/** Herdr-native bootstrap: preflight → durable plan → readiness barrier → release → recoverable cleanup. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piAgentDir } from "./bootstrap/bootstrap-utils.ts";
import { BootstrapService, MAX_WAIT_MS, type GenerateRequest } from "./bootstrap/lifecycle.ts";
import { buildMarkdownReport, formatAgentStates, formatAutomaticCleanup, formatCancelResult, formatLaunch, formatPlan, formatRecovery, formatReportDigest, formatRunList, formatRunOutcome } from "./bootstrap/reporting.ts";
import { createGraphWidgets } from "./bootstrap/graph-widget.ts";
import { wakeViaComs } from "./bootstrap/recovery.ts";
import { errorMessage, isRecord, MAX_CLEANUP_SETTLE_MS, type BootstrapManifest, type BootstrapResult } from "./bootstrap/session-store.ts";
import { outputContractSchema, resultSchema } from "./bootstrap/schemas.ts";
import { applyExtensionDefaults } from "./themeMap.ts";
import { openBriefEditor } from "./factory/editor.ts";
import {
	createManagerAuthority,
	factoryOperations,
	MAX_BRIEF_BYTES,
	MAX_QUEUED_INPUTS,
	revokeManagerAuthority,
	validateFactoryToken,
	type ManagerAuthority,
	type SessionBinding,
} from "./factory/operations.ts";

function response(text: string, details: Record<string, unknown>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function publicManifest(manifest: BootstrapManifest): Record<string, unknown> {
	// Acknowledgement tokens are internal; callers only need identities and recovery state.
	const { token: _token, ...visible } = manifest;
	return visible;
}

function closestTrustDecision(trustMap: Record<string, unknown>, targetPath: string): boolean | undefined {
	let current = resolve(targetPath);
	for (;;) {
		if (Object.prototype.hasOwnProperty.call(trustMap, current)) {
			const val = trustMap[current];
			if (typeof val !== "boolean") throw new Error(`Invalid trust decision for ${current} in trust.json`);
			return val;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function hasProtectedProjectResources(projectCwd: string): boolean {
	for (const rel of [
		".pi/settings.json", ".pi/mcp.json", ".pi/extensions", ".pi/skills",
		".pi/prompts", ".pi/themes", ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md",
	]) {
		if (existsSync(join(projectCwd, rel))) return true;
	}
	let current = resolve(projectCwd);
	for (;;) {
		if (existsSync(join(current, ".agents", "skills"))) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

function assertProjectTrusted(
	ctx: { cwd?: string; isProjectTrusted?: () => boolean },
	agentDir: string,
	projectCwd?: string,
): void {
	if (typeof ctx.isProjectTrusted !== "function" || !ctx.isProjectTrusted()) {
		throw new Error("Factory launch refused: project is not trusted in this Pi session");
	}
	const trustPath = join(agentDir, "trust.json");
	let trustMap: Record<string, unknown> = {};
	if (existsSync(trustPath)) {
		try {
			const raw = JSON.parse(readFileSync(trustPath, "utf8")) as unknown;
			if (!isRecord(raw)) throw new Error("trust.json must be a JSON object");
			trustMap = raw;
		} catch (error) {
			throw new Error(`Factory launch refused: unreadable trust store (${errorMessage(error)})`);
		}
	}
	let canonicalSessionCwd: string | undefined;
	if (typeof ctx.cwd === "string" && ctx.cwd.length > 0) {
		try { canonicalSessionCwd = realpathSync(ctx.cwd); } catch { canonicalSessionCwd = resolve(ctx.cwd); }
		if (closestTrustDecision(trustMap, canonicalSessionCwd) === false) {
			throw new Error("Factory launch refused: project trust was denied or revoked in trust.json");
		}
	}
	if (projectCwd) {
		const decision = closestTrustDecision(trustMap, projectCwd);
		if (decision === false) {
			throw new Error(`Factory launch refused: trust for ${projectCwd} was denied or revoked in trust.json`);
		}
		if (canonicalSessionCwd !== projectCwd && decision !== true && hasProtectedProjectResources(projectCwd)) {
			const settingsPath = join(agentDir, "settings.json");
			let defaultTrust: unknown;
			if (existsSync(settingsPath)) {
				try {
					const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
					if (isRecord(settings)) defaultTrust = settings.defaultProjectTrust;
				} catch {
					throw new Error("Factory launch refused: unreadable Pi settings.json while verifying project trust");
				}
			}
			if (defaultTrust !== "always") {
				throw new Error(`Factory launch refused: target checkout ${projectCwd} has protected project resources and is not trusted`);
			}
		}
	}
}

export default function (pi: ExtensionAPI) {
	const service = new BootstrapService({
		exec: (command, args, options) => pi.exec(command, args, options),
		extensionDir: dirname(fileURLToPath(import.meta.url)),
	});

	const factoryStore = join(process.env.PI_FACTORY_STATE_DIR ?? process.env.PI_BOOTSTRAP_STATE_DIR ?? join(homedir(), ".pi", "agent", "bootstrap-sessions"), "factories.sqlite");
	const factory = factoryOperations(factoryStore, service);
	const inAgentSession = () => process.argv.slice(2).includes("--bootstrap-worker-config");

	let activeAuthority: ManagerAuthority | undefined;
	let activeBinding: SessionBinding | undefined;
	let sessionShutDown = false;

	const currentBinding = (ctx: { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } }): SessionBinding => ({
		pi_session_id: ctx.sessionManager?.getSessionId?.(),
		pi_session_file: ctx.sessionManager?.getSessionFile?.(),
	});
	const sameBinding = (a: SessionBinding | undefined, b: SessionBinding): boolean =>
		(a?.pi_session_id ?? undefined) === (b.pi_session_id ?? undefined)
		&& (a?.pi_session_file ?? undefined) === (b.pi_session_file ?? undefined);
	const ensureAuthority = (ctx: { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } }): ManagerAuthority => {
		if (sessionShutDown) throw new Error("Session has shut down; management authority is no longer active");
		const binding = currentBinding(ctx);
		if (!activeAuthority || !sameBinding(activeBinding, binding)) {
			revokeManagerAuthority(activeAuthority);
			activeAuthority = createManagerAuthority(binding);
			activeBinding = binding;
		}
		return activeAuthority;
	};
	const assertLiveAuthority = (
		ctx: { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } },
		expectedAuthority: ManagerAuthority,
		expectedBinding: SessionBinding,
	): void => {
		if (sessionShutDown) {
			throw new Error("Session has shut down; management authority is no longer active");
		}
		if (activeAuthority !== expectedAuthority) {
			throw new Error("Managing session authority changed or was revoked while the command was suspended; explicitly resume management in the active session");
		}
		const liveBinding = currentBinding(ctx);
		if (!sameBinding(expectedBinding, liveBinding) || !sameBinding(activeBinding, liveBinding)) {
			throw new Error("Session binding changed while the command was suspended; submission aborted without writing");
		}
	};

	const ALLOWED_FACTORY_INSPECT_KEYS = new Set(["action", "factory_id", "reference", "input_id"]);
	pi.registerTool({
		name: "factory_inspect", label: "Factory Inspect",
		description: "Read-only discovery, definition inspection, queue inspection, and receipt recovery for explicitly published software factories. Opening, inspection, and receipt lookup never resume management, mutate queue state, or launch runs.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("receipt")]),
			factory_id: Type.Optional(Type.String({ minLength: 1, description: "Published factory ID; required for inspect and receipt." })),
			reference: Type.Optional(Type.String({ minLength: 1, description: "Literal submission reference for receipt recovery; pass either reference or input_id." })),
			input_id: Type.Optional(Type.String({ minLength: 1, description: "Accepted input ID for receipt recovery; pass either reference or input_id." })),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			try {
				if (!isRecord(params)) throw new Error("factory_inspect requires an object parameter");
				for (const key of Object.keys(params)) {
					if (!ALLOWED_FACTORY_INSPECT_KEYS.has(key)) throw new Error(`factory_inspect does not accept parameter "${key}"`);
				}
				if (params.action === "list") {
					if (params.factory_id !== undefined || params.reference !== undefined || params.input_id !== undefined) {
						throw new Error('factory_inspect action "list" does not accept factory_id, reference, or input_id');
					}
					const result = factory({ action: "list" });
					return response(JSON.stringify(result, null, 2), { result });
				}
				if (params.action === "inspect") {
					if (typeof params.factory_id !== "string" || !params.factory_id.trim()) {
						throw new Error('factory_inspect action "inspect" requires a non-empty factory_id');
					}
					if (params.reference !== undefined || params.input_id !== undefined) {
						throw new Error('factory_inspect action "inspect" does not accept reference or input_id');
					}
					const result = factory({ action: "inspect", factory_id: params.factory_id });
					return response(JSON.stringify(result, null, 2), { result });
				}
				if (params.action === "receipt") {
					if (typeof params.factory_id !== "string" || !params.factory_id.trim()) {
						throw new Error('factory_inspect action "receipt" requires a non-empty factory_id');
					}
					const hasRef = params.reference !== undefined;
					const hasId = params.input_id !== undefined;
					if (hasRef === hasId) {
						throw new Error('factory_inspect action "receipt" requires exactly one of reference or input_id');
					}
					const result = hasRef
						? factory({ action: "receipt", factory_id: params.factory_id, reference: params.reference as string })
						: factory({ action: "receipt", factory_id: params.factory_id, input_id: params.input_id as string });
					return response(JSON.stringify(result, null, 2), { result });
				}
				throw new Error('factory_inspect action must be "list", "inspect", or "receipt"');
			} catch (error) { return response(errorMessage(error), {}, true); }
		},
	});

	pi.registerCommand("factory", {
		description: "Discover, inspect, publish, explicitly resume management, submit plain-text briefs, launch the FIFO head, or recover receipts for a software factory",
		getArgumentCompletions: prefix => {
			if (prefix.includes(" ")) return null;
			const matches = ["list", "inspect", "receipt", "publish", "resume", "submit", "launch"].filter(action => action.startsWith(prefix));
			return matches.length > 0 ? matches.map(value => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			try {
				const tokens = typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
				const [action, ...rest] = tokens;
				if (!action || action === "list") {
					if (rest.length > 0) throw new Error("Usage: /factory [list]");
					ctx.ui.notify(JSON.stringify(factory({ action: "list" }), null, 2), "info");
					return;
				}
				if (action === "inspect") {
					if (rest.length !== 1) throw new Error("Usage: /factory inspect <factory-id>");
					ctx.ui.notify(JSON.stringify(factory({ action: "inspect", factory_id: rest[0] }), null, 2), "info");
					return;
				}
				if (action === "receipt") {
					if (rest.length !== 2) throw new Error("Usage: /factory receipt <factory-id> <reference>");
					ctx.ui.notify(JSON.stringify(factory({ action: "receipt", factory_id: rest[0], reference: rest[1] }), null, 2), "info");
					return;
				}
				if (action === "publish") {
					if (rest.length > 0) throw new Error("Usage: /factory publish");
					if (inAgentSession()) throw new Error("Factory publication cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory publication needs interactive confirmation; use /factory publish in Pi with a UI");
					const raw = await ctx.ui.editor("Publish factory definition (JSON: {name, draft})");
					if (raw === undefined) return;
					const publication = JSON.parse(raw) as { name: string; draft: unknown };
					const confirmed = await ctx.ui.confirm("Publish software factory?", `Validate and durably publish ${publication.name}; create no run?`);
					if (!confirmed) return;
					ctx.ui.notify(JSON.stringify(factory({ action: "publish", name: publication.name, draft: publication.draft, sessionModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: ctx.thinkingLevel } : undefined }), null, 2), "info");
					return;
				}
				if (action === "resume") {
					if (rest.length !== 1) throw new Error("Usage: /factory resume <factory-id>");
					if (inAgentSession()) throw new Error("Factory management cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory resume requires an interactive Pi session with a UI; use /factory resume <factory-id> interactively");
					const authority = ensureAuthority(ctx);
					ctx.ui.notify(JSON.stringify(factory({ action: "resume", factory_id: rest[0], authority }), null, 2), "info");
					return;
				}
				if (action === "submit") {
					if (rest.length < 1 || rest.length > 2) throw new Error("Usage: /factory submit <factory-id> [reference]");
					if (inAgentSession()) throw new Error("Factory submission cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory submission requires an interactive Pi session with a UI; use /factory submit <factory-id> [reference] interactively");
					const factoryId = validateFactoryToken(rest[0], "factory_id");
					const reference = rest[1] !== undefined ? validateFactoryToken(rest[1], "reference") : `sub-${randomUUID()}`;
					const capturedBinding = currentBinding(ctx);
					const authority = ensureAuthority(ctx);
					factory({ action: "verify_manager", factory_id: factoryId, authority });
					ctx.ui.notify(
						`Submission reference: ${reference} (factory ${factoryId}; max ${MAX_BRIEF_BYTES} UTF-8 bytes / 16 KiB, ${MAX_QUEUED_INPUTS} queued inputs)`,
						"info",
					);
					const raw = await openBriefEditor(
						ctx,
						`Submit plain-text brief for ${factoryId} [ref: ${reference}]`,
						`Literal plain text (${MAX_BRIEF_BYTES} UTF-8 bytes max, ${MAX_QUEUED_INPUTS} queued max). Enter submits, Shift/Alt+Enter newline, Esc cancels.`,
					);
					if (raw === undefined) {
						ctx.ui.notify(`Submission cancelled (reference ${reference} was not submitted)`, "info");
						return;
					}
					assertLiveAuthority(ctx, authority, capturedBinding);
					const receipt = factory({ action: "submit", factory_id: factoryId, reference, brief: raw, authority });
					ctx.ui.notify(JSON.stringify(receipt, null, 2), "info");
					return;
				}
				if (action === "launch") {
					if (rest.length !== 1) throw new Error("Usage: /factory launch <factory-id>");
					if (inAgentSession()) throw new Error("Factory launch cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory launch requires an interactive Pi session with a UI; use /factory launch <factory-id> interactively");
					const factoryId = validateFactoryToken(rest[0], "factory_id");
					const capturedBinding = currentBinding(ctx);
					const authority = ensureAuthority(ctx);
					const { env: serviceEnv, home: serviceHome } = service.getEnvironment();
					const agentDir = piAgentDir(serviceEnv, serviceHome);
					const assertAuthorityAndTrust = (projectCwd?: string) => {
						assertLiveAuthority(ctx, authority, capturedBinding);
						assertProjectTrusted(ctx, agentDir, projectCwd);
					};
					assertAuthorityAndTrust();
					const launched = await factory({
						action: "launch",
						factory_id: factoryId,
						authority,
						assertAuthorityAndTrust,
					});
					if (!inAgentSession()) {
						try { await graphs.attach(launched.task_id, ctx, service.status(launched.task_id, ctx.cwd)); } catch { /* launch already committed */ }
					}
					const { manifest, ...summaryResult } = launched;
					ctx.ui.notify(JSON.stringify({ ...summaryResult, manifest: publicManifest(manifest) }, null, 2), "info");
					return;
				}
				throw new Error("Usage: /factory [list | inspect <factory-id> | receipt <factory-id> <reference> | publish | resume <factory-id> | submit <factory-id> [reference] | launch <factory-id>]");
			} catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
		},
	});

	const graphs = createGraphWidgets((taskId, cwd, onCleaned) => service.statusWithCleanup(taskId, cwd, onCleaned), (taskId, message) => {
		pi.sendMessage({ customType: "bootstrap-cleanup", content: `Run ${taskId}. ${message}`, display: true },
			{ deliverAs: "followUp", triggerTurn: true });
	});
	// The worker extension owns this flag in Pi. The launcher argument is visible to both extensions.

	pi.registerTool({
		name: "bootstrap_generate", label: "Bootstrap Generate",
		description: "Spawn a chain, team, or graph of agents as tabs in the originating Herdr workspace using the existing project_cwd (shared_cwd; worktrees are never created automatically). Each agent entry is one assignment (a node): give every node a unique node_id and name the persona it runs with persona, so several assignments can use the same persona (for example two reviewers with different sub_tasks). The older form (name + sub_task, where name is both the persona and the node ID) still works for chains and teams; graph topology requires the node form (persona with optional node_id). New-format plans default collaboration_mode to independent (unsolicited peer task activation is rejected while preserving internal handoffs and user controls); pass collaboration_mode: \"collaborative\" to opt into peer collaboration explicitly. Legacy name requests keep their existing messaging behavior with visible guidance. failure_policy defaults to independent (other nodes finish even if another node fails); set failure_policy: \"fail_fast\" to cancel remaining unfinished nodes, including parked loop-body agents, on a failure. Supports bounded shared briefs (goal, acceptance_criteria, constraints), per-node role/ownership, read_paths, write_paths, output_contract, and required_checks: stores immutable task inputs and an upstream-results index, validates required upstream outputs, artifact hashes, and current verification evidence before downstream admission, without creating worktrees. Disjoint write_paths run concurrently while overlapping write_paths (including parent directories and whole-project scopes) serialize in deterministic plan order and queue writers in shared_cwd. Shared-cwd path declarations and active tool lists are an advisory scheduling contract, not a filesystem sandbox. Dependencies (implicit order in a chain, or explicit depends_on in a graph) are governed by dependency_policy per node: new-format requests (persona/node_id) default to require_success, so a node starts only if its predecessor succeeded; a partial, failed, blocked, skipped or cancelled predecessor blocks it, and a blocked node is reported as blocked with its cause, not as a failed execution. Set dependency_policy: allow_partial on a node to accept a partial predecessor (a failed predecessor always blocks); the legacy name form keeps allow_partial. Graph joins (nodes with multiple inbound edges in depends_on) also declare join_policy: all_success (default; requires every inbound edge to succeed) or allow_partial (admits partial sources and defaults omitted dependency_policy to allow_partial). Nodes in a node-form chain or graph may declare decision to form a bounded review loop (field, approve, reject, on_reject naming a strict ancestor, max_revisions 1–10 defaulting to 3, and on_exhausted, which defaults to needs_attention or can be set to failed); the decision's output_contract must require field as a string enum of exactly approve and reject. On rejection with budget left, the whole loop body (nodes from on_reject to the decision node, inclusive) re-runs in dependency order as a new attempt on the same live parked agents, holding write_paths ownership until finalization; max_total_attempts bounds all attempts across the run (defaults to initial attempts plus allowed loop-body revisions, subject to bootstrap.json graph defaults and ceilings — exceeding a ceiling fails planning). A node's required_checks are also what its dependent needs: the dependent starts only when those checks still have passing, current evidence (an agent's claim of success is not evidence; missing, failed, unverified and stale evidence each block it, and the reason says which). Each result is handed to downstream nodes per edge durably and Coms is only the wake-up: a handoff delivered or queued by Coms is not accepted (the successor claims the exact saved input before any model work, and rejects a wrong run, sender, destination, attempt or changed input), so check bootstrap_status for the handoff state rather than assuming a send means the successor started. If delivery was interrupted (the source exited, an acknowledgement was lost), bootstrap_recover inspects the saved evidence and can re-send the same unclaimed handoff without re-running anything. Deadlines and liveness are configured separately: ready_timeout_ms bounds startup readiness (default 60000ms), task_timeout_ms bounds running-task duration per attempt from admission (unset by default so long-running workflows stay compatible), dependency_wait_timeout_ms bounds waiting without useful upstream progress (default 300000ms; heartbeats alone do not reset it), liveness_timeout_ms diagnoses stalled agents without auto-killing (default 600000ms), and cancel_grace_ms sets the grace period before force_close (default 5000ms). cleanup defaults to on_success for graph (automatically closing owned tabs once all nodes succeed and delivery settles after cleanup_settle_ms, default 3000ms, while retaining session files and reports) and manual for chain and team. Interactive dispatcher sessions show a live graph widget (manageable via /bootgraph <task_id> and /bootgraph clear). Validates dependencies, persists partial progress, and waits for every agent to be ready before releasing work. Returns task_id (the run ID) and pane_manifest listing node IDs. On failure, resources are retained for bootstrap_cleanup; do not blindly re-submit. Reuse request_id for idempotent re-submission: an equivalent plan returns the original run (including a run whose launcher was interrupted, reported as error/interrupted, or as applied if work had already been released) and never launches twice, even from two processes; a different plan with the same request_id is rejected. Use a new request_id for a deliberate fresh launch. A re-submission queued behind another launch of the same request_id waits for it (up to 15 minutes), and cancellation takes effect only once that wait ends.",
		parameters: Type.Object({
			topology: Type.Union([Type.Literal("chain"), Type.Literal("team"), Type.Literal("graph")], { description: "Run topology: chain, team, or graph (DAG with fan-out, joins, and optional decision nodes)." }),
			task: Type.String({ minLength: 1, description: "High-level task for the run" }),
			goal: Type.Optional(Type.String({ minLength: 1, description: "Shared run goal injected into every agent's bounded authoritative brief" })),
			acceptance_criteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Run-wide acceptance criteria injected into agents' authoritative briefs" })),
			constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Run-wide constraints injected into agents' authoritative briefs" })),
			collaboration_mode: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("collaborative")], { description: "Peer messaging policy: independent (default for persona/node_id plans; rejects unsolicited peer task activation while keeping internal coordination and user controls) or collaborative (explicit opt-in for peer collaboration). Omitted legacy name requests keep legacy messaging with guidance." })),
			failure_policy: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("fail_fast")], { description: "How other nodes react to a node's failure: independent (default; healthy nodes continue) or fail_fast (cancel remaining unfinished nodes, including parked loop-body agents, on failure)." })),
			agents: Type.Array(Type.Object({
				node_id: Type.Optional(Type.String({ minLength: 1, description: "Unique ID of this assignment within the run (letters, digits, _ . -; compared case-insensitively). Defaults to the persona name, so give distinct node_id values when several assignments use one persona. Status, reports and cleanup refer to the assignment by this ID." })),
				persona: Type.Optional(Type.String({ minLength: 1, description: "Persona name; case-insensitive. May repeat across nodes. Use together with node_id." })),
				name: Type.Optional(Type.String({ minLength: 1, description: "Legacy form for chains and teams: a persona name that is also the node ID (so it cannot repeat). Do not combine with persona or node_id, and not allowed in graphs." })),
				sub_task: Type.String({ minLength: 1, description: "This assignment's task" }),
				role: Type.Optional(Type.String({ minLength: 1, description: "Declared role for this assignment in the brief and bounded roster" })),
				ownership: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files, directories, or responsibilities owned by this assignment" })),
				read_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Relative (or project-scoped) paths/globs this assignment reads. Readers do not conflict with each other or block writers." })),
				write_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Relative (or project-scoped) paths/globs this assignment may write (\".\", \"*\", \"**\" = whole project). Disjoint writers run concurrently; overlapping writers serialize in plan order (a loop body holds ownership until finalization). Advisory shared-cwd contract, not a filesystem sandbox." })),
				acceptance_criteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Node-specific acceptance criteria" })),
				constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Node-specific constraints" })),
				output_contract: Type.Optional(outputContractSchema),
				decision: Type.Optional(Type.Object({
					field: Type.String({ minLength: 1, description: "Required string enum field in result.outputs whose value selects approve or reject" }),
					approve: Type.String({ minLength: 1, description: "Verdict value that fires forward edges and finalizes the loop body" }),
					reject: Type.String({ minLength: 1, description: "Verdict value that follows the feedback edge back to on_reject" }),
					on_reject: Type.String({ minLength: 1, description: "Node ID of the strict ancestor that revises on rejection" }),
					max_revisions: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum revisions for this loop (1–10; defaults to bootstrap.json graph.defaults.maxRevisions or 3; exceeding a ceiling fails planning)" })),
					on_exhausted: Type.Optional(Type.Union([Type.Literal("needs_attention"), Type.Literal("failed")], { description: "Decision node outcome when revisions or max_total_attempts are exhausted: needs_attention (default) or failed" })),
				}, { description: "Decision node configuration for a review loop in a node-form chain or graph: routes forward on approve or back along the feedback edge to on_reject on reject, re-running the loop body on parked agents." })),
				required_checks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Verification check IDs that must have passing, current evidence before completion/dependent admission" })),
				step: Type.Optional(Type.Integer({ minimum: 1, description: "Optional chain order. If supplied, supply unique contiguous values from 1 to the node count for all nodes. Not allowed for teams or graphs." })),
				predecessor: Type.Optional(Type.String({ description: "Optional chain consistency check naming the previous node ID; edges are derived from chain order." })),
				successor: Type.Optional(Type.String({ description: "Optional chain consistency check naming the next node ID; edges are derived from chain order." })),
				depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Graph nodes: node IDs this node depends on. Omit or empty for a root node that starts at release." })),
				join_policy: Type.Optional(Type.Union([Type.Literal("all_success"), Type.Literal("allow_partial")], { description: "Graph joins (nodes with multiple dependencies): all_success (default) requires every inbound edge to succeed; allow_partial admits a partial source. Per-edge dependency_policy still applies." })),
				dependency_policy: Type.Optional(Type.Union([Type.Literal("require_success"), Type.Literal("allow_partial")], { description: "Dependent nodes (chain followers and graph edges): how this node treats an inbound source's outcome. require_success (default for the node form and all_success joins): only a success admits it. allow_partial (default for the legacy name form and allow_partial joins): a partial result also admits it. A failed, blocked, skipped or cancelled source never admits it. Not allowed for teams or root nodes." })),
				task_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000, description: "Optional running-task duration deadline in ms per attempt for this node once admitted (overrides run-level task_timeout_ms)." })),
				dependency_wait_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000, description: "Dependent nodes: max wait in ms without useful upstream progress (overrides run-level dependency_wait_timeout_ms; default 300000ms)." })),
			}), { minItems: 1, maxItems: 32 }),
			project_cwd: Type.String({ minLength: 1, description: "Absolute project directory" }),
			request_id: Type.Optional(Type.String({ minLength: 1, description: "Idempotency key. Reusing this key with an equivalent plan (key order, persona-name case and explicit defaults do not matter) returns the original run, including its failure or interrupted state; a different plan is rejected. Use a new key for an intentional fresh launch." })),
			coms_extension: Type.Optional(Type.String({ description: "Path to coms.ts when it is not installed under project/extensions or alongside bootstrap.ts" })),
			ready_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000, description: "Readiness deadline after all launchers have been submitted; default 60000ms" })),
			task_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000, description: "Optional run-wide running-task duration deadline in ms per attempt measured from node admission (not launch/wait time); unset by default." })),
			dependency_wait_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000, description: "Optional max wait in ms for useful upstream progress on dependent nodes (heartbeats alone do not count); default 300000ms." })),
			liveness_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 86400000, description: "Optional diagnostic stall threshold in ms (live heartbeat without model/tool activity; never auto-kills; excludes parked agents); default 600000ms." })),
			cancel_grace_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000, description: "Optional grace period in ms after cancellation before force_close is allowed; default 5000ms." })),
			cleanup: Type.Optional(Type.Union([Type.Literal("on_success"), Type.Literal("manual")], {
				description: "Close the run's tabs automatically after all nodes succeed and delivery settles. Defaults to on_success for graphs and manual for chains and teams. Automatic cleanup retains session files.",
			})),
			cleanup_settle_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_CLEANUP_SETTLE_MS, description: "Minimum time since the last result of a still-live agent before automatic cleanup (default 3000ms)." })),
			max_total_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Run-wide attempt budget for a plan with a decision node (defaults to initial attempts plus allowed loop-body revisions; exceeding a bootstrap.json ceiling fails planning; launch requires at least the planned node count)" })),
			dry_run: Type.Optional(Type.Boolean({ description: "Validate and return the fully resolved plan (node IDs, persona files, models, tools, extensions, allowed skills, brief, contracts, deadlines, edges, joins, loop bodies, limits, cleanup) without creating tabs or files. Recommended before a first launch." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				if (params.dry_run) {
					const { dry_run: _dryRun, ...request } = params;
					const plan = service.plan(request as GenerateRequest, ctx.model);
					const next = "Launch with the same parameters and dry_run omitted.";
					return response(`Dry run OK — nothing was created.\n${formatPlan(plan)}\n${next}`, { status: "planned", plan });
				}
				const manifest = await service.generate({ ...params, request_id: params.request_id ?? toolCallId } as GenerateRequest, ctx.model, signal, manifest => {
					onUpdate?.(response(`Bootstrap ${manifest.task_id}: ${manifest.phase}`, publicManifest(manifest)));
				});
				const failed = manifest.status === "error";
				if (manifest.status === "applied" && (ctx.hasUI || manifest.cleanup_policy?.mode === "on_success") && !inAgentSession()) {
					try { await graphs.attach(manifest.task_id, ctx, service.status(manifest.task_id, ctx.cwd)); } catch { /* The launch already succeeded. */ }
				}
				const agents = formatLaunch(manifest);
				const legacyNote = manifest.collaboration_mode === "legacy" ? "\nNote: legacy request form retains existing peer messaging; migrate to persona/node_id for independent mode or set collaboration_mode explicitly." : "";
				return response(
					failed ? `Bootstrap failed: ${manifest.error}. task_id: "${manifest.task_id}". Partial resources are recorded; use bootstrap_cleanup to close them.\n${agents}` :
						`Bootstrap ${manifest.status}. task_id: "${manifest.task_id}". ${manifest.pane_manifest.length} agent(s); workspace ${manifest.workspace_id} (${manifest.workspace_strategy ?? "shared_cwd"}; mode ${manifest.collaboration_mode ?? "legacy"}; failure_policy ${manifest.failure_policy ?? "independent"}).${manifest.error ? ` Warning: ${manifest.error}.` : ""}${legacyNote}\n${agents}\n` +
						`Next: bootstrap_status with wait_ms to block until agents finish or need attention, then bootstrap_report without results.`,
					publicManifest(manifest), failed,
				);
			} catch (error) { return response(errorMessage(error), { status: "error", phase: "preflight", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_status", label: "Bootstrap Status",
		description: "Read per-agent progress (waiting/working/done/error, heartbeat age, last activity age, liveness diagnosis separately from useful progress and running-task duration, result summaries), pending node IDs, ownership waits (whether a queued writer is waiting on a running writer or held because a conflicting writer's execution is uncertain), agent errors and delivery errors from durable files. Liveness diagnosis distinguishes healthy, stalled (live heartbeat without useful activity), heartbeat_stale and exited without auto-killing agents; parked loop-body agents are never diagnosed as stalled. Each node also has an execution state: pending, waiting, running, succeeded, partial, failed, blocked, skipped, cancelled or needs_attention, plus attempt counters (attempt N/M), parked/finalized state, and last_verdict for review loops. A blocked, skipped or cancelled node did not execute (or was stopped): it has no result and shows the nodes that caused it (the original cause is kept across the whole dependency chain). needs_attention is unresolved (an agent or handoff problem, exhausted revisions, a dead parked agent, or tabs closed before an outcome): inspect it; it never admits dependants and the task is not replayed for you. Graph nodes also show derived edge states (pending, fired, dead) and joins show pending or dead inbound edges. Nodes with required_checks show their evidence (passing, missing, unverified, stale or failed), and recorded verification checks show result/applicability (current, stale or unknown). The run outcome aggregates all nodes (a parked node keeps the run unsettled until its loop settles). Dependent nodes also show their handoffs (handoff/handoffs_in and handoff_out/handoffs_out with an ID): queued (Coms acknowledged the notification), accepted (the successor claimed that exact saved input; evidence includes the input digest) or rejected (with the reason and recovery guidance), each independent of the node's execution state. A node whose handoff was accepted but has no result (its agent died or restarted) is needs_attention and the task is not replayed automatically; decide explicitly (inspect its effects, then clean up and start a new run if it should be redone). A handoff that was not delivered or accepted can be inspected and, when demonstrably unclaimed, re-sent with bootstrap_recover. Also evaluates and reports automatic cleanup (cleanup: on_success). Resource state (tab open/closed) is separate from execution state. Agents are listed by node ID, with their persona when it differs. Does not infer task completion from Herdr idle status. Pass wait_ms to block until every agent finished, any error appears, a task_timeout_ms deadline expires, or the wait expires — prefer this over repeated polling.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Block up to this long (max ${MAX_WAIT_MS}ms) until the run settles or needs attention. Default 0 (return immediately).` })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const status = params.wait_ms ? await service.waitForStatus(params.task_id, params.wait_ms, ctx.cwd, signal) : { ...await service.statusWithCleanup(params.task_id, ctx.cwd), timed_out: false };
				const total = status.manifest.pane_manifest.length;
				const isManaged = service.isFactoryManagedRun(params.task_id, ctx.cwd, status.manifest);
				const errors = [...status.worker_errors.map(error => `agent: ${error}`), ...status.delivery_errors.map(error => `delivery: ${error}`)];
				const next = formatAutomaticCleanup(status.manifest) ?? (status.manifest.status === "cleaned" ? "Run is cleaned up."
					: isManaged && status.manifest.status === "error"
					? (status.manifest.phase === "uncertain"
						? "Release state is uncertain; inspect via /factory inspect (direct bootstrap_cleanup is forbidden)."
						: status.manifest.phase === "held"
						? "Run did not release; capacity holds remain active. Inspect via /factory inspect (direct bootstrap_cleanup is forbidden)."
						: "Factory-managed run is in error; inspect via /factory inspect (direct bootstrap_cleanup is forbidden).")
					: isManaged && errors.length
					? "Needs attention: inspect the agent output or /factory inspect (direct bootstrap_cleanup and bootstrap_recover retry_delivery are forbidden for factory-managed runs)."
					: errors.length ? "Needs attention: for a handoff that was not delivered or accepted, run bootstrap_recover (action inspect) first; it re-sends only a handoff that was demonstrably never claimed (pass source as well as agent for a join node). Otherwise inspect the agent tab, or bootstrap_cleanup the affected nodes (agents parameter, by node ID). Do not re-run a task whose effects are uncertain without checking what it already did."
					: status.pending.length ? `${status.cleanup_wait_reason ? `${status.cleanup_wait_reason} ` : ""}${status.timed_out ? "Still running; call again with wait_ms." : "Still running."}`
					: `${status.cleanup_wait_reason ? `${status.cleanup_wait_reason} ` : ""}All agents finished (every node reached a final state): call bootstrap_report without results.`);
				const text = `Run ${status.manifest.task_id} [${status.manifest.status}/${status.manifest.phase}]: ${status.results.length}/${total} result(s); pending: ${status.pending.join(", ") || "none"}.` +
					(status.manifest.status === "error" && status.manifest.error ? `\nRun error: ${status.manifest.error}` : "") +
					`\n${formatAgentStates(status.agents, status.manifest.topology)}${errors.length ? `\nErrors:\n${errors.map(error => `- ${error}`).join("\n")}` : ""}` +
					`\n${formatRunOutcome(status.outcome, status.agents)}\n${next}`;
				return response(text, {
					...publicManifest(status.manifest), results: status.results, pending: status.pending, delivery_errors: status.delivery_errors, worker_errors: status.worker_errors,
					agents: status.agents, outcome: status.outcome, timed_out: status.timed_out,
					...(status.cleanup_wait_reason ? { cleanup_wait_reason: status.cleanup_wait_reason } : {}),
				});
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_recover", label: "Bootstrap Recover",
		description: "Repair an interrupted handoff (in a chain, graph, join, or feedback edge) from saved evidence, without re-running any work and without asking a model to reconstruct a result. action inspect (read-only) reconciles the source's saved result, the handoff offer, the successor's acceptance receipt, the successor's identity and its own result, and says where each edge's handoff stands: deliverable (the successor never claimed it and is the live agent the run launched), waiting, already accepted or finished, or needs_attention. action retry_delivery (agent = the successor node ID; also pass source for a join node) re-sends the same handoff (same ID, same saved input) to a successor whose handoff is demonstrably unclaimed (it never accepted it), even if the source has exited; it needs no new confirmation because it starts no new work: the successor still validates the handoff and claims it exactly once itself. It never replaces the original result, never resets or overrides a claim, and does not re-run any task. A Coms acknowledgement of the re-send is delivery, not acceptance: check bootstrap_status for the successor's accepted handoff. Anything uncertain is needs_attention and nothing is sent: work that was accepted but has no result (its effects are unknown), execution evidence without a receipt, an unreadable receipt, result or offer, a successor that has gone or refused the handoff, a plan that changed, or a run that was cleaned up or cancelled. Those need an explicit decision (inspect the effects, then bootstrap_cleanup and a new run with a new request_id); starting a new run is a different decision from retrying delivery and is never made for you. Recovery is serialized with launch and cleanup, bounded (one re-send per 30s wait window, up to 5 attempts, within the successor's dependency_wait_timeout_ms window — default 5 minutes) and requires Coms loaded in this session, because the successor accepts a re-send only from the dispatcher's recorded Coms session.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1, description: "The run ID" }),
			action: Type.Union([Type.Literal("inspect"), Type.Literal("retry_delivery")], { description: "inspect: read-only reconciliation of every inbound edge handoff (or one). retry_delivery: re-send the same unclaimed handoff to one successor." }),
			agent: Type.Optional(Type.String({ minLength: 1, description: "The successor node ID (or instance ID) whose inbound handoff to inspect or repair. Required for retry_delivery; inspect covers every edge without it. To repair delivery from a node, name its successor." })),
			source: Type.Optional(Type.String({ minLength: 1, description: "For join nodes with multiple inbound edges: the source node ID (or instance ID) whose inbound handoff to repair." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const report = await service.recover(params.task_id, { action: params.action, agent: params.agent, ...(params.source !== undefined ? { source: params.source } : {}) }, { cwd: ctx.cwd, signal, wake: wakeViaComs((name, args, options) => ctx.executeTool(name, args, options) as any) });
				const failed = report.refused !== undefined || report.assessments.some(item => item.verdict === "needs_attention") || report.delivery?.transport === "failed";
				const recoverStatus = report.delivery?.transport === "acknowledged" ? "re-sent"
					: report.delivery?.transport === "failed" ? "delivery_failed"
					: report.refused ? "not_retried"
					: "inspected";
				return response(formatRecovery(report), { status: recoverStatus, ...report }, failed && params.action === "retry_delivery" && report.delivery?.transport !== "acknowledged");
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_report", label: "Bootstrap Report",
		description: "Persist report.json and optionally report.md. Omit results to collect agent results automatically (all agents must have finished, or have a recorded final state: a node that did not execute because it was blocked, skipped or cancelled is listed from its record with its causes and has no result; needs_attention is unresolved and refuses automatic collection until resolved). Looped nodes include per-attempt history and verdict history, and blocked joins list their causes. Explicit results must contain exactly one result per node that executed, identified by node_id (agent_name alone is accepted only when exactly one node uses that persona); a node that did not execute (blocked, skipped, cancelled) cannot be given a result and is added from its record. Reports remain writable after bootstrap_cleanup (including automatic cleanup) unless delete_session_files=true deleted the session directory. The report ends with the run outcome (needs_attention, incomplete, failed, blocked, cancelled, skipped, partial or succeeded; only all-success is succeeded). task_id is the run ID, not the workspace ID.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			results: Type.Optional(Type.Array(resultSchema)),
			write_markdown: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const paths = await service.report(params.task_id, params.results as BootstrapResult[] | undefined, params.write_markdown ?? false, buildMarkdownReport, ctx.cwd);
				return response(`Report saved: ${paths.report_json}${paths.report_md ? ` (+ ${paths.report_md})` : ""}\n${formatReportDigest(paths.results)}`, { status: "saved", ...paths });
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_cancel", label: "Bootstrap Cancel",
		description: "Stop released or launching work gracefully for a whole run or selected nodes (by node_id, instance_id, or unique persona), separate from closing tabs and deleting files. Persists durable cancellation intent before signalling agents; agents observe it after release, deny new task admission and new completions, preserve results already committed before cancellation, propagate cancellation through loop bodies (including parked agents), and mark downstream dependents that will not run as blocked. Note: a hook cannot undo a tool side effect already in progress, so active tool work stays cancelling until it settles or is explicitly force-closed. After the grace period (default 5000ms), call again with force_close=true to close verified owned tabs/panes for the cancelled nodes without deleting session files or reports.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional subset by node ID, instance ID, or unique persona name. Omit to cancel the whole run." })),
			reason: Type.Optional(Type.String({ description: "Human-readable reason recorded on the cancellation and disposition records." })),
			grace_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000, description: "Grace period in ms before force_close=true is permitted (defaults to manifest cancel_grace_ms or 5000ms)." })),
			force_close: Type.Optional(Type.Boolean({ description: "Explicitly close verified owned tabs/panes for already-cancelled nodes after the grace period has elapsed. Does not delete session files or reports. Default false." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const result = await service.cancel(params.task_id, {
					agents: params.agents,
					reason: params.reason,
					grace_ms: params.grace_ms,
					force_close: params.force_close,
					cwd: ctx.cwd,
					signal,
				});
				const failed = result.cleanup_errors.length > 0;
				return response(formatCancelResult(result), { ...result, manifest: publicManifest(result.manifest) }, failed);
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_cleanup", label: "Bootstrap Cleanup",
		description: "Close tabs owned by a bootstrap run (a resource operation separate from bootstrap_cancel, which stops work without closing tabs or deleting files; closing tabs does not erase recorded results or prevent writing reports, though a full cleanup of an unfinalized review loop finalizes parked nodes on the decision node's last reviewed attempt—settling an unfinalized rejection as failed). Select agents by node ID or instance ID; a persona name is accepted only when exactly one node uses it, and an ambiguous selector is rejected without closing anything. Re-resolves live IDs before closing and retains recovery state on failure. Session files and reports are kept by default; set delete_session_files=true to delete them only after every owned tab is closed. Safe to retry.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional subset by node ID or instance ID (e.g. review-ui or a2-review-ui); a persona name works only when it names exactly one node. Preferred over tab_ids, which can go stale when Herdr compacts IDs." })),
			tab_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional subset of tab IDs as recorded in the manifest; unrelated IDs are rejected. Omit both agents and tab_ids to close all owned tabs, including ambiguous partial launches." })),
			delete_session_files: Type.Optional(Type.Boolean({ description: "Explicitly delete session files and reports after all tabs are closed. Default false." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const manifest = await service.cleanup(params.task_id, params.tab_ids, params.delete_session_files ?? false, ctx.cwd, signal, params.agents);
				const closed = manifest.pane_manifest.filter(entry => entry.status === "closed").length;
				const open = manifest.pane_manifest.filter(entry => entry.status !== "closed" && entry.status !== "planned").length;
				// Closing a requested subset successfully is not a failure, even though other tabs stay open.
				const subset = params.tab_ids !== undefined || params.agents !== undefined;
				const failed = (manifest.cleanup_errors?.length ?? 0) > 0 || (!subset && manifest.status !== "cleaned");
				const files = manifest.session_files_deleted ? "deleted" : manifest.session_dir_removed ? "unavailable (project session directory is missing)" : "retained (including reports)";
				const notes = manifest.cleanup_notes?.length ? ` Notes: ${manifest.cleanup_notes.join("; ")}.` : "";
				const text = failed ? `Cleanup incomplete: ${manifest.cleanup_errors?.join("; ") || "some owned tabs remain"}. Session files retained for retry.`
					: manifest.status === "cleaned" ? `Cleanup complete. Session files ${files}.`
					: `Closed the selected tab(s); ${open} owned tab(s) remain open.${params.delete_session_files ? " Session files were kept because the run still has open tabs." : ""}`;
				return response(text + notes,
					{ ...publicManifest(manifest), tabs_closed: closed, tabs_total: manifest.pane_manifest.length, session_dir_removed: manifest.session_dir_removed ?? false, session_files_deleted: manifest.session_files_deleted ?? false }, failed,
				);
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerCommand("boot", {
		description: "Bootstrap help and recent runs; /boot <task_id> shows one run's status",
		handler: async (args, ctx) => {
			const taskId = typeof args === "string" ? args.trim() : "";
			try {
				if (taskId) {
					const status = await service.statusWithCleanup(taskId, ctx.cwd);
					const cleanup = formatAutomaticCleanup(status.manifest) ?? status.cleanup_wait_reason;
					ctx.ui.notify(`Run ${taskId} [${status.manifest.status}/${status.manifest.phase}]\n${formatAgentStates(status.agents, status.manifest.topology)}\n${formatRunOutcome(status.outcome, status.agents)}${cleanup ? `\n${cleanup}` : ""}`, status.worker_errors.length || status.delivery_errors.length || status.manifest.cleanup_errors?.length ? "warning" : "info");
					return;
				}
				const runs = service.list(8);
				ctx.ui.notify("Ask the dispatcher to bootstrap a chain, team, or graph. Tools: bootstrap_generate (dry_run first; give each assignment a node_id and persona; dependencies require a successful predecessor unless dependency_policy or join_policy says allow_partial; use decision for bounded review loops) → bootstrap_status (wait_ms; execution states, edges, joins, loop attempts, liveness, deadlines and run outcome; bootstrap_recover for an interrupted handoff) → bootstrap_cancel (stop work gracefully without deleting files; optional force_close after grace) → bootstrap_report → bootstrap_cleanup (by node ID; on_success is automatic for graphs). /bootgraph <task_id> shows the live graph widget. Cleanup keeps reports unless delete_session_files=true." +
					(runs.length ? `\nRecent runs (/boot <task_id> for details):\n${formatRunList(runs)}` : "\nNo recorded runs."), "info");
			} catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
		},
	});
	pi.registerCommand("bootgraph", {
		description: "Show a bootstrap run's live graph with /bootgraph <task_id>, or remove all graphs with /bootgraph clear",
		handler: async (args, ctx) => {
			if (inAgentSession()) return;
			const taskId = args.trim();
			if (taskId === "clear") graphs.clear();
			else if (!taskId && ctx.hasUI) ctx.ui.notify("Usage: /bootgraph <task_id> or /bootgraph clear", "info");
			else if (taskId) {
				try { await graphs.attach(taskId, ctx); }
				catch (error) { if (ctx.hasUI) ctx.ui.notify(errorMessage(error), "error"); }
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		revokeManagerAuthority(activeAuthority);
		sessionShutDown = false;
		activeBinding = currentBinding(ctx);
		activeAuthority = createManagerAuthority(activeBinding);
		graphs.reset();
		applyExtensionDefaults(import.meta.url, ctx);
	});
	pi.on("session_shutdown", async () => {
		revokeManagerAuthority(activeAuthority);
		activeAuthority = undefined;
		activeBinding = undefined;
		sessionShutDown = true;
		graphs.reset();
	});
}
