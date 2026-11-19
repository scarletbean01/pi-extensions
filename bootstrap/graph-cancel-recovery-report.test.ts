import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelPath, claimOutcome, outcomeClaimPath, runCancelPath, writeCancelRecord, writeRunCancelRecord } from "./cancellation.ts";
import { handoffClaimPath, handoffOfferPath } from "./handoff.ts";
import { BootstrapService } from "./lifecycle.ts";
import { ownershipPath } from "./ownership.ts";
import { formatAgentStates, formatCancelResult, formatRecovery, formatReportDigest, buildMarkdownReport } from "./reporting.ts";
import { atomicJson, dispositionPath, readJson, resultPath, type WorkerCompletion } from "./session-store.ts";
import { model, runFixture, serviceFixture } from "./test-support/chain-fixture.ts";

const verdictContract = {
	required_fields: ["verdict"],
	properties: { verdict: { type: "string" as const, enum: ["approve", "changes_requested"] } },
};

const complete = (summary: string, verdict?: string) => ({
	status: "success",
	summary,
	detail: summary,
	...(verdict ? { outputs: { verdict } } : {}),
});

function assertOwnershipReleased(status: ReturnType<Awaited<ReturnType<typeof runFixture>>["status"]>) {
	for (const agent of status.agents) {
		assert.notEqual(agent.ownership_status, "admitted", `${agent.node_id} should have released ownership`);
	}
}

function twoBranchPlan(cwd: string, overrides?: {
	maxRevisionsA?: number;
	maxRevisionsB?: number;
	cleanup?: "on_success" | "manual";
	joinPolicy?: "all_success" | "allow_partial";
	dependencyWaitMs?: number;
	writePathsBuildA?: string[];
}) {
	return {
		topology: "graph" as const,
		task: "Two-branch review loops joining into merge",
		project_cwd: cwd,
		cleanup: overrides?.cleanup ?? ("manual" as const),
		agents: [
			{ node_id: "scout-a", persona: "first", sub_task: "Scout A" },
			{ node_id: "scout-b", persona: "first", sub_task: "Scout B" },
			{
				node_id: "build-a",
				persona: "second",
				depends_on: ["scout-a"],
				...(overrides?.writePathsBuildA ? { write_paths: overrides.writePathsBuildA } : {}),
				sub_task: "Build A",
			},
			{ node_id: "build-b", persona: "second", depends_on: ["scout-b"], sub_task: "Build B" },
			{
				node_id: "review-a",
				persona: "second",
				depends_on: ["build-a"],
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: {
					field: "verdict",
					approve: "approve",
					reject: "changes_requested",
					on_reject: "build-a",
					max_revisions: overrides?.maxRevisionsA ?? 3,
				},
			},
			{
				node_id: "review-b",
				persona: "second",
				depends_on: ["build-b"],
				sub_task: "Review B",
				output_contract: verdictContract,
				decision: {
					field: "verdict",
					approve: "approve",
					reject: "changes_requested",
					on_reject: "build-b",
					max_revisions: overrides?.maxRevisionsB ?? 3,
				},
			},
			{
				node_id: "merge",
				persona: "first",
				depends_on: ["review-a", "review-b"],
				...(overrides?.joinPolicy ? { join_policy: overrides.joinPolicy } : {}),
				...(overrides?.dependencyWaitMs !== undefined ? { dependency_wait_timeout_ms: overrides.dependencyWaitMs } : {}),
				sub_task: "Merge A and B",
			},
			{ node_id: "next", persona: "second", depends_on: ["merge"], sub_task: "Finalize" },
		],
	};
}

// ---- Acceptance 1: graph-aware cancellation ----

test("upstream node cancel in a graph settles downstream loop body, blocks join, keeps sibling branch, and releases ownership", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { writePathsBuildA: ["src/a.ts"] }), new Map(), { simulateShutdown: true });
	const scoutB = f.nodes.get("scout-b")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

	// Branch B completes and approves; branch A is cancelled at scout-a.
	await scoutB.complete(complete("Scout B ok"));
	await buildB.deliverNotification(scoutB);
	await buildB.complete(complete("Build B ok"));
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await merge.deliverNotification(reviewB);

	const scoutA = f.nodes.get("scout-a")!;
	const reason = "Abort branch A scout";
	const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["scout-a"], reason, grace_ms: 0 });
	assert.deepEqual(cancelRes.cancelling.map(c => c.node_id), ["scout-a"]);
	assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["build-a", "review-a", "merge", "next"]);
	await scoutA.hooks.get("agent_settled")!({ aborted: true }, scoutA.context);

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "blocked");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.pending, []);

	const scoutAState = st.agents.find(a => a.node_id === "scout-a")!;
	const buildAState = st.agents.find(a => a.node_id === "build-a")!;
	const reviewAState = st.agents.find(a => a.node_id === "review-a")!;
	const reviewBState = st.agents.find(a => a.node_id === "review-b")!;
	const mergeState = st.agents.find(a => a.node_id === "merge")!;
	const nextState = st.agents.find(a => a.node_id === "next")!;

	assert.equal(scoutAState.execution, "cancelled");
	assert.equal(scoutAState.execution_reason, reason);
	assert.equal(buildAState.execution, "blocked");
	assert.equal(buildAState.finalized, true);
	assert.deepEqual(buildAState.execution_causes, [{ node_id: "scout-a", state: "cancelled", reason }]);
	assert.equal(reviewAState.execution, "blocked");
	assert.equal(reviewAState.finalized, true);
	assert.equal(reviewBState.execution, "succeeded");
	assert.equal(reviewBState.finalized, true);
	assert.equal(mergeState.execution, "blocked");
	assert.deepEqual(mergeState.edge_states, { "review-a": "dead", "review-b": "fired" });
	assert.equal(mergeState.execution_causes.some(c => c.node_id === "scout-a" && c.state === "cancelled" && c.reason === reason), true);
	assert.equal(nextState.execution, "blocked");
	assertOwnershipReleased(st);

	const rep = await f.report();
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeRep.status, "blocked");
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "scout-a" && c.state === "cancelled"), true);
	assert.match(formatReportDigest(rep.results), /Verdict history: 1\/4 approve/);
});

test("cancelling a parked loop member in a graph settles that loop on one attempt, releases conflicting ownership, and blocks join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = twoBranchPlan(process.cwd(), { writePathsBuildA: ["src/shared.ts"] });
	plan.agents.push({ node_id: "outsider", persona: "first", write_paths: ["src/shared.ts"], sub_task: "Conflicting writer" } as any);

	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;
	const outsider = f.nodes.get("outsider")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);

	// Branch A rejects v1; build-a stays parked on v1 while review-a is parked on v1.
	await reviewA.complete(complete("Revise A 1", "changes_requested"));

	// While branch A is revising, outsider waits for ownership held by loop A.
	t.mock.timers.tick(1000);
	assert.equal(f.status().agents.find(a => a.node_id === "build-a")?.ownership_status, "admitted");
	assert.equal(f.status().agents.find(a => a.node_id === "outsider")?.ownership_status, "waiting");

	// Cancel parked build-a with grace_ms=5000, keeping review-b untouched.
	const reason = "Stop parked build-a before v2";
	const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["build-a"], reason, grace_ms: 5000 });
	assert.deepEqual(cancelRes.cancelled, ["build-a"]);
	assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["review-a", "merge", "next"]);

	// Late revision notification cannot run build-a v2 or approve loop A.
	assert.equal(await buildA.deliverNotification(reviewA), undefined);

	// Outsider is unblocked on ownership once loop A settles, and branch B finishes independently.
	t.mock.timers.tick(1000);
	await outsider.deliverFollowUps();
	await outsider.beforeStart();
	await outsider.complete(complete("Outsider ran after loop A settled"));
	await reviewB.complete(complete("Review B ok", "approve"));
	await merge.deliverNotification(reviewB);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "blocked");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.pending, []);

	const bA = st.agents.find(a => a.node_id === "build-a")!;
	const rA = st.agents.find(a => a.node_id === "review-a")!;
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(bA.attempt_id.endsWith(".2"), true);
	assert.equal(bA.execution, "cancelled");
	assert.equal(bA.execution_reason, reason);
	assert.equal(bA.finalized, true);
	assert.equal(rA.attempt_id.endsWith(".2"), true);
	assert.equal(rA.execution, "blocked");
	assert.equal(rA.finalized, true);
	assert.deepEqual(rA.execution_causes, [{ node_id: "build-a", state: "cancelled", reason }]);
	assert.deepEqual(mrg.edge_states, { "review-a": "dead", "review-b": "fired" });
	assert.equal(mrg.execution, "blocked");
	assert.equal(mrg.execution_causes.some(c => c.node_id === "build-a" && c.state === "cancelled" && c.reason === reason), true);
	assert.equal(st.agents.find(a => a.node_id === "review-b")?.execution, "succeeded");
	assert.equal(st.agents.find(a => a.node_id === "outsider")?.execution, "succeeded");
	assertOwnershipReleased(st);

	// Re-cancelling already-finalized build-b reports it as already_completed.
	const cancelBuildB = await f.service.cancel(f.run.task_id, { agents: ["build-b"], reason: "Close build-b", grace_ms: 2000 });
	assert.equal(cancelBuildB.already_completed.includes("build-b"), true);
});

test("cancelling an active loop node and force_closing after grace period closes only its tab and settles the graph", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd()), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewA.complete(complete("Revise A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA); // build-a is actively working on attempt 2

	const reason = "Abort running build-a v2";
	const req = await f.service.cancel(f.run.task_id, { agents: ["build-a"], reason, grace_ms: 3000 });
	assert.equal(req.cancelling.length, 1);
	assert.equal(req.cancelling[0].node_id, "build-a");
	assert.equal(req.cancelling[0].grace_remaining_ms, 3000);
	assert.equal(req.cancelling[0].force_close_allowed, false);

	await assert.rejects(
		f.service.cancel(f.run.task_id, { agents: ["build-a"], force_close: true }),
		/grace period elapses \(3000ms remaining\)/,
	);

	t.mock.timers.tick(3000);
	const forced = await f.service.cancel(f.run.task_id, { agents: ["build-a"], force_close: true });
	assert.deepEqual(forced.force_closed, ["build-a"]);
	assert.deepEqual(forced.cleanup_errors, []);

	// Branch B finishes normally after branch A was force-closed.
	await reviewB.complete(complete("Review B ok", "approve"));
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "blocked");
	assert.equal(st.outcome.terminal, true);
	assert.equal(st.agents.find(a => a.node_id === "build-a")?.resource, "closed");
	assert.equal(st.agents.find(a => a.node_id === "build-a")?.execution, "cancelled");
	assert.equal(st.agents.find(a => a.node_id === "build-a")?.finalized, true);
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.execution, "blocked");
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.finalized, true);
	assert.equal(st.agents.find(a => a.node_id === "review-b")?.execution, "succeeded");
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.deepEqual(st.agents.find(a => a.node_id === "merge")?.edge_states, { "review-a": "dead", "review-b": "fired" });
	assertOwnershipReleased(st);
});

test("cancelling a join loop target's parent and sequential multi-parent cancel keep all join causes", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const joinLoopPlan = {
		topology: "graph" as const,
		task: "Join feeds loop target",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "build", persona: "second", depends_on: ["left", "right"], sub_task: "Build" },
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
			},
			{ node_id: "next", persona: "first", depends_on: ["review"], sub_task: "Next" },
		],
	};
	const f = await runFixture(t, joinLoopPlan, new Map(), { simulateShutdown: true });
	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;

	await f.service.cancel(f.run.task_id, { agents: ["left"], reason: "Stop left", grace_ms: 0 });
	await left.hooks.get("agent_settled")!({ aborted: true }, left.context);
	await f.service.cancel(f.run.task_id, { agents: ["right"], reason: "Stop right", grace_ms: 0 });
	await right.hooks.get("agent_settled")!({ aborted: true }, right.context);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "blocked");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.pending, []);

	const buildState = st.agents.find(a => a.node_id === "build")!;
	assert.equal(buildState.execution, "blocked");
	assert.equal(buildState.finalized, true);
	assert.deepEqual(buildState.edge_states, { left: "dead", right: "dead" });
	assert.equal(buildState.execution_causes.some(c => c.node_id === "left" && c.state === "cancelled" && c.reason === "Stop left"), true);
	assert.equal(buildState.execution_causes.some(c => c.node_id === "right" && c.state === "cancelled" && c.reason === "Stop right"), true);
	assert.equal(st.agents.find(a => a.node_id === "review")?.finalized, true);
	assert.equal(st.agents.find(a => a.node_id === "next")?.execution, "blocked");
	assertOwnershipReleased(st);

	const rep = await f.report();
	const buildRep = rep.results.find(r => r.node_id === "build")!;
	assert.equal(buildRep.status, "blocked");
	assert.equal("causes" in buildRep && buildRep.causes.some(c => c.node_id === "left" && c.reason === "Stop left"), true);
	assert.equal("causes" in buildRep && buildRep.causes.some(c => c.node_id === "right" && c.reason === "Stop right"), true);
	const md = buildMarkdownReport(rep.results);
	assert.match(md, /left \(cancelled\): Stop left/);
	assert.match(md, /right \(cancelled\): Stop right/);
});

// ---- Acceptance 2: graph-aware bootstrap_recover ----

test("recover inspect detects an already-claimed join handoff and refuses retry_delivery", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Claimed join recovery inspection",
		cleanup: "manual",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", depends_on: ["left", "right"], sub_task: "Merge" },
			{ node_id: "next", persona: "first", depends_on: ["merge"], sub_task: "Next" },
		],
	});
	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;
	const merge = f.nodes.get("merge")!;

	await left.complete(complete("Left ok"));
	await right.complete(complete("Right ok"));
	await merge.deliverNotification(right); // Join claimed both handoffs and is running.

	const runningInspect = await f.service.recover(f.run.task_id, { action: "inspect" });
	const leftEdge = runningInspect.assessments.find(a => a.source.node_id === "left" && a.destination.node_id === "merge")!;
	const rightEdge = runningInspect.assessments.find(a => a.source.node_id === "right" && a.destination.node_id === "merge")!;
	assert.deepEqual([leftEdge.stage, leftEdge.verdict], ["accepted_running", "wait"]);
	assert.deepEqual([rightEdge.stage, rightEdge.verdict], ["accepted_running", "wait"]);

	let woken = 0;
	const refusedRunning = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge", source: "left" }, {
		senderSession: "dispatcher",
		wake: async () => { woken++; },
	});
	assert.ok(refusedRunning.refused);
	assert.equal(woken, 0);

	// If merge exits after claiming without a result, inspect reports claimed_unfinished and never replays.
	merge.vanish();
	const deadInspect = await f.service.recover(f.run.task_id, { action: "inspect" });
	const deadLeft = deadInspect.assessments.find(a => a.source.node_id === "left" && a.destination.node_id === "merge")!;
	assert.deepEqual([deadLeft.stage, deadLeft.verdict], ["claimed_unfinished", "needs_attention"]);
	const refusedDead = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge", source: "left" }, {
		senderSession: "dispatcher",
		wake: async () => { woken++; },
	});
	assert.ok(refusedDead.refused);
	assert.equal(woken, 0);
});

test("recover inspects every edge and attempt across fan-out, parallel loops, feedback, and join, and repairs only unclaimed attempt-scoped handoffs", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	let failFeedback = false;
	let failForwardA = false;
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map([
		["review-a", {
			executeTool: async (_name: string, params: unknown) => {
				const target = String((params as { target?: string })?.target ?? "");
				if (failFeedback && target.includes("build-a")) return { isError: true, content: [{ type: "text", text: "feedback coms down" }] };
				if (failForwardA && target.includes("merge")) return { isError: true, content: [{ type: "text", text: "merge coms down" }] };
				return { content: [], details: { msg_id: "msg1" } };
			},
		}],
	]), { simulateShutdown: true });

	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;
	const next = f.nodes.get("next")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);

	// Branch B approves attempt 1 and offers to merge; branch A rejects attempt 1 with failed feedback delivery.
	await reviewB.complete(complete("Review B ok", "approve"));
	failFeedback = true;
	await reviewA.complete(complete("Reject A 1", "changes_requested"));
	failFeedback = false;

	const inspect1 = await f.service.recover(f.run.task_id, { action: "inspect" });
	assert.deepEqual(inspect1.record_errors ?? [], []);
	// Every edge is present, including review-a -> merge (waiting on revision) and review-b -> merge (waiting on sibling review-a).
	const feedbackEdge = inspect1.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "build-a")!;
	const forwardA = inspect1.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "merge")!;
	const forwardB = inspect1.assessments.find(a => a.source.node_id === "review-b" && a.destination.node_id === "merge")!;
	assert.equal(feedbackEdge.source.attempt_id, `${reviewA.config.instance_id}.1`);
	assert.equal(feedbackEdge.destination.attempt_id, `${buildA.config.instance_id}.2`);
	assert.deepEqual([feedbackEdge.stage, feedbackEdge.verdict], ["deliverable", "retry_delivery"]);
	assert.deepEqual([forwardA.stage, forwardA.verdict], ["source_unfinished", "wait"]);
	assert.deepEqual([forwardB.stage, forwardB.verdict], ["awaiting_destination", "wait"]);
	assert.match(forwardB.reason, /awaiting other inbound edges \(review-a\)/);

	// Repair feedback edge review-a.1 -> build-a.2.
	const wokenFeedback: Array<{ target: string; prompt: string }> = [];
	const retriedFeedback = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "build-a" }, {
		senderSession: "dispatcher",
		wake: async (target, prompt) => { wokenFeedback.push({ target, prompt }); },
	});
	assert.equal(retriedFeedback.refused, undefined);
	assert.equal(wokenFeedback.length, 1);
	await buildA.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", content: wokenFeedback[0].prompt, details: { sender_session: "dispatcher" } },
	});
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);

	// Attempt 2 approves, but forward delivery to merge fails and review-a exits.
	failForwardA = true;
	await reviewA.complete(complete("Review A v2 ok", "approve"));
	failForwardA = false;
	reviewA.vanish();

	const inspect2 = await f.service.recover(f.run.task_id, { action: "inspect" });
	// All attempt-1 and attempt-2 loop edges are present and completed; only review-a.2 -> merge.1 is deliverable.
	assert.equal(inspect2.assessments.find(a => a.source.node_id === "build-a" && a.source.attempt_id?.endsWith(".1"))?.stage, "completed");
	assert.equal(inspect2.assessments.find(a => a.source.node_id === "build-a" && a.source.attempt_id?.endsWith(".2"))?.stage, "completed");
	assert.equal(inspect2.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "build-a" && a.destination.attempt_id?.endsWith(".2"))?.stage, "completed");
	const deliverableForwardA = inspect2.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "merge")!;
	assert.equal(deliverableForwardA.source.attempt_id, `${reviewA.config.instance_id}.2`);
	assert.deepEqual([deliverableForwardA.stage, deliverableForwardA.verdict], ["deliverable", "retry_delivery"]);
	assert.deepEqual(
		inspect2.assessments.filter(a => a.verdict === "retry_delivery").map(a => `${a.source.node_id}->${a.destination.node_id}`).sort(),
		["review-a->merge", "review-b->merge"],
	);

	// retry_delivery on join merge without source must reject naming both parents.
	await assert.rejects(
		() => f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge" }, { senderSession: "dispatcher", wake: async () => {} }),
		/multiple inbound edges \(review-a, review-b\).*source/i,
	);

	// Repair review-a.2 -> merge.1 with explicit source.
	const wokenMerge: Array<{ target: string; prompt: string }> = [];
	const retriedMerge = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge", source: "review-a" }, {
		senderSession: "dispatcher",
		wake: async (target, prompt) => { wokenMerge.push({ target, prompt }); },
	});
	assert.equal(retriedMerge.refused, undefined);
	assert.equal(wokenMerge.length, 1);
	await merge.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", content: wokenMerge[0].prompt, details: { sender_session: "dispatcher" } },
	});
	await merge.complete(complete("Merged"));
	await next.deliverNotification(merge);
	await next.complete(complete("Next ok"));

	const finalSt = f.status();
	assert.deepEqual(finalSt.worker_errors, []);
	assert.equal(finalSt.outcome.state, "succeeded");
	assert.equal(finalSt.outcome.terminal, true);
	assertOwnershipReleased(finalSt);
});

test("recover inspect reports exhausted or dead-member loop edges as non-retryable and never reconstructs missing results", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 1, cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Reject A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Reject A 2", "changes_requested")); // Exhausted!

	const inspectBeforeTick = await f.service.recover(f.run.task_id, { action: "inspect" });
	assert.equal(inspectBeforeTick.assessments.some(a => a.verdict === "retry_delivery"), false);
	const revAMerge = inspectBeforeTick.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "merge")!;
	const revBMerge = inspectBeforeTick.assessments.find(a => a.source.node_id === "review-b" && a.destination.node_id === "merge")!;
	assert.deepEqual([revAMerge.stage, revAMerge.verdict], ["source_not_executed", "none"]);
	assert.deepEqual([revBMerge.stage, revBMerge.verdict], ["destination_ended", "none"]);
	assert.match(revBMerge.reason, /blocked by review-a/);

	// Refused retry_delivery leaves nothing sent.
	let woken = 0;
	const refused = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge", source: "review-b" }, {
		senderSession: "dispatcher",
		wake: async () => { woken++; },
	});
	assert.ok(refused.refused);
	assert.equal(woken, 0);
	assert.doesNotMatch(formatRecovery(inspectBeforeTick), /retry_delivery/);

	// Dead-member loop case: build-a claims attempt 2 after review-a rejects v1, then vanishes without writing v2's result.
	const f2 = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 2, cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const sA2 = f2.nodes.get("scout-a")!;
	const sB2 = f2.nodes.get("scout-b")!;
	const bA2 = f2.nodes.get("build-a")!;
	const bB2 = f2.nodes.get("build-b")!;
	const rA2 = f2.nodes.get("review-a")!;
	const rB2 = f2.nodes.get("review-b")!;

	await sA2.complete(complete("Scout A"));
	await sB2.complete(complete("Scout B"));
	await bA2.deliverNotification(sA2);
	await bB2.deliverNotification(sB2);
	await bA2.complete(complete("Build A v1 only"));
	await bB2.complete(complete("Build B v1"));
	await rA2.deliverNotification(bA2);
	await rB2.deliverNotification(bB2);
	await rB2.complete(complete("Approve B", "approve"));
	await rA2.complete(complete("Revise A 1", "changes_requested"));
	await bA2.deliverNotification(rA2); // build-a starts attempt 2, never completes
	bA2.vanish();

	const deadInspect = await f2.service.recover(f2.run.task_id, { action: "inspect" });
	assert.equal(deadInspect.assessments.some(a => a.verdict === "retry_delivery"), false);
	const deadLoopEdge = deadInspect.assessments.find(a =>
		a.source.node_id === "build-a" && a.source.attempt_id?.endsWith(".2") && a.destination.node_id === "review-a",
	)!;
	assert.ok(deadLoopEdge, "attempt 2 loop edge should be inspected");
	assert.equal(deadLoopEdge.stage, "source_unfinished");
	assert.equal(deadLoopEdge.verdict, "needs_attention");
	const stDead = f2.status();
	assert.equal(stDead.agents.find(a => a.node_id === "build-a")?.attempt_id.endsWith(".2"), true);
	assert.equal(stDead.results.find(r => r.node_id === "build-a"), undefined);
	assert.match(stDead.worker_errors.join("\n"), /accepted handoff.*no result was recorded.*not replayed automatically/);
	await assert.rejects(
		() => f2.service.report(f2.run.task_id, undefined, true, buildMarkdownReport),
		/no result was recorded and the task is not replayed automatically/,
	);

	let wokenDead = 0;
	const refusedDead = await f2.service.recover(f2.run.task_id, { action: "retry_delivery", agent: "review-a", source: "build-a" }, {
		senderSession: "dispatcher",
		wake: async () => { wokenDead++; },
	});
	assert.ok(refusedDead.refused);
	assert.equal(wokenDead, 0);
});

// ---- Acceptance 3: bootstrap_report lists blocked join causes alongside attempt and verdict history ----

test("bootstrap_report lists causes of blocked joins alongside attempt and verdict history across parallel loops", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 2, maxRevisionsB: 1, cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);

	// Branch A revises once and approves; branch B exhausts revisions.
	await reviewA.complete(complete("Revise A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Approve A 2", "approve"));

	await reviewB.complete(complete("Revise B 1", "changes_requested"));
	await buildB.deliverNotification(reviewB);
	await buildB.complete(complete("Build B v2"));
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Reject B 2", "changes_requested"));

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assertOwnershipReleased(st);

	const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	const revARep = rep.results.find(r => r.node_id === "review-a")!;
	const revBRep = rep.results.find(r => r.node_id === "review-b")!;

	assert.equal(mergeRep.status, "blocked");
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "review-b" && c.state === "needs_attention" && /exhausted/i.test(c.reason)), true);
	assert.equal(revARep.review_history?.attempts.length, 2);
	assert.deepEqual(revARep.review_history?.attempts.map(a => a.verdict), ["changes_requested", "approve"]);
	assert.equal(revBRep.review_history?.attempts.length, 2);
	assert.deepEqual(revBRep.review_history?.attempts.map(a => a.verdict), ["changes_requested", "changes_requested"]);

	const digest = formatReportDigest(rep.results);
	assert.match(digest, /merge[^:]*: blocked .*caused by review-b needs_attention/);
	assert.match(digest, /Verdict history: 1\/3 changes_requested → 2\/3 approve/);
	assert.match(digest, /Verdict history: 1\/2 changes_requested → 2\/2 changes_requested/);

	const md = buildMarkdownReport(rep.results);
	assert.match(md, /### ⛔ merge[\s\S]*Caused by:\n\s+- review-b \(needs_attention\): .*exhausted/);
	assert.match(md, /### ⚠️ review-b[\s\S]*Verdict history: 1\/2 changes_requested → 2\/2 changes_requested/);
});

test("bootstrap_report lists both blocked join causes after mixed failure and cancellation alongside attempt and verdict history", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);

	// Branch A rejects v1 then build-a fails v2 -> review-a blocked.
	await reviewA.complete(complete("Revise A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA);
	await buildA.complete({ status: "failure", summary: "Build A v2 crashed", detail: "compile error" });
	t.mock.timers.tick(1000);

	// Branch B is cancelled at review-b with caller's reason.
	await f.service.cancel(f.run.task_id, { agents: ["review-b"], reason: "Operator cancelled review-b", grace_ms: 0 });
	await reviewB.hooks.get("agent_settled")!({ aborted: true }, reviewB.context);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "failed");
	assert.equal(st.outcome.terminal, true);
	assertOwnershipReleased(st);

	const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeRep.status, "blocked");
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "build-a" && c.state === "failed"), true);
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "review-b" && c.state === "cancelled" && c.reason === "Operator cancelled review-b"), true);

	const md = buildMarkdownReport(rep.results);
	assert.match(md, /### ⛔ merge[\s\S]*build-a \(failed\): Build A v2 crashed/);
	assert.match(md, /### ⛔ merge[\s\S]*review-b \(cancelled\): Operator cancelled review-b/);
	assert.match(md, /### ⛔ review-a[\s\S]*Attempt 1\/4: succeeded — Revise A 1[\s\S]*Attempt 2\/4: blocked/);
});

test("sequential failure and cancellation on a plain join keep both causes in status and report", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Plain join sequential causes",
		cleanup: "manual",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", depends_on: ["left", "right"], sub_task: "Merge" },
			{ node_id: "next", persona: "first", depends_on: ["merge"], sub_task: "Next" },
		],
	});
	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;

	await left.complete({ status: "failure", summary: "Left exploded", detail: "" });
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "blocked");

	await f.service.cancel(f.run.task_id, { agents: ["right"], reason: "Right stopped", grace_ms: 0 });
	await right.hooks.get("agent_settled")!({ aborted: true }, right.context);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "failed");
	assert.equal(st.outcome.terminal, true);
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.deepEqual(mrg.edge_states, { left: "dead", right: "dead" });
	assert.equal(mrg.execution_causes.some(c => c.node_id === "left" && c.state === "failed"), true);
	assert.equal(mrg.execution_causes.some(c => c.node_id === "right" && c.state === "cancelled" && c.reason === "Right stopped"), true);
	assertOwnershipReleased(st);

	const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
	const md = buildMarkdownReport(rep.results);
	assert.match(md, /### ⛔ merge[\s\S]*left \(failed\): Left exploded/);
	assert.match(md, /### ⛔ merge[\s\S]*right \(cancelled\): Right stopped/);
});

test("cancelling parked middle node in a 3-node loop inside a graph settles all loop members, blocks join, and reports history", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = twoBranchPlan(process.cwd(), { maxRevisionsA: 2, cleanup: "manual" });
	const revIdx = plan.agents.findIndex(a => a.node_id === "review-a");
	plan.agents[revIdx].depends_on = ["mid-a"];
	plan.agents.splice(revIdx, 0, { node_id: "mid-a", persona: "second", depends_on: ["build-a"], sub_task: "Middle A" });

	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const midA = f.nodes.get("mid-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await midA.deliverNotification(buildA);
	await midA.complete(complete("Mid A v1"));
	await reviewA.deliverNotification(midA);
	await reviewA.complete(complete("Revise A 1", "changes_requested"));

	await buildB.complete(complete("Build B v1"));
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Approve B", "approve"));

	const reason = "Stop parked mid-a before v2";
	const res = await f.service.cancel(f.run.task_id, { agents: ["mid-a"], reason, grace_ms: 0 });
	assert.deepEqual(res.cancelled, ["mid-a"]);

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "blocked");
	assert.equal(st.outcome.terminal, true);
	for (const id of ["build-a", "mid-a", "review-a"]) {
		const a = st.agents.find(x => x.node_id === id)!;
		assert.equal(a.attempt_id.endsWith(".2"), true, `${id} should settle on attempt 2`);
		assert.equal(a.finalized, true, `${id} should be finalized`);
	}
	assert.equal(st.agents.find(a => a.node_id === "mid-a")?.execution, "cancelled");
	assert.equal(st.agents.find(a => a.node_id === "mid-a")?.execution_reason, reason);
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.execution, "blocked");
	assert.equal(st.agents.find(a => a.node_id === "review-b")?.execution, "succeeded");
	assert.deepEqual(st.agents.find(a => a.node_id === "merge")?.edge_states, { "review-a": "dead", "review-b": "fired" });
	assertOwnershipReleased(st);

	const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeRep.status, "blocked");
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "mid-a" && c.state === "cancelled" && c.reason === reason), true);
	const md = buildMarkdownReport(rep.results);
	assert.match(md, /### ⛔ merge[\s\S]*mid-a \(cancelled\): Stop parked mid-a before v2/);
	assert.match(md, /### ⛔ review-a[\s\S]*Verdict history: 1\/3 changes_requested/);
});

test("cancelling a waiting node immediately settles downstream loop before timer ticks and closes forward join edge", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = {
		topology: "graph" as const,
		task: "Upstream pre-node into branch-A loop joining with scout-b",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "pre", persona: "first", sub_task: "Pre" },
			{ node_id: "scout-a", persona: "first", depends_on: ["pre"], sub_task: "Scout A" },
			{ node_id: "scout-b", persona: "first", sub_task: "Scout B" },
			{ node_id: "build-a", persona: "second", depends_on: ["scout-a"], sub_task: "Build A" },
			{
				node_id: "review-a",
				persona: "second",
				depends_on: ["build-a"],
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: {
					field: "verdict",
					approve: "approve",
					reject: "changes_requested",
					on_reject: "build-a",
					max_revisions: 3,
				},
			},
			{
				node_id: "merge",
				persona: "third",
				depends_on: ["review-a", "scout-b"],
				wait_for: "all" as const,
				join_policy: "all_success" as const,
				sub_task: "Merge",
			},
		],
	};

	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const pre = f.nodes.get("pre")!;
	const scoutB = f.nodes.get("scout-b")!;

	await pre.complete(complete("Pre ok"));
	await scoutB.complete(complete("Scout B ok"));

	// scout-a has not been delivered pre's completion (waiting/idle), so cancel settles immediately.
	const reason = "Cancel unstarted scout-a before loop A begins";
	const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["scout-a"], reason, grace_ms: 0 });
	assert.deepEqual(cancelRes.cancelled, ["scout-a"]);
	assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["build-a", "review-a", "merge"]);

	// Read status immediately with ZERO timer ticks: downstream loop must already be finalized and terminal.
	const stImmediate = f.status();
	assert.deepEqual(stImmediate.worker_errors, []);
	assert.equal(stImmediate.outcome.state, "blocked");
	assert.equal(stImmediate.outcome.terminal, true);
	assert.deepEqual(stImmediate.pending, []);
	const bAImm = stImmediate.agents.find(a => a.node_id === "build-a")!;
	const rAImm = stImmediate.agents.find(a => a.node_id === "review-a")!;
	const mImm = stImmediate.agents.find(a => a.node_id === "merge")!;
	assert.equal(bAImm.execution, "blocked");
	assert.equal(bAImm.finalized, true);
	assert.equal(rAImm.execution, "blocked");
	assert.equal(rAImm.finalized, true);
	assert.equal(mImm.execution, "blocked");
	assert.deepEqual(mImm.edge_states, { "review-a": "dead", "scout-b": "fired" });
	assert.equal(mImm.execution_causes.some(c => c.node_id === "scout-a" && c.state === "cancelled" && c.reason === reason), true);
	assertOwnershipReleased(stImmediate);

	// Ticking timers afterwards converges cleanly to the same state and report.
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	const stAfter = f.status();
	assert.deepEqual(stAfter.worker_errors, []);
	assert.equal(stAfter.outcome.state, "blocked");
	assert.equal(stAfter.outcome.terminal, true);
	assert.deepEqual(stAfter.pending, []);
	assert.equal(stAfter.agents.find(a => a.node_id === "build-a")?.finalized, true);
	assert.equal(stAfter.agents.find(a => a.node_id === "review-a")?.finalized, true);
	assert.deepEqual(stAfter.agents.find(a => a.node_id === "merge")?.edge_states, { "review-a": "dead", "scout-b": "fired" });
	assertOwnershipReleased(stAfter);

	const rep = await f.report();
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeRep.status, "blocked");
	assert.equal("causes" in mergeRep && mergeRep.causes.some(c => c.node_id === "scout-a" && c.state === "cancelled" && c.reason === reason), true);
});

test("propagateBlockedChain records exhausted loop forward-edge cause in inbound depends_on order", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = {
		topology: "graph" as const,
		task: "Exhausted review loop A + cancelled waiting scout-b at merge",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "scout-a", persona: "first", sub_task: "Scout A" },
			{ node_id: "pre-b", persona: "first", sub_task: "Pre B" },
			{ node_id: "scout-b", persona: "first", depends_on: ["pre-b"], sub_task: "Scout B" },
			{ node_id: "build-a", persona: "second", depends_on: ["scout-a"], sub_task: "Build A" },
			{
				node_id: "review-a",
				persona: "second",
				depends_on: ["build-a"],
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: {
					field: "verdict",
					approve: "approve",
					reject: "changes_requested",
					on_reject: "build-a",
					max_revisions: 1,
				},
			},
			{
				node_id: "merge",
				persona: "third",
				depends_on: ["review-a", "scout-b"],
				wait_for: "all" as const,
				join_policy: "all_success" as const,
				sub_task: "Merge",
			},
		],
	};

	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const preB = f.nodes.get("pre-b")!;
	const buildA = f.nodes.get("build-a")!;
	const reviewA = f.nodes.get("review-a")!;

	// Exhaust loop A: attempt 1 reject -> attempt 2 reject.
	await scoutA.complete(complete("Scout A"));
	await buildA.deliverNotification(scoutA);
	await buildA.complete(complete("Build A v1"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Reject A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Reject A 2", "changes_requested"));

	// Complete pre-b without delivering to scout-b, then cancel waiting scout-b.
	await preB.complete(complete("Pre B ok"));
	const cancelReason = "Cancel waiting scout-b after loop A exhaustion";
	const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["scout-b"], reason: cancelReason, grace_ms: 0 });
	assert.deepEqual(cancelRes.cancelled, ["scout-b"]);
	assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["merge"]);

	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mrg.execution, "blocked");
	assert.deepEqual(mrg.edge_states, { "review-a": "dead", "scout-b": "dead" });
	assert.deepEqual(mrg.execution_causes.map(c => c.node_id), ["review-a", "scout-b"]);
	assert.match(mrg.execution_reason ?? "", /^Review loop exhausted/);
	assertOwnershipReleased(st);

	const rep = await f.report();
	const mergeRep = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeRep.status, "blocked");
	assert.deepEqual("causes" in mergeRep ? mergeRep.causes.map(c => c.node_id) : [], ["review-a", "scout-b"]);
});

test("mismatched or unsupported cancel records fail closed without review_plan attempt-id exceptions", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const loopFreePlan = {
		topology: "graph" as const,
		task: "Loop-free join for cancel record validation",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{
				node_id: "merge",
				persona: "second",
				depends_on: ["left", "right"],
				wait_for: "all" as const,
				join_policy: "all_success" as const,
				sub_task: "Merge",
			},
		],
	};

	const f1 = await runFixture(t, loopFreePlan, new Map(), { simulateShutdown: true });
	const left1 = f1.nodes.get("left")!;
	writeCancelRecord(f1.run.session_dir, {
		scope: "agents",
		requestedAt: new Date(1_000_000).toISOString(),
		graceMs: 0,
		reason: "Mismatched attempt",
		identity: {
			run_id: f1.run.task_id,
			node_id: "left",
			persona_name: left1.config.persona_name,
			instance_id: left1.config.instance_id,
			attempt_id: `${left1.config.instance_id}.2`,
		},
	});

	const st1 = f1.status();
	assert.equal(st1.outcome.state, "needs_attention");
	assert.match(st1.worker_errors.join("\n"), /cancel identity mismatch/);
	await assert.rejects(
		() => f1.service.cancel(f1.run.task_id, { agents: ["left"], reason: "Force", force_close: true }),
		/cancel identity mismatch/,
	);

	// Unsupported version fails closed under review_plan as well.
	const f2 = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const buildA2 = f2.nodes.get("build-a")!;
	atomicJson(cancelPath(f2.run.session_dir, buildA2.config.instance_id), {
		version: 99,
		scope: "agents",
		requested_at: new Date(1_000_000).toISOString(),
		grace_ms: 0,
		reason: "Bad version",
		identity: {
			run_id: f2.run.task_id,
			node_id: "build-a",
			persona_name: buildA2.config.persona_name,
			instance_id: buildA2.config.instance_id,
		},
	});

	const st2 = f2.status();
	assert.equal(st2.outcome.state, "needs_attention");
	assert.match(st2.worker_errors.join("\n"), /Unsupported cancel record version 99/);
	await assert.rejects(
		() => f2.service.cancel(f2.run.task_id, { agents: ["build-a"], reason: "Force", force_close: true }),
		/Unsupported cancel record version 99/,
	);
});

test("standalone loop-free join recovery waits before merge writes blocked disposition and stops once blocked", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const join3Plan = {
		topology: "graph" as const,
		task: "Loop-free 3-parent join recovery timing",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "mid", persona: "first", sub_task: "Mid" },
			{
				node_id: "merge",
				persona: "second",
				depends_on: ["left", "right", "mid"],
				wait_for: "all" as const,
				join_policy: "all_success" as const,
				sub_task: "Merge",
			},
		],
	};

	const f = await runFixture(t, join3Plan, new Map([
		["left", {
			executeTool: async () => ({ isError: true, content: [{ type: "text", text: "merge coms down" }] }),
		}],
	]), { simulateShutdown: true });

	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;
	const mid = f.nodes.get("mid")!;

	await left.complete(complete("Left ok"));
	await right.complete({ status: "failure", summary: "Right failed", detail: "Right failed" });

	// Before merge's timer writes the blocked disposition, mid is still pending -> left->merge waits.
	const inspectBeforeTick = await f.service.recover(f.run.task_id, { action: "inspect" });
	const edgeBefore = inspectBeforeTick.assessments.find(a => a.source.node_id === "left" && a.destination.node_id === "merge")!;
	assert.deepEqual([edgeBefore.stage, edgeBefore.verdict], ["awaiting_destination", "wait"]);
	assert.match(edgeBefore.reason, /awaiting other inbound edges \(mid\)/);

	// After timers run, merge writes its blocked disposition -> left->merge reports destination_ended / none.
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);
	const inspectAfterTick = await f.service.recover(f.run.task_id, { action: "inspect" });
	const edgeAfter = inspectAfterTick.assessments.find(a => a.source.node_id === "left" && a.destination.node_id === "merge")!;
	assert.deepEqual([edgeAfter.stage, edgeAfter.verdict], ["destination_ended", "none"]);
	assert.match(edgeAfter.reason, /never executed \(blocked\)/);

	await mid.complete(complete("Mid ok"));
	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "failed");
	assert.equal(st.outcome.terminal, true);
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assertOwnershipReleased(st);
});

test("recover inspect and retry_delivery repair failed feedback to a join node that is also a loop target", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	let failFeedback = false;
	const plan = {
		topology: "graph" as const,
		task: "Join node as review loop target",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "l", persona: "first", sub_task: "Left" },
			{ node_id: "r", persona: "first", sub_task: "Right" },
			{ node_id: "b", persona: "second", depends_on: ["l", "r"], sub_task: "Build" },
			{
				node_id: "rv",
				persona: "second",
				depends_on: ["b"],
				sub_task: "Review",
				output_contract: verdictContract,
				decision: {
					field: "verdict",
					approve: "approve",
					reject: "changes_requested",
					on_reject: "b",
					max_revisions: 2,
				},
			},
			{ node_id: "z", persona: "first", depends_on: ["rv"], sub_task: "Final" },
		],
	};

	const f = await runFixture(t, plan, new Map([
		["rv", {
			executeTool: async (_name: string, params: unknown) => {
				const target = String((params as { target?: string })?.target ?? "");
				const bId = f.run.pane_manifest.find(e => e.node_id === "b")!.instance_id;
				if (failFeedback && target.includes(bId)) {
					return { isError: true, content: [{ type: "text", text: "feedback coms down" }] };
				}
				return { content: [], details: { msg_id: "msg1" } };
			},
		}],
	]), { simulateShutdown: true });

	const l = f.nodes.get("l")!;
	const r = f.nodes.get("r")!;
	const b = f.nodes.get("b")!;
	const rv = f.nodes.get("rv")!;
	const z = f.nodes.get("z")!;

	await l.complete(complete("L ok"));
	await r.complete(complete("R ok"));
	await b.deliverNotification(r);
	await b.complete(complete("B v1 ok"));
	await rv.deliverNotification(b);

	failFeedback = true;
	await rv.complete(complete("Revise B", "changes_requested"));
	failFeedback = false;

	const inspect = await f.service.recover(f.run.task_id, { action: "inspect" });
	assert.deepEqual(inspect.record_errors ?? [], []);
	const feedbackEdge = inspect.assessments.find(a => a.source.node_id === "rv" && a.destination.node_id === "b")!;
	assert.ok(feedbackEdge);
	assert.equal(feedbackEdge.source.attempt_id, `${rv.config.instance_id}.1`);
	assert.equal(feedbackEdge.destination.attempt_id, `${b.config.instance_id}.2`);
	assert.deepEqual([feedbackEdge.stage, feedbackEdge.verdict], ["deliverable", "retry_delivery"]);

	const woken: string[] = [];
	const retry = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "b" }, {
		senderSession: "dispatcher",
		wake: async (_target, prompt) => { woken.push(prompt); },
	});
	assert.equal(retry.refused, undefined);
	assert.equal(woken.length, 1);

	await b.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", content: woken[0], details: { sender_session: "dispatcher" } },
	});
	await b.complete(complete("B v2 ok"));
	await rv.deliverNotification(b);
	await rv.complete(complete("Approved", "approve"));
	await z.deliverNotification(rv);
	await z.complete(complete("Z ok"));

	t.mock.timers.tick(3000);
	const st = f.status();
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "succeeded");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.agents.map(a => `${a.node_id}:${a.execution}`), [
		"l:succeeded", "r:succeeded", "b:succeeded", "rv:succeeded", "z:succeeded",
	]);
	assertOwnershipReleased(st);

	const rep = await f.report();
	assert.equal(rep.results.every(res => res.status === "success"), true);
});

test("blocked join cause enrichment across nested blocked chains is independent of plan order", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const baseAgents = [
		{ node_id: "l", persona: "first", sub_task: "L" },
		{ node_id: "m", persona: "first", sub_task: "M" },
		{ node_id: "j", persona: "second", depends_on: ["l", "m"], sub_task: "J" },
		{ node_id: "z", persona: "first", depends_on: ["j"], sub_task: "Z" },
		{ node_id: "y", persona: "second", depends_on: ["z"], sub_task: "Y" },
	];

	const runWithOrder = async (agents: typeof baseAgents) => {
		const f = await runFixture(t, {
			topology: "graph",
			task: "Order-independent blocked join causes",
			cleanup: "manual",
			agents,
		}, new Map(), { simulateShutdown: true });
		const l = f.nodes.get("l")!;
		const m = f.nodes.get("m")!;

		await l.complete({ status: "failure", summary: "lf", detail: "lf" });
		t.mock.timers.tick(1000);
		t.mock.timers.tick(1000);

		await f.service.cancel(f.run.task_id, { agents: ["m"], reason: "stop m", grace_ms: 0 });
		await m.hooks.get("agent_settled")!({ aborted: true }, m.context);
		t.mock.timers.tick(4000);

		const st = f.status();
		assert.deepEqual(st.worker_errors, []);
		assert.equal(st.outcome.state, "failed");
		assert.equal(st.outcome.terminal, true);
		assertOwnershipReleased(st);

		const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
		const digest = formatReportDigest(rep.results);
		return { st, rep, digest };
	};

	const fwd = await runWithOrder(baseAgents);
	const rev = await runWithOrder([baseAgents[4], baseAgents[3], baseAgents[2], baseAgents[0], baseAgents[1]]);

	for (const nodeId of ["j", "z", "y"]) {
		const fwdAgent = fwd.st.agents.find(a => a.node_id === nodeId)!;
		const revAgent = rev.st.agents.find(a => a.node_id === nodeId)!;
		assert.equal(fwdAgent.execution, "blocked");
		assert.equal(revAgent.execution, "blocked");
		assert.equal(fwdAgent.execution_causes.some(c => c.node_id === "l" && c.state === "failed"), true, `${nodeId} fwd should include l`);
		assert.equal(fwdAgent.execution_causes.some(c => c.node_id === "m" && c.state === "cancelled"), true, `${nodeId} fwd should include m`);
		assert.deepEqual(revAgent.execution_causes, fwdAgent.execution_causes, `${nodeId} causes should match across plan orders`);
		assert.equal(revAgent.execution_reason, fwdAgent.execution_reason, `${nodeId} reason should match across plan orders`);

		const fwdRep = fwd.rep.results.find(r => r.node_id === nodeId)!;
		const revRep = rev.rep.results.find(r => r.node_id === nodeId)!;
		assert.deepEqual("causes" in revRep ? revRep.causes : [], "causes" in fwdRep ? fwdRep.causes : []);
		assert.equal(revRep.summary, fwdRep.summary);

		const digestLine = (digest: string) => digest.split("\n").find(line => line.startsWith(`- ${nodeId} (`) || line.startsWith(`- ${nodeId}:`))!;
		assert.equal(digestLine(rev.digest), digestLine(fwd.digest), `${nodeId} digest line should match across plan orders`);
		assert.match(digestLine(fwd.digest), /l failed.*m cancelled/);
	}
});

test("unreadable loop finalization or transition during cancel propagation fails closed with filename and propagates to independent join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const graphPlan = {
		topology: "graph" as const,
		task: "Unreadable loop record during cancel propagation",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "pre", persona: "first", sub_task: "Pre" },
			{ node_id: "sa", persona: "first", depends_on: ["pre"], sub_task: "Scout A" },
			{ node_id: "sb", persona: "first", sub_task: "Scout B" },
			{ node_id: "ba", persona: "second", depends_on: ["sa"], sub_task: "Build A" },
			{
				node_id: "ra",
				persona: "second",
				depends_on: ["ba"],
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "ba", max_revisions: 2 },
			},
			{ node_id: "m", persona: "first", depends_on: ["ra", "sb"], sub_task: "Merge" },
		],
	};

	for (const suffix of ["finalize.json", "1.transition.json"] as const) {
		const f = await runFixture(t, graphPlan, new Map(), { simulateShutdown: true });
		await f.nodes.get("pre")!.complete(complete("Pre ok"));
		await f.nodes.get("sb")!.complete(complete("SB ok"));

		const raId = f.nodes.get("ra")!.config.instance_id;
		const corruptName = `${raId}.${suffix}`;
		writeFileSync(join(f.run.session_dir, corruptName), "{bad");

		const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["sa"], reason: "stop sa", grace_ms: 0 });
		assert.deepEqual(cancelRes.cancelled, ["sa"]);
		assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["ba", "ra", "m"]);
		assert.equal((cancelRes.record_errors ?? []).some(err => err.includes(corruptName)), true, `cancel record_errors should name ${corruptName}`);

		const stImmediate = f.status();
		assert.equal(stImmediate.outcome.terminal, false, "unreadable loop record must fail closed");
		assert.equal(stImmediate.worker_errors.some(err => err.includes(corruptName)), true, `immediate worker_errors should name ${corruptName}`);
		assert.equal(stImmediate.agents.find(a => a.node_id === "sb")?.execution, "succeeded");
		assert.equal(stImmediate.agents.find(a => a.node_id === "m")?.execution, "blocked");

		t.mock.timers.tick(5000);
		const stAfter = f.status();
		assert.equal(stAfter.outcome.terminal, false);
		assert.equal(stAfter.worker_errors.some(err => err.includes(corruptName)), true, `post-tick worker_errors should name ${corruptName}`);
		assert.equal(stAfter.agents.find(a => a.node_id === "sb")?.execution, "succeeded");
		assert.equal(stAfter.agents.find(a => a.node_id === "m")?.execution, "blocked");
		assertOwnershipReleased(stAfter);
	}

	// Chain with a review loop also propagates past an unreadable finalization without throwing.
	const chainLoopPlan = {
		topology: "chain" as const,
		task: "Chain with review loop and unreadable finalization",
		project_cwd: process.cwd(),
		cleanup: "manual" as const,
		agents: [
			{ node_id: "pre", persona: "first", sub_task: "Pre" },
			{ node_id: "mid", persona: "first", sub_task: "Mid" },
			{ node_id: "ba", persona: "second", sub_task: "Build A" },
			{
				node_id: "ra",
				persona: "second",
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "ba", max_revisions: 2 },
			},
			{ node_id: "z", persona: "first", sub_task: "Final" },
		],
	};
	const fc = await runFixture(t, chainLoopPlan, new Map(), { simulateShutdown: true });
	await fc.nodes.get("pre")!.complete(complete("Pre ok"));
	const raChainId = fc.nodes.get("ra")!.config.instance_id;
	const chainCorrupt = `${raChainId}.finalize.json`;
	writeFileSync(join(fc.run.session_dir, chainCorrupt), "{bad");

	const chainCancel = await fc.service.cancel(fc.run.task_id, { agents: ["mid"], reason: "stop mid", grace_ms: 0 });
	assert.deepEqual(chainCancel.cancelled, ["mid"]);
	assert.deepEqual(chainCancel.blocked_dependents.map(d => d.node_id), ["ba", "ra", "z"]);
	assert.equal((chainCancel.record_errors ?? []).some(err => err.includes(chainCorrupt)), true);

	t.mock.timers.tick(5000);
	const stChain = fc.status();
	assert.equal(stChain.outcome.terminal, false);
	assert.equal(stChain.worker_errors.some(err => err.includes(chainCorrupt)), true);
	assert.equal(stChain.agents.find(a => a.node_id === "z")?.execution, "blocked");
	assertOwnershipReleased(stChain);
});

test("recover inspect does not repeat reviewer node name in ended-without-approval reason", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 2, cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const buildA = f.nodes.get("build-a")!;
	const reviewA = f.nodes.get("review-a")!;

	await scoutA.complete(complete("Scout A"));
	await buildA.deliverNotification(scoutA);
	await buildA.complete(complete("Build A v1"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Revise A 1", "changes_requested"));

	const reason = "Stop parked review-a";
	await f.service.cancel(f.run.task_id, { agents: ["review-a"], reason, grace_ms: 0 });

	const inspect = await f.service.recover(f.run.task_id, { action: "inspect" });
	const revAMerge = inspect.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === "merge")!;
	assert.deepEqual([revAMerge.stage, revAMerge.verdict], ["source_not_executed", "none"]);
	assert.equal(revAMerge.reason, `review-a ended without approval (was cancelled: ${reason}), so no forward handoff exists`);
	assert.equal(revAMerge.next_steps[0]?.startsWith("merge settles on its own"), true);
});

// ---- Gap G2: cancel while exited source has pending/failed delivery to unclaimed successor ----

test("G2 case 1 & 6 & 7: approved decision agent exiting with pending delivery settles cancelled/terminal across chain/graph and cleanup modes", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const topology of ["chain", "graph"] as const) {
		for (const cleanup of ["on_success", "manual"] as const) {
			for (const mode of ["hanging-coms", "rewritten-cleared", "rewritten-sent"] as const) {
				await t.test(`${topology} ${cleanup} ${mode}`, async () => {
					const enteredSend = Promise.withResolvers<void>();
					const hangingSend = new Promise<{ content: never[]; details: Record<string, unknown> }>(() => {});
					const overrides = mode === "hanging-coms"
						? new Map([["review-a", {
							executeTool: async (_name: string, params: unknown) => {
								const target = String((params as { target?: string })?.target ?? "");
								if (target.includes("publish") || target.includes("merge")) {
									enteredSend.resolve();
									return hangingSend;
								}
								return { content: [], details: { msg_id: "msg1" } };
							},
						}]])
						: new Map();
					const plan = topology === "chain"
						? {
							topology: "chain" as const,
							task: "Chain loop G2",
							project_cwd: process.cwd(),
							cleanup,
							cleanup_settle_ms: 0,
							agents: [
								{ node_id: "build-a", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
								{
									node_id: "review-a",
									persona: "second",
									sub_task: "Review",
									output_contract: verdictContract,
									decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-a", max_revisions: 1 },
								},
								{ node_id: "publish", persona: "second", sub_task: "Publish", write_paths: ["dist/out.txt"] },
							],
						}
						: twoBranchPlan(process.cwd(), { cleanup, writePathsBuildA: ["src/a.ts"] });
					const f = await runFixture(t, plan as any, overrides, { simulateShutdown: true });

					if (topology === "graph") {
						const scoutA = f.nodes.get("scout-a")!;
						const scoutB = f.nodes.get("scout-b")!;
						const buildB = f.nodes.get("build-b")!;
						const reviewB = f.nodes.get("review-b")!;
						await scoutA.complete(complete("Scout A"));
						await scoutB.complete(complete("Scout B"));
						await f.nodes.get("build-a")!.deliverNotification(scoutA);
						await buildB.deliverNotification(scoutB);
						await buildB.complete(complete("Build B ok"));
						await reviewB.deliverNotification(buildB);
						await reviewB.complete(complete("Review B ok", "approve"));
					}

					const buildA = f.nodes.get("build-a")!;
					const reviewA = f.nodes.get("review-a")!;
					await buildA.complete(complete("Build A ok"));
					await reviewA.deliverNotification(buildA);

					if (mode === "hanging-coms") {
						void reviewA.complete(complete("Approved A", "approve"));
						await enteredSend.promise;
					} else {
						await reviewA.complete(complete("Approved A", "approve"));
					}

					const resFile = resultPath(f.run.session_dir, `${reviewA.config.instance_id}.1`);
					if (mode !== "hanging-coms") {
						const saved = readJson<WorkerCompletion>(resFile);
						atomicJson(resFile, { ...saved, delivery: "pending", ...(mode === "rewritten-cleared" ? { edge_deliveries: undefined } : {}) });
					}
					const savedBeforeCancel = readFileSync(resFile, "utf8");
					reviewA.vanish();

					const cancelRes = await f.service.cancel(f.run.task_id, { reason: "Operator stopped run", grace_ms: 0 });
					assert.equal(cancelRes.already_completed.includes("review-a"), true);

					t.mock.timers.tick(1000);
					const st = await f.service.statusWithCleanup(f.run.task_id);
					assert.deepEqual(st.worker_errors, []);
					assert.deepEqual(st.delivery_errors, []);
					assert.deepEqual(st.pending, []);
					assert.equal(st.outcome.state, "cancelled");
					assert.equal(st.outcome.terminal, true);
					assert.equal(st.manifest.status, "applied");
					assertOwnershipReleased(st);

					// Durable source result stays completely untouched.
					assert.equal(readFileSync(resFile, "utf8"), savedBeforeCancel);
					assert.equal(readJson<WorkerCompletion>(resFile).delivery, "pending");

					const outsideId = topology === "chain" ? "publish" : "merge";
					const outsideState = st.agents.find(a => a.node_id === outsideId)!;
					assert.equal(outsideState.execution, "cancelled");
					assert.equal(outsideState.execution_reason, "Operator stopped run");
					assert.deepEqual(outsideState.execution_causes, []);

					const statusText = formatAgentStates(st.agents, st.manifest.topology);
					const revState = st.agents.find(a => a.node_id === "review-a")!;
					const outView = revState.handoffs_out?.[outsideState.instance_id] ?? revState.handoff_out;
					if (mode !== "hanging-coms") {
						assert.equal(outView?.state, "queued");
						assert.equal(outView?.not_delivered_reason, undefined);
						assert.match(statusText, /handoff out.*queued: not accepted yet/);
					} else {
						assert.equal(outView?.not_delivered_reason, "run was cancelled: Operator stopped run");
						assert.match(statusText, /handoff out.*: not delivered \(run was cancelled: Operator stopped run\)/);
					}

					const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
					const revRep = rep.results.find(r => r.node_id === "review-a")!;
					const outRep = rep.results.find(r => r.node_id === outsideId)!;
					assert.equal(outRep.status, "cancelled");
					assert.match(outRep.summary, /Operator stopped run/);
					if (mode === "hanging-coms") {
						assert.deepEqual(revRep.undelivered_edges, [{ destination: outsideId, reason: "not delivered (run was cancelled: Operator stopped run)" }]);
						assert.match(formatReportDigest(rep.results), new RegExp(`undelivered: ${outsideId} — not delivered \\(run was cancelled: Operator stopped run\\)`));
						assert.match(readFileSync(rep.report_md!, "utf8"), new RegExp(`Undelivered edges:[\\s\\S]*to ${outsideId}: not delivered \\(run was cancelled: Operator stopped run\\)`));
					} else {
						assert.equal(revRep.undelivered_edges, undefined);
					}

					// Case 7: recover inspect reports closed & verdict none; retry_delivery is refused.
					const inspect = await f.service.recover(f.run.task_id, { action: "inspect" });
					assert.match(inspect.closed ?? "", /run was cancelled \(Operator stopped run\)/);
					const edge = inspect.assessments.find(a => a.source.node_id === "review-a" && a.destination.node_id === outsideId)!;
					assert.deepEqual([edge.stage, edge.verdict], ["destination_ended", "none"]);
					const retry = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: outsideId, ...(topology === "graph" ? { source: "review-a" } : {}) }, {
						senderSession: "dispatcher",
						wake: async () => { throw new Error("must not send"); },
					});
					assert.match(retry.refused ?? "", /run was cancelled/);
				});
			}
		}
	}
});

test("G2 case 2: node-scoped cancel of successor settles exited reviewer, whereas node-scoped cancel of reviewer leaves waiting successor recoverable", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 2a: Node-scoped cancel of outside successor only (with a downstream node after it; handoff to publish never sent).
	{
		const enteredSend = Promise.withResolvers<void>();
		const hangingSend = new Promise<{ content: never[]; details: Record<string, unknown> }>(() => {});
		const f = await runFixture(t, {
			topology: "graph",
			task: "Node cancel outside successor",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish", write_paths: ["dist/out.txt"] },
				{ node_id: "announce", persona: "first", depends_on: ["publish"], sub_task: "Announce" },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return hangingSend;
				}
				return { content: [], details: { msg_id: "msg1" } };
			},
		}]]), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();

		const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["publish"], reason: "Skip publish", grace_ms: 0 });
		assert.deepEqual(cancelRes.cancelled, ["publish"]);
		assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["announce"]);

		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.delivery_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "blocked");
		assert.equal(st.outcome.terminal, true);
		assertOwnershipReleased(st);
		assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "cancelled");
		assert.equal(st.agents.find(a => a.node_id === "announce")?.execution, "blocked");
		assert.deepEqual(st.agents.find(a => a.node_id === "announce")?.execution_causes, [{ node_id: "publish", state: "cancelled", reason: "Skip publish" }]);
		assert.match(formatAgentStates(st.agents, "graph"), /not delivered \(publish was cancelled: Skip publish\)/);

		const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
		assert.deepEqual(rep.results.find(r => r.node_id === "review")?.undelivered_edges, [
			{ destination: "publish", reason: "not delivered (publish was cancelled: Skip publish)" },
		]);
		const inspect = await f.service.recover(f.run.task_id, { action: "inspect" });
		assert.equal(inspect.closed, undefined);
		assert.equal(inspect.assessments.find(a => a.source.node_id === "review" && a.destination.node_id === "publish")?.verdict, "none");
	}

	// 2b: Node-scoped cancel of already-completed finalized reviewer leaves live outside successor waiting and recoverable.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "Node cancel reviewer only",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
			],
		}, new Map(), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		await review.complete(complete("Approved", "approve"));
		const p = resultPath(f.run.session_dir, `${review.config.instance_id}.1`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		review.vanish();

		const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["review"], reason: "Cancel reviewer", grace_ms: 0 });
		assert.deepEqual(cancelRes.already_completed, ["review"]);
		assert.deepEqual(cancelRes.cancelled, []);

		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "incomplete");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.pending.includes("review"), true);
		assert.equal(st.pending.includes("publish"), true);
		assert.match(st.worker_errors.join("\n"), /process exited during chain handoff/);
		assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "waiting");

		const inspect = await f.service.recover(f.run.task_id, { action: "inspect" });
		const edge = inspect.assessments.find(a => a.source.node_id === "review" && a.destination.node_id === "publish")!;
		assert.deepEqual([edge.stage, edge.verdict], ["deliverable", "retry_delivery"]);
	}
});

test("G2 case 3: delivery failed settles cancelled/terminal on run cancel, and delivery sent stays terminal (pin)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const delivery of ["failed", "sent"] as const) {
		await t.test(`delivery=${delivery}`, async () => {
			const overrides = delivery === "failed"
				? new Map([["review", {
					executeTool: async (_name: string, params: unknown) => {
						if (String((params as { target?: string })?.target ?? "").includes("publish")) {
							return { isError: true, content: [{ type: "text", text: "coms send failed" }] };
						}
						return { content: [], details: { msg_id: "msg1" } };
					},
				}]])
				: new Map();
			const f = await runFixture(t, {
				topology: "graph",
				task: `Delivery ${delivery} then cancel`,
				project_cwd: process.cwd(),
				cleanup: "on_success",
				agents: [
					{ node_id: "build", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
					{
						node_id: "review",
						persona: "second",
						depends_on: ["build"],
						sub_task: "Review",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					},
					{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
				],
			}, overrides, { simulateShutdown: true });
			const build = f.nodes.get("build")!;
			const review = f.nodes.get("review")!;
			await build.complete(complete("Build ok"));
			await review.deliverNotification(build);
			await review.complete(complete("Approved", "approve"));
			const p = resultPath(f.run.session_dir, `${review.config.instance_id}.1`);
			const before = readFileSync(p, "utf8");
			assert.equal(readJson<WorkerCompletion>(p).delivery, delivery);
			review.vanish();

			await f.service.cancel(f.run.task_id, { reason: "Abort run", grace_ms: 0 });
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(st.worker_errors, []);
			assert.deepEqual(st.delivery_errors, []);
			assert.deepEqual(st.pending, []);
			assert.equal(st.outcome.state, "cancelled");
			assert.equal(st.outcome.terminal, true);
			assertOwnershipReleased(st);
			assert.equal(readFileSync(p, "utf8"), before);

			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			const revRep = rep.results.find(r => r.node_id === "review")!;
			if (delivery === "failed") {
				assert.deepEqual(revRep.undelivered_edges, [{ destination: "publish", reason: "not delivered (run was cancelled: Abort run)" }]);
			} else {
				assert.equal(revRep.undelivered_edges, undefined);
			}
		});
	}
});

test("G2 case 4: successor that already claimed/completed keeps its outcome and racing cancel produces one winner", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 4a: Successor claimed & completed before cancel -> keeps succeeded, cancel does not overturn it.
	{
		const f = await runFixture(t, {
			topology: "chain",
			task: "Successor completed before cancel",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
				{
					node_id: "review",
					persona: "second",
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", sub_task: "Publish", write_paths: ["dist/out.txt"] },
			],
		}, new Map(), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		await review.complete(complete("Approved", "approve"));
		await publish.deliverNotification(review);
		await publish.complete(complete("Published"));
		const p = resultPath(f.run.session_dir, `${review.config.instance_id}.1`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		review.vanish();

		const cancelRes = await f.service.cancel(f.run.task_id, { reason: "Too late", grace_ms: 0 });
		assert.deepEqual(cancelRes.already_completed.sort(), ["build", "publish", "review"]);
		assert.deepEqual(cancelRes.cancelled, []);

		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.delivery_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "succeeded");
		assert.equal(st.outcome.terminal, true);
		assert.equal(st.agents.find(a => a.node_id === "review")?.delivery, "sent");
		assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "succeeded");
		assertOwnershipReleased(st);

		const rep = await f.service.report(f.run.task_id, undefined, false, buildMarkdownReport);
		assert.equal(rep.results.find(r => r.node_id === "review")?.undelivered_edges, undefined);
		assert.equal(rep.results.find(r => r.node_id === "publish")?.status, "success");
	}

	// 4b: Successor already claimed & working; cancel races with completion via outcome-claim.
	for (const winner of ["completed", "cancelled"] as const) {
		await t.test(`race winner=${winner}`, async () => {
			const signalled = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const f = await runFixture(t, {
				topology: "graph",
				task: `Claimed successor race ${winner}`,
				project_cwd: process.cwd(),
				cleanup: "on_success",
				agents: [
					{ node_id: "build", persona: "first", sub_task: "Build" },
					{
						node_id: "review",
						persona: "second",
						depends_on: ["build"],
						sub_task: "Review",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					},
					{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish", write_paths: ["dist/out.txt"] },
				],
			}, new Map(), {
				simulateShutdown: true,
				signalWorker: async (_m, entry) => {
					if (entry.node_id === "publish" && winner === "cancelled") {
						signalled.resolve();
						await release.promise;
					}
				},
			});
			const build = f.nodes.get("build")!;
			const review = f.nodes.get("review")!;
			const publish = f.nodes.get("publish")!;
			await build.complete(complete("Build ok"));
			await review.deliverNotification(build);
			await review.complete(complete("Approved", "approve"));
			await publish.deliverNotification(review);
			const p = resultPath(f.run.session_dir, `${review.config.instance_id}.1`);
			atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
			review.vanish();

			if (winner === "completed") {
				const pubId = {
					run_id: f.run.task_id,
					node_id: "publish",
					persona_name: publish.config.persona_name,
					attempt_id: publish.config.attempt_id!,
					instance_id: publish.config.instance_id,
				};
				assert.equal(claimOutcome(f.run.session_dir, pubId, "completed", new Date(Date.now()).toISOString(), `${publish.config.instance_id}.1`).won, true);
				const cancelRes = await f.service.cancel(f.run.task_id, { reason: "Late cancel", grace_ms: 0 });
				assert.equal(cancelRes.already_completed.includes("publish"), true);
				await publish.complete(complete("Publish won"));
				t.mock.timers.tick(3000);
				const st = await f.service.statusWithCleanup(f.run.task_id);
				assert.equal(st.outcome.state, "succeeded");
				assert.equal(st.outcome.terminal, true);
				assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "succeeded");
				assertOwnershipReleased(st);
			} else {
				const cancelling = f.service.cancel(f.run.task_id, { reason: "Cancel won", grace_ms: 0 });
				await signalled.promise;
				const comp = await publish.complete(complete("Publish lost"));
				assert.equal(comp.isError, true);
				release.resolve();
				await cancelling;
				const st = await f.service.statusWithCleanup(f.run.task_id);
				assert.deepEqual(st.worker_errors, []);
				assert.equal(st.outcome.state, "cancelled");
				assert.equal(st.outcome.terminal, true);
				assert.equal(st.agents.find(a => a.node_id === "review")?.delivery, "sent");
				assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "cancelled");
				assertOwnershipReleased(st);
			}
		});
	}
});

test("G2 case 5: non-loop chain, fan-out (both cleanup modes), and join with pending delivery on exited source settle on cancel", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 5a: Non-loop chain n1 -> n2, n1 completed normally (queued offer), result rewritten to pending, exited, run cancel (pin: already settled on f7707e8, keeps queued offer).
	{
		const f = await runFixture(t, {
			topology: "chain",
			task: "Non-loop chain G2",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "n1", persona: "first", sub_task: "One", write_paths: ["a.txt"] },
				{ node_id: "n2", persona: "second", sub_task: "Two", write_paths: ["b.txt"] },
			],
		}, new Map(), { simulateShutdown: true });
		const n1 = f.nodes.get("n1")!;
		await n1.complete(complete("One ok"));
		const p = resultPath(f.run.session_dir, n1.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
		n1.vanish();
		await f.service.cancel(f.run.task_id, { reason: "Stop chain", grace_ms: 0 });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assertOwnershipReleased(st);
		assert.equal(st.agents.find(a => a.node_id === "n1")?.handoff_out?.not_delivered_reason, undefined);
		assert.match(formatAgentStates(st.agents, "chain"), /handoff out h-[0-9a-f]+ queued: not accepted yet/);
		const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
		assert.equal(rep.results.find(r => r.node_id === "n1")?.undelivered_edges, undefined);
	}

	// 5b: Non-loop fan-out root -> [left, right] with left sent and right pending, root exited:
	// node-cancel of right only across on_success AND manual (pin: matches f7707e8; manual waits for left acceptance before settling root).
	for (const cleanup of ["on_success", "manual"] as const) {
		await t.test(`fan-out ${cleanup} node-cancel pending edge`, async () => {
			const f = await runFixture(t, {
				topology: "graph",
				task: `Fan-out G2 ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				agents: [
					{ node_id: "root", persona: "first", sub_task: "Root" },
					{ node_id: "left", persona: "second", depends_on: ["root"], sub_task: "Left" },
					{ node_id: "right", persona: "second", depends_on: ["root"], sub_task: "Right" },
				],
			}, new Map([["root", {
				executeTool: async (_name: string, params: unknown) => {
					if (String((params as { target?: string })?.target ?? "").includes("right")) {
						return { isError: true, content: [{ type: "text", text: "right coms down" }] };
					}
					return { content: [], details: { msg_id: "msg1" } };
				},
			}]]), { simulateShutdown: true });
			const root = f.nodes.get("root")!;
			const left = f.nodes.get("left")!;
			await root.complete(complete("Root ok"));
			const p = resultPath(f.run.session_dir, root.config.instance_id);
			const saved = readJson<WorkerCompletion>(p);
			atomicJson(p, { ...saved, delivery: "pending", edge_deliveries: { [left.config.instance_id]: { state: "sent", updated_at: new Date(Date.now()).toISOString() } } });
			root.vanish();

			// Node-cancel only right while left is still waiting (sent, unclaimed).
			await f.service.cancel(f.run.task_id, { agents: ["right"], reason: "Drop right", grace_ms: 0 });
			const mid = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(mid.delivery_errors, []);
			assert.equal(mid.agents.find(a => a.node_id === "right")?.execution, "cancelled");
			const rootState = mid.agents.find(a => a.node_id === "root")!;
			assert.equal(rootState.handoffs_out?.[left.config.instance_id]?.not_delivered_reason, undefined);
			assert.equal(rootState.handoffs_out?.[f.nodes.get("right")!.config.instance_id]?.not_delivered_reason, undefined);
			if (cleanup === "on_success") {
				assert.deepEqual(mid.worker_errors, []);
				assert.deepEqual(mid.pending, ["left"]);
			} else {
				assert.deepEqual(mid.worker_errors, ["root (persona first): process exited during chain handoff"]);
				assert.deepEqual(mid.pending, ["root", "left"]);
			}

			// Left finishes normally; run settles cancelled/terminal without errors.
			await left.deliverNotification(root);
			await left.complete(complete("Left ok"));
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(st.worker_errors, []);
			assert.deepEqual(st.delivery_errors, []);
			assert.deepEqual(st.pending, []);
			assert.equal(st.outcome.state, "cancelled");
			assert.equal(st.outcome.terminal, true);
			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			assert.equal(rep.results.find(r => r.node_id === "root")?.undelivered_edges, undefined);
		});
	}

	// 5c: Loop-free join left -> merge <- right, left exited with delivery: pending, run cancel (pin).
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "Loop-free join G2",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "left", persona: "first", sub_task: "Left" },
				{ node_id: "right", persona: "first", sub_task: "Right" },
				{ node_id: "merge", persona: "second", depends_on: ["left", "right"], sub_task: "Merge" },
			],
		}, new Map(), { simulateShutdown: true });
		const left = f.nodes.get("left")!;
		const right = f.nodes.get("right")!;
		await left.complete(complete("Left ok"));
		const p = resultPath(f.run.session_dir, left.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		left.vanish();
		await f.service.cancel(f.run.task_id, { reason: "Stop join", grace_ms: 0 });
		await right.hooks.get("agent_settled")!({ aborted: true }, right.context);
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
	}
});

test("G2 crash windows & unreadable records: reload converges after cancel intent crash and corrupt records fail closed", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// Crash window 1: run cancel.json written, process dies before publish.disposition.json or publish.cancel.json; reload converges.
	{
		const enteredSend = Promise.withResolvers<void>();
		const hangingSend = new Promise<{ content: never[]; details: Record<string, unknown> }>(() => {});
		const f = await runFixture(t, {
			topology: "graph",
			task: "Crash window after cancel intent",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish", write_paths: ["dist/out.txt"] },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return hangingSend;
				}
				return { content: [], details: { msg_id: "msg1" } };
			},
		}]]), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();

		// Simulate crash right after writing cancel.json (before disposition or ownership release on publish).
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Crash mid-cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
		const reloadedService = new BootstrapService((f.service as any).options);
		const st = await reloadedService.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.delivery_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assert.equal(st.manifest.status, "applied");
		assert.equal(st.agents.find(a => a.node_id === "publish")?.execution, "cancelled");
		assert.equal(st.agents.find(a => a.node_id === "publish")?.execution_reason, "Crash mid-cancel");
		// While publish is still live and its ownership record still says admitted, ownership_status honestly stays admitted.
		assert.equal(st.agents.find(a => a.node_id === "build")?.ownership_status, "released");
		assert.equal(st.agents.find(a => a.node_id === "publish")?.ownership_status, "admitted");
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[publish.config.instance_id]?.not_delivered_reason, "run was cancelled: Crash mid-cancel");

		const rep = await reloadedService.report(f.run.task_id, undefined, true, buildMarkdownReport);
		assert.deepEqual(rep.results.find(r => r.node_id === "review")?.undelivered_edges, [
			{ destination: "publish", reason: "not delivered (run was cancelled: Crash mid-cancel)" },
		]);
		const inspect = await reloadedService.recover(f.run.task_id, { action: "inspect" });
		assert.match(inspect.closed ?? "", /Crash mid-cancel/);
		assert.equal(inspect.assessments.find(a => a.source.node_id === "review" && a.destination.node_id === "publish")?.verdict, "none");

		// Once cancel finishes settling publish and releases its ownership record, status converges to released too.
		await reloadedService.cancel(f.run.task_id, { reason: "Crash mid-cancel", grace_ms: 0 });
		const stAfter = await reloadedService.statusWithCleanup(f.run.task_id);
		assert.equal(stAfter.outcome.state, "cancelled");
		assert.equal(stAfter.outcome.terminal, true);
		assertOwnershipReleased(stAfter);
	}

	// Crash window 2: node-cancel written for publish only, process dies before disposition; reload converges.
	{
		const enteredSend = Promise.withResolvers<void>();
		const hangingSend = new Promise<{ content: never[]; details: Record<string, unknown> }>(() => {});
		const f = await runFixture(t, {
			topology: "chain",
			task: "Crash window node cancel",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", sub_task: "Publish", write_paths: ["dist/out.txt"] },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return hangingSend;
				}
				return { content: [], details: { msg_id: "msg1" } };
			},
		}]]), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();

		writeCancelRecord(f.run.session_dir, {
			identity: { run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name, instance_id: publish.config.instance_id },
			scope: "node",
			reason: "Node crash mid-cancel",
			requestedAt: new Date(Date.now()).toISOString(),
			graceMs: 0,
		});
		const reloadedService = new BootstrapService((f.service as any).options);
		const st = await reloadedService.statusWithCleanup(f.run.task_id);
		assert.deepEqual(st.worker_errors, []);
		assert.deepEqual(st.pending, []);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assert.equal(st.agents.find(a => a.node_id === "publish")?.ownership_status, "admitted");
		const revState2 = st.agents.find(a => a.node_id === "review")!;
		assert.equal((revState2.handoffs_out?.[publish.config.instance_id] ?? revState2.handoff_out)?.not_delivered_reason, "publish was cancelled: Node crash mid-cancel");

		await reloadedService.cancel(f.run.task_id, { agents: ["publish"], reason: "Node crash mid-cancel", grace_ms: 0 });
		const stAfter = await reloadedService.statusWithCleanup(f.run.task_id);
		assertOwnershipReleased(stAfter);
	}

	// Racing evaluators: concurrent statusWithCleanup and cancel produce one winner without automatic cleanup or double settlement.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "Race statusWithCleanup vs cancel",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			cleanup_settle_ms: 0,
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build", write_paths: ["src/a.ts"] },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
			],
		}, new Map(), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		await review.complete(complete("Approved", "approve"));
		const p = resultPath(f.run.session_dir, `${review.config.instance_id}.1`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		review.vanish();

		const [s1, cancelRes, s2] = await Promise.all([
			f.service.statusWithCleanup(f.run.task_id),
			f.service.cancel(f.run.task_id, { reason: "Race cancel", grace_ms: 0 }),
			f.service.statusWithCleanup(f.run.task_id),
		]);
		assert.equal(cancelRes.cancelled.includes("publish"), true);
		for (const st of [s1, s2, await f.service.statusWithCleanup(f.run.task_id)]) {
			assert.equal(st.manifest.status, "applied");
			assert.equal(st.manifest.cleanup_trigger, undefined);
		}
		const settled = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(settled.worker_errors, []);
		assert.deepEqual(settled.pending, []);
		assert.equal(settled.outcome.state, "cancelled");
		assert.equal(settled.outcome.terminal, true);
		assertOwnershipReleased(settled);
	}

	// Unreadable / foreign cancel, claim, disposition, or finalization record fails closed naming the file/problem,
	// and never settles the exited source (even when another cancel record is present).
	for (const kind of [
		"run-cancel", "node-cancel", "outcome-claim", "disposition", "disp-cancel",
		"fail-fast", "target-error", "manifest-target-error", "ownership", "inbound-handoff", "finalize",
	] as const) {
		await t.test(`unreadable ${kind} fails closed`, async () => {
			const enteredSend = Promise.withResolvers<void>();
			const hangingSend = new Promise<{ content: never[]; details: Record<string, unknown> }>(() => {});
			const f = await runFixture(t, {
				topology: "graph",
				task: `Unreadable ${kind}`,
				project_cwd: process.cwd(),
				cleanup: "on_success",
				agents: [
					{ node_id: "build", persona: "first", sub_task: "Build" },
					{
						node_id: "review",
						persona: "second",
						depends_on: ["build"],
						sub_task: "Review",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					},
					{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish", write_paths: ["dist/out.txt"] },
				],
			}, new Map([["review", {
				executeTool: async (_name: string, params: unknown) => {
					if (String((params as { target?: string })?.target ?? "").includes("publish")) {
						enteredSend.resolve();
						return hangingSend;
					}
					return { content: [], details: { msg_id: "msg1" } };
				},
			}]]), { simulateShutdown: true });
			const build = f.nodes.get("build")!;
			const review = f.nodes.get("review")!;
			const publish = f.nodes.get("publish")!;
			await build.complete(complete("Build ok"));
			await review.deliverNotification(build);
			void review.complete(complete("Approved", "approve"));
			await enteredSend.promise;
			review.vanish();

			if (kind === "run-cancel") {
				writeCancelRecord(f.run.session_dir, {
					identity: { run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name, instance_id: publish.config.instance_id },
					scope: "node",
					reason: "Node cancel",
					requestedAt: new Date(Date.now()).toISOString(),
					graceMs: 0,
				});
				writeFileSync(runCancelPath(f.run.session_dir), "{bad json");
			} else if (kind === "node-cancel") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				writeFileSync(cancelPath(f.run.session_dir, publish.config.instance_id), "{bad json");
			} else if (kind === "outcome-claim") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				atomicJson(outcomeClaimPath(f.run.session_dir, `${publish.config.instance_id}.1`), {
					version: 99,
					identity: { run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name, attempt_id: `${publish.config.instance_id}.1`, instance_id: publish.config.instance_id },
					outcome: "cancelled",
					claimed_at: new Date(Date.now()).toISOString(),
				});
			} else if (kind === "disposition") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				writeFileSync(dispositionPath(f.run.session_dir, `${publish.config.instance_id}.1`), "{bad json");
			} else if (kind === "disp-cancel") {
				atomicJson(dispositionPath(f.run.session_dir, `${publish.config.instance_id}.1`), {
					version: 1,
					identity: { run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name, attempt_id: `${publish.config.instance_id}.1`, instance_id: publish.config.instance_id },
					state: "cancelled",
					reason: "Cancelled",
					causes: [],
					recorded_at: new Date(Date.now()).toISOString(),
				});
				writeFileSync(cancelPath(f.run.session_dir, publish.config.instance_id), "{bad json");
			} else if (kind === "fail-fast") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				writeFileSync(join(f.run.session_dir, "fail-fast.json"), "{bad json");
			} else if (kind === "target-error") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				atomicJson(join(f.run.session_dir, `${publish.config.instance_id}.error.json`), { error: "target crashed" });
			} else if (kind === "manifest-target-error") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				const manifest = (f.service as any).store.load(f.run.task_id, process.cwd(), false);
				manifest.pane_manifest.find((e: any) => e.node_id === "publish").error = "launch failed";
				(f.service as any).store.save(manifest);
			} else if (kind === "ownership") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				writeFileSync(ownershipPath(f.run.session_dir, publish.config.instance_id), "{bad json");
			} else if (kind === "inbound-handoff") {
				writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Run cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
				writeFileSync(handoffOfferPath(f.run.session_dir, `${publish.config.instance_id}.1`, review.config.instance_id), "{bad json");
			} else {
				writeCancelRecord(f.run.session_dir, {
					identity: { run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name, instance_id: publish.config.instance_id },
					scope: "node",
					reason: "Node cancel",
					requestedAt: new Date(Date.now()).toISOString(),
					graceMs: 0,
				});
				writeFileSync(join(f.run.session_dir, `${review.config.instance_id}.finalize.json`), "{bad json");
			}

			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.terminal, false);
			assert.equal(st.manifest.status, "applied");
			assert.equal(st.pending.includes("review"), true);
			const revState = st.agents.find(a => a.node_id === "review")!;
			const outView = revState.handoffs_out?.[publish.config.instance_id] ?? revState.handoff_out;
			if (kind === "finalize") {
				assert.equal(st.worker_errors.some(e => e.includes(`${review.config.instance_id}.finalize.json`)), true);
			} else {
				assert.equal(st.worker_errors.some(e => e.includes("review") && e.includes("process exited during chain handoff")), true);
				assert.equal(outView?.not_delivered_reason, undefined);
				assert.equal(st.outcome.state, kind === "disp-cancel" ? "incomplete" : "needs_attention");
				assert.ok(st.worker_errors.length >= 2);
			}
			await assert.rejects(f.service.report(f.run.task_id, undefined, false, buildMarkdownReport), /Run is not complete/);
		});
	}
});

test("G2 round 1 H1: manual uncancelled runs with edge_deliveries sent and unclaimed successor keep pending and exit error", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const shape of ["graph", "chain-loop"] as const) {
		await t.test(shape, async () => {
			const plan = shape === "graph"
				? {
					topology: "graph" as const,
					task: "H1 graph manual",
					project_cwd: process.cwd(),
					cleanup: "manual" as const,
					agents: [
						{ node_id: "n1", persona: "first", sub_task: "One" },
						{ node_id: "n2", persona: "second", depends_on: ["n1"], sub_task: "Two" },
					],
				}
				: {
					topology: "chain" as const,
					task: "H1 chain loop manual",
					project_cwd: process.cwd(),
					cleanup: "manual" as const,
					agents: [
						{ node_id: "build", persona: "first", sub_task: "Build" },
						{
							node_id: "n1",
							persona: "second",
							sub_task: "Review",
							output_contract: verdictContract,
							decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
						},
						{ node_id: "n2", persona: "second", sub_task: "Publish" },
					],
				};
			const f = await runFixture(t, plan as any, new Map(), { simulateShutdown: true });
			const n1 = f.nodes.get("n1")!;
			if (shape === "chain-loop") {
				const b = f.nodes.get("build")!;
				await b.complete(complete("Build ok"));
				await n1.deliverNotification(b);
				await n1.complete(complete("Approved", "approve"));
			} else {
				await n1.complete(complete("One ok"));
			}
			const p = resultPath(f.run.session_dir, shape === "graph" ? n1.config.instance_id : `${n1.config.instance_id}.1`);
			const rec = readJson<WorkerCompletion>(p);
			assert.equal(rec.edge_deliveries?.[f.nodes.get("n2")!.config.instance_id]?.state, "sent");
			atomicJson(p, { ...rec, delivery: "pending" });
			n1.vanish();

			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.state, "incomplete");
			assert.equal(st.outcome.terminal, false);
			assert.deepEqual(st.pending, ["n1", "n2"]);
			assert.deepEqual(st.worker_errors, [`n1 (persona ${n1.config.persona_name}): process exited during chain handoff`]);
			assert.match(formatAgentStates(st.agents, st.manifest.topology), /— process exited during chain handoff/);
		});
	}
});

test("G2 round 1 H2: uncancelled loop reviewer into doomed join stays incomplete/non-terminal in both cleanup modes", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const cleanup of ["manual", "on_success"] as const) {
		await t.test(cleanup, async () => {
			const f = await runFixture(t, {
				topology: "graph",
				task: `H2 doomed join ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				cleanup_settle_ms: 0,
				agents: [
					{ node_id: "build-a", persona: "second", sub_task: "Build A" },
					{ node_id: "build-b", persona: "second", sub_task: "Build B" },
					{
						node_id: "review-a",
						persona: "second",
						depends_on: ["build-a"],
						sub_task: "Review A",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-a", max_revisions: 1 },
					},
					{ node_id: "merge", persona: "first", depends_on: ["review-a", "build-b"], sub_task: "Merge" },
				],
			}, new Map(), { simulateShutdown: true });
			const ba = f.nodes.get("build-a")!;
			const bb = f.nodes.get("build-b")!;
			const ra = f.nodes.get("review-a")!;
			const m = f.nodes.get("merge")!;
			await bb.complete({ status: "failure", summary: "bb failed", detail: "bb failed" });
			await m.deliverNotification(bb);
			await ba.complete(complete("ba ok"));
			await ra.deliverNotification(ba);
			await ra.complete(complete("ok", "approve"));
			const p = resultPath(f.run.session_dir, `${ra.config.instance_id}.1`);
			atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
			ra.vanish();

			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.state, "incomplete");
			assert.equal(st.outcome.terminal, false);
			assert.deepEqual(st.pending, ["review-a"]);
			assert.deepEqual(st.worker_errors, ["review-a (persona second): process exited during chain handoff"]);
			assert.equal(st.agents.find(a => a.node_id === "merge")?.edge_states?.["review-a"], "pending");
			await assert.rejects(f.service.report(f.run.task_id, undefined, false, buildMarkdownReport), /Run is not complete\. Pending: review-a/);
		});
	}
});

test("G2 round 1 H3: cancelled exited/crash-window nodes keep real ownership_status and held_uncertain waiter text", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// probe-c repro: loop-free graph, overlapping write_paths, node-cancel n1 then n1 dies -> n1 admitted, n2 held_uncertain.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "H3 probe-c",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "n1", persona: "first", sub_task: "One", write_paths: ["x.txt"] },
				{ node_id: "n2", persona: "second", sub_task: "Two", write_paths: ["x.txt"] },
			],
		}, new Map(), { simulateShutdown: true });
		const cancelRes = await f.service.cancel(f.run.task_id, { agents: ["n1"], reason: "stop n1", grace_ms: 0 });
		assert.deepEqual(cancelRes.cancelling.map(c => c.node_id), ["n1"]);
		f.nodes.get("n1")!.vanish();

		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "incomplete");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.agents.find(a => a.node_id === "n1")?.execution, "cancelled");
		assert.equal(st.agents.find(a => a.node_id === "n1")?.ownership_status, "admitted");
		assert.equal(st.agents.find(a => a.node_id === "n2")?.ownership_status, "held_uncertain");
		assert.match(formatAgentStates(st.agents, "graph"), /\[ownership: held by n1 \(uncertain: process exited without recording a durable outcome\)\]/);
	}

	// probe-b B3 repro: run cancel intent only on exited admitted root + waiter -> n1 admitted, n2 held_uncertain with text.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "H3 probe-b B3",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "n1", persona: "first", sub_task: "One", write_paths: ["x.txt"] },
				{ node_id: "n3", persona: "first", sub_task: "Three", depends_on: ["n1"] },
				{ node_id: "n2", persona: "second", sub_task: "Two", write_paths: ["x.txt"] },
			],
		}, new Map(), { simulateShutdown: true });
		f.nodes.get("n1")!.vanish();
		f.nodes.get("n2")!.vanish();
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "crash", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });

		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assert.equal(st.agents.find(a => a.node_id === "n1")?.ownership_status, "admitted");
		assert.equal(st.agents.find(a => a.node_id === "n2")?.ownership_status, "held_uncertain");
		assert.match(formatAgentStates(st.agents, "graph"), /\[ownership: held by n1 \(uncertain: process exited without recording a durable outcome\)\]/);
	}
});

test("G2 round 1 H4: queued offers and already-settled routes keep f7707e8 output with no undelivered_edges", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// probe-a A1 & A8: chain n1->n2, n1 completed normally (delivery: sent, offer queued), n2 never claims; run cancel & node cancel.
	for (const cleanup of ["manual", "on_success"] as const) {
		for (const scope of ["run", "node-n2"] as const) {
			if (cleanup === "on_success" && scope === "node-n2") continue;
			await t.test(`A1/A8 chain ${cleanup} ${scope}`, async () => {
				const f = await runFixture(t, {
					topology: "chain",
					task: `H4 ${cleanup} ${scope}`,
					project_cwd: process.cwd(),
					cleanup,
					cleanup_settle_ms: 0,
					agents: [
						{ node_id: "n1", persona: "first", sub_task: "One" },
						{ node_id: "n2", persona: "second", sub_task: "Two" },
					],
				}, new Map(), { simulateShutdown: true });
				await f.nodes.get("n1")!.complete(complete("one"));
				if (scope === "run") {
					await f.service.cancel(f.run.task_id, { reason: "stop", grace_ms: 0 });
				} else {
					await f.service.cancel(f.run.task_id, { agents: ["n2"], reason: "drop n2", grace_ms: 0 });
				}
				const st = await f.service.statusWithCleanup(f.run.task_id);
				assert.equal(st.outcome.state, "cancelled");
				assert.equal(st.outcome.terminal, true);
				assert.deepEqual(st.pending, []);
				assert.deepEqual(st.worker_errors, []);
				assert.equal(st.agents.find(a => a.node_id === "n1")?.handoff_out?.state, "queued");
				assert.equal(st.agents.find(a => a.node_id === "n1")?.handoff_out?.not_delivered_reason, undefined);
				assert.match(formatAgentStates(st.agents, "chain"), /handoff out h-[0-9a-f]+ queued: not accepted yet/);
				const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
				assert.equal(rep.results.find(r => r.node_id === "n1")?.undelivered_edges, undefined);
				assert.doesNotMatch(formatReportDigest(rep.results), /\[undelivered:/);
				assert.doesNotMatch(readFileSync(rep.report_md!, "utf8"), /Undelivered edges:/);
			});
		}
	}

	// probe-e Ea: loop author completed normally (queued offer), result rewritten to pending, vanished, run cancel -> queued offer preserved.
	for (const cleanup of ["manual", "on_success"] as const) {
		await t.test(`Ea loop author queued offer ${cleanup}`, async () => {
			const f = await runFixture(t, {
				topology: "chain",
				task: `H4 Ea ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				cleanup_settle_ms: 0,
				agents: [
					{ node_id: "build", persona: "first", sub_task: "Build" },
					{
						node_id: "review",
						persona: "second",
						sub_task: "Review",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					},
					{ node_id: "publish", persona: "second", sub_task: "Publish" },
				],
			}, new Map(), { simulateShutdown: true });
			const b = f.nodes.get("build")!;
			const r = f.nodes.get("review")!;
			await b.complete(complete("b"));
			const p = resultPath(f.run.session_dir, `${b.config.instance_id}.1`);
			atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
			b.vanish();
			await f.service.cancel(f.run.task_id, { reason: "stop", grace_ms: 0 });
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.state, "cancelled");
			assert.equal(st.outcome.terminal, true);
			assert.deepEqual(st.pending, []);
			const bState = st.agents.find(a => a.node_id === "build")!;
			const outView = bState.handoffs_out?.[r.config.instance_id] ?? bState.handoff_out;
			assert.equal(outView?.state, "queued");
			assert.equal(outView?.not_delivered_reason, undefined);
			assert.match(formatAgentStates(st.agents, "chain"), /a1-build .*handoff out h-[0-9a-f]+ queued: not accepted yet/);
			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			assert.equal(rep.results.find(r2 => r2.node_id === "build")?.undelivered_edges, undefined);
		});
	}

	// probe-b B1: live non-loop n1 hanging coms_send to n2 then run cancel -> already settled on f7707e8, keeps offered text & no undelivered_edges.
	for (const cleanup of ["manual", "on_success"] as const) {
		await t.test(`B1 live non-loop hanging coms ${cleanup}`, async () => {
			const entered = Promise.withResolvers<void>();
			const f = await runFixture(t, {
				topology: "chain",
				task: `H4 B1 ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				cleanup_settle_ms: 0,
				agents: [
					{ node_id: "n1", persona: "first", sub_task: "One" },
					{ node_id: "n2", persona: "second", sub_task: "Two" },
				],
			}, new Map([["n1", {
				executeTool: async (_name: string, params: unknown) => {
					if (String((params as { target?: string })?.target ?? "").includes("n2")) {
						entered.resolve();
						return new Promise(() => {});
					}
					return { content: [], details: { msg_id: "m" } };
				},
			}]]) as any, { simulateShutdown: true });
			void f.nodes.get("n1")!.complete(complete("one"));
			await entered.promise;
			await f.service.cancel(f.run.task_id, { reason: "stop", grace_ms: 0 });
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.state, "cancelled");
			assert.equal(st.outcome.terminal, true);
			assert.deepEqual(st.pending, []);
			assert.equal(st.agents.find(a => a.node_id === "n1")?.handoff_out?.not_delivered_reason, undefined);
			assert.match(formatAgentStates(st.agents, "chain"), /handoff out h-[0-9a-f]+ offered: not delivered yet/);
			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			assert.equal(rep.results.find(r => r.node_id === "n1")?.undelivered_edges, undefined);
		});
	}
});

test("G2 round 1 M5 pin: live loop reviewer blocked in hanging coms_send then run cancel settles cancelled/terminal", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const cleanup of ["manual", "on_success"] as const) {
		await t.test(cleanup, async () => {
			const entered = Promise.withResolvers<void>();
			const f = await runFixture(t, {
				topology: "chain",
				task: `M5 A5 ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				cleanup_settle_ms: 0,
				agents: [
					{ node_id: "build", persona: "first", sub_task: "Build" },
					{
						node_id: "review",
						persona: "second",
						sub_task: "Review",
						output_contract: verdictContract,
						decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					},
					{ node_id: "publish", persona: "second", sub_task: "Publish" },
				],
			}, new Map([["review", {
				executeTool: async (_name: string, params: unknown) => {
					if (String((params as { target?: string })?.target ?? "").includes("publish")) {
						entered.resolve();
						return new Promise(() => {});
					}
					return { content: [], details: { msg_id: "m" } };
				},
			}]]) as any, { simulateShutdown: true });
			const b = f.nodes.get("build")!;
			const r = f.nodes.get("review")!;
			await b.complete(complete("b"));
			await r.deliverNotification(b);
			void r.complete(complete("ok", "approve"));
			await entered.promise;

			await f.service.cancel(f.run.task_id, { reason: "stop", grace_ms: 0 });
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(st.pending, []);
			assert.deepEqual(st.worker_errors, []);
			assert.deepEqual(st.delivery_errors, []);
			assert.equal(st.outcome.state, "cancelled");
			assert.equal(st.outcome.terminal, true);
			const revState = st.agents.find(a => a.node_id === "review")!;
			const pubState = st.agents.find(a => a.node_id === "publish")!;
			assert.equal((revState.handoffs_out?.[pubState.instance_id] ?? revState.handoff_out)?.not_delivered_reason, "run was cancelled: stop");
			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			assert.deepEqual(rep.results.find(x => x.node_id === "review")?.undelivered_edges, [
				{ destination: "publish", reason: "not delivered (run was cancelled: stop)" },
			]);
		});
	}
});

test("G2 round 1 M6: fail_fast-cancelled targets without bootstrap_cancel stay byte-identical to f7707e8", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// probe-d D1: non-loop graph root -> [left, right], root send to right fails, left fails under fail_fast.
	for (const cleanup of ["manual", "on_success"] as const) {
		await t.test(`D1 ${cleanup}`, async () => {
			const f = await runFixture(t, {
				topology: "graph",
				task: `M6 D1 ${cleanup}`,
				project_cwd: process.cwd(),
				cleanup,
				failure_policy: "fail_fast",
				agents: [
					{ node_id: "root", persona: "first", sub_task: "Root" },
					{ node_id: "left", persona: "second", depends_on: ["root"], sub_task: "Left" },
					{ node_id: "right", persona: "second", depends_on: ["root"], sub_task: "Right" },
				],
			}, new Map([["root", {
				executeTool: async (_name: string, params: unknown) => {
					if (String((params as { target?: string })?.target ?? "").includes("right")) {
						return { isError: true, content: [{ type: "text", text: "down" }] };
					}
					return { content: [], details: { msg_id: "m" } };
				},
			}]]) as any, { simulateShutdown: true });
			const root = f.nodes.get("root")!;
			const left = f.nodes.get("left")!;
			const right = f.nodes.get("right")!;
			await root.complete(complete("root"));
			root.vanish();
			await left.deliverNotification(root);
			await left.complete({ status: "failure", summary: "left bad", detail: "left bad" });
			for (let i = 0; i < 5; i++) {
				t.mock.timers.tick(1000);
				await new Promise(r => setImmediate(r));
			}
			const st = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(st.outcome.state, "failed");
			assert.equal(st.outcome.terminal, true);
			assert.deepEqual(st.pending, []);
			assert.deepEqual(st.worker_errors, []);
			assert.deepEqual(st.delivery_errors, []);
			assert.equal(st.agents.find(a => a.node_id === "root")?.handoffs_out?.[right.config.instance_id]?.not_delivered_reason, undefined);
			assert.match(formatAgentStates(st.agents, "graph"), /handoff out -> a3-right h-[0-9a-f]+ offered: not delivered yet/);
			const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
			assert.equal(rep.results.find(r => r.node_id === "root")?.undelivered_edges, undefined);
			assert.doesNotMatch(formatReportDigest(rep.results), /\[undelivered:/);
			assert.doesNotMatch(readFileSync(rep.report_md!, "utf8"), /Undelivered edges:/);
		});
	}

	// Loop source whose successor is cancelled by fail_fast (no bootstrap_cancel): stays unsettled as on f7707e8.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "graph",
			task: "M6 loop fail_fast",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			failure_policy: "fail_fast",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
				{ node_id: "other", persona: "first", sub_task: "Other" },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const other = f.nodes.get("other")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();
		await other.complete({ status: "failure", summary: "other failed", detail: "other failed" });
		for (let i = 0; i < 5; i++) {
			t.mock.timers.tick(1000);
			await new Promise(r => setImmediate(r));
		}
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "incomplete");
		assert.equal(st.outcome.terminal, false);
		assert.deepEqual(st.pending, ["review"]);
		assert.deepEqual(st.worker_errors, ["review (persona second): process exited during chain handoff"]);
		const pubState = st.agents.find(a => a.node_id === "publish")!;
		assert.equal(pubState.execution, "cancelled");
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[pubState.instance_id]?.not_delivered_reason, undefined);

		// Also before publish.1.disposition.json lands (only fail-fast.json + fail-fast publish.cancel.json exist): still unsettled.
		rmSync(dispositionPath(f.run.session_dir, `${pubState.instance_id}.1`), { force: true });
		const stNoDisp = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(stNoDisp.outcome.state, "incomplete");
		assert.equal(stNoDisp.outcome.terminal, false);
		assert.deepEqual(stNoDisp.pending, ["review"]);
		assert.deepEqual(stNoDisp.worker_errors, ["review (persona second): process exited during chain handoff"]);
		assert.equal(stNoDisp.agents.find(a => a.node_id === "review")?.handoffs_out?.[pubState.instance_id]?.not_delivered_reason, undefined);
	}
});

test("G2 round 1 M7: target guardrails (reviewErrors, completed claim, working target, attempt match, synthetic handoff_out, force-close reason)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// M01 reviewErrors: live review rejects with failed delivery -> revision 2 reserved -> run cancel -> corrupt claim on build.2 triggers reviewErrors.has(build).
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "M01 reviewErrors",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("build")) {
					return { isError: true, content: [{ type: "text", text: "feedback send failed" }] };
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build 1"));
		await review.deliverNotification(build);
		await review.complete(complete("Fix", "changes_requested"));
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Cancel run", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
		// Corrupt claim on build.2 forces reviewErrors.set(build.instance_id, ...).
		writeFileSync(handoffClaimPath(f.run.session_dir, `${build.config.instance_id}.2`, review.config.instance_id), "{bad json");
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "needs_attention");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.pending.includes("review"), true);
		assert.equal(st.delivery_errors.some(e => e.includes("review") && e.includes("feedback send failed")), true);
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[build.config.instance_id]?.not_delivered_reason, undefined);
	}

	// M10 claimCompleted: publish won outcome-claim "completed" without flushing result.json, then vanished + run cancel.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "graph",
			task: "M10 claimCompleted",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();
		assert.equal(claimOutcome(f.run.session_dir, {
			run_id: f.run.task_id, node_id: "publish", persona_name: publish.config.persona_name,
			attempt_id: `${publish.config.instance_id}.1`, instance_id: publish.config.instance_id,
		}, "completed", new Date(Date.now()).toISOString(), `${publish.config.instance_id}.1`).won, true);
		publish.vanish();
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Late cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "needs_attention");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.pending.includes("review"), true);
		assert.equal(st.worker_errors.some(e => e.includes("review") && e.includes("process exited during chain handoff")), true);
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[publish.config.instance_id]?.not_delivered_reason, undefined);
	}

	// M11 workingTarget: publish is live and working when cancel.json is written -> review stays pending & unannotated while publish is cancelling.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "graph",
			task: "M11 workingTarget",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();
		atomicJson(join(f.run.session_dir, `${publish.config.instance_id}.progress.json`), {
			version: 1,
			token: f.run.token,
			instance_id: publish.config.instance_id,
			attempt_id: `${publish.config.instance_id}.1`,
			state: "working",
			started_at: Date.now(),
			updated_at: Date.now(),
			last_activity_at: Date.now(),
		});
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Stop", requestedAt: new Date(Date.now()).toISOString(), graceMs: 5000 });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "incomplete");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.pending.includes("review"), true);
		assert.equal(st.pending.includes("publish"), true);
		assert.equal(st.worker_errors.some(e => e.includes("review") && e.includes("process exited during chain handoff")), true);
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[publish.config.instance_id]?.not_delivered_reason, undefined);
	}

	// M13 attemptMatch: live review rejects with failed delivery to build.2; build.cancel.json scoped to build.1 must NOT settle review->build.2.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "M13 attemptMatch",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("build")) {
					return { isError: true, content: [{ type: "text", text: "feedback send failed" }] };
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build 1"));
		await review.deliverNotification(build);
		await review.complete(complete("Fix", "changes_requested"));
		writeCancelRecord(f.run.session_dir, {
			identity: {
				run_id: f.run.task_id, node_id: "build", persona_name: build.config.persona_name,
				attempt_id: `${build.config.instance_id}.1`, instance_id: build.config.instance_id,
			},
			scope: "node",
			reason: "Stale attempt 1 cancel",
			requestedAt: new Date(Date.now()).toISOString(),
			graceMs: 0,
		});
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "incomplete");
		assert.equal(st.outcome.terminal, false);
		assert.equal(st.pending.includes("review"), true);
		assert.equal(st.delivery_errors.some(e => e.includes("review") && e.includes("feedback send failed")), true);
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[build.config.instance_id]?.not_delivered_reason, undefined);
	}

	// M21 synthOut: chain n1->n2 crash window with no handoff-offer.json at all (state.handoff_out absent) synthesizes not_delivered_reason and report undelivered_edges.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "chain",
			task: "M21 synthOut",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				{ node_id: "n1", persona: "first", sub_task: "One" },
				{ node_id: "n2", persona: "second", sub_task: "Two" },
			],
		}, new Map([["n1", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("n2")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const n1 = f.nodes.get("n1")!;
		const n2 = f.nodes.get("n2")!;
		void n1.complete(complete("One ok"));
		await enteredSend.promise;
		n1.vanish();
		rmSync(handoffOfferPath(f.run.session_dir, n2.config.instance_id), { force: true });
		writeRunCancelRecord(f.run.session_dir, { run_id: f.run.task_id, reason: "Crash cancel", requestedAt: new Date(Date.now()).toISOString(), graceMs: 0 });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assert.deepEqual(st.pending, []);
		assert.equal(st.agents.find(a => a.node_id === "n1")?.handoff_out?.not_delivered_reason, "run was cancelled: Crash cancel");
		assert.match(formatAgentStates(st.agents, "chain"), /handoff out: not delivered \(run was cancelled: Crash cancel\)/);
		const rep = await f.service.report(f.run.task_id, undefined, true, buildMarkdownReport);
		assert.deepEqual(rep.results.find(r => r.node_id === "n1")?.undelivered_edges, [
			{ destination: "n2", reason: "not delivered (run was cancelled: Crash cancel)" },
		]);
	}

	// M29 dispReason: force_close writes "(force-closed after grace period)" in disposition.reason; not_delivered_reason uses cancel record's reason.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "graph",
			task: "M29 dispReason",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
				{ node_id: "publish", persona: "second", depends_on: ["review"], sub_task: "Publish" },
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("publish")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const publish = f.nodes.get("publish")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Approved", "approve"));
		await enteredSend.promise;
		review.vanish();
		atomicJson(join(f.run.session_dir, `${publish.config.instance_id}.progress.json`), {
			version: 1,
			token: f.run.token,
			instance_id: publish.config.instance_id,
			attempt_id: `${publish.config.instance_id}.1`,
			state: "working",
			started_at: Date.now(),
			updated_at: Date.now(),
			last_activity_at: Date.now(),
		});
		await f.service.cancel(f.run.task_id, { reason: "Stop force", grace_ms: 0 });
		await f.service.cancel(f.run.task_id, { reason: "Stop force", force_close: true });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.outcome.state, "cancelled");
		assert.equal(st.outcome.terminal, true);
		assert.equal(
			st.agents.find(a => a.node_id === "review")?.handoffs_out?.[publish.config.instance_id]?.not_delivered_reason,
			"run was cancelled: Stop force",
		);
	}

	// M20 annotateClosed: a finalized rejected/cancelled review with an error record (so oldBaseSettled is false, closedEdge is truthy) must not annotate its closed edge on cancel.
	{
		const enteredSend = Promise.withResolvers<void>();
		const f = await runFixture(t, {
			topology: "graph",
			task: "M20 annotateClosed",
			project_cwd: process.cwd(),
			cleanup: "on_success",
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		}, new Map([["review", {
			executeTool: async (_name: string, params: unknown) => {
				if (String((params as { target?: string })?.target ?? "").includes("build")) {
					enteredSend.resolve();
					return new Promise(() => {});
				}
				return { content: [], details: { msg_id: "m" } };
			},
		}]]) as any, { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		await build.complete(complete("Build ok"));
		await review.deliverNotification(build);
		void review.complete(complete("Fix", "changes_requested"));
		await enteredSend.promise;
		atomicJson(join(f.run.session_dir, `${review.config.instance_id}.1.error.json`), { error: "late error" });
		await f.service.cancel(f.run.task_id, { reason: "Cancel run", grace_ms: 0 });
		const st = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(st.agents.find(a => a.node_id === "review")?.handoffs_out?.[build.config.instance_id]?.not_delivered_reason, undefined);
	}
});
