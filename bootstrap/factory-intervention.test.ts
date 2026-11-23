import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSupervised } from "./test-harness.ts";
import { BootstrapService } from "./lifecycle.ts";
import { awaitDirection, claimConsumption, createRequest, directionProcess, fenceAttempt, inTransaction, openRequestDatabase, recordDirectionDelivery, terminateNodeRequests, type DirectionReceiver, type DirectionRequestView } from "./factory-requests.ts";
import { atomicJson, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, type WorkerReady } from "./session-store.ts";
import { sha256Hex } from "./factory-records.ts";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { formatAgentStates } from "./reporting.ts";
import { outcomeClaimPath, writeRunCancelRecord } from "./cancellation.ts";
import { handoffClaimPath, handoffOfferPath } from "./handoff.ts";

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
	const file = readdirSync(dir).find(name => name.endsWith(`-${node}.config.json`))!;
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
const APPROVAL = { choice_id: "ship", label: "Ship it", route: "approve" };
const APPROVAL_ASK = { question: "Ship this?", reason: "Review complete", choices: ["ship"] };
const SUCCESS = { status: "success", summary: "Done", detail: "Reviewed the work" };
function reviewNodes(options: { sink?: boolean; requireRoute?: boolean; extraReview?: Record<string, unknown> } = {}) {
	return [
		{ node_id: "build", persona: "builder", sub_task: "Build" },
		{ node_id: "review", persona: "builder", sub_task: "Review", depends_on: ["build"],
			decision: { field: "decision", approve: "ship_it", reject: "make_changes", on_reject: "build" },
			output_contract: { required_fields: ["decision"], properties: { decision: { type: "string", enum: ["ship_it", "make_changes"] } } },
			intervention: { choices: [APPROVAL, { ...APPROVAL, choice_id: "confirm", label: "Confirm approval" }, CHOICES[0]], ...(options.requireRoute ? { require_route: true } : {}) },
			...options.extraReview },
		...(options.sink ? [] : [{ node_id: "publish", persona: "builder", sub_task: "Publish", depends_on: ["review"] }]),
		{ node_id: "docs", persona: "builder", sub_task: "Independent" },
	];
}
async function admittedReviewer(t: test.TestContext, f: Fixture) {
	const build = await admittedWorker(t, f);
	const review = await admittedWorker(t, f, "review");
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	return review;
}
async function answerApproval(f: Fixture, review: Awaited<ReturnType<typeof admittedReviewer>>, guidance?: string) {
	const waiting = review.requestDirection(APPROVAL_ASK);
	const request = await pendingRequest(f);
	const answer = respond(f, request.request_id, { kind: "choice", choice_id: "ship", ...(guidance ? { guidance } : {}) });
	return { waiting, request, answer };
}

test("a plan-defined approval supplies the verdict but only the agent routes the valid result", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const successor = await admittedWorker(t, f, "publish");
	const { waiting, answer } = await answerApproval(f, review);
	const revised = reviewNodes({ extraReview: { decision: { field: "decision", approve: "make_changes", reject: "ship_it", on_reject: "build" } } });
	f.open()({ action: "update", factory_id: f.factory.factory_id, draft: { topology: "graph", task: "New publication only", project_cwd: f.cwd, agents: revised as any }, sessionModel: model, authority: f.authority });
	assert.equal(answer.request.response_recorded, true);
	assert.equal(answer.request.consumption, "awaiting_consumption");
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "not_recorded" });
	assert.equal(review.sent.length, 0);
	assert.ok(!(await waiting).isError);
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "not_recorded" });
	assert.ok(!(await review.complete(SUCCESS)).isError);
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "recorded", value: "ship_it" });
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "publish", kind: "successor", state: "not_admitted" }]);
	const status = f.service.status(f.run.task_id, f.cwd);
	assert.equal(status.agents.find(node => node.node_id === "review")?.last_verdict, "ship_it");
	assert.equal(status.agents.find(node => node.node_id === "publish")?.execution, "waiting");
	await successor.beforeStart(notification(review, successor));
	await successor.deliverFollowUps();
	assert.equal(f.service.status(f.run.task_id, f.cwd).agents.find(node => node.node_id === "publish")?.execution, "running");
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "publish", kind: "successor", state: "admitted" }]);
});

test("an agent verdict can precede a fresh human approval on the same review agent's next attempt", async t => {
	const f = await fixture(t, reviewNodes());
	const build = await admittedWorker(t, f);
	const review = await admittedWorker(t, f, "review");
	const admit = async (sender: typeof build, receiver: typeof build) => {
		await receiver.beforeStart(notification(sender, receiver));
		await receiver.deliverFollowUps();
	};
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await admit(build, review);
	const waiting = review.requestDirection(APPROVAL_ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	assert.ok(!(await review.complete({ ...SUCCESS, outputs: { decision: "make_changes" } })).isError);
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "build", kind: "revision", state: "not_admitted" }]);
	await admit(review, build);
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "build", kind: "revision", state: "admitted" }]);
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await admit(build, review);
	const second = await answerApproval(f, review);
	await second.waiting;
	assert.notEqual(second.request.node_attempt_id, original.node_attempt_id);
	assert.ok(!(await review.complete(SUCCESS)).isError);
	const history = savedRequests(f);
	assert.deepEqual(history.find(item => item.request_id === original.request_id)?.verdict, { state: "recorded", value: "make_changes" });
	assert.equal(history.find(item => item.request_id === original.request_id)?.approval, undefined);
	assert.deepEqual(history.find(item => item.request_id === second.request.request_id)?.verdict, { state: "recorded", value: "ship_it" });
});

const REVISION = { choice_id: "revise", label: "Request revision", route: "reject" };
const REVISION_ASK = { question: "Revise or ship?", reason: "Review findings", choices: ["revise", "ship"] };
function revisionNodes(max_revisions = 1, on_exhausted = "needs_attention") {
	return reviewNodes({ extraReview: {
		decision: { field: "decision", approve: "ship_it", reject: "make_changes", on_reject: "build", max_revisions, on_exhausted },
		intervention: { choices: [REVISION, APPROVAL], require_route: true },
	} });
}

test("a human revision binds only this attempt and hands findings and guidance to the same builder before fresh approval", async t => {
	const nodes = revisionNodes().map(node => node.node_id === "review" ? { ...node, depends_on: ["check"] } : node);
	const f = await fixture(t, [...nodes, { node_id: "check", persona: "builder", sub_task: "Check", depends_on: ["build"] }]);
	const build = await admittedWorker(t, f);
	const check = await admittedWorker(t, f, "check");
	const review = await admittedWorker(t, f, "review");
	const docs = await admittedWorker(t, f, "docs");
	const publish = await admittedWorker(t, f, "publish");
	await docs.complete(SUCCESS);
	const admit = async (sender: typeof build, receiver: typeof build) => {
		await receiver.beforeStart(notification(sender, receiver));
		await receiver.deliverFollowUps();
	};
	await build.complete(SUCCESS);
	await admit(build, check);
	await check.complete(SUCCESS);
	await admit(check, review);
	const waiting = review.requestDirection(REVISION_ASK);
	const request = await pendingRequest(f);
	const answer = respond(f, request.request_id, { kind: "choice", choice_id: "revise", guidance: "Keep the public API" });
	assert.equal(answer.request.consumption, "awaiting_consumption");
	assert.equal(answer.request.route_binding?.verdict, "make_changes");
	assert.equal(answer.request.approval, undefined, "the legacy projection is approval-only");
	assert.deepEqual(answer.request.verdict, { state: "not_recorded" });
	assert.match((await waiting).content[0].text, /make_changes/);
	assert.match((await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } })).content[0].text, /Verdict conflicts/);
	assert.ok(!(await review.complete({ ...SUCCESS, detail: "Provide a more precise example" })).isError);
	const original = () => savedRequests(f).find(item => item.request_id === request.request_id)!;
	assert.deepEqual(original().verdict, { state: "recorded", value: "make_changes" });
	assert.deepEqual(original().admissions, [{ node_id: "build", kind: "revision", state: "not_admitted" }]);
	await admit(review, build);
	assert.deepEqual(original().admissions, [{ node_id: "build", kind: "revision", state: "admitted" }]);
	const findings = await build.readInput({ kind: "result", node_id: "review", attempt_id: request.node_attempt_id });
	assert.match(findings.content[0].text, /Provide a more precise example/);
	assert.match(findings.content[0].text, /Keep the public API/);
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await admit(build, check);
	assert.ok(!(await check.complete(SUCCESS)).isError);
	await admit(check, review);
	const status = f.service.status(f.run.task_id, f.cwd);
	assert.match(status.agents.find(node => node.node_id === "docs")?.attempt_id ?? "", /\.1$/);
	assert.equal(status.agents.find(node => node.node_id === "publish")?.execution, "waiting");
	const second = await answerApproval(f, review);
	assert.notEqual(second.request.node_attempt_id, request.node_attempt_id);
	await second.waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	assert.deepEqual(savedRequests(f).find(item => item.request_id === second.request.request_id)?.verdict, { state: "recorded", value: "ship_it" });
	await admit(review, publish);
	assert.ok(!(await publish.complete(SUCCESS)).isError);
	assert.equal(f.service.status(f.run.task_id, f.cwd).outcome.state, "succeeded");
	assert.ok(!savedRequests(f).some(item => item.exhaustion), "approval at the last allowed attempt is not exhaustion");
});

for (const [limit, disposition] of [["loop_limit", "needs_attention"], ["run_budget", "failed"]] as const) {
	test(`a selected rejection at the ${limit} stays selectable and escalates without admitting any revision`, async t => {
		const f = await fixture(t, revisionNodes(limit === "loop_limit" ? 1 : 3, disposition), true, { max_total_attempts: limit === "loop_limit" ? 20 : 4 });
		const build = await admittedWorker(t, f);
		const review = await admittedWorker(t, f, "review");
		const admit = async (sender: typeof build, receiver: typeof build) => {
			await receiver.beforeStart(notification(sender, receiver));
			await receiver.deliverFollowUps();
		};
		await build.complete(SUCCESS);
		await admit(build, review);
		const chooseRevision = async () => {
			const waiting = review.requestDirection(REVISION_ASK);
			const request = await pendingRequest(f);
			assert.ok(request.can_respond);
			respond(f, request.request_id, { kind: "choice", choice_id: "revise" });
			assert.ok(!(await waiting).isError);
			assert.ok(!(await review.complete(SUCCESS)).isError);
			return request;
		};
		if (limit === "loop_limit") {
			await chooseRevision();
			await admit(review, build);
			await build.complete(SUCCESS);
			await admit(build, review);
		}
		const sent = review.sent.length;
		const request = await chooseRevision();
		assert.equal(request.revision?.blocked_by, limit);
		assert.equal(request.revision?.on_exhausted, disposition);
		assert.equal(request.revision?.remaining_iterations, 0);
		assert.equal(review.sent.length, sent);
		const history = savedRequests(f);
		assert.deepEqual(history.find(item => item.request_id === request.request_id)?.verdict, { state: "recorded", value: "make_changes" });
		const escalation = history.find(item => item.exhaustion);
		assert.ok(escalation?.can_respond);
		assert.deepEqual(escalation.choices.map(choice => choice.choice_id), ["retry", "takeover", "discard"]);
		assert.deepEqual(escalation.exhaustion, { blocked_by: limit, on_exhausted: disposition });
		assert.equal(f.service.status(f.run.task_id, f.cwd).agents.find(node => node.node_id === "review")?.execution, disposition);
		const queuedBefore = inspect(f).queue.length;
		assert.throws(() => respond(f, escalation.request_id, { kind: "choice", choice_id: "discard" }), /confirmation/);
		assert.throws(() => respond(f, escalation.request_id, { kind: "choice", choice_id: "retry" }), /brief/i);
		const retry = { action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: escalation.request_id, response: { kind: "choice", choice_id: "retry" }, newBrief: "New constraints\nStay within the public API" } as const;
		const recorded = f.open()(retry);
		assert.equal(recorded.request.response_recorded, true);
		assert.equal(recorded.request.consumption, "not_applicable");
		assert.equal(recorded.retry_receipt?.brief, retry.newBrief);
		assert.ok(f.open()(retry).replayed);
		assert.throws(() => f.open()({ ...retry, newBrief: "Different" }), /different/);
		assert.equal(inspect(f).queue.length, queuedBefore + 1);
		assert.equal(inspect(f).attempts.length, 1);
	});
}

test("two loops can select revision with apparent headroom, but only one can reserve a whole iteration", async t => {
	const nodes = revisionNodes(3).slice(0, 2);
	const renamed = nodes.map(node => ({ ...node, node_id: `${node.node_id}-other`, ...(node.depends_on ? { depends_on: ["build-other"] } : {}),
		...(node.decision ? { decision: { ...node.decision, on_reject: "build-other" } } : {}) }));
	const f = await fixture(t, [...renamed, ...nodes], true, { max_total_attempts: 6 });
	const workers = ["build-other", "review-other", "build", "review"].map(node => startWorker(t, f, node));
	const [otherBuild, otherReview, build, review] = workers;
	for (const worker of workers) await worker.start();
	for (const worker of workers) await worker.beforeStart();
	for (const [builder, reviewer] of [[build, review], [otherBuild, otherReview]]) {
		await builder.complete(SUCCESS);
		await reviewer.beforeStart(notification(builder, reviewer));
		await reviewer.deliverFollowUps();
	}
	const select = async (reviewer: typeof review) => {
		const wait = reviewer.requestDirection(REVISION_ASK);
		const request = await pendingRequest(f);
		assert.equal(request.revision?.remaining_iterations, 1);
		respond(f, request.request_id, { kind: "choice", choice_id: "revise" });
		assert.ok(!(await wait).isError);
	};
	await select(review);
	await select(otherReview);
	const completions = await Promise.all([review.complete(SUCCESS), otherReview.complete(SUCCESS)]);
	assert.ok(completions.every(result => !result.isError));
	const histories = savedRequests(f);
	const blocked = histories.find(item => item.exhaustion);
	assert.equal(blocked?.exhaustion?.blocked_by, "run_budget");
	assert.equal(histories.filter(item => item.exhaustion).length, 1);
	assert.equal(review.sent.length + otherReview.sent.length, 1);
	const winner = review.sent.length ? review : otherReview;
	const loser = winner === review ? otherReview : review;
	const winnerRequest = histories.find(item => item.node_id === winner.config.node_id)!;
	const reservation = join(winner.config.session_dir, `${winner.config.instance_id}.2.revision.json`);
	const original = readFileSync(reservation);
	const rogue = join(loser.config.session_dir, `${loser.config.instance_id}.2.revision.json`);
	try {
		atomicJson(rogue, { version: 1, run_id: f.run.task_id, reviewer: loser.config.instance_id, attempt: 2 });
		assert.match(savedRequests(f).find(item => item.request_id === winnerRequest.request_id)?.routing_error ?? "", /exceed.*run attempt budget/);
		rmSync(rogue);
		rmSync(reservation);
		assert.match(savedRequests(f).find(item => item.request_id === winnerRequest.request_id)?.routing_error ?? "", /Missing revision reservation/);
	} finally { rmSync(rogue, { force: true }); writeFileSync(reservation, original); }
});

test("a non-successful final review at the run limit escalates without turning into a rejecting verdict", async t => {
	const f = await fixture(t, revisionNodes(), true, { max_total_attempts: 4 });
	const review = await admittedReviewer(t, f);
	const wait = review.requestDirection(REVISION_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "choice", choice_id: "revise" });
	await wait;
	assert.ok(!(await review.complete({ ...SUCCESS, status: "partial" })).isError);
	const history = savedRequests(f);
	assert.deepEqual(history.find(item => item.request_id === request.request_id)?.verdict, { state: "not_applicable" });
	assert.deepEqual(history.find(item => item.exhaustion)?.exhaustion, { blocked_by: "run_budget", on_exhausted: "needs_attention" });
	assert.equal(review.sent.length, 0);
	const file = join(review.config.session_dir, `${review.config.instance_id}.finalize.json`);
	const evidence = readFileSync(file);
	try {
		atomicJson(file, { ...JSON.parse(evidence.toString()), settled_capacity: "loop_limit" });
		assert.ok(savedRequests(f).some(item => !item.can_respond && /Contradictory settled revision capacity/.test(item.reason)));
	} finally { writeFileSync(file, evidence); }
});

test("a revision still requires the decision contract, current checks and matching artifact at builder admission", async t => {
	const nodes = revisionNodes().map(node => node.node_id !== "review" ? node : { ...node, required_checks: ["tests"],
		output_contract: { ...node.output_contract!, required_fields: ["decision", "finding"], properties: { ...node.output_contract!.properties, finding: { type: "string" } } } });
	const f = await fixture(t, nodes);
	const build = await admittedWorker(t, f);
	const review = await admittedWorker(t, f, "review");
	await build.complete(SUCCESS);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	const wait = review.requestDirection(REVISION_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "choice", choice_id: "revise" });
	await wait;
	assert.match((await review.complete(SUCCESS)).content[0].text, /finding/);
	const payload = { ...SUCCESS, outputs: { finding: "Review finding" }, artifacts: [{ type: "file", path: "review.txt" }] };
	writeFileSync(join(f.cwd, "review.txt"), "Original artifact");
	assert.match((await review.complete(payload)).content[0].text, /missing.*check.*tests/i);
	await review.verify({ action: "start", check_id: "tests" });
	await review.verify({ action: "finish", check_id: "tests", result: "pass" });
	assert.ok(!(await review.complete(payload)).isError);
	writeFileSync(join(f.cwd, "review.txt"), "Changed after review");
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	const node = f.service.status(f.run.task_id, f.cwd).agents.find(node => node.node_id === "build")!;
	assert.notEqual(node.execution, "running");
	assert.match(JSON.stringify(node), /stale evidence|changed content hash/i);
	const admissions = savedRequests(f)[0].admissions;
	assert.ok(!Array.isArray(admissions) || admissions[0]?.state !== "admitted");
});

test("damaged or missing revision reservations are reported instead of silently restoring run budget", async t => {
	const f = await fixture(t, revisionNodes(3));
	const build = await admittedWorker(t, f);
	const review = await admittedWorker(t, f, "review");
	const admit = async (sender: typeof build, receiver: typeof build) => {
		await receiver.beforeStart(notification(sender, receiver));
		await receiver.deliverFollowUps();
	};
	await build.complete(SUCCESS);
	await admit(build, review);
	const first = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await first;
	await review.complete(SUCCESS);
	await admit(review, build);
	await build.complete(SUCCESS);
	await admit(build, review);
	const wait = review.requestDirection(REVISION_ASK);
	const pending = await pendingRequest(f);
	const path = join(review.config.session_dir, `${review.config.instance_id}.2.revision.json`);
	const original = readFileSync(path);
	const linked = join(f.root, "linked-reservation.json");
	writeFileSync(linked, original);
	const latest = () => savedRequests(f).find(item => item.request_id === pending.request_id)!;
	try {
		for (const damage of [() => rmSync(path), () => writeFileSync(path, '{"version":99}'), () => { rmSync(path); symlinkSync(linked, path); }]) {
			damage();
			assert.equal(latest().can_respond, false);
			assert.match(latest().routing_error!, /revision reservation/i);
			assert.throws(() => respond(f, pending.request_id, { kind: "choice", choice_id: "revise" }), /revision reservation/i);
			rmSync(path, { force: true });
			writeFileSync(path, original);
		}
	} finally { writeFileSync(path, original); }
	const rogue = (attempt: number) => join(review.config.session_dir, `${review.config.instance_id}.${attempt}.revision.json`);
	for (const [attempt, problem] of [[5, /Out-of-plan revision reservation/], [4, /Noncontiguous revision reservations/]] as const) {
		atomicJson(rogue(attempt), { version: 1, run_id: f.run.task_id, reviewer: review.config.instance_id, attempt });
		try { assert.match(latest().routing_error ?? "", problem); }
		finally { rmSync(rogue(attempt)); }
	}
	respond(f, pending.request_id, { kind: "choice", choice_id: "ship" });
	await wait;
});

test("an exhaustion answer with missing finalization, retry receipt or companion evidence is not replayed", async t => {
	const f = await fixture(t, revisionNodes(), true, { max_total_attempts: 4 });
	const review = await admittedReviewer(t, f);
	const wait = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await wait;
	await review.complete(SUCCESS);
	const request = savedRequests(f).find(item => item.exhaustion)!;
	assert.throws(() => f.open()({ action: "submit", factory_id: f.factory.factory_id, authority: f.authority, reference: request.request_id, brief: "Not an escalation response" }), /reserved/);
	assert.throws(() => wakeSaved(f, request.request_id), /no worker to wake/);
	assert.throws(() => respond(f, request.request_id, { kind: "decline" }), /Choose retry, takeover or discard/);
	assert.throws(() => respond(f, request.request_id, { kind: "choice", choice_id: "takeover", confirmed: true }), /Choose retry, takeover or discard/);
	assert.throws(() => respond(f, request.request_id, { kind: "choice", choice_id: "takeover" }, createManagerAuthority()), /current managing session authority/);
	const retry = { action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: request.request_id, response: { kind: "choice", choice_id: "retry" }, newBrief: "New review scope" } as const;
	f.open()(retry);
	const dbPath = join(f.root, "factories.sqlite");
	const dbBytes = readFileSync(dbPath);
	for (const sql of ["DELETE FROM factory_revision_escalation_answers", "DELETE FROM factory_inputs WHERE reference LIKE 'exhaust_%'", "UPDATE factory_revision_escalation_answers SET answer = 'damaged'", "UPDATE factory_revision_escalation_answers SET record_digest = 'damaged'"]) {
		const db = openRequestDatabase(dbPath);
		try { db.exec(sql); } finally { db.close(); }
		try {
			const bytes = readFileSync(dbPath);
			assert.ok(savedRequests(f).some(item => item.reconciliation === "uncertain" && !item.can_respond && /evidence|receipt/i.test(item.reason)));
			assert.deepEqual(readFileSync(dbPath), bytes);
			assert.throws(() => f.open()(retry), /evidence|receipt/i);
		} finally { writeFileSync(dbPath, dbBytes); }
	}
	const finalized = join(review.config.session_dir, `${review.config.instance_id}.finalize.json`);
	const original = readFileSync(finalized);
	try {
		rmSync(finalized);
		assert.ok(savedRequests(f).some(item => item.reconciliation === "uncertain" && /finalization/.test(item.reason)));
		assert.throws(() => f.open()(retry), /finalization/i);
		for (const [change, error] of [
			[{ exhausted: { state: "needs_attention", reason: "Unknown" } }, /Unknown exhaustion cause/],
			[{ exhausted: { state: "needs_attention", reason: "Review loop exhausted its revision limit (a1-build → a2-review)" } }, /Contradictory exhaustion evidence/],
			[{ exhausted: undefined }, /Missing exhaustion cause/],
		] as const) {
			atomicJson(finalized, { ...JSON.parse(original.toString()), ...change });
			assert.throws(() => f.open()(retry), error);
		}
	} finally { writeFileSync(finalized, original); }
	const forward = handoffOfferPath(review.config.session_dir, `${f.configs.find(config => config.node_id === "publish")!.instance_id}.1`, review.config.instance_id);
	try {
		writeFileSync(forward, "unexpected forward offer");
		assert.throws(() => f.open()(retry), /contradicts a saved handoff/);
	} finally { rmSync(forward); }
});

test("an exhaustion disposition rechecks manager authority after human confirmation", async t => {
	const f = await fixture(t, revisionNodes(), true, { max_total_attempts: 4 });
	const review = await admittedReviewer(t, f);
	const wait = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await wait;
	await review.complete(SUCCESS);
	const request = savedRequests(f).find(item => item.exhaustion)!;
	assert.throws(() => f.open()({ action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority,
		request_id: request.request_id, response: { kind: "choice", choice_id: "discard" }, confirmExhaustion: target => {
			assert.equal(target.request_id, request.request_id);
			assert.equal(target.task_id, f.run.task_id);
			assert.equal(target.choice, "discard");
			revokeManagerAuthority(f.authority);
			return true;
		},
	}), /authority/);
	assert.equal(savedRequests(f).find(item => item.exhaustion)?.response_recorded, false);
});

test("recorded takeover is not replayable as discard and survives settlement unchanged", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const { review, escalation } = await exhaustedReview(t, f);
	const request = { action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: escalation.request_id,
		response: { kind: "choice", choice_id: "takeover" }, confirmExhaustion: () => true } as const;
	const chosen = f.open()(request);
	assert.throws(() => f.open()({ ...request, response: { kind: "choice", choice_id: "discard" } }), /different recorded response/);
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.ok(settled.settled, settled.reason);
	const saved = savedRequests(f).find(item => item.request_id === escalation.request_id)!;
	assert.equal(saved.terminated, undefined);
	assert.deepEqual(saved.response, chosen.request.response);
	assert.equal(saved.reconciliation, "resolved");
	assert.equal(f.open()(request).replayed, true);
	assert.ok(existsSync(resultPath(review.config.session_dir, review.config.attempt_id!)));
});

async function exhaustedReview(t: test.TestContext, f: Fixture, status: "success" | "partial" = "success") {
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	const direction = await pendingRequest(f);
	respond(f, direction.request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	const completion = await review.complete({ ...SUCCESS, status });
	assert.ok(!completion.isError, completion.content[0].text);
	const escalation = savedRequests(f).find(item => item.exhaustion && item.task_id === f.run.task_id)!;
	assert.ok(escalation);
	return { review, escalation, direction };
}

for (const damage of ["wrong run", "wrong reviewer", "wrong review attempt", "no outcome", "no exhaustion marker", "only finalized transition"] as const) {
	test(`unanswered escalation is uncertain with ${damage}`, async t => {
		const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
		const { review, escalation } = await exhaustedReview(t, f);
		assert.equal(escalation.response_recorded, false);
		assert.equal(escalation.can_respond, true);
		const { session_dir: dir, instance_id: reviewer, attempt_id: key } = review.config;
		const path = join(dir, `${reviewer}.finalize.json`);
		const { exhausted, ...header } = readJson<Record<string, unknown>>(path);
		assert.ok(exhausted);
		// Remove the marker so it cannot independently trigger full verification.
		// A dispatcher-authored header also bypasses the reviewer-result shortcut.
		const dispatcherHeader = { ...header, finalized_by: "dispatcher" };
		switch (damage) {
			case "wrong run": atomicJson(path, { ...dispatcherHeader, run_id: "wrong-run" }); break;
			case "wrong reviewer": atomicJson(path, { ...dispatcherHeader, instance_id: f.configs[0].instance_id }); break;
			case "wrong review attempt": atomicJson(path, { ...dispatcherHeader, attempt_id: `${reviewer}.99` }); break;
			case "no outcome":
				atomicJson(path, header);
				rmSync(resultPath(dir, key!));
				assert.equal(existsSync(dispositionPath(dir, key!)), false);
				break;
			case "no exhaustion marker": atomicJson(path, header); break;
			case "only finalized transition":
				assert.equal(readJson<{ winner: string }>(join(dir, `${key}.transition.json`)).winner, "finalized");
				rmSync(path);
				break;
		}
		const requests = savedRequests(f);
		const item = requests.find(view => view.attempt_id === f.run.attempt_id && view.question === "Revision escalation evidence unavailable");
		assert.ok(item, "damage must be visible even without a saved escalation answer");
		assert.equal(item.reconciliation, "uncertain");
		assert.equal(item.request_id, `exhaust_evidence_${f.run.attempt_id}`);
		assert.equal(item.task_id, f.run.task_id);
		assert.equal(item.node_id, "", "an attempt-level diagnostic must not name an unverified node");
		assert.equal(item.node_attempt_id, "");
		assert.equal(item.can_respond, false);
		assert.ok(!requests.some(view => view.request_id === escalation.request_id));
	});
}

test("missing exhaustion evidence in run A is reported without blocking run B or its response", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const exhaust = async (run: Fixture) => {
		const review = await admittedReviewer(t, run);
		const waiting = review.requestDirection(REVISION_ASK);
		respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
		await waiting;
		assert.ok(!(await review.complete(SUCCESS)).isError);
		return savedRequests(f).find(item => item.task_id === run.run.task_id && item.exhaustion)!;
	};
	const a = await exhaust(f);
	const choice = { action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: a.request_id, response: { kind: "choice", choice_id: "retry" }, newBrief: "Second run" } as const;
	f.open()(choice);
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.ok(settled.settled, settled.reason);
	const b = await exhaust({ ...f, run: await f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority }) });
	const dbPath = join(f.root, "factories.sqlite");
	const original = readFileSync(dbPath);
	const db = openRequestDatabase(dbPath);
	try { db.prepare("UPDATE factory_requests SET record_digest = 'damaged' WHERE request_id = ?").run(a.request_id); }
	finally { db.close(); }
	try {
		const requests = savedRequests(f);
		assert.match(requests.find(item => item.request_id === a.request_id && item.state === "unknown")?.reason ?? "", /request evidence mismatch/);
		assert.equal(requests.find(item => item.request_id === b.request_id)?.can_respond, true);
	} finally { writeFileSync(dbPath, original); }
	rmSync(join(f.cwd, ".pi", "agent-sessions", a.task_id), { recursive: true });
	let history!: DirectionRequestView[];
	assert.doesNotThrow(() => { history = savedRequests(f); }, "the missing run must not break factory-wide listing");
	const damaged = history.find(item => item.request_id === a.request_id)!;
	assert.equal(damaged.attempt_id, a.attempt_id);
	assert.equal(damaged.task_id, a.task_id);
	assert.equal(damaged.reconciliation, "uncertain");
	assert.equal(damaged.response_recorded, null);
	assert.equal(damaged.can_respond, false);
	assert.ok(inspect(f).attention.some(item => item.request_id === a.request_id && item.task_id === a.task_id));
	assert.equal(history.find(item => item.request_id === b.request_id)?.can_respond, true);
	assert.throws(() => f.open()(choice), /evidence|ENOENT/i);
	const answer = f.open()({ ...choice, request_id: b.request_id, response: { kind: "choice", choice_id: "takeover" }, newBrief: undefined, confirmExhaustion: target => target.task_id === b.task_id });
	assert.equal(answer.request.response?.kind, "choice");
});

test("escalation polling does not load an unfinished decision with no trigger or a proven successful historical run", async t => {
	const f = await fixture(t, reviewNodes({ sink: true }).slice(0, 2), true, { max_total_attempts: 2 });
	// Use no ordinary direction requests, so any load here would be escalation discovery.
	const store = f.service.store;
	const oldLoad = store.load;
	const assertNoLoad = () => {
		store.load = () => { assert.fail("escalation discovery loaded a run without a trigger"); };
		try { assert.deepEqual(savedRequests(f), []); } finally { store.load = oldLoad; }
	};
	assertNoLoad();
	const review = await admittedReviewer(t, f);
	assert.ok(!(await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } })).isError);
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.ok(settled.settled, settled.reason);
	rmSync(review.config.session_dir, { recursive: true });
	assertNoLoad();
});

test("a pending exhaustion survives proven settlement, and only an explicit retry submits new FIFO work", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	await review.complete(SUCCESS);
	const ask = savedRequests(f).find(item => item.exhaustion)!;
	const settled = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.equal(settled.settled, true, settled.reason);
	assert.equal(savedRequests(f).find(item => item.request_id === ask.request_id)?.can_respond, true);
	assert.deepEqual(inspect(f).queue.map(item => item.reference), ["first"]);
	const answer = f.open()({ action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: ask.request_id, response: { kind: "choice", choice_id: "retry" }, newBrief: "New input after settlement" });
	assert.ok(answer.retry_receipt);
	assert.equal(inspect(f).attempts.length, 1);
	const next = await f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority });
	assert.notEqual(next.task_id, f.run.task_id);
	assert.equal(next.input_id, answer.retry_receipt.input_id);
});

for (const boundary of ["reservation", "feedback admission"] as const) test(`worker checks damaged budget evidence at ${boundary}`, async t => {
	const f = await fixture(t, revisionNodes(3));
	const build = await admittedWorker(t, f);
	const review = await admittedWorker(t, f, "review");
	await build.complete(SUCCESS);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	const waiting = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	const rogue = join(review.config.session_dir, `${review.config.instance_id}.5.revision.json`);
	if (boundary === "feedback admission") assert.ok(!(await review.complete(SUCCESS)).isError);
	atomicJson(rogue, { version: 1, run_id: f.run.task_id, reviewer: review.config.instance_id, attempt: 5 });
	if (boundary === "reservation") {
		const result = await review.complete(SUCCESS);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Out-of-plan revision reservation/);
		assert.equal(review.sent.length, 0);
	} else {
		await build.beforeStart(notification(review, build));
		await build.deliverFollowUps();
		const status = f.service.status(f.run.task_id, f.cwd);
		assert.match(status.worker_errors.join("\n"), /Out-of-plan revision reservation/);
		assert.ok(!existsSync(handoffClaimPath(build.config.session_dir, `${build.config.instance_id}.2`, review.config.instance_id)));
	}
});

test("cancelling a managed review at zero headroom does not mark it as settled at a limit", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const review = await admittedReviewer(t, f);
	await cancelRun(f);
	await review.beforeStart();
	const finalization = readJson<{ settled_capacity?: unknown }>(join(review.config.session_dir, `${review.config.instance_id}.finalize.json`));
	assert.equal(finalization.settled_capacity, undefined);
	assert.ok(!savedRequests(f).some(item => item.exhaustion || item.reconciliation === "uncertain"));
});

test("exhaustion refuses contradictory bindings, plans, outcomes and human route evidence", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const { review, escalation, direction } = await exhaustedReview(t, f);
	const cfg = review.config;
	const dir = cfg.session_dir;
	const key = cfg.attempt_id!;
	const manifest = join(f.service.store.indexRoot, `${cfg.task_id}.json`);
	const finalized = join(dir, `${cfg.instance_id}.finalize.json`);
	const result = resultPath(dir, key);
	const disposition = dispositionPath(dir, key);
	const dbFile = join(f.root, "factories.sqlite");
	const cases: Array<[string, string, () => void, RegExp]> = [
		["binding", manifest, () => atomicJson(manifest, { ...readJson<object>(manifest), session_dir_removed: true }), /Run binding or evidence is missing/],
		["plan", manifest, () => { const data = readJson<any>(manifest); data.review_plan.max_total_attempts++; atomicJson(manifest, data); }, /Run decision does not match the bound definition/],
		["conflicting outcome", disposition, () => atomicJson(disposition, dispositionRecord(cfg, "blocked", "Also blocked", [], new Date().toISOString())), /Missing or contradictory review outcome/],
		["non-rejection", result, () => { const saved = readJson<any>(result); saved.result.status = "partial"; atomicJson(result, saved); }, /Contradictory exhaustion evidence/],
		["wrong disposition", finalized, () => { const saved = readJson<any>(finalized); saved.finalized_by = "dispatcher"; saved.exhausted.state = "needs_attention"; atomicJson(finalized, saved); }, /Contradictory exhaustion evidence/],
		["unproved delivery", dbFile, () => { const db = openRequestDatabase(dbFile); try { db.prepare("DELETE FROM factory_direction_deliveries WHERE request_id = ?").run(direction.request_id); } finally { db.close(); } }, /contradicts the bound human choice or delivery evidence/],
	];
	for (const [label, path, tamper, diagnostic] of cases) await t.test(label, () => {
		const before = existsSync(path) ? readFileSync(path) : undefined;
		try {
			tamper();
			const evidence = savedRequests(f).find(item => item.attempt_id === escalation.attempt_id && item.state === "unknown");
			assert.match(evidence?.reason ?? "", diagnostic);
			assert.equal(evidence?.can_respond, false);
		} finally { if (before) writeFileSync(path, before); else rmSync(path, { force: true }); }
	});
});

test("a recorded next iteration contradicts explicit exhaustion even when it used the last run attempts", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 4 });
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	const cfg = review.config;
	const builder = f.configs[0];
	rmSync(handoffOfferPath(cfg.session_dir, `${builder.instance_id}.2`, cfg.instance_id));
	atomicJson(join(cfg.session_dir, `${cfg.instance_id}.finalize.json`), { version: 1, run_id: cfg.task_id, instance_id: cfg.instance_id,
		attempt_id: cfg.attempt_id, finalized_by: cfg.instance_id, exhausted: { state: "failed", reason: "Run attempt budget exhausted" } });
	assert.ok(savedRequests(f).some(item => item.attempt_id === f.run.attempt_id && item.state === "unknown" && /Contradictory exhaustion evidence/.test(item.reason)));
});

test("settled-capacity evidence is valid only for a non-successful reviewer and a non-cancelled outcome", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const { review } = await exhaustedReview(t, f, "partial");
	const cfg = review.config;
	const dir = cfg.session_dir;
	const key = cfg.attempt_id!;
	const finalized = join(dir, `${cfg.instance_id}.finalize.json`);
	const bytes = readFileSync(finalized);
	const settled = JSON.parse(bytes.toString());
	const unknownReason = () => savedRequests(f).find(item => item.attempt_id === f.run.attempt_id && item.state === "unknown")?.reason ?? "";
	for (const change of [{ settled_capacity: "bad" }, { exhausted: { state: "failed", reason: "Run attempt budget exhausted" } }, { version: 1 }]) {
		try { atomicJson(finalized, { ...settled, ...change }); assert.match(unknownReason(), /Invalid or unsupported finalization record/); }
		finally { writeFileSync(finalized, bytes); }
	}
	const member = f.configs[0];
	const memberPath = join(dir, `${member.instance_id}.finalize.json`);
	const memberBytes = readFileSync(memberPath);
	try {
		atomicJson(memberPath, { ...JSON.parse(memberBytes.toString()), version: 2, settled_capacity: "run_budget" });
		assert.match(f.service.status(f.run.task_id, f.cwd).worker_errors.join("\n"), new RegExp(`${member.instance_id}\\.finalize\\.json`));
	} finally { writeFileSync(memberPath, memberBytes); }
	const result = resultPath(dir, key);
	const resultBytes = readFileSync(result);
	const outcome = outcomeClaimPath(dir, key);
	const outcomeBytes = readFileSync(outcome);
	const disposition = dispositionPath(dir, key);
	try {
		const altered = JSON.parse(resultBytes.toString());
		altered.result.status = "success";
		atomicJson(result, altered);
		assert.match(unknownReason(), /Contradictory settled revision capacity/);
		rmSync(result);
		rmSync(outcome);
		atomicJson(disposition, dispositionRecord(cfg, "cancelled", "Cancelled", [], new Date().toISOString()));
		assert.match(unknownReason(), /Contradictory settled revision capacity/);
		atomicJson(disposition, dispositionRecord(cfg, "blocked", "Blocked", [], new Date().toISOString()));
		writeFileSync(outcome, "bad claim");
		assert.match(unknownReason(), /outcome claim|JSON/i);
	} finally { writeFileSync(result, resultBytes); writeFileSync(outcome, outcomeBytes); rmSync(disposition, { force: true }); }
});

test("a decision requiring human selection cannot show a forged agent verdict after decline", async t => {
	const f = await fixture(t, revisionNodes());
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "decline" });
	await waiting;
	assert.ok(!(await review.complete({ ...SUCCESS, status: "partial", outputs: { decision: "ship_it" } })).isError);
	const file = resultPath(review.config.session_dir, request.node_attempt_id);
	const forged = readJson<any>(file);
	forged.result.status = "success";
	atomicJson(file, forged);
	const view = savedRequests(f).find(item => item.request_id === request.request_id)!;
	assert.deepEqual(view.verdict, { state: "unknown" });
	assert.match(view.routing_error ?? "", /contradicts the approval/);
});

test("an unreadable answer does not hide a second loop's exhaustion in the same attempt", async t => {
	const nodes = revisionNodes(2, "failed").slice(0, 2);
	const other = nodes.map(node => ({ ...node, node_id: `${node.node_id}-other`, ...(node.depends_on ? { depends_on: ["build-other"] } : {}),
		...(node.decision ? { decision: { ...node.decision, on_reject: "build-other" } } : {}) }));
	const f = await fixture(t, [...nodes, ...other], true, { max_total_attempts: 4 });
	const { escalation: first } = await exhaustedReview(t, f);
	const build = await admittedWorker(t, f, "build-other");
	const review = await admittedWorker(t, f, "review-other");
	await build.complete(SUCCESS);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	const waiting = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	const second = savedRequests(f).find(item => item.exhaustion && item.node_id === "review-other")!;
	const request = { action: "respond_request", factory_id: f.factory.factory_id, authority: f.authority, request_id: first.request_id,
		response: { kind: "choice", choice_id: "discard" }, confirmExhaustion: () => true } as const;
	f.open()(request);
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { db.prepare("UPDATE factory_revision_escalation_answers SET record_digest = 'damaged' WHERE request_id = ?").run(first.request_id); }
	finally { db.close(); }
	const requests = savedRequests(f);
	assert.equal(requests.find(item => item.request_id === first.request_id)?.state, "unknown");
	assert.equal(requests.find(item => item.request_id === second.request_id)?.can_respond, true);
	assert.equal(f.open()({ ...request, request_id: second.request_id }).request.state, "responded");
});

test("an orphaned escalation companion is reported without suppressing the genuine request", async t => {
	const f = await fixture(t, revisionNodes(2, "failed").slice(0, 2), true, { max_total_attempts: 2 });
	const { escalation } = await exhaustedReview(t, f);
	const orphan = `exhaust_${"0".repeat(64)}`;
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { db.prepare("INSERT INTO factory_revision_escalation_answers VALUES (?, ?, ?, ?)").run(orphan, f.factory.factory_id, "null", "damaged"); }
	finally { db.close(); }
	const history = savedRequests(f);
	assert.equal(history.find(item => item.request_id === escalation.request_id)?.can_respond, true);
	assert.match(history.find(item => item.request_id === orphan && item.state === "unknown")?.reason ?? "", /missing or contradictory finalization/);
});

test("a v10 database cannot authorize a rejection mapping, and inspection verifies the bound run budget", async t => {
	const f = await fixture(t, revisionNodes());
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	const path = join(f.root, "factories.sqlite");
	const original = readFileSync(path);
	const db = openRequestDatabase(path);
	try { db.exec("DROP TABLE factory_revision_escalation_answers; PRAGMA user_version = 10"); } finally { db.close(); }
	try { assert.match((await review.complete(SUCCESS)).content[0].text, /version 11 revision evidence/); }
	finally { writeFileSync(path, original); }
	const manifestFile = join(f.service.store.indexRoot, `${f.run.task_id}.json`);
	const manifest = readFileSync(manifestFile);
	try {
		const changed = JSON.parse(manifest.toString());
		changed.review_plan.max_total_attempts++;
		atomicJson(manifestFile, changed);
		assert.match(savedRequests(f).find(item => item.request_id === request.request_id)?.routing_error ?? "", /bound definition/);
	} finally { writeFileSync(manifestFile, manifest); }
});

test("a review requiring a selected route cannot route its own verdict after a decline", async t => {
	const f = await fixture(t, reviewNodes({ requireRoute: true }));
	const review = await admittedReviewer(t, f);
	const attempted = { ...SUCCESS, outputs: { decision: "ship_it" } };
	assert.match((await review.complete(attempted)).content[0].text, /requires.*human.*route/i);
	const waiting = review.requestDirection(APPROVAL_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "decline" });
	assert.ok(!(await waiting).isError);
	assert.match((await review.complete(attempted)).content[0].text, /requires.*human.*route/i);
	assert.equal(review.sent.length, 0);
	assert.ok(!(await review.complete({ ...SUCCESS, status: "failure", summary: "No approval selected" })).isError);
});

test("a plan permitting the agent's verdict still routes normally after a human declines", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(APPROVAL_ASK);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "decline" });
	await waiting;
	assert.equal(savedRequests(f)[0].approval, undefined);
	assert.ok(!(await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } })).isError);
	assert.equal(review.sent.length, 1);
});

test("later clarification cannot replace approval; incompatible guidance can be reported without routing", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const first = await answerApproval(f, review);
	await first.waiting;
	await assert.rejects(review.requestDirection({ ...APPROVAL_ASK, choices: ["confirm"] }), /already binds.*clarification/);
	const waiting = review.requestDirection({ ...APPROVAL_ASK, choices: ["proceed"] });
	const clarification = await pendingRequest(f);
	respond(f, clarification.request_id, { kind: "choice", choice_id: "proceed", guidance: "Only proceed by rejecting the work and changing the published plan." });
	const response = await waiting;
	assert.match(response.content[0].text, /rejecting the work/);
	assert.match(response.content[0].text, /guidance.*cannot.*change.*route/i);
	assert.equal(savedRequests(f).find(r => r.request_id === clarification.request_id)?.approval?.request_id, first.request.request_id);
	const conflictingVerdict = { ...SUCCESS, outputs: { decision: "make_changes" } };
	const toolCall = review.hooks.get("tool_call")!;
	assert.equal(await toolCall({ toolName: "bootstrap_complete", input: conflictingVerdict }), undefined);
	const contrary = await review.complete(conflictingVerdict);
	assert.equal(contrary.isError, true);
	assert.match(contrary.content[0].text, /Verdict conflicts.*ship_it/);
	assert.equal(await toolCall({ toolName: "bash", input: {} }), undefined, "a rejected completion leaves the agent able to clarify or fix its result");
	const conflict = { ...SUCCESS, direction_conflict: "Guidance asks for a different route and a plan change" };
	assert.match((await review.complete(conflict)).content[0].text, /cannot complete successfully.*guidance/i);
	assert.equal(review.sent.length, 0);
	assert.ok(!(await review.complete({ ...conflict, status: "failure" })).isError);
	const st = f.service.status(f.run.task_id, f.cwd);
	assert.equal(st.agents.find(node => node.node_id === "review")?.execution, "failed");
	assert.match(st.results.find(item => item.summary === SUCCESS.summary && item.status === "failure")?.detail ?? "", /Guidance asks for a different route/);
	assert.equal(review.sent.length, 0);
	const observation = savedRequests(f).find(r => r.request_id === first.request.request_id)!;
	assert.equal(observation.consumption, "consumed");
	assert.deepEqual(observation.verdict, { state: "not_applicable" });
	assert.equal(observation.admissions, null);
});

test("only published approval mappings on decision nodes are eligible", async t => {
	await assert.rejects(() => fixture(t, agents({ choices: [APPROVAL] }), false), /build.*only.*decision node/);
	for (const [intervention, message] of [
		[{ choices: [{ ...APPROVAL, route: "send_anywhere" }] }, /route must be/],
		[{ choices: [APPROVAL], require_route: "yes" }, /require_route.*boolean/],
		[{ choices: CHOICES, require_route: true }, /require_route.*requires a routing choice/],
	] as const) await assert.rejects(() => fixture(t, reviewNodes({ extraReview: { intervention } }), false), message);
	const f = await fixture(t, reviewNodes({ extraReview: { intervention: undefined } }));
	const review = await admittedReviewer(t, f);
	await assert.rejects(review.requestDirection(APPROVAL_ASK), /not enabled/);
	assert.deepEqual(savedRequests(f), []);
});

test("approval still requires other outputs, a passing check, and intact artifacts at completion and admission", async t => {
	const f = await fixture(t, reviewNodes({ extraReview: {
		required_checks: ["tests"],
		output_contract: { required_fields: ["decision", "finding"], properties: { decision: { type: "string", enum: ["ship_it", "make_changes"] }, finding: { type: "string" } } },
	} }));
	const review = await admittedReviewer(t, f);
	const publish = await admittedWorker(t, f, "publish");
	await (await answerApproval(f, review)).waiting;
	const outcome = { ...SUCCESS, outputs: { finding: "Ready" } };
	assert.match((await review.complete(outcome)).content[0].text, /missing.*check.*tests/i);
	await review.verify({ action: "start", check_id: "tests" });
	await review.verify({ action: "finish", check_id: "tests", result: "fail" });
	assert.match((await review.complete(outcome)).content[0].text, /tests.*fail/i);
	const artifacts = [{ type: "file", path: "evidence.txt" }];
	writeFileSync(join(f.cwd, "evidence.txt"), "Initial evidence");
	await review.verify({ action: "start", check_id: "tests" });
	await review.verify({ action: "finish", check_id: "tests", result: "pass" });
	assert.match((await review.complete(SUCCESS)).content[0].text, /finding/);
	assert.match((await review.complete({ ...outcome, artifacts: [{ ...artifacts[0], path: "missing.txt" }] })).content[0].text, /missing.*artifact/i);
	assert.equal(review.sent.length, 0);
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "not_recorded" });
	assert.ok(!(await review.complete({ ...outcome, artifacts })).isError);
	writeFileSync(join(f.cwd, "evidence.txt"), "Changed after the verdict");
	await publish.beforeStart(notification(review, publish));
	await publish.deliverFollowUps();
	const node = f.service.status(f.run.task_id, f.cwd).agents.find(node => node.node_id === "publish")!;
	assert.notEqual(node.execution, "running");
	assert.match(JSON.stringify(node), /stale evidence|changed content hash/i);
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "publish", kind: "successor", state: "not_admitted" }]);
});

test("a partial result cannot use a selected approval even on an allow-partial edge", async t => {
	const nodes = reviewNodes();
	const f = await fixture(t, nodes.map(node => node.node_id === "publish" ? { ...node, dependency_policy: "allow_partial" } : node));
	const review = await admittedReviewer(t, f);
	await (await answerApproval(f, review)).waiting;
	assert.ok(!(await review.complete({ ...SUCCESS, status: "partial" })).isError);
	assert.equal(review.sent.length, 0);
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "not_applicable" });
	assert.equal(savedRequests(f)[0].admissions, null);
});

test("a terminal approval finalizes only its branch while independent work stays active", async t => {
	const f = await fixture(t, reviewNodes({ sink: true }));
	const review = await admittedReviewer(t, f);
	const docs = await admittedWorker(t, f, "docs");
	await (await answerApproval(f, review)).waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	const status = f.service.status(f.run.task_id, f.cwd);
	assert.equal(status.agents.find(node => node.node_id === "build")?.finalized, true);
	assert.equal(status.agents.find(node => node.node_id === "review")?.finalized, true);
	assert.equal(status.agents.find(node => node.node_id === "docs")?.execution, "running");
	assert.equal(status.outcome.terminal, false);
	assert.equal(inspect(f).capacity.factory_slot, "held");
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "recorded", value: "ship_it" });
	assert.equal(savedRequests(f)[0].admissions, null);
	assert.equal(review.sent.length, 0);
	assert.ok(!(await docs.complete(SUCCESS)).isError);
	assert.equal(f.service.status(f.run.task_id, f.cwd).outcome.state, "succeeded");
});

for (const damage of ["missing binding", "corrupt binding", "missing delivery"] as const) test(`approval fails closed on ${damage}`, async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	await (await answerApproval(f, review)).waiting;
	const path = join(f.root, "factories.sqlite");
	const db = openRequestDatabase(path);
	try {
		db.exec(damage === "missing binding" ? "DELETE FROM factory_direction_approvals" : damage === "corrupt binding" ? "UPDATE factory_direction_approvals SET record_digest = 'bad'" : "DELETE FROM factory_direction_deliveries");
	} finally { db.close(); }
	const before = readFileSync(path);
	const found = savedRequests(f)[0];
	assert.equal(found.response_recorded, true);
	assert.equal(found.consumption, "consumed");
	assert.equal(found.reconciliation, "uncertain");
	assert.match(found.recovery_reason!, /approval binding|delivery was not recorded/);
	assert.deepEqual(readFileSync(path), before);
	const completion = await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } });
	assert.equal(completion.isError, true);
	assert.match(completion.content[0].text, /approval binding|approval was not received/);
	assert.equal(review.sent.length, 0);
});

test("a decision cannot commit while its original request is open, even with a valid agent verdict", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection({ ...APPROVAL_ASK, choices: ["proceed"] });
	const pending = await pendingRequest(f);
	try {
		const result = await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } });
		assert.match(result.content[0].text, /still open/);
		assert.equal(review.sent.length, 0);
	} finally {
		respond(f, pending.request_id, { kind: "decline" });
		await waiting;
	}
});

test("a factory fence prevents routing a previously consumed approval", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	await (await answerApproval(f, review)).waiting;
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { inTransaction(db, () => fenceAttempt(db, f.run.attempt_id, "cancelled")); } finally { db.close(); }
	const result = await review.complete(SUCCESS);
	assert.match(result.content[0].text, /attempt is fenced/);
	assert.equal(review.sent.length, 0);
});

test("a decision worker cannot change the bound verdict mapping or replace the decision owner", async t => {
	for (const change of ["field", "approve", "reject", "reviewer", "loop_limit", "disposition", "target", "body", "node_count"] as const) {
		await t.test(change, async t => {
			const f = await fixture(t, reviewNodes());
			const cfg = f.configs.find(item => item.node_id === "review")!;
			const path = join(cfg.session_dir, `${cfg.instance_id}.config.json`);
			const plan = structuredClone(cfg.review_plan!);
			const loop = plan.loops[0];
			if (change === "field") loop.field = "other";
			else if (change === "approve") loop.approve = "other";
			else if (change === "reject") loop.reject = "other";
			else if (change === "node_count") plan.node_count++;
			else if (change === "reviewer") loop.reviewer = loop.target;
			else if (change === "loop_limit") loop.max_revisions++;
			else if (change === "disposition") loop.on_exhausted = "failed";
			else if (change === "target") loop.target = loop.reviewer;
			else loop.members.reverse();
			atomicJson(path, { ...cfg, review_plan: plan });
			const review = await admittedReviewer(t, f);
			const result = await review.complete({ ...SUCCESS, outputs: { decision: "make_changes" } });
			assert.match(result.content[0].text, /does not match the bound definition/);
			assert.equal(review.sent.length, 0);
		});
	}
});

test("a routed definition cannot assume there is no approval on old storage", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const path = join(f.root, "factories.sqlite");
	const db = openRequestDatabase(path);
	try { db.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; PRAGMA user_version = 9"); } finally { db.close(); }
	const result = await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } });
	assert.match(result.content[0].text, /requires version 10 approval evidence/);
	assert.equal(review.sent.length, 0);
});

test("a consumed approval with damaged evidence cannot be attested at Pi's tool-result boundary", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const answer = review.tools.get("bootstrap_request_direction").execute("ask", APPROVAL_ASK, undefined, undefined, review.context);
	const pending = await pendingRequest(f);
	respond(f, pending.request_id, { kind: "choice", choice_id: "ship" });
	const result = await answer;
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { db.exec("DELETE FROM factory_direction_approvals"); } finally { db.close(); }
	const receipt = await review.hooks.get("tool_result")!({ toolName: "bootstrap_request_direction", toolCallId: "ask", input: APPROVAL_ASK, ...result });
	assert.equal(receipt.isError, true);
	assert.match(receipt.content[0].text, /approval binding/);
	assert.equal(savedRequests(f)[0].consumption, "consumed");
	assert.equal((await review.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.block, true);
});

test("approval storage is checked again in the worker's claim transaction", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const { waiting } = await answerApproval(f, review);
	atClaimBoundary(t, () => {
		const db = openRequestDatabase(join(f.root, "factories.sqlite"));
		try { db.exec("DELETE FROM factory_direction_approvals"); } finally { db.close(); }
	});
	await assert.rejects(waiting, /approval binding/);
	assert.equal(savedRequests(f)[0].consumption, "awaiting_consumption");
	const blocked = await review.hooks.get("tool_call")!({ toolName: "bash", input: {} });
	assert.match(blocked.reason, /waiting for human direction/i);
});

test("a pending decision request cannot be answered when the run manifest contradicts its bound definition", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(APPROVAL_ASK);
	const pending = await pendingRequest(f);
	const manifestFile = join(f.service.store.indexRoot, `${f.run.task_id}.json`);
	const original = readFileSync(manifestFile);
	try {
		const manifest = readJson<any>(manifestFile);
		manifest.review_plan.loops[0].approve = "other_approve";
		atomicJson(manifestFile, manifest);
		const [view] = savedRequests(f);
		assert.equal(view.can_respond, false);
		assert.equal(view.recovery_reason, "Run decision does not match the bound definition");
	} finally {
		writeFileSync(manifestFile, original);
	}
	respond(f, pending.request_id, { kind: "decline" });
	await waiting;
});

test("missing or contradictory routing evidence is unknown, not a denial or an admission", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const publish = await admittedWorker(t, f, "publish");
	await (await answerApproval(f, review)).waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	await publish.beforeStart(notification(review, publish));
	await publish.deliverFollowUps();
	const dir = review.config.session_dir;
	const decisionFile = resultPath(dir, review.config.attempt_id!);
	const destKey = publish.config.attempt_id!;
	const offer = handoffOfferPath(dir, destKey, review.config.instance_id);
	const claim = handoffClaimPath(dir, destKey, review.config.instance_id);
	const damaged = (path: string, replace: () => void, assertion: () => void) => {
		const original = readFileSync(path);
		replace();
		try { assertion(); } finally { writeFileSync(path, original); }
	};
	const admissionUnknown = (pattern: RegExp) => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "recorded", value: "ship_it" });
		assert.ok(Array.isArray(request.admissions));
		assert.equal(request.admissions[0].state, "unknown");
		assert.match(request.admissions[0].reason!, pattern);
	};
	damaged(offer, () => rmSync(offer), () => admissionUnknown(/no matching offer/));
	damaged(offer, () => atomicJson(offer, { ...readJson<object>(offer), handoff_id: "changed" }), () => admissionUnknown(/recorded acceptance.*offer/));
	damaged(offer, () => atomicJson(offer, { ...readJson<object>(offer), handoff_id: "foreign-attempt" }), () => {
		damaged(claim, () => atomicJson(claim, { ...readJson<object>(claim), handoff_id: "foreign-attempt" }), () => admissionUnknown(/does not match the recorded verdict/));
	});
	const outcome = outcomeClaimPath(dir, review.config.attempt_id!);
	damaged(outcome, () => rmSync(outcome), () => {
		assert.deepEqual(savedRequests(f)[0].verdict, { state: "unknown" });
		assert.match(savedRequests(f)[0].routing_error!, /matching completion claim/);
	});
	damaged(outcome, () => writeFileSync(outcome, "broken json"), () => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
	});
	damaged(outcome, () => writeFileSync(outcome, "broken json"), () => damaged(decisionFile, () => rmSync(decisionFile), () => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.reconciliation, "uncertain");
	}));
	damaged(claim, () => writeFileSync(claim, "broken json"), () => admissionUnknown(/JSON|unexpected token/i));
	damaged(claim, () => rmSync(claim), () => admissionUnknown(/no matching admission claim/));
	damaged(decisionFile, () => rmSync(decisionFile), () => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.admissions, "unknown");
		assert.match(request.routing_error!, /completion claim without its result/);
		assert.equal(request.reconciliation, "uncertain");
	});
	damaged(decisionFile, () => {
		const record = readJson<any>(decisionFile);
		record.result.outputs.decision = "make_changes";
		atomicJson(decisionFile, record);
	}, () => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.reconciliation, "uncertain");
		assert.match(request.routing_error!, /contradicts the approval/);
	});
	const progressFile = join(dir, `${publish.config.instance_id}.progress.json`);
	damaged(claim, () => rmSync(claim), () => {
		admissionUnknown(/no matching admission claim/);
		damaged(progressFile, () => {
			atomicJson(progressFile, { ...readJson<object>(progressFile), token: "foreign-token" });
		}, () => admissionUnknown(/another run/));
		// Removing progress too while destination result exists leaves result without claim -> still unknown.
		const destResult = resultPath(dir, destKey);
		writeFileSync(destResult, JSON.stringify({ version: 2, result: SUCCESS }));
		try {
			admissionUnknown(/no matching admission claim/);
		} finally { rmSync(destResult); }
	});
	const dispFile = dispositionPath(dir, review.config.attempt_id!);
	writeFileSync(dispFile, JSON.stringify({ state: "cancelled" }));
	try {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.reconciliation, "uncertain");
		assert.match(request.routing_error!, /conflicts with termination evidence/);
	} finally { rmSync(dispFile); }
	const dbPath = join(f.root, "factories.sqlite");
	const originalDb = readFileSync(dbPath);
	try {
		const db = openRequestDatabase(dbPath);
		try { db.exec("DELETE FROM factory_direction_deliveries"); } finally { db.close(); }
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.reconciliation, "uncertain");
		assert.match(request.routing_error!, /contradicts the approval or its delivery evidence/);
	} finally { writeFileSync(dbPath, originalDb); }
	const manifestFile = join(f.service.store.indexRoot, `${f.run.task_id}.json`);
	damaged(manifestFile, () => {
		const manifest = readJson<any>(manifestFile);
		manifest.review_plan.loops[0].approve = "other_approve";
		atomicJson(manifestFile, manifest);
	}, () => {
		const [request] = savedRequests(f);
		assert.deepEqual(request.verdict, { state: "unknown" });
		assert.equal(request.reconciliation, "uncertain");
		assert.match(request.routing_error!, /does not match the bound definition/);
	});
});

test("join successor admission reports not_admitted until every branch arrives and admitted once the join claims", async t => {
	const nodes = [
		{ node_id: "build", persona: "builder", sub_task: "Build" },
		{ node_id: "review", persona: "builder", sub_task: "Review", depends_on: ["build"],
			decision: { field: "decision", approve: "ship_it", reject: "make_changes", on_reject: "build" },
			output_contract: { required_fields: ["decision"], properties: { decision: { type: "string", enum: ["ship_it", "make_changes"] } } },
			intervention: { choices: [APPROVAL] } },
		{ node_id: "docs", persona: "builder", sub_task: "Docs" },
		{ node_id: "merge", persona: "builder", sub_task: "Merge", depends_on: ["review", "docs"] },
	];
	const f = await fixture(t, nodes);
	const review = await admittedReviewer(t, f);
	const docs = await admittedWorker(t, f, "docs");
	const merge = await admittedWorker(t, f, "merge");
	await (await answerApproval(f, review)).waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	assert.deepEqual(savedRequests(f)[0].verdict, { state: "recorded", value: "ship_it" });
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "merge", kind: "successor", state: "not_admitted" }]);
	await merge.beforeStart(notification(review, merge));
	await merge.deliverFollowUps();
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "merge", kind: "successor", state: "not_admitted" }]);
	assert.ok(!(await docs.complete(SUCCESS)).isError);
	await merge.beforeStart(notification(docs, merge));
	await merge.deliverFollowUps();
	assert.deepEqual(savedRequests(f)[0].admissions, [{ node_id: "merge", kind: "successor", state: "admitted" }]);
});

test("required routing choices apply before binding and clarification is allowed after binding", async t => {
	const f = await fixture(t, reviewNodes({
		requireRoute: true,
		extraReview: { intervention: { choices: [APPROVAL, CHOICES[0]], required: ["ship"], require_route: true } },
	}));
	const review = await admittedReviewer(t, f);
	// Before binding, offering only non-routing choice omits required "ship".
	await assert.rejects(review.requestDirection({ ...APPROVAL_ASK, choices: ["proceed"] }), /requires offering choice "ship"/);
	// A non-routing choice on a require_route node does not permit supplying own verdict.
	const askBoth = review.requestDirection({ ...APPROVAL_ASK, choices: ["ship", "proceed"] });
	const req1 = await pendingRequest(f);
	respond(f, req1.request_id, { kind: "choice", choice_id: "proceed" });
	await askBoth;
	assert.match((await review.complete({ ...SUCCESS, outputs: { decision: "ship_it" } })).content[0].text, /requires.*human.*route/i);

	// Now offer "ship", answer it without waking/consuming yet -> responded-but-unconsumed still blocks completion.
	const askShip = review.requestDirection({ ...APPROVAL_ASK, choices: ["ship", "proceed"] });
	const req2 = await pendingRequest(f);
	const saved = respond(f, req2.request_id, { kind: "choice", choice_id: "ship" });
	assert.equal(saved.request.consumption, "awaiting_consumption");
	await askShip;
	// After binding, required routing choice "ship" is no longer required for clarification, and "ship" cannot be offered again.
	await assert.rejects(review.requestDirection({ ...APPROVAL_ASK, choices: ["ship", "proceed"] }), /already binds/);
	const clarify = review.requestDirection({ ...APPROVAL_ASK, choices: ["proceed"] });
	const req3 = await pendingRequest(f);
	respond(f, req3.request_id, { kind: "choice", choice_id: "proceed" });
	await clarify;
	// direction_conflict cannot use partial or pass a verdict with failure.
	assert.match((await review.complete({ ...SUCCESS, status: "partial", direction_conflict: "Conflict" })).content[0].text, /cannot complete successfully/i);
	assert.match((await review.complete({ ...SUCCESS, status: "failure", outputs: { decision: "ship_it" }, direction_conflict: "Conflict" })).content[0].text, /cannot supply a verdict/i);
});

test("saved choices that contradict the bound definition fail closed", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const { waiting, request } = await answerApproval(f, review);
	await waiting;
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try {
		const row = db.prepare("SELECT * FROM factory_requests WHERE request_id = ?").get(request.request_id) as any;
		const choices = JSON.parse(row.choices);
		choices[0].label = "Tampered label";
		const fields = ["request_id", "factory_id", "input_id", "attempt_id", "task_id", "node_id", "node_attempt_id", "question", "reason", "evidence", "choices", "recommendation", "state", "created_at", "response", "responder", "responded_at", "consumed_at", "terminated_at", "terminated_reason"];
		row.choices = JSON.stringify(choices);
		const digest = sha256Hex(JSON.stringify(fields.map(field => row[field])));
		db.prepare("UPDATE factory_requests SET choices = ?, record_digest = ? WHERE request_id = ?").run(row.choices, digest, request.request_id);
		const approvalDigest = sha256Hex(JSON.stringify(["direction-approval-v1", row.factory_id, row.input_id, row.task_id, row.attempt_id, row.node_id, row.node_attempt_id, row.request_id, row.response, row.responded_at, "decision", "ship_it"]));
		db.prepare("UPDATE factory_direction_approvals SET record_digest = ? WHERE request_id = ?").run(approvalDigest, request.request_id);
		const identity = (db.prepare("SELECT identity FROM factory_direction_mailboxes WHERE request_id = ?").get(request.request_id) as { identity: string }).identity;
		const deliveryDigest = sha256Hex(JSON.stringify(["direction-delivery-v1", request.request_id, digest, identity]));
		db.prepare("UPDATE factory_direction_deliveries SET record_digest = ? WHERE request_id = ?").run(deliveryDigest, request.request_id);
	} finally { db.close(); }
	assert.match((await review.complete(SUCCESS)).content[0].text, /contradict its bound definition/);
});

test("responded-but-unconsumed request and tampered approval/request/retained records fail closed", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	// Abort the wait after response is recorded so it remains responded-but-unconsumed ("open").
	const abort = new AbortController();
	const waiting = review.requestDirection(APPROVAL_ASK, abort.signal);
	const req = await pendingRequest(f);
	respond(f, req.request_id, { kind: "choice", choice_id: "ship" });
	abort.abort(new Error("stop before consuming"));
	await assert.rejects(waiting, /stop before consuming/);
	assert.equal(savedRequests(f)[0].consumption, "awaiting_consumption");
	assert.match((await review.complete(SUCCESS)).content[0].text, /still open/);

	// Orphan approval row when no routing choice was selected fails closed.
	const f2 = await fixture(t, reviewNodes());
	const rev2 = await admittedReviewer(t, f2);
	const w2 = rev2.requestDirection({ ...APPROVAL_ASK, choices: ["proceed"] });
	const r2 = await pendingRequest(f2);
	respond(f2, r2.request_id, { kind: "choice", choice_id: "proceed" });
	await w2;
	const db2 = openRequestDatabase(join(f2.root, "factories.sqlite"));
	try {
		db2.prepare("INSERT INTO factory_direction_approvals VALUES (?, ?, ?, ?, ?)").run(f2.run.attempt_id, "review", rev2.config.attempt_id!, r2.request_id, "orphan-digest");
	} finally { db2.close(); }
	assert.equal(savedRequests(f2)[0].reconciliation, "uncertain");
	assert.match(savedRequests(f2)[0].recovery_reason!, /approval binding/i);
	assert.match((await rev2.complete({ ...SUCCESS, outputs: { decision: "ship_it" } })).content[0].text, /approval binding/i);

	// Tampered retained definition in factory_versions with routing choice on non-decision node fails launch preflight.
	const f3 = await fixture(t, agents({ choices: CHOICES }), false);
	const db3 = openRequestDatabase(join(f3.root, "factories.sqlite"));
	try {
		const row = db3.prepare("SELECT * FROM factory_versions WHERE factory_id = ? AND version = 'v1'").get(f3.factory.factory_id) as any;
		const def = JSON.parse(row.definition);
		def.agents[0].node.intervention.choices[0].route = "approve";
		const newDef = JSON.stringify(def);
		const newDigest = sha256Hex(newDef);
		const recDigest = sha256Hex(JSON.stringify([row.factory_id, row.version, row.version_num, newDef, newDigest, row.restored_from_version, row.created_at]));
		db3.prepare("UPDATE factories SET definition = ?, digest = ? WHERE factory_id = ?").run(newDef, newDigest, f3.factory.factory_id);
		db3.prepare("UPDATE factory_versions SET definition = ?, digest = ?, record_digest = ? WHERE factory_id = ? AND version = 'v1'").run(newDef, newDigest, recDigest, f3.factory.factory_id);
		const ptr = db3.prepare("SELECT * FROM factory_pointers WHERE factory_id = ?").get(f3.factory.factory_id) as any;
		const ptrRec = sha256Hex(JSON.stringify([ptr.factory_id, ptr.current_version, ptr.current_version_num, newDigest, ptr.updated_at]));
		db3.prepare("UPDATE factory_pointers SET definition_digest = ?, record_digest = ? WHERE factory_id = ?").run(newDigest, ptrRec, f3.factory.factory_id);
	} finally { db3.close(); }
	await assert.rejects(() => f3.open()({ action: "launch", factory_id: f3.factory.factory_id, authority: f3.authority }), /only an intervention-enabled decision node may offer routing choices/);

	// A valid decision definition with a tampered invalid route must also fail retained-definition preflight.
	const f4 = await fixture(t, reviewNodes(), false);
	const db4 = openRequestDatabase(join(f4.root, "factories.sqlite"));
	try {
		const row = db4.prepare("SELECT * FROM factory_versions WHERE factory_id = ? AND version = 'v1'").get(f4.factory.factory_id) as any;
		const def = JSON.parse(row.definition);
		def.agents.find((entry: any) => entry.node.node_id === "review").node.intervention.choices[0].route = "send_anywhere";
		const newDef = JSON.stringify(def);
		const newDigest = sha256Hex(newDef);
		const recDigest = sha256Hex(JSON.stringify([row.factory_id, row.version, row.version_num, newDef, newDigest, row.restored_from_version, row.created_at]));
		db4.prepare("UPDATE factories SET definition = ?, digest = ? WHERE factory_id = ?").run(newDef, newDigest, f4.factory.factory_id);
		db4.prepare("UPDATE factory_versions SET definition = ?, digest = ?, record_digest = ? WHERE factory_id = ? AND version = 'v1'").run(newDef, newDigest, recDigest, f4.factory.factory_id);
		const ptr = db4.prepare("SELECT * FROM factory_pointers WHERE factory_id = ?").get(f4.factory.factory_id) as any;
		const ptrRec = sha256Hex(JSON.stringify([ptr.factory_id, ptr.current_version, ptr.current_version_num, newDigest, ptr.updated_at]));
		db4.prepare("UPDATE factory_pointers SET definition_digest = ?, record_digest = ? WHERE factory_id = ?").run(newDigest, ptrRec, f4.factory.factory_id);
	} finally { db4.close(); }
	await assert.rejects(() => f4.open()({ action: "launch", factory_id: f4.factory.factory_id, authority: f4.authority }), /route must be "approve"/);
});

test("Pi warns before selecting an exhausted revision and confirms takeover and discard separately", async t => {
	const f = await fixture(t, revisionNodes(), true, { max_total_attempts: 4 });
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const review = await admittedReviewer(t, f);
	const waiting = review.requestDirection(REVISION_ASK);
	const pending = await pendingRequest(f);
	pi.prompts.picks.push("revise: Request revision (binds this attempt to rejection; requires a valid result)");
	assert.match(await pi.run(`respond ${f.factory.factory_id} ${pending.request_id}`), /Response recorded/);
	assert.match(pi.prompts.title ?? "", /0 whole iteration.*Blocked by the run attempt budget.*on_exhausted: needs_attention/);
	await waiting;
	await review.complete(SUCCESS);
	const escalation = savedRequests(f).find(item => item.exhaustion)!;
	const command = `respond ${f.factory.factory_id} ${escalation.request_id}`;
	pi.prompts.confirm = false;
	for (const [label, title] of [["takeover: Take over the work manually", /Take over/], ["discard: Discard the escalation", /Discard/]] as const) {
		pi.prompts.picks.push(label);
		await pi.run(command);
		assert.match(pi.prompts.confirmTitle ?? "", title);
		assert.equal(savedRequests(f).find(item => item.exhaustion)?.response_recorded, false);
	}
	assert.ok(!pi.prompts.selected?.some(label => label.startsWith("Decline")), "an escalation has no decline choice");
	const originalDiscovery = BootstrapService.prototype.directionExhaustions;
	const originalConfirm = pi.ctx.ui.confirm;
	let changedAfterConfirm = false;
	try {
		// Simulate a different target being returned by the service at commit; the adapter must
		// not turn a human's confirmation of the original target into a general authority flag.
		BootstrapService.prototype.directionExhaustions = function (...args) {
			const views = originalDiscovery.apply(this, args);
			return changedAfterConfirm ? views.map(view => view.request_id === escalation.request_id
				? { ...view, exhaustion: { ...view.exhaustion!, on_exhausted: "failed" } } : view) : views;
		};
		pi.ctx.ui.confirm = async () => { changedAfterConfirm = true; return true; };
		pi.prompts.picks.push("takeover: Take over the work manually");
		assert.match(await pi.run(command), /requires direct human confirmation/);
		assert.equal(savedRequests(f).find(item => item.exhaustion)?.response_recorded, false);
	} finally {
		BootstrapService.prototype.directionExhaustions = originalDiscovery;
		pi.ctx.ui.confirm = originalConfirm;
	}
	pi.prompts.confirm = true;
	pi.prompts.picks.push("takeover: Take over the work manually");
	assert.match(await pi.run(command), /Exhaustion decision recorded/);
	assert.equal(savedRequests(f).find(item => item.exhaustion)?.response?.kind, "choice");
	assert.equal(inspect(f).attempts.length, 1);
});

test("Pi submits an exact multiline escalation brief, but Esc leaves the request pending", async t => {
	const f = await fixture(t, revisionNodes(), true, { max_total_attempts: 4 });
	const review = await admittedReviewer(t, f);
	const wait = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await wait;
	await review.complete(SUCCESS);
	const escalation = savedRequests(f).find(item => item.exhaustion)!;
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const command = `respond ${f.factory.factory_id} ${escalation.request_id}`;
	pi.prompts.picks.push("retry: Retry with a new brief");
	assert.equal(await pi.run(command), "");
	assert.equal(savedRequests(f).find(item => item.exhaustion)?.response_recorded, false);
	const brief = "  leading space\r\nnext line\n  ";
	pi.prompts.editor = brief;
	pi.prompts.picks.push("retry: Retry with a new brief");
	assert.match(await pi.run(command), /Decision recorded.*queued/);
	assert.equal(inspect(f).queue.find(item => item.reference === escalation.request_id)?.brief, brief);
});

test("Pi /factory respond and /factory requests surface routing choice binding and distinct stages without mutating execution", async t => {
	const f = await fixture(t, reviewNodes());
	revokeManagerAuthority(f.authority);
	const pi = await commandSession(t, f);
	await pi.run(`takeover ${f.factory.factory_id}`);
	const review = await admittedReviewer(t, f);
	const publish = await admittedWorker(t, f, "publish");
	const waiting = review.requestDirection({ ...APPROVAL_ASK, choices: ["ship", "proceed"] });
	const req = await pendingRequest(f);
	pi.prompts.picks.push("ship: Ship it (binds this attempt to approval; requires a valid result)");
	pi.prompts.input = "Double-check README wording";
	const out = await pi.run(`respond ${f.factory.factory_id} ${req.request_id}`);
	assert.match(out, /Response recorded/);
	assert.ok(pi.prompts.selected?.some(label => label.includes("binds this attempt to approval; requires a valid result")));
	assert.match((await waiting).content[0].text, /binds this attempt to decision = "ship_it".*Double-check README wording/s);
	const beforeResult = JSON.parse(await pi.run(`requests ${f.factory.factory_id}`))[0];
	assert.equal(beforeResult.response_recorded, true);
	assert.equal(beforeResult.consumption, "consumed");
	assert.deepEqual(beforeResult.verdict, { state: "not_recorded" });
	assert.equal(beforeResult.admissions, null);
	assert.ok(!(await review.complete(SUCCESS)).isError);
	const beforeAdmit = JSON.parse(await pi.run(`requests ${f.factory.factory_id}`))[0];
	assert.deepEqual(beforeAdmit.verdict, { state: "recorded", value: "ship_it" });
	assert.deepEqual(beforeAdmit.admissions, [{ node_id: "publish", kind: "successor", state: "not_admitted" }]);
	await publish.beforeStart(notification(review, publish));
	await publish.deliverFollowUps();
	const afterAdmit = JSON.parse(await pi.run(`requests ${f.factory.factory_id}`))[0];
	assert.deepEqual(afterAdmit.admissions, [{ node_id: "publish", kind: "successor", state: "admitted" }]);
});

test("v10 migration is read-only until resume, preserves old answers, and refuses missing v11 evidence", async t => {
	const f = await fixture(t, reviewNodes());
	const review = await admittedReviewer(t, f);
	const { request, waiting } = await answerApproval(f, review);
	await waiting;
	const path = join(f.root, "factories.sqlite");
	const downgrade = openRequestDatabase(path);
	try { downgrade.exec("DROP TABLE factory_revision_escalation_answers; PRAGMA user_version = 10"); } finally { downgrade.close(); }
	const before = readFileSync(path);
	assert.equal(savedRequests(f)[0].request_id, request.request_id);
	assert.deepEqual(readFileSync(path), before);
	const resume = () => f.open()({ action: "resume", factory_id: f.factory.factory_id, authority: f.authority });
	resume();
	resume();
	assert.equal(savedRequests(f)[0].route_binding?.verdict, "ship_it");
	const db = openRequestDatabase(path);
	try {
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 12);
		assert.equal(db.prepare("SELECT count(*) AS count FROM factory_revision_escalation_answers").get()?.count, 0);
		db.exec("DROP TABLE factory_revision_escalation_answers");
	} finally { db.close(); }
	assert.throws(() => savedRequests(f), /revision escalation table is missing/);
	assert.throws(resume, /revision escalation table is missing/);
	assert.match((await review.complete(SUCCESS)).content[0].text, /revision escalation table is missing/);
});

test("a damaged v10 schema cannot migrate over missing approval evidence", async t => {
	const f = await fixture(t, reviewNodes(), false);
	const path = join(f.root, "factories.sqlite");
	const downgrade = openRequestDatabase(path);
	try { downgrade.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; PRAGMA user_version = 10"); }
	finally { downgrade.close(); }
	const before = readFileSync(path);
	assert.throws(() => f.open()({ action: "resume", factory_id: f.factory.factory_id, authority: f.authority }), /approval table is missing/);
	assert.deepEqual(readFileSync(path), before);
});

test("schema v9 rejects creating, claiming, and recording delivery for worker waits", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const request = await pendingRequest(f);
	const receiver = receiverEvidence(f, request.request_id);
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try {
		db.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; PRAGMA user_version = 9");
		assert.throws(() => inTransaction(db, () => createRequest(db, {
			factory_id: f.factory.factory_id, input_id: request.input_id, attempt_id: request.attempt_id, task_id: request.task_id,
			node_id: request.node_id, node_attempt_id: request.node_attempt_id, question: "Again?", reason: "Test", choices: ["proceed", "narrow", "stop"],
		}, receiver)), /version 9 cannot hold verified direction waits/);
		assert.throws(() => inTransaction(db, () => claimConsumption(db, request.request_id, receiver)), /version 9 cannot hold verified direction waits/);
		assert.throws(() => inTransaction(db, () => recordDirectionDelivery(db, request.request_id, receiver)), /version 9 cannot hold verified direction waits/);
	} finally { db.close(); }
	assert.equal(savedRequests(f)[0].state, "pending");
	assert.equal(savedRequests(f)[0].response_recorded, false);
	await assert.rejects(waiting);
});

test("schema v9 inspection is read-only and explicit migration preserves old responses without inferring approval", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const pending = await pendingRequest(f);
	respond(f, pending.request_id, { kind: "choice", choice_id: "proceed" });
	await waiting;
	const path = join(f.root, "factories.sqlite");
	const db = openRequestDatabase(path);
	try { db.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; PRAGMA user_version = 9"); } finally { db.close(); }
	const before = readFileSync(path);
	const [legacy] = savedRequests(f);
	assert.deepEqual(readFileSync(path), before);
	assert.equal(legacy.consumption, "consumed");
	assert.equal(legacy.approval, undefined);
	assert.deepEqual(legacy.verdict, { state: "not_applicable" });
	f.open()({ action: "resume", factory_id: f.factory.factory_id, authority: f.authority });
	assert.deepEqual(savedRequests(f)[0], legacy);
	const migrated = openRequestDatabase(path);
	try {
		assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 12);
		migrated.exec("DROP TABLE factory_direction_approvals");
	} finally { migrated.close(); }
	const damaged = readFileSync(path);
	assert.throws(() => savedRequests(f), /direction approval table is missing/);
	assert.deepEqual(readFileSync(path), damaged);
});

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

async function claimedAnswer(f: Fixture, worker: Awaited<ReturnType<typeof admittedWorker>>) {
	const answer = worker.tools.get("bootstrap_request_direction").execute("receipt-call", ASK, undefined, undefined, worker.context);
	const request = await pendingRequest(f);
	respond(f, request.request_id, { kind: "decline" });
	const result = await answer;
	assert.equal(result.isError, undefined, result.content[0].text);
	return { request, event: { toolName: "bootstrap_request_direction", toolCallId: "receipt-call", input: ASK, ...result } };
}

for (const fault of ["write failure", "cancellation"] as const) test(`receipt hook rejects a ${fault} after the claim`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const { request, event } = await claimedAnswer(f, worker);
	if (fault === "write failure") {
		const db = openRequestDatabase(join(f.root, "factories.sqlite"));
		try { db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON factory_direction_deliveries BEGIN SELECT RAISE(ABORT, 'receipt storage failure'); END;`); }
		finally { db.close(); }
	} else writeRunCancelRecord(worker.config.session_dir, { run_id: request.task_id, reason: "Cancelled before receipt", requestedAt: new Date().toISOString(), graceMs: 5000 });
	const failure = await worker.hooks.get("tool_result")!(event);
	assert.equal(failure?.isError, true);
	assert.equal(failure.details.status, "delivery_uncertain");
	assert.match(failure.content[0].text, fault === "write failure" ? /receipt storage failure/ : /original attempt was cancelled/);
	assert.equal((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.block, true);
	const [saved] = savedRequests(f);
	assert.equal(saved.consumption, "consumed");
	assert.equal(saved.reconciliation, fault === "write failure" ? "uncertain" : "cancelled");
	assert.equal(saved.can_redeliver, false);
	assert.throws(() => wakeSaved(f, request.request_id), /no wake sent/);
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try { assert.equal(db.prepare("SELECT 1 FROM factory_direction_deliveries WHERE request_id = ?").get(request.request_id), undefined); }
	finally { db.close(); }
});

for (const forgery of ["error", "wrong request ID", "wrong status"] as const) test(`receipt hook ignores an event with ${forgery}`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const { request, event } = await claimedAnswer(f, worker);
	const forged = forgery === "error" ? { ...event, isError: true } : { ...event, details: { ...event.details,
		...(forgery === "wrong request ID" ? { request_id: "dir_other" } : { status: "terminated" }),
	} };
	assert.equal(await worker.hooks.get("tool_result")!(forged), undefined);
	assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	assert.equal((await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} }))?.block, true);
	assert.equal(await worker.hooks.get("tool_result")!(event), undefined, "a genuine result can still be received");
	assert.equal(savedRequests(f)[0].request_id, request.request_id);
	assert.equal(savedRequests(f)[0].reconciliation, "continuing");
});

for (const cause of ["unconsumed", "wrong receiver", "terminated", "fenced"] as const) test(`direct receipt write refuses invalid evidence: ${cause}`, async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.tools.get("bootstrap_request_direction").execute("receipt-call", ASK, AbortSignal.timeout(2500), undefined, worker.context);
	void waiting.catch(() => {});
	const request = await pendingRequest(f);
	let receiver = receiverEvidence(f, request.request_id);
	if (cause !== "unconsumed") {
		respond(f, request.request_id, { kind: "decline" });
		await waiting;
	} else {
		// A saved response and wake still do not authorize a receipt until the worker claims it.
		respond(f, request.request_id, { kind: "decline" });
	}
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	try {
		if (cause === "wrong receiver") receiver = { ...receiver, incarnation: randomUUID() };
		if (cause === "fenced") inTransaction(db, () => fenceAttempt(db, request.attempt_id, "cancelled"));
		if (cause === "terminated") {
			// An intact but contradictory terminal record isolates the termination guard from
			// the unconsumed and attempt-fence guards, which also deny an ordinary termination.
			const { record_digest: _, ...row } = db.prepare("SELECT * FROM factory_requests WHERE request_id = ?").get(request.request_id)!;
			const terminated_at = new Date().toISOString();
			const terminated_reason = "closed";
			const digest = createHash("sha256").update(JSON.stringify(Object.values({ ...row, terminated_at, terminated_reason }))).digest("hex");
			db.prepare("UPDATE factory_requests SET terminated_at = ?, terminated_reason = ?, record_digest = ? WHERE request_id = ?").run(terminated_at, terminated_reason, digest, request.request_id);
		}
		assert.throws(() => inTransaction(db, () => recordDirectionDelivery(db, request.request_id, receiver)), /no delivered claim by the original receiver/);
		assert.equal(db.prepare("SELECT 1 FROM factory_direction_deliveries WHERE request_id = ?").get(request.request_id), undefined);
	} finally { db.close(); }
	if (cause === "unconsumed") await waiting;
});

test("receipt hook refuses a delayed result after the active attempt key changes", async t => {
	const f = await fixture(t);
	const worker = await admittedWorker(t, f);
	const { request, event } = await claimedAnswer(f, worker);
	// Reuse the runtime with another node's config, leaving the first node's queued result intact.
	const path = join(worker.config.session_dir, `${worker.config.instance_id}.config.json`);
	atomicJson(path, f.configs.find(config => config.node_id === "docs"));
	await worker.hooks.get("session_start")!({ reason: "reload" });
	const failure = await worker.hooks.get("tool_result")!(event);
	assert.equal(failure?.isError, true);
	assert.match(failure.content[0].text, /original attempt has changed/i);
	assert.equal(savedRequests(f).find(item => item.request_id === request.request_id)?.reconciliation, "uncertain");
});

test("receipt hook refuses a delayed result when the original request is no longer pending in memory", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const tool = worker.tools.get("bootstrap_request_direction");
	const first = tool.execute("receipt-call", ASK, undefined, undefined, worker.context);
	const request = await pendingRequest(f);
	const db = openRequestDatabase(join(f.root, "factories.sqlite"));
	const tables = ["factory_requests", "factory_direction_mailboxes"];
	const capture = () => tables.map(table => db.prepare(`SELECT * FROM ${table} WHERE request_id = ?`).get(request.request_id)!);
	const restore = (rows: ReturnType<typeof capture>) => inTransaction(db, () => {
		for (const [i, values] of rows.entries()) {
			const { request_id, ...fields } = values;
			db.prepare(`UPDATE ${tables[i]} SET ${Object.keys(fields).map(key => `${key} = ?`).join(", ")} WHERE request_id = ?`).run(...Object.values(fields), request_id);
		}
	});
	try {
		const beforeClaim = capture();
		respond(f, request.request_id, { kind: "decline" });
		const result = await first;
		const afterClaim = capture();
		// Offer a stale snapshot while the first tool result is queued. The second wait
		// terminates and clears the runtime's pending ID, without changing its attempt key.
		restore(beforeClaim);
		const second = tool.execute("other-call", ASK, AbortSignal.timeout(2500), undefined, worker.context);
		inTransaction(db, () => terminateNodeRequests(db, request.attempt_id, request.node_id, "closed"));
		assert.equal((await second).details.status, "terminated");
		restore(afterClaim);
		const failure = await worker.hooks.get("tool_result")!({ toolName: "bootstrap_request_direction", toolCallId: "receipt-call", input: ASK, ...result });
		assert.equal(failure?.isError, true);
		assert.match(failure.content[0].text, /original attempt has changed/i);
		assert.equal(savedRequests(f)[0].reconciliation, "uncertain");
	} finally { db.close(); }
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
	const prompts: { selected?: string[]; title?: string; confirmTitle?: string; confirm?: boolean; picks: string[]; input: string | undefined; editor?: string } = { picks: [], input: "" };
	const ctx = {
		hasUI: true, cwd: f.cwd, sessionManager: { getSessionId: () => "human-session", getSessionFile: () => join(f.root, "human.jsonl") },
		ui: {
			notify: (message: string, level?: string) => notes.push({ message, level }), confirm: async (title: string) => { prompts.confirmTitle = title; return prompts.confirm ?? true; },
			select: async (title: string, options: string[]) => { prompts.title = title; prompts.selected = options; return prompts.picks.shift(); },
			input: async () => prompts.input, editor: async () => prompts.editor, setTheme: () => ({ success: true }), setTitle: () => {}, setStatus: () => {}, setFooter: () => {}, setHeader: () => {},
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

function superviseAgent(t: test.TestContext, f: Pick<Fixture, "root" | "configs">, phase = "none", config = f.configs[0], startupEvent?: object) {
	const child = spawn(process.execPath, ["--experimental-strip-types", interruptionChild, "agent", join(config.session_dir, `${config.instance_id}.config.json`), phase, continuationFile(f), ...(startupEvent ? [JSON.stringify(startupEvent)] : [])], { stdio: ["ignore", "ignore", "pipe"] });
	const exit = once(child, "close");
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	t.after(async () => { child.kill("SIGKILL"); await exit; });
	return { child, exit, stderr: () => stderr };
}

for (const phase of ["approval_after_claim", "approval_after_verdict"] as const) test(`SIGKILL at ${phase} preserves only the stages already committed`, async t => {
	const f = await fixture(t, reviewNodes());
	const build = await admittedWorker(t, f);
	const review = startWorker(t, f, "review"); // serialize the actual handoff without starting this fixture agent
	assert.ok(!(await build.complete(SUCCESS)).isError);
	const agent = superviseAgent(t, f, phase, review.config, notification(build, review));
	const pending = await pendingRequest(f);
	const answer = respond(f, pending.request_id, { kind: "choice", choice_id: "ship" });
	assert.equal(answer.request.consumption, "awaiting_consumption");
	assert.deepEqual(await agent.exit, [null, "SIGKILL"], agent.stderr());
	const before = readFileSync(join(f.root, "factories.sqlite"));
	const [request] = savedRequests(f);
	assert.equal(request.response_recorded, true);
	assert.equal(request.consumption, "consumed");
	assert.equal(request.can_redeliver, false);
	assert.throws(() => wakeSaved(f, request.request_id), /no wake sent/);
	if (phase === "approval_after_claim") {
		assert.deepEqual(request.verdict, { state: "not_recorded" });
		assert.equal(request.admissions, null);
		assert.equal(request.reconciliation, "uncertain");
	} else {
		assert.deepEqual(request.verdict, { state: "recorded", value: "ship_it" });
		assert.deepEqual(request.admissions, [{ node_id: "publish", kind: "successor", state: "not_admitted" }]);
	}
	assert.deepEqual(readFileSync(join(f.root, "factories.sqlite")), before, "read-only inspection and refused wake do not rewrite evidence");
});

function takeOver(f: Pick<Fixture, "open" | "factory">, previous: string, label: string) {
	const authority = createManagerAuthority({ pi_session_id: label });
	f.open()({ action: "takeover", factory_id: f.factory.factory_id, authority, confirmed_manager_incarnation_id: previous });
	return authority;
}

async function interruptionFixture(t: test.TestContext, variant?: "exhaustion") {
	const setup = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "setup", ...(variant ? [variant] : [])], { timeoutMs: 10_000 });
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

test("read-only managed inspection reports dead feedback after a parked agent is SIGKILLed without finalizing it", async t => {
	const f = await fixture(t, revisionNodes());
	const review = await admittedWorker(t, f, "review");
	const builder = superviseAgent(t, f, "park_after_complete");
	await until(() => existsSync(continuationFile(f)) && builder.child.pid && directionProcess(builder.child.pid).state === "T", "builder did not reach its parked barrier");
	const sent = readJson<Array<{ name: string; params: { prompt: string } }>>(continuationFile(f));
	await review.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: `session-${f.configs[0].instance_id}` }, content: sent.find(call => call.name === "coms_send")!.params.prompt } });
	await review.deliverFollowUps();
	const waiting = review.requestDirection(REVISION_ASK);
	respond(f, (await pendingRequest(f)).request_id, { kind: "choice", choice_id: "revise" });
	await waiting;
	assert.ok(!(await review.complete(SUCCESS)).isError);
	assert.equal(review.sent.length, 1);
	builder.child.kill("SIGKILL");
	assert.deepEqual(await builder.exit, [null, "SIGKILL"]);
	const dir = review.config.session_dir;
	const finalization = join(dir, `${review.config.instance_id}.finalize.json`);
	assert.equal(existsSync(finalization), false);
	const before = readdirSync(dir);
	const requests = savedRequests(f);
	assert.deepEqual(requests[0].verdict, { state: "recorded", value: "make_changes" });
	assert.equal(existsSync(finalization), false);
	assert.deepEqual(readdirSync(dir), before);
	assert.match(f.service.status(f.run.task_id, f.cwd).agents.find(node => node.node_id === "review")?.execution_reason ?? "", /Feedback edge.*is dead/);
});

test("SIGKILL around escalation retry commit retains the finalized request and never enqueues twice", async t => {
	const f = await interruptionFixture(t, "exhaustion");
	const request = savedRequests(f).find(item => item.exhaustion)!;
	const brief = "Retry after manager interruption";
	let previous = f.manager;
	for (const phase of ["before_commit", "after_commit"]) {
		const manager = await runSupervised(process.execPath, ["--experimental-strip-types", interruptionChild, "manager", f.root, f.factory.factory_id, previous, request.request_id, phase, brief], { timeoutMs: 10_000 });
		assert.equal(manager.signal, "SIGKILL", manager.stderr);
		const { owner, recovered } = JSON.parse(manager.stdout) as { owner: string; recovered: DirectionRequestView };
		previous = owner;
		assert.equal(recovered.request_id, request.request_id);
		assert.equal(recovered.response_recorded, false);
		assert.equal(recovered.can_respond, true);
	}
	const authority = takeOver(f, previous, "after-escalation");
	const saved = savedRequests(f).find(item => item.request_id === request.request_id)!;
	assert.equal(saved.response_recorded, true);
	assert.equal(saved.can_redeliver, false);
	const replay = f.open()({ action: "respond_request", factory_id: f.factory.factory_id, request_id: request.request_id, authority, response: { kind: "choice", choice_id: "retry" }, newBrief: brief });
	assert.equal(replay.replayed, true);
	const view = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(view.queue.filter(input => input.reference === request.request_id).length, 1);
	assert.equal(view.attempts.length, 1);
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

function downgradeToV8(path: string) {
	const db = new DatabaseSync(path);
	try { db.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; DROP TABLE factory_direction_deliveries; PRAGMA user_version = 8"); } finally { db.close(); }
}

const migrationRequired = /version 8.*resume management to migrate/i;

test("an admitted worker refuses to create a direction request on v8 storage before migration", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const path = join(f.root, "factories.sqlite");
	downgradeToV8(path);
	const before = readFileSync(path);
	await assert.rejects(worker.requestDirection(ASK, AbortSignal.timeout(750)), migrationRequired);
	assert.deepEqual(savedRequests(f), []);
	assert.deepEqual(readFileSync(path), before);
});

test("a saved response on v8 storage cannot be awaited or claimed by a worker before migration", async t => {
	const f = await fixture(t, [agents()[0]]);
	const agent = superviseAgent(t, f, "pause");
	const request = await pendingRequest(f);
	await until(() => agent.child.pid && directionProcess(agent.child.pid).state === "T", "agent did not reach its stopped wait boundary");
	const receiver = receiverEvidence(f, request.request_id);
	const path = join(f.root, "factories.sqlite");
	// Retain a pending snapshot to test refusal to wait independently of refusal to claim.
	const pending = readFileSync(path);
	respond(f, request.request_id, { kind: "decline" });
	downgradeToV8(path);
	const before = readFileSync(path);
	await assert.rejects(awaitDirection(path, request.request_id, receiver, { signal: AbortSignal.timeout(750) }), migrationRequired);
	const db = openRequestDatabase(path);
	try { assert.throws(() => inTransaction(db, () => claimConsumption(db, request.request_id, receiver)), migrationRequired); }
	finally { db.close(); }
	assert.equal(savedRequests(f)[0].consumption, "awaiting_consumption");
	assert.deepEqual(readFileSync(path), before);
	const pendingPath = join(f.root, "pending.sqlite");
	writeFileSync(pendingPath, pending);
	downgradeToV8(pendingPath);
	const beforeWait = readFileSync(pendingPath);
	await assert.rejects(awaitDirection(pendingPath, request.request_id, receiver, { signal: AbortSignal.timeout(750) }), migrationRequired);
	assert.deepEqual(readFileSync(pendingPath), beforeWait);
});

test("v8 migration does not infer delivery from a live attempt's old consumption claim", async t => {
	const f = await fixture(t, [agents()[0]]);
	const worker = await admittedWorker(t, f);
	const waiting = worker.requestDirection(ASK);
	const original = await pendingRequest(f);
	respond(f, original.request_id, { kind: "decline" });
	await waiting;
	const path = join(f.root, "factories.sqlite");
	downgradeToV8(path);
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
		assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 12);
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
	try { db.exec("DROP TABLE factory_revision_escalation_answers; DROP TABLE factory_direction_approvals; DROP TABLE factory_direction_deliveries; DROP TABLE factory_direction_mailboxes; PRAGMA user_version = 7"); } finally { db.close(); }
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
