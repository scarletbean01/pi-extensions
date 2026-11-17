import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, dispositionPath, readJson, readyPath, resultPath, type Disposition, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";
import { beginVerificationCheck, finishVerificationCheck, verificationPath } from "./verification.ts";

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
		version: 2, task_id: "test-123", token: "token", session_dir: root, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "boot-test-123", instance_id: "a1-first", node_id: "first", persona_name: "first", attempt_id: "a1-first.1",
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
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
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
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", predecessor: "a1-first" });
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
	// Silence from the predecessor is an attention condition for this node, not a failure it executed.
	assert.equal(existsSync(resultPath(f.root, f.config.instance_id)), false);
	const record = readJson<Disposition>(dispositionPath(f.root, f.config.instance_id));
	assert.equal(record.state, "needs_attention");
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
	const f = fixture(t, { task: "Ship the parser", roster: [{ instance_id: "a1-first", node_id: "first", persona_name: "first", sub_task: "Do assigned work" }, { instance_id: "a2-second", node_id: "second", persona_name: "second", sub_task: "Review it" }] });
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

// ---- ticket 03: node identity in the worker ----

test("two workers of one persona keep separate assignments, identities and durable results", async t => {
	const api = fixture(t, { instance_id: "a1-review-api", node_id: "review-api", attempt_id: "a1-review-api.1", sub_task: "Review the API" });
	await api.start();
	const ui = fixture(t, { instance_id: "a2-review-ui", node_id: "review-ui", attempt_id: "a2-review-ui.1", sub_task: "Review the UI" }, api.root);
	await ui.start();
	const [apiPrompt, uiPrompt] = [await api.hooks.get("before_agent_start")!({ systemPrompt: "BASE" }), await ui.hooks.get("before_agent_start")!({ systemPrompt: "BASE" })];
	assert.match(apiPrompt.systemPrompt, /Node: review-api\. Persona: first\. Attempt: a1-review-api\.1\. Instance: a1-review-api\./);
	assert.match(apiPrompt.systemPrompt, /Your task: Review the API/);
	assert.doesNotMatch(apiPrompt.systemPrompt, /Your task: Review the UI/);
	assert.match(uiPrompt.systemPrompt, /Node: review-ui\./);
	await api.complete({ status: "success", summary: "API fine", detail: "No findings" });
	await ui.complete({ status: "partial", summary: "UI issues", detail: "Two findings" });
	const [apiResult, uiResult] = [readJson<WorkerCompletion>(resultPath(api.root, "a1-review-api")), readJson<WorkerCompletion>(resultPath(api.root, "a2-review-ui"))];
	assert.deepEqual(apiResult.identity, { run_id: "test-123", node_id: "review-api", persona_name: "first", attempt_id: "a1-review-api.1", instance_id: "a1-review-api" });
	assert.equal(apiResult.version, 2);
	assert.deepEqual([apiResult.result.node_id, apiResult.result.agent_name, apiResult.result.summary], ["review-api", "first", "API fine"]);
	assert.deepEqual([uiResult.result.node_id, uiResult.result.agent_name, uiResult.result.summary], ["review-ui", "first", "UI issues"]);
});

test("a worker started from a version 1 (persona-keyed) configuration still works and writes a version 1 result", async t => {
	const f = fixture(t);
	// The exact shape the previous release wrote: no version, the persona as agent_name, no node or attempt.
	const { version: _v, node_id: _n, persona_name: _p, attempt_id: _a, ...rest } = f.config;
	atomicJson(f.configPath, { ...rest, agent_name: "first" });
	await f.start();
	assert.ok(existsSync(readyPath(f.root, f.config.instance_id)));
	const prompt = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.match(prompt.systemPrompt, /Persona: first\./);
	assert.doesNotMatch(prompt.systemPrompt, /Attempt:/);
	await f.complete();
	const record = readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id));
	assert.equal(record.version, undefined, "a live version 1 run is not migrated in place");
	assert.equal(record.identity, undefined);
	assert.equal(record.result.agent_name, "first");
});

test("a worker refuses an unsupported or malformed identity in its configuration before acknowledging readiness", async t => {
	for (const [bad, pattern] of [
		[{ version: 3 }, /Unsupported bootstrap worker configuration version 3/],
		[{ node_id: undefined }, /node_id must be a non-empty string/],
		[{ node_id: "has space" }, /not a valid node ID/],
		[{ attempt_id: undefined }, /attempt_id must be a non-empty string/],
	] as const) {
		const f = fixture(t);
		atomicJson(f.configPath, { ...f.config, ...bad });
		await f.start();
		assert.match(readJson<any>(join(f.root, `${f.config.instance_id}.error.json`)).error, pattern);
		assert.equal(existsSync(readyPath(f.root, f.config.instance_id)), false);
		assert.equal(f.shutdowns, 1);
	}
});

test("a predecessor result recorded for another node is rejected at admission", async t => {
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", predecessor: "a1-first" });
	await f.start();
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "predecessor-session" });
	atomicJson(resultPath(f.root, "a1-first"), {
		version: 2, identity: { run_id: "test-123", node_id: "somebody-else", persona_name: "first", attempt_id: "a9-somebody-else.1", instance_id: "a9-somebody-else" },
		result: { agent_name: "first", node_id: "somebody-else", status: "success", summary: "Input", detail: "Not mine" }, delivery: "sent", completed_at: new Date().toISOString(),
	});
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "predecessor-session" }, content: "bootstrap-handoff:token:a1-first" } });
	assert.match(readJson<any>(join(f.root, "a2-second.error.json")).error, /Chain admission failed: .*identity mismatch/);
	assert.equal(f.aborts, 1);
});

// ---- ticket 04: dependency policies, execution outcomes and verification evidence in the worker ----

/** The second node of a chain, whose predecessor wrote `completion` (or nothing) before the handoff. The project is a directory apart from the session files. */
function follower(t: test.TestContext, overrides: Partial<WorkerConfig> = {}, predecessor?: { status: "success" | "partial" | "failure"; delivery?: string }) {
	const f = fixture(t, {
		topology: "chain", instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", predecessor: "a1-first", dependency_policy: "require_success", ...overrides,
	});
	const project = join(f.root, "project");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "code.txt"), "v1");
	atomicJson(f.configPath, { ...f.config, project_cwd: project });
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "predecessor-session" });
	if (predecessor) atomicJson(resultPath(f.root, "a1-first"), { result: { agent_name: "first", status: predecessor.status, summary: `Predecessor ${predecessor.status}`, detail: "Data" }, delivery: predecessor.delivery ?? "sent", completed_at: new Date().toISOString() });
	const handoff = () => f.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "predecessor-session" }, content: "bootstrap-handoff:token:a1-first" } });
	const disposition = () => readJson<Disposition>(dispositionPath(f.root, "a2-second"));
	return Object.assign(f, { project, handoff, disposition });
}
const predecessorIdentity = { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" };
/** The predecessor's required check, as its worker records it over `project` (optionally with an edit while the check runs). */
const recordCheck = (f: { root: string; project: string }, result: "pass" | "fail" | "error", options: { scope?: string[]; during?: () => void } = {}) => {
	const started = beginVerificationCheck(f.project, "tests", options.scope);
	options.during?.();
	return finishVerificationCheck(f.root, predecessorIdentity, started, { result });
};
/** A follower whose predecessor's plan requires the `tests` check (carried in the worker's upstream contracts). */
const requiringTests = { upstream_contracts: { "a1-first": { required_checks: ["tests"] } } } as Partial<WorkerConfig>;

test("a successor that requires success is blocked, not failed, by a partial predecessor; allow_partial continues", async t => {
	const strict = follower(t, {}, { status: "partial" });
	await strict.start();
	const admitted = await strict.handoff();
	assert.equal(admitted, undefined, "no task prompt: the node does not execute");
	assert.equal(strict.aborts, 1);
	assert.equal(strict.shutdowns, 1);
	assert.equal(existsSync(resultPath(strict.root, "a2-second")), false, "a node that never ran has no worker result");
	assert.equal(existsSync(join(strict.root, "a2-second.error.json")), false);
	const record = strict.disposition();
	assert.equal(record.state, "blocked");
	assert.deepEqual(record.identity, { run_id: "test-123", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", instance_id: "a2-second" });
	assert.deepEqual(record.causes.map(cause => [cause.node_id, cause.state]), [["a1-first", "partial"]]);
	assert.match(record.reason, /requires success/);
	assert.equal((await strict.hooks.get("tool_call")!({ toolName: "read" })).block, true, "no task tools are authorized");

	const lenient = follower(t, { dependency_policy: "allow_partial" }, { status: "partial" });
	await lenient.start();
	const prompt = await lenient.handoff();
	assert.match(prompt.systemPrompt, /Predecessor result: .*"status":"partial"/);
	assert.equal(existsSync(dispositionPath(lenient.root, "a2-second")), false);
});

test("a predecessor's own failure blocks its successor under either policy and the failure stays the root cause", async t => {
	for (const policy of ["require_success", "allow_partial"] as const) {
		const f = follower(t, { dependency_policy: policy }, { status: "failure" });
		await f.start();
		await f.handoff();
		const record = f.disposition();
		assert.equal(record.state, "blocked");
		assert.deepEqual(record.causes.map(cause => [cause.node_id, cause.state, cause.reason]), [["a1-first", "failed", "Predecessor failure"]]);
		assert.equal(existsSync(resultPath(f.root, "a2-second")), false, "the successor is not reported as a failed execution");
	}
});

test("a reported success does not admit work whose required checks are missing, unverified, stale or failed", async t => {
	const cases: Array<[string, string, (f: { root: string; project: string }) => void]> = [
		["missing", "missing", () => {}],
		["failed", "failed", f => { recordCheck(f, "fail"); }],
		["unverified (tree changed during the check)", "unverified", f => { recordCheck(f, "pass", { during: () => writeFileSync(join(f.project, "code.txt"), "edited while the check ran") }); }],
		["unverified (applicability unknown)", "unverified", f => { recordCheck(f, "pass", { scope: [] }); }],
		["stale", "stale", f => { recordCheck(f, "pass"); writeFileSync(join(f.project, "code.txt"), "v2 edited after the check"); }],
	];
	for (const [label, evidence, arrange] of cases) {
		const f = follower(t, requiringTests, { status: "success" });
		arrange(f);
		await f.start();
		assert.equal(await f.handoff(), undefined, label);
		const record = f.disposition();
		assert.equal(record.state, "blocked", label);
		assert.match(record.reason, new RegExp(`check "tests" has ${evidence} evidence`), label);
		assert.deepEqual(record.causes.map(cause => [cause.node_id, cause.state, cause.check?.evidence]), [["a1-first", "succeeded", evidence]], "the predecessor did succeed; its evidence is what is unacceptable");
		assert.equal(existsSync(resultPath(f.root, "a2-second")), false);
		assert.equal(existsSync(join(f.root, "a2-second.error.json")), false, "an evidence problem is a blocked dependency, not an admission failure");
	}
});

test("a reported success with passing, current evidence admits the dependent; an unreadable evidence file does not", async t => {
	const ok = follower(t, requiringTests, { status: "success" });
	recordCheck(ok, "pass");
	await ok.start();
	assert.match((await ok.handoff()).systemPrompt, /Predecessor result/);
	assert.equal(existsSync(dispositionPath(ok.root, "a2-second")), false);
	const torn = follower(t, requiringTests, { status: "success" });
	writeFileSync(verificationPath(torn.root, "a1-first"), "{torn");
	await torn.start();
	await torn.handoff();
	assert.equal(torn.disposition().causes[0].check?.evidence, "unverified");
	// Required evidence also gates a partial predecessor that the policy would otherwise allow.
	const partial = follower(t, { ...requiringTests, dependency_policy: "allow_partial" }, { status: "partial" });
	await partial.start();
	await partial.handoff();
	assert.equal(partial.disposition().causes[0].check?.evidence, "missing");
});

test("a node blocked upstream blocks its successor with the whole chain of causes, without a handoff", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = follower(t, { instance_id: "a3-third", node_id: "third", persona_name: "third", attempt_id: "a3-third.1", predecessor: "a2-second" });
	atomicJson(dispositionPath(f.root, "a2-second"), {
		version: 1, identity: { run_id: "test-123", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", instance_id: "a2-second" }, state: "blocked", reason: "a1-first failed: no input",
		causes: [{ node_id: "a1-first", state: "failed", reason: "no input" }], recorded_at: new Date().toISOString(),
	});
	await f.start();
	t.mock.timers.tick(1000);
	const record = readJson<Disposition>(dispositionPath(f.root, "a3-third"));
	assert.equal(record.state, "blocked");
	assert.deepEqual(record.causes.map(cause => [cause.node_id, cause.state]), [["a2-second", "blocked"], ["a1-first", "failed"]]);
	assert.equal(existsSync(resultPath(f.root, "a3-third")), false);
	assert.equal(f.shutdowns, 1);
});

test("a failed predecessor whose handoff could not be delivered still blocks the successor", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = follower(t, {}, { status: "failure", delivery: "failed" });
	await f.start();
	t.mock.timers.tick(1000);
	assert.equal(f.disposition().state, "blocked");
	// A partial predecessor under allow_partial keeps waiting for its handoff instead.
	const lenient = follower(t, { dependency_policy: "allow_partial" }, { status: "partial", delivery: "failed" });
	await lenient.start();
	t.mock.timers.tick(1000);
	assert.equal(existsSync(dispositionPath(lenient.root, "a2-second")), false);
});

test("an unresolved predecessor is waited on, never replayed past: no handoff means needs_attention, not failure", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const f = follower(t);
	atomicJson(dispositionPath(f.root, "a1-first"), {
		version: 1, identity: { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" }, state: "needs_attention", reason: "worker exited during handoff",
		causes: [], recorded_at: new Date(0).toISOString(),
	});
	await f.start();
	t.mock.timers.tick(60_000);
	assert.equal(existsSync(dispositionPath(f.root, "a2-second")), false, "it keeps waiting while the predecessor is unresolved");
	t.mock.timers.tick(300_001);
	const record = f.disposition();
	assert.equal(record.state, "needs_attention");
	assert.match(record.reason, /No predecessor progress or handoff from a1-first for 300000ms/);
	assert.deepEqual(record.causes.map(cause => [cause.node_id, cause.state]), [["a1-first", "needs_attention"]]);
	assert.equal(existsSync(resultPath(f.root, "a2-second")), false);
});

test("worker instructions explain what each outcome means for dependants", async t => {
	const f = fixture(t);
	await f.start();
	const { systemPrompt } = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.match(systemPrompt, /success means the task is done; partial means gaps remain \(a dependant that requires success will not start\); failure means you could not do it/);
});

test("a version 1 follower keeps the original behavior: an upstream failure is recorded as its own failure result", async t => {
	const f = follower(t, { version: 1 }, { status: "failure" });
	const { version: _v, node_id: _n, persona_name: _p, attempt_id: _a, dependency_policy: _d, ...rest } = readJson<any>(f.configPath);
	atomicJson(f.configPath, { ...rest, agent_name: "second" });
	await f.start();
	await f.handoff();
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, "a2-second")).result.status, "failure");
	assert.equal(existsSync(dispositionPath(f.root, "a2-second")), false);
});

const roster = [
	{ instance_id: "a1-n1", node_id: "n1", persona_name: "first", sub_task: "one" }, { instance_id: "a2-n2", node_id: "n2", persona_name: "second", sub_task: "two" }, { instance_id: "a3-n3", node_id: "n3", persona_name: "third", sub_task: "three" },
];
const chainNode = (n: 1 | 2 | 3, more: Partial<WorkerConfig> = {}): Partial<WorkerConfig> => ({
	topology: "chain", instance_id: `a${n}-n${n}`, node_id: `n${n}`, persona_name: roster[n - 1].persona_name, attempt_id: `a${n}-n${n}.1`, roster,
	...(n > 1 ? { predecessor: `a${n - 1}-n${n - 1}`, dependency_policy: "require_success" as const } : {}), ...(n < 3 ? { successor: `a${n + 1}-n${n + 1}` } : {}), ...more,
});
const handoffFrom = (predecessor: string) => ({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "own-session" }, content: `bootstrap-handoff:token:${predecessor}` } });

test("through real workers, a partial result blocks the next node and the node after it, each carrying the original cause", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const a = fixture(t, chainNode(1));
	atomicJson(readyPath(a.root, "a2-n2"), { task_id: a.config.task_id, token: a.config.token, instance_id: "a2-n2", session_id: "b-session" });
	await a.start();
	await a.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	await a.complete({ status: "partial", summary: "Only half done", detail: "Gaps remain" });
	assert.equal(readJson<WorkerCompletion>(resultPath(a.root, "a1-n1")).delivery, "sent");
	const b = fixture(t, chainNode(2), a.root);
	await b.start();
	assert.equal(await b.hooks.get("before_agent_start")!(handoffFrom("a1-n1")), undefined);
	const second = readJson<Disposition>(dispositionPath(a.root, "a2-n2"));
	assert.deepEqual([second.state, second.causes.map(cause => `${cause.node_id}:${cause.state}`)], ["blocked", ["n1:partial"]]);
	const c = fixture(t, chainNode(3), a.root);
	await c.start();
	t.mock.timers.tick(1000);
	const third = readJson<Disposition>(dispositionPath(a.root, "a3-n3"));
	assert.deepEqual([third.state, third.causes.map(cause => `${cause.node_id}:${cause.state}`)], ["blocked", ["n2:blocked", "n1:partial"]]);
	for (const instance of ["a2-n2", "a3-n3"]) assert.equal(existsSync(resultPath(a.root, instance)), false, `${instance} executed nothing and has no result`);
	assert.equal(c.shutdowns, 1);
});

test("through real workers, a check recorded with bootstrap_verify admits the next node only while its evidence is current", async t => {
	for (const edit of [false, true]) {
		const a = fixture(t, chainNode(1, { required_checks: ["tests"] }));
		const project = join(a.root, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "code.txt"), "v1");
		atomicJson(a.configPath, { ...a.config, project_cwd: project });
		atomicJson(readyPath(a.root, "a2-n2"), { task_id: a.config.task_id, token: a.config.token, instance_id: "a2-n2", session_id: "b-session" });
		await a.start();
		await a.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
		const verify = (params: object) => a.tools.get("bootstrap_verify").execute("id", params, undefined, undefined, a.context);
		await verify({ action: "start", check_id: "tests" });
		await verify({ action: "finish", check_id: "tests", result: "pass" });
		assert.equal((await a.complete({ status: "success", summary: "Built", detail: "" })).isError, undefined, "its own required check is passing, so it may complete");
		if (edit) writeFileSync(join(project, "code.txt"), "v2 edited after the check");
		const b = fixture(t, chainNode(2, { upstream_contracts: { "a1-n1": { required_checks: ["tests"] } } }), a.root);
		atomicJson(b.configPath, { ...b.config, project_cwd: project });
		await b.start();
		const admitted = await b.hooks.get("before_agent_start")!(handoffFrom("a1-n1"));
		if (edit) {
			assert.equal(admitted, undefined);
			assert.match(readJson<Disposition>(dispositionPath(a.root, "a2-n2")).reason, /check "tests" has stale evidence/);
		} else {
			assert.match(admitted.systemPrompt, /Predecessor result/);
			assert.equal(existsSync(dispositionPath(a.root, "a2-n2")), false);
		}
	}
});
