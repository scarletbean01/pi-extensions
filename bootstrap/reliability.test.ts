import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BootstrapService } from "./lifecycle.ts";
import { lockHeld, lockRecordIdentity, processStartTime, withRunLock } from "./session-store.ts";

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
	for (const name of ["first", "second"]) writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read\n---\nPersona ${name}\n`);
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

test("cancellation is not observed while waiting for a run lock; the cancelled launch then creates nothing", async t => {
	const p = sharedProject(t);
	const service = new BootstrapService({ exec: async () => { throw new Error("Herdr must not be used by a cancelled launch"); }, extensionDir: dirname(here), stateDir: p.stateDir, home: p.home, env: { PATH: p.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" } });
	const lockKey = join(p.stateDir, createHash("sha256").update(p.request.request_id).digest("hex"));
	let releaseHolder!: () => void;
	const holder = withRunLock(lockKey, () => new Promise<void>(resolve => { releaseHolder = resolve; }));
	await new Promise(resolve => setTimeout(resolve, 20));
	const controller = new AbortController();
	let settled = false;
	const launch = service.generate(p.request, undefined, controller.signal).finally(() => { settled = true; });
	launch.catch(() => {});
	await new Promise(resolve => setTimeout(resolve, 150));
	controller.abort();
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(settled, false, "documented: an abort only takes effect once the lock is acquired");
	releaseHolder();
	await holder;
	await assert.rejects(launch, /Bootstrap cancelled/);
	assert.equal(existsSync(join(p.cwd, ".pi", "agent-sessions")), false, "no session directory");
	assert.deepEqual(readdirSync(p.stateDir).filter(file => file.startsWith("request-") || file.endsWith(".json")), [], "no reservation or run record");
});
