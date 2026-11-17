/**
 * Explicit live-Herdr suite. Never runs from the default suites: `node bootstrap/run-tests.ts live` with PI_BOOTSTRAP_LIVE_HERDR=1,
 * inside a Herdr pane. Pi config/trust/session/Coms state is still isolated; only the Herdr identity is passed through.
 * These checks are read-only: they never create, move or close tabs. Tab-lifecycle tests belong to later tickets and must stay here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gate, runSupervised, type Capability } from "./test-harness.ts";

const optedIn = process.env.PI_BOOTSTRAP_LIVE_HERDR === "1";
const insideHerdr = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
const live: Capability = !optedIn ? { ok: false, reason: "live Herdr tests require PI_BOOTSTRAP_LIVE_HERDR=1" }
	: !insideHerdr ? { ok: false, reason: "live Herdr tests must run inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)" } : { ok: true };

test("live: the Herdr CLI answers a read-only snapshot from the calling pane", { timeout: 30_000 }, async t => {
	if (!gate(t, live)) return;
	const result = await runSupervised("herdr", ["api", "snapshot"], { timeoutMs: 20_000, env: process.env });
	assert.equal(result.timedOut, false);
	assert.equal(result.code, 0, result.stderr);
	assert.ok(result.stdout.trim().length > 0, "snapshot output");
});
