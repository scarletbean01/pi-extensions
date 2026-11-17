import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, readJson, readyPath, resultPath, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";

// Pi supplies TypeBox at runtime. The test host only needs its schema constructors;
// a separate real-Pi smoke test validates extension loading with the real package.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

/** `sameRoot` starts another runtime (a /reload, or the next process) on the durable state of an earlier fixture. */
function fixture(t: test.TestContext, overrides: Partial<WorkerConfig> = {}, sameRoot?: string) {
	const root = sameRoot ?? mkdtempSync(join(tmpdir(), "bootstrap-worker-test-"));
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); if (!sameRoot) rmSync(root, { recursive: true, force: true }); });
	const config: WorkerConfig = {
		task_id: "test-123", token: "token", session_dir: root, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "boot-test-123", instance_id: "a1-first", agent_name: "first",
		persona: "EXACT PERSONA SNAPSHOT", tools: ["read"], sub_task: "Do assigned work", topology: "team",
		startup_message: "bootstrap-start:token:a1-first", ready_timeout_ms: 1000, ...overrides,
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
	mkdirSync(registryDir, { recursive: true });
	atomicJson(join(registryDir, `${config.instance_id}.json`), { pid: process.pid, name: config.instance_id, session_id: "own-session", endpoint: "/fake/socket", model: "model" });
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const behavior = { sendError: false };
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} }, shutdown: () => { shutdowns++; }, abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return behavior.sendError ? { isError: true, content: [{ type: "text", text: "receiver unreachable" }] } : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {}, getFlag: () => configPath,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	return {
		root, config, configPath, registryDir, hooks, tools, context, sent, behavior,
		get active() { return active; }, get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		complete: (params = { status: "success", summary: "Done", detail: "Work complete" }) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
	};
}

test("worker acknowledges its exact Coms identity and retains only persona plus coordination tools", async t => {
	const f = fixture(t);
	await f.start();
	const ready = readJson<any>(readyPath(f.root, f.config.instance_id));
	assert.equal(ready.session_id, "own-session");
	assert.equal(ready.model, "provider/model");
	assert.ok(f.active.includes("bootstrap_complete"));
	assert.ok(f.active.includes("coms_send"));
	assert.ok(!f.active.includes("bash"));
	assert.ok(!f.active.includes("bootstrap_generate"));
	const input = await f.hooks.get("input")!({ text: f.config.startup_message });
	assert.equal(input.action, "transform");
	assert.match(input.text, /Do assigned work/);
	const prompt = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.ok(prompt.systemPrompt.startsWith("EXACT PERSONA SNAPSHOT"));
});

test("worker cannot acknowledge readiness with the wrong registry identity", async t => {
	const f = fixture(t);
	atomicJson(join(f.registryDir, `${f.config.instance_id}.json`), { pid: process.pid + 1, name: f.config.instance_id });
	await f.start();
	assert.equal(existsSync(readyPath(f.root, f.config.instance_id)), false);
	assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, /identity mismatch/);
	assert.equal(f.shutdowns, 1);
	assert.equal((await f.hooks.get("input")!({ text: f.config.startup_message })).action, "handled");
});

test("worker reports initialization failure for unavailable persona tools", async t => {
	const f = fixture(t, { tools: ["missing_tool"] });
	await f.start();
	assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, /missing_tool/);
	assert.equal(existsSync(readyPath(f.root, f.config.instance_id)), false);
});

test("worker holds the readiness barrier until the dispatcher releases it", async t => {
	const f = fixture(t);
	rmSync(join(f.root, "release.json"));
	let started = false;
	const startup = f.start().then(() => { started = true; });
	assert.ok(existsSync(readyPath(f.root, f.config.instance_id)));
	assert.equal(started, false);
	assert.equal((await f.hooks.get("input")!({ text: f.config.startup_message })).action, "handled");
	atomicJson(join(f.root, "release.json"), { task_id: f.config.task_id, token: f.config.token });
	await startup;
	assert.equal(started, true);
});

test("chain followers consume startup without a model turn and await an inbound Coms prompt", async t => {
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", agent_name: "second", predecessor: "a1-first" });
	await f.start();
	assert.equal((await f.hooks.get("input")!({ text: f.config.startup_message })).action, "handled");
	assert.equal(f.sent.length, 0);
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "predecessor-session" });
	atomicJson(resultPath(f.root, "a1-first"), { result: { agent_name: "first", status: "success", summary: "Input", detail: "Predecessor data" }, delivery: "sent", completed_at: new Date().toISOString() });
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "predecessor-session" }, content: "bootstrap-handoff:token:a1-first" } });
	await f.complete();
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.agent_name, "second");
});

test("worker completion persists a result without requiring dispatcher Coms registration", async t => {
	const f = fixture(t);
	await f.start();
	const response = await f.complete();
	assert.equal(response.details.status, "saved");
	const completion = readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id));
	assert.equal(completion.result.summary, "Done");
	assert.equal(completion.delivery, "not_required");
	assert.equal(f.sent.length, 0);
	assert.equal(f.shutdowns, 1);
});

test("chain completion routes to the successor session using the actual Coms API exactly once", async t => {
	const f = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(readyPath(f.root, "a2-second"), { task_id: f.config.task_id, token: f.config.token, instance_id: "a2-second", session_id: "successor-session" });
	await f.start();
	await f.complete();
	await f.complete();
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0].name, "coms_send");
	assert.equal(f.sent[0].params.target, "successor-session");
	assert.match(f.sent[0].params.prompt, /Predecessor result/);
	assert.equal(f.sent[0].params.recipient, undefined);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).delivery, "sent");
});

test("failed handoff preserves the original result and can be retried without replacing it", async t => {
	const f = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(readyPath(f.root, "a2-second"), { task_id: f.config.task_id, token: f.config.token, instance_id: "a2-second", session_id: "successor-session" });
	await f.start();
	f.behavior.sendError = true;
	assert.equal((await f.complete()).isError, true);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).delivery, "failed");
	assert.equal(f.shutdowns, 0);
	f.behavior.sendError = false;
	await f.complete({ status: "success", summary: "Changed", detail: "Changed" });
	const completion = readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id));
	assert.equal(completion.result.summary, "Done");
	assert.equal(completion.delivery, "sent");
});

test("upstream failures propagate an abort rather than authorizing downstream work", async t => {
	const f = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(readyPath(f.root, "a2-second"), { task_id: f.config.task_id, token: f.config.token, instance_id: "a2-second", session_id: "successor-session" });
	await f.start();
	await f.complete({ status: "failure", summary: "Failed", detail: "No input" });
	assert.match(f.sent[0].params.prompt, /chain is aborted/);
});

test("worker refuses readiness when the actual model differs from the launch plan", async t => {
	const f = fixture(t, { expected_model: "different/model" });
	await f.start();
	assert.equal(existsSync(readyPath(f.root, f.config.instance_id)), false);
	assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, /model does not match/);
});

test("a worker that settles without completing records a recoverable failure", async t => {
	const f = fixture(t);
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	await f.hooks.get("agent_settled")!({ aborted: false }, f.context);
	assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, /without calling bootstrap_complete/);
	assert.equal(f.shutdowns, 1);
});

test("already delivered durable results are not forwarded again after worker reload", async t => {
	const f = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(resultPath(f.root, f.config.instance_id), {
		result: { agent_name: "first", status: "success", summary: "Previously done", detail: "" }, delivery: "sent", completed_at: new Date().toISOString(),
	});
	await f.start();
	await f.complete();
	assert.equal(f.sent.length, 0);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.summary, "Previously done");
});

test("followers reject wrong senders and durably consume a logical handoff only once", async t => {
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", predecessor: "a1-first" });
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "expected-session" });
	atomicJson(resultPath(f.root, "a1-first"), { result: { agent_name: "first", status: "success", summary: "Input", detail: "Data" }, delivery: "sent", completed_at: new Date().toISOString() });
	await f.start();
	const event = { systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "wrong-session" }, content: "bootstrap-handoff:token:a1-first" } };
	await f.hooks.get("before_agent_start")!(event);
	assert.equal(f.aborts, 1);
	assert.equal((await f.hooks.get("tool_call")!({ toolName: "read" })).block, true);
	event.message.details.sender_session = "expected-session";
	const accepted = await f.hooks.get("before_agent_start")!(event);
	assert.match(accepted.systemPrompt, /Predecessor result/);
	assert.equal(await f.hooks.get("tool_call")!({ toolName: "read" }), undefined);
	await f.hooks.get("before_agent_start")!(event);
	assert.equal(f.aborts, 2);
	assert.equal((await f.hooks.get("tool_call")!({ toolName: "read" })).block, true);
});

test("completion is sequential and blocks later tools in the same batch and queued work", async t => {
	const f = fixture(t);
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.equal(f.tools.get("bootstrap_complete").executionMode, "sequential");
	// A malformed completion is rejected by validation and must not lock the worker out of its tools.
	await f.hooks.get("tool_call")!({ toolName: "bootstrap_complete", input: { status: "done" } });
	assert.equal(await f.hooks.get("tool_call")!({ toolName: "bash" }), undefined);
	await f.hooks.get("tool_call")!({ toolName: "bootstrap_complete", input: { status: "success", summary: "Done", detail: "" } });
	assert.equal((await f.hooks.get("tool_call")!({ toolName: "bash" })).block, true);
	await f.complete();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.equal(f.aborts, 1);
	assert.equal((await f.hooks.get("tool_call")!({ toolName: "read" })).block, true);
});

test("large results use a bounded handoff reference instead of exceeding Coms envelope limits", async t => {
	const f = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(readyPath(f.root, "a2-second"), { task_id: f.config.task_id, token: f.config.token, instance_id: "a2-second", session_id: "successor-session" });
	await f.start();
	await f.complete({ status: "success", summary: "Large result", detail: "x".repeat(100_000) });
	assert.ok(Buffer.byteLength(f.sent[0].params.prompt) < 4096);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.detail.length, 100_000);
});

test("long chains wait for live predecessor progress rather than expiring from fleet release", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const f = fixture(t, { topology: "chain", instance_id: "a3-third", predecessor: "a2-second" });
	await f.start();
	for (let minute = 0; minute < 12; minute++) {
		atomicJson(join(f.root, "a2-second.progress.json"), { token: f.config.token, updated_at: Date.now(), state: "working" });
		t.mock.timers.tick(60_000);
	}
	assert.equal(existsSync(resultPath(f.root, f.config.instance_id)), false);
	t.mock.timers.tick(300_001);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.status, "failure");
	assert.equal(f.shutdowns, 1);
});

test("a specific failure is not overwritten by the generic shutdown message", async t => {
	const f = fixture(t);
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	await f.hooks.get("agent_settled")!({ aborted: false }, f.context);
	await f.hooks.get("session_shutdown")!({ reason: "quit" });
	assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, /without calling bootstrap_complete/);
});

test("a replacement session (/new) detaches from bootstrap instead of blocking the user", async t => {
	const f = fixture(t);
	await f.hooks.get("session_start")!({ reason: "new" }, f.context);
	assert.equal(existsSync(readyPath(f.root, f.config.instance_id)), false);
	assert.equal(await f.hooks.get("tool_call")!({ toolName: "read" }), undefined);
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.equal(f.aborts, 0);
});

test("readiness records the process start time so PID reuse is detectable", async t => {
	const f = fixture(t);
	await f.start();
	const ready = readJson<any>(readyPath(f.root, f.config.instance_id));
	if (process.platform === "linux") assert.match(ready.start_time, /^\d+$/);
});

test("predecessor input is truncated on a UTF-8 character boundary", async t => {
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", predecessor: "a1-first" });
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "expected-session" });
	atomicJson(resultPath(f.root, "a1-first"), { result: { agent_name: "first", status: "success", summary: "x", detail: "é".repeat(30_000) }, delivery: "sent", completed_at: new Date().toISOString() });
	await f.start();
	const accepted = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "expected-session" }, content: "bootstrap-handoff:token:a1-first" } });
	assert.match(accepted.systemPrompt, /Truncated/);
	assert.ok(!accepted.systemPrompt.includes("�"));
});

test("a reused runtime fully detaches after /new: no old persona, task or tool restriction survives", async t => {
	const f = fixture(t);
	await f.start();
	assert.ok(!f.active.includes("bash"), "bootstrap restricted the toolset");
	await f.hooks.get("session_start")!({ reason: "new" }, f.context);
	assert.ok(f.active.includes("bash"), "the original toolset is restored");
	assert.equal(await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined, "no persona or task injection");
	assert.equal(await f.hooks.get("input")!({ text: f.config.startup_message }), undefined);
	assert.equal(await f.hooks.get("tool_call")!({ toolName: "bash" }), undefined);
	assert.equal(f.aborts, 0);
});

test("workers see the overall task and roster, and record real activity separately from heartbeats", async t => {
	const f = fixture(t, { task: "Ship the parser", roster: [{ instance_id: "a1-first", agent_name: "first", sub_task: "Do assigned work" }, { instance_id: "a2-second", agent_name: "second", sub_task: "Review it" }] });
	await f.start();
	const before = readJson<any>(join(f.root, "a1-first.progress.json"));
	assert.equal(before.activity_at, undefined, "no activity before admission");
	const prompt = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.match(prompt.systemPrompt, /Overall run task: Ship the parser/);
	assert.match(prompt.systemPrompt, /a1-first \(first\) ← you: Do assigned work/);
	assert.match(prompt.systemPrompt, /a2-second \(second\): Review it/);
	await f.hooks.get("tool_execution_start")!({});
	await new Promise(resolve => setTimeout(resolve, 5100));
	const after = readJson<any>(join(f.root, "a1-first.progress.json"));
	assert.ok(Number.isFinite(after.activity_at), "the next heartbeat carries the activity time");
});

for (const reason of ["new", "resume", "fork"]) {
	test(`replacing an initialized worker with /${reason} records why, restores the toolset and leaves an ordinary session`, async t => {
		const f = fixture(t);
		await f.start();
		assert.ok(!f.active.includes("bash"), "bootstrap restricted the toolset");
		await f.hooks.get("session_shutdown")!({ reason });
		assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, new RegExp(`replaced \\(/${reason}\\) before recording a result`));
		await f.hooks.get("session_start")!({ reason }, f.context);
		assert.ok(f.active.includes("bash"), "the original toolset is restored");
		assert.equal(await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
		assert.equal(await f.hooks.get("tool_call")!({ toolName: "bash" }), undefined);
		assert.equal(await f.hooks.get("input")!({ text: f.config.startup_message }), undefined);
		assert.equal(f.aborts, 0);
		assert.equal(f.shutdowns, 0, "the user's new session is never shut down");
	});
}

test("replacing a worker that already completed keeps its result and records no failure", async t => {
	const f = fixture(t);
	await f.start();
	await f.complete();
	await f.hooks.get("session_shutdown")!({ reason: "new" });
	assert.equal(existsSync(join(f.root, `${f.config.instance_id}.error.json`)), false);
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.summary, "Done");
});

test("a /reload after the session was replaced does not turn the user's session back into the worker", async t => {
	const first = fixture(t);
	await first.start();
	await first.hooks.get("session_shutdown")!({ reason: "new" });
	await first.hooks.get("session_start")!({ reason: "new" }, first.context);
	// The host's flags still carry the worker configuration when the replaced session is reloaded.
	const reloaded = fixture(t, {}, first.root);
	await reloaded.hooks.get("session_start")!({ reason: "reload" }, reloaded.context);
	assert.ok(reloaded.active.includes("bash"), "the user's toolset is untouched");
	assert.equal(await reloaded.hooks.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined, "no persona or task injection");
	assert.equal(await reloaded.hooks.get("tool_call")!({ toolName: "bash" }), undefined);
	assert.equal(await reloaded.hooks.get("input")!({ text: reloaded.config.startup_message }), undefined);
	assert.equal(reloaded.aborts, 0);
	assert.equal(reloaded.shutdowns, 0);
});

test("after a reload a worker with a saved result retries only the delivery and never redoes the work", async t => {
	const first = fixture(t, { topology: "chain", successor: "a2-second", sub_task: "Do assigned work" });
	atomicJson(readyPath(first.root, "a2-second"), { task_id: first.config.task_id, token: first.config.token, instance_id: "a2-second", session_id: "successor-session" });
	await first.start();
	first.behavior.sendError = true;
	assert.equal((await first.complete()).isError, true);
	await first.hooks.get("session_shutdown")!({ reason: "reload" });
	const reloaded = fixture(t, { topology: "chain", successor: "a2-second", sub_task: "Do assigned work" }, first.root);
	await reloaded.hooks.get("session_start")!({ reason: "reload" }, reloaded.context);
	const prompt = await reloaded.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.doesNotMatch(prompt.systemPrompt, /Your task: Do assigned work/);
	assert.match(prompt.systemPrompt, /already finished and its result is saved/);
	assert.equal(await reloaded.hooks.get("tool_call")!({ toolName: "bash" }).then((r: any) => r?.block), true, "no further task tools");
	await reloaded.complete({ status: "failure", summary: "Changed", detail: "Changed" });
	const completion = readJson<WorkerCompletion>(resultPath(first.root, first.config.instance_id));
	assert.equal(completion.result.summary, "Done", "the original result is kept");
	assert.equal(completion.delivery, "sent");
	assert.equal(reloaded.sent.length, 1);
});
