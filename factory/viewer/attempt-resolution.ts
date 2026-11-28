import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import {
	cancelPath,
	outcomeClaimPath,
	readCancelRecordSafe,
	readOutcomeClaimSafe,
	readRunCancelRecordSafe,
	runCancelPath,
	type ProgressSnapshot,
} from "../../bootstrap/cancellation.ts";
import { verifyBoundReviewPlan } from "../../bootstrap/factory-requests.ts";
import {
	currentAttempt,
	describeHandoff,
	handoffClaimPath,
	handoffOfferPath,
	handoffRecoveryPath,
	handoffRejectionsPath,
} from "../../bootstrap/handoff.ts";
import {
	decideAdmission,
	deriveEdgeState,
	effectiveDependencyPolicy,
	executionFromResult,
	type CauseRef,
	type EdgeState,
	type EvidenceStatus,
	type ExecutionState,
} from "../../bootstrap/outcomes.ts";
import { failFastPath, readFailFast } from "../../bootstrap/ownership.ts";
import {
	attemptNumber,
	blockedReviewForwardEdge,
	finalizePath,
	finalizedReviewRejection,
	readFinalization,
	reviewLoopFor,
	type ReviewLoop,
} from "../../bootstrap/review-loop.ts";
import {
	assertNoSymlinkPath,
	dispositionPath,
	expectationFor,
	inboundEdgesOf,
	parseCompletion,
	parseDisposition,
	parseWorkerReady,
	pathEntryExists,
	processAlive,
	readRegularJsonNoSymlink,
	readyPath,
	resultPath,
	type AgentLaunch,
	type BootstrapManifest,
	type CommandEvidence,
	type CompletionExpectation,
	type Disposition,
	type WorkerCompletion,
} from "../../bootstrap/session-store.ts";
import {
	collectArtifactPathTokens,
	compileArtifactRedactionMatcher,
	sanitizeOperatorText,
	sanitizeOutputText as sanitizeOutputTextHelper,
} from "./sanitize.ts";

export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{1,32}$/;
const EVIDENCE_STATUSES = new Set<EvidenceStatus>(["passing", "missing", "unverified", "stale", "failed"]);

export function validateIsoTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 64 || !ISO_TIMESTAMP_RE.test(value)) {
		return undefined;
	}
	return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function validateExecutionState(value: unknown): ExecutionState {
	return typeof value === "string" && Object.hasOwn(STATUS_TEXT, value)
		? (value as ExecutionState)
		: "needs_attention";
}

export function validateEvidenceStatus(value: unknown): EvidenceStatus {
	return typeof value === "string" && EVIDENCE_STATUSES.has(value as EvidenceStatus)
		? (value as EvidenceStatus)
		: "unverified";
}

export function sanitizeCommandSignal(
	signal: unknown,
	blockedPaths: readonly string[],
	mode: "operator" | "output",
): string | null {
	if (signal === null || signal === undefined) return null;
	const raw = typeof signal === "string" ? signal : "";
	if (!raw) return null;
	if (raw.length <= 35 && SIGNAL_RE.test(raw)) return raw;
	return mode === "output"
		? sanitizeOutputTextHelper(raw, 128, blockedPaths)
		: sanitizeOperatorText(raw, 128, blockedPaths);
}

export const STATUS_TEXT: Record<ExecutionState, string> = {
	pending: "Pending",
	waiting: "Waiting",
	running: "Running",
	succeeded: "Succeeded",
	partial: "Partial",
	failed: "Failed",
	blocked: "Blocked",
	skipped: "Skipped",
	cancelled: "Cancelled",
	needs_attention: "Uncertain",
};

export interface ProjectedCause {
	node_id: string;
	state: ExecutionState;
	reason: string;
	check?: { name: string; evidence: EvidenceStatus };
}

export function assertPathInsideDir(dir: string, targetPath: string, label: string): void {
	const rel = relative(resolve(dir), resolve(targetPath));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Refusing ${label} outside session directory`);
	}
}

export function assertRegularDirNoSymlink(dir: string, label: string): void {
	assertNoSymlinkPath(dir);
	if (!pathEntryExists(dir)) {
		throw new Error(`Missing ${label}`);
	}
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`Refusing non-directory ${label}`);
	}
}

/** Verify an existing path is a regular, non-symlink, size-bounded file using O_NONBLOCK | O_NOFOLLOW. */
export function assertRegularFileIfExists(path: string, label: string, maxBytes = MAX_EVIDENCE_FILE_BYTES): boolean {
	if (!pathEntryExists(path)) return false;
	assertNoSymlinkPath(path);
	const st = lstatSync(path);
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new Error(`Refusing non-regular ${label}`);
	}
	if (st.size > maxBytes) {
		throw new Error(`Refusing oversized ${label}`);
	}
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const fst = fstatSync(fd);
		if (!fst.isFile()) {
			throw new Error(`Refusing non-regular ${label}`);
		}
		if (fst.size > maxBytes) {
			throw new Error(`Refusing oversized ${label}`);
		}
	} finally {
		closeSync(fd);
	}
	return true;
}

export function readBoundedRegularJsonIfExists<T>(
	dir: string,
	filePath: string,
	label: string,
	maxBytes = MAX_EVIDENCE_FILE_BYTES,
): { exists: false } | { exists: true; value: T } {
	assertPathInsideDir(dir, filePath, label);
	if (!pathEntryExists(filePath)) return { exists: false };
	assertNoSymlinkPath(filePath);
	const st = lstatSync(filePath);
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new Error(`Refusing non-regular ${label}`);
	}
	if (st.size > maxBytes) {
		throw new Error(`Refusing oversized ${label}`);
	}
	const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const fst = fstatSync(fd);
		if (!fst.isFile()) {
			throw new Error(`Refusing non-regular ${label}`);
		}
		if (fst.size > maxBytes) {
			throw new Error(`Refusing oversized ${label}`);
		}
		return { exists: true, value: JSON.parse(readFileSync(fd, "utf8")) as T };
	} finally {
		closeSync(fd);
	}
}

export function projectCommandOutcome(ev: CommandEvidence | undefined, blockedPaths: readonly string[] = []) {
	if (!ev) return undefined;
	return {
		exit_code: ev.exit_code,
		signal: sanitizeCommandSignal(ev.signal, blockedPaths, "operator"),
		duration_ms: ev.duration_ms,
	};
}

export function projectCauses(causes: CauseRef[] | undefined, blockedPaths?: readonly string[]): ProjectedCause[] | undefined {
	if (!Array.isArray(causes) || causes.length === 0) return undefined;
	const projected: ProjectedCause[] = [];
	for (const cause of causes) {
		if (!cause || typeof cause !== "object") continue;
		const rawNodeId = typeof cause.node_id === "string" ? cause.node_id : "";
		const rawReason = typeof cause.reason === "string" ? cause.reason : "";
		const rawCheck = cause.check && typeof cause.check === "object" ? cause.check : undefined;
		const rawCheckName = rawCheck && typeof rawCheck.name === "string" ? rawCheck.name : "";
		projected.push({
			node_id: blockedPaths ? sanitizeOperatorText(rawNodeId, 128, blockedPaths) : rawNodeId,
			state: validateExecutionState(cause.state),
			reason: blockedPaths ? sanitizeOperatorText(rawReason, 1000, blockedPaths) : rawReason,
			...(rawCheck
				? {
					check: {
						name: blockedPaths ? sanitizeOperatorText(rawCheckName, 500, blockedPaths) : rawCheckName,
						evidence: validateEvidenceStatus(rawCheck.evidence),
					},
				}
				: {}),
		});
	}
	return projected.length > 0 ? projected : undefined;
}

export function assertRunEvidenceConsistent(inspection: Inspection, releases: ReleasedFactoryRun[]) {
	const { factory, attempts, capacity, head_status } = inspection;
	const anyActiveAuthorized = attempts.filter(a => !a.historical && a.release_authorized);
	const active = anyActiveAuthorized.filter(a => a.state === "released");
	const badHistoricalReleased = attempts.some(
		a => ((a.state === "settled" || a.state === "cleared") && (!a.release_authorized || !a.settlement || Boolean(a.uncertainty?.length)))
			|| (a.state === "proven_not_released" && a.release_authorized),
	);
	const contradictoryHistoricalReleased = attempts.some(
		a => a.historical && a.release_authorized && a.state === "released",
	);
	const hasCurrentAttempt = attempts.some(a => !a.historical);
	const headExplainsFactoryHold = head_status.blocking_kind === "factory_held" || head_status.without_control_fence?.blocking_kind === "factory_held";
	const contradictoryFactoryHold = capacity.factory_slot === "held" && !hasCurrentAttempt && !headExplainsFactoryHold;
	const hasUncertainty = Boolean(
		inspection.uncertainty.length ||
		inspection.current_error ||
		inspection.control_error ||
		head_status.blocking_kind === "uncertain" ||
		capacity.factory_slot === "uncertain" ||
		capacity.checkout_slot === "uncertain" ||
		badHistoricalReleased ||
		contradictoryHistoricalReleased ||
		contradictoryFactoryHold,
	);

	if (inspection.deleted) {
		if (anyActiveAuthorized.length || releases.length || hasUncertainty || capacity.factory_slot === "held") {
			return { state: "uncertain" as const };
		}
		return { state: "no_displayed_run" as const };
	}
	if (anyActiveAuthorized.length || releases.length) {
		if (
			anyActiveAuthorized.length !== 1 ||
			active.length !== 1 ||
			releases.length !== 1 ||
			Boolean(active[0].uncertainty?.length) ||
			active[0].attempt_id !== releases[0].attempt_id ||
			active[0].bound_version !== releases[0].bound_version ||
			active[0].task_id !== releases[0].manifest.task_id ||
			releases[0].manifest.factory_managed?.factory_id !== factory.factory_id ||
			releases[0].manifest.factory_managed?.attempt_id !== active[0].attempt_id ||
			capacity.factory_slot !== "held" ||
			capacity.checkout_slot !== "held"
		) {
			return { state: "uncertain" as const };
		}
		return { state: "released" as const, release: releases[0] };
	}
	if (hasUncertainty) {
		return { state: "uncertain" as const };
	}
	return { state: "no_displayed_run" as const };
}

export function verifyReleaseMatchesDefinition(factoryId: string, release: ReleasedFactoryRun): Map<string, AgentLaunch> {
	const { definition, manifest, bound_version } = release;
	if (manifest.factory_managed?.factory_id !== factoryId || manifest.factory_managed?.bound_version !== bound_version) {
		throw new Error("Run factory binding does not match the selected factory release");
	}
	if (manifest.topology !== definition.topology || manifest.pane_manifest.length !== definition.agents.length) {
		throw new Error("Run topology differs from the retained version");
	}
	const roster = new Map(manifest.pane_manifest.map(entry => [entry.node_id, entry]));
	const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry.node_id]));
	if (roster.size !== definition.agents.length || byInstance.size !== definition.agents.length) {
		throw new Error("Run roster contains duplicate node or instance identifiers");
	}
	verifyBoundReviewPlan(definition, manifest.review_plan, manifest.pane_manifest);
	for (const entry of definition.agents) {
		const node = entry.node;
		const launched = roster.get(node.node_id);
		const inbound = inboundEdgesOf(node);
		if (!launched || (launched.kind ?? "agent") !== (node.kind ?? "agent") ||
			JSON.stringify(inboundEdgesOf(launched).map(id => byInstance.get(id))) !== JSON.stringify(inbound)) {
			throw new Error("Run roster differs from the retained version");
		}
	}
	return roster;
}

function assertSafeAttemptKey(attemptId: string, label: string): void {
	if (!/^[A-Za-z0-9_.-]+$/.test(attemptId) || attemptId.includes("..")) {
		throw new Error(`Refusing unsafe ${label} key`);
	}
}

function verifyRegularHandoffFiles(
	dir: string,
	destKey: string,
	destInstance: string,
	sourceInstance: string,
	sourceKey: string,
	sourceId?: string,
) {
	assertRegularFileIfExists(handoffOfferPath(dir, destKey, sourceId), "handoff offer");
	const edgeClaimPath = handoffClaimPath(dir, destKey, sourceId);
	const hasEdgeClaim = assertRegularFileIfExists(edgeClaimPath, "handoff claim");
	const joinClaimPath = sourceId ? handoffClaimPath(dir, destKey) : undefined;
	const hasJoinClaim = joinClaimPath ? assertRegularFileIfExists(joinClaimPath, "join handoff claim") : false;
	assertRegularFileIfExists(handoffRejectionsPath(dir, destKey, sourceId), "handoff rejections");
	assertRegularFileIfExists(handoffRecoveryPath(dir, destKey, sourceId), "handoff recovery");
	assertRegularFileIfExists(resultPath(dir, sourceInstance), "source result");
	if (sourceKey !== sourceInstance) {
		assertRegularFileIfExists(resultPath(dir, sourceKey), "source result");
	}
	if (destKey !== destInstance) {
		if (hasEdgeClaim) {
			const claim = readRegularJsonNoSymlink<{ source?: { attempt_id?: unknown } }>(edgeClaimPath, "handoff claim");
			const attempt = claim?.source?.attempt_id;
			if (typeof attempt === "string" && attempt.length > 0) {
				assertSafeAttemptKey(attempt, "source result");
				assertRegularFileIfExists(resultPath(dir, attempt), "source result");
			}
		}
		if (hasJoinClaim && joinClaimPath) {
			const joinClaim = readRegularJsonNoSymlink<{ sources?: Array<{ instance_id?: unknown; attempt_id?: unknown }> }>(joinClaimPath, "join handoff claim");
			const joinSrc = Array.isArray(joinClaim?.sources)
				? joinClaim.sources.find(s => s && s.instance_id === sourceInstance)
				: undefined;
			const attempt = joinSrc?.attempt_id;
			if (typeof attempt === "string" && attempt.length > 0) {
				assertSafeAttemptKey(attempt, "source result");
				assertRegularFileIfExists(resultPath(dir, attempt), "source result");
			}
		}
	}
}

export interface ResolvedNodeObservation {
	attempt_id?: string;
	attempt_number: number;
	attempt_number_unverified?: boolean;
	max_attempts: number;
	instance_id: string;
	key: string;
	expected?: CompletionExpectation;
	has_result: boolean;
	has_disposition: boolean;
	result_record?: WorkerCompletion;
	disposition_record?: Disposition;
	error_message?: string;
	error_source?: "file" | "launch";
	cancel_reason?: string;
	claim_outcome?: "completed" | "cancelled";
	in_progress?: boolean;
	corrupt_or_unverified?: boolean;
	handoff_error?: boolean;
	upstream_closed?: boolean;
	evidence_problem?: string;
	status: ExecutionState;
	status_text: string;
	attempt_status: ExecutionState;
	attempt_status_text: string;
	reason?: string;
	raw_reason?: string;
	causes?: ProjectedCause[];
	raw_causes?: ProjectedCause[];
	parked?: boolean;
	finalized?: boolean;
	last_verdict?: string;
	resource_state: AgentLaunch["status"];
	process_state: "alive" | "exited" | "not_started" | "unknown";
	started_at?: string;
	updated_at?: string;
	completed_at?: string;
	waiting_for_human_since?: string;
	result_status?: "success" | "partial" | "failure";
	summary?: string;
	command?: { exit_code: number | null; signal: NodeJS.Signals | null; duration_ms: number };
	waiting_on?: string[];
	loop?: ReviewLoop;
	review_rejected_closure?: ReturnType<typeof blockedReviewForwardEdge>;
	source_instance?: string;
}

export interface ResolveRunObservationsOptions {
	enforceNodeRecordSizeLimit?: boolean;
	enforceSizeLimitNodeId?: string;
	skipLoopResultPrecheckNodeId?: string;
}

interface SharedNodeContext {
	manifest: BootstrapManifest;
	entry: AgentLaunch;
	byInstanceNodeId: ReadonlyMap<string, string>;
	blockedPaths: readonly string[];
	recordMaxBytes: number;
	loop?: ReturnType<typeof reviewLoopFor>;
	maxAttempts: number;
	latestAttemptNum: number;
	latestAttemptId?: string;
	latestSourceInstance?: string;
	finalization?: ReturnType<typeof readFinalization>;
	processState: ResolvedNodeObservation["process_state"];
	readyAlive: boolean;
	runCancelRecord?: ReturnType<typeof readRunCancelRecordSafe>["record"];
	matchingProgress?: ProgressSnapshot;
	startedAt?: string;
	updatedAt?: string;
	waitingForHumanSince?: string;
}

/**
 * Resolve one attempt `targetAttemptNum` of a node from shared node context, independently catching
 * file/identity/format errors so one damaged attempt never hides or blocks other attempts.
 */
function resolveSingleAttemptFromContext(
	ctx: SharedNodeContext,
	targetAttemptNum: number,
): ResolvedNodeObservation {
	const {
		manifest,
		entry,
		byInstanceNodeId,
		blockedPaths,
		recordMaxBytes,
		loop,
		maxAttempts,
		latestAttemptNum,
		latestSourceInstance,
		finalization,
		processState,
		readyAlive,
		runCancelRecord,
		matchingProgress,
		startedAt,
		updatedAt,
		waitingForHumanSince,
	} = ctx;
	const { session_dir: dir, task_id, review_plan } = manifest;
	const isLatest = targetAttemptNum === latestAttemptNum;
	const inbound = inboundEdgesOf(entry);
	const sourceInstance = isLatest
		? latestSourceInstance
		: (loop && entry.instance_id === loop.target && targetAttemptNum >= 2
			? loop.reviewer
			: (inbound.length === 1 ? inbound[0] : undefined));
	const hasScopedAttempts = Boolean(review_plan && !manifest.session_dir_removed);
	const attemptId = hasScopedAttempts || targetAttemptNum > 1
		? `${entry.instance_id}.${targetAttemptNum}`
		: entry.attempt_id;
	const key = review_plan && (hasScopedAttempts || finalization || targetAttemptNum > 1)
		? (attemptId ?? entry.instance_id)
		: entry.instance_id;
	const expected: CompletionExpectation = { ...expectationFor(manifest, entry), attempt_id: attemptId };

	try {
		const resFile = resultPath(dir, key);
		const dispFile = dispositionPath(dir, key);
		const claimFile = outcomeClaimPath(dir, key);
		assertPathInsideDir(dir, resFile, "node result");
		assertPathInsideDir(dir, dispFile, "node disposition");
		assertPathInsideDir(dir, claimFile, "outcome claim");
		assertRegularFileIfExists(claimFile, "outcome claim", MAX_EVIDENCE_FILE_BYTES);

		const hasResult = pathEntryExists(resFile);
		const hasDisposition = pathEntryExists(dispFile);
		if (hasResult && hasDisposition) {
			throw new Error("Contradictory result records");
		}

		const identity = {
			run_id: task_id,
			node_id: entry.node_id,
			persona_name: entry.persona_name,
			instance_id: entry.instance_id,
			...(attemptId ? { attempt_id: attemptId } : {}),
		};
		const cancelInfo = readCancelRecordSafe(dir, identity);
		const claimInfo = readOutcomeClaimSafe(dir, identity, key);
		if (cancelInfo.error || claimInfo.error) {
			throw new Error(cancelInfo.error ?? claimInfo.error);
		}

		if (hasDisposition) {
			const dispRead = readBoundedRegularJsonIfExists<unknown>(dir, dispFile, "node disposition", recordMaxBytes);
			if (!dispRead.exists) {
				throw new Error("Disposition record could not be read");
			}
			const disp = parseDisposition(dispRead.value, expected);
			const command = projectCommandOutcome(disp.command_evidence, blockedPaths);
			const rawCauses = projectCauses(disp.causes);
			const causes = projectCauses(disp.causes, blockedPaths);
			const recordedAt = validateIsoTimestamp(disp.recorded_at);
			const closedEdge = isLatest && loop
				? blockedReviewForwardEdge(loop, finalization, entry.node_id, {
					state: disp.state,
					causes: disp.causes,
					reason: disp.reason,
				})
				: undefined;
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: true,
				disposition_record: disp,
				status: disp.state,
				status_text: STATUS_TEXT[disp.state],
				attempt_status: disp.state,
				attempt_status_text: STATUS_TEXT[disp.state],
				reason: disp.reason ? sanitizeOperatorText(disp.reason, 1000, blockedPaths) : "The node has a recorded execution disposition.",
				...(causes ? { causes } : {}),
				...(rawCauses ? { raw_causes: rawCauses } : {}),
				...(isLatest && finalization ? { finalized: true } : {}),
				...(disp.state === "needs_attention" ? { evidence_problem: "Attempt ended with unresolved evidence and no recorded result." } : {}),
				resource_state: entry.status,
				process_state: isLatest ? processState : "exited",
				...(isLatest && startedAt ? { started_at: startedAt } : {}),
				...(isLatest && updatedAt ? { updated_at: updatedAt } : {}),
				...(recordedAt ? { completed_at: recordedAt } : {}),
				...(command ? { command } : {}),
				...(loop ? { loop } : {}),
				...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
				source_instance: sourceInstance,
			};
		}

		if (hasResult) {
			const resRead = readBoundedRegularJsonIfExists<unknown>(dir, resFile, "node result", recordMaxBytes);
			if (!resRead.exists) {
				throw new Error("Result record could not be read");
			}
			const record = parseCompletion(resRead.value, expected);
			const artifactMatcher = compileArtifactRedactionMatcher(
				collectArtifactPathTokens(record.result.artifacts, manifest.project_cwd),
			);
			const scrubbedSummary = record.result.summary
				? sanitizeOperatorText(record.result.summary, 1000, blockedPaths, artifactMatcher)
				: undefined;
			const scrubbedResult = scrubbedSummary !== undefined
				? { ...record.result, summary: scrubbedSummary }
				: record.result;
			const command = projectCommandOutcome(record.result.command_evidence, blockedPaths);
			const completedAt = validateIsoTimestamp(record.completed_at);
			const baseState = executionFromResult(record.result.status).state;
			const rejection = isLatest && loop && finalization
				? finalizedReviewRejection(loop, finalization, entry.node_id, scrubbedResult)
				: undefined;
			const attemptStatus = rejection ? rejection.state : baseState;
			const attemptStatusText = STATUS_TEXT[attemptStatus];
			const rawLastVerdict = loop && loop.reviewer === entry.instance_id && record.result.status === "success"
				? (typeof record.result.outputs?.[loop.field] === "string" ? String(record.result.outputs[loop.field]) : undefined)
				: undefined;
			const lastVerdict = rawLastVerdict ? sanitizeOperatorText(rawLastVerdict, 128, blockedPaths) : undefined;

			const baseFields = {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: true,
				has_disposition: false,
				result_record: record,
				resource_state: entry.status,
				process_state: isLatest ? processState : ("exited" as const),
				...(isLatest && startedAt ? { started_at: startedAt } : {}),
				...(isLatest && updatedAt ? { updated_at: updatedAt } : {}),
				...(completedAt ? { completed_at: completedAt } : {}),
				result_status: record.result.status,
				...(scrubbedSummary ? { summary: scrubbedSummary } : {}),
				...(command ? { command } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};

			if (isLatest && loop && !finalization) {
				return {
					...baseFields,
					status: "waiting",
					status_text: "Waiting (parked)",
					attempt_status: attemptStatus,
					attempt_status_text: attemptStatusText,
					parked: true,
					finalized: false,
					...(lastVerdict ? { last_verdict: lastVerdict } : {}),
					reason: "An attempt result is recorded; the review loop has not finalized this node.",
				};
			}
			if (isLatest && loop && finalization) {
				const closedEdge = blockedReviewForwardEdge(
					loop,
					finalization,
					entry.node_id,
					{ ...executionFromResult(record.result.status), reason: scrubbedSummary ?? "" },
					scrubbedResult,
				);
				if (rejection) {
					return {
						...baseFields,
						status: rejection.state,
						status_text: STATUS_TEXT[rejection.state],
						attempt_status: rejection.state,
						attempt_status_text: STATUS_TEXT[rejection.state],
						reason: rejection.reason,
						finalized: true,
						...(lastVerdict ? { last_verdict: lastVerdict } : {}),
						...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
					};
				}
				return {
					...baseFields,
					status: baseState,
					status_text: STATUS_TEXT[baseState],
					attempt_status: baseState,
					attempt_status_text: STATUS_TEXT[baseState],
					...(baseState === "failed" || baseState === "partial" ? { reason: scrubbedSummary ?? "" } : {}),
					finalized: true,
					...(lastVerdict ? { last_verdict: lastVerdict } : {}),
					...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
				};
			}
			return {
				...baseFields,
				status: baseState,
				status_text: STATUS_TEXT[baseState],
				attempt_status: baseState,
				attempt_status_text: STATUS_TEXT[baseState],
				...(baseState === "failed" || baseState === "partial" ? { reason: scrubbedSummary ?? "" } : {}),
				...(lastVerdict && isLatest ? { last_verdict: lastVerdict } : {}),
			};
		}

		const scopedErrorFile = join(dir, `${key}.error.json`);
		const errorFile = review_plan && !pathEntryExists(scopedErrorFile) && targetAttemptNum === 1
			? join(dir, `${entry.instance_id}.error.json`)
			: scopedErrorFile;
		assertPathInsideDir(dir, errorFile, "node error");
		if (pathEntryExists(errorFile)) {
			const errRead = readBoundedRegularJsonIfExists<{ error?: unknown }>(dir, errorFile, "node error", recordMaxBytes);
			const rawErrorMsg = errRead.exists && typeof errRead.value?.error === "string" && errRead.value.error.trim()
				? errRead.value.error
				: undefined;
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				...(rawErrorMsg ? { error_message: rawErrorMsg } : {}),
				error_source: "file",
				evidence_problem: "The attempt recorded an execution error without a verified result.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "The node recorded an execution error without a verified outcome.",
				resource_state: entry.status,
				process_state: isLatest ? processState : "exited",
				...(isLatest && startedAt ? { started_at: startedAt } : {}),
				...(isLatest && updatedAt ? { updated_at: updatedAt } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}
		if (isLatest && entry.error) {
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				error_message: entry.error,
				error_source: "launch",
				evidence_problem: "The attempt launch recorded an error without a verified result.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "The node launch recorded an error without a verified outcome.",
				resource_state: entry.status,
				process_state: processState,
				...(startedAt ? { started_at: startedAt } : {}),
				...(updatedAt ? { updated_at: updatedAt } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}

		const claimOutcome = claimInfo.claim?.outcome;
		const matchingNodeCancel = cancelInfo.record && (!review_plan || !cancelInfo.record.identity.attempt_id || cancelInfo.record.identity.attempt_id === attemptId)
			? cancelInfo.record
			: undefined;
		const activeCancel = matchingNodeCancel ?? (claimOutcome === "completed" ? undefined : runCancelRecord);
		if (activeCancel) {
			if (isLatest && matchingProgress?.state === "working" && readyAlive && entry.status !== "closed") {
				return {
					attempt_id: attemptId,
					attempt_number: targetAttemptNum,
					max_attempts: maxAttempts,
					instance_id: entry.instance_id,
					key,
					expected,
					has_result: false,
					has_disposition: false,
					...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
					in_progress: true,
					status: "running",
					status_text: "Running (cancelling)",
					attempt_status: "running",
					attempt_status_text: "Running (cancelling)",
					reason: "Cancellation requested; waiting for in-progress work to stop.",
					resource_state: entry.status,
					process_state: processState,
					...(startedAt ? { started_at: startedAt } : {}),
					...(updatedAt ? { updated_at: updatedAt } : {}),
					...(loop ? { loop } : {}),
					source_instance: sourceInstance,
				};
			}
			const cancelReason = activeCancel.reason || "Cancelled.";
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
				cancel_reason: cancelReason,
				status: "cancelled",
				status_text: "Cancelled",
				attempt_status: "cancelled",
				attempt_status_text: "Cancelled",
				reason: sanitizeOperatorText(cancelReason, 1000, blockedPaths),
				resource_state: entry.status,
				process_state: isLatest ? processState : "exited",
				...(isLatest && startedAt ? { started_at: startedAt } : {}),
				...(isLatest && updatedAt ? { updated_at: updatedAt } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}

		if (!isLatest) {
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
				evidence_problem: claimOutcome === "completed"
					? "The attempt recorded completion without a readable result record."
					: "The attempt ended before a verified result record was saved.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "The worker exited without a verified result.",
				resource_state: entry.status,
				process_state: "exited",
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}

		if (processState === "exited") {
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
				evidence_problem: "The attempt ended before a verified result record was saved.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "The worker exited without a verified result.",
				resource_state: entry.status,
				process_state: processState,
				...(startedAt ? { started_at: startedAt } : {}),
				...(updatedAt ? { updated_at: updatedAt } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}

		if (entry.status === "closed") {
			return {
				attempt_id: attemptId,
				attempt_number: targetAttemptNum,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key,
				expected,
				has_result: false,
				has_disposition: false,
				...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
				evidence_problem: "The attempt ended before a verified result record was saved.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "The node's resource closed before an outcome was recorded.",
				resource_state: entry.status,
				process_state: processState,
				...(startedAt ? { started_at: startedAt } : {}),
				...(updatedAt ? { updated_at: updatedAt } : {}),
				...(loop ? { loop } : {}),
				source_instance: sourceInstance,
			};
		}

		if (readyAlive && matchingProgress) {
			if (matchingProgress.state === "working") {
				if (waitingForHumanSince !== undefined) {
					return {
						attempt_id: attemptId,
						attempt_number: targetAttemptNum,
						max_attempts: maxAttempts,
						instance_id: entry.instance_id,
						key,
						expected,
						has_result: false,
						has_disposition: false,
						...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
						in_progress: true,
						status: "waiting",
						status_text: "Waiting",
						attempt_status: "waiting",
						attempt_status_text: "Waiting",
						reason: "The node is waiting for human direction.",
						waiting_on: ["human_direction"],
						waiting_for_human_since: waitingForHumanSince,
						resource_state: entry.status,
						process_state: processState,
						...(startedAt ? { started_at: startedAt } : {}),
						...(updatedAt ? { updated_at: updatedAt } : {}),
						...(loop ? { loop } : {}),
						source_instance: sourceInstance,
					};
				}
				return {
					attempt_id: attemptId,
					attempt_number: targetAttemptNum,
					max_attempts: maxAttempts,
					instance_id: entry.instance_id,
					key,
					expected,
					has_result: false,
					has_disposition: false,
					...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
					in_progress: true,
					status: "running",
					status_text: "Running",
					attempt_status: "running",
					attempt_status_text: "Running",
					resource_state: entry.status,
					process_state: processState,
					...(startedAt ? { started_at: startedAt } : {}),
					...(updatedAt ? { updated_at: updatedAt } : {}),
					...(loop ? { loop } : {}),
					source_instance: sourceInstance,
				};
			}
			if (matchingProgress.state === "waiting") {
				const inboundNodes = inboundEdgesOf(entry).map(id => byInstanceNodeId.get(id) ?? id);
				const waitingOn = inboundNodes.length ? inboundNodes : (entry.ownership_wait_for?.map(id => byInstanceNodeId.get(id) ?? id) ?? []);
				let reason = "The node is waiting before starting execution.";
				if (inboundNodes.length > 0) {
					reason = `Waiting for inbound dependency (${inboundNodes.join(", ")}) to complete and deliver handoff.`;
				} else if (entry.ownership_wait_for?.length) {
					reason = `Waiting for workspace path ownership release (${waitingOn.join(", ")}).`;
				}
				return {
					attempt_id: attemptId,
					attempt_number: targetAttemptNum,
					max_attempts: maxAttempts,
					instance_id: entry.instance_id,
					key,
					expected,
					has_result: false,
					has_disposition: false,
					...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
					in_progress: true,
					status: "waiting",
					status_text: "Waiting",
					attempt_status: "waiting",
					attempt_status_text: "Waiting",
					reason,
					...(waitingOn.length ? { waiting_on: waitingOn } : {}),
					resource_state: entry.status,
					process_state: processState,
					...(startedAt ? { started_at: startedAt } : {}),
					...(updatedAt ? { updated_at: updatedAt } : {}),
					...(loop ? { loop } : {}),
					source_instance: sourceInstance,
				};
			}
		}

		return {
			attempt_id: attemptId,
			attempt_number: targetAttemptNum,
			max_attempts: maxAttempts,
			instance_id: entry.instance_id,
			key,
			expected,
			has_result: false,
			has_disposition: false,
			...(claimOutcome ? { claim_outcome: claimOutcome } : {}),
			in_progress: true,
			status: "pending",
			status_text: "Pending",
			attempt_status: "pending",
			attempt_status_text: "Pending",
			reason: "No verified execution or terminal record is available yet.",
			resource_state: entry.status,
			process_state: processState,
			...(startedAt ? { started_at: startedAt } : {}),
			...(updatedAt ? { updated_at: updatedAt } : {}),
			...(loop ? { loop } : {}),
			source_instance: sourceInstance,
		};
	} catch {
		return {
			attempt_id: attemptId,
			attempt_number: targetAttemptNum,
			max_attempts: maxAttempts,
			instance_id: entry.instance_id,
			key,
			expected,
			has_result: false,
			has_disposition: false,
			corrupt_or_unverified: true,
			evidence_problem: "Attempt output evidence is unavailable because the result record is missing, damaged, unreadable, or fails verification.",
			status: "needs_attention",
			status_text: "Uncertain",
			attempt_status: "needs_attention",
			attempt_status_text: "Uncertain",
			reason: "Node evidence is missing, damaged or contradictory.",
			resource_state: entry.status,
			process_state: "unknown",
			...(loop ? { loop } : {}),
		};
	}
}

interface PartialResolvedTracker {
	attemptNum: number;
	attemptId?: string;
	key: string;
	expected?: CompletionExpectation;
}

function resolveSharedNodeContext(
	manifest: BootstrapManifest,
	entry: AgentLaunch,
	byInstanceNodeId: ReadonlyMap<string, string>,
	blockedPaths: readonly string[],
	options: ResolveRunObservationsOptions,
	tracker?: PartialResolvedTracker,
): SharedNodeContext {
	const { session_dir: dir, task_id, review_plan } = manifest;
	const enforceNodeRecordSizeLimit = Boolean(
		options.enforceNodeRecordSizeLimit || options.enforceSizeLimitNodeId === entry.node_id,
	);
	const recordMaxBytes = enforceNodeRecordSizeLimit ? MAX_EVIDENCE_FILE_BYTES : Number.POSITIVE_INFINITY;
	const loop = reviewLoopFor(review_plan, entry.instance_id);
	const maxAttempts = loop ? loop.max_revisions + 1 : 1;
	const skipLoopResultPrecheck = options.skipLoopResultPrecheckNodeId === entry.node_id;

	assertRegularDirNoSymlink(dir, "session directory");
	if (loop) {
		assertPathInsideDir(dir, finalizePath(dir, entry.instance_id), "finalization record");
		assertRegularFileIfExists(finalizePath(dir, entry.instance_id), "finalization record", MAX_EVIDENCE_FILE_BYTES);
		assertPathInsideDir(dir, finalizePath(dir, loop.reviewer), "reviewer finalization record");
		assertRegularFileIfExists(finalizePath(dir, loop.reviewer), "reviewer finalization record", MAX_EVIDENCE_FILE_BYTES);
		for (let n = 1; n <= maxAttempts; n++) {
			const keyN = `${entry.instance_id}.${n}`;
			const coordChecks: Array<readonly [string, string]> = [
				[join(dir, `${keyN}.transition.json`), "loop transition"],
				[join(dir, `${loop.reviewer}.${n}.revision.json`), "revision reservation"],
			];
			if (!skipLoopResultPrecheck) {
				coordChecks.push(
					[resultPath(dir, keyN), "loop result"],
					[dispositionPath(dir, keyN), "loop disposition"],
					[join(dir, `${keyN}.error.json`), "loop error"],
				);
			}
			for (const [p, lbl] of coordChecks) {
				assertPathInsideDir(dir, p, lbl);
				assertRegularFileIfExists(p, lbl, MAX_EVIDENCE_FILE_BYTES);
			}
			for (const src of inboundEdgesOf(entry)) {
				const claimP = handoffClaimPath(dir, keyN, src);
				assertPathInsideDir(dir, claimP, "revision handoff claim");
				assertRegularFileIfExists(claimP, "revision handoff claim", MAX_EVIDENCE_FILE_BYTES);
			}
			if (loop.target === entry.instance_id) {
				const fbClaimP = handoffClaimPath(dir, keyN, loop.reviewer);
				assertPathInsideDir(dir, fbClaimP, "feedback handoff claim");
				assertRegularFileIfExists(fbClaimP, "feedback handoff claim", MAX_EVIDENCE_FILE_BYTES);
			}
		}
	}

	let attempt = currentAttempt(manifest, entry);
	const finalization = loop && readFinalization(dir, task_id, loop, entry.instance_id, manifest.topology, manifest.version);
	if (finalization && attempt && attemptNumber(finalization.attempt_id) < attempt.number) {
		attempt = { ...attempt, number: attemptNumber(finalization.attempt_id) };
	}
	const attemptNum = attempt?.number ?? 1;
	const attemptId = attempt ? `${entry.instance_id}.${attempt.number}` : entry.attempt_id;
	if (tracker) {
		tracker.attemptNum = attemptNum;
		tracker.attemptId = attemptId;
	}
	if (finalization && attemptId && finalization.attempt_id !== attemptId) {
		throw new Error("Finalization does not match the latest attempt");
	}
	if (tracker) {
		tracker.key = review_plan && (attempt || finalization) ? (attemptId ?? entry.instance_id) : entry.instance_id;
		tracker.expected = { ...expectationFor(manifest, entry), attempt_id: attemptId };
	}

	const readyFile = readyPath(dir, entry.instance_id);
	const progressFile = join(dir, `${entry.instance_id}.progress.json`);
	const cancelFile = cancelPath(dir, entry.instance_id);
	const runCancelFile = runCancelPath(dir);
	const ffFile = failFastPath(dir);
	assertPathInsideDir(dir, cancelFile, "cancel record");
	assertPathInsideDir(dir, runCancelFile, "run cancel record");
	assertPathInsideDir(dir, ffFile, "fail-fast record");
	assertRegularFileIfExists(cancelFile, "cancel record", MAX_EVIDENCE_FILE_BYTES);
	assertRegularFileIfExists(runCancelFile, "run cancel record", MAX_EVIDENCE_FILE_BYTES);
	assertRegularFileIfExists(ffFile, "fail-fast record", MAX_EVIDENCE_FILE_BYTES);

	const readyRead = readBoundedRegularJsonIfExists<unknown>(dir, readyFile, "worker readiness", recordMaxBytes);
	let processState: ResolvedNodeObservation["process_state"] = "not_started";
	let readyAlive = false;
	if (readyRead.exists) {
		const ready = parseWorkerReady(readyRead.value);
		if (ready.token !== manifest.token || ready.task_id !== task_id || ready.instance_id !== entry.instance_id) {
			throw new Error("Foreign readiness");
		}
		readyAlive = processAlive(ready);
		processState = readyAlive ? "alive" : "exited";
	}

	const runCancelInfo = readRunCancelRecordSafe(dir, task_id);
	const failFastInfo = readFailFast(dir, task_id, manifest.token);
	if (runCancelInfo.error || failFastInfo.error) {
		throw new Error(runCancelInfo.error ?? failFastInfo.error);
	}

	const progressRead = readBoundedRegularJsonIfExists<ProgressSnapshot>(dir, progressFile, "node progress", recordMaxBytes);
	let matchingProgress: ProgressSnapshot | undefined;
	if (progressRead.exists) {
		const progress = progressRead.value;
		if (progress.token !== manifest.token) throw new Error("Foreign progress");
		if (progress.attempt_id !== undefined && progress.attempt_id !== attemptId) {
			if (!(review_plan && progress.state === "completed" && progress.attempt_id.startsWith(`${entry.instance_id}.`))) {
				throw new Error("Progress attempt mismatch");
			}
		} else if (review_plan && progress.attempt_id === undefined) {
			throw new Error("Missing review progress attempt");
		} else {
			matchingProgress = progress;
		}
	}
	const startedAt = matchingProgress && Number.isFinite(matchingProgress.started_at) ? new Date(matchingProgress.started_at!).toISOString() : undefined;
	const updatedAt = matchingProgress && Number.isFinite(matchingProgress.updated_at) ? new Date(matchingProgress.updated_at).toISOString() : undefined;
	const waitingForHumanSince = matchingProgress && Number.isFinite(matchingProgress.waiting_for_human_since)
		? new Date(matchingProgress.waiting_for_human_since!).toISOString()
		: undefined;

	return {
		manifest,
		entry,
		byInstanceNodeId,
		blockedPaths,
		recordMaxBytes,
		loop,
		maxAttempts,
		latestAttemptNum: attemptNum,
		latestAttemptId: attemptId,
		latestSourceInstance: attempt?.source,
		finalization,
		processState,
		readyAlive,
		runCancelRecord: runCancelInfo.record,
		matchingProgress,
		startedAt,
		updatedAt,
		waitingForHumanSince,
	};
}

function resolveNodeObservationWithContext(
	manifest: BootstrapManifest,
	entry: AgentLaunch,
	byInstanceNodeId: ReadonlyMap<string, string>,
	blockedPaths: readonly string[],
	options: ResolveRunObservationsOptions = {},
): { observation: ResolvedNodeObservation; context?: SharedNodeContext } {
	const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
	const maxAttempts = loop ? loop.max_revisions + 1 : 1;
	const tracker: PartialResolvedTracker = {
		attemptNum: 1,
		attemptId: entry.attempt_id,
		key: entry.instance_id,
	};
	try {
		const ctx = resolveSharedNodeContext(manifest, entry, byInstanceNodeId, blockedPaths, options, tracker);
		return {
			observation: resolveSingleAttemptFromContext(ctx, ctx.latestAttemptNum),
			context: ctx,
		};
	} catch {
		return {
			observation: {
				attempt_id: tracker.attemptId,
				attempt_number: tracker.attemptNum,
				attempt_number_unverified: true,
				max_attempts: maxAttempts,
				instance_id: entry.instance_id,
				key: tracker.key,
				...(tracker.expected ? { expected: tracker.expected } : {}),
				has_result: false,
				has_disposition: false,
				corrupt_or_unverified: true,
				evidence_problem: "Attempt output evidence is unavailable because the result record is missing, damaged, unreadable, or fails verification.",
				status: "needs_attention",
				status_text: "Uncertain",
				attempt_status: "needs_attention",
				attempt_status_text: "Uncertain",
				reason: "Node evidence is missing, damaged or contradictory.",
				resource_state: entry.status,
				process_state: "unknown",
				...(loop ? { loop } : {}),
			},
		};
	}
}

/** Resolve one node's latest attempt, expected identity, durable records, and derived status without mutating state. */
export function resolveNodeObservation(
	manifest: BootstrapManifest,
	entry: AgentLaunch,
	byInstanceNodeId: ReadonlyMap<string, string>,
	blockedPaths: readonly string[],
	options: ResolveRunObservationsOptions = {},
): ResolvedNodeObservation {
	return resolveNodeObservationWithContext(manifest, entry, byInstanceNodeId, blockedPaths, options).observation;
}

/**
 * Resolve up to `maxReturnedAttempts` attempts of one node, newest first, independently typing each
 * attempt while preserving the graph-aligned latest attempt observation at index 0.
 */
export function resolveNodeAttempts(
	manifest: BootstrapManifest,
	entry: AgentLaunch,
	byInstanceNodeId: ReadonlyMap<string, string>,
	blockedPaths: readonly string[],
	latestObservation: ResolvedNodeObservation,
	maxReturnedAttempts = 20,
	preResolvedContext?: { resolved: true; context: SharedNodeContext | undefined },
): { attempts: ResolvedNodeObservation[]; totalAttempts: number; totalAttemptsExact: boolean; omittedAttempts: number } {
	const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
	const maxAttempts = loop ? loop.max_revisions + 1 : 1;
	if (!loop || maxAttempts <= 1) {
		const exact = !latestObservation.attempt_number_unverified;
		return {
			attempts: [latestObservation],
			totalAttempts: exact ? 1 : 0,
			totalAttemptsExact: exact,
			omittedAttempts: 0,
		};
	}

	let ctx: SharedNodeContext | undefined;
	if (preResolvedContext?.resolved) {
		ctx = preResolvedContext.context;
	} else {
		try {
			ctx = resolveSharedNodeContext(manifest, entry, byInstanceNodeId, blockedPaths, {
				enforceNodeRecordSizeLimit: true,
				skipLoopResultPrecheckNodeId: entry.node_id,
			});
		} catch {
			ctx = undefined;
		}
	}

	if (!ctx) {
		// Shared node context failed (e.g. corrupt handoff claim, finalization, readiness, or progress on the latest attempt).
		// Probe 1..maxAttempts safely and list EVERY existing attempt under its own number alongside the unverified latest
		// observation at index 0, without letting index 0 stand in for highestExisting or reporting total_attempts as exact.
		const unverifiedLatest: ResolvedNodeObservation = latestObservation.attempt_number_unverified
			? latestObservation
			: { ...latestObservation, attempt_number_unverified: true };
		const fallbackCtx: SharedNodeContext = {
			manifest,
			entry,
			byInstanceNodeId,
			blockedPaths,
			recordMaxBytes: MAX_EVIDENCE_FILE_BYTES,
			loop,
			maxAttempts,
			latestAttemptNum: maxAttempts + 1,
			processState: "exited",
			readyAlive: false,
		};
		const dir = manifest.session_dir;
		const existingAttempts: number[] = [];
		try {
			assertRegularDirNoSymlink(dir, "session directory");
			for (let n = 1; n <= maxAttempts; n++) {
				const keyN = `${entry.instance_id}.${n}`;
				const candidatePaths = [
					resultPath(dir, keyN),
					dispositionPath(dir, keyN),
					join(dir, `${keyN}.error.json`),
					outcomeClaimPath(dir, keyN),
					...(n === 1 ? [join(dir, `${entry.instance_id}.error.json`)] : []),
				];
				const hasAny = candidatePaths.some(p => {
					try {
						assertPathInsideDir(dir, p, "attempt record");
						return pathEntryExists(p);
					} catch {
						return false;
					}
				});
				if (hasAny) {
					existingAttempts.push(n);
				}
			}
		} catch {
			return { attempts: [unverifiedLatest], totalAttempts: 0, totalAttemptsExact: false, omittedAttempts: 0 };
		}
		if (existingAttempts.length === 0) {
			return { attempts: [unverifiedLatest], totalAttempts: 0, totalAttemptsExact: false, omittedAttempts: 0 };
		}
		const olderNums = existingAttempts
			.sort((a, b) => b - a)
			.slice(0, Math.max(0, maxReturnedAttempts - 1));
		const olderObs = olderNums.map(n => resolveSingleAttemptFromContext(fallbackCtx, n));
		const attempts = [unverifiedLatest, ...olderObs].slice(0, maxReturnedAttempts);
		return {
			attempts,
			totalAttempts: existingAttempts.length,
			totalAttemptsExact: false,
			omittedAttempts: Math.max(0, existingAttempts.length - olderNums.length),
		};
	}

	const totalAttempts = ctx.latestAttemptNum;
	const stopAt = Math.max(1, totalAttempts - maxReturnedAttempts + 1);
	const attempts: ResolvedNodeObservation[] = [latestObservation];
	for (let n = totalAttempts - 1; n >= stopAt; n--) {
		attempts.push(resolveSingleAttemptFromContext(ctx, n));
	}
	return {
		attempts,
		totalAttempts,
		totalAttemptsExact: true,
		omittedAttempts: Math.max(0, totalAttempts - attempts.length),
	};
}

export function resolveRunObservations(
	factoryId: string,
	release: ReleasedFactoryRun,
	blockedPaths: readonly string[],
	options: ResolveRunObservationsOptions = {},
) {
	const roster = verifyReleaseMatchesDefinition(factoryId, release);
	const { definition, manifest, bound_version } = release;
	const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry.node_id]));
	const runBlockedPaths = [
		...blockedPaths,
		manifest.session_dir,
		manifest.project_cwd,
		...(manifest.factory_managed?.canonical_checkout ? [manifest.factory_managed.canonical_checkout] : []),
	];
	const observations = new Map<string, ResolvedNodeObservation>();
	const contexts = new Map<string, SharedNodeContext | undefined>();
	for (const entry of definition.agents) {
		const launched = roster.get(entry.node.node_id)!;
		const res = resolveNodeObservationWithContext(manifest, launched, byInstance, runBlockedPaths, options);
		observations.set(entry.node.node_id, res.observation);
		contexts.set(entry.node.node_id, res.context);
	}

	const entryByNode = new Map(definition.agents.map(entry => [entry.node.node_id, entry]));
	const orderedNodes: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (nodeId: string) => {
		if (visited.has(nodeId) || visiting.has(nodeId)) return;
		visiting.add(nodeId);
		const defEntry = entryByNode.get(nodeId);
		if (defEntry) {
			for (const src of inboundEdgesOf(defEntry.node)) visit(src);
		}
		visiting.delete(nodeId);
		visited.add(nodeId);
		orderedNodes.push(nodeId);
	};
	for (const entry of definition.agents) visit(entry.node.node_id);

	const depEdges: DependencyEdgeObservation[] = [];
	for (const nodeId of orderedNodes) {
		const entry = entryByNode.get(nodeId)!;
		const node = entry.node;
		const obs = observations.get(nodeId)!;
		const launched = roster.get(nodeId)!;
		const inbound = inboundEdgesOf(node);
		const sourceScope = (srcInst: string) => (manifest.topology === "graph" || manifest.review_plan ? srcInst : undefined);
		for (const srcNode of inbound) {
			const srcLaunched = roster.get(srcNode)!;
			const srcObs = observations.get(srcNode)!;
			const edgePolicy = inbound.length > 1
				? effectiveDependencyPolicy(node.join_policy ?? "all_success", node.dependency_policy)
				: (node.dependency_policy ?? "allow_partial");
			let handoffClaimed = false;
			let handoffRejectedReason: string | undefined;
			try {
				verifyRegularHandoffFiles(
					manifest.session_dir,
					obs.key,
					launched.instance_id,
					srcLaunched.instance_id,
					srcObs.key,
					sourceScope(srcLaunched.instance_id),
				);
				const view = describeHandoff(manifest.session_dir, srcLaunched.instance_id, obs.key, {
					run_id: manifest.task_id,
					source_instance_id: srcLaunched.instance_id,
					destination: { node_id: node.node_id, instance_id: launched.instance_id, attempt_id: manifest.review_plan ? obs.key : launched.attempt_id },
				}, sourceScope(srcLaunched.instance_id), launched.instance_id);
				if (view?.problems.length) {
					throw new Error(view.problems[0]);
				}
				handoffClaimed = view?.state === "accepted";
				if (view?.rejections.length) {
					handoffRejectedReason = view.rejections.at(-1)?.reason;
				}
			} catch {
				obs.status = "needs_attention";
				obs.status_text = STATUS_TEXT.needs_attention;
				obs.attempt_status = "needs_attention";
				obs.attempt_status_text = STATUS_TEXT.needs_attention;
				obs.parked = false;
				obs.handoff_error = true;
				obs.in_progress = false;
				obs.reason = "Node handoff evidence is missing, damaged or contradictory.";
			}

			const closed = !handoffClaimed ? srcObs.review_rejected_closure : undefined;
			if (closed && (obs.status === "pending" || obs.status === "waiting")) {
				obs.status = "blocked";
				obs.status_text = STATUS_TEXT.blocked;
				obs.attempt_status = "blocked";
				obs.attempt_status_text = STATUS_TEXT.blocked;
				obs.upstream_closed = true;
				obs.in_progress = false;
				obs.raw_reason = closed.reason;
				obs.reason = sanitizeOperatorText(closed.reason, 1000, runBlockedPaths);
				obs.raw_causes = projectCauses(closed.causes);
				obs.causes = projectCauses(closed.causes, runBlockedPaths);
			} else if (!closed && !handoffClaimed && (obs.status === "pending" || obs.status === "waiting")) {
				const adm = decideAdmission({
					policy: edgePolicy,
					predecessor: { node_id: srcNode, execution: { state: srcObs.status, causes: srcObs.causes ?? [], reason: srcObs.reason } },
				});
				if (!adm.admit && adm.outcome === "blocked" && obs.status === "waiting") {
					obs.reason = sanitizeOperatorText(`Waiting for disposition (${adm.reason}).`, 1000, runBlockedPaths);
				} else if (handoffRejectedReason && obs.status === "waiting") {
					obs.reason = sanitizeOperatorText(`Waiting on handoff after rejection from ${srcNode}: ${handoffRejectedReason}`, 1000, runBlockedPaths);
				}
			}

			const sourceExecution: ExecutionState = srcObs.parked ? "waiting" : srcObs.status;
			const edgeState: EdgeState = closed ? "dead" : deriveEdgeState({
				sourceExecution,
				dependencyPolicy: edgePolicy,
				handoffClaimed,
			});
			depEdges.push({
				from: srcNode,
				to: node.node_id,
				kind: "dependency",
				dependency_policy: edgePolicy,
				state: edgeState,
			});
		}
	}

	return { roster, runBlockedPaths, observations, contexts, depEdges, bound_version, manifest, definition };
}
