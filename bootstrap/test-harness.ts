/**
 * Host verification harness: isolated Pi state, process supervision and capability reporting for bootstrap tests.
 * Test-support only; nothing here is loaded by the extension at runtime.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Variables that carry provider credentials/endpoints or Herdr/hc identity; never inherited by isolated runs. */
const SENSITIVE = /(^|_)(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$|^AWS_|^AZURE_|^GOOGLE_|^VERTEX_|^CLOUDFLARE_|^OPENAI_|^ANTHROPIC_|^HERDR_|^HC_|^PI_(CODING_AGENT|COMS|BOOTSTRAP|FACTORY)/;

export interface IsolatedPiEnvironment {
	root: string;
	home: string;
	agentDir: string;
	sessionDir: string;
	comsDir: string;
	stateDir: string;
	coordDir: string;
	env: NodeJS.ProcessEnv;
	/** Paths (relative to the fake HOME) that were created by the code under test; any entry means user-level state leaked. */
	homeLeaks(): string[];
	cleanup(): void;
}

function walk(dir: string, base: string, out: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, base, out);
		else out.push(relative(base, full));
	}
	return out.sort();
}

/**
 * Build a child-process environment whose Pi config, trust, session, Coms and bootstrap-state locations are all temp directories.
 * Uses Pi's supported mechanism (`PI_CODING_AGENT_DIR`, which also holds `trust.json`, and `PI_CODING_AGENT_SESSION_DIR`), plus a fake
 * HOME so anything that bypasses them lands in a place the harness can inspect instead of the user's real `~/.pi`.
 */
export function isolatedPiEnvironment(parent: NodeJS.ProcessEnv = process.env): IsolatedPiEnvironment {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-host-"));
	const dirs = {
		home: join(root, "home"), agentDir: join(root, "agent"), sessionDir: join(root, "sessions"),
		comsDir: join(root, "coms"), stateDir: join(root, "bootstrap-state"), coordDir: join(root, "factory-coord"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Deterministic runtime settings: never trust project-local resources (and never prompt), and do not retry refused model calls.
	writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", retry: { enabled: false } }), { mode: 0o600 });
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) if (value !== undefined && !SENSITIVE.test(key)) env[key] = value;
	Object.assign(env, {
		HOME: dirs.home, XDG_CONFIG_HOME: join(dirs.home, ".config"), XDG_DATA_HOME: join(dirs.home, ".local", "share"), XDG_STATE_HOME: join(dirs.home, ".local", "state"),
		PI_CODING_AGENT_DIR: dirs.agentDir, PI_CODING_AGENT_SESSION_DIR: dirs.sessionDir, PI_COMS_DIR: dirs.comsDir, PI_BOOTSTRAP_STATE_DIR: dirs.stateDir,
		PI_FACTORY_COORDINATION_DIR: dirs.coordDir,
		PI_OFFLINE: "1", PI_TELEMETRY: "0", HERDR_ENV: "0",
	});
	return {
		root, ...dirs, env,
		homeLeaks: () => { try { return walk(dirs.home, dirs.home, []); } catch { return []; } },
		cleanup: () => { try { if (statSync(root).isDirectory()) rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ } },
	};
}

// ---- supervised child processes ----

export interface SupervisedOptions {
	timeoutMs: number;
	/** Delay between SIGTERM and SIGKILL once the timeout fires. */
	graceMs?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
}
export interface SupervisedResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }

const liveGroups = new Set<number>();
function killGroup(pgid: number, signal: NodeJS.Signals): void {
	try { process.kill(-pgid, signal); } catch { /* group already gone */ }
}
// Last line of defence: if the test runner itself is torn down (outer timeout, Ctrl+C), take every supervised group with it.
process.once("exit", () => { for (const pgid of liveGroups) killGroup(pgid, "SIGKILL"); });

export interface SpawnedGroup {
	child: ChildProcessWithoutNullStreams;
	/** Resolves when the child (and its pipes) closed. */
	closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** SIGTERM the whole group, SIGKILL after `graceMs`, and wait until the child closed. Idempotent. */
	stop(graceMs?: number): Promise<void>;
}

/**
 * Spawn a command as the leader of its own process group, tracked so it is killed with the test runner on exit.
 * After the child closes, any descendants it left in the group are killed too, so no test leaks background processes.
 * A spawn failure (for example EPERM under a sandbox) throws or emits the original error so callers can classify it.
 */
export function spawnGroup(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): SpawnedGroup {
	const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	const pgid = child.pid;
	if (pgid) liveGroups.add(pgid);
	const reap = () => { if (pgid) { killGroup(pgid, "SIGKILL"); liveGroups.delete(pgid); } };
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", error => { reap(); reject(error); });
		child.once("close", (code, signal) => { reap(); resolve({ code, signal }); });
	});
	closed.catch(() => { /* surfaced to whoever awaits it */ });
	child.stdin.on("error", () => { /* child exited before reading its input */ });
	return {
		child, closed,
		async stop(graceMs = 2000) {
			if (pgid && liveGroups.has(pgid)) {
				killGroup(pgid, "SIGTERM");
				const timer = setTimeout(() => killGroup(pgid, "SIGKILL"), graceMs);
				try { await closed; } catch { /* spawn failure */ } finally { clearTimeout(timer); }
			}
		},
	};
}

/** Run a command to completion in its own process group; on timeout the group is terminated and `timedOut` is set. */
export async function runSupervised(command: string, args: string[], options: SupervisedOptions): Promise<SupervisedResult> {
	const group = spawnGroup(command, args, options);
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	const timer = setTimeout(() => { timedOut = true; void group.stop(options.graceMs); }, options.timeoutMs);
	group.child.stdin.end(options.input ?? "");
	try {
		const { code, signal } = await group.closed;
		return { code, signal, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

// ---- capability reporting ----

export interface Capability { ok: boolean; reason?: string }

/** Turn a low-level failure into a reason that says whether this is the environment (sandbox, read-only, missing tool) or the code. */
export function classifyFailure(error: unknown, what: string): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "EPERM" || code === "EACCES") return `${what} denied by the environment/sandbox (${code}): ${message}`;
	if (code === "EROFS") return `${what} unavailable: read-only file system (EROFS): ${message}`;
	if (code === "ENOENT") return `${what} not found (ENOENT): ${message}`;
	return `${what} failed: ${message}`;
}

/** Can this command be spawned and exit 0? Never throws; a missing capability carries its reason. */
export async function probeCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Capability> {
	try {
		const result = await runSupervised(command, args, { timeoutMs: 15_000, env });
		if (result.timedOut) return { ok: false, reason: `${command} timed out during capability probe` };
		if (result.code !== 0) return { ok: false, reason: `${command} ${args.join(" ")} exit ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}` };
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: classifyFailure(error, command) };
	}
}

/** Can a file be created in this directory (e.g. Pi's trust/config directory)? */
export function probeWritableDir(dir: string): Capability {
	try {
		accessSync(dir, constants.W_OK);
		const probe = join(dir, `.probe-${process.pid}`);
		writeFileSync(probe, "x");
		unlinkSync(probe);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: classifyFailure(error, `directory ${dir}`) };
	}
}

/**
 * Guard a test on an environment capability. Missing capability: the test is skipped with an `UNVERIFIED:` reason, so it never counts as
 * passing coverage. With PI_BOOTSTRAP_TEST_STRICT=1 it throws an infrastructure failure instead (use in release/CI runs).
 * Returns true when the test may proceed; callers must `return` on false.
 */
export function gate(t: { skip: (reason?: string) => void }, capability: Capability, env: NodeJS.ProcessEnv = process.env): boolean {
	if (capability.ok) return true;
	const reason = capability.reason ?? "capability unavailable";
	if (env.PI_BOOTSTRAP_TEST_STRICT === "1") throw new Error(`Infrastructure failure (strict mode): ${reason}`);
	t.skip(`UNVERIFIED: ${reason}`);
	return false;
}

// ---- fake provider ----

export interface RecordedModelCall { method: string; path: string; headers: Record<string, string>; body: string; expected: boolean }
export interface FakeProvider {
	baseUrl: string;
	requests(): RecordedModelCall[];
	unexpectedCalls(): RecordedModelCall[];
	/** Throws with the first unexpected call's details; use after a run that must not have reached any model. */
	assertNoUnexpectedCalls(): void;
	close(): Promise<void>;
}

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key", "cookie", "proxy-authorization"]);

/**
 * Local OpenAI-compatible (chat completions) provider. Calls are served from `replies` in order; any call with no scripted reply is
 * recorded as unexpected and refused with 503, so a test that must never reach a model can prove it did not, and a test that needs a
 * deterministic successful run scripts exactly the replies it expects. Credentials in request headers are not retained.
 */
export async function startFakeProvider(options: { replies?: string[] } = {}): Promise<FakeProvider> {
	const queue = [...(options.replies ?? [])];
	const calls: RecordedModelCall[] = [];
	const server = createServer((request, response) => {
		const parts: Buffer[] = [];
		request.on("data", chunk => parts.push(chunk));
		request.on("end", () => {
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(request.headers)) if (!REDACTED_HEADERS.has(key)) headers[key] = Array.isArray(value) ? value.join(",") : value ?? "";
			const reply = queue.shift();
			calls.push({ method: request.method ?? "", path: request.url ?? "", headers, body: Buffer.concat(parts).toString("utf8"), expected: reply !== undefined });
			if (reply === undefined) {
				response.writeHead(503, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "bootstrap fake provider: unexpected model call", type: "unexpected_call" } }));
				return;
			}
			const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(chunk({ role: "assistant", content: "" }, null));
			response.write(chunk({ content: reply }, null));
			response.write(chunk({}, "stop"));
			response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake provider failed to bind");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests: () => [...calls],
		unexpectedCalls: () => calls.filter(call => !call.expected),
		assertNoUnexpectedCalls() {
			const first = calls.find(call => !call.expected);
			if (first) throw new Error(`Unexpected model call reached the fake provider: ${first.method} ${first.path} ${first.body.slice(0, 200)}`);
		},
		close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
	};
}

/** Pi extension source that registers the fake provider as `bootstrap-fake/model`; load it with `-e` and `--model bootstrap-fake/model`. */
export function fakeProviderExtensionSource(baseUrl: string, options: { markerFile?: string; reasoning?: boolean } = {}): string {
	const marker = options.markerFile
		? `\tpi.on("before_provider_request", () => { writeFileSync(${JSON.stringify(options.markerFile)}, "unexpected"); });\n`
		: "";
	return `${options.markerFile ? 'import { writeFileSync } from "node:fs";\n' : ""}export default function (pi) {
	pi.registerProvider("bootstrap-fake", { baseUrl: ${JSON.stringify(baseUrl)}, apiKey: "test-only", api: "openai-completions", models: [{ id: "model", name: "Bootstrap fake", reasoning: ${options.reasoning ?? false}, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
${marker}}
`;
}
