import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { directionProcess } from "./factory-requests.ts";
import { createManagerAuthority, defaultFactoryStorePath, factoryOperations } from "../factory/operations.ts";
import {
	getFactoryViewerStatus,
	MAX_STDERR_BYTES,
	startFactoryViewer,
	stopFactoryViewer,
} from "../factory/viewer-command.ts";
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

/** Poll until a stopped/killed process has exited (ESRCH/EPERM or /proc/<pid>/stat state Z/X). */
async function assertPidDead(pid: number, message?: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isPidAlive(pid) && Date.now() < deadline) {
		await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
	}
	if (!isPidAlive(pid)) return;
	let statDetail = "";
	try {
		statDetail = ` (/proc/${pid}/stat: ${readFileSync(`/proc/${pid}/stat`, "utf8").trim()})`;
	} catch {
		// Re-check below in case the process exited while reading stat.
	}
	assert.equal(isPidAlive(pid), false, `${message ?? `expected process ${pid} to be dead`}${statDetail}`);
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

function readProcEnvMap(pid: number): Map<string, string> {
	const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
	const env = new Map<string, string>();
	for (const entry of raw.split("\0")) {
		if (!entry) continue;
		const eq = entry.indexOf("=");
		if (eq === -1) continue;
		env.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	return env;
}

async function startSpyServer(): Promise<{ url: string; port: number; getHits: () => number; close: () => Promise<void> }> {
	let hits = 0;
	const srv = createHttpServer((_req, res) => {
		hits++;
		res.writeHead(200, { "content-type": "application/json" });
		res.end("[]");
	});
	await new Promise<void>(resolveListen => srv.listen(0, "127.0.0.1", resolveListen));
	const port = (srv.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		getHits: () => hits,
		close: () => new Promise<void>(resolveClose => srv.close(() => resolveClose())),
	};
}

function createMockViewerExtension(root: string, name: string, cliSource: string): string {
	const extDir = join(root, name);
	mkdirSync(join(extDir, "factory", "viewer"), { recursive: true });
	writeFileSync(join(extDir, "factory", "viewer", "cli.ts"), cliSource, "utf8");
	return extDir;
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
		TMPDIR: process.env.TMPDIR,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TZ: process.env.TZ,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BOOTSTRAP_STATE_DIR: process.env.PI_BOOTSTRAP_STATE_DIR,
		PI_FACTORY_STATE_DIR: process.env.PI_FACTORY_STATE_DIR,
		PI_FACTORY_COORDINATION_DIR: process.env.PI_FACTORY_COORDINATION_DIR,
		PI_COMS_DIR: process.env.PI_COMS_DIR,
		FACTORY_STATE_PATH: process.env.FACTORY_STATE_PATH,
		FACTORY_VIEWER_PORT: process.env.FACTORY_VIEWER_PORT,
		FACTORY_VIEWER_HOST: process.env.FACTORY_VIEWER_HOST,
		NODE_OPTIONS: process.env.NODE_OPTIONS,
		SECRET_API_KEY: process.env.SECRET_API_KEY,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
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

	const readRecorded = (): {
		state?: string;
		pid: number;
		boot_id: string;
		start_time: string;
		port?: number;
		url?: string;
		store_path: string;
		coordination_dir?: string;
		sessions_dir?: string;
		started_at: string;
	} | undefined => {
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
	assert.equal(firstRec.state, "running");
	assert.equal(notifications.at(-1)?.[1], "info");
	const url = extractUrl(notifications.at(-1)![0]);
	assert.equal(new URL(url).hostname, "127.0.0.1");
	assert.equal(firstRec.url, url);
	assert.equal(firstRec.store_path, defaultFactoryStorePath());
	assert.equal(firstRec.coordination_dir, resolve(fx.coordDir));
	assert.equal(firstRec.sessions_dir, resolve(fx.sessionsDir));
	assert.ok(isPidAlive(firstRec.pid), "viewer process must be alive");
	assert.equal(lstatSync(fx.recordPath).mode & 0o777, 0o600, "runtime record must have mode 0600");

	// Verify /proc/<pid>/environ explicitly receives PI_BOOTSTRAP_STATE_DIR and coordination/state env vars (kills M19).
	const childEnvMap = readProcEnvMap(firstRec.pid);
	assert.equal(childEnvMap.get("PI_BOOTSTRAP_STATE_DIR"), fx.sessionsDir);
	assert.equal(childEnvMap.get("PI_FACTORY_COORDINATION_DIR"), fx.coordDir);
	assert.equal(childEnvMap.get("PI_FACTORY_STATE_DIR"), fx.stateDir);
	assert.equal(childEnvMap.get("FACTORY_STATE_PATH"), defaultFactoryStorePath());

	const listRes = await fetch(`${url}/api/factories`);
	assert.equal(listRes.status, 200);
	const listBody = await listRes.json() as { factories: Array<{ factory_id: string; name: string }>; deleted: unknown[]; damaged: unknown[] };
	assert.deepEqual(listBody.factories.map(f => ({ factory_id: f.factory_id, name: f.name })), [
		{ factory_id: alpha.factory_id, name: "viewer-alpha-fac" },
		{ factory_id: delta.factory_id, name: "viewer-delta-fac" },
	]);
	assert.deepEqual(listBody.deleted, []);
	assert.deepEqual(listBody.damaged, []);

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
	await assertPidDead(firstRec.pid);
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
	await assertPidDead(deadRec.pid);

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
	const spy = await startSpyServer();
	try {
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			state: "running",
			pid: sleeper.pid,
			boot_id: sleeperIdentity.boot,
			start_time: String(Number(sleeperIdentity.start) + 999),
			port: spy.port,
			url: spy.url,
			store_path: defaultFactoryStorePath(),
			coordination_dir: resolve(fx.coordDir),
			sessions_dir: resolve(fx.sessionsDir),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		// Stop must clear stale record and NEVER signal the sleeper.
		await fx.factoryCmd.handler("viewer stop", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		assert.equal(existsSync(fx.recordPath), false);
		assert.equal(isPidAlive(sleeper.pid!), true, "forged-record stop must NOT signal unrelated live PID");
		assert.equal(spy.getHits(), 0, "forged record must never be fetched");

		// Forged record naming `sleep` with REAL boot_id and REAL start_time -> rejected by cmdline check, NEVER reused or signalled!
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			state: "running",
			pid: sleeper.pid,
			boot_id: sleeperIdentity.boot,
			start_time: sleeperIdentity.start,
			port: spy.port,
			url: spy.url,
			store_path: defaultFactoryStorePath(),
			coordination_dir: resolve(fx.coordDir),
			sessions_dir: resolve(fx.sessionsDir),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		await fx.factoryCmd.handler("viewer status", ctx);
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		assert.equal(spy.getHits(), 0, "cmdline-mismatched record must NOT probe URL");

		await fx.factoryCmd.handler("viewer stop", ctx);
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		assert.equal(isPidAlive(sleeper.pid!), true, "stop on sleep with real boot_id/start_time must NOT signal sleeper");

		// Re-write forged sleep with real boot_id/start_time and run start -> must NOT reuse, must NOT fetch spy, must NOT signal sleeper.
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			state: "running",
			pid: sleeper.pid,
			boot_id: sleeperIdentity.boot,
			start_time: sleeperIdentity.start,
			port: spy.port,
			url: spy.url,
			store_path: defaultFactoryStorePath(),
			coordination_dir: resolve(fx.coordDir),
			sessions_dir: resolve(fx.sessionsDir),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /stale/i);
		assert.equal(spy.getHits(), 0, "start on sleep with real boot_id/start_time must NOT fetch spy URL");
		const freshRec = fx.readRecorded()!;
		assert.notEqual(freshRec.pid, sleeper.pid);
		assert.equal(isPidAlive(sleeper.pid!), true, "start on sleep with real boot_id/start_time must NOT signal sleeper");
		assert.equal((await fetch(`${freshRec.url}/api/factories`)).status, 200);
		await fx.factoryCmd.handler("viewer stop", ctx);

		// Forged boot_id mismatch on /factory viewer start must likewise treat as stale, not signal sleeper.
		writeFileSync(fx.recordPath, JSON.stringify({
			version: 1,
			state: "running",
			pid: sleeper.pid,
			boot_id: "00000000-0000-4000-8000-000000000000",
			start_time: sleeperIdentity.start,
			port: spy.port,
			url: spy.url,
			store_path: defaultFactoryStorePath(),
			coordination_dir: resolve(fx.coordDir),
			sessions_dir: resolve(fx.sessionsDir),
			started_at: new Date().toISOString(),
		}), { mode: 0o600 });

		await fx.factoryCmd.handler("viewer", ctx);
		assert.equal(notifications.at(-1)?.[1], "info");
		assert.match(notifications.at(-1)![0], /stale/i);
		const freshRec2 = fx.readRecorded()!;
		assert.notEqual(freshRec2.pid, sleeper.pid);
		assert.equal(isPidAlive(sleeper.pid!), true, "forged-record start must NOT signal unrelated live PID");
		assert.equal(spy.getHits(), 0);
		await fx.factoryCmd.handler("viewer stop", ctx);
	} finally {
		await spy.close();
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

	// Symlink to a VALID-LOOKING record pointing at a live viewer -> treated as corrupt/untrusted (kills M11).
	await fx.factoryCmd.handler("viewer", ctx);
	const realLiveRec = fx.readRecorded()!;
	const targetRecordFile = join(fx.root, "valid-target-record.json");
	writeFileSync(targetRecordFile, JSON.stringify(realLiveRec), { mode: 0o600 });
	unlinkSync(fx.recordPath);
	symlinkSync(targetRecordFile, fx.recordPath);
	try {
		await fx.factoryCmd.handler("viewer status", ctx);
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		await fx.factoryCmd.handler("viewer stop", ctx);
		assert.match(notifications.at(-1)![0], /no factory viewer is running/i);
		assert.equal(isPidAlive(realLiveRec.pid), true, "stop on symlinked valid record must NOT signal target viewer");
		assert.equal(readFileSync(targetRecordFile, "utf8"), JSON.stringify(realLiveRec), "symlink target must remain intact");

		symlinkSync(targetRecordFile, fx.recordPath);
		await fx.factoryCmd.handler("viewer", ctx);
		const replacedSymRec = fx.readRecorded()!;
		assert.notEqual(replacedSymRec.pid, realLiveRec.pid, "start must NOT reuse symlinked valid record");
		assert.equal(lstatSync(fx.recordPath).isSymbolicLink(), false);
		await fx.factoryCmd.handler("viewer stop", ctx);
	} finally {
		await stopVerifiedPid(realLiveRec.pid, realLiveRec.start_time);
	}

	// Mode 0666 (world-writable) and wrong-uid records -> treated as corrupt/untrusted, never reused or signalled.
	const liveSpy = await startSpyServer();
	const mockViewerExt = createMockViewerExtension(
		fx.root,
		"mock-viewer-perm",
		`import { createServer } from "node:http";
		const s = createServer((_req, res) => { res.writeHead(200); res.end("[]"); });
		s.listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			console.log("Factory Viewer: http://127.0.0.1:" + p);
		});
		process.on("SIGTERM", () => process.exit(0));`,
	);
	try {
		const startedMock = await startFactoryViewer({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
		assert.equal(startedMock.action, "started");
		fx.trackPid(startedMock.record.pid, startedMock.record.start_time);

		// chmod 0666 makes record untrusted.
		chmodSync(fx.recordPath, 0o666);
		const status0666 = await getFactoryViewerStatus({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
		assert.equal(status0666.running, false);
		assert.match(status0666.staleReason ?? "", /writable|permission|unsafe/i);

		const stop0666 = await stopFactoryViewer({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
		assert.equal(stop0666.stopped, false);
		assert.equal(isPidAlive(startedMock.record.pid), true, "0666 record must NOT be signalled by stop");

		// Restore valid 0600 record and test wrong-uid rejection via currentUid mismatch.
		writeFileSync(fx.recordPath, JSON.stringify(startedMock.record), { mode: 0o600 });
		const wrongUid = (process.getuid?.() ?? 1000) + 1;
		const statusUid = await getFactoryViewerStatus(
			{ extensionDir: mockViewerExt, env: process.env, home: fx.home },
			{ currentUid: () => wrongUid },
		);
		assert.equal(statusUid.running, false);
		assert.match(statusUid.staleReason ?? "", /owner|owned|uid/i);

		const stopUid = await stopFactoryViewer(
			{ extensionDir: mockViewerExt, env: process.env, home: fx.home },
			{ currentUid: () => wrongUid },
		);
		assert.equal(stopUid.stopped, false);
		assert.equal(isPidAlive(startedMock.record.pid), true, "wrong-uid record must NOT be signalled by stop");

		// Valid 0600 record owned by current user, but /proc/<pid>/status Uid mismatches -> rejected without signalling.
		writeFileSync(fx.recordPath, JSON.stringify(startedMock.record), { mode: 0o600 });
		const statusProcUid = await getFactoryViewerStatus(
			{ extensionDir: mockViewerExt, env: process.env, home: fx.home },
			{ readProcUid: () => ({ ruid: wrongUid, euid: wrongUid }) },
		);
		assert.equal(statusProcUid.running, false);
		assert.match(statusProcUid.staleReason ?? "", /uid mismatch/i);

		const stopProcUid = await stopFactoryViewer(
			{ extensionDir: mockViewerExt, env: process.env, home: fx.home },
			{ readProcUid: () => ({ ruid: wrongUid, euid: wrongUid }) },
		);
		assert.equal(stopProcUid.stopped, false);
		assert.equal(isPidAlive(startedMock.record.pid), true, "proc-uid mismatch must NOT be signalled by stop");

		// Restore valid record and stop cleanly.
		writeFileSync(fx.recordPath, JSON.stringify(startedMock.record), { mode: 0o600 });
		const cleanStop = await stopFactoryViewer({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
		assert.equal(cleanStop.stopped, true);
		await assertPidDead(startedMock.record.pid);

		// Non-loopback URL, URL with path/query, and mismatched port vs URL -> treated as corrupt, nothing fetched (M09, M10, M30).
		const badUrls = [
			{ url: "http://192.0.2.10:43210", port: 43210 },
			{ url: "http://localhost:43210", port: 43210 },
			{ url: `${liveSpy.url}/extra?foo=bar`, port: liveSpy.port },
			{ url: liveSpy.url, port: liveSpy.port + 1 },
		];
		for (const bad of badUrls) {
			const dummyChild = await startFactoryViewer({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
			fx.trackPid(dummyChild.record.pid, dummyChild.record.start_time);
			writeFileSync(fx.recordPath, JSON.stringify({
				...dummyChild.record,
				url: bad.url,
				port: bad.port,
			}), { mode: 0o600 });
			const stBad = await getFactoryViewerStatus({ extensionDir: mockViewerExt, env: process.env, home: fx.home });
			assert.equal(stBad.running, false, `bad url/port must be rejected: ${JSON.stringify(bad)}`);
			assert.equal(liveSpy.getHits(), 0, `bad url/port must never fetch: ${JSON.stringify(bad)}`);
			await stopVerifiedPid(dummyChild.record.pid, dummyChild.record.start_time);
			if (existsSync(fx.recordPath)) unlinkSync(fx.recordPath);
		}
	} finally {
		await liveSpy.close();
	}

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
	await assertPidDead(rec.pid);
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

	// 4. Startup timeout kills hung child, includes bounded stderr tail, leaves no record or stray process (kills M27).
	const hangExt = createMockViewerExtension(
		fx.root,
		"hang-ext",
		`console.error("EARLY-MARKER-" + "x".repeat(12000) + "-LATE-MARKER");
		setInterval(() => {}, 1000);`,
	);
	await assert.rejects(
		() => startFactoryViewer({ extensionDir: hangExt, env: process.env, home: fx.home, startupTimeoutMs: 400 }),
		(err: Error) => {
			assert.match(err.message, /timed out/i);
			assert.match(err.message, /LATE-MARKER/);
			assert.doesNotMatch(err.message, /EARLY-MARKER/);
			assert.ok(err.message.length <= MAX_STDERR_BYTES + 200, `error length ${err.message.length} exceeded bound`);
			return true;
		},
	);
	assert.equal(existsSync(fx.recordPath), false);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer stop escalates to SIGKILL when verified process ignores SIGTERM, normal stop sends no SIGKILL, and honors explicit port and ::1 host", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx, notifications } = fx.makeCtx();

	// 1. Normal stop sends only SIGTERM and never SIGKILL (kills M07).
	await fx.factoryCmd.handler("viewer", ctx);
	const normalRec = fx.readRecorded()!;
	const normalSignals: Array<[number, NodeJS.Signals | number]> = [];
	const normalStop = await stopFactoryViewer(
		{ extensionDir: repoRoot, env: process.env, home: fx.home },
		{ killProcess: (pid, sig) => { normalSignals.push([pid, sig]); return process.kill(pid, sig); } },
	);
	assert.equal(normalStop.stopped, true);
	if (normalStop.stopped) assert.equal(normalStop.killedWithSigkill, false);
	assert.deepEqual(normalSignals, [[normalRec.pid, "SIGTERM"]], "normal stop must send only SIGTERM and never SIGKILL");

	// 2. SIGTERM-ignoring verified viewer child -> SIGKILL fallback, record removed, process reaped.
	const stubbornExt = createMockViewerExtension(
		fx.root,
		"stubborn-ext",
		`import { createServer } from "node:http";
		process.on("SIGTERM", () => {});
		const s = createServer((_req, res) => { res.writeHead(200); res.end("[]"); });
		s.listen(0, "127.0.0.1", () => {
			console.log("Factory Viewer: http://127.0.0.1:" + s.address().port);
		});
		setInterval(() => {}, 1000);`,
	);
	const startedStubborn = await startFactoryViewer({ extensionDir: stubbornExt, env: process.env, home: fx.home });
	assert.equal(startedStubborn.action, "started");
	const stubbornPid = startedStubborn.record.pid;
	fx.trackPid(stubbornPid, startedStubborn.record.start_time);
	try {
		const stubbornSignals: Array<[number, NodeJS.Signals | number]> = [];
		const stoppedStubborn = await stopFactoryViewer(
			{ extensionDir: stubbornExt, env: process.env, home: fx.home },
			{ killProcess: (pid, sig) => { stubbornSignals.push([pid, sig]); return process.kill(pid, sig); } },
		);
		assert.equal(stoppedStubborn.stopped, true);
		if (stoppedStubborn.stopped) assert.equal(stoppedStubborn.killedWithSigkill, true);
		assert.deepEqual(stubbornSignals, [[stubbornPid, "SIGTERM"], [stubbornPid, "SIGKILL"]]);
		await assertPidDead(stubbornPid, "stubborn process must be killed by SIGKILL");
		assert.equal(existsSync(fx.recordPath), false);
	} finally {
		await stopVerifiedPid(stubbornPid, startedStubborn.record.start_time);
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

	// Extra argument after stop or status -> usage error (kills M32).
	await fx.factoryCmd.handler("viewer stop extra", ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /Usage: \/factory viewer \[stop \| status\]/);

	await fx.factoryCmd.handler("viewer status extra", ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /Usage: \/factory viewer \[stop \| status\]/);

	await fx.factoryCmd.handler("not-a-subcommand", ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /viewer \[stop \| status\]/);
});

test("/factory viewer refuses reuse on store/coordination/sessions mismatch and flags difference in status", async t => {
	const fx = setupFixture(t, { separateDirs: true });
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx, notifications } = fx.makeCtx();

	// Start viewer for store A.
	await fx.factoryCmd.handler("viewer", ctx);
	const recA = fx.readRecorded()!;
	assert.equal(recA.state, "running");
	assert.ok(isPidAlive(recA.pid));

	// Different PI_BOOTSTRAP_STATE_DIR (B) while sharing the same PI_CODING_AGENT_DIR -> refuse without reusing or killing A.
	const storeB = join(fx.root, "state-b");
	mkdirSync(storeB, { recursive: true });
	const envB: NodeJS.ProcessEnv = { ...process.env, PI_BOOTSTRAP_STATE_DIR: storeB };
	delete envB.PI_FACTORY_STATE_DIR;

	await assert.rejects(
		() => startFactoryViewer({ extensionDir: repoRoot, env: envB, home: fx.home }),
		(err: Error) => {
			assert.match(err.message, /already running for store/i);
			assert.ok(err.message.includes(recA.store_path), "mismatch error must name running store");
			assert.ok(err.message.includes(recA.url!), "mismatch error must show running URL");
			assert.match(err.message, /\/factory viewer stop/);
			return true;
		},
	);
	assert.equal(isPidAlive(recA.pid), true, "store mismatch must NOT kill existing viewer");
	assert.equal((await fetch(`${recA.url}/api/factories`)).status, 200);

	// Different PI_FACTORY_COORDINATION_DIR -> refuse without reusing or killing A.
	const coordB = join(fx.root, "coord-b");
	mkdirSync(coordB, { recursive: true });
	await assert.rejects(
		() => startFactoryViewer({ extensionDir: repoRoot, env: { ...process.env, PI_FACTORY_COORDINATION_DIR: coordB }, home: fx.home }),
		(err: Error) => {
			assert.match(err.message, /already running for store/i);
			assert.ok(err.message.includes(recA.url!));
			return true;
		},
	);
	assert.equal(isPidAlive(recA.pid), true);

	// Status under env B must report the store A viewer and flag that it differs from current store B.
	const statusB = await getFactoryViewerStatus({ extensionDir: repoRoot, env: envB, home: fx.home });
	assert.equal(statusB.running, true);
	if (statusB.running) {
		assert.equal(statusB.record.store_path, recA.store_path);
		assert.equal(statusB.storeMatches, false);
	}
	// Also verify /factory viewer status command notification flags store mismatch when PI_BOOTSTRAP_STATE_DIR changes.
	const prevBoot = process.env.PI_BOOTSTRAP_STATE_DIR;
	const prevFac = process.env.PI_FACTORY_STATE_DIR;
	process.env.PI_BOOTSTRAP_STATE_DIR = storeB;
	delete process.env.PI_FACTORY_STATE_DIR;
	try {
		const commandsB = new Map<string, any>();
		registerBootstrap({
			sendMessage: () => {},
			registerTool: () => {},
			registerCommand: (name: string, cmd: any) => commandsB.set(name, cmd),
			on: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		} as any);
		const ctxB = fx.makeCtx();
		await commandsB.get("factory").handler("viewer status", ctxB.ctx);
		assert.equal(ctxB.notifications.at(-1)?.[1], "info");
		assert.ok(ctxB.notifications.at(-1)![0].includes(recA.store_path), "status must show observed store");
		assert.match(ctxB.notifications.at(-1)![0], /differs/i);
	} finally {
		if (prevBoot === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR;
		else process.env.PI_BOOTSTRAP_STATE_DIR = prevBoot;
		if (prevFac === undefined) delete process.env.PI_FACTORY_STATE_DIR;
		else process.env.PI_FACTORY_STATE_DIR = prevFac;
	}

	await fx.factoryCmd.handler("viewer stop", ctx);
	await assertPidDead(recA.pid);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("viewer child survives process-group SIGHUP and SIGTERM sent to detached parent session (kills M23)", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const runnerPath = join(fx.root, "group-runner.ts");
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
await commands.get("factory").handler("viewer", {
  cwd: ${JSON.stringify(fx.projectCwd)},
  hasUI: false,
  ui: { notify: () => {} },
});
console.log("STARTED");
setInterval(() => {}, 1000);
`, "utf8");

	const parent = spawn(process.execPath, [runnerPath], {
		env: process.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const parentPid = parent.pid!;
	const parentExited = new Promise<void>(resolveExit => parent.once("close", () => resolveExit()));
	try {
		await new Promise<void>((resolveReady, rejectReady) => {
			let out = "";
			let err = "";
			const timer = setTimeout(() => rejectReady(new Error(`group runner failed to start: ${err}`)), 10_000);
			parent.stdout.on("data", chunk => {
				out += String(chunk);
				if (out.includes("STARTED")) {
					clearTimeout(timer);
					resolveReady();
				}
			});
			parent.stderr.on("data", chunk => { err += String(chunk); });
		});

		const rec = fx.readRecorded()!;
		assert.ok(rec);
		assert.ok(isPidAlive(rec.pid));

		// Send SIGHUP then SIGTERM to the parent's process group (-parentPid).
		process.kill(-parentPid, "SIGHUP");
		try { process.kill(-parentPid, "SIGTERM"); } catch { /* group may already be gone */ }
		await parentExited;

		// Viewer must survive process-group SIGHUP/SIGTERM and keep serving.
		await new Promise(r => setTimeout(r, 100));
		assert.equal(isPidAlive(rec.pid), true, "viewer must survive parent process-group SIGHUP/SIGTERM");
		const res = await fetch(`${rec.url}/api/factories`);
		assert.equal(res.status, 200);

		const { ctx } = fx.makeCtx();
		await fx.factoryCmd.handler("viewer stop", ctx);
		await assertPidDead(rec.pid);
	} finally {
		try { process.kill(-parentPid, "SIGKILL"); } catch { /* exited */ }
	}
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer writes starting record mid-start, reports starting in status, and cleans up orphaned starting process", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));
	const hangMarker = join(fx.root, "hang.flag");
	writeFileSync(hangMarker, "1", "utf8");

	const extDir = createMockViewerExtension(
		fx.root,
		"midstart-ext",
		`import { existsSync } from "node:fs";
		import { createServer } from "node:http";
		if (existsSync(${JSON.stringify(hangMarker)})) {
			setInterval(() => {}, 1000);
		} else {
			const s = createServer((_req, res) => { res.writeHead(200); res.end("[]"); });
			s.listen(0, "127.0.0.1", () => {
				console.log("Factory Viewer: http://127.0.0.1:" + s.address().port);
			});
			process.on("SIGTERM", () => process.exit(0));
		}`,
	);

	const starterScript = join(fx.root, "midstart-parent.ts");
	writeFileSync(starterScript, `
import { startFactoryViewer } from ${JSON.stringify(join(repoRoot, "factory", "viewer-command.ts"))};
await startFactoryViewer({
  extensionDir: ${JSON.stringify(extDir)},
  env: process.env,
  home: ${JSON.stringify(fx.home)},
  startupTimeoutMs: 30_000,
});
`, "utf8");

	const starter = spawn(process.execPath, [starterScript], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let starterStderr = "";
	starter.stderr.on("data", chunk => { starterStderr += String(chunk); });
	const starterClosed = new Promise<void>(resolveClosed => starter.once("close", () => resolveClosed()));
	let orphanPid: number | undefined;
	let orphanStart: string | undefined;
	try {
		// Wait until `starting` record appears on disk.
		const deadline = Date.now() + 5000;
		let startingRec: ReturnType<typeof fx.readRecorded>;
		while (Date.now() < deadline) {
			startingRec = fx.readRecorded();
			if (startingRec && startingRec.state === "starting") break;
			await new Promise(r => setTimeout(r, 25));
		}
		assert.ok(startingRec && startingRec.state === "starting", `expected starting record (stderr: ${starterStderr})`);
		orphanPid = startingRec.pid;
		orphanStart = startingRec.start_time;
		assert.equal(startingRec.url, undefined);
		assert.ok(isPidAlive(orphanPid));

		// Status reports `starting`.
		const st = await getFactoryViewerStatus({ extensionDir: extDir, env: process.env, home: fx.home });
		assert.equal(st.running, true);
		if (st.running) assert.equal(st.state, "starting");

		// Kill the starter process mid-start with SIGKILL.
		starter.kill("SIGKILL");
		await starterClosed;
		assert.equal(isPidAlive(orphanPid), true, "orphan child stays alive immediately after parent SIGKILL");

		// Remove hang marker; next start finds `starting` record, verifies identity, kills orphan, and starts cleanly.
		unlinkSync(hangMarker);
		const restarted = await startFactoryViewer({ extensionDir: extDir, env: process.env, home: fx.home });
		assert.equal(restarted.action, "started");
		assert.match(restarted.staleReason ?? "", /starting|orphan|interrupted/i);
		await assertPidDead(orphanPid, "next start must stop verified starting orphan");
		assert.notEqual(restarted.record.pid, orphanPid);
		assert.equal((await fetch(`${restarted.record.url}/api/factories`)).status, 200);
		fx.trackPid(restarted.record.pid, restarted.record.start_time);

		const finalRec = fx.readRecorded()!;
		assert.equal(finalRec.state, "running");

		const stopped = await stopFactoryViewer({ extensionDir: extDir, env: process.env, home: fx.home });
		assert.equal(stopped.stopped, true);
		await assertPidDead(restarted.record.pid);
	} finally {
		try { starter.kill("SIGKILL"); } catch { /* exited */ }
		if (orphanPid !== undefined) await stopVerifiedPid(orphanPid, orphanStart);
	}
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer child env uses allowlist (strips secrets and NODE_OPTIONS while keeping allowlisted vars)", async t => {
	const fx = setupFixture(t, { separateDirs: true });
	const beforePids = new Set(listViewerCliPids(fx.root));
	const { ctx } = fx.makeCtx();

	const comsDir = join(fx.root, "coms");
	const tmpDir = join(fx.root, "tmp");
	mkdirSync(comsDir, { recursive: true });
	mkdirSync(tmpDir, { recursive: true });
	process.env.TMPDIR = tmpDir;
	process.env.LANG = "C.UTF-8";
	process.env.LC_ALL = "C.UTF-8";
	process.env.TZ = "UTC";
	process.env.PI_COMS_DIR = comsDir;
	process.env.SECRET_API_KEY = "do-not-leak-secret";
	process.env.OPENAI_API_KEY = "sk-do-not-leak";
	process.env.NODE_OPTIONS = "--title=do-not-inherit";

	await fx.factoryCmd.handler("viewer", ctx);
	const rec = fx.readRecorded()!;
	assert.ok(rec);
	const childEnv = readProcEnvMap(rec.pid);
	assert.equal(childEnv.get("SECRET_API_KEY"), undefined, "unrelated secret var must NOT be in child environ");
	assert.equal(childEnv.get("OPENAI_API_KEY"), undefined, "API key must NOT be in child environ");
	assert.equal(childEnv.get("NODE_OPTIONS"), undefined, "NODE_OPTIONS must NOT be in child environ");

	assert.equal(childEnv.get("HOME"), fx.home);
	assert.equal(childEnv.get("TMPDIR"), tmpDir);
	assert.equal(childEnv.get("LANG"), "C.UTF-8");
	assert.equal(childEnv.get("LC_ALL"), "C.UTF-8");
	assert.equal(childEnv.get("TZ"), "UTC");
	assert.ok(childEnv.get("PATH"));
	assert.equal(childEnv.get("PI_CODING_AGENT_DIR"), fx.agentDir);
	assert.equal(childEnv.get("PI_BOOTSTRAP_STATE_DIR"), fx.sessionsDir);
	assert.equal(childEnv.get("PI_FACTORY_STATE_DIR"), fx.stateDir);
	assert.equal(childEnv.get("PI_FACTORY_COORDINATION_DIR"), fx.coordDir);
	assert.equal(childEnv.get("PI_COMS_DIR"), comsDir);
	assert.equal(childEnv.get("FACTORY_STATE_PATH"), defaultFactoryStorePath());

	await fx.factoryCmd.handler("viewer stop", ctx);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer refuses to reuse alive but unresponsive viewer within bounded timeout (kills M22)", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const unresponsiveExt = createMockViewerExtension(
		fx.root,
		"unresponsive-ext",
		`import { createServer } from "node:http";
		const s = createServer((_req, _res) => {
			// Intentionally never respond so health probe times out.
		});
		s.listen(0, "127.0.0.1", () => {
			console.log("Factory Viewer: http://127.0.0.1:" + s.address().port);
		});
		process.on("SIGTERM", () => process.exit(0));`,
	);

	const started = await startFactoryViewer({ extensionDir: unresponsiveExt, env: process.env, home: fx.home });
	assert.equal(started.action, "started");
	fx.trackPid(started.record.pid, started.record.start_time);

	const t0 = Date.now();
	await assert.rejects(
		() => startFactoryViewer({ extensionDir: unresponsiveExt, env: process.env, home: fx.home }),
		(err: Error) => {
			assert.match(err.message, /unresponsive/i);
			assert.match(err.message, /\/factory viewer stop/);
			return true;
		},
	);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 5_000, `unresponsive health check took too long (${elapsed}ms)`);
	assert.equal(isPidAlive(started.record.pid), true, "unresponsive viewer is not killed without explicit stop");

	const st = await getFactoryViewerStatus({ extensionDir: unresponsiveExt, env: process.env, home: fx.home });
	assert.equal(st.running, true);
	if (st.running && st.state === "running") {
		assert.equal(st.healthy, false);
	}

	const stopped = await stopFactoryViewer({ extensionDir: unresponsiveExt, env: process.env, home: fx.home });
	assert.equal(stopped.stopped, true);
	await assertPidDead(started.record.pid);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer resolves PATH node when execPath is non-node (compiled pi stand-in), verifies cmdline identity, and never executes fake pi", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const runtimeDir = join(fx.root, "runtime");
	const nodeBinDir = join(fx.root, "node-bin");
	mkdirSync(runtimeDir, { recursive: true });
	mkdirSync(nodeBinDir, { recursive: true });

	const fakePiPath = join(runtimeDir, "pi");
	const fakePiMarker = join(fx.root, "fake-pi-executed.txt");
	writeFileSync(
		fakePiPath,
		`#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(fakePiMarker)}\nsleep 30\n`,
		{ mode: 0o700 },
	);

	const pathNode = join(nodeBinDir, "node");
	symlinkSync(process.execPath, pathNode);

	const hostEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: nodeBinDir,
	};
	delete hostEnv.BOOTSTRAP_NODE;

	const started = await startFactoryViewer({
		extensionDir: repoRoot,
		env: hostEnv,
		home: fx.home,
		execPath: fakePiPath,
		startupTimeoutMs: 5_000,
	});
	assert.equal(started.action, "started");
	fx.trackPid(started.record.pid, started.record.start_time);

	assert.equal(existsSync(fakePiMarker), false, "non-node execPath must never be executed");
	const cmdlineArgs = readFileSync(`/proc/${started.record.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	assert.equal(cmdlineArgs[0], pathNode, `expected PATH node (${pathNode}), got ${cmdlineArgs[0]}`);
	assert.ok(cmdlineArgs.slice(1).some(arg => arg.endsWith("factory/viewer/cli.ts")));

	const res = await fetch(`${started.record.url}/api/factories`);
	assert.equal(res.status, 200);

	// Cmdline identity check must succeed for reuse, status, and stop when started via PATH node under non-node execPath.
	const reused = await startFactoryViewer({
		extensionDir: repoRoot,
		env: hostEnv,
		home: fx.home,
		execPath: fakePiPath,
		startupTimeoutMs: 5_000,
	});
	assert.equal(reused.action, "reused");
	assert.equal(reused.record.pid, started.record.pid);

	const status = await getFactoryViewerStatus({ extensionDir: repoRoot, env: hostEnv, home: fx.home });
	assert.equal(status.running, true);
	if (status.running && status.state === "running") {
		assert.equal(status.healthy, true);
	}

	const stopped = await stopFactoryViewer({ extensionDir: repoRoot, env: hostEnv, home: fx.home });
	assert.equal(stopped.stopped, true);
	await assertPidDead(started.record.pid);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer honours BOOTSTRAP_NODE override and fails closed before lock/record on invalid BOOTSTRAP_NODE or missing node", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const runtimeDir = join(fx.root, "runtime");
	const emptyPathDir = join(fx.root, "empty-path");
	const overrideDir = join(fx.root, "override-bin");
	mkdirSync(runtimeDir, { recursive: true });
	mkdirSync(emptyPathDir, { recursive: true });
	mkdirSync(overrideDir, { recursive: true });

	const fakePiPath = join(runtimeDir, "pi");
	const fakePiMarker = join(fx.root, "fake-pi-never.txt");
	writeFileSync(
		fakePiPath,
		`#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(fakePiMarker)}\nexit 0\n`,
		{ mode: 0o700 },
	);

	// 1. Valid absolute BOOTSTRAP_NODE override works even with empty PATH and non-node execPath, and is not leaked to child env.
	const overrideNode = join(overrideDir, "custom-node");
	symlinkSync(process.execPath, overrideNode);
	const validEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: emptyPathDir,
		BOOTSTRAP_NODE: overrideNode,
	};
	const started = await startFactoryViewer({
		extensionDir: repoRoot,
		env: validEnv,
		home: fx.home,
		execPath: fakePiPath,
		startupTimeoutMs: 5_000,
	});
	assert.equal(started.action, "started");
	fx.trackPid(started.record.pid, started.record.start_time);

	const cmdlineArgs = readFileSync(`/proc/${started.record.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	assert.equal(cmdlineArgs[0], overrideNode);
	const childEnvMap = readProcEnvMap(started.record.pid);
	assert.equal(childEnvMap.get("BOOTSTRAP_NODE"), undefined, "child viewer does not need BOOTSTRAP_NODE");
	assert.equal((await fetch(`${started.record.url}/api/factories`)).status, 200);

	const stopped = await stopFactoryViewer({ extensionDir: repoRoot, env: validEnv, home: fx.home });
	assert.equal(stopped.stopped, true);
	await assertPidDead(started.record.pid);

	// 2. Invalid BOOTSTRAP_NODE (non-node script) -> fails closed BEFORE creating lock/record/dir.
	const badOverride = join(overrideDir, "not-node");
	writeFileSync(badOverride, "#!/bin/sh\necho 'not node' >&2\nexit 7\n", { mode: 0o700 });
	const freshAgentDir1 = join(fx.root, "fresh-agent-invalid-override");
	await assert.rejects(
		() => startFactoryViewer({
			extensionDir: repoRoot,
			env: { ...process.env, PI_CODING_AGENT_DIR: freshAgentDir1, PATH: emptyPathDir, BOOTSTRAP_NODE: badOverride },
			home: fx.home,
			execPath: fakePiPath,
		}),
		(err: Error) => {
			assert.match(err.message, /Invalid BOOTSTRAP_NODE/);
			assert.match(err.message, /--experimental-strip-types/);
			return true;
		},
	);
	assert.equal(existsSync(freshAgentDir1), false, "invalid BOOTSTRAP_NODE must not create agent dir, lock, or record");
	assert.equal(existsSync(fakePiMarker), false);

	// 3. Non-node execPath and no node on PATH -> fails closed BEFORE creating lock/record/dir.
	const freshAgentDir2 = join(fx.root, "fresh-agent-no-node");
	const noNodeEnv: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: freshAgentDir2,
		PATH: emptyPathDir,
	};
	delete noNodeEnv.BOOTSTRAP_NODE;
	await assert.rejects(
		() => startFactoryViewer({
			extensionDir: repoRoot,
			env: noNodeEnv,
			home: fx.home,
			execPath: fakePiPath,
		}),
		(err: Error) => {
			assert.match(err.message, /Required Node binary/);
			assert.ok(err.message.includes(fakePiPath), `expected error to name ${fakePiPath}: ${err.message}`);
			assert.match(err.message, /BOOTSTRAP_NODE/);
			return true;
		},
	);
	assert.equal(existsSync(freshAgentDir2), false, "missing node must not create agent dir, lock, or record");
	assert.equal(existsSync(fakePiMarker), false);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});

test("/factory viewer startup diagnostics report immediate exit code/stderr without waiting timeout and include interpreter/entry on timeout without secrets", async t => {
	const fx = setupFixture(t);
	const beforePids = new Set(listViewerCliPids(fx.root));

	const nodeBinDir = join(fx.root, "diag-node-bin");
	mkdirSync(nodeBinDir, { recursive: true });
	const resolvedNode = join(nodeBinDir, "node");
	symlinkSync(process.execPath, resolvedNode);

	const diagEnv: NodeJS.ProcessEnv = {
		...process.env,
		PATH: nodeBinDir,
		SECRET_API_KEY: "super-secret-value-do-not-print",
	};
	delete diagEnv.BOOTSTRAP_NODE;

	// 1. Immediate exit before URL (exit code 3 + large stderr) -> fails promptly without waiting startupTimeoutMs.
	const exitExt = createMockViewerExtension(
		fx.root,
		"exit-ext",
		`console.error("EARLY-EXIT-" + "y".repeat(12000) + "-LATE-EXIT");
		process.exit(3);`,
	);
	const exitCli = join(exitExt, "factory", "viewer", "cli.ts");
	const t0 = Date.now();
	await assert.rejects(
		() => startFactoryViewer({
			extensionDir: exitExt,
			env: diagEnv,
			home: fx.home,
			execPath: "/nonexistent/fake-pi",
			startupTimeoutMs: 8_000,
		}),
		(err: Error) => {
			assert.match(err.message, /code 3/);
			assert.match(err.message, /LATE-EXIT/);
			assert.doesNotMatch(err.message, /EARLY-EXIT/);
			assert.ok(err.message.includes(resolvedNode), `expected interpreter ${resolvedNode} in: ${err.message}`);
			assert.ok(err.message.includes(exitCli), `expected entry ${exitCli} in: ${err.message}`);
			assert.doesNotMatch(err.message, /super-secret-value-do-not-print/);
			return true;
		},
	);
	const exitElapsed = Date.now() - t0;
	assert.ok(exitElapsed < 3_000, `immediate exit waited too long (${exitElapsed}ms)`);
	assert.equal(existsSync(fx.recordPath), false);

	// 2. Timeout diagnostic includes resolved interpreter path and entry path, and omits secrets/env.
	const hangExt = createMockViewerExtension(
		fx.root,
		"hang-diag-ext",
		`console.error("hung without url");
		setInterval(() => {}, 1000);`,
	);
	const hangCli = join(hangExt, "factory", "viewer", "cli.ts");
	await assert.rejects(
		() => startFactoryViewer({
			extensionDir: hangExt,
			env: diagEnv,
			home: fx.home,
			execPath: "/nonexistent/fake-pi",
			startupTimeoutMs: 300,
		}),
		(err: Error) => {
			assert.match(err.message, /timed out/i);
			assert.ok(err.message.includes(resolvedNode), `expected resolved interpreter ${resolvedNode} in: ${err.message}`);
			assert.ok(err.message.includes(hangCli), `expected entry ${hangCli} in: ${err.message}`);
			assert.match(err.message, /hung without url/);
			assert.doesNotMatch(err.message, /super-secret-value-do-not-print/);
			assert.doesNotMatch(err.message, /SECRET_API_KEY/);
			return true;
		},
	);
	assert.equal(existsSync(fx.recordPath), false);
	assert.deepEqual(listViewerCliPids(fx.root).filter(p => !beforePids.has(p)), []);
});
