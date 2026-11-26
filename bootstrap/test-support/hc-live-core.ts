import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
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

export function command(root: string, env: NodeJS.ProcessEnv, binary: string, args: string[], timeout = 8_000): Promise<CommandResult> {
	assertHcEnvironment(root, env);
	// Kill only the CLI on timeout. A successful server start leaves a daemon for
	// the verified server-stop path to reap.
	return new Promise((resolve, reject) => {
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

export async function readCoreStatus(
	root: string, env: NodeJS.ProcessEnv, expected?: CoreIdentity, observe?: (result: CommandResult) => void,
): Promise<{ identity: CoreIdentity; result: CommandResult }> {
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
	assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0, "hc isolation requires the core's pid");
	const coreEnv = Object.fromEntries(readFileSync(`/proc/${status.pid}/environ`, "utf8")
		.split("\0").filter(entry => entry.includes("=")).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
	assertHcEnvironment(root, coreEnv);
	assert.deepEqual(privateSocket(root, env), endpoint, "hc isolation socket changed during status check");
	const identity = { ...endpoint, id: status.core.id as string, pid: status.pid as number };
	if (expected) assert.deepEqual(identity, expected, "hc isolation core identity changed");
	return { identity, result };
}
