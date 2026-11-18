import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { publishFailFast } from "./ownership.ts";
import { createGraphWidgets } from "./graph-widget.ts";
import { atomicJson, readJson, resultPath, type WorkerCompletion } from "./session-store.ts";
import { buildMarkdownReport, formatAgentStates, formatCancelResult, formatRecovery, formatReportDigest, formatRunOutcome } from "./reporting.ts";
import { parseCompletion as readPreviousCompletion, parseWorkerConfig as readPreviousConfig, parseManifest as readPreviousManifest } from "./test-support/previous-v4-session-store.ts";
import { chain, runFixture } from "./test-support/chain-fixture.ts";

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
	const f = await runFixture(t, loopPlan);
	const { builder, reviewer } = await rejectFirstBuild(f);
	await builder.deliverNotification(reviewer);
	await builder.complete({ status: "failure", summary: "Revision broke the build", detail: "The build failed" });
	assert.match(states(f), /a2-n2 .*Revision broke the build.*\[execution blocked.*\[attempt 2\/3, finalized\]/);
	assert.match(await reportText(f), /Revision broke the build/);
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
	const f = await runFixture(t, { ...loopPlan, max_total_attempts: 4 });
	const first = await rejectFirstBuild(f);
	await first.builder.deliverNotification(first.reviewer);
	await first.builder.complete(complete("Only affordable revision"));
	const reviewer = await f.reload("n2");
	await reviewer.deliverNotification(first.builder);
	await reviewer.complete(complete("Rejected the only revision", "revise"));
	await f.reload("n1");
	await f.reload("n2");
	assert.match(states(f), /a1-n1 .*attempt 2\/3, finalized/);
	assert.match(states(f), /a2-n2 .*Run attempt budget exhausted.*attempt 2\/3, finalized/);
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
	assert.match(states(f), /a3-publish .*First review failed.*\[execution blocked/);
	assert.match(statusText(f), /Run outcome: failed/);
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
