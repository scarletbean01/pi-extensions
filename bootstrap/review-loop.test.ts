import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { publishFailFast } from "./ownership.ts";
import { createGraphWidgets } from "./graph-widget.ts";
import { finalizeReview } from "./review-loop.ts";
import { atomicJson, readJson, resultPath, type ReportEntry, type WorkerCompletion } from "./session-store.ts";
import { buildMarkdownReport, formatAgentStates, formatCancelResult, formatPlan, formatRecovery, formatReportDigest, formatRunOutcome } from "./reporting.ts";
import { parseCompletion as readPreviousCompletion, parseWorkerConfig as readPreviousConfig, parseManifest as readPreviousManifest } from "./test-support/previous-v4-session-store.ts";
import { chain, model, runFixture } from "./test-support/chain-fixture.ts";

const review = {
	...chain.agents[1],
	output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "revise"] } } },
	decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "n1", max_revisions: 2 },
};
const complete = (summary: string, verdict?: string) => ({
	status: "success", summary, detail: summary, ...(verdict ? { outputs: { verdict } } : {}),
});

test("a rejected review revises the same two agents and approval finalizes both", async t => {
	const f = await runFixture(t, { ...chain, agents: [chain.agents[0], review] }, new Map(), { simulateShutdown: true });
	assert.throws(() => readPreviousManifest(f.status().manifest, f.run.task_id), /Unsupported bootstrap manifest version 5/);
	const builder = f.nodes.get("n1")!;
	assert.throws(() => readPreviousConfig(builder.config), /Unsupported bootstrap worker configuration version 5/);
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Original build"));
	assert.match(states(f), /a1-n1 .*Original build.*attempt 1\/3, parked/);
	await builder.complete(complete("Unexpected editing while parked")).catch(() => undefined);
	assert.match(states(f), /a1-n1 .*Original build.*attempt 1\/3, parked/);
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Invalid result", "try again"));
	assert.match(states(f), /a2-n2 .*\[execution running\].*attempt 1\/3/);
	await reviewer.complete(complete("Add missing coverage", "revise"));
	assert.match(statusText(f), /Run outcome: incomplete/);
	assert.match(states(f), /a2-n2 .*Add missing coverage.*attempt 1\/3, parked/);

	const revision = await builder.deliverNotification(reviewer);
	await builder.deliverNotification(reviewer);
	assert.match(states(f), /a1-n1 .*\[execution running\].*attempt 2\/3/);
	assert.match(states(f), /a2-n2 .*Add missing coverage.*attempt 1\/3, parked/);
	const feedback = await builder.readInput({ kind: "result", node_id: "n2", attempt_id: "a2-n2.1" });
	assert.throws(() => readPreviousCompletion(JSON.parse(feedback.details.text), { run_id: f.run.task_id, instance_id: reviewer.config.instance_id }), /Unsupported result record version 5/);
	await builder.complete({
		...complete("Coverage added"),
		detail: `Builder revision prompt: ${JSON.stringify(revision?.systemPrompt)}\nBuilder retrieved feedback: ${JSON.stringify(feedback.details.text)}`,
	});
	const nextReview = await reviewer.deliverNotification(builder);
	const history = await reviewer.readInput({ kind: "result", node_id: "n2", attempt_id: "a2-n2.1" });
	await reviewer.complete({
		...complete("Coverage approved", "approve"),
		detail: `Reviewer revision prompt: ${JSON.stringify(nextReview?.systemPrompt)}\nReviewer retrieved history: ${JSON.stringify(history.details.text)}`,
	});

	assert.match(statusText(f), /Run outcome: succeeded/);
	assert.match(states(f), /a1-n1 .*: done.*Coverage added.*attempt 2\/3, finalized/);
	assert.match(states(f), /a2-n2 .*: done.*Coverage approved.*attempt 2\/3, finalized/);
	assert.match(await reportText(f), /Coverage added[^\n]*\n[^\n]*Coverage approved/);
	const report = await markdownReport(f);
	assert.match(report, /Builder revision prompt: [^\n]*Earlier attempts and review findings/);
	assert.match(report, /Builder retrieved feedback: [^\n]*Add missing coverage/);
	assert.match(report, /Reviewer revision prompt: [^\n]*verdict \\"revise\\"/);
	assert.match(report, /Reviewer retrieved history: [^\n]*Add missing coverage/);
});

test("a successor outside the loop receives only the final approval on its first attempt", async t => {
	const f = await runFixture(t, { ...chain, agents: [chain.agents[0], review, {
		node_id: "publish", persona: "publisher", sub_task: "Publish the approved build",
	}] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const publisher = f.nodes.get("publish")!;
	await builder.complete(complete("Original build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise build", "revise"));
	assert.match(states(f), /a3-publish .*\[execution waiting\]/);
	assert.doesNotMatch(states(f), /a3-publish .*handoff in/);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved revised build", "approve"));
	await publisher.deliverNotification(reviewer);
	await publisher.complete(complete("Published"));
	assert.match(statusText(f), /Run outcome: succeeded/);
	assert.match(states(f), /a3-publish .*Published.*attempt 1\/1/);
	assert.match(await reportText(f), /Revised build[^\n]*\n[^\n]*Approved revised build[^\n]*\n[^\n]*Published/);
});

const loopPlan = { ...chain, agents: [chain.agents[0], review] };
const publish = { node_id: "publish", persona: "publisher", sub_task: "Publish the approved build" };
const states = (f: Awaited<ReturnType<typeof runFixture>>) => formatAgentStates(f.status().agents, f.run.topology);
const reportText = async (f: Awaited<ReturnType<typeof runFixture>>) => formatReportDigest((await f.report()).results);
const markdownReport = async (f: Awaited<ReturnType<typeof runFixture>>) => buildMarkdownReport((await f.report()).results);
const statusText = (f: Awaited<ReturnType<typeof runFixture>>) => {
	const status = f.status();
	return formatRunOutcome(status.outcome, status.agents) + "\n" + states(f) + "\n" +
		[...status.delivery_errors, ...status.worker_errors].join("\n");
};

async function rejectFirstBuild(f: Awaited<ReturnType<typeof runFixture>>) {
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Original build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise build", "revise"));
	return { builder, reviewer };
}

test("a revision can outlast the successor's dependency timer while the loop is making progress", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, dependency_wait_timeout_ms: 6_000, agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	const publisher = f.nodes.get("publish")!;
	await builder.deliverNotification(reviewer);
	for (let step = 0; step < 16; step++) {
		await builder.hooks.get("tool_execution_start")!({});
		t.mock.timers.tick(1_000);
	}
	assert.match(states(f), /a3-publish .*\[execution waiting\]/);
	await builder.complete(complete("Revision after sixteen seconds"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved long revision", "approve"));
	await publisher.deliverNotification(reviewer);
	await publisher.complete(complete("Published after the revision"));
	assert.match(statusText(f), /Run outcome: succeeded/i);
	assert.match(await reportText(f), /Published after the revision/);
});

test("the reviewer is blocked and finalized on attempt 2 if the revised build fails", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete({ status: "failure", summary: "Revision broke the build", detail: "The build failed" });
	assert.match(states(f), /a1-n1 .*Revision broke the build.*attempt 2\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Revision broke the build.*\[execution blocked.*\[attempt 2\/3, finalized\]/);
	assert.match(statusText(f), /Run outcome: failed .*2 blocked/);
	assert.equal(f.status().outcome.terminal, true);
	const digest = await reportText(f);
	assert.match(digest, /publish.*blocked.*Revision broke the build/);
	assert.match(digest, /Attempt 2\/3: blocked — .*Revision broke the build/);
	assert.match(digest, /Loop ended: .*Revision broke the build/);
	assert.deepEqual(f.status().agents.slice(0, 2).map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	t.mock.timers.tick(1_000);
	const heartbeat = () => f.status().agents.find(agent => agent.node_id === "n2")!.heartbeat_age_ms;
	assert.equal(heartbeat(), 0, "settlement publishes progress for the blocked attempt");
	t.mock.timers.tick(6_000);
	assert.equal(heartbeat(), 6_000, "settled reviewer stopped polling");
});

for (const onExhausted of [undefined, "failed"] as const) {
	test(`an exhausted loop finalizes as ${onExhausted ?? "needs_attention"} and blocks its successor`, async t => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const f = await runFixture(t, { ...loopPlan, agents: [loopPlan.agents[0], {
			...review, decision: { ...review.decision, max_revisions: 1, on_exhausted: onExhausted },
		}, { ...publish, dependency_policy: "allow_partial" }] });
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		await builder.complete(complete("Revised build"));
		await reviewer.deliverNotification(builder);
		await reviewer.complete(complete("Still rejected", "revise"));
		t.mock.timers.tick(1_000);
		assert.match(states(f), /a1-n1 .*Revised build.*attempt 2\/2, finalized/);
		const outcome = onExhausted ?? "needs_attention";
		assert.match(states(f), new RegExp(`a2-n2 .*Review loop exhausted its revision limit .*n1.*n2.*execution ${outcome}.*attempt 2/2, finalized`));
		assert.match(states(f), /a3-publish .*Review loop exhausted its revision limit.*execution blocked/);
		assert.match(statusText(f), new RegExp(`Run outcome: ${outcome}`));
		assert.equal(f.status().outcome.terminal, true);
		assert.equal(f.status().agents.find(agent => agent.node_id === "publish")?.edge_states?.n2, "dead");
		assert.match(await reportText(f), new RegExp(`Run outcome: ${outcome}`));
	});
}

test("a partial review finalizes without following either edge, even with an allow-partial successor", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, {
		...publish, dependency_policy: "allow_partial",
	}] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Ready for review"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete({ ...complete("Review was inconclusive", "revise"), status: "partial" });
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a1-n1 .*Ready for review.*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*partial: Review was inconclusive.*execution partial.*attempt 1\/3, finalized/);
	assert.match(states(f), /a3-publish .*execution blocked.*n2 \(partial\)/);
	assert.equal(f.status().outcome.terminal, true);
	assert.equal(f.status().agents.find(agent => agent.node_id === "publish")?.edge_states?.n2, "dead");
	assert.match(await reportText(f), /publish.*blocked.*partial result/);
});

test("lost acknowledgements do not swallow feedback or leave an outside node pending", async t => {
	const lostAck = { executeTool: async () => ({ isError: true, content: [{ type: "text", text: "Lost transport acknowledgement" }] }) };
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish, {
		node_id: "announce", persona: "publisher", sub_task: "Announce the publication",
	}] }, new Map([["n1", lostAck], ["n2", lostAck], ["publish", lostAck]]));
	const { builder, reviewer } = await rejectFirstBuild(f);
	const publisher = f.nodes.get("publish")!;
	const announcer = f.nodes.get("announce")!;
	assert.match(states(f), /a1-n1 .*attempt 1\/3, parked/);
	await builder.deliverNotification(reviewer);
	assert.match(states(f), /a1-n1 .*\[execution running\].*\[attempt 2\/3\]/);
	await builder.complete(complete("Revised after lost acknowledgement"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved after lost acknowledgement", "approve"));
	await publisher.deliverNotification(reviewer);
	// Simulate restart before the sender could record the lost-ack state.
	await publisher.complete(complete("Published"));
	const path = resultPath(f.run.session_dir, "a3-publish.1");
	atomicJson(path, { ...readJson<WorkerCompletion>(path), delivery: "pending" });
	await announcer.deliverNotification(publisher);
	await announcer.complete(complete("Announced publication"));
	assert.match(statusText(f), /Run outcome: succeeded/i);
	assert.doesNotMatch(statusText(f), /Lost transport acknowledgement/);
});

test("resuming an already delivered completion parks the worker even when its acknowledgement was lost", async t => {
	const f = await runFixture(t, loopPlan, new Map([["n1", { executeTool: async () => ({ isError: true, content: [] }) }]]), { simulateShutdown: true });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build with a lost acknowledgement"));
	await reviewer.deliverNotification(builder);
	await builder.complete(complete("Retry the original delivery"));
	assert.match(states(f), /a1-n1 .*: done.*attempt 1\/3, parked/);
	assert.doesNotMatch(states(f), /a1-n1 .*: closed/);
	await reviewer.complete(complete("Reviewed after the retry", "revise"));
	await builder.deliverNotification(reviewer);
	assert.match(states(f), /a1-n1 .*\[execution running\].*\[attempt 2\/3\]/);
});

test("reload restores both latest attempts and the reserved revision budget", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, max_total_attempts: 5, agents: [...loopPlan.agents, publish] });
	const first = await rejectFirstBuild(f);
	await first.builder.deliverNotification(first.reviewer);
	await first.builder.complete(complete("Only affordable revision"));
	const reviewer = await f.reload("n2");
	await reviewer.deliverNotification(first.builder);
	await reviewer.complete(complete("Rejected the only revision", "revise"));
	await f.reload("n1");
	await f.reload("n2");
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a1-n1 .*attempt 2\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Run attempt budget exhausted.*attempt 2\/3, finalized/);
	assert.match(states(f), /a3-publish .*Run attempt budget exhausted.*execution blocked/);
	assert.equal(f.status().outcome.terminal, true);
	assert.match(states(f), /Only affordable revision/);
});

test("a reload after a revision claim never replays work of uncertain outcome", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	const reloaded = await f.reload("n1");
	await reloaded.deliverNotification(reviewer);
	assert.match(states(f), /a1-n1 .*not replayed automatically.*attempt 2\/3/);
});

test("parked agents have no active tools, and closing their tabs preserves their work", async t => {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	await builder.complete(complete("Saved before tab close"));
	const parkedTools = [...builder.active];
	const bash = await builder.hooks.get("tool_call")!({ toolName: "bash" });
	await f.service.cleanup(f.run.task_id, undefined, false, undefined, undefined, ["n1"]);
	assert.match(states(f), /a1-n1 .*: closed.*Saved before tab close.*attempt 1\/3, parked/);
	assert.doesNotMatch(statusText(f), /exited before recording a result/);
	const reviewer = f.nodes.get("n2")!;
	await reviewer.deliverNotification(builder);
	await reviewer.complete({
		...complete("Approved after the builder tab closed", "approve"),
		detail: `Parked builder tools: ${JSON.stringify(parkedTools)}\nBash guard: ${JSON.stringify(bash)}`,
	});
	const report = await markdownReport(f);
	assert.match(report, /Saved before tab close/);
	assert.match(report, /Parked builder tools: \[\]\nBash guard: \{"block":true,"reason":"Bootstrap worker has no admitted work or has already completed"\}/);
});

test("an attempt-1 handoff cannot start attempt 2, and concurrent revision notifications start it once", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	const stale = reviewer.notificationFrom(builder);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Newly revised input"));
	await reviewer.beforeStart(stale);
	assert.match(states(f), /a2-n2 .*Revise build.*attempt 1\/3, parked/);
	const duplicate = await Promise.all([reviewer.deliverNotification(builder), reviewer.deliverNotification(builder)]);
	assert.match(states(f), /a2-n2 .*\[execution running\].*\[attempt 2\/3\]/);
	await reviewer.complete({
		...complete("Accepted only the current input", "approve"),
		detail: `Model turns admitted for the current handoff: ${duplicate.filter(Boolean).length}`,
	});
	assert.match(await markdownReport(f), /Model turns admitted for the current handoff: 1\n/);
});

test("cancelling a finalized reviewer preserves the result and does not block its waiting successor", async t => {
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved before cancellation", "approve"));
	const result = await f.service.cancel(f.run.task_id, { agents: ["n2"], grace_ms: 0 });
	const cancellation = formatCancelResult(result);
	assert.match(cancellation, /Already completed \(preserved\): n2/);
	assert.doesNotMatch(cancellation, /Cancelling \(in-flight work\)|downstream blockers/);
	await f.service.cancel(f.run.task_id, { agents: ["n2"], force_close: true });
	assert.match(states(f), /a2-n2 .*Approved before cancellation.*attempt 2\/3, finalized/);
	assert.match(states(f), /a3-publish .*\[execution waiting\]/);
});

test("cancel wins against a concurrent attempt-2 completion and status shows the cancellation", async t => {
	const signalled = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const f = await runFixture(t, loopPlan, new Map(), {
		signalWorker: async () => { signalled.resolve(); await release.promise; },
	});
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	const cancelling = f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "Stop the second build" });
	await signalled.promise;
	try { await builder.complete(complete("This completion lost the race")); }
	finally { release.resolve(); }
	await cancelling;
	assert.match(states(f), /a1-n1 .*Stop the second build.*\[execution cancelled\].*attempt 2\/3/);
	assert.match(states(f), /a2-n2 .*Stop the second build.*\[execution blocked.*attempt 2\/3/);
	assert.doesNotMatch(statusText(f), /This completion lost the race/);
});

test("a completed outcome claim wins cancellation even before a result file is visible", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	// Stop the worker exactly at the next write after its exclusive completion claim.
	const original = fs.writeFileSync;
	fs.writeFileSync = ((path, ...args) => {
		if (String(path).includes("a1-n1.2.result.json")) throw new Error("Result write interrupted");
		return Reflect.apply(original, fs, [path, ...args]);
	}) as typeof fs.writeFileSync;
	syncBuiltinESMExports();
	try { await builder.complete(complete("Completion claimed the outcome")); }
	finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
	const cancellation = formatCancelResult(await f.service.cancel(f.run.task_id, { agents: ["n1"] }));
	assert.match(cancellation, /Already completed \(preserved\): n1/);
	assert.doesNotMatch(cancellation, /Cancelling \(in-flight work\)|downstream blockers/);
	await builder.complete(complete("Retried the winning completion"));
	assert.match(states(f), /Retried the winning completion.*attempt 2\/3, parked/);
});

test("recovery inspects and retries the unclaimed feedback edge for attempt 2", async t => {
	const f = await runFixture(t, loopPlan, new Map([["n2", { executeTool: async () => ({ isError: true, content: [] }) }]]));
	const { builder } = await rejectFirstBuild(f);
	const inspect = () => f.service.recover(f.run.task_id, { action: "inspect", agent: "n1" });
	assert.match(formatRecovery(await inspect()), /n2 → n1 .*deliverable \[retry_delivery\]/);
	const response = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n1" }, {
		senderSession: "dispatcher-session",
		wake: async (_session, prompt) => {
			await builder.beforeStart({ systemPrompt: "BASE", messageType: "custom",
				message: { customType: "coms-inbound", details: { sender_session: "dispatcher-session" }, content: prompt } });
		},
	});
	assert.match(formatRecovery(response), /n2 → n1 .*accepted_running \[wait\]/);
	assert.match(states(f), /a1-n1 .*dispatcher.*\[execution running\].*attempt 2\/3/);
});

test("status accepts a dispatcher finalization of a parked review attempt", async t => {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	await builder.complete(complete("Ready for dispatcher finalization"));
	atomicJson(join(f.run.session_dir, "a1-n1.finalize.json"), {
		version: 1, run_id: f.run.task_id, instance_id: "a1-n1", attempt_id: "a1-n1.1", finalized_by: "dispatcher",
	});
	assert.match(states(f), /a1-n1 .*Ready for dispatcher finalization.*attempt 1\/3, finalized/);
	assert.doesNotMatch(statusText(f), /Invalid or unsupported finalization/);
});

test("status refuses review plans grafted onto earlier manifest, config and result formats", async t => {
	const f = await runFixture(t, loopPlan);
	const { task_id, session_dir } = f.run;
	const builder = f.nodes.get("n1")!;
	await builder.complete(complete("Written using the review format"));
	const manifestPath = join(f.service.store.indexRoot, `${task_id}.json`);
	const configPath = join(session_dir, "a1-n1.config.json");
	const resultFile = resultPath(session_dir, "a1-n1.1");
	const originalResult = readJson<WorkerCompletion>(resultFile);
	const graph = { ...f.run, topology: "graph" as const };
	assert.match(states(f), /Written using the review format.*attempt 1\/3, parked/);

	for (const version of [2, 3, 4]) {
		atomicJson(manifestPath, { ...(version === 2 ? f.run : graph), version });
		assert.throws(() => f.status(), /Review plan requires review record version/);
	}
	const { review_plan: _manifestPlan, ...missingManifestPlan } = f.run;
	atomicJson(manifestPath, missingManifestPlan);
	assert.throws(() => f.status(), /Invalid persisted review plan/);
	atomicJson(manifestPath, f.run);

	for (const version of [2, 3, 4]) {
		atomicJson(resultFile, { ...originalResult, version });
		const refusal = version === 2 ? "Review plan requires review record version" : `Unsupported result record version ${version}`;
		assert.match(states(f), new RegExp(refusal));
	}
	const { review_plan: _resultPlan, ...missingResultPlan } = originalResult;
	atomicJson(resultFile, missingResultPlan);
	assert.match(states(f), /unusable result file: Invalid persisted review plan/);
	atomicJson(resultFile, originalResult);

	for (const version of [2, 3, 4]) {
		atomicJson(configPath, { ...builder.config, topology: version === 2 ? "chain" : "graph", version });
		await f.reload("n1");
		assert.match(states(f), /Review plan requires review record version/);
	}
	const { review_plan: _configPlan, ...missingConfigPlan } = builder.config;
	atomicJson(configPath, missingConfigPlan);
	await f.reload("n1");
	assert.match(states(f), /Invalid persisted review plan/);
});

test("revision admission errors are attached to the attempted revision", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	const valid = reviewer.notificationFrom(builder);
	const offer = join(f.run.session_dir, "a2-n2.2.from-a1-n1.handoff-offer.json");
	atomicJson(offer, { ...readJson<Record<string, unknown>>(offer), version: 99 });
	await reviewer.beforeStart(valid);
	assert.match(states(f), /a2-n2 .*Unsupported handoff offer version 99.*\[execution needs_attention\].*attempt 2\/3/);
	assert.doesNotMatch(states(f), /a2-n2 .*Revise build.*attempt 1\/3/);
});

test("the settled widget reads elapsed time from the latest review attempt", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(31_000);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved later", "approve"));
	let widgetText = "";
	const widgets = createGraphWidgets(() => f.status());
	t.after(() => widgets.clear());
	widgets.attach(f.run.task_id, {
		hasUI: true,
		cwd: f.cwd,
		ui: {
			setWidget(_key: string, factory?: Function) {
				if (factory) widgetText = factory({}, { fg: (_color: string, value: string) => value }).render(100).join("\n");
			},
		},
	} as Parameters<typeof widgets.attach>[1]);
	assert.match(widgetText, /succeeded · 00:31/);
});

test("a failed first build settles the loop and blocks the outside successor on its first poll", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, dependency_wait_timeout_ms: 3_000, agents: [...loopPlan.agents, publish] });
	await f.nodes.get("n1")!.complete({ status: "failure", summary: "First build failed", detail: "Compilation failed" });
	assert.match(states(f), /a1-n1 .*First build failed.*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*First build failed.*\[execution blocked.*attempt 1\/3, finalized/);
	assert.deepEqual(f.status().agents.slice(0, 2).map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a3-publish .*First build failed.*\[execution blocked/);
	assert.match(statusText(f), /Run outcome: failed \(.*2 blocked/);
	assert.match(await reportText(f), /publish.*blocked.*First build failed/);
});

test("a failed first review finalizes the builder and blocks the outside successor", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, dependency_wait_timeout_ms: 3_000, agents: [...loopPlan.agents, publish] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Ready for review"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete({ status: "failure", summary: "First review failed", detail: "Review could not complete" });
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a1-n1 .*Ready for review.*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*failure: First review failed.*execution failed.*attempt 1\/3, finalized/);
	assert.match(states(f), /a3-publish .*First review failed.*\[execution blocked/);
	assert.match(statusText(f), /Run outcome: failed/);
	assert.equal(f.status().outcome.terminal, true);
	assert.match(await reportText(f), /publish.*blocked.*First review failed/);
});

test("the first review's task deadline finalizes the loop and blocks the outside successor", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...loopPlan, dependency_wait_timeout_ms: 8_000,
		agents: [loopPlan.agents[0], { ...review, task_timeout_ms: 2_000 }, publish],
	});
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Ready for timed review"));
	await reviewer.deliverNotification(builder);
	t.mock.timers.tick(2_000);
	await reviewer.hooks.get("agent_settled")!({ aborted: true });
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a1-n1 .*Ready for timed review.*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Task duration deadline exceeded.*\[execution cancelled\].*attempt 1\/3, finalized/);
	assert.match(states(f), /a3-publish .*Task duration deadline exceeded.*\[execution blocked/);
	assert.match(statusText(f), /Run outcome: blocked \(.*1 cancelled.*\)/);
	assert.match(await reportText(f), /publish.*blocked.*Task duration deadline exceeded/);
});

test("cancel, force-close and recovery inspect isolate a corrupt revision claim", async t => {
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish, {
		node_id: "announce", persona: "publisher", sub_task: "Announce the publication",
	}] });
	await rejectFirstBuild(f);
	const claim = join(f.run.session_dir, "a1-n1.2.from-a2-n2.handoff.json");
	atomicJson(claim, { version: 99 });
	assert.match(states(f), /a1-n1 .*Unsupported handoff acceptance version 99/);
	atomicJson(join(f.run.session_dir, "a2-n2.finalize.json"), { version: 99 });

	const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.match(recovery, /Record error: n1.*Unsupported handoff acceptance version 99/);
	assert.match(recovery, /Record error: n2.*Invalid or unsupported finalization record/);
	assert.match(recovery, /publish → announce: source_unfinished \[wait\]/);

	const cancel = (force_close: boolean) => f.service.cancel(f.run.task_id, {
		agents: ["n1", "publish"], reason: "Cancel publication", grace_ms: 0, force_close,
	}).then(formatCancelResult);
	const requested = await cancel(false);
	assert.match(requested, /Record errors: n1.*Unsupported handoff acceptance version 99/);
	assert.match(requested, /Cancelled: publish/);
	assert.match(states(f), /a4-announce .*Cancel publication.*\[execution blocked/);

	const closed = await cancel(true);
	assert.match(closed, /Record errors: n1.*Unsupported handoff acceptance version 99/);
	assert.match(closed, /Force-closed owned resources: publish/);
	assert.match(states(f), /a1-n1 .*Unsupported handoff acceptance version 99/);
});

test("the outside successor waits for a first review's fail-fast cancellation and then blocks", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...loopPlan, failure_policy: "fail_fast", dependency_wait_timeout_ms: 8_000,
		agents: [...loopPlan.agents, publish],
	});
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Ready for review before fail-fast"));
	await reviewer.deliverNotification(builder);
	publishFailFast({
		sessionDir: f.run.session_dir, taskId: f.run.task_id, token: f.run.token,
		cause: { instance_id: builder.config.instance_id, node_id: "n1", state: "failed", reason: "A fail-fast failure was detected" },
	});
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a3-publish .*\[execution waiting\]/);
	await reviewer.hooks.get("agent_settled")!({ aborted: true });
	t.mock.timers.tick(1_000);
	assert.match(states(f), /a1-n1 .*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Cancelled by fail-fast policy.*\[execution cancelled.*attempt 1\/3, finalized/);
	assert.match(statusText(f), /Run outcome: blocked/);
	assert.match(await reportText(f), /publish.*blocked.*Cancelled by fail-fast policy/);
});

test("a recorded cancellation settles the first review even when its worker has exited", async t => {
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Ready for review before cancellation"));
	await reviewer.deliverNotification(builder);
	reviewer.vanish();
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "Stop the exited reviewer" });
	assert.match(states(f), /a1-n1 .*attempt 1\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Stop the exited reviewer.*\[execution cancelled\].*attempt 1\/3, finalized/);
	assert.match(states(f), /a3-publish .*Stop the exited reviewer.*\[execution blocked/);
	assert.match(await reportText(f), /publish.*blocked.*Stop the exited reviewer/);
});

test("duplicate revision notifications after parking and while running execute the builder once", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	const duplicate = await Promise.all([builder.deliverNotification(reviewer), builder.deliverNotification(reviewer)]);
	assert.equal(duplicate.filter(Boolean).length, 1);
	await builder.complete(complete("Revised once"));
	assert.match(states(f), /a1-n1 .*Revised once.*attempt 2\/3, parked/);
	// A late duplicate of the attempt-2 notification arriving after attempt 2 is parked is ignored harmlessly.
	const lateReplay = await builder.deliverNotification(reviewer);
	assert.equal(lateReplay, undefined);
	assert.match(states(f), /a1-n1 .*Revised once.*attempt 2\/3, parked/);
	assert.equal(f.status().worker_errors.length, 0);
});

test("a parked agent that dies leaves its results valid, marks the feedback edge dead, and sets the reviewer to needs_attention", async t => {
	const failIfVanished = (fRef: { nodes: Map<string, { config: { instance_id: string } }> }) => ({
		executeTool: async (_id: string, name: string, params: Record<string, unknown>) => {
			if (name === "coms_send" && String(params.target ?? "") === "a1-n1") {
				return { isError: true, content: [{ type: "text", text: "Connection refused: a1-n1 exited" }] };
			}
			void fRef;
			return { isError: false, content: [] };
		},
	});
	const fRef: { nodes: Map<string, { config: { instance_id: string } }> } = { nodes: new Map() };
	const f = await runFixture(t, loopPlan, new Map([["n2", failIfVanished(fRef)]]));
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Saved before dying"));
	builder.vanish();
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Needs revision from dead builder", "revise"));
	const status = f.status();
	assert.equal(status.outcome.state, "needs_attention");
	assert.equal(status.outcome.terminal, false);
	assert.equal(status.outcome.counts.succeeded, 1);
	assert.equal(status.delivery_errors.length, 0);
	const builderState = status.agents.find(a => a.node_id === "n1")!;
	const reviewerState = status.agents.find(a => a.node_id === "n2")!;
	assert.equal(builderState.execution, "succeeded");
	assert.equal(builderState.edge_states?.n2, "dead");
	assert.equal(reviewerState.execution, "needs_attention");
	assert.match(statusText(f), /Feedback edge to n1 is dead/);
	assert.equal(status.results.find(r => r.node_id === "n1")?.summary, "Saved before dying");
	const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.doesNotMatch(recovery, /retry_delivery/);
});

test("in a 3-node loop body, a dead intermediate parked agent stops the feedback target from running attempt 2", async t => {
	const midPlan = {
		...loopPlan,
		agents: [
			chain.agents[0],
			{ node_id: "mid", persona: "second", sub_task: "Intermediate step" },
			{ ...review, decision: { ...review.decision, on_reject: "n1" } },
		],
	};
	const f = await runFixture(t, midPlan);
	const builder = f.nodes.get("n1")!;
	const mid = f.nodes.get("mid")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Builder 1"));
	await mid.deliverNotification(builder);
	await mid.complete(complete("Mid 1"));
	await reviewer.deliverNotification(mid);
	await reviewer.complete(complete("Revise because mid died", "revise"));
	// Mid dies after the reviewer already sent the feedback notification; builder must still refuse attempt 2.
	mid.vanish();
	assert.equal(await builder.deliverNotification(reviewer), undefined);
	const status = f.status();
	assert.equal(status.outcome.state, "needs_attention");
	assert.equal(status.outcome.terminal, false);
	assert.equal(status.outcome.counts.succeeded, 2);
	assert.equal(status.outcome.counts.waiting, 0);
	assert.deepEqual(status.pending, ["n2"]);
	assert.deepEqual(status.agents.map(agent => agent.parked), [false, false, false]);
	assert.equal(status.agents.find(a => a.node_id === "n1")?.attempt_id, "a1-n1.1");
	assert.equal(status.agents.find(a => a.node_id === "n1")?.edge_states?.n2, "dead");
	assert.equal(status.agents.find(a => a.node_id === "n2")?.execution, "needs_attention");
	const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.doesNotMatch(recovery, /retry_delivery/);
});

test("a parked agent's shutdown hook records no failure and preserves its result", async t => {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	await builder.complete(complete("Saved before shutdown"));
	await builder.hooks.get("session_shutdown")!({ reason: "exit" });
	const status = f.status();
	assert.equal(status.worker_errors.length, 0);
	assert.match(states(f), /a1-n1 .*Saved before shutdown.*attempt 1\/3, parked/);
});

test("finalize and revision claim race to one winner in both orders, refuse while running, and finalize is idempotent", async t => {
	// Order 1a: finalize before delivery -> idempotent on repeat, invalid author refused, and late revision is rejected as "node finalized" in status().
	const f1 = await runFixture(t, loopPlan);
	const b1 = f1.nodes.get("n1")!;
	const r1 = f1.nodes.get("n2")!;
	const loop1 = f1.run.review_plan!.loops[0];
	assert.throws(() => finalizeReview(f1.run.session_dir, f1.run.task_id, loop1, 1, undefined, "n2"), /Invalid finalization author/);
	assert.throws(() => finalizeReview(f1.run.session_dir, f1.run.task_id, loop1, 1, undefined, "dispatcher"), /still running/);
	await b1.complete(complete("Build 1"));
	await r1.deliverNotification(b1);
	await r1.complete(complete("Revise 1", "revise"));
	finalizeReview(f1.run.session_dir, f1.run.task_id, loop1, 1, undefined, "dispatcher");
	finalizeReview(f1.run.session_dir, f1.run.task_id, loop1, 1, undefined, "dispatcher");
	assert.equal(await b1.deliverNotification(r1), undefined);
	assert.match(states(f1), /a1-n1 .*Build 1.*attempt 1\/3, finalized/);
	const revHandoff1 = f1.status().agents.find(a => a.node_id === "n1")?.handoff;
	assert.ok(revHandoff1?.rejections.some(rej => rej.reason === "node finalized"));

	// Order 1b: finalize wins *after* the early readFinalization check so claimRevisionTransition itself loses the race.
	const f1b = await runFixture(t, loopPlan);
	const { builder: b1b, reviewer: r1b } = await rejectFirstBuild(f1b);
	const loop1b = f1b.run.review_plan!.loops[0];
	const origRead = fs.readFileSync;
	let raced = false;
	fs.readFileSync = ((path, ...args) => {
		const res = Reflect.apply(origRead, fs, [path, ...args]);
		if (!raced && String(path).includes("a1-n1.2.from-a2-n2.handoff-offer.json")) {
			raced = true;
			finalizeReview(f1b.run.session_dir, f1b.run.task_id, loop1b, 1, undefined, "dispatcher");
		}
		return res;
	}) as typeof fs.readFileSync;
	syncBuiltinESMExports();
	try { assert.equal(await b1b.deliverNotification(r1b), undefined); }
	finally { fs.readFileSync = origRead; syncBuiltinESMExports(); }
	assert.equal(raced, true);
	assert.match(states(f1b), /a1-n1 .*Original build.*attempt 1\/3, finalized/);
	const revHandoff1b = f1b.status().agents.find(a => a.node_id === "n1")?.handoff;
	assert.ok(revHandoff1b?.rejections.some(rej => rej.reason === "node finalized"));

	// Order 2: revision claim wins -> finalize is refused while attempt 2 runs.
	const f2 = await runFixture(t, loopPlan);
	const { builder: b2 } = await rejectFirstBuild(f2);
	const loop2 = f2.run.review_plan!.loops[0];
	await b2.deliverNotification(f2.nodes.get("n2")!);
	assert.throws(() => finalizeReview(f2.run.session_dir, f2.run.task_id, loop2, 1, undefined, "dispatcher"), /revision attempt 2 is running/);
	assert.equal(f2.status().agents.find(a => a.node_id === "n1")?.finalized, undefined);

	// Corrupt/unsupported transition record fails closed in status() and recover().
	atomicJson(join(f2.run.session_dir, "a1-n1.1.transition.json"), { version: 99 });
	assert.match(states(f2), /Invalid or unsupported loop transition record/);
	const recovery = formatRecovery(await f2.service.recover(f2.run.task_id, { action: "inspect" }));
	assert.match(recovery, /Record error: n1.*Invalid or unsupported loop transition record/);
});

test("a crash between transition.json and finalize.json still counts as finalized in status and recover", async t => {
	const f = await runFixture(t, loopPlan);
	await rejectFirstBuild(f);
	atomicJson(join(f.run.session_dir, "a1-n1.1.transition.json"), {
		version: 1, run_id: f.run.task_id, instance_id: "a1-n1", from_attempt: 1, winner: "finalized",
	});
	assert.match(states(f), /a1-n1 .*Original build.*attempt 1\/3, finalized/);
	const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.doesNotMatch(recovery, /retry_delivery/);
});

test("cancelling or fail-fasting a downstream loop member while an upstream member runs settles without error", async t => {
	// 1. Selective cancel of n2 while n1 is still working on attempt 1.
	const f1 = await runFixture(t, loopPlan);
	const cancelSel = await f1.service.cancel(f1.run.task_id, { agents: ["n2"], reason: "Cancel reviewer only", grace_ms: 0 });
	assert.equal(cancelSel.record_errors?.length ?? 0, 0);
	assert.equal(f1.status().worker_errors.length, 0);
	assert.match(states(f1), /a2-n2 .*\[execution cancelled\]/);

	// 2. Whole-run cancel while n1 is still working on attempt 1.
	const f2 = await runFixture(t, loopPlan);
	const cancelRun = await f2.service.cancel(f2.run.task_id, { reason: "Stop whole run", grace_ms: 0 });
	assert.equal(cancelRun.record_errors?.length ?? 0, 0);
	assert.equal(f2.status().worker_errors.length, 0);
	assert.match(states(f2), /a2-n2 .*\[execution cancelled\]/);

	// 3. Fail-fast while n1 is working on attempt 1.
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f3 = await runFixture(t, { ...loopPlan, failure_policy: "fail_fast" });
	const r3 = f3.nodes.get("n2")!;
	publishFailFast({
		sessionDir: f3.run.session_dir, taskId: f3.run.task_id, token: f3.run.token,
		cause: { instance_id: "a0-other", node_id: "other", state: "failed", reason: "Upstream fail-fast" },
	});
	t.mock.timers.tick(1_000);
	await r3.hooks.get("agent_settled")!({ aborted: true });
	assert.equal(f3.status().worker_errors.length, 0);
	assert.match(states(f3), /a2-n2 .*\[execution cancelled/);

	// 4. Wake during run cancel on attempt 2 while builder runs attempt 2.
	const f4 = await runFixture(t, loopPlan);
	const { builder: b4, reviewer: r4 } = await rejectFirstBuild(f4);
	await b4.deliverNotification(r4);
	const cancelAttempt2 = await f4.service.cancel(f4.run.task_id, { reason: "Cancel on attempt 2", grace_ms: 0 });
	assert.equal(cancelAttempt2.record_errors?.length ?? 0, 0);
	await r4.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", content: "wake" } });
	assert.equal(f4.status().worker_errors.length, 0);
	assert.match(states(f4), /a2-n2 .*\[execution cancelled\]/);
});

test("a revised build failure settles immediately after the parked reviewer tab closes", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await reviewer.closeTab();
	await builder.complete({ status: "failure", summary: "The revised build cannot compile", detail: "Compilation failed" });

	const status = f.status();
	assert.deepEqual(status.agents.map(agent => agent.execution), ["failed", "blocked", "blocked"]);
	assert.deepEqual(status.agents.slice(0, 2).map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	assert.equal(status.agents[2].edge_states?.n2, "dead");
	assert.deepEqual(status.pending, []);
	assert.equal(status.outcome.terminal, true);
	assert.match(await reportText(f), /publish.*blocked.*revised build cannot compile/);
	const explicit = await f.service.report(f.run.task_id, status.results, false, buildMarkdownReport);
	const publication = explicit.results.find(result => result.node_id === "publish");
	assert.equal(publication?.execution_state, "blocked");
	assert.deepEqual(publication?.causes?.map(cause => cause.node_id), ["n2", "n1"]);
});

test("fail-fast cancels a running revision and closes its forward edge", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, failure_policy: "fail_fast", agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	publishFailFast({
		sessionDir: f.run.session_dir, taskId: f.run.task_id, token: f.run.token,
		cause: { instance_id: builder.config.instance_id, node_id: "n1", state: "failed", reason: "Build failure was detected" },
	});

	t.mock.timers.tick(500);
	assert.equal(f.status().agents[1].cancelling, true);
	await reviewer.hooks.get("agent_settled")!({ aborted: true });
	assert.match(states(f), /a2-n2 .*Cancelled by fail-fast policy.*execution cancelled.*attempt 2\/3, finalized/);
	assert.equal(f.status().outcome.terminal, true);
	assert.match(await reportText(f), /publish.*blocked.*Build failure was detected/);
});

test("revision deadline finalization is attributed to the reviewer", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [{ ...loopPlan.agents[0], task_timeout_ms: 2_000 }, review, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(2_000);
	await builder.hooks.get("agent_settled")!({ aborted: true });

	const status = f.status();
	assert.deepEqual(status.agents.map(agent => agent.execution), ["cancelled", "blocked", "blocked"]);
	assert.deepEqual(status.agents.slice(0, 2).map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	assert.equal(status.outcome.terminal, true);
	assert.match(await reportText(f), /publish.*blocked.*Task duration deadline exceeded/);
});

for (const staleCheck of [false, true]) {
	test(`a revision blocked by ${staleCheck ? "a stale required check" : "a partial build"} is finalized by the reviewer`, async t => {
		const mid = { node_id: "mid", persona: "middle", sub_task: "Inspect the build" };
		const first = { ...loopPlan.agents[0], ...(staleCheck ? { required_checks: ["tests"] } : {}) };
		const f = await runFixture(t, { ...loopPlan, agents: [first, mid, review, publish] });
		const builder = f.nodes.get("n1")!;
		const middle = f.nodes.get("mid")!;
		const reviewer = f.nodes.get("n2")!;
		const checkFile = join(f.cwd, "checked.txt");
		fs.writeFileSync(checkFile, "before");
		const passCheck = async () => {
			if (!staleCheck) return;
			await builder.verify({ action: "start", check_id: "tests", scope: ["checked.txt"] });
			await builder.verify({ action: "finish", check_id: "tests", result: "pass" });
		};

		await passCheck();
		await builder.complete(complete("First build"));
		await middle.deliverNotification(builder);
		await middle.complete(complete("First inspection"));
		await reviewer.deliverNotification(middle);
		await reviewer.complete(complete("Revise build", "revise"));
		await builder.deliverNotification(reviewer);
		await passCheck();
		await builder.complete({ ...complete("Revised build"), status: staleCheck ? "success" : "partial" });
		if (staleCheck) fs.writeFileSync(checkFile, "after");
		await middle.deliverNotification(builder);

		const status = f.status();
		assert.deepEqual(status.agents.map(agent => agent.execution), [staleCheck ? "succeeded" : "partial", "blocked", "blocked", "blocked"]);
		assert.deepEqual(status.agents.slice(0, 3).map(agent => agent.finalized_by), ["a3-n2", "a3-n2", "a3-n2"]);
		assert.equal(status.outcome.terminal, true);
		assert.match(await reportText(f), staleCheck ? /publish.*blocked.*tests.*stale/ : /publish.*blocked.*partial result/);
	});
}

for (const pending of [false, true]) {
	test(`reload retries a ${pending ? "pending" : "failed"} review delivery from its saved result`, async t => {
		const enteredSend = Promise.withResolvers<void>();
		// The interrupted process never receives a transport response.
		const interruptedSend = new Promise<never>(() => {});
		let firstSend = true;
		const f = await runFixture(t, loopPlan, new Map([["n2", {
			executeTool: async () => {
				if (!firstSend) return { content: [], details: { msg_id: "retried" } };
				firstSend = false;
				enteredSend.resolve();
				if (pending) return interruptedSend;
				return { isError: true, content: [{ type: "text", text: "Temporary transport failure" }] };
			},
		}]]));
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(complete("First build"));
		await reviewer.deliverNotification(builder);
		const original = reviewer.complete(complete("Durable rejection", "revise"));
		if (pending) await enteredSend.promise;
		else await original;
		assert.equal(f.status().agents[1].delivery, pending ? "pending" : "failed");

		const reloaded = await f.reload("n2");
		await reloaded.complete(complete("Do not replace the saved verdict", "approve"));
		assert.match(states(f), /n2 .*Durable rejection.*attempt 1\/3, parked/);
		await builder.deliverNotification(reloaded);
		assert.match(states(f), /n1 .*execution running.*attempt 2\/3/);
	});
}

test("failed exhaustion publishes fail-fast with the review's exhaustion cause", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const decision = { ...review, decision: { ...review.decision, max_revisions: 1, on_exhausted: "failed" as const } };
	const tail = { node_id: "announce", persona: "announcer", sub_task: "Announce the publication" };
	const f = await runFixture(t, { ...loopPlan, failure_policy: "fail_fast", agents: [loopPlan.agents[0], decision, publish, tail] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Still rejected", "revise"));

	t.mock.timers.tick(500);
	assert.match(states(f), /announce .*Cancelled by fail-fast policy after n2.*Review loop exhausted its revision limit/);
	assert.match(await reportText(f), /publish.*blocked.*Review loop exhausted its revision limit/);
});

for (const exhaustedState of ["failed", "needs_attention"] as const) {
	test(`reports show ${exhaustedState} exhaustion with explicit or collected results`, async t => {
		const decision = { ...review, decision: { ...review.decision, max_revisions: 1, on_exhausted: exhaustedState } };
		const f = await runFixture(t, { ...loopPlan, max_total_attempts: 2, agents: [loopPlan.agents[0], decision] });
		await rejectFirstBuild(f);

		const durableResults = f.status().results;
		const explicit = durableResults.map(result => result.node_id === "n2" && exhaustedState === "failed"
			? { ...result, status: "failure" as const }
			: result);
		for (const supplied of [undefined, explicit]) {
			const { results, report_md } = await f.service.report(f.run.task_id, supplied, true, buildMarkdownReport);
			const reviewer = results.find(result => result.node_id === "n2");
			assert.equal(reviewer?.execution_state, exhaustedState);
			assert.equal(reviewer && "execution_reason" in reviewer && reviewer.execution_reason, "Run attempt budget exhausted");
			const digest = formatReportDigest(results);
			assert.match(digest, exhaustedState === "failed" ? /1 success, 0 partial, 1 failure/ : /1 success, 0 partial, 0 failure, 1 needs attention/);
			assert.match(digest, /n2.*Revise build.*Run attempt budget exhausted/);
			assert.match(digest, new RegExp(`Run outcome: ${exhaustedState}`));
			const markdown = fs.readFileSync(report_md!, "utf8");
			const decisionStatus = exhaustedState === "failed" ? "failure" : "needs_attention";
			assert.match(markdown, new RegExp("### [^\\n]+ n2[^\\n]*\\nStatus: " + decisionStatus));
			assert.match(markdown, /Execution reason: Run attempt budget exhausted/);
			assert.match(markdown, /Loop ended: Run attempt budget exhausted/);
		}
	});
}

test("dispatcher finalization of a rejection blocks the outside successor without exhaustion", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, dependency_wait_timeout_ms: 2_000, agents: [...loopPlan.agents, publish] });
	await rejectFirstBuild(f);
	finalizeReview(f.run.session_dir, f.run.task_id, f.run.review_plan!.loops[0], 1, undefined, "dispatcher");

	assert.equal(f.status().agents[1].finalized_by, "dispatcher");
	assert.equal(f.status().agents[2].edge_states?.n2, "dead");
	assert.equal(f.status().agents[2].execution, "blocked");
	t.mock.timers.tick(3_000);
	await f.nodes.get("publish")!.closeTab();
	assert.equal(f.status().agents[2].execution, "blocked");
	assert.equal(f.status().outcome.terminal, true);
	assert.match(await reportText(f), /publish.*blocked.*n2 rejected the work/);
});

for (const legacy of [false, true]) {
	test(`an exhausted decision survives \${legacy ? "a legacy transition-only record" : "interrupted member finalization"}`, async t => {
		const decision = { ...review, decision: { ...review.decision, max_revisions: 1, on_exhausted: "failed" as const } };
		const f = await runFixture(t, { ...loopPlan, agents: [loopPlan.agents[0], decision],
			...(legacy ? { max_total_attempts: 2 } : {}) });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		if (legacy) {
			await rejectFirstBuild(f);
			// Recreate the v1 crash window from workers that published the transition first.
			fs.rmSync(join(f.run.session_dir, "a2-n2.finalize.json"));
		} else {
			await rejectFirstBuild(f);
			await builder.deliverNotification(reviewer);
			await builder.complete(complete("Build 2"));
			await reviewer.deliverNotification(builder);

			const original = fs.linkSync;
			fs.linkSync = ((from, to) => {
				if (String(to).endsWith("a1-n1.2.transition.json")) throw new Error("Interrupted after committing the review decision");
				return original(from, to);
			}) as typeof fs.linkSync;
			syncBuiltinESMExports();
			try { await reviewer.complete(complete("Still rejected", "revise")); }
			finally { fs.linkSync = original; syncBuiltinESMExports(); }
		}
		reviewer.vanish();

		const status = f.status();
		const reason = legacy ? /Run attempt budget exhausted/ : /Review loop exhausted its revision limit/;
		assert.equal(status.outcome.state, "failed");
		assert.equal(status.outcome.terminal, true);
		assert.deepEqual(status.agents.map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
		assert.equal(status.agents[1].execution, "failed");
		assert.match(status.agents[1].execution_reason!, reason);
		assert.match(await reportText(f), /1 success, 0 partial, 1 failure/);
		assert.match(await reportText(f), reason);
	});
}

test("a dispatcher-finalized rejection fails the run even when the decision has no successor", async t => {
	const f = await runFixture(t, loopPlan);
	await rejectFirstBuild(f);
	assert.equal(f.status().agents[1].execution, "waiting");
	finalizeReview(f.run.session_dir, f.run.task_id, f.run.review_plan!.loops[0], 1, undefined, "dispatcher");
	const status = f.status();
	assert.equal(status.agents[1].execution, "failed");
	assert.equal(status.agents[1].finalized_by, "dispatcher");
	assert.equal(status.outcome.state, "failed");
	assert.equal(status.outcome.terminal, true);
	assert.match(await reportText(f), /1 success, 0 partial, 1 failure/);
	assert.match(await reportText(f), /n2.*failure.*rejected the work/);
});

test("a running builder can finish and finalize after its reviewer was cancelled", async t => {
	const f = await runFixture(t, loopPlan);
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "Stop the reviewer", grace_ms: 0 });
	assert.deepEqual(f.status().agents.map(agent => agent.execution), ["running", "cancelled"]);

	await f.nodes.get("n1")!.complete(complete("Finished after reviewer cancellation"));
	const status = f.status();
	assert.deepEqual(status.agents.map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	assert.deepEqual(status.pending, []);
	assert.equal(status.outcome.state, "cancelled");
	assert.equal(status.outcome.terminal, true);
	assert.match(await reportText(f), /1 success.*1 cancelled/);
});

test("force finalization cannot split an attempt and retries for older attempts are idempotent", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	const { session_dir, task_id, review_plan } = f.run;
	const loop = review_plan!.loops[0];
	finalizeReview(session_dir, task_id, loop, 1, undefined, "dispatcher", { force: true });
	assert.deepEqual(f.status().agents.map(agent => agent.finalized), [undefined, undefined]);

	await builder.complete({ status: "failure", summary: "Revision broke", detail: "Failed" });
	const settled = f.status();
	assert.deepEqual(settled.agents.map(agent => agent.attempt_id), ["a1-n1.2", "a2-n2.2"]);
	assert.deepEqual(settled.agents.map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
	assert.deepEqual(settled.worker_errors, []);
	assert.equal(settled.outcome.terminal, true);

	finalizeReview(session_dir, task_id, loop, 1, undefined, "dispatcher");
	finalizeReview(session_dir, task_id, loop, 1, undefined, "dispatcher", { force: true });
	finalizeReview(session_dir, task_id, loop, 2, undefined, "dispatcher");
	assert.deepEqual(f.status().agents.map(agent => [agent.attempt_id, agent.finalized_by]),
		settled.agents.map(agent => [agent.attempt_id, agent.finalized_by]));
	assert.match(await reportText(f), /n2.*blocked.*Revision broke/);
});

for (const staleCheck of [false, true]) {
	test(`a \${staleCheck ? "stale required check" : "partial build"} settles a revision with an exited reviewer`, async t => {
		const first = { ...loopPlan.agents[0], ...(staleCheck ? { required_checks: ["tests"] } : {}) };
		const f = await runFixture(t, { ...loopPlan, agents: [first, review, publish] });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		const checked = join(f.cwd, "checked.txt");
		fs.writeFileSync(checked, "before");
		const passCheck = async () => {
			if (!staleCheck) return;
			await builder.verify({ action: "start", check_id: "tests", scope: ["checked.txt"] });
			await builder.verify({ action: "finish", check_id: "tests", result: "pass" });
		};
		await passCheck();
		await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		await reviewer.closeTab();
		await passCheck();

		const original = fs.renameSync;
		fs.renameSync = ((from, to) => {
			original(from, to);
			// Change the evidence after completion validates it and before it evaluates the next edge.
			if (staleCheck && String(to).endsWith("a1-n1.2.result.json")) fs.writeFileSync(checked, "after");
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		try { await builder.complete({ ...complete("Build 2"), status: staleCheck ? "success" : "partial" }); }
		finally { fs.renameSync = original; syncBuiltinESMExports(); }

		const status = f.status();
		assert.equal(status.outcome.terminal, true);
		assert.deepEqual(status.agents.map(agent => agent.execution), [staleCheck ? "succeeded" : "partial", "blocked", "blocked"]);
		assert.deepEqual(status.agents.slice(0, 2).map(agent => agent.finalized_by), ["a2-n2", "a2-n2"]);
		assert.match(await reportText(f), staleCheck ? /publish.*tests.*stale/ : /publish.*partial result/);
	});
}

test("a revision blocked at admission updates the reviewer's progress and stops its timers", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [{ ...loopPlan.agents[0], required_checks: ["tests"] }, review] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const checked = join(f.cwd, "checked.txt");
	fs.writeFileSync(checked, "before");
	const passCheck = async () => {
		await builder.verify({ action: "start", check_id: "tests", scope: ["checked.txt"] });
		await builder.verify({ action: "finish", check_id: "tests", result: "pass" });
	};
	await passCheck();
	await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await passCheck();
	await builder.complete(complete("Revised build"));
	fs.writeFileSync(checked, "changed after delivery");
	await reviewer.deliverNotification(builder);

	const reviewState = () => f.status().agents[1];
	assert.equal(reviewState().execution, "blocked");
	assert.equal(reviewState().attempt_id, "a2-n2.2");
	assert.equal(reviewState().heartbeat_age_ms, 0);
	t.mock.timers.tick(10_000);
	assert.equal(reviewState().heartbeat_age_ms, 10_000);
	assert.match(await reportText(f), /n2.*blocked.*tests.*stale/);
});

test("a revision can deliver a partial build to a reviewer that allows it", async t => {
	const f = await runFixture(t, { ...loopPlan, agents: [loopPlan.agents[0], { ...review, dependency_policy: "allow_partial" }] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete({ ...complete("Partial build 2"), status: "partial" });
	await reviewer.deliverNotification(builder);
	assert.equal(f.status().agents[1].execution, "running");
	await reviewer.complete(complete("Approved partial build", "approve"));
	assert.equal(f.status().outcome.state, "partial");
	assert.equal(f.status().outcome.terminal, true);
});

test("a three-node loop shows the current outbound handoff and keeps its attempt and verdict history", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = { ...loopPlan, agents: [loopPlan.agents[0], {
		node_id: "tester", persona: "publisher", sub_task: "Test the build",
	}, review] };
	const f = await runFixture(t, plan);
	const builder = f.nodes.get("n1")!;
	const tester = f.nodes.get("tester")!;
	const reviewer = f.nodes.get("n2")!;
	let render!: (width: number) => string[];
	const widgets = createGraphWidgets(() => f.status());
	t.after(() => widgets.clear());
	widgets.attach(f.run.task_id, {
		hasUI: true, cwd: f.cwd,
		ui: { setWidget(_key: string, factory?: Function) {
			if (factory) render = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }).render;
		} },
	} as Parameters<typeof widgets.attach>[1]);
	const frame = () => render(120).join("\n").replace(f.run.task_id, "review-run");
	assert.match(formatPlan(f.service.plan({ ...plan, project_cwd: f.cwd }, model)), /↺ 1\/3\s+↺ 1\/3\s+↺ 1\/3/);
	await builder.complete(complete("Build one"));
	await tester.deliverNotification(builder);
	const oldHandoff = states(f).match(/a1-n1 .*handoff out (\S+) accepted/)?.[1];
	assert.ok(oldHandoff);
	await tester.complete(complete("Test one"));
	await reviewer.deliverNotification(tester);
	await reviewer.complete(complete("Needs coverage", "revise"));
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build two"));

	const builderLine = states(f).split("\n")[0];
	assert.match(builderLine, /handoff out \S+ queued.*attempt 2\/3, parked.*last verdict: revise/);
	assert.ok(!builderLine.includes(oldHandoff));
	t.mock.timers.tick(2_000);
	assert.equal(frame(), [
		"● run review-run · chain · 3 nodes · incomplete · 00:02",
		"⏸ n1       ──▶ ⏸ tester   ──▶ ⏸ n2",
		"↺ 2/3 (revise) ↺ 1/3 (revise) ↺ 1/3 (revise)",
		"3 pending · 0 errors · bootstrap_status",
	].join("\n"));

	await tester.deliverNotification(builder);
	await tester.complete(complete("Test two"));
	await reviewer.deliverNotification(tester);
	assert.match(states(f), /a3-n2 .*attempt 2\/3.*last verdict: revise/);
	await reviewer.complete(complete("Coverage approved", "approve"));
	assert.match(states(f), /a3-n2 .*attempt 2\/3, finalized.*last verdict: approve/);
	const paths = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
	const digest = formatReportDigest(readJson<ReportEntry[]>(paths.report_json));
	for (const summary of ["Build one", "Build two", "Test one", "Test two", "Needs coverage", "Coverage approved"]) {
		assert.ok(digest.includes(summary));
	}
	assert.match(digest, /Verdict history: 1\/3 revise → 2\/3 approve/);
	assert.match(digest, /Loop ended: approved/);
	assert.match(fs.readFileSync(paths.report_md!, "utf8"), /Verdict history: 1\/3 revise → 2\/3 approve/);
});

for (const cleanup of ["on_success", "manual"] as const) {
	test(`the loop widget retains the final frame with ${cleanup} cleanup`, async t => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const f = await runFixture(t, { ...loopPlan, cleanup });
		let render!: (width: number) => string[];
		let redraws = 0;
		const widgets = createGraphWidgets((taskId, cwd, onCleaned) => f.service.statusWithCleanup(taskId, cwd, onCleaned));
		t.after(() => widgets.reset());
		const attach = () => widgets.attach(f.run.task_id, {
			hasUI: true, cwd: f.cwd,
			ui: { setWidget(_key: string, factory?: Function) {
				if (factory) render = factory({ requestRender() { redraws++; } }, { fg: (_color: string, text: string) => text }).render;
			} },
		} as Parameters<typeof widgets.attach>[1]);
		await attach();
		const frame = () => render(120).join("\n");
		assert.match(frame(), /incomplete .*00:00/);
		assert.match(frame(), /● n1/);

		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(complete("Ready for review"));
		await reviewer.deliverNotification(builder);
		await reviewer.complete(complete("Approved", "approve"));
		t.mock.timers.tick(2_000);
		assert.match(frame(), /succeeded · 00:00/);
		assert.doesNotMatch(frame(), /cleaned/);

		if (cleanup === "manual") {
			t.mock.timers.tick(2_000);
			assert.match(frame(), /succeeded · 00:00/);
			await f.service.cleanup(f.run.task_id, undefined, false, f.cwd);
			await attach();
		} else {
			t.mock.timers.tick(2_000);
			await new Promise<void>(resolve => setImmediate(resolve));
		}

		const cleaned = frame();
		if (cleanup === "on_success") {
			assert.match(cleaned, /✓ run .* succeeded · cleaned · 00:00/);
			assert.match(cleaned, /cleaned up automatically.*bootstrap_report/);
		} else {
			assert.match(cleaned, /✓ run .* nodes · cleaned · 00:00/);
			assert.doesNotMatch(cleaned, /cleaned up automatically/);
		}
		assert.match(cleaned, /✓ n1.*✓ n2/);
		assert.match(cleaned, /↺ 1\/3 \(approve\)\s+↺ 1\/3 \(approve\)/);
		const finalRedraws = redraws;
		t.mock.timers.tick(20_000);
		assert.equal(frame(), cleaned);
		assert.equal(redraws, finalRedraws);
	});
}

for (const state of ["waiting", "needs_attention", "interrupted finalization", "revision running"] as const) {
	test(`full manual cleanup finalizes parked nodes while the loop has ${state}`, async t => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		const f = await runFixture(t, { ...loopPlan, cleanup: state === "needs_attention" ? "on_success" : "manual" });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(complete("Saved build"));
		if (state !== "waiting") await reviewer.deliverNotification(builder);
		if (state === "needs_attention") {
			reviewer.vanish();
			assert.match(statusText(f), /Run outcome: needs_attention/);
		}
		if (state === "interrupted finalization") {
			await reviewer.complete(complete("Approved", "approve"));
			// Recreate the earlier transition-first publication order after an interruption.
			fs.rmSync(join(f.run.session_dir, "a2-n2.finalize.json"));
			fs.rmSync(join(f.run.session_dir, "a1-n1.finalize.json"));
			fs.rmSync(join(f.run.session_dir, "a1-n1.1.transition.json"));
		}
		if (state === "revision running") {
			await reviewer.complete(complete("Please revise", "revise"));
			await builder.deliverNotification(reviewer);
			assert.match(states(f), /a1-n1 .*execution running.*attempt 2\/3/);
			assert.match(states(f), /a2-n2 .*attempt 1\/3, parked/);
		} else {
			assert.match(states(f), /a1-n1 .*attempt 1\/3, parked/);
		}

		await f.service.cleanup(f.run.task_id);
		const cleaned = statusText(f);
		assert.doesNotMatch(states(f), /, parked\]/);
		if (state === "revision running") {
			assert.match(cleaned, /a1-n1 .*execution needs_attention.*attempt 2\/3\]/);
			assert.match(cleaned, /a2-n2 .*attempt 1\/3, finalized/);
		} else {
			assert.match(cleaned, /a1-n1 .*closed.*Saved build.*attempt 1\/3, finalized/);
			if (state === "interrupted finalization") {
				assert.match(await reportText(f), /Attempt 1\/3: succeeded — Saved build/);
			} else {
				await assert.rejects(f.report(), /Pending: n2\. Delivery errors: none/);
			}
		}
		await f.service.cleanup(f.run.task_id);
		assert.equal(statusText(f), cleaned);
	});
}

test("the report renderer still reads a pre-history review report", () => {
	const previousReport: ReportEntry[] = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/previous-review-report.json", import.meta.url), "utf8"));
	assert.equal(formatReportDigest(previousReport), [
		"2 success, 0 partial, 0 failure.",
		"Run outcome: succeeded.",
		"- n1 (persona first): success — Revised build",
		"- n2 (persona second): success — Approved revised build",
	].join("\n"));
});
