import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "../bootstrap/bootstrap-utils.ts";
import { directionProcess } from "../bootstrap/factory-requests.ts";
import { atomicJson, delay, errorMessage, isRecord, processAlive, withRunLock } from "../bootstrap/session-store.ts";
import { defaultFactoryStorePath } from "./operations.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STOP_SIGTERM_WAIT_MS = 5_000;
const STOP_SIGKILL_WAIT_MS = 2_000;
const HEALTH_TIMEOUT_MS = 1_500;
const MAX_RECORD_BYTES = 65_536;
const MAX_STDERR_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

export interface ViewerRuntimeRecord {
	version: 1;
	pid: number;
	boot_id: string;
	start_time: string;
	port: number;
	url: string;
	store_path: string;
	started_at: string;
}

export interface ViewerCommandOptions {
	extensionDir: string;
	env: NodeJS.ProcessEnv;
	home: string;
	storePath?: string;
	startupTimeoutMs?: number;
}

export type ViewerStartResult =
	| { action: "started"; record: ViewerRuntimeRecord; staleReason?: string }
	| { action: "reused"; record: ViewerRuntimeRecord };

export type ViewerStopResult =
	| { stopped: true; pid: number; url: string; killedWithSigkill: boolean }
	| { stopped: false; staleCleared?: boolean; reason: string };

export type ViewerStatusResult =
	| { running: true; healthy: boolean; record: ViewerRuntimeRecord; healthError?: string }
	| { running: false; staleReason?: string };

/** Resolve the per-user viewer runtime record path under the Pi agent state root (outside factory/Bootstrap stores). */
export function viewerRecordPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
	return join(piAgentDir(env, home), "factory-viewer.json");
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

function readViewerRecord(recordPath: string): ReadRecordResult {
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
	if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
		return { kind: "corrupt", reason: "invalid viewer record pid" };
	}
	if (typeof parsed.boot_id !== "string" || !UUID_PATTERN.test(parsed.boot_id)) {
		return { kind: "corrupt", reason: "invalid viewer record boot_id" };
	}
	if (typeof parsed.start_time !== "string" || !/^\d+$/.test(parsed.start_time)) {
		return { kind: "corrupt", reason: "invalid viewer record start_time" };
	}
	if (typeof parsed.url !== "string" || typeof parsed.port !== "number") {
		return { kind: "corrupt", reason: "invalid viewer record endpoint" };
	}
	const loopback = parseLoopbackUrl(parsed.url);
	if (!loopback || loopback.port !== parsed.port) {
		return { kind: "corrupt", reason: "invalid non-loopback or mismatched viewer record URL" };
	}
	if (typeof parsed.store_path !== "string" || !parsed.store_path.trim()) {
		return { kind: "corrupt", reason: "invalid viewer record store_path" };
	}
	if (typeof parsed.started_at !== "string" || !Number.isFinite(Date.parse(parsed.started_at))) {
		return { kind: "corrupt", reason: "invalid viewer record started_at" };
	}
	return {
		kind: "ok",
		record: {
			version: 1,
			pid: parsed.pid,
			boot_id: parsed.boot_id,
			start_time: parsed.start_time,
			port: parsed.port,
			url: loopback.url,
			store_path: parsed.store_path,
			started_at: parsed.started_at,
		},
	};
}

function verifyRecordedProcessAlive(record: ViewerRuntimeRecord): { alive: true } | { alive: false; reason: string } {
	try {
		if (!processAlive({ pid: record.pid, start_time: record.start_time })) {
			return { alive: false, reason: `process ${record.pid} is not running or PID was reused` };
		}
	} catch (error) {
		return { alive: false, reason: `cannot verify process ${record.pid} (${errorMessage(error)})` };
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

function inspectRecordedViewer(recordPath: string): InspectedViewer {
	const read = readViewerRecord(recordPath);
	if (read.kind === "missing") return { status: "none" };
	if (read.kind === "corrupt") return { status: "stale", reason: read.reason, corrupt: true };
	const check = verifyRecordedProcessAlive(read.record);
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

function buildViewerChildEnv(env: NodeJS.ProcessEnv, home: string, storePath: string): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...env };
	childEnv.HOME = env.HOME ?? home;
	// Preserve an explicitly empty FACTORY_STATE_PATH so cli.ts rejects invalid store config; otherwise pin to /factory list's store.
	childEnv.FACTORY_STATE_PATH = env.FACTORY_STATE_PATH !== undefined && !env.FACTORY_STATE_PATH.trim()
		? env.FACTORY_STATE_PATH
		: storePath;
	return childEnv;
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
	cliPath: string,
	childEnv: NodeJS.ProcessEnv,
	startupTimeoutMs: number,
): Promise<{ pid: number; boot_id: string; start_time: string; port: number; url: string }> {
	const child = spawn(process.execPath, [cliPath], {
		env: childEnv,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderrTail = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", chunk => { stderrTail = appendTail(stderrTail, String(chunk)); });

	const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
		let done = false;
		const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
			if (done) return;
			done = true;
			resolve(result);
		};
		child.once("error", error => finish({ code: null, signal: null, error }));
		child.once("close", (code, signal) => finish({ code, signal }));
	});

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
			const tail = stderrTail.trim();
			startupError = new Error(`Factory Viewer timed out after ${startupTimeoutMs}ms waiting for startup URL${tail ? `: ${tail}` : ""}`);
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
			const tail = stderrTail.trim();
			if (error) {
				startupError = new Error(`Failed to spawn Factory Viewer: ${error.message}${tail ? `: ${tail}` : ""}`);
			} else {
				startupError = new Error(`Factory Viewer exited before printing URL (${code !== null ? `code ${code}` : `signal ${signal}`})${tail ? `: ${tail}` : ""}`);
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
		identity = directionProcess(child.pid);
	} catch (error) {
		await terminateAndReapChild(child, closedPromise);
		throw new Error(`Factory Viewer started (pid ${child.pid}) but its process identity could not be verified: ${errorMessage(error)}`);
	}
	if (identity.state === "Z" || identity.state === "X") {
		await terminateAndReapChild(child, closedPromise);
		throw new Error(`Factory Viewer exited immediately after printing URL (${loopback.url})`);
	}

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
export async function startFactoryViewer(options: ViewerCommandOptions): Promise<ViewerStartResult> {
	const recordPath = viewerRecordPath(options.env, options.home);
	const storePath = options.storePath ?? defaultFactoryStorePath(options.env, options.home);
	const cliPath = join(options.extensionDir, "factory", "viewer", "cli.ts");
	const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

	return withRunLock(recordPath, async () => {
		let inspected = inspectRecordedViewer(recordPath);
		if (inspected.status === "alive") {
			const health = await probeViewerHealth(inspected.record.url);
			if (health.ok) {
				return { action: "reused", record: inspected.record };
			}
			const recheck = inspectRecordedViewer(recordPath);
			if (recheck.status === "alive") {
				throw new Error(`Recorded Factory Viewer (pid ${inspected.record.pid}) at ${inspected.record.url} is unresponsive (${health.error}); run /factory viewer stop first`);
			}
			inspected = recheck;
		}

		let staleReason: string | undefined;
		if (inspected.status === "stale") {
			staleReason = inspected.reason;
			removeRecordFile(recordPath);
		}

		mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
		const childEnv = buildViewerChildEnv(options.env, options.home, storePath);
		const spawned = await spawnDetachedViewer(cliPath, childEnv, startupTimeoutMs);
		const record: ViewerRuntimeRecord = {
			version: 1,
			pid: spawned.pid,
			boot_id: spawned.boot_id,
			start_time: spawned.start_time,
			port: spawned.port,
			url: spawned.url,
			store_path: storePath,
			started_at: new Date().toISOString(),
		};
		atomicJson(recordPath, record);
		return { action: "started", record, ...(staleReason ? { staleReason } : {}) };
	}, Math.max(15_000, startupTimeoutMs + 5_000));
}

/** Stop only the Factory Viewer recorded in the runtime record after verifying its process identity. */
export async function stopFactoryViewer(options: Pick<ViewerCommandOptions, "env" | "home">): Promise<ViewerStopResult> {
	const recordPath = viewerRecordPath(options.env, options.home);
	if (!existsSync(dirname(recordPath)) && !existsSync(recordPath)) {
		return { stopped: false, reason: "No Factory Viewer is running." };
	}

	return withRunLock(recordPath, async () => {
		const inspected = inspectRecordedViewer(recordPath);
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
		const verified = verifyRecordedProcessAlive(record);
		if (!verified.alive) {
			removeRecordFile(recordPath);
			return {
				stopped: false,
				staleCleared: true,
				reason: `No Factory Viewer is running (cleared stale record: ${verified.reason}).`,
			};
		}

		try {
			process.kill(record.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}

		const termDeadline = Date.now() + STOP_SIGTERM_WAIT_MS;
		while (Date.now() < termDeadline && verifyRecordedProcessAlive(record).alive) {
			await delay(25);
		}

		let killedWithSigkill = false;
		if (verifyRecordedProcessAlive(record).alive) {
			killedWithSigkill = true;
			try {
				process.kill(record.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			const killDeadline = Date.now() + STOP_SIGKILL_WAIT_MS;
			while (Date.now() < killDeadline && verifyRecordedProcessAlive(record).alive) {
				await delay(25);
			}
			if (verifyRecordedProcessAlive(record).alive) {
				throw new Error(`Factory Viewer process ${record.pid} did not exit after SIGTERM and SIGKILL`);
			}
		}

		removeRecordFile(recordPath);
		return { stopped: true, pid: record.pid, url: record.url, killedWithSigkill };
	}, 15_000);
}

/** Read-only check of the recorded Factory Viewer state. */
export async function getFactoryViewerStatus(options: Pick<ViewerCommandOptions, "env" | "home">): Promise<ViewerStatusResult> {
	const recordPath = viewerRecordPath(options.env, options.home);
	const inspected = inspectRecordedViewer(recordPath);
	if (inspected.status === "none") return { running: false };
	if (inspected.status === "stale") return { running: false, staleReason: inspected.reason };
	const health = await probeViewerHealth(inspected.record.url);
	return {
		running: true,
		healthy: health.ok,
		record: inspected.record,
		...(!health.ok ? { healthError: health.error } : {}),
	};
}
