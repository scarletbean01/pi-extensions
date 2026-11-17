/** Handoff delivery versus acceptance as the dispatcher sees it: real workers launched from the service's own configurations, observed through status. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { formatAgentStates } from "./reporting.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

function serviceFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-handoff-service-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
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

function workerFromConfig(t: test.TestContext, configPath: string, overrides: { tools?: string[] } = {}) {
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
			return { content: [], details: { msg_id: "msg1" } };
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


const model = { provider: "provider", id: "model" };
const chain: GenerateRequest = { topology: "chain", task: "Two steps", project_cwd: "", agents: [{ node_id: "n1", persona: "first", sub_task: "one" }, { node_id: "n2", persona: "second", sub_task: "two" }] };
/** A launched two-node chain with a worker for each node (the second only once its predecessor handed off). */
async function launched(t: test.TestContext) {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "handoff" }, model);
	const first = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	const second = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await first.start(); await second.start();
	await first.beforeStart();
	const notification = () => ({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: first.sent[0].params.prompt } });
	return { ...f, run, first, second, notification, status: () => f.service.status(run.task_id) };
}

test("a launched chain speaks the durable handoff protocol, and a team has no handoffs", async t => {
	const f = await launched(t);
	assert.equal(f.first.config.handoff_protocol, 1);
	assert.equal(f.second.config.handoff_protocol, 1);
	const team = await f.service.generate({ topology: "team", task: "Team", project_cwd: f.cwd, request_id: "team", agents: [{ node_id: "t1", persona: "first", sub_task: "x" }] }, model);
	assert.equal(readJson<WorkerConfig>(join(team.session_dir, "a1-t1.config.json")).handoff_protocol, undefined);
});

test("a queued handoff is neither accepted nor running: delivery, acceptance and execution are separate", async t => {
	const f = await launched(t);
	assert.equal(f.status().agents[1].handoff, undefined, "nothing was handed off yet");
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const agents = f.status().agents;
	assert.equal(agents[0].delivery, "sent");
	assert.equal(agents[1].handoff?.state, "queued");
	assert.equal(agents[0].handoff_out?.handoff_id, agents[1].handoff?.handoff_id);
	assert.notEqual(agents[1].execution, "running", "a transport acknowledgement is not acceptance");
	assert.equal(agents[1].handoff?.accepted_at, undefined);
	assert.match(formatAgentStates(agents), /\[handoff in h-[0-9a-f]{32} queued: not accepted yet/);
});

test("a queued handoff the worker rejects is never shown as accepted or running, and the guidance says what to do", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	// The saved input changes after the offer: Coms acknowledged the message, but the destination refuses it.
	const path = join(f.run.session_dir, "a1-n1.result.json");
	const record = readJson<any>(path); record.result.summary = "Edited after the offer"; atomicJson(path, record);
	await f.second.beforeStart(f.notification());
	const second = f.status().agents[1];
	assert.equal(second.handoff?.state, "rejected");
	assert.match(second.handoff!.rejections[0].reason, /changed after it was offered/);
	assert.equal(second.handoff?.accepted_at, undefined);
	assert.equal(second.execution, "needs_attention");
	assert.notEqual(second.state, "working");
	const text = formatAgentStates(f.status().agents);
	assert.match(text, /\[handoff in h-[0-9a-f]{32} rejected: the saved input changed after it was offered/);
	assert.match(text, /nothing ran for this handoff; inspect a1-n1's saved result, then bootstrap_cleanup.*new request_id/i);
});

test("acceptance is recorded and shown independently of execution, with the evidence", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	assert.match((await f.second.beforeStart(f.notification())).systemPrompt, /Accepted handoff: h-/);
	const second = f.status().agents[1];
	assert.equal(second.handoff?.state, "accepted");
	assert.match(second.handoff!.input_digest!, /^[0-9a-f]{64}$/);
	assert.deepEqual(second.handoff!.problems, []);
	assert.ok(second.handoff!.accepted_at);
	assert.equal(f.status().agents[0].handoff_out?.state, "accepted", "the source can prove its successor accepted the exact saved input");
	assert.match(formatAgentStates(f.status().agents), /\[handoff in h-[0-9a-f]{32} accepted\]/);
	await f.second.complete({ status: "success", summary: "Done", detail: "" });
	assert.equal(f.status().agents[1].execution, "succeeded");
	assert.equal(f.status().agents[1].handoff?.state, "accepted", "completing does not change what was accepted");
});

test("a claimed task whose worker died without a result is needs_attention, with the handoff named, and is never reset", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	const claim = readJson<any>(claimFile);
	// The worker process is gone (a PID that cannot be alive), leaving a claim and no result.
	atomicJson(readyPath(f.run.session_dir, "a2-n2"), { ...readJson<any>(readyPath(f.run.session_dir, "a2-n2")), pid: 2147483646 });
	const second = f.status().agents[1];
	assert.equal(second.execution, "needs_attention");
	assert.match(second.execution_reason!, new RegExp(`accepted handoff ${claim.handoff_id}; no result was recorded and the task is not replayed automatically`));
	assert.equal(f.status().outcome.state, "needs_attention");
	assert.deepEqual(readJson<any>(claimFile), claim);
	await assert.rejects(f.service.report(f.run.task_id, undefined, false, () => ""), /not complete/);
});

test("an acceptance that disagrees with the offer or the saved input is reported as an evidence problem", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	atomicJson(claimFile, { ...readJson<any>(claimFile), input_digest: "0".repeat(64) });
	const view = f.status().agents[1].handoff!;
	assert.match(view.problems.join(";"), /does not match the saved result/);
	assert.match(f.status().worker_errors.join(";"), /handoff evidence/);
});

test("a receipt written by the previous release is shown as accepted without a handoff ID, and unsupported records are reported clearly", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "legacy" }, model);
	atomicJson(join(run.session_dir, "a2-n2.handoff.json"), { task_id: run.task_id, token: run.token, predecessor: "a1-n1", sender_session: "session-a1-n1" });
	const view = f.service.status(run.task_id).agents[1].handoff!;
	assert.deepEqual([view.state, view.legacy, view.handoff_id], ["accepted", true, undefined]);
	atomicJson(join(run.session_dir, "a2-n2.handoff.json"), { version: 9, state: "accepted" });
	const unsupported = f.service.status(run.task_id).agents[1].handoff!;
	assert.match(unsupported.problems.join(";"), /Unsupported handoff acceptance version 9/);
	atomicJson(join(run.session_dir, "a2-n2.handoff-offer.json"), { version: 3 });
	assert.match(f.service.status(run.task_id).agents[1].handoff!.problems.join(";"), /Unsupported handoff offer version 3/);
});
