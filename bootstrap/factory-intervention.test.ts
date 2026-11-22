import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claimConsumption, createRequest, inTransaction, openRequestDatabase } from "./factory-requests.ts";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { formatAgentStates } from "./reporting.ts";

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
const respond = (f: Fixture, request_id: string, response: unknown, authority = f.authority) => f.open()({ action: "respond_request", factory_id: f.factory.factory_id, request_id, response, authority });
const ASK = { question: "Which scope?", reason: "The brief is ambiguous", evidence: ["src/a.ts:10"], choices: ["proceed", "narrow", "stop"], recommendation: { choice_id: "narrow", rationale: "Smaller blast radius" } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function admittedWorker(t: test.TestContext, f: Fixture, node = "build") {
	const worker = startWorker(t, f, node);
	await worker.start();
	await worker.beforeStart();
	return worker;
}
async function pendingRequest(f: Fixture) {
	for (let i = 0; i < 100; i++) {
		const found = inspect(f).requests?.find(item => item.state === "pending");
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
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	// The same attempt keeps working and may ask again after resolution; it still owns capacity.
	assert.equal(inspect(f).capacity.factory_slot, "held");
	const second = worker.requestDirection({ ...ASK, question: "Again?" });
	const next = await pendingRequest(f);
	assert.notEqual(next.request_id, request.request_id);
	respond(f, next.request_id, { kind: "decline" });
	await second;
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
function directRequest(f: Fixture) {
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try {
		return inTransaction(db, () => createRequest(db, { factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, node_id: "build", node_attempt_id: "build", question: "Q?", reason: "R", choices: ["proceed", "stop"] })).request_id;
	} finally { db.close(); }
}
function claim(f: Fixture, requestId: string) {
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { return inTransaction(db, () => claimConsumption(db, requestId)); } finally { db.close(); }
}

test("at most one pending request exists per attempt, with another possible after resolution", async t => {
	const f = await fixture(t);
	const first = directRequest(f);
	assert.throws(() => directRequest(f), /already has a pending request/);
	respond(f, first, { kind: "decline" });
	const second = directRequest(f);
	assert.notEqual(second, first);
});

test("cancellation first closes the request and rejects a later response", async t => {
	const f = await fixture(t);
	const requestId = directRequest(f);
	await cancelRun(f);
	assert.throws(() => respond(f, requestId, { kind: "choice", choice_id: "proceed" }), /closed because its attempt cancelled/);
	const view = inspect(f).requests![0];
	assert.equal(view.state, "cancelled");
	assert.equal(view.response_recorded, false);
	assert.equal(view.consumption, "not_applicable");
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	assert.throws(() => directRequest(f), /cancelled or failed/, "a cancelled attempt cannot ask again");
});

test("a response recorded first is kept, yet a later cancellation stops it from ever being consumed or reviving the attempt", async t => {
	const f = await fixture(t);
	const requestId = directRequest(f);
	respond(f, requestId, { kind: "choice", choice_id: "proceed" });
	assert.equal(inspect(f).requests![0].consumption, "awaiting_consumption");
	await cancelRun(f);
	const view = inspect(f).requests![0];
	assert.equal(view.state, "responded", "the accepted response is kept");
	assert.equal(view.response?.kind, "choice");
	assert.equal(view.consumption, "never_consumed");
	assert.equal(view.terminated?.reason, "cancelled");
	assert.equal(claim(f, requestId), "terminated");
	assert.equal(respond(f, requestId, { kind: "choice", choice_id: "proceed" }).replayed, true, "an identical retry still returns the saved outcome");
});

test("the consumption claim is recorded once, so duplicate wake-ups cannot start another turn", async t => {
	const f = await fixture(t);
	const requestId = directRequest(f);
	assert.equal(claim(f, requestId), "not_responded");
	respond(f, requestId, { kind: "decline" });
	assert.equal(claim(f, requestId), "claimed");
	assert.equal(claim(f, requestId), "already_consumed");
	assert.equal(claim(f, requestId), "already_consumed");
	assert.equal(inspect(f).requests![0].consumption, "consumed");
});

test("a failed run that settles terminates its still-pending request", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const requestId = directRequest(f);
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.equal(settled.settled, true, settled.reason);
	const view = inspect(f).requests![0];
	assert.equal(view.state, "failed");
	assert.equal(view.terminated?.reason, "failed");
	assert.throws(() => respond(f, requestId, { kind: "decline" }), /closed because its attempt failed/);
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

async function commandSession(t: test.TestContext, f: Fixture) {
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

test("a response recorded while the wait was aborted still blocks work until it is consumed", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const abort = new AbortController();
	const aborted = worker.requestDirection(ASK, abort.signal);
	const request = await pendingRequest(f);
	abort.abort(new Error("interrupt"));
	await assert.rejects(() => aborted);
	respond(f, request.request_id, { kind: "decline" });
	assert.match((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.reason ?? "", /human direction/i);
	assert.match((await worker.requestDirection(ASK)).content[0].text, /declined/);
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
	assert.equal(inspect(f).attention.some(item => item.kind === "intervention"), false);
	await waiting.catch(() => {});
});

test("Esc at the guidance prompt records nothing, and alerts stop once another session manages the factory", async t => {
	const f = await fixture(t, [agents()[0]]);
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const requestId = directRequest(f);
	pi.prompts.picks.push("proceed: Proceed as planned");
	pi.prompts.input = undefined as any;
	assert.match(await pi.run(`respond ${f.factory.factory_id} ${requestId}`), /left unanswered/);
	assert.equal(inspect(f).requests![0].response_recorded, false);
	for (let i = 0; i < 40 && !pi.notes.some(note => note.level === "warning"); i++) await sleep(100);
	assert.ok(pi.notes.some(note => note.level === "warning"));
});
