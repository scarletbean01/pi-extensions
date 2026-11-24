import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecResult } from "../lifecycle.ts";
import { startViewer, type createViewerReader, type ViewerOptions, type ViewerServer } from "../../factory/viewer/server.ts";

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
 * Test-only positive control: invoke the private `command` method on a reader's underlying
 * `BootstrapService` to prove `options.exec` is wired into it.
 */
export async function probeReaderExec(
	reader: ReturnType<typeof createViewerReader>,
	args: string[] = ["api", "snapshot"],
): Promise<string> {
	const command = Reflect.get(reader.bootstrap, "command") as (args: string[]) => Promise<string>;
	return command.call(reader.bootstrap, args);
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
	const dirs = Array.isArray(options.stateDirs) ? options.stateDirs : [options.stateDirs];
	const coordinationPath = options.viewerOptions.coordinationPath;
	assert.ok(typeof coordinationPath === "string" && coordinationPath.trim().length > 0, "verifyReadOnlyViewer requires viewerOptions.coordinationPath");
	const resolvedCoord = resolve(coordinationPath);
	const coordUnderSnapshottedDir = dirs.some(dir => {
		const rel = relative(resolve(dir), resolvedCoord);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	});
	assert.ok(coordUnderSnapshottedDir, `verifyReadOnlyViewer requires coordinationPath (${resolvedCoord}) to lie under one of stateDirs`);
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
