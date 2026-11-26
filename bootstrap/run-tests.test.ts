/** The suite runner: one command per suite, isolated state, honest reporting, and no leaked children. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTestFile, runSuite, suiteFiles, SUITES } from "./run-tests.ts";
import { gate, probeCommand } from "./test-harness.ts";

const spawnReady = await probeCommand(process.execPath, ["-e", "0"]);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fixtureDir(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "run-tests-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}
const passing = `import test from "node:test"; test("ok", () => {});`;
const quiet = { write: () => {} };

test("test files are split by name into deterministic, runtime and live suites", () => {
	assert.deepEqual(SUITES, ["deterministic", "runtime", "live"]);
	assert.equal(classifyTestFile("lifecycle.test.ts"), "deterministic");
	assert.equal(classifyTestFile("run-tests.test.ts"), "deterministic");
	assert.equal(classifyTestFile("runtime-smoke.test.ts"), "runtime");
	assert.equal(classifyTestFile("runtime-isolation.test.ts"), "runtime");
	assert.equal(classifyTestFile("live-herdr.test.ts"), "live");
	assert.equal(classifyTestFile("session-store.ts"), undefined);
	const real = new URL(".", import.meta.url).pathname;
	const all = SUITES.flatMap(suite => suiteFiles(real, suite));
	assert.equal(new Set(all).size, all.length, "no file belongs to two suites");
	assert.ok(suiteFiles(real, "deterministic").includes("lifecycle.test.ts"));
	assert.ok(suiteFiles(real, "runtime").includes("runtime-smoke.test.ts"));
	assert.deepEqual(suiteFiles(real, "live"), ["live-hc.test.ts", "live-herdr.test.ts"]);
});

test("a suite runs on isolated Pi state and passes through its exit status", { timeout: 60_000 }, async t => {
	if (!gate(t, spawnReady)) return;
	const dir = fixtureDir(t, {
		"a.test.ts": `import test from "node:test"; import assert from "node:assert/strict"; import { homedir } from "node:os";
			test("env is isolated", () => { assert.match(process.env.PI_CODING_AGENT_DIR, /bootstrap-host-/); assert.match(homedir(), /bootstrap-host-/); assert.equal(process.env.OPENAI_API_KEY, undefined); });`,
		"runtime-b.test.ts": `import test from "node:test"; test("must not run in deterministic", () => { throw new Error("wrong suite"); });`,
	});
	const result = await runSuite({ suite: "deterministic", dir, env: { ...process.env, OPENAI_API_KEY: "leak-me" }, timeoutMs: 30_000, out: quiet });
	assert.equal(result.exitCode, 0, result.output);
	assert.deepEqual(result.files, ["a.test.ts"]);
	assert.deepEqual(result.leaks, []);
	assert.equal(result.timedOut, false);
	assert.equal(existsSync(result.isolatedRoot), false, "temporary state is removed afterwards");
	const failing = fixtureDir(t, { "f.test.ts": `import test from "node:test"; test("bad", () => { throw new Error("nope"); });` });
	assert.notEqual((await runSuite({ suite: "deterministic", dir: failing, timeoutMs: 30_000, out: quiet })).exitCode, 0);
});

test("skipped tests are reported as unverified and fail strict runs", { timeout: 60_000 }, async t => {
	if (!gate(t, spawnReady)) return;
	const dir = fixtureDir(t, { "s.test.ts": `import test from "node:test"; test("needs pi", { skip: "UNVERIFIED: pi not found" }, () => {}); test("real", () => {});` });
	const laxEnv = { ...process.env };
	delete laxEnv.PI_BOOTSTRAP_TEST_STRICT;
	const lax = await runSuite({ suite: "deterministic", dir, env: laxEnv, timeoutMs: 30_000, out: quiet });
	assert.equal(lax.exitCode, 0);
	assert.equal(lax.skipped, 1);
	assert.match(lax.summary, /UNVERIFIED.*1 .*skipped/is);
	const strict = await runSuite({ suite: "deterministic", dir, timeoutMs: 30_000, strict: true, out: quiet });
	assert.notEqual(strict.exitCode, 0);
	assert.match(strict.summary, /strict/i);
});

test("writes outside the isolated state, into the user's HOME, fail the suite", { timeout: 60_000 }, async t => {
	if (!gate(t, spawnReady)) return;
	const dir = fixtureDir(t, { "leak.test.ts": `import test from "node:test"; import { mkdirSync, writeFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
		test("writes to home", () => { mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true }); writeFileSync(join(homedir(), ".pi", "agent", "trust.json"), "{}"); });` });
	const result = await runSuite({ suite: "deterministic", dir, timeoutMs: 30_000, out: quiet });
	assert.notEqual(result.exitCode, 0);
	assert.deepEqual(result.leaks, [join(".pi", "agent", "trust.json")]);
	assert.match(result.summary, /leak.*trust\.json/is);
});

test("a suite that exceeds its timeout is killed with every descendant", { timeout: 60_000 }, async t => {
	if (!gate(t, spawnReady)) return;
	const pidFile = join(tmpdir(), `run-tests-pid-${process.pid}`);
	t.after(() => rmSync(pidFile, { force: true }));
	const dir = fixtureDir(t, { "hang.test.ts": `import test from "node:test"; import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
		test("hangs", async () => { const c = spawn("sleep", ["120"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); await new Promise(() => setInterval(() => {}, 1000)); });` });
	const started = Date.now();
	const result = await runSuite({ suite: "deterministic", dir, timeoutMs: 3000, graceMs: 200, out: quiet });
	assert.equal(result.timedOut, true);
	assert.notEqual(result.exitCode, 0);
	assert.match(result.summary, /timed out/i);
	assert.ok(Date.now() - started < 20_000);
	const pid = Number(readFileSync(pidFile, "utf8"));
	for (let i = 0; i < 100 && alive(pid); i++) await new Promise(r => setTimeout(r, 50));
	assert.equal(alive(pid), false, "grandchild sleep must be gone");
});

test("the live Herdr suite never runs without an explicit opt-in and says why", { timeout: 60_000 }, async t => {
	if (!gate(t, spawnReady)) return;
	const dir = fixtureDir(t, { "live-x.test.ts": `import test from "node:test"; test("touches herdr", () => { throw new Error("must not run"); });` });
	const env = { ...process.env }; delete env.PI_BOOTSTRAP_LIVE_HERDR; delete env.PI_BOOTSTRAP_TEST_STRICT;
	const result = await runSuite({ suite: "live", dir, env, timeoutMs: 30_000, out: quiet });
	assert.equal(result.ran, false);
	assert.equal(result.exitCode, 0);
	assert.match(result.summary, /UNVERIFIED.*PI_BOOTSTRAP_LIVE_HERDR=1/s);
	const strict = await runSuite({ suite: "live", dir, env, timeoutMs: 30_000, strict: true, out: quiet });
	assert.notEqual(strict.exitCode, 0);
});
