import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe, type ProgressSnapshot } from "../../bootstrap/cancellation.ts";
import { inspectFactoryReleaseState } from "../../bootstrap/factory-evidence.ts";
import {
	directionProcess,
	requestDecisionEvidence,
	verifyBoundReviewPlan,
	type BoundDirectionDefinition,
	type DirectionRequestView,
	type DirectionRoutingView,
	type StoredRequest,
} from "../../bootstrap/factory-requests.ts";
import { describeHandoff, handoffClaimPath, handoffId, handoffOfferPath, handoffRecoveryPath, handoffRejectionsPath, inputDigest } from "../../bootstrap/handoff.ts";
import { assessRiskLane } from "../../bootstrap/lanes.ts";
import { readFailFast } from "../../bootstrap/ownership.ts";
import {
	attemptKey,
	attemptNumber,
	finalizePath,
	readFinalization,
	reviewLoopFor,
	reviewVerdict,
	revisionCapacity,
	revisionExhaustionReason,
	revisionReserved,
} from "../../bootstrap/review-loop.ts";
import {
	assertNoSymlinkPath,
	assertTaskId,
	dispositionPath,
	expectationFor,
	expectedResultVersion,
	lockHeld,
	outboundEdgesOf,
	parseCompletion,
	parseDisposition,
	parseManifest,
	parseWorkerReady,
	pathEntryExists,
	processAlive,
	readRegularJsonNoSymlink,
	readyPath,
	resultPath,
	type AgentLaunch,
	type BootstrapManifest,
	type Disposition,
	type WorkerCompletion,
	type WorkerReady,
} from "../../bootstrap/session-store.ts";
import { currentAttempt } from "../../bootstrap/handoff.ts";
import type { FactoryDeletionInfo, RequestsListResult } from "../operations.ts";
import { type TypedAbsence } from "./inspect.ts";
import { assertRegularFileIfExists } from "./live.ts";
import { deletionMarkerFields, projectViewerDeletion, sanitizeOperatorText, type ViewerDeletionSummary } from "./sanitize.ts";

export { projectViewerDeletion, sanitizeOperatorText, type ViewerDeletionSummary };

const REQUEST_STATES = new Set(["pending", "responded", "cancelled", "failed", "closed"]);
const CONSUMPTION_STATES = new Set(["not_applicable", "awaiting_consumption", "consumed", "never_consumed", "unknown"]);
const RECONCILIATION_STATES = new Set(["pending", "continuing", "resolved", "cancelled", "failed", "uncertain"]);

const REQUEST_STATE_EXPLANATIONS: Record<string, string> = {
	pending: "Waiting for a human response in Pi.",
	responded: "A human response was recorded for this request.",
	cancelled: "The request was closed because the attempt or run was cancelled.",
	failed: "The request was closed because the attempt or run failed.",
	closed: "The request was closed after the attempt ended.",
	unknown: "Request state is unrecognized or damaged.",
};

const CONSUMPTION_EXPLANATIONS: Record<string, string> = {
	not_applicable: "Response consumption does not apply until a direction response is recorded.",
	awaiting_consumption: "A response is recorded, and the waiting attempt has not durably claimed it yet.",
	consumed: "The waiting attempt durably claimed the recorded response.",
	never_consumed: "A response was recorded, but the attempt terminated before claiming it; it cannot revive a dead attempt.",
	unknown: "Whether the waiting attempt claimed the response could not be verified.",
};

const RECONCILIATION_EXPLANATIONS: Record<string, string> = {
	pending: "Waiting for a human response.",
	continuing: "The waiting attempt claimed the response and delivery was recorded.",
	resolved: "The request and its recorded response or attempt outcome are settled.",
	cancelled: "The original attempt was cancelled.",
	failed: "The original attempt failed.",
	uncertain: "The original requester, response delivery, or downstream routing could not be verified.",
};

function assertRegularDir(dir: string, label: string): void {
	assertNoSymlinkPath(dir);
	if (!pathEntryExists(dir)) {
		throw new Error(`Missing ${label}`);
	}
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`Refusing non-directory ${label}`);
	}
}

function precheckSessionFiles(dir: string, instanceIds?: readonly string[]): void {
	assertRegularDir(dir, "session directory");
	assertRegularFileIfExists(join(dir, "manifest.json"), "run manifest.json");
	const entries = readdirSync(dir);
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		if (instanceIds && !instanceIds.some(id => name === `${id}.json` || name.startsWith(`${id}.`))) {
			continue;
		}
		assertRegularFileIfExists(join(dir, name), `session file ${name}`);
	}
}

function loadSafeDirectionManifest(
	indexRoot: string,
	ids: Pick<StoredRequest, "factory_id" | "input_id" | "attempt_id" | "task_id">,
	cwd: string,
	dbPath: string,
): BootstrapManifest {
	assertTaskId(ids.task_id);
	const expectedSessionDir = join(cwd, ".pi", "agent-sessions", ids.task_id);
	const indexFile = join(indexRoot, `${ids.task_id}.json`);
	const localManifestFile = join(expectedSessionDir, "manifest.json");
	const hasIndex = assertRegularFileIfExists(indexFile, "bootstrap index manifest");
	const manifestPath = hasIndex ? indexFile : localManifestFile;
	if (!hasIndex && !assertRegularFileIfExists(localManifestFile, "run manifest.json")) {
		throw new Error(`No bootstrap session found for task_id "${ids.task_id}".`);
	}
	const parsed = parseManifest(readRegularJsonNoSymlink<unknown>(manifestPath, "bootstrap manifest"), ids.task_id);
	if (!isAbsolute(parsed.project_cwd) || parsed.session_dir !== join(parsed.project_cwd, ".pi", "agent-sessions", ids.task_id)) {
		throw new Error("Session directory does not match the recorded project root");
	}
	const managed = parsed.factory_managed;
	if (
		!managed
		|| managed.factory_id !== ids.factory_id
		|| managed.input_id !== ids.input_id
		|| managed.attempt_id !== ids.attempt_id
		|| managed.state_db_path !== dbPath
	) {
		throw new Error("Run binding does not match the original direction request");
	}
	if (parsed.session_dir_removed) {
		throw new Error("Run evidence is missing");
	}
	assertRegularDir(parsed.session_dir, "bootstrap session directory");
	const check = inspectFactoryReleaseState({
		taskId: ids.task_id,
		token: parsed.token,
		sessionDir: parsed.session_dir,
		sessionDirRemoved: parsed.session_dir_removed,
		primaryMeta: parsed.factory_managed,
		indexRunPath: join(indexRoot, "factory-runs", `${ids.task_id}.json`),
	});
	const observed: BootstrapManifest = {
		...parsed,
		pane_manifest: parsed.pane_manifest.map(entry => ({ ...entry })),
	};
	const lockKey = join(indexRoot, observed.task_id);
	const lockPath = `${lockKey}.lock`;
	const activeLaunch = observed.status === "launching"
		&& pathEntryExists(lockPath)
		&& assertRegularFileIfExists(lockPath, "run lock")
		&& lockHeld(lockKey);
	if (observed.status === "launching") {
		if (!activeLaunch) {
			observed.reconciled = true;
			if (check.kind === "released") {
				for (const entry of observed.pane_manifest) {
					if (entry.status !== "closed") entry.status = "released";
				}
				observed.status = "applied";
				observed.phase = "released";
			} else {
				observed.status = "error";
				observed.phase = check.kind === "held" || check.kind === "historical_non_release" ? "held" : "uncertain";
			}
		}
	} else if (observed.status === "applied") {
		if (check.kind !== "released") {
			observed.status = "error";
			observed.phase = "uncertain";
		}
	} else if (observed.status === "error" || observed.status === "cleaned") {
		if (observed.status === "cleaned" || (check.kind !== "held" && check.kind !== "historical_non_release")) {
			observed.status = "error";
			observed.phase = "uncertain";
		}
	}
	return observed;
}

function directionAttemptFromManifest(
	manifest: BootstrapManifest,
	request: Pick<StoredRequest, "node_id" | "node_attempt_id">,
): { entry: AgentLaunch; dir: string; key: string; scoped: boolean } {
	const entry = manifest.pane_manifest.find(agent => agent.node_id === request.node_id);
	if (!entry) throw new Error("Original requester is missing from the run roster");
	const dir = manifest.session_dir;
	const key = request.node_attempt_id;
	const scoped = Boolean(manifest.review_plan);
	if (scoped ? !key.startsWith(`${entry.instance_id}.`) || !/^[1-9]\d*$/.test(key.slice(entry.instance_id.length + 1)) : key !== entry.instance_id) {
		throw new Error("Request does not identify an attempt of the original node");
	}
	return { entry, dir, key, scoped };
}

function cancelIdentityFor(manifest: BootstrapManifest, entry: AgentLaunch, attemptId?: string) {
	return {
		run_id: manifest.task_id,
		node_id: entry.node_id,
		persona_name: entry.persona_name,
		instance_id: entry.instance_id,
		...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
	};
}

function hasSafeExhaustionCandidate(indexRoot: string, taskId: string, cwd: string, definition: BoundDirectionDefinition): boolean {
	assertTaskId(taskId);
	const dir = join(cwd, ".pi", "agent-sessions", taskId);
	const instanceForNode = (nodeId: string, index: number) => `a${index + 1}-${nodeId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;
	const reviewers = definition.agents.flatMap(({ node, decision }, i) => decision ? [{ instance: instanceForNode(node.node_id, i), decision }] : []);
	if (!reviewers.length) return false;
	const indexFile = join(indexRoot, `${taskId}.json`);
	if (pathEntryExists(indexFile)) {
		assertRegularFileIfExists(indexFile, "bootstrap index manifest");
	}
	precheckSessionFiles(dir);
	const files = new Set(readdirSync(dir));
	for (const { instance, decision } of reviewers) {
		if (files.has(`${instance}.finalize.json`)) {
			const finFile = finalizePath(dir, instance);
			const header = readRegularJsonNoSymlink<Record<string, unknown>>(finFile, `review finalization (${finFile})`);
			if (header?.version !== 1 || header.exhausted !== undefined || header.settled_capacity !== undefined) return true;
			if (
				header.run_id !== taskId
				|| header.instance_id !== instance
				|| !Array.from({ length: decision.max_revisions + 1 }, (_, n) => `${instance}.${n + 1}`).includes(String(header.attempt_id))
			) {
				return true;
			}
			const key = String(header.attempt_id);
			if (header.finalized_by === instance) {
				if (!files.has(`${key}.result.json`)) {
					if (!files.has(`${key}.disposition.json`)) return true;
				} else {
					const completion = readRegularJsonNoSymlink<WorkerCompletion>(resultPath(dir, key), "decision result during exhaustion discovery");
					if (!completion?.result || (completion.result.status === "success" && completion.result.outputs?.[decision.field] !== decision.approve)) return true;
				}
			}
		} else {
			for (let n = 1; n <= decision.max_revisions + 1; n++) {
				if (files.has(`${instance}.${n}.transition.json`)) {
					const transFile = join(dir, `${instance}.${n}.transition.json`);
					const trans = readRegularJsonNoSymlink<{ winner?: unknown }>(transFile, "loop transition");
					if (trans?.winner === "finalized") return true;
				}
			}
		}
	}
	return false;
}

/**
 * Viewer-owned, strictly read-only direction observation, routing, and exhaustion readers.
 * Uses only regular-file/no-symlink/non-blocking (`O_NONBLOCK | O_NOFOLLOW` + `fstat`) session reads
 * and never falls back to `BootstrapService.status` or `SessionStore.load`.
 */
export function createViewerDirectionReader(indexRoot: string) {
	const directionObservation = (
		request: StoredRequest,
		cwd: string,
		dbPath: string,
		receiver?: Parameters<typeof import("../../bootstrap/lifecycle.ts").BootstrapService.prototype.directionObservation>[3],
	): "receiver_verified" | "unverified" | "result" | "cancelled" | "failed" => {
		const manifest = loadSafeDirectionManifest(indexRoot, request, cwd, dbPath);
		const { entry, dir, key, scoped } = directionAttemptFromManifest(manifest, request);
		precheckSessionFiles(dir);

		const cancel = readRunCancelRecordSafe(dir, manifest.task_id);
		const nodeCancel = readCancelRecordSafe(dir, cancelIdentityFor(manifest, entry));
		const failed = readFailFast(dir, manifest.task_id, manifest.token);
		const outcome = readOutcomeClaimSafe(dir, cancelIdentityFor(manifest, entry, scoped ? key : entry.attempt_id), key);
		const error = cancel.error ?? nodeCancel.error ?? failed.error ?? outcome.error;
		if (error) throw new Error(error);

		const expected = { ...expectationFor(manifest, entry), attempt_id: scoped ? key : entry.attempt_id };
		const resFile = resultPath(dir, key);
		if (pathEntryExists(resFile)) {
			if (outcome.claim?.outcome === "cancelled" || pathEntryExists(dispositionPath(dir, key))) {
				throw new Error("Original attempt has contradictory result and termination evidence");
			}
			const completion = parseCompletion(readRegularJsonNoSymlink(resFile, "direction requester result"), expected);
			return completion.result.status === "failure" ? "failed" : "result";
		}

		const dispFile = dispositionPath(dir, key);
		let disp: Disposition | undefined;
		if (pathEntryExists(dispFile)) {
			disp = parseDisposition(readRegularJsonNoSymlink(dispFile, "node disposition"), expected);
		}

		const scopedErrorFile = join(dir, `${key}.error.json`);
		const errorFile = manifest.review_plan && !pathEntryExists(scopedErrorFile) && attemptNumber(key) === 1
			? join(dir, `${entry.instance_id}.error.json`)
			: scopedErrorFile;
		if (pathEntryExists(errorFile)) {
			readRegularJsonNoSymlink(errorFile, "node error");
			throw new Error("Original attempt recorded an execution error");
		}
		if (entry.error) {
			throw new Error("Original attempt launch recorded an error");
		}

		const readyFile = readyPath(dir, entry.instance_id);
		let ready: WorkerReady | undefined;
		let readyAlive = false;
		if (pathEntryExists(readyFile)) {
			ready = parseWorkerReady(readRegularJsonNoSymlink(readyFile, "direction requester readiness"));
			if (ready.task_id !== manifest.task_id || ready.token !== manifest.token || ready.instance_id !== entry.instance_id) {
				throw new Error("Foreign readiness");
			}
			readyAlive = processAlive(ready);
		}

		const progressFile = join(dir, `${entry.instance_id}.progress.json`);
		let heartbeat: "working" | "waiting" | undefined;
		if (pathEntryExists(progressFile)) {
			const progress = readRegularJsonNoSymlink<ProgressSnapshot>(progressFile, "node progress");
			if (progress.token !== manifest.token) {
				throw new Error("Foreign progress");
			}
			if (Number.isFinite(progress.updated_at) && (!manifest.review_plan || progress.attempt_id === key)) {
				heartbeat = progress.state === "working" ? "working" : "waiting";
			}
		}

		const matchingNodeCancel = nodeCancel.record && (!manifest.review_plan || !nodeCancel.record.identity.attempt_id || nodeCancel.record.identity.attempt_id === key)
			? nodeCancel.record
			: undefined;
		const activeCancel = matchingNodeCancel ?? (outcome.claim?.outcome === "completed" ? undefined : cancel.record);
		if (
			cancel.record
			|| nodeCancel.record
			|| failed.record
			|| outcome.claim?.outcome === "cancelled"
			|| disp?.state === "cancelled"
			|| (manifest.status === "error" && manifest.phase === "cancelled")
			|| activeCancel
		) {
			return "cancelled";
		}
		if (disp?.state === "failed") return "failed";
		if (outcome.claim || disp) {
			throw new Error("Original attempt has terminal evidence without a result");
		}

		if (manifest.review_plan) {
			let att = currentAttempt(manifest, entry);
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			const fin = loop ? readFinalization(dir, manifest.task_id, loop, entry.instance_id, manifest.topology, manifest.version) : undefined;
			if (fin && att && attemptNumber(fin.attempt_id) < att.number) {
				att = { ...att, number: attemptNumber(fin.attempt_id) };
			}
			const activeKey = att ? `${entry.instance_id}.${att.number}` : entry.attempt_id;
			if (activeKey !== key) {
				throw new Error("Original attempt is no longer active");
			}
		}

		if (manifest.status !== "applied" || entry.status === "closed" || heartbeat !== "working" || (ready !== undefined && !readyAlive)) {
			throw new Error(ready !== undefined && !readyAlive ? "Original requester exited" : "Original attempt is not running or its resource evidence changed");
		}
		if (!receiver) return "unverified";
		if (!ready) {
			throw new Error("Original requester readiness identity is missing or changed");
		}
		if (
			ready.version !== 2
			|| receiver.instance_id !== entry.instance_id
			|| receiver.run_token !== manifest.token
			|| ready.token !== manifest.token
			|| ready.task_id !== manifest.task_id
			|| ready.instance_id !== entry.instance_id
			|| ready.pid !== receiver.pid
			|| ready.session_id !== receiver.session_id
			|| ready.start_time !== receiver.start
			|| ready.direction_incarnation !== receiver.incarnation
		) {
			throw new Error("Original requester readiness identity is missing or changed");
		}
		const proc = directionProcess(receiver.pid);
		if (proc.boot !== receiver.boot || proc.start !== receiver.start || ["Z", "X", "x"].includes(proc.state)) {
			throw new Error("Original requester exited or its process identity changed");
		}
		return "receiver_verified";
	};

	const directionRouting = (
		request: StoredRequest,
		cwd: string,
		dbPath: string,
		evidence: ReturnType<typeof requestDecisionEvidence>,
	): DirectionRoutingView => {
		const manifest = loadSafeDirectionManifest(indexRoot, request, cwd, dbPath);
		const { entry, dir, key } = directionAttemptFromManifest(manifest, request);
		precheckSessionFiles(dir);
		verifyBoundReviewPlan(evidence.definition, manifest.review_plan, manifest.pane_manifest);
		const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
		if (loop?.reviewer !== entry.instance_id || !evidence.decision) {
			throw new Error("Run decision does not match the bound definition");
		}
		const resFile = resultPath(dir, key);
		const risk_lane = manifest.lanes && !manifest.session_dir_removed
			? assessRiskLane({
				sessionDir: dir,
				runId: manifest.task_id,
				projectCwd: manifest.project_cwd,
				lanes: manifest.lanes,
				reviewerInstance: loop.reviewer,
				reviewerNodeId: entry.node_id,
				attempt: attemptNumber(key),
				liveIfNoAfterSnapshot: false,
			})
			: undefined;
		const outcome = readOutcomeClaimSafe(dir, cancelIdentityFor(manifest, entry, key), key);
		if (outcome.error) throw new Error(outcome.error);
		if (!pathEntryExists(resFile)) {
			if (outcome.claim?.outcome === "completed") {
				throw new Error("Decision has a completion claim without its result");
			}
			const choices = JSON.parse(request.choices) as Array<{ route?: string }>;
			const revision = choices.some(choice => choice.route === "reject")
				? revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, attemptNumber(key), true)
				: undefined;
			return { verdict: { state: "not_recorded" }, admissions: null, ...(revision ? { revision } : {}), ...(risk_lane ? { risk_lane } : {}) };
		}
		if (outcome.claim?.outcome !== "completed" || pathEntryExists(dispositionPath(dir, key))) {
			throw new Error("Decision result lacks a matching completion claim or conflicts with termination evidence");
		}
		const completion = parseCompletion(readRegularJsonNoSymlink(resFile, "decision result"), { ...expectationFor(manifest, entry), attempt_id: key });
		const route = reviewVerdict(loop, completion.result);
		if (!route) {
			return { verdict: { state: "not_applicable" }, admissions: null, ...(risk_lane ? { risk_lane } : {}) };
		}
		const value = loop[route];
		if ((evidence.requireRoute && !evidence.approval) || (evidence.approval && (!evidence.approvalDelivered || value !== evidence.approval.verdict))) {
			throw new Error("Recorded verdict contradicts the approval or its delivery evidence");
		}
		const verdict = { state: "recorded", value } as const;
		try {
			const revisionAttempt = attemptNumber(key) + 1;
			if (route === "reject") revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, revisionAttempt - 1, true);
			const outbound = outboundEdgesOf(manifest.pane_manifest, entry.instance_id);
			const destinations = route === "approve"
				? outbound.map(instance => ({ instance, attempt: 1 }))
				: [{ instance: loop.target, attempt: attemptNumber(key) + 1 }];
			const digest = inputDigest(completion.result);
			const admissions = destinations.map(({ instance, attempt }) => {
				const target = manifest.pane_manifest.find(item => item.instance_id === instance)!;
				const targetKey = attemptKey(manifest.review_plan, instance, attempt);
				const claim = describeHandoff(
					dir,
					entry.instance_id,
					targetKey,
					{ run_id: manifest.task_id, destination: { instance_id: instance, node_id: target.node_id, attempt_id: targetKey }, version: expectedResultVersion(manifest) },
					entry.instance_id,
					instance,
				);
				const expectedId = handoffId({
					run_id: manifest.task_id,
					source_attempt_id: key,
					destination_node_id: target.node_id,
					destination_attempt_id: targetKey,
					input_digest: digest,
				});
				const edge = { node_id: target.node_id, kind: route === "approve" ? ("successor" as const) : ("revision" as const) };
				const problem = claim?.problems[0] ?? (claim?.handoff_id && (claim.handoff_id !== expectedId || claim.input_digest !== digest) ? "Handoff does not match the recorded verdict result" : undefined);
				if (problem) return { ...edge, state: "unknown" as const, reason: problem };
				if (claim?.state === "accepted") {
					return claim.offered_at && !claim.legacy
						? { ...edge, state: "admitted" as const }
						: { ...edge, state: "unknown" as const, reason: "Acceptance has no matching offer" };
				}
				const progressFile = join(dir, `${instance}.progress.json`);
				const progress = pathEntryExists(progressFile)
					? readRegularJsonNoSymlink<ProgressSnapshot>(progressFile, "destination progress")
					: undefined;
				if (progress && progress.token !== manifest.token) {
					return { ...edge, state: "unknown" as const, reason: "Destination progress belongs to another run" };
				}
				const targetResFile = resultPath(dir, targetKey);
				if (pathEntryExists(targetResFile) || (progress?.attempt_id === targetKey && progress.started_at !== undefined)) {
					return { ...edge, state: "unknown" as const, reason: "Destination execution has no matching admission claim" };
				}
				return { ...edge, state: "not_admitted" as const };
			});
			return { verdict, admissions: admissions.length ? admissions : null, ...(risk_lane ? { risk_lane } : {}) };
		} catch (error) {
			return { verdict, admissions: "unknown", routing_error: error instanceof Error ? error.message : String(error), ...(risk_lane ? { risk_lane } : {}) };
		}
	};

	const directionExhaustions = (
		ids: Pick<StoredRequest, "factory_id" | "input_id" | "attempt_id" | "task_id">,
		cwd: string,
		dbPath: string,
		definition: BoundDirectionDefinition,
		evidenceFor: (node: string, key: string) => ReturnType<typeof requestDecisionEvidence>,
		hasSavedAnswer = false,
	): DirectionRequestView[] => {
		if (!hasSavedAnswer && !hasSafeExhaustionCandidate(indexRoot, ids.task_id, cwd, definition)) return [];
		const manifest = loadSafeDirectionManifest(indexRoot, ids, cwd, dbPath);
		const dir = manifest.session_dir;
		precheckSessionFiles(dir);
		verifyBoundReviewPlan(definition, manifest.review_plan, manifest.pane_manifest);
		return definition.agents.flatMap(({ node, decision }) => {
			if (!decision) return [];
			const entry = manifest.pane_manifest.find(item => item.node_id === node.node_id);
			if (!entry) throw new Error(`Missing decision ${node.node_id} in the run roster`);
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id)!;
			const finalization = readFinalization(dir, manifest.task_id, loop, loop.reviewer, manifest.topology, manifest.version);
			if (!finalization) return [];
			if (!pathEntryExists(finalizePath(dir, loop.reviewer))) throw new Error(`Missing finalization evidence for ${loop.reviewer}`);
			const key = finalization.attempt_id;
			const attempt = attemptNumber(key);
			const capacity = revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, attempt, true);
			const resFile = resultPath(dir, key);
			const dispFile = dispositionPath(dir, key);
			const expected = { ...expectationFor(manifest, entry), attempt_id: key };
			const outcome = readOutcomeClaimSafe(dir, cancelIdentityFor(manifest, entry, key), key);
			if (outcome.error) throw new Error(outcome.error);
			const result = pathEntryExists(resFile)
				? parseCompletion(readRegularJsonNoSymlink(resFile, "finalized review result"), expected).result
				: undefined;
			const disposition = pathEntryExists(dispFile)
				? parseDisposition(readRegularJsonNoSymlink(dispFile, "finalized review disposition"), expected)
				: undefined;
			if (result ? outcome.claim?.outcome !== "completed" || disposition : !disposition || outcome.claim?.outcome === "completed") {
				throw new Error(`Missing or contradictory review outcome for ${key}`);
			}
			const route = result && reviewVerdict(loop, result);
			const limit = capacity.blocked_by;
			const exhausted = finalization.exhausted;
			const explicit = exhausted && (exhausted.reason === revisionExhaustionReason(loop, "loop_limit") || exhausted.reason === revisionExhaustionReason(loop, "run_budget"));
			if (exhausted && !explicit && finalization.finalized_by !== "dispatcher") throw new Error(`Unknown exhaustion cause for ${key}`);
			if (explicit && (!limit || exhausted.reason !== revisionExhaustionReason(loop, limit) || exhausted.state !== loop.on_exhausted || route !== "reject" || revisionReserved(dir, manifest.task_id, loop, attempt + 1))) {
				throw new Error(`Contradictory exhaustion evidence for ${key}`);
			}
			if (finalization.settled_capacity && (route || disposition?.state === "cancelled" || finalization.settled_capacity !== limit)) {
				throw new Error(`Contradictory settled revision capacity for ${key}`);
			}
			if (!limit || (!explicit && !finalization.settled_capacity)) {
				if (route === "reject" && finalization.finalized_by !== "dispatcher") throw new Error(`Missing exhaustion cause for ${key}`);
				return [];
			}
			const destinations = [...outboundEdgesOf(manifest.pane_manifest, entry.instance_id).map(target => `${target}.1`), `${loop.target}.${attempt + 1}`];
			if (destinations.some(destination => pathEntryExists(handoffOfferPath(dir, destination, entry.instance_id)) || pathEntryExists(handoffClaimPath(dir, destination, entry.instance_id)))) {
				throw new Error(`Exhaustion evidence for ${key} contradicts a saved handoff`);
			}
			if (route) {
				const evidence = evidenceFor(node.node_id, key);
				if ((evidence.requireRoute && !evidence.approval) || (evidence.approval && (!evidence.approvalDelivered || evidence.approval.verdict !== loop[route]))) {
					throw new Error(`Exhausted verdict for ${key} contradicts the bound human choice or delivery evidence`);
				}
			}
			const risk_lane = manifest.lanes && !manifest.session_dir_removed
				? assessRiskLane({
					sessionDir: dir,
					runId: manifest.task_id,
					projectCwd: manifest.project_cwd,
					lanes: manifest.lanes,
					reviewerInstance: loop.reviewer,
					reviewerNodeId: entry.node_id,
					attempt,
					liveIfNoAfterSnapshot: false,
				})
				: undefined;
			const request_id = `exhaust_${createHash("sha256").update(JSON.stringify([manifest.task_id, key])).digest("hex")}`;
			return [{
				...ids,
				request_id,
				node_id: node.node_id,
				node_attempt_id: key,
				question: "This review loop is out of revision capacity. What should happen next?",
				reason: `${revisionExhaustionReason(loop, limit)}; plan on_exhausted: ${loop.on_exhausted}.`,
				evidence: [`Run ${manifest.task_id}, finalized review ${key}`],
				choices: [
					{ choice_id: "retry", label: "Retry with a new brief" },
					{ choice_id: "takeover", label: "Take over the work manually" },
					{ choice_id: "discard", label: "Discard the escalation" },
				],
				exhaustion: { blocked_by: limit, on_exhausted: loop.on_exhausted },
				state: "pending",
				response_recorded: false,
				created_at: outcome.claim?.claimed_at ?? disposition!.recorded_at,
				consumption: "not_applicable",
				can_respond: true,
				can_redeliver: false,
				reconciliation: "pending",
				verdict: route ? { state: "recorded", value: loop[route] } : { state: "not_applicable" },
				admissions: null,
				...(risk_lane ? { risk_lane } : {}),
			}];
		});
	};

	return { directionObservation, directionRouting, directionExhaustions };
}

function presentIdOrUnavailable(value: string, label: string) {
	return value
		? value
		: { absence: "evidence unavailable" as const, explanation: `${label} is unavailable because request evidence is damaged.` };
}

function projectRequest(item: DirectionRequestView, blockedPaths: readonly string[]) {
	const isExhaustion = Boolean(item.exhaustion) || item.request_id.startsWith("exhaust_");
	const state = REQUEST_STATES.has(item.state) ? item.state : ("unknown" as const);
	const consumption = CONSUMPTION_STATES.has(item.consumption) ? item.consumption : ("unknown" as const);
	const reconciliation = item.reconciliation && RECONCILIATION_STATES.has(item.reconciliation)
		? item.reconciliation
		: ("uncertain" as const);

	const responseRecordedKnown = typeof item.response_recorded === "boolean";
	const responseRecorded = responseRecordedKnown
		? item.response_recorded
		: { absence: "evidence unavailable" as const, explanation: "Whether a response was recorded could not be verified." };

	const responseConsumed = consumption === "consumed"
		? true
		: consumption === "awaiting_consumption" || consumption === "never_consumed"
			? false
			: consumption === "not_applicable"
				? {
					absence: "not applicable" as const,
					explanation: isExhaustion
						? "Exhaustion requests do not use worker consumption."
						: "No response has been recorded to consume.",
				}
				: {
					absence: "evidence unavailable" as const,
					explanation: "Whether the waiting attempt consumed the response could not be verified.",
				};

	const admissionsUnknown = item.admissions === "unknown"
		|| (Array.isArray(item.admissions) && item.admissions.some(a => a.state === "unknown"));
	const uncertain = state === "unknown"
		|| !responseRecordedKnown
		|| consumption === "unknown"
		|| reconciliation === "uncertain"
		|| Boolean(item.routing_error)
		|| item.verdict?.state === "unknown"
		|| admissionsUnknown;

	const uncertaintyReasons: string[] = [];
	if (state === "unknown" || !responseRecordedKnown) {
		uncertaintyReasons.push("Request state or response recording evidence is damaged or contradictory.");
	}
	if (consumption === "unknown") {
		uncertaintyReasons.push("Response consumption state could not be verified.");
	}
	if (reconciliation === "uncertain") {
		uncertaintyReasons.push("The original requester, response delivery, or routing state could not be verified.");
	}
	if (item.routing_error || item.verdict?.state === "unknown" || admissionsUnknown) {
		uncertaintyReasons.push("Downstream decision verdict or handoff admission evidence could not be verified.");
	}

	const damagedRequest = state === "unknown";
	const question = damagedRequest || !item.question.trim()
		? { absence: "evidence unavailable" as const, explanation: "Request question is unavailable because request evidence is damaged or incomplete." }
		: sanitizeOperatorText(item.question, 512, blockedPaths);
	const choices = Array.isArray(item.choices) && item.choices.length > 0
		? item.choices.map(c => ({
			choice_id: c.choice_id,
			label: sanitizeOperatorText(c.label, 200, blockedPaths),
			...(c.route ? { route: c.route } : {}),
		}))
		: { absence: "evidence unavailable" as const, explanation: "Request choices are unavailable." };

	const admissions = item.admissions === undefined
		? undefined
		: item.admissions === null
			? { absence: "not applicable" as const, explanation: "No downstream handoff admissions apply to this request." }
			: item.admissions === "unknown"
				? { absence: "evidence unavailable" as const, explanation: "Downstream handoff admission evidence could not be verified." }
				: item.admissions.map(a => ({
					node_id: a.node_id,
					kind: a.kind,
					state: a.state,
				}));

	const reconciliationExplanation = reconciliation === "resolved" && consumption === "awaiting_consumption"
		? "A response is recorded and awaiting consumption; the waiting attempt has not claimed it yet."
		: RECONCILIATION_EXPLANATIONS[reconciliation]!;

	return {
		request_id: item.request_id,
		factory_id: item.factory_id,
		kind: isExhaustion ? ("exhaustion" as const) : ("direction" as const),
		input_id: presentIdOrUnavailable(item.input_id, "Input ID"),
		attempt_id: presentIdOrUnavailable(item.attempt_id, "Attempt ID"),
		task_id: presentIdOrUnavailable(item.task_id, "Run task ID"),
		node_id: presentIdOrUnavailable(item.node_id, "Node ID"),
		node_attempt_id: presentIdOrUnavailable(item.node_attempt_id, "Node attempt ID"),
		state,
		state_explanation: REQUEST_STATE_EXPLANATIONS[state]!,
		question,
		choices,
		...(item.exhaustion ? { exhaustion: { blocked_by: item.exhaustion.blocked_by, on_exhausted: item.exhaustion.on_exhausted } } : {}),
		created_at: item.created_at || { absence: "evidence unavailable" as const, explanation: "Creation timestamp is unavailable." },
		response_recorded: responseRecorded,
		...(item.response_recorded === true && item.response
			? {
				recorded_response: {
					kind: item.response.kind,
					...(item.response.kind === "choice" ? { choice_id: item.response.choice_id } : {}),
				},
				responded_at: item.response.responded_at,
			}
			: {}),
		consumption,
		consumption_explanation: CONSUMPTION_EXPLANATIONS[consumption]!,
		response_consumed: responseConsumed,
		...(item.consumed_at ? { consumed_at: item.consumed_at } : {}),
		...(item.terminated ? { terminated: { reason: item.terminated.reason, at: item.terminated.at } } : {}),
		reconciliation,
		reconciliation_explanation: reconciliationExplanation,
		...(item.verdict ? { verdict: { ...item.verdict } } : {}),
		...(admissions !== undefined ? { admissions } : {}),
		...(item.risk_lane
			? {
				risk_lane: {
					lane: item.risk_lane.lane,
					requirement: item.risk_lane.requirement,
					scope: item.risk_lane.unknown_scope
						? {
							absence: "evidence unavailable" as const,
							explanation: "Recorded lane scope snapshot is absent or incomplete; live working-tree snapshots are not taken.",
						}
						: ("recorded" as const),
					...(item.risk_lane.unknown_scope ? { unknown_scope: true } : {}),
				},
			}
			: {}),
		uncertain,
		...(uncertain ? { uncertainty: uncertaintyReasons.join(" ") } : {}),
	};
}

function collectManifestBlockedPaths(manifestPath: string, target: Set<string>): void {
	try {
		if (!assertRegularFileIfExists(manifestPath, "request manifest")) return;
		const parsed = readRegularJsonNoSymlink<Partial<BootstrapManifest>>(manifestPath, "request manifest");
		if (typeof parsed.project_cwd === "string" && parsed.project_cwd) target.add(parsed.project_cwd);
		if (typeof parsed.session_dir === "string" && parsed.session_dir) target.add(parsed.session_dir);
		const managed = parsed.factory_managed;
		if (managed) {
			if (typeof managed.canonical_checkout === "string" && managed.canonical_checkout) target.add(managed.canonical_checkout);
			if (typeof managed.state_db_path === "string" && managed.state_db_path) {
				target.add(managed.state_db_path);
				target.add(dirname(managed.state_db_path));
			}
			if (typeof managed.coord_db_path === "string" && managed.coord_db_path) {
				target.add(managed.coord_db_path);
				target.add(dirname(managed.coord_db_path));
			}
		}
	} catch {
		// Best-effort non-blocking path collection; generic scrub and base paths still apply.
	}
}

/**
 * Collect per-attempt checkout, session-dir, and run store paths read-only without blocking on FIFOs,
 * so `requestsSnapshot` scrubs paths even when state/home/checkout are separate.
 */
export function collectRequestBlockedPaths(
	statePath: string,
	indexRoot: string,
	factoryId: string,
	requests: readonly Pick<DirectionRequestView, "attempt_id" | "task_id">[],
): Map<string, string[]> {
	const byAttempt = new Map<string, Set<string>>();
	const ensureSet = (key: string): Set<string> => {
		let set = byAttempt.get(key);
		if (!set) {
			set = new Set<string>();
			byAttempt.set(key, set);
		}
		return set;
	};
	const attemptCheckouts = new Map<string, { task_id: string; canonical_checkout: string }>();
	try {
		if (assertRegularFileIfExists(statePath, "factory state database", Number.MAX_SAFE_INTEGER)) {
			const db = new DatabaseSync(statePath, { readOnly: true });
			try {
				db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON");
				const rows = db.prepare("SELECT attempt_id, task_id, canonical_checkout FROM factory_attempts WHERE factory_id = ?").all(factoryId) as Array<{
					attempt_id: string;
					task_id: string;
					canonical_checkout: string;
				}>;
				for (const row of rows) {
					attemptCheckouts.set(row.attempt_id, { task_id: row.task_id, canonical_checkout: row.canonical_checkout });
				}
			} finally {
				db.close();
			}
		}
	} catch {
		// Best-effort read-only lookup.
	}

	const seenKeys = new Set<string>();
	for (const req of requests) {
		const att = req.attempt_id ? attemptCheckouts.get(req.attempt_id) : undefined;
		const taskId = req.task_id || att?.task_id || "";
		const key = `${req.attempt_id}:${taskId}`;
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);
		const paths = ensureSet(req.attempt_id || taskId);
		if (att?.canonical_checkout) {
			paths.add(att.canonical_checkout);
			if (taskId) {
				const sessionDir = join(att.canonical_checkout, ".pi", "agent-sessions", taskId);
				paths.add(sessionDir);
				collectManifestBlockedPaths(join(sessionDir, "manifest.json"), paths);
			}
		}
		if (taskId) {
			try {
				assertTaskId(taskId);
				collectManifestBlockedPaths(join(indexRoot, `${taskId}.json`), paths);
			} catch {
				// Ignore invalid task IDs in damaged records.
			}
		}
	}

	const out = new Map<string, string[]>();
	for (const [k, set] of byAttempt) {
		out.set(k, [...set]);
	}
	return out;
}

/** Operator-facing requests snapshot projected from verified read-only DirectionRequestView records. */
export function requestsSnapshot(
	requests: DirectionRequestView[],
	factoryId: string,
	blockedPaths: readonly string[] = [],
	perAttemptBlockedPaths?: ReadonlyMap<string, readonly string[]>,
) {
	const records = requests.map(item => {
		const extra = perAttemptBlockedPaths?.get(item.attempt_id || item.task_id) ?? [];
		return projectRequest(item, extra.length > 0 ? [...blockedPaths, ...extra] : blockedPaths);
	});
	const anyUncertain = records.some(record => record.uncertain);
	const deletionFields = deletionMarkerFields(requests as RequestsListResult, blockedPaths);
	return {
		factory_id: factoryId,
		...deletionFields,
		evidence: anyUncertain ? ("uncertain" as const) : ("available" as const),
		records,
		explanation: `${records.length} direction or exhaustion request(s) recorded.`,
	};
}

/** Typed absence requests snapshot when a healthy store has zero requests. */
export function absentRequestsSnapshot(
	factoryId: string,
	absence: Exclude<TypedAbsence, "evidence unavailable">,
	deletionSource?: { deleted?: boolean; deletion?: FactoryDeletionInfo },
	blockedPaths: readonly string[] = [],
) {
	return {
		factory_id: factoryId,
		...deletionMarkerFields(deletionSource, blockedPaths),
		evidence: "available" as const,
		records: [] as never[],
		absence,
		explanation: absence === "not applicable"
			? "Direction and exhaustion requests apply only to a managed factory."
			: "No direction or exhaustion requests have been recorded.",
	};
}

/** Typed unavailable requests snapshot when store or session evidence cannot be verified. */
export function unavailableRequestsSnapshot(factoryId: string) {
	return {
		factory_id: factoryId,
		evidence: "unavailable" as const,
		records: [] as never[],
		absence: "evidence unavailable" as const,
		explanation: "Direction request evidence is unavailable.",
	};
}
