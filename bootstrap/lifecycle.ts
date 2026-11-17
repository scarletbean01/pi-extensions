/** Launch orchestration; Herdr subprocess execution is the only injected system boundary. */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ensureSessionDir, generateTaskId, resolveExtensionPaths, scanAgents } from "./bootstrap-utils.ts";
import { modelMatches, resolveModel } from "./model-utils.ts";
import { aggregateRun, DEPENDENCY_POLICIES, executionFromResult, NOT_EXECUTED_STATES, type CauseRef, type DependencyPolicy, type EvidenceStatus, type ExecutionState, type RunOutcome } from "./outcomes.ts";
import { requiredChecksOf, verifyEvidence } from "./evidence.ts";
import {
	atomicJson, atomicText, checkAbort, CURRENT_VERSION, delay, dependencyPolicyOf, dispositionPath, errorMessage, expectationFor, lockHeld, NODE_ID_PATTERN, nodeLabel, parseCompletion, parseDisposition, parseWorkerConfig, processAlive, publishExclusive,
	readJson, readyPath, resultPath, SessionStore, withRunLock,
	type AgentLaunch, type BootstrapManifest, type BootstrapResult, type Disposition, type NotExecutedEntry, type ReportEntry, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import {
	boundRosterEntries, buildTaskInputRecord, canonicalJson, taskInputPath, upstreamIndexPath, validateOutputContractSyntax,
	type OutputContract, type RosterEntry,
} from "./contracts.ts";
import { describeHandoff, HANDOFF_PROTOCOL, type HandoffView } from "./handoff.ts";
import { chainEdges, inspectRun, retryDelivery, type RecoveryDeps, type RecoveryReport, type RecoveryRequest } from "./recovery.ts";
import { evaluateNodeVerification, verificationPath, type VerificationEvaluation } from "./verification.ts";

export interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; truncated?: boolean }
export type Executor = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;
/**
 * One requested assignment. Either the legacy form (`name` is both the persona and the node ID) or the explicit form
 * (`persona` plus an optional `node_id`, which defaults to the persona name). `predecessor`/`successor` name node IDs.
 */
export interface RequestedAgent {
	name?: string;
	persona?: string;
	node_id?: string;
	sub_task: string;
	role?: string;
	ownership?: string[];
	acceptance_criteria?: string[];
	constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	/** Chain followers: how this node's dependency on its predecessor treats the predecessor's outcome (require_success or allow_partial). */
	dependency_policy?: string;
	step?: number;
	predecessor?: string;
	successor?: string;
}
/**
 * A validated assignment: its unique node ID, the persona it runs, and (for chains) its derived neighbours' node IDs and the
 * resolved dependency policy (`require_success` by default for the node form, `allow_partial` for the legacy form).
 */
export interface PlannedNode {
	node_id: string;
	persona: string;
	sub_task: string;
	role?: string;
	ownership?: string[];
	acceptance_criteria?: string[];
	constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	dependency_policy?: DependencyPolicy;
	step?: number;
	predecessor?: string;
	successor?: string;
}
export interface GenerateRequest {
	topology: "chain" | "team";
	task: string;
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	agents: RequestedAgent[];
	project_cwd: string;
	request_id?: string;
	coms_extension?: string;
	ready_timeout_ms?: number;
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
}
export const MAX_WAIT_MS = 1_800_000;
/** One agent's observable state, derived from durable files only (never from Herdr idle status). */
export interface AgentState {
	node_id: string;
	persona_name: string;
	attempt_id?: string;
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
		/** Evidence for the checks this node is required to pass, judged against the project as it is now: passing, missing, unverified, stale or failed. */
	evidence?: Array<{ check: string; status: EvidenceStatus }>;
	result_status?: BootstrapResult["status"];
	summary?: string;
	delivery?: WorkerCompletion["delivery"];
	heartbeat_age_ms?: number;
	/** Time since the worker's last model/tool activity; a live heartbeat with stale activity suggests a stall. */
	activity_age_ms?: number;
	verification?: VerificationEvaluation[];
	error?: string;
}
export interface RunStatus { manifest: BootstrapManifest; results: BootstrapResult[]; pending: string[]; delivery_errors: string[]; worker_errors: string[]; agents: AgentState[]; outcome: RunOutcome }
interface LiveTopology { tabs: any[]; panes: any[] }
export interface PlanPreview {
	topology: "chain" | "team";
	task: string;
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	project_cwd: string;
	coms_extension: string;
	ready_timeout_ms: number;
	agents: Array<{
		node_id: string;
		attempt_id: string;
		instance_id: string;
		persona_name: string;
		persona_file: string;
		persona_source?: string;
		model: string;
		tools: string[];
		extensions: string[];
		role?: string;
		ownership?: string[];
		acceptance_criteria?: string[];
		constraints?: string[];
		output_contract?: OutputContract;
		required_checks?: string[];
		dependency_policy?: DependencyPolicy;
		step?: number;
		predecessor?: string;
		successor?: string;
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

/** Validate assignments and normalize the legacy `name` form into nodes. Chain order and links are derived here. */
export function normalizeAgents(topology: "chain" | "team", requested: RequestedAgent[]): PlannedNode[] {
	if (!Array.isArray(requested) || requested.length < 1 || requested.length > 32) throw new Error("Bootstrap requires between 1 and 32 agents");
	const seen = new Set<string>();
	const nodes = requested.map((agent, index): PlannedNode & { requested: RequestedAgent } => {
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
		const acceptance_criteria = optionalStringList(agent.acceptance_criteria, `acceptance_criteria for ${nodeId}`, 32);
		const constraints = optionalStringList(agent.constraints, `constraints for ${nodeId}`, 32);
		const output_contract = agent.output_contract !== undefined ? validateOutputContractSyntax(agent.output_contract, nodeId) : undefined;
		const required_checks = optionalStringList(agent.required_checks, `required_checks for ${nodeId}`, 32);
		return {
			node_id: nodeId, persona, sub_task: agent.sub_task,
			...(role !== undefined ? { role } : {}),
			...(ownership !== undefined ? { ownership } : {}),
			...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			...(output_contract !== undefined ? { output_contract } : {}),
			...(required_checks !== undefined ? { required_checks } : {}),
			step: agent.step, predecessor: agent.predecessor, successor: agent.successor, requested: agent,
		};
	});
	if (topology === "team") {
		if (nodes.some(node => node.step !== undefined || node.predecessor || node.successor)) throw new Error("Team agents cannot declare chain links or steps");
		if (nodes.some(node => node.requested.dependency_policy !== undefined)) throw new Error("Team agents cannot declare a dependency policy: a team has no dependencies");
		return nodes.map(({ requested: _requested, step: _step, predecessor: _predecessor, successor: _successor, ...node }) => node);
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
		return { ...rest, step: i + 1, predecessor, successor, ...dependency };
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
		if (request.topology !== "chain" && request.topology !== "team") throw new Error("Invalid topology");
		requiredString(request.task, "task");
		const goal = optionalString(request.goal, "goal");
		const acceptance_criteria = optionalStringList(request.acceptance_criteria, "acceptance_criteria", 32);
		const constraints = optionalStringList(request.constraints, "constraints", 32);
		if (!isAbsolute(requiredString(request.project_cwd, "project_cwd"))) throw new Error("project_cwd must be absolute");
		const cwd = realpathSync(request.project_cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("project_cwd must be a directory");
		const nodes = normalizeAgents(request.topology, request.agents);
		const readyTimeout = request.ready_timeout_ms ?? 60_000;
		if (!Number.isInteger(readyTimeout) || readyTimeout < 100 || readyTimeout > 300_000) throw new Error("ready_timeout_ms must be an integer between 100 and 300000");
		const available = scanAgents(cwd, this.home);
		const mapped = nodes.map(node => {
			const def = available.find(def => def.name.toLowerCase() === node.persona.toLowerCase());
			if (!def) throw new Error(`Agent "${node.persona}" not found. Available: ${available.map(def => def.name).join(", ") || "none"}`);
			// Project extensions win; a global persona also finds extensions beside its own agents directory.
			const extensions = resolveExtensionPaths(cwd, def.extensions ?? [], [join(dirname(dirname(def.file)), "extensions"), this.options.extensionDir])
				.map(path => realpathSync(path));
			return { node, def, extensions, resolvedModel: resolveModel(def.model, model) };
		});
		const coms = this.comsExtension(cwd, request.coms_extension);
		const worker = realpathSync(join(this.options.extensionDir, "bootstrap", "worker.ts"));
		accessSync(worker, constants.R_OK);
		const piBinary = executableOnPath("pi", this.env);
		executableOnPath("herdr", this.env);
		// The worker instance is derived from the node (unique), never from the persona (which may repeat).
		const instances = mapped.map(({ node }, i) => `a${i + 1}-${node.node_id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`);
		const attempts = instances.map(instance => `${instance}.1`);
		return { cwd, goal, acceptance_criteria, constraints, nodes, readyTimeout, mapped, coms, worker, piBinary, instances, attempts };
	}

	/**
	 * Fingerprint of the plan's meaning, independent of JSON key order and of omitted-vs-explicit defaults,
	 * so an equivalent retry with the same request_id is recognized as the same plan. A plan whose node IDs are
	 * all its persona names (every legacy request, and the explicit form of one) keeps the exact fingerprint the
	 * previous release wrote, so old request IDs still find their runs after an upgrade.
	 */
	private fingerprint(request: GenerateRequest, cwd: string, nodes: PlannedNode[], readyTimeout: number, model?: { provider: string; id: string }, withOutcomes = true): string {
		const hasBriefOrContract = request.goal !== undefined || request.acceptance_criteria !== undefined || request.constraints !== undefined
			|| nodes.some(node => node.role !== undefined || node.ownership !== undefined || node.acceptance_criteria !== undefined
				|| node.constraints !== undefined || node.output_contract !== undefined || node.required_checks !== undefined);
		// Only a plan that sets dependency policies says so: every plan that behaves as the previous release did keeps its earlier fingerprint.
		const outcomes = withOutcomes && this.usesOutcomes(nodes) ? { outcomes: nodes.map(node => node.dependency_policy ?? null) } : {};
		const personaKeyed = nodes.every(node => node.node_id.toLowerCase() === node.persona.toLowerCase());
		const canonical = hasBriefOrContract ? {
			v: 4, topology: request.topology, task: request.task, goal: request.goal ?? null,
			acceptance_criteria: request.acceptance_criteria ?? null, constraints: request.constraints ?? null,
			project_cwd: cwd, ready_timeout_ms: readyTimeout,
			coms_extension: request.coms_extension ? resolve(cwd, request.coms_extension) : null,
			agents: nodes.map(node => ({
				node_id: node.node_id.toLowerCase(), persona: node.persona.toLowerCase(), sub_task: node.sub_task, step: node.step ?? null,
				role: node.role ?? null, ownership: node.ownership ?? null,
				acceptance_criteria: node.acceptance_criteria ?? null, constraints: node.constraints ?? null,
				output_contract: node.output_contract ?? null, required_checks: node.required_checks ?? null,
			})),
			model: model ? `${model.provider}/${model.id}` : null,
			...outcomes,
		} : {
			v: personaKeyed ? 2 : 3, topology: request.topology, task: request.task, project_cwd: cwd, ready_timeout_ms: readyTimeout,
			coms_extension: request.coms_extension ? resolve(cwd, request.coms_extension) : null,
			agents: nodes.map(node => personaKeyed ? [node.persona.toLowerCase(), node.sub_task, node.step ?? null] : [node.node_id.toLowerCase(), node.persona.toLowerCase(), node.sub_task, node.step ?? null]),
			model: model ? `${model.provider}/${model.id}` : null,
			...outcomes,
		};
		return createHash("sha256").update(hasBriefOrContract ? canonicalJson(canonical) : JSON.stringify(canonical)).digest("hex");
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
			: nodes.map(node => ({ ...original(node), name: node.node_id, step: node.step, predecessor: node.predecessor, successor: node.successor }));
		return createHash("sha256").update(JSON.stringify({ ...request, project_cwd: cwd, agents, request_id: undefined, model })).digest("hex");
	}

	/** Dry run: the complete resolved plan (personas, models, tools, extensions, links) without creating anything. */
	plan(request: GenerateRequest, model?: { provider: string; id: string }): PlanPreview {
		const { cwd, goal, acceptance_criteria, constraints, mapped, coms, instances, attempts, readyTimeout } = this.prepare(request, model);
		return {
			topology: request.topology, task: request.task,
			...(goal !== undefined ? { goal } : {}),
			...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
			...(constraints !== undefined ? { constraints } : {}),
			project_cwd: cwd, coms_extension: coms, ready_timeout_ms: readyTimeout,
			agents: mapped.map(({ node, def, extensions, resolvedModel }, i) => ({
				node_id: node.node_id, attempt_id: attempts[i], instance_id: instances[i], persona_name: def.name, persona_file: def.file, persona_source: def.source, model: resolvedModel,
				tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), extensions: [...new Set(extensions)],
				...(node.role !== undefined ? { role: node.role } : {}),
				...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
				...(node.acceptance_criteria !== undefined ? { acceptance_criteria: node.acceptance_criteria } : {}),
				...(node.constraints !== undefined ? { constraints: node.constraints } : {}),
				...(node.output_contract !== undefined ? { output_contract: node.output_contract } : {}),
				...(node.required_checks !== undefined ? { required_checks: node.required_checks } : {}),
				step: node.step,
				predecessor: request.topology === "chain" ? instances[i - 1] : undefined, successor: request.topology === "chain" ? instances[i + 1] : undefined,
				dependency_policy: node.dependency_policy,
				sub_task: node.sub_task,
			})),
		};
	}

	async generate(request: GenerateRequest, model?: { provider: string; id: string }, signal?: AbortSignal, update?: (manifest: BootstrapManifest) => void): Promise<BootstrapManifest> {
		checkAbort(signal);
		const { cwd, goal, acceptance_criteria, constraints, nodes, readyTimeout, mapped, coms, worker, piBinary, instances, attempts } = this.prepare(request, model);
		const fingerprint = this.fingerprint(request, cwd, nodes, readyTimeout, model);
		// Reservations written before the canonical fingerprint existed are still honored.
		const legacyFingerprint = this.oldestFingerprint(request, cwd, nodes, model);
		// A plan the previous release launched ran without policies; retrying its key must still find that run, not a "different plan".
		const priorFingerprint = this.usesOutcomes(nodes) ? this.fingerprint(request, cwd, nodes, readyTimeout, model, false) : undefined;
		const launchedBeforePolicies = (taskId: string): boolean => {
			try { return this.store.load(taskId).pane_manifest.every(entry => entry.dependency_policy === undefined); } catch { return false; }
		};
		const samePlan = (existing: { fingerprint: string; task_id: string }) => existing.fingerprint === fingerprint || existing.fingerprint === legacyFingerprint
			|| (priorFingerprint !== undefined && existing.fingerprint === priorFingerprint && launchedBeforePolicies(existing.task_id));
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
			const manifest: BootstrapManifest = {
				version: CURRENT_VERSION, request_form: requestForm(request.agents), task_id: taskId, task: request.task, topology: request.topology,
				project_cwd: cwd, session_dir: sessionDir, workspace_id: workspaceId, coms_project: `boot-${taskId}`,
				dispatcher_coms_name: dispatcher?.name, dispatcher_session_id: dispatcher?.session_id,
				status: "launching", phase: "planned", token: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				pane_manifest: mapped.map(({ node, def, resolvedModel }, i) => ({
				node_id: node.node_id, persona_name: def.name, attempt_id: attempts[i], instance_id: instances[i], expected_coms_name: instances[i], expected_model: resolvedModel, label: `${taskId}:${instances[i]}`,
				step: node.step, predecessor: i > 0 && request.topology === "chain" ? instances[i - 1] : undefined,
					successor: request.topology === "chain" ? instances[i + 1] : undefined, status: "planned",
					...(node.dependency_policy ? { dependency_policy: node.dependency_policy } : {}), ...(requiredChecksOf(node).length ? { required_checks: requiredChecksOf(node) } : {}),
				})),
			};
			this.store.assertDirectory(manifest);
			this.store.save(manifest);
			// Atomic, complete reservation: a concurrent process must not create a second fleet for the same key,
			// and a crash can never leave an empty or partial reservation behind.
			mkdirSync(this.store.indexRoot, { recursive: true, mode: 0o700 });
			if (!publishExclusive(requestPath, JSON.stringify({ fingerprint, task_id: taskId }))) {
				// Nothing was launched for this losing plan: remove its files instead of leaving an orphan run behind.
				try { this.store.assertDirectory(manifest); rmSync(sessionDir, { recursive: true }); rmSync(join(this.store.indexRoot, `${taskId}.json`), { force: true }); }
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
						const { node, def, extensions } = mapped[i];
						const entry = manifest.pane_manifest[i];
						const config: WorkerConfig = {
						version: CURRENT_VERSION, task_id: taskId, token: manifest.token, session_dir: sessionDir, project_cwd: cwd,
							coms_dir: this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), coms_project: manifest.coms_project,
							instance_id: entry.instance_id, node_id: node.node_id, persona_name: def.name, attempt_id: entry.attempt_id,
							persona: def.systemPrompt, expected_model: entry.expected_model,
							tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), sub_task: node.sub_task,
							topology: request.topology, step: node.step, predecessor: entry.predecessor, successor: entry.successor,
							dependency_policy: node.dependency_policy,
							// Chains hand results over durably: the source records an offer, the destination claims it before model work (handoff.ts).
							...(request.topology === "chain" ? { handoff_protocol: HANDOFF_PROTOCOL } : {}),
							startup_message: `bootstrap-start:${manifest.token}:${entry.instance_id}`, ready_timeout_ms: readyTimeout + nodes.length * 30_000 + 15_000,
							task: request.task,
							...(goal !== undefined ? { goal } : {}),
							...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
							...(constraints !== undefined ? { constraints } : {}),
							...(node.role !== undefined ? { role: node.role } : {}),
							...(node.ownership !== undefined ? { ownership: node.ownership } : {}),
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
								...(node.acceptance_criteria !== undefined ? { acceptance_criteria: node.acceptance_criteria } : {}),
								...(node.constraints !== undefined ? { constraints: node.constraints } : {}),
								...(node.output_contract !== undefined ? { output_contract: node.output_contract } : {}),
								...(node.required_checks !== undefined ? { required_checks: node.required_checks } : {}),
							},
							roster: fullRoster,
							...(Object.keys(upstreamContracts).length > 0 ? { upstream_contracts: upstreamContracts } : {}),
						});
						atomicJson(taskInputPath(sessionDir, entry.instance_id), inputRecord);
						const configPath = join(sessionDir, `${entry.instance_id}.config.json`);
						atomicJson(configPath, config);
						const personaExtensions = [...new Set(extensions)].filter(ext => ext !== coms && ext !== worker);
						const args = ["-e", coms, ...personaExtensions.flatMap(ext => ["-e", ext]), "-e", worker,
							"--cname", entry.instance_id, "--purpose", `Bootstrap ${taskId}: ${nodeLabel(entry)}`, "--project", manifest.coms_project,
							"--model", entry.expected_model, "--bootstrap-worker-config", configPath, config.startup_message];
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
					const deadline = Date.now() + readyTimeout;
					while (manifest.pane_manifest.some(entry => entry.status !== "ready")) {
						checkAbort(signal);
						for (const entry of manifest.pane_manifest) {
							const failure = join(sessionDir, `${entry.instance_id}.error.json`);
							if (existsSync(failure)) throw new Error(`${nodeLabel(entry)}: ${readJson<{ error: string }>(failure).error}`);
							if (entry.status === "ready" || !existsSync(readyPath(sessionDir, entry.instance_id))) continue;
							const ready = readJson<WorkerReady>(readyPath(sessionDir, entry.instance_id));
							if (ready.task_id !== taskId || ready.token !== manifest.token || ready.instance_id !== entry.instance_id || ready.name !== entry.expected_coms_name || typeof ready.model !== "string" || !modelMatches(entry.expected_model, ready.model) || !ready.session_id || !ready.endpoint || !Number.isInteger(ready.pid)) throw new Error(`Invalid readiness acknowledgement for ${nodeLabel(entry)}`);
if (!processAlive(ready)) throw new Error(`${nodeLabel(entry)} exited after acknowledging readiness`);
							entry.status = "ready"; this.store.save(manifest); update?.(manifest);
						}
						if (manifest.pane_manifest.every(entry => entry.status === "ready")) break;
						if (Date.now() >= deadline) throw new Error(`Readiness timeout. Not ready: ${manifest.pane_manifest.filter(entry => entry.status !== "ready").map(entry => nodeLabel(entry)).join(", ")}`);
						await delay(this.options.pollMs ?? 100, signal);
					}
					checkAbort(signal);
					// A worker may have exited after its first acknowledgement while another was starting.
					for (const entry of manifest.pane_manifest) {
						const ready = readJson<WorkerReady>(readyPath(sessionDir, entry.instance_id));
						if (ready.task_id !== taskId || ready.token !== manifest.token || !modelMatches(entry.expected_model, ready.model) || ready.instance_id !== entry.instance_id) throw new Error(`Readiness changed before release for ${nodeLabel(entry)}`);
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
					manifest.status = "error"; manifest.phase = signal?.aborted ? "cancelled" : "failed"; manifest.error = errorMessage(error);
					// Unreleased children see this marker and shut down, instead of waiting forever.
					try { atomicJson(join(sessionDir, "abort.json"), { task_id: taskId, token: manifest.token, error: manifest.error }); } catch { /* index remains recovery source */ }
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

	status(taskId: string, cwd?: string): RunStatus {
		const manifest = this.reconcile(this.store.load(taskId, cwd), false);
		const results: BootstrapResult[] = [];
		const pending: string[] = [];
		const deliveryErrors: string[] = [];
		const workerErrors: string[] = [];
		const agents: AgentState[] = [];
		const available = !manifest.session_dir_removed;
		// A node is settled once it has a result, or a record that it never executed: a successor's undelivered handoff no longer matters then.
		const finished = new Set(manifest.pane_manifest.filter(entry => available && (existsSync(resultPath(manifest.session_dir, entry.instance_id)) || existsSync(dispositionPath(manifest.session_dir, entry.instance_id)))).map(entry => entry.instance_id));
		const exited = (entry: (typeof manifest.pane_manifest)[number]): boolean => {
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (!available || entry.status === "closed" || !existsSync(readyFile)) return false;
			try { return !processAlive(readJson<WorkerReady>(readyFile)); } catch { return false; }
		};
		const now = Date.now();
		// Handoff records, keyed by the destination: delivery (queued), acceptance and rejection are read from the durable records alone.
		const handoffs = new Map<string, HandoffView>();
		if (available) for (const entry of manifest.pane_manifest) {
			if (!entry.predecessor) continue;
			try { const view = describeHandoff(manifest.session_dir, entry.predecessor, entry.instance_id); if (view) handoffs.set(entry.instance_id, view); } catch { /* one unreadable record must not hide the run */ }
		}
		for (const entry of manifest.pane_manifest) {
			const label = nodeLabel(entry);
			const state: AgentState = {
				node_id: entry.node_id, persona_name: entry.persona_name, attempt_id: entry.attempt_id, instance_id: entry.instance_id, tab_id: entry.tab_id, state: entry.status === "closed" ? "closed" : "pending",
				dependency_policy: dependencyPolicyOf(entry, entry.predecessor !== undefined), resource: entry.status, execution: "pending", execution_causes: [],
			};
			agents.push(state);
			const handoff = handoffs.get(entry.instance_id);
			if (handoff) state.handoff = handoff;
			const outbound = entry.successor ? handoffs.get(entry.successor) : undefined;
			if (outbound) state.handoff_out = outbound;
			if (handoff?.problems.length) workerErrors.push(`${label}: handoff evidence problem: ${handoff.problems.join("; ")}`);
			let heartbeat: "working" | "waiting" | undefined;
			const failure = join(manifest.session_dir, `${entry.instance_id}.error.json`);
			if (available && existsSync(failure)) {
				// A torn or foreign file must not hide every other agent's status.
				let message: string;
				try { message = String(readJson<{ error: string }>(failure).error); } catch (error) { message = `unreadable error record (${errorMessage(error)})`; }
				workerErrors.push(`${label}: ${message}`);
				state.error = message;
			}
			if (available) {
				try {
					const progress = readJson<{ token: string; updated_at: number; state: string; activity_at?: number }>(join(manifest.session_dir, `${entry.instance_id}.progress.json`));
					if (progress.token === manifest.token && Number.isFinite(progress.updated_at)) {
						state.heartbeat_age_ms = Math.max(0, now - progress.updated_at);
						if (Number.isFinite(progress.activity_at)) state.activity_age_ms = Math.max(0, now - progress.activity_at!);
						heartbeat = progress.state === "working" ? "working" : "waiting";
						if (state.state === "pending") state.state = heartbeat;
					}
				} catch { /* no heartbeat yet */ }
			}
			const path = resultPath(manifest.session_dir, entry.instance_id);
			let completion: WorkerCompletion | undefined;
			if (available && existsSync(path)) {
				// One unreadable or foreign result must not hide the rest of the run.
				try {
					completion = parseCompletion(readJson<unknown>(path), expectationFor(manifest, entry));
				} catch (error) {
					completion = undefined;
					state.error = `unusable result file: ${errorMessage(error)}`;
					workerErrors.push(`${label}: ${state.error}`);
				}
			}
			// A node that never executed has a disposition instead of a result; the worker's result, when there is one, is authoritative.
			let disposition: Disposition | undefined;
			const dispositionFile = dispositionPath(manifest.session_dir, entry.instance_id);
			if (available && !completion && existsSync(dispositionFile)) {
				try { disposition = parseDisposition(readJson<unknown>(dispositionFile), expectationFor(manifest, entry)); }
				catch (error) { state.error = `unusable disposition file: ${errorMessage(error)}`; workerErrors.push(`${label}: ${state.error}`); }
			}
			if (completion) {
				results.push({ ...completion.result, node_id: entry.node_id });
				state.execution = executionFromResult(completion.result.status).state; state.execution_reason = completion.result.summary;
				state.result_status = completion.result.status; state.summary = completion.result.summary; state.delivery = completion.delivery;
				if (state.state !== "closed") state.state = "done";
				// Once the successor has its own durable result, an undelivered handoff no longer matters
				// (e.g. a follower that already failed itself on an upstream failure).
				// An accepted handoff proves delivery whatever the source recorded (e.g. a lost acknowledgement).
					const handoffSettled = entry.successor !== undefined && (finished.has(entry.successor) || handoffs.get(entry.successor)?.state === "accepted");
				if (completion.delivery === "failed" && !handoffSettled) deliveryErrors.push(`${label}: ${completion.delivery_error}`);
				if (completion.delivery === "pending" && !handoffSettled) {
					pending.push(entry.node_id);
					if (exited(entry)) { workerErrors.push(`${label}: process exited during chain handoff`); state.error ??= "process exited during chain handoff"; }
				}
			} else if (disposition) {
				state.execution = disposition.state; state.execution_causes = disposition.causes; state.execution_reason = disposition.reason;
				if (disposition.state === "needs_attention") { state.error ??= disposition.reason; workerErrors.push(`${label}: needs attention: ${disposition.reason}`); pending.push(entry.node_id); }
				else if (state.state !== "closed") state.state = "done";
			} else {
				pending.push(entry.node_id);
				// An accepted handoff with no result is the case where effects are unknown: the task is never replayed on its own.
				const accepted = handoff?.state === "accepted" ? `accepted handoff ${handoff.handoff_id ?? `from ${handoff.source}`}` : undefined;
				if (exited(entry)) {
					const message = accepted ? `process exited after it ${accepted}; no result was recorded and the task is not replayed automatically` : "process exited before recording a result";
					workerErrors.push(`${label}: ${message}`); state.error ??= message;
				}
				// Closing a node's tab or pane is a resource operation, not a cancellation: with no outcome on record, the outcome is unknown.
				if (state.error || state.state === "closed") {
					state.execution = "needs_attention";
					state.execution_reason = state.error ?? (accepted ? `Resource closed after it ${accepted}; no result was recorded and the task is not replayed automatically` : "Resource closed before an outcome was recorded");
					if (accepted && !state.execution_reason.includes("not replayed")) state.execution_reason += `; it ${accepted} and no result was recorded, so the task is not replayed automatically`;
				}
				else state.execution = heartbeat === "working" ? "running" : heartbeat === "waiting" ? "waiting" : "pending";
			}
			if (available && existsSync(verificationPath(manifest.session_dir, entry.instance_id))) {
				try {
					const ver = evaluateNodeVerification(manifest.session_dir, entry.instance_id, manifest.project_cwd, undefined, manifest.task_id);
					if (ver.evaluations.length) state.verification = ver.evaluations;
				} catch (error) {
					workerErrors.push(`${label}: unusable verification record: ${errorMessage(error)}`);
				}
			}
			if (state.error && state.state !== "done" && state.state !== "closed") state.state = "error";
			// Evidence for the checks this node must pass, against the project as it is now.
			if (available && entry.required_checks?.length) state.evidence = verifyEvidence(manifest.session_dir, entry.instance_id, manifest.project_cwd, entry.required_checks, manifest.task_id).map(({ check, status }) => ({ check, status }));
		}
		return { manifest, results, pending, delivery_errors: deliveryErrors, worker_errors: workerErrors, agents, outcome: aggregateRun(agents.map(agent => agent.execution)) };
	}

	/**
	 * Inspect (read-only) or repair the delivery of chain handoffs from saved evidence; see recovery.ts. Repair holds the run lock, so it is serialized with
	 * launch, report and cleanup.
	 */
	async recover(taskId: string, request: RecoveryRequest, options: RecoveryDeps & { cwd?: string } = {}): Promise<RecoveryReport> {
		const select = (manifest: BootstrapManifest): AgentLaunch[] => {
			if (manifest.session_dir_removed) throw new Error("Session files are unavailable; handoff recovery needs them");
			if (manifest.topology !== "chain") throw new Error("Only a chain has handoffs to recover");
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
			const [edge] = chainEdges(manifest, select(manifest));
			if (!edge) throw new Error(`${request.agent} has no inbound handoff (it is the first step). To repair delivery from a node, name its successor`);
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
		const deadline = Date.now() + waitMs;
		for (;;) {
			const status = this.status(taskId, cwd);
			const settled = !status.pending.length || status.worker_errors.length > 0 || status.delivery_errors.length > 0
				|| status.manifest.status === "error" || status.manifest.status === "cleaned" || !!status.manifest.session_dir_removed;
			const remaining = deadline - Date.now();
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
				return { ...result, agent_name: entry.persona_name, node_id: entry.node_id, execution_state: executionFromResult(result.status).state };
			});
			if (seen.size + notExecuted.size !== entries.length) throw new Error(`Report must include exactly one result for each planned agent${notExecuted.size ? ` that executed (${[...notExecuted.keys()].map(entry => entry.node_id).join(", ")} did not execute and are reported from their records)` : ""}`);
			for (const [entry, agent] of notExecuted) {
				const state = agent.execution as NotExecutedEntry["status"];
				collected.push({ agent_name: entry.persona_name, node_id: entry.node_id, status: state, summary: `Not executed (${state}): ${agent.execution_reason ?? "no reason recorded"}`, detail: "", execution_state: state, causes: agent.execution_causes });
			}
			// Plan order for the nodes the report supplied no order for; explicit results keep the order they were given.
			if (!results) collected.sort((a, b) => entries.findIndex(entry => entry.node_id === a.node_id) - entries.findIndex(entry => entry.node_id === b.node_id));
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

	async cleanup(taskId: string, tabIds?: string[], deleteSessionFiles = false, cwd?: string, signal?: AbortSignal, agentNames?: string[]): Promise<BootstrapManifest> {
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			const manifest = this.reconcile(this.store.load(taskId, cwd, true), true);
			if (manifest.status === "cleaned" && (!deleteSessionFiles || manifest.session_dir_removed)) return manifest;
			if (tabIds?.length === 0) throw new Error("tab_ids must not be empty; omit it to clean all owned tabs");
			if (agentNames?.length === 0) throw new Error("agents must not be empty; omit it to clean all owned tabs");
			if (tabIds?.some(id => !manifest.pane_manifest.some(entry => entry.tab_id === id))) throw new Error("Refusing to close tab IDs not owned by this bootstrap run");
			// Agent names and instance IDs are stable; recorded tab IDs can go stale when Herdr compacts IDs.
			// Node IDs and instance IDs are stable; a persona name works only when it names exactly one node.
			const byAgent = new Set<AgentLaunch>();
			for (const selector of agentNames ?? []) {
			const found = selectAgents(manifest.pane_manifest, selector);
			if (!found.length) throw new Error(`Unknown agent for this bootstrap run: ${selector}`);
			for (const entry of found) byAgent.add(entry);
			}
			const subset = tabIds !== undefined || agentNames !== undefined;
			const selected = subset ? manifest.pane_manifest.filter(entry => (entry.tab_id !== undefined && !!tabIds?.includes(entry.tab_id)) || byAgent.has(entry)) : manifest.pane_manifest;
			manifest.cleanup_errors = [];
			manifest.cleanup_notes = [];
			// A full cleanup ends the run: children still at the readiness barrier must exit. A subset close does not.
			if (!subset && !manifest.session_dir_removed) atomicJson(join(manifest.session_dir, "abort.json"), { task_id: taskId, token: manifest.token, error: "Run cleaned up" });
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
					entry.status = "closed"; this.store.save(manifest);
				} catch (error) { manifest.cleanup_errors.push(`${nodeLabel(entry)}: ${errorMessage(error)}`); }
			}
			const allClosed = manifest.pane_manifest.every(entry => entry.status === "closed" || entry.status === "planned");
			if (allClosed && !manifest.cleanup_errors.length) { manifest.status = "cleaned"; manifest.phase = "cleaned"; }
			// A successful subset close leaves the run's status alone; the other agents keep running.
			else if (subset && !manifest.cleanup_errors.length) manifest.phase = "partially-cleaned";
			else { manifest.status = "error"; manifest.phase = "cleanup-incomplete"; }
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
