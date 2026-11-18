import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	t.mock.timers.tick(5000);

	const st = f.status();
	const revA = st.agents.find(a => a.node_id === "review-a")!;
	const mrg = st.agents.find(a => a.node_id === "merge")!;
	const bldA = st.agents.find(a => a.node_id === "build-a")!;
	const ownRecord = JSON.parse(readFileSync(join(f.run.session_dir, `${bldA.instance_id}.ownership.json`), "utf8"));
	assert.equal(ownRecord.state, "released");
	assert.equal(revA.execution, "needs_attention");
	assert.equal(revA.finalized, true);
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assert.equal(st.worker_errors.length, 1);
	assert.match(st.worker_errors[0], /Feedback edge to build-a is dead: parked agent build-a exited before revision/);
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
			new RegExp(`decision for review: join node ${expectedJoin} is not supported inside loop body`),
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
			/decision for review: loop body member build cannot have successor side outside the loop body/,
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
		/ownership deadlock cycle.*build-a → review-a.*build-b → review-b/i,
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

// ---- Round 2 findings regression tests ----

for (const advanced of [false, true]) test(`dead parked middle writer settles loop even when revision advanced=${advanced} (finding 1b)`, async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const plan = twoBranchPlan(process.cwd(), { dependencyWaitMs: 3000, cleanup: "manual" });
	const revIdx = plan.agents.findIndex(a => a.node_id === "review-a");
	plan.agents[revIdx].depends_on = ["mid-a"];
	plan.agents.splice(revIdx, 0, { node_id: "mid-a", persona: "second", depends_on: ["build-a"], write_paths: ["src/mid"], sub_task: "Middle A" });
	plan.agents.find(a => a.node_id === "build-a")!.write_paths = ["src/a"];

	const f = await runFixture(t, plan, new Map(), { simulateShutdown: true });
	const scoutA = f.nodes.get("scout-a")!;
	const scoutB = f.nodes.get("scout-b")!;
	const buildA = f.nodes.get("build-a")!;
	const midA = f.nodes.get("mid-a")!;
	const buildB = f.nodes.get("build-b")!;
	const reviewA = f.nodes.get("review-a")!;
	const reviewB = f.nodes.get("review-b")!;
	const merge = f.nodes.get("merge")!;

	await scoutA.complete(complete("Scout A"));
	await scoutB.complete(complete("Scout B"));
	await buildA.deliverNotification(scoutA);
	await buildB.deliverNotification(scoutB);
	await buildA.complete(complete("Build A1"));
	await midA.deliverNotification(buildA);
	await midA.complete(complete("Mid A1"));
	await reviewA.deliverNotification(midA);
	await buildB.complete(complete("Build B1"));
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));
	await reviewA.complete(complete("Reject A1", "changes_requested"));
	await merge.deliverNotification(reviewB);

	if (advanced) await buildA.deliverNotification(reviewA);
	midA.vanish();
	t.mock.timers.tick(8000);

	const midStatus = f.status();
	assert.equal(midStatus.agents.find(a => a.node_id === "review-a")?.finalized, true);
	assert.equal(midStatus.agents.find(a => a.node_id === "mid-a")?.ownership_status, "released");
	assert.equal(midStatus.agents.find(a => a.node_id === "merge")?.execution, "blocked");

	if (advanced) {
		await buildA.complete(complete("Build A2"));
		t.mock.timers.tick(1000);
	}
	const finalStatus = f.status();
	assert.equal(finalStatus.outcome.state, "needs_attention");
	assert.equal(finalStatus.outcome.terminal, true);
	assert.equal(finalStatus.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.match(finalStatus.agents.find(a => a.node_id === "merge")?.execution_reason ?? "", /mid-a/);
	assertOwnershipReleased(finalStatus);
});

test("dead reviewer and dead parked target with held feedback acknowledgement settle terminally (finding 1c)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	let startSend!: () => void;
	let finishSend!: (value: { content: unknown[]; details: { msg_id: string } }) => void;
	const sending = new Promise<void>(resolve => { startSend = resolve; });
	const reply = new Promise<{ content: unknown[]; details: { msg_id: string } }>(resolve => { finishSend = resolve; });
	const plan = twoBranchPlan(process.cwd(), { dependencyWaitMs: 3000, cleanup: "manual" });
	plan.agents.find(a => a.node_id === "build-a")!.write_paths = ["src/a"];

	const f = await runFixture(t, plan, new Map([
		["review-a", { executeTool: async () => { startSend(); return reply; } }],
	]), { simulateShutdown: true });
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
	await buildA.complete(complete("Build A1"));
	await buildB.complete(complete("Build B1"));
	await reviewA.deliverNotification(buildA);
	await reviewB.deliverNotification(buildB);
	await reviewB.complete(complete("Review B ok", "approve"));

	const rejection = reviewA.complete(complete("Reject A1", "changes_requested"));
	await sending;
	buildA.vanish();
	reviewA.vanish();

	const first = f.status();
	assert.equal(first.agents.find(a => a.node_id === "review-a")?.finalized, true);
	t.mock.timers.tick(8000);
	const st = f.status();
	const terminalAtExit = st.outcome.terminal;
	finishSend({ content: [], details: { msg_id: "msg1" } });
	await rejection;

	assert.equal(terminalAtExit, true);
	assert.equal(st.outcome.state, "needs_attention");
	assert.deepEqual(st.pending, []);
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assertOwnershipReleased(st);
});

test("planning rejects outside writer that forms a parked-ownership cycle with a loop (finding 2)", t => {
	const f = serviceFixture(t);
	const deadlockPlan = {
		topology: "graph" as const,
		task: "Outside writer ownership deadlock",
		project_cwd: f.cwd,
		agents: [
			graphNode("build", [], { write_paths: ["x"] }),
			graphNode("outsider", [], { write_paths: ["x", "y"] }),
			graphReviewer("review", "build", ["build"], { write_paths: ["y"] }),
		],
	};
	assert.throws(
		() => f.service.plan(deadlockPlan, model),
		/ownership deadlock cycle involving (?:outsider ↔ build → review|build → review ↔ outsider) \(x, y\)/i,
	);

	// Safe overlapping writer (no reverse wait edge) keeps working with the whole-loop warning.
	const safePlan = {
		topology: "graph" as const,
		task: "Safe overlapping outside writer",
		project_cwd: f.cwd,
		agents: [
			graphNode("build", [], { write_paths: ["x"] }),
			graphReviewer("review", "build", ["build"]),
			graphNode("outsider", [], { write_paths: ["x"] }),
		],
	};
	assert.match(formatPlan(f.service.plan(safePlan, model)), /whole loop \(build → review\) serializes with outsider/);
});

test("reload after a join feedback target claims attempt 2 reports accepted before restart (finding 3)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Join feedback target reload",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("left"),
			graphNode("right"),
			graphNode("build", ["left", "right"]),
			graphReviewer("review", "build", ["build"]),
			graphNode("done", ["review"]),
		],
	}, new Map(), { simulateShutdown: true });
	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;

	await left.complete(complete("Left"));
	await right.complete(complete("Right"));
	await build.deliverNotification(right);
	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	await build.deliverNotification(review);
	assert.equal(f.status().agents.find(a => a.node_id === "build")?.execution, "running");

	await f.reload("build");
	const st = f.status();
	const bld = st.agents.find(a => a.node_id === "build")!;
	assert.equal(bld.execution, "needs_attention");
	assert.match(bld.execution_reason ?? "", /accepted.*restart/);
	assert.equal(st.outcome.state, "needs_attention");
});

for (const topology of ["graph", "chain"] as const) test(`result reader rejects swapped v5/v6 version in ${topology} review run (finding 5)`, async t => {
	const request = topology === "graph" ? twoBranchPlan(process.cwd(), { cleanup: "manual" }) : {
		topology: "chain" as const,
		task: "Chain review version check",
		project_cwd: process.cwd(),
		agents: [
			{ node_id: "build", persona: "first", sub_task: "Build" },
			{
				node_id: "review",
				persona: "second",
				sub_task: "Review",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build" },
			},
		],
	};
	const f = await runFixture(t, request, new Map(), { simulateShutdown: true });
	const source = f.nodes.get(topology === "graph" ? "scout-a" : "build")!;
	const dest = f.nodes.get(topology === "graph" ? "build-a" : "review")!;
	await source.complete(complete("Seed"));

	const resFile = join(f.run.session_dir, `${source.config.instance_id}.1.result.json`);
	const payload = JSON.parse(readFileSync(resFile, "utf8"));
	payload.version = payload.version === 5 ? 6 : 5;
	writeFileSync(resFile, JSON.stringify(payload));

	await dest.deliverNotification(source);
	const st = f.status();
	assert.notEqual(st.agents.find(a => a.node_id === source.config.node_id)?.execution, "succeeded");
	assert.equal(st.worker_errors.some(err => /version/i.test(err)), true);
});

test("chain-review read-only progress does not advance between heartbeats while graph-review does (finding 6)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const chainFix = await runFixture(t, {
		topology: "chain",
		task: "Chain review progress",
		project_cwd: process.cwd(),
		agents: [
			{ node_id: "build", persona: "first", sub_task: "Build" },
			{
				node_id: "review",
				persona: "second",
				sub_task: "Review",
				output_contract: verdictContract,
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build" },
			},
		],
	}, new Map(), { simulateShutdown: true });
	const chainBuild = chainFix.nodes.get("build")!;
	const chainProgressFile = join(chainFix.run.session_dir, `${chainBuild.config.instance_id}.progress.json`);
	const before = readFileSync(chainProgressFile, "utf8");
	t.mock.timers.tick(1000);
	await chainBuild.hooks.get("turn_start")?.({}, chainBuild.context);
	const after = readFileSync(chainProgressFile, "utf8");
	assert.equal(before, after);
});

// ---- Round 3 findings regression tests ----

test("planner cycle detection is independent of dependency declaration order (finding 1)", t => {
	const f = serviceFixture(t);
	const baseAgents = [
		graphNode("a", ["b", "review"], { write_paths: ["x"] }),
		graphNode("b", [], { write_paths: ["x"] }),
		graphNode("build", ["b"]),
		graphReviewer("review", "build", ["build"]),
	];
	for (const deps of [["b", "review"], ["review", "b"]]) {
		const plan = {
			topology: "graph" as const,
			task: "Order-independent cycle",
			project_cwd: f.cwd,
			agents: [{ ...baseAgents[0], depends_on: deps }, ...baseAgents.slice(1)],
		};
		assert.throws(() => f.service.plan(plan, model), /ownership deadlock cycle/);
	}

	// Permutation sweep over a safe shape (no cycle) must always accept regardless of depends_on order.
	const safeAgents = [
		graphNode("b", [], { write_paths: ["x"] }),
		graphNode("build", ["b"]),
		graphReviewer("review", "build", ["build"]),
		graphNode("a", ["b", "review"], { write_paths: ["x"] }),
	];
	for (const deps of [["b", "review"], ["review", "b"]]) {
		const safePlan = {
			topology: "graph" as const,
			task: "Order-independent safe",
			project_cwd: f.cwd,
			agents: [...safeAgents.slice(0, 3), { ...safeAgents[3], depends_on: deps }],
		};
		assert.equal(f.service.plan(safePlan, model).agents.length, 4);
	}
});

test("dead parked root writer releases its ownership record on disk on first status (finding 6)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Dead parked root writer",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build", [], { write_paths: ["x"] }),
			graphReviewer("review", "build", ["build"]),
			graphNode("peer"),
			graphNode("merge", ["review", "peer"]),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;
	const peer = f.nodes.get("peer")!;
	const merge = f.nodes.get("merge")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	await peer.complete(complete("Peer"));
	await merge.deliverNotification(peer);
	build.vanish();

	const st = f.status();
	const bld = st.agents.find(a => a.node_id === "build")!;
	const ownRecord = JSON.parse(readFileSync(join(f.run.session_dir, `${bld.instance_id}.ownership.json`), "utf8"));
	assert.equal(bld.ownership_status, "released");
	assert.equal(ownRecord.state, "released");
});

test("active revision keeps running builder ownership admitted and admits conflicting writer after builder finishes (finding 2)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Active revision with dead middle member",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("root"),
			graphNode("build", ["root"], { write_paths: ["x"] }),
			graphNode("middle", ["build"], { write_paths: ["y"] }),
			graphReviewer("review", "build", ["middle"]),
			graphNode("outside", [], { write_paths: ["x"] }),
		],
	}, new Map(), { simulateShutdown: true });
	const root = f.nodes.get("root")!;
	const build = f.nodes.get("build")!;
	const middle = f.nodes.get("middle")!;
	const review = f.nodes.get("review")!;
	const outside = f.nodes.get("outside")!;

	await root.complete(complete("Root"));
	await build.deliverNotification(root);
	await build.complete(complete("Build 1"));
	await middle.deliverNotification(build);
	await middle.complete(complete("Middle 1"));
	await review.deliverNotification(middle);
	await review.complete(complete("Reject 1", "changes_requested"));
	await build.deliverNotification(review);
	middle.vanish();

	const whileActive = f.status();
	const activeBuild = whileActive.agents.find(a => a.node_id === "build")!;
	const activeOwn = JSON.parse(readFileSync(join(f.run.session_dir, `${activeBuild.instance_id}.ownership.json`), "utf8"));
	assert.equal(activeBuild.execution, "running");
	assert.equal(activeBuild.ownership_status, "admitted");
	assert.equal(activeOwn.state, "admitted");
	assert.equal(whileActive.agents.find(a => a.node_id === "outside")?.ownership_status, "waiting");

	await build.complete(complete("Build 2"));
	t.mock.timers.tick(4000);
	await outside.deliverFollowUps();

	const afterBuild = f.status();
	const doneBuild = afterBuild.agents.find(a => a.node_id === "build")!;
	const doneOwn = JSON.parse(readFileSync(join(f.run.session_dir, `${doneBuild.instance_id}.ownership.json`), "utf8"));
	assert.equal(doneBuild.finalized, true);
	assert.equal(doneBuild.ownership_status, "released");
	assert.equal(doneOwn.state, "released");
	assert.equal(afterBuild.agents.find(a => a.node_id === "outside")?.ownership_status, "admitted");
});

test("first terminal status after dead feedback has empty pending list (finding 7)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "First terminal pending empty",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
			graphNode("done", ["review"]),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	build.vanish();

	const first = f.status();
	assert.equal(first.outcome.terminal, true);
	assert.deepEqual(first.pending, []);
});

test("finalized loop settles downstream join and descendant with their own saved timeouts (finding 3)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Descendant with own timeout",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
			graphNode("peer"),
			graphNode("merge", ["review", "peer"], { dependency_wait_timeout_ms: 3000 }),
			graphNode("next", ["merge"], { dependency_wait_timeout_ms: 3000 }),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;
	const peer = f.nodes.get("peer")!;
	const merge = f.nodes.get("merge")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	await peer.complete(complete("Peer"));
	await merge.deliverNotification(peer);
	build.vanish();
	t.mock.timers.tick(10_000);

	const st = f.status();
	assert.equal(st.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.equal(st.agents.find(a => a.node_id === "next")?.execution, "blocked");
	assert.equal(st.outcome.state, "needs_attention");
	assert.equal(st.outcome.terminal, true);
	assert.deepEqual(st.pending, []);
});

test("late reviewer failure preserves separate join integrity error and chain follower timeout (finding 4)", async t => {
	await t.test("graph join integrity error preserved", async s => {
		s.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const f = await runFixture(s, {
			topology: "graph",
			task: "Join integrity preserved",
			project_cwd: process.cwd(),
			cleanup: "manual",
			agents: [
				graphNode("build"),
				graphReviewer("review", "build", ["build"]),
				graphNode("peer"),
				graphNode("merge", ["review", "peer"], { dependency_wait_timeout_ms: 3000 }),
			],
		}, new Map(), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;
		const peer = f.nodes.get("peer")!;

		await build.complete(complete("Build 1"));
		await review.deliverNotification(build);
		await peer.complete(complete("Peer"));

		const peerFile = join(f.run.session_dir, `${peer.config.instance_id}.1.result.json`);
		const raw = readFileSync(peerFile, "utf8");
		writeFileSync(peerFile, JSON.stringify({ ...JSON.parse(raw), version: 5 }));
		s.mock.timers.tick(1000);
		assert.equal(f.status().agents.find(a => a.node_id === "merge")?.execution, "needs_attention");

		writeFileSync(peerFile, raw);
		await review.complete({ status: "failure", summary: "Review failed", detail: "Review failed" });

		const st = f.status();
		const mrg = st.agents.find(a => a.node_id === "merge")!;
		assert.equal(mrg.execution, "needs_attention");
		assert.match(mrg.execution_reason ?? "", /Unsupported result record version 5/);
	});

	await t.test("chain follower retains saved dependency timeout", async s => {
		s.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
		const f = await runFixture(s, {
			topology: "chain",
			task: "Chain follower timeout",
			project_cwd: process.cwd(),
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{
					node_id: "review",
					persona: "second",
					sub_task: "Review",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build" },
				},
				{ node_id: "next", persona: "first", sub_task: "Next", dependency_wait_timeout_ms: 3000 },
			],
		}, new Map(), { simulateShutdown: true });
		const build = f.nodes.get("build")!;
		const review = f.nodes.get("review")!;

		await build.complete(complete("Build"));
		await review.deliverNotification(build);
		s.mock.timers.tick(6000);
		assert.equal(f.status().agents.find(a => a.node_id === "next")?.execution, "needs_attention");

		await review.complete({ status: "failure", summary: "Review failed late", detail: "Review failed late" });
		const st = f.status();
		assert.equal(st.agents.find(a => a.node_id === "next")?.execution, "needs_attention");
		assert.equal(st.outcome.terminal, false);
	});
});

test("ownership admission rejects v5 result in v6 graph-review run (finding 5)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Ownership reader version",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("writer", [], { write_paths: ["x"] }),
			graphNode("other", [], { write_paths: ["x"] }),
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
		],
	}, new Map(), { simulateShutdown: true });
	const writer = f.nodes.get("writer")!;
	const other = f.nodes.get("other")!;
	assert.equal(f.status().agents.find(a => a.node_id === "other")?.ownership_status, "waiting");

	await writer.complete(complete("Writer"));
	const file = join(f.run.session_dir, `${writer.config.instance_id}.1.result.json`);
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: 5 }));
	t.mock.timers.tick(2000);
	await other.deliverFollowUps();

	const st = f.status();
	assert.notEqual(st.agents.find(a => a.node_id === "other")?.ownership_status, "admitted");
	assert.equal(st.worker_errors.some(err => /version/i.test(err)), true);
});

// ---- Round 4 findings regression tests ----

test("revision claimed during status read does not let another writer enter (finding 1)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Status clock-seam race",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("root"),
			graphNode("build", ["root"], { write_paths: ["x"] }),
			graphNode("middle", ["build"], { write_paths: ["y"] }),
			graphReviewer("review", "build", ["middle"]),
			graphNode("outside", [], { write_paths: ["x"] }),
		],
	}, new Map(), { simulateShutdown: true });
	const root = f.nodes.get("root")!;
	const build = f.nodes.get("build")!;
	const middle = f.nodes.get("middle")!;
	const review = f.nodes.get("review")!;
	const outside = f.nodes.get("outside")!;

	await root.complete(complete("Root"));
	await build.deliverNotification(root);
	await build.complete(complete("Build 1"));
	await middle.deliverNotification(build);
	await middle.complete(complete("Middle 1"));
	await review.deliverNotification(middle);
	await review.complete(complete("Reject 1", "changes_requested"));

	let admitted: Promise<unknown> | undefined;
	const clock = t.mock.method(f.service, "now", () => {
		admitted = build.deliverNotification(review);
		middle.vanish();
		return Date.now();
	});
	f.status();
	clock.mock.restore();
	await admitted;

	t.mock.timers.tick(4000);
	await outside.deliverFollowUps();
	await outside.beforeStart();

	const st = f.status();
	assert.equal(st.agents.find(a => a.node_id === "build")?.execution, "running");
	assert.notEqual(st.agents.find(a => a.node_id === "outside")?.execution, "running");
	assert.equal(st.agents.find(a => a.node_id === "outside")?.ownership_status, "waiting");
});

test("blocked timed-out join persists blocked disposition and releases independent conflicting writer (finding 2)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Timed-out join releases writer",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
			graphNode("peer"),
			graphNode("merge", ["review", "peer"], { dependency_wait_timeout_ms: 3000, write_paths: ["x"] }),
			graphNode("other", [], { write_paths: ["x"] }),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;
	const peer = f.nodes.get("peer")!;
	const merge = f.nodes.get("merge")!;
	const other = f.nodes.get("other")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	await peer.complete(complete("Peer"));
	await merge.deliverNotification(peer);
	build.vanish();
	t.mock.timers.tick(8000);

	const first = f.status();
	assert.equal(first.agents.find(a => a.node_id === "merge")?.execution, "blocked");

	t.mock.timers.tick(6000);
	await other.deliverFollowUps();
	await other.beforeStart();
	assert.equal(f.status().agents.find(a => a.node_id === "other")?.execution, "running");

	await other.complete(complete("Other done"));
	const final = f.status();
	assert.equal(final.outcome.state, "needs_attention");
	assert.equal(final.outcome.terminal, true);
});

test("active revision restart with unknown effects keeps ownership held_uncertain (finding 3)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Active revision restart keeps ownership",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("root"),
			graphNode("build", ["root"], { write_paths: ["x"] }),
			graphNode("middle", ["build"], { write_paths: ["y"] }),
			graphReviewer("review", "build", ["middle"]),
			graphNode("outside", [], { write_paths: ["x"] }),
		],
	}, new Map(), { simulateShutdown: true });
	const root = f.nodes.get("root")!;
	const build = f.nodes.get("build")!;
	const middle = f.nodes.get("middle")!;
	const review = f.nodes.get("review")!;

	await root.complete(complete("Root"));
	await build.deliverNotification(root);
	await build.complete(complete("Build 1"));
	await middle.deliverNotification(build);
	await middle.complete(complete("Middle 1"));
	await review.deliverNotification(middle);
	await review.complete(complete("Reject 1", "changes_requested"));
	await build.deliverNotification(review);
	middle.vanish();
	assert.equal(f.status().agents.find(a => a.node_id === "review")?.finalized, true);

	await f.reload("build");
	const st = f.status();
	const bld = st.agents.find(a => a.node_id === "build")!;
	const own = JSON.parse(readFileSync(join(f.run.session_dir, `${bld.instance_id}.ownership.json`), "utf8"));
	assert.equal(bld.execution, "needs_attention");
	assert.equal(bld.finalized, undefined);
	assert.equal(own.state, "admitted");
	assert.equal(st.agents.find(a => a.node_id === "outside")?.ownership_status, "held_uncertain");
});

test("corrupt member finalization does not make status throw (finding 4)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Corrupt member finalization",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
			graphNode("next", ["review"]),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Reject 1", "changes_requested"));
	build.vanish();
	assert.equal(f.status().agents.find(a => a.node_id === "review")?.finalized, true);

	writeFileSync(join(f.run.session_dir, `${build.config.instance_id}.finalize.json`), '{"version":99}');
	const st = f.status();
	assert.equal(st.worker_errors.some(err => /finalization record/i.test(err)), true);
});

test("transition recovery, cleanup finalization, and handoff reader reject swapped v5 result in v6 run (finding 5)", async t => {
	const { readFinalization, finishReviewFinalizations } = await import("./review-loop.ts");
	const { rmSync } = await import("node:fs");
	const f = await runFixture(t, {
		topology: "graph",
		task: "Outlying readers version check",
		project_cwd: process.cwd(),
		cleanup: "manual",
		agents: [
			graphNode("build"),
			graphReviewer("review", "build", ["build"]),
		],
	}, new Map(), { simulateShutdown: true });
	const build = f.nodes.get("build")!;
	const review = f.nodes.get("review")!;

	await build.complete(complete("Build 1"));
	await review.deliverNotification(build);
	await review.complete(complete("Approve 1", "approve"));

	const dir = f.run.session_dir;
	const run = f.run.task_id;
	const plan = f.run.review_plan!;
	const loop = plan.loops[0];

	// 1. Transition recovery rejects swapped v5 reviewer result.
	const revPath = join(dir, `${loop.reviewer}.1.result.json`);
	const revRaw = readFileSync(revPath, "utf8");
	writeFileSync(revPath, JSON.stringify({ ...JSON.parse(revRaw), version: 5 }));
	rmSync(join(dir, `${loop.reviewer}.finalize.json`));
	assert.throws(() => readFinalization(dir, run, loop, loop.reviewer), /version/i);

	// 2. Public cleanup records cleanup error and does not publish finalization from swapped v5 result.
	const cleaned = await f.service.cleanup(run);
	assert.equal(cleaned.cleanup_errors?.some(err => /version/i.test(err)), true);
	assert.equal(existsSync(join(dir, `${loop.reviewer}.finalize.json`)), false);
	assert.throws(() => finishReviewFinalizations(dir, run, plan), /version/i);

	// Restore reviewer result, then swap builder result version + summary for handoff edge check.
	writeFileSync(revPath, revRaw);
	const bldPath = join(dir, `${build.config.instance_id}.1.result.json`);
	const bldRaw = JSON.parse(readFileSync(bldPath, "utf8"));
	writeFileSync(bldPath, JSON.stringify({ ...bldRaw, version: 5, result: { ...bldRaw.result, summary: "edited" } }));
	const st = f.status();
	const revAgent = st.agents.find(a => a.node_id === "review")!;
	assert.doesNotMatch(revAgent.handoff?.problems.join(" ") ?? "", /accepted input digest/);
	assert.equal(st.worker_errors.some(err => /Unsupported result record version 5/i.test(err)), true);
});

for (const topology of ["chain", "team"] as const) test(`cancelling a dead root writer in ${topology} preserves admitted ownership bytes (finding 6)`, async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology,
		task: "Root cancel compat",
		project_cwd: process.cwd(),
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Build", write_paths: ["x"] },
			{ node_id: "next", persona: "second", sub_task: "Next" },
		],
	}, new Map(), { simulateShutdown: true });
	const root = f.nodes.get("root")!;
	const ownFile = join(f.run.session_dir, `${root.config.instance_id}.ownership.json`);
	const before = readFileSync(ownFile, "utf8");
	root.vanish();
	await f.service.cancel(f.run.task_id, { agents: ["root"], grace_ms: 0 });
	const after = readFileSync(ownFile, "utf8");
	assert.equal(after, before);
});
