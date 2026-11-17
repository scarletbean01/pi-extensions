/** Handoff delivery versus acceptance as the dispatcher sees it: real workers launched from the service's own configurations, observed through status. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { formatAgentStates } from "./reporting.ts";
import { chain, launched, model, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

test("a launched chain speaks the durable handoff protocol, and a team has no handoffs", async t => {
	const f = await launched(t);
	assert.equal(f.first.config.handoff_protocol, 1);
	assert.equal(f.second.config.handoff_protocol, 1);
	const team = await f.service.generate({ topology: "team", task: "Team", project_cwd: f.cwd, request_id: "team", agents: [{ node_id: "t1", persona: "first", sub_task: "x" }] }, model);
	assert.equal(readJson<WorkerConfig>(join(team.session_dir, "a1-t1.config.json")).handoff_protocol, undefined);
});

test("a queued handoff is neither accepted nor running: delivery, acceptance and execution are separate", async t => {
	const f = await launched(t);
	assert.equal(f.status().agents[1].handoff, undefined, "nothing was handed off yet");
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const agents = f.status().agents;
	assert.equal(agents[0].delivery, "sent");
	assert.equal(agents[1].handoff?.state, "queued");
	assert.equal(agents[0].handoff_out?.handoff_id, agents[1].handoff?.handoff_id);
	assert.notEqual(agents[1].execution, "running", "a transport acknowledgement is not acceptance");
	assert.equal(agents[1].handoff?.accepted_at, undefined);
	assert.match(formatAgentStates(agents), /\[handoff in h-[0-9a-f]{32} queued: not accepted yet/);
});

test("a queued handoff the worker rejects is never shown as accepted or running, and the guidance says what to do", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	// The saved input changes after the offer: Coms acknowledged the message, but the destination refuses it.
	const path = join(f.run.session_dir, "a1-n1.result.json");
	const record = readJson<any>(path); record.result.summary = "Edited after the offer"; atomicJson(path, record);
	await f.second.beforeStart(f.notification());
	const second = f.status().agents[1];
	assert.equal(second.handoff?.state, "rejected");
	assert.match(second.handoff!.rejections[0].reason, /changed after it was offered/);
	assert.equal(second.handoff?.accepted_at, undefined);
	assert.equal(second.execution, "needs_attention");
	assert.notEqual(second.state, "working");
	const text = formatAgentStates(f.status().agents);
	assert.match(text, /\[handoff in h-[0-9a-f]{32} rejected: the saved input changed after it was offered/);
	assert.match(text, /nothing ran for this handoff; inspect a1-n1's saved result, then bootstrap_cleanup.*new request_id/i);
});

test("acceptance is recorded and shown independently of execution, with the evidence", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	assert.match((await f.second.beforeStart(f.notification())).systemPrompt, /Accepted handoff: h-/);
	const second = f.status().agents[1];
	assert.equal(second.handoff?.state, "accepted");
	assert.match(second.handoff!.input_digest!, /^[0-9a-f]{64}$/);
	assert.deepEqual(second.handoff!.problems, []);
	assert.ok(second.handoff!.accepted_at);
	assert.equal(f.status().agents[0].handoff_out?.state, "accepted", "the source can prove its successor accepted the exact saved input");
	assert.match(formatAgentStates(f.status().agents), /\[handoff in h-[0-9a-f]{32} accepted\]/);
	await f.second.complete({ status: "success", summary: "Done", detail: "" });
	assert.equal(f.status().agents[1].execution, "succeeded");
	assert.equal(f.status().agents[1].handoff?.state, "accepted", "completing does not change what was accepted");
});

test("a claimed task whose worker died without a result is needs_attention, with the handoff named, and is never reset", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	const claim = readJson<any>(claimFile);
	// The worker process is gone (a PID that cannot be alive), leaving a claim and no result.
	atomicJson(readyPath(f.run.session_dir, "a2-n2"), { ...readJson<any>(readyPath(f.run.session_dir, "a2-n2")), pid: 2147483646 });
	const second = f.status().agents[1];
	assert.equal(second.execution, "needs_attention");
	assert.match(second.execution_reason!, new RegExp(`accepted handoff ${claim.handoff_id}; no result was recorded and the task is not replayed automatically`));
	assert.equal(f.status().outcome.state, "needs_attention");
	assert.deepEqual(readJson<any>(claimFile), claim);
	await assert.rejects(f.service.report(f.run.task_id, undefined, false, () => ""), /not complete/);
});

test("an acceptance that disagrees with the offer or the saved input is reported as an evidence problem", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	await f.second.beforeStart(f.notification());
	const claimFile = join(f.run.session_dir, "a2-n2.handoff.json");
	atomicJson(claimFile, { ...readJson<any>(claimFile), input_digest: "0".repeat(64) });
	const view = f.status().agents[1].handoff!;
	assert.match(view.problems.join(";"), /does not match the saved result/);
	assert.match(f.status().worker_errors.join(";"), /handoff evidence/);
});

test("a receipt written by the previous release is shown as accepted without a handoff ID, and unsupported records are reported clearly", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "legacy" }, model);
	atomicJson(join(run.session_dir, "a2-n2.handoff.json"), { task_id: run.task_id, token: run.token, predecessor: "a1-n1", sender_session: "session-a1-n1" });
	const view = f.service.status(run.task_id).agents[1].handoff!;
	assert.deepEqual([view.state, view.legacy, view.handoff_id], ["accepted", true, undefined]);
	atomicJson(join(run.session_dir, "a2-n2.handoff.json"), { version: 9, state: "accepted" });
	const unsupported = f.service.status(run.task_id).agents[1].handoff!;
	assert.match(unsupported.problems.join(";"), /Unsupported handoff acceptance version 9/);
	atomicJson(join(run.session_dir, "a2-n2.handoff-offer.json"), { version: 3 });
	assert.match(f.service.status(run.task_id).agents[1].handoff!.problems.join(";"), /Unsupported handoff offer version 3/);
});

// ---- compatibility fixture: records exactly as this release's version 1 formats are written on disk ----

test("version 1 handoff records written by this release stay readable: frozen literal fixtures", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "frozen" }, model);
	const digest = "a".repeat(64);
	const id = `h-${"b".repeat(32)}`;
	const ends = { source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1" }, destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" } };
	writeFileSync(join(run.session_dir, "a2-n2.handoff-offer.json"), JSON.stringify({ version: 1, handoff_id: id, run_id: run.task_id, state: "queued", source: { ...ends.source, persona_name: "first" }, destination: ends.destination, input_digest: digest, result_path: "/x/a1-n1.result.json", offered_at: "2026-11-17T10:00:00.000Z", queued_at: "2026-11-17T10:00:01.000Z" }, null, 2));
	writeFileSync(join(run.session_dir, "a2-n2.handoff.json"), JSON.stringify({ version: 1, handoff_id: id, state: "accepted", run_id: run.task_id, source: { ...ends.source, session_id: "session-a1-n1" }, destination: ends.destination, input_digest: digest, offer: "matched", accepted_at: "2026-11-17T10:00:02.000Z" }, null, 2));
	writeFileSync(join(run.session_dir, "a2-n2.handoff-rejections.json"), JSON.stringify({ version: 1, rejections: [{ at: "2026-11-17T10:00:00.500Z", kind: "sender", severity: "notification", reason: "the sender is not the recorded session of a1-n1" }] }, null, 2));
	const view = f.service.status(run.task_id).agents[1].handoff!;
	assert.deepEqual({ ...view, problems: view.problems }, {
		handoff_id: id, state: "accepted", source: "a1-n1", destination: "a2-n2", input_digest: digest,
		offered_at: "2026-11-17T10:00:00.000Z", queued_at: "2026-11-17T10:00:01.000Z", accepted_at: "2026-11-17T10:00:02.000Z",
		rejections: [{ at: "2026-11-17T10:00:00.500Z", kind: "sender", severity: "notification", reason: "the sender is not the recorded session of a1-n1" }], problems: [],
	});
	writeFileSync(join(run.session_dir, "a2-n2.handoff-rejections.json"), JSON.stringify({ version: 2, rejections: [] }));
	assert.match(f.service.status(run.task_id).agents[1].handoff!.problems.join(";"), /Unsupported handoff rejections version 2/);
});

test("a run launched before durable handoffs (configurations without the protocol) is not given an offer requirement", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({ ...chain, project_cwd: f.cwd, request_id: "pre-protocol" }, model);
	for (const instance of ["a1-n1", "a2-n2"]) {
		const path = join(run.session_dir, `${instance}.config.json`);
		const { handoff_protocol: _removed, ...old } = readJson<any>(path);
		atomicJson(path, old);
	}
	const first = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	const second = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await first.start(); await second.start();
	await first.beforeStart();
	await first.complete({ status: "success", summary: "Built", detail: "" });
	assert.doesNotMatch(first.sent[0].params.prompt, /handoff-id:/);
	const admitted = await second.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: first.sent[0].params.prompt } });
	assert.match(admitted.systemPrompt, /Predecessor result/);
	const view = f.service.status(run.task_id).agents[1].handoff!;
	assert.deepEqual([view.state, view.legacy, view.handoff_id], ["accepted", true, undefined]);
});

test("status flags foreign handoff claims and offers (wrong run_id or destination) as problems", async t => {
	const f = await launched(t);
	await f.first.complete({ status: "success", summary: "Built", detail: "" });
	const offerFile = join(f.run.session_dir, "a2-n2.handoff-offer.json");
	const offer = readJson<any>(offerFile);
	atomicJson(join(f.run.session_dir, "a2-n2.handoff.json"), {
		version: 1, handoff_id: offer.handoff_id, state: "accepted", run_id: "OTHER-RUN",
		source: { node_id: "n1", attempt_id: "a1-n1.1", instance_id: "a1-n1", session_id: "session-a1-n1" },
		destination: { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		input_digest: offer.input_digest, offer: "matched", accepted_at: new Date().toISOString(),
	});
	const status = f.status();
	assert.ok(status.agents[1].handoff?.problems.some(p => /OTHER-RUN|run_id|mismatch|for run/i.test(p)), JSON.stringify(status.agents[1].handoff));
	assert.notEqual(status.agents[1].handoff?.state, "accepted");
	assert.ok(status.worker_errors.some(e => /handoff evidence problem/i.test(e)));
});
