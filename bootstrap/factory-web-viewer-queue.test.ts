import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createManagerAuthority,
	factoryOperations,
	revokeManagerAuthority,
} from "../factory/operations.ts";
import {
	buildAttemptRow,
	buildFactoryVersionRow,
	buildInputRow,
	buildManagedRunRow,
	sha256Hex,
} from "./factory-records.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import {
	verifyReadOnlyViewer,
	verifyReadOnlyViewerInChild,
} from "./test-support/factory-viewer-fixture.ts";
import { atomicJson, completionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import { execFileSync } from "node:child_process";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

async function getJson(url: string) {
	const res = await fetch(url);
	const text = await res.text();
	return { status: res.status, text, body: JSON.parse(text) as any };
}

test("Queue snapshot lists FIFO inputs in acceptance order, filters Open vs All, explains head_status safely, and links to receipts", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };

	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_TASK_V1",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SUBTASK_V1" }],
	};
	const fac = ops({ action: "publish", name: "queue-fac", draft: draftV1, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-queue" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// 1. Settled entry (v1)
	const inSettled = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-settled-v1", brief: "PRIVATE_BRIEF_SETTLED" });
	await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const w1 = f.configs[0]!;
	atomicJson(resultPath(w1.session_dir, w1.instance_id), completionRecord(w1, { agent_name: "builder", status: "success", summary: "Done 1", detail: "" }, "none", new Date().toISOString()));
	await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });

	// 2. Discarded entry (v1)
	const inDiscarded = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-discarded-v1", brief: "PRIVATE_BRIEF_DISCARDED" });
	await ops({ action: "discard", factory_id: fac.factory_id, authority: auth, input_id: inDiscarded.input_id, confirm: async () => true });

	// Publish v2, then restore v1 as v3.
	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: { ...draftV1, task: "PRIVATE_TASK_V2" }, sessionModel });
	ops({ action: "restore", factory_id: fac.factory_id, authority: auth, from_version: "v1" });

	// 3. Running entry (bound to v3)
	const inRunning = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-running-v3", brief: "PRIVATE_BRIEF_RUNNING" });
	await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });

	// 4. Retryable waiting head (queued behind running, modified to retryable)
	const inRetryable = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-retryable-v3", brief: "PRIVATE_BRIEF_RETRYABLE" });
	// 5. Blocked queued entry
	const inBlocked = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-blocked-v3", brief: "PRIVATE_BRIEF_BLOCKED" });
	// 6. Queued entry
	const inQueued = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-queued-v3", brief: "PRIVATE_BRIEF_QUEUED" });
	{
		const raw = new DatabaseSync(statePath);
		try {
			for (const [id, disp] of [[inRetryable.input_id, "retryable"], [inBlocked.input_id, "blocked"]] as const) {
				const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(id) as any;
				const next = buildInputRow({ ...row, disposition: disp });
				raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, id);
			}
		} finally { raw.close(); }
	}
	revokeManagerAuthority(auth);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Default filter is open; explicit ?filter=open matches default.
			const openDefault = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/queue`);
			const openExplicit = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/queue?filter=open`);
			assert.equal(openDefault.status, 200);
			assert.equal(openExplicit.status, 200);
			assert.deepEqual(openDefault.body, openExplicit.body);

			assert.equal(openDefault.body.factory_id, fac.factory_id);
			assert.equal(openDefault.body.filter, "open");
			assert.equal(openDefault.body.evidence, "available");
			assert.equal(openDefault.body.total_count, 6);
			assert.equal(openDefault.body.absence, undefined);
			assert.deepEqual(
				openDefault.body.entries.map((e: any) => [e.queue_position, e.reference, e.disposition, e.bound_version, e.is_head]),
				[
					[3, "ref-running-v3", "running", "v3", false],
					[4, "ref-retryable-v3", "retryable", "v3", true],
					[5, "ref-blocked-v3", "blocked", "v3", false],
					[6, "ref-queued-v3", "queued", "v3", false],
				],
			);

			// Head status shows the first waiting input (retryable) blocked by factory_held with fixed operator explanation and NO raw path.
			assert.equal(openDefault.body.head_status.eligible, false);
			assert.equal(openDefault.body.head_status.blocking_kind, "factory_held");
			assert.equal(openDefault.body.head_status.input_id, inRetryable.input_id);
			assert.equal(openDefault.body.head_status.reference, "ref-retryable-v3");
			assert.equal(openDefault.body.head_status.bound_version, "v3");
			assert.match(openDefault.body.head_status.explanation, /holds this factory's run slot/i);
			assert.equal(openDefault.body.head_status.reason, undefined);

			// All filter includes settled and discarded entries in acceptance order.
			const allRes = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/queue?filter=all`);
			assert.equal(allRes.status, 200);
			assert.equal(allRes.body.filter, "all");
			assert.equal(allRes.body.total_count, 6);
			assert.deepEqual(
				allRes.body.entries.map((e: any) => [e.queue_position, e.reference, e.disposition, e.bound_version]),
				[
					[1, "ref-settled-v1", "settled", "v1"],
					[2, "ref-discarded-v1", "discarded", "v1"],
					[3, "ref-running-v3", "running", "v3"],
					[4, "ref-retryable-v3", "retryable", "v3"],
					[5, "ref-blocked-v3", "blocked", "v3"],
					[6, "ref-queued-v3", "queued", "v3"],
				],
			);

			// Every row has accepted_at, disposition_explanation, uncertain: false, and identifier-only receipt links that resolve.
			for (const entry of allRes.body.entries) {
				assert.equal(typeof entry.accepted_at, "string");
				assert.equal(typeof entry.disposition_explanation, "string");
				assert.equal(entry.uncertain, false);
				const linkUrl = new URL(entry.receipt_url, viewer.url);
				assert.equal(linkUrl.pathname, "/");
				assert.deepEqual([...linkUrl.searchParams.entries()], [
					["factory", fac.factory_id],
					["view", "receipts"],
					["reference", entry.reference],
				]);
				const apiUrl = new URL(entry.receipt_snapshot_url, viewer.url);
				assert.equal(apiUrl.pathname, `/api/factories/${fac.factory_id}/receipts`);
				assert.deepEqual([...apiUrl.searchParams.entries()], [["reference", entry.reference]]);
				const followed = await getJson(`${viewer.url}${entry.receipt_snapshot_url}`);
				assert.equal(followed.status, 200);
				assert.equal(followed.body.type, "receipt");
				assert.equal(followed.body.is_run_report, false);
				assert.equal(followed.body.input_id, entry.input_id);
				assert.equal(followed.body.bound_version, entry.bound_version);
			}

			// Filter validation: invalid, empty, case-mismatched, duplicate, or extra query params => 400.
			for (const badQuery of [
				"?filter=unknown",
				"?filter=",
				"?filter=OPEN",
				"?filter=../all",
				"?filter=open&filter=all",
				"?filter=open&extra=1",
				"?path=/etc/passwd",
			]) {
				const bad = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/queue${badQuery}`);
				assert.equal(bad.status, 400, `expected 400 for ${badQuery}`);
			}

			// Sentinel leak scan across queue and followed receipts.
			for (const text of [openDefault.text, allRes.text]) {
				for (const s of ["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath]) {
					assert.equal(text.includes(s), false, `queue response leaked ${s}`);
				}
			}
		},
	);
});

test("Queue distinguishes typed absence (not applicable, no records, evidence unavailable), keeps uncertain/damaged entries open, and blocks without path leaks", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_TASK_ABSENCE",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SUBTASK_ABSENCE" }],
	};

	const f2 = serviceFixture(t, ["builder"]);
	const otherOps = factoryOperations(statePath, f2.service, { coordinationPath });
	const otherDraft: GenerateRequest = { ...draft, project_cwd: f2.cwd };

	const unmanaged = ops({ action: "publish", name: "unmanaged-q", draft, sessionModel });
	const emptyManaged = ops({ action: "publish", name: "empty-managed-q", draft, sessionModel });
	const finishedOnly = ops({ action: "publish", name: "finished-only-q", draft, sessionModel });
	const checkoutPeer = otherOps({ action: "publish", name: "checkout-peer-q", draft: otherDraft, sessionModel });

	const authEmpty = createManagerAuthority({ pi_session_id: "sess-empty-q" });
	ops({ action: "resume", factory_id: emptyManaged.factory_id, authority: authEmpty });
	revokeManagerAuthority(authEmpty);

	// Finished-only factory: settled + discarded + cleanly cleared (non-uncertain needs_attention outcome).
	const authFin = createManagerAuthority({ pi_session_id: "sess-fin-q" });
	ops({ action: "resume", factory_id: finishedOnly.factory_id, authority: authFin });
	ops({ action: "submit", factory_id: finishedOnly.factory_id, authority: authFin, reference: "fin-settled", brief: "PRIVATE_FIN_1" });
	await ops({ action: "launch", factory_id: finishedOnly.factory_id, authority: authFin });
	const wFin = f.configs.at(-1)!;
	atomicJson(resultPath(wFin.session_dir, wFin.instance_id), completionRecord(wFin, { agent_name: "builder", status: "success", summary: "Done", detail: "" }, "none", new Date().toISOString()));
	await ops({ action: "settle_run", factory_id: finishedOnly.factory_id, authority: authFin });
	const finDiscarded = ops({ action: "submit", factory_id: finishedOnly.factory_id, authority: authFin, reference: "fin-discarded", brief: "PRIVATE_FIN_2" });
	await ops({ action: "discard", factory_id: finishedOnly.factory_id, authority: authFin, input_id: finDiscarded.input_id, confirm: async () => true });
	const finClrSub = ops({ action: "submit", factory_id: finishedOnly.factory_id, authority: authFin, reference: "fin-cleared-known", brief: "PRIVATE_FIN_3" });
	{
		const raw = new DatabaseSync(statePath);
		try {
			const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(finClrSub.input_id) as any;
			const nextIn = buildInputRow({ ...row, disposition: "cleared" });
			raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(nextIn.disposition, nextIn.record_digest, row.input_id);
			const devStat = raw.prepare("SELECT checkout_key FROM factory_attempts LIMIT 1").get() as { checkout_key: string };
			const nowIso = new Date().toISOString();
			const dummyHold = { factory_id: finishedOnly.factory_id, attempt_id: "att-fin-clr", input_id: row.input_id, request_id: "req-fin-clr", task_id: "task-fin-clr", state: "released", held_at: nowIso, updated_at: nowIso, record_digest: sha256Hex("h") };
			const dummyCheckoutHold = { canonical_checkout: f.cwd, checkout_key: devStat.checkout_key, factory_id: finishedOnly.factory_id, factory_name: "finished-only-q", factory_db_path: statePath, attempt_id: "att-fin-clr", input_id: row.input_id, request_id: "req-fin-clr", task_id: "task-fin-clr", state: "released", held_at: nowIso, updated_at: nowIso, record_digest: sha256Hex("c") };
			const clearanceJson = `clearance:${JSON.stringify({
				cleared_at: nowIso,
				reason: "Operator cleared needs_attention run",
				evidence: "Process exited cleanly",
				acknowledged_unknown_effects: true,
				prior_input_disposition: "running",
				missing_or_contradictory: ["run outcome is needs_attention"],
				observations: {
					cancellation: { intent: "none" },
					resource_closure: { state: "closed", recorded_closed: ["build"], not_recorded_closed: [] },
					execution_settlement: { state: "unsettled", reason: "run outcome is needs_attention" },
					outcome: "needs_attention",
					resume_risk: [],
					attention: ["run outcome is needs_attention"],
				},
				released_holds: { factory_held_at: nowIso, checkout_held_at: nowIso },
				source_records: { input: row, managed_run: null, factory_hold: dummyHold, checkout_hold: dummyCheckoutHold },
			})}`;
			const clrAtt = buildAttemptRow({
				attempt_id: "att-fin-clr",
				factory_id: finishedOnly.factory_id,
				input_id: row.input_id,
				bound_version: "v1",
				request_id: "req-fin-clr",
				task_id: "task-fin-clr",
				canonical_checkout: f.cwd,
				checkout_key: devStat.checkout_key,
				state: "cleared",
				release_authorized: 1,
				release_authorized_at: nowIso,
				release_token_digest: null,
				release_nonce_digest: null,
				error: clearanceJson,
				created_at: nowIso,
				updated_at: nowIso,
			});
			raw.prepare(
				`INSERT INTO factory_attempts (attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(clrAtt.attempt_id, clrAtt.factory_id, clrAtt.input_id, clrAtt.bound_version, clrAtt.request_id, clrAtt.task_id, clrAtt.canonical_checkout, clrAtt.checkout_key, clrAtt.state, clrAtt.release_authorized, clrAtt.release_authorized_at, clrAtt.release_token_digest, clrAtt.release_nonce_digest, clrAtt.error, clrAtt.created_at, clrAtt.updated_at, clrAtt.record_digest);
		} finally { raw.close(); }
	}
	revokeManagerAuthority(authFin);

	// Checkout peer holds f2.cwd; blockedByPeer with a queued head is blocked by checkout_held and stopped.
	const authPeer = createManagerAuthority({ pi_session_id: "sess-peer-q" });
	otherOps({ action: "resume", factory_id: checkoutPeer.factory_id, authority: authPeer });
	otherOps({ action: "submit", factory_id: checkoutPeer.factory_id, authority: authPeer, reference: "peer-run", brief: "PRIVATE_PEER" });
	await otherOps({ action: "launch", factory_id: checkoutPeer.factory_id, authority: authPeer });
	revokeManagerAuthority(authPeer);

	const blockedByPeer = otherOps({ action: "publish", name: "blocked-by-peer-q", draft: otherDraft, sessionModel });
	const authBlocked = createManagerAuthority({ pi_session_id: "sess-blocked-q" });
	otherOps({ action: "resume", factory_id: blockedByPeer.factory_id, authority: authBlocked });
	otherOps({ action: "submit", factory_id: blockedByPeer.factory_id, authority: authBlocked, reference: "waiting-under-peer", brief: "PRIVATE_WAIT" });
	otherOps({ action: "stop", factory_id: blockedByPeer.factory_id, authority: authBlocked });
	revokeManagerAuthority(authBlocked);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Unmanaged -> not applicable
			const unmRes = await getJson(`${viewer.url}/api/factories/${unmanaged.factory_id}/queue`);
			assert.equal(unmRes.status, 200);
			assert.deepEqual(unmRes.body.entries, []);
			assert.equal(unmRes.body.absence, "not applicable");
			assert.equal(unmRes.body.head_status.blocking_kind, "unmanaged");

			// Managed empty -> no records
			const empRes = await getJson(`${viewer.url}/api/factories/${emptyManaged.factory_id}/queue`);
			assert.equal(empRes.status, 200);
			assert.deepEqual(empRes.body.entries, []);
			assert.equal(empRes.body.absence, "no records");
			assert.equal(empRes.body.explanation, "No factory inputs have been admitted.");
			assert.equal(empRes.body.head_status.blocking_kind, "empty");

			// Managed with only finished inputs (settled, discarded, cleanly cleared): open => no records, all => 3 entries
			const finOpen = await getJson(`${viewer.url}/api/factories/${finishedOnly.factory_id}/queue?filter=open`);
			assert.equal(finOpen.status, 200);
			assert.deepEqual(finOpen.body.entries, []);
			assert.equal(finOpen.body.absence, "no records");
			assert.equal(finOpen.body.total_count, 3);
			assert.match(finOpen.body.explanation, /3 finished input/);

			const finAll = await getJson(`${viewer.url}/api/factories/${finishedOnly.factory_id}/queue?filter=all`);
			assert.equal(finAll.status, 200);
			assert.equal(finAll.body.entries.length, 3);
			assert.equal(finAll.body.absence, undefined);

			// Stopped + checkout_held head: fixed explanations, no checkout path leaked!
			const blkRes = await getJson(`${viewer.url}/api/factories/${blockedByPeer.factory_id}/queue?filter=open`);
			assert.equal(blkRes.status, 200);
			assert.equal(blkRes.body.head_status.blocking_kind, "stopped");
			assert.equal(blkRes.body.head_status.without_control_fence.blocking_kind, "checkout_held");
			assert.match(blkRes.body.head_status.without_control_fence.explanation, /target checkout slot/i);
			for (const s of ["PRIVATE_", f.root, f.cwd, f2.cwd, f.home, statePath, coordinationPath]) {
				assert.equal(blkRes.text.includes(s), false, `blocked queue leaked ${s}`);
			}

			// Unknown factory => 404
			const unknownFac = await getJson(`${viewer.url}/api/factories/no-such-factory/queue`);
			assert.equal(unknownFac.status, 404);
		},
	);

	// Preflight failure when PATH lacks pi/herdr -> blocking_kind: "preflight"
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
		async viewer => {
			// Unstop emptyManaged won't have head; check blockedByPeer without_control_fence vs a fresh eligible head.
			const authE = createManagerAuthority({ pi_session_id: "sess-pre" });
			revokeManagerAuthority(authE);
			const blk = await getJson(`${viewer.url}/api/factories/${blockedByPeer.factory_id}/queue`);
			assert.equal(blk.body.head_status.blocking_kind, "stopped");
			assert.equal(blk.body.head_status.without_control_fence.blocking_kind, "checkout_held");
		},
	);
});

test("Queue keeps uncertain cleared/settled entries in Open, flags damaged bound/current versions without falling back, and fails to evidence unavailable on damaged stores", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_V1",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SUB_1" }],
	};
	const fac = ops({ action: "publish", name: "uncertain-q", draft: draftV1, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-unc-q" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// 1. Cleared run with unknown execution settlement (worker exited without output -> cleared) => MUST stay in Open!
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-cleared-unknown", brief: "PRIVATE_CLR_UNK" });
	const launchedClr = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const wClr = f.configs.at(-1)!;
	const rPath = readyPath(wClr.session_dir, wClr.instance_id);
	atomicJson(rPath, { ...readJson(rPath), pid: 999_999 });
	const cleared = await ops({
		action: "clear_hold",
		factory_id: fac.factory_id,
		input_id: launchedClr.input_id,
		attempt_id: launchedClr.attempt_id,
		task_id: launchedClr.task_id,
		authority: auth,
		confirm: async () => ({ reason: "worker died", evidence: "no process", acknowledged_unknown_effects: true }),
	});
	assert.equal(cleared.cleared, true);

	// 2. Cleanly settled run at v1, then delete its attempt row later to test missing-attempt-for-finished guard;
	// also publish v2, submit v2 input, publish v3, then damage v2 definition in factory_versions!
	const inSettled = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-settled-missing-att", brief: "PRIVATE_SET_MISS" });
	await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const wSet = f.configs.at(-1)!;
	atomicJson(resultPath(wSet.session_dir, wSet.instance_id), completionRecord(wSet, { agent_name: "builder", status: "success", summary: "Done", detail: "" }, "none", new Date().toISOString()));
	await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });

	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: { ...draftV1, task: "PRIVATE_V2" }, sessionModel });
	const inV2 = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-bound-v2-damaged", brief: "PRIVATE_V2_BRIEF" });
	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: { ...draftV1, task: "PRIVATE_V3" }, sessionModel });

	// Also create a stopped empty factory with damaged current_version to verify current_error forces evidence: "uncertain".
	const stoppedBroken = ops({ action: "publish", name: "stopped-broken-cur", draft: draftV1, sessionModel });
	const authSB = createManagerAuthority({ pi_session_id: "sess-sb" });
	ops({ action: "resume", factory_id: stoppedBroken.factory_id, authority: authSB });
	ops({ action: "update", factory_id: stoppedBroken.factory_id, authority: authSB, draft: { ...draftV1, task: "PRIVATE_SB_V2" }, sessionModel });
	ops({ action: "stop", factory_id: stoppedBroken.factory_id, authority: authSB });
	revokeManagerAuthority(authSB);

	// Standalone cleared-unknown factory (empty head, no damaged versions, no inspection.uncertainty) -> pins allRows.some(r => r.uncertain).
	const clrOnly = ops({ action: "publish", name: "clr-only-q", draft: draftV1, sessionModel });
	const authCO = createManagerAuthority({ pi_session_id: "sess-co" });
	ops({ action: "resume", factory_id: clrOnly.factory_id, authority: authCO });
	ops({ action: "submit", factory_id: clrOnly.factory_id, authority: authCO, reference: "ref-co", brief: "PRIVATE_CO" });
	const runCO = await ops({ action: "launch", factory_id: clrOnly.factory_id, authority: authCO });
	const wCO = f.configs.at(-1)!;
	const rCO = readyPath(wCO.session_dir, wCO.instance_id);
	atomicJson(rCO, { ...readJson(rCO), pid: 999_998 });
	await ops({
		action: "clear_hold",
		factory_id: clrOnly.factory_id,
		input_id: runCO.input_id,
		attempt_id: runCO.attempt_id,
		task_id: runCO.task_id,
		authority: authCO,
		confirm: async () => ({ reason: "worker died", evidence: "no process", acknowledged_unknown_effects: true }),
	});
	revokeManagerAuthority(authCO);

	// Empty managed factory with damaged factory_controls -> pins head_status.blocking_kind === "uncertain".
	const badCtrl = ops({ action: "publish", name: "bad-ctrl-q", draft: draftV1, sessionModel });
	const authBC = createManagerAuthority({ pi_session_id: "sess-bc" });
	ops({ action: "resume", factory_id: badCtrl.factory_id, authority: authBC });
	revokeManagerAuthority(authBC);

	// Stopped empty factory with orphaned managed_run in coordination DB -> pins inspection.uncertainty.length while head_status is "stopped" and queue is empty.
	const fSU = serviceFixture(t, ["builder"]);
	const suOps = factoryOperations(statePath, fSU.service, { coordinationPath });
	const stoppedUnc = suOps({ action: "publish", name: "stopped-unc-q", draft: { ...draftV1, project_cwd: fSU.cwd }, sessionModel });
	const authSU = createManagerAuthority({ pi_session_id: "sess-su" });
	suOps({ action: "resume", factory_id: stoppedUnc.factory_id, authority: authSU });
	suOps({ action: "stop", factory_id: stoppedUnc.factory_id, authority: authSU });
	revokeManagerAuthority(authSU);
	revokeManagerAuthority(auth);

	{
		const raw = new DatabaseSync(statePath);
		try {
			// Delete attempt for inSettled so settled disposition has no attempt record.
			raw.exec("PRAGMA foreign_keys = OFF");
			raw.prepare("DELETE FROM factory_attempts WHERE input_id = ?").run(inSettled.input_id);
			// Tamper factory_controls for badCtrl.
			raw.prepare("UPDATE factory_controls SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?")
				.run(badCtrl.factory_id);
			// Damage v2 of uncertain-q (bound by inV2 while v3 is current).
			const badV2 = buildFactoryVersionRow({
				factory_id: fac.factory_id,
				version: "v2",
				version_num: 2,
				definition: "{bad json",
				digest: sha256Hex("{bad json"),
				restored_from_version: null,
				created_at: new Date().toISOString(),
			});
			raw.prepare("UPDATE factory_versions SET definition = ?, digest = ?, record_digest = ? WHERE factory_id = ? AND version = 'v2'")
				.run(badV2.definition, badV2.digest, badV2.record_digest, fac.factory_id);
			// Damage v2 (current_version) of stopped-broken-cur.
			const badSB = buildFactoryVersionRow({
				factory_id: stoppedBroken.factory_id,
				version: "v2",
				version_num: 2,
				definition: "{bad current",
				digest: sha256Hex("{bad current"),
				restored_from_version: null,
				created_at: new Date().toISOString(),
			});
			raw.prepare("UPDATE factory_versions SET definition = ?, digest = ?, record_digest = ? WHERE factory_id = ? AND version = 'v2'")
				.run(badSB.definition, badSB.digest, badSB.record_digest, stoppedBroken.factory_id);
		} finally { raw.close(); }
		const cdb = new DatabaseSync(coordinationPath);
		try {
			const stSU = statSync(fSU.cwd);
			const suCk = `dev:${stSU.dev}:ino:${stSU.ino}`;
			const nowIso = new Date().toISOString();
			const orphan = buildManagedRunRow({
				task_id: "task-orphan-su",
				request_id_digest: sha256Hex("req-orphan-su"),
				factory_id: stoppedUnc.factory_id,
				factory_name: "stopped-unc-q",
				factory_db_path: statePath,
				input_id: "in-orphan-su",
				attempt_id: "att-orphan-su",
				canonical_checkout: fSU.cwd,
				checkout_key: suCk,
				created_at: nowIso,
			});
			cdb.prepare(
				"INSERT INTO managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(orphan.task_id, orphan.request_id_digest, orphan.factory_id, orphan.factory_name, orphan.factory_db_path, orphan.input_id, orphan.attempt_id, orphan.canonical_checkout, orphan.checkout_key, orphan.created_at, orphan.record_digest);
		} finally { cdb.close(); }
	}

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const openRes = await getJson(`${viewer.url}/api/factories/${fac.factory_id}/queue?filter=open`);
			assert.equal(openRes.status, 200);
			assert.equal(openRes.body.evidence, "uncertain");
			assert.deepEqual(
				openRes.body.entries.map((e: any) => [e.reference, e.disposition, e.bound_version, e.uncertain]),
				[
					["ref-cleared-unknown", "cleared", "v1", true],
					["ref-settled-missing-att", "settled", "v1", true],
					["ref-bound-v2-damaged", "queued", "v2", true],
				],
			);
			assert.equal(openRes.body.entries[2].bound_version, "v2");
			assert.equal(openRes.body.entries[2].bound_version_evidence, "unavailable");
			assert.equal(openRes.body.head_status.blocking_kind, "uncertain");

			// Stopped factory with damaged current_version => evidence must still be "uncertain" even though head_status.blocking_kind is "stopped".
			const sbRes = await getJson(`${viewer.url}/api/factories/${stoppedBroken.factory_id}/queue?filter=open`);
			assert.equal(sbRes.status, 200);
			assert.equal(sbRes.body.evidence, "uncertain");
			assert.equal(sbRes.body.absence, "no records");
			assert.equal(sbRes.body.head_status.blocking_kind, "stopped");

			// Standalone cleared-unknown factory => evidence: "uncertain" via row.uncertain alone.
			const coRes = await getJson(`${viewer.url}/api/factories/${clrOnly.factory_id}/queue?filter=open`);
			assert.equal(coRes.status, 200);
			assert.equal(coRes.body.evidence, "uncertain");
			assert.equal(coRes.body.head_status.blocking_kind, "empty");

			// Damaged factory_controls on empty factory => evidence: "uncertain" via head_status.blocking_kind.
			const bcRes = await getJson(`${viewer.url}/api/factories/${badCtrl.factory_id}/queue?filter=open`);
			assert.equal(bcRes.status, 200);
			assert.equal(bcRes.body.evidence, "uncertain");
			assert.equal(bcRes.body.head_status.blocking_kind, "uncertain");

			// Stopped factory with orphaned failed_before_release => evidence: "uncertain" via inspection.uncertainty.length.
			const suRes = await getJson(`${viewer.url}/api/factories/${stoppedUnc.factory_id}/queue?filter=open`);
			assert.equal(suRes.status, 200);
			assert.equal(suRes.body.evidence, "uncertain");
			assert.equal(suRes.body.head_status.blocking_kind, "stopped");

			// Verify preflight failure on missing PATH when an eligible queued input exists.
			void inV2;
		},
	);

	// Preflight blocker test on a fresh managed factory with an eligible input and missing PATH.
	const preFac = ops({ action: "publish", name: "preflight-q", draft: draftV1, sessionModel });
	const authPre = createManagerAuthority({ pi_session_id: "sess-pre-q" });
	ops({ action: "resume", factory_id: preFac.factory_id, authority: authPre });
	ops({ action: "submit", factory_id: preFac.factory_id, authority: authPre, reference: "ref-pre", brief: "PRIVATE_PRE" });
	revokeManagerAuthority(authPre);
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
		async viewer => {
			const preRes = await getJson(`${viewer.url}/api/factories/${preFac.factory_id}/queue`);
			assert.equal(preRes.status, 200);
			assert.equal(preRes.body.head_status.blocking_kind, "preflight");
			assert.match(preRes.body.head_status.explanation, /prerequisite/i);
		},
	);

	// Unknown disposition in SQLite -> operations fails closed -> queue returns typed evidence unavailable (never no records).
	{
		const raw = new DatabaseSync(statePath);
		try {
			const row = raw.prepare("SELECT * FROM factory_inputs WHERE reference = 'ref-pre'").get() as any;
			const bad = buildInputRow({ ...row, disposition: "bogus_state" });
			raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(bad.disposition, bad.record_digest, row.input_id);
		} finally { raw.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const badDisp = await getJson(`${viewer.url}/api/factories/${preFac.factory_id}/queue`);
			assert.equal(badDisp.status, 200);
			assert.equal(badDisp.body.evidence, "unavailable");
			assert.equal(badDisp.body.absence, "evidence unavailable");
			assert.deepEqual(badDisp.body.entries, []);
		},
	);

	// Coordination hot journal / WAL -> queue returns typed evidence unavailable.
	{
		const cdb = new DatabaseSync(coordinationPath);
		try { cdb.exec("PRAGMA journal_mode = WAL"); } finally { cdb.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const coordWal = await getJson(`${viewer.url}/api/factories/${stoppedBroken.factory_id}/queue`);
			assert.equal(coordWal.status, 200);
			assert.equal(coordWal.body.evidence, "unavailable");
			assert.equal(coordWal.body.absence, "evidence unavailable");
		},
	);
});

test("Receipt lookup returns admission, bound version, disposition, and safe attempt details without managing session, and rejects unknown/malformed/cross-factory references", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_REC_V1",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_REC_SUB" }],
	};
	const facA = ops({ action: "publish", name: "receipt-fac-a", draft: draftV1, sessionModel });
	const facB = ops({ action: "publish", name: "receipt-fac-b", draft: draftV1, sessionModel });
	const authA = createManagerAuthority({ pi_session_id: "sess-rec-a" });
	ops({ action: "resume", factory_id: facA.factory_id, authority: authA });
	const authB = createManagerAuthority({ pi_session_id: "sess-rec-b" });
	ops({ action: "resume", factory_id: facB.factory_id, authority: authB });

	// 1. Settled input at v1
	const inSettled = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-settled", brief: "PRIVATE_BRIEF_SETTLED" });
	await ops({ action: "launch", factory_id: facA.factory_id, authority: authA });
	const w1 = f.configs.at(-1)!;
	atomicJson(resultPath(w1.session_dir, w1.instance_id), completionRecord(w1, { agent_name: "builder", status: "success", summary: "Done", detail: "" }, "none", new Date().toISOString()));
	await ops({ action: "settle_run", factory_id: facA.factory_id, authority: authA });

	// Publish v2, restore v1 as v3.
	ops({ action: "update", factory_id: facA.factory_id, authority: authA, draft: { ...draftV1, task: "PRIVATE_REC_V2" }, sessionModel });
	ops({ action: "restore", factory_id: facA.factory_id, authority: authA, from_version: "v1" });

	// 2. Discarded input at v3
	const inDiscarded = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-discarded", brief: "PRIVATE_BRIEF_DISC" });
	await ops({ action: "discard", factory_id: facA.factory_id, authority: authA, input_id: inDiscarded.input_id, confirm: async () => true });

	// 3. Queued, blocked, retryable inputs at v3 (no attempt rows)
	const inQueued = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-queued", brief: "PRIVATE_BRIEF_QUEUED" });
	const inBlocked = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-blocked", brief: "PRIVATE_BRIEF_BLOCKED" });
	const inRetryable = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-retryable", brief: "PRIVATE_BRIEF_RETRYABLE" });

	// 4. Running input whose attempt row will be deleted, plus another running input with reserved/unreleased attempt & bad state test on facB.
	const inMissingAtt = ops({ action: "submit", factory_id: facA.factory_id, authority: authA, reference: "rec-missing-att", brief: "PRIVATE_BRIEF_MISS_ATT" });

	// On facB: submit an unauthorized (failed_before_release), settled+unauth, cleared+unauth, and unrecognized-state attempt.
	const inBReserved = ops({ action: "submit", factory_id: facB.factory_id, authority: authB, reference: "facb-reserved", brief: "PRIVATE_B_RES" });
	const inBCustom = ops({ action: "submit", factory_id: facB.factory_id, authority: authB, reference: "facb-custom", brief: "PRIVATE_B_CUST" });
	const inBClearedUnauth = ops({ action: "submit", factory_id: facB.factory_id, authority: authB, reference: "facb-clr-unauth", brief: "PRIVATE_B_CLR_UA" });
	const inBUnknownState = ops({ action: "submit", factory_id: facB.factory_id, authority: authB, reference: "facb-unk-state", brief: "PRIVATE_B_UNK" });

	revokeManagerAuthority(authA);
	revokeManagerAuthority(authB);

	{
		const raw = new DatabaseSync(statePath);
		try {
			for (const [id, disp] of [[inBlocked.input_id, "blocked"], [inRetryable.input_id, "retryable"], [inMissingAtt.input_id, "running"]] as const) {
				const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(id) as any;
				const next = buildInputRow({ ...row, disposition: disp });
				raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, id);
			}
			const devStat = raw.prepare("SELECT checkout_key FROM factory_attempts LIMIT 1").get() as { checkout_key: string };
			const nowIso = new Date().toISOString();
			const resAtt = buildAttemptRow({
				attempt_id: "att-b-res",
				factory_id: facB.factory_id,
				input_id: inBReserved.input_id,
				bound_version: "v1",
				request_id: "req-b-res",
				task_id: "task-b-res",
				canonical_checkout: f.cwd,
				checkout_key: devStat.checkout_key,
				state: "failed_before_release",
				release_authorized: 0,
				release_authorized_at: null,
				release_token_digest: null,
				release_nonce_digest: null,
				error: `PRIVATE_ERR_PATH_${f.cwd}`,
				created_at: nowIso,
				updated_at: nowIso,
			});
			const badAtt = buildAttemptRow({
				attempt_id: "att-b-bad",
				factory_id: facB.factory_id,
				input_id: inBCustom.input_id,
				bound_version: "v1",
				request_id: "req-b-bad",
				task_id: "task-b-bad",
				canonical_checkout: f.cwd,
				checkout_key: devStat.checkout_key,
				state: "settled",
				release_authorized: 0,
				release_authorized_at: null,
				release_token_digest: null,
				release_nonce_digest: null,
				error: null,
				created_at: nowIso,
				updated_at: nowIso,
			});
			const clrUnauthAtt = buildAttemptRow({
				attempt_id: "att-b-clr-ua",
				factory_id: facB.factory_id,
				input_id: inBClearedUnauth.input_id,
				bound_version: "v1",
				request_id: "req-b-clr-ua",
				task_id: "task-b-clr-ua",
				canonical_checkout: f.cwd,
				checkout_key: devStat.checkout_key,
				state: "cleared",
				release_authorized: 0,
				release_authorized_at: null,
				release_token_digest: null,
				release_nonce_digest: null,
				error: null,
				created_at: nowIso,
				updated_at: nowIso,
			});
			const unkStateAtt = buildAttemptRow({
				attempt_id: "att-b-unk-st",
				factory_id: facB.factory_id,
				input_id: inBUnknownState.input_id,
				bound_version: "v1",
				request_id: "req-b-unk-st",
				task_id: "task-b-unk-st",
				canonical_checkout: f.cwd,
				checkout_key: devStat.checkout_key,
				state: "bogus_attempt_state",
				release_authorized: 0,
				release_authorized_at: null,
				release_token_digest: null,
				release_nonce_digest: null,
				error: null,
				created_at: nowIso,
				updated_at: nowIso,
			});
			for (const a of [resAtt, badAtt, clrUnauthAtt, unkStateAtt]) {
				raw.prepare(
					`INSERT INTO factory_attempts (attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(a.attempt_id, a.factory_id, a.input_id, a.bound_version, a.request_id, a.task_id, a.canonical_checkout, a.checkout_key, a.state, a.release_authorized, a.release_authorized_at, a.release_token_digest, a.release_nonce_digest, a.error, a.created_at, a.updated_at, a.record_digest);
			}
		} finally { raw.close(); }
	}

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Settled v1 receipt while v3 is current (with no managing session).
			const recSet = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=rec-settled`);
			assert.equal(recSet.status, 200);
			assert.equal(recSet.body.type, "receipt");
			assert.equal(recSet.body.is_run_report, false);
			assert.match(recSet.body.note, /not a run report/i);
			assert.equal(recSet.body.factory_id, facA.factory_id);
			assert.equal(recSet.body.input_id, inSettled.input_id);
			assert.equal(recSet.body.reference, "rec-settled");
			assert.equal(recSet.body.queue_position, 1);
			assert.equal(recSet.body.bound_version, "v1");
			assert.equal(recSet.body.current_version, "v3");
			assert.equal(recSet.body.disposition, "settled");
			assert.equal(recSet.body.brief, undefined);
			assert.equal(recSet.body.attempt.state, "settled");
			assert.equal(recSet.body.attempt.bound_version, "v1");
			assert.equal(recSet.body.attempt.release_authorized, true);
			assert.equal(typeof recSet.body.attempt.release_authorized_at, "string");
			assert.equal(recSet.body.attempt.canonical_checkout, undefined);
			assert.equal(recSet.body.attempt.node_counts, undefined);
			assert.equal(recSet.body.attempt.uncertain, undefined);

			// Discarded -> attempt absence: not applicable
			const recDisc = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=rec-discarded`);
			assert.equal(recDisc.status, 200);
			assert.equal(recDisc.body.disposition, "discarded");
			assert.equal(recDisc.body.attempt.absence, "not applicable");

			// Queued, blocked, retryable without attempt -> attempt absence: no records
			for (const ref of ["rec-queued", "rec-blocked", "rec-retryable"]) {
				const r = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=${ref}`);
				assert.equal(r.status, 200);
				assert.equal(r.body.attempt.absence, "no records", ref);
			}

			// Running without attempt row -> attempt absence: evidence unavailable
			const recMiss = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=rec-missing-att`);
			assert.equal(recMiss.status, 200);
			assert.equal(recMiss.body.attempt.evidence, "unavailable");
			assert.equal(recMiss.body.attempt.absence, "evidence unavailable");

			// Failed before release on facB -> release_authorized_at not applicable, error path never leaked
			const recRes = await getJson(`${viewer.url}/api/factories/${facB.factory_id}/receipts?reference=facb-reserved`);
			assert.equal(recRes.status, 200);
			assert.equal(recRes.body.attempt.state, "failed_before_release");
			assert.equal(recRes.body.attempt.release_authorized, false);
			assert.equal(recRes.body.attempt.release_authorized_at.absence, "not applicable");
			assert.equal(recRes.body.attempt.error, undefined);

			// Settled/cleared with release_authorized=0, and unrecognized attempt state -> marked uncertain
			for (const ref of ["facb-custom", "facb-clr-unauth", "facb-unk-state"]) {
				const recBad = await getJson(`${viewer.url}/api/factories/${facB.factory_id}/receipts?reference=${ref}`);
				assert.equal(recBad.status, 200, ref);
				assert.equal(recBad.body.attempt.uncertain, true, ref);
			}

			// Unknown reference and cross-factory reference -> 404 with clear message (not an empty receipt)
			for (const url of [
				`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=does-not-exist`,
				`${viewer.url}/api/factories/${facB.factory_id}/receipts?reference=rec-settled`,
				`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=facb-reserved`,
			]) {
				const miss = await getJson(url);
				assert.equal(miss.status, 404, url);
				assert.deepEqual(miss.body, { error: "Unknown submission reference" });
			}

			// Malformed, missing, over-long (>256 UTF-8 bytes), duplicate, extra params -> 400
			for (const badQuery of [
				"",
				"?reference=",
				"?reference=bad%20space",
				"?reference=bad%00nul",
				`?reference=${encodeURIComponent("é".repeat(129))}`,
				`?reference=${"a".repeat(257)}`,
				"?reference=rec-settled&reference=rec-queued",
				`?input_id=${inQueued.input_id}`,
				"?reference=rec-settled&extra=1",
			]) {
				const bad = await fetch(`${viewer.url}/api/factories/${facA.factory_id}/receipts${badQuery}`);
				assert.equal(bad.status, 400, `expected 400 for ${badQuery}`);
			}

			// Leak scan on every 200 receipt response
			for (const res of [recSet, recDisc, recMiss, recRes]) {
				for (const s of ["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath]) {
					assert.equal(res.text.includes(s), false, `receipt leaked ${s}`);
				}
			}
		},
	);

	// Receipt lookup still works with NO manager record AND NO pointer (never falls back to bound_version for current_version);
	// meanwhile queue fails closed to evidence unavailable.
	{
		const raw = new DatabaseSync(statePath);
		try {
			raw.prepare("DELETE FROM factory_managers WHERE factory_id = ?").run(facA.factory_id);
			raw.prepare("DELETE FROM factory_pointers WHERE factory_id = ?").run(facA.factory_id);
		} finally { raw.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const recNoMgr = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=rec-settled`);
			assert.equal(recNoMgr.status, 200);
			assert.equal(recNoMgr.body.bound_version, "v1");
			assert.equal(recNoMgr.body.current_version.absence, "evidence unavailable");

			const qNoMgr = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/queue`);
			assert.equal(qNoMgr.status, 200);
			assert.equal(qNoMgr.body.evidence, "unavailable");
			assert.equal(qNoMgr.body.absence, "evidence unavailable");
		},
	);

	// Tampered input row -> receipt returns 503 Evidence unavailable.
	{
		const raw = new DatabaseSync(statePath);
		try {
			raw.prepare("UPDATE factory_inputs SET brief = 'tampered' WHERE input_id = ?").run(inSettled.input_id);
		} finally { raw.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const tamperedRec = await getJson(`${viewer.url}/api/factories/${facA.factory_id}/receipts?reference=rec-settled`);
			assert.equal(tamperedRec.status, 503);
			assert.deepEqual(tamperedRec.body, { error: "Evidence unavailable" });
		},
	);
});

test("Hot-journal store returns typed evidence unavailable on queue and 503 on receipt without recovery, and FIFO manifest does not hang receipt lookup", async t => {
	// 1. Hot-journal factories.sqlite -> queue gives evidence unavailable, receipts gives 503, journal stays intact.
	{
		const f = serviceFixture(t, ["first"]);
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		mkdirSync(join(iso.agentDir, "agents"), { recursive: true });
		writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
		const dbPath = join(f.root, "factories.sqlite");
		const coordPath = join(f.root, "factory-coordination.sqlite");
		const ops = factoryOperations(dbPath, f.service, { coordinationPath: coordPath });
		const initDraft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "Seed", agents: [{ persona: "first", node_id: "build", sub_task: "init" }] };
		const existing = ops({ action: "publish", name: "existing-hot", draft: initDraft, sessionModel });

		const draftFile = join(f.root, "draft.json");
		const bigDraft: GenerateRequest = {
			project_cwd: f.cwd,
			topology: "graph",
			task: "Hot journal test",
			agents: [{ persona: "first", node_id: "build", sub_task: "x".repeat(3 * 1024 * 1024) }],
		};
		writeFileSync(draftFile, JSON.stringify(bigDraft));
		const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
		const killed = await runSupervised(process.execPath, [child, dbPath, draftFile, "hot-factory-2", "before_commit"], {
			env: { ...iso.env, PATH: join(f.root, "bin") },
			timeoutMs: 10_000,
		});
		assert.equal(killed.signal, "SIGKILL", killed.stderr);
		assert.equal(existsSync(`${dbPath}-journal`), true);

		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
			async viewer => {
				const qRes = await getJson(`${viewer.url}/api/factories/${existing.factory_id}/queue?filter=open`);
				assert.equal(qRes.status, 200);
				assert.equal(qRes.body.evidence, "unavailable");
				assert.equal(qRes.body.absence, "evidence unavailable");

				const rRes = await getJson(`${viewer.url}/api/factories/${existing.factory_id}/receipts?reference=any-ref`);
				assert.equal(rRes.status, 503);
				assert.deepEqual(rRes.body, { error: "Evidence unavailable" });
			},
		);
		assert.equal(existsSync(`${dbPath}-journal`), true);
	}

	// 2. FIFO manifest.json on released attempt does not hang /receipts (verified in SIGKILL child watchdog).
	{
		const f = serviceFixture(t, ["builder"]);
		const statePath = join(f.root, "factories.sqlite");
		const coordinationPath = join(f.root, "factory-coordination.sqlite");
		const ops = factoryOperations(statePath, f.service, { coordinationPath });
		const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "PRIVATE_FIFO", agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_FIFO_SUB" }] };
		const fac = ops({ action: "publish", name: "fifo-receipt", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "sess-fifo" });
		ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
		ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "fifo-ref", brief: "PRIVATE_FIFO_BRIEF" });
		const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
		revokeManagerAuthority(auth);

		const manifestFile = join(launched.manifest.session_dir, "manifest.json");
		rmSync(manifestFile);
		execFileSync("mkfifo", [manifestFile]);

		const responses = await verifyReadOnlyViewerInChild({
			stateDirs: f.root,
			viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
			paths: [
				`/api/factories/${fac.factory_id}/receipts?reference=fifo-ref`,
				`/api/factories/${fac.factory_id}/queue?filter=all`,
			],
		});
		assert.equal(responses[0]!.status, 200);
		const rec = JSON.parse(responses[0]!.text);
		assert.equal(rec.type, "receipt");
		assert.equal(rec.attempt.attempt_id, launched.attempt_id);
		assert.equal(responses[1]!.status, 200);
		const q = JSON.parse(responses[1]!.text);
		assert.equal(q.entries[0].reference, "fifo-ref");
	}
});
