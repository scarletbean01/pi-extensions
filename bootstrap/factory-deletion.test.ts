import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type DeleteFactoryTarget } from "../factory/operations.ts";
import { buildInputRow } from "./factory-records.ts";
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
		/pending (?:direction|intervention) request/i,
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
		/pending .*request/i,
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



