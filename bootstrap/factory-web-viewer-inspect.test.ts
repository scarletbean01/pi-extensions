import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type ClearanceDecision } from "../factory/operations.ts";
import { publicInspect } from "../factory/viewer/inspect.ts";
import { buildAttemptRow, buildInputRow, sha256Hex } from "./factory-records.ts";
import { createRequest, directionProcess, inTransaction, openRequestDatabase, recordResponse, terminateNodeRequests } from "./factory-requests.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { BootstrapService } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer } from "./test-support/factory-viewer-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

async function getInspect(baseUrl: string, factoryId: string) {
	const res = await fetch(`${baseUrl}/api/factories/${encodeURIComponent(factoryId)}/inspect`);
	assert.equal(res.status, 200);
	return res.json() as Promise<any>;
}

test("Inspect attention summary explains name, management, stop state, version, capacity, queue-head blockers, and attention", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const viewerEnv = { PATH: join(f.root, "bin") };

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_PROMPT_ATTENTION",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "SENTINEL_SUBTASK_BUILD" },
		],
	};

	const unmanaged = ops({ action: "publish", name: "unmanaged-fac", draft, sessionModel });
	const managed = ops({ action: "publish", name: "managed-fac", draft, sessionModel });
	const checkoutPeer = ops({ action: "publish", name: "checkout-peer", draft, sessionModel });

	const authManaged = createManagerAuthority({ pi_session_id: "sess-managed" });
	ops({ action: "resume", factory_id: managed.factory_id, authority: authManaged });

	// 1. Unmanaged factory vs managed empty factory.
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const unm = await getInspect(viewer.url, unmanaged.factory_id);
			assert.equal(unm.name, "unmanaged-fac");
			assert.equal(unm.attention_summary.name, "unmanaged-fac");
			assert.equal(unm.attention_summary.management.state, "unmanaged");
			assert.match(unm.attention_summary.management.explanation, /unmanaged/i);
			assert.equal(unm.attention_summary.stop_state.absence, "not applicable");
			assert.match(unm.attention_summary.stop_state.explanation, /managed/i);
			assert.equal(unm.attention_summary.current_version.version, "v1");
			assert.match(unm.attention_summary.current_version.explanation, /v1/);
			assert.equal(unm.attention_summary.capacity.factory_slot.state, "free");
			assert.match(unm.attention_summary.capacity.factory_slot.explanation, /free/i);
			assert.equal(unm.attention_summary.capacity.checkout_slot.state, "free");
			assert.match(unm.attention_summary.capacity.checkout_slot.explanation, /free/i);
			assert.equal(unm.attention_summary.capacity.blocking_hold.absence, "no records");
			assert.equal(unm.attention_summary.capacity.queue.absence, "not applicable");
			assert.equal(unm.attention_summary.queue_head.eligible, false);
			assert.equal(unm.attention_summary.queue_head.blocking_kind, "unmanaged");
			assert.match(unm.attention_summary.queue_head.explanation, /unmanaged/i);
			assert.equal(unm.attention_summary.queue_head.input.absence, "not applicable");
			assert.equal(unm.attention_summary.attention.absence, "not applicable");

			const mEmpty = await getInspect(viewer.url, managed.factory_id);
			assert.equal(mEmpty.attention_summary.management.state, "managed");
			assert.match(mEmpty.attention_summary.management.explanation, /manage/i);
			assert.equal(mEmpty.attention_summary.stop_state.stopped, false);
			assert.match(mEmpty.attention_summary.stop_state.explanation, /not paused|clear/i);
			assert.equal(mEmpty.attention_summary.capacity.queue.used, 0);
			assert.equal(mEmpty.attention_summary.capacity.queue.limit, 32);
			assert.match(mEmpty.attention_summary.capacity.queue.explanation, /0 of 32/);
			assert.equal(mEmpty.attention_summary.queue_head.eligible, false);
			assert.equal(mEmpty.attention_summary.queue_head.blocking_kind, "empty");
			assert.match(mEmpty.attention_summary.queue_head.explanation, /waiting/i);
			assert.equal(mEmpty.attention_summary.queue_head.input.absence, "no records");
			assert.equal(mEmpty.attention_summary.attention.absence, "no records");
		},
	);

	// 2. Submit brief -> eligible head; then stop -> stopped head with eligible without_control_fence; also check preflight failure when PATH lacks pi/herdr.
	ops({ action: "submit", factory_id: managed.factory_id, authority: authManaged, reference: "ref-eligible", brief: "SENTINEL_BRIEF_1" });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const eligible = await getInspect(viewer.url, managed.factory_id);
			assert.equal(eligible.attention_summary.queue_head.eligible, true);
			assert.equal(eligible.attention_summary.queue_head.blocker.absence, "not applicable");
			assert.equal(eligible.attention_summary.queue_head.input.reference, "ref-eligible");
			assert.equal(eligible.attention_summary.queue_head.input.bound_version, "v1");
			assert.match(eligible.attention_summary.queue_head.explanation, /no blocker/i);
		},
	);
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
		async viewer => {
			const preflightBlocked = await getInspect(viewer.url, managed.factory_id);
			assert.equal(preflightBlocked.attention_summary.queue_head.eligible, false);
			assert.equal(preflightBlocked.attention_summary.queue_head.blocking_kind, "preflight");
			assert.match(preflightBlocked.attention_summary.queue_head.explanation, /prerequisite/i);
		},
	);

	ops({ action: "stop", factory_id: managed.factory_id, authority: authManaged });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const stopped = await getInspect(viewer.url, managed.factory_id);
			assert.equal(stopped.attention_summary.stop_state.stopped, true);
			assert.match(stopped.attention_summary.stop_state.explanation, /stop fence is active|paused/i);
			assert.equal(stopped.attention_summary.queue_head.eligible, false);
			assert.equal(stopped.attention_summary.queue_head.blocking_kind, "stopped");
			assert.match(stopped.attention_summary.queue_head.explanation, /stop fence/i);
			assert.equal(stopped.attention_summary.queue_head.without_control_fence.eligible, true);
		},
	);

	// 3. Resume, launch managed-fac (holds factory + checkout), and inspect both managed-fac and checkout-peer.
	ops({ action: "resume", factory_id: managed.factory_id, authority: authManaged });
	await ops({ action: "launch", factory_id: managed.factory_id, authority: authManaged });
	revokeManagerAuthority(authManaged);

	const authPeer = createManagerAuthority({ pi_session_id: "sess-peer" });
	ops({ action: "resume", factory_id: checkoutPeer.factory_id, authority: authPeer });
	ops({ action: "submit", factory_id: checkoutPeer.factory_id, authority: authPeer, reference: "ref-peer", brief: "SENTINEL_BRIEF_PEER" });
	revokeManagerAuthority(authPeer);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const held = await getInspect(viewer.url, managed.factory_id);
			assert.equal(held.attention_summary.capacity.factory_slot.state, "held");
			assert.equal(held.attention_summary.capacity.checkout_slot.state, "held");
			assert.equal(held.attention_summary.capacity.blocking_hold.scope, "both");
			assert.match(held.attention_summary.capacity.blocking_hold.scope_explanation, /both/i);
			assert.equal(held.attention_summary.capacity.blocking_hold.state, "released");
			assert.match(held.attention_summary.capacity.blocking_hold.state_explanation, /released/i);
			assert.equal(held.attention_summary.queue_head.blocking_kind, "factory_held");
			assert.match(held.attention_summary.queue_head.explanation, /factory.*run slot/i);

			const peer = await getInspect(viewer.url, checkoutPeer.factory_id);
			assert.equal(peer.attention_summary.capacity.factory_slot.state, "free");
			assert.equal(peer.attention_summary.capacity.checkout_slot.state, "held");
			assert.equal(peer.attention_summary.capacity.blocking_hold.scope, "checkout");
			assert.equal(peer.attention_summary.capacity.blocking_hold.factory_id, managed.factory_id);
			assert.match(peer.attention_summary.capacity.blocking_hold.explanation, /managed-fac/);
			assert.equal(peer.attention_summary.queue_head.blocking_kind, "checkout_held");
			assert.match(peer.attention_summary.queue_head.explanation, /checkout slot/i);
		},
	);

	// 4. Ceiling blocker test on a separate checkout factory.
	const fCeil = serviceFixture(t, ["builder"]);
	const ceilState = join(fCeil.root, "factories.sqlite");
	const ceilCoord = join(fCeil.root, "factory-coordination.sqlite");
	const ceilOps = factoryOperations(ceilState, fCeil.service, { coordinationPath: ceilCoord });
	const ceilFac = ceilOps({
		action: "publish",
		name: "ceil-fac",
		draft: {
			project_cwd: fCeil.cwd,
			topology: "graph",
			task: "Ceiling task",
			agents: [
				{ node_id: "work", persona: "builder", sub_task: "Work" },
				{
					node_id: "review",
					persona: "builder",
					sub_task: "Review",
					depends_on: ["work"],
					output_contract: { properties: { v: { type: "string", enum: ["yes", "no"], required: true } } },
					decision: { field: "v", approve: "yes", reject: "no", on_reject: "work", max_revisions: 2 },
				},
			],
		},
		sessionModel,
	});
	const authCeil = createManagerAuthority({ pi_session_id: "sess-ceil" });
	ceilOps({ action: "resume", factory_id: ceilFac.factory_id, authority: authCeil });
	ceilOps({ action: "submit", factory_id: ceilFac.factory_id, authority: authCeil, reference: "ref-ceil", brief: "Brief" });
	revokeManagerAuthority(authCeil);
	mkdirSync(join(fCeil.cwd, ".pi"), { recursive: true });
	writeFileSync(join(fCeil.cwd, ".pi", "bootstrap.json"), JSON.stringify({ graph: { ceilings: { maxRevisions: 1 } } }));

	await verifyReadOnlyViewer(
		{ stateDirs: fCeil.root, viewerOptions: { statePath: ceilState, coordinationPath: ceilCoord, env: { PATH: join(fCeil.root, "bin") }, home: fCeil.home } },
		async viewer => {
			const ceil = await getInspect(viewer.url, ceilFac.factory_id);
			assert.equal(ceil.attention_summary.queue_head.eligible, false);
			assert.equal(ceil.attention_summary.queue_head.blocking_kind, "ceiling");
			assert.equal(ceil.attention_summary.queue_head.explanation, "The bound definition exceeds a configured revision or attempt ceiling.");
			assert.equal(ceil.attention_summary.queue_head.blocker.explanation, "The bound definition exceeds a configured revision or attempt ceiling.");
		},
	);
});

test("Inspect definition and versions report restore provenance, runtime assumptions, damaged records, and hot-journal refusal without recovery", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const viewerEnv = { PATH: join(f.root, "bin") };

	const v1Draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_V1_PROMPT",
		agents: [{ node_id: "build", persona: "builder", sub_task: "SENTINEL_V1_SUBTASK" }],
	};
	const v2Draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_V2_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "SENTINEL_V2_BUILD" },
			{ node_id: "review", persona: "reviewer", sub_task: "SENTINEL_V2_REVIEW", depends_on: ["build"] },
		],
	};

	const fac = ops({ action: "publish", name: "versioned-fac", draft: v1Draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-ver" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v2Draft, sessionModel });
	ops({ action: "restore", factory_id: fac.factory_id, authority: auth, from_version: "v1" });
	revokeManagerAuthority(auth);

	// 1. Intact multi-version history with restore provenance (v3 restored from v1) and runtime assumptions.
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			assert.equal(snap.current_version, "v3");
			assert.equal(snap.inspected_version, "v3");
			assert.equal(snap.current_definition.available, true);
			assert.equal(snap.definition.limits.task_timeout_ms.absence, "no records");
			assert.equal(snap.definition.nodes[0].limits.task_timeout_ms.absence, "no records");
			assert.equal(snap.damaged_records.absence, "no records");
			assert.equal(snap.definition.restored_from.version, "v1");
			assert.match(snap.definition.restored_from.explanation, /v1/);
			assert.deepEqual(snap.versions.map((v: any) => v.version), ["v1", "v2", "v3"]);
			assert.match(snap.versions[0].digest, /^[a-f0-9]{64}$/);
			assert.equal(typeof snap.versions[0].created_at, "string");
			assert.equal(snap.versions[0].restored_from.absence, "not applicable");
			assert.equal(snap.versions[1].restored_from.absence, "not applicable");
			assert.equal(snap.versions[2].current, true);
			assert.equal(snap.versions[2].inspected, true);
			assert.equal(snap.versions[2].restored_from.version, "v1");
			assert.ok(snap.runtime_assumptions.not_frozen.some((item: any) => item.key === "checkout_contents" && /checkout/i.test(item.explanation)));
			assert.ok(snap.runtime_assumptions.not_frozen.some((item: any) => item.key === "pi_runtime"));
			assert.match(snap.runtime_assumptions.note, /live runtime/i);
			assert.deepEqual(snap.definition.not_frozen, snap.runtime_assumptions);
		},
	);

	// 2. Corrupt retained historical version v2 and delete v1 row while v3 is current -> v1/v2 marked unavailable with missing digest/created_at, v3 remains readable.
	{
		const db = new DatabaseSync(statePath);
		try {
			db.prepare("DELETE FROM factory_versions WHERE factory_id = ? AND version = 'v1'").run(fac.factory_id);
			db.prepare("UPDATE factory_versions SET definition = '{corrupt' WHERE factory_id = ? AND version = 'v2'").run(fac.factory_id);
		} finally { db.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			assert.equal(snap.evidence, "uncertain");
			assert.equal(snap.current_version, "v3");
			assert.equal(snap.definition.nodes[0].id, "build");
			assert.equal(snap.versions[0].version, "v1");
			assert.equal(snap.versions[0].digest.absence, "evidence unavailable");
			assert.equal(snap.versions[0].created_at.absence, "evidence unavailable");
			assert.match(snap.versions[0].created_at.explanation, /damaged/i);
			assert.equal(snap.versions[1].version, "v2");
			assert.equal(snap.versions[1].evidence, "unavailable");
			assert.equal(snap.versions[1].absence, "evidence unavailable");
			assert.equal(snap.versions[1].restored_from.absence, "evidence unavailable");
			assert.ok(snap.damaged_records.count >= 2);
			assert.ok(snap.damaged_records.items.some((item: any) => item.scope === "definition_version" && item.version === "v1"));
			assert.ok(snap.damaged_records.items.some((item: any) => item.scope === "definition_version" && item.version === "v2"));
		},
	);

	// 3. Corrupt current version v3 row (pointer intact) -> definition and current_definition report evidence unavailable.
	{
		const db = new DatabaseSync(statePath);
		try {
			db.prepare("UPDATE factory_versions SET definition = '{corrupt-current' WHERE factory_id = ? AND version = 'v3'").run(fac.factory_id);
		} finally { db.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			assert.equal(snap.evidence, "uncertain");
			assert.equal(snap.current_version, "v3");
			assert.equal(snap.definition.absence, "evidence unavailable");
			assert.equal(snap.current_definition.absence, "evidence unavailable");
			assert.equal(snap.versions[2].absence, "evidence unavailable");
			assert.equal(snap.attention_summary.current_version.absence, "evidence unavailable");
			assert.equal(snap.attention_summary.queue_head.blocking_kind, "uncertain");
			assert.ok(snap.damaged_records.items.some((item: any) => item.scope === "definition_version" && item.version === "v3"));
		},
	);

	// 4. Missing factory_pointers row -> entire inspection reports unavailable evidence without defaulting to v1.
	{
		const db = new DatabaseSync(statePath);
		try {
			db.prepare("DELETE FROM factory_pointers WHERE factory_id = ?").run(fac.factory_id);
		} finally { db.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			assert.equal(snap.evidence, "unavailable");
			assert.equal(snap.absence, "evidence unavailable");
		},
	);

	// 5. Hot-journal fixture on factories.sqlite -> inspect reports evidence unavailable with zero recovery (journal intact).
	{
		const fHot = serviceFixture(t, ["first"]);
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		mkdirSync(join(iso.agentDir, "agents"), { recursive: true });
		writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
		const hotDb = join(fHot.root, "factories.sqlite");
		const hotCoord = join(fHot.root, "factory-coordination.sqlite");
		const draftFile = join(fHot.root, "draft.json");
		writeFileSync(draftFile, JSON.stringify({
			project_cwd: fHot.cwd,
			topology: "graph",
			task: "Hot journal inspect test",
			agents: [{ persona: "first", node_id: "build", sub_task: "x".repeat(3 * 1024 * 1024) }],
		}));
		const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
		const killed = await runSupervised(process.execPath, [child, hotDb, draftFile, "hot-inspect", "before_commit"], {
			env: { ...iso.env, PATH: join(fHot.root, "bin") },
			timeoutMs: 10_000,
		});
		assert.equal(killed.signal, "SIGKILL", killed.stderr);
		assert.equal(existsSync(`${hotDb}-journal`), true);

		await verifyReadOnlyViewer(
			{ stateDirs: fHot.root, viewerOptions: { statePath: hotDb, coordinationPath: hotCoord, env: { PATH: join(fHot.root, "bin") }, home: fHot.home } },
			async viewer => {
				const snap = await getInspect(viewer.url, "hot-inspect");
				assert.equal(snap.evidence, "unavailable");
				assert.equal(snap.absence, "evidence unavailable");
			},
		);
		assert.equal(existsSync(`${hotDb}-journal`), true);
	}

	// 6. Legacy schema v1 store -> created_at reports "not applicable" (distinct from damaged record "evidence unavailable").
	{
		const fLegacy = serviceFixture(t, ["builder"]);
		const legacyDb = join(fLegacy.root, "factories.sqlite");
		const legacyCoord = join(fLegacy.root, "factory-coordination.sqlite");
		const legacyDef = JSON.stringify({
			version: 1,
			topology: "graph",
			task: "Legacy v1",
			project_cwd: fLegacy.cwd,
			failure_policy: "independent",
			ready_timeout_ms: 60_000,
			max_total_attempts: 10,
			agents: [{ node: { node_id: "build", kind: "agent", persona: "builder", sub_task: "work", inbound_edges: [] }, persona_name: "builder", model: "test-provider/test-model", thinking: "medium", tools: { mode: "inherit" }, skills: { mode: "inherit" }, extensions: { mode: "inherit_with_additions", declared: [] } }],
		});
		const db = new DatabaseSync(legacyDb);
		try {
			db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, digest TEXT NOT NULL);");
			db.prepare("INSERT INTO factories VALUES (?, ?, ?, ?)").run("fac_legacy", "legacy-fac", legacyDef, sha256Hex(legacyDef));
		} finally { db.close(); }
		await verifyReadOnlyViewer(
			{ stateDirs: fLegacy.root, viewerOptions: { statePath: legacyDb, coordinationPath: legacyCoord, env: { PATH: join(fLegacy.root, "bin") }, home: fLegacy.home } },
			async viewer => {
				const legacy = await getInspect(viewer.url, "fac_legacy");
				assert.equal(legacy.versions[0].version, "v1");
				assert.equal(legacy.versions[0].created_at.absence, "not applicable");
				assert.match(legacy.versions[0].created_at.explanation, /legacy schema v1/i);
				assert.equal(legacy.versions[0].restored_from.absence, "not applicable");
			},
		);
	}
});

test("Inspect node configuration shows labelled fields for agent, command, join, decision, policies, checks, and limits", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	writeFileSync(join(f.cwd, ".pi", "agents", "checker.md"), "---\nname: checker\nskills: \n---\nExact persona checker\n");
	writeFileSync(join(f.cwd, ".pi", "agents", "skilled.md"), "---\nname: skilled\nskills: skill-a, skill-b\nextensions: coms\n---\nExact persona skilled\n");
	mkdirSync(join(f.cwd, ".pi", "skills", "skill-a"), { recursive: true });
	mkdirSync(join(f.cwd, ".pi", "skills", "skill-b"), { recursive: true });
	writeFileSync(join(f.cwd, ".pi", "skills", "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\nA\n");
	writeFileSync(join(f.cwd, ".pi", "skills", "skill-b", "SKILL.md"), "---\nname: skill-b\ndescription: B\n---\nB\n");
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const viewerEnv = { PATH: join(f.root, "bin") };

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_NODE_CFG_PROMPT",
		task_timeout_ms: 30_000,
		dependency_wait_timeout_ms: 45_000,
		agents: [
			{
				kind: "command",
				node_id: "prep",
				command: process.execPath,
				args: ["-e", "process.exit(0)"],
				working_directory: f.cwd,
				sub_task: "SENTINEL_CMD_SUBTASK",
			},
			{
				node_id: "build",
				persona: "builder",
				sub_task: "SENTINEL_BUILD_SUBTASK",
				depends_on: ["prep"],
				dependency_policy: "require_success",
				task_timeout_ms: 15_000,
				required_checks: ["lint"],
			},
			{
				node_id: "check",
				persona: "checker",
				sub_task: "SENTINEL_CHECK_SUBTASK",
				depends_on: ["prep"],
				required_checks: ["unit"],
			},
			{
				node_id: "review",
				persona: "reviewer",
				sub_task: "SENTINEL_REVIEW_SUBTASK",
				depends_on: ["build"],
				output_contract: {
					properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } },
					required_checks: ["contract-check"],
				},
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 3, on_exhausted: "failed" },
				intervention: {
					choices: [
						{ choice_id: "go", label: "Approve", route: "approve" },
						{ choice_id: "redo", label: "Revise", route: "reject" },
					],
					require_route: true,
				},
			},
			{
				node_id: "merge",
				persona: "skilled",
				sub_task: "SENTINEL_MERGE_SUBTASK",
				depends_on: ["check", "review"],
				join_policy: "allow_partial",
			},
		],
	};

	const fac = ops({ action: "publish", name: "node-cfg-fac", draft, sessionModel });

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${encodeURIComponent(fac.factory_id)}/inspect`);
			assert.equal(res.status, 200);
			const bodyText = await res.text();
			for (const sentinel of [
				f.root, f.cwd, f.home, statePath, coordinationPath,
				"SENTINEL_NODE_CFG_PROMPT", "SENTINEL_CMD_SUBTASK", "SENTINEL_BUILD_SUBTASK",
				"SENTINEL_CHECK_SUBTASK", "SENTINEL_REVIEW_SUBTASK", "SENTINEL_MERGE_SUBTASK", "Exact persona",
			]) {
				assert.equal(bodyText.includes(sentinel), false, `node configuration leaked sentinel/path: ${sentinel}`);
			}
			const snap = JSON.parse(bodyText);
			assert.equal(snap.definition.limits.task_timeout_ms, 30_000);
			const byId = new Map<string, any>(snap.definition.nodes.map((n: any) => [n.id, n]));

			const prep = byId.get("prep");
			assert.equal(prep.kind, "command");
			assert.match(prep.kind_explanation, /command/i);
			assert.equal(prep.persona.absence, "not applicable");
			assert.equal(prep.model.absence, "not applicable");
			assert.equal("working_directory" in prep.command, false);
			assert.equal(prep.command.working_directory, undefined);
			assert.deepEqual(Object.keys(prep.command).sort(), ["args", "executable", "explanation"]);
			assert.equal(prep.command.executable, process.execPath);
			assert.deepEqual(prep.command.args, ["-e", "process.exit(0)"]);
			assert.equal(prep.policies.tools.absence, "not applicable");
			assert.equal(prep.policies.skills.absence, "not applicable");
			assert.equal(prep.policies.extensions.absence, "not applicable");
			assert.equal(prep.policies.dependency.absence, "not applicable");
			assert.equal(prep.policies.join.absence, "not applicable");
			assert.equal(prep.policies.intervention.absence, "not applicable");
			assert.equal(prep.dependencies.absence, "not applicable");
			assert.equal(prep.join.absence, "not applicable");
			assert.equal(prep.decision.absence, "not applicable");
			assert.equal(prep.feedback_target.absence, "not applicable");
			assert.equal(prep.required_checks.absence, "no records");
			assert.equal(prep.limits.task_timeout_ms.value, 30_000);
			assert.equal(prep.limits.task_timeout_ms.inherited, true);
			assert.equal(prep.limits.dependency_wait_timeout_ms.absence, "not applicable");

			const build = byId.get("build");
			assert.equal(build.kind, "agent");
			assert.equal(build.persona.name, "builder");
			assert.equal(build.model.id, "test-provider/test-model");
			assert.equal(build.model.thinking, "medium");
			assert.equal(build.command.absence, "not applicable");
			assert.equal(build.policies.tools.mode, "declared");
			assert.deepEqual(build.policies.tools.names, ["read", "bash"]);
			assert.equal(build.policies.skills.mode, "inherit");
			assert.equal(build.policies.skills.names.absence, "not applicable");
			assert.equal(build.policies.extensions.mode, "inherit_with_additions");
			assert.equal(build.policies.extensions.declared.absence, "no records");
			assert.equal(build.policies.dependency.policy, "require_success");
			assert.equal(build.policies.intervention.absence, "not applicable");
			assert.deepEqual(build.dependencies.items.map((d: any) => d.node_id), ["prep"]);
			assert.deepEqual(build.required_checks.items, ["lint"]);
			assert.equal(build.limits.task_timeout_ms.value, 15_000);
			assert.equal(build.limits.task_timeout_ms.inherited, false);
			assert.equal(build.limits.dependency_wait_timeout_ms.value, 45_000);
			assert.equal(build.limits.dependency_wait_timeout_ms.inherited, true);

			const check = byId.get("check");
			assert.equal(check.policies.tools.mode, "inherit");
			assert.equal(check.policies.tools.names.absence, "not applicable");
			assert.equal(check.policies.skills.mode, "declared");
			assert.equal(check.policies.skills.names.absence, "no records");
			assert.deepEqual(check.required_checks.items, ["unit"]);
			assert.equal(check.limits.task_timeout_ms.value, 30_000);
			assert.equal(check.limits.task_timeout_ms.inherited, true);

			const review = byId.get("review");
			assert.equal(review.decision.field, "verdict");
			assert.equal(review.decision.approve, "approve");
			assert.equal(review.decision.reject, "revise");
			assert.equal(review.decision.feedback_target, "build");
			assert.deepEqual(review.decision.loop_body, ["build", "review"]);
			assert.equal(review.decision.max_revisions, 3);
			assert.equal(review.decision.on_exhausted, "failed");
			assert.equal(review.feedback_target.node_id, "build");
			assert.equal(review.policies.intervention.enabled, true);
			assert.equal(review.policies.intervention.require_route, true);
			assert.deepEqual(review.required_checks.items, ["contract-check"]);

			const merge = byId.get("merge");
			assert.deepEqual(merge.dependencies.items.map((d: any) => d.node_id), ["check", "review"]);
			assert.equal(merge.join.policy, "allow_partial");
			assert.deepEqual(merge.join.sources.map((s: any) => s.node_id), ["check", "review"]);
			assert.equal(merge.policies.join.policy, "allow_partial");
			assert.equal(merge.policies.skills.mode, "declared");
			assert.deepEqual(merge.policies.skills.names, ["skill-a", "skill-b"]);
			assert.deepEqual(merge.policies.extensions.declared, ["coms"]);
		},
	);
});

test("Inspect operation evidence, 3-way typed absence, sentinel leak scan, coordination hot-journal, and guard negative tests", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const sentinelExtDir = join(f.cwd, "extensions", "SENTINEL_EXT_PATH");
	mkdirSync(sentinelExtDir, { recursive: true });
	const sentinelExtPath = join(sentinelExtDir, "custom-ext.ts");
	writeFileSync(sentinelExtPath, "export default function () {}\n");
	writeFileSync(
		join(f.cwd, ".pi", "agents", "builder.md"),
		`---\nname: builder\ntools: read,bash\nextensions: ${sentinelExtPath}\n---\nSENTINEL_PERSONA_SYSTEM_PROMPT\n`,
	);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const viewerEnv = { PATH: join(f.root, "bin") };

	const sentinels = [
		"SENTINEL_RAW_PROMPT_TASK",
		"SENTINEL_RAW_GOAL",
		"SENTINEL_NODE_SUBTASK",
		"SENTINEL_PERSONA_SYSTEM_PROMPT",
		"SENTINEL_FULL_INPUT_BRIEF",
		"SENTINEL_EXT_PATH",
		f.root,
		f.cwd,
		statePath,
		coordinationPath,
	];

	const assertNoLeaks = (bodyText: string, label: string) => {
		for (const sentinel of sentinels) {
			assert.equal(bodyText.includes(sentinel), false, `${label} leaked sentinel/path: ${sentinel}`);
		}
	};

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_RAW_PROMPT_TASK",
		goal: "SENTINEL_RAW_GOAL",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "SENTINEL_NODE_SUBTASK" },
			{
				node_id: "review",
				persona: "reviewer",
				sub_task: "SENTINEL_NODE_SUBTASK_REVIEW",
				depends_on: ["build"],
				output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
			},
		],
	};

	const unm = ops({ action: "publish", name: "op-unmanaged", draft: draftV1, sessionModel });
	const emptyManaged = ops({ action: "publish", name: "op-empty-managed", draft: draftV1, sessionModel });
	const activeFac = ops({ action: "publish", name: "op-active", draft: draftV1, sessionModel });

	const authEmpty = createManagerAuthority({ pi_session_id: "sess-empty" });
	ops({ action: "resume", factory_id: emptyManaged.factory_id, authority: authEmpty });
	revokeManagerAuthority(authEmpty);

	const authActive = createManagerAuthority({ pi_session_id: "sess-active" });
	ops({ action: "resume", factory_id: activeFac.factory_id, authority: authActive });
	ops({ action: "submit", factory_id: activeFac.factory_id, authority: authActive, reference: "ref-v1-run", brief: "SENTINEL_FULL_INPUT_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: activeFac.factory_id, authority: authActive });
	// Publish v2 and submit a queued v2 input while v1 run is still released and holding capacity.
	ops({ action: "update", factory_id: activeFac.factory_id, authority: authActive, draft: { ...draftV1, task: "SENTINEL_RAW_PROMPT_TASK_V2" }, sessionModel });
	ops({ action: "submit", factory_id: activeFac.factory_id, authority: authActive, reference: "ref-v2-queued", brief: "SENTINEL_FULL_INPUT_BRIEF_V2" });

	// 1. Check "not applicable" (unmanaged), "no records" (managed empty), and active released run + bound versions + admission + leak scan.
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const unmRes = await fetch(`${viewer.url}/api/factories/${unm.factory_id}/inspect`);
			const unmText = await unmRes.text();
			assertNoLeaks(unmText, "unmanaged");
			const unmJson = JSON.parse(unmText);
			assert.equal(unmJson.operation_evidence.attempts.absence, "not applicable");
			assert.equal(unmJson.operation_evidence.admission.absence, "not applicable");
			assert.equal(unmJson.operation_evidence.bound_versions.absence, "not applicable");
			assert.equal(unmJson.operation_evidence.requests.absence, "not applicable");
			assert.equal(unmJson.operation_evidence.proposals.absence, "not applicable");
			assert.equal(unmJson.operation_evidence.attention.absence, "not applicable");

			const emptyRes = await fetch(`${viewer.url}/api/factories/${emptyManaged.factory_id}/inspect`);
			const emptyText = await emptyRes.text();
			assertNoLeaks(emptyText, "managed empty");
			const emptyJson = JSON.parse(emptyText);
			assert.equal(emptyJson.operation_evidence.attempts.absence, "no records");
			assert.equal(emptyJson.operation_evidence.admission.absence, "no records");
			assert.equal(emptyJson.operation_evidence.bound_versions.absence, "no records");
			assert.equal(emptyJson.operation_evidence.requests.absence, "no records");
			assert.equal(emptyJson.operation_evidence.proposals.absence, "no records");
			assert.equal(emptyJson.operation_evidence.attention.absence, "no records");

			const activeRes = await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/inspect`);
			const activeText = await activeRes.text();
			assertNoLeaks(activeText, "active released");
			const activeJson = JSON.parse(activeText);
			assert.equal(activeJson.current_version, "v2");
			assert.equal(activeJson.operation_evidence.admission.count, 2);
			assert.equal(activeJson.operation_evidence.admission.detail_view, "queue");
			assert.match(activeJson.operation_evidence.admission.detail_url, /\/queue$/);
			assert.equal(activeJson.operation_evidence.admission.items[0].reference, "ref-v1-run");
			assert.equal(activeJson.operation_evidence.admission.items[0].bound_version, "v1");
			assert.match(activeJson.operation_evidence.admission.items[0].detail_url, /\/receipts\?reference=ref-v1-run$/);
			assert.equal(activeJson.operation_evidence.bound_versions.count, 2);
			const bv1 = activeJson.operation_evidence.bound_versions.items.find((b: any) => b.version === "v1");
			assert.equal(bv1.matches_current, false);
			assert.equal(bv1.attempt_count, 1);
			assert.equal(bv1.retained_evidence, "available");
			assert.equal(bv1.absence, undefined);
			assert.equal(activeJson.operation_evidence.attempts.count, 1);
			const att = activeJson.operation_evidence.attempts.items[0];
			assert.equal(att.attempt_id, launched.attempt_id);
			assert.equal(att.bound_version, "v1");
			assert.equal(att.state, "released");
			assert.match(att.state_explanation, /released/i);
			assert.equal(att.settlement.absence, "no records");
			assert.match(att.settlement.explanation, /in-flight/i);
			assert.equal(att.uncertainty.absence, "no records");
			assert.equal(att.clearance.eligible, false);
			assert.equal(att.receipt.detail_view, "receipts");
			assert.match(att.receipt.detail_url, /\/receipts\?reference=ref-v1-run$/);
			assert.equal(activeJson.operation_evidence.capacity.detail_view, "queue");
			assert.equal(activeJson.operation_evidence.requests.detail_view, "requests");
			assert.equal(activeJson.operation_evidence.proposals.detail_view, "proposals");

			// Guard negative checks on HTTP seam.
			assert.equal((await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/inspect?version=bad`)).status, 400);
			assert.equal((await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/inspect?extra=1`)).status, 400);
			assert.equal((await fetch(`${viewer.url}/api/factories/missing-factory/inspect`)).status, 404);
			assert.equal((await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/inspect`, { method: "POST" })).status, 405);
		},
	);

	// 2. Drive run through revision + approval + settle + pending proposal, then verify settled attempt + proposal + attention!
	const buildCfg = launched.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = launched.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const buildW = workerFromConfig(t, join(launched.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } });
	const reviewW = workerFromConfig(t, join(launched.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } });
	await buildW.start();
	await reviewW.start();
	await buildW.beforeStart();
	await reviewW.beforeStart();
	await buildW.complete({ status: "success", summary: "v1 built", detail: "done" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "Needs fix", detail: "revise", outputs: { verdict: "revise" } });
	await buildW.beforeStart(notification(reviewW, buildW));
	await buildW.deliverFollowUps();
	await buildW.complete({ status: "success", summary: "v2 built", detail: "fixed" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "LGTM", detail: "approved", outputs: { verdict: "approve" } });
	const settled = await ops({ action: "settle_run", factory_id: activeFac.factory_id, authority: authActive });
	assert.equal(settled.settled, true, settled.reason);
	ops({
		action: "propose_constraint",
		factory_id: activeFac.factory_id,
		authority: authActive,
		text: "Run lint before review",
		run_id: launched.task_id,
		attempt_id: `${reviewCfg.instance_id}.2`,
		evidence_ref: `result:${reviewCfg.instance_id}.2`,
	});
	revokeManagerAuthority(authActive);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const settledRes = await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/inspect`);
			const settledText = await settledRes.text();
			assertNoLeaks(settledText, "settled with proposal");
			const settledJson = JSON.parse(settledText);
			const settledAtt = settledJson.operation_evidence.attempts.items.find((a: any) => a.attempt_id === launched.attempt_id);
			assert.equal(settledAtt.state, "settled");
			assert.equal(settledAtt.settlement.outcome, "succeeded");
			assert.equal(settledAtt.settlement.execution_settlement, "settled");
			assert.equal(settledAtt.settlement.capacity_release, "released");
			assert.equal(settledAtt.clearance.absence, "not applicable");
			assert.equal(settledJson.operation_evidence.proposals.count, 1);
			assert.equal(settledJson.operation_evidence.proposals.pending_count, 1);
			const propAttn = settledJson.attention_summary.attention.items.find((item: any) => item.kind === "constraint_proposal");
			assert.ok(propAttn);
			assert.equal(propAttn.label, "Constraint proposal");
			assert.equal(propAttn.detail_view, "proposals");
			assert.equal(propAttn.detail_url, `/api/factories/${activeFac.factory_id}/proposals`);
			assert.equal(propAttn.explanation, "A learned-constraint proposal is pending human confirmation in Pi.");
		},
	);

	// 3. Operator clearance fixture -> clearance shown separately from settlement.
	{
		const fClear = serviceFixture(t, ["builder"]);
		const cState = join(fClear.root, "factories.sqlite");
		const cCoord = join(fClear.root, "coord.sqlite");
		const cOps = factoryOperations(cState, fClear.service, { coordinationPath: cCoord });
		const cFac = cOps({
			action: "publish",
			name: "clear-fac",
			draft: { project_cwd: fClear.cwd, topology: "graph", task: "SENTINEL_CLEAR_PROMPT", agents: [{ node_id: "build", persona: "builder", sub_task: "SENTINEL_CLEAR_SUB" }] },
			sessionModel,
		});
		const cAuth = createManagerAuthority({ pi_session_id: "sess-clear" });
		cOps({ action: "resume", factory_id: cFac.factory_id, authority: cAuth });
		cOps({ action: "submit", factory_id: cFac.factory_id, authority: cAuth, reference: "ref-clear", brief: "SENTINEL_CLEAR_BRIEF" });
		const cRun = await cOps({ action: "launch", factory_id: cFac.factory_id, authority: cAuth });
		const cDir = join(fClear.cwd, ".pi", "agent-sessions", cRun.task_id);
		const cfgFile = readdirSync(cDir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
		const w = workerFromConfig(t, join(cDir, cfgFile), { model: { provider: "test-provider", id: "test-model" } });
		await w.start();
		await w.beforeStart();
		await w.complete({ status: "failure", summary: "Failed", detail: "err" });
		const db = new DatabaseSync(cState);
		try {
			const row = db.prepare("SELECT * FROM factory_inputs").get() as any;
			const next = buildInputRow({ ...row, disposition: "blocked" });
			db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, row.input_id);
		} finally { db.close(); }
		const cleared = await cOps({
			action: "clear_hold",
			factory_id: cFac.factory_id,
			input_id: cRun.input_id,
			attempt_id: cRun.attempt_id,
			task_id: cRun.task_id,
			authority: cAuth,
			confirm: async () => ({
				reason: "Operator stopped process",
				evidence: "Verified exited",
				acknowledged_unknown_effects: true,
			} satisfies ClearanceDecision),
		});
		assert.equal(cleared.cleared, true);
		revokeManagerAuthority(cAuth);

		await verifyReadOnlyViewer(
			{ stateDirs: fClear.root, viewerOptions: { statePath: cState, coordinationPath: cCoord, env: { PATH: join(fClear.root, "bin") }, home: fClear.home } },
			async viewer => {
				const clearRes = await fetch(`${viewer.url}/api/factories/${cFac.factory_id}/inspect`);
				const clearText = await clearRes.text();
				assertNoLeaks(clearText, "cleared attempt");
				const clearJson = JSON.parse(clearText);
				const clearedAtt = clearJson.operation_evidence.attempts.items[0];
				assert.equal(clearedAtt.state, "cleared");
				assert.equal(clearedAtt.clearance.cleared, true);
				assert.equal(clearedAtt.clearance.acknowledged_unknown_effects, true);
				assert.match(clearedAtt.clearance.explanation, /cleared by operator/i);
				assert.equal(clearedAtt.settlement.capacity_release, "released");
			},
		);
	}

	// 4. Corrupt controls, requests, and proposals -> "evidence unavailable" on stop_state, requests, proposals, damaged_records, and attention.
	{
		const db = new DatabaseSync(statePath);
		try {
			db.prepare("INSERT OR REPLACE INTO factory_controls (factory_id, stopped, updated_at, record_digest) VALUES (?, 1, ?, 'bad-digest')").run(emptyManaged.factory_id, new Date().toISOString());
			db.prepare("INSERT INTO factory_requests (request_id, factory_id, input_id, attempt_id, task_id, node_id, node_attempt_id, question, reason, created_at, evidence, choices, state, response, responded_at, consumed_at, record_digest) VALUES ('req-bad', ?, 'in-1', 'att-1', 't-1', 'build', 'a1', 'q', 'r', '2026-01-01T00:00:00Z', '[]', '[]', 'pending', NULL, NULL, NULL, 'bad-digest')").run(emptyManaged.factory_id);
			db.prepare("UPDATE factory_constraint_proposals SET record_digest = 'bad-digest' WHERE factory_id = ?").run(activeFac.factory_id);
			db.prepare("UPDATE factory_versions SET definition = '{corrupt-v1' WHERE factory_id = ? AND version = 'v1'").run(activeFac.factory_id);
		} finally { db.close(); }
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const dmgEmpty = await getInspect(viewer.url, emptyManaged.factory_id);
			assertNoLeaks(JSON.stringify(dmgEmpty), "corrupt controls and requests");
			assert.equal(dmgEmpty.evidence, "uncertain");
			assert.equal(dmgEmpty.attention_summary.stop_state.absence, "evidence unavailable");
			assert.equal(dmgEmpty.operation_evidence.requests.absence, "evidence unavailable");
			assert.ok(dmgEmpty.damaged_records.items.some((d: any) => d.scope === "stop_control"));
			assert.ok(dmgEmpty.damaged_records.items.some((d: any) => d.scope === "requests"));

			const dmgActive = await getInspect(viewer.url, activeFac.factory_id);
			assertNoLeaks(JSON.stringify(dmgActive), "corrupt proposals");
			assert.equal(dmgActive.evidence, "uncertain");
			assert.equal(dmgActive.operation_evidence.proposals.absence, "evidence unavailable");
			assert.ok(dmgActive.damaged_records.items.some((d: any) => d.scope === "proposals"));
			const dmgBv1 = dmgActive.operation_evidence.bound_versions.items.find((b: any) => b.version === "v1");
			assert.equal(dmgBv1.retained_evidence, "unavailable");
			assert.equal(dmgBv1.absence, "evidence unavailable");
			assert.equal(dmgBv1.explanation, "Bound version v1 record is missing or damaged.");
		},
	);

	// 5. Hot-journal on coordination DB -> evidence unavailable with zero recovery.
	{
		const fCoordHot = serviceFixture(t, ["builder"]);
		const chState = join(fCoordHot.root, "factories.sqlite");
		const chCoord = join(fCoordHot.root, "factory-coordination.sqlite");
		const chOps = factoryOperations(chState, fCoordHot.service, { coordinationPath: chCoord });
		const chFac = chOps({ action: "publish", name: "coord-hot", draft: { project_cwd: fCoordHot.cwd, topology: "graph", task: "Coord hot", agents: [{ node_id: "b", persona: "builder", sub_task: "work" }] }, sessionModel });
		const script = `
			import { DatabaseSync } from "node:sqlite";
			const db = new DatabaseSync(process.argv[1]);
			db.exec("PRAGMA journal_mode = DELETE; PRAGMA user_version = 2; CREATE TABLE coord_meta(id INTEGER PRIMARY KEY, anchor_id TEXT, created_at TEXT, record_digest TEXT); CREATE TABLE checkout_holds(x TEXT); CREATE TABLE managed_runs(x TEXT);");
			db.exec("BEGIN IMMEDIATE;");
			db.prepare("INSERT INTO checkout_holds VALUES (?)").run("x".repeat(3 * 1024 * 1024));
			process.kill(process.pid, "SIGKILL");
		`;
		const killed = await runSupervised(process.execPath, ["--input-type=module", "-e", script, chCoord], { timeoutMs: 10_000 });
		assert.equal(killed.signal, "SIGKILL", killed.stderr);
		assert.equal(existsSync(`${chCoord}-journal`), true);

		await verifyReadOnlyViewer(
			{ stateDirs: fCoordHot.root, viewerOptions: { statePath: chState, coordinationPath: chCoord, env: { PATH: join(fCoordHot.root, "bin") }, home: fCoordHot.home } },
			async viewer => {
				const snap = await getInspect(viewer.url, chFac.factory_id);
				assert.equal(snap.evidence, "unavailable");
				assert.equal(snap.absence, "evidence unavailable");
			},
		);
		assert.equal(existsSync(`${chCoord}-journal`), true);
	}

	// 6. Negative guard probe on publicInspect(undefined, ...).
	const unavail = publicInspect(undefined, "fac_guard");
	assert.equal(unavail.evidence, "unavailable");
	assert.equal(unavail.absence, "evidence unavailable");
});

test("Inspect surfaces uncertain capacity, blocking hold, attempt, node counts, missing admission, and unmanaged attention without modifying bytes", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const viewerEnv = { PATH: join(f.root, "bin") };

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_UNCERTAIN_PROMPT",
		agents: [{ node_id: "build", persona: "builder", sub_task: "SENTINEL_UNCERTAIN_SUBTASK" }],
	};

	const unmFac = ops({ action: "publish", name: "unc-unmanaged", draft, sessionModel });
	const uncFac = ops({ action: "publish", name: "unc-managed", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-unc" });
	ops({ action: "resume", factory_id: uncFac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: uncFac.factory_id, authority: auth, reference: "ref-unc", brief: "SENTINEL_UNCERTAIN_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: uncFac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	// Damage coordination continuity + remove holds/managed_runs + corrupt upstream-index.json.
	writeFileSync(join(f.cwd, ".pi", "agent-sessions", launched.task_id, "upstream-index.json"), "{corrupt");
	{
		const coordDb = new DatabaseSync(coordinationPath);
		try {
			coordDb.prepare("UPDATE coord_meta SET record_digest = 'bad-digest' WHERE id = 1").run();
			coordDb.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(uncFac.factory_id);
			coordDb.prepare("DELETE FROM managed_runs WHERE factory_id = ?").run(uncFac.factory_id);
		} finally { coordDb.close(); }

		const stateDb = new DatabaseSync(statePath);
		try {
			stateDb.prepare("DELETE FROM factory_holds WHERE factory_id = ?").run(uncFac.factory_id);
		} finally { stateDb.close(); }
	}

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, uncFac.factory_id);
			assert.equal(snap.evidence, "uncertain");
			assert.equal(snap.capacity.factory_slot.state, "uncertain");
			assert.equal(snap.capacity.factory_slot.absence, "evidence unavailable");
			assert.equal(snap.capacity.checkout_slot.state, "uncertain");
			assert.equal(snap.capacity.checkout_slot.absence, "evidence unavailable");
			assert.equal(snap.capacity.blocking_hold.absence, "evidence unavailable");
			assert.equal(snap.uncertainty.absence, "evidence unavailable");
			assert.equal(snap.uncertainty.evidence, "unavailable");

			assert.ok(snap.damaged_records.items.some((d: any) => d.scope === "launch_or_capacity" && d.absence === "evidence unavailable"));
			assert.ok(snap.damaged_records.items.some((d: any) => d.scope === "attempt" && d.attempt_id === launched.attempt_id && d.absence === "evidence unavailable"));
			assert.ok(snap.damaged_records.items.some((d: any) => d.scope === "attempt_node_counts" && d.attempt_id === launched.attempt_id && d.absence === "evidence unavailable"));

			const att = snap.operation_evidence.attempts.items[0];
			assert.equal(att.uncertainty.absence, "evidence unavailable");
			assert.ok(att.uncertainty.count >= 1);

			const uncAttn = snap.attention_summary.attention.items.find((item: any) => item.kind === "uncertain");
			assert.ok(uncAttn);
			assert.equal(uncAttn.detail_view, "queue");
			assert.equal(uncAttn.detail_url, `/api/factories/${uncFac.factory_id}/queue`);
			assert.equal(uncAttn.explanation, "Factory, run, or capacity evidence could not be fully verified and requires review in Pi.");

			const noticeAttn = snap.attention_summary.attention.items.find((item: any) => item.kind === "report_notice");
			assert.ok(noticeAttn);
			assert.equal(noticeAttn.detail_view, "queue");
			assert.equal(noticeAttn.detail_url, `/api/factories/${uncFac.factory_id}/queue`);
			assert.equal(noticeAttn.explanation, "Per-node attempt or rollback count evidence for a run could not be verified.");

			// Unmanaged factory sharing the damaged coordination store still lands uncertain evidence in attention.
			const unm = await getInspect(viewer.url, unmFac.factory_id);
			assert.equal(unm.attention_summary.management.state, "unmanaged");
			assert.equal(unm.evidence, "uncertain");
			assert.equal(unm.capacity.checkout_slot.state, "uncertain");
			assert.equal(unm.capacity.checkout_slot.absence, "evidence unavailable");
			assert.equal(unm.capacity.blocking_hold.absence, "evidence unavailable");
			assert.equal(unm.uncertainty.absence, "evidence unavailable");
			assert.ok(unm.damaged_records.items.some((d: any) => d.scope === "launch_or_capacity" && d.absence === "evidence unavailable"));
			assert.ok(unm.attention_summary.attention.count >= 1);
			assert.equal(unm.attention_summary.attention.items[0].kind, "uncertain");
			assert.equal(unm.attention_summary.attention.items[0].detail_view, "queue");
			assert.equal(unm.attention_summary.attention.items[0].detail_url, `/api/factories/${unmFac.factory_id}/queue`);
			assert.equal(unm.attention_summary.attention.items[0].explanation, "Factory, run, or capacity evidence could not be fully verified and requires review in Pi.");
		},
	);

	// Missing admitted input record for an attempt -> per-attempt admission/receipt report "evidence unavailable".
	{
		const missingInputFac = ops({ action: "publish", name: "missing-input-fac", draft, sessionModel });
		const mAuth = createManagerAuthority({ pi_session_id: "sess-missing-input" });
		ops({ action: "resume", factory_id: missingInputFac.factory_id, authority: mAuth });
		revokeManagerAuthority(mAuth);
		const stateDb = new DatabaseSync(statePath);
		try {
			const row = stateDb.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(launched.attempt_id) as any;
			const foreignAtt = buildAttemptRow({
				...row,
				attempt_id: "att_missing_input",
				factory_id: missingInputFac.factory_id,
				request_id: "req_missing_input",
				task_id: "task_missing_input",
			});
			stateDb.prepare(
				`INSERT INTO factory_attempts (
					attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key,
					state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				foreignAtt.attempt_id, foreignAtt.factory_id, foreignAtt.input_id, foreignAtt.bound_version, foreignAtt.request_id, foreignAtt.task_id,
				foreignAtt.canonical_checkout, foreignAtt.checkout_key, foreignAtt.state, foreignAtt.release_authorized, foreignAtt.release_authorized_at,
				foreignAtt.release_token_digest, foreignAtt.release_nonce_digest, foreignAtt.error, foreignAtt.created_at, foreignAtt.updated_at, foreignAtt.record_digest,
			);
		} finally { stateDb.close(); }
		await verifyReadOnlyViewer(
			{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
			async viewer => {
				const snap = await getInspect(viewer.url, missingInputFac.factory_id);
				const att = snap.operation_evidence.attempts.items[0];
				assert.equal(att.admission.absence, "evidence unavailable");
				assert.equal(att.receipt.absence, "evidence unavailable");
			},
		);
	}

	// Bad record_digest on checkout_holds in an isolated coordination DB fails closed to evidence unavailable without touching bytes.
	{
		const fHold = serviceFixture(t, ["builder"]);
		const hState = join(fHold.root, "factories.sqlite");
		const hCoord = join(fHold.root, "factory-coordination.sqlite");
		const hOps = factoryOperations(hState, fHold.service, { coordinationPath: hCoord });
		const hFac = hOps({ action: "publish", name: "bad-hold", draft: { project_cwd: fHold.cwd, topology: "graph", task: "Bad hold", agents: [{ node_id: "build", persona: "builder", sub_task: "work" }] }, sessionModel });
		const hAuth = createManagerAuthority({ pi_session_id: "sess-bad-hold" });
		hOps({ action: "resume", factory_id: hFac.factory_id, authority: hAuth });
		hOps({ action: "submit", factory_id: hFac.factory_id, authority: hAuth, reference: "ref-hold", brief: "work" });
		const hRun = await hOps({ action: "launch", factory_id: hFac.factory_id, authority: hAuth });
		revokeManagerAuthority(hAuth);
		const coordDb = new DatabaseSync(hCoord);
		try {
			coordDb.prepare("UPDATE checkout_holds SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE task_id = ?").run(hRun.task_id);
		} finally { coordDb.close(); }
		await verifyReadOnlyViewer(
			{ stateDirs: fHold.root, viewerOptions: { statePath: hState, coordinationPath: hCoord, env: { PATH: join(fHold.root, "bin") }, home: fHold.home } },
			async viewer => {
				const snap = await getInspect(viewer.url, hFac.factory_id);
				assert.equal(snap.evidence, "unavailable");
				assert.equal(snap.absence, "evidence unavailable");
			},
		);
	}
});

test("Inspect reports pending and uncertain direction request counts and attention", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const choices = [{ choice_id: "proceed", label: "Proceed" }];
	const fac = ops({
		action: "publish",
		name: "req-fac",
		draft: {
			project_cwd: f.cwd,
			topology: "graph",
			task: "SENTINEL_REQ_PROMPT",
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "SENTINEL_REQ_BUILD", intervention: { choices } },
				{ node_id: "docs", persona: "builder", sub_task: "SENTINEL_REQ_DOCS", intervention: { choices } },
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "sess-req" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-req", brief: "SENTINEL_REQ_BRIEF" });
	const run = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const buildCfg = run.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const docsCfg = run.manifest.pane_manifest.find(m => m.node_id === "docs")!;
	const receiver = {
		instance_id: buildCfg.instance_id,
		run_token: run.manifest.token,
		session_id: `session-${buildCfg.instance_id}`,
		incarnation: "inc-req",
		pid: process.pid,
		...directionProcess(process.pid),
	};
	const db = openRequestDatabase(statePath);
	try {
		inTransaction(db, () => {
			// 1. Cancelled request on docs.1 (terminated -> reconciliation: "cancelled").
			createRequest(db, {
				factory_id: fac.factory_id,
				input_id: run.input_id,
				attempt_id: run.attempt_id,
				task_id: run.task_id,
				node_id: "docs",
				node_attempt_id: `${docsCfg.instance_id}.1`,
				question: "SENTINEL_REQ_Q3",
				reason: "SENTINEL_REQ_R3",
				choices: ["proceed"],
			}, { ...receiver, instance_id: docsCfg.instance_id, session_id: `session-${docsCfg.instance_id}` });
			terminateNodeRequests(db, run.attempt_id, "docs", "cancelled");

			// 2. Responded-but-unconsumed request on docs.2 (state: "responded", reconciliation: "uncertain").
			const responded = createRequest(db, {
				factory_id: fac.factory_id,
				input_id: run.input_id,
				attempt_id: run.attempt_id,
				task_id: run.task_id,
				node_id: "docs",
				node_attempt_id: `${docsCfg.instance_id}.2`,
				question: "SENTINEL_REQ_Q2",
				reason: "SENTINEL_REQ_R2",
				choices: ["proceed"],
			}, { ...receiver, instance_id: docsCfg.instance_id, session_id: `session-${docsCfg.instance_id}` });
			recordResponse(db, responded.request_id, fac.factory_id, { kind: "choice", choice_id: "proceed" }, { incarnation_id: "inc-mgr", pi_session_id: "sess-req" });

			// 3. Pending request on build.1 (state: "pending", reconciliation: "uncertain").
			createRequest(db, {
				factory_id: fac.factory_id,
				input_id: run.input_id,
				attempt_id: run.attempt_id,
				task_id: run.task_id,
				node_id: "build",
				node_attempt_id: `${buildCfg.instance_id}.1`,
				question: "SENTINEL_REQ_Q1",
				reason: "SENTINEL_REQ_R1",
				choices: ["proceed"],
			}, receiver);
		});
	} finally { db.close(); }

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			const reqSummary = snap.operation_evidence.requests;
			assert.equal(reqSummary.count, 3);
			assert.equal(reqSummary.pending_count, 1);
			assert.equal(reqSummary.uncertain_count, 2);
			assert.equal(reqSummary.explanation, "3 request(s) recorded (1 pending, 2 uncertain).");
			assert.equal(reqSummary.detail_view, "requests");
			assert.equal(reqSummary.detail_url, `/api/factories/${fac.factory_id}/requests`);
			const intAttn = snap.attention_summary.attention.items.find((item: any) => item.kind === "intervention");
			assert.ok(intAttn);
			assert.equal(intAttn.label, "Direction or exhaustion request");
			assert.equal(intAttn.detail_view, "requests");
			assert.equal(intAttn.detail_url, `/api/factories/${fac.factory_id}/requests`);
			assert.equal(intAttn.explanation, "A node or review loop is waiting for human direction or exhaustion review in Pi.");
		},
	);
});

test("Inspect marks settlement as not applicable for unauthorized pre-release attempts", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const failingService = new BootstrapService({
		exec: async (_command, args) => {
			if (args[0] === "tab" && args[1] === "create") {
				return { code: 1, stdout: "", stderr: "tab create failed before release" };
			}
			return { code: 0, stdout: JSON.stringify({ result: { pane: { workspace_id: "w" }, workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] } }), stderr: "" };
		},
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: join(f.root, "state-fail"),
		home: f.home,
		env: { PATH: join(f.root, "bin"), HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	const ops = factoryOperations(statePath, failingService, { coordinationPath });
	const fac = ops({
		action: "publish",
		name: "fail-prerelease",
		draft: { project_cwd: f.cwd, topology: "graph", task: "Pre-release fail", agents: [{ node_id: "build", persona: "builder", sub_task: "work" }] },
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "sess-fail" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-fail", brief: "work" });
	await assert.rejects(() => ops({ action: "launch", factory_id: fac.factory_id, authority: auth }), /tab create failed before release/);
	revokeManagerAuthority(auth);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			const att = snap.operation_evidence.attempts.items[0];
			assert.equal(att.release_authorized, false);
			assert.equal(att.state, "proven_not_released");
			assert.equal(att.settlement.absence, "not applicable");
			assert.equal(att.settlement.explanation, "Settlement applies only after a launch is authorized for release.");
		},
	);
});

test("Inspect honors viewer options.home for global bootstrap.json without consulting real home", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const fac = ops({
		action: "publish",
		name: "home-ceil-fac",
		draft: {
			project_cwd: f.cwd,
			topology: "graph",
			task: "Home ceiling check",
			agents: [
				{ node_id: "work", persona: "builder", sub_task: "Work" },
				{
					node_id: "review",
					persona: "builder",
					sub_task: "Review",
					depends_on: ["work"],
					output_contract: { properties: { v: { type: "string", enum: ["yes", "no"], required: true } } },
					decision: { field: "v", approve: "yes", reject: "no", on_reject: "work", max_revisions: 2 },
				},
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "sess-home" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-home", brief: "Brief" });
	revokeManagerAuthority(auth);

	const sentinelHome = join(f.root, "sentinel-home");
	mkdirSync(join(sentinelHome, ".pi", "agent"), { recursive: true });
	writeFileSync(join(sentinelHome, ".pi", "agent", "bootstrap.json"), JSON.stringify({ graph: { ceilings: { maxRevisions: 1 } } }));

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: sentinelHome } },
		async viewer => {
			const snap = await getInspect(viewer.url, fac.factory_id);
			assert.equal(snap.attention_summary.queue_head.eligible, false);
			assert.equal(snap.attention_summary.queue_head.blocking_kind, "ceiling");
			assert.equal(snap.attention_summary.queue_head.explanation, "The bound definition exceeds a configured revision or attempt ceiling.");
		},
	);
});
