import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { ownershipPath, publishFailFast } from "./ownership.ts";
import { claimOutcome, outcomeClaimPath, writeCancelRecord } from "./cancellation.ts";
import { createGraphWidgets } from "./graph-widget.ts";
import { handoffClaimPath } from "./handoff.ts";
import { claimRevisionTransition, finalizeReview, readFinalization, readLoopTransition, reserveRevision, reviewRoutes } from "./review-loop.ts";
import { atomicJson, dispositionPath, dispositionRecord, readJson, resultPath, withRunLock, type ReportEntry, type WorkerCompletion } from "./session-store.ts";
import { buildMarkdownReport, formatAgentStates, formatCancelResult, formatPlan, formatRecovery, formatReportDigest, formatRunOutcome } from "./reporting.ts";
import { parseCompletion as readPreviousCompletion, parseWorkerConfig as readPreviousConfig, parseManifest as readPreviousManifest } from "./test-support/previous-v4-session-store.ts";
import { chain, model, runFixture, serviceFixture } from "./test-support/chain-fixture.ts";

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
	assert.match(cancellation, /Cancelled: n1/);
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

test("recovery pane fallback targets the current review-loop destination attempt", async t => {
	const f = await runFixture(t, loopPlan, new Map([["n2", { executeTool: async () => ({ isError: true, content: [] }) }]]));
	await rejectFirstBuild(f);
	let destinationAttempt: string | undefined;
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n1", source: "n2" }, {
		senderSession: "dispatcher-session",
		wake: async () => { throw new Error("coms: unreachable: destination socket missing"); },
		paneWake: async request => {
			destinationAttempt = request.destinationAttempt;
			return { outcome: "sent", pane_id: "pane-n1", handoff_id: request.handoffId, line: "wake" };
		},
	});
	assert.equal(destinationAttempt, "a1-n1.2");
	assert.equal(report.delivery?.transport, "pane_fallback");
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
	test(`an exhausted decision survives ${legacy ? "a legacy transition-only record" : "interrupted member finalization"}`, async t => {
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
	test(`a ${staleCheck ? "stale required check" : "partial build"} settles a revision with an exited reviewer`, async t => {
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
			assert.match(cleaned, /✓ run .* nodes · succeeded · cleaned · 00:00/);
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

test("a loop body holds write ownership until finalization, body nodes without write_paths hold nothing while parked, and overlapping writers wait", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...chain,
		agents: [
			{ ...chain.agents[0], write_paths: ["src/a.ts"] },
			review,
			{ node_id: "other", persona: "publisher", sub_task: "Edit src/a.ts after loop", write_paths: ["src/a.ts"] },
		],
	});
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;

	// Before n1 settles, other waits on ownership; reviewer has no write_paths so holds no ownership.
	assert.equal(f.status().agents[0].ownership_status, "admitted");
	assert.equal(f.status().agents[1].ownership_status, undefined);
	assert.equal(f.status().agents[2].ownership_status, "waiting");

	// Builder parks after attempt 1: still holds ownership, other still waits.
	await builder.complete(complete("Build 1"));
	assert.equal(f.status().agents[0].parked, true);
	assert.equal(f.status().agents[0].ownership_status, "admitted");
	assert.equal(f.status().agents[2].ownership_status, "waiting");

	// Reviewer rejects attempt 1 and parks: reviewer holds nothing while parked, other still waits.
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Reject 1", "revise"));
	assert.equal(f.status().agents[1].parked, true);
	assert.equal(f.status().agents[1].ownership_status, undefined);
	t.mock.timers.tick(2_000);
	assert.equal(f.status().agents[2].ownership_status, "waiting");

	// Attempt 2 approval finalizes the loop, releases ownership, and admits the overlapping writer.
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build 2"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved", "approve"));
	t.mock.timers.tick(2_000);
	const status = f.status();
	assert.deepEqual(status.worker_errors, []);
	assert.equal(status.agents[0].finalized, true);
	assert.equal(status.agents[0].ownership_status, "released");
	assert.equal(status.agents[2].ownership_status, "admitted");
	const other = f.nodes.get("other")!;
	await other.deliverNotification(reviewer);
	await other.complete(complete("Edited src/a.ts"));
	assert.equal(f.status().outcome.state, "succeeded");
	assert.equal(f.status().outcome.terminal, true);
	assert.match(await reportText(f), /n1.*success/);
});

test("required checks are judged per attempt, block unverified approval, and invalidate earlier evidence on revision", async t => {
	const f = await runFixture(t, {
		...loopPlan,
		agents: [{ ...loopPlan.agents[0], required_checks: ["tests"] }, review],
	});
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const checked = join(f.cwd, "checked.txt");
	fs.writeFileSync(checked, "v1");

	await builder.verify({ action: "start", check_id: "tests", scope: ["checked.txt"] });
	await builder.verify({ action: "finish", check_id: "tests", result: "pass" });
	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Needs fixes", "revise"));

	// Revision edits the checked file, invalidating attempt 1's evidence and requiring fresh attempt-2 evidence.
	await builder.deliverNotification(reviewer);
	fs.writeFileSync(checked, "v2");
	const missingCheck = await builder.complete(complete("Build 2 without check"));
	assert.equal(missingCheck.isError, true);
	assert.match(missingCheck.content.map(c => c.text).join("\n"), /Missing required verification check "tests"/);

	await builder.verify({ action: "start", check_id: "tests", scope: ["checked.txt"] });
	await builder.verify({ action: "finish", check_id: "tests", result: "pass" });
	await builder.complete(complete("Build 2 verified"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved", "approve"));
	const status = f.status();
	assert.deepEqual(status.worker_errors, []);
	assert.equal(status.outcome.state, "succeeded");
	assert.equal(status.outcome.terminal, true);
	assert.match(await reportText(f), /n2.*success/);
});

test("fail_fast published while a loop member is parked cancels the revision without starting a turn and finalizes the loop", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...loopPlan,
		failure_policy: "fail_fast",
		agents: [...loopPlan.agents, publish],
	});
	const { builder, reviewer } = await rejectFirstBuild(f);

	publishFailFast({
		sessionDir: f.run.session_dir,
		taskId: f.run.task_id,
		token: f.run.token,
		cause: { instance_id: "a0-other", node_id: "other", state: "failed", reason: "Sibling branch failed" },
	});

	const admittedTurn = await builder.deliverNotification(reviewer);
	assert.equal(admittedTurn, undefined);
	await builder.hooks.get("agent_settled")!({ aborted: true });

	const status = f.status();
	assert.equal(status.worker_errors.length, 0);
	assert.equal(status.outcome.state, "blocked");
	assert.equal(status.outcome.terminal, true);
	assert.match(states(f), /a1-n1 .*Cancelled by fail-fast policy.*\[execution cancelled.*finalized/);
	assert.match(states(f), /a2-n2 .*\[execution blocked.*finalized/);
});

test("fail_fast published while loop members are parked between attempts cancels parked agents on timer tick", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...loopPlan,
		failure_policy: "fail_fast",
		agents: [...loopPlan.agents, publish],
	});
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build 2"));

	publishFailFast({
		sessionDir: f.run.session_dir,
		taskId: f.run.task_id,
		token: f.run.token,
		cause: { instance_id: "a0-other", node_id: "other", state: "failed", reason: "Sibling branch failed" },
	});

	t.mock.timers.tick(2_000);
	const status = f.status();
	assert.equal(status.outcome.state, "blocked");
	assert.equal(status.outcome.terminal, true);
	assert.deepEqual(status.pending, []);
	assert.match(states(f), /a2-n2 .*Cancelled by fail-fast policy.*\[execution cancelled.*finalized/);
});

test("node cancel of a parked loop agent does not report already completed and prevents running the next attempt", async t => {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);

	const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "Cancel parked builder", grace_ms: 0 });
	const cancelText = formatCancelResult(cancelRes);
	assert.match(cancelText, /Cancelled: n1/);
	assert.doesNotMatch(cancelText, /Already completed \(preserved\): n1/);

	const rejRes = await reviewer.complete(complete("Reject 1", "revise"));
	assert.equal(rejRes.isError, true);

	const status = f.status();
	assert.deepEqual(status.worker_errors, []);
	assert.equal(status.outcome.state, "cancelled");
	assert.equal(status.outcome.terminal, true);
	assert.match(states(f), /a2-n2 .*Cancel parked builder.*\[execution cancelled.*finalized/);
});

test("whole-run cancel while loop agents are parked between attempts settles and finalizes the loop", async t => {
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build 2"));

	await f.service.cancel(f.run.task_id, { reason: "Cancel whole run", grace_ms: 0 });
	const status = f.status();
	assert.equal(status.outcome.state, "cancelled");
	assert.equal(status.outcome.terminal, true);
	assert.deepEqual(status.pending, []);
	assert.ok(status.agents.slice(0, 2).every(a => a.finalized));
});

test("a loop member already running when the reviewer is cancelled or fail-fasted finalizes itself and releases ownership when it finishes", async t => {
	// 1. Reviewer cancelled while builder is running attempt 1
	const f1 = await runFixture(t, {
		...loopPlan,
		agents: [{ ...loopPlan.agents[0], write_paths: ["src/a.ts"] }, review],
	});
	const b1 = f1.nodes.get("n1")!;
	await f1.service.cancel(f1.run.task_id, { agents: ["n2"], reason: "Cancel reviewer", grace_ms: 0 });
	await b1.complete(complete("Build 1 finished"));
	const s1 = f1.status();
	assert.equal(s1.outcome.terminal, true);
	assert.deepEqual(s1.pending, []);
	assert.equal(s1.agents[0].finalized, true);
	assert.equal(s1.agents[0].ownership_status, "released");

	// 2. Reviewer fail-fasted while builder is running attempt 1
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f2 = await runFixture(t, {
		...loopPlan,
		failure_policy: "fail_fast",
		agents: [{ ...loopPlan.agents[0], write_paths: ["src/a.ts"] }, review],
	});
	const b2 = f2.nodes.get("n1")!;
	const r2 = f2.nodes.get("n2")!;
	publishFailFast({
		sessionDir: f2.run.session_dir,
		taskId: f2.run.task_id,
		token: f2.run.token,
		cause: { instance_id: "a0-other", node_id: "other", state: "failed", reason: "Upstream fail-fast" },
	});
	t.mock.timers.tick(1_000);
	await r2.hooks.get("agent_settled")!({ aborted: true });
	await b2.complete(complete("Build 1 finished after fail-fast"));
	await b2.hooks.get("agent_settled")!({ aborted: true });
	const s2 = f2.status();
	assert.equal(s2.outcome.terminal, true);
	assert.deepEqual(s2.pending, []);
	assert.equal(s2.agents[0].finalized, true);
	assert.equal(s2.agents[0].ownership_status, "released");
});

test("task_timeout_ms applies per attempt in a loop", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, task_timeout_ms: 5_000 });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;

	// Attempt 1 takes 4,000ms (< 5,000ms).
	t.mock.timers.tick(4_000);
	assert.equal(f.status().agents[0].deadline_exceeded, false);
	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise 1", "revise"));

	// Attempt 2 starts fresh and takes 4,000ms (total 8,000ms > 5,000ms, but per-attempt < 5,000ms).
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(4_000);
	assert.equal(f.status().agents[0].deadline_exceeded, false);
	await builder.complete(complete("Build 2"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise 2", "revise"));

	// Attempt 3 exceeds 5,000ms on a single attempt -> times out.
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(5_500);
	assert.equal(f.status().agents[0].deadline_exceeded, true);
	await builder.hooks.get("agent_settled")!({ aborted: true });
	assert.match(states(f), /a1-n1 .*Task duration deadline exceeded \(5000ms\).*\[execution cancelled\]/);
});

test("parked loop agents are never diagnosed as stalled and an outside wait follows the decision node's progress", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...loopPlan,
		liveness_timeout_ms: 10_000,
		dependency_wait_timeout_ms: 15_000,
		agents: [...loopPlan.agents, publish],
	});
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;

	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);

	// Advance 20s (> liveness_timeout_ms and > dependency_wait_timeout_ms) while reviewer reports progress every 5s.
	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(5_000);
		await reviewer.hooks.get("tool_execution_start")!({});
	}

	const status = f.status();
	assert.equal(status.agents[0].parked, true);
	assert.equal(status.agents[0].liveness, "healthy");
	assert.equal(status.agents[2].execution, "waiting");
	assert.equal(status.outcome.terminal, false);
});

test("ownership release works on attempt 2 failure, cancel, reload, and reviewer with ownership paths", async t => {
	// 1. Builder with write_paths fails on attempt 2
	const f1 = await runFixture(t, {
		...chain,
		agents: [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, review],
	});
	const b1 = f1.nodes.get("n1")!;
	const r1 = f1.nodes.get("n2")!;
	await b1.complete(complete("Build 1"));
	await r1.deliverNotification(b1);
	await r1.complete(complete("Revise 1", "revise"));
	await b1.deliverNotification(r1);
	const failRes = await b1.complete({ status: "failure", summary: "Build 2 failed", detail: "Failed" });
	assert.equal(failRes.isError, undefined);
	const s1 = f1.status();
	assert.deepEqual(s1.worker_errors, []);
	assert.equal(s1.outcome.terminal, true);
	assert.equal(s1.agents[0].ownership_status, "released");

	// 2. Builder with write_paths cancelled while running attempt 2
	const f2 = await runFixture(t, {
		...chain,
		agents: [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, review],
	});
	const b2 = f2.nodes.get("n1")!;
	const r2 = f2.nodes.get("n2")!;
	await b2.complete(complete("Build 1"));
	await r2.deliverNotification(b2);
	await r2.complete(complete("Revise 1", "revise"));
	await b2.deliverNotification(r2);
	await f2.service.cancel(f2.run.task_id, { agents: ["n1"], reason: "Cancel attempt 2" });
	await b2.hooks.get("agent_settled")!({ aborted: true });
	const s2 = f2.status();
	assert.deepEqual(s2.worker_errors, []);
	assert.equal(s2.outcome.terminal, true);
	assert.equal(s2.agents[0].ownership_status, "released");

	// 3. Builder with write_paths reloads on attempt 2, and reviewer with write_paths approves on attempt 2
	const f3 = await runFixture(t, {
		...chain,
		agents: [
			{ ...chain.agents[0], write_paths: ["src/a.ts"] },
			{ ...review, write_paths: ["src/b.ts"] },
		],
	});
	const b3 = f3.nodes.get("n1")!;
	const r3 = f3.nodes.get("n2")!;
	await b3.complete(complete("Build 1"));
	await r3.deliverNotification(b3);
	await r3.complete(complete("Revise 1", "revise"));
	await b3.deliverNotification(r3);
	await b3.complete(complete("Build 2"));
	await f3.reload("n1");
	await r3.deliverNotification(b3);
	const appRes = await r3.complete(complete("Approve 2", "approve"));
	assert.equal(appRes.isError, undefined);
	const s3 = f3.status();
	assert.deepEqual(s3.worker_errors, []);
	assert.equal(s3.outcome.state, "succeeded");
	assert.equal(s3.outcome.terminal, true);
	assert.equal(s3.agents[1].ownership_status, "released");
});

test("node cancel of a parked loop member settles all members and prevents approval across reserved and unreserved states", async t => {
	// 1. Parked reviewer cancelled when attempt 2 is reserved (2-node loop)
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f1 = await runFixture(t, loopPlan);
	const { builder: b1, reviewer: r1 } = await rejectFirstBuild(f1);
	await f1.service.cancel(f1.run.task_id, { agents: ["n2"], reason: "Cancel parked reviewer", grace_ms: 0 });
	await b1.deliverNotification(r1);
	t.mock.timers.tick(2_000);
	const s1 = f1.status();
	assert.deepEqual(s1.worker_errors, []);
	assert.equal(s1.outcome.terminal, true);
	assert.deepEqual(s1.pending, []);
	assert.ok(s1.agents.every(a => a.finalized));

	// 2. Parked builder cancelled on attempt 1 before reviewer claims attempt 1 -> reviewer cannot approve
	const f2 = await runFixture(t, loopPlan);
	const b2 = f2.nodes.get("n1")!;
	const r2 = f2.nodes.get("n2")!;
	await b2.complete(complete("Build 1"));
	await f2.service.cancel(f2.run.task_id, { agents: ["n1"], reason: "Cancel parked builder", grace_ms: 0 });
	assert.equal(await r2.deliverNotification(b2), undefined);
	await assert.rejects(() => r2.complete(complete("Approve 1", "approve")), /no admitted work/);
	const s2 = f2.status();
	assert.deepEqual(s2.worker_errors, []);
	assert.equal(s2.outcome.state, "blocked");
	assert.equal(s2.outcome.terminal, true);
	assert.deepEqual(s2.pending, []);
	assert.deepEqual(s2.agents.map(a => a.finalized_by), ["dispatcher", "dispatcher"]);
	assert.deepEqual(s2.agents[1].execution_causes, [{ node_id: "n1", state: "cancelled", reason: "Cancel parked builder" }]);

	// 3. Parked builder cancelled on attempt 2 while reviewer is parked on attempt 1 -> reviewer cannot approve
	const f3 = await runFixture(t, loopPlan);
	const { builder: b3, reviewer: r3 } = await rejectFirstBuild(f3);
	await b3.deliverNotification(r3);
	await b3.complete(complete("Build 2"));
	await f3.service.cancel(f3.run.task_id, { agents: ["n1"], reason: "Cancel parked builder 2", grace_ms: 0 });
	assert.equal(await r3.deliverNotification(b3), undefined);
	const s3 = f3.status();
	assert.deepEqual(s3.worker_errors, []);
	assert.equal(s3.outcome.state, "blocked");
	assert.equal(s3.outcome.terminal, true);
	assert.deepEqual(s3.pending, []);

	// 4. 3-node loop: middle member cancelled while parked (both with reviewer running and with attempt 2 reserved)
	const threeNode = {
		...chain,
		agents: [chain.agents[0], { node_id: "mid", persona: "second", sub_task: "Middle step" }, review],
	};
	const f4 = await runFixture(t, threeNode);
	const n1_4 = f4.nodes.get("n1")!;
	const mid_4 = f4.nodes.get("mid")!;
	const n2_4 = f4.nodes.get("n2")!;
	await n1_4.complete(complete("Build 1"));
	await mid_4.deliverNotification(n1_4);
	await mid_4.complete(complete("Mid 1"));
	await n2_4.deliverNotification(mid_4);
	await f4.service.cancel(f4.run.task_id, { agents: ["mid"], reason: "Cancel parked mid", grace_ms: 0 });
	const approveRes = await n2_4.complete(complete("Approve 1", "approve"));
	assert.equal(approveRes.isError, true);
	const s4 = f4.status();
	assert.deepEqual(s4.worker_errors, []);
	assert.equal(s4.outcome.state, "cancelled");
	assert.equal(s4.outcome.terminal, true);
	assert.deepEqual(s4.pending, []);

	const f5 = await runFixture(t, threeNode);
	const n1_5 = f5.nodes.get("n1")!;
	const mid_5 = f5.nodes.get("mid")!;
	const n2_5 = f5.nodes.get("n2")!;
	await n1_5.complete(complete("Build 1"));
	await mid_5.deliverNotification(n1_5);
	await mid_5.complete(complete("Mid 1"));
	await n2_5.deliverNotification(mid_5);
	await n2_5.complete(complete("Revise 1", "revise"));
	await f5.service.cancel(f5.run.task_id, { agents: ["mid"], reason: "Cancel parked mid reserved", grace_ms: 0 });
	const s5 = f5.status();
	assert.deepEqual(s5.worker_errors, []);
	assert.equal(s5.outcome.state, "blocked");
	assert.equal(s5.outcome.terminal, true);
	assert.deepEqual(s5.pending, []);
	assert.ok(s5.agents.every(a => a.finalized));
});

test("fail_fast settles parked loop members on attempt 1 after rejection, read_paths-only nodes hold nothing while parked, reload preserves ownership release, closed parked writer stays waiting, and force_close respects grace", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 1. fail_fast while both builder and reviewer are parked on attempt 1 after rejection
	const f1 = await runFixture(t, { ...loopPlan, failure_policy: "fail_fast" });
	await rejectFirstBuild(f1);
	publishFailFast({
		sessionDir: f1.run.session_dir,
		taskId: f1.run.task_id,
		token: f1.run.token,
		cause: { instance_id: "a0-other", node_id: "other", state: "failed", reason: "Sibling failed" },
	});
	t.mock.timers.tick(2_000);
	const s1 = f1.status();
	assert.deepEqual(s1.worker_errors, []);
	assert.equal(s1.outcome.terminal, true);
	assert.deepEqual(s1.pending, []);

	// 2. Reviewer with read_paths and no write_paths holds nothing while parked
	const f2 = await runFixture(t, { ...chain, agents: [chain.agents[0], { ...review, read_paths: ["src/a.ts"] }] });
	const b2 = f2.nodes.get("n1")!;
	const r2 = f2.nodes.get("n2")!;
	await b2.complete(complete("Build 1"));
	await r2.deliverNotification(b2);
	await r2.complete(complete("Reject 1", "revise"));
	assert.notEqual(f2.status().agents[1].ownership_status, "admitted");

	// 3. Reload while parked preserves ownership release on finalization
	const f3 = await runFixture(t, { ...chain, agents: [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, review] });
	const b3 = f3.nodes.get("n1")!;
	const r3 = f3.nodes.get("n2")!;
	await b3.complete(complete("Build 1"));
	await f3.reload("n1");
	await r3.deliverNotification(b3);
	await r3.complete(complete("Approve 1", "approve"));
	t.mock.timers.tick(5_000);
	const s3 = f3.status();
	assert.deepEqual(s3.worker_errors, []);
	assert.equal(s3.agents[0].ownership_status, "released");

	// 4. Closing a parked writer's tab before finalization keeps downstream writer waiting (not held_uncertain), and force_close respects grace_ms
	const f4 = await runFixture(t, {
		...chain,
		agents: [
			{ ...chain.agents[0], write_paths: ["src/a.ts"] },
			review,
			{ node_id: "other", persona: "publisher", sub_task: "Edit src/a.ts", write_paths: ["src/a.ts"] },
		],
	});
	const b4 = f4.nodes.get("n1")!;
	await b4.complete(complete("Build 1"));
	await assert.rejects(() => f4.service.cancel(f4.run.task_id, { agents: ["n1"], force_close: true }), /cancellation must be requested first/);
	await b4.closeTab();
	assert.equal(f4.status().agents[2].ownership_status, "waiting");
});

test("09 x 10: cancelled loop members are never auto-cleaned as succeeded, stale cancel records do not strand cleanup, manual cleanup finalizes cancelled parked members, and cleaned status/widget/report say cancelled", async t => {
	// (a) A run with a cancelled loop member (parked or not) is never auto-cleaned as succeeded.
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const fA1 = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
	const bA1 = fA1.nodes.get("n1")!;
	await bA1.complete(complete("Build 1"));
	await fA1.service.cancel(fA1.run.task_id, { agents: ["n1"], reason: "Cancel parked builder", grace_ms: 0 });
	const sA1 = await fA1.service.statusWithCleanup(fA1.run.task_id);
	assert.deepEqual(sA1.worker_errors, []);
	assert.equal(sA1.manifest.status, "applied");
	assert.equal(sA1.outcome.terminal, true);
	assert.equal(sA1.outcome.state, "blocked");
	assert.ok(sA1.agents.every(a => a.finalized));

	// Even if a reviewer completed approve later than an earlier parked-member cancel.json, auto-cleanup refuses it.
	const fA2 = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
	const bA2 = fA2.nodes.get("n1")!;
	const rA2 = fA2.nodes.get("n2")!;
	await bA2.complete(complete("Build 1"));
	t.mock.timers.tick(5);
	writeCancelRecord(fA2.run.session_dir, {
		identity: { run_id: fA2.run.task_id, node_id: "n1", persona_name: "first", instance_id: bA2.config.instance_id },
		scope: "node", reason: "Cancelled before approval", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0,
	});
	t.mock.timers.tick(5);
	await rA2.deliverNotification(bA2);
	await rA2.complete(complete("Approved after cancel", "approve"));
	const sA2 = await fA2.service.statusWithCleanup(fA2.run.task_id);
	assert.deepEqual(sA2.worker_errors, []);
	assert.equal(sA2.manifest.status, "applied");

	// (b) A stale cancel record written after every completion won must not strand an interrupted automatic cleanup or block a legitimate one.
	const fB = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
	const bB = fB.nodes.get("n1")!;
	const rB = fB.nodes.get("n2")!;
	await bB.complete(complete("Build 1"));
	await rB.deliverNotification(bB);
	await rB.complete(complete("Approved", "approve"));
	t.mock.timers.tick(10);
	writeCancelRecord(fB.run.session_dir, {
		identity: { run_id: fB.run.task_id, node_id: "n1", persona_name: "first", instance_id: bB.config.instance_id },
		scope: "node", reason: "Stale cancel after completion", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0,
	});
	fB.service.store.save({ ...fB.status().manifest, cleanup_trigger: "auto", cleanup_at: new Date(Date.now()).toISOString(), phase: "auto-cleaning" });
	await fB.service.cancel(fB.run.task_id, { reason: "Whole-run cancel after completion" });
	let renderB!: (width: number) => string[];
	const widgetsB = createGraphWidgets((taskId, cwd, onCleaned) => fB.service.statusWithCleanup(taskId, cwd, onCleaned));
	t.after(() => widgetsB.clear());
	widgetsB.attach(fB.run.task_id, {
		hasUI: true, cwd: fB.cwd,
		ui: { setWidget(_key: string, factory?: Function) { if (factory) renderB = factory({ requestRender() {} }, { fg: (_c: string, text: string) => text }).render; } },
	} as Parameters<typeof widgetsB.attach>[1]);
	const sB = await fB.service.statusWithCleanup(fB.run.task_id);
	assert.deepEqual(sB.worker_errors, []);
	assert.equal(sB.outcome.state, "succeeded");
	assert.equal(sB.manifest.status, "cleaned");
	assert.match(renderB(120).join("\n"), /succeeded · cleaned/);
	assert.match(await reportText(fB), /Run outcome: succeeded\./);

	// (c) Auto-cleanup waits while parked/unfinalized; manual cleanup finalizes cancelled parked members as dispatcher without error.
	const fC = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
	const bC = fC.nodes.get("n1")!;
	const rC = fC.nodes.get("n2")!;
	await bC.complete(complete("Build 1"));
	assert.equal((await fC.service.statusWithCleanup(fC.run.task_id)).manifest.status, "applied");
	await rC.deliverNotification(bC);
	await rC.complete(complete("Revise 1", "revise"));
	assert.equal((await fC.service.statusWithCleanup(fC.run.task_id)).manifest.status, "applied");
	// Simulate attempt-2 cancellation disposition on n1 before finalization, then run manual cleanup.
	atomicJson(dispositionPath(fC.run.session_dir, `${bC.config.instance_id}.2`), dispositionRecord({
		task_id: fC.run.task_id, node_id: "n1", persona_name: "first", attempt_id: `${bC.config.instance_id}.2`, instance_id: bC.config.instance_id,
	}, "cancelled", "Cancelled on attempt 2", [], new Date(Date.now()).toISOString()));
	const cleanedC = await fC.service.cleanup(fC.run.task_id);
	assert.deepEqual(cleanedC.cleanup_errors, []);
	assert.equal(cleanedC.status, "cleaned");
	const sC = fC.status();
	assert.deepEqual(sC.worker_errors, []);
	assert.equal(sC.agents[0].finalized, true);
	assert.equal(sC.agents[0].finalized_by, "dispatcher");
	assert.equal(sC.agents[0].attempt_id, `${bC.config.instance_id}.2`);
	assert.equal(sC.agents[0].execution, "cancelled");
	assert.equal(sC.outcome.state, "failed");

	// (d) Cleaned-run status, widget, and report for a cancelled run say cancelled, not succeeded.
	const fD = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
	const bD = fD.nodes.get("n1")!;
	const rD = fD.nodes.get("n2")!;
	await bD.complete(complete("Build 1"));
	await rD.deliverNotification(bD);
	await fD.service.cancel(fD.run.task_id, { reason: "Stop loop run", grace_ms: 0 });
	await rD.complete(complete("Ignored after cancel", "approve")).catch(() => undefined);
	assert.equal((await fD.service.statusWithCleanup(fD.run.task_id)).manifest.status, "applied");
	const cleanedD = await fD.service.cleanup(fD.run.task_id);
	assert.equal(cleanedD.status, "cleaned");
	let renderD!: (width: number) => string[];
	const widgetsD = createGraphWidgets(() => fD.status());
	t.after(() => widgetsD.clear());
	widgetsD.attach(fD.run.task_id, {
		hasUI: true, cwd: fD.cwd,
		ui: { setWidget(_key: string, factory?: Function) { if (factory) renderD = factory({ requestRender() {} }, { fg: (_c: string, text: string) => text }).render; } },
	} as Parameters<typeof widgetsD.attach>[1]);
	const sD = fD.status();
	assert.deepEqual(sD.worker_errors, []);
	assert.equal(sD.outcome.state, "cancelled");
	assert.match(formatRunOutcome(sD.outcome, sD.agents), /^Run outcome: cancelled\b/);
	assert.doesNotMatch(formatRunOutcome(sD.outcome, sD.agents), /^Run outcome: succeeded\b/);
	const widgetD = renderD(120).join("\n");
	assert.match(widgetD, /cancelled · cleaned/);
	assert.doesNotMatch(widgetD, /succeeded/);
	const repD = await reportText(fD);
	assert.match(repD, /Run outcome: cancelled\./);
	assert.doesNotMatch(repD, /Run outcome: succeeded/);
});

test("node cancel losing to an in-flight completion claim still blocks future loop revisions", async t => {
	for (const verdict of ["approve", "revise"] as const) {
		await t.test(verdict, async st => {
			st.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
			const f = await runFixture(st, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
			const b = f.nodes.get("n1")!;
			const r = f.nodes.get("n2")!;
			const c = b.config;
			claimOutcome(c.session_dir, {
				run_id: c.task_id, node_id: c.node_id, persona_name: c.persona_name,
				instance_id: c.instance_id, attempt_id: c.attempt_id,
			}, "completed", new Date(Date.now()).toISOString(), `${c.instance_id}.1`);
			const res = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "late cancel", grace_ms: 0 });
			assert.deepEqual(res.cancelled, ["n1"]);
			assert.deepEqual(res.already_completed, []);
			await b.complete(complete("B1"));
			st.mock.timers.tick(1000);
			await r.deliverNotification(b);
			await r.complete(complete("R", verdict));
			if (verdict === "revise") {
				await b.deliverNotification(r).catch(() => undefined);
				st.mock.timers.tick(3000);
				const s = await f.service.statusWithCleanup(f.run.task_id);
				assert.deepEqual(s.worker_errors, []);
				assert.equal(s.outcome.terminal, true);
				assert.notEqual(s.outcome.state, "succeeded");
				assert.equal(s.manifest.status, "applied");
				assert.equal(s.agents[0].execution, "cancelled");
				assert.equal(s.agents[0].execution_reason, "late cancel");
				assert.deepEqual(s.agents[1].execution_causes, [{ node_id: "n1", state: "cancelled", reason: "late cancel" }]);
				assert.ok(s.agents.every(a => a.finalized));
			} else {
				st.mock.timers.tick(3000);
				const s = await f.service.statusWithCleanup(f.run.task_id);
				assert.deepEqual(s.worker_errors, []);
				assert.equal(s.outcome.state, "succeeded");
				assert.equal(s.manifest.status, "cleaned");
			}
		});
	}
});

test("cancelling a parked loop member arbitrates against a concurrent reviewer completion during signalNode", async t => {
	for (const verdict of ["approve", "revise"] as const) {
		await t.test(`R1/R5 ${verdict}`, async st => {
			st.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
			let hook: (() => Promise<void>) | undefined;
			const f = await runFixture(st, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 }, new Map(), {
				signalWorker: async (_m, entry) => {
					if (entry.node_id === "n1" && hook) { const h = hook; hook = undefined; await h(); }
				},
			});
			const b = f.nodes.get("n1")!;
			const r = f.nodes.get("n2")!;
			await b.complete(complete("B1"));
			await r.deliverNotification(b);
			hook = async () => { await r.complete(complete("R", verdict)); };
			const res = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "cancel builder", grace_ms: 0 });
			assert.deepEqual(res.cancelled, ["n1"]);
			await r.hooks.get("agent_settled")!({ aborted: false });
			st.mock.timers.tick(1000);
			const s = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(s.worker_errors, []);
			assert.equal(s.outcome.terminal, true);
			assert.equal(s.outcome.state, "cancelled");
			assert.equal(s.manifest.status, "applied");
			assert.match(await reportText(f), /Run outcome: cancelled\./);
		});
	}
});

test("a closed parked loop writer keeps holding ownership past the 10-minute heartbeat window until finalization", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		...chain,
		agents: [
			{ ...chain.agents[0], write_paths: ["src/a.ts"] },
			review,
			{ node_id: "other", persona: "first", sub_task: "x", write_paths: ["src/a.ts"] },
		],
	});
	const b = f.nodes.get("n1")!;
	const r = f.nodes.get("n2")!;
	await b.complete(complete("B1"));
	await r.deliverNotification(b);
	await b.closeTab();
	assert.equal(f.status().agents[2].ownership_status, "waiting");
	for (let i = 0; i < 22; i++) {
		t.mock.timers.tick(30_000);
		await r.hooks.get("tool_execution_start")!({});
	}
	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.agents[2].ownership_status, "waiting");
});

test("read-only reviewer owns its paths only during revision execution", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, agents: [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, { ...review, read_paths: ["src/a.ts"] },
		{ node_id: "writer", persona: "publisher", sub_task: "Edit reviewed files", write_paths: ["src/a.ts"] },
	] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const writer = f.nodes.get("writer")!;
	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Reject 1", "revise"));
	assert.equal(f.status().agents[1].ownership_status, "released");
	t.mock.timers.tick(1000);
	assert.equal(f.status().agents[2].ownership_status, "waiting");
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build 2"));
	await reviewer.deliverNotification(builder);
	const running = f.status();
	assert.deepEqual(running.worker_errors, []);
	assert.equal(running.outcome.state, "incomplete");
	assert.equal(running.agents[1].execution, "running");
	assert.equal(running.agents[1].ownership_status, "admitted");
	assert.equal(running.agents[2].ownership_status, "waiting");
	await reviewer.complete(complete("Approved", "approve"));
	t.mock.timers.tick(1000);
	await writer.deliverNotification(reviewer);
	await writer.complete(complete("Edited"));
	const done = f.status();
	assert.deepEqual(done.worker_errors, []);
	assert.equal(done.agents[1].ownership_status, "released");
	assert.equal(done.outcome.state, "succeeded");
});

test("status shows a decision's queued feedback alongside its forward edge", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, agents: [chain.agents[0], review, publish] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Reject", "revise"));
	const queued = f.status();
	assert.deepEqual(queued.worker_errors, []);
	assert.equal(queued.outcome.state, "incomplete");
	assert.equal(queued.agents[1].handoffs_out?.[builder.config.instance_id]?.state, "queued");
	assert.match(states(f), /handoff out -> a1-n1 .* queued: not accepted yet/);
	await builder.deliverNotification(reviewer);
	const accepted = f.status();
	assert.deepEqual(accepted.worker_errors, []);
	assert.equal(accepted.agents[1].handoffs_out?.[builder.config.instance_id]?.state, "accepted");
});

test("an earlier corrupt reviewer attempt surfaces in status and report", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build 1"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Reject", "revise"));
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Build 2"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved", "approve"));
	assert.deepEqual(f.status().worker_errors, []);
	assert.equal(f.status().outcome.state, "succeeded");
	atomicJson(resultPath(f.run.session_dir, reviewer.config.attempt_id!), {});
	const corrupt = f.status();
	assert.match(corrupt.worker_errors.join("\n"), /n2.*attempt 1.*malformed result record/);
	assert.equal(corrupt.outcome.state, "needs_attention");
	await assert.rejects(f.report(), /n2.*attempt 1.*malformed result record/);
});

test("dry-run diagnostics name a whole bootstrap.json that cannot be read or parsed", async t => {
	const f = serviceFixture(t);
	const path = join(f.cwd, ".pi", "bootstrap.json");
	const dryRun = () => f.service.plan({ ...loopPlan, project_cwd: f.cwd }, model);
	await t.test("invalid JSON", () => {
		fs.writeFileSync(path, "{");
		assert.throws(dryRun, (error: Error) => error.message.startsWith(`${path}: configuration file contains invalid JSON`));
	});
	await t.test("unreadable file", () => {
		fs.rmSync(path);
		fs.mkdirSync(path);
		assert.throws(dryRun, (error: Error) => error.message.startsWith(`${path}: configuration file could not be read`));
	});
});

// ---- Settlement fixes & mutation pins ----

for (const mode of ["vanish", "closeTab"] as const) {
	test(`a parked decision node that exits (${mode}) during a revision makes the decision needs_attention and blocks nothing by replay`, async t => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const fRef: { nodes: Map<string, { config: { instance_id: string } }> } = { nodes: new Map() };
		const failComsToDeadReviewer = {
			executeTool: async (_name: string, params: unknown) => {
				const target = (params as { target?: string })?.target;
				if (target === `session-${fRef.nodes.get("n2")?.config.instance_id}`) {
					return { isError: true, content: [{ type: "text", text: "Connection refused: reviewer exited" }] };
				}
				return { content: [], details: { msg_id: "msg1" } };
			},
		};
		const f = await runFixture(
			t,
			{ ...loopPlan, agents: [...loopPlan.agents, publish] },
			new Map([["n1", failComsToDeadReviewer]]),
		);
		for (const [k, v] of f.nodes) fRef.nodes.set(k, v);
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		if (mode === "vanish") reviewer.vanish();
		else await reviewer.closeTab();
		await builder.complete(complete("Revised after reviewer died"));
		t.mock.timers.tick(1_000);

		const s = f.status();
		assert.equal(s.outcome.state, "needs_attention");
		assert.equal(s.outcome.terminal, false);
		assert.deepEqual(s.delivery_errors, []);
		assert.equal(s.worker_errors.length, 1);
		assert.match(s.worker_errors[0], /n2.*Feedback edge to n1 is dead: parked agent n2 exited during revision/);
		const n1State = s.agents.find(a => a.node_id === "n1")!;
		const n2State = s.agents.find(a => a.node_id === "n2")!;
		assert.equal(n1State.execution, "succeeded");
		assert.equal(n1State.parked, false);
		assert.equal(n1State.edge_states?.n2, "dead");
		assert.equal(n2State.execution, "needs_attention");
		assert.match(n2State.execution_reason!, /parked agent n2 exited during revision/);
		const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
		assert.doesNotMatch(recovery, /retry_delivery/);
		await assert.rejects(f.report(), /Run is not complete/);
	});
}

test("a parked intermediate or moved-on member that exits during revision is detected without false 'before revision' cause", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
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
	await builder.complete(complete("B1"));
	await mid.deliverNotification(builder);
	await mid.complete(complete("M1"));
	await reviewer.deliverNotification(mid);
	await reviewer.complete(complete("R1", "revise"));
	await builder.deliverNotification(reviewer);
	mid.vanish();
	await builder.complete(complete("B2"));
	t.mock.timers.tick(1_000);

	const s = f.status();
	assert.equal(s.outcome.state, "needs_attention");
	assert.equal(s.outcome.terminal, false);
	assert.equal(s.worker_errors.length, 1);
	assert.match(s.worker_errors[0], /Feedback edge to n1 is dead: parked agent mid exited during revision/);
	assert.doesNotMatch(s.worker_errors[0], /exited before revision/);
	assert.equal(s.agents.find(a => a.node_id === "n2")?.execution, "needs_attention");
	assert.deepEqual(s.pending, ["n2"]);
	const recovery = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.doesNotMatch(recovery, /retry_delivery/);
});

test("cancelling the reviewer on attempt 1 of a 3-node loop blocks unstarted middle members and makes the run terminal", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const midPlan = {
		...loopPlan,
		agents: [
			chain.agents[0],
			{ node_id: "mid", persona: "second", sub_task: "Intermediate step" },
			{ ...review, decision: { ...review.decision, on_reject: "n1" } },
			publish,
		],
	};
	const f = await runFixture(t, midPlan);
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "cancel reviewer", grace_ms: 0 });
	await f.nodes.get("n1")!.complete(complete("B1"));
	for (let i = 0; i < 310; i++) t.mock.timers.tick(1000);

	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "blocked");
	assert.equal(s.outcome.terminal, true);
	const midState = s.agents.find(a => a.node_id === "mid")!;
	assert.equal(midState.execution, "blocked");
	assert.match(midState.execution_reason!, /n2/);
	assert.equal(s.agents.find(a => a.node_id === "publish")?.execution, "blocked");
	assert.match(await reportText(f), /mid.*blocked/);
});

test("cancelling a middle member on attempt 2 and fail_fast on attempt 1 of a 3-node loop settle cleanly", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const midPlan = {
		...loopPlan,
		agents: [
			chain.agents[0],
			{ node_id: "mid", persona: "second", sub_task: "Intermediate step" },
			{ ...review, decision: { ...review.decision, on_reject: "n1" } },
		],
	};
	const f1 = await runFixture(t, midPlan);
	const b1 = f1.nodes.get("n1")!, m1 = f1.nodes.get("mid")!, r1 = f1.nodes.get("n2")!;
	await b1.complete(complete("B1"));
	await m1.deliverNotification(b1);
	await m1.complete(complete("M1"));
	await r1.deliverNotification(m1);
	await r1.complete(complete("R1", "revise"));
	await b1.deliverNotification(r1);
	await f1.service.cancel(f1.run.task_id, { agents: ["mid"], reason: "cancel mid", grace_ms: 0 });
	await b1.complete(complete("B2"));
	t.mock.timers.tick(1_000);
	const s1 = f1.status();
	assert.deepEqual(s1.worker_errors, []);
	assert.equal(s1.outcome.state, "blocked");
	assert.equal(s1.outcome.terminal, true);
	assert.equal(s1.agents.find(a => a.node_id === "n2")?.execution, "blocked");

	const f2 = await runFixture(t, { ...midPlan, failure_policy: "fail_fast" });
	publishFailFast({
		sessionDir: f2.run.session_dir, taskId: f2.run.task_id, token: f2.run.token,
		cause: { instance_id: "zzz", node_id: "other", state: "failed", reason: "boom" },
	});
	t.mock.timers.tick(1_000);
	await f2.nodes.get("n1")!.hooks.get("agent_settled")!({ aborted: true });
	t.mock.timers.tick(1_000);
	const s2 = f2.status();
	assert.deepEqual(s2.worker_errors, []);
	assert.equal(s2.outcome.state, "blocked");
	assert.equal(s2.outcome.terminal, true);
	assert.equal(s2.agents.find(a => a.node_id === "mid")?.execution, "cancelled");
	assert.equal(s2.agents.find(a => a.node_id === "n2")?.execution, "blocked");
});

test("a crash after revision transition.json and before handoff claim shows needs_attention while open, recovers on redeliver, and closes on cleanup", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// (a) Open state -> needs_attention, then redeliver recovers (also pins M22).
	const fA = await runFixture(t, loopPlan);
	const { reviewer: rA } = await rejectFirstBuild(fA);
	atomicJson(join(fA.run.session_dir, "a1-n1.1.transition.json"), {
		version: 1, run_id: fA.run.task_id, instance_id: "a1-n1", from_attempt: 1, winner: "revision", next_attempt: 2,
	});
	const bA = await fA.reload("n1");
	const openStatus = fA.status();
	assert.equal(openStatus.outcome.state, "needs_attention");
	assert.equal(openStatus.outcome.terminal, false);
	assert.equal(openStatus.agents[0].execution, "needs_attention");
	assert.match(openStatus.worker_errors[0], /Revision attempt 2 transition was recorded without claiming the handoff/);

	await bA.deliverNotification(rA);
	const afterRedeliver = fA.status();
	assert.equal(afterRedeliver.agents[0].attempt_id, "a1-n1.2");
	assert.equal(afterRedeliver.agents[0].execution, "running");

	// (b) Cleanup closes a bare revision transition on the builder's last real attempt.
	const fB = await runFixture(t, loopPlan);
	await rejectFirstBuild(fB);
	atomicJson(join(fB.run.session_dir, "a1-n1.1.transition.json"), {
		version: 1, run_id: fB.run.task_id, instance_id: "a1-n1", from_attempt: 1, winner: "revision", next_attempt: 2,
	});
	fB.nodes.get("n1")!.vanish();
	const cleaned = await fB.service.cleanup(fB.run.task_id);
	assert.equal(cleaned.status, "cleaned");
	const sB = fB.status();
	assert.deepEqual(sB.worker_errors, []);
	assert.equal(sB.outcome.state, "failed");
	assert.equal(sB.outcome.terminal, true);
	assert.equal(sB.agents[0].attempt_id, "a1-n1.1");
	assert.equal(sB.agents[0].finalized, true);
	assert.equal(sB.agents[1].finalized, true);
	assert.match(await reportText(fB), /1 success, 0 partial, 1 failure/);
});

test("cleanup finalizes all loop members on the decision's last reviewed attempt, never a never-reviewed builder attempt", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	reviewer.vanish();
	await builder.complete(complete("Revised without reviewer"));
	await f.service.cleanup(f.run.task_id);

	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "failed");
	assert.equal(s.outcome.terminal, true);
	assert.deepEqual(s.agents.map(a => a.attempt_id), ["a1-n1.1", "a2-n2.1"]);
	assert.deepEqual(s.agents.map(a => a.finalized), [true, true]);
	assert.equal(s.agents[0].summary, "Original build");
	assert.equal(s.agents[0].unreviewed_attempts?.length, 1);
	assert.equal(s.agents[0].unreviewed_attempts?.[0].attempt_id, "a1-n1.2");
	assert.equal(s.agents[0].unreviewed_attempts?.[0].state, "succeeded");
	assert.equal(s.agents[0].unreviewed_attempts?.[0].summary, "Revised without reviewer");
	assert.match(s.agents[0].unreviewed_attempts?.[0].result_path ?? "", /a1-n1\.2\.result\.json$/);
	assert.match(states(f), /a1-n1 .*Original build.*\[attempt 1\/3, finalized\].*\[unreviewed later result: a1-n1\.2 \(succeeded: Revised without reviewer,/);
	const rep = await reportText(f);
	assert.match(rep, /1 success, 0 partial, 1 failure/);
	assert.match(rep, /Attempt 1\/3: succeeded — Original build/);
	assert.match(rep, /Attempt 2\/3 \(unreviewed\): succeeded — Revised without reviewer/);
});

test("mutation pins: M2, M13, M15, M18, M25, M26 and stable legacy budget recovery", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });

	// M2: decision record exists before member transition -> claimRevisionTransition rejects.
	{
		const f = await runFixture(t, loopPlan);
		const { builder, reviewer } = await rejectFirstBuild(f);
		atomicJson(join(f.run.session_dir, "a2-n2.finalize.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a2-n2", attempt_id: "a2-n2.1", finalized_by: "dispatcher",
		});
		assert.deepEqual(
			claimRevisionTransition(f.run.session_dir, f.run.task_id, f.run.review_plan!.loops[0], "a1-n1", 1, 2),
			{ outcome: "rejected", reason: "node finalized" },
		);
		await builder.deliverNotification(reviewer);
		assert.equal(f.status().agents[0].attempt_id, "a1-n1.1");
	}

	// M13: attempt-2 settlement writes attempt-1 -> revision transition for reviewer.
	{
		const f = await runFixture(t, loopPlan);
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		await builder.complete({ status: "failure", summary: "B2 failed", detail: "err" });
		assert.equal(readLoopTransition(f.run.session_dir, f.run.task_id, "a2-n2", 1)?.winner, "revision");
		assert.equal(f.status().outcome.state, "failed");
	}

	// M15: member finalization preserves dispatcher finalized_by when decision was finalized by dispatcher.
	{
		const f = await runFixture(t, loopPlan);
		const b = f.nodes.get("n1")!;
		await b.complete(complete("B1"));
		atomicJson(join(f.run.session_dir, "a2-n2.finalize.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a2-n2", attempt_id: "a2-n2.1", finalized_by: "dispatcher",
		});
		await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "stop", grace_ms: 0 });
		assert.deepEqual(f.status().agents.map(a => a.finalized_by), ["dispatcher", "dispatcher"]);
	}

	// M18: reviewer timer settles a blocked next attempt left by an exited writer before finalization.
	{
		const f = await runFixture(t, loopPlan);
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		atomicJson(dispositionPath(f.run.session_dir, "a2-n2.2"), dispositionRecord({
			task_id: f.run.task_id, node_id: "n2", persona_name: "second", attempt_id: "a2-n2.2", instance_id: "a2-n2",
		}, "blocked", "Writer exited", [], new Date().toISOString()));
		t.mock.timers.tick(1_000);
		const s = f.status();
		assert.equal(s.agents[1].attempt_id, "a2-n2.2");
		assert.equal(s.agents[1].execution, "blocked");
		assert.equal(s.agents[1].finalized, true);
	}

	// M25: builder completing after reviewer cancelled suppresses handoff without calling coms_send.
	{
		let sentToReviewer = false;
		const f = await runFixture(t, loopPlan, new Map([["n1", {
			executeTool: async (name: string) => {
				if (name === "coms_send") { sentToReviewer = true; throw new Error("coms_send should be suppressed"); }
				return { content: [], details: { msg_id: "msg1" } };
			},
		}]]));
		await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "stop", grace_ms: 0 });
		await f.nodes.get("n1")!.complete(complete("B1"));
		assert.equal(sentToReviewer, false);
		assert.equal(f.status().outcome.state, "cancelled");
		assert.equal(f.status().outcome.terminal, true);
	}

	// M26: reviewer completing after dispatcher-written failed exhaustion decision publishes fail-fast.
	{
		const f = await runFixture(t, {
			...loopPlan,
			failure_policy: "fail_fast",
			agents: [
				chain.agents[0],
				{ ...review, decision: { ...review.decision, on_exhausted: "failed" as const } },
				publish,
			],
		});
		const b = f.nodes.get("n1")!, r = f.nodes.get("n2")!;
		await b.complete(complete("B1"));
		await r.deliverNotification(b);
		atomicJson(join(f.run.session_dir, "a2-n2.finalize.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a2-n2", attempt_id: "a2-n2.1", finalized_by: "dispatcher",
			exhausted: { state: "failed", reason: "Budget exhausted" },
		});
		await r.complete(complete("R1", "revise"));
		assert.equal(fs.existsSync(join(f.run.session_dir, "fail-fast.json")), true);
	}
});

for (const timing of ["crash", "live"] as const) {
	for (const scope of ["node", "run"] as const) {
		for (const verdict of ["approve", "revise"] as const) {
			test(`cancel during reviewer ${verdict} publication (${timing}, ${scope})`, async t => {
				t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
				const f = await runFixture(t, { ...loopPlan, cleanup: "on_success", cleanup_settle_ms: 0 });
				const builder = f.nodes.get("n1")!;
				const reviewer = f.nodes.get("n2")!;
				await builder.complete(complete("Build"));
				await reviewer.deliverNotification(builder);
				let pending: Promise<unknown> | undefined;
				let releaseBudget: (() => void) | undefined;
				let budgetLock: Promise<void> | undefined;
				if (timing === "crash") {
					await reviewer.complete(complete("Reviewer verdict", verdict));
					reviewer.vanish();
					const path = resultPath(f.run.session_dir, "a2-n2.1");
					atomicJson(path, { ...readJson<WorkerCompletion>(path), delivery: "pending" });
					for (const name of fs.readdirSync(f.run.session_dir)) {
						if (/\.(finalize|transition|revision)\.json$/.test(name)) fs.rmSync(join(f.run.session_dir, name));
					}
				} else {
					if (verdict === "revise") {
						const held = new Promise<void>(resolve => {
							budgetLock = withRunLock(join(f.run.session_dir, "review-budget"), () => {
								resolve();
								return new Promise<void>(release => { releaseBudget = release; });
							});
						});
						await held;
					}
					pending = reviewer.complete(complete("Reviewer verdict", verdict));
					if (releaseBudget) await new Promise<void>(resolve => setImmediate(resolve));
				}
				const reason = "Stop the review";
				const cancel = await (async () => {
					try { return await f.service.cancel(f.run.task_id, { ...(scope === "node" ? { agents: ["n2"] } : {}), reason, grace_ms: 0 }); }
					finally { releaseBudget?.(); await budgetLock; }
				})();
				await pending;
				if (timing === "live" && verdict === "revise") {
					await Promise.resolve().then(() => builder.deliverNotification(reviewer)).catch(() => undefined);
				}
				t.mock.timers.tick(3_000);
				if (timing === "live" && scope === "node" && verdict === "approve") {
					// A contradictory outcome claim still prevents cleanup if every result says success.
					const path = outcomeClaimPath(f.run.session_dir, "a2-n2.1");
					const won = readJson<ReturnType<typeof claimOutcome>["claim"]>(path);
					atomicJson(path, { ...won, outcome: "cancelled" });
					const guarded = await f.service.statusWithCleanup(f.run.task_id);
					assert.deepEqual(guarded.worker_errors, []);
					assert.equal(guarded.outcome.state, "succeeded");
					assert.equal(guarded.outcome.terminal, true);
					assert.deepEqual(guarded.agents.map(a => a.execution_causes), [[], []]);
					assert.equal(guarded.manifest.status, "applied");
					atomicJson(path, won);
				}
				const s = await f.service.statusWithCleanup(f.run.task_id);
				assert.deepEqual(s.worker_errors, []);
				assert.equal(s.outcome.terminal, true);
				assert.equal(s.outcome.state, verdict === "approve" ? "succeeded" : "cancelled");
				assert.equal(s.manifest.status, verdict === "approve" ? "cleaned" : "applied");
				if (verdict === "revise") assert.deepEqual(s.agents.map(a => a.finalized_by), ["dispatcher", "dispatcher"]);
				assert.deepEqual(s.agents.map(a => [a.execution, a.execution_reason, a.execution_causes]), [
					["succeeded", "Build", []],
					verdict === "approve" ? ["succeeded", "Reviewer verdict", []] : ["cancelled", reason, []],
				]);
				assert.match(await reportText(f), verdict === "approve" ? /Run outcome: succeeded/ : /Stop the review/);
				assert.deepEqual(cancel.cancelled, verdict === "approve" ? [] : ["n2"]);
				assert.equal(cancel.already_completed.includes("n2"), verdict === "approve");
			});
		}
	}
}

test("cancelling a parked builder after a saved rejection preserves the next attempt's cancel reason", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build"));
	await reviewer.deliverNotification(builder);
	const pending = reviewer.complete(complete("Revise the build", "revise"));
	const reason = "Stop the builder before revision";
	const cancel = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason, grace_ms: 0 });
	await pending;
	const c = builder.config;
	// A competing completion claim must lose even before the notification is processed.
	claimOutcome(c.session_dir, { run_id: c.task_id, node_id: c.node_id, persona_name: c.persona_name,
		instance_id: c.instance_id, attempt_id: "a1-n1.2" }, "completed", new Date().toISOString(), "a1-n1.2");
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(3_000);
	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.terminal, true);
	assert.equal(s.outcome.state, "blocked");
	assert.deepEqual(s.agents.map(a => [a.execution, a.execution_reason, a.execution_causes]), [
		["cancelled", reason, []],
		["blocked", `n1 was cancelled: ${reason}`, [{ node_id: "n1", state: "cancelled", reason }]],
	]);
	assert.match(await reportText(f), /Stop the builder before revision/);
	assert.deepEqual(cancel.cancelled, ["n1"]);
	assert.deepEqual(cancel.already_completed, []);
});

test("unreadable finalization fails closed for force-close, parked cancellation and lost arbitration", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	await checkUnreadableParkedFinalization(t);
	await checkUnreadableFinalizationAfterClaim(t, false);
	await checkUnreadableFinalizationAfterClaim(t, true);
});

async function checkUnreadableParkedFinalization(t: test.TestContext) {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	const premature = join(f.run.session_dir, "a1-n1.finalize.json");
	atomicJson(premature, { version: 99 });
	await assert.rejects(f.service.cancel(f.run.task_id, { agents: ["n1"], force_close: true }), /cancellation must be requested first/);
	const cancel = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "Must fail closed", grace_ms: 0 });
	assert.match(cancel.record_errors?.join("\n") ?? "", /Invalid or unsupported finalization record/);
	const corrupt = f.status();
	assert.match(corrupt.worker_errors.join("\n"), /n1.*Invalid or unsupported finalization record/);
	assert.equal(corrupt.outcome.state, "incomplete");
	assert.equal(corrupt.outcome.terminal, false);
	assert.deepEqual(corrupt.agents.map(a => a.execution_causes), [[], []]);
	fs.rmSync(premature);
	await builder.deliverNotification(reviewer);
	await builder.complete(complete("Revised build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Approved build", "approve"));
	const recovered = f.status();
	assert.deepEqual(recovered.worker_errors, []);
	assert.equal(recovered.outcome.state, "succeeded");
	assert.equal(recovered.outcome.terminal, true);
	assert.deepEqual(recovered.agents.map(a => [a.execution_reason, a.execution_causes]), [["Revised build", []], ["Approved build", []]]);
}

async function checkUnreadableFinalizationAfterClaim(t: test.TestContext, priorCancel: boolean) {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const c = builder.config;
	const identity = { run_id: c.task_id, node_id: c.node_id, persona_name: c.persona_name, instance_id: c.instance_id };
	claimOutcome(c.session_dir, { ...identity, attempt_id: c.attempt_id }, "completed", new Date().toISOString(), "a1-n1.1");
	const reason = "Previously requested cancellation";
	if (priorCancel) writeCancelRecord(c.session_dir, {
		identity: { ...identity, attempt_id: "a1-n1.2" }, scope: "node", reason, requestedAt: new Date().toISOString(), graceMs: 0,
	});
	const path = join(c.session_dir, "a1-n1.finalize.json");
	atomicJson(path, { version: 99 });
	await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "Must fail closed", grace_ms: 0 });
	const corrupt = f.status();
	assert.match(corrupt.worker_errors.join("\n"), /n1.*Invalid or unsupported finalization record/);
	assert.equal(corrupt.outcome.state, "needs_attention");
	assert.equal(corrupt.outcome.terminal, false);
	assert.deepEqual(corrupt.agents.map(a => a.execution_causes), [[], []]);
	fs.rmSync(path);
	await builder.complete(complete("Build"));
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise", "revise"));
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(3_000);
	const recovered = f.status();
	assert.deepEqual(recovered.worker_errors, []);
	assert.equal(recovered.outcome.state, priorCancel ? "blocked" : "incomplete");
	assert.equal(recovered.outcome.terminal, priorCancel);
	if (priorCancel) assert.equal(recovered.agents[0].execution_reason, reason);
	assert.deepEqual(recovered.agents.map(a => [a.execution, a.execution_causes]), priorCancel
		? [["cancelled", []], ["blocked", [{ node_id: "n1", state: "cancelled", reason }]]]
		: [["running", []], ["waiting", []]]);
}

test("a revising reader refuses foreign ownership identity in a review plan", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const [field, value] of [["persona_name", "foreign"], ["attempt_id", "a2-n2.2"]]) {
		const f = await runFixture(t, { ...loopPlan, agents: [chain.agents[0], { ...review, read_paths: ["src/a.ts"] }] });
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		await builder.complete(complete("Revised build"));
		const path = ownershipPath(f.run.session_dir, "a2-n2");
		const original = readJson<{ identity: Record<string, unknown> }>(path);
		atomicJson(path, { ...original, identity: { ...original.identity, [field]: value } });
		await reviewer.deliverNotification(builder);
		t.mock.timers.tick(1_000);
		const s = f.status();
		assert.match(s.worker_errors.join("\n"), new RegExp(`n2.*ownership.*identity mismatch.*${field}`, "i"));
		assert.equal(s.outcome.state, "needs_attention");
		assert.equal(s.outcome.terminal, false);
		assert.deepEqual(s.agents.map(a => a.execution_causes), [[], []]);
	}
});

test("revision cancellation on either side of a handoff claim prevents work", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const timing of ["before", "after"] as const) {
		const f = await runFixture(t, loopPlan);
		const { builder, reviewer } = await rejectFirstBuild(f);
		const reason = "Cancel during revision admission";
		const c = builder.config;
		const publish = () => writeCancelRecord(c.session_dir, {
			identity: { run_id: c.task_id, node_id: c.node_id, persona_name: c.persona_name, instance_id: c.instance_id },
			scope: "node", reason, requestedAt: new Date().toISOString(), graceMs: 0,
		});
		const read = fs.readFileSync;
		const link = fs.linkSync;
		if (timing === "before") {
			fs.readFileSync = ((path, ...args) => {
				if (String(path).endsWith("a2-n2.1.result.json")) publish();
				return Reflect.apply(read, fs, [path, ...args]);
			}) as typeof fs.readFileSync;
		} else {
			fs.linkSync = (from, to) => {
				link(from, to);
				if (String(to) === handoffClaimPath(c.session_dir, "a1-n1.2", "a2-n2")) publish();
			};
		}
		syncBuiltinESMExports();
		try { await builder.deliverNotification(reviewer); }
		finally { fs.readFileSync = read; fs.linkSync = link; syncBuiltinESMExports(); }
		const s = f.status();
		assert.deepEqual(s.worker_errors, []);
		assert.equal(s.outcome.state, "blocked");
		assert.equal(s.outcome.terminal, true);
		assert.deepEqual(s.agents.map(a => [a.execution, a.execution_reason, a.execution_causes]), [
			["cancelled", reason, []],
			["blocked", `n1 was cancelled: ${reason}`, [{ node_id: "n1", state: "cancelled", reason }]],
		]);
		assert.equal(s.agents[0].handoff?.state, timing === "before" ? "queued" : "accepted");
	}
});

test("a cancelled rejection is the recorded cause of blocked successors", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("Build"));
	await reviewer.deliverNotification(builder);
	const pending = reviewer.complete(complete("Revise", "revise"));
	const reason = "Stop before publishing";
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason, grace_ms: 0 });
	await pending;
	t.mock.timers.tick(3_000);
	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "blocked");
	assert.equal(s.outcome.terminal, true);
	assert.deepEqual(s.agents.map(a => [a.execution, a.execution_causes]), [
		["succeeded", []],
		["cancelled", []],
		["blocked", [{ node_id: "n2", state: "cancelled", reason }]],
	]);
	assert.match(await reportText(f), /publish.*blocked.*Stop before publishing/);
});

test("cancelling a rejecting reviewer stops a reserved revision before the builder claims it", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	const reason = "Stop the queued revision";
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason, grace_ms: 0 });
	await builder.deliverNotification(reviewer);
	t.mock.timers.tick(3_000);
	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "cancelled");
	assert.equal(s.outcome.terminal, true);
	assert.deepEqual(s.agents.map(a => [a.attempt_id, a.execution, a.execution_reason, a.execution_causes]), [
		["a1-n1.1", "succeeded", "Original build", []],
		["a2-n2.1", "cancelled", reason, []],
	]);
	assert.match(await reportText(f), /Stop the queued revision/);
});

test("3-node loop with successor: cancelling reviewer during revise publication suppresses handoff and settles all members", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const midPlan = {
		...loopPlan,
		agents: [
			chain.agents[0],
			{ node_id: "mid", persona: "second", sub_task: "Intermediate step" },
			{ ...review, decision: { ...review.decision, on_reject: "n1" } },
			publish,
		],
	};
	const f = await runFixture(t, midPlan);
	const builder = f.nodes.get("n1")!;
	const mid = f.nodes.get("mid")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("B1"));
	await mid.deliverNotification(builder);
	await mid.complete(complete("M1"));
	await reviewer.deliverNotification(mid);
	let releaseBudget: (() => void) | undefined;
	const budgetLock = new Promise<void>(resolve => {
		void withRunLock(join(f.run.session_dir, "review-budget"), () => {
			resolve();
			return new Promise<void>(release => { releaseBudget = release; });
		});
	});
	await budgetLock;
	const pending = reviewer.complete(complete("R1", "revise"));
	await new Promise<void>(resolve => setImmediate(resolve));
	const reason = "Stop 3-node loop before revision";
	const cancel = await (async () => {
		try { return await f.service.cancel(f.run.task_id, { agents: ["n2"], reason, grace_ms: 0 }); }
		finally { releaseBudget?.(); }
	})();
	await pending;
	t.mock.timers.tick(3_000);
	assert.deepEqual(cancel.cancelled, ["n2"]);
	assert.deepEqual(cancel.already_completed, []);
	assert.equal(reviewer.sent.some(call => call.name === "coms_send"), false);
	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "blocked");
	assert.equal(s.outcome.terminal, true);
	assert.deepEqual(s.agents.map(a => [a.node_id, a.execution, a.finalized, a.execution_causes]), [
		["n1", "succeeded", true, []],
		["mid", "succeeded", true, []],
		["n2", "cancelled", true, []],
		["publish", "blocked", undefined, [{ node_id: "n2", state: "cancelled", reason }]],
	]);
});

test("a reviewer cancelled after saving a rejection is reported as cancelled after completing, never as not executed", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(complete("B1"));
	await reviewer.deliverNotification(builder);
	const pending = reviewer.complete(complete("R", "revise"));
	await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "my reason", grace_ms: 0 });
	await pending;
	t.mock.timers.tick(3_000);

	const s = f.status();
	assert.deepEqual(s.worker_errors, []);
	assert.equal(s.outcome.state, "cancelled");
	assert.equal(s.outcome.terminal, true);
	assert.equal(s.agents[1].execution, "cancelled");
	assert.equal(s.agents[1].result_status, "success");
	const outcomeLine = statusText(f);
	assert.doesNotMatch(outcomeLine, /Did not execute:/);
	assert.match(outcomeLine, /Cancelled after completing: n2\./);
	const rep = await reportText(f);
	assert.doesNotMatch(rep, /Not executed:/);
	assert.match(rep, /Cancelled after completing: 1\./);
	assert.match(rep, /- n2 \(persona second\): cancelled — R — my reason/);
});

for (const action of ["cancel-node", "cancel-run", "fail-fast"] as const) {
	test(`single-edge follower ${action} while waiting for ownership releases its ownership record`, async t => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const f = await runFixture(t, {
			topology: "graph",
			task: "single-edge ownership release",
			failure_policy: action === "fail-fast" ? "fail_fast" : "independent",
			dependency_wait_timeout_ms: 30_000,
			agents: [
				{ node_id: "holder", persona: "first", sub_task: "Hold", write_paths: ["out"] },
				{ node_id: "a", persona: "first", sub_task: "A" },
				{ node_id: "x", persona: "first", sub_task: "X" },
				{ node_id: "b", persona: "second", sub_task: "B", depends_on: ["a"], write_paths: ["out"] },
			],
		});
		const a = f.nodes.get("a")!;
		const x = f.nodes.get("x")!;
		const b = f.nodes.get("b")!;
		await a.complete(complete("A done"));
		await b.deliverNotification(a);
		assert.equal(f.status().agents[3].ownership_status, "waiting");

		if (action === "cancel-node") await f.service.cancel(f.run.task_id, { agents: ["b"], reason: "stop b", grace_ms: 0 });
		else if (action === "cancel-run") await f.service.cancel(f.run.task_id, { reason: "stop all", grace_ms: 0 });
		else await x.complete({ status: "failure", summary: "x broke", detail: "" });

		for (let i = 0; i < 3; i++) {
			t.mock.timers.tick(1_000);
			await b.deliverFollowUps();
		}
		const s = f.status();
		assert.deepEqual(s.worker_errors, []);
		assert.equal(s.agents[3].execution, "cancelled");
		assert.equal(s.agents[3].ownership_status, "released");
		assert.equal(readJson<{ state: string }>(ownershipPath(f.run.session_dir, "a4-b")).state, "released");
	});
}

test("mutation pins: A-reserve-under-lock-finalized, A-legacy-cause, A-finalized-transition-guard, B-worker-sourceRecord, B-cancel-scope-attempt, MERGE-lateDecision-suppress", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });

	// A-reserve-under-lock-finalized: reserveRevision returns undefined when reviewer is already finalized even if budget is tight.
	{
		const f = await runFixture(t, { ...loopPlan, max_total_attempts: 2 });
		const { reviewer } = await rejectFirstBuild(f);
		assert.equal(fs.existsSync(join(f.run.session_dir, "a2-n2.finalize.json")), true);
		assert.equal(await reserveRevision(f.run.session_dir, f.run.task_id, f.run.review_plan!, f.run.review_plan!.loops[0], 2), undefined);
		assert.equal(fs.existsSync(join(f.run.session_dir, "a2-n2.2.revision.json")), false);
		void reviewer;
	}

	// A-legacy-cause: legacy transition-only recovery infers budget exhaustion when no revision reservation exists even if saved review_plan has headroom.
	{
		const f = await runFixture(t, loopPlan);
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(complete("B1"));
		await reviewer.deliverNotification(builder);
		const resPath = resultPath(f.run.session_dir, "a2-n2.1");
		atomicJson(resPath, {
			version: 5,
			identity: { run_id: f.run.task_id, node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
			review_plan: f.run.review_plan,
			result: { agent_name: "second", ...complete("Rejected legacy", "revise") },
			delivery: "pending",
			recorded_at: "1970-01-01T00:16:40.000Z",
		});
		atomicJson(join(f.run.session_dir, "a2-n2.1.transition.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a2-n2", from_attempt: 1, winner: "finalized",
		});
		const recovered = readFinalization(f.run.session_dir, f.run.task_id, f.run.review_plan!.loops[0], "a2-n2");
		assert.equal(recovered?.exhausted?.reason, "Run attempt budget exhausted");
	}

	// A-finalized-transition-guard: force finalization on attempt 1 skips writing finalized transition when revision already won.
	{
		const f = await runFixture(t, loopPlan);
		await rejectFirstBuild(f);
		atomicJson(join(f.run.session_dir, "a1-n1.1.transition.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a1-n1", from_attempt: 1, winner: "revision", next_attempt: 2,
		});
		assert.doesNotThrow(() => finalizeReview(f.run.session_dir, f.run.task_id, f.run.review_plan!.loops[0], 1, undefined, "dispatcher", { force: true }));
		assert.equal(readLoopTransition(f.run.session_dir, f.run.task_id, "a1-n1", 1)?.winner, "revision");
	}

	// B-worker-sourceRecord: successor reading a reviewer with both saved rejection and cancelled disposition sees cancelled, not success.
	{
		const f = await runFixture(t, { ...loopPlan, agents: [...loopPlan.agents, publish] });
		const b = f.nodes.get("n1")!;
		const r = f.nodes.get("n2")!;
		const pub = f.nodes.get("publish")!;
		await b.complete(complete("B1"));
		await r.deliverNotification(b);
		const pending = r.complete(complete("R1", "revise"));
		await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "Cancel R1", grace_ms: 0 });
		await pending;
		fs.rmSync(dispositionPath(f.run.session_dir, "a3-publish.1"), { force: true });
		t.mock.timers.tick(2_000);
		const s = f.status();
		assert.deepEqual(s.worker_errors, []);
		assert.equal(s.agents[2].execution, "blocked");
		assert.deepEqual(s.agents[2].execution_causes, [{ node_id: "n2", state: "cancelled", reason: "Cancel R1" }]);
	}

	// B-cancel-scope-attempt: a cancel record scoped to attempt 1 does not cancel attempt 2.
	{
		const f = await runFixture(t, loopPlan);
		const { builder, reviewer } = await rejectFirstBuild(f);
		await builder.deliverNotification(reviewer);
		writeCancelRecord(f.run.session_dir, {
			identity: { run_id: f.run.task_id, node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1", instance_id: "a1-n1" },
			scope: "node", reason: "Stale attempt 1 cancel", requestedAt: "1970-01-01T00:16:40.000Z", graceMs: 0,
		});
		await builder.complete(complete("B2"));
		const s = f.status();
		assert.deepEqual(s.worker_errors, []);
		assert.equal(s.agents[0].execution, "succeeded");
		assert.equal(s.agents[0].summary, "B2");
	}

	// MERGE-lateDecision-suppress: late finalization appearing during reserveRevision suppresses revision handoff even when reservation exists.
	{
		const f = await runFixture(t, loopPlan);
		const b = f.nodes.get("n1")!;
		const r = f.nodes.get("n2")!;
		await b.complete(complete("B1"));
		await r.deliverNotification(b);
		let releaseBudget: (() => void) | undefined;
		const locked = new Promise<void>(resolve => {
			void withRunLock(join(f.run.session_dir, "review-budget"), () => {
				resolve();
				return new Promise<void>(release => { releaseBudget = release; });
			});
		});
		await locked;
		const pending = r.complete(complete("R1", "revise"));
		await new Promise<void>(resolve => setImmediate(resolve));
		atomicJson(join(f.run.session_dir, "a2-n2.2.revision.json"), {
			version: 1, run_id: f.run.task_id, reviewer: "a2-n2", attempt: 2,
		});
		atomicJson(join(f.run.session_dir, "a2-n2.finalize.json"), {
			version: 1, run_id: f.run.task_id, instance_id: "a2-n2", attempt_id: "a2-n2.1", finalized_by: "dispatcher",
		});
		releaseBudget?.();
		await pending;
		assert.equal(r.sent.some(call => call.name === "coms_send"), false);
		assert.equal(fs.existsSync(join(f.run.session_dir, "a1-n1.2.from-a2-n2.handoff-offer.json")), false);
	}
});

test("reused loop members receive explicit revision directives, injected messages, and attempt-scoped notifications", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);

	// Reviewer's attempt-2 feedback notification carries destination attempt and new-attempt wording.
	const feedbackNotif = builder.notificationFrom(reviewer);
	assert.match(feedbackNotif.message.content, /Destination attempt: a1-n1\.2\./);
	assert.match(feedbackNotif.message.content, /New attempt a1-n1\.2: treat earlier attempts as history/);

	// Target revision receives authoritative revision directive in systemPrompt and injected message.
	const targetRev = await builder.deliverNotification(reviewer);
	assert.match(targetRev?.systemPrompt ?? "", /Attempt: a1-n1\.2\./);
	assert.match(targetRev?.systemPrompt ?? "", /Revision directive: This is NEW attempt a1-n1\.2/);
	assert.match(targetRev?.systemPrompt ?? "", /do NOT complete attempt a1-n1\.2/);
	assert.equal(targetRev?.message?.customType, "bootstrap-revision-assignment");
	assert.match(targetRev?.message?.content ?? "", /NEW REVISION ASSIGNMENT — Attempt a1-n1\.2/);
	assert.match(targetRev?.message?.content ?? "", /Revise build/);

	// Completing attempt 2 routes attempt-2 handoff back to reviewer.
	const completeResp = await builder.complete(complete("Revised build"));
	assert.match(completeResp.content?.[0]?.text ?? "", /Result persisted for attempt a1-n1\.2;.*parked/);

	// Reviewer's attempt-2 re-review receives new-attempt directive and injected message.
	const reviewNotif = reviewer.notificationFrom(builder);
	assert.match(reviewNotif.message.content, /Destination attempt: a2-n2\.2\./);
	const reviewerRev = await reviewer.deliverNotification(builder);
	assert.match(reviewerRev?.systemPrompt ?? "", /Attempt: a2-n2\.2\./);
	assert.match(reviewerRev?.systemPrompt ?? "", /New attempt directive: This is NEW attempt a2-n2\.2/);
	assert.equal(reviewerRev?.message?.customType, "bootstrap-revision-assignment");
	assert.match(reviewerRev?.message?.content ?? "", /NEW ATTEMPT ASSIGNMENT — Attempt a2-n2\.2/);
});

test("a review handoff delivered during a parked agent's active turn starts a fresh admission after settlement", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	const overlap = async (receiver: typeof builder, sender: typeof reviewer, msgId: string, attemptId: string) => {
		const wake = receiver.notificationFrom(sender).message;
		const message = { ...wake, details: { ...wake.details, msg_id: msgId }, display: true, role: "custom" };
		const claim = join(f.run.session_dir, `${attemptId}.from-${sender.config.instance_id}.handoff.json`);
		// Pi injects a busy follow-up without firing before_agent_start. No claim or task tools in that turn.
		await receiver.hooks.get("message_start")!({ message });
		await receiver.deliverFollowUps();
		assert.equal(fs.existsSync(claim), false);
		assert.deepEqual(receiver.active, []);
		await receiver.hooks.get("agent_settled")!({ aborted: false });
		await receiver.deliverFollowUps();
		assert.equal(fs.existsSync(claim), true, "fresh start must claim the saved handoff");
		assert.ok(receiver.active.includes("bootstrap_complete"));
	};
	const wake = builder.notificationFrom(reviewer).message;
	const foreign = { ...wake, details: { msg_id: "foreign", sender_session: "another-session" }, display: true, role: "custom" };
	await builder.hooks.get("message_start")!({ message: foreign });
	await builder.hooks.get("agent_settled")!({ aborted: false });
	await builder.deliverFollowUps();
	assert.deepEqual(builder.active, []);
	assert.equal(fs.existsSync(join(f.run.session_dir, "a1-n1.2.from-a2-n2.handoff.json")), false, "deferred delivery cannot bypass sender validation");
	const aborts = builder.aborts;
	// A message from that rejected fresh start is not a new follow-up to requeue.
	await builder.hooks.get("message_start")!({ message: foreign });
	await builder.hooks.get("agent_settled")!({ aborted: true });
	await builder.deliverFollowUps();
	assert.equal(builder.aborts, aborts);

	await overlap(builder, reviewer, "feedback", "a1-n1.2");
	await builder.complete(complete("Revised"));
	await overlap(reviewer, builder, "rereview", "a2-n2.2");
	await reviewer.complete(complete("Approved", "approve"));
	assert.equal(f.status().outcome.state, "succeeded");
});

test("a rejected revision wake on a parked worker clears temporary selectedTools back to empty", async t => {
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	// Finalize attempt 1 so the incoming revision notification is rejected.
	finalizeReview(f.run.session_dir, f.run.task_id, builder.config.review_plan!.loops[0], 1, "done", "dispatcher");
	const options = { selectedTools: ["read", "bootstrap_complete"] };
	const notif = builder.notificationFrom(reviewer);
	await builder.beforeStart({ ...notif, systemPromptOptions: options });
	assert.deepEqual(options.selectedTools, [], "Rejected revision wake must clear temporary selectedTools");
	assert.deepEqual(builder.active, [], "Parked worker must retain empty active tools on rejected wake");
});

test("agent_before_settle issues at most one bounded completion reminder per attempt and skips error/completed/cancelled runs", async t => {
	const f = await runFixture(t, loopPlan);
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const beforeSettle = builder.hooks.get("agent_before_settle")!;
	assert.ok(beforeSettle, "worker must register agent_before_settle");

	// Error outcome must never trigger a continuation.
	assert.equal(await beforeSettle({ outcome: "error", entries: [] }, builder.context), undefined);

	// Normal plain-text settlement on attempt 1 triggers exactly one bounded reminder.
	const first = await beforeSettle({ outcome: "completed", entries: [] }, builder.context);
	assert.equal(first?.continue, true);
	assert.equal(first?.entries?.length, 1);
	assert.equal(first?.entries?.[0]?.customType, "bootstrap-completion-reminder");
	assert.match(first?.entries?.[0]?.content ?? "", /Attempt a1-n1\.1 is still active/);
	// Second invocation on the same attempt is bounded and returns undefined so agent_settled fails closed.
	assert.equal(await beforeSettle({ outcome: "completed", entries: [] }, builder.context), undefined);

	// Once attempt 1 completes, before_settle does nothing.
	await builder.complete(complete("Build 1"));
	assert.equal(await beforeSettle({ outcome: "completed", entries: [] }, builder.context), undefined);

	// On attempt 2, the worker gets a fresh single bounded reminder scoped to a1-n1.2.
	await reviewer.deliverNotification(builder);
	await reviewer.complete(complete("Revise build", "revise"));
	await builder.deliverNotification(reviewer);
	const second = await beforeSettle({ outcome: "completed", entries: [] }, builder.context);
	assert.equal(second?.continue, true);
	assert.match(second?.entries?.[0]?.content ?? "", /Attempt a1-n1\.2 is still active/);
	assert.match(second?.entries?.[0]?.content ?? "", /do NOT complete a1-n1\.2/);
	assert.equal(await beforeSettle({ outcome: "completed", entries: [] }, builder.context), undefined);

	// Cancelled worker never gets a completion reminder.
	const f2 = await runFixture(t, loopPlan);
	const b2 = f2.nodes.get("n1")!;
	writeCancelRecord(f2.run.session_dir, {
		identity: { run_id: f2.run.task_id, node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1", instance_id: "a1-n1" },
		scope: "node", reason: "cancelled", requestedAt: new Date().toISOString(), graceMs: 0,
	});
	assert.equal(await b2.hooks.get("agent_before_settle")!({ outcome: "completed", entries: [] }, b2.context), undefined);
});

test("reviewRoutes validates out-of-plan reservations before revisionLimit and never routes beyond max_revisions", async t => {
	const f = await runFixture(t, {
		...loopPlan,
		agents: [
			loopPlan.agents[0],
			{ ...review, decision: { ...review.decision, max_revisions: 1 } },
			publish,
		],
	});
	const dir = f.run.session_dir;
	const plan = f.run.review_plan!;
	const identity = { run_id: f.run.task_id, node_id: "n2", persona_name: "second", instance_id: "a2-n2", attempt_id: "a2-n2.2" };
	const rejected = { agent_name: "second", ...complete("Still rejected", "revise") };
	const outbound = ["a3-publish"];
	const roguePath = join(dir, "a2-n2.3.revision.json");

	// Missing out-of-plan reservation does not route.
	assert.deepEqual(reviewRoutes(dir, identity, plan, rejected, outbound), []);

	// Valid schema out-of-plan reservation at max_revisions + 2 still never routes.
	atomicJson(roguePath, { version: 1, run_id: f.run.task_id, reviewer: "a2-n2", attempt: 3 });
	assert.deepEqual(reviewRoutes(dir, identity, plan, rejected, outbound), []);

	// Corrupt, foreign, wrong-version, and symlinked out-of-plan reservations fail closed instead of short-circuiting.
	const target = join(f.root, "symlink-target.json");
	atomicJson(target, { version: 1, run_id: f.run.task_id, reviewer: "a2-n2", attempt: 3 });
	for (const corrupt of [
		() => fs.writeFileSync(roguePath, "{not json"),
		() => atomicJson(roguePath, { version: 1, run_id: "foreign-run", reviewer: "a2-n2", attempt: 3 }),
		() => atomicJson(roguePath, { version: 99, run_id: f.run.task_id, reviewer: "a2-n2", attempt: 3 }),
		() => { fs.rmSync(roguePath, { force: true }); fs.symlinkSync(target, roguePath); },
	]) {
		corrupt();
		assert.throws(() => reviewRoutes(dir, identity, plan, rejected, outbound), /revision reservation/i);
		fs.rmSync(roguePath, { force: true });
	}
});

test("review-loop completions terminate on queued feedback, approval, exhausted loop, and revision attempts, while failed feedback delivery keeps turn open", async t => {
	// 1. Rejection -> failed feedback delivery keeps turn open -> retry queues feedback & terminates -> builder wakes & completes attempt 2 & terminates -> reviewer approves & terminates.
	let failFeedbackSend = true;
	const f = await runFixture(t, { ...chain, agents: [chain.agents[0], { ...review, decision: { ...review.decision, max_revisions: 1 } }] }, new Map([
		["n2", {
			executeTool: async (name) => {
				if (name === "coms_send" && failFeedbackSend) {
					return { isError: true, content: [{ type: "text" as const, text: "feedback target unreachable" }] };
				}
				return { content: [{ type: "text" as const, text: "queued" }] };
			},
		}],
	]));
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;

	// Builder attempt 1 terminates and parks (does not shut down).
	const b1 = await builder.complete(complete("Build 1"));
	assert.equal(b1.terminate, true);
	assert.equal(b1.details.status, "saved");
	assert.equal(builder.shutdowns, 0);
	assert.deepEqual(builder.active, []);

	// Reviewer rejects with failed feedback delivery -> turn stays open.
	await reviewer.deliverNotification(builder);
	const r1Fail = await reviewer.complete(complete("Reject 1", "revise"));
	assert.equal(r1Fail.isError, true);
	assert.equal("terminate" in r1Fail, false);
	assert.equal(reviewer.shutdowns, 0);

	// Reviewer retries feedback delivery -> queued -> terminates and parks.
	failFeedbackSend = false;
	const r1Ok = await reviewer.complete(complete("Ignored", "revise"));
	assert.equal(r1Ok.terminate, true);
	assert.equal(r1Ok.details.status, "saved");
	assert.equal(reviewer.shutdowns, 0);
	assert.deepEqual(reviewer.active, []);

	// Builder wakes for attempt 2, completes, terminates, and parks again.
	await builder.deliverNotification(reviewer);
	assert.ok(builder.active.includes("bootstrap_complete"), "builder must unpark tools for attempt 2");
	const b2 = await builder.complete(complete("Build 2"));
	assert.equal(b2.terminate, true);
	assert.equal(b2.details.status, "saved");
	assert.equal(builder.shutdowns, 0);
	assert.deepEqual(builder.active, []);

	// Reviewer attempt 2 approves -> terminates with no outbound edge.
	await reviewer.deliverNotification(builder);
	const r2Approve = await reviewer.complete(complete("Approved", "approve"));
	assert.equal(r2Approve.terminate, true);
	assert.equal(r2Approve.details.status, "saved");

	// 2. Exhausted loop (no outbound handoff) also terminates for both on_exhausted policies.
	for (const onExhausted of ["needs_attention", "failed"] as const) {
		const fEx = await runFixture(t, {
			...chain,
			agents: [
				chain.agents[0],
				{ ...review, decision: { ...review.decision, max_revisions: 1, on_exhausted: onExhausted } },
				{ node_id: "n3", persona: "first", sub_task: "Publish" },
			],
		});
		const bEx = fEx.nodes.get("n1")!;
		const rEx = fEx.nodes.get("n2")!;
		await bEx.complete(complete("B1"));
		await rEx.deliverNotification(bEx);
		await rEx.complete(complete("R1", "revise"));
		await bEx.deliverNotification(rEx);
		await bEx.complete(complete("B2"));
		await rEx.deliverNotification(bEx);
		const r2Exhausted = await rEx.complete(complete("R2 exhausted", "revise"));
		assert.equal(r2Exhausted.terminate, true);
		assert.equal(r2Exhausted.details.status, "saved");
	}
});
