import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRun, decideAdmission, evaluateEvidence, EXECUTION_STATES, executionFromResult, type CauseRef, type EvidenceStatus, type ExecutionState, type NodeExecution } from "./outcomes.ts";

const execution = (state: ExecutionState, causes: CauseRef[] = []): NodeExecution => ({ state, causes });

test("the execution vocabulary is exactly the specified states", () => {
	assert.deepEqual([...EXECUTION_STATES], ["pending", "waiting", "running", "succeeded", "partial", "failed", "blocked", "skipped", "cancelled", "needs_attention"]);
});

test("a worker's reported status maps to its own execution state", () => {
	assert.equal(executionFromResult("success").state, "succeeded");
	assert.equal(executionFromResult("partial").state, "partial");
	assert.equal(executionFromResult("failure").state, "failed");
});

// Expected values are the specification's policy table, written out by hand: a predecessor in this state admits (or not) under each policy.
const matrix: Array<[ExecutionState, "admit" | "blocked" | "wait", "admit" | "blocked" | "wait"]> = [
	// state, require_success, allow_partial
	["succeeded", "admit", "admit"],
	["partial", "blocked", "admit"],
	["failed", "blocked", "blocked"],
	["blocked", "blocked", "blocked"],
	["skipped", "blocked", "blocked"],
	["cancelled", "blocked", "blocked"],
	["needs_attention", "wait", "wait"],
	["pending", "wait", "wait"],
	["waiting", "wait", "wait"],
	["running", "wait", "wait"],
];
for (const [state, requireSuccess, allowPartial] of matrix) {
	test(`predecessor ${state}: require_success ${requireSuccess}, allow_partial ${allowPartial}`, () => {
		const outcome = (policy: "require_success" | "allow_partial") => { const d = decideAdmission({ policy, predecessor: { node_id: "up", execution: execution(state) } }); return d.admit ? "admit" : d.outcome; };
		assert.equal(outcome("require_success"), requireSuccess);
		assert.equal(outcome("allow_partial"), allowPartial);
	});
}

test("a blocked decision names the direct cause and carries the original causes across the whole chain", () => {
	const root: CauseRef = { node_id: "a", state: "failed", reason: "compile error" };
	const direct = decideAdmission({ policy: "require_success", predecessor: { node_id: "b", execution: execution("blocked", [root]) } });
	assert.equal(direct.admit, false);
	if (direct.admit || direct.outcome !== "blocked") throw new Error("expected a blocked decision");
	assert.deepEqual(direct.causes.map(cause => [cause.node_id, cause.state]), [["b", "blocked"], ["a", "failed"]]);
	assert.match(direct.reason, /b is blocked/);
	// A worker's own failure is the root: it has no deeper cause.
	const failed = decideAdmission({ policy: "allow_partial", predecessor: { node_id: "a", execution: execution("failed") } });
	if (failed.admit || failed.outcome !== "blocked") throw new Error("expected a blocked decision");
	assert.deepEqual(failed.causes.map(cause => [cause.node_id, cause.state]), [["a", "failed"]]);
});

test("a reported success does not satisfy required checks without passing, current evidence", () => {
	const succeeded = execution("succeeded");
	const admit = (status: EvidenceStatus) =>
		decideAdmission({ policy: "require_success", predecessor: { node_id: "up", execution: succeeded }, checks: [{ name: "tests", status }] });
	assert.equal(admit("passing").admit, true);
	for (const status of ["missing", "unverified", "stale", "failed"] as const) {
		const decision = admit(status);
		if (decision.admit || decision.outcome !== "blocked") throw new Error(`${status} evidence must block`);
		assert.match(decision.reason, new RegExp(`check "tests".*${status}`), "the kind of evidence problem is named");
		assert.deepEqual(decision.causes.map(cause => [cause.node_id, cause.state, cause.check?.evidence]), [["up", "succeeded", status]]);
	}
});

test("required checks also gate an allowed partial predecessor, and every failing check is listed", () => {
	const ok = decideAdmission({ policy: "allow_partial", predecessor: { node_id: "up", execution: execution("partial") }, checks: [{ name: "lint", status: "passing" }] });
	assert.equal(ok.admit, true);
	const bad = decideAdmission({ policy: "allow_partial", predecessor: { node_id: "up", execution: execution("partial") }, checks: [{ name: "lint", status: "stale" }, { name: "tests", status: "missing" }, { name: "types", status: "passing" }] });
	if (bad.admit || bad.outcome !== "blocked") throw new Error("expected a blocked decision");
	assert.deepEqual(bad.causes.map(cause => cause.check?.name), ["lint", "tests"]);
});

test("evidence is classified as missing, failed, unverified, stale or passing", () => {
	const record = (overrides: Record<string, unknown> = {}) => ({ check: "tests", result: "passed" as const, before: "h1", after: "h1", ...overrides });
	assert.equal(evaluateEvidence("tests", [], "h1"), "missing");
	assert.equal(evaluateEvidence("tests", [record({ check: "other" })], "h1"), "missing");
	assert.equal(evaluateEvidence("tests", [record()], "h1"), "passing");
	assert.equal(evaluateEvidence("tests", [record({ result: "failed" })], "h1"), "failed");
	assert.equal(evaluateEvidence("tests", [record()], "h2"), "stale", "the tree changed after the check");
	assert.equal(evaluateEvidence("tests", [record({ after: "h2" })], "h2"), "unverified", "the tree changed during the check");
	assert.equal(evaluateEvidence("tests", [record({ before: null, after: null })], "h1"), "unverified", "applicability could not be determined then");
	assert.equal(evaluateEvidence("tests", [record()], null), "unverified", "applicability cannot be determined now");
	// The latest record for the check decides; the history stays untouched.
	assert.equal(evaluateEvidence("tests", [record({ result: "failed" }), record()], "h1"), "passing");
	assert.equal(evaluateEvidence("tests", [record(), record({ result: "failed" })], "h1"), "failed");
});

test("run aggregation is deterministic, order independent and never turns skipped work into success", () => {
	const states = (...list: ExecutionState[]) => aggregateRun(list);
	assert.equal(states("succeeded", "succeeded").state, "succeeded");
	assert.equal(states("succeeded", "partial").state, "partial");
	assert.equal(states("succeeded", "skipped").state, "skipped");
	assert.equal(states("succeeded", "cancelled", "skipped").state, "cancelled");
	assert.equal(states("succeeded", "failed", "blocked").state, "failed");
	assert.equal(states("partial", "blocked", "blocked").state, "blocked");
	assert.equal(states("failed", "needs_attention").state, "needs_attention");
	assert.equal(states("failed", "running").state, "incomplete");
	assert.equal(states("failed", "running", "needs_attention").state, "needs_attention");
	assert.equal(states("succeeded", "pending").state, "incomplete");
	assert.equal(states("skipped", "skipped").state, "skipped");
	assert.equal(states().state, "incomplete", "an empty run has no outcome yet");
	const sample: ExecutionState[] = ["succeeded", "partial", "failed", "blocked", "skipped", "cancelled"];
	const expected = aggregateRun(sample);
	for (let shift = 1; shift < sample.length; shift++) assert.deepEqual(aggregateRun([...sample.slice(shift), ...sample.slice(0, shift)]), expected);
	assert.deepEqual(expected.counts, { pending: 0, waiting: 0, running: 0, succeeded: 1, partial: 1, failed: 1, blocked: 1, skipped: 1, cancelled: 1, needs_attention: 0 });
	assert.equal(aggregateRun(["succeeded", "blocked"]).terminal, true);
	assert.equal(aggregateRun(["succeeded", "needs_attention"]).terminal, false);
});
