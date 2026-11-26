import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BootstrapService } from "./lifecycle.ts";
import { atomicJson, completionRecord, lockHeld, lockRecordIdentity, processStartTime, readJson, readyPath, resultPath, withRunLock, type WorkerConfig } from "./session-store.ts";
import { cancelPath } from "./cancellation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const contender = join(here, "test-support", "lock-contender.ts");
const launcher = join(here, "test-support", "launch-child.ts");

function run(args: string[], script = contender): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.on("close", code => resolve({ code, stdout, stderr }));
	});
}

test("simultaneous stale-lock contenders never share the critical section", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-race-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let violations = 0;
	for (let round = 0; round < 8; round++) {
		const key = join(root, `run-${round}`);
		// A lock left behind by a dead process (PID far above any live one).
		writeFileSync(`${key}.lock`, JSON.stringify({ pid: 2147483646, instance: "dead", acquired_at: Date.now() - 60_000 }));
		const startAt = String(Date.now() + 400);
		const results = await Promise.all(Array.from({ length: 24 }, () => run([key, join(root, `inside-${round}`), startAt, "2"])));
		for (const result of results) {
			assert.equal(result.code, 0, result.stderr);
			violations += JSON.parse(result.stdout).violations;
		}
		assert.deepEqual(readdirSync(root).filter(file => file.startsWith(`run-${round}`)), [], "no lock or stale artifacts remain");
	}
	assert.equal(violations, 0, "a live holder lost exclusivity during stale-lock recovery");
});

function staleLock(root: string, name: string) {
	const key = join(root, name);
	const record = { pid: 2147483646, instance: "dead", acquired_at: Date.now() - 60_000 };
	writeFileSync(`${key}.lock`, JSON.stringify(record));
	return { key, identity: lockRecordIdentity(`${key}.lock`, record)! };
}

test("a breaker that died mid-recovery is superseded instead of wedging the lock", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-claim-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { key, identity } = staleLock(root, "run");
	writeFileSync(`${key}.lock.break-${identity}-0`, JSON.stringify({ pid: 2147483645, instance: "dead-breaker", acquired_at: Date.now() - 1000 }));
	assert.equal(await withRunLock(key, async () => "ran", 2000), "ran");
	assert.deepEqual(readdirSync(root), [], "lock and recovery claims are cleaned up");
});

test("a live breaker's claim keeps others from touching the stale record until it finishes", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-claim-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { key, identity } = staleLock(root, "run");
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	t.after(() => sleeper.kill());
	const claim = `${key}.lock.break-${identity}-0`;
	writeFileSync(claim, JSON.stringify({ pid: sleeper.pid, instance: "live-breaker", acquired_at: Date.now() }));
	await assert.rejects(withRunLock(key, async () => "ran", 300), /locked by another process/);
	assert.equal(existsSync(`${key}.lock`), true, "the stale record is left to its live breaker");
	rmSync(claim);
	assert.equal(await withRunLock(key, async () => "ran", 2000), "ran");
});

/** A project with two personas and a harmless `pi`/`herdr` on PATH, for dispatcher processes that share one state dir. */
function sharedProject(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-two-process-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const bin = join(root, "bin");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second"]) writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: provider/model\ntools: read\n---\nPersona ${name}\n`);
	const request = { topology: "team" as const, task: "Two process launch", project_cwd: cwd, request_id: "shared-key", ready_timeout_ms: 5000, agents: [{ name: "first", sub_task: "One" }, { name: "second", sub_task: "Two" }] };
	return { root, cwd, bin, stateDir: join(root, "state"), home: join(root, "home"), request };
}

test("two processes launching the same request_id create exactly one fleet", async t => {
	const p = sharedProject(t);
	const startAt = Date.now() + 500;
	// The second dispatcher sends an equivalent plan: reordered keys, different persona-name case.
	const equivalent = { ready_timeout_ms: 5000, request_id: "shared-key", agents: [{ sub_task: "One", name: "FIRST" }, { sub_task: "Two", name: "Second" }], project_cwd: p.cwd, topology: "team", task: "Two process launch" };
	const results = await Promise.all([p.request, equivalent, p.request, equivalent].map(request =>
		run([JSON.stringify({ root: p.root, cwd: p.cwd, home: p.home, stateDir: p.stateDir, bin: p.bin, startAt, holdCreateMs: 50, request })], launcher)));
	const outcomes = results.map(result => { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); });
	for (const outcome of outcomes) assert.equal(outcome.error, undefined);
	assert.equal(new Set(outcomes.map(outcome => outcome.task_id)).size, 1, "every process sees the same run");
	assert.ok(outcomes.every(outcome => outcome.status === "applied"));
	const tabsCreated = readFileSync(join(p.root, "tabs.log"), "utf8").trim().split("\n");
	assert.equal(tabsCreated.length, 2, "one tab per agent, launched once");
	assert.equal(readdirSync(join(p.cwd, ".pi", "agent-sessions")).length, 1, "no orphaned session directory from the losing processes");
	assert.deepEqual(readdirSync(p.stateDir).filter(file => file.endsWith(".lock")), [], "no lock files remain");
});

test("a launcher killed between reservation and release is reconciled by the retry, without a second fleet", async t => {
	const p = sharedProject(t);
	const input = (extra: object) => JSON.stringify({ root: p.root, cwd: p.cwd, home: p.home, stateDir: p.stateDir, bin: p.bin, startAt: 0, request: p.request, ...extra });
	// The first launcher stalls inside its first tab creation (reservation published, nothing released) and is killed.
	const victim = spawn(process.execPath, [launcher, input({ holdCreateMs: 60_000 })], { stdio: "ignore" });
	t.after(() => victim.kill("SIGKILL"));
	const logged = join(p.root, "tabs.log");
	for (let waited = 0; !existsSync(logged); waited += 20) { assert.ok(waited < 10_000, "launcher never reached tab creation"); await new Promise(resolve => setTimeout(resolve, 20)); }
	victim.kill("SIGKILL");
	await new Promise(resolve => victim.once("close", resolve));
	const retry = await run([input({})], launcher);
	assert.equal(retry.code, 0, retry.stderr);
	const outcome = JSON.parse(retry.stdout);
	assert.equal(outcome.error, undefined);
	assert.equal(outcome.status, "error");
	assert.equal(outcome.phase, "interrupted");
	assert.equal(readFileSync(logged, "utf8").trim().split("\n").length, 1, "the retry did not launch again");
	// The reconciliation told any waiting children to stop.
	const [taskId] = readdirSync(join(p.cwd, ".pi", "agent-sessions"));
	assert.equal(existsSync(join(p.cwd, ".pi", "agent-sessions", taskId, "abort.json")), true);
	assert.equal(existsSync(join(p.cwd, ".pi", "agent-sessions", taskId, "release.json")), false);
});

test("lock ownership: another runtime instance in this process is live, a recycled PID is stale", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const key = join(root, "run");
	// A /reload gives the module a new identity; the old instance may still be mid-launch in this very process.
	writeFileSync(`${key}.lock`, JSON.stringify({ pid: process.pid, start_time: processStartTime(process.pid), instance: "previous-module-instance", acquired_at: Date.now() }));
	assert.equal(lockHeld(key), true);
	await assert.rejects(withRunLock(key, async () => "ran", 200), /locked by another process/);
	assert.equal(existsSync(`${key}.lock`), true, "a live holder's lock is never removed");
	// The same PID with a different kernel start time is a different process: the lock is stale.
	if (processStartTime(process.pid) !== undefined) {
		writeFileSync(`${key}.lock`, JSON.stringify({ pid: process.pid, start_time: "1", instance: "recycled", acquired_at: Date.now() }));
		assert.equal(await withRunLock(key, async () => "ran", 2000), "ran");
	}
});

test("cancelling a launch waiting on a contended run lock rejects promptly and creates nothing", async t => {
	const p = sharedProject(t);
	const service = new BootstrapService({ exec: async () => { throw new Error("Herdr must not be used by a cancelled launch"); }, extensionDir: dirname(here), stateDir: p.stateDir, home: p.home, env: { PATH: p.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" } });
	const lockKey = join(p.stateDir, createHash("sha256").update(p.request.request_id).digest("hex"));

	// In-process queue wait: holder keeps lock while aborted generate() settles immediately.
	let releaseHolder!: () => void;
	const holder = withRunLock(lockKey, () => new Promise<void>(resolve => { releaseHolder = resolve; }));
	await new Promise(resolve => setTimeout(resolve, 20));
	const inProcBefore = readFileSync(`${lockKey}.lock`);
	const inProcController = new AbortController();
	const t0 = Date.now();
	const inProcLaunch = service.generate(p.request, undefined, inProcController.signal);
	setTimeout(() => inProcController.abort(), 50);
	await assert.rejects(inProcLaunch, /Bootstrap cancelled/);
	assert.ok(Date.now() - t0 < 1000, "cancelled launch stopped waiting promptly on in-process queue");
	assert.deepEqual(readFileSync(`${lockKey}.lock`), inProcBefore, "holder lock file stayed byte-for-byte intact");
	releaseHolder();
	await holder;
	assert.equal(existsSync(join(p.cwd, ".pi", "agent-sessions")), false, "no session directory");
	assert.deepEqual(readdirSync(p.stateDir).filter(file => file.startsWith("request-") || file.endsWith(".json")), [], "no reservation or run record");

	// Cross-process polling wait: another live process holds the lock file.
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	t.after(() => sleeper.kill());
	mkdirSync(p.stateDir, { recursive: true });
	writeFileSync(`${lockKey}.lock`, JSON.stringify({ pid: sleeper.pid, instance: "other-party", acquired_at: Date.now() }));
	const crossBefore = readFileSync(`${lockKey}.lock`);
	const crossController = new AbortController();
	const t1 = Date.now();
	const crossLaunch = service.generate(p.request, undefined, crossController.signal);
	setTimeout(() => crossController.abort(), 60);
	await assert.rejects(crossLaunch, /Bootstrap cancelled/);
	assert.ok(Date.now() - t1 < 1000, "cancelled launch stopped waiting promptly on cross-process lock");
	assert.deepEqual(readFileSync(`${lockKey}.lock`), crossBefore, "contended lock file stayed byte-for-byte intact");
	assert.deepEqual(readdirSync(p.stateDir).filter(file => file.includes(".break-")), [], "no break files created");
	assert.equal(existsSync(join(p.cwd, ".pi", "agent-sessions")), false, "no session directory");
	assert.deepEqual(readdirSync(p.stateDir).filter(file => file.startsWith("request-") || file.endsWith(".json")), [], "no reservation or run record");
});

test("withRunLock in-process queue wait cancels promptly without touching lock or breaking mutual exclusion", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-queue-abort-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const key = join(root, "run");

	let releaseHolder!: () => void;
	let holderReleased = false;
	const holder = withRunLock(key, () => new Promise<void>(resolve => {
		releaseHolder = () => { holderReleased = true; resolve(); };
	}));
	await new Promise(resolve => setTimeout(resolve, 20));
	const lockBytes = readFileSync(`${key}.lock`);

	const controller = new AbortController();
	let ran1 = false;
	let ran2 = false;
	const waiter1 = withRunLock(key, async () => { ran1 = true; return "one"; }, 5000, controller.signal);
	const waiter2 = withRunLock(key, async () => {
		assert.equal(holderReleased, true, "uncancelled waiter must not enter before holder finishes");
		ran2 = true;
		return "two";
	}, 5000);

	await new Promise(resolve => setTimeout(resolve, 30));
	const start = Date.now();
	controller.abort();
	await assert.rejects(waiter1, /Bootstrap cancelled/);
	assert.ok(Date.now() - start < 500, "in-process waiter rejected promptly on abort");
	assert.equal(ran1, false);

	// Give the event loop time to make sure waiter2 does not prematurely wake while holder is still active.
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(ran2, false, "uncancelled waiter behind cancelled waiter still waits for holder");
	assert.deepEqual(readFileSync(`${key}.lock`), lockBytes, "lock file stayed byte-for-byte intact");
	assert.deepEqual(readdirSync(root), ["run.lock"]);

	releaseHolder();
	await holder;
	assert.equal(await waiter2, "two");
	assert.equal(ran2, true);
	assert.deepEqual(readdirSync(root), [], "lock file cleaned up after uncancelled waiter finished");
});

test("withRunLock polling-sleep wait cancels promptly and leaves lock and break files byte-for-byte intact", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-poll-abort-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Case A: live lock held by another process.
	const liveKey = join(root, "live");
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	t.after(() => sleeper.kill());
	writeFileSync(`${liveKey}.lock`, JSON.stringify({ pid: sleeper.pid, instance: "other-party", acquired_at: Date.now() }));
	const liveLockBytes = readFileSync(`${liveKey}.lock`);

	const liveController = new AbortController();
	let liveRan = false;
	const tLive = Date.now();
	const liveWait = withRunLock(liveKey, async () => { liveRan = true; return "live"; }, 5000, liveController.signal);
	setTimeout(() => liveController.abort(), 80);
	await assert.rejects(liveWait, /Bootstrap cancelled/);
	assert.ok(Date.now() - tLive < 500, "polling waiter rejected promptly on abort");
	assert.equal(liveRan, false);
	assert.deepEqual(readFileSync(`${liveKey}.lock`), liveLockBytes, "live lock file remained byte-for-byte intact");
	assert.deepEqual(readdirSync(root).filter(f => f.startsWith("live.")), ["live.lock"]);

	// Once the other party releases the lock, an uncancelled waiter acquires it.
	rmSync(`${liveKey}.lock`);
	assert.equal(await withRunLock(liveKey, async () => "acquired", 1000), "acquired");

	// Case B: stale lock with a live breaker claim file (polling sleep after breakStaleLock returns false).
	const breakKey = join(root, "breaking");
	const staleRecord = { pid: 2147483646, instance: "dead", acquired_at: Date.now() - 60_000 };
	writeFileSync(`${breakKey}.lock`, JSON.stringify(staleRecord));
	const identity = lockRecordIdentity(`${breakKey}.lock`, staleRecord)!;
	const claimPath = `${breakKey}.lock.break-${identity}-0`;
	writeFileSync(claimPath, JSON.stringify({ pid: sleeper.pid, instance: "live-breaker", acquired_at: Date.now() }));
	const staleBytes = readFileSync(`${breakKey}.lock`);
	const claimBytes = readFileSync(claimPath);

	const breakController = new AbortController();
	let breakRan = false;
	const tBreak = Date.now();
	const breakWait = withRunLock(breakKey, async () => { breakRan = true; return "break"; }, 5000, breakController.signal);
	setTimeout(() => breakController.abort(), 80);
	await assert.rejects(breakWait, /Bootstrap cancelled/);
	assert.ok(Date.now() - tBreak < 500, "polling waiter behind live breaker rejected promptly on abort");
	assert.equal(breakRan, false);
	assert.deepEqual(readFileSync(`${breakKey}.lock`), staleBytes, "stale lock file stayed byte-for-byte intact");
	assert.deepEqual(readFileSync(claimPath), claimBytes, "break file stayed byte-for-byte intact");
	assert.deepEqual(readdirSync(root).filter(f => f.startsWith("breaking.")).sort(), ["breaking.lock", `breaking.lock.break-${identity}-0`]);
});

test("withRunLock with an already-aborted signal leaves stale locks and break files byte-for-byte intact", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lock-preaborted-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const key = join(root, "stale");
	const staleRecord = { pid: 2147483646, instance: "dead", acquired_at: Date.now() - 60_000 };
	writeFileSync(`${key}.lock`, JSON.stringify(staleRecord));
	const identity = lockRecordIdentity(`${key}.lock`, staleRecord)!;
	const claimPath = `${key}.lock.break-${identity}-0`;
	writeFileSync(claimPath, JSON.stringify({ pid: 2147483645, instance: "dead-breaker", acquired_at: Date.now() - 1000 }));
	const staleBytes = readFileSync(`${key}.lock`);
	const claimBytes = readFileSync(claimPath);

	let ran = false;
	await assert.rejects(withRunLock(key, async () => { ran = true; }, 5000, AbortSignal.abort()), /Bootstrap cancelled/);
	assert.equal(ran, false);
	assert.deepEqual(readFileSync(`${key}.lock`), staleBytes, "stale lock was not broken or removed");
	assert.deepEqual(readFileSync(claimPath), claimBytes, "dead breaker claim was not broken or removed");
	assert.deepEqual(readdirSync(root).sort(), ["stale.lock", `stale.lock.break-${identity}-0`]);

	const nestedKey = join(root, "never-created", "run");
	await assert.rejects(withRunLock(nestedKey, async () => { ran = true; }, 5000, AbortSignal.abort()), /Bootstrap cancelled/);
	assert.equal(existsSync(join(root, "never-created")), false, "already-aborted lock wait creates no directories");
});

test("BootstrapService callers pass cancellation signal through to contended run-lock wait", async t => {
	const p = sharedProject(t);
	let seq = 0;
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	const exec = async (_command: string, args: string[]) => {
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(tb => tb.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(p.cwd, ".pi", "agent-sessions", task);
			const config = JSON.parse(readFileSync(join(sessionDir, `${instance}.config.json`), "utf8")) as WorkerConfig;
			const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
			atomicJson(readyPath(sessionDir, instance), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({ exec, extensionDir: dirname(here), stateDir: p.stateDir, home: p.home, env: { PATH: p.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" }, pollMs: 5 });

	const teamRun = await service.generate({ topology: "team", task: "Team lock test", project_cwd: p.cwd, agents: [{ node_id: "first", persona: "first", sub_task: "One" }] }, { provider: "provider", id: "model" });
	const chainRun = await service.generate({ topology: "chain", task: "Chain lock test", project_cwd: p.cwd, agents: [{ node_id: "first", persona: "first", sub_task: "One" }, { node_id: "second", persona: "second", sub_task: "Two" }] }, { provider: "provider", id: "model" });
	const graphRun = await service.generate({ topology: "graph", task: "Graph lock test", project_cwd: p.cwd, cleanup: "on_success", cleanup_settle_ms: 0, agents: [{ node_id: "first", persona: "first", sub_task: "One" }] }, { provider: "provider", id: "model" });
	// Complete the graph run so statusWithCleanup() tries to take the run lock for automatic cleanup.
	const gEntry = graphRun.pane_manifest[0];
	const gConfig = readJson<WorkerConfig>(join(graphRun.session_dir, `${gEntry.instance_id}.config.json`));
	atomicJson(resultPath(graphRun.session_dir, gEntry.instance_id), completionRecord(
		gConfig,
		{ status: "success", summary: "done" },
		"not_required",
		new Date(Date.now() - 10_000).toISOString(),
	));
	assert.equal(service.status(graphRun.task_id, p.cwd).outcome.state, "succeeded");

	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	t.after(() => sleeper.kill());
	const holdLock = (taskId: string) => {
		const lockPath = `${join(p.stateDir, taskId)}.lock`;
		writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, instance: "other-party", acquired_at: Date.now() }));
		return { lockPath, bytes: readFileSync(lockPath) };
	};
	const cancelHold = holdLock(teamRun.task_id);
	const chainHold = holdLock(chainRun.task_id);
	const graphHold = holdLock(graphRun.task_id);

	const abortSoon = () => { const c = new AbortController(); setTimeout(() => c.abort(), 60); return c.signal; };

	// cancel() with held lock (also check pre-release cancel is skipped when already aborted).
	const tCancel = Date.now();
	await assert.rejects(service.cancel(teamRun.task_id, { cwd: p.cwd, signal: abortSoon() }), /Bootstrap cancelled/);
	assert.ok(Date.now() - tCancel < 500, "cancel stopped waiting promptly");
	assert.deepEqual(readFileSync(cancelHold.lockPath), cancelHold.bytes);
	assert.equal(existsSync(cancelPath(teamRun.session_dir, teamRun.pane_manifest[0].instance_id)), false);

	// Launching run with held lock and already-aborted cancel() must not write pre-release abort/cancel files.
	const indexFile = join(p.stateDir, `${teamRun.task_id}.json`);
	atomicJson(indexFile, { ...JSON.parse(readFileSync(indexFile, "utf8")), status: "launching", phase: "waiting-ready" });
	await assert.rejects(service.cancel(teamRun.task_id, { cwd: p.cwd, signal: AbortSignal.abort() }), /Bootstrap cancelled/);
	assert.equal(existsSync(join(teamRun.session_dir, "abort.json")), false, "already-aborted cancel did not write abort.json");
	assert.equal(existsSync(cancelPath(teamRun.session_dir, teamRun.pane_manifest[0].instance_id)), false, "already-aborted cancel did not write cancel.json");
	assert.deepEqual(readFileSync(cancelHold.lockPath), cancelHold.bytes);

	// cleanup() with held lock.
	const tCleanup = Date.now();
	await assert.rejects(service.cleanup(teamRun.task_id, undefined, false, p.cwd, abortSoon()), /Bootstrap cancelled/);
	assert.ok(Date.now() - tCleanup < 500, "cleanup stopped waiting promptly");
	assert.deepEqual(readFileSync(cancelHold.lockPath), cancelHold.bytes);

	// recover() retry_delivery with held lock.
	const tRecover = Date.now();
	await assert.rejects(service.recover(chainRun.task_id, { action: "retry_delivery", agent: "second" }, { cwd: p.cwd, signal: abortSoon() }), /Bootstrap cancelled/);
	assert.ok(Date.now() - tRecover < 500, "recover stopped waiting promptly");
	assert.deepEqual(readFileSync(chainHold.lockPath), chainHold.bytes);

	// report() with held lock.
	const tReport = Date.now();
	await assert.rejects(service.report(teamRun.task_id, [{ node_id: "first", status: "success", summary: "ok" }], false, () => "", p.cwd, abortSoon()), /Bootstrap cancelled/);
	assert.ok(Date.now() - tReport < 500, "report stopped waiting promptly");
	assert.deepEqual(readFileSync(cancelHold.lockPath), cancelHold.bytes);

	// statusWithCleanup() with held lock.
	const tStatus = Date.now();
	await assert.rejects(Promise.resolve(service.statusWithCleanup(graphRun.task_id, p.cwd, undefined, abortSoon())), /Bootstrap cancelled/);
	assert.ok(Date.now() - tStatus < 500, "statusWithCleanup stopped waiting promptly");
	assert.deepEqual(readFileSync(graphHold.lockPath), graphHold.bytes);
});
