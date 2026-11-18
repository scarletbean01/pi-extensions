import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMarkdownReport, formatAgentStates, formatPlan, formatReportDigest, formatRunOutcome } from "./reporting.ts";
import { parseCompletion, parseManifest, parseWorkerConfig } from "./session-store.ts";
import { model, runFixture, serviceFixture } from "./test-support/chain-fixture.ts";
import { parseCompletion as parsePrevCompletion, parseManifest as parsePrevManifest, parseWorkerConfig as parsePrevWorkerConfig } from "./test-support/previous-v5-095d12b-session-store.ts";

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

function twoBranchPlan(cwd: string, overrides?: {
	maxRevisionsA?: number;
	maxRevisionsB?: number;
	maxTotalAttempts?: number;
	cleanup?: "on_success" | "manual";
	joinPolicy?: "all_success" | "allow_partial";
	dependencyWaitMs?: number;
}) {
	return {
		topology: "graph" as const,
		task: "Two-branch review loops joining into merge",
		project_cwd: cwd,
		...(overrides?.maxTotalAttempts !== undefined ? { max_total_attempts: overrides.maxTotalAttempts } : {}),
		...(overrides?.cleanup !== undefined ? { cleanup: overrides.cleanup } : {}),
		agents: [
			{ node_id: "scout-a", persona: "first", sub_task: "Scout A" },
			{ node_id: "scout-b", persona: "first", sub_task: "Scout B" },
			{ node_id: "build-a", persona: "second", depends_on: ["scout-a"], sub_task: "Build A" },
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

function assertOwnershipReleased(status: ReturnType<Awaited<ReturnType<typeof runFixture>>["status"]>) {
	for (const agent of status.agents) {
		assert.notEqual(agent.ownership_status, "admitted", `${agent.node_id} should have released ownership`);
	}
}

test("planning validates disjoint loop bodies, strict-ancestor on_reject in graphs, loop_body excludes outside branches, and graph cleanup defaults to on_success", t => {
	const f = serviceFixture(t, ["first", "second"]);

	const preview = f.service.plan(twoBranchPlan(f.cwd), model);
	assert.equal(preview.cleanup, "on_success");
	assert.equal(preview.agents.find(a => a.node_id === "review-a")?.decision?.loop_body.join(","), "build-a,review-a");
	assert.equal(preview.agents.find(a => a.node_id === "review-b")?.decision?.loop_body.join(","), "build-b,review-b");
	assert.equal(preview.max_total_attempts, 8 + 3 * 2 + 3 * 2);

	// A node in a parallel branch is earlier in topological order but is NOT a strict ancestor of review-b.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Cross-branch on_reject",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "build-a", persona: "first", sub_task: "Build A" },
			{ node_id: "build-b", persona: "first", sub_task: "Build B" },
			{
				node_id: "review-b",
				persona: "second",
				depends_on: ["build-b"],
				sub_task: "Review B",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-a" },
			},
		],
	}, model), /strict ancestor/);

	// Overlapping loop bodies: outer loop covers inner loop's body.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Overlapping loops",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{
				node_id: "b",
				persona: "second",
				depends_on: ["a"],
				sub_task: "B",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "a" },
			},
			{
				node_id: "c",
				persona: "second",
				depends_on: ["b"],
				sub_task: "C",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "a" },
			},
		],
	}, model), /loop bodies overlap/);

	// A body node cannot be another loop's target.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Body node as target",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{
				node_id: "b",
				persona: "second",
				depends_on: ["a"],
				sub_task: "B",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "a" },
			},
			{
				node_id: "c",
				persona: "second",
				depends_on: ["b"],
				sub_task: "C",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "b" },
			},
		],
	}, model), /loop bodies overlap/);

	// Outside sibling off upstream scout does not get pulled into loop_body.
	const sidePlan = f.service.plan({
		topology: "graph",
		task: "Side branch off scout",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "scout", persona: "first", sub_task: "Scout" },
			{ node_id: "build", persona: "first", depends_on: ["scout"], sub_task: "Build" },
			{ node_id: "docs", persona: "second", depends_on: ["scout"], sub_task: "Docs" },
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build" },
			},
		],
	}, model);
	assert.deepEqual(sidePlan.agents.find(a => a.node_id === "review")?.decision?.loop_body, ["build", "review"]);
});

test("dry-run overlap warning states when a whole loop serializes with an overlapping parallel writer", t => {
	const f = serviceFixture(t, ["first", "second"]);
	const preview = f.service.plan({
		topology: "graph",
		task: "Loop serialization warning",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "build-a", persona: "first", write_paths: ["src/"], sub_task: "Build A" },
			{
				node_id: "review-a",
				persona: "second",
				depends_on: ["build-a"],
				sub_task: "Review A",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-a" },
			},
			{ node_id: "other", persona: "first", write_paths: ["src/other.ts"], sub_task: "Parallel writer" },
		],
	}, model);
	const text = formatPlan(preview);
	assert.match(text, /whole loop.*serializes/i);
	assert.match(text, /other waits for build-a/);
});

test("two-branch plan runs end to end: join waits while one branch revises, succeeds, and auto-cleans", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { dependencyWaitMs: 3000 }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;
	const next = f.nodes.get("next")!;

	await scoutA.complete(complete("Scout A done"));
	await scoutB.complete(complete("Scout B done"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);

	// Branch B approves on attempt 1 and notifies merge; Branch A rejects on attempt 1.
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Fix A", "changes_requested"));
	await merge.deliverNotification(reviewB);

	const whileRevising = f.status();
	assert.equal(whileRevising.outcome.terminal, false);
	const mergeWhileRevising = whileRevising.agents.find(a => a.node_id === "merge")!;
	assert.equal(mergeWhileRevising.execution, "waiting");
	assert.deepEqual(mergeWhileRevising.edge_states, { "review-a": "pending", "review-b": "fired" });
	assert.match(formatAgentStates(whileRevising.agents, "graph"), /\[edges: review-a=pending, review-b=fired\]/);

	// Advance clock past merge's dependency_wait_timeout_ms while branch A is legitimately revising.
	await buildA.deliverNotification(reviewA);
	t.mock.timers.tick(2000);
	await buildA.complete(complete("Build A v2"));
	t.mock.timers.tick(2000);
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Review A ok", "approve"));

	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "waiting");

	await merge.deliverNotification(reviewA);
	await merge.complete(complete("Merged A v2 and B v1"));
	await next.deliverNotification(merge);
	await next.complete(complete("All done"));

	const finalStatus = f.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	assert.equal(finalStatus.outcome.terminal, true);
	assert.deepEqual(finalStatus.worker_errors, []);
	assert.equal(finalStatus.agents.find(a => a.node_id === "build-a")?.attempt_id.endsWith(".2"), true);
	assert.equal(finalStatus.agents.find(a => a.node_id === "review-a")?.attempt_id.endsWith(".2"), true);
	assert.equal(finalStatus.agents.find(a => a.node_id === "build-b")?.attempt_id.endsWith(".1"), true);
	assert.equal(finalStatus.agents.find(a => a.node_id === "review-b")?.attempt_id.endsWith(".1"), true);
	assert.equal(finalStatus.agents.find(a => a.node_id === "scout-a")?.attempt_id.endsWith(".1"), true);
	assertOwnershipReleased(finalStatus);

	// Automatic cleanup runs after settle window (3000ms).
	t.mock.timers.tick(3000);
	const cleaned = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(cleaned.manifest.status, "cleaned");
	assert.equal(cleaned.manifest.cleanup_trigger, "auto");
	assert.equal(existsSync(join(cleaned.manifest.session_dir, "manifest.json")), true);

	const report = await f.report();
	assert.match(formatReportDigest(report.results), /Build A v1/);
	assert.match(formatReportDigest(report.results), /Build A v2/);
	assert.match(buildMarkdownReport(report.results), /Review A ok/);
});

test("exhausted loop in one branch ends needs_attention, blocks merge with cause naming the loop, and keeps tabs", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 1 }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

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
	await merge.deliverNotification(reviewB);

	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Reject A 2", "changes_requested"));

	// Poll merge's timer so merge writes its blocked disposition.
	t.mock.timers.tick(1000);
	// Poll next's timer so next writes its blocked disposition.
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	const revA = st.agents.find(a => a.node_id === "review-a")!;
	assert.equal(revA.execution, "needs_attention");
	assert.equal(revA.finalized, true);
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mrg.execution, "blocked");
	assert.deepEqual(mrg.edge_states, { "review-a": "dead", "review-b": "fired" });
	assert.match(mrg.execution_reason ?? "", /build-a.*review-a/);
	assert.equal(mrg.execution_causes.some(c => c.node_id === "review-a"), true);
	assertOwnershipReleased(st);

	t.mock.timers.tick(5000);
	assert.equal(f.status().manifest.status, "applied", "needs_attention run keeps tabs");
});

test("loops in parallel branches revise independently while outside nodes stay untouched", async t => {
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 2, maxRevisionsB: 2, cleanup: "manual" }), new Map(), { simulateShutdown: true });
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

	// Both reject attempt 1.
	await reviewA.complete(complete("Revise A 1", "changes_requested"));
	await reviewB.complete(complete("Revise B 1", "changes_requested"));

	// Branch A revises to attempt 2 and still rejects; Branch B revises to attempt 2 and approves.
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Revise A 2", "changes_requested"));

	await buildB.deliverNotification(reviewB);
	await buildB.complete(complete("Build B v2"));
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B v2 ok", "approve"));
	await merge.deliverNotification(reviewB);

	const mid = f.status();
	assert.equal(mid.agents.find(a => a.node_id === "review-a")?.attempt_id.endsWith(".2"), true);
	assert.equal(mid.agents.find(a => a.node_id === "review-b")?.finalized, true);
	assert.equal(mid.agents.find(a => a.node_id === "merge")?.execution, "waiting");

	// Branch A revises to attempt 3 and approves.
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v3"));
	await reviewA.deliverNotification(buildA);
	await reviewA.complete(complete("Review A v3 ok", "approve"));
	await merge.deliverNotification(reviewA);

	await merge.complete(complete("Merged"));
	await next.deliverNotification(merge);
	await next.complete(complete("Done"));

	const done = f.status();
	assert.equal(done.outcome.state, "succeeded");
	assert.equal(done.outcome.terminal, true);
	assert.deepEqual(done.worker_errors, []);
	assert.equal(done.agents.find(a => a.node_id === "build-a")?.attempt_id.endsWith(".3"), true);
	assert.equal(done.agents.find(a => a.node_id === "build-b")?.attempt_id.endsWith(".2"), true);
	assert.equal(done.agents.find(a => a.node_id === "scout-a")?.attempt_id.endsWith(".1"), true);
	assert.equal(done.agents.find(a => a.node_id === "merge")?.attempt_id.endsWith(".1"), true);
	assertOwnershipReleased(done);
});

test("builder failure during a revision in one branch settles that loop and blocks the join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd()), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Fix A", "changes_requested"));
	await merge.deliverNotification(reviewB);

	await buildA.deliverNotification(reviewA);
	await buildA.complete({ status: "failure", summary: "Build A v2 crashed", detail: "compile error" });

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.equal(st.outcome.state, "failed");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.agents.find(a => a.node_id === "build-a")?.execution, "failed");
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.execution, "blocked");
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution_causes.some(c => c.node_id === "build-a" && c.state === "failed"), true);
	assert.deepEqual(st.agents.find(a => a.node_id === "merge")?.edge_states, { "review-a": "dead", "review-b": "fired" });
	assertOwnershipReleased(st);
});

test("partial decision in a graph branch settles the loop and blocks even an allow_partial join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { joinPolicy: "allow_partial" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A v1"));
	await buildB.complete(complete("Build B v1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete({ ...complete("Review A inconclusive", "changes_requested"), status: "partial" });
	await merge.deliverNotification(reviewB);

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.equal(st.outcome.state, "blocked", JSON.stringify(st.agents.map(a => ({ id: a.node_id, exec: a.execution, parked: a.parked, fin: a.finalized }))));
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.execution, "partial");
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.finalized, true);
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.deepEqual(st.agents.find(a => a.node_id === "merge")?.edge_states, { "review-a": "dead", "review-b": "fired" });
	assertOwnershipReleased(st);
});

test("run budget exhaustion in one branch ends needs_attention with run-budget cause and blocks the join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// 8 nodes + 1 revision (2 attempts) = 10 attempts max; second revision is blocked by run budget.
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { maxRevisionsA: 3, maxTotalAttempts: 10 }), new Map(), { simulateShutdown: true });
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
	await reviewA.complete(complete("Reject A 2", "changes_requested"));

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assert.match(st.agents.find(a => a.node_id === "review-a")?.execution_reason ?? "", /budget/i);
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assertOwnershipReleased(st);
});

test("parallel writer with overlapping write_paths waits while loop body is parked and runs after finalization", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Loop ownership serialization",
		cleanup: "manual",
		agents: [
			{ node_id: "build", persona: "first", write_paths: ["src/"], sub_task: "Build" },
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
			},
			{ node_id: "other", persona: "first", write_paths: ["src/other.ts"], sub_task: "Other" },
		],
	}, new Map(), { simulateShutdown: true });

	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;
	const other = f.nodes.get("other")!;

	await build.complete(complete("Build v1"));
	await review.deliverNotification(build);
	await review.complete(complete("Revise", "changes_requested"));

	// Build is parked with ownership still admitted; other cannot start yet.
	t.mock.timers.tick(1000);
	const whileParked = f.status();
	assert.equal(whileParked.agents.find(a => a.node_id === "build")?.ownership_status, "admitted");
	assert.equal(whileParked.agents.find(a => a.node_id === "other")?.ownership_status, "waiting");
	assert.notEqual(whileParked.agents.find(a => a.node_id === "other")?.execution, "running");

	await build.deliverNotification(review);
	await build.complete(complete("Build v2"));
	await review.deliverNotification(build);
	await review.complete(complete("Approved", "approve"));

	// Now finalization happened, so other's ownership timer admits it and it completes.
	t.mock.timers.tick(1000);
	await other.deliverFollowUps();
	await other.beforeStart();
	const beforeOther = f.status().agents.find(a => a.node_id === "other");
	assert.equal(beforeOther?.ownership_status, "admitted", JSON.stringify(beforeOther));
	await other.complete(complete("Other done"));

	const afterFinalize = f.status();
	assert.equal(afterFinalize.agents.find(a => a.node_id === "build")?.ownership_status, "released");
	assert.equal(afterFinalize.agents.find(a => a.node_id === "other")?.execution, "succeeded");
	assertOwnershipReleased(afterFinalize);
});

test("cancelling a run with a parked loop branch and a waiting join settles all nodes and releases ownership", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

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
	await merge.deliverNotification(reviewB);

	const cancelled = await f.service.cancel(f.run.task_id, { reason: "Stop graph run" });
	assert.equal(cancelled.cancelled.includes("review-a"), true);

	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	assert.equal(st.outcome.state, "cancelled");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.agents.find(a => a.node_id === "review-a")?.execution, "cancelled");
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "cancelled");
	assert.equal(st.agents.find(a => a.node_id === "next")?.execution, "cancelled");
	assertOwnershipReleased(st);
});

test("dead parked member in one branch makes its decision node needs_attention and blocks the join", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = twoBranchPlan(process.cwd(), { cleanup: "manual", dependencyWaitMs: 3000 });
	plan.agents.find(a => a.node_id === "build-a")!.write_paths = ["src/a"];
	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

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
	await merge.deliverNotification(reviewB);

	buildA.vanish();
	// Dispatcher status poll detects dead parked member and finalizes the loop durably.
	const detected = f.status();
	assert.equal(detected.agents.find(a => a.node_id === "review-a")?.finalized, true);
	t.mock.timers.tick(1000);
	t.mock.timers.tick(1000);

	const st = f.status();
	const revA = st.agents.find(a => a.node_id === "review-a")!;
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(revA.execution, "needs_attention");
	assert.equal(revA.finalized, true);
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assert.equal(st.worker_errors.length > 0, true);
	assert.equal(mrg.execution, "blocked");
	assert.deepEqual(mrg.edge_states, { "review-a": "dead", "review-b": "fired" });
	assert.equal(mrg.execution_causes.some(c => c.node_id === "review-a" && c.state === "needs_attention"), true);
	assert.match(mrg.execution_reason ?? "", /build-a/);
	assertOwnershipReleased(st);
});

test("recovery retries a failed forward delivery from an approved loop reviewer to the join", async t => {
	let failComs = false;
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map([
		["review-a", {
			executeTool: async () => {
				if (failComs) throw new Error("temporary coms outage");
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
	await reviewB.complete(complete("Review B ok", "approve"));
	await merge.deliverNotification(reviewB);

	await reviewA.complete(complete("Reject A 1", "changes_requested"));
	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);

	// Fail Coms delivery from review-a to merge on attempt 2.
	failComs = true;
	await reviewA.complete(complete("Review A v2 ok", "approve"));
	failComs = false;
	assert.equal(f.status().delivery_errors.length, 1);

	const delivered: Array<{ target: string; prompt: string }> = [];
	const retried = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "merge", source: "review-a" }, {
		senderSession: "dispatcher",
		wake: async (target, prompt) => { delivered.push({ target, prompt }); },
	});
	assert.equal(retried.refused, undefined);
	assert.equal(delivered.length, 1);
	await merge.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", content: delivered[0].prompt, details: { sender_session: "dispatcher" } },
	});
	await merge.complete(complete("Merged after recovery"));
	await next.deliverNotification(merge);
	await next.complete(complete("All done"));

	const finalStatus = f.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	assert.equal(finalStatus.outcome.terminal, true);
	assert.deepEqual(finalStatus.worker_errors, []);
	assertOwnershipReleased(finalStatus);
});

// ---- Findings 1-10 regression tests ----

const graphNode = (node_id: string, depends_on: string[] = [], extra: Record<string, unknown> = {}) => ({
	node_id, persona: "first", depends_on, sub_task: node_id, ...extra,
});
const graphReviewer = (id: string, target: string, parents: string[], extra: Record<string, unknown> = {}) =>
	graphNode(id, parents, {
		output_contract: verdictContract,
		decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: target },
		...extra,
	});

test("planning rejects a join inside a loop body (finding 1)", t => {
	const f = serviceFixture(t);
	for (const kind of ["middle", "reviewer"] as const) {
		const plan = {
			topology: "graph" as const,
			task: `Join in loop body (${kind})`,
			project_cwd: f.cwd,
			agents: [
				graphNode("build"),
				graphNode("left", ["build"]),
				graphNode("right", ["build"]),
				...(kind === "middle" ? [graphNode("join", ["left", "right"])] : []),
				graphReviewer("review", "build", kind === "middle" ? ["join"] : ["left", "right"]),
			],
		};
		const expectedJoin = kind === "middle" ? "join" : "review";
		assert.throws(
			() => f.service.plan(plan, model),
			new RegExp(`${expectedJoin}`),
			`planning should reject ${kind} join inside loop body`,
		);
	}
});

test("planning rejects a non-reviewer loop member with a successor outside the loop body (finding 2)", t => {
	const f = serviceFixture(t);
	for (const isJoin of [false, true]) {
		const plan = {
			topology: "graph" as const,
			task: `Side exit from loop body (${isJoin ? "join" : "follower"})`,
			project_cwd: f.cwd,
			agents: [
				graphNode("build"),
				graphReviewer("review", "build", ["build"]),
				...(isJoin ? [graphNode("other")] : []),
				graphNode("side", isJoin ? ["build", "other"] : ["build"]),
			],
		};
		assert.throws(
			() => f.service.plan(plan, model),
			/build.*side|side.*build/,
			"planning should reject side exit from non-reviewer loop member",
		);
	}
});

test("planning rejects parallel loops with overlapping write_paths and no dependency ordering (finding 3)", t => {
	const f = serviceFixture(t);
	const crossedPlan = {
		topology: "graph" as const,
		task: "Crossed write paths between parallel loops",
		project_cwd: f.cwd,
		agents: [
			graphNode("build-a", [], { write_paths: ["x"] }),
			graphNode("build-b", [], { write_paths: ["y"] }),
			graphReviewer("review-a", "build-a", ["build-a"], { write_paths: ["y"] }),
			graphReviewer("review-b", "build-b", ["build-b"], { write_paths: ["x"] }),
			graphNode("merge", ["review-a", "review-b"]),
		],
	};
	assert.throws(
		() => f.service.plan(crossedPlan, model),
		/review-a.*review-b|build-a.*build-b/,
		"planning should reject parallel loops with overlapping write_paths",
	);

	// Sequentially ordered loops with overlapping write_paths remain valid.
	const sequentialPlan = {
		topology: "graph" as const,
		task: "Sequential overlapping loops",
		project_cwd: f.cwd,
		agents: [
			graphNode("build-a", [], { write_paths: ["x"] }),
			graphReviewer("review-a", "build-a", ["build-a"]),
			graphNode("build-b", ["review-a"], { write_paths: ["x"] }),
			graphReviewer("review-b", "build-b", ["build-b"]),
		],
	};
	const planned = f.service.plan(sequentialPlan, model);
	assert.equal(planned.agents.length, 4);
});

test("reload after graph-loop join claims but before result reports accepted before restart (finding 4)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A"));
	await buildB.complete(complete("Build B"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Review A ok", "approve"));
	await merge.deliverNotification(reviewB);

	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "running");

	await f.reload("merge");
	const st = f.status();
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mrg.execution, "needs_attention");
	assert.match(mrg.execution_reason ?? "", /accepted.*restart/);
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.worker_errors.length > 0, true);
	assertOwnershipReleased(st);
});

test("graph-decision runs use version 6, reject mismatched v5/v6 records, and are rejected by 095d12b reader (finding 6)", async t => {
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { cleanup: "manual" }), new Map(), { simulateShutdown: true });
	const rawManifest = JSON.parse(readFileSync(join(f.run.session_dir, "manifest.json"), "utf8"));
	const mergeId = f.nodes.get("merge")!.config.instance_id;
	const rawConfig = JSON.parse(readFileSync(join(f.run.session_dir, `${mergeId}.config.json`), "utf8"));

	await f.nodes.get("scout-a")!.complete(complete("Scout A"));
	const rawResult = JSON.parse(readFileSync(join(f.run.session_dir, `${f.nodes.get("scout-a")!.config.instance_id}.1.result.json`), "utf8"));

	assert.equal(rawManifest.version, 6);
	assert.equal(rawConfig.version, 6);
	assert.equal(rawResult.version, 6);

	// Current reader rejects v5 graph decision and v6 non-graph-decision records.
	assert.throws(() => parseManifest({ ...rawManifest, version: 5 }, f.run.task_id), /version|graph/i);
	assert.throws(() => parseWorkerConfig({ ...rawConfig, version: 5 }), /version|graph/i);
	assert.throws(() => parseManifest({ ...rawManifest, topology: "chain", version: 6 }, f.run.task_id), /graph|version/i);
	assert.throws(() => parseWorkerConfig({ ...rawConfig, topology: "chain", version: 6 }), /graph|version/i);
	assert.throws(() => parseManifest({ ...rawManifest, review_plan: undefined, version: 6 }, f.run.task_id), /review|version/i);
	assert.throws(() => parseWorkerConfig({ ...rawConfig, review_plan: undefined, version: 6 }), /review|version/i);
	assert.throws(() => parseCompletion({ ...rawResult, review_plan: undefined, version: 6 }, {
		run_id: f.run.task_id, instance_id: rawResult.identity.instance_id,
	}), /review|version/i);

	// Frozen 095d12b reader rejects ticket-14 graph-decision manifest, config, and result.
	assert.throws(() => parsePrevManifest(rawManifest, f.run.task_id));
	assert.throws(() => parsePrevWorkerConfig(rawConfig));
	assert.throws(() => parsePrevCompletion(rawResult, {
		run_id: f.run.task_id, instance_id: rawResult.identity.instance_id,
	}));
});

test("join keeps waiting during active read-only reviewer work in revision (finding 7)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, twoBranchPlan(process.cwd(), { dependencyWaitMs: 3000, cleanup: "manual" }), new Map(), { simulateShutdown: true });
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
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Reject A 1", "changes_requested"));
	await merge.deliverNotification(reviewB);

	await buildA.deliverNotification(reviewA);
	await buildA.complete(complete("Build A v2"));
	await reviewA.deliverNotification(buildA);

	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(2000);
		await reviewA.hooks.get("turn_start")?.({}, reviewA.context);
		const mrg = f.status().agents.find(a => a.node_id === "merge")!;
		assert.equal(mrg.execution, "waiting");
		assert.equal(mrg.edge_states?.["review-a"], "pending");
	}

	await reviewA.complete(complete("Review A v2 ok", "approve"));
	await merge.deliverNotification(reviewA);
	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "running");

	await merge.complete(complete("Merged"));
	await next.deliverNotification(merge);
	await next.complete(complete("Done"));
	const st = f.status();
	assert.equal(st.outcome.state, "succeeded");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assertOwnershipReleased(st);
});

test("later failed loop appears in already-blocked join causes and report (finding 8)", async t => {
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

	await reviewA.complete({ status: "failure", summary: "A review failed", detail: "A review failed" });
	t.mock.timers.tick(2000);
	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "blocked");

	await reviewB.complete({ status: "failure", summary: "B review failed", detail: "B review failed" });
	t.mock.timers.tick(2000);

	const st = f.status();
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mrg.execution, "blocked");
	assert.deepEqual(mrg.edge_states, { "review-a": "dead", "review-b": "dead" });
	assert.deepEqual(mrg.execution_causes.map(c => c.node_id).sort(), ["review-a", "review-b"]);
	assert.match(mrg.execution_reason ?? "", /review-a/);
	assert.match(mrg.execution_reason ?? "", /review-b/);
	assert.equal(st.outcome.state, "failed");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.worker_errors, []);
	assertOwnershipReleased(st);

	const rep = await f.report();
	const mergeReport = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeReport.status, "blocked");
	assert.deepEqual("causes" in mergeReport ? mergeReport.causes.map(c => c.node_id).sort() : [], ["review-a", "review-b"]);
	const markdown = buildMarkdownReport(rep.results);
	const mergeSection = markdown.slice(markdown.indexOf("### ⛔ merge"));
	const nextHeader = mergeSection.indexOf("\n### ", 1);
	const mergeBlock = nextHeader === -1 ? mergeSection : mergeSection.slice(0, nextHeader);
	assert.match(mergeBlock, /review-a/);
	assert.match(mergeBlock, /review-b/);
});

test("join claim settles failed delivery acknowledgement after reviewer exits (finding 9)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	let mergeRef: { beforeStart: (event: unknown) => Promise<void> } | undefined;
	const f = await runFixture(t, twoBranchPlan(process.cwd()), new Map([
		["review-a", {
			executeTool: async (_name, params) => {
				await mergeRef!.beforeStart({
					systemPrompt: "BASE",
					messageType: "custom",
					message: { customType: "coms-inbound", content: params.prompt, details: { sender_session: "session-a5-review-a" } },
				});
				throw new Error("ack lost after receiver accepted");
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
	mergeRef = merge;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A"));
	await buildB.complete(complete("Build B"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Review A ok", "approve"));
	if (f.status().agents.find(a => a.node_id === "merge")?.execution !== "running") {
		await merge.deliverNotification(reviewA);
	}
	assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "running");

	await merge.complete(complete("Merged"));
	await next.deliverNotification(merge);
	await next.complete(complete("Done"));
	reviewA.vanish();
	t.mock.timers.tick(5000);

	const st = await f.service.statusWithCleanup(f.run.task_id);
	assert.deepEqual(st.delivery_errors, []);
	assert.deepEqual(st.worker_errors, []);
	assert.equal(st.outcome.state, "succeeded");
	assert.equal(st.outcome.terminal, true);
	assert.equal(st.manifest.status, "cleaned");
	assertOwnershipReleased(st);
});

test("dry-run overlap warning only describes writers that could run in parallel (finding 10)", t => {
	const f = serviceFixture(t);
	const makePlan = (parents: string[], writePath: string) => ({
		topology: "graph" as const,
		task: "Overlap warning scope",
		project_cwd: f.cwd,
		agents: [
			graphNode("build", [], { write_paths: ["src"] }),
			graphReviewer("review", "build", ["build"]),
			graphNode("other", parents, { write_paths: [writePath] }),
		],
	});
	assert.doesNotMatch(formatPlan(f.service.plan(makePlan([], "test"), model)), /whole loop/);
	assert.match(formatPlan(f.service.plan(makePlan([], "src"), model)), /whole loop \(build → review\) serializes with other/);
	assert.doesNotMatch(formatPlan(f.service.plan(makePlan(["review"], "src"), model)), /whole loop/);
});
