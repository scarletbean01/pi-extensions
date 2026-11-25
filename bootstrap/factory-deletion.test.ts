import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type DeleteFactoryTarget } from "../factory/operations.ts";
import { buildProposalRow, updateProposalRow } from "./constraint-proposals.ts";
import { buildInputRow, managerRecordDigest } from "./factory-records.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };

function deletionFixture(t: test.TestContext) {
	const f = serviceFixture(t, ["builder"]);
	const dbPath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "coord.sqlite");
	const open = () => factoryOperations(dbPath, f.service, { coordinationPath });
	const draft = (task = "Idle factory") => ({
		topology: "graph",
		task,
		project_cwd: f.cwd,
		agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }],
	});
	const publish = (name = "idle-factory", task = "Idle factory") =>
		open()({ action: "publish", name, draft: draft(task), sessionModel });
	return { ...f, dbPath, coordinationPath, open, draft, publish };
}

test("confirmed delete of an input-less factory writes deletion record, inspect reports it, and existing records stay untouched", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("retire-me", "Initial");
	f.open()({ action: "update", factory_id: fac.factory_id, draft: f.draft("Updated"), sessionModel });
	const authority = createManagerAuthority({ pi_session_id: "mgr-delete-1", pi_session_file: join(f.root, "mgr.jsonl") });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority });

	const rawBefore = new DatabaseSync(f.dbPath, { readOnly: true });
	const beforeFactories = rawBefore.prepare("SELECT * FROM factories WHERE factory_id = ?").all(fac.factory_id);
	const beforeVersions = rawBefore.prepare("SELECT * FROM factory_versions WHERE factory_id = ? ORDER BY version_num").all(fac.factory_id);
	const beforePointers = rawBefore.prepare("SELECT * FROM factory_pointers WHERE factory_id = ?").all(fac.factory_id);
	const beforeState = rawBefore.prepare("SELECT * FROM factory_state WHERE factory_id = ?").all(fac.factory_id);
	const beforeControls = rawBefore.prepare("SELECT * FROM factory_controls WHERE factory_id = ?").all(fac.factory_id);
	rawBefore.close();

	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);

	let shownTarget: DeleteFactoryTarget | undefined;
	const result = await f.open()({
		action: "delete",
		factory_id: fac.factory_id,
		authority,
		confirm: async target => {
			shownTarget = target;
			return true;
		},
	});

	assert.ok(shownTarget);
	assert.equal(shownTarget.factory_id, fac.factory_id);
	assert.equal(shownTarget.name, "retire-me");
	assert.equal(shownTarget.current_version, "v2");
	assert.match(shownTarget.consequences, /permanent/i);
	assert.match(shownTarget.consequences, /versions|receipts|evidence/i);
	assert.match(shownTarget.consequences, /name.*reserved/i);

	assert.equal(result.deleted, true);
	assert.equal(result.already_deleted, false);
	assert.equal(result.factory_id, fac.factory_id);
	assert.equal(result.name, "retire-me");
	assert.ok(result.deletion);
	assert.ok(!Number.isNaN(Date.parse(result.deletion.deleted_at)));
	assert.equal(result.deletion.deleted_by.incarnation_id, authority.incarnation_id);
	assert.equal(result.deletion.deleted_by.pi_session_id, "mgr-delete-1");
	assert.equal(result.deletion.deleted_by.pi_session_file, join(f.root, "mgr.jsonl"));
	assert.equal(result.deletion.deleted_by.pid, process.pid);

	const inspected = f.open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(inspected.deleted, true);
	assert.deepEqual(inspected.deletion, result.deletion);

	const rawAfter = new DatabaseSync(f.dbPath, { readOnly: true });
	try {
		assert.equal(rawAfter.prepare("PRAGMA user_version").get()?.user_version, 13);
		assert.deepEqual(rawAfter.prepare("SELECT * FROM factories WHERE factory_id = ?").all(fac.factory_id), beforeFactories);
		assert.deepEqual(rawAfter.prepare("SELECT * FROM factory_versions WHERE factory_id = ? ORDER BY version_num").all(fac.factory_id), beforeVersions);
		assert.deepEqual(rawAfter.prepare("SELECT * FROM factory_pointers WHERE factory_id = ?").all(fac.factory_id), beforePointers);
		assert.deepEqual(rawAfter.prepare("SELECT * FROM factory_state WHERE factory_id = ?").all(fac.factory_id), beforeState);
		assert.deepEqual(rawAfter.prepare("SELECT * FROM factory_controls WHERE factory_id = ?").all(fac.factory_id), beforeControls);
		const deletionRows = rawAfter.prepare("SELECT * FROM factory_deletions WHERE factory_id = ?").all(fac.factory_id) as Array<Record<string, unknown>>;
		assert.equal(deletionRows.length, 1);
		assert.equal(deletionRows[0]!.deleted_at, result.deletion.deleted_at);
		assert.equal(deletionRows[0]!.incarnation_id, authority.incarnation_id);
		assert.match(String(deletionRows[0]!.record_digest), /^[a-f0-9]{64}$/);
	} finally {
		rawAfter.close();
	}
});

test("delete refuses unmanaged factories, wrong/revoked/missing authority, and missing confirm callback without calling confirm or writing records", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("unmanaged-fac");
	const auth = createManagerAuthority({ pi_session_id: "mgr-1" });

	let confirmCalls = 0;
	const confirm = async () => { confirmCalls++; return true; };

	// Unmanaged factory points at resume / takeover
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm }),
		/unmanaged.*resume.*takeover/i,
	);
	assert.equal(confirmCalls, 0);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);

	// Resume management, then test wrong authority, revoked authority, and missing confirm callback
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const other = createManagerAuthority({ pi_session_id: "mgr-other" });
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: other, confirm }),
		/managing session authority|takeover/i,
	);
	assert.equal(confirmCalls, 0);

	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: undefined, confirmed: true } as any),
		/direct human confirmation/i,
	);

	// Revoked authority before or during confirmation
	const revoked = createManagerAuthority({ pi_session_id: "mgr-revoked" });
	revokeManagerAuthority(revoked);
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: revoked, confirm }),
		/closed or replaced|revoked/i,
	);
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: fac.factory_id,
			authority: auth,
			confirm: async () => {
				revokeManagerAuthority(auth);
				return true;
			},
		}),
		/closed or replaced|revoked/i,
	);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);
});

test("no agent-facing delete tool exists, and /factory delete refuses Bootstrap worker sessions, requires typed name, and resolves name or UUID", async t => {
	const f = deletionFixture(t);
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const savedArgv = [...process.argv];
	const stateDir = join(f.root, "cmd-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
		process.argv.splice(0, process.argv.length, ...savedArgv);
	});

	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const { default: registerWorker } = await import("./worker.ts");
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	const workerTools = new Map<string, any>();
	registerWorker({
		registerFlag: () => {},
		getFlag: () => undefined,
		registerCommand: () => {},
		on: () => {},
		registerTool: (tool: any) => workerTools.set(tool.name, tool),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	} as any);

	// No delete tool on dispatcher or worker, and factory_inspect has no delete action
	assert.equal([...tools.keys()].some(n => /delete/i.test(n)), false);
	assert.equal([...workerTools.keys()].some(n => /delete/i.test(n)), false);
	const inspectTool = tools.get("factory_inspect");
	assert.ok(inspectTool);
	assert.doesNotMatch(JSON.stringify(inspectTool.parameters), /"delete"/);
	const rejectInspectDelete = await inspectTool.execute("c1", { action: "delete", factory_id: "x" });
	assert.equal(rejectInspectDelete.isError, true);

	const storePath = join(stateDir, "factories.sqlite");
	const cmdOps = () => factoryOperations(storePath, f.service);
	const facByName = cmdOps()({ action: "publish", name: "cmd-by-name", draft: f.draft("Name"), sessionModel });
	const facById = cmdOps()({ action: "publish", name: "cmd-by-id", draft: f.draft("Id"), sessionModel });

	const notes: Array<{ message: string; level: string }> = [];
	const confirmPrompts: Array<{ title: string; body: string }> = [];
	let confirmAnswer = true;
	let typedAnswer: string | undefined = "cmd-by-name";
	const ctx = {
		hasUI: true,
		cwd: f.cwd,
		ui: {
			notify: (message: string, level = "info") => notes.push({ message, level }),
			confirm: async (title: string, body: string) => { confirmPrompts.push({ title, body }); return confirmAnswer; },
			input: async () => typedAnswer,
			editor: async () => undefined,
			setStatus: () => {},
		},
		sessionManager: { getSessionId: () => "cmd-sess", getSessionFile: () => undefined },
	};
	const factoryCmd = commands.get("factory")!;
	const runCmd = async (args: string) => {
		notes.length = 0;
		confirmPrompts.length = 0;
		await factoryCmd.handler(args, ctx);
		return notes.map(n => n.message).join("\n");
	};

	// Refused inside Bootstrap worker session
	process.argv.push("--bootstrap-worker-config", "/tmp/w.json");
	assert.match(await runCmd(`delete ${facByName.factory_id}`), /Bootstrap worker session/i);
	process.argv.splice(0, process.argv.length, ...savedArgv);

	// Resume both factories in this command session
	await runCmd(`resume ${facByName.factory_id}`);
	await runCmd(`resume ${facById.factory_id}`);

	// Wrong typed name declines deletion and writes nothing
	typedAnswer = "wrong-name";
	confirmAnswer = true;
	const wrongOut = await runCmd("delete cmd-by-name");
	assert.match(wrongOut, /did not match|cancelled/i);
	assert.equal(confirmPrompts.length, 1);
	assert.ok(confirmPrompts[0]!.body.includes("cmd-by-name"));
	assert.ok(confirmPrompts[0]!.body.includes(facByName.factory_id));
	assert.match(confirmPrompts[0]!.body, /permanent/i);
	assert.match(confirmPrompts[0]!.body, /versions|receipts|evidence/i);
	assert.match(confirmPrompts[0]!.body, /reserved/i);
	assert.equal(cmdOps()({ action: "inspect", factory_id: facByName.factory_id }).deleted, false);

	// Exact typed name via name resolves to UUID and deletes
	typedAnswer = "cmd-by-name";
	const okByName = await runCmd("delete cmd-by-name");
	assert.match(okByName, /"deleted": true|Deleted factory/i);
	assert.equal(cmdOps()({ action: "inspect", factory_id: facByName.factory_id }).deleted, true);

	// Exact typed name via UUID deletes
	typedAnswer = "cmd-by-id";
	const okById = await runCmd(`delete ${facById.factory_id}`);
	assert.match(okById, /"deleted": true|Deleted factory/i);
	assert.equal(cmdOps()({ action: "inspect", factory_id: facById.factory_id }).deleted, true);

	// Repeating /factory delete via command says already deleted without prompting
	const repeatOut = await runCmd(`delete ${facById.factory_id}`);
	assert.match(repeatOut, /already deleted/i);
	assert.equal(confirmPrompts.length, 0);
});

test("declining confirmation leaves database byte-for-byte unchanged and writes no deletion record", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("decline-me");
	const authority = createManagerAuthority({ pi_session_id: "mgr-decline" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority });

	const beforeBytes = readFileSync(f.dbPath);
	const res = await f.open()({
		action: "delete",
		factory_id: fac.factory_id,
		authority,
		confirm: async () => false,
	});
	assert.equal(res.deleted, false);
	assert.equal(res.already_deleted, false);
	assert.deepEqual(readFileSync(f.dbPath), beforeBytes);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);
});

test("queued input refuses deletion before confirmation, and commit-time race fails with inspect again", async t => {
	const f = deletionFixture(t);
	const facWithInput = f.publish("has-input");
	const auth1 = createManagerAuthority({ pi_session_id: "mgr-input" });
	f.open()({ action: "resume", factory_id: facWithInput.factory_id, authority: auth1 });
	f.open()({ action: "submit", factory_id: facWithInput.factory_id, reference: "r1", brief: "Work", authority: auth1 });

	let confirmCalled = false;
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: facWithInput.factory_id,
			authority: auth1,
			confirm: async () => { confirmCalled = true; return true; },
		}),
		/input/i,
	);
	assert.equal(confirmCalled, false);
	assert.equal(f.open()({ action: "inspect", factory_id: facWithInput.factory_id }).deleted, false);

	// Commit-time race: input submitted while confirmation dialog is open
	const racing = f.publish("racing-delete");
	const auth2 = createManagerAuthority({ pi_session_id: "mgr-race" });
	f.open()({ action: "resume", factory_id: racing.factory_id, authority: auth2 });

	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: racing.factory_id,
			authority: auth2,
			confirm: async () => {
				f.open()({ action: "submit", factory_id: racing.factory_id, reference: "r-race", brief: "Slipped in", authority: auth2 });
				return true;
			},
		}),
		/changed during confirmation; inspect again/i,
	);
	const inspected = f.open()({ action: "inspect", factory_id: racing.factory_id });
	assert.equal(inspected.deleted, false);
	assert.equal(inspected.queue.length, 1);
	assert.equal(inspected.queue[0]!.reference, "r-race");
});

test("repeating delete on an already deleted factory says so plainly without prompting and changes nothing", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("repeat-delete");
	const authority = createManagerAuthority({ pi_session_id: "mgr-repeat" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority });

	const first = await f.open()({
		action: "delete",
		factory_id: fac.factory_id,
		authority,
		confirm: async () => true,
	});
	assert.equal(first.deleted, true);
	assert.equal(first.already_deleted, false);
	const dbSnapshot = readFileSync(f.dbPath);

	let secondPrompted = false;
	const second = await f.open()({
		action: "delete",
		factory_id: fac.factory_id,
		authority,
		confirm: async () => { secondPrompted = true; return true; },
	});
	assert.equal(secondPrompted, false);
	assert.equal(second.deleted, true);
	assert.equal(second.already_deleted, true);
	assert.match(second.message, /already deleted/i);
	assert.deepEqual(second.deletion, first.deletion);
	assert.deepEqual(readFileSync(f.dbPath), dbSnapshot);
});

test("opening an older v12 database migrates to v13 only through the normal explicit write path and fails closed on missing table or v14", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("legacy-v12");
	const auth = createManagerAuthority({ pi_session_id: "mgr-v12" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Downgrade to schema v12 (drop factory_deletions table and set user_version = 12)
	const downgrade = new DatabaseSync(f.dbPath);
	downgrade.exec("DROP TABLE factory_deletions; PRAGMA user_version = 12;");
	downgrade.close();
	const v12Bytes = readFileSync(f.dbPath);

	// Read-only list/inspect do not migrate v12
	assert.equal(f.open()({ action: "list" }).length, 1);
	const preInspect = f.open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(preInspect.deleted, false);
	assert.deepEqual(readFileSync(f.dbPath), v12Bytes, "read-only operations must not migrate v12");

	// Declining delete on v12 does not migrate v12
	const declined = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => false });
	assert.equal(declined.deleted, false);
	assert.deepEqual(readFileSync(f.dbPath), v12Bytes, "declined delete must not migrate v12");

	// Confirmed delete migrates v12 -> v13 in the same transaction and records deletion
	const confirmed = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(confirmed.deleted, true);
	const check13 = new DatabaseSync(f.dbPath, { readOnly: true });
	try {
		assert.equal(check13.prepare("PRAGMA user_version").get()?.user_version, 13);
	} finally {
		check13.close();
	}
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, true);

	// Missing factory_deletions while user_version === 13 fails closed
	const corrupt = new DatabaseSync(f.dbPath);
	corrupt.exec("DROP TABLE factory_deletions;");
	corrupt.close();
	assert.throws(() => f.open()({ action: "inspect", factory_id: fac.factory_id }), /deletion table is missing/i);
	await assert.rejects(() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true }), /deletion table is missing/i);

	// Future version 14 fails closed
	const future = new DatabaseSync(f.dbPath);
	future.exec("PRAGMA user_version = 14;");
	future.close();
	assert.throws(() => f.open()({ action: "inspect", factory_id: fac.factory_id }), /unsupported.*14/i);
});

test("queued, blocked, and retryable inputs refuse deletion even when stopped, while discarded inputs do not block", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("queued-then-discarded");
	const auth = createManagerAuthority({ pi_session_id: "mgr-queued" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const q1 = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "q1", brief: "First", authority: auth });
	const q2 = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "q2", brief: "Second", authority: auth });

	// Stopping the factory does not bypass queued-input refusal
	f.open()({ action: "stop", factory_id: fac.factory_id, authority: auth });
	const beforeStopRefusal = readFileSync(f.dbPath);
	let confirmCalls = 0;
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		/queued input/i,
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeStopRefusal);

	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: q1.input_id, authority: auth, confirm: async () => true });

	// Still blocked by q2 (and when q2 is marked blocked or retryable)
	for (const disp of ["blocked", "retryable"] as const) {
		const raw = new DatabaseSync(f.dbPath);
		const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(q2.input_id) as any;
		const next = buildInputRow({ ...row, disposition: disp });
		raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, q2.input_id);
		raw.close();
		await assert.rejects(
			() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
			/queued input/i,
		);
		assert.equal(confirmCalls, 0);
	}

	// Restore q2 to queued so discard works, discard it, then delete succeeds (without requiring /factory stop)
	{
		const raw = new DatabaseSync(f.dbPath);
		const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(q2.input_id) as any;
		const next = buildInputRow({ ...row, disposition: "queued" });
		raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, q2.input_id);
		raw.close();
	}
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: q2.input_id, authority: auth, confirm: async () => true });

	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).queue.length, 2);
});

test("delete refuses while holding capacity for a run or launch attempt or while a run is unsettled, and succeeds once settled (while idle sibling on shared checkout can delete)", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("active-run");
	const auth = createManagerAuthority({ pi_session_id: "mgr-run" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "run-1", brief: "Run work", authority: auth });
	const launched = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

	// Idle sibling factory sharing the same checkout does not hold capacity and can be deleted
	const sibling = f.publish("idle-sibling");
	const sibAuth = createManagerAuthority({ pi_session_id: "mgr-sib" });
	f.open()({ action: "resume", factory_id: sibling.factory_id, authority: sibAuth });
	const sibDeleted = await f.open()({ action: "delete", factory_id: sibling.factory_id, authority: sibAuth, confirm: async () => true });
	assert.equal(sibDeleted.deleted, true);

	// Active unsettled run holds capacity and is unsettled
	let confirmCalls = 0;
	const beforeActiveRefusal = readFileSync(f.dbPath);
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		err => err instanceof Error && /capacity hold/i.test(err.message) && /unsettled run/i.test(err.message),
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeActiveRefusal);

	// Finish worker, still not settled in factory storage -> still refused until settle_run
	const sessionDir = join(f.cwd, ".pi", "agent-sessions", launched.task_id);
	const workerCfg = readdirSync(sessionDir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
	const worker = workerFromConfig(t, join(sessionDir, workerCfg), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "Finished" });

	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		err => err instanceof Error && /capacity hold/i.test(err.message) && /unsettled/i.test(err.message),
	);
	assert.equal(confirmCalls, 0);

	// Settle the run -> deletion now succeeds
	const settled = await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
	assert.equal(settled.settled, true);
	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);

	// Launch attempt hold (failed_before_release -> proven_not_released -> retry -> settle)
	const facAttempt = f.publish("launch-attempt-hold");
	const attAuth = createManagerAuthority({ pi_session_id: "mgr-att" });
	f.open()({ action: "resume", factory_id: facAttempt.factory_id, authority: attAuth });
	const subAtt = f.open()({ action: "submit", factory_id: facAttempt.factory_id, reference: "att-1", brief: "Fail pre-release", authority: attAuth });
	const failingOps = factoryOperations(f.dbPath, f.service, {
		coordinationPath: f.coordinationPath,
		atLaunchCommit: phase => { if (phase === "release_before_commit") throw new Error("injected pre-release failure"); },
	} as any);
	await assert.rejects(() => failingOps({ action: "launch", factory_id: facAttempt.factory_id, authority: attAuth }), /injected pre-release failure/);

	// failed_before_release launch attempt holds capacity
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: facAttempt.factory_id, authority: attAuth, confirm: async () => { confirmCalls++; return true; } }),
		/capacity hold/i,
	);
	assert.equal(confirmCalls, 0);

	// Prove non-release via takeover -> proven_not_released still holds capacity and awaits retry
	revokeManagerAuthority(attAuth);
	const attAuth2 = createManagerAuthority({ pi_session_id: "mgr-att-2" });
	f.open()({ action: "takeover", factory_id: facAttempt.factory_id, authority: attAuth2, confirmed_manager_incarnation_id: attAuth.incarnation_id });
	const provenView = f.open()({ action: "inspect", factory_id: facAttempt.factory_id });
	assert.equal(provenView.attempts[0]!.state, "proven_not_released");
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: facAttempt.factory_id, authority: attAuth2, confirm: async () => { confirmCalls++; return true; } }),
		/capacity hold/i,
	);
	assert.equal(confirmCalls, 0);

	// Retry, complete, and settle -> superseded non-release attempt does not block deletion
	const priorAttemptId = provenView.attempts[0]!.attempt_id;
	const retried = await f.open()({ action: "retry_launch", factory_id: facAttempt.factory_id, input_id: subAtt.input_id, previous_attempt_id: priorAttemptId, confirmed: true, authority: attAuth2 });
	const retryDir = join(f.cwd, ".pi", "agent-sessions", retried.task_id);
	const retryCfg = readdirSync(retryDir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
	const retryWorker = workerFromConfig(t, join(retryDir, retryCfg), { model: sessionModel });
	await retryWorker.start();
	await retryWorker.beforeStart();
	await retryWorker.complete({ status: "success", summary: "Retry ok", detail: "Done" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: facAttempt.factory_id, authority: attAuth2 })).settled, true);

	const deletedAfterRetry = await f.open()({ action: "delete", factory_id: facAttempt.factory_id, authority: attAuth2, confirm: async () => true });
	assert.equal(deletedAfterRetry.deleted, true);
});

test("delete refuses while uncertain evidence exists (including uncertain hold and damaged control/version), and succeeds after operator clearance", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("uncertain-hold");
	const auth = createManagerAuthority({ pi_session_id: "mgr-uncertain" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "u-1", brief: "Run work", authority: auth });
	const launched = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const sessionDir = join(f.cwd, ".pi", "agent-sessions", launched.task_id);
	const workerCfg = readdirSync(sessionDir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
	const worker = workerFromConfig(t, join(sessionDir, workerCfg), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });

	// Tamper input disposition to blocked (matching factory-clearance.test.ts uncertainHold)
	{
		const raw = new DatabaseSync(f.dbPath);
		const row = raw.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(launched.input_id) as any;
		const next = buildInputRow({ ...row, disposition: "blocked" });
		raw.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, row.input_id);
		raw.close();
	}

	let confirmCalls = 0;
	const beforeUncertain = readFileSync(f.dbPath);
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		err => err instanceof Error && /uncertain evidence/i.test(err.message) && /capacity hold/i.test(err.message),
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeUncertain);

	// Operator clearance retires the hold and input -> deletion now succeeds
	const cleared = await f.open()({
		action: "clear_hold",
		factory_id: fac.factory_id,
		input_id: launched.input_id,
		attempt_id: launched.attempt_id,
		task_id: launched.task_id,
		authority: auth,
		confirm: async () => ({
			reason: "Operator verified no worker process remains",
			evidence: "Process exited and checkout is clean",
			acknowledged_unknown_effects: true,
		}),
	});
	assert.equal(cleared.cleared, true);
	const deletedCleared = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deletedCleared.deleted, true);

	// Uncertain evidence without a hold: damaged factory_controls record refuses deletion
	const facCtrl = f.publish("damaged-control");
	const ctrlAuth = createManagerAuthority({ pi_session_id: "mgr-ctrl" });
	f.open()({ action: "resume", factory_id: facCtrl.factory_id, authority: ctrlAuth });
	{
		const raw = new DatabaseSync(f.dbPath);
		raw.prepare("UPDATE factory_controls SET record_digest = 'deadbeef' WHERE factory_id = ?").run(facCtrl.factory_id);
		raw.close();
	}
	const beforeCtrl = readFileSync(f.dbPath);
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: facCtrl.factory_id, authority: ctrlAuth, confirm: async () => { confirmCalls++; return true; } }),
		/uncertain evidence/i,
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeCtrl);
});

test("delete refuses while a direction request or intervention request is pending, and succeeds once answered and settled", async t => {
	const f = deletionFixture(t);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const fac = f.open()({
		action: "publish",
		name: "pending-req",
		draft: {
			topology: "graph",
			task: "Direction ask",
			project_cwd: f.cwd,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Ask", intervention: { choices } }] as any,
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-req" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "req-1", brief: "Need direction", authority: auth });
	const run = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const worker = workerFromConfig(t, join(dir, readdirSync(dir).find(n => n.endsWith(".config.json") && n.includes("build"))!), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();

	const asked = worker.requestDirection({
		question: "Proceed?",
		reason: "Check",
		evidence: ["e1"],
		choices: ["proceed", "stop"],
	} as any);
	let pendingReq: any;
	for (let i = 0; i < 100 && !pendingReq; i++) {
		pendingReq = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!pendingReq) await new Promise(r => setTimeout(r, 20));
	}
	assert.ok(pendingReq);

	let confirmCalls = 0;
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		/pending direction request/i,
	);
	assert.equal(confirmCalls, 0);

	// Answer the request, check responded-but-unconsumed still blocks, then finish worker and settle -> now deletion succeeds
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: pendingReq.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await asked;
	await worker.complete({ status: "success", summary: "Done", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	const deletedAfterReq = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deletedAfterReq.deleted, true);

	// Settled run with an unanswered intervention/exhaustion request in isolation (no hold, settled run)
	const facEx = f.open()({
		action: "publish",
		name: "pending-exhaustion",
		draft: {
			topology: "graph",
			task: "Decision task",
			project_cwd: f.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "builder",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
			],
		},
		sessionModel,
	});
	const exAuth = createManagerAuthority({ pi_session_id: "mgr-ex" });
	f.open()({ action: "resume", factory_id: facEx.factory_id, authority: exAuth });
	const exSub = f.open()({ action: "submit", factory_id: facEx.factory_id, reference: "ex-1", brief: "Exhaust", authority: exAuth });
	const exRun = await f.open()({ action: "launch", factory_id: facEx.factory_id, authority: exAuth });
	const exDir = join(f.cwd, ".pi", "agent-sessions", exRun.task_id);
	const exWorker = workerFromConfig(t, join(exDir, readdirSync(exDir).find(n => n.endsWith(".config.json") && n.includes("build"))!), { model: sessionModel });
	await exWorker.start();
	await exWorker.beforeStart();
	await exWorker.complete({ status: "failure", summary: "Exhausted", detail: "Max revisions" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: facEx.factory_id, authority: exAuth })).settled, true);

	const exService = Object.create(f.service);
	exService.directionExhaustions = (ids: any) => {
		if (ids.factory_id !== facEx.factory_id) return [];
		return [{
			request_id: "exhaust_del_test",
			factory_id: facEx.factory_id,
			input_id: exSub.input_id,
			attempt_id: exRun.attempt_id,
			task_id: exRun.task_id,
			node_id: "build",
			node_attempt_id: "a1-build.1",
			state: "pending",
			question: "Loop exhausted",
			reason: "max_revisions reached",
			evidence: [],
			choices: [{ choice_id: "discard", label: "Discard the escalation" }],
			created_at: new Date().toISOString(),
			response_recorded: false,
			consumption: "not_applicable",
			can_respond: true,
			can_redeliver: false,
			reconciliation: "pending",
			exhaustion: { kind: "loop_limit", limit: 1, used: 1, on_exhausted: "needs_attention", verdict: "changes_requested", summary: "Exhausted" },
		}];
	};
	const exOps = () => factoryOperations(f.dbPath, exService, { coordinationPath: f.coordinationPath });
	await assert.rejects(
		() => exOps()({ action: "delete", factory_id: facEx.factory_id, authority: exAuth, confirm: async () => { confirmCalls++; return true; } }),
		/pending revision escalation/i,
	);
	assert.equal(confirmCalls, 0);

	exOps()({ action: "respond_request", factory_id: facEx.factory_id, request_id: "exhaust_del_test", response: { kind: "choice", choice_id: "discard" }, confirmExhaustion: () => true, authority: exAuth } as any);
	const deletedAfterEx = await exOps()({ action: "delete", factory_id: facEx.factory_id, authority: exAuth, confirm: async () => true });
	assert.equal(deletedAfterEx.deleted, true);
});

test("delete refuses while a constraint proposal is pending, and succeeds when proposals are confirmed, rejected, or dropped_duplicate", async t => {
	const f = deletionFixture(t);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const fac = f.open()({
		action: "publish",
		name: "proposal-gate",
		draft: {
			topology: "graph",
			task: "Proposal run",
			project_cwd: f.cwd,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-prop" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "p-1", brief: "Intervention run", authority: auth });
	const run = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const workerFile = readdirSync(dir).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const worker = workerFromConfig(t, join(dir, workerFile), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();
	const asked = worker.requestDirection({ question: "Proceed?", reason: "Check", evidence: ["e1"], choices: ["proceed", "stop"] } as any);
	let pendingReq: any;
	for (let i = 0; i < 100 && !pendingReq; i++) {
		pendingReq = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!pendingReq) await new Promise(r => setTimeout(r, 20));
	}
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: pendingReq.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await asked;
	await worker.complete({ status: "success", summary: "Done", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	const instanceId = JSON.parse(readFileSync(join(dir, workerFile), "utf8")).instance_id as string;
	const attemptId = `${instanceId}.1`;
	const evidenceRef = `request:${pendingReq.request_id}`;

	const prop1 = f.open()({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Always keep public APIs backwards compatible",
		run_id: run.task_id,
		attempt_id: attemptId,
		evidence_ref: evidenceRef,
		reference: "prop-confirm",
	});
	assert.equal(prop1.proposal.outcome, "pending");

	// Dropped duplicate does not clear the pending one, and by itself won't block later
	const dup = f.open()({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "  always  keep public APIs backwards compatible ",
		run_id: run.task_id,
		attempt_id: attemptId,
		evidence_ref: evidenceRef,
		reference: "prop-dup",
	});
	assert.equal(dup.proposal.outcome, "dropped_duplicate");

	let confirmCalls = 0;
	const beforeRefusal = readFileSync(f.dbPath);
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		/pending constraint proposal/i,
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeRefusal);

	// Confirm prop1 -> synced
	await f.open()({ action: "confirm_constraint", factory_id: fac.factory_id, proposal_id: prop1.proposal.proposal_id, authority: auth, confirm: async () => true });

	// Add prop2 -> pending blocks again; then reject it
	const prop2 = f.open()({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Never skip schema validation",
		run_id: run.task_id,
		attempt_id: attemptId,
		evidence_ref: evidenceRef,
		reference: "prop-reject",
	});
	assert.equal(prop2.proposal.outcome, "pending");
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		/pending constraint proposal/i,
	);
	assert.equal(confirmCalls, 0);

	await f.open()({ action: "reject_constraint", factory_id: fac.factory_id, proposal_id: prop2.proposal.proposal_id, authority: auth, reason: "Not needed", confirm: async () => true });

	// Now proposals are confirmed (synced), rejected, and dropped_duplicate -> delete succeeds
	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);
});

test("combined blocking conditions name every blocker in one refusal, force flags are rejected, and DBs stay byte-for-byte unchanged", async t => {
	const f = deletionFixture(t);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const fac = f.open()({
		action: "publish",
		name: "all-blockers",
		draft: {
			topology: "graph",
			task: "Combined blockers",
			project_cwd: f.cwd,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-all" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Run 1: intervene, finish, settle, and leave a pending constraint proposal
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "run-1", brief: "First", authority: auth });
	const run1 = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir1 = join(f.cwd, ".pi", "agent-sessions", run1.task_id);
	const file1 = readdirSync(dir1).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const w1 = workerFromConfig(t, join(dir1, file1), { model: sessionModel });
	await w1.start();
	await w1.beforeStart();
	const ask1 = w1.requestDirection({ question: "Proceed 1?", reason: "r1", evidence: ["e1"], choices: ["proceed", "stop"] } as any);
	let req1: any;
	for (let i = 0; i < 100 && !req1; i++) {
		req1 = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!req1) await new Promise(r => setTimeout(r, 20));
	}
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: req1.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await ask1;
	await w1.complete({ status: "success", summary: "Done 1", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);
	const inst1 = JSON.parse(readFileSync(join(dir1, file1), "utf8")).instance_id as string;
	const prop = f.open()({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Keep all blockers visible",
		run_id: run1.task_id,
		attempt_id: `${inst1}.1`,
		evidence_ref: `request:${req1.request_id}`,
		reference: "prop-all",
	});

	// Run 2: active run with pending direction request + queued Run 3 + damaged factory_controls (uncertain evidence)
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "run-2", brief: "Second", authority: auth });
	const run2 = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir2 = join(f.cwd, ".pi", "agent-sessions", run2.task_id);
	const file2 = readdirSync(dir2).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const w2 = workerFromConfig(t, join(dir2, file2), { model: sessionModel });
	await w2.start();
	await w2.beforeStart();
	const ask2 = w2.requestDirection({ question: "Proceed 2?", reason: "r2", evidence: ["e2"], choices: ["proceed", "stop"] } as any);
	let req2: any;
	for (let i = 0; i < 100 && !req2; i++) {
		req2 = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!req2) await new Promise(r => setTimeout(r, 20));
	}
	assert.ok(req2);

	const run3 = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "run-3-queued", brief: "Queued third", authority: auth });

	// Corrupt factory_controls digest to add uncertain evidence without breaking run2/req2
	const savedControlDigest = (() => {
		const raw = new DatabaseSync(f.dbPath);
		const row = raw.prepare("SELECT record_digest FROM factory_controls WHERE factory_id = ?").get(fac.factory_id) as { record_digest: string };
		raw.prepare("UPDATE factory_controls SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?").run(fac.factory_id);
		raw.close();
		return row.record_digest;
	})();

	const beforeMain = readFileSync(f.dbPath);
	const beforeCoord = readFileSync(f.coordinationPath);
	let confirmCalls = 0;

	let caught: Error | undefined;
	try {
		await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } });
	} catch (error) {
		caught = error as Error;
	}
	assert.ok(caught);
	assert.match(caught.message, /capacity hold/i);
	assert.match(caught.message, /unsettled run/i);
	assert.match(caught.message, /uncertain evidence/i);
	assert.match(caught.message, /pending direction request/i);
	assert.match(caught.message, /pending constraint proposal/i);
	assert.match(caught.message, /queued input/i);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeMain);
	assert.deepEqual(readFileSync(f.coordinationPath), beforeCoord);

	// No force option bypasses refusal
	await assert.rejects(
		() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, force: true, confirm: async () => { confirmCalls++; return true; } } as any),
		/force/i,
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeMain);
	assert.deepEqual(readFileSync(f.coordinationPath), beforeCoord);

	// Clear every condition in order, then delete succeeds
	{
		const raw = new DatabaseSync(f.dbPath);
		raw.prepare("UPDATE factory_controls SET record_digest = ? WHERE factory_id = ?").run(savedControlDigest, fac.factory_id);
		raw.close();
	}
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: req2.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await ask2;
	await w2.complete({ status: "success", summary: "Done 2", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: run3.input_id, authority: auth, confirm: async () => true });
	await f.open()({ action: "reject_constraint", factory_id: fac.factory_id, proposal_id: prop.proposal.proposal_id, authority: auth, reason: "Not needed", confirm: async () => true });

	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);
	const inspected = f.open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(inspected.deleted, true);
	assert.equal(inspected.queue.length, 3);
});

test("settled run whose revision escalation is uncertain refuses deletion in isolation (no hold, no unsettled run)", async t => {
	const f = deletionFixture(t);
	const fac = f.open()({
		action: "publish",
		name: "uncertain-escalation",
		draft: {
			topology: "graph",
			task: "Decision task",
			project_cwd: f.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "builder",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 1 },
				},
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-unc-ex" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const sub = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "uex-1", brief: "Exhaust", authority: auth });
	const run = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const worker = workerFromConfig(t, join(dir, readdirSync(dir).find(n => n.endsWith(".config.json") && n.includes("build"))!), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Exhausted", detail: "Max revisions" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	const exhaustService = Object.create(f.service);
	exhaustService.directionExhaustions = (ids: any) => {
		if (ids.factory_id !== fac.factory_id) return [];
		return [{
			request_id: "exhaust_uncertain_test",
			factory_id: fac.factory_id,
			input_id: sub.input_id,
			attempt_id: run.attempt_id,
			task_id: run.task_id,
			node_id: "review",
			node_attempt_id: "a1-review.1",
			state: "unknown",
			question: "Loop exhausted",
			reason: "Escalation evidence unavailable",
			evidence: [],
			choices: [],
			created_at: new Date().toISOString(),
			response_recorded: null,
			consumption: "unknown",
			can_respond: false,
			can_redeliver: false,
			reconciliation: "uncertain",
			recovery_reason: "Escalation routing evidence is missing",
			verdict: { state: "unknown" },
			admissions: "unknown",
		}];
	};
	const ops = () => factoryOperations(f.dbPath, exhaustService, { coordinationPath: f.coordinationPath });
	let confirmCalls = 0;
	const beforeBytes = readFileSync(f.dbPath);
	await assert.rejects(
		() => ops()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
		err => err instanceof Error && /uncertain evidence/i.test(err.message) && /Escalation routing evidence is missing/i.test(err.message),
	);
	assert.equal(confirmCalls, 0);
	assert.deepEqual(readFileSync(f.dbPath), beforeBytes);
});

test("confirmed constraint proposal with pending_write or conflict file_sync_state refuses deletion in isolation", async t => {
	const f = deletionFixture(t);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const fac = f.open()({
		action: "publish",
		name: "proposal-sync-blocker",
		draft: {
			topology: "graph",
			task: "Proposal sync run",
			project_cwd: f.cwd,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-sync" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "sync-1", brief: "Run", authority: auth });
	const run = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const workerFile = readdirSync(dir).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const worker = workerFromConfig(t, join(dir, workerFile), { model: sessionModel });
	await worker.start();
	await worker.beforeStart();
	const asked = worker.requestDirection({ question: "Proceed?", reason: "Check", evidence: ["e1"], choices: ["proceed", "stop"] } as any);
	let pendingReq: any;
	for (let i = 0; i < 100 && !pendingReq; i++) {
		pendingReq = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!pendingReq) await new Promise(r => setTimeout(r, 20));
	}
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: pendingReq.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await asked;
	await worker.complete({ status: "success", summary: "Done", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	const instanceId = JSON.parse(readFileSync(join(dir, workerFile), "utf8")).instance_id as string;
	const prop = f.open()({
		action: "propose_constraint",
		factory_id: fac.factory_id,
		authority: auth,
		text: "Keep durable constraint sync clean",
		run_id: run.task_id,
		attempt_id: `${instanceId}.1`,
		evidence_ref: `request:${pendingReq.request_id}`,
		reference: "prop-sync",
	});
	await f.open()({ action: "confirm_constraint", factory_id: fac.factory_id, proposal_id: prop.proposal.proposal_id, authority: auth, confirm: async () => true });

	for (const syncState of ["pending_write", "conflict"] as const) {
		const raw = new DatabaseSync(f.dbPath);
		const stored = raw.prepare("SELECT * FROM factory_constraint_proposals WHERE proposal_id = ?").get(prop.proposal.proposal_id) as any;
		const updated = buildProposalRow({
			...stored,
			file_sync_state: syncState,
			sync_error: syncState === "conflict" ? "Conflicting concurrent edit to .pi/constraints.json" : null,
			resolved_at: null,
			resolved_by: null,
		});
		updateProposalRow(raw, updated);
		raw.close();

		let confirmCalls = 0;
		const beforeBytes = readFileSync(f.dbPath);
		await assert.rejects(
			() => f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => { confirmCalls++; return true; } }),
			err => err instanceof Error && /uncertain evidence/i.test(err.message) && new RegExp(syncState === "conflict" ? "Conflicting concurrent edit" : "pending durable write", "i").test(err.message),
		);
		assert.equal(confirmCalls, 0);
		assert.deepEqual(readFileSync(f.dbPath), beforeBytes);
	}
});

test("contradiction on a sibling factory's shared-checkout hold or healthy foreign hold does not block this factory's deletion", async t => {
	const f = deletionFixture(t);
	const dbAPath = join(f.root, "factories-a.sqlite");
	const dbBPath = join(f.root, "factories-b.sqlite");
	const dbCPath = join(f.root, "factories-c.sqlite");
	const openA = () => factoryOperations(dbAPath, f.service, { coordinationPath: f.coordinationPath });
	const openB = () => factoryOperations(dbBPath, f.service, { coordinationPath: f.coordinationPath });
	const openC = () => factoryOperations(dbCPath, f.service, { coordinationPath: f.coordinationPath });

	const sharedDraft = (task: string) => ({
		topology: "graph" as const,
		task,
		project_cwd: f.cwd,
		agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }],
	});

	// Factory A holds the shared checkout normally
	const facA = openA()({ action: "publish", name: "sibling-a", draft: sharedDraft("A"), sessionModel });
	const authA = createManagerAuthority({ pi_session_id: "mgr-a" });
	openA()({ action: "resume", factory_id: facA.factory_id, authority: authA });
	openA()({ action: "submit", factory_id: facA.factory_id, reference: "a-1", brief: "A work", authority: authA });
	await openA()({ action: "launch", factory_id: facA.factory_id, authority: authA });

	// Healthy foreign hold does not block Factory B on the same checkout
	const facB = openB()({ action: "publish", name: "idle-b", draft: sharedDraft("B"), sessionModel });
	const authB = createManagerAuthority({ pi_session_id: "mgr-b" });
	openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
	assert.equal(openB()({ action: "inspect", factory_id: facB.factory_id }).capacity.checkout_slot, "held");
	const deletedB = await openB()({ action: "delete", factory_id: facB.factory_id, authority: authB, confirm: async () => true });
	assert.equal(deletedB.deleted, true);

	// Tamper foreign hold (delete Factory A's DB so foreign hold proof fails and inspect reports uncertainty)
	rmSync(dbAPath);
	const facC = openC()({ action: "publish", name: "idle-c", draft: sharedDraft("C"), sessionModel });
	const authC = createManagerAuthority({ pi_session_id: "mgr-c" });
	openC()({ action: "resume", factory_id: facC.factory_id, authority: authC });
	const inspectedC = openC()({ action: "inspect", factory_id: facC.factory_id });
	assert.ok(inspectedC.uncertainty.length > 0, "inspect surfaces foreign hold contradiction on shared checkout");
	const deletedC = await openC()({ action: "delete", factory_id: facC.factory_id, authority: authC, confirm: async () => true });
	assert.equal(deletedC.deleted, true);

	// Also test orphaned managed_run from another factory (clear checkout_holds leaving foreign managed_runs row)
	const dbDPath = join(f.root, "factories-d.sqlite");
	const openD = () => factoryOperations(dbDPath, f.service, { coordinationPath: f.coordinationPath });
	{
		const coordDb = new DatabaseSync(f.coordinationPath);
		coordDb.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(facA.factory_id);
		coordDb.close();
	}
	const facD = openD()({ action: "publish", name: "idle-d", draft: sharedDraft("D"), sessionModel });
	const authD = createManagerAuthority({ pi_session_id: "mgr-d" });
	openD()({ action: "resume", factory_id: facD.factory_id, authority: authD });
	const inspectedD = openD()({ action: "inspect", factory_id: facD.factory_id });
	assert.ok(inspectedD.uncertainty.some(u => /orphaned coordination managed_run/i.test(u)));
	const deletedD = await openD()({ action: "delete", factory_id: facD.factory_id, authority: authD, confirm: async () => true });
	assert.equal(deletedD.deleted, true);
});

test("replacing or removing manager authority during confirmation reaches commit-time authority check and fails with inspect again", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("manager-race");
	const auth = createManagerAuthority({ pi_session_id: "mgr-orig" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Pre-confirm refusal is clearly distinguishable from a commit-time failure
	const wrongAuth = createManagerAuthority({ pi_session_id: "mgr-wrong" });
	let preConfirmErr: Error | undefined;
	try {
		await f.open()({ action: "delete", factory_id: fac.factory_id, authority: wrongAuth, confirm: async () => true });
	} catch (error) {
		preConfirmErr = error as Error;
	}
	assert.ok(preConfirmErr);
	assert.doesNotMatch(preConfirmErr.message, /inspect again|changed during confirmation/i);

	// Case 1: manager row is replaced in SQLite while confirm prompt is open (live auth not revoked, so commitManager check is reached)
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: fac.factory_id,
			authority: auth,
			confirm: async () => {
				const raw = new DatabaseSync(f.dbPath);
				const current = raw.prepare("SELECT * FROM factory_managers WHERE factory_id = ?").get(fac.factory_id) as any;
				const replacement = {
					factory_id: fac.factory_id,
					incarnation_id: `${current.incarnation_id.split("|")[0]}|${current.incarnation_id.split("|")[1]}|999999|1`,
					authority_digest: "1".repeat(64),
					pi_session_id: "mgr-takeover",
					pi_session_file: null,
					pid: 999999,
					resumed_at: new Date().toISOString(),
				};
				raw.prepare(
					"UPDATE factory_managers SET incarnation_id = ?, authority_digest = ?, pi_session_id = ?, pi_session_file = ?, pid = ?, resumed_at = ?, record_digest = ? WHERE factory_id = ?",
				).run(
					replacement.incarnation_id,
					replacement.authority_digest,
					replacement.pi_session_id,
					replacement.pi_session_file,
					replacement.pid,
					replacement.resumed_at,
					managerRecordDigest(replacement),
					fac.factory_id,
				);
				raw.close();
				return true;
			},
		}),
		err => err instanceof Error && /changed during confirmation/i.test(err.message) && /inspect again/i.test(err.message),
	);

	// Verify no deletion row was written
	const rawCheck = new DatabaseSync(f.dbPath, { readOnly: true });
	try {
		assert.equal(rawCheck.prepare("SELECT COUNT(*) AS n FROM factory_deletions WHERE factory_id = ?").get(fac.factory_id)?.n, 0);
	} finally {
		rawCheck.close();
	}
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);
});

test("concurrent double delete: nested delete inside confirm wins and outer delete returns already_deleted with one row", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("double-delete-race");
	const auth = createManagerAuthority({ pi_session_id: "mgr-double" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	let innerResult: Awaited<ReturnType<ReturnType<typeof f.open>>> | undefined;
	const outerResult = await f.open()({
		action: "delete",
		factory_id: fac.factory_id,
		authority: auth,
		confirm: async () => {
			innerResult = await f.open()({
				action: "delete",
				factory_id: fac.factory_id,
				authority: auth,
				confirm: async () => true,
			});
			return true;
		},
	});

	assert.ok(innerResult);
	assert.equal(innerResult.deleted, true);
	assert.equal(innerResult.already_deleted, false);

	assert.equal(outerResult.deleted, true);
	assert.equal(outerResult.already_deleted, true);
	assert.match(outerResult.message, /already deleted/i);
	assert.deepEqual(outerResult.deletion, innerResult.deletion);

	const rawCheck = new DatabaseSync(f.dbPath, { readOnly: true });
	try {
		const rows = rawCheck.prepare("SELECT * FROM factory_deletions WHERE factory_id = ?").all(fac.factory_id);
		assert.equal(rows.length, 1);
	} finally {
		rawCheck.close();
	}
});

test("commit-time revalidation fails with inspect again when a hold, unsettled run, pending request, pending proposal, or version update arises during confirmation, and never-stopped factory deletes cleanly", async t => {
	const f = deletionFixture(t);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const fac = f.open()({
		action: "publish",
		name: "race-preconditions",
		draft: {
			topology: "graph",
			task: "Race preconditions",
			project_cwd: f.cwd,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-race-pre" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Finish and settle run 1 (factory is never stopped)
	f.open()({ action: "submit", factory_id: fac.factory_id, reference: "r-1", brief: "First", authority: auth });
	const run1 = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir1 = join(f.cwd, ".pi", "agent-sessions", run1.task_id);
	const file1 = readdirSync(dir1).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const w1 = workerFromConfig(t, join(dir1, file1), { model: sessionModel });
	await w1.start();
	await w1.beforeStart();
	const ask1 = w1.requestDirection({ question: "Proceed?", reason: "Check", evidence: ["e1"], choices: ["proceed", "stop"] } as any);
	let req1: any;
	for (let i = 0; i < 100 && !req1; i++) {
		req1 = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!req1) await new Promise(r => setTimeout(r, 20));
	}
	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: req1.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await ask1;
	await w1.complete({ status: "success", summary: "Done 1", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);
	const inst1 = JSON.parse(readFileSync(join(dir1, file1), "utf8")).instance_id as string;

	// Case 1: pending constraint proposal introduced during confirm (no hold, no unsettled run, no queued input)
	let propId = "";
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: fac.factory_id,
			authority: auth,
			confirm: async () => {
				const prop = f.open()({
					action: "propose_constraint",
					factory_id: fac.factory_id,
					authority: auth,
					text: "Revalidate proposals at commit",
					run_id: run1.task_id,
					attempt_id: `${inst1}.1`,
					evidence_ref: `request:${req1.request_id}`,
					reference: "prop-race",
				});
				propId = prop.proposal.proposal_id;
				return true;
			},
		}),
		err => err instanceof Error && /changed during confirmation; inspect again/i.test(err.message) && /pending constraint proposal/i.test(err.message),
	);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);

	// Pre-confirm refusal is clearly distinguishable from a commit-time failure
	let refusalErr: Error | undefined;
	try {
		await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	} catch (error) {
		refusalErr = error as Error;
	}
	assert.ok(refusalErr);
	assert.match(refusalErr.message, /^Cannot delete factory/i);
	assert.doesNotMatch(refusalErr.message, /changed during confirmation|inspect again/i);

	await f.open()({ action: "reject_constraint", factory_id: fac.factory_id, proposal_id: propId, authority: auth, reason: "Cleared", confirm: async () => true });

	// Case 2: hold + unsettled run + pending direction request introduced during confirm
	let ask2: Promise<any> | undefined;
	let req2: any;
	let w2: ReturnType<typeof workerFromConfig> | undefined;
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: fac.factory_id,
			authority: auth,
			confirm: async () => {
				f.open()({ action: "submit", factory_id: fac.factory_id, reference: "r-2", brief: "Second", authority: auth });
				const run2 = await f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
				const dir2 = join(f.cwd, ".pi", "agent-sessions", run2.task_id);
				const file2 = readdirSync(dir2).find(n => n.endsWith(".config.json") && n.includes("build"))!;
				w2 = workerFromConfig(t, join(dir2, file2), { model: sessionModel });
				await w2.start();
				await w2.beforeStart();
				ask2 = w2.requestDirection({ question: "Proceed 2?", reason: "Check", evidence: ["e2"], choices: ["proceed", "stop"] } as any);
				for (let i = 0; i < 100 && !req2; i++) {
					req2 = (f.open()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
					if (!req2) await new Promise(r => setTimeout(r, 20));
				}
				assert.ok(req2);
				return true;
			},
		}),
		err =>
			err instanceof Error
			&& /changed during confirmation; inspect again/i.test(err.message)
			&& /capacity hold/i.test(err.message)
			&& /unsettled run/i.test(err.message)
			&& /pending direction request/i.test(err.message),
	);
	assert.equal(f.open()({ action: "inspect", factory_id: fac.factory_id }).deleted, false);

	f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: req2.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await ask2;
	await w2!.complete({ status: "success", summary: "Done 2", detail: "Ok" });
	assert.equal((await f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	// Case 3: factory definition update during confirm fails with inspect again
	await assert.rejects(
		() => f.open()({
			action: "delete",
			factory_id: fac.factory_id,
			authority: auth,
			confirm: async () => {
				f.open()({
					action: "update",
					factory_id: fac.factory_id,
					authority: auth,
					draft: {
						topology: "graph",
						task: "Updated during confirm",
						project_cwd: f.cwd,
						agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
					},
					sessionModel,
				});
				return true;
			},
		}),
		err => err instanceof Error && /changed during confirmation; inspect again/i.test(err.message),
	);

	// Verify factory was never stopped and deletes cleanly with no extra step
	const inspectedBefore = f.open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(inspectedBefore.stopped, false);
	assert.equal(inspectedBefore.deleted, false);
	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);

	const rawCheck = new DatabaseSync(f.dbPath, { readOnly: true });
	try {
		assert.equal(rawCheck.prepare("SELECT COUNT(*) AS n FROM factory_deletions WHERE factory_id = ?").get(fac.factory_id)?.n, 1);
	} finally {
		rawCheck.close();
	}
});

test("after delete commits, submit, launch, and retry_launch are rejected as deleted within fenced transaction semantics", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("closed-after-delete");
	const auth = createManagerAuthority({ pi_session_id: "mgr-after" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const sub0 = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "prior-ref", brief: "Discarded work", authority: auth });
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: sub0.input_id, authority: auth, confirm: async () => true });

	// At delete after_commit boundary, submit and launch are already rejected as deleted
	let afterCommitSubmitErr: unknown;
	let afterCommitLaunchErr: unknown;
	const deletingOps = factoryOperations(f.dbPath, f.service, {
		coordinationPath: f.coordinationPath,
		atCommit: phase => {
			if (phase === "after_commit") {
				try {
					f.open()({ action: "submit", factory_id: fac.factory_id, reference: "post-del-1", brief: "Too late", authority: auth });
				} catch (err) {
					afterCommitSubmitErr = err;
				}
				// Synchronous pre-flight error or async rejection on launch
				f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth }).catch(err => {
					afterCommitLaunchErr = err;
				});
			}
		},
	});
	const deleted = await deletingOps({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);

	assert.ok(afterCommitSubmitErr instanceof Error);
	assert.match(afterCommitSubmitErr.message, /this factory is deleted/i);
	await new Promise(r => setTimeout(r, 20));
	assert.ok(afterCommitLaunchErr instanceof Error);
	assert.match(afterCommitLaunchErr.message, /this factory is deleted/i);

	const snapshotAfterDelete = readFileSync(f.dbPath);

	// New submission, exact-reference retry submission, launch, and retry_launch are all rejected as deleted
	assert.throws(
		() => f.open()({ action: "submit", factory_id: fac.factory_id, reference: "post-del-2", brief: "New work", authority: auth }),
		/this factory is deleted/i,
	);
	assert.throws(
		() => f.open()({ action: "submit", factory_id: fac.factory_id, reference: "prior-ref", brief: "Discarded work", authority: auth }),
		/this factory is deleted/i,
	);
	await assert.rejects(
		() => f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth }),
		/this factory is deleted/i,
	);
	await assert.rejects(
		() => f.open()({ action: "retry_launch", factory_id: fac.factory_id, input_id: sub0.input_id, previous_attempt_id: "att-none", confirmed: true, authority: auth }),
		/this factory is deleted/i,
	);
	assert.deepEqual(readFileSync(f.dbPath), snapshotAfterDelete);

	// Even if launch passed pre-flight before delete committed, reserveAttempt's BEGIN IMMEDIATE transaction rejects as deleted
	const facRace = f.publish("launch-reserve-race");
	const raceAuth = createManagerAuthority({ pi_session_id: "mgr-launch-race" });
	f.open()({ action: "resume", factory_id: facRace.factory_id, authority: raceAuth });
	const q = f.open()({ action: "submit", factory_id: facRace.factory_id, reference: "race-q", brief: "Work", authority: raceAuth });

	const racingService = Object.create(f.service);
	racingService.launchFromDefinition = async (opts: any) => {
		// Discard and delete while launch is between pre-flight and reserveAttempt
		await f.open()({ action: "discard", factory_id: facRace.factory_id, input_id: q.input_id, authority: raceAuth, confirm: async () => true });
		const del = await f.open()({ action: "delete", factory_id: facRace.factory_id, authority: raceAuth, confirm: async () => true });
		assert.equal(del.deleted, true);
		return f.service.launchFromDefinition!(opts);
	};
	const raceOps = factoryOperations(f.dbPath, racingService, { coordinationPath: f.coordinationPath });
	await assert.rejects(
		() => raceOps({ action: "launch", factory_id: facRace.factory_id, authority: raceAuth }),
		/this factory is deleted/i,
	);
	assert.equal(f.open()({ action: "inspect", factory_id: facRace.factory_id }).attempts.length, 0);
});

test("every mutating factory operation is refused with a single-sentence 'this factory is deleted' error and leaves records unchanged", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("all-mutations-closed", "Initial");
	const auth = createManagerAuthority({ pi_session_id: "mgr-closed-all" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	f.open()({ action: "update", factory_id: fac.factory_id, draft: f.draft("Updated"), authority: auth, sessionModel });
	const sub = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "closed-ref", brief: "Before delete", authority: auth });
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: sub.input_id, authority: auth, confirm: async () => true });

	const deleted = await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(deleted.deleted, true);

	const beforeMain = readFileSync(f.dbPath);
	const beforeCoord = existsSync(f.coordinationPath) ? readFileSync(f.coordinationPath) : undefined;

	// Exhaustive classification of every action dispatched in factory/operations.ts.
	// If a new mutating action is added there, this test fails until it is classified and proven guarded.
	const opsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "factory", "operations.ts"), "utf8");
	const discoveredActions = new Set<string>();
	for (const match of opsSource.matchAll(/request\.action\s*===\s*"([a-z_]+)"/g)) {
		discoveredActions.add(match[1]!);
	}

	let confirmCalls = 0;
	const neverConfirm = async () => {
		confirmCalls++;
		return true;
	};
	const neverConfirmClearance = async () => {
		confirmCalls++;
		return { reason: "r", evidence: "e", acknowledged_unknown_effects: true };
	};
	const neverConfirmRetire = async () => {
		confirmCalls++;
		return { reason: "r" };
	};
	const neverConfirmConflict = async () => {
		confirmCalls++;
		return { resolution: "abandon" as const };
	};

	const mutatingCalls: Record<string, () => Promise<unknown> | unknown> = {
		update: () => f.open()({ action: "update", factory_id: fac.factory_id, draft: f.draft("After delete"), authority: auth, sessionModel }),
		restore: () => f.open()({ action: "restore", factory_id: fac.factory_id, from_version: "v1", authority: auth }),
		resume: () => f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth }),
		takeover: () => f.open()({ action: "takeover", factory_id: fac.factory_id, authority: auth, confirmed_manager_incarnation_id: auth.incarnation_id }),
		stop: () => f.open()({ action: "stop", factory_id: fac.factory_id, authority: auth }),
		discard: () => f.open()({ action: "discard", factory_id: fac.factory_id, input_id: sub.input_id, authority: auth, confirm: neverConfirm }),
		submit: () => f.open()({ action: "submit", factory_id: fac.factory_id, reference: "new-ref", brief: "Too late", authority: auth }),
		launch: () => f.open()({ action: "launch", factory_id: fac.factory_id, authority: auth }),
		retry_launch: () => f.open()({ action: "retry_launch", factory_id: fac.factory_id, input_id: sub.input_id, previous_attempt_id: "att-none", confirmed: true, authority: auth }),
		cancel_run: () => f.open()({ action: "cancel_run", factory_id: fac.factory_id, input_id: sub.input_id, attempt_id: "att-none", task_id: "task-none", authority: auth, confirm: neverConfirm }),
		settle_run: () => f.open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth }),
		clear_hold: () => f.open()({ action: "clear_hold", factory_id: fac.factory_id, input_id: sub.input_id, attempt_id: "att-none", task_id: "task-none", authority: auth, confirm: neverConfirmClearance }),
		redeliver_handoff: () => f.open()({ action: "redeliver_handoff", factory_id: fac.factory_id, authority: auth, agent: "build" }),
		respond_request: () => f.open()({ action: "respond_request", factory_id: fac.factory_id, request_id: "req-none", response: { kind: "decline" }, authority: auth }),
		redeliver_response: () => f.open()({ action: "redeliver_response", factory_id: fac.factory_id, request_id: "req-none", authority: auth }),
		propose_constraint: () => f.open()({ action: "propose_constraint", factory_id: fac.factory_id, authority: auth, text: "Never mutate deleted", run_id: "run-none", attempt_id: "att-none", evidence_ref: "result:none" }),
		confirm_constraint: () => f.open()({ action: "confirm_constraint", factory_id: fac.factory_id, proposal_id: "cprop_none", authority: auth, confirm: neverConfirm }),
		reject_constraint: () => f.open()({ action: "reject_constraint", factory_id: fac.factory_id, proposal_id: "cprop_none", authority: auth, confirm: neverConfirm }),
		retire_constraint: () => f.open()({ action: "retire_constraint", factory_id: fac.factory_id, constraint_id: "c-none", authority: auth, confirm: neverConfirmRetire }),
		resolve_constraint_conflict: () => f.open()({ action: "resolve_constraint_conflict", factory_id: fac.factory_id, proposal_id: "cprop_none", authority: auth, confirm: neverConfirmConflict }),
	};
	const nonMutatingActions = new Set([
		"list", "identities", "inspect", "publication_target", "receipt", "verify_manager",
		"binding", "requests", "proposals", "publish", "delete",
	]);

	for (const action of discoveredActions) {
		assert.ok(
			action in mutatingCalls || nonMutatingActions.has(action),
			`Unclassified action "${action}" in factory/operations.ts; classify it and guard it if mutating`,
		);
	}

	for (const [action, invoke] of Object.entries(mutatingCalls)) {
		let caught: unknown;
		try {
			await invoke();
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof Error, `Expected "${action}" to fail on a deleted factory`);
		assert.match(caught.message, /this factory is deleted/i, `${action}: ${caught.message}`);
		assert.equal(
			(caught.message.match(/deleted/gi) ?? []).length,
			1,
			`Error message for "${action}" should not repeat "deleted": ${caught.message}`,
		);
	}

	assert.equal(confirmCalls, 0, "No confirmation callback should run on a deleted factory");
	assert.deepEqual(readFileSync(f.dbPath), beforeMain, "Main DB must stay byte-for-byte unchanged");
	if (beforeCoord !== undefined) {
		assert.deepEqual(readFileSync(f.coordinationPath), beforeCoord, "Coord DB must stay byte-for-byte unchanged");
	}
});

test("commit-time deletion during confirm fences async mutations and damaged deletion record fails closed", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("commit-race-deleted", "Initial");
	const auth = createManagerAuthority({ pi_session_id: "mgr-commit-race" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const queued = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "race-q", brief: "Wait", authority: auth });

	// During discard's confirm(), delete the factory after discarding via a nested call; outer discard commit must fail as deleted
	await assert.rejects(
		() => f.open()({
			action: "discard",
			factory_id: fac.factory_id,
			input_id: queued.input_id,
			authority: auth,
			confirm: async () => {
				await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: queued.input_id, authority: auth, confirm: async () => true });
				await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
				return true;
			},
		}),
		/this factory is deleted/i,
	);

	// Damaged factory_deletions record fails closed across mutations and reads
	const raw = new DatabaseSync(f.dbPath);
	raw.prepare("UPDATE factory_deletions SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?").run(fac.factory_id);
	raw.close();
	const damagedSnapshot = readFileSync(f.dbPath);

	assert.throws(() => f.open()({ action: "stop", factory_id: fac.factory_id, authority: auth }), /deletion.*mismatch|corruption/i);
	assert.throws(() => f.open()({ action: "inspect", factory_id: fac.factory_id }), /deletion.*mismatch|corruption/i);
	assert.throws(() => f.open()({ action: "receipt", factory_id: fac.factory_id, input_id: queued.input_id }), /deletion.*mismatch|corruption/i);
	assert.throws(() => f.open()({ action: "requests", factory_id: fac.factory_id }), /deletion.*mismatch|corruption/i);
	assert.deepEqual(readFileSync(f.dbPath), damagedSnapshot);
});

test("every mutating /factory command and factory_propose_constraint refuses a deleted factory by UUID and by name without prompting", async t => {
	const f = deletionFixture(t);
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const stateDir = join(f.root, "cmd-mutations-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
	});

	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);

	const storePath = join(stateDir, "factories.sqlite");
	const cmdOps = () => factoryOperations(storePath, f.service);
	const fac = cmdOps()({ action: "publish", name: "cmd-retired-fac", draft: f.draft("Initial"), sessionModel });

	const notes: Array<{ message: string; level: string }> = [];
	let promptCalls = 0;
	const ctx = {
		hasUI: true,
		cwd: f.cwd,
		isProjectTrusted: () => true,
		ui: {
			notify: (message: string, level = "info") => notes.push({ message, level }),
			confirm: async () => { promptCalls++; return true; },
			input: async () => { promptCalls++; return "cmd-retired-fac"; },
			editor: async () => { promptCalls++; return "{}"; },
			select: async () => { promptCalls++; return undefined; },
			setStatus: () => {},
		},
		sessionManager: { getSessionId: () => "cmd-mut-sess", getSessionFile: () => undefined },
	};
	const factoryCmd = commands.get("factory")!;

	// Resume, submit, discard, and delete via command
	await factoryCmd.handler(`resume ${fac.factory_id}`, ctx);
	const submitCtx = {
		...ctx,
		ui: { ...ctx.ui, editor: async () => "To be discarded" },
	};
	await factoryCmd.handler(`submit ${fac.factory_id} ref-cmd-del`, submitCtx);
	const subReceipt = JSON.parse(notes.at(-1)!.message) as { input_id: string };
	await factoryCmd.handler(`discard ${fac.factory_id} ${subReceipt.input_id}`, ctx);
	await factoryCmd.handler(`delete ${fac.factory_id}`, ctx);
	assert.equal(cmdOps()({ action: "inspect", factory_id: fac.factory_id }).deleted, true);

	const beforeBytes = readFileSync(storePath);
	promptCalls = 0;

	// Enumerate FACTORY_SUBCOMMANDS from bootstrap.ts so newly added mutating subcommands cannot bypass this test.
	const bootstrapSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bootstrap.ts"), "utf8");
	const subBlock = bootstrapSource.match(/const FACTORY_SUBCOMMANDS\s*=\s*\[([\s\S]*?)\]\s*as const/);
	assert.ok(subBlock, "Expected FACTORY_SUBCOMMANDS array in bootstrap.ts");
	const discoveredSubcommands = [...subBlock[1]!.matchAll(/"([a-z-]+)"/g)].map(m => m[1]!);

	const mutatingSubcommandArgs: Record<string, (target: string) => string> = {
		update: target => `update ${target}`,
		restore: target => `restore ${target} v1`,
		resume: target => `resume ${target}`,
		takeover: target => `takeover ${target}`,
		stop: target => `stop ${target}`,
		discard: target => `discard ${target} ${subReceipt.input_id}`,
		submit: target => `submit ${target} ref-too-late`,
		launch: target => `launch ${target}`,
		retry: target => `retry ${target} ${subReceipt.input_id} att-none`,
		cancel: target => `cancel ${target}`,
		settle: target => `settle ${target}`,
		clear: target => `clear ${target}`,
		redeliver: target => `redeliver ${target} build`,
		respond: target => `respond ${target} req-none`,
		wake: target => `wake ${target} req-none`,
		"review-proposal": target => `review-proposal ${target} cprop_none`,
		"retire-constraint": target => `retire-constraint ${target} c-none`,
		"resolve-conflict": target => `resolve-conflict ${target} cprop_none`,
	};
	const nonMutatingSubcommands = new Set(["list", "inspect", "queue", "receipt", "viewer", "requests", "proposals", "publish", "delete"]);

	for (const sub of discoveredSubcommands) {
		assert.ok(
			sub in mutatingSubcommandArgs || nonMutatingSubcommands.has(sub),
			`Unclassified /factory subcommand "${sub}" in bootstrap.ts; classify it and guard it if mutating`,
		);
	}

	for (const target of [fac.factory_id, "cmd-retired-fac"]) {
		for (const [sub, formatArgs] of Object.entries(mutatingSubcommandArgs)) {
			notes.length = 0;
			await factoryCmd.handler(formatArgs(target), ctx);
			const last = notes.at(-1);
			assert.ok(last, `Expected notification for /factory ${sub} (${target})`);
			assert.equal(last.level, "error", `Expected error notification for /factory ${sub} (${target}), got: ${last.message}`);
			assert.match(last.message, /this factory is deleted/i, `/factory ${sub} (${target}): ${last.message}`);
			assert.equal(
				(last.message.match(/deleted/gi) ?? []).length,
				1,
				`Error message for /factory ${sub} should not repeat "deleted": ${last.message}`,
			);
		}
	}

	// factory_propose_constraint tool also refuses a deleted factory
	const proposeTool = tools.get("factory_propose_constraint");
	assert.ok(proposeTool);
	const propRes = await proposeTool.execute(
		"call-del-prop",
		{
			factory_id: fac.factory_id,
			run_id: "run-none",
			attempt_id: "att-none",
			evidence_ref: "result:none",
			text: "Do not mutate deleted factories",
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(propRes.isError, true);
	assert.match(propRes.content[0].text, /this factory is deleted/i);

	assert.equal(promptCalls, 0, "No UI prompt (confirm/input/editor/select) may run for deleted factory mutations");
	assert.deepEqual(readFileSync(storePath), beforeBytes, "Factory store must stay byte-for-byte unchanged");
});

test("periodic launch watcher and scheduler take no action on a deleted factory (never launch or settle)", async t => {
	const f = deletionFixture(t);
	const fac = f.publish("watcher-deleted");
	const auth = createManagerAuthority({ pi_session_id: "mgr-watch" });
	f.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const sub = f.open()({ action: "submit", factory_id: fac.factory_id, reference: "w-1", brief: "Before delete", authority: auth });
	await f.open()({ action: "discard", factory_id: fac.factory_id, input_id: sub.input_id, authority: auth, confirm: async () => true });
	await f.open()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });

	const { createFactoryQueueScheduler } = await import("../factory/scheduler.ts");
	const beforeMain = readFileSync(f.dbPath);
	const calledActions: string[] = [];
	const spyFactory = new Proxy(f.open(), {
		apply(target, thisArg, args) {
			calledActions.push(args[0].action);
			return Reflect.apply(target, thisArg, args);
		},
	});
	const scheduler = createFactoryQueueScheduler({ factory: spyFactory, factoryId: fac.factory_id, authority: auth });
	await scheduler.advance();
	assert.deepEqual(calledActions, ["inspect"]);
	assert.deepEqual(readFileSync(f.dbPath), beforeMain);

	// Even if inspect reports a settleable attempt and an eligible head alongside deleted: true,
	// the scheduler must refuse to call settle_run or launch.
	calledActions.length = 0;
	const syntheticDeletedFactory = new Proxy(f.open(), {
		apply(target, thisArg, args) {
			calledActions.push(args[0].action);
			const res = Reflect.apply(target, thisArg, args);
			if (args[0].action === "inspect") {
				return {
					...res,
					deleted: true,
					factory: { ...res.factory, management: "managed" },
					attempts: [{
						attempt_id: "att-syn",
						factory_id: fac.factory_id,
						input_id: sub.input_id,
						bound_version: "v1",
						request_id: "req-syn",
						task_id: "task-syn",
						canonical_checkout: f.cwd,
						state: "released",
						release_authorized: true,
						release_authorized_at: new Date().toISOString(),
						error: null,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						settlement: {
							evidence_unreadable: false,
							cancellation: { intent: "none" },
							resource_closure: { state: "closed", recorded_closed: [], not_recorded_closed: [] },
							execution_settlement: { state: "settled", reason: "done" },
							outcome: "succeeded",
							resume_risk: [],
							attention: [],
							capacity_release: "held",
						},
					}],
					head_status: { eligible: true, input_id: sub.input_id, reference: "w-1", bound_version: "v1" },
					uncertainty: [],
				};
			}
			return res;
		},
	});
	const gatedScheduler = createFactoryQueueScheduler({ factory: syntheticDeletedFactory, factoryId: fac.factory_id, authority: auth });
	await gatedScheduler.advance();
	assert.deepEqual(calledActions, ["inspect"], "scheduler must never call settle_run or launch when view.deleted is true");

	// Also verify bootstrap's periodic watcher (pollFactories) stops acting once deleted externally
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const stateDir = join(f.root, "watcher-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
	});
	t.mock.timers.enable({ apis: ["setInterval"] });

	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, any>();
	const hooks = new Map<string, Array<(...args: any[]) => any>>();
	registerBootstrap({
		registerTool: () => {},
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: (event: string, fn: (...args: any[]) => any) => {
			const list = hooks.get(event) ?? [];
			list.push(fn);
			hooks.set(event, list);
		},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);

	const storePath = join(stateDir, "factories.sqlite");
	const watchOps = () => factoryOperations(storePath, f.service);
	const watched = watchOps()({ action: "publish", name: "watched-fac", draft: f.draft("Watched"), sessionModel });
	const notes: Array<{ message: string; level: string }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		cwd: f.cwd,
		isProjectTrusted: () => true,
		ui: {
			notify: (message: string, level = "info") => notes.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
		},
		sessionManager: { getSessionId: () => "watch-sess", getSessionFile: () => undefined },
	};
	t.after(async () => {
		for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
	});

	await commands.get("factory")!.handler(`resume ${watched.factory_id}`, ctx);
	const resumedNotes = JSON.parse(notes.at(-1)!.message);
	assert.equal(resumedNotes.resumed, true);
	// Now delete via direct operations (not /factory delete), while the periodic watcher is still active
	const watchAuth = createManagerAuthority({ pi_session_id: "watch-sess" });
	// Takeover/delete or delete using same session? Use /factory delete or update DB via direct delete after takeover?
	// Wait: /factory resume used bootstrap.ts's internal authority, so let's delete via /factory delete OR trigger takeover?
	// Wait: /factory delete clears watchedFactories synchronously; to test pollFactories seeing a deleted factory externally,
	// we can insert a valid deletion row or use a second watch? Even simpler: build a valid deletion row using buildFactoryDeletionRow!
	const { buildFactoryDeletionRow } = await import("./factory-records.ts");
	{
		const raw = new DatabaseSync(storePath);
		const mgr = raw.prepare("SELECT * FROM factory_managers WHERE factory_id = ?").get(watched.factory_id) as any;
		const delRow = buildFactoryDeletionRow({
			factory_id: watched.factory_id,
			deleted_at: new Date().toISOString(),
			incarnation_id: mgr.incarnation_id,
			pi_session_id: mgr.pi_session_id,
			pi_session_file: mgr.pi_session_file,
			pid: mgr.pid,
		});
		raw.prepare(
			"INSERT INTO factory_deletions (factory_id, deleted_at, incarnation_id, pi_session_id, pi_session_file, pid, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(delRow.factory_id, delRow.deleted_at, delRow.incarnation_id, delRow.pi_session_id, delRow.pi_session_file, delRow.pid, delRow.record_digest);
		raw.close();
	}
	notes.length = 0;
	statuses.length = 0;
	t.mock.timers.tick(3500);
	await new Promise(r => setImmediate(r));
	assert.equal(notes.some(n => n.level === "error"), false, `Watcher must not emit errors on deleted factory: ${JSON.stringify(notes)}`);
	assert.ok(statuses.some(([k, v]) => k === `factory-${watched.factory_id}` && v === undefined), "Watcher must clear status for deleted factory");
});

test("inspect, receipt, queue, requests, factory_inspect tool, and every retained version stay readable on a deleted factory by UUID and name", async t => {
	const f = deletionFixture(t);
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const stateDir = join(f.root, "reads-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
	});

	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);

	const storePath = join(stateDir, "factories.sqlite");
	const ops = () => factoryOperations(storePath, f.service);
	const choices = [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }];
	const versionDraft = (task: string) => ({
		topology: "graph",
		task,
		project_cwd: f.cwd,
		agents: [{ node_id: "build", persona: "builder", sub_task: "Build", intervention: { choices } }] as any,
	});
	const fac = ops()({ action: "publish", name: "readable-retired", draft: versionDraft("Task v1"), sessionModel });
	ops()({ action: "update", factory_id: fac.factory_id, draft: versionDraft("Task v2"), sessionModel });
	ops()({ action: "restore", factory_id: fac.factory_id, from_version: "v1" });

	const auth = createManagerAuthority({ pi_session_id: "mgr-reads" });
	ops()({ action: "resume", factory_id: fac.factory_id, authority: auth });

	// Input 1: launched on v3, triggers direction request, answered, completed, settled
	const sub1 = ops()({ action: "submit", factory_id: fac.factory_id, reference: "read-ref-1", brief: "Run 1", authority: auth });
	const run1 = await ops()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir1 = join(f.cwd, ".pi", "agent-sessions", run1.task_id);
	const file1 = readdirSync(dir1).find(n => n.endsWith(".config.json") && n.includes("build"))!;
	const w1 = workerFromConfig(t, join(dir1, file1), { model: sessionModel });
	await w1.start();
	await w1.beforeStart();
	const asked = w1.requestDirection({ question: "Proceed?", reason: "Check", evidence: ["e1"], choices: ["proceed", "stop"] } as any);
	let pendingReq: any;
	for (let i = 0; i < 100 && !pendingReq; i++) {
		pendingReq = (ops()({ action: "requests", factory_id: fac.factory_id } as any) as any[]).find(r => r.state === "pending");
		if (!pendingReq) await new Promise(r => setTimeout(r, 20));
	}
	assert.ok(pendingReq);
	ops()({ action: "respond_request", factory_id: fac.factory_id, request_id: pendingReq.request_id, response: { kind: "choice", choice_id: "proceed" }, authority: auth } as any);
	await asked;
	await w1.complete({ status: "success", summary: "Done", detail: "Ok" });
	assert.equal((await ops()({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);

	// Input 2: submitted then discarded
	const sub2 = ops()({ action: "submit", factory_id: fac.factory_id, reference: "read-ref-2", brief: "Discarded 2", authority: auth });
	await ops()({ action: "discard", factory_id: fac.factory_id, input_id: sub2.input_id, authority: auth, confirm: async () => true });

	// Delete the factory
	const delRes = await ops()({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	assert.equal(delRes.deleted, true);

	const dbSnapshot = readFileSync(storePath);
	const notes: Array<{ message: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		cwd: f.cwd,
		ui: { notify: (message: string, level = "info") => notes.push({ message, level }), setStatus: () => {} },
		sessionManager: { getSessionId: () => "reader-sess", getSessionFile: () => undefined },
	};
	const factoryCmd = commands.get("factory")!;
	const inspectTool = tools.get("factory_inspect")!;

	// 1. inspect by UUID and by name, plus every retained version (v1, v2, v3)
	for (const target of [fac.factory_id, "readable-retired"]) {
		notes.length = 0;
		await factoryCmd.handler(`inspect ${target}`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		const cliInsp = JSON.parse(notes.at(-1)!.message);
		assert.equal(cliInsp.deleted, true);
		assert.deepEqual(cliInsp.deletion, delRes.deletion);

		const toolInsp = await inspectTool.execute("t-insp", { action: "inspect", factory_id: target }, undefined, undefined, ctx);
		assert.equal(toolInsp.isError, undefined, JSON.stringify(toolInsp));
		assert.equal(toolInsp.details.result.deleted, true);
		assert.deepEqual(toolInsp.details.result.deletion, delRes.deletion);

		for (const [ver, expectedTask] of [["v1", "Task v1"], ["v2", "Task v2"], ["v3", "Task v1"]] as const) {
			const opVer = ops()({ action: "inspect", factory_id: fac.factory_id, version: ver });
			assert.equal(opVer.deleted, true);
			assert.equal(opVer.inspected_version, ver);
			assert.equal(opVer.definition?.task, expectedTask);

			notes.length = 0;
			await factoryCmd.handler(`inspect ${target} ${ver}`, ctx);
			assert.equal(notes.at(-1)?.level, "info");
			const cliVer = JSON.parse(notes.at(-1)!.message);
			assert.equal(cliVer.deleted, true);
			assert.equal(cliVer.inspected_version, ver);
			assert.equal(cliVer.definition?.task, expectedTask);

			const toolVer = await inspectTool.execute("t-ver", { action: "inspect", factory_id: target, version: ver }, undefined, undefined, ctx);
			assert.equal(toolVer.isError, undefined);
			assert.equal(toolVer.details.result.deleted, true);
			assert.equal(toolVer.details.result.inspected_version, ver);
			assert.equal(toolVer.details.result.definition?.task, expectedTask);
		}
	}

	// 2. receipt by UUID and by name (CLI, tool, and operations)
	const opReceipt = ops()({ action: "receipt", factory_id: fac.factory_id, input_id: sub1.input_id }) as any;
	assert.equal(opReceipt.deleted, true);
	assert.deepEqual(opReceipt.deletion, delRes.deletion);
	for (const target of [fac.factory_id, "readable-retired"]) {
		notes.length = 0;
		await factoryCmd.handler(`receipt ${target} read-ref-1`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		const cliRec = JSON.parse(notes.at(-1)!.message);
		assert.equal(cliRec.deleted, true);
		assert.deepEqual(cliRec.deletion, delRes.deletion);
		assert.equal(cliRec.input_id, sub1.input_id);

		const toolRec = await inspectTool.execute("t-rec", { action: "receipt", factory_id: target, reference: "read-ref-2" }, undefined, undefined, ctx);
		assert.equal(toolRec.isError, undefined);
		assert.equal(toolRec.details.result.deleted, true);
		assert.deepEqual(toolRec.details.result.deletion, delRes.deletion);
		assert.equal(toolRec.details.result.disposition, "discarded");
	}

	// 3. queue by UUID and by name (CLI table, CLI --json, and factory_inspect tool)
	for (const target of [fac.factory_id, "readable-retired"]) {
		notes.length = 0;
		await factoryCmd.handler(`queue ${target}`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		assert.match(notes.at(-1)!.message, /\bdeleted\b/i);
		assert.match(notes.at(-1)!.message, /\bread-ref-1\b/);
		assert.match(notes.at(-1)!.message, /\bread-ref-2\b/);

		notes.length = 0;
		await factoryCmd.handler(`queue ${target} --json`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		const cliQ = JSON.parse(notes.at(-1)!.message);
		assert.equal(cliQ.factory.deleted, true);
		assert.deepEqual(cliQ.factory.deletion, delRes.deletion);
		assert.equal(cliQ.total_inputs, 2);

		const toolQ = await inspectTool.execute("t-q", { action: "queue", factory_id: target }, undefined, undefined, ctx);
		assert.equal(toolQ.isError, undefined);
		assert.equal(toolQ.details.result.factory.deleted, true);
		assert.deepEqual(toolQ.details.result.factory.deletion, delRes.deletion);
		assert.equal(toolQ.details.result.total_inputs, 2);
	}

	// 4. requests by UUID and by name
	const opRequests = ops()({ action: "requests", factory_id: fac.factory_id });
	assert.equal(opRequests.length, 1);
	assert.equal(opRequests[0]!.request_id, pendingReq.request_id);
	for (const target of [fac.factory_id, "readable-retired"]) {
		notes.length = 0;
		await factoryCmd.handler(`requests ${target}`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		const parsedReqs = JSON.parse(notes.at(-1)!.message);
		assert.equal(parsedReqs.length, 1);
		assert.equal(parsedReqs[0].request_id, pendingReq.request_id);
		assert.ok(
			notes.some(n => /deleted/i.test(n.message) && n.message.includes(delRes.deletion!.deleted_at)),
			`Expected /factory requests ${target} to show deletion status`,
		);
	}

	// All reads leave store byte-for-byte unchanged
	assert.deepEqual(readFileSync(storePath), dbSnapshot);
});

test("list omits deleted factories by default, list --all includes them marked deleted, and damaged deletion fails closed", async t => {
	const f = deletionFixture(t);
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const stateDir = join(f.root, "list-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
	});

	const storePath = join(stateDir, "factories.sqlite");
	const ops = () => factoryOperations(storePath, f.service, { coordinationPath: f.coordinationPath });
	const active = ops()({ action: "publish", name: "active-one", draft: f.draft("Active"), sessionModel });
	const retired = ops()({ action: "publish", name: "retired-one", draft: f.draft("Retired"), sessionModel });
	const authority = createManagerAuthority({ pi_session_id: "mgr-list-1", pi_session_file: join(f.root, "mgr.jsonl") });
	ops()({ action: "resume", factory_id: retired.factory_id, authority });
	const delRes = await ops()({
		action: "delete",
		factory_id: retired.factory_id,
		authority,
		confirm: async () => true,
	});
	assert.equal(delRes.deleted, true);

	// Seam 1: factoryOperations list default vs all: true
	const defaultList = ops()({ action: "list" });
	assert.equal(defaultList.length, 1);
	assert.equal(defaultList[0]!.factory_id, active.factory_id);
	assert.equal("deleted" in defaultList[0]!, false);

	const allList = ops()({ action: "list", all: true });
	assert.equal(allList.length, 2);
	const activeEntry = allList.find(item => item.factory_id === active.factory_id)!;
	const deletedEntry = allList.find(item => item.factory_id === retired.factory_id)!;
	assert.equal("deleted" in activeEntry, false);
	assert.equal(deletedEntry.deleted, true);
	assert.deepEqual(deletedEntry.deletion, delRes.deletion);

	// /factory list and /factory list --all via command handler
	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, any>();
	const notes: Array<{ message: string; level: string }> = [];
	registerBootstrap({
		registerTool() {},
		registerCommand(name: string, spec: any) { commands.set(name, spec); },
		on() {},
		sendMessage() {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	const ctx: any = {
		cwd: f.cwd,
		hasUI: true,
		ui: {
			notify: (message: string, level = "info") => { notes.push({ message, level }); },
			setStatus() {},
		},
		sessionManager: { getSessionId: () => "list-sess", getSessionFile: () => undefined },
	};
	const factoryCmd = commands.get("factory")!;

	await factoryCmd.handler("list", ctx);
	assert.equal(notes.at(-1)?.level, "info");
	const cliDefault = JSON.parse(notes.at(-1)!.message);
	assert.equal(cliDefault.length, 1);
	assert.equal(cliDefault[0].factory_id, active.factory_id);

	await factoryCmd.handler("list --all", ctx);
	assert.equal(notes.at(-1)?.level, "info");
	const cliAll = JSON.parse(notes.at(-1)!.message);
	assert.equal(cliAll.length, 2);
	const cliDeleted = cliAll.find((item: any) => item.factory_id === retired.factory_id);
	assert.equal(cliDeleted.deleted, true);
	assert.deepEqual(cliDeleted.deletion, delRes.deletion);

	await factoryCmd.handler("list --bogus", ctx);
	assert.equal(notes.at(-1)?.level, "error");
	assert.match(notes.at(-1)!.message, /Usage: \/factory \[list \[--all\]\]/);

	// Damaged factory_deletions record fails closed on list (default and all)
	const raw = new DatabaseSync(storePath);
	try {
		raw.prepare("UPDATE factory_deletions SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?").run(retired.factory_id);
	} finally {
		raw.close();
	}
	assert.throws(() => ops()({ action: "list" }), /corrupt|digest|deletion/i);
	assert.throws(() => ops()({ action: "list", all: true }), /corrupt|digest|deletion/i);
});

test("publish rejects a name held by a deleted factory (case-insensitively) with id and deletion time instead of duplicate error", async t => {
	const f = deletionFixture(t);
	const active = f.publish("ActiveName");
	const retired = f.publish("Fusion");
	const authority = createManagerAuthority({ pi_session_id: "mgr-pub-reserved" });
	f.open()({ action: "resume", factory_id: retired.factory_id, authority });
	const delRes = await f.open()({
		action: "delete",
		factory_id: retired.factory_id,
		authority,
		confirm: async () => true,
	});
	assert.equal(delRes.deleted, true);

	// Active factory duplicate keeps existing message
	assert.throws(
		() => f.publish("activename"),
		/already published/i,
	);

	// Exact name and case-insensitive variant of deleted factory both fail with id and deletion time, not "already published"
	for (const candidate of ["Fusion", "fusion", "FUSION"]) {
		assert.throws(
			() => f.publish(candidate),
			err => {
				assert.ok(err instanceof Error);
				assert.ok(err.message.includes(retired.factory_id), `expected factory_id in: ${err.message}`);
				assert.ok(err.message.includes(delRes.deletion!.deleted_at), `expected deleted_at in: ${err.message}`);
				assert.ok(err.message.includes("Fusion"), `expected deleted factory name in: ${err.message}`);
				assert.match(err.message, /deleted/i);
				assert.doesNotMatch(err.message, /already published/i);
				return true;
			},
		);
	}
	assert.equal(f.open()({ action: "list" }).length, 1);
	assert.equal(f.open()({ action: "list", all: true }).length, 2);
});

test("tab completion offers deleted factories only for read-only commands and --all for list, while read-only resolution still finds deleted factories", async t => {
	const f = deletionFixture(t);
	const savedState = process.env.PI_BOOTSTRAP_STATE_DIR;
	const stateDir = join(f.root, "complete-state");
	mkdirSync(stateDir, { recursive: true });
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	t.after(() => {
		if (savedState === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = savedState;
	});

	const storePath = join(stateDir, "factories.sqlite");
	const ops = () => factoryOperations(storePath, f.service, { coordinationPath: f.coordinationPath });
	const active = ops()({ action: "publish", name: "active-comp", draft: f.draft("Active"), sessionModel });
	const retired = ops()({ action: "publish", name: "retired-comp", draft: f.draft("Retired"), sessionModel });
	const authority = createManagerAuthority({ pi_session_id: "mgr-comp-1" });
	ops()({ action: "resume", factory_id: retired.factory_id, authority });
	const delRes = await ops()({
		action: "delete",
		factory_id: retired.factory_id,
		authority,
		confirm: async () => true,
	});
	assert.equal(delRes.deleted, true);

	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, any>();
	const notes: Array<{ message: string; level: string }> = [];
	registerBootstrap({
		registerTool() {},
		registerCommand(name: string, spec: any) { commands.set(name, spec); },
		on() {},
		sendMessage() {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	const ctx: any = {
		cwd: f.cwd,
		hasUI: true,
		ui: {
			notify: (message: string, level = "info") => { notes.push({ message, level }); },
			setStatus() {},
		},
		sessionManager: { getSessionId: () => "comp-sess", getSessionFile: () => undefined },
	};
	const cmd = commands.get("factory")!;

	// list takes no factory argument, but offers --all when typing flag prefix
	assert.equal(cmd.getArgumentCompletions("list "), null);
	const listFlagCompletions = (cmd.getArgumentCompletions("list --") as Array<{ value: string }>).map(c => c.value);
	assert.deepEqual(listFlagCompletions, ["list --all"]);

	// Read-only commands offer both active and deleted factories (by name and by UUID)
	for (const ro of ["inspect", "queue", "receipt", "requests", "proposals"]) {
		const items = (cmd.getArgumentCompletions(`${ro} `) as Array<{ value: string; description?: string }>).map(c => c.value);
		assert.ok(items.includes(`${ro} active-comp`), `${ro} should offer active factory name`);
		assert.ok(items.includes(`${ro} ${active.factory_id}`), `${ro} should offer active factory id`);
		assert.ok(items.includes(`${ro} retired-comp`), `${ro} should offer deleted factory name`);
		assert.ok(items.includes(`${ro} ${retired.factory_id}`), `${ro} should offer deleted factory id`);
	}

	// Mutating commands offer only active factories, never deleted ones
	for (const mut of [
		"update", "restore", "resume", "takeover", "stop", "discard", "delete",
		"submit", "launch", "retry", "cancel", "settle", "clear", "redeliver",
		"respond", "wake", "review-proposal", "retire-constraint", "resolve-conflict",
	]) {
		const items = (cmd.getArgumentCompletions(`${mut} `) as Array<{ value: string }>).map(c => c.value);
		assert.ok(items.includes(`${mut} active-comp`), `${mut} should offer active factory name`);
		assert.equal(items.includes(`${mut} retired-comp`), false, `${mut} must NOT offer deleted factory name`);
		assert.equal(items.includes(`${mut} ${retired.factory_id}`), false, `${mut} must NOT offer deleted factory id`);
	}

	// Name and id resolution still finds the deleted factory for read-only commands
	for (const target of ["retired-comp", retired.factory_id]) {
		await cmd.handler(`inspect ${target}`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
		assert.equal(JSON.parse(notes.at(-1)!.message).deleted, true);

		await cmd.handler(`proposals ${target}`, ctx);
		assert.equal(notes.at(-1)?.level, "info");
	}
});








