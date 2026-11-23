/** Deterministic path-based risk lanes (`contained`, `wide`, `closed`) derived from project config and loop-body snapshots. */
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Text } from "./contracts.ts";
import { globToRegExp, pathsOverlap } from "./ownership.ts";
import { requiredChecksOf, verifyEvidence } from "./evidence.ts";
import type { CauseRef, EvidenceStatus } from "./outcomes.ts";
import { attemptKey, type ReviewPlan } from "./review-plan.ts";
import { assertNoSymlinkPath, errorMessage, isRecord, pathEntryExists, publishExclusive, readRegularJsonNoSymlink } from "./session-store.ts";
import { diffSnapshots, snapshotScope, type RepoSnapshot, type SnapshotFileCacheEntry } from "./verification.ts";
import type { PlannedDecision } from "./decisions.ts";
import type { InterventionPolicy } from "./intervention.ts";

export type RiskLane = "contained" | "wide" | "closed";

export interface LaneConfig {
	contained: string[];
	closed: string[];
}

export interface RiskLaneAssessment {
	lane: RiskLane;
	deciding_paths: string[];
	requirement: string;
	changed_paths?: string[];
	unknown_scope?: boolean;
	reason?: string;
	error?: string;
}

export interface LaneSnapshotRecord {
	version: 1;
	kind: "before" | "after";
	run_id: string;
	reviewer: string;
	node_id: string;
	attempt: number;
	project_cwd: string;
	snapshot_sha256: string;
	snapshot: RepoSnapshot;
	symlinks?: Record<string, string>;
}

const LANE_REQUIREMENTS: Record<RiskLane, string> = {
	contained: "reviewer approval",
	wide: "declared required checks passing and current",
	closed: "recorded human approval choice for this attempt",
};

const GLOB_CHARS = /[*?[\]{}]/;

export const MAX_BRACE_EXPANSIONS = 64;
export const EXCLUDED_SNAPSHOT_DIRS = [".git", "node_modules", ".pi/agent-sessions"] as const;

function excludedSnapshotDir(alt: string): string | undefined {
	const segs = alt.split("/");
	const first = globToRegExp(segs[0]);
	if (first.test(".git") && !segs[0].includes("**") && !first.test("src") && !first.test(".github")) {
		return ".git";
	}
	if (first.test("node_modules") && !segs[0].includes("**") && !first.test("src") && !first.test("node_modules_custom")) {
		return "node_modules";
	}
	if (segs.length >= 2 && first.test(".pi") && !segs[0].includes("**") && !first.test("src")) {
		const second = globToRegExp(segs[1]);
		if (second.test("agent-sessions") && !segs[1].includes("**") && !second.test("agents") && !second.test("skills")) {
			return ".pi/agent-sessions";
		}
	}
	return undefined;
}

function validateGlobSyntax(pattern: string, label: string): void {
	let inBracket = false;
	let braceDepth = 0;
	let braceStart = -1;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "[" && !inBracket) {
			inBracket = true;
			if (pattern[i + 1] === "]") {
				throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (empty character class)`);
			}
			continue;
		}
		if (ch === "]" && inBracket) {
			inBracket = false;
			continue;
		}
		if (inBracket) continue;
		if (ch === "{") {
			if (braceDepth > 0) {
				throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (nested braces are not supported)`);
			}
			braceDepth = 1;
			braceStart = i;
		} else if (ch === "}") {
			if (braceDepth === 0) {
				throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (unmatched "}")`);
			}
			if (i === braceStart + 1) {
				throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (empty "{}")`);
			}
			braceDepth = 0;
		}
	}
	if (inBracket) throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (unclosed "[")`);
	if (braceDepth !== 0) throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} (unclosed "{")`);
	const expanded = expandBraces(pattern, label);
	const excludedHits = expanded.map(excludedSnapshotDir);
	if (excludedHits.every((dir): dir is string => Boolean(dir))) {
		throw new Error(`${label}: invalid glob ${JSON.stringify(pattern)} targets excluded snapshot directory (${[...new Set(excludedHits)].join(", ")})`);
	}
	// Verify regex compilation succeeds for all brace alternatives.
	for (const alt of expanded) {
		globToRegExp(alt);
	}
}

function normalizeLaneGlob(raw: unknown, label: string): string {
	if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
		throw new Error(`${label} must be a non-empty string without NUL characters`);
	}
	const slashNormalized = raw.trim().replaceAll("\\", "/");
	if (slashNormalized.startsWith("/") || /^[A-Za-z]:\//.test(slashNormalized)) {
		throw new Error(`${label} (${JSON.stringify(raw)}) must be project-relative`);
	}
	let stripped = slashNormalized;
	while (stripped.startsWith("./")) stripped = stripped.slice(2);
	if (!stripped || stripped === ".") {
		throw new Error(`${label} (${JSON.stringify(raw)}) is an ambiguous whole-project token; use "**" to match all paths`);
	}
	const trailingSlash = stripped.endsWith("/");
	const segmentSource = trailingSlash ? stripped.slice(0, -1) : stripped;
	const segments = segmentSource.split("/");
	if (segments.some(seg => seg === "")) {
		throw new Error(`${label} (${JSON.stringify(raw)}) cannot contain empty path segments`);
	}
	if (segments.some(seg => seg === "..")) {
		throw new Error(`${label} (${JSON.stringify(raw)}) cannot contain path traversal ("..")`);
	}
	let pattern = stripped;
	if (trailingSlash) {
		const withoutTrailing = segmentSource;
		pattern = withoutTrailing === "**" || withoutTrailing.endsWith("/**") ? withoutTrailing : `${withoutTrailing}/**`;
	}
	validateGlobSyntax(pattern, label);
	return pattern;
}

/** Validate and normalize `lanes` config from project `.pi/bootstrap.json`. Returns `undefined` when no globs are configured. */
export function validateLaneConfig(path: string, raw: unknown): LaneConfig | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new Error(`${path}: "lanes" must be an object`);
	for (const key of Object.keys(raw)) {
		if (key !== "contained" && key !== "closed") {
			throw new Error(`${path}: "lanes.${key}" is not a recognized key`);
		}
	}
	const readList = (key: "contained" | "closed"): string[] => {
		const value = raw[key];
		if (value === undefined) return [];
		if (!Array.isArray(value)) throw new Error(`${path}: "lanes.${key}" must be an array of glob strings`);
		const seen = new Set<string>();
		const out: string[] = [];
		for (let i = 0; i < value.length; i++) {
			const norm = normalizeLaneGlob(value[i], `${path}: "lanes.${key}[${i}]"`);
			if (!seen.has(norm)) {
				seen.add(norm);
				out.push(norm);
			}
		}
		return out;
	};
	const contained = readList("contained");
	const closed = readList("closed");
	if (contained.length === 0 && closed.length === 0) return undefined;
	return { contained, closed };
}

/** Validate a persisted `LaneConfig` in a manifest or worker config. Requires at least one configured glob. */
export function parseLaneConfig(raw: unknown): LaneConfig {
	const validated = validateLaneConfig("persisted lanes", raw);
	if (!validated) throw new Error("Persisted lanes configuration must declare at least one glob");
	return validated;
}

function expandBraces(pattern: string, label?: string, limit = MAX_BRACE_EXPANSIONS): string[] {
	const queue = [pattern];
	const out: string[] = [];
	while (queue.length) {
		const current = queue.shift()!;
		const match = current.match(/\{([^{}]+)\}/);
		if (!match || match.index === undefined) {
			out.push(current);
			continue;
		}
		const before = current.slice(0, match.index);
		const after = current.slice(match.index + match[0].length);
		for (const alt of match[1].split(",")) {
			if (alt === "") {
				throw new Error(`${label ?? "lane glob"}: invalid glob ${JSON.stringify(pattern)} (empty brace alternative)`);
			}
			if (queue.length + out.length + 1 > limit) {
				throw new Error(`${label ?? "lane glob"}: invalid glob ${JSON.stringify(pattern)} exceeds maximum brace expansions (${limit})`);
			}
			queue.push(`${before}${alt}${after}`);
		}
	}
	return out.length ? out : [pattern];
}

/** Case-sensitive POSIX relative path matching. */
export function matchesLaneGlob(relPosix: string, pattern: string): boolean {
	if (!GLOB_CHARS.test(pattern)) {
		return relPosix === pattern || relPosix.startsWith(`${pattern}/`);
	}
	for (const alt of expandBraces(pattern)) {
		if (globToRegExp(alt).test(relPosix)) return true;
	}
	return false;
}

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

function resolveProjectRoot(projectCwd: string): string {
	if (existsSync(projectCwd)) {
		try { return realpathSync(projectCwd); } catch { /* fall back */ }
	}
	return resolve(projectCwd);
}

function normalizeCandidatePath(
	rawPath: string,
	realProject: string,
): { ok: true; relPosix: string } | { ok: false; reason: string } {
	if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
		return { ok: false, reason: `Invalid changed path ${JSON.stringify(rawPath)}` };
	}
	const slash = rawPath.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
	if (slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) {
		const resolved = resolveExistingPrefix(slash);
		const rel = relative(realProject, resolved);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			return { ok: false, reason: `Changed path ${JSON.stringify(rawPath)} is outside project_cwd` };
		}
		return { ok: true, relPosix: rel.split(sep).join("/").replace(/\/+$/, "") };
	}
	const stripped = slash.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
	if (!stripped || stripped === ".") {
		return { ok: false, reason: `Ambiguous changed path ${JSON.stringify(rawPath)}` };
	}
	const segments = stripped.split("/");
	if (segments.some(seg => seg === "..")) {
		return { ok: false, reason: `Changed path ${JSON.stringify(rawPath)} contains path traversal` };
	}
	return { ok: true, relPosix: stripped };
}

function inspectSymlinkTarget(
	relPosix: string,
	realProject: string,
	recordedTarget?: string,
): { escapes: boolean; resolvedRel?: string; reason?: string } {
	const full = join(realProject, ...relPosix.split("/"));
	let linkTarget = recordedTarget;
	if (linkTarget === undefined) {
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) {
				linkTarget = readlinkSync(full);
			}
		} catch { /* deleted or unreachable */ }
	}
	if (linkTarget === undefined) {
		// Also check whether an existing intermediate directory is a symlink escaping project_cwd.
		const parts = relPosix.split("/");
		for (let i = 1; i < parts.length; i++) {
			const prefixPath = join(realProject, ...parts.slice(0, i));
			try {
				const st = lstatSync(prefixPath);
				if (st.isSymbolicLink()) {
					const realDir = resolveExistingPrefix(prefixPath);
					const relDir = relative(realProject, realDir);
					if (relDir.startsWith("..") || isAbsolute(relDir)) {
						return { escapes: true, reason: `Path ${relPosix} traverses symlink ${parts.slice(0, i).join("/")} escaping project_cwd` };
					}
				}
			} catch { break; }
		}
		return { escapes: false };
	}
	const rawResolved = isAbsolute(linkTarget)
		? resolveExistingPrefix(linkTarget)
		: resolveExistingPrefix(resolve(dirname(full), linkTarget));
	const rel = relative(realProject, rawResolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { escapes: true, reason: `Symlink ${relPosix} -> ${linkTarget} escapes project_cwd` };
	}
	const resolvedRel = rel.split(sep).join("/").replace(/\/+$/, "");
	return { escapes: false, ...(resolvedRel && resolvedRel !== relPosix ? { resolvedRel } : {}) };
}

export type ChangedPathEntry = string | { path: string; oldPath?: string };

/** Deterministically classify changed paths (including renames, deletions, and symlink/traversal checks) against `lanes`. */
export function assessChangedPaths(
	lanes: LaneConfig,
	entries: ReadonlyArray<ChangedPathEntry>,
	projectCwd: string,
	options: {
		unknownScope?: boolean;
		unknownReason?: string;
		error?: string;
		symlinks?: Record<string, string>;
	} = {},
): RiskLaneAssessment {
	const realProject = resolveProjectRoot(projectCwd);
	const rawPaths: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			rawPaths.push(entry);
		} else {
			if (entry.oldPath !== undefined) rawPaths.push(entry.oldPath);
			rawPaths.push(entry.path);
		}
	}

	let unknownScope = Boolean(options.unknownScope);
	const reasons: string[] = options.unknownReason ? [options.unknownReason] : [];
	const normalizedChanged = new Set<string>();
	const closedPaths = new Set<string>();
	const widePaths = new Set<string>();
	const containedPaths = new Set<string>();

	const classifyOne = (relPosix: string) => {
		if (lanes.closed.some(glob => matchesLaneGlob(relPosix, glob))) {
			closedPaths.add(relPosix);
			return;
		}
		if (lanes.contained.some(glob => matchesLaneGlob(relPosix, glob))) {
			containedPaths.add(relPosix);
			return;
		}
		widePaths.add(relPosix);
	};

	for (const raw of rawPaths) {
		const norm = normalizeCandidatePath(raw, realProject);
		if (!norm.ok) {
			unknownScope = true;
			reasons.push(norm.reason);
			continue;
		}
		normalizedChanged.add(norm.relPosix);
		const symlink = inspectSymlinkTarget(norm.relPosix, realProject, options.symlinks?.[norm.relPosix]);
		if (symlink.escapes) {
			unknownScope = true;
			if (symlink.reason) reasons.push(symlink.reason);
			// Even an escaping symlink path that literally matches a closed glob stays closed.
			if (lanes.closed.some(glob => matchesLaneGlob(norm.relPosix, glob))) {
				closedPaths.add(norm.relPosix);
			}
			continue;
		}
		classifyOne(norm.relPosix);
		if (symlink.resolvedRel) {
			normalizedChanged.add(symlink.resolvedRel);
			classifyOne(symlink.resolvedRel);
		}
	}

	let lane: RiskLane;
	let deciding_paths: string[];
	if (closedPaths.size > 0 || (unknownScope && lanes.closed.length > 0)) {
		lane = "closed";
		deciding_paths = [...closedPaths].sort();
	} else if (widePaths.size > 0 || unknownScope) {
		lane = "wide";
		deciding_paths = [...widePaths].sort();
	} else {
		lane = "contained";
		deciding_paths = [...containedPaths].sort();
	}

	const reason = reasons.length > 0
		? [...new Set(reasons)].join("; ")
		: normalizedChanged.size === 0 && !unknownScope
		? "No files changed by loop body"
		: undefined;

	return {
		lane,
		deciding_paths,
		requirement: LANE_REQUIREMENTS[lane],
		changed_paths: [...normalizedChanged].sort(),
		...(unknownScope ? { unknown_scope: true } : {}),
		...(reason ? { reason } : {}),
		...(options.error ? { error: options.error } : {}),
	};
}

export const laneBeforePath = (sessionDir: string, reviewerInstance: string, attempt: number): string =>
	join(sessionDir, `${reviewerInstance}.${attempt}.lane-before.json`);

export const laneAfterPath = (sessionDir: string, reviewerInstance: string, attempt: number): string =>
	join(sessionDir, `${reviewerInstance}.${attempt}.lane-after.json`);

function collectSymlinkTargets(snapshot: RepoSnapshot): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const relPosix of Object.keys(snapshot.files)) {
		const full = join(snapshot.project_cwd, ...relPosix.split("/"));
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) {
				out[relPosix] = readlinkSync(full);
			}
		} catch { /* ignore unreadable/disappeared file */ }
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Collect snapshot + symlinks in memory so callers can prepare an `after` snapshot before committing an outcome claim. */
export function prepareLaneSnapshot(params: {
	sessionDir: string;
	kind: "before" | "after";
	runId: string;
	reviewer: string;
	nodeId: string;
	attempt: number;
	projectCwd: string;
	durable?: boolean;
}): { path: string; record: LaneSnapshotRecord; durable?: boolean } {
	const path = params.kind === "before"
		? laneBeforePath(params.sessionDir, params.reviewer, params.attempt)
		: laneAfterPath(params.sessionDir, params.reviewer, params.attempt);
	const snapshot = snapshotScope(params.projectCwd);
	const symlinks = collectSymlinkTargets(snapshot);
	const record: LaneSnapshotRecord = {
		version: 1,
		kind: params.kind,
		run_id: params.runId,
		reviewer: params.reviewer,
		node_id: params.nodeId,
		attempt: params.attempt,
		project_cwd: snapshot.project_cwd,
		snapshot_sha256: sha256Text(canonicalJson(snapshot)),
		snapshot,
		...(symlinks ? { symlinks } : {}),
	};
	return { path, record, durable: params.durable };
}

/** Return true if an existing lane snapshot record matches the prepared snapshot's identity and working-tree contents. */
export function laneSnapshotMatches(existing: LaneSnapshotRecord, prepared: LaneSnapshotRecord): boolean {
	return existing.version === prepared.version
		&& existing.kind === prepared.kind
		&& existing.run_id === prepared.run_id
		&& existing.reviewer === prepared.reviewer
		&& existing.node_id === prepared.node_id
		&& existing.attempt === prepared.attempt
		&& existing.project_cwd === prepared.project_cwd
		&& existing.snapshot.complete === prepared.snapshot.complete
		&& existing.snapshot.scope_kind === prepared.snapshot.scope_kind
		&& existing.snapshot.reason === prepared.snapshot.reason
		&& canonicalJson(existing.snapshot.files) === canonicalJson(prepared.snapshot.files)
		&& canonicalJson(existing.symlinks ?? {}) === canonicalJson(prepared.symlinks ?? {});
}

/** Exclusively persist a previously prepared lane snapshot record. */
export function writePreparedLaneSnapshot(prepared: { path: string; record: LaneSnapshotRecord; durable?: boolean }): boolean {
	const published = publishExclusive(prepared.path, JSON.stringify(prepared.record, null, 2) + "\n", prepared.durable);
	if (published) return true;
	if (prepared.record.kind === "after") {
		const existing = readLaneSnapshotSafe(prepared.path, {
			kind: prepared.record.kind,
			runId: prepared.record.run_id,
			reviewer: prepared.record.reviewer,
			attempt: prepared.record.attempt,
			projectCwd: prepared.record.project_cwd,
		});
		if (existing.error || !existing.record || !laneSnapshotMatches(existing.record, prepared.record)) {
			throw new Error(existing.error ?? `Existing post-attempt risk-lane snapshot (${prepared.path}) does not match what the worker would write`);
		}
	}
	return false;
}

/** Capture and exclusively persist a working-tree snapshot for risk-lane derivation. */
export function captureLaneSnapshot(params: {
	sessionDir: string;
	kind: "before" | "after";
	runId: string;
	reviewer: string;
	nodeId: string;
	attempt: number;
	projectCwd: string;
	durable?: boolean;
}): { path: string; record: LaneSnapshotRecord; published: boolean } {
	const prepared = prepareLaneSnapshot(params);
	const published = writePreparedLaneSnapshot(prepared);
	return { path: prepared.path, record: prepared.record, published };
}

function validateRepoSnapshot(raw: unknown, label: string): RepoSnapshot {
	if (!isRecord(raw)) throw new Error(`${label} snapshot must be an object`);
	if (typeof raw.captured_at !== "string" || typeof raw.project_cwd !== "string" || typeof raw.complete !== "boolean") {
		throw new Error(`${label} snapshot is malformed`);
	}
	if (raw.scope_kind !== "declared" && raw.scope_kind !== "conservative" && raw.scope_kind !== "unknown") {
		throw new Error(`${label} snapshot has invalid scope_kind`);
	}
	if (!isRecord(raw.files)) throw new Error(`${label} snapshot files must be an object`);
	for (const [key, entry] of Object.entries(raw.files)) {
		if (!key || !isRecord(entry) || typeof entry.sha256 !== "string" || typeof entry.size !== "number") {
			throw new Error(`${label} snapshot has malformed file entry ${JSON.stringify(key)}`);
		}
	}
	return raw as unknown as RepoSnapshot;
}

export function readLaneSnapshotSafe(
	path: string,
	expected: { kind: "before" | "after"; runId: string; reviewer: string; attempt: number; projectCwd: string },
): { record?: LaneSnapshotRecord; missing?: true; error?: string } {
	const label = `${expected.kind} lane snapshot (${expected.reviewer}.${expected.attempt})`;
	try {
		assertNoSymlinkPath(path);
		if (!pathEntryExists(path)) return { missing: true };
		const raw = readRegularJsonNoSymlink<unknown>(path, label);
		if (!isRecord(raw)) throw new Error(`${label} must be an object`);
		if (raw.version !== 1) throw new Error(`Unsupported ${label} version ${JSON.stringify(raw.version)}`);
		if (raw.kind !== expected.kind) throw new Error(`${label} kind mismatch`);
		if (raw.run_id !== expected.runId || raw.reviewer !== expected.reviewer || raw.attempt !== expected.attempt) {
			throw new Error(`${label} identity mismatch`);
		}
		if (typeof raw.node_id !== "string" || !raw.node_id) throw new Error(`${label} missing node_id`);
		const expectedRoot = resolveProjectRoot(expected.projectCwd);
		if (raw.project_cwd !== expectedRoot && raw.project_cwd !== expected.projectCwd) {
			throw new Error(`${label} project_cwd mismatch`);
		}
		const snapshot = validateRepoSnapshot(raw.snapshot, label);
		if (typeof raw.snapshot_sha256 !== "string") {
			throw new Error(`${label} missing snapshot_sha256`);
		}
		if (raw.snapshot_sha256 !== sha256Text(canonicalJson(snapshot))) {
			throw new Error(`${label} snapshot digest mismatch`);
		}
		if (raw.symlinks !== undefined) {
			if (!isRecord(raw.symlinks) || Object.values(raw.symlinks).some(v => typeof v !== "string")) {
				throw new Error(`${label} symlinks must be a string map`);
			}
		}
		return { record: { ...(raw as unknown as LaneSnapshotRecord), snapshot } };
	} catch (error) {
		return { error: `Unreadable or invalid ${label}: ${errorMessage(error)}` };
	}
}

/**
 * Derive a decision attempt's risk lane from the loop-body baseline (`attempt 1 before`) and the post-attempt snapshot
 * (`attempt N after`, or live read-only `snapshotScope` when `liveIfNoAfterSnapshot` is true for an in-flight attempt).
 * Missing, incomplete, truncated, or unreadable snapshots fail closed (`closed` when `lanes.closed` is configured, else `wide`).
 */
export function assessRiskLane(params: {
	sessionDir: string;
	runId: string;
	projectCwd: string;
	lanes: LaneConfig;
	reviewerInstance: string;
	reviewerNodeId: string;
	attempt: number;
	liveIfNoAfterSnapshot: boolean;
	fileHashCache?: Map<string, SnapshotFileCacheEntry>;
}): RiskLaneAssessment {
	const { sessionDir, runId, projectCwd, lanes, reviewerInstance, reviewerNodeId, attempt, liveIfNoAfterSnapshot, fileHashCache } = params;
	const beforeRes = readLaneSnapshotSafe(laneBeforePath(sessionDir, reviewerInstance, 1), {
		kind: "before", runId, reviewer: reviewerInstance, attempt: 1, projectCwd,
	});
	// Also validate the attempt's own before-snapshot if present for attempt > 1 so tampered evidence never goes unreported.
	let attemptBeforeError: string | undefined;
	if (attempt > 1) {
		const attBefore = readLaneSnapshotSafe(laneBeforePath(sessionDir, reviewerInstance, attempt), {
			kind: "before", runId, reviewer: reviewerInstance, attempt, projectCwd,
		});
		if (attBefore.error) attemptBeforeError = attBefore.error;
	}

	const afterFile = laneAfterPath(sessionDir, reviewerInstance, attempt);
	const afterRes = readLaneSnapshotSafe(afterFile, {
		kind: "after", runId, reviewer: reviewerInstance, attempt, projectCwd,
	});

	let afterSnapshot: RepoSnapshot | undefined = afterRes.record?.snapshot;
	let afterSymlinks: Record<string, string> | undefined = afterRes.record?.symlinks;
	let afterMissingError: string | undefined;
	if (afterRes.missing) {
		if (liveIfNoAfterSnapshot) {
			try {
				afterSnapshot = snapshotScope(projectCwd, undefined, fileHashCache ? { fileHashCache } : undefined);
				afterSymlinks = collectSymlinkTargets(afterSnapshot);
			} catch (error) {
				afterMissingError = `Failed live risk-lane snapshot for ${reviewerNodeId}: ${errorMessage(error)}`;
			}
		} else {
			afterMissingError = `Missing post-attempt lane snapshot for ${reviewerNodeId} attempt ${attempt}`;
		}
	} else if (liveIfNoAfterSnapshot && afterRes.record) {
		try {
			const liveAfter = snapshotScope(projectCwd, undefined, fileHashCache ? { fileHashCache } : undefined);
			const liveSymlinks = collectSymlinkTargets(liveAfter);
			if (
				afterRes.record.snapshot.complete !== liveAfter.complete
				|| afterRes.record.snapshot.scope_kind !== liveAfter.scope_kind
				|| afterRes.record.snapshot.reason !== liveAfter.reason
				|| canonicalJson(afterRes.record.snapshot.files) !== canonicalJson(liveAfter.files)
				|| canonicalJson(afterRes.record.symlinks ?? {}) !== canonicalJson(liveSymlinks ?? {})
			) {
				afterMissingError = `Existing post-attempt lane snapshot for ${reviewerNodeId} attempt ${attempt} does not match live working tree`;
			}
		} catch (error) {
			afterMissingError = `Failed live risk-lane snapshot for ${reviewerNodeId}: ${errorMessage(error)}`;
		}
	}

	const errors = [beforeRes.error, attemptBeforeError, afterRes.error].filter((e): e is string => Boolean(e));
	const beforeSnap = beforeRes.record?.snapshot;
	const unknownReasons: string[] = [...errors];
	if (beforeRes.missing) unknownReasons.push(`Missing baseline lane snapshot for ${reviewerNodeId}`);
	if (afterMissingError) unknownReasons.push(afterMissingError);
	if (beforeSnap && (!beforeSnap.complete || beforeSnap.scope_kind !== "conservative")) {
		unknownReasons.push(beforeSnap.reason ?? `Baseline lane snapshot has ${beforeSnap.scope_kind} scope`);
	}
	if (afterSnapshot && (!afterSnapshot.complete || afterSnapshot.scope_kind !== "conservative")) {
		unknownReasons.push(afterSnapshot.reason ?? `Post-attempt lane snapshot has ${afterSnapshot.scope_kind} scope`);
	}

	const unknownScope = unknownReasons.length > 0;
	const changedPaths = beforeSnap && afterSnapshot
		? diffSnapshots(beforeSnap.files, afterSnapshot.files)
		: [];
	const mergedSymlinks: Record<string, string> = {
		...(beforeRes.record?.symlinks ?? {}),
		...(afterSymlinks ?? {}),
	};

	return assessChangedPaths(lanes, changedPaths, projectCwd, {
		unknownScope,
		unknownReason: unknownReasons.join("; ") || undefined,
		error: errors.join("; ") || undefined,
		symlinks: mergedSymlinks,
	});
}

/**
 * Emit planning warnings when `lanes.closed` is configured and a decision node whose loop body could touch
 * a closed path is not intervention-enabled for human approval.
 */
export function closedLanePlanningWarnings(
	nodes: ReadonlyArray<{ node_id: string; write_paths?: string[]; intervention?: InterventionPolicy }>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	lanes: LaneConfig | undefined,
	options: { factoryManaged: boolean },
): string[] {
	if (!lanes || lanes.closed.length === 0 || !decisions || decisions.size === 0) return [];
	const nodeById = new Map(nodes.map(node => [node.node_id, node]));
	const warnings: string[] = [];
	for (const [reviewerId, decision] of decisions) {
		const reviewerNode = nodeById.get(reviewerId);
		const canApproveByHuman = options.factoryManaged
			&& Boolean(reviewerNode?.intervention?.choices.some(choice => choice.route === "approve"));
		if (canApproveByHuman) continue;

		const overlappingPaths: string[] = [];
		let unrestrictedMember: string | undefined;
		for (const memberId of decision.loop_body) {
			const member = nodeById.get(memberId);
			if (!member) continue;
			const writes = member.write_paths ?? [];
			if (writes.length > 0) {
				for (const wp of writes) {
					for (const closedGlob of lanes.closed) {
						if (pathsOverlap(wp, closedGlob)) {
							overlappingPaths.push(`${memberId}:${wp}`);
						}
					}
				}
			} else {
				unrestrictedMember ??= memberId;
			}
		}

		if (overlappingPaths.length === 0 && !unrestrictedMember) continue;
		const scopeDetail = overlappingPaths.length > 0
			? `declared write_paths overlap closed globs (${[...new Set(overlappingPaths)].join(", ")})`
			: `loop member ${unrestrictedMember} has no write_paths restriction and could touch closed paths (${lanes.closed.join(", ")})`;
		const modeDetail = options.factoryManaged
			? (reviewerNode?.intervention
				? `has intervention without a route: "approve" choice`
				: `is not intervention-enabled`)
			: `is not intervention-enabled (standalone runs cannot request human approval)`;
		warnings.push(
			`Risk lane warning: decision node ${reviewerId} ${modeDetail}, yet its loop body (${decision.loop_body.join(" → ")}) ${scopeDetail}. Any closed-lane attempt will settle blocked without routing.`,
		);
	}
	return warnings;
}

/** Whether a decision node can obtain a recorded human approval choice at runtime. */
export function isDecisionInterventionEnabled(
	node: { factory_managed?: unknown; intervention?: InterventionPolicy } | undefined,
): boolean {
	return Boolean(node?.factory_managed) && Boolean(node?.intervention?.choices.some(choice => choice.route === "approve"));
}

/** Verify all declared `required_checks` across every member of a loop body against current project evidence. */
export function verifyLoopRequiredChecks(params: {
	sessionDir: string;
	projectCwd: string;
	taskId: string;
	loopMembers: ReadonlyArray<string>;
	reviewPlan?: ReviewPlan;
	attempt: number;
	selfInstanceId?: string;
	selfContract?: { required_checks?: string[]; output_contract?: { required_checks?: string[] } };
	upstreamContracts?: Record<string, { required_checks?: string[]; output_contract?: { required_checks?: string[] } }>;
}): { checks: Array<{ instance_id: string; check: string; status: EvidenceStatus; reason?: string }>; blockers: string[] } {
	const checks: Array<{ instance_id: string; check: string; status: EvidenceStatus; reason?: string }> = [];
	const blockers: string[] = [];
	for (const memberId of params.loopMembers) {
		const contract = memberId === params.selfInstanceId
			? (params.selfContract ?? params.upstreamContracts?.[memberId])
			: params.upstreamContracts?.[memberId];
		if (!contract) continue;
		const required = requiredChecksOf(contract);
		if (required.length === 0) continue;
		const recordKey = attemptKey(params.reviewPlan, memberId, params.attempt);
		const statuses = verifyEvidence(params.sessionDir, memberId, params.projectCwd, required, params.taskId, recordKey);
		for (const entry of statuses) {
			checks.push({ instance_id: memberId, ...entry });
			if (entry.status !== "passing") {
				blockers.push(`check "${entry.check}" on ${memberId} has ${entry.status} evidence${entry.reason ? ` (${entry.reason})` : ""}`);
			}
		}
	}
	return { checks, blockers };
}

/** Format the blocked reason and cause for a closed-lane decision node lacking human approval intervention. */
export function closedLaneBlockedDetails(nodeId: string, assessment: RiskLaneAssessment): { reason: string; causes: CauseRef[] } {
	const pathsText = assessment.deciding_paths.length > 0
		? assessment.deciding_paths.join(", ")
		: (assessment.reason ?? "unknown scope");
	const reason = `${nodeId} approval in closed risk lane (${pathsText}) cannot route because this decision node is not intervention-enabled for human approval`;
	return { reason, causes: [{ node_id: nodeId, state: "blocked", reason }] };
}

/** Single-line human-readable summary of a risk-lane assessment for status, request, and report views. */
export function formatRiskLaneSummary(riskLane: RiskLaneAssessment): string {
	if (riskLane.deciding_paths.length > 0) {
		const paths = riskLane.deciding_paths.join(", ");
		const scopeNote = riskLane.unknown_scope
			? `; unknown change scope${riskLane.reason ? ` (${riskLane.reason})` : ""}`
			: riskLane.error
			? `; snapshot error (${riskLane.error})`
			: "";
		return `${riskLane.lane} (paths: ${paths}; requires: ${riskLane.requirement}${scopeNote})`;
	}
	const why = riskLane.unknown_scope
		? `unknown change scope${riskLane.reason ? `: ${riskLane.reason}` : ""}`
		: (riskLane.reason ?? "no files changed");
	return `${riskLane.lane} (paths: none — ${why}; requires: ${riskLane.requirement})`;
}
