import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

export const OSC_PROBE_MIN_POLL_MS = 200;
export const OSC_PROBE_MAX_POLL_MS = 1_000;
export const DEFAULT_OSC_PROBE_POLL_MS = 500;
export const EXPECTED_OSC_CAPABILITY_REPLY_BODY = "?:states=idle,working,done,blocked,error:kinds=permission,question,auth";

function wireBytes(input: Buffer | string) {
	const buf = typeof input === "string" ? Buffer.from(input) : input;
	return { hex: buf.toString("hex"), utf8: buf.toString("utf8") };
}

export interface OscProbeSpec {
	key: string;
	terminalName: string;
	wire: string;
	expectedState?: string;
	expectedRecordId?: string;
}

export interface OscProbeOps {
	createTerminal: (name: string) => Promise<{ address: string; name: string }>;
	emitOsc: (address: string, wire: string) => Promise<Buffer | string | void>;
	get: (address: string) => Promise<any>;
	list: () => Promise<{ result: CommandResult; terminals: any[] }>;
	send?: (address: string, text: string) => Promise<CommandResult>;
	stdinOffset?: (address: string) => Promise<number>;
	readStdinSince?: (address: string, offset: number, expectedText?: string) => Promise<Buffer>;
	cleanupTerminal: (address: string) => Promise<void>;
}

export interface OscPollOptions {
	pollMs?: number;
	intervalMs?: number;
	get: () => Promise<any>;
	isDone: (terminal: any) => boolean;
}

export async function pollForOscProbe(options: OscPollOptions): Promise<{ after: any; polls: number; elapsedMs: number }> {
	const pollMs = options.pollMs ?? DEFAULT_OSC_PROBE_POLL_MS;
	const intervalMs = options.intervalMs ?? 40;
	if (!Number.isFinite(pollMs) || pollMs < OSC_PROBE_MIN_POLL_MS || pollMs > OSC_PROBE_MAX_POLL_MS) {
		throw new RangeError(
			`pollForOscProbe pollMs must be between ${OSC_PROBE_MIN_POLL_MS} and ${OSC_PROBE_MAX_POLL_MS} ms, got ${String(pollMs)}`,
		);
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError(`pollForOscProbe intervalMs must be positive, got ${String(intervalMs)}`);
	}
	const started = Date.now();
	const deadline = started + pollMs;
	let polls = 0;
	let after: any;
	while (true) {
		polls++;
		after = await options.get();
		if (options.isDone(after)) break;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await delay(Math.min(intervalMs, remaining));
	}
	return { after, polls, elapsedMs: Date.now() - started };
}

export function buildRun4MinimalProbes(): OscProbeSpec[] {
	return [
		{ key: "idle ST", terminalName: "osc-min-idle-st", wire: "\x1b]7501;state=idle\x1b\\", expectedState: "idle" },
		{ key: "working ST", terminalName: "osc-min-working-st", wire: "\x1b]7501;state=working\x1b\\", expectedState: "working" },
		{ key: "done ST", terminalName: "osc-min-done-st", wire: "\x1b]7501;state=done\x1b\\", expectedState: "done" },
		{ key: "blocked ST", terminalName: "osc-min-blocked-st", wire: "\x1b]7501;state=blocked\x1b\\", expectedState: "blocked" },
		{ key: "error ST", terminalName: "osc-min-error-st", wire: "\x1b]7501;state=error\x1b\\", expectedState: "error" },
		{ key: "working BEL", terminalName: "osc-min-working-bel", wire: "\x1b]7501;state=working\x07", expectedState: "working" },
		{ key: "blocked BEL", terminalName: "osc-min-blocked-bel", wire: "\x1b]7501;state=blocked\x07", expectedState: "blocked" },
	];
}

export function buildRun4SingleKeyProbes(terminator: "\x1b\\" | "\x07" = "\x1b\\"): OscProbeSpec[] {
	// The msg probe deliberately uses raw "hello", not base64; it does not establish whether hc accepts Pi's payload.
	return [
		{ key: "app", terminalName: "osc-key-app", wire: `\x1b]7501;state=working:app=spike${terminator}`, expectedState: "working" },
		{ key: "msg", terminalName: "osc-key-msg", wire: `\x1b]7501;state=working:msg=hello${terminator}`, expectedState: "working" },
		{ key: "message", terminalName: "osc-key-message", wire: `\x1b]7501;state=working:message=hello${terminator}`, expectedState: "working" },
		{ key: "title", terminalName: "osc-key-title", wire: `\x1b]7501;state=working:title=Spike${terminator}`, expectedState: "working" },
		{ key: "progress", terminalName: "osc-key-progress", wire: `\x1b]7501;state=working:progress=37${terminator}`, expectedState: "working" },
		{ key: "kind", terminalName: "osc-key-kind", wire: `\x1b]7501;state=blocked:kind=permission${terminator}`, expectedState: "blocked" },
		{
			key: "id",
			terminalName: "osc-key-id",
			wire: `\x1b]7501;state=working:id=worker1${terminator}`,
			expectedState: "working",
			expectedRecordId: "worker1",
		},
	];
}

export function buildRun4EscapingProbes(msgKey: "msg" | "message", terminator: "\x1b\\" | "\x07" = "\x1b\\"): OscProbeSpec[] {
	const special = 'semi; colon: equals= percent% quote" slash\\ café';
	return [
		{ key: "spaces", terminalName: "osc-esc-spaces", wire: `\x1b]7501;state=working:${msgKey}=plain message${terminator}`, expectedState: "working" },
		{ key: "colon", terminalName: "osc-esc-colon", wire: `\x1b]7501;state=working:${msgKey}=step: detail${terminator}`, expectedState: "working" },
		{ key: "unicode", terminalName: "osc-esc-unicode", wire: `\x1b]7501;state=working:${msgKey}=café ✓ — test${terminator}`, expectedState: "working" },
		{
			key: "percent-encoding",
			terminalName: "osc-esc-percent",
			wire: `\x1b]7501;state=working:${msgKey}=${encodeURIComponent(special)}${terminator}`,
			expectedState: "working",
		},
	];
}

export function buildRun4RecordByIdProbes(terminator: "\x1b\\" | "\x07" = "\x1b\\"): OscProbeSpec[] {
	return [
		{
			key: "state-first-id",
			terminalName: "osc-rec-state-first",
			wire: `\x1b]7501;state=working:id=worker1${terminator}`,
			expectedState: "working",
			expectedRecordId: "worker1",
		},
		{
			key: "id-first-state",
			terminalName: "osc-rec-id-first",
			wire: `\x1b]7501;id=worker1:state=working${terminator}`,
			expectedState: "working",
			expectedRecordId: "worker1",
		},
	];
}

export async function runIsolatedOscProbe(
	ops: OscProbeOps,
	spec: OscProbeSpec,
	options: { pollMs?: number; intervalMs?: number } = {},
): Promise<Record<string, unknown>> {
	let created: { address: string; name: string } | undefined;
	try {
		created = await ops.createTerminal(spec.terminalName);
		const address = created.address;
		const before = await ops.get(address);
		await ops.emitOsc(address, spec.wire);
		const polled = await pollForOscProbe({
			pollMs: options.pollMs,
			intervalMs: options.intervalMs,
			get: () => ops.get(address),
			isDone: term => spec.expectedRecordId
				? isOscRecordAccepted(term, spec.expectedRecordId, spec.expectedState)
				: spec.expectedState
					? isOscCandidateAccepted(term, spec.expectedState)
					: isAnyOscReportAccepted(term),
		});
		const listing = await ops.list();
		const lsTerminal = listing.terminals.find((item: any) => item?.address === address) ?? null;
		const accepted = spec.expectedRecordId
			? isOscRecordAccepted(polled.after, spec.expectedRecordId, spec.expectedState)
			: spec.expectedState
				? isOscCandidateAccepted(polled.after, spec.expectedState)
				: isAnyOscReportAccepted(polled.after);
		const st = polled.after?.status;
		return {
			address,
			terminalName: spec.terminalName,
			wire: wireBytes(spec.wire),
			before,
			after: polled.after,
			ls: listing.result,
			lsTerminal,
			polls: polled.polls,
			elapsedMs: polled.elapsedMs,
			statusChanged: JSON.stringify(before?.status ?? null) !== JSON.stringify(st ?? null),
			accepted,
			acceptedAny: isAnyOscReportAccepted(polled.after),
			representation: {
				reported: polled.after?.reported ?? null,
				status: st ?? null,
				status_ms: polled.after?.status_ms ?? null,
				turn: polled.after?.turn ?? null,
				records: polled.after?.records ?? null,
				lsStatus: lsTerminal?.status ?? null,
			},
			observedFields: {
				state: st?.state ?? null,
				app: st?.app ?? null,
				msg: st?.msg ?? null,
				message: st?.message ?? null,
				title: st?.title ?? null,
				progress: st?.progress ?? null,
				kind: st?.kind ?? null,
				records: polled.after?.records ?? null,
			},
		};
	} catch (error) {
		return {
			terminalName: spec.terminalName,
			wire: wireBytes(spec.wire),
			accepted: false,
			acceptedAny: false,
			error: String(error),
		};
	} finally {
		if (created) {
			await ops.cleanupTerminal(created.address).catch(() => {});
		}
	}
}

export async function runOscProbeSuite(
	ops: OscProbeOps,
	options: { pollMs?: number; intervalMs?: number } = {},
): Promise<{
	capabilityQueries: Record<string, unknown>;
	minimalStates: Record<string, any>;
	acceptedTerminator: "\x1b\\" | "\x07" | null;
	singleKeys: Record<string, any>;
	modCombo: Record<string, unknown>;
	escapingMsgKey: "msg" | "message" | null;
	escaping: Record<string, unknown>;
	recordsById: Record<string, any>;
}> {
	// 1. Capability queries on their own fresh terminal.
	const capabilityQueries: Record<string, unknown> = {};
	let queryTerm: { address: string; name: string } | undefined;
	try {
		queryTerm = await ops.createTerminal("osc-cap-query");
		for (const q of OSC_7501_QUERIES) {
			try {
				const replyRaw = await ops.emitOsc(queryTerm.address, q.wire);
				const replyBuf = replyRaw === undefined ? Buffer.alloc(0)
					: typeof replyRaw === "string" ? Buffer.from(replyRaw, "utf8") : replyRaw;
				capabilityQueries[q.label] = { wire: wireBytes(q.wire), reply: wireBytes(replyBuf) };
			} catch (error) {
				capabilityQueries[q.label] = { wire: wireBytes(q.wire), error: String(error) };
			}
		}
	} catch (error) {
		capabilityQueries.error = String(error);
	} finally {
		if (queryTerm) await ops.cleanupTerminal(queryTerm.address).catch(() => {});
	}

	// 2. Minimal state words first, each alone on a fresh terminal.
	const minimalStates: Record<string, any> = {};
	for (const spec of buildRun4MinimalProbes()) {
		minimalStates[spec.key] = await runIsolatedOscProbe(ops, spec, options);
	}
	const acceptedTerminator: "\x1b\\" | "\x07" | null = minimalStates["working ST"]?.accepted
		? "\x1b\\"
		: minimalStates["working BEL"]?.accepted
			? "\x07"
			: null;
	const term: "\x1b\\" | "\x07" = acceptedTerminator ?? "\x1b\\";

	// 3. One extra key at a time on top of a working minimal record.
	const singleKeys: Record<string, any> = {};
	for (const spec of buildRun4SingleKeyProbes(term)) {
		singleKeys[spec.key] = await runIsolatedOscProbe(ops, spec, options);
	}
	const modCombo = await runIsolatedOscProbe(
		ops,
		{ key: "mod-combo", terminalName: "osc-mod-hermes", wire: `\x1b]7501;state=working:app=hermes${term}`, expectedState: "working" },
		options,
	);

	const msgAccepted = singleKeys.msg?.accepted === true;
	const messageAccepted = singleKeys.message?.accepted === true;
	const msgPopulated = msgAccepted && singleKeys.msg?.observedFields?.msg === "hello";
	const messagePopulated = messageAccepted && (singleKeys.message?.observedFields?.msg === "hello" || singleKeys.message?.observedFields?.message === "hello");
	const escapingMsgKey: "msg" | "message" | null = msgPopulated
		? "msg"
		: messagePopulated
			? "message"
			: msgAccepted
				? "msg"
				: messageAccepted
					? "message"
					: null;

	const escaping: Record<string, unknown> = {};
	if (escapingMsgKey) {
		for (const spec of buildRun4EscapingProbes(escapingMsgKey, term)) {
			const res = await runIsolatedOscProbe(ops, spec, options);
			escaping[spec.key] = {
				...res,
				msgKey: escapingMsgKey,
				observedMsg: (res.observedFields as any)?.msg ?? (res.observedFields as any)?.message ?? null,
			};
		}
	} else {
		escaping.skippedReason = "neither msg= nor message= was accepted in single-key probes";
	}

	// 4. Records by id, each on a fresh terminal.
	const recordsById: Record<string, any> = {};
	for (const spec of buildRun4RecordByIdProbes(term)) {
		recordsById[spec.key] = await runIsolatedOscProbe(ops, spec, options);
	}

	return {
		capabilityQueries,
		minimalStates,
		acceptedTerminator,
		singleKeys,
		modCombo,
		escapingMsgKey,
		escaping,
		recordsById,
	};
}

export async function runBlockedSendSuite(
	ops: OscProbeOps,
	options: {
		pollMs?: number;
		intervalMs?: number;
		terminator?: "\x1b\\" | "\x07";
		wakeText: (id: string) => string;
	},
): Promise<Record<string, any>> {
	if (!ops.send || !ops.stdinOffset || !ops.readStdinSince) {
		throw new Error("runBlockedSendSuite requires send, stdinOffset, and readStdinSince");
	}
	const term = options.terminator ?? "\x1b\\";
	const results: Record<string, any> = {};
	for (const targetState of ["blocked", "working", "done"] as const) {
		let created: { address: string; name: string } | undefined;
		try {
			created = await ops.createTerminal(`send-${targetState}`);
			const address = created.address;
			const before = await ops.get(address);
			const candidateWires = targetState === "blocked"
				? [
					`\x1b]7501;state=blocked${term}`,
					`\x1b]7501;state=blocked${term === "\x1b\\" ? "\x07" : "\x1b\\"}`,
					`\x1b]7501;state=blocked:kind=permission${term}`,
				]
				: [`\x1b]7501;state=${targetState}${term}`];

			let wireUsed = candidateWires[0]!;
			let polled: { after: any; polls: number; elapsedMs: number } | undefined;
			let statusObserved = false;
			for (const candidateWire of candidateWires) {
				wireUsed = candidateWire;
				await ops.emitOsc(address, candidateWire);
				polled = await pollForOscProbe({
					pollMs: options.pollMs,
					intervalMs: options.intervalMs,
					get: () => ops.get(address),
					isDone: terminal => isOscCandidateAccepted(terminal, targetState),
				});
				if (isOscCandidateAccepted(polled.after, targetState)) {
					statusObserved = true;
					break;
				}
			}

			if (targetState === "blocked" && !statusObserved) {
				results.blocked = {
					address,
					wire: wireBytes(wireUsed),
					statusBefore: before?.status ?? null,
					statusAfter: polled?.after?.status ?? null,
					statusObserved: false,
					sendAttempted: false,
					note: "Could not produce blocked status on terminal; skipped blocked send check",
				};
				continue;
			}

			const text = options.wakeText(targetState);
			const offset = await ops.stdinOffset(address);
			const sendStart = Date.now();
			const sendResult = await ops.send(address, text);
			const sendDurationMs = Date.now() - sendStart;
			const input = await ops.readStdinSince(address, offset, text);
			const parsedErrKind = json(sendResult.stderr)?.error?.kind ?? null;
			results[targetState] = {
				address,
				wire: wireBytes(wireUsed),
				statusObserved,
				sendAttempted: true,
				statusBefore: before?.status ?? null,
				statusAfter: polled?.after?.status ?? null,
				args: ["send", "--json", address, text],
				sendDurationMs,
				waited: sendDurationMs >= 1_000 || sendResult.timedOut,
				result: sendResult,
				errorKind: parsedErrKind,
				input: wireBytes(input),
				delivered: input.includes(text),
				...(targetState === "blocked"
					? { matchesContract: sendResult.code === 9 && parsedErrKind === "blocked" && input.length === 0 }
					: {}),
			};
		} catch (error) {
			results[targetState] = {
				statusObserved: false,
				sendAttempted: false,
				error: String(error),
			};
		} finally {
			if (created) {
				await ops.cleanupTerminal(created.address).catch(() => {});
			}
		}
	}
	return results;
}

export function evaluateLiveBhRequirements(input: {
	selected: ReadonlySet<string>;
	osc: Record<string, any>;
	blocked: Record<string, any>;
}) {
	const missing: string[] = [];
	const oscObservations: Record<string, any> = {};
	const blockedObservations: Record<string, any> = {};

	if (input.selected.has("b")) {
		const queries = input.osc.capabilityQueries ?? {};
		const belOk = queries["query BEL"]?.reply?.utf8 === `\x1b]7501;${EXPECTED_OSC_CAPABILITY_REPLY_BODY}\x07`;
		const stOk = queries["query ST"]?.reply?.utf8 === `\x1b]7501;${EXPECTED_OSC_CAPABILITY_REPLY_BODY}\x1b\\`;
		oscObservations.capabilityQueryBel = { observed: belOk };
		oscObservations.capabilityQuerySt = { observed: stOk };
		if (!belOk) missing.push("b: capability query BEL did not return expected reply");
		if (!stOk) missing.push("b: capability query ST did not return expected reply");

		const minimalStates = input.osc.minimalStates ?? {};
		const stateWords = ["idle", "working", "done", "blocked", "error"] as const;
		const observedStates = stateWords.filter(word => minimalStates[`${word} ST`]?.accepted === true);
		const missingStates = stateWords.filter(word => minimalStates[`${word} ST`]?.accepted !== true);
		oscObservations.minimalStates = {
			observed: missingStates.length === 0,
			observedWords: observedStates,
			missing: missingStates,
		};
		if (missingStates.length > 0) {
			missing.push(`b: hc did not expose minimal OSC state word(s): ${missingStates.join(", ")}`);
		}

		const recordsById = input.osc.recordsById ?? {};
		const recordsObserved = Object.values(recordsById).some((entry: any) => entry?.accepted === true);
		oscObservations.recordsById = { observed: recordsObserved };
		if (!recordsObserved) {
			missing.push("b: hc did not populate get.records for any id= OSC 7501 probe");
		}
	}

	if (input.selected.has("h")) {
		const b = input.blocked.blocked;
		const blockedRefused = b?.statusObserved === true && b?.matchesContract === true;
		blockedObservations.blockedRefused = {
			observed: blockedRefused,
			statusObserved: b?.statusObserved === true,
			code: b?.result?.code ?? null,
			errorKind: b?.errorKind ?? null,
			deliveredBytes: b?.input?.utf8?.length ?? null,
		};
		if (!blockedRefused) {
			missing.push("h: blocked send did not refuse with exit 9 / error.kind=blocked and 0 delivered bytes");
		}

		const w = input.blocked.working;
		const d = input.blocked.done;
		blockedObservations.workingSend = {
			observed: w?.sendAttempted === true && w?.result?.timedOut === false,
			code: w?.result?.code ?? null,
			delivered: w?.delivered ?? null,
			waited: w?.waited ?? null,
		};
		blockedObservations.doneSend = {
			observed: d?.sendAttempted === true && d?.result?.timedOut === false,
			code: d?.result?.code ?? null,
			delivered: d?.delivered ?? null,
			waited: d?.waited ?? null,
		};
	}

	return { oscObservations, blockedObservations, missing };
}
