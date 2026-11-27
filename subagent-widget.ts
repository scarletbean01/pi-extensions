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
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
const { spawn } = require("child_process") as any;
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

const FALLBACK_MODEL = "openrouter/google/gemini-3.5-flash";
const THINKING_OVERRIDES = ["low", "medium", "high", "xhigh"] as const;
type ThinkingOverride = (typeof THINKING_OVERRIDES)[number];

interface SpawnOptions {
	model?: string;
	thinking?: ThinkingOverride;
	skills?: string[];
	writeAccess?: boolean;
}

interface SubState {
	id: number;
	status: "running" | "done" | "error";
	task: string;
	textChunks: string[];
	toolCount: number;
	elapsed: number;
	sessionFile: string;   // persistent JSONL session path — used by /subcont to resume
	turnCount: number;     // increments each time /subcont continues this agent
	model: string;
	thinking: ThinkingLevel;
	error?: string;
	proc?: any;            // active ChildProcess ref (for kill on /subrm)
}

interface SubagentWidgetOptions {
	createChildDocsDirectory?: () => string;
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
		const flagMatch = rest.match(/^--(model|thinking|skills|write)(?:=([^\s]+))?(?:\s+|$)/);
		if (!flagMatch) {
			const flag = rest.match(/^\S+/)?.[0] || rest;
			return { options, rest: "", error: `Unknown or malformed option: ${flag}` };
		}

		const flag = flagMatch[1];
		let value = flagMatch[2];
		rest = rest.slice(flagMatch[0].length);
		if (flag === "write") {
			if (value !== undefined) return { options, rest: "", error: "--write does not take a value" };
			options.writeAccess = true;
			rest = rest.trimStart();
			continue;
		}
		if (!value) {
			const parsed = readCommandValue(rest);
			value = parsed.value;
			rest = parsed.rest;
		}
		if (!value) return { options, rest: "", error: `Missing value for --${flag}` };

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
	]) delete env[key];
	return env;
}

export default function (pi: ExtensionAPI, options: SubagentWidgetOptions = {}) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;
	let widgetCtx: any;
	const createChildDocsDirectory = options.createChildDocsDirectory ??
		(() => fs.mkdtempSync(path.join(os.tmpdir(), "subagent-widget-child-")));

	function resolveSkillPaths(skills: string[] | undefined, cwd: string): { paths: string[]; error?: string } {
		const skillCommands = pi.getCommands().filter(command => command.source === "skill");
		const paths: string[] = [];
		for (const skill of skills ?? []) {
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

	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	// ── Widget rendering ──────────────────────────────────────────────────────

	function updateWidgets() {
		if (!widgetCtx) return;

		for (const [id, state] of Array.from(agents.entries())) {
			const key = `sub-${id}`;
			widgetCtx.ui.setWidget(key, (_tui: any, theme: any) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);

				container.addChild(new Text("", 0, 0)); // top margin
				container.addChild(new DynamicBorder(borderFn));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const statusColor = state.status === "running" ? "accent"
							: state.status === "done" ? "success" : "error";
						const statusIcon = state.status === "running" ? "●"
							: state.status === "done" ? "✓" : "✗";

						const taskPreview = state.task.length > 40
							? state.task.slice(0, 37) + "..."
							: state.task;

						const turnLabel = state.turnCount > 1
							? theme.fg("dim", ` · Turn ${state.turnCount}`)
							: "";

						lines.push(
							theme.fg(statusColor, `${statusIcon} Subagent #${state.id}`) +
							turnLabel +
							theme.fg("dim", `  ${taskPreview}`) +
							theme.fg("dim", `  (${Math.round(state.elapsed / 1000)}s)`) +
							theme.fg("dim", ` | Tools: ${state.toolCount}`)
						);

						const fullText = state.textChunks.join("");
						const lastLine = fullText.split("\n").filter((l: string) => l.trim()).pop() || "";
						if (lastLine) {
							const trimmed = lastLine.length > width - 10
								? lastLine.slice(0, width - 13) + "..."
								: lastLine;
							lines.push(theme.fg("muted", `  ${trimmed}`));
						}

						content.setText(lines.join("\n"));
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		}
	}

	// ── Streaming helpers ─────────────────────────────────────────────────────

	function processLine(state: SubState, line: string) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) return;
		if (!line.includes('"message_update"') && !line.includes('"tool_execution_start"')) return;
		if (!/^\s*\{\s*"type"\s*:\s*"(?:message_update|tool_execution_start)"(?=\s*[,}])/.test(line)) return;
		try {
			const event = JSON.parse(line);
			const type = event.type;

			if (type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta") {
					state.textChunks.push(delta.delta || "");
					updateWidgets();
				}
			} else if (type === "tool_execution_start") {
				state.toolCount++;
				updateWidgets();
			}
		} catch {}
	}

	function spawnAgent(
		state: SubState,
		prompt: string,
		ctx: any,
		options: SpawnOptions = {},
	): Promise<void> {
		const parentProvider = ctx.model?.provider?.trim();
		const parentModelId = ctx.model?.id?.trim();
		const hasParentModel = parentProvider && parentModelId
			&& parentProvider !== "unknown" && parentModelId !== "unknown";
		const parentModel = hasParentModel
			? `${parentProvider}/${parentModelId}`
			: FALLBACK_MODEL;
		const model = options.model?.trim() || state.model || parentModel;
		const thinking = options.thinking || state.thinking || pi.getThinkingLevel();
		state.model = model;
		state.thinking = thinking;
		const tools = options.writeAccess ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls";
		let childDocsExtensionDir: string | undefined;
		let childDocsExtension = "";
		try {
			childDocsExtensionDir = createChildDocsDirectory();
			childDocsExtension = path.join(childDocsExtensionDir, "strip-pi-docs.mjs");
			fs.writeFileSync(childDocsExtension, `export default function (pi) {
	pi.on("before_agent_start", (event) => {
		const systemPrompt = event.systemPrompt.replace(/\\n\\n<docs>[\\s\\S]*?<\\/docs>(?=\\n\\n|$)/, "");
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});
}`);
		} catch (error) {
			if (childDocsExtensionDir) {
				if (childDocsExtensionDir) try { fs.rmSync(childDocsExtensionDir, { recursive: true, force: true }); } catch {}
			}
			state.status = "error";
			state.proc = undefined;
			state.error = `Could not prepare subagent launch: ${error instanceof Error ? error.message : String(error)}`;
			state.textChunks.push(state.error);
			updateWidgets();
			return Promise.resolve();
		}
		const args = [
			"--mode", "json", "-p", "--session", state.sessionFile, "--no-extensions",
			"--no-skills", "--no-mcp", "--no-prompt-templates", "--no-themes", "--offline",
			"--extension", childDocsExtension,
			"--model", model, "--tools", tools, "--thinking", thinking,
		];
		for (const skill of options.skills ?? []) args.push("--skill", skill);
		args.push("--");
		if (!prompt.startsWith("@")) args.push(prompt);
		const invocation = getPiInvocation(args);

		return new Promise<void>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: childEnvironment(process.env),
			});
			proc.stdin!.end(prompt.startsWith("@") ? prompt : "");

			state.proc = proc;

			const startTime = Date.now();
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidgets();
			}, 1000);

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				const lines = chunk.split("\n");
				lines[0] = buffer + lines[0];
				buffer = lines.pop() || "";
				for (const line of lines) processLine(state, line);
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				if (chunk.trim()) {
					state.textChunks.push(chunk);
					updateWidgets();
				}
			});

			proc.on("close", (code) => {
				if (childDocsExtensionDir) try { fs.rmSync(childDocsExtensionDir, { recursive: true, force: true }); } catch {}
				if (buffer.trim()) processLine(state, buffer);
				clearInterval(timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";
				state.proc = undefined;
				updateWidgets();

				const result = state.textChunks.join("");
				ctx.ui.notify(
					`Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				pi.sendMessage({
					customType: "subagent-result",
					content: `Subagent #${state.id}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
					display: true,
				}, { deliverAs: "followUp", triggerTurn: true });

				resolve();
			});

			proc.on("error", (err) => {
				try { fs.rmSync(childDocsExtensionDir, { recursive: true, force: true }); } catch {}
				clearInterval(timer);
				state.status = "error";
				state.proc = undefined;
				state.textChunks.push(`Error: ${err.message}`);
				updateWidgets();
				resolve();
			});
		});
	}

	// ── Tools for the Main Agent ──────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_create",
		description: "Spawn a background subagent. Thinking level is required and is the primary way to match the subagent to task complexity: low for lightweight/simple tasks, medium for routine tasks needing moderate reasoning, high for complex multi-step work, and xhigh for the hardest tasks or when accuracy and performance are critical. Unless the user explicitly requests a specific model, omit model and use the default inherited parent model. Skills and write access apply to this launch only. Returns immediately and delivers results as a follow-up message.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
			model: Type.Optional(Type.String({
				description: "Leave blank or omit unless the user explicitly requests a specific model. Do not choose a different model autonomously. When explicitly requested, provide the override in provider/model form. The default reuses the parent caller's current model and falls back to openrouter/google/gemini-3.5-flash only if the parent has no model.",
			})),
			thinking: StringEnum([...THINKING_OVERRIDES], {
				description: "Required thinking level. Use low for lightweight/simple tasks; medium for routine tasks needing moderate reasoning; high for complex, multi-step, or ambiguous work; and xhigh for the hardest tasks or when accuracy and performance are critical. Pi may clamp the value to the selected model's supported maximum.",
			}),
			skills: Type.Optional(Type.Array(Type.String({ description: "Skill names or paths for this launch only" }))),
			writeAccess: Type.Optional(Type.Boolean({ description: "Enable bash, edit and write tools for this launch only" })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const skillResolution = resolveSkillPaths(args.skills, ctx.cwd);
			if (skillResolution.error) {
				return { isError: true, content: [{ type: "text", text: skillResolution.error }] };
			}
			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task: args.task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				model: "",
				thinking: pi.getThinkingLevel(),
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, args.task, ctx, { model: args.model, thinking: args.thinking, skills: skillResolution.paths, writeAccess: args.writeAccess });
			if (state.status === "error") {
				return { isError: true, content: [{ type: "text", text: state.error ?? `Could not launch subagent #${id}.` }] };
			}

			return {
				content: [{ type: "text", text: `Subagent #${id} spawned with ${state.model} (${state.thinking} thinking) and is running in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		description: "Continue an existing subagent conversation with its stored model and thinking level unless explicitly overridden. Skills and write access apply to this turn only. Returns immediately while it runs in the background.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to continue" }),
			prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
			model: Type.Optional(Type.String({
				description: "Omit to reuse this subagent's stored model; provide a provider/model override to change it for this and later turns.",
			})),
			thinking: Type.Optional(StringEnum([...THINKING_OVERRIDES], {
				description: "Override the stored thinking level for this turn. Pi may clamp it to the selected model's supported maximum.",
			})),
			skills: Type.Optional(Type.Array(Type.String({ description: "Skill names or paths for this turn only" }))),
			writeAccess: Type.Optional(Type.Boolean({ description: "Enable bash, edit and write tools for this turn only" })),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}
			if (state.status === "running") {
				return { content: [{ type: "text", text: `Error: Subagent #${args.id} is still running.` }] };
			}
			const skillResolution = resolveSkillPaths(args.skills, ctx.cwd);
			if (skillResolution.error) {
				return { isError: true, content: [{ type: "text", text: skillResolution.error }] };
			}

			state.status = "running";
			state.task = args.prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			spawnAgent(state, args.prompt, ctx, { model: args.model, thinking: args.thinking, skills: skillResolution.paths, writeAccess: args.writeAccess });
			if (state.status === "error") {
				return { isError: true, content: [{ type: "text", text: state.error ?? `Could not continue subagent #${args.id}.` }] };
			}
			ctx.ui.notify(`Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");

			return {
				content: [{ type: "text", text: `Subagent #${args.id} continuing with ${state.model} (${state.thinking} thinking) in background.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		description: "Remove a specific subagent. Kills it if it's currently running.",
		parameters: Type.Object({
			id: Type.Number({ description: "The ID of the subagent to remove" }),
		}),
		execute: async (callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) {
				return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
			}

			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${args.id}`, undefined);
			agents.delete(args.id);

			return {
				content: [{ type: "text", text: `Subagent #${args.id} removed successfully.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		description: "List all active and finished subagents, showing their IDs, tasks, and status.",
		parameters: Type.Object({}),
		execute: async () => {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No active subagents." }] };
			}

			const list = Array.from(agents.values()).map(s =>
				`#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}, ${s.model}, ${s.thinking}) - ${s.task}`
			).join("\n");

			return {
				content: [{ type: "text", text: `Subagents:\n${list}` }],
			};
		},
	});
	// ── /sub [--model <model>] [--thinking <level>] [--skills <list>] [--write] <task> ──

	pi.registerCommand("sub", {
		description: "Spawn a subagent: /sub [--model provider/model] [--thinking level] [--skills a,b] [--write] [--] <task>. Skills and write access apply only to this launch.",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const parsed = parseCommandOptions(args || "");
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const task = parsed.rest;
			if (!task) {
				ctx.ui.notify("Usage: /sub [--model provider/model] [--thinking level] [--skills a,b] [--write] [--] <task>. Skills and write access apply only to this launch.", "error");
				return;
			}
			const skillResolution = resolveSkillPaths(parsed.options.skills, ctx.cwd);
			if (skillResolution.error) {
				ctx.ui.notify(skillResolution.error, "error");
				return;
			}
			parsed.options.skills = skillResolution.paths;

			const id = nextId++;
			const state: SubState = {
				id,
				status: "running",
				task,
				textChunks: [],
				toolCount: 0,
				elapsed: 0,
				sessionFile: makeSessionFile(id),
				turnCount: 1,
				model: "",
				thinking: pi.getThinkingLevel(),
			};
			agents.set(id, state);
			updateWidgets();

			// Fire-and-forget
			spawnAgent(state, task, ctx, parsed.options);
			if (state.status === "error") {
				ctx.ui.notify(state.error ?? `Could not launch subagent #${id}.`, "error");
				return;
			}
			ctx.ui.notify(`Subagent #${id}: ${state.model} (${state.thinking} thinking)`, "info");
		},
	});

	// ── /subcont <id> [--model <model>] [--thinking <level>] [--skills <list>] [--write] <prompt> ──

	pi.registerCommand("subcont", {
		description: "Continue a subagent: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--] <prompt>. Skills and write access apply only to this turn.",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const trimmed = args?.trim() ?? "";
			const idMatch = trimmed.match(/^(\d+)(?:\s+|$)/);
			if (!idMatch) {
				ctx.ui.notify("Usage: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--] <prompt>. Skills and write access apply only to this turn.", "error");
				return;
			}

			const num = parseInt(idMatch[1], 10);
			const parsed = parseCommandOptions(trimmed.slice(idMatch[0].length));
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const prompt = parsed.rest;

			if (!prompt) {
				ctx.ui.notify("Usage: /subcont <id> [--model provider/model] [--thinking level] [--skills a,b] [--write] [--] <prompt>. Skills and write access apply only to this turn.", "error");
				return;
			}

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found. Use /sub to create one.`, "error");
				return;
			}

			if (state.status === "running") {
				ctx.ui.notify(`Subagent #${num} is still running — wait for it to finish first.`, "warning");
				return;
			}
			const skillResolution = resolveSkillPaths(parsed.options.skills, ctx.cwd);
			if (skillResolution.error) {
				ctx.ui.notify(skillResolution.error, "error");
				return;
			}
			parsed.options.skills = skillResolution.paths;

			// Resume: update state for a new turn
			state.status = "running";
			state.task = prompt;
			state.textChunks = [];
			state.elapsed = 0;
			state.turnCount++;
			updateWidgets();

			// Fire-and-forget — reuses the same sessionFile for conversation history
			spawnAgent(state, prompt, ctx, parsed.options);
			if (state.status === "error") {
				ctx.ui.notify(state.error ?? `Could not continue subagent #${num}.`, "error");
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

			const state = agents.get(num);
			if (!state) {
				ctx.ui.notify(`No subagent #${num} found.`, "error");
				return;
			}

			// Kill the process if still running
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
				ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Subagent #${num} removed.`, "info");
			}

			ctx.ui.setWidget(`sub-${num}`, undefined);
			agents.delete(num);
		},
	});

	// ── /subclear ─────────────────────────────────────────────────────────────

	pi.registerCommand("subclear", {
		description: "Clear all subagent widgets",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;

			let killed = 0;
			for (const [id, state] of Array.from(agents.entries())) {
				if (state.proc && state.status === "running") {
					state.proc.kill("SIGTERM");
					killed++;
				}
				ctx.ui.setWidget(`sub-${id}`, undefined);
			}

			const total = agents.size;
			agents.clear();
			nextId = 1;

			const msg = total === 0
				? "No subagents to clear."
				: `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.proc && state.status === "running") {
				state.proc.kill("SIGTERM");
			}
			ctx.ui.setWidget(`sub-${id}`, undefined);
		}
		agents.clear();
		nextId = 1;
		widgetCtx = ctx;
	});
}
