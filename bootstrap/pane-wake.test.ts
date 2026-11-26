/** Outside-in tests for the shared pane wake-up fallback module against a fake `herdr` binary on `PATH` and real processes. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";
import { claimHandoff, claimJoinHandoff, handoffClaimPath, handoffOfferPath, offerHandoff } from "./handoff.ts";
import { tryPaneWake } from "./pane-wake.ts";
import { atomicJson, completionRecord, processStartTime, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";

function installFakeHerdr(t: test.TestContext, options: {
	paneGetMode?: "exists" | "exists_working" | "exists_blocked" | "missing" | "unknown_pane" | "mismatch_id" | "server_error" | "syntax_error" | "connect_error" | "bad_json";
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
	if (mode === "unknown_pane") {
		process.stderr.write("unknown pane: " + paneId + "\\n");
		process.exit(1);
	}
	if (mode === "server_error") {
		process.stderr.write("internal server error while reading pane\\n");
		process.exit(1);
	}
	if (mode === "syntax_error") {
		process.stderr.write("error: unexpected argument\\n");
		process.exit(2);
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

test("tryPaneWake resolves a bare instance key for a graph/review-loop destination (attempt 1 and attempt 2)", async t => {
	const fake = installFakeHerdr(t);
	const sessionDir = join(fake.root, "review-session");
	mkdirSync(sessionDir, { recursive: true });
	const reviewPlan = {
		max_total_attempts: 6, max_total_attempts_source: "built-in" as const, node_count: 2,
		loops: [{ reviewer: "a2-review", target: "a1-build", members: ["a1-build", "a2-review"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 2, on_exhausted: "needs_attention" as const }],
	};
	const roster = [
		{ instance_id: "a1-build", node_id: "build", persona_name: "builder", sub_task: "Build" },
		{ instance_id: "a2-review", node_id: "review", persona_name: "reviewer", sub_task: "Review" },
	];
	const buildCfg: WorkerConfig = {
		version: 6, task_id: "run-rev", token: "tok-rev", session_dir: sessionDir, project_cwd: fake.root,
		coms_dir: join(fake.root, "coms"), coms_project: "p-rev", instance_id: "a1-build", node_id: "build", persona_name: "builder", attempt_id: "a1-build.1",
		persona: "Build", tools: [], sub_task: "Build", topology: "graph", outbound_edges: ["a2-review"], handoff_protocol: 1, roster, review_plan: reviewPlan,
		startup_message: "go", ready_timeout_ms: 5000,
	};
	const revCfg: WorkerConfig = {
		...buildCfg, instance_id: "a2-review", node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.1",
		predecessor: "a1-build", outbound_edges: ["a1-build"],
	};
	atomicJson(taskInputPath(sessionDir, "a1-build.1"), buildTaskInputRecord({
		identity: { run_id: "run-rev", node_id: "build", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build" },
		brief: { task: "Loop", goal: "Loop" }, assignment: { sub_task: "Build" }, roster,
	}));
	atomicJson(taskInputPath(sessionDir, "a2-review.1"), buildTaskInputRecord({
		identity: { run_id: "run-rev", node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.1", instance_id: "a2-review" },
		brief: { task: "Loop", goal: "Loop" }, assignment: { sub_task: "Review" }, roster,
	}));
	atomicJson(readyPath(sessionDir, "a2-review"), {
		version: 1, task_id: "run-rev", token: "tok-rev", instance_id: "a2-review",
		pid: process.pid, start_time: processStartTime(process.pid), session_id: "sess-rev", pane_id: "pane-rev",
	});
	atomicJson(readyPath(sessionDir, "a1-build"), {
		version: 1, task_id: "run-rev", token: "tok-rev", instance_id: "a1-build",
		pid: process.pid, start_time: processStartTime(process.pid), session_id: "sess-build", pane_id: "pane-build",
	});

	// Attempt 1 with bare instance key + reviewPlan + sourceInstance
	const buildComp = completionRecord(buildCfg, { status: "success", agent_name: "builder", node_id: "build", summary: "v1", detail: "v1" }, "pending", new Date().toISOString());
	const buildResPath = resultPath(sessionDir, "a1-build.1");
	atomicJson(buildResPath, buildComp);
	const offer1 = offerHandoff(buildCfg, buildComp, buildResPath, undefined, undefined, "a2-review", "a1-build", 1);
	const res1 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a2-review",
		handoffId: offer1.handoff_id,
		sourceInstance: "a1-build",
		reviewPlan,
		topology: "graph",
		env: fake.env,
	});
	assert.deepEqual(res1, {
		outcome: "sent",
		pane_id: "pane-rev",
		handoff_id: offer1.handoff_id,
		line: `[BOOTSTRAP_WAKE handoff=${offer1.handoff_id}]`,
	});

	// Attempt 2 feedback with bare instance key + reviewPlan + sourceInstance
	const revComp = completionRecord(revCfg, { status: "success", agent_name: "reviewer", node_id: "review", summary: "revise", detail: "fix", outputs: { verdict: "revise" } }, "pending", new Date().toISOString());
	const revResPath = resultPath(sessionDir, "a2-review.1");
	atomicJson(revResPath, revComp);
	const offer2 = offerHandoff(revCfg, revComp, revResPath, undefined, undefined, "a1-build", "a2-review", 2);
	const res2 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a1-build",
		handoffId: offer2.handoff_id,
		sourceInstance: "a2-review",
		reviewPlan,
		topology: "graph",
		env: fake.env,
	});
	assert.deepEqual(res2, {
		outcome: "sent",
		pane_id: "pane-build",
		handoff_id: offer2.handoff_id,
		line: `[BOOTSTRAP_WAKE handoff=${offer2.handoff_id}]`,
	});
});

test("tryPaneWake records pending state when send-keys Enter fails so retry sends only Enter without doubling wake text", async t => {
	const fake = installFakeHerdr(t);
	const f = setupChainFixture(fake.root, { paneId: "pane-retry" });
	let attempt = 0;
	const calls: string[][] = [];
	const customExec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-retry", workspace_id: "ws-1" } } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-text") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-keys") {
			attempt++;
			if (attempt === 1) return { code: 1, stdout: "", stderr: "transient send-keys failure" };
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "unexpected" };
	};

	const first = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.equal(first.outcome, "failed");
	assert.match((first as { reason: string }).reason, /pending/i);
	assert.match((first as { reason: string }).reason, /send-keys/);

	const second = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.deepEqual(second, {
		outcome: "sent",
		pane_id: "pane-retry",
		handoff_id: f.offer.handoff_id,
		line: `[BOOTSTRAP_WAKE handoff=${f.offer.handoff_id}]`,
	});
	assert.deepEqual(calls, [
		["pane", "get", "pane-retry"],
		["pane", "send-text", "pane-retry", `[BOOTSTRAP_WAKE handoff=${f.offer.handoff_id}]`],
		["pane", "send-keys", "pane-retry", "Enter"],
		["pane", "get", "pane-retry"],
		["pane", "send-keys", "pane-retry", "Enter"],
	]);
	assert.deepEqual(
		readdirSync(f.sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")),
		[],
		"pending marker must be removed once wake-up is sent",
	);
});

test("tryPaneWake refuses a different handoff on the same pane while pending marker exists (A-then-B), then allows B after A sends", async t => {
	const fake = installFakeHerdr(t);
	const sessionDir = join(fake.root, "join-ab");
	mkdirSync(sessionDir, { recursive: true });
	const roster = [
		{ instance_id: "a1-srcA", node_id: "srcA", persona_name: "p", sub_task: "a" },
		{ instance_id: "a2-srcB", node_id: "srcB", persona_name: "p", sub_task: "b" },
		{ instance_id: "a3-dest", node_id: "dest", persona_name: "p", sub_task: "d" },
	];
	const mkCfg = (inst: string, node: string): WorkerConfig => ({
		version: 4, task_id: "run-ab", token: "tok-ab", session_dir: sessionDir, project_cwd: fake.root,
		coms_dir: join(fake.root, "coms"), coms_project: "p-ab", instance_id: inst, node_id: node, persona_name: "p", attempt_id: `${inst}.1`,
		persona: "P", tools: [], sub_task: node, topology: "graph", outbound_edges: ["a3-dest"], handoff_protocol: 1, roster,
		startup_message: "go", ready_timeout_ms: 5000,
	});
	const cfgA = mkCfg("a1-srcA", "srcA");
	const cfgB = mkCfg("a2-srcB", "srcB");
	atomicJson(taskInputPath(sessionDir, "a3-dest"), buildTaskInputRecord({
		identity: { run_id: "run-ab", node_id: "dest", persona_name: "p", attempt_id: "a3-dest.1", instance_id: "a3-dest" },
		brief: { task: "AB", goal: "AB" }, assignment: { sub_task: "d" }, roster,
	}));
	atomicJson(readyPath(sessionDir, "a3-dest"), {
		version: 1, task_id: "run-ab", token: "tok-ab", instance_id: "a3-dest",
		pid: process.pid, start_time: processStartTime(process.pid), session_id: "sess-dest", pane_id: "pane-shared",
	});
	const compA = completionRecord(cfgA, { status: "success", agent_name: "p", node_id: "srcA", summary: "A", detail: "A" }, "pending", new Date().toISOString());
	const compB = completionRecord(cfgB, { status: "success", agent_name: "p", node_id: "srcB", summary: "B", detail: "B" }, "pending", new Date().toISOString());
	atomicJson(resultPath(sessionDir, "a1-srcA"), compA);
	atomicJson(resultPath(sessionDir, "a2-srcB"), compB);
	const offerA = offerHandoff(cfgA, compA, resultPath(sessionDir, "a1-srcA"), undefined, undefined, "a3-dest", "a1-srcA", 1);
	const offerB = offerHandoff(cfgB, compB, resultPath(sessionDir, "a2-srcB"), undefined, undefined, "a3-dest", "a2-srcB", 1);

	let failNextEnter = true;
	const calls: string[][] = [];
	const customExec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-shared", workspace_id: "ws-1" } } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-text") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-keys") {
			if (failNextEnter) {
				failNextEnter = false;
				return { code: 1, stdout: "", stderr: "transient send-keys failure" };
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "unexpected" };
	};

	// 1. Handoff A sends text, fails on Enter -> marker left for A.
	const resA1 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a3-dest.1",
		handoffId: offerA.handoff_id,
		sourceInstance: "a1-srcA",
		topology: "graph",
		exec: customExec,
	});
	assert.equal(resA1.outcome, "failed");
	assert.equal(readdirSync(sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")).length, 1);

	// 2. Handoff B wakes the same pane -> must refuse without sending text or Enter, naming both IDs.
	const resB1 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a3-dest.1",
		handoffId: offerB.handoff_id,
		sourceInstance: "a2-srcB",
		topology: "graph",
		exec: customExec,
	});
	assert.equal(resB1.outcome, "failed");
	const reasonB1 = (resB1 as { reason: string }).reason;
	assert.match(reasonB1, /another handoff/i);
	assert.ok(reasonB1.includes(offerA.handoff_id), `reason should name pending handoff A: ${reasonB1}`);
	assert.ok(reasonB1.includes(offerB.handoff_id), `reason should name refused handoff B: ${reasonB1}`);

	// 3. Retry A -> sends Enter only, succeeds, removes marker.
	const resA2 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a3-dest.1",
		handoffId: offerA.handoff_id,
		sourceInstance: "a1-srcA",
		topology: "graph",
		exec: customExec,
	});
	assert.equal(resA2.outcome, "sent");
	assert.deepEqual(readdirSync(sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")), []);

	// 4. Now B can send normally.
	const resB2 = await tryPaneWake({
		sessionDir,
		destinationAttempt: "a3-dest.1",
		handoffId: offerB.handoff_id,
		sourceInstance: "a2-srcB",
		topology: "graph",
		exec: customExec,
	});
	assert.equal(resB2.outcome, "sent");
	assert.deepEqual(readdirSync(sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")), []);

	assert.deepEqual(calls, [
		["pane", "get", "pane-shared"],
		["pane", "send-text", "pane-shared", `[BOOTSTRAP_WAKE handoff=${offerA.handoff_id}]`],
		["pane", "send-keys", "pane-shared", "Enter"],
		["pane", "get", "pane-shared"],
		["pane", "get", "pane-shared"],
		["pane", "send-keys", "pane-shared", "Enter"],
		["pane", "get", "pane-shared"],
		["pane", "send-text", "pane-shared", `[BOOTSTRAP_WAKE handoff=${offerB.handoff_id}]`],
		["pane", "send-keys", "pane-shared", "Enter"],
	]);
});

test("tryPaneWake compares pid AND start_time so a reused pid cannot inherit a pending marker", async t => {
	const fake = installFakeHerdr(t);
	const f = setupChainFixture(fake.root, { paneId: "pane-pid-reuse", pid: process.pid, startTime: processStartTime(process.pid) });
	let failEnter = true;
	const calls: string[][] = [];
	const customExec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-pid-reuse", workspace_id: "ws-1" } } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-text") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "pane" && args[1] === "send-keys") {
			if (failEnter) {
				failEnter = false;
				return { code: 1, stdout: "", stderr: "transient send-keys failure" };
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "unexpected" };
	};

	const first = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.equal(first.outcome, "failed");

	// Mutate the marker's start_time AND omit/change start_time in readiness to ensure start_time is compared in both places.
	const markerFiles = readdirSync(f.sessionDir).filter(name => name.endsWith(".pane-wake-pending.json"));
	assert.equal(markerFiles.length, 1);
	const markerPath = join(f.sessionDir, markerFiles[0]!);
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
	atomicJson(markerPath, { ...marker, start_time: "stale-start-time-1" });

	const second = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.equal(second.outcome, "sent");
	assert.equal(calls.filter(c => c[1] === "send-text").length, 2, "stale start_time marker must not be inherited");

	// Also test readiness changing start_time (defined -> undefined) on same pid.
	failEnter = true;
	const third = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.equal(third.outcome, "failed");
	atomicJson(readyPath(f.sessionDir, "a2-n2"), {
		version: 1, task_id: "run-1", token: "tok-1", instance_id: "a2-n2",
		pid: process.pid, name: "a2-n2", session_id: "sess-a2-n2", endpoint: join(fake.root, "a2.sock"), model: "m",
		pane_id: "pane-pid-reuse",
	});
	const fourth = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: customExec,
	});
	assert.equal(fourth.outcome, "sent");
	assert.equal(calls.filter(c => c[1] === "send-text").length, 4, "different readiness start_time on same pid must not inherit marker");
});

test("tryPaneWake atomically claims marker before send-text so concurrent callers send text once, and removes marker if send-text fails", async t => {
	const fake = installFakeHerdr(t);
	const f = setupChainFixture(fake.root, { paneId: "pane-concurrent" });

	let releaseSendText!: () => void;
	const sendTextEntered = Promise.withResolvers<void>();
	const sendTextGate = new Promise<void>(resolve => { releaseSendText = resolve; });
	const calls: string[][] = [];
	const concurrentExec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-concurrent", workspace_id: "ws-1" } } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-text") {
			sendTextEntered.resolve();
			await sendTextGate;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-keys") {
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "unexpected" };
	};

	const p1 = tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: concurrentExec,
	});
	await sendTextEntered.promise;
	const p2 = tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: concurrentExec,
	});
	// Wait a tick for p2 to reach pane get + claim check while p1 is still inside send-text.
	await new Promise(resolve => setTimeout(resolve, 20));
	releaseSendText();

	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.outcome, "sent");
	assert.equal(r2.outcome, "sent");
	assert.equal(calls.filter(c => c[1] === "send-text").length, 1, `expected exactly 1 send-text, got ${JSON.stringify(calls)}`);
	assert.deepEqual(readdirSync(f.sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")), []);

	// If send-text fails, the newly created marker must be removed so the next retry can send-text.
	let failText = true;
	const retryCalls: string[][] = [];
	const failThenSucceedExec = async (_cmd: string, args: string[]) => {
		retryCalls.push(args);
		if (args[0] === "pane" && args[1] === "get") {
			return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-concurrent", workspace_id: "ws-1" } } }), stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-text") {
			if (failText) {
				failText = false;
				return { code: 1, stdout: "", stderr: "send-text error" };
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "pane" && args[1] === "send-keys") return { code: 0, stdout: "", stderr: "" };
		return { code: 2, stdout: "", stderr: "unexpected" };
	};

	const failedTextRes = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: failThenSucceedExec,
	});
	assert.equal(failedTextRes.outcome, "failed");
	assert.deepEqual(readdirSync(f.sessionDir).filter(name => name.endsWith(".pane-wake-pending.json")), [], "marker must be removed when send-text fails");

	const recoveredRes = await tryPaneWake({
		sessionDir: f.sessionDir,
		destinationAttempt: f.offer.destination.attempt_id,
		handoffId: f.offer.handoff_id,
		exec: failThenSucceedExec,
	});
	assert.equal(recoveredRes.outcome, "sent");
	assert.equal(retryCalls.filter(c => c[1] === "send-text").length, 2);
});

test("tryPaneWake treats only recognisable pane-not-found errors as skipped and other non-zero pane get exits as failed with stderr", async t => {
	const fakeUnknown = installFakeHerdr(t, { paneGetMode: "unknown_pane" });
	const fUnknown = setupChainFixture(fakeUnknown.root, { paneId: "pane-unk" });
	const rUnknown = await tryPaneWake({
		sessionDir: fUnknown.sessionDir,
		destinationAttempt: fUnknown.offer.destination.attempt_id,
		handoffId: fUnknown.offer.handoff_id,
		env: fakeUnknown.env,
	});
	assert.equal(rUnknown.outcome, "skipped");
	assert.match((rUnknown as { reason: string }).reason, /unknown pane/i);

	for (const mode of ["server_error", "syntax_error"] as const) {
		const fakeErr = installFakeHerdr(t, { paneGetMode: mode });
		const fErr = setupChainFixture(fakeErr.root, { paneId: "pane-err" });
		const rErr = await tryPaneWake({
			sessionDir: fErr.sessionDir,
			destinationAttempt: fErr.offer.destination.attempt_id,
			handoffId: fErr.offer.handoff_id,
			env: fakeErr.env,
		});
		assert.equal(rErr.outcome, "failed", `${mode} must return failed, not skipped`);
		assert.match((rErr as { reason: string }).reason, mode === "server_error" ? /internal server error/ : /unexpected argument/);
		assert.deepEqual(fakeErr.calls(), [["pane", "get", "pane-err"]]);
	}

	// Narrow not-found matching: generic/other-resource "not found" errors must fail, while pane-specific wording skips.
	for (const nonPaneNotFound of [
		"socket not found",
		"session not found",
		"workspace not found",
		"herdr pane get: socket not found",
	]) {
		const fNonPane = setupChainFixture(installFakeHerdr(t).root, { paneId: "pane-other-nf" });
		const rNonPane = await tryPaneWake({
			sessionDir: fNonPane.sessionDir,
			destinationAttempt: fNonPane.offer.destination.attempt_id,
			handoffId: fNonPane.offer.handoff_id,
			exec: async () => ({ code: 1, stdout: "", stderr: nonPaneNotFound }),
		});
		assert.equal(rNonPane.outcome, "failed", `${JSON.stringify(nonPaneNotFound)} must return failed, not skipped`);
	}

	for (const paneNotFound of [
		"unknown_pane",
		'pane "pane-nf" not found',
		"no such pane",
		"pane pane-nf does not exist",
		JSON.stringify({ error: "pane not found" }),
	]) {
		const fPaneNf = setupChainFixture(installFakeHerdr(t).root, { paneId: "pane-nf" });
		const rPaneNf = await tryPaneWake({
			sessionDir: fPaneNf.sessionDir,
			destinationAttempt: fPaneNf.offer.destination.attempt_id,
			handoffId: fPaneNf.offer.handoff_id,
			exec: async () => ({ code: 1, stdout: "", stderr: paneNotFound }),
		});
		assert.equal(rPaneNf.outcome, "skipped", `${JSON.stringify(paneNotFound)} must return skipped`);
	}
});

test("tryPaneWake rejects handoff IDs with control/escape characters or non-canonical format before touching herdr", async t => {
	const fake = installFakeHerdr(t);
	const f = setupChainFixture(fake.root, { paneId: "pane-esc" });
	for (const badId of [
		`h-\x1b[31m${"0".repeat(27)}`,
		`h-${"0".repeat(31)}\x1b`,
		`h-not-hex-${"0".repeat(24)}`,
		"h-1234",
	]) {
		const res = await tryPaneWake({
			sessionDir: f.sessionDir,
			destinationAttempt: f.offer.destination.attempt_id,
			handoffId: badId,
			env: fake.env,
		});
		assert.equal(res.outcome, "skipped");
		assert.match((res as { reason: string }).reason, /invalid handoff ID/i);
	}
	assert.deepEqual(fake.calls(), []);
});
