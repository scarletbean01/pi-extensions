import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations } from "../factory/operations.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const CHOICES = [{ choice_id: "proceed", label: "Proceed as planned" }, { choice_id: "narrow", label: "Narrow the scope" }, { choice_id: "stop", label: "Stop here" }];
const model = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

function agents(intervention: unknown = { choices: CHOICES, required: ["stop"] }) {
	return [
		{ node_id: "build", persona: "builder", sub_task: "Fixture only", ...(intervention === undefined ? {} : { intervention }) },
		{ node_id: "docs", persona: "builder", sub_task: "Independent", depends_on: [] },
	];
}

async function fixture(t: test.TestContext, nodes: unknown[] = agents(), launch = true) {
	const f = serviceFixture(t, ["builder"]);
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite") });
	const factory = open()({ action: "publish", name: "direction", draft: { topology: "graph", task: "Direction fixture", project_cwd: f.cwd, agents: nodes as any }, sessionModel: model });
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
