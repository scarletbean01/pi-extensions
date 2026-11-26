/** Outside-in tests for the shared pane wake-up fallback module against a fake `herdr` binary on `PATH` and real processes. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";
import { claimHandoff, claimJoinHandoff, handoffClaimPath, handoffOfferPath, offerHandoff } from "./handoff.ts";
import { tryPaneWake } from "./pane-wake.ts";
import { atomicJson, completionRecord, processStartTime, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";

function installFakeHerdr(t: test.TestContext, options: {
	paneGetMode?: "exists" | "exists_working" | "exists_blocked" | "missing" | "mismatch_id" | "connect_error" | "bad_json";
	sendTextFail?: boolean;
	sendKeysFail?: boolean;
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-pane-wake-test-"));
	const binDir = join(root, "bin");
	const logPath = join(root, "herdr-calls.jsonl");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const prevPath = process.env.PATH ?? "";
	t.after(() => {
		process.env.PATH = prevPath;
		rmSync(root, { recursive: true, force: true });
	});

	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
	const paneId = args[2];
	const mode = ${JSON.stringify(options.paneGetMode ?? "exists")};
	if (mode === "missing") {
		process.stderr.write(JSON.stringify({ error: "pane not found" }) + "\\n");
		process.exit(1);
	}
	if (mode === "connect_error") {
		process.stderr.write("error: failed to connect to herdr server (ECONNREFUSED)\\n");
		process.exit(1);
	}
	if (mode === "bad_json") {
		process.stdout.write("not-json");
		process.exit(0);
	}
	const returnedId = mode === "mismatch_id" ? "other-pane" : paneId;
	const extra = mode === "exists_working"
		? { agent_status: "working", status: "working" }
		: mode === "exists_blocked"
		? { agent_status: "blocked", status: "blocked" }
		: { agent_status: "done", status: "idle" };
	process.stdout.write(JSON.stringify({ result: { pane: { pane_id: returnedId, workspace_id: "ws-1", ...extra } } }));
	process.exit(0);
}
if (args[0] === "pane" && args[1] === "send-text") {
	if (${JSON.stringify(Boolean(options.sendTextFail))}) {
		process.stderr.write("send-text failed\\n");
		process.exit(1);
	}
	process.exit(0);
}
if (args[0] === "pane" && args[1] === "send-keys") {
	if (${JSON.stringify(Boolean(options.sendKeysFail))}) {
		process.stderr.write("send-keys failed\\n");
		process.exit(1);
	}
	process.exit(0);
}
process.stderr.write("unexpected herdr command: " + args.join(" ") + "\\n");
process.exit(2);
`;
	const fakeHerdr = join(binDir, "herdr");
	writeFileSync(fakeHerdr, script, "utf8");
	chmodSync(fakeHerdr, 0o755);

	const env = { ...process.env, PATH: `${binDir}:${prevPath}` };
	const calls = (): string[][] => {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
	};
	return { root, binDir, env, calls };
}

function setupChainFixture(root: string, options: { paneId?: string; pid?: number; startTime?: string } = {}) {
	const sessionDir = join(root, "session");
	mkdirSync(sessionDir, { recursive: true });
	const roster = [
		{ instance_id: "a1-n1", node_id: "n1", persona_name: "first", sub_task: "one" },
		{ instance_id: "a2-n2", node_id: "n2", persona_name: "second", sub_task: "two" },
	];
	const sourceCfg: WorkerConfig = {
		version: 2, task_id: "run-1", token: "tok-1", session_dir: sessionDir, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "p1", instance_id: "a1-n1", node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1",
		persona: "P1", tools: ["read"], sub_task: "one", topology: "chain", successor: "a2-n2", handoff_protocol: 1, roster,
		startup_message: "bootstrap-start:tok-1:a1-n1", ready_timeout_ms: 5000,
	};
	const destCfg: WorkerConfig = {
		version: 2, task_id: "run-1", token: "tok-1", session_dir: sessionDir, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "p1", instance_id: "a2-n2", node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1",
		persona: "P2", tools: ["read"], sub_task: "two", topology: "chain", predecessor: "a1-n1", handoff_protocol: 1, roster,
		startup_message: "bootstrap-start:tok-1:a2-n2", ready_timeout_ms: 5000,
	};
	atomicJson(taskInputPath(sessionDir, "a2-n2"), buildTaskInputRecord({
		identity: { run_id: "run-1", node_id: "n2", persona_name: "second", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		brief: { task: "Chain", goal: "Chain" }, assignment: { sub_task: "two" }, roster,
	}));
	const resFile = resultPath(sessionDir, "a1-n1");
	const completion = completionRecord(sourceCfg, { status: "success", agent_name: "first", node_id: "n1", summary: "Done", detail: "Output" }, "pending", new Date().toISOString());
	atomicJson(resFile, completion);
	const offer = offerHandoff(sourceCfg, completion, resFile);
	atomicJson(readyPath(sessionDir, "a2-n2"), {
		version: 1, task_id: "run-1", token: "tok-1", instance_id: "a2-n2",
		pid: options.pid ?? process.pid,
		...(options.startTime !== undefined ? { start_time: options.startTime } : { start_time: processStartTime(options.pid ?? process.pid) }),
		name: "a2-n2", session_id: "sess-a2-n2", endpoint: join(root, "a2.sock"), model: "m",
		...(options.paneId !== undefined ? { pane_id: options.paneId } : {}),
	});
	return { sessionDir, sourceCfg, destCfg, completion, offer };
}

test("tryPaneWake sends the exact single-line wake-up when all preconditions hold and ignores Herdr agent status", async t => {
	for (const paneGetMode of ["exists", "exists_working", "exists_blocked"] as const) {
		const fake = installFakeHerdr(t, { paneGetMode });
		const { sessionDir, offer } = setupChainFixture(fake.root, { paneId: "pane-42" });

		const res = await tryPaneWake({
			sessionDir,
			destinationAttempt: offer.destination.attempt_id,
			handoffId: offer.handoff_id,
			env: fake.env,
		});

		assert.deepEqual(res, {
			outcome: "sent",
			pane_id: "pane-42",
			handoff_id: offer.handoff_id,
			line: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`,
		});
		assert.deepEqual(fake.calls(), [
			["pane", "get", "pane-42"],
			["pane", "send-text", "pane-42", `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`],
			["pane", "send-keys", "pane-42", "Enter"],
		]);
	}
});

test("tryPaneWake skips without invoking herdr when readiness has no pane_id or process is dead", async t => {
	// 1. Old-format readiness record without pane_id
	const fakeNoPane = installFakeHerdr(t);
	const fNoPane = setupChainFixture(fakeNoPane.root);
	const resNoPane = await tryPaneWake({
		sessionDir: fNoPane.sessionDir,
		destinationAttempt: fNoPane.offer.destination.attempt_id,
		handoffId: fNoPane.offer.handoff_id,
		env: fakeNoPane.env,
	});
	assert.equal(resNoPane.outcome, "skipped");
	assert.match((resNoPane as { reason: string }).reason, /pane_id/i);
	assert.deepEqual(fakeNoPane.calls(), []);

	// 2. Dead destination process (real exited child process)
	const fakeDead = installFakeHerdr(t);
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	await once(child, "close");
	const fDead = setupChainFixture(fakeDead.root, { paneId: "pane-dead", pid: child.pid! });
	const resDead = await tryPaneWake({
		sessionDir: fDead.sessionDir,
		destinationAttempt: fDead.offer.destination.attempt_id,
		handoffId: fDead.offer.handoff_id,
		env: fakeDead.env,
	});
	assert.equal(resDead.outcome, "skipped");
	assert.match((resDead as { reason: string }).reason, /not alive/i);
	assert.deepEqual(fakeDead.calls(), []);

	// 3. Reused PID (mismatched start_time)
	const fakeReused = installFakeHerdr(t);
	const fReused = setupChainFixture(fakeReused.root, { paneId: "pane-reused", pid: process.pid, startTime: "9999999999999" });
	const resReused = await tryPaneWake({
		sessionDir: fReused.sessionDir,
		destinationAttempt: fReused.offer.destination.attempt_id,
		handoffId: fReused.offer.handoff_id,
		env: fakeReused.env,
	});
	assert.equal(resReused.outcome, "skipped");
	assert.match((resReused as { reason: string }).reason, /not alive/i);
	assert.deepEqual(fakeReused.calls(), []);
});

test("tryPaneWake skips without injecting when offer is missing, already claimed (chain, graph, or join), or pane is gone", async t => {
	// 1. Missing offer
	const fakeMissing = installFakeHerdr(t);
	const fMissing = setupChainFixture(fakeMissing.root, { paneId: "pane-1" });
	rmSync(handoffOfferPath(fMissing.sessionDir, "a2-n2"));
	const resMissing = await tryPaneWake({
		sessionDir: fMissing.sessionDir,
		destinationAttempt: "a2-n2.1",
		handoffId: fMissing.offer.handoff_id,
		env: fakeMissing.env,
	});
	assert.equal(resMissing.outcome, "skipped");
	assert.match((resMissing as { reason: string }).reason, /offer/i);
	assert.deepEqual(fakeMissing.calls(), []);

	// 2. Claimed chain handoff
	const fakeClaimed = installFakeHerdr(t);
	const fClaimed = setupChainFixture(fakeClaimed.root, { paneId: "pane-2" });
	claimHandoff(
		fClaimed.destCfg,
		{ outcome: "proceed", offer: fClaimed.offer, input_digest: fClaimed.offer.input_digest, predecessor: fClaimed.completion },
		"sess-a1-n1",
	);
	const resClaimed = await tryPaneWake({
		sessionDir: fClaimed.sessionDir,
		destinationAttempt: "a2-n2.1",
		handoffId: fClaimed.offer.handoff_id,
		env: fakeClaimed.env,
	});
	assert.equal(resClaimed.outcome, "skipped");
	assert.match((resClaimed as { reason: string }).reason, /claimed/i);
	assert.deepEqual(fakeClaimed.calls(), []);

	// 3. Claimed join handoff
	const fakeJoin = installFakeHerdr(t);
	const joinDir = join(fakeJoin.root, "join-session");
	mkdirSync(joinDir, { recursive: true });
	const joinRoster = [
		{ instance_id: "a1-left", node_id: "left", persona_name: "p", sub_task: "l" },
		{ instance_id: "a2-right", node_id: "right", persona_name: "p", sub_task: "r" },
		{ instance_id: "a3-join", node_id: "join", persona_name: "p", sub_task: "j" },
	];
	const leftCfg: WorkerConfig = {
		version: 4, task_id: "run-j", token: "tok-j", session_dir: joinDir, project_cwd: fakeJoin.root,
		coms_dir: join(fakeJoin.root, "coms"), coms_project: "pj", instance_id: "a1-left", node_id: "left", persona_name: "p", attempt_id: "a1-left.1",
		persona: "P", tools: [], sub_task: "l", topology: "graph", outbound_edges: ["a3-join"], handoff_protocol: 1, roster: joinRoster,
		startup_message: "go", ready_timeout_ms: 5000,
	};
	const rightCfg: WorkerConfig = { ...leftCfg, instance_id: "a2-right", node_id: "right", attempt_id: "a2-right.1" };
	const joinCfg: WorkerConfig = {
		...leftCfg, instance_id: "a3-join", node_id: "join", attempt_id: "a3-join.1",
		inbound_edges: ["a1-left", "a2-right"], outbound_edges: undefined,
	};
	atomicJson(taskInputPath(joinDir, "a3-join"), buildTaskInputRecord({
		identity: { run_id: "run-j", node_id: "join", persona_name: "p", attempt_id: "a3-join.1", instance_id: "a3-join" },
		brief: { task: "Join", goal: "Join" }, assignment: { sub_task: "j" }, roster: joinRoster,
	}));
	atomicJson(readyPath(joinDir, "a3-join"), {
		version: 1, task_id: "run-j", token: "tok-j", instance_id: "a3-join",
		pid: process.pid, start_time: processStartTime(process.pid), session_id: "sess-join", pane_id: "pane-join",
	});
	const leftComp = completionRecord(leftCfg, { status: "success", agent_name: "p", node_id: "left", summary: "L", detail: "" }, "pending", new Date().toISOString());
	const rightComp = completionRecord(rightCfg, { status: "success", agent_name: "p", node_id: "right", summary: "R", detail: "" }, "pending", new Date().toISOString());
	atomicJson(resultPath(joinDir, "a1-left"), leftComp);
	atomicJson(resultPath(joinDir, "a2-right"), rightComp);
	const leftOffer = offerHandoff(leftCfg, leftComp, resultPath(joinDir, "a1-left"), undefined, undefined, "a3-join", "a1-left", 1);
	const rightOffer = offerHandoff(rightCfg, rightComp, resultPath(joinDir, "a2-right"), undefined, undefined, "a3-join", "a2-right", 1);
	assert.equal(existsSync(handoffOfferPath(joinDir, "a3-join", "a1-left")), true);
	claimJoinHandoff(joinCfg, [
		{ sourceInstanceId: "a1-left", offer: leftOffer, input_digest: leftOffer.input_digest, predecessor: leftComp, session_id: "s1" },
		{ sourceInstanceId: "a2-right", offer: rightOffer, input_digest: rightOffer.input_digest, predecessor: rightComp, session_id: "s2" },
	]);
	assert.equal(existsSync(handoffClaimPath(joinDir, "a3-join")), true);
	const resJoin = await tryPaneWake({
		sessionDir: joinDir,
		destinationAttempt: "a3-join.1",
		handoffId: leftOffer.handoff_id,
		env: fakeJoin.env,
	});
	assert.equal(resJoin.outcome, "skipped");
	assert.match((resJoin as { reason: string }).reason, /claimed/i);
	assert.deepEqual(fakeJoin.calls(), []);

	// 4. Pane no longer exists (pane get exits 1)
	const fakeGone = installFakeHerdr(t, { paneGetMode: "missing" });
	const fGone = setupChainFixture(fakeGone.root, { paneId: "pane-gone" });
	const resGone = await tryPaneWake({
		sessionDir: fGone.sessionDir,
		destinationAttempt: "a2-n2.1",
		handoffId: fGone.offer.handoff_id,
		env: fakeGone.env,
	});
	assert.equal(resGone.outcome, "skipped");
	assert.match((resGone as { reason: string }).reason, /does not exist|not found/i);
	assert.deepEqual(fakeGone.calls(), [["pane", "get", "pane-gone"]]);
});

test("tryPaneWake returns failed with reason when herdr injection fails or herdr is missing", async t => {
	const fakeSendFail = installFakeHerdr(t, { sendTextFail: true });
	const f1 = setupChainFixture(fakeSendFail.root, { paneId: "pane-1" });
	const r1 = await tryPaneWake({
		sessionDir: f1.sessionDir,
		destinationAttempt: f1.offer.destination.attempt_id,
		handoffId: f1.offer.handoff_id,
		env: fakeSendFail.env,
	});
	assert.equal(r1.outcome, "failed");
	assert.match((r1 as { reason: string }).reason, /send-text/);

	const fakeKeysFail = installFakeHerdr(t, { sendKeysFail: true });
	const f2 = setupChainFixture(fakeKeysFail.root, { paneId: "pane-2" });
	const r2 = await tryPaneWake({
		sessionDir: f2.sessionDir,
		destinationAttempt: f2.offer.destination.attempt_id,
		handoffId: f2.offer.handoff_id,
		env: fakeKeysFail.env,
	});
	assert.equal(r2.outcome, "failed");
	assert.match((r2 as { reason: string }).reason, /send-keys/);

	const fakeNoBin = installFakeHerdr(t);
	const f3 = setupChainFixture(fakeNoBin.root, { paneId: "pane-3" });
	const r3 = await tryPaneWake({
		sessionDir: f3.sessionDir,
		destinationAttempt: f3.offer.destination.attempt_id,
		handoffId: f3.offer.handoff_id,
		env: { ...process.env, PATH: join(fakeNoBin.root, "empty-bin") },
	});
	assert.equal(r3.outcome, "failed");
	assert.match((r3 as { reason: string }).reason, /herdr/i);
});
