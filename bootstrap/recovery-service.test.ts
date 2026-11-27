/** Recovering interrupted handoff delivery from saved evidence, through the service and real workers (fake Herdr, fake wake-up). */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, readJson, readyPath } from "./session-store.ts";
import { launched } from "./test-support/chain-fixture.ts";
import { formatAgentStates, formatRecovery } from "./reporting.ts";
import { wakeViaComs } from "./recovery.ts";
import { tryPaneWake } from "./pane-wake.ts";
import { BootstrapService } from "./lifecycle.ts";

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

test("retry_delivery: a reachable destination uses Coms and never calls the pane fallback", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const d = dispatcher();
	let fallbackCalls = 0;
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, {
		...d.deps,
		paneWake: async () => { fallbackCalls++; return { outcome: "sent", pane_id: "unused", handoff_id: "unused", line: "unused" }; },
	});
	assert.equal(report.delivery?.transport, "acknowledged");
	assert.match(report.next_steps.join(" "), /Coms acknowledged/);
	assert.equal(d.woken.length, 1);
	assert.equal(fallbackCalls, 0);
});

test("retry_delivery: unreachable and delivery-unknown Coms errors use the pane fallback and report that transport", async t => {
	for (const comsError of ["coms: unreachable: socket missing", "coms: delivery unknown: acknowledgement timed out"]) {
		const f = await launched(t);
		await f.first.complete({ status: "success", summary: "Built", detail: "" });
		const d = dispatcher({ fail: comsError });
		let wakeRequest: any;
		const calls: string[] = [];
		const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, {
			senderSession: DISPATCHER,
			wake: async (target, prompt) => { calls.push("coms"); d.woken.push({ target, prompt }); throw new Error(comsError); },
			paneWake: async request => {
				calls.push("pane");
				wakeRequest = request;
				return { outcome: "sent", pane_id: "pane-2", handoff_id: request.handoffId, line: `[BOOTSTRAP_WAKE handoff=${request.handoffId}]` };
			},
		});
		assert.equal(report.delivery?.transport, "pane_fallback");
		assert.match(report.next_steps.join(" "), /pane fallback sent/);
		assert.match(report.next_steps.join(" "), /not acceptance/);
		assert.match(formatRecovery(report), /pane fallback sent the wake-up/);
		assert.deepEqual(calls, ["coms", "pane"], "pane fallback runs only after the Coms attempt fails");
		assert.equal(d.woken.length, 1, "Coms is attempted first");
		assert.equal(wakeRequest.sessionDir, f.run.session_dir);
		assert.equal(wakeRequest.handoffId, report.delivery?.handoff_id);
		const retry = readJson<any>(join(f.run.session_dir, "a2-n2.handoff-recovery.json")).retries[0];
		assert.deepEqual([retry.sender_session, retry.transport], [DISPATCHER, "pane_fallback"], "the same dispatcher authorization record records the actual transport");
		assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff.json")), false, "a pane wake-up alone does not claim the handoff");
	}
});

test("retry_delivery: a skipped pane fallback reports why and leaves the destination unclaimed", async t => {
	for (const skipped of [
		{ label: "no pane ID", paneId: false, afterComs: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
		{ label: "dead process", paneId: true, afterComs: (dir: string) => kill(dir, "a2-n2"), exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
		{ label: "pane gone", paneId: true, afterComs: () => {}, exec: async () => ({ code: 1, stdout: "", stderr: "pane not found" }) },
	]) {
		const f = await launched(t);
		await f.first.complete({ status: "success", summary: "Built", detail: "" });
		const readyFile = readyPath(f.run.session_dir, "a2-n2");
		const ready = readJson<any>(readyFile);
		if (skipped.paneId) atomicJson(readyFile, { ...ready, pane_id: "pane-2" });
		else { delete ready.pane_id; delete ready.host_ref; atomicJson(readyFile, ready); }
		const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, {
			senderSession: DISPATCHER,
			wake: async () => { skipped.afterComs(f.run.session_dir); throw new Error("coms: unreachable: socket missing"); },
			paneWake: request => tryPaneWake({ ...request, exec: skipped.exec as any }),
		});
		assert.equal(report.delivery?.transport, "skipped", `${skipped.label}: ${JSON.stringify(report.delivery)}`);
		assert.match(report.delivery?.error ?? "", new RegExp(skipped.label === "no pane ID" ? "no pane_id" : skipped.label === "dead process" ? "not alive" : "does not exist", "i"));
		assert.match(report.next_steps.join(" "), /fallback did not claim the handoff/i);
		assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff.json")), false);
	}
});

test("retry_delivery: an in-progress or interrupted pane marker is retryable and the next steps say so", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const busyDeps = {
		...dispatcher({ fail: "coms: unreachable: socket missing" }).deps,
		paneWake: async () => ({ outcome: "failed", reason: "wake-up in progress or interrupted for h-00000000000000000000000000000000 on pane pane-2" }),
	};
	for (let attempt = 1; attempt <= 6; attempt++) {
		const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, busyDeps);
		assert.equal(report.delivery?.transport, "failed");
		assert.equal(report.delivery?.retryable, true);
		assert.equal(report.delivery?.attempt, 1, "observing one busy marker does not consume another redelivery attempt");
		assert.match(report.delivery?.error ?? "", /in progress or interrupted/);
		assert.match(report.next_steps.join(" "), /retryable/i);
		assert.match(report.next_steps.join(" "), /retry_delivery/);
		assert.equal(report.assessments[0].verdict, "retry_delivery");
	}
	const recovery = readJson<any>(join(f.run.session_dir, "a2-n2.handoff-recovery.json"));
	assert.equal(recovery.retries.length, 1);
	assert.equal(recovery.retries[0].transport, "in_progress");
	const retried = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, {
		...dispatcher({ fail: "coms: unreachable: socket missing" }).deps,
		paneWake: async request => ({ outcome: "sent", pane_id: "pane-2", handoff_id: request.handoffId, line: "wake" }),
	});
	assert.deepEqual([retried.delivery?.attempt, retried.delivery?.transport], [1, "pane_fallback"]);
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

test("retry_delivery: concurrent callers, in one process or two, send the handoff once", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const other = new (f.service.constructor as any)((f.service as any).options);
	const d = dispatcher();
	const gate = Promise.withResolvers<void>();
	const slow = { ...d.deps, wake: async (target: string, prompt: string) => { d.woken.push({ target, prompt }); await gate.promise; } };
	const reports = Promise.all([
		f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, slow),
		other.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, slow),
		f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, slow),
	]);
	setTimeout(() => gate.resolve(), 50);
	const all = await reports;
	assert.equal(d.woken.length, 1, "exactly one wake-up for the one logical handoff");
	assert.equal(all.filter(report => report.delivery).length, 1);
	for (const report of all.filter(report => !report.delivery)) {
		assert.match(report.refused!, /already re-sent .*waiting for n2/);
		assert.equal(report.assessments[0].stage, "awaiting_destination");
	}
	assert.equal(readJson<any>(join(f.run.session_dir, "a2-n2.handoff-recovery.json")).retries.length, 1);
});

test("retry_delivery: after the wait window an unclaimed handoff can be re-sent, up to a bound, and a failed send is retryable at once", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	let now = Date.parse("2026-11-17T10:00:00.000Z");
	const failing = dispatcher({ fail: "Coms is down" });
	const failed = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...failing.deps, now: () => now });
	assert.deepEqual([failed.delivery?.transport, failed.delivery?.error], ["failed", "Coms is down"]);
	assert.equal(failed.delivery?.fallback_attempted, undefined);
	assert.match(formatRecovery(failed), /did not allow pane fallback/);
	assert.match(failed.next_steps.join(" "), /not eligible for pane fallback/);
	const d = dispatcher();
	const again = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...d.deps, now: () => now });
	assert.equal(again.delivery?.attempt, 2, "a send that failed is not an acknowledged one, so there is nothing to wait for");
	const early = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...d.deps, now: () => now + 5_000 });
	assert.equal(early.delivery, undefined);
	assert.equal(early.assessments[0].verdict, "wait");
	for (let attempt = 3; attempt <= 5; attempt++) {
		now += 60_000;
		assert.equal((await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...d.deps, now: () => now })).delivery?.attempt, attempt);
	}
	now += 60_000;
	const exhausted = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...d.deps, now: () => now });
	assert.equal(exhausted.delivery, undefined);
	assert.equal(exhausted.assessments[0].stage, "retries_exhausted");
	assert.equal(exhausted.assessments[0].verdict, "needs_attention");
	assert.equal(d.woken.length, 4, "five attempts in all, the first of which failed before sending");
});

test("retry_delivery: it never sends when nothing shows the handoff is unclaimed, and says why", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const d = dispatcher();
	const claimed = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.equal(d.woken.length, 0);
	assert.match(claimed.refused!, /accepted the handoff and is working on it.*Nothing was sent/);
	kill(f.run.session_dir, "a2-n2");
	const dead = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.match(dead.refused!, /no result was recorded.*Nothing was sent/);
	assert.equal(dead.assessments[0].verdict, "needs_attention");
	assert.equal(d.woken.length, 0);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff-recovery.json")), false, "a refused retry leaves no record of one");
});

test("retry_delivery: without a Coms identity or a way to wake, or for a destination that predates durable handoffs, nothing is sent", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const d = dispatcher();
	// A dispatcher process with no Coms registration of its own (the fixture's workers share this test process, so give it an empty registry).
	const unregistered = new BootstrapService({ ...(f.service as any).options, env: { ...(f.service as any).options.env, PI_COMS_DIR: join(f.root, "empty-coms") } });
	assert.match((await unregistered.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { wake: d.deps.wake })).refused!, /no Coms identity/);
	assert.match((await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { senderSession: DISPATCHER })).refused!, /Coms is not available/);
	const configFile = join(f.run.session_dir, "a2-n2.config.json");
	const { handoff_protocol: _removed, ...old } = readJson<any>(configFile);
	atomicJson(configFile, old);
	assert.match((await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps)).refused!, /launched before durable handoffs.*only its own predecessor can notify it/);
	assert.equal(d.woken.length, 0);
	await assert.rejects(f.service.recover(f.run.task_id, { action: "retry_delivery" }, d.deps), /needs agent/);
	await assert.rejects(f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n1" }, d.deps), /first step.*name its successor/);
});

test("recovery is serialized with cleanup in both orders, and a cleaned or cancelled run is never recovered", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const d = dispatcher();
	const gate = Promise.withResolvers<void>();
	const slow = { ...d.deps, wake: async (target: string, prompt: string) => { d.woken.push({ target, prompt }); await gate.promise; } };
	const recovering = f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, slow);
	while (!d.woken.length) await new Promise(resolve => setTimeout(resolve, 5));
	let cleaned = false;
	const cleaning = f.service.cleanup(f.run.task_id).then(manifest => { cleaned = true; return manifest; });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(cleaned, false, "cleanup waits for the recovery that holds the run");
	assert.equal(f.service.store.load(f.run.task_id).status, "applied");
	gate.resolve();
	assert.equal((await recovering).delivery?.transport, "acknowledged");
	assert.equal((await cleaning).status, "cleaned");
	// Cleanup ran first: the run is over and nothing may be sent into it.
	const afterCleanup = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { ...d.deps, now: () => Date.now() + 3_600_000 });
	assert.match(afterCleanup.refused!, /run was cleaned up/);
	assert.equal(d.woken.length, 1);
	assert.match((await f.service.recover(f.run.task_id, { action: "inspect" })).closed!, /cleaned up/);
});

test("a run whose launch was cancelled or failed is not recovered", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	atomicJson(join(f.run.session_dir, "abort.json"), { task_id: f.run.task_id, token: f.run.token, error: "Dispatcher aborted the bootstrap run" });
	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.match(report.refused!, /run was cancelled or aborted.*Dispatcher aborted the bootstrap run/);
	assert.equal(d.woken.length, 0);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff-recovery.json")), false);
});

test("recovery reports an unavailable project directory instead of guessing", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	rmSync(f.run.session_dir, { recursive: true });
	const d = dispatcher();
	await assert.rejects(f.service.recover(f.run.task_id, { action: "inspect" }), /Session files are unavailable/);
	await assert.rejects(f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps), /Session files are unavailable/);
	assert.equal(d.woken.length, 0);
});

test("a plan that changed since the handoff was offered is incompatible: nothing is sent and no offer is invented", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	// A later plan revision gave the destination a new attempt; the saved input and offer belong to the first.
	const manifest = f.service.store.load(f.run.task_id);
	manifest.pane_manifest[1].attempt_id = "a2-n2.2";
	f.service.store.save(manifest);
	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.equal(report.assessments[0].stage, "incompatible_plan");
	assert.match(report.refused!, /attempt a2-n2\.1.*a2-n2\.2/);
	assert.equal(d.woken.length, 0);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff-offer.json")), false);
	assert.equal(existsSync(join(f.run.session_dir, "a2-n2.handoff-recovery.json")), false);
});

test("an unreadable recovery record stops further redelivery and is left as found", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const file = join(f.run.session_dir, "a2-n2.handoff-recovery.json");
	writeFileSync(file, "{ torn");
	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.match(report.refused!, /earlier redeliveries.*unreadable/);
	assert.equal(readFileSync(file, "utf8"), "{ torn");
	assert.equal(d.woken.length, 0);
});

// ---- what status says once delivery is repaired or proven ----

test("status: an acceptance proves delivery, so a lost acknowledgement stops being a delivery error", async t => {
	const f = await launched(t, { executeTool: async () => { throw new Error("socket closed before the acknowledgement"); } });
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	let status = f.status();
	assert.match(status.delivery_errors.join(";"), /socket closed/);
	kill(f.run.session_dir, "a1-n1");
	await f.second.beforeStart(f.notification());
	status = f.status();
	assert.deepEqual(status.delivery_errors, [], "n2 accepted exactly that handoff: delivery is proven, whatever the source recorded");
	assert.doesNotMatch(status.worker_errors.join(";"), /exited during chain handoff/);
	assert.ok(!status.pending.includes("n1"));
});

test("status: redeliveries the dispatcher made are shown with the handoff, apart from acceptance", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const d = dispatcher();
	await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	const view = f.status().agents[1].handoff!;
	assert.equal(view.state, "queued");
	assert.deepEqual([view.recovery?.attempts, view.recovery?.last_transport], [1, "acknowledged"]);
	assert.match(formatAgentStates(f.status().agents), /handoff in h-[0-9a-f]{32} queued: not accepted yet.*dispatcher re-sent it 1 time \(last Coms acknowledged\)/);
	await f.second.beforeStart(fromDispatcher(d.woken[0].prompt));
	assert.equal(f.status().agents[1].handoff?.state, "accepted");
	assert.match(formatAgentStates(f.status().agents), /\[handoff in h-[0-9a-f]{32} accepted \(re-sent by the dispatcher\)\]/);
});

// ---- the pieces the tool is made of ----

test("the dispatcher's own Coms session is recorded as the sender when the caller does not supply one", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const comsDir = join(f.root, "dispatcher-coms");
	mkdirSync(join(comsDir, "projects", "dispatch", "agents"), { recursive: true });
	atomicJson(join(comsDir, "projects", "dispatch", "agents", "dispatcher.json"), { pid: process.pid, name: "dispatcher", session_id: "session-the-dispatcher", endpoint: "/tmp/x", cwd: f.cwd, model: "m" });
	const service = new BootstrapService({ ...(f.service as any).options, env: { ...(f.service as any).options.env, PI_COMS_DIR: comsDir } });
	const d = dispatcher();
	const report = await service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, { wake: d.deps.wake });
	assert.equal(report.delivery?.transport, "acknowledged");
	assert.deepEqual(readJson<any>(join(f.run.session_dir, "a2-n2.handoff-recovery.json")).retries.map((retry: any) => retry.sender_session), ["session-the-dispatcher"]);
});

test("wakeViaComs sends through coms_send and turns a refused send into an error", async () => {
	const calls: any[] = [];
	const ok = wakeViaComs(async (name, args, options) => { calls.push({ name, args, options }); return { content: [{ type: "text", text: "sent" }] }; });
	await ok("session-x", "hello", undefined);
	assert.deepEqual(calls, [{ name: "coms_send", args: { target: "session-x", prompt: "hello" }, options: { signal: undefined } }]);
	const refused = wakeViaComs(async () => ({ isError: true, content: [{ type: "text", text: "coms: no live agent matching session-x" }] }));
	await assert.rejects(refused("session-x", "hello"), /no live agent matching session-x/);
});

test("the recovery report reads as model-facing text: evidence, what was done, and the next step", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const inspected = formatRecovery(await f.service.recover(f.run.task_id, { action: "inspect" }));
	assert.match(inspected, /^Recovery inspect for run /);
	assert.match(inspected, /- n1 → n2: deliverable \[retry_delivery\] — /);
	assert.match(inspected, /evidence: source n1 saved a result \(success\)/);
	assert.match(inspected, /Next: bootstrap_recover with action retry_delivery and agent n2/);
	const d = dispatcher();
	const sent = formatRecovery(await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps));
	assert.match(sent, /Re-sent handoff h-[0-9a-f]{32} \(attempt 1\): Coms acknowledged the message \(that is delivery, not acceptance\); the source had exited before recording its offer/);
	const again = formatRecovery(await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps));
	assert.match(again, /Not retried: .*already re-sent.*waiting for n2/);
});

// ---- compatibility and legacy ----

test("version 1 recovery records and the dispatcher's offer and claim markers stay readable: frozen literal fixtures", async t => {
	const f = await launched(t);
	const dir = f.run.session_dir;
	const digest = "a".repeat(64);
	const id = `h-${"b".repeat(32)}`;
	const ends = { source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1" }, destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" } };
	writeFileSync(join(dir, "a2-n2.handoff-offer.json"), JSON.stringify({ version: 1, handoff_id: id, run_id: f.run.task_id, state: "offered", source: { ...ends.source, persona_name: "first" }, destination: ends.destination, input_digest: digest, result_path: "/x/a1-n1.result.json", offered_at: "2026-11-17T10:00:00.000Z", offered_by: "dispatcher" }, null, 2));
	writeFileSync(join(dir, "a2-n2.handoff-recovery.json"), JSON.stringify({ version: 1, run_id: f.run.task_id, handoff_id: id, input_digest: digest, source: "a1-n1", destination: "a2-n2", retries: [
		{ seq: 1, at: "2026-11-17T10:01:00.000Z", sender_session: "session-dispatcher", transport: "failed", error: "Coms is down" },
		{ seq: 2, at: "2026-11-17T10:02:00.000Z", sender_session: "session-dispatcher", transport: "acknowledged", acknowledged_at: "2026-11-17T10:02:00.500Z" },
	] }, null, 2));
	writeFileSync(join(dir, "a2-n2.handoff.json"), JSON.stringify({ version: 1, handoff_id: id, state: "accepted", run_id: f.run.task_id, source: { ...ends.source, session_id: "session-a1-n1" }, destination: ends.destination, input_digest: digest, offer: "matched", accepted_at: "2026-11-17T10:03:00.000Z", delivered_by: "dispatcher" }, null, 2));
	const view = f.status().agents[1].handoff!;
	assert.deepEqual([view.state, view.delivered_by, view.recovery], ["accepted", "dispatcher", { attempts: 2, last_transport: "acknowledged", last_at: "2026-11-17T10:02:00.000Z" }]);
	writeFileSync(join(dir, "a2-n2.handoff-recovery.json"), JSON.stringify({ version: 2, retries: [] }));
	assert.match(f.status().agents[1].handoff!.problems.join(";"), /Unsupported handoff recovery record version 2/);
});

test("a run launched before durable handoffs can be inspected, and its receipt from the previous release counts as accepted", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	rmSync(join(f.run.session_dir, "a2-n2.handoff-offer.json"));
	atomicJson(join(f.run.session_dir, "a2-n2.handoff.json"), { task_id: f.run.task_id, token: f.run.token, predecessor: "a1-n1", sender_session: "session-a1-n1" });
	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["accepted_running", "wait"]);
	assert.match(edge.evidence.join(";"), /n2 accepted the handoff \(a receipt from the previous release, with no handoff ID\)/);
});

test("a failed completion tells the worker that the dispatcher can repair delivery from the saved result", async t => {
	const f = await launched(t, { executeTool: async () => { throw new Error("socket closed"); } });
	const result = await f.first.complete({ status: "success", summary: "Built", detail: "" });
	assert.match(result.content[0].text, /You may retry bootstrap_complete\. If you cannot, the dispatcher can repair delivery from the saved result \(bootstrap_recover\)/);
});

test("inspect handles malformed or null ready.json without throwing TypeError", async t => {
	const f = await launched(t);
	writeFileSync(join(f.run.session_dir, "a1-n1.ready.json"), "null");
	let edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["source_unfinished", "needs_attention"]);

	const f2 = await launched(t);
	await f2.first.complete({ status: "success", summary: "Built", detail: "" });
	writeFileSync(join(f2.run.session_dir, "a2-n2.ready.json"), "null");
	edge = await inspectEdge(f2);
	assert.deepEqual([edge.stage, edge.verdict], ["destination_unavailable", "needs_attention"]);
	assert.match(edge.reason, /no valid readiness record/);

	writeFileSync(join(f2.run.session_dir, "a2-n2.ready.json"), JSON.stringify({ task_id: f2.run.task_id, token: f2.run.token, instance_id: "a2-n2" }));
	edge = await inspectEdge(f2);
	assert.deepEqual([edge.stage, edge.verdict], ["destination_unavailable", "needs_attention"]);
	assert.match(edge.reason, /no valid readiness record/);
});

test("inspect and retry_delivery fail closed on unreadable or unsupported disposition.json", async t => {
	const f = await launched(t);
	writeFileSync(join(f.run.session_dir, "a1-n1.disposition.json"), "{ torn");
	let edge = await inspectEdge(f);
	assert.equal(edge.verdict, "needs_attention");
	assert.ok(edge.problems.some(p => /disposition/i.test(p)));

	const f2 = await launched(t);
	await f2.first.complete({ status: "success", summary: "Built", detail: "" });
	writeFileSync(join(f2.run.session_dir, "a2-n2.disposition.json"), JSON.stringify({ version: 2 }));
	edge = await inspectEdge(f2);
	assert.equal(edge.verdict, "needs_attention");
	assert.ok(edge.problems.some(p => /Unsupported disposition record version 2/i.test(p)));
	const d = dispatcher();
	const refused = await f2.service.recover(f2.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.ok(refused.refused);
	assert.equal(d.woken.length, 0);
});

test("mismatched handoff-recovery.json is caught as incompatible_plan without writing handoff-offer.json", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const offerPath = join(f.run.session_dir, "a2-n2.handoff-offer.json");
	assert.equal(existsSync(offerPath), false);
	atomicJson(join(f.run.session_dir, "a2-n2.handoff-recovery.json"), {
		version: 1,
		run_id: f.run.task_id,
		handoff_id: `h-${"0".repeat(32)}`,
		input_digest: "0".repeat(64),
		source: "a1-n1",
		destination: "a2-n2",
		retries: [],
	});

	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["incompatible_plan", "needs_attention"]);
	assert.ok(edge.problems.some(p => /handoff recovery/i.test(p)));

	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.ok(report.refused);
	assert.equal(d.woken.length, 0);
	assert.equal(existsSync(offerPath), false, "retry_delivery must not write handoff-offer.json when recovery record mismatches");
});

test("corrupt or missing destination input.json reports incompatible_plan and refuses retry_delivery cleanly", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const inputPath = join(f.run.session_dir, "a2-n2.input.json");
	writeFileSync(inputPath, "{ torn");
	let edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["incompatible_plan", "needs_attention"]);
	assert.ok(edge.problems.some(p => /task input/i.test(p)));
	const d = dispatcher();
	const corruptRefused = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.ok(corruptRefused.refused);
	assert.equal(d.woken.length, 0);

	rmSync(inputPath);
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["incompatible_plan", "needs_attention"]);
	const missingRefused = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.ok(missingRefused.refused);
	assert.equal(d.woken.length, 0);
});

test("inspect does not recommend retry_delivery for pre-handoff-protocol destinations", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const configFile = join(f.run.session_dir, "a2-n2.config.json");
	const { handoff_protocol: _removed, ...old } = readJson<any>(configFile);
	atomicJson(configFile, old);

	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["destination_unavailable", "needs_attention"]);
	assert.match(edge.reason, /launched before durable handoffs.*only its own predecessor can notify it/);
	assert.doesNotMatch(edge.next_steps.join(" "), /retry_delivery/);
});

test("inspect treats progress.json state=completed or activity_at as execution evidence without a receipt", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	atomicJson(join(f.run.session_dir, "a2-n2.progress.json"), { token: f.run.token, updated_at: Date.now(), state: "completed" });
	let edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["execution_without_receipt", "needs_attention"]);

	atomicJson(join(f.run.session_dir, "a2-n2.progress.json"), { token: f.run.token, updated_at: Date.now(), state: "waiting", activity_at: Date.now() });
	edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["execution_without_receipt", "needs_attention"]);
});

test("corrupt abort.json fails closed in runClosedReason and refuses retry_delivery", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	writeFileSync(join(f.run.session_dir, "abort.json"), "{ torn");
	const inspected = await f.service.recover(f.run.task_id, { action: "inspect" });
	assert.match(inspected.closed ?? "", /abort marker/i);

	const d = dispatcher();
	const report = await f.service.recover(f.run.task_id, { action: "retry_delivery", agent: "n2" }, d.deps);
	assert.match(report.refused ?? "", /abort marker/i);
	assert.equal(d.woken.length, 0);
});

test("source.attempt_id mismatch between manifest and saved result reports incompatible_plan", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	sourceDiedAfterSavingResult(f);
	const manifest = f.service.store.load(f.run.task_id);
	manifest.pane_manifest[0].attempt_id = "a1-n1.2";
	f.service.store.save(manifest);

	const edge = await inspectEdge(f);
	assert.deepEqual([edge.stage, edge.verdict], ["incompatible_plan", "needs_attention"]);
	assert.match(edge.reason, /a1-n1\.1.*a1-n1\.2/);
});
