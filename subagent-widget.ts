/**
 * Subagent Widget — /sub, /subclear, /subrm, /subcont commands with stacking live widgets
 *
 * Each /sub spawns a background Pi subagent with its own persistent session,
 * enabling conversation continuations via /subcont.
 *
 * Usage: pi -e extensions/subagent-widget.ts
 * Then:
 *   /sub list files and summarize          — spawn using the parent model/thinking
 *   /sub --model openai/gpt-5 --thinking high review this code
 *   /subcont 1 --thinking xhigh now write tests for it
 *   /subrm 2                               — remove subagent #2 widget
 *   /subclear                              — clear all subagent widgets
 */

import { StringEnum, type ThinkingLevel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
const { spawn } = require("child_process") as any;
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ResultBatches, WorkerPool } from "./subagent-widget/scheduling.ts";
import { applyExtensionDefaults } from "./themeMap.ts";
import { piAgentDir, scanAgents } from "./bootstrap/bootstrap-utils.ts";
import { readBootstrapConfig, readModelAliases, resolveModel } from "./bootstrap/model-utils.ts";

const FALLBACK_MODEL = "openrouter/google/gemini-3.5-flash";
const THINKING_OVERRIDES = ["low", "medium", "high", "xhigh"] as const;
const MAX_LAST_LINE_CHARS = 512;
type ThinkingOverride = (typeof THINKING_OVERRIDES)[number];
type SubagentThinkingLevel = ThinkingLevel | "max";
const MAX_RESULT_BYTES = 8000;
const MAX_BATCH_BYTES = 8192;
const MAX_BATCH_TURNS = 32;
const NOTICE_TYPE = "subagent-notice";
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_DRAIN_GRACE_MS = 5000;
const DEFAULT_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MANAGEMENT_TOOL_NAMES = ["subagent_continue", "subagent_remove", "subagent_list"];

export interface SubagentWidgetOptions {
	maxConcurrent?: number;
	/** Test seam to override the SIGTERM-to-SIGKILL grace period (defaults to 5000 ms). */
	killGraceMs?: number;
	/** Test seam: how long after child exit to wait for stdio to close before settling anyway (defaults to 5000 ms). */
	drainGraceMs?: number;
	/** Test seam to override the session-file retention period (defaults to seven days). */
	sessionFileMaxAgeMs?: number;
	/** Override the subagent session directory; used by isolated harnesses. */
	sessionsDirectory?: string | (() => string);
	/** Test seam for session-directory setup failures and delays. */
	createSessionsDirectory?: (dir: string) => Promise<void>;
	/** Test seam for controlling startup pruning. */
	pruneSessionFiles?: (dir: string, maxAgeMs: number) => Promise<void>;
	resolveChildDocsExtension?: () => string;
}

interface SpawnOptions {
	persona?: string;
	model?: string;
	thinking?: ThinkingOverride;
	skills?: string[];
	writeAccess?: boolean;
	isContinuation?: boolean;
	notifyOnly?: boolean;
}

interface ResolvedPersona {
	name: string;
	file: string;
	systemPrompt: string;
	model: string;
	thinking?: SubagentThinkingLevel;
	tools: string;
	allowedSkills?: string[];
}

interface SubUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

interface SubState {
	id: number;
	status: "running" | "done" | "error";
	task: string;
	lastAssistantText: string;
	stopReason?: string;
	assistantErrorMessage?: string;
	stderrChunks: string[];
	stderrBytes: number;
	usage: SubUsage;
	lastLine: string;
	partialLine: string;
	partialLineCapped?: boolean;
	currentTool?: string;
	toolCount: number;
	elapsed: number;
	startTime?: number;
	sessionFile: string;   // persistent JSONL session path — used by /subcont to resume
	turnCount: number;     // increments each time /subcont continues this agent
	model: string;
	thinking: SubagentThinkingLevel;
	persona?: ResolvedPersona;
	error?: string;
	continueError?: string;
	queuedTask?: string;
	queuedModel?: string;
	queuedThinking?: SubagentThinkingLevel;
	latestResult?: SettledResult;
	proc?: any;            // active ChildProcess ref (for kill on /subrm)
	cancelled?: boolean;
	killTimer?: ReturnType<typeof setTimeout>;
}

interface SettledResult {
	id: number;
	turnCount: number;
	sessionFile: string;
	elapsedMs: number;
	status: "done" | "error";
	exitCode: number | null;
	finalText: string;
	stderr: string;
	usage: SubUsage;
	errorMessage?: string;
}

function emptyUsage(): SubUsage {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
}

function resolveKillGraceMs(options?: SubagentWidgetOptions): number {
	if (typeof options?.killGraceMs === "number" && Number.isFinite(options.killGraceMs) && options.killGraceMs >= 0) {
		return options.killGraceMs;
	}
	return DEFAULT_KILL_GRACE_MS;
}

function resolveSessionFileMaxAgeMs(options?: SubagentWidgetOptions): number {
	if (typeof options?.sessionFileMaxAgeMs === "number" && Number.isFinite(options.sessionFileMaxAgeMs) && options.sessionFileMaxAgeMs >= 0) {
		return options.sessionFileMaxAgeMs;
	}
	return DEFAULT_SESSION_FILE_MAX_AGE_MS;
}

/** Extract text blocks from an assistant message joined by newlines, or empty string when none exist. */
function extractAssistantText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (part?.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
	return parts.join("\n");
}

/** Slice the last maxBytes from text on a valid UTF-8 character boundary. */
function sliceUtf8Tail(text: string, maxBytes: number): { tail: string; omittedBytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return { tail: text, omittedBytes: 0 };
	let start = Math.max(0, buf.length - maxBytes);
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}
	return { tail: buf.toString("utf8", start), omittedBytes: start };
}

/** Keep at most maxBytes from the tail of text on a valid UTF-8 boundary, marking omitted prefix bytes. */
function truncateTailText(text: string, maxBytes = MAX_RESULT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const { tail, omittedBytes } = sliceUtf8Tail(text, maxBytes);
	return `... [truncated ${omittedBytes} bytes from start]\n\n${tail}`;
}

/** Append stderr while capping buffered memory to the last MAX_STDERR_BYTES bytes. */
function appendStderrTail(state: SubState, chunk: string) {
	if (!chunk) return;
	const chunkBytes = Buffer.byteLength(chunk, "utf8");
	if (chunkBytes >= MAX_STDERR_BYTES) {
		const { tail } = sliceUtf8Tail(chunk, MAX_STDERR_BYTES);
		state.stderrChunks = [tail];
		state.stderrBytes = Buffer.byteLength(tail, "utf8");
		return;
	}
	state.stderrChunks.push(chunk);
	state.stderrBytes += chunkBytes;
	while (state.stderrBytes > MAX_STDERR_BYTES && state.stderrChunks.length > 1) {
		const dropped = state.stderrChunks.shift()!;
		state.stderrBytes -= Buffer.byteLength(dropped, "utf8");
	}
	if (state.stderrBytes > MAX_STDERR_BYTES && state.stderrChunks.length === 1) {
		const { tail } = sliceUtf8Tail(state.stderrChunks[0], MAX_STDERR_BYTES);
		state.stderrChunks = [tail];
		state.stderrBytes = Buffer.byteLength(tail, "utf8");
	}
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost === 0) return "$0.0000";
	return cost < 0.0001 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`;
}

function formatUsage(usage: SubUsage): string {
	return `Usage: input ${usage.input}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite}, output ${usage.output}, cost ${formatCost(usage.cost)}`;
}

function resultHeader(result: SettledResult): string {
	const turnLabel = result.turnCount > 1 ? ` (Turn ${result.turnCount})` : "";
	const statusLabel = result.status === "done"
		? "finished"
		: `failed${result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}`;
	return `Subagent #${result.id}${turnLabel} ${statusLabel}`;
}

// Budget includes the marker. Keep the tail on a UTF-8 boundary, including on errors.
function compactTail(text: string, bytes: number, marker = "[truncated] "): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	// Tiny budgets get the short marker so some of the text itself survives.
	if (bytes < marker.length + 40) marker = "[truncated] ";
	if (bytes <= marker.length) return bytes > 0 ? marker.slice(0, bytes) : "";
	return marker + sliceUtf8Tail(text, bytes - marker.length).tail;
}

const CUT_MARKER = /^\.\.\. \[truncated \d+ bytes from start\]\n\n/;
function stripCutMarker(text: string): string { return text.replace(CUT_MARKER, ""); }

function formatResult(result: SettledResult, bytes: number): string {
	const header = resultHeader(result) + "\nResult:\n";
	const sections: [string, string][] = [];
	if (result.errorMessage) sections.push(["Error", stripCutMarker(result.errorMessage)]);
	const stderr = result.stderr.trim();
	if (result.status === "error" && stderr) sections.push(["Stderr", stderr]);
	const available = bytes - Buffer.byteLength(header);
	// Diagnostics never take more than a third, so the answer always keeps real room.
	const per = Math.min(384, Math.floor(available / (3 * Math.max(1, sections.length))));
	// Truncate only the body so each diagnostic keeps its label.
	const diag = sections.map(([label, body]) => {
		const heading = `\n${label}:\n`;
		return heading + compactTail(body, Math.max(0, per - heading.length));
	}).join("");
	const bodyBytes = available - Buffer.byteLength(diag);
	let text = result.finalText || "(the subagent produced no final message)";
	// The stored text may already carry a cut marker; drop it before cutting again.
	if (Buffer.byteLength(text) > bodyBytes) text = stripCutMarker(text);
	const body = compactTail(text, bodyBytes,
		`[truncated; subagent_list {id:${result.id}} has the transcript path] `);
	return header + body + diag;
}

function formatResultBatch(results: SettledResult[]): string {
	// At most MAX_BATCH_TURNS per envelope, so every turn always gets an ID and space.
	const bytes = Math.min(2048, Math.floor(MAX_BATCH_BYTES / results.length) - 2);
	return results.map(result => formatResult(result, bytes)).join("\n\n");
}

function resultDetails(result: SettledResult): string {
	return `${resultHeader(result)} · ${Math.round(result.elapsedMs / 1000)}s\n${formatUsage(result.usage)}\nTranscript: ${result.sessionFile}` +
		(result.errorMessage ? `\nError: ${truncateTailText(result.errorMessage, 2048)}` : "") +
		(result.stderr.trim() ? `\nStderr:\n${truncateTailText(result.stderr.trim(), 2048)}` : "");
}

interface ParsedCommand {
	options: SpawnOptions;
	rest: string;
	error?: string;
}

function readCommandValue(input: string): { value?: string; rest: string } {
	const trimmed = input.trimStart();
	if (!trimmed) return { rest: "" };

	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		if (end === -1) return { rest: trimmed };
		return { value: trimmed.slice(1, end), rest: trimmed.slice(end + 1) };
	}

	const end = trimmed.search(/\s/);
	return end === -1
		? { value: trimmed, rest: "" }
		: { value: trimmed.slice(0, end), rest: trimmed.slice(end) };
}

function parseCommandOptions(input: string): ParsedCommand {
	const options: SpawnOptions = {};
	let rest = input.trimStart();

	while (rest.startsWith("--")) {
		if (rest === "--" || rest.startsWith("-- ")) {
			return { options, rest: rest.slice(2).trimStart() };
		}
		const flagMatch = rest.match(/^--(persona|model|thinking|skills|write|notify-only)(?:=([^\s]+))?(?:\s+|$)/);
		if (!flagMatch) {
			const flag = rest.match(/^\S+/)?.[0] || rest;
			return { options, rest: "", error: `Unknown or malformed option: ${flag}` };
		}

		const flag = flagMatch[1];
		let value = flagMatch[2];
		rest = rest.slice(flagMatch[0].length);
		if (flag === "write" || flag === "notify-only") {
			if (value !== undefined) return { options, rest: "", error: `--${flag} does not take a value` };
			if (flag === "write") options.writeAccess = true;
			else options.notifyOnly = true;
			rest = rest.trimStart();
			continue;
		}
		if (!value) {
			const parsed = readCommandValue(rest);
			value = parsed.value;
			rest = parsed.rest;
		}
		if (!value) return { options, rest: "", error: `Missing value for --${flag}` };

		if (flag === "persona") {
			options.persona = value;
			rest = rest.trimStart();
			continue;
		}
		if (flag === "model") {
			options.model = value;
			rest = rest.trimStart();
			continue;
		}
		if (flag === "skills") {
			options.skills = value.split(",").map(skill => skill.trim()).filter(Boolean);
			rest = rest.trimStart();
			continue;
		}

		const thinking = value.toLowerCase();
		if (!THINKING_OVERRIDES.includes(thinking as ThinkingOverride)) {
			return {
				options,
				rest: "",
				error: "Thinking must be one of: low, medium, high, xhigh",
			};
		}
		options.thinking = thinking as ThinkingOverride;
		rest = rest.trimStart();
	}

	return { options, rest: rest.trim() };
}

function getPiInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
	// Explicit launcher seam for the test harness; normal Pi runs resolve their current executable below.
	if (env.SUBAGENT_PI_BINARY) return { command: env.SUBAGENT_PI_BINARY, args };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...source };
	for (const key of [
		"PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "SUBAGENT_PI_BINARY",
		"PI_SUBAGENT_PERSONA_PROMPT",
	]) delete env[key];
	return env;
}

export default function (pi: ExtensionAPI, options: SubagentWidgetOptions = {}) {
	const agents: Map<number, SubState> = new Map();
	const maxConcurrent = options.maxConcurrent ?? Number(process.env.PI_SUBAGENT_MAX_CONCURRENT);
	let pool = new WorkerPool<SubState>(maxConcurrent);
	const batches = new ResultBatches<SubState, SettledResult>(MAX_BATCH_TURNS, results => {
		pi.sendMessage({ customType: "subagent-result", content: formatResultBatch(results), display: true },
			{ deliverAs: "followUp", triggerTurn: true });
	});
	let toolTurn = 0;
	let commandBurstStart = -Infinity;
	pi.on("turn_start", () => { toolTurn++; });
	const killGraceMs = resolveKillGraceMs(options);
	const drainGraceMs = typeof options.drainGraceMs === "number" && options.drainGraceMs >= 0 ? options.drainGraceMs : DEFAULT_DRAIN_GRACE_MS;
	const sessionFileMaxAgeMs = resolveSessionFileMaxAgeMs(options);
	let nextId = 1;
	let sessionFileSequence = 0;
	const sessionsDirectoryPromises = new Map<string, Promise<string>>();
	let lifecycleGeneration = 0;
	let shuttingDown = false;
	let widgetCtx: any;
	const helperPath = fileURLToPath(new URL("./subagent-widget/strip-pi-docs.mjs", import.meta.url));
	const resolveChildDocsExtension = options.resolveChildDocsExtension ?? (() => helperPath);
	let streamPaint: ReturnType<typeof setTimeout> | undefined;
	let rowCache = new WeakMap<SubState, { width: number; theme: any; line: string }>();
	let sharedTimer: ReturnType<typeof setInterval> | undefined;
	let widgetVersion = 0;
	let widgetRegistered = false;
	let widgetUi: any;
	let activeComponent: { invalidate(frameOnly?: boolean): void } | undefined;
	let activeTui: { requestRender?: () => void } | undefined;

	pi.registerEntryRenderer<{ text: string; details: string }>(NOTICE_TYPE, (entry, { expanded }) =>
		new Text(sanitizeDisplayText((entry.data?.text ?? "") + (expanded ? `\n${entry.data?.details ?? ""}` : "")), 0, 0));

	function syncManagementTools() {
		const active = pi.getActiveTools();
		const registered = new Set(pi.getAllTools().map(tool => tool.name));
		const next = agents.size > 0
			? [...active, ...MANAGEMENT_TOOL_NAMES.filter(name => registered.has(name) && !active.includes(name))]
			: active.filter(name => !MANAGEMENT_TOOL_NAMES.includes(name));
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
			pi.setActiveTools(next);
		}
	}

	function resolveParentModel(ctx: any): string {
		const parentProvider = ctx.model?.provider?.trim();
		const parentModelId = ctx.model?.id?.trim();
		const hasParentModel = parentProvider && parentModelId
			&& parentProvider !== "unknown" && parentModelId !== "unknown";
		return hasParentModel
			? `${parentProvider}/${parentModelId}`
			: FALLBACK_MODEL;
	}

	function resolvePersona(personaName: string, cwd: string, parentModel: string): { persona?: ResolvedPersona; error?: string } {
		const requested = personaName.trim();
		if (!requested) return { error: "Persona name must not be empty." };
		const agentDir = piAgentDir();
		const projectAgentsDir = path.join(cwd, ".pi", "agents");
		const globalAgentsDir = path.join(agentDir, "agents");
		const available = scanAgents(cwd, agentDir);
		const def = available.find(agent => agent.name.toLowerCase() === requested.toLowerCase());
		if (!def) {
			return {
				error: `Unknown persona "${requested}". Searched ${projectAgentsDir} and ${globalAgentsDir}. Available: ${available.map(agent => agent.name).join(", ") || "none"}.`,
			};
		}
		const slash = parentModel.indexOf("/");
		const ctxModel = slash > 0
			? { provider: parentModel.slice(0, slash), id: parentModel.slice(slash + 1) }
			: undefined;
		try {
			const globalConfigPath = path.join(agentDir, "bootstrap.json");
			const projectConfigPath = path.join(cwd, ".pi", "bootstrap.json");
			const globalConfig = readBootstrapConfig(globalConfigPath);
			const projectConfig = readBootstrapConfig(projectConfigPath);
			const aliases = new Map([
				...readModelAliases(globalConfigPath, globalConfig),
				...readModelAliases(projectConfigPath, projectConfig),
			]);
			const resolvedModel = resolveModel(def, ctxModel, aliases);
			return {
				persona: {
					name: def.name,
					file: def.file,
					systemPrompt: def.systemPrompt,
					model: resolvedModel.model,
					thinking: resolvedModel.thinking as SubagentThinkingLevel | undefined,
					tools: def.tools,
					allowedSkills: def.allowedSkills,
				},
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	function resolveSkillPaths(skills: string[] | undefined, cwd: string): { paths: string[]; error?: string } {
		if (!skills?.length) return { paths: [] };
		const skillCommands = pi.getCommands().filter(command => command.source === "skill");
		const paths: string[] = [];
		for (const skill of skills ?? []) {
			if (!skill.trim()) return { paths: [], error: "Skill name or path must not be empty." };
			const namedSkill = skillCommands.find(command => command.name === `skill:${skill}`);
			if (namedSkill) {
				paths.push(namedSkill.sourceInfo.path);
				continue;
			}
			const resolvedPath = path.resolve(cwd, skill);
			if (!fs.existsSync(resolvedPath)) {
				return { paths: [], error: `Unknown skill "${skill}": no loaded skill name or existing path was found.` };
			}
			paths.push(resolvedPath);
		}
		return { paths };
	}

	// ── Session file helpers ──────────────────────────────────────────────────

	function sessionsDirectory(): string {
		const configured = typeof options.sessionsDirectory === "function"
			? options.sessionsDirectory()
			: options.sessionsDirectory;
		return path.resolve(configured ?? path.join(os.homedir(), ".pi", "agent", "sessions", "subagents"));
	}

	function ensureSessionsDirectory(): Promise<string> {
		const dir = sessionsDirectory();
		let promise = sessionsDirectoryPromises.get(dir);
		if (!promise) {
			promise = (options.createSessionsDirectory
				? options.createSessionsDirectory(dir)
				: fs.promises.mkdir(dir, { recursive: true }).then(() => undefined)
			).then(() => dir).catch(error => {
				if (sessionsDirectoryPromises.get(dir) === promise) sessionsDirectoryPromises.delete(dir);
				throw error;
			});
			sessionsDirectoryPromises.set(dir, promise);
		}
		return promise;
	}

	function makeSessionFile(id: number): string {
		return path.join(sessionsDirectory(), `subagent-${id}-${Date.now()}-${sessionFileSequence++}-${randomUUID()}.jsonl`);
	}

	async function pruneSessionFiles(dir: string): Promise<void> {
		let names: string[];
		try { names = await fs.promises.readdir(dir); } catch { return; }
		const cutoff = Date.now() - sessionFileMaxAgeMs;
		await Promise.all(names.filter(name => /^subagent-.*\.jsonl$/.test(name)).map(async name => {
			const file = path.join(dir, name);
			try {
				const info = await fs.promises.lstat(file);
				if ((info.isFile() || info.isSymbolicLink()) && info.mtimeMs < cutoff) await fs.promises.unlink(file);
			} catch {}
		}));
	}

	function deleteSessionFile(state: SubState): void {
		try { fs.rmSync(state.sessionFile, { force: true }); } catch {}
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	const CONTROL_SEQ_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

	function sanitizeDisplayText(text: string): string {
		return text.replace(CONTROL_SEQ_RE, match =>
			match.startsWith("\x1b[") && /^\x1b\[[0-9;]*m$/.test(match) ? match : ""
		);
	}

	function fitToWidth(text: string, width: number): string {
		if (width <= 0) return "";
		const ellipsis = width < 4 ? "" : "...";
		const truncated = truncateToWidth(text, width, ellipsis);
		if (visibleWidth(truncated) > width) {
			return truncateToWidth(text, width, "");
		}
		return truncated;
	}

	function formatSubagentRow(state: SubState, width: number, theme: any): string {
		const status = state.queuedTask !== undefined ? "queued" : state.status;
		const statusColor = status === "queued" ? "dim" : state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = status === "queued" ? "○" : state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";
		const turnLabel = state.turnCount > 1 ? ` T${state.turnCount}` : "";
		const elapsedLabel = status === "queued" ? "-" : `${Math.max(0, Math.round(state.elapsed / 1000))}s`;
		const toolLabel = state.status === "running" && state.currentTool ? state.currentTool : "-";
		const plainTask = sanitizeDisplayText((state.queuedTask ?? state.task).replace(/[\r\n\t]+/g, " ").trim())
			.replace(/\x1b\[[0-9;]*m/g, "");
		const taskBudget = width <= 40 ? Math.max(6, Math.min(20, Math.floor(width / 3))) : 20;
		// Truncate task label without ellipsis and strip any reset code so dim styling stays intact.
		const taskLabel = plainTask
			? truncateToWidth(plainTask, taskBudget, "").replace(/\x1b\[0m$/g, "")
			: "";
		const lastLine = state.lastLine ? sanitizeDisplayText(state.lastLine.replace(/\t/g, " ")) : "";

		let prefix: string;
		if (width <= 24) {
			const narrowTool = truncateToWidth(toolLabel, 6, "").replace(/\x1b\[0m$/g, "");
			prefix =
				theme.fg(statusColor, `${statusIcon}#${state.id}`) +
				(taskLabel ? " " + theme.fg("dim", taskLabel) : "") +
				" " +
				theme.fg("dim", narrowTool);
		} else if (width <= 40) {
			prefix =
				theme.fg(statusColor, `${statusIcon} #${state.id}`) +
				(turnLabel ? theme.fg("dim", turnLabel) : "") +
				theme.fg("dim", ` ${elapsedLabel}`) +
				(taskLabel ? " " + theme.fg("dim", taskLabel) : "") +
				theme.fg("dim", ` [${toolLabel}]`);
		} else {
			prefix =
				theme.fg(statusColor, `${statusIcon} #${state.id}`) +
				(turnLabel ? theme.fg("dim", turnLabel) : "") +
				" " +
				theme.fg(statusColor, status) +
				theme.fg("dim", ` ${elapsedLabel}`) +
				(taskLabel ? " " + theme.fg("dim", taskLabel) : "") +
				theme.fg("dim", ` Tools: ${state.toolCount} [${toolLabel}]`);
		}
		const row = lastLine
			? `${prefix} ${theme.fg("muted", lastLine)}`
			: prefix;
		return fitToWidth(row, width);
	}

	function renderWidgetLines(width: number, theme: any): string[] {
		if (width <= 0 || agents.size === 0) return [];
		const title = ` Subagents (${agents.size}) `;
		const lead = "─".repeat(Math.min(2, width));
		const tailWidth = Math.max(0, width - visibleWidth(lead) - visibleWidth(title));
		const topBorder = fitToWidth(
			theme.fg("dim", lead) + theme.fg("accent", title) + theme.fg("dim", "─".repeat(tailWidth)),
			width,
		);
		const rows = Array.from(agents.values(), state => {
			const hit = rowCache.get(state);
			if (hit?.width === width && hit.theme === theme) return hit.line;
			const line = formatSubagentRow(state, width, theme);
			rowCache.set(state, { width, theme, line });
			return line;
		});
		const bottomBorder = fitToWidth(theme.fg("dim", "─".repeat(width)), width);
		return [topBorder, ...rows, bottomBorder];
	}

	function stopSharedTimer(): void {
		if (sharedTimer !== undefined) {
			clearInterval(sharedTimer);
			sharedTimer = undefined;
		}
	}

	function streamChanged(state: SubState) {
		rowCache.delete(state);
		if (streamPaint || !activeComponent) return;
		streamPaint = setTimeout(() => { streamPaint = undefined; requestWidgetRender(); }, 100);
		streamPaint.unref?.();
	}

	function requestWidgetRender(): void {
		widgetVersion++;
		activeComponent?.invalidate(true);
		activeTui?.requestRender?.();
	}

	function syncSharedTimer(): void {
		if (hasRunningSubagents()) {
			if (sharedTimer === undefined) {
				sharedTimer = setInterval(() => {
					const now = Date.now();
					let running = false;
					for (const state of agents.values()) {
						if (state.status === "running" && !state.cancelled && !pool.isQueued(state)) {
							running = true;
							if (state.startTime !== undefined) {
								state.elapsed = now - state.startTime;
								rowCache.delete(state);
							}
						}
					}
					if (running) {
						requestWidgetRender();
					} else {
						stopSharedTimer();
					}
				}, 1000);
				sharedTimer.unref?.();
			}
		} else {
			stopSharedTimer();
		}
	}

	/**
	 * Clear the shared timer and global `"subagents"` widget.
	 * Ticket 04 should call this from `session_shutdown`; `session_start` also uses it to reset.
	 */
	function clearWidget(ctx: any = widgetCtx): void {
		stopSharedTimer();
		clearTimeout(streamPaint);
		streamPaint = undefined;
		const ui = widgetUi ?? ctx?.ui;
		if (widgetRegistered && ui?.setWidget) {
			try { ui.setWidget("subagents", undefined); } catch {}
		}
		widgetRegistered = false;
		widgetUi = undefined;
		activeComponent = undefined;
		activeTui = undefined;
		widgetVersion++;
	}

	function updateWidgets(changed?: SubState) {
		if (changed) rowCache.delete(changed);
		clearTimeout(streamPaint);
		streamPaint = undefined;
		if (agents.size === 0) {
			clearWidget(widgetCtx);
			return;
		}
		syncSharedTimer();
		widgetVersion++;
		if (!widgetCtx?.ui?.setWidget) return;

		if (widgetRegistered && widgetUi === widgetCtx.ui) {
			activeComponent?.invalidate(true);
			activeTui?.requestRender?.();
			return;
		}

		if (widgetRegistered && widgetUi && widgetUi !== widgetCtx.ui) {
			try { widgetUi.setWidget("subagents", undefined); } catch {}
			widgetRegistered = false;
			activeComponent = undefined;
			activeTui = undefined;
		}

		try {
			widgetCtx.ui.setWidget("subagents", (tui: any, theme: any) => {
				let cachedWidth: number | undefined;
				let cachedVersion = -1;
				let cachedTheme: any;
				let cachedLines: string[] | undefined;

				const component = {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width && cachedVersion === widgetVersion && cachedTheme === theme) {
							return cachedLines;
						}
						cachedWidth = width;
						cachedVersion = widgetVersion;
						cachedTheme = theme;
						cachedLines = renderWidgetLines(width, theme);
						return cachedLines;
					},
					invalidate(frameOnly = false) {
						if (!frameOnly) rowCache = new WeakMap();
						cachedWidth = undefined;
						cachedLines = undefined;
					},
					dispose() {
						if (activeComponent === component) {
							activeComponent = undefined;
							activeTui = undefined;
						}
					},
				};
				activeComponent = component;
				activeTui = tui;
				return component;
			});
			widgetRegistered = true;
			widgetUi = widgetCtx.ui;
		} catch {
			widgetRegistered = false;
			widgetUi = undefined;
		}
	}

	// ── Delivery & cancellation helpers ───────────────────────────────────────

	function hasRunningSubagents(): boolean {
		for (const state of agents.values()) {
			if (state.status === "running" && !state.cancelled && !pool.isQueued(state)) return true;
		}
		return false;
	}

	function resetScheduler() {
		// Killed children may still be draining; a fresh pool keeps them from throttling new launches.
		pool.clear();
		pool = new WorkerPool<SubState>(maxConcurrent);
		batches.clear();
		commandBurstStart = -Infinity;
	}

	function clearKillTimer(state: SubState) {
		if (state.killTimer) {
			clearTimeout(state.killTimer);
			state.killTimer = undefined;
		}
	}

	function cancelSubagent(state: SubState): Promise<void> {
		// Mark cancelled before signalling so any immediate or delayed close/error event is ignored.
		state.cancelled = true;
		const proc = state.proc;
		if (!proc || state.status !== "running") return Promise.resolve();
		if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

		clearKillTimer(state);
		const stopped = new Promise<void>(resolve => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				proc.off("exit", finish);
				proc.off("close", finish);
				resolve();
			};
			proc.once("exit", finish);
			proc.once("close", finish);
			if (proc.exitCode !== null || proc.signalCode !== null) finish();
		});
		let signalled = false;
		try {
			signalled = Boolean(proc.kill("SIGTERM"));
		} catch {
			return Promise.resolve();
		}
		if (!signalled) return Promise.resolve();

		const timer = setTimeout(() => {
			state.killTimer = undefined;
			if (state.proc === proc && proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}
		}, killGraceMs);
		timer.unref?.();
		state.killTimer = timer;
		return stopped;
	}

	function removeSubagent(id: number, ctx: any): { found: boolean; wasRunning: boolean } {
		const state = agents.get(id);
		if (!state) return { found: false, wasRunning: false };
		// A queued launch has no process yet: removing it is not a kill.
		const wasRunning = state.status === "running" && !pool.isQueued(state);
		void cancelSubagent(state).then(() => deleteSessionFile(state), () => deleteSessionFile(state));
		agents.delete(id);
		updateWidgets();
		syncManagementTools();
		pool.remove(state);
		batches.remove(state);
		return { found: true, wasRunning };
	}

	function prepareTurnState(state: SubState, task: string) {
		state.status = "running";
		state.latestResult = undefined;
		state.cancelled = false;
		state.task = task;
		state.lastLine = "";
		state.partialLine = "";
		state.partialLineCapped = false;
		state.currentTool = undefined;
		state.lastAssistantText = "";
		state.stopReason = undefined;
		state.assistantErrorMessage = undefined;
		state.stderrChunks = [];
		state.stderrBytes = 0;
		state.usage = emptyUsage();
		state.elapsed = 0;
		state.startTime = undefined;
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	/** Cut `text` to at most `maxUnits` UTF-16 code units without splitting surrogate pairs, ZWJ graphemes, or escape sequences. */
	function capLinePrefix(text: string, maxUnits = MAX_LAST_LINE_CHARS): { value: string; capped: boolean } {
		if (text.length <= maxUnits) return { value: text, capped: false };
		let end = 0;
		let i = 0;
		while (i < text.length) {
			if (text[i] === "\x1b") {
				const escMatch = text.slice(i).match(/^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_])/);
				if (escMatch) {
					if (i + escMatch[0].length > maxUnits) return { value: text.slice(0, end), capped: true };
					i += escMatch[0].length;
					end = i;
					continue;
				}
			}
			const nextEsc = text.indexOf("\x1b", i + 1);
			const segEnd = nextEsc === -1 ? text.length : nextEsc;
			for (const { segment } of GRAPHEME_SEGMENTER.segment(text.slice(i, segEnd))) {
				if (end + segment.length > maxUnits) return { value: text.slice(0, end), capped: true };
				end += segment.length;
			}
			i = segEnd;
		}
		return { value: text.slice(0, end), capped: false };
	}

	/**
	 * Maintain the invariant:
	 * - `state.partialLine` is the current (in-progress) line after the final `\n`, capped safely at MAX_LAST_LINE_CHARS.
	 * - `state.lastLine` is the trimmed last non-empty line across everything streamed so far, capped safely at MAX_LAST_LINE_CHARS.
	 * Runs in O(chunk.length) without joining or splitting the accumulated transcript.
	 */
	function appendLastLine(state: SubState, chunk: string): boolean {
		if (!chunk) return false;
		const clean = chunk.includes("\r") ? chunk.replace(/\r/g, "") : chunk;
		if (!clean) return false;
		const prevLastLine = state.lastLine;
		const lastNl = clean.lastIndexOf("\n");
		if (lastNl === -1) {
			if (!state.partialLineCapped) {
				const input = state.partialLine ? clean : clean.trimStart();
				if (input) {
					const capped = capLinePrefix(state.partialLine + input, MAX_LAST_LINE_CHARS);
					state.partialLine = capped.value;
					state.partialLineCapped = capped.capped;
				}
			}
			const trimmed = state.partialLine.trim();
			if (trimmed) state.lastLine = trimmed;
			return state.lastLine !== prevLastLine;
		}

		// Scan backwards from the end down to firstNl so every step strictly shrinks `end`.
		const firstNl = clean.indexOf("\n");
		let end = clean.length;
		let found = "";
		while (end > firstNl) {
			const pos = clean.lastIndexOf("\n", end - 1);
			const seg = clean.slice(pos + 1, end).trim();
			if (seg) {
				found = seg;
				break;
			}
			end = pos;
		}
		if (!found) {
			const combined = (state.partialLine + clean.slice(0, firstNl)).trim();
			if (combined) found = combined;
		}
		if (found) state.lastLine = capLinePrefix(found, MAX_LAST_LINE_CHARS).value;
		const nextPartial = capLinePrefix(clean.slice(lastNl + 1).trimStart(), MAX_LAST_LINE_CHARS);
		state.partialLine = nextPartial.value;
		state.partialLineCapped = nextPartial.capped;
		return state.lastLine !== prevLastLine;
	}

	function processLine(state: SubState, line: string) {
		if (state.cancelled) return;
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) return;
		if (!line.includes('"message_update"') && !line.includes('"tool_execution_start"') && !line.includes('"tool_execution_end"') && !line.includes('"message_end"')) return;
		if (!/^\s*\{\s*"type"\s*:\s*"(?:message_update|tool_execution_start|tool_execution_end|message_end)"(?=\s*[,}])/.test(line)) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					const chunk = delta.delta || "";
					if (appendLastLine(state, chunk)) {
						streamChanged(state);
					}
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				if (typeof event.toolName === "string" && event.toolName) {
					state.currentTool = event.toolName;
				}
				streamChanged(state);
			} else if (type === "tool_execution_end") {
				if (!event.toolName || state.currentTool === event.toolName) {
					state.currentTool = undefined;
				}
				streamChanged(state);
			} else if (type === "message_end") {
				const message = event.message;
				if (!message || typeof message !== "object") return;
				if (message.role === "assistant") {
					state.lastAssistantText = truncateTailText(extractAssistantText(message));
					state.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
					state.assistantErrorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
						? message.errorMessage.trim()
						: undefined;
				}
				if ((message.role === "assistant" || message.role === "toolResult") && message.usage && typeof message.usage === "object") {
					const u = message.usage;
					if (typeof u.input === "number" && Number.isFinite(u.input)) state.usage.input += u.input;
					if (typeof u.cacheRead === "number" && Number.isFinite(u.cacheRead)) state.usage.cacheRead += u.cacheRead;
					if (typeof u.cacheWrite === "number" && Number.isFinite(u.cacheWrite)) state.usage.cacheWrite += u.cacheWrite;
					if (typeof u.output === "number" && Number.isFinite(u.output)) state.usage.output += u.output;
					const costTotal = typeof u.cost === "number" ? u.cost : u.cost?.total;
					if (typeof costTotal === "number" && Number.isFinite(costTotal)) state.usage.cost += costTotal;
				}
			}
		} catch {}
	}

	function scheduleAgent(state: SubState, prompt: string, ctx: any, options: SpawnOptions, origin: "tool" | "command") {
		// Freeze the selected model and launch environment before a queued start.
		const env = { ...process.env };
		const now = Date.now();
		if (origin === "command" && now - commandBurstStart > 100) commandBurstStart = now;
		const key = origin === "command" ? `command:${commandBurstStart}` : `turn:${toolTurn}`;
		state.continueError = undefined;
		const parentModel = resolveParentModel(ctx);
		const model = options.model?.trim() || state.model || state.persona?.model || parentModel;
		const thinking = options.thinking || state.thinking || state.persona?.thinking || pi.getThinkingLevel();
		// Join only now: anything above that throws must not leave an open batch member behind.
		const finish = options.notifyOnly
			? (result?: SettledResult) => { if (result) pi.appendEntry(NOTICE_TYPE, { text: formatResult(result, MAX_RESULT_BYTES), details: resultDetails(result) }); }
			: batches.join(key, state);
		pool.submit(state, wasQueued => {
			state.queuedTask = state.queuedModel = state.queuedThinking = undefined;
			let done: Promise<void>;
			try { done = spawnAgent(state, prompt, ctx, options, model, thinking, env, finish); }
			catch (error) { finish(undefined); throw error; }
			if (!state.proc) {
				// An immediate caller gets the launch error directly. A queued caller has
				// already terminated its turn and must receive the failure as a result.
				const error = state.continueError ?? state.error;
				if (wasQueued && error) {
					// The parent turn already ended; surface the failure where the user can see it.
					try { ctx.ui.notify(`Subagent #${state.id}: ${error}`, "error"); } catch {}
				}
				let failed: SettledResult | undefined;
				if (wasQueued) {
					failed = { id: state.id, turnCount: state.turnCount + 1, sessionFile: state.sessionFile,
						elapsedMs: 0, status: "error", exitCode: null, finalText: "Launch failed", stderr: "", usage: emptyUsage(), errorMessage: error };
					state.latestResult = failed;
					// The turn that was promised to the parent failed; do not leave a green row behind.
					state.status = "error";
				}
				finish(failed);
				updateWidgets(state);
			}
			return done;
		});
		if (pool.isQueued(state)) { state.queuedTask = prompt; state.queuedModel = model; state.queuedThinking = thinking; updateWidgets(state); }
	}

	function spawnAgent(state: SubState, prompt: string, ctx: any, options: SpawnOptions, model: string,
		thinking: SubagentThinkingLevel, env: NodeJS.ProcessEnv, finish: (result?: SettledResult) => void): Promise<void> {
		const tools = options.writeAccess ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls";
		let proc: any;
		const failLaunch = (prefix: string, error: unknown): Promise<void> => {
			const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
			state.proc = undefined;
			if (options.isContinuation) {
				// Preserve prior turn status, widget narration, and turnCount on a failed continuation.
				state.continueError = message;
				return Promise.resolve();
			}
			state.status = "error";
			state.turnCount = 0;
			state.error = message;
			appendLastLine(state, message);
			updateWidgets(state);
			return Promise.resolve();
		};
		let launchStage = "prepare";
		try {
			const childDocsExtension = resolveChildDocsExtension();
			const args = [
				"--mode", "json", "-p", "--session", state.sessionFile, "--no-extensions",
				"--no-skills", "--no-mcp", "--no-prompt-templates", "--no-themes", "--offline",
				"--extension", childDocsExtension,
				"--model", model, "--tools", tools, "--thinking", thinking,
			];
			for (const skill of options.skills ?? []) args.push("--skill", skill);
			args.push("--");
			if (!prompt.startsWith("@")) args.push(prompt);
			const invocation = getPiInvocation(args, env);
			const spawnEnv = childEnvironment(env);
			if (state.persona?.systemPrompt) {
				spawnEnv.PI_SUBAGENT_PERSONA_PROMPT = state.persona.systemPrompt;
			}
			launchStage = "spawn";
			proc = spawn(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: spawnEnv,
			});
		} catch (error) {
			return failLaunch(
				launchStage === "prepare" ? "Could not prepare subagent launch" : "Could not launch subagent",
				error,
			);
		}

		// Commit turn metadata only once child setup and spawn have succeeded so a failed launch/continuation
		// keeps turnCount accurate and preserves the prior turn's result, model, and thinking level.
		if (options.isContinuation) {
			prepareTurnState(state, prompt);
		}
		state.turnCount++;
		state.model = model;
		state.thinking = thinking;
		state.error = undefined;
		state.continueError = undefined;
		updateWidgets(state);

		return new Promise<void>((resolve) => {
			// EPIPE from an already-exited child arrives as an async 'error' event; unhandled it would crash the host.
			proc.stdin!.on("error", () => {});
			try { proc.stdin!.end(prompt.startsWith("@") ? prompt : ""); } catch {}

			state.proc = proc;

			const startTime = Date.now();
			state.startTime = startTime;
			syncSharedTimer();

			let settled = false;
			let buffer = "";

			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanupProcessResources = () => {
				clearTimeout(closeTimer);
				clearKillTimer(state);
				if (state.proc === proc) state.proc = undefined;
			};

			// Note: a synchronous/early spawn error settles this subagent alone and may flush/wake the parent
			// before siblings later in the same batch have been created; this is accepted.
			const settleResult = (status: "done" | "error", exitCode: number | null, errorMessage?: string) => {
				if (settled) return;
				settled = true;
				cleanupProcessResources();

				if (state.cancelled || agents.get(state.id) !== state) {
					syncSharedTimer();
					resolve();
					return;
				}

				state.elapsed = Date.now() - startTime;
				state.status = status;
				if (errorMessage) appendLastLine(state, `Error: ${errorMessage}`);
				updateWidgets(state);

				// A throwing UI (stale ctx) must not strand the worker slot or the result batch.
				try {
					ctx.ui.notify(
						`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
						state.status === "done" ? "success" : "error"
					);
				} catch {}

				const result: SettledResult = {
					id: state.id,
					turnCount: state.turnCount,
					sessionFile: state.sessionFile,
					elapsedMs: state.elapsed,
					status: state.status,
					exitCode,
					finalText: state.lastAssistantText,
					stderr: state.stderrChunks.join(""),
					usage: { ...state.usage },
					errorMessage: errorMessage && truncateTailText(errorMessage),
				};
				state.latestResult = result;
				// A stale host can throw while delivering; that must not escape the child event handler.
				try { finish(result); } catch {} finally { resolve(); }
			};

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				if (state.cancelled) return;
				const lines = chunk.split("\n");
				lines[0] = buffer + lines[0];
				buffer = lines.pop() || "";
				for (const line of lines) processLine(state, line);
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				if (state.cancelled) return;
				appendStderrTail(state, chunk);
				if (chunk.trim() && appendLastLine(state, chunk)) streamChanged(state);
			});

			const finishExited = (code: number | null) => {
				// The grace timer and a late 'close' can both arrive; only the first may touch state.
				if (settled) return;
				const tail = buffer;
				buffer = "";
				if (tail.trim()) processLine(state, tail);
				const hasAssistantError = Boolean(state.assistantErrorMessage) || state.stopReason === "error";
				const status = code === 0 && !hasAssistantError ? "done" : "error";
				settleResult(status, code, state.assistantErrorMessage);
			};

			proc.on("exit", (code: number | null) => {
				clearKillTimer(state);
				// A background grandchild can hold the stdio pipes open so 'close' never fires, which
				// would pin the worker slot forever. Give the pipes a grace period, then settle anyway.
				if (settled) return;
				closeTimer = setTimeout(() => {
					try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch {}
					finishExited(code);
				}, drainGraceMs);
				closeTimer.unref?.();
			});

			proc.on("close", (code: number | null) => finishExited(code));

			proc.on("error", (err: Error) => {
				settleResult("error", null, err.message);
			});
		});
	}

	// ── Tools for the Main Agent ──────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_create",
		description: "Start a background subagent; results arrive as a follow-up. Model override only by user request. Skills and write access are per launch.",
		parameters: Type.Object({
			task: Type.String({ description: "Task for the subagent." }),
			persona: Type.Optional(Type.String({
				description: "Only if the user names a persona.",
			})),
			model: Type.Optional(Type.String({
				description: "Only if the user requests a specific model.",
			})),
			thinking: Type.Optional(StringEnum([...THINKING_OVERRIDES], {
				description: "Reasoning effort (required without persona): low, medium, high, or xhigh.",
			})),
			skills: Type.Optional(Type.Array(Type.String({ description: "Skill name or path; launch only." }))),
			writeAccess: Type.Optional(Type.Boolean({ description: "Enable bash, edit and write for this launch only." })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			if (args.persona === undefined && args.thinking === undefined) {
				return {
					isError: true,
					content: [{ type: "text", text: "Thinking level is required when no persona is specified (low, medium, high, or xhigh)." }],
				};
			}
			if (args.thinking !== undefined && !THINKING_OVERRIDES.includes(args.thinking)) {
				return {
					isError: true,
					content: [{ type: "text", text: "Thinking must be one of: low, medium, high, xhigh" }],
				};
			}
			const parentModel = resolveParentModel(ctx);
			let resolvedPersona: ResolvedPersona | undefined;
			if (args.persona !== undefined) {
				const resolution = resolvePersona(args.persona, ctx.cwd, parentModel);
				if (resolution.error) {
					return { isError: true, content: [{ type: "text", text: resolution.error }] };
				}
				resolvedPersona = resolution.persona;
			}
			const skillResolution = resolveSkillPaths(args.skills, ctx.cwd);
			if (skillResolution.error) {
				return { isError: true, content: [{ type: "text", text: skillResolution.error }] };
			}
			const generation = lifecycleGeneration;
			try { await ensureSessionsDirectory(); }
			catch (error) {
				return { isError: true, content: [{ type: "text", text: `Could not create subagent sessions directory: ${error instanceof Error ? error.message : String(error)}` }] };
			}
			if (shuttingDown || lifecycleGeneration !== generation) {
				return { content: [{ type: "text", text: "Subagent launch cancelled before it started." }] };
			}
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task: args.task,
				lastAssistantText: "",
				stderrChunks: [],
				stderrBytes: 0,
				usage: emptyUsage(),
				lastLine: "",
				partialLine: "",
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 0,
				model: "",
				thinking: resolvedPersona?.thinking ?? pi.getThinkingLevel(),
				persona: resolvedPersona,
			};
			agents.set(id, state);
			syncManagementTools();
			updateWidgets();

			// Fire-and-forget
			scheduleAgent(state, args.task, ctx, { model: args.model, thinking: args.thinking, skills: skillResolution.paths, writeAccess: args.writeAccess }, "tool");
			if (state.status === "error") {
				return { isError: true, content: [{ type: "text", text: state.error ?? `Could not launch subagent #${id}.` }] };
			}

			return {
				content: [{ type: "text", text: `Subagent #${id} ${pool.isQueued(state) ? "queued" : "spawned"}.` }],
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		description: "Continue a finished subagent, using its stored model and thinking unless overridden.",
		defaultActive: false,
		parameters: Type.Object({
			id: Type.Number({ description: "Existing subagent ID." }),
			prompt: Type.String({ description: "Follow-up instructions." }),
			model: Type.Optional(Type.String({
				description: "Override the stored model for this and later turns.",
			})),
			thinking: Type.Optional(StringEnum([...THINKING_OVERRIDES], {
				description: "Override thinking for this and later turns.",
			})),
			skills: Type.Optional(Type.Array(Type.String({ description: "Skill name or path; this turn only." }))),
			writeAccess: Type.Optional(Type.Boolean({ description: "Enable bash, edit and write for this turn only." })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}
			if (state.status === "running") {
				return { content: [{ type: "text", text: `Error: Subagent #${args.id} is ${pool.isQueued(state) ? "queued" : "still running"}.` }] };
			}
			const skillResolution = resolveSkillPaths(args.skills, ctx.cwd);
			if (skillResolution.error) {
				return { isError: true, content: [{ type: "text", text: skillResolution.error }] };
			}
			const generation = lifecycleGeneration;
			try { await ensureSessionsDirectory(); }
			catch (error) {
				return { isError: true, content: [{ type: "text", text: `Could not create subagent sessions directory: ${error instanceof Error ? error.message : String(error)}` }] };
			}
			if (shuttingDown || lifecycleGeneration !== generation || agents.get(state.id) !== state) {
				return { content: [{ type: "text", text: `Subagent #${state.id} continuation cancelled before it started.` }] };
			}

			// Directory setup yields even on a cache hit: recheck before reserving the ID.
			if (state.proc || pool.isQueued(state)) return { isError: true, content: [{ type: "text", text: `Subagent #${state.id} is already busy.` }] };
			scheduleAgent(state, args.prompt, ctx, { model: args.model, thinking: args.thinking, skills: skillResolution.paths, writeAccess: args.writeAccess, isContinuation: true }, "tool");
			if (state.continueError) {
				return { isError: true, content: [{ type: "text", text: state.continueError }] };
			}
			ctx.ui.notify(pool.isQueued(state)
				? `Queued Subagent #${args.id} continuation (Turn ${state.turnCount + 1})…`
				: `Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");

			return {
				content: [{ type: "text", text: `Subagent #${args.id} ${pool.isQueued(state) ? "queued" : "continuing"}.` }],
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		description: "Remove a subagent and stop it if running.",
		defaultActive: false,
		parameters: Type.Object({
			id: Type.Number({ description: "Subagent ID." }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const { found } = removeSubagent(args.id, ctx);
			if (!found) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}

			return {
				content: [{ type: "text", text: `Subagent #${args.id} removed successfully.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		description: "List subagents; pass id for latest usage, diagnostics and full transcript path.",
		defaultActive: false,
		parameters: Type.Object({ id: Type.Optional(Type.Number()) }),
		execute: async (_callId, args) => {
			if (args.id !== undefined) {
				const s = agents.get(args.id);
				const queued = s ? pool.isQueued(s) : false;
				// While a turn is queued or running, the stored result belongs to the previous turn.
				const current = s?.latestResult && s.status !== "running" && !queued ? s.latestResult : undefined;
				const text = current ? resultDetails(current) : s ? `#${s.id}: ${queued ? "queued" : s.status}` : `Unknown subagent #${args.id}`;
				return { content: [{ type: "text", text }] };
			}
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s => {
				const continueNote = s.continueError ? ` [last continue failed: ${s.continueError}]` : "";
				const queued = pool.isQueued(s);
				const meta = queued ? `Turn ${s.turnCount + 1}, ${s.queuedModel ?? s.model}, ${s.queuedThinking ?? s.thinking}` : `Turn ${s.turnCount}, ${s.model}, ${s.thinking}`;
				return `#${s.id} [${queued ? "QUEUED" : s.status.toUpperCase()}] (${meta}) - ${capLinePrefix((s.queuedTask ?? s.task).replace(/\s+/g, " ").trim(), 96).value}${continueNote}`;
			}).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});
	// ── /sub [--persona <name>] [--model <model>] [--thinking <level>] [--skills <list>] [--write] [--notify-only] <task> ──

	pi.registerCommand("sub", {
		description: "Spawn a subagent: /sub [--persona name] [--model provider/model] [--thinking level] [--skills a,b] [--write] [--notify-only] [--] <task>. Skills and write access apply only to this launch. --notify-only shows the result without waking the parent model. Concurrency is capped (PI_SUBAGENT_MAX_CONCURRENT, default 4); extra launches queue.",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const parsed = parseCommandOptions(args || "");
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const task = parsed.rest;
			if (!task) {
				ctx.ui.notify("Usage: /sub [--persona name] [--model provider/model] [--thinking level] [--skills a,b] [--write] [--notify-only] [--] <task>. Skills and write access apply only to this launch. --notify-only shows the result without waking the parent model. Concurrency is capped (PI_SUBAGENT_MAX_CONCURRENT, default 4); extra launches queue.", "error");
				return;
			}
			const parentModel = resolveParentModel(ctx);
			let resolvedPersona: ResolvedPersona | undefined;
			if (parsed.options.persona !== undefined) {
				const resolution = resolvePersona(parsed.options.persona, ctx.cwd, parentModel);
				if (resolution.error) {
					ctx.ui.notify(resolution.error, "error");
					return;
				}
				resolvedPersona = resolution.persona;
			}
			const skillResolution = resolveSkillPaths(parsed.options.skills, ctx.cwd);
			if (skillResolution.error) {
				ctx.ui.notify(skillResolution.error, "error");
				return;
			}
			const generation = lifecycleGeneration;
			try { await ensureSessionsDirectory(); }
			catch (error) {
				ctx.ui.notify(`Could not create subagent sessions directory: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (shuttingDown || lifecycleGeneration !== generation) return;
			parsed.options.skills = skillResolution.paths;

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task,
				lastAssistantText: "",
				stderrChunks: [],
				stderrBytes: 0,
				usage: emptyUsage(),
				lastLine: "",
				partialLine: "",
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 0,
				model: "",
				thinking: resolvedPersona?.thinking ?? pi.getThinkingLevel(),
				persona: resolvedPersona,
			};
			agents.set(id, state);
			syncManagementTools();
			updateWidgets();

			// Fire-and-forget
			scheduleAgent(state, task, ctx, parsed.options, "command");
			if (pool.isQueued(state)) { ctx.ui.notify(`Subagent #${id} queued.`, "info"); return; }
			if (state.status === "error") {
				ctx.ui.notify(state.error ?? `Could not launch subagent #${id}.`, "error");
				return;
			}
			ctx.ui.notify(`Subagent #${id}: ${state.model} (${state.thinking} thinking)`, "info");
		},
	});

	// ── /subcont <id> [--model <model>] [--thinking <level>] [--skills <list>] [--write] [--notify-only] <prompt> ──

	pi.registerCommand("subcont", {
		description: "Continue a subagent: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--notify-only] [--] <prompt>. Skills and write access apply only to this turn. --notify-only shows the result without waking the parent model. Concurrency is capped (PI_SUBAGENT_MAX_CONCURRENT, default 4); extra turns queue.",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const idMatch = trimmed.match(/^(\d+)(?:\s+|$)/);
			if (!idMatch) {
				ctx.ui.notify("Usage: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--notify-only] [--] <prompt>. Skills and write access apply only to this turn. --notify-only shows the result without waking the parent model. Concurrency is capped (PI_SUBAGENT_MAX_CONCURRENT, default 4); extra turns queue.", "error");
				return;
			}

			const num = parseInt(idMatch[1], 10);
			const parsed = parseCommandOptions(trimmed.slice(idMatch[0].length));
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			if (parsed.options.persona !== undefined) {
				ctx.ui.notify("--persona cannot be used with /subcont.", "error");
				return;
			}
			const prompt = parsed.rest;

			if (!prompt) {
				ctx.ui.notify("Usage: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--notify-only] [--] <prompt>. Skills and write access apply only to this turn. --notify-only shows the result without waking the parent model. Concurrency is capped (PI_SUBAGENT_MAX_CONCURRENT, default 4); extra turns queue.", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`Subagent #${num} is ${pool.isQueued(state) ? "queued" : "still running"} — wait for it to finish first.`, "warning");
				return;
			}
			const skillResolution = resolveSkillPaths(parsed.options.skills, ctx.cwd);
			if (skillResolution.error) {
				ctx.ui.notify(skillResolution.error, "error");
				return;
			}
			const generation = lifecycleGeneration;
			try { await ensureSessionsDirectory(); }
			catch (error) {
				ctx.ui.notify(`Could not create subagent sessions directory: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (shuttingDown || lifecycleGeneration !== generation || agents.get(num) !== state) return;
			parsed.options.skills = skillResolution.paths;

			// Resume: update state for a new turn
			if (state.proc || pool.isQueued(state)) { ctx.ui.notify(`Subagent #${num} is already busy.`, "warning"); return; }
			scheduleAgent(state, prompt, ctx, { ...parsed.options, isContinuation: true }, "command");
			if (pool.isQueued(state)) { ctx.ui.notify(`Subagent #${num} queued.`, "info"); return; }
			if (state.continueError) {
				ctx.ui.notify(state.continueError, "error");
				return;
			}
			ctx.ui.notify(`Continuing Subagent #${num} (Turn ${state.turnCount})…`, "info");
			ctx.ui.notify(`Subagent #${num}: ${state.model} (${state.thinking} thinking)`, "info");
		},
	});

	// ── /subrm <number> ───────────────────────────────────────────────────────

	pi.registerCommand("subrm", {
		description: "Remove a specific subagent widget: /subrm <number>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const num = parseInt(args?.trim() ?? "", 10);
			if (isNaN(num)) {
				ctx.ui.notify("Usage: /subrm <number>", "error");
				return;
			}

			const { found, wasRunning } = removeSubagent(num, ctx);
			if (!found) {
				ctx.ui.notify(`No subagent #${num} found.`, "error");
				return;
			}

			if (wasRunning) {
				ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Subagent #${num} removed.`, "info");
			}
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	pi.registerCommand("subclear", {
		description: "Clear all subagent widgets",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;

			let killed = 0;
			lifecycleGeneration++;
			const removals: Promise<void>[] = [];
			for (const [, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					killed++;
				}
				removals.push(cancelSubagent(state).then(() => deleteSessionFile(state), () => deleteSessionFile(state)));
			}

			const total = agents.size;
			agents.clear();
			syncManagementTools();
			resetScheduler();
			nextId = 1;
			clearWidget(ctx);
			await Promise.all(removals);

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	// Pi clears all pending restored names when a tool is removed; reconcile after session_start registrations finish.
	pi.on("before_agent_start", async () => {
		syncManagementTools();
	});

	pi.on("session_tree", async () => {
		// Enable immediately for live subagents; defer an empty-state removal to before_agent_start.
		if (agents.size > 0) syncManagementTools();
	});

	pi.on("session_start", async (_event, ctx) => {
		lifecycleGeneration++;
		shuttingDown = false;
		applyExtensionDefaults(import.meta.url, ctx);
		for (const [, state] of Array.from(agents.entries())) {
			cancelSubagent(state);
		}
		agents.clear();
		// Removing restored management tools here would clear Pi's pending names for other extensions.
		// Empty-state removal waits for before_agent_start; tools restored after that boundary sync on the next prompt.
		resetScheduler();
		nextId = 1;
		widgetCtx = ctx;
		clearWidget(ctx);
		await (options.pruneSessionFiles?.(sessionsDirectory(), sessionFileMaxAgeMs) ?? pruneSessionFiles(sessionsDirectory()));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		lifecycleGeneration++;
		const stopping = Array.from(agents.values()).map(state => cancelSubagent(state));
		const hadSubagents = agents.size > 0;
		agents.clear();
		if (hadSubagents) syncManagementTools();
		resetScheduler();
		clearWidget(ctx);
		// A SIGTERM-ignoring child delays quit through the grace period; descendants holding stdio cannot delay it indefinitely.
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(stopping),
				new Promise<void>(resolve => { timeout = setTimeout(resolve, killGraceMs + 1000); }),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	});
}
