import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BootstrapService } from "../bootstrap/lifecycle.ts";
import { generateFactoryRequestId } from "../bootstrap/factory-evidence.ts";
import {
	atomicJson,
	coordAnchorPath,
	coordMetaRecordDigest,
	errorMessage,
	factoryRunPath,
	parseCoordAnchor,
	parseFactoryManagedInfo,
	parseFactoryReleaseMarker,
	parseManifest,
	readJson,
	type BootstrapManifest,
	type FactoryManagedInfo,
} from "../bootstrap/session-store.ts";
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
type Launch = {
	action: "launch";
	factory_id: string;
	authority: ManagerAuthority;
	signal?: AbortSignal;
	assertAuthorityAndTrust?: (projectCwd?: string) => void;
};
export type FactoryRead = List | Inspect | ReceiptLookup;

type Identity = { factory_id: string; name: string };
export type ManagementState = "unmanaged" | "managed";
export type Factory = Identity & { current_version: "v1"; management: ManagementState };
export type InputDisposition = "queued" | "launching" | "running" | "blocked" | "retryable";
const QUEUED_DISPOSITIONS = new Set<string>(["queued", "blocked", "retryable"]);
const VALID_DISPOSITIONS = new Set<string>(["queued", "launching", "running", "blocked", "retryable"]);

export interface AttemptSummary {
	attempt_id: string;
	factory_id: string;
	input_id: string;
	bound_version: "v1";
	request_id: string;
	task_id: string;
	canonical_checkout: string;
	state: string;
	release_authorized: boolean;
	release_authorized_at: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	uncertainty?: string[];
	run?: {
		status: BootstrapManifest["status"];
		phase: string;
		release_marker_present: boolean;
		abort_marker_present: boolean;
		outcome?: unknown;
		pending?: string[];
		worker_errors?: string[];
		delivery_errors?: string[];
	};
}

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
	attempt?: AttemptSummary;
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
type StoredState = {
	factory_id: string;
	established: number;
	last_input_position: number;
	record_digest: string;
};
type StoredAttempt = {
	attempt_id: string;
	factory_id: string;
	input_id: string;
	bound_version: string;
	request_id: string;
	task_id: string;
	canonical_checkout: string;
	state: string;
	release_authorized: number;
	release_authorized_at: string | null;
	release_token_digest: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	record_digest: string;
};
type StoredFactoryHold = {
	factory_id: string;
	attempt_id: string;
	input_id: string;
	request_id: string;
	task_id: string;
	state: string;
	held_at: string;
	updated_at: string;
	record_digest: string;
};
type StoredCheckoutHold = {
	canonical_checkout: string;
	factory_id: string;
	factory_name: string;
	factory_db_path: string;
	attempt_id: string;
	input_id: string;
	request_id: string;
	task_id: string;
	state: string;
	held_at: string;
	updated_at: string;
	record_digest: string;
};
type StoredManagedRun = {
	task_id: string;
	request_id_digest: string;
	factory_id: string;
	factory_name: string;
	factory_db_path: string;
	input_id: string;
	attempt_id: string;
	canonical_checkout: string;
	created_at: string;
	record_digest: string;
};

export interface CapacityView {
	queue_used: number;
	queue_limit: number;
	factory_slot: "free" | "held" | "uncertain";
	checkout_slot: "free" | "held" | "uncertain";
	canonical_checkout: string;
	blocking_hold?: {
		scope: "factory" | "checkout" | "both";
		factory_id: string;
		factory_name?: string;
		input_id: string;
		attempt_id: string;
		request_id?: string;
		task_id: string;
		state: string;
		release_authorized?: boolean;
		held_at: string;
		reason?: string;
	};
}

export interface HeadStatus {
	eligible: boolean;
	input_id?: string;
	reference?: string;
	bound_version?: "v1";
	blocking_kind?: "empty" | "unmanaged" | "factory_held" | "checkout_held" | "preflight" | "compatibility" | "ceiling" | "uncertain";
	reason?: string;
}

type Inspection = {
	factory: Factory;
	definition: Definition;
	queue: InputReceipt[];
	capacity: CapacityView;
	attempts: AttemptSummary[];
	head_status: HeadStatus;
	uncertainty: string[];
};
type LaunchResult = {
	factory_id: string;
	input_id: string;
	reference: string;
	bound_version: "v1";
	attempt_id: string;
	request_id: string;
	task_id: string;
	release_authorized: boolean;
	manifest: BootstrapManifest;
};
type ResumeResult = { factory: Factory; resumed: true; already_managed: boolean };
type CommitBoundary = (phase: "before_commit" | "after_commit") => void;
export type LaunchCommitBoundary = (phase: "reserve_before_commit" | "reserve_after_commit" | "release_before_commit" | "release_after_commit") => void;
export interface FactoryOperationsOptions {
	atCommit?: CommitBoundary;
	atLaunchCommit?: LaunchCommitBoundary;
	coordinationPath?: string;
}

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

const STATE_TABLE_SQL = `
	CREATE TABLE factory_state (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		established INTEGER NOT NULL CHECK (established IN (0, 1)),
		last_input_position INTEGER NOT NULL CHECK (last_input_position >= 0),
		record_digest TEXT NOT NULL
	) STRICT;
`;

const ATTEMPT_TABLE_SQL = `
	CREATE TABLE factory_attempts (
		attempt_id TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL REFERENCES factories(factory_id),
		input_id TEXT NOT NULL REFERENCES factory_inputs(input_id),
		bound_version TEXT NOT NULL,
		request_id TEXT NOT NULL UNIQUE,
		task_id TEXT NOT NULL UNIQUE,
		canonical_checkout TEXT NOT NULL,
		state TEXT NOT NULL,
		release_authorized INTEGER NOT NULL CHECK (release_authorized IN (0, 1)),
		release_authorized_at TEXT,
		release_token_digest TEXT,
		error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const FACTORY_HOLD_TABLE_SQL = `
	CREATE TABLE factory_holds (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		attempt_id TEXT NOT NULL UNIQUE REFERENCES factory_attempts(attempt_id),
		input_id TEXT NOT NULL REFERENCES factory_inputs(input_id),
		request_id TEXT NOT NULL,
		task_id TEXT NOT NULL,
		state TEXT NOT NULL,
		held_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const COORD_META_TABLE_SQL = `
	CREATE TABLE coord.coord_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		anchor_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const CHECKOUT_HOLD_TABLE_SQL = `
	CREATE TABLE coord.checkout_holds (
		canonical_checkout TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL,
		factory_name TEXT NOT NULL,
		factory_db_path TEXT NOT NULL,
		attempt_id TEXT NOT NULL UNIQUE,
		input_id TEXT NOT NULL,
		request_id TEXT NOT NULL,
		task_id TEXT NOT NULL,
		state TEXT NOT NULL,
		held_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const MANAGED_RUN_TABLE_SQL = `
	CREATE TABLE coord.managed_runs (
		task_id TEXT PRIMARY KEY NOT NULL,
		request_id_digest TEXT NOT NULL UNIQUE,
		factory_id TEXT NOT NULL,
		factory_name TEXT NOT NULL,
		factory_db_path TEXT NOT NULL,
		input_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL UNIQUE,
		canonical_checkout TEXT NOT NULL,
		created_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
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

function stateRecordDigest(row: Omit<StoredState, "record_digest">): string {
	return digest(JSON.stringify([row.factory_id, row.established, row.last_input_position]));
}

function attemptRecordDigest(row: Omit<StoredAttempt, "record_digest">): string {
	return digest(JSON.stringify([
		row.attempt_id,
		row.factory_id,
		row.input_id,
		row.bound_version,
		row.request_id,
		row.task_id,
		row.canonical_checkout,
		row.state,
		row.release_authorized,
		row.release_authorized_at,
		row.release_token_digest,
		row.error,
		row.created_at,
		row.updated_at,
	]));
}

function factoryHoldRecordDigest(row: Omit<StoredFactoryHold, "record_digest">): string {
	return digest(JSON.stringify([
		row.factory_id,
		row.attempt_id,
		row.input_id,
		row.request_id,
		row.task_id,
		row.state,
		row.held_at,
		row.updated_at,
	]));
}

function checkoutHoldRecordDigest(row: Omit<StoredCheckoutHold, "record_digest">): string {
	return digest(JSON.stringify([
		row.canonical_checkout,
		row.factory_id,
		row.factory_name,
		row.factory_db_path,
		row.attempt_id,
		row.input_id,
		row.request_id,
		row.task_id,
		row.state,
		row.held_at,
		row.updated_at,
	]));
}

function managedRunRecordDigest(row: Omit<StoredManagedRun, "record_digest">): string {
	return digest(JSON.stringify([
		row.task_id,
		row.request_id_digest,
		row.factory_id,
		row.factory_name,
		row.factory_db_path,
		row.input_id,
		row.attempt_id,
		row.canonical_checkout,
		row.created_at,
	]));
}

function buildInputRow(row: Omit<StoredInput, "record_digest">): StoredInput {
	return { ...row, record_digest: inputRecordDigest(row) };
}

function buildAttemptRow(row: Omit<StoredAttempt, "record_digest">): StoredAttempt {
	return { ...row, record_digest: attemptRecordDigest(row) };
}

function buildFactoryHoldRow(row: Omit<StoredFactoryHold, "record_digest">): StoredFactoryHold {
	return { ...row, record_digest: factoryHoldRecordDigest(row) };
}

function buildCheckoutHoldRow(row: Omit<StoredCheckoutHold, "record_digest">): StoredCheckoutHold {
	return { ...row, record_digest: checkoutHoldRecordDigest(row) };
}

function buildManagedRunRow(row: Omit<StoredManagedRun, "record_digest">): StoredManagedRun {
	return { ...row, record_digest: managedRunRecordDigest(row) };
}

function buildStateRow(factoryId: string, established: 0 | 1, lastInputPosition: number): StoredState {
	const base = { factory_id: factoryId, established, last_input_position: lastInputPosition };
	return { ...base, record_digest: stateRecordDigest(base) };
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

function schemaVersion(db: DatabaseSync): 0 | 1 | 2 | 3 {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported factory storage version ${version}`);
	if (version === 0 && db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
		throw new Error("Factory storage corruption detected: version-zero database has a nonempty schema");
	}
	if (version >= 1 && !hasTable(db, "factories")) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing factories table`);
	}
	if (version >= 2 && (!hasTable(db, "factory_managers") || !hasTable(db, "factory_inputs") || !hasTable(db, "factory_state"))) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing required tables`);
	}
	if (version === 3 && (!hasTable(db, "factory_attempts") || !hasTable(db, "factory_holds"))) {
		throw new Error("Factory storage corruption detected: version-three database is missing required tables");
	}
	return version;
}

function hasCoordTable(db: DatabaseSync, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM coord.sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function readAnchorFile(coordPath: string): ReturnType<typeof parseCoordAnchor> | undefined {
	const anchorPath = coordAnchorPath(coordPath);
	assertNoSymlinkComponents(anchorPath);
	if (!existsSync(anchorPath)) return undefined;
	return parseCoordAnchor(readJson<unknown>(anchorPath));
}

function writeAnchorFile(coordPath: string, anchor: ReturnType<typeof parseCoordAnchor>): void {
	const anchorPath = coordAnchorPath(coordPath);
	assertNoSymlinkComponents(anchorPath);
	atomicJson(anchorPath, anchor, true);
}

function inspectCoordContinuityReadOnly(
	coordPath: string,
	db: DatabaseSync | undefined,
): { coordVersion: 0 | 1; error?: string } {
	let anchor: ReturnType<typeof parseCoordAnchor> | undefined;
	try {
		anchor = readAnchorFile(coordPath);
	} catch (error) {
		return { coordVersion: 0, error: `Invalid factory coordination continuity anchor: ${errorMessage(error)}` };
	}
	if (!db) {
		if (anchor?.state === "committed") {
			return { coordVersion: 0, error: "Factory coordination database is missing despite prior initialization continuity anchor" };
		}
		return { coordVersion: 0 };
	}
	const version = db.prepare("PRAGMA coord.user_version").get()?.user_version;
	if (version !== 0 && version !== 1) {
		return { coordVersion: 0, error: `Unsupported factory coordination storage version ${version}` };
	}
	if (version === 0) {
		if (db.prepare("SELECT 1 FROM coord.sqlite_schema LIMIT 1").get()) {
			return { coordVersion: 0, error: "Factory coordination storage corruption detected: version-zero database has a nonempty schema" };
		}
		if (anchor?.state === "committed") {
			return { coordVersion: 0, error: "Factory coordination database is uninitialized despite prior initialization continuity anchor" };
		}
		return { coordVersion: 0 };
	}
	if (!hasCoordTable(db, "coord_meta") || !hasCoordTable(db, "checkout_holds") || !hasCoordTable(db, "managed_runs")) {
		return { coordVersion: 1, error: "Factory coordination storage corruption detected: version-one database is missing required tables" };
	}
	if (!anchor) {
		return { coordVersion: 1, error: "Factory coordination continuity anchor is missing for initialized coordination database" };
	}
	const meta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
		| { id: number; anchor_id: string; created_at: string; record_digest: string }
		| undefined;
	if (!meta || coordMetaRecordDigest(meta.id, meta.anchor_id, meta.created_at) !== meta.record_digest) {
		return { coordVersion: 1, error: "Factory coordination metadata corruption detected: continuity record digest mismatch" };
	}
	if (meta.anchor_id !== anchor.anchor_id) {
		return { coordVersion: 1, error: "Factory coordination continuity mismatch: database identity does not match continuity anchor" };
	}
	return { coordVersion: 1 };
}

function ensureCoordSchema(db: DatabaseSync, coordPath: string): { newlyInitialized: boolean; anchor: ReturnType<typeof parseCoordAnchor> } {
	const version = db.prepare("PRAGMA coord.user_version").get()?.user_version;
	if (version !== 0 && version !== 1) throw new Error(`Unsupported factory coordination storage version ${version}`);
	const existingAnchor = readAnchorFile(coordPath);
	if (version === 0) {
		if (db.prepare("SELECT 1 FROM coord.sqlite_schema LIMIT 1").get()) {
			throw new Error("Factory coordination storage corruption detected: version-zero database has a nonempty schema");
		}
		if (existingAnchor && existingAnchor.state !== "pending") {
			throw new Error("Factory coordination database is uninitialized despite prior initialization continuity anchor");
		}
		const anchor: ReturnType<typeof parseCoordAnchor> = {
			version: 1,
			anchor_id: randomUUID(),
			state: "pending",
			created_at: new Date().toISOString(),
		};
		db.exec(`
			${COORD_META_TABLE_SQL}
			${CHECKOUT_HOLD_TABLE_SQL}
			${MANAGED_RUN_TABLE_SQL}
			PRAGMA coord.user_version = 1;
		`);
		db.prepare("INSERT INTO coord.coord_meta (id, anchor_id, created_at, record_digest) VALUES (?, ?, ?, ?)").run(
			1,
			anchor.anchor_id,
			anchor.created_at,
			coordMetaRecordDigest(1, anchor.anchor_id, anchor.created_at),
		);
		writeAnchorFile(coordPath, anchor);
		return { newlyInitialized: true, anchor };
	}
	if (!hasCoordTable(db, "coord_meta") || !hasCoordTable(db, "checkout_holds") || !hasCoordTable(db, "managed_runs")) {
		throw new Error("Factory coordination storage corruption detected: version-one database is missing required tables");
	}
	if (!existingAnchor) {
		throw new Error("Factory coordination continuity anchor is missing for initialized coordination database");
	}
	const meta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
		| { id: number; anchor_id: string; created_at: string; record_digest: string }
		| undefined;
	if (!meta || coordMetaRecordDigest(meta.id, meta.anchor_id, meta.created_at) !== meta.record_digest) {
		throw new Error("Factory coordination metadata corruption detected: continuity record digest mismatch");
	}
	if (meta.anchor_id !== existingAnchor.anchor_id) {
		throw new Error("Factory coordination continuity mismatch: database identity does not match continuity anchor");
	}
	return { newlyInitialized: existingAnchor.state === "pending", anchor: existingAnchor };
}

function verifyCoordSchemaForRelease(db: DatabaseSync, coordPath: string): void {
	const check = inspectCoordContinuityReadOnly(coordPath, db);
	if (check.error) throw new Error(check.error);
	if (check.coordVersion !== 1) throw new Error("Factory coordination storage is not initialized at release gate");
}

function ensureV2Schema(db: DatabaseSync): 0 | 1 | 2 | 3 {
	const version = schemaVersion(db);
	if (version === 0) {
		db.exec(`
			CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			${STATE_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
	} else if (version === 1) {
		const existingFactories = db.prepare("SELECT factory_id, name, definition, digest FROM factories").all() as StoredFactory[];
		for (const row of existingFactories) verifyStoredFactory(row);
		db.exec(`
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			${STATE_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
		const insertState = db.prepare(
			"INSERT INTO factory_state (factory_id, established, last_input_position, record_digest) VALUES (?, ?, ?, ?)",
		);
		for (const row of existingFactories) {
			const state = buildStateRow(row.factory_id, 0, 0);
			insertState.run(state.factory_id, state.established, state.last_input_position, state.record_digest);
		}
	}
	return version;
}

function ensureV3Schema(db: DatabaseSync): 0 | 1 | 2 | 3 {
	const prior = ensureV2Schema(db);
	const current = schemaVersion(db);
	if (current === 2) {
		db.exec(`
			${ATTEMPT_TABLE_SQL}
			${FACTORY_HOLD_TABLE_SQL}
			PRAGMA user_version = 3;
		`);
	}
	return prior;
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
		|| !VALID_DISPOSITIONS.has(row.disposition)
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} input ${row.input_id}: input evidence mismatch`);
	}
	return {
		factory_id: row.factory_id,
		input_id: row.input_id,
		reference: row.reference,
		bound_version: "v1",
		disposition: row.disposition as InputDisposition,
		queue_position: row.queue_position,
		brief: row.brief,
		brief_bytes: row.brief_bytes,
		accepted_at: row.accepted_at,
	};
}

function verifyAttemptRow(row: StoredAttempt): AttemptSummary {
	if (
		(row.release_authorized !== 0 && row.release_authorized !== 1)
		|| row.bound_version !== "v1"
		|| !/^[a-f0-9]{64}$/.test(row.record_digest)
		|| attemptRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} attempt ${row.attempt_id}: attempt evidence mismatch`);
	}
	return {
		attempt_id: row.attempt_id,
		factory_id: row.factory_id,
		input_id: row.input_id,
		bound_version: "v1",
		request_id: row.request_id,
		task_id: row.task_id,
		canonical_checkout: row.canonical_checkout,
		state: row.state,
		release_authorized: row.release_authorized === 1,
		release_authorized_at: row.release_authorized_at,
		error: row.error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function verifyFactoryHoldRow(row: StoredFactoryHold): StoredFactoryHold {
	if (!/^[a-f0-9]{64}$/.test(row.record_digest) || factoryHoldRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: factory hold evidence mismatch`);
	}
	return row;
}

function verifyCheckoutHoldRow(row: StoredCheckoutHold): StoredCheckoutHold {
	if (!/^[a-f0-9]{64}$/.test(row.record_digest) || checkoutHoldRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory coordination corruption detected for checkout ${row.canonical_checkout}: checkout hold evidence mismatch`);
	}
	return row;
}

function verifyManagedRunRow(row: StoredManagedRun): StoredManagedRun {
	if (!/^[a-f0-9]{64}$/.test(row.record_digest) || managedRunRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory coordination corruption detected for run ${row.task_id}: managed run evidence mismatch`);
	}
	return row;
}

function verifyStateRow(row: StoredState | undefined, identity: Identity): StoredState {
	if (!row) {
		throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing factory state evidence`);
	}
	if (
		(row.established !== 0 && row.established !== 1)
		|| !Number.isInteger(row.last_input_position)
		|| row.last_input_position < 0
		|| !/^[a-f0-9]{64}$/.test(row.record_digest)
		|| stateRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): factory state evidence mismatch`);
	}
	return row;
}

function verifyEstablishedState(
	identity: Identity,
	state: StoredState | undefined,
	manager: StoredManager | undefined,
	hasInputs: boolean,
): { state: StoredState; manager: StoredManager | undefined } {
	const verifiedState = verifyStateRow(state, identity);
	if (verifiedState.established === 0) {
		if (manager) {
			throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): manager record exists for unmanaged factory state`);
		}
		if (verifiedState.last_input_position !== 0 || hasInputs) {
			throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): accepted input evidence exists for unmanaged factory state`);
		}
		return { state: verifiedState, manager: undefined };
	}
	if (!manager) {
		throw missingManagerCorruptionError(identity);
	}
	verifyManagerRow(manager);
	return { state: verifiedState, manager };
}

function verifyQueueCompleteness(identity: Identity, inputs: StoredInput[], lastInputPosition: number): InputReceipt[] {
	const verified = inputs.map(verifyInputRow);
	if (verified.length !== lastInputPosition) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): expected ${lastInputPosition} contiguous queued inputs, found ${verified.length}`,
		);
	}
	for (let i = 0; i < verified.length; i++) {
		if (verified[i]!.queue_position !== i + 1) {
			throw new Error(
				`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing or non-contiguous queue position ${i + 1}`,
			);
		}
	}
	return verified;
}

function verifyQueueSummary(
	identity: Identity,
	lastInputPosition: number,
	inputCount: number,
	minPos: number,
	maxPos: number,
): void {
	if (inputCount !== lastInputPosition) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): expected ${lastInputPosition} queued inputs, found ${inputCount}`,
		);
	}
	if (lastInputPosition > 0 && (minPos !== 1 || maxPos !== lastInputPosition)) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing or out-of-range queue positions (expected 1..${lastInputPosition}, got ${minPos}..${maxPos})`,
		);
	}
}

function selectState(db: DatabaseSync, factoryId: string): StoredState | undefined {
	return db.prepare(
		"SELECT factory_id, established, last_input_position, record_digest FROM factory_state WHERE factory_id = ?",
	).get(factoryId) as StoredState | undefined;
}

function selectManager(db: DatabaseSync, factoryId: string): StoredManager | undefined {
	return db.prepare(
		"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
	).get(factoryId) as StoredManager | undefined;
}

function hasAcceptedInputs(db: DatabaseSync, factoryId: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM factory_inputs WHERE factory_id = ? LIMIT 1").get(factoryId));
}

function missingManagerCorruptionError(identity: Identity): Error {
	return new Error(
		`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): established management evidence exists without a manager record; refusing takeover or mutation. Recover valid receipts read-only with /factory receipt ${identity.factory_id} <reference>`,
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
		!record.revoked
		&& row.incarnation_id === record.incarnation_id
		&& row.authority_digest === record.secret_digest
		&& row.pi_session_id === record.pi_session_id
		&& row.pi_session_file === record.pi_session_file
		&& row.pid === record.pid
	);
}

function openWritableWithCoord(mainPath: string, coordPath: string, allowMissingCoordInit = false): DatabaseSync {
	assertNoSymlinkComponents(mainPath);
	assertNoSymlinkComponents(coordPath);
	if (!databaseExists(coordPath)) {
		const existingAnchor = readAnchorFile(coordPath);
		if (existingAnchor?.state === "committed") {
			throw new Error("Factory coordination database is missing despite prior initialization continuity anchor");
		}
		if (!allowMissingCoordInit) {
			throw new Error("Factory coordination database is missing");
		}
	}
	for (const dbPath of [mainPath, coordPath]) {
		createDurableDirectory(dirname(dbPath));
		try { closeSync(openSync(dbPath, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !databaseExists(dbPath)) throw error; }
		syncDirectory(dirname(dbPath));
	}
	const db = new DatabaseSync(mainPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA main.synchronous = EXTRA; PRAGMA foreign_keys = ON");
		db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
		db.exec("PRAGMA coord.synchronous = EXTRA");
		if (db.prepare("PRAGMA main.journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA coord.journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory coordination storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA main.synchronous").get()?.synchronous !== 3) throw new Error("Factory storage requires SQLite synchronous=EXTRA");
		if (db.prepare("PRAGMA coord.synchronous").get()?.synchronous !== 3) throw new Error("Factory coordination storage requires SQLite synchronous=EXTRA");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function selectAttemptsWithTokens(db: DatabaseSync, factoryId: string): { attempts: AttemptSummary[]; tokenDigests: Map<string, string | null> } {
	const rows = db.prepare(
		`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state,
			release_authorized, release_authorized_at, release_token_digest, error, created_at, updated_at, record_digest
		FROM factory_attempts WHERE factory_id = ? ORDER BY created_at ASC, rowid ASC`,
	).all(factoryId) as StoredAttempt[];
	const tokenDigests = new Map<string, string | null>();
	const attempts = rows.map(row => {
		const summaryRow = verifyAttemptRow(row);
		tokenDigests.set(row.attempt_id, row.release_token_digest);
		return summaryRow;
	});
	return { attempts, tokenDigests };
}

function selectFactoryHold(db: DatabaseSync, factoryId: string): StoredFactoryHold | undefined {
	const row = db.prepare(
		"SELECT factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest FROM factory_holds WHERE factory_id = ?",
	).get(factoryId) as StoredFactoryHold | undefined;
	return row ? verifyFactoryHoldRow(row) : undefined;
}

function selectCheckoutHold(db: DatabaseSync, canonicalCheckout: string): StoredCheckoutHold | undefined {
	const row = db.prepare(
		`SELECT canonical_checkout, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE canonical_checkout = ?`,
	).get(canonicalCheckout) as StoredCheckoutHold | undefined;
	return row ? verifyCheckoutHoldRow(row) : undefined;
}

function selectCheckoutHoldsForFactory(db: DatabaseSync, factoryId: string, factoryDbPath: string): StoredCheckoutHold[] {
	const rows = db.prepare(
		`SELECT canonical_checkout, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE factory_id = ? AND factory_db_path = ?`,
	).all(factoryId, factoryDbPath) as StoredCheckoutHold[];
	return rows.map(verifyCheckoutHoldRow);
}

function selectManagedRunsForFactory(db: DatabaseSync, factoryId: string, factoryDbPath: string): StoredManagedRun[] {
	const rows = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, created_at, record_digest
		FROM coord.managed_runs WHERE factory_id = ? AND factory_db_path = ?`,
	).all(factoryId, factoryDbPath) as StoredManagedRun[];
	return rows.map(verifyManagedRunRow);
}

function selectManagedRunsForCheckout(db: DatabaseSync, canonicalCheckout: string): StoredManagedRun[] {
	const rows = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, created_at, record_digest
		FROM coord.managed_runs WHERE canonical_checkout = ? ORDER BY created_at ASC, rowid ASC`,
	).all(canonicalCheckout) as StoredManagedRun[];
	return rows.map(verifyManagedRunRow);
}

function selectManagedRunByTaskId(db: DatabaseSync, taskId: string): StoredManagedRun | undefined {
	const row = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, created_at, record_digest
		FROM coord.managed_runs WHERE task_id = ?`,
	).get(taskId) as StoredManagedRun | undefined;
	return row ? verifyManagedRunRow(row) : undefined;
}

const VALID_HOLD_STATES = new Set(["reserved", "released", "failed_before_release"]);

function collectCheckoutEvidence(
	db: DatabaseSync,
	params: {
		coordVersion: 0 | 1;
		retainedCheckout: string;
		liveCheckout: string;
		factoryId: string;
		factoryDbPath: string;
	},
): {
	checkoutHold: StoredCheckoutHold | undefined;
	checkoutManagedRuns: StoredManagedRun[];
	factoryCheckoutHolds: StoredCheckoutHold[];
	managedRuns: StoredManagedRun[];
} {
	if (params.coordVersion !== 1) {
		return { checkoutHold: undefined, checkoutManagedRuns: [], factoryCheckoutHolds: [], managedRuns: [] };
	}
	const primaryHold = selectCheckoutHold(db, params.retainedCheckout);
	const aliasHold = params.liveCheckout !== params.retainedCheckout ? selectCheckoutHold(db, params.liveCheckout) : undefined;
	const checkoutHold = primaryHold ?? aliasHold;
	const byTask = new Map<string, StoredManagedRun>();
	for (const row of selectManagedRunsForCheckout(db, params.retainedCheckout)) byTask.set(row.task_id, row);
	if (params.liveCheckout !== params.retainedCheckout) {
		for (const row of selectManagedRunsForCheckout(db, params.liveCheckout)) byTask.set(row.task_id, row);
	}
	return {
		checkoutHold,
		checkoutManagedRuns: [...byTask.values()],
		factoryCheckoutHolds: selectCheckoutHoldsForFactory(db, params.factoryId, params.factoryDbPath),
		managedRuns: selectManagedRunsForFactory(db, params.factoryId, params.factoryDbPath),
	};
}

function classifyHeadBlockKind(errorMessageText: string): "preflight" | "compatibility" | "ceiling" {
	if (/ceiling/i.test(errorMessageText)) return "ceiling";
	if (/unsupported|canonical checkout mismatch|incompatible/i.test(errorMessageText)) return "compatibility";
	return "preflight";
}

function inspectLaunchEvidence(params: {
	factory: Identity;
	factoryDbPath: string;
	coordDbPath: string;
	definition: Definition;
	managed: boolean;
	inputs: InputReceipt[];
	attempts: AttemptSummary[];
	attemptTokenDigests?: Map<string, string | null>;
	factoryHold: StoredFactoryHold | undefined;
	checkoutHold: StoredCheckoutHold | undefined;
	checkoutManagedRuns: StoredManagedRun[];
	factoryCheckoutHolds: StoredCheckoutHold[];
	managedRuns: StoredManagedRun[];
	coordContinuityError?: string;
	bootstrap: Pick<BootstrapService, "prepareDefinition"> & Partial<Pick<BootstrapService, "prepareFromDefinition" | "status">>;
}): { capacity: CapacityView; attempts: AttemptSummary[]; head_status: HeadStatus; uncertainty: string[] } {
	const {
		factory,
		factoryDbPath,
		coordDbPath,
		definition,
		managed,
		inputs,
		attempts,
		attemptTokenDigests,
		factoryHold,
		checkoutHold,
		checkoutManagedRuns,
		factoryCheckoutHolds,
		managedRuns,
		coordContinuityError,
		bootstrap,
	} = params;
	const uncertainty: string[] = [];
	const checkoutUncertainty: string[] = [];
	const recordCheckoutUncertainty = (msg: string) => {
		uncertainty.push(msg);
		checkoutUncertainty.push(msg);
	};
	if (coordContinuityError) {
		recordCheckoutUncertainty(coordContinuityError);
	}
	const attemptById = new Map(attempts.map(a => [a.attempt_id, a]));
	const inputById = new Map(inputs.map(i => [i.input_id, i]));
	const managedRunByAttempt = new Map(managedRuns.map(r => [r.attempt_id, r]));
	const checkoutManagedRunByTask = new Map(checkoutManagedRuns.map(r => [r.task_id, r]));
	const canonicalCheckout = definition.project_cwd;

	let liveResolvedCheckout = canonicalCheckout;
	try {
		liveResolvedCheckout = realpathSync(canonicalCheckout);
		if (liveResolvedCheckout !== canonicalCheckout) {
			recordCheckoutUncertainty(`Canonical checkout ${canonicalCheckout} now resolves to ${liveResolvedCheckout}`);
		}
	} catch {
		// Missing checkout is surfaced at preflight / head_status.
	}

	const enrichedAttempts = attempts.map(attempt => {
		const attemptUncertainty: string[] = [];
		const managedRun = managedRunByAttempt.get(attempt.attempt_id);
		if (
			!managedRun
			|| managedRun.task_id !== attempt.task_id
			|| managedRun.input_id !== attempt.input_id
			|| managedRun.factory_name !== factory.name
			|| managedRun.factory_db_path !== factoryDbPath
			|| managedRun.canonical_checkout !== canonicalCheckout
			|| managedRun.request_id_digest !== digest(attempt.request_id)
		) {
			attemptUncertainty.push(`Missing or mismatched coordination managed_run record for attempt ${attempt.attempt_id}`);
		}
		const sessionDir = join(canonicalCheckout, ".pi", "agent-sessions", attempt.task_id);
		const releasePath = join(sessionDir, "release.json");
		const releaseMarkerPresent = existsSync(releasePath);
		const abortMarkerPresent = existsSync(join(sessionDir, "abort.json"));
		const expectedTokenDigest = attemptTokenDigests?.get(attempt.attempt_id) ?? null;

		let loadedManifestToken: string | undefined;
		let run: AttemptSummary["run"];
		if (bootstrap.status) {
			try {
				const st = bootstrap.status(attempt.task_id, canonicalCheckout);
				loadedManifestToken = st.manifest.token;
				run = {
					status: st.manifest.status,
					phase: st.manifest.phase,
					release_marker_present: releaseMarkerPresent,
					abort_marker_present: abortMarkerPresent,
					outcome: st.outcome,
					pending: st.pending,
					worker_errors: st.worker_errors,
					delivery_errors: st.delivery_errors,
				};
				if (st.manifest.factory_managed) {
					const fm = st.manifest.factory_managed;
					if (
						fm.factory_id !== factory.factory_id
						|| fm.factory_name !== factory.name
						|| fm.attempt_id !== attempt.attempt_id
						|| fm.input_id !== attempt.input_id
						|| fm.request_id !== attempt.request_id
						|| fm.canonical_checkout !== canonicalCheckout
						|| fm.state_db_path !== factoryDbPath
						|| fm.coord_db_path !== coordDbPath
					) {
						attemptUncertainty.push(`Manifest factory_managed metadata contradicts attempt ${attempt.attempt_id}`);
					}
				} else {
					attemptUncertainty.push(`Manifest for run ${attempt.task_id} is missing factory_managed metadata`);
				}
				if (attempt.release_authorized && (!expectedTokenDigest || digest(st.manifest.token) !== expectedTokenDigest)) {
					attemptUncertainty.push(`Manifest token digest contradicts SQLite release authorization for attempt ${attempt.attempt_id}`);
				}
			} catch (error) {
				const msg = errorMessage(error);
				if (!/No bootstrap session found/i.test(msg)) {
					attemptUncertainty.push(`Unable to read run ${attempt.task_id}: ${msg}`);
				} else if (attempt.release_authorized) {
					attemptUncertainty.push(`Release was authorized for attempt ${attempt.attempt_id} (${attempt.task_id}), but run manifest is missing`);
				}
			}
		}

		if (releaseMarkerPresent) {
			try {
				assertNoSymlinkComponents(releasePath);
				parseFactoryReleaseMarker(readJson<unknown>(releasePath), {
					task_id: attempt.task_id,
					...(loadedManifestToken !== undefined ? { token: loadedManifestToken } : {}),
					...(expectedTokenDigest ? { token_digest: expectedTokenDigest } : {}),
					factory_managed: {
						factory_id: factory.factory_id,
						input_id: attempt.input_id,
						attempt_id: attempt.attempt_id,
						request_id: attempt.request_id,
					},
				});
			} catch (error) {
				attemptUncertainty.push(`Invalid or contradictory release.json marker for attempt ${attempt.attempt_id}: ${errorMessage(error)}`);
			}
		}
		if (releaseMarkerPresent && !attempt.release_authorized) {
			attemptUncertainty.push(`Contradictory release state for attempt ${attempt.attempt_id}: release.json exists without SQLite release authorization`);
		}
		if (attempt.release_authorized && !releaseMarkerPresent) {
			attemptUncertainty.push(`Release authorization committed for attempt ${attempt.attempt_id} without release.json marker`);
		}
		const sidecarPath = factoryRunPath(sessionDir);
		if (existsSync(sidecarPath)) {
			try {
				assertNoSymlinkComponents(sidecarPath);
				const sidecar = parseFactoryManagedInfo(readJson<unknown>(sidecarPath));
				if (
					sidecar.factory_id !== factory.factory_id
					|| sidecar.factory_name !== factory.name
					|| sidecar.attempt_id !== attempt.attempt_id
					|| sidecar.input_id !== attempt.input_id
					|| sidecar.request_id !== attempt.request_id
					|| sidecar.canonical_checkout !== canonicalCheckout
					|| sidecar.state_db_path !== factoryDbPath
					|| sidecar.coord_db_path !== coordDbPath
				) {
					attemptUncertainty.push(`factory-run.json sidecar contradicts attempt ${attempt.attempt_id}`);
				}
			} catch (error) {
				attemptUncertainty.push(`Invalid factory-run.json sidecar for attempt ${attempt.attempt_id}: ${errorMessage(error)}`);
			}
		}
		const inputRow = inputById.get(attempt.input_id);
		if (!inputRow) {
			attemptUncertainty.push(`Attempt ${attempt.attempt_id} references missing input ${attempt.input_id}`);
		} else if (attempt.release_authorized && inputRow.disposition !== "running") {
			attemptUncertainty.push(`Attempt ${attempt.attempt_id} is release_authorized but input ${inputRow.input_id} disposition is "${inputRow.disposition}"`);
		} else if (!attempt.release_authorized && inputRow.disposition !== "launching") {
			attemptUncertainty.push(`Attempt ${attempt.attempt_id} is unreleased but input ${inputRow.input_id} disposition is "${inputRow.disposition}"`);
		}

		for (const item of attemptUncertainty) uncertainty.push(item);
		return {
			...attempt,
			...(attemptUncertainty.length ? { uncertainty: attemptUncertainty } : {}),
			...(run ? { run } : {}),
		};
	});

	if (checkoutHold) {
		if (!VALID_HOLD_STATES.has(checkoutHold.state)) {
			recordCheckoutUncertainty(`Checkout hold on ${checkoutHold.canonical_checkout} has invalid state "${checkoutHold.state}"`);
		}
		const matchingRun = checkoutManagedRunByTask.get(checkoutHold.task_id);
		if (
			!matchingRun
			|| matchingRun.attempt_id !== checkoutHold.attempt_id
			|| matchingRun.factory_id !== checkoutHold.factory_id
			|| matchingRun.factory_name !== checkoutHold.factory_name
			|| matchingRun.factory_db_path !== checkoutHold.factory_db_path
			|| matchingRun.input_id !== checkoutHold.input_id
			|| matchingRun.canonical_checkout !== checkoutHold.canonical_checkout
			|| matchingRun.request_id_digest !== digest(checkoutHold.request_id)
		) {
			recordCheckoutUncertainty(`Checkout hold on ${checkoutHold.canonical_checkout} (task ${checkoutHold.task_id}) lacks matching coordination managed_run record`);
		}
		for (const runRow of checkoutManagedRuns) {
			if (runRow.task_id !== checkoutHold.task_id) {
				recordCheckoutUncertainty(`Extra coordination managed_run record (${runRow.task_id}) on checkout ${canonicalCheckout} contradicts active hold (${checkoutHold.task_id})`);
			}
		}
		const ownHold = checkoutHold.factory_id === factory.factory_id && checkoutHold.factory_db_path === factoryDbPath;
		if (!ownHold) {
			const holderReleasePath = join(canonicalCheckout, ".pi", "agent-sessions", checkoutHold.task_id, "release.json");
			const holderReleasePresent = existsSync(holderReleasePath);
			if (checkoutHold.state === "released") {
				if (!holderReleasePresent) {
					recordCheckoutUncertainty(`Checkout hold for ${checkoutHold.task_id} is released without release.json marker`);
				} else {
					try {
						assertNoSymlinkComponents(holderReleasePath);
						parseFactoryReleaseMarker(readJson<unknown>(holderReleasePath), {
							task_id: checkoutHold.task_id,
							factory_managed: {
								factory_id: checkoutHold.factory_id,
								input_id: checkoutHold.input_id,
								attempt_id: checkoutHold.attempt_id,
								request_id: checkoutHold.request_id,
							},
						});
					} catch (error) {
						recordCheckoutUncertainty(`Checkout hold for ${checkoutHold.task_id} has invalid release.json marker: ${errorMessage(error)}`);
					}
				}
			} else if (holderReleasePresent) {
				recordCheckoutUncertainty(`Checkout hold for ${checkoutHold.task_id} has state "${checkoutHold.state}" while release.json exists`);
			}
		}
	} else if (checkoutManagedRuns.length > 0) {
		recordCheckoutUncertainty(
			`Orphaned coordination managed_run record(s) for checkout ${canonicalCheckout} without an active checkout hold (task_id: ${checkoutManagedRuns.map(r => r.task_id).join(", ")})`,
		);
	}

	if (factoryHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		if (
			!att
			|| att.task_id !== factoryHold.task_id
			|| att.input_id !== factoryHold.input_id
			|| att.request_id !== factoryHold.request_id
			|| att.state !== factoryHold.state
		) {
			uncertainty.push(`Factory hold references missing or mismatched attempt ${factoryHold.attempt_id}`);
		}
		if (
			!checkoutHold
			|| checkoutHold.factory_id !== factory.factory_id
			|| checkoutHold.factory_db_path !== factoryDbPath
			|| checkoutHold.attempt_id !== factoryHold.attempt_id
			|| checkoutHold.input_id !== factoryHold.input_id
			|| checkoutHold.request_id !== factoryHold.request_id
			|| checkoutHold.task_id !== factoryHold.task_id
			|| checkoutHold.state !== factoryHold.state
		) {
			recordCheckoutUncertainty(`Factory hold ${factoryHold.attempt_id} lacks matching checkout hold for ${canonicalCheckout}`);
		}
	}
	for (const ch of factoryCheckoutHolds) {
		if (!factoryHold || factoryHold.attempt_id !== ch.attempt_id || ch.canonical_checkout !== canonicalCheckout) {
			recordCheckoutUncertainty(`Checkout hold on ${ch.canonical_checkout} for factory ${factory.factory_id} lacks matching factory hold`);
		}
	}
	if (attempts.length > 0 && !factoryHold) {
		uncertainty.push(`Attempt ${attempts.at(-1)!.attempt_id} exists without an active factory hold`);
	}
	if (attempts.length > 1) {
		uncertainty.push(`Factory has ${attempts.length} recorded attempts without clearance or settlement`);
	}

	const queue_used = inputs.filter(row => QUEUED_DISPOSITIONS.has(row.disposition)).length;
	const ownCheckoutHold = checkoutHold && checkoutHold.factory_id === factory.factory_id && checkoutHold.factory_db_path === factoryDbPath;
	const factory_slot: CapacityView["factory_slot"] = uncertainty.length > 0 && (factoryHold || factoryCheckoutHolds.length > 0 || attempts.length > 0)
		? "uncertain"
		: factoryHold ? "held" : "free";
	const checkout_slot: CapacityView["checkout_slot"] =
		checkoutUncertainty.length > 0
		|| (uncertainty.length > 0 && Boolean(checkoutHold || factoryCheckoutHolds.length > 0 || factoryHold || checkoutManagedRuns.length > 0))
			? "uncertain"
			: checkoutHold ? "held" : "free";

	let blocking_hold: CapacityView["blocking_hold"];
	if (factoryHold && checkoutHold && ownCheckoutHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		blocking_hold = {
			scope: "both",
			factory_id: factory.factory_id,
			factory_name: factory.name,
			input_id: factoryHold.input_id,
			attempt_id: factoryHold.attempt_id,
			request_id: factoryHold.request_id,
			task_id: factoryHold.task_id,
			state: factoryHold.state,
			release_authorized: att?.release_authorized,
			held_at: factoryHold.held_at,
		};
	} else if (checkoutHold && !ownCheckoutHold) {
		blocking_hold = {
			scope: "checkout",
			factory_id: checkoutHold.factory_id,
			factory_name: checkoutHold.factory_name,
			input_id: checkoutHold.input_id,
			attempt_id: checkoutHold.attempt_id,
			task_id: checkoutHold.task_id,
			state: checkoutHold.state,
			held_at: checkoutHold.held_at,
			reason: `Checkout ${canonicalCheckout} is held by factory "${checkoutHold.factory_name}" (${checkoutHold.factory_id}, attempt ${checkoutHold.attempt_id}, run ${checkoutHold.task_id})`,
		};
	} else if (factoryHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		blocking_hold = {
			scope: "factory",
			factory_id: factory.factory_id,
			factory_name: factory.name,
			input_id: factoryHold.input_id,
			attempt_id: factoryHold.attempt_id,
			request_id: factoryHold.request_id,
			task_id: factoryHold.task_id,
			state: factoryHold.state,
			release_authorized: att?.release_authorized,
			held_at: factoryHold.held_at,
		};
	} else if (checkoutManagedRuns.length > 0) {
		const orphan = checkoutManagedRuns[0]!;
		blocking_hold = {
			scope: "checkout",
			factory_id: orphan.factory_id,
			factory_name: orphan.factory_name,
			input_id: orphan.input_id,
			attempt_id: orphan.attempt_id,
			task_id: orphan.task_id,
			state: "uncertain",
			held_at: orphan.created_at,
			reason: `Orphaned coordination managed_run for checkout ${canonicalCheckout} (factory "${orphan.factory_name}", ${orphan.factory_id}, run ${orphan.task_id})`,
		};
	}

	const capacity: CapacityView = {
		queue_used,
		queue_limit: MAX_QUEUED_INPUTS,
		factory_slot,
		checkout_slot,
		canonical_checkout: canonicalCheckout,
		...(blocking_hold ? { blocking_hold } : {}),
	};

	let head_status: HeadStatus;
	const head = inputs[0];
	if (!managed) {
		head_status = { eligible: false, blocking_kind: "unmanaged", reason: `Factory "${factory.name}" (${factory.factory_id}) is unmanaged` };
	} else if (uncertainty.length > 0) {
		head_status = {
			eligible: false,
			...(head ? { input_id: head.input_id, reference: head.reference, bound_version: head.bound_version } : {}),
			blocking_kind: "uncertain",
			reason: uncertainty.join("; "),
		};
	} else if (factoryHold) {
		head_status = {
			eligible: false,
			...(head ? { input_id: head.input_id, reference: head.reference, bound_version: head.bound_version } : {}),
			blocking_kind: "factory_held",
			reason: `Factory slot is held by attempt ${factoryHold.attempt_id} (input ${factoryHold.input_id}, run ${factoryHold.task_id}, state ${factoryHold.state})`,
		};
	} else if (checkoutHold) {
		head_status = {
			eligible: false,
			...(head ? { input_id: head.input_id, reference: head.reference, bound_version: head.bound_version } : {}),
			blocking_kind: "checkout_held",
			reason: `Checkout ${canonicalCheckout} is held by factory "${checkoutHold.factory_name}" (${checkoutHold.factory_id}, attempt ${checkoutHold.attempt_id}, run ${checkoutHold.task_id})`,
		};
	} else if (!head) {
		head_status = { eligible: false, blocking_kind: "empty", reason: "No queued input waiting to launch" };
	} else if (head.disposition !== "queued") {
		head_status = {
			eligible: false,
			input_id: head.input_id,
			reference: head.reference,
			bound_version: head.bound_version,
			blocking_kind: "factory_held",
			reason: `Head input ${head.input_id} (${head.reference}) has disposition "${head.disposition}"`,
		};
	} else if (bootstrap.prepareFromDefinition) {
		try {
			bootstrap.prepareFromDefinition(definition, { checkHerdrEnv: false });
			head_status = { eligible: true, input_id: head.input_id, reference: head.reference, bound_version: head.bound_version };
		} catch (error) {
			const reason = errorMessage(error);
			head_status = {
				eligible: false,
				input_id: head.input_id,
				reference: head.reference,
				bound_version: head.bound_version,
				blocking_kind: classifyHeadBlockKind(reason),
				reason,
			};
		}
	} else {
		head_status = { eligible: true, input_id: head.input_id, reference: head.reference, bound_version: head.bound_version };
	}

	return { capacity, attempts: enrichedAttempts, head_status, uncertainty };
}

export { validateToken as validateFactoryToken };

/** Shared operation boundary for factory publication, explicit resume, brief submission, launch, and read-only inspection/receipts. */
export function factoryOperations(
	path: string,
	bootstrap: Pick<BootstrapService, "prepareDefinition"> & Partial<Pick<BootstrapService, "prepareFromDefinition" | "launchFromDefinition" | "status" | "defaultCoordinationPath">>,
	commitOrOptions?: CommitBoundary | FactoryOperationsOptions,
) {
	const options: FactoryOperationsOptions = typeof commitOrOptions === "function" ? { atCommit: commitOrOptions } : (commitOrOptions ?? {});
	const atCommit = options.atCommit;
	const atLaunchCommit = options.atLaunchCommit;
	const coordPath = options.coordinationPath ?? bootstrap.defaultCoordinationPath?.() ?? join(dirname(resolve(path)), "factory-coordination.sqlite");

	function operate(request: List): Factory[];
	function operate(request: Inspect): Inspection;
	function operate(request: ReceiptLookup): InputReceipt;
	function operate(request: VerifyManager): Factory;
	function operate(request: Publish): Factory;
	function operate(request: Resume): ResumeResult;
	function operate(request: Submit): InputReceipt;
	function operate(request: Launch): Promise<LaunchResult>;
	function operate(request: FactoryRead): Factory[] | Inspection | InputReceipt;
	function operate(request: FactoryRead | VerifyManager | Publish | Resume | Submit | Launch): Factory[] | Inspection | InputReceipt | Factory | ResumeResult | Promise<LaunchResult> {
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
				const initialState = buildStateRow(identity.factory_id, 0, 0);
				db.prepare("INSERT INTO factory_state (factory_id, established, last_input_position, record_digest) VALUES (?, ?, ?, ?)").run(
					initialState.factory_id,
					initialState.established,
					initialState.last_input_position,
					initialState.record_digest,
				);
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
				const { manager: existingManager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				if (existingManager) {
					if (authorityMatches(existingManager, authRecord)) {
						db.exec("COMMIT");
						inTx = false;
						return { factory: summary(factoryRow, "managed"), resumed: true, already_managed: true };
					}
					throw new Error(
						`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is already managed by another session; orphaned or active managers are not replaced in this slice`,
					);
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
				const establishedState = buildStateRow(factoryRow.factory_id, 1, 0);
				db.prepare("UPDATE factory_state SET established = ?, last_input_position = ?, record_digest = ? WHERE factory_id = ?").run(
					establishedState.established,
					establishedState.last_input_position,
					establishedState.record_digest,
					establishedState.factory_id,
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
				const { state, manager: existingManager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				if (!existingManager) {
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
				}
				if (!authorityMatches(existingManager, authRecord)) {
					throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can submit`);
				}
				const existingStored = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND reference = ?",
				).get(factoryId, reference) as StoredInput | undefined;
				if (existingStored) {
					const verified = verifyInputRow(existingStored);
					if (verified.queue_position > state.last_input_position) {
						throw new Error(
							`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): input ${verified.input_id} position ${verified.queue_position} exceeds durable high-water mark ${state.last_input_position}`,
						);
					}
					if (verified.brief !== brief || existingStored.brief_digest !== brief_digest) {
						throw new Error(`Submission conflict for factory "${factoryRow.name}" (${factoryRow.factory_id}): reference "${reference}" already exists with a different brief`);
					}
					db.exec("COMMIT");
					inTx = false;
					return verified;
				}
				const storedInputs = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
				).all(factoryId) as StoredInput[];
				const verifiedInputs = verifyQueueCompleteness(factoryRow, storedInputs, state.last_input_position);
				const queuedCount = verifiedInputs.filter(row => QUEUED_DISPOSITIONS.has(row.disposition)).length;
				if (queuedCount >= MAX_QUEUED_INPUTS) {
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) queue is full (${MAX_QUEUED_INPUTS}/${MAX_QUEUED_INPUTS} queued inputs); no inputs were evicted`);
				}
				const queue_position = state.last_input_position + 1;
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
				const nextState = buildStateRow(factoryRow.factory_id, 1, queue_position);
				db.prepare("UPDATE factory_state SET established = ?, last_input_position = ?, record_digest = ? WHERE factory_id = ?").run(
					nextState.established,
					nextState.last_input_position,
					nextState.record_digest,
					nextState.factory_id,
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

		if (request.action === "launch") {
			return (async (): Promise<LaunchResult> => {
				if (!bootstrap.launchFromDefinition || !bootstrap.prepareFromDefinition) {
					throw new Error("Bootstrap launch service is unavailable");
				}
				const factoryId = validateToken(request.factory_id, "factory_id");
				const authRecord = requireAuthority(request.authority);
				request.assertAuthorityAndTrust?.();
				assertNoSymlinkComponents(path);
				assertNoSymlinkComponents(coordPath);
				if (!databaseExists(path)) throw new Error(`Factory not found: ${factoryId}`);

				// Pre-flight read-only check before contacting Herdr or taking any holds.
				let preflightDefinition: Definition;
				let headInput: InputReceipt;
				{
					const ro = new DatabaseSync(path);
					const hasCoord = databaseExists(coordPath);
					try {
						if (hasCoord) ro.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
						ro.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
						const version = schemaVersion(ro);
						if (version === 0) throw new Error(`Factory not found: ${factoryId}`);
						const factoryRow = ro.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
						if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
						preflightDefinition = verifyStoredFactory(factoryRow);
						if (version === 1) {
							throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
						}
						const inputs = ro.prepare(
							"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
						).all(factoryId) as StoredInput[];
						const { state, manager } = verifyEstablishedState(factoryRow, selectState(ro, factoryId), selectManager(ro, factoryId), inputs.length > 0);
						if (!manager) {
							throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
						}
						if (!authorityMatches(manager, authRecord)) {
							throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can launch`);
						}
						const verifiedInputs = verifyQueueCompleteness(factoryRow, inputs, state.last_input_position);
						const coordCheck = inspectCoordContinuityReadOnly(coordPath, hasCoord ? ro : undefined);
						const { attempts, tokenDigests } = version === 3 ? selectAttemptsWithTokens(ro, factoryId) : { attempts: [], tokenDigests: new Map<string, string | null>() };
						const factoryHold = version === 3 ? selectFactoryHold(ro, factoryId) : undefined;
						const canonicalCheckout = realpathSync(preflightDefinition.project_cwd);
						const canonicalFactoryDb = realpathSync(path);
						const coordEv = collectCheckoutEvidence(ro, {
							coordVersion: coordCheck.coordVersion,
							retainedCheckout: canonicalCheckout,
							liveCheckout: canonicalCheckout,
							factoryId,
							factoryDbPath: canonicalFactoryDb,
						});
						const inspected = inspectLaunchEvidence({
							factory: factoryRow,
							factoryDbPath: canonicalFactoryDb,
							coordDbPath: existsSync(coordPath) ? realpathSync(coordPath) : coordPath,
							definition: preflightDefinition,
							managed: true,
							inputs: verifiedInputs,
							attempts,
							attemptTokenDigests: tokenDigests,
							factoryHold,
							checkoutHold: coordEv.checkoutHold,
							checkoutManagedRuns: coordEv.checkoutManagedRuns,
							factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
							managedRuns: coordEv.managedRuns,
							coordContinuityError: coordCheck.error,
							bootstrap,
						});
						if (!inspected.head_status.eligible) {
							throw new Error(inspected.head_status.reason ?? "FIFO head is not eligible to launch");
						}
						request.assertAuthorityAndTrust?.(canonicalCheckout);
						headInput = verifiedInputs[0]!;
					} finally {
						ro.close();
					}
				}

				let committedAttemptId: string | undefined;
				let committedRequestId: string | undefined;
				let committedTaskId: string | undefined;
				let committedFactoryDbPath: string | undefined;
				let committedCoordDbPath: string | undefined;
				let committedCheckout: string | undefined;

				const manifest = await bootstrap.launchFromDefinition({
					definition: preflightDefinition,
					submittedBrief: headInput.brief,
					signal: request.signal,
					reserveAttempt: (_workspaceId, candidateTaskId) => {
						const liveAuth = requireAuthority(request.authority);
						request.assertAuthorityAndTrust?.(realpathSync(preflightDefinition.project_cwd));
						const db = openWritableWithCoord(path, coordPath, true);
						let inTx = false;
						try {
							db.exec("BEGIN IMMEDIATE");
							inTx = true;
							const priorVersion = schemaVersion(db);
							if (priorVersion === 0) throw new Error(`Factory not found: ${factoryId}`);
							const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
							if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
							const def = verifyStoredFactory(factoryRow);
							if (priorVersion === 1) {
								throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
							}
							ensureV3Schema(db);
							const coordInit = ensureCoordSchema(db, coordPath);
							const inputs = db.prepare(
								"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
							).all(factoryId) as StoredInput[];
							const { state, manager } = verifyEstablishedState(factoryRow, selectState(db, factoryId), selectManager(db, factoryId), inputs.length > 0);
							if (!manager) {
								throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
							}
							if (!authorityMatches(manager, liveAuth)) {
								throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can launch`);
							}
							const verifiedInputs = verifyQueueCompleteness(factoryRow, inputs, state.last_input_position);
							const canonicalCheckout = realpathSync(def.project_cwd);
							if (canonicalCheckout !== def.project_cwd) {
								throw new Error(`Canonical checkout mismatch: retained ${def.project_cwd} now resolves to ${canonicalCheckout}`);
							}
							const canonicalFactoryDb = realpathSync(path);
							const canonicalCoordDb = realpathSync(coordPath);
							const { attempts: existingAttempts, tokenDigests: existingTokenDigests } = selectAttemptsWithTokens(db, factoryId);
							const existingFactoryHold = selectFactoryHold(db, factoryId);
							const coordEv = collectCheckoutEvidence(db, {
								coordVersion: 1,
								retainedCheckout: canonicalCheckout,
								liveCheckout: canonicalCheckout,
								factoryId,
								factoryDbPath: canonicalFactoryDb,
							});
							const inspected = inspectLaunchEvidence({
								factory: factoryRow,
								factoryDbPath: canonicalFactoryDb,
								coordDbPath: canonicalCoordDb,
								definition: def,
								managed: true,
								inputs: verifiedInputs,
								attempts: existingAttempts,
								attemptTokenDigests: existingTokenDigests,
								factoryHold: existingFactoryHold,
								checkoutHold: coordEv.checkoutHold,
								checkoutManagedRuns: coordEv.checkoutManagedRuns,
								factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
								managedRuns: coordEv.managedRuns,
								bootstrap,
							});
							if (!inspected.head_status.eligible) {
								throw new Error(inspected.head_status.reason ?? "FIFO head is not eligible to launch");
							}
							const headRow = inputs[0]!;
							if (headRow.input_id !== headInput.input_id) {
								throw new Error(`FIFO head changed before reservation (${headRow.input_id} !== ${headInput.input_id})`);
							}
							const attemptId = `att-${randomUUID()}`;
							const requestId = generateFactoryRequestId(factoryId, attemptId);
							const taskId = candidateTaskId;
							const nowIso = new Date().toISOString();

							const updatedInput = buildInputRow({
								input_id: headRow.input_id,
								factory_id: headRow.factory_id,
								reference: headRow.reference,
								queue_position: headRow.queue_position,
								bound_version: headRow.bound_version,
								disposition: "launching",
								brief: headRow.brief,
								brief_bytes: headRow.brief_bytes,
								brief_digest: headRow.brief_digest,
								accepted_at: headRow.accepted_at,
							});
							db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(
								updatedInput.disposition,
								updatedInput.record_digest,
								updatedInput.input_id,
							);

							const attemptRow = buildAttemptRow({
								attempt_id: attemptId,
								factory_id: factoryId,
								input_id: headRow.input_id,
								bound_version: "v1",
								request_id: requestId,
								task_id: taskId,
								canonical_checkout: canonicalCheckout,
								state: "reserved",
								release_authorized: 0,
								release_authorized_at: null,
								release_token_digest: null,
								error: null,
								created_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO factory_attempts (attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state, release_authorized, release_authorized_at, release_token_digest, error, created_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								attemptRow.attempt_id, attemptRow.factory_id, attemptRow.input_id, attemptRow.bound_version,
								attemptRow.request_id, attemptRow.task_id, attemptRow.canonical_checkout, attemptRow.state,
								attemptRow.release_authorized, attemptRow.release_authorized_at, attemptRow.release_token_digest,
								attemptRow.error, attemptRow.created_at, attemptRow.updated_at, attemptRow.record_digest,
							);

							const fHoldRow = buildFactoryHoldRow({
								factory_id: factoryId,
								attempt_id: attemptId,
								input_id: headRow.input_id,
								request_id: requestId,
								task_id: taskId,
								state: "reserved",
								held_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO factory_holds (factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								fHoldRow.factory_id, fHoldRow.attempt_id, fHoldRow.input_id, fHoldRow.request_id,
								fHoldRow.task_id, fHoldRow.state, fHoldRow.held_at, fHoldRow.updated_at, fHoldRow.record_digest,
							);

							const cHoldRow = buildCheckoutHoldRow({
								canonical_checkout: canonicalCheckout,
								factory_id: factoryId,
								factory_name: factoryRow.name,
								factory_db_path: canonicalFactoryDb,
								attempt_id: attemptId,
								input_id: headRow.input_id,
								request_id: requestId,
								task_id: taskId,
								state: "reserved",
								held_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO coord.checkout_holds (canonical_checkout, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								cHoldRow.canonical_checkout, cHoldRow.factory_id, cHoldRow.factory_name, cHoldRow.factory_db_path,
								cHoldRow.attempt_id, cHoldRow.input_id, cHoldRow.request_id, cHoldRow.task_id,
								cHoldRow.state, cHoldRow.held_at, cHoldRow.updated_at, cHoldRow.record_digest,
							);

							const mRunRow = buildManagedRunRow({
								task_id: taskId,
								request_id_digest: digest(requestId),
								factory_id: factoryId,
								factory_name: factoryRow.name,
								factory_db_path: canonicalFactoryDb,
								input_id: headRow.input_id,
								attempt_id: attemptId,
								canonical_checkout: canonicalCheckout,
								created_at: nowIso,
							});
							db.prepare(
								`INSERT INTO coord.managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, created_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								mRunRow.task_id, mRunRow.request_id_digest, mRunRow.factory_id, mRunRow.factory_name,
								mRunRow.factory_db_path, mRunRow.input_id, mRunRow.attempt_id, mRunRow.canonical_checkout,
								mRunRow.created_at, mRunRow.record_digest,
							);

							const commitAuth = requireAuthority(request.authority);
							if (!authorityMatches(manager, commitAuth)) {
								throw new Error(`Management authority mismatch at reservation commit for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							request.assertAuthorityAndTrust?.(canonicalCheckout);
							atLaunchCommit?.("reserve_before_commit");
							try {
								db.exec("COMMIT");
								inTx = false;
								if (coordInit.newlyInitialized) {
									writeAnchorFile(coordPath, { ...coordInit.anchor, state: "committed" });
								}
								atLaunchCommit?.("reserve_after_commit");
							} catch (error) {
								throw new Error(`Launch reservation outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}); inspect with /factory inspect ${factoryRow.factory_id}: ${error}`);
							}

							committedAttemptId = attemptId;
							committedRequestId = requestId;
							committedTaskId = taskId;
							committedFactoryDbPath = canonicalFactoryDb;
							committedCoordDbPath = canonicalCoordDb;
							committedCheckout = canonicalCheckout;
							const factory_managed: FactoryManagedInfo = {
								version: 1,
								factory_id: factoryId,
								factory_name: factoryRow.name,
								input_id: headRow.input_id,
								attempt_id: attemptId,
								request_id: requestId,
								bound_version: "v1",
								canonical_checkout: canonicalCheckout,
								state_db_path: canonicalFactoryDb,
								coord_db_path: canonicalCoordDb,
							};
							return { request_id: requestId, task_id: taskId, factory_managed };
						} finally {
							if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
							db.close();
						}
					},
					beforeRelease: manifest => {
						// Synchronous authority + trust + hold + run identity fence with zero async gap before committing release_authorized = 1.
						const liveAuth = requireAuthority(request.authority);
						request.assertAuthorityAndTrust?.(committedCheckout);
						if (!committedAttemptId || !committedRequestId || !committedTaskId || !committedCheckout || !committedFactoryDbPath || !committedCoordDbPath) {
							throw new Error("Missing committed launch reservation at release gate");
						}
						if (manifest.task_id !== committedTaskId) {
							throw new Error(`Task ID mismatch at release gate (${manifest.task_id} !== ${committedTaskId})`);
						}
						if (manifest.project_cwd !== committedCheckout || realpathSync(committedCheckout) !== committedCheckout) {
							throw new Error("Canonical checkout mismatch at release gate");
						}
						if (realpathSync(path) !== committedFactoryDbPath || realpathSync(coordPath) !== committedCoordDbPath) {
							throw new Error("Factory database path mismatch at release gate");
						}
						if (typeof manifest.token !== "string" || manifest.token.length === 0) {
							throw new Error("Missing launch token at release gate");
						}
						const expectedManaged: Record<keyof FactoryManagedInfo, unknown> = {
							version: 1,
							factory_id: factoryId,
							factory_name: manifest.factory_managed?.factory_name,
							input_id: headInput.input_id,
							attempt_id: committedAttemptId,
							request_id: committedRequestId,
							bound_version: "v1",
							canonical_checkout: committedCheckout,
							state_db_path: committedFactoryDbPath,
							coord_db_path: committedCoordDbPath,
						};
						if (!manifest.factory_managed) {
							throw new Error("Manifest is missing factory_managed metadata at release gate");
						}
						const manifestMeta = parseFactoryManagedInfo(manifest.factory_managed);
						assertNoSymlinkComponents(manifest.session_dir);
						const sidecarPath = factoryRunPath(manifest.session_dir);
						const diskManifestPath = join(manifest.session_dir, "manifest.json");
						if (!existsSync(sidecarPath) || !existsSync(diskManifestPath)) {
							throw new Error("Missing required factory run metadata files at release gate");
						}
						const sidecarMeta = parseFactoryManagedInfo(readJson<unknown>(sidecarPath));
						const diskManifest = parseManifest(readJson<unknown>(diskManifestPath), committedTaskId);
						if (diskManifest.token !== manifest.token || !diskManifest.factory_managed) {
							throw new Error("On-disk manifest disagrees with release token or factory metadata");
						}
						const diskMeta = parseFactoryManagedInfo(diskManifest.factory_managed);
						for (const key of ["factory_id", "input_id", "attempt_id", "request_id", "canonical_checkout", "state_db_path", "coord_db_path"] as const) {
							if (manifestMeta[key] !== expectedManaged[key] || sidecarMeta[key] !== expectedManaged[key] || diskMeta[key] !== expectedManaged[key]) {
								throw new Error(`Factory run metadata mismatch at release gate (${key})`);
							}
						}
						const db = openWritableWithCoord(path, coordPath);
						let inTx = false;
						try {
							db.exec("BEGIN IMMEDIATE");
							inTx = true;
							if (schemaVersion(db) !== 3) throw new Error("Factory storage version mismatch at release gate");
							verifyCoordSchemaForRelease(db, coordPath);
							const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
							if (!factoryRow) throw new Error(`Factory not found at release gate: ${factoryId}`);
							verifyStoredFactory(factoryRow);
							if (manifestMeta.factory_name !== factoryRow.name || sidecarMeta.factory_name !== factoryRow.name || diskMeta.factory_name !== factoryRow.name) {
								throw new Error("Factory name mismatch in run metadata at release gate");
							}
							const { manager } = verifyEstablishedState(factoryRow, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
							if (!manager || !authorityMatches(manager, liveAuth)) {
								throw new Error(`Management authority mismatch at release gate for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							const attemptRow = db.prepare(
								`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state,
									release_authorized, release_authorized_at, release_token_digest, error, created_at, updated_at, record_digest
								FROM factory_attempts WHERE attempt_id = ?`,
							).get(committedAttemptId) as StoredAttempt | undefined;
							if (!attemptRow) throw new Error(`Attempt ${committedAttemptId} missing at release gate`);
							verifyAttemptRow(attemptRow);
							if (
								attemptRow.factory_id !== factoryId
								|| attemptRow.input_id !== headInput.input_id
								|| attemptRow.bound_version !== "v1"
								|| attemptRow.request_id !== committedRequestId
								|| attemptRow.task_id !== committedTaskId
								|| attemptRow.canonical_checkout !== committedCheckout
								|| attemptRow.state !== "reserved"
								|| attemptRow.release_authorized !== 0
								|| attemptRow.release_token_digest !== null
							) {
								throw new Error(`Attempt ${committedAttemptId} state or identity is not eligible for release (${attemptRow.state})`);
							}
							const fHold = selectFactoryHold(db, factoryId);
							const cHold = selectCheckoutHold(db, committedCheckout);
							const mRun = selectManagedRunByTaskId(db, committedTaskId);
							const checkoutRuns = selectManagedRunsForCheckout(db, committedCheckout);
							if (
								!fHold
								|| fHold.attempt_id !== committedAttemptId
								|| fHold.input_id !== headInput.input_id
								|| fHold.request_id !== committedRequestId
								|| fHold.task_id !== committedTaskId
								|| fHold.state !== "reserved"
								|| !cHold
								|| cHold.canonical_checkout !== committedCheckout
								|| cHold.factory_id !== factoryId
								|| cHold.factory_name !== factoryRow.name
								|| cHold.factory_db_path !== committedFactoryDbPath
								|| cHold.attempt_id !== committedAttemptId
								|| cHold.input_id !== headInput.input_id
								|| cHold.request_id !== committedRequestId
								|| cHold.task_id !== committedTaskId
								|| cHold.state !== "reserved"
							) {
								throw new Error(`Hold mismatch at release gate for attempt ${committedAttemptId}`);
							}
							if (
								!mRun
								|| checkoutRuns.length !== 1
								|| mRun.task_id !== committedTaskId
								|| mRun.request_id_digest !== digest(committedRequestId)
								|| mRun.factory_id !== factoryId
								|| mRun.factory_name !== factoryRow.name
								|| mRun.factory_db_path !== committedFactoryDbPath
								|| mRun.input_id !== headInput.input_id
								|| mRun.attempt_id !== committedAttemptId
								|| mRun.canonical_checkout !== committedCheckout
							) {
								throw new Error(`Managed run association missing or mismatched at release gate for run ${committedTaskId}`);
							}
							const inputRow = db.prepare(
								"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?",
							).get(headInput.input_id) as StoredInput | undefined;
							if (!inputRow) throw new Error(`Input ${headInput.input_id} missing at release gate`);
							verifyInputRow(inputRow);
							if (inputRow.factory_id !== factoryId || inputRow.bound_version !== "v1" || inputRow.disposition !== "launching") {
								throw new Error(`Input ${headInput.input_id} state is not eligible for release (${inputRow.disposition})`);
							}

							const nowIso = new Date().toISOString();
							const tokenDigest = digest(manifest.token);
							const nextAttempt = buildAttemptRow({
								attempt_id: attemptRow.attempt_id,
								factory_id: attemptRow.factory_id,
								input_id: attemptRow.input_id,
								bound_version: attemptRow.bound_version,
								request_id: attemptRow.request_id,
								task_id: attemptRow.task_id,
								canonical_checkout: attemptRow.canonical_checkout,
								state: "released",
								release_authorized: 1,
								release_authorized_at: nowIso,
								release_token_digest: tokenDigest,
								error: null,
								created_at: attemptRow.created_at,
								updated_at: nowIso,
							});
							db.prepare(
								"UPDATE factory_attempts SET state = ?, release_authorized = ?, release_authorized_at = ?, release_token_digest = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ?",
							).run(
								nextAttempt.state,
								nextAttempt.release_authorized,
								nextAttempt.release_authorized_at,
								nextAttempt.release_token_digest,
								nextAttempt.updated_at,
								nextAttempt.record_digest,
								nextAttempt.attempt_id,
							);

							const nextInput = buildInputRow({
								input_id: inputRow.input_id,
								factory_id: inputRow.factory_id,
								reference: inputRow.reference,
								queue_position: inputRow.queue_position,
								bound_version: inputRow.bound_version,
								disposition: "running",
								brief: inputRow.brief,
								brief_bytes: inputRow.brief_bytes,
								brief_digest: inputRow.brief_digest,
								accepted_at: inputRow.accepted_at,
							});
							db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(
								nextInput.disposition,
								nextInput.record_digest,
								nextInput.input_id,
							);

							const nextFHold = buildFactoryHoldRow({
								factory_id: fHold.factory_id,
								attempt_id: fHold.attempt_id,
								input_id: fHold.input_id,
								request_id: fHold.request_id,
								task_id: fHold.task_id,
								state: "released",
								held_at: fHold.held_at,
								updated_at: nowIso,
							});
							db.prepare("UPDATE factory_holds SET state = ?, updated_at = ?, record_digest = ? WHERE factory_id = ?").run(
								nextFHold.state, nextFHold.updated_at, nextFHold.record_digest, nextFHold.factory_id,
							);

							const nextCHold = buildCheckoutHoldRow({
								canonical_checkout: cHold.canonical_checkout,
								factory_id: cHold.factory_id,
								factory_name: cHold.factory_name,
								factory_db_path: cHold.factory_db_path,
								attempt_id: cHold.attempt_id,
								input_id: cHold.input_id,
								request_id: cHold.request_id,
								task_id: cHold.task_id,
								state: "released",
								held_at: cHold.held_at,
								updated_at: nowIso,
							});
							db.prepare("UPDATE coord.checkout_holds SET state = ?, updated_at = ?, record_digest = ? WHERE canonical_checkout = ?").run(
								nextCHold.state, nextCHold.updated_at, nextCHold.record_digest, nextCHold.canonical_checkout,
							);

							const commitAuth = requireAuthority(request.authority);
							if (!authorityMatches(manager, commitAuth)) {
								throw new Error(`Management authority mismatch at release commit for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							request.assertAuthorityAndTrust?.(committedCheckout);
							atLaunchCommit?.("release_before_commit");
							try {
								db.exec("COMMIT");
								inTx = false;
								atLaunchCommit?.("release_after_commit");
							} catch (error) {
								throw new Error(`Release authorization outcome uncertain for attempt ${committedAttemptId}: ${error}`);
							}

							return {
								factory_id: factoryId,
								input_id: headInput.input_id,
								attempt_id: committedAttemptId,
								request_id: committedRequestId,
								release_authorized_at: nowIso,
							};
						} finally {
							if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
							db.close();
						}
					},
					onBeforeReleaseError: (taskId, errorText) => {
						if (!committedAttemptId) return;
						try {
							const db = openWritableWithCoord(path, coordPath, false);
							let inTx = false;
							try {
								db.exec("BEGIN IMMEDIATE");
								inTx = true;
								if (schemaVersion(db) !== 3) throw new Error("Factory storage version mismatch");
								verifyCoordSchemaForRelease(db, coordPath);
								const attemptRow = db.prepare(
									`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state,
										release_authorized, release_authorized_at, release_token_digest, error, created_at, updated_at, record_digest
									FROM factory_attempts WHERE attempt_id = ?`,
								).get(committedAttemptId) as StoredAttempt | undefined;
								if (attemptRow) {
									verifyAttemptRow(attemptRow);
									if (attemptRow.release_authorized === 0 && attemptRow.task_id === taskId) {
										const nowIso = new Date().toISOString();
										const failedAttempt = buildAttemptRow({
											...attemptRow,
											state: "failed_before_release",
											error: errorText,
											updated_at: nowIso,
										});
										db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ?").run(
											failedAttempt.state, failedAttempt.error, failedAttempt.updated_at, failedAttempt.record_digest, failedAttempt.attempt_id,
										);
										const fHold = selectFactoryHold(db, factoryId);
										if (fHold && fHold.attempt_id === committedAttemptId) {
											const nextFHold = buildFactoryHoldRow({ ...fHold, state: "failed_before_release", updated_at: nowIso });
											db.prepare("UPDATE factory_holds SET state = ?, updated_at = ?, record_digest = ? WHERE factory_id = ?").run(
												nextFHold.state, nextFHold.updated_at, nextFHold.record_digest, nextFHold.factory_id,
											);
										}
										const cHold = committedCheckout ? selectCheckoutHold(db, committedCheckout) : undefined;
										if (cHold && cHold.attempt_id === committedAttemptId) {
											const nextCHold = buildCheckoutHoldRow({ ...cHold, state: "failed_before_release", updated_at: nowIso });
											db.prepare("UPDATE coord.checkout_holds SET state = ?, updated_at = ?, record_digest = ? WHERE canonical_checkout = ?").run(
												nextCHold.state, nextCHold.updated_at, nextCHold.record_digest, nextCHold.canonical_checkout,
											);
										}
									}
								}
								db.exec("COMMIT");
								inTx = false;
							} finally {
								if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
								db.close();
							}
						} catch {
							// Conservative holds remain even if recording failure text could not commit.
						}
					},
				});
				if (manifest.status === "error") {
					throw new Error(manifest.error ?? "Factory launch failed before release");
				}
				return {
					factory_id: factoryId,
					input_id: headInput.input_id,
					reference: headInput.reference,
					bound_version: "v1" as const,
					attempt_id: committedAttemptId!,
					request_id: committedRequestId!,
					task_id: committedTaskId!,
					release_authorized: true,
					manifest,
				};
			})();
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
		const hasCoord = request.action === "inspect" && databaseExists(coordPath);
		if (hasCoord) assertNoSymlinkComponents(coordPath);
		const db = new DatabaseSync(path);
		try {
			if (hasCoord) db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
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
					`SELECT f.factory_id, f.name,
						s.factory_id AS s_factory_id, s.established, s.last_input_position, s.record_digest AS s_record_digest,
						m.factory_id AS m_factory_id, m.incarnation_id, m.authority_digest, m.pi_session_id, m.pi_session_file, m.pid, m.resumed_at, m.record_digest AS m_record_digest,
						COALESCE(i.input_count, 0) AS input_count,
						COALESCE(i.min_pos, 0) AS min_pos,
						COALESCE(i.max_pos, 0) AS max_pos
					FROM factories f
					LEFT JOIN factory_state s ON s.factory_id = f.factory_id
					LEFT JOIN factory_managers m ON m.factory_id = f.factory_id
					LEFT JOIN (
						SELECT factory_id, COUNT(*) AS input_count, MIN(queue_position) AS min_pos, MAX(queue_position) AS max_pos
						FROM factory_inputs
						GROUP BY factory_id
					) i ON i.factory_id = f.factory_id
					ORDER BY f.name`,
				).all() as Array<Identity & {
					s_factory_id: string | null;
					established: number | null;
					last_input_position: number | null;
					s_record_digest: string | null;
					m_factory_id: string | null;
					m_record_digest: string | null;
					input_count: number;
					min_pos: number;
					max_pos: number;
				} & Partial<Omit<StoredManager, "record_digest">>>;
				return rows.map(row => {
					const identity = { factory_id: row.factory_id, name: row.name };
					const state: StoredState | undefined = row.s_factory_id !== null ? {
						factory_id: row.s_factory_id,
						established: row.established!,
						last_input_position: row.last_input_position!,
						record_digest: row.s_record_digest!,
					} : undefined;
					const manager: StoredManager | undefined = row.m_factory_id !== null ? {
						factory_id: row.m_factory_id,
						incarnation_id: row.incarnation_id!,
						authority_digest: row.authority_digest!,
						pi_session_id: row.pi_session_id ?? null,
						pi_session_file: row.pi_session_file ?? null,
						pid: row.pid!,
						resumed_at: row.resumed_at!,
						record_digest: row.m_record_digest!,
					} : undefined;
					const { state: verifiedState, manager: verifiedManager } = verifyEstablishedState(identity, state, manager, row.input_count > 0);
					if (verifiedManager) {
						verifyQueueSummary(identity, verifiedState.last_input_position, row.input_count, row.min_pos, row.max_pos);
					}
					return summary(identity, verifiedManager ? "managed" : "unmanaged");
				});
			}

			const factoryId = validateToken(request.factory_id, "factory_id");
			const row = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
			if (!row) throw missing(factoryId);
			const definition = verifyStoredFactory(row);

			if (request.action === "inspect") {
				const coordCheck = inspectCoordContinuityReadOnly(coordPath, hasCoord ? db : undefined);
				const canonicalFactoryDb = realpathSync(path);
				const canonicalCoordDb = existsSync(coordPath) ? realpathSync(coordPath) : coordPath;
				let liveCheckout = definition.project_cwd;
				try { liveCheckout = realpathSync(definition.project_cwd); } catch { /* handled in inspectLaunchEvidence */ }
				const coordEv = collectCheckoutEvidence(db, {
					coordVersion: coordCheck.coordVersion,
					retainedCheckout: definition.project_cwd,
					liveCheckout,
					factoryId,
					factoryDbPath: canonicalFactoryDb,
				});

				if (version === 1) {
					const ev = inspectLaunchEvidence({
						factory: row,
						factoryDbPath: canonicalFactoryDb,
						coordDbPath: canonicalCoordDb,
						definition,
						managed: false,
						inputs: [],
						attempts: [],
						factoryHold: undefined,
						checkoutHold: coordEv.checkoutHold,
						checkoutManagedRuns: coordEv.checkoutManagedRuns,
						factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
						managedRuns: coordEv.managedRuns,
						coordContinuityError: coordCheck.error,
						bootstrap,
					});
					return { factory: summary(row, "unmanaged"), definition, queue: [], ...ev };
				}
				const inputs = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
				).all(factoryId) as StoredInput[];
				const { state, manager } = verifyEstablishedState(row, selectState(db, factoryId), selectManager(db, factoryId), inputs.length > 0);
				const { attempts, tokenDigests } = version === 3 ? selectAttemptsWithTokens(db, factoryId) : { attempts: [], tokenDigests: new Map<string, string | null>() };
				const factoryHold = version === 3 ? selectFactoryHold(db, factoryId) : undefined;
				if (!manager) {
					const ev = inspectLaunchEvidence({
						factory: row,
						factoryDbPath: canonicalFactoryDb,
						coordDbPath: canonicalCoordDb,
						definition,
						managed: false,
						inputs: [],
						attempts,
						attemptTokenDigests: tokenDigests,
						factoryHold,
						checkoutHold: coordEv.checkoutHold,
						checkoutManagedRuns: coordEv.checkoutManagedRuns,
						factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
						managedRuns: coordEv.managedRuns,
						coordContinuityError: coordCheck.error,
						bootstrap,
					});
					return { factory: summary(row, "unmanaged"), definition, queue: [], ...ev };
				}
				const verifiedQueue = verifyQueueCompleteness(row, inputs, state.last_input_position);
				const ev = inspectLaunchEvidence({
					factory: row,
					factoryDbPath: canonicalFactoryDb,
					coordDbPath: canonicalCoordDb,
					definition,
					managed: true,
					inputs: verifiedQueue,
					attempts,
					attemptTokenDigests: tokenDigests,
					factoryHold,
					checkoutHold: coordEv.checkoutHold,
					checkoutManagedRuns: coordEv.checkoutManagedRuns,
					factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
					managedRuns: coordEv.managedRuns,
					coordContinuityError: coordCheck.error,
					bootstrap,
				});
				const attemptByInput = new Map(ev.attempts.map(a => [a.input_id, a]));
				const queueWithAttempts = verifiedQueue.map(item => {
					const att = attemptByInput.get(item.input_id);
					return att ? { ...item, attempt: att } : item;
				});
				return {
					factory: summary(row, "managed"),
					definition,
					queue: queueWithAttempts,
					...ev,
				};
			}

			if (request.action === "verify_manager") {
				const authRecord = requireAuthority(request.authority);
				if (version === 1) {
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
				const { manager } = verifyEstablishedState(row, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
				if (!manager) {
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
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
			const receipt = verifyInputRow(stored);
			if (version === 3) {
				const attemptRow = db.prepare(
					`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state,
						release_authorized, release_authorized_at, release_token_digest, error, created_at, updated_at, record_digest
					FROM factory_attempts WHERE input_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				).get(receipt.input_id) as StoredAttempt | undefined;
				if (attemptRow) {
					return { ...receipt, attempt: verifyAttemptRow(attemptRow) };
				}
			}
			return receipt;
		} finally { db.close(); }
	}
	return operate;
}
