/** Shared pure admission, release-verification, and record-reading helpers for agent workers and deterministic command nodes. */
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { requiredChecksOf, upstreamRequiredChecks, verifyEvidence } from "./evidence.ts";
import { inspectFactoryReleaseState, isFactoryTaskId, resolveCheckoutIdentity } from "./factory-evidence.ts";
import { readDecisionDirection } from "./factory-requests.ts";
import { assessRiskLane, closedLaneBlockedDetails, verifyLoopRequiredChecks } from "./lanes.ts";
import { decideAdmission, effectiveDependencyPolicy, executionFromResult, type AdmissionDecision, type CauseRef, type NodeExecution } from "./outcomes.ts";
import { attemptKey, attemptNumber, blockedReviewForwardEdge, readFinalization, reviewLoopFor, reviewVerdict, type ReviewLoop } from "./review-loop.ts";
import { formatLearnedConstraintLine } from "./constraints.ts";
import { parseTaskInput, sha256Text, taskInputPath, type TaskInputRecord } from "./contracts.ts";
import {
	assertNoSymlinkPath, dependencyPolicyOf, dispositionPath, errorMessage, expectedResultVersion, factoryRunPath, inboundEdgesOf,
	parseCompletion, parseDisposition, parseManifest, pathEntryExists, readJson, readRegularJsonNoSymlink, resultPath,
	type CompletionExpectation, type Disposition, type WorkerCompletion, type WorkerConfig,
} from "./session-store.ts";

/** What a worker's own result file must say about itself. */
export function ownExpectation(config: WorkerConfig): CompletionExpectation {
	const version = expectedResultVersion(config);
	return {
		run_id: config.task_id,
		instance_id: config.instance_id,
		node_id: config.node_id,
		persona_name: config.persona_name,
		attempt_id: config.attempt_id,
		kind: config.kind ?? "agent",
		...(config.kind === "command" ? { command: config.command, args: config.args, working_directory: config.working_directory } : {}),
		...(version !== undefined ? { version } : {}),
	};
}

/** Ownership records are per-instance across loop attempts, so review-plan runs validate without attempt_id. */
export function ownershipExpectation(config: WorkerConfig): CompletionExpectation {
	return {
		run_id: config.task_id,
		instance_id: config.instance_id,
		node_id: config.node_id,
		persona_name: config.persona_name,
		attempt_id: config.review_plan ? attemptKey(config.review_plan, config.instance_id, 1) : config.attempt_id,
	};
}

export function activeKey(config: WorkerConfig): string {
	return attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id));
}

export function sourceKey(config: WorkerConfig, source: string, sourceAttempt?: number): string {
	return attemptKey(config.review_plan, source, sourceAttempt ?? (source === config.predecessor ? config.predecessor_attempt : undefined));
}

export function predecessorKey(config: WorkerConfig): string {
	return sourceKey(config, config.predecessor!);
}

export function ownLoop(config: WorkerConfig) {
	return reviewLoopFor(config.review_plan, config.instance_id);
}

export function sourceNode(config: WorkerConfig, sourceInstanceId: string): string {
	return config.roster?.find(member => member.instance_id === sourceInstanceId)?.node_id ?? sourceInstanceId;
}

export function predecessorNode(config: WorkerConfig): string {
	return sourceNode(config, config.predecessor!);
}

/** What a predecessor's result file must say; the roster (when present) says which node and kind it is. */
export function sourceExpectation(config: WorkerConfig, sourceInstanceId: string, sourceAttempt?: number): CompletionExpectation {
	let member = config.roster?.find(item => item.instance_id === sourceInstanceId);
	if (!member?.kind) {
		try {
			const manifest = parseManifest(readJson<unknown>(join(config.session_dir, "manifest.json")), config.task_id);
			const launch = manifest.pane_manifest.find(item => item.instance_id === sourceInstanceId);
			if (launch) {
				member = {
					instance_id: launch.instance_id,
					node_id: launch.node_id,
					persona_name: launch.persona_name,
					sub_task: member?.sub_task ?? "",
					...(launch.kind ? { kind: launch.kind } : {}),
					...(launch.command !== undefined ? { command: launch.command } : {}),
					...(launch.args !== undefined ? { args: launch.args } : {}),
					...(launch.working_directory !== undefined ? { working_directory: launch.working_directory } : {}),
				};
			}
		} catch { /* fall back to roster metadata */ }
	}
	const version = expectedResultVersion(config);
	return {
		run_id: config.task_id,
		instance_id: sourceInstanceId,
		node_id: member?.node_id,
		persona_name: member?.persona_name,
		...(member?.kind ? { kind: member.kind } : {}),
		...(member?.kind === "command" ? { command: member.command, args: member.args, working_directory: member.working_directory } : {}),
		...(config.review_plan ? { attempt_id: sourceKey(config, sourceInstanceId, sourceAttempt) } : {}),
		...(version !== undefined ? { version } : {}),
	};
}

export function predecessorExpectation(config: WorkerConfig): CompletionExpectation {
	return sourceExpectation(config, config.predecessor!);
}

/** Read the source outcome that governs admission. */
export function sourceRecord(config: WorkerConfig, sourceInstanceId: string, sourceAttempt?: number): { completion?: WorkerCompletion; disposition?: Disposition } {
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

export function predecessorRecord(config: WorkerConfig): { completion?: WorkerCompletion; disposition?: Disposition } {
	return sourceRecord(config, config.predecessor!);
}

export function isManagedWorker(config: WorkerConfig): boolean {
	if (config.factory_managed !== undefined || isFactoryTaskId(config.task_id)) return true;
	try {
		return pathEntryExists(factoryRunPath(config.session_dir));
	} catch {
		return true;
	}
}

export function verifyFactoryReleaseAuthority(
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

/** Verify that `taskInput.brief.learned_constraints` and `brief.constraints` agree with `cfg`. */
export function verifyTaskInputConstraints(cfg: WorkerConfig, taskInput: TaskInputRecord | undefined): void {
	if (cfg.learned_constraints !== undefined) {
		if (!taskInput) {
			throw new Error("Missing immutable task input for learned constraints run");
		}
		const lc = taskInput.brief.learned_constraints;
		if (!lc) {
			throw new Error("Immutable task input is missing brief.learned_constraints");
		}
		if (
			lc.digest !== cfg.learned_constraints.digest
			|| lc.used_ids.length !== cfg.learned_constraints.used_ids.length
			|| lc.used_ids.some((id, idx) => id !== cfg.learned_constraints!.used_ids[idx])
		) {
			throw new Error("Immutable task input brief.learned_constraints does not match worker config");
		}
		const cfgConstraints = cfg.constraints ?? [];
		const expectedActive = cfg.learned_constraints.entries
			.filter(entry => entry.status === "active")
			.map(formatLearnedConstraintLine);
		if (
			cfgConstraints.length < expectedActive.length
			|| expectedActive.some((line, idx) => cfgConstraints[cfgConstraints.length - expectedActive.length + idx] !== line)
		) {
			throw new Error("Worker config constraints do not match formatted active learned constraints");
		}
		const inputConstraints = taskInput.brief.constraints ?? [];
		if (cfgConstraints.length !== inputConstraints.length || cfgConstraints.some((c, i) => c !== inputConstraints[i])) {
			throw new Error("Immutable task input brief.constraints does not match worker config");
		}
	} else if (taskInput?.brief.learned_constraints !== undefined) {
		throw new Error("Unexpected brief.learned_constraints in immutable task input");
	}
}

export function requireManagedTaskInput(
	cfg: WorkerConfig,
	authoritativeBrief: { taskId: string; text: string; digest: string } | undefined,
): TaskInputRecord {
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
	verifyTaskInputConstraints(cfg, parsed);
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
}

export function graphPredecessors(config: WorkerConfig): Map<string, string[]> {
	let nodes: ReadonlyArray<{ instance_id: string; predecessor?: string; inbound_edges?: string[] }> = config.roster ?? [];
	// V3 graph rosters omit dependencies, but their manifest records the graph.
	try {
		const manifest = parseManifest(readJson<unknown>(join(config.session_dir, "manifest.json")), config.task_id);
		if (manifest.topology === "graph" && manifest.token === config.token) nodes = manifest.pane_manifest;
	} catch { /* use the dependencies available in the worker configuration */ }
	return new Map(nodes.map(node => [node.instance_id, inboundEdgesOf(node)]));
}

export function graphAncestors(predecessors: Map<string, string[]>, inbound: string[]): Set<string> {
	const ancestors = new Set(inbound);
	for (const id of ancestors) for (const parent of predecessors.get(id) ?? []) ancestors.add(parent);
	return ancestors;
}

export function executionOf(record: { completion?: WorkerCompletion; disposition?: Disposition }): NodeExecution | undefined {
	if (record.completion) return { ...executionFromResult(record.completion.result.status), reason: record.completion.result.summary };
	if (record.disposition) return { state: record.disposition.state, causes: record.disposition.causes, reason: record.disposition.reason };
}

/** May this edge admit the node, given what its source recorded, the effective dependency policy, and the evidence its required checks have now? */
export function admissionForEdge(
	config: WorkerConfig,
	sourceInstanceId: string,
	record: { completion?: WorkerCompletion; disposition?: Disposition },
	sourceAttempt?: number,
): AdmissionDecision {
	const execution = executionOf(record);
	const node_id = sourceNode(config, sourceInstanceId);
	if (!execution) return { admit: false, outcome: "wait", reason: `${node_id} has not recorded an outcome` };
	const reported = execution.state === "succeeded" || execution.state === "partial";
	const required = upstreamRequiredChecks(config, sourceInstanceId);
	const checks = reported
		? verifyEvidence(config.session_dir, sourceInstanceId, config.project_cwd, required, config.task_id, sourceKey(config, sourceInstanceId, sourceAttempt)).map(({ check, status }) => ({ name: check, status }))
		: [];
	const policy = inboundEdgesOf(config).length > 1
		? effectiveDependencyPolicy(config.join_policy, dependencyPolicyOf(config, true))
		: dependencyPolicyOf(config, true)!;
	return decideAdmission({ policy, predecessor: { node_id, execution }, checks });
}

function evaluateForwardLaneGate(
	config: WorkerConfig,
	sourceLoop: ReviewLoop,
	sourceInstanceId: string,
	sourceNodeId: string,
	sourceAttempt: number | undefined,
	record: { completion?: WorkerCompletion; disposition?: Disposition },
): Extract<AdmissionDecision, { admit: false }> | undefined {
	if (!config.lanes || sourceLoop === ownLoop(config) || sourceInstanceId !== sourceLoop.reviewer) return undefined;
	const execution = executionOf(record);
	if (execution?.state !== "succeeded" || reviewVerdict(sourceLoop, record.completion?.result) !== "approve") return undefined;
	const attempt = sourceAttempt
		?? (record.completion?.identity?.attempt_id ? attemptNumber(record.completion.identity.attempt_id) : undefined)
		?? (sourceInstanceId === config.predecessor ? config.predecessor_attempt : undefined)
		?? 1;
	const assessment = assessRiskLane({
		sessionDir: config.session_dir,
		runId: config.task_id,
		projectCwd: config.project_cwd,
		lanes: config.lanes,
		reviewerInstance: sourceLoop.reviewer,
		reviewerNodeId: sourceNodeId,
		attempt,
		liveIfNoAfterSnapshot: false,
	});
	if (assessment.lane === "contained") return undefined;
	if (assessment.lane === "closed") {
		if (!config.factory_managed) {
			const blocked = closedLaneBlockedDetails(sourceNodeId, assessment);
			return { admit: false, outcome: "blocked", reason: blocked.reason, causes: blocked.causes };
		}
		const pathsText = assessment.deciding_paths.length > 0 ? assessment.deciding_paths.join(", ") : (assessment.reason ?? "unknown scope");
		try {
			const { binding, approveInterventionEnabled } = readDecisionDirection(config.factory_managed.state_db_path, {
				factory_id: config.factory_managed.factory_id,
				input_id: config.factory_managed.input_id,
				attempt_id: config.factory_managed.attempt_id,
				task_id: config.task_id,
				node_id: sourceNodeId,
				node_attempt_id: attemptKey(config.review_plan, sourceLoop.reviewer, attempt),
			}, config.review_plan, config.roster ?? []);
			if (!approveInterventionEnabled) {
				const blocked = closedLaneBlockedDetails(sourceNodeId, assessment);
				return { admit: false, outcome: "blocked", reason: blocked.reason, causes: blocked.causes };
			}
			if (!binding || binding.verdict !== sourceLoop.approve) {
				const reason = `${sourceNodeId} approval in closed risk lane (${pathsText}) cannot route without a recorded human approval choice for attempt ${attempt}`;
				return { admit: false, outcome: "blocked", reason, causes: [{ node_id: sourceNodeId, state: "blocked", reason }] };
			}
		} catch (error) {
			const msg = errorMessage(error);
			const code = (error as { code?: string } | undefined)?.code;
			if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|Request .+ is still open/i.test(msg)) {
				return {
					admit: false,
					outcome: "wait",
					reason: `${sourceNodeId} approval in closed risk lane (${pathsText}) is waiting on direction state: ${msg}`,
				};
			}
			if (/Factory attempt is fenced|verdict.*contradicts|was not received|Missing or contradictory approval binding|direction approval table is missing|bound decision requires version/i.test(msg)) {
				const reason = `${sourceNodeId} approval in closed risk lane (${pathsText}) cannot route: ${msg}`;
				return { admit: false, outcome: "blocked", reason, causes: [{ node_id: sourceNodeId, state: "blocked", reason }] };
			}
			throw error;
		}
	}
	const loopChecks = verifyLoopRequiredChecks({
		sessionDir: config.session_dir,
		projectCwd: config.project_cwd,
		taskId: config.task_id,
		loopMembers: sourceLoop.members,
		reviewPlan: config.review_plan,
		attempt,
		upstreamContracts: config.upstream_contracts,
	});
	if (loopChecks.blockers.length > 0) {
		const unknownSuffix = assessment.unknown_scope ? ` (unknown change scope${assessment.reason ? `: ${assessment.reason}` : ""})` : "";
		const reason = `${sourceNodeId} approval in ${assessment.lane} risk lane${unknownSuffix} cannot route: ${loopChecks.blockers.join("; ")}`;
		const causes: CauseRef[] = loopChecks.checks
			.filter(entry => entry.status !== "passing")
			.map(entry => ({
				node_id: entry.instance_id === sourceLoop.reviewer ? sourceNodeId : sourceNode(config, entry.instance_id),
				state: "blocked" as const,
				reason: `check "${entry.check}": ${entry.status} evidence`,
				check: { name: entry.check, evidence: entry.status },
			}));
		return { admit: false, outcome: "blocked", reason, causes };
	}
	return undefined;
}

export function admission(
	config: WorkerConfig,
	record: { completion?: WorkerCompletion; disposition?: Disposition },
	finalization?: ReturnType<typeof readFinalization>,
): AdmissionDecision {
	const loop = reviewLoopFor(config.review_plan, config.predecessor!);
	const resolvedFinalization = finalization ?? (config.lanes && loop && loop !== ownLoop(config) ? readFinalization(config.session_dir, config.task_id, loop, config.predecessor!) : undefined);
	if (loop && resolvedFinalization) {
		const blocked = blockedReviewForwardEdge(loop, resolvedFinalization, predecessorNode(config), executionOf(record), record.completion?.result);
		if (blocked) return blocked;
	}
	if (config.lanes && loop) {
		const laneBlocked = evaluateForwardLaneGate(
			config,
			loop,
			config.predecessor!,
			predecessorNode(config),
			resolvedFinalization ? attemptNumber(resolvedFinalization.attempt_id) : config.predecessor_attempt,
			record,
		);
		if (laneBlocked) return laneBlocked;
	}
	return admissionForEdge(config, config.predecessor!, record);
}

export function evaluateJoinAdmission(config: WorkerConfig, inbound: string[]):
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
		if (config.lanes && srcLoop) {
			const laneDecision = evaluateForwardLaneGate(config, srcLoop, src, sourceNode(config, src), sourceAttempt, rec);
			if (laneDecision) {
				if (laneDecision.outcome === "wait") {
					pendingSources.push(src);
				} else {
					blockedReasons.push(laneDecision.reason);
					pushCauses(laneDecision.causes);
				}
				continue;
			}
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
