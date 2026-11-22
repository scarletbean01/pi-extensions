/** Durable bootstrap state. Project files are indexed independently of the dispatcher's cwd. */
import type { InterventionPolicy } from "./intervention.ts";
import { parseReviewPlan, type ReviewPlan } from "./review-plan.ts";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
	COLLABORATION_MODES, DEPENDENCY_POLICIES, DISPOSITION_STATES, FAILURE_POLICIES, JOIN_POLICIES, WORKSPACE_STRATEGY,
	type CauseRef, type DependencyPolicy, type DispositionState, type ExecutionState, type FailurePolicy, type JoinPolicy, type ResolvedCollaborationMode, type WorkspaceStrategy,
} from "./outcomes.ts";
import type { ArtifactMetadata, OutputContract, RosterEntry, VerificationSummary } from "./contracts.ts";

/**
 * Identities (see the bootstrap README): the run is the public `task_id`; a node is one planned assignment;
 * the persona is the reusable configuration it runs; an attempt is one execution of a node; the worker instance
 * is the live process/Coms identity (`instance_id`, with the session recorded in its ready file).
 */
export const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
/** Persisted-format versions. Version 1 is the original persona-keyed format; chain/team records use version 2; fan-out graph records use version 3; join graph records use version 4; chain review records use version 5; graph review records use version 6. */
export const CURRENT_VERSION = 2;
export const GRAPH_VERSION = 3;
export const JOIN_GRAPH_VERSION = 4;
export const REVIEW_VERSION = 5;
export const GRAPH_REVIEW_VERSION = 6;
const READABLE_VERSIONS = [1, 2];

export type NodeKind = "agent" | "command";

/** Deterministic execution evidence persisted by command nodes on completion or cancellation. */
export interface CommandEvidence {
	version: 1;
	command: string;
	args: string[];
	working_directory: string;
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	spawn_error?: string;
	process_group_id?: number;
	process_group_killed?: boolean;
	stdout_bytes: number;
	stderr_bytes: number;
	stdout_excerpt?: string;
	stderr_excerpt?: string;
}

export interface BootstrapResult {
	/** Persona that produced the result (several nodes may share one). */
	agent_name: string;
	/** The assignment this result belongs to. Absent on results written before node identities existed. */
	node_id?: string;
	status: "success" | "partial" | "failure";
	summary: string;
	detail: string;
	artifacts?: ArtifactMetadata[];
	outputs?: Record<string, unknown>;
	verification?: VerificationSummary[];
	metrics?: Record<string, number>;
	warnings?: string[];
	next_steps?: string[];
	command_evidence?: CommandEvidence;
}

/**
 * A report entry for a node that did not execute. It has no worker result and never claims success: its `status` is the not-executed
 * execution state itself, `summary` says why, and `causes` references the nodes (and evidence) responsible.
 */
export interface NotExecutedEntry {
	agent_name: string;
	node_id: string;
	status: "blocked" | "skipped" | "cancelled";
	summary: string;
	detail: string;
	execution_state: "blocked" | "skipped" | "cancelled";
	causes: CauseRef[];
	command_evidence?: CommandEvidence;
}
/** One node's line in a report: its worker's result (with the execution state it amounts to), or the record that it did not execute. */
export type ReportEntry = ((BootstrapResult & { execution_state?: ExecutionState; execution_reason?: string; causes?: CauseRef[] }) | NotExecutedEntry) & {
	kind?: NodeKind;
	review_history?: ReportReviewHistory;
	undelivered_edges?: Array<{ destination: string; reason: string }>;
};

export interface ReportReviewHistory {
	version: 1;
	attempt_limit: number;
	attempts: Array<{ number: number; state: ExecutionState; summary: string; verdict?: string; unreviewed?: boolean }>;
	/** Present on the decision node once the loop settles. */
	ended?: string;
}

/**
 * One planned node's launch record, in the normalized in-memory form. Version 1 files stored the persona as
 * `agent_name` and had no separate node or attempt; they are normalized on read (`node_id` = persona name) and
 * written back unchanged in the version 1 form, never rewritten into version 2.
 */
export interface AgentLaunch {
	kind?: NodeKind;
	command?: string;
	args?: string[];
	working_directory?: string;
	node_id: string;
	persona_name: string;
	/** One execution of the node. Absent for version 1 runs, which predate attempts. */
	attempt_id?: string;
	instance_id: string;
	expected_coms_name: string;
	expected_model: string;
	label: string;
	step?: number;
	predecessor?: string;
	successor?: string;
	/** Inbound source instance IDs (set for graph topology). */
	inbound_edges?: string[];
	tab_id?: string;
	pane_id?: string;
	terminal_id?: string;
	status: "planned" | "creating" | "tab_created" | "launch_submitted" | "ready" | "released" | "closed";
	error?: string;
	/**
	 * How this node's dependency on its predecessor treats the predecessor's outcome (chain followers only). Absent on records written
	 * before policies existed, which ran under `allow_partial`: read it through `dependencyPolicyOf`.
	 */
	dependency_policy?: DependencyPolicy;
	/** How a join node combines its inbound edges (`all_success` or `allow_partial`). */
	join_policy?: JoinPolicy;
	/**
	 * Verification checks this node must pass (its `required_checks` and its output contract's): they are also what a dependent needs to
	 * find passing and current when it is admitted. Recorded so status can show their evidence.
	 */
	required_checks?: string[];
	/** Running-task duration deadline in ms once admitted/started. Absent unless configured. */
	task_timeout_ms?: number;
	/** Dependency-wait timeout in ms without useful upstream progress (chain followers only). */
	dependency_wait_timeout_ms?: number;
	/** Declared read-only paths within project_cwd. */
	read_paths?: string[];
	/** Declared writable paths within project_cwd (advisory shared-cwd ownership). */
	write_paths?: string[];
	/** Earlier conflicting writers (instance_ids) this node waits for in deterministic plan order. */
	ownership_wait_for?: string[];
}

export type CleanupMode = "on_success" | "manual";
export const DEFAULT_CLEANUP_SETTLE_MS = 3000;
export const MAX_CLEANUP_SETTLE_MS = 86_400_000;

interface CleanupPolicy {
	version: 1;
	mode: CleanupMode;
	settle_ms: number;
}

export const cleanupPolicyPath = (dir: string): string => join(dir, "cleanup-policy.json");

export interface FactoryManagedInfo {
	version: 1;
	factory_id: string;
	factory_name: string;
	input_id: string;
	attempt_id: string;
	request_id: string;
	bound_version: string;
	canonical_checkout: string;
	checkout_key: string;
	state_db_path: string;
	coord_db_path: string;
}

export interface BootstrapManifest {
	/** Factory association metadata when launched by a software factory. Absent on standalone runs. */
	factory_managed?: FactoryManagedInfo;
	/** Versioned independently of node, graph and review records. Absent in runs launched before this policy existed. */
	cleanup_policy?: CleanupPolicy;
	cleanup_trigger?: "auto";
	cleanup_at?: string;
	version: 1 | 2 | 3 | 4 | 5;
	review_plan?: ReviewPlan;
	/** Whether the launch request used the legacy name/sub_task form or explicit nodes. Version 2+ only. */
	request_form?: "legacy" | "nodes";
	/** Collaboration mode governing peer Coms activation. Absent on pre-09 records (read as "legacy"). */
	collaboration_mode?: ResolvedCollaborationMode;
	/** How other members behave when one member fails. Absent on pre-09 records (read as "independent"). */
	failure_policy?: FailurePolicy;
	/** Workspace strategy used for this run ("shared_cwd" by default). */
	workspace_strategy?: WorkspaceStrategy;
	task_id: string;
	task: string;
	topology: "chain" | "team" | "graph";
	project_cwd: string;
	session_dir: string;
	workspace_id: string;
	coms_project: string;
	dispatcher_coms_name?: string;
	dispatcher_session_id?: string;
	status: "launching" | "applied" | "error" | "cleaned";
	phase: string;
	created_at: string;
	updated_at: string;
	token: string;
	pane_manifest: AgentLaunch[];
	error?: string;
	cleanup_errors?: string[];
	/** Cleanup found no live tab/pane for these agents and treated them as already closed. */
	cleanup_notes?: string[];
	/** Session files are unavailable (deleted or missing); no further project writes are attempted. */
	session_dir_removed?: boolean;
	/** Session files were deleted by an explicit delete_session_files cleanup. */
	session_files_deleted?: boolean;
	/** The launch was found interrupted (its launcher died) and the manifest was reconciled from durable markers. */
	reconciled?: boolean;
	/** Configurable run-level deadlines and grace period (additive; omitted when using defaults/legacy). */
	task_timeout_ms?: number;
	dependency_wait_timeout_ms?: number;
	liveness_timeout_ms?: number;
	cancel_grace_ms?: number;
}

/** Normalized worker configuration. Version 1 files (no `version`) carried `agent_name` and are normalized on read. */
export interface WorkerConfig {
	kind?: NodeKind;
	command?: string;
	args?: string[];
	working_directory?: string;
	factory_managed?: FactoryManagedInfo;
	/** Set only for a factory-managed node its definition opted in to ask a human for direction. */
	intervention?: InterventionPolicy;
	submitted_brief?: string;
	version?: 1 | 2 | 3 | 4 | 5;
	review_plan?: ReviewPlan;
	/** Source attempt for the active inbound handoff. Derived locally from the review plan. */
	predecessor_attempt?: number;
	/** The run ID. */
	task_id: string;
	token: string;
	session_dir: string;
	project_cwd: string;
	coms_dir: string;
	coms_project: string;
	/** Worker instance and Coms identity. */
	instance_id: string;
	node_id: string;
	persona_name: string;
	attempt_id?: string;
	/** The persona's system prompt snapshot. */
	persona: string;
	expected_model?: string;
	tools: string[];
	sub_task: string;
	topology: "chain" | "team" | "graph";
	step?: number;
	predecessor?: string;
	successor?: string;
	inbound_edges?: string[];
	outbound_edges?: string[];
	dependency_policy?: DependencyPolicy;
	/** How a join node combines its inbound edges (`all_success` or `allow_partial`). */
	join_policy?: JoinPolicy;
	/**
	 * Durable handoff protocol this worker speaks (see handoff.ts): the source records an offer bound to the input digest, the destination
	 * validates it and claims the handoff before model work. Absent in configurations written before it existed and for version 1 workers,
	 * which keep the original notification and receipt behavior.
	 */
	handoff_protocol?: 1;
	startup_message: string;
	ready_timeout_ms: number;
	task_timeout_ms?: number;
	dependency_wait_timeout_ms?: number;
	liveness_timeout_ms?: number;
	cancel_grace_ms?: number;
	/** The run's overall task, so each agent understands how its sub-task fits. */
	task?: string;
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	role?: string;
	ownership?: string[];
	read_paths?: string[];
	write_paths?: string[];
	ownership_wait_for?: string[];
	collaboration_mode?: ResolvedCollaborationMode;
	failure_policy?: FailurePolicy;
	node_acceptance_criteria?: string[];
	node_constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	upstream_contracts?: Record<string, { output_contract?: OutputContract; required_checks?: string[] }>;
	/** Everyone in the run, in plan order (for coordination and orientation only). */
	roster?: RosterEntry[];
}

export const BOOTSTRAP_LAUNCH_COMMAND = "bootstrap-launch";

export function workerStartupMessages(startupMessage: string, hasAllowedSkills: boolean): string[] {
	// Pi awaits CLI messages in order. The command checks discovered skills and the
	// release barrier, then Pi drives the assignment through its own prompt lifecycle.
	return hasAllowedSkills ? [`/${BOOTSTRAP_LAUNCH_COMMAND} ${startupMessage}`, startupMessage] : [startupMessage];
}

export function unknownAllowedSkills(persona: string, names: string[]): string {
	return `Persona ${JSON.stringify(persona)} names skills Pi did not discover: ${names.map(name => JSON.stringify(name)).join(", ")}`;
}

export interface WorkerReady {
	/** Absent on older readiness records. */
	version?: 1 | 2;
	/** Unique to the loaded worker, even on reload within the same Pi process. */
	direction_incarnation?: string;
	task_id: string;
	token: string;
	instance_id: string;
	pid: number;
	session_id: string;
	name: string;
	endpoint: string;
	model: string;
	/** Kernel process start time (Linux /proc), used to detect PID reuse. */
	start_time?: string;
	kept_skills?: string[];
	unmatched_skills?: string[];
}

/** Who a result belongs to; version 2 completions record it so a misplaced or foreign file is detected on read. */
export interface CompletionIdentity { run_id: string; node_id: string; persona_name: string; attempt_id: string; instance_id: string }

export interface EdgeDeliveryState {
	state: "pending" | "sent" | "failed";
	error?: string;
	handoff_id?: string;
	updated_at?: string;
}

export interface WorkerCompletion {
	/** Absent on version 1 records, which carry only the persona-keyed result. */
	version?: 2 | 5;
	review_plan?: ReviewPlan;
	identity?: CompletionIdentity;
	result: BootstrapResult;
	delivery: "pending" | "sent" | "not_required" | "failed";
	delivery_error?: string;
	/** Per-outbound-edge delivery state for fan-out graphs, keyed by destination instance_id. */
	edge_deliveries?: Record<string, EdgeDeliveryState>;
	completed_at: string;
}

export function assertTaskId(id: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)) throw new Error("Invalid bootstrap task_id");
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Safely read a JSON regular file on a symlink-free physical path without following symlinks
 * or blocking on non-regular files such as FIFOs.
 */
export function readRegularJsonNoSymlink<T>(path: string, label = path): T {
	assertNoSymlinkPath(path);
	const lst = lstatSync(path);
	if (lst.isSymbolicLink()) {
		throw new Error(`Refusing symlinked ${label}: ${path}`);
	}
	if (!lst.isFile()) {
		throw new Error(`Refusing non-regular file for ${label}: ${path}`);
	}
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		if (!fstatSync(fd).isFile()) {
			throw new Error(`Refusing non-regular file for ${label}: ${path}`);
		}
		return JSON.parse(readFileSync(fd, "utf8")) as T;
	} finally {
		closeSync(fd);
	}
}

export function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function assertNoSymlinkPath(path: string): void {
	const absolute = resolve(path);
	const components: string[] = [];
	for (let current = absolute; ; current = dirname(current)) {
		components.push(current);
		if (dirname(current) === current) break;
	}
	for (const component of components.reverse()) {
		try {
			if (lstatSync(component).isSymbolicLink()) throw new Error(`Storage path contains a symlink: ${component}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function createDurableDirectoryPath(path: string): void {
	assertNoSymlinkPath(path);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	for (let current = path; ; current = dirname(current)) {
		syncDirectory(current);
		if (dirname(current) === current) break;
		syncDirectory(dirname(current));
	}
}

export function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function atomicJson(path: string, value: unknown, durable = false): void {
	atomicText(path, JSON.stringify(value, null, 2) + "\n", durable);
}

export function atomicText(path: string, text: string, durable = false): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		if (!durable) {
			writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		} else {
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, text, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		renameSync(temporary, path);
		if (durable) syncDirectory(dirname(path));
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Process start time from /proc/<pid>/stat (field 22), or undefined where unavailable. */
export function processStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch { return undefined; }
}

/** Whether the acknowledged worker process is still the same live process (not a reused PID). */
export function processAlive(ready: { pid: number; start_time?: string }): boolean {
	try { process.kill(ready.pid, 0); }
	catch (error: any) {
		if (error?.code === "ESRCH") return false;
		// EPERM: the PID exists but belongs to another user, so it cannot be our worker any more.
		if (error?.code === "EPERM") return false;
		throw error;
	}
	if (!ready.start_time) return true;
	const current = processStartTime(ready.pid);
	return current === undefined || current === ready.start_time;
}

// ---- versioned readers (validation happens at the read boundary) ----

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a non-empty string`);
	return value;
}

export function checkVersion(value: unknown, what: string, absentIsV1: boolean, subject = "", readable: number[] = READABLE_VERSIONS): 1 | 2 | 3 | 4 {
	const version = value === undefined && absentIsV1 ? 1 : value;
	if (typeof version !== "number" || !readable.includes(version)) {
		throw new Error(`Unsupported ${what} version ${JSON.stringify(value)}${subject}: this release reads version${readable.length > 1 ? "s" : ""} ${readable.length === 2 ? readable.join(" and ") : readable.join(", ")}. The record was left untouched; inspect or clean it up with a release that supports it`);
	}
	return version as 1 | 2 | 3 | 4 | 5;
}

/**
 * The policy governing a node's dependency on its predecessor: none for a node without one; otherwise the recorded policy, or
 * `allow_partial` for records written before policies existed (they ran, and are still read, under that behavior).
 */
export function dependencyPolicyOf(node: { dependency_policy?: DependencyPolicy }, hasDependency: boolean): DependencyPolicy | undefined {
	return hasDependency ? node.dependency_policy ?? "allow_partial" : undefined;
}

/** Inbound source instance IDs for a launched node or worker config. */
export function inboundEdgesOf(entry: { predecessor?: string; inbound_edges?: string[] }): string[] {
	return entry.inbound_edges ?? (entry.predecessor ? [entry.predecessor] : []);
}

/** Outbound destination instance IDs for a launched node, derived from inbound edges. */
export function outboundEdgesOf(entries: ReadonlyArray<{ instance_id: string; predecessor?: string; inbound_edges?: string[] }>, sourceInstanceId: string): string[] {
	return entries.filter(other => inboundEdgesOf(other).includes(sourceInstanceId)).map(other => other.instance_id);
}

/**
 * Effective collaboration mode for a manifest or worker config. Records written before independent mode existed
 * carry no `collaboration_mode` and retain `"legacy"` messaging behavior.
 */
export function collaborationModeOf(record: { collaboration_mode?: ResolvedCollaborationMode }): ResolvedCollaborationMode {
	return record.collaboration_mode ?? "legacy";
}

/** Effective failure policy for a manifest or worker config; defaults to `"independent"`. */
export function failurePolicyOf(record: { failure_policy?: FailurePolicy }): FailurePolicy {
	return record.failure_policy ?? "independent";
}

function checkPolicy(raw: Record<string, unknown>): void {
	if (raw.dependency_policy !== undefined && !(DEPENDENCY_POLICIES as readonly unknown[]).includes(raw.dependency_policy)) throw new Error(`dependency_policy must be one of ${DEPENDENCY_POLICIES.join(", ")}`);
	if (raw.join_policy !== undefined && !(JOIN_POLICIES as readonly unknown[]).includes(raw.join_policy)) throw new Error(`join_policy must be one of ${JOIN_POLICIES.join(", ")}`);
	for (const field of ["task_timeout_ms", "dependency_wait_timeout_ms", "liveness_timeout_ms", "cancel_grace_ms"] as const) {
		const value = raw[field];
		if (value !== undefined && (!Number.isInteger(value) || (value as number) < (field === "cancel_grace_ms" ? 0 : 100))) {
			throw new Error(`${field} must be an integer >= ${field === "cancel_grace_ms" ? 0 : 100}`);
		}
	}
}

function checkRunPolicies(raw: Record<string, unknown>): void {
	const allowedModes: readonly unknown[] = [...COLLABORATION_MODES, "legacy"];
	if (raw.collaboration_mode !== undefined && !allowedModes.includes(raw.collaboration_mode)) {
		throw new Error(`collaboration_mode must be ${COLLABORATION_MODES.join(" or ")}`);
	}
	if (raw.failure_policy !== undefined && !(FAILURE_POLICIES as readonly unknown[]).includes(raw.failure_policy)) {
		throw new Error(`failure_policy must be ${FAILURE_POLICIES.join(" or ")}`);
	}
	if (raw.workspace_strategy !== undefined && raw.workspace_strategy !== WORKSPACE_STRATEGY) {
		throw new Error(`Unsupported workspace_strategy ${JSON.stringify(raw.workspace_strategy)}: this release supports "${WORKSPACE_STRATEGY}" only. The record was left untouched`);
	}
}

export function validateCommandString(value: unknown, field = "command"): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty string without NUL characters`);
	}
	return value;
}

export function validateCommandArgs(value: unknown, field = "args"): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
	return value.map((item, idx) => {
		if (typeof item !== "string" || item.includes("\0")) {
			throw new Error(`${field}[${idx}] must be a string without NUL characters`);
		}
		return item;
	});
}

export function formatCommandDisplay(command: string, args: readonly string[] = []): string {
	return args.length ? `Run command: ${command} ${args.join(" ")}` : `Run command: ${command}`;
}

export function resolveCommandWorkingDirectory(projectCwd: string, workingDirectory: unknown, field = "working_directory"): string {
	const canonicalRoot = realpathSync(projectCwd);
	if (workingDirectory === undefined) return canonicalRoot;
	const raw = nonEmpty(workingDirectory, field);
	if (raw.includes("\0")) throw new Error(`${field} cannot contain NUL characters`);
	const candidate = resolve(canonicalRoot, raw);
	let realCandidate: string;
	try {
		if (!statSync(candidate).isDirectory()) throw new Error(`${field} must refer to an existing directory`);
		realCandidate = realpathSync(candidate);
		if (!statSync(realCandidate).isDirectory()) throw new Error(`${field} must refer to an existing directory`);
	} catch (error) {
		throw new Error(`${field}: ${errorMessage(error)}`);
	}
	const inside = realCandidate === canonicalRoot || realCandidate.startsWith(canonicalRoot === "/" ? "/" : `${canonicalRoot}/`);
	if (!inside) {
		throw new Error(`${field} resolves outside project_cwd (${realCandidate})`);
	}
	return realCandidate;
}

export function parseCommandEvidence(
	raw: unknown,
	expected?: { command?: string; args?: string[]; working_directory?: string },
): CommandEvidence {
	if (!isRecord(raw)) throw new Error("malformed command_evidence");
	if (raw.version !== 1) throw new Error(`Unsupported command_evidence version ${JSON.stringify(raw.version)}`);
	const command = validateCommandString(raw.command, "command_evidence.command");
	if (!Array.isArray(raw.args)) throw new Error("command_evidence.args must be an array of strings");
	const args = validateCommandArgs(raw.args, "command_evidence.args");
	const working_directory = nonEmpty(raw.working_directory, "command_evidence.working_directory");
	const exit_code = raw.exit_code === null ? null
		: (typeof raw.exit_code === "number" && Number.isInteger(raw.exit_code) ? raw.exit_code : (() => { throw new Error("command_evidence.exit_code must be null or an integer"); })());
	const signal = raw.signal === null ? null : nonEmpty(raw.signal, "command_evidence.signal");
	const spawn_error = raw.spawn_error === undefined ? undefined : nonEmpty(raw.spawn_error, "command_evidence.spawn_error");
	if (exit_code === null && signal === null && spawn_error === undefined) {
		throw new Error("command_evidence must record exit_code, signal, or spawn_error");
	}
	const started_at = nonEmpty(raw.started_at, "command_evidence.started_at");
	const finished_at = nonEmpty(raw.finished_at, "command_evidence.finished_at");
	if (!Number.isFinite(Date.parse(started_at)) || !Number.isFinite(Date.parse(finished_at))) {
		throw new Error("command_evidence timestamps must be valid ISO dates");
	}
	if (typeof raw.duration_ms !== "number" || !Number.isFinite(raw.duration_ms) || raw.duration_ms < 0) {
		throw new Error("command_evidence.duration_ms must be a non-negative finite number");
	}
	for (const byteField of ["stdout_bytes", "stderr_bytes"] as const) {
		const val = raw[byteField];
		if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
			throw new Error(`command_evidence.${byteField} must be a non-negative integer`);
		}
	}
	if (raw.process_group_id !== undefined && (!Number.isInteger(raw.process_group_id) || (raw.process_group_id as number) <= 0)) {
		throw new Error("command_evidence.process_group_id must be a positive integer");
	}
	if (raw.process_group_killed !== undefined && typeof raw.process_group_killed !== "boolean") {
		throw new Error("command_evidence.process_group_killed must be a boolean");
	}
	for (const excerptField of ["stdout_excerpt", "stderr_excerpt"] as const) {
		if (raw[excerptField] !== undefined && typeof raw[excerptField] !== "string") {
			throw new Error(`command_evidence.${excerptField} must be a string`);
		}
	}
	if (expected) {
		if (expected.command !== undefined && command !== expected.command) {
			throw new Error(`command_evidence command mismatch (${JSON.stringify(command)} !== ${JSON.stringify(expected.command)})`);
		}
		if (expected.args !== undefined && JSON.stringify(args) !== JSON.stringify(expected.args)) {
			throw new Error("command_evidence args mismatch");
		}
		if (expected.working_directory !== undefined && working_directory !== expected.working_directory) {
			throw new Error(`command_evidence working_directory mismatch (${JSON.stringify(working_directory)} !== ${JSON.stringify(expected.working_directory)})`);
		}
	}
	return raw as unknown as CommandEvidence;
}

function checkNodeKindFields(raw: Record<string, unknown>, version: number): void {
	const kind = raw.kind;
	if (kind !== undefined && kind !== "agent" && kind !== "command") {
		throw new Error(`Unsupported node kind ${JSON.stringify(kind)}`);
	}
	if (kind === "command") {
		if (version === 1) throw new Error("Command nodes are not supported in version 1 records");
		validateCommandString(raw.command, "command");
		validateCommandArgs(raw.args, "args");
		if (raw.working_directory !== undefined) nonEmpty(raw.working_directory, "working_directory");
		return;
	}
	for (const field of ["command", "args", "working_directory"] as const) {
		if (raw[field] !== undefined) {
			throw new Error(`Agent node record cannot carry command-only field ${field}`);
		}
	}
}

/** Version 1 stored the persona as `agent_name` and had no node or attempt; version 2+ stores all three explicitly. */
function normalizeIdentity(raw: Record<string, unknown>, version: 1 | 2 | 3 | 4): { node_id: string; persona_name: string; attempt_id?: string } {
	if (version === 1) {
		const persona = nonEmpty(raw.agent_name, "agent_name");
		return { node_id: persona, persona_name: persona };
	}
	const node = nonEmpty(raw.node_id, "node_id");
	if (!NODE_ID_PATTERN.test(node)) throw new Error(`node_id is not a valid node ID: ${node}`);
	return { node_id: node, persona_name: nonEmpty(raw.persona_name, "persona_name"), attempt_id: nonEmpty(raw.attempt_id, "attempt_id") };
}

function checkEdgeList(value: unknown, field: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array of non-empty strings`);
	for (const item of value) nonEmpty(item, field);
}

function isJoinNode(entry: unknown): boolean {
	return isRecord(entry) && (entry.join_policy !== undefined || (Array.isArray(entry.inbound_edges) && entry.inbound_edges.length > 1));
}

function checkGraphVersion(version: number, hasJoin: boolean, record: string): void {
	if (version === GRAPH_VERSION && hasJoin) throw new Error(`Graph ${record} version 3 cannot contain a join`);
	if (version === JOIN_GRAPH_VERSION && !hasJoin) throw new Error(`Graph ${record} version 4 requires a join`);
}

function checkReviewVersion(raw: Record<string, unknown>, version: number, hasTopology = false): void {
	if (version === GRAPH_REVIEW_VERSION) {
		if (hasTopology && raw.topology !== "graph") throw new Error('Graph review record version 6 requires topology "graph"');
		parseReviewPlan(raw.review_plan);
	} else if (version === REVIEW_VERSION) {
		if (hasTopology && raw.topology === "graph") throw new Error("Graph decision record cannot use version 5; version 6 is required");
		parseReviewPlan(raw.review_plan);
	} else if (raw.review_plan !== undefined) {
		throw new Error("Review plan requires review record version");
	}
}

function parseCleanupPolicy(policy: unknown): CleanupPolicy {
	if (!isRecord(policy)) throw new Error("Invalid cleanup policy");
	checkVersion(policy.version, "cleanup policy", false, "", [1]);
	if ((policy.mode !== "manual" && policy.mode !== "on_success") || !Number.isInteger(policy.settle_ms) ||
		(policy.settle_ms as number) < 0 || (policy.settle_ms as number) > MAX_CLEANUP_SETTLE_MS) {
		throw new Error("Invalid cleanup policy");
	}
	return { version: 1, mode: policy.mode, settle_ms: policy.settle_ms as number };
}

export function parseFactoryManagedInfo(raw: unknown): FactoryManagedInfo {
	if (!isRecord(raw)) throw new Error("Invalid factory_managed metadata");
	if (raw.version !== 1) throw new Error(`Unsupported factory_managed version ${JSON.stringify(raw.version)}`);
	if (typeof raw.bound_version !== "string" || !/^v[1-9]\d*$/.test(raw.bound_version)) {
		throw new Error(`Unsupported factory bound_version ${JSON.stringify(raw.bound_version)}`);
	}
	const checkout_key = nonEmpty(raw.checkout_key, "factory_managed.checkout_key");
	if (!/^dev:\d+:ino:\d+$/.test(checkout_key)) {
		throw new Error("Invalid factory_managed.checkout_key");
	}
	return {
		version: 1,
		factory_id: nonEmpty(raw.factory_id, "factory_managed.factory_id"),
		factory_name: nonEmpty(raw.factory_name, "factory_managed.factory_name"),
		input_id: nonEmpty(raw.input_id, "factory_managed.input_id"),
		attempt_id: nonEmpty(raw.attempt_id, "factory_managed.attempt_id"),
		request_id: nonEmpty(raw.request_id, "factory_managed.request_id"),
		bound_version: raw.bound_version,
		canonical_checkout: nonEmpty(raw.canonical_checkout, "factory_managed.canonical_checkout"),
		checkout_key,
		state_db_path: nonEmpty(raw.state_db_path, "factory_managed.state_db_path"),
		coord_db_path: nonEmpty(raw.coord_db_path, "factory_managed.coord_db_path"),
	};
}

export interface FactoryReleaseMarker {
	task_id: string;
	token: string;
	factory_managed: {
		factory_id: string;
		input_id: string;
		attempt_id: string;
		request_id: string;
		bound_version?: string;
		release_nonce: string;
	};
}

/** Validate release.json contents for a factory-managed run against expected identity, token/digest, and nonce digest. */
export function parseFactoryReleaseMarker(
	raw: unknown,
	expected: {
		task_id: string;
		token?: string;
		token_digest?: string | null;
		release_nonce_digest?: string | null;
		factory_managed: { factory_id: string; input_id: string; attempt_id: string; request_id: string; bound_version?: string };
	},
): FactoryReleaseMarker {
	if (!isRecord(raw)) throw new Error("Release marker must be a JSON object");
	const task_id = nonEmpty(raw.task_id, "release.task_id");
	if (task_id !== expected.task_id) {
		throw new Error(`Release marker task_id mismatch (${task_id} !== ${expected.task_id})`);
	}
	const token = nonEmpty(raw.token, "release.token");
	if (expected.token !== undefined && token !== expected.token) {
		throw new Error("Release marker token mismatch");
	}
	if (expected.token_digest) {
		const tokenDigest = createHash("sha256").update(token, "utf8").digest("hex");
		if (tokenDigest !== expected.token_digest) {
			throw new Error("Release marker token digest mismatch");
		}
	}
	if (!isRecord(raw.factory_managed)) {
		throw new Error("Release marker is missing factory_managed authorization details");
	}
	const fm = raw.factory_managed;
	const identity = {
		factory_id: nonEmpty(fm.factory_id, "release.factory_managed.factory_id"),
		input_id: nonEmpty(fm.input_id, "release.factory_managed.input_id"),
		attempt_id: nonEmpty(fm.attempt_id, "release.factory_managed.attempt_id"),
		request_id: nonEmpty(fm.request_id, "release.factory_managed.request_id"),
	};
	for (const key of ["factory_id", "input_id", "attempt_id", "request_id"] as const) {
		if (identity[key] !== expected.factory_managed[key]) {
			throw new Error(`Release marker factory identity mismatch (${key})`);
		}
	}
	let bound_version: string | undefined;
	// Only legacy v1 markers may omit bound_version; a marker for any later version must name the version it released.
	if (fm.bound_version === undefined && expected.factory_managed.bound_version !== undefined && expected.factory_managed.bound_version !== "v1") {
		throw new Error(`Release marker is missing release.factory_managed.bound_version (expected ${expected.factory_managed.bound_version})`);
	}
	if (fm.bound_version !== undefined) {
		bound_version = nonEmpty(fm.bound_version, "release.factory_managed.bound_version");
		if (!/^v[1-9]\d*$/.test(bound_version)) {
			throw new Error(`Invalid release.factory_managed.bound_version (${bound_version})`);
		}
		if (expected.factory_managed.bound_version !== undefined && bound_version !== expected.factory_managed.bound_version) {
			throw new Error(`Release marker factory identity mismatch (bound_version)`);
		}
	}
	const release_nonce = nonEmpty(fm.release_nonce, "release.factory_managed.release_nonce");
	if (expected.release_nonce_digest) {
		const nonceDigest = createHash("sha256").update(release_nonce, "utf8").digest("hex");
		if (nonceDigest !== expected.release_nonce_digest) {
			throw new Error("Release marker nonce digest mismatch");
		}
	}
	return { task_id, token, factory_managed: { ...identity, ...(bound_version !== undefined ? { bound_version } : {}), release_nonce } };
}

export interface CoordAnchor {
	version: 1;
	anchor_id: string;
	state: "pending" | "committed";
	created_at: string;
}

export function coordAnchorPath(coordPath: string): string {
	return `${coordPath}.anchor.json`;
}

export function coordMetaRecordDigest(id: number, anchorId: string, createdAt: string): string {
	return createHash("sha256").update(JSON.stringify([id, anchorId, createdAt]), "utf8").digest("hex");
}

export function parseCoordAnchor(raw: unknown): CoordAnchor {
	if (!isRecord(raw)) throw new Error("Coordination continuity anchor must be a JSON object");
	if (raw.version !== 1) throw new Error(`Unsupported coordination anchor version ${JSON.stringify(raw.version)}`);
	if (raw.state !== "pending" && raw.state !== "committed") {
		throw new Error(`Invalid coordination anchor state ${JSON.stringify(raw.state)}`);
	}
	return {
		version: 1,
		anchor_id: nonEmpty(raw.anchor_id, "anchor.anchor_id"),
		state: raw.state,
		created_at: nonEmpty(raw.created_at, "anchor.created_at"),
	};
}

/** Validate a persisted manifest and normalize it to the in-memory shape. Throws a clear error for anything unreadable. */
function parseManifestFields(raw: unknown, taskId: string): BootstrapManifest {
	if (!isRecord(raw)) throw new Error(`Invalid bootstrap manifest for "${taskId}"`);
	if (raw.factory_managed !== undefined) parseFactoryManagedInfo(raw.factory_managed);
	if (raw.topology === "graph" && (raw.version === 1 || raw.version === 2)) throw new Error(`Unsupported topology ${JSON.stringify(raw.topology)} for "${taskId}"`);
	const readable = raw.version === GRAPH_REVIEW_VERSION ? [GRAPH_REVIEW_VERSION]
		: raw.version === REVIEW_VERSION ? [REVIEW_VERSION]
		: raw.topology === "graph" ? [GRAPH_VERSION, JOIN_GRAPH_VERSION]
		: READABLE_VERSIONS;
	const version = checkVersion(raw.version, "bootstrap manifest", false, ` for "${taskId}"`, readable);
	checkReviewVersion(raw, version, true);
	if (raw.task_id !== taskId || !Array.isArray(raw.pane_manifest)) throw new Error(`Invalid bootstrap manifest for "${taskId}"`);
	if (raw.topology !== "chain" && raw.topology !== "team" && raw.topology !== "graph") throw new Error(`Unsupported topology ${JSON.stringify(raw.topology)} for "${taskId}"`);
	checkPolicy(raw);
	checkRunPolicies(raw);
	const cleanup_policy = raw.cleanup_policy === undefined ? undefined : parseCleanupPolicy(raw.cleanup_policy);
	const nodes = new Set<string>();
	const instances = new Set<string>();
	const pane_manifest = raw.pane_manifest.map((entry, index): AgentLaunch => {
		try {
			if (!isRecord(entry)) throw new Error("not an object");
			const { agent_name: _legacyPersona, node_id: _node, persona_name: _persona, attempt_id: _attempt, ...rest } = entry;
			const identity = normalizeIdentity(entry, version);
			checkPolicy(entry);
			checkNodeKindFields(entry, version);
			checkEdgeList(entry.inbound_edges, "inbound_edges");
			const instance = nonEmpty(entry.instance_id, "instance_id");
			if (nodes.has(identity.node_id.toLowerCase())) throw new Error(`duplicate node ID ${identity.node_id}`);
			if (instances.has(instance)) throw new Error(`duplicate instance ${instance}`);
			nodes.add(identity.node_id.toLowerCase()); instances.add(instance);
			return { ...rest, ...identity, instance_id: instance } as unknown as AgentLaunch;
		} catch (error) { throw new Error(`Invalid bootstrap manifest for "${taskId}": agent ${index + 1}: ${errorMessage(error)}`); }
	});
	if (raw.topology === "graph") checkGraphVersion(version, pane_manifest.some(isJoinNode), "manifest");
	return { ...raw, ...(cleanup_policy && { cleanup_policy }), version, pane_manifest } as unknown as BootstrapManifest;
}

function validateAutomaticCleanup(manifest: BootstrapManifest): BootstrapManifest {
	if (manifest.cleanup_trigger !== undefined || manifest.cleanup_at !== undefined) {
		if (manifest.cleanup_policy?.mode !== "on_success" || manifest.cleanup_trigger !== "auto" ||
			typeof manifest.cleanup_at !== "string" || !Number.isFinite(Date.parse(manifest.cleanup_at))) {
			throw new Error("Invalid automatic cleanup record");
		}
	}
	return manifest;
}

export function parseManifest(raw: unknown, taskId: string): BootstrapManifest {
	return validateAutomaticCleanup(parseManifestFields(raw, taskId));
}

/** Preserve the launch shape and make a started cleanup journal self-contained. */
function storedManifest(manifest: BootstrapManifest): unknown {
	const { cleanup_policy: _policy, ...launch } = manifest;
	const stored = manifest.cleanup_trigger ? manifest : launch;
	if (manifest.version !== 1) return stored;
	return { ...stored, pane_manifest: manifest.pane_manifest.map(({ node_id: _node, persona_name, attempt_id: _attempt, ...rest }) => ({ agent_name: persona_name, ...rest })) };
}

/** Validate a persisted worker configuration and normalize version 1 (persona-keyed) files. */
export function parseWorkerConfig(raw: unknown): WorkerConfig {
	if (!isRecord(raw)) throw new Error("Invalid bootstrap child configuration");
	if (raw.factory_managed !== undefined) parseFactoryManagedInfo(raw.factory_managed);
	if (raw.submitted_brief !== undefined && (typeof raw.submitted_brief !== "string" || !raw.submitted_brief.isWellFormed())) {
		throw new Error("Invalid bootstrap child submitted_brief");
	}
	if (raw.topology === "graph" && (raw.version === undefined || raw.version === 1 || raw.version === 2)) throw new Error(`Unsupported worker topology ${JSON.stringify(raw.topology)}`);
	const readable = raw.version === GRAPH_REVIEW_VERSION ? [GRAPH_REVIEW_VERSION]
		: raw.version === REVIEW_VERSION ? [REVIEW_VERSION]
		: raw.topology === "graph" ? [GRAPH_VERSION, JOIN_GRAPH_VERSION]
		: READABLE_VERSIONS;
	const version = checkVersion(raw.version, "bootstrap worker configuration", true, "", readable);
	checkReviewVersion(raw, version, true);
	const { agent_name: _legacyPersona, ...rest } = raw;
	const identity = normalizeIdentity(raw, version);
	checkPolicy(raw);
	checkRunPolicies(raw);
	checkNodeKindFields(raw, version);
	if (raw.topology !== "chain" && raw.topology !== "team" && raw.topology !== "graph") throw new Error(`Unsupported worker topology ${JSON.stringify(raw.topology)}`);
	checkEdgeList(raw.inbound_edges, "inbound_edges");
	checkEdgeList(raw.outbound_edges, "outbound_edges");
	if (raw.handoff_protocol !== undefined && raw.handoff_protocol !== 1) throw new Error(`Unsupported handoff protocol ${JSON.stringify(raw.handoff_protocol)}: this release reads protocol 1. The configuration was left untouched`);
	const roster = raw.roster === undefined ? undefined : (Array.isArray(raw.roster) ? raw.roster : (() => { throw new Error("roster must be an array"); })()).map((member: unknown) => {
		if (!isRecord(member)) throw new Error("roster entries must be objects");
		if (raw.topology === "graph") checkEdgeList(member.inbound_edges, "roster inbound_edges");
		const { agent_name: _persona, ...fields } = member;
		const persona = version === 1 ? nonEmpty(member.agent_name, "roster agent_name") : nonEmpty(member.persona_name, "roster persona_name");
		return { ...fields, instance_id: nonEmpty(member.instance_id, "roster instance_id"), node_id: version === 1 ? persona : nonEmpty(member.node_id, "roster node_id"), persona_name: persona };
	});
	if (raw.topology === "graph") {
		checkGraphVersion(version, isJoinNode(raw) || (roster?.some(isJoinNode) ?? false), "worker configuration");
	}
	return { ...rest, ...identity, version, ...(roster ? { roster } : {}) } as unknown as WorkerConfig;
}

/** What a result file must say about itself. The run and the instance are always known; a reader that knows more (the node, persona, attempt) checks more. */
export interface CompletionExpectation {
	run_id: string; instance_id: string; node_id?: string; persona_name?: string; attempt_id?: string;
	kind?: NodeKind;
	command?: string;
	args?: string[];
	working_directory?: string;
	/** Another node of the run shares this persona, so a persona-only (version 1) record cannot prove which node it is for. */
	personaShared?: boolean;
	/** Expected record version when the caller knows the run's topology and review mode. */
	version?: number;
}

/** Expected result record version for a review-plan run (6 for graph decisions, 5 for chain reviews). */
export function expectedResultVersion(record: { topology?: Topology; review_plan?: ReviewPlan }): number | undefined {
	return record.review_plan ? (record.topology === "graph" ? GRAPH_REVIEW_VERSION : REVIEW_VERSION) : undefined;
}

/** Validate a persisted `CompletionIdentity` block against `expected`; throws a contextual mismatch error. */
export function assertIdentityMatches(identity: unknown, expected: CompletionExpectation, label: string): CompletionIdentity {
	if (!isRecord(identity)) throw new Error(`${label} identity mismatch (no identity recorded)`);
	const recorded = identity as unknown as CompletionIdentity;
	for (const field of ["run_id", "node_id", "persona_name", "instance_id", "attempt_id"] as const) {
		if (expected[field] !== undefined && recorded[field] !== expected[field]) {
			throw new Error(`${label} identity mismatch (${field} ${JSON.stringify(recorded[field])}, expected ${JSON.stringify(expected[field])})`);
		}
	}
	return recorded;
}

/** Validate a persisted result against the node whose file it is. Throws a message suitable for the per-agent error. */
export function parseCompletion(raw: unknown, expected: CompletionExpectation): WorkerCompletion {
	if (!isRecord(raw) || !isRecord(raw.result)) throw new Error("malformed result record");
	if (raw.review_plan !== undefined && (raw.version === 1 || raw.version === 2)) {
		throw new Error("Review plan requires review record version");
	}
	const readable = expected.version !== undefined ? [expected.version]
		: raw.version === GRAPH_REVIEW_VERSION ? [GRAPH_REVIEW_VERSION]
		: raw.version === REVIEW_VERSION ? [REVIEW_VERSION]
		: READABLE_VERSIONS;
	const version = checkVersion(raw.version, "result record", true, "", readable);
	checkReviewVersion(raw, version, false);
	const result = raw.result as unknown as BootstrapResult;
	if (typeof result.summary !== "string" || !["success", "partial", "failure"].includes(result.status)) throw new Error("malformed result record");
	if (version === 1) {
		if (expected.persona_name !== undefined && result.agent_name !== expected.persona_name) throw new Error(`result identity mismatch (recorded for ${result.agent_name})`);
		if (expected.personaShared) throw new Error(`version 1 result is ambiguous: persona ${expected.persona_name} is shared by several nodes of this run`);
		return raw as unknown as WorkerCompletion;
	}
	const recorded = assertIdentityMatches(raw.identity, expected, "result");
	// The result inside the record must agree with the identity that wraps it.
	if (result.agent_name !== recorded.persona_name || (result.node_id !== undefined && result.node_id !== recorded.node_id)) throw new Error(`result identity mismatch (result recorded for ${result.node_id ?? "?"}/${result.agent_name})`);
	if (expected.kind === "command") {
		if (result.command_evidence === undefined) throw new Error("missing command_evidence for command node result");
		const evidence = parseCommandEvidence(result.command_evidence, expected);
		if (result.status === "success" && (evidence.exit_code !== 0 || evidence.signal !== null || evidence.spawn_error !== undefined)) {
			throw new Error("command_evidence contradicts claimed success status");
		}
	} else if (expected.kind === "agent") {
		if (result.command_evidence !== undefined) throw new Error("unexpected command_evidence on agent node result");
	} else if (result.command_evidence !== undefined) {
		const evidence = parseCommandEvidence(result.command_evidence);
		if (result.status === "success" && (evidence.exit_code !== 0 || evidence.signal !== null || evidence.spawn_error !== undefined)) {
			throw new Error("command_evidence contradicts claimed success status");
		}
	}
	if (raw.edge_deliveries !== undefined) {
		if (!isRecord(raw.edge_deliveries)) throw new Error("malformed result record (edge_deliveries)");
		for (const entry of Object.values(raw.edge_deliveries)) {
			if (!isRecord(entry) || !["pending", "sent", "failed"].includes(entry.state as string)) {
				throw new Error("malformed result record (edge_deliveries)");
			}
		}
	}
	return raw as unknown as WorkerCompletion;
}

/** The version 2 record for a finished node, stamped with the identity of the config that produced it. */
export function completionRecord(config: WorkerConfig, result: BootstrapResult, delivery: WorkerCompletion["delivery"], completedAt: string): WorkerCompletion {
	if (config.version === 1) return { result: { ...result, agent_name: config.persona_name }, delivery, completed_at: completedAt };
	return {
		version: config.review_plan ? (config.topology === "graph" ? GRAPH_REVIEW_VERSION : REVIEW_VERSION) : CURRENT_VERSION,
		...(config.review_plan ? { review_plan: config.review_plan } : {}),
		identity: { run_id: config.task_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id!, instance_id: config.instance_id },
		result: { ...result, agent_name: config.persona_name, node_id: config.node_id }, delivery, completed_at: completedAt,
	};
}

/** Expectation for one launch record, for `parseCompletion`. */
export function expectationFor(manifest: BootstrapManifest, entry: AgentLaunch): CompletionExpectation {
	const version = expectedResultVersion(manifest);
	return {
		run_id: manifest.task_id, node_id: entry.node_id, persona_name: entry.persona_name, attempt_id: entry.attempt_id, instance_id: entry.instance_id,
		kind: entry.kind ?? "agent",
		...(entry.kind === "command" ? { command: entry.command, args: entry.args, working_directory: entry.working_directory } : {}),
		personaShared: entry.kind !== "command" && manifest.pane_manifest.some(other => other !== entry && other.kind !== "command" && other.persona_name.toLowerCase() === entry.persona_name.toLowerCase()),
		...(version !== undefined ? { version } : {}),
	};
}

/** "node" when the node is named after its persona, otherwise "node, persona X": the identifiers selectors and reports use. */
export function nodeIdentity(node: { node_id: string; persona_name: string; kind?: NodeKind }): string {
	if (node.kind === "command") return `${node.node_id} (command)`;
	return node.node_id.toLowerCase() === node.persona_name.toLowerCase() ? node.node_id : `${node.node_id}, persona ${node.persona_name}`;
}

/** Label for messages: the node, with its persona when that is a different name. */
export function nodeLabel(node: { node_id: string; persona_name: string; kind?: NodeKind }): string {
	if (node.kind === "command") return `${node.node_id} (command)`;
	return node.node_id.toLowerCase() === node.persona_name.toLowerCase() ? node.node_id : `${node.node_id} (persona ${node.persona_name})`;
}

/**
 * What the system recorded for a node that has no worker result: it did not execute (`blocked`, `skipped`, `cancelled`) or its outcome is
 * unresolved (`needs_attention`). `causes` references the nodes (and evidence) responsible, the direct cause first and the original ones after.
 * A node with a disposition never also has a result: the two are the node's execution record, either reported by its worker or by the system.
 */
export interface DispositionIdentity { run_id: string; node_id: string; persona_name: string; attempt_id?: string; instance_id: string }

export interface Disposition {
	version: 1;
	identity: DispositionIdentity;
	state: DispositionState;
	reason: string;
	causes: CauseRef[];
	recorded_at: string;
	command_evidence?: CommandEvidence;
}
const READABLE_DISPOSITION_VERSIONS = [1];

export function dispositionRecord(config: { task_id: string; node_id: string; persona_name: string; attempt_id?: string; instance_id: string }, state: DispositionState, reason: string, causes: CauseRef[], recordedAt: string, commandEvidence?: CommandEvidence): Disposition {
	return {
		version: 1,
		identity: {
			run_id: config.task_id, node_id: config.node_id, persona_name: config.persona_name,
			...(config.attempt_id !== undefined ? { attempt_id: config.attempt_id } : {}),
			instance_id: config.instance_id,
		},
		state, reason, causes, recorded_at: recordedAt,
		...(commandEvidence !== undefined ? { command_evidence: commandEvidence } : {}),
	};
}

/** Validate a persisted disposition against the node whose file it is. Throws a message suitable for the per-agent error. */
export function parseDisposition(raw: unknown, expected: CompletionExpectation): Disposition {
	if (!isRecord(raw)) throw new Error("malformed disposition record");
	checkVersion(raw.version, "disposition record", false, "", READABLE_DISPOSITION_VERSIONS);
	assertIdentityMatches(raw.identity, expected, "disposition");
	if (!(DISPOSITION_STATES as readonly unknown[]).includes(raw.state) || typeof raw.reason !== "string" || !Array.isArray(raw.causes) || typeof raw.recorded_at !== "string") throw new Error("malformed disposition record");
	if (raw.command_evidence !== undefined) {
		if (expected.kind === "agent") throw new Error("unexpected command_evidence on agent disposition");
		parseCommandEvidence(raw.command_evidence, expected);
	}
	return raw as unknown as Disposition;
}

export function readyPath(dir: string, instance: string): string { return join(dir, `${instance}.ready.json`); }

/** Validate a persisted `WorkerReady` record at the read boundary. */
export function parseWorkerReady(raw: unknown): WorkerReady {
	if (!isRecord(raw)) throw new Error("malformed readiness record");
	const version = checkVersion(raw.version, "worker readiness record", true, "", [1, 2]);
	if (version === 2) nonEmpty(raw.direction_incarnation, "direction_incarnation");
	const task_id = nonEmpty(raw.task_id, "task_id");
	const token = nonEmpty(raw.token, "token");
	const instance_id = nonEmpty(raw.instance_id, "instance_id");
	const session_id = nonEmpty(raw.session_id, "session_id");
	if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
		throw new Error("pid must be a positive integer");
	}
	if (raw.name !== undefined) nonEmpty(raw.name, "name");
	if (raw.endpoint !== undefined) nonEmpty(raw.endpoint, "endpoint");
	if (raw.model !== undefined && typeof raw.model !== "string") throw new Error("model must be a string");
	if (raw.start_time !== undefined && typeof raw.start_time !== "string") throw new Error("start_time must be a string");
	for (const field of ["kept_skills", "unmatched_skills"] as const) {
		const names = raw[field];
		if (names === undefined) continue;
		if (!Array.isArray(names)) throw new Error(`${field} must be an array of skill names`);
		for (const name of names) nonEmpty(name, field);
	}
	return { ...raw, task_id, token, instance_id, session_id, pid: raw.pid as number } as WorkerReady;
}
export function factoryRunPath(dir: string): string { return join(dir, "factory-run.json"); }
export function dispositionPath(dir: string, instance: string): string { return join(dir, `${instance}.disposition.json`); }
export function resultPath(dir: string, instance: string): string { return join(dir, `${instance}.result.json`); }

export class SessionStore {
	readonly indexRoot: string;
	constructor(indexRoot: string) { this.indexRoot = indexRoot; }

	private indexPath(taskId: string): string {
		assertTaskId(taskId);
		return join(this.indexRoot, `${taskId}.json`);
	}

	factoryRunIndexPath(taskId: string): string {
		assertTaskId(taskId);
		return join(this.indexRoot, "factory-runs", `${taskId}.json`);
	}

	private indexCleanupPolicyPath(taskId: string): string {
		return join(this.indexRoot, "cleanup-policies", `${taskId}.json`);
	}

	save(manifest: BootstrapManifest, durable = false): void {
		const index = this.indexPath(manifest.task_id);
		if (durable) createDurableDirectoryPath(this.indexRoot);
		else mkdirSync(this.indexRoot, { recursive: true, mode: 0o700 });
		if (manifest.cleanup_policy && !manifest.cleanup_trigger) {
			const policy = { ...manifest.cleanup_policy, run_id: manifest.task_id };
			const indexed = this.indexCleanupPolicyPath(manifest.task_id);
			if (!existsSync(indexed)) {
				if (durable) createDurableDirectoryPath(dirname(indexed));
				else mkdirSync(dirname(indexed), { recursive: true, mode: 0o700 });
				atomicJson(indexed, policy, durable);
			}
			if (!manifest.session_dir_removed) {
				this.assertDirectory(manifest);
				const local = cleanupPolicyPath(manifest.session_dir);
				if (!existsSync(local)) atomicJson(local, policy, durable);
			}
		}
		manifest.updated_at = new Date().toISOString();
		// The independent index is also a recovery journal if the project becomes inaccessible.
		const stored = storedManifest(manifest);
		atomicJson(index, stored, durable);
		if (!manifest.session_dir_removed) {
			if (manifest.cleanup_trigger === "auto") this.assertDirectory(manifest);
			atomicJson(join(manifest.session_dir, "manifest.json"), stored, durable);
		}
	}

	load(taskId: string, cwd?: string, allowMissingSession = false): BootstrapManifest {
		const index = this.indexPath(taskId);
		const path = existsSync(index) ? index : cwd ? join(cwd, ".pi", "agent-sessions", taskId, "manifest.json") : index;
		if (!existsSync(path)) throw new Error(`No bootstrap session found for task_id "${taskId}". Use the task_id, not the workspace_id.`);
		// Fail closed on an unsupported or malformed record; it is never rewritten, so its ownership evidence stays intact.
		const manifest = parseManifestFields(readJson<unknown>(path), taskId);
		if (!isAbsolute(manifest.project_cwd) || manifest.session_dir !== join(manifest.project_cwd, ".pi", "agent-sessions", taskId)) {
			throw new Error("Session directory does not match the recorded project root");
		}
		if (!manifest.session_dir_removed) {
			try { this.assertDirectory(manifest); }
			catch (error: any) {
				// Cleanup must remain possible from the independent index after project files disappear.
				if (!allowMissingSession || error?.code !== "ENOENT") throw error;
				manifest.session_dir_removed = true;
			}
		}
		if (!manifest.cleanup_policy) {
			const local = cleanupPolicyPath(manifest.session_dir);
			const policyPath = !manifest.session_dir_removed && existsSync(local) ? local : this.indexCleanupPolicyPath(taskId);
			if (existsSync(policyPath)) {
				const raw = readJson<Record<string, unknown>>(policyPath);
				const policy = parseCleanupPolicy(raw);
				if (raw.run_id !== taskId) throw new Error("Cleanup policy belongs to a different run");
				manifest.cleanup_policy = policy;
			}
		}
		return validateAutomaticCleanup(manifest);
	}

	removeUnlaunchedIndex(taskId: string): void {
		rmSync(this.indexPath(taskId), { force: true });
		rmSync(this.indexCleanupPolicyPath(taskId), { force: true });
	}

	/** Most recently updated runs from the independent index (unreadable records are skipped). */
	list(limit = 10): BootstrapManifest[] {
		let files: string[];
		try { files = readdirSync(this.indexRoot).filter(file => file.endsWith(".json") && !file.startsWith("request-")); } catch { return []; }
		const runs: BootstrapManifest[] = [];
		for (const file of files) {
			try { runs.push(parseManifest(readJson<unknown>(join(this.indexRoot, file)), file.slice(0, -".json".length))); } catch { /* skip unreadable or unsupported records */ }
		}
		return runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
	}

	assertDirectory(manifest: BootstrapManifest): void {
		const dir = manifest.session_dir;
		if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir)) {
			throw new Error("Refusing a symlinked or non-directory bootstrap session path");
		}
		if (realpathSync(dirname(dir)) !== dirname(dir)) throw new Error("Refusing a symlinked sessions root");
	}
}

/**
 * Publish a complete file at `path` only if nothing exists there yet. link(2) is atomic and exclusive,
 * so readers never see a partial record and a crash never leaves an empty one. Returns false on EEXIST.
 */
export function publishExclusive(path: string, text: string, durable = false): boolean {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		if (!durable) {
			writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		} else {
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, text, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		try {
			linkSync(temporary, path);
			if (durable) syncDirectory(dirname(path));
			return true;
		}
		catch (error: any) { if (error?.code === "EEXIST") return false; throw error; }
	} finally { rmSync(temporary, { force: true }); }
}

interface LockOwner { pid: number; start_time?: string; instance: string; acquired_at: number; /** Unique per acquisition; absent in records written by older versions. */ id?: string }
/** Identifies this module instance: a /reload in the same process gets a new one. */
const LOCK_INSTANCE = randomUUID();
export const LOCK_WAIT_MS = 15 * 60_000;

function readLockOwner(path: string): LockOwner | undefined {
	try { return readJson<LockOwner>(path); } catch { return undefined; }
}

/** Whether another live holder owns the lock file. Our own instance never holds it outside withRunLock. */
export function lockHeld(key: string): boolean {
	const owner = readLockOwner(`${key}.lock`);
	if (!owner || !Number.isInteger(owner.pid)) return existsSync(`${key}.lock`) && Date.now() - safeMtime(`${key}.lock`) < 5000; // a torn record is being written
	try { return processAlive(owner); } catch { return true; }
}

function safeMtime(path: string): number {
	try { return lstatSync(path).mtimeMs; } catch { return 0; }
}

/** Identity of one specific lock record, so recovery of that record (and no other) can be claimed exclusively. */
export function lockRecordIdentity(path: string, owner: LockOwner | undefined): string | undefined {
	if (owner && Number.isInteger(owner.pid)) return createHash("sha1").update(`${owner.id ?? ""}:${owner.pid}:${owner.start_time ?? ""}:${owner.instance}:${owner.acquired_at}`).digest("hex").slice(0, 20);
	try { const info = lstatSync(path); return `torn-${info.ino}-${Math.trunc(info.mtimeMs)}`; } catch { return undefined; }
}

/**
 * Remove one specific stale lock record without ever disturbing a live holder.
 *
 * Deleting "whatever is at the lock path" is unsafe: a contender that judged record S stale may be
 * overtaken by another that removes S and publishes its own live lock, and the slower contender would
 * then remove that live lock. Instead, recovery of S needs an exclusive claim (published with link(2))
 * named after S. Only the claim holder may remove S, and S is a unique record that is never written
 * again, so after claiming, finding anything else at the path proves S is already gone and nothing is
 * removed. A claim whose holder died is superseded by the next generation. Returns false when a live
 * recovery of this record is in progress elsewhere (the caller waits and re-evaluates).
 */
function breakStaleLock(path: string, identity: string): boolean {
	for (let generation = 0; ; generation++) {
		const claim = `${path}.break-${identity}-${generation}`;
		const record: LockOwner = { pid: process.pid, start_time: processStartTime(process.pid), instance: LOCK_INSTANCE, acquired_at: Date.now() };
		if (publishExclusive(claim, JSON.stringify(record))) {
			try {
				if (lockRecordIdentity(path, readLockOwner(path)) === identity) rmSync(path, { force: true });
			} finally {
				// Every lower generation belonged to a dead breaker; nothing can need them once S is gone.
				for (let lower = 0; lower <= generation; lower++) rmSync(`${path}.break-${identity}-${lower}`, { force: true });
			}
			return true;
		}
		const holder = readLockOwner(claim);
		const alive = holder && Number.isInteger(holder.pid) ? ((): boolean => { try { return processAlive(holder); } catch { return true; } })() : Date.now() - safeMtime(claim) < 5000;
		if (alive) return false;
	}
}

function tryAcquireFileLock(path: string): { acquired: true } | { acquired: false; retry: boolean; pid?: number } {
	const record: LockOwner = { pid: process.pid, start_time: processStartTime(process.pid), instance: LOCK_INSTANCE, acquired_at: Date.now(), id: randomUUID() };
	if (publishExclusive(path, JSON.stringify(record))) return { acquired: true };
	const owner = readLockOwner(path);
	// A lock from this module without an active holder is a leftover. A different module instance
	// in the same process (after /reload) may still own a live lock.
	let stale = false;
	if (owner && Number.isInteger(owner.pid)) {
		try {
			const recycled = owner.start_time !== undefined && owner.start_time !== processStartTime(process.pid);
			stale = owner.pid === process.pid ? owner.instance === LOCK_INSTANCE || (recycled && processStartTime(process.pid) !== undefined) : !processAlive(owner);
		} catch { stale = false; }
	} else stale = Date.now() - safeMtime(path) > 5000;
	const identity = stale ? lockRecordIdentity(path, owner) : undefined;
	return { acquired: false, retry: stale && (identity === undefined || breakStaleLock(path, identity)), pid: owner?.pid };
}

function lockTimeout(path: string, pid: number | undefined): Error {
	return new Error(`Bootstrap run is locked by another process (pid ${pid ?? "unknown"}). Retry later, or remove ${path} if that process is gone.`);
}

async function acquireFileLock(path: string, waitMs: number): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + waitMs;
	for (;;) {
		const result = tryAcquireFileLock(path);
		if (result.acquired) return;
		if (result.retry) continue;
		if (Date.now() >= deadline) throw lockTimeout(path, result.pid);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function releaseFileLock(path: string): void {
	const owner = readLockOwner(path);
	if (owner?.instance === LOCK_INSTANCE && owner.pid === process.pid) rmSync(path, { force: true });
}

const syncLockWait = new Int32Array(new SharedArrayBuffer(4));

/** Serialize short synchronous record publications. The lock holder performs no asynchronous work. */
export function withSyncRunLock<T>(key: string, action: () => T): T {
	const path = `${key}.lock`;
	const deadline = performance.now() + 5000;
	for (;;) {
		const result = tryAcquireFileLock(path);
		if (result.acquired) {
			try { return action(); }
			finally { releaseFileLock(path); }
		}
		if (performance.now() >= deadline) throw lockTimeout(path, result.pid);
		if (!result.retry) Atomics.wait(syncLockWait, 0, 0, 10);
	}
}

const locks = new Map<string, Promise<void>>();
/**
 * Serialize launch/report/cleanup on a run without blocking unrelated runs: an in-process queue
 * plus a lock file (`<key>.lock`) that coordinates separate dispatcher processes.
 */
export async function withRunLock<T>(key: string, action: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => { release = resolve; });
	locks.set(key, current);
	await previous;
	try {
		await acquireFileLock(`${key}.lock`, waitMs);
		try { return await action(); }
		finally { releaseFileLock(`${key}.lock`); }
	}
	finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Bootstrap cancelled");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	checkAbort(signal);
	return new Promise((resolve, reject) => {
		const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, ms);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Bootstrap cancelled")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}
