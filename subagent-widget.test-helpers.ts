/** Test-only host and executable for subagent-widget.ts. Run with the command in subagent-widget.test.ts. */
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let hooksInstalled = false;
let moduleCounter = 0;

// Pi's extension runtime provides CommonJS require to extensions; plain Node ESM does not.
(globalThis as any).require ??= createRequire(import.meta.url);

export async function loadSubagentWidget() {
	if (!hooksInstalled) {
		const modules: Record<string, string> = {
			"@mariozechner/pi-ai": `export const StringEnum = values => ({ type: "string", values });`,
			"@mariozechner/pi-coding-agent": `export class DynamicBorder { constructor(border) { this.border = border; } render() { return ""; } }`,
			"@mariozechner/pi-tui": `export class Container { children = []; addChild(child) { this.children.push(child); } render() { return this.children.map(child => child.render?.() ?? "").join("\\n").split("\\n"); } invalidate() {} } export class Text { constructor(text) { this.text = text; } setText(text) { this.text = text; } render() { return this.text; } }`,
			"@sinclair/typebox": `export const Type = { Object: properties => ({ type: "object", properties }), String: options => ({ type: "string", ...options }), Number: options => ({ type: "number", ...options }), Boolean: options => ({ type: "boolean", ...options }), Array: items => ({ type: "array", items }), Optional: schema => ({ ...schema, optional: true }) };`,
		};
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (modules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
				return nextResolve(specifier, context);
			},
		});
		hooksInstalled = true;
	}
	return (await import(`./subagent-widget.ts?test=${++moduleCounter}`)).default;
}

export interface FakeInvocation {
	type: "start";
	argv: string[];
	cwd: string;
	pid: number;
	env: Record<string, string | undefined>;
	stdin?: string;
	childExtension?: string;
	docsFilteredPrompt?: string;
}

export interface FakeExit {
	type: "exit";
	pid: number;
	code: number;
	signal: string | null;
}

const fakeRunner = (fixture: { recordFile: string; events: unknown[]; chunks?: string[]; stderr: string; exitCode: number; delayMs: number }) => String.raw`import fs from "node:fs";
const fixture = ${JSON.stringify(fixture)};
const argv = process.argv.slice(2);
const extensionIndex = argv.indexOf("--extension");
const record = { type: "start", argv, cwd: process.cwd(), pid: process.pid, env: { ...process.env }, childExtension: extensionIndex < 0 ? undefined : fs.readFileSync(argv[extensionIndex + 1], "utf8") };
if (extensionIndex >= 0) {
  const { pathToFileURL } = await import("node:url");
  const extension = (await import(pathToFileURL(argv[extensionIndex + 1]).href)).default;
  let beforeAgentStart;
  extension({ on(event, handler) { if (event === "before_agent_start") beforeAgentStart = handler; } });
  record.docsFilteredPrompt = beforeAgentStart({ systemPrompt: "base instructions\n\n<docs>Pi documentation</docs>\n\nother context" })?.systemPrompt;
}
function finish(code, signal = null) {
  fs.appendFileSync(fixture.recordFile, JSON.stringify({ type: "exit", pid: process.pid, code, signal }) + "\n");
  process.exit(code);
}
process.on("SIGTERM", () => finish(143, "SIGTERM"));
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
record.stdin = stdin;
fs.appendFileSync(fixture.recordFile, JSON.stringify(record) + "\n");
const chunks = fixture.chunks ?? fixture.events.map(line => (typeof line === "string" ? line : JSON.stringify(line)) + "\n");
function emitChunk(index) {
  if (index >= chunks.length) {
    if (fixture.stderr) process.stderr.write(fixture.stderr);
    setTimeout(() => finish(fixture.exitCode), fixture.delayMs);
    return;
  }
  process.stdout.write(chunks[index]);
  setTimeout(() => emitChunk(index + 1), 5);
}
emitChunk(0);
`;

export function createFakePi(options: { events?: unknown[]; chunks?: string[]; stderr?: string; exitCode?: number; delayMs?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "subagent-widget-test-"));
	const binDir = join(root, "bin");
	const home = join(root, "home");
	const cwd = join(root, "work");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const recordFile = join(root, "invocations.jsonl");
	const runnerFile = join(root, "fake-pi.mjs");
	writeFileSync(runnerFile, fakeRunner({
		recordFile,
		events: options.events ?? [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fake result" } },
		],
		chunks: options.chunks,
		stderr: options.stderr ?? "",
		exitCode: options.exitCode ?? 0,
		delayMs: options.delayMs ?? 10,
	}));
	const executable = join(binDir, "pi");
	writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerFile)} "$@"\n`);
	chmodSync(executable, 0o755);
	// SUBAGENT_PI_BINARY is the explicit resolver seam used by this test harness to select the fake executable.
	// It is set only in the parent fixture; the extension removes it from the spawned child's environment.
	const env = {
		HOME: home,
		PATH: [binDir, process.env.PATH || "/usr/bin:/bin"].join(delimiter),
		SUBAGENT_PI_BINARY: executable,
		SUBAGENT_TEST_MARKER: "preserved-env-value",
		HTTP_PROXY: "http://proxy-http.example:8080",
		HTTPS_PROXY: "http://proxy.example:8080",
		NO_PROXY: "localhost,.example.test",
		NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
		SSL_CERT_FILE: "/fixture/ssl-cert.pem",
		COPILOT_GITHUB_TOKEN: "fixture-copilot-token",
		CUSTOM_PROVIDER_KEY: "fixture-custom-provider-key",
		PI_CACHE_RETENTION: "long",
		LANG: "en_US.UTF-8",
		AI_AGENT: "pi",
		PI_CODING_AGENT: "true",
		PI_SESSION_ID: "parent-session-id",
		PI_SESSION_FILE: "/parent/session.jsonl",
		PI_PROVIDER: "parent-provider",
		PI_MODEL: "parent-model",
		PI_REASONING_LEVEL: "high",
	};
	return {
		root, home, cwd, binDir, recordFile, env,
		invocations(): FakeInvocation[] {
			if (!readFileSafe(recordFile)) return [];
			return readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === "start");
		},
		exits(): FakeExit[] {
			if (!readFileSafe(recordFile)) return [];
			return readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(record => record.type === "exit");
		},
		sessionsDir: join(home, ".pi", "agent", "sessions", "subagents"),
		cleanup() {
			for (const { pid } of this.invocations()) {
				try { process.kill(pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export async function withFakePiEnvironment<T>(fake: ReturnType<typeof createFakePi>, action: () => T | Promise<T>): Promise<T> {
	// Invariant: extension handlers spawn synchronously before returning, and node:test runs these cases one at a time.
	const keys = Object.keys(fake.env);
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) process.env[key] = fake.env[key];
	try { return await action(); }
	finally {
		for (const key of keys) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

function readFileSafe(path: string) {
	try { return readFileSync(path); } catch { return undefined; }
}

export function createFakeHost(extension: (pi: any) => void, cwd = process.cwd()) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets = new Map<string, any>();
	const widgetCalls: Array<{ key: string; widget: any }> = [];
	const activeToolCalls: Array<{ method: "getActiveTools" | "setActiveTools"; names?: string[] }> = [];
	const availableCommands: any[] = [];
	let activeTools: string[] = [];
	let thinkingLevelCalls = 0;
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
		getThinkingLevel() { thinkingLevelCalls++; return "medium"; },
		getActiveTools() { activeToolCalls.push({ method: "getActiveTools" }); return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; activeToolCalls.push({ method: "setActiveTools", names: [...names] }); },
		getCommands() { return [...availableCommands]; },
	};
	extension(pi);
	const ctx = {
		model: { provider: "test-provider", id: "test-model" },
		cwd,
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setWidget(key: string, widget: any) { widgetCalls.push({ key, widget }); if (widget === undefined) widgets.delete(key); else widgets.set(key, widget); },
			setTheme() { return { success: true }; },
		},
	};
	return {
		tools, commands, handlers, sentMessages, notifications, widgets, widgetCalls, activeToolCalls,
		get thinkingLevelCalls() { return thinkingLevelCalls; },
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: string[]) => pi.setActiveTools(names),
		getWidgetFactory: (key: string) => widgets.get(key),
		addPiCommand: (command: any) => availableCommands.push(command),
		emit: async (event: string, payload: any) => Promise.all((handlers.get(event) ?? []).map(handler => handler(payload, ctx))),
		ctx,
	};
}

export async function waitFor<T>(read: () => T | undefined, message: string, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail(`Timed out waiting for ${message}`);
}

export function getOption(argv: string[], name: string) {
	const index = argv.indexOf(name);
	return index < 0 ? undefined : argv[index + 1];
}
