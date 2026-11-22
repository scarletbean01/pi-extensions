/** Child-only extension: bind the exact persona, acknowledge readiness, and persist/route results. */
import { attemptKey, attemptNumber, blockedReviewForwardEdge, deadLoopMembers, finalizeMemberAfterDecision, finalizeReview, readFinalization, reserveRevision, revisionReserved, reviewLoopFor, reviewRoutes, reviewVerdict, settleReviewFailure } from "./review-loop.ts";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { modelMatches } from "./model-utils.ts";
import { resultFields } from "./schemas.ts";
import { decideAdmission, effectiveDependencyPolicy, executionFromResult, type AdmissionDecision, type CauseRef, type DispositionState, type ExecutionState, type NodeExecution } from "./outcomes.ts";
import { awaitDirection, createRequest, findOpenRequest, inTransaction, openRequestDatabase, terminateNodeRequests } from "./factory-requests.ts";
import { requiredChecksOf, upstreamRequiredChecks, verifyEvidence } from "./evidence.ts";
import { inspectFactoryReleaseState, isFactoryTaskId, resolveCheckoutIdentity } from "./factory-evidence.ts";
import {
	assertNoSymlinkPath, atomicJson, BOOTSTRAP_LAUNCH_COMMAND, collaborationModeOf, completionRecord, delay, dependencyPolicyOf, dispositionPath, dispositionRecord, errorMessage, expectedResultVersion, factoryRunPath, failurePolicyOf, inboundEdgesOf, nodeIdentity, parseCompletion, parseDisposition, parseManifest, parseWorkerConfig, parseWorkerReady, pathEntryExists, processAlive, processStartTime, publishExclusive, readJson, readRegularJsonNoSymlink, readyPath, resultPath, unknownAllowedSkills,
	type BootstrapResult, type Disposition, type EdgeDeliveryState, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import {
	cancelPath, claimOutcome, DEFAULT_CANCEL_GRACE_MS, DEFAULT_DEPENDENCY_WAIT_MS, HEARTBEAT_STALE_MS, humanWaitStartedAt, outcomeClaimPath, parseCancelRecord, parseOutcomeClaim, parseRunCancelRecord, runCancelPath, writeCancelRecord, type CancelIdentity, type ProgressSnapshot,
} from "./cancellation.ts";
import {
	BRIEF_FIELD_MAX_BYTES, enrichArtifactsWithProvenance, formatAuthoritativeBrief, formatPeerDataSection, parseTaskInput, readBoundedInput, readUpstreamIndex, resultHash, sha256Text, taskInputPath, truncateUtf8, upsertUpstreamIndex,
	validateArtifactHashes, validateOutputContract, validateUpstreamAdmission,
	type TaskInputRecord, type UpstreamIndex,
} from "./contracts.ts";
import { claimHandoff, claimJoinHandoff, evaluateHandoff, evaluateJoinHandoff, handoffClaimPath, handoffNotification, handoffOfferPath, handoffSourceScope, inputDigest, isLegacyClaim, latestReviewAttempt, offerMismatch, parseHandoffClaim, parseHandoffOffer, parseJoinHandoffClaim, markHandoffQueued, offerHandoff, recordHandoffRejection, reviewDeliveryClaimed, type HandoffOffer } from "./handoff.ts";
import {
	beginVerificationCheck, evaluateNodeVerification, finishVerificationCheck, runVerificationCommand,
	type StartedVerificationCheck,
} from "./verification.ts";
import {
	evaluateOwnershipDependencies, ownershipPath, ownershipRecord, parseOwnershipRecord, publishFailFast, readFailFast,
	type OwnershipState,
} from "./ownership.ts";

function looksLikeResult(input: unknown): boolean {
	const value = input as { status?: unknown; summary?: unknown; detail?: unknown } | undefined;
	return !!value && ["success", "partial", "failure"].includes(value.status as string)
		&& typeof value.summary === "string" && value.summary.length > 0 && typeof value.detail === "string";
}

/** What this worker's own result file must say about itself. */
const ownExpectation = (config: WorkerConfig) => {
	const version = expectedResultVersion(config);
	return { run_id: config.task_id, instance_id: config.instance_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id, ...(version !== undefined ? { version } : {}) };
};
/** Ownership records are per-instance across loop attempts, so review-plan runs validate without attempt_id. */
const ownershipExpectation = (config: WorkerConfig) => ({ run_id: config.task_id, instance_id: config.instance_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.review_plan ? attemptKey(config.review_plan, config.instance_id, 1) : config.attempt_id });
const activeKey = (config: WorkerConfig) => attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id));
const sourceKey = (config: WorkerConfig, source: string, sourceAttempt?: number) => attemptKey(config.review_plan, source, sourceAttempt ?? (source === config.predecessor ? config.predecessor_attempt : undefined));
const predecessorKey = (config: WorkerConfig) => sourceKey(config, config.predecessor!);
const ownLoop = (config: WorkerConfig) => reviewLoopFor(config.review_plan, config.instance_id);

/** What a predecessor's result file must say; the roster (when present) says which node and persona it is. */
function sourceExpectation(config: WorkerConfig, sourceInstanceId: string, sourceAttempt?: number) {
	const member = config.roster?.find(member => member.instance_id === sourceInstanceId);
	const version = expectedResultVersion(config);
	return { run_id: config.task_id, instance_id: sourceInstanceId, node_id: member?.node_id, persona_name: member?.persona_name, ...(config.review_plan ? { attempt_id: sourceKey(config, sourceInstanceId, sourceAttempt) } : {}), ...(version !== undefined ? { version } : {}) };
}
function predecessorExpectation(config: WorkerConfig) {
	return sourceExpectation(config, config.predecessor!);
}
/** Read the source outcome that governs admission. */
function sourceRecord(config: WorkerConfig, sourceInstanceId: string, sourceAttempt?: number): { completion?: WorkerCompletion; disposition?: Disposition } {
	const expected = sourceExpectation(config, sourceInstanceId, sourceAttempt);
	const key = sourceKey(config, sourceInstanceId, sourceAttempt);
	const result = resultPath(config.session_dir, key);
	const disposition = dispositionPath(config.session_dir, key);
	if (existsSync(result)) {
		const completion = parseCompletion(readJson<unknown>(result), expected);
		const loop = reviewLoopFor(config.review_plan, sourceInstanceId);
		if (loop?.reviewer === sourceInstanceId && existsSync(disposition)) {
			const finalization = readFinalization(config.session_dir, config.task_id, loop, sourceInstanceId);
			if (finalization?.attempt_id === key && finalization.finalized_by === "dispatcher" && reviewVerdict(loop, completion.result) === "reject") {
				const saved = parseDisposition(readJson<unknown>(disposition), expected);
				if (saved.state === "cancelled") return { disposition: saved };
			}
		}
		return { completion };
	}
	if (existsSync(disposition)) return { disposition: parseDisposition(readJson<unknown>(disposition), expected) };
	return {};
}
function predecessorRecord(config: WorkerConfig): { completion?: WorkerCompletion; disposition?: Disposition } {
	return sourceRecord(config, config.predecessor!);
}
const sourceNode = (config: WorkerConfig, sourceInstanceId: string) =>
	config.roster?.find(member => member.instance_id === sourceInstanceId)?.node_id ?? sourceInstanceId;
const predecessorNode = (config: WorkerConfig) => sourceNode(config, config.predecessor!);

function isManagedWorker(config: WorkerConfig): boolean {
	if (config.factory_managed !== undefined || isFactoryTaskId(config.task_id)) return true;
	try {
		return pathEntryExists(factoryRunPath(config.session_dir));
	} catch {
		return true;
	}
}

function verifyFactoryReleaseAuthority(
	config: WorkerConfig,
): { taskId: string; text: string; digest: string } {
	const sidecarPath = factoryRunPath(config.session_dir);
	let hasSidecar = false;
	try { hasSidecar = pathEntryExists(sidecarPath); } catch { hasSidecar = true; }
	if (!config.factory_managed || !hasSidecar) {
		throw new Error("Contradictory or missing factory run metadata at release barrier");
	}
	if (
		config.project_cwd !== config.factory_managed.canonical_checkout
		|| config.session_dir !== join(config.factory_managed.canonical_checkout, ".pi", "agent-sessions", config.task_id)
	) {
		throw new Error("Worker configuration project or session path contradicts factory_managed metadata");
	}
	const check = inspectFactoryReleaseState({
		taskId: config.task_id,
		token: config.token,
		sessionDir: config.session_dir,
		primaryMeta: config.factory_managed,
	});
	if (check.kind !== "released") {
		throw new Error(check.reason ?? "Factory release authorization is absent, unapproved, or mismatched");
	}
	if (check.attempt_state === "settled" || check.attempt_state === "cleared") throw new Error(`This factory run is ${check.attempt_state}; a worker may not act on it`);
	if (typeof check.submitted_brief !== "string" || typeof check.submitted_brief_digest !== "string") {
		throw new Error("Factory release proof did not include authoritative accepted brief");
	}
	const liveCheckout = resolveCheckoutIdentity(config.project_cwd);
	if (
		liveCheckout.canonical_checkout !== config.factory_managed.canonical_checkout
		|| liveCheckout.checkout_key !== config.factory_managed.checkout_key
	) {
		throw new Error(
			`Project checkout physical identity changed before release (${liveCheckout.checkout_key} !== ${config.factory_managed.checkout_key})`,
		);
	}
	return {
		taskId: config.task_id,
		text: check.submitted_brief,
		digest: check.submitted_brief_digest,
	};
}

function graphPredecessors(config: WorkerConfig): Map<string, string[]> {
	let nodes: ReadonlyArray<{ instance_id: string; predecessor?: string; inbound_edges?: string[] }> = config.roster ?? [];
	// V3 graph rosters omit dependencies, but their manifest records the graph.
	try {
		const manifest = parseManifest(readJson<unknown>(join(config.session_dir, "manifest.json")), config.task_id);
		if (manifest.topology === "graph" && manifest.token === config.token) nodes = manifest.pane_manifest;
	} catch { /* use the dependencies available in the worker configuration */ }
	return new Map(nodes.map(node => [node.instance_id, inboundEdgesOf(node)]));
}

function graphAncestors(predecessors: Map<string, string[]>, inbound: string[]): Set<string> {
	const ancestors = new Set(inbound);
	for (const id of ancestors) for (const parent of predecessors.get(id) ?? []) ancestors.add(parent);
	return ancestors;
}

function executionOf(record: { completion?: WorkerCompletion; disposition?: Disposition }): NodeExecution | undefined {
	if (record.completion) return { ...executionFromResult(record.completion.result.status), reason: record.completion.result.summary };
	if (record.disposition) return { state: record.disposition.state, causes: record.disposition.causes, reason: record.disposition.reason };
}
/** May this edge admit the node, given what its source recorded, the effective dependency policy, and the evidence its required checks have now? */
function admissionForEdge(config: WorkerConfig, sourceInstanceId: string, record: { completion?: WorkerCompletion; disposition?: Disposition }, sourceAttempt?: number): AdmissionDecision {
	const execution = executionOf(record);
	const node_id = sourceNode(config, sourceInstanceId);
	if (!execution) return { admit: false, outcome: "wait", reason: `${node_id} has not recorded an outcome` };
	const reported = execution.state === "succeeded" || execution.state === "partial";
	const required = upstreamRequiredChecks(config, sourceInstanceId);
	const checks = reported ? verifyEvidence(config.session_dir, sourceInstanceId, config.project_cwd, required, config.task_id, sourceKey(config, sourceInstanceId, sourceAttempt)).map(({ check, status }) => ({ name: check, status })) : [];
	const policy = inboundEdgesOf(config).length > 1
		? effectiveDependencyPolicy(config.join_policy, dependencyPolicyOf(config, true))
		: dependencyPolicyOf(config, true)!;
	return decideAdmission({ policy, predecessor: { node_id, execution }, checks });
}
function admission(config: WorkerConfig, record: { completion?: WorkerCompletion; disposition?: Disposition }, finalization?: ReturnType<typeof readFinalization>): AdmissionDecision {
	const loop = reviewLoopFor(config.review_plan, config.predecessor!);
	if (loop && finalization) {
		const blocked = blockedReviewForwardEdge(loop, finalization, predecessorNode(config), executionOf(record), record.completion?.result);
		if (blocked) return blocked;
	}
	return admissionForEdge(config, config.predecessor!, record);
}
function evaluateJoinAdmission(config: WorkerConfig, inbound: string[]):
	| { outcome: "admit" }
	| { outcome: "wait"; pendingSources: string[] }
	| { outcome: "blocked"; reason: string; causes: CauseRef[] } {
	const pendingSources: string[] = [];
	const blockedReasons: string[] = [];
	const allCauses: CauseRef[] = [];
	const seenCause = new Set<string>();
	const pushCauses = (causes: CauseRef[]) => {
		for (const cause of causes) {
			const key = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`;
			if (!seenCause.has(key)) { seenCause.add(key); allCauses.push(cause); }
		}
	};
	const destLoop = ownLoop(config);
	for (const src of inbound) {
		const srcLoop = reviewLoopFor(config.review_plan, src);
		let sourceAttempt: number | undefined;
		let finalization: ReturnType<typeof readFinalization>;
		if (srcLoop && srcLoop !== destLoop) {
			finalization = readFinalization(config.session_dir, config.task_id, srcLoop, src);
			if (!finalization) {
				pendingSources.push(src);
				continue;
			}
			sourceAttempt = attemptNumber(finalization.attempt_id);
		} else if (srcLoop) {
			sourceAttempt = attemptNumber(config.attempt_id);
		}
		const rec = sourceRecord(config, src, sourceAttempt);
		const execution = executionOf(rec);
		if (!execution || execution.state === "needs_attention") {
			pendingSources.push(src);
			continue;
		}
		const closed = srcLoop && finalization
			? blockedReviewForwardEdge(srcLoop, finalization, sourceNode(config, src), execution, rec.completion?.result)
			: undefined;
		if (closed) {
			blockedReasons.push(closed.reason);
			pushCauses(closed.causes);
			continue;
		}
		const dec = admissionForEdge(config, src, rec, sourceAttempt);
		if (!dec.admit) {
			if (dec.outcome === "wait") {
				pendingSources.push(src);
			} else {
				blockedReasons.push(dec.reason);
				pushCauses(dec.causes);
			}
		}
	}
	if (blockedReasons.length > 0) return { outcome: "blocked", reason: blockedReasons.join("; "), causes: allCauses };
	if (pendingSources.length > 0) return { outcome: "wait", pendingSources };
	return { outcome: "admit" };
}

/** The identities the model is told it runs under. Version 1 configurations predate nodes and attempts. */
const identityLine = (config: WorkerConfig) => `Run: ${config.task_id}. ${config.version === 1 ? "" : `Node: ${config.node_id}. `}Persona: ${config.persona_name}. ${config.attempt_id ? `Attempt: ${config.attempt_id}. ` : ""}Instance: ${config.instance_id}.`;
const taskPrompt = (config: WorkerConfig) => {
	const sub = truncateUtf8(config.sub_task, BRIEF_FIELD_MAX_BYTES * 2);
	const suffix = sub.truncated ? ` [Truncated. Retrieve full input via bootstrap_read_input({ kind: "task_input" }) or read ${taskInputPath(config.session_dir, attemptKey(config.review_plan, config.instance_id))}.]` : "";
	return `Bootstrap task ${config.task_id}\n\n${sub.text}${suffix}\n\nWhen finished, call bootstrap_complete with your structured result.`;
};

function executionModeLine(config: WorkerConfig): string {
	const mode = collaborationModeOf(config);
	const workspaceNote = "Workspace: shared_cwd (path declarations and active tool lists are an advisory scheduling contract, not a filesystem sandbox).";
	if (mode === "independent") {
		return `Execution mode: independent (unsolicited peer task activation via Coms is disabled; complete your own assignment via bootstrap_complete). ${workspaceNote}`;
	}
	if (mode === "collaborative") {
		return `Execution mode: collaborative (explicitly opted in). ${workspaceNote}`;
	}
	return `Execution mode: legacy (retains existing peer messaging behavior; migrate to persona/node_id plans for independent mode). ${workspaceNote}`;
}

// Match Pi's own section, including its boundaries, so other documentation stays intact.
const piHarnessDocs = new RegExp([
	String.raw`\n\n<docs>`,
	String.raw`Pi documentation \(read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI\):`,
	String.raw`- Main documentation: [^\n]+/README\.md`,
	String.raw`- Additional docs: [^\n]+`,
	String.raw`- Examples: [^\n]+`,
	String.raw`- When reading pi docs or examples, [^\n]+`,
	String.raw`- When asked about: [^\n]+`,
	String.raw`- Before implementing harness changes, [^\n]+`,
	String.raw`</docs>(?=\n\n|$)`,
].join("\n"));

export default function (pi: ExtensionAPI) {
	pi.registerFlag("bootstrap-worker-config", { description: "Bootstrap child launch configuration", type: "string" });
	pi.registerFlag("allowed-skills", { description: "Comma-separated skill names to advertise, or none", type: "string" });
	let config: WorkerConfig | undefined;
	let authoritativeBrief: { taskId: string; text: string; digest: string } | undefined;
	let released = false;
	let initialized = false;
	let allowedSkillNames: Set<string> | undefined;
	let completing = false;
	let completionSettled: Promise<void> | undefined;
	let completionRequested = false;
	let completed = false;
	/** An accepted task has no result and will not be replayed: nothing may start for this attempt. */
	let holdForAttention = false;
	let delivered = false;
	let started = false;
	let admitted = false;
	/** Start of the currently open human wait, if any. */
	let waitingForHumanSince: number | undefined;
	/** Close this node's open direction request when it ends without a successful result; a dead attempt must not look like it will continue. */
	const closeOpenRequests = (cfg: WorkerConfig | undefined, reason: "cancelled" | "failed") => {
		if (!cfg?.intervention || !cfg.factory_managed) return;
		try {
			const db = openRequestDatabase(cfg.factory_managed.state_db_path);
			try { inTransaction(db, () => terminateNodeRequests(db, cfg.factory_managed!.attempt_id, cfg.node_id, reason)); } finally { db.close(); }
		} catch { /* factory storage unavailable: settlement closes it later */ }
	};
	let ownershipAdmitted = false;
	let startupSeen = false;
	/** A specific failure was already recorded; shutdown must not replace it with a generic one. */
	let failureRecorded = false;
	/** This instance belongs to a replacement session (/new, /resume, /fork): not a bootstrap worker any more. */
	let detached = false;
	let cancelAborted = false;
	let predecessorTimer: ReturnType<typeof setInterval> | undefined;
	let ownershipTimer: ReturnType<typeof setInterval> | undefined;
	const joinWakeSources = new Set<string>();
	let queuedHandoffWake: "queued" | "grace_elapsed" | undefined;
	let failFastTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let cancelTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: { shutdown: () => void } | undefined;
	/** Toolset before bootstrap restricted it, restored if this runtime is ever reused for a replacement session. */
	let originalTools: string[] | undefined;
	let parkedTools: string[] | undefined;
	/** Attempt key for which we already issued our single bounded completion reminder before settling. */
	let completionReminderAttempt: string | undefined;
	/** Last observed model/tool activity: a heartbeat proves only a live event loop, this proves progress. */
	let activityAt: number | undefined;
	/** Start of the attempt's execution clock, shifted forward by completed human waits. */
	let startedAt: number | undefined;
	const pendingChecks = new Map<string, StartedVerificationCheck>();
	const markActivity = () => {
		const now = Date.now();
		if (!config || !released || waitingForHumanSince !== undefined || activityAt === now) return;
		activityAt = now;
		// A writer's or graph-loop member's useful activity must be visible even between heartbeat ticks.
		if (started && !completed && (config.write_paths?.length || (config.topology === "graph" && ownLoop(config)))) writeProgress();
	};
	for (const event of ["turn_start", "message_start", "tool_execution_start", "tool_result"] as const) pi.on(event as any, async () => { markActivity(); });
	const stopTimers = () => {
		queuedHandoffWake = undefined;
		joinWakeSources.clear();
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
		if (failFastTimer) { clearInterval(failFastTimer); failFastTimer = undefined; }
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
		if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = undefined; }
	};

	const cancelIdentity = (cfg: WorkerConfig): CancelIdentity => ({
		run_id: cfg.task_id,
		node_id: cfg.node_id,
		persona_name: cfg.persona_name,
		...(cfg.attempt_id !== undefined ? { attempt_id: cfg.attempt_id } : {}),
		instance_id: cfg.instance_id,
	});

	const readCancellation = (cfg = config): { cancelled: boolean; reason?: string; error?: string } => {
		if (!cfg) return { cancelled: false };
		const expected = cancelIdentity(cfg);
		const claimFile = outcomeClaimPath(cfg.session_dir, activeKey(cfg));
		let claimOutcomeVal: "completed" | "cancelled" | undefined;
		if (existsSync(claimFile)) {
			try {
				claimOutcomeVal = parseOutcomeClaim(readJson<unknown>(claimFile), expected).outcome;
				if (claimOutcomeVal === "completed") return { cancelled: false };
			} catch (error) {
				return { cancelled: false, error: `unusable outcome claim: ${errorMessage(error)}` };
			}
		}
		const nodeCancel = cancelPath(cfg.session_dir, cfg.instance_id);
		if (existsSync(nodeCancel)) {
			try {
				const rec = parseCancelRecord(readJson<unknown>(nodeCancel), cfg.review_plan ? { ...expected, attempt_id: undefined } : expected);
				if (!cfg.review_plan || !rec.identity.attempt_id || rec.identity.attempt_id === expected.attempt_id) {
					return { cancelled: true, reason: rec.reason };
				}
			} catch (error) {
				return { cancelled: false, error: `unusable cancel record: ${errorMessage(error)}` };
			}
		}
		const runCancel = runCancelPath(cfg.session_dir);
		if (existsSync(runCancel)) {
			try {
				const rec = parseRunCancelRecord(readJson<unknown>(runCancel), cfg.task_id);
				return { cancelled: true, reason: rec.reason };
			} catch (error) {
				return { cancelled: false, error: `unusable run cancel record: ${errorMessage(error)}` };
			}
		}
		if (claimOutcomeVal === "cancelled") return { cancelled: true, reason: "Cancelled concurrently with completion" };
		return { cancelled: false };
	};

	const failClosedCancelError = (message: string, ctx: { abort?: () => void; shutdown: () => void }, cfg = config) => {
		holdForAttention = true;
		recordFailure(message, cfg);
		stopTimers();
		ctx.abort?.();
		ctx.shutdown();
	};

	const settleReviewDisposition = (cfg: WorkerConfig, path: string) => {
		if (!ownLoop(cfg) || !existsSync(path)) return;
		try {
			const disposition = parseDisposition(readJson<unknown>(path), ownExpectation(cfg));
			if (disposition.state === "blocked" || disposition.state === "cancelled") settleReviewFailure(cfg, disposition);
		} catch (error) {
			recordFailure(`Review settlement failed: ${errorMessage(error)}`, cfg);
		}
	};

	const recordCancelled = (reason: string, ctx: { shutdown: () => void }, settled = false, cfg = config) => {
		if (!cfg || (cfg === config && completed)) return;
		if (cfg === config && started && !settled && reason.startsWith("Cancelled by fail-fast policy")) return;
		if (existsSync(resultPath(cfg.session_dir, activeKey(cfg)))) return;
		if (cfg.review_plan) {
			try {
				const outcome = claimOutcome(cfg.session_dir, cancelIdentity(cfg), "cancelled", new Date().toISOString(), activeKey(cfg));
				if (!outcome.won) return;
			} catch (error) { failClosedCancelError(errorMessage(error), ctx, cfg); return; }
		}
		const dispFile = dispositionPath(cfg.session_dir, activeKey(cfg));
		if (!existsSync(dispFile)) {
			try {
				const ff = reason.startsWith("Cancelled by fail-fast policy")
					? readFailFast(cfg.session_dir, cfg.task_id, cfg.token).record : undefined;
				const causes: CauseRef[] = ff ? [{ node_id: ff.cause.node_id, state: ff.cause.state, reason: ff.cause.reason }] : [];
				atomicJson(dispFile, dispositionRecord(cfg, "cancelled", reason, causes, new Date().toISOString()));
			} catch { /* project storage unavailable */ }
		}
		settleReviewDisposition(cfg, dispFile);
		if (ownershipAdmitted) persistOwnership("released");
		closeOpenRequests(cfg, "cancelled");
		completed = true;
		if (cfg !== config) finishBlockedRevision(cfg);
		else stopTimers();
		ctx.shutdown();
	};

	const park = () => {
		admitted = false;
		parkedTools ??= pi.getActiveTools();
		pi.setActiveTools([]);
	};
	const deliverySettled = (cfg: WorkerConfig, completion: WorkerCompletion): boolean => {
		if (completion.delivery === "sent" || completion.delivery === "not_required") return true;
		return !!cfg.review_plan && !!completion.identity && reviewDeliveryClaimed(cfg.session_dir, completion,
			reviewRoutes(cfg.session_dir, completion.identity, cfg.review_plan, completion.result,
				cfg.outbound_edges ?? (cfg.successor ? [cfg.successor] : [])));
	};

	const refreshParkedDelivery = () => {
		if (!config?.review_plan || !ownLoop(config) || !completed || completing || delivered || holdForAttention) return;
		const path = resultPath(config.session_dir, activeKey(config));
		if (!existsSync(path)) return;
		delivered = deliverySettled(config, parseCompletion(readJson<unknown>(path), ownExpectation(config)));
		if (delivered) park();
	};

	const errorFile = (cfg = config!) => join(cfg.session_dir, `${activeKey(cfg)}.error.json`);
	/** Written when the user replaces this worker's session, so a later /reload of the replacement never revives the worker role. */
	const detachedFile = (cfg: WorkerConfig) => join(cfg.session_dir, `${cfg.instance_id}.detached.json`);
	const recordFailure = (message: string, cfg = config) => {
		if (!cfg) return;
		if (cfg !== config) holdForAttention = true;
		failureRecorded = true;
		closeOpenRequests(cfg, "failed");
		try { atomicJson(errorFile(cfg), { error: message }); } catch { /* cleanup may have removed session files */ }
		if (initialized && failurePolicyOf(cfg) === "fail_fast") {
			try {
				publishFailFast({
					sessionDir: cfg.session_dir,
					taskId: cfg.task_id,
					token: cfg.token,
					cause: { node_id: cfg.node_id, instance_id: cfg.instance_id, state: "needs_attention", reason: message },
				});
			} catch { /* best effort */ }
		}
	};

	const persistOwnership = (state: OwnershipState) => {
		if (!config || config.version === 1) return;
		if (!config.write_paths?.length && !config.read_paths?.length && !config.ownership_wait_for?.length && !existsSync(ownershipPath(config.session_dir, config.instance_id))) return;
		const path = ownershipPath(config.session_dir, config.instance_id);
		let prevAdmittedAt: string | undefined;
		let prevStartupSeen = false;
		if (existsSync(path)) {
			// Fail closed on unsupported/foreign ownership records so they are never overwritten.
			const existing = parseOwnershipRecord(readJson<unknown>(path), ownershipExpectation(config));
			prevAdmittedAt = existing.admitted_at;
			prevStartupSeen = existing.startup_seen === true;
		}
		const now = new Date().toISOString();
		const record = ownershipRecord({
			identity: { run_id: config.task_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.review_plan ? attemptKey(config.review_plan, config.instance_id, 1) : (config.attempt_id ?? config.instance_id), instance_id: config.instance_id },
			state,
			write_paths: config.write_paths ?? [],
			read_paths: config.read_paths ?? [],
			waiting_for: config.ownership_wait_for ?? [],
			startup_seen: state === "waiting" ? (startupSeen || prevStartupSeen) : false,
			admitted_at: state === "admitted" ? (prevAdmittedAt ?? now) : prevAdmittedAt,
			released_at: state === "released" ? now : undefined,
			updated_at: now,
		});
		try { atomicJson(path, record); } catch { /* project storage unavailable */ }
	};

	const sendOwnershipAdmission = () => {
		if (!config || !startupSeen || config.predecessor || typeof (pi as any).sendMessage !== "function") return;
		(pi as any).sendMessage({
			customType: "bootstrap-ownership-admit",
			content: taskPrompt(config),
			display: true,
			details: { token: config.token, instance_id: config.instance_id },
		}, { deliverAs: "followUp", triggerTurn: true });
	};

	const ownershipDependencies = (cfg: WorkerConfig) => evaluateOwnershipDependencies({
		sessionDir: cfg.session_dir,
		taskId: cfg.task_id,
		token: cfg.token,
		waitingFor: cfg.ownership_wait_for ?? [],
		topology: cfg.topology,
		reviewPlan: cfg.review_plan,
		instanceId: cfg.instance_id,
		roster: cfg.roster,
	});

	const tryAdmitOwnership = (notifyIfWaiting = false, beforeHandoff = false): boolean => {
		if (!config) return false;
		if (ownershipAdmitted) return true;
		const ownFile = ownershipPath(config.session_dir, config.instance_id);
		let wasWaiting = false;
		if (config.version !== 1 && existsSync(ownFile)) {
			// Validate at read boundary; unsupported/foreign records throw and leave the file untouched.
			const existing = parseOwnershipRecord(readJson<unknown>(ownFile), ownershipExpectation(config));
			if (existing.startup_seen) startupSeen = true;
			if (existing.state === "admitted" || existing.state === "released") {
				ownershipAdmitted = true;
				return true;
			}
			wasWaiting = existing.state === "waiting";
		}
		// A follower's waiting record belongs to the handoff poller. The startup poll
		// may reserve free paths, but must never consume or manufacture its wake.
		if (beforeHandoff && wasWaiting) return false;
		if (!ownershipDependencies(config).admitted) {
			if (!beforeHandoff && (!config.predecessor || !wasWaiting)) persistOwnership("waiting");
			return false;
		}
		ownershipAdmitted = true;
		persistOwnership("admitted");
		if (notifyIfWaiting && wasWaiting) sendOwnershipAdmission();
		return true;
	};

	const releaseOwnershipForDisposition = (path: string) => {
		if (!config || (!ownershipAdmitted && (!config.predecessor || !existsSync(ownershipPath(config.session_dir, config.instance_id))))) return;
		try {
			const existing = parseDisposition(readJson<unknown>(path), ownExpectation(config));
			if (existing.state !== "needs_attention") persistOwnership("released");
		} catch { /* retain ownership if the existing disposition is unusable */ }
	};

	/**
	 * End this node without executing it (blocked) or without a resolvable outcome (needs_attention): the system's record, never a worker
	 * result. A version 1 worker has no such record, so it keeps its original behavior of recording its own failure.
	 */
	const endWithoutExecuting = (state: DispositionState, reason: string, causes: CauseRef[], legacySummary: string, cfg = config) => {
		if (!cfg) return;
		const destPath = cfg.version === 1 ? resultPath(cfg.session_dir, activeKey(cfg)) : dispositionPath(cfg.session_dir, activeKey(cfg));
		if (cfg.version !== 1 && existsSync(destPath)) {
			settleReviewDisposition(cfg, destPath);
			releaseOwnershipForDisposition(destPath);
			completed = true;
			holdForAttention = true;
			return;
		}
		const now = new Date().toISOString();
		const record = cfg.version === 1
			? completionRecord(cfg, { status: "failure", summary: legacySummary, detail: reason } as BootstrapResult, "not_required", now)
			: dispositionRecord(cfg, state, reason, causes, now);
		try {
			if (cfg.review_plan) publishExclusive(destPath, JSON.stringify(record, null, 2) + "\n");
			else atomicJson(destPath, record);
		} catch { /* project storage unavailable */ }
		settleReviewDisposition(cfg, destPath);
		if (state !== "needs_attention" && (ownershipAdmitted || (cfg.predecessor && existsSync(ownershipPath(cfg.session_dir, cfg.instance_id))))) {
			try { persistOwnership("released"); } catch { /* retain unusable ownership record */ }
		}
		completed = true;
		holdForAttention = true;
	};

	const checkAndApplyFailFast = (ctx?: { abort?: () => void; shutdown: () => void }, cfg = config): boolean => {
		if (!cfg || (cfg === config && completed) || failureRecorded || failurePolicyOf(cfg) !== "fail_fast") return false;
		if (existsSync(errorFile(cfg)) || existsSync(resultPath(cfg.session_dir, activeKey(cfg))) || existsSync(dispositionPath(cfg.session_dir, activeKey(cfg)))) return false;
		const targetCtx = ctx ?? activeCtx;
		const isRunning = cfg === config && started;
		const info = readFailFast(cfg.session_dir, cfg.task_id, cfg.token);
		if (info.error) {
			endWithoutExecuting("needs_attention", info.error, [], "Unusable fail-fast evidence", cfg);
			if (targetCtx) failClosedCancelError(info.error, targetCtx, cfg);
			return true;
		}
		const ff = info.record;
		if (!ff || ff.cause.instance_id === cfg.instance_id) return false;
		const predecessorLoop = cfg.predecessor && reviewLoopFor(cfg.review_plan, cfg.predecessor);
		if (!isRunning && predecessorLoop && predecessorLoop !== ownLoop(cfg)) {
			try {
				const final = readFinalization(cfg.session_dir, cfg.task_id, predecessorLoop, cfg.predecessor!);
				// Let the loop publish its dependency outcome before deciding whether to cancel this waiting successor.
				if (!final) return false;
				const predCfg = { ...cfg, predecessor_attempt: attemptNumber(final.attempt_id) };
				const decision = admission(predCfg, predecessorRecord(predCfg), final);
				if (!decision.admit && decision.outcome === "blocked") {
					endWithoutExecuting("blocked", decision.reason, decision.causes, "Chain dependency failed", cfg);
					stopTimers();
					targetCtx?.shutdown();
					return true;
				}
			} catch (error) {
				if (targetCtx) failClosedCancelError(errorMessage(error), targetCtx, cfg);
				return true;
			}
		}
		const reason = `Cancelled by fail-fast policy after ${ff.cause.node_id} (${ff.cause.state}): ${ff.cause.reason}`;
		const nowIso = new Date().toISOString();
		try {
			const claim = claimOutcome(cfg.session_dir, cancelIdentity(cfg), "cancelled", nowIso, activeKey(cfg));
			if (!claim.won) return false;
			writeCancelRecord(cfg.session_dir, {
				identity: { ...cancelIdentity(cfg), ...(cfg.review_plan ? { attempt_id: undefined } : {}) },
				scope: "node",
				reason,
				requestedAt: nowIso,
				graceMs: cfg.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS,
			});
		} catch (error) {
			if (targetCtx) failClosedCancelError(`unusable cancel/claim record during fail-fast: ${errorMessage(error)}`, targetCtx, cfg);
			return false;
		}
		if (!isRunning) endWithoutExecuting(
			"cancelled",
			reason,
			[{ node_id: ff.cause.node_id, state: ff.cause.state, reason: ff.cause.reason }],
			"Run cancelled by fail-fast policy",
			cfg,
		);
		if (!cancelAborted && targetCtx?.abort) { cancelAborted = true; targetCtx.abort(); }
		if (!isRunning) {
			if (cfg !== config) finishBlockedRevision(cfg);
			else stopTimers();
			targetCtx?.shutdown();
		}
		return true;
	};

	const publishFailure = (cfg: WorkerConfig, reason: string) => {
		if (failurePolicyOf(cfg) !== "fail_fast") return;
		try {
			publishFailFast({
				sessionDir: cfg.session_dir,
				taskId: cfg.task_id,
				token: cfg.token,
				cause: { node_id: cfg.node_id, instance_id: cfg.instance_id, state: "failed", reason },
			});
		} catch { /* best effort */ }
	};

	const startFailFastTimer = (ctx: { abort: () => void; shutdown: () => void }) => {
		if (!config || completed || failFastTimer || failurePolicyOf(config) !== "fail_fast") return;
		failFastTimer = setInterval(() => {
			if (!config || completed) {
				clearInterval(failFastTimer);
				failFastTimer = undefined;
				return;
			}
			checkAndApplyFailFast(ctx);
		}, 500);
		failFastTimer.unref?.();
	};

	const writeProgress = () => {
		if (!config) return;
		try {
			atomicJson(join(config.session_dir, `${config.instance_id}.progress.json`), {
				token: config.token,
				...(config.review_plan ? { attempt_id: config.attempt_id } : {}),
				updated_at: Date.now(),
				state: completed ? "completed" : started ? "working" : "waiting",
				...(activityAt !== undefined ? { activity_at: activityAt } : {}),
				...(startedAt !== undefined ? { started_at: startedAt } : {}),
				...(!completed && waitingForHumanSince !== undefined ? { waiting_for_human_since: waitingForHumanSince } : {}),
			});
		}
		catch { /* cleanup may have removed session files */ }
	};

	const heartbeat = () => {
		try { refreshParkedDelivery(); } catch { /* cleanup may have removed session files */ }
		writeProgress();
	};

	const finishBlockedRevision = (next: WorkerConfig) => {
		config = next;
		startedAt = activityAt = undefined;
		heartbeat();
		stopTimers();
	};

	const startWorkerTimers = (ctx: { abort: () => void; shutdown: () => void }) => {
		if (!config) return;
		const inboundSources = inboundEdgesOf(config);
		const follower = inboundSources.length === 1;
		if (!completed && inboundSources.length < 2 && !tryAdmitOwnership(true, follower)) {
			ownershipTimer = setInterval(() => {
				if (!config || completed || started) {
					if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
					return;
				}
				const cancel = readCancellation();
				if (cancel.error) { failClosedCancelError(cancel.error, ctx); return; }
				if (cancel.cancelled) {
					recordCancelled(cancel.reason ?? "Run or node cancelled", ctx);
					if (!cancelAborted) { cancelAborted = true; ctx.abort(); }
					return;
				}
				if (checkAndApplyFailFast(ctx)) return;
				try {
					if (tryAdmitOwnership(false, follower)) {
						if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
						sendOwnershipAdmission();
					}
				} catch (error) {
					if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
					recordFailure(errorMessage(error));
					ctx.shutdown();
				}
			}, 500);
			ownershipTimer.unref?.();
		}
		startFailFastTimer(ctx);
		heartbeat();
		heartbeatTimer = setInterval(heartbeat, 5000); heartbeatTimer.unref?.();
		const checkTaskDeadline = (ctxRef: { abort: () => void; shutdown: () => void }) => {
			if (!config || completed || waitingForHumanSince !== undefined || config.task_timeout_ms === undefined || startedAt === undefined) return;
			if (Date.now() - startedAt < config.task_timeout_ms) return;
			if (existsSync(resultPath(config.session_dir, activeKey(config)))) return;
			const reason = `Task duration deadline exceeded (${config.task_timeout_ms}ms)`;
			const nowIso = new Date().toISOString();
			let won = false;
			try {
				won = claimOutcome(config.session_dir, cancelIdentity(config), "cancelled", nowIso, activeKey(config)).won;
			} catch (error) {
				failClosedCancelError(`unusable outcome claim: ${errorMessage(error)}`, ctxRef);
				return;
			}
			if (!won) return;
			writeCancelRecord(config.session_dir, {
				identity: { ...cancelIdentity(config), ...(config.review_plan ? { attempt_id: undefined } : {}) },
				scope: "node",
				reason,
				requestedAt: nowIso,
				graceMs: config.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS,
			});
			if (!cancelAborted) { cancelAborted = true; ctxRef.abort(); }
		};
		cancelTimer = setInterval(() => {
			if (!config) return;
			if (completed) {
				const loop = ownLoop(config);
				if (!loop || !delivered || completing || holdForAttention) return;
				try {
					let finalization = readFinalization(config.session_dir, config.task_id, loop, config.instance_id);
					if (!finalization) {
						const attempt = attemptNumber(config.attempt_id) + 1;
						if (revisionReserved(config.session_dir, config.task_id, loop, attempt)) {
							const next = { ...config, attempt_id: attemptKey(config.review_plan, config.instance_id, attempt) };
							const cancel = readCancellation(next);
							if (cancel.error) { failClosedCancelError(cancel.error, ctx, next); return; }
							if (cancel.cancelled) {
								recordCancelled(cancel.reason ?? "Run or node cancelled", ctx, false, next);
								return;
							}
							if (checkAndApplyFailFast(ctx, next)) return;
							if (loop.reviewer === config.instance_id) {
								// A writer may have exited after recording the blocked attempt and before finalizing it.
								settleReviewDisposition(next, dispositionPath(config.session_dir, activeKey(next)));
								finalization = readFinalization(config.session_dir, config.task_id, loop, config.instance_id);
							}
						}
					}
					if (finalization) {
						if (config.attempt_id !== finalization.attempt_id) {
							config = { ...config, attempt_id: finalization.attempt_id };
							startedAt = activityAt = undefined;
							heartbeat();
						}
						if (ownershipAdmitted) persistOwnership("released");
						stopTimers();
					}
				} catch (error) {
					recordFailure(errorMessage(error));
					stopTimers();
				}
				return;
			}
			checkTaskDeadline(ctx);
			const cancel = readCancellation();
			if (cancel.error) { failClosedCancelError(cancel.error, ctx); return; }
			if (cancel.cancelled) {
				if (!started) recordCancelled(cancel.reason ?? "Run or node cancelled", ctx);
				if (!cancelAborted) { cancelAborted = true; ctx.abort(); }
			}
		}, 1000);
		cancelTimer.unref?.();
		if (inboundSources.length > 0 && !completed) {
			// Count inactivity, not total fleet runtime: later steps may wait for long chains.
			const waitingSince = Date.now();
			const dependencyWaitMs = config.dependency_wait_timeout_ms ?? DEFAULT_DEPENDENCY_WAIT_MS;
			const progressTimestamp = (p: ProgressSnapshot): number => {
				// Never equate heartbeat (`updated_at`) with useful progress when `activity_at` or `started_at` is tracked.
				if (Number.isFinite(p.activity_at)) return p.activity_at!;
				if (Number.isFinite(p.started_at)) return p.started_at!;
				return p.updated_at;
			};
			const sourceLoop = reviewLoopFor(config.review_plan, config.predecessor ?? "");
			const awaitedLoop = sourceLoop !== ownLoop(config) ? sourceLoop : undefined;
			const predecessors = config.topology === "graph" ? graphPredecessors(config) : undefined;
			const upstreamInstances = predecessors ? graphAncestors(predecessors, inboundSources) : (awaitedLoop?.members ?? inboundSources);
			const sourcePaths = new Map(inboundSources.map(src => [src, predecessors ? graphAncestors(predecessors, [src]) : upstreamInstances]));
			const processState = (id: string): "alive" | "exited" | "unknown" => {
				try {
					const cfg = config!;
					const ready = parseWorkerReady(readJson<unknown>(readyPath(cfg.session_dir, id)));
					if (ready.task_id === cfg.task_id && ready.token === cfg.token && ready.instance_id === id) return processAlive(ready) ? "alive" : "exited";
				} catch { /* unreadable readiness is not proof of life */ }
				return "unknown";
			};
			const humanWait = (id: string, p: ProgressSnapshot | undefined): "live" | "lost" | undefined => {
				if (!p || p.token !== config!.token || humanWaitStartedAt(p) === undefined) return undefined;
				return Date.now() - p.updated_at <= HEARTBEAT_STALE_MS && processState(id) === "alive" ? "live" : "lost";
			};
			type UpstreamProgress = { snapshot?: ProgressSnapshot; activity?: number; settled?: boolean };
			const readUpstreamProgress = (): Map<string, UpstreamProgress> => {
				const progress = new Map<string, UpstreamProgress>();
				for (const id of upstreamInstances) {
					const node: UpstreamProgress = {};
					progress.set(id, node);
					const bump = (ts: number) => { if (Number.isFinite(ts) && (node.activity === undefined || ts > node.activity)) node.activity = ts; };
					const cfg = config!;
					const member = cfg.roster?.find(m => m.instance_id === id);
					const predId = (member ? inboundEdgesOf(member)[0] : undefined) ?? predecessors?.get(id)?.[0]
						?? (member ? cfg.roster?.[cfg.roster.indexOf(member) - 1]?.instance_id : undefined);
					const current = cfg.review_plan && member ? latestReviewAttempt({
						dir: cfg.session_dir, runId: cfg.task_id, plan: cfg.review_plan,
						instance: id, node: member.node_id, predecessor: predId,
					}) : undefined;
					const key = attemptKey(cfg.review_plan, id, current?.number);
					const expected = { ...sourceExpectation(cfg, id), ...(cfg.review_plan ? { attempt_id: key } : {}) };
					try {
						const p = readJson<ProgressSnapshot>(join(cfg.session_dir, `${id}.progress.json`));
						if (p.token === cfg.token && (!cfg.review_plan || p.attempt_id === key)) {
							node.snapshot = p;
							if (p.state === "working") bump(progressTimestamp(p));
						}
					} catch { /* no progress yet */ }
					try {
						const res = resultPath(cfg.session_dir, key);
						if (existsSync(res)) {
							bump(Date.parse(parseCompletion(readJson<unknown>(res), expected).completed_at));
							node.settled = true;
						}
					} catch { /* ignore */ }
					try {
						const disp = dispositionPath(cfg.session_dir, key);
						if (existsSync(disp)) {
							bump(Date.parse(parseDisposition(readJson<unknown>(disp), expected).recorded_at));
							node.settled = true;
						}
					} catch { /* ignore */ }
				}
				return progress;
			};
			const latestProgress = (nodes: Map<string, UpstreamProgress>, ids: Iterable<string>) =>
				Math.max(waitingSince, ...Array.from(ids, id => nodes.get(id)?.activity ?? waitingSince));
			const hasHumanWait = (nodes: Map<string, UpstreamProgress>) => Array.from(nodes.values()).some(({ snapshot, settled }) =>
				!settled && snapshot && humanWaitStartedAt(snapshot) !== undefined);
			// Follow only unresolved dependency paths. A working/completed intermediate
			// node is no longer waiting on its own prerequisites.
			const upstreamHumanWait = (source: string, nodes: Map<string, UpstreamProgress>) => {
				const visit = new Set([source]);
				let lost = false;
				for (const id of visit) {
					const node = nodes.get(id);
					if (node?.settled) continue;
					const p = node?.snapshot;
					const wait = humanWait(id, p);
					if (wait === "live") return "live";
					if (wait === "lost") lost = true;
					if (p?.state === "working" || p?.state === "completed" || processState(id) === "exited") continue;
					for (const parent of predecessors?.get(id) ?? []) visit.add(parent);
				}
				return lost ? "lost" : undefined;
			};
			const workingChainPredecessor = (instanceId: string, progress: ProgressSnapshot | undefined) => {
				if (!progress || progress.token !== config!.token) return undefined;
				if (progress.state === "working") return { id: instanceId, progress };
				// If predecessor is itself waiting in a chain, look for useful activity upstream in the roster.
				if (progress.state === "waiting" && config!.roster?.length) {
					const idx = config!.roster.findIndex(m => m.instance_id === instanceId);
					for (let j = idx - 1; j >= 0; j--) {
						try {
							const id = config!.roster[j].instance_id;
							const up = readJson<ProgressSnapshot>(join(config!.session_dir, `${id}.progress.json`));
							if (up.token === config!.token && up.state === "working") return { id, progress: up };
						} catch { /* try earlier */ }
					}
				}
				return undefined;
			};
			const handoffOwnershipWait = (cfg: WorkerConfig) => {
				const path = ownershipPath(cfg.session_dir, cfg.instance_id);
				if (cfg.version === 1 || !existsSync(path)) return;
				const record = parseOwnershipRecord(readJson<unknown>(path), ownershipExpectation(cfg));
				if (record.state === "waiting") return record;
			};
			const offerPath = (cfg: WorkerConfig, src: string) =>
				handoffOfferPath(cfg.session_dir, activeKey(cfg), handoffSourceScope(cfg, src));
			const pollHandoffOwnership = (cfg: WorkerConfig, missing: string[], ownershipWaitSince: string): boolean => {
				const problems: CauseRef[] = [];
				let wake: { customType: string; display: boolean; details: { sender_session: string }; content: string } | undefined;
				for (const src of inboundSources) {
					if (missing.includes(src)) continue;
					const node = sourceNode(cfg, src);
					try {
						const path = resultPath(cfg.session_dir, sourceKey(cfg, src));
						parseCompletion(readJson<unknown>(path), sourceExpectation(cfg, src));
						const offer = cfg.handoff_protocol ? parseHandoffOffer(readJson<unknown>(offerPath(cfg, src))) : undefined;
						const ready = parseWorkerReady(readJson<unknown>(readyPath(cfg.session_dir, src)));
						if (ready.task_id !== cfg.task_id || ready.token !== cfg.token || ready.instance_id !== src) {
							throw new Error("readiness identity mismatch");
						}
						wake ??= {
							customType: "coms-inbound", display: true, details: { sender_session: ready.session_id },
							content: handoffNotification({ ...cfg, instance_id: src }, offer, path, false),
						};
					} catch (error) {
						problems.push({ node_id: node, state: "needs_attention", reason: `Handoff rejected from ${node}: ${errorMessage(error)}` });
					}
				}
				if (problems.length) {
					endWithoutExecuting("needs_attention", problems.map(cause => cause.reason).join("; "), problems, "Handoff validation failed");
					ctx.shutdown();
					return true;
				}
				if (missing.length) return false;
				const ownership = ownershipDependencies(cfg);
				if (!ownership.admitted) {
					const recordedWait = Date.parse(ownershipWaitSince);
					const stalled = ownership.waiting_on.filter(holder => {
						if (holder.status === "uncertain") return true;
						const loop = reviewLoopFor(cfg.review_plan, holder.instance_id);
						const latest = latestProgress(loop?.members ?? [holder.instance_id]);
						const lastActivity = latest ?? (Number.isFinite(recordedWait) ? recordedWait : waitingSince);
						return Date.now() - lastActivity > dependencyWaitMs;
					});
					if (stalled.length) {
						const reason = `Timed out waiting for write ownership held by ${stalled.map(holder => holder.node_id).join(", ")}`;
						const causes = stalled.map((holder): CauseRef => ({
							node_id: holder.node_id, state: holder.status === "uncertain" ? "needs_attention" : "running",
							reason: holder.status === "uncertain" ? holder.reason : `${holder.reason}; no useful progress for ${dependencyWaitMs}ms`,
						}));
						endWithoutExecuting("needs_attention", [reason, ...causes.map(cause => `${cause.node_id}: ${cause.reason}`)].join("; "), causes, "Ownership wait failed");
						ctx.shutdown();
					}
					return true;
				}
				// A follow-up can still be queued when the next dependency poll runs.
				if (queuedHandoffWake === "queued") {
					queuedHandoffWake = "grace_elapsed";
					return true;
				}
				if (queuedHandoffWake || !wake || typeof pi.sendMessage !== "function") return false;
				queuedHandoffWake = "queued";
				pi.sendMessage(wake, { deliverAs: "followUp", triggerTurn: true });
				return true;
			};
			predecessorTimer = setInterval(() => {
				if (!config || completed || started) return;
				const ownDisposition = dispositionPath(config.session_dir, activeKey(config));
				if (config.version !== 1 && existsSync(ownDisposition)) {
					settleReviewDisposition(config, ownDisposition);
					releaseOwnershipForDisposition(ownDisposition);
					completed = true;
					holdForAttention = true;
					stopTimers();
					ctx.shutdown();
					return;
				}
				const cancel = readCancellation();
				if (cancel.error) { failClosedCancelError(cancel.error, ctx); return; }
				if (cancel.cancelled) {
					recordCancelled(cancel.reason ?? "Run or node cancelled", ctx);
					if (!cancelAborted) { cancelAborted = true; ctx.abort(); }
					return;
				}
				if (inboundSources.length > 1) {
					let timeout: { reason: string; causes: CauseRef[] };
					try {
						const joinDecision = evaluateJoinAdmission(config, inboundSources);
						if (joinDecision.outcome === "blocked") {
							endWithoutExecuting("blocked", joinDecision.reason, joinDecision.causes, "Join dependency failed");
							ctx.shutdown();
							return;
						}
						const cfg = config;
						const withoutOffers = cfg.handoff_protocol ? inboundSources.filter(src => !existsSync(offerPath(cfg, src))) : [];
						// This record is written only after validating the handoff and finding a path conflict.
						const ownershipWait = handoffOwnershipWait(cfg);
						if (ownershipWait && joinDecision.outcome === "admit" && pollHandoffOwnership(cfg, withoutOffers, ownershipWait.updated_at)) return;
						const upstream = readUpstreamProgress();
						const expired = (ids: Iterable<string>) => Date.now() - latestProgress(upstream, ids) > dependencyWaitMs;
						const unresolved = new Set([
							...(joinDecision.outcome === "wait" ? joinDecision.pendingSources : []),
							...withoutOffers,
						]);
						const unheard = inboundSources.filter(src => !joinWakeSources.has(src));
						let sources = unresolved.size ? [...unresolved] : unheard.length ? unheard : inboundSources;
						const waits = hasHumanWait(upstream) ? sources.map(src => upstreamHumanWait(src, upstream)) : [];
						if (waits.some(Boolean)) {
							// A human wait excuses only its own inbound path. Ordinary useful
							// progress elsewhere must not hide a lost or stalled sibling here.
							sources = sources.filter((src, i) => waits[i] !== "live" && expired(sourcePaths.get(src)!));
							if (!sources.length) return;
						} else if (!expired(upstreamInstances)) return;
						const names = sources.map(src => sourceNode(cfg, src));
						const reason = `No upstream progress or handoff from ${names.join(", ")} for ${dependencyWaitMs}ms`;
						const causes = sources.map((src, index): CauseRef => {
							const state = executionOf(sourceRecord(cfg, src))?.state;
							if (state === "succeeded" || state === "partial") {
								const detail = withoutOffers.includes(src)
									? (ownershipWait ? "its previously validated handoff offer is missing" : "its handoff never arrived")
									: "its handoff offer is on record but no notification admitted the join";
								return { node_id: names[index], state: "needs_attention", reason: `${names[index]} finished (${state}) but ${detail}` };
							}
							return { node_id: names[index], state: state && state !== "pending" ? state : "needs_attention", reason: processState(src) === "exited" ? `${names[index]} process exited without recording an outcome` : reason };
						});
						const missing = causes.filter(cause => cause.reason !== reason).map(cause => cause.reason);
						timeout = { reason: [reason, ...missing].join("; "), causes };
					} catch (error) {
						timeout = { reason: errorMessage(error), causes: [] };
					}
					endWithoutExecuting("needs_attention", timeout.reason, timeout.causes, "Join dependency failed");
					ctx.shutdown();
					return;
				}
				let record: ReturnType<typeof predecessorRecord> = {};
				try {
					const finalization = awaitedLoop && readFinalization(config.session_dir, config.task_id, awaitedLoop, config.predecessor!);
					const incoming = finalization ? { ...config, predecessor_attempt: attemptNumber(finalization.attempt_id) } : config;
					if (!awaitedLoop || finalization) record = predecessorRecord(incoming);
					const execution = executionOf(record);
					// A predecessor that never executed sends no handoff; one whose handoff was not delivered cannot send it. Either settles this node now.
					if (config.version === 1) {
						if (record.completion?.result.status === "failure" && record.completion.delivery !== "sent") throw new Error(`Upstream failure: ${record.completion.result.summary}`);
					} else {
						const closedEdge = awaitedLoop && blockedReviewForwardEdge(awaitedLoop, finalization, predecessorNode(config), execution, record.completion?.result);
						const decision = closedEdge ?? (execution && (record.disposition || record.completion!.delivery !== "sent") ? admission(config, record) : undefined);
						if (decision && !decision.admit && decision.outcome === "blocked") { endWithoutExecuting("blocked", decision.reason, decision.causes, "Chain dependency failed"); ctx.shutdown(); return; }
					}
					const ownershipWait = record.completion && handoffOwnershipWait(incoming);
					const missingOffer = ownershipWait && incoming.handoff_protocol &&
						!existsSync(offerPath(incoming, incoming.predecessor!));
					if (ownershipWait && pollHandoffOwnership(incoming, missingOffer ? [incoming.predecessor!] : [], ownershipWait.updated_at)) return;
					const progressPath = join(config.session_dir, `${config.predecessor}.progress.json`);
					const progress = existsSync(progressPath) ? readJson<ProgressSnapshot>(progressPath) : undefined;
					const upstream = predecessors || awaitedLoop ? readUpstreamProgress() : undefined;
					const chainPredecessor = predecessors || execution ? undefined : workingChainPredecessor(config.predecessor!, progress);
					if (!execution) {
						if (predecessors && upstream && hasHumanWait(upstream) && upstreamHumanWait(config.predecessor!, upstream) === "live") return;
						if (chainPredecessor && humanWait(chainPredecessor.id, chainPredecessor.progress) === "live" && processState(config.predecessor!) !== "exited") return;
					}
					const lastActivity = upstream ? latestProgress(upstream, upstreamInstances)
						: record.completion ? Date.parse(record.completion.completed_at)
						: record.disposition ? Date.parse(record.disposition.recorded_at)
						: chainPredecessor ? progressTimestamp(chainPredecessor.progress) : waitingSince;
					if (Date.now() - lastActivity <= dependencyWaitMs) return;
					if (ownershipWait) {
						throw new Error(`${predecessorNode(config)} finished but ${missingOffer
							? "its previously validated handoff offer is missing"
							: "its handoff offer is on record but no notification admitted the node"}`);
					}
					if (progress?.token === config.token && progress.state === "working" && Number.isFinite(progress.activity_at)) {
						const hbAge = Math.max(0, Date.now() - progress.updated_at);
						const process = processState(config.predecessor!);
						const detail = process === "exited" ? "process exited" : hbAge > HEARTBEAT_STALE_MS ? "heartbeat stale" : process === "alive" ? "live but stalled" : "liveness unknown";
						throw new Error(`No useful progress or handoff from ${config.predecessor} for ${dependencyWaitMs}ms (last heartbeat ${hbAge}ms ago — ${detail})`);
					}
					throw new Error(`No predecessor progress or handoff from ${config.predecessor} for ${dependencyWaitMs}ms`);
				} catch (error) {
					// Without a handoff the predecessor's outcome is unresolved. That is this node's attention condition, not a failure it executed.
					const state = executionOf(record)?.state;
					endWithoutExecuting("needs_attention", errorMessage(error), [{ node_id: predecessorNode(config), state: state && state !== "pending" ? state : "needs_attention", reason: errorMessage(error) }], "Chain dependency failed");
					ctx.shutdown();
				}
			}, 1000);
			predecessorTimer.unref?.();
		}
	};

	const requireManagedTaskInput = (cfg: WorkerConfig): TaskInputRecord => {
		const inputKey = attemptKey(cfg.review_plan, cfg.instance_id);
		const inputFile = taskInputPath(cfg.session_dir, inputKey);
		assertNoSymlinkPath(inputFile);
		if (!existsSync(inputFile)) {
			throw new Error(`Missing immutable factory task input: ${inputFile}`);
		}
		if (!lstatSync(inputFile).isFile()) {
			throw new Error(`Immutable factory task input must be a regular file: ${inputFile}`);
		}
		const expectedAttemptId = cfg.review_plan ? inputKey : cfg.attempt_id;
		if (!expectedAttemptId) {
			throw new Error("Missing attempt_id for factory-managed worker");
		}
		const parsed = parseTaskInput(readRegularJsonNoSymlink<unknown>(inputFile, "immutable factory task input"), {
			...ownExpectation(cfg),
			attempt_id: expectedAttemptId,
		});
		if (!authoritativeBrief || authoritativeBrief.taskId !== cfg.task_id) {
			throw new Error("Missing authoritative accepted brief from factory release proof");
		}
		const submitted = parsed.brief.submitted_brief;
		if (typeof submitted !== "string" || submitted.length === 0) {
			throw new Error("Immutable factory task input is missing submitted_brief");
		}
		if (sha256Text(submitted) !== authoritativeBrief.digest || submitted !== authoritativeBrief.text) {
			throw new Error("Immutable factory task input submitted_brief does not match authoritative accepted brief");
		}
		if (cfg.submitted_brief !== undefined && cfg.submitted_brief !== authoritativeBrief.text) {
			throw new Error("Worker config submitted_brief does not match authoritative accepted brief");
		}
		return parsed;
	};

	const failStartup = (error: unknown, ctx: ExtensionContext) => {
		released = false;
		authoritativeBrief = undefined;
		const message = errorMessage(error);
		recordFailure(message);
		ctx.ui.notify(`Bootstrap initialization failed: ${message}`, "error");
		ctx.shutdown();
	};

	const finishStartup = async (ready: WorkerReady, ctx: ExtensionContext) => {
		if (!config) return;
		atomicJson(readyPath(config.session_dir, config.instance_id), ready);
		if (ready.unmatched_skills?.length) throw new Error(unknownAllowedSkills(config.persona_name, ready.unmatched_skills));
		initialized = true;
		activeCtx = ctx;
		const deadline = Date.now() + config.ready_timeout_ms;
		while (!released) {
			const preCancel = readCancellation();
			if (preCancel.error) {
				failClosedCancelError(preCancel.error, ctx);
				return;
			}
			if (preCancel.cancelled) {
				recordCancelled(preCancel.reason ?? "Cancelled before release", ctx);
				return;
			}
			if (existsSync(join(config.session_dir, "abort.json"))) throw new Error("Dispatcher aborted the bootstrap run");
			const releasePath = join(config.session_dir, "release.json");
			const managed = isManagedWorker(config);
			if (managed ? pathEntryExists(releasePath) : existsSync(releasePath)) {
				if (managed) {
					authoritativeBrief = verifyFactoryReleaseAuthority(config);
					requireManagedTaskInput(config);
				} else {
					const release = readJson<{ task_id: string; token: string; factory_managed?: unknown }>(releasePath);
					if (release.task_id !== config.task_id || release.token !== config.token) throw new Error("Invalid bootstrap release token");
					if (release.factory_managed !== undefined) {
						throw new Error("Contradictory release marker: factory_managed metadata on standalone run");
					}
					authoritativeBrief = undefined;
				}
				released = true;
				break;
			}
			if (Date.now() >= deadline) throw new Error("Dispatcher did not release the bootstrap readiness barrier");
			await delay(100);
		}
		// After a reload, durable state decides what this instance may still do; never redo finished work.
		if (config.review_plan) {
			const latest = latestReviewAttempt({
				dir: config.session_dir, runId: config.task_id, plan: config.review_plan,
				instance: config.instance_id, node: config.node_id, predecessor: config.predecessor,
			});
			if (latest.number > 1) config = {
				...config, attempt_id: attemptKey(config.review_plan, config.instance_id, latest.number),
				predecessor: latest.source, predecessor_attempt: latest.sourceAttempt,
			};
		}
		const priorPath = resultPath(config.session_dir, activeKey(config));
		if (existsSync(priorPath)) {
			const prior = parseCompletion(readJson<unknown>(priorPath), ownExpectation(config));
			completed = true; started = true;
			delivered = deliverySettled(config, prior);
			if (ownLoop(config)) {
				if (config.write_paths?.length && existsSync(ownershipPath(config.session_dir, config.instance_id))) {
					tryAdmitOwnership(false);
				}
				if (delivered) park();
				else admitted = true;
			}
		} else if (existsSync(dispositionPath(config.session_dir, activeKey(config))) || (config.review_plan && existsSync(errorFile()))) {
			settleReviewDisposition(config, dispositionPath(config.session_dir, activeKey(config)));
			// A node that already ended without executing must never start timers, admit work, or overwrite its disposition on restart.
			completed = true; holdForAttention = true;
		} else {
			const postReleaseCancel = readCancellation();
			if (postReleaseCancel.error) { failClosedCancelError(postReleaseCancel.error, ctx); return; }
			if (postReleaseCancel.cancelled) { recordCancelled(postReleaseCancel.reason ?? "Run or node cancelled", ctx); return; }
		}
		const inboundRestart = inboundEdgesOf(config);
		const isJoinRestart = inboundRestart.length > 1 && attemptNumber(config.attempt_id) === 1;
		if (!completed && isJoinRestart && existsSync(handoffClaimPath(config.session_dir, activeKey(config)))) {
			const claim = parseJoinHandoffClaim(readJson<unknown>(handoffClaimPath(config.session_dir, activeKey(config))));
			const reason = `join handoffs (${claim.handoff_ids.join(", ")}) were accepted but no result was recorded before this worker restarted; the task is not replayed automatically and its effects are unknown`;
			endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], "Worker restarted after accepting its task");
		} else if (!completed && !isJoinRestart && inboundRestart.length >= 1 && existsSync(handoffClaimPath(config.session_dir, activeKey(config), handoffSourceScope(config)))) {
			// The handoff was accepted by an earlier incarnation of this worker, which never saved a result. Whatever it did cannot be known, so the
			// task is not replayed and the claim is not reset: the node needs attention until an operator decides.
			const claim = parseHandoffClaim(readJson<unknown>(handoffClaimPath(config.session_dir, activeKey(config), handoffSourceScope(config))));
			const reason = `handoff ${isLegacyClaim(claim) ? "from " + claim.predecessor : claim.handoff_id} was accepted but no result was recorded before this worker restarted; the task is not replayed automatically and its effects are unknown`;
			endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], "Worker restarted after accepting its task");
		}
		if (!completed && checkAndApplyFailFast(ctx)) return;
		startWorkerTimers(ctx);
	};

	pi.on("session_start", async (event, ctx) => {
		const configPath = pi.getFlag("bootstrap-worker-config");
		if (typeof configPath !== "string" || !configPath) return;
		const reason = (event as { reason?: string } | undefined)?.reason;
		// The user replaced this pane's session; the old one already recorded why the bootstrap work stopped.
		if (reason === "new" || reason === "resume" || reason === "fork") {
			// Pi normally builds a fresh runtime for these, so this state is already empty. If a runtime is
			// ever reused, drop every trace of the old run so no hook injects its persona or task again.
			detached = true; stopTimers(); pendingChecks.clear(); parkedTools = undefined; completionReminderAttempt = undefined;
			if (originalTools) { try { pi.setActiveTools(originalTools); } catch { /* best effort */ } }
			config = undefined; authoritativeBrief = undefined; originalTools = undefined; allowedSkillNames = undefined; activityAt = undefined; startedAt = undefined; cancelAborted = false;
			released = initialized = completing = completionRequested = completed = holdForAttention = delivered = started = admitted = ownershipAdmitted = startupSeen = failureRecorded = false;
			return;
		}
		try {
			const rawConfig = readJson<{ instance_id?: unknown; session_dir?: unknown }>(configPath);
			try { config = parseWorkerConfig(rawConfig); }
			catch (error) {
			// Nothing identifies this worker for certain, but when the file names its own instance the dispatcher should still hear why it never became ready.
			if (typeof rawConfig?.instance_id === "string" && typeof rawConfig.session_dir === "string" && /^a\d+-[a-z0-9-]+$/.test(rawConfig.instance_id)) {
			try { atomicJson(join(rawConfig.session_dir, `${rawConfig.instance_id}.error.json`), { error: errorMessage(error) }); failureRecorded = true; } catch { /* session files unavailable */ }
			}
			throw error;
			}
			if (!config.task_id || !config.token || !/^a\d+-[a-z0-9-]+$/.test(config.instance_id)) throw new Error("Invalid bootstrap child configuration");
			// The flag outlives /new, /resume and /fork: a reload of the replacement session is still not this run's worker.
			try {
				if (readJson<{ token?: string }>(detachedFile(config)).token === config.token) { detached = true; config = undefined; return; }
			} catch { /* never replaced */ }
			const active = pi.getActiveTools();
			const registered = new Set(pi.getAllTools().map(tool => tool.name));
			for (const tool of ["coms_send", ...config.tools]) {
				if (!registered.has(tool)) throw new Error(`Required tool is unavailable: ${tool}`);
			}
			// Startup hooks run in extension order; Coms is loaded before this extension.
			const registryPath = join(config.coms_dir, "projects", config.coms_project, "agents", `${config.instance_id}.json`);
			if (!existsSync(registryPath)) throw new Error("Coms did not register the expected child identity");
			const registry = readJson<{ pid: number; name: string; session_id: string; endpoint: string; model: string }>(registryPath);
			if (registry.pid !== process.pid || registry.name !== config.instance_id || !registry.session_id || !registry.endpoint) throw new Error("Coms registry identity mismatch");
			if (!ctx.model) throw new Error("No model was resolved for the child");
			if (config.expected_model && !modelMatches(config.expected_model, `${ctx.model.provider}/${ctx.model.id}`)) throw new Error("Child model does not match the launch plan");
			originalTools = [...active];
			const tools = config.tools.length ? config.tools : active.filter(tool => !tool.startsWith("bootstrap_"));
			pi.setActiveTools([...new Set([...tools.filter(tool => !tool.startsWith("bootstrap_")), "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify", ...(config.intervention && config.factory_managed ? ["bootstrap_request_direction"] : []), ...active.filter(tool => tool.startsWith("coms_"))])]);
			const ready: WorkerReady = {
				version: 1, task_id: config.task_id, token: config.token, instance_id: config.instance_id,
				pid: process.pid, name: registry.name, session_id: registry.session_id, endpoint: registry.endpoint,
				model: `${ctx.model.provider}/${ctx.model.id}`, start_time: processStartTime(process.pid),
			};
			const flag = pi.getFlag("allowed-skills");
			const allowed = typeof flag === "string" ? new Set(flag.split(",").filter(name => name !== "none")) : undefined;
			allowedSkillNames = allowed;
			if (allowed && reason !== "reload") {
				// Pi completes resource discovery after session_start. Its startup command sees the structured skills.
				pi.registerCommand(BOOTSTRAP_LAUNCH_COMMAND, {
					description: "Acknowledge bootstrap startup after discovering resources",
					handler: async (message, launchCtx) => {
						if (!config || message !== config.startup_message || detached || initialized || failureRecorded) return;
						try {
							const skills = launchCtx.getSystemPromptOptions().skills ?? [];
							ready.kept_skills = skills.filter(skill => allowed.has(skill.name)).map(skill => skill.name);
							const kept = new Set(ready.kept_skills);
							ready.unmatched_skills = [...allowed].filter(name => !kept.has(name));
							await finishStartup(ready, launchCtx);
						} catch (error) { failStartup(error, launchCtx); }
					},
				});
				return;
			}
			// Reload preserves the report from the original launch without replaying its startup command.
			if (allowed && existsSync(readyPath(config.session_dir, config.instance_id))) {
				const prior = parseWorkerReady(readJson<unknown>(readyPath(config.session_dir, config.instance_id)));
				if (prior.task_id !== config.task_id || prior.token !== config.token || prior.instance_id !== config.instance_id) {
					throw new Error("Previous readiness identity mismatch");
				}
				ready.kept_skills = prior.kept_skills;
				ready.unmatched_skills = prior.unmatched_skills;
			}
			await finishStartup(ready, ctx);
		} catch (error) { failStartup(error, ctx); }
	});

	pi.on("input", async (event, ctx) => {
		if (!config) return;
		if (!initialized || !released) return { action: "handled" as const };
		if (event.text !== config.startup_message) return;
		if (completed || holdForAttention || checkAndApplyFailFast(ctx)) return { action: "handled" as const };
		startupSeen = true;
		// The explicit startup message is intercepted for followers; an inbound Coms prompt activates them.
		if (config.predecessor) return { action: "handled" as const };
		if (isManagedWorker(config)) {
			try {
				if (!started) {
					authoritativeBrief = verifyFactoryReleaseAuthority(config);
				}
				requireManagedTaskInput(config);
			} catch (error) {
				recordFailure(`Task input validation failed: ${errorMessage(error)}`);
				ctx.shutdown();
				return { action: "handled" as const };
			}
		}
		if (!tryAdmitOwnership()) {
			persistOwnership("waiting");
			return { action: "handled" as const };
		}
		return { action: "transform" as const, text: taskPrompt(config) };
	});

	// Let Pi rebuild its default prompt with restored tools and filtered skills before the next hook adds the persona.
	pi.on("before_agent_start", async event => {
		if (!config || !released) return;
		const handoffWake = event.messageType === "custom" && event.message?.customType === "coms-inbound";
		if (ownLoop(config) && completed && handoffWake && !delivered) {
			if (completionSettled) await completionSettled;
			if (!config || !released) return;
			try { refreshParkedDelivery(); } catch { /* handled by admission hook */ }
		}
		const options = event.systemPromptOptions;
		if (!options) return;
		if (ownLoop(config) && delivered && !holdForAttention && handoffWake && parkedTools) {
			options.selectedTools = [...parkedTools];
		}
		const allowed = allowedSkillNames;
		if (allowed) {
			options.skills = options.skills?.filter(skill => allowed.has(skill.name));
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
		if (!config || !released) { if (pi.getFlag("bootstrap-worker-config") && !detached) ctx.abort(); return; }
		// A notification that is refused or replayed must not take away the tools of work that was already accepted.
		const handoffWake = event.messageType === "custom" && event.message?.customType === "coms-inbound";
		if (ownLoop(config) && completed && handoffWake && !delivered) {
			// Let an in-flight completion finish writing the previous attempt before advancing.
			if (completionSettled) await completionSettled;
			if (!config || !released) { ctx.abort(); return; }
			try { refreshParkedDelivery(); }
			catch (error) { failClosedCancelError(errorMessage(error), ctx); return; }
		}
		const wasAdmitted = admitted;
		admitted = false;
		const loop = ownLoop(config);
		const currentAttempt = attemptNumber(config.attempt_id);
		const revising = !!loop && delivered && !holdForAttention && handoffWake;
		let incoming = config;
		if (revising) {
			const feedback = config.instance_id === loop.target;
			incoming = {
				...config, attempt_id: attemptKey(config.review_plan, config.instance_id, currentAttempt + 1),
				predecessor: feedback ? loop.reviewer : config.predecessor,
				predecessor_attempt: feedback ? currentAttempt : currentAttempt + 1,
			};
			try {
				const finalization = readFinalization(config.session_dir, config.task_id, loop, config.instance_id);
				const blockedAttempt = finalization?.attempt_id === incoming.attempt_id &&
					existsSync(dispositionPath(incoming.session_dir, activeKey(incoming)));
				if (finalization && !blockedAttempt) {
					const inbound = event.messageType === "custom" ? event.message : undefined;
					if (inbound?.customType === "coms-inbound" && typeof inbound.content === "string" && inbound.content.includes("bootstrap-handoff:")) {
						try { recordHandoffRejection(incoming, { at: new Date().toISOString(), kind: "conflict", severity: "notification", reason: "node finalized" }); } catch { /* project storage unavailable */ }
					}
					admitted = wasAdmitted; ctx.abort(); return;
				}
				if (!revisionReserved(config.session_dir, config.task_id, loop, currentAttempt + 1)) { ctx.abort(); return; }
				const dead = blockedAttempt ? [] : deadLoopMembers(config.session_dir, loop, config.roster ?? [], config.instance_id);
				if (dead.length) {
					const inbound = event.messageType === "custom" ? event.message : undefined;
					if (inbound?.customType === "coms-inbound" && typeof inbound.content === "string" && inbound.content.includes("bootstrap-handoff:")) {
						try { recordHandoffRejection(incoming, { at: new Date().toISOString(), kind: "conflict", severity: "notification", reason: `Feedback edge is dead: parked agent ${dead.map(d => d.node_id).join(", ")} exited` }); } catch { /* project storage unavailable */ }
					}
					admitted = wasAdmitted; ctx.abort(); return;
				}
			} catch (error) { ctx.abort(); recordFailure(errorMessage(error), incoming); return; }
		} else if (delivered || holdForAttention) { ctx.abort(); return; }
		const incomingDisposition = dispositionPath(incoming.session_dir, activeKey(incoming));
		if (incoming.review_plan && existsSync(incomingDisposition)) {
			settleReviewDisposition(incoming, incomingDisposition);
			completed = true;
			holdForAttention = true;
			if (revising) finishBlockedRevision(incoming);
			ctx.abort();
			ctx.shutdown();
			return;
		}
		if (!completed || revising) {
			const cancel = readCancellation(incoming);
			if (cancel.error) {
				failClosedCancelError(cancel.error, ctx, incoming);
				return;
			}
			if (cancel.cancelled) {
				ctx.abort();
				recordCancelled(cancel.reason ?? "Run or node cancelled", ctx, false, incoming);
				return;
			}
		}
		if (checkAndApplyFailFast(ctx, incoming)) return;
		const inboundMsg = event.messageType === "custom" ? event.message : undefined;
		if (inboundMsg?.customType === "bootstrap-ownership-admit") {
			const details = inboundMsg.details as { token?: string; instance_id?: string } | undefined;
			if (details?.token !== config.token || details.instance_id !== config.instance_id) {
				admitted = wasAdmitted; ctx.abort(); return;
			}
		}
		if (inboundMsg?.customType === "coms-inbound" && collaborationModeOf(config) === "independent" && !revising && (!config.predecessor || completed)) {
			// Independent mode rejects unsolicited peer task activation while keeping user controls and internal handoffs.
			admitted = wasAdmitted; ctx.abort(); return;
		}
		let taskInput: TaskInputRecord | undefined;
		const managed = isManagedWorker(incoming);
		if (managed) {
			try {
				if (!started) {
					authoritativeBrief = verifyFactoryReleaseAuthority(incoming);
				}
				taskInput = requireManagedTaskInput(incoming);
			} catch (error) {
				ctx.abort();
				recordFailure(`Task input validation failed: ${errorMessage(error)}`, incoming);
				ctx.shutdown();
				return;
			}
		}
		const inboundEdges = inboundEdgesOf(config);
		if (!completed && !config.predecessor) {
			try {
				if (!tryAdmitOwnership()) { admitted = wasAdmitted; ctx.abort(); return; }
			} catch (error) {
				ctx.abort();
				recordFailure(`Ownership admission failed: ${errorMessage(error)}`);
				ctx.shutdown(); return;
			}
		}
		if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
		if (!managed) {
			const inputFile = taskInputPath(config.session_dir, attemptKey(config.review_plan, config.instance_id));
			if (existsSync(inputFile)) {
				try {
					taskInput = parseTaskInput(readJson<unknown>(inputFile), { ...ownExpectation(config), attempt_id: config.review_plan ? attemptKey(config.review_plan, config.instance_id) : config.attempt_id });
				} catch (error) {
					ctx.abort();
					recordFailure(`Task input validation failed: ${errorMessage(error)}`, incoming);
					ctx.shutdown(); return;
				}
			}
		}
		let upstreamIndex: UpstreamIndex | undefined;
		try {
			upstreamIndex = readUpstreamIndex(config.session_dir, config.task_id);
		} catch (error) {
			ctx.abort();
			recordFailure(`Upstream index validation failed: ${errorMessage(error)}`, incoming);
			ctx.shutdown(); return;
		}
		let predecessorResult: BootstrapResult | undefined;
		let predecessorPath: string | undefined;
		let predecessorResults: Array<{ instanceId: string; nodeId: string; result: BootstrapResult; path: string }> | undefined;
		let acceptedHandoff: { handoff_id?: string; input_digest: string } | undefined;
		let acceptedJoinHandoffs: string[] | undefined;
		if (inboundEdges.length > 1 && !completed) {
			try {
				const inbound = event.messageType === "custom" ? event.message : undefined;
				if (inbound?.customType !== "coms-inbound" || typeof inbound.content !== "string" || !inbound.content.includes("bootstrap-handoff:")) { admitted = wasAdmitted; ctx.abort(); return; }
				const details = inbound.details as { sender_session?: string } | undefined;
				const prefix = `bootstrap-handoff:${config.token}:`;
				const idx = inbound.content.indexOf(prefix);
				const sourceInstanceId = idx >= 0 ? inbound.content.slice(idx + prefix.length).split(/\s/)[0] : "";
				if (!inboundEdges.includes(sourceInstanceId)) {
					// Use the configured predecessor's diagnostics file. The source named in the message is untrusted.
					try {
						recordHandoffRejection(config, {
							at: new Date().toISOString(), kind: "run", severity: "notification",
							reason: idx < 0 ? "the notification is not for this run's handoff (token mismatch)"
								: `${JSON.stringify(sourceInstanceId)} is not an inbound edge of ${config.instance_id}`,
						});
					} catch { /* project storage unavailable */ }
					admitted = wasAdmitted; ctx.abort(); return;
				}
				const expected = readJson<WorkerReady>(readyPath(config.session_dir, sourceInstanceId));
				const sessionOf = (srcId: string): string | undefined => {
					try { return readJson<WorkerReady>(readyPath(config!.session_dir, srcId)).session_id; } catch { return undefined; }
				};
				const decision = evaluateJoinHandoff({
					config,
					inboundInstances: inboundEdges,
					sourceInstanceId,
					expectedSession: expected.session_id,
					senderSession: details?.sender_session,
					content: inbound.content,
					loadPredecessor: (srcId) => {
						const srcLoop = reviewLoopFor(config!.review_plan, srcId);
						let srcAttempt: number | undefined;
						if (srcLoop && srcLoop !== loop) {
							const finalization = readFinalization(config!.session_dir, config!.task_id, srcLoop, srcId);
							if (!finalization) return undefined;
							srcAttempt = attemptNumber(finalization.attempt_id);
						} else if (srcLoop) {
							srcAttempt = attemptNumber(incoming.attempt_id);
						}
						const p = resultPath(config!.session_dir, sourceKey(config!, srcId, srcAttempt));
						return existsSync(p) ? parseCompletion(readJson<unknown>(p), sourceExpectation(config!, srcId, srcAttempt)) : undefined;
					},
					sessionOf,
				});
				if (decision.outcome === "duplicate") {
					admitted = wasAdmitted; ctx.abort();
					ctx.ui.notify(`Duplicate join handoff notification ignored: ${decision.claim.handoff_ids.join(", ")} already accepted at ${decision.claim.accepted_at}`, "info");
					return;
				}
				if (decision.outcome === "reject") {
					try { recordHandoffRejection(config, decision.rejection, decision.sourceInstanceId); } catch { /* project storage unavailable */ }
					ctx.abort();
					if (decision.rejection.severity === "integrity") {
						admitted = false;
						const node = sourceNode(config, decision.sourceInstanceId);
						const reason = `Handoff rejected from ${node}: ${decision.rejection.reason}`;
						if (queuedHandoffWake) endWithoutExecuting("needs_attention", reason, [{ node_id: node, state: "needs_attention", reason }], "Handoff validation failed");
						else recordFailure(`Handoff rejected: ${decision.rejection.reason}`);
						ctx.shutdown();
					} else admitted = wasAdmitted;
					return;
				}
				joinWakeSources.add(sourceInstanceId);
				if (decision.outcome === "wait") {
					const joinState = evaluateJoinAdmission(config, inboundEdges);
					if (joinState.outcome === "blocked") {
						endWithoutExecuting("blocked", joinState.reason, joinState.causes, "Join aborted by upstream failure");
						ctx.abort(); ctx.shutdown(); return;
					}
					admitted = wasAdmitted; ctx.abort(); return;
				}
				for (const edge of decision.edges) {
					const blockers = validateUpstreamAdmission({ config, predecessor: edge.predecessor, sourceInstanceId: edge.sourceInstanceId, upstreamIndex, includeChecks: false });
					if (blockers.length) throw new Error(blockers.join("; "));
				}
				const recheck = evaluateJoinAdmission(config, inboundEdges);
				if (recheck.outcome === "blocked") {
					endWithoutExecuting("blocked", recheck.reason, recheck.causes, "Join aborted by upstream failure");
					ctx.abort(); ctx.shutdown(); return;
				}
				if (recheck.outcome === "wait") {
					admitted = wasAdmitted; ctx.abort(); return;
				}
				queuedHandoffWake = undefined;
				if (!tryAdmitOwnership()) {
					admitted = wasAdmitted; ctx.abort(); return;
				}
				const claimed = claimJoinHandoff(config, decision.edges);
				if (claimed.outcome === "duplicate") { admitted = wasAdmitted; ctx.abort(); return; }
				acceptedJoinHandoffs = claimed.claim.handoff_ids;
				predecessorResults = decision.edges.map(edge => ({
					instanceId: edge.sourceInstanceId,
					nodeId: sourceNode(config!, edge.sourceInstanceId),
					result: edge.predecessor.result,
					path: resultPath(config!.session_dir, attemptKey(config!.review_plan, edge.sourceInstanceId, attemptNumber(edge.predecessor.identity?.attempt_id))),
				}));
			} catch (error) {
				ctx.abort();
				recordFailure(`Join admission failed: ${errorMessage(error)}`);
				ctx.shutdown(); return;
			}
		} else if (incoming.predecessor && (!completed || revising)) {
			try {
				const inbound = event.messageType === "custom" ? event.message : undefined;
				const ready = readJson<WorkerReady>(readyPath(config.session_dir, incoming.predecessor));
				const expected = config.review_plan ? parseWorkerReady(ready) : ready;
				if (config.review_plan && (expected.task_id !== config.task_id || expected.token !== config.token || expected.instance_id !== incoming.predecessor)) {
					throw new Error("Predecessor readiness identity mismatch");
				}
				const details = inbound?.details as { sender_session?: string } | undefined;
				// A message that is not a handoff notification at all is not this node's business; it cannot disturb accepted work.
				if (inbound?.customType !== "coms-inbound" || typeof inbound.content !== "string" || !inbound.content.includes("bootstrap-handoff:")) { admitted = wasAdmitted; ctx.abort(); return; }
				// Outside the loop, the first attempt consumes only the reviewer's finalized approval.
				const sourceLoop = reviewLoopFor(config.review_plan, incoming.predecessor);
				if (!revising && sourceLoop && sourceLoop !== loop) {
					const finalization = readFinalization(config.session_dir, config.task_id, sourceLoop, incoming.predecessor);
					if (!finalization) { admitted = wasAdmitted; ctx.abort(); return; }
					incoming = { ...incoming, predecessor_attempt: attemptNumber(finalization.attempt_id) };
				}
				predecessorPath = resultPath(config.session_dir, predecessorKey(incoming));
				// Coms only wakes this worker. The durable records decide whether the work may execute (handoff.ts): who sent it, whether it was
				// already accepted, and that the offer matches this run, attempts and the saved input.
				const decision = evaluateHandoff({
					config: incoming, expectedSession: expected.session_id, senderSession: details?.sender_session, content: inbound.content,
					loadPredecessor: () => parseCompletion(readJson<unknown>(predecessorPath!), predecessorExpectation(incoming)),
				});
				if (decision.outcome === "duplicate") {
					// A replay of an accepted handoff: the original acceptance stands, nothing restarts, and work already under way keeps its tools.
					admitted = wasAdmitted; ctx.abort();
					ctx.ui.notify(`Duplicate handoff notification ignored${isLegacyClaim(decision.claim) ? "" : `: ${decision.claim.handoff_id} was already accepted at ${decision.claim.accepted_at}`}`, "info");
					return;
				}
				if (decision.outcome === "reject") {
					try { recordHandoffRejection(incoming, decision.rejection); } catch { /* project storage unavailable */ }
					ctx.abort();
					if (decision.rejection.severity === "integrity") { admitted = false; recordFailure(`Handoff rejected: ${decision.rejection.reason}`, incoming); ctx.shutdown(); }
					else admitted = wasAdmitted;
					return;
				}
				const predecessor = decision.predecessor;
				// Integrity of the predecessor's record, outputs and artifacts: a violation is an attention condition. Required checks are judged below,
				// by the dependency decision, so that missing, unverified and stale evidence block the node with a recorded cause.
				const feedback = revising && !!loop && config.instance_id === loop.target;
				if (feedback && reviewVerdict(loop!, predecessor.result) !== "reject") throw new Error("Feedback requires a rejecting review");
				if (!revising && sourceLoop && sourceLoop !== loop &&
					(sourceLoop.reviewer !== incoming.predecessor || reviewVerdict(sourceLoop, predecessor.result) !== "approve")) {
					throw new Error("Forward handoff requires approval from the review loop");
				}
				const admissionBlockers = validateUpstreamAdmission({ config: incoming, predecessor, upstreamIndex, includeChecks: false });
				if (admissionBlockers.length) {
					throw new Error(admissionBlockers.join("; "));
				}
				if (config.version !== 1) {
					// The dependency's policy and required evidence decide, not the model's reading of the predecessor's summary. A blocked node is
					// finished, so nothing needs claiming: a repeated handoff message finds a completed node.
					const verdict = admission(incoming, { completion: predecessor });
					if (!verdict.admit) {
						if (verdict.outcome === "blocked") {
							endWithoutExecuting("blocked", verdict.reason, verdict.causes, "Chain aborted by upstream failure", incoming);
							if (revising) finishBlockedRevision(incoming);
						} else recordFailure(`Chain admission failed: ${verdict.reason}`, incoming);
						ctx.abort(); ctx.shutdown(); return;
					}
				}
				const revisionCancelled = () => {
					if (!revising) return false;
					const cancel = readCancellation(incoming);
					if (cancel.error) failClosedCancelError(cancel.error, ctx, incoming);
					else if (cancel.cancelled) {
						ctx.abort();
						recordCancelled(cancel.reason ?? "Run or node cancelled", ctx, false, incoming);
					}
					return !!cancel.error || cancel.cancelled;
				};
				if (revisionCancelled()) return;
				if (!revising) {
					queuedHandoffWake = undefined;
					if (!tryAdmitOwnership()) { admitted = wasAdmitted; ctx.abort(); return; }
				}
				// Claim the logical handoff, atomically, before model/tool side effects: of any racing notifications exactly one wins.
				const claimed = claimHandoff(incoming, decision, expected.session_id);
				if (claimed.outcome === "rejected") {
					try { recordHandoffRejection(incoming, { at: new Date().toISOString(), kind: "conflict", severity: "notification", reason: claimed.reason, ...(decision.offer ? { handoff_id: decision.offer.handoff_id } : {}) }); } catch { /* project storage unavailable */ }
					admitted = wasAdmitted; ctx.abort(); return;
				}
				if (claimed.outcome === "accepted" && revisionCancelled()) return;
				if (!revising && claimed.outcome === "accepted") config = incoming;
				if (revising && claimed.outcome === "accepted") {
					config = incoming;
					if (!config.write_paths?.length && config.read_paths?.length) {
						persistOwnership("admitted");
						ownershipAdmitted = true;
					}
					completed = delivered = completionRequested = cancelAborted = false;
					startedAt = undefined;
					startFailFastTimer(ctx);
					pendingChecks.clear();
					if (parkedTools) pi.setActiveTools(parkedTools);
					parkedTools = undefined;
				}
				if (claimed.outcome === "duplicate") { admitted = wasAdmitted; ctx.abort(); return; }
				acceptedHandoff = { ...(isLegacyClaim(claimed.claim) ? {} : { handoff_id: claimed.claim.handoff_id }), input_digest: decision.input_digest };
				if (config.version === 1 && predecessor.result.status === "failure") {
					endWithoutExecuting("blocked", predecessor.result.detail, [], "Chain aborted by upstream failure", incoming); ctx.abort(); ctx.shutdown(); return;
				}
				predecessorResult = predecessor.result;
			} catch (error) {
				ctx.abort();
				recordFailure(`Chain admission failed: ${errorMessage(error)}`, incoming);
				ctx.shutdown(); return;
			}
		}
		const history = loop && attemptNumber(config.attempt_id) > 1
			? upstreamIndex?.entries.filter(entry => entry.instance_id === config!.instance_id ||
				entry.instance_id === loop.reviewer).map(entry =>
				`${entry.node_id} attempt ${entry.attempt_id}: ${truncateUtf8(entry.summary, 240).text}${entry.instance_id === loop.reviewer ? ` (verdict ${truncateUtf8(JSON.stringify(entry.outputs?.[loop.field]) ?? "unavailable", 80).text})` : ""}. ` +
				`Full result: bootstrap_read_input({ kind: "result", node_id: ${JSON.stringify(entry.node_id)}, attempt_id: ${JSON.stringify(entry.attempt_id)} })`)
			: undefined;
		const peerData = formatPeerDataSection({ config, predecessorResult, predecessorPath, predecessorResults, upstreamIndex }) +
			(history?.length ? "\n\n## Earlier attempts and review findings (peer-produced data)\n" + history.join("\n") : "");
		admitted = true;
		started = true;
		startedAt ??= Date.now();
		activityAt = Date.now();
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		writeProgress();
		const basePrompt = event.systemPrompt.replace(piHarnessDocs, "");
		if (completed) {
			// The result is already durable (e.g. after a /reload with a failed handoff): only delivery can still be retried.
			return {
				systemPrompt: `${config.persona}\n\n${basePrompt}\n\n## Bootstrap execution contract\n` +
					`${identityLine(config)}\n` +
					`Your task is already finished and its result is saved. Do not redo or continue the work and do not use other tools. ` +
					`If delivery to the next agent failed, call bootstrap_complete again with your original status, summary and detail; the saved result is kept and only the handoff is retried.`,
			};
		}
		const activeAttempt = attemptNumber(config.attempt_id);
		const isLoopRevision = !!loop && activeAttempt > 1;
		const isFeedbackRevision = isLoopRevision && config.instance_id === loop.target;
		const prevAttemptId = isLoopRevision ? attemptKey(config.review_plan, config.instance_id, activeAttempt - 1) : undefined;
		const sourceNodeId = config.predecessor ? sourceNode(config, config.predecessor) : undefined;
		const sourceAttemptId = config.predecessor ? predecessorKey(config) : undefined;
		const readSourceHint = sourceNodeId && sourceAttemptId
			? `bootstrap_read_input({ kind: "result", node_id: ${JSON.stringify(sourceNodeId)}, attempt_id: ${JSON.stringify(sourceAttemptId)} })`
			: undefined;
		const revisionDirective = !isLoopRevision ? ""
			: isFeedbackRevision
				? `Revision directive: This is NEW attempt ${config.attempt_id} (revision ${activeAttempt - 1} of ${loop.max_revisions}). ` +
					`Reviewer ${sourceNodeId ?? loop.reviewer} (${sourceAttemptId ?? `${loop.reviewer}.${activeAttempt - 1}`}) rejected your earlier attempt ${prevAttemptId} (${loop.field}=${JSON.stringify(loop.reject)}). ` +
					`Treat earlier attempts and earlier bootstrap_complete calls in this conversation as superseded history — they do NOT complete attempt ${config.attempt_id}. ` +
					`Read the review findings in the predecessor result below${readSourceHint ? ` (or full result via ${readSourceHint})` : ""}, address them, run any required verification checks, and call bootstrap_complete for attempt ${config.attempt_id}.\n`
				: `New attempt directive: This is NEW attempt ${config.attempt_id} (iteration ${activeAttempt} of this review loop). ` +
					`Treat earlier attempts (${prevAttemptId}) and earlier bootstrap_complete calls in this conversation as superseded history — they do NOT complete attempt ${config.attempt_id}. ` +
					`Act on the updated predecessor result from ${sourceNodeId ?? config.predecessor} (${sourceAttemptId ?? "latest"})${readSourceHint ? ` (or full result via ${readSourceHint})` : ""} and call bootstrap_complete for attempt ${config.attempt_id}.\n`;
		const attemptScope = config.attempt_id ? ` for this attempt (${config.attempt_id})` : "";
		const revisionMessage = revising && isLoopRevision ? {
			customType: "bootstrap-revision-assignment",
			display: true,
			content: isFeedbackRevision
				? `NEW REVISION ASSIGNMENT — Attempt ${config.attempt_id} (node ${config.node_id})\n` +
					`Your earlier attempt (${prevAttemptId}) was rejected by ${sourceNodeId ?? loop.reviewer} (${sourceAttemptId ?? `${loop.reviewer}.${activeAttempt - 1}`}, ${loop.field}=${JSON.stringify(loop.reject)}). ` +
					`Earlier completion messages and bootstrap_complete calls in this conversation were for ${prevAttemptId} only and do NOT complete ${config.attempt_id}.\n` +
					(predecessorResult?.summary ? `Review summary (peer-produced data): ${truncateUtf8(predecessorResult.summary, 512).text}\n` : "") +
					(readSourceHint ? `Read full review findings via ${readSourceHint}${predecessorPath ? ` or ${predecessorPath}` : ""}.\n` : "") +
					`Address the review findings, run any required verification checks, and call bootstrap_complete for attempt ${config.attempt_id}.`
				: `NEW ATTEMPT ASSIGNMENT — Attempt ${config.attempt_id} (node ${config.node_id})\n` +
					`Earlier completion messages and bootstrap_complete calls in this conversation were for ${prevAttemptId} only and do NOT complete ${config.attempt_id}.\n` +
					(readSourceHint ? `Review the updated predecessor result from ${sourceNodeId ?? config.predecessor} (${sourceAttemptId}) via ${readSourceHint}${predecessorPath ? ` or ${predecessorPath}` : ""}, ` : "Act on the updated predecessor result, ") +
					`then call bootstrap_complete for attempt ${config.attempt_id}.`,
		} : undefined;
		return {
			systemPrompt: `${config.persona}\n\n${basePrompt}\n\n## Bootstrap execution contract — Authoritative assignment instructions\n` +
				`${identityLine(config)}\n` +
				`${executionModeLine(config)}\n` +
				(acceptedJoinHandoffs?.length ? `Accepted join handoffs: ${acceptedJoinHandoffs.join(", ")}.\n`
					: acceptedHandoff?.handoff_id ? `Accepted handoff: ${acceptedHandoff.handoff_id} (input digest ${acceptedHandoff.input_digest.slice(0, 12)}…).\n` : "") +
				revisionDirective +
				formatAuthoritativeBrief(config, taskInput) +
				`Report status honestly: success means the task is done; partial means gaps remain (a dependant that requires success will not start); failure means you could not do it. ` +
				`Call bootstrap_complete exactly once${attemptScope} with status, summary, detail, and optional outputs/artifacts/metrics/warnings/next_steps. ` +
				`That tool persists your result and routes chain input automatically. ` +
				(config.predecessor ? `The handoff notification only wakes you: your input${attemptScope} was accepted durably (the accepted handoff ID above) before this turn, so a repeated notification for the same handoff will not restart this attempt. ` : "") +
				`Do not manually forward results or wait via coms_await. ` +
				`The Coms API is request/response: coms_send({target,prompt}); coms_await({msg_id}). ` +
				`Do not call coms_send({recipient,message}) or coms_await({sender}). ` +
				`If you cannot finish, call bootstrap_complete with status failure. ` +
				(loop ? `After calling bootstrap_complete for ${config.attempt_id}, do not start more work until a new attempt is assigned.` : `After completion, do not start more work.`) +
				peerData,
			...(revisionMessage ? { message: revisionMessage } : {}),
		};
		} finally {
			if (!admitted && parkedTools && event.systemPromptOptions) event.systemPromptOptions.selectedTools = [];
		}
	});

	// shutdown() is deferred until idle. Block queued/parallel work after completion, cancellation, or rejected admission.
	pi.on("tool_call", async (event, ctx) => {
		if (!config) return pi.getFlag("bootstrap-worker-config") && !detached ? { block: true, reason: "Bootstrap worker is initializing" } : undefined;
		if (!completed) {
			const cancel = readCancellation();
			if (cancel.error) { failClosedCancelError(cancel.error, ctx); return { block: true, reason: cancel.error }; }
			if (cancel.cancelled) return { block: true, reason: "Bootstrap run or node was cancelled" };
		}
		const internalHandoff = completing && event.parentToolCallId && event.toolName === "coms_send";
		if (checkAndApplyFailFast(ctx)) {
			return { block: true, reason: failureRecorded ? "Unusable fail-fast evidence; worker needs attention" : "Run cancelled by fail-fast policy" };
		}
		if (config.intervention && config.factory_managed && event.toolName !== "bootstrap_request_direction") {
			// The waiting boundary is durable: an aborted wait, a recorded-but-unconsumed response or a restart never frees ordinary work.
			try {
				const open = findOpenRequest(config.factory_managed.state_db_path, config.factory_managed.attempt_id, config.node_id, activeKey(config));
				if (open) return { block: true, reason: `Waiting for human direction (request ${open}); ordinary work and completion cannot continue until it is answered and consumed. Call bootstrap_request_direction again to resume waiting.` };
			} catch (error) { return { block: true, reason: `Cannot verify that no human-direction request is open: ${errorMessage(error)}` }; }
		}
		if (holdForAttention || !released || (!admitted && !internalHandoff) || ((completed || completionRequested) && event.toolName !== "bootstrap_complete" && !internalHandoff)) {
			return { block: true, reason: "Bootstrap worker has no admitted work or has already completed" };
		}
		if (event.toolName === "coms_send" && !internalHandoff && collaborationModeOf(config) === "independent") {
			return { block: true, reason: "Peer messaging via coms_send is disabled in independent execution mode; coordinate via bootstrap_complete or opt into collaboration_mode: \"collaborative\"" };
		}
		// Only a well-formed completion locks the toolset; a malformed call is rejected and the work goes on.
		if (event.toolName === "bootstrap_complete" && looksLikeResult(event.input)) completionRequested = true;
	});

	pi.registerTool({
		name: "bootstrap_complete", label: "Bootstrap Complete",
		description: "Persist your final structured result and route any downstream or feedback handoffs (in a chain, graph fan-out/join, or decision node). Use only when your assigned task is finished. Each handoff is recorded durably and Coms is only the wake-up: a transport acknowledgement means it is queued, not accepted, and only the successor's own claim records acceptance. If a handoff fails, the result stays saved: call it again to retry delivery of only the undelivered edge(s) (the saved result and the same handoffs are kept).",
		parameters: Type.Object(resultFields),
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (config?.review_plan && !admitted) throw new Error("Bootstrap worker is parked or has no admitted work");
			if (!config || !released) { completionRequested = completed; throw new Error("Bootstrap worker is not ready"); }
			if (delivered) return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
			if (completing) throw new Error("Completion is already in progress");
			completing = true;
			const settled = config.review_plan ? Promise.withResolvers<void>() : undefined;
			completionSettled = settled?.promise;
			try {
				const path = resultPath(config.session_dir, activeKey(config));
				// Retrying a failed delivery must not replace the original result or create a second completion.
				const existing = existsSync(path) ? parseCompletion(readJson<unknown>(path), ownExpectation(config)) : undefined;
				if (existing && deliverySettled(config, existing)) {
					completed = true; delivered = true;
					if (ownLoop(config)) park();
					else ctx.shutdown();
					return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
				}
				if (!existing) {
					const cancel = readCancellation();
					if (cancel.error) {
						completionRequested = false;
						failClosedCancelError(cancel.error, ctx);
						return { isError: true, content: [{ type: "text", text: cancel.error }], details: { status: "error" } };
					}
					if (cancel.cancelled) {
						completionRequested = false;
						recordCancelled(cancel.reason ?? "Run or node cancelled", ctx);
						return { isError: true, content: [{ type: "text", text: `Cannot complete: node was cancelled (${cancel.reason ?? "cancelled"}).` }], details: { status: "cancelled" } };
					}
					if (checkAndApplyFailFast(ctx)) {
						completionRequested = false;
						return { isError: true, content: [{ type: "text", text: failureRecorded ? "Cannot complete: unusable fail-fast evidence; worker needs attention." : "Cannot complete: run was cancelled by fail-fast policy." }], details: { status: failureRecorded ? "error" : "cancelled" } };
					}
					if (failureRecorded) {
						completionRequested = false;
						return { isError: true, content: [{ type: "text", text: "Cannot complete: fail-closed cancellation error recorded." }], details: { status: "error" } };
					}
				}
				const rawResult = existing?.result ?? { ...params, agent_name: config.persona_name } as BootstrapResult;
				const enrichedArtifacts = existing?.result
					? rawResult.artifacts
					: enrichArtifactsWithProvenance(rawResult.artifacts, config.project_cwd, config.session_dir, {
						node_id: config.node_id,
						attempt_id: config.attempt_id ?? config.instance_id,
						instance_id: config.instance_id,
					});
				const result: BootstrapResult = enrichedArtifacts !== undefined
					? { ...rawResult, artifacts: enrichedArtifacts }
					: rawResult;
				if (!existing && result.status !== "failure") {
					const blockers: string[] = [];
					if (config.output_contract) {
						blockers.push(...validateOutputContract(config.output_contract, result, config.project_cwd, config.session_dir));
					}
					blockers.push(...validateArtifactHashes(result.artifacts, config.project_cwd, config.session_dir, config.node_id));
					const requiredChecks = requiredChecksOf(config);
					if (requiredChecks.length || existsSync(join(config.session_dir, `${activeKey(config)}.verification.json`))) {
						const ver = evaluateNodeVerification(config.session_dir, config.instance_id, config.project_cwd, requiredChecks, config.task_id, activeKey(config));
						blockers.push(...ver.blockers);
						if (ver.summaries.length && !blockers.length) result.verification = ver.summaries;
					}
					if (blockers.length) {
						completionRequested = false;
						return { isError: true, content: [{ type: "text", text: `Output/verification contract validation failed: ${blockers.join("; ")}` }], details: { status: "error", blockers } };
					}
				}
				if (!existing) {
					let claim: ReturnType<typeof claimOutcome>;
					try {
						claim = claimOutcome(config.session_dir, cancelIdentity(config), "completed", new Date().toISOString(), activeKey(config));
					} catch (error) {
						completionRequested = false;
						const message = `unusable outcome claim: ${errorMessage(error)}`;
						failClosedCancelError(message, ctx);
						return { isError: true, content: [{ type: "text", text: message }], details: { status: "error" } };
					}
					if (!claim.won) {
						completionRequested = false;
						const cancel = readCancellation();
						recordCancelled(cancel.reason ?? "Cancelled concurrently with completion", ctx);
						return { isError: true, content: [{ type: "text", text: "Cannot complete: cancellation won the race before the result was committed." }], details: { status: "cancelled" } };
					}
				}
				const completion = completionRecord(config, result, "pending", existing?.completed_at ?? new Date().toISOString());
				if (existing?.edge_deliveries) completion.edge_deliveries = { ...existing.edge_deliveries };
				atomicJson(path, completion);
				if (config.version !== 1 && existsSync(join(config.session_dir, "upstream-index.json"))) {
					await upsertUpstreamIndex(config.session_dir, config.task_id, {
						node_id: config.node_id,
						persona_name: config.persona_name,
						attempt_id: config.attempt_id ?? config.instance_id,
						instance_id: config.instance_id,
						...(config.step !== undefined ? { step: config.step } : {}),
						status: completion.result.status,
						summary: completion.result.summary,
						completed_at: completion.completed_at,
						result_path: path,
						result_hash: resultHash(completion.result),
						...(completion.result.outputs ? { outputs: completion.result.outputs } : {}),
						...(completion.result.artifacts ? { artifacts: completion.result.artifacts } : {}),
						...(completion.result.verification ? { verification: completion.result.verification } : {}),
					});
				}
				completed = true;
				const loop = ownLoop(config);
				if (!loop || !config.write_paths?.length) persistOwnership("released");
				if (result.status === "failure") publishFailure(config, result.summary);
				if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
				if (failFastTimer) { clearInterval(failFastTimer); failFastTimer = undefined; }
				const attempt = attemptNumber(config.attempt_id);
				const outbound = config.outbound_edges ?? (config.successor ? [config.successor] : []);
				let suppressHandoff = false;
				if (loop) {
					const reviewer = loop.reviewer === config.instance_id;
					const verdict = reviewer ? reviewVerdict(loop, result) : undefined;
					const decision = readFinalization(config.session_dir, config.task_id, loop, loop.reviewer);
					const execution = { ...executionFromResult(result.status), reason: result.summary };
					if (decision) {
						finalizeReview(config.session_dir, config.task_id, loop, attempt, undefined, decision.finalized_by, { force: true });
						if (!reviewer && attempt > attemptNumber(decision.attempt_id)) {
							finalizeMemberAfterDecision(config.session_dir, config.task_id, loop, config.instance_id, attempt, decision.finalized_by);
						}
						suppressHandoff = verdict !== "approve";
						if (reviewer && decision.exhausted?.state === "failed") publishFailure(config, decision.exhausted.reason);
					} else if (result.status === "failure") {
						settleReviewFailure(config, execution);
					} else if (reviewer) {
						const exhausted = verdict === "reject"
							? await reserveRevision(config.session_dir, config.task_id, config.review_plan!, loop, attempt + 1)
							: undefined;
						const lateDecision = readFinalization(config.session_dir, config.task_id, loop, loop.reviewer);
						if (lateDecision) {
							finalizeReview(config.session_dir, config.task_id, loop, attempt, undefined, lateDecision.finalized_by, { force: true });
							suppressHandoff = verdict !== "approve";
							if (lateDecision.exhausted?.state === "failed") publishFailure(config, lateDecision.exhausted.reason);
						} else {
							if (verdict !== "reject" || exhausted) finalizeReview(config.session_dir, config.task_id, loop, attempt, exhausted);
							if (exhausted && loop.on_exhausted === "failed") publishFailure(config, exhausted);
						}
					} else if (attempt > 1) {
						for (const dest of outbound) {
							if (!loop.members.includes(dest)) continue;
							const successor = parseWorkerConfig(readJson<unknown>(join(config.session_dir, `${dest}.config.json`)));
							const admission = admissionForEdge({ ...successor, predecessor_attempt: attempt }, config.instance_id, { completion });
							if (!admission.admit && admission.outcome === "blocked") {
								settleReviewFailure(config, execution, admission);
								suppressHandoff = true;
								break;
							}
						}
					}
					if (ownershipAdmitted && (readFinalization(config.session_dir, config.task_id, loop, config.instance_id) || readFinalization(config.session_dir, config.task_id, loop, loop.reviewer))) {
						persistOwnership("released");
					}
				}

				const deadMembers = !suppressHandoff && loop && (loop.reviewer !== config.instance_id || (result.status === "success" && reviewVerdict(loop, result) === "reject"))
					? deadLoopMembers(config.session_dir, loop, config.roster ?? [], config.instance_id)
					: [];
				const routes = suppressHandoff || deadMembers.length
					? []
					: config.review_plan && completion.identity
					? reviewRoutes(config.session_dir, completion.identity, config.review_plan, result, outbound)
					: outbound.map(instance => ({ instance, attempt: 1 }));
				const finishDelivery = () => {
					delivered = true;
					if (loop) park();
					else ctx.shutdown();
				};
				if (config.review_plan || config.topology === "graph" || config.outbound_edges !== undefined) {
					if (routes.length === 0) {
						completion.delivery = "not_required";
						atomicJson(path, completion);
						finishDelivery();
						return { content: [{ type: "text", text: "Result persisted; graph handoff complete." }], details: { status: "saved" } };
					}
					const edgeDeliveries: Record<string, EdgeDeliveryState> = { ...(completion.edge_deliveries ?? {}) };
					const queuedOffers: HandoffOffer[] = [];
					const failedEdges: Array<[string, string]> = [];
					for (const { instance: dest, attempt: destinationAttempt } of routes) {
						if (edgeDeliveries[dest]?.state === "sent") continue;
						const destinationKey = attemptKey(config.review_plan, dest, destinationAttempt);
						const offerFile = handoffOfferPath(config.session_dir, destinationKey, config.instance_id);
						const claimFile = handoffClaimPath(config.session_dir, destinationKey, config.instance_id);
						let existingOffer: HandoffOffer | undefined;
						if (config.handoff_protocol && existsSync(offerFile)) {
							try { existingOffer = parseHandoffOffer(readJson<unknown>(offerFile)); } catch { /* fall through */ }
						}
						const existingClaimed = existsSync(claimFile);
						if (existingClaimed || existingOffer?.state === "queued") {
							let claimedId = existingOffer?.handoff_id;
							if (!claimedId && existingClaimed) {
								try {
									const claim = parseHandoffClaim(readJson<unknown>(claimFile));
									if (!isLegacyClaim(claim)) claimedId = claim.handoff_id;
								} catch { /* fall through */ }
							}
							edgeDeliveries[dest] = {
								state: "sent",
								...(claimedId ? { handoff_id: claimedId } : {}),
								updated_at: new Date().toISOString(),
							};
							completion.edge_deliveries = { ...edgeDeliveries };
							atomicJson(path, completion);
							if (existingOffer) queuedOffers.push(existingOffer);
							continue;
						}
						let offer: HandoffOffer | undefined;
						try {
							const ready = readJson<WorkerReady>(readyPath(config.session_dir, dest));
							if (ready.task_id !== config.task_id || ready.token !== config.token || ready.instance_id !== dest) {
								throw new Error(`Successor ${dest} readiness identity mismatch`);
							}
							offer = config.handoff_protocol
								? offerHandoff(config, completion, path, undefined, undefined, dest, config.instance_id, destinationAttempt)
								: undefined;
							const response = await ctx.executeTool("coms_send", {
								target: ready.session_id,
								prompt: handoffNotification(config, offer, path, result.status === "failure"),
							}, { signal });
							if (response.isError) throw new Error(response.content.map(part => part.type === "text" ? part.text : "").join("\n"));
							if (offer) offer = markHandoffQueued(config, offer, undefined, config.instance_id);
							if (offer) queuedOffers.push(offer);
							edgeDeliveries[dest] = {
								state: "sent",
								...(offer ? { handoff_id: offer.handoff_id } : {}),
								updated_at: new Date().toISOString(),
							};
						} catch (edgeError) {
							const message = errorMessage(edgeError);
							const handoffId = offer?.handoff_id ?? edgeDeliveries[dest]?.handoff_id;
							edgeDeliveries[dest] = {
								state: "failed",
								error: message,
								...(handoffId ? { handoff_id: handoffId } : {}),
								updated_at: new Date().toISOString(),
							};
							failedEdges.push([dest, message]);
						}
						completion.edge_deliveries = { ...edgeDeliveries };
						atomicJson(path, completion);
					}
					completion.edge_deliveries = edgeDeliveries;
					if (failedEdges.length > 0) {
						completion.delivery = "failed";
						completion.delivery_error = failedEdges.map(([dest, message]) => `${dest}: ${message}`).join("; ");
						atomicJson(path, completion);
						return {
							isError: true,
							content: [{ type: "text", text: `Result retained, but fan-out delivery failed for ${failedEdges.map(([dest, msg]) => `${dest} (${msg})`).join("; ")}. You may retry bootstrap_complete to send only the remaining edges. If you cannot, the dispatcher can repair delivery from the saved result (bootstrap_recover); do not redo your task.` }],
							details: { status: "error", edge_deliveries: edgeDeliveries },
						};
					}
					completion.delivery = "sent";
					delete completion.delivery_error;
					atomicJson(path, completion);
					finishDelivery();
					const summary = queuedOffers.map(offer => `${offer.handoff_id} -> ${offer.destination.instance_id}`).join(", ");
					const completionText = queuedOffers.length
						? (loop
							? `Result persisted for attempt ${config.attempt_id}; handoffs queued (${summary}). Acceptance is recorded only when each successor claims its handoff; attempt ${config.attempt_id} is complete and you are parked until the review loop finalizes or assigns a new attempt.`
							: `Result persisted; handoffs queued (${summary}). Acceptance is recorded only when each successor claims its handoff; you are done and need not wait.`)
						: (loop
							? `Result persisted for attempt ${config.attempt_id}; graph fan-out complete.`
							: "Result persisted; graph fan-out complete.");
					return {
						content: [{ type: "text", text: completionText }],
						details: { status: "saved", edge_deliveries: edgeDeliveries },
					};
				}
				const successor = config.successor;
				let handoffOffer: HandoffOffer | undefined;
				if (successor) {
					const ready = readJson<WorkerReady>(readyPath(config.session_dir, successor));
					if (ready.task_id !== config.task_id || ready.token !== config.token || ready.instance_id !== successor) throw new Error("Successor readiness identity mismatch");
					// The durable offer comes first: the notification only wakes the destination, which decides from this record.
					let offer: HandoffOffer | undefined = config.handoff_protocol ? offerHandoff(config, completion, path) : undefined;
					const response = await ctx.executeTool("coms_send", {
						target: ready.session_id,
						prompt: handoffNotification(config, offer, path, result.status === "failure"),
					}, { signal });
					if (response.isError) throw new Error(response.content.map(part => part.type === "text" ? part.text : "").join("\n"));
					// A transport acknowledgement queues the handoff; acceptance is the destination's claim, recorded separately.
					if (offer) offer = handoffOffer = markHandoffQueued(config, offer);
					completion.delivery = "sent";
				} else {
					// The durable result is authoritative; dispatcher messaging is optional and never required for collection.
					completion.delivery = "not_required";
				}
				atomicJson(path, completion);
				delivered = true;
				ctx.shutdown();
				return { content: [{ type: "text", text: handoffOffer ? `Result persisted; handoff ${handoffOffer.handoff_id} queued for ${handoffOffer.destination.instance_id} (Coms acknowledged the message). It is not accepted until the successor records its claim; you are done and need not wait.` : "Result persisted; chain handoff complete." }], details: { status: "saved", ...(handoffOffer ? { handoff_id: handoffOffer.handoff_id, handoff_state: handoffOffer.state } : {}) } };
			} catch (error) {
				// Nothing was persisted: the worker may keep working instead of being locked out of its tools.
				if (!completed) completionRequested = false;
				const path = resultPath(config.session_dir, activeKey(config));
				if (existsSync(path)) {
					const completion = readJson<WorkerCompletion>(path);
					// A shutdown or park failure after the final delivery write must not reopen delivery.
					if (completion.delivery === "sent" || completion.delivery === "not_required") {
						return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
					}
					completion.delivery = "failed"; completion.delivery_error = errorMessage(error); atomicJson(path, completion);
					return { isError: true, content: [{ type: "text", text: `Result retained, but chain delivery failed: ${errorMessage(error)}. You may retry bootstrap_complete. If you cannot, the dispatcher can repair delivery from the saved result (bootstrap_recover); do not redo your task.` }], details: { status: "error" } };
				}
				return { isError: true, content: [{ type: "text", text: `Completion failed: ${errorMessage(error)}` }], details: { status: "error" } };
			} finally {
				completing = false;
				completionSettled = undefined;
				settled?.resolve();
			}
		},
	});

	pi.registerTool({
		name: "bootstrap_request_direction", label: "Bootstrap Request Direction",
		description: "Ask a human for direction when your assignment is unclear or needs a decision you must not guess. Offer a nonempty subset of your plan choices (all required ones included); a human selects one or explicitly declines. Your work waits here with no deadline of its own, then continues. A decline permits only work your assignment and plan already authorize; otherwise report that you cannot proceed. Only a node enabled by its definition may ask.",
		parameters: Type.Object({
			question: Type.String({ description: "What you need decided" }),
			reason: Type.String({ description: "Why you cannot decide this yourself" }),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "Evidence or references the human should see" })),
			choices: Type.Array(Type.String(), { description: "choice_id values from your plan choices to offer" }),
			recommendation: Type.Optional(Type.Object({ choice_id: Type.String(), rationale: Type.Optional(Type.String()) })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const managed = config?.factory_managed;
			if (!config || !managed || !config.intervention) throw new Error("This node is not enabled to request human direction");
			if (!released || !admitted || completed || completionRequested || holdForAttention) throw new Error("Only an admitted attempt that is still working may request direction");
			if (waitingForHumanSince !== undefined) throw new Error("This attempt is already waiting for human direction");
			const cancel = readCancellation();
			if (cancel.error || cancel.cancelled) throw new Error(cancel.error ?? "Bootstrap run or node was cancelled");
			const nodeAttempt = activeKey(config);
			let requestId = findOpenRequest(managed.state_db_path, managed.attempt_id, config.node_id, nodeAttempt);
			if (!requestId) {
				const db = openRequestDatabase(managed.state_db_path);
				try {
					requestId = inTransaction(db, () => createRequest(db, {
						factory_id: managed.factory_id, input_id: managed.input_id, attempt_id: managed.attempt_id, task_id: config!.task_id, node_id: config!.node_id, node_attempt_id: nodeAttempt,
						question: params.question, reason: params.reason, evidence: params.evidence, choices: params.choices, recommendation: params.recommendation,
					})).request_id;
				} finally { db.close(); }
			}
			const waitStartedAt = waitingForHumanSince = Date.now();
			// Dependants recognize the live wait explicitly, without treating heartbeats as progress.
			heartbeat();
			try {
				const result = await awaitDirection(managed.state_db_path, requestId, { signal, cancelled: () => { const state = readCancellation(); return state.cancelled || Boolean(state.error); } });
				if (result.outcome === "terminated") return { isError: true, content: [{ type: "text", text: `Request ${requestId} was closed because the attempt was ${result.view.terminated?.reason ?? "cancelled"}. Stop work.` }], details: { status: "terminated", request_id: requestId } };
				const response = result.view.response!;
				const guidance = response.guidance ? ` Guidance: ${response.guidance}` : "";
				const text = response.kind === "choice"
					? `A human chose ${JSON.stringify(response.choice_id)} for request ${requestId}.${guidance}`
					: `A human declined request ${requestId}; this is not approval. Proceed only with work your assignment and plan already authorize, otherwise report that you cannot proceed.${guidance}`;
				return { content: [{ type: "text", text }], details: { status: "answered", request_id: requestId, response: response.kind, ...(response.kind === "choice" ? { choice_id: response.choice_id } : {}) } };
			} finally {
				const waitEndedAt = Date.now();
				if (startedAt !== undefined) startedAt += waitEndedAt - waitStartedAt;
				activityAt = waitEndedAt;
				waitingForHumanSince = undefined;
				heartbeat();
			}
		},
	});

	pi.registerTool({
		name: "bootstrap_read_input",
		label: "Bootstrap Read Input",
		description: "Retrieve full bounded slices of your immutable task input, the upstream-results index, an earlier node's (or earlier attempt's) full result, or a verified upstream file artifact.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("task_input"), Type.Literal("upstream_index"), Type.Literal("result"), Type.Literal("artifact")]),
			attempt_id: Type.Optional(Type.String({ description: "Select a specific earlier attempt for kind=result" })),
			node_id: Type.Optional(Type.String({ description: "Target node_id or instance_id (required for kind=\"result\", optional for kind=\"artifact\" hash verification)" })),
			path: Type.Optional(Type.String({ description: "Artifact path relative to project_cwd (required for kind=\"artifact\")" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-8 byte offset (default 0)" })),
			max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536, description: "Max bytes to return (default 32768, max 65536)" })),
		}),
		async execute(_id, params) {
			if (!config || !released || !admitted) throw new Error("Bootstrap worker is not admitted");
			try {
				if (params.kind === "task_input" && isManagedWorker(config)) {
					requireManagedTaskInput(config);
				}
				const data = readBoundedInput({
					config,
					kind: params.kind,
					node_id: params.node_id,
					attempt_id: params.attempt_id,
					path: params.path,
					offset: params.offset,
					max_bytes: params.max_bytes,
				});
				const meta = `[source: ${data.source}; offset ${data.offset}-${data.next_offset} of ${data.totalBytes} bytes${data.truncated ? `; truncated — pass offset=${data.next_offset} for next chunk` : ""}]`;
				return {
					content: [{ type: "text", text: `${meta}\n${data.text}` }],
					details: data,
				};
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: errorMessage(error) }], details: { status: "error", error: errorMessage(error) } };
			}
		},
	});

	pi.registerTool({
		name: "bootstrap_verify",
		label: "Bootstrap Verify",
		description: "Record or run a verification check with before/after repository content snapshots (including untracked files). Historical checks are preserved; edits during a check or unestablished scopes mark applicability unknown (unverified), and edits after a check mark applicability stale.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("finish"), Type.Literal("run"), Type.Literal("status")]),
			check_id: Type.Optional(Type.String({ description: "Check identifier (required for start, finish, run)" })),
			scope: Type.Optional(Type.Array(Type.String(), { description: "Optional reliable relative paths/globs for this check; omit for conservative full-project snapshot" })),
			result: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("error")], { description: "Check outcome (required for finish)" })),
			command: Type.Optional(Type.String({ description: "Shell command (only for action=\"run\" when bash is allowed)" })),
			detail: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			if (!config || !released || !admitted) throw new Error("Bootstrap worker is not admitted");
			try {
				const identity = {
					run_id: config.task_id,
					node_id: config.node_id,
					persona_name: config.persona_name,
					attempt_id: config.attempt_id ?? config.instance_id,
					instance_id: config.instance_id,
				};
				if (params.action === "status") {
					const ev = evaluateNodeVerification(config.session_dir, config.instance_id, config.project_cwd, requiredChecksOf(config), config.task_id, activeKey(config));
					return { content: [{ type: "text", text: JSON.stringify(ev, null, 2) }], details: ev };
				}
				if (!params.check_id?.trim()) throw new Error("check_id is required");
				if (params.action === "start") {
					const started = beginVerificationCheck(config.project_cwd, params.check_id.trim(), params.scope);
					pendingChecks.set(params.check_id.trim(), started);
					return {
						content: [{ type: "text", text: `Started verification check "${started.check_id}" (${started.scope_kind} scope, ${Object.keys(started.before_snapshot.files).length} files snapshotted).` }],
						details: { status: "started", check_id: started.check_id, scope_kind: started.scope_kind, files: Object.keys(started.before_snapshot.files).length },
					};
				}
				if (params.action === "finish") {
					if (!params.result) throw new Error("result is required for action=\"finish\"");
					const started = pendingChecks.get(params.check_id.trim());
					if (!started) throw new Error(`No started verification check found for "${params.check_id}"`);
					pendingChecks.delete(params.check_id.trim());
					const finished = finishVerificationCheck(config.session_dir, identity, started, {
						result: params.result,
						detail: params.detail,
						name: params.name,
					}, activeKey(config));
					return {
						content: [{ type: "text", text: `Verification "${finished.record.check_id}" recorded: result=${finished.record.result}, applicability=${finished.applicability}${finished.reason ? ` (${finished.reason})` : ""}.` }],
						details: finished,
					};
				}
				if (params.action === "run") {
					if (config.tools.length > 0 && !config.tools.includes("bash")) {
						throw new Error("Verification command execution requires bash tool permission");
					}
					if (!params.command?.trim()) throw new Error("command is required for action=\"run\"");
					const ran = await runVerificationCommand({
						sessionDir: config.session_dir,
						projectCwd: config.project_cwd,
						identity,
						recordKey: activeKey(config),
						checkId: params.check_id.trim(),
						command: params.command,
						scope: params.scope,
						name: params.name,
					});
					return {
						content: [{ type: "text", text: `Verification "${ran.record.check_id}" ran: result=${ran.record.result}, applicability=${ran.applicability}${ran.reason ? ` (${ran.reason})` : ""}.` }],
						details: ran,
					};
				}
				throw new Error(`Unsupported verification action: ${String(params.action)}`);
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: errorMessage(error) }], details: { status: "error", error: errorMessage(error) } };
			}
		},
	});

	pi.on("agent_before_settle" as any, async (event: any, ctx: any) => {
		if (!config || !released || completed || completing || completionRequested || holdForAttention || !started || !admitted) return;
		if (event?.outcome !== "completed") return;
		const cancel = readCancellation();
		if (cancel.error) { failClosedCancelError(cancel.error, ctx); return; }
		if (cancel.cancelled) return;
		if (checkAndApplyFailFast(ctx)) return;
		const attemptKeyId = activeKey(config);
		if (completionReminderAttempt === attemptKeyId) return;
		completionReminderAttempt = attemptKeyId;
		const attemptLabel = config.attempt_id ?? config.instance_id;
		const loop = ownLoop(config);
		const revisionNote = loop && attemptNumber(config.attempt_id) > 1
			? ` Earlier attempts and earlier bootstrap_complete calls in this conversation do NOT complete ${attemptLabel}.`
			: "";
		return {
			entries: [
				...(Array.isArray(event?.entries) ? event.entries : []),
				{
					type: "custom_message",
					customType: "bootstrap-completion-reminder",
					content: `Attempt ${attemptLabel} is still active and has not recorded a result via bootstrap_complete.${revisionNote} ` +
						`Do not redo work you already completed in this attempt; finish any remaining work for ${attemptLabel} and call bootstrap_complete with your structured result (or status: "failure" if you cannot finish).`,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!config || !released || completed) return;
		const cancel = readCancellation();
		if (cancel.error) { failClosedCancelError(cancel.error, ctx); return; }
		if (cancel.cancelled) {
			recordCancelled(cancel.reason ?? "Run or node cancelled", ctx, true);
			return;
		}
		if (!started || !admitted) return;
		recordFailure(event.aborted ? "Worker was aborted before recording a result" : "Worker settled without calling bootstrap_complete");
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (event) => {
		stopTimers();
		const replaced = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		if (config && initialized && replaced) {
			// Whether an outcome was already on record BEFORE this teardown records one: a tool still running in a replaced session is not stopped by recording cancellation.
			let outcomeRecorded = completed || failureRecorded || !started;
			try { outcomeRecorded ||= existsSync(dispositionPath(config.session_dir, activeKey(config))); } catch { /* unknown stays false */ }
			try { atomicJson(detachedFile(config), { task_id: config.task_id, token: config.token, reason: event.reason, detached_at: new Date().toISOString(), outcome_recorded: outcomeRecorded }); } catch { /* cleanup may have removed session files */ }
		}
		if (!config || !initialized || completed || failureRecorded || event.reason === "reload") return;
		const cancel = readCancellation();
		if (cancel.error) {
			if (!existsSync(errorFile())) recordFailure(cancel.error);
			return;
		}
		if (cancel.cancelled) {
			recordCancelled(cancel.reason ?? "Run or node cancelled", { shutdown: () => {} });
			return;
		}
		// Keep a more specific error written earlier (possibly by a previous instance before a reload).
		if (existsSync(errorFile())) return;
		recordFailure(replaced
			? `Worker session was replaced (/${event.reason}) before recording a result`
			: "Worker exited before recording a result");
	});
}
