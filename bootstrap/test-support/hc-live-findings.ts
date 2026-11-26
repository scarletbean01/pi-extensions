import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	isKillablePid, json,
	type CommandResult, type CoreIdentity, type CoreStopResult,
} from "./hc-live-core.ts";

export interface Osc7501Fields {
	state: string;
	app?: string;
	msg?: string;
	title?: string;
	kind?: string;
	progress?: number;
	id?: string;
}

export interface Osc7501Candidate {
	label: string;
	body: string;
	terminator: "\x07" | "\x1b\\";
	wire: string;
	encode: (fields: Osc7501Fields, id?: string) => string;
	encodeFull: (fields: Osc7501Fields, id?: string) => string;
}

export const OSC_7501_QUERIES = [
	{ label: "query BEL", wire: "\x1b]7501;?\x07" },
	{ label: "query ST", wire: "\x1b]7501;?\x1b\\" },
	{
		label: "query-with-caps BEL",
		wire: "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x07",
	},
	{
		label: "query-with-caps ST",
		wire: "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\",
	},
] as const;

function kvEntries(fields: Osc7501Fields, msgKey: "msg" | "message" = "msg"): Array<[string, string]> {
	const entries: Array<[string, string]> = [["state", fields.state]];
	if (fields.app !== undefined) entries.push(["app", fields.app]);
	if (fields.kind !== undefined) entries.push(["kind", fields.kind]);
	if (fields.progress !== undefined) entries.push(["progress", String(fields.progress)]);
	if (fields.msg !== undefined) entries.push([msgKey, fields.msg]);
	if (fields.title !== undefined) entries.push(["title", fields.title]);
	if (fields.id !== undefined) entries.push(["id", fields.id]);
	return entries;
}

function kvDelimited(fields: Osc7501Fields, sep: ":" | ";", msgKey: "msg" | "message" = "msg"): string {
	return kvEntries(fields, msgKey).map(([k, v]) => `${k}=${v}`).join(sep);
}

function colonKvWithOptionalId(fields: Osc7501Fields, id?: string, msgKey: "msg" | "message" = "msg"): string {
	const effective = id !== undefined && fields.id === undefined ? { ...fields, id } : fields;
	return kvDelimited(effective, ":", msgKey);
}

export function buildOsc7501Candidates(initial: Osc7501Fields): Osc7501Candidate[] {
	const fullColon = (f: Osc7501Fields, id?: string) => colonKvWithOptionalId(f, id);
	const fullColonMessage = (f: Osc7501Fields, id?: string) => colonKvWithOptionalId(f, id, "message");
	const specs: Array<{
		label: string;
		formatBody: (f: Osc7501Fields, id?: string) => string;
		formatFull?: (f: Osc7501Fields, id?: string) => string;
	}> = [
		// Primary mod grammar: OSC 7501 ; state=...[:key=value...] ST/BEL (no id prefix, state first, colon-separated).
		{
			label: "colon-kv-state",
			formatBody: f => `state=${f.state}`,
			formatFull: fullColon,
		},
		{
			label: "colon-kv-state-app",
			formatBody: f => `state=${f.state}${f.app !== undefined ? `:app=${f.app}` : ""}`,
			formatFull: fullColon,
		},
		{
			label: "colon-kv-state-app-msg",
			formatBody: f => `state=${f.state}${f.app !== undefined ? `:app=${f.app}` : ""}${f.msg !== undefined ? `:msg=${f.msg.replace(/\s+/g, "-")}` : ""}`,
			formatFull: fullColon,
		},
		{
			label: "colon-kv-full",
			formatBody: fullColon,
			formatFull: fullColon,
		},
		{
			label: "colon-kv-message",
			formatBody: fullColonMessage,
			formatFull: fullColonMessage,
		},
		{
			label: "colon-kv-minimal",
			formatBody: (f, id) => `${id ? `${id}:` : ""}state=${f.state}${f.msg !== undefined ? `:msg=${f.msg}` : ""}`,
			formatFull: fullColon,
		},
		// Fallbacks (id-prefixed, bare, semicolon-delimited, JSON).
		{ label: "id-colon-full", formatBody: (f, id = "") => `${id}:${kvDelimited(f, ":")}` },
		{ label: "id-colon-state", formatBody: (f, id = "") => `${id}:state=${f.state}` },
		{ label: "bare-state", formatBody: (f, id) => `${id ? `${id}:` : ""}${f.state}` },
		{ label: "id-colon-bare", formatBody: (f, id = "") => `${id}:${f.state}` },
		{ label: "semicolon-id-colon-full", formatBody: (f, id = "") => `${id};${kvDelimited(f, ":")}` },
		{ label: "semicolon-id-bare", formatBody: (f, id = "") => `${id};${f.state}` },
		{ label: "main-colon-kv-full", formatBody: (f, id = "main") => `${id}:${kvDelimited(f, ":")}` },
		{
			label: "main-colon-kv-msg",
			formatBody: (f, id = "main") => `${id}:state=${f.state}${f.msg !== undefined ? `:msg=${f.msg}` : ""}`,
		},
		{ label: "main-colon-bare", formatBody: (f, id = "main") => `${id}:${f.state}` },
		{ label: "main-semicolon-bare", formatBody: (f, id = "main") => `${id};${f.state}` },
		{ label: "main-semicolon-colon", formatBody: (f, id = "main") => `${id};${kvDelimited(f, ":")}` },
		{ label: "semicolon-kv", formatBody: (f, id) => `${id ? `${id};` : ""}${kvDelimited(f, ";")}` },
		{ label: "json", formatBody: f => JSON.stringify(f) },
	];
	const terminators: Array<["ST" | "BEL", "\x1b\\" | "\x07"]> = [["ST", "\x1b\\"], ["BEL", "\x07"]];
	const out: Osc7501Candidate[] = [];
	for (const spec of specs) {
		for (const [termName, terminator] of terminators) {
			const body = spec.formatBody(initial);
			const fullFormatter = spec.formatFull ?? spec.formatBody;
			out.push({
				label: `${spec.label} ${termName}`,
				body,
				terminator,
				wire: `\x1b]7501;${body}${terminator}`,
				encode: (fields, id) => `\x1b]7501;${spec.formatBody(fields, id)}${terminator}`,
				encodeFull: (fields, id) => `\x1b]7501;${fullFormatter(fields, id)}${terminator}`,
			});
		}
	}
	return out;
}

export function isOscCandidateAccepted(terminal: unknown, expectedState: string): boolean {
	if (!terminal || typeof terminal !== "object") return false;
	const t = terminal as Record<string, unknown>;
	const status = t.status as Record<string, unknown> | null | undefined;
	return t.reported === true && !!status && typeof status === "object" && status.state === expectedState;
}

export function isOscRecordAccepted(terminal: unknown, id: string, expectedState?: string): boolean {
	if (!terminal || typeof terminal !== "object") return false;
	const t = terminal as Record<string, unknown>;
	if (t.reported !== true || !t.records || typeof t.records !== "object" || Array.isArray(t.records)) return false;
	const rec = (t.records as Record<string, unknown>)[id];
	if (!rec || typeof rec !== "object") return false;
	return expectedState ? (rec as Record<string, unknown>).state === expectedState : true;
}

export function isAnyOscReportAccepted(terminal: unknown): boolean {
	if (!terminal || typeof terminal !== "object") return false;
	const t = terminal as Record<string, unknown>;
	const hasRoot = t.status !== null && typeof t.status === "object";
	const records = t.records && typeof t.records === "object" && !Array.isArray(t.records)
		? Object.keys(t.records)
		: [];
	return t.reported === true && (hasRoot || records.length > 0);
}

const MAX_CORE_LOG_BYTES = 64 * 1024;

function isRealDirectory(dir: string): boolean {
	try {
		return lstatSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function findCoreLogs(dir: string, out: string[] = []): string[] {
	if (!isRealDirectory(dir)) return out;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) findCoreLogs(full, out);
		else if (entry.isFile() && entry.name === "core.log") out.push(full);
	}
	return out;
}

export function readFileTailUtf8(file: string, maxBytes = MAX_CORE_LOG_BYTES): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const st = fstatSync(fd);
		if (!st.isFile() || st.size <= 0) return "";
		const start = Math.max(0, st.size - maxBytes);
		const toRead = st.size - start;
		const buf = Buffer.allocUnsafe(toRead);
		let total = 0;
		while (total < toRead) {
			const n = readSync(fd, buf, total, toRead - total, start + total);
			if (n <= 0) break;
			total += n;
		}
		let text = buf.subarray(0, total).toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		}
		return text;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* ignore */ }
		}
	}
}

export function readCoreLogTail(root: string, maxLines = 80): { files: string[]; tail: string[]; osc7501Lines: string[] } {
	const candidates = findCoreLogs(join(root, "state")).sort();
	const files: string[] = [];
	const allLines: string[] = [];
	for (const file of candidates) {
		const chunk = readFileTailUtf8(file);
		if (chunk === undefined) continue;
		files.push(file);
		allLines.push(...chunk.split(/\r?\n/).filter(Boolean));
	}
	return {
		files,
		tail: allLines.slice(-maxLines),
		osc7501Lines: allLines.filter(line => /7501/.test(line)).slice(-maxLines),
	};
}

export const EXPECTED_STATUS_TOP_LEVEL_KEYS = [
	"core", "version", "pid", "uptime_ms", "live", "finished",
	"holder", "holders", "installed_by", "keeps_running_after_logout", "logout_linger_user",
] as const;

export const EXPECTED_STATUS_CORE_KEYS = ["id", "name"] as const;

export function recordStatusShapeFindings(result: CommandResult) {
	const raw = json(result.stdout);
	const topLevelKeys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
	const coreKeys = raw?.core && typeof raw.core === "object" && !Array.isArray(raw.core) ? Object.keys(raw.core) : [];
	return {
		raw: result,
		topLevelKeys,
		coreKeys,
		expectedTopLevelKeys: [...EXPECTED_STATUS_TOP_LEVEL_KEYS],
		expectedCoreKeys: [...EXPECTED_STATUS_CORE_KEYS],
		expectedKeysPresent: EXPECTED_STATUS_TOP_LEVEL_KEYS.every(key => topLevelKeys.includes(key))
			&& EXPECTED_STATUS_CORE_KEYS.every(key => coreKeys.includes(key)),
		ticket03ProbeMatches: typeof raw?.core?.id === "string" && !!raw.core.id.trim()
			&& typeof raw?.version === "string" && !!raw.version.trim(),
	};
}

export function recordShimFindings(shimLogContents: string) {
	const shimCalls = shimLogContents.split("\n").filter(Boolean);
	return {
		shimCalls,
		shimCallCount: shimCalls.length,
	};
}

export function recordCoreEnvFindings(status: {
	identity: CoreIdentity;
	cgroup: string;
	hasRuntimeMarker: boolean;
	coreRuntimeEnv: string | null;
}) {
	return {
		identity: status.identity,
		cgroup: status.cgroup,
		hasRuntimeMarker: status.hasRuntimeMarker,
		observedCoreRuntimeEnv: status.coreRuntimeEnv,
	};
}

export function recordTeardownFindings(stopResult: CoreStopResult) {
	const survivingPids = [
		...(stopResult.remainingCoreAlive && isKillablePid(stopResult.corePid) ? [stopResult.corePid] : []),
		...stopResult.remainingHolderPids.filter(pid => isKillablePid(pid)),
	];
	const findings: Record<string, unknown> = {
		corePid: stopResult.corePid,
		holderPids: stopResult.holderPids,
		teardownPids: {
			mode: stopResult.mode,
			corePid: stopResult.corePid,
			holderPids: stopResult.holderPids,
			remainingCoreAlive: stopResult.remainingCoreAlive,
			remainingHolderPids: stopResult.remainingHolderPids,
			socketRemaining: stopResult.socketRemaining,
		},
	};
	if (stopResult.mode === "fallback") findings.fallbackCleanup = stopResult;
	if (stopResult.stopError) findings.stopError = stopResult.stopError;
	if (survivingPids.length > 0) findings.killCommand = `kill ${survivingPids.join(" ")}`;
	return { findings, survivingPids };
}
