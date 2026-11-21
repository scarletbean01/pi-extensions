import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations } from "../factory/operations.ts";
import { createFactoryQueueScheduler } from "../factory/scheduler.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

function fixture(t: test.TestContext) {
	const { service, cwd, root, configs } = serviceFixture(t, ["builder"]);
	const dbPath = join(root, "factories.sqlite");
	const coordinationPath = join(root, "coord.sqlite");
	const factory = factoryOperations(dbPath, service, { coordinationPath });
	const { factory_id: factoryId } = factory({ action: "publish", name: "scheduler", draft: {
		topology: "chain", task: "FIFO", project_cwd: cwd, agents: [{ name: "builder", sub_task: "Build" }],
	}, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority();
	const target = { factory_id: factoryId, authority };
	const resume = () => factory({ action: "resume", ...target });
	const inspect = () => factory({ action: "inspect", factory_id: factoryId });
	const submit = (reference: string) => factory({ action: "submit", ...target, reference, brief: reference });
	const finish = async () => {
		const cfg = configs.at(-1)!;
		const worker = workerFromConfig(t, join(cfg.session_dir, `${cfg.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } });
		await worker.start();
		await worker.beforeStart();
		await worker.complete({ status: "success", summary: "Finished", detail: "Ready for the next input" });
	};
	return { factory, factoryId, authority, target, resume, inspect, submit, finish, dbPath, coordinationPath };
}

test("the real scheduler dispatches the waiting FIFO head only after resume and proven settlement, without closing tabs", async t => {
	const f = fixture(t);
	const attempted: Array<string | undefined> = [];
	const launched: string[] = [];
	const observedFactory = new Proxy(f.factory, { apply(operation, receiver, args) {
		if (args[0].action === "launch") attempted.push(args[0].input_id);
		return Reflect.apply(operation, receiver, args);
	} });
	const scheduler = createFactoryQueueScheduler({ factory: observedFactory, factoryId: f.factoryId, authority: f.authority, onLaunch: result => { launched.push(result.input_id); } });
	await scheduler.advance();
	f.resume();
	const discarded = f.submit("discarded");
	await f.factory({ action: "discard", ...f.target, input_id: discarded.input_id, confirm: async () => true });
	const first = f.submit("first");
	const second = f.submit("second");
	f.factory({ action: "stop", ...f.target });
	await scheduler.advance();
	assert.deepEqual(attempted, []);
	f.resume();
	const tick = scheduler.advance();
	assert.equal(scheduler.advance(), tick, "overlapping ticks share the same in-flight advance");
	await tick;
	assert.deepEqual(launched, [first.input_id]);
	assert.equal(f.inspect().head_status.input_id, second.input_id);
	assert.equal(f.inspect().head_status.blocking_kind, "factory_held");
	await scheduler.advance();
	assert.deepEqual(attempted, [first.input_id], "a held slot is not a launch attempt");
	await f.finish();
	const paths = [f.dbPath, f.coordinationPath];
	const before = paths.map(path => readFileSync(path));
	const settled = f.inspect();
	assert.equal(settled.attempts[0].settlement?.execution_settlement.state, "settled");
	assert.notEqual(settled.attempts[0].settlement?.resource_closure.state, "closed");
	assert.equal(settled.capacity.factory_slot, "held", "ordinary inspection never settles");
	assert.deepEqual(paths.map(path => readFileSync(path)), before, "inspection leaves both databases byte-for-byte unchanged");
	await scheduler.advance();
	assert.deepEqual(launched, [first.input_id, second.input_id]);
	assert.equal(f.inspect().queue.find(input => input.input_id === first.input_id)?.disposition, "settled");
	await f.finish();
	await scheduler.advance();
	await scheduler.advance();
	assert.equal(f.inspect().head_status.blocking_kind, "empty");
	assert.deepEqual(attempted, launched, "settled and discarded receipts never trigger launches");
});

test("if the observed head is discarded before dispatch, the scheduler reports the failure instead of launching its replacement", async t => {
	const f = fixture(t);
	f.resume();
	const first = f.submit("first");
	const second = f.submit("second");
	const racingFactory = new Proxy(f.factory, { apply(operation, receiver, args) {
		if (args[0].action !== "launch" || args[0].input_id !== first.input_id) return Reflect.apply(operation, receiver, args);
		return f.factory({ action: "discard", ...f.target, input_id: first.input_id, confirm: async () => true })
			.then(() => Reflect.apply(operation, receiver, args));
	} });
	const scheduler = createFactoryQueueScheduler({ factory: racingFactory, factoryId: f.factoryId, authority: f.authority });
	await assert.rejects(scheduler.advance(), /FIFO head changed before launch/);
	assert.equal(f.inspect().attempts.length, 0);
	await scheduler.advance();
	assert.equal(f.inspect().attempts[0].input_id, second.input_id);
});
