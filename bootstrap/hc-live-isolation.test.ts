import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSuite } from "./run-tests.ts";

test("hc live CLI environment contains only allowed parent values and scratch settings", { timeout: 5000 }, async t => {
	const { buildHcEnvironment, assertHcEnvironment } = await import("./test-support/hc-live-env.ts");
	const root = mkdtempSync(join(realpathSync(tmpdir()), "bootstrap-hc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const baseline = buildHcEnvironment(root, { PATH: "/usr/bin", LANG: "C" });
	const poisoned = buildHcEnvironment(root, {
		PATH: "/usr/bin", LANG: "C", HOME: "/operator", TMPDIR: "/operator/tmp",
		HC_SESSION: "operator", HC_SOCKET: "/operator/core.sock", HC_RUNTIME: "/operator/run",
		HC_TERMINAL_ID: "operator/t1", HC_FUTURE: "secret",
		XDG_CONFIG_HOME: "/operator/config", XDG_RUNTIME_DIR: "/operator/run",
		XDG_DATA_DIRS: "/operator/data", XDG_FUTURE: "secret",
		HERDR_ENV: "1", HERDR_PANE_ID: "operator", HERDR_FUTURE: "secret",
		API_KEY: "secret", NODE_OPTIONS: "--require=/operator/startup",
	});
	assert.deepEqual(poisoned, baseline);
	assert.equal(poisoned.PATH, "/usr/bin");
	assert.equal(poisoned.LANG, "C");
	assert.match(poisoned.HC_SESSION!, /^bootstrap-hc-/);
	for (const key of ["HOME", "TMPDIR", "HC_SOCKET", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
		"XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
		assert.ok(poisoned[key]?.startsWith(root + "/"), key);
		assert.throws(() => assertHcEnvironment(root, { ...poisoned, [key]: undefined }), /isolation/);
	}
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_SESSION: undefined }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_SOCKET: "/operator/core.sock" }), /isolation/);
	assert.doesNotThrow(() => assertHcEnvironment(root, poisoned));
});

test("hc live file is skipped without its exact opt-in, including when Herdr is enabled", { timeout: 15000 }, async t => {
	const { hcLiveEnabled } = await import("./test-support/hc-live-env.ts");
	assert.equal(hcLiveEnabled({}), false);
	assert.equal(hcLiveEnabled({ PI_BOOTSTRAP_LIVE_HC: "true" }), false);
	assert.equal(hcLiveEnabled({ PI_BOOTSTRAP_LIVE_HC: "1" }), true);
	const dir = mkdtempSync(join(tmpdir(), "hc-gate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "live-hc.test.ts"), 'throw new Error("hc file must not be loaded");');
	writeFileSync(join(dir, "live-herdr.test.ts"), 'import test from "node:test"; test("Herdr fixture", () => {});');
	const env = { PATH: process.env.PATH };
	const neither = await runSuite({ suite: "live", dir, env, timeoutMs: 5000 });
	assert.equal(neither.ran, false);
	assert.match(neither.summary, /PI_BOOTSTRAP_LIVE_HC=1/);
	for (const hc of [undefined, "true"]) {
		const herdr = await runSuite({
			suite: "live", dir, timeoutMs: 5000,
			env: { ...env, PI_BOOTSTRAP_LIVE_HC: hc, PI_BOOTSTRAP_LIVE_HERDR: "1", HERDR_ENV: "1", HERDR_PANE_ID: "fixture" },
		});
		assert.equal(herdr.exitCode, 0, herdr.output);
		assert.deepEqual(herdr.files, ["live-herdr.test.ts"]);
	}
});
