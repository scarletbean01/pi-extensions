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
			"@sinclair/typebox": `export const Type = { Object: properties => ({ type: "object", properties }), String: options => ({ type: "string", ...options }), Number: options => ({ type: "number", ...options }), Optional: schema => ({ ...schema, optional: true }) };`,
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
	argv: string[];
	cwd: string;
	pid: number;
	env: Record<string, string | undefined>;
}

const fakeRunner = String.raw`import fs from "node:fs";
const record = { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, env: { ...process.env } };
fs.appendFileSync(process.env.FAKE_PI_RECORD_FILE, JSON.stringify(record) + "\n");
process.on("SIGTERM", () => process.exit(143));
for (const line of JSON.parse(process.env.FAKE_PI_EVENTS || "[]")) process.stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n");
if (process.env.FAKE_PI_STDERR) process.stderr.write(process.env.FAKE_PI_STDERR);
setTimeout(() => process.exit(Number(process.env.FAKE_PI_EXIT || "0")), Number(process.env.FAKE_PI_DELAY_MS || "10"));
`;

export function createFakePi(options: { events?: unknown[]; stderr?: string; exitCode?: number; delayMs?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "subagent-widget-test-"));
	const binDir = join(root, "bin");
	const home = join(root, "home");
	const cwd = join(root, "work");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const recordFile = join(root, "invocations.jsonl");
	const runnerFile = join(root, "fake-pi.mjs");
	writeFileSync(runnerFile, fakeRunner);
	const executable = join(binDir, "pi");
	writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerFile)} "$@"\n`);
	chmodSync(executable, 0o755);
	const env = {
		...process.env,
		HOME: home,
		PATH: [binDir, process.env.PATH || "/usr/bin:/bin"].join(delimiter),
		FAKE_PI_RECORD_FILE: recordFile,
		FAKE_PI_EVENTS: JSON.stringify(options.events ?? [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fake result" } },
		]),
		FAKE_PI_STDERR: options.stderr ?? "",
		FAKE_PI_EXIT: String(options.exitCode ?? 0),
		FAKE_PI_DELAY_MS: String(options.delayMs ?? 10),
		SUBAGENT_TEST_MARKER: "preserved-env-value",
	};
	return {
		root, home, cwd, binDir, recordFile, env,
		invocations(): FakeInvocation[] {
			if (!readFileSafe(recordFile)) return [];
			return readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		},
		sessionsDir: join(home, ".pi", "agent", "sessions", "subagents"),
		cleanup() { rmSync(root, { recursive: true, force: true }); },
	};
}

export async function withFakePiEnvironment<T>(fake: ReturnType<typeof createFakePi>, action: () => T | Promise<T>): Promise<T> {
	const keys = ["HOME", "PATH", "FAKE_PI_RECORD_FILE", "FAKE_PI_EVENTS", "FAKE_PI_STDERR", "FAKE_PI_EXIT", "FAKE_PI_DELAY_MS", "SUBAGENT_TEST_MARKER"] as const;
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

export function createFakeHost(extension: (pi: any) => void) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets = new Map<string, any>();
	const widgetCalls: Array<{ key: string; widget: any }> = [];
	let thinkingLevelCalls = 0;
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
		getThinkingLevel() { thinkingLevelCalls++; return "medium"; },
	};
	extension(pi);
	const ctx = {
		model: { provider: "test-provider", id: "test-model" },
		cwd: process.cwd(),
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setWidget(key: string, widget: any) { widgetCalls.push({ key, widget }); if (widget === undefined) widgets.delete(key); else widgets.set(key, widget); },
			setTheme() { return { success: true }; },
		},
	};
	return { tools, commands, handlers, sentMessages, notifications, widgets, widgetCalls, get thinkingLevelCalls() { return thinkingLevelCalls; }, ctx };
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
