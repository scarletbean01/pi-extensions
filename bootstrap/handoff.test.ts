/** Handoff delivery versus task acceptance, observed through the worker hooks (source and destination) and the service's status. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, dispositionPath, readJson, readyPath, resultPath, type Disposition, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

const roster = [
	{ instance_id: "a1-n1", node_id: "n1", persona_name: "first", sub_task: "one" },
	{ instance_id: "a2-n2", node_id: "n2", persona_name: "second", sub_task: "two" },
];
/** Chain node `n` of the two-node chain, speaking the durable handoff protocol. */
const chainNode = (n: 1 | 2, more: Partial<WorkerConfig> = {}): Partial<WorkerConfig> => ({
	topology: "chain", instance_id: `a${n}-n${n}`, node_id: `n${n}`, persona_name: roster[n - 1].persona_name, attempt_id: `a${n}-n${n}.1`, roster, handoff_protocol: 1,
	...(n === 1 ? { successor: "a2-n2" } : { predecessor: "a1-n1", dependency_policy: "require_success" as const }), ...more,
});

/** `sameRoot` starts another runtime (the other node, a /reload, or the next process) on the durable state of an earlier fixture. */
function worker(t: test.TestContext, overrides: Partial<WorkerConfig> = {}, sameRoot?: string) {
	const root = sameRoot ?? mkdtempSync(join(tmpdir(), "bootstrap-handoff-test-"));
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); if (!sameRoot) rmSync(root, { recursive: true, force: true }); });
	const config: WorkerConfig = {
		version: 2, task_id: "run-1", token: "token", session_dir: root, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "boot-run-1", instance_id: "a1-n1", node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1",
		persona: "PERSONA", tools: ["read"], sub_task: "Do the work", topology: "team",
		startup_message: "bootstrap-start:token:a1-n1", ready_timeout_ms: 1000, ...overrides,
	};
	const configPath = join(root, `${config.instance_id}.config.json`);
	atomicJson(configPath, config);
	const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
	mkdirSync(registryDir, { recursive: true });
	atomicJson(join(registryDir, `${config.instance_id}.json`), { pid: process.pid, name: config.instance_id, session_id: `session-${config.instance_id}`, endpoint: "/fake/socket", model: "model" });
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = ["read", "bash", "coms_send", "coms_get", "coms_await"];
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
		root, config, configPath, hooks, tools, context, sent, behavior,
		get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		complete: (params = { status: "success", summary: "Done", detail: "Work complete" }) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
	};
}

/** What the dispatcher persists for a node before launch: its authoritative identity and input. */
function writeTaskInput(root: string, node: 1 | 2, runId = "run-1") {
	const identity = { run_id: runId, node_id: `n${node}`, persona_name: roster[node - 1].persona_name, attempt_id: `a${node}-n${node}.1`, instance_id: `a${node}-n${node}` };
	atomicJson(taskInputPath(root, identity.instance_id), buildTaskInputRecord({ identity, brief: { task: "Chain", goal: "Chain" }, assignment: { sub_task: roster[node - 1].sub_task }, roster }));
}

/** The source (n1) completes its work and offers the result to n2, whose readiness is on record. */
async function completedSource(t: test.TestContext, more: Partial<WorkerConfig> = {}, result?: { status: string; summary: string; detail: string }) {
	const source = worker(t, chainNode(1, more));
	const runId = more.task_id ?? "run-1";
	writeTaskInput(source.root, 2, runId);
	atomicJson(join(source.root, "upstream-index.json"), { version: 2, run_id: runId, updated_at: new Date().toISOString(), entries: [] });
	atomicJson(readyPath(source.root, "a2-n2"), { task_id: runId, token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	await source.start();
	await source.beforeStart();
	const done = await source.complete(result);
	assert.equal(done.isError, undefined, JSON.stringify(done));
	return Object.assign(source, { done });
}
const offerPath = (root: string) => join(root, "a2-n2.handoff-offer.json");
const claimPath = (root: string) => join(root, "a2-n2.handoff.json");

test("a completed source records a durable handoff offer bound to run, source attempt, destination node and input digest before it notifies", async t => {
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	assert.match(offer.handoff_id, /^h-[0-9a-f]{32}$/);
	assert.equal(offer.version, 1);
	assert.equal(offer.run_id, "run-1");
	assert.deepEqual(offer.source, { node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1", instance_id: "a1-n1" });
	assert.deepEqual(offer.destination, { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" });
	assert.equal(offer.input_digest, readJson<any>(join(source.root, "upstream-index.json")).entries[0].result_hash, "the digest is the hash of the saved result the upstream index records");
	assert.match(offer.input_digest, /^[0-9a-f]{64}$/);
	// The notification only wakes the destination: it names the handoff and digest, but the durable offer is what decides.
	const prompt: string = source.sent[0].params.prompt;
	assert.match(prompt, new RegExp(`^bootstrap-handoff:token:a1-n1\\n`));
	assert.ok(prompt.includes(`handoff-id: ${offer.handoff_id}`) && prompt.includes(`input-digest: ${offer.input_digest}`));
});

test("a Coms transport ACK queues the handoff; it never records acceptance", async t => {
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	assert.equal(offer.state, "queued");
	assert.ok(offer.queued_at);
	assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
	assert.equal(existsSync(claimPath(source.root)), false, "no acceptance exists until the destination claims the handoff");
	assert.equal(existsSync(resultPath(source.root, "a2-n2")), false);
});

test("a failed notification leaves the offer unqueued, and the retry re-offers the same logical handoff", async t => {
	const source = worker(t, chainNode(1));
	writeTaskInput(source.root, 2);
	atomicJson(readyPath(source.root, "a2-n2"), { task_id: "run-1", token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	await source.start();
	await source.beforeStart();
	source.behavior.sendError = true;
	assert.equal((await source.complete()).isError, true);
	const offered = readJson<any>(offerPath(source.root));
	assert.equal(offered.state, "offered");
	assert.equal(offered.queued_at, undefined);
	source.behavior.sendError = false;
	await source.complete({ status: "success", summary: "Changed", detail: "ignored: the saved result is kept" });
	const queued = readJson<any>(offerPath(source.root));
	assert.equal(queued.handoff_id, offered.handoff_id);
	assert.equal(queued.input_digest, offered.input_digest);
	assert.equal(queued.state, "queued");
	assert.equal(source.sent.length, 2);
});

test("the handoff ID follows the run, source attempt, destination node and input digest", async t => {
	const base = readJson<any>(offerPath((await completedSource(t)).root)).handoff_id;
	const sameInputs = readJson<any>(offerPath((await completedSource(t)).root)).handoff_id;
	assert.equal(sameInputs, base, "identical run, attempt, destination and input give the same logical handoff");
	const otherInput = readJson<any>(offerPath((await completedSource(t, {}, { status: "success", summary: "Other", detail: "other input" })).root)).handoff_id;
	assert.notEqual(otherInput, base);
	const otherAttempt = readJson<any>(offerPath((await completedSource(t, { attempt_id: "a1-n1.2" })).root)).handoff_id;
	assert.notEqual(otherAttempt, base);
	const otherRun = readJson<any>(offerPath((await completedSource(t, { task_id: "run-2" })).root)).handoff_id;
	assert.notEqual(otherRun, base);
});

test("a worker without the durable handoff protocol (a run from the previous release) keeps the original notification and writes no offer", async t => {
	const source = await completedSource(t, { handoff_protocol: undefined });
	assert.equal(existsSync(offerPath(source.root)), false);
	assert.doesNotMatch(source.sent[0].params.prompt, /handoff-id:/);
	assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
});


// ---- destination: validate, claim atomically, accept ----

/** The notification the source's Coms send carried, as the destination's runtime receives it. */
const inbound = (source: { sent: Array<{ params: any }> }, change: { sender?: string; content?: (text: string) => string } = {}) => ({
	systemPrompt: "BASE", messageType: "custom",
	message: { customType: "coms-inbound", details: { sender_session: change.sender ?? "session-a1-n1" }, content: change.content ? change.content(source.sent[0].params.prompt) : source.sent[0].params.prompt },
});
async function destination(t: test.TestContext, more: Partial<WorkerConfig> = {}, source?: Awaited<ReturnType<typeof completedSource>>) {
	source ??= await completedSource(t);
	const dest = worker(t, chainNode(2, more), source.root);
	await dest.start();
	return { source, dest, notify: (change?: Parameters<typeof inbound>[1]) => inbound(source, change) };
}
const rejectionsOf = (root: string): any[] => { try { return readJson<any>(join(root, "a2-n2.handoff-rejections.json")).rejections; } catch { return []; } };
const errorOf = (root: string): string | undefined => { try { return readJson<any>(join(root, "a2-n2.error.json")).error; } catch { return undefined; } };

test("the destination claims the handoff durably before any model work and records exactly what it accepted", async t => {
	const { source, dest, notify } = await destination(t);
	const offer = readJson<any>(offerPath(source.root));
	assert.equal(existsSync(claimPath(source.root)), false, "nothing is accepted before the destination acts");
	const prompt = await dest.beforeStart(notify());
	assert.match(prompt.systemPrompt, /Predecessor result/);
	const claim = readJson<any>(claimPath(source.root));
	assert.deepEqual({ ...claim, accepted_at: undefined }, {
		version: 1, handoff_id: offer.handoff_id, state: "accepted", run_id: "run-1", offer: "matched", input_digest: offer.input_digest, accepted_at: undefined,
		source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1", session_id: "session-a1-n1" },
		destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
	});
	assert.ok(Date.parse(claim.accepted_at) > 0);
	assert.equal(readJson<any>(offerPath(source.root)).state, "queued", "accepting does not rewrite the source's offer");
	assert.equal(dest.aborts, 0);
});

/** Each way a handoff can be wrong, and what the destination must say about it. Nothing is claimed and no model work is admitted. */
const rejections: Array<{ name: string; kind: string; severity: "notification" | "integrity"; reason: RegExp; apply: (f: Awaited<ReturnType<typeof destination>>) => void | Promise<void>; change?: Parameters<typeof inbound>[1] }> = [
	{ name: "a sender that is not the predecessor's session", kind: "sender", severity: "notification", reason: /sender/i, apply: () => {}, change: { sender: "intruder-session" } },
	{ name: "another run's notification (a different token)", kind: "run", severity: "notification", reason: /run/i, apply: () => {}, change: { content: text => text.replace("bootstrap-handoff:token:", "bootstrap-handoff:other-token:") } },
	{ name: "a notification that names a different handoff", kind: "conflict", severity: "notification", reason: /names handoff h-0+, but the offer is h-/i, apply: () => {}, change: { content: text => text.replace(/handoff-id: \S+/, `handoff-id: h-${"0".repeat(32)}`) } },
	{ name: "a notification that carries a different input digest", kind: "input", severity: "notification", reason: /digest/i, apply: () => {}, change: { content: text => text.replace(/input-digest: \S+/, `input-digest: ${"0".repeat(64)}`) } },
	{ name: "a notification with no durable offer behind it", kind: "offer", severity: "notification", reason: /no handoff offer/i, apply: f => rmSync(offerPath(f.source.root)) },
	{ name: "an offer for another run", kind: "run", severity: "integrity", reason: /made for run other-run/i, apply: f => atomicJson(offerPath(f.source.root), { ...readJson<any>(offerPath(f.source.root)), run_id: "other-run" }) },
	{ name: "an offer addressed to another destination node", kind: "destination", severity: "integrity", reason: /destination node n9/i, apply: f => atomicJson(offerPath(f.source.root), { ...readJson<any>(offerPath(f.source.root)), destination: { ...readJson<any>(offerPath(f.source.root)).destination, node_id: "n9" } }) },
	{ name: "an offer for another attempt of the destination", kind: "attempt", severity: "integrity", reason: /destination attempt a2-n2\.2/i, apply: f => atomicJson(offerPath(f.source.root), { ...readJson<any>(offerPath(f.source.root)), destination: { ...readJson<any>(offerPath(f.source.root)).destination, attempt_id: "a2-n2.2" } }) },
	{ name: "an offer from another attempt of the source", kind: "attempt", severity: "integrity", reason: /source attempt a1-n1\.2/i, apply: f => atomicJson(offerPath(f.source.root), { ...readJson<any>(offerPath(f.source.root)), source: { ...readJson<any>(offerPath(f.source.root)).source, attempt_id: "a1-n1.2" } }) },
	{ name: "an input that changed after it was offered", kind: "input", severity: "integrity", reason: /changed after/i, apply: f => { const completion = readJson<any>(resultPath(f.source.root, "a1-n1")); completion.result.summary = "Edited after the offer"; atomicJson(resultPath(f.source.root, "a1-n1"), completion); } },
];
for (const rejection of rejections) {
	test(`a handoff is refused, with nothing claimed and no model work, for ${rejection.name}`, async t => {
		const f = await destination(t);
		await rejection.apply(f);
		assert.equal(await f.dest.beforeStart(f.notify(rejection.change)), undefined, "no task authority is granted");
		assert.equal(f.dest.aborts, 1);
		assert.equal(existsSync(claimPath(f.source.root)), false, "a refused handoff is never claimed");
		assert.equal((await f.dest.hooks.get("tool_call")!({ toolName: "read" })).block, true, "the worker has no admitted work");
		const recorded = rejectionsOf(f.source.root);
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].kind, rejection.kind);
		assert.equal(recorded[0].severity, rejection.severity);
		assert.match(recorded[0].reason, rejection.reason);
		if (rejection.severity === "integrity") {
			assert.match(errorOf(f.source.root) ?? "", /^Handoff rejected: /, "an invalid handoff is an attention condition for the destination");
			assert.equal(f.dest.shutdowns, 1);
		} else {
			assert.equal(errorOf(f.source.root), undefined, "one bad notification does not stop a destination whose offer is sound");
			assert.equal(f.dest.shutdowns, 0);
		}
	});
}

test("after a refused notification the genuine one is still accepted", async t => {
	const f = await destination(t);
	assert.equal(await f.dest.beforeStart(f.notify({ sender: "intruder-session" })), undefined);
	assert.match((await f.dest.beforeStart(f.notify())).systemPrompt, /Predecessor result/);
	assert.equal(readJson<any>(claimPath(f.source.root)).state, "accepted");
});

test("duplicate and concurrent notifications claim the handoff once and replay harmlessly", async t => {
	const f = await destination(t);
	const prompts = await Promise.all([f.dest.beforeStart(f.notify()), f.dest.beforeStart(f.notify())]);
	assert.equal(prompts.filter(Boolean).length, 1, "exactly one notification admits the work");
	assert.equal(f.dest.aborts, 1, "the replay is aborted without starting a second turn");
	const claim = readJson<any>(claimPath(f.source.root));
	await f.dest.beforeStart(f.notify());
	assert.deepEqual(readJson<any>(claimPath(f.source.root)), claim, "the original acceptance evidence is never rewritten");
	assert.equal(await f.dest.hooks.get("tool_call")!({ toolName: "read" }), undefined, "a replay does not take the accepted work's tools away");
	assert.equal(rejectionsOf(f.source.root).length, 0, "a replay is not a rejection");
	assert.equal(errorOf(f.source.root), undefined);
	await f.dest.complete({ status: "success", summary: "Final", detail: "" });
	assert.equal(readJson<WorkerCompletion>(resultPath(f.source.root, "a2-n2")).result.summary, "Final", "the replayed notification did not restart or replace the task");
});

// ---- competing owners and crashes ----

test("notifications racing in separate processes claim the handoff once; the losers get the winner's evidence", async t => {
	const f = await destination(t);
	const notification = join(f.source.root, "notification.txt");
	writeFileSync(notification, f.source.sent[0].params.prompt);
	const contender = join(dirname(fileURLToPath(import.meta.url)), "test-support", "claim-contender.ts");
	for (let round = 0; round < 3; round++) {
		rmSync(claimPath(f.source.root), { force: true });
		const startAt = String(Date.now() + 400);
		const outcomes = await Promise.all(Array.from({ length: 8 }, () => new Promise<any>((resolve, reject) => {
			const child = spawn(process.execPath, [contender, f.dest.configPath, notification, "session-a1-n1", startAt], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = ""; let stderr = "";
			child.stdout.on("data", chunk => { stdout += chunk; });
			child.stderr.on("data", chunk => { stderr += chunk; });
			child.on("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
		})));
		assert.equal(outcomes.filter(outcome => outcome.outcome === "accepted").length, 1, "exactly one process owns the handoff");
		const evidence = readJson<any>(claimPath(f.source.root));
		for (const outcome of outcomes) if (outcome.outcome === "duplicate") assert.deepEqual(outcome.claim, evidence);
	}
});

test("a crash before the claim leaves the handoff unclaimed, so a replayed notification is accepted exactly once", async t => {
	const f = await destination(t);
	// The destination's process dies before it acts: nothing is claimed and nothing ran.
	await f.dest.hooks.get("session_shutdown")!({ reason: "quit" });
	assert.equal(existsSync(claimPath(f.source.root)), false);
	const next = worker(t, chainNode(2), f.source.root);
	await next.start();
	assert.equal(existsSync(dispositionPath(f.source.root, "a2-n2")), false, "an unclaimed handoff needs no attention");
	assert.match((await next.beforeStart(f.notify())).systemPrompt, /Predecessor result/);
	assert.equal(await next.beforeStart(f.notify()), undefined);
	assert.equal(readJson<any>(claimPath(f.source.root)).state, "accepted");
});

test("a crash after the claim and before a result is never replayed; the node needs attention and the claim stays", async t => {
	const f = await destination(t);
	await f.dest.beforeStart(f.notify());
	const claim = readJson<any>(claimPath(f.source.root));
	// The destination's process dies mid-task: a claim, no result.
	await f.dest.hooks.get("session_shutdown")!({ reason: "quit" });
	const next = worker(t, chainNode(2), f.source.root);
	await next.start();
	const record = readJson<Disposition>(dispositionPath(f.source.root, "a2-n2"));
	assert.equal(record.state, "needs_attention");
	assert.match(record.reason, new RegExp(`handoff ${claim.handoff_id} was accepted .* no result .* not replayed`));
	assert.equal(existsSync(resultPath(f.source.root, "a2-n2")), false);
	assert.equal(await next.beforeStart(f.notify()), undefined, "the replayed notification does not restart the task");
	assert.equal((await next.hooks.get("tool_call")!({ toolName: "read" })).block, true);
	assert.deepEqual(readJson<any>(claimPath(f.source.root)), claim, "the claim is never reset automatically");
});

test("a crash after the result is saved keeps the result; a replayed notification neither re-accepts nor re-runs", async t => {
	const f = await destination(t);
	await f.dest.beforeStart(f.notify());
	await f.dest.complete({ status: "success", summary: "Final", detail: "" });
	const claim = readJson<any>(claimPath(f.source.root));
	const next = worker(t, chainNode(2), f.source.root);
	await next.start();
	assert.equal(existsSync(dispositionPath(f.source.root, "a2-n2")), false, "a finished node does not need attention");
	await next.beforeStart(f.notify());
	assert.equal(readJson<WorkerCompletion>(resultPath(f.source.root, "a2-n2")).result.summary, "Final");
	assert.deepEqual(readJson<any>(claimPath(f.source.root)), claim);
	assert.equal((await next.hooks.get("tool_call")!({ toolName: "read" })).block, true);
});

test("worker-facing text says a Coms acknowledgement only queues the handoff and the successor's acceptance is separate", async t => {
	const f = await destination(t);
	assert.match(f.source.tools.get("bootstrap_complete").description, /queued.*not accepted.*successor/i);
	assert.match(f.source.done.content[0].text, /handoff h-[0-9a-f]{32} queued for a2-n2.*not accepted until/i);
	assert.match((await f.dest.beforeStart(f.notify())).systemPrompt, /handoff notification only wakes you/i);
});
