import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "../lifecycle.ts";
import type { Host, HostBackendName } from "../host.ts";
import { spawnGroup } from "../test-harness.ts";
import { startViewer, createViewerReader, type ViewerOptions, type ViewerServer } from "../../factory/viewer/server.ts";

export type StateEntrySnapshot =
	| { kind: "dir" }
	| { kind: "file"; bytes: Buffer }
	| { kind: "symlink"; target: string }
	| { kind: "fifo" };

export type StateDirSnapshot = Map<string, StateEntrySnapshot>;

/** Capture a deterministic, byte-for-byte snapshot of every file, symlink, and directory in a fixture state directory. */
export function snapshotStateDir(directory: string): StateDirSnapshot {
	const snapshot: StateDirSnapshot = new Map();
	const visit = (current: string, relative: string) => {
		for (const name of readdirSync(current).sort()) {
			const fullPath = join(current, name);
			const key = relative ? `${relative}/${name}` : name;
			const stat = lstatSync(fullPath);
			if (stat.isSymbolicLink()) {
				snapshot.set(key, { kind: "symlink", target: readlinkSync(fullPath) });
			} else if (stat.isDirectory()) {
				snapshot.set(key, { kind: "dir" });
				visit(fullPath, key);
			} else if (stat.isFIFO()) {
				snapshot.set(key, { kind: "fifo" });
			} else {
				snapshot.set(key, { kind: "file", bytes: readFileSync(fullPath) });
			}
		}
	};
	visit(directory, "");
	return snapshot;
}

/** Assert that a fixture state directory is byte-for-byte identical to a previously captured snapshot. */
export function assertStateDirUnchanged(directory: string, before: StateDirSnapshot, label = directory): void {
	const after = snapshotStateDir(directory);
	const beforeKeys = [...before.keys()];
	const afterKeys = [...after.keys()];
	const added = afterKeys.filter(key => !before.has(key));
	const removed = beforeKeys.filter(key => !after.has(key));
	assert.deepEqual(
		{ added, removed },
		{ added: [], removed: [] },
		`State directory "${label}" changed structure (added: ${added.join(", ") || "none"}, removed: ${removed.join(", ") || "none"})`,
	);
	for (const [key, beforeEntry] of before.entries()) {
		const afterEntry = after.get(key)!;
		assert.equal(afterEntry.kind, beforeEntry.kind, `Entry kind changed for "${label}/${key}"`);
		if (beforeEntry.kind === "file" && afterEntry.kind === "file") {
			assert.ok(
				afterEntry.bytes.equals(beforeEntry.bytes),
				`File bytes changed for "${label}/${key}" (before ${beforeEntry.bytes.length}B, after ${afterEntry.bytes.length}B)`,
			);
		} else if (beforeEntry.kind === "symlink" && afterEntry.kind === "symlink") {
			assert.equal(afterEntry.target, beforeEntry.target, `Symlink target changed for "${label}/${key}"`);
		}
	}
}

export interface RecordedExecCall {
	command: string;
	args: string[];
}

/** Fake exec that records every invocation and fails closed so read-only viewer checks prove zero Herdr/command calls. */
export function createExecRecorder() {
	const calls: RecordedExecCall[] = [];
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		calls.push({ command, args: [...args] });
		throw new Error(`Viewer must not execute external commands: ${command} ${args.join(" ")}`);
	};
	const assertNoCalls = (message = "Expected no Herdr or external command calls during viewer operations") => {
		assert.deepEqual(calls, [], message);
	};
	return { exec, calls, assertNoCalls };
}

export interface VerifyReadOnlyViewerOptions {
	stateDirs: string | string[];
	viewerOptions: Omit<ViewerOptions, "exec"> & { coordinationPath: string };
	start?: typeof startViewer;
}

/**
 * Test-only positive control: resolve a Host through the private `hostForBackend` seam on a
 * reader's underlying `BootstrapService` and invoke `discoverOwnedNodes` to prove `options.exec`
 * is wired into it.
 */
export async function probeReaderExec(
	reader: ReturnType<typeof createViewerReader>,
	_args: string[] = ["api", "snapshot"],
): Promise<unknown> {
	const hostForBackend = Reflect.get(reader.bootstrap, "hostForBackend") as
		| ((backend: HostBackendName) => Host)
		| undefined;
	if (typeof hostForBackend !== "function") {
		throw new Error("BootstrapService.hostForBackend is unavailable for positive-control probe");
	}
	const host = hostForBackend.call(reader.bootstrap, "herdr");
	return host.discoverOwnedNodes([
		{
			run_id: "probe",
			node_id: "probe",
			persona_name: "probe",
			instance_id: "a1-probe",
			label: "probe:a1-probe",
		},
	]);
}

function assertIsolatedViewerOptions(options: Pick<VerifyReadOnlyViewerOptions, "stateDirs" | "viewerOptions">): { dirs: string[]; coordinationPath: string } {
	const dirs = Array.isArray(options.stateDirs) ? options.stateDirs : [options.stateDirs];
	const coordinationPath = options.viewerOptions.coordinationPath;
	assert.ok(typeof coordinationPath === "string" && coordinationPath.trim().length > 0, "verifyReadOnlyViewer requires viewerOptions.coordinationPath");
	const resolvedCoord = resolve(coordinationPath);
	const coordUnderSnapshottedDir = dirs.some(dir => {
		const rel = relative(resolve(dir), resolvedCoord);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	});
	assert.ok(coordUnderSnapshottedDir, `verifyReadOnlyViewer requires coordinationPath (${resolvedCoord}) to lie under one of stateDirs`);
	return { dirs, coordinationPath };
}

/**
 * Snapshot all configured `stateDirs` before starting the viewer, run the
 * caller's HTTP sequence with `createExecRecorder().exec` wired into
 * `options.exec`, close the viewer and assert it stopped listening, then
 * assert zero `options.exec` calls and byte-for-byte unchanged `stateDirs`.
 */
export async function verifyReadOnlyViewer(
	options: VerifyReadOnlyViewerOptions,
	run: (viewer: ViewerServer) => Promise<void>,
): Promise<void> {
	const { dirs } = assertIsolatedViewerOptions(options);
	const before = dirs.map(dir => [dir, snapshotStateDir(dir)] as const);
	const recorder = createExecRecorder();
	const start = options.start ?? startViewer;
	const viewer = await start({ ...options.viewerOptions, exec: recorder.exec });
	try {
		await run(viewer);
	} finally {
		await viewer.close();
		assert.equal(viewer.server.listening, false, "Expected viewer server to stop listening after close");
	}
	recorder.assertNoCalls();
	for (const [dir, snap] of before) {
		assertStateDirUnchanged(dir, snap);
	}
}

export interface ChildViewerResponse {
	path: string;
	status: number;
	text: string;
}

export interface VerifyReadOnlyViewerInChildOptions {
	stateDirs: string | string[];
	viewerOptions: Omit<ViewerOptions, "exec"> & { coordinationPath: string };
	paths: string[];
	timeoutMs?: number;
	childScript?: string;
	probeExec?: boolean;
}

const defaultLiveChildScript = fileURLToPath(new URL("./factory-viewer-live-child.ts", import.meta.url));

/**
 * Run `startViewer` and HTTP GET `paths` in an isolated child process under a hard `SIGKILL` watchdog
 * so a blocking non-regular file read (such as an unguarded FIFO) cannot freeze the parent test event loop,
 * while still verifying zero exec calls and byte-for-byte unchanged `stateDirs`.
 */
export async function verifyReadOnlyViewerInChild(
	options: VerifyReadOnlyViewerInChildOptions,
): Promise<ChildViewerResponse[]> {
	const { dirs } = assertIsolatedViewerOptions(options);
	const before = dirs.map(dir => [dir, snapshotStateDir(dir)] as const);
	const timeoutMs = options.timeoutMs ?? 5_000;
	const childScript = options.childScript ?? defaultLiveChildScript;
	const payload = JSON.stringify({
		statePath: options.viewerOptions.statePath,
		coordinationPath: options.viewerOptions.coordinationPath,
		env: options.viewerOptions.env,
		home: options.viewerOptions.home,
		paths: options.paths,
		...(options.probeExec ? { probeExec: true } : {}),
	});
	const fallbackHome = options.viewerOptions.home ?? resolve(dirs[0]!);
	const childEnv: NodeJS.ProcessEnv = {
		...(options.viewerOptions.env ?? { PATH: process.env.PATH ?? "" }),
		HOME: fallbackHome,
	};
	const group = spawnGroup(process.execPath, ["--experimental-strip-types", childScript, payload], { env: childEnv });
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	const timer = setTimeout(() => {
		timedOut = true;
		if (group.child.pid) {
			try { process.kill(-group.child.pid, "SIGKILL"); } catch { /* already exited */ }
		}
	}, timeoutMs);
	group.child.stdin.end();
	let result: { code: number | null; signal: NodeJS.Signals | null };
	try {
		result = await group.closed;
	} finally {
		clearTimeout(timer);
	}
	if (timedOut) {
		throw new Error(`viewer hung on non-regular file (SIGKILL after ${timeoutMs}ms)`);
	}
	assert.equal(result.code, 0, `Viewer child failed (code=${result.code}, signal=${result.signal}): ${stderr}`);
	assert.equal(result.signal, null, `Viewer child terminated by signal ${result.signal}: ${stderr}`);
	const parsed = JSON.parse(stdout) as { responses: ChildViewerResponse[] };
	for (const [dir, snap] of before) {
		assertStateDirUnchanged(dir, snap);
	}
	return parsed.responses;
}
