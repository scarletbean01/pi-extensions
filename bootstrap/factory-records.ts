import { createHash } from "node:crypto";

export type InputDisposition = "queued" | "launching" | "running" | "blocked" | "retryable" | "settled" | "cleared" | "discarded";
export const QUEUED_DISPOSITIONS = new Set<string>(["queued", "blocked", "retryable"]);
export const VALID_DISPOSITIONS = new Set<string>(["queued", "launching", "running", "blocked", "retryable", "settled", "cleared", "discarded"]);
export const VALID_HOLD_STATES = new Set<string>(["reserved", "released", "failed_before_release"]);
export const CHECKOUT_KEY_PATTERN = /^dev:\d+:ino:\d+$/;
export const VERSION_PATTERN = /^v([1-9]\d*)$/;

export function parseVersionToken(value: unknown, label = "version"): { version: string; version_num: number } {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a version token like "v1"`);
	}
	const match = VERSION_PATTERN.exec(value);
	if (!match) {
		throw new Error(`${label} must be a version token like "v1" (got ${JSON.stringify(value)})`);
	}
	const version_num = Number(match[1]);
	if (!Number.isSafeInteger(version_num) || version_num < 1) {
		throw new Error(`${label} has an invalid version number`);
	}
	return { version: value, version_num };
}

export function validateCheckoutKey(value: unknown, label = "checkout_key"): string {
	if (typeof value !== "string" || !CHECKOUT_KEY_PATTERN.test(value)) {
		throw new Error(`${label} must be a valid physical checkout identity (dev:<n>:ino:<n>)`);
	}
	return value;
}

export interface StoredFactory {
	factory_id: string;
	name: string;
	definition: string;
	digest: string;
}

export interface StoredFactoryVersion {
	factory_id: string;
	version: string;
	version_num: number;
	definition: string;
	digest: string;
	restored_from_version: string | null;
	created_at: string;
	record_digest: string;
}

export interface StoredFactoryPointer {
	factory_id: string;
	current_version: string;
	current_version_num: number;
	definition_digest: string;
	updated_at: string;
	record_digest: string;
}

export interface StoredManager {
	factory_id: string;
	incarnation_id: string;
	authority_digest: string;
	pi_session_id: string | null;
	pi_session_file: string | null;
	pid: number;
	resumed_at: string;
	record_digest: string;
}

export interface StoredInput {
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
}

export interface StoredState {
	factory_id: string;
	established: number;
	last_input_position: number;
	record_digest: string;
}

export interface StoredAttempt {
	attempt_id: string;
	factory_id: string;
	input_id: string;
	bound_version: string;
	request_id: string;
	task_id: string;
	canonical_checkout: string;
	checkout_key: string;
	state: string;
	release_authorized: number;
	release_authorized_at: string | null;
	release_token_digest: string | null;
	release_nonce_digest: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	record_digest: string;
}

export interface StoredFactoryHold {
	factory_id: string;
	attempt_id: string;
	input_id: string;
	request_id: string;
	task_id: string;
	state: string;
	held_at: string;
	updated_at: string;
	record_digest: string;
}

export interface StoredCheckoutHold {
	canonical_checkout: string;
	checkout_key: string;
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
}

export interface StoredManagedRun {
	task_id: string;
	request_id_digest: string;
	factory_id: string;
	factory_name: string;
	factory_db_path: string;
	input_id: string;
	attempt_id: string;
	canonical_checkout: string;
	checkout_key: string;
	created_at: string;
	record_digest: string;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function managerRecordDigest(row: Omit<StoredManager, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.factory_id,
		row.incarnation_id,
		row.authority_digest,
		row.pi_session_id,
		row.pi_session_file,
		row.pid,
		row.resumed_at,
	]));
}

export function inputRecordDigest(row: Omit<StoredInput, "record_digest">): string {
	return sha256Hex(JSON.stringify([
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

export function stateRecordDigest(row: Omit<StoredState, "record_digest">): string {
	return sha256Hex(JSON.stringify([row.factory_id, row.established, row.last_input_position]));
}

export function attemptRecordDigest(row: Omit<StoredAttempt, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.attempt_id,
		row.factory_id,
		row.input_id,
		row.bound_version,
		row.request_id,
		row.task_id,
		row.canonical_checkout,
		row.checkout_key,
		row.state,
		row.release_authorized,
		row.release_authorized_at,
		row.release_token_digest,
		row.release_nonce_digest,
		row.error,
		row.created_at,
		row.updated_at,
	]));
}

export function factoryHoldRecordDigest(row: Omit<StoredFactoryHold, "record_digest">): string {
	return sha256Hex(JSON.stringify([
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

export function checkoutHoldRecordDigest(row: Omit<StoredCheckoutHold, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.canonical_checkout,
		row.checkout_key,
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

export function managedRunRecordDigest(row: Omit<StoredManagedRun, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.task_id,
		row.request_id_digest,
		row.factory_id,
		row.factory_name,
		row.factory_db_path,
		row.input_id,
		row.attempt_id,
		row.canonical_checkout,
		row.checkout_key,
		row.created_at,
	]));
}

export function factoryVersionRecordDigest(row: Omit<StoredFactoryVersion, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.factory_id,
		row.version,
		row.version_num,
		row.definition,
		row.digest,
		row.restored_from_version,
		row.created_at,
	]));
}

export function factoryPointerRecordDigest(row: Omit<StoredFactoryPointer, "record_digest">): string {
	return sha256Hex(JSON.stringify([
		row.factory_id,
		row.current_version,
		row.current_version_num,
		row.definition_digest,
		row.updated_at,
	]));
}

export function buildFactoryVersionRow(row: Omit<StoredFactoryVersion, "record_digest">): StoredFactoryVersion {
	return { ...row, record_digest: factoryVersionRecordDigest(row) };
}

export function buildFactoryPointerRow(row: Omit<StoredFactoryPointer, "record_digest">): StoredFactoryPointer {
	return { ...row, record_digest: factoryPointerRecordDigest(row) };
}

export function buildInputRow(row: Omit<StoredInput, "record_digest">): StoredInput {
	return { ...row, record_digest: inputRecordDigest(row) };
}

export function buildAttemptRow(row: Omit<StoredAttempt, "record_digest">): StoredAttempt {
	return { ...row, record_digest: attemptRecordDigest(row) };
}

export function buildFactoryHoldRow(row: Omit<StoredFactoryHold, "record_digest">): StoredFactoryHold {
	return { ...row, record_digest: factoryHoldRecordDigest(row) };
}

export function buildCheckoutHoldRow(row: Omit<StoredCheckoutHold, "record_digest">): StoredCheckoutHold {
	return { ...row, record_digest: checkoutHoldRecordDigest(row) };
}

export function buildManagedRunRow(row: Omit<StoredManagedRun, "record_digest">): StoredManagedRun {
	return { ...row, record_digest: managedRunRecordDigest(row) };
}

export function buildStateRow(factoryId: string, established: 0 | 1, lastInputPosition: number): StoredState {
	const base = { factory_id: factoryId, established, last_input_position: lastInputPosition };
	return { ...base, record_digest: stateRecordDigest(base) };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Validate persisted `factory_versions` row invariants and digests. */
export function validateFactoryVersionRow(row: StoredFactoryVersion): StoredFactoryVersion {
	if (
		!Number.isInteger(row.version_num)
		|| row.version_num < 1
		|| row.version !== `v${row.version_num}`
		|| !SHA256_HEX.test(row.digest)
		|| sha256Hex(row.definition) !== row.digest
		|| (row.restored_from_version !== null && !VERSION_PATTERN.test(row.restored_from_version))
		|| typeof row.created_at !== "string"
		|| row.created_at.length === 0
		|| !SHA256_HEX.test(row.record_digest)
		|| factoryVersionRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} version ${row.version}: version evidence mismatch`);
	}
	return row;
}

/** Validate persisted `factory_pointers` row invariants and digest. */
export function validateFactoryPointerRow(row: StoredFactoryPointer): StoredFactoryPointer {
	if (
		!Number.isInteger(row.current_version_num)
		|| row.current_version_num < 1
		|| row.current_version !== `v${row.current_version_num}`
		|| !SHA256_HEX.test(row.definition_digest)
		|| typeof row.updated_at !== "string"
		|| row.updated_at.length === 0
		|| !SHA256_HEX.test(row.record_digest)
		|| factoryPointerRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: current version pointer mismatch`);
	}
	return row;
}

/** Validate persisted `factory_inputs` row invariants and digests without mapping to public views. */
export function validateInputRow(row: StoredInput): StoredInput {
	const expectedBytes = Buffer.byteLength(row.brief, "utf8");
	if (
		!Number.isInteger(row.queue_position)
		|| row.queue_position < 1
		|| !row.brief.isWellFormed()
		|| row.brief_bytes !== expectedBytes
		|| !SHA256_HEX.test(row.brief_digest)
		|| sha256Hex(row.brief) !== row.brief_digest
		|| !SHA256_HEX.test(row.record_digest)
		|| inputRecordDigest(row) !== row.record_digest
		|| !VERSION_PATTERN.test(row.bound_version)
		|| !VALID_DISPOSITIONS.has(row.disposition)
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} input ${row.input_id}: input evidence mismatch`);
	}
	return row;
}

/** Validate persisted `factory_attempts` row invariants and digest without mapping to public views. */
export function validateAttemptRow(row: StoredAttempt): StoredAttempt {
	if (
		(row.release_authorized !== 0 && row.release_authorized !== 1)
		|| !VERSION_PATTERN.test(row.bound_version)
		|| !CHECKOUT_KEY_PATTERN.test(row.checkout_key)
		|| !SHA256_HEX.test(row.record_digest)
		|| attemptRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id} attempt ${row.attempt_id}: attempt evidence mismatch`);
	}
	return row;
}

/** Validate persisted `factory_holds` row digest. */
export function validateFactoryHoldRow(row: StoredFactoryHold): StoredFactoryHold {
	if (!SHA256_HEX.test(row.record_digest) || factoryHoldRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: factory hold evidence mismatch`);
	}
	return row;
}

/** Validate persisted `coord.checkout_holds` row digest. */
export function validateCheckoutHoldRow(row: StoredCheckoutHold): StoredCheckoutHold {
	if (
		!CHECKOUT_KEY_PATTERN.test(row.checkout_key)
		|| !SHA256_HEX.test(row.record_digest)
		|| checkoutHoldRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory coordination corruption detected for checkout ${row.canonical_checkout}: checkout hold evidence mismatch`);
	}
	return row;
}

/** Validate persisted `coord.managed_runs` row digest. */
export function validateManagedRunRow(row: StoredManagedRun): StoredManagedRun {
	if (
		!CHECKOUT_KEY_PATTERN.test(row.checkout_key)
		|| !SHA256_HEX.test(row.record_digest)
		|| managedRunRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory coordination corruption detected for run ${row.task_id}: managed run evidence mismatch`);
	}
	return row;
}
