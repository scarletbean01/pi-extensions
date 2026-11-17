/**
 * Independent team execution policies, shared-cwd read/write ownership declarations,
 * deterministic conflict serialization, and durable ownership admission helpers.
 *
 * Shared-cwd ownership is an advisory scheduling contract unless backed by external
 * enforcement or separate workspaces; path declarations are never a filesystem sandbox.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
	COLLABORATION_MODES, FAILURE_POLICIES, WORKSPACE_STRATEGY,
	type CauseRef, type CollaborationMode, type FailurePolicy, type ResolvedCollaborationMode, type WorkspaceStrategy,
} from "./outcomes.ts";
import {
	dispositionPath, errorMessage, parseCompletion, parseDisposition, processAlive, publishExclusive, readJson, readyPath, resultPath,
	type CompletionExpectation, type CompletionIdentity, type WorkerReady,
} from "./session-store.ts";

export { COLLABORATION_MODES, FAILURE_POLICIES, WORKSPACE_STRATEGY };
export type { CollaborationMode, FailurePolicy, ResolvedCollaborationMode, WorkspaceStrategy };

export const OWNERSHIP_RECORD_VERSION = 1;
const READABLE_OWNERSHIP_VERSIONS = [1];

export interface OwnershipAdmissionRecord {
	version: 1;
	identity: CompletionIdentity;
	state: "waiting" | "admitted" | "released";
	write_paths: string[];
	read_paths: string[];
	waiting_for: string[];
	admitted_at?: string;
	released_at?: string;
	updated_at: string;
}

export interface FailFastCancelRecord {
	version: 1;
	task_id: string;
	token: string;
	cause: CauseRef & { instance_id: string };
	recorded_at: string;
}

export interface OwnershipConflict {
	node_id: string;
	instance_id: string;
	waits_for_node_id: string;
	waits_for_instance_id: string;
	overlapping_paths: string[];
}

export interface ScheduledOwnershipNode {
	node_id: string;
	instance_id: string;
	read_paths?: string[];
	write_paths?: string[];
}

const WHOLE_PROJECT_TOKENS = new Set([".", "./", "*", "**", "**/*"]);
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Normalize a declared read/write ownership path relative to `projectCwd` using POSIX separators.
 * Rejects empty strings, NUL characters, and paths escaping `projectCwd`.
 */
export function normalizeOwnershipPath(projectCwd: string, rawPath: string, fieldLabel: string): string {
	if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
		throw new Error(`${fieldLabel} entries must be non-empty strings without NUL characters`);
	}
	const trimmed = rawPath.trim().replaceAll("\\", "/");
	if (WHOLE_PROJECT_TOKENS.has(trimmed)) return ".";
	const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectCwd, trimmed);
	const rel = relative(resolve(projectCwd), abs);
	if (rel === "") return ".";
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`${fieldLabel} "${rawPath}" escapes project_cwd`);
	}
	const normalized = rel.split(sep).join("/").replace(/\/+$/, "");
	if (!normalized || WHOLE_PROJECT_TOKENS.has(normalized)) return ".";
	return normalized;
}

/** Normalize and deduplicate a list of ownership paths while preserving first-seen order. */
export function normalizeOwnershipPaths(projectCwd: string, rawPaths: string[], fieldLabel: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of rawPaths) {
		const norm = normalizeOwnershipPath(projectCwd, item, fieldLabel);
		if (!seen.has(norm)) {
			seen.add(norm);
			out.push(norm);
		}
	}
	return out;
}

function staticPrefix(pattern: string): string {
	if (pattern === ".") return ".";
	const parts = pattern.split("/");
	const prefix: string[] = [];
	for (const part of parts) {
		if (GLOB_CHARS.test(part)) break;
		prefix.push(part);
	}
	return prefix.length ? prefix.join("/") : ".";
}

function exactOrParentOverlap(a: string, b: string): boolean {
	if (a === "." || b === ".") return true;
	if (a === b) return true;
	return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function globToRegExp(pattern: string): RegExp {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	re += "$";
	return new RegExp(re);
}

function globOverlapsConcrete(globPattern: string, concrete: string): boolean {
	if (globPattern === "." || concrete === ".") return true;
	const prefix = staticPrefix(globPattern);
	// If the concrete path is the static prefix or an ancestor of it, the directory covers the glob's matches.
	if (prefix === concrete || prefix.startsWith(`${concrete}/`)) return true;
	// If the concrete path lies outside the glob's static prefix subtree, it cannot match.
	if (prefix !== "." && !concrete.startsWith(`${prefix}/`)) return false;
	const regex = globToRegExp(globPattern);
	if (regex.test(concrete)) return true;
	// If the concrete path is a directory name (no extension) inside a ** glob subtree, descendants can match.
	const base = posix.basename(concrete);
	if (!base.includes(".") && globPattern.includes("**")) {
		const ext = posix.extname(globPattern);
		const probe = ext && !GLOB_CHARS.test(ext) ? `${concrete}/probe${ext}` : `${concrete}/probe`;
		if (regex.test(probe)) return true;
	}
	return false;
}

/** Whether two normalized ownership paths/scopes can touch the same filesystem target. */
export function pathsOverlap(a: string, b: string): boolean {
	if (a === "." || b === ".") return true;
	const aGlob = GLOB_CHARS.test(a);
	const bGlob = GLOB_CHARS.test(b);
	if (!aGlob && !bGlob) return exactOrParentOverlap(a, b);
	if (aGlob && !bGlob) return globOverlapsConcrete(a, b);
	if (!aGlob && bGlob) return globOverlapsConcrete(b, a);
	// Both are globs: disjoint static subtrees cannot overlap; distinct concrete extensions cannot overlap.
	const prefixA = staticPrefix(a);
	const prefixB = staticPrefix(b);
	if (!exactOrParentOverlap(prefixA, prefixB)) return false;
	const extA = posix.extname(a);
	const extB = posix.extname(b);
	if (extA && extB && !GLOB_CHARS.test(extA) && !GLOB_CHARS.test(extB) && extA !== extB) return false;
	return true;
}

/**
 * Compute deterministic plan-order serialization waits for nodes with overlapping `write_paths`.
 * Readers (`write_paths` empty/omitted) never wait and never block other nodes.
 */
export function computeOwnershipSchedule(nodes: ScheduledOwnershipNode[]): {
	waitsFor: Map<string, string[]>;
	conflicts: OwnershipConflict[];
} {
	const waitsFor = new Map<string, string[]>();
	const conflicts: OwnershipConflict[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const current = nodes[i];
		const currentWrites = current.write_paths ?? [];
		const waitIds: string[] = [];
		if (currentWrites.length > 0) {
			for (let j = 0; j < i; j++) {
				const earlier = nodes[j];
				const earlierWrites = earlier.write_paths ?? [];
				if (!earlierWrites.length) continue;
				const overlapping: string[] = [];
				for (const curPath of currentWrites) {
					for (const prevPath of earlierWrites) {
						if (pathsOverlap(curPath, prevPath)) {
							overlapping.push(curPath === prevPath ? curPath : `${curPath} <-> ${prevPath}`);
						}
					}
				}
				if (overlapping.length > 0) {
					waitIds.push(earlier.instance_id);
					conflicts.push({
						node_id: current.node_id,
						instance_id: current.instance_id,
						waits_for_node_id: earlier.node_id,
						waits_for_instance_id: earlier.instance_id,
						overlapping_paths: [...new Set(overlapping)],
					});
				}
			}
		}
		waitsFor.set(current.instance_id, waitIds);
	}
	return { waitsFor, conflicts };
}

export function ownershipPath(sessionDir: string, instanceId: string): string {
	return join(sessionDir, `${instanceId}.ownership.json`);
}

export function failFastPath(sessionDir: string): string {
	return join(sessionDir, "fail-fast.json");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Validate a persisted `<instance_id>.ownership.json` record at the read boundary. */
export function parseOwnershipRecord(raw: unknown, expected: CompletionExpectation): OwnershipAdmissionRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed ownership record");
	const rec = raw as Record<string, unknown>;
	if (typeof rec.version !== "number" || !READABLE_OWNERSHIP_VERSIONS.includes(rec.version)) {
		throw new Error(`Unsupported ownership record version ${JSON.stringify(rec.version)}: this release reads version 1. The record was left untouched`);
	}
	const identity = rec.identity as Record<string, unknown> | undefined;
	if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
		throw new Error("ownership identity mismatch (no identity recorded)");
	}
	for (const field of ["run_id", "node_id", "persona_name", "instance_id"] as const) {
		if (expected[field] !== undefined && identity[field] !== expected[field]) {
			throw new Error(`ownership identity mismatch (${field} ${JSON.stringify(identity[field])}, expected ${JSON.stringify(expected[field])})`);
		}
	}
	if (expected.attempt_id !== undefined && identity.attempt_id !== expected.attempt_id) {
		throw new Error(`ownership identity mismatch (attempt_id ${JSON.stringify(identity.attempt_id)}, expected ${JSON.stringify(expected.attempt_id)})`);
	}
	if (!["waiting", "admitted", "released"].includes(rec.state as string)) {
		throw new Error("malformed ownership record: invalid state");
	}
	if (!isStringArray(rec.write_paths) || !isStringArray(rec.read_paths) || !isStringArray(rec.waiting_for) || typeof rec.updated_at !== "string") {
		throw new Error("malformed ownership record");
	}
	return rec as unknown as OwnershipAdmissionRecord;
}

export function parseFailFastRecord(raw: unknown, taskId: string, token: string): FailFastCancelRecord {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed fail-fast record");
	const rec = raw as Record<string, unknown>;
	if (rec.version !== 1) throw new Error(`Unsupported fail-fast record version ${JSON.stringify(rec.version)}`);
	if (rec.task_id !== taskId || rec.token !== token) throw new Error("fail-fast record run/token mismatch");
	const cause = rec.cause as Record<string, unknown> | undefined;
	if (!cause || typeof cause !== "object" || typeof cause.node_id !== "string" || typeof cause.instance_id !== "string" || typeof cause.reason !== "string") {
		throw new Error("malformed fail-fast record cause");
	}
	return rec as unknown as FailFastCancelRecord;
}

/** Publish the first fail-fast cancellation marker exclusively so concurrent failures do not clobber the root cause. */
export function publishFailFast(params: {
	sessionDir: string;
	taskId: string;
	token: string;
	cause: CauseRef & { instance_id: string };
}): boolean {
	const record: FailFastCancelRecord = {
		version: 1,
		task_id: params.taskId,
		token: params.token,
		cause: params.cause,
		recorded_at: new Date().toISOString(),
	};
	return publishExclusive(failFastPath(params.sessionDir), JSON.stringify(record, null, 2) + "\n");
}

export function readFailFast(sessionDir: string, taskId: string, token: string): FailFastCancelRecord | undefined {
	const path = failFastPath(sessionDir);
	if (!existsSync(path)) return undefined;
	try {
		return parseFailFastRecord(readJson<unknown>(path), taskId, token);
	} catch {
		return undefined;
	}
}

export interface OwnershipWaitDetail {
	node_id: string;
	instance_id: string;
	status: "running" | "uncertain";
	reason: string;
}

export interface OwnershipEvaluation {
	admitted: boolean;
	waiting_on: OwnershipWaitDetail[];
}

export function ownershipRecord(params: {
	identity: CompletionIdentity;
	state: OwnershipAdmissionRecord["state"];
	write_paths?: string[];
	read_paths?: string[];
	waiting_for?: string[];
	admitted_at?: string;
	released_at?: string;
	updated_at?: string;
}): OwnershipAdmissionRecord {
	return {
		version: 1,
		identity: params.identity,
		state: params.state,
		write_paths: params.write_paths ?? [],
		read_paths: params.read_paths ?? [],
		waiting_for: params.waiting_for ?? [],
		...(params.admitted_at ? { admitted_at: params.admitted_at } : {}),
		...(params.released_at ? { released_at: params.released_at } : {}),
		updated_at: params.updated_at ?? new Date().toISOString(),
	};
}

/**
 * Evaluate whether every earlier conflicting writer has reached a durable outcome that releases ownership.
 * Never releases a conflicting writer solely because its heartbeat disappeared when execution remains uncertain.
 */
export function evaluateOwnershipDependencies(params: {
	sessionDir: string;
	taskId: string;
	token?: string;
	waitingFor: string[];
	roster?: Array<{ instance_id: string; node_id: string; persona_name: string }>;
	nowMs?: number;
	staleMs?: number;
}): OwnershipEvaluation {
	const { sessionDir, taskId, token, waitingFor, roster, nowMs = Date.now(), staleMs = 10 * 60_000 } = params;
	const waiting_on: OwnershipWaitDetail[] = [];
	for (const predInst of waitingFor) {
		const member = roster?.find(item => item.instance_id === predInst);
		const predNode = member?.node_id ?? predInst;
		const expected: CompletionExpectation = {
			run_id: taskId,
			instance_id: predInst,
			node_id: member?.node_id,
			persona_name: member?.persona_name,
		};

		const resFile = resultPath(sessionDir, predInst);
		if (existsSync(resFile)) {
			try {
				parseCompletion(readJson<unknown>(resFile), expected);
				continue; // Valid durable result settles the writer's execution.
			} catch (error) {
				waiting_on.push({
					node_id: predNode,
					instance_id: predInst,
					status: "uncertain",
					reason: `unusable result file (${errorMessage(error)})`,
				});
				continue;
			}
		}

		const dispFile = dispositionPath(sessionDir, predInst);
		if (existsSync(dispFile)) {
			try {
				const disp = parseDisposition(readJson<unknown>(dispFile), expected);
				if (disp.state === "blocked" || disp.state === "skipped" || disp.state === "cancelled") {
					continue; // Cleanly never-executed or cancelled node holds no active writer.
				}
				waiting_on.push({
					node_id: predNode,
					instance_id: predInst,
					status: "uncertain",
					reason: disp.reason,
				});
				continue;
			} catch (error) {
				waiting_on.push({
					node_id: predNode,
					instance_id: predInst,
					status: "uncertain",
					reason: `unusable disposition file (${errorMessage(error)})`,
				});
				continue;
			}
		}

		// No durable result or terminal disposition: execution may still be running or uncertain.
		const errFile = join(sessionDir, `${predInst}.error.json`);
		if (existsSync(errFile)) {
			let msg = "worker recorded an error without a durable outcome";
			try { msg = String(readJson<{ error?: unknown }>(errFile).error ?? msg); } catch { /* keep generic */ }
			waiting_on.push({ node_id: predNode, instance_id: predInst, status: "uncertain", reason: msg });
			continue;
		}
		const rdyFile = readyPath(sessionDir, predInst);
		if (existsSync(rdyFile)) {
			try {
				const ready = readJson<WorkerReady>(rdyFile);
				if (!processAlive(ready)) {
					waiting_on.push({
						node_id: predNode,
						instance_id: predInst,
						status: "uncertain",
						reason: "process exited without recording a durable outcome",
					});
					continue;
				}
			} catch { /* ignore unreadable ready */ }
		}
		const progFile = join(sessionDir, `${predInst}.progress.json`);
		if (existsSync(progFile)) {
			try {
				const prog = readJson<{ token?: string; updated_at?: number }>(progFile);
				if ((!token || prog.token === token) && Number.isFinite(prog.updated_at) && nowMs - prog.updated_at! > staleMs) {
					waiting_on.push({
						node_id: predNode,
						instance_id: predInst,
						status: "uncertain",
						reason: "heartbeat disappeared while execution remains uncertain",
					});
					continue;
				}
			} catch { /* ignore unreadable progress */ }
		}
		waiting_on.push({
			node_id: predNode,
			instance_id: predInst,
			status: "running",
			reason: "conflicting writer has not finished",
		});
	}
	return { admitted: waiting_on.length === 0, waiting_on };
}
