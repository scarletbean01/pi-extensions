import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { FactoryDeletionInfo } from "../operations.ts";

const CONTROL_AND_FORMAT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u034F\u115F\u1160\u180B-\u180D\u2800\u3164\uFE00-\uFE0D\uFFA0\u2028\u2029\u{E0100}-\u{E01EF}\p{Cf}]+/gu;
const VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F]+/g;
const GENERIC_PATH_RE = /(^|[^A-Za-z0-9._~/-])((?:file:\/\/[^\s"'<>()\[\]{}`*,;|]+|\/(?:[^\s"'<>()\[\]{}`*,;|/]+\/)+[^\s"'<>()\[\]{}`*,;|]*|~[A-Za-z0-9._-]*[\\/][^\s"'<>()\[\]{}`*,;|]+|[A-Za-z]:[\\/][^\s"'<>()\[\]{}`*,;|]+))/g;
const SPOOFED_TRUNCATION_MARKER_RE = /(?:…\s*)?\[truncated,\s*[0-9\uFF10-\uFF19]+(?:,[0-9\uFF10-\uFF19]+)*\s+characters?\s+omitted\]/gi;
const TRAILING_SENTENCE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const PRE_BOUND_MULTIPLIER = 4;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTrailingSentencePunctuation(token: string): { core: string; trailing: string } {
	let splitAt = token.length;
	while (splitAt > 0 && TRAILING_SENTENCE_PUNCTUATION.has(token[splitAt - 1]!)) {
		splitAt -= 1;
	}
	if (splitAt === 0 || splitAt === token.length) {
		return { core: token, trailing: "" };
	}
	return { core: token.slice(0, splitAt), trailing: token.slice(splitAt) };
}

function preBoundCodePoints(wellFormed: string, maxCodePoints: number): { bounded: string; droppedCodePoints: number } {
	if (wellFormed.length <= maxCodePoints) {
		return { bounded: wellFormed, droppedCodePoints: 0 };
	}
	const len = wellFormed.length;
	let cpCount = 0;
	let i = 0;
	while (i < len && cpCount < maxCodePoints) {
		const code = wellFormed.charCodeAt(i);
		i += code >= 0xd800 && code <= 0xdbff && i + 1 < len ? 2 : 1;
		cpCount += 1;
	}
	if (i >= len) {
		return { bounded: wellFormed, droppedCodePoints: 0 };
	}
	let droppedCodePoints = 0;
	for (let j = i; j < len; ) {
		const code = wellFormed.charCodeAt(j);
		j += code >= 0xd800 && code <= 0xdbff && j + 1 < len ? 2 : 1;
		droppedCodePoints += 1;
	}
	return { bounded: wellFormed.slice(0, i), droppedCodePoints };
}

function scrubBlockedAndGenericPaths(text: string, blockedPaths: readonly string[]): string {
	let cleaned = text;
	const uniquePaths = [...new Set(
		blockedPaths
			.filter(p => typeof p === "string" && p.length > 1)
			.flatMap(p => [p, resolve(p)])
			.filter(p => p !== "/" && p !== "/tmp" && p !== tmpdir()),
	)].sort((a, b) => b.length - a.length);
	for (const blocked of uniquePaths) {
		if (!cleaned.includes(blocked)) continue;
		const re = new RegExp(`${escapeRegExp(blocked)}[^\\s"'<>()\\[\\]{}\`*,;|]*`, "g");
		cleaned = cleaned.replace(re, match => {
			const { trailing } = splitTrailingSentencePunctuation(match);
			return `[redacted-path]${trailing}`;
		});
	}
	return cleaned.replace(GENERIC_PATH_RE, (_full, lead: string, token: string) => {
		const { trailing } = splitTrailingSentencePunctuation(token);
		return `${lead}[redacted-path]${trailing}`;
	});
}

function truncateWithOmissionMarker(codePoints: string[], maxChars: number, extraOmitted = 0): string {
	if (maxChars <= 0) return "";
	const total = codePoints.length + extraOmitted;
	if (extraOmitted === 0 && codePoints.length <= maxChars) return codePoints.join("");
	let kept = Math.min(codePoints.length, Math.max(0, maxChars - 40));
	for (let i = 0; i < 4; i++) {
		const omitted = total - kept;
		const marker = `… [truncated, ${omitted} character${omitted === 1 ? "" : "s"} omitted]`;
		const markerLen = Array.from(marker).length;
		if (markerLen >= maxChars) {
			return maxChars === 1 ? "…" : `${codePoints.slice(0, maxChars - 1).join("")}…`;
		}
		const nextKept = Math.min(codePoints.length, maxChars - markerLen);
		if (nextKept === kept) {
			return `${codePoints.slice(0, kept).join("")}${marker}`;
		}
		kept = nextKept;
	}
	const omitted = total - kept;
	const marker = `… [truncated, ${omitted} character${omitted === 1 ? "" : "s"} omitted]`;
	return `${codePoints.slice(0, kept).join("")}${marker}`;
}

/**
 * Normalize, path-scrub, and code-point length-bound operator-facing text so store/checkout/home paths
 * and unsafe control/bidi characters never leak. Note: genuinely path-like question text (tokens
 * starting with `/`, `~`, `file://`, or a drive letter) is conservatively redacted to `[redacted-path]`.
 */
export function sanitizeOperatorText(value: string, maxChars: number, blockedPaths: readonly string[] = []): string {
	if (maxChars <= 0) return "";
	const { bounded, droppedCodePoints } = preBoundCodePoints(value.trimStart().toWellFormed(), maxChars * PRE_BOUND_MULTIPLIER);
	const normalized = bounded
		.replace(VARIATION_SELECTORS_RE, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(CONTROL_AND_FORMAT_RE, " [ctrl] ")
		.replace(/\s+/g, " ")
		.trim();
	const cleaned = scrubBlockedAndGenericPaths(normalized, blockedPaths)
		.replace(SPOOFED_TRUNCATION_MARKER_RE, "[truncated-marker]");
	const codePoints = Array.from(cleaned);
	if (codePoints.length > maxChars || droppedCodePoints > 0) {
		return maxChars === 1 ? "…" : `${codePoints.slice(0, maxChars - 1).join("")}…`;
	}
	return cleaned;
}

/**
 * Scrub control/bidi/zero-width characters and blocked or generic absolute paths while preserving line breaks,
 * then bound by Unicode code points with an explicit omission-count marker without splitting surrogate pairs.
 */
export function sanitizeOutputText(value: string, maxChars: number, blockedPaths: readonly string[] = []): string {
	if (maxChars <= 0) return "";
	const { bounded, droppedCodePoints } = preBoundCodePoints(value.toWellFormed(), maxChars * PRE_BOUND_MULTIPLIER);
	const normalized = bounded
		.replace(VARIATION_SELECTORS_RE, "")
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_AND_FORMAT_RE, (match, offset: number, whole: string) => {
			const before = offset > 0 ? whole[offset - 1]! : "";
			const after = offset + match.length < whole.length ? whole[offset + match.length]! : "";
			const padLeft = before !== "" && !/\s/.test(before) ? " " : "";
			const padRight = after !== "" && !/\s/.test(after) ? " " : "";
			return `${padLeft}[ctrl]${padRight}`;
		});
	const cleaned = scrubBlockedAndGenericPaths(normalized, blockedPaths)
		.replace(SPOOFED_TRUNCATION_MARKER_RE, "[truncated-marker]");
	return truncateWithOmissionMarker(Array.from(cleaned), maxChars, droppedCodePoints);
}

export interface ViewerDeletionSummary {
	deleted_at: string;
	deleted_by: {
		incarnation_id: string;
		pi_session_id?: string;
	};
}

/** Project deletion metadata for viewer snapshots without exposing session file paths or PIDs. */
export function projectViewerDeletion(
	deletion: FactoryDeletionInfo | undefined,
	blockedPaths: readonly string[] = [],
): ViewerDeletionSummary | undefined {
	if (!deletion) return undefined;
	const rawSessionId = deletion.deleted_by?.pi_session_id;
	const cleanSessionId = typeof rawSessionId === "string" && rawSessionId.trim()
		? sanitizeOperatorText(rawSessionId, 128, blockedPaths)
		: undefined;
	return {
		deleted_at: deletion.deleted_at,
		deleted_by: {
			incarnation_id: sanitizeOperatorText(deletion.deleted_by.incarnation_id, 128, blockedPaths),
			...(cleanSessionId ? { pi_session_id: cleanSessionId } : {}),
		},
	};
}

/** Build optional deletion marker fields for viewer snapshots when a factory is deleted. */
export function deletionMarkerFields(
	source: { deleted?: boolean; deletion?: FactoryDeletionInfo } | undefined,
	blockedPaths: readonly string[] = [],
): { deleted: true; deletion?: ViewerDeletionSummary } | Record<string, never> {
	if (!source?.deleted) return {};
	const deletion = projectViewerDeletion(source.deletion, blockedPaths);
	return {
		deleted: true,
		...(deletion ? { deletion } : {}),
	};
}
