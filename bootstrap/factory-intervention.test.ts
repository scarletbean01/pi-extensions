import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSupervised } from "./test-harness.ts";
import { BootstrapService } from "./lifecycle.ts";
import { awaitDirection, claimConsumption, directionProcess, inTransaction, openRequestDatabase, terminateNodeRequests, type DirectionReceiver, type DirectionRequestView } from "./factory-requests.ts";
import { atomicJson, readJson, readyPath, type WorkerReady } from "./session-store.ts";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { formatAgentStates } from "./reporting.ts";
import { writeRunCancelRecord } from "./cancellation.ts";

const CHOICES = [{ choice_id: "proceed", label: "Proceed as planned" }, { choice_id: "narrow", label: "Narrow the scope" }, { choice_id: "stop", label: "Stop here" }];
const model = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

function agents(intervention: unknown = { choices: CHOICES, required: ["stop"] }) {
	return [
		{ node_id: "build", persona: "builder", sub_task: "Fixture only", ...(intervention === undefined ? {} : { intervention }) },
		{ node_id: "docs", persona: "builder", sub_task: "Independent", depends_on: [] },
	];
}

async function fixture(t: test.TestContext, nodes: unknown[] = agents(), launch = true, deadlines: Record<string, number> = {}) {
	const f = serviceFixture(t, ["builder"]);
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "factory-coordination.sqlite") });
	const factory = open()({ action: "publish", name: "direction", draft: { topology: "graph", task: "Direction fixture", project_cwd: f.cwd, ...deadlines, agents: nodes as any }, sessionModel: model });
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(f.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "first", brief: "Fixture brief", authority });
	const run = launch ? await open()({ action: "launch", factory_id: factory.factory_id, authority }) : undefined as never;
	return { ...f, open, factory, authority, run };
}

function startWorker(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, node = "build") {
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const file = readdirSync(dir).find(name => name.endsWith(".config.json") && name.includes(node))!;
	return workerFromConfig(t, join(dir, file), { model: { provider: "test-provider", id: "test-model" } });
}

test("a definition opts a node in with its plan choices and inspection shows them", async t => {
	const f = await fixture(t, agents(), false);
	const view = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.deepEqual(view.node_policies!.build.intervention, { choices: CHOICES, required: ["stop"] });
	assert.equal(view.node_policies!.docs.intervention, undefined);
});

test("invalid intervention settings are rejected at publication naming the node", async t => {
	for (const [bad, pattern] of [
		[{ choices: [] }, /build.*choices/],
		[{ choices: [CHOICES[0], CHOICES[0]] }, /build.*duplicate/i],
		[{ choices: CHOICES, required: ["missing"] }, /build.*required.*missing/],
		[{ choices: CHOICES, extra: 1 }, /build.*extra/],
		[{ choices: [{ choice_id: "bad id", label: "x" }] }, /build.*choice_id/],
	] as const) await assert.rejects(() => fixture(t, agents(bad), false), pattern);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const inspect = (f: Fixture) => f.open()({ action: "inspect", factory_id: f.factory.factory_id });
const respond = (f: Pick<Fixture, "open" | "factory" | "authority">, request_id: string, response: unknown, authority = f.authority) => f.open()({ action: "respond_request", factory_id: f.factory.factory_id, request_id, response, authority });
const ASK = { question: "Which scope?", reason: "The brief is ambiguous", evidence: ["src/a.ts:10"], choices: ["proceed", "narrow", "stop"], recommendation: { choice_id: "narrow", rationale: "Smaller blast radius" } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function admittedWorker(t: test.TestContext, f: Fixture, node = "build") {
	const worker = startWorker(t, f, node);
	await worker.start();
	await worker.beforeStart();
	return worker;
}
async function pendingRequest(f: Pick<Fixture, "open" | "factory">) {
	for (let i = 0; i < 100; i++) {
		const found = savedRequests(f).find(item => item.state === "pending");
		if (found) return found;
		await sleep(20);
	}
	throw new Error("no pending request appeared");
}

test("an enabled admitted attempt creates a request that is persisted, listed, alerted and blocks ordinary work", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	assert.ok(worker.active.includes("bootstrap_request_direction"));
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	assert.equal(request.node_id, "build");
	assert.equal(request.task_id, f.run.task_id);
	assert.equal(request.question, ASK.question);
	assert.equal(request.reason, ASK.reason);
	assert.deepEqual(request.evidence, ASK.evidence);
	assert.deepEqual(request.choices.map(choice => choice.choice_id), ["proceed", "narrow", "stop"]);
	assert.deepEqual(request.recommendation, ASK.recommendation);
	assert.equal(request.response_recorded, false);
	const view = inspect(f);
	const alert = view.attention.find(item => item.kind === "intervention" && item.request_id === request.request_id);
	assert.match(alert?.reason ?? "", /build is waiting for a person/, "a missed alert never hides the request");
	assert.equal(view.capacity.factory_slot, "held", "waiting keeps factory capacity");
	// Ordinary work cannot continue while requesting.
	const blocked = await worker.hooks.get("tool_call")!({ toolName: "bash", input: { command: "ls" } });
	assert.match(blocked.reason, /human direction/i);
	// Silence is indefinite waiting: nothing resolves the request on its own.
	await sleep(400);
	assert.equal(inspect(f).requests![0].state, "pending");
	await f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
	await waiting;
});

test("a human wait pauses the requesting attempt deadline without resetting prior elapsed work", async t => {
	const f = await fixture(t, [agents()[0]], true, { task_timeout_ms: 1800 });
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	const worker = await admittedWorker(t, f);
	t.mock.timers.tick(600); // Spend part of the attempt's ordinary execution budget before waiting.
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	t.mock.timers.tick(5000);
	const duringWait = f.service.status(f.run.task_id);
	assert.equal(duringWait.agents[0].elapsed_ms, 600);
	assert.equal(duringWait.agents[0].deadline_exceeded, false);
	assert.doesNotMatch(formatAgentStates(duringWait.agents, "graph"), /deadline exceeded/i);
	assert.equal(inspect(f).requests!.find(item => item.request_id === request.request_id)?.state, "pending");
	assert.equal(inspect(f).capacity.factory_slot, "held");
	assert.equal(inspect(f).capacity.checkout_slot, "held");
	respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	assert.match((await waiting).content[0].text, /chose "proceed"/);
	t.mock.timers.tick(1000);
	assert.equal(f.service.status(f.run.task_id).agents[0].elapsed_ms, 1600);
	assert.equal(f.service.status(f.run.task_id).agents[0].deadline_exceeded, false, "the human wait itself does not consume the remaining budget");
	t.mock.timers.tick(200);
	assert.equal(f.service.status(f.run.task_id).agents[0].deadline_exceeded, true, "resuming preserves pre-wait elapsed time instead of resetting the timeout");
});

test("a human wait preserves a dependent chain and join while an independent deadline expires", async t => {
	const nodes = [
		{ node_id: "build", persona: "builder", sub_task: "Ask for direction", write_paths: ["src/held"], intervention: { choices: CHOICES } },
		{ node_id: "chain", persona: "builder", sub_task: "Follow build", depends_on: ["build"], dependency_wait_timeout_ms: 100 },
		{ node_id: "other", persona: "builder", sub_task: "Independent prerequisite", depends_on: [], task_timeout_ms: 100 },
		{ node_id: "join", persona: "builder", sub_task: "Join both paths", depends_on: ["chain", "other"], dependency_wait_timeout_ms: 100 },
		{ node_id: "independent", persona: "builder", sub_task: "Keep its own deadline", depends_on: [], task_timeout_ms: 100 },
		{ node_id: "ordinary", persona: "builder", sub_task: "Ordinarily waiting", depends_on: ["independent"], dependency_wait_timeout_ms: 10_000 },
	];
	const f = await fixture(t, nodes, true, { dependency_wait_timeout_ms: 100, liveness_timeout_ms: 100 });
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	const build = await admittedWorker(t, f, "build");
	const waiting = build.requestDirection(ASK);
	const request = await pendingRequest(f);
	t.mock.timers.tick(250); // Deliberately offset dependency polls from requester heartbeats.
	await admittedWorker(t, f, "chain");
	const other = await admittedWorker(t, f, "other");
	await admittedWorker(t, f, "independent");
	await admittedWorker(t, f, "ordinary");
	await admittedWorker(t, f, "join");
	await other.complete({ status: "success", summary: "Other prerequisite passed", detail: "done" });
	for (let i = 0; i < 6; i++) t.mock.timers.tick(500);
	const status = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(status.requests!.find(item => item.request_id === request.request_id)?.state, "pending");
	assert.equal(status.capacity.factory_slot, "held");
	assert.equal(status.capacity.checkout_slot, "held");
	const runStatus = f.service.status(f.run.task_id);
	assert.equal(runStatus.agents.find((node: any) => node.node_id === "build")?.ownership_status, "admitted", "waiting for a person does not release existing node ownership");
	assert.equal(runStatus.agents.find((node: any) => node.node_id === "independent")?.deadline_exceeded, true, "unrelated work keeps and expires its own deadline");
	assert.notEqual(runStatus.agents.find((node: any) => node.node_id === "chain")?.execution, "needs_attention", "transitive chain must not expire solely due to the request");
	assert.notEqual(runStatus.agents.find((node: any) => node.node_id === "join")?.execution, "needs_attention", "join must not expire solely due to the request after its other prerequisite succeeds");
	const text = formatAgentStates(runStatus.agents, "graph");
	assert.match(text, /\(build, persona builder\): [^\n]*\[waiting for a person\]/);
	assert.doesNotMatch(text, /\(build, persona builder\): [^\n]*stalled/);
	assert.match(text, /\(chain, persona builder\): [^\n]*\[waiting behind a human request\]/);
	assert.match(text, /\(join, persona builder\): [^\n]*\[waiting behind a human request\]/);
	assert.match(text, /\(ordinary, persona builder\): [^\n]*\[waiting on dependency progress\]/);
	assert.match(text, /\(independent, persona builder\): [^\n]*\[liveness: stalled\]/);
	const buildBeforeResponse = runStatus.agents.find((node: any) => node.node_id === "build");
	respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	assert.match((await waiting).content[0].text, /chose "proceed"/);
	const buildAfterResponse = f.service.status(f.run.task_id).agents.find((node: any) => node.node_id === "build");
	assert.equal(buildAfterResponse.attempt_id, buildBeforeResponse.attempt_id, "the same attempt continues after the response");
	assert.equal(await build.hooks.get("tool_call")!({ toolName: "bash", input: { command: "ls" } }), undefined, "ordinary tools are unblocked after the response is consumed");
	await cancelRun(f);
});

test("a join times out on its lost prerequisite even while another prerequisite waits for a person", async t => {
	const f = await fixture(t, [
		...agents(),
		{ node_id: "merge", persona: "builder", sub_task: "Join both", depends_on: ["build", "docs"] },
	], true, { dependency_wait_timeout_ms: 750 });
	const build = await admittedWorker(t, f);
	const waiting = build.requestDirection(ASK);
	const request = await pendingRequest(f);
	const other = await admittedWorker(t, f, "docs");
	const merge = await admittedWorker(t, f, "merge");
	other.vanish();
	await sleep(1150);
	assert.equal(merge.shutdowns, 1);
	const status = f.service.status(f.run.task_id);
	assert.equal(status.agents.find(node => node.node_id === "docs")?.liveness, "exited");
	const joined = status.agents.find(node => node.node_id === "merge")!;
	assert.equal(joined.execution, "needs_attention");
	assert.deepEqual(joined.execution_causes.map(cause => cause.node_id), ["docs"]);
	respond(f, request.request_id, { kind: "decline" });
	await waiting;
});

test("a lost requester stays inspectable by ID but cannot be answered or woken", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	void worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	assert.equal(inspect(f).requests![0].can_respond, true);
	worker.vanish();
	const lost = inspect(f).requests![0];
	assert.equal(lost.request_id, original.request_id);
	assert.equal(lost.reconciliation, "uncertain");
	assert.equal(lost.can_respond, false);
	assert.equal(lost.can_redeliver, false);
	assert.match(lost.recovery_reason!, /requester exited|identity/);
	assert.throws(() => respond(f, original.request_id, { kind: "decline" }), /cannot verify/i);
	assert.equal(inspect(f).requests![0].response_recorded, false);
});

function receiverEvidence(f: Pick<Fixture, "root">, requestId: string, change?: (identity: DirectionReceiver) => DirectionReceiver): DirectionReceiver {
	const db = new DatabaseSync(join(f.root, "factories.sqlite"));
	try {
		const row = db.prepare("SELECT * FROM factory_direction_mailboxes WHERE request_id = ?").get(requestId)!;
		const saved = JSON.parse(String(row.identity)) as DirectionReceiver;
		if (change) {
			// A contradictory but internally intact record, so this exercises identity, not checksum validation.
			const identity = JSON.stringify(change(saved));
			const digest = createHash("sha256").update(JSON.stringify([requestId, row.factory_id, identity, row.waiting, row.wake])).digest("hex");
			db.prepare("UPDATE factory_direction_mailboxes SET identity = ?, digest = ? WHERE request_id = ?").run(identity, digest, requestId);
		}
		return saved;
	} finally { db.close(); }
}

for (const evidence of ["readiness incarnation", "boot identity"] as const) test(`a live requester with changed ${evidence} cannot receive or claim an answer`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	const path = readyPath(worker.config.session_dir, worker.config.instance_id);
	const ready = readJson<WorkerReady>(path);
	const receiver = receiverEvidence(f, original.request_id);
	const change = () => {
		if (evidence === "readiness incarnation") atomicJson(path, { ...ready, direction_incarnation: randomUUID() });
		else receiverEvidence(f, original.request_id, saved => ({ ...saved, boot: randomUUID() }));
	};
	const restore = () => {
		if (evidence === "readiness incarnation") atomicJson(path, ready);
		else receiverEvidence(f, original.request_id, () => receiver);
	};
	change();
	assert.equal(directionProcess(ready.pid).start, ready.start_time, "the original PID is still alive");
	assert.throws(() => respond(f, original.request_id, { kind: "decline" }), /cannot verify.*identity/i);
	assert.equal(savedRequests(f)[0].response_recorded, false);
	restore();
	respond(f, original.request_id, { kind: "decline" }); // Publish one legitimate wake before the identity changes again.
	change();
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent.*identity/i);
	await assert.rejects(waiting, /receiver readiness changed|waiting invocation identity.*changed/);
	const [saved] = savedRequests(f);
	assert.equal(saved.consumption, "awaiting_consumption", "the live worker also refused the already-published wake");
	assert.equal(saved.reconciliation, "uncertain");
});

test("an interrupted wait cannot reattach to a different receiver in the same live process", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const abort = new AbortController();
	const waiting = worker.requestDirection(ASK, abort.signal);
	const original = await pendingRequest(f);
	abort.abort(new Error("interrupted"));
	await assert.rejects(waiting, /interrupted/);
	receiverEvidence(f, original.request_id, saved => ({ ...saved, incarnation: randomUUID() }));
	await assert.rejects(worker.requestDirection(ASK, AbortSignal.timeout(750)), /waiting invocation identity.*changed/);
	assert.equal(savedRequests(f)[0].can_respond, false);
});

test("receiver identity survives reordering of the same JSON fields", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const abort = new AbortController();
	const waiting = worker.requestDirection(ASK, abort.signal);
	const original = await pendingRequest(f);
	abort.abort(new Error("interrupted"));
	await assert.rejects(waiting, /interrupted/);
	receiverEvidence(f, original.request_id, saved => Object.fromEntries(Object.entries(saved).reverse()) as unknown as DirectionReceiver);
	const reattached = worker.requestDirection(ASK, AbortSignal.timeout(2000));
	// The tool can reattach and claim, although the persisted object order differs.
	void reattached.catch(() => {});
	assert.equal(savedRequests(f)[0].can_respond, true, "same receiver can reattach");
	respond(f, original.request_id, { kind: "decline" });
	assert.match((await reattached).content[0].text, /declined/);
});

test("a dependant times out when a live requester disappears without running its wait cleanup", async t => {
	const f = await fixture(t, [
		agents()[0],
		{ node_id: "chain", persona: "builder", sub_task: "Follow build", depends_on: ["build"] },
	], true, { dependency_wait_timeout_ms: 750 });
	const worker = await admittedWorker(t, f);
	void worker.requestDirection(ASK); // vanish stops worker timers and never runs the tool's finally block.
	const request = await pendingRequest(f);
	const chain = await admittedWorker(t, f, "chain");
	await sleep(1150);
	assert.equal(chain.shutdowns, 0, "a live requester keeps its dependant waiting");
	worker.vanish();
	await sleep(1150);
	assert.equal(chain.shutdowns, 1);
	const status = f.service.status(f.run.task_id);
	assert.equal(status.agents[0].liveness, "exited");
	assert.equal(status.agents[1].execution, "needs_attention");
	assert.match(status.agents[1].execution_reason!, /exited/);
	assert.doesNotMatch(status.agents[1].execution_reason!, /live but stalled/);
	const view = inspect(f);
	assert.equal(view.requests!.find(item => item.request_id === request.request_id)?.state, "pending", "the unanswered request is preserved");
	assert.match(view.attention.find(item => item.request_id === request.request_id)?.reason ?? "", /requester exited/);
	const text = formatAgentStates(status.agents, "graph");
	assert.match(text, /\(build, persona builder\): [^\n]*\[liveness: exited\]/);
	assert.doesNotMatch(text, /waiting for a person|waiting behind a human request/);
});

test("requests are validated against the bound definition, the admitted attempt and the plan choices", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	for (const [bad, pattern] of [
		[{ ...ASK, choices: [] }, /nonempty/i],
		[{ ...ASK, choices: ["proceed", "stop", "invented"] }, /not a plan choice/],
		[{ ...ASK, choices: ["proceed", "narrow"] }, /requires offering.*stop/],
		[{ ...ASK, recommendation: { choice_id: "invented" } }, /presented/],
		[{ ...ASK, question: "" }, /question/],
	] as const) await assert.rejects(() => worker.requestDirection(bad as any), pattern);
	assert.equal(inspect(f).requests!.length, 0);
	const docs = await admittedWorker(t, f, "docs");
	assert.equal(docs.active.includes("bootstrap_request_direction"), false);
	await assert.rejects(() => docs.requestDirection(ASK), /not enabled/);
});

test("a human selects an offered choice with guidance; the same live attempt continues once the response is consumed", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	const recorded = respond(f, request.request_id, { kind: "choice", choice_id: "narrow", guidance: "Only src/a.ts" });
	assert.equal(recorded.replayed, false);
	assert.equal(recorded.request.response_recorded, true);
	assert.equal(recorded.request.response?.responder?.pi_session_id, "manager");
	const result = await waiting;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /chose "narrow".*Only src\/a\.ts/);
	const after = inspect(f).requests![0];
	assert.equal(after.state, "responded");
	assert.equal(after.consumption, "consumed", "recorded and consumed are separate observations");
	assert.equal(after.reconciliation, "continuing", "Pi observed the answer but the node has not yet recorded a result");
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	// The same attempt keeps working and may ask again after resolution; it still owns capacity.
	assert.equal(inspect(f).capacity.factory_slot, "held");
	const second = worker.requestDirection({ ...ASK, question: "Again?" });
	const next = await pendingRequest(f);
	assert.notEqual(next.request_id, request.request_id);
	respond(f, next.request_id, { kind: "decline" });
	await second;
});

test("only Pi receiving the matching answer changes a live claim from uncertain to continuing", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	// Separate completion of the tool from Pi observing its result.
	const answer = worker.tools.get("bootstrap_request_direction").execute("ask-1", ASK, undefined, undefined, worker.context);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	const result = await answer;
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	assert.equal((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.block, true);
	const event = { toolName: "bootstrap_request_direction", input: ASK, ...result };
	await worker.hooks.get("tool_result")!({ ...event, toolCallId: "other" });
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	await worker.hooks.get("tool_result")!({ ...event, toolCallId: "ask-1" });
	assert.equal(savedRequests(f)[0].reconciliation, "continuing");
	assert.equal(inspect(f).attention.some(item => item.request_id === original.request_id), false);
	assert.equal(await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }), undefined);
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
	worker.vanish();
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain", "delivery does not prove the requester is still alive");
});

test("damage to the delivery receipt leaves the live claimed response uncertain and not replayable", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	assert.equal(savedRequests(f)[0].reconciliation, "continuing");
	const db = new DatabaseSync(join(f.root, "factories.sqlite"));
	try { db.prepare("UPDATE factory_direction_deliveries SET record_digest = 'damaged' WHERE request_id = ?").run(original.request_id); }
	finally { db.close(); }
	const [request] = savedRequests(f);
	assert.equal(request.consumption, "consumed");
	assert.equal(request.reconciliation, "uncertain");
	assert.match(request.recovery_reason!, /contradictory direction delivery evidence/);
	assert.equal(request.can_redeliver, false);
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
});

test("a decline is explicit, is not approval, and free text alone is not a response", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	for (const bad of [{ guidance: "just do it" }, "proceed", { kind: "choice" }, { kind: "choice", choice_id: "invented" }, { kind: "decline", choice_id: "proceed" }, { kind: "choice", choice_id: "proceed", extra: 1 }, null]) {
		assert.throws(() => respond(f, request.request_id, bad), /response|offered|free text|decline|Unknown/i);
	}
	assert.equal((await pendingRequest(f)).response_recorded, false);
	respond(f, request.request_id, { kind: "decline", guidance: "Stay in scope" });
	const result = await waiting;
	assert.match(result.content[0].text, /declined.*not approval.*already authorize/s);
	assert.match(result.content[0].text, /Stay in scope/);
});

test("a response is recorded once: identical retry returns the saved outcome, a changed one conflicts", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	const first = respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	const again = respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	assert.equal(again.replayed, true);
	assert.deepEqual(again.request.response, first.request.response);
	assert.throws(() => respond(f, request.request_id, { kind: "choice", choice_id: "stop" }), /different recorded response/);
	assert.throws(() => respond(f, request.request_id, { kind: "decline" }), /different recorded response/);
	await waiting;
	assert.equal(respond(f, request.request_id, { kind: "choice", choice_id: "proceed" }).request.consumption, "consumed");
});

test("only the current managing session can respond; a worker has no way to answer for the human", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	const other = createManagerAuthority({ pi_session_id: "intruder", pi_session_file: join(f.root, "other.jsonl") });
	assert.throws(() => respond(f, request.request_id, { kind: "choice", choice_id: "proceed" }, other), /managing session authority/);
	assert.throws(() => respond(f, request.request_id, { kind: "choice", choice_id: "proceed" }, {} as any), /authority/);
	assert.throws(() => respond(f, "dir_missing", { kind: "decline" }), /not found/);
	assert.equal([...worker.tools.keys()].some(name => /respond/.test(name)), false);
	assert.equal((await pendingRequest(f)).response_recorded, false);
	respond(f, request.request_id, { kind: "decline" });
	await waiting;
});

const cancelRun = (f: Fixture) => f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
test("at most one pending request exists per attempt, with another possible after resolution", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const first = worker.requestDirection(ASK);
	const { request_id } = await pendingRequest(f);
	await assert.rejects(() => worker.requestDirection(ASK), /already waiting/);
	respond(f, request_id, { kind: "decline" });
	await first;
	const second = worker.requestDirection(ASK);
	assert.notEqual((await pendingRequest(f)).request_id, request_id);
	await cancelRun(f);
	await second;
});

test("cancellation first closes the request and rejects a later response", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const { request_id: requestId } = await pendingRequest(f);
	await cancelRun(f);
	await waiting;
	assert.throws(() => respond(f, requestId, { kind: "choice", choice_id: "proceed" }), /closed because its attempt cancelled/);
	const view = inspect(f).requests![0];
	assert.equal(view.state, "cancelled");
	assert.equal(view.response_recorded, false);
	assert.equal(view.consumption, "not_applicable");
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	await assert.rejects(() => worker.requestDirection(ASK), /cancelled|admitted/, "a cancelled attempt cannot ask again");
});

test("a response recorded first is kept, yet a later cancellation stops it from ever being consumed or reviving the attempt", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const { request_id: requestId } = await pendingRequest(f);
	respond(f, requestId, { kind: "choice", choice_id: "proceed" });
	assert.equal(inspect(f).requests![0].consumption, "awaiting_consumption");
	await cancelRun(f);
	const view = inspect(f).requests![0];
	assert.equal(view.state, "responded", "the accepted response is kept");
	assert.equal(view.response?.kind, "choice");
	assert.equal(view.consumption, "never_consumed");
	assert.equal(view.terminated?.reason, "cancelled");
	assert.equal((await waiting).isError, true);
	assert.throws(() => f.open()({ action: "redeliver_response", request_id: requestId, factory_id: f.factory.factory_id, authority: f.authority }), /no wake sent/);
	assert.equal(respond(f, requestId, { kind: "choice", choice_id: "proceed" }).replayed, true, "an identical retry still returns the saved outcome");
});

for (const action of ["cancel_run", "settle_run", "clear_hold", "worker stop"] as const) test(`${action} terminates the request without overwriting a damaged mailbox`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	void waiting.catch(() => {});
	const original = await pendingRequest(f);
	if (action === "settle_run") {
		// Provide independent terminal execution evidence without closing the pending request.
		assert.equal((await worker.complete({ status: "failure", summary: "Failed", detail: "Terminal outcome" })).isError, undefined);
	} else if (action === "clear_hold") worker.vanish();
	const db = new DatabaseSync(join(f.root, "factories.sqlite"));
	t.after(() => db.close());
	db.prepare("UPDATE factory_direction_mailboxes SET digest = 'damaged' WHERE request_id = ?").run(original.request_id);
	const mailbox = () => db.prepare("SELECT * FROM factory_direction_mailboxes WHERE request_id = ?").get(original.request_id);
	const before = mailbox();
	if (action === "cancel_run") {
		assert.equal((await cancelRun(f)).cancelled, true);
		assert.equal(f.service.settlementObservations(f.run.task_id, f.cwd).cancellation.intent, "requested");
	} else if (action === "settle_run") {
		const result = await f.open()({ action, factory_id: f.factory.factory_id, authority: f.authority });
		assert.equal(result.settled, true, result.reason);
	} else if (action === "clear_hold") {
		const result = await f.open()({ action, factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority,
			confirm: async () => ({ reason: "Requester stopped", evidence: "Original process exited", acknowledged_unknown_effects: true }) });
		assert.equal(result.cleared, true);
	} else await worker.hooks.get("agent_settled")!({ aborted: true });
	const expected = action === "cancel_run" ? "cancelled" : action === "clear_hold" ? "closed" : "failed";
	const terminated = db.prepare("SELECT state, terminated_reason FROM factory_requests WHERE request_id = ?").get(original.request_id);
	assert.equal(terminated?.state, expected);
	assert.equal(terminated?.terminated_reason, expected);
	assert.deepEqual(mailbox(), before, "damaged evidence is retained exactly");
	assert.throws(() => savedRequests(f), /contradictory direction mailbox evidence/);
	assert.match(inspect(f).request_evidence_error!, /contradictory direction mailbox evidence/);
	assert.throws(() => wakeSaved(f, original.request_id), /contradictory direction mailbox evidence/);
});

test("a failed run that settles terminates its still-pending request", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	// Drive terminal run evidence directly through the completion fixture seam so settlement,
	// not the requester's shutdown hook, has to close the outstanding request.
	const completed = await worker.complete({ status: "failure", summary: "Failed while waiting", detail: "Terminal outcome" });
	assert.equal(completed.isError, undefined, completed.content[0].text);
	assert.equal(savedRequests(f)[0].state, "pending");
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.equal(settled.settled, true, settled.reason);
	const [request] = savedRequests(f);
	assert.equal(request.request_id, original.request_id);
	assert.equal(request.state, "failed");
	assert.equal(request.terminated?.reason, "failed");
	assert.throws(() => respond(f, request.request_id, { kind: "decline" }), /closed because its attempt failed/);
	assert.equal((await waiting).isError, true);
});

test("settled direction history does not become an alert when run files disappear", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	assert.equal((await worker.complete({ status: "success", summary: "Done", detail: "Terminal outcome" })).isError, undefined);
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.equal(settled.settled, true, settled.reason);
	rmSync(worker.config.session_dir, { recursive: true });
	worker.vanish();
	const [request] = savedRequests(f);
	assert.equal(request.request_id, original.request_id);
	assert.equal(request.response_recorded, true);
	assert.equal(request.consumption, "consumed");
	assert.equal(request.reconciliation, "resolved");
	assert.equal(request.can_redeliver, false);
	assert.equal(inspect(f).attention.some(item => item.request_id === original.request_id), false);
});

test("a live requester with a committed but undelivered claim stays uncertain and blocked", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	const exec = DatabaseSync.prototype.exec;
	// Throw only after the worker's real claim commit (the manager has returned).
	const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		if (sql === "COMMIT") {
			fault.mock.restore();
			throw new Error("lost consumption commit acknowledgement");
		}
	});
	await assert.rejects(waiting, /lost consumption commit acknowledgement/);
	const [request] = savedRequests(f);
	assert.equal(request.request_id, original.request_id);
	assert.equal(request.response_recorded, true);
	assert.equal(request.consumption, "consumed");
	assert.equal(request.reconciliation, "uncertain");
	assert.match(request.recovery_reason!, /claim.*no recorded result/i);
	assert.match((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} })).reason, /human direction/);
	assert.throws(() => wakeSaved(f, request.request_id), /no wake sent/);
});

test("a committed claim returns its answer without a second wait-cleanup transaction", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.tools.get("bootstrap_request_direction").execute("ask-1", ASK, undefined, undefined, worker.context);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	const exec = DatabaseSync.prototype.exec;
	let committed = false;
	const fault = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		if (committed && sql === "BEGIN IMMEDIATE") throw new Error("cannot reread after claim commit");
		exec.call(this, sql);
		if (sql === "COMMIT") committed = true;
	});
	let result;
	try { result = await waiting; assert.match(result.content[0].text, /declined/); }
	finally { fault.mock.restore(); }
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	await worker.hooks.get("tool_result")!({ toolName: "bootstrap_request_direction", toolCallId: "ask-1", input: ASK, ...result });
	assert.equal(await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }), undefined);
});

test("a waiting attempt that is cancelled stops instead of being answered", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	await cancelRun(f);
	const result = await waiting;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /closed because the attempt was cancelled/);
	assert.equal(inspect(f).requests![0].request_id, request.request_id);
});

async function commandSession(t: test.TestContext, f: Pick<Fixture, "root" | "cwd">) {
	const saved = { state: process.env.PI_FACTORY_STATE_DIR, coord: process.env.PI_FACTORY_COORDINATION_DIR };
	process.env.PI_FACTORY_STATE_DIR = f.root;
	process.env.PI_FACTORY_COORDINATION_DIR = f.root;
	t.after(() => { for (const [key, value] of [["PI_FACTORY_STATE_DIR", saved.state], ["PI_FACTORY_COORDINATION_DIR", saved.coord]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, { handler: Function }>();
	const hooks = new Map<string, Function>();
	registerBootstrap({ registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: Function) => hooks.set(name, handler), sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as any);
	const notes: Array<{ message: string; level?: string }> = [];
	const prompts: { selected?: string[]; picks: string[]; input: string | undefined } = { picks: [], input: "" };
	const ctx = {
		hasUI: true, cwd: f.cwd, sessionManager: { getSessionId: () => "human-session", getSessionFile: () => join(f.root, "human.jsonl") },
		ui: {
			notify: (message: string, level?: string) => notes.push({ message, level }), confirm: async () => true,
			select: async (_title: string, options: string[]) => { prompts.selected = options; return prompts.picks.shift(); },
			input: async () => prompts.input, setTheme: () => ({ success: true }), setTitle: () => {}, setStatus: () => {}, setFooter: () => {}, setHeader: () => {},
		},
	};
	await hooks.get("session_start")!({}, ctx);
	t.after(() => hooks.get("session_shutdown")!({}));
	const run = async (args: string) => { notes.length = 0; await commands.get("factory")!.handler(args, ctx); return notes.map(note => note.message).join("\n"); };
	return { run, notes, prompts, hooks, ctx };
}

test("the managing Pi session is alerted to a request, lists it durably and answers by choosing or declining with guidance", async t => {
	const f = await fixture(t, [agents()[0]]);
	// The launching fixture session ends; the human's Pi session takes over management.
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	for (let i = 0; i < 40 && !pi.notes.some(note => note.level === "warning"); i++) await sleep(100);
	const alert = pi.notes.find(note => note.level === "warning");
	assert.match(alert?.message ?? "", new RegExp(`/factory respond ${f.factory.factory_id} ${request.request_id}`));
	// A missed alert hides nothing: the list is durable and discoverable.
	const listed = JSON.parse(await pi.run(`requests ${f.factory.factory_id}`));
	assert.equal(listed[0].request_id, request.request_id);
	assert.equal(listed[0].state, "pending");
	pi.prompts.picks.push("Leave unanswered (stays pending)");
	assert.match(await pi.run(`respond ${f.factory.factory_id} ${request.request_id}`), /left unanswered/);
	assert.equal(inspect(f).requests![0].response_recorded, false);
	pi.prompts.picks.splice(0);
	pi.prompts.picks.push("narrow: Narrow the scope (recommended)");
	pi.prompts.input = "Only src/a.ts";
	const prompted = await pi.run(`respond ${f.factory.factory_id} ${request.request_id}`);
	assert.match(prompted, /Response recorded/);
	assert.match((await waiting).content[0].text, /chose "narrow".*Only src\/a\.ts/);
	assert.match(await pi.run(`respond ${f.factory.factory_id} ${request.request_id}`), /only a pending request can be answered/);
});

test("respond refuses bad usage, a missing UI and requests that are not pending before touching anything", async t => {
	const f = await fixture(t, [agents()[0]], false);
	const pi = await commandSession(t, f);
	assert.match(await pi.run("respond"), /Usage: \/factory respond/);
	assert.match(await pi.run("requests"), /Usage: \/factory requests/);
	assert.match(await pi.run(`respond ${f.factory.factory_id} dir_missing`), /not managed|unmanaged|authority|not found/i);
});

test("aborting the wait keeps ordinary work and completion blocked until the open request is answered, and asking again re-attaches", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const abort = new AbortController();
	const aborted = worker.requestDirection(ASK, abort.signal);
	const request = await pendingRequest(f);
	abort.abort(new Error("user interrupt"));
	await assert.rejects(() => aborted, /user interrupt/);
	for (const toolName of ["bash", "read", "bootstrap_complete"]) {
		const blocked = await worker.hooks.get("tool_call")!({ toolName, input: {} });
		assert.match(blocked?.reason ?? "", /human direction/i, `${toolName} stays blocked`);
	}
	assert.equal(inspect(f).requests![0].state, "pending");
	const again = worker.requestDirection({ ...ASK, question: "Re-asked?" });
	await sleep(300);
	assert.equal(inspect(f).requests!.length, 1, "re-attaches to the open request instead of creating or erroring");
	respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	assert.match((await again).content[0].text, /chose "proceed"/);
	assert.equal(await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }), undefined, "consumed: ordinary work resumes");
});

test("an aborted wait cannot be answered until the same attempt reattaches to the request", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const abort = new AbortController();
	const aborted = worker.requestDirection(ASK, abort.signal);
	const request = await pendingRequest(f);
	abort.abort(new Error("interrupt"));
	await assert.rejects(() => aborted);
	assert.throws(() => respond(f, request.request_id, { kind: "decline" }), /cannot verify/i);
	assert.match((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.reason ?? "", /human direction/i);
	const again = worker.requestDirection(ASK);
	respond(f, request.request_id, { kind: "decline" });
	assert.match((await again).content[0].text, /declined/);
	assert.equal(await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }), undefined);
});

test("a node that fails inside Bootstrap closes its open request instead of leaving it pending", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	await pendingRequest(f);
	await worker.hooks.get("agent_settled")!({ aborted: true });
	const view = inspect(f).requests![0];
	assert.notEqual(view.state, "pending");
	assert.ok(view.terminated);
	assert.equal(view.reconciliation, "failed");
	assert.throws(() => wakeSaved(f, view.request_id), /no wake sent/);
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	await waiting.catch(() => {});
});

test("Esc at the guidance prompt records nothing, and alerts stop once another session manages the factory", async t => {
	const f = await fixture(t, [agents()[0]]);
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const worker = await admittedWorker(t, f);
	void worker.requestDirection(ASK);
	const { request_id: requestId } = await pendingRequest(f);
	pi.prompts.picks.push("proceed: Proceed as planned");
	pi.prompts.input = undefined as any;
	assert.match(await pi.run(`respond ${f.factory.factory_id} ${requestId}`), /left unanswered/);
	assert.equal(inspect(f).requests![0].response_recorded, false);
	for (let i = 0; i < 40 && !pi.notes.some(note => note.level === "warning"); i++) await sleep(100);
	assert.ok(pi.notes.some(note => note.level === "warning"));
});

const interruptionChild = fileURLToPath(new URL("./test-support/factory-intervention-child.ts", import.meta.url));
const savedRequests = (f: Pick<Fixture, "open" | "factory">) => f.open()({ action: "requests", factory_id: f.factory.factory_id });
const wakeSaved = (f: Pick<Fixture, "open" | "factory" | "authority">, request_id: string, authority = f.authority) => f.open()({ action: "redeliver_response", factory_id: f.factory.factory_id, request_id, authority });
const continuationFile = (f: Pick<Fixture, "root">) => join(f.root, "continued-once");

function superviseAgent(t: test.TestContext, f: Pick<Fixture, "root" | "configs">, phase = "none") {
	const config = f.configs[0];
	const child = spawn(process.execPath, ["--experimental-strip-types", interruptionChild, "agent", join(config.session_dir, `${config.instance_id}.config.json`), phase, continuationFile(f)], { stdio: ["ignore", "ignore", "pipe"] });
	const exit = once(child, "close");
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	t.after(async () => { child.kill("SIGKILL"); await exit; });
	return { child, exit, stderr: () => stderr };
}

function takeOver(f: Pick<Fixture, "open" | "factory">, previous: string, label: string) {
	const authority = createManagerAuthority({ pi_session_id: label });
	f.open()({ action: "takeover", factory_id: f.factory.factory_id, authority, confirmed_manager_incarnation_id: previous });
	return authority;
}

async function interruptionFixture(t: test.TestContext) {
	const setup = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "setup"], { timeoutMs: 10_000 });
	assert.equal(setup.code, 0, setup.stderr);
	const state = JSON.parse(setup.stdout) as Pick<Fixture, "root" | "cwd" | "configs" | "factory"> & { manager: string };
	t.after(() => rmSync(state.root, { recursive: true, force: true }));
	const service = new BootstrapService({ stateDir: join(state.root, "state"), home: join(state.root, "home"), extensionDir: state.root, exec: async () => { throw new Error("Unexpected Herdr call"); } });
	return { ...state, authority: createManagerAuthority(), open: () => factoryOperations(join(state.root, "factories.sqlite"), service, { coordinationPath: join(state.root, "factory-coordination.sqlite") }) };
}

test("SIGKILL around response commit: takeover retains the same request, and duplicate wakes authorize one continuation", async t => {
	const f = await interruptionFixture(t);
	const agent = superviseAgent(t, f, "pause");
	const original = await pendingRequest(f);
	await until(() => agent.child.pid && directionProcess(agent.child.pid).state === "T", "agent did not reach its stopped wait boundary");
	let previous = f.manager;
	for (const phase of ["before_commit", "after_commit"]) {
		const manager = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "manager", f.root, f.factory.factory_id, previous, original.request_id, phase], { timeoutMs: 10_000 });
		assert.equal(manager.signal, "SIGKILL", manager.stderr);
		const { owner, recovered } = JSON.parse(manager.stdout) as { owner: string; recovered: DirectionRequestView };
		previous = owner;
		assert.equal(recovered.request_id, original.request_id);
		assert.equal(recovered.node_attempt_id, original.node_attempt_id);
		assert.equal(recovered.response_recorded, false, "before-commit death leaves no response; takeover finds the original pending request");
		assert.equal(recovered.can_respond, true);
	}
	const authority = takeOver(f, previous, "after-response");
	const path = join(f.root, "factories.sqlite");
	const beforeInspection = readFileSync(path);
	const [saved] = savedRequests(f);
	assert.deepEqual(readFileSync(path), beforeInspection, "inspection does not send a wake-up");
	assert.equal(saved.request_id, original.request_id);
	assert.equal(saved.response_recorded, true);
	assert.equal(saved.can_respond, false);
	assert.equal(saved.can_redeliver, true);
	assert.equal(saved.consumption, "awaiting_consumption");
	assert.ok(!existsSync(continuationFile(f)));
	assert.throws(() => wakeSaved(f, saved.request_id), /managing session authority/);
	// The original wait is stopped at its explicit process barrier, outside any SQLite transaction.
	try {
		assert.throws(() => respond(f, original.request_id, { kind: "choice", choice_id: "stop" }, authority), /different recorded response/);
		assert.equal(wakeSaved(f, original.request_id, authority).consumption, "awaiting_consumption");
		assert.equal(wakeSaved(f, original.request_id, authority).consumption, "awaiting_consumption");
	} finally { agent.child.kill("SIGCONT"); }
	assert.deepEqual(await agent.exit, [0, null], agent.stderr());
	const [final] = savedRequests(f);
	assert.equal(final.request_id, original.request_id);
	assert.equal(final.reconciliation, "resolved");
	assert.equal(final.consumption, "consumed");
	assert.equal(readFileSync(continuationFile(f), "utf8"), `${f.configs[0].instance_id}\n`);
	assert.equal(respond(f, original.request_id, { kind: "decline" }, authority).replayed, true);
	assert.throws(() => wakeSaved(f, original.request_id, authority), /no wake sent/);
	assert.equal(f.configs.length, 1, "no agent was recreated");
});

test("a running agent waits for /factory wake after the manager dies with a committed response", async t => {
	const f = await interruptionFixture(t);
	const agent = superviseAgent(t, f, "observe");
	const original = await pendingRequest(f);
	const manager = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "manager", f.root, f.factory.factory_id, f.manager, original.request_id, "after_commit"], { timeoutMs: 10_000 });
	assert.equal(manager.signal, "SIGKILL", manager.stderr);
	await until(() => existsSync(`${continuationFile(f)}.observed-response`), "running agent did not observe the saved response");
	assert.equal(savedRequests(f)[0].consumption, "awaiting_consumption", "observing a response is not a wake");
	assert.ok(!existsSync(`${continuationFile(f)}.premature-claim`), "an unwoken response must not even start a claim transaction");
	assert.notEqual(directionProcess(agent.child.pid!).state, "T", "the agent is not SIGSTOPped");
	assert.ok(!existsSync(continuationFile(f)));
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try {
		assert.equal(inTransaction(db, () => claimConsumption(db, original.request_id, receiverEvidence(f, original.request_id))), "not_responded", "even inside the transaction a response alone cannot authorize a claim");
	} finally { db.close(); }
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	assert.match(await pi.run(`wake ${f.factory.factory_id} ${original.request_id}`), /wake-up published/i);
	assert.deepEqual(await agent.exit, [0, null], agent.stderr());
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	assert.match(await pi.run(`wake ${f.factory.factory_id} ${original.request_id}`), /no wake sent/i);
	assert.equal(readFileSync(continuationFile(f), "utf8"), `${f.configs[0].instance_id}\n`);
});

test("a wait started on an already-consumed response cannot replay it", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	const receiver = receiverEvidence(f, original.request_id);
	await assert.rejects(awaitDirection(join(f.root, "factories.sqlite"), original.request_id, receiver, { signal: AbortSignal.timeout(500) }), /already consumed/);
});

// Inject a competing event after the worker reads the response and releases that snapshot,
// before it can open its claim transaction. No timer ordering is involved.
function atClaimBoundary(t: test.TestContext, intervene: () => void, rejectFurtherPolls = false) {
	const exec = DatabaseSync.prototype.exec;
	let raced = false;
	return t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
		if (sql === "BEGIN" && raced && rejectFurtherPolls) throw new Error("a definite duplicate claim must not poll again");
		exec.call(this, sql);
		if (sql === "ROLLBACK" && !raced) {
			raced = true;
			intervene();
		}
	});
}

for (const stop of ["run intent", "request termination", "attempt fence"] as const) test(`${stop} recorded at the claim boundary prevents consumption`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	const fault = atClaimBoundary(t, () => {
		const now = new Date().toISOString();
		if (stop === "run intent") {
			writeRunCancelRecord(worker.config.session_dir, { run_id: original.task_id, reason: "Cancellation won", requestedAt: now, graceMs: 5000 });
			return;
		}
		const db = openRequestDatabase(join(f.root, "factories.sqlite"));
		try {
			inTransaction(db, () => {
				if (stop === "request termination") terminateNodeRequests(db, original.attempt_id, original.node_id, "failed", now);
				else {
					// Keep the request and wake intact to exercise the independent attempt fence.
					const digest = createHash("sha256").update(JSON.stringify([original.attempt_id, "cancelled", now])).digest("hex");
					db.prepare("INSERT INTO factory_request_fences VALUES (?, ?, ?, ?)").run(original.attempt_id, "cancelled", now, digest);
				}
			});
		} finally { db.close(); }
	});
	try { assert.equal((await waiting).details.status, "terminated"); }
	finally { fault.mock.restore(); }
	assert.equal(savedRequests(f)[0].consumption, "never_consumed");
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
	if (stop === "request termination") {
		const db = new DatabaseSync(join(f.root, "factories.sqlite"), { readOnly: true });
		try {
			const mailbox = db.prepare("SELECT waiting, wake FROM factory_direction_mailboxes WHERE request_id = ?").get(original.request_id);
			assert.equal(mailbox?.waiting, 0, "closed request no longer advertises a receiver");
			assert.equal(mailbox?.wake, 0);
		} finally { db.close(); }
	}
});

test("a competing claim at the transaction boundary cannot return the response a second time", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	const receiver = receiverEvidence(f, original.request_id);
	respond(f, original.request_id, { kind: "decline" });
	const fault = atClaimBoundary(t, () => {
		const db = openRequestDatabase(join(f.root, "factories.sqlite"));
		try { assert.equal(inTransaction(db, () => claimConsumption(db, original.request_id, receiver)), "claimed"); }
		finally { db.close(); }
	}, true);
	try { await assert.rejects(waiting, /already consumed/); }
	finally { fault.mock.restore(); }
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
});

test("requests inspection fails closed on a hot journal and leaves crash evidence intact", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	void worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	worker.vanish(); // No worker connections are open to repair the database behind inspection's back.
	const path = join(f.root, "factories.sqlite");
	const crash = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "hot_journal", path], { timeoutMs: 10_000 });
	assert.equal(crash.signal, "SIGKILL", crash.stderr);
	const evidence = () => [readFileSync(path), readFileSync(`${path}-journal`)];
	const before = evidence();
	assert.throws(() => savedRequests(f), /hot SQLite journal/);
	assert.deepEqual(evidence(), before);
	revokeManagerAuthority(f.authority);
	takeOver(f, f.authority.incarnation_id, "explicit writer");
	assert.equal(savedRequests(f)[0].request_id, original.request_id);
});

for (const phase of ["before_commit", "after_commit"]) test(`SIGKILL ${phase} of the consumption claim never enables another turn`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const agent = superviseAgent(t, f, phase);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	assert.deepEqual(await agent.exit, [null, "SIGKILL"], agent.stderr());
	revokeManagerAuthority(f.authority);
	const next = takeOver(f, f.authority.incarnation_id, "replacement");
	const [saved] = savedRequests(f);
	assert.equal(saved.request_id, original.request_id);
	assert.equal(saved.response_recorded, true);
	assert.equal(saved.consumption, phase === "after_commit" ? "consumed" : "awaiting_consumption");
	assert.equal(saved.reconciliation, "uncertain");
	assert.match(saved.recovery_reason!, /requester exited|process|ENOENT/i);
	assert.equal(saved.can_redeliver, false);
	assert.throws(() => wakeSaved(f, original.request_id, next), /no wake sent/);
	assert.ok(!existsSync(continuationFile(f)), "no ordinary work ran and no new agent was created");
	assert.equal(f.configs.length, 1);
});

async function until<T>(observe: () => T | false | undefined, diagnostic: string): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const value = observe();
		if (value) return value;
		await sleep(20);
	}
	throw new Error(diagnostic);
}

test("SIGKILL of isolated Herdr loses its attached requester without reviving it", async t => {
	const capability = await runSupervised("herdr", ["--version"], { timeoutMs: 3000 }).catch(() => undefined);
	if (!capability || capability.code !== 0) return t.skip("Herdr CLI is not available");
	const f = await fixture(t, [agents()[0]]);
	const session = "crash";
	const env = { HOME: f.home, XDG_CONFIG_HOME: join(f.root, "h"), XDG_STATE_HOME: join(f.root, "hs"), XDG_RUNTIME_DIR: join(f.root, "hr"), PATH: process.env.PATH, SHELL: "/bin/sh", TERM: "xterm" };
	mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
	const socket = join(env.XDG_CONFIG_HOME, "herdr", "sessions", session, "herdr-client.sock");
	const server = spawn("herdr", ["--session", session, "server"], { env, stdio: "ignore" });
	const exited = once(server, "close");
	t.after(async () => { server.kill("SIGKILL"); await exited; });
	await until(() => existsSync(socket), "isolated Herdr did not start");
	const cli = async (...args: string[]) => {
		const result = await runSupervised("herdr", ["--session", session, ...args], { timeoutMs: 5000, env });
		assert.equal(result.code, 0, result.stderr);
		return result.stdout.trim() ? JSON.parse(result.stdout).result : undefined;
	};
	const { root_pane } = await cli("workspace", "create", "--cwd", f.cwd);
	const config = f.configs[0];
	const quote = (arg: string) => `'${arg.replaceAll("'", "'\\\"'\\\"'")}'`;
	await cli("pane", "run", root_pane.pane_id, `exec ${[process.execPath, "--experimental-strip-types", interruptionChild, "agent", join(config.session_dir, `${config.instance_id}.config.json`), "none", continuationFile(f)].map(quote).join(" ")}`);
	const original = await pendingRequest(f);
	assert.equal(original.can_respond, true);
	assert.equal(server.kill("SIGKILL"), true);
	assert.deepEqual(await exited, [null, "SIGKILL"]);
	const lost = await until(() => savedRequests(f).find(row => row.reconciliation === "uncertain"), "requester remained actionable after Herdr and its pane were lost");
	assert.equal(lost.request_id, original.request_id);
	assert.equal(lost.response_recorded, false);
	assert.equal(lost.can_respond, false);
	assert.throws(() => respond(f, original.request_id, { kind: "decline" }), /cannot verify/i);
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
	assert.ok(!existsSync(continuationFile(f)));
});

for (const damage of [
	"DROP TABLE factory_direction_mailboxes",
	"DELETE FROM factory_direction_mailboxes",
	"UPDATE factory_direction_mailboxes SET digest = 'damaged'",
	"DELETE FROM factory_requests",
]) test(`inspection and response fail closed without changing damaged evidence: ${damage}`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	void worker.requestDirection(ASK).catch(() => {});
	const original = await pendingRequest(f);
	const path = join(f.root, "factories.sqlite");
	const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
	try { db.exec(damage); } finally { db.close(); }
	const before = readFileSync(path);
	const reported = /mailbox.*(missing|evidence)|request .*missing/i;
	assert.throws(() => savedRequests(f), reported);
	if (damage.startsWith("DROP TABLE")) assert.throws(() => inspect(f), reported);
	else assert.match(inspect(f).request_evidence_error!, reported);
	assert.throws(() => respond(f, original.request_id, { kind: "decline" }), reported);
	assert.throws(() => wakeSaved(f, original.request_id), reported);
	assert.deepEqual(readFileSync(path), before);
	const blocked = await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} });
	assert.match(blocked.reason, /cannot verify.*human-direction/i);
});

test("v8 migration does not infer delivery from a live attempt's old consumption claim", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	const path = join(f.root, "factories.sqlite");
	const db = new DatabaseSync(path);
	try { db.exec("DROP TABLE factory_direction_deliveries; PRAGMA user_version = 8"); } finally { db.close(); }
	const before = readFileSync(path);
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	assert.deepEqual(readFileSync(path), before, "inspection does not migrate");
	f.open()({ action: "resume", factory_id: f.factory.factory_id, authority: f.authority });
	const [saved] = savedRequests(f);
	assert.equal(saved.request_id, original.request_id);
	assert.equal(saved.consumption, "consumed");
	assert.equal(saved.reconciliation, "uncertain");
	assert.equal(saved.can_redeliver, false);
	const migrated = new DatabaseSync(path, { readOnly: true });
	try {
		assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 9);
		assert.equal(migrated.prepare("SELECT count(*) AS count FROM factory_direction_deliveries").get()?.count, 0);
	} finally { migrated.close(); }
});

test("v7 migration retains the request ID and response history but never infers a recoverable receiver", async t => {
	const f = await fixture(t, [agents()[0]]);
	const agent = superviseAgent(t, f, "pause");
	const original = await pendingRequest(f);
	await until(() => agent.child.pid && directionProcess(agent.child.pid).state === "T", "agent did not reach its stopped wait boundary");
	respond(f, original.request_id, { kind: "decline" });
	const path = join(f.root, "factories.sqlite");
	const db = new DatabaseSync(path);
	try { db.exec("DROP TABLE factory_direction_deliveries; DROP TABLE factory_direction_mailboxes; PRAGMA user_version = 7"); } finally { db.close(); }
	const before = readFileSync(path);
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	assert.deepEqual(readFileSync(path), before, "read-only inspection does not migrate");
	f.open()({ action: "resume", factory_id: f.factory.factory_id, authority: f.authority });
	const [saved] = savedRequests(f);
	assert.equal(saved.request_id, original.request_id);
	assert.equal(saved.response_recorded, true);
	assert.equal(saved.consumption, "awaiting_consumption");
	assert.equal(saved.can_redeliver, false);
	assert.match(saved.recovery_reason!, /legacy|original waiting invocation/);
	assert.throws(() => wakeSaved(f, original.request_id), /no wake sent/);
});
