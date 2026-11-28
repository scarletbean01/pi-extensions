import { join } from "node:path";
import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import type { ExecutionState } from "../../bootstrap/outcomes.ts";
import {
	assertTaskId,
	parseManifest,
	pathEntryExists,
	type BootstrapManifest,
	type CommandEvidence,
} from "../../bootstrap/session-store.ts";
import {
	assertPathInsideDir,
	assertRegularFileIfExists,
	assertRunEvidenceConsistent,
	MAX_EVIDENCE_FILE_BYTES,
	readBoundedRegularJsonIfExists,
	resolveNodeAttempts,
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
import {
	collectArtifactPathTokens,
	compileArtifactRedactionMatcher,
	deletionMarkerFields,
	reboundOutputText,
	sanitizeOutputText,
	type ArtifactRedactionMatcher,
} from "./sanitize.ts";

export const OUTPUT_SUMMARY_MAX_CHARS = 1000;
export const OUTPUT_DETAIL_MAX_CHARS = 8000;
export const OUTPUT_STRUCTURED_MAX_CHARS = 8000;
export const OUTPUT_COMMAND_EXCERPT_MAX_CHARS = 4000;
export const OUTPUT_LIST_ITEM_MAX_CHARS = 500;
export const OUTPUT_LIST_MAX_ITEMS = 20;
export const OUTPUT_MAX_ATTEMPTS = 20;
export const OUTPUT_DISPOSITION_REASON_MAX_CHARS = 4000;
export const OUTPUT_ERROR_MAX_CHARS = 4000;
export const OUTPUT_MAX_RESPONSE_BYTES = 64 * 1024;
const OUTPUT_JSON_MAX_DEPTH = 64;
const OUTPUT_JSON_PRINTER_BUDGET = OUTPUT_STRUCTURED_MAX_CHARS * 4 + 256;
const OUTPUT_JSON_INDENTS = Array.from({ length: OUTPUT_JSON_MAX_DEPTH + 1 }, (_, d) => "  ".repeat(d));

function cpLength(text: string): number {
	return Array.from(text).length;
}

function jsonStringCodePointLength(s: string): number {
	let count = 2; // opening and closing quotes
	const len = s.length;
	for (let i = 0; i < len; ) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 < len) {
				const next = s.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					count += 1;
					i += 2;
					continue;
				}
			}
			count += 6;
			i += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			count += 6;
			i += 1;
			continue;
		}
		if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
			count += 2;
		} else if (code < 0x20) {
			count += 6;
		} else {
			count += 1;
		}
		i += 1;
	}
	return count;
}

/**
 * Iterative bounded JSON pretty-printer that caps depth and emitted text length while still
 * counting the full depth-bounded code-point length so truncation markers report true omitted counts.
 */
function boundedPrettyPrintJson(
	value: unknown,
	maxChars = OUTPUT_JSON_PRINTER_BUDGET,
	maxDepth = OUTPUT_JSON_MAX_DEPTH,
): { text: string; extraCodePoints: number } {
	const chunks: string[] = [];
	let emittedCp = 0;
	let extraCodePoints = 0;

	const pushAscii = (s: string): void => {
		if (emittedCp >= maxChars) {
			extraCodePoints += s.length;
			return;
		}
		const remaining = maxChars - emittedCp;
		if (s.length <= remaining) {
			chunks.push(s);
			emittedCp += s.length;
		} else {
			chunks.push(s.slice(0, remaining));
			emittedCp = maxChars;
			extraCodePoints += s.length - remaining;
		}
	};

	const pushIndent = (depth: number): void => {
		if (depth <= 0) return;
		if (emittedCp >= maxChars) {
			extraCodePoints += depth * 2;
			return;
		}
		pushAscii(OUTPUT_JSON_INDENTS[depth] ?? "  ".repeat(depth));
	};

	const pushJsonString = (s: string): void => {
		const fullCpLen = jsonStringCodePointLength(s);
		if (emittedCp >= maxChars) {
			extraCodePoints += fullCpLen;
			return;
		}
		const remaining = maxChars - emittedCp;
		if (fullCpLen <= remaining) {
			chunks.push(JSON.stringify(s));
			emittedCp += fullCpLen;
			return;
		}
		let sliceEnd = 0;
		let sliceCp = 0;
		while (sliceEnd < s.length && sliceCp < remaining) {
			const c = s.charCodeAt(sliceEnd);
			sliceEnd += c >= 0xd800 && c <= 0xdbff && sliceEnd + 1 < s.length ? 2 : 1;
			sliceCp += 1;
		}
		const partialJson = JSON.stringify(s.slice(0, sliceEnd));
		let cut = 0;
		let taken = 0;
		while (cut < partialJson.length && taken < remaining) {
			const c = partialJson.charCodeAt(cut);
			cut += c >= 0xd800 && c <= 0xdbff && cut + 1 < partialJson.length ? 2 : 1;
			taken += 1;
		}
		chunks.push(partialJson.slice(0, cut));
		emittedCp += taken;
		extraCodePoints += fullCpLen - taken;
	};

	const emitPrimitive = (val: unknown): void => {
		if (val === null || typeof val === "boolean") {
			pushAscii(String(val));
			return;
		}
		if (typeof val === "number") {
			pushAscii(Number.isFinite(val) ? String(val) : "null");
			return;
		}
		if (typeof val === "string") {
			pushJsonString(val);
			return;
		}
		pushAscii("null");
	};

	type Frame =
		| { kind: "value"; val: unknown; depth: number }
		| { kind: "array"; arr: readonly unknown[]; idx: number; depth: number }
		| { kind: "object"; entries: readonly [string, unknown][]; idx: number; depth: number };

	const stack: Frame[] = [{ kind: "value", val: value, depth: 0 }];
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (frame.kind === "value") {
			const { val, depth } = frame;
			if (val === null || typeof val !== "object") {
				emitPrimitive(val);
				continue;
			}
			if (Array.isArray(val)) {
				if (val.length === 0) {
					pushAscii("[]");
					continue;
				}
				if (depth >= maxDepth) {
					pushAscii('"[...]"');
					continue;
				}
				pushAscii("[\n");
				stack.push({ kind: "array", arr: val, idx: 0, depth });
				continue;
			}
			const entries = Object.entries(val as Record<string, unknown>).filter(
				([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol",
			);
			if (entries.length === 0) {
				pushAscii("{}");
				continue;
			}
			if (depth >= maxDepth) {
				pushAscii('"{...}"');
				continue;
			}
			pushAscii("{\n");
			stack.push({ kind: "object", entries, idx: 0, depth });
			continue;
		}

		if (frame.kind === "array") {
			const { arr, depth } = frame;
			let interrupted = false;
			while (frame.idx < arr.length) {
				const idx = frame.idx;
				frame.idx = idx + 1;
				if (idx > 0) pushAscii(",\n");
				pushIndent(depth + 1);
				const elem = arr[idx];
				if (elem !== null && typeof elem === "object") {
					stack.push(frame);
					stack.push({ kind: "value", val: elem, depth: depth + 1 });
					interrupted = true;
					break;
				}
				emitPrimitive(elem);
			}
			if (!interrupted) {
				pushAscii("\n");
				pushIndent(depth);
				pushAscii("]");
			}
			continue;
		}

		const { entries, depth } = frame;
		let interrupted = false;
		while (frame.idx < entries.length) {
			const idx = frame.idx;
			frame.idx = idx + 1;
			if (idx > 0) pushAscii(",\n");
			pushIndent(depth + 1);
			const [k, v] = entries[idx]!;
			pushJsonString(k);
			pushAscii(": ");
			if (v !== null && typeof v === "object") {
				stack.push(frame);
				stack.push({ kind: "value", val: v, depth: depth + 1 });
				interrupted = true;
				break;
			}
			emitPrimitive(v);
		}
		if (!interrupted) {
			pushAscii("\n");
			pushIndent(depth);
			pushAscii("}");
		}
	}
	return { text: chunks.join(""), extraCodePoints };
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

function attemptsOmittedMarker(omitted: number): string {
	return `… [truncated, ${omitted} attempt${omitted === 1 ? "" : "s"} omitted]`;
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
	if (list.items.length === 0 || measure() <= targetBytes) return;
	const savedItems = list.items;
	const savedOmitted = list.omitted_count;
	const savedMarker = list.omitted_marker;
	list.items = [];
	list.omitted_count = savedOmitted + savedItems.length;
	list.omitted_marker = itemsOmittedMarker(list.omitted_count);
	if (measure() > targetBytes) {
		return;
	}
	list.items = savedItems;
	list.omitted_count = savedOmitted;
	list.omitted_marker = savedMarker;
	let low = 0;
	let high = savedItems.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const dropped = savedItems.length - mid;
		list.items = savedItems.slice(0, mid);
		list.omitted_count = savedOmitted + dropped;
		list.omitted_marker = list.omitted_count > 0 ? itemsOmittedMarker(list.omitted_count) : savedMarker;
		if (measure() <= targetBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	const finalDropped = savedItems.length - low;
	list.items = savedItems.slice(0, low);
	list.omitted_count = savedOmitted + finalDropped;
	if (list.omitted_count > 0) {
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
	const curCp = Array.from(cur).length;
	const minChars = Math.min(curCp, 64);
	holder[key] = reboundOutputText(cur, 1);
	if (measure() > targetBytes) {
		return;
	}
	let low = minChars;
	let high = curCp;
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

function trimAttemptOptionalSections(
	att: Record<string, unknown>,
	targetBytes: number,
	measure: () => number,
): void {
	trimStringFieldForBudget(att, "outputs_text", targetBytes, measure);
	if (measure() <= targetBytes) return;

	for (const listKey of ["artifacts", "next_steps", "warnings", "verification", "causes"] as const) {
		const list = att[listKey] as BoundedList<unknown> | undefined;
		if (list && Array.isArray(list.items)) {
			trimBoundedListForBudget(list, targetBytes, measure);
			if (measure() <= targetBytes) return;
		}
	}

	const cmd = att.command as Record<string, unknown> | undefined;
	if (cmd && typeof cmd === "object") {
		for (const cmdKey of ["stderr_excerpt", "stdout_excerpt", "termination_error", "spawn_error"] as const) {
			trimStringFieldForBudget(cmd, cmdKey, targetBytes, measure);
			if (measure() <= targetBytes) return;
		}
	}
}

function trimAttemptBodyFields(
	att: Record<string, unknown>,
	targetBytes: number,
	measure: () => number,
	includeSummary: boolean,
): void {
	const keys = includeSummary
		? (["detail", "error_message", "disposition_reason", "summary"] as const)
		: (["detail", "error_message", "disposition_reason"] as const);
	for (const strKey of keys) {
		trimStringFieldForBudget(att, strKey, targetBytes, measure);
		if (measure() <= targetBytes) return;
	}
}

function buildBudgetFallbackAttempt(att: Record<string, unknown> | undefined): Record<string, unknown> {
	return {
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
}

/**
 * Bound the full `/output` response at `maxBytes` (default 64 KiB) without splitting surrogate pairs.
 *
 * Trim order across multiple attempts (stopping as soon as the serialized response fits):
 * 1. Oldest attempts' optional sections first (`i = attempts.length - 1` down to `1`: `outputs_text`,
 *    then `artifacts`/`next_steps`/`warnings`/`verification`/`causes`, then `command` excerpts/errors).
 * 2. Older attempts' bodies (`i = attempts.length - 1` down to `1`: `detail`, `error_message`,
 *    `disposition_reason`, `summary`).
 * 3. Drop entire oldest attempts (`attempts.pop()` down to `attempts[0]`), updating `omitted_attempts`
 *    and `omitted_marker` (`… [truncated, N attempts omitted]`).
 * 4. Newest attempt (`attempts[0]`) optional sections, then `detail`/`error_message`/`disposition_reason`
 *    (never trimming the newest attempt's `summary` or `status`).
 * 5. Hard budget stub fallback (`evidence: "unavailable"`) if even a single minimal attempt exceeds `maxBytes`.
 */
export function enforceOutputResponseBudget(body: Record<string, unknown>, maxBytes = OUTPUT_MAX_RESPONSE_BYTES): Record<string, unknown> {
	const measureBody = () => Buffer.byteLength(JSON.stringify(body), "utf8");
	if (measureBody() <= maxBytes) return body;

	const attempts = Array.isArray(body.attempts)
		? (body.attempts as Array<Record<string, unknown>>)
		: undefined;

	if (attempts && attempts.length > 0) {
		const attBytes = attempts.map(a => Buffer.byteLength(JSON.stringify(a), "utf8"));
		const measureEnvelope = () => {
			const saved = body.attempts;
			body.attempts = [];
			const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
			body.attempts = saved;
			return bytes;
		};
		let envelopeBytes = measureEnvelope();
		let sumAttBytes = attBytes.reduce((acc, b) => acc + b, 0);
		const totalBytes = () => envelopeBytes + sumAttBytes + Math.max(0, attempts.length - 1);

		const trimSingleAttempt = (idx: number, fn: (att: Record<string, unknown>, target: number, measureAtt: () => number) => void) => {
			const att = attempts[idx]!;
			const otherBytes = totalBytes() - attBytes[idx]!;
			const attTarget = maxBytes - otherBytes;
			fn(att, attTarget, () => Buffer.byteLength(JSON.stringify(att), "utf8"));
			const nextBytes = Buffer.byteLength(JSON.stringify(att), "utf8");
			sumAttBytes += nextBytes - attBytes[idx]!;
			attBytes[idx] = nextBytes;
		};

		// 1. Oldest attempts' optional sections first (leaving newest attempts[0] intact)
		for (let i = attempts.length - 1; i >= 1 && totalBytes() > maxBytes; i--) {
			trimSingleAttempt(i, trimAttemptOptionalSections);
		}
		// 2. Older attempts' bodies (leaving newest attempts[0] intact)
		for (let i = attempts.length - 1; i >= 1 && totalBytes() > maxBytes; i--) {
			trimSingleAttempt(i, (att, target, measureAtt) => trimAttemptBodyFields(att, target, measureAtt, true));
		}
		// 3. Drop entire oldest attempts with visible omitted_marker
		while (attempts.length > 1 && totalBytes() > maxBytes) {
			attempts.pop();
			const droppedBytes = attBytes.pop() ?? 0;
			sumAttBytes -= droppedBytes;
			const prevOmitted = typeof body.omitted_attempts === "number" ? body.omitted_attempts : 0;
			const nextOmitted = prevOmitted + 1;
			body.omitted_attempts = nextOmitted;
			body.omitted_marker = attemptsOmittedMarker(nextOmitted);
			envelopeBytes = measureEnvelope();
		}
		// 4. Newest attempt optional sections, then body (never summary or status)
		if (totalBytes() > maxBytes) {
			trimSingleAttempt(0, trimAttemptOptionalSections);
		}
		if (totalBytes() > maxBytes) {
			trimSingleAttempt(0, (att, target, measureAtt) => trimAttemptBodyFields(att, target, measureAtt, false));
		}

		if (measureBody() > maxBytes) {
			const fallbackAttempt = buildBudgetFallbackAttempt(attempts[0]);
			body.evidence = "unavailable";
			body.attempts = [fallbackAttempt];
			if (measureBody() > maxBytes) {
				fallbackAttempt.attempt_id = { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity unavailable." };
				fallbackAttempt.explanation = "Attempt output exceeded response budget.";
			}
		}
		return body;
	}

	const att = body.latest_attempt as Record<string, unknown> | undefined;
	if (att && typeof att === "object") {
		trimAttemptOptionalSections(att, maxBytes, measureBody);
		if (measureBody() <= maxBytes) return body;
		trimAttemptBodyFields(att, maxBytes, measureBody, true);
		if (measureBody() <= maxBytes) return body;
	}

	if (measureBody() > maxBytes) {
		const fallbackAttempt = buildBudgetFallbackAttempt(att);
		body.evidence = "unavailable";
		body.latest_attempt = fallbackAttempt;
		if (measureBody() > maxBytes) {
			fallbackAttempt.attempt_id = { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity unavailable." };
			fallbackAttempt.explanation = "Attempt output exceeded response budget.";
		}
	}
	return body;
}

function projectVerificationItem(
	raw: unknown,
	blockedPaths: readonly string[],
	artifactMatcher: ArtifactRedactionMatcher,
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
	let checkId = sanitizeOutputText(rawCheckId, rem, blockedPaths, artifactMatcher);
	let reason = typeof v.reason === "string" && v.reason
		? sanitizeOutputText(v.reason, rem, blockedPaths, artifactMatcher)
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
	artifactMatcher: ArtifactRedactionMatcher,
) {
	const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const type = sanitizeOutputText(typeof a.type === "string" && a.type ? a.type : "artifact", 128, blockedPaths);
	const action = typeof a.action === "string" && a.action
		? sanitizeOutputText(a.action, 128, blockedPaths)
		: undefined;
	const descBudget = Math.max(0, OUTPUT_LIST_ITEM_MAX_CHARS - cpLength(type) - (action ? cpLength(action) : 0));
	const description = typeof a.description === "string" && a.description && descBudget > 0
		? sanitizeOutputText(a.description, descBudget, blockedPaths, artifactMatcher)
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
		const artifactMatcher = compileArtifactRedactionMatcher(
			collectArtifactPathTokens(res.artifacts, projectCwd),
		);
		const summary = sanitizeOutputText(res.summary, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths, artifactMatcher);
		const rawDetail = typeof res.detail === "string" ? res.detail : "";
		const detail = sanitizeOutputText(rawDetail, OUTPUT_DETAIL_MAX_CHARS, blockedPaths, artifactMatcher);
		const verification = buildBoundedList(res.verification, OUTPUT_LIST_MAX_ITEMS, v =>
			projectVerificationItem(v, blockedPaths, artifactMatcher),
		);
		const warnings = buildBoundedList(res.warnings, OUTPUT_LIST_MAX_ITEMS, w =>
			sanitizeOutputText(typeof w === "string" ? w : "", OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths, artifactMatcher),
		);
		const nextSteps = buildBoundedList(res.next_steps, OUTPUT_LIST_MAX_ITEMS, s =>
			sanitizeOutputText(typeof s === "string" ? s : "", OUTPUT_LIST_ITEM_MAX_CHARS, blockedPaths, artifactMatcher),
		);
		const command = projectAttemptCommand(res.command_evidence, blockedPaths);
		let outputsText: string | undefined;
		if (res.outputs !== undefined) {
			try {
				const printed = boundedPrettyPrintJson(res.outputs);
				outputsText = sanitizeOutputText(
					printed.text,
					OUTPUT_STRUCTURED_MAX_CHARS,
					blockedPaths,
					artifactMatcher,
					printed.extraCodePoints,
				);
			} catch {
				outputsText = undefined;
			}
		}
		// Never project artifacts[].path or host provenance paths.
		const artifacts = buildBoundedList(res.artifacts, OUTPUT_LIST_MAX_ITEMS, a =>
			projectArtifactItem(a, blockedPaths, artifactMatcher),
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

export function findRetainedEndedAttempt(inspection: Inspection) {
	const hasUnreleased = inspection.attempts.some(a => !a.historical && !a.release_authorized);
	if (hasUnreleased) return undefined;
	return inspection.attempts.findLast(
		a => a.release_authorized && (a.state === "settled" || a.state === "cleared") && a.settlement && !a.uncertainty?.length,
	);
}

/**
 * Safely read the retained manifest for a settled or cleared run (including on Deleted factories)
 * using non-blocking regular-file checks without modifying or recovering state.
 */
export function loadRetainedRunForOutput(
	factoryId: string,
	nodeId: string,
	inspection: Inspection,
	indexRoot: string,
	inspectBoundVersion: (version: string) => Inspection,
): { kind: "none" } | { kind: "not_found" } | { kind: "unavailable"; explanation: string } | { kind: "ready"; release: ReleasedFactoryRun } {
	if (assertRunEvidenceConsistent(inspection, []).state !== "no_displayed_run") return { kind: "none" };
	const ended = findRetainedEndedAttempt(inspection);
	if (!ended) return { kind: "none" };
	let boundInsp: Inspection;
	try {
		boundInsp = inspectBoundVersion(ended.bound_version);
	} catch {
		return { kind: "unavailable", explanation: "Bound run definition could not be verified." };
	}
	const def = boundInsp.definition;
	if (!def) {
		return { kind: "unavailable", explanation: "Bound run definition could not be verified." };
	}
	if (!def.agents.some(entry => entry.node.node_id === nodeId)) {
		return { kind: "not_found" };
	}
	try {
		assertTaskId(ended.task_id);
		const expectedSessionDir = join(def.project_cwd, ".pi", "agent-sessions", ended.task_id);
		const localManifestFile = join(expectedSessionDir, "manifest.json");
		const indexFile = join(indexRoot, `${ended.task_id}.json`);
		const hasLocal = pathEntryExists(localManifestFile);
		if (hasLocal) {
			assertPathInsideDir(expectedSessionDir, localManifestFile, "run manifest.json");
			assertRegularFileIfExists(localManifestFile, "run manifest.json", MAX_EVIDENCE_FILE_BYTES);
		}
		if (pathEntryExists(indexFile)) {
			assertPathInsideDir(indexRoot, indexFile, "bootstrap index manifest");
			assertRegularFileIfExists(indexFile, "bootstrap index manifest", MAX_EVIDENCE_FILE_BYTES);
		}
		const manifestRead = hasLocal
			? readBoundedRegularJsonIfExists<unknown>(expectedSessionDir, localManifestFile, "run manifest.json", MAX_EVIDENCE_FILE_BYTES)
			: readBoundedRegularJsonIfExists<unknown>(indexRoot, indexFile, "bootstrap index manifest", MAX_EVIDENCE_FILE_BYTES);
		if (!manifestRead.exists) {
			return { kind: "unavailable", explanation: "Retained run manifest is missing." };
		}
		const manifest: BootstrapManifest = parseManifest(manifestRead.value, ended.task_id);
		const fm = manifest.factory_managed;
		if (
			!fm
			|| fm.factory_id !== factoryId
			|| fm.attempt_id !== ended.attempt_id
			|| fm.bound_version !== ended.bound_version
			|| fm.input_id !== ended.input_id
		) {
			return { kind: "unavailable", explanation: "Retained run metadata does not match the recorded attempt." };
		}
		if (manifest.session_dir_removed || manifest.session_dir !== expectedSessionDir || manifest.status !== "applied") {
			return { kind: "unavailable", explanation: "Retained run session evidence is unavailable." };
		}
		return {
			kind: "ready",
			release: {
				manifest,
				definition: def,
				attempt_id: ended.attempt_id,
				bound_version: ended.bound_version,
			},
		};
	} catch {
		return { kind: "unavailable", explanation: "Retained run evidence could not be verified." };
	}
}

export interface NodeOutputSnapshotOptions {
	retainedRelease?: ReleasedFactoryRun;
	retainedError?: string;
}

/** Project every attempt (newest first, up to 20) of one node of a factory's displayed or retained run. */
export function nodeOutputSnapshot(
	factoryId: string,
	nodeId: string,
	inspection: Inspection,
	releases: ReleasedFactoryRun[],
	blockedPaths: readonly string[] = [],
	options: NodeOutputSnapshotOptions = {},
): OutputSnapshotOutcome {
	const deletionFields = deletionMarkerFields(inspection, blockedPaths);
	const consistent = assertRunEvidenceConsistent(inspection, releases);
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

	let release: ReleasedFactoryRun | undefined;
	if (consistent.state === "released") {
		release = consistent.release;
	} else if (options.retainedError) {
		return {
			kind: "ok",
			body: {
				factory_id: factoryId,
				node_id: nodeId,
				...deletionFields,
				evidence: "unavailable",
				absence: "evidence unavailable" as TypedAbsence,
				explanation: options.retainedError,
			},
		};
	} else if (options.retainedRelease) {
		release = options.retainedRelease;
	} else {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	if (!release.definition.agents.some(entry => entry.node.node_id === nodeId)) {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	let resolved: ReturnType<typeof resolveRunObservations>;
	try {
		// Enforce the 1 MiB record limit only on the requested node so upstream observations stay aligned with /live (N5),
		// and defer per-attempt result/disposition/error checks on the requested node to independent per-attempt resolution.
		resolved = resolveRunObservations(factoryId, release, blockedPaths, {
			enforceSizeLimitNodeId: nodeId,
			skipLoopResultPrecheckNodeId: nodeId,
		});
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
	const launched = resolved.roster.get(nodeId);
	if (!obs || !launched) {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	const byInstance = new Map(resolved.manifest.pane_manifest.map(entry => [entry.instance_id, entry.node_id]));
	const resolvedAttempts = resolveNodeAttempts(
		resolved.manifest,
		launched,
		byInstance,
		resolved.runBlockedPaths,
		obs,
		OUTPUT_MAX_ATTEMPTS,
	);
	const projectedAttempts = resolvedAttempts.attempts.map(attObs =>
		projectAttemptFromObservation(attObs, resolved.runBlockedPaths, resolved.manifest.project_cwd),
	);
	const body: Record<string, unknown> = {
		factory_id: factoryId,
		node_id: nodeId,
		run_id: resolved.manifest.task_id,
		bound_version: resolved.bound_version,
		...deletionFields,
		evidence: projectedAttempts[0]?.evidence ?? "unavailable",
		attempts: projectedAttempts,
		total_attempts: resolvedAttempts.totalAttempts,
		omitted_attempts: resolvedAttempts.omittedAttempts,
		...(resolvedAttempts.omittedAttempts > 0
			? { omitted_marker: attemptsOmittedMarker(resolvedAttempts.omittedAttempts) }
			: {}),
	};
	return {
		kind: "ok",
		body: enforceOutputResponseBudget(body),
	};
}
