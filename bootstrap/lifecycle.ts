/** Launch orchestration; Herdr subprocess execution is the only injected system boundary. */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ensureSessionDir, generateTaskId, resolveExtensionPaths, scanAgents } from "./bootstrap-utils.ts";
import { modelMatches, resolveModel } from "./model-utils.ts";
import {
	atomicJson, atomicText, checkAbort, delay, errorMessage, lockHeld, processAlive, publishExclusive, readJson, readyPath, resultPath, SessionStore, withRunLock,
	type BootstrapManifest, type BootstrapResult, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";

export interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean; truncated?: boolean }
export type Executor = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;
export interface RequestedAgent { name: string; sub_task: string; step?: number; predecessor?: string; successor?: string }
export interface GenerateRequest {
	topology: "chain" | "team";
	task: string;
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
	agent_name: string;
	instance_id: string;
	tab_id?: string;
	state: "pending" | "waiting" | "working" | "done" | "error" | "closed";
	result_status?: BootstrapResult["status"];
	summary?: string;
	delivery?: WorkerCompletion["delivery"];
	heartbeat_age_ms?: number;
	/** Time since the worker's last model/tool activity; a live heartbeat with stale activity suggests a stall. */
	activity_age_ms?: number;
	error?: string;
}
export interface RunStatus { manifest: BootstrapManifest; results: BootstrapResult[]; pending: string[]; delivery_errors: string[]; worker_errors: string[]; agents: AgentState[] }
interface LiveTopology { tabs: any[]; panes: any[] }
export interface PlanPreview {
	topology: "chain" | "team"; task: string; project_cwd: string; coms_extension: string; ready_timeout_ms: number;
	agents: Array<{ instance_id: string; agent_name: string; persona_file: string; persona_source?: string; model: string; tools: string[]; extensions: string[]; step?: number; predecessor?: string; successor?: string; sub_task: string }>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a non-empty string without NUL characters`);
	return value;
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

export function normalizeAgents(topology: "chain" | "team", requested: RequestedAgent[]): RequestedAgent[] {
	if (!Array.isArray(requested) || requested.length < 1 || requested.length > 32) throw new Error("Bootstrap requires between 1 and 32 agents");
	const seen = new Set<string>();
	for (const agent of requested) {
		const name = requiredString(agent.name, "Agent name").trim();
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new Error(`Unsafe agent name: ${name}`);
		if (seen.has(name.toLowerCase())) throw new Error(`Duplicate agent name: ${name}`);
		seen.add(name.toLowerCase());
		requiredString(agent.sub_task, `sub_task for ${name}`);
	}
	let agents = requested.map(agent => ({ ...agent, name: agent.name.trim() }));
	if (topology === "team") {
		if (agents.some(agent => agent.step !== undefined || agent.predecessor || agent.successor)) throw new Error("Team agents cannot declare chain links or steps");
		return agents;
	}
	const explicitSteps = agents.some(agent => agent.step !== undefined);
	if (explicitSteps) {
		if (agents.some(agent => !Number.isInteger(agent.step) || agent.step! < 1 || agent.step! > agents.length)) throw new Error("Chain steps must be contiguous integers from 1 to the number of agents");
		agents.sort((a, b) => a.step! - b.step!);
		if (agents.some((agent, i) => agent.step !== i + 1)) throw new Error("Chain steps must be unique and contiguous");
	}
	return agents.map((agent, i) => {
		const predecessor = agents[i - 1]?.name;
		const successor = agents[i + 1]?.name;
		// The chain's ends may be named "dispatcher" (or left empty) by callers.
		const end = (value: string) => ["", "dispatcher"].includes(value.trim().toLowerCase());
		if (agent.predecessor !== undefined && (predecessor ? agent.predecessor.trim().toLowerCase() !== predecessor.toLowerCase() : !end(agent.predecessor))) throw new Error(`Invalid predecessor for ${agent.name}`);
		if (agent.successor !== undefined && (successor ? agent.successor.trim().toLowerCase() !== successor.toLowerCase() : !end(agent.successor))) throw new Error(`Invalid successor for ${agent.name}`);
		return { ...agent, step: i + 1, predecessor, successor };
	});
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
		if (!isAbsolute(requiredString(request.project_cwd, "project_cwd"))) throw new Error("project_cwd must be absolute");
		const cwd = realpathSync(request.project_cwd);
		if (!statSync(cwd).isDirectory()) throw new Error("project_cwd must be a directory");
		const agents = normalizeAgents(request.topology, request.agents);
		const readyTimeout = request.ready_timeout_ms ?? 60_000;
		if (!Number.isInteger(readyTimeout) || readyTimeout < 100 || readyTimeout > 300_000) throw new Error("ready_timeout_ms must be an integer between 100 and 300000");
		const available = scanAgents(cwd, this.home);
		const mapped = agents.map(agent => {
			const def = available.find(def => def.name.toLowerCase() === agent.name.toLowerCase());
			if (!def) throw new Error(`Agent "${agent.name}" not found. Available: ${available.map(def => def.name).join(", ") || "none"}`);
			// Project extensions win; a global persona also finds extensions beside its own agents directory.
			const extensions = resolveExtensionPaths(cwd, def.extensions ?? [], [join(dirname(dirname(def.file)), "extensions"), this.options.extensionDir])
				.map(path => realpathSync(path));
			return { agent, def, extensions, resolvedModel: resolveModel(def.model, model) };
		});
		const coms = this.comsExtension(cwd, request.coms_extension);
		const worker = realpathSync(join(this.options.extensionDir, "bootstrap", "worker.ts"));
		accessSync(worker, constants.R_OK);
		const piBinary = executableOnPath("pi", this.env);
		executableOnPath("herdr", this.env);
		const instances = mapped.map(({ agent }, i) => `a${i + 1}-${agent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`);
		return { cwd, agents, readyTimeout, mapped, coms, worker, piBinary, instances };
	}

	/**
	 * Fingerprint of the plan's meaning, independent of JSON key order and of omitted-vs-explicit defaults,
	 * so an equivalent retry with the same request_id is recognized as the same plan.
	 */
	private fingerprint(request: GenerateRequest, cwd: string, agents: RequestedAgent[], readyTimeout: number, model?: { provider: string; id: string }): string {
		const canonical = {
			v: 2, topology: request.topology, task: request.task, project_cwd: cwd, ready_timeout_ms: readyTimeout,
			coms_extension: request.coms_extension ? resolve(cwd, request.coms_extension) : null,
			agents: agents.map(agent => [agent.name.toLowerCase(), agent.sub_task, agent.step ?? null]),
			model: model ? `${model.provider}/${model.id}` : null,
		};
		return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
	}

	/** Dry run: the complete resolved plan (personas, models, tools, extensions, links) without creating anything. */
	plan(request: GenerateRequest, model?: { provider: string; id: string }): PlanPreview {
		const { cwd, mapped, coms, instances, readyTimeout } = this.prepare(request, model);
		return {
			topology: request.topology, task: request.task, project_cwd: cwd, coms_extension: coms, ready_timeout_ms: readyTimeout,
			agents: mapped.map(({ agent, def, extensions, resolvedModel }, i) => ({
				instance_id: instances[i], agent_name: def.name, persona_file: def.file, persona_source: def.source, model: resolvedModel,
				tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), extensions: [...new Set(extensions)], step: agent.step,
				predecessor: request.topology === "chain" ? instances[i - 1] : undefined, successor: request.topology === "chain" ? instances[i + 1] : undefined,
				sub_task: agent.sub_task,
			})),
		};
	}

	async generate(request: GenerateRequest, model?: { provider: string; id: string }, signal?: AbortSignal, update?: (manifest: BootstrapManifest) => void): Promise<BootstrapManifest> {
		checkAbort(signal);
		const { cwd, agents, readyTimeout, mapped, coms, worker, piBinary, instances } = this.prepare(request, model);
		const fingerprint = this.fingerprint(request, cwd, agents, readyTimeout, model);
		// Reservations written before the canonical fingerprint existed are still honored.
		const legacyFingerprint = createHash("sha256").update(JSON.stringify({ ...request, project_cwd: cwd, agents, request_id: undefined, model })).digest("hex");
		const samePlan = (existing: { fingerprint: string }) => existing.fingerprint === fingerprint || existing.fingerprint === legacyFingerprint;
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
				version: 1, task_id: taskId, task: request.task, topology: request.topology,
				project_cwd: cwd, session_dir: sessionDir, workspace_id: workspaceId, coms_project: `boot-${taskId}`,
				dispatcher_coms_name: dispatcher?.name, dispatcher_session_id: dispatcher?.session_id,
				status: "launching", phase: "planned", token: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
				pane_manifest: mapped.map(({ agent, resolvedModel }, i) => ({
					agent_name: agent.name, instance_id: instances[i], expected_coms_name: instances[i], expected_model: resolvedModel, label: `${taskId}:${instances[i]}`,
					step: agent.step, predecessor: i > 0 && request.topology === "chain" ? instances[i - 1] : undefined,
					successor: request.topology === "chain" ? instances[i + 1] : undefined, status: "planned",
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
			const roster = mapped.map(({ agent }, i) => ({ instance_id: instances[i], agent_name: agent.name, step: agent.step, sub_task: agent.sub_task.slice(0, 500) }));
				let releaseWritten = false;
				try {
					for (let i = 0; i < mapped.length; i++) {
						checkAbort(signal);
						const { agent, def, extensions } = mapped[i];
						const entry = manifest.pane_manifest[i];
						const config: WorkerConfig = {
							task_id: taskId, token: manifest.token, session_dir: sessionDir, project_cwd: cwd,
							coms_dir: this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), coms_project: manifest.coms_project,
							instance_id: entry.instance_id, agent_name: agent.name, persona: def.systemPrompt, expected_model: entry.expected_model,
							tools: def.tools.split(",").map(tool => tool.trim()).filter(Boolean), sub_task: agent.sub_task,
							topology: request.topology, step: agent.step, predecessor: entry.predecessor, successor: entry.successor,
							startup_message: `bootstrap-start:${manifest.token}:${entry.instance_id}`, ready_timeout_ms: readyTimeout + agents.length * 30_000 + 15_000,
							task: request.task, roster,
						};
						const configPath = join(sessionDir, `${entry.instance_id}.config.json`);
						atomicJson(configPath, config);
						const personaExtensions = [...new Set(extensions)].filter(ext => ext !== coms && ext !== worker);
						const args = ["-e", coms, ...personaExtensions.flatMap(ext => ["-e", ext]), "-e", worker,
							"--cname", entry.instance_id, "--purpose", `Bootstrap ${taskId}: ${agent.name}`, "--project", manifest.coms_project,
							"--model", entry.expected_model, "--bootstrap-worker-config", configPath, config.startup_message];
						// Only the short launcher path crosses the user's shell/PTY. All arbitrary task text stays in files.
						const launcher = join(sessionDir, `${entry.instance_id}.sh`);
						atomicText(launcher, `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${[piBinary, ...args].map(shellQuote).join(" ")}\n`);
						entry.status = "creating"; manifest.phase = `creating:${entry.instance_id}`; this.store.save(manifest); update?.(manifest);
						try {
							const created = await this.json(["tab", "create", "--workspace", workspaceId, "--label", entry.label, "--cwd", cwd, "--no-focus",
								"--env", `PI_COMS_DIR=${config.coms_dir}`, "--env", "PI_COMS_TIMEOUT_MS=300000", "--env", `PI_COMS_MAX_HOPS=${Math.max(5, agents.length + 2)}`], signal);
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
							if (existsSync(failure)) throw new Error(`${entry.agent_name}: ${readJson<{ error: string }>(failure).error}`);
							if (entry.status === "ready" || !existsSync(readyPath(sessionDir, entry.instance_id))) continue;
							const ready = readJson<WorkerReady>(readyPath(sessionDir, entry.instance_id));
							if (ready.task_id !== taskId || ready.token !== manifest.token || ready.instance_id !== entry.instance_id || ready.name !== entry.expected_coms_name || typeof ready.model !== "string" || !modelMatches(entry.expected_model, ready.model) || !ready.session_id || !ready.endpoint || !Number.isInteger(ready.pid)) throw new Error(`Invalid readiness acknowledgement for ${entry.agent_name}`);
							if (!processAlive(ready)) throw new Error(`${entry.agent_name} exited after acknowledging readiness`);
							entry.status = "ready"; this.store.save(manifest); update?.(manifest);
						}
						if (manifest.pane_manifest.every(entry => entry.status === "ready")) break;
						if (Date.now() >= deadline) throw new Error(`Readiness timeout. Not ready: ${manifest.pane_manifest.filter(entry => entry.status !== "ready").map(entry => entry.agent_name).join(", ")}`);
						await delay(this.options.pollMs ?? 100, signal);
					}
					checkAbort(signal);
					// A worker may have exited after its first acknowledgement while another was starting.
					for (const entry of manifest.pane_manifest) {
						const ready = readJson<WorkerReady>(readyPath(sessionDir, entry.instance_id));
						if (ready.task_id !== taskId || ready.token !== manifest.token || !modelMatches(entry.expected_model, ready.model) || ready.instance_id !== entry.instance_id) throw new Error(`Readiness changed before release for ${entry.agent_name}`);
						if (!processAlive(ready)) throw new Error(`${entry.agent_name} exited before work was released`);
						const registry = readJson<RegistryEntry>(join(this.env.PI_COMS_DIR ?? join(this.home, ".pi", "coms"), "projects", manifest.coms_project, "agents", `${entry.instance_id}.json`));
						if (registry.pid !== ready.pid || registry.session_id !== ready.session_id || registry.name !== entry.instance_id) throw new Error(`Coms identity changed before release for ${entry.agent_name}`);
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
		const finished = new Set(manifest.pane_manifest.filter(entry => available && existsSync(resultPath(manifest.session_dir, entry.instance_id))).map(entry => entry.instance_id));
		const exited = (entry: (typeof manifest.pane_manifest)[number]): boolean => {
			const readyFile = readyPath(manifest.session_dir, entry.instance_id);
			if (!available || entry.status === "closed" || !existsSync(readyFile)) return false;
			try { return !processAlive(readJson<WorkerReady>(readyFile)); } catch { return false; }
		};
		const now = Date.now();
		for (const entry of manifest.pane_manifest) {
			const state: AgentState = { agent_name: entry.agent_name, instance_id: entry.instance_id, tab_id: entry.tab_id, state: entry.status === "closed" ? "closed" : "pending" };
			agents.push(state);
			const failure = join(manifest.session_dir, `${entry.instance_id}.error.json`);
			if (available && existsSync(failure)) {
				// A torn or foreign file must not hide every other agent's status.
				let message: string;
				try { message = String(readJson<{ error: string }>(failure).error); } catch (error) { message = `unreadable error record (${errorMessage(error)})`; }
				workerErrors.push(`${entry.agent_name}: ${message}`);
				state.error = message;
			}
			if (available) {
				try {
					const progress = readJson<{ token: string; updated_at: number; state: string; activity_at?: number }>(join(manifest.session_dir, `${entry.instance_id}.progress.json`));
					if (progress.token === manifest.token && Number.isFinite(progress.updated_at)) {
						state.heartbeat_age_ms = Math.max(0, now - progress.updated_at);
						if (Number.isFinite(progress.activity_at)) state.activity_age_ms = Math.max(0, now - progress.activity_at!);
						if (state.state === "pending") state.state = progress.state === "working" ? "working" : "waiting";
					}
				} catch { /* no heartbeat yet */ }
			}
			const path = resultPath(manifest.session_dir, entry.instance_id);
			let completion: WorkerCompletion | undefined;
			if (available && existsSync(path)) {
				// One unreadable or foreign result must not hide the rest of the run.
				try {
					completion = readJson<WorkerCompletion>(path);
					if (!completion?.result || typeof completion.result.summary !== "string" || !["success", "partial", "failure"].includes(completion.result.status)) throw new Error("malformed result record");
					if (completion.result.agent_name !== entry.agent_name) throw new Error(`result identity mismatch (recorded for ${completion.result.agent_name})`);
				} catch (error) {
					completion = undefined;
					state.error = `unusable result file: ${errorMessage(error)}`;
					workerErrors.push(`${entry.agent_name}: ${state.error}`);
				}
			}
			if (completion) {
				results.push(completion.result);
				state.result_status = completion.result.status; state.summary = completion.result.summary; state.delivery = completion.delivery;
				if (state.state !== "closed") state.state = "done";
				// Once the successor has its own durable result, an undelivered handoff no longer matters
				// (e.g. a follower that already failed itself on an upstream failure).
				const handoffSettled = entry.successor !== undefined && finished.has(entry.successor);
				if (completion.delivery === "failed" && !handoffSettled) deliveryErrors.push(`${entry.agent_name}: ${completion.delivery_error}`);
				if (completion.delivery === "pending" && !handoffSettled) {
					pending.push(entry.agent_name);
					if (exited(entry)) { workerErrors.push(`${entry.agent_name}: process exited during chain handoff`); state.error ??= "process exited during chain handoff"; }
				}
			} else {
				pending.push(entry.agent_name);
				if (exited(entry)) { workerErrors.push(`${entry.agent_name}: process exited before recording a result`); state.error ??= "process exited before recording a result"; }
			}
			if (state.error && state.state !== "done" && state.state !== "closed") state.state = "error";
		}
		return { manifest, results, pending, delivery_errors: deliveryErrors, worker_errors: workerErrors, agents };
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

	async report(taskId: string, results: BootstrapResult[] | undefined, markdown: boolean, render: (results: BootstrapResult[]) => string, cwd?: string): Promise<{ report_json: string; report_md?: string; results: BootstrapResult[] }> {
		return withRunLock(join(this.store.indexRoot, taskId), async () => {
			this.reconcile(this.store.load(taskId, cwd, true), true);
			const status = this.status(taskId, cwd);
			if (status.manifest.session_dir_removed) throw new Error(status.manifest.session_files_deleted ? "Session files were explicitly deleted; reports can no longer be written" : "Session files are unavailable (the project directory is missing); reports cannot be written");
			if (!results && (status.pending.length || status.delivery_errors.length || status.worker_errors.length)) throw new Error(`Run is not complete. Pending: ${status.pending.join(", ") || "none"}. Delivery errors: ${status.delivery_errors.join("; ") || "none"}. Worker errors: ${status.worker_errors.join("; ") || "none"}`);
			const collected = results ?? status.results;
			const expected = new Set(status.manifest.pane_manifest.map(entry => entry.agent_name.toLowerCase()));
			const seen = new Set<string>();
			for (const result of collected) {
				const name = result.agent_name.toLowerCase();
				if (!expected.has(name) || seen.has(name)) throw new Error(`Unknown or duplicate result agent: ${result.agent_name}`);
				seen.add(name);
			}
			if (seen.size !== expected.size) throw new Error("Report must include exactly one result for each planned agent");
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
			const byAgent = (entry: BootstrapManifest["pane_manifest"][number], selector: string) => [entry.instance_id, entry.agent_name.toLowerCase()].includes(selector.trim().toLowerCase());
			const unknownAgent = agentNames?.find(selector => !manifest.pane_manifest.some(entry => byAgent(entry, selector)));
			if (unknownAgent !== undefined) throw new Error(`Unknown agent for this bootstrap run: ${unknownAgent}`);
			const subset = tabIds !== undefined || agentNames !== undefined;
			const selected = subset ? manifest.pane_manifest.filter(entry => (entry.tab_id !== undefined && !!tabIds?.includes(entry.tab_id)) || !!agentNames?.some(selector => byAgent(entry, selector))) : manifest.pane_manifest;
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
						if (owned.length > 1) throw new Error(`Ambiguous terminal ownership for ${entry.agent_name}`);
						if (owned.length === 1) {
							ownedTabId = requiredString(owned[0].tab_id, "Owned tab_id");
							// A user may have renamed the tab, moved our terminal, or added unrelated panes.
							// Close only our pane in that case, never the surrounding user-owned tab.
							if (matches[0]?.tab_id !== ownedTabId || livePanes.filter((pane: any) => pane.tab_id === ownedTabId).length !== 1) {
								ownedPaneId = requiredString(owned[0].pane_id, "Owned pane_id");
							}
						} else if (matches.length) throw new Error(`Terminal ownership mismatch for ${entry.agent_name}; tab may have been replaced`);
					} else if (matches.length === 1) ownedTabId = requiredString(matches[0].tab_id, "Owned tab_id");
					if (ownedPaneId || ownedTabId) {
						// Whatever the outcome, IDs may have changed: the next agent re-resolves from a fresh view.
						live = undefined;
						if (ownedPaneId) await this.command(["pane", "close", ownedPaneId], signal);
						else await this.command(["tab", "close", ownedTabId!], signal);
					} else manifest.cleanup_notes.push(`${entry.agent_name}: no live tab or pane found; treated as already closed`);
					entry.status = "closed"; this.store.save(manifest);
				} catch (error) { manifest.cleanup_errors.push(`${entry.agent_name}: ${errorMessage(error)}`); }
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
