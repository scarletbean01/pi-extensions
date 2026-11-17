import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVerification, projectFingerprint, readVerification, runCheck, verificationPath } from "./verification.ts";
import { evaluateEvidence } from "./outcomes.ts";
import { gate, probeCommand } from "./test-harness.ts";

const spawnReady = await probeCommand("/bin/sh", ["-c", "exit 0"]);
const identity = { node_id: "impl", attempt_id: "a1-impl.1", instance_id: "a1-impl" };

function project(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-verify-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, ".pi", "agent-sessions", "run"), { recursive: true });
	writeFileSync(join(root, "src", "a.txt"), "one");
	return root;
}

test("the project fingerprint follows content, including new untracked files, and ignores the run's own session files", t => {
	const root = project(t);
	const base = projectFingerprint(root);
	assert.equal(typeof base.digest, "string");
	assert.deepEqual(projectFingerprint(root), base, "stable while nothing changes");
	writeFileSync(join(root, ".pi", "agent-sessions", "run", "x.json"), "{}");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(join(root, ".git", "HEAD"), "ref");
	assert.deepEqual(projectFingerprint(root), base, "session files and .git do not count");
	writeFileSync(join(root, "src", "a.txt"), "two");
	const edited = projectFingerprint(root);
	assert.notEqual(edited.digest, base.digest, "an edit changes it");
	writeFileSync(join(root, "src", "a.txt"), "one");
	assert.equal(projectFingerprint(root).digest, base.digest, "content, not modification time");
	writeFileSync(join(root, "src", "new.txt"), "untracked input");
	assert.notEqual(projectFingerprint(root).digest, base.digest, "a new untracked file counts");
});

test("a scope narrows what is relevant, and a deletion inside it counts", t => {
	const root = project(t);
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "readme.txt"), "docs");
	const scoped = projectFingerprint(root, ["src"]);
	writeFileSync(join(root, "docs", "readme.txt"), "changed docs");
	assert.equal(projectFingerprint(root, ["src"]).digest, scoped.digest, "edits outside the scope are not relevant");
	writeFileSync(join(root, "src", "a.txt"), "changed");
	assert.notEqual(projectFingerprint(root, ["src"]).digest, scoped.digest);
	const single = projectFingerprint(root, ["src/a.txt"]);
	rmSync(join(root, "src", "a.txt"));
	assert.notEqual(projectFingerprint(root, ["src/a.txt"]).digest, single.digest, "a removed file is a change");
});

test("a symlink is fingerprinted by what it points at, never followed", t => {
	const root = project(t);
	symlinkSync("/nonexistent-target", join(root, "link"));
	const before = projectFingerprint(root);
	assert.equal(typeof before.digest, "string");
	rmSync(join(root, "link"));
	symlinkSync("/other-target", join(root, "link"));
	assert.notEqual(projectFingerprint(root).digest, before.digest);
});

test("relevance that cannot be determined is reported as unknown, not guessed", t => {
	const root = project(t);
	writeFileSync(join(root, "src", "b.txt"), "two");
	const tooBig = projectFingerprint(root, undefined, { maxFiles: 1 });
	assert.equal(tooBig.digest, null);
	assert.match(tooBig.reason!, /more than 1 files/);
	assert.equal(projectFingerprint(root, ["../outside"]).digest, null, "a scope outside the project is not determinable");
	assert.equal(projectFingerprint(join(root, "missing")).digest, null);
});

test("a check records its command, exit status, identity and the project state before and after", async t => {
	if (!gate(t, spawnReady)) return;
	const root = project(t);
	const passed = await runCheck({ name: "tests", command: "echo ok" }, { cwd: root, ...identity });
	assert.equal(passed.result, "passed");
	assert.equal(passed.exit_code, 0);
	assert.equal(passed.check, "tests");
	assert.equal(passed.node_id, "impl");
	assert.equal(passed.attempt_id, "a1-impl.1");
	assert.match(passed.output_tail, /ok/);
	assert.equal(passed.before, passed.after);
	assert.equal(evaluateEvidence("tests", [passed], projectFingerprint(root).digest), "passing");
	const failed = await runCheck({ name: "tests", command: "echo broken >&2; exit 3" }, { cwd: root, ...identity });
	assert.equal(failed.result, "failed");
	assert.equal(failed.exit_code, 3);
	assert.match(failed.output_tail, /broken/);
});

test("a check that changes the project while it runs is not usable evidence", async t => {
	if (!gate(t, spawnReady)) return;
	const root = project(t);
	const record = await runCheck({ name: "tests", command: "echo more >> src/a.txt" }, { cwd: root, ...identity });
	assert.equal(record.result, "passed");
	assert.notEqual(record.before, record.after);
	assert.equal(evaluateEvidence("tests", [record], record.after), "unverified");
});

test("a check outside its scope's edits stays current, and one that cannot be fingerprinted is unverified", async t => {
	if (!gate(t, spawnReady)) return;
	const root = project(t);
	const record = await runCheck({ name: "lint", command: "true", scope: ["src"] }, { cwd: root, ...identity });
	writeFileSync(join(root, "unrelated.txt"), "x");
	assert.equal(evaluateEvidence("lint", [record], projectFingerprint(root, ["src"]).digest), "passing");
	writeFileSync(join(root, "src", "a.txt"), "edited later");
	assert.equal(evaluateEvidence("lint", [record], projectFingerprint(root, ["src"]).digest), "stale");
	const unknown = await runCheck({ name: "huge", command: "true" }, { cwd: root, ...identity, limits: { maxFiles: 1 } });
	assert.equal(unknown.before, null);
	assert.match(unknown.unknown_reason!, /more than 1 files/);
	assert.equal(evaluateEvidence("huge", [unknown], projectFingerprint(root).digest), "unverified");
});

test("a check that exceeds its time limit fails with that reason instead of hanging", async t => {
	if (!gate(t, spawnReady)) return;
	const root = project(t);
	const started = Date.now();
	const record = await runCheck({ name: "slow", command: "sleep 30", timeout_ms: 100 }, { cwd: root, ...identity });
	assert.ok(Date.now() - started < 10_000);
	assert.equal(record.result, "failed");
	assert.equal(record.exit_code, null);
	assert.match(record.output_tail, /timed out after 100ms/);
});

test("evidence history is appended, never replaced, and read through a versioned reader", async t => {
	if (!gate(t, spawnReady)) return;
	const root = project(t);
	const path = verificationPath(root, "a1-impl");
	assert.deepEqual(readVerification(path), [], "no evidence yet");
	appendVerification(path, await runCheck({ name: "tests", command: "exit 1" }, { cwd: root, ...identity }));
	appendVerification(path, await runCheck({ name: "tests", command: "true" }, { cwd: root, ...identity }));
	const records = readVerification(path);
	assert.deepEqual(records.map(record => record.result), ["failed", "passed"]);
	writeFileSync(path, JSON.stringify({ version: 9, records: [] }));
	assert.throws(() => readVerification(path), /Unsupported verification record version 9/);
	writeFileSync(path, "{torn");
	assert.throws(() => readVerification(path), /unreadable/i);
});
