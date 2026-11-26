/**
 * Shared pane wake-up fallback (ADR 0003).
 *
 * Used by a completing worker when Coms fails as unreachable or delivery-unknown, and by recovery redelivery.
 * Decides purely from durable records (readiness pane_id, live destination process, matching unclaimed offer)
 * and Host terminal existence via the Herdr backend, never consulting Host agent status.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	formatPaneWakeLine, handoffClaimPath, handoffOfferPath, isJoinClaim, isLegacyClaim,
	parseHandoffClaim, parseHandoffOffer, parseJoinHandoffClaim, type HandoffOffer,
} from "./handoff.ts";
import {
	checkHerdrPaneExists, defaultHerdrExec, sendHerdrPaneEnter, sendHerdrPaneText,
	type PaneWakeExec, type PaneWakeExecResult,
} from "./host-herdr.ts";
import { attemptKey, attemptNumber, type ReviewPlan } from "./review-plan.ts";
import { atomicJson, errorMessage, isRecord, parseWorkerReady, processAlive, processStartTime, publishExclusive, readJson, readyPath, type WorkerReady } from "./session-store.ts";

export type { PaneWakeExec, PaneWakeExecResult };

const DEFAULT_WAKE_TIMEOUT_MS = 15_000;
const HANDOFF_ID_PATTERN = /^h-[0-9a-f]{32}$/;

export type PaneWakeResult =
	| { outcome: "sent"; pane_id: string; handoff_id: string; line: string }
	| { outcome: "skipped"; reason: string }
	| { outcome: "failed"; reason: string };

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
	/** Optional environment for locating the Host binary on PATH (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Optional command runner (defaults to spawning the Host binary directly on PATH). */
	exec?: PaneWakeExec;
	/** Optional abort signal. */
	signal?: AbortSignal;
	/** Timeout per Host invocation in ms (defaults to 15_000). */
	timeoutMs?: number;
}

/** Whether a Coms send failure message is eligible for a pane wake-up fallback (`unreachable` or `delivery unknown`). */
export function isComsFallbackEligibleError(message: string): boolean {
	const trimmed = message.trim();
	return trimmed.startsWith("coms: unreachable:") || trimmed.startsWith("coms: delivery unknown:");
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

function checkOfferUnclaimed(
	sessionDir: string,
	offer: HandoffOffer,
	offerKey: string,
	destInstance: string,
	destinationAttempt: string,
	handoffId: string,
): { claimed: boolean; reason: string } | undefined {
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
				return {
					claimed: true,
					reason: joinClaim.handoff_ids.includes(handoffId)
						? `handoff ${handoffId} is already claimed`
						: `destination ${destinationAttempt} already claimed join handoffs (${joinClaim.handoff_ids.join(", ")})`,
				};
			}
			const claim = parseHandoffClaim(raw, {
				run_id: offer.run_id,
				destination: { instance_id: destInstance },
			});
			if (isLegacyClaim(claim)) return { claimed: true, reason: `destination ${destinationAttempt} already has a legacy claim` };
			return {
				claimed: true,
				reason: claim.handoff_id === handoffId
					? `handoff ${handoffId} is already claimed`
					: `destination ${destinationAttempt} already claimed handoff ${claim.handoff_id}`,
			};
		} catch (error) {
			return { claimed: false, reason: `handoff claim record is unreadable: ${errorMessage(error)}` };
		}
	}
	return undefined;
}

function isMarkerHandoffLiveOffer(
	sessionDir: string,
	markerHandoffId: string,
	destInstance: string,
	readyTaskId: string,
): boolean {
	let files: string[] = [];
	try { files = readdirSync(sessionDir); } catch { return false; }
	for (const file of files) {
		if (!file.endsWith(".handoff-offer.json")) continue;
		let offer: HandoffOffer;
		try {
			offer = parseHandoffOffer(readJson<unknown>(join(sessionDir, file)));
		} catch {
			continue;
		}
		if (offer.handoff_id !== markerHandoffId) continue;
		if (offer.run_id !== readyTaskId || offer.destination.instance_id !== destInstance) {
			return false;
		}
		const stem = file.slice(0, -".handoff-offer.json".length);
		const scopedSuffix = `.from-${offer.source.instance_id}`;
		const offerKey = stem.endsWith(scopedSuffix) ? stem.slice(0, -scopedSuffix.length) : stem;
		const claimStatus = checkOfferUnclaimed(
			sessionDir,
			offer,
			offerKey,
			destInstance,
			offer.destination.attempt_id,
			markerHandoffId,
		);
		if (!claimStatus || !claimStatus.claimed) return true;
	}
	return false;
}

interface PendingWakeMarker {
	version: 1;
	state: "claimed" | "text_sent";
	handoff_id: string;
	pane_id: string;
	pid: number;
	start_time?: string;
	/** The process that owns the initial marker claim; lets a later caller recover a crash before marker state advances. */
	claimant_pid?: number;
	claimant_start_time?: string | null;
	claim_id: string;
	sent_at: string;
	updated_at?: string;
}

const paneWakePendingPath = (sessionDir: string, paneId: string, pid: number, startTime?: string): string => {
	const key = createHash("sha256").update(JSON.stringify([paneId, pid, startTime ?? null])).digest("hex").slice(0, 16);
	return join(sessionDir, `pane-${key}.pane-wake-pending.json`);
};

function parsePendingMarker(raw: unknown): PendingWakeMarker | undefined {
	if (!isRecord(raw) || raw.version !== 1) return undefined;
	if (raw.state !== "claimed" && raw.state !== "text_sent") return undefined;
	if (typeof raw.handoff_id !== "string" || !HANDOFF_ID_PATTERN.test(raw.handoff_id)) return undefined;
	if (typeof raw.pane_id !== "string" || raw.pane_id.length === 0) return undefined;
	if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) return undefined;
	if (raw.start_time !== undefined && typeof raw.start_time !== "string") return undefined;
	if (raw.claimant_pid !== undefined && (!Number.isInteger(raw.claimant_pid) || (raw.claimant_pid as number) <= 0)) return undefined;
	if (raw.claimant_start_time !== undefined && raw.claimant_start_time !== null && typeof raw.claimant_start_time !== "string") return undefined;
	if (typeof raw.claim_id !== "string" || raw.claim_id.length === 0) return undefined;
	if (typeof raw.sent_at !== "string") return undefined;
	if (raw.updated_at !== undefined && typeof raw.updated_at !== "string") return undefined;
	return raw as unknown as PendingWakeMarker;
}

function markerMatchesDestination(marker: PendingWakeMarker, paneId: string, pid: number, startTime?: string): boolean {
	return marker.pane_id === paneId && marker.pid === pid && marker.start_time === startTime;
}

function removeMarkerIfClaimMatches(pendingFile: string, claimId: string): void {
	try {
		const existing = parsePendingMarker(readJson<unknown>(pendingFile));
		if (!existing || existing.claim_id !== claimId) return;
		rmSync(pendingFile, { force: true });
	} catch { /* already gone or best effort */ }
}

function removeOwnPendingMarker(
	pendingFile: string,
	handoffId: string,
	paneId: string,
	pid: number,
	startTime?: string,
): void {
	try {
		const existing = parsePendingMarker(readJson<unknown>(pendingFile));
		if (!existing) return;
		if (!markerMatchesDestination(existing, paneId, pid, startTime) || existing.handoff_id !== handoffId) return;
		removeMarkerIfClaimMatches(pendingFile, existing.claim_id);
	} catch { /* absent or best effort */ }
}

type PendingClaimResult =
	| { status: "claimed"; record: PendingWakeMarker }
	| { status: "text_sent"; claimId: string }
	| { status: "error"; reason: string };

async function claimPendingWakeMarker(params: {
	sessionDir: string;
	pendingFile: string;
	handoffId: string;
	destInstance: string;
	readyTaskId: string;
	paneId: string;
	pid: number;
	startTime?: string;
	flushStaleLine: () => Promise<{ ok: true } | { ok: false; commandLabel: string; detail: string }>;
}): Promise<PendingClaimResult> {
	const { sessionDir, pendingFile, handoffId, destInstance, readyTaskId, paneId, pid, startTime, flushStaleLine } = params;
	const record: PendingWakeMarker = {
		version: 1,
		state: "claimed",
		handoff_id: handoffId,
		pane_id: paneId,
		pid,
		...(startTime !== undefined ? { start_time: startTime } : {}),
		claimant_pid: process.pid,
		claimant_start_time: processStartTime(process.pid) ?? null,
		claim_id: randomUUID(),
		sent_at: new Date().toISOString(),
	};
	const payload = JSON.stringify(record, null, 2) + "\n";

	for (let attempt = 0; attempt < 5; attempt++) {
		let published: boolean;
		try {
			published = publishExclusive(pendingFile, payload);
		} catch (error) {
			return { status: "error", reason: `failed to claim pending wake-up marker ${pendingFile}: ${errorMessage(error)}` };
		}
		if (published) {
			return { status: "claimed", record };
		}

		let raw: unknown;
		try {
			raw = readJson<unknown>(pendingFile);
		} catch (readError) {
			if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			return { status: "error", reason: `corrupt marker ${pendingFile}; remove to retry (${errorMessage(readError)})` };
		}
		const existing = parsePendingMarker(raw);
		if (!existing) {
			return { status: "error", reason: `corrupt marker ${pendingFile}; remove to retry (malformed marker)` };
		}
		if (!markerMatchesDestination(existing, paneId, pid, startTime)) {
			removeMarkerIfClaimMatches(pendingFile, existing.claim_id);
			continue;
		}
		if (existing.handoff_id === handoffId) {
			if (existing.state === "claimed") {
				let claimantAlive = true;
				if (existing.claimant_pid !== undefined) {
					try {
						claimantAlive = processAlive({ pid: existing.claimant_pid, start_time: existing.claimant_start_time ?? undefined });
					} catch { /* inability to prove death must not race the current claimant */ }
				}
				if (!claimantAlive) return { status: "text_sent", claimId: existing.claim_id };
				return {
					status: "error",
					reason: `wake-up in progress or interrupted for ${handoffId} on pane ${paneId}; marker ${pendingFile} remains. If its caller is gone and the marker is wedged, deleting it allows a retry`,
				};
			}
			return { status: "text_sent", claimId: existing.claim_id };
		}
		if (isMarkerHandoffLiveOffer(sessionDir, existing.handoff_id, destInstance, readyTaskId)) {
			return {
				status: "error",
				reason: `pane ${paneId} input holds another handoff's pending wake-up text (${existing.handoff_id}); refusing ${handoffId}; marker ${pendingFile} remains until that handoff is claimed or stale. If it is wedged, deleting it allows a retry after confirming no old text remains in pane input`,
			};
		}
		const flush = await flushStaleLine();
		if (!flush.ok) {
			return {
				status: "error",
				reason: `failed to flush stale wake-up text for ${existing.handoff_id} before retrying ${handoffId}: ${flush.commandLabel} Enter failed (${flush.detail}); marker ${pendingFile} remains, and deleting it allows a retry`,
			};
		}
		removeMarkerIfClaimMatches(pendingFile, existing.claim_id);
	}
	return { status: "error", reason: `failed to claim pending wake-up marker ${pendingFile} after concurrent retries` };
}

/**
 * Decide whether a pane wake-up is allowed from durable records and terminal existence, and if so inject the single-line wake-up.
 * Never consults Host agent status (ADR 0003).
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

	const claimStatus = checkOfferUnclaimed(
		request.sessionDir,
		resolvedOffer.value.offer,
		resolvedOffer.value.offerKey,
		destInstance,
		request.destinationAttempt,
		request.handoffId,
	);
	if (claimStatus) {
		if (claimStatus.claimed) {
			const pendingFile = paneWakePendingPath(request.sessionDir, ready.pane_id, ready.pid, ready.start_time);
			removeOwnPendingMarker(pendingFile, request.handoffId, ready.pane_id, ready.pid, ready.start_time);
		}
		return { outcome: "skipped", reason: claimStatus.reason };
	}

	const exec = request.exec ?? defaultHerdrExec;
	const execOpts = { signal: request.signal, timeoutMs: request.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS, env: request.env };
	const paneExists = await checkHerdrPaneExists(exec, ready.pane_id, execOpts);
	if (!paneExists.ok) {
		return { outcome: paneExists.outcome, reason: paneExists.reason };
	}

	// Track unsubmitted wake text in a pane-keyed sidecar claimed atomically via link(2) before send-text.
	const pendingFile = paneWakePendingPath(request.sessionDir, ready.pane_id, ready.pid, ready.start_time);
	const claim = await claimPendingWakeMarker({
		sessionDir: request.sessionDir,
		pendingFile,
		handoffId: request.handoffId,
		destInstance,
		readyTaskId: ready.task_id,
		paneId: ready.pane_id,
		pid: ready.pid,
		startTime: ready.start_time,
		flushStaleLine: () => sendHerdrPaneEnter(exec, ready.pane_id!, execOpts),
	});
	if (claim.status === "error") {
		return { outcome: "failed", reason: claim.reason };
	}
	let ownedClaimId: string;
	if (claim.status === "claimed") {
		ownedClaimId = claim.record.claim_id;
		const textRes = await sendHerdrPaneText(exec, ready.pane_id, wakeLine, execOpts);
		if (!textRes.ok) {
			removeMarkerIfClaimMatches(pendingFile, ownedClaimId);
			return { outcome: "failed", reason: textRes.reason };
		}
		try {
			atomicJson(pendingFile, {
				...claim.record,
				state: "text_sent",
				updated_at: new Date().toISOString(),
			});
		} catch (error) {
			return { outcome: "failed", reason: `failed to update pending wake-up marker ${pendingFile}: ${errorMessage(error)}; deleting it allows a retry after checking pane input` };
		}
	} else {
		ownedClaimId = claim.claimId;
	}
	const keysRes = await sendHerdrPaneEnter(exec, ready.pane_id, execOpts);
	if (!keysRes.ok) {
		return {
			outcome: "failed",
			reason: `${keysRes.commandLabel} ${ready.pane_id} Enter failed (wake line may still be pending in pane input): ${keysRes.detail}; marker ${pendingFile} remains, and deleting it allows a retry after checking pane input`,
		};
	}
	removeMarkerIfClaimMatches(pendingFile, ownedClaimId);

	return { outcome: "sent", pane_id: ready.pane_id, handoff_id: request.handoffId, line: wakeLine };
}
