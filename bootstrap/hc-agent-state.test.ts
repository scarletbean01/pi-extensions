import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bootstrapDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(bootstrapDir);
const extensionPath = join(repoRoot, "hc-agent-state.ts");
const childPath = join(bootstrapDir, "test-support", "hc-agent-state-child.ts");

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function runExtension(events: unknown[], env: Record<string, string>, extension = extensionPath): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", childPath, extension], {
			cwd: repoRoot,
			env: { ...process.env, HC_AGENT_STATE_TEST_EVENTS: JSON.stringify(events), ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.on("error", error => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
		});
	});
}

function assertChildSucceeded(result: ChildResult) {
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.signal, null);
}

test("hc status reports Pi lifecycle and direction waits as exact OSC 7501 bytes", async () => {
	const result = await runExtension([
		{ name: "session_start", event: { reason: "startup" }, context: { mode: "tui", idle: true } },
		{ name: "agent_start" },
		{ name: "agent_start" },
		{ name: "tool_execution_start", event: { toolName: "bootstrap_request_direction", toolCallId: "direction-1" } },
		{ name: "tool_execution_end", event: { toolName: "bootstrap_request_direction", toolCallId: "direction-1" } },
		{ name: "agent_settled", context: { idle: true } },
		{ name: "session_shutdown", event: { reason: "quit" } },
	], { HC_TERMINAL_ID: "t1" });
	assertChildSucceeded(result);
	assert.match(result.stderr, /^registrations=[1-9]\d*\n$/);
	assert.equal(result.stdout,
		"\x1b]7501;state=idle:app=pi\x1b\\" +
		"\x1b]7501;state=working:app=pi\x1b\\" +
		"\x1b]7501;state=blocked:app=pi:kind=question\x1b\\" +
		"\x1b]7501;state=working:app=pi\x1b\\" +
		"\x1b]7501;state=idle:app=pi\x1b\\" +
		"\x1b]7501;state=done:app=pi\x1b\\");
	assert.doesNotMatch(result.stdout, /(?:^|:)msg=|(?:^|:)title=/);
	assert.match(result.stdout, /^(?:\x1b\]7501;state=(?:working|idle|blocked|done):app=pi(?::kind=(?:permission|question|auth))?\x1b\\)+$/);
});

test("blocking Pi prompts report question or permission and return to the active turn", async () => {
	const result = await runExtension([
		{ name: "session_start", context: { mode: "tui", idle: true } },
		{ name: "agent_start" },
		{ name: "ui_prompt_start", event: { reason: "ui_prompt", kind: "select" } },
		{ name: "ui_prompt_end", event: { reason: "ui_prompt", kind: "select" } },
		{ name: "ui_prompt_start", event: { reason: "ui_prompt", kind: "confirm" } },
		{ name: "ui_prompt_end", event: { reason: "ui_prompt", kind: "confirm" } },
		{ name: "agent_settled", context: { idle: true } },
		{ name: "session_shutdown", event: { reason: "quit" } },
	], { HC_TERMINAL_ID: "t1" });
	assertChildSucceeded(result);
	assert.equal(result.stdout,
		"\x1b]7501;state=idle:app=pi\x1b\\" +
		"\x1b]7501;state=working:app=pi\x1b\\" +
		"\x1b]7501;state=blocked:app=pi:kind=question\x1b\\" +
		"\x1b]7501;state=working:app=pi\x1b\\" +
		"\x1b]7501;state=blocked:app=pi:kind=permission\x1b\\" +
		"\x1b]7501;state=working:app=pi\x1b\\" +
		"\x1b]7501;state=idle:app=pi\x1b\\" +
		"\x1b]7501;state=done:app=pi\x1b\\");
});

test("without HC_TERMINAL_ID the extension registers no handlers or output", async () => {
	const events = [
		{ name: "session_start", context: { mode: "tui", idle: true } },
		{ name: "agent_start" },
		{ name: "session_shutdown" },
	];
	for (const env of [
		{ HC_TERMINAL_ID: "", HERDR_ENV: "", HERDR_PANE_ID: "", HC_RUNTIME: "" },
		{ HC_TERMINAL_ID: "", HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", HC_RUNTIME: "1" },
	]) {
		const result = await runExtension(events, env);
		assertChildSucceeded(result);
		assert.equal(result.stderr, "registrations=0\n");
		assert.equal(result.stdout, "");
	}
});

test("HC status does not write to stdout in Pi's headless modes", async () => {
	const result = await runExtension([
		{ name: "session_start", context: { mode: "rpc", idle: true } },
		{ name: "agent_start" },
		{ name: "session_shutdown", event: { reason: "quit" } },
	], { HC_TERMINAL_ID: "t1" });
	assertChildSucceeded(result);
	assert.match(result.stderr, /^registrations=[1-9]\d*\n$/);
	assert.equal(result.stdout, "");
});

test("extension source contains no rejected OSC keys and Herdr-managed source is unchanged", () => {
	const extensionSource = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(extensionSource, /msg=/);
	assert.doesNotMatch(extensionSource, /title=/);
	const bootstrapReadme = readFileSync(join(bootstrapDir, "README.md"), "utf8");
	const hostContract = readFileSync(join(bootstrapDir, "HOST.md"), "utf8");
	assert.match(bootstrapReadme, /hc-agent-state\.ts/);
	assert.match(bootstrapReadme, /settings\.json/);
	assert.match(bootstrapReadme, /Reports are advisory/);
	assert.match(hostContract, /hc-agent-state\.ts/);
	assert.match(hostContract, /extension's behavior inside a real hc terminal with a real Pi agent is not live-tested/i);
	assert.doesNotThrow(() => {
		execFileSync("git", ["diff", "--quiet", "feature/host-backends", "--", "herdr-agent-state.ts"], { cwd: repoRoot });
	});
});
