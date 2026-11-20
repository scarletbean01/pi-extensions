import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

async function fixture(t: test.TestContext, agents: unknown[] = [{ node_id: "build", persona: "builder", sub_task: "Fixture only" }], personas = ["builder"]) {
	const f = serviceFixture(t, personas);
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite") });
	const factory = open()({ action: "publish", name: "cancellation", draft: { topology: "graph", task: "Cancellation fixture", project_cwd: f.cwd, agents: agents as any }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(f.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "first", brief: "Fixture brief", authority });
	const run = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	return { ...f, open, factory, authority, run };
}

test("factory cancellation requires exact-target human confirmation and retains both capacity holds", async t => {
	const f = await fixture(t);
	const request = { action: "cancel_run" as const, factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority };
	await assert.rejects(() => f.open()({ ...request, confirmed: true } as any), /confirmation/i);
	let confirmations = 0;
	const declined = await f.open()({ ...request, confirm: async target => {
		confirmations++;
		assert.equal(target.task_id, f.run.task_id);
		assert.equal(target.attempt_id, f.run.attempt_id);
		assert.match(target.consequences, /capacity|holds/i);
		return false;
	} });
	assert.equal(declined.cancelled, false);
	assert.equal(confirmations, 1);
	await assert.rejects(() => f.service.cancel(f.run.task_id, { force_close: true }), /factory/);
	await assert.rejects(() => f.service.cleanup(f.run.task_id), /factory/);
	const result = await f.open()({ ...request, confirm: async () => true });
	assert.equal(result.cancelled, true);
	const inspected = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(inspected.capacity.factory_slot, "held");
	assert.equal(inspected.capacity.checkout_slot, "held");
});

test("cancellation rechecks authority after the human dialog and at the intent commit", async t => {
	const f = await fixture(t);
	await assert.rejects(() => f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => { revokeManagerAuthority(f.authority); return true; } }), /authority|closed|replaced/i);
	assert.equal(f.service.status(f.run.task_id).agents.some(agent => agent.cancelling), false);
});

function startWorker(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, node = "build") {
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const file = readdirSync(dir).find(name => name.endsWith(".config.json") && name.includes(node))!;
	return workerFromConfig(t, join(dir, file), { model: { provider: "test-provider", id: "test-model" } });
}

test("ordinary completion settles and frees both holds while the tab is still open", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	const before = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(before.attempts[0].settlement?.execution_settlement.state, "unsettled", before.attempts[0].settlement?.execution_settlement.reason);
	assert.equal((await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority })).settled, false);
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	const observed = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(observed.attempts[0].settlement?.execution_settlement.state, "settled");
	assert.equal(observed.capacity.factory_slot, "held", "inspection never releases capacity");
	assert.equal(observed.capacity.checkout_slot, "held");
	const result = await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
	assert.equal(result.settled, true);
	const after = f.open()({ action: "inspect", factory_id: f.factory.factory_id });
	assert.equal(after.capacity.factory_slot, "free", JSON.stringify(after.uncertainty));
	assert.equal(after.capacity.checkout_slot, "free");
	assert.deepEqual(after.uncertainty, []);
	assert.equal(after.attempts[0].settlement?.capacity_release, "released");
	assert.equal(f.service.status(f.run.task_id).manifest.status, "applied", "run evidence is retained");
});

async function confirmedCancel(f: Awaited<ReturnType<typeof fixture>>) {
	return f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
}
const settle = (f: Awaited<ReturnType<typeof fixture>>) => f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority });
const inspect = (f: Awaited<ReturnType<typeof fixture>>) => f.open()({ action: "inspect", factory_id: f.factory.factory_id });

test("cancelling in-flight work keeps both holds until the worker actually settles", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	assert.equal((await confirmedCancel(f)).cancelled, true);
	const requested = inspect(f).attempts[0].settlement!;
	assert.equal(requested.cancellation.intent, "requested");
	assert.equal(requested.execution_settlement.state, "unsettled", "intent is not settlement");
	assert.equal(requested.capacity_release, "held");
	const refused = await settle(f);
	assert.equal(refused.settled, false);
	assert.equal(inspect(f).capacity.checkout_slot, "held");
	// The in-flight tool finishes and the worker records the cancelled disposition.
	await worker.hooks.get("agent_settled")!({ aborted: true });
	const settledResult = await settle(f);
	assert.equal(settledResult.settled, true, settledResult.reason);
	const after = inspect(f);
	assert.equal(after.attempts[0].settlement!.cancellation.intent, "requested");
	assert.equal(after.attempts[0].settlement!.outcome, "cancelled");
	assert.equal(after.attempts[0].settlement!.capacity_release, "released");
	assert.equal(after.capacity.factory_slot, "free", JSON.stringify(after.uncertainty));
	assert.deepEqual(after.uncertainty, []);
});

test("closing the tab without settlement neither settles the run nor frees capacity", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await f.closeTab(f.run.task_id.length ? f.service.status(f.run.task_id).agents[0].tab_id! : "");
	const view = inspect(f);
	assert.notEqual(view.attempts[0].settlement?.execution_settlement.state, "settled");
	assert.equal((await settle(f)).settled, false);
	assert.equal(inspect(f).capacity.factory_slot === "free", false);
	assert.equal(inspect(f).capacity.checkout_slot === "free", false);
});

test("a failed run settles but stays outstanding attention", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });
	const result = await settle(f);
	assert.equal(result.settled, true, result.reason);
	assert.deepEqual(inspect(f).attempts[0].settlement!.attention, ["run outcome is failed"]);
});

test("interruption at the settlement commit leaves both holds and settles on retry", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	const crashing = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite"), atLaunchCommit: phase => { if (phase === "settle_before_commit") throw new Error("crash"); } });
	await assert.rejects(() => crashing({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority }), /crash/);
	const held = inspect(f);
	assert.equal(held.capacity.factory_slot, "held");
	assert.equal(held.capacity.checkout_slot, "held");
	assert.deepEqual(held.uncertainty, []);
	assert.equal((await settle(f)).settled, true);
	assert.equal(inspect(f).capacity.factory_slot, "free");
});

test("settlement retains the report and run evidence, and inspection has no cleanup side effect", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Kept summary", detail: "ok" });
	inspect(f); inspect(f);
	assert.equal(f.service.status(f.run.task_id).manifest.status, "applied");
	assert.equal((await settle(f)).settled, true);
	const status = f.service.status(f.run.task_id);
	assert.equal(status.manifest.status, "applied");
	assert.equal(status.manifest.session_dir_removed, undefined);
	assert.match(JSON.stringify(f.service.readOnlyReport(f.run.task_id).results), /Kept summary/);
});

test("parked and revising nodes keep capacity held until the loop is finalized", async t => {
	const reviewer = { node_id: "review", persona: "reviewer", depends_on: ["build"], sub_task: "Review", output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } }, decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 } };
	const f = await fixture(t, [{ node_id: "build", persona: "builder", sub_task: "Build" }, reviewer], ["builder", "reviewer"]);
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const drive = (node: string) => workerFromConfig(t, join(dir, readdirSync(dir).find(name => name.endsWith(".config.json") && name.includes(node))!), { model: { provider: "test-provider", id: "test-model" } });
	const builder = drive("build");
	const review = drive("review");
	await builder.start(); await review.start();
	await builder.beforeStart();
	await builder.complete({ status: "success", summary: "v1", detail: "" });
	const parked = inspect(f).attempts[0].settlement!;
	assert.equal(parked.execution_settlement.state, "unsettled");
	assert.equal((await settle(f)).settled, false);
	assert.equal(inspect(f).capacity.factory_slot, "held");
	assert.equal(inspect(f).capacity.checkout_slot, "held");
});

test("the next input launches on the freed capacity after settlement, never before", async t => {
	const f = await fixture(t);
	f.open()({ action: "submit", factory_id: f.factory.factory_id, reference: "second", brief: "Second brief", authority: f.authority });
	await assert.rejects(() => f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority }), /held|capacity|hold/i);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	// No explicit settle: launch releases a reliably settled run's capacity first.
	const next = await f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority });
	assert.notEqual(next.task_id, f.run.task_id);
	const view = inspect(f);
	assert.deepEqual(view.uncertainty, []);
	assert.equal(view.capacity.factory_slot, "held");
});

test("cancelling a run whose worker vanished mid-work does not prove it stopped", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	assert.equal((await confirmedCancel(f)).cancelled, true);
	const view = inspect(f);
	assert.notEqual(view.attempts[0].settlement?.execution_settlement.state, "settled");
	const result = await settle(f);
	assert.equal(result.settled, false);
	assert.equal(inspect(f).capacity.factory_slot, "held");
	assert.equal(inspect(f).capacity.checkout_slot, "held");
});

test("a second factory on the same checkout is not blocked by the first factory's settled run", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	assert.equal((await settle(f)).settled, true);
	const other = f.open()({ action: "publish", name: "other-factory", draft: { topology: "graph", task: "Other", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Fixture only" }] }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const view = f.open()({ action: "inspect", factory_id: other.factory_id });
	assert.deepEqual(view.uncertainty, []);
	assert.equal(view.capacity.checkout_slot, "free");
});

test("a worker woken on a settled run is refused", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	assert.equal((await settle(f)).settled, true);
	const late = startWorker(t, f);
	await late.start();
	assert.ok(late.shutdowns >= 1, "the barrier shuts a late worker of a settled run down");
});

test("factory authority redelivers a demonstrably unclaimed handoff once, without repairing the run", async t => {
	const agents = [{ node_id: "n1", persona: "builder", sub_task: "one" }, { node_id: "n2", persona: "builder", depends_on: ["n1"], sub_task: "two" }];
	const f = await fixture(t, agents);
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const files = readdirSync(dir);
	const driver = (node: string) => workerFromConfig(t, join(dir, files.find(name => name.endsWith(".config.json") && name.includes(`-${node}`))!), { model: { provider: "test-provider", id: "test-model" } });
	const first = driver("n1"), second = driver("n2");
	await first.start(); await second.start();
	await first.beforeStart();
	await first.complete({ status: "success", summary: "Built", detail: "" });
	const resultFile = join(dir, readdirSync(dir).find(name => name.endsWith("n1.result.json"))!);
	const record = JSON.parse(readFileSync(resultFile, "utf8"));
	writeFileSync(resultFile, JSON.stringify({ ...record, delivery: "pending" }));
	for (const name of readdirSync(dir).filter(name => name.endsWith("n2.handoff-offer.json"))) rmSync(join(dir, name), { force: true });
	const woken: string[] = [];
	const wake = async (target: string) => { woken.push(target); };
	const request = { action: "redeliver_handoff" as const, factory_id: f.factory.factory_id, authority: f.authority, agent: "n2", wake };
	const bare = { ...request, authority: createManagerAuthority({ pi_session_id: "other", pi_session_file: join(f.root, "other.jsonl") }) };
	await assert.rejects(() => f.open()(bare), /authority/i);
	assert.equal(woken.length, 0);
	await f.open()(request);
	assert.equal(woken.length, 1);
	assert.equal(inspect(f).capacity.factory_slot, "held");
});

test("a failed run's outstanding attention is visible on the input receipt", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });
	assert.equal((await settle(f)).settled, true);
	const receipt = f.open()({ action: "receipt", factory_id: f.factory.factory_id, reference: "first" });
	assert.equal(receipt.disposition, "settled");
	assert.deepEqual(receipt.attempt?.settlement?.attention, ["run outcome is failed"]);
});

test("a lost acknowledgement after the settlement commit leaves the run settled and idempotent", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	const crashing = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite"), atLaunchCommit: phase => { if (phase === "settle_after_commit") throw new Error("lost ack"); } });
	await assert.rejects(() => crashing({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority }), /lost ack/);
	const view = inspect(f);
	assert.equal(view.capacity.factory_slot, "free");
	assert.deepEqual(view.uncertainty, []);
	assert.equal((await settle(f)).settled, false, "a second settle finds nothing left to release");
});

test("a malformed stored settlement record is reported as damaged, never shown as authoritative", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	assert.equal((await settle(f)).settled, true);
	const { DatabaseSync } = await import("node:sqlite");
	const { buildAttemptRow } = await import("./factory-records.ts");
	const db = new DatabaseSync(join(f.root, "factories.sqlite"));
	const row = db.prepare("SELECT * FROM factory_attempts").get() as any;
	const forged = buildAttemptRow({ ...row, error: 'settlement:{"capacity_release":"released"}' });
	db.prepare("UPDATE factory_attempts SET error = ?, record_digest = ? WHERE attempt_id = ?").run(forged.error, forged.record_digest, row.attempt_id);
	db.close();
	const view = inspect(f);
	assert.equal(view.attempts[0].settlement, undefined);
	assert.match(view.uncertainty.join(";"), /no readable settlement record/);
});

test("suspected detached work blocks settlement until it records an outcome", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const instance = f.service.status(f.run.task_id).agents[0].instance_id;
	writeFileSync(join(dir, `${instance}.detached.json`), JSON.stringify({ task_id: f.run.task_id, reason: "reload", detached_at: new Date().toISOString() }));
	assert.equal((await confirmedCancel(f)).cancelled, true);
	await worker.hooks.get("agent_settled")!({ aborted: true });
	const result = await settle(f);
	assert.equal(result.settled, false);
	assert.match(result.reason, /detached/);
	assert.equal(inspect(f).capacity.checkout_slot, "held");
});

test("inspection lists failed runs and uncertain evidence as outstanding attention", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });
	assert.equal((await settle(f)).settled, true);
	assert.deepEqual(inspect(f).attention.map(item => [item.kind, item.reason]), [["failed_run", "run outcome is failed"]]);
});

test("a node revising after a rejected review keeps capacity held until the loop is finalized", async t => {
	const reviewerNode = { node_id: "review", persona: "reviewer", depends_on: ["build"], sub_task: "Review", output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } }, decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 } };
	const f = await fixture(t, [{ node_id: "build", persona: "builder", sub_task: "Build" }, reviewerNode], ["builder", "reviewer"]);
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const drive = (node: string) => workerFromConfig(t, join(dir, readdirSync(dir).find(name => name.endsWith(".config.json") && name.includes(node))!), { model: { provider: "test-provider", id: "test-model" } });
	const builder = drive("build"), review = drive("review");
	await builder.start(); await review.start();
	await builder.beforeStart();
	await builder.complete({ status: "success", summary: "v1", detail: "" });
	await review.beforeStart(notification(builder as any, review as any));
	await review.complete({ status: "success", summary: "no", detail: "", outputs: { verdict: "revise" } });
	await builder.beforeStart(notification(review as any, builder as any));
	const view = inspect(f);
	assert.equal(view.attempts[0].settlement?.execution_settlement.state, "unsettled", view.attempts[0].settlement?.execution_settlement.reason);
	assert.equal((await settle(f)).settled, false);
	assert.equal(view.capacity.factory_slot, "held");
	assert.equal(view.capacity.checkout_slot, "held");
});

test("manager commands refuse bad usage and missing UI before touching any run", async t => {
	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, { handler: Function }>();
	registerBootstrap({ registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as any);
	const notes: string[] = [];
	const ctx = { hasUI: false, cwd: process.cwd(), ui: { notify: (message: string) => notes.push(message), confirm: async () => true }, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const run = async (args: string) => { notes.length = 0; await commands.get("factory")!.handler(args, ctx); return notes.join("\n"); };
	assert.match(await run("cancel"), /Usage: \/factory cancel/);
	assert.match(await run("settle"), /Usage: \/factory settle/);
	assert.match(await run("redeliver only-one"), /Usage: \/factory redeliver/);
	assert.match(await run("cancel factory-x"), /requires an interactive Pi session with a UI/);
});
