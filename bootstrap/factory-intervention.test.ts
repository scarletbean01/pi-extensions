import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claimConsumption, createRequest, inTransaction, openRequestDatabase } from "./factory-requests.ts";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

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
	assert.ok(view.attention.some(item => item.kind === "intervention" && item.request_id === request.request_id), "a missed alert never hides the request");
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
	const f = await fixture(t, [agents()[0]], true, { task_timeout_ms: 100 });
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	await sleep(1300);
	assert.equal(inspect(f).requests!.find(item => item.request_id === request.request_id)?.state, "pending");
	assert.equal(inspect(f).capacity.factory_slot, "held");
	respond(f, request.request_id, { kind: "choice", choice_id: "proceed" });
	assert.match((await waiting).content[0].text, /chose "proceed"/);
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
