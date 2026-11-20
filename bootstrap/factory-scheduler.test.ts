import assert from "node:assert/strict";
import test from "node:test";
import { createFactoryQueueScheduler } from "../factory/scheduler.ts";

test("the manager scheduler retries only the FIFO head after capacity becomes available", async () => {
	const queue = ["first", "second"];
	let capacity = "held";
	const attempted: string[] = [];
	const scheduler = createFactoryQueueScheduler({
		queue: () => [...queue],
		launch: async (input) => {
			attempted.push(input);
			if (capacity === "held") throw new Error("capacity held");
			assert.equal(input, queue[0], "scheduler must never skip the blocked head");
			queue.shift();
			capacity = "held";
		},
	});

	await scheduler.advance();
	assert.deepEqual(attempted, ["first"]);
	capacity = "free";
	await scheduler.advance();
	assert.deepEqual(attempted, ["first", "first"], "after release, retry the same FIFO head before any later input");
	capacity = "free";
	await scheduler.advance();
	assert.deepEqual(attempted, ["first", "first", "second"]);
});

test("overlapping scheduler ticks are coalesced so one factory never races itself", async () => {
	let release!: () => void;
	let calls = 0;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const scheduler = createFactoryQueueScheduler({ queue: () => ["head"], launch: async () => { calls++; await gate; } });
	const first = scheduler.advance();
	const second = scheduler.advance();
	await Promise.resolve();
	assert.equal(calls, 1);
	release();
	await Promise.all([first, second]);
});
