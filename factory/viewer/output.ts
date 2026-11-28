import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import type { ExecutionState } from "../../bootstrap/outcomes.ts";
import type { CommandEvidence } from "../../bootstrap/session-store.ts";
import {
	assertRunEvidenceConsistent,
	resolveRunObservations,
	sanitizeCommandSignal,
	STATUS_TEXT,
	validateEvidenceStatus,
	validateExecutionState,
	validateIsoTimestamp,
	type ProjectedCause,
	type ResolvedNodeObservation,
} from "./attempt-resolution.ts";
import type { TypedAbsence } from "./inspect.ts";
import { collectArtifactPathTokens, deletionMarkerFields, reboundOutputText, sanitizeOutputText } from "./sanitize.ts";

export const OUTPUT_SUMMARY_MAX_CHARS = 1000;
export const OUTPUT_DETAIL_MAX_CHARS = 8000;
export const OUTPUT_STRUCTURED_MAX_CHARS = 8000;
export const OUTPUT_COMMAND_EXCERPT_MAX_CHARS = 4000;
export const OUTPUT_LIST_ITEM_MAX_CHARS = 500;
export const OUTPUT_LIST_MAX_ITEMS = 20;
export const OUTPUT_DISPOSITION_REASON_MAX_CHARS = 4000;
export const OUTPUT_ERROR_MAX_CHARS = 4000;
export const OUTPUT_MAX_RESPONSE_BYTES = 64 * 1024;
const OUTPUT_JSON_MAX_DEPTH = 64;
const OUTPUT_JSON_PRINTER_BUDGET = OUTPUT_STRUCTURED_MAX_CHARS * 4 + 256;

function cpLength(text: string): number {
	return Array.from(text).length;
}

/**
 * Iterative bounded JSON pretty-printer that caps depth and emitted length to avoid O(depth^2) expansion
 * or RangeError stack overflow on deeply nested structured outputs.
 */
function boundedPrettyPrintJson(
	value: unknown,
	maxChars = OUTPUT_JSON_PRINTER_BUDGET,
	maxDepth = OUTPUT_JSON_MAX_DEPTH,
): string {
	const chunks: string[] = [];
	let totalLen = 0;
	const push = (s: string): void => {
		if (totalLen >= maxChars) return;
		const remaining = maxChars - totalLen;
		if (s.length <= remaining) {
			chunks.push(s);
			totalLen += s.length;
		} else {
			chunks.push(s.slice(0, remaining));
			totalLen = maxChars;
		}
	};

	type Frame =
		| { kind: "value"; val: unknown; depth: number }
		| { kind: "text"; text: string };
	const stack: Frame[] = [{ kind: "value", val: value, depth: 0 }];
	while (stack.length > 0 && totalLen < maxChars) {
		const frame = stack.pop()!;
		if (frame.kind === "text") {
			push(frame.text);
			continue;
		}
		const { val, depth } = frame;
		if (val === null || typeof val === "boolean") {
			push(String(val));
			continue;
		}
		if (typeof val === "number") {
			push(Number.isFinite(val) ? String(val) : "null");
			continue;
		}
		if (typeof val === "string") {
			const boundedStr = val.length > maxChars ? val.slice(0, maxChars) : val;
			push(JSON.stringify(boundedStr));
			continue;
		}
		if (typeof val !== "object") {
			push("null");
			continue;
		}
		if (Array.isArray(val)) {
			if (val.length === 0) {
				push("[]");
				continue;
			}
			if (depth >= maxDepth) {
				push('"[...]"');
				continue;
			}
			const indent = "  ".repeat(depth);
			const childIndent = "  ".repeat(depth + 1);
			push("[\n");
			stack.push({ kind: "text", text: `\n${indent}]` });
			const limit = Math.min(val.length, maxChars);
			for (let idx = limit - 1; idx >= 0; idx--) {
				if (idx < limit - 1) stack.push({ kind: "text", text: ",\n" });
				stack.push({ kind: "value", val: val[idx], depth: depth + 1 });
				stack.push({ kind: "text", text: childIndent });
			}
			continue;
		}
		const entries = Object.entries(val as Record<string, unknown>).filter(
			([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol",
		);
		if (entries.length === 0) {
			push("{}");
			continue;
		}
		if (depth >= maxDepth) {
			push('"{...}"');
			continue;
		}
		const indent = "  ".repeat(depth);
		const childIndent = "  ".repeat(depth + 1);
		push("{\n");
		stack.push({ kind: "text", text: `\n${indent}}` });
		const limit = Math.min(entries.length, maxChars);
		for (let idx = limit - 1; idx >= 0; idx--) {
			const [k, v] = entries[idx]!;
			if (idx < limit - 1) stack.push({ kind: "text", text: ",\n" });
			stack.push({ kind: "value", val: v, depth: depth + 1 });
			const safeKey = k.length > maxChars ? k.slice(0, maxChars) : k;
			stack.push({ kind: "text", text: `${childIndent}${JSON.stringify(safeKey)}: ` });
		}
	}
	return chunks.join("");
}

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
		signal: sanitizeCommandSignal(ev.signal, blockedPaths, "output"),
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
	return buildBoundedList(causes, OUTPUT_LIST_MAX_ITEMS, c => {
		const rawNodeId = typeof c?.node_id === "string" ? c.node_id : "";
		const rawReason = typeof c?.reason === "string" ? c.reason : "";
		const rawCheck = c?.check && typeof c.check === "object" ? c.check : undefined;
		const rawCheckName = rawCheck && typeof rawCheck.name === "string" ? rawCheck.name : "";
		return {
			node_id: sanitizeOutputText(rawNodeId, 128, blockedPaths),
			state: validateExecutionState(c?.state),
			reason: sanitizeOutputText(rawReason, OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
			...(rawCheck
				? {
					check: {
						name: sanitizeOutputText(rawCheckName, OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths),
						evidence: validateEvidenceStatus(rawCheck.evidence),
					},
				}
				: {}),
		};
	});
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

// Ticket 03 will extend this budget across multiple attempts of the selected node.
export function enforceOutputResponseBudget(body: Record<string, unknown>, maxBytes = OUTPUT_MAX_RESPONSE_BYTES): Record<string, unknown> {
	const measure = () => Buffer.byteLength(JSON.stringify(body), "utf8");
	if (measure() <= maxBytes) return body;
	const att = body.latest_attempt as Record<string, unknown> | undefined;
	if (att && typeof att === "object") {
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
			for (const cmdKey of ["stderr_excerpt", "stdout_excerpt", "termination_error", "spawn_error"] as const) {
				trimStringFieldForBudget(cmd, cmdKey, maxBytes, measure);
				if (measure() <= maxBytes) return body;
			}
		}

		for (const strKey of ["detail", "error_message", "disposition_reason", "summary"] as const) {
			trimStringFieldForBudget(att, strKey, maxBytes, measure);
			if (measure() <= maxBytes) return body;
		}
	}

	if (measure() > maxBytes) {
		const fallbackAttempt: Record<string, unknown> = {
			attempt_id: att && (typeof att.attempt_id === "string" || (att.attempt_id && typeof att.attempt_id === "object"))
				? att.attempt_id
				: { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity could not be verified." },
			attempt_number: att && typeof att.attempt_number === "number" ? att.attempt_number : 1,
			max_attempts: att && typeof att.max_attempts === "number" ? att.max_attempts : 1,
			status: att && typeof att.status === "string" ? att.status : "needs_attention",
			status_text: att && typeof att.status_text === "string" ? att.status_text : "Uncertain",
			evidence: "unavailable" as const,
			absence: "evidence unavailable" as TypedAbsence,
			explanation: "Attempt output exceeded the response size budget and cannot be displayed.",
		};
		body.evidence = "unavailable";
		body.latest_attempt = fallbackAttempt;
		if (measure() > maxBytes) {
			fallbackAttempt.attempt_id = { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity unavailable." };
			fallbackAttempt.explanation = "Attempt output exceeded response budget.";
		}
	}
	return body;
}

function projectVerificationItem(
	raw: unknown,
	blockedPaths: readonly string[],
	artifactTokens: readonly string[],
) {
	const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const result = v.result === "pass" || v.result === "fail" || v.result === "error"
		? v.result
		: sanitizeOutputText(typeof v.result === "string" ? v.result : "unknown", 64, blockedPaths);
	const applicability = v.applicability === "current" || v.applicability === "stale" || v.applicability === "unknown"
		? v.applicability
		: sanitizeOutputText(typeof v.applicability === "string" ? v.applicability : "unknown", 64, blockedPaths);
	const scopeKind = v.scope_kind === "declared" || v.scope_kind === "conservative" || v.scope_kind === "unknown"
		? v.scope_kind
		: sanitizeOutputText(typeof v.scope_kind === "string" ? v.scope_kind : "unknown", 64, blockedPaths);
	const completedAt = validateIsoTimestamp(v.completed_at);
	const fixedLen = cpLength(result) + cpLength(applicability) + cpLength(scopeKind) + (completedAt ? cpLength(completedAt) : 0);
	const rem = Math.max(0, OUTPUT_LIST_ITEM_MAX_CHARS - fixedLen);

	const rawCheckId = typeof v.check_id === "string" ? v.check_id : "";
	let checkId = sanitizeOutputText(rawCheckId, rem, blockedPaths, artifactTokens);
	let reason = typeof v.reason === "string" && v.reason
		? sanitizeOutputText(v.reason, rem, blockedPaths, artifactTokens)
		: undefined;
	if (reason !== undefined && cpLength(checkId) + cpLength(reason) > rem) {
		const checkCap = Math.min(cpLength(checkId), Math.max(Math.floor(rem / 2), rem - cpLength(reason)));
		checkId = reboundOutputText(checkId, checkCap);
		const reasonCap = Math.max(0, rem - cpLength(checkId));
		reason = reboundOutputText(reason, reasonCap);
	}
	return {
		check_id: checkId,
		result,
		applicability,
		scope_kind: scopeKind,
		...(completedAt ? { completed_at: completedAt } : {}),
		...(reason !== undefined ? { reason } : {}),
	};
}

function projectArtifactItem(
	raw: unknown,
	blockedPaths: readonly string[],
	artifactTokens: readonly string[],
) {
	const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const type = sanitizeOutputText(typeof a.type === "string" && a.type ? a.type : "artifact", 128, blockedPaths);
	const action = typeof a.action === "string" && a.action
		? sanitizeOutputText(a.action, 128, blockedPaths)
		: undefined;
	const descBudget = Math.max(0, OUTPUT_LIST_ITEM_MAX_CHARS - cpLength(type) - (action ? cpLength(action) : 0));
	const description = typeof a.description === "string" && a.description && descBudget > 0
		? sanitizeOutputText(a.description, descBudget, blockedPaths, artifactTokens)
		: undefined;
	return {
		type,
		...(action ? { action } : {}),
		...(description ? { description } : {}),
		...(a.missing !== undefined ? { missing: Boolean(a.missing) } : {}),
	};
}

function projectAttemptFromObservation(
	obs: ResolvedNodeObservation,
	blockedPaths: readonly string[],
	projectCwd?: string,
) {
	const attemptIdVal = obs.corrupt_or_unverified || !obs.attempt_id
		? {
			absence: "evidence unavailable" as TypedAbsence,
			explanation: "Attempt identity could not be verified.",
		}
		: obs.attempt_id;
	const attemptNumber = obs.corrupt_or_unverified ? 1 : obs.attempt_number;

	const unavailable = (
		status: ExecutionState,
		statusText: string,
		explanation: string,
		extras: Record<string, unknown> = {},
	) => ({
		attempt_id: attemptIdVal,
		attempt_number: attemptNumber,
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
		attempt_number: attemptNumber,
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
		const recordedAt = validateIsoTimestamp(disp.recorded_at);
		const extras = {
			disposition_state: disp.state,
			disposition_reason: dispositionReason,
			...(causes ? { causes } : {}),
			...(recordedAt ? { recorded_at: recordedAt } : {}),
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
		const artifactTokens = collectArtifactPathTokens(res.artifacts, projectCwd);
		const summary = sanitizeOutputText(res.summary, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths, artifactTokens);
		const rawDetail = typeof res.detail === "string" ? res.detail : "";
		const detail = sanitizeOutputText(rawDetail, OUTPUT_DETAIL_MAX_CHARS, blockedPaths, artifactTokens);
		const verification = buildBoundedList(res.verification, OUTPUT_LIST_MAX_ITEMS, v =>
			projectVerificationItem(v, blockedPaths, artifactTokens),
		);
		const warnings = buildBoundedList(res.warnings, OUTPUT_LIST_MAX_ITEMS, w =>
			sanitizeOutputText(typeof w === "string" ? w : "", OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths, artifactTokens),
		);
		const nextSteps = buildBoundedList(res.next_steps, OUTPUT_LIST_MAX_ITEMS, s =>
			sanitizeOutputText(typeof s === "string" ? s : "", OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths, artifactTokens),
		);
		const command = projectAttemptCommand(res.command_evidence, blockedPaths);
		let outputsText: string | undefined;
		if (res.outputs !== undefined) {
			try {
				outputsText = sanitizeOutputText(
					boundedPrettyPrintJson(res.outputs),
					OUTPUT_STRUCTURED_MAX_CHARS,
					blockedPaths,
					artifactTokens,
				);
			} catch {
				outputsText = undefined;
			}
		}
		// Never project artifacts[].path or host provenance paths.
		const artifacts = buildBoundedList(res.artifacts, OUTPUT_LIST_MAX_ITEMS, a =>
			projectArtifactItem(a, blockedPaths, artifactTokens),
		);
		const completedAt = validateIsoTimestamp(record.completed_at);

		return {
			attempt_id: attemptIdVal,
			attempt_number: attemptNumber,
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
			...(completedAt ? { completed_at: completedAt } : {}),
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
		// Enforce the 1 MiB record limit only on the requested node so upstream observations stay aligned with /live (N5).
		// Ticket 03 will add per-attempt resolution across `<inst>.<n>.result.json` here.
		resolved = resolveRunObservations(factoryId, release, blockedPaths, { enforceSizeLimitNodeId: nodeId });
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

	const latestAttempt = projectAttemptFromObservation(obs, resolved.runBlockedPaths, resolved.manifest.project_cwd);
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
