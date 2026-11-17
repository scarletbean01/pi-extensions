/** Recovering interrupted handoff delivery from saved evidence, through the service and real workers (fake Herdr, fake wake-up). */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, readJson, readyPath } from "./session-store.ts";
import { launched } from "./test-support/chain-fixture.ts";

const DEAD_PID = 2147483646;
/** Every file in the session directory with its content, so a test can prove an operation wrote nothing. */
const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).filter(name => !name.endsWith(".lock")).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]));
const kill = (dir: string, instance: string) => atomicJson(readyPath(dir, instance), { ...readJson<any>(readyPath(dir, instance)), pid: DEAD_PID });
/** The source saved its result and then died before it could record the offer or notify anyone. */
function sourceDiedAfterSavingResult(f: Awaited<ReturnType<typeof launched>>) {
	const resultFile = join(f.run.session_dir, "a1-n1.result.json");
	const record = readJson<any>(resultFile);
	atomicJson(resultFile, { ...record, delivery: "pending" });
	rmSync(join(f.run.session_dir, "a2-n2.handoff-offer.json"), { force: true });
	kill(f.run.session_dir, "a1-n1");
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("inspect: a source that saved its result and exited leaves a delivery the dispatcher can repair, and inspecting writes nothing", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const before = snapshot(f.run.session_dir);
	const report = await f.service.recover(f.run.task_id, { action: "inspect" });
	assert.equal(report.assessments.length, 1);
	const [edge] = report.assessments;
	assert.deepEqual([edge.source.node_id, edge.destination.node_id], ["n1", "n2"]);
	assert.equal(edge.stage, "deliverable");
	assert.equal(edge.verdict, "retry_delivery");
	assert.match(edge.evidence.join(";"), /source n1 saved a result \(success\)/);
	assert.match(edge.evidence.join(";"), /no handoff offer was recorded/);
	assert.match(edge.next_steps.join(" "), /bootstrap_recover.*retry_delivery.*n2/);
	assert.deepEqual(snapshot(f.run.session_dir), before, "inspect is read-only");
});

test("inspect: a lost acknowledgement after acceptance, with the destination finished before recovery, needs no repair", async t => {
	// The message reached the successor, but the sender saw an error (the ACK was lost) and recorded the delivery as failed.
	const f = await launched(t, { executeTool: async () => { throw new Error("socket closed before the acknowledgement"); } });
	const sent = await f.first.complete({ status: "success", summary: "Built", detail: "" });
	assert.equal(sent.isError, true);
	assert.equal(readJson<any>(join(f.run.session_dir, "a1-n1.result.json")).delivery, "failed");
	await f.second.beforeStart(f.notification());
	await f.second.complete({ status: "success", summary: "Done", detail: "" });
	const [edge] = (await f.service.recover(f.run.task_id, { action: "inspect" })).assessments;
	assert.equal(edge.stage, "completed");
	assert.equal(edge.verdict, "none");
	assert.match(edge.evidence.join(";"), /n2 accepted handoff h-[0-9a-f]{32}/);
	assert.match(edge.evidence.join(";"), /n2 recorded a result \(success\)/);
	assert.match(edge.evidence.join(";"), /delivery recorded as failed.*accepted and finished anyway/);
});

test("inspect: accepted work whose worker is alive is simply running; if the worker died it needs attention and is never replayed", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	const claimBefore = readFileSync(claimFile, "utf8");
	let [edge] = (await f.service.recover(f.run.task_id, { action: "inspect" })).assessments;
	assert.deepEqual([edge.stage, edge.verdict], ["accepted_running", "wait"]);
	kill(f.run.session_dir, "a2-n2");
	[edge] = (await f.service.recover(f.run.task_id, { action: "inspect" })).assessments;
	assert.deepEqual([edge.stage, edge.verdict], ["claimed_unfinished", "needs_attention"]);
	assert.match(edge.reason, /accepted handoff h-[0-9a-f]{32}.*no result.*not replayed/);
	assert.match(edge.next_steps.join(" "), /inspect.*n2.*effects/i);
	assert.doesNotMatch(edge.next_steps.join(" "), /retry_delivery/);
	assert.equal(readFileSync(claimFile, "utf8"), claimBefore, "the claim is never reset");
});
