import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import type { ExecutionState } from "../../bootstrap/outcomes.ts";
import type { CommandEvidence } from "../../bootstrap/session-store.ts";
import {
	assertRunEvidenceConsistent,
	resolveRunObservations,
	STATUS_TEXT,
	type ProjectedCause,
	type ResolvedNodeObservation,
} from "./attempt-resolution.ts";
import type { TypedAbsence } from "./inspect.ts";
import { deletionMarkerFields, reboundOutputText, sanitizeOutputText } from "./sanitize.ts";

export const OUTPUT_SUMMARY_MAX_CHARS = 1000;
export const OUTPUT_DETAIL_MAX_CHARS = 8000;
export const OUTPUT_STRUCTURED_MAX_CHARS = 8000;
export const OUTPUT_COMMAND_EXCERPT_MAX_CHARS = 4000;
export const OUTPUT_LIST_ITEM_MAX_CHARS = 500;
export const OUTPUT_LIST_MAX_ITEMS = 20;
export const OUTPUT_DISPOSITION_REASON_MAX_CHARS = 4000;
export const OUTPUT_ERROR_MAX_CHARS = 4000;
export const OUTPUT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface BoundedList<T> {
	items: T[];
	total_count: number;
	omitted_count: number;
	omitted_marker?: string;
}

function itemsOmittedMarker(omitted: number): string {
	return `… [truncated, ${omitted} item${omitted === 1 ? "" : "s"} omitted]`;
}

function buildBoundedList<T, U>(raw: readonly T[] | undefined, maxItems: number, mapItem: (item: T) => U): BoundedList<U> | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const items = raw.slice(0, maxItems).map(mapItem);
	const omitted = Math.max(0, raw.length - items.length);
	return {
		items,
		total_count: raw.length,
		omitted_count: omitted,
		...(omitted > 0 ? { omitted_marker: itemsOmittedMarker(omitted) } : {}),
	};
}

function projectAttemptCommand(ev: CommandEvidence | undefined, blockedPaths: readonly string[]) {
	if (!ev) return undefined;
	const spawnError = typeof ev.spawn_error === "string" && ev.spawn_error
		? sanitizeOutputText(ev.spawn_error, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths)
		: undefined;
	const terminationError = typeof ev.termination_error === "string" && ev.termination_error
		? sanitizeOutputText(ev.termination_error, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths)
		: undefined;
	return {
		exit_code: ev.exit_code,
		signal: ev.signal,
		duration_ms: ev.duration_ms,
		stdout_bytes: ev.stdout_bytes,
		stderr_bytes: ev.stderr_bytes,
		...(typeof ev.stdout_excerpt === "string"
			? { stdout_excerpt: sanitizeOutputText(ev.stdout_excerpt, OUTPUT_COMMAND_EXCERPT_MAX_CHARS, blockedPaths) }
			: {}),
		...(typeof ev.stderr_excerpt === "string"
			? { stderr_excerpt: sanitizeOutputText(ev.stderr_excerpt, OUTPUT_COMMAND_EXCERPT_MAX_CHARS, blockedPaths) }
			: {}),
		...(spawnError ? { spawn_error: spawnError } : {}),
		...(terminationError ? { termination_error: terminationError } : {}),
	};
}

function projectScrubbedCauses(causes: readonly ProjectedCause[] | undefined, blockedPaths: readonly string[]): BoundedList<ProjectedCause> | undefined {
	return buildBoundedList(causes, OUTPUT_LIST_MAX_ITEMS, c => ({
		node_id: sanitizeOutputText(String(c.node_id), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
		state: c.state,
		reason: sanitizeOutputText(String(c.reason ?? ""), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
		...(c.check
			? {
				check: {
					name: sanitizeOutputText(String(c.check.name ?? ""), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
					evidence: c.check.evidence,
				},
			}
			: {}),
	}));
}

function trimBoundedListForBudget<T>(list: BoundedList<T>, targetBytes: number, measure: () => number): void {
	while (list.items.length > 0 && measure() > targetBytes) {
		list.items.pop();
		list.omitted_count += 1;
		list.omitted_marker = itemsOmittedMarker(list.omitted_count);
	}
}

function trimStringFieldForBudget(
	holder: Record<string, unknown>,
	key: string,
	targetBytes: number,
	measure: () => number,
): void {
	const cur = holder[key];
	if (typeof cur !== "string" || !cur || measure() <= targetBytes) return;
	const minChars = Math.min(Array.from(cur).length, 64);
	let low = minChars;
	let high = Array.from(cur).length;
	// Binary search the largest code-point cap that fits within targetBytes.
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		holder[key] = reboundOutputText(cur, mid);
		if (measure() <= targetBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	holder[key] = reboundOutputText(cur, low);
	if (measure() > targetBytes) {
		holder[key] = reboundOutputText(cur, 1);
	}
}

function enforceOutputResponseBudget(body: Record<string, unknown>, maxBytes = OUTPUT_MAX_RESPONSE_BYTES): Record<string, unknown> {
	const measure = () => Buffer.byteLength(JSON.stringify(body), "utf8");
	if (measure() <= maxBytes) return body;
	const att = body.latest_attempt as Record<string, unknown> | undefined;
	if (!att || typeof att !== "object") return body;

	trimStringFieldForBudget(att, "outputs_text", maxBytes, measure);
	if (measure() <= maxBytes) return body;

	for (const listKey of ["artifacts", "next_steps", "warnings", "verification", "causes"] as const) {
		const list = att[listKey] as BoundedList<unknown> | undefined;
		if (list && Array.isArray(list.items)) {
			trimBoundedListForBudget(list, maxBytes, measure);
			if (measure() <= maxBytes) return body;
		}
	}

	const cmd = att.command as Record<string, unknown> | undefined;
	if (cmd && typeof cmd === "object") {
		trimStringFieldForBudget(cmd, "stderr_excerpt", maxBytes, measure);
		if (measure() <= maxBytes) return body;
		trimStringFieldForBudget(cmd, "stdout_excerpt", maxBytes, measure);
		if (measure() <= maxBytes) return body;
	}

	for (const strKey of ["detail", "error_message", "disposition_reason", "summary"] as const) {
		trimStringFieldForBudget(att, strKey, maxBytes, measure);
		if (measure() <= maxBytes) return body;
	}
	return body;
}

function projectAttemptFromObservation(obs: ResolvedNodeObservation, blockedPaths: readonly string[]) {
	const attemptIdVal = obs.attempt_id ?? {
		absence: "evidence unavailable" as TypedAbsence,
		explanation: "Attempt identity could not be verified.",
	};

	const unavailable = (
		status: ExecutionState,
		statusText: string,
		explanation: string,
		extras: Record<string, unknown> = {},
	) => ({
		attempt_id: attemptIdVal,
		attempt_number: obs.attempt_number,
		max_attempts: obs.max_attempts,
		status,
		status_text: statusText,
		evidence: "unavailable" as const,
		absence: "evidence unavailable" as TypedAbsence,
		explanation,
		...extras,
	});

	const notApplicable = (
		status: ExecutionState,
		statusText: string,
		explanation: string,
		extras: Record<string, unknown> = {},
	) => ({
		attempt_id: attemptIdVal,
		attempt_number: obs.attempt_number,
		max_attempts: obs.max_attempts,
		status,
		status_text: statusText,
		evidence: "not applicable" as const,
		absence: "not applicable" as TypedAbsence,
		explanation,
		...extras,
	});

	if (obs.corrupt_or_unverified) {
		return unavailable(
			obs.attempt_status,
			obs.attempt_status_text,
			obs.evidence_problem ?? "Attempt output evidence is unavailable because the result record is missing, damaged, unreadable, or fails verification.",
		);
	}

	if (obs.has_disposition && obs.disposition_record) {
		const disp = obs.disposition_record;
		const dispositionReason = sanitizeOutputText(
			disp.reason || `Recorded disposition: ${disp.state}.`,
			OUTPUT_DISPOSITION_REASON_MAX_CHARS,
			blockedPaths,
		);
		const causes = projectScrubbedCauses(obs.raw_causes ?? obs.causes, blockedPaths);
		const command = projectAttemptCommand(disp.command_evidence, blockedPaths);
		const extras = {
			disposition_state: disp.state,
			disposition_reason: dispositionReason,
			...(causes ? { causes } : {}),
			...(disp.recorded_at ? { recorded_at: disp.recorded_at } : {}),
			...(command ? { command } : {}),
		};
		if (obs.handoff_error || disp.state === "needs_attention") {
			return unavailable(
				obs.attempt_status,
				obs.attempt_status_text,
				obs.handoff_error
					? "Node handoff evidence is missing, damaged or contradictory."
					: "Attempt ended with unresolved evidence and no recorded result.",
				extras,
			);
		}
		return notApplicable(
			obs.attempt_status,
			obs.attempt_status_text,
			`No attempt result was recorded (${disp.state}).`,
			extras,
		);
	}

	if (obs.has_result && obs.result_record) {
		const record = obs.result_record;
		const res = record.result;
		const summary = sanitizeOutputText(res.summary, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths);
		const rawDetail = typeof res.detail === "string" ? res.detail : "";
		const detail = sanitizeOutputText(rawDetail, OUTPUT_DETAIL_MAX_CHARS, blockedPaths);
		const verification = buildBoundedList(res.verification, OUTPUT_LIST_MAX_ITEMS, v => ({
			check_id: sanitizeOutputText(String(v?.check_id ?? ""), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
			result: v?.result === "pass" || v?.result === "fail" || v?.result === "error"
				? v.result
				: sanitizeOutputText(String(v?.result ?? "unknown"), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
			applicability: v?.applicability === "current" || v?.applicability === "stale" || v?.applicability === "unknown"
				? v.applicability
				: sanitizeOutputText(String(v?.applicability ?? "unknown"), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
			scope_kind: v?.scope_kind === "declared" || v?.scope_kind === "conservative" || v?.scope_kind === "unknown"
				? v.scope_kind
				: sanitizeOutputText(String(v?.scope_kind ?? "unknown"), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
			...(typeof v?.completed_at === "string" && v.completed_at
				? { completed_at: sanitizeOutputText(v.completed_at, OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths) }
				: {}),
			...(typeof v?.reason === "string" && v.reason
				? { reason: sanitizeOutputText(v.reason, OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths) }
				: {}),
		}));
		const warnings = buildBoundedList(res.warnings, OUTPUT_LIST_MAX_ITEMS, w =>
			sanitizeOutputText(String(w ?? ""), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
		);
		const nextSteps = buildBoundedList(res.next_steps, OUTPUT_LIST_MAX_ITEMS, s =>
			sanitizeOutputText(String(s ?? ""), OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
		);
		const command = projectAttemptCommand(res.command_evidence, blockedPaths);
		const outputsText = res.outputs !== undefined
			? sanitizeOutputText(JSON.stringify(res.outputs, null, 2), OUTPUT_STRUCTURED_MAX_CHARS, blockedPaths)
			: undefined;
		// Never project artifacts[].path or host provenance paths.
		const artifacts = buildBoundedList(res.artifacts, OUTPUT_LIST_MAX_ITEMS, a => ({
			type: sanitizeOutputText(typeof a?.type === "string" && a.type ? a.type : "artifact", 128, blockedPaths),
			...(typeof a?.action === "string" && a.action
				? { action: sanitizeOutputText(a.action, 128, blockedPaths) }
				: {}),
			...(typeof a?.description === "string" && a.description
				? { description: sanitizeOutputText(a.description, OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths) }
				: {}),
			...(a?.missing !== undefined ? { missing: Boolean(a.missing) } : {}),
		}));

		return {
			attempt_id: attemptIdVal,
			attempt_number: obs.attempt_number,
			max_attempts: obs.max_attempts,
			status: obs.attempt_status,
			status_text: obs.attempt_status_text,
			result_status: res.status,
			evidence: "available" as const,
			summary,
			detail,
			...(verification ? { verification } : {}),
			...(warnings ? { warnings } : {}),
			...(nextSteps ? { next_steps: nextSteps } : {}),
			...(command ? { command } : {}),
			...(outputsText !== undefined ? { outputs_text: outputsText } : {}),
			...(artifacts ? { artifacts } : {}),
			...(record.completed_at ? { completed_at: record.completed_at } : {}),
		};
	}

	if (obs.handoff_error) {
		return unavailable(obs.attempt_status, obs.attempt_status_text, obs.reason ?? "Node handoff evidence is missing, damaged or contradictory.");
	}

	if (obs.upstream_closed) {
		const dispositionReason = sanitizeOutputText(
			obs.raw_reason || obs.reason || "Blocked by upstream review closure.",
			OUTPUT_DISPOSITION_REASON_MAX_CHARS,
			blockedPaths,
		);
		const causes = projectScrubbedCauses(obs.raw_causes ?? obs.causes, blockedPaths);
		return notApplicable(
			obs.attempt_status,
			obs.attempt_status_text,
			"No attempt result was recorded (blocked).",
			{
				disposition_state: "blocked",
				disposition_reason: dispositionReason,
				...(causes ? { causes } : {}),
			},
		);
	}

	if (obs.error_source) {
		const errorMessage = obs.error_message
			? sanitizeOutputText(obs.error_message, OUTPUT_ERROR_MAX_CHARS, blockedPaths)
			: undefined;
		return unavailable(
			obs.attempt_status,
			obs.attempt_status_text,
			obs.evidence_problem ?? "The attempt recorded an execution error without a verified result.",
			errorMessage ? { error_message: errorMessage } : {},
		);
	}

	if (obs.claim_outcome === "completed") {
		return unavailable(
			obs.attempt_status,
			obs.attempt_status_text,
			"The attempt recorded completion without a readable result record.",
		);
	}

	if (obs.attempt_status === "cancelled") {
		const dispositionReason = sanitizeOutputText(
			obs.cancel_reason || "Cancelled.",
			OUTPUT_DISPOSITION_REASON_MAX_CHARS,
			blockedPaths,
		);
		return notApplicable(
			"cancelled",
			STATUS_TEXT.cancelled,
			"No attempt result was recorded because the attempt was cancelled.",
			{
				disposition_state: "cancelled",
				disposition_reason: dispositionReason,
			},
		);
	}

	if (obs.evidence_problem) {
		return unavailable(obs.attempt_status, obs.attempt_status_text, obs.evidence_problem);
	}

	return notApplicable(
		obs.attempt_status,
		obs.attempt_status_text,
		"Attempt output is recorded when the attempt finishes.",
	);
}

export type OutputSnapshotOutcome =
	| { kind: "not_found"; error: string }
	| { kind: "ok"; body: Record<string, unknown> };

/** Project the latest attempt's scrubbed, bounded output for one node of a factory's displayed run. */
export function nodeOutputSnapshot(
	factoryId: string,
	nodeId: string,
	inspection: Inspection,
	releases: ReleasedFactoryRun[],
	blockedPaths: readonly string[] = [],
): OutputSnapshotOutcome {
	const deletionFields = deletionMarkerFields(inspection, blockedPaths);
	const consistent = assertRunEvidenceConsistent(inspection, releases);
	if (consistent.state === "no_displayed_run") {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}
	if (consistent.state === "uncertain") {
		if (releases.length > 0 && !releases.some(r => r.definition.agents.some(entry => entry.node.node_id === nodeId))) {
			return { kind: "not_found", error: "Node not found in displayed run" };
		}
		return {
			kind: "ok",
			body: {
				factory_id: factoryId,
				node_id: nodeId,
				...deletionFields,
				evidence: "unavailable",
				absence: "evidence unavailable" as TypedAbsence,
				explanation: "Run evidence is uncertain; attempt output cannot be verified.",
			},
		};
	}

	const release = consistent.release;
	if (!release.definition.agents.some(entry => entry.node.node_id === nodeId)) {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	let resolved: ReturnType<typeof resolveRunObservations>;
	try {
		resolved = resolveRunObservations(factoryId, release, blockedPaths, { enforceNodeRecordSizeLimit: true });
	} catch {
		return {
			kind: "ok",
			body: {
				factory_id: factoryId,
				node_id: nodeId,
				...deletionFields,
				evidence: "unavailable",
				absence: "evidence unavailable" as TypedAbsence,
				explanation: "Run topology could not be verified against its bound definition.",
			},
		};
	}

	const obs = resolved.observations.get(nodeId);
	if (!obs) {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	const latestAttempt = projectAttemptFromObservation(obs, resolved.runBlockedPaths);
	const body: Record<string, unknown> = {
		factory_id: factoryId,
		node_id: nodeId,
		run_id: resolved.manifest.task_id,
		bound_version: resolved.bound_version,
		...deletionFields,
		evidence: latestAttempt.evidence,
		latest_attempt: latestAttempt,
	};
	return {
		kind: "ok",
		body: enforceOutputResponseBudget(body),
	};
}
