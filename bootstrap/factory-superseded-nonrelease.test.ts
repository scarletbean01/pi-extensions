import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, type GenerateRequest } from "../factory/operations.ts";
import {
	attemptRecordDigest,
	buildInputRow,
	buildManagedRunRow,
	managerRecordDigest,
	sha256Hex,
	type StoredAttempt,
	type StoredInput,
	type StoredManagedRun,
} from "./factory-records.ts";
import { BootstrapService } from "./lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const sessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" as const };

function markManagerDead(dbPath: string, factoryId: string): string {
	const db = new DatabaseSync(dbPath);
	try {
		const m = db.prepare("SELECT * FROM factory_managers WHERE factory_id = ?").get(factoryId) as Record<string, any>;
		const deadPid = process.pid + 100000000;
		const parts = m.incarnation_id.split("|");
		const deadInc = `${parts[0]}|${parts[1]}|${deadPid}|1`;
		db.prepare("UPDATE factory_managers SET pid = ?, incarnation_id = ?, record_digest = ? WHERE factory_id = ?")
			.run(deadPid, deadInc, managerRecordDigest({ ...m, pid: deadPid, incarnation_id: deadInc } as never), factoryId);
		return deadInc;
	} finally {
		db.close();
	}
}

async function setupSupersededSettledFixture(t: test.TestContext) {
	const fix = serviceFixture(t, ["builder"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const draft: GenerateRequest = {
		topology: "graph",
		task: "Retry then settle",
		project_cwd: fix.cwd,
		agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }],
	};
	const fac = open()({ action: "publish", name: "retry-settle", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-first" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "r1", brief: "Brief 1", authority: auth });

	const failing = factoryOperations(dbPath, fix.service, {
		coordinationPath: coordPath,
		atLaunchCommit: phase => { if (phase === "release_before_commit") throw new Error("launch failed before release"); },
	});
	await assert.rejects(() => failing({ action: "launch", factory_id: fac.factory_id, authority: auth }), /failed before release/);
	const first = open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0]!;
	assert.equal(first.state, "failed_before_release");

	const deadInc = markManagerDead(dbPath, fac.factory_id);
	const auth2 = createManagerAuthority({ pi_session_id: "mgr-second" });
	open()({ action: "takeover", factory_id: fac.factory_id, authority: auth2, confirmed_manager_incarnation_id: deadInc });
	const proven = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(proven.attempts[0]!.state, "proven_not_released");
	assert.deepEqual(proven.uncertainty, []);

	const retried = await open()({
		action: "retry_launch",
		factory_id: fac.factory_id,
		authority: auth2,
		input_id: receipt.input_id,
		previous_attempt_id: first.attempt_id,
		confirmed: true,
	});
	assert.equal(retried.release_authorized, true);
	const cfg = fix.configs.at(-1)!;
	const build = workerFromConfig(t, join(retried.manifest.session_dir, `${cfg.instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await build.beforeStart();
	await build.complete({ status: "success", summary: "done", detail: "ok" });
	const settled = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth2 });
	assert.equal(settled.settled, true, settled.reason);
	return { fix, dbPath, coordPath, open, fac, receipt, first, retried, auth2, draft };
}

function readManagedRuns(coordPath: string): Array<{ task_id: string; attempt_id: string; factory_id: string }> {
	const coord = new DatabaseSync(coordPath, { readOnly: true });
	try {
		return coord.prepare("SELECT task_id, attempt_id, factory_id FROM managed_runs ORDER BY rowid ASC").all() as Array<{ task_id: string; attempt_id: string; factory_id: string }>;
	} finally {
		coord.close();
	}
}

function insertRun(coordPath: string, row: StoredManagedRun) {
	const coord = new DatabaseSync(coordPath);
	try {
		coord.prepare(
			`INSERT INTO managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(row.task_id, row.request_id_digest, row.factory_id, row.factory_name, row.factory_db_path, row.input_id, row.attempt_id, row.canonical_checkout, row.checkout_key, row.created_at, row.record_digest);
	} finally {
		coord.close();
	}
}

function attemptRow(dbPath: string, id: string): StoredAttempt {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(id) as StoredAttempt;
	} finally {
		db.close();
	}
}

function stuckRow(a: StoredAttempt, fac: { factory_id: string; name: string }, dbPath: string, over: Partial<StoredManagedRun> = {}) {
	return buildManagedRunRow({
		task_id: a.task_id,
		request_id_digest: sha256Hex(a.request_id),
		factory_id: fac.factory_id,
		factory_name: fac.name,
		factory_db_path: dbPath,
		input_id: a.input_id,
		attempt_id: a.attempt_id,
		canonical_checkout: a.canonical_checkout,
		checkout_key: a.checkout_key,
		created_at: a.created_at,
		...over,
	});
}

function updAttempt(dbPath: string, id: string, f: (r: StoredAttempt) => Partial<StoredAttempt>) {
	const db = new DatabaseSync(dbPath);
	try {
		const r = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(id) as StoredAttempt;
		const { record_digest: _d, ...rest } = { ...r, ...f(r) } as StoredAttempt;
		const dg = attemptRecordDigest(rest as never);
		db.prepare(
			"UPDATE factory_attempts SET state=?, release_authorized=?, release_authorized_at=?, release_token_digest=?, release_nonce_digest=?, error=?, created_at=?, bound_version=?, record_digest=? WHERE attempt_id=?",
		).run(rest.state, rest.release_authorized, rest.release_authorized_at, rest.release_token_digest, rest.release_nonce_digest, rest.error, rest.created_at, rest.bound_version, dg, id);
	} finally {
		db.close();
	}
}

function insertAttemptClone(dbPath: string, src: string, over: Partial<StoredAttempt>) {
	const db = new DatabaseSync(dbPath);
	try {
		const r = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(src) as StoredAttempt;
		const { record_digest: _d, ...rest } = { ...r, ...over } as StoredAttempt;
		const dg = attemptRecordDigest(rest as never);
		const cols = Object.keys(r);
		const vals = cols.map(c => c === "record_digest" ? dg : (rest as any)[c]);
		db.prepare(`INSERT INTO factory_attempts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
	} finally {
		db.close();
	}
}

async function takeoverAgain(dbPath: string, open: () => ReturnType<typeof factoryOperations>, fid: string, tag: string) {
	const deadInc = markManagerDead(dbPath, fid);
	const a = createManagerAuthority({ pi_session_id: tag });
	try {
		const res = open()({ action: "takeover", factory_id: fid, authority: a, confirmed_manager_incarnation_id: deadInc });
		return { authority: a, result: res };
	} catch {
		return { authority: a, result: undefined };
	}
}

async function assertStuckRowSurvivesTakeoverAndSettle(
	dbPath: string,
	coordPath: string,
	open: () => ReturnType<typeof factoryOperations>,
	fac: { factory_id: string; name: string },
	attemptId: string,
	tag: string,
	expectDiagnostic = true,
) {
	insertRun(coordPath, stuckRow(attemptRow(dbPath, attemptId), fac, dbPath));
	const { authority, result } = await takeoverAgain(dbPath, open, fac.factory_id, `survive-${tag}`);
	if (expectDiagnostic && result) {
		const diags = (result as { retirement_diagnostics?: Array<{ attempt_id: string; reason: string }> }).retirement_diagnostics;
		assert.ok(diags && diags.some(d => d.attempt_id === attemptId && d.reason.length > 0), `${tag}: expected retirement_diagnostics`);
	}
	try { await open()({ action: "settle_run", factory_id: fac.factory_id, authority }); } catch {}
	assert.equal(readManagedRuns(coordPath).filter(r => r.attempt_id === attemptId).length, 1, `${tag}: row must survive takeover and settle_run`);
}

test("pre-release failure -> takeover proof -> retry -> settle leaves inspect certain, managed_runs empty, old attempt ineligible, and next input launchable", async t => {
	const { fix, coordPath, open, fac, receipt, first, retried, auth2 } = await setupSupersededSettledFixture(t);

	assert.deepEqual(readManagedRuns(coordPath), [], "managed_runs must be empty after settle");
	const after = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(after.uncertainty, [], "a superseded proven_not_released attempt of a settled input must not make the factory uncertain");
	assert.equal(after.capacity.factory_slot, "free");
	assert.equal(after.capacity.checkout_slot, "free");

	const oldAttemptView = after.attempts.find(a => a.attempt_id === first.attempt_id)!;
	assert.equal(oldAttemptView.historical, true);
	assert.equal(oldAttemptView.retry_eligibility?.eligible, false);
	await assert.rejects(
		() => open()({ action: "retry_launch", factory_id: fac.factory_id, authority: auth2, input_id: receipt.input_id, previous_attempt_id: first.attempt_id, confirmed: true }),
		/Retry requires exact|launching|proven/i,
	);

	// Direct Bootstrap status on both the old and settled attempts stays consistent (not uncertain).
	const oldStatus = fix.service.status(first.task_id, fix.cwd);
	assert.notEqual(oldStatus.manifest.phase, "uncertain");
	const settledStatus = fix.service.status(retried.task_id, fix.cwd);
	assert.equal(settledStatus.manifest.status, "applied");
	assert.equal(settledStatus.manifest.phase, "released");

	// Submitting and launching a second input works cleanly.
	open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
	const beforeSecondLaunch = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(beforeSecondLaunch.head_status.eligible, true);
	const secondLaunch = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth2 });
	assert.equal(secondLaunch.release_authorized, true);
	const cfg2 = fix.configs.at(-1)!;
	const build2 = workerFromConfig(t, join(secondLaunch.manifest.session_dir, `${cfg2.instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build2.start();
	await build2.beforeStart();
	await build2.complete({ status: "success", summary: "done 2", detail: "ok" });
	const settled2 = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth2 });
	assert.equal(settled2.settled, true, settled2.reason);
	assert.deepEqual(readManagedRuns(coordPath), []);
	assert.deepEqual(open()({ action: "inspect", factory_id: fac.factory_id }).uncertainty, []);
});

test("same-session readiness-timeout non-release proof -> retry -> settle retires managed_runs and keeps inspect certain", async t => {
	const root = mkdtempSync(join(tmpdir(), "factory-same-session-settle-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const factoryStateDir = join(root, "factory-state");
	const coordDatabase = join(root, "factory-coordination.sqlite");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, bin, stateDir, factoryStateDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read\n---\nBuilder.\n");

	let allowReady = false;
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	let seq = 0;
	const exec = async (_cmd: string, args: string[]) => {
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
			const sDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
			if (allowReady) {
				const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
				atomicJson(readyPath(sDir, instance), ready);
				const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
				mkdirSync(registryDir, { recursive: true });
				atomicJson(join(registryDir, `${instance}.json`), ready);
			}
			return ok();
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};

	const service = new BootstrapService({
		exec,
		extensionDir,
		home,
		pollMs: 5,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller", PI_BOOTSTRAP_STATE_DIR: stateDir, PI_FACTORY_STATE_DIR: factoryStateDir },
	});
	const database = join(factoryStateDir, "factories.sqlite");
	const open = () => factoryOperations(database, service, { coordinationPath: coordDatabase });

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Same-session retry settle",
		ready_timeout_ms: 100,
		agents: [{ node_id: "prep", persona: "builder", sub_task: "Prep" }],
	};
	const fac = open()({ action: "publish", name: "same-session-settle", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-timeout" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "run-1", brief: "Brief", authority: auth });

	await assert.rejects(() => open()({ action: "launch", factory_id: fac.factory_id, authority: auth }), /Readiness timeout/);
	const first = open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0]!;
	assert.equal(first.state, "proven_not_released");

	allowReady = true;
	const retried = await open()({
		action: "retry_launch",
		factory_id: fac.factory_id,
		authority: auth,
		input_id: receipt.input_id,
		previous_attempt_id: first.attempt_id,
		confirmed: true,
	});
	assert.equal(retried.release_authorized, true);
	const cfg = join(retried.manifest.session_dir, `${retried.manifest.pane_manifest[0]!.instance_id}.config.json`);
	const worker = workerFromConfig(t, cfg, { model: { provider: "provider", id: "model" } });
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "done", detail: "ok" });

	const settled = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
	assert.equal(settled.settled, true, settled.reason);
	assert.deepEqual(readManagedRuns(coordDatabase), []);

	const after = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(after.uncertainty, []);
	assert.equal(after.attempts.find(a => a.attempt_id === first.attempt_id)?.historical, true);
	assert.equal(after.attempts.find(a => a.attempt_id === first.attempt_id)?.retry_eligibility?.eligible, false);
	open()({ action: "submit", factory_id: fac.factory_id, reference: "run-2", brief: "Brief 2", authority: auth });
	assert.equal(open()({ action: "inspect", factory_id: fac.factory_id }).head_status.eligible, true);
});

test("superseded non-release ending in clear_hold retires managed_runs and leaves inspect certain and queue launchable", async t => {
	const fix = serviceFixture(t, ["builder"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const fac = open()({
		action: "publish",
		name: "retry-clear",
		draft: { topology: "graph", task: "Retry then clear", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] },
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-clear-1" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "r1", brief: "Brief 1", authority: auth });

	const failing = factoryOperations(dbPath, fix.service, {
		coordinationPath: coordPath,
		atLaunchCommit: phase => { if (phase === "release_before_commit") throw new Error("failed before release"); },
	});
	await assert.rejects(() => failing({ action: "launch", factory_id: fac.factory_id, authority: auth }), /failed before release/);
	const first = open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0]!;
	const deadInc = markManagerDead(dbPath, fac.factory_id);
	const auth2 = createManagerAuthority({ pi_session_id: "mgr-clear-2" });
	open()({ action: "takeover", factory_id: fac.factory_id, authority: auth2, confirmed_manager_incarnation_id: deadInc });

	const retried = await open()({
		action: "retry_launch",
		factory_id: fac.factory_id,
		authority: auth2,
		input_id: receipt.input_id,
		previous_attempt_id: first.attempt_id,
		confirmed: true,
	});
	const cfg = fix.configs.at(-1)!;
	const build = workerFromConfig(t, join(retried.manifest.session_dir, `${cfg.instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await build.beforeStart();
	// Worker exits without recording an outcome -> settle refuses, clearance is eligible.
	await build.shutdown("quit");
	const settledAttempt = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth2 });
	assert.equal(settledAttempt.settled, false);

	const cleared = await open()({
		action: "clear_hold",
		factory_id: fac.factory_id,
		input_id: receipt.input_id,
		attempt_id: retried.attempt_id,
		task_id: retried.task_id,
		authority: auth2,
		confirm: () => ({ reason: "Worker crashed", evidence: "PID exited without outcome", acknowledged_unknown_effects: true }),
	});
	assert.equal(cleared.cleared, true);
	assert.deepEqual(readManagedRuns(coordPath), []);

	const after = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(after.uncertainty, []);
	assert.equal(after.attempts.find(a => a.attempt_id === first.attempt_id)?.historical, true);
	assert.equal(after.attempts.find(a => a.attempt_id === first.attempt_id)?.retry_eligibility?.eligible, false);
	assert.equal(after.attempts.find(a => a.attempt_id === retried.attempt_id)?.state, "cleared");
	assert.notEqual(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");

	open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
	assert.equal(open()({ action: "inspect", factory_id: fac.factory_id }).head_status.eligible, true);
});

test("pre-fix stuck-state repair: unretired valid managed_run row is repaired by takeover (and settle_run when nothing is held) while inspect never mutates", async t => {
	const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);

	const restoreStuckRow = () => insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));

	restoreStuckRow();
	assert.equal(readManagedRuns(coordPath).length, 1);

	// Read-only inspect sees no uncertainty AND does NOT mutate coord.managed_runs.
	const viewBefore = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(viewBefore.uncertainty, []);
	assert.equal(readManagedRuns(coordPath).length, 1, "inspect must never mutate managed_runs");

	// Takeover idempotently retires the stuck row under manager authority.
	const deadInc = markManagerDead(dbPath, fac.factory_id);
	const auth3 = createManagerAuthority({ pi_session_id: "mgr-third" });
	open()({ action: "takeover", factory_id: fac.factory_id, authority: auth3, confirmed_manager_incarnation_id: deadInc });
	assert.deepEqual(readManagedRuns(coordPath), [], "takeover must retire stuck superseded managed_run row");
	assert.deepEqual(open()({ action: "inspect", factory_id: fac.factory_id }).uncertainty, []);

	// Re-insert stuck row and verify another factory on the same checkout is not falsely blocked and never deletes Factory A's row.
	restoreStuckRow();
	const dbPathB = join(fix.root, "factories-b-clean.sqlite");
	const openB = () => factoryOperations(dbPathB, fix.service, { coordinationPath: coordPath });
	const facB = openB()({ action: "publish", name: "factory-b-clean", draft: { topology: "graph", task: "Factory B clean", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] }, sessionModel });
	const authB = createManagerAuthority({ pi_session_id: "mgr-b-clean" });
	openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
	openB()({ action: "submit", factory_id: facB.factory_id, reference: "b1", brief: "Brief B", authority: authB });
	const viewB = openB()({ action: "inspect", factory_id: facB.factory_id });
	assert.deepEqual(viewB.uncertainty, [], "valid pre-fix superseded managed_run from another factory must not block checkout");
	assert.equal(viewB.head_status.eligible, true);
	const deadIncB = markManagerDead(dbPathB, facB.factory_id);
	const authB2 = createManagerAuthority({ pi_session_id: "mgr-b-clean-2" });
	openB()({ action: "takeover", factory_id: facB.factory_id, authority: authB2, confirmed_manager_incarnation_id: deadIncB });
	assert.equal(readManagedRuns(coordPath).length, 1, "another factory's takeover must never delete Factory A's row");

	// Verify settle_run on Factory A when nothing is held retires it under manager authority.
	assert.equal(readManagedRuns(coordPath).length, 1);
	await assert.rejects(() => open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth2 }), /authority/i);
	assert.equal(readManagedRuns(coordPath).length, 1, "stale authority must not retire row");
	const noopSettle = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth3 });
	assert.equal(noopSettle.settled, false);
	assert.deepEqual(readManagedRuns(coordPath), [], "settle_run when nothing is held must retire stuck superseded row");
	assert.deepEqual(open()({ action: "inspect", factory_id: fac.factory_id }).uncertainty, []);
});

test("negative guards: any contradiction on a superseded attempt keeps uncertainty and blocks repair", async t => {
	const assertUncertain = (open: () => ReturnType<typeof factoryOperations>, factoryId: string, label: string) => {
		const view = open()({ action: "inspect", factory_id: factoryId });
		assert.ok(view.uncertainty.length > 0, `${label}: expected non-empty uncertainty`);
		assert.equal(view.head_status.eligible, false, `${label}: head must not be eligible`);
		assert.equal(view.head_status.blocking_kind, "uncertain", `${label}: blocking_kind must be uncertain`);
	};

	await t.test("release.json exists in old attempt session stays uncertain and stuck row survives", async t => {
		const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const rawFirst = attemptRow(dbPath, first.attempt_id);
		const oldSessionDir = join(fix.cwd, ".pi", "agent-sessions", first.task_id);
		const manifest = readJson<{ token: string }>(join(oldSessionDir, "manifest.json"));
		atomicJson(join(oldSessionDir, "release.json"), {
			task_id: first.task_id,
			token: manifest.token,
			factory_managed: {
				factory_id: fac.factory_id,
				factory_name: fac.name,
				input_id: first.input_id,
				attempt_id: first.attempt_id,
				request_id: first.request_id,
				bound_version: first.bound_version,
				canonical_checkout: fix.cwd,
				checkout_key: rawFirst.checkout_key,
				state_db_path: dbPath,
				coord_db_path: coordPath,
				release_nonce: "0".repeat(64),
			},
		});
		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "release.json present");
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
		await assertStuckRowSurvivesTakeoverAndSettle(dbPath, coordPath, open, fac, first.attempt_id, "release.json");
	});

	await t.test("tampered old managed_run row stays uncertain and is never retired", async t => {
		const { dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const rawFirst = attemptRow(dbPath, first.attempt_id);
		insertRun(coordPath, stuckRow(rawFirst, fac, dbPath, { request_id_digest: "f".repeat(64) }));

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "tampered managed_run");

		// Takeover and settle_run must NOT delete the tampered managed_run row and must surface diagnostics.
		const { authority, result } = await takeoverAgain(dbPath, open, fac.factory_id, "mgr-after-tamper");
		const diags = (result as { retirement_diagnostics?: Array<{ attempt_id: string; reason: string }> } | undefined)?.retirement_diagnostics;
		assert.ok(diags && diags.some(d => d.attempt_id === first.attempt_id && /managed run/i.test(d.reason)), "expected managed_run diagnostic");
		try { await open()({ action: "settle_run", factory_id: fac.factory_id, authority }); } catch {}
		assert.equal(readManagedRuns(coordPath).length, 1, "tampered managed_run row must not be deleted by takeover or settle_run");
		assertUncertain(open, fac.factory_id, "still uncertain after takeover");
	});

	await t.test("input settled with no later settled/cleared attempt stays uncertain and stuck row survives", async t => {
		const fix = serviceFixture(t, ["builder"]);
		const dbPath = join(fix.root, "factories.sqlite");
		const coordPath = join(fix.root, "factory-coordination.sqlite");
		const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
		const fac = open()({ action: "publish", name: "no-later-terminal", draft: { topology: "graph", task: "No later", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] }, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-nolater" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "r1", brief: "Brief 1", authority: auth });
		const failing = factoryOperations(dbPath, fix.service, { coordinationPath: coordPath, atLaunchCommit: phase => { if (phase === "release_before_commit") throw new Error("fail"); } });
		await assert.rejects(() => failing({ action: "launch", factory_id: fac.factory_id, authority: auth }), /fail/);
		const deadInc = markManagerDead(dbPath, fac.factory_id);
		const auth2 = createManagerAuthority({ pi_session_id: "mgr-nolater-2" });
		open()({ action: "takeover", factory_id: fac.factory_id, authority: auth2, confirmed_manager_incarnation_id: deadInc });

		const db = new DatabaseSync(dbPath);
		const inp = db.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(receipt.input_id) as StoredInput;
		const settledInp = buildInputRow({ ...inp, disposition: "settled" });
		db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(settledInp.disposition, settledInp.record_digest, inp.input_id);
		db.prepare("DELETE FROM factory_holds WHERE factory_id = ?").run(fac.factory_id);
		db.close();
		const coord = new DatabaseSync(coordPath);
		coord.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(fac.factory_id);
		coord.prepare("DELETE FROM managed_runs WHERE factory_id = ?").run(fac.factory_id);
		coord.close();

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "settled input without later terminal attempt");
		const first = open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0]!;
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
		await assertStuckRowSurvivesTakeoverAndSettle(dbPath, coordPath, open, fac, first.attempt_id, "no-later-terminal");
	});

	await t.test("old attempt nonzero release_authorized, non-null digest/timestamp, or wrong error stays uncertain and stuck row survives", async t => {
		for (const variant of ["release_authorized", "token_digest", "nonce_digest", "authorized_at", "error"] as const) {
			await t.test(variant, async t => {
				const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
				updAttempt(dbPath, first.attempt_id, () => ({
					...(variant === "release_authorized" ? { release_authorized: 1 } : {}),
					...(variant === "token_digest" ? { release_token_digest: "a".repeat(64) } : {}),
					...(variant === "nonce_digest" ? { release_nonce_digest: "b".repeat(64) } : {}),
					...(variant === "authorized_at" ? { release_authorized_at: new Date().toISOString() } : {}),
					...(variant === "error" ? { error: "tampered error message" } : {}),
				}));
				open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
				assertUncertain(open, fac.factory_id, variant);
				assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
				await assertStuckRowSurvivesTakeoverAndSettle(dbPath, coordPath, open, fac, first.attempt_id, variant);
			});
		}
	});

	await t.test("another factory's managed_runs row is never touched, and foreign orphan blocks inspect", async t => {
		const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const dbPathB = join(fix.root, "factories-b.sqlite");
		const openB = () => factoryOperations(dbPathB, fix.service, { coordinationPath: coordPath });
		const facB = openB()({ action: "publish", name: "factory-b", draft: { topology: "graph", task: "Factory B", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] }, sessionModel });
		const authB = createManagerAuthority({ pi_session_id: "mgr-b" });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });

		const foreignRun = buildManagedRunRow({
			task_id: "factory_run_foreign-orphan-00000000-0000-4000-8000-000000000001",
			request_id_digest: sha256Hex("req-foreign"),
			factory_id: facB.factory_id,
			factory_name: facB.name,
			factory_db_path: dbPathB,
			input_id: "inp-foreign",
			attempt_id: "att-foreign",
			canonical_checkout: fix.cwd,
			checkout_key: attemptRow(dbPath, first.attempt_id).checkout_key,
			created_at: new Date().toISOString(),
		});
		insertRun(coordPath, foreignRun);

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "foreign orphan blocks checkout");

		// Takeover and settle_run on Factory A must NOT delete Factory B's row!
		const { authority: auth3 } = await takeoverAgain(dbPath, open, fac.factory_id, "mgr-a-3");
		await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth3 });
		const remaining = readManagedRuns(coordPath);
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0]!.factory_id, facB.factory_id);
	});

	await t.test("superseded attempt whose sibling is NOT terminal stays uncertain and stuck row survives", async t => {
		const fix = serviceFixture(t, ["builder"]);
		const dbPath = join(fix.root, "factories.sqlite");
		const coordPath = join(fix.root, "factory-coordination.sqlite");
		const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
		const fac = open()({ action: "publish", name: "nonterminal-sibling", draft: { topology: "graph", task: "Nonterminal", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] }, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-nt-1" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "r1", brief: "Brief 1", authority: auth });
		const failing = factoryOperations(dbPath, fix.service, { coordinationPath: coordPath, atLaunchCommit: phase => { if (phase === "release_before_commit") throw new Error("fail"); } });
		await assert.rejects(() => failing({ action: "launch", factory_id: fac.factory_id, authority: auth }), /fail/);
		const first = open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0]!;
		const deadInc = markManagerDead(dbPath, fac.factory_id);
		const auth2 = createManagerAuthority({ pi_session_id: "mgr-nt-2" });
		open()({ action: "takeover", factory_id: fac.factory_id, authority: auth2, confirmed_manager_incarnation_id: deadInc });
		await open()({ action: "retry_launch", factory_id: fac.factory_id, authority: auth2, input_id: receipt.input_id, previous_attempt_id: first.attempt_id, confirmed: true });

		// Delete holds while the retried attempt is still `released` (NOT terminal).
		const db = new DatabaseSync(dbPath);
		db.prepare("DELETE FROM factory_holds WHERE factory_id = ?").run(fac.factory_id);
		db.close();
		const coord = new DatabaseSync(coordPath);
		coord.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(fac.factory_id);
		coord.close();

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "non-terminal sibling without holds");
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
		const { authority: auth3 } = await takeoverAgain(dbPath, open, fac.factory_id, "mgr-nt-3");
		try { await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth3 }); } catch {}
		assert.equal(readManagedRuns(coordPath).filter(r => r.attempt_id === first.attempt_id).length, 1, "non-terminal sibling: old row must survive");
	});

	await t.test("tampered abort.json, missing abort.json, missing index, or inverted sibling order stays uncertain and stuck row survives", async t => {
		for (const variant of ["corrupt_abort", "missing_abort", "missing_index", "inverted_order"] as const) {
			await t.test(variant, async t => {
				const { fix, dbPath, coordPath, open, fac, first, retried, auth2 } = await setupSupersededSettledFixture(t);
				const oldSessionDir = join(fix.cwd, ".pi", "agent-sessions", first.task_id);
				if (variant === "corrupt_abort") {
					atomicJson(join(oldSessionDir, "abort.json"), { task_id: first.task_id, token: "wrong-token", error: "tampered" });
				} else if (variant === "missing_abort") {
					rmSync(join(oldSessionDir, "abort.json"));
				} else if (variant === "missing_index") {
					const db = new DatabaseSync(dbPath);
					db.prepare("DELETE FROM factory_run_indexes WHERE task_id = ?").run(first.task_id);
					db.close();
				} else if (variant === "inverted_order") {
					updAttempt(dbPath, first.attempt_id, () => ({ created_at: "2099-01-01T00:00:00.000Z" }));
				}
				open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
				assertUncertain(open, fac.factory_id, variant);
				assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
				assert.ok(retried.attempt_id);
				await assertStuckRowSurvivesTakeoverAndSettle(dbPath, coordPath, open, fac, first.attempt_id, variant);
			});
		}
	});

	await t.test("hold still referencing old proven_not_released attempt stays uncertain and stuck row survives", async t => {
		const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const rawFirst = attemptRow(dbPath, first.attempt_id);
		const db = new DatabaseSync(dbPath);
		const nowIso = new Date().toISOString();
		const holdDigest = sha256Hex(JSON.stringify([fac.factory_id, rawFirst.attempt_id, rawFirst.input_id, rawFirst.request_id, rawFirst.task_id, "failed_before_release", nowIso, nowIso]));
		db.prepare(
			"INSERT INTO factory_holds (factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(fac.factory_id, rawFirst.attempt_id, rawFirst.input_id, rawFirst.request_id, rawFirst.task_id, "failed_before_release", nowIso, nowIso, holdDigest);
		db.close();
		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "hold still referencing old attempt");
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
		await assertStuckRowSurvivesTakeoverAndSettle(dbPath, coordPath, open, fac, first.attempt_id, "active-hold");
	});
});

// ---------- retirement probes & release-gate guards ----------

const retireProbeVariants: Record<string, (ctx: Awaited<ReturnType<typeof setupSupersededSettledFixture>>) => void> = {
	old_release_authorized: ({ dbPath, first }) => updAttempt(dbPath, first.attempt_id, () => ({ release_authorized: 1 })),
	later_release_authorized_0: ({ dbPath, retried }) => updAttempt(dbPath, retried.attempt_id, () => ({ release_authorized: 0 })),
	input_disposition_cleared: ({ dbPath, receipt }) => {
		const db = new DatabaseSync(dbPath);
		try {
			const inp = db.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(receipt.input_id) as StoredInput;
			const n = buildInputRow({ ...inp, disposition: "cleared" } as never);
			db.prepare("UPDATE factory_inputs SET disposition=?, record_digest=? WHERE input_id=?").run(n.disposition, n.record_digest, inp.input_id);
		} finally {
			db.close();
		}
	},
	later_bound_version: ({ dbPath, retried }) => updAttempt(dbPath, retried.attempt_id, () => ({ bound_version: "v9" })),
	terminal_not_last: ({ dbPath, retried }) => insertAttemptClone(dbPath, retried.attempt_id, {
		attempt_id: "att-00000000-0000-4000-8000-0000000000ff",
		task_id: "factory_run_probe-x-00000000-0000-4000-8000-0000000000ff",
		request_id: "factory_run_req_probe_ff",
		state: "failed_before_release",
		release_authorized: 0,
		release_authorized_at: null,
		release_token_digest: null,
		release_nonce_digest: null,
		error: "x",
		created_at: "2099-01-01T00:00:00.000Z",
	}),
	middle_sibling_not_pnr: ({ dbPath, first }) => insertAttemptClone(dbPath, first.attempt_id, {
		attempt_id: "att-00000000-0000-4000-8000-0000000000ee",
		task_id: "factory_run_probe-y-00000000-0000-4000-8000-0000000000ee",
		request_id: "factory_run_req_probe_ee",
		state: "failed_before_release",
		created_at: new Date(Date.parse(attemptRow(dbPath, first.attempt_id).created_at) + 1).toISOString(),
	}),
	manifest_cleaned: ({ fix, first }) => {
		const p = join(fix.cwd, ".pi", "agent-sessions", first.task_id, "manifest.json");
		const m = JSON.parse(readFileSync(p, "utf8"));
		m.status = "cleaned";
		writeFileSync(p, JSON.stringify(m));
	},
};

for (const [name, tamper] of Object.entries(retireProbeVariants)) {
	test(`probe retire guard: ${name} keeps the stuck row through takeover and settle_run (and flags inspect uncertain)`, async t => {
		const ctx = await setupSupersededSettledFixture(t);
		const { dbPath, coordPath, open, fac, first } = ctx;
		insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));
		tamper(ctx);
		const view = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.ok(view.uncertainty.length > 0, `${name}: inspect must report uncertainty`);
		const { authority } = await takeoverAgain(dbPath, open, fac.factory_id, `probe-${name}`);
		try { await open()({ action: "settle_run", factory_id: fac.factory_id, authority }); } catch {}
		assert.equal(readManagedRuns(coordPath).filter(r => r.attempt_id === first.attempt_id).length, 1, `${name}: row must survive`);
	});
}

test("probe retire guard: managed_run factory_db_path alias is not retired and flags inspect uncertain", async t => {
	const { dbPath, coordPath, open, fac, first } = await setupSupersededSettledFixture(t);
	insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath, { factory_db_path: dbPath.replace(/factories\.sqlite$/, "./factories.sqlite") }));
	assert.ok(open()({ action: "inspect", factory_id: fac.factory_id }).uncertainty.length > 0);
	const { authority } = await takeoverAgain(dbPath, open, fac.factory_id, "probe-alias");
	try { await open()({ action: "settle_run", factory_id: fac.factory_id, authority }); } catch {}
	assert.equal(readManagedRuns(coordPath).length, 1);
});

test("probe deletion scoping: retiring A's stuck row leaves foreign and unrelated rows", async t => {
	const { fix, dbPath, coordPath, open, fac, first, retried } = await setupSupersededSettledFixture(t);
	const a1 = attemptRow(dbPath, first.attempt_id);
	insertRun(coordPath, stuckRow(a1, fac, dbPath));
	// unrelated rows: the settled retry's own association (re-inserted) and a foreign factory's row on same checkout
	insertRun(coordPath, stuckRow(attemptRow(dbPath, retried.attempt_id), fac, dbPath));
	insertRun(coordPath, buildManagedRunRow({
		task_id: "factory_run_foreign-00000000-0000-4000-8000-000000000001",
		request_id_digest: sha256Hex("req-f"),
		factory_id: "00000000-0000-4000-8000-0000000000aa",
		factory_name: "foreign",
		factory_db_path: join(fix.root, "other.sqlite"),
		input_id: "inp-f",
		attempt_id: "att-f",
		canonical_checkout: a1.canonical_checkout,
		checkout_key: a1.checkout_key,
		created_at: new Date().toISOString(),
	}));
	await takeoverAgain(dbPath, open, fac.factory_id, "probe-scope");
	const rem = readManagedRuns(coordPath).map(r => r.attempt_id).sort();
	assert.deepEqual(rem, [retried.attempt_id, "att-f"].sort());
});

async function factoryB(fix: ReturnType<typeof serviceFixture>, coordPath: string, hook?: (phase: string) => void) {
	const dbPathB = join(fix.root, "factories-b.sqlite");
	const openB = () => factoryOperations(dbPathB, fix.service, { coordinationPath: coordPath, ...(hook ? { atLaunchCommit: hook } : {}) });
	const facB = openB()({ action: "publish", name: "factory-b", draft: { topology: "graph", task: "Factory B", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] }, sessionModel });
	const authB = createManagerAuthority({ pi_session_id: "mgr-b" });
	openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
	openB()({ action: "submit", factory_id: facB.factory_id, reference: "b1", brief: "Brief B", authority: authB });
	return { openB, facB, authB };
}

test("probe release gate (cross-root): A's unretired valid superseded row does not block factory B's release", async t => {
	const { fix, dbPath, coordPath, fac, first } = await setupSupersededSettledFixture(t);
	insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));
	const { openB, facB, authB } = await factoryB(fix, coordPath);
	assert.deepEqual(openB()({ action: "inspect", factory_id: facB.factory_id }).uncertainty, []);
	const l = await openB()({ action: "launch", factory_id: facB.factory_id, authority: authB });
	assert.equal(l.release_authorized, true);
	assert.equal(readManagedRuns(coordPath).length, 2);
});

test("probe release gate (cross-root): A's superseded row whose evidence breaks before B's release commit blocks B's release", async t => {
	const { fix, dbPath, coordPath, fac, first } = await setupSupersededSettledFixture(t);
	insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));
	const { openB, facB, authB } = await factoryB(fix, coordPath, phase => {
		if (phase === "reserve_after_commit") rmSync(join(fix.cwd, ".pi", "agent-sessions", first.task_id, "abort.json"));
	});
	await assert.rejects(() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }));
});

test("probe release gate (own): unretired superseded row present at gate (retire skipped) with evidence broken blocks release", async t => {
	const { fix, dbPath, coordPath, fac, first, auth2 } = await setupSupersededSettledFixture(t);
	const open = () => factoryOperations(dbPath, fix.service, {
		coordinationPath: coordPath,
		atLaunchCommit: phase => {
			if (phase === "reserve_after_commit") {
				insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));
				rmSync(join(fix.cwd, ".pi", "agent-sessions", first.task_id, "abort.json"));
			}
		},
	});
	open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
	await assert.rejects(() => open()({ action: "launch", factory_id: fac.factory_id, authority: auth2 }));
});

test("probe release gate (own): unretired valid superseded row inserted before gate does not block", async t => {
	const { fix, dbPath, coordPath, fac, first, auth2 } = await setupSupersededSettledFixture(t);
	const open = () => factoryOperations(dbPath, fix.service, {
		coordinationPath: coordPath,
		atLaunchCommit: phase => {
			if (phase === "reserve_after_commit") insertRun(coordPath, stuckRow(attemptRow(dbPath, first.attempt_id), fac, dbPath));
		},
	});
	open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
	const l = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth2 });
	assert.equal(l.release_authorized, true);
});
