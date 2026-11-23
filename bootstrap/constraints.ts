/** Project learned constraints (.pi/constraints.json): strict validation, canonical digest, prompt-safety checks, and brief-bound enforcement. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const CONSTRAINTS_FILE_VERSION = 1;
export const CONSTRAINTS_MAX_FILE_BYTES = 1_048_576;
export const CONSTRAINTS_MAX_ENTRIES = 64;
export const CONSTRAINTS_MAX_ACTIVE = 32;
export const CONSTRAINTS_MAX_TEXT_BYTES = 512;
export const CONSTRAINTS_BRIEF_ITEM_MAX_BYTES = 768;
export const CONSTRAINTS_BRIEF_MAX_BYTES = 2048;
export const CONSTRAINT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOP_LEVEL_KEYS = new Set(["version", "constraints"]);
const ENTRY_KEYS = new Set(["id", "text", "provenance", "status"]);
const PROVENANCE_KEYS = new Set(["run_id", "attempt_id", "evidence_ref", "note", "recorded_at", "recorded_by"]);
const SNAPSHOT_KEYS = new Set(["version", "digest", "used_ids", "entries"]);

// ASCII C0 (includes NUL, \n, \r, \t, ESC), DEL, C1 (U+0080..U+009F), Unicode line/para separators, and bidi controls.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const PROMPT_INJECTION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/```/, "markdown code fence (```)"],
	[/^\s*#{1,6}\s/, "markdown heading marker (#)"],
	[/<\|[^|>]*\|>/, "model control delimiter (<|...|>)"],
	[/\[\/?INST\]/, "instruction delimiter ([INST])"],
	[/<<\/?SYS>>/, "system delimiter (<<SYS>>)"],
	[/<\/?(?:system|assistant|user|human|instructions?|prompt|docs|developer|tool_call|tool_result|function_calls?|antml:[a-z_]+)\b[^>]*>/i, "prompt XML/role tag"],
	[/bootstrap-(?:handoff|start|cancel):/i, "Bootstrap protocol prefix"],
	[/\b(?:Authoritative assignment instructions|Bootstrap execution contract|peer-produced data)\b/i, "Bootstrap prompt section marker"],
];

export interface ConstraintProvenance {
	run_id?: string;
	attempt_id?: string;
	evidence_ref?: string;
	note?: string;
	recorded_at?: string;
	recorded_by?: string;
}

export interface LearnedConstraintEntry {
	id: string;
	text: string;
	provenance: ConstraintProvenance;
	status: "active" | "retired";
}

export interface LearnedConstraintsSnapshot {
	version: 1;
	digest: string;
	used_ids: string[];
	entries: LearnedConstraintEntry[];
}

export interface LearnedConstraintsSummary {
	digest: string;
	used_ids: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalJsonValue(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJsonValue(item)).join(",")}]`;
	const rec = value as Record<string, unknown>;
	const keys = Object.keys(rec).sort();
	return `{${keys.filter(k => rec[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJsonValue(rec[k])}`).join(",")}}`;
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256").update(canonicalJsonValue(value), "utf8").digest("hex");
}

function assertSafeText(value: unknown, label: string, maxBytes: number, checkPromptMarkers: boolean): string {
	if (typeof value !== "string" || !value.isWellFormed() || !value.trim()) {
		throw new Error(`${label} must be a non-empty well-formed UTF-8 string`);
	}
	if (CONTROL_CHAR_PATTERN.test(value)) {
		throw new Error(`${label} cannot contain control characters, newlines, tabs, or bidirectional overrides`);
	}
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > maxBytes) {
		throw new Error(`${label} exceeds maximum ${maxBytes} UTF-8 bytes (${bytes} bytes)`);
	}
	if (checkPromptMarkers) {
		for (const [pattern, name] of PROMPT_INJECTION_PATTERNS) {
			if (pattern.test(value)) {
				throw new Error(`${label} contains disallowed prompt-structure marker (${name})`);
			}
		}
	}
	return value;
}

function validateProvenance(raw: unknown, sourceLabel: string, entryLabel: string): ConstraintProvenance {
	if (!isPlainRecord(raw)) {
		throw new Error(`${sourceLabel}: ${entryLabel} provenance must be an object`);
	}
	for (const key of Object.keys(raw)) {
		if (!PROVENANCE_KEYS.has(key)) {
			throw new Error(`${sourceLabel}: ${entryLabel} provenance has unknown key ${JSON.stringify(key)}`);
		}
	}
	const out: ConstraintProvenance = {};
	if (raw.run_id !== undefined) out.run_id = assertSafeText(raw.run_id, `${sourceLabel}: ${entryLabel} provenance.run_id`, 200, false);
	if (raw.attempt_id !== undefined) out.attempt_id = assertSafeText(raw.attempt_id, `${sourceLabel}: ${entryLabel} provenance.attempt_id`, 200, false);
	if (raw.evidence_ref !== undefined) out.evidence_ref = assertSafeText(raw.evidence_ref, `${sourceLabel}: ${entryLabel} provenance.evidence_ref`, 512, false);
	if (raw.note !== undefined) out.note = assertSafeText(raw.note, `${sourceLabel}: ${entryLabel} provenance.note`, 512, false);
	if (raw.recorded_by !== undefined) out.recorded_by = assertSafeText(raw.recorded_by, `${sourceLabel}: ${entryLabel} provenance.recorded_by`, 128, false);
	if (raw.recorded_at !== undefined) {
		const ts = assertSafeText(raw.recorded_at, `${sourceLabel}: ${entryLabel} provenance.recorded_at`, 64, false);
		if (!Number.isFinite(Date.parse(ts))) {
			throw new Error(`${sourceLabel}: ${entryLabel} provenance.recorded_at must be a valid ISO timestamp`);
		}
		out.recorded_at = ts;
	}
	const hasAnyRunRef = out.run_id !== undefined || out.attempt_id !== undefined || out.evidence_ref !== undefined;
	const hasFullRunRef = out.run_id !== undefined && out.attempt_id !== undefined && out.evidence_ref !== undefined;
	if (!out.note && !hasFullRunRef) {
		throw new Error(`${sourceLabel}: ${entryLabel} provenance must include a note or complete run provenance (run_id, attempt_id, evidence_ref)`);
	}
	if (hasAnyRunRef && !hasFullRunRef) {
		throw new Error(`${sourceLabel}: ${entryLabel} provenance with run references must include run_id, attempt_id, and evidence_ref`);
	}
	return out;
}

export function validateConstraintsEntries(sourceLabel: string, rawEntries: unknown): LearnedConstraintEntry[] {
	if (!Array.isArray(rawEntries)) {
		throw new Error(`${sourceLabel}: "constraints" must be an array`);
	}
	if (rawEntries.length > CONSTRAINTS_MAX_ENTRIES) {
		throw new Error(`${sourceLabel}: constraints file has ${rawEntries.length} entries, exceeding maximum ${CONSTRAINTS_MAX_ENTRIES}`);
	}
	const seenIds = new Map<string, number>();
	const entries: LearnedConstraintEntry[] = [];
	let activeCount = 0;

	for (let i = 0; i < rawEntries.length; i++) {
		const rawEntry = rawEntries[i];
		if (!isPlainRecord(rawEntry)) {
			throw new Error(`${sourceLabel}: constraint entry #${i + 1} must be an object`);
		}
		const entryLabel = typeof rawEntry.id === "string" && rawEntry.id.trim()
			? `constraint ${JSON.stringify(rawEntry.id)} (entry #${i + 1})`
			: `constraint entry #${i + 1}`;

		for (const key of Object.keys(rawEntry)) {
			if (!ENTRY_KEYS.has(key)) {
				throw new Error(`${sourceLabel}: ${entryLabel} has unknown key ${JSON.stringify(key)}`);
			}
		}

		if (typeof rawEntry.id !== "string" || !CONSTRAINT_ID_PATTERN.test(rawEntry.id)) {
			throw new Error(`${sourceLabel}: ${entryLabel} id must be 1–80 characters matching ${CONSTRAINT_ID_PATTERN}`);
		}
		const normalizedId = rawEntry.id.toLowerCase();
		const priorIndex = seenIds.get(normalizedId);
		if (priorIndex !== undefined) {
			throw new Error(`${sourceLabel}: duplicate constraint id ${JSON.stringify(rawEntry.id)} at entry #${i + 1} (conflicts with entry #${priorIndex + 1})`);
		}
		seenIds.set(normalizedId, i);

		if (rawEntry.status !== "active" && rawEntry.status !== "retired") {
			throw new Error(`${sourceLabel}: ${entryLabel} has invalid status ${JSON.stringify(rawEntry.status)} (expected "active" or "retired")`);
		}
		if (rawEntry.status === "active") activeCount++;

		const text = assertSafeText(rawEntry.text, `${sourceLabel}: ${entryLabel} text`, CONSTRAINTS_MAX_TEXT_BYTES, true);
		const provenance = validateProvenance(rawEntry.provenance, sourceLabel, entryLabel);
		entries.push({ id: rawEntry.id, text, provenance, status: rawEntry.status });
	}

	if (activeCount > CONSTRAINTS_MAX_ACTIVE) {
		throw new Error(`${sourceLabel}: active learned constraints (${activeCount}) exceed maximum ${CONSTRAINTS_MAX_ACTIVE}`);
	}
	return entries;
}

/** Render one active learned constraint as injected into the shared brief's Constraints list. */
export function formatLearnedConstraintLine(entry: Pick<LearnedConstraintEntry, "id" | "text">): string {
	return `[${entry.id}] ${entry.text}`;
}

/** Render active learned constraints into the shared brief's `Constraints:` list when present. */
export function mergeBriefConstraints(
	planConstraints: ReadonlyArray<string> | undefined,
	learned: LearnedConstraintsSnapshot | undefined,
): string[] | undefined {
	if (!learned) return planConstraints ? [...planConstraints] : undefined;
	const activeLines = learned.entries
		.filter(entry => entry.status === "active")
		.map(entry => formatLearnedConstraintLine(entry));
	if (activeLines.length === 0) return planConstraints ? [...planConstraints] : undefined;
	return [...(planConstraints ?? []), ...activeLines];
}

/**
 * Verify that all plan + active learned constraints fit inside the shared brief's `Constraints:` bound
 * without truncating or omitting a single item. Fails closed on overflow.
 */
export function checkConstraintsFit(
	planConstraints: ReadonlyArray<string> | undefined,
	learned: LearnedConstraintsSnapshot | undefined,
	maxTotalBytes = CONSTRAINTS_BRIEF_MAX_BYTES,
): void {
	const activeEntries = learned?.entries.filter(entry => entry.status === "active") ?? [];
	if (activeEntries.length === 0) return;

	const combined = [
		...(planConstraints ?? []),
		...activeEntries.map(entry => formatLearnedConstraintLine(entry)),
	];
	let totalBytes = 0;
	for (let i = 0; i < combined.length; i++) {
		const item = combined[i];
		const itemBytes = Buffer.byteLength(item, "utf8");
		if (itemBytes > CONSTRAINTS_BRIEF_ITEM_MAX_BYTES) {
			throw new Error(`Constraints overflow shared brief per-item bound at item #${i + 1} (${itemBytes} > ${CONSTRAINTS_BRIEF_ITEM_MAX_BYTES} bytes)`);
		}
		totalBytes += Buffer.byteLength(`- ${item}`, "utf8") + 1;
	}
	if (totalBytes > maxTotalBytes) {
		throw new Error(`Active learned constraints overflow the shared brief constraints bound (${totalBytes} > ${maxTotalBytes} UTF-8 bytes)`);
	}
}

/** Validate a parsed `.pi/constraints.json` object and compute its canonical digest. */
export function validateConstraintsFile(sourceLabel: string, raw: unknown): LearnedConstraintsSnapshot {
	if (!isPlainRecord(raw)) {
		throw new Error(`${sourceLabel}: constraints file must be a JSON object`);
	}
	for (const key of Object.keys(raw)) {
		if (!TOP_LEVEL_KEYS.has(key)) {
			throw new Error(`${sourceLabel}: unknown key ${JSON.stringify(key)}`);
		}
	}
	if (raw.version !== CONSTRAINTS_FILE_VERSION) {
		throw new Error(`${sourceLabel}: unsupported constraints file version ${JSON.stringify(raw.version)} (expected ${CONSTRAINTS_FILE_VERSION})`);
	}
	const entries = validateConstraintsEntries(sourceLabel, raw.constraints);
	const checkOnlyActive: LearnedConstraintsSnapshot = {
		version: 1,
		digest: sha256Canonical({ version: CONSTRAINTS_FILE_VERSION, constraints: entries }),
		used_ids: entries.filter(entry => entry.status === "active").map(entry => entry.id),
		entries,
	};
	checkConstraintsFit(undefined, checkOnlyActive);
	return checkOnlyActive;
}

/**
 * Read and validate `<projectCwd>/.pi/constraints.json` once without following symlinks or blocking on non-regular files.
 * Returns `undefined` when `.pi` or `.pi/constraints.json` does not exist; fails closed on any other read or schema error.
 */
export function readProjectConstraints(projectCwd: string): LearnedConstraintsSnapshot | undefined {
	let realCwd: string;
	try {
		realCwd = realpathSync(projectCwd);
	} catch (error) {
		throw new Error(`Cannot resolve project_cwd for constraints: ${errMsg(error)}`);
	}
	const piDir = join(realCwd, ".pi");
	try {
		const piStat = lstatSync(piDir);
		if (piStat.isSymbolicLink()) {
			throw new Error(`Refusing symlinked .pi directory for constraints: ${piDir}`);
		}
		if (!piStat.isDirectory()) {
			throw new Error(`.pi is not a directory: ${piDir}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	const filePath = join(piDir, "constraints.json");
	try {
		const stat = lstatSync(filePath);
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing symlinked constraints file: ${filePath}`);
		}
		if (!stat.isFile()) {
			throw new Error(`Refusing non-regular constraints file: ${filePath}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	let rawText: string;
	let fd: number | undefined;
	try {
		fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const fdStat = fstatSync(fd);
		if (!fdStat.isFile()) {
			throw new Error(`Refusing non-regular constraints file: ${filePath}`);
		}
		if (fdStat.size > CONSTRAINTS_MAX_FILE_BYTES) {
			throw new Error(`${filePath}: constraints file exceeds maximum ${CONSTRAINTS_MAX_FILE_BYTES} bytes (${fdStat.size} bytes)`);
		}
		rawText = readFileSync(fd, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${filePath}: unable to read constraints file (${errMsg(error)})`);
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* ignore */ }
		}
	}

	if (!rawText.isWellFormed()) {
		throw new Error(`${filePath}: constraints file contains malformed UTF-8`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		throw new Error(`${filePath}: constraints file contains invalid JSON (${errMsg(error)})`);
	}
	return validateConstraintsFile(filePath, parsed);
}

/** Validate a persisted `learned_constraints` snapshot inside a manifest or worker config, verifying digest and `used_ids`. */
export function parseLearnedConstraintsSnapshot(raw: unknown, label = "learned_constraints"): LearnedConstraintsSnapshot {
	if (!isPlainRecord(raw)) {
		throw new Error(`${label} must be an object`);
	}
	for (const key of Object.keys(raw)) {
		if (!SNAPSHOT_KEYS.has(key)) {
			throw new Error(`${label} has unknown key ${JSON.stringify(key)}`);
		}
	}
	if (raw.version !== 1) {
		throw new Error(`Unsupported ${label} version ${JSON.stringify(raw.version)}`);
	}
	if (typeof raw.digest !== "string" || !SHA256_HEX.test(raw.digest)) {
		throw new Error(`${label}.digest must be a 64-character lowercase hex SHA-256 digest`);
	}
	if (!Array.isArray(raw.used_ids) || raw.used_ids.some(id => typeof id !== "string" || !CONSTRAINT_ID_PATTERN.test(id))) {
		throw new Error(`${label}.used_ids must be an array of valid constraint IDs`);
	}
	const entries = validateConstraintsEntries(label, raw.entries);
	const expectedDigest = sha256Canonical({ version: CONSTRAINTS_FILE_VERSION, constraints: entries });
	if (raw.digest !== expectedDigest) {
		throw new Error(`${label} digest mismatch (recorded ${raw.digest}, computed ${expectedDigest})`);
	}
	const expectedUsedIds = entries.filter(entry => entry.status === "active").map(entry => entry.id);
	if (raw.used_ids.length !== expectedUsedIds.length || raw.used_ids.some((id, idx) => id !== expectedUsedIds[idx])) {
		throw new Error(`${label} used_ids mismatch (recorded ${JSON.stringify(raw.used_ids)}, active entries ${JSON.stringify(expectedUsedIds)})`);
	}
	return {
		version: 1,
		digest: raw.digest,
		used_ids: [...expectedUsedIds],
		entries,
	};
}

/** Single-line summary of learned constraints for status, dry-run, and report views. */
export function formatLearnedConstraintsSummary(summary: Pick<LearnedConstraintsSnapshot, "digest" | "used_ids">): string {
	const used = summary.used_ids.length > 0 ? summary.used_ids.join(", ") : "none";
	return `digest ${summary.digest}; used (${summary.used_ids.length}): ${used}`;
}
