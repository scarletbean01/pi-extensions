/** Shared fixture for tests that drive real workers (from the service's own configurations) through a fake Herdr and read outcomes through status and report. */
import test from "node:test";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "../lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig, type WorkerReady } from "../session-store.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("../worker.ts");

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

export function serviceFixture(t: test.TestContext, personas: Iterable<string> = ["first", "second"], options: { signalWorker?: ConstructorParameters<typeof BootstrapService>[0]["signalWorker"]; independentStateRoots?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-handoff-service-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of new Set(personas)) {
		if (basename(name) !== name) throw new Error(`Invalid fixture persona: ${name}`);
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	}
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
	const onTabClose = new Map<string, () => Promise<void>>();
	const closeTab = async (id: string) => {
		const index = tabs.findIndex(tab => tab.tab_id === id || tab.pane_id === id);
		if (index === -1) return;
		const [tab] = tabs.splice(index, 1);
		await onTabClose.get(tab.tab_id)?.();
	};
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(item => item.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
			atomicJson(readyPath(sessionDir, instance), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") {
			await closeTab(args[2]);
			return ok();
		}
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({
		exec, extensionDir, stateDir: options.independentStateRoots ? undefined : stateDir, home, pollMs: 5, signalWorker: options.signalWorker,
		env: {
			PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller",
			...(options.independentStateRoots ? { PI_BOOTSTRAP_STATE_DIR: stateDir, PI_FACTORY_STATE_DIR: join(root, "factory-state") } : {}),
		},
	});
	return { root, cwd, home, stateDir, service, configs, onTabClose, closeTab };
}

export function workerFromConfig(t: test.TestContext, configPath: string, overrides: { onShutdown?: () => void; tools?: string[]; executeTool?: (name: string, params: unknown) => Promise<any>; model?: { provider: string; id: string } } = {}) {
	const config = readJson<WorkerConfig>(configPath);
	// Each fake agent shares the test process. Track its timers so it can disappear
	// without running any worker hook or stopping the other agents' timers.
	const workerScope = new AsyncLocalStorage<boolean>();
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	const timerHook = createHook({
		init(id, type, _trigger, resource) {
			if (type === "Timeout" && workerScope.getStore()) {
				timers.set(id, resource as ReturnType<typeof setTimeout>);
			}
		},
		destroy(id) { timers.delete(id); },
	});
	const stopTimers = () => {
		timerHook.disable();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	};
	let stopped = false;
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = overrides.tools ?? ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const followUps: unknown[] = [];
	const sent: Array<{ name: string; params: any }> = [];
	const context = {
		model: overrides.model ?? { provider: "provider", id: "model" },
		ui: { notify: () => {} },
		shutdown: () => { shutdowns++; overrides.onShutdown?.(); },
		abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return overrides.executeTool ? overrides.executeTool(name, params) : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {},
		getFlag: (name: string) => name === "bootstrap-worker-config" ? configPath : undefined,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => workerScope.run(true, () => handler(event, ctx))),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: unknown) => followUps.push(message),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	timerHook.enable();
	const markExited = () => {
		// Use an unallocated PID for the retained readiness acknowledgement.
		const path = readyPath(config.session_dir, config.instance_id);
		let ready: WorkerReady;
		try { ready = readJson<WorkerReady>(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		atomicJson(path, { ...ready, pid: 2147483646 });
	};
	const shutdown = async (reason: "quit" | "reload") => {
		if (stopped) return;
		stopped = true;
		try { await hooks.get("session_shutdown")?.({ reason }, context); }
		finally {
			stopTimers();
			if (reason === "quit") markExited();
		}
	};
	const execute = (name: string, params: Record<string, unknown>) =>
		workerScope.run(true, () => tools.get(name).execute("id", params, undefined, undefined, context));
	t.after(() => shutdown("reload"));
	return {
		config, hooks, tools, context, sent,
		deliverFollowUps: async () => {
			for (const message of followUps.splice(0)) await hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message }, context);
		},
		get active() { return active; },
		get shutdowns() { return shutdowns; },
		get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		complete: (params: Record<string, unknown>) => execute("bootstrap_complete", params),
		readInput: (params: Record<string, unknown>) => execute("bootstrap_read_input", params),
		verify: (params: Record<string, unknown>) => execute("bootstrap_verify", params),
		requestDirection: (params: Record<string, unknown>, signal?: AbortSignal) => workerScope.run(true, async () => {
			const toolName = "bootstrap_request_direction";
			const toolCallId = "id";
			const result = await tools.get(toolName).execute(toolCallId, params, signal, undefined, context);
			const patch = await hooks.get("tool_result")?.({ toolName, toolCallId, input: params, ...result }, context);
			return { ...result, ...patch };
		}),
		shutdown,
		vanish: () => {
			if (stopped) return;
			stopped = true;
			stopTimers();
			markExited();
		},
	};
}

export const model = { provider: "provider", id: "model" };
export const chain = { topology: "chain", task: "Two steps", project_cwd: "", agents: [{ node_id: "n1", persona: "first", sub_task: "one" }, { node_id: "n2", persona: "second", sub_task: "two" }] } satisfies GenerateRequest;
type WorkerDriver = ReturnType<typeof workerFromConfig>;

export function notification(sender: WorkerDriver, recipient: WorkerDriver) {
	const session = (worker: WorkerDriver) => `session-${worker.config.instance_id}`;
	const message = sender.sent.findLast(call => call.name === "coms_send" && call.params.target === session(recipient));
	if (!message) throw new Error(`No notification from ${sender.config.node_id} to ${recipient.config.node_id}`);
	return {
		systemPrompt: "BASE", messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: session(sender) }, content: message.params.prompt },
	};
}

type NodePlan = Omit<GenerateRequest, "project_cwd" | "agents"> & {
	agents: Array<GenerateRequest["agents"][number] & { node_id: string; persona: string }>;
};

/** Launch real workers from the configurations generated for a node-form plan. */
export async function runFixture(
	t: test.TestContext,
	plan: NodePlan,
	overrides: ReadonlyMap<string, Parameters<typeof workerFromConfig>[2]> = new Map(),
	options: { simulateShutdown?: boolean; signalWorker?: ConstructorParameters<typeof BootstrapService>[0]["signalWorker"] } = {},
) {
	const f = serviceFixture(t, plan.agents.map(node => node.persona), { signalWorker: options.signalWorker });
	const run = await f.service.generate({ ...plan, project_cwd: f.cwd }, model);
	const driverFor = (entry: typeof run.pane_manifest[number]) => {
		const tabId = entry.tab_id!;
		const worker = workerFromConfig(t, join(run.session_dir, `${entry.instance_id}.config.json`), {
			...overrides.get(entry.node_id),
			...(options.simulateShutdown ? { onShutdown: () => { void f.closeTab(tabId); } } : {}),
		});
		f.onTabClose.set(tabId, () => worker.shutdown("quit"));
		return Object.assign(worker, {
			closeTab: () => f.closeTab(tabId),
			notificationFrom: (sender: WorkerDriver) => notification(sender, worker),
			deliverNotification: (sender: WorkerDriver) => worker.beforeStart(notification(sender, worker)),
		});
	};
	const nodes = new Map(run.pane_manifest.map(entry => [entry.node_id, driverFor(entry)]));
	const reload = async (nodeId: string) => {
		await nodes.get(nodeId)!.shutdown("reload");
		const entry = run.pane_manifest.find(entry => entry.node_id === nodeId)!;
		const worker = driverFor(entry);
		nodes.set(nodeId, worker);
		await worker.start();
		return worker;
	};
	for (const node of nodes.values()) await node.start();
	for (const node of nodes.values()) {
		if (!node.config.predecessor) await node.beforeStart();
	}
	return {
		...f, run, nodes, reload,
		status: () => f.service.status(run.task_id),
		report: () => f.service.report(run.task_id, undefined, false, () => ""),
	};
}

/** Compatibility helper for the original two-node chain tests. */
export async function launched(t: test.TestContext, firstOverrides: Parameters<typeof workerFromConfig>[2] = {}) {
	const f = await runFixture(t, { ...chain, request_id: "handoff" }, new Map([["n1", firstOverrides]]));
	const first = f.nodes.get("n1")!;
	const second = f.nodes.get("n2")!;
	return { ...f, first, second, notification: () => notification(first, second) };
}
