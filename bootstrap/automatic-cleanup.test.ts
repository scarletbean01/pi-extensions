import assert from "node:assert/strict";
import test from "node:test";
import { createGraphWidgets } from "./graph-widget.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { formatAutomaticCleanup, formatReportDigest } from "./reporting.ts";
import { atomicJson, cleanupPolicyPath, dispositionPath, dispositionRecord, parseManifest, readJson, resultPath, type BootstrapManifest } from "./session-store.ts";
import { finalizePath } from "./review-loop.ts";
import { SessionStore as PreviousSessionStore } from "./test-support/previous-v5-session-store.ts";
import { chain, model, runFixture, serviceFixture } from "./test-support/chain-fixture.ts";

test("automatic cleanup keeps the report and serializes concurrent status reads", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, cleanup: "on_success" });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete({ status: "success", summary: "Built", detail: "" });
	await reviewer.deliverNotification(builder);
	await reviewer.complete({ status: "success", summary: "Reviewed", detail: "" });
	const read = () => f.service.statusWithCleanup(f.run.task_id);
	assert.equal((await read()).manifest.status, "applied");
	t.mock.timers.tick(2999);
	assert.equal((await read()).manifest.status, "applied");
	t.mock.timers.tick(1);
	const statuses = await Promise.all([read(), read(), read()]);
	for (const status of statuses) {
		assert.equal(status.manifest.status, "cleaned");
		assert.equal(status.manifest.cleanup_trigger, "auto");
		assert.equal(status.manifest.cleanup_at, new Date(1_003_000).toISOString());
		assert.equal(status.outcome.state, "succeeded");
	}
	assert.deepEqual((await f.report()).results.map(result => result.summary), ["Built", "Reviewed"]);
});

const success = { status: "success", summary: "Done", detail: "" };
const review = {
	...chain.agents[1],
	output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "revise"] } } },
	decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "n1", max_revisions: 1 },
};

test("dry-run cleanup policy validates options and keeps omitted legacy fingerprints and records", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	for (const topology of ["chain", "team", "graph"] as const) {
		const request = { ...chain, topology, project_cwd: f.cwd, request_id: topology };
		const dry = (options: Partial<typeof request & { cleanup: "on_success" | "manual"; cleanup_settle_ms: number }>) =>
			f.service.plan({ ...request, ...options }, model);
		const defaultMode = topology === "graph" ? "on_success" : "manual";
		assert.equal(dry({ cleanup: defaultMode }).cleanup, defaultMode);
		assert.equal(dry({ cleanup: defaultMode }).cleanup_settle_ms, 3000);
		assert.notEqual(dry({ cleanup: defaultMode }).fingerprint, dry({ cleanup: defaultMode === "manual" ? "on_success" : "manual" }).fingerprint);
		assert.notEqual(dry({ cleanup: defaultMode }).fingerprint, dry({ cleanup_settle_ms: 42 }).fingerprint);
		assert.throws(() => dry({ cleanup: "later" as "manual" }), /cleanup must be/);
		assert.throws(() => dry({ cleanup_settle_ms: -1 }), /cleanup_settle_ms must be/);
		const first = await f.service.generate(request, model);
		await f.service.generate({ ...request, cleanup: defaultMode, cleanup_settle_ms: 3000 }, model);
		const status = f.service.status(first.task_id);
		assert.equal(status.manifest.cleanup_policy?.mode, topology === "graph" ? "on_success" : undefined);
		await assert.rejects(f.service.generate({ ...request, cleanup: defaultMode === "manual" ? "on_success" : "manual" }, model), /different bootstrap plan/);
	}
});

test("the previous reader round-trips sidecar and embedded policies across automatic cleanup", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0, agents: [chain.agents[0], review] });
	const { task_id: taskId, session_dir: dir } = f.run;
	const previous = new PreviousSessionStore(f.stateDir);
	const manifestPath = join(dir, "manifest.json");
	const indexPath = join(f.stateDir, `${taskId}.json`);
	const policy = { version: 1, mode: "on_success", settle_ms: 0 };
	const autoText = /Run succeeded and was cleaned up automatically.*bootstrap_report/;
	const readLaunch = () => previous.load(taskId);
	assert.equal(parseManifest(readJson(manifestPath), taskId).cleanup_policy, undefined);
	assert.equal("cleanup_policy" in readLaunch(), false);
	previous.save(readLaunch());
	assert.deepEqual(f.status().manifest.cleanup_policy, policy);

	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete({ ...success, summary: "Built" });
	await reviewer.deliverNotification(builder);
	await reviewer.complete({ ...success, summary: "Approved", outputs: { verdict: "approve" } });
	assert.match(formatAutomaticCleanup((await f.service.statusWithCleanup(taskId)).manifest)!, autoText);

	const embedded = parseManifest(readJson(manifestPath), taskId);
	assert.equal(embedded.status, "cleaned");
	assert.equal(embedded.cleanup_trigger, "auto");
	assert.deepEqual(embedded.cleanup_policy, policy);
	assert.equal(previous.load(taskId).status, "cleaned");
	assert.throws(() => parseManifest({ ...embedded, cleanup_policy: { ...policy, version: 99 } }, taskId),
		/Unsupported cleanup policy version 99/);

	// Exercise an automatic cleanup journal whose policy is still in the sidecar.
	const { cleanup_policy: _policy, ...sidecarJournal } = embedded;
	atomicJson(manifestPath, sidecarJournal);
	atomicJson(indexPath, sidecarJournal);
	previous.save(previous.load(taskId));
	assert.match(formatAutomaticCleanup(f.status().manifest)!, autoText);
	f.service.store.save(f.status().manifest);

	// A previous release must preserve the complete journal even without the sidecar.
	rmSync(cleanupPolicyPath(dir));
	previous.save(previous.load(taskId));
	for (const path of [manifestPath, indexPath]) {
		const roundTrip = parseManifest(readJson(path), taskId);
		assert.deepEqual(roundTrip.cleanup_policy, policy);
		assert.equal(roundTrip.cleanup_at, embedded.cleanup_at);
		assert.match(formatAutomaticCleanup(roundTrip)!, autoText);
	}
	assert.match(formatReportDigest((await f.report()).results), /Run outcome: succeeded/);
});

test("index-only cleanup retains the launch policy after the previous reader saves without project files", async t => {
	const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 47 });
	const taskId = f.run.task_id;
	rmSync(f.run.session_dir, { recursive: true });
	const previous = new PreviousSessionStore(f.stateDir);
	previous.save(previous.load(taskId, undefined, true));
	await f.service.cleanup(taskId);
	const status = f.status();
	assert.equal(status.manifest.status, "cleaned");
	assert.equal(status.manifest.session_dir_removed, true);
	assert.deepEqual(status.manifest.cleanup_policy, { version: 1, mode: "on_success", settle_ms: 47 });
	assert.equal(formatAutomaticCleanup(status.manifest), undefined);
});

test("a future cleanup record version fails closed in status", async t => {
	const f = await runFixture(t, { ...chain, cleanup: "on_success" });
	atomicJson(cleanupPolicyPath(f.run.session_dir), { version: 99, mode: "on_success", settle_ms: 3000 });
	assert.throws(() => f.service.statusWithCleanup(f.run.task_id), /Unsupported cleanup policy version 99/);
});

test("accepted handoffs do not let cleanup interrupt pending delivery bookkeeping", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const sending = Promise.withResolvers<void>();
	const ack = Promise.withResolvers<{ content: []; details: object }>();
	const f = await runFixture(t, { ...chain, cleanup: "on_success" }, new Map([
		["n1", { executeTool: () => { sending.resolve(); return ack.promise; } }],
	]));
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	const writing = builder.complete(success);
	await sending.promise;
	await reviewer.deliverNotification(builder);
	await reviewer.complete(success);
	t.mock.timers.tick(10_000);
	const status = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(status.outcome.state, "succeeded");
	assert.equal(status.agents[1].handoff?.state, "accepted");
	assert.equal(status.agents[0].delivery, "pending");
	assert.deepEqual(status.agents.map(agent => agent.resource), ["released", "released"]);
	ack.resolve({ content: [], details: {} });
	await writing;
	assert.equal((await f.service.statusWithCleanup(f.run.task_id)).manifest.status, "cleaned");
});

test("automatic cleanup waits on parked nodes and materializes a settled loop's missing finalization", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 50, agents: [chain.agents[0], review] });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(success);
	t.mock.timers.tick(5000);
	const parked = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(parked.outcome.terminal, false);
	assert.equal(parked.agents[0].parked, true);
	assert.equal(parked.agents[0].resource, "released");
	await reviewer.deliverNotification(builder);
	await reviewer.complete({ ...success, outputs: { verdict: "approve" } });
	rmSync(finalizePath(f.run.session_dir, builder.config.instance_id));
	// Replay a notification after the reviewer committed finalization.
	await reviewer.deliverNotification(builder);
	t.mock.timers.tick(49);
	assert.equal((await f.service.statusWithCleanup(f.run.task_id)).manifest.status, "applied");
	t.mock.timers.tick(1);
	const closed = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(closed.manifest.status, "cleaned");
	assert.equal(closed.agents[0].finalized_by, "dispatcher");
	assert.ok(closed.agents.every(agent => agent.finalized && agent.resource === "closed" && agent.execution === "succeeded"));
	assert.deepEqual(closed.worker_errors, []);
});

test("failed, blocked, partial, cancelled, skipped and attention outcomes keep their resources", async t => {
	for (const outcome of ["failed", "blocked", "partial", "cancelled", "skipped", "needs_attention"] as const) {
		await t.test(outcome, async t => {
			t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
			const f = await runFixture(t, { ...chain, topology: "team", cleanup: "on_success", agents: [chain.agents[0]] });
			const agent = f.nodes.get("n1")!;
			if (outcome === "failed" || outcome === "partial") {
				await agent.complete({ ...success, status: outcome === "failed" ? "failure" : "partial" });
			} else if (outcome === "needs_attention") {
				agent.vanish();
			} else if (outcome === "cancelled") {
				await f.service.cancel(f.run.task_id, { reason: "Stopped for inspection" });
				await agent.beforeStart();
			} else {
				atomicJson(dispositionPath(f.run.session_dir, agent.config.instance_id),
					dispositionRecord(agent.config, outcome, "Did not execute", [], new Date().toISOString()));
			}
			t.mock.timers.tick(10_000);
			const status = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(status.outcome.state, outcome);
			assert.equal(status.manifest.cleanup_trigger, undefined);
			assert.equal(status.agents[0].resource, "released");
		});
	}
});

test("a manual graph or default chain/team keeps successful tabs open", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	for (const topology of ["chain", "team", "graph"] as const) {
		const f = await runFixture(t, { ...chain, topology, ...(topology === "graph" ? { cleanup: "manual" } : {}), agents: [chain.agents[0]] });
		await f.nodes.get("n1")!.complete(success);
		t.mock.timers.tick(10_000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "succeeded");
		assert.equal(status.agents[0].resource, "released");
		assert.equal(status.manifest.cleanup_trigger, undefined);
	}
});

test("automatic cleanup records closure errors, stops automatic retries, and allows an explicit retry", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, topology: "team", cleanup: "on_success", cleanup_settle_ms: 0 });
	for (const agent of f.nodes.values()) await agent.complete(success);
	const tabId = f.run.pane_manifest[0].tab_id!;
	const shutdown = f.onTabClose.get(tabId)!;
	f.onTabClose.set(tabId, async () => { await shutdown(); throw new Error("Lost close acknowledgement"); });
	const first = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(first.manifest.phase, "cleanup-incomplete");
	assert.match(formatAutomaticCleanup(first.manifest)!, /Retry with bootstrap_cleanup:[\s\S]*Lost close acknowledgement/);
	assert.equal((await f.service.statusWithCleanup(f.run.task_id)).agents[0].resource, "released");
	await f.service.cleanup(f.run.task_id);
	const retried = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(retried.manifest.status, "cleaned");
	assert.match(retried.manifest.cleanup_notes![0], /already closed/);
	assert.deepEqual(retried.manifest.cleanup_errors, []);
	assert.equal((await f.report()).results.length, 2);
});

test("an interrupted cleanup resumes from the journal and keeps another run's live tabs and files", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, topology: "team", cleanup: "on_success", cleanup_settle_ms: 0 });
	const other = await f.service.generate({ ...chain, task: "Other run", topology: "team", project_cwd: f.cwd }, model);
	// Keep a durable result outside the run and leave its other node active.
	const config = f.configs.find(item => item.task_id === other.task_id)!;
	atomicJson(resultPath(config.session_dir, config.instance_id), { result: { ...success, agent_name: config.persona_name }, delivery: "not_required", completed_at: new Date().toISOString() });
	for (const agent of f.nodes.values()) await agent.complete(success);
	const journal: BootstrapManifest = { ...f.status().manifest, cleanup_trigger: "auto", cleanup_at: new Date().toISOString(), phase: "auto-cleaning" };
	f.service.store.save(journal);
	await f.nodes.get("n1")!.closeTab();
	const closed = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(closed.manifest.status, "cleaned");
	assert.equal(closed.manifest.cleanup_at, journal.cleanup_at);
	assert.match(closed.manifest.cleanup_notes![0], /already closed/);
	assert.equal((await f.report()).results.length, 2);
	assert.equal(f.service.status(other.task_id).results[0].summary, "Done");
	await f.service.cleanup(other.task_id);
	assert.deepEqual(f.service.status(other.task_id).manifest.cleanup_notes, []);
});

test("a completed agent can be closed before the settle deadline once its process exits", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, topology: "graph", agents: [chain.agents[0]] });
	const node = f.nodes.get("n1")!;
	await node.complete(success);
	node.vanish();
	const status = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(status.manifest.status, "cleaned");
	assert.equal(status.outcome.state, "succeeded");
});

test("cancel and recovery racing with automatic close cannot reopen completed work", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
	const builder = f.nodes.get("n1")!;
	const reviewer = f.nodes.get("n2")!;
	await builder.complete(success);
	await reviewer.deliverNotification(builder);
	await reviewer.complete(success);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tabId = f.run.pane_manifest[0].tab_id!;
	const shutdown = f.onTabClose.get(tabId)!;
	f.onTabClose.set(tabId, async () => { entered.resolve(); await release.promise; await shutdown(); });
	const closing = f.service.statusWithCleanup(f.run.task_id);
	await entered.promise;
	assert.equal(f.status().manifest.phase, "auto-cleaning");
	const cancellation = f.service.cancel(f.run.task_id, { reason: "Cancellation during cleanup" });
	const recovery = f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" });
	const secondRead = f.service.statusWithCleanup(f.run.task_id);
	await reviewer.deliverNotification(builder);
	release.resolve();
	await Promise.all([closing, cancellation, recovery, secondRead]);
	const final = f.status();
	assert.equal(final.outcome.state, "succeeded");
	assert.equal(final.agents[1].handoff?.state, "accepted");
	assert.ok(final.agents.every(agent => agent.resource === "closed"));
	assert.deepEqual(final.worker_errors, []);
	assert.equal((await f.report()).results.length, 2);
});

test("a cancellation after every completion won does not strand an interrupted cleanup", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, { ...chain, topology: "team", cleanup: "on_success", cleanup_settle_ms: 0 });
	for (const agent of f.nodes.values()) await agent.complete(success);
	const journal: BootstrapManifest = { ...f.status().manifest, cleanup_trigger: "auto", cleanup_at: new Date().toISOString(), phase: "auto-cleaning" };
	f.service.store.save(journal);
	await f.service.cancel(f.run.task_id, { reason: "Completion already won" });
	const status = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(status.outcome.state, "succeeded");
	assert.equal(status.manifest.status, "cleaned");
	assert.equal(status.manifest.cleanup_at, journal.cleanup_at);
});

test("automatic cleanup of a fan-out and join waits for every branch", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	const f = await runFixture(t, {
		topology: "graph",
		task: "Diamond",
		cleanup_settle_ms: 0,
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Root" },
			{ node_id: "left", persona: "first", sub_task: "Left", depends_on: ["root"] },
			{ node_id: "right", persona: "first", sub_task: "Right", depends_on: ["root"] },
			{ node_id: "join", persona: "second", sub_task: "Join", depends_on: ["left", "right"] },
		],
	});
	const root = f.nodes.get("root")!;
	const left = f.nodes.get("left")!;
	const right = f.nodes.get("right")!;
	const join = f.nodes.get("join")!;
	await root.complete(success);
	await left.deliverNotification(root);
	await right.deliverNotification(root);
	await left.complete(success);
	await join.deliverNotification(left);
	const waiting = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(waiting.outcome.state, "incomplete");
	assert.ok(waiting.agents.every(agent => agent.resource === "released"));
	await right.complete(success);
	await join.deliverNotification(right);
	await join.complete(success);
	const closed = await f.service.statusWithCleanup(f.run.task_id);
	assert.equal(closed.manifest.status, "cleaned");
	assert.ok(closed.agents.every(agent => agent.execution === "succeeded" && agent.resource === "closed"));
	assert.equal((await f.report()).results.length, 4);
});

test("cleaned widgets retain the outcome for manual success, manual failure and automatic success", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const kind of ["chain", "team", "graph", "loop"] as const) {
		await t.test(kind, async () => {
			for (const mode of ["manual-success", "manual-failure", "automatic"] as const) {
				const topology = kind === "loop" ? "chain" : kind;
				const f = await runFixture(t, {
					...chain, topology, cleanup: mode === "automatic" ? "on_success" : "manual",
					agents: [chain.agents[0], kind === "loop" ? review :
						{ ...chain.agents[1], ...(topology === "graph" ? { depends_on: ["n1"] } : {}) }],
				});
				const builder = f.nodes.get("n1")!;
				const reviewer = f.nodes.get("n2")!;
				await builder.complete(success);
				if (topology !== "team") await reviewer.deliverNotification(builder);
				const failed = mode === "manual-failure";
				await reviewer.complete(failed ? { ...success, status: "failure" } :
					{ ...success, ...(kind === "loop" ? { outputs: { verdict: "approve" } } : {}) });
				if (mode === "automatic") {
					t.mock.timers.tick(3000);
					await f.service.statusWithCleanup(f.run.task_id);
				} else await f.service.cleanup(f.run.task_id);
				const status = f.status();
				const outcome = failed ? "failed" : "succeeded";
				assert.deepEqual(status.worker_errors, []);
				assert.equal(status.outcome.state, outcome);
				let frame: string[] = [];
				const widgets = createGraphWidgets(() => status);
				await widgets.attach(f.run.task_id, {
					cwd: f.cwd, hasUI: true,
					ui: { setWidget: (_key: string, render?: Function) => {
						if (render) frame = render({ requestRender() {} }, { fg: (_color: string, text: string) => text }).render(140);
					} },
				} as any, status);
				widgets.reset();
				assert.match(frame.find(line => line.includes(" run ")) ?? "", new RegExp(` · ${outcome} · cleaned · `));
				assert.equal(frame.some(line => line.includes("cleaned up automatically")), mode === "automatic");
			}
		});
	}
});
