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
import { cancelPath, claimOutcome, outcomeClaimPath, runCancelPath, writeCancelRecord, writeRunCancelRecord, type CancelRecord } from "./cancellation.ts";
import { publishFailFast } from "./ownership.ts";
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
		registerFlag: () => {}, getFlag: (name: string) => name === "bootstrap-worker-config" ? configPath : undefined,
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

test("winning completion outcome-claim commits result even if cancel.json appears concurrently", async t => {
	const f = fixture(t);
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	// Worker wins outcome-claim first, while run cancel.json also gets written concurrently before result.json is flushed.
	const id = { run_id: f.config.task_id, node_id: f.config.node_id, persona_name: f.config.persona_name, attempt_id: f.config.attempt_id, instance_id: f.config.instance_id };
	assert.equal(claimOutcome(f.root, id, "completed", new Date().toISOString()).won, true);
	writeRunCancelRecord(f.root, { run_id: f.config.task_id, reason: "Concurrent run cancel", requestedAt: new Date().toISOString(), graceMs: 5000 });
	// Since worker already won outcome-claim? Note: bootstrap_complete checks readCancellation at entry unless claimOutcome already ran;
	// test the exact race: if claimOutcome is won by worker right as cancel.json is written, worker commits result!
	// Simulate by calling complete when outcomeClaim is already won by worker AND cancel.json exists:
	const res = await f.complete();
	assert.equal(res.isError, undefined, "worker that won outcome claim must commit its result");
	assert.equal(readJson<WorkerCompletion>(resultPath(f.root, f.config.instance_id)).result.status, "success");
	assert.equal(existsSync(dispositionPath(f.root, f.config.instance_id)), false);
});

test("unsupported or foreign cancel records fail closed with error.json instead of silently cancelling", async t => {
	for (const [label, file, content] of [
		["unsupported node cancel version", "a1-first.cancel.json", { version: 99, identity: { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" }, scope: "node", reason: "future", requested_at: "2026-01-01T00:00:00.000Z", grace_ms: 5000, force_close_after: "2026-01-01T00:00:05.000Z" }],
		["foreign run cancel", "cancel.json", { version: 1, run_id: "other-run", reason: "foreign", requested_at: "2026-01-01T00:00:00.000Z", grace_ms: 5000, force_close_after: "2026-01-01T00:00:05.000Z" }],
		["unsupported outcome claim version", "a1-first.outcome-claim.json", { version: 99, identity: { run_id: "test-123", node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first" }, outcome: "cancelled", claimed_at: "2026-01-01T00:00:00.000Z" }],
	] as const) {
		const f = fixture(t);
		atomicJson(join(f.root, file), content);
		await f.start();
		assert.equal(existsSync(dispositionPath(f.root, "a1-first")), false, `${label}: must not record cancelled disposition`);
		assert.ok(existsSync(join(f.root, "a1-first.error.json")), `${label}: must fail closed with error.json`);
		assert.equal(f.shutdowns, 1, label);
	}
});

test("cancelTimer aborts active provider-waiting turns and checkTaskDeadline respects configured cancel_grace_ms", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 1. Active turn waiting on provider (started === true, no tool calls) gets aborted once by cancelTimer.
	const f = fixture(t);
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	cancelNode(f, "Cancelled during model wait");
	t.mock.timers.tick(1000);
	assert.equal(f.aborts, 1, "cancelTimer must abort active turn even when started === true");
	t.mock.timers.tick(2000);
	assert.equal(f.aborts, 1, "abort is issued once, not repeated every tick");

	// 2. checkTaskDeadline uses configured cancel_grace_ms instead of hardcoded 5000ms.
	const g = fixture(t, { task_timeout_ms: 2000, cancel_grace_ms: 15_000 });
	await g.start();
	await g.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	t.mock.timers.tick(2000);
	const cancelRec = readJson<CancelRecord>(cancelPath(g.root, g.config.instance_id));
	assert.equal(cancelRec.grace_ms, 15_000);
});

test("fail_fast arbitrates outcome-claim, writes cancel record, aborts turn, and yields to won completion", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 1. Peer publishes fail_fast during active turn -> worker claims cancelled outcome, writes cancel.json, writes disposition, and aborts.
	const f = fixture(t, { instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", failure_policy: "fail_fast", cancel_grace_ms: 9000 });
	await f.start();
	await f.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	publishFailFast({
		sessionDir: f.root, taskId: f.config.task_id, token: f.config.token,
		cause: { node_id: "first", instance_id: "a1-first", state: "failed", reason: "boom" },
	});
	await f.hooks.get("before_agent_start")!({ systemPrompt: "NEXT" });
	assert.equal(f.aborts, 1, "fail_fast must abort active turn");
	const claim1 = readJson<any>(outcomeClaimPath(f.root, f.config.instance_id));
	assert.equal(claim1.outcome, "cancelled");
	const cancel1 = readJson<CancelRecord>(cancelPath(f.root, f.config.instance_id));
	assert.equal(cancel1.grace_ms, 9000);
	assert.equal(existsSync(dispositionPath(f.root, f.config.instance_id)), false);
	await f.hooks.get("agent_settled")!({ aborted: true });
	assert.equal(readJson<Disposition>(dispositionPath(f.root, f.config.instance_id)).state, "cancelled");

	// 2. bootstrap_complete checks readFailFast before claiming completed -> refuses completion and records cancelled.
	const g = fixture(t, { instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", failure_policy: "fail_fast" });
	await g.start();
	await g.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	publishFailFast({
		sessionDir: g.root, taskId: g.config.task_id, token: g.config.token,
		cause: { node_id: "first", instance_id: "a1-first", state: "failed", reason: "peer failed" },
	});
	const res = await g.complete();
	assert.equal(res.isError, true, "bootstrap_complete must refuse completion when fail_fast is active");
	assert.equal(existsSync(resultPath(g.root, g.config.instance_id)), false);
	assert.equal(existsSync(dispositionPath(g.root, g.config.instance_id)), false);
	await g.hooks.get("agent_settled")!({ aborted: true });
	assert.equal(readJson<Disposition>(dispositionPath(g.root, g.config.instance_id)).state, "cancelled");

	// 3. If worker already won outcome-claim as completed, checkAndApplyFailFast yields instead of writing conflicting disposition.json.
	const h = fixture(t, { instance_id: "a2-second", node_id: "second", persona_name: "second", attempt_id: "a2-second.1", failure_policy: "fail_fast" });
	await h.start();
	await h.hooks.get("before_agent_start")!({ systemPrompt: "BASE" });
	claimOutcome(h.root, { run_id: h.config.task_id, node_id: h.config.node_id, persona_name: h.config.persona_name, attempt_id: h.config.attempt_id, instance_id: h.config.instance_id }, "completed", new Date().toISOString());
	publishFailFast({
		sessionDir: h.root, taskId: h.config.task_id, token: h.config.token,
		cause: { node_id: "first", instance_id: "a1-first", state: "failed", reason: "late failure" },
	});
	await h.hooks.get("before_agent_start")!({ systemPrompt: "NEXT" });
	assert.equal(existsSync(dispositionPath(h.root, h.config.instance_id)), false, "checkAndApplyFailFast must yield when completion outcome claim already won");
});
