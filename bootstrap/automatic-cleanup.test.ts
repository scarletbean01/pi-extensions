import assert from "node:assert/strict";
import test from "node:test";
import { createGraphWidgets } from "./graph-widget.ts";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffClaimPath } from "./handoff.ts";
import { formatAutomaticCleanup, formatReportDigest } from "./reporting.ts";
import { atomicJson, cleanupPolicyPath, dispositionPath, dispositionRecord, parseManifest, readJson, readyPath, resultPath, type BootstrapManifest, type WorkerCompletion } from "./session-store.ts";
import { finalizePath } from "./review-loop.ts";
import { wakeViaComs } from "./recovery.ts";
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

test("routed result with pending delivery after exit cleans up once successor accepted and succeeded", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const topology of ["chain", "graph"] as const) {
		await t.test(topology, async () => {
			const f = await runFixture(t, {
				...chain,
				topology,
				cleanup: "on_success",
				agents: [
					{ ...chain.agents[0], write_paths: ["src/a.ts"] },
					{ ...chain.agents[1], ...(topology === "graph" ? { depends_on: ["n1"] } : {}), write_paths: ["src/b.ts"] },
				],
			});
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			await second.deliverNotification(first);
			await second.complete(success);
			// Simulate first having exited between saving its result (delivery: "pending") and updating delivery: "sent".
			const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
			atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "pending" });
			first.vanish();
			t.mock.timers.tick(3000);
			const status = await f.service.statusWithCleanup(f.run.task_id);
			assert.deepEqual(status.worker_errors, []);
			assert.deepEqual(status.delivery_errors, []);
			assert.equal(status.outcome.state, "succeeded");
			assert.equal(status.outcome.terminal, true);
			assert.deepEqual(status.agents.map(a => a.execution_causes), [[], []]);
			assert.ok(status.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
			assert.equal(status.manifest.status, "cleaned");
			assert.equal(status.manifest.cleanup_trigger, "auto");
			assert.ok(status.agents.every(a => a.resource === "closed"));
			assert.equal(readJson<WorkerCompletion>(firstResult).delivery, "pending", "dispatcher never rewrites result files");
			assert.deepEqual((await f.report()).results.map(r => r.summary), ["Done", "Done"]);
		});
	}
});

test("routed pending delivery blocks cleanup while successor has not claimed and reports live wait reason", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// (a) Live source still in delivery bookkeeping: wait reason explains why cleanup has not run even after successor succeeds.
	{
		const sending = Promise.withResolvers<void>();
		const ack = Promise.withResolvers<{ content: []; details: object }>();
		const f = await runFixture(t, { ...chain, cleanup: "on_success" }, new Map([
			["n1", { executeTool: () => { sending.resolve(); return ack.promise; } }],
		]));
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		const writing = first.complete(success);
		await sending.promise;
		await second.deliverNotification(first);
		await second.complete(success);
		t.mock.timers.tick(10_000);
		const waiting = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(waiting.manifest.status, "applied");
		assert.equal(waiting.manifest.cleanup_trigger, undefined);
		assert.match(waiting.cleanup_wait_reason ?? "", /waiting for n1 delivery.*still live/i);
		ack.resolve({ content: [], details: {} });
		await writing;
		const cleaned = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(cleaned.manifest.status, "cleaned");
		assert.equal(cleaned.cleanup_wait_reason, undefined);
	}

	// (b) Live source before successor claims: cleanup does not run.
	{
		const entered = Promise.withResolvers<void>();
		const hold = new Promise<never>(() => {});
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 }, new Map([
			["n1", { executeTool: () => { entered.resolve(); return hold; } }],
		]));
		const first = f.nodes.get("n1")!;
		void first.complete(success);
		await entered.promise;
		t.mock.timers.tick(10_000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "incomplete");
		assert.equal(status.outcome.terminal, false);
		assert.equal(status.manifest.status, "applied");
		assert.equal(status.manifest.cleanup_trigger, undefined);
		assert.deepEqual(status.agents.map(a => a.resource), ["released", "released"]);
	}

	// (c) Exited source with unclaimed live successor: cleanup does not run and error surfaces.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
		const first = f.nodes.get("n1")!;
		await first.complete(success);
		const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "pending" });
		first.vanish();
		t.mock.timers.tick(10_000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "incomplete");
		assert.equal(status.outcome.terminal, false);
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
		assert.equal(status.manifest.status, "applied");
		assert.equal(status.manifest.cleanup_trigger, undefined);
		assert.deepEqual(status.agents.map(a => a.resource), ["released", "released"]);
	}
});

test("routed pending delivery with failed or vanished successor never triggers automatic cleanup", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// (a) Successor accepted and failed -> outcome failed, source has no spurious handoff error, no cleanup.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "pending" });
		first.vanish();
		await second.deliverNotification(first);
		await second.complete({ ...success, status: "failure", summary: "Successor failed" });
		t.mock.timers.tick(5000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "failed");
		assert.equal(status.outcome.terminal, true);
		assert.deepEqual(status.worker_errors, []);
		assert.deepEqual(status.delivery_errors, []);
		assert.equal(status.manifest.status, "applied");
		assert.equal(status.manifest.cleanup_trigger, undefined);
		assert.deepEqual(status.agents.map(a => a.resource), ["released", "released"]);
	}

	// (b) Successor never claimed and vanished -> needs_attention, no cleanup.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "pending" });
		first.vanish();
		second.vanish();
		t.mock.timers.tick(5000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "needs_attention");
		assert.equal(status.outcome.terminal, false);
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
		assert.ok(status.worker_errors.some(err => /process exited before recording a result/.test(err)));
		assert.equal(status.manifest.status, "applied");
		assert.deepEqual(status.agents.map(a => a.resource), ["released", "released"]);
	}

	// (c) Successor accepted and vanished without result -> needs_attention on successor only, no cleanup.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "pending" });
		first.vanish();
		await second.deliverNotification(first);
		second.vanish();
		t.mock.timers.tick(5000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "needs_attention");
		assert.equal(status.outcome.terminal, false);
		assert.equal(status.worker_errors.length, 1);
		assert.match(status.worker_errors[0], /accepted handoff.*no result/);
		assert.equal(status.manifest.status, "applied");
		assert.deepEqual(status.agents.map(a => a.resource), ["released", "released"]);
	}
});

test("unrouted approving reviewer and final node exited with real delivery values follow one consistent rule", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const role of ["approving-reviewer", "final-node"] as const) {
		for (const delivery of ["pending", "sent", "not_required", "failed"] as const) {
			await t.test(`${role} (${delivery})`, async () => {
				const isReviewer = role === "approving-reviewer";
				const f = await runFixture(t, {
					...chain,
					topology: isReviewer ? "chain" : "graph",
					cleanup: "on_success",
					cleanup_settle_ms: 0,
					agents: [
						{ ...chain.agents[0], write_paths: ["src/a.ts"] },
						isReviewer ? review : { ...chain.agents[1], depends_on: ["n1"] },
					],
				});
				const first = f.nodes.get("n1")!;
				const second = f.nodes.get("n2")!;
				await first.complete(success);
				await second.deliverNotification(first);
				await second.complete(isReviewer ? { ...success, outputs: { verdict: "approve" } } : success);
				const secondKey = isReviewer ? `${second.config.instance_id}.1` : second.config.instance_id;
				const secondResult = resultPath(f.run.session_dir, secondKey);
				atomicJson(secondResult, {
					...readJson<WorkerCompletion>(secondResult),
					delivery,
					...(delivery === "failed" ? { delivery_error: "send failed" } : {}),
				});

				if (delivery === "pending") {
					// While the unrouted agent is still live with delivery: "pending", cleanup must not close it mid-write.
					const live = await f.service.statusWithCleanup(f.run.task_id);
					assert.equal(live.manifest.status, "applied");
					assert.match(live.cleanup_wait_reason ?? "", /waiting for n2 delivery.*still live/i);
				}

				second.vanish();
				const status = await f.service.statusWithCleanup(f.run.task_id);
				assert.deepEqual(status.worker_errors, []);
				assert.equal(status.outcome.state, "succeeded");
				assert.equal(status.outcome.terminal, true);
				if (delivery === "failed") {
					assert.equal(status.delivery_errors.length, 1);
					assert.equal(status.manifest.status, "applied");
					assert.equal(status.manifest.cleanup_trigger, undefined);
					assert.ok(status.agents.every(a => a.resource === "released"));
					assert.match(status.cleanup_wait_reason ?? "", /delivery errors have not settled; resolve with bootstrap_recover or bootstrap_cleanup/);
					assert.doesNotMatch(status.cleanup_wait_reason ?? "", /\bwaiting\b/i);
				} else {
					assert.deepEqual(status.delivery_errors, []);
					assert.ok(status.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
					assert.equal(status.manifest.status, "cleaned");
					assert.equal(status.manifest.cleanup_trigger, "auto");
					assert.ok(status.agents.every(a => a.resource === "closed"));
					assert.equal(readJson<WorkerCompletion>(secondResult).delivery, delivery);
					assert.equal((await f.report()).results.length, 2);
				}
			});
		}
	}
});

test("unknown delivery value fails closed and never cleans a live or exited unrouted agent", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const [label, value, expected] of [
		["string", "none", '"none"'],
		["empty string", "", '""'],
		["object", { bad: true }, '{"bad":true}'],
	] as const) {
		await t.test(label, async () => {
			const f = await runFixture(t, {
				...chain,
				topology: "graph",
				cleanup_settle_ms: 0,
				agents: [
					{ ...chain.agents[0], write_paths: ["src/a.ts"] },
					{ ...chain.agents[1], depends_on: ["n1"] },
				],
			});
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			await second.deliverNotification(first);
			await second.complete(success);
			const secondResult = resultPath(f.run.session_dir, second.config.instance_id);
			atomicJson(secondResult, { ...readJson<WorkerCompletion>(secondResult), delivery: value as unknown as WorkerCompletion["delivery"] });

			const live = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(live.manifest.status, "applied");
			assert.equal(live.manifest.cleanup_trigger, undefined);
			assert.deepEqual(live.worker_errors, []);
			assert.deepEqual(live.delivery_errors, []);
			assert.equal(live.outcome.state, "succeeded");
			assert.equal(live.outcome.terminal, true);
			assert.ok(live.agents.every(a => a.resource === "released"));
			assert.ok(live.agents.every(a => a.execution_causes.length === 0));
			assert.ok(live.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
			assert.equal(live.cleanup_wait_reason, `Automatic cleanup has not run yet: n2 delivery state is ${expected}.`);
			assert.doesNotMatch(live.cleanup_wait_reason ?? "", /\[object Object\]/);
			assert.doesNotMatch(live.cleanup_wait_reason ?? "", /\bwaiting\b/i);

			second.vanish();
			const exited = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(exited.manifest.status, "applied");
			assert.equal(exited.manifest.cleanup_trigger, undefined);
			assert.equal(readJson<BootstrapManifest>(join(f.run.session_dir, "manifest.json")).status, "applied");
			assert.equal(exited.cleanup_wait_reason, `Automatic cleanup has not run yet: n2 delivery state is ${expected}.`);
		});
	}
});

test("routed live source with unknown delivery value fails closed for graph and chain (pin)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const topology of ["graph", "chain"] as const) {
		await t.test(topology, async () => {
			const f = await runFixture(t, {
				...chain,
				topology,
				cleanup: "on_success",
				cleanup_settle_ms: 0,
				agents: topology === "graph"
					? [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, { ...chain.agents[1], depends_on: ["n1"] }]
					: [{ ...chain.agents[0], write_paths: ["src/a.ts"] }, chain.agents[1]],
			});
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			await second.deliverNotification(first);
			await second.complete(success);
			const firstResult = resultPath(f.run.session_dir, first.config.instance_id);
			atomicJson(firstResult, { ...readJson<WorkerCompletion>(firstResult), delivery: "none" as unknown as WorkerCompletion["delivery"] });
			second.vanish();

			t.mock.timers.tick(5000);
			const status = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(status.manifest.status, "applied");
			assert.equal(status.manifest.cleanup_trigger, undefined);
			assert.equal(readJson<BootstrapManifest>(join(f.run.session_dir, "manifest.json")).status, "applied");
			assert.deepEqual(status.worker_errors, []);
			assert.deepEqual(status.delivery_errors, []);
			assert.equal(status.outcome.state, "succeeded");
			assert.equal(status.outcome.terminal, true);
			assert.ok(status.agents.every(a => a.execution_causes.length === 0));
			assert.ok(status.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
			assert.equal(status.agents.find(a => a.node_id === "n1")?.resource, "released");
			assert.equal(status.cleanup_wait_reason, 'Automatic cleanup has not run yet: n1 delivery state is "none".');
			assert.doesNotMatch(status.cleanup_wait_reason ?? "", /\bwaiting\b/i);
			assert.equal((await f.report()).results.length, 2);
		});
	}
});

test("fan-out pending delivery waits when only one edge is accepted, cleans up once both settle, and failed sibling stays failed", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// (a) Fan-out: edge 1 sent/accepted, edge 2 undelivered -> no cleanup; after recovery & completion -> cleans up.
	{
		let failRight = true;
		const f = await runFixture(t, {
			topology: "graph",
			task: "Fan-out partial pending",
			cleanup_settle_ms: 0,
			agents: [
				{ node_id: "root", persona: "first", sub_task: "Root", write_paths: ["src/root.ts"] },
				{ node_id: "left", persona: "second", sub_task: "Left", depends_on: ["root"] },
				{ node_id: "right", persona: "second", sub_task: "Right", depends_on: ["root"] },
			],
		}, new Map([
			["root", {
				executeTool: async (_name, params: any) => {
					if (failRight && String(params.target).endsWith("a3-right")) {
						return { isError: true, content: [{ type: "text", text: "edge right failed" }] };
					}
					return { content: [], details: { msg_id: "ok" } };
				},
			}],
		]));
		const root = f.nodes.get("root")!;
		const left = f.nodes.get("left")!;
		const right = f.nodes.get("right")!;
		await root.complete(success);
		// Root had left sent, right failed; simulate root exited with delivery: "pending" (preserving edge_deliveries for left only).
		const rootResult = resultPath(f.run.session_dir, root.config.instance_id);
		const savedRoot = readJson<WorkerCompletion>(rootResult);
		atomicJson(rootResult, {
			...savedRoot,
			delivery: "pending",
			edge_deliveries: { [left.config.instance_id]: savedRoot.edge_deliveries![left.config.instance_id] },
		});
		root.vanish();
		await left.deliverNotification(root);
		await left.complete(success);
		t.mock.timers.tick(5000);

		const halfSettled = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(halfSettled.outcome.state, "incomplete");
		assert.equal(halfSettled.outcome.terminal, false);
		assert.equal(halfSettled.manifest.status, "applied");
		assert.ok(halfSettled.agents.every(a => a.resource === "released"));

		// Recover right's unclaimed handoff; right accepts and succeeds while root's result still says delivery: "pending".
		failRight = false;
		const rec = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "right" }, {
			senderSession: "disp-session",
			wake: wakeViaComs(async (_tool, args) => {
				await right.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "disp-session" }, content: args.prompt } });
				return { content: [], details: { msg_id: "rec-right" } };
			}),
		});
		assert.equal(rec.delivery?.transport, "acknowledged");
		await right.complete(success);

		const settled = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(settled.worker_errors, []);
		assert.deepEqual(settled.delivery_errors, []);
		assert.equal(settled.outcome.state, "succeeded");
		assert.equal(settled.outcome.terminal, true);
		assert.equal(settled.manifest.status, "cleaned");
		assert.equal(settled.manifest.cleanup_trigger, "auto");
		assert.ok(settled.agents.every(a => a.resource === "closed"));
		assert.equal(readJson<WorkerCompletion>(rootResult).delivery, "pending");
		assert.equal((await f.report()).results.length, 3);
	}

	// (b) Join with failed sibling stays failed and does not clean up.
	{
		const f = await runFixture(t, {
			topology: "graph",
			task: "Join failed sibling",
			cleanup_settle_ms: 0,
			agents: [
				{ node_id: "left", persona: "first", sub_task: "Left" },
				{ node_id: "right", persona: "first", sub_task: "Right" },
				{ node_id: "join", persona: "second", sub_task: "Join", depends_on: ["left", "right"] },
			],
		});
		const left = f.nodes.get("left")!;
		const right = f.nodes.get("right")!;
		const join = f.nodes.get("join")!;
		await left.complete(success);
		const leftResult = resultPath(f.run.session_dir, left.config.instance_id);
		atomicJson(leftResult, { ...readJson<WorkerCompletion>(leftResult), delivery: "pending" });
		left.vanish();
		await right.complete({ ...success, status: "failure", summary: "Right failed" });
		await join.deliverNotification(left);
		await join.deliverNotification(right);
		t.mock.timers.tick(5000);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.outcome.state, "failed");
		assert.equal(status.outcome.terminal, true);
		assert.deepEqual(status.agents[2].execution_causes.map(c => c.node_id), ["right"]);
		assert.equal(status.manifest.status, "applied");
		assert.ok(status.agents.every(a => a.resource === "released"));
	}
});

test("loop reviewer approval forward edge to outside successor and graph with loops clean up when delivery is pending after exit", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// (a) Chain loop with outside successor: build -> review -> publish.
	{
		const f = await runFixture(t, {
			...chain,
			cleanup: "on_success",
			cleanup_settle_ms: 0,
			agents: [
				{ ...chain.agents[0], write_paths: ["src/a.ts"] },
				review,
				{ node_id: "publish", persona: "second", sub_task: "Publish", write_paths: ["dist/out.txt"] },
			],
		});
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		const publisher = f.nodes.get("publish")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "revise" } });
		await builder.deliverNotification(reviewer);
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "approve" } });
		const reviewResult = resultPath(f.run.session_dir, `${reviewer.config.instance_id}.2`);
		atomicJson(reviewResult, { ...readJson<WorkerCompletion>(reviewResult), delivery: "pending" });
		reviewer.vanish();
		await publisher.deliverNotification(reviewer);
		await publisher.complete(success);
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(status.worker_errors, []);
		assert.deepEqual(status.delivery_errors, []);
		assert.equal(status.outcome.state, "succeeded");
		assert.equal(status.outcome.terminal, true);
		assert.ok(status.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
		assert.equal(status.manifest.status, "cleaned");
		assert.equal(status.manifest.cleanup_trigger, "auto");
		assert.ok(status.agents.every(a => a.resource === "closed"));
		assert.equal(readJson<WorkerCompletion>(reviewResult).delivery, "pending");
		assert.equal((await f.report()).results.length, 3);
	}

	// (b) Graph with loops and join: two parallel review loops feeding merge.
	{
		const verdictContract = { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "changes_requested"] } } };
		const f = await runFixture(t, {
			topology: "graph",
			task: "Graph loops with pending delivery",
			cleanup_settle_ms: 0,
			agents: [
				{ node_id: "build-a", persona: "first", sub_task: "Build A", write_paths: ["src/a"] },
				{ node_id: "build-b", persona: "first", sub_task: "Build B", write_paths: ["src/b"] },
				{
					node_id: "review-a", persona: "second", depends_on: ["build-a"], sub_task: "Review A",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-a", max_revisions: 2 },
				},
				{
					node_id: "review-b", persona: "second", depends_on: ["build-b"], sub_task: "Review B",
					output_contract: verdictContract,
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build-b", max_revisions: 2 },
				},
				{ node_id: "merge", persona: "second", depends_on: ["review-a", "review-b"], sub_task: "Merge" },
			],
		});
		const buildA = f.nodes.get("build-a")!;
		const buildB = f.nodes.get("build-b")!;
		const reviewA = f.nodes.get("review-a")!;
		const reviewB = f.nodes.get("review-b")!;
		const merge = f.nodes.get("merge")!;
		await buildA.complete(success);
		await buildB.complete(success);
		await reviewA.deliverNotification(buildA);
		await reviewB.deliverNotification(buildB);
		await reviewA.complete({ ...success, outputs: { verdict: "approve" } });
		await reviewB.complete({ ...success, outputs: { verdict: "approve" } });
		const reviewAResult = resultPath(f.run.session_dir, `${reviewA.config.instance_id}.1`);
		atomicJson(reviewAResult, { ...readJson<WorkerCompletion>(reviewAResult), delivery: "pending" });
		reviewA.vanish();
		await merge.deliverNotification(reviewA);
		await merge.deliverNotification(reviewB);
		await merge.complete(success);

		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(status.worker_errors, []);
		assert.deepEqual(status.delivery_errors, []);
		assert.equal(status.outcome.state, "succeeded");
		assert.equal(status.outcome.terminal, true);
		assert.ok(status.agents.every(a => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"));
		assert.equal(status.manifest.status, "cleaned");
		assert.equal(status.manifest.cleanup_trigger, "auto");
		assert.ok(status.agents.every(a => a.resource === "closed"));
		assert.equal((await f.report()).results.length, 5);
	}
});

test("chain and team on_success runs preserve baseline automatic cleanup behavior", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const topology of ["chain", "team"] as const) {
		await t.test(topology, async () => {
			const f = await runFixture(t, { ...chain, topology, cleanup: "on_success" });
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			if (topology === "chain") await second.deliverNotification(first);
			await second.complete(success);
			t.mock.timers.tick(2999);
			assert.equal((await f.service.statusWithCleanup(f.run.task_id)).manifest.status, "applied");
			t.mock.timers.tick(1);
			const cleaned = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(cleaned.manifest.status, "cleaned");
			assert.equal(cleaned.manifest.cleanup_trigger, "auto");
			assert.deepEqual(cleaned.worker_errors, []);
			assert.equal(cleaned.outcome.state, "succeeded");
			assert.equal(cleaned.outcome.terminal, true);
			assert.deepEqual((await f.report()).results.map(r => r.summary), ["Done", "Done"]);
		});
	}
});

test("manual cleanup chain, team, and review_plan runs stay byte-identical to main on pending unrouted results", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	for (const topology of ["chain", "team"] as const) {
		await t.test(`${topology} manual exited pending`, async () => {
			const f = await runFixture(t, { ...chain, topology, cleanup: "manual" });
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			if (topology === "chain") await second.deliverNotification(first);
			await second.complete(success);
			const p = resultPath(f.run.session_dir, second.config.instance_id);
			atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
			second.vanish();
			t.mock.timers.tick(5000);
			const status = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(status.manifest.status, "applied");
			assert.deepEqual(status.pending, ["n2"]);
			assert.deepEqual(status.worker_errors, ["n2 (persona second): process exited during chain handoff"]);
			assert.deepEqual(status.delivery_errors, []);
			assert.equal(status.outcome.state, "succeeded");
			assert.equal(status.outcome.terminal, true);
			assert.equal(status.cleanup_wait_reason, undefined);
			await assert.rejects(f.report(), /Run is not complete\. Pending: n2/);
		});
	}

	await t.test("review_plan manual run with live outside pending node stays incomplete and non-terminal", async () => {
		const f = await runFixture(t, {
			...chain,
			cleanup: "manual",
			agents: [
				{ ...chain.agents[0] },
				review,
				{ node_id: "publish", persona: "second", sub_task: "Publish" },
			],
		});
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		const publisher = f.nodes.get("publish")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "approve" } });
		await publisher.deliverNotification(reviewer);
		await publisher.complete(success);
		const pubResult = resultPath(f.run.session_dir, `${publisher.config.instance_id}.1`);
		atomicJson(pubResult, { ...readJson<WorkerCompletion>(pubResult), delivery: "pending" });
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.manifest.status, "applied");
		assert.deepEqual(status.pending, ["publish"]);
		assert.deepEqual(status.worker_errors, []);
		assert.equal(status.outcome.state, "incomplete");
		assert.equal(status.outcome.terminal, false);
		await assert.rejects(f.report(), /Run is not complete\. Pending: publish/);

		const widgets = createGraphWidgets(f.service);
		let frame: string[] = [];
		await widgets.attach(f.run.task_id, {
			cwd: f.cwd, hasUI: true,
			ui: { setWidget: (_key: string, render?: Function) => {
				if (render) frame = render({ requestRender() {} }, { fg: (_color: string, text: string) => text }).render(140);
			} },
		} as any, status);
		widgets.reset();
		assert.match(frame.find(line => line.includes(" run ")) ?? "", / · incomplete · /);
	});
});

test("on_success per-edge sent evidence settles source status and cancellation while wrong-attempt or unfinalized claims stay unsettled", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// D1: graph source with edge_deliveries sent and delivery rewritten to pending, vanished, unclaimed successor -> pending [n2], no worker_errors.
	{
		const f = await runFixture(t, {
			...chain,
			topology: "graph",
			cleanup_settle_ms: 0,
			agents: [{ ...chain.agents[0] }, { ...chain.agents[1], depends_on: ["n1"] }],
		});
		const first = f.nodes.get("n1")!;
		await first.complete(success);
		const p = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
		first.vanish();
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.manifest.status, "applied");
		assert.deepEqual(status.pending, ["n2"]);
		assert.deepEqual(status.worker_errors, []);
		assert.deepEqual(status.delivery_errors, []);
		assert.equal(status.outcome.state, "incomplete");
		assert.equal(status.outcome.terminal, false);
	}

	// E1 pin: decision agent approves & exits with delivery: "pending" before run cancel.
	// With edge_deliveries recorded sent -> settles as cancelled (terminal). Without edge_deliveries -> stays incomplete (non-terminal).
	for (const keepEdgeSent of [true, false]) {
		const f = await runFixture(t, {
			...chain,
			cleanup: "on_success",
			cleanup_settle_ms: 0,
			agents: [
				{ ...chain.agents[0] },
				review,
				{ node_id: "publish", persona: "second", sub_task: "Publish" },
			],
		});
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "approve" } });
		const p = resultPath(f.run.session_dir, `${reviewer.config.instance_id}.1`);
		const saved = readJson<WorkerCompletion>(p);
		atomicJson(p, { ...saved, delivery: "pending", ...(keepEdgeSent ? {} : { edge_deliveries: undefined }) });
		reviewer.vanish();
		await f.service.cancel(f.run.task_id, { reason: "stop" });
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.manifest.status, "applied");
		if (keepEdgeSent) {
			assert.deepEqual(status.pending, []);
			assert.deepEqual(status.worker_errors, []);
			assert.equal(status.outcome.state, "cancelled");
			assert.equal(status.outcome.terminal, true);
		} else {
			assert.deepEqual(status.pending, ["n2"]);
			assert.equal(status.outcome.state, "incomplete");
			assert.equal(status.outcome.terminal, false);
		}
	}

	// m10: graph wrong source attempt claim on unfinished successor does not settle source status.
	{
		const f = await runFixture(t, {
			...chain,
			topology: "graph",
			cleanup_settle_ms: 0,
			agents: [{ ...chain.agents[0] }, { ...chain.agents[1], depends_on: ["n1"] }],
		});
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const p = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		first.vanish();
		await second.deliverNotification(first);
		const cp = handoffClaimPath(f.run.session_dir, second.config.instance_id, first.config.instance_id);
		const claim = readJson<any>(cp);
		atomicJson(cp, { ...claim, source: { ...claim.source, attempt_id: `${first.config.instance_id}.2` } });
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.deepEqual(status.pending, ["n1", "n2"]);
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
	}

	// m10 (loop revision): builder attempt 2 pending & vanished before reviewer attempt 2 claims does not reuse attempt 1 claim.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0, agents: [{ ...chain.agents[0] }, review] });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "revise" } });
		await builder.deliverNotification(reviewer);
		await builder.complete(success);
		const p = resultPath(f.run.session_dir, `${builder.config.instance_id}.2`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		builder.vanish();
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.ok(status.pending.includes("n1"));
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
	}

	// m11: unrouted approving sink reviewer exited with pending and missing finalization surfaces handoff exit error.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0, agents: [{ ...chain.agents[0] }, review] });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "approve" } });
		unlinkSync(finalizePath(f.run.session_dir, reviewer.config.instance_id));
		unlinkSync(join(f.run.session_dir, `${reviewer.config.instance_id}.1.transition.json`));
		const p = resultPath(f.run.session_dir, `${reviewer.config.instance_id}.1`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
		reviewer.vanish();
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
	}

	// m12: reviewRoutes error on finalized sink reviewer keeps pending and handoff error rather than settling routes.
	{
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0, agents: [{ ...chain.agents[0] }, review] });
		const builder = f.nodes.get("n1")!;
		const reviewer = f.nodes.get("n2")!;
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "revise" } });
		await builder.deliverNotification(reviewer);
		await builder.complete(success);
		await reviewer.deliverNotification(builder);
		await reviewer.complete({ ...success, outputs: { verdict: "revise" } });
		const p = resultPath(f.run.session_dir, `${reviewer.config.instance_id}.2`);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
		writeFileSync(join(f.run.session_dir, `${reviewer.config.instance_id}.3.revision.json`), "{not json");
		reviewer.vanish();
		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.ok(status.pending.includes("n2"));
		assert.ok(status.worker_errors.some(err => /process exited during chain handoff/.test(err)));
	}
});

test("chain on_success rejects mismatched source attempt claim (C2) and missing claim (m22), and closed tab counts as exited (m06)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	// C2: chain on_success with pending or failed delivery and claim naming another source attempt fails closed naming the file.
	for (const delivery of ["pending", "failed"] as const) {
		await t.test(`C2 chain ${delivery} wrong source attempt`, async () => {
			const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
			const first = f.nodes.get("n1")!;
			const second = f.nodes.get("n2")!;
			await first.complete(success);
			await second.deliverNotification(first);
			await second.complete(success);
			const p = resultPath(f.run.session_dir, first.config.instance_id);
			atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery, ...(delivery === "failed" ? { delivery_error: "send failed" } : {}) });
			first.vanish();
			second.vanish();
			const cp = handoffClaimPath(f.run.session_dir, second.config.instance_id);
			const claim = readJson<any>(cp);
			atomicJson(cp, { ...claim, source: { ...claim.source, attempt_id: `${first.config.instance_id}.2` } });

			const status = await f.service.statusWithCleanup(f.run.task_id);
			assert.equal(status.manifest.status, "applied");
			assert.equal(status.manifest.cleanup_trigger, undefined);
			assert.ok(status.agents.every(a => a.resource === "released"));
			assert.ok(status.cleanup_wait_reason?.includes(cp));
			assert.match(status.cleanup_wait_reason ?? "", /names source a1-n1\.2 instead of a1-n1\.1/);
		});
	}

	// m22: chain on_success with n1 pending/exited and n2 succeeded without a claim file fails closed without saying "waiting".
	await t.test("chain on_success missing claim with finished successor", async () => {
		const f = await runFixture(t, { ...chain, cleanup: "on_success", cleanup_settle_ms: 0 });
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const p = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending" });
		first.vanish();
		await second.deliverNotification(first);
		await second.complete(success);
		second.vanish();
		unlinkSync(handoffClaimPath(f.run.session_dir, second.config.instance_id));

		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.manifest.status, "applied");
		assert.equal(status.manifest.cleanup_trigger, undefined);
		assert.deepEqual(status.worker_errors, []);
		assert.deepEqual(status.delivery_errors, []);
		assert.deepEqual(status.pending, []);
		assert.equal(status.outcome.state, "succeeded");
		assert.equal(status.outcome.terminal, true);
		assert.match(status.cleanup_wait_reason ?? "", /n1 handoff to n2 has not settled; resolve with bootstrap_recover or bootstrap_cleanup/);
		assert.doesNotMatch(status.cleanup_wait_reason ?? "", /\bwaiting\b/i);
	});

	// m06: entry.status === "closed" counts as exited even if ready.json still records a live pid.
	await t.test("subset-closed pending agent counts as exited for automatic cleanup", async () => {
		const f = await runFixture(t, {
			...chain,
			topology: "graph",
			cleanup_settle_ms: 0,
			agents: [{ ...chain.agents[0] }, { ...chain.agents[1], depends_on: ["n1"] }],
		});
		const first = f.nodes.get("n1")!;
		const second = f.nodes.get("n2")!;
		await first.complete(success);
		const p = resultPath(f.run.session_dir, first.config.instance_id);
		atomicJson(p, { ...readJson<WorkerCompletion>(p), delivery: "pending", edge_deliveries: undefined });
		await second.deliverNotification(first);
		await second.complete(success);
		second.vanish();
		await f.service.cleanup(f.run.task_id, undefined, false, f.cwd, undefined, ["n1"]);
		const r1 = readyPath(f.run.session_dir, first.config.instance_id);
		atomicJson(r1, { ...readJson<any>(r1), pid: process.pid });

		const status = await f.service.statusWithCleanup(f.run.task_id);
		assert.equal(status.manifest.status, "cleaned");
		assert.equal(status.manifest.cleanup_trigger, "auto");
		assert.ok(status.agents.every(a => a.resource === "closed"));
	});
});
