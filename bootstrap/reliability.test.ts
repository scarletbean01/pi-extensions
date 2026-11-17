import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockRecordIdentity, withRunLock } from "./session-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const contender = join(here, "test-support", "lock-contender.ts");

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn(process.execPath, [contender, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
