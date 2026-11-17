import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, completionRecord, dispositionPath, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import { cancelPath, claimOutcome, runCancelPath } from "./cancellation.ts";
import { buildMarkdownReport } from "./reporting.ts";

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-cancel-svc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second", "third"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	}
	const calls: string[][] = [];
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
	const signals: Array<{ instance_id: string; file_existed_before_signal: boolean }> = [];
	let clock = 1_700_000_000_000;
	let sequence = 0;
	const behavior = {
		acknowledge: true,
		snapshot: false,
		failClose: false,
		extraPaneOnTab: undefined as string | undefined,
		replaceTerminalOnTab: undefined as string | undefined,
	};
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		calls.push(args);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			sequence++;
			const tab = { tab_id: `t${sequence}`, pane_id: `p${sequence}`, terminal_id: `term${sequence}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(t => t.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			if (behavior.acknowledge) {
				const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
				atomicJson(readyPath(sessionDir, instance), ready);
				const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
				mkdirSync(registryDir, { recursive: true });
				atomicJson(join(registryDir, `${instance}.json`), ready);
			}
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot" && behavior.snapshot) {
			const panes = [...tabs, ...(behavior.extraPaneOnTab ? [{ tab_id: behavior.extraPaneOnTab, pane_id: "p-user", terminal_id: "term-user" }] : [])];
			return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes, layouts: [], agents: [] });
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") {
			const mapped = tabs.map(t => t.tab_id === behavior.replaceTerminalOnTab ? { ...t, terminal_id: "foreign-term" } : t);
			const panes = [...mapped, ...(behavior.extraPaneOnTab ? [{ tab_id: behavior.extraPaneOnTab, pane_id: "p-user", terminal_id: "term-user" }] : [])];
			return ok({ panes });
		}
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") {
			if (behavior.failClose) return { code: 1, stdout: "", stderr: "close failed" };
			const index = tabs.findIndex(t => (args[0] === "pane" ? t.pane_id : t.tab_id) === args[2]);
			assert.notEqual(index, -1);
			tabs.splice(index, 1);
			tabs.forEach((t, i) => { t.tab_id = `t${i + 1}`; t.pane_id = `p${i + 1}`; });
			return ok();
		}
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	const options = {
		exec,
		extensionDir,
		stateDir,
		home,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		pollMs: 5,
		statusPollMs: 10,
		now: () => clock,
		signalWorker: async (manifest: { session_dir: string }, entry: { instance_id: string }) => {
			signals.push({
				instance_id: entry.instance_id,
				file_existed_before_signal: existsSync(cancelPath(manifest.session_dir, entry.instance_id)),
			});
		},
	};
	const service = new BootstrapService(options);
	const base = { task: "Test cancel", project_cwd: cwd, ready_timeout_ms: 100 };
	const chain = (extra: Array<Record<string, unknown>> = [{}, {}, {}]): GenerateRequest => ({
		...base,
		topology: "chain",
		agents: ["first", "second", "third"].map((name, i) => ({ node_id: `n${i + 1}`, persona: name, sub_task: `${name} task`, ...extra[i] })),
	});
	const team = (extra: Array<Record<string, unknown>> = [{}, {}]): GenerateRequest => ({
		...base,
		topology: "team",
		agents: ["first", "second"].map((name, i) => ({ node_id: `n${i + 1}`, persona: name, sub_task: `${name} task`, ...extra[i] })),
	});
	return {
		root, cwd, options, service, chain, team, calls, tabs, configs, signals, behavior,
		get now() { return clock; },
		advance: (ms: number) => { clock += ms; },
	};
}

test("whole-run cancel persists intent before signalling, leaves tabs and files untouched, and reports cancelled state", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.team());
	assert.equal(f.tabs.length, 2);

	const res = await f.service.cancel(run.task_id, { reason: "User stopped run" });
	assert.equal(res.scope, "run");
	assert.deepEqual(res.cancelled, ["n1", "n2"]);
	assert.deepEqual(res.force_closed, []);
	assert.match(res.limitations, /cannot undo.*tool side effect/i);

	// Cancellation intent persisted BEFORE signalling workers.
	assert.ok(existsSync(runCancelPath(run.session_dir)));
	assert.equal(f.signals.length, 2);
	assert.ok(f.signals.every(s => s.file_existed_before_signal), "cancel file must exist before worker signal");

	// Tabs and session files remain separate and intact!
	assert.equal(f.tabs.length, 2, "cancellation must not close tabs");
	assert.equal(existsSync(run.session_dir), true, "cancellation must not delete session files");

	// Status & report reflect cancelled execution state.
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => [a.node_id, a.execution, a.resource]), [["n1", "cancelled", "released"], ["n2", "cancelled", "released"]]);
	assert.equal(status.outcome.state, "cancelled");
	assert.deepEqual(status.pending, []);

	// Dispatcher restart: a fresh BootstrapService reads durable state and writes report cleanly.
	const restarted = new BootstrapService(f.options);
	const rep = await restarted.report(run.task_id, undefined, true, buildMarkdownReport);
	assert.deepEqual(rep.results.map(r => [r.node_id, r.status]), [["n1", "cancelled"], ["n2", "cancelled"]]);
	assert.match(readFileSync(rep.report_md!, "utf8"), /run outcome: cancelled/);
});

test("selective node cancel in a chain marks downstream dependents blocked and preserves unrelated team peers", async t => {
	const f = fixture(t);
	const chainRun = await f.service.generate(f.chain());

	// Cancel only n1 in n1 -> n2 -> n3 chain.
	const res = await f.service.cancel(chainRun.task_id, { agents: ["n1"], reason: "No longer needed" });
	assert.equal(res.scope, "node");
	assert.deepEqual(res.cancelled, ["n1"]);
	assert.deepEqual(res.blocked_dependents.map(d => [d.node_id, d.blocked_by]), [["n2", "n1"], ["n3", "n2"]]);

	const status = f.service.status(chainRun.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["cancelled", "blocked", "blocked"]);
	assert.deepEqual(status.agents[2].execution_causes.map(c => [c.node_id, c.state]), [["n2", "blocked"], ["n1", "cancelled"]]);
	assert.equal(existsSync(cancelPath(chainRun.session_dir, "a2-n2")), false, "downstream nodes are blocked, not directly cancelled");

	// Team selective cancel leaves the other member running.
	const teamRun = await f.service.generate(f.team());
	await f.service.cancel(teamRun.task_id, { agents: ["n1"] });
	const teamStatus = f.service.status(teamRun.task_id);
	assert.deepEqual(teamStatus.agents.map(a => [a.node_id, a.execution]), [["n1", "cancelled"], ["n2", "pending"]]);
	assert.deepEqual(teamStatus.pending, ["n2"]);
});

test("cancel rejects unknown or ambiguous selectors without writing any cancel record", async t => {
	const f = fixture(t);
	const run = await f.service.generate({
		task: "Shared persona team",
		topology: "team",
		project_cwd: f.cwd,
		ready_timeout_ms: 100,
		agents: [
			{ node_id: "rev-a", persona: "first", sub_task: "A" },
			{ node_id: "rev-b", persona: "first", sub_task: "B" },
		],
	});
	await assert.rejects(f.service.cancel(run.task_id, { agents: ["first"] }), /Ambiguous agent selector/);
	await assert.rejects(f.service.cancel(run.task_id, { agents: ["missing"] }), /Unknown agent/);
	await assert.rejects(f.service.cancel(run.task_id, { agents: [] }), /must not be empty/);
	assert.equal(existsSync(runCancelPath(run.session_dir)), false);
	assert.equal(existsSync(cancelPath(run.session_dir, "a1-rev-a")), false);
	assert.equal(existsSync(cancelPath(run.session_dir, "a2-rev-b")), false);
});

test("cancel before release aborts launch, avoids release.json, and marks nodes cancelled instead of needs_attention", async t => {
	const f = fixture(t);
	f.behavior.acknowledge = false;
	let taskId = "";
	const launching = f.service.generate({ ...f.team(), ready_timeout_ms: 5000 }, undefined, undefined, manifest => {
		taskId = manifest.task_id;
		if (manifest.phase === "waiting-ready") {
			void f.service.cancel(taskId, { reason: "Cancelled during startup" });
		}
	});
	const run = await launching;
	assert.equal(run.phase, "cancelled");
	assert.equal(existsSync(join(run.session_dir, "release.json")), false);
	assert.ok(existsSync(join(run.session_dir, "abort.json")));
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["cancelled", "cancelled"]);
	assert.equal(status.outcome.state, "cancelled");
});

test("already-completed results are preserved on cancel, and completed outcome claims beat concurrent cancel", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.chain());
	// n1 committed its result before cancel.
	atomicJson(resultPath(run.session_dir, f.configs[0].instance_id), completionRecord(f.configs[0], { agent_name: "first", status: "success", summary: "n1 finished", detail: "" }, "sent", new Date(f.now).toISOString()));
	// n2 won outcome claim simultaneously with cancel and wrote its result.
	const n2Id = { run_id: run.task_id, node_id: "n2", persona_name: "second", attempt_id: f.configs[1].attempt_id, instance_id: f.configs[1].instance_id };
	assert.equal(claimOutcome(run.session_dir, n2Id, "completed", new Date(f.now).toISOString()).won, true);
	atomicJson(resultPath(run.session_dir, f.configs[1].instance_id), completionRecord(f.configs[1], { agent_name: "second", status: "partial", summary: "n2 finished", detail: "" }, "sent", new Date(f.now).toISOString()));

	const res = await f.service.cancel(run.task_id, { reason: "Stop remaining" });
	assert.deepEqual(res.already_completed, ["n1", "n2"]);
	assert.deepEqual(res.cancelled, ["n3"]);
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["succeeded", "partial", "cancelled"]);
	assert.equal(status.results.length, 2);
});

test("in-flight work stays cancelling until settled or force-closed after the grace period, scoped to verified owned resources", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.chain());
	// n1 is actively running tool work; n2 and n3 are waiting.
	atomicJson(join(run.session_dir, "a1-n1.progress.json"), {
		token: run.token, updated_at: f.now, activity_at: f.now, started_at: f.now - 1000, state: "working",
	});

	// Cannot force-close before cancel is requested.
	await assert.rejects(f.service.cancel(run.task_id, { agents: ["n1"], force_close: true }), /cancellation must be requested first/);

	const cancelled = await f.service.cancel(run.task_id, { agents: ["n1"], reason: "User abort", grace_ms: 5000 });
	assert.deepEqual(cancelled.cancelled, []);
	assert.equal(cancelled.cancelling.length, 1);
	assert.equal(cancelled.cancelling[0].node_id, "n1");
	assert.equal(cancelled.cancelling[0].grace_remaining_ms, 5000);
	assert.equal(cancelled.cancelling[0].force_close_allowed, false);
	assert.deepEqual(cancelled.blocked_dependents.map(d => d.node_id), ["n2", "n3"], "warns which downstream tasks will not run");
	assert.equal(existsSync(dispositionPath(run.session_dir, "a2-n2")), false, "downstream nodes are not prematurely disposed while n1 might still commit");

	// Status shows cancelling state and grace remaining.
	let status = f.service.status(run.task_id);
	assert.equal(status.agents[0].execution, "running");
	assert.equal(status.agents[0].cancelling, true);
	assert.equal(status.agents[0].grace_remaining_ms, 5000);
	assert.equal(status.agents[0].force_close_allowed, false);

	// Grace period not elapsed yet -> force_close rejected.
	f.advance(4999);
	await assert.rejects(f.service.cancel(run.task_id, { agents: ["n1"], force_close: true }), /grace period elapses \(1ms remaining\)/);

	// Advance past grace period; user added an unrelated pane to n1's tab so only n1's pane should close.
	f.advance(1);
	f.behavior.extraPaneOnTab = f.tabs[0].tab_id;
	status = f.service.status(run.task_id);
	assert.equal(status.agents[0].grace_remaining_ms, 0);
	assert.equal(status.agents[0].force_close_allowed, true);

	const forced = await f.service.cancel(run.task_id, { agents: ["n1"], force_close: true });
	assert.deepEqual(forced.force_closed, ["n1"]);
	assert.deepEqual(forced.cleanup_errors, []);
	// Verify pane close was issued (not tab close) because user added another pane, and n2/n3 tabs stayed open!
	assert.ok(f.calls.some(c => c[0] === "pane" && c[1] === "close" && c[2] === "p1"));
	assert.equal(f.tabs.length, 2, "only n1's owned pane closed; n2 and n3 remain open");
	assert.equal(existsSync(run.session_dir), true, "session files remain retained after force_close");

	status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["cancelled", "blocked", "blocked"]);
	assert.match(status.agents[0].execution_reason!, /in-flight tool side effects could not be undone/);
	assert.equal(status.agents[0].resource, "closed");

	// Replaced terminal ownership mismatch blocks force_close for n2 without touching foreign terminal.
	f.advance(10_000);
	await f.service.cancel(run.task_id, { agents: ["n2"], grace_ms: 0 });
	// Simulate n2 working, cancelled, then tab terminal replaced before force_close:
	const run2 = await f.service.generate(f.team());
	atomicJson(join(run2.session_dir, "a1-n1.progress.json"), { token: run2.token, updated_at: f.now, activity_at: f.now, state: "working" });
	await f.service.cancel(run2.task_id, { agents: ["n1"], grace_ms: 1000 });
	f.advance(1000);
	f.behavior.extraPaneOnTab = undefined;
	f.behavior.replaceTerminalOnTab = f.tabs[f.tabs.length - 2].tab_id;
	const mismatch = await f.service.cancel(run2.task_id, { agents: ["n1"], force_close: true });
	assert.match(mismatch.cleanup_errors[0], /Terminal ownership mismatch/);
});

test("configurable deadlines and liveness checks validate, preview, persist, and diagnose independently", async t => {
	const f = fixture(t);
	// Validation rejects invalid deadlines and dependency_wait_timeout_ms on teams or first chain node.
	await assert.rejects(f.service.generate({ ...f.team(), task_timeout_ms: 50 }), /task_timeout_ms/);
	await assert.rejects(f.service.generate({ ...f.team([{ dependency_wait_timeout_ms: 1000 }, {}]) }), /Team agents cannot declare a dependency wait/);
	await assert.rejects(f.service.generate({ ...f.chain([{ dependency_wait_timeout_ms: 1000 }, {}, {}]) }), /first step.*cannot declare a dependency wait/);

	// Omitted deadlines preserve legacy/existing fingerprint compatibility.
	const reqBase = f.chain();
	await f.service.generate({ ...reqBase, request_id: "compat-deadlines" });
	await assert.rejects(
		f.service.generate({ ...reqBase, request_id: "compat-deadlines", task_timeout_ms: 10_000 }),
		/different bootstrap plan/,
	);

	// Plan preview and persisted manifest/configs carry run and per-node overrides.
	const plan = f.service.plan({
		...f.chain([{}, { task_timeout_ms: 4000, dependency_wait_timeout_ms: 2000 }, {}]),
		task_timeout_ms: 9000,
		dependency_wait_timeout_ms: 5000,
		liveness_timeout_ms: 3000,
		cancel_grace_ms: 1500,
	});
	assert.equal((plan as any).task_timeout_ms, 9000);
	assert.equal((plan as any).liveness_timeout_ms, 3000);
	assert.equal((plan.agents[1] as any).task_timeout_ms, 4000);
	assert.equal((plan.agents[1] as any).dependency_wait_timeout_ms, 2000);

	const run = await f.service.generate({
		...f.chain([{}, { task_timeout_ms: 4000, dependency_wait_timeout_ms: 2000 }, {}]),
		task_timeout_ms: 9000,
		dependency_wait_timeout_ms: 5000,
		liveness_timeout_ms: 3000,
		cancel_grace_ms: 1500,
		request_id: "deadlines-run",
	});
	const latestConfigs = f.configs.slice(-3);
	assert.equal(latestConfigs[0].task_timeout_ms, 9000);
	assert.equal(latestConfigs[1].task_timeout_ms, 4000);
	assert.equal(latestConfigs[1].dependency_wait_timeout_ms, 2000);
	assert.equal(latestConfigs[2].dependency_wait_timeout_ms, 5000);

	// Liveness diagnosis: live heartbeat with stale activity -> stalled, without auto-killing!
	atomicJson(join(run.session_dir, "a1-n1.progress.json"), {
		token: run.token, updated_at: f.now, activity_at: f.now - 3500, started_at: f.now - 4000, state: "working",
	});
	let status = f.service.status(run.task_id);
	assert.equal(status.agents[0].liveness, "stalled");
	assert.equal(status.agents[0].execution, "running", "liveness is diagnostic only and never kills");
	assert.equal(status.agents[0].deadline_exceeded, false);

	// Advancing fake time past task_timeout_ms (9000ms) surfaces deadline_exceeded and waitForStatus enforces it.
	f.advance(6000);
	atomicJson(join(run.session_dir, "a1-n1.progress.json"), {
		token: run.token, updated_at: f.now, activity_at: f.now, started_at: f.now - 10_000, state: "working",
	});
	status = f.service.status(run.task_id);
	assert.equal(status.agents[0].liveness, "healthy");
	assert.equal(status.agents[0].deadline_exceeded, true);

	const settled = await f.service.waitForStatus(run.task_id, 50);
	assert.equal(settled.agents[0].cancelling, true);
	assert.ok(existsSync(cancelPath(run.session_dir, "a1-n1")));
});
