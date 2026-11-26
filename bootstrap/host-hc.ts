/** hc (herdr-core) Host backend implementation (HOST.md). All `hc` CLI interactions live here. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	executableOnPath,
	findExecutableOnPath,
	type Host,
	type HostCloseResult,
	type HostDiscoveredNode,
	type HostExecResult,
	type HostExecutor,
	type HostLaunchNodeRequest,
	type HostNodeExistence,
	type HostNodeHandle,
	type HostNodeTarget,
	type HostPreflightResult,
	type HostWakeRequest,
	type HostWakeResult,
} from "./host.ts";
import { checkAbort, errorMessage, isRecord, nodeLabel } from "./session-store.ts";

const DEFAULT_HC_TIMEOUT_MS = 15_000;
const HC_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export interface HcHostRef extends Record<string, unknown> {
	name: string;
	address: string;
}

interface ConfirmedHcTerminal {
	address: string;
	name?: string;
	state: string;
	labels: Record<string, string>;
}

interface HcDiscoveryContext {
	byRun: Map<string, ConfirmedHcTerminal[]>;
	byAddress: Map<string, ConfirmedHcTerminal | null>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty string without NUL characters`);
	}
	return value;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") ? value : undefined;
}

function sanitizeHcNameSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/**
 * Deterministic, sanitized, hashed terminal name valid for `hc run --name` (1-32 of `a-z 0-9 - _`).
 * Uses the original run and instance identities in the digest so long or awkward IDs stay distinct.
 */
export function hcTerminalName(taskId: string, instanceId: string): string {
	const rawTask = requiredString(taskId, "taskId");
	const rawInstance = requiredString(instanceId, "instanceId");
	const digest = createHash("sha256").update(JSON.stringify([rawTask, rawInstance]), "utf8").digest("hex").slice(0, 10);
	const taskPart = sanitizeHcNameSegment(rawTask).slice(0, 10).replace(/[-_]+$/g, "");
	const instancePart = sanitizeHcNameSegment(rawInstance).slice(0, 10).replace(/[-_]+$/g, "");
	const combined = [taskPart, instancePart].filter(Boolean).join("-");
	const prefix = (combined.slice(0, 21).replace(/[-_]+$/g, "")) || "node";
	const candidate = `${prefix}-${digest}`;
	if (!HC_NAME_PATTERN.test(candidate)) {
		throw new Error(`Generated invalid hc terminal name: ${candidate}`);
	}
	return candidate;
}

function parseHcError(result: HostExecResult): { kind?: string; detail: string } {
	if (result.killed) return { detail: "cancelled or timed out; outcome may be ambiguous" };
	if (result.truncated) return { detail: "output exceeded buffer limit" };
	for (const raw of [result.stderr, result.stdout]) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRecord(parsed) && isRecord(parsed.error)) {
				const kind = asNonEmptyString(parsed.error.kind);
				const message = asNonEmptyString(parsed.error.message);
				const hint = asNonEmptyString(parsed.error.hint);
				const body = message ?? JSON.stringify(parsed.error).slice(0, 1000);
				return {
					kind,
					detail: `${kind ? `[${kind}] ` : ""}${body}${hint ? ` (${hint})` : ""}`,
				};
			}
		} catch { /* fall back to plain text */ }
	}
	return { detail: (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 3000) };
}

function isHcNotFoundError(result: HostExecResult, parsed: { kind?: string }): boolean {
	if (result.killed || result.truncated) return false;
	if (parsed.kind === "not_found") return true;
	return parsed.kind === undefined && result.code === 3;
}

function isValidHcStatusResult(value: unknown): boolean {
	if (!isRecord(value) || value.error) return false;
	if (!isRecord(value.core) || !asNonEmptyString(value.core.id)) return false;
	return asNonEmptyString(value.version) !== undefined;
}

export function spawnHcServerStatusProbe(
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
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(hcPath, ["server", "status", "--json"], {
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			if (postExitTimer) clearTimeout(postExitTimer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			try { child.stdout?.destroy(); } catch { /* ignore */ }
			resolveProbe(ok);
		};
		const evaluateStatus = (code: number | null) => {
			if (code !== 0) {
				finish(false);
				return;
			}
			const trimmed = stdout.trim();
			if (!trimmed) {
				finish(false);
				return;
			}
			try {
				finish(isValidHcStatusResult(JSON.parse(trimmed)));
			} catch {
				finish(false);
			}
		};
		const terminate = () => {
			if (settled) return;
			try { child.kill("SIGTERM"); } catch { /* exited */ }
			killTimer = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* exited */ }
			}, 250);
			killTimer.unref?.();
			// Hard deadline so a stubborn child or grandchild holding stdout open cannot hang selection.
			deadlineTimer = setTimeout(() => finish(false), 300);
			deadlineTimer.unref?.();
		};
		const onAbort = () => terminate();
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(terminate, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
		child.once("error", () => finish(false));
		child.once("exit", code => {
			if (settled) return;
			if (code !== 0) {
				finish(false);
				return;
			}
			// Allow buffered stdout to flush after exit, without waiting for EOF if a grandchild holds stdout open.
			postExitTimer = setTimeout(() => evaluateStatus(code), 25);
			postExitTimer.unref?.();
		});
		child.once("close", code => evaluateStatus(code));
	});
}

function normalizeLabels(raw: unknown): Record<string, string> {
	if (!isRecord(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

function resolveTargetRunId(node: HostNodeTarget): string {
	const explicit = asNonEmptyString(node.run_id);
	if (explicit) return explicit;
	if (typeof node.label === "string" && node.instance_id && node.label.endsWith(`:${node.instance_id}`)) {
		const prefix = node.label.slice(0, -(node.instance_id.length + 1));
		if (asNonEmptyString(prefix)) return prefix;
	}
	throw new Error(`hc target ${node.node_id} is missing run_id`);
}

function savedAddressOf(node: HostNodeTarget): string | undefined {
	if (isRecord(node.host_ref)) {
		const fromRef = asNonEmptyString(node.host_ref.address);
		if (fromRef) return fromRef;
	}
	return asNonEmptyString(node.terminal_id);
}

function savedNameOf(node: HostNodeTarget): string | undefined {
	return isRecord(node.host_ref) ? asNonEmptyString(node.host_ref.name) : undefined;
}

export class HcHost implements Host {
	readonly backend = "hc" as const;
	private readonly exec: HostExecutor;
	private readonly env: NodeJS.ProcessEnv;

	constructor(options: { exec: HostExecutor; env: NodeJS.ProcessEnv }) {
		this.exec = options.exec;
		this.env = options.env;
	}

	private async runRaw(args: string[], signal?: AbortSignal): Promise<HostExecResult> {
		checkAbort(signal);
		return this.exec("hc", args, { signal, timeout: DEFAULT_HC_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
	}

	private parseJsonPayload(operation: string, output: string): Record<string, unknown> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(output);
		} catch {
			throw new Error(`hc ${operation} returned invalid JSON`);
		}
		if (!isRecord(parsed)) {
			throw new Error(`hc ${operation} returned non-object JSON response`);
		}
		if (parsed.error) {
			throw new Error(`hc ${operation} API error: ${JSON.stringify(parsed.error).slice(0, 1000)}`);
		}
		return parsed;
	}

	private async jsonCommand(operation: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
		const result = await this.runRaw(args, signal);
		if (result.code !== 0 || result.killed || result.truncated) {
			const err = parseHcError(result);
			throw new Error(`hc ${operation} failed: ${err.detail}`);
		}
		return this.parseJsonPayload(operation, result.stdout);
	}

	checkAvailable(_options: { requireContext?: boolean } = {}): void {
		executableOnPath("hc", this.env);
	}

	async preflight(signal?: AbortSignal): Promise<HostPreflightResult> {
		try {
			this.checkAvailable({ requireContext: false });
		} catch (error) {
			throw new Error(`hc preflight failed: ${errorMessage(error)}`);
		}
		const status = await this.jsonCommand("preflight (server status)", ["server", "status", "--json"], signal);
		if (!isValidHcStatusResult(status)) {
			throw new Error("hc preflight (server status) failed: response is missing required core or version fields");
		}
		const callerTerminalId = asNonEmptyString(this.env.HC_TERMINAL_ID);
		if (callerTerminalId) {
			const caller = await this.jsonCommand(`preflight (get caller terminal ${callerTerminalId})`, ["get", "--json", callerTerminalId], signal);
			requiredString(caller.address, `hc preflight caller terminal ${callerTerminalId} address`);
		}
		return { backend: "hc", workspace_id: "hc" };
	}

	async launchNode(request: HostLaunchNodeRequest, signal?: AbortSignal): Promise<HostNodeHandle> {
		const runId = requiredString(request.runId, "runId");
		const instanceId = requiredString(request.instanceId, "instanceId");
		const directory = requiredString(request.directory, "directory");
		const launcher = requiredString(request.launcher, "launcher");
		const name = hcTerminalName(runId, instanceId);

		const created = await this.jsonCommand(`launchNode (${name})`, [
			"run",
			"--json",
			"--bg",
			"--name", name,
			"--cwd", directory,
			"--label", `bootstrap_run=${runId}`,
			"--label", `bootstrap_node=${instanceId}`,
			"--no-parent",
			"--no-notify",
			"/bin/sh",
			launcher,
		], signal);

		const address = requiredString(created.address, "Created hc terminal address");
		const confirmedName = asNonEmptyString(created.name) ?? name;
		const hostRef: HcHostRef = { name: confirmedName, address };
		request.onUpdate?.({ host_ref: hostRef, phase: "submitted" });
		return { host_ref: hostRef };
	}

	createDiscoveryContext(): HcDiscoveryContext {
		return { byRun: new Map(), byAddress: new Map() };
	}

	private asDiscoveryContext(discoveryContext?: unknown): HcDiscoveryContext {
		if (discoveryContext && isRecord(discoveryContext) && discoveryContext.byRun instanceof Map && discoveryContext.byAddress instanceof Map) {
			return discoveryContext as unknown as HcDiscoveryContext;
		}
		return this.createDiscoveryContext();
	}

	private async getTerminal(address: string, ctx: HcDiscoveryContext, signal?: AbortSignal): Promise<ConfirmedHcTerminal | null> {
		if (ctx.byAddress.has(address)) return ctx.byAddress.get(address)!;
		const result = await this.runRaw(["get", "--json", address], signal);
		if (result.code !== 0 || result.killed || result.truncated) {
			const err = parseHcError(result);
			if (isHcNotFoundError(result, err)) {
				ctx.byAddress.set(address, null);
				return null;
			}
			throw new Error(`hc get (${address}) failed: ${err.detail}`);
		}
		const parsed = this.parseJsonPayload(`get (${address})`, result.stdout);
		const confirmedAddress = requiredString(parsed.address, `hc get (${address}) address`);
		const state = requiredString(parsed.state, `hc get (${address}) state`);
		const confirmed: ConfirmedHcTerminal = {
			address: confirmedAddress,
			...(asNonEmptyString(parsed.name) ? { name: asNonEmptyString(parsed.name) } : {}),
			state,
			labels: normalizeLabels(parsed.labels),
		};
		ctx.byAddress.set(address, confirmed);
		return confirmed;
	}

	private async listRunTerminals(runId: string, ctx: HcDiscoveryContext, signal?: AbortSignal): Promise<ConfirmedHcTerminal[]> {
		if (ctx.byRun.has(runId)) return ctx.byRun.get(runId)!;
		const listed = await this.jsonCommand(`ls (bootstrap_run=${runId})`, [
			"ls",
			"--all",
			"--json",
			"--label", `bootstrap_run=${runId}`,
		], signal);
		if (!Array.isArray(listed.terminals)) {
			throw new Error(`hc ls (bootstrap_run=${runId}) returned invalid terminals array`);
		}
		const candidateAddresses: string[] = [];
		const seen = new Set<string>();
		for (const item of listed.terminals) {
			if (!isRecord(item)) continue;
			const addr = asNonEmptyString(item.address);
			if (addr && !seen.has(addr)) {
				seen.add(addr);
				candidateAddresses.push(addr);
			}
		}
		const confirmed: ConfirmedHcTerminal[] = [];
		for (const addr of candidateAddresses) {
			const terminal = await this.getTerminal(addr, ctx, signal);
			if (terminal) confirmed.push(terminal);
		}
		ctx.byRun.set(runId, confirmed);
		return confirmed;
	}

	private async inspectTarget(
		node: HostNodeTarget,
		ctx: HcDiscoveryContext,
		signal?: AbortSignal,
	): Promise<{ existence: HostNodeExistence; terminal?: ConfirmedHcTerminal; runId: string }> {
		const runId = resolveTargetRunId(node);
		const savedAddress = savedAddressOf(node);
		const runTerminals = await this.listRunTerminals(runId, ctx, signal);
		const labelMatches = runTerminals.filter(
			terminal => terminal.labels.bootstrap_run === runId && terminal.labels.bootstrap_node === node.instance_id,
		);
		if (labelMatches.length > 1) {
			return {
				runId,
				existence: {
					state: "ambiguous",
					reason: `Multiple hc terminals carry bootstrap_run=${runId} and bootstrap_node=${node.instance_id}: ${labelMatches.map(t => t.address).join(", ")}`,
				},
			};
		}
		if (savedAddress) {
			const exact = await this.getTerminal(savedAddress, ctx, signal);
			if (!exact) {
				if (labelMatches.length > 0) {
					return {
						runId,
						existence: {
							state: "ambiguous",
							reason: `Saved hc address ${savedAddress} is gone, but terminal ${labelMatches[0]!.address} carries bootstrap_run=${runId} and bootstrap_node=${node.instance_id}`,
						},
					};
				}
				return {
					runId,
					existence: { state: "gone", reason: `hc terminal ${savedAddress} was not found` },
				};
			}
			if (exact.labels.bootstrap_run !== runId || exact.labels.bootstrap_node !== node.instance_id) {
				return {
					runId,
					existence: {
						state: "ambiguous",
						reason: `hc terminal ${savedAddress} labels do not match bootstrap_run=${runId} and bootstrap_node=${node.instance_id}`,
					},
				};
			}
			if (exact.state !== "live" && exact.state !== "finished") {
				return {
					runId,
					existence: {
						state: "ambiguous",
						reason: `hc terminal ${savedAddress} reported unexpected state ${JSON.stringify(exact.state)}`,
					},
				};
			}
			return {
				runId,
				terminal: exact,
				existence: {
					state: "present",
					ref: {
						name: exact.name ?? savedNameOf(node) ?? hcTerminalName(runId, node.instance_id),
						address: exact.address,
					},
				},
			};
		}
		if (labelMatches.length > 0) {
			return {
				runId,
				existence: {
					state: "ambiguous",
					reason: `Unrecorded hc terminal ${labelMatches[0]!.address} matches bootstrap_run=${runId} and bootstrap_node=${node.instance_id} without a saved host_ref address`,
				},
			};
		}
		return {
			runId,
			existence: { state: "gone", reason: "No saved hc terminal address or matching terminal found" },
		};
	}

	private async evaluateTarget(node: HostNodeTarget, ctx: HcDiscoveryContext, signal?: AbortSignal): Promise<HostNodeExistence> {
		return (await this.inspectTarget(node, ctx, signal)).existence;
	}

	async nodeExists(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostNodeExistence> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		return this.evaluateTarget(node, ctx, signal);
	}

	async discoverOwnedNodes(nodes: ReadonlyArray<HostNodeTarget>, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostDiscoveredNode[]> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		const discovered: HostDiscoveredNode[] = [];
		for (const target of nodes) {
			discovered.push({
				target,
				existence: await this.evaluateTarget(target, ctx, signal),
			});
		}
		return discovered;
	}

	private invalidateDiscoveryEntry(ctx: HcDiscoveryContext, runId: string, address: string, removed: boolean): void {
		ctx.byAddress.delete(address);
		if (!removed) {
			ctx.byRun.delete(runId);
			return;
		}
		const cachedRun = ctx.byRun.get(runId);
		if (cachedRun) {
			ctx.byRun.set(runId, cachedRun.filter(terminal => terminal.address !== address));
		}
	}

	private async runCloseStep(
		subcommand: "kill" | "rm",
		node: HostNodeTarget,
		ctx: HcDiscoveryContext,
		runId: string,
		address: string,
		signal?: AbortSignal,
	): Promise<HostCloseResult | undefined> {
		const res = await this.runRaw([subcommand, "--json", address], signal);
		if (res.code !== 0 || res.killed || res.truncated) {
			const err = parseHcError(res);
			if (isHcNotFoundError(res, err)) {
				this.invalidateDiscoveryEntry(ctx, runId, address, true);
				return {
					outcome: "already_gone",
					note: `${nodeLabel(node)}: hc terminal ${address} was not found; treated as already closed`,
				};
			}
			this.invalidateDiscoveryEntry(ctx, runId, address, false);
			throw new Error(`hc ${subcommand} (${address}) failed: ${err.detail}`);
		}
		this.parseJsonPayload(`${subcommand} (${address})`, res.stdout);
		return undefined;
	}

	async closeNode(node: HostNodeTarget, signal?: AbortSignal, discoveryContext?: unknown): Promise<HostCloseResult> {
		const ctx = this.asDiscoveryContext(discoveryContext);
		const { existence, terminal, runId } = await this.inspectTarget(node, ctx, signal);
		if (existence.state === "ambiguous") {
			throw new Error(existence.reason);
		}
		if (existence.state === "gone" || !terminal) {
			return {
				outcome: "already_gone",
				note: `${nodeLabel(node)}: ${existence.state === "gone" && existence.reason ? existence.reason : "hc terminal not found"}; treated as already closed`,
			};
		}

		const address = terminal.address;
		if (terminal.state === "live") {
			const gone = await this.runCloseStep("kill", node, ctx, runId, address, signal);
			if (gone) return gone;
		}

		const gone = await this.runCloseStep("rm", node, ctx, runId, address, signal);
		if (gone) return gone;
		this.invalidateDiscoveryEntry(ctx, runId, address, true);
		return { outcome: "closed" };
	}

	async sendWakeUp(_request: HostWakeRequest): Promise<HostWakeResult> {
		return { outcome: "failed", reason: "hc sendWakeUp is not implemented yet (ticket 06)" };
	}
}
