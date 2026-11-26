import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertHcEnvironment } from "./hc-live-env.ts";

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface CoreIdentity {
	id: string;
	pid: number;
	socket: string;
	device: number;
	inode: number;
}

export async function command(root: string, env: NodeJS.ProcessEnv, binary: string, args: string[], timeout = 8_000): Promise<CommandResult> {
	assertHcEnvironment(root, env);
	// Kill only the CLI on timeout. A successful server start leaves a daemon for
	// the verified server-stop path to reap.
	return await new Promise((resolve, reject) => {
		const child = execFile(binary, args, { cwd: root, env, timeout, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
			if (typeof error?.code === "string") return reject(error);
			resolve({ code: error ? error.code ?? null : 0, stdout, stderr, timedOut: error?.killed === true });
		});
		child.stdin?.end();
	});
}

export function successful(result: CommandResult, operation: string): void {
	assert.ok(!result.timedOut && result.code === 0, `${operation} failed: ${JSON.stringify(result)}`);
}

export function json(text: string) {
	try { return JSON.parse(text); } catch { return undefined; }
}

export function payload(result: CommandResult) {
	const parsed = json(result.stdout);
	return parsed?.result ?? parsed;
}

export function localAddress(value: unknown): string {
	assert.ok(typeof value === "string" && /^t[0-9a-z]+$/.test(value), `expected a local hc address, got ${JSON.stringify(value)}`);
	return value;
}

export function assertPrivatePath(root: string, path: string): void {
	assert.ok(isAbsolute(path), `hc isolation requires an absolute path: ${path}`);
	const inside = relative(root, realpathSync(path));
	assert.ok(inside && inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside),
		`hc isolation rejected a path outside the scratch root: ${path}`);
}

export function privateSocket(root: string, env: NodeJS.ProcessEnv) {
	assertHcEnvironment(root, env);
	const socket = env.HC_SOCKET!;
	const stat = lstatSync(socket);
	assert.ok(stat.isSocket() && stat.uid === process.getuid?.(), "hc isolation requires a private Unix socket");
	assertPrivatePath(root, socket);
	return { socket, device: stat.dev, inode: stat.ino };
}

function verifyReportedPaths(root: string, node: unknown): void {
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node)) {
		if (typeof value === "string" && /^(?:core_?)?(?:socket|sock|ipc)(?:_?path)?$/i.test(key)) {
			assertPrivatePath(root, value);
		} else {
			verifyReportedPaths(root, value);
		}
	}
}

function cgroupPaths(raw: string): string[] {
	return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
		const idx = line.indexOf("::");
		if (idx >= 0) return line.slice(idx + 2);
		const parts = line.split(":");
		return parts.length >= 3 ? parts.slice(2).join(":") : line;
	});
}

export function assertSafeCoreCgroup(coreCgroup: string, callerCgroup: string): void {
	const coreTrimmed = coreCgroup.trim();
	const callerTrimmed = callerCgroup.trim();
	const corePaths = cgroupPaths(coreTrimmed);
	const callerPaths = cgroupPaths(callerTrimmed);
	assert.ok(coreTrimmed.length > 0 && corePaths.length > 0, "hc isolation requires readable core /proc/<pid>/cgroup");
	assert.ok(callerTrimmed.length > 0 && callerPaths.length > 0, "hc isolation requires readable caller /proc/self/cgroup");
	const pathsMatch = corePaths.length === callerPaths.length && corePaths.every((path, i) => path === callerPaths[i]);
	const isHcUnit = /(?:^|\/)(?:herdr-core|hc[-_])[^/\n]*\.(?:service|scope)\b/i;
	if (isHcUnit.test(coreTrimmed) || isHcUnit.test(callerTrimmed)) {
		if (!pathsMatch) {
			assert.fail(`hc isolation rejected core cgroup: the isolated core is in cgroup ${coreTrimmed}, different from the test process's ${callerTrimmed}; if you are running from a terminal hosted by hc, run from a terminal that is not`);
		}
		assert.fail(`hc isolation rejected hc-hosted caller cgroup: both the core and test process are in ${coreTrimmed}; if you are running from a terminal hosted by hc, run from a terminal that is not`);
	}
	if (!pathsMatch) {
		assert.fail(`hc isolation rejected core cgroup: the isolated core is in cgroup ${coreTrimmed}, different from the test process's ${callerTrimmed}`);
	}
}

function defaultReadCgroup(pid: number | "self"): string {
	return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
}

export function createSignalForwarder(
	onSignal: (signal: NodeJS.Signals) => void,
	target: {
		pid: number;
		off: (signal: NodeJS.Signals, listener: () => void) => unknown;
		kill: (pid: number, signal: NodeJS.Signals) => unknown;
	} = {
		pid: process.pid,
		off: (signal, listener) => process.off(signal, listener),
		kill: (pid, signal) => process.kill(pid, signal),
	},
) {
	const handlers = new Map<NodeJS.Signals, () => void>();
	return (signal: NodeJS.Signals) => {
		let handler = handlers.get(signal);
		if (!handler) {
			handler = () => {
				try {
					onSignal(signal);
				} finally {
					target.off(signal, handler!);
					target.kill(target.pid, signal);
				}
			};
			handlers.set(signal, handler);
		}
		return handler;
	};
}

export function formatOrphanWarning(options: {
	root: string;
	stopCommand: string;
	socketExists: boolean;
	survivingPids: number[];
}): string {
	const lines = [`Isolated hc core may still be running (scratch root retained at ${options.root}).`];
	if (options.socketExists || options.survivingPids.length === 0) {
		lines.push(`Stop it with:\n  ${options.stopCommand}`);
	}
	if (options.survivingPids.length > 0) {
		lines.push(`Surviving core/holder PIDs outlived server stop (the stop command cannot help once the socket is gone); terminate them with:\n  kill ${options.survivingPids.join(" ")}`);
	}
	return lines.join("\n") + "\n";
}

function parseEnviron(raw: string): Record<string, string> {
	return Object.fromEntries(raw.split("\0").filter(entry => entry.includes("="))
		.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}

function defaultReadProcEnviron(pid: number): string {
	return readFileSync(`/proc/${pid}/environ`, "utf8");
}

function readSafeProcEnviron(pid: number, readProcEnviron: (pid: number) => string): Record<string, string> | undefined {
	try {
		return parseEnviron(readProcEnviron(pid));
	} catch {
		return undefined;
	}
}

function hasVerifiedHcSession(
	procEnv: Record<string, string> | undefined,
	expectedSession: string | undefined,
): expectedSession is string {
	return procEnv !== undefined
		&& typeof expectedSession === "string"
		&& expectedSession !== ""
		&& procEnv.HC_SESSION === expectedSession;
}

export const MAX_KILLABLE_PID = 0x7fffffff;

export function isKillablePid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid <= MAX_KILLABLE_PID;
}

export function processAlive(
	pid: number,
	killFn: (pid: number, signal: number) => unknown = (p, s) => process.kill(p, s),
): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_KILLABLE_PID) return false;
	try {
		killFn(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

export function extractHolderPids(status: any): number[] {
	const pids = new Set<number>();
	if (isKillablePid(status?.holder?.pid)) pids.add(status.holder.pid);
	if (Array.isArray(status?.holders)) {
		for (const holder of status.holders) {
			if (isKillablePid(holder?.pid)) pids.add(holder.pid);
		}
	}
	return [...pids].sort((a, b) => a - b);
}

async function pollUntil(check: () => boolean, ms = 5_000): Promise<boolean> {
	const end = Date.now() + ms;
	do {
		if (check()) return true;
		await delay(40);
	} while (Date.now() < end);
	return check();
}

export interface CoreStopResult {
	mode: "verified" | "fallback";
	stop: CommandResult;
	corePid: number | null;
	holderPids: number[];
	remainingCoreAlive: boolean;
	remainingHolderPids: number[];
	socketRemaining: boolean;
	stopped: boolean;
	verifyError?: string;
	stopError?: string;
	fallbackKill?: { pid: number; signal: "SIGTERM" | "SIGKILL"; verifiedHcSession: string };
	fallbackKillSkipped?: { pid: number | null; reason: string };
}

export interface StopCoreOptions {
	identity?: CoreIdentity;
	startPid?: number;
	holderPids?: number[];
	readProcEnviron?: (pid: number) => string;
	isProcessAlive?: (pid: number) => boolean;
	signalProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	stopWaitMs?: number;
	termWaitMs?: number;
	killWaitMs?: number;
}

export async function stopCoreWithFallback(
	root: string,
	env: NodeJS.ProcessEnv,
	options: StopCoreOptions = {},
): Promise<CoreStopResult> {
	assertHcEnvironment(root, env);
	const socket = env.HC_SOCKET!;
	const readProcEnviron = options.readProcEnviron ?? defaultReadProcEnviron;
	const isProcessAlive = options.isProcessAlive ?? processAlive;
	const signalProcess = options.signalProcess ?? ((pid: number, signal: "SIGTERM" | "SIGKILL") => {
		process.kill(pid, signal);
	});
	const stopWaitMs = options.stopWaitMs ?? 5_000;
	const termWaitMs = options.termWaitMs ?? 2_000;
	const killWaitMs = options.killWaitMs ?? 1_000;
	const holderSet = new Set<number>((options.holderPids ?? []).filter(pid => isKillablePid(pid)));
	let verified: Awaited<ReturnType<typeof readCoreStatus>> | undefined;
	let verifyError: unknown;
	try {
		verified = await readCoreStatus(root, env, options.identity);
	} catch (error) {
		verifyError = error;
	}
	if (verified) {
		const corePid = verified.identity.pid;
		for (const pid of extractHolderPids(payload(verified.result))) holderSet.add(pid);
		const holderPids = [...holderSet].sort((a, b) => a - b);
		let stop: CommandResult = { code: null, stdout: "", stderr: "", timedOut: false };
		let stopError: string | undefined;
		try {
			stop = await command(root, env, "hc", ["server", "stop", "--json"]);
			successful(stop, "hc server stop");
		} catch (error) {
			stopError = String(error);
			if (stop.code === null && !stop.stdout && !stop.stderr) {
				stop = { code: null, stdout: "", stderr: stopError, timedOut: false };
			}
		}
		if (!stopError) {
			await pollUntil(() => !existsSync(socket), 5_000);
			const pidsToCheck = [corePid, ...holderPids];
			await pollUntil(() => pidsToCheck.every(pid => !isProcessAlive(pid)), 5_000);
		}
		const socketRemaining = existsSync(socket);
		const remainingCoreAlive = isProcessAlive(corePid);
		const remainingHolderPids = holderPids.filter(pid => isProcessAlive(pid));
		return {
			mode: "verified",
			stop,
			...(stopError ? { stopError } : {}),
			corePid,
			holderPids,
			remainingCoreAlive,
			remainingHolderPids,
			socketRemaining,
			stopped: !stopError && !socketRemaining && !remainingCoreAlive && remainingHolderPids.length === 0,
		};
	}

	let socketEntryExists = existsSync(socket);
	if (!socketEntryExists) {
		try { lstatSync(socket); socketEntryExists = true; } catch {}
	}
	if (socketEntryExists) privateSocket(root, env);
	let stop: CommandResult;
	try {
		stop = await command(root, env, "hc", ["server", "stop", "--json"]);
	} catch (error) {
		stop = { code: null, stdout: "", stderr: String(error), timedOut: false };
	}
	const hasInvalidStartPid = options.startPid !== undefined && !isKillablePid(options.startPid);
	const startPid = isKillablePid(options.startPid) ? options.startPid : null;
	await pollUntil(() => !existsSync(socket) && (startPid === null || !isProcessAlive(startPid)), stopWaitMs);
	let fallbackKill: CoreStopResult["fallbackKill"];
	let fallbackKillSkipped: CoreStopResult["fallbackKillSkipped"];
	if (hasInvalidStartPid) {
		fallbackKillSkipped = {
			pid: typeof options.startPid === "number" && Number.isSafeInteger(options.startPid) ? options.startPid : null,
			reason: `refused invalid or protected startPid (${typeof options.startPid === "string" ? JSON.stringify(options.startPid) : String(options.startPid)})`,
		};
	} else if (startPid !== null && isProcessAlive(startPid)) {
		const procEnvBeforeTerm = readSafeProcEnviron(startPid, readProcEnviron);
		if (hasVerifiedHcSession(procEnvBeforeTerm, env.HC_SESSION)) {
			try { signalProcess(startPid, "SIGTERM"); } catch {}
			const exited = await pollUntil(() => !isProcessAlive(startPid), termWaitMs);
			if (!exited && isProcessAlive(startPid)) {
				const procEnvBeforeKill = readSafeProcEnviron(startPid, readProcEnviron);
				if (hasVerifiedHcSession(procEnvBeforeKill, env.HC_SESSION)) {
					try { signalProcess(startPid, "SIGKILL"); } catch {}
					await pollUntil(() => !isProcessAlive(startPid), killWaitMs);
					fallbackKill = { pid: startPid, signal: "SIGKILL", verifiedHcSession: env.HC_SESSION };
				} else {
					fallbackKill = { pid: startPid, signal: "SIGTERM", verifiedHcSession: env.HC_SESSION };
					fallbackKillSkipped = {
						pid: startPid,
						reason: procEnvBeforeKill
							? `HC_SESSION mismatch before SIGKILL (${JSON.stringify(procEnvBeforeKill.HC_SESSION)})`
							: "unreadable /proc environ before SIGKILL",
					};
				}
			} else {
				fallbackKill = { pid: startPid, signal: "SIGTERM", verifiedHcSession: env.HC_SESSION };
			}
		} else {
			fallbackKillSkipped = {
				pid: startPid,
				reason: procEnvBeforeTerm
					? `HC_SESSION mismatch (${JSON.stringify(procEnvBeforeTerm.HC_SESSION)})`
					: "unreadable /proc environ",
			};
		}
	}
	const socketRemaining = existsSync(socket);
	const remainingCoreAlive = startPid !== null ? isProcessAlive(startPid) : false;
	const holderPids = [...holderSet].sort((a, b) => a - b);
	const remainingHolderPids = holderPids.filter(pid => isProcessAlive(pid));
	return {
		mode: "fallback",
		verifyError: String(verifyError),
		stop,
		corePid: startPid,
		holderPids,
		remainingCoreAlive,
		remainingHolderPids,
		socketRemaining,
		fallbackKill,
		fallbackKillSkipped,
		stopped: !socketRemaining && !remainingCoreAlive && remainingHolderPids.length === 0,
	};
}

export async function readCoreStatus(
	root: string,
	env: NodeJS.ProcessEnv,
	expected?: CoreIdentity,
	observe?: (result: CommandResult) => void,
	readCgroup: (pid: number | "self") => string = defaultReadCgroup,
): Promise<{ identity: CoreIdentity; result: CommandResult; cgroup: string; hasRuntimeMarker: boolean; coreRuntimeEnv: string | null }> {
	const endpoint = privateSocket(root, env);
	if (expected) {
		assert.deepEqual(endpoint, { socket: expected.socket, device: expected.device, inode: expected.inode },
			"hc isolation socket was replaced");
	}
	const result = await command(root, env, "hc", ["server", "status", "--json"]);
	observe?.(result);
	successful(result, "hc server status");
	const status = payload(result);
	verifyReportedPaths(root, json(result.stdout));
	assert.ok(typeof status?.core?.id === "string" && status.core.id.trim(), "hc isolation requires a core id");
	assert.ok(isKillablePid(status.pid), "hc isolation requires the core's pid");
	const coreEnv = parseEnviron(readFileSync(`/proc/${status.pid}/environ`, "utf8"));
	assert.equal(coreEnv.INVOCATION_ID, undefined, "hc isolation rejected systemd-launched core (INVOCATION_ID present)");
	assertHcEnvironment(root, coreEnv, { allowDaemonMarkers: true });
	const cgroup = readCgroup(status.pid).trim();
	const callerCgroup = readCgroup("self").trim();
	assertSafeCoreCgroup(cgroup, callerCgroup);
	assert.deepEqual(privateSocket(root, env), endpoint, "hc isolation socket changed during status check");
	const identity = { ...endpoint, id: status.core.id as string, pid: status.pid as number };
	if (expected) assert.deepEqual(identity, expected, "hc isolation core identity changed");
	return { identity, result, cgroup, hasRuntimeMarker: coreEnv.HC_RUNTIME === "1", coreRuntimeEnv: coreEnv.HC_RUNTIME ?? null };
}
