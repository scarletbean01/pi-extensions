import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { FactoryDeletionInfo } from "../operations.ts";

const CONTROL_AND_FORMAT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\p{Cf}]+/gu;
const GENERIC_PATH_RE = /(^|[\s"'(\[{:=])((?:file:\/\/[^\s"'<>()\[\]{}]+|\/(?:[^\s"'<>()\[\]{}/]+\/)+[^\s"'<>()\[\]{}]*|~[A-Za-z0-9._-]*[\\/][^\s"'<>()\[\]{}]+|[A-Za-z]:[\\/][^\s"'<>()\[\]{}]+))/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTrailingSentencePunctuation(token: string): { core: string; trailing: string } {
	const match = /^(.*?)([.,;:!?]+)$/.exec(token);
	if (!match || !match[1]) return { core: token, trailing: "" };
	return { core: match[1], trailing: match[2] };
}

/**
 * Normalize, path-scrub, and code-point length-bound operator-facing text so store/checkout/home paths
 * and unsafe control/bidi characters never leak. Note: genuinely path-like question text (tokens
 * starting with `/`, `~`, `file://`, or a drive letter) is conservatively redacted to `[redacted-path]`.
 */
export function sanitizeOperatorText(value: string, maxChars: number, blockedPaths: readonly string[] = []): string {
	let cleaned = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(CONTROL_AND_FORMAT_RE, " [ctrl] ")
		.replace(/\s+/g, " ")
		.trim();
	const uniquePaths = [...new Set(
		blockedPaths
			.filter(p => typeof p === "string" && p.length > 1)
			.flatMap(p => [p, resolve(p)])
			.filter(p => p !== "/" && p !== "/tmp" && p !== tmpdir()),
	)].sort((a, b) => b.length - a.length);
	for (const blocked of uniquePaths) {
		if (!cleaned.includes(blocked)) continue;
		const re = new RegExp(`${escapeRegExp(blocked)}[^\\s"'<>()\\[\\]{}]*`, "g");
		cleaned = cleaned.replace(re, match => {
			const { trailing } = splitTrailingSentencePunctuation(match);
			return `[redacted-path]${trailing}`;
		});
	}
	cleaned = cleaned.replace(GENERIC_PATH_RE, (_full, lead: string, token: string) => {
		const { trailing } = splitTrailingSentencePunctuation(token);
		return `${lead}[redacted-path]${trailing}`;
	});
	const codePoints = Array.from(cleaned);
	if (maxChars <= 0) return "";
	if (codePoints.length > maxChars) {
		return maxChars === 1 ? "…" : `${codePoints.slice(0, maxChars - 1).join("")}…`;
	}
	return cleaned;
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
