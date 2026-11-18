import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { formatAgentStates, formatPlan, buildMarkdownReport } from "./reporting.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, parseCompletion, parseManifest, parseWorkerConfig, readJson, readyPath, resultPath, type WorkerReady } from "./session-store.ts";
import { claimJoinHandoff, evaluateJoinHandoff, handoffClaimPath, handoffOfferPath } from "./handoff.ts";
import {
	parseManifest as parsePreviousV3Manifest,
	parseWorkerConfig as parsePreviousV3WorkerConfig,
} from "./test-support/previous-v3-session-store.ts";
import { ownershipPath } from "./ownership.ts";
import { model, runFixture, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

test("join dry-run planning validates join_policy, renders diamond plan, and enforces fingerprint", async t => {
	const f = serviceFixture(t, ["first", "second"]);

	const preview = f.service.plan({
		topology: "graph",
		task: "Diamond join",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "left", persona: "second", sub_task: "Build left", depends_on: ["root"] },
			{ node_id: "right", persona: "second", sub_task: "Build right", depends_on: ["root"] },
			{ node_id: "merge", persona: "first", sub_task: "Merge", depends_on: ["left", "right"], join_policy: "allow_partial" },
		],
	}, model);
	assert.equal(preview.agents[3].join_policy, "allow_partial");
	const planText = formatPlan(preview);
	assert.match(planText, /join_policy: allow_partial/);
	assert.match(planText, /◌ merge/);

	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Invalid join_policy on non-join",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{ node_id: "b", persona: "second", sub_task: "B", depends_on: ["a"], join_policy: "allow_partial" },
		],
	}, model), /not a join/i);

	assert.throws(() => f.service.plan({
		topology: "chain",
		task: "join_policy on chain",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{ node_id: "b", persona: "second", sub_task: "B", join_policy: "all_success" },
		],
	}, model), /join_policy is only supported for topology "graph"/);

	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Bad join_policy value",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{ node_id: "b", persona: "first", sub_task: "B" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["a", "b"], join_policy: "quorum" as any },
		],
	}, model), /join_policy for merge must be all_success or allow_partial/);

	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "all_success with allow_partial",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{ node_id: "b", persona: "first", sub_task: "B" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["a", "b"], join_policy: "all_success", dependency_policy: "allow_partial" },
		],
	}, model), /cannot combine join_policy "all_success" with dependency_policy "allow_partial"/);

	const base = {
		topology: "graph" as const,
		task: "Fingerprint join_policy",
		project_cwd: f.cwd,
		request_id: "join-fp-1",
		agents: [
			{ node_id: "a", persona: "first", sub_task: "A" },
			{ node_id: "b", persona: "first", sub_task: "B" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["a", "b"], join_policy: "all_success" as const },
		],
	};
	await f.service.generate(base, model);
	await assert.rejects(() => f.service.generate({
		...base,
		agents: [
			base.agents[0],
			base.agents[1],
			{ ...base.agents[2], join_policy: "allow_partial" },
		],
	}, model), /request_id was already used for a different bootstrap plan/);
});

test("join starts once when parents finish simultaneously, receives all parent results, and writes one exclusive join claim", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Simultaneous parents join",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left work" },
			{ node_id: "right", persona: "first", sub_task: "Right work" },
			{ node_id: "merge", persona: "second", sub_task: "Merge both", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;

	await Promise.all([
		left.complete({ status: "success", summary: "Left ok", detail: "left detail" }),
		right.complete({ status: "success", summary: "Right ok", detail: "right detail" }),
	]);

	const rival = workerFromConfig(t, join(run.run.session_dir, `${merge.config.instance_id}.config.json`));
	await rival.start();
	const rightMessage = right.sent.find(call => call.name === "coms_send" && call.params.target === `session-${merge.config.instance_id}`)!;
	const claimPath = handoffClaimPath(run.run.session_dir, merge.config.instance_id);
	const linkSync = fs.linkSync;
	let publications = 0;
	let rivalTurn: ReturnType<typeof rival.beforeStart>;
	// Run the second worker after the first checked for a claim, just before its atomic publication.
	const link = t.mock.method(fs, "linkSync", (from, to) => {
		if (to === claimPath && ++publications === 1) {
			rivalTurn = rival.beforeStart({
				systemPrompt: "BASE", messageType: "custom",
				message: { customType: "coms-inbound", details: { sender_session: `session-${right.config.instance_id}` }, content: rightMessage.params.prompt },
			});
		}
		return linkSync(from, to);
	});
	syncBuiltinESMExports();
	let turnA: Awaited<ReturnType<typeof merge.deliverNotification>>;
	let turnB: Awaited<ReturnType<typeof rival.beforeStart>>;
	try {
		turnA = await merge.deliverNotification(left);
		turnB = await rivalTurn;
	} finally {
		link.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal(publications, 2, "both workers raced to publish the same claim");
	const prompts = [turnA?.systemPrompt, turnB?.systemPrompt].filter((p): p is string => typeof p === "string");
	assert.equal(prompts.length, 1, "exactly one notification starts the join");
	assert.match(prompts[0], /Predecessor result \(left\):.*Left ok/);
	assert.match(prompts[0], /Predecessor result \(right\):.*Right ok/);
	assert.match(prompts[0], /Accepted join handoffs:/);

	const midStatus = run.status();
	const mergeMid = midStatus.agents.find(a => a.node_id === "merge")!;
	assert.deepEqual(mergeMid.edge_states, { left: "fired", right: "fired" });
	assert.equal(mergeMid.handoffs_in?.[left.config.instance_id]?.state, "accepted");
	assert.equal(mergeMid.handoffs_in?.[right.config.instance_id]?.state, "accepted");

	await (turnA?.systemPrompt ? merge : rival).complete({ status: "success", summary: "Merged", detail: "all good" });
	const finalStatus = run.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	const report = await run.report();
	assert.equal(report.results.length, 3);
});

test("join waits while an edge is pending or its source needs_attention, and status shows pending and dead inbound edges", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Wait on pending and needs_attention",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;

	await left.complete({ status: "success", summary: "Left ok", detail: "" });
	const waitTurn = await merge.deliverNotification(left);
	assert.equal(waitTurn, undefined, "join does not start while right is still pending");

	const whilePending = run.status();
	const mergePending = whilePending.agents.find(a => a.node_id === "merge")!;
	assert.notEqual(mergePending.handoffs_in?.[left.config.instance_id]?.state, "accepted");
	assert.deepEqual(mergePending.edge_states, { left: "fired", right: "pending" });
	assert.match(formatAgentStates(whilePending.agents), /\[edges: left=fired, right=pending\] \[join: all_success; pending: right\]/);

	// Crash right without recording a result -> needs_attention.
	await right.shutdown("exit");
	const whileAttention = run.status();
	assert.equal(whileAttention.agents.find(a => a.node_id === "right")?.execution, "needs_attention");
	const mergeAttention = whileAttention.agents.find(a => a.node_id === "merge")!;
	assert.deepEqual(mergeAttention.edge_states, { left: "fired", right: "pending" });
	assert.equal(mergeAttention.execution, "waiting");
});

test("join_policy all_success vs allow_partial and per-edge dependency_policy", async t => {
	// 1. Default all_success blocks on partial parent.
	const runDefault = await runFixture(t, {
		topology: "graph",
		task: "Default all_success",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const l1 = runDefault.nodes.get("left")!;
	const r1 = runDefault.nodes.get("right")!;
	const m1 = runDefault.nodes.get("merge")!;
	await l1.complete({ status: "partial", summary: "Left partial", detail: "gaps" });
	await r1.complete({ status: "success", summary: "Right ok", detail: "" });
	assert.equal(await m1.deliverNotification(r1), undefined);
	const st1 = runDefault.status();
	assert.equal(st1.agents.find(a => a.node_id === "merge")?.execution, "blocked");
	assert.deepEqual(st1.agents.find(a => a.node_id === "merge")?.edge_states, { left: "dead", right: "fired" });
	assert.match(formatAgentStates(st1.agents), /\[join: all_success; dead: left\]/);

	// 2. join_policy: allow_partial admits a partial parent.
	const runPartial = await runFixture(t, {
		topology: "graph",
		task: "Allow partial join",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"], join_policy: "allow_partial" },
		],
	});
	const l2 = runPartial.nodes.get("left")!;
	const r2 = runPartial.nodes.get("right")!;
	const m2 = runPartial.nodes.get("merge")!;
	await l2.complete({ status: "partial", summary: "Left partial", detail: "gaps" });
	await r2.complete({ status: "success", summary: "Right ok", detail: "" });
	const turn2 = await m2.deliverNotification(r2);
	assert.ok(turn2?.systemPrompt);
	await m2.complete({ status: "success", summary: "Merged partial", detail: "" });
	assert.equal(runPartial.status().outcome.state, "partial");

	// 3. Per-edge dependency_policy: require_success still blocks partial under join_policy: allow_partial.
	const runStrictEdge = await runFixture(t, {
		topology: "graph",
		task: "Per-edge policy still applies",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"], join_policy: "allow_partial", dependency_policy: "require_success" },
		],
	});
	const l3 = runStrictEdge.nodes.get("left")!;
	const r3 = runStrictEdge.nodes.get("right")!;
	const m3 = runStrictEdge.nodes.get("merge")!;
	await l3.complete({ status: "partial", summary: "Left partial", detail: "gaps" });
	await r3.complete({ status: "success", summary: "Right ok", detail: "" });
	assert.equal(await m3.deliverNotification(r3), undefined);
	assert.equal(runStrictEdge.status().agents.find(a => a.node_id === "merge")?.execution, "blocked");
});

test("dead inbound edges block the join with causes from every dead edge in status and report", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Both parents fail",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;

	await left.complete({ status: "failure", summary: "Left broke", detail: "err L" });
	await right.complete({ status: "failure", summary: "Right broke", detail: "err R" });
	await merge.deliverNotification(left);
	await merge.deliverNotification(right);

	const st = run.status();
	const mergeState = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mergeState.execution, "blocked");
	assert.deepEqual(mergeState.edge_states, { left: "dead", right: "dead" });
	assert.deepEqual(mergeState.execution_causes.map(c => c.node_id), ["left", "right"]);
	assert.match(formatAgentStates(st.agents), /\[edges: left=dead, right=dead\] \[join: all_success; dead: left, right\]/);

	const report = await run.report();
	const mergeReport = report.results.find(r => r.node_id === "merge");
	assert.equal(mergeReport?.execution_state, "blocked");
	assert.deepEqual(mergeReport && "causes" in mergeReport ? mergeReport.causes?.map(c => c.node_id) : [], ["left", "right"]);
	const md = buildMarkdownReport(report.results);
	assert.match(md, /left \(failed\): Left broke/);
	assert.match(md, /right \(failed\): Right broke/);
});

test("join dependency wait runs from the latest useful progress across all upstream nodes", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const run = await runFixture(t, {
		topology: "graph",
		task: "Upstream progress keeps join alive",
		dependency_wait_timeout_ms: 10_000,
		agents: [
			{ node_id: "root-a", persona: "first", sub_task: "Root A" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root-a"] },
			{ node_id: "branch-b", persona: "first", sub_task: "Branch B" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["branch-a", "branch-b"] },
		],
	});
	const rootA = run.nodes.get("root-a")!;
	const branchB = run.nodes.get("branch-b")!;
	const merge = run.nodes.get("merge")!;

	// Keep root-a actively progressing well past dependency_wait_timeout_ms (10s) while branch-b is silent: merge must still wait.
	for (let i = 0; i < 4; i++) {
		atomicJson(join(run.run.session_dir, `${rootA.config.instance_id}.progress.json`), {
			token: run.run.token,
			updated_at: Date.now(),
			state: "working",
			activity_at: Date.now(),
			started_at: 1_000_000,
		});
		t.mock.timers.tick(4000);
	}
	assert.equal(run.status().agents.find(a => a.node_id === "merge")?.execution, "waiting");
	assert.equal(merge.config.dependency_wait_timeout_ms, 10_000);

	// Stop advancing root-a activity_at; after dependency_wait_timeout_ms, merge times out to needs_attention.
	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(4000);
	}
	const timedOut = run.status().agents.find(a => a.node_id === "merge")!;
	assert.equal(timedOut.execution, "needs_attention");
	assert.match(timedOut.execution_reason ?? "", /No upstream progress or handoff/);
});

test("cancelling one parent of a join propagates blocked disposition to the join", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Cancel one join parent",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	await right.complete({ status: "success", summary: "Right ok", detail: "" });

	const cancelRes = await run.service.cancel(run.run.task_id, { agents: ["left"], reason: "stop left" });
	assert.deepEqual(cancelRes.blocked_dependents.map(d => d.node_id), ["merge"]);
	await left.hooks.get("agent_settled")?.({ aborted: true }, left.context);
	await run.nodes.get("merge")!.deliverNotification(right);
	const st = run.status();
	const mergeState = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mergeState.execution, "blocked");
	assert.deepEqual(mergeState.execution_causes.map(c => c.node_id), ["left"]);
});

test("join claim race via publishExclusive admits exactly one winner", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Exclusive join claim race",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;
	await left.complete({ status: "success", summary: "L", detail: "" });
	await right.complete({ status: "success", summary: "R", detail: "" });

	const loadPred = (srcId: string) => parseCompletion(readJson<unknown>(resultPath(run.run.session_dir, srcId)), { run_id: run.run.task_id, instance_id: srcId });
	const sessionOf = (srcId: string) => readJson<WorkerReady>(readyPath(run.run.session_dir, srcId)).session_id;
	const offerLeft = readJson<{ handoff_id: string; input_digest: string }>(handoffOfferPath(run.run.session_dir, merge.config.instance_id, left.config.instance_id));
	const offerRight = readJson<{ handoff_id: string; input_digest: string }>(handoffOfferPath(run.run.session_dir, merge.config.instance_id, right.config.instance_id));
	const d1 = evaluateJoinHandoff({
		config: merge.config,
		inboundInstances: merge.config.inbound_edges!,
		sourceInstanceId: left.config.instance_id,
		expectedSession: sessionOf(left.config.instance_id),
		senderSession: sessionOf(left.config.instance_id),
		content: `bootstrap-handoff:${merge.config.token}:${left.config.instance_id}\nhandoff-id: ${offerLeft.handoff_id}\ninput-digest: ${offerLeft.input_digest}\n`,
		loadPredecessor: loadPred,
		sessionOf,
	});
	const d2 = evaluateJoinHandoff({
		config: merge.config,
		inboundInstances: merge.config.inbound_edges!,
		sourceInstanceId: right.config.instance_id,
		expectedSession: sessionOf(right.config.instance_id),
		senderSession: sessionOf(right.config.instance_id),
		content: `bootstrap-handoff:${merge.config.token}:${right.config.instance_id}\nhandoff-id: ${offerRight.handoff_id}\ninput-digest: ${offerRight.input_digest}\n`,
		loadPredecessor: loadPred,
		sessionOf,
	});
	assert.equal(d1.outcome, "proceed");
	assert.equal(d2.outcome, "proceed");
	const [c1, c2] = await Promise.all([
		Promise.resolve().then(() => claimJoinHandoff(merge.config, d1.edges)),
		Promise.resolve().then(() => claimJoinHandoff(merge.config, d2.edges)),
	]);
	assert.deepEqual([c1.outcome, c2.outcome].sort(), ["accepted", "duplicate"]);
});

test("late or duplicate notification after join started ignores stale parent evidence and does not abort running join", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Duplicate join notification with stale evidence",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left", required_checks: ["lint"] },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;

	// Create a file and record passing verification evidence for left before completing.
	writeFileSync(join(run.cwd, "work.txt"), "v1\n");
	await left.verify({ action: "run", check_id: "lint", command: "true", scope: ["work.txt"] });
	await left.complete({ status: "success", summary: "Left ok", detail: "" });
	await right.complete({ status: "success", summary: "Right ok", detail: "" });

	const firstTurn = await merge.deliverNotification(right);
	assert.ok(firstTurn?.systemPrompt);
	assert.equal(run.status().agents.find(a => a.node_id === "merge")?.execution, "running");

	// Mutate the file so left's required_checks evidence is now stale, then deliver a duplicate notification.
	writeFileSync(join(run.cwd, "work.txt"), "v2 edited by merge\n");
	const dupTurn = await merge.deliverNotification(left);
	assert.equal(dupTurn, undefined);
	assert.equal(run.status().agents.find(a => a.node_id === "merge")?.execution, "running", "running join must not be aborted or blocked");

	await merge.complete({ status: "success", summary: "Merged", detail: "" });
	assert.equal(run.status().outcome.state, "succeeded");
});

test("left fails while right is still running blocks join immediately, and wait poll stops on dispatcher disposition", async t => {
	// 1. Left fails and notifies merge while right is still running -> merge blocks immediately.
	const run1 = await runFixture(t, {
		topology: "graph",
		task: "Left fails while right running",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left1 = run1.nodes.get("left")!;
	const merge1 = run1.nodes.get("merge")!;
	await left1.complete({ status: "failure", summary: "Left failed", detail: "boom" });
	await merge1.deliverNotification(left1);
	const st1 = run1.status().agents.find(a => a.node_id === "merge")!;
	assert.equal(st1.execution, "blocked");
	assert.deepEqual(st1.execution_causes.map(c => c.node_id), ["left"]);

	// 2. Dispatcher writes blocked disposition (e.g. via cancel); join's wait poll notices and stops without overwriting.
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const run2 = await runFixture(t, {
		topology: "graph",
		task: "Wait poll stops on dispatcher disposition",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left2 = run2.nodes.get("left")!;
	const merge2 = run2.nodes.get("merge")!;
	await run2.service.cancel(run2.run.task_id, { agents: ["left"], reason: "stop left" });
	await left2.hooks.get("agent_settled")?.({ aborted: true }, left2.context);
	await run2.service.cancel(run2.run.task_id, { agents: ["left"], reason: "stop left" });
	const path = dispositionPath(run2.run.session_dir, merge2.config.instance_id);
	const dispBefore = readFileSync(path, "utf8");
	const progressPath = join(run2.run.session_dir, `${merge2.config.instance_id}.progress.json`);
	const progressBefore = readFileSync(progressPath, "utf8");
	const clear = t.mock.method(globalThis, "clearInterval");
	assert.equal(merge2.shutdowns, 0);
	t.mock.timers.tick(1000);
	assert.equal(merge2.shutdowns, 1, "the poll asks the worker to shut down");
	assert.equal(clear.mock.callCount(), 3, "the dependency, heartbeat and cancellation intervals are cleared");
	t.mock.timers.tick(6000);
	assert.equal(merge2.shutdowns, 1);
	assert.equal(readFileSync(progressPath, "utf8"), progressBefore, "the worker stopped publishing heartbeats");
	assert.equal(readFileSync(path, "utf8"), dispBefore, "worker must not overwrite dispatcher disposition");
});

test("a recorded needs_attention disposition retains ownership when a notification requests blocked", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Keep ownership for the recorded disposition",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"], write_paths: ["out"] },
		],
	});
	const left = run.nodes.get("left")!;
	const merge = run.nodes.get("merge")!;
	const path = dispositionPath(run.run.session_dir, merge.config.instance_id);
	await left.complete({ status: "failure", summary: "Left failed", detail: "boom" });
	atomicJson(path, dispositionRecord(merge.config, "needs_attention", "Existing attention condition", [], new Date().toISOString()));
	const before = readFileSync(path, "utf8");

	assert.equal(await merge.deliverNotification(left), undefined);
	assert.equal(merge.shutdowns, 1);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.equal(readJson<{ state: string }>(ownershipPath(run.run.session_dir, merge.config.instance_id)).state, "admitted");
});

test("a join records a notification from outside its inbound edges and still admits valid handoffs", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Reject an unrelated handoff",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "outside", persona: "first", sub_task: "Independent" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const outside = run.nodes.get("outside")!;
	const merge = run.nodes.get("merge")!;
	const turn = await merge.beforeStart({
		systemPrompt: "BASE", messageType: "custom",
		message: {
			customType: "coms-inbound", details: { sender_session: `session-${outside.config.instance_id}` },
			content: `bootstrap-handoff:${merge.config.token}:${outside.config.instance_id}`,
		},
	});
	assert.equal(turn, undefined);
	const state = run.status().agents.find(agent => agent.node_id === "merge")!;
	assert.equal(state.execution, "waiting");
	const rejection = state.handoffs_in?.[left.config.instance_id]?.rejections.at(-1);
	assert.equal(rejection?.severity, "notification");
	assert.match(rejection?.reason ?? "", /outside.*not an inbound edge/);
	assert.equal(merge.shutdowns, 0);

	await left.complete({ status: "success", summary: "Left ok", detail: "" });
	await right.complete({ status: "success", summary: "Right ok", detail: "" });
	assert.ok((await merge.deliverNotification(right))?.systemPrompt);
});

test("recovery inspect reports awaiting other inbound edges, and retry_delivery requires source and repairs second parent", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Recover second parent of join",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	}, new Map([
		["right", { executeTool: async () => ({ isError: true, content: [{ type: "text" as const, text: "coms failed" }] }) }],
	]));
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;

	// Left finishes first while right is still running: inspect must say awaiting other inbound edges, not deliverable.
	await left.complete({ status: "success", summary: "Left ok", detail: "" });
	const waitingInspect = await run.service.recover(run.run.task_id, { action: "inspect", agent: "merge" });
	const leftWhileWaiting = waitingInspect.assessments.find(a => a.source.node_id === "left")!;
	assert.equal(leftWhileWaiting.verdict, "wait");
	assert.match(leftWhileWaiting.reason, /awaiting other inbound edges/);

	// Neither type of outcome from an earlier sibling attempt is evidence for this attempt.
	const staleConfig = { ...right.config, attempt_id: `${right.config.instance_id}.0` };
	const staleResult = resultPath(run.run.session_dir, right.config.instance_id);
	const staleDisposition = dispositionPath(run.run.session_dir, right.config.instance_id);
	const now = new Date().toISOString();
	for (const [path, record] of [
		[staleResult, completionRecord(staleConfig, { status: "failure", summary: "Earlier failure", detail: "" }, "not_required", now)],
		[staleDisposition, dispositionRecord(staleConfig, "blocked", "Earlier block", [], now)],
	] as const) {
		atomicJson(path, record);
		const inspect = await run.service.recover(run.run.task_id, { action: "inspect", agent: "merge" });
		const edge = inspect.assessments.find(a => a.source.node_id === "left")!;
		assert.equal(edge.verdict, "needs_attention");
		assert.match(edge.reason, /right.*attempt_id/);
		rmSync(path);
	}

	// Now right completes, but its handoff offer/delivery failed.
	await right.complete({ status: "success", summary: "Right ok", detail: "" });
	rmSync(handoffOfferPath(run.run.session_dir, merge.config.instance_id, right.config.instance_id), { force: true });
	await right.closeTab();

	// retry_delivery without source fails with a clear error naming the choices.
	await assert.rejects(
		() => run.service.recover(run.run.task_id, { action: "retry_delivery", agent: "merge" }, { wake: async () => {} }),
		/multiple inbound edges \(left, right\).*source/i,
	);

	const delivered: Array<{ target: string; prompt: string }> = [];
	const repaired = await run.service.recover(run.run.task_id, { action: "retry_delivery", agent: "merge", source: "right" }, {
		senderSession: "dispatcher",
		wake: async (target, prompt) => { delivered.push({ target, prompt }); },
	});
	assert.equal(repaired.refused, undefined);
	assert.equal(repaired.delivery?.transport, "acknowledged");
	assert.equal(delivered.length, 1);

	const turn = await merge.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "dispatcher" }, content: delivered[0].prompt },
	});
	assert.ok(turn?.systemPrompt);
	await merge.complete({ status: "success", summary: "Merged", detail: "" });
	assert.equal(run.status().outcome.state, "succeeded");
});

test("join manifest and config use version 4 and are rejected by frozen ticket 12 (v3) reader", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Compatibility v4 join",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	assert.equal(run.run.version, 4);
	const rawManifest = readJson<typeof run.run>(join(run.run.session_dir, "manifest.json"));
	assert.throws(() => parsePreviousV3Manifest(rawManifest, run.run.task_id), /Unsupported bootstrap manifest version 4/);
	const merge = run.nodes.get("merge")!;
	const rawConfig = readJson<typeof merge.config>(join(run.run.session_dir, `${merge.config.instance_id}.config.json`));
	assert.throws(() => parsePreviousV3WorkerConfig(rawConfig), /Unsupported bootstrap worker configuration version 4/);

	const root = run.nodes.get("left")!;
	assert.equal(parseWorkerConfig(root.config).version, 4, "the roster identifies the join for a v4 root");
	const fanOutPanes = rawManifest.pane_manifest.map(({ join_policy: _policy, ...entry }) => ({
		...entry, inbound_edges: entry.inbound_edges?.slice(0, 1),
	}));
	const mergeIndex = fanOutPanes.findIndex(entry => entry.node_id === "merge");
	const policyOnlyPanes = fanOutPanes.map((entry, i) => i === mergeIndex ? { ...entry, join_policy: "all_success" } : entry);
	const { join_policy: _policy, roster, ...config } = rawConfig;
	const fanOutConfig = { ...config, inbound_edges: config.inbound_edges?.slice(0, 1) };
	const v3Error = /graph.*version 3.*join/i;
	const v4Error = /graph.*version 4.*join/i;

	assert.throws(() => parseManifest({ ...rawManifest, version: 3 }, run.run.task_id), v3Error);
	assert.throws(() => parseManifest({ ...rawManifest, version: 3, pane_manifest: policyOnlyPanes }, run.run.task_id), v3Error);
	assert.throws(() => parseManifest({ ...rawManifest, pane_manifest: fanOutPanes }, run.run.task_id), v4Error);
	assert.throws(() => parseWorkerConfig({ ...config, version: 3 }), v3Error);
	assert.throws(() => parseWorkerConfig({ ...fanOutConfig, version: 3, join_policy: "all_success" }), v3Error);
	assert.throws(() => parseWorkerConfig({ ...root.config, version: 3 }), v3Error);
	assert.throws(() => parseWorkerConfig({
		...fanOutConfig, roster: roster!.map(member => ({ ...member, inbound_edges: member.inbound_edges?.slice(0, 1) })),
	}), v4Error);
});

test("restarting a join worker after claim ends as needs_attention without replaying", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Restart after join claim",
		agents: [
			{ node_id: "left", persona: "first", sub_task: "Left" },
			{ node_id: "right", persona: "first", sub_task: "Right" },
			{ node_id: "merge", persona: "second", sub_task: "Merge", depends_on: ["left", "right"] },
		],
	});
	const left = run.nodes.get("left")!;
	const right = run.nodes.get("right")!;
	const merge = run.nodes.get("merge")!;
	await left.complete({ status: "success", summary: "Left ok", detail: "" });
	await right.complete({ status: "success", summary: "Right ok", detail: "" });
	const turn = await merge.deliverNotification(right);
	assert.ok(turn?.systemPrompt);

	// Simulate worker restart before completing: must record needs_attention and not replay.
	const restarted = workerFromConfig(t, join(run.run.session_dir, `${merge.config.instance_id}.config.json`));
	await restarted.start();
	const st = run.status().agents.find(a => a.node_id === "merge")!;
	assert.equal(st.execution, "needs_attention");
	assert.match(st.execution_reason ?? "", /not replayed automatically/);
});
