import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piAgentDir, resolveNodeBinary } from "../bootstrap/bootstrap-utils.ts";
import { directionProcess } from "../bootstrap/factory-requests.ts";
import { atomicJson, delay, errorMessage, isRecord, processAlive, withRunLock } from "../bootstrap/session-store.ts";
import { defaultFactoryStorePath } from "./operations.ts";

export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const STOP_SIGTERM_WAIT_MS = 5_000;
export const STOP_SIGKILL_WAIT_MS = 2_000;
export const HEALTH_TIMEOUT_MS = 1_500;
const MAX_RECORD_BYTES = 65_536;
export const MAX_STDERR_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const DEFAULT_EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit allowlist for detached viewer env: never forward unrelated secrets or NODE_OPTIONS.
const ALLOWED_VIEWER_ENV_VARS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"TZ",
	"PI_CODING_AGENT_DIR",
	"PI_BOOTSTRAP_STATE_DIR",
	"PI_FACTORY_STATE_DIR",
	"PI_FACTORY_COORDINATION_DIR",
	"PI_COMS_DIR",
	"FACTORY_STATE_PATH",
	"FACTORY_VIEWER_PORT",
	"FACTORY_VIEWER_HOST",
] as const;
const ALLOWED_VIEWER_ENV_SET = new Set<string>(ALLOWED_VIEWER_ENV_VARS);
const ALLOWED_VIEWER_ENV_PREFIXES = ["LC_"] as const;

export interface ViewerTarget {
	store_path: string;
	coordination_dir: string;
	sessions_dir: string;
}

export interface ViewerStartingRecord extends ViewerTarget {
	version: 1;
	state: "starting";
	pid: number;
	boot_id: string;
	start_time: string;
	started_at: string;
}

export interface ViewerRunningRecord extends ViewerTarget {
	version: 1;
	state: "running";
	pid: number;
	boot_id: string;
	start_time: string;
	port: number;
	url: string;
	started_at: string;
}

export type ViewerRuntimeRecord = ViewerStartingRecord | ViewerRunningRecord;

export interface ViewerCommandOptions {
	extensionDir: string;
	env: NodeJS.ProcessEnv;
	home: string;
	storePath?: string;
	startupTimeoutMs?: number;
	/** Runtime executable path override for testing non-node hosts (defaults to `process.execPath`). */
	execPath?: string;
}

export interface ViewerCommandDeps {
	killProcess?: (pid: number, signal: NodeJS.Signals | number) => boolean | void;
	currentUid?: () => number | undefined;
	readProcUid?: (pid: number) => { ruid: number; euid: number } | undefined;
}

export type ViewerStartResult =
	| { action: "started"; record: ViewerRunningRecord; staleReason?: string }
	| { action: "reused"; record: ViewerRunningRecord };

export type ViewerStopResult =
	| { stopped: true; pid: number; url?: string; killedWithSigkill: boolean }
	| { stopped: false; staleCleared?: boolean; reason: string };

export type ViewerStatusResult =
	| { running: true; state: "running"; healthy: boolean; record: ViewerRunningRecord; storeMatches: boolean; currentTarget: ViewerTarget; healthError?: string }
	| { running: true; state: "starting"; record: ViewerStartingRecord; storeMatches: boolean; currentTarget: ViewerTarget }
	| { running: false; staleReason?: string };

/** Resolve the per-user viewer runtime record path under the Pi agent state root (outside factory/Bootstrap stores). */
export function viewerRecordPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
	return join(piAgentDir(env, home), "factory-viewer.json");
}

function getCurrentUid(deps?: ViewerCommandDeps): number | undefined {
	if (deps?.currentUid) return deps.currentUid();
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function resolveCliPath(extensionDir?: string): string {
	return resolve(extensionDir ?? DEFAULT_EXTENSION_DIR, "factory", "viewer", "cli.ts");
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function resolveViewerTarget(options: Pick<ViewerCommandOptions, "env" | "home" | "storePath">): ViewerTarget {
	const effectiveHome = options.env.HOME ?? options.home;
	const store_path = resolve(
		options.storePath
		?? (options.env.FACTORY_STATE_PATH?.trim() ? options.env.FACTORY_STATE_PATH : defaultFactoryStorePath(options.env, effectiveHome)),
	);
	const coordination_dir = resolve(options.env.PI_FACTORY_COORDINATION_DIR ?? join(effectiveHome, ".pi", "agent"));
	const sessions_dir = resolve(options.env.PI_BOOTSTRAP_STATE_DIR ?? join(effectiveHome, ".pi", "agent", "bootstrap-sessions"));
	return { store_path, coordination_dir, sessions_dir };
}

function describeTargetDiff(recorded: ViewerTarget, current: ViewerTarget): string[] {
	const diffs: string[] = [];
	if (canonicalPath(recorded.store_path) !== canonicalPath(current.store_path)) {
		diffs.push(`store ${recorded.store_path} vs ${current.store_path}`);
	}
	if (canonicalPath(recorded.coordination_dir) !== canonicalPath(current.coordination_dir)) {
		diffs.push(`coordination dir ${recorded.coordination_dir} vs ${current.coordination_dir}`);
	}
	if (canonicalPath(recorded.sessions_dir) !== canonicalPath(current.sessions_dir)) {
		diffs.push(`sessions dir ${recorded.sessions_dir} vs ${current.sessions_dir}`);
	}
	return diffs;
}

function targetsMatch(recorded: ViewerTarget, current: ViewerTarget): boolean {
	return describeTargetDiff(recorded, current).length === 0;
}

function parseLoopbackUrl(raw: string): { url: string; port: number } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:") return undefined;
	if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") return undefined;
	if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return { url: parsed.origin, port };
}

function removeRecordFile(recordPath: string): void {
	try {
		const st = lstatSync(recordPath);
		if (st.isDirectory()) throw new Error(`Refusing to remove directory at ${recordPath}`);
		unlinkSync(recordPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

type ReadRecordResult =
	| { kind: "missing" }
	| { kind: "corrupt"; reason: string }
	| { kind: "ok"; record: ViewerRuntimeRecord };

function readViewerRecord(recordPath: string, deps?: ViewerCommandDeps): ReadRecordResult {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(recordPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "corrupt", reason: `unreadable viewer record (${errorMessage(error)})` };
	}
	if (st.isSymbolicLink() || !st.isFile()) {
		return { kind: "corrupt", reason: "viewer record is not a regular file" };
	}
	let rawText: string;
	try {
		const fd = openSync(recordPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile()) return { kind: "corrupt", reason: "viewer record is not a regular file" };
			const uid = getCurrentUid(deps);
			if (uid !== undefined && opened.uid !== uid) {
				return { kind: "corrupt", reason: "viewer record is not owned by the current user" };
			}
			if ((opened.mode & 0o022) !== 0) {
				return { kind: "corrupt", reason: "viewer record has unsafe group/world-writable permissions" };
			}
			if (opened.size > MAX_RECORD_BYTES) return { kind: "corrupt", reason: "viewer record exceeds maximum size" };
			rawText = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return { kind: "corrupt", reason: `unreadable viewer record (${errorMessage(error)})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return { kind: "corrupt", reason: "corrupt viewer record JSON" };
	}
	if (!isRecord(parsed) || parsed.version !== 1) {
		return { kind: "corrupt", reason: "invalid viewer record schema" };
	}
	if (parsed.state !== "starting" && parsed.state !== "running") {
		return { kind: "corrupt", reason: "invalid viewer record state" };
	}
	if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
		return { kind: "corrupt", reason: "invalid viewer record pid" };
	}
	if (typeof parsed.boot_id !== "string" || !UUID_PATTERN.test(parsed.boot_id)) {
		return { kind: "corrupt", reason: "invalid viewer record boot_id" };
	}
	if (typeof parsed.start_time !== "string" || !/^\d+$/.test(parsed.start_time)) {
		return { kind: "corrupt", reason: "invalid viewer record start_time" };
	}
	if (typeof parsed.store_path !== "string" || !parsed.store_path.trim()) {
		return { kind: "corrupt", reason: "invalid viewer record store_path" };
	}
	if (typeof parsed.coordination_dir !== "string" || !parsed.coordination_dir.trim()) {
		return { kind: "corrupt", reason: "invalid viewer record coordination_dir" };
	}
	if (typeof parsed.sessions_dir !== "string" || !parsed.sessions_dir.trim()) {
		return { kind: "corrupt", reason: "invalid viewer record sessions_dir" };
	}
	if (typeof parsed.started_at !== "string" || !Number.isFinite(Date.parse(parsed.started_at))) {
		return { kind: "corrupt", reason: "invalid viewer record started_at" };
	}
	const base = {
		version: 1 as const,
		pid: parsed.pid,
		boot_id: parsed.boot_id,
		start_time: parsed.start_time,
		store_path: parsed.store_path,
		coordination_dir: parsed.coordination_dir,
		sessions_dir: parsed.sessions_dir,
		started_at: parsed.started_at,
	};
	if (parsed.state === "starting") {
		return {
			kind: "ok",
			record: { ...base, state: "starting" },
		};
	}
	if (typeof parsed.url !== "string" || typeof parsed.port !== "number") {
		return { kind: "corrupt", reason: "invalid viewer record endpoint" };
	}
	const loopback = parseLoopbackUrl(parsed.url);
	if (!loopback || loopback.port !== parsed.port) {
		return { kind: "corrupt", reason: "invalid non-loopback or mismatched viewer record URL" };
	}
	return {
		kind: "ok",
		record: {
			...base,
			state: "running",
			port: parsed.port,
			url: loopback.url,
		},
	};
}

function isMatchingCliArg(arg: string, expectedCliPath: string, expectedCliRealpath: string): boolean {
	if (arg === expectedCliPath) return true;
	if (resolve(arg) === expectedCliPath) return true;
	try {
		return realpathSync(arg) === expectedCliRealpath;
	} catch {
		return false;
	}
}

/**
 * Verify that the recorded process is alive and matches our viewer identity.
 * On Linux, checks /proc/<pid>/stat (start_time + non-zombie), boot_id, /proc/<pid>/status Uid,
 * and /proc/<pid>/cmdline containing the resolved factory/viewer/cli.ts entry point.
 * On non-Linux platforms without /proc, falls back to PID/start_time/signal checks.
 */
function verifyRecordedProcessAlive(
	record: ViewerRuntimeRecord,
	expectedCliPath: string,
	deps?: ViewerCommandDeps,
): { alive: true } | { alive: false; reason: string } {
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return { alive: false, reason: `invalid PID ${String(record.pid)}` };
	}
	try {
		if (!processAlive({ pid: record.pid, start_time: record.start_time })) {
			return { alive: false, reason: `process ${record.pid} is not running or PID was reused` };
		}
	} catch (error) {
		return { alive: false, reason: `cannot verify process ${record.pid} (${errorMessage(error)})` };
	}
	if (process.platform !== "linux" || !existsSync("/proc")) {
		return { alive: true };
	}
	try {
		const proc = directionProcess(record.pid);
		if (proc.state === "Z" || proc.state === "X") {
			return { alive: false, reason: `process ${record.pid} has exited` };
		}
		if (proc.boot !== record.boot_id) {
			return { alive: false, reason: `process ${record.pid} boot_id mismatch` };
		}
		if (proc.start !== record.start_time) {
			return { alive: false, reason: `process ${record.pid} identity mismatch (PID reused)` };
		}
		const uid = getCurrentUid(deps);
		if (uid !== undefined) {
			const procUid = deps?.readProcUid
				? deps.readProcUid(record.pid)
				: (() => {
					const statusText = readFileSync(`/proc/${record.pid}/status`, "utf8");
					const uidMatch = /^Uid:\s+(\d+)\s+(\d+)/m.exec(statusText);
					return uidMatch ? { ruid: Number(uidMatch[1]), euid: Number(uidMatch[2]) } : undefined;
				})();
			if (!procUid || procUid.ruid !== uid || procUid.euid !== uid) {
				return { alive: false, reason: `process ${record.pid} uid mismatch` };
			}
		}
		const rawCmdline = readFileSync(`/proc/${record.pid}/cmdline`, "utf8");
		const args = rawCmdline.split("\0").filter(Boolean);
		const expectedCliRealpath = canonicalPath(expectedCliPath);
		if (
			args.length < 2
			|| args.includes("-e")
			|| args.includes("--eval")
			|| !args.slice(1).some(arg => isMatchingCliArg(arg, expectedCliPath, expectedCliRealpath))
		) {
			return { alive: false, reason: `process ${record.pid} cmdline is not the Factory Viewer` };
		}
		return { alive: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") {
			return { alive: false, reason: `process ${record.pid} is no longer running` };
		}
		return { alive: false, reason: `cannot verify process ${record.pid} identity (${errorMessage(error)})` };
	}
}

type InspectedViewer =
	| { status: "none" }
	| { status: "stale"; reason: string; corrupt?: boolean; record?: ViewerRuntimeRecord }
	| { status: "alive"; record: ViewerRuntimeRecord };

function inspectRecordedViewer(recordPath: string, expectedCliPath: string, deps?: ViewerCommandDeps): InspectedViewer {
	const read = readViewerRecord(recordPath, deps);
	if (read.kind === "missing") return { status: "none" };
	if (read.kind === "corrupt") return { status: "stale", reason: read.reason, corrupt: true };
	const check = verifyRecordedProcessAlive(read.record, expectedCliPath, deps);
	if (!check.alive) return { status: "stale", reason: check.reason, record: read.record };
	return { status: "alive", record: read.record };
}

async function probeViewerHealth(url: string): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
	const loopback = parseLoopbackUrl(url);
	if (!loopback) return { ok: false, error: "non-loopback URL" };
	try {
		const res = await fetch(`${loopback.url}/api/factories`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		if (res.status === 200 || res.status === 503) {
			return { ok: true, status: res.status };
		}
		return { ok: false, error: `HTTP ${res.status}` };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function appendTail(current: string, chunk: string): string {
	const combined = current + chunk;
	return combined.length > MAX_STDERR_BYTES ? combined.slice(-MAX_STDERR_BYTES) : combined;
}

function formatStartupError(prefix: string, stderrTail: string): Error {
	const tail = stderrTail.trim();
	if (!tail) return new Error(prefix);
	const maxTail = Math.max(256, MAX_STDERR_BYTES + 200 - prefix.length - 2);
	const boundedTail = tail.length > maxTail ? tail.slice(-maxTail) : tail;
	return new Error(`${prefix}: ${boundedTail}`);
}

function buildViewerChildEnv(env: NodeJS.ProcessEnv, home: string, storePath: string): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (ALLOWED_VIEWER_ENV_SET.has(key) || ALLOWED_VIEWER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
			childEnv[key] = value;
		}
	}
	childEnv.HOME = env.HOME ?? home;
	// Preserve an explicitly empty FACTORY_STATE_PATH so cli.ts rejects invalid store config; otherwise pin to /factory list's store.
	childEnv.FACTORY_STATE_PATH = env.FACTORY_STATE_PATH !== undefined && !env.FACTORY_STATE_PATH.trim()
		? env.FACTORY_STATE_PATH
		: storePath;
	return childEnv;
}

function readProcessIdentityForSpawn(pid: number): { boot: string; start: string; state: string } {
	if (process.platform === "linux" && existsSync("/proc")) {
		return directionProcess(pid);
	}
	return { boot: "00000000-0000-4000-8000-000000000000", start: "0", state: "S" };
}

async function terminateVerifiedRecordedProcess(
	record: ViewerRuntimeRecord,
	expectedCliPath: string,
	deps?: ViewerCommandDeps,
): Promise<{ stopped: true; killedWithSigkill: boolean } | { stopped: false; staleReason: string }> {
	const sendSignal = deps?.killProcess ?? ((pid: number, sig: NodeJS.Signals | number) => process.kill(pid, sig));
	const verified = verifyRecordedProcessAlive(record, expectedCliPath, deps);
	if (!verified.alive) {
		return { stopped: false, staleReason: verified.reason };
	}
	try {
		sendSignal(record.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}

	const termDeadline = Date.now() + STOP_SIGTERM_WAIT_MS;
	while (Date.now() < termDeadline && verifyRecordedProcessAlive(record, expectedCliPath, deps).alive) {
		await delay(25);
	}

	let killedWithSigkill = false;
	if (verifyRecordedProcessAlive(record, expectedCliPath, deps).alive) {
		killedWithSigkill = true;
		try {
			sendSignal(record.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		const killDeadline = Date.now() + STOP_SIGKILL_WAIT_MS;
		while (Date.now() < killDeadline && verifyRecordedProcessAlive(record, expectedCliPath, deps).alive) {
			await delay(25);
		}
		if (verifyRecordedProcessAlive(record, expectedCliPath, deps).alive) {
			throw new Error(`Factory Viewer process ${record.pid} did not exit after SIGTERM and SIGKILL`);
		}
	}
	return { stopped: true, killedWithSigkill };
}

async function terminateAndReapChild(child: ChildProcess, closedPromise: Promise<unknown>): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		try { child.kill("SIGTERM"); } catch { /* exited */ }
		const termWinner = await Promise.race([
			closedPromise.then(() => "exited" as const),
			delay(1_000).then(() => "timeout" as const),
		]);
		if (termWinner === "timeout" && child.exitCode === null && child.signalCode === null) {
			try { child.kill("SIGKILL"); } catch { /* exited */ }
			await Promise.race([closedPromise, delay(2_000)]);
		}
	} else {
		await Promise.race([closedPromise, delay(500)]);
	}
	child.stdout?.removeAllListeners();
	child.stderr?.removeAllListeners();
	child.stdout?.destroy();
	child.stderr?.destroy();
}

async function spawnDetachedViewer(
	nodeBinary: string,
	cliPath: string,
	childEnv: NodeJS.ProcessEnv,
	startupTimeoutMs: number,
	onStarting: (identity: { pid: number; boot_id: string; start_time: string }) => void,
): Promise<{ pid: number; boot_id: string; start_time: string; port: number; url: string }> {
	const child = spawn(nodeBinary, ["--experimental-strip-types", cliPath], {
		env: childEnv,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderrTail = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", chunk => { stderrTail = appendTail(stderrTail, String(chunk)); });

	const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolveClosed => {
		let done = false;
		const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
			if (done) return;
			done = true;
			resolveClosed(result);
		};
		child.once("error", error => finish({ code: null, signal: null, error }));
		child.once("close", (code, signal) => finish({ code, signal }));
	});

	if (child.pid) {
		try {
			const spawnIdentity = readProcessIdentityForSpawn(child.pid);
			if (spawnIdentity.state !== "Z" && spawnIdentity.state !== "X") {
				onStarting({ pid: child.pid, boot_id: spawnIdentity.boot, start_time: spawnIdentity.start });
			}
		} catch {
			// If the child exited before /proc was read, closedPromise below handles reaping and error reporting.
		}
	}

	let startupError: Error | undefined;
	let url: string | undefined;

	await new Promise<void>(resolveWait => {
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveWait();
		};
		const timer = setTimeout(() => {
			startupError = formatStartupError(
				`Factory Viewer timed out after ${startupTimeoutMs}ms waiting for startup URL (interpreter ${nodeBinary}, entry ${cliPath})`,
				stderrTail,
			);
			settle();
		}, startupTimeoutMs);

		child.stdout?.on("data", chunk => {
			if (settled) return;
			stdout += String(chunk);
			const match = /^Factory Viewer:\s+(http:\/\/\S+)\r?$/m.exec(stdout);
			if (match) {
				url = match[1];
				settle();
			}
		});

		void closedPromise.then(({ code, signal, error }) => {
			if (settled) return;
			if (error) {
				startupError = formatStartupError(
					`Failed to spawn Factory Viewer (interpreter ${nodeBinary}, entry ${cliPath}): ${error.message}`,
					stderrTail,
				);
			} else {
				startupError = formatStartupError(
					`Factory Viewer exited before printing URL (${code !== null ? `code ${code}` : `signal ${signal}`}; interpreter ${nodeBinary}, entry ${cliPath})`,
					stderrTail,
				);
			}
			settle();
		});
	});

	if (startupError || !url || !child.pid) {
		await terminateAndReapChild(child, closedPromise);
		throw startupError ?? new Error("Factory Viewer failed to report a startup URL");
	}

	const loopback = parseLoopbackUrl(url);
	if (!loopback) {
		await terminateAndReapChild(child, closedPromise);
		throw new Error(`Refusing non-loopback Factory Viewer URL: ${url}`);
	}

	let identity: { boot: string; start: string; state: string };
	try {
		identity = readProcessIdentityForSpawn(child.pid);
	} catch (error) {
		await terminateAndReapChild(child, closedPromise);
		throw new Error(`Factory Viewer started (pid ${child.pid}) but its process identity could not be verified: ${errorMessage(error)}`);
	}
	if (identity.state === "Z" || identity.state === "X") {
		await terminateAndReapChild(child, closedPromise);
		throw new Error(`Factory Viewer exited immediately after printing URL (${loopback.url})`);
	}

	// cli.ts writes nothing to stdout/stderr after printing the startup URL line, so closing the parent pipes is safe.
	child.stdout?.removeAllListeners();
	child.stderr?.removeAllListeners();
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.unref();

	return {
		pid: child.pid,
		boot_id: identity.boot,
		start_time: identity.start,
		port: loopback.port,
		url: loopback.url,
	};
}

/** Start the standalone Factory Viewer detached, or report the existing verified instance. */
export async function startFactoryViewer(options: ViewerCommandOptions, deps?: ViewerCommandDeps): Promise<ViewerStartResult> {
	// Resolve Node before acquiring locks or creating directories/records so non-Node hosts fail closed cleanly.
	const nodeBinary = resolveNodeBinary(options.env, options.execPath ?? process.execPath);
	const recordPath = viewerRecordPath(options.env, options.home);
	const target = resolveViewerTarget(options);
	const cliPath = resolveCliPath(options.extensionDir);
	const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

	return withRunLock(recordPath, async () => {
		let inspected = inspectRecordedViewer(recordPath, cliPath, deps);
		let staleReason: string | undefined;

		if (inspected.status === "alive" && inspected.record.state === "starting") {
			// Holding the run lock proves no starter is still waiting; stop the verified mid-start orphan and replace it.
			await terminateVerifiedRecordedProcess(inspected.record, cliPath, deps);
			removeRecordFile(recordPath);
			staleReason = `cleared orphaned starting viewer (pid ${inspected.record.pid})`;
			inspected = { status: "none" };
		} else if (inspected.status === "alive" && inspected.record.state === "running") {
			const diffs = describeTargetDiff(inspected.record, target);
			if (diffs.length > 0) {
				throw new Error(
					`A Factory Viewer is already running for store ${inspected.record.store_path} (${inspected.record.url}; differs on ${diffs.join(", ")}); run /factory viewer stop first`,
				);
			}
			const health = await probeViewerHealth(inspected.record.url);
			if (health.ok) {
				return { action: "reused", record: inspected.record };
			}
			const recheck = inspectRecordedViewer(recordPath, cliPath, deps);
			if (recheck.status === "alive") {
				throw new Error(`Recorded Factory Viewer (pid ${inspected.record.pid}) at ${inspected.record.url} is unresponsive (${health.error}); run /factory viewer stop first`);
			}
			inspected = recheck;
		}

		if (inspected.status === "stale") {
			staleReason = inspected.reason;
			removeRecordFile(recordPath);
		}

		mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
		const childEnv = buildViewerChildEnv(options.env, options.home, target.store_path);
		const startedAt = new Date().toISOString();
		try {
			const spawned = await spawnDetachedViewer(nodeBinary, cliPath, childEnv, startupTimeoutMs, identity => {
				const startingRecord: ViewerStartingRecord = {
					version: 1,
					state: "starting",
					pid: identity.pid,
					boot_id: identity.boot_id,
					start_time: identity.start_time,
					...target,
					started_at: startedAt,
				};
				atomicJson(recordPath, startingRecord);
			});
			const runningRecord: ViewerRunningRecord = {
				version: 1,
				state: "running",
				pid: spawned.pid,
				boot_id: spawned.boot_id,
				start_time: spawned.start_time,
				port: spawned.port,
				url: spawned.url,
				...target,
				started_at: startedAt,
			};
			atomicJson(recordPath, runningRecord);
			return { action: "started", record: runningRecord, ...(staleReason ? { staleReason } : {}) };
		} catch (error) {
			removeRecordFile(recordPath);
			throw error;
		}
	}, Math.max(15_000, startupTimeoutMs + 5_000));
}

/** Stop only the Factory Viewer recorded in the runtime record after verifying its process identity. */
export async function stopFactoryViewer(
	options: Pick<ViewerCommandOptions, "env" | "home"> & { extensionDir?: string },
	deps?: ViewerCommandDeps,
): Promise<ViewerStopResult> {
	const recordPath = viewerRecordPath(options.env, options.home);
	const cliPath = resolveCliPath(options.extensionDir);
	if (!existsSync(dirname(recordPath)) && !existsSync(recordPath)) {
		return { stopped: false, reason: "No Factory Viewer is running." };
	}

	return withRunLock(recordPath, async () => {
		const inspected = inspectRecordedViewer(recordPath, cliPath, deps);
		if (inspected.status === "none") {
			return { stopped: false, reason: "No Factory Viewer is running." };
		}
		if (inspected.status === "stale") {
			removeRecordFile(recordPath);
			return {
				stopped: false,
				staleCleared: true,
				reason: `No Factory Viewer is running (cleared stale record: ${inspected.reason}).`,
			};
		}

		const record = inspected.record;
		const terminated = await terminateVerifiedRecordedProcess(record, cliPath, deps);
		removeRecordFile(recordPath);
		if (!terminated.stopped) {
			return {
				stopped: false,
				staleCleared: true,
				reason: `No Factory Viewer is running (cleared stale record: ${terminated.staleReason}).`,
			};
		}
		return {
			stopped: true,
			pid: record.pid,
			...(record.state === "running" ? { url: record.url } : {}),
			killedWithSigkill: terminated.killedWithSigkill,
		};
	}, 15_000);
}

/** Read-only check of the recorded Factory Viewer state. */
export async function getFactoryViewerStatus(
	options: Pick<ViewerCommandOptions, "env" | "home" | "storePath"> & { extensionDir?: string },
	deps?: ViewerCommandDeps,
): Promise<ViewerStatusResult> {
	const recordPath = viewerRecordPath(options.env, options.home);
	const cliPath = resolveCliPath(options.extensionDir);
	const currentTarget = resolveViewerTarget(options);
	const inspected = inspectRecordedViewer(recordPath, cliPath, deps);
	if (inspected.status === "none") return { running: false };
	if (inspected.status === "stale") return { running: false, staleReason: inspected.reason };
	const storeMatches = targetsMatch(inspected.record, currentTarget);
	if (inspected.record.state === "starting") {
		return {
			running: true,
			state: "starting",
			record: inspected.record,
			storeMatches,
			currentTarget,
		};
	}
	const health = await probeViewerHealth(inspected.record.url);
	return {
		running: true,
		state: "running",
		healthy: health.ok,
		record: inspected.record,
		storeMatches,
		currentTarget,
		...(!health.ok ? { healthError: health.error } : {}),
	};
}
