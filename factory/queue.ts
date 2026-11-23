import type { AttemptSummary, HeadStatus, Inspection, InputDisposition } from "./operations.ts";

const BRIEF_PREVIEW_MAX = 60;
const SHORT_TASK_ID_MAX = 16;

function stripControlToSingleLine(text: string): string {
	return text
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069\p{Cf}]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateText(text: string, maxLen: number): string {
	const codePoints = Array.from(text);
	if (codePoints.length <= maxLen) return text;
	return `${codePoints.slice(0, Math.max(1, maxLen - 1)).join("")}…`;
}

export function sanitizeBriefPreview(brief: string, maxLen = BRIEF_PREVIEW_MAX): string {
	return truncateText(stripControlToSingleLine(brief), maxLen);
}

export function shortTaskId(taskId: string | undefined, maxLen = SHORT_TASK_ID_MAX): string | null {
	if (!taskId) return null;
	return truncateText(taskId, maxLen);
}

function hasHeldCommandOwnership(attempt: AttemptSummary): boolean {
	if (attempt.state === "cleared" || attempt.settlement?.outcome !== "needs_attention") return false;
	const risk = attempt.settlement.resume_risk ?? [];
	for (const entry of risk) {
		const match = entry.match(/^(.+?) still holds write ownership \((admitted|held_uncertain)\)$/);
		if (!match) continue;
		const nodeId = match[1]!;
		if (attempt.node_policies?.[nodeId]?.kind === "command") return true;
		if (attempt.run?.worker_errors?.some(err => err.startsWith(`${nodeId} (command):`))) return true;
		if (attempt.settlement.execution_settlement.reason.includes(`${nodeId} (command):`)) return true;
	}
	return false;
}

export function deriveRunOutcome(attempt: AttemptSummary | undefined): string | null {
	if (!attempt) return null;
	if (attempt.uncertainty?.length) return "uncertain";
	if (attempt.settlement) {
		if (attempt.settlement.evidence_unreadable) return "uncertain";
		if (hasHeldCommandOwnership(attempt)) {
			return "needs_attention";
		}
		if (attempt.settlement.execution_settlement.state === "unknown") {
			return "uncertain";
		}
		if (attempt.settlement.outcome === "incomplete" && attempt.state === "released" && attempt.run?.status === "applied") {
			return "running";
		}
		return attempt.settlement.outcome;
	}
	if (attempt.run) {
		const outcomeState = (attempt.run.outcome as { state?: string } | undefined)?.state;
		if (outcomeState === "incomplete" && attempt.state === "released" && attempt.run.status === "applied") {
			return "running";
		}
		if (outcomeState) return outcomeState;
		if (attempt.run.status === "error") return "error";
	}
	return null;
}

export interface QueueRowView {
	queue_position: number;
	input_id: string;
	reference: string;
	disposition: InputDisposition;
	bound_version: string;
	is_head: boolean;
	attempt_count: number;
	earlier_attempts: number;
	attempt_state: string | null;
	run_outcome: string | null;
	task_id: string | null;
	short_task_id: string | null;
	accepted_at: string;
	brief_preview: string;
	uncertainty: string[] | null;
}

export interface QueueView {
	factory: {
		factory_id: string;
		name: string;
		current_version: string;
		management: Inspection["factory"]["management"];
		stopped: boolean | null;
		control_error: string | null;
		current_error: string | null;
	};
	filter: "all" | "open";
	total_inputs: number;
	shown_inputs: number;
	uncertainty: string[];
	inputs: QueueRowView[];
	head_status: {
		eligible: boolean;
		input_id: string | null;
		reference: string | null;
		blocking_kind: HeadStatus["blocking_kind"] | null;
		reason: string | null;
		without_control_fence: {
			eligible: boolean;
			blocking_kind: HeadStatus["blocking_kind"] | null;
			reason: string | null;
		} | null;
	};
	capacity: {
		queue_used: number;
		queue_limit: number;
		factory_slot: Inspection["capacity"]["factory_slot"];
		checkout_slot: Inspection["capacity"]["checkout_slot"];
		blocking_hold: {
			scope: "factory" | "checkout" | "both";
			factory_id: string;
			input_id: string;
			attempt_id: string;
			task_id: string;
			state: string;
		} | null;
	};
}

function isOpenQueueRow(row: QueueRowView): boolean {
	if (row.uncertainty?.length || row.run_outcome === "uncertain") return true;
	return row.disposition !== "settled" && row.disposition !== "discarded" && row.disposition !== "cleared";
}

export function buildQueueView(view: Inspection, openOnly = false): QueueView {
	const attemptCounts = new Map<string, number>();
	for (const attempt of view.attempts) {
		attemptCounts.set(attempt.input_id, (attemptCounts.get(attempt.input_id) ?? 0) + 1);
	}
	const sortedInputs = [...view.queue].sort((a, b) => a.queue_position - b.queue_position);
	const allRows: QueueRowView[] = sortedInputs.map(item => {
		const attempt = item.attempt;
		const attemptCount = attemptCounts.get(item.input_id) ?? (attempt ? 1 : 0);
		return {
			queue_position: item.queue_position,
			input_id: item.input_id,
			reference: item.reference,
			disposition: item.disposition,
			bound_version: item.bound_version,
			is_head: view.head_status.input_id === item.input_id,
			attempt_count: attemptCount,
			earlier_attempts: Math.max(0, attemptCount - 1),
			attempt_state: attempt?.state ?? null,
			run_outcome: deriveRunOutcome(attempt),
			task_id: attempt?.task_id ?? null,
			short_task_id: shortTaskId(attempt?.task_id),
			accepted_at: item.accepted_at,
			brief_preview: sanitizeBriefPreview(item.brief),
			uncertainty: attempt?.uncertainty?.length ? [...attempt.uncertainty] : null,
		};
	});
	const rows = openOnly ? allRows.filter(isOpenQueueRow) : allRows;
	const uncertainty = [...new Set([
		...view.uncertainty,
		...allRows.filter(row => row.run_outcome === "uncertain" && !row.uncertainty?.length).map(row => `${row.reference} (${row.disposition}): uncertain execution outcome`),
		...(view.current_error ? [view.current_error] : []),
		...(view.inspected_error ? [view.inspected_error] : []),
		...(view.control_error ? [view.control_error] : []),
		...(view.request_evidence_error ? [view.request_evidence_error] : []),
		...(view.proposal_evidence_error ? [view.proposal_evidence_error] : []),
	])];

	return {
		factory: {
			factory_id: view.factory.factory_id,
			name: view.factory.name,
			current_version: view.factory.current_version,
			management: view.factory.management,
			stopped: view.stopped ?? null,
			control_error: view.control_error ?? null,
			current_error: view.current_error ?? null,
		},
		filter: openOnly ? "open" : "all",
		total_inputs: allRows.length,
		shown_inputs: rows.length,
		uncertainty,
		inputs: rows,
		head_status: {
			eligible: view.head_status.eligible,
			input_id: view.head_status.input_id ?? null,
			reference: view.head_status.reference ?? null,
			blocking_kind: view.head_status.blocking_kind ?? null,
			reason: view.head_status.reason ?? null,
			without_control_fence: view.head_status.without_control_fence ? {
				eligible: view.head_status.without_control_fence.eligible,
				blocking_kind: view.head_status.without_control_fence.blocking_kind ?? null,
				reason: view.head_status.without_control_fence.reason ?? null,
			} : null,
		},
		capacity: {
			queue_used: view.capacity.queue_used,
			queue_limit: view.capacity.queue_limit,
			factory_slot: view.capacity.factory_slot,
			checkout_slot: view.capacity.checkout_slot,
			blocking_hold: view.capacity.blocking_hold ? {
				scope: view.capacity.blocking_hold.scope,
				factory_id: view.capacity.blocking_hold.factory_id,
				input_id: view.capacity.blocking_hold.input_id,
				attempt_id: view.capacity.blocking_hold.attempt_id,
				task_id: view.capacity.blocking_hold.task_id,
				state: view.capacity.blocking_hold.state,
			} : null,
		},
	};
}

export function formatQueueTable(q: QueueView): string {
	const mgmt = q.factory.control_error ? "control uncertain" : q.factory.stopped ? "stopped" : q.factory.management;
	const ver = q.factory.current_error ? "version uncertain" : q.factory.current_version;
	const countLabel = q.filter === "open" ? `open ${q.shown_inputs}/${q.total_inputs}` : `${q.total_inputs} input(s)`;
	const lines: string[] = [
		`Factory ${q.factory.name} (${q.factory.factory_id}) · ${mgmt} · ${ver} · ${countLabel}`,
	];
	if (q.uncertainty.length > 0) {
		lines.push(`UNCERTAIN EVIDENCE: ${q.uncertainty.map(stripControlToSingleLine).join("; ")}`);
	}
	if (q.total_inputs === 0) {
		lines.push("no inputs submitted");
	} else if (q.inputs.length === 0) {
		lines.push(`no open inputs (${q.total_inputs} total)`);
	} else {
		const cells = q.inputs.map(row => [
			`${row.is_head ? "*" : ""}${row.queue_position}`,
			stripControlToSingleLine(row.reference),
			row.disposition,
			row.attempt_state ? `${row.attempt_state}${row.earlier_attempts > 0 ? ` (+${row.earlier_attempts} prior)` : ""}` : "-",
			row.run_outcome ?? "-",
			row.short_task_id ?? "-",
			row.accepted_at,
			row.brief_preview,
		]);
		const headers = ["POS", "REF", "DISPOSITION", "ATTEMPT", "OUTCOME", "TASK_ID", "ACCEPTED_AT", "BRIEF"];
		const widths = headers.map((header, idx) => {
			if (idx === headers.length - 1) return header.length;
			return Math.max(header.length, ...cells.map(row => row[idx]!.length));
		});
		const padRow = (cols: string[]) => cols.map((col, idx) => idx === cols.length - 1 ? col : col.padEnd(widths[idx]!)).join("  ");
		lines.push(padRow(headers));
		for (const row of cells) lines.push(padRow(row));
	}

	const headRow = q.head_status.input_id
		? q.inputs.find(item => item.input_id === q.head_status.input_id)
		: undefined;
	const headLine = q.head_status.input_id
		? `Head: ${headRow ? `#${headRow.queue_position} ` : ""}${q.head_status.reference ?? q.head_status.input_id} (${q.head_status.input_id}) — ${q.head_status.eligible ? "eligible" : `blocked (${q.head_status.blocking_kind ?? "blocked"}: ${truncateText(stripControlToSingleLine(q.head_status.reason ?? ""), 110)})`}`
		: `Head: none — ${q.head_status.blocking_kind ?? "empty"}${q.head_status.reason ? `: ${truncateText(stripControlToSingleLine(q.head_status.reason), 110)}` : ""}`;
	const holdNote = q.capacity.blocking_hold
		? ` · held by ${shortTaskId(q.capacity.blocking_hold.task_id) ?? q.capacity.blocking_hold.task_id} (${q.capacity.blocking_hold.scope})`
		: "";
	const capacityLine = `Capacity: ${q.capacity.queue_used}/${q.capacity.queue_limit} queued · factory_slot=${q.capacity.factory_slot} · checkout_slot=${q.capacity.checkout_slot}${holdNote}`;
	lines.push(headLine, capacityLine);
	return lines.join("\n");
}
