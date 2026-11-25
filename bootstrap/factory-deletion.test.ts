import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type DeleteFactoryTarget } from "../factory/operations.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";

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

test("stand-in precondition refuses factory with an input before confirmation, and commit-time race fails with inspect again", async t => {
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

	// Unsupported future version 14 fails closed
	const future = new DatabaseSync(f.dbPath);
	future.exec("PRAGMA user_version = 14;");
	future.close();
	assert.throws(() => f.open()({ action: "inspect", factory_id: fac.factory_id }), /unsupported.*14/i);
});



