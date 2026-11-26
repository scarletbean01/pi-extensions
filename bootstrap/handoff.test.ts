/** Handoff delivery versus task acceptance, observed through the worker hooks (source and destination) and the service's status. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const sentMessages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const behavior = { sendError: false };
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: (message: string, type?: string) => { notifications.push({ message, type }); } }, shutdown: () => { shutdowns++; }, abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return behavior.sendError ? { isError: true, content: [{ type: "text", text: "receiver unreachable" }] } : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {}, getFlag: (name: string) => name === "bootstrap-worker-config" ? configPath : undefined,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	return {
		root, config, configPath, hooks, tools, context, sent, sentMessages, notifications, behavior,
		get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		input: (text: string, extra: Record<string, unknown> = {}) => hooks.get("input")!({ text, ...extra }, context),
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
	const { handoffId } = await import("./handoff.ts");
	const parts = { run_id: "run-1", source_attempt_id: "a1-n1.1", destination_node_id: "n2", destination_attempt_id: "a2-n2.1", input_digest: "a".repeat(64) };
	assert.notEqual(handoffId({ ...parts, destination_node_id: "n3" }), handoffId(parts));
	assert.notEqual(handoffId({ ...parts, destination_attempt_id: "a2-n2.2" }), handoffId(parts));
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

test("a blocked follower aborts duplicate notifications instead of entering completion prompt, and a second restart preserves existing disposition", async t => {
	const source = await completedSource(t, {}, { status: "partial", summary: "Partial", detail: "Gaps" });
	const dest = worker(t, chainNode(2, { dependency_policy: "require_success" }), source.root);
	await dest.start();
	// First notification blocks dest (partial predecessor under require_success).
	assert.equal(await dest.beforeStart(inbound(source)), undefined);
	assert.equal(readJson<Disposition>(dispositionPath(source.root, "a2-n2")).state, "blocked");
	const abortsAfterBlock = dest.aborts;
	// Duplicate notification before process exit must abort rather than returning a retry-completion prompt.
	assert.equal(await dest.beforeStart(inbound(source)), undefined);
	assert.equal(dest.aborts, abortsAfterBlock + 1);

	// Crash-after-claim scenario: disposition is written on first restart; a second restart must not overwrite it on timer expiry.
	const f2 = await destination(t);
	await f2.dest.beforeStart(f2.notify());
	await f2.dest.hooks.get("session_shutdown")!({ reason: "quit" });
	const restart1 = worker(t, chainNode(2), f2.source.root);
	await restart1.start();
	const origDisp = readJson<Disposition>(dispositionPath(f2.source.root, "a2-n2"));
	assert.equal(origDisp.state, "needs_attention");
	assert.match(origDisp.reason, /accepted .* no result/);

	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	const restart2 = worker(t, chainNode(2, { dependency_wait_timeout_ms: 500 }), f2.source.root);
	await restart2.start();
	t.mock.timers.tick(5000);
	assert.deepEqual(readJson<Disposition>(dispositionPath(f2.source.root, "a2-n2")), origDisp);
	assert.equal(await restart2.beforeStart(f2.notify()), undefined);
});

test("a premature notification before predecessor result and offer exist is rejected benignly without crashing the destination", async t => {
	const source = worker(t, chainNode(1));
	writeTaskInput(source.root, 2);
	atomicJson(readyPath(source.root, "a2-n2"), { task_id: "run-1", token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	await source.start();
	await source.beforeStart();
	const dest = worker(t, chainNode(2), source.root);
	await dest.start();

	const premature = {
		systemPrompt: "BASE", messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: "bootstrap-handoff:token:a1-n1\nRun: run-1." },
	};
	assert.equal(await dest.beforeStart(premature), undefined);
	assert.equal(dest.aborts, 1);
	assert.equal(dest.shutdowns, 0, "premature notification without offer must not kill destination");
	assert.equal(errorOf(source.root), undefined);
	assert.equal(rejectionsOf(source.root).length, 1);
	assert.deepEqual([rejectionsOf(source.root)[0].kind, rejectionsOf(source.root)[0].severity], ["offer", "notification"]);

	// Destination can still accept the genuine handoff once the source completes.
	await source.complete();
	const admitted = await dest.beforeStart(inbound(source));
	assert.match(admitted.systemPrompt, /Predecessor result/);
});

test("recordHandoffRejection leaves unsupported future-version rejection logs untouched", async t => {
	const f = await destination(t);
	const rejPath = join(f.source.root, "a2-n2.handoff-rejections.json");
	const v2Text = JSON.stringify({ version: 2, rejections: [] }, null, 2);
	writeFileSync(rejPath, v2Text);
	assert.equal(await f.dest.beforeStart(f.notify({ sender: "intruder-session" })), undefined);
	assert.equal(f.dest.aborts, 1);
	assert.equal(readFileSync(rejPath, "utf8"), v2Text, "unsupported version rejection log must not be overwritten");
});

test("foreign or malformed-digest handoff claims fail closed with integrity severity", async t => {
	// 1. Foreign run_id on handoff.json must fail closed with integrity error (not duplicate).
	const f = await destination(t);
	const offer = readJson<any>(offerPath(f.source.root));
	atomicJson(claimPath(f.source.root), {
		version: 1, handoff_id: offer.handoff_id, state: "accepted", run_id: "OTHER-RUN",
		source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1", session_id: "session-a1-n1" },
		destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		input_digest: offer.input_digest, offer: "matched", accepted_at: new Date().toISOString(),
	});
	assert.equal(await f.dest.beforeStart(f.notify()), undefined);
	assert.equal(f.dest.shutdowns, 1);
	assert.match(errorOf(f.source.root) ?? "", /^Handoff rejected:/);
	assert.equal(rejectionsOf(f.source.root).at(-1)?.severity, "integrity");

	// 2. Non-hex input_digest on handoff.json must fail closed at the read boundary.
	const f2 = await destination(t);
	const offer2 = readJson<any>(offerPath(f2.source.root));
	atomicJson(claimPath(f2.source.root), {
		version: 1, handoff_id: offer2.handoff_id, state: "accepted", run_id: "run-1",
		source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1", session_id: "session-a1-n1" },
		destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		input_digest: "not-a-64-hex-sha256", offer: "matched", accepted_at: new Date().toISOString(),
	});
	assert.equal(await f2.dest.beforeStart(f2.notify()), undefined);
	assert.equal(f2.dest.shutdowns, 1);
	assert.match(errorOf(f2.source.root) ?? "", /^Handoff rejected: .*input_digest/);
});

// ---- pane wake-up (ticket 04) ----

test("exact pane wake-up accepts a matching unclaimed offer without checking sender identity", async t => {
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	// Remove predecessor ready.json to prove sender identity is not required for pane wake-up.
	rmSync(readyPath(source.root, "a1-n1"), { force: true });
	const dest = worker(t, chainNode(2), source.root);
	await dest.start();

	const inputResult = await dest.input(`[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`);
	assert.deepEqual(inputResult, { action: "handled" });
	assert.equal(dest.sentMessages.length, 1);
	assert.equal(dest.sentMessages[0]!.options.deliverAs, "followUp");
	assert.equal(dest.sentMessages[0]!.options.triggerTurn, true);

	const prompt = await dest.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: dest.sentMessages[0]!.message });
	assert.match(prompt.systemPrompt, /Predecessor result/);
	const claim = readJson<any>(claimPath(source.root));
	assert.equal(claim.state, "accepted");
	assert.equal(claim.handoff_id, offer.handoff_id);
	assert.equal(dest.aborts, 0);
	assert.equal(await dest.hooks.get("tool_call")!({ toolName: "read" }), undefined);
});

test("pane wake-up for an already-claimed handoff is a harmless replay (after pane wake or Coms delivery)", async t => {
	// 1. After Coms delivery
	const fComs = await destination(t);
	const offerComs = readJson<any>(offerPath(fComs.source.root));
	assert.match((await fComs.dest.beforeStart(fComs.notify())).systemPrompt, /Predecessor result/);
	const claimAfterComs = readJson<any>(claimPath(fComs.source.root));

	assert.deepEqual(await fComs.dest.input(`[BOOTSTRAP_WAKE handoff=${offerComs.handoff_id}]`), { action: "handled" });
	assert.equal(fComs.dest.sentMessages.length, 0, "already-claimed handoff must not queue another turn");
	assert.deepEqual(readJson<any>(claimPath(fComs.source.root)), claimAfterComs);
	assert.equal(rejectionsOf(fComs.source.root).length, 0);
	assert.equal(await fComs.dest.hooks.get("tool_call")!({ toolName: "read" }), undefined);

	// 2. After an earlier pane wake-up
	const fPane = await destination(t);
	const offerPane = readJson<any>(offerPath(fPane.source.root));
	await fPane.dest.input(`[BOOTSTRAP_WAKE handoff=${offerPane.handoff_id}]`);
	assert.match((await fPane.dest.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: fPane.dest.sentMessages[0]!.message })).systemPrompt, /Predecessor result/);
	assert.deepEqual(await fPane.dest.input(`[BOOTSTRAP_WAKE handoff=${offerPane.handoff_id}]`), { action: "handled" });
	assert.equal(fPane.dest.sentMessages.length, 1);
	assert.equal(rejectionsOf(fPane.source.root).length, 0);
});

test("pane wake-up naming no offer, a wrong ID, or an offer for another attempt or run refuses safely without claiming", async t => {
	// 1. Missing offer
	const fMissing = await destination(t);
	const offerMissing = readJson<any>(offerPath(fMissing.source.root));
	rmSync(offerPath(fMissing.source.root));
	assert.deepEqual(await fMissing.dest.input(`[BOOTSTRAP_WAKE handoff=${offerMissing.handoff_id}]`), { action: "handled" });
	assert.equal(fMissing.dest.sentMessages.length, 0);
	assert.equal(existsSync(claimPath(fMissing.source.root)), false);
	assert.equal(rejectionsOf(fMissing.source.root).at(-1)?.kind, "offer");

	// 2. Unknown handoff ID when a different offer is on disk (does not poison valid offer)
	const fWrongId = await destination(t);
	const validOffer = readJson<any>(offerPath(fWrongId.source.root));
	assert.deepEqual(await fWrongId.dest.input(`[BOOTSTRAP_WAKE handoff=h-${"0".repeat(32)}]`), { action: "handled" });
	assert.equal(fWrongId.dest.sentMessages.length, 0);
	assert.equal(existsSync(claimPath(fWrongId.source.root)), false);
	assert.equal(rejectionsOf(fWrongId.source.root).at(-1)?.kind, "conflict");
	assert.deepEqual(await fWrongId.dest.input(`[BOOTSTRAP_WAKE handoff=${validOffer.handoff_id}]`), { action: "handled" });
	assert.equal(fWrongId.dest.sentMessages.length, 1);

	// 3. Offer for a different run
	const fOtherRun = await destination(t);
	const offerOtherRun = readJson<any>(offerPath(fOtherRun.source.root));
	atomicJson(offerPath(fOtherRun.source.root), { ...offerOtherRun, run_id: "other-run" });
	assert.deepEqual(await fOtherRun.dest.input(`[BOOTSTRAP_WAKE handoff=${offerOtherRun.handoff_id}]`), { action: "handled" });
	assert.equal(fOtherRun.dest.sentMessages.length, 0);
	assert.equal(existsSync(claimPath(fOtherRun.source.root)), false);
	assert.equal(rejectionsOf(fOtherRun.source.root).at(-1)?.kind, "run");

	// 4. Offer for a different destination attempt
	const fOtherAttempt = await destination(t);
	const offerOtherAttempt = readJson<any>(offerPath(fOtherAttempt.source.root));
	atomicJson(offerPath(fOtherAttempt.source.root), { ...offerOtherAttempt, destination: { ...offerOtherAttempt.destination, attempt_id: "a2-n2.2" } });
	assert.deepEqual(await fOtherAttempt.dest.input(`[BOOTSTRAP_WAKE handoff=${offerOtherAttempt.handoff_id}]`), { action: "handled" });
	assert.equal(fOtherAttempt.dest.sentMessages.length, 0);
	assert.equal(existsSync(claimPath(fOtherAttempt.source.root)), false);
	assert.equal(rejectionsOf(fOtherAttempt.source.root).at(-1)?.kind, "attempt");
});

test("any input not matching the exact pane wake-up form passes through untouched", async t => {
	const f = await destination(t);
	const offer = readJson<any>(offerPath(f.source.root));
	const nonMatching = [
		`[BOOTSTRAP_WAKE handoff=${offer.handoff_id}] extra`,
		` [BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`,
		`[BOOTSTRAP_WAKE handoff=${offer.handoff_id}] `,
		`prefix [BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`,
		`[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]\nsecond line`,
		`[BOOTSTRAP_WAKE handoff=]`,
		`[BOOTSTRAP_WAKE handoff=a b]`,
		`BOOTSTRAP_WAKE handoff=${offer.handoff_id}`,
		`hello world`,
	];
	for (const text of nonMatching) {
		assert.equal(await f.dest.input(text), undefined, `Expected pass-through for: ${JSON.stringify(text)}`);
	}
	assert.equal(await f.dest.input(`[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`, { images: [{ type: "image", data: "x", mimeType: "image/png" }] }), undefined);
	assert.equal(f.dest.sentMessages.length, 0);
	assert.equal(existsSync(claimPath(f.source.root)), false);
	assert.equal(rejectionsOf(f.source.root).length, 0);
});

test("parked loop worker accepts a revision pane wake-up for attempt 2 and treats attempt 1 replay harmlessly", async t => {
	const { reserveRevision } = await import("./review-loop.ts");
	const { offerHandoff } = await import("./handoff.ts");
	const { buildTaskInputRecord, resultHash, upsertUpstreamIndex } = await import("./contracts.ts");
	const { completionRecord } = await import("./session-store.ts");
	const reviewPlan = {
		max_total_attempts: 4, max_total_attempts_source: "built-in" as const, node_count: 2,
		loops: [{ reviewer: "a2-n2", target: "a1-n1", members: ["a1-n1", "a2-n2"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 1, on_exhausted: "needs_attention" as const }],
	};
	const target = worker(t, {
		version: 5, topology: "chain", instance_id: "a1-n1", node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1",
		successor: "a2-n2", outbound_edges: ["a2-n2"], handoff_protocol: 1, roster, review_plan: reviewPlan,
	});
	atomicJson(readyPath(target.root, "a2-n2"), { task_id: "run-1", token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	atomicJson(join(target.root, "upstream-index.json"), { version: 2, run_id: "run-1", updated_at: new Date().toISOString(), entries: [] });
	atomicJson(taskInputPath(target.root, "a1-n1.1"), buildTaskInputRecord({
		identity: { run_id: "run-1", node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1", instance_id: "a1-n1" },
		brief: { task: "Loop", goal: "Loop" }, assignment: { sub_task: "one" }, roster,
	}));
	atomicJson(taskInputPath(target.root, "a2-n2.1"), buildTaskInputRecord({
		identity: { run_id: "run-1", node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		brief: { task: "Loop", goal: "Loop" }, assignment: { sub_task: "two" }, roster,
	}));
	await target.start();
	await target.beforeStart();
	await target.complete({ status: "success", summary: "Attempt 1", detail: "Initial" });

	const revConfig: WorkerConfig = {
		...target.config, instance_id: "a2-n2", node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1",
		predecessor: "a1-n1", successor: "a1-n1", outbound_edges: ["a1-n1"],
	};
	const revResultPath = resultPath(target.root, "a2-n2.1");
	const revComp = completionRecord(revConfig, { status: "success", agent_name: "second", node_id: "n2", summary: "Revise", detail: "Fix bug", outputs: { verdict: "revise" } }, "pending", new Date().toISOString());
	atomicJson(revResultPath, revComp);
	await upsertUpstreamIndex(target.root, "run-1", {
		node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", instance_id: "a2-n2",
		status: "success", summary: revComp.result.summary, completed_at: revComp.completed_at,
		result_path: revResultPath, result_hash: resultHash(revComp.result), outputs: revComp.result.outputs,
	});
	assert.equal(await reserveRevision(target.root, "run-1", reviewPlan, reviewPlan.loops[0], 2), undefined);
	const revOffer = offerHandoff(revConfig, revComp, revResultPath, undefined, undefined, "a1-n1", "a2-n2", 2);

	assert.deepEqual(await target.input(`[BOOTSTRAP_WAKE handoff=${revOffer.handoff_id}]`), { action: "handled" });
	assert.equal(target.sentMessages.length, 1);
	const prompt2 = await target.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: target.sentMessages[0]!.message });
	assert.match(prompt2.systemPrompt, /Attempt: a1-n1\.2\./);
	assert.equal(readJson<any>(join(target.root, "a1-n1.2.from-a2-n2.handoff.json")).handoff_id, revOffer.handoff_id);
});

test("join node accepts pane wake-ups for its inbound edges and replays harmlessly once claimed", async t => {
	const { offerHandoff } = await import("./handoff.ts");
	const { buildTaskInputRecord, resultHash, upsertUpstreamIndex } = await import("./contracts.ts");
	const { completionRecord } = await import("./session-store.ts");
	const joinRoster = [
		{ instance_id: "a1-left", node_id: "left", persona_name: "first", sub_task: "left" },
		{ instance_id: "a2-right", node_id: "right", persona_name: "first", sub_task: "right" },
		{ instance_id: "a3-join", node_id: "join", persona_name: "second", sub_task: "join" },
	];
	const leftCfg: WorkerConfig = {
		version: 4, task_id: "join-run", token: "token", session_dir: "", project_cwd: "",
		coms_dir: "", coms_project: "p", instance_id: "a1-left", node_id: "left", persona_name: "first", attempt_id: "a1-left.1",
		persona: "P", tools: [], sub_task: "left", topology: "graph", outbound_edges: ["a3-join"], handoff_protocol: 1,
		roster: joinRoster, startup_message: "bootstrap-start:token:a1-left", ready_timeout_ms: 1000,
	};
	const joinDest = worker(t, {
		version: 4, task_id: "join-run", token: "token", instance_id: "a3-join", node_id: "join", persona_name: "second", attempt_id: "a3-join.1",
		topology: "graph", inbound_edges: ["a1-left", "a2-right"], dependency_policy: "require_success", handoff_protocol: 1,
		roster: joinRoster, startup_message: "bootstrap-start:token:a3-join",
	});
	const root = joinDest.root;
	leftCfg.session_dir = root; leftCfg.project_cwd = root; leftCfg.coms_dir = join(root, "coms");
	const rightCfg: WorkerConfig = { ...leftCfg, instance_id: "a2-right", node_id: "right", attempt_id: "a2-right.1", sub_task: "right" };
	atomicJson(taskInputPath(root, "a3-join"), buildTaskInputRecord({
		identity: { run_id: "join-run", node_id: "join", persona_name: "second", attempt_id: "a3-join.1", instance_id: "a3-join" },
		brief: { task: "Join", goal: "Join" }, assignment: { sub_task: "join" }, roster: joinRoster,
	}));
	const leftComp = completionRecord(leftCfg, { status: "success", agent_name: "first", node_id: "left", summary: "L", detail: "L" }, "pending", new Date().toISOString());
	const rightComp = completionRecord(rightCfg, { status: "success", agent_name: "first", node_id: "right", summary: "R", detail: "R" }, "pending", new Date().toISOString());
	atomicJson(resultPath(root, "a1-left"), leftComp);
	atomicJson(resultPath(root, "a2-right"), rightComp);
	await upsertUpstreamIndex(root, "join-run", { node_id: "left", persona_name: "first", attempt_id: "a1-left.1", instance_id: "a1-left", status: "success", summary: "L", completed_at: leftComp.completed_at, result_path: resultPath(root, "a1-left"), result_hash: resultHash(leftComp.result) });
	await upsertUpstreamIndex(root, "join-run", { node_id: "right", persona_name: "first", attempt_id: "a2-right.1", instance_id: "a2-right", status: "success", summary: "R", completed_at: rightComp.completed_at, result_path: resultPath(root, "a2-right"), result_hash: resultHash(rightComp.result) });
	const leftOffer = offerHandoff(leftCfg, leftComp, resultPath(root, "a1-left"), undefined, undefined, "a3-join", "a1-left");
	const rightOffer = offerHandoff(rightCfg, rightComp, resultPath(root, "a2-right"), undefined, undefined, "a3-join", "a2-right");
	await joinDest.start();

	assert.deepEqual(await joinDest.input(`[BOOTSTRAP_WAKE handoff=${rightOffer.handoff_id}]`), { action: "handled" });
	assert.equal(joinDest.sentMessages.length, 1);
	const prompt = await joinDest.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: joinDest.sentMessages[0]!.message });
	assert.match(prompt.systemPrompt, /Accepted join handoffs:/);
	const claim = readJson<any>(join(root, "a3-join.handoff.json"));
	assert.deepEqual(claim.handoff_ids, [leftOffer.handoff_id, rightOffer.handoff_id]);

	// Replaying either inbound handoff ID via pane wake is a harmless replay.
	assert.deepEqual(await joinDest.input(`[BOOTSTRAP_WAKE handoff=${leftOffer.handoff_id}]`), { action: "handled" });
	assert.equal(joinDest.sentMessages.length, 1);
});

test("graph loop target at attempt 2 and graph join loop target resolve feedback vs join edges on pane wake-ups", async t => {
	const { offerHandoff } = await import("./handoff.ts");
	const { reserveRevision } = await import("./review-loop.ts");
	const { buildTaskInputRecord, resultHash, upsertUpstreamIndex } = await import("./contracts.ts");
	const { completionRecord } = await import("./session-store.ts");

	// 1. Graph loop target with an inbound_edges DAG predecessor (not a root node) revising at attempt 2
	const graphPlan = {
		max_total_attempts: 6, max_total_attempts_source: "built-in" as const, node_count: 3,
		loops: [{ reviewer: "a2-review", target: "a1-build", members: ["a1-build", "a2-review"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 2, on_exhausted: "needs_attention" as const }],
	};
	const graphRoster = [
		{ instance_id: "a0-init", node_id: "init", persona_name: "first", sub_task: "init" },
		{ instance_id: "a1-build", node_id: "build", persona_name: "first", sub_task: "build" },
		{ instance_id: "a2-review", node_id: "review", persona_name: "second", sub_task: "review" },
	];
	const buildWorker = worker(t, {
		version: 6, task_id: "graph-loop-1", token: "token", instance_id: "a1-build", node_id: "build", persona_name: "first", attempt_id: "a1-build.1",
		topology: "graph", inbound_edges: ["a0-init"], predecessor: "a0-init", outbound_edges: ["a2-review"], dependency_policy: "require_success",
		handoff_protocol: 1, roster: graphRoster, review_plan: graphPlan, startup_message: "bootstrap-start:token:a1-build",
	});
	const gRoot = buildWorker.root;
	const initCfg: WorkerConfig = { ...buildWorker.config, instance_id: "a0-init", node_id: "init", attempt_id: "a0-init.1", inbound_edges: undefined, predecessor: undefined, outbound_edges: ["a1-build"] };
	const revCfg: WorkerConfig = { ...buildWorker.config, instance_id: "a2-review", node_id: "review", persona_name: "second", attempt_id: "a2-review.1", inbound_edges: ["a1-build"], predecessor: "a1-build", outbound_edges: ["a1-build"] };
	atomicJson(readyPath(gRoot, "a2-review"), { task_id: "graph-loop-1", token: "token", instance_id: "a2-review", session_id: "sess-rev" });
	atomicJson(join(gRoot, "upstream-index.json"), { version: 2, run_id: "graph-loop-1", updated_at: new Date().toISOString(), entries: [] });
	for (const [id, node, persona, sub] of [["a1-build", "build", "first", "build"], ["a2-review", "review", "second", "review"]] as const) {
		atomicJson(taskInputPath(gRoot, `${id}.1`), buildTaskInputRecord({
			identity: { run_id: "graph-loop-1", node_id: node, persona_name: persona, attempt_id: `${id}.1`, instance_id: id },
			brief: { task: "G", goal: "G" }, assignment: { sub_task: sub }, roster: graphRoster,
		}));
	}
	const initComp = completionRecord(initCfg, { status: "success", agent_name: "first", node_id: "init", summary: "Init", detail: "Init" }, "pending", new Date().toISOString());
	atomicJson(resultPath(gRoot, "a0-init.1"), initComp);
	await upsertUpstreamIndex(gRoot, "graph-loop-1", { node_id: "init", persona_name: "first", attempt_id: "a0-init.1", instance_id: "a0-init", status: "success", summary: "Init", completed_at: initComp.completed_at, result_path: resultPath(gRoot, "a0-init.1"), result_hash: resultHash(initComp.result) });
	const attempt1Offer = offerHandoff(initCfg, initComp, resultPath(gRoot, "a0-init.1"), undefined, undefined, "a1-build", "a0-init", 1);
	await buildWorker.start();
	assert.deepEqual(await buildWorker.input(`[BOOTSTRAP_WAKE handoff=${attempt1Offer.handoff_id}]`), { action: "handled" });
	await buildWorker.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: buildWorker.sentMessages[0]!.message });
	await buildWorker.complete({ status: "success", summary: "Build 1", detail: "Done 1" });

	const rev1Path = resultPath(gRoot, "a2-review.1");
	const rev1Comp = completionRecord(revCfg, { status: "success", agent_name: "second", node_id: "review", summary: "Revise", detail: "Fix", outputs: { verdict: "revise" } }, "pending", new Date().toISOString());
	atomicJson(rev1Path, rev1Comp);
	await upsertUpstreamIndex(gRoot, "graph-loop-1", { node_id: "review", persona_name: "second", attempt_id: "a2-review.1", instance_id: "a2-review", status: "success", summary: "Revise", completed_at: rev1Comp.completed_at, result_path: rev1Path, result_hash: resultHash(rev1Comp.result), outputs: rev1Comp.result.outputs });
	assert.equal(await reserveRevision(gRoot, "graph-loop-1", graphPlan, graphPlan.loops[0], 2), undefined);
	const attempt2Offer = offerHandoff(revCfg, rev1Comp, rev1Path, undefined, undefined, "a1-build", "a2-review", 2);

	// Mismatched wake-up while parked for attempt 2 refuses cleanly against a1-build.2.from-a2-review
	assert.deepEqual(await buildWorker.input(`[BOOTSTRAP_WAKE handoff=h-${"0".repeat(32)}]`), { action: "handled" });
	assert.equal(buildWorker.sentMessages.length, 1);
	assert.equal(readJson<any>(join(gRoot, "a1-build.2.from-a2-review.handoff-rejections.json")).rejections.at(-1)?.kind, "conflict");

	// Valid wake-up for attempt 2 looks up a1-build.2.from-a2-review (not inbound_edges[0] = a0-init) and claims!
	assert.deepEqual(await buildWorker.input(`[BOOTSTRAP_WAKE handoff=${attempt2Offer.handoff_id}]`), { action: "handled" });
	assert.equal(buildWorker.sentMessages.length, 2);
	const prompt2 = await buildWorker.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: buildWorker.sentMessages[1]!.message });
	assert.match(prompt2.systemPrompt, /Attempt: a1-build\.2\./);
	assert.equal(readJson<any>(join(gRoot, "a1-build.2.from-a2-review.handoff.json")).handoff_id, attempt2Offer.handoff_id);

	// Replaying either attempt 2 or attempt 1 handoff while on attempt 2 is a harmless duplicate replay.
	assert.deepEqual(await buildWorker.input(`[BOOTSTRAP_WAKE handoff=${attempt2Offer.handoff_id}]`), { action: "handled" });
	assert.deepEqual(await buildWorker.input(`[BOOTSTRAP_WAKE handoff=${attempt1Offer.handoff_id}]`), { action: "handled" });
	assert.equal(buildWorker.sentMessages.length, 2);

	// 2. Graph join node that is also a loop target (attempt 1 join, attempt 2 single-edge feedback)
	const joinLoopPlan = {
		max_total_attempts: 8, max_total_attempts_source: "built-in" as const, node_count: 4,
		loops: [{ reviewer: "a4-review", target: "a3-join", members: ["a3-join", "a4-review"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 2, on_exhausted: "needs_attention" as const }],
	};
	const joinLoopRoster = [
		{ instance_id: "a1-left", node_id: "left", persona_name: "first", sub_task: "left" },
		{ instance_id: "a2-right", node_id: "right", persona_name: "first", sub_task: "right" },
		{ instance_id: "a3-join", node_id: "join", persona_name: "first", sub_task: "join" },
		{ instance_id: "a4-review", node_id: "review", persona_name: "second", sub_task: "review" },
	];
	const joinLoop = worker(t, {
		version: 6, task_id: "join-loop-1", token: "token", instance_id: "a3-join", node_id: "join", persona_name: "first", attempt_id: "a3-join.1",
		topology: "graph", inbound_edges: ["a1-left", "a2-right"], predecessor: "a1-left", outbound_edges: ["a4-review"], dependency_policy: "require_success",
		handoff_protocol: 1, roster: joinLoopRoster, review_plan: joinLoopPlan, startup_message: "bootstrap-start:token:a3-join",
	});
	const jRoot = joinLoop.root;
	const leftCfg: WorkerConfig = { ...joinLoop.config, instance_id: "a1-left", node_id: "left", attempt_id: "a1-left.1", inbound_edges: undefined, predecessor: undefined, outbound_edges: ["a3-join"] };
	const rightCfg: WorkerConfig = { ...leftCfg, instance_id: "a2-right", node_id: "right", attempt_id: "a2-right.1" };
	const jRevCfg: WorkerConfig = { ...joinLoop.config, instance_id: "a4-review", node_id: "review", persona_name: "second", attempt_id: "a4-review.1", inbound_edges: ["a3-join"], predecessor: "a3-join", outbound_edges: ["a3-join"] };
	atomicJson(readyPath(jRoot, "a4-review"), { task_id: "join-loop-1", token: "token", instance_id: "a4-review", session_id: "sess-jrev" });
	atomicJson(join(jRoot, "upstream-index.json"), { version: 2, run_id: "join-loop-1", updated_at: new Date().toISOString(), entries: [] });
	for (const [id, node, persona, sub] of [["a3-join", "join", "first", "join"], ["a4-review", "review", "second", "review"]] as const) {
		atomicJson(taskInputPath(jRoot, `${id}.1`), buildTaskInputRecord({
			identity: { run_id: "join-loop-1", node_id: node, persona_name: persona, attempt_id: `${id}.1`, instance_id: id },
			brief: { task: "JL", goal: "JL" }, assignment: { sub_task: sub }, roster: joinLoopRoster,
		}));
	}
	const lComp = completionRecord(leftCfg, { status: "success", agent_name: "first", node_id: "left", summary: "L", detail: "L" }, "pending", new Date().toISOString());
	const rComp = completionRecord(rightCfg, { status: "success", agent_name: "first", node_id: "right", summary: "R", detail: "R" }, "pending", new Date().toISOString());
	atomicJson(resultPath(jRoot, "a1-left.1"), lComp);
	atomicJson(resultPath(jRoot, "a2-right.1"), rComp);
	await upsertUpstreamIndex(jRoot, "join-loop-1", { node_id: "left", persona_name: "first", attempt_id: "a1-left.1", instance_id: "a1-left", status: "success", summary: "L", completed_at: lComp.completed_at, result_path: resultPath(jRoot, "a1-left.1"), result_hash: resultHash(lComp.result) });
	await upsertUpstreamIndex(jRoot, "join-loop-1", { node_id: "right", persona_name: "first", attempt_id: "a2-right.1", instance_id: "a2-right", status: "success", summary: "R", completed_at: rComp.completed_at, result_path: resultPath(jRoot, "a2-right.1"), result_hash: resultHash(rComp.result) });
	const lOffer = offerHandoff(leftCfg, lComp, resultPath(jRoot, "a1-left.1"), undefined, undefined, "a3-join", "a1-left", 1);
	const rOffer = offerHandoff(rightCfg, rComp, resultPath(jRoot, "a2-right.1"), undefined, undefined, "a3-join", "a2-right", 1);
	await joinLoop.start();

	// Mismatched join wake-up refuses without claiming
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=h-${"f".repeat(32)}]`), { action: "handled" });
	assert.equal(joinLoop.sentMessages.length, 0);
	assert.equal(readJson<any>(join(jRoot, "a3-join.1.from-a1-left.handoff-rejections.json")).rejections.at(-1)?.kind, "offer");

	// Valid join wake-up claims attempt 1 join, completes, and parks
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=${lOffer.handoff_id}]`), { action: "handled" });
	await joinLoop.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: joinLoop.sentMessages[0]!.message });
	await joinLoop.complete({ status: "success", summary: "Join 1", detail: "Joined" });

	const jRevPath = resultPath(jRoot, "a4-review.1");
	const jRevComp = completionRecord(jRevCfg, { status: "success", agent_name: "second", node_id: "review", summary: "Revise join", detail: "Fix", outputs: { verdict: "revise" } }, "pending", new Date().toISOString());
	atomicJson(jRevPath, jRevComp);
	await upsertUpstreamIndex(jRoot, "join-loop-1", { node_id: "review", persona_name: "second", attempt_id: "a4-review.1", instance_id: "a4-review", status: "success", summary: "Revise join", completed_at: jRevComp.completed_at, result_path: jRevPath, result_hash: resultHash(jRevComp.result), outputs: jRevComp.result.outputs });
	assert.equal(await reserveRevision(jRoot, "join-loop-1", joinLoopPlan, joinLoopPlan.loops[0], 2), undefined);
	const jAttempt2Offer = offerHandoff(jRevCfg, jRevComp, jRevPath, undefined, undefined, "a3-join", "a4-review", 2);

	// Replaying attempt 1 join handoff while parked is a harmless replay (not a bogus refusal)
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=${rOffer.handoff_id}]`), { action: "handled" });
	assert.equal(joinLoop.sentMessages.length, 1);
	assert.equal(existsSync(join(jRoot, "a3-join.2.from-a4-review.handoff-rejections.json")), false);

	// Attempt 2 wake-up for join loop target takes the single-edge feedback path and claims a3-join.2.from-a4-review
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=${jAttempt2Offer.handoff_id}]`), { action: "handled" });
	assert.equal(joinLoop.sentMessages.length, 2);
	const jPrompt2 = await joinLoop.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: joinLoop.sentMessages[1]!.message });
	assert.match(jPrompt2.systemPrompt, /Attempt: a3-join\.2\./);
	assert.equal(readJson<any>(join(jRoot, "a3-join.2.from-a4-review.handoff.json")).handoff_id, jAttempt2Offer.handoff_id);

	// Replaying attempt 1 join handoff OR attempt 2 feedback handoff while running attempt 2 is a harmless duplicate replay
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=${lOffer.handoff_id}]`), { action: "handled" });
	assert.deepEqual(await joinLoop.input(`[BOOTSTRAP_WAKE handoff=${jAttempt2Offer.handoff_id}]`), { action: "handled" });
	assert.equal(joinLoop.sentMessages.length, 2);
});

test("pane wake-up records a refusal when worker is held for attention or cannot dispatch sendMessage", async t => {
	// 1. Held for attention (restarted after claim without result)
	const held = await destination(t);
	const heldOffer = readJson<any>(offerPath(held.source.root));
	await held.dest.beforeStart(held.notify());
	await held.dest.hooks.get("session_shutdown")!({ reason: "quit" });
	const restarted = worker(t, chainNode(2), held.source.root);
	await restarted.start();
	assert.deepEqual(await restarted.input(`[BOOTSTRAP_WAKE handoff=h-${"e".repeat(32)}]`), { action: "handled" });
	assert.equal(restarted.sentMessages.length, 0);
	assert.equal(rejectionsOf(held.source.root).at(-1)?.kind, "conflict");
	assert.match(restarted.notifications.at(-1)?.message ?? "", /held for attention/);

	// 2. Missing pi.sendMessage records a refusal instead of failing silently
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	const hooks = new Map<string, Function>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const cfgPath = join(source.root, "a2-nosend.config.json");
	const cfg: WorkerConfig = { ...source.config, instance_id: "a2-n2", node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", predecessor: "a1-n1", successor: undefined, dependency_policy: "require_success" };
	atomicJson(cfgPath, cfg);
	atomicJson(join(cfg.coms_dir, "projects", cfg.coms_project, "agents", "a2-n2.json"), { pid: process.pid, name: "a2-n2", session_id: "s-nosend", endpoint: "/fake/sock", model: "model" });
	const ctx = { model: { provider: "provider", id: "model" }, ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) }, shutdown: () => {}, abort: () => {}, executeTool: async () => ({ content: [] }) };
	registerWorker({
		registerFlag: () => {}, getFlag: (name: string) => name === "bootstrap-worker-config" ? cfgPath : undefined,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, c = ctx) => handler(event, c)),
		registerTool: () => {}, getActiveTools: () => ["read"], getAllTools: () => ["read", "coms_send"].map(name => ({ name })), setActiveTools: () => {},
	} as any);
	await hooks.get("session_start")!({}, ctx);
	assert.deepEqual(await hooks.get("input")!({ text: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]` }, ctx), { action: "handled" });
	assert.equal(existsSync(claimPath(source.root)), false);
	assert.equal(rejectionsOf(source.root).at(-1)?.kind, "conflict");
	assert.match(notifications.at(-1)?.message ?? "", /sendMessage unavailable/);
});

// ---- sender fallback wake-up and transport recording (ticket 06) ----

function withFakeHerdrOnPath(t: test.TestContext, options: { paneExists?: boolean; sendFail?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "bootstrap-fake-herdr-"));
	const binDir = join(dir, "bin");
	const logPath = join(dir, "herdr.log");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const prevPath = process.env.PATH ?? "";
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
	if (${JSON.stringify(options.paneExists === false)}) {
		process.stderr.write(JSON.stringify({ error: "pane not found" }) + "\\n");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: "ws-1", agent_status: "working" } } }));
	process.exit(0);
}
if (args[0] === "pane" && (args[1] === "send-text" || args[1] === "send-keys")) {
	if (${JSON.stringify(Boolean(options.sendFail))}) {
		process.stderr.write("injection failed\\n");
		process.exit(1);
	}
	process.exit(0);
}
process.exit(2);
`;
	const fakeBin = join(binDir, "herdr");
	writeFileSync(fakeBin, script, { mode: 0o755 });
	process.env.PATH = `${binDir}:${prevPath}`;
	t.after(() => {
		process.env.PATH = prevPath;
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		calls: (): string[][] => existsSync(logPath)
			? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
			: [],
	};
}

test("completing worker records Coms transport without calling herdr on the primary path", async t => {
	const fake = withFakeHerdrOnPath(t);
	const source = worker(t, chainNode(1));
	writeTaskInput(source.root, 2);
	atomicJson(join(source.root, "upstream-index.json"), { version: 2, run_id: "run-1", updated_at: new Date().toISOString(), entries: [] });
	atomicJson(readyPath(source.root, "a2-n2"), {
		version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
		pid: process.pid, session_id: "session-a2-n2", pane_id: "pane-dest-1",
	});
	await source.start();
	await source.beforeStart();
	const res = await source.complete({ status: "success", summary: "Built", detail: "Primary Coms" });
	assert.equal(res.isError, undefined);
	assert.equal(source.shutdowns, 1);
	assert.deepEqual(fake.calls(), []);
	const offer = readJson<any>(offerPath(source.root));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "coms");
	assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
});

test("completing worker falls back once to pane wake-up on unreachable or delivery-unknown Coms errors, and destination claims", async t => {
	for (const comsErr of [
		"coms: unreachable: connect ENOENT /tmp/missing.sock",
		"coms: delivery unknown: acknowledgement not received within 5000 ms",
	]) {
		const fake = withFakeHerdrOnPath(t);
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(join(source.root, "upstream-index.json"), { version: 2, run_id: "run-1", updated_at: new Date().toISOString(), entries: [] });
		atomicJson(readyPath(source.root, "a2-n2"), {
			version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: process.pid, session_id: "session-a2-n2", pane_id: "pane-dest-2",
		});
		source.context.executeTool = async (name: string, params: unknown) => {
			source.sent.push({ name, params });
			return { isError: true, content: [{ type: "text", text: comsErr }] };
		};
		await source.start();
		await source.beforeStart();
		const res = await source.complete({ status: "success", summary: "Built", detail: "Fallback" });
		assert.equal(res.isError, undefined, JSON.stringify(res));
		assert.equal(source.sent.length, 1);
		assert.equal(source.shutdowns, 1);

		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "queued");
		assert.equal(offer.transport, "pane_fallback");
		assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
		assert.deepEqual(fake.calls(), [
			["pane", "get", "pane-dest-2"],
			["pane", "send-text", "pane-dest-2", `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`],
			["pane", "send-keys", "pane-dest-2", "Enter"],
		]);

		// Feed the recorded line into the destination worker to prove it claims the handoff.
		const injectedLine = fake.calls()[1]![3]!;
		const dest = worker(t, chainNode(2), source.root);
		await dest.start();
		assert.deepEqual(await dest.input(injectedLine), { action: "handled" });
		const prompt = await dest.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: dest.sentMessages[0]!.message });
		assert.match(prompt.systemPrompt, /Predecessor result/);
		assert.equal(readJson<any>(claimPath(source.root)).handoff_id, offer.handoff_id);
	}
});

test("completing worker does not fall back on coms: refused: or when destination process is dead, offer is claimed, pane is gone, or pane_id is absent", async t => {
	// 1. coms: refused: never triggers fallback
	{
		const fake = withFakeHerdrOnPath(t);
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(readyPath(source.root, "a2-n2"), {
			version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: process.pid, session_id: "session-a2-n2", pane_id: "pane-refused",
		});
		source.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: refused: blocked by receiver" }] });
		await source.start();
		await source.beforeStart();
		const res = await source.complete();
		assert.equal(res.isError, true);
		assert.equal(source.shutdowns, 0);
		assert.deepEqual(fake.calls(), []);
		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "offered");
		assert.equal(offer.transport, "failed");
		assert.match(offer.transport_reason, /coms: refused:/);
	}

	// 2. Dead process -> skipped with reason, no injection
	{
		const fake = withFakeHerdrOnPath(t);
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>(resolve => child.once("close", () => resolve()));
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(readyPath(source.root, "a2-n2"), {
			version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: child.pid!, session_id: "session-a2-n2", pane_id: "pane-dead",
		});
		source.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: unreachable: connect ENOENT" }] });
		await source.start();
		await source.beforeStart();
		const res = await source.complete();
		assert.equal(res.isError, true);
		assert.deepEqual(fake.calls(), []);
		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "offered");
		assert.equal(offer.transport, "skipped");
		assert.match(offer.transport_reason, /not alive/i);
	}

	// 3. Pane gone -> skipped with reason, no send-text/send-keys
	{
		const fake = withFakeHerdrOnPath(t, { paneExists: false });
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(readyPath(source.root, "a2-n2"), {
			version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: process.pid, session_id: "session-a2-n2", pane_id: "pane-gone",
		});
		source.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: unreachable: connect ENOENT" }] });
		await source.start();
		await source.beforeStart();
		const res = await source.complete();
		assert.equal(res.isError, true);
		assert.deepEqual(fake.calls(), [["pane", "get", "pane-gone"]]);
		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "offered");
		assert.equal(offer.transport, "skipped");
		assert.match(offer.transport_reason, /does not exist|not found/i);
	}

	// 4. Old-format readiness record (no pane_id) -> behaves as before (fails delivery, no herdr calls)
	{
		const fake = withFakeHerdrOnPath(t);
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(readyPath(source.root, "a2-n2"), {
			task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: process.pid, session_id: "session-a2-n2",
		});
		source.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: unreachable: connect ENOENT" }] });
		await source.start();
		await source.beforeStart();
		const res = await source.complete();
		assert.equal(res.isError, true);
		assert.equal(source.shutdowns, 0);
		assert.deepEqual(fake.calls(), []);
		assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "failed");
		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "offered");
		assert.equal(offer.transport, "skipped");
		assert.match(offer.transport_reason, /pane_id/i);
	}

	// 5. Fallback herdr send fails -> recorded as failed with reason
	{
		const fake = withFakeHerdrOnPath(t, { sendFail: true });
		const source = worker(t, chainNode(1));
		writeTaskInput(source.root, 2);
		atomicJson(readyPath(source.root, "a2-n2"), {
			version: 1, task_id: "run-1", token: "token", instance_id: "a2-n2",
			pid: process.pid, session_id: "session-a2-n2", pane_id: "pane-fail",
		});
		source.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: delivery unknown: timeout" }] });
		await source.start();
		await source.beforeStart();
		const res = await source.complete();
		assert.equal(res.isError, true);
		assert.equal(fake.calls().length, 2);
		const offer = readJson<any>(offerPath(source.root));
		assert.equal(offer.state, "offered");
		assert.equal(offer.transport, "failed");
		assert.match(offer.transport_reason, /send-text/);
	}
});

test("graph fan-out falls back per unreachable edge and records transport on offer and edge_deliveries", async t => {
	const fake = withFakeHerdrOnPath(t);
	const gRoster = [
		{ instance_id: "a1-root", node_id: "root", persona_name: "first", sub_task: "r" },
		{ instance_id: "a2-left", node_id: "left", persona_name: "second", sub_task: "l" },
		{ instance_id: "a3-right", node_id: "right", persona_name: "second", sub_task: "ri" },
	];
	const root = worker(t, {
		version: 3, topology: "graph", instance_id: "a1-root", node_id: "root", persona_name: "first", attempt_id: "a1-root.1",
		outbound_edges: ["a2-left", "a3-right"], handoff_protocol: 1, roster: gRoster,
	});
	for (const [inst, node] of [["a2-left", "left"], ["a3-right", "right"]] as const) {
		atomicJson(taskInputPath(root.root, inst), buildTaskInputRecord({
			identity: { run_id: "run-1", node_id: node, persona_name: "second", attempt_id: `${inst}.1`, instance_id: inst },
			brief: { task: "Fanout", goal: "Fanout" }, assignment: { sub_task: node }, roster: gRoster,
		}));
		atomicJson(readyPath(root.root, inst), {
			version: 1, task_id: "run-1", token: "token", instance_id: inst,
			pid: process.pid, session_id: `sess-${inst}`, pane_id: `pane-${inst}`,
		});
	}
	atomicJson(join(root.root, "upstream-index.json"), { version: 2, run_id: "run-1", updated_at: new Date().toISOString(), entries: [] });
	root.context.executeTool = async (_name: string, params: { target?: string }) => {
		if (params.target === "sess-a3-right") {
			return { isError: true, content: [{ type: "text", text: "coms: unreachable: connect ENOENT" }] };
		}
		return { content: [], details: { msg_id: "msg-ok" } };
	};
	await root.start();
	await root.beforeStart();
	const res = await root.complete({ status: "success", summary: "Fanout done", detail: "Both edges" });
	assert.equal(res.isError, undefined, JSON.stringify(res));
	assert.equal(root.shutdowns, 1);

	const comp = readJson<WorkerCompletion>(resultPath(root.root, "a1-root"));
	assert.equal(comp.delivery, "sent");
	assert.equal(comp.edge_deliveries?.["a2-left"]?.transport, "coms");
	assert.equal(comp.edge_deliveries?.["a3-right"]?.transport, "pane_fallback");

	const leftOffer = readJson<any>(join(root.root, "a2-left.from-a1-root.handoff-offer.json"));
	const rightOffer = readJson<any>(join(root.root, "a3-right.from-a1-root.handoff-offer.json"));
	assert.equal(leftOffer.transport, "coms");
	assert.equal(rightOffer.transport, "pane_fallback");
	assert.deepEqual(fake.calls(), [
		["pane", "get", "pane-a3-right"],
		["pane", "send-text", "pane-a3-right", `[BOOTSTRAP_WAKE handoff=${rightOffer.handoff_id}]`],
		["pane", "send-keys", "pane-a3-right", "Enter"],
	]);
});

test("graph deliverHandoffEdge preserves offer handoff_id and records failed transport when fallback throws unexpectedly", async t => {
	const fake = withFakeHerdrOnPath(t);
	const gRoster = [
		{ instance_id: "a1-root", node_id: "root", persona_name: "first", sub_task: "r" },
		{ instance_id: "a2-dest", node_id: "dest", persona_name: "second", sub_task: "d" },
	];
	const root = worker(t, {
		version: 3, topology: "graph", instance_id: "a1-root", node_id: "root", persona_name: "first", attempt_id: "a1-root.1",
		outbound_edges: ["a2-dest"], handoff_protocol: 1, roster: gRoster,
	});
	atomicJson(taskInputPath(root.root, "a2-dest"), buildTaskInputRecord({
		identity: { run_id: "run-1", node_id: "dest", persona_name: "second", attempt_id: "a2-dest.1", instance_id: "a2-dest" },
		brief: { task: "Throw test", goal: "Throw test" }, assignment: { sub_task: "d" }, roster: gRoster,
	}));
	// Use an out-of-range PID so parseWorkerReady succeeds and process.kill throws ERR_OUT_OF_RANGE inside tryPaneWake.
	atomicJson(readyPath(root.root, "a2-dest"), {
		version: 1, task_id: "run-1", token: "token", instance_id: "a2-dest",
		pid: Number.MAX_SAFE_INTEGER, session_id: "sess-a2-dest", pane_id: "pane-dest",
	});
	atomicJson(join(root.root, "upstream-index.json"), { version: 2, run_id: "run-1", updated_at: new Date().toISOString(), entries: [] });
	root.context.executeTool = async () => ({ isError: true, content: [{ type: "text", text: "coms: unreachable: connect ENOENT" }] });
	await root.start();
	await root.beforeStart();
	const res = await root.complete({ status: "success", summary: "Done", detail: "Edge" });
	assert.equal(res.isError, true);
	assert.deepEqual(fake.calls(), []);

	const offer = readJson<any>(join(root.root, "a2-dest.from-a1-root.handoff-offer.json"));
	assert.equal(offer.state, "offered");
	assert.equal(offer.transport, "failed");
	assert.ok(offer.transport_reason);

	const comp = readJson<WorkerCompletion>(resultPath(root.root, "a1-root"));
	assert.equal(comp.delivery, "failed");
	assert.equal(comp.edge_deliveries?.["a2-dest"]?.handoff_id, offer.handoff_id);
	assert.equal(comp.edge_deliveries?.["a2-dest"]?.transport, "failed");
	assert.match(comp.edge_deliveries?.["a2-dest"]?.error ?? "", /pane fallback failed/i);
});
