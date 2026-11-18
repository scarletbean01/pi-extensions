/**
 * Durable cancellation intent, completion-vs-cancellation arbitration, grace periods, and separate deadline/liveness checks.
 *
 * Cancellation intent (`<instance>.cancel.json` / `cancel.json`) is persisted BEFORE signalling workers.
 * Outcome arbitration (`<instance>.outcome-claim.json` via link(2)) decides completion-vs-cancellation races durably.
 * Heartbeats (`updated_at`), useful progress (`activity_at`), running-task duration (`started_at` vs `task_timeout_ms`),
 * and dependency wait (`dependency_wait_timeout_ms`) are kept strictly separate.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, errorMessage, outboundEdgesOf, publishExclusive, readJson } from "./session-store.ts";

export const CANCEL_VERSION = 1;
const READABLE_CANCEL_VERSIONS = [1];
export const DEFAULT_CANCEL_GRACE_MS = 5_000;
export const DEFAULT_DEPENDENCY_WAIT_MS = 300_000;
export const DEFAULT_LIVENESS_MS = 600_000;
export const HEARTBEAT_STALE_MS = 30_000;

/** Identity recorded inside cancellation and arbitration files; attempt_id may be absent for version 1 runs. */
export interface CancelIdentity {
	run_id: string;
	node_id: string;
	persona_name: string;
	attempt_id?: string;
	instance_id: string;
}

export interface CancelExpectation {
	run_id: string;
	instance_id: string;
	node_id?: string;
	persona_name?: string;
	attempt_id?: string;
}

export interface CancelRecord {
	version: 1;
	identity: CancelIdentity;
	scope: "run" | "node";
	reason: string;
	requested_at: string;
	grace_ms: number;
	force_close_after: string;
}

export interface RunCancelRecord {
	version: 1;
	run_id: string;
	reason: string;
	requested_at: string;
	grace_ms: number;
	force_close_after: string;
}

export interface OutcomeClaim {
	version: 1;
	identity: CancelIdentity;
	outcome: "completed" | "cancelled";
	claimed_at: string;
}

export type LivenessState = "healthy" | "stalled" | "heartbeat_stale" | "exited";

export interface ProgressSnapshot {
	attempt_id?: string;
	token: string;
	updated_at: number;
	state: string;
	activity_at?: number;
	started_at?: number;
}

export interface LivenessDiagnosis {
	liveness: LivenessState;
	heartbeat_age_ms: number;
	activity_age_ms?: number;
	elapsed_ms?: number;
	deadline_exceeded: boolean;
}

export const cancelPath = (dir: string, instance: string) => join(dir, `${instance}.cancel.json`);
export const runCancelPath = (dir: string) => join(dir, "cancel.json");
export const outcomeClaimPath = (dir: string, instance: string) => join(dir, `${instance}.outcome-claim.json`);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value;
};

function checkVersion(value: unknown, what: string): 1 {
	if (typeof value !== "number" || !READABLE_CANCEL_VERSIONS.includes(value)) {
		throw new Error(`Unsupported ${what} version ${JSON.stringify(value)}: this release reads version ${READABLE_CANCEL_VERSIONS.join(" and ")}. The record was left untouched`);
	}
	return 1;
}

function checkIdentity(raw: unknown, expected: CancelExpectation, what: string): CancelIdentity {
	if (!isRecord(raw)) throw new Error(`${what} identity mismatch (no identity recorded)`);
	const identity: CancelIdentity = {
		run_id: nonEmpty(raw.run_id, `${what}.identity.run_id`),
		node_id: nonEmpty(raw.node_id, `${what}.identity.node_id`),
		persona_name: nonEmpty(raw.persona_name, `${what}.identity.persona_name`),
		instance_id: nonEmpty(raw.instance_id, `${what}.identity.instance_id`),
		...(raw.attempt_id !== undefined ? { attempt_id: nonEmpty(raw.attempt_id, `${what}.identity.attempt_id`) } : {}),
	};
	for (const field of ["run_id", "node_id", "persona_name", "instance_id"] as const) {
		if (expected[field] !== undefined && identity[field] !== expected[field]) {
			throw new Error(`${what} identity mismatch (${field} ${JSON.stringify(identity[field])}, expected ${JSON.stringify(expected[field])})`);
		}
	}
	if (expected.attempt_id !== undefined && identity.attempt_id !== expected.attempt_id) {
		throw new Error(`${what} identity mismatch (attempt_id ${JSON.stringify(identity.attempt_id)}, expected ${JSON.stringify(expected.attempt_id)})`);
	}
	return identity;
}

function checkCancelTimingFields(raw: Record<string, unknown>, what: string): void {
	if (typeof raw.reason !== "string" || typeof raw.requested_at !== "string" || !Number.isFinite(raw.grace_ms) || Number(raw.grace_ms) < 0 || typeof raw.force_close_after !== "string") {
		throw new Error(`malformed ${what}`);
	}
}

/** Validate a persisted per-node cancellation record at the read boundary. */
export function parseCancelRecord(raw: unknown, expected: CancelExpectation): CancelRecord {
	if (!isRecord(raw)) throw new Error("malformed cancel record");
	checkVersion(raw.version, "cancel record");
	const identity = checkIdentity(raw.identity, expected, "cancel");
	if (raw.scope !== "run" && raw.scope !== "node") throw new Error("malformed cancel record (scope)");
	checkCancelTimingFields(raw, "cancel record");
	return { ...raw, version: 1, identity } as CancelRecord;
}

/** Validate a persisted run-wide cancellation record at the read boundary. */
export function parseRunCancelRecord(raw: unknown, runId: string): RunCancelRecord {
	if (!isRecord(raw)) throw new Error("malformed run cancel record");
	checkVersion(raw.version, "run cancel record");
	const recordedRunId = nonEmpty(raw.run_id, "run_id");
	if (recordedRunId !== runId) throw new Error(`run cancel identity mismatch (run_id ${JSON.stringify(recordedRunId)}, expected ${JSON.stringify(runId)})`);
	checkCancelTimingFields(raw, "run cancel record");
	return raw as unknown as RunCancelRecord;
}

/** Validate a persisted completion-vs-cancellation arbitration record at the read boundary. */
export function parseOutcomeClaim(raw: unknown, expected: CancelExpectation): OutcomeClaim {
	if (!isRecord(raw)) throw new Error("malformed outcome claim");
	checkVersion(raw.version, "outcome claim");
	const identity = checkIdentity(raw.identity, expected, "outcome claim");
	if ((raw.outcome !== "completed" && raw.outcome !== "cancelled") || typeof raw.claimed_at !== "string") {
		throw new Error("malformed outcome claim");
	}
	return { ...raw, version: 1, identity } as OutcomeClaim;
}

function forceCloseTimestamp(requestedAt: string, graceMs: number): string {
	const base = Date.parse(requestedAt);
	const ts = Number.isFinite(base) ? base + graceMs : Date.now() + graceMs;
	return new Date(ts).toISOString();
}

/** Persist durable per-node cancellation intent (idempotent: preserves an earlier valid cancel record's timestamps, never overwrites unsupported/foreign records). */
export function writeCancelRecord(
	dir: string,
	input: { identity: CancelIdentity; scope: "run" | "node"; reason: string; requestedAt: string; graceMs: number },
): CancelRecord {
	const path = cancelPath(dir, input.identity.instance_id);
	const record: CancelRecord = {
		version: CANCEL_VERSION,
		identity: input.identity,
		scope: input.scope,
		reason: input.reason,
		requested_at: input.requestedAt,
		grace_ms: input.graceMs,
		force_close_after: forceCloseTimestamp(input.requestedAt, input.graceMs),
	};
	if (!publishExclusive(path, JSON.stringify(record, null, 2) + "\n")) {
		return parseCancelRecord(readJson<unknown>(path), input.identity);
	}
	return record;
}

/** Persist durable run-wide cancellation intent (idempotent; never overwrites unsupported/foreign records). */
export function writeRunCancelRecord(
	dir: string,
	input: { run_id: string; reason: string; requestedAt: string; graceMs: number },
): RunCancelRecord {
	const path = runCancelPath(dir);
	const record: RunCancelRecord = {
		version: CANCEL_VERSION,
		run_id: input.run_id,
		reason: input.reason,
		requested_at: input.requestedAt,
		grace_ms: input.graceMs,
		force_close_after: forceCloseTimestamp(input.requestedAt, input.graceMs),
	};
	if (!publishExclusive(path, JSON.stringify(record, null, 2) + "\n")) {
		return parseRunCancelRecord(readJson<unknown>(path), input.run_id);
	}
	return record;
}

/**
 * Atomically arbitrate between committing a worker completion and recording cancellation via link(2).
 * Whichever side publishes `<instance>.outcome-claim.json` first wins; the loser observes the winner.
 */
export function claimOutcome(
	dir: string,
	identity: CancelIdentity,
	outcome: "completed" | "cancelled",
	claimedAt: string,
	recordKey = identity.instance_id,
): { won: boolean; claim: OutcomeClaim } {
	const path = outcomeClaimPath(dir, recordKey);
	const claim: OutcomeClaim = { version: CANCEL_VERSION, identity, outcome, claimed_at: claimedAt };
	if (publishExclusive(path, JSON.stringify(claim, null, 2) + "\n")) return { won: true, claim };
	const existing = parseOutcomeClaim(readJson<unknown>(path), identity);
	return { won: existing.outcome === outcome, claim: existing };
}

/** Remaining milliseconds before explicit force-close is permitted; 0 means the grace period has elapsed. */
export function graceRemainingMs(record: Pick<CancelRecord, "requested_at" | "grace_ms" | "force_close_after">, nowMs: number): number {
	const explicit = Date.parse(record.force_close_after);
	const target = Number.isFinite(explicit) ? explicit : Date.parse(record.requested_at) + record.grace_ms;
	return Number.isFinite(target) ? Math.max(0, target - nowMs) : 0;
}

/**
 * Diagnose worker liveness and task duration separately:
 * - Heartbeat (`updated_at`) proves only that the event loop is alive (`heartbeat_stale` if old, `exited` if process died).
 * - Useful progress (`activity_at`) determines whether a working node is `healthy` or `stalled`.
 * - Task duration (`started_at` vs `taskTimeoutMs`) is evaluated independently of liveness.
 */
export function diagnoseLiveness(input: {
	nowMs: number;
	progress: ProgressSnapshot;
	alive: boolean;
	livenessTimeoutMs: number;
	taskTimeoutMs?: number;
	heartbeatStaleMs?: number;
}): LivenessDiagnosis {
	const { nowMs, progress, alive, livenessTimeoutMs, taskTimeoutMs, heartbeatStaleMs = HEARTBEAT_STALE_MS } = input;
	const heartbeat_age_ms = Math.max(0, nowMs - progress.updated_at);
	const activity_age_ms = Number.isFinite(progress.activity_at) ? Math.max(0, nowMs - progress.activity_at!) : undefined;
	const running = progress.state === "working";
	const elapsed_ms = running && Number.isFinite(progress.started_at) ? Math.max(0, nowMs - progress.started_at!) : undefined;
	const deadline_exceeded = running && taskTimeoutMs !== undefined && elapsed_ms !== undefined && elapsed_ms >= taskTimeoutMs;
	let liveness: LivenessState;
	if (!alive) liveness = "exited";
	else if (heartbeat_age_ms > heartbeatStaleMs) liveness = "heartbeat_stale";
	else if (progress.state === "working" && activity_age_ms !== undefined && activity_age_ms > livenessTimeoutMs) liveness = "stalled";
	else liveness = "healthy";
	return { liveness, heartbeat_age_ms, ...(activity_age_ms !== undefined ? { activity_age_ms } : {}), ...(elapsed_ms !== undefined ? { elapsed_ms } : {}), deadline_exceeded };
}

/** Compute downstream nodes that depend (directly or transitively) on any cancelled instance. */
export function computeDownstreamBlockers(
	entries: Array<{ node_id: string; instance_id: string; predecessor?: string; successor?: string }>,
	cancelledInstances: Iterable<string>,
): Array<{ node_id: string; instance_id: string; blocked_by: string }> {
	const cancelled = new Set(cancelledInstances);
	const byInstance = new Map(entries.map(entry => [entry.instance_id, entry]));
	const out: Array<{ node_id: string; instance_id: string; blocked_by: string }> = [];
	const visited = new Set<string>();
	const visit = (current: { node_id: string; instance_id: string; predecessor?: string; successor?: string }) => {
		for (const nextId of outboundEdgesOf(entries, current.instance_id)) {
			const next = byInstance.get(nextId);
			if (!next || cancelled.has(next.instance_id) || visited.has(next.instance_id)) continue;
			visited.add(next.instance_id);
			out.push({ node_id: next.node_id, instance_id: next.instance_id, blocked_by: current.node_id });
			visit(next);
		}
	};
	for (const startId of cancelled) {
		const start = byInstance.get(startId);
		if (start) visit(start);
	}
	return out;
}

/** Safely read a cancel record if it exists, returning either the parsed record or a human-readable error. */
export function readCancelRecordSafe(dir: string, expected: CancelExpectation): { record?: CancelRecord; error?: string } {
	const path = cancelPath(dir, expected.instance_id);
	if (!existsSync(path)) return {};
	try {
		return { record: parseCancelRecord(readJson<unknown>(path), expected) };
	} catch (error) {
		return { error: `unusable cancel record: ${errorMessage(error)}` };
	}
}

/** Safely read a run-wide cancel record if it exists, failing closed on unsupported/foreign records. */
export function readRunCancelRecordSafe(dir: string, runId: string): { record?: RunCancelRecord; error?: string } {
	const path = runCancelPath(dir);
	if (!existsSync(path)) return {};
	try {
		return { record: parseRunCancelRecord(readJson<unknown>(path), runId) };
	} catch (error) {
		return { error: `unusable run cancel record: ${errorMessage(error)}` };
	}
}

/** Safely read an outcome claim record if it exists, failing closed on unsupported/foreign records. */
export function readOutcomeClaimSafe(dir: string, expected: CancelExpectation, recordKey = expected.instance_id): { claim?: OutcomeClaim; error?: string } {
	const path = outcomeClaimPath(dir, recordKey);
	if (!existsSync(path)) return {};
	try {
		return { claim: parseOutcomeClaim(readJson<unknown>(path), expected) };
	} catch (error) {
		return { error: `unusable outcome claim: ${errorMessage(error)}` };
	}
}
