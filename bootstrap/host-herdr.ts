/** Herdr Host backend implementation (HOST.md). All `herdr` CLI interactions live here. */
import { spawn } from "node:child_process";
import {
	executableOnPath,
	launchCommand,
	type Host,
	type HostCloseResult,
	type HostDiscoveredNode,
	type HostExecutor,
	type HostLaunchNodeRequest,
	type HostNodeExistence,
	type HostNodeHandle,
	type HostNodeTarget,
	type HostPreflightResult,
	type HostWakeRequest,
	type HostWakeResult,
} from "./host.ts";
import { tryPaneWake } from "./pane-wake.ts";
import { checkAbort, errorMessage, isRecord, nodeLabel } from "./session-store.ts";

const DEFAULT_HERDR_TIMEOUT_MS = 15_000;

export interface HerdrHostRef extends Record<string, unknown> {
	tab_id?: string;
	pane_id?: string;
	terminal_id?: string;
	label: string;
}

interface LiveTopology {
	tabs: any[];
	panes: any[];
}

interface HerdrDiscoveryContext {
	useSnapshot: boolean;
	live?: LiveTopology;
}

export interface PaneWakeExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	killed?: boolean;
	error?: NodeJS.ErrnoException;
}

export type PaneWakeExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<PaneWakeExecResult>;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty string without NUL characters`);
	}
	return value;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") ? value : undefined;
}

function buildHerdrHostRef(fields: { tab_id?: string; pane_id?: string; terminal_id?: string; label: string }): HerdrHostRef {
	return {
		...(fields.tab_id !== undefined ? { tab_id: fields.tab_id } : {}),
		...(fields.pane_id !== undefined ? { pane_id: fields.pane_id } : {}),
		...(fields.terminal_id !== undefined ? { terminal_id: fields.terminal_id } : {}),
		label: fields.label,
	};
}

export function defaultHerdrExec(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PaneWakeExecResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HERDR_TIMEOUT_MS;
	return new Promise(resolve => {
		if (options.signal?.aborted) {
			resolve({ code: null, stdout: "", stderr: "Aborted", killed: true });
			return;
		}
		let settled = false;
		let killed = false;
		let stdout = "";
		let stderr = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(command, args, {
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: PaneWakeExecResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const terminate = () => {
			if (killed || settled) return;
			killed = true;
			try { child.kill("SIGTERM"); } catch { /* exited */ }
			killTimer = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* exited */ }
			}, 1000);
			killTimer.unref?.();
		};
		const onAbort = () => terminate();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(terminate, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
		child.once("error", err => finish({ code: null, stdout, stderr: err.message, killed, error: err }));
		child.once("close", code => finish({ code, stdout, stderr, killed }));
	});
}

export function commandFailureDetail(res: PaneWakeExecResult): string {
	if (res.error) return res.error.message;
	if (res.killed) return "timed out or aborted";
	return (res.stderr || res.stdout || `exit ${res.code ?? "null"}`).trim().slice(0, 300);
}

function isPaneNotFoundError(detail: string): boolean {
	return /(?:pane[_ ]not[_ ]found|unknown[_ ]pane|no[_ ]such[_ ]pane|\bpane(?:\s+(?:id\s+)?["'`]?[a-zA-Z0-9_.:-]+["'`]?)?\s+(?:is\s+|was\s+)?(?:not[_ ]found|does not exist)\b)/i.test(detail);
}

async function runHerdrExec(
	exec: PaneWakeExec,
	args: string[],
	opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<PaneWakeExecResult> {
	try {
		return await exec("herdr", args, opts);
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		return { code: null, stdout: "", stderr: err.message, error: err as NodeJS.ErrnoException };
	}
}

export async function checkHerdrPaneExists(
	exec: PaneWakeExec,
	paneId: string,
	execOpts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true } | { ok: false; outcome: "skipped" | "failed"; reason: string }> {
	const getRes = await runHerdrExec(exec, ["pane", "get", paneId], execOpts);
	if (getRes.error) {
		return { ok: false, outcome: "failed", reason: `failed to run herdr pane get: ${getRes.error.message}` };
	}
	if (getRes.killed) {
		return { ok: false, outcome: "failed", reason: `herdr pane get ${paneId} timed out or was aborted` };
	}
	if (getRes.code !== 0) {
		const detail = commandFailureDetail(getRes);
		if (isPaneNotFoundError(detail)) {
			return { ok: false, outcome: "skipped", reason: `pane ${paneId} does not exist (${detail})` };
		}
		return { ok: false, outcome: "failed", reason: `herdr pane get ${paneId} failed (exit ${getRes.code ?? "null"}): ${detail}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(getRes.stdout);
	} catch {
		return { ok: false, outcome: "failed", reason: `herdr pane get ${paneId} returned invalid JSON` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, outcome: "failed", reason: `herdr pane get ${paneId} returned invalid response` };
	}
	if (parsed.error) {
		const errDetail = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error).slice(0, 300);
		if (isPaneNotFoundError(errDetail)) {
			return { ok: false, outcome: "skipped", reason: `pane ${paneId} does not exist (${errDetail})` };
		}
		return { ok: false, outcome: "failed", reason: `herdr pane get ${paneId} failed: ${errDetail}` };
	}
	const payload = isRecord(parsed.result) ? parsed.result : parsed;
	const pane = isRecord(payload) ? payload.pane : undefined;
	if (!isRecord(pane) || (pane.pane_id !== undefined && pane.pane_id !== paneId)) {
		return { ok: false, outcome: "skipped", reason: `Herdr did not report pane ${paneId} as existing` };
	}
	return { ok: true };
}

export async function sendHerdrPaneText(
	exec: PaneWakeExec,
	paneId: string,
	text: string,
	execOpts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const textRes = await runHerdrExec(exec, ["pane", "send-text", paneId, text], execOpts);
	if (textRes.error || textRes.killed || textRes.code !== 0) {
		return { ok: false, reason: `herdr pane send-text ${paneId} failed: ${commandFailureDetail(textRes)}` };
	}
	return { ok: true };
}

export async function sendHerdrPaneEnter(
	exec: PaneWakeExec,
	paneId: string,
	execOpts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ ok: true } | { ok: false; commandLabel: string; detail: string }> {
	const res = await runHerdrExec(exec, ["pane", "send-keys", paneId, "Enter"], execOpts);
	if (res.error || res.killed || res.code !== 0) {
		return {
			ok: false,
			commandLabel: "herdr pane send-keys",
			detail: commandFailureDetail(res),
		};
	}
	return { ok: true };
}

export class HerdrHost implements Host {
	readonly backend = "herdr" as const;
	private readonly exec: HostExecutor;
	private readonly env: NodeJS.ProcessEnv;

	constructor(options: { exec: HostExecutor; env: NodeJS.ProcessEnv }) {
		this.exec = options.exec;
		this.env = options.env;
	}

	private async command(args: string[], signal?: AbortSignal): Promise<string> {
		checkAbort(signal);
		const result = await this.exec("herdr", args, { signal, timeout: DEFAULT_HERDR_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
		if (result.code !== 0 || result.killed || result.truncated) {
			throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed${result.killed ? " (cancelled or timed out; outcome may be ambiguous)" : ""}: ${(result.stderr || result.stdout || `exit ${result.code}`).slice(0, 3000)}`);
		}
		return result.stdout;
	}

	private async json(args: string[], signal?: AbortSignal): Promise<any> {
		const output = await this.command(args, signal);
		let parsed: any;
		try { parsed = JSON.parse(output); } catch { throw new Error(`herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`); }
		if (!parsed || typeof parsed !== "object" || parsed.error) throw new Error(`herdr API error: ${JSON.stringify(parsed?.error ?? parsed).slice(0, 1000)}`);
		return parsed.result ?? parsed;
	}

	checkAvailable(options: { requireContext?: boolean } = {}): void {
		executableOnPath("herdr", this.env);
		if (options.requireContext) {
			if (this.env.HERDR_ENV !== "1") throw new Error("Bootstrap must run inside a Herdr-managed pane (HERDR_ENV=1)");
			requiredString(this.env.HERDR_PANE_ID, "HERDR_PANE_ID");
		}
	}

	async preflight(signal?: AbortSignal): Promise<HostPreflightResult> {
		this.checkAvailable({ requireContext: true });
		const paneId = requiredString(this.env.HERDR_PANE_ID, "HERDR_PANE_ID");
		const response = await this.json(["pane", "get", paneId], signal);
		const workspaceId = requiredString(response.pane?.workspace_id, "Originating pane workspace_id");
		// Never substitute the currently focused workspace for the caller's workspace.
		return { backend: "herdr", workspace_id: workspaceId };
	}

	async launchNode(request: HostLaunchNodeRequest, signal?: AbortSignal): Promise<HostNodeHandle> {
		const envArgs = Object.entries(request.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
		const created = await this.json([
			"tab", "create",
			"--workspace", request.preflight.workspace_id,
			"--label", request.name,
			"--cwd", request.directory,
			"--no-focus",
			...envArgs,
		], signal);

		// Preserve every known ID even if the rest of the response is malformed.
		const rawTabId = asNonEmptyString(created.tab?.tab_id);
		const rawPaneId = asNonEmptyString(created.root_pane?.pane_id);
		const rawTerminalId = asNonEmptyString(created.root_pane?.terminal_id);
		if (rawTabId !== undefined || rawPaneId !== undefined || rawTerminalId !== undefined) {
			request.onUpdate?.({
				...(rawTabId !== undefined ? { tab_id: rawTabId } : {}),
				...(rawPaneId !== undefined ? { pane_id: rawPaneId } : {}),
				...(rawTerminalId !== undefined ? { terminal_id: rawTerminalId } : {}),
				host_ref: buildHerdrHostRef({ tab_id: rawTabId, pane_id: rawPaneId, terminal_id: rawTerminalId, label: request.name }),
			});
		}

		const paneId = requiredString(created.root_pane?.pane_id, "Created root pane_id");
		const terminalId = requiredString(created.root_pane?.terminal_id, "Created terminal_id");
		const tabId = requiredString(rawTabId, "Created tab_id");
		const hostRef = buildHerdrHostRef({ tab_id: tabId, pane_id: paneId, terminal_id: terminalId, label: request.name });
		request.onUpdate?.({ tab_id: tabId, pane_id: paneId, terminal_id: terminalId, host_ref: hostRef, phase: "created" });

		await this.command(["pane", "run", paneId, launchCommand(request.directory, request.launcher)], signal);
		request.onUpdate?.({ tab_id: tabId, pane_id: paneId, terminal_id: terminalId, host_ref: hostRef, phase: "submitted" });

		return {
			host_ref: hostRef,
			tab_id: tabId,
			pane_id: paneId,
			terminal_id: terminalId,
		};
	}

	createDiscoveryContext(): HerdrDiscoveryContext {
		return { useSnapshot: true };
	}

	private asDiscoveryContext(discoveryContext?: unknown): HerdrDiscoveryContext {
		if (discoveryContext && typeof discoveryContext === "object" && "useSnapshot" in discoveryContext) {
			return discoveryContext as HerdrDiscoveryContext;
		}
		return this.createDiscoveryContext();
	}

	/**
	 * Live tabs and panes across every workspace. Prefers one `herdr api snapshot` call; older Herdr
	 * servers fall back to explicit per-workspace listings (fetched concurrently).
	 */
	private async topology(ctx: HerdrDiscoveryContext, signal?: AbortSignal): Promise<LiveTopology> {
		if (ctx.useSnapshot) {
			try {
				const response = await this.json(["api", "snapshot"], signal);
				const snapshot = response.snapshot ?? response;
				if (Array.isArray(snapshot.tabs) && Array.isArray(snapshot.panes) && Array.isArray(snapshot.workspaces)) {
					return { tabs: snapshot.tabs, panes: snapshot.panes };
				}
			} catch { checkAbort(signal); }
			ctx.useSnapshot = false; // Unsupported or malformed: do not retry it for every agent.
		}
		const workspaces = await this.json(["workspace", "list"], signal);
		if (!Array.isArray(workspaces.workspaces)) throw new Error("Invalid workspace-list response");
		const listings = await Promise.all(workspaces.workspaces.map(async (workspace: any) => {
			const id = requiredString(workspace.workspace_id, "Live workspace_id");
			const [tabs, panes] = await Promise.all([
				this.json(["tab", "list", "--workspace", id], signal),
				this.json(["pane", "list", "--workspace", id], signal),
			]);
			if (!Array.isArray(tabs.tabs)) throw new Error("Invalid tab-list response");
			if (!Array.isArray(panes.panes)) throw new Error("Invalid pane-list response");
			return { tabs: tabs.tabs as any[], panes: panes.panes as any[] };
		}));
		return {
			tabs: listings.flatMap(listing => listing.tabs),
			panes: listings.flatMap(listing => listing.panes),
		};
	}

	private resolveNodeOwnership(live: LiveTopology, node: HostNodeTarget): { ownedTabId?: string; ownedPaneId?: string; terminalId?: string; label: string } {
		const ref = isRecord(node.host_ref) ? node.host_ref : undefined;
		const label = node.label || asNonEmptyString(ref?.label) || `${node.instance_id}`;
		const terminalId = node.terminal_id ?? asNonEmptyString(ref?.terminal_id);
		const { tabs, panes: livePanes } = live;
		const matches = tabs.filter((tab: any) => tab.label === label);
		if (matches.length > 1) throw new Error(`Ambiguous ownership label ${label}`);
		let ownedTabId: string | undefined;
		let ownedPaneId: string | undefined;
		if (terminalId) {
			const owned = livePanes.filter((pane: any) => pane.terminal_id === terminalId);
			if (owned.length > 1) throw new Error(`Ambiguous terminal ownership for ${nodeLabel(node)}`);
			if (owned.length === 1) {
				ownedTabId = requiredString(owned[0].tab_id, "Owned tab_id");
				// A user may have renamed the tab, moved our terminal, or added unrelated panes.
				// Close only our pane in that case, never the surrounding user-owned tab.
				if (matches[0]?.tab_id !== ownedTabId || livePanes.filter((pane: any) => pane.tab_id === ownedTabId).length !== 1) {
					ownedPaneId = requiredString(owned[0].pane_id, "Owned pane_id");
				}
			} else if (matches.length) {
				throw new Error(`Terminal ownership mismatch for ${nodeLabel(node)}; tab may have been replaced`);
			}
		} else if (matches.length === 1) {
			ownedTabId = requiredString(matches[0].tab_id, "Owned tab_id");
		}
		return { ownedTabId, ownedPaneId, terminalId, label };
	}

	private evaluateExistence(live: LiveTopology, node: HostNodeTarget): HostNodeExistence {
		try {
			const { ownedTabId, ownedPaneId, terminalId, label } = this.resolveNodeOwnership(live, node);
			if (ownedPaneId || ownedTabId) {
				return {
					state: "present",
					ref: buildHerdrHostRef({
						...(ownedTabId ? { tab_id: ownedTabId } : {}),
						...(ownedPaneId ? { pane_id: ownedPaneId } : {}),
						...(terminalId ? { terminal_id: terminalId } : {}),
						label,
					}),
				};
			}
			return { state: "gone" };
		} catch (error) {
			return { state: "ambiguous", reason: errorMessage(error) };
		}
	}

	async nodeExists(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostNodeExistence> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		ctx.live ??= await this.topology(ctx, signal);
		return this.evaluateExistence(ctx.live, node);
	}

	async discoverOwnedNodes(nodes: ReadonlyArray<HostNodeTarget>, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostDiscoveredNode[]> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		ctx.live ??= await this.topology(ctx, signal);
		const live = ctx.live;
		return nodes.map(target => ({
			target,
			existence: this.evaluateExistence(live, target),
		}));
	}

	async closeNode(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostCloseResult> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		// A live view stays valid until we close something (public tab/pane IDs may compact after a close).
		ctx.live ??= await this.topology(ctx, signal);
		const { ownedTabId, ownedPaneId } = this.resolveNodeOwnership(ctx.live, node);
		if (ownedPaneId || ownedTabId) {
			// Whatever the outcome, IDs may have changed: the next agent re-resolves from a fresh view.
			ctx.live = undefined;
			if (ownedPaneId) await this.command(["pane", "close", ownedPaneId], signal);
			else await this.command(["tab", "close", ownedTabId!], signal);
			return { outcome: "closed" };
		}
		return {
			outcome: "already_gone",
			note: `${nodeLabel(node)}: no live tab or pane found; treated as already closed`,
		};
	}

	async sendWakeUp(request: HostWakeRequest): Promise<HostWakeResult> {
		return tryPaneWake({ ...request, env: request.env ?? this.env });
	}
}
