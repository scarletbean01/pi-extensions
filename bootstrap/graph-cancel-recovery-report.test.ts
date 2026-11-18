import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelPath, writeCancelRecord } from "./cancellation.ts";
import { formatCancelResult, formatRecovery, formatReportDigest, buildMarkdownReport } from "./reporting.ts";
import { atomicJson } from "./session-store.ts";
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
