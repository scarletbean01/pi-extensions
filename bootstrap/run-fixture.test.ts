import test from "node:test";
import assert from "node:assert/strict";
import { runFixture } from "./test-support/chain-fixture.ts";

const plan = {
	topology: "chain",
	task: "Three steps",
	agents: [
		{ node_id: "scout", persona: "researcher", sub_task: "Investigate" },
		{ node_id: "builder", persona: "implementer", sub_task: "Build" },
		{ node_id: "reviewer", persona: "researcher", sub_task: "Review" },
	],
} as const;

test("a three-node run can complete through notifications and report every node after all tabs close", async t => {
	const run = await runFixture(t, { ...plan, agents: [...plan.agents] });
	const scout = run.nodes.get("scout")!;
	const builder = run.nodes.get("builder")!;
	const reviewer = run.nodes.get("reviewer")!;
	const handoffState = (nodeId: string) => run.status().agents.find(agent => agent.node_id === nodeId)?.handoff?.state;
	await scout.complete({ status: "success", summary: "Investigated", detail: "" });
	assert.equal(handoffState("builder"), "queued");
	await builder.deliverNotification(scout);
	assert.equal(handoffState("builder"), "accepted");
	await builder.complete({ status: "success", summary: "Built", detail: "" });
	assert.equal(handoffState("reviewer"), "queued");
	await reviewer.deliverNotification(builder);
	assert.equal(handoffState("reviewer"), "accepted");
	await reviewer.complete({ status: "success", summary: "Reviewed", detail: "" });

	assert.equal(run.status().outcome.state, "succeeded");
	for (const node of run.nodes.values()) await node.closeTab();
	assert.equal(run.status().outcome.state, "succeeded");
	assert.deepEqual((await run.report()).results.map(result => [result.node_id, result.summary]), [
		["scout", "Investigated"], ["builder", "Built"], ["reviewer", "Reviewed"],
	]);
});

test("status distinguishes closing a tab from losing a process before it completes", async t => {
	const run = await runFixture(t, { ...plan, topology: "team", agents: [...plan.agents] });
	await run.nodes.get("scout")!.closeTab();
	run.nodes.get("builder")!.vanish();

	const agents = new Map(run.status().agents.map(agent => [agent.node_id, agent]));
	assert.match(agents.get("scout")!.execution_reason!, /Worker exited before recording a result/);
	assert.match(agents.get("builder")!.execution_reason!, /process exited before recording a result/);
	assert.equal(agents.get("reviewer")!.execution, "running");
});
