import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";

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
