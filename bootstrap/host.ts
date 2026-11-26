/** Host seam and backend selection (ADR 0004, HOST.md). */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";
import { HOST_BACKENDS, hostBackendOf, type HostBackendName, type HostNodeRef } from "./host-backend.ts";
import { HcHost } from "./host-hc.ts";
import { HerdrHost } from "./host-herdr.ts";
import type { PaneWakeRequest, PaneWakeResult } from "./pane-wake.ts";

export { HOST_BACKENDS, hostBackendOf, type HostBackendName, type HostNodeRef };

const PORTABLE_WORD = /^[A-Za-z0-9_./+-]+$/;

/**
 * The command typed into the pane's interactive shell (bash, zsh, fish, ...). It must need no quoting,
 * because quoting rules differ between shells (fish treats backslashes in single quotes as escapes).
 * Falls back to the cwd-relative path, which is always portable: the tab is created with --cwd.
 */
export function launchCommand(cwd: string, launcher: string): string {
	if (PORTABLE_WORD.test(launcher)) return `/bin/sh ${launcher}`;
	const relative = launcher.startsWith(cwd + sep) ? launcher.slice(cwd.length + 1) : undefined;
	if (relative && PORTABLE_WORD.test(relative)) return `/bin/sh ./${relative}`;
	throw new Error(`Launcher path cannot be typed portably into a shell: ${launcher}`);
}

export interface HostLaunchNodeRequest {
	name: string;
	runId?: string;
	instanceId?: string;
	directory: string;
	launcher: string;
	environment: Record<string, string>;
	preflight: HostPreflightResult;
	onUpdate?: (partial: HostNodeLaunchPartial) => void;
}

export interface HostNodeHandle {
	host_ref: HostNodeRef;
	tab_id?: string;
	pane_id?: string;
	terminal_id?: string;
}

export interface HostNodeTarget {
	run_id?: string;
	node_id: string;
	persona_name: string;
	kind?: "agent" | "command";
	instance_id: string;
	label: string;
	tab_id?: string;
	pane_id?: string;
	terminal_id?: string;
	host_ref?: HostNodeRef;
}

export type HostNodeExistence =
	| { state: "present"; ref?: HostNodeRef }
	| { state: "gone"; reason?: string }
	| { state: "ambiguous"; reason: string };

export type HostCloseResult =
	| { outcome: "closed" }
	| { outcome: "already_gone"; note: string };

export interface HostDiscoveredNode {
	target: HostNodeTarget;
	existence: HostNodeExistence;
}

export type HostWakeRequest = PaneWakeRequest;
export type HostWakeResult = PaneWakeResult;

export interface Host {
	readonly backend: HostBackendName;
	checkAvailable(options?: { requireContext?: boolean }): void;
	preflight(signal?: AbortSignal): Promise<HostPreflightResult>;
	launchNode(request: HostLaunchNodeRequest, signal?: AbortSignal): Promise<HostNodeHandle>;
	nodeExists(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostNodeExistence>;
	closeNode(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostCloseResult>;
	sendWakeUp(request: HostWakeRequest): Promise<HostWakeResult>;
	discoverOwnedNodes(nodes: ReadonlyArray<HostNodeTarget>, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostDiscoveredNode[]>;
	createDiscoveryContext?(): unknown;
}

export interface HostSelectionResult {
	backend: HostBackendName;
	source: "explicit" | "context" | "probe";
}

export type HcCoreProbe = (env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<boolean>;

export function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = resolve(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch { /* try next */ }
	}
	return undefined;
}

export function executableOnPath(name: string, env: NodeJS.ProcessEnv): string {
	const found = findExecutableOnPath(name, env);
	if (found) return found;
	throw new Error(`Required executable "${name}" was not found on PATH`);
}

/**
 * Resolve backend from explicit `PI_BOOTSTRAP_HOST` or calling context (`HC_TERMINAL_ID`, or `HERDR_ENV=1` + `HERDR_PANE_ID`).
 * Returns `undefined` when neither an override nor a Host context is present.
 */
export function resolveExplicitOrContextHost(env: NodeJS.ProcessEnv): HostSelectionResult | undefined {
	if (env.PI_BOOTSTRAP_HOST !== undefined) {
		const explicit = env.PI_BOOTSTRAP_HOST.trim();
		if (explicit === "herdr" || explicit === "hc") {
			return { backend: explicit, source: "explicit" };
		}
		throw new Error(`Invalid PI_BOOTSTRAP_HOST=${JSON.stringify(env.PI_BOOTSTRAP_HOST)}: expected "herdr" or "hc"`);
	}
	const hasHcContext = typeof env.HC_TERMINAL_ID === "string" && env.HC_TERMINAL_ID.trim().length > 0 && !env.HC_TERMINAL_ID.includes("\0");
	if (hasHcContext) {
		return { backend: "hc", source: "context" };
	}
	const hasHerdrContext = env.HERDR_ENV === "1"
		&& typeof env.HERDR_PANE_ID === "string"
		&& env.HERDR_PANE_ID.trim().length > 0
		&& !env.HERDR_PANE_ID.includes("\0");
	if (hasHerdrContext) {
		return { backend: "herdr", source: "context" };
	}
	return undefined;
}

function spawnHcServerStatusProbe(
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
	timeoutMs = 5_000,
): Promise<boolean> {
	const hcPath = findExecutableOnPath("hc", env);
	if (!hcPath) return Promise.resolve(false);
	return new Promise(resolveProbe => {
		if (signal?.aborted) {
			resolveProbe(false);
			return;
		}
		let settled = false;
		let stdout = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(hcPath, ["server", "status", "--json"], {
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			try { child.stdout?.destroy(); } catch { /* ignore */ }
			resolveProbe(ok);
		};
		const terminate = () => {
			if (settled) return;
			try { child.kill("SIGTERM"); } catch { /* exited */ }
			killTimer = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* exited */ }
			}, 250);
			killTimer.unref?.();
			// Hard deadline so a background grandchild holding stdout open cannot hang selection.
			deadlineTimer = setTimeout(() => finish(false), 300);
			deadlineTimer.unref?.();
		};
		const onAbort = () => terminate();
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(terminate, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
		child.once("error", () => finish(false));
		child.once("close", code => {
			if (code !== 0) {
				finish(false);
				return;
			}
			const trimmed = stdout.trim();
			if (trimmed) {
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
						finish(false);
						return;
					}
				} catch {
					finish(false);
					return;
				}
			}
			finish(true);
		});
	});
}

/**
 * Select the Host backend using the contract rules:
 * 1. Explicit `PI_BOOTSTRAP_HOST` (`"hc"` or `"herdr"`; anything else is an error).
 * 2. Calling context (`HC_TERMINAL_ID` -> `"hc"`; `HERDR_ENV=1` with `HERDR_PANE_ID` -> `"herdr"`; `hc` wins if both).
 * 3. With neither, `"hc"` if `hc` is on `PATH` and its core answers; else a clear failure naming both `hc` and `herdr`.
 */
export async function selectHostBackend(
	env: NodeJS.ProcessEnv,
	options: { probeHc?: HcCoreProbe; signal?: AbortSignal; probeTimeoutMs?: number } = {},
): Promise<HostSelectionResult> {
	const immediate = resolveExplicitOrContextHost(env);
	if (immediate) return immediate;

	const probe = options.probeHc ?? ((probeEnv, probeSignal) => spawnHcServerStatusProbe(probeEnv, probeSignal, options.probeTimeoutMs));
	if (await probe(env, options.signal)) {
		return { backend: "hc", source: "probe" };
	}

	if (env.HERDR_ENV === "1") {
		throw new Error(
			"Bootstrap must run inside a Herdr-managed pane (HERDR_ENV=1 requires a non-empty HERDR_PANE_ID) " +
			"when using Herdr, and no reachable hc (herdr-core) server on PATH was found. " +
			"Set HERDR_PANE_ID, start an hc core, or set PI_BOOTSTRAP_HOST=herdr|hc.",
		);
	}

	throw new Error(
		"No Host backend is available: neither an active Host context (HC_TERMINAL_ID for hc, or HERDR_ENV=1 with HERDR_PANE_ID for herdr) " +
		"nor a reachable hc (herdr-core) server on PATH was found. Run inside Herdr or hc, start an hc core, or set PI_BOOTSTRAP_HOST=herdr|hc.",
	);
}

export function requireSupportedHost(selection: HostSelectionResult): HostBackendName {
	return selection.backend;
}

export function createHost(
	backend: HostBackendName,
	options: { exec: HostExecutor; env: NodeJS.ProcessEnv },
): Host {
	if (backend === "hc") {
		return new HcHost(options);
	}
	return new HerdrHost(options);
}
