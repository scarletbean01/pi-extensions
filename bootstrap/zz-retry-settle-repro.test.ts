import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	const db = new DatabaseSync(dbPath);
	const rawFirst = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(first.attempt_id) as StoredAttempt;
	db.close();

	// Re-insert the pre-fix unretired managed_runs row for the superseded attempt.
	const restoreStuckRow = () => {
		const coord = new DatabaseSync(coordPath);
		try {
			const row = buildManagedRunRow({
				task_id: rawFirst.task_id,
				request_id_digest: sha256Hex(rawFirst.request_id),
				factory_id: fac.factory_id,
				factory_name: fac.name,
				factory_db_path: dbPath,
				input_id: rawFirst.input_id,
				attempt_id: rawFirst.attempt_id,
				canonical_checkout: rawFirst.canonical_checkout,
				checkout_key: rawFirst.checkout_key,
				created_at: rawFirst.created_at,
			});
			coord.prepare(
				`INSERT INTO managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(row.task_id, row.request_id_digest, row.factory_id, row.factory_name, row.factory_db_path, row.input_id, row.attempt_id, row.canonical_checkout, row.checkout_key, row.created_at, row.record_digest);
		} finally {
			coord.close();
		}
	};

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
	const mutateAttempt = (dbPath: string, attemptId: string, mutator: (row: StoredAttempt) => Omit<StoredAttempt, "record_digest">) => {
		const db = new DatabaseSync(dbPath);
		try {
			const row = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(attemptId) as StoredAttempt;
			const updated = mutator(row);
			const digest = attemptRecordDigest(updated);
			db.prepare(
				`UPDATE factory_attempts SET state = ?, release_authorized = ?, release_authorized_at = ?, release_token_digest = ?, release_nonce_digest = ?, error = ?, created_at = ?, record_digest = ? WHERE attempt_id = ?`,
			).run(updated.state, updated.release_authorized, updated.release_authorized_at, updated.release_token_digest, updated.release_nonce_digest, updated.error, updated.created_at, digest, attemptId);
		} finally {
			db.close();
		}
	};

	const assertUncertain = (open: () => ReturnType<typeof factoryOperations>, factoryId: string, label: string) => {
		const view = open()({ action: "inspect", factory_id: factoryId });
		assert.ok(view.uncertainty.length > 0, `${label}: expected non-empty uncertainty`);
		assert.equal(view.head_status.eligible, false, `${label}: head must not be eligible`);
		assert.equal(view.head_status.blocking_kind, "uncertain", `${label}: blocking_kind must be uncertain`);
	};

	await t.test("release.json exists in old attempt session stays uncertain", async t => {
		const { fix, dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const db = new DatabaseSync(dbPath);
		const rawFirst = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(first.attempt_id) as StoredAttempt;
		db.close();
		const oldSessionDir = join(fix.cwd, ".pi", "agent-sessions", first.task_id);
		const manifest = readJson<{ token: string }>(join(oldSessionDir, "manifest.json"));
		atomicJson(join(oldSessionDir, "release.json"), { task_id: first.task_id, token: manifest.token, factory_managed: { factory_id: fac.factory_id, factory_name: fac.name, input_id: first.input_id, attempt_id: first.attempt_id, request_id: first.request_id, bound_version: first.bound_version, canonical_checkout: fix.cwd, checkout_key: rawFirst.checkout_key, state_db_path: dbPath, coord_db_path: coordPath, release_nonce: "0".repeat(64) } });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "release.json present");
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
	});

	await t.test("tampered old managed_run row stays uncertain and is never retired", async t => {
		const { dbPath, coordPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const db = new DatabaseSync(dbPath);
		const rawFirst = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(first.attempt_id) as StoredAttempt;
		db.close();
		const coord = new DatabaseSync(coordPath);
		const badRow = buildManagedRunRow({
			task_id: rawFirst.task_id,
			request_id_digest: "f".repeat(64),
			factory_id: fac.factory_id,
			factory_name: fac.name,
			factory_db_path: dbPath,
			input_id: rawFirst.input_id,
			attempt_id: rawFirst.attempt_id,
			canonical_checkout: rawFirst.canonical_checkout,
			checkout_key: rawFirst.checkout_key,
			created_at: rawFirst.created_at,
		});
		coord.prepare(
			`INSERT INTO managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(badRow.task_id, badRow.request_id_digest, badRow.factory_id, badRow.factory_name, badRow.factory_db_path, badRow.input_id, badRow.attempt_id, badRow.canonical_checkout, badRow.checkout_key, badRow.created_at, badRow.record_digest);
		coord.close();

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "tampered managed_run");

		// Takeover must NOT delete the tampered managed_run row.
		const deadInc = markManagerDead(dbPath, fac.factory_id);
		const auth3 = createManagerAuthority({ pi_session_id: "mgr-after-tamper" });
		open()({ action: "takeover", factory_id: fac.factory_id, authority: auth3, confirmed_manager_incarnation_id: deadInc });
		assert.equal(readManagedRuns(coordPath).length, 1, "tampered managed_run row must not be deleted by takeover");
		assertUncertain(open, fac.factory_id, "still uncertain after takeover");
	});

	await t.test("input settled with no later settled/cleared attempt stays uncertain", async t => {
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
	});

	await t.test("old attempt nonzero release_authorized, non-null digest/timestamp, or wrong error stays uncertain", async t => {
		for (const variant of ["release_authorized", "token_digest", "nonce_digest", "authorized_at", "error"] as const) {
			await t.test(variant, async t => {
				const { fix, dbPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
				mutateAttempt(dbPath, first.attempt_id, row => ({
					...row,
					...(variant === "release_authorized" ? { release_authorized: 1 } : {}),
					...(variant === "token_digest" ? { release_token_digest: "a".repeat(64) } : {}),
					...(variant === "nonce_digest" ? { release_nonce_digest: "b".repeat(64) } : {}),
					...(variant === "authorized_at" ? { release_authorized_at: new Date().toISOString() } : {}),
					...(variant === "error" ? { error: "tampered error message" } : {}),
				}));
				open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
				assertUncertain(open, fac.factory_id, variant);
				assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
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

		// Insert an orphaned managed_runs row owned by Factory B on the same checkout.
		const coord = new DatabaseSync(coordPath);
		const foreignRun = buildManagedRunRow({
			task_id: "factory_run_foreign-orphan-00000000-0000-4000-8000-000000000001",
			request_id_digest: sha256Hex("req-foreign"),
			factory_id: facB.factory_id,
			factory_name: facB.name,
			factory_db_path: dbPathB,
			input_id: "inp-foreign",
			attempt_id: "att-foreign",
			canonical_checkout: fix.cwd,
			checkout_key: (new DatabaseSync(dbPath, { readOnly: true })).prepare("SELECT checkout_key FROM factory_attempts WHERE attempt_id = ?").get(first.attempt_id)!.checkout_key as string,
			created_at: new Date().toISOString(),
		});
		coord.prepare(
			`INSERT INTO managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(foreignRun.task_id, foreignRun.request_id_digest, foreignRun.factory_id, foreignRun.factory_name, foreignRun.factory_db_path, foreignRun.input_id, foreignRun.attempt_id, foreignRun.canonical_checkout, foreignRun.checkout_key, foreignRun.created_at, foreignRun.record_digest);
		coord.close();

		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "foreign orphan blocks checkout");

		// Takeover and settle_run on Factory A must NOT delete Factory B's row!
		const deadInc = markManagerDead(dbPath, fac.factory_id);
		const auth3 = createManagerAuthority({ pi_session_id: "mgr-a-3" });
		open()({ action: "takeover", factory_id: fac.factory_id, authority: auth3, confirmed_manager_incarnation_id: deadInc });
		await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth3 });
		const remaining = readManagedRuns(coordPath);
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0]!.factory_id, facB.factory_id);
	});

	await t.test("superseded attempt whose sibling is NOT terminal stays uncertain", async t => {
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
	});

	await t.test("tampered abort.json, missing abort.json, missing index, or inverted sibling order stays uncertain", async t => {
		for (const variant of ["corrupt_abort", "missing_abort", "missing_index", "inverted_order"] as const) {
			await t.test(variant, async t => {
				const { fix, dbPath, open, fac, first, retried, auth2 } = await setupSupersededSettledFixture(t);
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
					mutateAttempt(dbPath, first.attempt_id, row => ({ ...row, created_at: "2099-01-01T00:00:00.000Z" }));
				}
				open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
				assertUncertain(open, fac.factory_id, variant);
				if (variant !== "inverted_order") {
					assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
				} else {
					assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
				}
				assert.ok(retried.attempt_id);
			});
		}
	});

	await t.test("hold still referencing old proven_not_released attempt stays uncertain", async t => {
		const { fix, dbPath, open, fac, first, auth2 } = await setupSupersededSettledFixture(t);
		const db = new DatabaseSync(dbPath);
		const rawFirst = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(first.attempt_id) as StoredAttempt;
		const nowIso = new Date().toISOString();
		const holdDigest = sha256Hex(JSON.stringify([fac.factory_id, rawFirst.attempt_id, rawFirst.input_id, rawFirst.request_id, rawFirst.task_id, "failed_before_release", nowIso, nowIso]));
		db.prepare(
			"INSERT INTO factory_holds (factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(fac.factory_id, rawFirst.attempt_id, rawFirst.input_id, rawFirst.request_id, rawFirst.task_id, "failed_before_release", nowIso, nowIso, holdDigest);
		db.close();
		open()({ action: "submit", factory_id: fac.factory_id, reference: "r2", brief: "Brief 2", authority: auth2 });
		assertUncertain(open, fac.factory_id, "hold still referencing old attempt");
		assert.equal(fix.service.status(first.task_id, fix.cwd).manifest.phase, "uncertain");
	});
});
