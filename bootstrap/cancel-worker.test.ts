import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	atomicJson, completionRecord, dispositionPath, readJson, readyPath, resultPath,
	type Disposition, type WorkerCompletion, type WorkerConfig,
} from "./session-store.ts";
import { cancelPath, claimOutcome, runCancelPath, writeCancelRecord, writeRunCancelRecord } from "./cancellation.ts";
import { handoffClaimPath, handoffOfferPath, inputDigest } from "./handoff.ts";

const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

function fixture(t: test.TestContext, overrides: Partial<WorkerConfig> = {}, sameRoot?: string) {
	const root = sameRoot ?? mkdtempSync(join(tmpdir(), "bootstrap-cancel-worker-"));
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
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} }, shutdown: () => { shutdowns++; }, abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return { content: [], details: { msg_id: "msg1" } };
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
		root, config, configPath, registryDir, hooks, tools, context, sent,
		get active() { return active; }, get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		complete: (params = { status: "success", summary: "Done", detail: "Work complete" }) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
	};
}

function cancelNode(f: ReturnType<typeof fixture>, reason = "Cancelled by user") {
	return writeCancelRecord(f.root, {
		identity: { run_id: f.config.task_id, node_id: f.config.node_id, persona_name: f.config.persona_name, attempt_id: f.config.attempt_id, instance_id: f.config.instance_id },
		scope: "node",
		reason,
		requestedAt: new Date().toISOString(),
		graceMs: 5000,
	});
}

test("cancel before release makes worker record cancelled disposition instead of an error", async t => {
	const f = fixture(t);
	rmSync(join(f.root, "release.json"));
	const startup = f.start();
	assert.ok(existsSync(readyPath(f.root, f.config.instance_id)));
	writeRunCancelRecord(f.root, { run_id: f.config.task_id, reason: "Aborted before release", requestedAt: new Date().toISOString(), graceMs: 5000 });
	cancelNode(f, "Aborted before release");
	atomicJson(join(f.root, "abort.json"), { task_id: f.config.task_id, token: f.config.token, error: "Aborted before release" });
	await startup;
	assert.equal(existsSync(join(f.root, `${f.config.instance_id}.error.json`)), false);
	const disp = readJson<Disposition>(dispositionPath(f.root, f.config.instance_id));
	assert.equal(disp.state, "cancelled");
	assert.match(disp.reason, /Aborted before release/);
	assert.equal(f.shutdowns, 1);
});

test("waiting follower observes cancellation on timer and denies subsequent handoff admission", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = fixture(t, { topology: "chain", instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", predecessor: "a1-first", handoff_protocol: 1 });
	await f.start();
	cancelNode(f, "Stop follower");
	t.mock.timers.tick(1000);
	const disp = readJson<Disposition>(dispositionPath(f.root, "a2-second"));
	assert.equal(disp.state, "cancelled");
	assert.equal(f.shutdowns, 1);

	// Even if a valid handoff arrives afterwards, admission is denied without claiming or calling the model.
	const f2 = fixture(t, { topology: "chain", instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", predecessor: "a1-first", handoff_protocol: 1 });
	atomicJson(readyPath(f2.root, "a1-first"), { session_id: "pred-sess" });
	const predResult = { agent_name: "first", node_id: "first", status: "success" as const, summary: "Done", detail: "" };
	atomicJson(resultPath(f2.root, "a1-first"), { version: 2, identity: { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" }, result: predResult, delivery: "sent", completed_at: new Date().toISOString() });
	atomicJson(handoffOfferPath(f2.root, "a2-second"), {
		version: 1, handoff_id: "h-000", run_id: "test-123", state: "queued",
		source: { node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" },
		destination: { node_id: "second", attempt_id: "a2-second.1", instance_id: "a2-second" },
		input_digest: inputDigest(predResult), result_path: resultPath(f2.root, "a1-first"), offered_at: new Date().toISOString(),
	});
	await f2.start();
	cancelNode(f2, "Cancelled before handoff");
	const prompt = await f2.hooks.get("before_agent_start")!({
		systemPrompt: "BASE", messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "pred-sess" }, content: "bootstrap-handoff:token:a1-first" },
	});
	assert.equal(prompt, undefined);
	assert.equal(f2.aborts, 1);
	assert.equal(existsSync(handoffClaimPath(f2.root, "a2-second")), false, "cancelled node must not claim handoff");
	assert.equal(readJson<Disposition>(dispositionPath(f2.root, "a2-second")).state, "cancelled");
});

test("cancel during active tool work blocks subsequent tools, blocks new completion, and records cancelled on settle", async t => {
	const f = fixture(t);
	await f.start();
	const prompt = await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	assert.ok(prompt.systemPrompt);

	// Persist cancellation while a tool is running.
	cancelNode(f, "Cancelled mid-tool");
	const blockedTool = await f.hooks.get("tool_call")!({ toolName: "read" });
	assert.equal(blockedTool.block, true);
	assert.match(blockedTool.reason, /cancelled/i);

	const comp = await f.complete();
	assert.equal(comp.isError, true);
	assert.equal(existsSync(resultPath(f.root, f.config.instance_id)), false, "cannot commit result after cancel");

	// When the in-progress tool finishes and agent_settled runs, no error.json is written; cancelled disposition stands.
	await f.hooks.get("agent_settled")!({ aborted: true });
	assert.equal(existsSync(join(f.root, `${f.config.instance_id}.error.json`)), false);
	assert.equal(readJson<Disposition>(dispositionPath(f.root, f.config.instance_id)).state, "cancelled");
});

test("simultaneous completion vs cancel: committed result before cancel is preserved; lost claim refuses result", async t => {
	// Case A: result already committed before cancel -> delivery retry still works and result is kept.
	const a = fixture(t, { topology: "chain", successor: "a2-second" });
	atomicJson(readyPath(a.root, "a2-second"), { task_id: a.config.task_id, token: a.config.token, instance_id: "a2-second", session_id: "succ-sess" });
	await a.start();
	await a.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	await a.complete();
	assert.equal(existsSync(resultPath(a.root, a.config.instance_id)), true);
	// Now cancel happens after result committed -> result preserved.
	cancelNode(a, "Late cancel");
	assert.equal(readJson<WorkerCompletion>(resultPath(a.root, a.config.instance_id)).result.status, "success");

	// Case B: cancel won outcome claim before bootstrap_complete committed -> completion refused.
	const b = fixture(t);
	await b.start();
	await b.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	const id = { run_id: b.config.task_id, node_id: b.config.node_id, persona_name: b.config.persona_name, attempt_id: b.config.attempt_id, instance_id: b.config.instance_id };
	assert.equal(claimOutcome(b.root, id, "cancelled", new Date().toISOString()).won, true);
	const res = await b.complete();
	assert.equal(res.isError, true);
	assert.equal(existsSync(resultPath(b.root, b.config.instance_id)), false);
	assert.equal(readJson<Disposition>(dispositionPath(b.root, b.config.instance_id)).state, "cancelled");
});

test("worker reload after cancel shuts down without redoing work; /new replacement session is unaffected by cancel", async t => {
	const f = fixture(t);
	cancelNode(f, "Cancelled before reload");
	await f.start();
	assert.equal(f.shutdowns, 1);
	assert.equal(readJson<Disposition>(dispositionPath(f.root, f.config.instance_id)).state, "cancelled");

	// /new replacement session detaches and is unaffected by cancel records.
	const g = fixture(t);
	await g.start();
	cancelNode(g, "Cancelled");
	await g.hooks.get("session_start")!({ reason: "new" }, g.context);
	assert.equal(await g.hooks.get("tool_call")!({ toolName: "bash" }), undefined);
	assert.equal(await g.hooks.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
});

test("running-task duration starts at admission, not launch, and cancels when task_timeout_ms expires", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = fixture(t, {
		topology: "chain",
		instance_id: "a2-second",
		node_id: "second",
		persona_name: "second",
		attempt_id: "a2-second.1",
		predecessor: "a1-first",
		task_timeout_ms: 5000,
		dependency_wait_timeout_ms: 600_000,
	});
	await f.start();
	// Waiting 60 seconds (12x task_timeout_ms!) does NOT expire task_timeout_ms because task hasn't started.
	for (let s = 0; s < 12; s++) {
		atomicJson(join(f.root, "a1-first.progress.json"), { token: f.config.token, updated_at: Date.now(), activity_at: Date.now(), started_at: 1_000_000, state: "working" });
		t.mock.timers.tick(5000);
	}
	assert.equal(existsSync(cancelPath(f.root, "a2-second")), false);
	assert.equal(f.shutdowns, 0);

	// Now predecessor completes and follower is admitted: running-task clock starts NOW.
	atomicJson(readyPath(f.root, "a1-first"), { session_id: "pred-sess" });
	atomicJson(resultPath(f.root, "a1-first"), { version: 2, identity: { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" }, result: { agent_name: "first", node_id: "first", status: "success", summary: "ok", detail: "" }, delivery: "sent", completed_at: new Date().toISOString() });
	const admitted = await f.hooks.get("before_agent_start")!({
		systemPrompt: "BASE", messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "pred-sess" }, content: "bootstrap-handoff:token:a1-first" },
	});
	assert.ok(admitted.systemPrompt);

	t.mock.timers.tick(4000);
	assert.equal(existsSync(cancelPath(f.root, "a2-second")), false, "within task_timeout_ms");
	t.mock.timers.tick(1000);
	assert.ok(existsSync(cancelPath(f.root, "a2-second")), "task_timeout_ms exceeded -> durable cancel written");
	assert.equal((await f.hooks.get("tool_call")!({ toolName: "read" })).block, true);
	await f.hooks.get("agent_settled")!({ aborted: true });
	const disp = readJson<Disposition>(dispositionPath(f.root, "a2-second"));
	assert.equal(disp.state, "cancelled");
	assert.match(disp.reason, /Task duration deadline exceeded \(5000ms\)/);
});

test("dependency wait separates heartbeat from useful progress: long healthy predecessor waits, live-but-stalled times out", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 1. Long healthy predecessor updating activity_at periodically survives well past dependency_wait_timeout_ms (10s).
	const healthy = fixture(t, {
		topology: "chain",
		instance_id: "a2-second",
		node_id: "second",
		persona_name: "second",
		attempt_id: "a2-second.1",
		predecessor: "a1-first",
		dependency_wait_timeout_ms: 10_000,
	});
	await healthy.start();
	for (let step = 0; step < 6; step++) {
		atomicJson(join(healthy.root, "a1-first.progress.json"), {
			token: healthy.config.token, updated_at: Date.now(), activity_at: Date.now(), started_at: 1_000_000, state: "working",
		});
		t.mock.timers.tick(5000);
	}
	assert.equal(existsSync(dispositionPath(healthy.root, "a2-second")), false, "long healthy predecessor keeps follower waiting");

	// 2. Live-but-stalled predecessor: heartbeat (updated_at) keeps ticking every 5s, while activity_at stays frozen!
	const stalled = fixture(t, {
		topology: "chain",
		instance_id: "a2-second",
		node_id: "second",
		persona_name: "second",
		attempt_id: "a2-second.1",
		predecessor: "a1-first",
		dependency_wait_timeout_ms: 10_000,
	});
	await stalled.start();
	const frozenActivity = Date.now();
	for (let step = 0; step < 3; step++) {
		atomicJson(join(stalled.root, "a1-first.progress.json"), {
			token: stalled.config.token, updated_at: Date.now(), activity_at: frozenActivity, started_at: frozenActivity, state: "working",
		});
		t.mock.timers.tick(5000);
	}
	const disp = readJson<Disposition>(dispositionPath(stalled.root, "a2-second"));
	assert.equal(disp.state, "needs_attention");
	assert.match(disp.reason, /10000ms/);
	assert.match(disp.reason, /no useful progress|stalled/i);
});
