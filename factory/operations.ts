import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BootstrapService } from "../bootstrap/lifecycle.ts";
import { validateDraftShape } from "./draft.ts";

export const MAX_BRIEF_BYTES = 16 * 1024;
export const MAX_QUEUED_INPUTS = 32;
export const MAX_REFERENCE_BYTES = 256;

type Definition = ReturnType<BootstrapService["prepareDefinition"]>;
type SessionModel = Parameters<BootstrapService["prepareDefinition"]>[1];

export interface SessionBinding {
	pi_session_id?: string;
	pi_session_file?: string;
}

export interface ManagerAuthority {
	readonly incarnation_id: string;
}

interface AuthorityRecord {
	incarnation_id: string;
	secret_digest: string;
	pi_session_id: string | null;
	pi_session_file: string | null;
	pid: number;
	revoked: boolean;
}

const authorities = new WeakMap<ManagerAuthority, AuthorityRecord>();

export function createManagerAuthority(binding?: SessionBinding): ManagerAuthority {
	const incarnation_id = randomUUID();
	const secret = randomBytes(32).toString("hex");
	const handle: ManagerAuthority = Object.freeze({ incarnation_id });
	authorities.set(handle, {
		incarnation_id,
		secret_digest: digest(secret),
		pi_session_id: typeof binding?.pi_session_id === "string" && binding.pi_session_id.length > 0 ? binding.pi_session_id : null,
		pi_session_file: typeof binding?.pi_session_file === "string" && binding.pi_session_file.length > 0 ? binding.pi_session_file : null,
		pid: process.pid,
		revoked: false,
	});
	return handle;
}

export function revokeManagerAuthority(authority: ManagerAuthority | undefined): void {
	if (!authority) return;
	const record = authorities.get(authority);
	if (record) record.revoked = true;
}

function requireAuthority(authority: unknown): AuthorityRecord {
	if (!authority || typeof authority !== "object") {
		throw new Error("Untrusted or missing managing session authority; explicitly resume management in an interactive Pi session");
	}
	const record = authorities.get(authority as ManagerAuthority);
	if (!record) {
		throw new Error("Untrusted managing session authority; authority cannot be forged or inherited from saved state");
	}
	if (record.revoked) {
		throw new Error("Managing session authority has been closed or replaced; explicitly resume management in the active session");
	}
	return record;
}

type List = { action: "list" };
type Inspect = { action: "inspect"; factory_id: string };
type ReceiptLookup =
	| { action: "receipt"; factory_id: string; reference: string; input_id?: never }
	| { action: "receipt"; factory_id: string; input_id: string; reference?: never };
type VerifyManager = { action: "verify_manager"; factory_id: string; authority: ManagerAuthority };
type Publish = { action: "publish"; name: string; draft: unknown; sessionModel?: SessionModel };
type Resume = { action: "resume"; factory_id: string; authority: ManagerAuthority };
type Submit = { action: "submit"; factory_id: string; reference: string; brief: string; authority: ManagerAuthority };
export type FactoryRead = List | Inspect | ReceiptLookup;

type Identity = { factory_id: string; name: string };
export type ManagementState = "unmanaged" | "managed";
export type Factory = Identity & { current_version: "v1"; management: ManagementState };
export type InputDisposition = "queued";

export interface InputReceipt {
	factory_id: string;
	input_id: string;
	reference: string;
	bound_version: "v1";
	disposition: InputDisposition;
	queue_position: number;
	brief: string;
	brief_bytes: number;
	accepted_at: string;
}

type StoredFactory = Identity & { definition: string; digest: string };
type StoredManager = {
	factory_id: string;
	incarnation_id: string;
	authority_digest: string;
	pi_session_id: string | null;
	pi_session_file: string | null;
	pid: number;
	resumed_at: string;
	record_digest: string;
};
type StoredInput = {
	input_id: string;
	factory_id: string;
	reference: string;
	queue_position: number;
	bound_version: string;
	disposition: string;
	brief: string;
	brief_bytes: number;
	brief_digest: string;
	accepted_at: string;
	record_digest: string;
};

type Inspection = { factory: Factory; definition: Definition; queue: InputReceipt[] };
type ResumeResult = { factory: Factory; resumed: true; already_managed: boolean };
type CommitBoundary = (phase: "before_commit" | "after_commit") => void;

const MANAGER_TABLE_SQL = `
	CREATE TABLE factory_managers (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		incarnation_id TEXT NOT NULL,
		authority_digest TEXT NOT NULL,
		pi_session_id TEXT,
		pi_session_file TEXT,
		pid INTEGER NOT NULL,
		resumed_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const INPUT_TABLE_SQL = `
	CREATE TABLE factory_inputs (
		input_id TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL REFERENCES factories(factory_id),
		reference TEXT NOT NULL,
		queue_position INTEGER NOT NULL,
		bound_version TEXT NOT NULL,
		disposition TEXT NOT NULL,
		brief TEXT NOT NULL,
		brief_bytes INTEGER NOT NULL,
		brief_digest TEXT NOT NULL,
		accepted_at TEXT NOT NULL,
		record_digest TEXT NOT NULL,
		UNIQUE(factory_id, reference),
		UNIQUE(factory_id, queue_position)
	) STRICT;
`;

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function managerRecordDigest(row: Omit<StoredManager, "record_digest">): string {
	return digest(JSON.stringify([
		row.factory_id,
		row.incarnation_id,
		row.authority_digest,
		row.pi_session_id,
		row.pi_session_file,
		row.pid,
		row.resumed_at,
	]));
}

function inputRecordDigest(row: Omit<StoredInput, "record_digest">): string {
	return digest(JSON.stringify([
		row.input_id,
		row.factory_id,
		row.reference,
		row.queue_position,
		row.bound_version,
		row.disposition,
		row.brief,
		row.brief_bytes,
		row.brief_digest,
		row.accepted_at,
	]));
}

function validateToken(value: unknown, label: string, maxBytes = MAX_REFERENCE_BYTES): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty literal token`);
	}
	if (!value.isWellFormed()) {
		throw new Error(`${label} must be well-formed UTF-8 text`);
	}
	if (/[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`${label} cannot contain whitespace or control characters`);
	}
	if (Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
	}
	return value;
}

function validateBrief(value: unknown): { brief: string; brief_bytes: number; brief_digest: string } {
	if (typeof value !== "string") {
		throw new Error("Brief must be plain UTF-8 text");
	}
	if (!value.isWellFormed()) {
		throw new Error("Brief must be well-formed UTF-8 text");
	}
	if (value.trim().length === 0) {
		throw new Error("Brief must be nonblank plain text");
	}
	const brief_bytes = Buffer.byteLength(value, "utf8");
	if (brief_bytes > MAX_BRIEF_BYTES) {
		throw new Error(`Brief exceeds the 16 KiB (${MAX_BRIEF_BYTES} UTF-8 bytes) limit (got ${brief_bytes} bytes)`);
	}
	return { brief: value, brief_bytes, brief_digest: digest(value) };
}

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Persist every newly-created directory entry, not only the leaf database parent. */
function assertNoSymlinkComponents(path: string): void {
	const absolute = resolve(path);
	const components: string[] = [];
	for (let current = absolute; ; current = dirname(current)) {
		components.push(current);
		if (dirname(current) === current) break;
	}
	for (const component of components.reverse()) {
		try {
			if (lstatSync(component).isSymbolicLink()) throw new Error(`Factory storage path contains a symlink: ${component}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function createDurableDirectory(path: string): void {
	assertNoSymlinkComponents(path);
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) throw new Error(`Cannot find an existing parent for factory state directory ${path}`);
		current = parent;
	}
	mkdirSync(path, { recursive: true, mode: 0o700 });
	// Sync the entire extant ancestry, not only directories this process created: a concurrent
	// creator may have made an entry but not yet persisted its parent before this publisher arrives.
	for (current = path; ; current = dirname(current)) {
		syncDirectory(current);
		if (dirname(current) === current) break;
		syncDirectory(dirname(current));
	}
}

function summary(identity: Identity, management: ManagementState = "unmanaged"): Factory {
	return { factory_id: identity.factory_id, name: identity.name, current_version: "v1", management };
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function schemaVersion(db: DatabaseSync): 0 | 1 | 2 {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported factory storage version ${version}`);
	if (version === 0 && db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
		throw new Error("Factory storage corruption detected: version-zero database has a nonempty schema");
	}
	if (version >= 1 && !hasTable(db, "factories")) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing factories table`);
	}
	if (version === 2 && (!hasTable(db, "factory_managers") || !hasTable(db, "factory_inputs"))) {
		throw new Error("Factory storage corruption detected: version-two database is missing required tables");
	}
	return version;
}

function ensureV2Schema(db: DatabaseSync): 0 | 1 | 2 {
	const version = schemaVersion(db);
	if (version === 0) {
		db.exec(`
			CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
	} else if (version === 1) {
		db.exec(`
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
	}
	return version;
}

function verifyStoredFactory(row: StoredFactory): Definition {
	if (!/^[a-f0-9]{64}$/.test(row.digest) || digest(row.definition) !== row.digest) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: definition digest mismatch`);
	}
	let definition: unknown;
	try { definition = JSON.parse(row.definition); }
	catch { throw new Error(`Factory storage corruption detected for ${row.factory_id}: invalid definition JSON`); }
	if (!definition || typeof definition !== "object" || Array.isArray(definition) || (definition as Record<string, unknown>).topology === undefined || !Array.isArray((definition as Record<string, unknown>).agents)) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: invalid v1 definition envelope`);
	}
	return definition as Definition;
}

function verifyManagerRow(row: StoredManager): void {
	if (!/^[a-f0-9]{64}$/.test(row.authority_digest) || !/^[a-f0-9]{64}$/.test(row.record_digest) || managerRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: manager authority evidence mismatch`);
	}
}

function verifyInputRow(row: StoredInput): InputReceipt {
	const expectedBytes = Buffer.byteLength(row.brief, "utf8");
	if (
		!Number.isInteger(row.queue_position)
		|| row.queue_position < 1
		|| !row.brief.isWellFormed()
		|| row.brief_bytes !== expectedBytes
		|| !/^[a-f0-9]{64}$/.test(row.brief_digest)
		|| digest(row.brief) !== row.brief_digest
		|| !/^[a-f0-9]{64}$/.test(row.record_digest)
		|| inputRecordDigest(row) !== row.record_digest
		|| row.bound_version !== "v1"
		|| row.disposition !== "queued"
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} input ${row.input_id}: input evidence mismatch`);
	}
	return {
		factory_id: row.factory_id,
		input_id: row.input_id,
		reference: row.reference,
		bound_version: "v1",
		disposition: "queued",
		queue_position: row.queue_position,
		brief: row.brief,
		brief_bytes: row.brief_bytes,
		accepted_at: row.accepted_at,
	};
}

function hasAcceptedInputs(db: DatabaseSync, factoryId: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM factory_inputs WHERE factory_id = ? LIMIT 1").get(factoryId));
}

function missingManagerCorruptionError(identity: Identity): Error {
	return new Error(
		`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): accepted input evidence exists without a manager record; refusing takeover or mutation. Recover valid receipts read-only with /factory receipt ${identity.factory_id} <reference>`,
	);
}

function databaseExists(path: string): boolean {
	try {
		if (!statSync(path).isFile()) throw new Error(`Not a factory database file: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function openWritableDb(path: string, createIfMissing: boolean): DatabaseSync | undefined {
	assertNoSymlinkComponents(path);
	if (createIfMissing) {
		// Do not depend on the umask for definitions containing private project instructions.
		createDurableDirectory(dirname(path));
		try { closeSync(openSync(path, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !databaseExists(path)) throw error; }
		syncDirectory(dirname(path));
	} else if (!databaseExists(path)) {
		return undefined;
	}
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON");
		if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 3) throw new Error("Factory storage requires SQLite synchronous=EXTRA");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function authorityMatches(row: StoredManager, record: AuthorityRecord): boolean {
	return (
		row.incarnation_id === record.incarnation_id
		&& row.authority_digest === record.secret_digest
		&& row.pi_session_id === record.pi_session_id
		&& row.pi_session_file === record.pi_session_file
	);
}

export { validateToken as validateFactoryToken };

/** Shared operation boundary for factory publication, explicit resume, brief submission, and read-only inspection/receipts. */
export function factoryOperations(path: string, bootstrap: Pick<BootstrapService, "prepareDefinition">, atCommit?: CommitBoundary) {
	function operate(request: List): Factory[];
	function operate(request: Inspect): Inspection;
	function operate(request: ReceiptLookup): InputReceipt;
	function operate(request: VerifyManager): Factory;
	function operate(request: Publish): Factory;
	function operate(request: Resume): ResumeResult;
	function operate(request: Submit): InputReceipt;
	function operate(request: FactoryRead): Factory[] | Inspection | InputReceipt;
	function operate(request: FactoryRead | VerifyManager | Publish | Resume | Submit): Factory[] | Inspection | InputReceipt | Factory | ResumeResult {
		if (request.action === "publish") {
			const name = request.name.trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("Factory name must be 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit");
			validateDraftShape(request.draft);
			const prepared = bootstrap.prepareDefinition(request.draft, request.sessionModel);
			const definition = JSON.stringify(prepared);
			const definitionDigest = digest(definition);
			const identity = { factory_id: randomUUID(), name };
			const db = openWritableDb(path, true)!;
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				ensureV2Schema(db);
				if (db.prepare("SELECT 1 FROM factories WHERE name = ?").get(name)) throw new Error(`Factory "${name}" is already published; its v1 is unchanged`);
				db.prepare("INSERT INTO factories (factory_id, name, definition, digest) VALUES (?, ?, ?, ?)").run(identity.factory_id, name, definition, definitionDigest);
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Publication outcome uncertain for "${name}" (${identity.factory_id}); inspect with /factory list before retrying: ${error}`);
				}
				return summary(identity);
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "resume") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const authRecord = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				const priorVersion = schemaVersion(db);
				if (priorVersion === 0) throw new Error(`Factory not found: ${factoryId}`);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				verifyStoredFactory(factoryRow);
				ensureV2Schema(db);
				const existingManager = db.prepare(
					"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
				).get(factoryId) as StoredManager | undefined;
				if (existingManager) {
					verifyManagerRow(existingManager);
					if (authorityMatches(existingManager, authRecord)) {
						db.exec("COMMIT");
						inTx = false;
						return { factory: summary(factoryRow, "managed"), resumed: true, already_managed: true };
					}
					throw new Error(
						`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is already managed by another session; orphaned or active managers are not replaced in this slice`,
					);
				}
				if (hasAcceptedInputs(db, factoryId)) {
					throw missingManagerCorruptionError(factoryRow);
				}
				const resumedAt = new Date().toISOString();
				const rowWithoutDigest: Omit<StoredManager, "record_digest"> = {
					factory_id: factoryRow.factory_id,
					incarnation_id: authRecord.incarnation_id,
					authority_digest: authRecord.secret_digest,
					pi_session_id: authRecord.pi_session_id,
					pi_session_file: authRecord.pi_session_file,
					pid: authRecord.pid,
					resumed_at: resumedAt,
				};
				db.prepare(
					"INSERT INTO factory_managers (factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					rowWithoutDigest.factory_id,
					rowWithoutDigest.incarnation_id,
					rowWithoutDigest.authority_digest,
					rowWithoutDigest.pi_session_id,
					rowWithoutDigest.pi_session_file,
					rowWithoutDigest.pid,
					rowWithoutDigest.resumed_at,
					managerRecordDigest(rowWithoutDigest),
				);
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Resume outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}); inspect with /factory inspect ${factoryRow.factory_id} or retry /factory resume ${factoryRow.factory_id}: ${error}`);
				}
				return { factory: summary(factoryRow, "managed"), resumed: true, already_managed: false };
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "submit") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const reference = validateToken(request.reference, "reference");
			const { brief, brief_bytes, brief_digest } = validateBrief(request.brief);
			const authRecord = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				const version = schemaVersion(db);
				if (version === 0) throw new Error(`Factory not found: ${factoryId}`);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				verifyStoredFactory(factoryRow);
				if (version === 1) {
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
				}
				const existingManager = db.prepare(
					"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
				).get(factoryId) as StoredManager | undefined;
				if (!existingManager) {
					if (hasAcceptedInputs(db, factoryId)) throw missingManagerCorruptionError(factoryRow);
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
				}
				verifyManagerRow(existingManager);
				if (!authorityMatches(existingManager, authRecord)) {
					throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can submit`);
				}
				const storedInputs = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
				).all(factoryId) as StoredInput[];
				const verifiedInputs = storedInputs.map(verifyInputRow);
				const existingIdx = storedInputs.findIndex(row => row.reference === reference);
				if (existingIdx !== -1) {
					const existingStored = storedInputs[existingIdx]!;
					const verified = verifiedInputs[existingIdx]!;
					if (verified.brief !== brief || existingStored.brief_digest !== brief_digest) {
						throw new Error(`Submission conflict for factory "${factoryRow.name}" (${factoryRow.factory_id}): reference "${reference}" already exists with a different brief`);
					}
					db.exec("COMMIT");
					inTx = false;
					return verified;
				}
				const queuedCount = verifiedInputs.filter(row => row.disposition === "queued").length;
				if (queuedCount >= MAX_QUEUED_INPUTS) {
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) queue is full (${MAX_QUEUED_INPUTS}/${MAX_QUEUED_INPUTS} queued inputs); no inputs were evicted`);
				}
				const queue_position = verifiedInputs.reduce((max, row) => Math.max(max, row.queue_position), 0) + 1;
				const rowWithoutDigest: Omit<StoredInput, "record_digest"> = {
					input_id: randomUUID(),
					factory_id: factoryRow.factory_id,
					reference,
					queue_position,
					bound_version: "v1",
					disposition: "queued",
					brief,
					brief_bytes,
					brief_digest,
					accepted_at: new Date().toISOString(),
				};
				db.prepare(
					`INSERT INTO factory_inputs (input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					rowWithoutDigest.input_id,
					rowWithoutDigest.factory_id,
					rowWithoutDigest.reference,
					rowWithoutDigest.queue_position,
					rowWithoutDigest.bound_version,
					rowWithoutDigest.disposition,
					rowWithoutDigest.brief,
					rowWithoutDigest.brief_bytes,
					rowWithoutDigest.brief_digest,
					rowWithoutDigest.accepted_at,
					inputRecordDigest(rowWithoutDigest),
				);
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Submission outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}, reference "${reference}"); inspect with /factory receipt ${factoryRow.factory_id} ${reference} or retry with the same reference: ${error}`);
				}
				return {
					factory_id: rowWithoutDigest.factory_id,
					input_id: rowWithoutDigest.input_id,
					reference: rowWithoutDigest.reference,
					bound_version: "v1",
					disposition: "queued",
					queue_position: rowWithoutDigest.queue_position,
					brief: rowWithoutDigest.brief,
					brief_bytes: rowWithoutDigest.brief_bytes,
					accepted_at: rowWithoutDigest.accepted_at,
				};
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action !== "list" && request.action !== "inspect" && request.action !== "receipt" && request.action !== "verify_manager") {
			throw new Error("Unknown factory operation");
		}
		if (request.action === "verify_manager") requireAuthority(request.authority);
		assertNoSymlinkComponents(path);
		const missing = (id = "") => new Error(`Factory not found: ${id}`);
		if (!databaseExists(path)) {
			if (request.action === "list") return [];
			throw missing(request.factory_id);
		}
		// SQLite may roll back a hot journal after a crash. SQL in this connection cannot mutate factory records.
		const db = new DatabaseSync(path);
		try {
			db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
			const version = schemaVersion(db);
			if (version === 0) {
				if (request.action === "list") return [];
				throw missing(request.factory_id);
			}
			if (request.action === "list") {
				if (version === 1) {
					return (db.prepare("SELECT factory_id, name FROM factories ORDER BY name").all() as Identity[]).map(row => summary(row, "unmanaged"));
				}
				const rows = db.prepare(
					`SELECT f.factory_id, f.name, m.factory_id AS m_factory_id, m.incarnation_id, m.authority_digest, m.pi_session_id, m.pi_session_file, m.pid, m.resumed_at, m.record_digest,
						EXISTS (SELECT 1 FROM factory_inputs i WHERE i.factory_id = f.factory_id) AS has_inputs
					FROM factories f LEFT JOIN factory_managers m ON m.factory_id = f.factory_id ORDER BY f.name`,
				).all() as Array<Identity & { m_factory_id: string | null; has_inputs: number } & Partial<StoredManager>>;
				return rows.map(row => {
					if (row.m_factory_id === null && row.has_inputs) {
						throw missingManagerCorruptionError({ factory_id: row.factory_id, name: row.name });
					}
					if (row.m_factory_id !== null) {
						verifyManagerRow({
							factory_id: row.m_factory_id,
							incarnation_id: row.incarnation_id!,
							authority_digest: row.authority_digest!,
							pi_session_id: row.pi_session_id ?? null,
							pi_session_file: row.pi_session_file ?? null,
							pid: row.pid!,
							resumed_at: row.resumed_at!,
							record_digest: row.record_digest!,
						});
					}
					return summary({ factory_id: row.factory_id, name: row.name }, row.m_factory_id ? "managed" : "unmanaged");
				});
			}

			const factoryId = validateToken(request.factory_id, "factory_id");
			const row = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
			if (!row) throw missing(factoryId);
			const definition = verifyStoredFactory(row);

			if (request.action === "inspect") {
				if (version === 1) return { factory: summary(row, "unmanaged"), definition, queue: [] };
				const manager = db.prepare(
					"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
				).get(factoryId) as StoredManager | undefined;
				if (manager) verifyManagerRow(manager);
				const inputs = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
				).all(factoryId) as StoredInput[];
				if (!manager && inputs.length > 0) {
					throw missingManagerCorruptionError(row);
				}
				return {
					factory: summary(row, manager ? "managed" : "unmanaged"),
					definition,
					queue: inputs.map(verifyInputRow),
				};
			}

			if (request.action === "verify_manager") {
				const authRecord = requireAuthority(request.authority);
				if (version === 1) {
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
				const manager = db.prepare(
					"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
				).get(factoryId) as StoredManager | undefined;
				if (!manager) {
					if (hasAcceptedInputs(db, factoryId)) throw missingManagerCorruptionError(row);
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
				verifyManagerRow(manager);
				if (!authorityMatches(manager, authRecord)) {
					throw new Error(`Management authority mismatch for factory "${row.name}" (${row.factory_id}); only the active managing session can submit`);
				}
				return summary(row, "managed");
			}

			const hasRef = request.reference !== undefined;
			const hasId = request.input_id !== undefined;
			if (hasRef && hasId) throw new Error('Receipt lookup accepts either "reference" or "input_id", not both');
			if (!hasRef && !hasId) throw new Error('Receipt lookup requires "reference" or "input_id"');
			const lookupRef = hasRef ? validateToken(request.reference, "reference") : undefined;
			const lookupId = hasId ? validateToken(request.input_id, "input_id") : undefined;
			if (version === 1) {
				throw new Error(`Receipt not found for factory ${factoryId} (${hasRef ? `reference "${lookupRef}"` : `input_id "${lookupId}"`})`);
			}
			const stored = (hasRef
				? db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND reference = ?").get(factoryId, lookupRef!)
				: db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND input_id = ?").get(factoryId, lookupId!)
			) as StoredInput | undefined;
			if (!stored) {
				throw new Error(`Receipt not found for factory ${factoryId} (${hasRef ? `reference "${lookupRef}"` : `input_id "${lookupId}"`})`);
			}
			return verifyInputRow(stored);
		} finally { db.close(); }
	}
	return operate;
}
