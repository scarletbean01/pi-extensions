import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer } from "./test-support/factory-viewer-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };
const workerModel = { provider: "test-provider", id: "test-model" };

async function getChecked(baseUrl: string, path: string, sentinels: readonly string[], expectedStatus = 200) {
	const res = await fetch(`${baseUrl}${path}`);
	const text = await res.text();
	assert.equal(res.status, expectedStatus, `${path} -> ${res.status}: ${text}`);
	for (const s of sentinels) {
		assert.equal(text.includes(s), false, `${path} leaked sentinel ${JSON.stringify(s)}`);
	}
	return JSON.parse(text) as any;
}

test("viewer /api/factories separates active, deleted, and damaged factories without writes, including v12 and closed-manager stores", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_PROMPT_LIST",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SUBTASK_LIST" }],
	};

	const active = ops({ action: "publish", name: "active-viewer-fac", draft, sessionModel });
	const retired = ops({ action: "publish", name: "retired-viewer-fac", draft, sessionModel });
	const damaged = ops({ action: "publish", name: "damaged-viewer-fac", draft, sessionModel });

	const secretSessionFile = join(f.root, "PRIVATE_SESSION_FILE.jsonl");
	const authRetired = createManagerAuthority({ pi_session_id: "sess-ret-list", pi_session_file: secretSessionFile });
	ops({ action: "resume", factory_id: retired.factory_id, authority: authRetired });
	const delRetired = await ops({ action: "delete", factory_id: retired.factory_id, authority: authRetired, confirm: async () => true });
	revokeManagerAuthority(authRetired);

	const authDamaged = createManagerAuthority({ pi_session_id: "sess-dmg-list", pi_session_file: secretSessionFile });
	ops({ action: "resume", factory_id: damaged.factory_id, authority: authDamaged });
	await ops({ action: "delete", factory_id: damaged.factory_id, authority: authDamaged, confirm: async () => true });
	revokeManagerAuthority(authDamaged);

	// Corrupt damaged factory's deletion digest
	const raw = new DatabaseSync(statePath);
	try {
		raw.prepare("UPDATE factory_deletions SET record_digest = ? WHERE factory_id = ?").run("0".repeat(64), damaged.factory_id);
	} finally {
		raw.close();
	}

	const sentinels = [f.root, f.cwd, f.home, secretSessionFile, "PRIVATE_PROMPT_LIST", "PRIVATE_SUBTASK_LIST"];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const body = await getChecked(viewer.url, "/api/factories", sentinels);
			assert.deepEqual(body.factories, [
				{ factory_id: active.factory_id, name: "active-viewer-fac", current_version: "v1", management: "unmanaged" },
			]);
			assert.equal(body.deleted.length, 1);
			assert.equal(body.deleted[0].factory_id, retired.factory_id);
			assert.equal(body.deleted[0].name, "retired-viewer-fac");
			assert.equal(body.deleted[0].deleted, true);
			assert.equal(body.deleted[0].deletion.deleted_at, delRetired.deletion!.deleted_at);
			assert.equal(body.deleted[0].deletion.deleted_by.pi_session_id, "sess-ret-list");
			assert.equal("pi_session_file" in body.deleted[0].deletion.deleted_by, false);

			assert.equal(body.damaged.length, 1);
			assert.equal(body.damaged[0].factory_id, damaged.factory_id);
			assert.equal(body.damaged[0].name, "damaged-viewer-fac");
			assert.equal(body.damaged[0].damaged, true);
			assert.equal(body.damaged[0].evidence, "unavailable");
			assert.equal(body.damaged[0].status, "uncertain");
			assert.equal("management" in body.damaged[0], false);
		},
	);

	// Also prove reading a v12 database (pre-deletion schema) does not migrate or write anything.
	const v12Fix = serviceFixture(t, ["builder"]);
	const v12State = join(v12Fix.root, "factories.sqlite");
	const v12Coord = join(v12Fix.root, "factory-coordination.sqlite");
	const v12Ops = factoryOperations(v12State, v12Fix.service, { coordinationPath: v12Coord });
	const v12Fac = v12Ops({ action: "publish", name: "v12-fac", draft: { ...draft, project_cwd: v12Fix.cwd }, sessionModel });
	const v12Db = new DatabaseSync(v12State);
	try {
		v12Db.exec("DROP TABLE IF EXISTS factory_deletions; PRAGMA user_version = 12;");
	} finally {
		v12Db.close();
	}
	await verifyReadOnlyViewer(
		{ stateDirs: v12Fix.root, viewerOptions: { statePath: v12State, coordinationPath: v12Coord, env: { PATH: join(v12Fix.root, "bin") }, home: v12Fix.home } },
		async viewer => {
			const body = await getChecked(viewer.url, "/api/factories", [v12Fix.root, v12Fix.cwd, v12Fix.home]);
			assert.deepEqual(body, {
				factories: [{ factory_id: v12Fac.factory_id, name: "v12-fac", current_version: "v1", management: "unmanaged" }],
				deleted: [],
				damaged: [],
			});
			const insp = await getChecked(viewer.url, `/api/factories/${v12Fac.factory_id}/inspect`, [v12Fix.root, v12Fix.cwd, v12Fix.home]);
			assert.equal("deleted" in insp, false);
		},
	);
	const v12Check = new DatabaseSync(v12State, { readOnly: true });
	try {
		assert.equal(v12Check.prepare("PRAGMA user_version").get()?.user_version, 12);
	} finally {
		v12Check.close();
	}
});

test("deleted factory snapshots keep Inspect, Queue, Receipts, Requests, and Proposals readable with deletion time, while Live Graph never implies activity", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const choices = [{ choice_id: "proceed", label: "Proceed" }];
	const makeDraft = (task: string): GenerateRequest => ({
		project_cwd: f.cwd,
		topology: "graph",
		task,
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SUBTASK", intervention: { choices } } as any],
	});

	const retiredRich = ops({ action: "publish", name: "retired-rich", draft: makeDraft("PRIVATE_PROMPT_V1"), sessionModel });
	ops({ action: "update", factory_id: retiredRich.factory_id, draft: makeDraft("PRIVATE_PROMPT_V2"), sessionModel });
	ops({ action: "restore", factory_id: retiredRich.factory_id, from_version: "v1" });

	const secretSessionFile = join(f.root, "PRIVATE_MGR_SESSION.jsonl");
	const authRich = createManagerAuthority({ pi_session_id: "sess-rich-del", pi_session_file: secretSessionFile });
	ops({ action: "resume", factory_id: retiredRich.factory_id, authority: authRich });

	ops({ action: "submit", factory_id: retiredRich.factory_id, authority: authRich, reference: "del-ref-1", brief: "PRIVATE_BRIEF_1" });
	const run = await ops({ action: "launch", factory_id: retiredRich.factory_id, authority: authRich });
	const sessionDir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const cfgFile = readdirSync(sessionDir).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const w = workerFromConfig(t, join(sessionDir, cfgFile), { model: workerModel });
	await w.start();
	await w.beforeStart();
	const asked = w.requestDirection({ question: "Proceed with build?", reason: "Check", evidence: ["e1"], choices: ["proceed"] } as any);
	let reqId = "";
	for (let i = 0; i < 100 && !reqId; i++) {
		reqId = (ops({ action: "requests", factory_id: retiredRich.factory_id }) as any[]).find(r => r.state === "pending")?.request_id ?? "";
		if (!reqId) await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(reqId);
	ops({ action: "respond_request", factory_id: retiredRich.factory_id, request_id: reqId, response: { kind: "choice", choice_id: "proceed" }, authority: authRich } as any);
	await asked;
	await w.complete({ status: "success", summary: "Built", detail: "PRIVATE_RUN_DETAIL" });
	assert.equal((await ops({ action: "settle_run", factory_id: retiredRich.factory_id, authority: authRich })).settled, true);

	const inst = JSON.parse(readFileSync(join(sessionDir, cfgFile), "utf8")).instance_id as string;
	const prop = ops({
		action: "propose_constraint",
		factory_id: retiredRich.factory_id,
		run_id: run.task_id,
		attempt_id: `${inst}.1`,
		evidence_ref: `request:${reqId}`,
		text: "Keep history readable after factory deletion.",
		authority: authRich,
	});
	await ops({
		action: "reject_constraint",
		factory_id: retiredRich.factory_id,
		proposal_id: prop.proposal.proposal_id,
		authority: authRich,
		confirm: async () => ({ confirmed: true, reason: "Historical only" }),
	});

	const subDiscarded = ops({ action: "submit", factory_id: retiredRich.factory_id, authority: authRich, reference: "del-ref-2", brief: "PRIVATE_BRIEF_2" });
	await ops({ action: "discard", factory_id: retiredRich.factory_id, input_id: subDiscarded.input_id, authority: authRich, confirm: async () => true });

	const delRich = await ops({ action: "delete", factory_id: retiredRich.factory_id, authority: authRich, confirm: async () => true });
	revokeManagerAuthority(authRich);

	// Second deleted factory with zero inputs/requests/proposals (covers absent snapshots)
	const retiredEmpty = ops({ action: "publish", name: "retired-empty", draft: makeDraft("PRIVATE_EMPTY_PROMPT"), sessionModel });
	const authEmpty = createManagerAuthority({ pi_session_id: "sess-empty-del", pi_session_file: secretSessionFile });
	ops({ action: "resume", factory_id: retiredEmpty.factory_id, authority: authEmpty });
	const delEmpty = await ops({ action: "delete", factory_id: retiredEmpty.factory_id, authority: authEmpty, confirm: async () => true });
	revokeManagerAuthority(authEmpty);

	// Damaged factory
	const damaged = ops({ action: "publish", name: "damaged-snapshot-fac", draft: makeDraft("PRIVATE_DMG_PROMPT"), sessionModel });
	const authDmg = createManagerAuthority({ pi_session_id: "sess-dmg-snap", pi_session_file: secretSessionFile });
	ops({ action: "resume", factory_id: damaged.factory_id, authority: authDmg });
	await ops({ action: "delete", factory_id: damaged.factory_id, authority: authDmg, confirm: async () => true });
	revokeManagerAuthority(authDmg);
	const raw = new DatabaseSync(statePath);
	try {
		raw.prepare("UPDATE factory_deletions SET record_digest = ? WHERE factory_id = ?").run("f".repeat(64), damaged.factory_id);
	} finally {
		raw.close();
	}

	const sentinels = [f.root, f.cwd, f.home, secretSessionFile, "PRIVATE_PROMPT_V1", "PRIVATE_PROMPT_V2", "PRIVATE_SUBTASK", "PRIVATE_BRIEF_1", "PRIVATE_BRIEF_2", "PRIVATE_RUN_DETAIL", "PRIVATE_EMPTY_PROMPT", "PRIVATE_DMG_PROMPT"];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			for (const [fid, expectedAt] of [
				[retiredRich.factory_id, delRich.deletion!.deleted_at],
				[retiredEmpty.factory_id, delEmpty.deletion!.deleted_at],
			] as const) {
				const live = await getChecked(viewer.url, `/api/factories/${fid}/live`, sentinels);
				assert.equal(live.state, "deleted");
				assert.equal(["idle", "waiting", "running"].includes(live.state), false);
				assert.equal(live.deleted, true);
				assert.equal(live.deletion.deleted_at, expectedAt);
				assert.equal("pi_session_file" in live.deletion.deleted_by, false);
				assert.equal(live.run, null);
				assert.equal(live.graph.absence, "not applicable");
				assert.equal(live.head_status, undefined);

				const insp = await getChecked(viewer.url, `/api/factories/${fid}/inspect`, sentinels);
				assert.equal(insp.deleted, true);
				assert.equal(insp.deletion.deleted_at, expectedAt);
				assert.equal("pi_session_file" in insp.deletion.deleted_by, false);
				assert.ok(insp.definition);

				const qOpen = await getChecked(viewer.url, `/api/factories/${fid}/queue?filter=open`, sentinels);
				assert.equal(qOpen.deleted, true);
				assert.equal(qOpen.deletion.deleted_at, expectedAt);

				const qAll = await getChecked(viewer.url, `/api/factories/${fid}/queue?filter=all`, sentinels);
				assert.equal(qAll.deleted, true);
				assert.equal(qAll.deletion.deleted_at, expectedAt);

				const reqs = await getChecked(viewer.url, `/api/factories/${fid}/requests`, sentinels);
				assert.equal(reqs.deleted, true);
				assert.equal(reqs.deletion.deleted_at, expectedAt);

				const props = await getChecked(viewer.url, `/api/factories/${fid}/proposals`, sentinels);
				assert.equal(props.deleted, true);
				assert.equal(props.deletion.deleted_at, expectedAt);
			}

			// Verify rich factory retains all history on Inspect(v1), Queue(all), Receipts, Requests, Proposals
			const inspV1 = await getChecked(viewer.url, `/api/factories/${retiredRich.factory_id}/inspect?version=v1`, sentinels);
			assert.equal(inspV1.inspected_version, "v1");
			assert.equal(inspV1.deleted, true);
			assert.equal(inspV1.deletion.deleted_at, delRich.deletion!.deleted_at);

			const richQueue = await getChecked(viewer.url, `/api/factories/${retiredRich.factory_id}/queue?filter=all`, sentinels);
			assert.equal(richQueue.entries.length, 2);

			const richReceipt = await getChecked(viewer.url, `/api/factories/${retiredRich.factory_id}/receipts?reference=del-ref-1`, sentinels);
			assert.equal(richReceipt.type, "receipt");
			assert.equal(richReceipt.deleted, true);
			assert.equal(richReceipt.deletion.deleted_at, delRich.deletion!.deleted_at);
			assert.equal(richReceipt.attempt.state, "settled");

			const richReqs = await getChecked(viewer.url, `/api/factories/${retiredRich.factory_id}/requests`, sentinels);
			assert.equal(richReqs.records.length, 1);

			const richProps = await getChecked(viewer.url, `/api/factories/${retiredRich.factory_id}/proposals`, sentinels);
			assert.equal(richProps.records.length, 1);

			// Damaged deletion record fails closed on individual views (never active, never idle/waiting/running)
			await getChecked(viewer.url, `/api/factories/${damaged.factory_id}/live`, sentinels, 503);
			for (const view of ["inspect", "queue", "requests", "proposals"]) {
				const body = await getChecked(viewer.url, `/api/factories/${damaged.factory_id}/${view}`, sentinels, 200);
				assert.equal(body.evidence, "unavailable", `${view} must report unavailable`);
				assert.equal(body.absence, "evidence unavailable", `${view} must report evidence unavailable`);
			}
		},
	);
});

