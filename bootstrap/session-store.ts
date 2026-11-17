/** Durable bootstrap state. Project files are indexed independently of the dispatcher's cwd. */
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactMetadata, OutputContract, RosterEntry, VerificationSummary } from "./contracts.ts";

/**
 * Identities (see the bootstrap README): the run is the public `task_id`; a node is one planned assignment;
 * the persona is the reusable configuration it runs; an attempt is one execution of a node; the worker instance
 * is the live process/Coms identity (`instance_id`, with the session recorded in its ready file).
 */
export const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
/** Persisted-format versions. Version 1 is the original persona-keyed format; new records are written as version 2. */
export const CURRENT_VERSION = 2;
const READABLE_VERSIONS = [1, 2];

export interface BootstrapResult {
	/** Persona that produced the result (several nodes may share one). */
	agent_name: string;
	/** The assignment this result belongs to. Absent on results written before node identities existed. */
	node_id?: string;
	status: "success" | "partial" | "failure";
	summary: string;
	detail: string;
	artifacts?: ArtifactMetadata[];
	outputs?: Record<string, unknown>;
	verification?: VerificationSummary[];
	metrics?: Record<string, number>;
	warnings?: string[];
	next_steps?: string[];
}

/**
 * One planned node's launch record, in the normalized in-memory form. Version 1 files stored the persona as
 * `agent_name` and had no separate node or attempt; they are normalized on read (`node_id` = persona name) and
 * written back unchanged in the version 1 form, never rewritten into version 2.
 */
export interface AgentLaunch {
	node_id: string;
	persona_name: string;
	/** One execution of the node. Absent for version 1 runs, which predate attempts. */
	attempt_id?: string;
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
	version: 1 | 2;
	/** Whether the launch request used the legacy name/sub_task form or explicit nodes. Version 2 only. */
	request_form?: "legacy" | "nodes";
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

/** Normalized worker configuration. Version 1 files (no `version`) carried `agent_name` and are normalized on read. */
export interface WorkerConfig {
	version?: 1 | 2;
	/** The run ID. */
	task_id: string;
	token: string;
	session_dir: string;
	project_cwd: string;
	coms_dir: string;
	coms_project: string;
	/** Worker instance and Coms identity. */
	instance_id: string;
	node_id: string;
	persona_name: string;
	attempt_id?: string;
	/** The persona's system prompt snapshot. */
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
	goal?: string;
	acceptance_criteria?: string[];
	constraints?: string[];
	role?: string;
	ownership?: string[];
	node_acceptance_criteria?: string[];
	node_constraints?: string[];
	output_contract?: OutputContract;
	required_checks?: string[];
	upstream_contracts?: Record<string, { output_contract?: OutputContract; required_checks?: string[] }>;
	/** Everyone in the run, in plan order (for coordination and orientation only). */
	roster?: RosterEntry[];
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

/** Who a result belongs to; version 2 completions record it so a misplaced or foreign file is detected on read. */
export interface CompletionIdentity { run_id: string; node_id: string; persona_name: string; attempt_id: string; instance_id: string }

export interface WorkerCompletion {
	/** Absent on version 1 records, which carry only the persona-keyed result. */
	version?: 2;
	identity?: CompletionIdentity;
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

// ---- versioned readers (validation happens at the read boundary) ----

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function checkVersion(value: unknown, what: string, absentIsV1: boolean, subject = ""): 1 | 2 {
	const version = value === undefined && absentIsV1 ? 1 : value;
	if (typeof version !== "number" || !READABLE_VERSIONS.includes(version)) {
		throw new Error(`Unsupported ${what} version ${JSON.stringify(value)}${subject}: this release reads versions ${READABLE_VERSIONS.join(" and ")}. The record was left untouched; inspect or clean it up with a release that supports it`);
	}
	return version as 1 | 2;
}

/** Version 1 stored the persona as `agent_name` and had no node or attempt; version 2 stores all three explicitly. */
function normalizeIdentity(raw: Record<string, unknown>, version: 1 | 2): { node_id: string; persona_name: string; attempt_id?: string } {
	if (version === 1) {
		const persona = nonEmpty(raw.agent_name, "agent_name");
		return { node_id: persona, persona_name: persona };
	}
	const node = nonEmpty(raw.node_id, "node_id");
	if (!NODE_ID_PATTERN.test(node)) throw new Error(`node_id is not a valid node ID: ${node}`);
	return { node_id: node, persona_name: nonEmpty(raw.persona_name, "persona_name"), attempt_id: nonEmpty(raw.attempt_id, "attempt_id") };
}

/** Validate a persisted manifest and normalize it to the in-memory shape. Throws a clear error for anything unreadable. */
export function parseManifest(raw: unknown, taskId: string): BootstrapManifest {
	if (!isRecord(raw)) throw new Error(`Invalid bootstrap manifest for "${taskId}"`);
	const version = checkVersion(raw.version, "bootstrap manifest", false, ` for "${taskId}"`);
	if (raw.task_id !== taskId || !Array.isArray(raw.pane_manifest)) throw new Error(`Invalid bootstrap manifest for "${taskId}"`);
	const nodes = new Set<string>();
	const instances = new Set<string>();
	const pane_manifest = raw.pane_manifest.map((entry, index): AgentLaunch => {
		try {
			if (!isRecord(entry)) throw new Error("not an object");
			const { agent_name: _legacyPersona, node_id: _node, persona_name: _persona, attempt_id: _attempt, ...rest } = entry;
			const identity = normalizeIdentity(entry, version);
			const instance = nonEmpty(entry.instance_id, "instance_id");
			if (nodes.has(identity.node_id.toLowerCase())) throw new Error(`duplicate node ID ${identity.node_id}`);
			if (instances.has(instance)) throw new Error(`duplicate instance ${instance}`);
			nodes.add(identity.node_id.toLowerCase()); instances.add(instance);
			return { ...rest, ...identity, instance_id: instance } as unknown as AgentLaunch;
		} catch (error) { throw new Error(`Invalid bootstrap manifest for "${taskId}": agent ${index + 1}: ${errorMessage(error)}`); }
	});
	return { ...raw, version, pane_manifest } as unknown as BootstrapManifest;
}

/** The stored form. Version 1 runs are written back in the version 1 shape: their identities are never rewritten. */
function storedManifest(manifest: BootstrapManifest): unknown {
	if (manifest.version !== 1) return manifest;
	return { ...manifest, pane_manifest: manifest.pane_manifest.map(({ node_id: _node, persona_name, attempt_id: _attempt, ...rest }) => ({ agent_name: persona_name, ...rest })) };
}

/** Validate a persisted worker configuration and normalize version 1 (persona-keyed) files. */
export function parseWorkerConfig(raw: unknown): WorkerConfig {
	if (!isRecord(raw)) throw new Error("Invalid bootstrap child configuration");
	const version = checkVersion(raw.version, "bootstrap worker configuration", true);
	const { agent_name: _legacyPersona, ...rest } = raw;
	const identity = normalizeIdentity(raw, version);
	const roster = raw.roster === undefined ? undefined : (Array.isArray(raw.roster) ? raw.roster : (() => { throw new Error("roster must be an array"); })()).map((member: unknown) => {
		if (!isRecord(member)) throw new Error("roster entries must be objects");
		const { agent_name: _persona, ...fields } = member;
		const persona = version === 1 ? nonEmpty(member.agent_name, "roster agent_name") : nonEmpty(member.persona_name, "roster persona_name");
		return { ...fields, instance_id: nonEmpty(member.instance_id, "roster instance_id"), node_id: version === 1 ? persona : nonEmpty(member.node_id, "roster node_id"), persona_name: persona };
	});
	return { ...rest, ...identity, version, ...(roster ? { roster } : {}) } as unknown as WorkerConfig;
}

/** What a result file must say about itself. The run and the instance are always known; a reader that knows more (the node, persona, attempt) checks more. */
export interface CompletionExpectation {
	run_id: string; instance_id: string; node_id?: string; persona_name?: string; attempt_id?: string;
	/** Another node of the run shares this persona, so a persona-only (version 1) record cannot prove which node it is for. */
	personaShared?: boolean;
}

/** Validate a persisted result against the node whose file it is. Throws a message suitable for the per-agent error. */
export function parseCompletion(raw: unknown, expected: CompletionExpectation): WorkerCompletion {
	if (!isRecord(raw) || !isRecord(raw.result)) throw new Error("malformed result record");
	const version = checkVersion(raw.version, "result record", true);
	const result = raw.result as unknown as BootstrapResult;
	if (typeof result.summary !== "string" || !["success", "partial", "failure"].includes(result.status)) throw new Error("malformed result record");
	if (version === 1) {
		if (expected.persona_name !== undefined && result.agent_name !== expected.persona_name) throw new Error(`result identity mismatch (recorded for ${result.agent_name})`);
		if (expected.personaShared) throw new Error(`version 1 result is ambiguous: persona ${expected.persona_name} is shared by several nodes of this run`);
		return raw as unknown as WorkerCompletion;
	}
	const identity = raw.identity;
	if (!isRecord(identity)) throw new Error("result identity mismatch (no identity recorded)");
	const recorded = identity as unknown as CompletionIdentity;
	for (const field of ["run_id", "node_id", "persona_name", "instance_id"] as const) {
		if (expected[field] !== undefined && recorded[field] !== expected[field]) throw new Error(`result identity mismatch (${field} ${JSON.stringify(recorded[field])}, expected ${JSON.stringify(expected[field])})`);
	}
	if (expected.attempt_id !== undefined && recorded.attempt_id !== expected.attempt_id) throw new Error(`result identity mismatch (attempt_id ${JSON.stringify(recorded.attempt_id)}, expected ${JSON.stringify(expected.attempt_id)})`);
	// The result inside the record must agree with the identity that wraps it.
	if (result.agent_name !== recorded.persona_name || (result.node_id !== undefined && result.node_id !== recorded.node_id)) throw new Error(`result identity mismatch (result recorded for ${result.node_id ?? "?"}/${result.agent_name})`);
	return raw as unknown as WorkerCompletion;
}

/** The version 2 record for a finished node, stamped with the identity of the config that produced it. */
export function completionRecord(config: WorkerConfig, result: BootstrapResult, delivery: WorkerCompletion["delivery"], completedAt: string): WorkerCompletion {
	if (config.version === 1) return { result: { ...result, agent_name: config.persona_name }, delivery, completed_at: completedAt };
	return {
		version: 2,
		identity: { run_id: config.task_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id!, instance_id: config.instance_id },
		result: { ...result, agent_name: config.persona_name, node_id: config.node_id }, delivery, completed_at: completedAt,
	};
}

/** Expectation for one launch record, for `parseCompletion`. */
export function expectationFor(manifest: BootstrapManifest, entry: AgentLaunch): CompletionExpectation {
	return {
		run_id: manifest.task_id, node_id: entry.node_id, persona_name: entry.persona_name, attempt_id: entry.attempt_id, instance_id: entry.instance_id,
		personaShared: manifest.pane_manifest.some(other => other !== entry && other.persona_name.toLowerCase() === entry.persona_name.toLowerCase()),
	};
}

/** "node" when the node is named after its persona, otherwise "node, persona X": the identifiers selectors and reports use. */
export function nodeIdentity(node: { node_id: string; persona_name: string }): string {
	return node.node_id.toLowerCase() === node.persona_name.toLowerCase() ? node.node_id : `${node.node_id}, persona ${node.persona_name}`;
}

/** Label for messages: the node, with its persona when that is a different name. */
export function nodeLabel(node: { node_id: string; persona_name: string }): string {
	return node.node_id.toLowerCase() === node.persona_name.toLowerCase() ? node.node_id : `${node.node_id} (persona ${node.persona_name})`;
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
		const stored = storedManifest(manifest);
		atomicJson(this.indexPath(manifest.task_id), stored);
		if (!manifest.session_dir_removed) atomicJson(join(manifest.session_dir, "manifest.json"), stored);
	}

	load(taskId: string, cwd?: string, allowMissingSession = false): BootstrapManifest {
		const index = this.indexPath(taskId);
		const path = existsSync(index) ? index : cwd ? join(cwd, ".pi", "agent-sessions", taskId, "manifest.json") : index;
		if (!existsSync(path)) throw new Error(`No bootstrap session found for task_id "${taskId}". Use the task_id, not the workspace_id.`);
		// Fail closed on an unsupported or malformed record; it is never rewritten, so its ownership evidence stays intact.
		const manifest = parseManifest(readJson<unknown>(path), taskId);
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
			try { runs.push(parseManifest(readJson<unknown>(join(this.indexRoot, file)), file.slice(0, -".json".length))); } catch { /* skip unreadable or unsupported records */ }
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

interface LockOwner { pid: number; start_time?: string; instance: string; acquired_at: number; /** Unique per acquisition; absent in records written by older versions. */ id?: string }
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

/** Identity of one specific lock record, so recovery of that record (and no other) can be claimed exclusively. */
export function lockRecordIdentity(path: string, owner: LockOwner | undefined): string | undefined {
	if (owner && Number.isInteger(owner.pid)) return createHash("sha1").update(`${owner.id ?? ""}:${owner.pid}:${owner.start_time ?? ""}:${owner.instance}:${owner.acquired_at}`).digest("hex").slice(0, 20);
	try { const info = lstatSync(path); return `torn-${info.ino}-${Math.trunc(info.mtimeMs)}`; } catch { return undefined; }
}

/**
 * Remove one specific stale lock record without ever disturbing a live holder.
 *
 * Deleting "whatever is at the lock path" is unsafe: a contender that judged record S stale may be
 * overtaken by another that removes S and publishes its own live lock, and the slower contender would
 * then remove that live lock. Instead, recovery of S needs an exclusive claim (published with link(2))
 * named after S. Only the claim holder may remove S, and S is a unique record that is never written
 * again, so after claiming, finding anything else at the path proves S is already gone and nothing is
 * removed. A claim whose holder died is superseded by the next generation. Returns false when a live
 * recovery of this record is in progress elsewhere (the caller waits and re-evaluates).
 */
function breakStaleLock(path: string, identity: string): boolean {
	for (let generation = 0; ; generation++) {
		const claim = `${path}.break-${identity}-${generation}`;
		const record: LockOwner = { pid: process.pid, start_time: processStartTime(process.pid), instance: LOCK_INSTANCE, acquired_at: Date.now() };
		if (publishExclusive(claim, JSON.stringify(record))) {
			try {
				if (lockRecordIdentity(path, readLockOwner(path)) === identity) rmSync(path, { force: true });
			} finally {
				// Every lower generation belonged to a dead breaker; nothing can need them once S is gone.
				for (let lower = 0; lower <= generation; lower++) rmSync(`${path}.break-${identity}-${lower}`, { force: true });
			}
			return true;
		}
		const holder = readLockOwner(claim);
		const alive = holder && Number.isInteger(holder.pid) ? ((): boolean => { try { return processAlive(holder); } catch { return true; } })() : Date.now() - safeMtime(claim) < 5000;
		if (alive) return false;
	}
}

async function acquireFileLock(path: string, waitMs: number): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + waitMs;
	for (;;) {
		const record: LockOwner = { pid: process.pid, start_time: processStartTime(process.pid), instance: LOCK_INSTANCE, acquired_at: Date.now(), id: randomUUID() };
		if (publishExclusive(path, JSON.stringify(record))) return;
		const owner = readLockOwner(path);
		// Same module instance: the in-process queue already serialized us, so this is a leftover. Other
		// instances in this process (after /reload) may still be running and are treated as live.
		let stale = false;
		if (owner && Number.isInteger(owner.pid)) {
			try {
				// Our own PID: a record from another instance of this module is live, unless its start time proves a
				// previous process that has since recycled this PID.
				const recycled = owner.start_time !== undefined && owner.start_time !== processStartTime(process.pid);
				stale = owner.pid === process.pid ? owner.instance === LOCK_INSTANCE || (recycled && processStartTime(process.pid) !== undefined) : !processAlive(owner);
			} catch { stale = false; }
		} else stale = Date.now() - safeMtime(path) > 5000; // unreadable for long: a crashed writer
		if (stale) {
			const identity = lockRecordIdentity(path, owner);
			if (identity === undefined) continue; // the record vanished meanwhile: try to publish again
			if (breakStaleLock(path, identity)) continue;
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
