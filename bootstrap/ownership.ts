/**
 * Independent team execution policies, shared-cwd read/write ownership declarations,
 * deterministic conflict serialization, and durable ownership admission helpers.
 *
 * Shared-cwd ownership is an advisory scheduling contract unless backed by external
 * enforcement or separate workspaces; path declarations are never a filesystem sandbox.
 */
import { latestReviewAttempt } from "./handoff.ts";
import { attemptClaimedOrStarted, attemptKey, attemptNumber, readFinalization, readLoopTransition, reviewLoopFor, type ReviewPlan } from "./review-loop.ts";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
	COLLABORATION_MODES, FAILURE_POLICIES, WORKSPACE_STRATEGY,
	type CauseRef, type CollaborationMode, type FailurePolicy, type ResolvedCollaborationMode, type WorkspaceStrategy,
} from "./outcomes.ts";
import {
	assertIdentityMatches, commandProcessGroupPath, dispositionPath, errorMessage, expectedResultVersion, parseCommandProcessGroupRecord, parseCompletion, parseDisposition, parseWorkerReady, pathEntryExists, processAlive, processGroupAlive, publishExclusive, readJson, readRegularJsonNoSymlink, readyPath, resultPath,
	type CompletionExpectation, type CompletionIdentity, type NodeKind, type Topology,
} from "./session-store.ts";

export { COLLABORATION_MODES, FAILURE_POLICIES, WORKSPACE_STRATEGY };
export type { CollaborationMode, FailurePolicy, ResolvedCollaborationMode, WorkspaceStrategy };

export const OWNERSHIP_RECORD_VERSION = 1;
const READABLE_OWNERSHIP_VERSIONS = [1];

export type OwnershipState = "waiting" | "admitted" | "released";
export type OwnershipStatus = OwnershipState | "held_uncertain";

export interface OwnershipAdmissionRecord {
	version: 1;
	identity: CompletionIdentity;
	state: OwnershipState;
	write_paths: string[];
	read_paths: string[];
	waiting_for: string[];
	/** True once the worker's startup_message arrived while queued, so reload does not lose the trigger. */
	startup_seen?: boolean;
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
const ALPHA_FILE_EXT = /\.([a-zA-Z][a-zA-Z0-9]{0,9})$/;

/**
 * Resolve symlinks for the deepest existing ancestor of `targetPath` and re-attach remaining
 * non-existent segments so symlinked project roots and symlinked subtrees normalize consistently.
 */
function resolveExistingPrefix(targetPath: string): string {
	let current = resolve(targetPath);
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		suffix.push(posix.basename(current.split(sep).join("/")));
		current = parent;
	}
	let base = current;
	if (existsSync(current)) {
		try { base = realpathSync(current); } catch { base = current; }
	}
	return suffix.length ? join(base, ...suffix.reverse()) : base;
}

/**
 * Normalize a declared read/write ownership path relative to `projectCwd` using POSIX separators.
 * Resolves existing symlink prefixes; rejects empty strings, NUL characters, and paths escaping `projectCwd`.
 */
export function normalizeOwnershipPath(projectCwd: string, rawPath: string, fieldLabel: string): string {
	if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
		throw new Error(`${fieldLabel} entries must be non-empty strings without NUL characters`);
	}
	const trimmed = rawPath.trim().replaceAll("\\", "/");
	if (WHOLE_PROJECT_TOKENS.has(trimmed)) return ".";
	const realProject = resolveExistingPrefix(projectCwd);
	const hasGlob = GLOB_CHARS.test(trimmed);
	if (!hasGlob) {
		const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(realProject, trimmed);
		const resolved = resolveExistingPrefix(candidate);
		const rel = relative(realProject, resolved);
		if (rel === "") return ".";
		if (rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`${fieldLabel} "${rawPath}" escapes project_cwd`);
		}
		const normalized = rel.split(sep).join("/").replace(/\/+$/, "");
		if (!normalized || WHOLE_PROJECT_TOKENS.has(normalized)) return ".";
		return normalized;
	}
	// Glob path: resolve symlinked static directory prefix before the first wildcard segment.
	const parts = trimmed.split("/");
	const prefixParts: string[] = [];
	let globIdx = parts.length;
	for (let i = 0; i < parts.length; i++) {
		if (GLOB_CHARS.test(parts[i])) {
			globIdx = i;
			break;
		}
		prefixParts.push(parts[i]);
	}
	const globSuffix = parts.slice(globIdx).join("/");
	const prefixRaw = prefixParts.join("/");
	let prefixRel = "";
	if (prefixRaw) {
		const candidatePrefix = isAbsolute(prefixRaw) ? resolve(prefixRaw) : resolve(realProject, prefixRaw);
		const resolvedPrefix = resolveExistingPrefix(candidatePrefix);
		prefixRel = relative(realProject, resolvedPrefix);
		if (prefixRel.startsWith("..") || isAbsolute(prefixRel)) {
			throw new Error(`${fieldLabel} "${rawPath}" escapes project_cwd`);
		}
	}
	const joined = [prefixRel.split(sep).join("/"), globSuffix].filter(Boolean).join("/").replace(/\/+$/, "");
	if (!joined || WHOLE_PROJECT_TOKENS.has(joined)) return ".";
	return joined;
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

function expandBraces(pattern: string, limit = 64): string[] {
	const queue = [pattern];
	const out: string[] = [];
	while (queue.length && out.length < limit) {
		const current = queue.shift()!;
		const match = current.match(/\{([^{}]+)\}/);
		if (!match || match.index === undefined) {
			out.push(current);
			continue;
		}
		const before = current.slice(0, match.index);
		const after = current.slice(match.index + match[0].length);
		const alts = match[1].split(",");
		for (const alt of alts) {
			if (queue.length + out.length >= limit) break;
			queue.push(`${before}${alt}${after}`);
		}
	}
	return out.length ? out : [pattern];
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

export function globToRegExp(pattern: string): RegExp {
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
		} else if (ch === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close > i + 1) {
				let body = pattern.slice(i + 1, close);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				re += `[${body}]`;
				i = close;
			} else {
				re += "\\[";
			}
		} else if ("\\^$.|+(){}".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	re += "$";
	return new RegExp(re);
}

export function canGlobMatchDescendant(gSegs: string[], cSegs: string[]): boolean {
	const memo = new Map<string, boolean>();
	const visit = (gi: number, ci: number): boolean => {
		const key = `${gi}:${ci}`;
		if (memo.has(key)) return memo.get(key)!;
		let result = false;
		if (ci === cSegs.length) {
			// True when the glob still has segments to match inside `concrete` (or ended in `**`).
			result = gi < gSegs.length || (gi > 0 && gSegs[gi - 1] === "**");
		} else if (gi < gSegs.length) {
			if (gSegs[gi] === "**") {
				result = visit(gi + 1, ci) || visit(gi, ci + 1);
			} else if (gSegs[gi].includes("**")) {
				result = true;
			} else if (globToRegExp(gSegs[gi]).test(cSegs[ci])) {
				result = visit(gi + 1, ci + 1);
			}
		}
		memo.set(key, result);
		return result;
	};
	return visit(0, 0);
}

function globOverlapsConcrete(globPattern: string, concrete: string): boolean {
	if (globPattern === "." || concrete === ".") return true;
	for (const alt of expandBraces(globPattern)) {
		const prefix = staticPrefix(alt);
		if (prefix === concrete || prefix.startsWith(`${concrete}/`)) return true;
		if (prefix !== "." && !concrete.startsWith(`${prefix}/`)) continue;
		if (globToRegExp(alt).test(concrete)) return true;
		const cExt = posix.basename(concrete).match(ALPHA_FILE_EXT)?.[1];
		if (!cExt && canGlobMatchDescendant(alt.split("/"), concrete.split("/"))) return true;
	}
	return false;
}

/** Whether two normalized ownership paths/scopes can touch the same filesystem target. */
export function pathsOverlap(a: string, b: string): boolean {
	if (a === "." || b === ".") return true;
	const aAlts = expandBraces(a);
	const bAlts = expandBraces(b);
	for (const altA of aAlts) {
		for (const altB of bAlts) {
			const aGlob = GLOB_CHARS.test(altA);
			const bGlob = GLOB_CHARS.test(altB);
			if (!aGlob && !bGlob) {
				if (exactOrParentOverlap(altA, altB)) return true;
			} else if (aGlob && !bGlob) {
				if (globOverlapsConcrete(altA, altB)) return true;
			} else if (!aGlob && bGlob) {
				if (globOverlapsConcrete(altB, altA)) return true;
			} else {
				const prefixA = staticPrefix(altA);
				const prefixB = staticPrefix(altB);
				if (!exactOrParentOverlap(prefixA, prefixB)) continue;
				const extA = posix.extname(altA);
				const extB = posix.extname(altB);
				if (extA && extB && !GLOB_CHARS.test(extA) && !GLOB_CHARS.test(extB) && extA !== extB) continue;
				return true;
			}
		}
	}
	return false;
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
	assertIdentityMatches(rec.identity, expected, "ownership");
	if (!["waiting", "admitted", "released"].includes(rec.state as string)) {
		throw new Error("malformed ownership record: invalid state");
	}
	if (!isStringArray(rec.write_paths) || !isStringArray(rec.read_paths) || !isStringArray(rec.waiting_for) || typeof rec.updated_at !== "string") {
		throw new Error("malformed ownership record");
	}
	if (rec.startup_seen !== undefined && typeof rec.startup_seen !== "boolean") {
		throw new Error("malformed ownership record: invalid startup_seen");
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
	const published = publishExclusive(failFastPath(params.sessionDir), JSON.stringify(record, null, 2) + "\n");
	if (!published) {
		const existing = readFailFast(params.sessionDir, params.taskId, params.token);
		if (existing.error) throw new Error(existing.error);
		if (!existing.record) throw new Error("fail-fast record disappeared after exclusive publication lost");
	}
	return published;
}

export function readFailFast(sessionDir: string, taskId: string, token: string): { record?: FailFastCancelRecord; error?: string } {
	const path = failFastPath(sessionDir);
	try {
		if (!pathEntryExists(path)) return {};
		return { record: parseFailFastRecord(readRegularJsonNoSymlink(path), taskId, token) };
	} catch (error) {
		return { error: `unusable fail-fast record: ${errorMessage(error)}` };
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
	state: OwnershipState;
	write_paths?: string[];
	read_paths?: string[];
	waiting_for?: string[];
	startup_seen?: boolean;
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
		...(params.startup_seen ? { startup_seen: true } : {}),
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
	topology?: Topology;
	reviewPlan?: ReviewPlan;
	instanceId?: string;
	roster?: Array<{ instance_id: string; node_id: string; persona_name: string; kind?: NodeKind; command?: string; args?: string[]; working_directory?: string }>;
	nowMs?: number;
	staleMs?: number;
}): OwnershipEvaluation {
	const { sessionDir, taskId, token, waitingFor, roster, topology, reviewPlan, instanceId, nowMs = Date.now(), staleMs = 10 * 60_000 } = params;
	const expectedVersion = expectedResultVersion({ topology, review_plan: reviewPlan, roster });
	const waiting_on: OwnershipWaitDetail[] = [];
	for (const predInst of waitingFor) {
		const member = roster?.find(item => item.instance_id === predInst);
		const predNode = member?.node_id ?? predInst;
		const expected: CompletionExpectation = {
			run_id: taskId,
			instance_id: predInst,
			node_id: member?.node_id,
			persona_name: member?.persona_name,
			...(member?.kind ? { kind: member.kind } : {}),
			...(member?.kind === "command" ? { command: member.command, args: member.args, working_directory: member.working_directory } : {}),
			...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
		};

		const loop = reviewLoopFor(reviewPlan, predInst);
		const withinLoop = !!instanceId && loop?.members.includes(instanceId);
		let finalization: ReturnType<typeof readFinalization>;
		if (loop && !withinLoop) {
			try {
				finalization = readFinalization(sessionDir, taskId, loop, predInst, topology);
				if (finalization && predInst !== loop.reviewer) {
					const finAttempt = attemptNumber(finalization.attempt_id);
					if (readLoopTransition(sessionDir, taskId, predInst, finAttempt)?.winner === "revision" ||
						attemptClaimedOrStarted(sessionDir, predInst, finAttempt + 1)) {
						finalization = undefined;
					}
				}
			} catch (error) {
				waiting_on.push({ node_id: predNode, instance_id: predInst, status: "uncertain", reason: errorMessage(error) });
				continue;
			}
		}
		const activeAttempt = finalization
			? attemptNumber(finalization.attempt_id)
			: reviewPlan ? latestReviewAttempt({ dir: sessionDir, runId: taskId, plan: reviewPlan, instance: predInst, node: predNode }).number : 1;
		const key = attemptKey(reviewPlan, predInst, activeAttempt);
		const resFile = resultPath(sessionDir, key);
		if ((!loop || withinLoop || finalization) && existsSync(resFile)) {
			try {
				parseCompletion(readJson<unknown>(resFile), { ...expected, ...(reviewPlan ? { attempt_id: key } : {}) });
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

		const dispFile = dispositionPath(sessionDir, key);
		if (existsSync(dispFile)) {
			try {
				const disp = parseDisposition(readJson<unknown>(dispFile), { ...expected, ...(reviewPlan ? { attempt_id: key } : {}) });
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
		const errFile = join(sessionDir, `${key}.error.json`);
		if (existsSync(errFile)) {
			let msg = "worker recorded an error without a durable outcome";
			try { msg = String(readJson<{ error?: unknown }>(errFile).error ?? msg); } catch { /* keep generic */ }
			waiting_on.push({ node_id: predNode, instance_id: predInst, status: "uncertain", reason: msg });
			continue;
		}
		const pgFile = commandProcessGroupPath(sessionDir, key);
		if (existsSync(pgFile)) {
			try {
				const pg = parseCommandProcessGroupRecord(readJson<unknown>(pgFile), { ...expected, ...(reviewPlan ? { attempt_id: key } : {}) });
				if (processGroupAlive(pg.pgid, pg.start_time)) {
					waiting_on.push({
						node_id: predNode,
						instance_id: predInst,
						status: "running",
						reason: "conflicting command process group is still running",
					});
					continue;
				}
			} catch (error) {
				waiting_on.push({
					node_id: predNode,
					instance_id: predInst,
					status: "uncertain",
					reason: `unusable command process group record (${errorMessage(error)})`,
				});
				continue;
			}
		}
		const rdyFile = readyPath(sessionDir, predInst);
		if (existsSync(rdyFile)) {
			try {
				const ready = parseWorkerReady(readJson<unknown>(rdyFile));
				if (!processAlive(ready)) {
					let parkedWithResult = false;
					if (loop && !withinLoop && !finalization) {
						let latestRes = 0;
						for (let n = 1; n <= loop.max_revisions + 1; n++) {
							if (existsSync(resultPath(sessionDir, `${predInst}.${n}`))) latestRes = n;
						}
						if (latestRes > 0 && readLoopTransition(sessionDir, taskId, predInst, latestRes)?.winner !== "revision") {
							const nextPrefix = `${predInst}.${latestRes + 1}.`;
							const claimedNext = readdirSync(sessionDir).some(name => name.startsWith(nextPrefix) && name.endsWith(".handoff.json"));
							if (!claimedNext) parkedWithResult = true;
						}
					}
					if (!parkedWithResult) {
						waiting_on.push({
							node_id: predNode,
							instance_id: predInst,
							status: "uncertain",
							reason: "process exited without recording a durable outcome",
						});
						continue;
					}
					waiting_on.push({
						node_id: predNode,
						instance_id: predInst,
						status: "running",
						reason: "loop member is parked awaiting finalization",
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
