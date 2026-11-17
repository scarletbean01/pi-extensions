/**
 * Verification evidence. A check is a command the plan declares; running it through `runCheck` records the real exit status together
 * with a digest of the relevant project state before and after, so a dependency can later tell whether that evidence is still current.
 * Nothing here creates a worktree or a filesystem snapshot: the digest is content-based and the project directory is shared.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicJson, readJson } from "./session-store.ts";
import type { EvidenceRecord } from "./outcomes.ts";

/** A check a node may run. `scope` lists project-relative paths whose content is relevant (default: the whole project). */
export interface CheckSpec { name: string; command: string; scope?: string[]; timeout_ms?: number }
export const CHECK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,59}$/;
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;
export const MAX_CHECK_TIMEOUT_MS = 1_800_000;

export interface VerificationRecord extends EvidenceRecord {
	command: string;
	/** Null when the command did not exit normally (timed out, killed or could not start). */
	exit_code: number | null;
	node_id: string;
	attempt_id: string;
	instance_id: string;
	started_at: string;
	finished_at: string;
	scope?: string[];
	/** Why the project state could not be determined (the digests are then null). */
	unknown_reason?: string;
	output_tail: string;
}

export interface FingerprintLimits { maxFiles: number; maxBytes: number }
const DEFAULT_LIMITS: FingerprintLimits = { maxFiles: 20_000, maxBytes: 200_000_000 };
/** The run's own state and version control are never project content. */
const IGNORED = new Set([".git", "node_modules"]);
const SESSIONS = join(".pi", "agent-sessions");

export type Fingerprint = { digest: string; reason?: undefined } | { digest: null; reason: string };

/**
 * Content digest of the project (or of `scope`'s paths). Untracked files count; modification times do not. A symlink is hashed
 * by its target and never followed. When the relevant state cannot be determined (too large, unreadable, outside the project)
 * the digest is null with the reason, rather than a guess.
 */
export function projectFingerprint(cwd: string, scope?: string[], limits: FingerprintLimits = DEFAULT_LIMITS): Fingerprint {
	const hash = createHash("sha256");
	let files = 0;
	let bytes = 0;
	const take = (path: string): string | undefined => {
		const info = lstatSync(path);
		const name = relative(cwd, path);
		if (info.isSymbolicLink()) { hash.update(`link\0${name}\0${readlinkSync(path)}\n`); return; }
		if (info.isDirectory()) {
			if (name === SESSIONS || IGNORED.has(name.split(sep).pop()!)) return;
			for (const entry of readdirSync(path).sort()) { const problem = take(join(path, entry)); if (problem) return problem; }
			return;
		}
		if (!info.isFile()) return;
		if (++files > limits.maxFiles) return `the project has more than ${limits.maxFiles} files`;
		bytes += info.size;
		if (bytes > limits.maxBytes) return `the project has more than ${limits.maxBytes} bytes`;
		hash.update(`file\0${name}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
	};
	try {
		if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) return { digest: null, reason: "the project directory is unavailable" };
		const roots = [...new Set((scope?.length ? scope : ["."]).map(path => {
			const full = resolve(cwd, path);
			if (isAbsolute(path) || (full !== cwd && !full.startsWith(cwd + sep))) throw new Error(`scope ${JSON.stringify(path)} is outside the project`);
			return full;
		}))].sort();
		for (const root of roots) {
			if (!existsSync(root) && !isLink(root)) { hash.update(`absent\0${relative(cwd, root)}\n`); continue; } // a deletion is a change
			const problem = take(root);
			if (problem) return { digest: null, reason: problem };
		}
		return { digest: hash.digest("hex") };
	} catch (error) { return { digest: null, reason: error instanceof Error ? error.message : String(error) }; }
}

function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

const TAIL = 2000;

/** Run a declared check in the project and record what happened. The command comes from the plan, never from the worker's model. */
export async function runCheck(spec: CheckSpec, context: { cwd: string; node_id: string; attempt_id: string; instance_id: string; signal?: AbortSignal; limits?: FingerprintLimits }): Promise<VerificationRecord> {
	const started_at = new Date().toISOString();
	const before = projectFingerprint(context.cwd, spec.scope, context.limits);
	const timeout = spec.timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS;
	let output = "";
	let timedOut = false;
	const exit_code = await new Promise<number | null>(done => {
		let child;
		try { child = spawn("/bin/sh", ["-c", spec.command], { cwd: context.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
		catch (error) { output = `could not start: ${error instanceof Error ? error.message : String(error)}`; done(null); return; }
		const collect = (data: Buffer) => { output = (output + data.toString()).slice(-TAIL * 2); };
		child.stdout.on("data", collect); child.stderr.on("data", collect);
		const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
		const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
		const abort = () => { output += "\ncheck cancelled"; stop(); };
		context.signal?.addEventListener("abort", abort, { once: true });
		const finish = (code: number | null) => { clearTimeout(timer); context.signal?.removeEventListener("abort", abort); stop(); done(code); };
		child.once("error", error => { output += `\ncould not run: ${error.message}`; finish(null); });
		child.once("close", code => finish(code));
	});
	if (timedOut) output += `\ncheck timed out after ${timeout}ms`;
	const after = projectFingerprint(context.cwd, spec.scope, context.limits);
	const unknown = before.reason ?? after.reason;
	return {
		check: spec.name, command: spec.command, result: exit_code === 0 && !timedOut ? "passed" : "failed", exit_code,
		before: before.digest, after: after.digest, ...(spec.scope?.length ? { scope: spec.scope } : {}), ...(unknown ? { unknown_reason: unknown } : {}),
		node_id: context.node_id, attempt_id: context.attempt_id, instance_id: context.instance_id, started_at, finished_at: new Date().toISOString(), output_tail: output.trim().slice(-TAIL),
	};
}

export const VERIFICATION_VERSION = 1;
export function verificationPath(dir: string, instance: string): string { return join(dir, `${instance}.verification.json`); }

/** All evidence a node recorded, oldest first; none when it recorded nothing. Fails clearly on an unsupported or torn file. */
export function readVerification(path: string): VerificationRecord[] {
	if (!existsSync(path)) return [];
	let raw: any;
	try { raw = readJson<unknown>(path); } catch (error) { throw new Error(`unreadable verification record: ${error instanceof Error ? error.message : String(error)}`); }
	if (raw?.version !== VERIFICATION_VERSION) throw new Error(`Unsupported verification record version ${JSON.stringify(raw?.version)}: this release reads version ${VERIFICATION_VERSION}`);
	if (!Array.isArray(raw.records) || raw.records.some((record: any) => typeof record?.check !== "string" || !["passed", "failed"].includes(record.result))) throw new Error("malformed verification record");
	return raw.records as VerificationRecord[];
}

/** Add a record to the node's history. The single writer is the node's worker, whose tools run one at a time. */
export function appendVerification(path: string, record: VerificationRecord): void {
	atomicJson(path, { version: VERIFICATION_VERSION, records: [...readVerification(path), record] });
}
