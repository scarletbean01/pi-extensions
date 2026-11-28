import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { FactoryDeletionInfo } from "../operations.ts";

const CONTROL_AND_FORMAT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u034F\u115F\u1160\u180B-\u180D\u2800\u3164\uFE00-\uFE0D\uFFA0\u2028\u2029\u{E0100}-\u{E01EF}\p{Cf}]+/gu;
const VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F]+/g;
const PATH_DELIM_LOOKAHEAD = String.raw`(?!$|[\s"'<>()\[\]{}\`*,;|\/~]|[A-Za-z]:[\\/]|file:\/\/)`;
const PATH_BODY_CHAR = `(?:[^\\s"'<>()\\[\\]{}\`*,;|]|[,;|]${PATH_DELIM_LOOKAHEAD})`;
const PATH_BODY_NO_SLASH_CHAR = `(?:[^\\s"'<>()\\[\\]{}\`*,;|/]|[,;|]${PATH_DELIM_LOOKAHEAD})`;
const GENERIC_PATH_RE = new RegExp(
	`(^|[^A-Za-z0-9._~/-])((?:file:\\/\\/${PATH_BODY_CHAR}+|\\/(?:${PATH_BODY_NO_SLASH_CHAR}+\\/)+${PATH_BODY_CHAR}*|~[A-Za-z0-9._-]*[\\\\/]${PATH_BODY_CHAR}+|[A-Za-z]:[\\\\/]${PATH_BODY_CHAR}+))`,
	"g",
);
const SPOOFED_TRUNCATION_MARKER_RE = /(?:…\s*)?\[truncated,\s*[0-9\uFF10-\uFF19]+(?:,[0-9\uFF10-\uFF19]+)*\s+characters?\s+omitted\]/gi;
const TRAILING_SENTENCE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const PRE_BOUND_MULTIPLIER = 4;
const PRE_BOUND_TRIM_LOOKBACK = 4096;
const PRE_BOUND_DELIM_RE = /[\s"'<>()\[\]{}`*,;|]/;
const INCOMPLETE_TRAILING_PATH_RE = /(?:^|[^A-Za-z0-9._~/-])(\/[^/]*|~[A-Za-z0-9._-]*[\\/]?|file:\/{0,2}|[A-Za-z]:[\\/]?)$/;

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

function countCodePoints(text: string): number {
	let count = 0;
	for (let j = 0, len = text.length; j < len; ) {
		const code = text.charCodeAt(j);
		j += code >= 0xd800 && code <= 0xdbff && j + 1 < len ? 2 : 1;
		count += 1;
	}
	return count;
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
	let cut = i;
	if (!PRE_BOUND_DELIM_RE.test(wellFormed[i]!)) {
		const floor = Math.max(Math.ceil(i / 2), i - PRE_BOUND_TRIM_LOOKBACK);
		let foundDelimiter = false;
		for (let k = i - 1; k >= floor; k--) {
			if (PRE_BOUND_DELIM_RE.test(wellFormed[k]!)) {
				cut = k + 1;
				foundDelimiter = true;
				break;
			}
		}
		if (!foundDelimiter) {
			cut = floor;
			if (cut > 0) {
				const code = wellFormed.charCodeAt(cut);
				const prev = wellFormed.charCodeAt(cut - 1);
				if (code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
					cut -= 1;
				}
			}
		}
	}
	if (cut > 0) {
		const tail = wellFormed.slice(Math.max(0, cut - 512), cut);
		const incomplete = INCOMPLETE_TRAILING_PATH_RE.exec(tail);
		if (incomplete && incomplete[1]) {
			cut -= incomplete[1].length;
		}
	}
	const droppedCodePoints = countCodePoints(wellFormed.slice(cut));
	return { bounded: wellFormed.slice(0, cut), droppedCodePoints };
}

/**
 * Collect normalized forms (literal, no `./`, separator-swapped, JSON-escaped, and project-joined absolute)
 * of recorded artifact paths so relative artifact paths are redacted alongside absolute paths.
 */
export function collectArtifactPathTokens(
	artifacts: ReadonlyArray<{ path?: unknown }> | undefined,
	projectCwd?: string,
): string[] {
	if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
	const tokens = new Set<string>();
	const addForm = (candidate: string) => {
		const t = candidate.trim();
		if (t.length < 2 || t === "." || t === ".." || t === "./" || t === ".\\") return;
		tokens.add(t);
		const jsonEscaped = t.replace(/\\/g, "\\\\");
		if (jsonEscaped !== t) tokens.add(jsonEscaped);
	};
	for (const art of artifacts) {
		if (!art || typeof art !== "object" || typeof art.path !== "string") continue;
		const raw = art.path.trim();
		if (!raw) continue;
		addForm(raw);
		addForm(raw.replace(/\\/g, "/"));
		addForm(raw.replace(/\//g, "\\"));
		const noDot = raw.replace(/^(?:\.[\\/])+/, "");
		if (noDot) {
			addForm(noDot);
			const forward = noDot.replace(/\\/g, "/");
			const backward = noDot.replace(/\//g, "\\");
			addForm(forward);
			addForm(backward);
			if (!isAbsolute(noDot) && !/^[A-Za-z]:[\\/]/.test(noDot)) {
				addForm(`./${forward}`);
				addForm(`.\\${backward}`);
				if (projectCwd) {
					const abs = resolve(projectCwd, forward);
					addForm(abs);
					addForm(abs.replace(/\\/g, "/"));
					addForm(abs.replace(/\//g, "\\"));
				}
			} else if (projectCwd) {
				const rel = relative(resolve(projectCwd), resolve(raw));
				if (rel && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".") {
					const relFwd = rel.replace(/\\/g, "/");
					const relBwd = rel.replace(/\//g, "\\");
					addForm(relFwd);
					addForm(relBwd);
					addForm(`./${relFwd}`);
					addForm(`.\\${relBwd}`);
				}
			}
		}
	}
	return [...tokens].sort((a, b) => b.length - a.length);
}

function scrubExtraRedactedTokens(text: string, tokens: readonly string[]): string {
	if (!tokens.length || !text) return text;
	let cleaned = text;
	for (const token of tokens) {
		if (!cleaned.includes(token)) continue;
		const leftBoundary = /^[A-Za-z0-9_]/.test(token) ? "(?<![A-Za-z0-9_])" : "";
		const rightBoundary = /[A-Za-z0-9_]$/.test(token) ? "(?![A-Za-z0-9_])" : "";
		cleaned = cleaned.replace(new RegExp(`${leftBoundary}${escapeRegExp(token)}${rightBoundary}`, "g"), "[redacted-path]");
	}
	return cleaned;
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
		const re = new RegExp(`${escapeRegExp(blocked)}${PATH_BODY_CHAR}*`, "g");
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

const TRAILING_TRUNCATION_MARKER_RE = /… \[truncated, (\d+) characters? omitted\]$/;

/** Re-bound already-scrubbed text to `maxChars` Unicode code points, accumulating any existing omission count. */
export function reboundOutputText(scrubbed: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	let base = scrubbed;
	let priorOmitted = 0;
	const match = TRAILING_TRUNCATION_MARKER_RE.exec(scrubbed);
	if (match) {
		priorOmitted = Number(match[1]);
		base = scrubbed.slice(0, match.index);
	}
	const codePoints = Array.from(base);
	if (priorOmitted === 0 && codePoints.length <= maxChars) return scrubbed;
	return truncateWithOmissionMarker(codePoints, maxChars, priorOmitted);
}

/**
 * Normalize, path-scrub, and code-point length-bound operator-facing text so store/checkout/home paths
 * and unsafe control/bidi characters never leak. Note: genuinely path-like question text (tokens
 * starting with `/`, `~`, `file://`, or a drive letter) is conservatively redacted to `[redacted-path]`.
 */
export function sanitizeOperatorText(
	value: string,
	maxChars: number,
	blockedPaths: readonly string[] = [],
	extraRedactedTokens: readonly string[] = [],
): string {
	if (maxChars <= 0) return "";
	const stripped = value.toWellFormed().replace(VARIATION_SELECTORS_RE, "");
	const { bounded, droppedCodePoints } = preBoundCodePoints(stripped.trimStart(), maxChars * PRE_BOUND_MULTIPLIER);
	const normalized = bounded
		.replace(/[\r\n\t]+/g, " ")
		.replace(CONTROL_AND_FORMAT_RE, " [ctrl] ")
		.replace(/\s+/g, " ")
		.trim();
	const preScrubbed = scrubExtraRedactedTokens(normalized, extraRedactedTokens);
	const cleaned = scrubBlockedAndGenericPaths(preScrubbed, blockedPaths)
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
export function sanitizeOutputText(
	value: string,
	maxChars: number,
	blockedPaths: readonly string[] = [],
	extraRedactedTokens: readonly string[] = [],
): string {
	if (maxChars <= 0) return "";
	const stripped = value.toWellFormed().replace(VARIATION_SELECTORS_RE, "");
	const { bounded, droppedCodePoints } = preBoundCodePoints(stripped, maxChars * PRE_BOUND_MULTIPLIER);
	const normalized = bounded
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_AND_FORMAT_RE, (match, offset: number, whole: string) => {
			const before = offset > 0 ? whole[offset - 1]! : "";
			const after = offset + match.length < whole.length ? whole[offset + match.length]! : "";
			const padLeft = before !== "" && !/\s/.test(before) ? " " : "";
			const padRight = after !== "" && !/\s/.test(after) ? " " : "";
			return `${padLeft}[ctrl]${padRight}`;
		});
	const preScrubbed = scrubExtraRedactedTokens(normalized, extraRedactedTokens);
	const cleaned = scrubBlockedAndGenericPaths(preScrubbed, blockedPaths)
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
