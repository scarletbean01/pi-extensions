import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	createManagerAuthority,
	factoryOperations,
	revokeManagerAuthority,
} from "../factory/operations.ts";
import {
	claimConsumption,
	createRequest,
	directionProcess,
	inTransaction,
	openRequestDatabase,
	recordDirectionDelivery,
	recordResponse,
	terminateNodeRequests,
} from "./factory-requests.ts";
import { buildProposalRow, insertProposalRow } from "./constraint-proposals.ts";
import { writeProjectConstraintsDurable } from "./constraints.ts";
import { buildCheckoutHoldRow, buildManagedRunRow, sha256Hex, type StoredCheckoutHold, type StoredManagedRun } from "./factory-records.ts";
import { captureLaneSnapshot } from "./lanes.ts";
import {
	atomicJson,
	completionRecord,
	readJson,
	resultPath,
	type WorkerConfig,
} from "./session-store.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer, verifyReadOnlyViewerInChild } from "./test-support/factory-viewer-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };
const workerModel = { provider: "test-provider", id: "test-model" };

async function getJson(url: string) {
	const res = await fetch(url);
	const text = await res.text();
	return { status: res.status, text, body: JSON.parse(text) as any };
}

function scanSentinels(text: string, sentinels: readonly string[], label: string) {
	for (const s of sentinels) {
		assert.equal(text.includes(s), false, `${label} leaked sentinel ${JSON.stringify(s)}`);
	}
}

test("Slice 1: Requests view projects direction and exhaustion requests with separate recorded/consumed observations, choices, reconciliation, and no action hints", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const revChoice = { choice_id: "revise", label: "Send back for revision", route: "reject" as const };
	const appChoice = { choice_id: "ship", label: "Approve and ship", route: "approve" as const };
	const clarChoice = { choice_id: "narrow", label: "Narrow scope" };

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_REQ_PROMPT_V1",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_REQ_SUB_BUILD", intervention: { choices: [clarChoice] } },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_REQ_SUB_REVIEW",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1, on_exhausted: "needs_attention" },
				intervention: { choices: [revChoice, appChoice], require_route: true },
			},
			{ node_id: "publish", persona: "builder", sub_task: "PRIVATE_REQ_SUB_PUB", depends_on: ["review"] },
		],
	};

	const fac = ops({ action: "publish", name: "req-view-fac", draft: draftV1, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-req-view", pi_session_file: join(f.root, "PRIVATE_MGR.jsonl") });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Multiple published versions (v1, v2, restored v3) so bound version != current version is exercised too.
	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: { ...draftV1, task: "PRIVATE_REQ_PROMPT_V2" }, sessionModel });
	ops({ action: "restore", factory_id: fac.factory_id, authority: auth, from_version: "v1" });

	// Run 1 (v3): live direction request on build (pending) + consumed on build + exhausted review loop -> exhaustion request.
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "req-run-1", brief: "PRIVATE_REQ_BRIEF_1" });
	const run1 = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const buildCfg = run1.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = run1.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build = workerFromConfig(t, join(run1.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
	const review = workerFromConfig(t, join(run1.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();

	// Request A: direction request on build, answered AND consumed.
	const waitBuild = build.requestDirection({
		question: "Should build narrow scope?",
		reason: "Two options exist",
		choices: ["narrow"],
	});
	let reqAId = "";
	for (let i = 0; i < 50 && !reqAId; i++) {
		reqAId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqAId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqAId);
	ops({
		action: "respond_request",
		factory_id: fac.factory_id,
		request_id: reqAId,
		authority: auth,
		response: { kind: "choice", choice_id: "narrow", guidance: "PRIVATE_GUIDANCE_SHOULD_NOT_LEAK" },
	});
	assert.ok(!(await waitBuild).isError);
	await build.complete({ status: "success", summary: "Built 1", detail: "PRIVATE_BUILD_DETAIL_1" });

	// Review round 1: request routing choice -> reject -> exhausts on round 2.
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	const waitRev1 = review.requestDirection({
		question: "Approve or revise round 1?",
		reason: "First review pass",
		choices: ["revise", "ship"],
	});
	let reqRev1Id = "";
	for (let i = 0; i < 50 && !reqRev1Id; i++) {
		reqRev1Id = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqRev1Id) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqRev1Id);
	ops({ action: "respond_request", factory_id: fac.factory_id, request_id: reqRev1Id, authority: auth, response: { kind: "choice", choice_id: "revise" } });
	assert.ok(!(await waitRev1).isError);
	await review.complete({ status: "success", summary: "Revise once", detail: "PRIVATE_REV_1" });

	// Revision round 2 -> build completes -> review rejects at limit -> exhaustion request!
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "Built 2", detail: "PRIVATE_BUILD_DETAIL_2" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	const waitRev2 = review.requestDirection({
		question: "Approve or revise at limit?",
		reason: "Final revision capacity check",
		choices: ["revise", "ship"],
	});
	let reqRev2Id = "";
	for (let i = 0; i < 50 && !reqRev2Id; i++) {
		reqRev2Id = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqRev2Id) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqRev2Id);
	ops({ action: "respond_request", factory_id: fac.factory_id, request_id: reqRev2Id, authority: auth, response: { kind: "choice", choice_id: "revise" } });
	assert.ok(!(await waitRev2).isError);
	await review.complete({ status: "success", summary: "Still needs changes", detail: "PRIVATE_REV_2" });

	// Also create an unmanaged empty factory and a managed empty factory to check typed absence.
	const unmFac = ops({ action: "publish", name: "req-unmanaged", draft: draftV1, sessionModel });
	const emptyFac = ops({ action: "publish", name: "req-empty-managed", draft: draftV1, sessionModel });
	const emptyAuth = createManagerAuthority({ pi_session_id: "sess-empty-req" });
	ops({ action: "resume", factory_id: emptyFac.factory_id, authority: emptyAuth });

	// Close all manager sessions before starting the viewer (read-only with closed manager).
	revokeManagerAuthority(auth);
	revokeManagerAuthority(emptyAuth);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.status, 200);
			assert.equal(res.body.factory_id, fac.factory_id);
			assert.equal(res.body.absence, undefined);

			const records: any[] = res.body.records;
			assert.ok(records.length >= 4, `expected direction + exhaustion requests, got ${records.length}`);

			const dirRec = records.find(r => r.request_id === reqAId);
			assert.ok(dirRec, "missing direction request");
			assert.equal(dirRec.kind, "direction");
			assert.equal(dirRec.node_id, "build");
			assert.equal(dirRec.question, "Should build narrow scope?");
			assert.deepEqual(dirRec.choices, [{ choice_id: "narrow", label: "Narrow scope" }]);
			assert.equal(dirRec.state, "responded");
			assert.equal(dirRec.response_recorded, true);
			assert.equal(dirRec.consumption, "consumed");
			assert.equal(dirRec.response_consumed, true);
			assert.equal(typeof dirRec.consumed_at, "string");
			assert.equal(dirRec.reconciliation, "resolved");
			assert.equal(dirRec.uncertain, false);
			assert.equal(dirRec.can_respond, undefined);
			assert.equal(dirRec.can_redeliver, undefined);

			const rev1Rec = records.find(r => r.request_id === reqRev1Id);
			assert.ok(rev1Rec);
			assert.equal(rev1Rec.kind, "direction");
			assert.deepEqual(rev1Rec.choices, [revChoice, appChoice]);
			assert.equal(rev1Rec.response_recorded, true);
			assert.equal(rev1Rec.response_consumed, true);
			assert.deepEqual(rev1Rec.verdict, { state: "recorded", value: "changes_requested" });

			const exhRec = records.find(r => r.kind === "exhaustion");
			assert.ok(exhRec, "expected exhaustion request to be projected");
			assert.match(exhRec.request_id, /^exhaust_/);
			assert.equal(exhRec.node_id, "review");
			assert.match(exhRec.question, /revision capacity/i);
			assert.deepEqual(
				exhRec.choices.map((c: any) => c.choice_id),
				["retry", "takeover", "discard"],
			);
			assert.deepEqual(exhRec.exhaustion, { blocked_by: "loop_limit", on_exhausted: "needs_attention" });
			assert.equal(exhRec.state, "pending");
			assert.equal(exhRec.response_recorded, false);
			assert.equal(exhRec.consumption, "not_applicable");
			assert.equal(exhRec.response_consumed.absence, "not applicable");
			assert.equal(exhRec.reconciliation, "pending");
			assert.equal(exhRec.can_respond, undefined);
			assert.equal(exhRec.can_redeliver, undefined);

			// Unmanaged factory => typed absence "not applicable".
			const unmRes = await getJson(`${viewer.url}/api/factories/${unmFac.factory_id}/requests`);
			assert.equal(unmRes.status, 200);
			assert.deepEqual(unmRes.body.records, []);
			assert.equal(unmRes.body.absence, "not applicable");

			// Managed empty factory => typed absence "no records".
			const empRes = await getJson(`${viewer.url}/api/factories/${emptyFac.factory_id}/requests`);
			assert.equal(empRes.status, 200);
			assert.deepEqual(empRes.body.records, []);
			assert.equal(empRes.body.absence, "no records");

			// Sentinel leak scan.
			scanSentinels(
				res.text,
				["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath],
				"requests snapshot",
			);
		},
	);
});

test("Slice 2: Requests cover pending/awaiting_consumption/continuing/terminated/uncertain/damaged states and length/path bounding", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const choices = [
		{ choice_id: "proceed", label: "Proceed" },
		{ choice_id: "ship", label: "Approve", route: "approve" as const },
	];
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_TASK_S2",
		agents: [
			{ node_id: "prep", persona: "builder", sub_task: "PRIVATE_PREP_S2", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } },
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_BUILD_S2" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_REV_S2",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1, on_exhausted: "needs_attention" },
				intervention: { choices, require_route: true },
			},
			{ node_id: "docs", persona: "builder", sub_task: "PRIVATE_DOCS_S2", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } },
		],
	};

	const fac = ops({ action: "publish", name: "req-states-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-req-s2" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "s2-run", brief: "PRIVATE_BRIEF_S2" });
	const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });

	const prepCfg = run.manifest.pane_manifest.find(m => m.node_id === "prep")!;
	const docsCfg = run.manifest.pane_manifest.find(m => m.node_id === "docs")!;
	const reviewCfg = run.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const prep = workerFromConfig(t, join(run.manifest.session_dir, `${prepCfg.instance_id}.config.json`), { model: workerModel });
	const docs = workerFromConfig(t, join(run.manifest.session_dir, `${docsCfg.instance_id}.config.json`), { model: workerModel });
	await prep.start();
	await docs.start();
	await prep.beforeStart();
	await docs.beforeStart();

	// 1. Live pending request on prep (outside review loop) with over-long question + leaked store path in question.
	const longQuestion = `Question referencing ${statePath} and ` + "Q".repeat(600);
	const waitPrepPending = prep.requestDirection({
		question: longQuestion,
		reason: "Need direction",
		choices: ["proceed"],
	});
	// Avoid unhandled rejection when test closes.
	void waitPrepPending.catch(() => {});

	let pendingBuildId = "";
	for (let i = 0; i < 50 && !pendingBuildId; i++) {
		pendingBuildId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.node_id === "prep" && r.state === "pending")?.request_id ?? "";
		if (!pendingBuildId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(pendingBuildId);

	// 2. Responded + awaiting_consumption AND consumed + continuing on docs.
	const receiverDocs = {
		instance_id: docsCfg.instance_id,
		run_token: run.manifest.token,
		session_id: `session-${docsCfg.instance_id}`,
		incarnation: "inc-docs-await",
		pid: process.pid,
		...directionProcess(process.pid),
	};
	// Give docs a live v2 ready.json & working progress.json so directionObservation verifies it as live!
	const docsReady = readJson<Record<string, unknown>>(join(run.manifest.session_dir, `${docsCfg.instance_id}.ready.json`));
	atomicJson(join(run.manifest.session_dir, `${docsCfg.instance_id}.ready.json`), {
		...docsReady,
		version: 2,
		start_time: receiverDocs.start,
		direction_incarnation: receiverDocs.incarnation,
	});
	atomicJson(join(run.manifest.session_dir, `${docsCfg.instance_id}.progress.json`), {
		token: run.manifest.token,
		state: "working",
		attempt_id: `${docsCfg.instance_id}.1`,
		updated_at: Date.now(),
		started_at: Date.now(),
	});

	let awaitingId = "";
	let continuingId = "";
	let terminatedWithRespId = "";
	let terminatedNoRespId = "";
	const docsAttemptKey = `${docsCfg.instance_id}.1`;
	{
		const reqDb = openRequestDatabase(statePath);
		try {
			inTransaction(reqDb, () => {
				// 2a. Terminated with response -> never_consumed.
				const rTermResp = createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: run.input_id,
					attempt_id: run.attempt_id,
					task_id: run.task_id,
					node_id: "docs",
					node_attempt_id: docsAttemptKey,
					question: "Terminated after answer?",
					reason: "Test",
					choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rTermResp.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-m", pi_session_id: "sess" });
				terminateNodeRequests(reqDb, run.attempt_id, "docs", "cancelled");
				terminatedWithRespId = rTermResp.request_id;

				// 2b. Terminated without response -> cancelled, consumption not_applicable.
				const rTermNo = createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: run.input_id,
					attempt_id: run.attempt_id,
					task_id: run.task_id,
					node_id: "docs",
					node_attempt_id: docsAttemptKey,
					question: "Terminated before answer?",
					reason: "Test",
					choices: ["proceed"],
				}, receiverDocs);
				terminateNodeRequests(reqDb, run.attempt_id, "docs", "failed");
				terminatedNoRespId = rTermNo.request_id;

				// 2c. Consumed + delivery recorded while still running -> reconciliation: "continuing".
				const rCont = createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: run.input_id,
					attempt_id: run.attempt_id,
					task_id: run.task_id,
					node_id: "docs",
					node_attempt_id: docsAttemptKey,
					question: "Consumed and continuing?",
					reason: "Test",
					choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rCont.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-m", pi_session_id: "sess" });
				continuingId = rCont.request_id;
			});
		} finally { reqDb.close(); }
	}
	ops({ action: "redeliver_response", factory_id: fac.factory_id, request_id: continuingId, authority: auth });
	{
		const reqDb = openRequestDatabase(statePath);
		try {
			inTransaction(reqDb, () => {
				assert.equal(claimConsumption(reqDb, continuingId, receiverDocs), "claimed");
				recordDirectionDelivery(reqDb, continuingId, receiverDocs);
				// 2d. Active awaiting_consumption on docs (same attempt after consuming prior request).
				const rAwait = createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: run.input_id,
					attempt_id: run.attempt_id,
					task_id: run.task_id,
					node_id: "docs",
					node_attempt_id: docsAttemptKey,
					question: "Awaiting consumption?",
					reason: "Test",
					choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rAwait.request_id, fac.factory_id, { kind: "decline", guidance: "PRIVATE_DECLINE_NOTE" }, { incarnation_id: "inc-m", pi_session_id: "sess" });
				awaitingId = rAwait.request_id;
			});
		} finally { reqDb.close(); }
	}

	// 3. Also plant a damaged finalize.json (with an exhaustion marker so it is an exhaustion candidate) on review
	// so uncertainEscalation produces an unknown/damaged exhaustion record matching /factory requests.
	atomicJson(join(run.manifest.session_dir, `${reviewCfg.instance_id}.finalize.json`), {
		version: 1,
		run_id: run.task_id,
		instance_id: reviewCfg.instance_id,
		attempt_id: `${reviewCfg.instance_id}.1`,
		finalized_by: "bad_actor",
		exhausted: { reason: "corrupt", state: "needs_attention" },
	});

	revokeManagerAuthority(auth);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.status, 200);
			assert.equal(res.body.evidence, "uncertain");
			const recs: any[] = res.body.records;

			const pend = recs.find(r => r.request_id === pendingBuildId);
			assert.ok(pend);
			assert.equal(pend.state, "pending");
			assert.equal(pend.response_recorded, false);
			assert.equal(pend.consumption, "not_applicable");
			assert.equal(pend.response_consumed.absence, "not applicable");
			assert.equal(pend.reconciliation, "pending");
			assert.equal(pend.uncertain, false);
			assert.ok(pend.question.length <= 512, "question must be length-bounded");
			assert.match(pend.question, /\[redacted-path\]/);

			const awaiting = recs.find(r => r.request_id === awaitingId);
			assert.ok(awaiting);
			assert.equal(awaiting.state, "responded");
			assert.equal(awaiting.response_recorded, true);
			assert.deepEqual(awaiting.recorded_response, { kind: "decline" });
			assert.equal(awaiting.consumption, "awaiting_consumption");
			assert.equal(awaiting.response_consumed, false);
			assert.equal(awaiting.reconciliation, "resolved");
			assert.match(awaiting.reconciliation_explanation, /not claimed|awaiting consumption|not.*consum/i);
			assert.doesNotMatch(awaiting.reconciliation_explanation, /\bsettled\b/i);
			assert.equal(awaiting.uncertain, false);

			const cont = recs.find(r => r.request_id === continuingId);
			assert.ok(cont);
			assert.equal(cont.state, "responded");
			assert.equal(cont.response_recorded, true);
			assert.equal(cont.consumption, "consumed");
			assert.equal(cont.response_consumed, true);
			assert.equal(cont.reconciliation, "continuing");
			assert.equal(cont.uncertain, false);

			const termResp = recs.find(r => r.request_id === terminatedWithRespId);
			assert.ok(termResp);
			assert.equal(termResp.state, "responded");
			assert.equal(termResp.response_recorded, true);
			assert.equal(termResp.consumption, "never_consumed");
			assert.equal(termResp.response_consumed, false);
			assert.equal(termResp.terminated.reason, "cancelled");
			assert.equal(termResp.reconciliation, "cancelled");

			const termNo = recs.find(r => r.request_id === terminatedNoRespId);
			assert.ok(termNo);
			assert.equal(termNo.state, "failed");
			assert.equal(termNo.response_recorded, false);
			assert.equal(termNo.consumption, "not_applicable");
			assert.equal(termNo.response_consumed.absence, "not applicable");
			assert.equal(termNo.terminated.reason, "failed");
			assert.equal(termNo.reconciliation, "failed");

			const dmgExh = recs.find(r => r.kind === "exhaustion" && r.state === "unknown");
			assert.ok(dmgExh, "expected damaged exhaustion record with state: unknown");
			assert.equal(dmgExh.created_at.absence, "evidence unavailable");
			assert.equal(dmgExh.response_recorded.absence, "evidence unavailable");
			assert.equal(dmgExh.consumption, "unknown");
			assert.equal(dmgExh.response_consumed.absence, "evidence unavailable");
			assert.equal(dmgExh.question.absence, "evidence unavailable");
			assert.equal(dmgExh.choices.absence, "evidence unavailable");
			assert.equal(dmgExh.reconciliation, "uncertain");
			assert.equal(dmgExh.uncertain, true);

			scanSentinels(
				res.text,
				["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath],
				"slice 2 requests snapshot",
			);
		},
	);
});

test("Slice 2: Proposals view projects provenance, outcomes, file sync state, non-active label, path-scrubbed text, and typed absence", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_PROP_TASK",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_PROP_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_PROP_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
			},
		],
	};

	const fac = ops({ action: "publish", name: "prop-fac", draft, sessionModel });
	const unmFac = ops({ action: "publish", name: "prop-unmanaged", draft, sessionModel });
	const emptyFac = ops({ action: "publish", name: "prop-empty", draft, sessionModel });

	const auth = createManagerAuthority({ pi_session_id: "sess-prop", pi_session_file: join(f.root, "PRIVATE_MGR.jsonl") });
	const emptyAuth = createManagerAuthority({ pi_session_id: "sess-prop-empty" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "resume", factory_id: emptyFac.factory_id, authority: emptyAuth });

	writeProjectConstraintsDurable(f.cwd, {
		version: 1,
		constraints: [{
			id: "existing-c1",
			text: "Always verify clean workspace",
			provenance: { note: "Initial rule" },
			status: "active",
		}],
	});

	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "prop-run", brief: "PRIVATE_PROP_BRIEF" });
	const launch = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const buildCfg = launch.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = launch.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build = workerFromConfig(t, join(launch.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
	const review = workerFromConfig(t, join(launch.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();
	await build.complete({ status: "success", summary: "B1", detail: "PRIVATE_D1" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "R1", detail: "PRIVATE_D2", outputs: { verdict: "changes_requested" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "B2", detail: "PRIVATE_D3" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "R2", detail: "PRIVATE_D4", outputs: { verdict: "approve" } });
	await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });

	// 1. Confirmed & synced proposal (with path in text scrubbed!)
	const pSynced = ops({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: `Never read ${statePath} or ${f.cwd} directly`,
		run_id: launch.task_id,
		attempt_id: `${buildCfg.instance_id}.2`,
		evidence_ref: `result:${reviewCfg.instance_id}.1`,
	});
	await ops({ action: "confirm_constraint", factory_id: fac.factory_id, proposal_id: pSynced.proposal.proposal_id, authority: auth, confirm: async () => true });

	// 2. Dropped duplicate
	const pDup = ops({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "  always verify CLEAN workspace ",
		run_id: launch.task_id,
		attempt_id: `${buildCfg.instance_id}.2`,
		evidence_ref: `result:${reviewCfg.instance_id}.1`,
	});
	assert.equal(pDup.proposal.outcome, "dropped_duplicate");

	// 3. Pending proposal with conflicting_ids
	const pPending = ops({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Run strict unit tests before ship",
		run_id: launch.task_id,
		attempt_id: `${buildCfg.instance_id}.2`,
		evidence_ref: `result:${reviewCfg.instance_id}.1`,
		conflicting_ids: ["existing-c1"],
	});

	// 4. Rejected proposal
	const pRejected = ops({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Skip integration checks",
		run_id: launch.task_id,
		attempt_id: `${buildCfg.instance_id}.2`,
		evidence_ref: `result:${reviewCfg.instance_id}.1`,
	});
	await ops({
		action: "reject_constraint",
		factory_id: fac.factory_id,
		proposal_id: pRejected.proposal.proposal_id,
		authority: auth,
		confirm: async () => ({ confirmed: true, reason: `Conflicts with ${f.root} policy` }),
	});

	// 5. Confirmed conflict proposal (external edit to .pi/constraints.json -> conflict on confirm, or insert pending_write/conflict/abandoned rows)
	{
		const db = new DatabaseSync(statePath);
		try {
			const now = new Date().toISOString();
			const dummyDigest = "a".repeat(64);
			const conflictRow = buildProposalRow({
				proposal_id: "cprop_conflict_1",
				factory_id: fac.factory_id,
				reference: "ref-prop-conflict",
				proposal_action: "add",
				source: "agent",
				target_constraint_id: null,
				assigned_constraint_id: "lc-conflict-1",
				text: "Keep lockfile frozen",
				run_id: launch.task_id,
				attempt_id: `${buildCfg.instance_id}.2`,
				evidence_ref: `result:${reviewCfg.instance_id}.1`,
				note: null,
				conflicting_ids: "[]",
				canonical_checkout: f.cwd,
				outcome: "confirmed",
				duplicate_of: null,
				rejection_reason: null,
				proposed_at: now,
				decided_at: now,
				decided_by: JSON.stringify({ incarnation_id: "inc-m", pi_session_id: "sess-prop" }),
				file_sync_state: "conflict",
				expected_before_digest: dummyDigest,
				expected_after_digest: dummyDigest,
				committed_entry_json: JSON.stringify({
					id: "lc-conflict-1",
					text: "Keep lockfile frozen",
					provenance: { run_id: launch.task_id, attempt_id: `${buildCfg.instance_id}.2`, evidence_ref: `result:${reviewCfg.instance_id}.1` },
					status: "active",
				}),
				sync_error: `External edit at ${f.cwd}/.pi/constraints.json`,
				eligibility_json: JSON.stringify({
					kind: "revision",
					factory_attempt_id: launch.attempt_id,
					attempt_id: `${buildCfg.instance_id}.2`,
					evidence_ref: `result:${reviewCfg.instance_id}.1`,
					verified_at: now,
				}),
			});
			const humanRetireRow = buildProposalRow({
				proposal_id: "cprop_human_retire_1",
				factory_id: fac.factory_id,
				reference: "ref-prop-human-retire",
				proposal_action: "retire",
				source: "human",
				target_constraint_id: "existing-c1",
				assigned_constraint_id: null,
				text: "Retire obsolete workspace rule",
				run_id: "",
				attempt_id: "",
				evidence_ref: "",
				note: "Human requested retirement",
				conflicting_ids: "[]",
				canonical_checkout: f.cwd,
				outcome: "confirmed",
				duplicate_of: null,
				rejection_reason: null,
				proposed_at: now,
				decided_at: now,
				decided_by: JSON.stringify({ incarnation_id: "inc-m", pi_session_id: "sess-prop" }),
				file_sync_state: "abandoned",
				expected_before_digest: dummyDigest,
				expected_after_digest: dummyDigest,
				committed_entry_json: JSON.stringify({
					id: "existing-c1",
					text: "Always verify clean workspace",
					provenance: { note: "Initial rule" },
					status: "retired",
				}),
				sync_error: `Abandoned conflict at ${f.cwd}`,
				eligibility_json: null,
				resolved_at: now,
				resolved_by: JSON.stringify({ incarnation_id: "inc-m", pi_session_id: "sess-prop" }),
			});
			insertProposalRow(db, conflictRow);
			insertProposalRow(db, humanRetireRow);
		} finally { db.close(); }
	}

	revokeManagerAuthority(auth);
	revokeManagerAuthority(emptyAuth);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
			assert.equal(res.status, 200);
			assert.equal(res.body.factory_id, fac.factory_id);
			assert.equal(res.body.is_active_constraints_file, false);
			assert.equal(res.body.note, "Proposals are not the active constraints file.");
			assert.equal(res.body.evidence, "uncertain"); // conflict row sets uncertain: true
			assert.equal(res.body.absence, undefined);

			const recs: any[] = res.body.records;
			assert.equal(recs.length, 6);

			const synced = recs.find(r => r.proposal_id === pSynced.proposal.proposal_id);
			assert.ok(synced);
			assert.equal(synced.action, "add");
			assert.equal(synced.outcome, "confirmed");
			assert.equal(synced.file_sync_state, "synced");
			assert.match(synced.file_sync_state_explanation, /durably synchronized/i);
			assert.equal(synced.provenance.source, "agent");
			assert.equal(synced.provenance.run_id, launch.task_id);
			assert.equal(synced.provenance.attempt_id, `${buildCfg.instance_id}.2`);
			assert.equal(synced.provenance.evidence_ref, `result:${reviewCfg.instance_id}.1`);
			assert.equal(synced.uncertain, false);
			assert.match(synced.text, /\[redacted-path\]/);
			assert.equal(synced.canonical_checkout, undefined);
			assert.equal(synced.decided_by, undefined);
			assert.equal(synced.can_confirm, undefined);
			assert.equal(synced.can_reject, undefined);
			assert.equal(synced.can_resolve_conflict, undefined);

			const dup = recs.find(r => r.proposal_id === pDup.proposal.proposal_id);
			assert.equal(dup.outcome, "dropped_duplicate");
			assert.deepEqual(dup.duplicate_of, { kind: "constraint", id: "existing-c1" });
			assert.equal(dup.file_sync_state.absence, "not applicable");
			assert.match(dup.file_sync_state_explanation, /applies only after a proposal is confirmed/i);
			assert.equal(dup.provenance.decided_at.absence, "not applicable");

			const pend = recs.find(r => r.proposal_id === pPending.proposal.proposal_id);
			assert.equal(pend.outcome, "pending");
			assert.deepEqual(pend.conflicting_ids, ["existing-c1"]);
			assert.equal(pend.file_sync_state.absence, "not applicable");
			assert.match(pend.file_sync_state_explanation, /applies only after a proposal is confirmed/i);

			const rej = recs.find(r => r.proposal_id === pRejected.proposal.proposal_id);
			assert.equal(rej.outcome, "rejected");
			assert.equal(rej.file_sync_state.absence, "not applicable");
			assert.match(rej.file_sync_state_explanation, /applies only after a proposal is confirmed/i);
			assert.match(rej.rejection_reason, /\[redacted-path\]/);

			const conf = recs.find(r => r.proposal_id === "cprop_conflict_1");
			assert.equal(conf.outcome, "confirmed");
			assert.equal(conf.file_sync_state, "conflict");
			assert.match(conf.file_sync_state_explanation, /resolve-conflict/i);
			assert.equal(conf.uncertain, true);

			const hum = recs.find(r => r.proposal_id === "cprop_human_retire_1");
			assert.equal(hum.action, "retire");
			assert.equal(hum.target_constraint_id, "existing-c1");
			assert.equal(hum.source, "human");
			assert.equal(hum.file_sync_state, "abandoned");
			assert.match(hum.file_sync_state_explanation, /abandoned/i);
			assert.equal(hum.provenance.run_id.absence, "not applicable");
			assert.equal(hum.provenance.attempt_id.absence, "not applicable");
			assert.equal(hum.provenance.evidence_ref.absence, "not applicable");
			assert.equal(hum.uncertain, false);
			assert.equal(hum.resolved_by, undefined);

			// Typed absence: unmanaged -> not applicable, managed empty -> no records.
			const unmRes = await getJson(`${viewer.url}/api/factories/${unmFac.factory_id}/proposals`);
			assert.equal(unmRes.status, 200);
			assert.equal(unmRes.body.is_active_constraints_file, false);
			assert.equal(unmRes.body.absence, "not applicable");
			assert.deepEqual(unmRes.body.records, []);

			const empRes = await getJson(`${viewer.url}/api/factories/${emptyFac.factory_id}/proposals`);
			assert.equal(empRes.status, 200);
			assert.equal(empRes.body.is_active_constraints_file, false);
			assert.equal(empRes.body.absence, "no records");
			assert.deepEqual(empRes.body.records, []);

			// Sentinel leak scan.
			scanSentinels(
				res.text,
				["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath],
				"proposals snapshot",
			);
		},
	);
});

test("Slice 2: No action routes, methods, query params, or action URLs exist anywhere", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const fac = ops({
		action: "publish",
		name: "no-action-fac",
		draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE", agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE" }] },
		sessionModel,
	});

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
				for (const path of [
					`/api/factories/${fac.factory_id}/requests`,
					`/api/factories/${fac.factory_id}/proposals`,
					`/api/factories/${fac.factory_id}/respond`,
					`/api/factories/${fac.factory_id}/wake`,
					`/api/factories/${fac.factory_id}/review`,
					`/api/factories/${fac.factory_id}/review-proposal`,
					`/api/factories/${fac.factory_id}/approve`,
					`/api/factories/${fac.factory_id}/resolve`,
					`/api/factories/${fac.factory_id}/resolve-conflict`,
				]) {
					const res = await fetch(`${viewer.url}${path}`, { method });
					assert.equal(res.status, 405, `expected 405 for ${method} ${path}`);
					assert.equal(res.headers.get("allow"), "GET");
				}
			}

			for (const actionPath of [
				`/api/factories/${fac.factory_id}/respond`,
				`/api/factories/${fac.factory_id}/wake`,
				`/api/factories/${fac.factory_id}/review`,
				`/api/factories/${fac.factory_id}/review-proposal`,
				`/api/factories/${fac.factory_id}/approve`,
				`/api/factories/${fac.factory_id}/reject`,
				`/api/factories/${fac.factory_id}/resolve`,
				`/api/factories/${fac.factory_id}/resolve-conflict`,
				`/api/factories/${fac.factory_id}/retire`,
				`/api/factories/${fac.factory_id}/retire-constraint`,
				`/api/factories/${fac.factory_id}/requests/dir_1/respond`,
				`/api/factories/${fac.factory_id}/requests/dir_1/wake`,
				`/api/factories/${fac.factory_id}/proposals/cprop_1/confirm`,
				`/api/factories/${fac.factory_id}/proposals/cprop_1/reject`,
			]) {
				const res = await fetch(`${viewer.url}${actionPath}`);
				assert.equal(res.status, 404, `expected 404 for GET ${actionPath}`);
			}

			for (const badQuery of [
				`/api/factories/${fac.factory_id}/requests?respond=1`,
				`/api/factories/${fac.factory_id}/requests?path=/etc/passwd`,
				`/api/factories/${fac.factory_id}/proposals?approve=1`,
				`/api/factories/${fac.factory_id}/proposals?run_id=r1`,
			]) {
				const res = await fetch(`${viewer.url}${badQuery}`);
				assert.equal(res.status, 400, `expected 400 for GET ${badQuery}`);
			}

			for (const view of ["requests", "proposals"]) {
				const text = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/${view}`)).text();
				assert.equal(/\/(respond|wake|review-proposal|resolve-conflict|retire-constraint|approve|reject)\b/.test(text), false);
				assert.equal(/"can_(respond|redeliver|confirm|reject|resolve_conflict)"/.test(text), false);
			}
		},
	);
});

test("Slice 2: Missing factory_managers rows, hot journal, WAL, damaged records, and FIFO/symlink session files fail closed read-only", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_RO",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_RO_B", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } }],
	};
	const facWithRecs = ops({ action: "publish", name: "missing-mgr-with-recs", draft, sessionModel });
	const facEmptyEstablished = ops({ action: "publish", name: "missing-mgr-empty", draft, sessionModel });
	const auth1 = createManagerAuthority({ pi_session_id: "s1" });
	const auth2 = createManagerAuthority({ pi_session_id: "s2" });
	ops({ action: "resume", factory_id: facWithRecs.factory_id, authority: auth1 });
	ops({ action: "resume", factory_id: facEmptyEstablished.factory_id, authority: auth2 });

	ops({ action: "submit", factory_id: facWithRecs.factory_id, authority: auth1, reference: "ro-ref", brief: "PRIVATE_RO_BRIEF" });
	const run = await ops({ action: "launch", factory_id: facWithRecs.factory_id, authority: auth1 });
	const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const build = workerFromConfig(t, join(run.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await build.beforeStart();
	const dirAbort = new AbortController();
	const waitDir = build.requestDirection({ question: "Need direction?", reason: "Check", choices: ["proceed"] }, dirAbort.signal);
	void waitDir.catch(() => {});
	let reqId = "";
	for (let i = 0; i < 50 && !reqId; i++) {
		reqId = ops({ action: "requests", factory_id: facWithRecs.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqId);

	{
		const db = new DatabaseSync(statePath);
		try {
			const now = new Date().toISOString();
			insertProposalRow(db, buildProposalRow({
				proposal_id: "cprop_ro_1",
				factory_id: facWithRecs.factory_id,
				reference: "ref-ro-1",
				proposal_action: "add",
				source: "agent",
				target_constraint_id: null,
				assigned_constraint_id: null,
				text: "Verify missing manager still exposes proposals",
				run_id: run.task_id,
				attempt_id: buildCfg.instance_id,
				evidence_ref: `attempt:${buildCfg.instance_id}`,
				note: null,
				conflicting_ids: "[]",
				canonical_checkout: f.cwd,
				outcome: "pending",
				duplicate_of: null,
				rejection_reason: null,
				proposed_at: now,
				decided_at: null,
				decided_by: null,
				file_sync_state: null,
				expected_before_digest: null,
				expected_after_digest: null,
				committed_entry_json: null,
				sync_error: null,
				eligibility_json: JSON.stringify({
					kind: "intervention",
					factory_attempt_id: run.attempt_id,
					attempt_id: buildCfg.instance_id,
					evidence_ref: `attempt:${buildCfg.instance_id}`,
					verified_at: now,
				}),
			}));
			// Delete factory_managers rows from both factories.
			db.prepare("DELETE FROM factory_managers").run();
		} finally { db.close(); }
	}
	revokeManagerAuthority(auth1);
	revokeManagerAuthority(auth2);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Unknown factory => 404.
			assert.equal((await fetch(`${viewer.url}/api/factories/unknown_fac/requests`)).status, 404);
			assert.equal((await fetch(`${viewer.url}/api/factories/unknown_fac/proposals`)).status, 404);

			// Missing factory_managers row with existing records => still returns verified records!
			const reqRes = await getJson(`${viewer.url}/api/factories/${facWithRecs.factory_id}/requests`);
			assert.equal(reqRes.status, 200);
			assert.equal(reqRes.body.records.length, 1);
			assert.equal(reqRes.body.records[0].request_id, reqId);
			assert.equal(reqRes.body.records[0].reconciliation, "pending");

			const propRes = await getJson(`${viewer.url}/api/factories/${facWithRecs.factory_id}/proposals`);
			assert.equal(propRes.status, 200);
			assert.equal(propRes.body.records.length, 1);
			assert.equal(propRes.body.records[0].proposal_id, "cprop_ro_1");

			// Missing factory_managers row on established factory with 0 records => evidence unavailable (NEVER "no records").
			const empReq = await getJson(`${viewer.url}/api/factories/${facEmptyEstablished.factory_id}/requests`);
			assert.equal(empReq.status, 200);
			assert.equal(empReq.body.evidence, "unavailable");
			assert.equal(empReq.body.absence, "evidence unavailable");

			const empProp = await getJson(`${viewer.url}/api/factories/${facEmptyEstablished.factory_id}/proposals`);
			assert.equal(empProp.status, 200);
			assert.equal(empProp.body.evidence, "unavailable");
			assert.equal(empProp.body.absence, "evidence unavailable");
		},
	);

	// FIFO in session file (ready.json) must NOT hang and must fail closed to uncertain without changing bytes!
	const readyFile = join(run.manifest.session_dir, `${buildCfg.instance_id}.ready.json`);
	const savedReady = readFileSync(readyFile);
	rmSync(readyFile);
	execFileSync("mkfifo", [readyFile]);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${facWithRecs.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		assert.equal(body.records.length, 1);
		assert.equal(body.records[0].reconciliation, "uncertain");
		assert.equal(body.records[0].uncertain, true);
	}
	rmSync(readyFile);
	writeFileSync(readyFile, savedReady);

	// Symlink in session file (progress.json) must fail closed to uncertain without following symlink!
	const progressFile = join(run.manifest.session_dir, `${buildCfg.instance_id}.progress.json`);
	const outsideTarget = join(f.root, "outside-progress.json");
	writeFileSync(outsideTarget, JSON.stringify({ token: run.manifest.token, state: "working", updated_at: Date.now() }));
	rmSync(progressFile, { force: true });
	symlinkSync(outsideTarget, progressFile);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${facWithRecs.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		assert.equal(body.records[0].reconciliation, "uncertain");
		assert.equal(body.records[0].uncertain, true);
	}
	rmSync(progressFile, { force: true });

	// Stop the in-process direction waiter and worker timers before planting a hot journal so
	// awaitDirection does not open a read-write DB connection and roll back the journal during the check.
	dirAbort.abort();
	await waitDir.catch(() => {});
	await build.shutdown("reload");

	// Hot SQLite journal => evidence unavailable (NEVER no records) and leaves journal bytes untouched!
	const journalPath = `${statePath}-journal`;
	writeFileSync(journalPath, Buffer.from("hot-journal-bytes"));
	try {
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const reqHot = await getJson(`${viewer.url}/api/factories/${facWithRecs.factory_id}/requests`);
				assert.equal(reqHot.status, 200);
				assert.equal(reqHot.body.evidence, "unavailable");
				assert.equal(reqHot.body.absence, "evidence unavailable");
				assert.deepEqual(reqHot.body.records, []);

				const propHot = await getJson(`${viewer.url}/api/factories/${facWithRecs.factory_id}/proposals`);
				assert.equal(propHot.status, 200);
				assert.equal(propHot.body.evidence, "unavailable");
				assert.equal(propHot.body.absence, "evidence unavailable");
				assert.deepEqual(propHot.body.records, []);
			},
		);
		assert.equal(existsSync(journalPath), true, "Expected hot SQLite journal to remain intact during viewer checks");
	} finally {
		rmSync(journalPath, { force: true });
	}

	// Corrupt proposal digest => proposals returns evidence unavailable.
	{
		const db = new DatabaseSync(statePath);
		try {
			db.prepare("UPDATE factory_constraint_proposals SET record_digest = 'bad-digest' WHERE proposal_id = 'cprop_ro_1'").run();
		} finally { db.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const propBad = await getJson(`${viewer.url}/api/factories/${facWithRecs.factory_id}/proposals`);
			assert.equal(propBad.status, 200);
			assert.equal(propBad.body.evidence, "unavailable");
			assert.equal(propBad.body.absence, "evidence unavailable");
			assert.deepEqual(propBad.body.records, []);
		},
	);
});

test("Slice 3: Negative guard tests for WAL, corrupt requests, missing v12 table, pre-v12 store, pending_write, routing_error, FIFO/symlink session files, and foreign/exited markers", async t => {
	// Part A: Damaged stores, WAL, corrupt requests, missing v12 table, pre-v12 store, pending_write.
	{
		const f = serviceFixture(t, ["builder", "reviewer"]);
		const statePath = join(f.root, "factories.sqlite");
		const coordinationPath = join(f.root, "factory-coordination.sqlite");
		const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
		const ops = factoryOperations(statePath, f.service, { coordinationPath });

		const draft: GenerateRequest = {
			project_cwd: f.cwd,
			topology: "graph",
			task: "PRIVATE_NEG_A",
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "PRIVATE_B", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "PRIVATE_R",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					intervention: { choices: [{ choice_id: "ship", label: "Approve", route: "approve" }], require_route: true },
				},
			],
		};
		const fac = ops({ action: "publish", name: "neg-a", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "sess-neg-a" });
		ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
		ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "neg-ref", brief: "PRIVATE_NEG_BRIEF" });
		const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
		const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
		const reviewCfg = run.manifest.pane_manifest.find(m => m.node_id === "review")!;
		const build = workerFromConfig(t, join(run.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
		const review = workerFromConfig(t, join(run.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: workerModel });
		await build.start();
		await review.start();
		await build.beforeStart();
		await build.complete({ status: "success", summary: "B", detail: "D" });
		await review.beforeStart(notification(build, review));
		await review.deliverFollowUps();

		const waitRev = review.requestDirection({
			question: `Approve\n\u202e with ${coordinationPath} and ${f.home}?`,
			reason: "Check",
			choices: ["ship"],
		});
		let revReqId = "";
		for (let i = 0; i < 50 && !revReqId; i++) {
			revReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
			if (!revReqId) await new Promise(r => setTimeout(r, 15));
		}
		assert.ok(revReqId);
		ops({ action: "respond_request", factory_id: fac.factory_id, request_id: revReqId, authority: auth, response: { kind: "choice", choice_id: "ship" } });
		assert.ok(!(await waitRev).isError);
		await review.complete({ status: "success", summary: "Approved", detail: "D" });

		// Plant malformed handoff-offer.json on publish/outbound so routing_error / admissions unknown triggers if outbound exists,
		// OR test routing_error by corrupting review's outcome claim / adding a malformed destination progress!
		// Wait: review has no outbound node in this 2-node draft; let's plant a pending_write proposal and also test WAL/corrupt!
		{
			const db = new DatabaseSync(statePath);
			try {
				const now = new Date().toISOString();
				const d = "b".repeat(64);
				insertProposalRow(db, buildProposalRow({
					proposal_id: "cprop_pw_1",
					factory_id: fac.factory_id,
					reference: "ref-pw-1",
					proposal_action: "add",
					source: "agent",
					target_constraint_id: null,
					assigned_constraint_id: "lc-pw-1",
					text: `Check ${f.home} rules`,
					run_id: run.task_id,
					attempt_id: `${reviewCfg.instance_id}.1`,
					evidence_ref: `result:${reviewCfg.instance_id}.1`,
					note: null,
					conflicting_ids: "[]",
					canonical_checkout: f.cwd,
					outcome: "confirmed",
					duplicate_of: null,
					rejection_reason: null,
					proposed_at: now,
					decided_at: now,
					decided_by: JSON.stringify({ incarnation_id: "inc-m", pi_session_id: "s" }),
					file_sync_state: "pending_write",
					expected_before_digest: d,
					expected_after_digest: d,
					committed_entry_json: JSON.stringify({ id: "lc-pw-1", text: `Check ${f.home} rules`, provenance: {}, status: "active" }),
					sync_error: null,
					eligibility_json: JSON.stringify({
						kind: "intervention",
						factory_attempt_id: run.attempt_id,
						attempt_id: `${reviewCfg.instance_id}.1`,
						evidence_ref: `result:${reviewCfg.instance_id}.1`,
						verified_at: now,
					}),
				}));
			} finally { db.close(); }
		}
		revokeManagerAuthority(auth);

		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const reqRes = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(reqRes.status, 200);
				const r0 = reqRes.body.records[0];
				assert.equal(r0.question.includes("\n"), false);
				assert.equal(r0.question.includes("\u202e"), false);
				assert.match(r0.question, /\[redacted-path\]/);
				scanSentinels(reqRes.text, [coordinationPath, f.home, f.root, f.cwd, statePath], "req sanitization");

				const propRes = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
				assert.equal(propRes.status, 200);
				assert.equal(propRes.body.evidence, "uncertain");
				assert.equal(propRes.body.records[0].file_sync_state, "pending_write");
				assert.match(propRes.body.records[0].file_sync_state_explanation, /pending durable write/i);
				assert.equal(propRes.body.records[0].uncertain, true);
				scanSentinels(propRes.text, [coordinationPath, f.home, f.root, f.cwd, statePath], "prop sanitization");
			},
		);

		// Stray -wal sidecar => evidence unavailable on both requests and proposals.
		writeFileSync(`${statePath}-wal`, Buffer.from("wal-bytes"));
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const rWal = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(rWal.body.evidence, "unavailable");
				assert.equal(rWal.body.absence, "evidence unavailable");
				const pWal = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
				assert.equal(pWal.body.evidence, "unavailable");
				assert.equal(pWal.body.absence, "evidence unavailable");
			},
		);
		rmSync(`${statePath}-wal`);

		// Corrupt factory_requests digest => requests returns evidence unavailable.
		{
			const db = new DatabaseSync(statePath);
			try {
				db.prepare("UPDATE factory_requests SET record_digest = 'bad-req-digest' WHERE request_id = ?").run(revReqId);
			} finally { db.close(); }
		}
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const rCorrupt = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(rCorrupt.body.evidence, "unavailable");
				assert.equal(rCorrupt.body.absence, "evidence unavailable");
				assert.deepEqual(rCorrupt.body.records, []);
			},
		);

		// Missing factory_constraint_proposals table on schema v12 => proposals returns evidence unavailable.
		{
			const db = new DatabaseSync(statePath);
			try {
				db.exec("DROP TABLE factory_constraint_proposals;");
			} finally { db.close(); }
		}
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const pMissing = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
				assert.equal(pMissing.body.evidence, "unavailable");
				assert.equal(pMissing.body.absence, "evidence unavailable");
				assert.deepEqual(pMissing.body.records, []);
			},
		);
	}

	// Part B: Pre-v12 (schema v11) managed factory on proposals returns "no records" cleanly.
	{
		const f = serviceFixture(t, ["builder"]);
		const statePath = join(f.root, "factories.sqlite");
		const coordinationPath = join(f.root, "factory-coordination.sqlite");
		const viewerEnv = { PATH: join(f.root, "bin") };
		const ops = factoryOperations(statePath, f.service, { coordinationPath });
		const fac = ops({
			action: "publish",
			name: "v11-fac",
			draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE", agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "sess-v11" });
		ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
		revokeManagerAuthority(auth);
		{
			const db = new DatabaseSync(statePath);
			try {
				db.exec("DROP TABLE factory_constraint_proposals; PRAGMA user_version = 11;");
			} finally { db.close(); }
		}
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const p11 = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
				assert.equal(p11.status, 200);
				assert.equal(p11.body.evidence, "available");
				assert.equal(p11.body.absence, "no records");
			},
		);
	}

	// Part C: Direction observation, routing, and exhaustion negative guards + FIFO/symlink checks in child watchdog.
	{
		const f = serviceFixture(t, ["builder", "reviewer"]);
		const statePath = join(f.root, "factories.sqlite");
		const coordinationPath = join(f.root, "factory-coordination.sqlite");
		const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
		const ops = factoryOperations(statePath, f.service, { coordinationPath });
		const draft: GenerateRequest = {
			project_cwd: f.cwd,
			topology: "graph",
			task: "PRIVATE_NEG_C",
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "PRIVATE_CB", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "PRIVATE_CR",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
					intervention: { choices: [{ choice_id: "ship", label: "Approve", route: "approve" }], require_route: true },
				},
				{ node_id: "publish", persona: "builder", sub_task: "PRIVATE_CP", depends_on: ["review"] },
			],
		};
		const fac = ops({ action: "publish", name: "neg-c", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "sess-neg-c" });
		ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
		ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "neg-c-ref", brief: "PRIVATE_C_BRIEF" });
		const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
		const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
		const reviewCfg = run.manifest.pane_manifest.find(m => m.node_id === "review")!;
		const pubCfg = run.manifest.pane_manifest.find(m => m.node_id === "publish")!;
		const build = workerFromConfig(t, join(run.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
		const review = workerFromConfig(t, join(run.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: workerModel });
		await build.start();
		await review.start();
		await build.beforeStart();
		await build.complete({ status: "success", summary: "B", detail: "D" });
		await review.beforeStart(notification(build, review));
		await review.deliverFollowUps();

		const waitRev = review.requestDirection({ question: "Ship?", reason: "Ready", choices: ["ship"] });
		let revReqId = "";
		for (let i = 0; i < 50 && !revReqId; i++) {
			revReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
			if (!revReqId) await new Promise(r => setTimeout(r, 15));
		}
		assert.ok(revReqId);
		ops({ action: "respond_request", factory_id: fac.factory_id, request_id: revReqId, authority: auth, response: { kind: "choice", choice_id: "ship" } });
		assert.ok(!(await waitRev).isError);
		await review.complete({ status: "success", summary: "Approved", detail: "D" });
		revokeManagerAuthority(auth);

		// 1. Corrupt destination progress -> admissions[0].state === "unknown" -> uncertain: true!
		const pubProgress = join(run.manifest.session_dir, `${pubCfg.instance_id}.progress.json`);
		atomicJson(pubProgress, { token: "foreign-token", state: "working", updated_at: Date.now() });
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const r = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(r.body.records[0].admissions[0].state, "unknown");
				assert.equal(r.body.records[0].uncertain, true);
				assert.equal(r.body.evidence, "uncertain");
			},
		);
		rmSync(pubProgress);

		// 2. Malformed handoff-offer.json -> admissions[0].state === "unknown" + uncertain: true!
		const offerFile = join(run.manifest.session_dir, `${pubCfg.instance_id}.1.from-${reviewCfg.instance_id}.handoff-offer.json`);
		const savedOffer = readFileSync(offerFile);
		writeFileSync(offerFile, "{bad-json");
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const r = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(r.body.records[0].admissions[0].state, "unknown");
				assert.equal(r.body.records[0].uncertain, true);
			},
		);

		// 3. FIFO handoff-offer.json -> does NOT hang in child watchdog, triggers routing_error -> admissions: "evidence unavailable" & uncertain: true!
		rmSync(offerFile);
		execFileSync("mkfifo", [offerFile]);
		{
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: f.root,
				viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
				paths: [`/api/factories/${fac.factory_id}/requests`],
			});
			const body = JSON.parse(res!.text);
			assert.equal(body.records[0].admissions.absence, "evidence unavailable");
			assert.equal(body.records[0].uncertain, true);
		}
		rmSync(offerFile);
		writeFileSync(offerFile, savedOffer);

		// 4. FIFO manifest.json -> does NOT hang in child watchdog, fails closed to uncertain!
		const manifestFile = join(run.manifest.session_dir, "manifest.json");
		const savedManifest = readFileSync(manifestFile);
		rmSync(manifestFile);
		execFileSync("mkfifo", [manifestFile]);
		{
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: f.root,
				viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
				paths: [`/api/factories/${fac.factory_id}/requests`],
			});
			const body = JSON.parse(res!.text);
			assert.equal(body.records[0].reconciliation, "uncertain");
			assert.equal(body.records[0].uncertain, true);
		}
		rmSync(manifestFile);
		writeFileSync(manifestFile, savedManifest);

		// 5. FIFO index manifest (${taskId}.json) -> does NOT hang in child watchdog, fails closed to uncertain!
		const indexFile = join(f.stateDir, `${run.task_id}.json`);
		const savedIndex = readFileSync(indexFile);
		rmSync(indexFile);
		execFileSync("mkfifo", [indexFile]);
		{
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: f.root,
				viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
				paths: [`/api/factories/${fac.factory_id}/requests`],
			});
			const body = JSON.parse(res!.text);
			assert.equal(body.records[0].reconciliation, "uncertain");
			assert.equal(body.records[0].uncertain, true);
		}
		rmSync(indexFile);
		writeFileSync(indexFile, savedIndex);

		// 6. FIFO finalize.json -> does NOT hang in child watchdog, fails closed to uncertain exhaustion!
		const finFile = join(run.manifest.session_dir, `${reviewCfg.instance_id}.finalize.json`);
		const savedFin = existsSync(finFile) ? readFileSync(finFile) : undefined;
		rmSync(finFile, { force: true });
		execFileSync("mkfifo", [finFile]);
		{
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: f.root,
				viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
				paths: [`/api/factories/${fac.factory_id}/requests`],
			});
			const body = JSON.parse(res!.text);
			assert.ok(body.records.some((r: any) => r.kind === "exhaustion" && r.state === "unknown" && r.uncertain === true));
		}
		rmSync(finFile);
		if (savedFin !== undefined) writeFileSync(finFile, savedFin);

		// 7. Pending request on build with exited ready.json PID and missing release.json -> reconciliation: "uncertain"!
		const receiverBuild = {
			instance_id: buildCfg.instance_id,
			run_token: run.manifest.token,
			session_id: `session-${buildCfg.instance_id}`,
			incarnation: "inc-build-exited",
			pid: process.pid,
			...directionProcess(process.pid),
		};
		const buildReadyPath = join(run.manifest.session_dir, `${buildCfg.instance_id}.ready.json`);
		const savedBuildReady = readFileSync(buildReadyPath);
		const buildReadyJson = JSON.parse(savedBuildReady.toString("utf8"));
		atomicJson(buildReadyPath, { ...buildReadyJson, version: 2, pid: 2147483646, start_time: receiverBuild.start, direction_incarnation: receiverBuild.incarnation });
		atomicJson(join(run.manifest.session_dir, `${buildCfg.instance_id}.progress.json`), { token: run.manifest.token, state: "working", updated_at: Date.now() });
		const buildAttemptKey = `${buildCfg.instance_id}.1`;
		const buildResPath = join(run.manifest.session_dir, `${buildAttemptKey}.result.json`);
		const savedBuildRes = readFileSync(buildResPath);
		rmSync(buildResPath);
		let exitedReqId = "";
		{
			const reqDb = openRequestDatabase(statePath);
			try {
				inTransaction(reqDb, () => {
					const r = createRequest(reqDb, {
						factory_id: fac.factory_id,
						input_id: run.input_id,
						attempt_id: run.attempt_id,
						task_id: run.task_id,
						node_id: "build",
						node_attempt_id: buildAttemptKey,
						question: "Exited worker check?",
						reason: "Check",
						choices: ["proceed"],
					}, receiverBuild);
					exitedReqId = r.request_id;
				});
			} finally { reqDb.close(); }
		}
		const releaseFile = join(run.manifest.session_dir, "release.json");
		const savedRelease = readFileSync(releaseFile);
		rmSync(releaseFile);
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const r = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				const exitedRec = r.body.records.find((x: any) => x.request_id === exitedReqId);
				assert.ok(exitedRec);
				assert.equal(exitedRec.reconciliation, "uncertain");
				assert.equal(exitedRec.uncertain, true);
			},
		);
		writeFileSync(buildReadyPath, savedBuildReady);
		writeFileSync(buildResPath, savedBuildRes);
		writeFileSync(releaseFile, savedRelease);

		// 8. Live ready.json (process.pid) with non-working progress.json ("waiting") -> reconciliation: "uncertain"!
		const buildClaimPath = join(run.manifest.session_dir, `${buildAttemptKey}.outcome-claim.json`);
		const savedBuildClaim = existsSync(buildClaimPath) ? readFileSync(buildClaimPath) : undefined;
		rmSync(buildClaimPath, { force: true });
		atomicJson(buildReadyPath, { ...buildReadyJson, version: 2, pid: process.pid, start_time: receiverBuild.start, direction_incarnation: receiverBuild.incarnation });
		atomicJson(join(run.manifest.session_dir, `${buildCfg.instance_id}.progress.json`), { token: run.manifest.token, state: "waiting", attempt_id: buildAttemptKey, updated_at: Date.now() });
		rmSync(buildResPath);
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const r = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				const waitingRec = r.body.records.find((x: any) => x.request_id === exitedReqId);
				assert.ok(waitingRec);
				assert.equal(waitingRec.reconciliation, "uncertain");
				assert.equal(waitingRec.uncertain, true);
			},
		);
		if (savedBuildClaim !== undefined) writeFileSync(buildClaimPath, savedBuildClaim);
		writeFileSync(buildReadyPath, savedBuildReady);
		writeFileSync(buildResPath, savedBuildRes);

		// 9. Oversized (> 1 MiB) valid indexFile -> fails closed to uncertain!
		const parsedIndex = JSON.parse(savedIndex.toString("utf8"));
		writeFileSync(indexFile, JSON.stringify({ ...parsedIndex, task: "x".repeat(1_200_000) }));
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const r = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
				assert.equal(r.body.records[0].reconciliation, "uncertain");
				assert.equal(r.body.records[0].uncertain, true);
			},
		);
		writeFileSync(indexFile, savedIndex);

		// 10. Transition finalized + FIFO result.json -> precheckSessionFiles catches FIFO before readFinalization/readJson can block!
		const revTransPath = join(run.manifest.session_dir, `${reviewCfg.instance_id}.1.transition.json`);
		const revResPath = join(run.manifest.session_dir, `${reviewCfg.instance_id}.1.result.json`);
		const savedRevRes = readFileSync(revResPath);
		rmSync(revResPath);
		execFileSync("mkfifo", [revResPath]);
		atomicJson(revTransPath, { version: 1, run_id: run.task_id, instance_id: reviewCfg.instance_id, from_attempt: 1, winner: "finalized" });
		{
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: f.root,
				viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
				paths: [`/api/factories/${fac.factory_id}/requests`],
			});
			const body = JSON.parse(res!.text);
			assert.ok(body.records.some((r: any) => r.kind === "exhaustion" && r.state === "unknown" && r.uncertain === true));
		}
		rmSync(revTransPath);
		rmSync(revResPath);
		writeFileSync(revResPath, savedRevRes);

		// 11. Proposal canonical_checkout outside dirname(statePath) is scrubbed from proposal text!
		const sepCheckout = mkdtempSync(join(tmpdir(), "fwv-sep-checkout-"));
		t.after(() => rmSync(sepCheckout, { recursive: true, force: true }));
		{
			const db = new DatabaseSync(statePath);
			try {
				const now = new Date().toISOString();
				insertProposalRow(db, buildProposalRow({
					proposal_id: "cprop_sep_checkout",
					factory_id: fac.factory_id,
					reference: "ref-sep-checkout",
					proposal_action: "add",
					source: "agent",
					target_constraint_id: null,
					assigned_constraint_id: null,
					text: `Never write to ${sepCheckout} directly`,
					run_id: run.task_id,
					attempt_id: buildAttemptKey,
					evidence_ref: `attempt:${buildAttemptKey}`,
					note: null,
					conflicting_ids: "[]",
					canonical_checkout: sepCheckout,
					outcome: "pending",
					duplicate_of: null,
					rejection_reason: null,
					proposed_at: now,
					decided_at: null,
					decided_by: null,
					file_sync_state: null,
					expected_before_digest: null,
					expected_after_digest: null,
					committed_entry_json: null,
					sync_error: null,
					eligibility_json: JSON.stringify({
						kind: "intervention",
						factory_attempt_id: run.attempt_id,
						attempt_id: buildAttemptKey,
						evidence_ref: `attempt:${buildAttemptKey}`,
						verified_at: now,
					}),
				}));
			} finally { db.close(); }
		}
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const pSep = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/proposals`);
				const sepRec = pSep.body.records.find((x: any) => x.proposal_id === "cprop_sep_checkout");
				assert.ok(sepRec);
				assert.match(sepRec.text, /\[redacted-path\]/);
				scanSentinels(pSep.text, [sepCheckout], "separate canonical_checkout scrub");
			},
		);
	}
});

test("B3 fidelity: viewer requests match op({action:'requests'}) ids, states, consumption, and reconciliation including bad finalized_by without inventing exhaustion", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const revChoice = { choice_id: "revise", label: "Revise", route: "reject" as const };
	const appChoice = { choice_id: "ship", label: "Approve", route: "approve" as const };
	const clarChoice = { choice_id: "proceed", label: "Proceed" };
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_FIDELITY_TASK",
		agents: [
			{ node_id: "prep", persona: "builder", sub_task: "PRIVATE_FID_PREP", intervention: { choices: [clarChoice] } },
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_FID_BUILD", intervention: { choices: [clarChoice] } },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_FID_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1, on_exhausted: "needs_attention" },
				intervention: { choices: [revChoice, appChoice], require_route: true },
			},
			{ node_id: "docs", persona: "builder", sub_task: "PRIVATE_FID_DOCS", intervention: { choices: [clarChoice] } },
		],
	};

	const fac = ops({ action: "publish", name: "fidelity-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-fid" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Run 1: exhaustion-pending + resolved (consumed + result).
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "fid-run-1", brief: "PRIVATE_FID_B1" });
	const run1 = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const build1Cfg = run1.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const review1Cfg = run1.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build1 = workerFromConfig(t, join(run1.manifest.session_dir, `${build1Cfg.instance_id}.config.json`), { model: workerModel });
	const review1 = workerFromConfig(t, join(run1.manifest.session_dir, `${review1Cfg.instance_id}.config.json`), { model: workerModel });
	await build1.start();
	await review1.start();
	await build1.beforeStart();
	const wBuild1 = build1.requestDirection({ question: "Clarify build?", reason: "R", choices: ["proceed"] });
	let build1ReqId = "";
	for (let i = 0; i < 50 && !build1ReqId; i++) {
		build1ReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!build1ReqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(build1ReqId);
	ops({ action: "respond_request", factory_id: fac.factory_id, request_id: build1ReqId, authority: auth, response: { kind: "choice", choice_id: "proceed" } });
	assert.ok(!(await wBuild1).isError);
	await build1.complete({ status: "success", summary: "B1", detail: "D" });

	await review1.beforeStart(notification(build1, review1));
	await review1.deliverFollowUps();
	const wRev1 = review1.requestDirection({ question: "Approve or reject?", reason: "R", choices: ["revise", "ship"] });
	let rev1ReqId = "";
	for (let i = 0; i < 50 && !rev1ReqId; i++) {
		rev1ReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!rev1ReqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(rev1ReqId);
	ops({ action: "respond_request", factory_id: fac.factory_id, request_id: rev1ReqId, authority: auth, response: { kind: "choice", choice_id: "revise" } });
	assert.ok(!(await wRev1).isError);
	await review1.complete({ status: "success", summary: "Revise once", detail: "D" });

	// Revision round 2 -> build completes -> review rejects at limit -> exhaustion-pending!
	await build1.beforeStart(notification(review1, build1));
	await build1.deliverFollowUps();
	await build1.complete({ status: "success", summary: "B2", detail: "D" });
	await review1.beforeStart(notification(build1, review1));
	await review1.deliverFollowUps();
	const wRev2 = review1.requestDirection({ question: "Approve or reject at limit?", reason: "R", choices: ["revise", "ship"] });
	let rev2ReqId = "";
	for (let i = 0; i < 50 && !rev2ReqId; i++) {
		rev2ReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!rev2ReqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(rev2ReqId);
	ops({ action: "respond_request", factory_id: fac.factory_id, request_id: rev2ReqId, authority: auth, response: { kind: "choice", choice_id: "revise" } });
	assert.ok(!(await wRev2).isError);
	await review1.complete({ status: "success", summary: "Reject at limit", detail: "D" });

	// Also add pending, awaiting_consumption, consumed/continuing, never_consumed, cancelled, failed on prep & docs of run1!
	const prep1Cfg = run1.manifest.pane_manifest.find(m => m.node_id === "prep")!;
	const docs1Cfg = run1.manifest.pane_manifest.find(m => m.node_id === "docs")!;
	const prep1 = workerFromConfig(t, join(run1.manifest.session_dir, `${prep1Cfg.instance_id}.config.json`), { model: workerModel });
	await prep1.start();
	await prep1.beforeStart();
	const wPrepPending = prep1.requestDirection({ question: "Pending on prep?", reason: "R", choices: ["proceed"] });
	void wPrepPending.catch(() => {});
	let prepPendingId = "";
	for (let i = 0; i < 50 && !prepPendingId; i++) {
		prepPendingId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.node_id === "prep" && r.state === "pending")?.request_id ?? "";
		if (!prepPendingId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(prepPendingId);

	const receiverDocs = {
		instance_id: docs1Cfg.instance_id,
		run_token: run1.manifest.token,
		session_id: `session-${docs1Cfg.instance_id}`,
		incarnation: "inc-fid-docs",
		pid: process.pid,
		...directionProcess(process.pid),
	};
	const docsReady = readJson<Record<string, unknown>>(join(run1.manifest.session_dir, `${docs1Cfg.instance_id}.ready.json`));
	atomicJson(join(run1.manifest.session_dir, `${docs1Cfg.instance_id}.ready.json`), {
		...docsReady,
		version: 2,
		start_time: receiverDocs.start,
		direction_incarnation: receiverDocs.incarnation,
	});
	atomicJson(join(run1.manifest.session_dir, `${docs1Cfg.instance_id}.progress.json`), {
		token: run1.manifest.token,
		state: "working",
		attempt_id: `${docs1Cfg.instance_id}.1`,
		updated_at: Date.now(),
		started_at: Date.now(),
	});
	const docsAttemptKey = `${docs1Cfg.instance_id}.1`;
	let contId = "";
	{
		const reqDb = openRequestDatabase(statePath);
		try {
			inTransaction(reqDb, () => {
				const rNever = createRequest(reqDb, {
					factory_id: fac.factory_id, input_id: run1.input_id, attempt_id: run1.attempt_id, task_id: run1.task_id,
					node_id: "docs", node_attempt_id: docsAttemptKey, question: "Never consumed?", reason: "R", choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rNever.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-m", pi_session_id: "s" });
				terminateNodeRequests(reqDb, run1.attempt_id, "docs", "cancelled");

				const rCancel = createRequest(reqDb, {
					factory_id: fac.factory_id, input_id: run1.input_id, attempt_id: run1.attempt_id, task_id: run1.task_id,
					node_id: "docs", node_attempt_id: docsAttemptKey, question: "Cancelled?", reason: "R", choices: ["proceed"],
				}, receiverDocs);
				terminateNodeRequests(reqDb, run1.attempt_id, "docs", "cancelled");
				assert.ok(rCancel.request_id);

				const rFail = createRequest(reqDb, {
					factory_id: fac.factory_id, input_id: run1.input_id, attempt_id: run1.attempt_id, task_id: run1.task_id,
					node_id: "docs", node_attempt_id: docsAttemptKey, question: "Failed?", reason: "R", choices: ["proceed"],
				}, receiverDocs);
				terminateNodeRequests(reqDb, run1.attempt_id, "docs", "failed");
				assert.ok(rFail.request_id);

				const rCont = createRequest(reqDb, {
					factory_id: fac.factory_id, input_id: run1.input_id, attempt_id: run1.attempt_id, task_id: run1.task_id,
					node_id: "docs", node_attempt_id: docsAttemptKey, question: "Consumed continuing?", reason: "R", choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rCont.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-m", pi_session_id: "s" });
				contId = rCont.request_id;
			});
		} finally { reqDb.close(); }
	}
	ops({ action: "redeliver_response", factory_id: fac.factory_id, request_id: contId, authority: auth });
	{
		const reqDb = openRequestDatabase(statePath);
		try {
			inTransaction(reqDb, () => {
				assert.equal(claimConsumption(reqDb, contId, receiverDocs), "claimed");
				recordDirectionDelivery(reqDb, contId, receiverDocs);
				const rAwait = createRequest(reqDb, {
					factory_id: fac.factory_id, input_id: run1.input_id, attempt_id: run1.attempt_id, task_id: run1.task_id,
					node_id: "docs", node_attempt_id: docsAttemptKey, question: "Awaiting?", reason: "R", choices: ["proceed"],
				}, receiverDocs);
				recordResponse(reqDb, rAwait.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-m", pi_session_id: "s" });
			});
		} finally { reqDb.close(); }
	}

	// Run 2 (another factory with its own fixture): bad finalized_by WITHOUT exhausted or settled_capacity must NOT invent an exhaustion request.
	const f2 = serviceFixture(t, ["builder", "reviewer"]);
	const statePath2 = join(f2.root, "factories.sqlite");
	const coordinationPath2 = join(f2.root, "factory-coordination.sqlite");
	const viewerEnv2 = { PATH: join(f2.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f2.stateDir };
	const ops2 = factoryOperations(statePath2, f2.service, { coordinationPath: coordinationPath2 });
	const facBadFin = ops2({ action: "publish", name: "fidelity-bad-fin", draft: { ...draft, project_cwd: f2.cwd }, sessionModel });
	const auth2 = createManagerAuthority({ pi_session_id: "sess-fid-2" });
	ops2({ action: "resume", factory_id: facBadFin.factory_id, authority: auth2 });
	ops2({ action: "submit", factory_id: facBadFin.factory_id, authority: auth2, reference: "fid-run-2", brief: "PRIVATE_FID_B2" });
	const run2 = await ops2({ action: "launch", factory_id: facBadFin.factory_id, authority: auth2 });
	const build2Cfg = run2.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const review2Cfg = run2.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build2 = workerFromConfig(t, join(run2.manifest.session_dir, `${build2Cfg.instance_id}.config.json`), { model: workerModel });
	await build2.start();
	await build2.beforeStart();
	const wBuild2 = build2.requestDirection({ question: "Bad fin build?", reason: "R", choices: ["proceed"] });
	void wBuild2.catch(() => {});
	let build2ReqId = "";
	for (let i = 0; i < 50 && !build2ReqId; i++) {
		build2ReqId = ops2({ action: "requests", factory_id: facBadFin.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!build2ReqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(build2ReqId);
	atomicJson(join(run2.manifest.session_dir, `${review2Cfg.instance_id}.finalize.json`), {
		version: 1,
		run_id: run2.task_id,
		instance_id: review2Cfg.instance_id,
		attempt_id: `${review2Cfg.instance_id}.1`,
		finalized_by: "bad_actor",
	});

	revokeManagerAuthority(auth);
	revokeManagerAuthority(auth2);

	const expectedFid = ops({ action: "requests", factory_id: fac.factory_id });
	const expectedBadFin = ops2({ action: "requests", factory_id: facBadFin.factory_id });
	assert.equal(expectedBadFin.length, 1, "op({action:'requests'}) must not invent an exhaustion request for bad finalized_by");

	const projectComparable = (list: any[]) => list.map(r => ({
		request_id: r.request_id,
		state: r.state,
		consumption: r.consumption,
		reconciliation: r.reconciliation,
	}));

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res1 = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res1.status, 200);
			assert.deepEqual(projectComparable(res1.body.records), projectComparable(expectedFid));
			// Confirm all target states/consumption/reconciliation classes are covered:
			const states = new Set(res1.body.records.map((r: any) => `${r.state}:${r.consumption}:${r.reconciliation}`));
			assert.ok(states.has("pending:not_applicable:pending"));
			assert.ok(states.has("responded:awaiting_consumption:resolved"));
			assert.ok(states.has("responded:consumed:continuing"));
			assert.ok(states.has("responded:consumed:resolved"));
			assert.ok(states.has("responded:never_consumed:cancelled"));
			assert.ok(states.has("cancelled:not_applicable:cancelled"));
			assert.ok(states.has("failed:not_applicable:failed"));
			assert.ok(res1.body.records.some((r: any) => r.kind === "exhaustion" && r.state === "pending"));
		},
	);
	await verifyReadOnlyViewer(
		{ stateDirs: f2.root, viewerOptions: { statePath: statePath2, coordinationPath: coordinationPath2, env: viewerEnv2, home: f2.home } },
		async viewer => {
			const res2 = await getJson(`${viewer.url}/api/factories/${facBadFin.factory_id}/requests`);
			assert.equal(res2.status, 200);
			assert.deepEqual(projectComparable(res2.body.records), projectComparable(expectedBadFin));
		},
	);
});

test("B1: viewer never takes live scope snapshot (FIFO/symlink/oversized .git/HEAD, large checkout, recorded vs absent scope)", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	writeFileSync(join(f.cwd, ".pi", "bootstrap.json"), JSON.stringify({
		lanes: { contained: ["docs/**"], closed: ["secrets/**"] },
	}));
	mkdirSync(join(f.cwd, "docs"), { recursive: true });
	writeFileSync(join(f.cwd, "docs", "ok.md"), "initial\n");

	const appChoice = { choice_id: "ship", label: "Approve", route: "approve" as const };
	const revChoice = { choice_id: "revise", label: "Revise", route: "reject" as const };
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_B1_LANES",
		max_total_attempts: 3,
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_B1_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_B1_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1, on_exhausted: "needs_attention" },
				intervention: { choices: [revChoice, appChoice], require_route: true },
			},
		],
	};

	const fac = ops({ action: "publish", name: "b1-lanes-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-b1" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "b1-run", brief: "PRIVATE_B1_BRIEF" });
	const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });

	const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = run.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build = workerFromConfig(t, join(run.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
	const review = workerFromConfig(t, join(run.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await review.start();
	await build.beforeStart();
	await build.complete({ status: "success", summary: "B1", detail: "D" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	const waitRev = review.requestDirection({ question: "Approve lane?", reason: "Check", choices: ["revise", "ship"] });
	void waitRev.catch(() => {});
	let revReqId = "";
	for (let i = 0; i < 50 && !revReqId; i++) {
		revReqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!revReqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(revReqId);
	const savedReviewReady = readFileSync(join(run.manifest.session_dir, `${reviewCfg.instance_id}.ready.json`));
	review.vanish();
	build.vanish();
	writeFileSync(join(run.manifest.session_dir, `${reviewCfg.instance_id}.ready.json`), savedReviewReady);
	revokeManagerAuthority(auth);

	// 1. FIFO at <cwd>/.git/HEAD with pending review-decision request (no after snapshot yet): must NOT hang!
	const gitDir = join(f.cwd, ".git");
	const gitHead = join(gitDir, "HEAD");
	mkdirSync(gitDir, { recursive: true });
	execFileSync("mkfifo", [gitHead]);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		const rec = body.records.find((r: any) => r.request_id === revReqId);
		assert.ok(rec);
		assert.equal(rec.risk_lane.lane, "closed");
		assert.equal(rec.risk_lane.unknown_scope, true);
		assert.equal(rec.risk_lane.scope?.absence, "evidence unavailable");
	}
	rmSync(gitHead);

	// 2. Symlinked .git/HEAD pointing to an unguarded FIFO outside cwd: must NOT follow symlink!
	const outsideFifo = join(f.root, "outside-head-fifo");
	execFileSync("mkfifo", [outsideFifo]);
	symlinkSync(outsideFifo, gitHead);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		const rec = body.records.find((r: any) => r.request_id === revReqId);
		assert.equal(rec.risk_lane.unknown_scope, true);
		assert.equal(rec.risk_lane.scope?.absence, "evidence unavailable");
	}
	rmSync(gitHead);
	rmSync(outsideFifo);

	// 3. Oversized .git/HEAD (> 2 MiB): must NOT read it!
	writeFileSync(gitHead, Buffer.alloc(2 * 1024 * 1024 + 1024, 0x41));
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		const rec = body.records.find((r: any) => r.request_id === revReqId);
		assert.equal(rec.risk_lane.unknown_scope, true);
		assert.equal(rec.risk_lane.scope?.absence, "evidence unavailable");
	}
	rmSync(gitHead);

	// 4. Large checkout (> 5000 files) + closed-lane file on disk: response depends ONLY on recorded snapshots!
	// First capture a clean recorded `after` snapshot where only docs/ok.md changed (before adding bulk/secrets).
	writeFileSync(join(f.cwd, "docs", "ok.md"), "updated docs\n");
	captureLaneSnapshot({
		sessionDir: run.manifest.session_dir,
		kind: "after",
		runId: run.task_id,
		reviewer: reviewCfg.instance_id,
		nodeId: "review",
		attempt: 1,
		projectCwd: f.cwd,
	});
	// Now mutate the live working tree with > 5000 files, a closed-lane file, AND a FIFO .git/HEAD.
	const bulkDir = join(f.cwd, "bulk");
	mkdirSync(bulkDir, { recursive: true });
	for (let i = 0; i < 5005; i++) {
		writeFileSync(join(bulkDir, `f-${i}.txt`), "x");
	}
	mkdirSync(join(f.cwd, "secrets"), { recursive: true });
	writeFileSync(join(f.cwd, "secrets", "secret.txt"), "top-secret");
	execFileSync("mkfifo", [gitHead]);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		const rec = body.records.find((r: any) => r.request_id === revReqId);
		assert.equal(rec.risk_lane.lane, "contained");
		assert.equal(rec.risk_lane.scope, "recorded");
		assert.equal(rec.risk_lane.unknown_scope, undefined);
	}

	// 5. Also verify directionExhaustions never takes a live scope snapshot when result is absent (disposition + settled_capacity + FIFO .git/HEAD).
	rmSync(join(run.manifest.session_dir, `${reviewCfg.instance_id}.1.lane-after.json`));
	atomicJson(join(run.manifest.session_dir, `${reviewCfg.instance_id}.1.disposition.json`), {
		version: 1,
		identity: {
			run_id: run.task_id,
			instance_id: reviewCfg.instance_id,
			node_id: "review",
			persona_name: "reviewer",
			kind: "agent",
			attempt_id: `${reviewCfg.instance_id}.1`,
		},
		state: "blocked",
		reason: "Blocked without result",
		causes: [],
		recorded_at: new Date().toISOString(),
	});
	atomicJson(join(run.manifest.session_dir, `${reviewCfg.instance_id}.finalize.json`), {
		version: 2,
		run_id: run.task_id,
		instance_id: reviewCfg.instance_id,
		attempt_id: `${reviewCfg.instance_id}.1`,
		finalized_by: "dispatcher",
		settled_capacity: "run_budget",
	});
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		const exh = body.records.find((r: any) => r.kind === "exhaustion");
		assert.ok(exh, `expected exhaustion record: ${res!.text}`);
		assert.ok(exh.risk_lane, `expected risk_lane on exhaustion: ${JSON.stringify(exh)}`);
		assert.equal(exh.risk_lane.lane, "closed");
		assert.equal(exh.risk_lane.unknown_scope, true);
		assert.equal(exh.risk_lane.scope?.absence, "evidence unavailable");
	}
	rmSync(gitHead);
});

test("B2 + LOW 2/3: non-nested CLI layout (no viewer home option) scrubs checkout/session/home/store/index paths, prefix paths, control markers, surrogate pairs, choice labels, and proposal provenance", async t => {
	// Non-nested directories under a shared temp root: stateDir, coordDir, indexDir, checkoutDir, homeDir are siblings (none nested under dirname(statePath)).
	const outerRoot = mkdtempSync(join(tmpdir(), "fwv-b2-outer-"));
	t.after(() => rmSync(outerRoot, { recursive: true, force: true }));
	const stateDir = join(outerRoot, "state store dir");
	const coordDir = join(outerRoot, "coord store dir");
	const indexDir = join(outerRoot, "index store dir");
	const checkoutDir = join(outerRoot, "checkout proj dir");
	const homeDir = join(outerRoot, "cli home dir");
	const binDir = join(outerRoot, "bin");
	for (const d of [stateDir, coordDir, indexDir, join(checkoutDir, ".pi", "agents"), join(checkoutDir, "extensions"), homeDir, binDir]) {
		mkdirSync(d, { recursive: true });
	}
	writeFileSync(join(binDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(binDir, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(checkoutDir, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(checkoutDir, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read,bash\n---\nExact persona builder\n");

	const statePath = join(stateDir, "factories.sqlite");
	const coordinationPath = join(coordDir, "factory-coordination.sqlite");
	const { BootstrapService } = await import("./lifecycle.ts");
	const { dirname: pathDirname } = await import("node:path");
	const { fileURLToPath: urlToPath } = await import("node:url");
	const extDir = pathDirname(pathDirname(urlToPath(import.meta.url)));
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	let seq = 0;
	const service = new BootstrapService({
		extensionDir: extDir,
		stateDir: indexDir,
		home: homeDir,
		pollMs: 5,
		exec: async (_command, args) => {
			const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
			if (args[0] === "tab" && args[1] === "create") {
				seq++;
				const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
				tabs.push(tab);
				return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const tab = tabs.find(item => item.pane_id === args[2])!;
				const [task, instance] = tab.label.split(":");
				const sDir = join(checkoutDir, ".pi", "agent-sessions", task);
				const config = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
				atomicJson(join(sDir, `${instance}.ready.json`), ready);
				const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
				mkdirSync(registryDir, { recursive: true });
				atomicJson(join(registryDir, `${instance}.json`), ready);
				return ok();
			}
			if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs });
			if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
			if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
			if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
			return ok();
		},
		env: { PATH: binDir, HERDR_ENV: "1", HERDR_PANE_ID: "caller", PI_BOOTSTRAP_STATE_DIR: indexDir },
	});
	const ops = factoryOperations(statePath, service, { coordinationPath });

	const choiceLabelWithPaths = `Use ${join(checkoutDir, "src", "secret.ts")} or ${homeDir}`;
	const draft: GenerateRequest = {
		project_cwd: checkoutDir,
		topology: "graph",
		task: "PRIVATE_B2_TASK",
		agents: [
			{
				node_id: "build",
				persona: "builder",
				sub_task: "PRIVATE_B2_SUB",
				intervention: { choices: [{ choice_id: "use", label: choiceLabelWithPaths }] },
			},
		],
	};

	const fac = ops({ action: "publish", name: "b2-nonnested", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-b2" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "b2-run", brief: "PRIVATE_B2_BRIEF" });
	const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const taskId = run.task_id;
	const sessionDir = run.manifest.session_dir;
	const attemptId = run.attempt_id;
	const inputId = run.input_id;
	const runToken = run.manifest.token;

	// Plant a request whose question contains:
	// - checkout path + file (`checkoutDir/src/secret.ts`)
	// - session dir (`sessionDir`)
	// - home path (`homeDir`)
	// - stateDir sibling (`join(stateDir, "sibling-secret.txt")`) with space in stateDir (kills V8!)
	// - indexDir sibling (`join(indexDir, "idx-secret.txt")`) with space in indexDir (kills V9!)
	// - prefix path (`${checkoutDir}foo`) -> must redact whole token, NOT `[redacted-path]foo`
	// - generic absolute paths (`/etc/passwd`, `~/secrets/token`, `C:\\Users\\bob\\key.txt`)
	// - control/bidi chars (`\u202e`, `\u200b`) -> visible `[ctrl]` marker
	// - normal prose (`A/B`, `~5`) -> preserved!
	const stateSibling = join(stateDir, "sibling-secret.txt");
	const indexSibling = join(indexDir, "idx-secret.txt");
	const questionPart = [
		`Checkout ${join(checkoutDir, "src", "secret.ts")}`,
		`session ${sessionDir}`,
		`home ${join(homeDir, "home-secret.txt")}`,
		`stateSib ${stateSibling}`,
		`idxSib ${indexSibling}`,
		`prefix ${checkoutDir}foo`,
		`abs /etc/passwd`,
		`tilde ~/secrets/token`,
		`win C:\\Users\\bob\\key.txt`,
		`ctrl \u202e\u200b`,
		`prose A/B ~5`,
	].join(" | ");
	const receiver = {
		instance_id: "a1-build",
		run_token: runToken,
		session_id: "sess-a1-build",
		incarnation: "inc-b2",
		pid: process.pid,
		...directionProcess(process.pid),
	};
	{
		const reqDb = openRequestDatabase(statePath);
		try {
			inTransaction(reqDb, () => {
				createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: inputId,
					attempt_id: attemptId,
					task_id: taskId,
					node_id: "build",
					node_attempt_id: "a1-build.1",
					question: questionPart,
					reason: "Check B2",
					choices: ["use"],
				}, receiver);
				// Also create a second request with a surrogate pair right at truncation boundary (510 code points + 🚀 + extra)
				// and a choice label with a surrogate pair at 198 code points + 🚀 + extra.
				const r2Created = createRequest(reqDb, {
					factory_id: fac.factory_id,
					input_id: inputId,
					attempt_id: attemptId,
					task_id: taskId,
					node_id: "build",
					node_attempt_id: "a1-build.2",
					question: `${"A".repeat(510)}🚀extra-text`,
					reason: "Surrogate boundary",
					choices: ["use"],
				}, receiver);
				const longChoiceJson = JSON.stringify([{ choice_id: "use", label: `${"L".repeat(198)}🚀extra-choice` }]);
				const row2 = reqDb.prepare("SELECT * FROM factory_requests WHERE request_id = ?").get(r2Created.request_id) as Record<string, string | null>;
				const fields = ["request_id", "factory_id", "input_id", "attempt_id", "task_id", "node_id", "node_attempt_id", "question", "reason", "evidence", "choices", "recommendation", "state", "created_at", "response", "responder", "responded_at", "consumed_at", "terminated_at", "terminated_reason"];
				const updatedRow2 = { ...row2, choices: longChoiceJson };
				const digest2 = sha256Hex(JSON.stringify(fields.map(k => updatedRow2[k])));
				reqDb.prepare("UPDATE factory_requests SET choices = ?, record_digest = ? WHERE request_id = ?").run(longChoiceJson, digest2, r2Created.request_id);
			});
		} finally { reqDb.close(); }
	}

	// Plant a proposal with sentinel paths in text, provenance.note, provenance.evidence_ref, and rejection_reason.
	{
		const db = new DatabaseSync(statePath);
		try {
			const now = new Date().toISOString();
			insertProposalRow(db, buildProposalRow({
				proposal_id: "cprop_b2_1",
				factory_id: fac.factory_id,
				reference: "ref-b2-1",
				proposal_action: "add",
				source: "agent",
				target_constraint_id: null,
				assigned_constraint_id: null,
				text: `Never touch ${join(checkoutDir, "src", "p.ts")} or ${stateSibling} or ${homeDir}`,
				run_id: taskId,
				attempt_id: "a1-build.1",
				evidence_ref: join(checkoutDir, "evidence", "e.json"),
				note: `Provenance note ${sessionDir} and ${indexSibling} and ${homeDir}`,
				conflicting_ids: "[]",
				canonical_checkout: checkoutDir,
				outcome: "rejected",
				duplicate_of: null,
				rejection_reason: `Rejected due to ${indexSibling} and ${homeDir}`,
				proposed_at: now,
				decided_at: now,
				decided_by: JSON.stringify({ incarnation_id: "inc-m", pi_session_id: "sess-b2" }),
				file_sync_state: null,
				expected_before_digest: null,
				expected_after_digest: null,
				committed_entry_json: null,
				sync_error: null,
				eligibility_json: JSON.stringify({
					kind: "intervention",
					factory_attempt_id: attemptId,
					attempt_id: "a1-build.1",
					evidence_ref: join(checkoutDir, "evidence", "e.json"),
					verified_at: now,
				}),
			}));
		} finally { db.close(); }
	}
	revokeManagerAuthority(auth);

	// Note: homeDir is stateDirs[0], and viewerOptions OMITS `home` (matching factory/viewer/cli.ts!).
	// In child process, HOME = homeDir, and PI_BOOTSTRAP_STATE_DIR = indexDir.
	const responses = await verifyReadOnlyViewerInChild({
		stateDirs: [homeDir, stateDir, coordDir, indexDir, checkoutDir],
		viewerOptions: {
			statePath,
			coordinationPath,
			env: { PATH: binDir, PI_BOOTSTRAP_STATE_DIR: indexDir },
			// NO `home` option passed!
		},
		paths: [
			`/api/factories/${fac.factory_id}/requests`,
			`/api/factories/${fac.factory_id}/proposals`,
		],
	});

	const reqRes = JSON.parse(responses[0]!.text);
	const propRes = JSON.parse(responses[1]!.text);
	const r1 = reqRes.records.find((r: any) => r.node_attempt_id === "a1-build.1");
	const r2 = reqRes.records.find((r: any) => r.node_attempt_id === "a1-build.2");
	assert.ok(r1);
	assert.ok(r2);

	// Check visible control marker, prefix whole-token redaction, generic path scrub, and preserved prose!
	assert.match(r1.question, /\[ctrl\]/);
	assert.equal(r1.question.includes("[redacted-path]foo"), false, "prefix blocked path must redact whole token");
	assert.equal(r1.question.includes("/etc/passwd"), false);
	assert.equal(r1.question.includes("~/secrets/token"), false);
	assert.equal(r1.question.includes("C:\\Users\\bob\\key.txt"), false);
	assert.match(r1.question, /prose A\/B ~5/);

	// Check surrogate-pair truncation on both question (512 code points) and choice label (200 code points).
	assert.equal(r2.question.isWellFormed(), true, "question truncation must not split surrogate pair");
	assert.ok(Array.from(r2.question).length <= 512);
	assert.ok(r2.question.endsWith("…"));
	assert.equal(r1.choices[0].label.isWellFormed(), true, "choice label truncation must not split surrogate pair");
	assert.ok(Array.from(r1.choices[0].label).length <= 200);
	assert.match(r1.choices[0].label, /\[redacted-path\]/);
	assert.equal(r2.choices[0].label.isWellFormed(), true, "long choice label truncation must not split surrogate pair");
	assert.ok(Array.from(r2.choices[0].label).length <= 200);
	assert.ok(r2.choices[0].label.endsWith("…"));

	const p1 = propRes.records.find((p: any) => p.proposal_id === "cprop_b2_1");
	assert.ok(p1);
	assert.match(p1.text, /\[redacted-path\]/);
	assert.match(p1.provenance.note, /\[redacted-path\]/);
	assert.match(p1.provenance.evidence_ref, /\[redacted-path\]/);
	assert.match(p1.rejection_reason, /\[redacted-path\]/);

	const sentinels = [
		outerRoot,
		checkoutDir,
		sessionDir,
		homeDir,
		stateDir,
		coordDir,
		indexDir,
		statePath,
		coordinationPath,
		"src/secret.ts",
		"home-secret.txt",
		"sibling-secret.txt",
		"idx-secret.txt",
		"e.json",
		"p.ts",
		"/etc/passwd",
		"~/secrets/token",
		"C:\\Users\\bob\\key.txt",
	];
	scanSentinels(responses[0]!.text, sentinels, "B2 non-nested requests");
	scanSentinels(responses[1]!.text, sentinels, "B2 non-nested proposals");
});

test("LOW 5: directionObservation guards (precheckSessionFiles FIFOs for non-decision, /proc boot, state_db_path, active attempt, error file, foreign progress, incarnation, indexRoot FIFO)", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_L5_TASK",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_L5_BUILD", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }] } },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_L5_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
			},
		],
	};

	const fac = ops({ action: "publish", name: "l5-guards-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-l5" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "l5-run", brief: "PRIVATE_L5_BRIEF" });
	const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = run.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const buildKey = `${buildCfg.instance_id}.1`;

	const build = workerFromConfig(t, join(run.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await build.beforeStart();
	const wBuild = build.requestDirection({ question: "Non-decision pending?", reason: "R", choices: ["proceed"] });
	void wBuild.catch(() => {});
	let reqId = "";
	for (let i = 0; i < 50 && !reqId; i++) {
		reqId = ops({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqId);
	build.vanish();
	revokeManagerAuthority(auth);

	// Baseline: set healthy live v2 ready.json + working progress.json + matching mailbox receiver so positive control is "pending" (uncertain: false).
	const readyFile = join(run.manifest.session_dir, `${buildCfg.instance_id}.ready.json`);
	const progressFile = join(run.manifest.session_dir, `${buildCfg.instance_id}.progress.json`);
	const procInfo = directionProcess(process.pid);
	const receiver = {
		instance_id: buildCfg.instance_id,
		run_token: run.manifest.token,
		session_id: `session-${buildCfg.instance_id}`,
		incarnation: "inc-l5-healthy",
		pid: process.pid,
		boot: procInfo.boot,
		start: procInfo.start,
	};
	const savedReady = readJson<Record<string, unknown>>(readyFile);
	const healthyReady = {
		...savedReady,
		version: 2,
		pid: process.pid,
		session_id: receiver.session_id,
		start_time: receiver.start,
		direction_incarnation: receiver.incarnation,
	};
	const healthyProgress = {
		token: run.manifest.token,
		state: "working",
		attempt_id: buildKey,
		updated_at: Date.now(),
		started_at: Date.now(),
	};
	atomicJson(readyFile, healthyReady);
	atomicJson(progressFile, healthyProgress);

	// Update mailbox identity in SQLite to our healthy receiver (recomputing mailbox digest).
	const updateMailboxIdentity = (identityObj: Record<string, unknown>) => {
		const db = new DatabaseSync(statePath);
		try {
			const identityStr = JSON.stringify(identityObj);
			const digest = sha256Hex(JSON.stringify([reqId, fac.factory_id, identityStr, 1, 0]));
			db.prepare("UPDATE factory_direction_mailboxes SET identity = ?, waiting = 1, wake = 0, digest = ? WHERE request_id = ?").run(identityStr, digest, reqId);
		} finally { db.close(); }
	};
	updateMailboxIdentity(receiver);

	// Positive control: healthy non-decision request yields reconciliation: "pending", uncertain: false!
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.status, 200);
			const rec = res.body.records[0];
			assert.equal(rec.reconciliation, "pending");
			assert.equal(rec.uncertain, false);
		},
	);

	// R20: precheckSessionFiles in directionObservation for a non-decision request (FIFOs on cancel, outcome-claim, fail-fast, transition, manifest, and arbitrary session json).
	const savedLocalManifestR20 = readFileSync(join(run.manifest.session_dir, "manifest.json"));
	for (const fifoName of [
		"cancel.json",
		`${buildCfg.instance_id}.cancel.json`,
		`${buildKey}.outcome-claim.json`,
		"fail-fast.json",
		`${buildCfg.instance_id}.1.transition.json`,
		"extra-session-file.json",
	]) {
		const fifoPath = join(run.manifest.session_dir, fifoName);
		execFileSync("mkfifo", [fifoPath]);
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		rmSync(fifoPath);
		assert.equal(res!.status, 200, `FIFO ${fifoName} status`);
		const body = JSON.parse(res!.text);
		assert.equal(body.records[0].reconciliation, "uncertain", `FIFO ${fifoName} reconciliation`);
		assert.equal(body.records[0].uncertain, true, `FIFO ${fifoName} uncertain`);
	}
	void savedLocalManifestR20;

	// R23: /proc boot mismatch with live ready.json (pid=process.pid, matching start_time & incarnation) -> uncertain!
	updateMailboxIdentity({ ...receiver, boot: "00000000-0000-0000-0000-000000000000" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	updateMailboxIdentity(receiver);

	// R29: incarnation mismatch in ready.json with matching pid/start_time/boot -> uncertain!
	atomicJson(readyFile, { ...healthyReady, direction_incarnation: "inc-wrong" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	atomicJson(readyFile, healthyReady);

	// R28: foreign progress token with state "working" must NOT yield pending -> uncertain!
	atomicJson(progressFile, { ...healthyProgress, token: "foreign-token" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	atomicJson(progressFile, healthyProgress);

	// R26: error file (${key}.error.json) on pending request -> uncertain!
	const errFile = join(run.manifest.session_dir, `${buildKey}.error.json`);
	atomicJson(errFile, { message: "execution error" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	rmSync(errFile);

	// R25: active-attempt key moved to .2 while request is on .1 -> uncertain!
	const revReserveFile = join(run.manifest.session_dir, `${reviewCfg.instance_id}.2.revision.json`);
	const att2ErrFile = join(run.manifest.session_dir, `${buildCfg.instance_id}.2.error.json`);
	atomicJson(revReserveFile, { version: 1, run_id: run.task_id, reviewer: reviewCfg.instance_id, attempt: 2 });
	atomicJson(att2ErrFile, { message: "att2 started/errored" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	rmSync(revReserveFile);
	rmSync(att2ErrFile);

	// R24: state_db_path binding mismatch across manifest/index/run sidecar/factory-runs/release (pointing to an intact copy of DB+coord) -> uncertain!
	const indexFile = join(f.stateDir, `${run.task_id}.json`);
	const indexRunFile = join(f.stateDir, "factory-runs", `${run.task_id}.json`);
	const localManifestFile = join(run.manifest.session_dir, "manifest.json");
	const factoryRunFile = join(run.manifest.session_dir, "factory-run.json");
	const releaseFileR24 = join(run.manifest.session_dir, "release.json");
	const otherStatePath = join(f.root, "other-factories.sqlite");
	const otherCoordPath = join(f.root, "other-coord.sqlite");
	writeFileSync(otherStatePath, readFileSync(statePath));
	writeFileSync(otherCoordPath, readFileSync(coordinationPath));
	writeFileSync(`${otherCoordPath}.anchor.json`, readFileSync(`${coordinationPath}.anchor.json`));
	{
		const cdb = new DatabaseSync(otherCoordPath);
		try {
			const ch = cdb.prepare("SELECT * FROM checkout_holds WHERE attempt_id = ?").get(run.attempt_id) as StoredCheckoutHold;
			const chNew = buildCheckoutHoldRow({ ...ch, factory_db_path: otherStatePath });
			cdb.prepare("UPDATE checkout_holds SET factory_db_path = ?, record_digest = ? WHERE attempt_id = ?").run(otherStatePath, chNew.record_digest, run.attempt_id);
			const mr = cdb.prepare("SELECT * FROM managed_runs WHERE task_id = ?").get(run.task_id) as StoredManagedRun;
			const mrNew = buildManagedRunRow({ ...mr, factory_db_path: otherStatePath });
			cdb.prepare("UPDATE managed_runs SET factory_db_path = ?, record_digest = ? WHERE task_id = ?").run(otherStatePath, mrNew.record_digest, run.task_id);
		} finally { cdb.close(); }
	}
	const savedIndex = readFileSync(indexFile);
	const savedIndexRun = readFileSync(indexRunFile);
	const savedLocalManifest = readFileSync(localManifestFile);
	const savedFactoryRun = readFileSync(factoryRunFile);
	const savedReleaseR24 = readFileSync(releaseFileR24);
	const mutateStateDbPath = (rawBuf: Buffer) => {
		const obj = JSON.parse(rawBuf.toString("utf8"));
		if (obj.factory_managed) {
			obj.factory_managed.state_db_path = otherStatePath;
			obj.factory_managed.coord_db_path = otherCoordPath;
		}
		if (obj.state_db_path) obj.state_db_path = otherStatePath;
		if (obj.coord_db_path) obj.coord_db_path = otherCoordPath;
		return obj;
	};
	atomicJson(indexFile, mutateStateDbPath(savedIndex));
	atomicJson(indexRunFile, mutateStateDbPath(savedIndexRun));
	atomicJson(localManifestFile, mutateStateDbPath(savedLocalManifest));
	atomicJson(factoryRunFile, mutateStateDbPath(savedFactoryRun));
	atomicJson(releaseFileR24, mutateStateDbPath(savedReleaseR24));
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/requests`);
			assert.equal(res.body.records[0].reconciliation, "uncertain");
			assert.equal(res.body.records[0].uncertain, true);
		},
	);
	rmSync(otherStatePath);
	rmSync(otherCoordPath);
	rmSync(`${otherCoordPath}.anchor.json`);
	writeFileSync(indexFile, savedIndex);
	writeFileSync(indexRunFile, savedIndexRun);
	writeFileSync(localManifestFile, savedLocalManifest);
	writeFileSync(factoryRunFile, savedFactoryRun);
	writeFileSync(releaseFileR24, savedReleaseR24);

	// V9: index-file FIFO in f.stateDir (matching viewer's indexRoot) fails closed without hanging even when local manifest.json is intact!
	rmSync(indexFile);
	execFileSync("mkfifo", [indexFile]);
	{
		const [res] = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
			paths: [`/api/factories/${fac.factory_id}/requests`],
		});
		assert.equal(res!.status, 200);
		const body = JSON.parse(res!.text);
		assert.equal(body.records[0].reconciliation, "uncertain");
		assert.equal(body.records[0].uncertain, true);
	}
	rmSync(indexFile);
	writeFileSync(indexFile, savedIndex);
});
