import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { writeProjectConstraintsDurable } from "./constraints.ts";
import { buildProposalRow, insertProposalRow } from "./constraint-proposals.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";

const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, _context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

function factoryHarness(t: test.TestContext, options: {
	model?: string;
	exec?: (command: string, args: string[]) => { stdout: string; stderr: string; code: number };
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-factory-nq-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const agentDir = join(root, "agent");
	const stateDir = join(root, "state");
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, bin, agentDir, stateDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read\n---\nReview carefully.\n");
	writeFileSync(join(cwd, ".pi", "agents", "implementer.md"), "---\nname: implementer\ntools: read\n---\nImplement carefully.\n");
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["pi", "herdr"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));

	const saved = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		PI_BOOTSTRAP_STATE_DIR: process.env.PI_BOOTSTRAP_STATE_DIR,
		PI_FACTORY_STATE_DIR: process.env.PI_FACTORY_STATE_DIR,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	};
	process.env.HOME = home;
	process.env.PATH = bin;
	process.env.PI_BOOTSTRAP_STATE_DIR = stateDir;
	delete process.env.PI_FACTORY_STATE_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "dispatcher";
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
			else (process.env as Record<string, string | undefined>)[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function>();
	const followUps: string[] = [];
	const widgets = new Map<string, { render(width: number): string[] }>();
	const statuses = new Map<string, string | undefined>();
	let redraws = 0;

	registerBootstrap({
		sendMessage: (message: { content: string }) => followUps.push(message.content),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: Function) => hooks.set(name, handler),
		registerFlag: () => {},
		getFlag: () => undefined,
		exec: async (command: string, args: string[]) => options.exec?.(command, args) ?? { stdout: "", stderr: "", code: 0 },
	} as any);

	const makeCtx = (overrides: {
		sessionId?: string;
		sessionFile?: string;
		hasUI?: boolean;
		editor?: (title: string, initial?: string) => Promise<string | undefined>;
		confirm?: (title: string, message: string) => Promise<boolean>;
		select?: (title: string, choices: string[]) => Promise<string | undefined>;
		input?: (title: string, placeholder?: string) => Promise<string | undefined>;
		executeTool?: (name: string, args: unknown, opts?: unknown) => Promise<unknown>;
	} = {}) => {
		const notifications: Array<[string, string]> = [];
		const sid = overrides.sessionId ?? "sess-1";
		const sfile = overrides.sessionFile ?? join(root, `${sid}.jsonl`);
		const ctx: any = {
			cwd,
			model: { provider: "provider", id: options.model ?? "model" },
			thinkingLevel: "medium",
			hasUI: overrides.hasUI ?? true,
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => sid,
				getSessionFile: () => sfile,
			},
			executeTool: overrides.executeTool ?? (async () => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ status: "sent" }) }] })),
			ui: {
				notify: (message: string, level: string) => { notifications.push([message, level]); },
				editor: overrides.editor ?? (async () => undefined),
				confirm: overrides.confirm ?? (async () => true),
				select: overrides.select ?? (async (_t: string, choices: string[]) => choices[0]),
				input: overrides.input ?? (async () => "Operator verified reason"),
				setTheme: () => ({ success: true }),
				setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
				setWidget(key: string, factory?: Function) {
					if (factory) widgets.set(key, factory({ requestRender: () => { redraws++; } }, { fg: (_color: string, text: string) => text }));
					else widgets.delete(key);
				},
			},
		};
		return { ctx, notifications };
	};

	const base = makeCtx();
	const call = (name: string, params: unknown, ctx = base.ctx) => tools.get(name).execute("call-1", params, undefined, undefined, ctx);

	const publishFactory = async (name: string, customDraft?: Record<string, unknown>) => {
		const draft = customDraft ?? {
			topology: "graph",
			task: `Task for ${name}`,
			project_cwd: cwd,
			agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review changes" }],
		};
		const pub = makeCtx({
			editor: async () => JSON.stringify({ name, draft }),
			confirm: async () => true,
		});
		await commands.get("factory").handler("publish", pub.ctx);
		assert.equal(pub.notifications.at(-1)?.[1], "info", pub.notifications.at(-1)?.[0]);
		return JSON.parse(pub.notifications.at(-1)![0]) as { factory_id: string; name: string; current_version: string; management: string };
	};

	return {
		root, cwd, home, stateDir, agentDir, dbPath: join(stateDir, "factories.sqlite"),
		tools, commands, hooks, widgets, statuses, followUps,
		get redraws() { return redraws; },
		makeCtx, ctx: base.ctx, notifications: base.notifications, call, publishFactory,
	};
}

function snapshotDir(dir: string): Array<[string, string]> {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile())
		.map(e => join(e.parentPath, e.name))
		.sort()
		.map(p => [p, readFileSync(p).toString("base64")]);
}

test("name addressing resolves factory names for read-only and mutating /factory subcommands and factory_inspect tool", async t => {
	const f = factoryHarness(t);
	const fac = await f.publishFactory("fusion-mixed-smoke");
	const cmd = f.commands.get("factory");

	// Read-only commands by name: inspect, requests, proposals, factory_inspect tool.
	await cmd.handler("inspect fusion-mixed-smoke", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).factory.factory_id, fac.factory_id);

	const toolInspect = await f.call("factory_inspect", { action: "inspect", factory_id: "fusion-mixed-smoke" });
	assert.equal(toolInspect.isError, undefined, JSON.stringify(toolInspect));
	assert.equal(toolInspect.details.result.factory.factory_id, fac.factory_id);

	// Mutating commands by name: resume, submit, receipt (both CLI and tool), update, restore, discard, stop.
	await cmd.handler("resume fusion-mixed-smoke", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).factory.management, "managed");

	const submitCtx = f.makeCtx({ editor: async () => "Brief via name addressing" });
	await cmd.handler("submit fusion-mixed-smoke ref-by-name", submitCtx.ctx);
	assert.equal(submitCtx.notifications.at(-1)?.[1], "info", submitCtx.notifications.at(-1)?.[0]);
	const receipt = JSON.parse(submitCtx.notifications.at(-1)![0]) as { factory_id: string; input_id: string; reference: string };
	assert.equal(receipt.factory_id, fac.factory_id);

	await cmd.handler("receipt fusion-mixed-smoke ref-by-name", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).input_id, receipt.input_id);

	const toolReceipt = await f.call("factory_inspect", { action: "receipt", factory_id: "fusion-mixed-smoke", reference: "ref-by-name" });
	assert.equal(toolReceipt.isError, undefined, JSON.stringify(toolReceipt));
	assert.equal(toolReceipt.details.result.input_id, receipt.input_id);

	await cmd.handler("requests fusion-mixed-smoke", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	await cmd.handler("proposals fusion-mixed-smoke", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);

	const confirmMessages: string[] = [];
	const updateCtx = f.makeCtx({
		editor: async () => JSON.stringify({
			draft: { topology: "graph", task: "Updated via name", project_cwd: f.cwd, agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review v2" }] },
		}),
		confirm: async (_title, msg) => { confirmMessages.push(msg); return true; },
	});
	await cmd.handler("update fusion-mixed-smoke", updateCtx.ctx);
	assert.equal(updateCtx.notifications.at(-1)?.[1], "info", updateCtx.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(updateCtx.notifications.at(-1)![0]).version, "v2");
	assert.ok(confirmMessages.at(-1)!.includes(fac.factory_id) && confirmMessages.at(-1)!.includes("fusion-mixed-smoke"));

	const restoreCtx = f.makeCtx({ confirm: async (_t, msg) => { confirmMessages.push(msg); return true; } });
	await cmd.handler("restore fusion-mixed-smoke v1", restoreCtx.ctx);
	assert.equal(restoreCtx.notifications.at(-1)?.[1], "info", restoreCtx.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(restoreCtx.notifications.at(-1)![0]).version, "v3");
	assert.ok(confirmMessages.at(-1)!.includes(fac.factory_id) && confirmMessages.at(-1)!.includes("fusion-mixed-smoke"));

	// Discard by name shows both resolved UUID and factory name in confirmation.
	const discardCtx = f.makeCtx({ confirm: async (_t, msg) => { confirmMessages.push(msg); return true; } });
	await cmd.handler(`discard fusion-mixed-smoke ${receipt.input_id}`, discardCtx.ctx);
	assert.equal(discardCtx.notifications.at(-1)?.[1], "info", discardCtx.notifications.at(-1)?.[0]);
	assert.ok(confirmMessages.at(-1)!.includes(fac.factory_id) && confirmMessages.at(-1)!.includes("fusion-mixed-smoke"));

	// Stop by name shows both resolved UUID and factory name in confirmation.
	const stopCtx = f.makeCtx({ confirm: async (_t, msg) => { confirmMessages.push(msg); return true; } });
	await cmd.handler("stop fusion-mixed-smoke", stopCtx.ctx);
	assert.equal(stopCtx.notifications.at(-1)?.[1], "info", stopCtx.notifications.at(-1)?.[0]);
	assert.ok(confirmMessages.at(-1)!.includes(fac.factory_id) && confirmMessages.at(-1)!.includes("fusion-mixed-smoke"));

	// UUID id still works too.
	await cmd.handler(`inspect ${fac.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info");
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).factory.name, "fusion-mixed-smoke");
});

test("name resolution fails closed: unknown name, case sensitivity, ambiguous names, UUID-like name, and name vs id precedence", async t => {
	const f = factoryHarness(t);
	const alpha = await f.publishFactory("Alpha-Factory");
	const cmd = f.commands.get("factory");

	// Unknown name lists tried id/name and available names.
	await cmd.handler("inspect missing-name", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	assert.match(f.notifications.at(-1)![0], /Factory not found: missing-name/i);
	assert.match(f.notifications.at(-1)![0], /id.*name|name.*id/i);
	assert.match(f.notifications.at(-1)![0], /Alpha-Factory/);

	// Case-sensitive exact match only (no case-folding, no prefix match).
	for (const badToken of ["alpha-factory", "Alpha", "Alpha-Factor"]) {
		await cmd.handler(`inspect ${badToken}`, f.ctx);
		assert.equal(f.notifications.at(-1)?.[1], "error", `expected error for ${badToken}`);
		const toolRes = await f.call("factory_inspect", { action: "inspect", factory_id: badToken });
		assert.equal(toolRes.isError, true, `expected tool error for ${badToken}`);
	}

	// Name vs ID precedence: if factory B's name equals factory A's UUID, passing A's UUID selects A (ID wins over name).
	const namedWithUuid = await f.publishFactory(alpha.factory_id);
	await cmd.handler(`inspect ${alpha.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).factory.factory_id, alpha.factory_id);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).factory.name, "Alpha-Factory");
	assert.notEqual(namedWithUuid.factory_id, alpha.factory_id);

	// A token that looks like a UUID (matching no factory_id) but matches a different factory's name is refused.
	const foreignUuid = randomUUID();
	await f.publishFactory(foreignUuid);
	await cmd.handler(`inspect ${foreignUuid}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	assert.match(f.notifications.at(-1)![0], /UUID|ambiguous/i);
	const toolUuidName = await f.call("factory_inspect", { action: "inspect", factory_id: foreignUuid });
	assert.equal(toolUuidName.isError, true);

	// Ambiguous duplicate names in SQLite (when table lacks uniqueness) fail closed naming all matching IDs.
	const dupRoot = mkdtempSync(join(tmpdir(), "bootstrap-dup-name-"));
	t.after(() => rmSync(dupRoot, { recursive: true, force: true }));
	const dupDbPath = join(dupRoot, "factories.sqlite");
	const dupDb = new DatabaseSync(dupDbPath);
	try {
		dupDb.exec("CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT; PRAGMA user_version = 1;");
		const id1 = randomUUID();
		const id2 = randomUUID();
		dupDb.prepare("INSERT INTO factories (factory_id, name, definition, digest) VALUES (?, ?, ?, ?)").run(id1, "dup-name", "{}", "0".repeat(64));
		dupDb.prepare("INSERT INTO factories (factory_id, name, definition, digest) VALUES (?, ?, ?, ?)").run(id2, "dup-name", "{}", "0".repeat(64));
		process.env.PI_FACTORY_STATE_DIR = dupRoot;
		const dupCommands = new Map<string, any>();
		registerBootstrap({
			sendMessage: () => {},
			registerTool: () => {},
			registerCommand: (name: string, command: any) => dupCommands.set(name, command),
			on: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		} as any);
		const dupNotes: Array<[string, string]> = [];
		await dupCommands.get("factory").handler("inspect dup-name", {
			cwd: f.cwd, hasUI: false, ui: { notify: (m: string, l: string) => dupNotes.push([m, l]) },
		});
		assert.equal(dupNotes.at(-1)?.[1], "error");
		assert.match(dupNotes.at(-1)![0], /ambiguous/i);
		assert.ok(dupNotes.at(-1)![0].includes(id1));
		assert.ok(dupNotes.at(-1)![0].includes(id2));
	} finally {
		dupDb.close();
		delete process.env.PI_FACTORY_STATE_DIR;
	}
});

test("confirmation binds to resolved UUID so a name swap during confirmation cannot redirect commit", async t => {
	const f = factoryHarness(t);
	const facA = await f.publishFactory("swap-alpha");
	const facB = await f.publishFactory("swap-beta");
	const cmd = f.commands.get("factory");

	// Resume both so both can be targeted.
	await cmd.handler("resume swap-alpha", f.ctx);
	await cmd.handler("resume swap-beta", f.ctx);

	// Start `/factory stop swap-alpha`, and during ctx.ui.confirm swap the names in SQLite.
	let promptSeen = "";
	const swapCtx = f.makeCtx({
		confirm: async (_title, msg) => {
			promptSeen = msg;
			const db = new DatabaseSync(f.dbPath);
			try {
				db.exec("BEGIN IMMEDIATE");
				db.prepare("UPDATE factories SET name = ? WHERE factory_id = ?").run("temp-swap-name", facA.factory_id);
				db.prepare("UPDATE factories SET name = ? WHERE factory_id = ?").run("swap-alpha", facB.factory_id);
				db.prepare("UPDATE factories SET name = ? WHERE factory_id = ?").run("swap-beta", facA.factory_id);
				db.exec("COMMIT");
			} finally {
				db.close();
			}
			return true;
		},
	});
	await cmd.handler("stop swap-alpha", swapCtx.ctx);
	assert.equal(swapCtx.notifications.at(-1)?.[1], "info", swapCtx.notifications.at(-1)?.[0]);
	assert.ok(promptSeen.includes(facA.factory_id) && promptSeen.includes("swap-alpha"));

	// facA (original resolved UUID) is stopped; facB (now named "swap-alpha") was NOT touched!
	const checkA = await f.call("factory_inspect", { action: "inspect", factory_id: facA.factory_id });
	const checkB = await f.call("factory_inspect", { action: "inspect", factory_id: facB.factory_id });
	assert.equal(checkA.details.result.stopped, true, "commit must apply only to resolved UUID facA");
	assert.equal(checkB.details.result.stopped, false, "swap-alpha now pointing to facB must NOT be stopped");
});

test("/factory autocomplete offers subcommands including wake and queue, factory names/ids, and usage includes redeliver [source-node]", async t => {
	const f = factoryHarness(t);
	const fac = await f.publishFactory("autocomplete-pipe");
	const cmd = f.commands.get("factory");

	const subCompletions = cmd.getArgumentCompletions("");
	const values = subCompletions.map((c: any) => c.value);
	assert.ok(values.includes("wake"), "completions must include wake");
	assert.ok(values.includes("queue"), "completions must include queue");

	const argCompletions = cmd.getArgumentCompletions("inspect ");
	assert.ok(argCompletions, "should return factory completions after subcommand");
	const argValues = argCompletions.map((c: any) => c.value);
	assert.ok(argValues.includes("inspect autocomplete-pipe"), `expected factory name completion, got ${JSON.stringify(argValues)}`);
	assert.ok(argValues.includes(`inspect ${fac.factory_id}`), `expected factory id completion, got ${JSON.stringify(argValues)}`);

	const prefixCompletions = cmd.getArgumentCompletions("queue auto");
	assert.deepEqual(prefixCompletions.map((c: any) => c.value), ["queue autocomplete-pipe"]);

	assert.equal(cmd.getArgumentCompletions("list "), null, "list takes no factory argument");
	assert.equal(cmd.getArgumentCompletions("publish "), null, "publish takes no factory argument");

	// Usage string for unknown subcommand includes queue and redeliver [source-node].
	await cmd.handler("not-a-subcommand", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	assert.match(f.notifications.at(-1)![0], /\bqueue\b/);
	assert.match(f.notifications.at(-1)![0], /redeliver\b[^\n|]*\[source-node\]/);
});

test("/factory queue renders compact table across dispositions, filters --open, outputs --json, and matches factory_inspect action queue without mutating", async t => {
	const configs = new Map<string, WorkerConfig>();
	const tabs = new Map<string, string>();
	let fRef: ReturnType<typeof factoryHarness>;
	const f = factoryHarness(t, {
		exec: (_command, args) => {
			const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
			if (args[0] === "tab" && args[1] === "create") {
				const id = `t-${tabs.size + 1}`;
				const label = args[args.indexOf("--label") + 1];
				tabs.set(id, label);
				const tab = { tab_id: id, pane_id: id, terminal_id: id, label, cwd: fRef.cwd };
				return ok({ tab, root_pane: tab });
			}
			if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] });
			if (args[0] === "tab" && args[1] === "close") return ok({});
			const [taskId, instance] = tabs.get(args[2])!.split(":");
			const dir = join(fRef.cwd, ".pi", "agent-sessions", taskId);
			const config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
			configs.set(taskId, config);
			const ready = { task_id: taskId, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance}.json`), ready);
			atomicJson(readyPath(dir, instance), ready);
			return ok({});
		},
	});
	fRef = f;
	const cmd = f.commands.get("factory");

	// Unmanaged factory: queue works read-only and reports no inputs + unmanaged head without mutating state.
	const fac = await f.publishFactory("queue-pipe");
	const unmanagedSnapBefore = snapshotDir(f.stateDir);
	await cmd.handler("queue queue-pipe", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	assert.match(f.notifications.at(-1)![0], /no inputs submitted/i);
	assert.match(f.notifications.at(-1)![0], /unmanaged/i);
	assert.deepEqual(snapshotDir(f.stateDir), unmanagedSnapBefore, "read-only queue must not mutate unmanaged store");

	// Resume and submit inputs covering settled, discarded, cleared, running, queued (with truncation & control chars).
	await cmd.handler("resume queue-pipe", f.ctx);
	const submitBrief = async (reference: string, brief: string) => {
		const sctx = f.makeCtx({ editor: async () => brief });
		await cmd.handler(`submit queue-pipe ${reference}`, sctx.ctx);
		assert.equal(sctx.notifications.at(-1)?.[1], "info", sctx.notifications.at(-1)?.[0]);
		return JSON.parse(sctx.notifications.at(-1)![0]) as { input_id: string; reference: string };
	};

	const in1 = await submitBrief("ref-1", "First brief settles");
	await cmd.handler("launch queue-pipe", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	const launch1 = JSON.parse(f.notifications.at(-1)![0]) as { task_id: string };
	const w1 = configs.get(launch1.task_id)!;
	atomicJson(resultPath(w1.session_dir, w1.instance_id), completionRecord(w1,
		{ agent_name: "reviewer", status: "success", summary: "Done 1", detail: "" }, "none", new Date().toISOString()));
	await cmd.handler("settle queue-pipe", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);

	const in2 = await submitBrief("ref-2", "Second brief discarded");
	await cmd.handler(`discard queue-pipe ${in2.input_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);

	// Input 3: launched, worker process exited without outcome, cleared (via name addressing + confirmation showing name & UUID).
	await submitBrief("ref-3", "Third brief cleared");
	await cmd.handler("launch queue-pipe", f.ctx);
	const launch3 = JSON.parse(f.notifications.at(-1)![0]) as { task_id: string };
	const w3 = configs.get(launch3.task_id)!;
	rmSync(readyPath(w3.session_dir, w3.instance_id), { force: true });
	rmSync(join(w3.session_dir, "release.json"), { force: true });
	const clearMsgs: string[] = [];
	const clearCtx = f.makeCtx({
		confirm: async (_t, msg) => { clearMsgs.push(msg); return true; },
		input: async () => "Verified process exited",
	});
	await cmd.handler("clear queue-pipe", clearCtx.ctx);
	assert.equal(clearCtx.notifications.at(-1)?.[1], "info", clearCtx.notifications.at(-1)?.[0]);
	assert.ok(clearMsgs[0]!.includes(fac.factory_id) && clearMsgs[0]!.includes("queue-pipe"), "clear prompt must show name and resolved UUID");

	// Input 4: launched and currently running; plus Input 5 queued with multiline/control chars & >60 chars.
	await submitBrief("ref-4", "Fourth brief running now");
	await cmd.handler("launch queue-pipe", f.ctx);
	const launch4 = JSON.parse(f.notifications.at(-1)![0]) as { task_id: string };
	// Also test /factory cancel by name shows both name and UUID in confirmation prompt (declining cancel so run stays running).
	const cancelMsgs: string[] = [];
	const cancelDeclineCtx = f.makeCtx({ confirm: async (_t, msg) => { cancelMsgs.push(msg); return false; } });
	await cmd.handler("cancel queue-pipe", cancelDeclineCtx.ctx);
	assert.ok(cancelMsgs[0]!.includes(fac.factory_id) && cancelMsgs[0]!.includes("queue-pipe"), "cancel prompt must show name and resolved UUID");

	const longCtrlBrief = "Line1\x00\x1b[31m\n\tLine2 with extra details that definitely exceed sixty characters total!!";
	const in5 = await submitBrief("ref-5", longCtrlBrief);

	// Snapshot DB/state before read-only queue commands & tool calls.
	const snapBefore = snapshotDir(f.stateDir);
	const cwdSnapBefore = snapshotDir(join(f.cwd, ".pi"));

	// Compact table view (default --all, oldest first).
	await cmd.handler("queue queue-pipe", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info", f.notifications.at(-1)?.[0]);
	const tableOut = f.notifications.at(-1)![0];
	const rows = tableOut.split("\n");
	const pos1 = rows.findIndex(l => l.includes("ref-1"));
	const pos2 = rows.findIndex(l => l.includes("ref-2"));
	const pos3 = rows.findIndex(l => l.includes("ref-3"));
	const pos4 = rows.findIndex(l => l.includes("ref-4"));
	const pos5 = rows.findIndex(l => l.includes("ref-5"));
	assert.ok(pos1 > 0 && pos1 < pos2 && pos2 < pos3 && pos3 < pos4 && pos4 < pos5, `expected oldest-first ordering in:\n${tableOut}`);
	assert.match(rows[pos1]!, /\bsettled\b.*\bsucceeded\b/);
	assert.match(rows[pos2]!, /\bdiscarded\b/);
	assert.match(rows[pos3]!, /\bcleared\b/);
	assert.match(rows[pos4]!, /\brunning\b.*\breleased\b.*\brunning\b/);
	assert.match(rows[pos5]!, /\bqueued\b/);
	// Control chars stripped & truncated brief on single line (~60 chars).
	assert.doesNotMatch(rows[pos5]!, /[\x00-\x1f\x7f]/);
	assert.match(rows[pos5]!, /Line1.*Line2/);
	assert.doesNotMatch(rows[pos5]!, /characters total!!/);
	// Head & capacity lines under table.
	assert.match(tableOut, /Head:.*ref-5.*blocked.*factory_held/);
	assert.match(tableOut, /Capacity:\s+1\/32 queued/);

	// --open filter omits settled, discarded, cleared and keeps running + queued.
	await cmd.handler("queue queue-pipe --open", f.ctx);
	const openOut = f.notifications.at(-1)![0];
	assert.doesNotMatch(openOut, /\bref-1\b/);
	assert.doesNotMatch(openOut, /\bref-2\b/);
	assert.doesNotMatch(openOut, /\bref-3\b/);
	assert.match(openOut, /\bref-4\b/);
	assert.match(openOut, /\bref-5\b/);

	// --json matches factory_inspect action "queue" (with name addressing too).
	await cmd.handler("queue queue-pipe --json", f.ctx);
	const cliJson = JSON.parse(f.notifications.at(-1)![0]);
	const toolAll = await f.call("factory_inspect", { action: "queue", factory_id: "queue-pipe" });
	assert.equal(toolAll.isError, undefined, JSON.stringify(toolAll));
	assert.deepEqual(toolAll.details.result, cliJson);
	assert.equal(cliJson.total_inputs, 5);
	assert.equal(cliJson.shown_inputs, 5);
	assert.equal(cliJson.inputs[4].input_id, in5.input_id);
	assert.equal(cliJson.inputs[4].is_head, true);
	assert.ok(cliJson.inputs[4].brief_preview.length <= 60);
	assert.doesNotMatch(cliJson.inputs[4].brief_preview, /[\x00-\x1f\x7f]/);
	assert.equal(cliJson.inputs[3].task_id, launch4.task_id);
	assert.equal(cliJson.inputs[3].run_outcome, "running");

	const toolOpen = await f.call("factory_inspect", { action: "queue", factory_id: fac.factory_id, open: true });
	assert.equal(toolOpen.isError, undefined);
	assert.equal(toolOpen.details.result.filter, "open");
	assert.equal(toolOpen.details.result.shown_inputs, 2);

	// Tool validation / negative guards.
	for (const bad of [
		{ action: "queue" },
		{ action: "queue", factory_id: "   " },
		{ action: "queue", factory_id: "queue-pipe", version: "v1" },
		{ action: "queue", factory_id: "queue-pipe", reference: "ref-1" },
		{ action: "queue", factory_id: "queue-pipe", input_id: in1.input_id },
		{ action: "queue", factory_id: "queue-pipe", open: "yes" },
		{ action: "queue", factory_id: "queue-pipe", extra: 1 },
		{ action: "list", open: true },
		{ action: "inspect", factory_id: "queue-pipe", open: true },
		{ action: "receipt", factory_id: "queue-pipe", reference: "ref-1", open: true },
	]) {
		const res = await f.call("factory_inspect", bad);
		assert.equal(res.isError, true, `expected error for ${JSON.stringify(bad)}`);
	}
	for (const badCli of ["queue", "queue queue-pipe --open --all", "queue queue-pipe --bogus", "queue queue-pipe extra"]) {
		await cmd.handler(badCli, f.ctx);
		assert.equal(f.notifications.at(-1)?.[1], "error", `expected error for /factory ${badCli}`);
	}

	// State unchanged (no mutation).
	assert.deepEqual(snapshotDir(f.stateDir), snapBefore, "factory state dir must be unchanged after queue reads");
	assert.deepEqual(snapshotDir(join(f.cwd, ".pi")), cwdSnapBefore, "project .pi dir must be unchanged after queue reads");
});

test("/factory queue surfaces uncertainty header, retried attempts count, long queue (32), and factory FIFO launch replaces settled graph widget", async t => {
	const configs = new Map<string, WorkerConfig>();
	const tabs = new Map<string, string>();
	let fRef: ReturnType<typeof factoryHarness>;
	const f = factoryHarness(t, {
		exec: (_command, args) => {
			const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
			if (args[0] === "tab" && args[1] === "create") {
				const id = `t-${tabs.size + 1}`;
				const label = args[args.indexOf("--label") + 1];
				tabs.set(id, label);
				const tab = { tab_id: id, pane_id: id, terminal_id: id, label, cwd: fRef.cwd };
				return ok({ tab, root_pane: tab });
			}
			if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] });
			if (args[0] === "tab" && args[1] === "close") return ok({});
			const [taskId, instance] = tabs.get(args[2])!.split(":");
			const dir = join(fRef.cwd, ".pi", "agent-sessions", taskId);
			const config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
			configs.set(taskId, config);
			const ready = { task_id: taskId, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance}.json`), ready);
			atomicJson(readyPath(dir, instance), ready);
			return ok({});
		},
	});
	fRef = f;
	const cmd = f.commands.get("factory");

	const fac = await f.publishFactory("fifo-widget-pipe");
	await cmd.handler("resume fifo-widget-pipe", f.ctx);
	for (let i = 1; i <= 32; i++) {
		const sctx = f.makeCtx({ editor: async () => `Queued item #${i}` });
		await cmd.handler(`submit fifo-widget-pipe q-${i}`, sctx.ctx);
		assert.equal(sctx.notifications.at(-1)?.[1], "info", sctx.notifications.at(-1)?.[0]);
	}

	// Queue with 32 items renders all 32 lines compactly and reports capacity 32/32.
	await cmd.handler("queue fifo-widget-pipe", f.ctx);
	const longOut = f.notifications.at(-1)![0];
	assert.match(longOut, /32\/32 queued/);
	assert.match(longOut, /\bq-1\b/);
	assert.match(longOut, /\bq-32\b/);

	// Launch input 1 -> graph widget attached for run 1.
	await cmd.handler("launch fifo-widget-pipe", f.ctx);
	const run1 = JSON.parse(f.notifications.at(-1)![0]) as { task_id: string };
	assert.equal(f.widgets.has(`bootstrap-${run1.task_id}`), true);

	// Settle input 1, then launch input 2 -> widget shows input 2's run, NOT input 1!
	const w1 = configs.get(run1.task_id)!;
	atomicJson(resultPath(w1.session_dir, w1.instance_id), completionRecord(w1,
		{ agent_name: "reviewer", status: "success", summary: "Input 1 done", detail: "" }, "none", new Date().toISOString()));
	await cmd.handler("settle fifo-widget-pipe", f.ctx);
	await cmd.handler("launch fifo-widget-pipe", f.ctx);
	const run2 = JSON.parse(f.notifications.at(-1)![0]) as { task_id: string };
	assert.notEqual(run2.task_id, run1.task_id);
	assert.equal(f.widgets.has(`bootstrap-${run1.task_id}`), false, "settled FIFO input 1 widget must be replaced when input 2 launches");
	assert.equal(f.widgets.has(`bootstrap-${run2.task_id}`), true, "FIFO input 2 widget must be displayed");

	// Corrupt run2 manifest so attempt has uncertainty, and check queue surfaces uncertainty header & never defaults damaged row to safe status.
	writeFileSync(join(w1.session_dir, "..", run2.task_id, "manifest.json"), "{corrupt");
	await cmd.handler("queue fifo-widget-pipe", f.ctx);
	const uncertainOut = f.notifications.at(-1)![0];
	assert.match(uncertainOut, /UNCERTAIN EVIDENCE:/);
	assert.match(uncertainOut, /\bq-2\b[^\n]*uncertain/);
	const uncertainJson = (await f.call("factory_inspect", { action: "queue", factory_id: "fifo-widget-pipe" })).details.result;
	assert.ok(uncertainJson.uncertainty.length > 0);
	assert.equal(uncertainJson.inputs[1].run_outcome, "uncertain");
});

test("retried input shows latest attempt with prior attempt count, and remaining subcommands (takeover, retry, redeliver, respond, wake, review-proposal, retire-constraint, resolve-conflict) accept names", async t => {
	let failNextLaunch = true;
	const configs = new Map<string, WorkerConfig>();
	const tabs = new Map<string, string>();
	let fRef: ReturnType<typeof factoryHarness>;
	const f = factoryHarness(t, {
		exec: (_command, args) => {
			const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
			if (args[0] === "tab" && args[1] === "create") {
				if (failNextLaunch) return { code: 1, stdout: "", stderr: "tab create failed before release" };
				const id = `t-${tabs.size + 1}`;
				const label = args[args.indexOf("--label") + 1];
				tabs.set(id, label);
				const tab = { tab_id: id, pane_id: id, terminal_id: id, label, cwd: fRef.cwd };
				return ok({ tab, root_pane: tab });
			}
			if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] });
			if (args[0] === "tab" && args[1] === "close") return ok({});
			const [taskId, instance] = tabs.get(args[2])!.split(":");
			const dir = join(fRef.cwd, ".pi", "agent-sessions", taskId);
			const config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
			configs.set(taskId, config);
			const ready = { task_id: taskId, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance}.json`), ready);
			atomicJson(readyPath(dir, instance), ready);
			return ok({});
		},
	});
	fRef = f;
	const cmd = f.commands.get("factory");

	const fac = await f.publishFactory("retry-and-subcmds");
	await cmd.handler("resume retry-and-subcmds", f.ctx);
	const sub = f.makeCtx({ editor: async () => "Retryable brief" });
	await cmd.handler("submit retry-and-subcmds ref-retry", sub.ctx);
	const receipt = JSON.parse(sub.notifications.at(-1)![0]) as { input_id: string };

	// Failed pre-release launch automatically proves non-release (no nodes became ready) -> retry by name!
	await cmd.handler("launch retry-and-subcmds", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	const beforeRetry = (await f.call("factory_inspect", { action: "queue", factory_id: "retry-and-subcmds" })).details.result;
	assert.equal(beforeRetry.inputs[0].attempt_state, "proven_not_released");
	assert.equal(beforeRetry.inputs[0].attempt_count, 1);

	const inspectedBefore = (await f.call("factory_inspect", { action: "inspect", factory_id: "retry-and-subcmds" })).details.result;
	const firstAttemptId = inspectedBefore.attempts[0].attempt_id as string;

	failNextLaunch = false;
	const retryConfirmMsgs: string[] = [];
	const retryCtx = f.makeCtx({ confirm: async (_t, m) => { retryConfirmMsgs.push(m); return true; } });
	await cmd.handler(`retry retry-and-subcmds ${receipt.input_id} ${firstAttemptId}`, retryCtx.ctx);
	assert.equal(retryCtx.notifications.at(-1)?.[1], "info", retryCtx.notifications.at(-1)?.[0]);
	assert.ok(retryConfirmMsgs[0]!.includes(fac.factory_id) && retryConfirmMsgs[0]!.includes("retry-and-subcmds"));
	const retryLaunch = JSON.parse(retryCtx.notifications.at(-1)![0]) as { task_id: string };

	// Queue view shows latest attempt (released) AND marker that 1 prior attempt exists.
	await cmd.handler("queue retry-and-subcmds", f.ctx);
	const retryTable = f.notifications.at(-1)![0];
	assert.match(retryTable, /released \(\+1 prior\)/);
	const retryJson = (await f.call("factory_inspect", { action: "queue", factory_id: "retry-and-subcmds" })).details.result;
	assert.equal(retryJson.inputs[0].attempt_count, 2);
	assert.equal(retryJson.inputs[0].earlier_attempts, 1);
	assert.equal(retryJson.inputs[0].task_id, retryLaunch.task_id);
	assert.equal(retryJson.inputs[0].run_outcome, "running");

	// Takeover by name: revoke manager via session_start and rewrite manager PID to dead PID 999999 so takeover succeeds.
	await f.hooks.get("session_start")!({}, f.ctx);
	const db = new DatabaseSync(f.dbPath);
	try {
		const row = db.prepare("SELECT * FROM factory_managers WHERE factory_id = ?").get(fac.factory_id) as any;
		const deadParts = String(row.incarnation_id).split("|");
		deadParts[2] = "999999";
		const deadInc = deadParts.join("|");
		const { managerRecordDigest } = await import("./factory-records.ts");
		const digest = managerRecordDigest({
			factory_id: row.factory_id,
			incarnation_id: deadInc,
			authority_digest: row.authority_digest,
			pi_session_id: row.pi_session_id,
			pi_session_file: row.pi_session_file,
			pid: 999999,
			resumed_at: row.resumed_at,
		});
		db.prepare("UPDATE factory_managers SET incarnation_id = ?, pid = ?, record_digest = ? WHERE factory_id = ?").run(deadInc, 999999, digest, fac.factory_id);
	} finally {
		db.close();
	}
	const takeoverMsgs: string[] = [];
	const takeoverCtx = f.makeCtx({ confirm: async (_t, m) => { takeoverMsgs.push(m); return true; } });
	await cmd.handler("takeover retry-and-subcmds", takeoverCtx.ctx);
	assert.equal(takeoverCtx.notifications.at(-1)?.[1], "info", takeoverCtx.notifications.at(-1)?.[0]);
	assert.ok(takeoverMsgs[0]!.includes(fac.factory_id) && takeoverMsgs[0]!.includes("retry-and-subcmds"));

	// Redeliver, respond, wake by name resolve to canonical factory_id (verified via missing target error after boundary resolution).
	await cmd.handler("redeliver retry-and-subcmds review", takeoverCtx.ctx);
	assert.equal(takeoverCtx.notifications.at(-1)?.[1], "error");
	assert.doesNotMatch(takeoverCtx.notifications.at(-1)![0], /Factory not found/);

	await cmd.handler("respond retry-and-subcmds req-missing", takeoverCtx.ctx);
	assert.match(takeoverCtx.notifications.at(-1)![0], /Request not found: req-missing/);

	await cmd.handler("wake retry-and-subcmds req-missing", takeoverCtx.ctx);
	assert.doesNotMatch(takeoverCtx.notifications.at(-1)![0], /Factory not found/);

	// review-proposal and retire-constraint by name show factory name + resolved UUID in prompt.
	const w2 = configs.get(retryLaunch.task_id)!;
	atomicJson(resultPath(w2.session_dir, w2.instance_id), completionRecord(w2,
		{ agent_name: "reviewer", status: "success", summary: "Done", detail: "" }, "none", new Date().toISOString()));
	await cmd.handler("settle retry-and-subcmds", takeoverCtx.ctx);
	writeProjectConstraintsDurable(f.cwd, {
		version: 1,
		constraints: [{
			id: "c-active",
			text: "Existing learned rule",
			provenance: { note: "test", recorded_at: new Date().toISOString(), recorded_by: "human" },
			status: "active",
		}],
	});
	const propId = `cprop_${randomUUID().slice(0, 8)}`;
	const propRow = buildProposalRow({
		proposal_id: propId,
		factory_id: fac.factory_id,
		reference: "prop-ref-1",
		proposal_action: "add",
		source: "agent",
		target_constraint_id: null,
		assigned_constraint_id: null,
		text: "Always check queue output",
		run_id: retryLaunch.task_id,
		attempt_id: `${w2.instance_id}.1`,
		evidence_ref: `result:${w2.instance_id}`,
		note: "needed after retry",
		conflicting_ids: "[]",
		canonical_checkout: f.cwd,
		outcome: "pending",
		duplicate_of: null,
		rejection_reason: null,
		proposed_at: new Date().toISOString(),
		decided_at: null,
		decided_by: null,
		file_sync_state: null,
		expected_before_digest: null,
		expected_after_digest: null,
		committed_entry_json: null,
		sync_error: null,
		eligibility_json: JSON.stringify({
			kind: "revision",
			factory_attempt_id: "att",
			attempt_id: `${w2.instance_id}.1`,
			evidence_ref: `result:${w2.instance_id}`,
			verified_at: new Date().toISOString(),
		}),
	});
	const propDb = new DatabaseSync(f.dbPath);
	try { insertProposalRow(propDb, propRow); } finally { propDb.close(); }

	const selectTitles: string[] = [];
	const reviewConfirmDetails: string[] = [];
	const reviewCtx = f.makeCtx({
		select: async (title, choices) => { selectTitles.push(title); return choices[2]; },
		confirm: async (_title, detail) => { reviewConfirmDetails.push(detail); return true; },
	});
	await cmd.handler(`review-proposal retry-and-subcmds ${propId}`, reviewCtx.ctx);
	assert.equal(reviewCtx.notifications.at(-1)?.[1], "info", reviewCtx.notifications.at(-1)?.[0]);
	assert.ok(selectTitles[0]!.includes(fac.factory_id) && selectTitles[0]!.includes("retry-and-subcmds"));

	const retireConfirmDetails: string[] = [];
	const retireCtx = f.makeCtx({
		confirm: async (_title, detail) => { retireConfirmDetails.push(detail); return false; },
		input: async () => "Superseded by newer rule",
	});
	await cmd.handler("retire-constraint retry-and-subcmds c-active", retireCtx.ctx);
	assert.equal(retireCtx.notifications.at(-1)?.[1], "info", retireCtx.notifications.at(-1)?.[0]);
	assert.ok(retireConfirmDetails[0]!.includes(fac.factory_id) && retireConfirmDetails[0]!.includes("retry-and-subcmds"));

	await cmd.handler(`resolve-conflict retry-and-subcmds ${propId}`, retireCtx.ctx);
	assert.equal(retireCtx.notifications.at(-1)?.[1], "error");
	assert.doesNotMatch(retireCtx.notifications.at(-1)![0], /Factory not found/);
});

