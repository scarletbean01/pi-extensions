/**
 * Shared wake-up fallback across Host backends (ADR 0003, HOST.md).
 *
 * Used by a completing worker when Coms fails as unreachable or delivery-unknown, and by recovery redelivery.
 * Decides purely from durable records (readiness host_ref/pane_id, live destination process, matching unclaimed offer)
 * and Host node existence (`host.nodeExists`), never consulting Host agent status.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	formatPaneWakeLine, handoffClaimPath, handoffOfferPath, isJoinClaim, isLegacyClaim,
	parseHandoffClaim, parseHandoffOffer, parseJoinHandoffClaim, type HandoffOffer,
} from "./handoff.ts";
import {
	createHost, defaultHostExec, hostBackendOf,
	type Host, type HostBackendName, type HostNodeRef, type HostNodeTarget,
} from "./host.ts";
import type { PaneWakeExec, PaneWakeExecResult } from "./host-herdr.ts";
import { attemptKey, attemptNumber, type ReviewPlan } from "./review-plan.ts";
import {
	atomicJson, errorMessage, isRecord, parseManifest, parseWorkerReady, processAlive, processStartTime,
	publishExclusive, readJson, readyPath, type BootstrapManifest, type WorkerReady,
} from "./session-store.ts";

export type { PaneWakeExec, PaneWakeExecResult };

const HANDOFF_ID_PATTERN = /^h-[0-9a-f]{32}$/;

export type PaneWakeResult =
	| { outcome: "sent"; pane_id?: string; host_ref?: HostNodeRef; handoff_id: string; line: string }
	| { outcome: "skipped"; reason: string }
	| { outcome: "failed"; reason: string };

export interface PaneWakeRequest {
	/** Run's session directory (contains readiness records, handoff offers and claims). */
	sessionDir: string;
	/** Destination attempt ID (e.g. `a2-n2.1`) or destination instance key (`a2-n2`). */
	destinationAttempt: string;
	/** Handoff ID to verify against the durable offer and inject into the pane/terminal. */
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
	/** Optional Host instance to route node existence and delivery through. */
	host?: Host;
	/** Optional Host backend hint when no manifest exists. */
	backend?: HostBackendName;
	/** Optional abort signal. */
	signal?: AbortSignal;
	/** Timeout per Host invocation in ms. */
	timeoutMs?: number;
}

export interface WakeDeliveryContext {
	ready: WorkerReady;
	offer: HandoffOffer;
	destInstance: string;
	wakeLine: string;
	paneId?: string;
	address?: string;
	hostRef?: HostNodeRef;
	target: HostNodeTarget;
}

/** Whether a Coms send failure message is eligible for a wake-up fallback (`unreachable` or `delivery unknown`). */
export function isComsFallbackEligibleError(message: string): boolean {
	const trimmed = message.trim();
	return trimmed.startsWith("coms: unreachable:") || trimmed.startsWith("coms: delivery unknown:");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") ? value : undefined;
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
 * Herdr two-step wake-up injection with pending-line sidecar arbitration.
 * Used by `HerdrHost.sendWakeUp` after shared durable and `host.nodeExists` checks pass.
 */
export async function deliverHerdrPaneWake(params: {
	sessionDir: string;
	handoffId: string;
	destInstance: string;
	ready: WorkerReady;
	paneId: string;
	wakeLine: string;
	sendText: (paneId: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
	sendEnter: (paneId: string) => Promise<{ ok: true } | { ok: false; commandLabel: string; detail: string }>;
}): Promise<PaneWakeResult> {
	const { sessionDir, handoffId, destInstance, ready, paneId, wakeLine, sendText, sendEnter } = params;
	const pendingFile = paneWakePendingPath(sessionDir, paneId, ready.pid, ready.start_time);
	const claim = await claimPendingWakeMarker({
		sessionDir,
		pendingFile,
		handoffId,
		destInstance,
		readyTaskId: ready.task_id,
		paneId,
		pid: ready.pid,
		startTime: ready.start_time,
		flushStaleLine: () => sendEnter(paneId),
	});
	if (claim.status === "error") {
		return { outcome: "failed", reason: claim.reason };
	}
	let ownedClaimId: string;
	if (claim.status === "claimed") {
		ownedClaimId = claim.record.claim_id;
		const textRes = await sendText(paneId, wakeLine);
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
	const keysRes = await sendEnter(paneId);
	if (!keysRes.ok) {
		return {
			outcome: "failed",
			reason: `${keysRes.commandLabel} ${paneId} Enter failed (wake line may still be pending in pane input): ${keysRes.detail}; marker ${pendingFile} remains, and deleting it allows a retry after checking pane input`,
		};
	}
	removeMarkerIfClaimMatches(pendingFile, ownedClaimId);
	return { outcome: "sent", pane_id: paneId, handoff_id: handoffId, line: wakeLine };
}

/**
 * Shared wake-up fallback orchestration: validates durable preconditions (reference present, live process,
 * matching unclaimed offer), verifies Host terminal existence via `host.nodeExists`, and delegates delivery
 * through the Host backend. Never consults Host agent status (ADR 0003).
 */
export async function executePaneWake(
	host: Host,
	request: PaneWakeRequest,
	deliver: (ctx: WakeDeliveryContext) => Promise<PaneWakeResult>,
): Promise<PaneWakeResult> {
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

	let manifest: BootstrapManifest | undefined;
	const manifestFile = join(request.sessionDir, "manifest.json");
	if (existsSync(manifestFile)) {
		try {
			manifest = parseManifest(readJson<unknown>(manifestFile), ready.task_id);
		} catch (error) {
			return { outcome: "failed", reason: `run manifest is unreadable: ${errorMessage(error)}` };
		}
		if (hostBackendOf(manifest) !== host.backend) {
			return {
				outcome: "failed",
				reason: `run manifest host_backend ${hostBackendOf(manifest)} does not match Host backend ${host.backend}`,
			};
		}
	}

	const readyRef = isRecord(ready.host_ref) ? ready.host_ref : undefined;
	const paneId = host.backend === "herdr"
		? (asNonEmptyString(ready.pane_id) ?? asNonEmptyString(readyRef?.pane_id))
		: undefined;
	const address = host.backend === "hc"
		? asNonEmptyString(readyRef?.address)
		: undefined;

	if (host.backend === "herdr" && !paneId) {
		return { outcome: "skipped", reason: `destination ${destInstance} readiness record has no pane_id or host_ref` };
	}
	if (host.backend === "hc" && !address) {
		return { outcome: "skipped", reason: `destination ${destInstance} readiness record has no host_ref` };
	}

	const manifestEntry = manifest?.pane_manifest.find(entry => entry.instance_id === destInstance);
	if (host.backend === "hc" && manifestEntry && isRecord(manifestEntry.host_ref)) {
		const manifestAddress = asNonEmptyString(manifestEntry.host_ref.address);
		if (manifestAddress && manifestAddress !== address) {
			return {
				outcome: "failed",
				reason: `destination ${destInstance} readiness host_ref address ${address} does not match manifest address ${manifestAddress}`,
			};
		}
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
		if (claimStatus.claimed && host.backend === "herdr" && paneId) {
			const pendingFile = paneWakePendingPath(request.sessionDir, paneId, ready.pid, ready.start_time);
			removeOwnPendingMarker(pendingFile, request.handoffId, paneId, ready.pid, ready.start_time);
		}
		return { outcome: "skipped", reason: claimStatus.reason };
	}

	const hostRef: HostNodeRef = host.backend === "hc"
		? (isRecord(manifestEntry?.host_ref) ? manifestEntry.host_ref : (readyRef ?? { address: address! }))
		: { pane_id: paneId! };

	const target: HostNodeTarget = {
		run_id: ready.task_id,
		node_id: resolvedOffer.value.offer.destination.node_id,
		persona_name: manifestEntry?.persona_name ?? ready.name ?? destInstance,
		instance_id: destInstance,
		label: manifestEntry?.label ?? `${ready.task_id}:${destInstance}`,
		...(paneId ? { pane_id: paneId } : {}),
		host_ref: hostRef,
	};

	let existence;
	try {
		existence = await host.nodeExists(target, request.signal);
	} catch (error) {
		return { outcome: "failed", reason: errorMessage(error) };
	}
	if (existence.state === "gone") {
		return {
			outcome: "skipped",
			reason: existence.reason ?? (host.backend === "herdr"
				? `pane ${paneId} does not exist`
				: `hc terminal ${address} does not exist`),
		};
	}
	if (existence.state === "ambiguous") {
		return { outcome: "failed", reason: existence.reason };
	}

	return deliver({
		ready,
		offer: resolvedOffer.value.offer,
		destInstance,
		wakeLine,
		...(paneId ? { paneId } : {}),
		...(address ? { address } : {}),
		hostRef: existence.ref ?? hostRef,
		target,
	});
}

/**
 * Resolve the Host for `request` (from `request.host`, `request.backend`, run manifest, or ready record)
 * and run `host.sendWakeUp(request)`.
 */
export async function tryPaneWake(request: PaneWakeRequest): Promise<PaneWakeResult> {
	if (request.host) {
		return request.host.sendWakeUp(request);
	}
	let backend: HostBackendName | undefined = request.backend;
	if (!backend) {
		const destInstance = resolveDestinationInstance(request.sessionDir, request.destinationAttempt, request.destinationInstance);
		let taskId: string | undefined;
		let readyHostRef: Record<string, unknown> | undefined;
		let hasPaneId = false;
		const readyFile = readyPath(request.sessionDir, destInstance);
		if (existsSync(readyFile)) {
			try {
				const ready = parseWorkerReady(readJson<unknown>(readyFile));
				taskId = ready.task_id;
				if (isRecord(ready.host_ref)) readyHostRef = ready.host_ref;
				hasPaneId = Boolean(asNonEmptyString(ready.pane_id) ?? asNonEmptyString(readyHostRef?.pane_id));
			} catch { /* executePaneWake reports unreadable ready record */ }
		}
		const manifestFile = join(request.sessionDir, "manifest.json");
		if (existsSync(manifestFile) && taskId) {
			try {
				backend = hostBackendOf(parseManifest(readJson<unknown>(manifestFile), taskId));
			} catch { /* executePaneWake reports unreadable manifest */ }
		}
		if (!backend && readyHostRef && asNonEmptyString(readyHostRef.address) && !hasPaneId) {
			backend = "hc";
		}
	}
	const host = createHost(backend ?? "herdr", {
		exec: request.exec ?? defaultHostExec,
		env: request.env ?? process.env,
	});
	return host.sendWakeUp(request);
}
