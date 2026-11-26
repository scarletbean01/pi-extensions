import { existsSync, readdirSync, readFileSync } from "node:fs";
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
}

export interface Osc7501Candidate {
	label: string;
	body: string;
	terminator: "\x07" | "\x1b\\";
	wire: string;
	encode: (fields: Osc7501Fields, id?: string) => string;
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

function kvEntries(fields: Osc7501Fields): Array<[string, string]> {
	const entries: Array<[string, string]> = [["state", fields.state]];
	if (fields.app !== undefined) entries.push(["app", fields.app]);
	if (fields.kind !== undefined) entries.push(["kind", fields.kind]);
	if (fields.progress !== undefined) entries.push(["progress", String(fields.progress)]);
	if (fields.msg !== undefined) entries.push(["msg", fields.msg]);
	if (fields.title !== undefined) entries.push(["title", fields.title]);
	return entries;
}

function kvDelimited(fields: Osc7501Fields, sep: ":" | ";"): string {
	return kvEntries(fields).map(([k, v]) => `${k}=${v}`).join(sep);
}

export function buildOsc7501Candidates(initial: Osc7501Fields): Osc7501Candidate[] {
	const specs: Array<{ label: string; formatBody: (f: Osc7501Fields, id?: string) => string }> = [
		{ label: "id-colon-full", formatBody: (f, id = "") => `${id}:${kvDelimited(f, ":")}` },
		{ label: "id-colon-state", formatBody: (f, id = "") => `${id}:state=${f.state}` },
		{ label: "colon-kv-full", formatBody: (f, id) => `${id ? `${id}:` : ""}${kvDelimited(f, ":")}` },
		{
			label: "colon-kv-minimal",
			formatBody: (f, id) => `${id ? `${id}:` : ""}state=${f.state}${f.msg !== undefined ? `:msg=${f.msg}` : ""}`,
		},
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
	const terminators: Array<["BEL" | "ST", "\x07" | "\x1b\\"]> = [["BEL", "\x07"], ["ST", "\x1b\\"]];
	const out: Osc7501Candidate[] = [];
	for (const spec of specs) {
		for (const [termName, terminator] of terminators) {
			const body = spec.formatBody(initial);
			out.push({
				label: `${spec.label} ${termName}`,
				body,
				terminator,
				wire: `\x1b]7501;${body}${terminator}`,
				encode: (fields, id) => `\x1b]7501;${spec.formatBody(fields, id)}${terminator}`,
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

export function isAnyOscReportAccepted(terminal: unknown): boolean {
	if (!terminal || typeof terminal !== "object") return false;
	const t = terminal as Record<string, unknown>;
	const hasRoot = t.status !== null && typeof t.status === "object";
	const records = t.records && typeof t.records === "object" && !Array.isArray(t.records)
		? Object.keys(t.records)
		: [];
	return t.reported === true && (hasRoot || records.length > 0);
}

function findCoreLogs(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) findCoreLogs(full, out);
		else if (entry.isFile() && entry.name === "core.log") out.push(full);
	}
	return out;
}

export function readCoreLogTail(root: string, maxLines = 80): { files: string[]; tail: string[]; osc7501Lines: string[] } {
	const files = findCoreLogs(join(root, "state")).sort();
	const allLines: string[] = [];
	for (const file of files) {
		allLines.push(...readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean));
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
