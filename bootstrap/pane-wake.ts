/**
 * Shared Herdr pane wake-up fallback (ADR 0003).
 *
 * Used by a completing worker when Coms fails as unreachable or delivery-unknown, and by recovery redelivery.
 * Decides purely from durable records (readiness pane_id, live destination process, matching unclaimed offer)
 * and Herdr pane existence (`herdr pane get`), never consulting Herdr agent status.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatPaneWakeLine, handoffClaimPath, handoffOfferPath, isJoinClaim, isLegacyClaim,
	parseHandoffClaim, parseHandoffOffer, parseJoinHandoffClaim, type HandoffOffer,
} from "./handoff.ts";
import { attemptKey, attemptNumber, type ReviewPlan } from "./review-plan.ts";
import { errorMessage, isRecord, parseWorkerReady, processAlive, readJson, readyPath, type WorkerReady } from "./session-store.ts";

const DEFAULT_HERDR_TIMEOUT_MS = 15_000;
const HANDOFF_ID_PATTERN = /^h-[0-9a-f]{32}$/;

export type PaneWakeResult =
	| { outcome: "sent"; pane_id: string; handoff_id: string; line: string }
	| { outcome: "skipped"; reason: string }
	| { outcome: "failed"; reason: string };

export interface PaneWakeExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	killed?: boolean;
	error?: NodeJS.ErrnoException;
}

export type PaneWakeExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<PaneWakeExecResult>;

export interface PaneWakeRequest {
	/** Run's session directory (contains readiness records, handoff offers and claims). */
	sessionDir: string;
	/** Destination attempt ID (e.g. `a2-n2.1`) or destination instance key (`a2-n2`). */
	destinationAttempt: string;
	/** Handoff ID to verify against the durable offer and inject into the pane. */
	handoffId: string;
	/** Optional destination instance ID (derived from `destinationAttempt` when omitted). */
	destinationInstance?: string;
	/** Optional source instance ID to scope edge-specific offer/claim lookup when known. */
	sourceInstance?: string;
	/** Optional review plan to resolve exact attempt-keyed offer/claim paths. */
	reviewPlan?: ReviewPlan;
	/** Optional topology (`chain` | `team` | `graph`) to resolve offer/claim scope. */
	topology?: "chain" | "team" | "graph";
	/** Optional environment for locating `herdr` on PATH (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Optional command runner (defaults to spawning `herdr` directly on PATH). */
	exec?: PaneWakeExec;
	/** Optional abort signal. */
	signal?: AbortSignal;
	/** Timeout per `herdr` invocation in ms (defaults to 15_000). */
	timeoutMs?: number;
}

/** Whether a Coms send failure message is eligible for a pane wake-up fallback (`unreachable` or `delivery unknown`). */
export function isComsFallbackEligibleError(message: string): boolean {
	const trimmed = message.trim();
	return trimmed.startsWith("coms: unreachable:") || trimmed.startsWith("coms: delivery unknown:");
}

function defaultHerdrExec(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PaneWakeExecResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HERDR_TIMEOUT_MS;
	return new Promise(resolve => {
		if (options.signal?.aborted) {
			resolve({ code: null, stdout: "", stderr: "Aborted", killed: true });
			return;
		}
		let settled = false;
		let killed = false;
		let stdout = "";
		let stderr = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(command, args, {
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: PaneWakeExecResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const terminate = () => {
			if (killed || settled) return;
			killed = true;
			try { child.kill("SIGTERM"); } catch { /* exited */ }
			killTimer = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* exited */ }
			}, 1000);
			killTimer.unref?.();
		};
		const onAbort = () => terminate();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(terminate, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
		child.once("error", err => finish({ code: null, stdout, stderr: err.message, killed, error: err }));
		child.once("close", code => finish({ code, stdout, stderr, killed }));
	});
}

function resolveDestinationInstance(sessionDir: string, destinationAttempt: string, explicitInstance?: string): string {
	if (explicitInstance) return explicitInstance;
	if (existsSync(readyPath(sessionDir, destinationAttempt))) return destinationAttempt;
	const stripped = /^(.+)\.(\d+)$/.exec(destinationAttempt);
	return stripped ? stripped[1]! : destinationAttempt;
}

interface ResolvedOffer {
	offer: HandoffOffer;
	offerKey: string;
}

function findOfferForWake(params: {
	sessionDir: string;
	destInstance: string;
	destinationAttempt: string;
	handoffId: string;
	readyTaskId: string;
	sourceInstance?: string;
	reviewPlan?: ReviewPlan;
	topology?: "chain" | "team" | "graph";
}): { ok: true; value: ResolvedOffer } | { ok: false; reason: string } {
	const { sessionDir, destInstance, destinationAttempt, handoffId, readyTaskId, sourceInstance, reviewPlan, topology } = params;
	const candidates: Array<{ path: string; key: string }> = [];
	const seen = new Set<string>();
	const addCandidate = (key: string, scope?: string) => {
		const path = handoffOfferPath(sessionDir, key, scope);
		if (!seen.has(path)) {
			seen.add(path);
			candidates.push({ path, key });
		}
	};

	if (sourceInstance) {
		const hasExplicitAttempt = destinationAttempt !== destInstance && /^.+\.(\d+)$/.test(destinationAttempt);
		if (reviewPlan !== undefined || topology !== undefined) {
			if (hasExplicitAttempt) {
				const key = attemptKey(reviewPlan, destInstance, attemptNumber(destinationAttempt));
				const scope = reviewPlan || topology === "graph" ? sourceInstance : undefined;
				addCandidate(key, scope);
				if (!scope) addCandidate(key, sourceInstance);
			} else if (reviewPlan) {
				let files: string[] = [];
				try { files = readdirSync(sessionDir); } catch { files = []; }
				const numbered = new Set<number>([1]);
				const prefix = `${destInstance}.`;
				for (const file of files) {
					if (!file.startsWith(prefix) || !file.endsWith(".handoff-offer.json")) continue;
					const rest = file.slice(prefix.length, -".handoff-offer.json".length);
					const match = /^(\d+)(?:\.from-(.+))?$/.exec(rest);
					if (match && (!match[2] || match[2] === sourceInstance)) numbered.add(Number(match[1]));
				}
				for (const num of [...numbered].sort((a, b) => b - a)) {
					const key = attemptKey(reviewPlan, destInstance, num);
					addCandidate(key, sourceInstance);
					addCandidate(key, undefined);
				}
			} else {
				const scope = topology === "graph" ? sourceInstance : undefined;
				addCandidate(destInstance, scope);
				if (!scope) addCandidate(destInstance, sourceInstance);
			}
		} else {
			addCandidate(destinationAttempt, sourceInstance);
			addCandidate(destInstance, sourceInstance);
			addCandidate(destinationAttempt, undefined);
			addCandidate(destInstance, undefined);
		}
	} else {
		const hasExplicitAttempt = destinationAttempt !== destInstance && /^.+\.(\d+)$/.test(destinationAttempt);
		const keyCandidates: string[] = destinationAttempt !== destInstance ? [destinationAttempt, destInstance] : [destInstance];
		let files: string[] = [];
		try { files = readdirSync(sessionDir); } catch { files = []; }
		if (!hasExplicitAttempt) {
			const numbered = new Set<number>();
			const prefix = `${destInstance}.`;
			for (const file of files) {
				if (!file.startsWith(prefix) || !file.endsWith(".handoff-offer.json")) continue;
				const rest = file.slice(prefix.length, -".handoff-offer.json".length);
				const match = /^(\d+)(?:\.from-.+)?$/.exec(rest);
				if (match) numbered.add(Number(match[1]));
			}
			for (const num of [...numbered].sort((a, b) => b - a)) {
				keyCandidates.push(`${destInstance}.${num}`);
			}
		}
		for (const key of keyCandidates) {
			addCandidate(key, undefined);
			const prefix = `${key}.from-`;
			for (const file of files) {
				if (file.startsWith(prefix) && file.endsWith(".handoff-offer.json")) {
					const path = join(sessionDir, file);
					if (!seen.has(path)) {
						seen.add(path);
						candidates.push({ path, key });
					}
				}
			}
		}
	}

	let firstParseError: string | undefined;
	let mismatchedOfferReason: string | undefined;
	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		let offer: HandoffOffer;
		try {
			offer = parseHandoffOffer(readJson<unknown>(candidate.path));
		} catch (error) {
			firstParseError ??= errorMessage(error);
			continue;
		}
		if (offer.handoff_id !== handoffId) {
			mismatchedOfferReason ??= `handoff offer is for ${offer.handoff_id}, not ${handoffId}`;
			continue;
		}
		if (offer.run_id !== readyTaskId) {
			return { ok: false, reason: `handoff offer run ${offer.run_id} does not match readiness run ${readyTaskId}` };
		}
		if (offer.destination.instance_id !== destInstance) {
			return { ok: false, reason: `handoff offer destination ${offer.destination.instance_id} does not match ${destInstance}` };
		}
		if (destinationAttempt !== destInstance && offer.destination.attempt_id !== destinationAttempt) {
			return { ok: false, reason: `handoff offer destination attempt ${offer.destination.attempt_id} does not match ${destinationAttempt}` };
		}
		return { ok: true, value: { offer, offerKey: candidate.key } };
	}

	if (firstParseError) return { ok: false, reason: `handoff offer is unreadable: ${firstParseError}` };
	if (mismatchedOfferReason && sourceInstance) return { ok: false, reason: mismatchedOfferReason };
	return { ok: false, reason: `no matching handoff offer on record for ${destinationAttempt} (${handoffId})` };
}

function checkOfferUnclaimed(sessionDir: string, offer: HandoffOffer, offerKey: string, destInstance: string, destinationAttempt: string, handoffId: string): string | undefined {
	const claimPaths = new Set<string>([
		handoffClaimPath(sessionDir, offerKey, offer.source.instance_id),
		handoffClaimPath(sessionDir, offerKey),
	]);
	for (const path of claimPaths) {
		if (!existsSync(path)) continue;
		try {
			const raw = readJson<unknown>(path);
			if (isJoinClaim(raw)) {
				const joinClaim = parseJoinHandoffClaim(raw, {
					run_id: offer.run_id,
					destination: { instance_id: destInstance },
				});
				return joinClaim.handoff_ids.includes(handoffId)
					? `handoff ${handoffId} is already claimed`
					: `destination ${destinationAttempt} already claimed join handoffs (${joinClaim.handoff_ids.join(", ")})`;
			}
			const claim = parseHandoffClaim(raw, {
				run_id: offer.run_id,
				destination: { instance_id: destInstance },
			});
			if (isLegacyClaim(claim)) return `destination ${destinationAttempt} already has a legacy claim`;
			return claim.handoff_id === handoffId
				? `handoff ${handoffId} is already claimed`
				: `destination ${destinationAttempt} already claimed handoff ${claim.handoff_id}`;
		} catch (error) {
			return `handoff claim record is unreadable: ${errorMessage(error)}`;
		}
	}
	return undefined;
}

function commandFailureDetail(res: PaneWakeExecResult): string {
	if (res.error) return res.error.message;
	if (res.killed) return "timed out or aborted";
	return (res.stderr || res.stdout || `exit ${res.code ?? "null"}`).trim().slice(0, 300);
}

function isPaneNotFoundError(detail: string): boolean {
	return /(?:pane[_ ]not[_ ]found|unknown[_ ]pane|no[_ ]such[_ ]pane|\bpane(?:\s+(?:id\s+)?["'`]?[a-zA-Z0-9_.:-]+["'`]?)?\s+(?:is\s+|was\s+)?(?:not[_ ]found|does not exist)\b)/i.test(detail);
}

interface PendingWakeMarker {
	version: 1;
	handoff_id: string;
	pane_id: string;
	pid: number;
	start_time?: string;
	claim_id: string;
	sent_at: string;
}

const paneWakePendingPath = (sessionDir: string, paneId: string, pid: number, startTime?: string): string => {
	const key = createHash("sha256").update(JSON.stringify([paneId, pid, startTime ?? null])).digest("hex").slice(0, 16);
	return join(sessionDir, `pane-${key}.pane-wake-pending.json`);
};

function parseMatchingPendingMarker(
	raw: unknown,
	paneId: string,
	pid: number,
	startTime?: string,
): PendingWakeMarker | undefined {
	if (!isRecord(raw) || raw.version !== 1) return undefined;
	if (typeof raw.handoff_id !== "string" || !HANDOFF_ID_PATTERN.test(raw.handoff_id)) return undefined;
	if (raw.pane_id !== paneId || raw.pid !== pid || raw.start_time !== startTime) return undefined;
	if (raw.claim_id !== undefined && typeof raw.claim_id !== "string") return undefined;
	if (typeof raw.sent_at !== "string") return undefined;
	return raw as unknown as PendingWakeMarker;
}

type PendingClaimResult =
	| { status: "claimed"; claimId: string }
	| { status: "same_handoff" }
	| { status: "other_handoff"; handoffId: string }
	| { status: "untracked" };

function claimPendingWakeMarker(
	pendingFile: string,
	handoffId: string,
	paneId: string,
	pid: number,
	startTime?: string,
): PendingClaimResult {
	const claimId = randomUUID();
	const record: PendingWakeMarker = {
		version: 1,
		handoff_id: handoffId,
		pane_id: paneId,
		pid,
		...(startTime !== undefined ? { start_time: startTime } : {}),
		claim_id: claimId,
		sent_at: new Date().toISOString(),
	};
	const payload = JSON.stringify(record, null, 2) + "\n";

	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			writeFileSync(pendingFile, payload, { mode: 0o600, flag: "wx" });
			return { status: "claimed", claimId };
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
				return { status: "untracked" };
			}
			let raw: unknown;
			try {
				raw = readJson<unknown>(pendingFile);
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
				try { rmSync(pendingFile, { force: true }); } catch { return { status: "untracked" }; }
				continue;
			}
			const existing = parseMatchingPendingMarker(raw, paneId, pid, startTime);
			if (!existing) {
				try { rmSync(pendingFile, { force: true }); } catch { return { status: "untracked" }; }
				continue;
			}
			return existing.handoff_id === handoffId
				? { status: "same_handoff" }
				: { status: "other_handoff", handoffId: existing.handoff_id };
		}
	}
	return { status: "untracked" };
}

function removePendingWakeMarker(
	pendingFile: string,
	expected: { handoffId: string; paneId: string; pid: number; startTime?: string; claimId?: string },
): void {
	try {
		const existing = parseMatchingPendingMarker(
			readJson<unknown>(pendingFile),
			expected.paneId,
			expected.pid,
			expected.startTime,
		);
		if (!existing || existing.handoff_id !== expected.handoffId) return;
		if (expected.claimId !== undefined && existing.claim_id !== expected.claimId) return;
		rmSync(pendingFile, { force: true });
	} catch { /* already gone or best effort */ }
}

async function runExec(
	exec: PaneWakeExec,
	args: string[],
	opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<PaneWakeExecResult> {
	try {
		return await exec("herdr", args, opts);
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		return { code: null, stdout: "", stderr: err.message, error: err as NodeJS.ErrnoException };
	}
}

/**
 * Decide whether a Herdr pane wake-up is allowed from durable records and pane existence, and if so inject the single-line wake-up.
 * Never consults Herdr agent status (ADR 0003).
 */
export async function tryPaneWake(request: PaneWakeRequest): Promise<PaneWakeResult> {
	if (!HANDOFF_ID_PATTERN.test(request.handoffId)) {
		return { outcome: "skipped", reason: `invalid handoff ID for pane wake-up: ${JSON.stringify(request.handoffId)}` };
	}
	const wakeLine = formatPaneWakeLine(request.handoffId);

	const destInstance = resolveDestinationInstance(request.sessionDir, request.destinationAttempt, request.destinationInstance);
	const readyFile = readyPath(request.sessionDir, destInstance);
	if (!existsSync(readyFile)) {
		return { outcome: "skipped", reason: `destination ${destInstance} has no readiness record` };
	}

	let ready: WorkerReady;
	try {
		ready = parseWorkerReady(readJson<unknown>(readyFile));
	} catch (error) {
		return { outcome: "skipped", reason: `destination ${destInstance} readiness record is unreadable: ${errorMessage(error)}` };
	}
	if (ready.instance_id !== destInstance) {
		return { outcome: "skipped", reason: `destination readiness instance ${ready.instance_id} does not match ${destInstance}` };
	}
	if (!ready.pane_id) {
		return { outcome: "skipped", reason: `destination ${destInstance} readiness record has no pane_id` };
	}
	let alive: boolean;
	try {
		alive = processAlive(ready);
	} catch (error) {
		return { outcome: "failed", reason: `failed to check destination ${destInstance} process (pid ${ready.pid}): ${errorMessage(error)}` };
	}
	if (!alive) {
		return { outcome: "skipped", reason: `destination ${destInstance} process (pid ${ready.pid}) is not alive` };
	}

	const resolvedOffer = findOfferForWake({
		sessionDir: request.sessionDir,
		destInstance,
		destinationAttempt: request.destinationAttempt,
		handoffId: request.handoffId,
		readyTaskId: ready.task_id,
		sourceInstance: request.sourceInstance,
		reviewPlan: request.reviewPlan,
		topology: request.topology,
	});
	if (!resolvedOffer.ok) {
		return { outcome: "skipped", reason: resolvedOffer.reason };
	}

	const claimedReason = checkOfferUnclaimed(
		request.sessionDir,
		resolvedOffer.value.offer,
		resolvedOffer.value.offerKey,
		destInstance,
		request.destinationAttempt,
		request.handoffId,
	);
	if (claimedReason) {
		return { outcome: "skipped", reason: claimedReason };
	}

	const exec = request.exec ?? defaultHerdrExec;
	const execOpts = { signal: request.signal, timeoutMs: request.timeoutMs ?? DEFAULT_HERDR_TIMEOUT_MS, env: request.env };
	const getRes = await runExec(exec, ["pane", "get", ready.pane_id], execOpts);
	if (getRes.error) {
		return { outcome: "failed", reason: `failed to run herdr pane get: ${getRes.error.message}` };
	}
	if (getRes.killed) {
		return { outcome: "failed", reason: `herdr pane get ${ready.pane_id} timed out or was aborted` };
	}
	if (getRes.code !== 0) {
		const detail = commandFailureDetail(getRes);
		if (isPaneNotFoundError(detail)) {
			return { outcome: "skipped", reason: `pane ${ready.pane_id} does not exist (${detail})` };
		}
		return { outcome: "failed", reason: `herdr pane get ${ready.pane_id} failed (exit ${getRes.code ?? "null"}): ${detail}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(getRes.stdout);
	} catch {
		return { outcome: "failed", reason: `herdr pane get ${ready.pane_id} returned invalid JSON` };
	}
	if (!isRecord(parsed)) {
		return { outcome: "failed", reason: `herdr pane get ${ready.pane_id} returned invalid response` };
	}
	if (parsed.error) {
		const errDetail = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error).slice(0, 300);
		if (isPaneNotFoundError(errDetail)) {
			return { outcome: "skipped", reason: `pane ${ready.pane_id} does not exist (${errDetail})` };
		}
		return { outcome: "failed", reason: `herdr pane get ${ready.pane_id} failed: ${errDetail}` };
	}
	const payload = isRecord(parsed.result) ? parsed.result : parsed;
	const pane = isRecord(payload) ? payload.pane : undefined;
	if (!isRecord(pane) || (pane.pane_id !== undefined && pane.pane_id !== ready.pane_id)) {
		return { outcome: "skipped", reason: `Herdr did not report pane ${ready.pane_id} as existing` };
	}

	// Track unsubmitted wake text in a pane-keyed sidecar claimed atomically before send-text so concurrent retries send once,
	// a retry after send-keys failure sends only Enter, and another handoff to the same pane refuses instead of appending.
	const pendingFile = paneWakePendingPath(request.sessionDir, ready.pane_id, ready.pid, ready.start_time);
	const claim = claimPendingWakeMarker(pendingFile, request.handoffId, ready.pane_id, ready.pid, ready.start_time);
	if (claim.status === "other_handoff") {
		return {
			outcome: "failed",
			reason: `pane ${ready.pane_id} input holds another handoff's pending wake-up text (${claim.handoffId}); refusing ${request.handoffId}`,
		};
	}
	if (claim.status !== "same_handoff") {
		const textRes = await runExec(exec, ["pane", "send-text", ready.pane_id, wakeLine], execOpts);
		if (textRes.error || textRes.killed || textRes.code !== 0) {
			if (claim.status === "claimed") {
				removePendingWakeMarker(pendingFile, {
					handoffId: request.handoffId,
					paneId: ready.pane_id,
					pid: ready.pid,
					startTime: ready.start_time,
					claimId: claim.claimId,
				});
			}
			return { outcome: "failed", reason: `herdr pane send-text ${ready.pane_id} failed: ${commandFailureDetail(textRes)}` };
		}
	}
	const keysRes = await runExec(exec, ["pane", "send-keys", ready.pane_id, "Enter"], execOpts);
	if (keysRes.error || keysRes.killed || keysRes.code !== 0) {
		return {
			outcome: "failed",
			reason: `herdr pane send-keys ${ready.pane_id} Enter failed (wake line may still be pending in pane input): ${commandFailureDetail(keysRes)}`,
		};
	}
	if (claim.status !== "untracked") {
		removePendingWakeMarker(pendingFile, {
			handoffId: request.handoffId,
			paneId: ready.pane_id,
			pid: ready.pid,
			startTime: ready.start_time,
		});
	}

	return { outcome: "sent", pane_id: ready.pane_id, handoff_id: request.handoffId, line: wakeLine };
}
