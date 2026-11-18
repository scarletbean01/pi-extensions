import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskInput } from "./contracts.ts";
import { formatAgentStates, formatPlan } from "./reporting.ts";
import { atomicJson, parseManifest, parseWorkerConfig, readJson, resultPath } from "./session-store.ts";
import { SessionStore as PreviousSessionStore } from "./test-support/previous-session-store.ts";
import {
	SessionStore as PreviousV2SessionStore,
	parseManifest as parsePreviousV2Manifest,
	parseWorkerConfig as parsePreviousV2WorkerConfig,
} from "./test-support/previous-v2-session-store.ts";
import { model, runFixture, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

test("graph dry-run planning validates topology, depends_on, cycles, >32 nodes, and join_policy", async t => {
	const f = serviceFixture(t, ["first", "second"]);

	const preview = f.service.plan({
		topology: "graph",
		task: "Fan out from root",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Investigate" },
			{ node_id: "branch-a", persona: "second", sub_task: "Build A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Build B", depends_on: ["root"] },
		],
	}, model);
	assert.equal(preview.topology, "graph");
	assert.deepEqual(preview.agents.map(a => [a.node_id, a.inbound_edges, a.outbound_edges]), [
		["root", [], ["branch-a", "branch-b"]],
		["branch-a", ["root"], []],
		["branch-b", ["root"], []],
	]);
	const planText = formatPlan(preview);
	assert.match(planText, /^graph in /);
	assert.match(planText, /plan · graph · 3 nodes\n◌ root ──┬──▶ ◌ branch-a\n         └──▶ ◌ branch-b/);

	// Legacy name form is rejected for graph topology.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Legacy form",
		project_cwd: f.cwd,
		agents: [{ name: "first", sub_task: "x" }],
	}, model), /legacy name form/i);

	// Unknown dependency ID.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Unknown dep",
		project_cwd: f.cwd,
		agents: [{ node_id: "a", persona: "first", sub_task: "x", depends_on: ["missing"] }],
	}, model), /Unknown dependency "missing"/);

	// Duplicate node ID.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Duplicate",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "dup", persona: "first", sub_task: "x" },
			{ node_id: "DUP", persona: "second", sub_task: "y" },
		],
	}, model), /Duplicate node ID/);

	// Self-dependency.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Self dep",
		project_cwd: f.cwd,
		agents: [{ node_id: "a", persona: "first", sub_task: "x", depends_on: ["a"] }],
	}, model), /cannot depend on itself/);

	// Cycle detection.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Cycle",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "x", depends_on: ["b"] },
			{ node_id: "b", persona: "second", sub_task: "y", depends_on: ["a"] },
		],
	}, model), /cycle/i);

	// More than 32 nodes.
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Too many",
		project_cwd: f.cwd,
		agents: Array.from({ length: 33 }, (_, i) => ({ node_id: `n${i + 1}`, persona: "first", sub_task: `task ${i + 1}` })),
	}, model), /between 1 and 32 agents/);

	// Joins are planned with join_policy defaulting to all_success.
	const joinPreview = f.service.plan({
		topology: "graph",
		task: "Join",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "a", persona: "first", sub_task: "x" },
			{ node_id: "b", persona: "first", sub_task: "y" },
			{ node_id: "join", persona: "second", sub_task: "merge", depends_on: ["a", "b"] },
		],
	}, model);
	assert.equal(joinPreview.agents[2].join_policy, "all_success");
	assert.match(formatPlan(joinPreview), /join_policy: all_success/);
});

test("graph runs use new manifest and config versions rejected by previous release and enforce request_id fingerprint", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	const base = {
		topology: "graph" as const,
		task: "Versioned graph",
		project_cwd: f.cwd,
		request_id: "graph-fp-1",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Root" },
			{ node_id: "leaf", persona: "second", sub_task: "Leaf", depends_on: ["root"] },
		],
	};
	const run = await f.service.generate(base, model);
	assert.equal(run.version, 3);

	const rawManifest = JSON.parse(readFileSync(join(run.session_dir, "manifest.json"), "utf8"));
	const prevStore = new PreviousSessionStore(f.stateDir);
	assert.throws(() => prevStore.load(run.task_id), /Unsupported|Invalid/);
	const prevV2Store = new PreviousV2SessionStore(f.stateDir);
	assert.throws(() => prevV2Store.load(run.task_id), /Unsupported bootstrap manifest version 3/);
	assert.throws(() => parsePreviousV2Manifest(rawManifest, run.task_id), /Unsupported bootstrap manifest version 3/);
	assert.throws(() => parseManifest({ ...rawManifest, version: 2 }, run.task_id), /Unsupported topology/);
	assert.throws(() => parseManifest({ ...rawManifest, version: 99 }, run.task_id), /Unsupported bootstrap manifest version 99/);
	const rawConfig = readJson<Record<string, unknown>>(join(run.session_dir, `${run.pane_manifest[0].instance_id}.config.json`));
	assert.equal(rawConfig.version, 3);
	assert.throws(() => parsePreviousV2WorkerConfig(rawConfig), /Unsupported bootstrap worker configuration version 3/);
	assert.throws(() => parseWorkerConfig({ ...rawConfig, version: 2 }), /Unsupported worker topology/);
	assert.throws(() => parseWorkerConfig({ ...rawConfig, version: 99 }), /Unsupported bootstrap worker configuration version 99/);

	// Same request_id with same plan returns the existing run.
	const same = await f.service.generate(base, model);
	assert.equal(same.task_id, run.task_id);

	// Same request_id with changed depends_on is rejected as a different plan.
	await assert.rejects(() => f.service.generate({
		...base,
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Root" },
			{ node_id: "leaf", persona: "second", sub_task: "Leaf" },
		],
	}, model), /request_id was already used for a different bootstrap plan/);
});

test("graph fan-out delivers one source-scoped handoff per outbound edge and shows per-edge state in status", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Fan out to two branches",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	});
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;

	// Before root completes, inbound edges to branches are pending and outbound handoffs are keyed by destination as not offered.
	const initialStatus = run.status();
	assert.equal(initialStatus.agents.find(a => a.node_id === "branch-a")?.edge_states?.root, "pending");
	assert.equal(initialStatus.agents.find(a => a.node_id === "branch-b")?.edge_states?.root, "pending");
	const initialRoot = initialStatus.agents.find(a => a.node_id === "root");
	assert.deepEqual(Object.keys(initialRoot?.handoffs_out ?? {}), [branchA.config.instance_id, branchB.config.instance_id]);
	assert.equal(initialRoot?.handoffs_out?.[branchA.config.instance_id]?.state, "none");
	assert.equal(initialRoot?.handoffs_out?.[branchB.config.instance_id]?.state, "none");
	const initialText = formatAgentStates(initialStatus.agents);
	assert.match(initialText, new RegExp(`\\[handoff out -> ${branchA.config.instance_id}: not offered\\]`));
	assert.match(initialText, new RegExp(`\\[handoff out -> ${branchB.config.instance_id}: not offered\\]`));

	await root.complete({ status: "success", summary: "Scouted", detail: "Found two tasks" });

	const afterRoot = run.status();
	const rootOut = afterRoot.agents.find(a => a.node_id === "root")?.handoffs_out;
	assert.equal(rootOut?.[branchA.config.instance_id]?.state, "queued");
	assert.equal(rootOut?.[branchB.config.instance_id]?.state, "queued");
	assert.equal(afterRoot.agents.find(a => a.node_id === "branch-a")?.edge_states?.root, "fired");
	assert.equal(afterRoot.agents.find(a => a.node_id === "branch-b")?.edge_states?.root, "fired");
	const afterText = formatAgentStates(afterRoot.agents);
	assert.match(afterText, /\[edges: root=fired\]/);
	assert.match(afterText, new RegExp(`\\[handoff out -> ${branchA.config.instance_id} [^\\]]+ queued`));
	assert.match(afterText, new RegExp(`\\[handoff out -> ${branchB.config.instance_id} [^\\]]+ queued`));

	await branchA.deliverNotification(root);
	await branchB.deliverNotification(root);

	assert.equal(run.status().agents.find(a => a.node_id === "branch-a")?.handoff?.state, "accepted");
	assert.equal(run.status().agents.find(a => a.node_id === "branch-b")?.handoff?.state, "accepted");

	await branchA.complete({ status: "success", summary: "A done", detail: "" });
	await branchB.complete({ status: "success", summary: "B done", detail: "" });

	const finalStatus = run.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	const report = await run.report();
	assert.deepEqual(report.results.map(r => [r.node_id, r.summary]), [
		["root", "Scouted"],
		["branch-a", "A done"],
		["branch-b", "B done"],
	]);
});

test("retried bootstrap_complete in a fan-out re-sends only undelivered edges from the saved result", async t => {
	let failSecondEdge = true;
	const sentTargets: string[] = [];
	const run = await runFixture(t, {
		topology: "graph",
		task: "Fan out partial delivery retry",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	}, new Map([
		["root", {
			executeTool: async (name, params) => {
				if (name !== "coms_send") return { content: [] };
				sentTargets.push(String(params.target));
				if (failSecondEdge && sentTargets.length === 2) {
					return { isError: true, content: [{ type: "text" as const, text: "temporary coms error" }] };
				}
				return { content: [{ type: "text" as const, text: "queued" }] };
			},
		}],
	]));
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;

	const firstAttempt = await root.complete({ status: "success", summary: "Saved once", detail: "original" });
	assert.equal(firstAttempt.isError, true);
	assert.equal(sentTargets.length, 2);

	const midStatus = run.status();
	assert.equal(midStatus.delivery_errors.length, 1);
	assert.equal(midStatus.agents[0].delivery, "failed");
	const savedCompletion = readJson<{ edge_deliveries?: Record<string, { state: string; handoff_id?: string }> }>(resultPath(run.run.session_dir, root.config.instance_id));
	assert.equal(savedCompletion.edge_deliveries?.[branchA.config.instance_id]?.state, "sent");
	assert.equal(savedCompletion.edge_deliveries?.[branchB.config.instance_id]?.state, "failed");
	assert.ok(savedCompletion.edge_deliveries?.[branchB.config.instance_id]?.handoff_id, "failed edge records the new offer's handoff_id");

	// Retry delivery: only the undelivered edge (branch-b) is sent; branch-a is NOT re-sent, and the original result is preserved.
	failSecondEdge = false;
	const retryAttempt = await root.complete({ status: "success", summary: "Should be ignored", detail: "ignored" });
	assert.equal(retryAttempt.isError, undefined);
	assert.equal(sentTargets.length, 3);
	assert.equal(sentTargets[2], `session-${branchB.config.instance_id}`);

	await branchA.deliverNotification(root);
	await branchB.deliverNotification(root);
	await branchA.complete({ status: "success", summary: "A ok", detail: "" });
	await branchB.complete({ status: "success", summary: "B ok", detail: "" });

	const finalStatus = run.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	assert.equal(finalStatus.results.find(r => r.node_id === "root")?.summary, "Saved once");
});

test("derived edge state reflects dependency_policy on partial and failed sources", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Edge state policies",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "strict", persona: "second", sub_task: "Strict", depends_on: ["root"], dependency_policy: "require_success" },
			{ node_id: "lenient", persona: "second", sub_task: "Lenient", depends_on: ["root"], dependency_policy: "allow_partial" },
		],
	});
	const root = run.nodes.get("root")!;
	await root.complete({ status: "partial", summary: "Partial work", detail: "" });

	const status = run.status();
	assert.equal(status.agents.find(a => a.node_id === "strict")?.edge_states?.root, "dead");
	assert.equal(status.agents.find(a => a.node_id === "lenient")?.edge_states?.root, "fired");
});

test("crash between edge A and edge B persists edge A delivery; reloaded worker retries only edge B", async t => {
	const firstSent: string[] = [];
	let edgeAPersistedMidLoop = false;
	let sessionDir = "";
	let rootInstanceId = "";
	const run = await runFixture(t, {
		topology: "graph",
		task: "Crash between fan-out edges",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	}, new Map([
		["root", {
			executeTool: async (name, params) => {
				if (name !== "coms_send") return { content: [] };
				firstSent.push(String(params.target));
				if (firstSent.length === 2) {
					const mid = readJson<{ edge_deliveries?: Record<string, { state: string }> }>(resultPath(sessionDir, rootInstanceId));
					edgeAPersistedMidLoop = mid.edge_deliveries?.["a2-branch-a"]?.state === "sent";
					return { isError: true, content: [{ type: "text" as const, text: "simulated crash on edge B" }] };
				}
				return { content: [{ type: "text" as const, text: "queued" }] };
			},
		}],
	]));
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;
	sessionDir = run.run.session_dir;
	rootInstanceId = root.config.instance_id;

	const firstAttempt = await root.complete({ status: "success", summary: "Original", detail: "kept" });
	assert.equal(firstAttempt.isError, true);
	assert.equal(edgeAPersistedMidLoop, true, "edge A delivery state must be persisted before edge B runs");
	await root.shutdown("reload");

	const retrySent: string[] = [];
	const reloaded = workerFromConfig(t, join(run.run.session_dir, `${root.config.instance_id}.config.json`), {
		executeTool: async (name, params) => {
			if (name === "coms_send") retrySent.push(String(params.target));
			return { content: [{ type: "text" as const, text: "queued" }] };
		},
	});
	await reloaded.start();
	const retryAttempt = await reloaded.complete({ status: "success", summary: "Ignored", detail: "ignored" });
	assert.equal(retryAttempt.isError, undefined);
	assert.deepEqual(retrySent, [`session-${branchB.config.instance_id}`]);

	await branchA.deliverNotification(root);
	await branchB.deliverNotification(reloaded);
	await branchA.complete({ status: "success", summary: "A done", detail: "" });
	await branchB.complete({ status: "success", summary: "B done", detail: "" });
	assert.equal(run.status().outcome.state, "succeeded");
});

test("reloaded worker treats an existing claim on edge A as already sent and sends only to edge B", async t => {
	let failB = true;
	const run = await runFixture(t, {
		topology: "graph",
		task: "Restart finds existing claim",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	}, new Map([
		["root", {
			executeTool: async (name, params) => {
				if (name !== "coms_send") return { content: [] };
				if (failB && String(params.target).endsWith("branch-b")) {
					return { isError: true, content: [{ type: "text" as const, text: "edge B failed" }] };
				}
				return { content: [{ type: "text" as const, text: "queued" }] };
			},
		}],
	]));
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;

	await root.complete({ status: "success", summary: "Scouted", detail: "" });
	await branchA.deliverNotification(root);
	await root.shutdown("reload");

	// Simulate root having crashed before persisting edge_deliveries for branch-a, while branch-a already claimed it.
	const rootResultFile = resultPath(run.run.session_dir, root.config.instance_id);
	const raw = readJson<Record<string, unknown>>(rootResultFile);
	delete raw.edge_deliveries;
	raw.delivery = "pending";
	atomicJson(rootResultFile, raw);

	const retrySent: string[] = [];
	const reloaded = workerFromConfig(t, join(run.run.session_dir, `${root.config.instance_id}.config.json`), {
		executeTool: async (name, params) => {
			if (name === "coms_send") retrySent.push(String(params.target));
			return { content: [{ type: "text" as const, text: "queued" }] };
		},
	});
	await reloaded.start();
	failB = false;
	const retry = await reloaded.complete({ status: "success", summary: "Ignored", detail: "" });
	assert.equal(retry.isError, undefined);
	assert.deepEqual(retrySent, [`session-${branchB.config.instance_id}`]);
});

test("blocked propagation blocks all downstream fan-out branches", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Blocked propagation",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	});
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;
	await root.complete({ status: "failure", summary: "Root failed", detail: "" });
	await branchA.deliverNotification(root);
	await branchB.deliverNotification(root);

	const status = run.status();
	for (const id of ["branch-a", "branch-b"]) {
		const agent = status.agents.find(a => a.node_id === id);
		assert.equal(agent?.execution, "blocked", `${id} should be blocked`);
		assert.ok(agent?.execution_causes.some(c => c.node_id === "root"), `${id} cause should name root`);
	}
	assert.equal(status.agents.find(a => a.node_id === "branch-a")?.edge_states?.root, "dead");
	assert.equal(status.agents.find(a => a.node_id === "branch-b")?.edge_states?.root, "dead");
});

test("cancel propagation on a fan-out root lists both branches in blocked_dependents", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	const run = await f.service.generate({
		topology: "graph",
		task: "Cancel propagation",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	}, model);

	const cancelResult = await f.service.cancel(run.task_id, {
		agents: ["root"],
		reason: "Abort root",
	});
	assert.deepEqual(cancelResult.cancelled, ["root"]);
	assert.deepEqual(
		cancelResult.blocked_dependents.map(d => [d.node_id, d.blocked_by]),
		[["branch-a", "root"], ["branch-b", "root"]],
	);

	const status = f.service.status(run.task_id);
	assert.equal(status.agents.find(a => a.node_id === "root")?.execution, "cancelled");
	assert.equal(status.agents.find(a => a.node_id === "branch-a")?.execution, "blocked");
	assert.equal(status.agents.find(a => a.node_id === "branch-b")?.execution, "blocked");
});

test("bootstrap_recover retry_delivery repairs a single failed graph fan-out edge", async t => {
	const run = await runFixture(t, {
		topology: "graph",
		task: "Recover fan-out edge",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Scout" },
			{ node_id: "branch-a", persona: "second", sub_task: "Branch A", depends_on: ["root"] },
			{ node_id: "branch-b", persona: "second", sub_task: "Branch B", depends_on: ["root"] },
		],
	}, new Map([
		["root", {
			executeTool: async (name, params) => {
				if (name === "coms_send" && String(params.target).endsWith("branch-b")) {
					return { isError: true, content: [{ type: "text" as const, text: "coms down for B" }] };
				}
				return { content: [{ type: "text" as const, text: "queued" }] };
			},
		}],
	]));
	const root = run.nodes.get("root")!;
	const branchA = run.nodes.get("branch-a")!;
	const branchB = run.nodes.get("branch-b")!;

	const res = await root.complete({ status: "success", summary: "Scouted", detail: "" });
	assert.equal(res.isError, true);
	await branchA.deliverNotification(root);
	await root.closeTab();

	const inspected = await run.service.recover(run.run.task_id, { action: "inspect" });
	assert.equal(inspected.assessments.find(a => a.destination.node_id === "branch-a")?.verdict, "wait");
	assert.equal(inspected.assessments.find(a => a.destination.node_id === "branch-b")?.verdict, "retry_delivery");

	const delivered: Array<{ target: string; prompt: string }> = [];
	const repaired = await run.service.recover(run.run.task_id, { action: "retry_delivery", agent: "branch-b" }, {
		wake: async (target, prompt) => { delivered.push({ target, prompt }); },
	});
	assert.equal(repaired.refused, undefined);
	assert.equal(repaired.delivery?.transport, "acknowledged");

	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].target, `session-${branchB.config.instance_id}`);
	await branchB.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "dispatcher" }, content: delivered[0].prompt },
	});
	await branchA.complete({ status: "success", summary: "A done", detail: "" });
	await branchB.complete({ status: "success", summary: "B done", detail: "" });
	assert.equal(run.status().outcome.state, "succeeded");
});

test("fan-out fingerprint and manifest/config/input bytes stay unchanged from ticket 12", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	const globalAgents = join(f.home, ".pi", "agent", "agents");
	mkdirSync(globalAgents, { recursive: true });
	writeFileSync(join(globalAgents, "first.md"), "---\nname: first\ndescription: First\n---\nFirst persona\n");
	writeFileSync(join(globalAgents, "second.md"), "---\nname: second\ndescription: Second\n---\nSecond persona\n");
	const fanoutModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
	const req = {
		topology: "graph" as const,
		task: "Fan-out stability",
		project_cwd: "/tmp",
		request_id: "fanout-fp-stability",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Root" },
			{ node_id: "left", persona: "second", sub_task: "Left", depends_on: ["root"] },
			{ node_id: "right", persona: "second", sub_task: "Right", depends_on: ["root"] },
		],
	};
	const run = await f.service.generate(req, fanoutModel);
	t.after(() => rmSync(run.session_dir, { recursive: true, force: true }));
	const requestFile = readdirSync(f.service.store.indexRoot).find(name => name.startsWith("request-") && name.endsWith(".json"));
	assert.ok(requestFile, "request record should exist");
	const requestRecord = readJson<{ fingerprint: string; task_id: string }>(join(f.service.store.indexRoot, requestFile));
	// Literal fan-out fingerprint captured from 6e97847 (ticket 12) for this exact plan.
	assert.equal(requestRecord.fingerprint, "72a331f59f67f577342c2a7c0bb93d3a0a42d266468d9ae3e1a16cc3794fb539");
	assert.equal(run.version, 3);
	const local = serviceFixture(t, ["first", "second"]);
	const localRun = await local.service.generate({ ...req, project_cwd: local.cwd, request_id: "fanout-roster-bytes" }, fanoutModel);
	assert.equal(localRun.version, 3);
	const normalize = (bytes: string) => bytes.replaceAll(local.cwd, "<project>").replaceAll(local.home, "<home>").replaceAll(localRun.task_id, "<run>").replaceAll(localRun.token, "<token>")
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<time>");
	// Captured from 6e97847 with only generated paths, IDs and timestamps replaced.
	assert.equal(normalize(readFileSync(join(localRun.session_dir, "manifest.json"), "utf8")), `{
  "version": 3,
  "request_form": "nodes",
  "collaboration_mode": "independent",
  "failure_policy": "independent",
  "workspace_strategy": "shared_cwd",
  "task_id": "<run>",
  "task": "Fan-out stability",
  "topology": "graph",
  "project_cwd": "<project>",
  "session_dir": "<project>/.pi/agent-sessions/<run>",
  "workspace_id": "origin-workspace",
  "coms_project": "boot-<run>",
  "status": "applied",
  "phase": "released",
  "token": "<token>",
  "created_at": "<time>",
  "updated_at": "<time>",
  "pane_manifest": [
    {
      "node_id": "root",
      "persona_name": "first",
      "attempt_id": "a1-root.1",
      "instance_id": "a1-root",
      "expected_coms_name": "a1-root",
      "expected_model": "anthropic/claude-sonnet-4-5",
      "label": "<run>:a1-root",
      "successor": "a2-left",
      "inbound_edges": [],
      "status": "released",
      "tab_id": "t1",
      "pane_id": "p1",
      "terminal_id": "term1"
    },
    {
      "node_id": "left",
      "persona_name": "second",
      "attempt_id": "a2-left.1",
      "instance_id": "a2-left",
      "expected_coms_name": "a2-left",
      "expected_model": "anthropic/claude-sonnet-4-5",
      "label": "<run>:a2-left",
      "predecessor": "a1-root",
      "inbound_edges": [
        "a1-root"
      ],
      "status": "released",
      "dependency_policy": "require_success",
      "tab_id": "t2",
      "pane_id": "p2",
      "terminal_id": "term2"
    },
    {
      "node_id": "right",
      "persona_name": "second",
      "attempt_id": "a3-right.1",
      "instance_id": "a3-right",
      "expected_coms_name": "a3-right",
      "expected_model": "anthropic/claude-sonnet-4-5",
      "label": "<run>:a3-right",
      "predecessor": "a1-root",
      "inbound_edges": [
        "a1-root"
      ],
      "status": "released",
      "dependency_policy": "require_success",
      "tab_id": "t3",
      "pane_id": "p3",
      "terminal_id": "term3"
    }
  ]
}
`);
	// Ticket 12 hashes of the complete config and input files after the same normalization.
	for (const [instanceId, configHash, inputHash] of [
		["a1-root", "1f40b93a8bc904ab9438c6311da0490732352bbdbf7a6d50bdb06c34e4b2e3db", "dad0f051b510d666163957d5999f3e5c760552678094d36436799e67cfcafbb5"],
		["a2-left", "ab9aed811b1ad6db0d5a107f8c1b8c0f747be0554e5e133857320b45052adbb1", "a5bd677437e97599acceec77650a69b1e50147d001b932d500fa32556effc339"],
		["a3-right", "8e4e9fd0812dc764442dd1412dad85c9d26c1fd86b512b70e59f6db897a7e13a", "9f2c316066aba092f5ec2b2de05c9e1b8970dd4235603b6cb1a64f6fcda8683d"],
	]) {
		for (const [suffix, hash] of [["config", configHash], ["input", inputHash]]) {
			const name = `${instanceId}.${suffix}.json`;
			const raw = readFileSync(join(localRun.session_dir, name), "utf8");
			let bytes = normalize(raw);
			if (suffix === "input") {
				// The verified input hash depends on the generated run ID.
				const input = parseTaskInput(JSON.parse(raw), { run_id: localRun.task_id, instance_id: instanceId });
				bytes = bytes.replace(input.input_hash, "<input-hash>");
			}
			assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, name);
		}
	}
});

test("a non-join graph follower keeps waiting while its grandparent makes progress", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const run = await runFixture(t, {
		topology: "graph",
		task: "Follow graph ancestry",
		dependency_wait_timeout_ms: 10_000,
		agents: [
			{ node_id: "c", persona: "second", sub_task: "C", depends_on: ["b"] },
			{ node_id: "b", persona: "second", sub_task: "B", depends_on: ["a"] },
			{ node_id: "a", persona: "first", sub_task: "A" },
		],
	});
	const a = run.nodes.get("a")!;
	const b = run.nodes.get("b")!;
	const c = run.nodes.get("c")!;
	for (let i = 0; i < 4; i++) {
		await a.hooks.get("tool_result")!({});
		t.mock.timers.tick(4000);
	}
	const status = run.status();
	assert.equal(status.agents.find(agent => agent.node_id === "b")?.execution, "waiting");
	assert.equal(status.agents.find(agent => agent.node_id === "c")?.execution, "waiting");

	await a.complete({ status: "success", summary: "A finished", detail: "" });
	assert.ok((await b.deliverNotification(a))?.systemPrompt);
	await b.complete({ status: "success", summary: "B finished", detail: "" });
	assert.ok((await c.deliverNotification(b))?.systemPrompt);
});
