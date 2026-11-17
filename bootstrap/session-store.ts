/** Durable bootstrap state. Project files are indexed independently of the dispatcher's cwd. */
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface BootstrapResult {
	agent_name: string;
	status: "success" | "partial" | "failure";
	summary: string;
	detail: string;
	artifacts?: Array<{ type: string; path?: string; action?: string; description?: string }>;
	metrics?: Record<string, number>;
	warnings?: string[];
	next_steps?: string[];
}

export interface AgentLaunch {
	agent_name: string;
	instance_id: string;
	expected_coms_name: string;
	expected_model: string;
	label: string;
	step?: number;
	predecessor?: string;
	successor?: string;
	tab_id?: string;
	pane_id?: string;
	terminal_id?: string;
	status: "planned" | "creating" | "tab_created" | "launch_submitted" | "ready" | "released" | "closed";
	error?: string;
}

export interface BootstrapManifest {
	version: 1;
	task_id: string;
	task: string;
	topology: "chain" | "team";
	project_cwd: string;
	session_dir: string;
	workspace_id: string;
	coms_project: string;
	dispatcher_coms_name?: string;
	dispatcher_session_id?: string;
	status: "launching" | "applied" | "error" | "cleaned";
	phase: string;
	created_at: string;
	updated_at: string;
	token: string;
	pane_manifest: AgentLaunch[];
	error?: string;
	cleanup_errors?: string[];
	/** Cleanup found no live tab/pane for these agents and treated them as already closed. */
	cleanup_notes?: string[];
	/** Session files are unavailable (deleted or missing); no further project writes are attempted. */
	session_dir_removed?: boolean;
	/** Session files were deleted by an explicit delete_session_files cleanup. */
	session_files_deleted?: boolean;
	/** The launch was found interrupted (its launcher died) and the manifest was reconciled from durable markers. */
	reconciled?: boolean;
}

export interface WorkerConfig {
	task_id: string;
	token: string;
	session_dir: string;
	project_cwd: string;
	coms_dir: string;
	coms_project: string;
	instance_id: string;
	agent_name: string;
	persona: string;
	expected_model?: string;
	tools: string[];
	sub_task: string;
	topology: "chain" | "team";
	step?: number;
	predecessor?: string;
	successor?: string;
	startup_message: string;
	ready_timeout_ms: number;
	/** The run's overall task, so each agent understands how its sub-task fits. */
	task?: string;
	/** Everyone in the run, in plan order (for coordination and orientation only). */
	roster?: Array<{ instance_id: string; agent_name: string; step?: number; sub_task: string }>;
}

export interface WorkerReady {
	task_id: string;
	token: string;
	instance_id: string;
	pid: number;
	session_id: string;
	name: string;
	endpoint: string;
	model: string;
	/** Kernel process start time (Linux /proc), used to detect PID reuse. */
	start_time?: string;
}

export interface WorkerCompletion {
	result: BootstrapResult;
	delivery: "pending" | "sent" | "not_required" | "failed";
	delivery_error?: string;
	completed_at: string;
}

export function assertTaskId(id: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)) throw new Error("Invalid bootstrap task_id");
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function atomicJson(path: string, value: unknown): void {
	atomicText(path, JSON.stringify(value, null, 2) + "\n");
}

export function atomicText(path: string, text: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Process start time from /proc/<pid>/stat (field 22), or undefined where unavailable. */
export function processStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch { return undefined; }
}

/** Whether the acknowledged worker process is still the same live process (not a reused PID). */
export function processAlive(ready: { pid: number; start_time?: string }): boolean {
	try { process.kill(ready.pid, 0); }
	catch (error: any) {
		if (error?.code === "ESRCH") return false;
		// EPERM: the PID exists but belongs to another user, so it cannot be our worker any more.
		if (error?.code === "EPERM") return false;
		throw error;
	}
	if (!ready.start_time) return true;
	const current = processStartTime(ready.pid);
	return current === undefined || current === ready.start_time;
}

export function readyPath(dir: string, instance: string): string { return join(dir, `${instance}.ready.json`); }
export function resultPath(dir: string, instance: string): string { return join(dir, `${instance}.result.json`); }

export class SessionStore {
	readonly indexRoot: string;
	constructor(indexRoot: string) { this.indexRoot = indexRoot; }

	private indexPath(taskId: string): string {
		assertTaskId(taskId);
		return join(this.indexRoot, `${taskId}.json`);
	}

	save(manifest: BootstrapManifest): void {
		mkdirSync(this.indexRoot, { recursive: true, mode: 0o700 });
		manifest.updated_at = new Date().toISOString();
		// The independent index is also a recovery journal if the project becomes inaccessible.
		atomicJson(this.indexPath(manifest.task_id), manifest);
		if (!manifest.session_dir_removed) atomicJson(join(manifest.session_dir, "manifest.json"), manifest);
	}

	load(taskId: string, cwd?: string, allowMissingSession = false): BootstrapManifest {
		const index = this.indexPath(taskId);
		const path = existsSync(index) ? index : cwd ? join(cwd, ".pi", "agent-sessions", taskId, "manifest.json") : index;
		if (!existsSync(path)) throw new Error(`No bootstrap session found for task_id "${taskId}". Use the task_id, not the workspace_id.`);
		const manifest = readJson<BootstrapManifest>(path);
		if (manifest.version !== 1 || manifest.task_id !== taskId || !Array.isArray(manifest.pane_manifest)) {
			throw new Error(`Invalid bootstrap manifest for "${taskId}"`);
		}
		if (!isAbsolute(manifest.project_cwd) || manifest.session_dir !== join(manifest.project_cwd, ".pi", "agent-sessions", taskId)) {
			throw new Error("Session directory does not match the recorded project root");
		}
		if (!manifest.session_dir_removed) {
			try { this.assertDirectory(manifest); }
			catch (error: any) {
				// Cleanup must remain possible from the independent index after project files disappear.
				if (!allowMissingSession || error?.code !== "ENOENT") throw error;
				manifest.session_dir_removed = true;
			}
		}
		return manifest;
	}

	/** Most recently updated runs from the independent index (unreadable records are skipped). */
	list(limit = 10): BootstrapManifest[] {
		let files: string[];
		try { files = readdirSync(this.indexRoot).filter(file => file.endsWith(".json") && !file.startsWith("request-")); } catch { return []; }
		const runs: BootstrapManifest[] = [];
		for (const file of files) {
			try { const manifest = readJson<BootstrapManifest>(join(this.indexRoot, file)); if (manifest.version === 1 && `${manifest.task_id}.json` === file) runs.push(manifest); } catch { /* skip */ }
		}
		return runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
	}

	assertDirectory(manifest: BootstrapManifest): void {
		const dir = manifest.session_dir;
		if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir)) {
			throw new Error("Refusing a symlinked or non-directory bootstrap session path");
		}
		if (realpathSync(dirname(dir)) !== dirname(dir)) throw new Error("Refusing a symlinked sessions root");
	}
}

/**
 * Publish a complete file at `path` only if nothing exists there yet. link(2) is atomic and exclusive,
 * so readers never see a partial record and a crash never leaves an empty one. Returns false on EEXIST.
 */
export function publishExclusive(path: string, text: string): boolean {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		try { linkSync(temporary, path); return true; }
		catch (error: any) { if (error?.code === "EEXIST") return false; throw error; }
	} finally { rmSync(temporary, { force: true }); }
}

interface LockOwner { pid: number; start_time?: string; instance: string; acquired_at: number }
/** Identifies this module instance: a /reload in the same process gets a new one. */
const LOCK_INSTANCE = randomUUID();
export const LOCK_WAIT_MS = 15 * 60_000;

function readLockOwner(path: string): LockOwner | undefined {
	try { return readJson<LockOwner>(path); } catch { return undefined; }
}

/** Whether another live holder owns the lock file. Our own instance never holds it outside withRunLock. */
export function lockHeld(key: string): boolean {
	const owner = readLockOwner(`${key}.lock`);
	if (!owner || !Number.isInteger(owner.pid)) return existsSync(`${key}.lock`) && Date.now() - safeMtime(`${key}.lock`) < 5000; // a torn record is being written
	try { return processAlive(owner); } catch { return true; }
}

function safeMtime(path: string): number {
	try { return lstatSync(path).mtimeMs; } catch { return 0; }
}

async function acquireFileLock(path: string, waitMs: number): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + waitMs;
	for (;;) {
		const record: LockOwner = { pid: process.pid, start_time: processStartTime(process.pid), instance: LOCK_INSTANCE, acquired_at: Date.now() };
		if (publishExclusive(path, JSON.stringify(record))) return;
		const owner = readLockOwner(path);
		// Same module instance: the in-process queue already serialized us, so this is a leftover. Other
		// instances in this process (after /reload) may still be running and are treated as live.
		let stale = false;
		if (owner && Number.isInteger(owner.pid)) {
			try { stale = owner.pid === process.pid ? owner.instance === LOCK_INSTANCE : !processAlive(owner); } catch { stale = false; }
		} else stale = Date.now() - safeMtime(path) > 5000; // unreadable for long: a crashed writer
		if (stale) {
			// Steal by renaming, then verify we took the stale record and not a fresh lock published meanwhile.
			const taken = `${path}.${randomUUID()}.stale`;
			try {
				renameSync(path, taken);
				const victim = readLockOwner(taken);
				if (owner && victim && (victim.pid !== owner.pid || victim.acquired_at !== owner.acquired_at)) {
					try { linkSync(taken, path); } catch { /* a third party holds it now; it stays authoritative */ }
				}
			} catch { /* someone else removed or stole it first */ }
			finally { rmSync(taken, { force: true }); }
			continue;
		}
		if (Date.now() >= deadline) throw new Error(`Bootstrap run is locked by another process (pid ${owner?.pid ?? "unknown"}). Retry later, or remove ${path} if that process is gone.`);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function releaseFileLock(path: string): void {
	const owner = readLockOwner(path);
	if (owner?.instance === LOCK_INSTANCE && owner.pid === process.pid) rmSync(path, { force: true });
}

const locks = new Map<string, Promise<void>>();
/**
 * Serialize launch/report/cleanup on a run without blocking unrelated runs: an in-process queue
 * plus a lock file (`<key>.lock`) that coordinates separate dispatcher processes.
 */
export async function withRunLock<T>(key: string, action: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => { release = resolve; });
	locks.set(key, current);
	await previous;
	try {
		await acquireFileLock(`${key}.lock`, waitMs);
		try { return await action(); }
		finally { releaseFileLock(`${key}.lock`); }
	}
	finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Bootstrap cancelled");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	checkAbort(signal);
	return new Promise((resolve, reject) => {
		const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(finish, ms);
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Bootstrap cancelled")); };
		signal?.addEventListener("abort", abort, { once: true });
	});
}
