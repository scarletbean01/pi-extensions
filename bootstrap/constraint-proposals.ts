/**
 * Durable learned-constraint proposals and human confirmation/retirement records (SQLite schema v12).
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	assertSafeConstraintText,
	CONSTRAINT_ID_PATTERN,
	CONSTRAINTS_MAX_TEXT_BYTES,
	MISSING_CONSTRAINTS_DIGEST,
	normalizeConstraintText,
	type ConstraintProvenance,
	type LearnedConstraintEntry,
} from "./constraints.ts";

export const PROPOSAL_ACTIONS = new Set<string>(["add", "retire"]);
export const PROPOSAL_OUTCOMES = new Set<string>(["pending", "confirmed", "rejected", "dropped_duplicate"]);
export const PROPOSAL_SOURCES = new Set<string>(["agent", "human"]);
export const FILE_SYNC_STATES = new Set<string>(["pending_write", "synced", "conflict"]);

export type ProposalAction = "add" | "retire";
export type ProposalOutcome = "pending" | "confirmed" | "rejected" | "dropped_duplicate";
export type ProposalSource = "agent" | "human";
export type ProposalFileSyncState = "pending_write" | "synced" | "conflict";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_CONFLICTING_IDS = 32;

export const CONSTRAINT_PROPOSALS_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS factory_constraint_proposals (
		proposal_id TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL,
		reference TEXT NOT NULL,
		proposal_action TEXT NOT NULL CHECK (proposal_action IN ('add', 'retire')),
		source TEXT NOT NULL CHECK (source IN ('agent', 'human')),
		target_constraint_id TEXT,
		assigned_constraint_id TEXT,
		text TEXT NOT NULL,
		normalized_text TEXT NOT NULL,
		normalized_text_digest TEXT NOT NULL,
		payload_digest TEXT NOT NULL,
		run_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		evidence_ref TEXT NOT NULL,
		note TEXT,
		conflicting_ids TEXT NOT NULL,
		canonical_checkout TEXT NOT NULL,
		outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'confirmed', 'rejected', 'dropped_duplicate')),
		duplicate_of TEXT,
		rejection_reason TEXT,
		proposed_at TEXT NOT NULL,
		decided_at TEXT,
		decided_by TEXT,
		file_sync_state TEXT CHECK (file_sync_state IN ('pending_write', 'synced', 'conflict')),
		expected_before_digest TEXT,
		expected_after_digest TEXT,
		committed_entry_json TEXT,
		sync_error TEXT,
		record_digest TEXT NOT NULL,
		UNIQUE (factory_id, reference)
	) STRICT;
	CREATE INDEX IF NOT EXISTS factory_constraint_proposals_by_factory
		ON factory_constraint_proposals (factory_id, proposed_at, proposal_id);
`;

export interface StoredConstraintProposal {
	proposal_id: string;
	factory_id: string;
	reference: string;
	proposal_action: ProposalAction;
	source: ProposalSource;
	target_constraint_id: string | null;
	assigned_constraint_id: string | null;
	text: string;
	normalized_text: string;
	normalized_text_digest: string;
	payload_digest: string;
	run_id: string;
	attempt_id: string;
	evidence_ref: string;
	note: string | null;
	conflicting_ids: string;
	canonical_checkout: string;
	outcome: ProposalOutcome;
	duplicate_of: string | null;
	rejection_reason: string | null;
	proposed_at: string;
	decided_at: string | null;
	decided_by: string | null;
	file_sync_state: ProposalFileSyncState | null;
	expected_before_digest: string | null;
	expected_after_digest: string | null;
	committed_entry_json: string | null;
	sync_error: string | null;
	record_digest: string;
}

export interface ProposalActor {
	incarnation_id: string;
	pi_session_id: string | null;
}

export interface DuplicateReference {
	kind: "constraint" | "proposal";
	id: string;
}

export interface ConstraintProposalView {
	proposal_id: string;
	factory_id: string;
	reference: string;
	proposal_action: ProposalAction;
	source: ProposalSource;
	target_constraint_id?: string;
	assigned_constraint_id?: string;
	text: string;
	normalized_text: string;
	normalized_text_digest: string;
	provenance: ConstraintProvenance;
	conflicting_ids: string[];
	canonical_checkout: string;
	outcome: ProposalOutcome;
	duplicate_of?: DuplicateReference;
	rejection_reason?: string;
	proposed_at: string;
	decided_at?: string;
	decided_by?: ProposalActor;
	file_sync_state?: ProposalFileSyncState;
	sync_error?: string;
	can_confirm: boolean;
	can_reject: boolean;
}

const PROPOSAL_FIELDS: Array<keyof Omit<StoredConstraintProposal, "record_digest">> = [
	"proposal_id",
	"factory_id",
	"reference",
	"proposal_action",
	"source",
	"target_constraint_id",
	"assigned_constraint_id",
	"text",
	"normalized_text",
	"normalized_text_digest",
	"payload_digest",
	"run_id",
	"attempt_id",
	"evidence_ref",
	"note",
	"conflicting_ids",
	"canonical_checkout",
	"outcome",
	"duplicate_of",
	"rejection_reason",
	"proposed_at",
	"decided_at",
	"decided_by",
	"file_sync_state",
	"expected_before_digest",
	"expected_after_digest",
	"committed_entry_json",
	"sync_error",
];

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function proposalRecordDigest(row: Omit<StoredConstraintProposal, "record_digest">): string {
	return sha256(JSON.stringify(PROPOSAL_FIELDS.map(field => row[field])));
}

export function proposalPayloadDigest(input: {
	proposal_action: ProposalAction;
	target_constraint_id: string | null;
	assigned_constraint_id: string | null;
	text: string;
	run_id: string;
	attempt_id: string;
	evidence_ref: string;
	conflicting_ids: string[];
}): string {
	return sha256(JSON.stringify([
		"constraint-proposal-v1",
		input.proposal_action,
		input.target_constraint_id,
		input.assigned_constraint_id,
		input.text,
		input.run_id,
		input.attempt_id,
		input.evidence_ref,
		input.conflicting_ids,
	]));
}

export type BuildProposalInput = Omit<
	StoredConstraintProposal,
	"normalized_text" | "normalized_text_digest" | "payload_digest" | "record_digest"
> & { payload_digest?: string };

export function buildProposalRow(input: BuildProposalInput): StoredConstraintProposal {
	const normalized_text = normalizeConstraintText(input.text);
	const normalized_text_digest = sha256(normalized_text);
	const conflictingIds = JSON.parse(input.conflicting_ids) as string[];
	const payload_digest = input.payload_digest ?? proposalPayloadDigest({
		proposal_action: input.proposal_action,
		target_constraint_id: input.target_constraint_id,
		assigned_constraint_id: input.assigned_constraint_id,
		text: input.text,
		run_id: input.run_id,
		attempt_id: input.attempt_id,
		evidence_ref: input.evidence_ref,
		conflicting_ids: conflictingIds,
	});
	const base: Omit<StoredConstraintProposal, "record_digest"> = {
		...input,
		normalized_text,
		normalized_text_digest,
		payload_digest,
	};
	return { ...base, record_digest: proposalRecordDigest(base) };
}

function isDigestOrMissing(value: unknown): value is string {
	return value === MISSING_CONSTRAINTS_DIGEST || (typeof value === "string" && SHA256_HEX.test(value));
}

export function validateProposalRow(row: StoredConstraintProposal): StoredConstraintProposal {
	const fail = (reason: string): never => {
		throw new Error(`Factory storage corruption detected for constraint proposal ${row.proposal_id}: ${reason}`);
	};
	if (typeof row.proposal_id !== "string" || !row.proposal_id.trim()) fail("missing proposal_id");
	if (typeof row.factory_id !== "string" || !row.factory_id.trim()) fail("missing factory_id");
	if (typeof row.reference !== "string" || !row.reference.trim()) fail("missing reference");
	if (!PROPOSAL_ACTIONS.has(row.proposal_action)) fail(`invalid proposal_action ${JSON.stringify(row.proposal_action)}`);
	if (!PROPOSAL_SOURCES.has(row.source)) fail(`invalid source ${JSON.stringify(row.source)}`);
	if (!PROPOSAL_OUTCOMES.has(row.outcome)) fail(`invalid outcome ${JSON.stringify(row.outcome)}`);
	if (typeof row.canonical_checkout !== "string" || !row.canonical_checkout.trim()) fail("missing canonical_checkout");
	if (typeof row.proposed_at !== "string" || !Number.isFinite(Date.parse(row.proposed_at))) fail("invalid proposed_at");

	try {
		assertSafeConstraintText(row.text, `proposal ${row.proposal_id} text`, CONSTRAINTS_MAX_TEXT_BYTES, true);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const expectedNorm = normalizeConstraintText(row.text);
	const expectedNormDigest = sha256(expectedNorm);
	if (row.normalized_text !== expectedNorm || row.normalized_text_digest !== expectedNormDigest) {
		fail("normalized text mismatch");
	}
	if (!SHA256_HEX.test(row.payload_digest)) fail("invalid payload_digest");

	if (row.proposal_action === "add") {
		if (row.target_constraint_id !== null) fail("add proposal cannot have target_constraint_id");
		if (row.assigned_constraint_id !== null && !CONSTRAINT_ID_PATTERN.test(row.assigned_constraint_id)) {
			fail("invalid assigned_constraint_id");
		}
	} else {
		if (typeof row.target_constraint_id !== "string" || !CONSTRAINT_ID_PATTERN.test(row.target_constraint_id)) {
			fail("retire proposal requires valid target_constraint_id");
		}
		if (row.assigned_constraint_id !== null) fail("retire proposal cannot have assigned_constraint_id");
	}

	if (row.source === "agent") {
		try {
			assertSafeConstraintText(row.run_id, "run_id", 200, false);
			assertSafeConstraintText(row.attempt_id, "attempt_id", 200, false);
			assertSafeConstraintText(row.evidence_ref, "evidence_ref", 512, false);
			if (row.note !== null) assertSafeConstraintText(row.note, "note", 512, false);
		} catch (error) {
			fail(`invalid agent provenance: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		if (row.proposal_action !== "retire") fail("human source is only valid for retire");
		try {
			assertSafeConstraintText(row.note, "note", 512, false);
		} catch (error) {
			fail(`invalid human provenance: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	let conflicting: unknown;
	try { conflicting = JSON.parse(row.conflicting_ids); } catch { fail("invalid conflicting_ids JSON"); }
	if (
		!Array.isArray(conflicting)
		|| conflicting.length > MAX_CONFLICTING_IDS
		|| conflicting.some(id => typeof id !== "string" || !CONSTRAINT_ID_PATTERN.test(id))
	) {
		fail("invalid conflicting_ids list");
	}

	if (row.outcome === "pending") {
		if (
			row.duplicate_of !== null || row.rejection_reason !== null || row.decided_at !== null
			|| row.decided_by !== null || row.file_sync_state !== null
			|| row.expected_before_digest !== null || row.expected_after_digest !== null
			|| row.committed_entry_json !== null || row.sync_error !== null
		) {
			fail("pending proposal has unexpected decision or sync fields");
		}
	} else if (row.outcome === "dropped_duplicate") {
		if (
			row.decided_at !== null || row.decided_by !== null || row.rejection_reason !== null
			|| row.file_sync_state !== null || row.expected_before_digest !== null
			|| row.expected_after_digest !== null || row.committed_entry_json !== null || row.sync_error !== null
		) {
			fail("dropped_duplicate proposal has unexpected decision or sync fields");
		}
		let dup: unknown;
		try { dup = row.duplicate_of ? JSON.parse(row.duplicate_of) : null; } catch { fail("invalid duplicate_of JSON"); }
		if (
			!dup || typeof dup !== "object" || Array.isArray(dup)
			|| ((dup as DuplicateReference).kind !== "constraint" && (dup as DuplicateReference).kind !== "proposal")
			|| typeof (dup as DuplicateReference).id !== "string" || !(dup as DuplicateReference).id
		) {
			fail("dropped_duplicate proposal missing valid duplicate_of");
		}
	} else if (row.outcome === "rejected") {
		if (
			row.duplicate_of !== null || row.file_sync_state !== null
			|| row.expected_before_digest !== null || row.expected_after_digest !== null
			|| row.committed_entry_json !== null || row.sync_error !== null
			|| typeof row.decided_at !== "string" || !Number.isFinite(Date.parse(row.decided_at))
		) {
			fail("rejected proposal has invalid decision fields");
		}
		if (row.decided_by !== null) validateActorJson(row.decided_by, fail);
		if (row.rejection_reason !== null) {
			try { assertSafeConstraintText(row.rejection_reason, "rejection_reason", 512, false); }
			catch (error) { fail(`invalid rejection_reason: ${error instanceof Error ? error.message : String(error)}`); }
		}
	} else if (row.outcome === "confirmed") {
		if (
			row.duplicate_of !== null || row.rejection_reason !== null
			|| typeof row.decided_at !== "string" || !Number.isFinite(Date.parse(row.decided_at))
			|| !row.file_sync_state || !FILE_SYNC_STATES.has(row.file_sync_state)
			|| !isDigestOrMissing(row.expected_before_digest)
			|| !SHA256_HEX.test(row.expected_after_digest ?? "")
			|| typeof row.committed_entry_json !== "string"
		) {
			fail("confirmed proposal has missing or invalid commit fields");
		}
		if (row.decided_by !== null) validateActorJson(row.decided_by, fail);
		let entry: unknown;
		try { entry = JSON.parse(row.committed_entry_json); } catch { fail("invalid committed_entry_json"); }
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("invalid committed entry object");
		const parsedEntry = entry as LearnedConstraintEntry;
		if (
			!CONSTRAINT_ID_PATTERN.test(parsedEntry.id ?? "")
			|| (row.proposal_action === "add" && row.assigned_constraint_id !== parsedEntry.id)
			|| (row.proposal_action === "retire" && row.target_constraint_id !== parsedEntry.id)
			|| parsedEntry.status !== (row.proposal_action === "add" ? "active" : "retired")
		) {
			fail("committed_entry_json contradicts proposal action or ID");
		}
	}

	const { record_digest, ...rest } = row;
	if (!SHA256_HEX.test(record_digest) || proposalRecordDigest(rest) !== record_digest) {
		fail("proposal evidence mismatch (record_digest mismatch)");
	}
	return row;
}

function validateActorJson(raw: string, fail: (msg: string) => never): ProposalActor {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { fail("invalid decided_by JSON"); }
	if (
		!parsed || typeof parsed !== "object" || Array.isArray(parsed)
		|| typeof (parsed as ProposalActor).incarnation_id !== "string"
		|| !(parsed as ProposalActor).incarnation_id
		|| ((parsed as ProposalActor).pi_session_id !== null && typeof (parsed as ProposalActor).pi_session_id !== "string")
	) {
		fail("invalid decided_by actor");
	}
	return parsed as ProposalActor;
}

export function proposalView(row: StoredConstraintProposal): ConstraintProposalView {
	const provenance: ConstraintProvenance = row.source === "agent"
		? {
			run_id: row.run_id,
			attempt_id: row.attempt_id,
			evidence_ref: row.evidence_ref,
			...(row.note ? { note: row.note } : {}),
		}
		: {
			...(row.note ? { note: row.note } : {}),
		};
	return {
		proposal_id: row.proposal_id,
		factory_id: row.factory_id,
		reference: row.reference,
		proposal_action: row.proposal_action,
		source: row.source,
		...(row.target_constraint_id ? { target_constraint_id: row.target_constraint_id } : {}),
		...(row.assigned_constraint_id ? { assigned_constraint_id: row.assigned_constraint_id } : {}),
		text: row.text,
		normalized_text: row.normalized_text,
		normalized_text_digest: row.normalized_text_digest,
		provenance,
		conflicting_ids: JSON.parse(row.conflicting_ids) as string[],
		canonical_checkout: row.canonical_checkout,
		outcome: row.outcome,
		...(row.duplicate_of ? { duplicate_of: JSON.parse(row.duplicate_of) as DuplicateReference } : {}),
		...(row.rejection_reason ? { rejection_reason: row.rejection_reason } : {}),
		proposed_at: row.proposed_at,
		...(row.decided_at ? { decided_at: row.decided_at } : {}),
		...(row.decided_by ? { decided_by: JSON.parse(row.decided_by) as ProposalActor } : {}),
		...(row.file_sync_state ? { file_sync_state: row.file_sync_state } : {}),
		...(row.sync_error ? { sync_error: row.sync_error } : {}),
		can_confirm: row.outcome === "pending",
		can_reject: row.outcome === "pending",
	};
}

export function hasProposalTable(db: DatabaseSync): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'factory_constraint_proposals'").get());
}

export function listProposalRows(db: DatabaseSync, factoryId: string, runId?: string): StoredConstraintProposal[] {
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
	if (version < 12) return [];
	if (!hasProposalTable(db)) {
		throw new Error("Factory constraint proposal table is missing; restore the original evidence");
	}
	const rows = (runId !== undefined
		? db.prepare("SELECT * FROM factory_constraint_proposals WHERE factory_id = ? AND run_id = ? ORDER BY proposed_at, proposal_id").all(factoryId, runId)
		: db.prepare("SELECT * FROM factory_constraint_proposals WHERE factory_id = ? ORDER BY proposed_at, proposal_id").all(factoryId)
	) as unknown as StoredConstraintProposal[];
	return rows.map(validateProposalRow);
}

export function readProposalRow(db: DatabaseSync, proposalId: string): StoredConstraintProposal | undefined {
	const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
	if (version < 12) return undefined;
	if (!hasProposalTable(db)) {
		throw new Error("Factory constraint proposal table is missing; restore the original evidence");
	}
	const row = db.prepare("SELECT * FROM factory_constraint_proposals WHERE proposal_id = ?").get(proposalId) as StoredConstraintProposal | undefined;
	return row ? validateProposalRow(row) : undefined;
}

export function insertProposalRow(db: DatabaseSync, row: StoredConstraintProposal): void {
	const validated = validateProposalRow(row);
	db.prepare(
		`INSERT INTO factory_constraint_proposals (${PROPOSAL_FIELDS.join(", ")}, record_digest)
		VALUES (${PROPOSAL_FIELDS.map(() => "?").join(", ")}, ?)`,
	).run(...PROPOSAL_FIELDS.map(f => validated[f]), validated.record_digest);
}

export function updateProposalRow(db: DatabaseSync, row: StoredConstraintProposal): void {
	const validated = validateProposalRow(row);
	const nonPkFields = PROPOSAL_FIELDS.filter(f => f !== "proposal_id");
	db.prepare(
		`UPDATE factory_constraint_proposals SET ${nonPkFields.map(f => `${f} = ?`).join(", ")}, record_digest = ? WHERE proposal_id = ?`,
	).run(...nonPkFields.map(f => validated[f]), validated.record_digest, validated.proposal_id);
}
