/** Shared fixture for tests that drive real workers (from the service's own configurations) through a fake Herdr and read the result through status. */
import test from "node:test";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "../lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "../session-store.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("../worker.ts");

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

export function serviceFixture(t: test.TestContext) {
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
	for (const name of ["first", "second"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	}
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
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
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({
		exec, extensionDir, stateDir, home, pollMs: 5,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	return { root, cwd, home, stateDir, service, configs };
}

export function workerFromConfig(t: test.TestContext, configPath: string, overrides: { tools?: string[]; executeTool?: (name: string, params: unknown) => Promise<any> } = {}) {
	const config = readJson<WorkerConfig>(configPath);
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = overrides.tools ?? ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} },
		shutdown: () => { shutdowns++; },
		abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return overrides.executeTool ? overrides.executeTool(name, params) : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {},
		getFlag: () => configPath,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); });
	return {
		config, hooks, tools, context, sent,
		get active() { return active; },
		get shutdowns() { return shutdowns; },
		get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		complete: (params: Record<string, unknown>) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
		readInput: (params: Record<string, unknown>) => tools.get("bootstrap_read_input").execute("id", params, undefined, undefined, context),
		verify: (params: Record<string, unknown>) => tools.get("bootstrap_verify").execute("id", params, undefined, undefined, context),
	};
}


export const model = { provider: "provider", id: "model" };
export const chain: GenerateRequest = { topology: "chain", task: "Two steps", project_cwd: "", agents: [{ node_id: "n1", persona: "first", sub_task: "one" }, { node_id: "n2", persona: "second", sub_task: "two" }] };
/** A launched two-node chain with a worker for each node (the second only once its predecessor handed off). */
export async function launched(t: test.TestContext, firstOverrides: Parameters<typeof workerFromConfig>[2] = {}) {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "handoff" }, model);
	const first = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"), firstOverrides);
	const second = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await first.start(); await second.start();
	await first.beforeStart();
	const notification = () => ({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: first.sent[0].params.prompt } });
	return { ...f, run, first, second, notification, status: () => f.service.status(run.task_id) };
}

