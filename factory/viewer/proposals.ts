import type { ConstraintProposalView } from "../../bootstrap/constraint-proposals.ts";
import type { FactoryDeletionInfo, ProposalsListResult } from "../operations.ts";
import { type TypedAbsence } from "./inspect.ts";
import { deletionMarkerFields, sanitizeOperatorText } from "./sanitize.ts";

const OUTCOME_EXPLANATIONS: Record<string, string> = {
	pending: "Awaiting human confirmation or rejection in Pi.",
	confirmed: "Confirmed by an operator in Pi; check file sync state for .pi/constraints.json write status.",
	rejected: "Rejected by an operator; not written to .pi/constraints.json.",
	dropped_duplicate: "Dropped as a duplicate of an existing constraint or proposal before human review.",
	unknown: "Proposal outcome is unrecognized or damaged.",
};

const FILE_SYNC_EXPLANATIONS: Record<string, string> = {
	pending_write: "Confirmed proposal has a pending durable write to .pi/constraints.json; resume or takeover in Pi completes it.",
	synced: "Confirmed proposal has been durably synchronized to .pi/constraints.json.",
	conflict: "Confirmed proposal conflicted with concurrent changes to .pi/constraints.json; resolve via /factory resolve-conflict in Pi.",
	abandoned: "Confirmed proposal conflict was abandoned by an operator without updating .pi/constraints.json.",
	unknown: "File sync state for this confirmed proposal is unavailable or unrecognized.",
};

const PROPOSALS_NOTE = "Proposals are not the active constraints file.";

const KNOWN_OUTCOMES = new Set(["pending", "confirmed", "rejected", "dropped_duplicate"]);
const KNOWN_FILE_SYNC_STATES = new Set(["pending_write", "synced", "conflict", "abandoned"]);

function projectProposal(item: ConstraintProposalView, blockedPaths: readonly string[]) {
	const blocked = [...blockedPaths, item.canonical_checkout];
	const action = item.proposal_action;
	const outcome = KNOWN_OUTCOMES.has(item.outcome) ? item.outcome : ("unknown" as const);
	const confirmed = outcome === "confirmed";
	const rawSyncState = confirmed ? item.file_sync_state : undefined;
	const syncState = !confirmed
		? undefined
		: rawSyncState === undefined || rawSyncState === null
			? undefined
			: KNOWN_FILE_SYNC_STATES.has(rawSyncState)
				? rawSyncState
				: ("unknown" as const);

	const file_sync_state = !confirmed
		? { absence: "not applicable" as const, explanation: "File synchronization applies only after a proposal is confirmed in Pi." }
		: syncState
			? syncState
			: { absence: "evidence unavailable" as const, explanation: "File sync state for this confirmed proposal could not be verified." };

	const file_sync_state_explanation = !confirmed
		? "File synchronization applies only after a proposal is confirmed in Pi."
		: FILE_SYNC_EXPLANATIONS[syncState ?? "unknown"] ?? FILE_SYNC_EXPLANATIONS.unknown!;

	const syncUncertain = confirmed && (!syncState || syncState === "unknown" || syncState === "pending_write" || syncState === "conflict");
	const uncertain = outcome === "unknown" || syncUncertain;
	const uncertaintyReasons: string[] = [];
	if (outcome === "unknown") {
		uncertaintyReasons.push(OUTCOME_EXPLANATIONS.unknown!);
	}
	if (syncUncertain) {
		uncertaintyReasons.push(syncState ? (FILE_SYNC_EXPLANATIONS[syncState] ?? FILE_SYNC_EXPLANATIONS.unknown!) : FILE_SYNC_EXPLANATIONS.unknown!);
	}
	const uncertainty = uncertain ? uncertaintyReasons.join(" ") : undefined;

	const isHuman = item.source === "human";
	const notApplicableHuman = (detail: string) => ({
		absence: "not applicable" as const,
		explanation: `Human-initiated retirements do not carry ${detail}.`,
	});
	const unavailableAgent = (detail: string) => ({
		absence: "evidence unavailable" as const,
		explanation: `Originating ${detail} is unavailable.`,
	});

	return {
		proposal_id: item.proposal_id,
		factory_id: item.factory_id,
		reference: item.reference,
		action,
		source: item.source,
		...(item.target_constraint_id ? { target_constraint_id: item.target_constraint_id } : {}),
		...(item.assigned_constraint_id ? { assigned_constraint_id: item.assigned_constraint_id } : {}),
		text: sanitizeOperatorText(item.text, 512, blocked),
		normalized_text_digest: item.normalized_text_digest,
		provenance: {
			source: item.source,
			run_id: item.provenance.run_id ? sanitizeOperatorText(item.provenance.run_id, 200, blocked) : (isHuman ? notApplicableHuman("a run ID") : unavailableAgent("run ID")),
			attempt_id: item.provenance.attempt_id ? sanitizeOperatorText(item.provenance.attempt_id, 200, blocked) : (isHuman ? notApplicableHuman("a node attempt ID") : unavailableAgent("attempt ID")),
			evidence_ref: item.provenance.evidence_ref ? sanitizeOperatorText(item.provenance.evidence_ref, 512, blocked) : (isHuman ? notApplicableHuman("a run evidence reference") : unavailableAgent("evidence reference")),
			...(item.provenance.note ? { note: sanitizeOperatorText(item.provenance.note, 256, blocked) } : {}),
			proposed_at: item.proposed_at,
			decided_at: item.decided_at ?? {
				absence: "not applicable" as const,
				explanation: outcome === "dropped_duplicate"
					? "Duplicate proposal was dropped before human decision."
					: "Proposal has not been decided yet.",
			},
			...(item.resolved_at ? { resolved_at: item.resolved_at } : {}),
		},
		conflicting_ids: [...item.conflicting_ids],
		outcome,
		outcome_explanation: OUTCOME_EXPLANATIONS[outcome] ?? OUTCOME_EXPLANATIONS.unknown!,
		...(item.duplicate_of ? { duplicate_of: { kind: item.duplicate_of.kind, id: item.duplicate_of.id } } : {}),
		...(item.rejection_reason ? { rejection_reason: sanitizeOperatorText(item.rejection_reason, 256, blocked) } : {}),
		file_sync_state,
		file_sync_state_explanation,
		uncertain,
		...(uncertainty ? { uncertainty } : {}),
	};
}

/** Operator-facing proposals snapshot projected from verified read-only ConstraintProposalView records. */
export function proposalsSnapshot(
	proposals: ConstraintProposalView[],
	factoryId: string,
	blockedPaths: readonly string[] = [],
) {
	const records = proposals.map(item => projectProposal(item, blockedPaths));
	const anyUncertain = records.some(record => record.uncertain);
	return {
		factory_id: factoryId,
		...deletionMarkerFields(proposals as ProposalsListResult, blockedPaths),
		is_active_constraints_file: false as const,
		note: PROPOSALS_NOTE,
		evidence: anyUncertain ? ("uncertain" as const) : ("available" as const),
		records,
		explanation: `${records.length} learned-constraint proposal(s) recorded.`,
	};
}

/** Typed absence proposals snapshot when a healthy store has zero proposals. */
export function absentProposalsSnapshot(
	factoryId: string,
	absence: Exclude<TypedAbsence, "evidence unavailable">,
	deletionSource?: { deleted?: boolean; deletion?: FactoryDeletionInfo },
	blockedPaths: readonly string[] = [],
) {
	return {
		factory_id: factoryId,
		...deletionMarkerFields(deletionSource, blockedPaths),
		is_active_constraints_file: false as const,
		note: PROPOSALS_NOTE,
		evidence: "available" as const,
		records: [] as never[],
		absence,
		explanation: absence === "not applicable"
			? "Learned-constraint proposals apply only to a managed factory."
			: "No learned-constraint proposals have been recorded.",
	};
}

/** Typed unavailable proposals snapshot when store or proposal evidence cannot be verified. */
export function unavailableProposalsSnapshot(factoryId: string) {
	return {
		factory_id: factoryId,
		is_active_constraints_file: false as const,
		note: PROPOSALS_NOTE,
		evidence: "unavailable" as const,
		records: [] as never[],
		absence: "evidence unavailable" as const,
		explanation: "Constraint proposal evidence is unavailable.",
	};
}
