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

const inspectEdge = async (f: Awaited<ReturnType<typeof launched>>) => (await f.service.recover(f.run.task_id, { action: "inspect" })).assessments[0];

test("inspect: a queued handoff nobody claimed is deliverable, and the evidence says so", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["deliverable", "retry_delivery"]);
	assert.match(edge.evidence.join(";"), /handoff h-[0-9a-f]{32} was queued \(Coms acknowledged the message\)/);
	assert.equal(edge.handoff_id, readJson<any>(join(f.run.session_dir, "a2-n2.handoff-offer.json")).handoff_id);
});

test("inspect: missing acceptance evidence alone does not override evidence of execution", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	// The destination was working (its heartbeat says so), but its receipt is gone.
	atomicJson(join(f.run.session_dir, "a2-n2.progress.json"), { token: f.run.token, updated_at: Date.now(), state: "working" });
	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["execution_without_receipt", "needs_attention"]);
	assert.match(edge.evidence.join(";"), /n2's heartbeat reported it working/);
	assert.doesNotMatch(edge.next_steps.join(" "), /retry_delivery/);
});

test("inspect: an unreadable receipt, result or offer is preserved as found and never treated as unclaimed", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	writeFileSync(claimFile, "{ torn");
	const before = snapshot(f.run.session_dir);
	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["receipt_unreadable", "needs_attention"]);
	assert.match(edge.problems.join(";"), /acceptance receipt/);
	assert.deepEqual(snapshot(f.run.session_dir), before);
	rmSync(claimFile);
	writeFileSync(join(f.run.session_dir, "a2-n2.handoff-offer.json"), JSON.stringify({ version: 7 }));
	const unsupported = await inspectEdge(f);
	assert.deepEqual([unsupported.stage, unsupported.verdict], ["incompatible_plan", "needs_attention"]);
	assert.match(unsupported.problems.join(";"), /Unsupported handoff offer version 7/);
});

test("inspect: a missing or corrupt source result leaves nothing to deliver, and one is never reconstructed", async t => {
	const f = await launched(t);
	let edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["source_unfinished", "wait"]);
	kill(f.run.session_dir, "a1-n1");
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["source_unfinished", "needs_attention"]);
	assert.match(edge.reason, /exited without saving a result/);
	writeFileSync(join(f.run.session_dir, "a1-n1.result.json"), "not json");
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["source_result_unusable", "needs_attention"]);
	assert.equal(readFileSync(join(f.run.session_dir, "a1-n1.result.json"), "utf8"), "not json");
});

test("inspect: a destination that has gone, refused the handoff, or ended without it cannot be repaired by re-sending", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	kill(f.run.session_dir, "a2-n2");
	let edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["destination_unavailable", "needs_attention"]);
	assert.match(edge.reason, /unclaimed and nothing shows n2 ran, but it cannot receive it: n2's worker process \(pid \d+\) is gone/);
	atomicJson(join(f.run.session_dir, "a2-n2.handoff-rejections.json"), { version: 1, rejections: [{ at: "2026-11-17T10:00:00.000Z", kind: "input", severity: "integrity", reason: "the saved input changed after it was offered" }] });
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["rejected", "needs_attention"]);
	assert.match(edge.next_steps.join(" "), /new request_id/);
	rmSync(join(f.run.session_dir, "a2-n2.handoff-rejections.json"));
	const disposition = { version: 1, identity: { run_id: f.run.task_id, node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", instance_id: "a2-n2" }, state: "blocked", reason: "n1 did not succeed", causes: [], recorded_at: "2026-11-17T10:00:00.000Z" };
	atomicJson(join(f.run.session_dir, "a2-n2.disposition.json"), disposition);
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["destination_ended", "none"]);
});

test("inspect: an offer bound to another attempt is an incompatible plan, never re-sent and never replaced", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const offerFile = join(f.run.session_dir, "a2-n2.handoff-offer.json");
	atomicJson(offerFile, { ...readJson<any>(offerFile), destination: { node_id: "n2", attempt_id: "a2-n2.2", instance_id: "a2-n2" } });
	const before = readFileSync(offerFile, "utf8");
	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["incompatible_plan", "needs_attention"]);
	assert.match(edge.reason, /destination attempt a2-n2\.2, not a2-n2\.1/);
	assert.equal(readFileSync(offerFile, "utf8"), before);
});

test("inspect selects one successor by node or instance ID, and rejects what is not a chain edge", async t => {
	const f = await launched(t);
	assert.equal((await f.service.recover(f.run.task_id, { action: "inspect", agent: "n2" })).assessments.length, 1);
	assert.equal((await f.service.recover(f.run.task_id, { action: "inspect", agent: "a2-n2" })).assessments.length, 1);
	assert.equal((await f.service.recover(f.run.task_id, { action: "inspect", agent: "n1" })).assessments.length, 0, "the first node has no inbound handoff");
	await assert.rejects(f.service.recover(f.run.task_id, { action: "inspect", agent: "nope" }), /Unknown agent/);
});

// ---- retry_delivery ----

const DISPATCHER = "session-dispatcher";
/** A dispatcher whose wake-up is recorded instead of sent, and which can be told to fail. */
function dispatcher(options: { fail?: string } = {}) {
	const woken: Array<{ target: string; prompt: string }> = [];
	return {
		woken,
		deps: { senderSession: DISPATCHER, wake: async (target: string, prompt: string) => { woken.push({ target, prompt }); if (options.fail) throw new Error(options.fail); } },
	};
}
const fromDispatcher = (prompt: string, sender = DISPATCHER) => ({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: sender }, content: prompt } });

test("retry_delivery: the same handoff is re-offered after the source exited, the original result is untouched, and the destination accepts it once", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const resultFile = join(f.run.session_dir, "a1-n1.result.json");
	const resultBefore = readFileSync(resultFile, "utf8");
	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.equal(report.delivery?.transport, "acknowledged");
	assert.equal(d.woken.length, 1);
	assert.equal(d.woken[0].target, "session-a2-n2");
	assert.match(d.woken[0].prompt, new RegExp(`^bootstrap-handoff:${f.run.token}:a1-n1\\nhandoff-id: ${report.delivery!.handoff_id}\\n`));
	assert.equal(readFileSync(resultFile, "utf8"), resultBefore, "the original result is never replaced");
	const offer = readJson<any>(join(f.run.session_dir, "a2-n2.handoff-offer.json"));
	assert.equal(offer.handoff_id, report.delivery!.handoff_id);
	assert.equal(offer.offered_by, "dispatcher");
	// The destination's own admission decides: it accepts the dispatcher's wake-up for this handoff and claims it exactly once.
	const admitted = await f.second.beforeStart(fromDispatcher(d.woken[0].prompt));
	assert.match(admitted.systemPrompt, new RegExp(`Accepted handoff: ${report.delivery!.handoff_id}`));
	const claim = readJson<any>(join(f.run.session_dir, "a2-n2.handoff.json"));
	assert.deepEqual([claim.handoff_id, claim.delivered_by, claim.source.session_id], [report.delivery!.handoff_id, "dispatcher", "session-a1-n1"]);
	const repeat = await f.second.beforeStart(fromDispatcher(d.woken[0].prompt));
	assert.equal(repeat, undefined, "a replayed notification starts nothing");
	assert.equal((await inspectEdge(f)).stage, "accepted_running");
});

test("retry_delivery: a wake-up from the dispatcher is refused unless a recovery was recorded for exactly that handoff and sender", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const prompt = f.first.sent[0].params.prompt;
	// No recovery on record: only the predecessor's own session may notify.
	assert.equal(await f.second.beforeStart(fromDispatcher(prompt)), undefined);
	assert.match(readJson<any>(join(f.run.session_dir, "a2-n2.handoff-rejections.json")).rejections.at(-1).reason, /sender is not the recorded session of a1-n1/);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff.json")), false);
	const d = dispatcher();
	await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	// A different sender than the one the dispatcher recorded is still refused.
	assert.equal(await f.second.beforeStart(fromDispatcher(d.woken[0].prompt, "session-someone-else")), undefined);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff.json")), false);
	// And the recorded sender naming a different handoff is refused.
	assert.equal(await f.second.beforeStart(fromDispatcher(d.woken[0].prompt.replace(/handoff-id: \S+/, `handoff-id: h-${"0".repeat(32)}`))), undefined);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff.json")), false);
	assert.ok((await f.second.beforeStart(fromDispatcher(d.woken[0].prompt))).systemPrompt);
});
