import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

async function fixture(t: test.TestContext) {
	const f = serviceFixture(t, ["builder"]);
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite") });
	const factory = open()({ action: "publish", name: "cancellation", draft: { topology: "graph", task: "Cancellation fixture", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Fixture only" }] }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
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
	assert.equal(after.capacity.factory_slot, "free");
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
	assert.equal(after.capacity.factory_slot, "free");
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
