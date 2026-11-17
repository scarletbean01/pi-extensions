/**
 * Host verification harness: isolated Pi state, process supervision and capability reporting for bootstrap tests.
 * Test-support only; nothing here is loaded by the extension at runtime.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Variables that carry provider credentials/endpoints or Herdr/hc identity; never inherited by isolated runs. */
const SENSITIVE = /(^|_)(API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$|^AWS_|^AZURE_|^GOOGLE_|^VERTEX_|^CLOUDFLARE_|^OPENAI_|^ANTHROPIC_|^HERDR_|^HC_|^PI_(CODING_AGENT|COMS|BOOTSTRAP)/;

export interface IsolatedPiEnvironment {
	root: string;
	home: string;
	agentDir: string;
	sessionDir: string;
	comsDir: string;
	stateDir: string;
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
		comsDir: join(root, "coms"), stateDir: join(root, "bootstrap-state"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) if (value !== undefined && !SENSITIVE.test(key)) env[key] = value;
	Object.assign(env, {
		HOME: dirs.home, XDG_CONFIG_HOME: join(dirs.home, ".config"), XDG_DATA_HOME: join(dirs.home, ".local", "share"), XDG_STATE_HOME: join(dirs.home, ".local", "state"),
		PI_CODING_AGENT_DIR: dirs.agentDir, PI_CODING_AGENT_SESSION_DIR: dirs.sessionDir, PI_COMS_DIR: dirs.comsDir, PI_BOOTSTRAP_STATE_DIR: dirs.stateDir,
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

/**
 * Run a command in its own process group. On timeout the whole group gets SIGTERM, then SIGKILL after a grace period.
 * After the child exits, any descendants it left in the group are killed too, so no test leaks background processes.
 * A spawn failure (for example EPERM under a sandbox) rejects with the original error so callers can classify it.
 */
export function runSupervised(command: string, args: string[], options: SupervisedOptions): Promise<SupervisedResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		const pgid = child.pid;
		if (pgid) liveGroups.add(pgid);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			if (pgid) killGroup(pgid, "SIGTERM");
			killTimer = setTimeout(() => { if (pgid) killGroup(pgid, "SIGKILL"); }, options.graceMs ?? 2000);
		}, options.timeoutMs);
		child.stdout.on("data", data => { stdout += data.toString(); });
		child.stderr.on("data", data => { stderr += data.toString(); });
		child.once("error", error => {
			clearTimeout(timer); clearTimeout(killTimer);
			if (pgid) { killGroup(pgid, "SIGKILL"); liveGroups.delete(pgid); }
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer); clearTimeout(killTimer);
			if (pgid) { killGroup(pgid, "SIGKILL"); liveGroups.delete(pgid); }
			resolve({ code, signal, stdout, stderr, timedOut });
		});
		child.stdin.on("error", () => { /* child exited before reading its input */ });
		child.stdin.end(options.input ?? "");
	});
}
