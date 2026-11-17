import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, launchCommand, normalizeAgents, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { MODEL_ALIASES, modelMatches, resolveModel } from "./model-utils.ts";
import { atomicJson, lockHeld, processAlive, publishExclusive, readJson, readyPath, resultPath, withRunLock, type WorkerConfig } from "./session-store.ts";
import { buildMarkdownReport, formatAgentStates, formatLaunch, formatPlan, formatReportDigest, formatRunList } from "./reporting.ts";

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }
function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project ' $ space");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	const argsFile = join(root, "pi-args.json");
	writeFileSync(join(bin, "pi"), `#!/usr/bin/node\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second"]) writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	const calls: string[][] = [];
	const tabs: FakeTab[] = [];
	let sequence = 0;
	const behavior = { failCreate: 0, malformedCreate: 0, failRun: false, failClose: false, acknowledge: true, runLauncher: false, snapshot: false, afterCreate: undefined as ((tab: FakeTab) => void) | undefined, holdCreate: undefined as (() => Promise<void>) | undefined };
	const configs: WorkerConfig[] = [];
	const exec = async (_command: string, args: string[], options: { signal?: AbortSignal }): Promise<ExecResult> => {
		calls.push(args);
		assert.ok(!options.signal?.aborted);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			sequence++;
			await behavior.holdCreate?.();
			const tab = { tab_id: `t${sequence}`, pane_id: `p${sequence}`, terminal_id: `term${sequence}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			behavior.afterCreate?.(tab);
			assert.equal(args[args.indexOf("--workspace") + 1], "origin-workspace");
			assert.ok(args.includes("PI_COMS_TIMEOUT_MS=300000"));
			if (behavior.failCreate === sequence) return { code: 1, stdout: "", stderr: "create timed out after side effect", killed: true };
			if (behavior.malformedCreate === sequence) return ok({ tab: { tab_id: tab.tab_id } });
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			if (behavior.failRun) return { code: 1, stdout: "", stderr: "pane rejected command" };
			const tab = tabs.find(tab => tab.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			assert.equal(existsSync(join(sessionDir, "release.json")), false, "work must not be released during launch submission");
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			if (behavior.runLauncher) execFileSync("/bin/sh", [join(sessionDir, `${instance}.sh`)]);
			if (behavior.acknowledge) {
				const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
				atomicJson(readyPath(sessionDir, instance), ready);
				const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
				mkdirSync(registryDir, { recursive: true });
				atomicJson(join(registryDir, `${instance}.json`), ready);
			}
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot" && behavior.snapshot) return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs, layouts: [], agents: [] });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") {
			if (behavior.failClose) return { code: 1, stdout: "", stderr: "close failed" };
			const index = tabs.findIndex(tab => (args[0] === "pane" ? tab.pane_id : tab.tab_id) === args[2]);
			assert.notEqual(index, -1);
			tabs.splice(index, 1);
			// Simulate compacting public IDs after a close.
			tabs.forEach((tab, i) => { tab.tab_id = `t${i + 1}`; tab.pane_id = `p${i + 1}`; });
			return ok();
		}
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	const options = { exec, extensionDir, stateDir, home, env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller", HERDR_WORKSPACE_ID: "stale-focused-workspace" }, pollMs: 5 };
	const service = new BootstrapService(options);
	const request: GenerateRequest = { task: "Test launch", topology: "team", project_cwd: cwd, agents: [{ name: "first", sub_task: "First task" }, { name: "second", sub_task: "Second task" }], ready_timeout_ms: 100 };
	return { root, cwd, home, argsFile, options, service, request, calls, tabs, behavior, configs };
}

test("preflight rejects an empty run before creating session files or tabs", async t => {
	const f = fixture(t);
	await assert.rejects(f.service.generate({ ...f.request, agents: [] }), /between 1 and 32/);
	assert.equal(f.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
});

test("preflight validates duplicate names, topology and dependencies before launch", async t => {
	const f = fixture(t);
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ name: "first", sub_task: "a" }, { name: "FIRST", sub_task: "b" }] }), /Duplicate/);
	await assert.rejects(f.service.generate({ ...f.request, topology: "chain", agents: [{ name: "first", sub_task: "a", step: 2 }] }), /contiguous/);
	await assert.rejects(f.service.generate({ ...f.request, topology: "chain", agents: [{ name: "first", sub_task: "a", successor: "missing" }, { name: "second", sub_task: "b" }] }), /Invalid successor/);
	rmSync(join(f.cwd, "extensions", "coms.ts"));
	await assert.rejects(f.service.generate({ ...f.request, coms_extension: join(f.root, "missing-coms.ts") }), /Required Coms extension not found/);
	assert.equal(f.calls.length, 0);
});

test("launch uses the originating workspace and releases only after every child is ready", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request, { provider: "provider", id: "model" });
	assert.equal(run.status, "applied");
	assert.ok(run.pane_manifest.every(entry => entry.status === "released"));
	assert.ok(existsSync(join(run.session_dir, "release.json")));
	assert.equal(f.service.status(run.task_id).pending.length, 2);
	assert.equal(f.configs[0].persona, "Exact persona first");
	assert.ok(f.configs.every(config => config.coms_project === `boot-${run.task_id}`));
});

test("launchers keep task metacharacters out of CLI parsing and preserve quoted paths", async t => {
	const f = fixture(t);
	f.behavior.runLauncher = true;
	const marker = join(f.root, "SHOULD_NOT_EXIST");
	const task = `Explain $(touch ${marker}) and \`touch ${marker}\` and $HOME\n'quoted' "double" \\`;
	const run = await f.service.generate({ ...f.request, agents: [{ name: "first", sub_task: task }] });
	assert.equal(run.status, "applied");
	const args = readJson<string[]>(f.argsFile);
	assert.equal(args[args.indexOf("--purpose") + 1], `Bootstrap ${run.task_id}: first`);
	assert.equal(f.configs[0].sub_task, task);
	assert.ok(!args.includes(task), "arbitrary task text stays out of CLI parsing");
	assert.equal(args[args.indexOf("--bootstrap-worker-config") + 1], join(run.session_dir, "a1-first.config.json"));
	assert.equal(existsSync(marker), false);
	assert.equal(f.calls.find(args => args[1] === "run")!.length, 4);
});

test("chain order derives safe instance links and explicit follower startup messages", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, topology: "chain", agents: [{ name: "second", sub_task: "b", step: 2 }, { name: "first", sub_task: "a", step: 1 }] });
	assert.equal(run.status, "applied");
	assert.deepEqual(run.pane_manifest.map(entry => entry.agent_name), ["first", "second"]);
	assert.equal(f.configs[0].successor, "a2-second");
	assert.equal(f.configs[1].predecessor, "a1-first");
	assert.ok(f.configs.every(config => config.startup_message.startsWith("bootstrap-start:")));
});

test("second-agent create timeout retains partial progress and supports reconciliation cleanup", async t => {
	const f = fixture(t);
	f.behavior.failCreate = 2;
	const run = await f.service.generate(f.request);
	assert.equal(run.status, "error");
	assert.equal(run.pane_manifest.length, 2);
	assert.equal(run.pane_manifest[0].status, "launch_submitted");
	assert.equal(run.pane_manifest[1].status, "creating");
	assert.equal(existsSync(join(run.session_dir, "release.json")), false);
	assert.ok(existsSync(join(run.session_dir, "abort.json")));
	assert.equal(f.service.store.load(run.task_id).pane_manifest[0].tab_id, "t1");
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(f.tabs.length, 0);
});

test("malformed create responses never issue pane run with unknown identifiers", async t => {
	const f = fixture(t);
	f.behavior.malformedCreate = 1;
	const run = await f.service.generate(f.request);
	assert.equal(run.status, "error");
	assert.match(run.error!, /pane_id/);
	assert.equal(f.calls.filter(args => args[1] === "run").length, 0);
	assert.equal(run.pane_manifest[0].tab_id, "t1");
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
});

test("pane-run failure keeps the newly created tab recoverable", async t => {
	const f = fixture(t);
	f.behavior.failRun = true;
	const run = await f.service.generate(f.request);
	assert.equal(run.status, "error");
	assert.equal(run.pane_manifest[0].status, "tab_created");
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
});

test("readiness timeout and cancellation preserve state without releasing work", async t => {
	const f = fixture(t);
	f.behavior.acknowledge = false;
	const timeout = await f.service.generate(f.request);
	assert.match(timeout.error!, /Readiness timeout/);
	assert.equal(existsSync(join(timeout.session_dir, "release.json")), false);
	const controller = new AbortController();
	const pending = f.service.generate({ ...f.request, ready_timeout_ms: 5000 }, undefined, controller.signal, manifest => {
		if (manifest.phase === "waiting-ready") controller.abort();
	});
	const cancelled = await pending;
	assert.equal(cancelled.phase, "cancelled");
	assert.equal(existsSync(join(cancelled.session_dir, "release.json")), false);
});

test("idempotent retries return the same fleet, including from a fresh service instance", async t => {
	const f = fixture(t);
	const request = { ...f.request, request_id: "retry-key" };
	const [first, second] = await Promise.all([f.service.generate(request), f.service.generate(request)]);
	assert.equal(first.task_id, second.task_id);
	assert.equal(f.tabs.length, 2);
	const restarted = new BootstrapService(f.options);
	assert.equal((await restarted.generate(request)).task_id, first.task_id);
	await assert.rejects(restarted.generate({ ...request, task: "different task" }), /different bootstrap plan/);
	assert.equal(f.tabs.length, 2);
});

test("reports resolve the recorded project from any dispatcher cwd and collect worker files", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport, "/elsewhere"), /not complete/);
	for (const entry of run.pane_manifest) atomicJson(resultPath(run.session_dir, entry.instance_id), {
		result: { agent_name: entry.agent_name, status: "success", summary: "Done", detail: "Validated" }, delivery: "not_required", completed_at: new Date().toISOString(),
	});
	const paths = await new BootstrapService(f.options).report(run.task_id, undefined, true, buildMarkdownReport, "/elsewhere");
	assert.equal(readJson<unknown[]>(paths.report_json).length, 2);
	assert.match(readFileSync(paths.report_md!, "utf8"), /2 success, 0 partial, 0 failure/);
	await assert.rejects(f.service.report(run.task_id, [{ agent_name: "unknown", status: "success", summary: "x", detail: "" }], false, buildMarkdownReport), /Unknown/);
});

test("cleanup refuses unrelated tabs and follows owned labels through ID compaction", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	await assert.rejects(f.service.cleanup(run.task_id, ["unrelated"]), /not owned/);
	assert.equal(f.tabs.length, 2);
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(f.tabs.length, 0);
	assert.ok(existsSync(run.session_dir));
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
});

test("cleanup failures retain manifests and reports for a successful retry", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	writeFileSync(join(run.session_dir, "report.json"), "[]");
	f.behavior.failClose = true;
	const failed = await f.service.cleanup(run.task_id, undefined, true);
	assert.equal(failed.status, "error");
	assert.equal(failed.session_dir_removed, undefined);
	assert.ok(existsSync(join(run.session_dir, "report.json")));
	f.behavior.failClose = false;
	const cleaned = await f.service.cleanup(run.task_id, undefined, true);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(cleaned.session_dir_removed, true);
	assert.equal(existsSync(run.session_dir), false);
	assert.equal((await new BootstrapService(f.options).cleanup(run.task_id, undefined, true)).status, "cleaned");
});

test("cleanup refuses a replaced terminal even when its tab label matches", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	f.tabs[0].terminal_id = "replacement-terminal";
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "error");
	assert.ok(cleaned.cleanup_errors?.some(error => error.includes("ownership mismatch")));
	assert.equal(f.tabs.length, 1);
});

test("session traversal and symlink substitution are rejected", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	assert.throws(() => f.service.status("../outside"), /Invalid bootstrap task_id/);
	const target = join(f.root, "outside");
	mkdirSync(target);
	rmSync(run.session_dir, { recursive: true });
	symlinkSync(target, run.session_dir);
	await assert.rejects(f.service.cleanup(run.task_id, undefined, true), /symlinked/);
	assert.ok(existsSync(target));
});

test("cleanup tracks renamed terminals without closing their surrounding tab blindly", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	f.tabs[0].label = "user renamed this tab";
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
	assert.ok(f.calls.some(args => args[0] === "pane" && args[1] === "close" && args[2] === "p1"));
	assert.equal(f.tabs.length, 0);
});

test("recovery index permits cleanup after project session files disappear", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	rmSync(run.session_dir, { recursive: true });
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(cleaned.session_dir_removed, true);
	assert.equal(f.tabs.length, 0);
});

test("a persistence failure after tab creation still returns its partial manifest", async t => {
	const f = fixture(t);
	f.behavior.afterCreate = tab => {
		const taskId = tab.label.split(":")[0];
		rmSync(join(f.cwd, ".pi", "agent-sessions", taskId), { recursive: true });
	};
	const run = await f.service.generate(f.request);
	assert.equal(run.status, "error");
	assert.equal(run.pane_manifest[0].terminal_id, "term1");
	assert.match(run.error!, /persistence failed/);
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
});

test("readiness acknowledgements must match the planned model and run token", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request, undefined, undefined, manifest => {
		if (manifest.phase !== "waiting-ready") return;
		const entry = manifest.pane_manifest[0];
		const path = readyPath(manifest.session_dir, entry.instance_id);
		const ready = readJson<any>(path);
		atomicJson(path, { ...ready, model: "unexpected/model", token: "wrong-token" });
	});
	assert.equal(run.status, "error");
	assert.match(run.error!, /Invalid readiness/);
	assert.equal(existsSync(join(run.session_dir, "release.json")), false);
});

test("pending deliveries and unexpected worker exits are visible and block automatic reports", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	for (const entry of run.pane_manifest) atomicJson(resultPath(run.session_dir, entry.instance_id), {
		result: { agent_name: entry.agent_name, status: "success", summary: "Done", detail: "" }, delivery: "pending", completed_at: new Date().toISOString(),
	});
	atomicJson(join(run.session_dir, `${run.pane_manifest[0].instance_id}.error.json`), { error: "worker exited" });
	const status = f.service.status(run.task_id);
	assert.equal(status.pending.length, 2);
	assert.match(status.worker_errors[0], /worker exited/);
	await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /not complete/);
});

test("unknown explicit model aliases fail before creating tabs", async t => {
	const f = fixture(t);
	writeFileSync(join(f.cwd, ".pi", "agents", "first.md"), "---\nname: first\nmodel: typo-model\n---\nPersona");
	await assert.rejects(f.service.generate(f.request), /Unknown model alias/);
	assert.equal(f.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
});

test("markdown reports replace leaf symlinks without overwriting their targets", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const unrelated = join(f.root, "unrelated.md");
	writeFileSync(unrelated, "Do not overwrite");
	symlinkSync(unrelated, join(run.session_dir, "report.md"));
	const results = run.pane_manifest.map(entry => ({ agent_name: entry.agent_name, status: "success" as const, summary: "Done", detail: "" }));
	await f.service.report(run.task_id, results, true, buildMarkdownReport);
	assert.equal(readFileSync(unrelated, "utf8"), "Do not overwrite");
	assert.match(readFileSync(join(run.session_dir, "report.md"), "utf8"), /Bootstrap Results/);
});

test("worker Coms identities are revalidated immediately before releasing work", async t => {
	const f = fixture(t);
	let invalidated = false;
	const run = await f.service.generate(f.request, undefined, undefined, manifest => {
		if (invalidated || manifest.phase !== "waiting-ready" || !manifest.pane_manifest.every(entry => entry.status === "ready")) return;
		invalidated = true;
		const entry = manifest.pane_manifest[0];
		const path = join(f.home, ".pi", "coms", "projects", manifest.coms_project, "agents", `${entry.instance_id}.json`);
		const record = readJson<any>(path);
		atomicJson(path, { ...record, session_id: "replacement-session" });
	});
	assert.equal(run.status, "error");
	assert.match(run.error!, /identity changed before release/);
	assert.equal(existsSync(join(run.session_dir, "release.json")), false);
});

test("status detects abrupt worker death even when no shutdown hook could write an error", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const entry = run.pane_manifest[0];
	const path = readyPath(run.session_dir, entry.instance_id);
	const ready = readJson<any>(path);
	atomicJson(path, { ...ready, pid: 2147483647 });
	assert.ok(f.service.status(run.task_id).worker_errors.some(error => error.includes("process exited")));
});

test("chain ends may be named dispatcher or left empty", () => {
	const agents = normalizeAgents("chain", [{ name: "first", sub_task: "a", predecessor: "dispatcher" }, { name: "second", sub_task: "b", predecessor: "FIRST", successor: "" }]);
	assert.deepEqual(agents.map(agent => [agent.predecessor, agent.successor]), [[undefined, "second"], ["first", undefined]]);
	assert.throws(() => normalizeAgents("chain", [{ name: "first", sub_task: "a", predecessor: "someone" }]), /Invalid predecessor/);
});

test("the command typed into the pane needs no shell-specific quoting", () => {
	assert.equal(launchCommand("/plain/project", "/plain/project/.pi/agent-sessions/t-1/a1-x.sh"), "/bin/sh /plain/project/.pi/agent-sessions/t-1/a1-x.sh");
	assert.equal(launchCommand("/odd 'dir\\x", "/odd 'dir\\x/.pi/agent-sessions/t-1/a1-x.sh"), "/bin/sh ./.pi/agent-sessions/t-1/a1-x.sh");
	assert.throws(() => launchCommand("/a", "/elsewhere/odd dir/x.sh"), /portably/);
});

test("model matching tolerates thinking suffixes and dated snapshots only", () => {
	assert.ok(modelMatches("anthropic/claude-opus-5-5:high", "anthropic/claude-opus-5-5"));
	assert.ok(modelMatches("anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001"));
	assert.ok(!modelMatches("anthropic/claude-opus-5", "anthropic/claude-opus-5-5"));
	assert.equal(resolveModel("Sonnet:low", undefined), "anthropic/claude-sonnet-5-5:low");
	assert.ok(Object.values(MODEL_ALIASES).every(model => !/claude-(opus|sonnet)-4-2025|claude-3-5/.test(model)), "aliases must not target retired models");
});

test("a successful subset cleanup is not a failure and does not abort the run", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const partial = await f.service.cleanup(run.task_id, [run.pane_manifest[0].tab_id!]);
	assert.equal(partial.status, "applied");
	assert.equal(partial.phase, "partially-cleaned");
	assert.deepEqual(partial.cleanup_errors, []);
	assert.equal(existsSync(join(run.session_dir, "abort.json")), false);
	assert.equal(f.tabs.length, 1);
	const full = await f.service.cleanup(run.task_id);
	assert.equal(full.status, "cleaned");
});

test("cleanup notes agents whose tabs were already gone instead of claiming a close", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	f.tabs.splice(0, f.tabs.length);
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(cleaned.cleanup_notes?.length, 2);
	assert.match(cleaned.cleanup_notes![0], /already closed/);
});

test("an undelivered handoff to a successor that already finished does not block reports", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, topology: "chain" });
	const [first, second] = run.pane_manifest;
	atomicJson(resultPath(run.session_dir, first.instance_id), { result: { agent_name: first.agent_name, status: "failure", summary: "Broke", detail: "" }, delivery: "failed", delivery_error: "receiver gone", completed_at: new Date().toISOString() });
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.agent_name, status: "failure", summary: "Upstream", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.delivery_errors, []);
	assert.deepEqual(status.pending, []);
	await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
});

test("a report without markdown removes a stale report.md", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const results = run.pane_manifest.map(entry => ({ agent_name: entry.agent_name, status: "success" as const, summary: "Done", detail: "" }));
	await f.service.report(run.task_id, results, true, buildMarkdownReport);
	assert.ok(existsSync(join(run.session_dir, "report.md")));
	const paths = await f.service.report(run.task_id, results, false, buildMarkdownReport);
	assert.equal(paths.report_md, undefined);
	assert.equal(existsSync(join(run.session_dir, "report.md")), false);
});

test("deleted and missing session files are reported distinctly", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const cleaned = await f.service.cleanup(run.task_id, undefined, true);
	assert.equal(cleaned.session_files_deleted, true);
	const other = await f.service.generate({ ...f.request, request_id: "second-run" });
	await f.service.cleanup(other.task_id);
	rmSync(other.session_dir, { recursive: true });
	const missing = await f.service.cleanup(other.task_id, undefined, true);
	assert.equal(missing.session_dir_removed, true);
	assert.notEqual(missing.session_files_deleted, true);
});

test("cleanup resolves live IDs from one Herdr snapshot and reuses it until something is closed", async t => {
	const f = fixture(t);
	f.behavior.snapshot = true;
	const run = await f.service.generate(f.request);
	f.calls.length = 0;
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(f.tabs.length, 0);
	assert.ok(!f.calls.some(args => args[1] === "list"), "per-workspace listings are not needed when the snapshot is available");
	assert.equal(f.calls.filter(args => args[0] === "api").length, 2, "one fresh snapshot per close");
	const gone = await f.service.generate({ ...f.request, request_id: "gone" });
	f.tabs.splice(0, f.tabs.length);
	f.calls.length = 0;
	await f.service.cleanup(gone.task_id);
	assert.equal(f.calls.filter(args => args[0] === "api").length, 1, "nothing was closed, so one view serves every agent");
});

test("cleanup falls back to per-workspace listings when the snapshot API is unavailable", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	f.calls.length = 0;
	assert.equal((await f.service.cleanup(run.task_id)).status, "cleaned");
	assert.equal(f.calls.filter(args => args[0] === "api").length, 1, "an unsupported snapshot is not retried for every agent");
	assert.ok(f.calls.some(args => args[0] === "pane" && args[1] === "list"));
});

test("subset cleanup selects agents by stable name or instance ID", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	await assert.rejects(f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["nobody"]), /Unknown agent/);
	await assert.rejects(f.service.cleanup(run.task_id, undefined, false, undefined, undefined, []), /must not be empty/);
	const partial = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["SECOND"]);
	assert.equal(partial.phase, "partially-cleaned");
	assert.deepEqual(partial.pane_manifest.map(entry => entry.status), ["released", "closed"]);
	assert.equal(existsSync(join(run.session_dir, "abort.json")), false);
	// Tab IDs compacted after the close (t1 survives); the instance ID still names the remaining agent.
	const full = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, [run.pane_manifest[0].instance_id]);
	assert.equal(full.status, "cleaned");
});

test("status reports per-agent state, heartbeat age and result summaries", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const [first, second] = run.pane_manifest;
	atomicJson(join(run.session_dir, `${first.instance_id}.progress.json`), { token: run.token, updated_at: Date.now() - 4000, state: "working" });
	atomicJson(join(run.session_dir, `${second.instance_id}.progress.json`), { token: "foreign", updated_at: Date.now(), state: "working" });
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.agent_name, status: "partial", summary: "Half done", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	const status = f.service.status(run.task_id);
	assert.equal(status.agents[0].state, "working");
	assert.ok(status.agents[0].heartbeat_age_ms! >= 4000);
	assert.equal(status.agents[1].state, "done");
	assert.equal(status.agents[1].heartbeat_age_ms, undefined, "a foreign token is ignored");
	const text = formatAgentStates(status.agents);
	assert.match(text, /working \(heartbeat \d+s ago\)/);
	assert.match(text, /done partial: Half done/);
	writeFileSync(join(run.session_dir, `${first.instance_id}.error.json`), "{torn");
	const torn = f.service.status(run.task_id);
	assert.equal(torn.agents[0].state, "error");
	assert.match(torn.worker_errors[0], /unreadable error record/);
});

test("waitForStatus returns as soon as the run settles, needs attention, or the wait expires", async t => {
	const f = fixture(t);
	const service = new BootstrapService({ ...f.options, statusPollMs: 5 });
	const run = await service.generate(f.request);
	const expired = await service.waitForStatus(run.task_id, 30);
	assert.equal(expired.timed_out, true);
	assert.equal(expired.pending.length, 2);
	setTimeout(() => {
		for (const entry of run.pane_manifest) atomicJson(resultPath(run.session_dir, entry.instance_id), { result: { agent_name: entry.agent_name, status: "success", summary: "Done", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	}, 20);
	const settled = await service.waitForStatus(run.task_id, 5000);
	assert.equal(settled.timed_out, false);
	assert.deepEqual(settled.pending, []);
	const other = await service.generate({ ...f.request, request_id: "attention" });
	atomicJson(join(other.session_dir, `${other.pane_manifest[0].instance_id}.error.json`), { error: "Required tool is unavailable: bash" });
	const started = Date.now();
	const attention = await service.waitForStatus(other.task_id, 5000);
	assert.ok(Date.now() - started < 1000);
	assert.equal(attention.timed_out, false);
	assert.equal(attention.worker_errors.length, 1);
	await assert.rejects(service.waitForStatus(other.task_id, -1), /wait_ms/);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 10);
	const waiting = await service.generate({ ...f.request, request_id: "abortable" });
	await assert.rejects(service.waitForStatus(waiting.task_id, 5000, undefined, controller.signal), /cancelled/);
});

test("model-facing texts carry identifiers and outcomes", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, topology: "chain" });
	const launch = formatLaunch(run);
	assert.match(launch, new RegExp(`${run.pane_manifest[0].instance_id} \\(first\\) step 1: released, tab t1`));
	const digest = formatReportDigest([{ agent_name: "first", status: "success", summary: "Fixed\nparser", detail: "", next_steps: ["ship"] }, { agent_name: "second", status: "failure", summary: "x".repeat(500), detail: "" }]);
	assert.match(digest, /^1 success, 0 partial, 1 failure\./);
	assert.match(digest, /first: success — Fixed parser \(next: ship\)/);
	assert.ok(digest.split("\n")[2].length < 300, "summaries are clipped");
});

test("session directories are private and a PID owned by another user is not our worker", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	assert.equal(statSync(run.session_dir).mode & 0o777, 0o700);
	if (process.getuid?.() !== 0) assert.equal(processAlive({ pid: 1 }), false);
});

test("an equivalent retry is the same plan regardless of key order or explicit defaults", async t => {
	const f = fixture(t);
	const first = await f.service.generate({ ...f.request, request_id: "stable" });
	const reordered = { ready_timeout_ms: 100, request_id: "stable", agents: f.request.agents.map(agent => ({ sub_task: agent.sub_task, name: agent.name.toUpperCase() })), project_cwd: f.cwd, topology: "team" as const, task: f.request.task };
	const again = await f.service.generate(reordered);
	assert.equal(again.task_id, first.task_id);
	const defaulted = await f.service.generate({ ...f.request, request_id: "defaults", ready_timeout_ms: undefined });
	assert.equal((await f.service.generate({ ...f.request, request_id: "defaults", ready_timeout_ms: 60_000 })).task_id, defaulted.task_id);
	await assert.rejects(f.service.generate({ ...f.request, request_id: "stable", task: "Different" }), /different bootstrap plan/);
});

test("reservations are published complete and exclusively", async t => {
	const f = fixture(t);
	const path = join(f.root, "reservation.json");
	assert.equal(publishExclusive(path, '{"a":1}'), true);
	assert.equal(publishExclusive(path, '{"a":2}'), false);
	assert.deepEqual(readJson(path), { a: 1 });
	assert.deepEqual(readdirSync(f.root).filter(file => file.endsWith(".tmp")), [], "no temporary files remain");
});

test("run locks coordinate processes: a live owner blocks, a dead owner's lock is recovered", async t => {
	const f = fixture(t);
	const key = join(f.root, "locks", "run");
	mkdirSync(dirname(key), { recursive: true });
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	t.after(() => sleeper.kill());
	writeFileSync(`${key}.lock`, JSON.stringify({ pid: sleeper.pid, instance: "other", acquired_at: Date.now() }));
	assert.equal(lockHeld(key), true);
	await assert.rejects(withRunLock(key, async () => "ran", 100), /locked by another process/);
	writeFileSync(`${key}.lock`, JSON.stringify({ pid: 2147483647, instance: "dead", acquired_at: Date.now() }));
	assert.equal(lockHeld(key), false);
	assert.equal(await withRunLock(key, async () => { assert.equal(lockHeld(key), true); return "ran"; }, 1000), "ran");
	assert.equal(existsSync(`${key}.lock`), false, "released after the action");
});

test("a launch interrupted before release is reconciled to an error and children are aborted", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const index = join(f.options.stateDir, `${run.task_id}.json`);
	// Simulate a launcher that died while waiting for readiness.
	atomicJson(index, { ...readJson<any>(index), status: "launching", phase: "waiting-ready" });
	rmSync(join(run.session_dir, "release.json"));
	const viewed = f.service.status(run.task_id);
	assert.equal(viewed.manifest.status, "error");
	assert.equal(viewed.manifest.phase, "interrupted");
	assert.match(viewed.manifest.error!, /last phase: waiting-ready/);
	assert.equal(existsSync(join(run.session_dir, "abort.json")), false, "a read-only status does not write");
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	assert.equal(cleaned.reconciled, true);
});

test("a launch interrupted after release is reconciled to released, and retries return the reconciled run", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, request_id: "crashy" });
	const index = join(f.options.stateDir, `${run.task_id}.json`);
	atomicJson(index, { ...readJson<any>(index), status: "launching", phase: "waiting-ready" });
	const retried = await f.service.generate({ ...f.request, request_id: "crashy" });
	assert.equal(retried.status, "applied");
	assert.ok(retried.pane_manifest.every(entry => entry.status === "released"));
	assert.equal(readJson<any>(index).status, "applied", "the reconciled state is persisted");
	assert.equal(existsSync(join(run.session_dir, "abort.json")), false);
});

test("a malformed or foreign result file is reported for that agent only", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const [first, second] = run.pane_manifest;
	writeFileSync(resultPath(run.session_dir, first.instance_id), "{not json");
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.agent_name, status: "success", summary: "Fine", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	const status = f.service.status(run.task_id);
	assert.equal(status.results.length, 1);
	assert.equal(status.agents[0].state, "error");
	assert.match(status.worker_errors[0], /unusable result file/);
	atomicJson(resultPath(run.session_dir, first.instance_id), { result: { agent_name: "second", status: "success", summary: "Wrong", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	assert.match(f.service.status(run.task_id).worker_errors[0], /identity mismatch/);
});

test("dry run resolves the full plan without Herdr calls or files", async t => {
	const f = fixture(t);
	const plan = f.service.plan({ ...f.request, topology: "chain" });
	assert.equal(f.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
	assert.deepEqual(plan.agents.map(agent => [agent.instance_id, agent.predecessor, agent.successor]), [["a1-first", undefined, "a2-second"], ["a2-second", "a1-first", undefined]]);
	assert.deepEqual(plan.agents[0].tools, ["read", "bash"]);
	const text = formatPlan(plan);
	assert.match(text, /dispatcher → a1-first → a2-second/);
	assert.throws(() => f.service.plan({ ...f.request, agents: [{ name: "ghost", sub_task: "x" }] }), /not found/);
});

test("launched workers receive the overall task and roster; recent runs are listed newest first", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	assert.equal(f.configs[0].task, "Test launch");
	assert.deepEqual(f.configs[1].roster!.map(member => member.instance_id), run.pane_manifest.map(entry => entry.instance_id));
	const later = await f.service.generate({ ...f.request, request_id: "later" });
	assert.deepEqual(f.service.store.list().map(item => item.task_id), [later.task_id, run.task_id]);
	assert.match(formatRunList(f.service.store.list(1)), new RegExp(`${later.task_id} \\[applied/released\\]`));
});
