/** Launch orchestration; Herdr subprocess execution is the only injected system boundary. */
import { attemptClaimedOrStarted, attemptKey, attemptNumber, blockedReviewForwardEdge, finalizeMemberAfterDecision, finalizeReview, finalizedReviewRejection, finishReviewFinalizations, readFinalization, readLoopTransition, revisionCapacity, revisionExhaustionReason, revisionReserved, finalizePath, reviewLoopFor, reviewRoutes, reviewVerdict, settleReviewFailure, type ReviewLoop, type ReviewPlan } from "./review-loop.ts";
import { DatabaseSync } from "node:sqlite";
import { accessSync, closeSync, constants, existsSync, fsyncSync, openSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { ensureSessionDir, generateTaskId, piAgentDir, resolveExtensionPaths, scanAgents } from "./bootstrap-utils.ts";
import { isThinkingLevel, modelMatches, readBootstrapConfig, readModelAliases, resolveModel } from "./model-utils.ts";
import { validateInterventionPolicy, type InterventionPolicy } from "./intervention.ts";
import { planDecisions, validateGraphLimits, type DecisionPlan, type PlannedDecision, type RequestedDecision } from "./decisions.ts";
import { aggregateRun, decideAdmission, DEPENDENCY_POLICIES, deriveEdgeState, effectiveDependencyPolicy, executionFromResult, JOIN_POLICIES, NOT_EXECUTED_STATES, type CauseRef, type DependencyPolicy, type EdgeState, type EvidenceStatus, type ExecutionState, type JoinPolicy, type RunOutcome } from "./outcomes.ts";
import { requiredChecksOf, verifyEvidence } from "./evidence.ts";
import { generateFactoryTaskId, inspectFactoryReleaseState, isFactoryRequestId, isFactoryTaskId, ManagedManifestContradictionError, metadataMismatch, parseNormalizedFactoryManagedInfo, readAndValidateManagedManifest } from "./factory-evidence.ts";
import { readFactoryRunIndex } from "./factory-index.ts";
import { directionProcess, verifyBoundReviewPlan, type BoundDirectionDefinition, type DirectionReceiver, type DirectionRoutingView, type DirectionRequestView, type StoredRequest, type requestDecisionEvidence } from "./factory-requests.ts";
import {
	assertNoSymlinkPath, assertTaskId, atomicJson, atomicText, checkAbort, coordAnchorPath, coordMetaRecordDigest, createDurableDirectoryPath, CURRENT_VERSION, DEFAULT_CLEANUP_SETTLE_MS, MAX_CLEANUP_SETTLE_MS, delay, dependencyPolicyOf, dispositionPath, dispositionRecord, errorMessage, expectationFor, expectedResultVersion, factoryRunPath, formatCommandDisplay, GRAPH_REVIEW_VERSION, GRAPH_VERSION, inboundEdgesOf, JOIN_GRAPH_VERSION, REVIEW_VERSION, lockHeld, NODE_ID_PATTERN, nodeLabel, outboundEdgesOf, parseCompletion, parseCoordAnchor, parseDisposition, parseFactoryManagedInfo, parseManifest, parseWorkerConfig, parseWorkerReady, pathEntryExists, processAlive, publishExclusive,
	readJson, readRegularJsonNoSymlink, readyPath, resolveCommandWorkingDirectory, resultPath, SessionStore, syncDirectory, unknownAllowedSkills, validateCommandArgs, validateCommandString, withRunLock, workerStartupMessages,
	type AgentLaunch, type BootstrapManifest, type BootstrapResult, type CleanupMode, type CommandEvidence, type Disposition, type FactoryManagedInfo, type NodeKind, type NotExecutedEntry, type ReportEntry, type ReportReviewHistory, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import {
	cancelPath, claimOutcome, computeDownstreamBlockers, DEFAULT_CANCEL_GRACE_MS, DEFAULT_DEPENDENCY_WAIT_MS, DEFAULT_LIVENESS_MS, diagnoseLiveness, graceRemainingMs, humanWaitStartedAt, readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe, runCancelPath, writeCancelRecord, writeRunCancelRecord,
	type CancelIdentity, type CancelRecord, type LivenessState, type ProgressSnapshot,
} from "./cancellation.ts";
import {
	boundRosterEntries, buildTaskInputRecord, canonicalJson, deriveNodeAttemptCountsFromIndex, readValidatedUpstreamIndex, resolvePublishableRequiredArtifactPath, resolveStandaloneRequiredArtifactPath, taskInputPath, upstreamIndexPath, validateOutputContractSyntax,
	type NodeAttemptCount, type OutputContract, type RosterEntry,
} from "./contracts.ts";
import { currentAttempt, describeHandoff, HANDOFF_PROTOCOL, handoffClaimPath, handoffOfferPath, handoffId, inputDigest, isLegacyClaim, parseHandoffClaim, reviewDeliveryClaimed, type HandoffView } from "./handoff.ts";
import { chainEdges, inspectRun, retryDelivery, type RecoveryDeps, type RecoveryReport, type RecoveryRequest } from "./recovery.ts";
import { observeSettlement, type SettlementObservations } from "./factory-settlement.ts";
import { evaluateNodeVerification, verificationPath, type VerificationEvaluation } from "./verification.ts";
import {
	COLLABORATION_MODES, computeOwnershipSchedule, evaluateOwnershipDependencies, FAILURE_POLICIES, normalizeOwnershipPaths, ownershipPath, ownershipRecord, parseOwnershipRecord, readFailFast, WORKSPACE_STRATEGY,
	type CollaborationMode, type FailurePolicy, type OwnershipAdmissionRecord, type OwnershipConflict, type OwnershipStatus, type OwnershipWaitDetail, type ResolvedCollaborationMode, type WorkspaceStrategy,
} from "./ownership.ts";

export interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; truncated?: boolean }
export type Executor = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;
/**
 * One requested assignment. Either the legacy form (`name` is both the persona and the node ID) or the explicit form
 * (`persona` plus an optional `node_id`, which defaults to the persona name). `predecessor`/`successor` name node IDs.
 */
export interface RequestedAgent {
	kind?: string;
	command?: string;
	args?: string[];
	working_directory?: string;
	decision?: RequestedDecision;
	/** Factory-managed runs only: lets this node ask a human for direction among these plan choices. */
	intervention?: InterventionPolicy;
	name?: string;
	persona?: string;
	node_id?: string;
	sub_task?: string;
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
 * A validated assignment: its unique node ID, the persona it runs (for agent nodes), its kind, its inbound edges (source node IDs), and
 * the resolved dependency policy (`require_success` by default for the node form, `allow_partial` for the legacy form).
 */
export interface PlannedNode {
	kind?: NodeKind;
	command?: string;
	args?: string[];
	working_directory?: string;
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
	intervention?: InterventionPolicy;
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
	kind?: NodeKind;
	command?: string;
	args?: string[];
	working_directory?: string;
	command_evidence?: CommandEvidence;
	node_id: string;
	persona_name: string;
	attempt_id?: string;
	attempt_limit?: number;
	last_verdict?: string;
	parked?: boolean;
	finalized?: boolean;
	finalized_by?: string;
	unreviewed_attempts?: Array<{ attempt_id: string; state: ExecutionState; summary: string; result_path: string }>;
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
	/** Handoff for a single inbound edge. Joins use handoffs_in instead. */
	handoff?: HandoffView;
	/** Handoff for a single forward edge. Fan-out and feedback use handoffs_out. */
	handoff_out?: HandoffView;
	/** Graph forward handoffs and decision feedback handoffs, keyed by destination instance_id. */
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
	wait_reason?: "human" | "upstream_human" | "dependency";
	/** Running duration since the node was admitted, excluding human waits. */
	elapsed_ms?: number;
	task_timeout_ms?: number;
	deadline_exceeded?: boolean;
	/** Durable cancellation requested while in-flight work is still settling. */
	cancelling?: boolean;
	/** The node reads as cancelled only because a cancel record exists and the worker looks idle or gone; no worker disposition or claim proves it stopped. */
	cancel_inferred?: boolean;
	/** Liveness of the worker process from its own ready record, read even when its pane is closed: alive, positively exited, or unknown (no readable ready record). */
	process_state?: "alive" | "exited" | "unknown";
	/** The last readable heartbeat said "working" and was not stale. A positive liveness fact, kept apart from pane state. */
	recent_working_heartbeat?: boolean;
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
/** Read-only report of a factory-managed run. `complete` is true only when every node's outcome is recorded and nothing is pending or in error. */
export interface ReadOnlyReport {
	read_only: true;
	complete: boolean;
	/** Why the report is incomplete or uncertain: pending nodes, delivery or worker errors, missing results, a run in error. Empty when complete. */
	issues: string[];
	run_status: BootstrapManifest["status"];
	phase: string;
	/** The run's own outcome (from every node), never recomputed from the entries that have results. */
	outcome: RunOutcome;
	agents: AgentState[];
	results: ReportEntry[];
	/** Nodes with neither a recorded result nor a not-executed record. */
	unreported: Array<{ node_id: string; agent_name: string; execution: string; reason?: string }>;
	/** Report-only per-node attempt and rollback counts derived from upstream-index.json. */
	node_counts?: NodeAttemptCount[];
	manifest: BootstrapManifest;
}
export interface RunStatus { manifest: BootstrapManifest; results: BootstrapResult[]; pending: string[]; delivery_errors: string[]; worker_errors: string[]; agents: AgentState[]; outcome: RunOutcome; cleanup_wait_reason?: string }
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
		kind?: NodeKind;
		command?: string;
		args?: string[];
		working_directory?: string;
		node_id: string;
		attempt_id: string;
		instance_id: string;
		persona_name?: string;
		persona_file?: string;
		persona_source?: string;
		model?: string;
		thinking?: string;
		tools?: string[];
		extensions?: string[];
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

const AGENT_ONLY_NODE_SETTINGS = ["persona", "name", "model", "thinking", "skills", "allowed_skills", "tools", "extensions", "intervention", "decision"] as const;
const COMMAND_ONLY_NODE_SETTINGS = ["command", "args", "working_directory"] as const;

/** Validate assignments and normalize the legacy `name` form into nodes. Chain order and links are derived here. */
export function normalizeAgents(topology: "chain" | "team" | "graph", requested: RequestedAgent[], projectCwd?: string): PlannedNode[] {
	if (!Array.isArray(requested) || requested.length < 1 || requested.length > 32) throw new Error("Bootstrap requires between 1 and 32 agents");
	if (topology === "graph" && requested.some(agent => agent.name !== undefined && agent.kind !== "command")) {
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
		const raw = agent as unknown as Record<string, unknown>;
		const rawKind = raw.kind;
		const candidateLabel = typeof raw.node_id === "string" && raw.node_id.trim() ? raw.node_id.trim()
			: typeof raw.persona === "string" && raw.persona.trim() ? raw.persona.trim()
			: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim()
			: `agent ${index + 1}`;
		if (rawKind !== undefined && rawKind !== "agent" && rawKind !== "command") {
			throw new Error(`Node ${candidateLabel}: unsupported kind ${JSON.stringify(rawKind)}; expected "agent" or "command"`);
		}
		const kind: NodeKind = rawKind === "command" ? "command" : "agent";
		let nodeId: string;
		let persona: string;
		let command: string | undefined;
		let args: string[] | undefined;
		let workingDirectory: string | undefined;
		let subTask: string;
		if (kind === "command") {
			if (agent.node_id === undefined) throw new Error(`Agent ${index + 1}: command node requires node_id`);
			nodeId = requiredString(agent.node_id, "node_id").trim();
			if (!NODE_ID_PATTERN.test(nodeId)) throw new Error(`Unsafe node ID: ${nodeId}`);
			if (seen.has(nodeId.toLowerCase())) throw new Error(`Duplicate node ID: ${nodeId}. Node IDs compare case-insensitively`);
			seen.add(nodeId.toLowerCase());
			for (const setting of AGENT_ONLY_NODE_SETTINGS) {
				if (raw[setting] !== undefined) {
					throw new Error(`Node ${nodeId}: command node cannot declare agent-only setting "${setting}"`);
				}
			}
			command = validateCommandString(raw.command, `command for ${nodeId}`);
			args = validateCommandArgs(raw.args, `args for ${nodeId}`);
			workingDirectory = projectCwd
				? resolveCommandWorkingDirectory(projectCwd, raw.working_directory, `working_directory for ${nodeId}`)
				: (raw.working_directory === undefined ? undefined : requiredString(raw.working_directory, `working_directory for ${nodeId}`));
			persona = nodeId;
			subTask = agent.sub_task === undefined
				? formatCommandDisplay(command, args)
				: requiredString(agent.sub_task, `sub_task for ${nodeId}`);
		} else {
			const legacy = agent.name !== undefined;
			if (legacy && (agent.persona !== undefined || agent.node_id !== undefined)) throw new Error(`Agent ${index + 1}: specify either name (legacy: it is both the persona and the node ID) or persona with an optional node_id, not both`);
			if (!legacy && agent.persona === undefined) throw new Error(`Agent ${index + 1}: a persona is required (or the legacy name)`);
			persona = requiredString(legacy ? agent.name : agent.persona, legacy ? "Agent name" : "persona").trim();
			if (!NODE_ID_PATTERN.test(persona)) throw new Error(`Unsafe ${legacy ? "agent" : "persona"} name: ${persona}`);
			nodeId = agent.node_id === undefined ? persona : requiredString(agent.node_id, "node_id").trim();
			if (!NODE_ID_PATTERN.test(nodeId)) throw new Error(`Unsafe node ID: ${nodeId}`);
			// Node IDs identify assignments in tools, results and cleanup; persona names may repeat freely.
			if (seen.has(nodeId.toLowerCase())) throw new Error(`Duplicate node ID: ${nodeId}. Give assignments that share a persona distinct node_id values (node IDs compare case-insensitively)`);
			seen.add(nodeId.toLowerCase());
			for (const setting of COMMAND_ONLY_NODE_SETTINGS) {
				if (raw[setting] !== undefined) {
					throw new Error(`Node ${nodeId}: agent node cannot declare command-only setting "${setting}"`);
				}
			}
			subTask = requiredString(agent.sub_task, `sub_task for ${nodeId}`);
		}
		const role = optionalString(agent.role, `role for ${nodeId}`);
		const ownership = optionalStringList(agent.ownership, `ownership for ${nodeId}`);
		const rawReadPaths = optionalStringList(agent.read_paths, `read_paths for ${nodeId}`);
		const rawWritePaths = optionalStringList(agent.write_paths, `write_paths for ${nodeId}`);
		const read_paths = rawReadPaths ? (projectCwd ? normalizeOwnershipPaths(projectCwd, rawReadPaths, `read_paths for ${nodeId}`) : rawReadPaths) : undefined;
		const write_paths = rawWritePaths ? (projectCwd ? normalizeOwnershipPaths(projectCwd, rawWritePaths, `write_paths for ${nodeId}`) : rawWritePaths) : undefined;
		const acceptance_criteria = optionalStringList(agent.acceptance_criteria, `acceptance_criteria for ${nodeId}`, 32);
		const constraints = optionalStringList(agent.constraints, `constraints for ${nodeId}`, 32);
		const output_contract = agent.output_contract !== undefined ? validateOutputContractSyntax(agent.output_contract, nodeId) : undefined;
		if (output_contract?.required_checks?.some(check => check !== check.trim())) {
			throw new Error(`required_checks for ${nodeId} must not contain leading or trailing whitespace`);
		}
		if (output_contract) {
			const required = new Set([...(output_contract.required_fields ?? []), ...Object.entries(output_contract.properties ?? {}).filter(([, spec]) => spec.required).map(([key]) => key)]);
			for (const field of required) {
				const spec = output_contract.properties?.[field];
				if (!spec) continue;
				const maxRepresentableLength = spec.type === "array" ? 0xffff_ffff
					: spec.type === "string" ? bufferConstants.MAX_STRING_LENGTH : undefined;
				if (maxRepresentableLength !== undefined && spec.min_length !== undefined && spec.min_length > maxRepresentableLength) {
					throw new Error(`Node ${nodeId}: required output field "${field}" has min_length ${spec.min_length}, beyond the maximum representable ${spec.type} length ${maxRepresentableLength}`);
				}
				if (!spec.enum) continue;
				const satisfiable = spec.enum.some(value => {
					const matches = spec.type === "string" ? typeof value === "string"
						: spec.type === "number" ? typeof value === "number"
						: spec.type === "integer" ? typeof value === "number" && Number.isInteger(value)
						: spec.type === "boolean" ? typeof value === "boolean" : false;
					return matches && (!(typeof value === "string") || (spec.min_length === undefined || value.length >= spec.min_length)
						&& (spec.max_length === undefined || value.length <= spec.max_length));
				});
				if (!satisfiable) throw new Error(`Node ${nodeId}: required output field "${field}" has no value satisfying its output contract`);
			}
		}
		const required_checks = optionalStringList(agent.required_checks, `required_checks for ${nodeId}`, 32);
		if (required_checks?.some(check => check !== check.trim())) {
			throw new Error(`required_checks for ${nodeId} must not contain leading or trailing whitespace`);
		}
		const intervention = agent.intervention !== undefined ? validateInterventionPolicy(agent.intervention, nodeId) : undefined;
		const task_timeout_ms = optionalTimeoutMs(agent.task_timeout_ms, `task_timeout_ms for ${nodeId}`);
		const dependency_wait_timeout_ms = optionalTimeoutMs(agent.dependency_wait_timeout_ms, `dependency_wait_timeout_ms for ${nodeId}`);
		return {
			...(kind === "command" ? { kind: "command" as const, command, args, ...(workingDirectory !== undefined ? { working_directory: workingDirectory } : {}) } : {}),
			node_id: nodeId, persona, sub_task: subTask,
			...(role !== undefined ? { role } : {}),
			...(ownership !== undefined ? { ownership } : {}),
			...(read_paths !== undefined ? { read_paths } : {}),
			...(write_paths !== undefined ? { write_paths } : {}),
			...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			...(output_contract !== undefined ? { output_contract } : {}),
			...(required_checks !== undefined ? { required_checks } : {}),
			...(intervention !== undefined ? { intervention } : {}),
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

/** Select agents by stable identity: instance ID or node ID first, then a persona name only when it names exactly one agent node. */
export function selectAgents(entries: AgentLaunch[], selector: string): AgentLaunch[] {
	const wanted = selector.trim().toLowerCase();
	const byIdentity = entries.filter(entry => entry.instance_id === wanted || entry.node_id.toLowerCase() === wanted);
	if (byIdentity.length > 1) throw new Error(`Ambiguous agent selector "${selector}": it matches ${byIdentity.map(entry => `${entry.node_id} (${entry.instance_id})`).join(", ")}. Use an instance ID`);
	if (byIdentity.length === 1) return byIdentity;
	const byPersona = entries.filter(entry => entry.kind !== "command" && entry.persona_name.toLowerCase() === wanted);
	if (byPersona.length > 1) throw new Error(`Ambiguous agent selector "${selector}": persona ${byPersona[0].persona_name} is used by nodes ${byPersona.map(entry => `${entry.node_id} (${entry.instance_id})`).join(", ")}. Select by node ID or instance ID`);
	return byPersona;
}

/** The node a reported result belongs to, or undefined when it names none. A persona shared by several nodes needs a node_id. */
function resultNode(entries: AgentLaunch[], result: { node_id?: string; agent_name?: string }): AgentLaunch | undefined {
	if (result.node_id !== undefined) {
		const entry = entries.find(entry => entry.node_id.toLowerCase() === result.node_id!.trim().toLowerCase());
		if (entry && entry.kind !== "command" && result.agent_name !== undefined && result.agent_name.toLowerCase() !== entry.persona_name.toLowerCase()) throw new Error(`Result for node ${entry.node_id} names persona ${result.agent_name}, but that node runs ${entry.persona_name}`);
		return entry;
	}
	if (result.agent_name === undefined) throw new Error("Each result needs a node_id (or an agent_name that names exactly one node)");
	const matches = entries.filter(entry => entry.kind !== "command" && entry.persona_name.toLowerCase() === result.agent_name!.trim().toLowerCase());
	if (matches.length > 1) throw new Error(`Result names persona ${result.agent_name}, which is used by nodes ${matches.map(entry => entry.node_id).join(", ")}; supply node_id`);
	return matches[0];
}

function checkAllowedSkills(entry: AgentLaunch, ready: WorkerReady): void {
	if (!ready.unmatched_skills?.length) return;
	entry.error = unknownAllowedSkills(entry.persona_name, ready.unmatched_skills);
	throw new Error(`${nodeLabel(entry)}: ${entry.error}`);
}

/** True when `ancestor` names a strict parent directory of `descendant` on component boundaries. */
function isStrictAncestorPath(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return false;
	return ancestor === "/" ? descendant.startsWith("/") : descendant.startsWith(`${ancestor}/`);
}

/** Reject publication-ambiguous lexical artifact paths without normalizing away the caller's literal spelling. */
function assertPublishableRequiredArtifactPath(artifactPath: string): void {
	if (artifactPath.endsWith("/")) {
		throw new Error(`required artifact path "${artifactPath}" ends with "/", which denotes a directory, but required artifacts must be files`);
	}
	const segments = artifactPath.split("/");
	if (segments.includes("..")) {
		throw new Error(`required artifact path "${artifactPath}" contains a ".." traversal segment, which is not allowed in published required_artifact_paths`);
	}
	if (segments[segments.length - 1] === ".") {
		throw new Error(`required artifact path "${artifactPath}" ends with ".", which denotes a directory, but required artifacts must be files`);
	}
}

/** A detach marker counts as suspected detached work unless the worker's own outcome was already on record when it detached. */
function detachedWithoutOutcome(sessionDir: string, agent: { instance_id: string }): boolean {
	const path = join(sessionDir, `${agent.instance_id}.detached.json`);
	if (!existsSync(path)) return false;
	try { return readJson<{ outcome_recorded?: unknown }>(path).outcome_recorded !== true; } catch { return true; }
}

const instanceForNode = (nodeId: string, index: number) => `a${index + 1}-${nodeId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;

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

	getEnvironment(): { env: NodeJS.ProcessEnv; home: string } {
		return { env: this.env, home: this.home };
	}

	defaultCoordinationPath(): string {
		const dir = this.env.PI_FACTORY_COORDINATION_DIR ?? join(this.home, ".pi", "agent");
		return join(dir, "factory-coordination.sqlite");
	}

	private readCoordManagedRun(coordPath: string, query: { taskId?: string; requestIdDigest?: string }): { found: boolean; corrupt?: string } {
		const anchorPath = coordAnchorPath(coordPath);
		let db: DatabaseSync | undefined;
		try {
			assertNoSymlinkPath(coordPath);
			if (!existsSync(coordPath)) {
				if (!existsSync(anchorPath)) return { found: false };
				assertNoSymlinkPath(anchorPath);
				const anchor = parseCoordAnchor(readJson<unknown>(anchorPath));
				if (anchor.state === "committed") {
					return { found: false, corrupt: "Factory coordination database missing despite continuity anchor" };
				}
				return { found: false };
			}
			db = new DatabaseSync(coordPath);
			db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version === 0) {
				if (existsSync(anchorPath)) {
					assertNoSymlinkPath(anchorPath);
					const anchor = parseCoordAnchor(readJson<unknown>(anchorPath));
					if (anchor.state === "committed") {
						return { found: false, corrupt: "Factory coordination database reset despite continuity anchor" };
					}
				}
				return { found: false };
			}
			if (version !== 1 && version !== 2) return { found: false, corrupt: `Unsupported factory coordination version ${version}` };
			const hasMeta = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'coord_meta'").get());
			const hasManaged = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'managed_runs'").get());
			if (!hasMeta || !hasManaged) return { found: false, corrupt: "Factory coordination storage missing required tables" };
			if (!existsSync(anchorPath)) return { found: false, corrupt: "Factory coordination continuity anchor is missing" };
			assertNoSymlinkPath(anchorPath);
			const anchor = parseCoordAnchor(readJson<unknown>(anchorPath));
			const meta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord_meta WHERE id = 1").get() as
				| { id: number; anchor_id: string; created_at: string; record_digest: string }
				| undefined;
			if (!meta || coordMetaRecordDigest(meta.id, meta.anchor_id, meta.created_at) !== meta.record_digest || meta.anchor_id !== anchor.anchor_id) {
				return { found: false, corrupt: "Factory coordination continuity anchor mismatch" };
			}
			if (query.taskId) {
				const row = db.prepare("SELECT task_id FROM managed_runs WHERE task_id = ?").get(query.taskId);
				if (row) return { found: true };
			}
			if (query.requestIdDigest) {
				const row = db.prepare("SELECT task_id FROM managed_runs WHERE request_id_digest = ?").get(query.requestIdDigest);
				if (row) return { found: true };
			}
			return { found: false };
		} catch (error) {
			return { found: false, corrupt: errorMessage(error) };
		} finally {
			if (db) {
				try { db.close(); } catch { /* ignore cleanup error */ }
			}
		}
	}

	/** Raw, read-only evidence for factory non-release policy; status observations are not proof. */
	validateFactoryNonReleaseEvidence(taskId: string, expectedMeta: FactoryManagedInfo): void {
		const meta = parseNormalizedFactoryManagedInfo(expectedMeta, "expected factory non-release identity");
		assertTaskId(taskId);
		if (!isFactoryTaskId(taskId)) throw new Error("Invalid factory task identity");
		const sessionDir = join(meta.canonical_checkout, ".pi", "agent-sessions", taskId);
		if (pathEntryExists(join(sessionDir, "release.json"))) throw new Error("Contradictory release.json in non-release evidence");
		const indexRoot = readFactoryRunIndex(taskId, meta);
		const requestPath = join(indexRoot, `request-${createHash("sha256").update(meta.request_id).digest("hex")}.json`);
		const request = readRegularJsonNoSymlink<Record<string, unknown>>(requestPath, "factory request reservation");
		if (request.task_id !== taskId || typeof request.fingerprint !== "string" || !request.fingerprint.trim()) throw new Error("Factory request reservation identity mismatch");
		const requestMismatch = metadataMismatch(meta, parseNormalizedFactoryManagedInfo(request.factory_managed, "factory request reservation"), "factory request reservation");
		if (requestMismatch) throw new Error(requestMismatch);
		const indexed = readAndValidateManagedManifest({ manifestPath: join(indexRoot, `${taskId}.json`), taskId, expectedSessionDir: sessionDir, expectedMeta: meta, sourceLabel: "indexed manifest" });
		const local = readAndValidateManagedManifest({ manifestPath: join(sessionDir, "manifest.json"), taskId, expectedSessionDir: sessionDir, expectedMeta: meta, expectedToken: indexed.token, sourceLabel: "run manifest.json" });
		for (const [label, manifest] of [["indexed manifest", indexed], ["run manifest.json", local]] as const) {
			if (manifest.status === "applied" || manifest.phase === "released") throw new Error(`${label} explicitly claims release; contradictory non-release evidence`);
		}
		const sidecar = readRegularJsonNoSymlink<unknown>(factoryRunPath(sessionDir), "factory-run.json");
		const mismatch = metadataMismatch(meta, parseNormalizedFactoryManagedInfo(sidecar, "factory-run.json"), "factory-run.json");
		if (mismatch) throw new Error(mismatch);
	}

	private assertNotFactoryRequestId(requestId: string): void {
		if (isFactoryRequestId(requestId)) {
			throw new Error(`Refusing direct bootstrap_generate of factory-managed request_id "${requestId}"`);
		}
		const requestDigest = createHash("sha256").update(requestId).digest("hex");
		const requestPath = join(this.store.indexRoot, `request-${requestDigest}.json`);
		if (existsSync(requestPath)) {
			let existing: { task_id?: unknown; factory_managed?: unknown } | undefined;
			try { existing = readJson<{ task_id?: unknown; factory_managed?: unknown }>(requestPath); }
			catch { throw new Error("Unreadable request reservation record"); }
			if (existing?.factory_managed !== undefined || (typeof existing?.task_id === "string" && this.isFactoryManagedRun(existing.task_id))) {
				throw new Error(`Refusing direct bootstrap_generate replay of factory-managed request_id "${requestId}"`);
			}
		}
		const coordCheck = this.readCoordManagedRun(this.defaultCoordinationPath(), { requestIdDigest: requestDigest });
		if (coordCheck.found) {
			throw new Error(`Refusing direct bootstrap_generate replay of factory-managed request_id "${requestId}" across state roots`);
		}
	}

	isFactoryManagedRun(taskId: string, cwd?: string, loadedManifest?: BootstrapManifest): boolean {
		if (isFactoryTaskId(taskId)) return true;
		let manifest = loadedManifest;
		if (!manifest) {
			try { manifest = this.store.load(taskId, cwd, true); } catch { /* inspect sidecars directly */ }
		}
		if (manifest?.factory_managed !== undefined) return true;
		const candidates: string[] = [
			join(this.store.indexRoot, `${taskId}.json`),
			this.store.factoryRunIndexPath(taskId),
		];
		const sessionDir = manifest?.session_dir ?? (cwd ? join(resolve(cwd), ".pi", "agent-sessions", taskId) : undefined);
		if (sessionDir) {
			candidates.push(join(sessionDir, "manifest.json"), factoryRunPath(sessionDir));
		}
		const coordPaths = new Set<string>([this.defaultCoordinationPath()]);
		for (const candidate of candidates) {
			if (!existsSync(candidate)) continue;
			const isFactorySidecar = candidate.endsWith("factory-run.json") || candidate.includes(`${sep}factory-runs${sep}`);
			if (isFactorySidecar) return true;
			try {
				const raw = readJson<Record<string, unknown>>(candidate);
				if (raw?.factory_managed !== undefined) return true;
			} catch {
				// Ignore unreadable non-sidecar manifest candidates here so remaining candidates/coord DB are still checked.
			}
		}
		for (const coordPath of coordPaths) {
			if (this.readCoordManagedRun(coordPath, { taskId }).found) return true;
		}
		return false;
	}

	private assertDirectRunMutationAllowed(taskId: string, action: string, cwd?: string, loadedManifest?: BootstrapManifest): void {
		if (this.isFactoryManagedRun(taskId, cwd, loadedManifest)) {
			throw new Error(`Refusing direct ${action} on factory-managed run "${taskId}"; factory-managed runs cannot bypass factory authority`);
		}
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

	/** Validate required output paths with strict publication rules or standalone compatibility rules. */
	private validateRequiredArtifactPaths(
		nodes: PlannedNode[],
		cwd: string,
		mode: "standalone" | "publication",
	): void {
		const publication = mode === "publication";
		const realCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
		const directoryOnlyPaths = new Set([
			resolve(cwd),
			resolve(cwd, ".pi"),
			resolve(cwd, ".pi", "agent-sessions"),
			realCwd,
			resolve(realCwd, ".pi"),
			resolve(realCwd, ".pi", "agent-sessions"),
		]);
		for (const node of nodes) {
			const seenResolved: Array<{ artifactPath: string; resolved: string; traversedDirs: ReadonlySet<string> }> = [];
			for (const artifactPath of node.output_contract?.required_artifact_paths ?? []) {
				try {
					if (!publication) {
						const resolved = resolveStandaloneRequiredArtifactPath(cwd, cwd, artifactPath, directoryOnlyPaths);
						if (directoryOnlyPaths.has(resolved)) {
							throw new Error(`required artifact path "${artifactPath}" is a directory, but required artifacts must be files`);
						}
						continue;
					}
					assertPublishableRequiredArtifactPath(artifactPath);
					const { path: resolved, traversedDirs } = resolvePublishableRequiredArtifactPath(cwd, artifactPath);
					if (directoryOnlyPaths.has(resolved) || (existsSync(resolved) && statSync(resolved).isDirectory())) {
						throw new Error(`required artifact path "${artifactPath}" is a directory, but required artifacts must be files`);
					}
					if (traversedDirs.has(resolved)) {
						throw new Error(`conflicting required artifact path "${artifactPath}" cannot resolve to a regular file because it already traversed "${resolved}" as a directory`);
					}
					const descendantConflict = seenResolved.find(prior => isStrictAncestorPath(prior.resolved, resolved) || isStrictAncestorPath(resolved, prior.resolved));
					if (descendantConflict) {
						throw new Error(`conflicting required artifact paths "${descendantConflict.artifactPath}" and "${artifactPath}" cannot both be regular files`);
					}
					const traversalConflict = seenResolved.find(prior => traversedDirs.has(prior.resolved) || prior.traversedDirs.has(resolved));
					if (traversalConflict) {
						throw new Error(`conflicting required artifact paths "${traversalConflict.artifactPath}" and "${artifactPath}" conflict between a required file and a traversed directory`);
					}
					seenResolved.push({ artifactPath, resolved, traversedDirs });
				} catch (error) { throw new Error(`Node ${node.node_id}: required_artifact_paths: ${errorMessage(error)}`); }
			}
		}
	}

	/** Check write access only when creating a new run; request-ID replay is read/reconciliation-only. */
	private assertManagedSessionParent(cwd: string): void {
		let deepestExisting = cwd;
		for (const managedPath of [join(cwd, ".pi"), join(cwd, ".pi", "agent-sessions")]) {
			try {
				const info = lstatSync(managedPath);
				if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Managed session path is not a directory: ${managedPath}`);
				deepestExisting = managedPath;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try { accessSync(deepestExisting, constants.W_OK | constants.X_OK); }
		catch (error) { throw new Error(`Managed session path parent is not writable and traversable: ${deepestExisting}: ${errorMessage(error)}`); }
	}

	/** Validate a request and resolve everything a launch needs, without touching Herdr or the filesystem state. */
	private prepare(
		request: GenerateRequest,
		model?: { provider: string; id: string },
		checkManagedSessionParent = true,
		artifactValidation: "standalone" | "publication" | "defer" = "standalone",
	) {
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
		let cwd: string;
		try { cwd = realpathSync(request.project_cwd); }
		catch (error) { throw new Error(`project_cwd: ${errorMessage(error)}`); }
		if (!statSync(cwd).isDirectory()) throw new Error("project_cwd must be a directory");
		if (checkManagedSessionParent) this.assertManagedSessionParent(cwd);
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
		if (artifactValidation !== "defer") this.validateRequiredArtifactPaths(nodes, cwd, artifactValidation);
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
		for (const node of nodes) {
			if (node.intervention?.choices.some(choice => choice.route) && !decisionPlan?.decisions.has(node.node_id)) {
				throw new Error(`Node ${node.node_id}: only an intervention-enabled decision node may offer routing choices`);
			}
		}
		const hasAgentNode = nodes.some(node => node.kind !== "command");
		const available = hasAgentNode ? scanAgents(cwd, agentDir) : [];
		const mapped = nodes.map(node => {
			if (node.kind === "command") {
				return {
					node,
					def: { name: node.node_id, description: "", tools: "", systemPrompt: "", file: "", source: undefined, allowedSkills: undefined, extensions: undefined },
					extensions: [] as string[],
					resolvedModel: { model: "(none)", thinking: undefined as string | undefined },
				};
			}
			const def = available.find(def => def.name.toLowerCase() === node.persona.toLowerCase());
			if (!def) throw new Error(`Node ${node.node_id}: Agent "${node.persona}" not found. Available: ${available.map(def => def.name).join(", ") || "none"}`);
			try {
				if (def.allowedSkills?.includes("none")) {
					throw new Error(`${def.file} ("skills"): An empty \`skills:\` field means no skills. A skill named "none" cannot be allowed.`);
				}
				// Project extensions win; a global persona also finds extensions beside its own agents directory.
				const extensions = resolveExtensionPaths(cwd, def.extensions ?? [], [join(dirname(dirname(def.file)), "extensions"), this.options.extensionDir])
					.map(path => realpathSync(path));
				return { node, def, extensions, resolvedModel: resolveModel(def, model, aliases) };
			} catch (error) { throw new Error(`Node ${node.node_id}: ${errorMessage(error)}`); }
		});
		const coms = this.comsExtension(cwd, request.coms_extension);
		const worker = realpathSync(join(this.options.extensionDir, "bootstrap", "worker.ts"));
		accessSync(worker, constants.R_OK);
		const piBinary = hasAgentNode ? executableOnPath("pi", this.env) : "";
		executableOnPath("herdr", this.env);
		// The worker instance is derived from the node (unique), never from the persona (which may repeat).
		const instances = mapped.map(({ node }, i) => instanceForNode(node.node_id, i));
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
		const allowedSkills = mapped.some(({ node, def }) => node.kind !== "command" && def.allowedSkills !== undefined)
			? mapped.map(({ node, def }) => node.kind === "command" ? null : (def.allowedSkills ?? null))
			: undefined;
		const thinking = mapped.map(({ node, resolvedModel }) => node.kind === "command" ? null : (resolvedModel.thinking ?? null));
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
		const commandNodes = nodes.some(node => node.kind === "command")
			? {
				command_nodes: nodes.map(node => node.kind === "command"
					? { node_id: node.node_id.toLowerCase(), command: node.command!, args: node.args ?? [], working_directory: node.working_directory ?? cwd }
					: null),
			}
			: {};
		const resolved = { ...canonical, ...commandNodes, ...(allowedSkills ? { allowed_skills: allowedSkills } : {}), ...cleanupOptions };
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
		const prepared = this.prepare(request, model, false, "standalone");
		const { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, collaborationMode, failurePolicy, nodes, mapped, coms, instances, inbound, outbound, attempts, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, ownershipSchedule, decisionPlan } = prepared;
		const showCleanup = request.cleanup !== undefined || request.cleanup_settle_ms !== undefined || request.topology === "graph";
		return {
			...(showCleanup ? { cleanup, cleanup_settle_ms: cleanupSettleMs } : {}),
			...(showCleanup || decisionPlan || nodes.some(node => node.kind === "command") ? { fingerprint: this.preparedFingerprint(request, model, prepared) } : {}),
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
				const identityFields = node.kind === "command"
					? {
						kind: "command" as const,
						command: node.command!,
						args: node.args ?? [],
						working_directory: node.working_directory ?? cwd,
					}
					: {
						persona_name: def.name,
						persona_file: def.file,
						persona_source: def.source,
						model: resolvedModel.model,
						...(resolvedModel.thinking !== undefined ? { thinking: resolvedModel.thinking } : {}),
						tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean),
						extensions: [...new Set(extensions)],
						...(def.allowedSkills !== undefined ? { allowed_skills: def.allowedSkills } : {}),
					};
				return {
					node_id: node.node_id, attempt_id: attempts[i], instance_id: instances[i],
					...identityFields,
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

	/** Resolve a version for publication, without generating run identities, writing state or contacting Herdr. */
	prepareDefinition(request: GenerateRequest, sessionModel?: { provider: string; id: string; thinkingLevel: string }) {
		const prepared = this.prepare(request, sessionModel, true, "publication");
		const { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, form, collaborationMode, failurePolicy, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, mapped, coms, decisionPlan } = prepared;
		this.validateFirstAttempts(prepared);
		return {
			topology: request.topology, request_form: form, workspace_strategy: WORKSPACE_STRATEGY,
			project_cwd: cwd, task: request.task, goal: goal ?? request.task, acceptance_criteria, constraints,
			collaboration_mode: collaborationMode, failure_policy: failurePolicy, coms_extension: coms,
			cleanup, cleanup_settle_ms: cleanupSettleMs, ready_timeout_ms: readyTimeout,
			task_timeout_ms: taskTimeout ?? null, dependency_wait_timeout_ms: dependencyWaitTimeout ?? DEFAULT_DEPENDENCY_WAIT_MS,
			liveness_timeout_ms: livenessTimeout ?? DEFAULT_LIVENESS_MS, cancel_grace_ms: cancelGrace ?? DEFAULT_CANCEL_GRACE_MS,
			max_total_attempts: decisionPlan?.max_total_attempts ?? mapped.length,
			max_total_attempts_source: decisionPlan?.max_total_attempts_source ?? "built-in",
			agents: mapped.map(({ node, def, extensions, resolvedModel }) => {
				if (node.kind === "command") {
					return { kind: "command" as const, node };
				}
				const tools = def.tools.split(",").map(tool => tool.trim()).filter(Boolean);
				if (!/^[^\s/:\0]+\/[^\s/\0]+(?:\/[^\s/\0]+)*$/.test(resolvedModel.model)) {
					throw new Error(`Node ${node.node_id}: model must resolve to a full provider/model ID (got ${JSON.stringify(resolvedModel.model)})`);
				}
				// These values will be individual POSIX launcher arguments, not shell source.
				if (def.allowedSkills?.some(skill => skill.includes("\0"))) throw new Error(`Node ${node.node_id}: skills cannot contain NUL characters`);
				const thinking = resolvedModel.thinking ?? (sessionModel && resolvedModel.model === `${sessionModel.provider}/${sessionModel.id}` ? sessionModel.thinkingLevel : null);
				if (!isThinkingLevel(thinking)) {
					throw new Error(`Node ${node.node_id}: model ${resolvedModel.model} has no valid resolved thinking level; declare a thinking level in the persona or model alias before publishing`);
				}
				return {
					node, decision: decisionPlan?.decisions.get(node.node_id), persona_name: def.name, persona_file: def.file,
					system_prompt: def.systemPrompt, model: resolvedModel.model,
					thinking,
					tools: tools.length ? { mode: "declared" as const, names: tools } : { mode: "inherit" as const },
					skills: def.allowedSkills === undefined ? { mode: "inherit" as const } : { mode: "declared" as const, names: def.allowedSkills },
					extensions: { mode: "inherit_with_additions" as const, declared: def.extensions ?? [], paths: [...new Set(extensions)] },
				};
			}),
		};
	}

	private validateFirstAttempts({ decisionPlan, nodes }: { decisionPlan?: DecisionPlan; nodes: PlannedNode[] }) {
		if (decisionPlan && decisionPlan.max_total_attempts < nodes.length) {
			throw new Error("max_total_attempts must cover the first attempt of every planned node");
		}
	}

	private preparedFingerprint(request: GenerateRequest, model: { provider: string; id: string } | undefined,
		{ cwd, nodes, readyTimeout, thinking, collaborationMode, failurePolicy, allowedSkills, decisionPlan }: ReturnType<BootstrapService["prepare"]>): string {
		return this.fingerprint(request, cwd, nodes, readyTimeout, thinking, model, true, collaborationMode, failurePolicy, true, allowedSkills, decisionPlan);
	}

	/** Validate a retained factory definition against live prerequisites and ceilings without re-resolving aliases, personas, or defaults. */
	prepareFromDefinition(
		definition: ReturnType<BootstrapService["prepareDefinition"]>,
		options: { checkHerdrEnv?: boolean } = {},
	) {
		if (process.platform === "win32") throw new Error("Bootstrap currently requires POSIX /bin/sh; Windows launching is not supported");
		if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
			throw new Error("Invalid retained factory definition");
		}
		if (definition.topology !== "chain" && definition.topology !== "team" && definition.topology !== "graph") {
			throw new Error("Invalid retained factory topology");
		}
		if (definition.workspace_strategy !== WORKSPACE_STRATEGY) {
			throw new Error(`Unsupported retained workspace_strategy ${JSON.stringify(definition.workspace_strategy)}`);
		}
		if (definition.cleanup !== "on_success" && definition.cleanup !== "manual") {
			throw new Error("Invalid retained cleanup policy");
		}
		const cleanupSettleMs = optionalTimeoutMs(definition.cleanup_settle_ms, "cleanup_settle_ms", 0, MAX_CLEANUP_SETTLE_MS) ?? DEFAULT_CLEANUP_SETTLE_MS;
		const readyTimeout = definition.ready_timeout_ms;
		if (!Number.isInteger(readyTimeout) || readyTimeout < 100 || readyTimeout > 300_000) {
			throw new Error("Invalid retained ready_timeout_ms");
		}
		const taskTimeout = definition.task_timeout_ms === null ? undefined : optionalTimeoutMs(definition.task_timeout_ms, "task_timeout_ms");
		const dependencyWaitTimeout = optionalTimeoutMs(definition.dependency_wait_timeout_ms, "dependency_wait_timeout_ms");
		const livenessTimeout = optionalTimeoutMs(definition.liveness_timeout_ms, "liveness_timeout_ms");
		const cancelGrace = optionalTimeoutMs(definition.cancel_grace_ms, "cancel_grace_ms", 0, 300_000);
		requiredString(definition.task, "task");
		const goal = optionalString(definition.goal, "goal");
		const acceptance_criteria = optionalStringList(definition.acceptance_criteria, "acceptance_criteria", 32);
		const constraints = optionalStringList(definition.constraints, "constraints", 32);
		const form = definition.request_form === "legacy" || definition.request_form === "nodes" ? definition.request_form : "nodes";
		const collaborationMode = definition.collaboration_mode;
		if (![...COLLABORATION_MODES, "legacy"].includes(collaborationMode)) {
			throw new Error(`Invalid retained collaboration_mode ${JSON.stringify(collaborationMode)}`);
		}
		const failurePolicy = definition.failure_policy;
		if (!(FAILURE_POLICIES as readonly string[]).includes(failurePolicy)) {
			throw new Error(`Invalid retained failure_policy ${JSON.stringify(failurePolicy)}`);
		}
		if (!isAbsolute(requiredString(definition.project_cwd, "project_cwd"))) {
			throw new Error("Retained project_cwd must be absolute");
		}
		let cwd: string;
		try { cwd = realpathSync(definition.project_cwd); }
		catch (error) { throw new Error(`project_cwd: ${errorMessage(error)}`); }
		if (cwd !== definition.project_cwd) {
			throw new Error(`Canonical checkout mismatch: retained ${definition.project_cwd} now resolves to ${cwd}`);
		}
		if (!statSync(cwd).isDirectory()) throw new Error("project_cwd must be a directory");
		this.assertManagedSessionParent(cwd);
		if (!Array.isArray(definition.agents) || definition.agents.length < 1 || definition.agents.length > 32) {
			throw new Error("Retained definition requires between 1 and 32 agents");
		}
		const nodes: PlannedNode[] = definition.agents.map(entry => {
			if (!entry?.node || typeof entry.node !== "object") throw new Error("Retained agent is missing node definition");
			return entry.node;
		});
		const seenNodes = new Set<string>();
		for (const node of nodes) {
			if (!NODE_ID_PATTERN.test(node.node_id) || !NODE_ID_PATTERN.test(node.persona)) {
				throw new Error(`Invalid retained node or persona ID: ${node.node_id}`);
			}
			if (seenNodes.has(node.node_id.toLowerCase())) throw new Error(`Duplicate retained node ID: ${node.node_id}`);
			seenNodes.add(node.node_id.toLowerCase());
			if (node.kind === "command") {
				validateCommandString(node.command, `retained command for ${node.node_id}`);
				validateCommandArgs(node.args, `retained args for ${node.node_id}`);
				node.working_directory = resolveCommandWorkingDirectory(cwd, node.working_directory ?? cwd, `retained working_directory for ${node.node_id}`);
			} else if (node.kind !== undefined && node.kind !== "agent") {
				throw new Error(`Invalid retained node kind for ${node.node_id}: ${JSON.stringify(node.kind)}`);
			}
			requiredString(node.sub_task, `sub_task for ${node.node_id}`);
			if (node.output_contract !== undefined) validateOutputContractSyntax(node.output_contract, node.node_id);
			if (node.intervention !== undefined) {
				if (node.kind === "command") throw new Error(`Node ${node.node_id}: retained command node cannot declare intervention`);
				validateInterventionPolicy(node.intervention, node.node_id);
			}
		}
		this.validateRequiredArtifactPaths(nodes, cwd, "publication");

		// Live configuration ceilings and external prerequisites must pass without re-resolving aliases, personas, or defaults.
		const agentDir = piAgentDir(this.env, this.home);
		const globalConfigPath = join(agentDir, "bootstrap.json");
		const projectConfigPath = join(cwd, ".pi", "bootstrap.json");
		const globalConfig = readBootstrapConfig(globalConfigPath);
		const projectConfig = readBootstrapConfig(projectConfigPath);
		const globalLimits = validateGraphLimits(globalConfigPath, globalConfig.graph);
		const projectLimits = validateGraphLimits(projectConfigPath, projectConfig.graph);
		const maxRevisionsCeiling = Math.min(projectLimits.ceilings.maxRevisions ?? Infinity, globalLimits.ceilings.maxRevisions ?? Infinity);
		const maxTotalAttemptsCeiling = Math.min(projectLimits.ceilings.maxTotalAttempts ?? Infinity, globalLimits.ceilings.maxTotalAttempts ?? Infinity);

		const decisions = new Map<string, PlannedDecision>();
		for (const entry of definition.agents) {
			if (!entry.decision) continue;
			if (entry.node.kind === "command") {
				throw new Error(`Node ${entry.node.node_id}: retained command node cannot declare decision`);
			}
			if (entry.decision.max_revisions > maxRevisionsCeiling) {
				throw new Error(
					`Retained max_revisions for ${entry.node.node_id} (${entry.decision.max_revisions}) exceeds live configured ceiling (${maxRevisionsCeiling})`,
				);
			}
			decisions.set(entry.node.node_id, entry.decision);
		}
		for (const node of nodes) {
			if (node.intervention?.choices.some(choice => choice.route) && !decisions.has(node.node_id)) {
				throw new Error(`Node ${node.node_id}: only an intervention-enabled decision node may offer routing choices`);
			}
		}
		let decisionPlan: DecisionPlan | undefined;
		if (decisions.size > 0) {
			const maxTotal = definition.max_total_attempts;
			if (!Number.isSafeInteger(maxTotal) || maxTotal < nodes.length) {
				throw new Error("Retained max_total_attempts must cover the first attempt of every planned node");
			}
			if (maxTotal > maxTotalAttemptsCeiling) {
				throw new Error(`Retained max_total_attempts (${maxTotal}) exceeds live configured ceiling (${maxTotalAttemptsCeiling})`);
			}
			decisionPlan = {
				decisions,
				max_total_attempts: maxTotal,
				max_total_attempts_source: definition.max_total_attempts_source ?? "built-in",
			};
		}

		const coms = requiredString(definition.coms_extension, "coms_extension");
		try {
			if (!isAbsolute(coms) || !statSync(coms).isFile()) throw new Error("not a file");
			accessSync(coms, constants.R_OK);
		} catch {
			throw new Error(`Required retained Coms extension not found or unreadable: ${coms}`);
		}
		const worker = realpathSync(join(this.options.extensionDir, "bootstrap", "worker.ts"));
		accessSync(worker, constants.R_OK);
		if (nodes.some(node => node.kind === "command")) {
			accessSync(realpathSync(join(this.options.extensionDir, "bootstrap", "command-runner.ts")), constants.R_OK);
		}
		const hasAgentNode = nodes.some(node => node.kind !== "command");
		const piBinary = hasAgentNode ? executableOnPath("pi", this.env) : "";
		executableOnPath("herdr", this.env);
		if (options.checkHerdrEnv) {
			if (this.env.HERDR_ENV !== "1") throw new Error("Bootstrap must run inside a Herdr-managed pane (HERDR_ENV=1)");
			requiredString(this.env.HERDR_PANE_ID, "HERDR_PANE_ID");
		}

		const instances = nodes.map((node, i) => instanceForNode(node.node_id, i));
		const instanceByNodeId = new Map(nodes.map((node, i) => [node.node_id, instances[i]]));
		const inbound = nodes.map(node => node.inbound_edges.map(sourceId => instanceByNodeId.get(sourceId)!));
		const outbound = nodes.map(node => plannedOutboundEdges(nodes, node.node_id).map(destId => instanceByNodeId.get(destId)!));
		const attempts = instances.map(instance => `${instance}.1`);
		const ownershipSchedule = computeOwnershipSchedule(nodes.map((node, i) => ({
			node_id: node.node_id,
			instance_id: instances[i],
			read_paths: node.read_paths,
			write_paths: node.write_paths,
		})));

		const mapped = definition.agents.map(entry => {
			if (entry.node.kind === "command" || (entry as { kind?: string }).kind === "command") {
				const agentRec = entry as unknown as Record<string, unknown>;
				for (const forbidden of ["model", "thinking", "tools", "skills", "extensions", "system_prompt"] as const) {
					if (agentRec[forbidden] !== undefined) {
						throw new Error(`Node ${entry.node.node_id}: retained command node cannot carry ${forbidden}`);
					}
				}
				return {
					node: entry.node,
					def: { name: entry.node.node_id, description: "", tools: "", systemPrompt: "", file: "", allowedSkills: undefined as string[] | undefined },
					extensions: [] as string[],
					resolvedModel: { model: "(none)", thinking: undefined as string | undefined },
				};
			}
			const agentEntry = entry as Exclude<(typeof definition.agents)[number], { kind: "command" }>;
			if (typeof agentEntry.system_prompt !== "string") throw new Error(`Node ${agentEntry.node.node_id}: missing retained system_prompt`);
			if (!/^[^\s/:\0]+\/[^\s/\0]+(?:\/[^\s/\0]+)*$/.test(agentEntry.model)) {
				throw new Error(`Node ${agentEntry.node.node_id}: invalid retained model ${JSON.stringify(agentEntry.model)}`);
			}
			if (!isThinkingLevel(agentEntry.thinking)) {
				throw new Error(`Node ${agentEntry.node.node_id}: invalid retained thinking level ${JSON.stringify(agentEntry.thinking)}`);
			}
			const toolsList = agentEntry.tools.mode === "declared" ? agentEntry.tools.names : [];
			const allowedSkills = agentEntry.skills.mode === "declared" ? agentEntry.skills.names : undefined;
			if (allowedSkills?.some(skill => skill.includes("\0") || skill === "none")) {
				throw new Error(`Node ${agentEntry.node.node_id}: invalid retained allowed skills`);
			}
			const extensionPaths = agentEntry.extensions?.paths ?? [];
			for (const extPath of extensionPaths) {
				try {
					if (!isAbsolute(extPath) || !statSync(extPath).isFile()) throw new Error("not a file");
					accessSync(extPath, constants.R_OK);
				} catch {
					throw new Error(`Node ${agentEntry.node.node_id}: required retained extension not found or unreadable: ${extPath}`);
				}
			}
			return {
				node: agentEntry.node,
				def: {
					name: agentEntry.persona_name,
					description: "",
					tools: toolsList.join(","),
					systemPrompt: agentEntry.system_prompt,
					file: agentEntry.persona_file,
					allowedSkills,
				},
				extensions: extensionPaths,
				resolvedModel: { model: agentEntry.model, thinking: agentEntry.thinking },
			};
		});
		const allowedSkills = mapped.some(({ node, def }) => node.kind !== "command" && def.allowedSkills !== undefined)
			? mapped.map(({ node, def }) => node.kind === "command" ? null : (def.allowedSkills ?? null))
			: undefined;
		const thinking = mapped.map(({ node, resolvedModel }) => node.kind === "command" ? null : (resolvedModel.thinking ?? null));

		return {
			topology: definition.topology,
			task: definition.task,
			cwd,
			cleanup: definition.cleanup,
			cleanupSettleMs,
			goal,
			acceptance_criteria,
			constraints,
			form,
			collaborationMode,
			failurePolicy,
			nodes,
			readyTimeout,
			taskTimeout,
			dependencyWaitTimeout,
			livenessTimeout,
			cancelGrace,
			mapped,
			coms,
			worker,
			piBinary,
			instances,
			inbound,
			outbound,
			attempts,
			ownershipSchedule,
			decisionPlan,
			allowedSkills,
			thinking,
		};
	}

	async launchFromDefinition(options: {
		definition: ReturnType<BootstrapService["prepareDefinition"]>;
		submittedBrief: string;
		signal?: AbortSignal;
		update?: (manifest: BootstrapManifest) => void;
		reserveAttempt: (workspaceId: string, candidateTaskId: string) => {
			request_id: string;
			task_id: string;
			factory_managed: FactoryManagedInfo;
		};
		beforeRelease: (manifest: BootstrapManifest, markReleaseCommitted?: () => void) => Record<string, unknown>;
		onBeforeReleaseError?: (taskId: string, error: string) => void;
	}): Promise<BootstrapManifest> {
		checkAbort(options.signal);
		const prepared = this.prepareFromDefinition(options.definition, { checkHerdrEnv: true });
		const workspaceId = await this.workspace(options.signal);
		checkAbort(options.signal);
		const candidateTaskId = generateFactoryTaskId(prepared.task);
		const reserved = options.reserveAttempt(workspaceId, candidateTaskId);
		const fingerprint = createHash("sha256").update(canonicalJson({
			v: "factory-v1",
			factory_managed: reserved.factory_managed,
			submitted_brief: options.submittedBrief,
			definition: options.definition,
		})).digest("hex");
		try {
			const manifest = await this.executePreparedLaunch({
				prepared,
				fingerprint,
				samePlan: existing => existing.fingerprint === fingerprint,
				requestId: reserved.request_id,
				taskId: reserved.task_id,
				workspaceId,
				factoryManaged: reserved.factory_managed,
				submittedBrief: options.submittedBrief,
				durableWrites: true,
				beforeRelease: options.beforeRelease,
				signal: options.signal,
				update: options.update,
			});
			if (manifest.status === "error") {
				options.onBeforeReleaseError?.(reserved.task_id, manifest.error ?? "Factory launch failed before release");
			}
			return manifest;
		} catch (error) {
			options.onBeforeReleaseError?.(reserved.task_id, errorMessage(error));
			throw error;
		}
	}

	async generate(request: GenerateRequest, model?: { provider: string; id: string }, signal?: AbortSignal, update?: (manifest: BootstrapManifest) => void): Promise<BootstrapManifest> {
		checkAbort(signal);
		if (request.request_id !== undefined) {
			requiredString(request.request_id, "request_id");
			this.assertNotFactoryRequestId(request.request_id);
		}
		const prepared = this.prepare(request, model, false, "defer");
		const { cwd, cleanup, cleanupSettleMs, nodes, readyTimeout, collaborationMode, failurePolicy, decisionPlan, allowedSkills, thinking } = prepared;
		const reviewPlan: ReviewPlan | undefined = decisionPlan && {
			max_total_attempts: decisionPlan.max_total_attempts,
			max_total_attempts_source: decisionPlan.max_total_attempts_source,
			node_count: nodes.length,
			loops: [...decisionPlan.decisions].map(([id, decision]) => ({
				...decision,
				reviewer: prepared.instances[nodes.findIndex(node => node.node_id === id)],
				target: prepared.instances[nodes.findIndex(node => node.node_id === decision.on_reject)],
				members: decision.loop_body.map(memberId => prepared.instances[nodes.findIndex(node => node.node_id === memberId)]),
			})),
		};
		this.validateFirstAttempts(prepared);
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
		return this.executePreparedLaunch({
			prepared: { ...prepared, topology: request.topology, task: request.task },
			fingerprint,
			samePlan,
			requestId: request.request_id,
			artifactValidation: "standalone",
			hasExplicitCleanupPolicy: request.topology === "graph" || request.cleanup !== undefined || request.cleanup_settle_ms !== undefined,
			signal,
			update,
		});
	}

	private async executePreparedLaunch(params: {
		prepared: ReturnType<BootstrapService["prepare"]> & { topology: "chain" | "team" | "graph"; task: string };
		fingerprint: string;
		samePlan: (existing: { fingerprint: string; task_id: string }) => boolean;
		requestId?: string;
		taskId?: string;
		workspaceId?: string;
		factoryManaged?: FactoryManagedInfo;
		submittedBrief?: string;
		durableWrites?: boolean;
		hasExplicitCleanupPolicy?: boolean;
		artifactValidation?: "standalone" | "publication";
		beforeRelease?: (manifest: BootstrapManifest, markReleaseCommitted?: () => void) => Record<string, unknown>;
		signal?: AbortSignal;
		update?: (manifest: BootstrapManifest) => void;
	}): Promise<BootstrapManifest> {
		const { prepared, fingerprint, samePlan, signal, update } = params;
		const durable = !!params.durableWrites;
		const { cwd, cleanup, cleanupSettleMs, goal, acceptance_criteria, constraints, form, collaborationMode, failurePolicy, nodes, readyTimeout, taskTimeout, dependencyWaitTimeout, livenessTimeout, cancelGrace, mapped, coms, worker, piBinary, instances, inbound, outbound, attempts, ownershipSchedule, decisionPlan } = prepared;
		const instanceFor = (id: string) => instances[nodes.findIndex(node => node.node_id === id)];
		const reviewPlan: ReviewPlan | undefined = decisionPlan && {
			max_total_attempts: decisionPlan.max_total_attempts,
			max_total_attempts_source: decisionPlan.max_total_attempts_source,
			node_count: nodes.length,
			loops: [...decisionPlan.decisions].map(([id, decision]) => ({
				...decision, reviewer: instanceFor(id), target: instanceFor(decision.on_reject), members: decision.loop_body.map(instanceFor),
			})),
		};
		const requestKey = params.requestId ? createHash("sha256").update(requiredString(params.requestId, "request_id")).digest("hex") : randomUUID();
		return withRunLock(join(this.store.indexRoot, requestKey), async () => {
			const requestPath = join(this.store.indexRoot, `request-${requestKey}.json`);
			if (existsSync(requestPath)) {
				const existing = readJson<{ fingerprint: string; task_id: string; factory_managed?: unknown }>(requestPath);
				if (existing.factory_managed !== undefined || params.factoryManaged !== undefined || this.isFactoryManagedRun(existing.task_id, cwd)) {
					throw new Error(`Refusing direct replay of factory-managed request_id (run ${existing.task_id})`);
				}
				if (!samePlan(existing)) throw new Error("request_id was already used for a different bootstrap plan");
				// The original launcher may have died mid-launch: return a reconciled view, never a stale "launching".
				return withRunLock(join(this.store.indexRoot, existing.task_id), async () => this.reconcile(this.store.load(existing.task_id), true));
			}
			this.validateRequiredArtifactPaths(prepared.nodes, cwd, params.artifactValidation ?? "publication");
			this.assertManagedSessionParent(cwd);
			const workspaceId = params.workspaceId ?? await this.workspace(signal);
			checkAbort(signal);
			const taskId = params.taskId ?? generateTaskId(prepared.task);
			// Hold the run lock before the manifest exists, so nobody can mistake this launch for an interrupted one.
			return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const sessionDir = ensureSessionDir(cwd, taskId, durable);
			const dispatcher = this.dispatcher();
			const hasJoin = inbound.some(edges => edges.length > 1);
			const manifestVersion = reviewPlan
				? (prepared.topology === "graph" ? GRAPH_REVIEW_VERSION : REVIEW_VERSION)
				: prepared.topology === "graph" ? (hasJoin ? JOIN_GRAPH_VERSION : GRAPH_VERSION) : CURRENT_VERSION;
			const manifest: BootstrapManifest = {
				...(params.factoryManaged ? { factory_managed: params.factoryManaged } : {}),
				version: manifestVersion, ...(reviewPlan ? { review_plan: reviewPlan } : {}), request_form: form, collaboration_mode: collaborationMode, failure_policy: failurePolicy, workspace_strategy: WORKSPACE_STRATEGY,
				task_id: taskId, task: prepared.task, topology: prepared.topology,
				...(params.hasExplicitCleanupPolicy || params.factoryManaged || prepared.topology === "graph"
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
						...(node.kind === "command" ? { kind: "command" as const, command: node.command!, args: node.args ?? [], working_directory: node.working_directory ?? cwd } : {}),
						node_id: node.node_id, persona_name: def.name, attempt_id: attempts[i], instance_id: instances[i], expected_coms_name: instances[i], expected_model: resolvedModel.model, label: `${taskId}:${instances[i]}`,
						step: node.step, predecessor: inbound[i][0],
						successor: outbound[i][0],
						...(prepared.topology === "graph" ? { inbound_edges: inbound[i] } : {}),
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
			this.store.save(manifest, durable);
			if (params.factoryManaged) {
				const runMarker = { ...params.factoryManaged, task_id: taskId };
				atomicJson(factoryRunPath(sessionDir), runMarker, true);
				const indexRunMarker = this.store.factoryRunIndexPath(taskId);
				createDurableDirectoryPath(dirname(indexRunMarker));
				atomicJson(indexRunMarker, runMarker, true);
			}
			// Atomic, complete reservation: a concurrent process must not create a second fleet for the same key,
			// and a crash can never leave an empty or partial reservation behind.
			if (durable) createDurableDirectoryPath(this.store.indexRoot);
			else mkdirSync(this.store.indexRoot, { recursive: true, mode: 0o700 });
			const requestRecord = { fingerprint, task_id: taskId, ...(params.factoryManaged ? { factory_managed: params.factoryManaged } : {}) };
			if (!publishExclusive(requestPath, JSON.stringify(requestRecord), durable)) {
				if (params.factoryManaged) {
					throw new Error(`Factory request reservation ${params.requestId} already exists`);
				}
				// Nothing was launched for this losing plan: remove its files instead of leaving an orphan run behind.
				try { this.store.assertDirectory(manifest); rmSync(sessionDir, { recursive: true }); this.store.removeUnlaunchedIndex(taskId); }
				catch { manifest.status = "error"; manifest.error = "Concurrent request reservation won by another invocation"; try { this.store.save(manifest); } catch { /* best effort */ } }
				const existing = readJson<{ fingerprint: string; task_id: string; factory_managed?: unknown }>(requestPath);
				if (existing.factory_managed !== undefined || this.isFactoryManagedRun(existing.task_id, cwd)) {
					throw new Error(`Refusing direct replay of factory-managed request_id (run ${existing.task_id})`);
				}
				if (!samePlan(existing)) throw new Error("request_id was already used for a different bootstrap plan");
				return this.store.load(existing.task_id);
			}
			const fullRoster: RosterEntry[] = mapped.map(({ node, def }, i) => ({
				instance_id: instances[i],
				node_id: node.node_id,
				persona_name: def.name,
				...(node.kind === "command" ? { kind: "command" as const, command: node.command!, args: node.args ?? [], working_directory: node.working_directory ?? cwd } : {}),
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
			atomicJson(upstreamIndexPath(sessionDir), { version: 2, run_id: taskId, updated_at: new Date().toISOString(), entries: [] }, durable);
				const saveLaunchManifest = (): void => {
					if (params.factoryManaged) this.assertManagedLocalManifestIntact(manifest);
					this.store.save(manifest, durable);
				};
				let releaseWritten = false;
				let releaseCommitted = false;
				try {
					for (let i = 0; i < mapped.length; i++) {
						checkAbort(signal);
						const { node, def, extensions, resolvedModel } = mapped[i];
						const entry = manifest.pane_manifest[i];
						const waits = ownershipSchedule.waitsFor.get(entry.instance_id) ?? [];
						const config: WorkerConfig = {
							...(node.kind === "command" ? { kind: "command" as const, command: node.command!, args: node.args ?? [], working_directory: node.working_directory ?? cwd } : {}),
							...(params.factoryManaged ? { factory_managed: params.factoryManaged } : {}),
							...(params.factoryManaged && node.intervention ? { intervention: node.intervention } : {}),
							...(params.submittedBrief !== undefined ? { submitted_brief: params.submittedBrief } : {}),
							version: manifestVersion, ...(reviewPlan ? { review_plan: reviewPlan } : {}), task_id: taskId, token: manifest.token, session_dir: sessionDir, project_cwd: cwd,
							coms_dir: this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), coms_project: manifest.coms_project,
							instance_id: entry.instance_id, node_id: node.node_id, persona_name: def.name, attempt_id: entry.attempt_id,
							persona: def.systemPrompt, expected_model: entry.expected_model,
							tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), sub_task: node.sub_task,
							topology: prepared.topology, step: node.step, predecessor: entry.predecessor, successor: entry.successor,
							...(prepared.topology === "graph" ? { inbound_edges: inbound[i], outbound_edges: outbound[i] } : {}),
							dependency_policy: node.dependency_policy,
							...(node.join_policy !== undefined ? { join_policy: node.join_policy } : {}),
							collaboration_mode: collaborationMode,
							failure_policy: failurePolicy,
							// Chains and graphs hand results over durably: the source records an offer, the destination claims it before model work (handoff.ts).
							...(prepared.topology === "chain" || prepared.topology === "graph" ? { handoff_protocol: HANDOFF_PROTOCOL } : {}),
							startup_message: `bootstrap-start:${manifest.token}:${entry.instance_id}`, ready_timeout_ms: readyTimeout + nodes.length * 30_000 + 15_000,
							...(entry.task_timeout_ms !== undefined ? { task_timeout_ms: entry.task_timeout_ms } : {}),
							...(entry.dependency_wait_timeout_ms !== undefined ? { dependency_wait_timeout_ms: entry.dependency_wait_timeout_ms } : {}),
							...(livenessTimeout !== undefined ? { liveness_timeout_ms: livenessTimeout } : {}),
							...(cancelGrace !== undefined ? { cancel_grace_ms: cancelGrace } : {}),
							task: prepared.task,
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
								task: prepared.task,
								goal: goal ?? prepared.task,
								...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
								...(constraints !== undefined ? { constraints } : {}),
								...(params.submittedBrief !== undefined ? { submitted_brief: params.submittedBrief } : {}),
							},
							assignment: {
								...(node.kind === "command" ? { kind: "command" as const, command: node.command!, args: node.args ?? [], working_directory: node.working_directory ?? cwd } : {}),
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
						atomicJson(taskInputPath(sessionDir, attemptKey(reviewPlan, entry.instance_id)), inputRecord, durable);
						const configPath = join(sessionDir, `${entry.instance_id}.config.json`);
						atomicJson(configPath, config, durable);
						// Only the short launcher path crosses the user's shell/PTY. All arbitrary task text and command args stay in files.
						const launcher = join(sessionDir, `${entry.instance_id}.sh`);
						if (node.kind === "command") {
							const commandRunner = realpathSync(join(this.options.extensionDir, "bootstrap", "command-runner.ts"));
							accessSync(commandRunner, constants.R_OK);
							const runnerArgs = ["--experimental-strip-types", commandRunner, "--bootstrap-worker-config", configPath];
							atomicText(launcher, `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${[process.execPath, ...runnerArgs].map(shellQuote).join(" ")}\n`, durable);
						} else {
							const personaExtensions = [...new Set(extensions)].filter(ext => ext !== coms && ext !== worker);
							const args = ["-e", coms, ...personaExtensions.flatMap(ext => ["-e", ext]), "-e", worker,
								"--cname", entry.instance_id, "--purpose", `Bootstrap ${taskId}: ${nodeLabel(entry)}`, "--project", manifest.coms_project,
								"--model", entry.expected_model,
								...(resolvedModel.thinking !== undefined ? ["--thinking", resolvedModel.thinking] : []),
								"--bootstrap-worker-config", configPath,
								...(def.allowedSkills === undefined ? [] : ["--allowed-skills", def.allowedSkills.join(",") || "none"]),
								...workerStartupMessages(config.startup_message, def.allowedSkills !== undefined)];
							atomicText(launcher, `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${[piBinary, ...args].map(shellQuote).join(" ")}\n`, durable);
						}
						entry.status = "creating"; manifest.phase = `creating:${entry.instance_id}`; saveLaunchManifest(); update?.(manifest);
						try {
							const created = await this.json(["tab", "create", "--workspace", workspaceId, "--label", entry.label, "--cwd", cwd, "--no-focus",
								"--env", `PI_COMS_DIR=${config.coms_dir}`, "--env", "PI_COMS_TIMEOUT_MS=300000", "--env", `PI_COMS_MAX_HOPS=${Math.max(5, nodes.length + 2)}`], signal);
							// Preserve every known ID even if the rest of the response is malformed.
							if (typeof created.tab?.tab_id === "string") entry.tab_id = created.tab.tab_id;
							entry.pane_id = requiredString(created.root_pane?.pane_id, "Created root pane_id");
							entry.terminal_id = requiredString(created.root_pane?.terminal_id, "Created terminal_id");
							requiredString(entry.tab_id, "Created tab_id");
							entry.status = "tab_created"; saveLaunchManifest();
							await this.command(["pane", "run", entry.pane_id, launchCommand(cwd, launcher)], signal);
							entry.status = "launch_submitted"; saveLaunchManifest();
						} catch (error) { entry.error = errorMessage(error); throw error; }
					}
					manifest.phase = "waiting-ready"; saveLaunchManifest(); update?.(manifest);
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
							const modelOk = entry.kind === "command"
								? (ready.model === "(none)" && !ready.kept_skills?.length && !ready.unmatched_skills?.length)
								: (typeof ready.model === "string" && modelMatches(entry.expected_model, ready.model));
							if (ready.task_id !== taskId || ready.token !== manifest.token || ready.instance_id !== entry.instance_id || ready.name !== entry.expected_coms_name || !modelOk || !ready.session_id || !ready.endpoint || !Number.isInteger(ready.pid)) throw new Error(`Invalid readiness acknowledgement for ${nodeLabel(entry)}`);
							if (entry.kind !== "command") checkAllowedSkills(entry, ready);
							if (!processAlive(ready)) throw new Error(`${nodeLabel(entry)} exited after acknowledging readiness`);
							entry.status = "ready"; saveLaunchManifest(); update?.(manifest);
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
						const modelOk = entry.kind === "command"
							? (ready.model === "(none)" && !ready.kept_skills?.length && !ready.unmatched_skills?.length)
							: modelMatches(entry.expected_model, ready.model);
						if (ready.task_id !== taskId || ready.token !== manifest.token || !modelOk || ready.instance_id !== entry.instance_id) throw new Error(`Readiness changed before release for ${nodeLabel(entry)}`);
						if (entry.kind !== "command") checkAllowedSkills(entry, ready);
						if (!processAlive(ready)) throw new Error(`${nodeLabel(entry)} exited before work was released`);
						const registry = readJson<RegistryEntry>(join(this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), "projects", manifest.coms_project, "agents", `${entry.instance_id}.json`));
						if (registry.pid !== ready.pid || registry.session_id !== ready.session_id || registry.name !== entry.instance_id) throw new Error(`Coms identity changed before release for ${nodeLabel(entry)}`);
					}
					// No async gap between final authority/trust fence + SQLite release authorization and release.json publication.
					const releaseFactoryMeta = params.beforeRelease
						? params.beforeRelease(manifest, () => { releaseCommitted = true; })
						: undefined;
					const releasePath = join(sessionDir, "release.json");
					const releasePayload = {
						task_id: taskId,
						token: manifest.token,
						...(releaseFactoryMeta ? { factory_managed: releaseFactoryMeta } : {}),
					};
					if (params.factoryManaged || params.beforeRelease) {
						releaseCommitted = true;
						if (!publishExclusive(releasePath, JSON.stringify(releasePayload, null, 2) + "\n", durable)) {
							throw new Error(`Contradictory release.json already exists after release authorization commit for run "${taskId}"`);
						}
					} else {
						atomicJson(releasePath, releasePayload, durable);
					}
					releaseWritten = true;
					for (const entry of manifest.pane_manifest) entry.status = "released";
					manifest.status = "applied"; manifest.phase = "released"; saveLaunchManifest(); update?.(manifest);
				} catch (error) {
					const preservePersistedManifests = error instanceof ManagedManifestContradictionError;
					if (releaseWritten) {
						if (preservePersistedManifests) {
							manifest.status = "error";
							manifest.phase = "uncertain";
							manifest.error = errorMessage(error);
							return manifest;
						}
						// Children are already working; an abort marker now would be ignored and the run is not failed.
						for (const entry of manifest.pane_manifest) entry.status = "released";
						manifest.status = "applied"; manifest.phase = "released"; manifest.error = `Work was released, but recording that failed: ${errorMessage(error)}`;
						try { saveLaunchManifest(); } catch { /* the returned manifest is authoritative */ }
						return manifest;
					}
					if (releaseCommitted) {
						// SQLite release authorization committed or may have committed; a valid marker may already be linked.
						// Never write abort.json or falsely declare pre-release failure.
						manifest.status = "error";
						manifest.phase = "uncertain";
						manifest.error = errorMessage(error);
						if (!preservePersistedManifests) {
							try { saveLaunchManifest(); }
							catch (persistenceError) { manifest.error += `; recovery-state persistence failed: ${errorMessage(persistenceError)}`; }
						}
						return manifest;
					}
					const preReleaseCancelled = !!(signal?.aborted || existsSync(runCancelPath(sessionDir)) || manifest.pane_manifest.some(entry => existsSync(cancelPath(sessionDir, entry.instance_id))));
					manifest.status = "error"; manifest.phase = preReleaseCancelled ? "cancelled" : "failed"; manifest.error = errorMessage(error);
					// Unreleased children see this marker and shut down, instead of waiting forever.
					try {
						if (params.factoryManaged) {
							assertNoSymlinkPath(sessionDir);
							if (!lstatSync(sessionDir).isDirectory()) throw new Error("Session directory is not a directory");
						}
						atomicJson(join(sessionDir, "abort.json"), { task_id: taskId, token: manifest.token, error: manifest.error }, durable);
					} catch { /* index remains recovery source */ }
					if (preReleaseCancelled && existsSync(sessionDir)) {
						const nowIso = new Date(this.now()).toISOString();
						const graceMs = manifest.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS;
						try {
							this.persistPreReleaseCancel(manifest, manifest.error, "run", manifest.pane_manifest, nowIso, graceMs, true);
						} catch { /* best effort */ }
					}
					if (!preservePersistedManifests) {
						try { saveLaunchManifest(); }
						catch (persistenceError) { manifest.error += `; recovery-state persistence failed: ${errorMessage(persistenceError)}`; }
					}
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
		if (persist && this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest)) {
			throw new Error(`Refusing standalone reconciliation persistence on factory-managed run "${manifest.task_id}"`);
		}
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

	/**
	 * Read-only manifest observation shared by status, recover(inspect), list, and graph uses.
	 * Standalone runs keep legacy marker-only reconciliation; factory-managed runs verify durable
	 * factory/coordination SQLite proof and release.json without ever mutating state.
	 */
	private observeManifest(manifest: BootstrapManifest): BootstrapManifest {
		if (!this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest)) {
			return this.reconcile(manifest, false);
		}
		return this.observeManagedManifest(manifest);
	}

	/** The single read-only evidence check behind a factory-managed run's observed state and its verified version binding. */
	private managedReleaseCheck(manifest: BootstrapManifest): ReturnType<typeof inspectFactoryReleaseState> {
		return inspectFactoryReleaseState({
			taskId: manifest.task_id,
			token: manifest.token,
			sessionDir: manifest.session_dir,
			sessionDirRemoved: manifest.session_dir_removed,
			primaryMeta: manifest.factory_managed,
			indexRunPath: this.store.factoryRunIndexPath(manifest.task_id),
		});
	}

	/**
	 * The factory binding of a managed run that its own evidence verifies: run-local manifest, sidecar and index agree with the claimed identity and the
	 * durable attempt and input records record the same bound version. Read-only. The claimed manifest is never proof by itself, so `undefined` means the
	 * claimed factory, version and state database are unverified and must not be followed or presented as definitive.
	 */
	verifiedFactoryBinding(manifest: BootstrapManifest): { factory_id: string; bound_version: string; state_db_path: string } | undefined {
		if (manifest.factory_managed === undefined) return undefined;
		return this.managedReleaseCheck(manifest).verified_binding;
	}

	private observeManagedManifest(manifest: BootstrapManifest): BootstrapManifest {
		const observed: BootstrapManifest = {
			...manifest,
			pane_manifest: manifest.pane_manifest.map(entry => ({ ...entry })),
		};
		const activeLaunch = observed.status === "launching" && lockHeld(join(this.store.indexRoot, observed.task_id));
		const check = this.managedReleaseCheck(observed);
		if (observed.status === "launching") {
			if (activeLaunch) {
				const validActiveState = !observed.session_dir_removed && (
					check.kind === "held"
					|| check.kind === "released"
					|| (check.kind === "uncertain" && check.marker_publication_pending === true)
				);
				if (validActiveState) {
					return observed;
				}
				observed.status = "error";
				observed.phase = "uncertain";
				observed.error = `Factory release state is uncertain: ${
					observed.session_dir_removed
						? "Contradictory session_dir_removed flag during active factory launch"
						: (check.reason ?? "contradictory or incomplete durable evidence")
				} (inspect via /factory inspect)`;
				return observed;
			}
			observed.reconciled = true;
			if (check.kind === "released") {
				for (const entry of observed.pane_manifest) if (entry.status !== "closed") entry.status = "released";
				observed.status = "applied";
				observed.phase = "released";
				observed.error = "Launcher was interrupted after work was released; state reconciled from factory and release evidence";
			} else if (check.kind === "held" || check.kind === "historical_non_release") {
				observed.status = "error";
				observed.phase = "held";
				observed.error = check.attempt_state === "failed_before_release"
					? "Factory launch failed before release authorization; capacity holds remain active (inspect via /factory inspect)"
					: "Factory launch was interrupted before release authorization; capacity holds remain active (inspect via /factory inspect)";
			} else {
				observed.status = "error";
				observed.phase = "uncertain";
				observed.error = `Factory release state is uncertain: ${check.reason ?? "contradictory or incomplete durable evidence"} (inspect via /factory inspect)`;
			}
			return observed;
		}
		if (observed.status === "applied") {
			if (check.kind !== "released") {
				observed.status = "error";
				observed.phase = "uncertain";
				observed.error = `Factory release state is uncertain: ${check.reason ?? "durable factory release proof is inconsistent"} (inspect via /factory inspect)`;
			}
			return observed;
		}
		if (observed.status === "error") {
			if (check.kind === "held" || check.kind === "historical_non_release") {
				if (observed.phase === "interrupted") {
					observed.phase = "held";
					observed.error = "Factory launch was interrupted before release authorization; capacity holds remain active (inspect via /factory inspect)";
				}
				return observed;
			}
			observed.status = "error";
			observed.phase = "uncertain";
			observed.error = `Factory release state is uncertain: ${check.reason ?? "persisted error manifest contradicts durable factory release evidence"} (inspect via /factory inspect)`;
			return observed;
		}
		if (observed.status === "cleaned") {
			observed.status = "error";
			observed.phase = "uncertain";
			observed.error = `Factory release state is uncertain: invalid cleaned status on factory-managed run${check.reason ? ` (${check.reason})` : ""} (inspect via /factory inspect)`;
			return observed;
		}
		return observed;
	}

	/** Reports and status read the same attempt-scoped, identity-checked records. */
	private reviewAttempt(manifest: BootstrapManifest, entry: AgentLaunch, number: number, loop: ReviewLoop): ReportReviewHistory["attempts"][number] | undefined {
		const key = attemptKey(manifest.review_plan, entry.instance_id, number);
		const expected = { ...expectationFor(manifest, entry), attempt_id: key };
		const resultFile = resultPath(manifest.session_dir, key);
		if (existsSync(resultFile)) {
			let result: BootstrapResult;
			try { ({ result } = parseCompletion(readJson<unknown>(resultFile), expected)); }
			catch (error) { throw new Error(`${nodeLabel(entry)} attempt ${number}: ${errorMessage(error)}`); }
			const route = entry.instance_id === loop.reviewer ? reviewVerdict(loop, result) : undefined;
			const verdict = route && loop[route];
			return { number, state: executionFromResult(result.status).state, summary: result.summary, ...(verdict ? { verdict } : {}) };
		}
		const dispositionFile = dispositionPath(manifest.session_dir, key);
		if (existsSync(dispositionFile)) {
			try {
				const disposition = parseDisposition(readJson<unknown>(dispositionFile), expected);
				return { number, state: disposition.state, summary: disposition.reason };
			} catch (error) { throw new Error(`${nodeLabel(entry)} attempt ${number}: ${errorMessage(error)}`); }
		}
	}

	private assertManagedLocalManifestIntact(manifest: BootstrapManifest): void {
		if (!manifest.factory_managed) return;
		readAndValidateManagedManifest({
			manifestPath: join(manifest.session_dir, "manifest.json"),
			taskId: manifest.task_id,
			expectedToken: manifest.token,
			expectedSessionDir: manifest.session_dir,
			expectedMeta: manifest.factory_managed,
			sourceLabel: "run manifest.json",
		});
	}

	private assertSafeManagedFallbackManifest(taskId: string, cwd?: string): void {
		if (!cwd || existsSync(join(this.store.indexRoot, `${taskId}.json`))) return;
		const sessionDir = join(cwd, ".pi", "agent-sessions", taskId);
		const safeEntryExists = (p: string): boolean => {
			try { return pathEntryExists(p); }
			catch { return true; }
		};
		const managed = isFactoryTaskId(taskId)
			|| safeEntryExists(factoryRunPath(sessionDir))
			|| safeEntryExists(this.store.factoryRunIndexPath(taskId))
			|| this.readCoordManagedRun(this.defaultCoordinationPath(), { taskId }).found;
		if (!managed) return;
		const localManifestPath = join(sessionDir, "manifest.json");
		let exists = false;
		try {
			assertNoSymlinkPath(localManifestPath);
			exists = pathEntryExists(localManifestPath);
		} catch (error) {
			throw new ManagedManifestContradictionError(`Unable to inspect run manifest.json: ${errorMessage(error)}`);
		}
		if (!exists) return;
		try {
			readRegularJsonNoSymlink<unknown>(localManifestPath, "run manifest.json");
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new ManagedManifestContradictionError("Malformed JSON in run manifest.json");
			}
			throw new ManagedManifestContradictionError(errorMessage(error));
		}
	}

	list(limit = 10): BootstrapManifest[] {
		return this.store.list(limit).map(manifest => this.observeManifest(manifest));
	}

	status(taskId: string, cwd?: string): RunStatus {
		this.assertSafeManagedFallbackManifest(taskId, cwd);
		return this.readStatus(this.observeManifest(this.store.load(taskId, cwd)));
	}

	private directionAttempt(request: StoredRequest, cwd: string, dbPath: string) {
		const status = this.status(request.task_id, cwd);
		const { manifest } = status;
		const managed = manifest.factory_managed;
		if (!managed || managed.factory_id !== request.factory_id || managed.input_id !== request.input_id || managed.attempt_id !== request.attempt_id || managed.state_db_path !== dbPath) throw new Error("Run binding does not match the original direction request");
		if (manifest.session_dir_removed) throw new Error("Run evidence is missing");
		const entry = manifest.pane_manifest.find(agent => agent.node_id === request.node_id);
		const node = status.agents.find(agent => agent.node_id === request.node_id);
		if (!entry || !node) throw new Error("Original requester is missing from the run roster");
		const dir = manifest.session_dir;
		const key = request.node_attempt_id;
		const scoped = Boolean(manifest.review_plan);
		if (scoped ? !key.startsWith(`${entry.instance_id}.`) || !/^[1-9]\d*$/.test(key.slice(entry.instance_id.length + 1)) : key !== entry.instance_id) throw new Error("Request does not identify an attempt of the original node");
		return { manifest, entry, node, dir, key, scoped };
	}

	/** Cheap discovery, not authority: only a candidate goes through full run and outcome verification. */
	private hasExhaustionCandidate(taskId: string, cwd: string, definition: BoundDirectionDefinition): boolean {
		assertTaskId(taskId);
		const dir = join(cwd, ".pi", "agent-sessions", taskId);
		const reviewers = definition.agents.flatMap(({ node, decision }, i) => decision ? [{ instance: instanceForNode(node.node_id, i), decision }] : []);
		if (!reviewers.length) return false;
		assertNoSymlinkPath(dir);
		// Missing directories are not proof that no request exists.
		const files = new Set(readdirSync(dir));
		for (const { instance, decision } of reviewers) {
			if (files.has(`${instance}.finalize.json`)) {
				const path = finalizePath(dir, instance);
				const header = readRegularJsonNoSymlink<Record<string, unknown>>(path, `review finalization (${path})`);
				if (header?.version !== 1 || header.exhausted !== undefined || header.settled_capacity !== undefined) return true;
				// A marker-less decision is normal for approval, but not for a reviewer-finalized rejection.
				if (header.run_id !== taskId || header.instance_id !== instance ||
					!Array.from({ length: decision.max_revisions + 1 }, (_, n) => `${instance}.${n + 1}`).includes(String(header.attempt_id))) return true;
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
					if (files.has(`${instance}.${n}.transition.json`) && readLoopTransition(dir, taskId, instance, n)?.winner === "finalized") return true;
				}
			}
		}
		return false;
	}

	/** The finalization is the durable trigger; inspecting or discovering it does not write or wake anything. */
	directionExhaustions(ids: Pick<StoredRequest, "factory_id" | "input_id" | "attempt_id" | "task_id">, cwd: string, dbPath: string,
		definition: BoundDirectionDefinition, evidenceFor: (node: string, key: string) => ReturnType<typeof requestDecisionEvidence>, hasSavedAnswer = false): DirectionRequestView[] {
		if (!hasSavedAnswer && !this.hasExhaustionCandidate(ids.task_id, cwd, definition)) return [];
		this.assertSafeManagedFallbackManifest(ids.task_id, cwd);
		const manifest = this.observeManifest(this.store.load(ids.task_id, cwd));
		const managed = manifest.factory_managed;
		if (!managed || managed.factory_id !== ids.factory_id || managed.input_id !== ids.input_id || managed.attempt_id !== ids.attempt_id || managed.state_db_path !== dbPath || manifest.session_dir_removed) {
			throw new Error("Run binding or evidence is missing for revision escalation");
		}
		const dir = manifest.session_dir;
		verifyBoundReviewPlan(definition, manifest.review_plan, manifest.pane_manifest);
		return definition.agents.flatMap(({ node, decision }) => {
			if (!decision) return [];
			const entry = manifest.pane_manifest.find(item => item.node_id === node.node_id);
			if (!entry) throw new Error(`Missing decision ${node.node_id} in the run roster`);
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id)!;
			const finalization = readFinalization(dir, manifest.task_id, loop, loop.reviewer, manifest.topology);
			if (!finalization) return [];
			if (!pathEntryExists(finalizePath(dir, loop.reviewer))) throw new Error(`Missing finalization evidence for ${loop.reviewer}`);
			const key = finalization.attempt_id;
			const attempt = attemptNumber(key);
			const capacity = revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, attempt, true);
			const resultFile = resultPath(dir, key);
			const dispositionFile = dispositionPath(dir, key);
			const expected = { ...expectationFor(manifest, entry), attempt_id: key };
			const outcome = readOutcomeClaimSafe(dir, this.cancelIdentity(manifest, entry, key), key);
			if (outcome.error) throw new Error(outcome.error);
			const result = pathEntryExists(resultFile) ? parseCompletion(readRegularJsonNoSymlink(resultFile, "finalized review result"), expected).result : undefined;
			const disposition = pathEntryExists(dispositionFile) ? parseDisposition(readRegularJsonNoSymlink(dispositionFile, "finalized review disposition"), expected) : undefined;
			if (result ? outcome.claim?.outcome !== "completed" || disposition : !disposition || outcome.claim?.outcome === "completed") throw new Error(`Missing or contradictory review outcome for ${key}`);
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
			// An approval at the limit is still a success. Don't retroactively exhaust a loop because another loop later reserved budget.
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
				if ((evidence.requireRoute && !evidence.approval) || (evidence.approval && (!evidence.approvalDelivered || evidence.approval.verdict !== loop[route]))) throw new Error(`Exhausted verdict for ${key} contradicts the bound human choice or delivery evidence`);
			}
			const request_id = `exhaust_${createHash("sha256").update(JSON.stringify([manifest.task_id, key])).digest("hex")}`;
			return [{ ...ids, request_id, node_id: node.node_id, node_attempt_id: key,
				question: "This review loop is out of revision capacity. What should happen next?",
				reason: `${revisionExhaustionReason(loop, limit)}; plan on_exhausted: ${loop.on_exhausted}.`,
				evidence: [`Run ${manifest.task_id}, finalized review ${key}`],
				choices: [{ choice_id: "retry", label: "Retry with a new brief" }, { choice_id: "takeover", label: "Take over the work manually" }, { choice_id: "discard", label: "Discard the escalation" }],
				exhaustion: { blocked_by: limit, on_exhausted: loop.on_exhausted }, state: "pending", response_recorded: false,
				created_at: outcome.claim?.claimed_at ?? disposition!.recorded_at, consumption: "not_applicable", can_respond: true, can_redeliver: false,
				reconciliation: "pending", verdict: route ? { state: "recorded", value: loop[route] } : { state: "not_applicable" }, admissions: null,
			}];
		});
	}

	/** Observe exact-attempt result and destination claims separately. Never deliver, reconcile on disk, or clean up. */
	directionRouting(request: StoredRequest, cwd: string, dbPath: string, evidence: ReturnType<typeof requestDecisionEvidence>): DirectionRoutingView {
		const { manifest, entry, dir, key } = this.directionAttempt(request, cwd, dbPath);
		verifyBoundReviewPlan(evidence.definition, manifest.review_plan, manifest.pane_manifest);
		const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
		if (loop?.reviewer !== entry.instance_id || !evidence.decision) throw new Error("Run decision does not match the bound definition");
		const path = resultPath(dir, key);
		const outcome = readOutcomeClaimSafe(dir, this.cancelIdentity(manifest, entry, key), key);
		if (outcome.error) throw new Error(outcome.error);
		if (!pathEntryExists(path)) {
			if (outcome.claim?.outcome === "completed") throw new Error("Decision has a completion claim without its result");
			const choices = JSON.parse(request.choices) as Array<{ route?: string }>;
			const revision = choices.some(choice => choice.route === "reject")
				? revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, attemptNumber(key), true) : undefined;
			return { verdict: { state: "not_recorded" }, admissions: null, ...(revision ? { revision } : {}) };
		}
		if (outcome.claim?.outcome !== "completed" || pathEntryExists(dispositionPath(dir, key))) throw new Error("Decision result lacks a matching completion claim or conflicts with termination evidence");
		const completion = parseCompletion(readRegularJsonNoSymlink(path, "decision result"), { ...expectationFor(manifest, entry), attempt_id: key });
		const route = reviewVerdict(loop, completion.result);
		if (!route) return { verdict: { state: "not_applicable" }, admissions: null };
		const value = loop[route];
		if ((evidence.requireRoute && !evidence.approval) || (evidence.approval && (!evidence.approvalDelivered || value !== evidence.approval.verdict))) throw new Error("Recorded verdict contradicts the approval or its delivery evidence");
		const verdict = { state: "recorded", value } as const;
		try {
			const revisionAttempt = attemptNumber(key) + 1;
			if (route === "reject") revisionCapacity(dir, manifest.task_id, manifest.review_plan!, loop, revisionAttempt - 1, true);
			const outbound = outboundEdgesOf(manifest.pane_manifest, entry.instance_id);
			const destinations = route === "approve" ? outbound.map(instance => ({ instance, attempt: 1 })) : [{ instance: loop.target, attempt: attemptNumber(key) + 1 }];
			const digest = inputDigest(completion.result);
			const admissions = destinations.map(({ instance, attempt }) => {
				const target = manifest.pane_manifest.find(item => item.instance_id === instance)!;
				const targetKey = attemptKey(manifest.review_plan, instance, attempt);
				const claim = describeHandoff(dir, entry.instance_id, targetKey, {
					run_id: manifest.task_id, destination: { instance_id: instance, node_id: target.node_id, attempt_id: targetKey }, version: expectedResultVersion(manifest),
				}, entry.instance_id, instance);
				const expectedId = handoffId({ run_id: manifest.task_id, source_attempt_id: key, destination_node_id: target.node_id, destination_attempt_id: targetKey, input_digest: digest });
				const edge = { node_id: target.node_id, kind: route === "approve" ? "successor" as const : "revision" as const };
				const problem = claim?.problems[0] ?? (claim?.handoff_id && (claim.handoff_id !== expectedId || claim.input_digest !== digest) ? "Handoff does not match the recorded verdict result" : undefined);
				if (problem) return { ...edge, state: "unknown" as const, reason: problem };
				if (claim?.state === "accepted") return claim.offered_at && !claim.legacy
					? { ...edge, state: "admitted" as const }
					: { ...edge, state: "unknown" as const, reason: "Acceptance has no matching offer" };
				const progressFile = join(dir, `${instance}.progress.json`);
				const progress = pathEntryExists(progressFile) ? readRegularJsonNoSymlink<ProgressSnapshot>(progressFile, "destination progress") : undefined;
				if (progress && progress.token !== manifest.token) return { ...edge, state: "unknown" as const, reason: "Destination progress belongs to another run" };
				if (pathEntryExists(resultPath(dir, targetKey)) || (progress?.attempt_id === targetKey && progress.started_at !== undefined)) {
					return { ...edge, state: "unknown" as const, reason: "Destination execution has no matching admission claim" };
				}
				return { ...edge, state: "not_admitted" as const };
			});
			return { verdict, admissions: admissions.length ? admissions : null };
		} catch (error) { return { verdict, admissions: "unknown", routing_error: errorMessage(error) }; }
	}

	/** Verify the original receiver without treating heartbeat age, Herdr display state or a live PID as authority. */
	directionObservation(request: StoredRequest, cwd: string, dbPath: string, receiver?: DirectionReceiver): "receiver_verified" | "unverified" | "result" | "cancelled" | "failed" {
		const { manifest, entry, node, dir, key, scoped } = this.directionAttempt(request, cwd, dbPath);
		const cancel = readRunCancelRecordSafe(dir, manifest.task_id);
		const nodeCancel = readCancelRecordSafe(dir, this.cancelIdentity(manifest, entry));
		const failed = readFailFast(dir, manifest.task_id, manifest.token);
		const outcome = readOutcomeClaimSafe(dir, this.cancelIdentity(manifest, entry, scoped ? key : entry.attempt_id), key);
		const error = cancel.error ?? nodeCancel.error ?? failed.error ?? outcome.error;
		if (error) throw new Error(error);
		const resultFile = resultPath(dir, key);
		if (pathEntryExists(resultFile)) {
			if (outcome.claim?.outcome === "cancelled" || pathEntryExists(dispositionPath(dir, key))) throw new Error("Original attempt has contradictory result and termination evidence");
			const completion = parseCompletion(readRegularJsonNoSymlink(resultFile, "direction requester result"), { ...expectationFor(manifest, entry), attempt_id: scoped ? key : entry.attempt_id });
			return completion.result.status === "failure" ? "failed" : "result";
		}
		if (cancel.record || nodeCancel.record || failed.record || outcome.claim?.outcome === "cancelled" || node.cancelling || node.execution === "cancelled") return "cancelled";
		if (node.execution === "failed") return "failed";
		if (outcome.claim || pathEntryExists(dispositionPath(dir, key))) throw new Error("Original attempt has terminal evidence without a result");
		if (manifest.status !== "applied" || entry.status === "closed" || node.execution !== "running" || (scoped ? node.attempt_id !== key : node.instance_id !== key)) throw new Error(node.process_state === "exited" ? "Original requester exited" : "Original attempt is not running or its resource evidence changed");
		if (!receiver) return "unverified";
		const ready = parseWorkerReady(readRegularJsonNoSymlink(readyPath(dir, entry.instance_id), "direction requester readiness"));
		if (ready.version !== 2 || receiver.instance_id !== entry.instance_id || receiver.run_token !== manifest.token || ready.token !== manifest.token || ready.task_id !== manifest.task_id || ready.instance_id !== entry.instance_id || ready.pid !== receiver.pid || ready.session_id !== receiver.session_id || ready.start_time !== receiver.start || ready.direction_incarnation !== receiver.incarnation) throw new Error("Original requester readiness identity is missing or changed");
		const proc = directionProcess(receiver.pid);
		if (proc.boot !== receiver.boot || proc.start !== receiver.start || ["Z", "X", "x"].includes(proc.state)) throw new Error("Original requester exited or its process identity changed");
		return "receiver_verified";
	}

	/** Read-only settlement observations for a run; never resumes, repairs or cleans up. */
	settlementObservations(taskId: string, cwd?: string): SettlementObservations {
		let st: RunStatus;
		try { st = this.status(taskId, cwd); } catch (error) {
			const live = cwd ? liveWorkersIn(join(cwd, ".pi", "agent-sessions", taskId)) : [];
			if (live.length === 0) throw error;
			// The run status is unreadable, but a worker is positively live: that is still resume risk, however damaged the rest of the evidence is.
			const reason = `settlement evidence is unreadable: ${errorMessage(error)}`;
			return { evidence_unreadable: true, cancellation: { intent: "unknown", error: reason }, resource_closure: { state: "unknown", recorded_closed: [], not_recorded_closed: [] }, execution_settlement: { state: "unknown", reason }, outcome: "incomplete", resume_risk: live.map(id => `${id} has a live worker process and no recorded outcome (the run status is unreadable)`), attention: [] };
		}
		const cancel = st.manifest.session_dir_removed ? { error: "run session evidence is no longer present" } : readRunCancelRecordSafe(st.manifest.session_dir, taskId);
		return observeSettlement({
			manifestStatus: st.manifest.status,
			sessionDirRemoved: Boolean(st.manifest.session_dir_removed),
			cancel: { ...(cancel.record ? { record: cancel.record } : {}), ...(cancel.error ? { error: cancel.error } : {}) },
			agents: st.agents.map(agent => ({ ...agent, detached_without_outcome: !st.manifest.session_dir_removed && !agent.result_status && detachedWithoutOutcome(st.manifest.session_dir, agent) })), outcome: st.outcome, pending: st.pending, workerErrors: st.worker_errors, deliveryErrors: st.delivery_errors,
		});
	}

	private readStatus(manifest: BootstrapManifest): RunStatus {
		const repairStandalone = !this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest);
		const results: BootstrapResult[] = [];
		const pending: string[] = [];
		const deliveryErrors: string[] = [];
		const workerErrors: string[] = [];
		const agents: AgentState[] = [];
		const humanWaits = new Set<string>();
		const unsettledReviews = new Set<string>();
		const closedReviewEdges = new Map<string, NonNullable<ReturnType<typeof blockedReviewForwardEdge>>>();
		let settledAttention = 0;
		const available = !manifest.session_dir_removed;
		const reviewAttempts = new Map<string, ReturnType<typeof currentAttempt>>();
		const reviewErrors = new Map<string, string>();
		const finalizationErrors = new Set<string>();
		if (available && manifest.review_plan) for (const entry of manifest.pane_manifest) {
			try {
				let att = currentAttempt(manifest, entry);
				const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
				try {
					const finalization = loop ? readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id) : undefined;
					if (finalization && att && attemptNumber(finalization.attempt_id) < att.number) {
						att = { ...att, number: attemptNumber(finalization.attempt_id) };
					}
				} catch { finalizationErrors.add(entry.instance_id); /* validated below per-agent */ }
				reviewAttempts.set(entry.instance_id, att);
			} catch (error) { reviewErrors.set(entry.instance_id, errorMessage(error)); }
		}

		const keyFor = (entry: AgentLaunch) => attemptKey(manifest.review_plan, entry.instance_id, reviewAttempts.get(entry.instance_id)?.number);

		// A node is settled once it has a result, or a record that it never executed: a successor's undelivered handoff no longer matters then.
		const finished = new Set(manifest.pane_manifest.filter(entry => available && (existsSync(resultPath(manifest.session_dir, keyFor(entry))) || existsSync(dispositionPath(manifest.session_dir, keyFor(entry))))).map(entry => entry.instance_id));
		const processStateOf = (entry: (typeof manifest.pane_manifest)[number]): "alive" | "exited" | "unknown" => {
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (!available || !existsSync(readyFile)) return "unknown";
			try {
				const ready = parseWorkerReady(readJson<unknown>(readyFile));
				if (ready.task_id === manifest.task_id && ready.token === manifest.token && ready.instance_id === entry.instance_id) return processAlive(ready) ? "alive" : "exited";
			} catch { /* unreadable readiness is not proof of life */ }
			return "unknown";
		};
		const exited = (entry: (typeof manifest.pane_manifest)[number]): boolean => entry.status !== "closed" && processStateOf(entry) === "exited";
		const now = this.now();
		const nowIso = new Date(now).toISOString();
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
					const view = describeHandoff(manifest.session_dir, sourceId, keyFor(entry), { run_id: manifest.task_id, source_instance_id: sourceId, destination: { node_id: entry.node_id, instance_id: entry.instance_id, attempt_id: manifest.review_plan ? keyFor(entry) : entry.attempt_id }, version: expectedResultVersion(manifest) }, sourceScope(sourceId), entry.instance_id);
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
						const view = describeHandoff(manifest.session_dir, revSource, nextKey, { run_id: manifest.task_id, source_instance_id: revSource, destination: { node_id: entry.node_id, instance_id: entry.instance_id, attempt_id: `${entry.instance_id}.${nextAttempt}` }, version: expectedResultVersion(manifest) }, sourceScope(revSource), entry.instance_id);
						if (view?.rejections.length) revisionRejections.set(entry.instance_id, view);
					} catch { /* one unreadable record must not hide the run */ }
				}
			}
		}
		const failFastCancelReason = failFastInfo.record
			? `Cancelled by fail-fast policy after ${failFastInfo.record.cause.node_id} (${failFastInfo.record.cause.state}): ${failFastInfo.record.cause.reason}`
			: undefined;
		const isFailFastCancel = (reason: string): boolean =>
			failFastCancelReason !== undefined && reason === failFastCancelReason;
		type RouteCancellation =
			| { settled: true; scope: "run" | "node"; reason: string }
			| { settled: false };
		const routeTargetCache = new Map<string, RouteCancellation>();
		const inspectTargetCancellation = (target: string, targetAttempt: number): RouteCancellation => {
			const targetKey = attemptKey(manifest.review_plan, target, targetAttempt);
			const cached = routeTargetCache.get(targetKey);
			if (cached) return cached;
			const set = (value: RouteCancellation): RouteCancellation => { routeTargetCache.set(targetKey, value); return value; };
			const targetEntry = entryByInstance.get(target);
			if (!targetEntry) return set({ settled: false });
			if (reviewErrors.has(target)) return set({ settled: false });
			const resFile = resultPath(manifest.session_dir, targetKey);
			if (existsSync(resFile)) return set({ settled: false });
			if (failFastInfo.error || runCancelInfo.error || targetEntry.error) return set({ settled: false });
			const failure = manifest.review_plan && !existsSync(join(manifest.session_dir, `${targetKey}.error.json`)) && targetAttempt === 1
				? join(manifest.session_dir, `${targetEntry.instance_id}.error.json`)
				: join(manifest.session_dir, `${targetKey}.error.json`);
			if (existsSync(failure)) return set({ settled: false });
			const cancelInfo = readCancelRecordSafe(manifest.session_dir, this.cancelIdentity(manifest, targetEntry));
			const claimInfo = readOutcomeClaimSafe(manifest.session_dir, { ...this.cancelIdentity(manifest, targetEntry), ...(manifest.review_plan ? { attempt_id: targetKey } : {}) }, targetKey);
			if (cancelInfo.error || claimInfo.error) return set({ settled: false });
			const ownFile = ownershipPath(manifest.session_dir, targetEntry.instance_id);
			if (existsSync(ownFile)) {
				try { parseOwnershipRecord(readJson<unknown>(ownFile), expectationFor(manifest, targetEntry)); }
				catch { return set({ settled: false }); }
			}
			if (keyFor(targetEntry) === targetKey) {
				const targetInbound = reviewAttempts.get(targetEntry.instance_id)?.source ? [reviewAttempts.get(targetEntry.instance_id)!.source!] : inboundEdgesOf(targetEntry);
				if (targetInbound.some(src => (handoffs.get(`${src}->${targetEntry.instance_id}`)?.problems.length ?? 0) > 0)) {
					return set({ settled: false });
				}
			}
			const matching = cancelInfo.record && (!manifest.review_plan || !cancelInfo.record.identity.attempt_id || cancelInfo.record.identity.attempt_id === targetKey)
				? cancelInfo.record : undefined;
			const bootstrapMatching = matching && !isFailFastCancel(matching.reason) ? matching : undefined;
			const dispFile = dispositionPath(manifest.session_dir, targetKey);
			if (existsSync(dispFile)) {
				const targetExpected = manifest.review_plan ? { ...expectationFor(manifest, targetEntry), attempt_id: targetKey } : expectationFor(manifest, targetEntry);
				try {
					const disp = parseDisposition(readJson<unknown>(dispFile), targetExpected);
					if (disp.state !== "cancelled") return set({ settled: false });
					if (!bootstrapMatching && !runCancelInfo.record && isFailFastCancel(disp.reason)) {
						return set({ settled: false });
					}
					const scope: "run" | "node" = bootstrapMatching?.scope ?? (runCancelInfo.record ? "run" : "node");
					return set({ settled: true, scope, reason: bootstrapMatching?.reason ?? runCancelInfo.record?.reason ?? disp.reason });
				} catch {
					return set({ settled: false });
				}
			}
			const activeCancel = bootstrapMatching ?? (claimInfo.claim?.outcome === "completed" ? undefined : runCancelInfo.record);
			if (!activeCancel) return set({ settled: false });
			let workingTarget = false;
			if (!exited(targetEntry) && targetEntry.status !== "closed") {
				try {
					const progress = readJson<ProgressSnapshot>(join(manifest.session_dir, `${targetEntry.instance_id}.progress.json`));
					workingTarget = progress.token === manifest.token && progress.state === "working" && (!manifest.review_plan || progress.attempt_id === targetKey);
				} catch { /* no progress yet */ }
			}
			if (workingTarget) return set({ settled: false });
			return set({ settled: true, scope: bootstrapMatching ? bootstrapMatching.scope : "run", reason: activeCancel.reason });
		};
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
				...(entry.kind === "command" ? { kind: "command", command: entry.command, args: entry.args, working_directory: entry.working_directory } : {}),
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
			const handoff = inbound.length === 1 ? handoffs.get(`${inbound[0]}->${entry.instance_id}`) : undefined;
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
					run_id: manifest.task_id, destination: { instance_id: target, node_id: entryByInstance.get(target)!.node_id, attempt_id: targetKey }, version: expectedResultVersion(manifest),
				}, sourceScope(entry.instance_id), target);
			};
			const outbound = available && outboundTargets.length === 1 ? outboundView(outboundTargets[0]) : undefined;
			if (outbound) state.handoff_out = outbound;
			let feedback: HandoffView | undefined;
			const attempt = reviewAttempts.get(entry.instance_id)?.number ?? 1;
			if (available && loop?.reviewer === entry.instance_id && attempt <= loop.max_revisions) {
				const targetKey = attemptKey(manifest.review_plan, loop.target, attempt + 1);
				feedback = describeHandoff(manifest.session_dir, entry.instance_id, targetKey, {
					run_id: manifest.task_id,
					destination: { node_id: entryByInstance.get(loop.target)!.node_id, attempt_id: targetKey },
					version: expectedResultVersion(manifest),
				}, sourceScope(entry.instance_id), loop.target);
			}
			if (feedback || (manifest.topology === "graph" && outboundTargets.length > 0)) {
				state.handoffs_out = Object.fromEntries(
					outboundTargets.map(target => [
						target,
						(available ? (outboundTargets.length === 1 ? outbound : outboundView(target)) : undefined) ?? {
							state: "none",
							source: entry.instance_id,
							destination: target,
							rejections: [],
							problems: [],
						},
					]),
				);
			}
			if (feedback) state.handoffs_out![feedback.destination] = feedback;
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
			state.process_state = processStateOf(entry);
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
						if (state.process_state === "alive" && diag.liveness === "healthy" && humanWaitStartedAt(progress) !== undefined) humanWaits.add(entry.instance_id);
						heartbeat = progress.state === "working" ? "working" : "waiting";
						state.recent_working_heartbeat = heartbeat === "working" && (diag.liveness === "healthy" || diag.liveness === "stalled");
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
			const nodeCancel = cancelInfo.record;
			const matchingNodeCancel = nodeCancel && (!manifest.review_plan || !nodeCancel.identity.attempt_id || nodeCancel.identity.attempt_id === attemptId)
				? nodeCancel : undefined;
			const cancelRecord = matchingNodeCancel ?? (claimInfo.claim?.outcome === "completed" ? undefined : runCancelInfo.record);
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
			let finalizationError = false;
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
					finalizationError = true;
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
				if (completion.result.command_evidence) state.command_evidence = completion.result.command_evidence;
				if (state.state !== "closed") state.state = "done";
				let routes: Array<{ instance: string; attempt: number }> = outboundTargets.map(instance => ({ instance, attempt: 1 }));
				let reviewClaimed = false;
				let reviewRoutesError = false;
				if (completion.delivery === "pending" || completion.delivery === "failed") {
					try {
						if (manifest.review_plan && completion.identity) {
							routes = reviewRoutes(manifest.session_dir, completion.identity, manifest.review_plan, completion.result, outboundTargets);
							reviewClaimed = routes.length > 0 && reviewDeliveryClaimed(manifest.session_dir, completion, routes);
						}
					} catch (error) {
						reviewRoutesError = true;
						state.error = errorMessage(error);
						workerErrors.push(`${label}: ${state.error}`);
					}
				}
				let deadFeedback = false;
				let openRevisionTransition = false;
				if (loop && !finalization) {
					const attemptNum = attemptNumber(attemptId);
					if (loop.reviewer === entry.instance_id) {
						try {
							const rejected = reviewVerdict(loop, completion.result) === "reject";
							if (rejected) {
								state.execution = "waiting";
								state.execution_reason = `The review rejected the work: ${completion.result.summary}`;
							}
							if (rejected && revisionReserved(manifest.session_dir, manifest.task_id, loop, attemptNum + 1)) {
								const deadMembers = loop.members.filter(memberId => {
									const memberEntry = entryByInstance.get(memberId);
									if (!memberEntry || (memberEntry.status !== "closed" && !exited(memberEntry))) return false;
									if (memberId === entry.instance_id) return true;
									const memberAttempt = reviewAttempts.get(memberId)?.number ?? 1;
									return existsSync(resultPath(manifest.session_dir, attemptKey(manifest.review_plan, memberId, memberAttempt)));
								});
								if (deadMembers.length) {
									deadFeedback = true;
									const targetNode = entryByInstance.get(loop.target)?.node_id ?? loop.target;
									const deadNames = deadMembers.map(id => entryByInstance.get(id)?.node_id ?? id);
									const revisionStarted = loop.members.some(id => (reviewAttempts.get(id)?.number ?? 1) > attemptNum);
									state.execution = "needs_attention";
									state.execution_reason = `Feedback edge to ${targetNode} is dead: parked agent ${deadNames.join(", ")} exited ${revisionStarted ? "during" : "before"} revision`;
									state.error ??= state.execution_reason;
									state.parked = false;
									workerErrors.push(`${label}: ${state.execution_reason}`);
									if (repairStandalone && manifest.topology === "graph") {
										finalizeReview(manifest.session_dir, manifest.task_id, loop, attemptNum, state.execution_reason, "dispatcher", { force: true, allowAhead: true, exhaustedState: "needs_attention" });
										finalization = readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
									}
									if (finalization) {
										loopDecision = finalization;
										state.finalized = true;
										settledAttention++;
										for (const memberId of loop.members) {
											const memberEntry = entryByInstance.get(memberId);
											if (repairStandalone && memberEntry) settleDeadLoopMember(manifest, loop, memberEntry, attemptNum, finalization.finalized_by, nowIso);
										}
									} else {
										pending.push(entry.node_id);
										deadFeedbackTargets.set(loop.target, entry.node_id);
										for (const id of loop.members) {
											const member = entryByInstance.get(id);
											if (member && id !== loop.reviewer) deadFeedbackMembers.add(member.node_id);
										}
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
					} else {
						try {
							if (readLoopTransition(manifest.session_dir, manifest.task_id, entry.instance_id, attemptNum)?.winner === "revision" &&
								!existsSync(resultPath(manifest.session_dir, attemptKey(manifest.review_plan, entry.instance_id, attemptNum + 1)))) {
								openRevisionTransition = true;
								state.execution = "needs_attention";
								state.execution_reason = `Revision attempt ${attemptNum + 1} transition was recorded without claiming the handoff`;
								state.error ??= state.execution_reason;
								state.parked = false;
								workerErrors.push(`${label}: ${state.execution_reason}`);
								pending.push(entry.node_id);
							}
						} catch (error) {
							openRevisionTransition = true;
							state.execution = "needs_attention";
							state.error ??= errorMessage(error);
							state.parked = false;
							workerErrors.push(`${label}: ${state.error}`);
							pending.push(entry.node_id);
						}
					}
					if (!deadFeedback && !openRevisionTransition) {
						unsettledReviews.add(entry.node_id);
						state.parked = completion.delivery === "sent" || completion.delivery === "not_required" || reviewClaimed;
						pending.push(entry.node_id);
					}
				}
				// A rejection can lose to cancellation between result publication and finalization.
				// Keep the verdict in the attempt history and use the dispatcher's disposition for execution.
				let cancelledRejection: Disposition | undefined;
				if (loop && finalization?.finalized_by === "dispatcher" && existsSync(dispositionFile)) {
					try {
						cancelledRejection = this.readCancelledRejection(manifest, entry, loop, attemptId, completion.result, finalization);
					} catch (error) {
						state.error = errorMessage(error);
						workerErrors.push(`${label}: ${state.error}`);
					}
				}
				const rejection = !cancelledRejection && loop && finalizedReviewRejection(loop, finalization, entry.node_id, completion.result);
				if (rejection) {
					state.execution = rejection.state;
					state.execution_reason = rejection.reason;
					const dispatcherDeadFeedback = finalization?.finalized_by === "dispatcher" && rejection.state === "needs_attention" && rejection.reason.startsWith("Feedback edge to ");
					if (dispatcherDeadFeedback && !deadFeedback) {
						state.error ??= rejection.reason;
						workerErrors.push(`${label}: ${rejection.reason}`);
					}
					if (state.execution === "needs_attention" && (!state.error || dispatcherDeadFeedback) && !deadFeedback) settledAttention++;
				}
				if (cancelledRejection) {
					state.execution = "cancelled";
					state.execution_reason = cancelledRejection.reason;
					state.execution_causes = cancelledRejection.causes;
				}
				const closedEdge = loop && blockedReviewForwardEdge(loop, finalization, entry.node_id,
					cancelledRejection ?? { ...executionFromResult(completion.result.status), reason: completion.result.summary },
					cancelledRejection ? undefined : completion.result);
				if (closedEdge && (!state.error || (deadFeedback && !!finalization) || (finalization?.finalized_by === "dispatcher" && finalization.exhausted?.state === "needs_attention"))) {
					closedReviewEdges.set(entry.instance_id, closedEdge);
				}
				// Once the successor has its own durable result or record that it never executed, or an active bootstrap_cancel
				// ensures it can never claim/run, an undelivered handoff no longer keeps the run incomplete.
				// An accepted handoff proves delivery whatever the source recorded (e.g. a lost acknowledgement).
				const dispatcherDeadFeedback = finalization?.finalized_by === "dispatcher" && finalization.exhausted?.state === "needs_attention" && finalization.exhausted.reason.startsWith("Feedback edge to ");
				const autoCleanup = manifest.cleanup_policy?.mode === "on_success";
				const perEdge = manifest.topology === "graph" || Boolean(manifest.review_plan);
				const agentExited = isExited || entry.status === "closed";
				const exitedApprovalWithoutSuccessors = !autoCleanup && loop?.reviewer === entry.instance_id && finalization &&
					outboundTargets.length === 0 && agentExited && reviewVerdict(loop, completion.result) === "approve";
				const oldBaseSettled = exitedApprovalWithoutSuccessors || ((closedEdge || loopDecision) && (!state.error || dispatcherDeadFeedback));
				const loopFinalizationError = finalizationError || Boolean(loop?.members.some(member => finalizationErrors.has(member)));
				const routeResults = routes.map(({ instance: target, attempt }) => {
					const edgeSent = perEdge && completion.edge_deliveries?.[target]?.state === "sent";
					const edgeClaimed = perEdge && completion.identity
						? reviewDeliveryClaimed(manifest.session_dir, completion, [{ instance: target, attempt }])
						: handoffs.get(`${entry.instance_id}->${target}`)?.state === "accepted";
					const oldRouteSettled = autoCleanup
						? edgeSent || edgeClaimed || (!loop && finished.has(target))
						: (Boolean(manifest.review_plan && completion.identity) && edgeClaimed) ||
							(!loop && (finished.has(target) || handoffs.get(`${entry.instance_id}->${target}`)?.state === "accepted"));
					const cancelSettlement = !oldBaseSettled && !oldRouteSettled && !closedEdge && !loopFinalizationError
						? inspectTargetCancellation(target, attempt)
						: { settled: false as const };
					const newlySettledByCancel = cancelSettlement.settled;
					return { target, attempt, edgeSent, oldRouteSettled, newlySettledByCancel, cancelSettlement };
				});
				let oldHandoffSettled: boolean;
				if (autoCleanup) {
					const oldRoutesSettled = !reviewRoutesError && (routes.length === 0
						? agentExited && completion.delivery !== "failed" && (!loop || Boolean(finalization))
						: routeResults.every(r => r.oldRouteSettled));
					oldHandoffSettled = oldBaseSettled || oldRoutesSettled;
				} else {
					oldHandoffSettled = oldBaseSettled || (!reviewRoutesError && routes.length > 0 && routeResults.every(r => r.oldRouteSettled));
				}
				const handoffSettled = oldHandoffSettled || (!reviewRoutesError && routes.length > 0 && routeResults.every(r => r.oldRouteSettled || r.newlySettledByCancel));
				if (reviewClaimed) state.delivery = "sent";
				if (!reviewRoutesError && (completion.delivery === "pending" || completion.delivery === "failed")) {
					for (const r of routeResults) {
						if (!r.newlySettledByCancel || !r.cancelSettlement.settled) continue;
						if (r.edgeSent) continue;
						const existingOut = state.handoffs_out?.[r.target] ?? (state.handoff_out?.destination === r.target ? state.handoff_out : undefined);
						if (existingOut?.state === "queued" || existingOut?.state === "accepted") continue;
						const targetNode = entryByInstance.get(r.target)?.node_id ?? r.target;
						const why = r.cancelSettlement.scope === "run" ? `run was cancelled: ${r.cancelSettlement.reason}` : `${targetNode} was cancelled: ${r.cancelSettlement.reason}`;
						if (state.handoffs_out?.[r.target]) {
							state.handoffs_out[r.target] = { ...state.handoffs_out[r.target], not_delivered_reason: why };
						}
						if (state.handoff_out?.destination === r.target) {
							state.handoff_out = { ...state.handoff_out, not_delivered_reason: why };
						} else if (!state.handoff_out && outboundTargets.length === 1 && outboundTargets[0] === r.target) {
							state.handoff_out = {
								state: "none",
								source: entry.instance_id,
								destination: r.target,
								rejections: [],
								problems: [],
								not_delivered_reason: why,
							};
						}
					}
				}
				if (completion.delivery === "failed" && !handoffSettled && !deadFeedback) deliveryErrors.push(`${label}: ${completion.delivery_error}`);
				if (completion.delivery === "pending" && !handoffSettled) {
					if (!unsettledReviews.has(entry.node_id)) pending.push(entry.node_id);
					if (manifest.review_plan && (!autoCleanup || routes.length > 0 || (loop && !finalization))) unsettledReviews.add(entry.node_id);
					if (isExited) { workerErrors.push(`${label}: process exited during chain handoff`); state.error ??= "process exited during chain handoff"; }
				}
			} else if (disposition) {
				if (state.task_timeout_ms !== undefined) state.deadline_exceeded = false;
				state.execution = disposition.state; state.execution_causes = disposition.causes; state.execution_reason = disposition.reason;
				if (disposition.command_evidence) state.command_evidence = disposition.command_evidence;
				if (disposition.state === "needs_attention") {
					state.error ??= disposition.reason;
					workerErrors.push(`${label}: needs attention: ${disposition.reason}`);
					pending.push(entry.node_id);
				} else if (state.state !== "closed") state.state = "done";
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
					state.force_close_allowed = remaining === 0 && !this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest);
					state.execution_reason = `${cancelRecord.reason} (cancelling; in-progress tool work cannot be undone by hooks)`;
				} else {
					state.execution = "cancelled";
					state.cancel_inferred = true;
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
				else if (manifest.status === "error" && (manifest.phase === "uncertain" || manifest.phase === "held") && this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest)) {
					state.execution = "needs_attention";
					state.execution_reason = manifest.error ?? `Factory-managed run is ${manifest.phase}`;
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
		const settledPending = new Set<string>();
		if (available) for (const loop of manifest.review_plan?.loops ?? []) {
			let lastVerdict: string | undefined;
			for (const member of loop.members) {
				const entry = entryByInstance.get(member)!;
				const agent = stateByInstance.get(member)!;
				const latest = reviewAttempts.get(member)?.number ?? 1;
				const isReviewer = member === loop.reviewer;
				// Latest outcomes were already validated above. Read the earlier records as well,
				// including those preceding the last verdict, so status and report agree on integrity.
				for (let number = 1; number <= latest; number++) {
					if (number === latest && (!isReviewer || !agent.result_status)) continue;
					try {
						const attempt = this.reviewAttempt(manifest, entry, number, loop);
						if (attempt?.verdict) lastVerdict = attempt.verdict;
					} catch (error) {
						const reason = errorMessage(error);
						workerErrors.push(reason);
						agent.error ??= reason;
						agent.execution = "needs_attention";
						agent.execution_reason = reason;
						agent.state = "error";
						agent.parked = false;
						unsettledReviews.delete(agent.node_id);
						if (!pending.includes(agent.node_id)) pending.push(agent.node_id);
					}
				}
				if (agent.finalized) {
					for (let number = latest + 1; number <= loop.max_revisions + 1; number++) {
						const key = attemptKey(manifest.review_plan, member, number);
						const resFile = resultPath(manifest.session_dir, key);
						if (!existsSync(resFile)) continue;
						try {
							const attempt = this.reviewAttempt(manifest, entry, number, loop);
							if (attempt) (agent.unreviewed_attempts ??= []).push({ attempt_id: key, state: attempt.state, summary: attempt.summary, result_path: resFile });
						} catch (error) {
							const reason = errorMessage(error);
							workerErrors.push(reason);
							agent.error ??= reason;
							agent.execution = "needs_attention";
							agent.execution_reason = reason;
							agent.state = "error";
							agent.parked = false;
							unsettledReviews.delete(agent.node_id);
							if (!pending.includes(agent.node_id)) pending.push(agent.node_id);
						}
					}
				}
			}
			if (lastVerdict) for (const member of loop.members) stateByInstance.get(member)!.last_verdict = lastVerdict;
			let revDecision: ReturnType<typeof readFinalization>;
			if (available) {
				try { revDecision = readFinalization(manifest.session_dir, manifest.task_id, loop, loop.reviewer); }
				catch { /* corrupt finalization already recorded on the reviewer */ }
			}
			if (repairStandalone && revDecision?.finalized_by === "dispatcher" && revDecision.exhausted?.state === "needs_attention") {
				for (const member of loop.members) {
					const memberEntry = entryByInstance.get(member);
					const memberState = stateByInstance.get(member);
					if (!memberEntry || !memberState || memberState.execution === "running" || memberState.execution === "needs_attention") continue;
					const memberAttempt = reviewAttempts.get(member)?.number ?? 1;
					try {
						const settled = settleDeadLoopMember(manifest, loop, memberEntry, memberAttempt, revDecision.finalized_by, nowIso);
						if (settled) {
							memberState.finalized = true;
							memberState.parked = false;
							if (memberState.ownership_status === "admitted") memberState.ownership_status = "released";
							unsettledReviews.delete(memberState.node_id);
							if (!memberState.error) settledPending.add(memberState.node_id);
						}
					} catch (error) {
						const reason = errorMessage(error);
						workerErrors.push(reason);
						memberState.error ??= reason;
						memberState.execution = "needs_attention";
						memberState.execution_reason = reason;
						memberState.state = "error";
						memberState.parked = false;
						unsettledReviews.delete(memberState.node_id);
						if (!pending.includes(memberState.node_id)) pending.push(memberState.node_id);
					}
				}
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
		const orderedManifest: AgentLaunch[] = [];
		const visitedInstance = new Set<string>();
		const visitingInstance = new Set<string>();
		const visitManifest = (entry: AgentLaunch) => {
			if (visitedInstance.has(entry.instance_id) || visitingInstance.has(entry.instance_id)) return;
			visitingInstance.add(entry.instance_id);
			for (const sourceId of inboundEdgesOf(entry)) {
				const srcEntry = entryByInstance.get(sourceId);
				if (srcEntry) visitManifest(srcEntry);
			}
			visitingInstance.delete(entry.instance_id);
			visitedInstance.add(entry.instance_id);
			orderedManifest.push(entry);
		};
		for (const entry of manifest.pane_manifest) visitManifest(entry);
		for (const entry of manifest.pane_manifest) {
			if (!visitedInstance.has(entry.instance_id)) orderedManifest.push(entry);
		}
		for (const entry of orderedManifest) {
			const inbound = inboundEdgesOf(entry);
			const deadFeedbackSource = deadFeedbackTargets.get(entry.instance_id);
			if (!inbound.length && !deadFeedbackSource) continue;
			const destState = stateByInstance.get(entry.instance_id)!;
			const destLoop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			const edgeStates: Record<string, EdgeState> = {};
			for (const sourceId of inbound) {
				const srcState = stateByInstance.get(sourceId);
				if (!srcState) continue;
				const view = handoffs.get(`${sourceId}->${entry.instance_id}`);
				const edgePolicy = inbound.length > 1
					? effectiveDependencyPolicy(entry.join_policy, dependencyPolicyOf(entry, true))
					: (dependencyPolicyOf(entry, true) ?? "require_success");
				const closed = view?.state !== "accepted" ? closedReviewEdges.get(sourceId) : undefined;
				// A finalized decision in a graph run can settle an unadmitted or dependency-timed-out successor before its worker polls, or add causes to an already-blocked one.
				const isDependencyTimeoutReason = (reason: string | undefined): boolean =>
					!!reason && /^No (?:upstream|useful|predecessor) progress or handoff from /.test(reason);
				const clearTimeoutWorkerError = (nodeEntry: AgentLaunch, nodeState: AgentState) => {
					nodeState.error = undefined;
					const prefix = `${nodeLabel(nodeEntry)}: needs attention: `;
					for (let idx = workerErrors.length - 1; idx >= 0; idx--) {
						if (workerErrors[idx].startsWith(prefix)) workerErrors.splice(idx, 1);
					}
				};
				const alreadyBlocked = destState.execution === "blocked";
				const timedOutWaiting = manifest.topology === "graph" && destState.execution === "needs_attention" &&
					!destState.result_status && isDependencyTimeoutReason(destState.execution_reason);
				if (closed && (destState.execution === "pending" || destState.execution === "waiting" || timedOutWaiting || alreadyBlocked || settledByReview.has(destState.node_id))) {
					const existingCauses = new Set(timedOutWaiting ? [] : destState.execution_causes.map(c => `${c.node_id}/${c.state}/${c.check?.name ?? ""}`));
					if (timedOutWaiting) destState.execution_causes = [];
					let addedCause = false;
					for (const cause of closed.causes) {
						const causeKey = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`;
						if (!existingCauses.has(causeKey)) { existingCauses.add(causeKey); destState.execution_causes.push(cause); addedCause = true; }
					}
					if (timedOutWaiting) clearTimeoutWorkerError(entry, destState);
					if ((!alreadyBlocked && !settledByReview.has(destState.node_id)) || timedOutWaiting) {
						destState.execution = "blocked";
						destState.execution_reason = closed.reason;
						destState.state = "done";
						settledByReview.add(destState.node_id);
						if (repairStandalone && timedOutWaiting && manifest.review_plan) {
							atomicJson(dispositionPath(manifest.session_dir, keyFor(entry)), dispositionRecord({ ...entry, attempt_id: destState.attempt_id, task_id: manifest.task_id }, "blocked", destState.execution_reason, destState.execution_causes, nowIso));
						}
					} else if (addedCause && closed.reason && !destState.execution_reason?.includes(closed.reason)) {
						destState.execution_reason = destState.execution_reason
							? `${destState.execution_reason}; ${closed.reason}`
							: closed.reason;
					}
				}
				const sourceLoop = reviewLoopFor(manifest.review_plan, sourceId);
				const edgePendingReview = unsettledReviews.has(srcState.node_id) && (!sourceLoop || sourceLoop !== destLoop);
				const edgeState = closed ? "dead" : deriveEdgeState({
					sourceExecution: edgePendingReview ? "waiting" : srcState.execution,
					dependencyPolicy: edgePolicy,
					handoffClaimed: view?.state === "accepted",
				});
				edgeStates[srcState.node_id] = edgeState;
				if (destState.execution === "blocked" && !closed && edgeState === "dead") {
					const adm = decideAdmission({
						policy: edgePolicy,
						predecessor: { node_id: srcState.node_id, execution: { state: srcState.execution, causes: srcState.execution_causes, reason: srcState.execution_reason } },
						checks: [],
					});
					if (!adm.admit && adm.outcome === "blocked") {
						const existingCauses = new Set(destState.execution_causes.map(c => `${c.node_id}/${c.state}/${c.check?.name ?? ""}`));
						let addedCause = false;
						for (const cause of adm.causes) {
							const causeKey = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`;
							if (!existingCauses.has(causeKey)) { existingCauses.add(causeKey); destState.execution_causes.push(cause); addedCause = true; }
						}
						if (addedCause && adm.reason && !destState.execution_reason?.includes(adm.reason)) {
							destState.execution_reason = destState.execution_reason && adm.reason.startsWith(destState.execution_reason)
								? adm.reason
								: destState.execution_reason
									? `${destState.execution_reason}; ${adm.reason}`
									: adm.reason;
						}
					}
				}
			}
			if (deadFeedbackSource) edgeStates[deadFeedbackSource] = "dead";
			destState.edge_states = edgeStates;
		}
		if (manifest.topology === "graph" && manifest.review_plan && (settledByReview.size > 0 || agents.some(agent => agent.execution === "blocked"))) {
			const isDependencyTimeoutReason = (reason: string | undefined): boolean =>
				!!reason && /^No (?:upstream|useful|predecessor) progress or handoff from /.test(reason);
			let changed = true;
			while (changed) {
				changed = false;
				for (const entry of orderedManifest) {
					const destState = stateByInstance.get(entry.instance_id)!;
					const timedOut = destState.execution === "needs_attention" && !destState.result_status && isDependencyTimeoutReason(destState.execution_reason);
					if (destState.execution !== "pending" && destState.execution !== "waiting" && !timedOut) continue;
					for (const sourceId of inboundEdgesOf(entry)) {
						const srcState = stateByInstance.get(sourceId);
						if (!srcState || srcState.execution !== "blocked") continue;
						if (timedOut) {
							destState.error = undefined;
							const prefix = `${nodeLabel(entry)}: needs attention: `;
							for (let idx = workerErrors.length - 1; idx >= 0; idx--) {
								if (workerErrors[idx].startsWith(prefix)) workerErrors.splice(idx, 1);
							}
						}
						destState.execution = "blocked";
						destState.state = "done";
						destState.execution_reason = srcState.execution_reason ?? `${srcState.node_id} is blocked`;
						destState.execution_causes = srcState.execution_causes.length
							? [...srcState.execution_causes]
							: [{ node_id: srcState.node_id, state: "blocked", reason: srcState.execution_reason ?? "blocked" }];
						if (destState.edge_states) destState.edge_states[srcState.node_id] = "dead";
						settledByReview.add(destState.node_id);
						if (repairStandalone && timedOut && manifest.review_plan) {
							atomicJson(dispositionPath(manifest.session_dir, keyFor(entry)), dispositionRecord({ ...entry, attempt_id: destState.attempt_id, task_id: manifest.task_id }, "blocked", destState.execution_reason, destState.execution_causes, nowIso));
						}
						changed = true;
						break;
					}
				}
			}
		}
		const waitingOn = (id: string) => {
			const source = reviewAttempts.get(id)?.source;
			return source ? [source] : inboundEdgesOf(entryByInstance.get(id)!);
		};
		for (const agent of agents) {
			if (agent.execution === "running" && !agent.cancelling && humanWaits.has(agent.instance_id)) agent.wait_reason = "human";
		}
		for (const agent of agents) {
			if (agent.execution !== "waiting" || agent.ownership_status === "waiting" || agent.parked) continue;
			const upstream = new Set(waitingOn(agent.instance_id));
			if (!upstream.size) continue;
			agent.wait_reason = "dependency";
			for (const id of upstream) {
				const parent = stateByInstance.get(id);
				if (parent?.wait_reason === "human") { agent.wait_reason = "upstream_human"; break; }
				if (parent?.execution === "waiting" || parent?.execution === "pending") {
					for (const predecessor of waitingOn(id)) upstream.add(predecessor);
				}
			}
		}
		const outcome = aggregateRun([...agents.map(agent => unsettledReviews.has(agent.node_id) ? "waiting" as const : agent.execution), ...(failFastInfo.error ? ["needs_attention" as const] : [])]);
		// Exhaustion needs an operator's attention, but leaves no attempt that can still run.
		if (settledAttention > 0 && settledAttention === outcome.counts.needs_attention &&
			!outcome.counts.pending && !outcome.counts.waiting && !outcome.counts.running) outcome.terminal = true;
		const status: RunStatus = {
			manifest, results, pending: pending.filter(node => !settledByReview.has(node) && !settledPending.has(node) && !deadFeedbackMembers.has(node)),
			delivery_errors: deliveryErrors, worker_errors: workerErrors, agents, outcome,
		};
		const cleanupEval = this.evaluateAutomaticCleanup(status);
		if (!cleanupEval.ready && cleanupEval.waitReason) status.cleanup_wait_reason = cleanupEval.waitReason;
		return status;
	}

	/**
	 * Inspect (read-only) or repair the delivery of chain handoffs from saved evidence; see recovery.ts. Repair holds the run lock, so it is serialized with
	 * launch, report and cleanup.
	 */
	/** Factory operation boundary only: redeliver one demonstrably unclaimed handoff of a factory-managed run. The gate rechecks factory authority under the run lock. */
	async retryFactoryDelivery(taskId: string, request: { agent: string; source?: string }, options: RecoveryDeps & { cwd: string }, gate: () => void): Promise<RecoveryReport> {
		if (!this.isFactoryManagedRun(taskId, options.cwd)) throw new Error("Factory redelivery requires a factory-managed run");
		return this.recover(taskId, { action: "retry_delivery", ...request }, options, gate);
	}

	async recover(taskId: string, request: RecoveryRequest, options: RecoveryDeps & { cwd?: string } = {}, factoryGate?: () => void): Promise<RecoveryReport> {
		const select = (manifest: BootstrapManifest): AgentLaunch[] => {
			if (manifest.session_dir_removed) throw new Error("Session files are unavailable; handoff recovery needs them");
			if (manifest.topology !== "chain" && manifest.topology !== "graph") throw new Error("Only a chain or graph has handoffs to recover");
			if (request.agent === undefined) return manifest.pane_manifest;
			const found = selectAgents(manifest.pane_manifest, request.agent);
			if (!found.length) throw new Error(`Unknown agent for this bootstrap run: ${request.agent}`);
			return found;
		};
		if (request.action === "inspect") {
			this.assertSafeManagedFallbackManifest(taskId, options.cwd);
			const manifest = this.observeManifest(this.store.load(taskId, options.cwd, true));
			return inspectRun(manifest, select(manifest));
		}
		if (request.action !== "retry_delivery") throw new Error('action must be "inspect" or "retry_delivery"');
		if (!factoryGate) this.assertDirectRunMutationAllowed(taskId, "bootstrap_recover retry_delivery", options.cwd);
		if (request.agent === undefined) throw new Error("retry_delivery needs agent: the successor node whose inbound handoff to repair");
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const loaded = this.store.load(taskId, options.cwd, true);
			// Factory authority never repairs or resumes the run: it reads it as observed and redelivers only the one handoff.
			const manifest = factoryGate ? this.observeManifest(loaded) : this.reconcile(loaded, true);
			factoryGate?.();
			const recordProblems = new Map<string, string>();
			const edges = chainEdges(manifest, select(manifest), recordProblems);
			if (recordProblems.size) return {
				task_id: taskId, action: "retry_delivery", assessments: [], record_errors: [...recordProblems.values()],
				refused: "Review handoff evidence is unusable. Nothing was sent", next_steps: [],
			};
			if (!edges.length) throw new Error(`${request.agent} has no inbound handoff (it is the first step). To repair delivery from a node, name its successor`);
			if (manifest.review_plan) {
				const matching = edges.filter(({ source }) => request.source === undefined || source.node_id === request.source || source.instance_id === request.source);
				if (!matching.length) {
					const choices = [...new Set(edges.map(e => e.source.node_id))].join(", ");
					throw new Error(`${request.source} is not an inbound edge of ${request.agent}${choices ? ` (choices: ${choices})` : ""}`);
				}
				matching.sort((a, b) => attemptNumber(b.destination.attempt_id) - attemptNumber(a.destination.attempt_id));
				const newestAttempt = attemptNumber(matching[0].destination.attempt_id);
				const atNewest = matching.filter(e => attemptNumber(e.destination.attempt_id) === newestAttempt);
				if (request.source === undefined && inboundEdgesOf(matching[0].destination).length > 1 && newestAttempt === 1) {
					const choices = inboundEdgesOf(matching[0].destination)
						.map(id => manifest.pane_manifest.find(entry => entry.instance_id === id)?.node_id ?? id)
						.join(", ");
					throw new Error(`${request.agent} is a join with multiple inbound edges (${choices}); pass source to name which inbound handoff to repair`);
				}
				if (request.source !== undefined && new Set(atNewest.map(e => e.source.instance_id)).size > 1) {
					throw new Error(`Ambiguous source ${request.source} for ${request.agent}; name an instance_id`);
				}
				const newest = atNewest[0];
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
			const managed = this.isFactoryManagedRun(taskId, cwd);
			let status = managed ? this.status(taskId, cwd) : await this.statusWithCleanup(taskId, cwd);
			const expired = managed ? [] : status.agents.filter(agent => agent.execution === "running" && agent.deadline_exceeded && !agent.cancelling);
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

	private readNodeAttemptCounts(manifest: BootstrapManifest): { counts?: NodeAttemptCount[]; error?: string } {
		if (manifest.version === 1 || manifest.session_dir_removed) return {};
		try {
			const index = readValidatedUpstreamIndex(manifest.session_dir, manifest.task_id, manifest.pane_manifest);
			if (!index) {
				if (manifest.status === "applied" || manifest.status === "cleaned") {
					return { error: "Missing upstream-index.json for released run" };
				}
				return {};
			}
			return { counts: deriveNodeAttemptCountsFromIndex(index, manifest.pane_manifest) };
		} catch (error) {
			return { error: `Unusable upstream-index.json: ${errorMessage(error)}` };
		}
	}

	async report(taskId: string, results: Array<Omit<BootstrapResult, "agent_name"> & { agent_name?: string }> | undefined, markdown: boolean, render: (results: ReportEntry[], nodeCounts?: NodeAttemptCount[], nodeCountsError?: string) => string, cwd?: string): Promise<{ report_json: string; report_md?: string; results: ReportEntry[]; node_counts?: NodeAttemptCount[]; node_counts_error?: string }> {
		this.assertDirectRunMutationAllowed(taskId, "bootstrap_report", cwd);
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			this.reconcile(this.store.load(taskId, cwd, true), true);
			const status = this.status(taskId, cwd);
			if (status.manifest.session_dir_removed) throw new Error(status.manifest.session_files_deleted ? "Session files were explicitly deleted; reports can no longer be written" : "Session files are unavailable (the project directory is missing); reports cannot be written");
			if (!results && (status.pending.length || status.delivery_errors.length || status.worker_errors.length)) throw new Error(`Run is not complete. Pending: ${status.pending.join(", ") || "none"}. Delivery errors: ${status.delivery_errors.join("; ") || "none"}. Worker errors: ${status.worker_errors.join("; ") || "none"}`);
			const nodeCounts = this.readNodeAttemptCounts(status.manifest);
			const collected = this.assembleReportEntries(status, results);
			const json = join(status.manifest.session_dir, "report.json");
			const notice = nodeCounts.error ? { node_counts_error: nodeCounts.error } : {};
			// Preserve the historical array format for reports that could already be saved.
			atomicJson(json, nodeCounts.error ? { results: collected, ...notice } : collected);
			const mdPath = join(status.manifest.session_dir, "report.md");
			// Never leave a Markdown report that disagrees with the new report.json.
			if (markdown) atomicText(mdPath, render(collected, nodeCounts.counts, nodeCounts.error)); else rmSync(mdPath, { force: true });
			return { report_json: json, report_md: markdown ? mdPath : undefined, results: collected, ...(nodeCounts.counts ? { node_counts: nodeCounts.counts } : {}), ...notice };
		});
	}

	/**
	 * Read-only report for a factory-managed run, from authoritative recorded status and results alone. It never takes the run lock,
	 * reconciles or persists anything, writes report files, accepts replacement results, cleans up or delivers; the guarded persisted
	 * `report` stays refused for these runs. Missing, pending or damaged evidence is listed as such and never reported as success:
	 * the run outcome is the one status derives from every node, not a tally of the entries that happen to have results.
	 */
	readOnlyReport(taskId: string, cwd?: string): ReadOnlyReport {
		if (!this.isFactoryManagedRun(taskId, cwd)) {
			throw new Error(`Run "${taskId}" is not factory-managed; use bootstrap_report to persist a standalone report`);
		}
		const status = this.status(taskId, cwd);
		const manifest = status.manifest;
		const results = this.assembleReportEntries(status, undefined, { allowUnreported: true });
		const reported = new Set(results.map(entry => entry.node_id));
		const unreported = manifest.pane_manifest.filter(entry => !reported.has(entry.node_id)).map(entry => {
			const agent = status.agents.find(item => item.node_id === entry.node_id);
			return { node_id: entry.node_id, agent_name: entry.persona_name, execution: agent?.execution ?? "unknown", ...(agent?.execution_reason ? { reason: agent.execution_reason } : {}) };
		});
		const issues: string[] = [];
		if (manifest.status === "error") issues.push(manifest.error ? `Run error: ${manifest.error}` : `Run is in error state (${manifest.phase})`);
		else if (manifest.status !== "applied") issues.push(`Run status is ${manifest.status}/${manifest.phase}, not a released run`);
		if (manifest.session_dir_removed) issues.push(manifest.session_files_deleted ? "Session files were explicitly deleted; recorded results are unavailable" : "Session files are unavailable (the project directory is missing); recorded results are unavailable");
		if (status.pending.length) issues.push(`Pending: ${status.pending.join(", ")}`);
		for (const error of status.delivery_errors) issues.push(`Delivery error: ${error}`);
		for (const error of status.worker_errors) issues.push(`Worker error: ${error}`);
		for (const node of unreported.filter(item => !status.pending.includes(item.node_id))) issues.push(`No recorded result for ${node.node_id} (${node.execution}${node.reason ? `: ${node.reason}` : ""})`);
		const nodeCounts = this.readNodeAttemptCounts(manifest);
		if (nodeCounts.error) issues.push(nodeCounts.error);
		return {
			read_only: true,
			complete: issues.length === 0 && status.outcome.terminal,
			issues,
			run_status: manifest.status,
			phase: manifest.phase,
			outcome: status.outcome,
			agents: status.agents,
			results,
			unreported,
			...(nodeCounts.counts ? { node_counts: nodeCounts.counts } : {}),
			manifest,
		};
	}

	/**
	 * One entry per node, from recorded results (or the explicit ones given) and the records of nodes that never executed, with review-loop
	 * history. Reads only; shared by the persisted report and the read-only managed report. `allowUnreported` leaves nodes that have neither
	 * a result nor a not-executed record out instead of failing, so a read-only report can say they are missing.
	 */
	private assembleReportEntries(status: RunStatus, results: Array<Omit<BootstrapResult, "agent_name"> & { agent_name?: string }> | undefined, options: { allowUnreported?: boolean } = {}): ReportEntry[] {
		const entries = status.manifest.pane_manifest;
		const agentByNode = new Map(status.agents.map(agent => [agent.node_id, agent]));
		const executionByNode = status.manifest.review_plan ? agentByNode : undefined;
		// Nodes that never executed are reported from their records; they have no worker result and cannot be given one.
		const notExecuted = new Map<AgentLaunch, AgentState>();
		status.agents.forEach((agent, index) => { if (!agent.result_status && (NOT_EXECUTED_STATES as readonly string[]).includes(agent.execution)) notExecuted.set(entries[index], agent); });
		const seen = new Set<AgentLaunch>();
		// Explicit results are attributed to a node: by node_id, or by persona name when exactly one node uses that persona.
		const collected: ReportEntry[] = (results ?? status.results).map(result => {
			const entry = resultNode(entries, result);
			if (!entry || seen.has(entry)) throw new Error(`Unknown or duplicate result agent: ${result.node_id ?? result.agent_name}`);
			const skipped = notExecuted.get(entry);
			if (skipped) throw new Error(`Node ${entry.node_id} did not execute (${skipped.execution}); it cannot have a result`);
			seen.add(entry);
			const observed = executionByNode?.get(entry.node_id);
			const observedAgent = agentByNode.get(entry.node_id);
			const undeliveredEdges = observedAgent
				? (observedAgent.handoffs_out ? Object.values(observedAgent.handoffs_out) : observedAgent.handoff_out ? [observedAgent.handoff_out] : [])
					.filter(view => Boolean(view.not_delivered_reason))
					.map(view => ({
						destination: entries.find(item => item.instance_id === view.destination)?.node_id ?? view.destination,
						reason: `not delivered (${view.not_delivered_reason})`,
					}))
				: [];
			const reportedState = executionFromResult(result.status).state;
			const savedState = observed?.result_status ? executionFromResult(observed.result_status).state : reportedState;
			return {
				...result, agent_name: entry.persona_name, node_id: entry.node_id,
				...(entry.kind === "command" ? { kind: "command" as const } : {}),
				execution_state: observed?.execution ?? reportedState,
				...(observed?.execution_reason && observed.execution !== savedState ? { execution_reason: observed.execution_reason } : {}),
				...(observed?.execution_causes.length ? { causes: observed.execution_causes } : {}),
				...(undeliveredEdges.length ? { undelivered_edges: undeliveredEdges } : {}),
			};
		});
		if (!options.allowUnreported && seen.size + notExecuted.size !== entries.length) throw new Error(`Report must include exactly one result for each planned agent${notExecuted.size ? ` that executed (${[...notExecuted.keys()].map(entry => entry.node_id).join(", ")} did not execute and are reported from their records)` : ""}`);
		for (const [entry, agent] of notExecuted) {
			const state = agent.execution as NotExecutedEntry["status"];
			collected.push({
				...(entry.kind === "command" ? { kind: "command" as const } : {}),
				agent_name: entry.persona_name,
				node_id: entry.node_id,
				status: state,
				summary: `Not executed (${state}): ${agent.execution_reason ?? "no reason recorded"}`,
				detail: "",
				execution_state: state,
				causes: agent.execution_causes,
				...(agent.command_evidence ? { command_evidence: agent.command_evidence } : {}),
			});
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
			if (agent.finalized) {
				for (let number = latest + 1; number <= loop.max_revisions + 1; number++) {
					const key = attemptKey(status.manifest.review_plan, entry.instance_id, number);
					if (!existsSync(resultPath(status.manifest.session_dir, key))) continue;
					const attempt = this.reviewAttempt(status.manifest, entry, number, loop);
					if (attempt) attempts.push({ ...attempt, unreviewed: true });
				}
			}
			result.review_history = { version: 1, attempt_limit: loop.max_revisions + 1, attempts, ...(ended ? { ended } : {}) };
		}
		return collected;
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
		if (this.isFactoryManagedRun(taskId, cwd, observed.manifest)) return observed;
		if (!this.evaluateAutomaticCleanup(observed).ready) return observed;
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, cwd), true);
			const status = this.readStatus(manifest);
			if (!this.evaluateAutomaticCleanup(status).ready) return status;

			// A decision already commits the loop. Fill in individual finalizations if its
			// agent exited during publication, before touching any Herdr resources.
			manifest.cleanup_trigger = "auto";
			manifest.cleanup_at ??= new Date(this.now()).toISOString();
			manifest.phase = "auto-cleaning";
			this.store.save(manifest);
			try {
				if (manifest.review_plan) finishReviewFinalizations(manifest.session_dir, taskId, manifest.review_plan, manifest.topology);
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

	/**
	 * Unified delivery-settlement rule for a durable success result:
	 * - Unknown/unsupported delivery states always fail closed.
	 * - Unrouted (`routes.length === 0`): settled when persisted delivery is final (`not_required` or `sent`),
	 *   or when `pending` and the agent has already exited (a still-live agent may still be finishing bookkeeping).
	 * - Routed (`routes.length > 0`): a still-live agent with `pending` or `failed` delivery must not be closed mid-write;
	 *   otherwise every outgoing route must be recorded as delivered or demonstrably claimed/accepted by its successor.
	 */
	private completionDeliverySettled(
		sessionDir: string,
		manifest: BootstrapManifest,
		agent: AgentState,
		completion: WorkerCompletion,
		routes: Array<{ instance: string; attempt: number }>,
		exited: boolean,
	): { settled: boolean; waitReason?: string } {
		const delivery = completion.delivery as string;
		if (routes.length === 0) {
			if (delivery === "not_required" || delivery === "sent") return { settled: true };
			if (delivery === "pending") {
				return exited
					? { settled: true }
					: { settled: false, waitReason: `Automatic cleanup has not run yet: waiting for ${agent.node_id} delivery to settle while its agent is still live.` };
			}
		}
		if (routes.length === 0 || (delivery !== "pending" && delivery !== "sent" && delivery !== "not_required" && delivery !== "failed")) {
			return {
				settled: false,
				waitReason: `Automatic cleanup has not run yet: ${agent.node_id} delivery state is ${JSON.stringify(delivery)}.`,
			};
		}

		if (!exited && (delivery === "pending" || delivery === "failed")) {
			return {
				settled: false,
				waitReason: `Automatic cleanup has not run yet: waiting for ${agent.node_id} delivery (${delivery}) to settle while its agent is still live.`,
			};
		}

		const perEdge = manifest.topology === "graph" || Boolean(manifest.review_plan);
		const unsettledTargets: string[] = [];
		for (const route of routes) {
			const delivered = perEdge
				? completion.edge_deliveries?.[route.instance]?.state === "sent"
				: delivery === "sent";
			if (delivered) continue;

			if (perEdge && completion.identity) {
				if (reviewDeliveryClaimed(sessionDir, completion, [route])) continue;
			} else {
				const claimFile = handoffClaimPath(sessionDir, route.instance);
				if (existsSync(claimFile)) {
					const destEntry = manifest.pane_manifest.find(item => item.instance_id === route.instance);
					let claim;
					try {
						claim = parseHandoffClaim(readJson<unknown>(claimFile), {
							run_id: manifest.task_id,
							source_instance_id: completion.identity?.instance_id ?? agent.instance_id,
							destination: {
								instance_id: route.instance,
								...(destEntry ? { node_id: destEntry.node_id, attempt_id: destEntry.attempt_id } : {}),
							},
						});
					} catch (error) {
						return {
							settled: false,
							waitReason: `Automatic cleanup is blocked: unreadable or mismatched handoff acceptance ${claimFile} (${errorMessage(error)}).`,
						};
					}
					if (completion.identity) {
						if (isLegacyClaim(claim)) {
							return {
								settled: false,
								waitReason: `Automatic cleanup is blocked: handoff acceptance ${claimFile} is missing source attempt ${completion.identity.attempt_id}.`,
							};
						}
						if (claim.source.attempt_id !== completion.identity.attempt_id || claim.source.instance_id !== completion.identity.instance_id) {
							return {
								settled: false,
								waitReason: `Automatic cleanup is blocked: handoff acceptance ${claimFile} names source ${claim.source.attempt_id} instead of ${completion.identity.attempt_id}.`,
							};
						}
						if (claim.input_digest !== inputDigest(completion.result)) {
							return {
								settled: false,
								waitReason: `Automatic cleanup is blocked: handoff acceptance ${claimFile} input digest does not match saved result.`,
							};
						}
					}
					continue;
				}
			}

			const targetNode = manifest.pane_manifest.find(item => item.instance_id === route.instance)?.node_id ?? route.instance;
			unsettledTargets.push(targetNode);
		}
		if (unsettledTargets.length) {
			return {
				settled: false,
				waitReason: `Automatic cleanup has not run yet: ${agent.node_id} handoff to ${unsettledTargets.join(", ")} has not settled; resolve with bootstrap_recover or bootstrap_cleanup.`,
			};
		}
		return { settled: true };
	}

	private evaluateAutomaticCleanup({ manifest, agents, outcome, worker_errors, delivery_errors }: RunStatus): { ready: boolean; waitReason?: string } {
		if (this.isFactoryManagedRun(manifest.task_id, manifest.project_cwd, manifest)) {
			return { ready: false };
		}
		if (manifest.cleanup_policy?.mode !== "on_success" || manifest.status !== "applied" || manifest.session_dir_removed ||
			manifest.cleanup_errors?.length || !outcome.terminal || outcome.state !== "succeeded" || !agents.length) {
			return { ready: false };
		}
		if (worker_errors.length) return { ready: false, waitReason: "Automatic cleanup has not run: agent errors have not settled; resolve with bootstrap_recover or bootstrap_cleanup." };
		if (delivery_errors.length) return { ready: false, waitReason: "Automatic cleanup has not run: delivery errors have not settled; resolve with bootstrap_recover or bootstrap_cleanup." };

		const { task_id, session_dir } = manifest;
		if (existsSync(join(session_dir, "abort.json")) || readFailFast(session_dir, task_id, manifest.token).record) {
			return { ready: false, waitReason: "Automatic cleanup is blocked by an abort or fail-fast record." };
		}
		const runCancelRequested = existsSync(runCancelPath(session_dir));

		const now = this.now();
		const settleMs = manifest.cleanup_policy.settle_ms;
		let latestCompletedAt = -Infinity;
		const loopCancelRequestedAt: number[] = [];
		let settleWindowPending = false;

		for (let index = 0; index < manifest.pane_manifest.length; index++) {
			const entry = manifest.pane_manifest[index];
			const agent = agents[index];
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			if (agent.execution !== "succeeded" || agent.parked || agent.error || (loop && !agent.finalized)) {
				return {
					ready: false,
					waitReason: agent.parked || (loop && !agent.finalized)
						? `Automatic cleanup has not run yet: waiting for review loop on ${agent.node_id} to finalize.`
						: `Automatic cleanup has not run yet: ${agent.node_id} is not settled.`,
				};
			}
			if (!/^a[0-9]+-[a-z0-9-]+$/.test(entry.instance_id) || entry.label !== `${task_id}:${entry.instance_id}`) {
				return { ready: false };
			}
			try {
				const cancelInfo = readCancelRecordSafe(session_dir, this.cancelIdentity(manifest, entry));
				if (cancelInfo.error) return { ready: false };
				const attempt = attemptNumber(agent.attempt_id);
				const key = attemptKey(manifest.review_plan, entry.instance_id, attempt);
				const { claim, error } = readOutcomeClaimSafe(session_dir, this.cancelIdentity(manifest, entry, agent.attempt_id), key);
				if (error || claim?.outcome === "cancelled" || ((runCancelRequested || cancelInfo.record) && claim?.outcome !== "completed")) {
					return { ready: false, waitReason: `Automatic cleanup is blocked by cancellation state on ${agent.node_id}.` };
				}
				const completion = parseCompletion(readJson<unknown>(resultPath(session_dir, key)), {
					...expectationFor(manifest, entry), attempt_id: agent.attempt_id,
				});
				if (completion.result.status !== "success" || existsSync(dispositionPath(session_dir, key))) return { ready: false };
				const ready = parseWorkerReady(readJson<unknown>(readyPath(session_dir, entry.instance_id)));
				const exited = (ready.task_id === task_id && ready.token === manifest.token && ready.instance_id === entry.instance_id && !processAlive(ready))
					|| entry.status === "closed";
				const completedAt = Date.parse(completion.completed_at);
				if (Number.isFinite(completedAt)) latestCompletedAt = Math.max(latestCompletedAt, completedAt);
				if (cancelInfo.record && loop && (!cancelInfo.record.identity.attempt_id || cancelInfo.record.identity.attempt_id === agent.attempt_id)) {
					const requestedAt = Date.parse(cancelInfo.record.requested_at);
					if (!Number.isFinite(requestedAt)) return { ready: false };
					loopCancelRequestedAt.push(requestedAt);
				}

				const outbound = outboundEdgesOf(manifest.pane_manifest, entry.instance_id);
				const routes = manifest.review_plan && completion.identity
					? reviewRoutes(session_dir, completion.identity, manifest.review_plan, completion.result, outbound)
					: outbound.map(instance => ({ instance, attempt: 1 }));
				if (loop?.reviewer === entry.instance_id && reviewVerdict(loop, completion.result) !== "approve") return { ready: false };

				const delivery = this.completionDeliverySettled(session_dir, manifest, agent, completion, routes, exited);
				if (!delivery.settled) return { ready: false, waitReason: delivery.waitReason };

				if (!exited && (!Number.isFinite(completedAt) || now - completedAt < settleMs)) {
					settleWindowPending = true;
				}
			} catch {
				return { ready: false };
			}
		}
		if (settleWindowPending) {
			return {
				ready: false,
				waitReason: "Automatic cleanup has not run yet: within the cleanup settle window (cleanup_settle_ms).",
			};
		}
		if (!loopCancelRequestedAt.every(requestedAt => Number.isFinite(latestCompletedAt) && requestedAt >= latestCompletedAt)) {
			return { ready: false };
		}
		return { ready: true };
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
							const reviewLoop = reviewLoopFor(manifest.review_plan, pred.instance_id);
							const cancelledDisp = reviewLoop && this.readCancelledRejection(manifest, pred, reviewLoop, predRecord.attempt_id, comp.result);
							if (cancelledDisp) {
								predExec = cancelledDisp;
							} else if (reviewLoop && reviewLoop.reviewer === pred.instance_id && !reviewLoop.members.includes(entry.instance_id)) {
								const finalization = readFinalization(manifest.session_dir, manifest.task_id, reviewLoop, pred.instance_id, manifest.topology);
								if (!finalization) {
									const verdict = reviewVerdict(reviewLoop, comp.result);
									if (verdict === "reject") continue;
								}
								const baseExec = { ...executionFromResult(comp.result.status), reason: comp.result.summary };
								const closedEdge = blockedReviewForwardEdge(reviewLoop, finalization, pred.node_id, baseExec, comp.result);
								if (closedEdge) {
									reasons.push(closedEdge.reason);
									for (const cause of closedEdge.causes) {
										const causeKey = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`;
										if (!seenCause.has(causeKey)) { seenCause.add(causeKey); causes.push(cause); }
									}
									continue;
								}
								predExec = baseExec;
							} else {
								predExec = { ...executionFromResult(comp.result.status), reason: comp.result.summary };
							}
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
					if (manifest.review_plan) {
						const wrote = publishExclusive(path, JSON.stringify(record, null, 2) + "\n");
						if (wrote) {
							changed = true;
							if (loop) {
								try {
									settleReviewFailure({
										...entry, attempt_id, task_id: manifest.task_id,
										session_dir: manifest.session_dir, review_plan: manifest.review_plan, roster: manifest.pane_manifest, factory_managed: manifest.factory_managed,
									}, { state: "blocked", causes, reason: reasons.join("; ") });
								} catch (error) {
									problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
								}
							}
						}
					} else {
						atomicJson(path, record);
						changed = true;
					}
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
				releaseOwnershipRecord(manifest, entry, nowIso);
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
					try {
						const finalization = readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
						finalizedLoop = !!finalization;
						if (finalization?.finalized_by === "dispatcher" && existsSync(dispositionPath(manifest.session_dir, key))) {
							const { result } = parseCompletion(readJson<unknown>(resultPath(manifest.session_dir, key)), expected);
							finalizedLoop = !this.readCancelledRejection(manifest, entry, loop, key, result, finalization);
						}
					} catch (error) {
						problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
						finalizedLoop = false;
					}
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

	private readCancelledRejection(
		manifest: BootstrapManifest, entry: AgentLaunch, loop: ReviewLoop, attemptId: string, result: BootstrapResult,
		finalization?: ReturnType<typeof readFinalization>,
	): Disposition | undefined {
		if (entry.instance_id !== loop.reviewer) return;
		const file = dispositionPath(manifest.session_dir, attemptId);
		if (!existsSync(file)) return;
		finalization ??= readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
		if (finalization?.finalized_by !== "dispatcher" || finalization.attempt_id !== attemptId || reviewVerdict(loop, result) !== "reject") return;
		const disposition = parseDisposition(readJson<unknown>(file), { ...expectationFor(manifest, entry), attempt_id: attemptId });
		if (disposition.state === "cancelled") return disposition;
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
			if (disposition.state !== "cancelled" || existsSync(resultPath(manifest.session_dir, attempt.key))) return;
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
					finalizeReview(manifest.session_dir, manifest.task_id, loop, maxAttempt, undefined, "dispatcher", { force: true });
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
		/** Factory-managed cancellation: only the worker's own record proves a node stopped, so the dispatcher never writes a cancelled disposition for it. */
		workerAcknowledgesOnly?: boolean;
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

		const persistCancel = (entry: AgentLaunch, attemptId?: string) => writeCancelRecord(manifest.session_dir, {
			identity: this.cancelIdentity(manifest, entry, attemptId), scope, reason, requestedAt: nowIso, graceMs,
		});

		const claimCancelledNextAttempt = (entry: AgentLaunch, nextAttempt: number, loop: ReviewLoop): boolean => {
			if (nextAttempt > loop.max_revisions + 1) return false;
			const key = attemptKey(manifest.review_plan, entry.instance_id, nextAttempt);
			const identity = this.cancelIdentity(manifest, entry, key);
			// Publish the reason before the claim so a worker observing the claim can recover it.
			// The current result may still win approval. Scope the intent to the future attempt.
			const existing = readCancelRecordSafe(manifest.session_dir, this.cancelIdentity(manifest, entry));
			if (existing.error) throw new Error(existing.error);
			if (!existing.record) persistCancel(entry, key);
			return claimOutcome(manifest.session_dir, identity, "cancelled", nowIso, key).won;
		};

		// Resolve saved decisions before other members in a whole-run cancel. A parked
		// member's old result must not turn the same saved decision into a cancellation.
		const savedReviewers = scope === "run" ? selected.filter(entry => {
			const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
			const attempt = available && loop?.reviewer === entry.instance_id && this.readAttemptForCancel(manifest, entry, problems);
			return attempt && existsSync(resultPath(manifest.session_dir, attempt.key));
		}) : [];
		const savedReviewerIds = new Set(savedReviewers.map(entry => entry.instance_id));
		for (const entry of [...savedReviewers, ...selected.filter(entry => !savedReviewerIds.has(entry.instance_id))]) {
			const attempt = this.readAttemptForCancel(manifest, entry, problems);
			if (!attempt) continue;
			const { key, attempt_id, current, expected } = attempt;
			if (available && existsSync(resultPath(manifest.session_dir, key))) {
				let completedResult: BootstrapResult | undefined;
				try {
					completedResult = parseCompletion(readJson<unknown>(resultPath(manifest.session_dir, key)), expected).result;
				} catch { /* unusable result file does not block cancellation */ }
				if (completedResult) {
					const loop = reviewLoopFor(manifest.review_plan, entry.instance_id);
					if (!loop) {
						already_completed.push(entry.node_id);
						continue;
					}
					try {
						const finalization = readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
						if (finalization) {
							if (this.readCancelledRejection(manifest, entry, loop, attempt_id, completedResult, finalization)) {
								already_settled.push(entry.node_id);
								if (forceClose && entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
							} else {
								already_completed.push(entry.node_id);
							}
							continue;
						}
					} catch (error) {
						problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
						continue;
					}
					// Parked loop member: stop future revisions and settle any already-reserved next attempt.
					const number = current?.number ?? 1;
					const nextAttempt = number + 1;
					let reservedNext = revisionReserved(manifest.session_dir, manifest.task_id, loop, nextAttempt);
					if (entry.instance_id === loop.reviewer && reviewVerdict(loop, completedResult) !== "reject") {
						finalizeReview(manifest.session_dir, manifest.task_id, loop, number, undefined, "dispatcher");
						already_completed.push(entry.node_id);
						continue;
					}
					const target = entry.instance_id === loop.reviewer
						? manifest.pane_manifest.find(member => member.instance_id === loop.target) : undefined;
					const targetAttempt = target && this.readAttemptForCancel(manifest, target, problems);
					if (target && targetAttempt?.current?.number === number &&
						(nextAttempt > loop.max_revisions + 1 || claimCancelledNextAttempt(target, nextAttempt, loop))) {
						const record = persistCancel(entry);
						const disposition = dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", record.reason, [], nowIso);
						publishExclusive(dispositionPath(manifest.session_dir, key), JSON.stringify(disposition, null, 2) + "\n");
						finalizeReview(manifest.session_dir, manifest.task_id, loop, number, undefined, "dispatcher", { force: true });
						const decision = readFinalization(manifest.session_dir, manifest.task_id, loop, entry.instance_id);
						if (decision?.finalized_by === "dispatcher" && decision.attempt_id === key) {
							cancelledOrCancellingInstances.add(entry.instance_id);
							if (forceClose && entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
							cancelled.push(entry.node_id);
							continue;
						}
						// An admitted revision can win while the cancellation is being published.
						reservedNext = revisionReserved(manifest.session_dir, manifest.task_id, loop, nextAttempt);
						if (decision || !reservedNext) {
							already_completed.push(entry.node_id);
							continue;
						}
					}
					if (reservedNext) {
						const nextKey = attemptKey(manifest.review_plan, entry.instance_id, nextAttempt);
						const arbitration = claimOutcome(manifest.session_dir, this.cancelIdentity(manifest, entry, nextKey), "cancelled", nowIso, nextKey);
						if (!arbitration.won) {
							already_completed.push(entry.node_id);
							continue;
						}
						const cancelRecord = persistCancel(entry);
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
					if (entry.instance_id === loop.reviewer) {
						already_completed.push(entry.node_id);
						continue;
					}
					// Arbitrate downstream loop members before persisting cancel intent or signalling.
					const selfIdx = loop.members.indexOf(entry.instance_id);
					let reviewerWon = false;
					let reviewerVerdict: ReturnType<typeof reviewVerdict>;
					for (const memberId of loop.members.slice(selfIdx + 1)) {
						const member = manifest.pane_manifest.find(e => e.instance_id === memberId);
						if (!member) continue;
						const memberKey = attemptKey(manifest.review_plan, memberId, number);
						if (existsSync(resultPath(manifest.session_dir, memberKey))) {
							if (memberId === loop.reviewer) {
								reviewerWon = true;
								const saved = parseCompletion(readJson<unknown>(resultPath(manifest.session_dir, memberKey)), {
									...expectationFor(manifest, member), attempt_id: memberKey,
								});
								reviewerVerdict = reviewVerdict(loop, saved.result);
							}
							continue;
						}
						const memberArb = claimOutcome(manifest.session_dir, this.cancelIdentity(manifest, member, memberKey), "cancelled", nowIso, memberKey);
						if (!memberArb.won && memberId === loop.reviewer) reviewerWon = true;
					}
					if (reviewerWon) {
						if (reviewerVerdict !== "approve" && !savedReviewerIds.has(loop.reviewer) &&
							claimCancelledNextAttempt(entry, nextAttempt, loop)) cancelled.push(entry.node_id);
						else already_completed.push(entry.node_id);
						continue;
					}
					const cancelRecord = persistCancel(entry);
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
					catch (error) {
						problems.set(entry.instance_id, `${nodeLabel(entry)}: ${errorMessage(error)}`);
						continue;
					}
				}
				if (finalizedLoop) {
					try { rmSync(cancelPath(manifest.session_dir, entry.instance_id), { force: true }); } catch { /* best effort */ }
				} else if (loop && claimCancelledNextAttempt(entry, (current?.number ?? 1) + 1, loop)) {
					cancelled.push(entry.node_id);
					continue;
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
				if (entry.kind === "command") {
					try {
						const ready = parseWorkerReady(readJson<unknown>(readyPath(manifest.session_dir, entry.instance_id)));
						if (ready.task_id === manifest.task_id && ready.token === manifest.token && processAlive(ready)) {
							try { process.kill(-ready.pid, "SIGKILL"); } catch { /* exited */ }
						}
					} catch { /* no readable ready record */ }
				}
				if (entry.status !== "closed" && entry.status !== "planned") forceCloseTargets.push(entry);
				if (!existingDisposition && !existsSync(resultPath(manifest.session_dir, key))) {
					const forceReason = (working || existsSync(handoffClaimPath(manifest.session_dir, key, manifest.review_plan ? current?.source : undefined)))
						? `${cancelRecord.reason} (force-closed after grace period; any in-flight tool side effects could not be undone)`
						: `${cancelRecord.reason} (force-closed after grace period)`;
					atomicJson(dispFile, dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", forceReason, [], nowIso));
					releaseOwnershipRecord(manifest, entry, nowIso);
					cancelled.push(entry.node_id);
				} else if (existingDisposition?.state === "cancelled") {
					already_settled.push(entry.node_id);
				}
				continue;
			}

			if (working || (params.workerAcknowledgesOnly && !existingDisposition)) {
				const remaining = graceRemainingMs(cancelRecord, nowMs);
				cancelling.push({
					node_id: entry.node_id,
					instance_id: entry.instance_id,
					grace_remaining_ms: remaining,
					force_close_allowed: params.workerAcknowledgesOnly ? false : remaining === 0,
					note: params.workerAcknowledgesOnly
						? "Waiting for the worker to acknowledge cancellation. Force-close is refused for factory runs; if it never does, the hold needs operator clearance."
						: "In-progress tool or model turn cannot be interrupted or undone by hooks; waiting to settle or force_close after grace period.",
				});
			} else {
				if (!existingDisposition) {
					atomicJson(dispFile, dispositionRecord({ ...entry, attempt_id, task_id: manifest.task_id }, "cancelled", cancelRecord.reason, [], nowIso));
					releaseOwnershipRecord(manifest, entry, nowIso);
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
		this.assertDirectRunMutationAllowed(taskId, "bootstrap_cancel", options.cwd);
		return this.cancelRun(taskId, options);
	}

	/** Factory operation boundary only: the gate commits intent under the current manager's transaction. */
	async cancelFactoryRun(taskId: string, gate: (manifest: BootstrapManifest, writeIntent: () => void) => void, cwd: string): Promise<CancelResult> {
		return this.cancelRun(taskId, { cwd }, gate);
	}

	private async cancelRun(taskId: string, options: CancelOptions, factoryGate?: (manifest: BootstrapManifest, writeIntent: () => void) => void): Promise<CancelResult> {
		if (factoryGate && !this.isFactoryManagedRun(taskId, options.cwd)) throw new Error("Factory cancellation requires a factory-managed run");
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
		if (!factoryGate && initial.status === "launching" && !initial.session_dir_removed && lockHeld(join(this.store.indexRoot, taskId))) {
			this.persistPreReleaseCancel(initial, reason, scope, selectedInitial, initialNowIso, initialGraceMs, false, problems);
		}

		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const loaded = this.store.load(taskId, options.cwd, true);
			const manifest = factoryGate ? this.observeManifest(loaded) : this.reconcile(loaded, true);
			const selected = this.resolveSelectedAgents(manifest, options.agents);
			const graceMs = options.grace_ms ?? manifest.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS;
			const nowMs = this.now();
			const nowIso = new Date(nowMs).toISOString();
			const available = !manifest.session_dir_removed;
			const released = available && existsSync(join(manifest.session_dir, "release.json"));

			if (options.force_close) {
				this.validateForceCloseGrace(manifest, selected, available, nowMs, problems);
			}
			if (factoryGate) {
				if (!available || !released || manifest.status !== "applied") throw new Error("Factory cancellation requires verified released work and retained session evidence");
				factoryGate(manifest, () => {
					writeRunCancelRecord(manifest.session_dir, { run_id: taskId, reason, requestedAt: nowIso, graceMs });
					// The intent is acknowledged to the operator, so it must be crash-durable: flush the file and its directory entry.
					for (const target of [runCancelPath(manifest.session_dir), manifest.session_dir]) {
						const fd = openSync(target, "r");
						try { fsyncSync(fd); } finally { closeSync(fd); }
					}
				});
			}
			if (available && scope === "run" && !options.force_close) {
				if (!factoryGate) writeRunCancelRecord(manifest.session_dir, { run_id: taskId, reason, requestedAt: nowIso, graceMs });
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
			} = await this.cancelEntries({ manifest, selected, scope, reason, nowMs, nowIso, graceMs, available, released, forceClose: !!options.force_close, workerAcknowledgesOnly: !!factoryGate, problems });

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
		this.assertDirectRunMutationAllowed(taskId, "bootstrap_cleanup", cwd);
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, cwd, true), true);
			if (manifest.status === "cleaned" && (!deleteSessionFiles || manifest.session_dir_removed)) return manifest;
			const selected = this.resolveSelectedAgents(manifest, agentNames, tabIds);
			const subset = tabIds !== undefined || agentNames !== undefined;
			if (!subset && manifest.review_plan && !manifest.session_dir_removed) {
				try { finishReviewFinalizations(manifest.session_dir, taskId, manifest.review_plan, manifest.topology); }
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
			topology: manifest.topology,
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

function settleDeadLoopMember(manifest: BootstrapManifest, loop: ReviewLoop, entry: AgentLaunch, attempt: number, author: string, nowIso: string): boolean {
	if (manifest.session_dir_removed) return false;
	const latest = currentAttempt(manifest, entry)?.number ?? attempt;
	if (latest > attempt) return false;
	if (readLoopTransition(manifest.session_dir, manifest.task_id, entry.instance_id, attempt)?.winner === "revision") return false;
	if (attemptClaimedOrStarted(manifest.session_dir, entry.instance_id, attempt + 1)) return false;
	if (entry.instance_id !== loop.reviewer) {
		if (!finalizeMemberAfterDecision(manifest.session_dir, manifest.task_id, loop, entry.instance_id, attempt, author)) return false;
	}
	releaseOwnershipRecord(manifest, entry, nowIso, true);
	return true;
}

function releaseOwnershipRecord(manifest: BootstrapManifest, entry: AgentLaunch, nowIso: string, allowRoot = false): void {
	if (!allowRoot && !entry.predecessor) return;
	const ownFile = ownershipPath(manifest.session_dir, entry.instance_id);
	if (!existsSync(ownFile)) return;
	try {
		const existing = parseOwnershipRecord(readJson<unknown>(ownFile), expectationFor(manifest, entry));
		if (existing.state === "released") return;
		atomicJson(ownFile, ownershipRecord({
			identity: { run_id: manifest.task_id, node_id: entry.node_id, persona_name: entry.persona_name, attempt_id: existing.identity.attempt_id, instance_id: entry.instance_id },
			state: "released",
			write_paths: existing.write_paths,
			read_paths: existing.read_paths,
			waiting_for: existing.waiting_for,
			startup_seen: false,
			admitted_at: existing.admitted_at,
			released_at: nowIso,
			updated_at: nowIso,
		}));
	} catch { /* retain unusable or foreign ownership record */ }
}

/** Instance ids whose ready record is readable and whose process is alive, found without reading the run manifest. */
function liveWorkersIn(sessionDir: string): string[] {
	let names: string[];
	try { names = readdirSync(sessionDir); } catch { return []; }
	const live: string[] = [];
	for (const name of names.filter(item => item.endsWith(".ready.json"))) {
		try { if (processAlive(parseWorkerReady(readJson<unknown>(join(sessionDir, name))))) live.push(name.slice(0, -".ready.json".length)); } catch { /* unreadable ready record: liveness unknown, not risk */ }
	}
	return live;
}
