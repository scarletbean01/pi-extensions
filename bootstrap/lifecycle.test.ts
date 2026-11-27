import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, launchCommand, normalizeAgents, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { modelMatches } from "./model-utils.ts";
import { atomicJson, completionRecord, lockHeld, processAlive, publishExclusive, readJson, readyPath, resultPath, withRunLock, type WorkerConfig } from "./session-store.ts";
import { gate, probeCommand } from "./test-harness.ts";
import { buildMarkdownReport, formatAgentStates, formatLaunch, formatPlan, formatReportDigest, formatRunList } from "./reporting.ts";

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }
/** Tests that really spawn processes report an UNVERIFIED skip (or a strict-mode infrastructure failure) when spawning is denied, never a pass. */
const spawnReady = await probeCommand("/bin/sh", ["-c", "exit 0"]);

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
	for (const name of ["first", "second"]) writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: provider/model\ntools: read,bash\n---\nExact persona ${name}\n`);
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
	if (!gate(t, spawnReady)) return;
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

test("launchers pass named and empty allowed skills and omit the flag for unrestricted personas", async t => {
	const f = fixture(t);
	const dir = join(f.cwd, ".pi", "agents");
	writeFileSync(join(dir, "first.md"), "---\nmodel: provider/model\nskills: Review, search\n---\nReview.");
	writeFileSync(join(dir, "second.md"), "---\nmodel: provider/model\nskills:\n---\nScout.");
	writeFileSync(join(dir, "third.md"), "---\nmodel: provider/model\n---\nHelp.");
	const run = await f.service.generate({ ...f.request, agents: [...f.request.agents, { name: "third", sub_task: "Help out" }] });
	assert.equal(run.status, "applied", run.error);
	const launcher = (id: string) => readFileSync(join(run.session_dir, `${id}.sh`), "utf8");
	assert.match(launcher("a1-first"), /'--allowed-skills' 'Review,search'/);
	assert.match(launcher("a2-second"), /'--allowed-skills' 'none'/);
	for (const [index, id] of ["a1-first", "a2-second"].entries()) {
		const message = f.configs[index].startup_message;
		assert.ok(launcher(id).endsWith(`'/bootstrap-launch ${message}' '${message}'\n`));
	}
	assert.doesNotMatch(launcher("a3-third"), /--allowed-skills/);
	assert.doesNotMatch(launcher("a3-third"), /\/bootstrap-launch/);
	assert.ok(launcher("a3-third").endsWith(`'${f.configs[2].startup_message}'\n`));
});

test("chain order derives safe instance links and explicit follower startup messages", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, topology: "chain", agents: [{ name: "second", sub_task: "b", step: 2 }, { name: "first", sub_task: "a", step: 1 }] });
	assert.equal(run.status, "applied");
	assert.deepEqual(run.pane_manifest.map(entry => entry.persona_name), ["first", "second"]);
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
		result: { agent_name: entry.persona_name, status: "success", summary: "Done", detail: "Validated" }, delivery: "not_required", completed_at: new Date().toISOString(),
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
		result: { agent_name: entry.persona_name, status: "success", summary: "Done", detail: "" }, delivery: "pending", completed_at: new Date().toISOString(),
	});
	atomicJson(join(run.session_dir, `${run.pane_manifest[0].instance_id}.error.json`), { error: "worker exited" });
	const status = f.service.status(run.task_id);
	assert.equal(status.pending.length, 2);
	assert.match(status.worker_errors[0], /worker exited/);
	await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /not complete/);
});

test("changing a persona's allowed skills changes the request fingerprint", async t => {
	const f = fixture(t);
	const request = { ...f.request, request_id: "allowed-skills" };
	const file = join(f.cwd, ".pi", "agents", "first.md");
	const persona = (skills: string) => writeFileSync(file, `---\nmodel: provider/model\n${skills}---\nPersona`);
	const original = await f.service.generate(request);
	assert.equal(original.status, "applied");
	persona("skills:\n");
	assert.deepEqual(f.service.plan(request).agents[0].allowed_skills, []);
	await assert.rejects(f.service.generate(request), /different bootstrap plan/);

	const explicit = { ...request, request_id: "explicit-skills" };
	persona("skills: review, search\n");
	const run = await f.service.generate(explicit);
	assert.equal(run.status, "applied");
	assert.equal((await f.service.generate(explicit)).task_id, run.task_id);
	persona("skills: review\n");
	assert.deepEqual(f.service.plan(explicit).agents[0].allowed_skills, ["review"]);
	await assert.rejects(f.service.generate(explicit), /different bootstrap plan/);
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
	const results = run.pane_manifest.map(entry => ({ agent_name: entry.persona_name, status: "success" as const, summary: "Done", detail: "" }));
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
	atomicJson(resultPath(run.session_dir, first.instance_id), { result: { agent_name: first.persona_name, status: "failure", summary: "Broke", detail: "" }, delivery: "failed", delivery_error: "receiver gone", completed_at: new Date().toISOString() });
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.persona_name, status: "failure", summary: "Upstream", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.delivery_errors, []);
	assert.deepEqual(status.pending, []);
	await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
});

test("a report without markdown removes a stale report.md", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	const results = run.pane_manifest.map(entry => ({ agent_name: entry.persona_name, status: "success" as const, summary: "Done", detail: "" }));
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
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.persona_name, status: "partial", summary: "Half done", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
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
		for (const entry of run.pane_manifest) atomicJson(resultPath(run.session_dir, entry.instance_id), { result: { agent_name: entry.persona_name, status: "success", summary: "Done", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
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
	assert.ok(digest.split("\n")[3].length < 300, "summaries are clipped");
});

test("session directories are private and a PID owned by another user is not our worker", async t => {
	const f = fixture(t);
	const run = await f.service.generate(f.request);
	assert.equal(statSync(run.session_dir).mode & 0o777, 0o700);
	// A container's PID 1 can belong to the test user. Exercise the foreign-PID error directly.
	const kill = t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
	});
	assert.equal(processAlive({ pid: 1 }), false);
	assert.deepEqual(kill.mock.calls.map(call => call.arguments), [[1, 0]]);
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

test("request replay does not require write access to create a new managed session", async t => {
	const f = fixture(t);
	const original = await f.service.generate({ ...f.request, request_id: "replay-read-only" });
	const sessions = join(f.cwd, ".pi", "agent-sessions");
	chmodSync(sessions, 0o500);
	try {
		const replay = await f.service.generate({ ...f.request, request_id: "replay-read-only" });
		assert.equal(replay.task_id, original.task_id);
	} finally { chmodSync(sessions, 0o700); }
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
	if (!gate(t, spawnReady)) return;
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
	atomicJson(resultPath(run.session_dir, second.instance_id), { result: { agent_name: second.persona_name, status: "success", summary: "Fine", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
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
	assert.match(text, /plan · chain · 2 nodes\n◌ first ──▶ ◌ second/);
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

// ---- ticket 03: several assignments sharing one persona ----

const reviewers = [
	{ node_id: "review-api", persona: "first", sub_task: "Review the API surface" },
	{ node_id: "review-ui", persona: "FIRST", sub_task: "Review the UI flows" },
];

test("two nodes can use one persona with separate run, node, persona, attempt and worker identities", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, agents: reviewers });
	assert.equal(run.status, "applied");
	assert.equal(run.version, 2);
	assert.deepEqual(run.pane_manifest.map(entry => [entry.node_id, entry.persona_name]), [["review-api", "first"], ["review-ui", "first"]]);
	assert.equal(new Set(run.pane_manifest.map(entry => entry.attempt_id)).size, 2);
	assert.equal(new Set(run.pane_manifest.map(entry => entry.instance_id)).size, 2);
	assert.equal(new Set(run.pane_manifest.map(entry => entry.label)).size, 2);
	assert.equal(f.tabs.length, 2);
	assert.deepEqual(f.configs.map(config => [config.version, config.task_id, config.node_id, config.persona_name, config.sub_task]),
		[[2, run.task_id, "review-api", "first", "Review the API surface"], [2, run.task_id, "review-ui", "first", "Review the UI flows"]]);
	assert.deepEqual(f.configs.map(config => config.attempt_id), run.pane_manifest.map(entry => entry.attempt_id));
	assert.equal(f.configs[0].persona, f.configs[1].persona, "both nodes run the same persona snapshot");
	assert.deepEqual(f.configs[1].roster!.map(member => [member.node_id, member.persona_name]), [["review-api", "first"], ["review-ui", "first"]]);
	// The persisted plan is the new format and can be read back (and survives a fresh service).
	assert.equal(new BootstrapService(f.options).store.load(run.task_id).pane_manifest[1].node_id, "review-ui");
});

test("duplicate node IDs are rejected before launch while duplicate persona names are allowed", async t => {
	const f = fixture(t);
	await assert.rejects(f.service.generate({ ...f.request, agents: [reviewers[0], { ...reviewers[1], node_id: "REVIEW-API" }] }), /Duplicate node ID: REVIEW-API/);
	// A legacy request names the persona and the node at once, so repeating a persona there is a duplicate node.
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ name: "first", sub_task: "a" }, { name: "First", sub_task: "b" }] }), /Duplicate node ID/);
	// Omitting node_id defaults it to the persona name, so a repeated persona must be disambiguated explicitly.
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ persona: "first", sub_task: "a" }, { persona: "first", sub_task: "b" }] }), /Duplicate node ID: first.*distinct node_id/);
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ name: "first", persona: "first", sub_task: "a" }] }), /either name .* or persona/);
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ node_id: "solo", sub_task: "a" }] }), /persona/);
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ node_id: "bad node!", persona: "first", sub_task: "a" }] }), /Unsafe node ID/);
	await assert.rejects(f.service.generate({ ...f.request, agents: [{ node_id: "ok", persona: "ghost", sub_task: "a" }] }), /Agent "ghost" not found/);
	assert.equal(f.calls.length, 0);
});

test("a legacy name/sub_task request normalizes to the same plan as the explicit node form and keeps chain order", async t => {
	const f = fixture(t);
	// Legacy defaults to allow_partial + legacy messaging; explicit node form defaults to require_success + independent mode.
	const legacy = { ...f.request, topology: "chain" as const, collaboration_mode: "independent", agents: [{ name: "second", sub_task: "b", step: 2 }, { name: "first", sub_task: "a", step: 1 }] };
	const explicit = { ...f.request, topology: "chain" as const, agents: [{ node_id: "second", persona: "second", sub_task: "b", step: 2, dependency_policy: "allow_partial" }, { node_id: "first", persona: "first", sub_task: "a", step: 1 }] };
	const [planLegacy, planExplicit] = [f.service.plan(legacy), f.service.plan(explicit)];
	assert.deepEqual(planLegacy, planExplicit);
	assert.deepEqual(planLegacy.agents.map(agent => [agent.node_id, agent.persona_name, agent.instance_id, agent.step]), [["first", "first", "a1-first", 1], ["second", "second", "a2-second", 2]]);
	const run = await f.service.generate({ ...legacy, request_id: "equivalent" });
	const again = await f.service.generate({ ...explicit, request_id: "equivalent" });
	assert.equal(again.task_id, run.task_id, "equivalent forms share an idempotency fingerprint");
	assert.equal(f.tabs.length, 2);
	assert.equal(run.request_form, "legacy");
	assert.deepEqual(run.pane_manifest.map(entry => [entry.node_id, entry.successor]), [["first", "a2-second"], ["second", undefined]]);
	// Chain consistency checks refer to nodes.
	assert.throws(() => f.service.plan({ ...explicit, agents: [{ node_id: "x", persona: "first", sub_task: "a", successor: "z" }, { node_id: "y", persona: "first", sub_task: "b" }] }), /Invalid successor/);
});

test("a request key reserved by the previous plan fingerprint still resolves to the original run", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, request_id: "upgraded" });
	// Rewrite the reservation exactly as the previous (pre-node) release wrote it.
	const previous = createHash("sha256").update(JSON.stringify({
		v: 2, topology: "team", task: "Test launch", project_cwd: realpathSync(f.cwd), ready_timeout_ms: 100, coms_extension: null,
		agents: [["first", "First task", null], ["second", "Second task", null]], model: null,
	})).digest("hex");
	atomicJson(join(f.options.stateDir, `request-${createHash("sha256").update("upgraded").digest("hex")}.json`), { fingerprint: previous, task_id: run.task_id });
	const retry = await new BootstrapService(f.options).generate({ ...f.request, request_id: "upgraded" });
	assert.equal(retry.task_id, run.task_id);
	assert.equal(f.tabs.length, 2);
	// A plan that gives the same persona a different node identity is a different plan.
	await assert.rejects(f.service.generate({ ...f.request, request_id: "upgraded", agents: [{ node_id: "x", persona: "first", sub_task: "First task" }, { node_id: "second", persona: "second", sub_task: "Second task" }] }), /different bootstrap plan/);
});

/** The durable record a finished worker writes for its node (the same builder the worker uses). */
function finish(run: { session_dir: string }, config: WorkerConfig, status: "success" | "partial" | "failure", summary: string): void {
	atomicJson(resultPath(run.session_dir, config.instance_id), completionRecord(config, { agent_name: config.persona_name, status, summary, detail: `${summary} (detail)` }, "not_required", new Date().toISOString()));
}

test("two reviewers with different assignments produce two distinct, attributable results", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, agents: reviewers });
	finish(run, f.configs[0], "success", "API is sound");
	finish(run, f.configs[1], "partial", "UI has two problems");
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.pending, []);
	assert.deepEqual(status.results.map(result => [result.node_id, result.agent_name, result.status, result.summary]), [
		["review-api", "first", "success", "API is sound"], ["review-ui", "first", "partial", "UI has two problems"]]);
	assert.deepEqual(status.agents.map(agent => [agent.node_id, agent.persona_name, agent.state, agent.attempt_id]), [
		["review-api", "first", "done", "a1-review-api.1"], ["review-ui", "first", "done", "a2-review-ui.1"]]);
	const text = formatAgentStates(status.agents);
	assert.match(text, /a1-review-api \(review-api, persona first\): done success: API is sound/);
	assert.match(text, /a2-review-ui \(review-ui, persona first\): done partial: UI has two problems/);
	const paths = await f.service.report(run.task_id, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(paths.report_json).map(result => [result.node_id, result.summary]), [["review-api", "API is sound"], ["review-ui", "UI has two problems"]]);
	const markdown = readFileSync(paths.report_md!, "utf8");
	assert.match(markdown, /### .* review-api \(persona first\)/);
	assert.match(markdown, /### .* review-ui \(persona first\)/);
	assert.match(formatReportDigest(paths.results), /- review-ui \(persona first\): partial — UI has two problems/);
});

test("explicit report results are attributed by node ID; a shared persona name alone is ambiguous", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, agents: reviewers });
	const api = { node_id: "review-api", agent_name: "first", status: "success" as const, summary: "API", detail: "" };
	const ui = { node_id: "REVIEW-UI", status: "success" as const, summary: "UI", detail: "" };
	await assert.rejects(f.service.report(run.task_id, [{ agent_name: "first", status: "success", summary: "x", detail: "" }, ui], false, buildMarkdownReport), /persona first, which is used by nodes review-api, review-ui; supply node_id/);
	await assert.rejects(f.service.report(run.task_id, [api, { ...ui, agent_name: "second" }], false, buildMarkdownReport), /names persona second, but that node runs first/);
	await assert.rejects(f.service.report(run.task_id, [api, api], false, buildMarkdownReport), /Unknown or duplicate result agent: review-api/);
	await assert.rejects(f.service.report(run.task_id, [api, { node_id: "nobody", status: "success", summary: "x", detail: "" }], false, buildMarkdownReport), /Unknown or duplicate/);
	await assert.rejects(f.service.report(run.task_id, [api], false, buildMarkdownReport), /exactly one result for each planned agent/);
	const paths = await f.service.report(run.task_id, [ui, api], false, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(paths.report_json).map(result => [result.node_id, result.agent_name]), [["review-ui", "first"], ["review-api", "first"]]);
});

test("a result file with malformed or foreign identity is reported for that node only", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, agents: reviewers });
	finish(run, f.configs[0], "success", "API is sound");
	// The UI node's file carries the API node's identity (a copied or misplaced record).
	atomicJson(resultPath(run.session_dir, f.configs[1].instance_id), JSON.parse(readFileSync(resultPath(run.session_dir, f.configs[0].instance_id), "utf8")));
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.results.map(result => result.node_id), ["review-api"], "the healthy node stays visible");
	assert.equal(status.agents[1].state, "error");
	assert.match(status.worker_errors.join("\n"), /review-ui \(persona first\): unusable result file: result identity mismatch \(node_id "review-api", expected "review-ui"\)/);
	// Dropping the identity, a bad run, or an unknown version are all rejected rather than guessed at.
	const record = JSON.parse(readFileSync(resultPath(run.session_dir, f.configs[0].instance_id), "utf8"));
	for (const [broken, pattern] of [
		[{ ...record, identity: undefined }, /no identity recorded/],
		[{ ...record, identity: { ...record.identity, run_id: "another-run" } }, /run_id "another-run"/],
		[{ ...record, identity: { ...record.identity, attempt_id: "a1-review-api.2" } }, /attempt_id "a1-review-api.2"/],
		[{ ...record, version: 3 }, /Unsupported result record version 3/],
		[{ ...record, result: { ...record.result, node_id: "review-ui" } }, /identity mismatch/],
	] as const) {
		atomicJson(resultPath(run.session_dir, f.configs[0].instance_id), broken);
		const damaged = f.service.status(run.task_id);
		assert.equal(damaged.agents[0].state, "error");
		assert.match(damaged.agents[0].error!, pattern);
	}
	// A version 1 (persona-only) result cannot say which of two same-persona nodes it belongs to.
	atomicJson(resultPath(run.session_dir, f.configs[0].instance_id), { result: { agent_name: "first", status: "success", summary: "old", detail: "" }, delivery: "not_required", completed_at: new Date().toISOString() });
	assert.match(f.service.status(run.task_id).agents[0].error!, /ambiguous: persona first is shared/);
});

test("cleanup selects one node of a shared persona by node ID or instance ID and rejects an ambiguous persona selector", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.request, agents: [...reviewers, { node_id: "triage", persona: "second", sub_task: "Triage findings" }] });
	const ambiguity = /Ambiguous agent selector "(first|FIRST)": persona first is used by nodes review-api \(a1-review-api\), review-ui \(a2-review-ui\)\. Select by node ID or instance ID/;
	await assert.rejects(f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["first"]), ambiguity);
	await assert.rejects(f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["triage", "FIRST"]), ambiguity);
	assert.equal(f.tabs.length, 3, "an ambiguous selector closes nothing");
	assert.equal(existsSync(join(run.session_dir, "abort.json")), false);
	// A persona that names exactly one node is still a valid selector.
	const byPersona = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["second"]);
	assert.deepEqual(byPersona.pane_manifest.map(entry => [entry.node_id, entry.status]), [["review-api", "released"], ["review-ui", "released"], ["triage", "closed"]]);
	const byNode = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["Review-UI"]);
	assert.deepEqual(byNode.pane_manifest.map(entry => entry.status), ["released", "closed", "closed"]);
	assert.equal(f.tabs.length, 1);
	assert.equal(byNode.phase, "partially-cleaned");
	// Instance IDs stay selectable after tab IDs compacted.
	const last = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, [run.pane_manifest[0].instance_id]);
	assert.equal(last.status, "cleaned");
	assert.equal(f.tabs.length, 0);
});

test("a node ID outranks a persona name, and a selector matching two stable identities is rejected", async t => {
	const f = fixture(t);
	// Node "second" runs persona "first"; node "other" runs persona "second".
	const run = await f.service.generate({ ...f.request, agents: [{ node_id: "second", persona: "first", sub_task: "a" }, { node_id: "other", persona: "second", sub_task: "b" }] });
	const partial = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["second"]);
	assert.deepEqual(partial.pane_manifest.map(entry => [entry.node_id, entry.status]), [["second", "closed"], ["other", "released"]], "the node ID wins over another node's persona");
	await f.service.cleanup(run.task_id);
	const clash = await f.service.generate({ ...f.request, request_id: "clash", agents: [{ node_id: "a2-other", persona: "first", sub_task: "a" }, { node_id: "other", persona: "second", sub_task: "b" }] });
	assert.equal(clash.pane_manifest[1].instance_id, "a2-other");
	await assert.rejects(f.service.cleanup(clash.task_id, undefined, false, undefined, undefined, ["a2-other"]), /Ambiguous agent selector "a2-other": it matches a2-other \(a1-a2-other\), other \(a2-other\)\. Use an instance ID/);
});

// ---- ticket 03: persisted-format versions and compatibility fixtures ----

/** A run exactly as the previous release persisted it: version 1, persona-keyed, no nodes or attempts. */
function writeVersion1Run(f: ReturnType<typeof fixture>, taskId = "legacy-run-1") {
	const sessionDir = join(f.cwd, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const manifest = {
		version: 1, task_id: taskId, task: "Legacy chain", topology: "chain", project_cwd: realpathSync(f.cwd), session_dir: join(realpathSync(f.cwd), ".pi", "agent-sessions", taskId),
		workspace_id: "origin-workspace", coms_project: `boot-${taskId}`, status: "applied", phase: "released", token: "legacy-token",
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		pane_manifest: [
			{ agent_name: "first", instance_id: "a1-first", expected_coms_name: "a1-first", expected_model: "provider/model", label: `${taskId}:a1-first`, step: 1, successor: "a2-second", tab_id: "t1", pane_id: "p1", terminal_id: "term1", status: "released" },
			{ agent_name: "second", instance_id: "a2-second", expected_coms_name: "a2-second", expected_model: "provider/model", label: `${taskId}:a2-second`, step: 2, predecessor: "a1-first", tab_id: "t2", pane_id: "p2", terminal_id: "term2", status: "released" },
		],
	};
	const text = JSON.stringify(manifest, null, 2) + "\n";
	mkdirSync(f.options.stateDir, { recursive: true });
	writeFileSync(join(f.options.stateDir, `${taskId}.json`), text);
	writeFileSync(join(manifest.session_dir, "manifest.json"), text);
	for (const entry of manifest.pane_manifest) f.tabs.push({ tab_id: entry.tab_id, pane_id: entry.pane_id, terminal_id: entry.terminal_id, label: entry.label, cwd: f.cwd });
	for (const [instance, agent_name, summary] of [["a1-first", "first", "Found two issues"], ["a2-second", "second", "Fixed both"]]) {
		writeFileSync(join(manifest.session_dir, `${instance}.result.json`), JSON.stringify({ result: { agent_name, status: "success", summary, detail: "" }, delivery: "not_required", completed_at: "2026-01-01T00:01:00.000Z" }));
	}
	return { taskId, manifest, text, sessionDir: manifest.session_dir };
}

test("a version 1 run can still be inspected, reported and cleaned up, and stays in the version 1 format", async t => {
	const f = fixture(t);
	const legacy = writeVersion1Run(f);
	const status = f.service.status(legacy.taskId);
	assert.deepEqual(status.agents.map(agent => [agent.node_id, agent.persona_name, agent.attempt_id, agent.state]), [["first", "first", undefined, "done"], ["second", "second", undefined, "done"]]);
	assert.deepEqual(status.pending, []);
	assert.match(formatAgentStates(status.agents), /a1-first \(first\): done success: Found two issues/);
	assert.deepEqual(f.service.store.list().map(run => run.task_id), [legacy.taskId]);
	const paths = await f.service.report(legacy.taskId, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(paths.report_json).map(result => result.agent_name), ["first", "second"]);
	assert.match(readFileSync(paths.report_md!, "utf8"), /### .* first\n/);
	const partial = await f.service.cleanup(legacy.taskId, undefined, false, undefined, undefined, ["FIRST"]);
	assert.equal(partial.phase, "partially-cleaned");
	const full = await f.service.cleanup(legacy.taskId);
	assert.equal(full.status, "cleaned");
	assert.equal(f.tabs.length, 0);
	// Persisted changes keep the version 1 shape: identities are never rewritten in place.
	for (const path of [join(f.options.stateDir, `${legacy.taskId}.json`), join(legacy.sessionDir, "manifest.json")]) {
		const stored = readJson<any>(path);
		assert.equal(stored.version, 1);
		assert.equal(stored.status, "cleaned");
		assert.deepEqual(stored.pane_manifest.map((entry: any) => [entry.agent_name, entry.node_id, entry.persona_name, entry.attempt_id]), [["first", undefined, undefined, undefined], ["second", undefined, undefined, undefined]]);
	}
});

test("an unsupported or malformed manifest fails clearly and its ownership evidence is never rewritten", async t => {
	const f = fixture(t);
	const legacy = writeVersion1Run(f);
	const future = { ...legacy.manifest, version: 3 };
	const indexPath = join(f.options.stateDir, `${legacy.taskId}.json`);
	writeFileSync(indexPath, JSON.stringify(future));
	const before = readFileSync(indexPath, "utf8");
	assert.throws(() => f.service.status(legacy.taskId), /Unsupported bootstrap manifest version 3 for "legacy-run-1": this release reads versions 1 and 2/);
	await assert.rejects(f.service.cleanup(legacy.taskId), /Unsupported bootstrap manifest version 3/);
	await assert.rejects(f.service.report(legacy.taskId, undefined, false, buildMarkdownReport), /Unsupported bootstrap manifest version 3/);
	assert.equal(readFileSync(indexPath, "utf8"), before, "the record is untouched");
	assert.equal(f.tabs.length, 2, "nothing was closed on uncertain ownership");
	assert.deepEqual(f.service.store.list(), [], "unsupported records do not appear as runs");
	// A version 2 manifest must carry complete, unique identities.
	const run = await f.service.generate(f.request);
	const index = join(f.options.stateDir, `${run.task_id}.json`);
	const good = readJson<any>(index);
	for (const [mutate, pattern] of [
		[(m: any) => { delete m.pane_manifest[1].node_id; }, /agent 2: node_id must be a non-empty string/],
		[(m: any) => { m.pane_manifest[1].node_id = "FIRST"; }, /agent 2: duplicate node ID FIRST/],
		[(m: any) => { m.pane_manifest[0].attempt_id = ""; }, /agent 1: attempt_id must be a non-empty string/],
		[(m: any) => { m.pane_manifest[1].instance_id = m.pane_manifest[0].instance_id; }, /duplicate instance/],
		[(m: any) => { m.pane_manifest = {}; }, /Invalid bootstrap manifest/],
	] as Array<[(m: any) => void, RegExp]>) {
		const broken = structuredClone(good);
		mutate(broken);
		writeFileSync(index, JSON.stringify(broken));
		assert.throws(() => f.service.status(run.task_id), pattern);
	}
});

test("retrying a request after changing only the alias thinking level is a different plan", async t => {
	const f = fixture(t);
	const config = join(f.cwd, ".pi", "bootstrap.json");
	writeFileSync(join(f.cwd, ".pi", "agents", "first.md"), "---\nmodel: review\n---\nReview.");
	const setLevel = (thinking?: string) => writeFileSync(config, JSON.stringify({
		modelAliases: { review: { model: "provider/model", thinking } },
	}));
	const request = { ...f.request, request_id: "review-thinking" };
	setLevel("low");
	const run = await f.service.generate(request);
	assert.equal(run.status, "applied");
	assert.equal((await f.service.generate(request)).task_id, run.task_id);
	for (const changedLevel of ["high", undefined]) {
		setLevel(changedLevel);
		await assert.rejects(f.service.generate(request), /different bootstrap plan/);
	}
});

test("the launcher passes the persona thinking level explicitly with an inherited model", async t => {
	const f = fixture(t);
	writeFileSync(join(f.cwd, ".pi", "agents", "first.md"), "---\nthinking: max\n---\nReview.");
	const request = { ...f.request, agents: [f.request.agents[0]] };
	const inherited = { provider: "provider", id: "model" };
	const plan = f.service.plan(request, inherited);
	assert.equal(plan.agents[0].model, "provider/model");
	assert.equal(plan.agents[0].thinking, "max");

	const run = await f.service.generate(request, inherited);
	assert.equal(run.status, "applied");
	const launcher = readFileSync(join(run.session_dir, "a1-first.sh"), "utf8");
	assert.match(launcher, /'--model' 'provider\/model' '--thinking' 'max'/);
});

test("planned nodes carry inbound edges for chains and none for teams without changing records, fingerprints, dry-run or status", async t => {
	const chainNodes = normalizeAgents("chain", [
		{ node_id: "plan", persona: "first", sub_task: "a" },
		{ node_id: "build", persona: "second", sub_task: "b" },
		{ node_id: "check", persona: "first", sub_task: "c" },
	]);
	assert.deepEqual(chainNodes.map(node => [node.node_id, node.inbound_edges]), [
		["plan", []],
		["build", ["plan"]],
		["check", ["build"]],
	]);
	const teamNodes = normalizeAgents("team", [
		{ node_id: "a", persona: "first", sub_task: "x" },
		{ node_id: "b", persona: "second", sub_task: "y" },
	]);
	assert.deepEqual(teamNodes.map(node => [node.node_id, node.inbound_edges]), [
		["a", []],
		["b", []],
	]);

	// Compatibility against literals captured from HEAD before the inbound-edges refactor.
	const f = fixture(t);
	const compatRoot = "/tmp/bootstrap-compat-fp";
	rmSync(compatRoot, { recursive: true, force: true });
	t.after(() => rmSync(compatRoot, { recursive: true, force: true }));
	const cwd = join(compatRoot, "proj");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nmodel: provider/model\ntools: read, bash\n---\nFirst persona.");
	writeFileSync(join(cwd, ".pi", "agents", "second.md"), "---\nmodel: provider/model\ntools: read, write\n---\nSecond persona.");
	const coms = join(compatRoot, "coms.ts");
	writeFileSync(coms, "");
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string }> = [];
	let seq = 0;
	const service = new BootstrapService({
		...f.options,
		exec: async (_cmd, args) => {
			const ok = (value: unknown = "") => ({ code: 0, stdout: JSON.stringify({ result: value }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
			if (args[0] === "tab" && args[1] === "create") {
				seq++;
				const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1] };
				tabs.push(tab);
				return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const tab = tabs.find(item => item.pane_id === args[2])!;
				const [task, instance] = tab.label.split(":");
				const sessionDir = join(realpathSync(cwd), ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
				const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: cfg.expected_model };
				atomicJson(readyPath(sessionDir, instance), ready);
				const registryDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
				mkdirSync(registryDir, { recursive: true });
				atomicJson(join(registryDir, `${instance}.json`), ready);
				return ok();
			}
			return ok();
		},
	});
	const realCwd = realpathSync(cwd);
	const normalizeValue = (value: unknown, run: { task_id: string; token: string; session_dir: string }) => JSON.parse(
		JSON.stringify(value)
			.replaceAll(run.task_id, "<TASK_ID>")
			.replaceAll(run.token, "<TOKEN>")
			.replaceAll(run.session_dir, "<SESSION_DIR>")
			.replaceAll(realCwd, "<CWD>")
			.replaceAll(f.home, "<HOME>")
			.replaceAll(f.options.extensionDir, "<EXT_DIR>"),
	);
	const reservationFp = (requestId: string) =>
		readJson<{ fingerprint: string }>(join(service.store.indexRoot, `request-${createHash("sha256").update(requestId).digest("hex")}.json`)).fingerprint;

	const chainReq: GenerateRequest = {
		topology: "chain", task: "Compat chain", project_cwd: cwd, coms_extension: coms, ready_timeout_ms: 100, request_id: "compat-chain",
		agents: [
			{ node_id: "plan", persona: "first", sub_task: "Plan it" },
			{ node_id: "build", persona: "second", sub_task: "Build it" },
			{ node_id: "check", persona: "first", sub_task: "Check it" },
		],
	};
	assert.equal(
		formatPlan(service.plan(chainReq)).replaceAll(realCwd, "<CWD>").replaceAll(realpathSync(compatRoot), "<EXT_DIR>"),
		"chain in <CWD> (workspace: shared_cwd; readiness timeout 100ms; Coms <EXT_DIR>/coms.ts)\n" +
		"  collaboration: independent; failure_policy: independent\n" +
		"  ownership_contract: shared-cwd path declarations are an advisory scheduling contract unless backed by external enforcement or separate workspaces\n" +
		"plan · chain · 3 nodes\n" +
		"◌ plan ──▶ ◌ build ──▶ ◌ check\n" +
		"- a1-plan (step 1): node plan, persona first from <CWD>/.pi/agents/first.md [.pi]\n" +
		"  model provider/model; thinking (default); tools read, bash; allowed skills: all\n" +
		"  task: Plan it\n" +
		"- a2-build (step 2): node build, persona second from <CWD>/.pi/agents/second.md [.pi]\n" +
		"  model provider/model; thinking (default); tools read, write; allowed skills: all\n" +
		"  dependency: require_success\n" +
		"  task: Build it\n" +
		"- a3-check (step 3): node check, persona first from <CWD>/.pi/agents/first.md [.pi]\n" +
		"  model provider/model; thinking (default); tools read, bash; allowed skills: all\n" +
		"  dependency: require_success\n" +
		"  task: Check it",
	);
	const chainRun = await service.generate(chainReq);
	assert.equal(reservationFp("compat-chain"), "63dfc429bdbb32242578d3265aded9e904790ce547afbbbf16bfae215a644263");
	assert.deepEqual(normalizeValue(chainRun.pane_manifest, chainRun), [
		{
			node_id: "plan", persona_name: "first", attempt_id: "a1-plan.1", instance_id: "a1-plan", expected_coms_name: "a1-plan",
			expected_model: "provider/model", label: "<TASK_ID>:a1-plan", step: 1, successor: "a2-build", status: "released",
			tab_id: "t1", pane_id: "p1", terminal_id: "term1",
			host_ref: { tab_id: "t1", pane_id: "p1", terminal_id: "term1", label: "<TASK_ID>:a1-plan" },
		},
		{
			node_id: "build", persona_name: "second", attempt_id: "a2-build.1", instance_id: "a2-build", expected_coms_name: "a2-build",
			expected_model: "provider/model", label: "<TASK_ID>:a2-build", step: 2, predecessor: "a1-plan", successor: "a3-check",
			status: "released", dependency_policy: "require_success", tab_id: "t2", pane_id: "p2", terminal_id: "term2",
			host_ref: { tab_id: "t2", pane_id: "p2", terminal_id: "term2", label: "<TASK_ID>:a2-build" },
		},
		{
			node_id: "check", persona_name: "first", attempt_id: "a3-check.1", instance_id: "a3-check", expected_coms_name: "a3-check",
			expected_model: "provider/model", label: "<TASK_ID>:a3-check", step: 3, predecessor: "a2-build", status: "released",
			dependency_policy: "require_success", tab_id: "t3", pane_id: "p3", terminal_id: "term3",
			host_ref: { tab_id: "t3", pane_id: "p3", terminal_id: "term3", label: "<TASK_ID>:a3-check" },
		},
	]);
	const chainRoster = [
		{ instance_id: "a1-plan", node_id: "plan", persona_name: "first", step: 1, sub_task: "Plan it" },
		{ instance_id: "a2-build", node_id: "build", persona_name: "second", step: 2, sub_task: "Build it" },
		{ instance_id: "a3-check", node_id: "check", persona_name: "first", step: 3, sub_task: "Check it" },
	];
	assert.deepEqual(
		normalizeValue(chainRun.pane_manifest.map(entry => readJson<WorkerConfig>(join(chainRun.session_dir, `${entry.instance_id}.config.json`))), chainRun),
		[
			{
				version: 2, task_id: "<TASK_ID>", token: "<TOKEN>", session_dir: "<CWD>/.pi/agent-sessions/<TASK_ID>", project_cwd: "<CWD>",
				coms_dir: "<HOME>/.pi/coms", coms_project: "boot-<TASK_ID>", instance_id: "a1-plan", node_id: "plan", persona_name: "first",
				attempt_id: "a1-plan.1", persona: "First persona.", expected_model: "provider/model", tools: ["read", "bash"], sub_task: "Plan it",
				topology: "chain", step: 1, successor: "a2-build", collaboration_mode: "independent", failure_policy: "independent", handoff_protocol: 1,
				startup_message: "bootstrap-start:<TOKEN>:a1-plan", ready_timeout_ms: 105100, task: "Compat chain", roster: chainRoster,
			},
			{
				version: 2, task_id: "<TASK_ID>", token: "<TOKEN>", session_dir: "<CWD>/.pi/agent-sessions/<TASK_ID>", project_cwd: "<CWD>",
				coms_dir: "<HOME>/.pi/coms", coms_project: "boot-<TASK_ID>", instance_id: "a2-build", node_id: "build", persona_name: "second",
				attempt_id: "a2-build.1", persona: "Second persona.", expected_model: "provider/model", tools: ["read", "write"], sub_task: "Build it",
				topology: "chain", step: 2, predecessor: "a1-plan", successor: "a3-check", dependency_policy: "require_success",
				collaboration_mode: "independent", failure_policy: "independent", handoff_protocol: 1,
				startup_message: "bootstrap-start:<TOKEN>:a2-build", ready_timeout_ms: 105100, task: "Compat chain", roster: chainRoster,
			},
			{
				version: 2, task_id: "<TASK_ID>", token: "<TOKEN>", session_dir: "<CWD>/.pi/agent-sessions/<TASK_ID>", project_cwd: "<CWD>",
				coms_dir: "<HOME>/.pi/coms", coms_project: "boot-<TASK_ID>", instance_id: "a3-check", node_id: "check", persona_name: "first",
				attempt_id: "a3-check.1", persona: "First persona.", expected_model: "provider/model", tools: ["read", "bash"], sub_task: "Check it",
				topology: "chain", step: 3, predecessor: "a2-build", dependency_policy: "require_success",
				collaboration_mode: "independent", failure_policy: "independent", handoff_protocol: 1,
				startup_message: "bootstrap-start:<TOKEN>:a3-check", ready_timeout_ms: 105100, task: "Compat chain", roster: chainRoster,
			},
		],
	);

	const teamReq: GenerateRequest = {
		topology: "team", task: "Compat team", project_cwd: cwd, coms_extension: coms, ready_timeout_ms: 100, request_id: "compat-team",
		agents: [
			{ node_id: "a", persona: "first", sub_task: "Task A" },
			{ node_id: "b", persona: "second", sub_task: "Task B" },
		],
	};
	assert.equal(
		formatPlan(service.plan(teamReq)).replaceAll(realCwd, "<CWD>").replaceAll(realpathSync(compatRoot), "<EXT_DIR>"),
		"team in <CWD> (workspace: shared_cwd; readiness timeout 100ms; Coms <EXT_DIR>/coms.ts)\n" +
		"  collaboration: independent; failure_policy: independent\n" +
		"  ownership_contract: shared-cwd path declarations are an advisory scheduling contract unless backed by external enforcement or separate workspaces\n" +
		"plan · team · 2 nodes\n" +
		"◌ a\n" +
		"◌ b\n" +
		"- a1-a: node a, persona first from <CWD>/.pi/agents/first.md [.pi]\n" +
		"  model provider/model; thinking (default); tools read, bash; allowed skills: all\n" +
		"  task: Task A\n" +
		"- a2-b: node b, persona second from <CWD>/.pi/agents/second.md [.pi]\n" +
		"  model provider/model; thinking (default); tools read, write; allowed skills: all\n" +
		"  task: Task B",
	);
	const teamRun = await service.generate(teamReq);
	assert.equal(reservationFp("compat-team"), "f8d75559d16ce723321689e78a5e7add84acc26f08e051ceb22ce5ac4d7081e7");
	assert.deepEqual(normalizeValue(teamRun.pane_manifest, teamRun), [
		{
			node_id: "a", persona_name: "first", attempt_id: "a1-a.1", instance_id: "a1-a", expected_coms_name: "a1-a",
			expected_model: "provider/model", label: "<TASK_ID>:a1-a", status: "released", tab_id: "t4", pane_id: "p4", terminal_id: "term4",
			host_ref: { tab_id: "t4", pane_id: "p4", terminal_id: "term4", label: "<TASK_ID>:a1-a" },
		},
		{
			node_id: "b", persona_name: "second", attempt_id: "a2-b.1", instance_id: "a2-b", expected_coms_name: "a2-b",
			expected_model: "provider/model", label: "<TASK_ID>:a2-b", status: "released", tab_id: "t5", pane_id: "p5", terminal_id: "term5",
			host_ref: { tab_id: "t5", pane_id: "p5", terminal_id: "term5", label: "<TASK_ID>:a2-b" },
		},
	]);
	const teamRoster = [
		{ instance_id: "a1-a", node_id: "a", persona_name: "first", sub_task: "Task A" },
		{ instance_id: "a2-b", node_id: "b", persona_name: "second", sub_task: "Task B" },
	];
	assert.deepEqual(
		normalizeValue(teamRun.pane_manifest.map(entry => readJson<WorkerConfig>(join(teamRun.session_dir, `${entry.instance_id}.config.json`))), teamRun),
		[
			{
				version: 2, task_id: "<TASK_ID>", token: "<TOKEN>", session_dir: "<CWD>/.pi/agent-sessions/<TASK_ID>", project_cwd: "<CWD>",
				coms_dir: "<HOME>/.pi/coms", coms_project: "boot-<TASK_ID>", instance_id: "a1-a", node_id: "a", persona_name: "first",
				attempt_id: "a1-a.1", persona: "First persona.", expected_model: "provider/model", tools: ["read", "bash"], sub_task: "Task A",
				topology: "team", collaboration_mode: "independent", failure_policy: "independent",
				startup_message: "bootstrap-start:<TOKEN>:a1-a", ready_timeout_ms: 75100, task: "Compat team", roster: teamRoster,
			},
			{
				version: 2, task_id: "<TASK_ID>", token: "<TOKEN>", session_dir: "<CWD>/.pi/agent-sessions/<TASK_ID>", project_cwd: "<CWD>",
				coms_dir: "<HOME>/.pi/coms", coms_project: "boot-<TASK_ID>", instance_id: "a2-b", node_id: "b", persona_name: "second",
				attempt_id: "a2-b.1", persona: "Second persona.", expected_model: "provider/model", tools: ["read", "write"], sub_task: "Task B",
				topology: "team", collaboration_mode: "independent", failure_policy: "independent",
				startup_message: "bootstrap-start:<TOKEN>:a2-b", ready_timeout_ms: 75100, task: "Compat team", roster: teamRoster,
			},
		],
	);

	await service.generate({
		topology: "chain", task: "Legacy chain", project_cwd: cwd, coms_extension: coms, ready_timeout_ms: 100, request_id: "legacy-chain",
		agents: [{ name: "first", sub_task: "a" }, { name: "second", sub_task: "b" }],
	});
	assert.equal(reservationFp("legacy-chain"), "2c099aedfac8c605854df66f9fbdb35c726fa4b3030c31fa3a07e37efd33aac5");

	await service.generate({
		topology: "team", task: "Legacy team", project_cwd: cwd, coms_extension: coms, ready_timeout_ms: 100, request_id: "legacy-team",
		agents: [{ name: "first", sub_task: "a" }, { name: "second", sub_task: "b" }],
	});
	assert.equal(reservationFp("legacy-team"), "006429304fc0f19bb8b1ee9ca547d339e09b4ceb9edbc1aa7183b9cd52d470c8");
});

function decisionChain(f: ReturnType<typeof fixture>): GenerateRequest {
	return {
		...f.request, topology: "chain", request_id: "review-loop",
		agents: [
			{ persona: "first", node_id: "builder", sub_task: "Build" },
			{
				persona: "second", node_id: "reviewer", sub_task: "Review",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "builder" },
			},
		],
	};
}

test("dry run shows a decision loop with its built-in limits", t => {
	const f = fixture(t);
	const request = decisionChain(f);
	const text = formatPlan(f.service.plan(request));
	assert.match(text, /↺ 1\/4.*↺ 1\/4/);
	assert.match(text, /max_revisions: 3 \(built-in\)/);
	assert.match(text, /max_total_attempts: 8 \(built-in\)/);
	assert.match(text, /loop body: builder, reviewer/);
	assert.match(text, /on_exhausted: needs_attention/);
});

test("launch sets Coms hop limit from the bound attempt budget for agents, not command nodes", async t => {
	const f = fixture(t);
	const decisionRun = await f.service.generate(decisionChain(f));
	assert.equal(decisionRun.status, "applied", decisionRun.error);
	const decisionCreates = f.calls.filter(args => args[0] === "tab" && args[1] === "create");
	assert.equal(decisionCreates.length, 2);
	for (const args of decisionCreates) assert.equal(args.some(arg => arg.startsWith("PI_COMS_MAX_HOPS=")), false);
	for (const instance of ["a1-builder", "a2-reviewer"]) {
		const launcher = readFileSync(join(decisionRun.session_dir, `${instance}.sh`), "utf8");
		assert.match(launcher, /export PI_COMS_MAX_HOPS='10'/, "max_total_attempts=8 must set max(5, 8 + 2)");
	}
	const floorRun = await f.service.generate({ ...f.request, agents: [{ name: "first", sub_task: "Only node" }] });
	assert.equal(floorRun.status, "applied", floorRun.error);
	const floorLauncher = readFileSync(join(floorRun.session_dir, "a1-first.sh"), "utf8");
	assert.match(floorLauncher, /export PI_COMS_MAX_HOPS='5'/, "a one-attempt plan stays at the minimum hop limit of five");

	const commandRequest: GenerateRequest = {
		...f.request,
		topology: "graph",
		agents: [{ kind: "command", node_id: "verify", command: process.execPath, args: ["-e", "process.exit(0)"], sub_task: "Verify" }],
	};
	f.behavior.failCreate = f.calls.filter(args => args[0] === "tab" && args[1] === "create").length + 1;
	const commandRun = await f.service.generate(commandRequest);
	assert.equal(commandRun.status, "error");
	const commandCreate = f.calls.filter(args => args[0] === "tab" && args[1] === "create").at(-1)!;
	assert.equal(commandCreate.some(arg => arg.startsWith("PI_COMS_MAX_HOPS=")), false);
	const commandLauncher = readFileSync(join(commandRun.session_dir, "a1-verify.sh"), "utf8");
	assert.doesNotMatch(commandLauncher, /PI_COMS_MAX_HOPS/);
});

test("plans without a decision loop size the Coms hop limit from the node count", async t => {
	const f = fixture(t);
	const agents = Array.from({ length: 6 }, (_, index) => ({
		persona: index % 2 ? "second" : "first",
		node_id: `node-${index + 1}`,
		sub_task: `Work ${index + 1}`,
	}));
	const run = await f.service.generate({ ...f.request, topology: "graph", agents });
	assert.equal(run.status, "applied", run.error);
	const creates = f.calls.filter(args => args[0] === "tab" && args[1] === "create");
	assert.equal(creates.length, 6);
	for (let index = 0; index < agents.length; index++) {
		const launcher = readFileSync(join(run.session_dir, `a${index + 1}-node-${index + 1}.sh`), "utf8");
		assert.match(launcher, /export PI_COMS_MAX_HOPS='8'/, "six nodes plus two must set the hop limit to eight");
	}
});

test("dry run resolves each decision limit independently and fingerprints resolved changes", t => {
	const f = fixture(t);
	const agentDir = join(f.root, "custom-agent");
	mkdirSync(agentDir);
	const service = new BootstrapService({ ...f.options, env: { ...f.options.env, PI_CODING_AGENT_DIR: agentDir } });
	const projectConfig = join(f.cwd, ".pi", "bootstrap.json");
	writeFileSync(join(agentDir, "bootstrap.json"), JSON.stringify({
		graph: { defaults: { maxRevisions: 2, maxTotalAttempts: 20 }, ceilings: { maxRevisions: 4, maxTotalAttempts: 25 } },
	}));
	const request = decisionChain(f);
	const global = service.plan(request);
	assert.match(formatPlan(global), /max_revisions: 2 \(global\)/);
	assert.match(formatPlan(global), /max_total_attempts: 20 \(global\)/);
	assert.ok(global.fingerprint);

	writeFileSync(projectConfig, JSON.stringify({
		graph: { defaults: { maxRevisions: 3 }, ceilings: { maxRevisions: 6, maxTotalAttempts: 22 } },
	}));
	const project = service.plan(request);
	assert.match(formatPlan(project), /max_revisions: 3 \(project\)/);
	assert.match(formatPlan(project), /max_total_attempts: 20 \(global\)/);
	assert.notEqual(project.fingerprint, global.fingerprint);
	assert.equal(service.plan(request).fingerprint, project.fingerprint);
	const reviewer = request.agents[1];
	reviewer.decision!.max_revisions = 4;
	request.max_total_attempts = 21;
	assert.match(formatPlan(service.plan(request)), /max_revisions: 4 \(request\)/);
	assert.match(formatPlan(service.plan(request)), /max_total_attempts: 21 \(request\)/);
	reviewer.decision!.max_revisions = 5;
	assert.throws(() => service.plan(request), /max_revisions.*ceiling \(4\)/);
	reviewer.decision!.max_revisions = 4;
	request.max_total_attempts = 23;
	assert.throws(() => service.plan(request), /max_total_attempts.*ceiling \(22\)/);
});

test("planning checks malformed graph limits even for a team with no decision", t => {
	const f = fixture(t);
	const path = join(f.cwd, ".pi", "bootstrap.json");
	for (const [graph, key] of [
		[null, "graph"],
		[{ ceiling: {} }, "graph.ceiling"],
		[{ Ceilings: {} }, "graph.Ceilings"],
		[{ defaults: [] }, "graph.defaults"],
		[{ ceilings: { maxTotalAttempts: 1.5 } }, "graph.ceilings.maxTotalAttempts"],
		[{ defaults: { maxRevisions: 3 }, ceilings: { maxRevisions: 2 } }, "graph.defaults.maxRevisions"],
	] as const) {
		writeFileSync(path, JSON.stringify({ graph }));
		assert.throws(() => f.service.plan(f.request), error =>
			error instanceof Error && error.message.includes(path) && error.message.includes(`"${key}"`));
	}
});

test("planning checks the decision contract, feedback target and revision bounds", t => {
	const f = fixture(t);
	const request = decisionChain(f);
	const [builder, reviewer] = request.agents;
	const withDecision = (decision: Partial<NonNullable<typeof reviewer.decision>>) => ({
		...request, agents: [builder, { ...reviewer, decision: { ...reviewer.decision!, ...decision } }],
	});
	assert.throws(() => f.service.plan(withDecision({ on_reject: "reviewer" })), /strict ancestor/);
	assert.throws(() => f.service.plan(withDecision({ on_reject: "nonexistent" })), /strict ancestor/);
	assert.throws(() => f.service.plan(withDecision({ max_revisions: 0 })), /max_revisions.*between 1 and 10/);
	assert.throws(() => f.service.plan(withDecision({ field: "missing" })), /output_contract.*enum/);
	assert.throws(() => f.service.plan(withDecision({ reject: "approve" })), /output_contract.*enum/);
	assert.throws(() => f.service.plan(withDecision({ max_revisions: 11 })), /max_revisions.*between 1 and 10/);
	assert.throws(() => f.service.plan(withDecision({ on_exhausted: "invalid" as "failed" })), /on_exhausted.*needs_attention or failed/);
	assert.throws(() => f.service.plan({
		...request, agents: [builder, { name: "second", sub_task: "Review", decision: reviewer.decision }],
	}), /decision.*node-form chains/);
	assert.throws(() => f.service.plan({ ...request, topology: "team" }), /decision.*node-form chains/);
	assert.throws(() => f.service.plan({ ...request, agents: [
		builder, reviewer, { ...reviewer, node_id: "second-reviewer" },
	] }), /loop bodies overlap/);
});

test("a decision verdict must be a required output field", t => {
	const f = fixture(t);
	const request = decisionChain(f);
	const reviewer = request.agents[1];
	const verdict = reviewer.output_contract!.properties!.verdict;
	reviewer.output_contract = { properties: { verdict } };
	assert.throws(() => f.service.plan(request), /output_contract.*verdict.*required/);

	reviewer.output_contract = { properties: { verdict: { ...verdict, required: true } } };
	assert.match(formatPlan(f.service.plan(request)), /decision: verdict approves/);
});

test("a built-in limit above a ceiling suggests setting a default", t => {
	const f = fixture(t);
	const path = join(f.cwd, ".pi", "bootstrap.json");
	const request = decisionChain(f);
	writeFileSync(path, JSON.stringify({ graph: { ceilings: { maxRevisions: 2 } } }));
	assert.throws(() => f.service.plan(request), /max_revisions.*built-in.*ceiling.*set a default.*graph.defaults.maxRevisions/i);
	writeFileSync(path, JSON.stringify({ graph: { ceilings: { maxTotalAttempts: 7 } } }));
	assert.throws(() => f.service.plan(request), /max_total_attempts.*built-in.*ceiling.*set a default.*graph.defaults.maxTotalAttempts/i);
});
