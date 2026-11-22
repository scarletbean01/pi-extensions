/**
 * Durable human-direction requests of a factory-managed attempt. Every function runs inside the caller's transaction on the factory
 * database (see `inTransaction`), so a response and a cancellation are ordered by one lock in both race orders: cancellation fences
 * the attempt, and a fenced attempt can neither create, receive a response to, nor consume a request.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { InterventionChoice, InterventionPolicy } from "./intervention.ts";
import { sha256Hex, validateAttemptRow, validateFactoryVersionRow, type StoredAttempt, type StoredFactoryVersion } from "./factory-records.ts";

export type TerminationReason = "cancelled" | "failed" | "closed";
export type RequestState = "pending" | "responded" | TerminationReason;
const STATES = new Set<string>(["pending", "responded", "cancelled", "failed", "closed"]);
const REASONS = new Set<string>(["cancelled", "failed", "closed"]);
export interface RequestRecommendation { choice_id: string; rationale?: string }
export type RequestResponse = { kind: "choice"; choice_id: string; guidance?: string } | { kind: "decline"; guidance?: string };
/** The human who answered, only where the manager session identity is reliably known. */
export interface Responder { incarnation_id: string; pi_session_id: string | null }

export interface StoredRequest {
	request_id: string;
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	node_id: string;
	node_attempt_id: string;
	question: string;
	reason: string;
	evidence: string;
	choices: string;
	recommendation: string | null;
	state: RequestState;
	created_at: string;
	response: string | null;
	responder: string | null;
	responded_at: string | null;
	consumed_at: string | null;
	terminated_at: string | null;
	terminated_reason: TerminationReason | null;
	record_digest: string;
}

export interface DirectionRequestView {
	request_id: string;
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	node_id: string;
	node_attempt_id: string;
	question: string;
	reason: string;
	evidence: string[];
	choices: InterventionChoice[];
	recommendation?: RequestRecommendation;
	state: RequestState;
	created_at: string;
	/** Recorded, consumed and terminated are separate observations. */
	response_recorded: boolean;
	response?: RequestResponse & { responded_at: string; responder?: Responder };
	consumption: "not_applicable" | "awaiting_consumption" | "consumed" | "never_consumed";
	consumed_at?: string;
	terminated?: { reason: TerminationReason; at: string };
	/** Runtime reconciliation never changes the saved response or consumption claim. */
	reconciliation?: "pending" | "continuing" | "resolved" | "cancelled" | "failed" | "uncertain";
	can_respond?: boolean;
	can_redeliver?: boolean;
	recovery_reason?: string;
}

export interface NewRequest {
	factory_id: string; input_id: string; attempt_id: string; task_id: string; node_id: string; node_attempt_id: string;
	question: string; reason: string; evidence?: string[]; choices: string[]; recommendation?: RequestRecommendation;
}

const TEXT_MAX = 2000;
const EVIDENCE_MAX = 16;
const EVIDENCE_ITEM_MAX = 500;
const ID_PATTERN = /^[^\s\0]{1,256}$/;

export const REQUEST_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS factory_requests (
		request_id TEXT PRIMARY KEY, factory_id TEXT NOT NULL, input_id TEXT NOT NULL, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL,
		node_id TEXT NOT NULL, node_attempt_id TEXT NOT NULL, question TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL,
		choices TEXT NOT NULL, recommendation TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, response TEXT, responder TEXT,
		responded_at TEXT, consumed_at TEXT, terminated_at TEXT, terminated_reason TEXT, record_digest TEXT NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS factory_requests_one_pending ON factory_requests (attempt_id, node_id, node_attempt_id) WHERE state = 'pending';
	CREATE TABLE IF NOT EXISTS factory_request_fences (
		attempt_id TEXT PRIMARY KEY, reason TEXT NOT NULL, fenced_at TEXT NOT NULL, record_digest TEXT NOT NULL
	);
`;

// Version 9 adds affirmative evidence that Pi observed the claimed answer as a tool result.
// Migration leaves this table empty: a v8 claim alone cannot prove the answer reached Pi.
export const DIRECTION_DELIVERY_TABLE_SQL = `CREATE TABLE factory_direction_deliveries (
	request_id TEXT PRIMARY KEY REFERENCES factory_requests(request_id), record_digest TEXT NOT NULL
) STRICT;`;

export interface DirectionReceiver {
	instance_id: string;
	run_token: string;
	session_id: string;
	incarnation: string;
	pid: number;
	boot: string;
	start: string;
}
interface Mailbox {
	request_id: string;
	factory_id: string;
	identity: string | null;
	waiting: number;
	wake: number;
	digest: string;
}

/** Read process identity directly. An existing PID (or a fresh heartbeat) is not sufficient proof. */
export function directionProcess(pid: number) {
	const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
	if (!/^[0-9a-f-]{36}$/i.test(boot) || !/^\d+$/.test(fields[19] ?? "")) throw new Error("Unreadable requester process identity");
	return { boot, start: fields[19], state: fields[0] };
}

function mailboxDigest(row: Omit<Mailbox, "digest">): string {
	return sha256Hex(JSON.stringify([row.request_id, row.factory_id, row.identity, row.waiting, row.wake]));
}

/** v6/v7 have no receiver binding. Keep their response/claim history, never infer a live receiver. */
export function migrateRequestMailboxes(db: DatabaseSync): void {
	assertRequestTables(db);
	db.exec(`CREATE TABLE factory_direction_mailboxes (
		request_id TEXT PRIMARY KEY REFERENCES factory_requests(request_id), factory_id TEXT NOT NULL,
		identity TEXT, waiting INTEGER NOT NULL, wake INTEGER NOT NULL, digest TEXT NOT NULL
	) STRICT; CREATE INDEX factory_direction_mailboxes_by_factory ON factory_direction_mailboxes(factory_id);`);
	const rows = db.prepare("SELECT * FROM factory_requests").all() as unknown as StoredRequest[];
	for (const row of rows) insertMailbox(db, validated(row), null);
}

export function assertRequestTables(db: DatabaseSync): void {
	if (!hasRequestTables(db)) throw new Error("Factory direction request or fence table is missing; restore the original evidence");
}

export function requestVersion(db: DatabaseSync): number {
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
	if (version >= 6) assertRequestTables(db);
	if (version >= 8 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_direction_mailboxes'").get()) {
		throw new Error("Factory direction mailbox table is missing; restore the original evidence");
	}
	if (version === 9 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_direction_deliveries'").get()) {
		throw new Error("Factory direction delivery table is missing; restore the original evidence");
	}
	return version;
}

export function assertRequestSchema(db: DatabaseSync): void {
	const version = requestVersion(db);
	if (version !== 9) throw new Error(`Factory storage version ${version} cannot hold verified direction waits; explicitly resume management to migrate it`);
}

function insertMailbox(db: DatabaseSync, request: StoredRequest, receiver: DirectionReceiver | null): void {
	const row = { request_id: request.request_id, factory_id: request.factory_id, identity: receiver ? JSON.stringify(receiver) : null, waiting: receiver ? 1 : 0, wake: 0 };
	db.prepare("INSERT INTO factory_direction_mailboxes VALUES (?, ?, ?, ?, ?, ?)").run(row.request_id, row.factory_id, row.identity, row.waiting, row.wake, mailboxDigest(row));
}

function mailbox(db: DatabaseSync, request: StoredRequest): Mailbox | undefined {
	if (requestVersion(db) < 8) return undefined;
	const row = db.prepare("SELECT * FROM factory_direction_mailboxes WHERE request_id = ?").get(request.request_id) as Mailbox | undefined;
	if (!row || row.factory_id !== request.factory_id || row.digest !== mailboxDigest(row) || ![0, 1].includes(row.waiting) || ![0, 1].includes(row.wake)
		|| (!row.identity && (row.waiting || row.wake)) || (row.wake && !request.response) || (row.waiting && request.consumed_at)) {
		throw new Error(`Request ${request.request_id} has missing or contradictory direction mailbox evidence`);
	}
	return row;
}

function updateMailbox(db: DatabaseSync, row: Mailbox, waiting: number, wake: number): void {
	const updated = { ...row, waiting, wake };
	db.prepare("UPDATE factory_direction_mailboxes SET waiting = ?, wake = ?, digest = ? WHERE request_id = ?")
		.run(waiting, wake, mailboxDigest(updated), row.request_id);
}

export function originalReceiver(db: DatabaseSync, request: StoredRequest, requireWaiting: boolean): DirectionReceiver {
	const row = mailbox(db, request);
	if (!row?.identity || (requireWaiting && !row.waiting)) throw new Error("No original waiting invocation is verified (legacy, missing or interrupted wait)");
	return parseReceiver(row.identity);
}

const RECEIVER_TEXT_FIELDS = ["instance_id", "run_token", "session_id", "incarnation", "boot", "start"] as const;

function parseReceiver(identity: string): DirectionReceiver {
	const receiver = JSON.parse(identity) as DirectionReceiver;
	if (!receiver || !Number.isSafeInteger(receiver.pid) || receiver.pid <= 0 || RECEIVER_TEXT_FIELDS.some(field => typeof receiver[field] !== "string" || !receiver[field])) throw new Error("Invalid direction receiver identity");
	return receiver;
}

function sameReceiver(identity: string | null, expected: DirectionReceiver): boolean {
	if (identity === null) return false;
	const actual = parseReceiver(identity);
	return actual.pid === expected.pid && RECEIVER_TEXT_FIELDS.every(field => actual[field] === expected[field]);
}

export function setReceiverWaiting(db: DatabaseSync, requestId: string, receiver: DirectionReceiver, waiting: boolean): void {
	const request = readRequest(db, requestId);
	if (!request) throw new Error(`Request ${requestId} is missing`);
	const row = mailbox(db, request);
	if (!row || !sameReceiver(row.identity, receiver)) throw new Error(`Request ${requestId}: original waiting invocation identity is unavailable or changed`);
	if (request.consumed_at || request.terminated_at) {
		if (waiting) throw new Error(`Request ${requestId} cannot be resumed`);
		return;
	}
	updateMailbox(db, row, waiting ? 1 : 0, waiting ? row.wake : 0);
}

/** Level-triggered wake: set the bit beside this exact response, never enqueue a new model turn. */
export function wakeResponse(db: DatabaseSync, request: StoredRequest): void {
	if (!request.response || request.consumed_at || request.terminated_at || isFenced(db, request.attempt_id)) throw new Error(`Request ${request.request_id} has no wakeable response`);
	originalReceiver(db, request, true);
	updateMailbox(db, mailbox(db, request)!, 1, 1);
}

export function hasRequestTables(db: DatabaseSync): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_requests'").get())
		&& Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_request_fences'").get());
}

/** Run `work` in one immediate transaction on `db`; any throw rolls it back. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
		throw error;
	}
}

/** Open the factory database for request work with the factory's durability settings. */
export function openRequestDatabase(path: string): DatabaseSync {
	// Workers must not recreate missing factory storage.
	new DatabaseSync(path, { readOnly: true }).close();
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON");
		if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
		return db;
	} catch (error) { db.close(); throw error; }
}

const FIELDS: Array<keyof Omit<StoredRequest, "record_digest">> = ["request_id", "factory_id", "input_id", "attempt_id", "task_id", "node_id", "node_attempt_id", "question", "reason", "evidence", "choices", "recommendation", "state", "created_at", "response", "responder", "responded_at", "consumed_at", "terminated_at", "terminated_reason"];
const requestDigest = (row: Omit<StoredRequest, "record_digest">): string => sha256Hex(JSON.stringify(FIELDS.map(field => row[field])));
const fenceDigest = (attemptId: string, reason: string, at: string): string => sha256Hex(JSON.stringify([attemptId, reason, at]));

function validated(row: StoredRequest): StoredRequest {
	const { record_digest, ...rest } = row;
	const text = (value: unknown) => typeof value === "string" && value.length > 0;
	const optionalText = (value: unknown) => value === null || typeof value === "string";
	const json = (value: unknown, check: (parsed: unknown) => boolean) => { try { return typeof value === "string" && check(JSON.parse(value)); } catch { return false; } };
	const terminated = row.terminated_at !== null;
	const shapeOk = requestDigest(rest) === record_digest
		&& [row.request_id, row.factory_id, row.input_id, row.attempt_id, row.task_id, row.node_id, row.node_attempt_id, row.question, row.reason, row.created_at].every(text)
		&& STATES.has(row.state)
		&& json(row.evidence, v => Array.isArray(v) && v.every(item => typeof item === "string"))
		&& json(row.choices, v => Array.isArray(v) && v.length > 0 && v.every(c => typeof (c as InterventionChoice)?.choice_id === "string" && typeof (c as InterventionChoice)?.label === "string"))
		&& (row.recommendation === null || json(row.recommendation, v => typeof (v as RequestRecommendation)?.choice_id === "string"))
		&& (row.response === null || json(row.response, v => (v as RequestResponse)?.kind === "choice" || (v as RequestResponse)?.kind === "decline"))
		&& [row.responded_at, row.consumed_at, row.terminated_at, row.terminated_reason, row.responder].every(optionalText)
		&& (row.responder === null || json(row.responder, v => typeof v === "object" && v !== null))
		&& (row.state === "pending" ? row.response === null && row.responded_at === null : true)
		&& (row.state === "responded" ? row.response !== null && row.responded_at !== null : true)
		&& (row.state !== "pending" && row.state !== "responded" ? row.terminated_reason === row.state : true)
		&& (terminated ? row.terminated_reason !== null && REASONS.has(row.terminated_reason) : row.terminated_reason === null);
	if (!shapeOk) throw new Error(`Factory storage corruption detected for request ${row.request_id}: request evidence mismatch`);
	return row;
}

function write(db: DatabaseSync, row: Omit<StoredRequest, "record_digest">): StoredRequest {
	const full = { ...row, record_digest: requestDigest(row) };
	db.prepare(`UPDATE factory_requests SET ${FIELDS.filter(f => f !== "request_id").map(f => `${f} = ?`).join(", ")}, record_digest = ? WHERE request_id = ?`)
		.run(...FIELDS.filter(f => f !== "request_id").map(f => full[f] ?? null), full.record_digest, full.request_id);
	return full;
}

export function requestView(row: StoredRequest): DirectionRequestView {
	const response = row.response ? JSON.parse(row.response) as RequestResponse : undefined;
	const recorded = row.responded_at !== null;
	return {
		request_id: row.request_id, factory_id: row.factory_id, input_id: row.input_id, attempt_id: row.attempt_id, task_id: row.task_id,
		node_id: row.node_id, node_attempt_id: row.node_attempt_id, question: row.question, reason: row.reason,
		evidence: JSON.parse(row.evidence), choices: JSON.parse(row.choices),
		...(row.recommendation ? { recommendation: JSON.parse(row.recommendation) } : {}),
		state: row.state, created_at: row.created_at,
		response_recorded: recorded,
		...(response && recorded ? { response: { ...response, responded_at: row.responded_at!, ...(row.responder ? { responder: JSON.parse(row.responder) } : {}) } } : {}),
		consumption: !recorded ? "not_applicable" : row.consumed_at ? "consumed" : row.terminated_at ? "never_consumed" : "awaiting_consumption",
		...(row.consumed_at ? { consumed_at: row.consumed_at } : {}),
		...(row.terminated_at && row.terminated_reason ? { terminated: { reason: row.terminated_reason, at: row.terminated_at } } : {}),
	};
}

export function readRequest(db: DatabaseSync, requestId: string): StoredRequest | undefined {
	if (requestVersion(db) < 6) return undefined;
	const row = db.prepare("SELECT * FROM factory_requests WHERE request_id = ?").get(requestId) as StoredRequest | undefined;
	if (row) { validated(row); mailbox(db, row); }
	else if (requestVersion(db) >= 8 && db.prepare("SELECT 1 FROM factory_direction_mailboxes WHERE request_id = ?").get(requestId)) throw new Error(`Request ${requestId} is missing from factory storage`);
	return row;
}

export function listRequests(db: DatabaseSync, factoryId: string): StoredRequest[] {
	const version = requestVersion(db);
	if (version < 6) return [];
	if (version >= 8) {
		const orphan = db.prepare("SELECT m.request_id FROM factory_direction_mailboxes m LEFT JOIN factory_requests r USING (request_id) WHERE m.factory_id = ? AND r.request_id IS NULL").get(factoryId);
		if (orphan) throw new Error(`Request ${orphan.request_id} is missing from factory storage`);
	}
	const rows = db.prepare("SELECT * FROM factory_requests WHERE factory_id = ? ORDER BY created_at, request_id").all(factoryId) as unknown as StoredRequest[];
	for (const row of rows) { validated(row); mailbox(db, row); }
	return rows;
}

export function requestFence(db: DatabaseSync, attemptId: string): TerminationReason | undefined {
	const fence = db.prepare("SELECT * FROM factory_request_fences WHERE attempt_id = ?").get(attemptId) as { attempt_id: string; reason: string; fenced_at: string; record_digest: string } | undefined;
	if (!fence) return undefined;
	if (!REASONS.has(fence.reason) || fenceDigest(fence.attempt_id, fence.reason, fence.fenced_at) !== fence.record_digest) throw new Error(`Factory storage corruption detected for attempt ${attemptId}: request fence evidence mismatch`);
	return fence.reason as TerminationReason;
}
const isFenced = requestFence;

function text(value: unknown, label: string, max = TEXT_MAX): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || !value.isWellFormed() || value.includes("\0")) throw new Error(`${label} must be non-empty text of at most ${max} characters`);
	return value;
}

function identity(value: unknown, label: string): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must be a stable identifier`);
	return value;
}

/** The node's opt-in as retained in the attempt's bound definition version, never as claimed by the worker. */
function boundIntervention(db: DatabaseSync, attempt: StoredAttempt, nodeId: string): InterventionPolicy | undefined {
	const hasVersions = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_versions'").get());
	let json: string | undefined;
	if (hasVersions) {
		const versionRow = db.prepare("SELECT * FROM factory_versions WHERE factory_id = ? AND version = ?").get(attempt.factory_id, attempt.bound_version) as StoredFactoryVersion | undefined;
		if (versionRow) json = validateFactoryVersionRow(versionRow).definition;
	} else if (attempt.bound_version === "v1") {
		json = (db.prepare("SELECT definition FROM factories WHERE factory_id = ?").get(attempt.factory_id) as { definition: string } | undefined)?.definition;
	}
	if (json === undefined) throw new Error(`The bound definition ${attempt.bound_version} is unavailable; no request can be validated`);
	const definition = JSON.parse(json) as { agents?: Array<{ node?: { node_id?: string; intervention?: InterventionPolicy } }> };
	const node = definition.agents?.find(agent => agent.node?.node_id === nodeId)?.node;
	if (!node) throw new Error(`Node ${nodeId} is not part of the bound definition`);
	return node.intervention;
}

/** Create one pending request for an enabled, admitted attempt. */
export function createRequest(db: DatabaseSync, input: NewRequest, receiver: DirectionReceiver, now = new Date().toISOString()): StoredRequest {
	const ids = {
		factory_id: identity(input.factory_id, "factory_id"), input_id: identity(input.input_id, "input_id"), attempt_id: identity(input.attempt_id, "attempt_id"),
		task_id: identity(input.task_id, "run"), node_id: identity(input.node_id, "node_id"), node_attempt_id: identity(input.node_attempt_id, "node attempt"),
	};
	const question = text(input.question, "question");
	const reason = text(input.reason, "reason");
	const evidence = input.evidence ?? [];
	if (!Array.isArray(evidence) || evidence.length > EVIDENCE_MAX) throw new Error(`evidence must list at most ${EVIDENCE_MAX} items`);
	evidence.forEach((item, index) => text(item, `evidence[${index}]`, EVIDENCE_ITEM_MAX));
	assertRequestSchema(db);
	const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(ids.attempt_id) as StoredAttempt | undefined;
	if (!raw) throw new Error("No factory attempt matches this request");
	const attempt = validateAttemptRow(raw);
	if (attempt.factory_id !== ids.factory_id || attempt.input_id !== ids.input_id || attempt.task_id !== ids.task_id) throw new Error("Request identity does not match the factory attempt (factory, input or run)");
	if (attempt.state !== "released" || attempt.release_authorized !== 1) throw new Error("Only an admitted, released attempt may request direction");
	if (isFenced(db, attempt.attempt_id)) throw new Error("This attempt was cancelled or failed; it can no longer request direction");
	const policy = boundIntervention(db, attempt, ids.node_id);
	if (!policy) throw new Error(`Node ${ids.node_id} is not enabled for human direction by its definition`);
	if (!Array.isArray(input.choices) || input.choices.length < 1 || new Set(input.choices).size !== input.choices.length) throw new Error("Offer a nonempty list of distinct plan choices");
	const planned = new Map(policy.choices.map(choice => [choice.choice_id, choice]));
	for (const id of input.choices) if (!planned.has(id)) throw new Error(`Choice ${JSON.stringify(id)} is not a plan choice of node ${ids.node_id}`);
	for (const id of policy.required ?? []) if (!input.choices.includes(id)) throw new Error(`The definition requires offering choice ${JSON.stringify(id)}`);
	if (input.recommendation !== undefined) {
		if (!input.choices.includes(input.recommendation.choice_id)) throw new Error("A recommendation must be one of the presented choices");
		if (input.recommendation.rationale !== undefined) text(input.recommendation.rationale, "recommendation rationale");
	}
	const pending = db.prepare("SELECT request_id FROM factory_requests WHERE attempt_id = ? AND node_id = ? AND node_attempt_id = ? AND consumed_at IS NULL AND terminated_at IS NULL").get(ids.attempt_id, ids.node_id, ids.node_attempt_id);
	if (pending) throw new Error("This attempt already has a pending request; wait for its resolution");
	const base: Omit<StoredRequest, "record_digest"> = {
		request_id: `dir_${randomUUID()}`, ...ids, question, reason, evidence: JSON.stringify(evidence),
		choices: JSON.stringify(input.choices.map(id => planned.get(id))), recommendation: input.recommendation ? JSON.stringify(input.recommendation) : null,
		state: "pending", created_at: now, response: null, responder: null, responded_at: null, consumed_at: null, terminated_at: null, terminated_reason: null,
	};
	const row = { ...base, record_digest: requestDigest(base) };
	db.prepare(`INSERT INTO factory_requests (${FIELDS.join(", ")}, record_digest) VALUES (${FIELDS.map(() => "?").join(", ")}, ?)`).run(...FIELDS.map(f => row[f] ?? null), row.record_digest);
	insertMailbox(db, row, receiver);
	return row;
}

export interface RecordedResponse { view: DirectionRequestView; replayed: boolean }

/** Record the one response to a pending request. An identical retry returns the saved outcome; a changed one conflicts. */
export function recordResponse(db: DatabaseSync, requestId: string, factoryId: string, raw: unknown, responder: Responder | undefined, now = new Date().toISOString()): RecordedResponse {
	const row = readRequest(db, identity(requestId, "request_id"));
	if (!row || row.factory_id !== factoryId) throw new Error(`Request not found: ${requestId}`);
	const response = normalizeResponse(raw, JSON.parse(row.choices) as InterventionChoice[]);
	if (row.state !== "pending" && row.state !== "responded") throw new Error(`Request ${requestId} was closed because its attempt ${row.state === "closed" ? "ended" : row.state}; the response is rejected`);
	if (row.state === "responded") {
		if (row.response === JSON.stringify(response)) return { view: requestView(row), replayed: true };
		throw new Error(`Request ${requestId} already has a different recorded response; a response is recorded once`);
	}
	const updated = write(db, { ...row, state: "responded", response: JSON.stringify(response), responder: responder ? JSON.stringify(responder) : null, responded_at: now });
	return { view: requestView(updated), replayed: false };
}

function normalizeResponse(raw: unknown, choices: InterventionChoice[]): RequestResponse {
	if (typeof raw !== "object" || raw === null) throw new Error("A response must select a presented choice or explicitly decline; free text alone is not a response");
	const { kind, choice_id, guidance, ...extra } = raw as Record<string, unknown>;
	if (Object.keys(extra).length) throw new Error(`Unknown response setting ${JSON.stringify(Object.keys(extra)[0])}`);
	const note = guidance === undefined ? {} : { guidance: text(guidance, "guidance") };
	if (kind === "decline") {
		if (choice_id !== undefined) throw new Error("A decline cannot also select a choice");
		return { kind: "decline", ...note };
	}
	if (kind !== "choice" || typeof choice_id !== "string") throw new Error("A response must select a presented choice or explicitly decline; free text alone is not a response");
	if (!choices.some(choice => choice.choice_id === choice_id)) throw new Error(`Choice ${JSON.stringify(choice_id)} was not offered`);
	return { kind: "choice", choice_id, ...note };
}

/**
 * Fence an attempt as cancelled or failed: its pending requests close, a response not yet consumed can never be consumed,
 * and no new request can be made. Idempotent. Called inside the same transaction as the cancellation or failure evidence.
 */
export function fenceAttempt(db: DatabaseSync, attemptId: string, reason: TerminationReason, now = new Date().toISOString()): void {
	if (requestVersion(db) < 6) throw new Error("Factory request fence storage is unavailable");
	db.prepare("INSERT OR IGNORE INTO factory_request_fences (attempt_id, reason, fenced_at, record_digest) VALUES (?, ?, ?, ?)").run(attemptId, reason, now, fenceDigest(attemptId, reason, now));
	terminateOpen(db, "attempt_id = ?", [attemptId], reason, now);
}

function terminateOpen(db: DatabaseSync, where: string, params: string[], reason: TerminationReason, now: string): void {
	const open = db.prepare(`SELECT * FROM factory_requests WHERE ${where} AND terminated_at IS NULL AND consumed_at IS NULL`).all(...params) as unknown as StoredRequest[];
	for (const row of open) {
		const checked = validated(row);
		let delivery: Mailbox | undefined;
		try { delivery = mailbox(db, checked); }
		catch { /* Broken delivery evidence is not authority to proceed, nor a reason to block termination. Preserve it. */ }
		if (delivery?.waiting || delivery?.wake) updateMailbox(db, delivery, 0, 0);
		write(db, { ...checked, state: checked.state === "pending" ? reason : checked.state, terminated_at: now, terminated_reason: reason });
	}
}

/** Close one node's open requests (pending, or responded but never consumed) when that node ends without a successful result. */
export function terminateNodeRequests(db: DatabaseSync, attemptId: string, nodeId: string, reason: TerminationReason, now = new Date().toISOString()): void {
	if (requestVersion(db) < 8) throw new Error("Factory direction mailbox storage is unavailable");
	terminateOpen(db, "attempt_id = ? AND node_id = ?", [attemptId, nodeId], reason, now);
}

/** The request this node attempt still owes the human: pending, or answered but neither consumed nor terminated. Read from storage, never from memory. */
export function findOpenRequest(dbPath: string, attemptId: string, nodeId: string, nodeAttemptId: string): string | undefined {
	const db = openRequestDatabase(dbPath);
	try {
		assertRequestSchema(db);
		db.exec("BEGIN");
		const attempt = db.prepare("SELECT factory_id FROM factory_attempts WHERE attempt_id = ?").get(attemptId);
		if (!attempt) throw new Error(`Factory attempt ${attemptId} is missing`);
		return listRequests(db, String(attempt.factory_id)).find(row => row.attempt_id === attemptId && row.node_id === nodeId && row.node_attempt_id === nodeAttemptId && !row.consumed_at && !row.terminated_at)?.request_id;
	} finally { db.close(); }
}

export type ConsumptionClaim = "claimed" | "already_consumed" | "terminated" | "not_responded";

/** Record, once, the claim that lets the requesting attempt continue; duplicates, a fenced attempt or a terminated request never claim. */
export function claimConsumption(db: DatabaseSync, requestId: string, receiver: DirectionReceiver, now = new Date().toISOString()): ConsumptionClaim {
	assertRequestSchema(db);
	const row = readRequest(db, requestId);
	if (!row) throw new Error(`Request not found: ${requestId}`);
	if (row.consumed_at) return "already_consumed";
	if (row.terminated_at || (row.state !== "pending" && row.state !== "responded") || isFenced(db, row.attempt_id)) return "terminated";
	const delivery = mailbox(db, row);
	if (!delivery?.waiting || !sameReceiver(delivery.identity, receiver)) throw new Error(`Request ${requestId}: original waiting invocation identity is unavailable or changed`);
	if (row.state !== "responded" || !delivery.wake) return "not_responded";
	updateMailbox(db, delivery, 0, 0);
	write(db, { ...row, consumed_at: now });
	return "claimed";
}

function deliveryDigest(request: StoredRequest, identity: string): string {
	return sha256Hex(JSON.stringify(["direction-delivery-v1", request.request_id, request.record_digest, identity]));
}

/** Read an affirmative delivery record; its absence is not evidence of delivery. */
export function directionDeliveryRecorded(db: DatabaseSync, request: StoredRequest): boolean {
	if (requestVersion(db) < 9) return false;
	const record = db.prepare("SELECT record_digest FROM factory_direction_deliveries WHERE request_id = ?").get(request.request_id);
	if (!record) return false;
	const identity = mailbox(db, request)?.identity;
	if (!request.consumed_at || !identity || record.record_digest !== deliveryDigest(request, identity)) {
		throw new Error(`Request ${request.request_id} has contradictory direction delivery evidence`);
	}
	return true;
}

/** Record receipt at Pi's tool-result boundary, not at claim commit. Never grants replay authority. */
export function recordDirectionDelivery(db: DatabaseSync, requestId: string, receiver: DirectionReceiver): void {
	if (requestVersion(db) !== 9) throw new Error("Recording direction delivery requires factory storage version 9");
	const request = readRequest(db, requestId);
	const box = request && mailbox(db, request);
	if (!request?.consumed_at || request.terminated_at || isFenced(db, request.attempt_id) || !box?.identity || !sameReceiver(box.identity, receiver)) {
		throw new Error(`Request ${requestId}: no delivered claim by the original receiver can be recorded`);
	}
	if (directionDeliveryRecorded(db, request)) return;
	db.prepare("INSERT INTO factory_direction_deliveries (request_id, record_digest) VALUES (?, ?)").run(requestId, deliveryDigest(request, box.identity));
}

export type DirectionOutcome =
	| { outcome: "response"; view: DirectionRequestView }
	| { outcome: "terminated"; view: DirectionRequestView };

/**
 * Wait, without a deadline, for the human response to a request and record the consumption claim before returning it. Silence
 * is indefinite waiting. Invalid storage or an aborted signal rejects the wait; a terminated request reports `terminated`.
 */
export async function awaitDirection(dbPath: string, requestId: string, receiver: DirectionReceiver, options: { signal?: AbortSignal; pollMs?: number; cancelled?: () => boolean; verifyReceiver?: () => void } = {}): Promise<DirectionOutcome> {
	for (;;) {
		options.signal?.throwIfAborted();
		const db = openRequestDatabase(dbPath);
		try {
			db.exec("BEGIN");
			assertRequestSchema(db);
			const row = readRequest(db, requestId);
			if (!row) throw new Error(`Request ${requestId} is missing from factory storage`);
			if (options.cancelled?.() && !row.terminated_at && !row.consumed_at) return { outcome: "terminated", view: requestView(row) };
			if (row.terminated_at || (row.state !== "pending" && row.state !== "responded")) return { outcome: "terminated", view: requestView(row) };
			if (row.consumed_at) throw new Error(`Request ${requestId} was already consumed; this wait cannot continue it again`);
			if (row.state === "responded" && mailbox(db, row)?.wake) {
				db.exec("ROLLBACK"); // release the read snapshot before beginning the claim transaction
				const { claim, latest } = inTransaction(db, () => {
					if (options.cancelled?.()) return { claim: "terminated", latest: requestView(readRequest(db, requestId)!) } as const;
					options.verifyReceiver?.();
					const claim = claimConsumption(db, requestId, receiver);
					return { claim, latest: requestView(readRequest(db, requestId)!) };
				});
				if (claim === "claimed") return { outcome: "response", view: latest };
				if (claim === "terminated") return { outcome: "terminated", view: latest };
				if (claim === "already_consumed") throw new Error(`Request ${requestId} was already consumed; this wait cannot continue it again`);
			}
		} finally { db.close(); }
		await new Promise<void>((resolve, reject) => {
			const abort = () => { clearTimeout(timer); reject(options.signal!.reason); };
			const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, options.pollMs ?? 250);
			options.signal?.addEventListener("abort", abort, { once: true });
		});
	}
}
