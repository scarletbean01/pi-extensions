/**
 * Durable handoffs: delivery is not acceptance.
 *
 * A handoff transfers the source attempt's saved result to the destination node's attempt. Three durable records, each written by exactly one side,
 * keep the stages apart (Coms is only the wake-up path; these records decide whether work may execute):
 *
 * - `<destination>.handoff-offer.json`  (source) the immutable transfer: handoff ID bound to run, source attempt, destination node/attempt and the
 *   input digest, `offered` before the notification is sent and `queued` once Coms acknowledged transport. Queued is not accepted.
 * - `<destination>.handoff.json`         (destination) the acceptance: published exclusively (link(2)) by the destination before any model work.
 *   Whoever publishes it first owns the handoff; every later notification finds it and is a harmless replay.
 * - `<destination>.handoff-rejections.json` (destination) what the destination refused and why.
 *
 * Whether the destination then runs or completes is the destination's execution record (result / disposition), never inferred from these.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, parseTaskInput, sha256Text, taskInputPath } from "./contracts.ts";
import { atomicJson, errorMessage, parseCompletion, publishExclusive, readJson, resultPath, type CompletionExpectation, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";

/** The durable handoff protocol version a worker configuration may declare. Absent: the original receipt-only behavior (and version 1 workers). */
export const HANDOFF_PROTOCOL = 1;
const READABLE_RECORD_VERSIONS = [1];

export const handoffOfferPath = (dir: string, destinationInstance: string) => join(dir, `${destinationInstance}.handoff-offer.json`);
/** The acceptance (claim). The same file the original release wrote as a bare receipt. */
export const handoffClaimPath = (dir: string, destinationInstance: string) => join(dir, `${destinationInstance}.handoff.json`);
export const handoffRejectionsPath = (dir: string, destinationInstance: string) => join(dir, `${destinationInstance}.handoff-rejections.json`);

export interface HandoffEnd { node_id: string; attempt_id: string; instance_id: string }
export interface HandoffOffer {
	version: 1;
	handoff_id: string;
	run_id: string;
	state: "offered" | "queued";
	source: HandoffEnd & { persona_name: string };
	destination: HandoffEnd;
	/** sha256 of the canonical saved result: exactly the input the destination is being handed. */
	input_digest: string;
	result_path: string;
	offered_at: string;
	queued_at?: string;
}
export interface HandoffClaim {
	version: 1;
	handoff_id: string;
	state: "accepted";
	run_id: string;
	source: HandoffEnd & { session_id: string };
	destination: HandoffEnd;
	input_digest: string;
	/** Whether a durable offer backed this acceptance (a run from the previous release has none). */
	offer: "matched" | "absent";
	accepted_at: string;
}
/** The original release's receipt: it recorded that a handoff was consumed, but not which one. */
export interface LegacyHandoffClaim { task_id: string; token: string; predecessor: string; sender_session: string }

export type RejectionKind = "sender" | "run" | "offer" | "destination" | "attempt" | "input" | "conflict";
/** A `notification` rejection refuses one message (the offer may still be fine); an `integrity` rejection means the handoff itself cannot be accepted. */
export type RejectionSeverity = "notification" | "integrity";
export interface HandoffRejection { at: string; kind: RejectionKind; severity: RejectionSeverity; reason: string; handoff_id?: string }

/** The input a handoff transfers: the digest of the saved result, which is also what the upstream index records as its `result_hash`. */
export const inputDigest = (result: unknown): string => sha256Text(canonicalJson(result));

/** Bound to the run, the source attempt, the destination node (and attempt) and the exact input. */
export function handoffId(parts: { run_id: string; source_attempt_id: string; destination_node_id: string; destination_attempt_id: string; input_digest: string }): string {
	return `h-${createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32)}`;
}

function checkRecordVersion(raw: Record<string, unknown>, what: string): void {
	if (typeof raw.version !== "number" || !READABLE_RECORD_VERSIONS.includes(raw.version)) {
		throw new Error(`Unsupported ${what} version ${JSON.stringify(raw.version)}: this release reads version ${READABLE_RECORD_VERSIONS.join(" and ")}. The record was left untouched`);
	}
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`); return value; };
function end(value: unknown, field: string): HandoffEnd {
	if (!isRecord(value)) throw new Error(`${field} is missing`);
	return { node_id: text(value.node_id, `${field}.node_id`), attempt_id: text(value.attempt_id, `${field}.attempt_id`), instance_id: text(value.instance_id, `${field}.instance_id`) };
}

/** Validate a persisted offer at the read boundary. */
export function parseHandoffOffer(raw: unknown): HandoffOffer {
	if (!isRecord(raw)) throw new Error("malformed handoff offer");
	checkRecordVersion(raw, "handoff offer");
	if (raw.state !== "offered" && raw.state !== "queued") throw new Error("malformed handoff offer (state)");
	const source = end(raw.source, "source");
	const digest = text(raw.input_digest, "input_digest");
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("malformed handoff offer (input_digest)");
	return { ...raw, source: { ...source, persona_name: text((raw.source as Record<string, unknown>).persona_name, "source.persona_name") }, destination: end(raw.destination, "destination"), handoff_id: text(raw.handoff_id, "handoff_id"), run_id: text(raw.run_id, "run_id"), input_digest: digest, result_path: text(raw.result_path, "result_path"), offered_at: text(raw.offered_at, "offered_at") } as HandoffOffer;
}

/** Validate a persisted acceptance. The original release's receipt (no version) is returned as is: it proves consumption, not which handoff. */
export function parseHandoffClaim(raw: unknown): HandoffClaim | LegacyHandoffClaim {
	if (!isRecord(raw)) throw new Error("malformed handoff acceptance");
	if (raw.version === undefined) {
		if (typeof raw.task_id !== "string" || typeof raw.predecessor !== "string") throw new Error("malformed handoff acceptance");
		return raw as unknown as LegacyHandoffClaim;
	}
	checkRecordVersion(raw, "handoff acceptance");
	if (raw.state !== "accepted" || (raw.offer !== "matched" && raw.offer !== "absent")) throw new Error("malformed handoff acceptance (state)");
	const source = end(raw.source, "source");
	const digest = text(raw.input_digest, "input_digest");
	return { ...raw, source: { ...source, session_id: text((raw.source as Record<string, unknown>).session_id, "source.session_id") }, destination: end(raw.destination, "destination"), handoff_id: text(raw.handoff_id, "handoff_id"), run_id: text(raw.run_id, "run_id"), input_digest: digest, accepted_at: text(raw.accepted_at, "accepted_at") } as HandoffClaim;
}
export const isLegacyClaim = (claim: HandoffClaim | LegacyHandoffClaim): claim is LegacyHandoffClaim => !("version" in claim);

export function parseHandoffRejections(raw: unknown): HandoffRejection[] {
	if (!isRecord(raw) || !Array.isArray(raw.rejections)) throw new Error("malformed handoff rejections");
	checkRecordVersion(raw, "handoff rejections");
	return raw.rejections.map(entry => {
		if (!isRecord(entry) || typeof entry.reason !== "string" || typeof entry.kind !== "string") throw new Error("malformed handoff rejections");
		return entry as unknown as HandoffRejection;
	});
}

// ---- source side ----

/**
 * Offer the saved result to the destination. Idempotent: a retry of the same logical handoff (same run, source attempt, destination and input)
 * finds the existing offer; an offer that disagrees with what is being offered now is refused, never overwritten.
 */
export function offerHandoff(config: WorkerConfig, completion: WorkerCompletion, resultFile: string, now = new Date().toISOString()): HandoffOffer {
	const destinationInstance = config.successor!;
	const input = parseTaskInput(readJson<unknown>(taskInputPath(config.session_dir, destinationInstance)), { run_id: config.task_id, instance_id: destinationInstance });
	const destination: HandoffEnd = { node_id: input.identity.node_id, attempt_id: input.identity.attempt_id, instance_id: destinationInstance };
	const digest = inputDigest(completion.result);
	const offer: HandoffOffer = {
		version: 1,
		handoff_id: handoffId({ run_id: config.task_id, source_attempt_id: config.attempt_id!, destination_node_id: destination.node_id, destination_attempt_id: destination.attempt_id, input_digest: digest }),
		run_id: config.task_id, state: "offered",
		source: { node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id!, instance_id: config.instance_id },
		destination, input_digest: digest, result_path: resultFile, offered_at: now,
	};
	const path = handoffOfferPath(config.session_dir, destinationInstance);
	if (publishExclusive(path, JSON.stringify(offer, null, 2) + "\n")) return offer;
	const existing = parseHandoffOffer(readJson<unknown>(path));
	if (existing.handoff_id !== offer.handoff_id) throw new Error(`A different handoff (${existing.handoff_id}) was already offered to ${destinationInstance}; refusing to replace it with ${offer.handoff_id}`);
	return existing;
}

/** Coms acknowledged the notification. Transport only: this is not acceptance. Written by the source alone, and never moves a queued offer back. */
export function markHandoffQueued(config: WorkerConfig, offer: HandoffOffer, now = new Date().toISOString()): HandoffOffer {
	if (offer.state === "queued") return offer;
	const queued: HandoffOffer = { ...offer, state: "queued", queued_at: now };
	atomicJson(handoffOfferPath(config.session_dir, offer.destination.instance_id), queued);
	return queued;
}

/** The wake-up message: the original marker first (what receivers key on), then the handoff it is about. The destination still verifies it against the durable offer. */
export function handoffNotification(config: WorkerConfig, offer: HandoffOffer | undefined, resultFile: string, failed: boolean): string {
	return `bootstrap-handoff:${config.token}:${config.instance_id}\n` +
		(offer ? `handoff-id: ${offer.handoff_id}\ninput-digest: ${offer.input_digest}\n` : "") +
		`Run: ${config.task_id}. Predecessor result reference: ${resultFile}\n` +
		(failed ? "The chain is aborted." : "Perform your assigned task using the durable predecessor input, then call bootstrap_complete.");
}

void [existsSync, errorMessage, parseCompletion, resultPath, ({} as CompletionExpectation)];
