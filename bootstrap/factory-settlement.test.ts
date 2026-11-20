import assert from "node:assert/strict";
import test from "node:test";
import { observeSettlement, type SettlementInput } from "./factory-settlement.ts";

const base: SettlementInput = {
	manifestStatus: "applied", sessionDirRemoved: false, cancel: {},
	agents: [{ node_id: "a", resource: "released", execution: "succeeded", state: "done" }],
	outcome: { state: "succeeded", terminal: true }, pending: [], workerErrors: [], deliveryErrors: [],
};

test("a partial or failed outcome settles but leaves outstanding attention", () => {
	assert.deepEqual(observeSettlement({ ...base, outcome: { state: "partial", terminal: true } }).attention, ["run outcome is partial"]);
	assert.equal(observeSettlement({ ...base, outcome: { state: "partial", terminal: true } }).execution_settlement.state, "settled");
	assert.deepEqual(observeSettlement(base).attention, []);
});

test("resource closure is claimed only when every node's own record says closed", () => {
	assert.equal(observeSettlement(base).resource_closure.state, "unknown");
	assert.deepEqual(observeSettlement(base).resource_closure.not_recorded_closed, ["a"]);
	const closed = observeSettlement({ ...base, agents: [{ ...base.agents[0], resource: "closed" }] });
	assert.equal(closed.resource_closure.state, "closed");
	assert.equal(closed.execution_settlement.state, "settled", "closure is independent of settlement");
});

test("a node that reads cancelled only from a cancel record is unknown, never settled", () => {
	const view = observeSettlement({ ...base, cancel: { record: { reason: "stop", requested_at: "t" } }, agents: [{ ...base.agents[0], execution: "cancelled", cancel_inferred: true }], outcome: { state: "cancelled", terminal: true } });
	assert.equal(view.execution_settlement.state, "unknown");
	assert.equal(view.cancellation.intent, "requested");
});

test("held write ownership and parked unfinalized nodes keep a run unsettled", () => {
	assert.equal(observeSettlement({ ...base, agents: [{ ...base.agents[0], ownership_status: "held_uncertain" }] }).execution_settlement.state, "unsettled");
	assert.equal(observeSettlement({ ...base, agents: [{ ...base.agents[0], parked: true, finalized: false }] }).execution_settlement.state, "unsettled");
});

test("only affirmative evidence of work that may still act is resume risk, never missing evidence", () => {
	assert.deepEqual(observeSettlement(base).resume_risk, []);
	assert.deepEqual(observeSettlement({ ...base, workerErrors: ["boom"] }).resume_risk, [], "unreadable or erroring evidence is unknown, not live work");
	assert.match(observeSettlement({ ...base, agents: [{ ...base.agents[0], execution: "running" }] }).resume_risk.join(";"), /a execution is running/);
	assert.match(observeSettlement({ ...base, agents: [{ ...base.agents[0], detached_without_outcome: true }] }).resume_risk.join(";"), /detached/);
	assert.match(observeSettlement({ ...base, agents: [{ ...base.agents[0], cancelling: true }] }).resume_risk.join(";"), /cancelling/);
});
