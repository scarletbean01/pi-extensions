import { deriveRunOutcome } from "../queue.ts";
import type { AttemptSummary, InputReceipt, Inspection } from "../operations.ts";
import { DISPOSITION_EXPLANATIONS, headSummary, type TypedAbsence } from "./inspect.ts";

export type QueueFilter = "open" | "all";

const FINISHED_DISPOSITIONS = new Set<string>(["settled", "discarded", "cleared"]);

const ATTEMPT_STATE_EXPLANATIONS: Record<string, string> = {
	reserved: "Launch reserved capacity and is preparing to release.",
	released: "Run was released to execute and currently holds capacity until settled or cleared.",
	failed_before_release: "Launch failed before release; non-release has not been settled yet.",
	proven_not_released: "Launch attempt was proven never to have released.",
	settled: "Run execution settled and its capacity holds were released.",
	cleared: "Capacity holds were cleared by an operator while original execution effects remain unresolved.",
};

function normalizeAttemptForOutcome(att: AttemptSummary): AttemptSummary {
	if (att.settlement || !att.clearance) return att;
	return {
		...att,
		settlement: {
			...att.clearance.observations,
			capacity_release: "released",
			released_holds: att.clearance.released_holds,
		},
	};
}

function attemptUncertaintyState(att: AttemptSummary) {
	const normalized = normalizeAttemptForOutcome(att);
	const knownState = Object.hasOwn(ATTEMPT_STATE_EXPLANATIONS, att.state);
	const authContradiction = (att.state === "settled" || att.state === "cleared") && !att.release_authorized;
	const missingTerminalRecord = (att.state === "settled" && !att.settlement)
		|| (att.state === "cleared" && !att.clearance && !att.settlement);
	const outcomeUncertain = deriveRunOutcome(normalized) === "uncertain";
	return {
		knownState,
		authContradiction,
		uncertain: outcomeUncertain || !knownState || authContradiction || missingTerminalRecord,
	};
}

function receiptLinks(factoryId: string, reference: string) {
	return {
		receipt_url: `/?${new URLSearchParams({ factory: factoryId, view: "receipts", reference })}`,
		receipt_snapshot_url: `/api/factories/${encodeURIComponent(factoryId)}/receipts?${new URLSearchParams({ reference })}`,
	};
}

/** Operator-facing unavailable queue snapshot when store or coordination evidence cannot be read safely. */
export function unavailableQueueSnapshot(factoryId: string) {
	return {
		factory_id: factoryId,
		evidence: "unavailable" as const,
		entries: [] as never[],
		absence: "evidence unavailable" as const,
		explanation: "Queue evidence is unavailable.",
	};
}

/** Operator-facing queue snapshot projected from a verified read-only Inspection. */
export function queueSnapshot(inspection: Inspection, factoryId: string, filter: QueueFilter) {
	const damagedVersions = new Set(
		inspection.versions.filter(v => Boolean(v.corrupt_reason)).map(v => v.version),
	);
	const allRows = inspection.queue.map(entry => {
		const attemptUncertain = entry.attempt ? attemptUncertaintyState(entry.attempt).uncertain : false;
		const boundDamaged = damagedVersions.has(entry.bound_version);
		const missingAttemptForFinished = FINISHED_DISPOSITIONS.has(entry.disposition)
			&& entry.disposition !== "discarded"
			&& !entry.attempt;
		const uncertain = attemptUncertain
			|| boundDamaged
			|| missingAttemptForFinished;
		return {
			input_id: entry.input_id,
			reference: entry.reference,
			queue_position: entry.queue_position,
			bound_version: entry.bound_version,
			...(boundDamaged ? { bound_version_evidence: "unavailable" as const } : {}),
			disposition: entry.disposition,
			disposition_explanation: DISPOSITION_EXPLANATIONS[entry.disposition],
			uncertain,
			accepted_at: entry.accepted_at,
			is_head: inspection.head_status.input_id === entry.input_id,
			...receiptLinks(factoryId, entry.reference),
		};
	});

	const entries = filter === "all"
		? allRows
		: allRows.filter(row => row.uncertain || !FINISHED_DISPOSITIONS.has(row.disposition));

	const anyUncertain = Boolean(
		inspection.uncertainty.length
		|| inspection.current_error
		|| inspection.head_status.blocking_kind === "uncertain"
		|| allRows.some(row => row.uncertain),
	);

	let absence: TypedAbsence | undefined;
	let explanation: string;
	if (entries.length === 0) {
		if (inspection.factory.management === "unmanaged") {
			absence = "not applicable";
			explanation = "Queue admission applies only to a managed factory.";
		} else if (allRows.length === 0) {
			absence = "no records";
			explanation = "No factory inputs have been admitted.";
		} else {
			absence = "no records";
			explanation = `No open inputs in the queue (${allRows.length} finished input(s) hidden by the open filter).`;
		}
	} else {
		explanation = `${entries.length} of ${allRows.length} admitted input(s) shown (${filter} filter).`;
	}

	return {
		factory_id: factoryId,
		filter,
		evidence: anyUncertain ? ("uncertain" as const) : ("available" as const),
		total_count: allRows.length,
		entries,
		...(absence ? { absence } : {}),
		explanation,
		head_status: headSummary(inspection.head_status, inspection),
	};
}

function projectReceiptAttempt(receipt: InputReceipt, inspectedAttempt?: AttemptSummary) {
	const att = receipt.attempt;
	if (!att) {
		if (receipt.disposition === "discarded") {
			return {
				absence: "not applicable" as const,
				explanation: "Input was discarded without launching.",
			};
		}
		if (receipt.disposition === "queued" || receipt.disposition === "blocked" || receipt.disposition === "retryable") {
			return {
				absence: "no records" as const,
				explanation: "No launch attempt has been recorded for this input.",
			};
		}
		return {
			evidence: "unavailable" as const,
			absence: "evidence unavailable" as const,
			explanation: "Recorded launch attempt evidence is unavailable for this input disposition.",
		};
	}
	const effectiveAttempt = inspectedAttempt && inspectedAttempt.attempt_id === att.attempt_id
		? { ...att, ...inspectedAttempt }
		: att;
	const { knownState, authContradiction, uncertain } = attemptUncertaintyState(effectiveAttempt);
	const stateExplanation = !knownState || authContradiction
		? "Launch attempt state is unrecognized or inconsistent with release authorization."
		: uncertain
			? `${ATTEMPT_STATE_EXPLANATIONS[att.state]!} Associated run or settlement evidence is uncertain.`
			: ATTEMPT_STATE_EXPLANATIONS[att.state]!;
	return {
		attempt_id: att.attempt_id,
		state: att.state,
		state_explanation: stateExplanation,
		bound_version: att.bound_version,
		task_id: att.task_id,
		request_id: att.request_id,
		release_authorized: att.release_authorized,
		release_authorized_at: att.release_authorized_at ?? {
			absence: "not applicable" as const,
			explanation: "Release authorization was not committed for this attempt.",
		},
		created_at: att.created_at,
		updated_at: att.updated_at,
		...(uncertain ? { uncertain: true } : {}),
	};
}

/** Operator-facing receipt snapshot projected from a verified read-only InputReceipt. */
export function receiptSnapshot(receipt: InputReceipt, factoryId: string, inspectedAttempt?: AttemptSummary) {
	return {
		type: "receipt" as const,
		is_run_report: false as const,
		note: "Receipt evidence is not a run report.",
		factory_id: factoryId,
		input_id: receipt.input_id,
		reference: receipt.reference,
		queue_position: receipt.queue_position,
		accepted_at: receipt.accepted_at,
		bound_version: receipt.bound_version,
		current_version: receipt.current_version ?? {
			absence: "evidence unavailable" as const,
			explanation: "Current factory version could not be verified; receipt bound version is shown independently.",
		},
		disposition: receipt.disposition,
		disposition_explanation: DISPOSITION_EXPLANATIONS[receipt.disposition],
		attempt: projectReceiptAttempt(receipt, inspectedAttempt),
	};
}
