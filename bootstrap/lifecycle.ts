/** Launch orchestration; Herdr subprocess execution is the only injected system boundary. */
import { attemptKey, attemptNumber, blockedReviewForwardEdge, finalizeReview, finalizedReviewRejection, finishReviewFinalizations, readFinalization, revisionReserved, reviewLoopFor, reviewRoutes, reviewVerdict, settleReviewFailure, type ReviewLoop, type ReviewPlan } from "./review-loop.ts";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ensureSessionDir, generateTaskId, piAgentDir, resolveExtensionPaths, scanAgents } from "./bootstrap-utils.ts";
import { modelMatches, readBootstrapConfig, readModelAliases, resolveModel } from "./model-utils.ts";
import { planDecisions, validateGraphLimits, type DecisionPlan, type PlannedDecision, type RequestedDecision } from "./decisions.ts";
import { aggregateRun, decideAdmission, DEPENDENCY_POLICIES, deriveEdgeState, effectiveDependencyPolicy, executionFromResult, JOIN_POLICIES, NOT_EXECUTED_STATES, type CauseRef, type DependencyPolicy, type EdgeState, type EvidenceStatus, type ExecutionState, type JoinPolicy, type RunOutcome } from "./outcomes.ts";
import { requiredChecksOf, verifyEvidence } from "./evidence.ts";
import {
	atomicJson, atomicText, checkAbort, CURRENT_VERSION, DEFAULT_CLEANUP_SETTLE_MS, MAX_CLEANUP_SETTLE_MS, delay, dependencyPolicyOf, dispositionPath, dispositionRecord, errorMessage, expectationFor, GRAPH_VERSION, inboundEdgesOf, JOIN_GRAPH_VERSION, REVIEW_VERSION, lockHeld, NODE_ID_PATTERN, nodeLabel, outboundEdgesOf, parseCompletion, parseDisposition, parseWorkerConfig, parseWorkerReady, processAlive, publishExclusive,
	readJson, readyPath, resultPath, SessionStore, unknownAllowedSkills, withRunLock, workerStartupMessages,
	type AgentLaunch, type BootstrapManifest, type BootstrapResult, type CleanupMode, type Disposition, type NotExecutedEntry, type ReportEntry, type ReportReviewHistory, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import {
	cancelPath, claimOutcome, computeDownstreamBlockers, DEFAULT_CANCEL_GRACE_MS, DEFAULT_LIVENESS_MS, diagnoseLiveness, graceRemainingMs, readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe, runCancelPath, writeCancelRecord, writeRunCancelRecord,
	type CancelIdentity, type CancelRecord, type LivenessState, type ProgressSnapshot,
} from "./cancellation.ts";
import {
	boundRosterEntries, buildTaskInputRecord, canonicalJson, taskInputPath, upstreamIndexPath, validateOutputContractSyntax,
	type OutputContract, type RosterEntry,
} from "./contracts.ts";
import { currentAttempt, describeHandoff, HANDOFF_PROTOCOL, handoffClaimPath, reviewDeliveryClaimed, type HandoffView } from "./handoff.ts";
import { chainEdges, inspectRun, retryDelivery, type RecoveryDeps, type RecoveryReport, type RecoveryRequest } from "./recovery.ts";
import { evaluateNodeVerification, verificationPath, type VerificationEvaluation } from "./verification.ts";
import {
	COLLABORATION_MODES, computeOwnershipSchedule, evaluateOwnershipDependencies, FAILURE_POLICIES, normalizeOwnershipPaths, ownershipPath, parseOwnershipRecord, readFailFast, WORKSPACE_STRATEGY,
	type CollaborationMode, type FailurePolicy, type OwnershipAdmissionRecord, type OwnershipConflict, type OwnershipStatus, type OwnershipWaitDetail, type ResolvedCollaborationMode, type WorkspaceStrategy,
} from "./ownership.ts";

export interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; truncated?: boolean }
export type Executor = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;
/**
 * One requested assignment. Either the legacy form (`name` is both the persona and the node ID) or the explicit form
 * (`persona` plus an optional `node_id`, which defaults to the persona name). `predecessor`/`successor` name node IDs.
 */
export interface RequestedAgent {
	decision?: RequestedDecision;
	name?: string;
	persona?: string;
	node_id?: string;
	sub_task: string;
	role?: string;
	ownership?: string[];
	read_paths?: string[];
	write_paths?: string[];
	acceptance_criteria?: string[];
	constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	/** Chain followers: how this node's dependency on its predecessor treats the predecessor's outcome (require_success or allow_partial). */
	dependency_policy?: string;
	/** Running-task duration deadline in ms once admitted/started. */
	task_timeout_ms?: number;
	/** Dependency-wait timeout in ms without useful upstream progress (chain followers only). */
	dependency_wait_timeout_ms?: number;
	step?: number;
	predecessor?: string;
	successor?: string;
	/** Graph nodes: node IDs this node depends on. */
	depends_on?: string[];
	/** Graph joins: all_success (default) or allow_partial. */
	join_policy?: string;
}
/**
 * A validated assignment: its unique node ID, the persona it runs, its inbound edges (source node IDs), and
 * the resolved dependency policy (`require_success` by default for the node form, `allow_partial` for the legacy form).
 */
export interface PlannedNode {
	node_id: string;
	persona: string;
	sub_task: string;
	role?: string;
	ownership?: string[];
	read_paths?: string[];
	write_paths?: string[];
	acceptance_criteria?: string[];
	constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	dependency_policy?: DependencyPolicy;
	join_policy?: JoinPolicy;
	task_timeout_ms?: number;
	dependency_wait_timeout_ms?: number;
	step?: number;
	/** Source node IDs that this node depends on (one for a chain follower, none for a team or chain root). */
	inbound_edges: string[];
	predecessor?: string;
	successor?: string;
}

function plannedOutboundEdges(nodes: ReadonlyArray<PlannedNode>, nodeId: string): string[] {
	return nodes.filter(other => other.inbound_edges.includes(nodeId)).map(other => other.node_id);
}
export interface GenerateRequest {
	cleanup?: CleanupMode;
	cleanup_settle_ms?: number;
	max_total_attempts?: number;
	topology: "chain" | "team" | "graph";
	task: string;
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	collaboration_mode?: string;
	failure_policy?: string;
	agents: RequestedAgent[];
	project_cwd: string;
	request_id?: string;
	coms_extension?: string;
	ready_timeout_ms?: number;
	task_timeout_ms?: number;
	dependency_wait_timeout_ms?: number;
	liveness_timeout_ms?: number;
	cancel_grace_ms?: number;
}
interface RegistryEntry { pid: number; name: string; session_id: string; endpoint: string; cwd: string; model: string }
interface ServiceOptions {
	exec: Executor;
	extensionDir: string;
	stateDir?: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Readiness-barrier poll interval. */
	pollMs?: number;
	/** bootstrap_status wait poll interval. */
	statusPollMs?: number;
	/** Injected clock (ms since epoch) for deterministic deadline and grace-period checks. */
	now?: () => number;
	/** Optional worker signal seam for tests; defaults to best-effort Coms socket notification after durable persistence. */
	signalWorker?: (manifest: BootstrapManifest, entry: AgentLaunch, record: CancelRecord) => Promise<void>;
}
export const MAX_WAIT_MS = 1_800_000;
/** One agent's observable state, derived from durable files only (never from Herdr idle status). */
export interface AgentState {
	node_id: string;
	persona_name: string;
	attempt_id?: string;
	attempt_limit?: number;
	last_verdict?: string;
	parked?: boolean;
	finalized?: boolean;
	finalized_by?: string;
	instance_id: string;
	tab_id?: string;
	state: "pending" | "waiting" | "working" | "done" | "error" | "closed";
	/** How this node's dependency on its predecessor is gated (absent for a node without one). */
	dependency_policy?: DependencyPolicy;
	/** Launch/resource state: whether the node's tab exists and was released. Independent of what the node did (`execution`). */
	resource: AgentLaunch["status"];
	/** Where the node is in its execution, from its durable records only. */
	execution: ExecutionState;
	/** Why a node is blocked (the direct cause first, then the original ones) or needs attention. */
	execution_causes: CauseRef[];
	execution_reason?: string;
	/** The handoff into this node from its predecessor: queued (Coms acknowledged), accepted (this node claimed it) or rejected. Independent of `execution`. */
	handoff?: HandoffView;
	/** The handoff out of this node to its successor, so a source can see whether its successor accepted the exact saved input. */
	handoff_out?: HandoffView;
	/** Fan-out handoffs out of this node in a graph run, keyed by destination instance_id. */
	handoffs_out?: Record<string, HandoffView>;
	/** Join handoffs into this node in a graph run, keyed by source instance_id. */
	handoffs_in?: Record<string, HandoffView>;
	/** Join policy when this node has multiple inbound edges. */
	join_policy?: JoinPolicy;
	/** Derived inbound edge states keyed by source node_id. */
	edge_states?: Record<string, EdgeState>;
		/** Evidence for the checks this node is required to pass, judged against the project as it is now: passing, missing, unverified, stale or failed. */
	evidence?: Array<{ check: string; status: EvidenceStatus }>;
	result_status?: BootstrapResult["status"];
	summary?: string;
	delivery?: WorkerCompletion["delivery"];
	heartbeat_age_ms?: number;
	/** Time since the worker's last model/tool activity; a live heartbeat with stale activity suggests a stall. */
	activity_age_ms?: number;
	/** Liveness diagnosis (separate from execution state and running-task duration). */
	liveness?: LivenessState;
	/** Running duration since the node was admitted, if started. */
	elapsed_ms?: number;
	task_timeout_ms?: number;
	deadline_exceeded?: boolean;
	/** Durable cancellation requested while in-flight work is still settling. */
	cancelling?: boolean;
	cancel_requested_at?: string;
	grace_remaining_ms?: number;
	force_close_allowed?: boolean;
	verification?: VerificationEvaluation[];
	read_paths?: string[];
	write_paths?: string[];
	ownership_wait_for?: string[];
	ownership_status?: OwnershipStatus;
	ownership_waiting_on?: OwnershipWaitDetail[];
	error?: string;
}
export interface CancelOptions {
	agents?: string[];
	reason?: string;
	grace_ms?: number;
	force_close?: boolean;
	cwd?: string;
	signal?: AbortSignal;
}
export interface CancelResult {
	task_id: string;
	scope: "run" | "node";
	reason: string;
	requested_at: string;
	grace_ms: number;
	cancelled: string[];
	cancelling: Array<{ node_id: string; instance_id: string; grace_remaining_ms: number; force_close_allowed: boolean; note: string }>;
	already_completed: string[];
	already_settled: string[];
	blocked_dependents: Array<{ node_id: string; instance_id: string; blocked_by: string }>;
	force_closed: string[];
	record_errors?: string[];
	cleanup_errors: string[];
	cleanup_notes: string[];
	limitations: string;
	manifest: BootstrapManifest;
}
export interface RunStatus { manifest: BootstrapManifest; results: BootstrapResult[]; pending: string[]; delivery_errors: string[]; worker_errors: string[]; agents: AgentState[]; outcome: RunOutcome }
interface LiveTopology { tabs: any[]; panes: any[] }
export interface PlanPreview {
	cleanup?: CleanupMode;
	cleanup_settle_ms?: number;
	fingerprint?: string;
	max_total_attempts?: number;
	max_total_attempts_source?: DecisionPlan["max_total_attempts_source"];
	topology: "chain" | "team" | "graph";
	workspace_strategy: WorkspaceStrategy;
	collaboration_mode: ResolvedCollaborationMode;
	failure_policy: FailurePolicy;
	task: string;
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	project_cwd: string;
	coms_extension: string;
	ready_timeout_ms: number;
	task_timeout_ms?: number;
	dependency_wait_timeout_ms?: number;
	liveness_timeout_ms?: number;
	cancel_grace_ms?: number;
	ownership_conflicts: OwnershipConflict[];
	agents: Array<{
		node_id: string;
		attempt_id: string;
		instance_id: string;
		persona_name: string;
		persona_file: string;
		persona_source?: string;
		model: string;
		thinking?: string;
		tools: string[];
		extensions: string[];
		allowed_skills?: string[];
		role?: string;
		ownership?: string[];
		read_paths?: string[];
		write_paths?: string[];
		ownership_wait_for: string[];
		decision?: PlannedDecision;
		acceptance_criteria?: string[];
		constraints?: string[];
		output_contract?: OutputContract;
		required_checks?: string[];
		dependency_policy?: DependencyPolicy;
		join_policy?: JoinPolicy;
		task_timeout_ms?: number;
		dependency_wait_timeout_ms?: number;
		step?: number;
		predecessor?: string;
		successor?: string;
		inbound_edges?: string[];
		outbound_edges?: string[];
		sub_task: string;
	}>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a non-empty string without NUL characters`);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

function optionalStringList(value: unknown, field: string, maxItems = 64): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array of non-empty strings`);
	if (value.length > maxItems) throw new Error(`${field} must have at most ${maxItems} entries`);
	return value.map((item, idx) => requiredString(item, `${field}[${idx}]`));
}

/** POSIX quoting, used only inside the generated /bin/sh launcher script, which /bin/sh itself parses. */
export function shellQuote(value: string): string {
	if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL characters");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const PORTABLE_WORD = /^[A-Za-z0-9_./+-]+$/;
/**
 * The command typed into the pane's interactive shell (bash, zsh, fish, ...). It must need no quoting,
 * because quoting rules differ between shells (fish treats backslashes in single quotes as escapes).
 * Falls back to the cwd-relative path, which is always portable: the tab is created with --cwd.
 */
export function launchCommand(cwd: string, launcher: string): string {
	if (PORTABLE_WORD.test(launcher)) return `/bin/sh ${launcher}`;
	const relative = launcher.startsWith(cwd + sep) ? launcher.slice(cwd.length + 1) : undefined;
	if (relative && PORTABLE_WORD.test(relative)) return `/bin/sh ./${relative}`;
	throw new Error(`Launcher path cannot be typed portably into a shell: ${launcher}`);
}

export function executableOnPath(name: string, env: NodeJS.ProcessEnv): string {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = resolve(dir, name);
		try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
	}
	throw new Error(`Required executable "${name}" was not found on PATH`);
}

/** Which request vocabulary the caller used. Legacy requests name only personas; explicit ones name nodes. */
export function requestForm(requested: RequestedAgent[]): "legacy" | "nodes" {
	return requested.some(agent => agent.persona !== undefined || agent.node_id !== undefined) ? "nodes" : "legacy";
}

function optionalTimeoutMs(value: unknown, field: string, min = 100, max = 86_400_000): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new Error(`${field} must be an integer between ${min} and ${max}`);
	}
	return value as number;
}

/** Validate assignments and normalize the legacy `name` form into nodes. Chain order and links are derived here. */
export function normalizeAgents(topology: "chain" | "team" | "graph", requested: RequestedAgent[], projectCwd?: string): PlannedNode[] {
	if (!Array.isArray(requested) || requested.length < 1 || requested.length > 32) throw new Error("Bootstrap requires between 1 and 32 agents");
	if (topology === "graph" && requested.some(agent => agent.name !== undefined)) {
		throw new Error("Graph topology requires the node form (persona with optional node_id), not the legacy name form");
	}
	if (topology !== "graph" && requested.some(agent => agent.depends_on !== undefined)) {
		throw new Error(`depends_on is only supported for topology "graph"`);
	}
	if (topology !== "graph" && requested.some(agent => agent.join_policy !== undefined)) {
		throw new Error(`join_policy is only supported for topology "graph"`);
	}
	const seen = new Set<string>();
	const nodes = requested.map((agent, index): Omit<PlannedNode, "inbound_edges"> & { requested: RequestedAgent } => {
		const legacy = agent.name !== undefined;
		if (legacy && (agent.persona !== undefined || agent.node_id !== undefined)) throw new Error(`Agent ${index + 1}: specify either name (legacy: it is both the persona and the node ID) or persona with an optional node_id, not both`);
		if (!legacy && agent.persona === undefined) throw new Error(`Agent ${index + 1}: a persona is required (or the legacy name)`);
		const persona = requiredString(legacy ? agent.name : agent.persona, legacy ? "Agent name" : "persona").trim();
		if (!NODE_ID_PATTERN.test(persona)) throw new Error(`Unsafe ${legacy ? "agent" : "persona"} name: ${persona}`);
		const nodeId = agent.node_id === undefined ? persona : requiredString(agent.node_id, "node_id").trim();
		if (!NODE_ID_PATTERN.test(nodeId)) throw new Error(`Unsafe node ID: ${nodeId}`);
		// Node IDs identify assignments in tools, results and cleanup; persona names may repeat freely.
		if (seen.has(nodeId.toLowerCase())) throw new Error(`Duplicate node ID: ${nodeId}. Give assignments that share a persona distinct node_id values (node IDs compare case-insensitively)`);
		seen.add(nodeId.toLowerCase());
		requiredString(agent.sub_task, `sub_task for ${nodeId}`);
		const role = optionalString(agent.role, `role for ${nodeId}`);
		const ownership = optionalStringList(agent.ownership, `ownership for ${nodeId}`);
		const rawReadPaths = optionalStringList(agent.read_paths, `read_paths for ${nodeId}`);
		const rawWritePaths = optionalStringList(agent.write_paths, `write_paths for ${nodeId}`);
		const read_paths = rawReadPaths ? (projectCwd ? normalizeOwnershipPaths(projectCwd, rawReadPaths, `read_paths for ${nodeId}`) : rawReadPaths) : undefined;
		const write_paths = rawWritePaths ? (projectCwd ? normalizeOwnershipPaths(projectCwd, rawWritePaths, `write_paths for ${nodeId}`) : rawWritePaths) : undefined;
		const acceptance_criteria = optionalStringList(agent.acceptance_criteria, `acceptance_criteria for ${nodeId}`, 32);
		const constraints = optionalStringList(agent.constraints, `constraints for ${nodeId}`, 32);
		const output_contract = agent.output_contract !== undefined ? validateOutputContractSyntax(agent.output_contract, nodeId) : undefined;
		const required_checks = optionalStringList(agent.required_checks, `required_checks for ${nodeId}`, 32);
		const task_timeout_ms = optionalTimeoutMs(agent.task_timeout_ms, `task_timeout_ms for ${nodeId}`);
		const dependency_wait_timeout_ms = optionalTimeoutMs(agent.dependency_wait_timeout_ms, `dependency_wait_timeout_ms for ${nodeId}`);
		return {
			node_id: nodeId, persona, sub_task: agent.sub_task,
			...(role !== undefined ? { role } : {}),
			...(ownership !== undefined ? { ownership } : {}),
			...(read_paths !== undefined ? { read_paths } : {}),
			...(write_paths !== undefined ? { write_paths } : {}),
			...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			...(output_contract !== undefined ? { output_contract } : {}),
			...(required_checks !== undefined ? { required_checks } : {}),
			...(task_timeout_ms !== undefined ? { task_timeout_ms } : {}),
			...(dependency_wait_timeout_ms !== undefined ? { dependency_wait_timeout_ms } : {}),
			step: agent.step, predecessor: agent.predecessor, successor: agent.successor, requested: agent,
		};
	});
	if (topology === "team") {
		if (nodes.some(node => node.step !== undefined || node.predecessor || node.successor)) throw new Error("Team agents cannot declare chain links or steps");
		if (nodes.some(node => node.requested.dependency_policy !== undefined)) throw new Error("Team agents cannot declare a dependency policy: a team has no dependencies");
		if (nodes.some(node => node.dependency_wait_timeout_ms !== undefined)) throw new Error("Team agents cannot declare a dependency wait timeout: a team has no dependencies");
		return nodes.map(({ requested: _requested, step: _step, predecessor: _predecessor, successor: _successor, ...node }) => ({ ...node, inbound_edges: [] }));
	}
	if (topology === "graph") {
		if (nodes.some(node => node.step !== undefined || node.predecessor || node.successor)) {
			throw new Error("Graph nodes cannot declare chain steps, predecessor, or successor; use depends_on");
		}
		const byLowerId = new Map(nodes.map(node => [node.node_id.toLowerCase(), node]));
		const planned = nodes.map(node => {
			const rawDeps = optionalStringList(node.requested.depends_on, `depends_on for ${node.node_id}`);
			const inboundEdges: string[] = [];
			const seenDeps = new Set<string>();
			for (const dep of rawDeps ?? []) {
				const target = byLowerId.get(dep.trim().toLowerCase());
				if (!target) throw new Error(`Unknown dependency "${dep}" for node ${node.node_id}`);
				if (target.node_id === node.node_id) throw new Error(`Node ${node.node_id} cannot depend on itself`);
				if (seenDeps.has(target.node_id)) throw new Error(`Duplicate dependency "${target.node_id}" for node ${node.node_id}`);
				seenDeps.add(target.node_id);
				inboundEdges.push(target.node_id);
			}
			if (inboundEdges.length === 0) {
				if (node.requested.dependency_policy !== undefined) throw new Error(`${node.node_id} has no dependencies, so it cannot declare a dependency policy`);
				if (node.dependency_wait_timeout_ms !== undefined) throw new Error(`${node.node_id} has no dependencies, so it cannot declare a dependency wait timeout`);
			} else if (node.requested.dependency_policy !== undefined && !(DEPENDENCY_POLICIES as readonly string[]).includes(node.requested.dependency_policy)) {
				throw new Error(`dependency_policy for ${node.node_id} must be ${DEPENDENCY_POLICIES.join(" or ")}`);
			}
			if (inboundEdges.length <= 1 && node.requested.join_policy !== undefined) {
				throw new Error(`${node.node_id} is not a join (it has ${inboundEdges.length} ${inboundEdges.length === 1 ? "dependency" : "dependencies"}), so it cannot declare join_policy`);
			}
			if (node.requested.join_policy !== undefined && !(JOIN_POLICIES as readonly string[]).includes(node.requested.join_policy)) {
				throw new Error(`join_policy for ${node.node_id} must be ${JOIN_POLICIES.join(" or ")}`);
			}
			const joinPolicy: JoinPolicy | undefined = inboundEdges.length > 1
				? ((node.requested.join_policy as JoinPolicy | undefined) ?? "all_success")
				: undefined;
			const policy: DependencyPolicy | undefined = inboundEdges.length > 0
				? ((node.requested.dependency_policy as DependencyPolicy | undefined) ?? (joinPolicy === "allow_partial" ? "allow_partial" : "require_success"))
				: undefined;
			if (joinPolicy === "all_success" && policy === "allow_partial") {
				throw new Error(`${node.node_id} cannot combine join_policy "all_success" with dependency_policy "allow_partial"`);
			}
			const { requested: _requested, step: _step, predecessor: _p, successor: _s, ...rest } = node;
			return {
				...rest,
				inbound_edges: inboundEdges,
				...(inboundEdges[0] !== undefined ? { predecessor: inboundEdges[0] } : {}),
				...(policy !== undefined ? { dependency_policy: policy } : {}),
				...(joinPolicy !== undefined ? { join_policy: joinPolicy } : {}),
			};
		});
		// Detect dependency cycles (3-color DFS).
		const visitState = new Map<string, "visiting" | "visited">();
		const plannedById = new Map(planned.map(node => [node.node_id, node]));
		const visit = (id: string, stack: string[]) => {
			const state = visitState.get(id);
			if (state === "visited") return;
			if (state === "visiting") {
				const cycle = [...stack.slice(stack.indexOf(id)), id];
				throw new Error(`Dependency cycle detected in graph: ${cycle.join(" -> ")}`);
			}
			visitState.set(id, "visiting");
			for (const dep of plannedById.get(id)!.inbound_edges) visit(dep, [...stack, id]);
			visitState.set(id, "visited");
		};
		for (const node of planned) visit(node.node_id, []);
		return planned;
	}
	const explicitSteps = nodes.some(node => node.step !== undefined);
	if (explicitSteps) {
		if (nodes.some(node => !Number.isInteger(node.step) || node.step! < 1 || node.step! > nodes.length)) throw new Error("Chain steps must be contiguous integers from 1 to the number of agents");
		nodes.sort((a, b) => a.step! - b.step!);
		if (nodes.some((node, i) => node.step !== i + 1)) throw new Error("Chain steps must be unique and contiguous");
	}
	const form = requestForm(requested);
	return nodes.map((node, i) => {
		const predecessor = nodes[i - 1]?.node_id;
		const successor = nodes[i + 1]?.node_id;
		const declared = node.requested;
		if (i === 0 && declared.dependency_policy !== undefined) throw new Error(`${node.node_id} is the first step and has no dependency, so it cannot declare a dependency policy`);
		if (i === 0 && node.dependency_wait_timeout_ms !== undefined) throw new Error(`${node.node_id} is the first step and has no dependency, so it cannot declare a dependency wait timeout`);
		let dependency: { dependency_policy: DependencyPolicy } | undefined;
		if (i > 0) {
			if (declared.dependency_policy !== undefined && !(DEPENDENCY_POLICIES as readonly string[]).includes(declared.dependency_policy)) throw new Error(`dependency_policy for ${node.node_id} must be ${DEPENDENCY_POLICIES.join(" or ")}`);
			// New-format plans require a successful predecessor unless told otherwise; the legacy form keeps its original allowance.
			const policy = (declared.dependency_policy as DependencyPolicy | undefined) ?? (form === "nodes" ? "require_success" : "allow_partial");
			dependency = { dependency_policy: policy };
		}
		// The chain's ends may be named "dispatcher" (or left empty) by callers.
		const end = (value: string) => ["", "dispatcher"].includes(value.trim().toLowerCase());
		if (node.predecessor !== undefined && (predecessor ? node.predecessor.trim().toLowerCase() !== predecessor.toLowerCase() : !end(node.predecessor))) throw new Error(`Invalid predecessor for ${node.node_id}`);
		if (node.successor !== undefined && (successor ? node.successor.trim().toLowerCase() !== successor.toLowerCase() : !end(node.successor))) throw new Error(`Invalid successor for ${node.node_id}`);
		const { requested: _requested, predecessor: _p, successor: _s, ...rest } = node;
		return { ...rest, step: i + 1, inbound_edges: predecessor ? [predecessor] : [], predecessor, successor, ...dependency };
	});
}

/** Select agents by stable identity: instance ID or node ID first, then a persona name only when it names exactly one node. */
export function selectAgents(entries: AgentLaunch[], selector: string): AgentLaunch[] {
	const wanted = selector.trim().toLowerCase();
	const byIdentity = entries.filter(entry => entry.instance_id === wanted || entry.node_id.toLowerCase() === wanted);
	if (byIdentity.length > 1) throw new Error(`Ambiguous agent selector "${selector}": it matches ${byIdentity.map(entry => `${entry.node_id} (${entry.instance_id})`).join(", ")}. Use an instance ID`);
	if (byIdentity.length === 1) return byIdentity;
	const byPersona = entries.filter(entry => entry.persona_name.toLowerCase() === wanted);
	if (byPersona.length > 1) throw new Error(`Ambiguous agent selector "${selector}": persona ${byPersona[0].persona_name} is used by nodes ${byPersona.map(entry => `${entry.node_id} (${entry.instance_id})`).join(", ")}. Select by node ID or instance ID`);
	return byPersona;
}

/** The node a reported result belongs to, or undefined when it names none. A persona shared by several nodes needs a node_id. */
function resultNode(entries: AgentLaunch[], result: { node_id?: string; agent_name?: string }): AgentLaunch | undefined {
	if (result.node_id !== undefined) {
		const entry = entries.find(entry => entry.node_id.toLowerCase() === result.node_id!.trim().toLowerCase());
		if (entry && result.agent_name !== undefined && result.agent_name.toLowerCase() !== entry.persona_name.toLowerCase()) throw new Error(`Result for node ${entry.node_id} names persona ${result.agent_name}, but that node runs ${entry.persona_name}`);
		return entry;
	}
	if (result.agent_name === undefined) throw new Error("Each result needs a node_id (or an agent_name that names exactly one node)");
	const matches = entries.filter(entry => entry.persona_name.toLowerCase() === result.agent_name!.trim().toLowerCase());
	if (matches.length > 1) throw new Error(`Result names persona ${result.agent_name}, which is used by nodes ${matches.map(entry => entry.node_id).join(", ")}; supply node_id`);
	return matches[0];
}

function checkAllowedSkills(entry: AgentLaunch, ready: WorkerReady): void {
	if (!ready.unmatched_skills?.length) return;
	entry.error = unknownAllowedSkills(entry.persona_name, ready.unmatched_skills);
	throw new Error(`${nodeLabel(entry)}: ${entry.error}`);
}

export class BootstrapService {
	readonly store: SessionStore;
	private readonly env: NodeJS.ProcessEnv;
	private readonly home: string;
	private readonly options: ServiceOptions;
	constructor(options: ServiceOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.home = options.home ?? homedir();
		this.store = new SessionStore(options.stateDir ?? this.env.PI_BOOTSTRAP_STATE_DIR ?? join(this.home, ".pi", "agent", "bootstrap-sessions"));
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	private cancelIdentity(manifest: BootstrapManifest, entry: AgentLaunch, attemptId = manifest.review_plan ? undefined : entry.attempt_id): CancelIdentity {
		return {
			run_id: manifest.task_id,
			node_id: entry.node_id,
			persona_name: entry.persona_name,
			...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
			instance_id: entry.instance_id,
		};
	}

	private attemptRecord(manifest: BootstrapManifest, entry: AgentLaunch) {
		const current = currentAttempt(manifest, entry);
		const key = attemptKey(manifest.review_plan, entry.instance_id, current?.number);
		const attempt_id = manifest.review_plan ? key : entry.attempt_id;
		return { key, attempt_id, current, expected: { ...expectationFor(manifest, entry), attempt_id } };
	}

	private readAttemptForCancel(manifest: BootstrapManifest, entry: AgentLaunch, problems: Map<string, string>) {
		try { return this.attemptRecord(manifest, entry); }
		catch (error) {
			problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private async signalNode(manifest: BootstrapManifest, entry: AgentLaunch, record: CancelRecord): Promise<void> {
		if (this.options.signalWorker) {
			await this.options.signalWorker(manifest, entry, record);
			return;
		}
		// Best-effort Coms wake-up if a live Unix socket endpoint exists; durable cancel files remain primary.
		const readyFile = readyPath(manifest.session_dir, entry.instance_id);
		if (!existsSync(readyFile)) return;
		try {
			const ready = parseWorkerReady(readJson<unknown>(readyFile));
			if (!ready.endpoint || !existsSync(ready.endpoint)) return;
			await new Promise<void>(resolve => {
				const socket = createConnection(ready.endpoint);
				const done = () => { socket.destroy(); resolve(); };
				socket.setTimeout(500, done);
				socket.on("error", done);
				socket.on("connect", () => {
					socket.write(JSON.stringify({
						type: "prompt",
						msg_id: `cancel-${randomUUID()}`,
						sender_session: manifest.dispatcher_session_id ?? "bootstrap-dispatcher",
						sender_endpoint: "",
						sender_name: manifest.dispatcher_coms_name ?? "bootstrap",
						sender_cwd: manifest.project_cwd,
						hops: 0,
						timestamp: new Date(this.now()).toISOString(),
						prompt: `bootstrap-cancel:${manifest.token}:${entry.instance_id}\n${record.reason}`,
					}) + "\n", done);
				});
			});
		} catch { /* socket unavailable; durable cancel file is authoritative */ }
	}

	private async command(args: string[], signal?: AbortSignal): Promise<string> {
		checkAbort(signal);
		const result = await this.options.exec("herdr", args, { signal, timeout: 15_000, maxBuffer: 1024 * 1024 });
		if (result.code !== 0 || result.killed || result.truncated) {
			throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed${result.killed ? " (cancelled or timed out; outcome may be ambiguous)" : ""}: ${(result.stderr || result.stdout || `exit ${result.code}`).slice(0, 3000)}`);
		}
		return result.stdout;
	}

	private async json(args: string[], signal?: AbortSignal): Promise<any> {
		const output = await this.command(args, signal);
		let parsed: any;
		try { parsed = JSON.parse(output); } catch { throw new Error(`herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`); }
		if (!parsed || typeof parsed !== "object" || parsed.error) throw new Error(`herdr API error: ${JSON.stringify(parsed?.error ?? parsed).slice(0, 1000)}`);
		return parsed.result ?? parsed;
	}

	private async workspace(signal?: AbortSignal): Promise<string> {
		if (this.env.HERDR_ENV !== "1") throw new Error("Bootstrap must run inside a Herdr-managed pane (HERDR_ENV=1)");
		const paneId = requiredString(this.env.HERDR_PANE_ID, "HERDR_PANE_ID");
		const response = await this.json(["pane", "get", paneId], signal);
		const workspaceId = requiredString(response.pane?.workspace_id, "Originating pane workspace_id");
		// Never substitute the currently focused workspace for the caller's workspace.
		return workspaceId;
	}

	private comsExtension(cwd: string, explicit?: string): string {
		const candidates = explicit ? [resolve(cwd, explicit)] : [join(cwd, "extensions", "coms.ts"), join(this.options.extensionDir, "coms.ts")];
		for (const candidate of candidates) {
			try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.R_OK); return realpathSync(candidate); } } catch { /* try next */ }
		}
		throw new Error(`Required Coms extension not found. Install extensions/coms.ts in the project or pass coms_extension as an absolute path. Checked: ${candidates.join(", ")}`);
	}

	private dispatcher(): RegistryEntry | undefined {
		const root = join(this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), "projects");
		if (!existsSync(root)) return;
		for (const project of readdirSync(root)) {
			const dir = join(root, project, "agents");
			try {
				for (const file of readdirSync(dir).filter(file => file.endsWith(".json"))) {
					try { const entry = readJson<RegistryEntry>(join(dir, file)); if (entry.pid === process.pid) return entry; } catch { /* stale record */ }
				}
			} catch { /* unreadable project */ }
		}
	}

	/** Validate a request and resolve everything a launch needs, without touching Herdr or the filesystem state. */
	private prepare(request: GenerateRequest, model?: { provider: string; id: string }) {
		if (process.platform === "win32") throw new Error("Bootstrap currently requires POSIX /bin/sh; Windows launching is not supported");
		if (request.topology !== "chain" && request.topology !== "team" && request.topology !== "graph") throw new Error("Invalid topology");
		if (request.cleanup !== undefined && request.cleanup !== "on_success" && request.cleanup !== "manual") {
			throw new Error('cleanup must be "on_success" or "manual"');
		}
		const cleanup = request.cleanup ?? (request.topology === "graph" ? "on_success" : "manual");
		const cleanupSettleMs = optionalTimeoutMs(request.cleanup_settle_ms, "cleanup_settle_ms", 0, MAX_CLEANUP_SETTLE_MS) ?? DEFAULT_CLEANUP_SETTLE_MS;
		const requestedStrategy = (request as { workspace_strategy?: unknown }).workspace_strategy;
		if (requestedStrategy !== undefined && requestedStrategy !== WORKSPACE_STRATEGY) {
			throw new Error(`Unsupported workspace_strategy ${JSON.stringify(requestedStrategy)}: only "${WORKSPACE_STRATEGY}" is supported in this release`);
		}
		requiredString(request.task, "task");
		const goal = optionalString(request.goal, "goal");
		const acceptance_criteria = optionalStringList(request.acceptance_criteria, "acceptance_criteria", 32);
		const constraints = optionalStringList(request.constraints, "constraints", 32);
		if (!isAbsolute(requiredString(request.project_cwd, "project_cwd"))) throw new Error("project_cwd must be absolute");
		const cwd = realpathSync(request.project_cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("project_cwd must be a directory");
		if (request.collaboration_mode !== undefined && !(COLLABORATION_MODES as readonly string[]).includes(request.collaboration_mode)) {
			throw new Error(`collaboration_mode must be ${COLLABORATION_MODES.join(" or ")}`);
		}
		if (request.failure_policy !== undefined && !(FAILURE_POLICIES as readonly string[]).includes(request.failure_policy)) {
			throw new Error(`failure_policy must be ${FAILURE_POLICIES.join(" or ")}`);
		}
		const form = requestForm(request.agents);
		const collaborationMode: ResolvedCollaborationMode = (request.collaboration_mode as CollaborationMode | undefined)
			?? (form === "nodes" ? "independent" : "legacy");
		const failurePolicy: FailurePolicy = (request.failure_policy as FailurePolicy | undefined) ?? "independent";
		const nodes = normalizeAgents(request.topology, request.agents, cwd);
		const readyTimeout = request.ready_timeout_ms ?? 60_000;
		if (!Number.isInteger(readyTimeout) || readyTimeout < 100 || readyTimeout > 300_000) throw new Error("ready_timeout_ms must be an integer between 100 and 300000");
		const taskTimeout = optionalTimeoutMs(request.task_timeout_ms, "task_timeout_ms");
		const dependencyWaitTimeout = optionalTimeoutMs(request.dependency_wait_timeout_ms, "dependency_wait_timeout_ms");
		const livenessTimeout = optionalTimeoutMs(request.liveness_timeout_ms, "liveness_timeout_ms");
		const cancelGrace = optionalTimeoutMs(request.cancel_grace_ms, "cancel_grace_ms", 0, 300_000);
		const agentDir = piAgentDir(this.env, this.home);
		const globalConfigPath = join(agentDir, "bootstrap.json");
		const projectConfigPath = join(cwd, ".pi", "bootstrap.json");
		const globalConfig = readBootstrapConfig(globalConfigPath);
		const projectConfig = readBootstrapConfig(projectConfigPath);
		const aliases = new Map([
			...readModelAliases(globalConfigPath, globalConfig),
			...readModelAliases(projectConfigPath, projectConfig),
		]);
		const globalLimits = validateGraphLimits(globalConfigPath, globalConfig.graph);
		const projectLimits = validateGraphLimits(projectConfigPath, projectConfig.graph);
		const decisionPlan = planDecisions(request, nodes, projectLimits, globalLimits);
		const available = scanAgents(cwd, agentDir);
		const mapped = nodes.map(node => {
			const def = available.find(def => def.name.toLowerCase() === node.persona.toLowerCase());
			if (!def) throw new Error(`Agent "${node.persona}" not found. Available: ${available.map(def => def.name).join(", ") || "none"}`);
			if (def.allowedSkills?.includes("none")) {
				throw new Error(`${def.file} ("skills"): An empty \`skills:\` field means no skills. A skill named "none" cannot be allowed.`);
			}
			// Project extensions win; a global persona also finds extensions beside its own agents directory.
			const extensions = resolveExtensionPaths(cwd, def.extensions ?? [], [join(dirname(dirname(def.file)), "extensions"), this.options.extensionDir])
				.map(path => realpathSync(path));
			return { node, def, extensions, resolvedModel: resolveModel(def, model, aliases) };
		});
		const coms = this.comsExtension(cwd, request.coms_extension);
		const worker = realpathSync(join(this.options.extensionDir, "bootstrap", "worker.ts"));
		accessSync(worker, constants.R_OK);
		const piBinary = executableOnPath("pi", this.env);
		executableOnPath("herdr", this.env);
		// The worker instance is derived from the node (unique), never from the persona (which may repeat).
		const instances = mapped.map(({ node }, i) => `a${i + 1}-${node.node_id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`);
		const instanceByNodeId = new Map(mapped.map(({ node }, i) => [node.node_id, instances[i]]));
		const inbound = mapped.map(({ node }) => node.inbound_edges.map(sourceId => instanceByNodeId.get(sourceId)!));
		const outbound = mapped.map(({ node }) => plannedOutboundEdges(nodes, node.node_id).map(destId => instanceByNodeId.get(destId)!));
		const attempts = instances.map(instance => `${instance}.1`);
		const ownershipSchedule = computeOwnershipSchedule(mapped.map(({ node }, i) => ({
			node_id: node.node_id,
			instance_id: instances[i],
			read_paths: node.read_paths,
			write_paths: node.write_paths,
		})));
		const allowedSkills = mapped.some(({ def }) => def.allowedSkills !== undefined)
			? mapped.map(({ def }) => def.allowedSkills ?? null)
			: undefined;
		const thinking = mapped.map(({ resolvedModel }) => resolvedModel.thinking ?? null);
		return { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, form, collaborationMode, failurePolicy, nodes, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, mapped, coms, worker, piBinary, instances, inbound, outbound, attempts, ownershipSchedule, decisionPlan, allowedSkills, thinking };
	}

	/**
	 * Fingerprint of the plan's meaning, independent of JSON key order and of omitted-vs-explicit defaults,
	 * so an equivalent retry with the same request_id is recognized as the same plan. A plan whose node IDs are
	 * all its persona names and sets no thinking levels keeps the exact fingerprint the
	 * previous release wrote, so old request IDs still find their runs after an upgrade.
	 */
	private fingerprint(request: GenerateRequest, cwd: string, nodes: PlannedNode[], readyTimeout: number, thinking: (string | null)[], model?: { provider: string; id: string }, withOutcomes = true, collaborationMode?: ResolvedCollaborationMode, failurePolicy?: FailurePolicy, withTeamPolicies = true, allowedSkills?: Array<string[] | null>, decisionPlan?: DecisionPlan): string {
		const hasOwnershipPaths = nodes.some(node => node.read_paths !== undefined || node.write_paths !== undefined);
		const hasBriefOrContract = request.goal !== undefined || request.acceptance_criteria !== undefined || request.constraints !== undefined
			|| hasOwnershipPaths
			|| nodes.some(node => node.role !== undefined || node.ownership !== undefined || node.acceptance_criteria !== undefined
				|| node.constraints !== undefined || node.output_contract !== undefined || node.required_checks !== undefined);
		// Only a plan that sets dependency policies says so: every plan that behaves as the previous release did keeps its earlier fingerprint.
		const outcomes = withOutcomes && this.usesOutcomes(nodes) ? { outcomes: nodes.map(node => node.dependency_policy ?? null) } : {};
		const hasDeadlines = request.task_timeout_ms !== undefined || request.dependency_wait_timeout_ms !== undefined
			|| request.liveness_timeout_ms !== undefined || request.cancel_grace_ms !== undefined
			|| nodes.some(node => node.task_timeout_ms !== undefined || node.dependency_wait_timeout_ms !== undefined);
		const deadlines = hasDeadlines ? {
			deadlines: {
				task_timeout_ms: request.task_timeout_ms ?? null,
				dependency_wait_timeout_ms: request.dependency_wait_timeout_ms ?? null,
				liveness_timeout_ms: request.liveness_timeout_ms ?? null,
				cancel_grace_ms: request.cancel_grace_ms ?? null,
				nodes: nodes.map(node => ({ task_timeout_ms: node.task_timeout_ms ?? null, dependency_wait_timeout_ms: node.dependency_wait_timeout_ms ?? null })),
			},
		} : {};
		const teamPolicies: Record<string, unknown> = {};
		// Legacy mode ("legacy") keeps the previous release's fingerprint; explicit/defaulted "independent" or "collaborative" modes are part of the plan.
		if (withTeamPolicies && collaborationMode && collaborationMode !== "legacy") teamPolicies.collaboration_mode = collaborationMode;
		if (withTeamPolicies && failurePolicy && failurePolicy !== "independent") teamPolicies.failure_policy = failurePolicy;
		const personaKeyed = nodes.every(node => node.node_id.toLowerCase() === node.persona.toLowerCase());
		const effectiveThinking = thinking.some(level => level !== null) ? { thinking } : {};
		const canonical = hasBriefOrContract ? {
			v: 4, topology: request.topology, task: request.task, goal: request.goal ?? null,
			acceptance_criteria: request.acceptance_criteria ?? null, constraints: request.constraints ?? null,
			project_cwd: cwd, ready_timeout_ms: readyTimeout,
			coms_extension: request.coms_extension ? resolve(cwd, request.coms_extension) : null,
			agents: nodes.map(node => ({
				node_id: node.node_id.toLowerCase(), persona: node.persona.toLowerCase(), sub_task: node.sub_task, step: node.step ?? null,
				role: node.role ?? null, ownership: node.ownership ?? null,
				...(hasOwnershipPaths ? { read_paths: node.read_paths ?? null, write_paths: node.write_paths ?? null } : {}),
				acceptance_criteria: node.acceptance_criteria ?? null, constraints: node.constraints ?? null,
				output_contract: node.output_contract ?? null, required_checks: node.required_checks ?? null,
			})),
			model: model ? `${model.provider}/${model.id}` : null,
			...outcomes,
			...deadlines,
			...teamPolicies,
			...effectiveThinking,
		} : {
			v: personaKeyed ? 2 : 3, topology: request.topology, task: request.task, project_cwd: cwd, ready_timeout_ms: readyTimeout,
			coms_extension: request.coms_extension ? resolve(cwd, request.coms_extension) : null,
			agents: nodes.map(node => personaKeyed ? [node.persona.toLowerCase(), node.sub_task, node.step ?? null] : [node.node_id.toLowerCase(), node.persona.toLowerCase(), node.sub_task, node.step ?? null]),
			model: model ? `${model.provider}/${model.id}` : null,
			...outcomes,
			...deadlines,
			...teamPolicies,
			...effectiveThinking,
		};
		const cleanupDefaults = request.topology === "graph" ? "on_success" : "manual";
		const cleanupOptions = {
			...(request.cleanup !== undefined && request.cleanup !== cleanupDefaults ? { cleanup: request.cleanup } : {}),
			...(request.cleanup_settle_ms !== undefined && request.cleanup_settle_ms !== DEFAULT_CLEANUP_SETTLE_MS ? { cleanup_settle_ms: request.cleanup_settle_ms } : {}),
		};
		const resolved = { ...canonical, ...(allowedSkills ? { allowed_skills: allowedSkills } : {}), ...cleanupOptions };
		if (request.topology === "graph") {
			const graphCanonical = {
				...resolved,
				v: 5,
				graph_edges: nodes.map(node => ({
					node_id: node.node_id.toLowerCase(),
					inbound_edges: node.inbound_edges.map(dep => dep.toLowerCase()),
					dependency_policy: node.dependency_policy ?? null,
					...(node.join_policy !== undefined ? { join_policy: node.join_policy } : {}),
				})),
				...(decisionPlan ? (() => {
					const { decisions, ...limits } = decisionPlan;
					return {
						...limits,
						decisions: nodes.map(node => {
							const decision = decisions.get(node.node_id);
							return decision ? {
								...decision, on_reject: decision.on_reject.toLowerCase(),
								loop_body: decision.loop_body.map(id => id.toLowerCase()),
							} : null;
						}),
					};
				})() : {}),
			};
			return createHash("sha256").update(canonicalJson(graphCanonical)).digest("hex");
		}
		if (decisionPlan) {
			const { decisions, ...limits } = decisionPlan;
			return createHash("sha256").update(canonicalJson({
				...resolved, v: 5, ...limits,
				decisions: nodes.map(node => {
					const decision = decisions.get(node.node_id);
					return decision ? {
						...decision, on_reject: decision.on_reject.toLowerCase(),
						loop_body: decision.loop_body.map(id => id.toLowerCase()),
					} : null;
				}),
			})).digest("hex");
		}
		return createHash("sha256").update(hasBriefOrContract ? canonicalJson(resolved) : JSON.stringify(resolved)).digest("hex");
	}

	/** Whether the plan asks for anything the previous release could not do: a dependency that requires a successful predecessor. */
	private usesOutcomes(nodes: PlannedNode[]): boolean {
		return nodes.some(node => node.dependency_policy === "require_success");
	}

	/** Fingerprint written before canonical fingerprints existed; only a legacy-form request can match one. */
	private oldestFingerprint(request: GenerateRequest, cwd: string, nodes: PlannedNode[], model?: { provider: string; id: string }): string | undefined {
		if (requestForm(request.agents) !== "legacy") return undefined;
		const original = (node: PlannedNode) => request.agents.find(agent => agent.name!.trim().toLowerCase() === node.node_id.toLowerCase())!;
		const agents = request.topology === "team" ? request.agents.map(agent => ({ ...agent, name: agent.name!.trim() }))
			: nodes.map(node => ({ ...original(node), name: node.node_id, step: node.step, predecessor: node.inbound_edges[0], successor: plannedOutboundEdges(nodes, node.node_id)[0] }));
		const { cleanup: _cleanup, cleanup_settle_ms: _settle, ...legacyRequest } = request;
		return createHash("sha256").update(JSON.stringify({ ...legacyRequest, project_cwd: cwd, agents, request_id: undefined, model })).digest("hex");
	}

	/** Dry run: the complete resolved plan (personas, models, tools, extensions, links) without creating anything. */
	plan(request: GenerateRequest, model?: { provider: string; id: string }): PlanPreview {
		const prepared = this.prepare(request, model);
		const { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, collaborationMode, failurePolicy, nodes, mapped, coms, instances, inbound, outbound, attempts, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, ownershipSchedule, decisionPlan } = prepared;
		const showCleanup = request.cleanup !== undefined || request.cleanup_settle_ms !== undefined || request.topology === "graph";
		return {
			...(showCleanup ? { cleanup, cleanup_settle_ms: cleanupSettleMs } : {}),
			...(showCleanup || decisionPlan ? { fingerprint: this.preparedFingerprint(request, model, prepared) } : {}),
			...(decisionPlan ? {
				max_total_attempts: decisionPlan.max_total_attempts,
				max_total_attempts_source: decisionPlan.max_total_attempts_source,
			} : {}),
			topology: request.topology, workspace_strategy: WORKSPACE_STRATEGY, collaboration_mode: collaborationMode, failure_policy: failurePolicy, task: request.task,
			...(goal !== undefined ? { goal } : {}),
			...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			project_cwd: cwd, coms_extension: coms, ready_timeout_ms: readyTimeout,
			...(taskTimeout !== undefined ? { task_timeout_ms: taskTimeout } : {}),
			...(dependencyWaitTimeout !== undefined ? { dependency_wait_timeout_ms: dependencyWaitTimeout } : {}),
			...(livenessTimeout !== undefined ? { liveness_timeout_ms: livenessTimeout } : {}),
			...(cancelGrace !== undefined ? { cancel_grace_ms: cancelGrace } : {}),
			ownership_conflicts: ownershipSchedule.conflicts,
			agents: mapped.map(({ node, def, extensions, resolvedModel }, i) => {
				const decision = decisionPlan?.decisions.get(node.node_id);
				const effectiveTaskTimeout = node.task_timeout_ms ?? taskTimeout;
				const effectiveDepWait = node.inbound_edges.length > 0 ? (node.dependency_wait_timeout_ms ?? dependencyWaitTimeout) : undefined;
				return {
					node_id: node.node_id, attempt_id: attempts[i], instance_id: instances[i], persona_name: def.name, persona_file: def.file, persona_source: def.source, model: resolvedModel.model,
					...(resolvedModel.thinking !== undefined ? { thinking: resolvedModel.thinking } : {}),
					tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), extensions: [...new Set(extensions)],
					...(def.allowedSkills !== undefined ? { allowed_skills: def.allowedSkills } : {}),
					...(node.role !== undefined ? { role: node.role } : {}),
					...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
					...(node.read_paths !== undefined ? { read_paths: node.read_paths } : {}),
					...(node.write_paths !== undefined ? { write_paths: node.write_paths } : {}),
					ownership_wait_for: ownershipSchedule.waitsFor.get(instances[i]) ?? [],
					...(node.acceptance_criteria !== undefined ? { acceptance_criteria: node.acceptance_criteria } : {}),
					...(node.constraints !== undefined ? { constraints: node.constraints } : {}),
					...(node.output_contract !== undefined ? { output_contract: node.output_contract } : {}),
					...(decision ? { decision } : {}),
					...(node.required_checks !== undefined ? { required_checks: node.required_checks } : {}),
					step: node.step,
					predecessor: inbound[i][0], successor: outbound[i][0],
					...(request.topology === "graph" ? { inbound_edges: node.inbound_edges, outbound_edges: plannedOutboundEdges(nodes, node.node_id) } : {}),
					dependency_policy: node.dependency_policy,
					...(node.join_policy !== undefined ? { join_policy: node.join_policy } : {}),
					...(effectiveTaskTimeout !== undefined ? { task_timeout_ms: effectiveTaskTimeout } : {}),
					...(effectiveDepWait !== undefined ? { dependency_wait_timeout_ms: effectiveDepWait } : {}),
					sub_task: node.sub_task,
				};
			}),
		};
	}

	private preparedFingerprint(request: GenerateRequest, model: { provider: string; id: string } | undefined,
		{ cwd, nodes, readyTimeout, thinking, collaborationMode, failurePolicy, allowedSkills, decisionPlan }: ReturnType<BootstrapService["prepare"]>): string {
		return this.fingerprint(request, cwd, nodes, readyTimeout, thinking, model, true, collaborationMode, failurePolicy, true, allowedSkills, decisionPlan);
	}

	async generate(request: GenerateRequest, model?: { provider: string; id: string }, signal?: AbortSignal, update?: (manifest: BootstrapManifest) => void): Promise<BootstrapManifest> {
		checkAbort(signal);
		const prepared = this.prepare(request, model);
		const { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, form, collaborationMode, failurePolicy, nodes, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, mapped, coms, worker, piBinary, instances, inbound, outbound, attempts, ownershipSchedule, decisionPlan, allowedSkills, thinking } = prepared;
		const instanceFor = (id: string) => instances[nodes.findIndex(node => node.node_id === id)];
		const reviewPlan: ReviewPlan | undefined = decisionPlan && {
			max_total_attempts: decisionPlan.max_total_attempts,
			max_total_attempts_source: decisionPlan.max_total_attempts_source,
			node_count: nodes.length,
			loops: [...decisionPlan.decisions].map(([id, decision]) => ({
				...decision, reviewer: instanceFor(id), target: instanceFor(decision.on_reject), members: decision.loop_body.map(instanceFor),
			})),
		};
		if (reviewPlan && reviewPlan.max_total_attempts < reviewPlan.node_count) {
			throw new Error("max_total_attempts must cover the first attempt of every planned node");
		}
		const fingerprint = this.preparedFingerprint(request, model, prepared);
		const isGraph = request.topology === "graph";
		// A reservation predating canonical fingerprints has neither a thinking level nor allowed skills.
		const legacyFingerprint = cleanup === "manual" && cleanupSettleMs === DEFAULT_CLEANUP_SETTLE_MS && !reviewPlan && !isGraph && allowedSkills === undefined && thinking.every(level => level === null) ? this.oldestFingerprint(request, cwd, nodes, model) : undefined;
		// Pre-09 node-form runs lacked collaboration_mode/failure_policy (and pre-04 runs also lacked dependency_policy).
		const usesDefaultTeamPolicies = !reviewPlan && !isGraph && collaborationMode === "independent" && failurePolicy === "independent" && !nodes.some(node => node.read_paths !== undefined || node.write_paths !== undefined);
		const pre09Fingerprint = usesDefaultTeamPolicies ? this.fingerprint(request, cwd, nodes, readyTimeout, thinking, model, true, collaborationMode, failurePolicy, false, allowedSkills) : undefined;
		const pre04Fingerprint = usesDefaultTeamPolicies && this.usesOutcomes(nodes) ? this.fingerprint(request, cwd, nodes, readyTimeout, thinking, model, false, collaborationMode, failurePolicy, false, allowedSkills) : undefined;
		const launchedBeforeTeamPolicies = (taskId: string): boolean => {
			try { const loaded = this.store.load(taskId); return loaded.collaboration_mode === undefined && loaded.failure_policy === undefined; } catch { return false; }
		};
		const launchedBeforePolicies = (taskId: string): boolean => {
			try { return this.store.load(taskId).pane_manifest.every(entry => entry.dependency_policy === undefined); } catch { return false; }
		};
		const samePlan = (existing: { fingerprint: string; task_id: string }) => existing.fingerprint === fingerprint || existing.fingerprint === legacyFingerprint
			|| (pre09Fingerprint !== undefined && existing.fingerprint === pre09Fingerprint && launchedBeforeTeamPolicies(existing.task_id))
			|| (pre04Fingerprint !== undefined && existing.fingerprint === pre04Fingerprint && launchedBeforePolicies(existing.task_id));
		const requestKey = request.request_id ? createHash("sha256").update(requiredString(request.request_id, "request_id")).digest("hex") : randomUUID();
		return withRunLock(join(this.store.indexRoot, requestKey), async () => {
			const requestPath = join(this.store.indexRoot, `request-${requestKey}.json`);
			if (existsSync(requestPath)) {
				const existing = readJson<{ fingerprint: string; task_id: string }>(requestPath);
				if (!samePlan(existing)) throw new Error("request_id was already used for a different bootstrap plan");
				// The original launcher may have died mid-launch: return a reconciled view, never a stale "launching".
				return withRunLock(join(this.store.indexRoot, existing.task_id), async () => this.reconcile(this.store.load(existing.task_id), true));
			}
			const workspaceId = await this.workspace(signal);
			checkAbort(signal);
			const taskId = generateTaskId(request.task);
			// Hold the run lock before the manifest exists, so nobody can mistake this launch for an interrupted one.
			return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const sessionDir = ensureSessionDir(cwd, taskId);
			const dispatcher = this.dispatcher();
			const hasJoin = inbound.some(edges => edges.length > 1);
			const manifestVersion = reviewPlan ? REVIEW_VERSION : request.topology === "graph" ? (hasJoin ? JOIN_GRAPH_VERSION : GRAPH_VERSION) : CURRENT_VERSION;
			const manifest: BootstrapManifest = {
				version: manifestVersion, ...(reviewPlan ? { review_plan: reviewPlan } : {}), request_form: form, collaboration_mode: collaborationMode, failure_policy: failurePolicy, workspace_strategy: WORKSPACE_STRATEGY,
				task_id: taskId, task: request.task, topology: request.topology,
				...(request.topology === "graph" || request.cleanup !== undefined || request.cleanup_settle_ms !== undefined
					? { cleanup_policy: { version: 1, mode: cleanup, settle_ms: cleanupSettleMs } } : {}),
				project_cwd: cwd, session_dir: sessionDir, workspace_id: workspaceId, coms_project: `boot-${taskId}`,
				dispatcher_coms_name: dispatcher?.name, dispatcher_session_id: dispatcher?.session_id,
				status: "launching", phase: "planned", token: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				...(taskTimeout !== undefined ? { task_timeout_ms: taskTimeout } : {}),
				...(dependencyWaitTimeout !== undefined ? { dependency_wait_timeout_ms: dependencyWaitTimeout } : {}),
				...(livenessTimeout !== undefined ? { liveness_timeout_ms: livenessTimeout } : {}),
				...(cancelGrace !== undefined ? { cancel_grace_ms: cancelGrace } : {}),
				pane_manifest: mapped.map(({ node, def, resolvedModel }, i) => {
					const waits = ownershipSchedule.waitsFor.get(instances[i]) ?? [];
					const effectiveTaskTimeout = node.task_timeout_ms ?? taskTimeout;
					const effectiveDepWait = node.inbound_edges.length > 0 ? (node.dependency_wait_timeout_ms ?? dependencyWaitTimeout) : undefined;
					return {
						node_id: node.node_id, persona_name: def.name, attempt_id: attempts[i], instance_id: instances[i], expected_coms_name: instances[i], expected_model: resolvedModel.model, label: `${taskId}:${instances[i]}`,
						step: node.step, predecessor: inbound[i][0],
						successor: outbound[i][0],
						...(request.topology === "graph" ? { inbound_edges: inbound[i] } : {}),
						status: "planned",
						...(node.dependency_policy ? { dependency_policy: node.dependency_policy } : {}),
						...(node.join_policy ? { join_policy: node.join_policy } : {}),
						...(requiredChecksOf(node).length ? { required_checks: requiredChecksOf(node) } : {}),
						...(node.read_paths !== undefined ? { read_paths: node.read_paths } : {}),
						...(node.write_paths !== undefined ? { write_paths: node.write_paths } : {}),
						...(waits.length ? { ownership_wait_for: waits } : {}),
						...(effectiveTaskTimeout !== undefined ? { task_timeout_ms: effectiveTaskTimeout } : {}),
						...(effectiveDepWait !== undefined ? { dependency_wait_timeout_ms: effectiveDepWait } : {}),
					};
				}),
			};
			this.store.assertDirectory(manifest);
			this.store.save(manifest);
			// Atomic, complete reservation: a concurrent process must not create a second fleet for the same key,
			// and a crash can never leave an empty or partial reservation behind.
			mkdirSync(this.store.indexRoot, { recursive: true, mode: 0o700 });
			if (!publishExclusive(requestPath, JSON.stringify({ fingerprint, task_id: taskId }))) {
				// Nothing was launched for this losing plan: remove its files instead of leaving an orphan run behind.
				try { this.store.assertDirectory(manifest); rmSync(sessionDir, { recursive: true }); this.store.removeUnlaunchedIndex(taskId); }
				catch { manifest.status = "error"; manifest.error = "Concurrent request reservation won by another invocation"; try { this.store.save(manifest); } catch { /* best effort */ } }
				const existing = readJson<{ fingerprint: string; task_id: string }>(requestPath);
				if (!samePlan(existing)) throw new Error("request_id was already used for a different bootstrap plan");
				return this.store.load(existing.task_id);
			}
			const fullRoster: RosterEntry[] = mapped.map(({ node, def }, i) => ({
				instance_id: instances[i],
				node_id: node.node_id,
				persona_name: def.name,
				...(node.step !== undefined ? { step: node.step } : {}),
				...(node.role !== undefined ? { role: node.role } : {}),
				...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
				...(node.read_paths !== undefined ? { read_paths: node.read_paths } : {}),
				...(node.write_paths !== undefined ? { write_paths: node.write_paths } : {}),
				...(hasJoin ? { inbound_edges: inbound[i] } : {}),
				sub_task: node.sub_task,
			}));
			const roster = boundRosterEntries(fullRoster);
			const upstreamContracts: Record<string, { output_contract?: OutputContract; required_checks?: string[] }> = {};
			for (let i = 0; i < mapped.length; i++) {
				const { node } = mapped[i];
				if (node.output_contract || node.required_checks?.length) {
					upstreamContracts[instances[i]] = {
						...(node.output_contract ? { output_contract: node.output_contract } : {}),
						...(node.required_checks?.length ? { required_checks: node.required_checks } : {}),
					};
				}
			}
			atomicJson(upstreamIndexPath(sessionDir), { version: 2, run_id: taskId, updated_at: new Date().toISOString(), entries: [] });
				let releaseWritten = false;
				try {
					for (let i = 0; i < mapped.length; i++) {
						checkAbort(signal);
						const { node, def, extensions, resolvedModel } = mapped[i];
						const entry = manifest.pane_manifest[i];
						const waits = ownershipSchedule.waitsFor.get(entry.instance_id) ?? [];
						const config: WorkerConfig = {
						version: manifestVersion, ...(reviewPlan ? { review_plan: reviewPlan } : {}), task_id: taskId, token: manifest.token, session_dir: sessionDir, project_cwd: cwd,
							coms_dir: this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), coms_project: manifest.coms_project,
							instance_id: entry.instance_id, node_id: node.node_id, persona_name: def.name, attempt_id: entry.attempt_id,
							persona: def.systemPrompt, expected_model: entry.expected_model,
							tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), sub_task: node.sub_task,
							topology: request.topology, step: node.step, predecessor: entry.predecessor, successor: entry.successor,
							...(request.topology === "graph" ? { inbound_edges: inbound[i], outbound_edges: outbound[i] } : {}),
							dependency_policy: node.dependency_policy,
					...(node.join_policy !== undefined ? { join_policy: node.join_policy } : {}),
							collaboration_mode: collaborationMode,
							failure_policy: failurePolicy,
							// Chains and graphs hand results over durably: the source records an offer, the destination claims it before model work (handoff.ts).
							...(request.topology === "chain" || request.topology === "graph" ? { handoff_protocol: HANDOFF_PROTOCOL } : {}),
							startup_message: `bootstrap-start:${manifest.token}:${entry.instance_id}`, ready_timeout_ms: readyTimeout + nodes.length * 30_000 + 15_000,
							...(entry.task_timeout_ms !== undefined ? { task_timeout_ms: entry.task_timeout_ms } : {}),
							...(entry.dependency_wait_timeout_ms !== undefined ? { dependency_wait_timeout_ms: entry.dependency_wait_timeout_ms } : {}),
							...(livenessTimeout !== undefined ? { liveness_timeout_ms: livenessTimeout } : {}),
							...(cancelGrace !== undefined ? { cancel_grace_ms: cancelGrace } : {}),
							task: request.task,
							...(goal !== undefined ? { goal } : {}),
							...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
							...(constraints !== undefined ? { constraints } : {}),
							...(node.role !== undefined ? { role: node.role } : {}),
							...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
							...(node.read_paths !== undefined ? { read_paths: node.read_paths } : {}),
							...(node.write_paths !== undefined ? { write_paths: node.write_paths } : {}),
							...(waits.length ? { ownership_wait_for: waits } : {}),
							...(node.acceptance_criteria !== undefined ? { node_acceptance_criteria: node.acceptance_criteria } : {}),
							...(node.constraints !== undefined ? { node_constraints: node.constraints } : {}),
							...(node.output_contract !== undefined ? { output_contract: node.output_contract } : {}),
							...(node.required_checks !== undefined ? { required_checks: node.required_checks } : {}),
							...(Object.keys(upstreamContracts).length > 0 ? { upstream_contracts: upstreamContracts } : {}),
							roster,
						};
						const inputRecord = buildTaskInputRecord({
							identity: { run_id: taskId, node_id: node.node_id, persona_name: def.name, attempt_id: entry.attempt_id!, instance_id: entry.instance_id },
							brief: {
								task: request.task,
								goal: goal ?? request.task,
								...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
								...(constraints !== undefined ? { constraints } : {}),
							},
							assignment: {
								sub_task: node.sub_task,
								...(node.role !== undefined ? { role: node.role } : {}),
								...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
								...(node.read_paths !== undefined ? { read_paths: node.read_paths } : {}),
								...(node.write_paths !== undefined ? { write_paths: node.write_paths } : {}),
								...(waits.length ? { ownership_wait_for: waits } : {}),
								...(node.acceptance_criteria !== undefined ? { acceptance_criteria: node.acceptance_criteria } : {}),
								...(node.constraints !== undefined ? { constraints: node.constraints } : {}),
								...(node.output_contract !== undefined ? { output_contract: node.output_contract } : {}),
								...(node.required_checks !== undefined ? { required_checks: node.required_checks } : {}),
							},
							roster: fullRoster,
							...(Object.keys(upstreamContracts).length > 0 ? { upstream_contracts: upstreamContracts } : {}),
						});
						atomicJson(taskInputPath(sessionDir, attemptKey(reviewPlan, entry.instance_id)), inputRecord);
						const configPath = join(sessionDir, `${entry.instance_id}.config.json`);
						atomicJson(configPath, config);
						const personaExtensions = [...new Set(extensions)].filter(ext => ext !== coms && ext !== worker);
						const args = ["-e", coms, ...personaExtensions.flatMap(ext => ["-e", ext]), "-e", worker,
							"--cname", entry.instance_id, "--purpose", `Bootstrap ${taskId}: ${nodeLabel(entry)}`, "--project", manifest.coms_project,
							"--model", entry.expected_model,
							...(resolvedModel.thinking !== undefined ? ["--thinking", resolvedModel.thinking] : []),
							"--bootstrap-worker-config", configPath,
							...(def.allowedSkills === undefined ? [] : ["--allowed-skills", def.allowedSkills.join(",") || "none"]),
							...workerStartupMessages(config.startup_message, def.allowedSkills !== undefined)];
						// Only the short launcher path crosses the user's shell/PTY. All arbitrary task text stays in files.
						const launcher = join(sessionDir, `${entry.instance_id}.sh`);
						atomicText(launcher, `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${[piBinary, ...args].map(shellQuote).join(" ")}\n`);
						entry.status = "creating"; manifest.phase = `creating:${entry.instance_id}`; this.store.save(manifest); update?.(manifest);
						try {
							const created = await this.json(["tab", "create", "--workspace", workspaceId, "--label", entry.label, "--cwd", cwd, "--no-focus",
								"--env", `PI_COMS_DIR=${config.coms_dir}`, "--env", "PI_COMS_TIMEOUT_MS=300000", "--env", `PI_COMS_MAX_HOPS=${Math.max(5, nodes.length + 2)}`], signal);
							// Preserve every known ID even if the rest of the response is malformed.
							if (typeof created.tab?.tab_id === "string") entry.tab_id = created.tab.tab_id;
							entry.pane_id = requiredString(created.root_pane?.pane_id, "Created root pane_id");
							entry.terminal_id = requiredString(created.root_pane?.terminal_id, "Created terminal_id");
							requiredString(entry.tab_id, "Created tab_id");
							entry.status = "tab_created"; this.store.save(manifest);
							await this.command(["pane", "run", entry.pane_id, launchCommand(cwd, launcher)], signal);
							entry.status = "launch_submitted"; this.store.save(manifest);
						} catch (error) { entry.error = errorMessage(error); throw error; }
					}
					manifest.phase = "waiting-ready"; this.store.save(manifest); update?.(manifest);
					const deadline = this.now() + readyTimeout;
					while (manifest.pane_manifest.some(entry => entry.status !== "ready")) {
						checkAbort(signal);
						if (existsSync(runCancelPath(sessionDir))) throw new Error("Bootstrap run was cancelled before release");
						for (const entry of manifest.pane_manifest) {
							if (existsSync(cancelPath(sessionDir, entry.instance_id))) throw new Error("Bootstrap run was cancelled before release");
							const scopedFailure = join(sessionDir, `${attemptKey(reviewPlan, entry.instance_id)}.error.json`);
							const failure = existsSync(scopedFailure) ? scopedFailure : join(sessionDir, `${entry.instance_id}.error.json`);
							if (existsSync(failure)) {
								entry.error = String(readJson<{ error: string }>(failure).error);
								throw new Error(`${nodeLabel(entry)}: ${entry.error}`);
							}
							if (entry.status === "ready" || !existsSync(readyPath(sessionDir, entry.instance_id))) continue;
							const ready = parseWorkerReady(readJson<unknown>(readyPath(sessionDir, entry.instance_id)));
							if (ready.task_id !== taskId || ready.token !== manifest.token || ready.instance_id !== entry.instance_id || ready.name !== entry.expected_coms_name || typeof ready.model !== "string" || !modelMatches(entry.expected_model, ready.model) || !ready.session_id || !ready.endpoint || !Number.isInteger(ready.pid)) throw new Error(`Invalid readiness acknowledgement for ${nodeLabel(entry)}`);
							checkAllowedSkills(entry, ready);
							if (!processAlive(ready)) throw new Error(`${nodeLabel(entry)} exited after acknowledging readiness`);
							entry.status = "ready"; this.store.save(manifest); update?.(manifest);
						}
						if (manifest.pane_manifest.every(entry => entry.status === "ready")) break;
						if (this.now() >= deadline) throw new Error(`Readiness timeout. Not ready: ${manifest.pane_manifest.filter(entry => entry.status !== "ready").map(entry => nodeLabel(entry)).join(", ")}`);
						await delay(this.options.pollMs ?? 100, signal);
					}
					checkAbort(signal);
					if (existsSync(runCancelPath(sessionDir)) || manifest.pane_manifest.some(entry => existsSync(cancelPath(sessionDir, entry.instance_id)))) {
						throw new Error("Bootstrap run was cancelled before release");
					}
					// A worker may have exited after its first acknowledgement while another was starting.
					for (const entry of manifest.pane_manifest) {
						const ready = parseWorkerReady(readJson<unknown>(readyPath(sessionDir, entry.instance_id)));
						if (ready.task_id !== taskId || ready.token !== manifest.token || !modelMatches(entry.expected_model, ready.model) || ready.instance_id !== entry.instance_id) throw new Error(`Readiness changed before release for ${nodeLabel(entry)}`);
						checkAllowedSkills(entry, ready);
						if (!processAlive(ready)) throw new Error(`${nodeLabel(entry)} exited before work was released`);
						const registry = readJson<RegistryEntry>(join(this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), "projects", manifest.coms_project, "agents", `${entry.instance_id}.json`));
						if (registry.pid !== ready.pid || registry.session_id !== ready.session_id || registry.name !== entry.instance_id) throw new Error(`Coms identity changed before release for ${nodeLabel(entry)}`);
					}
					atomicJson(join(sessionDir, "release.json"), { task_id: taskId, token: manifest.token });
					releaseWritten = true;
					for (const entry of manifest.pane_manifest) entry.status = "released";
					manifest.status = "applied"; manifest.phase = "released"; this.store.save(manifest); update?.(manifest);
				} catch (error) {
					if (releaseWritten) {
						// Children are already working; an abort marker now would be ignored and the run is not failed.
						for (const entry of manifest.pane_manifest) entry.status = "released";
						manifest.status = "applied"; manifest.phase = "released"; manifest.error = `Work was released, but recording that failed: ${errorMessage(error)}`;
						try { this.store.save(manifest); } catch { /* the returned manifest is authoritative */ }
						return manifest;
					}
					const preReleaseCancelled = !!(signal?.aborted || existsSync(runCancelPath(sessionDir)) || manifest.pane_manifest.some(entry => existsSync(cancelPath(sessionDir, entry.instance_id))));
					manifest.status = "error"; manifest.phase = preReleaseCancelled ? "cancelled" : "failed"; manifest.error = errorMessage(error);
					// Unreleased children see this marker and shut down, instead of waiting forever.
					try { atomicJson(join(sessionDir, "abort.json"), { task_id: taskId, token: manifest.token, error: manifest.error }); } catch { /* index remains recovery source */ }
					if (preReleaseCancelled && existsSync(sessionDir)) {
						const nowIso = new Date(this.now()).toISOString();
						const graceMs = manifest.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS;
						try {
							this.persistPreReleaseCancel(manifest, manifest.error, "run", manifest.pane_manifest, nowIso, graceMs, true);
						} catch { /* best effort */ }
					}
					try { this.store.save(manifest); }
					catch (persistenceError) { manifest.error += `; recovery-state persistence failed: ${errorMessage(persistenceError)}`; }
				}
				return manifest;
			});
		});
	}

	/**
	 * A manifest still marked "launching" whose run lock nobody holds belongs to a launcher that died
	 * (crash, killed process, /reload mid-launch). Derive the truth from durable markers: work was either
	 * released (release.json with our token) or never released (abort waiting children). With
	 * `persist`, the caller holds the run lock and the reconciled state is saved.
	 */
	private reconcile(manifest: BootstrapManifest, persist: boolean): BootstrapManifest {
		if (manifest.status !== "launching") return manifest;
		if (!persist && lockHeld(join(this.store.indexRoot, manifest.task_id))) return manifest; // a live launch is in progress
		const available = !manifest.session_dir_removed;
		let released = false;
		try {
			const release = available ? readJson<{ task_id: string; token: string }>(join(manifest.session_dir, "release.json")) : undefined;
			released = release?.task_id === manifest.task_id && release.token === manifest.token;
		} catch { /* no release marker */ }
		manifest.reconciled = true;
		if (released) {
			for (const entry of manifest.pane_manifest) if (entry.status !== "closed") entry.status = "released";
			manifest.status = "applied"; manifest.phase = "released";
			manifest.error = "Launcher was interrupted after work was released; state reconciled from release marker";
		} else {
			manifest.error = `Launcher was interrupted before work was released (last phase: ${manifest.phase}); partial tabs need bootstrap_cleanup`;
			manifest.status = "error"; manifest.phase = "interrupted";
			if (persist && available) { try { atomicJson(join(manifest.session_dir, "abort.json"), { task_id: manifest.task_id, token: manifest.token, error: manifest.error }); } catch { /* index remains recovery source */ } }
		}
		if (persist) this.store.save(manifest);
		return manifest;
	}

	/** Reports and status read the same attempt-scoped, identity-checked records. */
	private reviewAttempt(manifest: BootstrapManifest, entry: AgentLaunch, number: number, loop: ReviewLoop): ReportReviewHistory["attempts"][number] | undefined {
		const key = attemptKey(manifest.review_plan, entry.instance_id, number);
		const expected = { ...expectationFor(manifest, entry), attempt_id: key };
		const resultFile = resultPath(manifest.session_dir, key);
		if (existsSync(resultFile)) {
			const { result } = parseCompletion(readJson<unknown>(resultFile), expected);
			const route = entry.instance_id === loop.reviewer ? reviewVerdict(loop, result) : undefined;
			const verdict = route && loop[route];
			return { number, state: executionFromResult(result.status).state, summary: result.summary, ...(verdict ? { verdict } : {}) };
		}
		const dispositionFile = dispositionPath(manifest.session_dir, key);
		if (existsSync(dispositionFile)) {
			const disposition = parseDisposition(readJson<unknown>(dispositionFile), expected);
			return { number, state: disposition.state, summary: disposition.reason };
		}
	}

	status(taskId: string, cwd?: string): RunStatus {
		return this.readStatus(this.reconcile(this.store.load(taskId, cwd), false));
	}

	private readStatus(manifest: BootstrapManifest): RunStatus {
		const results: BootstrapResult[] = [];
		const pending: string[] = [];
		const deliveryErrors: string[] = [];
		const workerErrors: string[] = [];
		const agents: AgentState[] = [];
		const unsettledReviews = new Set<string>();
		const closedReviewEdges = new Map<string, NonNullable<ReturnType<typeof blockedReviewForwardEdge>>>();
		let settledAttention = 0;
		const available = !manifest.session_dir_removed;
		const reviewAttempts = new Map<string, ReturnType<typeof currentAttempt>>();
		const reviewErrors = new Map<string, string>();
		if (available && manifest.review_plan) for (const entry of manifest.pane_manifest) {
			try {
				reviewAttempts.set(entry.instance_id, currentAttempt(manifest, entry));
			} catch (error) { reviewErrors.set(entry.instance_id, errorMessage(error)); }
		}

		const keyFor = (entry: AgentLaunch) => attemptKey(manifest.review_plan, entry.instance_id, reviewAttempts.get(entry.instance_id)?.number);

		// A node is settled once it has a result, or a record that it never executed: a successor's undelivered handoff no longer matters then.
		const finished = new Set(manifest.pane_manifest.filter(entry => available && (existsSync(resultPath(manifest.session_dir, keyFor(entry))) || existsSync(dispositionPath(manifest.session_dir, keyFor(entry))))).map(entry => entry.instance_id));
		const exited = (entry: (typeof manifest.pane_manifest)[number]): boolean => {
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (!available || entry.status === "closed" || !existsSync(readyFile)) return false;
			try { return !processAlive(parseWorkerReady(readJson<unknown>(readyFile))); } catch { return false; }
		};
		const now = this.now();
		const livenessTimeoutMs = manifest.liveness_timeout_ms ?? DEFAULT_LIVENESS_MS;
		const roster = manifest.pane_manifest.map(item => ({ instance_id: item.instance_id, node_id: item.node_id, persona_name: item.persona_name }));
		const entryByInstance = new Map(manifest.pane_manifest.map(item => [item.instance_id, item]));
		const deadFeedbackTargets = new Map<string, string>();
		const deadFeedbackMembers = new Set<string>();
		const failFastInfo = available ? readFailFast(manifest.session_dir, manifest.task_id, manifest.token) : {};
		if (failFastInfo.error) workerErrors.push(`run: ${failFastInfo.error}`);
		const runCancelInfo = available ? readRunCancelRecordSafe(manifest.session_dir, manifest.task_id) : {};
		if (runCancelInfo.error) workerErrors.push(`run: ${runCancelInfo.error}`);
		// Handoff records, keyed by edge (`source->destination`): delivery (queued), acceptance and rejection are read from the durable records alone.
		const handoffs = new Map<string, HandoffView>();
		const revisionRejections = new Map<string, HandoffView>();
		const sourceScope = (sourceId: string) => (manifest.topology === "graph" || manifest.review_plan ? sourceId : undefined);
		if (available) for (const entry of manifest.pane_manifest) {
			for (const sourceId of (reviewAttempts.get(entry.instance_id)?.source ? [reviewAttempts.get(entry.instance_id)!.source!] : inboundEdgesOf(entry))) {
				try {
					const view = describeHandoff(manifest.session_dir, sourceId, keyFor(entry), { run_id: manifest.task_id, source_instance_id: sourceId, destination: { node_id: entry.node_id, instance_id: entry.instance_id, attempt_id: manifest.review_plan ? keyFor(entry) : entry.attempt_id } }, sourceScope(sourceId), entry.instance_id);
					if (view) handoffs.set(`${sourceId}->${entry.instance_id}`, view);
				} catch { /* one unreadable record must not hide the run */ }
			}
			const revLoop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			if (revLoop) {
				const revSource = entry.instance_id === revLoop.target ? revLoop.reviewer : inboundEdgesOf(entry)[0];
				const nextAttempt = (reviewAttempts.get(entry.instance_id)?.number ?? 1) + 1;
				if (revSource && nextAttempt <= revLoop.max_revisions + 1) {
					try {
						const nextKey = attemptKey(manifest.review_plan, entry.instance_id, nextAttempt);
						const view = describeHandoff(manifest.session_dir, revSource, nextKey, { run_id: manifest.task_id, source_instance_id: revSource, destination: { node_id: entry.node_id, instance_id: entry.instance_id, attempt_id: `${entry.instance_id}.${nextAttempt}` } }, sourceScope(revSource), entry.instance_id);
						if (view?.rejections.length) revisionRejections.set(entry.instance_id, view);
					} catch { /* one unreadable record must not hide the run */ }
				}
			}
		}
		for (const entry of manifest.pane_manifest) {
			const label = nodeLabel(entry);
			const key = keyFor(entry);
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			const attemptId = manifest.review_plan ? key : entry.attempt_id;
			const expected = { ...expectationFor(manifest, entry), attempt_id: attemptId };
			const source = reviewAttempts.get(entry.instance_id)?.source;
			const inbound = source ? [source] : inboundEdgesOf(entry);
			const outboundTargets = outboundEdgesOf(manifest.pane_manifest, entry.instance_id);
			const state: AgentState = {
				node_id: entry.node_id, persona_name: entry.persona_name, attempt_id: attemptId, ...(manifest.review_plan ? { attempt_limit: (loop?.max_revisions ?? 0) + 1 } : {}), instance_id: entry.instance_id, tab_id: entry.tab_id, state: entry.status === "closed" ? "closed" : "pending",
				dependency_policy: dependencyPolicyOf(entry, inbound.length > 0),
				...(entry.join_policy !== undefined ? { join_policy: entry.join_policy } : inbound.length > 1 ? { join_policy: "all_success" as const } : {}),
				resource: entry.status, execution: "pending", execution_causes: [],
				...(entry.task_timeout_ms !== undefined ? { task_timeout_ms: entry.task_timeout_ms } : manifest.task_timeout_ms !== undefined ? { task_timeout_ms: manifest.task_timeout_ms } : {}),
				...(entry.read_paths?.length ? { read_paths: entry.read_paths } : {}),
				...(entry.write_paths?.length ? { write_paths: entry.write_paths } : {}),
				...(entry.ownership_wait_for?.length ? { ownership_wait_for: entry.ownership_wait_for } : {}),
			};
			agents.push(state);
			const reviewError = reviewErrors.get(entry.instance_id);
			if (reviewError) {
				state.error = reviewError;
				state.state = "error";
				state.execution = "needs_attention";
				pending.push(entry.node_id);
				workerErrors.push(`${label}: ${reviewError}`);
				continue;
			}
			const handoff = inbound[0] ? handoffs.get(`${inbound[0]}->${entry.instance_id}`) : undefined;
			const revRejection = revisionRejections.get(entry.instance_id);
			if (handoff) {
				state.handoff = revRejection ? { ...handoff, rejections: [...handoff.rejections, ...revRejection.rejections] } : handoff;
			} else if (revRejection) {
				state.handoff = revRejection;
			}
			if (manifest.topology === "graph" && inbound.length > 1) {
				state.handoffs_in = Object.fromEntries(
					inbound.map(sourceId => [
						sourceId,
						handoffs.get(`${sourceId}->${entry.instance_id}`) ?? {
							state: "none",
							source: sourceId,
							destination: entry.instance_id,
							rejections: [],
							problems: [],
						},
					]),
				);
			}
			const outboundView = (target: string) => {
				const attempt = reviewAttempts.get(entry.instance_id)?.number ?? 1;
				if (!loop?.members.includes(target) || attempt === (reviewAttempts.get(target)?.number ?? 1)) {
					return handoffs.get(`${entry.instance_id}->${target}`);
				}
				// The recipient may still be parked on the previous attempt while this offer is queued.
				const targetKey = attemptKey(manifest.review_plan, target, attempt);
				return describeHandoff(manifest.session_dir, entry.instance_id, targetKey, {
					run_id: manifest.task_id, destination: { instance_id: target, node_id: entryByInstance.get(target)!.node_id, attempt_id: targetKey },
				}, sourceScope(entry.instance_id), target);
			};
			const outbound = available && outboundTargets[0] ? outboundView(outboundTargets[0]) : undefined;
			if (outbound) state.handoff_out = outbound;
			if (manifest.topology === "graph" && outboundTargets.length > 0) {
				state.handoffs_out = Object.fromEntries(
					outboundTargets.map(target => [
						target,
						(available ? outboundView(target) : undefined) ?? {
							state: "none",
							source: entry.instance_id,
							destination: target,
							rejections: [],
							problems: [],
						},
					]),
				);
			}
			const inboundProblems = inbound.flatMap(sourceId => handoffs.get(`${sourceId}->${entry.instance_id}`)?.problems ?? []);
			if (inboundProblems.length) {
				const problemMessage = `handoff evidence problem: ${inboundProblems.join("; ")}`;
				workerErrors.push(`${label}: ${problemMessage}`);
				state.error ??= problemMessage;
			}
			let heartbeat: "working" | "waiting" | undefined;
			const scopedFailure = join(manifest.session_dir, `${key}.error.json`);
			const failure = manifest.review_plan && !existsSync(scopedFailure) && reviewAttempts.get(entry.instance_id)?.number === 1
				? join(manifest.session_dir, `${entry.instance_id}.error.json`) : scopedFailure;
			if (available && existsSync(failure)) {
				// A torn or foreign file must not hide every other agent's status.
				let message: string;
				try { message = String(readJson<{ error: string }>(failure).error); } catch (error) { message = `unreadable error record (${errorMessage(error)})`; }
				workerErrors.push(`${label}: ${message}`);
				state.error = message;
			} else if (entry.error) {
				workerErrors.push(`${label}: ${entry.error}`);
				state.error = entry.error;
			}
			const isExited = exited(entry);
			if (available) {
				try {
					const progress = readJson<ProgressSnapshot>(join(manifest.session_dir, `${entry.instance_id}.progress.json`));
					if (progress.token === manifest.token && Number.isFinite(progress.updated_at) && (!manifest.review_plan || progress.attempt_id === key)) {
						const diag = diagnoseLiveness({
							nowMs: now,
							progress,
							alive: !isExited,
							livenessTimeoutMs,
							taskTimeoutMs: state.task_timeout_ms,
						});
						state.heartbeat_age_ms = diag.heartbeat_age_ms;
						if (diag.activity_age_ms !== undefined) state.activity_age_ms = diag.activity_age_ms;
						if (diag.elapsed_ms !== undefined) state.elapsed_ms = diag.elapsed_ms;
						if (state.task_timeout_ms !== undefined) state.deadline_exceeded = diag.deadline_exceeded;
						state.liveness = diag.liveness;
						heartbeat = progress.state === "working" ? "working" : "waiting";
						if (state.state === "pending") state.state = heartbeat;
					}
				} catch { /* no heartbeat yet */ }
			}
			const cancelInfo = available ? readCancelRecordSafe(manifest.session_dir, this.cancelIdentity(manifest, entry)) : {};
			if (cancelInfo.error) {
				state.error ??= cancelInfo.error;
				workerErrors.push(`${label}: ${cancelInfo.error}`);
			}
			const claimInfo = available ? readOutcomeClaimSafe(manifest.session_dir, { ...this.cancelIdentity(manifest, entry), attempt_id: attemptId }, key) : {};
			if (claimInfo.error) {
				state.error ??= claimInfo.error;
				workerErrors.push(`${label}: ${claimInfo.error}`);
			}
			if (failFastInfo.error) state.error ??= failFastInfo.error;
			if (runCancelInfo.error) {
				state.error ??= runCancelInfo.error;
			}
			const cancelRecord = cancelInfo.record ?? (claimInfo.claim?.outcome === "completed" ? undefined : runCancelInfo.record);
			const path = resultPath(manifest.session_dir, keyFor(entry));
			let completion: WorkerCompletion | undefined;
			if (available && existsSync(path)) {
				// One unreadable or foreign result must not hide the rest of the run.
				try {
					completion = parseCompletion(readJson<unknown>(path), expected);
				} catch (error) {
					completion = undefined;
					state.error = `unusable result file: ${errorMessage(error)}`;
					workerErrors.push(`${label}: ${state.error}`);
				}
			}
			// A node that never executed has a disposition instead of a result; the worker's result, when there is one, is authoritative.
			let disposition: Disposition | undefined;
			const dispositionFile = dispositionPath(manifest.session_dir, keyFor(entry));
			if (available && !completion && existsSync(dispositionFile)) {
				try { disposition = parseDisposition(readJson<unknown>(dispositionFile), expected); }
				catch (error) { state.error = `unusable disposition file: ${errorMessage(error)}`; workerErrors.push(`${label}: ${state.error}`); }
			}
			// Parse and resolve ownership state before computing execution so corrupt/unsupported records fail closed as needs_attention.
			let finalization: ReturnType<typeof readFinalization>;
			let loopDecision: ReturnType<typeof readFinalization>;
			if (available && loop) {
				try {
					finalization = readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
					if (finalization && finalization.attempt_id !== attemptId) throw new Error("Finalization does not match the latest attempt");
					if (finalization) {
						state.finalized = true;
						state.finalized_by = finalization.finalized_by;
						if (loop.reviewer !== entry.instance_id) {
							loopDecision = readFinalization(manifest.session_dir, manifest.task_id, loop, loop.reviewer);
						}
					}
				} catch (error) {
					finalization = undefined;
					state.error = errorMessage(error);
					workerErrors.push(`${label}: ${state.error}`);
				}
			}
			if (available) resolveAgentOwnershipStatus({ manifest, entry, label, roster, completion, disposition, state, workerErrors, now });
			if (completion) {
				if (state.task_timeout_ms !== undefined) state.deadline_exceeded = false;
				results.push({ ...completion.result, node_id: entry.node_id });
				state.execution = executionFromResult(completion.result.status).state; state.execution_reason = completion.result.summary;
				state.result_status = completion.result.status; state.summary = completion.result.summary; state.delivery = completion.delivery;
				if (state.state !== "closed") state.state = "done";
				let reviewClaimed = false;
				if (manifest.review_plan && completion.identity && (completion.delivery === "pending" || completion.delivery === "failed")) {
					try {
						reviewClaimed = reviewDeliveryClaimed(manifest.session_dir, completion,
							reviewRoutes(manifest.session_dir, completion.identity, manifest.review_plan, completion.result, outboundTargets));
					} catch (error) {
						state.error = errorMessage(error);
						workerErrors.push(`${label}: ${state.error}`);
					}
				}
				let deadFeedback = false;
				if (loop && !finalization) {
					if (loop.reviewer === entry.instance_id) {
						try {
							const attemptNum = attemptNumber(attemptId);
							const rejected = reviewVerdict(loop, completion.result) === "reject";
							if (rejected) {
								state.execution = "waiting";
								state.execution_reason = `The review rejected the work: ${completion.result.summary}`;
							}
							if (rejected && revisionReserved(manifest.session_dir, manifest.task_id, loop, attemptNum + 1)) {
								const deadMembers = loop.members.filter(memberId => {
									if (memberId === entry.instance_id) return false;
									const memberEntry = entryByInstance.get(memberId);
									return !!memberEntry && (memberEntry.status === "closed" || exited(memberEntry)) &&
										(reviewAttempts.get(memberId)?.number ?? 1) === attemptNum;
								});
								if (deadMembers.length) {
									deadFeedback = true;
									const targetNode = entryByInstance.get(loop.target)?.node_id ?? loop.target;
									const deadNames = deadMembers.map(id => entryByInstance.get(id)?.node_id ?? id);
									state.execution = "needs_attention";
									state.execution_reason = `Feedback edge to ${targetNode} is dead: parked agent ${deadNames.join(", ")} exited before revision`;
									state.error ??= state.execution_reason;
									state.parked = false;
									workerErrors.push(`${label}: ${state.execution_reason}`);
									pending.push(entry.node_id);
									deadFeedbackTargets.set(loop.target, entry.node_id);
									for (const id of loop.members) {
										const member = entryByInstance.get(id);
										if (member && id !== loop.reviewer) deadFeedbackMembers.add(member.node_id);
									}
								}
							}
						} catch (error) {
							deadFeedback = true;
							state.execution = "needs_attention";
							state.error ??= errorMessage(error);
							state.parked = false;
							workerErrors.push(`${label}: ${state.error}`);
							pending.push(entry.node_id);
						}
					}
					if (!deadFeedback) {
						unsettledReviews.add(entry.node_id);
						state.parked = completion.delivery === "sent" || completion.delivery === "not_required" || reviewClaimed;
						pending.push(entry.node_id);
					}
				}
				const rejection = loop && finalizedReviewRejection(loop, finalization, entry.node_id, completion.result);
				if (rejection) {
					state.execution = rejection.state;
					state.execution_reason = rejection.reason;
					if (state.execution === "needs_attention" && !state.error) settledAttention++;
				}
				const closedEdge = loop && blockedReviewForwardEdge(loop, finalization, entry.node_id,
					{ ...executionFromResult(completion.result.status), reason: completion.result.summary }, completion.result);
				if (closedEdge && !state.error) closedReviewEdges.set(entry.instance_id, closedEdge);
				// Once the successor has its own durable result, an undelivered handoff no longer matters
				// (e.g. a follower that already failed itself on an upstream failure).
				// An accepted handoff proves delivery whatever the source recorded (e.g. a lost acknowledgement).
				const handoffSettled = ((closedEdge || loopDecision) && !state.error) || reviewClaimed || (!loop && outboundTargets.length > 0 && outboundTargets.every(target => finished.has(target) || handoffs.get(`${entry.instance_id}->${target}`)?.state === "accepted"));
				if (reviewClaimed) state.delivery = "sent";
				if (completion.delivery === "failed" && !handoffSettled && !deadFeedback) deliveryErrors.push(`${label}: ${completion.delivery_error}`);
				if (completion.delivery === "pending" && !handoffSettled) {
					if (!unsettledReviews.has(entry.node_id)) pending.push(entry.node_id);
					if (manifest.review_plan) unsettledReviews.add(entry.node_id);
					if (isExited) { workerErrors.push(`${label}: process exited during chain handoff`); state.error ??= "process exited during chain handoff"; }
				}
			} else if (disposition) {
				if (state.task_timeout_ms !== undefined) state.deadline_exceeded = false;
				state.execution = disposition.state; state.execution_causes = disposition.causes; state.execution_reason = disposition.reason;
				if (disposition.state === "needs_attention") { state.error ??= disposition.reason; workerErrors.push(`${label}: needs attention: ${disposition.reason}`); pending.push(entry.node_id); }
				else if (state.state !== "closed") state.state = "done";
				const closedEdge = loop && blockedReviewForwardEdge(loop, finalization, entry.node_id, disposition);
				if (closedEdge && !state.error) closedReviewEdges.set(entry.instance_id, closedEdge);
				if (loop && !finalization && (disposition.state === "blocked" || disposition.state === "cancelled")) {
					unsettledReviews.add(entry.node_id);
					pending.push(entry.node_id);
				}
			} else if (cancelRecord && !state.error) {
				const remaining = graceRemainingMs(cancelRecord, now);
				if (heartbeat === "working" && !isExited && entry.status !== "closed") {
					pending.push(entry.node_id);
					state.execution = "running";
					state.cancelling = true;
					state.cancel_requested_at = cancelRecord.requested_at;
					state.grace_remaining_ms = remaining;
					state.force_close_allowed = remaining === 0;
					state.execution_reason = `${cancelRecord.reason} (cancelling; in-progress tool work cannot be undone by hooks)`;
				} else {
					state.execution = "cancelled";
					const acceptedView = handoff?.state === "accepted" ? handoff : Object.values(state.handoffs_in ?? {}).find(h => h.state === "accepted");
					state.execution_reason = (heartbeat === "working" || acceptedView)
						? `${cancelRecord.reason} (stopped after work started; prior side effects could not be undone)`
						: cancelRecord.reason;
					if (state.state !== "closed") state.state = "done";
				}
			} else if (manifest.status === "error" && manifest.phase === "cancelled") {
				state.execution = "cancelled";
				state.execution_reason = manifest.error ?? "Cancelled before release";
				if (state.state !== "closed") state.state = "done";
			} else {
				pending.push(entry.node_id);
				// An accepted handoff with no result is the case where effects are unknown: the task is never replayed on its own.
				const acceptedView = handoff?.state === "accepted" ? handoff : Object.values(state.handoffs_in ?? {}).find(h => h.state === "accepted");
				const accepted = acceptedView ? `accepted handoff ${acceptedView.handoff_id ?? `from ${acceptedView.source}`}` : undefined;
				const acceptedNoResult = (prefix: string, sep = "; ", conj = "and") => `${prefix} ${accepted}${sep}no result was recorded ${conj} the task is not replayed automatically`;
				if (isExited) {
					const message = accepted ? acceptedNoResult("process exited after it") : "process exited before recording a result";
					workerErrors.push(`${label}: ${message}`); state.error ??= message;
				}
				// Closing a node's tab or pane is a resource operation, not a cancellation: with no outcome on record, the outcome is unknown.
				if (state.error || state.state === "closed") {
					state.execution = "needs_attention";
					state.execution_reason = state.error ?? (accepted ? acceptedNoResult("Resource closed after it") : "Resource closed before an outcome was recorded");
					if (accepted && !state.execution_reason.includes("not replayed")) state.execution_reason += `; ${acceptedNoResult("it", " and ", "so")}`;
				}
				else state.execution = heartbeat === "working" ? "running" : heartbeat === "waiting" ? "waiting" : "pending";
			}
			if (available && existsSync(verificationPath(manifest.session_dir, key))) {
				try {
					const ver = evaluateNodeVerification(manifest.session_dir, entry.instance_id, manifest.project_cwd, undefined, manifest.task_id, key);
					if (ver.evaluations.length) state.verification = ver.evaluations;
				} catch (error) {
					workerErrors.push(`${label}: unusable verification record: ${errorMessage(error)}`);
				}
			}
			if (state.error && state.state !== "done" && state.state !== "closed") state.state = "error";
			// Evidence for the checks this node must pass, against the project as it is now.
			if (available && entry.required_checks?.length) state.evidence = verifyEvidence(manifest.session_dir, entry.instance_id, manifest.project_cwd, entry.required_checks, manifest.task_id, key).map(({ check, status }) => ({ check, status }));
		}
		const stateByInstance = new Map(agents.map(agent => [agent.instance_id, agent]));
		if (available) for (const loop of manifest.review_plan?.loops ?? []) {
			const reviewer = entryByInstance.get(loop.reviewer)!;
			const latest = reviewAttempts.get(loop.reviewer)?.number ?? 1;
			for (let number = latest; number >= 1; number--) {
				try {
					const verdict = this.reviewAttempt(manifest, reviewer, number, loop)?.verdict;
					if (!verdict) continue;
					for (const member of loop.members) stateByInstance.get(member)!.last_verdict = verdict;
					break;
				} catch { /* Unreadable records cannot supply a verdict. */ }
			}
		}
		const settledByReview = new Set<string>();
		for (const agent of agents) {
			if (deadFeedbackMembers.has(agent.node_id) && agent.parked) {
				agent.parked = false;
				unsettledReviews.delete(agent.node_id);
			} else {
				deadFeedbackMembers.delete(agent.node_id);
			}
		}
		for (const entry of manifest.pane_manifest) {
			const inbound = inboundEdgesOf(entry);
			const deadFeedbackSource = deadFeedbackTargets.get(entry.instance_id);
			if (!inbound.length && !deadFeedbackSource) continue;
			const destState = stateByInstance.get(entry.instance_id)!;
			const edgeStates: Record<string, EdgeState> = {};
			for (const sourceId of inbound) {
				const srcState = stateByInstance.get(sourceId);
				if (!srcState) continue;
				const view = handoffs.get(`${sourceId}->${entry.instance_id}`);
				const edgePolicy = inbound.length > 1
					? effectiveDependencyPolicy(entry.join_policy, dependencyPolicyOf(entry, true))
					: (dependencyPolicyOf(entry, true) ?? "require_success");
				const closed = view?.state !== "accepted" ? closedReviewEdges.get(sourceId) : undefined;
				// A finalized decision can settle an unadmitted successor before its worker polls.
				if (closed && (destState.execution === "pending" || destState.execution === "waiting")) {
					destState.execution = "blocked";
					destState.execution_reason = closed.reason;
					destState.execution_causes = closed.causes;
					destState.state = "done";
					settledByReview.add(destState.node_id);
				}
				edgeStates[srcState.node_id] = closed ? "dead" : deriveEdgeState({
					sourceExecution: srcState.execution,
					dependencyPolicy: edgePolicy,
					handoffClaimed: view?.state === "accepted",
				});
			}
			if (deadFeedbackSource) edgeStates[deadFeedbackSource] = "dead";
			destState.edge_states = edgeStates;
		}
		const outcome = aggregateRun([...agents.map(agent => unsettledReviews.has(agent.node_id) ? "waiting" as const : agent.execution), ...(failFastInfo.error ? ["needs_attention" as const] : [])]);
		// Exhaustion needs an operator's attention, but leaves no attempt that can still run.
		if (settledAttention > 0 && settledAttention === outcome.counts.needs_attention &&
			!outcome.counts.pending && !outcome.counts.waiting && !outcome.counts.running) outcome.terminal = true;
		return {
			manifest, results, pending: pending.filter(node => !settledByReview.has(node) && !deadFeedbackMembers.has(node)),
			delivery_errors: deliveryErrors, worker_errors: workerErrors, agents, outcome,
		};
	}

	/**
	 * Inspect (read-only) or repair the delivery of chain handoffs from saved evidence; see recovery.ts. Repair holds the run lock, so it is serialized with
	 * launch, report and cleanup.
	 */
	async recover(taskId: string, request: RecoveryRequest, options: RecoveryDeps & { cwd?: string } = {}): Promise<RecoveryReport> {
		const select = (manifest: BootstrapManifest): AgentLaunch[] => {
			if (manifest.session_dir_removed) throw new Error("Session files are unavailable; handoff recovery needs them");
			if (manifest.topology !== "chain" && manifest.topology !== "graph") throw new Error("Only a chain or graph has handoffs to recover");
			if (request.agent === undefined) return manifest.pane_manifest;
			const found = selectAgents(manifest.pane_manifest, request.agent);
			if (!found.length) throw new Error(`Unknown agent for this bootstrap run: ${request.agent}`);
			return found;
		};
		if (request.action === "inspect") {
			const manifest = this.reconcile(this.store.load(taskId, options.cwd, true), false);
			return inspectRun(manifest, select(manifest));
		}
		if (request.action !== "retry_delivery") throw new Error('action must be "inspect" or "retry_delivery"');
		if (request.agent === undefined) throw new Error("retry_delivery needs agent: the successor node whose inbound handoff to repair");
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, options.cwd, true), true);
			const recordProblems = new Map<string, string>();
			const edges = chainEdges(manifest, select(manifest), recordProblems);
			if (recordProblems.size) return {
				task_id: taskId, action: "retry_delivery", assessments: [], record_errors: [...recordProblems.values()],
				refused: "Review handoff evidence is unusable. Nothing was sent", next_steps: [],
			};
			if (!edges.length) throw new Error(`${request.agent} has no inbound handoff (it is the first step). To repair delivery from a node, name its successor`);
			if (manifest.review_plan) {
				const matching = edges.filter(({ source }) => request.source === undefined || source.node_id === request.source || source.instance_id === request.source);
				if (!matching.length) throw new Error(`${request.source} is not an inbound edge of ${request.agent}`);
				matching.sort((a, b) => attemptNumber(b.destination.attempt_id) - attemptNumber(a.destination.attempt_id));
				const newest = matching[0];
				return retryDelivery(manifest, newest.source, newest.destination, { ...options, senderSession: options.senderSession ?? this.dispatcher()?.session_id });
			}

			let edge = edges[0];
			if (edges.length > 1) {
				if (request.source === undefined) {
					const choices = edges.map(e => e.source.node_id).join(", ");
					throw new Error(`${request.agent} is a join with multiple inbound edges (${choices}); pass source to name which inbound handoff to repair`);
				}
				const matches = edges.filter(e => e.source.node_id === request.source || e.source.instance_id === request.source);
				if (!matches.length) {
					const choices = edges.map(e => e.source.node_id).join(", ");
					throw new Error(`${request.source} is not an inbound edge of ${request.agent} (choices: ${choices})`);
				}
				if (matches.length > 1) {
					throw new Error(`Ambiguous source ${request.source} for ${request.agent}; name an instance_id`);
				}
				edge = matches[0];
			} else if (request.source !== undefined) {
				if (edge.source.node_id !== request.source && edge.source.instance_id !== request.source) {
					throw new Error(`${request.source} is not an inbound edge of ${request.agent} (inbound edge: ${edge.source.node_id})`);
				}
			}
			// The successor accepts a re-send only from the Coms session recorded for it, which is this dispatcher's own.
			return retryDelivery(manifest, edge.source, edge.destination, { ...options, senderSession: options.senderSession ?? this.dispatcher()?.session_id });
		});
	}

	/**
	 * Block until the run settles (no pending agents), needs attention (any worker or delivery error,
	 * a failed or cleaned run), or the wait expires. Replaces turn-by-turn polling by the dispatcher.
	 */
	async waitForStatus(taskId: string, waitMs: number, cwd?: string, signal?: AbortSignal): Promise<RunStatus & { timed_out: boolean }> {
		if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) throw new Error(`wait_ms must be an integer between 0 and ${MAX_WAIT_MS}`);
		const deadline = this.now() + waitMs;
		const wallDeadline = Date.now() + waitMs;
		for (;;) {
			let status = await this.statusWithCleanup(taskId, cwd);
			const expired = status.agents.filter(agent => agent.execution === "running" && agent.deadline_exceeded && !agent.cancelling);
			if (expired.length) {
				for (const agent of expired) {
					await this.cancel(taskId, {
						agents: [agent.node_id],
						reason: `Task duration deadline exceeded (${agent.task_timeout_ms}ms)`,
						cwd,
						signal,
					});
				}
				status = await this.statusWithCleanup(taskId, cwd);
			}
			const settled = !status.pending.length || status.worker_errors.length > 0 || status.delivery_errors.length > 0
				|| status.manifest.status === "error" || status.manifest.status === "cleaned" || !!status.manifest.session_dir_removed;
			const remaining = Math.min(deadline - this.now(), wallDeadline - Date.now());
			if (settled || remaining <= 0) return { ...status, timed_out: !settled };
			await delay(Math.min(this.options.statusPollMs ?? 1000, remaining), signal);
		}
	}

	async report(taskId: string, results: Array<Omit<BootstrapResult, "agent_name"> & { agent_name?: string }> | undefined, markdown: boolean, render: (results: ReportEntry[]) => string, cwd?: string): Promise<{ report_json: string; report_md?: string; results: ReportEntry[] }> {
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			this.reconcile(this.store.load(taskId, cwd, true), true);
			const status = this.status(taskId, cwd);
			if (status.manifest.session_dir_removed) throw new Error(status.manifest.session_files_deleted ? "Session files were explicitly deleted; reports can no longer be written" : "Session files are unavailable (the project directory is missing); reports cannot be written");
			if (!results && (status.pending.length || status.delivery_errors.length || status.worker_errors.length)) throw new Error(`Run is not complete. Pending: ${status.pending.join(", ") || "none"}. Delivery errors: ${status.delivery_errors.join("; ") || "none"}. Worker errors: ${status.worker_errors.join("; ") || "none"}`);
			const entries = status.manifest.pane_manifest;
			const executionByNode = status.manifest.review_plan ? new Map(status.agents.map(agent => [agent.node_id, agent])) : undefined;
			// Nodes that never executed are reported from their records; they have no worker result and cannot be given one.
			const notExecuted = new Map<AgentLaunch, AgentState>();
			status.agents.forEach((agent, index) => { if ((NOT_EXECUTED_STATES as readonly string[]).includes(agent.execution)) notExecuted.set(entries[index], agent); });
			const seen = new Set<AgentLaunch>();
			// Explicit results are attributed to a node: by node_id, or by persona name when exactly one node uses that persona.
			const collected: ReportEntry[] = (results ?? status.results).map(result => {
				const entry = resultNode(entries, result);
				if (!entry || seen.has(entry)) throw new Error(`Unknown or duplicate result agent: ${result.node_id ?? result.agent_name}`);
				const skipped = notExecuted.get(entry);
				if (skipped) throw new Error(`Node ${entry.node_id} did not execute (${skipped.execution}); it cannot have a result`);
				seen.add(entry);
				const observed = executionByNode?.get(entry.node_id);
				const reportedState = executionFromResult(result.status).state;
				const savedState = observed?.result_status ? executionFromResult(observed.result_status).state : reportedState;
				return {
					...result, agent_name: entry.persona_name, node_id: entry.node_id,
					execution_state: observed?.execution ?? reportedState,
					...(observed?.execution_reason && observed.execution !== savedState ? { execution_reason: observed.execution_reason } : {}),
					...(observed?.execution_causes.length ? { causes: observed.execution_causes } : {}),
				};
			});
			if (seen.size + notExecuted.size !== entries.length) throw new Error(`Report must include exactly one result for each planned agent${notExecuted.size ? ` that executed (${[...notExecuted.keys()].map(entry => entry.node_id).join(", ")} did not execute and are reported from their records)` : ""}`);
			for (const [entry, agent] of notExecuted) {
				const state = agent.execution as NotExecutedEntry["status"];
				collected.push({ agent_name: entry.persona_name, node_id: entry.node_id, status: state, summary: `Not executed (${state}): ${agent.execution_reason ?? "no reason recorded"}`, detail: "", execution_state: state, causes: agent.execution_causes });
			}
			// Plan order for the nodes the report supplied no order for; explicit results keep the order they were given.
			if (!results) collected.sort((a, b) => entries.findIndex(entry => entry.node_id === a.node_id) - entries.findIndex(entry => entry.node_id === b.node_id));
			for (const result of collected) {
				const agent = executionByNode?.get(result.node_id!);
				const loop = agent && reviewLoopFor(status.manifest.review_plan, agent.instance_id);
				if (!agent || !loop) continue;
				const entry = entries.find(item => item.instance_id === agent.instance_id)!;
				const latest = attemptNumber(agent.attempt_id);
				const attempts: ReportReviewHistory["attempts"] = [];
				for (let number = 1; number <= latest; number++) {
					const attempt = this.reviewAttempt(status.manifest, entry, number, loop);
					if (attempt) attempts.push(attempt);
				}
				// Some terminal outcomes (such as a dispatcher cancellation) are derived from run records.
				const last = attempts.at(-1);
				if (last?.number === latest) {
					last.state = agent.execution;
				} else if (agent.execution_reason && agent.finalized) {
					attempts.push({ number: latest, state: agent.execution, summary: agent.execution_reason });
				}
				const ended = loop.reviewer === agent.instance_id && agent.finalized
					? agent.execution === "succeeded" && last?.verdict === loop.approve
						? `approved — ${last.summary}`
						: agent.execution_reason ?? agent.execution
					: undefined;
				result.review_history = { version: 1, attempt_limit: loop.max_revisions + 1, attempts, ...(ended ? { ended } : {}) };
			}
			const json = join(status.manifest.session_dir, "report.json");
			atomicJson(json, collected);
			const mdPath = join(status.manifest.session_dir, "report.md");
			// Never leave a Markdown report that disagrees with the new report.json.
			if (markdown) atomicText(mdPath, render(collected)); else rmSync(mdPath, { force: true });
			return { report_json: json, report_md: markdown ? mdPath : undefined, results: collected };
		});
	}

	/**
	 * Live tabs and panes across every workspace. Prefers one `herdr api snapshot` call; older Herdr
	 * servers fall back to explicit per-workspace listings (fetched concurrently).
	 */
	private async topology(useSnapshot: { value: boolean }, signal?: AbortSignal): Promise<LiveTopology> {
		if (useSnapshot.value) {
			try {
				const response = await this.json(["api", "snapshot"], signal);
				const snapshot = response.snapshot ?? response;
				if (Array.isArray(snapshot.tabs) && Array.isArray(snapshot.panes) && Array.isArray(snapshot.workspaces)) return { tabs: snapshot.tabs, panes: snapshot.panes };
			} catch { checkAbort(signal); }
			useSnapshot.value = false; // Unsupported or malformed: do not retry it for every agent.
		}
		const workspaces = await this.json(["workspace", "list"], signal);
		if (!Array.isArray(workspaces.workspaces)) throw new Error("Invalid workspace-list response");
		const listings = await Promise.all(workspaces.workspaces.map(async (workspace: any) => {
			const id = requiredString(workspace.workspace_id, "Live workspace_id");
			const [tabs, panes] = await Promise.all([this.json(["tab", "list", "--workspace", id], signal), this.json(["pane", "list", "--workspace", id], signal)]);
			if (!Array.isArray(tabs.tabs)) throw new Error("Invalid tab-list response");
			if (!Array.isArray(panes.panes)) throw new Error("Invalid pane-list response");
			return { tabs: tabs.tabs as any[], panes: panes.panes as any[] };
		}));
		return { tabs: listings.flatMap(listing => listing.tabs), panes: listings.flatMap(listing => listing.panes) };
	}

	private resolveSelectedAgents(manifest: BootstrapManifest, agentNames?: string[], tabIds?: string[]): AgentLaunch[] {
		if (tabIds?.length === 0) throw new Error("tab_ids must not be empty; omit it to clean all owned tabs");
		if (agentNames?.length === 0) throw new Error("agents must not be empty; omit it to select the whole run");
		if (tabIds?.some(id => !manifest.pane_manifest.some(entry => entry.tab_id === id))) throw new Error("Refusing to close tab IDs not owned by this bootstrap run");
		const byAgent = new Set<AgentLaunch>();
		for (const selector of agentNames ?? []) {
			const found = selectAgents(manifest.pane_manifest, selector);
			if (!found.length) throw new Error(`Unknown agent for this bootstrap run: ${selector}`);
			for (const entry of found) byAgent.add(entry);
		}
		const subset = tabIds !== undefined || agentNames !== undefined;
		return subset ? manifest.pane_manifest.filter(entry => (entry.tab_id !== undefined && !!tabIds?.includes(entry.tab_id)) || byAgent.has(entry)) : manifest.pane_manifest;
	}

	/** Read and, for an eligible run, evaluate automatic cleanup under the dispatcher run lock. */
	statusWithCleanup(taskId: string, cwd?: string, onCleaned?: (status: RunStatus) => void): RunStatus | Promise<RunStatus> {
		const observed = this.status(taskId, cwd);
		if (!this.readyForAutomaticCleanup(observed)) return observed;
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, cwd), true);
			const status = this.readStatus(manifest);
			if (!this.readyForAutomaticCleanup(status)) return status;

			// A decision already commits the loop. Fill in individual finalizations if its
			// agent exited during publication, before touching any Herdr resources.
			manifest.cleanup_trigger = "auto";
			manifest.cleanup_at ??= new Date(this.now()).toISOString();
			manifest.phase = "auto-cleaning";
			this.store.save(manifest);
			try {
				if (manifest.review_plan) finishReviewFinalizations(manifest.session_dir, taskId, manifest.review_plan);
			} catch (error) {
				manifest.cleanup_errors = [errorMessage(error)];
				manifest.status = "error";
				manifest.phase = "cleanup-incomplete";
				this.store.save(manifest);
				return this.readStatus(manifest);
			}
			await this.closeOwnedEntries(manifest, manifest.pane_manifest, false);
			this.store.save(manifest);
			const cleaned = this.readStatus(manifest);
			if (manifest.status === "cleaned") onCleaned?.(cleaned);
			return cleaned;
		});
	}

	private readyForAutomaticCleanup({ manifest, agents, outcome, pending, worker_errors, delivery_errors }: RunStatus): boolean {
		if (manifest.cleanup_policy?.mode !== "on_success" || manifest.status !== "applied" || manifest.session_dir_removed ||
			manifest.cleanup_errors?.length || !outcome.terminal || outcome.state !== "succeeded" || !agents.length ||
			pending.length || worker_errors.length || delivery_errors.length) return false;

		const { task_id, session_dir } = manifest;
		if (existsSync(join(session_dir, "abort.json")) || readFailFast(session_dir, task_id, manifest.token).record) return false;
		const runCancelRequested = existsSync(runCancelPath(session_dir));

		const now = this.now();
		const settleMs = manifest.cleanup_policy.settle_ms;
		let latestCompletedAt = -Infinity;
		const loopCancelRequestedAt: number[] = [];
		const ready = manifest.pane_manifest.every((entry, index) => {
			const agent = agents[index];
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			if (agent.execution !== "succeeded" || agent.parked || agent.error || (loop && !agent.finalized)) return false;
			if (!/^a[0-9]+-[a-z0-9-]+$/.test(entry.instance_id) || entry.label !== `${task_id}:${entry.instance_id}`) return false;
			try {
				const cancelInfo = readCancelRecordSafe(session_dir, this.cancelIdentity(manifest, entry));
				if (cancelInfo.error) return false;
				const attempt = attemptNumber(agent.attempt_id);
				const key = attemptKey(manifest.review_plan, entry.instance_id, attempt);
				const { claim, error } = readOutcomeClaimSafe(session_dir, this.cancelIdentity(manifest, entry, agent.attempt_id), key);
				if (error || claim?.outcome === "cancelled" || ((runCancelRequested || cancelInfo.record) && claim?.outcome !== "completed")) return false;
				const completion = parseCompletion(readJson<unknown>(resultPath(session_dir, key)), {
					...expectationFor(manifest, entry), attempt_id: agent.attempt_id,
				});
				if (completion.result.status !== "success" || existsSync(dispositionPath(session_dir, key))) return false;
				const ready = parseWorkerReady(readJson<unknown>(readyPath(session_dir, entry.instance_id)));
				const exited = ready.task_id === task_id && ready.token === manifest.token && ready.instance_id === entry.instance_id && !processAlive(ready);
				const completedAt = Date.parse(completion.completed_at);
				if (Number.isFinite(completedAt)) latestCompletedAt = Math.max(latestCompletedAt, completedAt);
				if (cancelInfo.record && loop) {
					const requestedAt = Date.parse(cancelInfo.record.requested_at);
					if (!Number.isFinite(requestedAt)) return false;
					loopCancelRequestedAt.push(requestedAt);
				}
				if (!exited && (!Number.isFinite(completedAt) || now - completedAt < settleMs)) return false;

				const outbound = outboundEdgesOf(manifest.pane_manifest, entry.instance_id);
				const routes = manifest.review_plan && completion.identity
					? reviewRoutes(session_dir, completion.identity, manifest.review_plan, completion.result, outbound)
					: outbound.map(instance => ({ instance, attempt: 1 }));
				if (loop?.reviewer === entry.instance_id && reviewVerdict(loop, completion.result) !== "approve") return false;
				// A successor can claim the handoff while Coms is still acknowledging it.
				// Only the completion's final delivery write proves the agent finished bookkeeping.
				if (!routes.length) return completion.delivery === "not_required";
				if (completion.delivery === "failed" && exited) {
					return manifest.review_plan
						? reviewDeliveryClaimed(session_dir, completion, routes)
						: routes.every(({ instance }) => (agent.handoffs_out?.[instance] ?? agent.handoff_out)?.state === "accepted");
				}
				return completion.delivery === "sent" && (manifest.topology !== "graph" && !manifest.review_plan ||
					routes.every(({ instance }) => completion.edge_deliveries?.[instance]?.state === "sent"));
			} catch { return false; }
		});
		if (!ready) return false;
		return loopCancelRequestedAt.every(requestedAt => Number.isFinite(latestCompletedAt) && requestedAt >= latestCompletedAt);
	}

	/** Verify Herdr ownership and close only the selected owned tabs/panes, updating manifest state. */
	private async closeOwnedEntries(manifest: BootstrapManifest, selected: AgentLaunch[], subset: boolean, signal?: AbortSignal): Promise<{ closed: string[] }> {
		const automatic = manifest.phase === "auto-cleaning";
		manifest.cleanup_errors = [];
		manifest.cleanup_notes = [];
		const closed: string[] = [];
		const useSnapshot = { value: true };
		// A live view stays valid until we close something (public tab/pane IDs may compact after a close).
		let live: LiveTopology | undefined;
		for (const entry of selected) {
			if (entry.status === "closed" || entry.status === "planned") continue;
			try {
				checkAbort(signal);
				live ??= await this.topology(useSnapshot, signal);
				const { tabs, panes: livePanes } = live;
				const matches = tabs.filter((tab: any) => tab.label === entry.label);
				if (matches.length > 1) throw new Error(`Ambiguous ownership label ${entry.label}`);
				let ownedTabId: string | undefined;
				let ownedPaneId: string | undefined;
				if (entry.terminal_id) {
					const owned = livePanes.filter((pane: any) => pane.terminal_id === entry.terminal_id);
					if (owned.length > 1) throw new Error(`Ambiguous terminal ownership for ${nodeLabel(entry)}`);
					if (owned.length === 1) {
						ownedTabId = requiredString(owned[0].tab_id, "Owned tab_id");
						// A user may have renamed the tab, moved our terminal, or added unrelated panes.
						// Close only our pane in that case, never the surrounding user-owned tab.
						if (matches[0]?.tab_id !== ownedTabId || livePanes.filter((pane: any) => pane.tab_id === ownedTabId).length !== 1) {
							ownedPaneId = requiredString(owned[0].pane_id, "Owned pane_id");
						}
					} else if (matches.length) throw new Error(`Terminal ownership mismatch for ${nodeLabel(entry)}; tab may have been replaced`);
				} else if (matches.length === 1) ownedTabId = requiredString(matches[0].tab_id, "Owned tab_id");
				if (ownedPaneId || ownedTabId) {
					// Whatever the outcome, IDs may have changed: the next agent re-resolves from a fresh view.
					live = undefined;
					if (ownedPaneId) await this.command(["pane", "close", ownedPaneId], signal);
					else await this.command(["tab", "close", ownedTabId!], signal);
				} else manifest.cleanup_notes.push(`${nodeLabel(entry)}: no live tab or pane found; treated as already closed`);
				entry.status = "closed";
				closed.push(entry.node_id);
				this.store.save(manifest);
			} catch (error) {
				manifest.cleanup_errors.push(`${nodeLabel(entry)}: ${errorMessage(error)}`);
				if (automatic) {
					manifest.status = "error";
					manifest.phase = "cleanup-incomplete";
					this.store.save(manifest);
				}
			}
		}
		const allClosed = manifest.pane_manifest.every(entry => entry.status === "closed" || entry.status === "planned");
		if (allClosed && !manifest.cleanup_errors.length) { manifest.status = "cleaned"; manifest.phase = "cleaned"; }
		// A successful subset close leaves the run's status alone; the other agents keep running.
		else if (subset && !manifest.cleanup_errors.length) manifest.phase = "partially-cleaned";
		else { manifest.status = "error"; manifest.phase = "cleanup-incomplete"; }
		return { closed };
	}

	/** Propagate `blocked` dispositions to followers whose inbound edge is terminal and unacceptable (without overwriting existing results/dispositions). */
	private propagateBlockedChain(manifest: BootstrapManifest, targetedInstances: Set<string>, nowIso: string, problems: Map<string, string>): void {
		if (manifest.session_dir_removed) return;
		const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry]));
		for (let pass = 0; pass < manifest.pane_manifest.length; pass++) {
			let changed = false;
			for (const entry of manifest.pane_manifest) {
				if (targetedInstances.has(entry.instance_id)) continue;
				const attempt = this.readAttemptForCancel(manifest, entry, problems);
				if (!attempt) continue;
				const { current, key: activeKey, attempt_id: activeAttempt } = attempt;
				let key = activeKey;
				let attempt_id = activeAttempt;
				let inbound = current?.source ? [current.source] : inboundEdgesOf(entry);
				const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
				const forward = byInstance.get(inboundEdgesOf(entry)[0]);
				if (current && loop && entry.instance_id !== loop.target && forward && loop.members.includes(forward.instance_id) &&
					this.readAttemptForCancel(manifest, forward, problems)?.current?.number === current.number + 1) {
					// A parked follower's previous result belongs to the previous iteration. Its next attempt can be blocked
					// before it has a handoff to claim, if the source of that attempt already failed or was cancelled.
					key = attemptKey(manifest.review_plan, entry.instance_id, current.number + 1);
					attempt_id = key;
					inbound = [forward.instance_id];
				}
				if (!inbound.length) continue;
				if (existsSync(resultPath(manifest.session_dir, key)) || existsSync(dispositionPath(manifest.session_dir, key))) continue;
				const claimFile = inbound.length > 1
					? handoffClaimPath(manifest.session_dir, key)
					: handoffClaimPath(manifest.session_dir, key, (manifest.topology === "graph" || manifest.review_plan) ? inbound[0] : undefined);
				if (existsSync(claimFile)) continue;
				const policy = inbound.length > 1
					? effectiveDependencyPolicy(entry.join_policy, dependencyPolicyOf(entry, true))
					: dependencyPolicyOf(entry, true)!;
				const reasons: string[] = [];
				const causes: CauseRef[] = [];
				const seenCause = new Set<string>();
				for (const sourceId of inbound) {
					const pred = byInstance.get(sourceId);
					if (!pred) continue;
					let predExec: { state: ExecutionState; causes: CauseRef[]; reason?: string } | undefined;
					const predRecord = this.readAttemptForCancel(manifest, pred, problems);
					if (!predRecord) continue;
					const predDispPath = dispositionPath(manifest.session_dir, predRecord.key);
					const predResPath = resultPath(manifest.session_dir, predRecord.key);
					if (existsSync(predResPath)) {
						try {
							const comp = parseCompletion(readJson<unknown>(predResPath), predRecord.expected);
							predExec = { ...executionFromResult(comp.result.status), reason: comp.result.summary };
						} catch { continue; }
					} else if (existsSync(predDispPath)) {
						try {
							const disp = parseDisposition(readJson<unknown>(predDispPath), predRecord.expected);
							predExec = { state: disp.state, causes: disp.causes, reason: disp.reason };
						} catch { continue; }
					}
					if (!predExec) continue;
					const decision = decideAdmission({ policy, predecessor: { node_id: pred.node_id, execution: predExec }, checks: [] });
					if (!decision.admit && decision.outcome === "blocked") {
						reasons.push(decision.reason);
						for (const cause of decision.causes) {
							const key = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`;
							if (!seenCause.has(key)) { seenCause.add(key); causes.push(cause); }
						}
					}
				}
				if (reasons.length > 0) {
					const path = dispositionPath(manifest.session_dir, key);
					const record = dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "blocked", reasons.join("; "), causes, nowIso);
					if (manifest.review_plan) changed = publishExclusive(path, JSON.stringify(record, null, 2) + "\n") || changed;
					else { atomicJson(path, record); changed = true; }
				}
			}
			if (!changed) break;
		}
	}

	/**
	 * Cancel a whole run or selected nodes without closing tabs or deleting session files.
	 * Persists durable cancellation intent before signalling workers. After the grace period,
	 * `force_close: true` closes verified owned tabs/panes for the cancelled nodes.
	 */
	private persistPreReleaseCancel(
		manifest: BootstrapManifest,
		reason: string,
		scope: "run" | "node",
		entries: AgentLaunch[],
		nowIso: string,
		graceMs: number,
		writeDispositions: boolean,
		problems: Map<string, string>,
	): void {
		if (scope === "run") {
			writeRunCancelRecord(manifest.session_dir, { run_id: manifest.task_id, reason, requestedAt: nowIso, graceMs });
			if (!existsSync(join(manifest.session_dir, "release.json"))) {
				try { atomicJson(join(manifest.session_dir, "abort.json"), { task_id: manifest.task_id, token: manifest.token, error: reason }); } catch { /* best effort */ }
			}
		}
		for (const entry of entries) {
			const attempt = this.readAttemptForCancel(manifest, entry, problems);
			if (!attempt) continue;
			const { key, attempt_id } = attempt;
			writeCancelRecord(manifest.session_dir, { identity: this.cancelIdentity(manifest, entry), scope, reason, requestedAt: nowIso, graceMs });
			if (writeDispositions && !existsSync(dispositionPath(manifest.session_dir, key))) {
				atomicJson(dispositionPath(manifest.session_dir, key), dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", reason, [], nowIso));
			}
		}
	}

	private validateForceCloseGrace(manifest: BootstrapManifest, selected: AgentLaunch[], available: boolean, nowMs: number, problems: Map<string, string>): void {
		for (const entry of selected) {
			const attempt = this.readAttemptForCancel(manifest, entry, problems);
			if (!attempt) continue;
			const { key, expected } = attempt;
			if (entry.status === "closed" || entry.status === "planned") continue;
			if (available && existsSync(resultPath(manifest.session_dir, key))) {
				const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
				let finalizedLoop = !loop;
				if (loop) {
					try { finalizedLoop = !!readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id); }
					catch { finalizedLoop = true; }
				}
				if (finalizedLoop) continue;
			}
			if (available && existsSync(dispositionPath(manifest.session_dir, key))) {
				try {
					const disp = parseDisposition(readJson<unknown>(dispositionPath(manifest.session_dir, key)), expected);
					if (disp.state !== "cancelled" && disp.state !== "needs_attention") continue;
				} catch { /* fall through */ }
			}
			const cancelInfo = available ? readCancelRecordSafe(manifest.session_dir, this.cancelIdentity(manifest, entry)) : {};
			if (cancelInfo.error) throw new Error(cancelInfo.error);
			if (!cancelInfo.record) {
				throw new Error(`Cannot force-close ${nodeLabel(entry)}: cancellation must be requested first and the grace period must elapse`);
			}
			const remaining = graceRemainingMs(cancelInfo.record, nowMs);
			if (remaining > 0) {
				throw new Error(`Cannot force-close ${nodeLabel(entry)} before the cancellation grace period elapses (${remaining}ms remaining)`);
			}
		}
	}

	private settleCancelledReview(manifest: BootstrapManifest, entry: AgentLaunch, problems: Map<string, string>): void {
		const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
		if (!loop) return;
		try {
			const attempt = this.readAttemptForCancel(manifest, entry, problems);
			if (!attempt) return;
			const path = dispositionPath(manifest.session_dir, attempt.key);
			if (!existsSync(path)) return;
			const disposition = parseDisposition(readJson<unknown>(path), attempt.expected);
			if (disposition.state !== "cancelled") return;
			for (const member of manifest.pane_manifest) {
				if (loop.members.includes(member.instance_id) && !this.readAttemptForCancel(manifest, member, problems)) return;
			}
			settleReviewFailure({
				...entry, attempt_id: attempt.attempt_id, task_id: manifest.task_id,
				session_dir: manifest.session_dir, review_plan: manifest.review_plan, roster: manifest.pane_manifest,
			}, disposition);
		} catch (error) {
			problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
		}
	}

	private async propagateLoopBodyCancel(params: {
		manifest: BootstrapManifest;
		scope: "run" | "node";
		reason: string;
		nowMs: number;
		nowIso: string;
		graceMs: number;
		released: boolean;
		forceClose: boolean;
		cancelledOrCancellingInstances: Set<string>;
		cancelling: CancelResult["cancelling"];
		problems: Map<string, string>;
	}): Promise<void> {
		const { manifest, scope, reason, nowMs, nowIso, graceMs, released, forceClose, cancelledOrCancellingInstances, cancelling, problems } = params;
		if (!manifest.review_plan) return;
		const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry]));
		const isWorkingAttempt = (entry: AgentLaunch, key: string): boolean => {
			if (!released || entry.status === "closed") return false;
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (existsSync(readyFile)) {
				try { if (!processAlive(parseWorkerReady(readJson<unknown>(readyFile)))) return false; } catch { /* ignore */ }
			}
			try {
				const progress = readJson<ProgressSnapshot>(join(manifest.session_dir, `${entry.instance_id}.progress.json`));
				return progress.token === manifest.token && progress.state === "working" && progress.attempt_id === key;
			} catch { return false; }
		};
		for (const loop of manifest.review_plan.loops) {
			if (!loop.members.some(id => cancelledOrCancellingInstances.has(id))) continue;
			try {
				if (readFinalization(manifest.session_dir, manifest.task_id, loop, loop.reviewer)) continue;
				let maxAttempt = 1;
				for (const id of loop.members) {
					const entry = byInstance.get(id);
					const att = entry ? this.readAttemptForCancel(manifest, entry, problems) : undefined;
					if (att?.current && att.current.number > maxAttempt) maxAttempt = att.current.number;
				}
				const firstIdx = loop.members.findIndex(id => cancelledOrCancellingInstances.has(id));
				const sourceEntry = byInstance.get(loop.members[firstIdx]);
				if (!sourceEntry) continue;
				for (const memberId of loop.members.slice(firstIdx + 1)) {
					const member = byInstance.get(memberId);
					if (!member) continue;
					const key = attemptKey(manifest.review_plan, memberId, maxAttempt);
					if (existsSync(resultPath(manifest.session_dir, key)) || existsSync(dispositionPath(manifest.session_dir, key))) continue;
					if (isWorkingAttempt(member, key)) {
						const arb = claimOutcome(manifest.session_dir, this.cancelIdentity(manifest, member, key), "cancelled", nowIso, key);
						if (!arb.won) continue;
						const cancelRecord = writeCancelRecord(manifest.session_dir, {
							identity: this.cancelIdentity(manifest, member),
							scope,
							reason,
							requestedAt: nowIso,
							graceMs,
						});
						cancelledOrCancellingInstances.add(memberId);
						if (!forceClose) await this.signalNode(manifest, member, cancelRecord);
						if (!cancelling.some(c => c.instance_id === memberId)) {
							const remaining = graceRemainingMs(cancelRecord, nowMs);
							cancelling.push({
								node_id: member.node_id,
								instance_id: member.instance_id,
								grace_remaining_ms: remaining,
								force_close_allowed: remaining === 0,
								note: "In-progress tool or model turn cannot be interrupted or undone by hooks; waiting to settle or force_close after grace period.",
							});
						}
					} else {
						const dispReason = `${sourceEntry.node_id} was cancelled: ${reason}`;
						const record = dispositionRecord(
							{ ...member, attempt_id: key, task_id: manifest.task_id },
							"blocked",
							dispReason,
							[{ node_id: sourceEntry.node_id, state: "cancelled", reason }],
							nowIso,
						);
						publishExclusive(dispositionPath(manifest.session_dir, key), JSON.stringify(record, null, 2) + "\n");
					}
				}
				const reviewerKey = attemptKey(manifest.review_plan, loop.reviewer, maxAttempt);
				if (existsSync(resultPath(manifest.session_dir, reviewerKey)) || existsSync(dispositionPath(manifest.session_dir, reviewerKey))) {
					finalizeReview(manifest.session_dir, manifest.task_id, loop, maxAttempt, undefined, loop.reviewer, { force: true });
				}
			} catch (error) {
				problems.set(loop.reviewer, `${loop.reviewer}: ${errorMessage(error)}`);
			}
		}
	}

	private async cancelEntries(params: {
		manifest: BootstrapManifest;
		selected: AgentLaunch[];
		scope: "run" | "node";
		reason: string;
		nowMs: number;
		nowIso: string;
		graceMs: number;
		available: boolean;
		released: boolean;
		forceClose: boolean;
		problems: Map<string, string>;
	}) {
		const { manifest, selected, scope, reason, nowMs, nowIso, graceMs, available, released, forceClose, problems } = params;
		const cancelled: string[] = [];
		const cancelling: CancelResult["cancelling"] = [];
		const already_completed: string[] = [];
		const already_settled: string[] = [];
		const cancelledOrCancellingInstances = new Set<string>();
		const forceCloseTargets: AgentLaunch[] = [];

		const isActivelyWorking = (entry: AgentLaunch, key: string): boolean => {
			if (!available || !released || entry.status === "closed") return false;
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (existsSync(readyFile)) {
				try { if (!processAlive(parseWorkerReady(readJson<unknown>(readyFile)))) return false; } catch { /* ignore */ }
			}
			try {
				const progress = readJson<ProgressSnapshot>(join(manifest.session_dir, `${entry.instance_id}.progress.json`));
				return progress.token === manifest.token && progress.state === "working" && (!manifest.review_plan || progress.attempt_id === key);
			} catch { return false; }
		};

		for (const entry of selected) {
			const attempt = this.readAttemptForCancel(manifest, entry, problems);
			if (!attempt) continue;
			const { key, attempt_id, current, expected } = attempt;
			if (available && existsSync(resultPath(manifest.session_dir, key))) {
				let completedResult = false;
				try {
					parseCompletion(readJson<unknown>(resultPath(manifest.session_dir, key)), expected);
					completedResult = true;
				} catch { /* unusable result file does not block cancellation */ }
				if (completedResult) {
					const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
					let finalizedLoop = !loop;
					if (loop) {
						try { finalizedLoop = !!readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id); }
						catch { finalizedLoop = true; }
					}
					if (finalizedLoop) {
						already_completed.push(entry.node_id);
						continue;
					}
					// Parked loop member: stop future revisions and settle any already-reserved next attempt.
					const nextAttempt = (current?.number ?? 1) + 1;
					const reservedNext = revisionReserved(manifest.session_dir, manifest.task_id, loop!, nextAttempt);
					if (reservedNext) {
						const nextKey = attemptKey(manifest.review_plan, entry.instance_id, nextAttempt);
						const arbitration = claimOutcome(manifest.session_dir, this.cancelIdentity(manifest, entry, nextKey), "cancelled", nowIso, nextKey);
						if (!arbitration.won) {
							try { rmSync(cancelPath(manifest.session_dir, entry.instance_id), { force: true }); } catch { /* best effort */ }
							already_completed.push(entry.node_id);
							continue;
						}
						const cancelRecord = writeCancelRecord(manifest.session_dir, {
							identity: this.cancelIdentity(manifest, entry),
							scope,
							reason,
							requestedAt: nowIso,
							graceMs,
						});
						cancelledOrCancellingInstances.add(entry.instance_id);
						if (forceClose && entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
						const nextDispFile = dispositionPath(manifest.session_dir, nextKey);
						if (!existsSync(nextDispFile)) {
							const dispReason = forceClose ? `${cancelRecord.reason} (force-closed after grace period)` : cancelRecord.reason;
							atomicJson(nextDispFile, dispositionRecord({ ...entry, attempt_id: nextKey, task_id: manifest.task_id }, "cancelled", dispReason, [], nowIso));
						}
						if (!forceClose) await this.signalNode(manifest, entry, cancelRecord);
						cancelled.push(entry.node_id);
						continue;
					}
					const cancelRecord = writeCancelRecord(manifest.session_dir, {
						identity: this.cancelIdentity(manifest, entry),
						scope,
						reason,
						requestedAt: nowIso,
						graceMs,
					});
					cancelledOrCancellingInstances.add(entry.instance_id);
					if (!forceClose) await this.signalNode(manifest, entry, cancelRecord);
					if (forceClose && entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
					cancelled.push(entry.node_id);
					continue;
				}
			}
			const dispFile = dispositionPath(manifest.session_dir, key);
			let existingDisposition: Disposition | undefined;
			if (available && existsSync(dispFile)) {
				try { existingDisposition = parseDisposition(readJson<unknown>(dispFile), expected); } catch { /* ignore */ }
			}
			if (existingDisposition && (existingDisposition.state === "blocked" || existingDisposition.state === "skipped")) {
				already_settled.push(entry.node_id);
				continue;
			}
			if (existingDisposition?.state === "cancelled" && !forceClose) {
				already_settled.push(entry.node_id);
				cancelledOrCancellingInstances.add(entry.instance_id);
				continue;
			}
			if (!available) {
				if (forceClose && entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
				else already_settled.push(entry.node_id);
				continue;
			}

			// Arbitrate outcome exclusively via link(2) before persisting node cancel intent, so a winning completion is never overwritten.
			const arbitration = claimOutcome(manifest.session_dir, this.cancelIdentity(manifest, entry, attempt_id), "cancelled", nowIso, key);
			if (!arbitration.won) {
				const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
				let finalizedLoop = !loop;
				if (loop) {
					try { finalizedLoop = !!readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id); }
					catch { finalizedLoop = true; }
				}
				if (finalizedLoop) {
					try { rmSync(cancelPath(manifest.session_dir, entry.instance_id), { force: true }); } catch { /* best effort */ }
				}
				already_completed.push(entry.node_id);
				continue;
			}
			// Persist durable cancellation intent BEFORE signalling the worker.
			const cancelRecord = writeCancelRecord(manifest.session_dir, {
				identity: this.cancelIdentity(manifest, entry),
				scope,
				reason,
				requestedAt: nowIso,
				graceMs,
			});

			cancelledOrCancellingInstances.add(entry.instance_id);
			if (!forceClose) await this.signalNode(manifest, entry, cancelRecord);

			const working = isActivelyWorking(entry, key);
			if (forceClose) {
				if (entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
				if (!existingDisposition && !existsSync(resultPath(manifest.session_dir, key))) {
					const forceReason = (working || existsSync(handoffClaimPath(manifest.session_dir, key, manifest.review_plan ? current?.source : undefined)))
						? `${cancelRecord.reason} (force-closed after grace period; any in-flight tool side effects could not be undone)`
						: `${cancelRecord.reason} (force-closed after grace period)`;
					atomicJson(dispFile, dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", forceReason, [], nowIso));
					cancelled.push(entry.node_id);
				} else if (existingDisposition?.state === "cancelled") {
					already_settled.push(entry.node_id);
				}
				continue;
			}

			if (working) {
				const remaining = graceRemainingMs(cancelRecord, nowMs);
				cancelling.push({
					node_id: entry.node_id,
					instance_id: entry.instance_id,
					grace_remaining_ms: remaining,
					force_close_allowed: remaining === 0,
					note: "In-progress tool or model turn cannot be interrupted or undone by hooks; waiting to settle or force_close after grace period.",
				});
			} else {
				if (!existingDisposition) {
					atomicJson(dispFile, dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", cancelRecord.reason, [], nowIso));
				}
				cancelled.push(entry.node_id);
			}
		}

		return { cancelled, cancelling, already_completed, already_settled, cancelledOrCancellingInstances, forceCloseTargets };
	}

	private isTerminalForBlocking(manifest: BootstrapManifest, entry: AgentLaunch, problems: Map<string, string>): boolean {
		const attempt = this.readAttemptForCancel(manifest, entry, problems);
		if (!attempt) return false;
		const { key, expected } = attempt;
		if (existsSync(resultPath(manifest.session_dir, key))) {
			try { parseCompletion(readJson<unknown>(resultPath(manifest.session_dir, key)), expected); return true; } catch { /* ignore */ }
		}
		if (existsSync(dispositionPath(manifest.session_dir, key))) {
			try {
				const disp = parseDisposition(readJson<unknown>(dispositionPath(manifest.session_dir, key)), expected);
				return disp.state === "skipped" || disp.state === "cancelled";
			} catch { /* ignore */ }
		}
		return false;
	}

	async cancel(taskId: string, options: CancelOptions = {}): Promise<CancelResult> {
		const reason = options.reason?.trim() || (options.agents ? "Node cancelled" : "Run cancelled");
		if (options.grace_ms !== undefined && (!Number.isInteger(options.grace_ms) || options.grace_ms < 0 || options.grace_ms > 300_000)) {
			throw new Error("grace_ms must be an integer between 0 and 300000");
		}
		const initial = this.store.load(taskId, options.cwd, true);
		const selectedInitial = this.resolveSelectedAgents(initial, options.agents);
		const scope: "run" | "node" = options.agents !== undefined ? "node" : "run";
		const initialNowIso = new Date(this.now()).toISOString();
		const initialGraceMs = options.grace_ms ?? initial.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS;
		const problems = new Map<string, string>();

		// If a launch is currently holding the run lock at the readiness barrier, persist cancel intent first so generate() aborts immediately.
		if (initial.status === "launching" && !initial.session_dir_removed && lockHeld(join(this.store.indexRoot, taskId))) {
			this.persistPreReleaseCancel(initial, reason, scope, selectedInitial, initialNowIso, initialGraceMs, false, problems);
		}

		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, options.cwd, true), true);
			const selected = this.resolveSelectedAgents(manifest, options.agents);
			const graceMs = options.grace_ms ?? manifest.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS;
			const nowMs = this.now();
			const nowIso = new Date(nowMs).toISOString();
			const available = !manifest.session_dir_removed;
			const released = available && existsSync(join(manifest.session_dir, "release.json"));

			if (options.force_close) {
				this.validateForceCloseGrace(manifest, selected, available, nowMs, problems);
			}
			if (available && scope === "run" && !options.force_close) {
				writeRunCancelRecord(manifest.session_dir, { run_id: taskId, reason, requestedAt: nowIso, graceMs });
				if (!released) {
					try { atomicJson(join(manifest.session_dir, "abort.json"), { task_id: taskId, token: manifest.token, error: reason }); } catch { /* best effort */ }
				}
			}

			const {
				cancelled,
				cancelling,
				already_completed,
				already_settled,
				cancelledOrCancellingInstances,
				forceCloseTargets,
			} = await this.cancelEntries({ manifest, selected, scope, reason, nowMs, nowIso, graceMs, available, released, forceClose: !!options.force_close, problems });

			let force_closed: string[] = [];
			if (options.force_close && forceCloseTargets.length) {
				const openTotal = manifest.pane_manifest.filter(entry => entry.status !== "closed" && entry.status !== "planned").length;
				const subset = scope === "node" || forceCloseTargets.length < openTotal;
				({ closed: force_closed } = await this.closeOwnedEntries(manifest, forceCloseTargets, subset, options.signal));
				this.store.save(manifest);
				// Re-check if any worker committed a result right as its resource closed.
				for (const entry of forceCloseTargets) {
					const attempt = this.readAttemptForCancel(manifest, entry, problems);
					if (!attempt) continue;
					const { key } = attempt;
					if (available && existsSync(resultPath(manifest.session_dir, key)) && !existsSync(dispositionPath(manifest.session_dir, key))) {
						if (!already_completed.includes(entry.node_id)) already_completed.push(entry.node_id);
					}
				}
			}

			if (available && manifest.review_plan) {
				for (const entry of selected) {
					if (cancelledOrCancellingInstances.has(entry.instance_id)) this.settleCancelledReview(manifest, entry, problems);
				}
				await this.propagateLoopBodyCancel({ manifest, scope, reason, nowMs, nowIso, graceMs, released, forceClose: !!options.force_close, cancelledOrCancellingInstances, cancelling, problems });
			}
			const targetedInstances = new Set(selected.map(entry => entry.instance_id));
			if (!manifest.review_plan || cancelledOrCancellingInstances.size) this.propagateBlockedChain(manifest, targetedInstances, nowIso, problems);
			const blocked_dependents = computeDownstreamBlockers(manifest.pane_manifest, cancelledOrCancellingInstances)
				.filter(dep => {
					if (already_completed.includes(dep.node_id)) return false;
					const entry = manifest.pane_manifest.find(e => e.instance_id === dep.instance_id);
					return !entry || !available || !this.isTerminalForBlocking(manifest, entry, problems);
				});

			return {
				task_id: taskId,
				scope,
				reason,
				requested_at: nowIso,
				grace_ms: graceMs,
				cancelled,
				cancelling,
				already_completed,
				already_settled,
				blocked_dependents,
				force_closed,
				...(problems.size ? { record_errors: [...problems.values()] } : {}),
				cleanup_errors: manifest.cleanup_errors ?? [],
				cleanup_notes: manifest.cleanup_notes ?? [],
				limitations: "Hooks cannot undo tool side effects already in progress. Cancellation stops new admission and leaves tabs/files untouched (use bootstrap_cleanup, or force_close after the grace period).",
				manifest,
			};
		});
	}

	async cleanup(taskId: string, tabIds?: string[], deleteSessionFiles = false, cwd?: string, signal?: AbortSignal, agentNames?: string[]): Promise<BootstrapManifest> {
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, cwd, true), true);
			if (manifest.status === "cleaned" && (!deleteSessionFiles || manifest.session_dir_removed)) return manifest;
			const selected = this.resolveSelectedAgents(manifest, agentNames, tabIds);
			const subset = tabIds !== undefined || agentNames !== undefined;
			if (!subset && manifest.review_plan && !manifest.session_dir_removed) {
				try { finishReviewFinalizations(manifest.session_dir, taskId, manifest.review_plan); }
				catch (error) {
					manifest.cleanup_errors = [errorMessage(error)];
					manifest.status = "error";
					manifest.phase = "cleanup-incomplete";
					this.store.save(manifest);
					return manifest;
				}
			}
			// A full cleanup ends the run: children still at the readiness barrier must exit. A subset close does not.
			if (!subset && !manifest.session_dir_removed) atomicJson(join(manifest.session_dir, "abort.json"), { task_id: taskId, token: manifest.token, error: "Run cleaned up" });
			await this.closeOwnedEntries(manifest, selected, subset, signal);
			if (manifest.status === "cleaned" && deleteSessionFiles && !manifest.session_dir_removed) {
				this.store.assertDirectory(manifest);
				rmSync(manifest.session_dir, { recursive: true });
				manifest.session_dir_removed = true;
				manifest.session_files_deleted = true;
			}
			this.store.save(manifest);
			return manifest;
		});
	}
}

/** Resolve one agent's ownership status and surface any corrupt, foreign, or unsupported ownership record as an error. */
function resolveAgentOwnershipStatus(params: {
	manifest: BootstrapManifest;
	entry: AgentLaunch;
	label: string;
	roster: Array<Pick<RosterEntry, "instance_id" | "node_id" | "persona_name">>;
	completion: WorkerCompletion | undefined;
	disposition: Disposition | undefined;
	state: AgentState;
	workerErrors: string[];
	now: number;
}): void {
	const { manifest, entry, label, roster, completion, disposition, state, workerErrors, now } = params;
	const ownFile = ownershipPath(manifest.session_dir, entry.instance_id);
	if (!entry.write_paths?.length && !entry.read_paths?.length && !entry.ownership_wait_for?.length && !existsSync(ownFile)) return;
	let ownRecord: OwnershipAdmissionRecord | undefined;
	if (existsSync(ownFile)) {
		try {
			ownRecord = parseOwnershipRecord(readJson<unknown>(ownFile), expectationFor(manifest, entry));
		} catch (error) {
			const message = `unusable ownership record: ${errorMessage(error)}`;
			state.error ??= message;
			workerErrors.push(`${label}: ${message}`);
		}
	}
	if ((completion && (!reviewLoopFor(manifest.review_plan, entry.instance_id) || !entry.write_paths?.length || state.finalized)) || (disposition && disposition.state !== "needs_attention")) {
		state.ownership_status = "released";
	} else if (entry.ownership_wait_for?.length && ownRecord?.state !== "admitted" && ownRecord?.state !== "released") {
		const evalOwn = evaluateOwnershipDependencies({
			sessionDir: manifest.session_dir,
			taskId: manifest.task_id,
			token: manifest.token,
			waitingFor: entry.ownership_wait_for,
			reviewPlan: manifest.review_plan,
			instanceId: entry.instance_id,
			roster,
			nowMs: now,
		});
		if (!evalOwn.admitted) {
			state.ownership_waiting_on = evalOwn.waiting_on;
			state.ownership_status = evalOwn.waiting_on.some(w => w.status === "uncertain") ? "held_uncertain" : "waiting";
		} else if (ownRecord) {
			state.ownership_status = ownRecord.state;
		}
	} else if (ownRecord) {
		state.ownership_status = ownRecord.state;
	}
}
