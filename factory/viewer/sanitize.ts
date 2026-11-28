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
const INCOMPLETE_TRAILING_PATH_RE = /(?:^|[^A-Za-z0-9._~/-])(\/[^/\s"'<>()\[\]{}`*]*|~[A-Za-z0-9._-]*[\\/]?|file:\/{0,2}|[A-Za-z]:[\\/]?)$/;
const MAX_ARTIFACT_TOKEN_SOURCES = 20;
const MAX_ARTIFACT_TOKENS = 512;
const MAX_ARTIFACT_TOKEN_CHARS = 256 * 1024;
const HAS_SEP_RE = /[\\/]/;
const DOT_EXT_RE = /^\.[A-Za-z][A-Za-z0-9_-]{0,9}$/;
const ARTIFACT_DELIM_CHAR_RE = /[\s"'<>()\[\]{}`*,;|!?=]/;
const ARTIFACT_SUFFIX_SPLIT_CHARS = [":", "#", "@", "~", "+", "&", "%"] as const;
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;

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

export interface ArtifactRedactionMatcher {
	exact: ReadonlySet<string>;
	lower: ReadonlySet<string>;
}

const EMPTY_ARTIFACT_MATCHER: ArtifactRedactionMatcher = {
	exact: new Set(),
	lower: new Set(),
};

function hasArtifactDelim(token: string): boolean {
	if (ARTIFACT_DELIM_CHAR_RE.test(token)) return true;
	for (let i = 0; i < token.length; i++) {
		if (token.charCodeAt(i) <= 32) return true;
	}
	return false;
}

function isRedactableArtifactForm(token: string): boolean {
	if (token.length < 2 || token === "." || token === ".." || token === "./" || token === ".\\") return false;
	if (token === "[ctrl]" || token === "[redacted-path]" || token === "[truncated-marker]") return false;
	if (hasArtifactDelim(token)) return false;
	if (HAS_SEP_RE.test(token)) return true;
	const lastDot = token.lastIndexOf(".");
	return lastDot >= 2 && DOT_EXT_RE.test(token.slice(lastDot));
}

/**
 * Collect normalized forms (literal, trailing-separator-stripped, `./`/`../`-stripped, separator-swapped,
 * JSON-escaped, and project-joined absolute) from the projected artifacts (capped at 20 artifacts,
 * 512 tokens, and 256 KiB), excluding delimiter-containing forms and bare single words without a separator
 * or 1–10-char letter-led dot-extension on a 2+-char stem.
 */
export function collectArtifactPathTokens(
	artifacts: ReadonlyArray<{ path?: unknown }> | undefined,
	projectCwd?: string,
): string[] {
	if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
	const tokens = new Set<string>();
	let totalChars = 0;
	const pushToken = (candidate: string) => {
		if (tokens.size >= MAX_ARTIFACT_TOKENS) return;
		if (tokens.has(candidate)) return;
		if (totalChars + candidate.length > MAX_ARTIFACT_TOKEN_CHARS) return;
		tokens.add(candidate);
		totalChars += candidate.length;
	};
	const addForm = (candidate: string) => {
		const t = candidate.trim();
		if (!isRedactableArtifactForm(t)) return;
		pushToken(t);
		const jsonEscaped = t.replace(/\\/g, "\\\\");
		if (jsonEscaped !== t) pushToken(jsonEscaped);
	};
	const addSeparatorForms = (pathStr: string, includeTrailing: boolean) => {
		addForm(pathStr);
		const fwd = pathStr.replace(/\\/g, "/");
		const bwd = pathStr.replace(/\//g, "\\");
		addForm(fwd);
		addForm(bwd);
		if (includeTrailing && !pathStr.endsWith("/") && !pathStr.endsWith("\\")) {
			addForm(`${fwd}/`);
			addForm(`${bwd}\\`);
		}
	};

	const projected = artifacts.slice(0, MAX_ARTIFACT_TOKEN_SOURCES);
	for (const art of projected) {
		if (tokens.size >= MAX_ARTIFACT_TOKENS) break;
		if (!art || typeof art !== "object" || typeof art.path !== "string") continue;
		const raw = art.path.trim();
		if (!raw) continue;
		const hadTrailingSep = /[\\/]+$/.test(raw);
		const normalizedRaw = raw.replace(/[\\/]+$/, "");
		if (!normalizedRaw) continue;
		addSeparatorForms(normalizedRaw, hadTrailingSep);
		const noPrefix = normalizedRaw.replace(/^(?:\.\.?[\\/])+/, "");
		if (noPrefix) {
			addSeparatorForms(noPrefix, hadTrailingSep);
			const forward = noPrefix.replace(/\\/g, "/");
			const backward = noPrefix.replace(/\//g, "\\");
			if (!isAbsolute(noPrefix) && !DRIVE_PREFIX_RE.test(noPrefix)) {
				addForm(`./${forward}`);
				addForm(`.\\${backward}`);
				if (hadTrailingSep) {
					addForm(`./${forward}/`);
					addForm(`.\\${backward}\\`);
				}
				if (projectCwd && !normalizedRaw.startsWith("..")) {
					const abs = resolve(projectCwd, forward);
					addSeparatorForms(abs, false);
				}
			} else if (projectCwd) {
				const rel = relative(resolve(projectCwd), resolve(normalizedRaw));
				if (rel && !rel.startsWith("..") && !isAbsolute(rel) && rel !== ".") {
					const relFwd = rel.replace(/\\/g, "/");
					const relBwd = rel.replace(/\//g, "\\");
					addSeparatorForms(rel, hadTrailingSep);
					addForm(`./${relFwd}`);
					addForm(`.\\${relBwd}`);
					if (hadTrailingSep) {
						addForm(`./${relFwd}/`);
						addForm(`.\\${relBwd}\\`);
					}
				}
			}
		}
	}
	return [...tokens];
}

function isArtifactMatcher(value: readonly string[] | ArtifactRedactionMatcher): value is ArtifactRedactionMatcher {
	return !Array.isArray(value) && typeof value === "object" && value !== null && "exact" in value;
}

/** Build a lookup structure once per request for linear-time whole-token artifact redaction. */
export function compileArtifactRedactionMatcher(tokens: readonly string[] | ArtifactRedactionMatcher): ArtifactRedactionMatcher {
	if (isArtifactMatcher(tokens)) return tokens;
	if (!tokens.length) return EMPTY_ARTIFACT_MATCHER;
	const exact = new Set<string>();
	const lower = new Set<string>();
	for (const rawToken of tokens) {
		const t = typeof rawToken === "string" ? rawToken.trim() : "";
		if (!isRedactableArtifactForm(t)) continue;
		exact.add(t);
		if (t.includes("\\") || DRIVE_PREFIX_RE.test(t)) {
			lower.add(t.toLowerCase());
		}
	}
	return { exact, lower };
}

function isArtifactDelimChar(code: number, ch: string): boolean {
	if (code <= 32) return true; // whitespace / control
	return ARTIFACT_DELIM_CHAR_RE.test(ch);
}

function matchesCandidatePrefix(
	cand: string,
	splitLen: number,
	matcher: ArtifactRedactionMatcher,
	lowerCand: string | undefined,
): boolean {
	const prefix = splitLen === cand.length ? cand : cand.slice(0, splitLen);
	if (matcher.exact.has(prefix)) return true;
	if (lowerCand !== undefined) {
		const lowerPrefix = lowerCand.length === cand.length
			? (splitLen === cand.length ? lowerCand : lowerCand.slice(0, splitLen))
			: prefix.toLowerCase();
		return matcher.lower.has(lowerPrefix);
	}
	return false;
}

function findMatchedPrefixEnd(cand: string, matcher: ArtifactRedactionMatcher): number {
	const hasLower = matcher.lower.size > 0 && (cand.includes("\\") || DRIVE_PREFIX_RE.test(cand));
	const lowerCand = hasLower ? cand.toLowerCase() : undefined;

	if (matchesCandidatePrefix(cand, cand.length, matcher, lowerCand)) {
		return cand.length;
	}

	const splitLengths: number[] = [];
	let coreEnd = cand.length;
	while (coreEnd > 0 && (cand[coreEnd - 1] === "." || cand[coreEnd - 1] === ":" || cand[coreEnd - 1] === "/")) {
		coreEnd -= 1;
	}
	if (coreEnd > 0 && coreEnd < cand.length) {
		splitLengths.push(coreEnd);
	}

	for (const ch of ARTIFACT_SUFFIX_SPLIT_CHARS) {
		const first = cand.indexOf(ch);
		if (first > 0) {
			splitLengths.push(first);
			if (first > 1 && cand[first - 1] === "/") {
				splitLengths.push(first - 1);
			}
		}
		if (ch === ":" && first === 1 && DRIVE_PREFIX_RE.test(cand)) {
			const afterDrive = cand.indexOf(":", 2);
			if (afterDrive > 0) {
				splitLengths.push(afterDrive);
				if (afterDrive > 1 && cand[afterDrive - 1] === "/") {
					splitLengths.push(afterDrive - 1);
				}
			}
		}
		const last = cand.lastIndexOf(ch);
		if (last > 0 && last !== first) {
			splitLengths.push(last);
			if (last > 1 && cand[last - 1] === "/") {
				splitLengths.push(last - 1);
			}
		}
	}

	const lastDot = cand.lastIndexOf(".");
	if (lastDot > 0 && lastDot + 1 < cand.length) {
		const nextCode = cand.charCodeAt(lastDot + 1);
		if (nextCode >= 48 && nextCode <= 57) {
			splitLengths.push(lastDot);
		}
	}

	if (splitLengths.length === 0) return -1;
	splitLengths.sort((a, b) => b - a);
	let prev = -1;
	for (const splitLen of splitLengths) {
		if (splitLen === prev) continue;
		prev = splitLen;
		if (matchesCandidatePrefix(cand, splitLen, matcher, lowerCand)) {
			return splitLen;
		}
	}
	return -1;
}

function scrubExtraRedactedTokens(text: string, matcher: ArtifactRedactionMatcher): string {
	if (!text || (matcher.exact.size === 0 && matcher.lower.size === 0)) return text;
	const len = text.length;
	const out: string[] = [];
	let lastEmit = 0;
	let i = 0;

	while (i < len) {
		const ch = text[i]!;
		if (ch === "[") {
			if (text.startsWith("[redacted-path]", i)) {
				i += 15;
				continue;
			}
			if (text.startsWith("[ctrl]", i)) {
				i += 6;
				continue;
			}
			if (text.startsWith("[truncated-marker]", i)) {
				i += 18;
				continue;
			}
		}
		if (isArtifactDelimChar(text.charCodeAt(i), ch)) {
			i += 1;
			continue;
		}
		const start = i;
		let end = i + 1;
		while (end < len && !isArtifactDelimChar(text.charCodeAt(end), text[end]!)) {
			end += 1;
		}
		let delimAdvanceAt = end;
		if (end < len && text.charCodeAt(end) === 34 /* '"' */) {
			let bs = 0;
			while (end - 1 - bs >= start && text.charCodeAt(end - 1 - bs) === 92 /* '\\' */) {
				bs += 1;
			}
			if (bs % 2 === 1) {
				end -= 1;
				delimAdvanceAt = end + 2;
			}
		}
		if (end === start) {
			i = delimAdvanceAt;
			continue;
		}
		const tok = text.slice(start, end);

		let matchPrefixOffset = 0;
		let matchedLen = findMatchedPrefixEnd(tok, matcher);
		if (matchedLen < 0 && tok.length > 5 && tok.slice(0, 5).toLowerCase() === "file:") {
			const offset = tok.startsWith("//", 5) ? 7 : 5;
			if (offset < tok.length) {
				const subLen = findMatchedPrefixEnd(tok.slice(offset), matcher);
				if (subLen > 0) {
					matchPrefixOffset = offset;
					matchedLen = subLen;
				}
			}
		}
		if (matchedLen > 0) {
			out.push(text.slice(lastEmit, start + matchPrefixOffset), "[redacted-path]");
			lastEmit = start + matchPrefixOffset + matchedLen;
		}

		i = delimAdvanceAt;
	}
	if (lastEmit === 0) return text;
	out.push(text.slice(lastEmit));
	return out.join("");
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
	extraRedactedTokens: readonly string[] | ArtifactRedactionMatcher = [],
): string {
	if (maxChars <= 0) return "";
	const stripped = value.toWellFormed().replace(VARIATION_SELECTORS_RE, "");
	const { bounded, droppedCodePoints } = preBoundCodePoints(stripped.trimStart(), maxChars * PRE_BOUND_MULTIPLIER);
	const normalized = bounded
		.replace(/[\r\n\t]+/g, " ")
		.replace(CONTROL_AND_FORMAT_RE, " [ctrl] ")
		.replace(/\s+/g, " ")
		.trim();
	const pathScrubbed = scrubBlockedAndGenericPaths(normalized, blockedPaths)
		.replace(SPOOFED_TRUNCATION_MARKER_RE, "[truncated-marker]");
	const cleaned = scrubExtraRedactedTokens(pathScrubbed, compileArtifactRedactionMatcher(extraRedactedTokens));
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
	extraRedactedTokens: readonly string[] | ArtifactRedactionMatcher = [],
	extraDroppedCodePoints = 0,
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
	const pathScrubbed = scrubBlockedAndGenericPaths(normalized, blockedPaths)
		.replace(SPOOFED_TRUNCATION_MARKER_RE, "[truncated-marker]");
	const cleaned = scrubExtraRedactedTokens(pathScrubbed, compileArtifactRedactionMatcher(extraRedactedTokens));
	const extra = Number.isFinite(extraDroppedCodePoints) && extraDroppedCodePoints > 0 ? Math.floor(extraDroppedCodePoints) : 0;
	return truncateWithOmissionMarker(Array.from(cleaned), maxChars, droppedCodePoints + extra);
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
