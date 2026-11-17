import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CANCEL_VERSION,
	DEFAULT_CANCEL_GRACE_MS,
	DEFAULT_DEPENDENCY_WAIT_MS,
	DEFAULT_LIVENESS_MS,
	cancelPath,
	claimOutcome,
	computeDownstreamBlockers,
	diagnoseLiveness,
	graceRemainingMs,
	outcomeClaimPath,
	parseCancelRecord,
	parseOutcomeClaim,
	parseRunCancelRecord,
	runCancelPath,
	writeCancelRecord,
	writeRunCancelRecord,
} from "./cancellation.ts";
import { atomicJson, readJson } from "./session-store.ts";

function tempDir(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "bootstrap-cancel-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const sampleIdentity = {
	run_id: "run-1",
	node_id: "n1",
	persona_name: "worker",
	attempt_id: "a1-n1.1",
	instance_id: "a1-n1",
};

test("cancel records use versioned readers, validate identity, and keep a compatibility fixture readable", t => {
	const dir = tempDir(t);
	const written = writeCancelRecord(dir, {
		identity: sampleIdentity,
		scope: "node",
		reason: "Stop node",
		requestedAt: "2026-11-17T10:00:00.000Z",
		graceMs: 5000,
	});
	assert.equal(written.version, CANCEL_VERSION);
	assert.equal(written.force_close_after, "2026-11-17T10:00:05.000Z");

	const loaded = parseCancelRecord(readJson(cancelPath(dir, "a1-n1")), sampleIdentity);
	assert.deepEqual(loaded, written);

	// Frozen version 1 compatibility fixture.
	const fixture = {
		version: 1,
		identity: { ...sampleIdentity },
		scope: "run",
		reason: "Run cancelled by user",
		requested_at: "2026-01-01T00:00:00.000Z",
		grace_ms: 5000,
		force_close_after: "2026-01-01T00:00:05.000Z",
	};
	assert.equal(parseCancelRecord(fixture, sampleIdentity).scope, "run");

	// Version 1 runs without attempt_id are still accepted when expected attempt_id is absent.
	const v1Identity = { run_id: "run-1", node_id: "first", persona_name: "first", instance_id: "a1-first" };
	assert.equal(parseCancelRecord({ ...fixture, identity: v1Identity }, v1Identity).identity.attempt_id, undefined);

	// Unsupported versions and identity mismatches fail closed without modifying files.
	const file = cancelPath(dir, "a1-n1");
	const untouched = readFileSync(file, "utf8");
	assert.throws(() => parseCancelRecord({ ...fixture, version: 9 }, sampleIdentity), /Unsupported cancel record version 9/);
	assert.throws(() => parseCancelRecord({ ...fixture, identity: { ...sampleIdentity, node_id: "other" } }, sampleIdentity), /cancel identity mismatch/);
	assert.throws(() => parseCancelRecord({ ...fixture, identity: { ...sampleIdentity, run_id: "other-run" } }, sampleIdentity), /cancel identity mismatch/);
	assert.throws(() => parseCancelRecord({ ...fixture, identity: { ...sampleIdentity, attempt_id: "a1-n1.2" } }, sampleIdentity), /cancel identity mismatch/);
	assert.equal(readFileSync(file, "utf8"), untouched);

	const runCancel = writeRunCancelRecord(dir, { run_id: "run-1", reason: "Stop all", requestedAt: "2026-11-17T10:00:00.000Z", graceMs: DEFAULT_CANCEL_GRACE_MS });
	assert.equal(parseRunCancelRecord(readJson(runCancelPath(dir)), "run-1").reason, "Stop all");
	assert.throws(() => parseRunCancelRecord({ ...runCancel, version: 2 }, "run-1"), /Unsupported run cancel record version 2/);
	assert.throws(() => parseRunCancelRecord({ ...runCancel, run_id: "other" }, "run-1"), /run cancel identity mismatch/);
});

test("outcome claim arbitrates completion versus cancellation exclusively using link(2)", t => {
	const dir = tempDir(t);
	const first = claimOutcome(dir, sampleIdentity, "cancelled", "2026-11-17T10:00:00.000Z");
	assert.equal(first.won, true);
	assert.equal(first.claim.outcome, "cancelled");

	const second = claimOutcome(dir, sampleIdentity, "completed", "2026-11-17T10:00:00.001Z");
	assert.equal(second.won, false);
	assert.equal(second.claim.outcome, "cancelled");

	// Separate instance arbitrates independently and completion wins if first.
	const other = { ...sampleIdentity, node_id: "n2", instance_id: "a2-n2", attempt_id: "a2-n2.1" };
	const compFirst = claimOutcome(dir, other, "completed", "2026-11-17T10:00:00.000Z");
	assert.equal(compFirst.won, true);
	const cancelSecond = claimOutcome(dir, other, "cancelled", "2026-11-17T10:00:00.001Z");
	assert.equal(cancelSecond.won, false);
	assert.equal(cancelSecond.claim.outcome, "completed");

	// Versioned reader rejects unsupported outcome claim version.
	assert.throws(() => parseOutcomeClaim({ ...readJson<any>(outcomeClaimPath(dir, "a1-n1")), version: 4 }, sampleIdentity), /Unsupported outcome claim version 4/);
});

test("graceRemainingMs computes remaining grace window accurately under fake time", () => {
	const record = {
		version: 1 as const,
		identity: sampleIdentity,
		scope: "node" as const,
		reason: "Stop",
		requested_at: "2026-11-17T10:00:00.000Z",
		grace_ms: 5000,
		force_close_after: "2026-11-17T10:00:05.000Z",
	};
	const t0 = Date.parse("2026-11-17T10:00:00.000Z");
	assert.equal(graceRemainingMs(record, t0), 5000);
	assert.equal(graceRemainingMs(record, t0 + 2500), 2500);
	assert.equal(graceRemainingMs(record, t0 + 5000), 0);
	assert.equal(graceRemainingMs(record, t0 + 9000), 0);
});

test("diagnoseLiveness separates heartbeat liveness, useful activity, and running-task duration", () => {
	const t0 = 1_000_000;
	// Healthy: recent heartbeat AND recent activity, within task_timeout_ms.
	const healthy = diagnoseLiveness({
		nowMs: t0 + 60_000,
		progress: { token: "tok", updated_at: t0 + 59_000, activity_at: t0 + 50_000, started_at: t0, state: "working" },
		alive: true,
		livenessTimeoutMs: DEFAULT_LIVENESS_MS,
		taskTimeoutMs: 120_000,
	});
	assert.equal(healthy.liveness, "healthy");
	assert.equal(healthy.elapsed_ms, 60_000);
	assert.equal(healthy.deadline_exceeded, false);

	// Live-but-stalled: heartbeat is 1s old, but useful activity stopped 11 minutes ago!
	const stalled = diagnoseLiveness({
		nowMs: t0 + 660_000,
		progress: { token: "tok", updated_at: t0 + 659_000, activity_at: t0, started_at: t0, state: "working" },
		alive: true,
		livenessTimeoutMs: DEFAULT_LIVENESS_MS,
		taskTimeoutMs: undefined,
	});
	assert.equal(stalled.liveness, "stalled");
	assert.equal(stalled.heartbeat_age_ms, 1000);
	assert.equal(stalled.activity_age_ms, 660_000);
	assert.equal(stalled.deadline_exceeded, false);

	// Task deadline exceeded even while worker is still actively making progress.
	const exceeded = diagnoseLiveness({
		nowMs: t0 + 125_000,
		progress: { token: "tok", updated_at: t0 + 124_000, activity_at: t0 + 120_000, started_at: t0, state: "working" },
		alive: true,
		livenessTimeoutMs: DEFAULT_LIVENESS_MS,
		taskTimeoutMs: 120_000,
	});
	assert.equal(exceeded.liveness, "healthy");
	assert.equal(exceeded.elapsed_ms, 125_000);
	assert.equal(exceeded.deadline_exceeded, true);

	// Heartbeat stale when worker stopped sending heartbeats.
	const staleHb = diagnoseLiveness({
		nowMs: t0 + 45_000,
		progress: { token: "tok", updated_at: t0, activity_at: t0, started_at: t0, state: "working" },
		alive: true,
		livenessTimeoutMs: DEFAULT_LIVENESS_MS,
	});
	assert.equal(staleHb.liveness, "heartbeat_stale");

	// Exited process.
	const exited = diagnoseLiveness({
		nowMs: t0 + 10_000,
		progress: { token: "tok", updated_at: t0 + 5000, activity_at: t0 + 5000, started_at: t0, state: "working" },
		alive: false,
		livenessTimeoutMs: DEFAULT_LIVENESS_MS,
	});
	assert.equal(exited.liveness, "exited");
	assert.equal(DEFAULT_DEPENDENCY_WAIT_MS, 300_000);
});

test("computeDownstreamBlockers identifies dependent chain nodes that will not run", () => {
	const entries = [
		{ node_id: "n1", instance_id: "a1-n1", predecessor: undefined, successor: "a2-n2" },
		{ node_id: "n2", instance_id: "a2-n2", predecessor: "a1-n1", successor: "a3-n3" },
		{ node_id: "n3", instance_id: "a3-n3", predecessor: "a2-n2", successor: undefined },
	];
	assert.deepEqual(
		computeDownstreamBlockers(entries, ["a1-n1"]).map(item => [item.node_id, item.blocked_by]),
		[["n2", "n1"], ["n3", "n2"]],
	);
	assert.deepEqual(
		computeDownstreamBlockers(entries, ["a2-n2"]).map(item => [item.node_id, item.blocked_by]),
		[["n3", "n2"]],
	);
	assert.deepEqual(computeDownstreamBlockers(entries, ["a3-n3"]), []);
});
