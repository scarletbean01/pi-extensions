import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { directionProcess } from "./factory-requests.ts";
import { createManagerAuthority, defaultFactoryStorePath, factoryOperations } from "../factory/operations.ts";
import { BootstrapService, type ExecResult } from "./lifecycle.ts";
import { assertStateDirUnchanged, snapshotStateDir } from "./test-support/factory-viewer-fixture.ts";

// Pi supplies TypeBox at runtime; the test harness only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, _context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function listViewerCliPids(envMarker?: string): number[] {
	const out = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
	if (out.status !== 0) return [];
	const pids: number[] = [];
	for (const line of out.stdout.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const cmd = match[2] ?? "";
		if (pid !== process.pid && cmd.includes("factory/viewer/cli.ts")) {
			if (envMarker) {
				try {
					const envText = readFileSync(`/proc/${pid}/environ`, "utf8");
					if (!envText.includes(envMarker)) continue;
				} catch {
					continue;
				}
			}
			pids.push(pid);
		}
	}
	return pids;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error: any) {
		if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
		throw error;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
		return state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

async function stopVerifiedPid(pid: number, expectedStartTime?: string): Promise<void> {
	if (!isPidAlive(pid)) return;
	if (expectedStartTime !== undefined) {
		try {
			if (directionProcess(pid).start !== expectedStartTime) return;
		} catch {
			return;
		}
	}
	try { process.kill(pid, "SIGTERM"); } catch { return; }
	const deadline = Date.now() + 2000;
	while (isPidAlive(pid) && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 25));
	}
	if (isPidAlive(pid)) {
		if (expectedStartTime !== undefined) {
			try {
				if (directionProcess(pid).start !== expectedStartTime) return;
			} catch {
				return;
			}
		}
		try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
	}
}

function extractUrl(message: string): string {
	const match = /(http:\/\/(?:\[::1\]|127\.0\.0\.1):\d+)/.exec(message);
	assert.ok(match, `Expected loopback URL in message: ${message}`);
	return match[1]!;
}

function setupFixture(t: test.TestContext, opts: { separateDirs?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "factory-viewer-cmd-"));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const stateDir = opts.separateDirs ? join(root, "factory-state") : join(root, "bootstrap-sessions");
	const sessionsDir = join(root, "bootstrap-sessions");
	const coordDir = opts.separateDirs ? join(root, "coord-state") : join(root, "coord");
	const projectCwd = join(root, "project");
	const binDir = join(root, "bin");
	for (const dir of [home, agentDir, stateDir, sessionsDir, coordDir, binDir, join(projectCwd, ".pi", "agents"), join(projectCwd, "extensions")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(projectCwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\nmodel: provider/model\nthinking: medium\ntools: read\n---\nReview.\n");
	writeFileSync(join(projectCwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["pi", "herdr"]) writeFileSync(join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

	const savedEnv: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BOOTSTRAP_STATE_DIR: process.env.PI_BOOTSTRAP_STATE_DIR,
		PI_FACTORY_STATE_DIR: process.env.PI_FACTORY_STATE_DIR,
		PI_FACTORY_COORDINATION_DIR: process.env.PI_FACTORY_COORDINATION_DIR,
		FACTORY_STATE_PATH: process.env.FACTORY_STATE_PATH,
		FACTORY_VIEWER_PORT: process.env.FACTORY_VIEWER_PORT,
		FACTORY_VIEWER_HOST: process.env.FACTORY_VIEWER_HOST,
		NODE_OPTIONS: process.env.NODE_OPTIONS,
	};

	process.env.PATH = `${binDir}:${savedEnv.PATH ?? ""}`;
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_BOOTSTRAP_STATE_DIR = sessionsDir;
	if (opts.separateDirs) process.env.PI_FACTORY_STATE_DIR = stateDir;
	else delete process.env.PI_FACTORY_STATE_DIR;
	process.env.PI_FACTORY_COORDINATION_DIR = coordDir;
	delete process.env.FACTORY_STATE_PATH;
	delete process.env.FACTORY_VIEWER_PORT;
	delete process.env.FACTORY_VIEWER_HOST;
	delete process.env.NODE_OPTIONS;

	const spawnedPids = new Map<number, string | undefined>();
	const recordPath = join(agentDir, "factory-viewer.json");

	t.after(async () => {
		try {
			if (existsSync(recordPath)) {
				const raw = JSON.parse(readFileSync(recordPath, "utf8")) as { pid?: number; start_time?: string };
				if (typeof raw.pid === "number" && Number.isInteger(raw.pid)) {
					spawnedPids.set(raw.pid, typeof raw.start_time === "string" ? raw.start_time : undefined);
				}
			}
		} catch { /* ignore corrupt record during cleanup */ }
		for (const [pid, startTime] of spawnedPids) {
			await stopVerifiedPid(pid, startTime);
		}
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const commands = new Map<string, any>();
	registerBootstrap({
		sendMessage: () => {},
		registerTool: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);

	const factoryCmd = commands.get("factory");
	assert.ok(factoryCmd, "/factory command must be registered");

	const makeCtx = () => {
		const notifications: Array<[string, string]> = [];
		const ctx: any = {
			cwd: projectCwd,
			hasUI: false,
			sessionManager: {
				getSessionId: () => "viewer-test-sess",
				getSessionFile: () => join(root, "viewer-test-sess.jsonl"),
			},
			ui: {
				notify: (message: string, level: string) => { notifications.push([message, level]); },
			},
		};
		return { ctx, notifications };
	};

	const readRecorded = (): { pid: number; boot_id: string; start_time: string; port: number; url: string; store_path: string; started_at: string } | undefined => {
		try {
			const rec = JSON.parse(readFileSync(recordPath, "utf8"));
			if (typeof rec.pid === "number") spawnedPids.set(rec.pid, rec.start_time);
			return rec;
		} catch {
			return undefined;
		}
	};

	return {
		root,
		home,
		agentDir,
		stateDir,
		sessionsDir,
		coordDir,
		projectCwd,
		recordPath,
		factoryCmd,
		makeCtx,
		readRecorded,
		trackPid: (pid: number, startTime?: string) => { spawnedPids.set(pid, startTime); },
	};
}

async function seedRunningAndCheckoutBlockedFactories(fx: ReturnType<typeof setupFixture>) {
	const storePath = defaultFactoryStorePath();
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(item => item.pane_id === args[2]);
			if (!tab) return ok();
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(tab.cwd, ".pi", "agent-sessions", task!);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			const ready = {
				task_id: task!,
				token: config.token,
				instance_id: instance!,
				name: instance!,
				pid: process.pid,
				session_id: `session-${instance}`,
				endpoint: "/tmp/fake-coms",
				model: config.expected_model,
			};
			atomicJson(readyPath(sessionDir, instance!), ready);
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
	};
	const service = new BootstrapService({
		extensionDir: repoRoot,
		env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		home: fx.home,
		pollMs: 5,
		exec,
	});
	const ops = factoryOperations(storePath, service);
	const draft = {
		topology: "graph" as const,
		task: "Inspectable task",
		project_cwd: fx.projectCwd,
		agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review" }],
	};
	const alpha = ops({ action: "publish", name: "viewer-alpha-fac", draft });
	const auth = createManagerAuthority({ pi_session_id: "seed-coord" });
	ops({ action: "resume", factory_id: alpha.factory_id, authority: auth });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: auth, reference: "ref-alpha", brief: "Alpha brief" });
	await ops({ action: "launch", factory_id: alpha.factory_id, authority: auth });
	const delta = ops({ action: "publish", name: "viewer-delta-fac", draft });
	return { alpha, delta };
}

function seedManagedStoppedFactory(fx: ReturnType<typeof setupFixture>, name: string) {
	const storePath = defaultFactoryStorePath();
	const service = new BootstrapService({ extensionDir: repoRoot, env: process.env, home: fx.home });
	const ops = factoryOperations(storePath, service);
	return ops({
		action: "publish",
		name,
		draft: {
			topology: "graph",
			task: "Inspectable task",
			project_cwd: fx.projectCwd,
			agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review" }],
		},
	});
}

test("/factory viewer starts a detached loopback viewer, passes coordination/session env, reuses live instance, and preserves fixture bytes", async t => {
	const fx = setupFixture(t, { separateDirs: true });
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { alpha, delta } = await seedRunningAndCheckoutBlockedFactories(fx);

	const stateSnaps = [fx.stateDir, fx.coordDir, fx.sessionsDir, fx.projectCwd].map(dir => [dir, snapshotStateDir(dir)] as const);
	const { ctx, notifications } = fx.makeCtx();

	// 1. Start viewer.
	await fx.factoryCmd.handler("viewer", ctx);
	const firstRec = fx.readRecorded();
	assert.ok(firstRec, "runtime record must exist after start");
	assert.equal(notifications.at(-1)?.[1], "info");
	const url = extractUrl(notifications.at(-1)![0]);
	assert.equal(new URL(url).hostname, "127.0.0.1");
	assert.equal(firstRec.url, url);
	assert.equal(firstRec.store_path, defaultFactoryStorePath());
	assert.ok(isPidAlive(firstRec.pid), "viewer process must be alive");
	assert.equal(lstatSync(fx.recordPath).mode & 0o777, 0o600, "runtime record must have mode 0600");

	const listRes = await fetch(`${url}/api/factories`);
	assert.equal(listRes.status, 200);
	const listBody = await listRes.json() as Array<{ factory_id: string; name: string }>;
	assert.deepEqual(listBody.map(f => ({ factory_id: f.factory_id, name: f.name })), [
		{ factory_id: alpha.factory_id, name: "viewer-alpha-fac" },
		{ factory_id: delta.factory_id, name: "viewer-delta-fac" },
	]);

	// Coordination dir & bootstrap session dir passthrough checks (both dirs are separate from HOME/.pi/agent).
	const alphaLiveRes = await fetch(`${url}/api/factories/${alpha.factory_id}/live`);
	assert.equal(alphaLiveRes.status, 200);
	const alphaLive = await alphaLiveRes.json() as { state: string };
	assert.equal(alphaLive.state, "running", "viewer must receive PI_FACTORY_COORDINATION_DIR and PI_BOOTSTRAP_STATE_DIR");

	const deltaLiveRes = await fetch(`${url}/api/factories/${delta.factory_id}/live`);
	assert.equal(deltaLiveRes.status, 200);
	const deltaLive = await deltaLiveRes.json() as { state: string };
	assert.equal(deltaLive.state, "blocked", "viewer must observe checkout hold in PI_FACTORY_COORDINATION_DIR");

	// 2. Second /factory viewer reuses existing instance and does not start another process.
	await fx.factoryCmd.handler("viewer", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.equal(extractUrl(notifications.at(-1)![0]), url);
	const secondRec = fx.readRecorded();
	assert.equal(secondRec?.pid, firstRec.pid, "PID must remain unchanged on second /factory viewer");
	const duringPids = listViewerCliPids(fx.root).filter(p => !beforePids.has(p));
	assert.equal(duringPids.length, 1, "exactly one viewer process may run");

	// 3. /factory viewer status reports running without mutating state.
	await fx.factoryCmd.handler("viewer status", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	for (const [dir, snap] of stateSnaps) assertStateDirUnchanged(dir, snap);

	// 4. /factory viewer stop kills verified process and removes record.
	await fx.factoryCmd.handler("viewer stop", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], /stopped/i);
	assert.equal(isPidAlive(firstRec.pid), false);
	assert.equal(existsSync(fx.recordPath), false, "runtime record must be removed after stop");

	for (const [dir, snap] of stateSnaps) assertStateDirUnchanged(dir, snap);

	// 5. Stop/status when none is running report plainly.
	await fx.factoryCmd.handler("viewer stop", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], /no factory viewer is running/i);

	await fx.factoryCmd.handler("viewer status", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], /no factory viewer is running/i);

	const afterPids = listViewerCliPids(fx.root).filter(p => !beforePids.has(p));
	assert.deepEqual(afterPids, [], "no viewer cli.ts processes may remain after test");
});

test("/factory viewer detects stale dead viewer, replaces it, and never signals unrelated PIDs on forged/corrupt/symlink records", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx, notifications } = fx.makeCtx();

	// Start and manually kill the viewer, leaving a stale record.
	await fx.factoryCmd.handler("viewer", ctx);
	const deadRec = fx.readRecorded()!;
	await stopVerifiedPid(deadRec.pid, deadRec.start_time);
	assert.equal(isPidAlive(deadRec.pid), false);

	await fx.factoryCmd.handler("viewer", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], /stale/i);
	const replacedRec = fx.readRecorded()!;
	assert.notEqual(replacedRec.pid, deadRec.pid);
	assert.ok(isPidAlive(replacedRec.pid));
	await fx.factoryCmd.handler("viewer stop", ctx);

	// Forged record pointing to a live unrelated `sleep` child with mismatching identity.
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	const sleeperIdentity = directionProcess(sleeper.pid!);
	fx.trackPid(sleeper.pid!, sleeperIdentity.start);
	try {
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			pid: sleeper.pid,
			boot_id: sleeperIdentity.boot,
			start_time: String(Number(sleeperIdentity.start) + 999),
			port: 43210,
			url: "http://127.0.0.1:43210",
			store_path: defaultFactoryStorePath(),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		// Stop must clear stale record and NEVER signal the sleeper.
		await fx.factoryCmd.handler("viewer stop", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		assert.equal(existsSync(fx.recordPath), false);
		assert.equal(isPidAlive(sleeper.pid!), true, "forged-record stop must NOT signal unrelated live PID");

		// Forged boot_id mismatch on /factory viewer start must likewise treat as stale, not signal sleeper, and start real viewer.
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			pid: sleeper.pid,
			boot_id: "00000000-0000-4000-8000-000000000000",
			start_time: sleeperIdentity.start,
			port: 43211,
			url: "http://127.0.0.1:43211",
			store_path: defaultFactoryStorePath(),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /stale/i);
		const freshRec = fx.readRecorded()!;
		assert.notEqual(freshRec.pid, sleeper.pid);
		assert.equal(isPidAlive(sleeper.pid!), true, "forged-record start must NOT signal unrelated live PID");
		assert.equal((await fetch(`${freshRec.url}/api/factories`)).status, 200);
		await fx.factoryCmd.handler("viewer stop", ctx);
	} finally {
		await stopVerifiedPid(sleeper.pid!, sleeperIdentity.start);
	}

	// Corrupt JSON record -> treated as stale without crashing.
	writeFileSync(fx.recordPath, "{corrupt json", { mode: 0o600 });
	await fx.factoryCmd.handler("viewer", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.match(notifications.at(-1)![0], /stale/i);
	const afterCorruptRec = fx.readRecorded()!;
	assert.equal((await fetch(`${afterCorruptRec.url}/api/factories`)).status, 200);
	await fx.factoryCmd.handler("viewer stop", ctx);

	// Symlink record -> treated as corrupt/stale, symlink target untouched, replaced atomically.
	const targetFile = join(fx.root, "do-not-touch.txt");
	writeFileSync(targetFile, "intact", "utf8");
	symlinkSync(targetFile, fx.recordPath);
	await fx.factoryCmd.handler("viewer", ctx);
	assert.equal(readFileSync(targetFile, "utf8"), "intact");
	assert.equal(lstatSync(fx.recordPath).isSymbolicLink(), false);
	fx.readRecorded();
	await fx.factoryCmd.handler("viewer stop", ctx);

	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("concurrent /factory viewer invocations start exactly one viewer", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const c1 = fx.makeCtx();
	const c2 = fx.makeCtx();

	await Promise.all([
		fx.factoryCmd.handler("viewer", c1.ctx),
		fx.factoryCmd.handler("viewer", c2.ctx),
	]);

	const rec = fx.readRecorded()!;
	assert.ok(rec);
	assert.equal(c1.notifications.at(-1)?.[1], "info");
	assert.equal(c2.notifications.at(-1)?.[1], "info");
	assert.equal(extractUrl(c1.notifications.at(-1)![0]), rec.url);
	assert.equal(extractUrl(c2.notifications.at(-1)![0]), rec.url);

	const activePids = listViewerCliPids(fx.root).filter(p => !beforePids.has(p));
	assert.deepEqual(activePids, [rec.pid], "concurrent start must produce exactly one viewer child");

	await fx.factoryCmd.handler("viewer stop", c1.ctx);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("viewer child survives after parent Pi/node process exits and can be stopped later", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const runnerPath = join(fx.root, "parent-runner.ts");
	writeFileSync(runnerPath, `
import { registerHooks } from "node:module";
const typeboxUrl = \`data:text/javascript,\${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}\`;
registerHooks({ resolve(specifier, _context, next) {
  return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import(${JSON.stringify(join(repoRoot, "bootstrap.ts"))});
const commands = new Map();
registerBootstrap({
  sendMessage: () => {},
  registerTool: () => {},
  registerCommand: (name, cmd) => commands.set(name, cmd),
  on: () => {},
  registerFlag: () => {},
  getFlag: () => undefined,
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
});
const notes = [];
await commands.get("factory").handler("viewer", {
  cwd: ${JSON.stringify(fx.projectCwd)},
  hasUI: false,
  ui: { notify: (msg, lvl) => notes.push([msg, lvl]) },
});
console.log(JSON.stringify(notes));
`, "utf8");

	const parentResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [runnerPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => { stdout += String(chunk); });
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("parent runner hung (pipes/child not detached)")); }, 10_000);
		child.once("close", code => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});

	assert.equal(parentResult.code, 0, parentResult.stderr);
	const rec = fx.readRecorded()!;
	assert.ok(rec);
	assert.ok(isPidAlive(rec.pid), "viewer child must remain alive after parent process exits");
	const res = await fetch(`${rec.url}/api/factories`);
	assert.equal(res.status, 200);

	const { ctx, notifications } = fx.makeCtx();
	await fx.factoryCmd.handler("viewer stop", ctx);
	assert.equal(notifications.at(-1)?.[1], "info");
	assert.equal(isPidAlive(rec.pid), false);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer startup failures (port in use, bad store path, non-loopback host, timeout) reap child and leave no record", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx, notifications } = fx.makeCtx();

	// 1. Port already in use via FACTORY_VIEWER_PORT.
	const blocker = createServer();
	await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
	const busyPort = (blocker.address() as { port: number }).port;
	try {
		process.env.FACTORY_VIEWER_PORT = String(busyPort);
		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "error");
		assert.match(notifications.at(-1)![0], /EADDRINUSE|in use|exited before printing URL/i);
		assert.equal(existsSync(fx.recordPath), false);
		assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
	} finally {
		delete process.env.FACTORY_VIEWER_PORT;
		await new Promise<void>(resolve => blocker.close(() => resolve()));
	}

	// 2. Bad store path env (empty FACTORY_STATE_PATH).
	process.env.FACTORY_STATE_PATH = "";
	try {
		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "error");
		assert.match(notifications.at(-1)![0], /FACTORY_STATE_PATH cannot be empty/i);
		assert.equal(existsSync(fx.recordPath), false);
		assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
	} finally {
		delete process.env.FACTORY_STATE_PATH;
	}

	// 3. Non-loopback host refused.
	process.env.FACTORY_VIEWER_HOST = "0.0.0.0";
	try {
		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "error");
		assert.match(notifications.at(-1)![0], /loopback/i);
		assert.equal(existsSync(fx.recordPath), false);
		assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
	} finally {
		delete process.env.FACTORY_VIEWER_HOST;
	}

	// 4. Startup timeout kills hung child, includes stderr tail, leaves no record or stray process.
	const hangPreload = join(fx.root, "hang-preload.mjs");
	writeFileSync(hangPreload, `
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    if (url.endsWith("/factory/viewer/cli.ts")) {
      return {
        format: "module",
        source: 'console.error("simulated-viewer-hang-stderr"); setInterval(() => {}, 1000);',
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
`, "utf8");
	process.env.NODE_OPTIONS = `--import=${hangPreload}`;
	try {
		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "error");
		assert.match(notifications.at(-1)![0], /timed out/i);
		assert.match(notifications.at(-1)![0], /simulated-viewer-hang-stderr/);
		assert.equal(existsSync(fx.recordPath), false);
		assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
	} finally {
		delete process.env.NODE_OPTIONS;
	}
});

test("/factory viewer stop escalates to SIGKILL when verified process ignores SIGTERM, and honors explicit port and ::1 host", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx, notifications } = fx.makeCtx();

	// 1. SIGTERM-ignoring verified child -> SIGKILL fallback, record removed, process reaped.
	const stubborn = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise<void>((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error("stubborn child failed to print READY")), 5000);
		stubborn.stdout.on("data", chunk => {
			out += String(chunk);
			if (out.includes("READY")) {
				clearTimeout(timer);
				stubborn.stdout.destroy();
				resolve();
			}
		});
	});
	stubborn.unref();
	const stubbornId = directionProcess(stubborn.pid!);
	fx.trackPid(stubborn.pid!, stubbornId.start);
	try {
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			pid: stubborn.pid,
			boot_id: stubbornId.boot,
			start_time: stubbornId.start,
			port: 45123,
			url: "http://127.0.0.1:45123",
			store_path: defaultFactoryStorePath(),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		await fx.factoryCmd.handler("viewer stop", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /SIGKILL/);
		assert.equal(isPidAlive(stubborn.pid!), false, "stubborn process must be killed by SIGKILL");
		assert.equal(existsSync(fx.recordPath), false);
	} finally {
		await stopVerifiedPid(stubborn.pid!, stubbornId.start);
	}

	// 2. Explicit FACTORY_VIEWER_PORT and ::1 loopback host.
	const probe = createServer();
	await new Promise<void>(resolve => probe.listen(0, "::1", resolve));
	const freePort = (probe.address() as { port: number }).port;
	await new Promise<void>(resolve => probe.close(() => resolve()));

	process.env.FACTORY_VIEWER_HOST = "::1";
	process.env.FACTORY_VIEWER_PORT = String(freePort);
	try {
		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		const url = extractUrl(notifications.at(-1)![0]);
		assert.equal(url, `http://[::1]:${freePort}`);
		const rec = fx.readRecorded()!;
		assert.equal(rec.port, freePort);
		assert.equal((await fetch(`${url}/api/factories`)).status, 200);
		await fx.factoryCmd.handler("viewer stop", ctx);
	} finally {
		delete process.env.FACTORY_VIEWER_HOST;
		delete process.env.FACTORY_VIEWER_PORT;
	}

	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer completions, usage, and non-target isolation", async t => {
	const fx = setupFixture(t);
	seedManagedStoppedFactory(fx, "comp-fac");
	const { ctx, notifications } = fx.makeCtx();

	const topCompletions = (fx.factoryCmd.getArgumentCompletions("") as Array<{ value: string }>).map(c => c.value);
	assert.ok(topCompletions.includes("viewer"));

	const viewerSubs = (fx.factoryCmd.getArgumentCompletions("viewer ") as Array<{ value: string }>).map(c => c.value);
	assert.deepEqual(viewerSubs, ["viewer stop", "viewer status"]);
	assert.equal(viewerSubs.some(v => v.includes("comp-fac")), false, "viewer must not complete factory names");

	const viewerPrefix = (fx.factoryCmd.getArgumentCompletions("viewer sto") as Array<{ value: string }>).map(c => c.value);
	assert.deepEqual(viewerPrefix, ["viewer stop"]);
	assert.equal(fx.factoryCmd.getArgumentCompletions("viewer stop "), null);

	await fx.factoryCmd.handler("viewer bogus", ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /Usage: \/factory viewer \[stop \| status\]/);

	await fx.factoryCmd.handler("not-a-subcommand", ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /viewer \[stop \| status\]/);
});
