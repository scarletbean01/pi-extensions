/** Verification evidence with before/after working-tree content snapshots and applicability evaluation. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { assertIdentityMatches, atomicJson, errorMessage, readJson, type CompletionExpectation, type CompletionIdentity } from "./session-store.ts";
import { canGlobMatchDescendant, globToRegExp } from "./ownership.ts";
import type { VerificationSummary } from "./contracts.ts";

const execFileAsync = promisify(execFile);

export const MAX_SNAPSHOT_FILES = 5000;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export interface SnapshotFileEntry {
	sha256: string;
	size: number;
}

export interface RepoSnapshot {
	captured_at: string;
	project_cwd: string;
	scope_kind: "declared" | "conservative" | "unknown";
	scope?: string[];
	complete: boolean;
	reason?: string;
	/** Informational only — never relied upon alone for applicability. */
	git_head?: string;
	files: Record<string, SnapshotFileEntry>;
}

export interface VerificationRecord {
	version: 2;
	check_id: string;
	name?: string;
	command?: string;
	result: "pass" | "fail" | "error";
	detail?: string;
	identity: CompletionIdentity;
	started_at: string;
	completed_at: string;
	scope_kind: "declared" | "conservative" | "unknown";
	scope?: string[];
	before_snapshot: RepoSnapshot;
	after_snapshot: RepoSnapshot;
	changed_during_check: string[];
}

export interface VerificationFile {
	version: 2;
	identity: CompletionIdentity;
	records: VerificationRecord[];
}

export type VerificationApplicability = "current" | "stale" | "unknown";

export interface VerificationEvaluation {
	check_id: string;
	result: "pass" | "fail" | "error";
	applicability: VerificationApplicability;
	attempt_id: string;
	completed_at: string;
	scope_kind: "declared" | "conservative" | "unknown";
	reason?: string;
	changed_paths?: string[];
	history_count: number;
}

export interface StartedVerificationCheck {
	check_id: string;
	started_at: string;
	scope_kind: "declared" | "conservative" | "unknown";
	scope?: string[];
	before_snapshot: RepoSnapshot;
}

export function verificationPath(sessionDir: string, instanceId: string): string {
	return join(sessionDir, `${instanceId}.verification.json`);
}

function normalizeScopePattern(projectCwd: string, raw: string): { pattern: string; isDirPrefix: boolean; regex?: RegExp } {
	const trimmed = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed) || trimmed === ".." || trimmed.startsWith("../") || trimmed.includes("/../")) {
		throw new Error(`Invalid verification scope entry "${raw}": must stay relative to project_cwd`);
	}
	const isDirPrefix = trimmed.endsWith("/");
	const clean = isDirPrefix ? trimmed.slice(0, -1) : trimmed;
	if (!clean) {
		return { pattern: ".", isDirPrefix: true };
	}
	if (/[*?]/.test(clean)) {
		const globPattern = isDirPrefix && clean !== "**" && !clean.endsWith("/**") ? `${clean}/**` : clean;
		return { pattern: globPattern, isDirPrefix: false, regex: globToRegExp(globPattern) };
	}
	// Verify resolved target stays within projectCwd.
	const target = resolve(projectCwd, clean);
	const rel = relative(projectCwd, target);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Verification scope entry escapes project_cwd: ${raw}`);
	}
	return { pattern: clean, isDirPrefix };
}

function matchesScope(relPosix: string, matchers: ReturnType<typeof normalizeScopePattern>[]): boolean {
	for (const m of matchers) {
		if (m.pattern === ".") return true;
		if (m.regex) {
			if (m.regex.test(relPosix)) return true;
			continue;
		}
		if (m.isDirPrefix) {
			if (relPosix.startsWith(m.pattern + "/")) return true;
		} else if (relPosix === m.pattern || relPosix.startsWith(m.pattern + "/")) {
			return true;
		}
	}
	return false;
}

function shouldDescendDir(relPosix: string, matchers: ReturnType<typeof normalizeScopePattern>[]): boolean {
	const dirSegs = relPosix.split("/");
	for (const m of matchers) {
		if (m.pattern === ".") return true;
		if (m.regex) {
			if (m.pattern === "**" || canGlobMatchDescendant(m.pattern.split("/"), dirSegs)) return true;
			continue;
		}
		if (relPosix === m.pattern || relPosix.startsWith(m.pattern + "/") || m.pattern.startsWith(relPosix + "/")) {
			return true;
		}
	}
	return false;
}

function readGitHeadInfo(projectCwd: string): string | undefined {
	try {
		const headPath = join(projectCwd, ".git", "HEAD");
		if (!existsSync(headPath)) return undefined;
		const head = readFileSync(headPath, "utf8").trim();
		if (head.startsWith("ref: ")) {
			const refPath = join(projectCwd, ".git", head.slice(5).trim());
			if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim();
		}
		return head;
	} catch {
		return undefined;
	}
}

/**
 * Capture content hashes of relevant files in `projectCwd` (including untracked files, without relying on Git or commit IDs).
 * Declared scope limits hashing to matching paths; omitted scope snapshots the full working tree conservatively.
 */
export function snapshotScope(projectCwd: string, scope?: string[]): RepoSnapshot {
	const captured_at = new Date().toISOString();
	const root = existsSync(projectCwd) ? realpathSync(projectCwd) : resolve(projectCwd);
	const git_head = readGitHeadInfo(root);

	if (scope !== undefined && scope.length === 0) {
		return {
			captured_at,
			project_cwd: root,
			scope_kind: "unknown",
			scope,
			complete: false,
			reason: "Empty declared scope; relevance cannot be established",
			...(git_head ? { git_head } : {}),
			files: {},
		};
	}

	let matchers: ReturnType<typeof normalizeScopePattern>[] | undefined;
	if (scope !== undefined) {
		try {
			matchers = scope.map(entry => normalizeScopePattern(root, entry));
		} catch (error) {
			return {
				captured_at,
				project_cwd: root,
				scope_kind: "unknown",
				scope,
				complete: false,
				reason: errorMessage(error),
				...(git_head ? { git_head } : {}),
				files: {},
			};
		}
	}

	const scope_kind: RepoSnapshot["scope_kind"] = matchers ? "declared" : "conservative";
	const files: Record<string, SnapshotFileEntry> = {};
	let totalBytes = 0;
	let fileCount = 0;

	const walk = (dir: string, relDir: string): string | undefined => {
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch (error) {
			return `Failed to read directory ${relDir || "."}: ${errorMessage(error)}`;
		}
		for (const name of entries) {
			const relPosix = relDir ? posix.join(relDir, name) : name;
			if (relPosix === ".git" || relPosix === "node_modules" || relPosix === ".pi/agent-sessions") continue;
			const full = join(dir, name);
			let stat;
			try {
				stat = lstatSync(full);
			} catch (error) {
				return `Failed to stat ${relPosix}: ${errorMessage(error)}`;
			}
			if (stat.isDirectory()) {
				if (matchers && !shouldDescendDir(relPosix, matchers)) continue;
				const err = walk(full, relPosix);
				if (err) return err;
				continue;
			}
			if (matchers && !matchesScope(relPosix, matchers)) continue;
			fileCount++;
			if (fileCount > MAX_SNAPSHOT_FILES) {
				return `Snapshot exceeded ${MAX_SNAPSHOT_FILES} files`;
			}
			if (stat.isSymbolicLink()) {
				try {
					const target = readlinkSync(full);
					const sha256 = createHash("sha256").update(`symlink:${target}`).digest("hex");
					files[relPosix] = { sha256, size: target.length };
				} catch (error) {
					return `Failed to read symlink ${relPosix}: ${errorMessage(error)}`;
				}
				continue;
			}
			if (!stat.isFile()) continue;
			totalBytes += stat.size;
			if (totalBytes > MAX_SNAPSHOT_BYTES) {
				return `Snapshot exceeded ${MAX_SNAPSHOT_BYTES} bytes`;
			}
			try {
				const content = readFileSync(full);
				const sha256 = createHash("sha256").update(content).digest("hex");
				files[relPosix] = { sha256, size: content.length };
			} catch (error) {
				return `Failed to read ${relPosix}: ${errorMessage(error)}`;
			}
		}
		return undefined;
	};

	const walkError = walk(root, "");
	if (walkError) {
		return {
			captured_at,
			project_cwd: root,
			scope_kind: "unknown",
			...(scope ? { scope } : {}),
			complete: false,
			reason: walkError,
			...(git_head ? { git_head } : {}),
			files,
		};
	}

	return {
		captured_at,
		project_cwd: root,
		scope_kind,
		...(scope ? { scope } : {}),
		complete: true,
		...(git_head ? { git_head } : {}),
		files,
	};
}

export function diffSnapshots(a: Record<string, SnapshotFileEntry>, b: Record<string, SnapshotFileEntry>): string[] {
	const changed = new Set<string>();
	for (const path of Object.keys(a)) {
		if (!b[path] || b[path].sha256 !== a[path].sha256) changed.add(path);
	}
	for (const path of Object.keys(b)) {
		if (!a[path]) changed.add(path);
	}
	return [...changed].sort();
}

export function beginVerificationCheck(projectCwd: string, checkId: string, scope?: string[]): StartedVerificationCheck {
	const before_snapshot = snapshotScope(projectCwd, scope);
	return {
		check_id: checkId,
		started_at: new Date().toISOString(),
		scope_kind: before_snapshot.scope_kind,
		...(scope ? { scope } : {}),
		before_snapshot,
	};
}

export function appendVerificationRecord(sessionDir: string, record: VerificationRecord, recordKey = record.identity.instance_id): VerificationFile {
	const path = verificationPath(sessionDir, recordKey);
	let current: VerificationFile = { version: 2, identity: record.identity, records: [] };
	if (existsSync(path)) {
		current = parseVerificationFile(readJson<unknown>(path), {
			run_id: record.identity.run_id,
			instance_id: record.identity.instance_id,
			node_id: record.identity.node_id,
			persona_name: record.identity.persona_name,
			attempt_id: record.identity.attempt_id,
		});
	}
	const next: VerificationFile = {
		version: 2,
		identity: current.identity,
		records: [...current.records, record],
	};
	atomicJson(path, next);
	return next;
}

export function finishVerificationCheck(
	sessionDir: string,
	identity: CompletionIdentity,
	started: StartedVerificationCheck,
	outcome: { result: "pass" | "fail" | "error"; detail?: string; name?: string; command?: string },
	recordKey = identity.instance_id,
): {
	record: VerificationRecord;
	applicability: VerificationApplicability;
	reason?: string;
	changed_paths?: string[];
	history_count: number;
} {
	const after_snapshot = snapshotScope(started.before_snapshot.project_cwd, started.scope);
	const changed_during_check = started.before_snapshot.complete && after_snapshot.complete
		? diffSnapshots(started.before_snapshot.files, after_snapshot.files)
		: [];
	const scope_kind = !started.before_snapshot.complete || !after_snapshot.complete ? "unknown" : started.scope_kind;
	const record: VerificationRecord = {
		version: 2,
		check_id: started.check_id,
		...(outcome.name ? { name: outcome.name } : {}),
		...(outcome.command ? { command: outcome.command } : {}),
		result: outcome.result,
		...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
		identity,
		started_at: started.started_at,
		completed_at: new Date().toISOString(),
		scope_kind,
		...(started.scope ? { scope: started.scope } : {}),
		before_snapshot: started.before_snapshot,
		after_snapshot,
		changed_during_check,
	};
	const file = appendVerificationRecord(sessionDir, record, recordKey);
	const evalResult = evaluateApplicability(record, started.before_snapshot.project_cwd);
	const history_count = file.records.filter(r => r.check_id === started.check_id).length;
	return { record, ...evalResult, history_count };
}

export async function runVerificationCommand(params: {
	sessionDir: string;
	projectCwd: string;
	identity: CompletionIdentity;
	recordKey?: string;
	checkId: string;
	command: string;
	scope?: string[];
	name?: string;
	timeoutMs?: number;
}) {
	const started = beginVerificationCheck(params.projectCwd, params.checkId, params.scope);
	let result: "pass" | "fail" | "error" = "pass";
	let detail = "";
	try {
		const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", params.command], {
			cwd: params.projectCwd,
			timeout: params.timeoutMs ?? 60_000,
			maxBuffer: 1024 * 1024,
		});
		detail = (stdout || stderr || "exit 0").slice(0, 2000);
	} catch (error: any) {
		result = typeof error?.code === "number" ? "fail" : "error";
		detail = `${error?.stderr || error?.stdout || errorMessage(error)}`.slice(0, 2000);
	}
	return finishVerificationCheck(params.sessionDir, params.identity, started, {
		result,
		detail,
		name: params.name,
		command: params.command,
	}, params.recordKey);
}

function parseVerificationIdentity(raw: unknown, expected: Partial<CompletionExpectation>, label: string): CompletionIdentity {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} identity mismatch (no identity recorded)`);
	const id = raw as Record<string, unknown>;
	for (const field of ["run_id", "node_id", "persona_name", "attempt_id", "instance_id"] as const) {
		if (typeof id[field] !== "string" || !id[field]) {
			throw new Error(`malformed ${label} identity (${field} must be a non-empty string)`);
		}
	}
	return assertIdentityMatches(raw, expected as CompletionExpectation, label);
}

function parseVerificationFile(raw: unknown, expected: Partial<CompletionExpectation>): VerificationFile {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed verification record file");
	const file = raw as Record<string, unknown>;
	if (file.version !== 2) {
		throw new Error(`Unsupported verification file version ${JSON.stringify(file.version)}`);
	}
	if (!Array.isArray(file.records)) {
		throw new Error("malformed verification record file (records must be an array)");
	}
	const fileIdentity = parseVerificationIdentity(file.identity, expected, "verification");
	for (const entry of file.records) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("malformed verification record entry");
		const rec = entry as Record<string, unknown>;
		if (rec.version !== 2) throw new Error(`Unsupported verification record version ${JSON.stringify(rec.version)}`);
		if (typeof rec.check_id !== "string" || !rec.check_id) throw new Error("malformed verification record (missing check_id)");
		if (rec.result !== "pass" && rec.result !== "fail" && rec.result !== "error") throw new Error("malformed verification record (invalid result)");
		if (typeof rec.started_at !== "string" || typeof rec.completed_at !== "string") throw new Error("malformed verification record (missing timestamps)");
		if (rec.scope_kind !== "declared" && rec.scope_kind !== "conservative" && rec.scope_kind !== "unknown") throw new Error("malformed verification record (invalid scope_kind)");
		if (!rec.before_snapshot || typeof rec.before_snapshot !== "object" || !rec.after_snapshot || typeof rec.after_snapshot !== "object") {
			throw new Error("malformed verification record (missing snapshots)");
		}
		parseVerificationIdentity(rec.identity, fileIdentity, "verification record");
	}
	return file as unknown as VerificationFile;
}

export function readVerificationRecords(sessionDir: string, instanceId: string, expectedRunId?: string, recordKey = instanceId): VerificationRecord[] {
	const path = verificationPath(sessionDir, recordKey);
	if (!existsSync(path)) return [];
	return parseVerificationFile(readJson<unknown>(path), { instance_id: instanceId, ...(recordKey === instanceId ? {} : { attempt_id: recordKey }), ...(expectedRunId ? { run_id: expectedRunId } : {}) }).records;
}

export function evaluateApplicability(
	record: VerificationRecord,
	projectCwd: string,
): { applicability: VerificationApplicability; reason?: string; changed_paths?: string[] } {
	if (record.scope_kind === "unknown" || !record.before_snapshot?.complete || !record.after_snapshot?.complete) {
		return {
			applicability: "unknown",
			reason: record.after_snapshot?.reason ?? record.before_snapshot?.reason ?? "Verification scope or snapshots could not be established",
		};
	}
	const during = record.changed_during_check?.length
		? record.changed_during_check
		: diffSnapshots(record.before_snapshot.files, record.after_snapshot.files);
	if (during.length > 0) {
		return {
			applicability: "unknown",
			reason: `Relevant repository content changed during check execution (${during.slice(0, 5).join(", ")})`,
			changed_paths: during,
		};
	}
	const current = snapshotScope(projectCwd, record.scope);
	if (!current.complete || current.scope_kind === "unknown") {
		return {
			applicability: "unknown",
			reason: current.reason ?? "Current repository state could not be snapshotted",
		};
	}
	const afterChanges = diffSnapshots(record.after_snapshot.files, current.files);
	if (afterChanges.length > 0) {
		return {
			applicability: "stale",
			reason: `Relevant repository content changed after check execution (${afterChanges.slice(0, 5).join(", ")})`,
			changed_paths: afterChanges,
		};
	}
	return { applicability: "current" };
}

export function evaluateNodeVerification(
	sessionDir: string,
	instanceId: string,
	projectCwd: string,
	requiredChecks?: string[],
	expectedRunId?: string,
	recordKey = instanceId,
): {
	evaluations: VerificationEvaluation[];
	summaries: VerificationSummary[];
	blockers: string[];
} {
	const records = readVerificationRecords(sessionDir, instanceId, expectedRunId, recordKey);
	const byCheck = new Map<string, VerificationRecord[]>();
	for (const rec of records) {
		const list = byCheck.get(rec.check_id) ?? [];
		list.push(rec);
		byCheck.set(rec.check_id, list);
	}
	const evaluations: VerificationEvaluation[] = [];
	const summaries: VerificationSummary[] = [];
	const evalMap = new Map<string, VerificationEvaluation>();
	for (const [checkId, list] of byCheck.entries()) {
		const latest = list[list.length - 1];
		const app = evaluateApplicability(latest, projectCwd);
		const evaluation: VerificationEvaluation = {
			check_id: checkId,
			result: latest.result,
			applicability: app.applicability,
			attempt_id: latest.identity.attempt_id,
			completed_at: latest.completed_at,
			scope_kind: latest.scope_kind,
			...(app.reason ? { reason: app.reason } : {}),
			...(app.changed_paths?.length ? { changed_paths: app.changed_paths } : {}),
			history_count: list.length,
		};
		evaluations.push(evaluation);
		evalMap.set(checkId, evaluation);
		summaries.push({
			check_id: checkId,
			result: latest.result,
			attempt_id: latest.identity.attempt_id,
			completed_at: latest.completed_at,
			scope_kind: latest.scope_kind,
			applicability: app.applicability,
			...(app.reason ? { reason: app.reason } : {}),
		});
	}
	const blockers: string[] = [];
	for (const checkId of requiredChecks ?? []) {
		const ev = evalMap.get(checkId);
		if (!ev) {
			blockers.push(`Missing required verification check "${checkId}"`);
			continue;
		}
		if (ev.result !== "pass") {
			blockers.push(`Required verification check "${checkId}" did not pass (${ev.result})`);
			continue;
		}
		if (ev.applicability === "stale") {
			blockers.push(`Required verification check "${checkId}" is stale (${ev.reason ?? "relevant files changed"}); refresh required before admission`);
		} else if (ev.applicability === "unknown") {
			blockers.push(`Required verification check "${checkId}" has unknown applicability (${ev.reason ?? "scope unestablished"}); refresh with reliable scope required before admission`);
		}
	}
	return { evaluations, summaries, blockers };
}
