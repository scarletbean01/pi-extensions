/** Herdr-native bootstrap: preflight → durable plan → readiness barrier → release → recoverable cleanup. */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piAgentDir } from "./bootstrap/bootstrap-utils.ts";
import { constraintsFileSnapshotState, formatLearnedConstraintsSummary, readProjectConstraints } from "./bootstrap/constraints.ts";
import { formatRiskLaneSummary } from "./bootstrap/lanes.ts";
import { BootstrapService, MAX_WAIT_MS, type GenerateRequest } from "./bootstrap/lifecycle.ts";
import { buildMarkdownReport, formatAgentStates, formatAutomaticCleanup, formatCancelResult, formatLaunch, formatPlan, formatRecovery, formatReportDigest, formatRunList, formatRunOutcome } from "./bootstrap/reporting.ts";
import { createGraphWidgets } from "./bootstrap/graph-widget.ts";
import { wakeViaComs } from "./bootstrap/recovery.ts";
import { errorMessage, isRecord, MAX_CLEANUP_SETTLE_MS, type BootstrapManifest, type BootstrapResult } from "./bootstrap/session-store.ts";
import { outputContractSchema, resultSchema } from "./bootstrap/schemas.ts";
import { applyExtensionDefaults } from "./themeMap.ts";
import { openBriefEditor } from "./factory/editor.ts";
import { buildQueueView, formatQueueTable } from "./factory/queue.ts";
import { createFactoryQueueScheduler } from "./factory/scheduler.ts";
import { getFactoryViewerStatus, startFactoryViewer, stopFactoryViewer } from "./factory/viewer-command.ts";
import { VERSION_PATTERN } from "./bootstrap/factory-records.ts";
import {
	createManagerAuthority,
	defaultFactoryStorePath,
	factoryOperations,
	MAX_BRIEF_BYTES,
	MAX_QUEUED_INPUTS,
	revokeManagerAuthority,
	validateFactoryToken,
	type BindingView,
	type ConstraintConfirmationBinding,
	type ConstraintConfirmationTarget,
	type ConstraintConflictTarget,
	type ConstraintProposalView,
	type Inspection,
	type ManagerAuthority,
	type SessionBinding,
	heldReleasedAttempt,
} from "./factory/operations.ts";

function response(text: string, details: Record<string, unknown>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function publicManifest(manifest: BootstrapManifest): Record<string, unknown> {
	// Acknowledgement tokens are internal; callers only need identities and recovery state.
	const { token: _token, ...visible } = manifest;
	return visible;
}

/** Plain-language account of which version a factory-managed run is bound to and which of its settings stay live. */
type ManagedBinding =
	| (BindingView & { binding_verified: true; state_db_path: string })
	| { binding_verified: true; factory_id: string; bound_version: string; bound_retained: false; error: string; state_db_path: string }
	| { binding_verified: false; claimed_factory_id: string; claimed_bound_version: string; bound_retained: false; error: string };

function formatFactoryBinding(binding: ManagedBinding): string {
	if (!binding.binding_verified) {
		return `Factory version: UNVERIFIED (the run records ${binding.claimed_bound_version} of factory ${binding.claimed_factory_id}, but its own evidence does not confirm it). ${binding.error}`;
	}
	const full = "runtime_assumptions" in binding ? binding : undefined;
	const current = full?.current_version;
	const head = current === undefined
		? `Factory version: bound ${binding.bound_version}; current version unknown${full?.current_error ? ` (${full.current_error})` : ""}`
		: full!.bound_matches_current
			? `Factory version: bound ${binding.bound_version} (also the current version)${full!.current_error ? `; current version unverifiable: ${full!.current_error}` : ""}`
			: `Factory version: bound ${binding.bound_version}; current ${current} (this run keeps its bound version)${full!.current_error ? `; current version definition unverifiable: ${full!.current_error}` : ""}`;
	const lines = [binding.bound_retained ? `${head}.` : `${head}. Bound version unavailable: ${binding.error ?? "not retained"}`];
	if (full?.node_policies) {
		for (const [nodeId, policy] of Object.entries(full.node_policies)) {
			if (policy.kind === "command") {
				lines.push(`  ${nodeId}: deterministic command node (${policy.command} in ${policy.working_directory}; no persona, model, thinking level, tools, or skills)`);
				continue;
			}
			const parts = [
				policy.tools.mode === "inherit" ? "tools inherit live Pi runtime availability" : `tools declared (${policy.tools.names.join(", ") || "none"})`,
				policy.skills.mode === "inherit" ? "skills inherit live Pi runtime availability" : `skills declared (${policy.skills.names.join(", ") || "none"})`,
				"extensions inherit live Pi extensions plus declared additions",
			];
			lines.push(`  ${nodeId}: ${parts.join("; ")}`);
		}
		lines.push("  Not frozen with the version: installed extension/skill contents, the Pi runtime, provider credentials and checkout contents.");
	}
	return lines.join("\n");
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

	const factoryStore = defaultFactoryStorePath();
	const factory = factoryOperations(factoryStore, service);
	const samePath = (a: string, b: string): boolean => {
		const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
		return canonical(a) === canonical(b);
	};
	/**
	 * Read-only bound-vs-current view of a factory-managed run, shared by status and report. Only a binding that the run's own evidence verifies
	 * (the service's shared release-evidence check: run-local manifest, sidecar and index agree, and the durable attempt and input records record
	 * the same bound version) is shown as the run's bound version, and only its verified state database is read, which may live under another root
	 * than this session's default store. A claim that is not verified, such as an indexed manifest naming another version, is labelled unverified
	 * and carries no policy, equality or retention claim; a default-looking path is not proof. It never infers current from bound.
	 */
	const managedBindingFor = (manifest: BootstrapManifest): ManagedBinding | undefined => {
		const claimed = manifest.factory_managed;
		if (!claimed) return undefined;
		const verified = service.verifiedFactoryBinding(manifest);
		if (!verified) {
			return {
				binding_verified: false,
				claimed_factory_id: claimed.factory_id,
				claimed_bound_version: claimed.bound_version,
				bound_retained: false,
				error: "The run's factory binding is unverified: its recorded version and state database are not confirmed by the run's own manifest, attempt and input evidence, so no version lookup was made and no policy, current-version or retention claim is shown",
			};
		}
		const unavailable = (error: string): ManagedBinding => ({ binding_verified: true, factory_id: verified.factory_id, bound_version: verified.bound_version, bound_retained: false, error, state_db_path: verified.state_db_path });
		try {
			const view = (samePath(verified.state_db_path, factoryStore) ? factory : factoryOperations(verified.state_db_path, service))({ action: "binding", factory_id: verified.factory_id, bound_version: verified.bound_version });
			return { ...view, binding_verified: true, state_db_path: verified.state_db_path };
		} catch (error) { return unavailable(errorMessage(error)); }
	};
	const proposalsForRun = (
		binding: ManagedBinding | undefined,
		runId: string,
	): { proposals?: ConstraintProposalView[]; error?: string } => {
		if (!binding || !binding.binding_verified) return {};
		try {
			const ops = samePath(binding.state_db_path, factoryStore) ? factory : factoryOperations(binding.state_db_path, service);
			return { proposals: ops({ action: "proposals", factory_id: binding.factory_id, run_id: runId }) };
		} catch (error) {
			return { error: errorMessage(error) };
		}
	};

	const formatProposalSummaryLine = (state: { proposals?: ConstraintProposalView[]; error?: string }): string => {
		if (state.error) return `\nConstraint proposals unavailable: ${state.error}`;
		const list = state.proposals;
		if (!list || list.length === 0) return "";
		const pending = list.filter(p => p.outcome === "pending").length;
		const confirmed = list.filter(p => p.outcome === "confirmed").length;
		const rejected = list.filter(p => p.outcome === "rejected").length;
		const duplicates = list.filter(p => p.outcome === "dropped_duplicate").length;
		const parts = [
			pending ? `${pending} pending` : undefined,
			confirmed ? `${confirmed} confirmed` : undefined,
			rejected ? `${rejected} rejected` : undefined,
			duplicates ? `${duplicates} duplicate` : undefined,
		].filter(Boolean);
		return `\nConstraint proposals: ${list.length} (${parts.join(", ") || "none"})`;
	};

	const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const FACTORY_SUBCOMMANDS = [
		"list", "inspect", "queue", "receipt", "viewer", "publish", "update", "restore", "resume", "takeover",
		"stop", "discard", "delete", "submit", "launch", "retry", "cancel", "settle", "clear", "redeliver",
		"requests", "respond", "wake", "proposals", "review-proposal", "retire-constraint", "resolve-conflict",
	] as const;
	const FACTORY_TARGET_SUBCOMMANDS = new Set<string>(FACTORY_SUBCOMMANDS.filter(action => action !== "list" && action !== "publish" && action !== "viewer"));

	/**
	 * Resolve a user/tool-supplied factory token (UUID factory_id or exact case-sensitive factory name)
	 * once at the command/tool boundary. An existing factory_id always wins over a matching name.
	 */
	const resolveFactoryTarget = (rawToken: unknown): { factoryId: string; factoryName: string } => {
		const token = validateFactoryToken(rawToken, "factory_id");
		const identities = factory({ action: "identities" });
		const idMatch = identities.find(row => row.factory_id === token);
		if (idMatch) return { factoryId: idMatch.factory_id, factoryName: idMatch.name };
		const nameMatches = identities.filter(row => row.name === token);
		if (UUID_PATTERN.test(token) && nameMatches.length > 0) {
			throw new Error(
				`Ambiguous factory token "${token}": looks like a UUID, does not match any factory_id, and matches factory name on ${nameMatches.map(m => `${m.name} (${m.factory_id})`).join(", ")}; pass the factory_id UUID instead`,
			);
		}
		if (nameMatches.length > 1) {
			throw new Error(
				`Ambiguous factory name "${token}": matches multiple factories (${nameMatches.map(m => m.factory_id).join(", ")}); pass the exact factory_id UUID instead`,
			);
		}
		if (nameMatches.length === 1) {
			return { factoryId: nameMatches[0]!.factory_id, factoryName: nameMatches[0]!.name };
		}
		const available = identities.length > 0
			? `Available names: ${identities.map(row => row.name).join(", ")}`
			: "No factories are published";
		throw new Error(`Factory not found: ${token} (tried factory_id and exact name). ${available}`);
	};

	const formatConstraintReview = (opts: {
		action: "add" | "retire";
		factoryId?: string;
		factoryName?: string;
		proposalId: string;
		text: string;
		constraintId?: string;
		provenance: { run_id?: string; attempt_id?: string; evidence_ref?: string; note?: string };
		conflictingIds: string[];
		activeConstraints: Array<{ id: string; text: string }>;
	}): string => {
		const conflictSet = new Set(opts.conflictingIds);
		const activeLines = opts.activeConstraints.length > 0
			? opts.activeConstraints.map(item => `  - ${item.id}${conflictSet.has(item.id) ? " [CONFLICT]" : " [active]"}: ${item.text}`).join("\n")
			: "  (none)";
		return [
			...(opts.factoryId ? [`Factory: ${opts.factoryName ?? opts.factoryId} (${opts.factoryId})`] : []),
			`Constraint proposal ${opts.proposalId} (action: ${opts.action}${opts.constraintId ? `, id: ${opts.constraintId}` : ""})`,
			`Proposed text: ${opts.text}`,
			...(opts.provenance.note ? [`Note / reason: ${opts.provenance.note}`] : []),
			`Provenance: run=${opts.provenance.run_id ?? "?"} attempt=${opts.provenance.attempt_id ?? "?"} evidence=${opts.provenance.evidence_ref ?? "?"}`,
			`Named conflicts: ${opts.conflictingIds.length ? opts.conflictingIds.join(", ") : "none"}`,
			`Active constraints (${opts.activeConstraints.length}):`,
			activeLines,
		].join("\n");
	};

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
			throw new Error("Session binding changed while the command was suspended; aborted without writing");
		}
	};

	/**
	 * Publication ownership for /factory update and /factory restore. A factory that is managed when the command starts needs this session's live
	 * manager authority, captured with the session binding and re-checked after each suspension and inside the commit transaction; a human
	 * confirmation never grants it. An unmanaged target needs no authority (none is created), and if it becomes managed while the command is
	 * suspended the operation refuses because this command holds no authority for it.
	 */
	const capturePublicationOwnership = (
		ctx: { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } },
		target: { management: string },
		factoryId: string,
	): { request: { authority?: ManagerAuthority; assertAuthority?: () => void }; assertLive: () => void } => {
		if (target.management !== "managed") {
			// Explicit publication needs no manager capability for an unmanaged target, but it still belongs to
			// the Pi session that initiated the editor/confirmation flow. Do not let a suspended command
			// publish after that session has switched or shut down.
			const capturedBinding = currentBinding(ctx);
			return { request: {}, assertLive: () => {
				if (sessionShutDown) throw new Error("Session has shut down; publication was aborted without writing");
				if (!sameBinding(capturedBinding, currentBinding(ctx))) {
					throw new Error("Session binding changed while publication was suspended; aborted without writing");
				}
			} };
		}
		const capturedBinding = currentBinding(ctx);
		const authority = ensureAuthority(ctx);
		factory({ action: "verify_manager", factory_id: factoryId, authority });
		const assertLive = () => assertLiveAuthority(ctx, authority, capturedBinding);
		return { request: { authority, assertAuthority: assertLive }, assertLive };
	};

	const ALLOWED_FACTORY_INSPECT_KEYS = new Set(["action", "factory_id", "reference", "input_id", "version", "open"]);
	pi.registerTool({
		name: "factory_inspect", label: "Factory Inspect",
		description: "Read-only discovery, definition inspection, compact queue inspection, and receipt recovery for explicitly published software factories. Opening, inspection, queue listing, and receipt lookup never resume management, mutate queue state, or launch runs.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("receipt"), Type.Literal("queue")]),
			factory_id: Type.Optional(Type.String({ minLength: 1, description: "Published factory ID (UUID) or exact factory name; required for inspect, receipt, and queue." })),
			reference: Type.Optional(Type.String({ minLength: 1, description: "Literal submission reference for receipt recovery; pass either reference or input_id." })),
			input_id: Type.Optional(Type.String({ minLength: 1, description: "Accepted input ID for receipt recovery; pass either reference or input_id." })),
			version: Type.Optional(Type.String({ pattern: "^v[1-9][0-9]*$", description: "inspect only: read one retained version (for example v1) instead of the current one. Reading never changes the current version, queue bindings or management." })),
			open: Type.Optional(Type.Boolean({ description: "queue only: when true, show only unfinished inputs (queued, launching, running, or needing attention)." })),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			try {
				if (!isRecord(params)) throw new Error("factory_inspect requires an object parameter");
				for (const key of Object.keys(params)) {
					if (!ALLOWED_FACTORY_INSPECT_KEYS.has(key)) throw new Error(`factory_inspect does not accept parameter "${key}"`);
				}
				if (params.action === "list") {
					if (params.factory_id !== undefined || params.reference !== undefined || params.input_id !== undefined || params.version !== undefined || params.open !== undefined) {
						throw new Error('factory_inspect action "list" does not accept factory_id, reference, input_id, version, or open');
					}
					const result = factory({ action: "list" });
					return response(JSON.stringify(result, null, 2), { result });
				}
				if (params.action === "inspect") {
					if (typeof params.factory_id !== "string" || !params.factory_id.trim()) {
						throw new Error('factory_inspect action "inspect" requires a non-empty factory_id');
					}
					if (params.reference !== undefined || params.input_id !== undefined || params.open !== undefined) {
						throw new Error('factory_inspect action "inspect" does not accept reference, input_id, or open');
					}
					if (params.version !== undefined && (typeof params.version !== "string" || !VERSION_PATTERN.test(params.version))) {
						throw new Error('factory_inspect "version" must be a version token like "v1"');
					}
					const { factoryId } = resolveFactoryTarget(params.factory_id);
					const result = factory({ action: "inspect", factory_id: factoryId, ...(params.version !== undefined ? { version: params.version } : {}) });
					return response(JSON.stringify(result, null, 2), { result });
				}
				if (params.action === "queue") {
					if (typeof params.factory_id !== "string" || !params.factory_id.trim()) {
						throw new Error('factory_inspect action "queue" requires a non-empty factory_id');
					}
					if (params.reference !== undefined || params.input_id !== undefined || params.version !== undefined) {
						throw new Error('factory_inspect action "queue" does not accept reference, input_id, or version');
					}
					if (params.open !== undefined && typeof params.open !== "boolean") {
						throw new Error('factory_inspect "open" must be a boolean');
					}
					const { factoryId } = resolveFactoryTarget(params.factory_id);
					const inspection = factory({ action: "inspect", factory_id: factoryId });
					const result = buildQueueView(inspection, params.open === true);
					return response(JSON.stringify(result, null, 2), { result });
				}
				if (params.action === "receipt") {
					if (typeof params.factory_id !== "string" || !params.factory_id.trim()) {
						throw new Error('factory_inspect action "receipt" requires a non-empty factory_id');
					}
					if (params.version !== undefined || params.open !== undefined) throw new Error('factory_inspect action "receipt" does not accept version or open');
					const hasRef = params.reference !== undefined;
					const hasId = params.input_id !== undefined;
					if (hasRef === hasId) {
						throw new Error('factory_inspect action "receipt" requires exactly one of reference or input_id');
					}
					const { factoryId } = resolveFactoryTarget(params.factory_id);
					const result = hasRef
						? factory({ action: "receipt", factory_id: factoryId, reference: params.reference as string })
						: factory({ action: "receipt", factory_id: factoryId, input_id: params.input_id as string });
					return response(JSON.stringify(result, null, 2), { result });
				}
				throw new Error('factory_inspect action must be "list", "inspect", "receipt", or "queue"');
			} catch (error) { return response(errorMessage(error), {}, true); }
		},
	});

	const ALLOWED_FACTORY_PROPOSE_KEYS = new Set([
		"factory_id", "run_id", "attempt_id", "evidence_ref",
		"proposal_action", "target_constraint_id", "constraint_id",
		"text", "conflicting_ids", "reference",
	]);
	pi.registerTool({
		name: "factory_propose_constraint", label: "Factory Propose Constraint",
		description: "Propose a learned constraint addition or retirement after a finished factory run that needed at least one revision or human intervention. Proposals are queued for explicit human review only and never confirm, retire, or write .pi/constraints.json.",
		parameters: Type.Object({
			factory_id: Type.String({ minLength: 1, description: "Published factory ID" }),
			run_id: Type.String({ minLength: 1, description: "Finished factory run ID justifying this proposal" }),
			attempt_id: Type.String({ minLength: 1, description: "Specific attempt ID from that run as provenance" }),
			evidence_ref: Type.String({ minLength: 1, description: "Evidence reference tying the proposal to recorded run evidence" }),
			proposal_action: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("retire")], { description: "Proposal kind: add (default) or retire an existing constraint." })),
			target_constraint_id: Type.Optional(Type.String({ minLength: 1, description: "For retire proposals: existing active constraint ID to propose retiring." })),
			constraint_id: Type.Optional(Type.String({ minLength: 1, description: "For add proposals: optional constraint identifier hint." })),
			text: Type.Optional(Type.String({ minLength: 1, description: "For add proposals: single-sentence learned constraint text (bounded UTF-8, no control characters or prompt-structure headers)." })),
			conflicting_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional existing active constraint IDs to highlight next to this proposal during human review." })),
			reference: Type.Optional(Type.String({ minLength: 1, description: "Optional idempotency reference so retrying after a lost acknowledgement returns the recorded proposal." })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				if (inAgentSession()) {
					throw new Error("factory_propose_constraint cannot run from a Bootstrap worker session");
				}
				if (!isRecord(params)) throw new Error("factory_propose_constraint requires an object parameter");
				for (const key of Object.keys(params)) {
					if (!ALLOWED_FACTORY_PROPOSE_KEYS.has(key)) throw new Error(`factory_propose_constraint does not accept parameter "${key}"`);
				}
				const factoryId = validateFactoryToken(params.factory_id as string, "factory_id");
				const capturedBinding = currentBinding(ctx);
				const authority = ensureAuthority(ctx);
				const result = factory({
					action: "propose_constraint",
					factory_id: factoryId,
					authority,
					assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
					...(params.proposal_action !== undefined ? { proposal_action: params.proposal_action as "add" | "retire" } : {}),
					...(params.target_constraint_id !== undefined ? { target_constraint_id: params.target_constraint_id as string } : {}),
					...(params.constraint_id !== undefined ? { constraint_id: params.constraint_id as string } : {}),
					...(params.text !== undefined ? { text: params.text as string } : {}),
					run_id: params.run_id as string,
					attempt_id: params.attempt_id as string,
					evidence_ref: params.evidence_ref as string,
					...(params.conflicting_ids !== undefined ? { conflicting_ids: params.conflicting_ids as string[] } : {}),
					...(params.reference !== undefined ? { reference: params.reference as string } : {}),
				});
				return response(JSON.stringify(result, null, 2), result);
			} catch (error) { return response(errorMessage(error), {}, true); }
		},
	});

	/** Shared preamble of the manager commands that act on a factory's current run: usage, worker-session and UI guards, then binding and authority. */
	const beginManagerCommand = (ctx: any, rest: string[], opts: { usage: string; args: number | [number, number]; subject: string; needsUi: boolean }) => {
		const [min, max] = Array.isArray(opts.args) ? opts.args : [opts.args, opts.args];
		if (rest.length < min || rest.length > max) throw new Error(`Usage: ${opts.usage}`);
		if (inAgentSession()) throw new Error(`Factory ${opts.subject} cannot run from a Bootstrap worker session`);
		if (opts.needsUi && !ctx.hasUI) throw new Error(`Factory ${opts.subject} requires an interactive Pi session with a UI`);
		const { factoryId, factoryName } = resolveFactoryTarget(rest[0]);
		return { factoryId, factoryName, capturedBinding: currentBinding(ctx), authority: ensureAuthority(ctx) };
	};

	/** Live presentation only. Inspection, receipts and run records remain the source of truth. */
	type FactoryWatch = {
		ctx: ExtensionCommandContext;
		authority: ManagerAuthority;
		scheduler: ReturnType<typeof createFactoryQueueScheduler>;
		alerts: Set<string>;
		status?: string;
		error?: string;
	};
	const watchedFactories = new Map<string, FactoryWatch>();
	let alertTimer: ReturnType<typeof setInterval> | undefined;
	const statusKey = (factoryId: string) => `factory-${factoryId}`;
	const showFactory = (watch: FactoryWatch, factoryId: string, view: Inspection) => {
		if (watchedFactories.get(factoryId) !== watch) return;
		const head = view.head_status;
		const blocker = head.without_control_fence ?? head;
		const hold = view.capacity.blocking_hold;
		const active = view.attempts.find(item => !item.historical && item.attempt_id === hold?.attempt_id);
		const management = view.control_error ? "control uncertain" : view.stopped ? "stopped" : view.factory.management;
		const headState = head.eligible ? "ready" : head.without_control_fence && blocker.input_id && !blocker.eligible
			? `${head.blocking_kind}/${blocker.blocking_kind}` : head.blocking_kind;
		const alerts = new Set<string>();
		for (const item of view.requests ?? []) {
			if (item.can_respond) alerts.add(`${item.exhaustion ? "Revision escalation" : `${item.node_id} is waiting for your direction`}: ${item.question} (answer with /factory respond ${factoryId} ${item.request_id})`);
			else if (item.can_redeliver) alerts.add(`Response recorded for ${item.request_id}, awaiting consumption. To resend only the wake-up: /factory wake ${factoryId} ${item.request_id}`);
			else if (item.reconciliation === "uncertain") alerts.add(`Direction request ${item.request_id} needs inspection: ${item.recovery_reason}`);
		}
		for (const item of view.attention) {
			if (item.kind === "constraint_proposal") {
				alerts.add(`${item.proposal_id ? `Constraint proposal ${item.proposal_id}` : "Constraint proposals"}: ${item.reason}`);
			} else if (item.kind !== "intervention") {
				alerts.add(`${item.kind === "failed_run" ? "Failed run" : item.kind === "report_notice" ? "Node counts unavailable" : "Uncertain evidence"}${item.task_id ? ` ${item.task_id}` : ""}: ${item.reason}`);
			}
		}
		if (blocker.input_id && !blocker.eligible && (blocker.blocking_kind !== "factory_held" || view.attempts.some(item => item.retry_eligibility?.eligible))) {
			alerts.add(`FIFO head ${blocker.reference} (${blocker.input_id}, bound ${blocker.bound_version}) is blocked: ${blocker.reason}`);
		}
		for (const alert of alerts) {
			if (!watch.alerts.has(alert)) watch.ctx.ui.notify(`Factory ${factoryId}: ${alert}`, "warning");
		}
		watch.alerts = alerts;
		const activeRollbacks = active?.node_counts?.reduce((sum, item) => sum + item.rollbacks, 0);
		watch.status = [
			`${view.factory.name}: ${management} ${view.current_error ? "version uncertain" : view.factory.current_version}`,
			`queue ${view.capacity.queue_used}`,
			head.input_id ? `head ${head.reference}@${head.bound_version} ${headState}` : headState,
			active ? `run ${active.task_id}@${active.bound_version}` : undefined,
			activeRollbacks !== undefined && activeRollbacks > 0 ? `${activeRollbacks} rollback${activeRollbacks === 1 ? "" : "s"}` : undefined,
			alerts.size ? `${alerts.size} attention` : undefined,
		].filter(Boolean).join(" · ");
		if (!watch.error) watch.ctx.ui.setStatus?.(statusKey(factoryId), watch.status);
	};
	const pollFactories = () => {
		for (const [factoryId, watch] of watchedFactories) {
			try { factory({ action: "verify_manager", factory_id: factoryId, authority: watch.authority }); } catch (error) {
				watchedFactories.delete(factoryId);
				watch.ctx.ui.setStatus?.(statusKey(factoryId), undefined);
				watch.ctx.ui.notify(`Factory ${factoryId}: management watch ended: ${errorMessage(error)}`, "warning");
				continue;
			}
			void watch.scheduler.advance().then(() => {
				if (watchedFactories.get(factoryId) !== watch || !watch.error) return;
				watch.error = undefined;
				watch.ctx.ui.setStatus?.(statusKey(factoryId), watch.status);
			}, error => {
				if (watchedFactories.get(factoryId) !== watch) return;
				const message = errorMessage(error);
				if (watch.error !== message) watch.ctx.ui.notify(`Factory ${factoryId}: automatic advance failed: ${message} (see /factory inspect ${factoryId})`, "error");
				watch.error = message;
				watch.ctx.ui.setStatus?.(statusKey(factoryId), `${watch.status ?? `Factory ${factoryId}`} · automatic advance failed`);
			});
		}
	};
	const watchRequests = (ctx: ExtensionCommandContext, factoryId: string, authority: ManagerAuthority) => {
		const existing = watchedFactories.get(factoryId);
		if (existing?.authority === authority) {
			// Preserve in-flight coalescing for the same authority, but use the latest command context.
			existing.ctx = ctx;
		} else {
			const binding = currentBinding(ctx);
			const assertAuthority = () => assertLiveAuthority(watch.ctx, authority, binding);
			const { env, home } = service.getEnvironment();
			const scheduler = createFactoryQueueScheduler({
				factory, factoryId, authority, assertAuthority,
				assertAuthorityAndTrust: projectCwd => {
					assertAuthority();
					assertProjectTrusted(watch.ctx, piAgentDir(env, home), projectCwd);
				},
				onInspection: view => showFactory(watch, factoryId, view),
				onLaunch: async launched => {
					if (watchedFactories.get(factoryId) !== watch) return;
					watch.ctx.ui.notify(`Factory ${factoryId} launched FIFO input ${launched.input_id} as run ${launched.task_id} (bound ${launched.bound_version}).`, "info");
					try { await graphs.attach(launched.task_id, watch.ctx, service.status(launched.task_id, watch.ctx.cwd), { pruneFinished: true }); } catch { /* launch was durably committed */ }
				},
			});
			const watch: FactoryWatch = { ctx, authority, scheduler, alerts: new Set() };
			watchedFactories.set(factoryId, watch);
		}
		pollFactories();
		if (!alertTimer) { alertTimer = setInterval(pollFactories, 3000); alertTimer.unref?.(); }
	};
	const stopWatchingRequests = () => {
		if (alertTimer) clearInterval(alertTimer);
		alertTimer = undefined;
		for (const [factoryId, watch] of watchedFactories) watch.ctx.ui.setStatus?.(statusKey(factoryId), undefined);
		watchedFactories.clear();
	};

	const COMPLETION_CACHE_TTL_MS = 2000;
	let completionCache: { expiresAt: number; entries: Array<{ factory_id: string; name: string; current_version?: string; management?: string }> } | undefined;
	const invalidateCompletionCache = () => { completionCache = undefined; };

	pi.registerCommand("factory", {
		description: "Discover, inspect, publish, update or restore versions, explicitly resume management, submit plain-text briefs, launch the FIFO head, cancel a run, settle a finished one or clear an uncertain hold, or recover receipts for a software factory",
		getArgumentCompletions: prefix => {
			const spaceIdx = prefix.indexOf(" ");
			if (spaceIdx === -1) {
				const matches = FACTORY_SUBCOMMANDS.filter(action => action.startsWith(prefix));
				return matches.length > 0 ? matches.map(value => ({ value, label: value })) : null;
			}
			const sub = prefix.slice(0, spaceIdx);
			const argPrefix = prefix.slice(spaceIdx + 1);
			if (sub === "viewer") {
				if (argPrefix.includes(" ")) return null;
				const viewerSubs = ["stop", "status"].filter(opt => opt.startsWith(argPrefix));
				return viewerSubs.length > 0 ? viewerSubs.map(opt => ({ value: `viewer ${opt}`, label: opt })) : null;
			}
			if (!FACTORY_TARGET_SUBCOMMANDS.has(sub) || argPrefix.includes(" ")) return null;
			const now = Date.now();
			let entries: Array<{ factory_id: string; name: string; current_version?: string; management?: string }>;
			if (completionCache && now < completionCache.expiresAt) {
				entries = completionCache.entries;
			} else {
				try { entries = factory({ action: "list" }); }
				catch {
					try { entries = factory({ action: "identities" }); }
					catch { return null; }
				}
				completionCache = { expiresAt: now + COMPLETION_CACHE_TTL_MS, entries };
			}
			const suggestions: Array<{ value: string; label: string; description?: string }> = [];
			const seen = new Set<string>();
			for (const entry of entries) {
				const meta = entry.current_version && entry.management ? `${entry.current_version}, ${entry.management}` : undefined;
				if (entry.name.startsWith(argPrefix) && !seen.has(entry.name)) {
					seen.add(entry.name);
					suggestions.push({ value: `${sub} ${entry.name}`, label: entry.name, description: `${entry.factory_id}${meta ? ` (${meta})` : ""}` });
				}
			}
			for (const entry of entries) {
				const meta = entry.current_version && entry.management ? `${entry.current_version}, ${entry.management}` : undefined;
				if (entry.factory_id.startsWith(argPrefix) && !seen.has(entry.factory_id)) {
					seen.add(entry.factory_id);
					suggestions.push({ value: `${sub} ${entry.factory_id}`, label: entry.factory_id, description: `${entry.name}${meta ? ` (${meta})` : ""}` });
				}
			}
			return suggestions.length > 0 ? suggestions : null;
		},
		async handler(args, ctx) {
			invalidateCompletionCache();
			try {
				const tokens = typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
				const [action, ...rest] = tokens;
				if (!action || action === "list") {
					if (rest.length > 0) throw new Error("Usage: /factory [list]");
					ctx.ui.notify(JSON.stringify(factory({ action: "list" }), null, 2), "info");
					return;
				}
				if (action === "inspect") {
					if (rest.length < 1 || rest.length > 2 || (rest[1] !== undefined && !VERSION_PATTERN.test(rest[1]))) throw new Error("Usage: /factory inspect <factory> [version, for example v1]");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					ctx.ui.notify(JSON.stringify(factory({ action: "inspect", factory_id: factoryId, ...(rest[1] !== undefined ? { version: rest[1] } : {}) }), null, 2), "info");
					return;
				}
				if (action === "queue") {
					if (rest.length < 1) throw new Error("Usage: /factory queue <factory> [--open | --all] [--json]");
					let filterFlag: "open" | "all" | undefined;
					let asJson = false;
					for (const flag of rest.slice(1)) {
						if (flag === "--open") {
							if (filterFlag === "all") throw new Error("Usage: /factory queue <factory> [--open | --all] [--json] (cannot combine --open and --all)");
							filterFlag = "open";
						} else if (flag === "--all") {
							if (filterFlag === "open") throw new Error("Usage: /factory queue <factory> [--open | --all] [--json] (cannot combine --open and --all)");
							filterFlag = "all";
						} else if (flag === "--json") {
							asJson = true;
						} else {
							throw new Error(`Usage: /factory queue <factory> [--open | --all] [--json] (unexpected argument ${JSON.stringify(flag)})`);
						}
					}
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const inspection = factory({ action: "inspect", factory_id: factoryId });
					const queueView = buildQueueView(inspection, filterFlag === "open");
					ctx.ui.notify(asJson ? JSON.stringify(queueView, null, 2) : formatQueueTable(queueView), "info");
					return;
				}
				if (action === "receipt") {
					if (rest.length !== 2) throw new Error("Usage: /factory receipt <factory> <reference>");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					ctx.ui.notify(JSON.stringify(factory({ action: "receipt", factory_id: factoryId, reference: rest[1] }), null, 2), "info");
					return;
				}
				if (action === "viewer") {
					const { env, home } = service.getEnvironment();
					const extensionDir = dirname(fileURLToPath(import.meta.url));
					if (rest.length === 0) {
						const started = await startFactoryViewer({ extensionDir, env, home, storePath: factoryStore });
						const prefix = started.action === "reused"
							? "Factory Viewer already running"
							: started.staleReason
								? `Cleared stale viewer record (${started.staleReason}). Factory Viewer started`
								: "Factory Viewer started";
						ctx.ui.notify(`${prefix}: ${started.record.url} (pid ${started.record.pid}, store ${started.record.store_path})`, "info");
						return;
					}
					if (rest.length === 1 && rest[0] === "stop") {
						const stopped = await stopFactoryViewer({ extensionDir, env, home });
						ctx.ui.notify(
							stopped.stopped
								? `Factory Viewer stopped (pid ${stopped.pid}${stopped.url ? `, ${stopped.url}` : ""}${stopped.killedWithSigkill ? ", SIGKILL" : ""})`
								: stopped.reason,
							"info",
						);
						return;
					}
					if (rest.length === 1 && rest[0] === "status") {
						const status = await getFactoryViewerStatus({ extensionDir, env, home, storePath: factoryStore });
						if (!status.running) {
							ctx.ui.notify(`No Factory Viewer is running${status.staleReason ? ` (stale record: ${status.staleReason})` : ""}.`, "info");
							return;
						}
						const mismatchNote = status.storeMatches
							? ""
							: `, differs from current store ${status.currentTarget.store_path}`;
						if (status.state === "starting") {
							ctx.ui.notify(`Factory Viewer starting: pid ${status.record.pid}, store ${status.record.store_path}${mismatchNote}`, "info");
							return;
						}
						ctx.ui.notify(
							`Factory Viewer running: ${status.record.url} (pid ${status.record.pid}, store ${status.record.store_path}${mismatchNote}${status.healthy ? "" : `, unhealthy: ${status.healthError ?? "check failed"}`})`,
							"info",
						);
						return;
					}
					throw new Error("Usage: /factory viewer [stop | status]");
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
				if (action === "update") {
					if (rest.length !== 1) throw new Error("Usage: /factory update <factory>");
					if (inAgentSession()) throw new Error("Factory publication cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory update needs interactive confirmation; use /factory update <factory> in Pi with a UI");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const target = factory({ action: "publication_target", factory_id: factoryId });
					// An already-managed factory is published only by its live owning session; an unmanaged one by explicit human action without any authority.
					const ownership = capturePublicationOwnership(ctx, target, factoryId);
					const raw = await ctx.ui.editor(`Update factory ${target.name} (${factoryId}) from ${target.current_version} (JSON: {draft})`);
					if (raw === undefined) return;
					const parsed = JSON.parse(raw) as unknown;
					if (!isRecord(parsed) || Object.keys(parsed).some(key => key !== "draft") || parsed.draft === undefined) {
						throw new Error('Factory update input must be a JSON object with exactly one key, "draft"');
					}
					const nextVersion = `v${Number(target.current_version.slice(1)) + 1}`;
					ownership.assertLive();
					const confirmed = await ctx.ui.confirm(
						"Publish a new software factory version?",
						`Validate and durably publish ${nextVersion} of ${target.name} (${factoryId}), replacing current ${target.current_version}. Queued and running work keep the versions they are bound to; no run is created and management is unchanged. Older versions are retained.`,
					);
					if (!confirmed) return;
					ownership.assertLive();
					ctx.ui.notify(JSON.stringify(factory({
						action: "update", factory_id: factoryId, draft: parsed.draft, expected_current_version: target.current_version,
						sessionModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: ctx.thinkingLevel } : undefined,
						...ownership.request,
					}), null, 2), "info");
					return;
				}
				if (action === "restore") {
					if (rest.length !== 2) throw new Error("Usage: /factory restore <factory> <version, for example v1>");
					if (!VERSION_PATTERN.test(rest[1])) throw new Error(`Usage: /factory restore <factory> <version>; version token like "v1" required (got ${JSON.stringify(rest[1])})`);
					if (inAgentSession()) throw new Error("Factory publication cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory restore needs interactive confirmation; use /factory restore <factory> <version> in Pi with a UI");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const target = factory({ action: "publication_target", factory_id: factoryId });
					const ownership = capturePublicationOwnership(ctx, target, factoryId);
					const nextVersion = `v${Number(target.current_version.slice(1)) + 1}`;
					const confirmed = await ctx.ui.confirm(
						"Restore a preserved software factory version?",
						`Validate preserved ${rest[1]} of ${target.name} (${factoryId}) against live prerequisites and operator ceilings, then republish it unchanged as new ${nextVersion}, replacing current ${target.current_version}. ${rest[1]} and every other version stay as they are; queued and running work keep their bound versions; no run is created and management is unchanged.`,
					);
					if (!confirmed) return;
					ownership.assertLive();
					ctx.ui.notify(JSON.stringify(factory({ action: "restore", factory_id: factoryId, from_version: rest[1], expected_current_version: target.current_version, ...ownership.request }), null, 2), "info");
					return;
				}
				if (action === "resume") {
					if (rest.length !== 1) throw new Error("Usage: /factory resume <factory>");
					if (inAgentSession()) throw new Error("Factory management cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory resume requires an interactive Pi session with a UI; use /factory resume <factory> interactively");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const authority = ensureAuthority(ctx);
					const resumed = factory({ action: "resume", factory_id: factoryId, authority });
					watchRequests(ctx, factoryId, authority);
					ctx.ui.notify(JSON.stringify(resumed, null, 2), "info");
					return;
				}
				if (action === "takeover") {
					if (rest.length !== 1) throw new Error("Usage: /factory takeover <factory>");
					if (inAgentSession()) throw new Error("Factory takeover cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory takeover requires an interactive Pi session with a UI; use /factory takeover <factory> interactively");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const target = factory({ action: "publication_target", factory_id: factoryId }) as { name: string; manager_incarnation_id?: string };
					if (!target.manager_incarnation_id) throw new Error("Factory has no verified manager incarnation to take over");
					const capturedBinding = currentBinding(ctx);
					const authority = ensureAuthority(ctx);
					const confirmed = await ctx.ui.confirm("Take over factory management?", `Take over ${target.name} (${factoryId}) only if recorded manager incarnation ${target.manager_incarnation_id} is no longer alive. This does not cancel runs or release either hold; saved state must be reconciled before scheduling.`);
					if (!confirmed) return;
					assertLiveAuthority(ctx, authority, capturedBinding);
					const result = factory({ action: "takeover", factory_id: factoryId, authority, confirmed_manager_incarnation_id: target.manager_incarnation_id });
					watchRequests(ctx, factoryId, authority);
					ctx.ui.notify(JSON.stringify(result, null, 2), "info");
					return;
				}
				if (action === "stop") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory stop <factory>", args: 1, subject: "stop", needsUi: true });
					const view = factory({ action: "inspect", factory_id: factoryId });
					const confirmed = await ctx.ui.confirm("Stop factory admissions and launches?", `Stop ${view.factory.name} (${factoryId}). Queued inputs, running work, holds, run controls and direction requests are preserved. New submissions and launch starts are fenced; an attempt already across its start boundary is not undone.`);
					if (!confirmed) return;
					assertLiveAuthority(ctx, authority, capturedBinding);
					ctx.ui.notify(JSON.stringify(factory({ action: "stop", factory_id: factoryId, authority }), null, 2), "info");
					return;
				}
				if (action === "discard") {
					const { factoryId, factoryName, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory discard <factory> <input-id>", args: 2, subject: "discard", needsUi: true });
					const inputId = validateFactoryToken(rest[1], "input_id");
					const result = await factory({ action: "discard", factory_id: factoryId, input_id: inputId, authority, assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding), confirm: async target => {
						assertLiveAuthority(ctx, authority, capturedBinding);
						return ctx.ui.confirm("Discard unstarted factory input?", `Factory ${factoryName} (${target.factory_id}), input ${target.input_id}, reference ${target.reference}, ${target.queue_position_kind === "waiting" ? "queue position" : "acceptance ordinal (waiting position unavailable)"} ${target.queue_position}, bound ${target.bound_version}. ${target.consequences}`);
					} });
					ctx.ui.notify(result ? JSON.stringify(result, null, 2) : "Discard cancelled; nothing changed", "info");
					return;
				}
				if (action === "delete") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory delete <factory>", args: 1, subject: "deletion", needsUi: true });
					let cancelReason: string | undefined;
					const result = await factory({
						action: "delete",
						factory_id: factoryId,
						authority,
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						confirm: async target => {
							assertLiveAuthority(ctx, authority, capturedBinding);
							if (target.factory_id !== factoryId) {
								throw new Error(`Delete target mismatch: expected ${factoryId}, got ${target.factory_id}`);
							}
							const acknowledged = await ctx.ui.confirm(
								`Delete software factory "${target.name}"?`,
								`Factory ${target.name} (${target.factory_id}), current version ${target.current_version}. ${target.consequences}`,
							);
							if (!acknowledged) return false;
							assertLiveAuthority(ctx, authority, capturedBinding);
							const typed = await ctx.ui.input(
								`Type the factory name "${target.name}" to permanently delete ${target.name} (${target.factory_id})`,
								"",
							);
							if (typed === undefined) return false;
							if (typed !== target.name) {
								cancelReason = `Factory name did not match "${target.name}"; deletion cancelled and nothing changed.`;
								return false;
							}
							return true;
						},
					});
					if (result.deleted) {
						const watch = watchedFactories.get(factoryId);
						if (watch) {
							watchedFactories.delete(factoryId);
							watch.ctx.ui.setStatus?.(statusKey(factoryId), undefined);
						}
					}
					ctx.ui.notify(!result.deleted ? (cancelReason ?? result.message) : result.already_deleted ? result.message : JSON.stringify(result, null, 2), "info");
					return;
				}
				if (action === "submit") {
					if (rest.length < 1 || rest.length > 2) throw new Error("Usage: /factory submit <factory> [reference]");
					if (inAgentSession()) throw new Error("Factory submission cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory submission requires an interactive Pi session with a UI; use /factory submit <factory> [reference] interactively");
					const { factoryId, factoryName } = resolveFactoryTarget(rest[0]);
					const reference = rest[1] !== undefined ? validateFactoryToken(rest[1], "reference") : `sub-${randomUUID()}`;
					const capturedBinding = currentBinding(ctx);
					const authority = ensureAuthority(ctx);
					factory({ action: "verify_manager", factory_id: factoryId, authority });
					ctx.ui.notify(
						`Submission reference: ${reference} (factory ${factoryName} (${factoryId}); max ${MAX_BRIEF_BYTES} UTF-8 bytes / 16 KiB, ${MAX_QUEUED_INPUTS} queued inputs)`,
						"info",
					);
					const raw = await openBriefEditor(
						ctx,
						`Submit plain-text brief for ${factoryName} (${factoryId}) [ref: ${reference}]`,
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
				if (action === "retry") {
					if (rest.length !== 3) throw new Error("Usage: /factory retry <factory> <input-id> <previous-attempt-id>");
					if (inAgentSession()) throw new Error("Factory launch retry cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory launch retry requires an interactive Pi session with a UI");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const inputId = validateFactoryToken(rest[1], "input_id");
					const previousAttemptId = validateFactoryToken(rest[2], "attempt_id");
					const capturedBinding = currentBinding(ctx);
					const authority = ensureAuthority(ctx);
					const before = factory({ action: "inspect", factory_id: factoryId });
					const attempt = before.attempts.find(item => item.attempt_id === previousAttemptId && item.input_id === inputId);
					if (!attempt?.retry_eligibility?.eligible) throw new Error(attempt?.retry_eligibility?.reason ?? "Exact attempt is not eligible for retry");
					const target = factory({ action: "publication_target", factory_id: factoryId });
					const confirmed = await ctx.ui.confirm("Retry proven unreleased launch?", `Factory ${target.name} (${factoryId}), input ${inputId}, prior attempt ${previousAttemptId}. This keeps the same accepted brief, bound version and FIFO position; it creates a new attempt and request. Both holds are transferred atomically. Only durable proof of non-release is retryable.`);
					if (!confirmed) return;
					assertLiveAuthority(ctx, authority, capturedBinding);
					const after = factory({ action: "inspect", factory_id: factoryId });
					const revalidated = after.attempts.find(item => item.attempt_id === previousAttemptId && item.input_id === inputId);
					if (!revalidated?.retry_eligibility?.eligible) throw new Error(revalidated?.retry_eligibility?.reason ?? "Retry eligibility changed; inspect again");
					const { env: serviceEnv, home: serviceHome } = service.getEnvironment();
					const agentDir = piAgentDir(serviceEnv, serviceHome);
					const assertAuthorityAndTrust = (projectCwd?: string) => { assertLiveAuthority(ctx, authority, capturedBinding); assertProjectTrusted(ctx, agentDir, projectCwd); };
					assertAuthorityAndTrust();
					const launched = await factory({ action: "retry_launch", factory_id: factoryId, authority, input_id: inputId, previous_attempt_id: previousAttemptId, confirmed: true, assertAuthorityAndTrust });
					if (!inAgentSession()) { try { await graphs.attach(launched.task_id, ctx, service.status(launched.task_id, ctx.cwd), { pruneFinished: true }); } catch { /* launch already committed */ } }
					const { manifest, ...summaryResult } = launched;
					ctx.ui.notify(JSON.stringify({ ...summaryResult, manifest: publicManifest(manifest) }, null, 2), "info");
					return;
				}
				if (action === "cancel") {
					const { factoryId, factoryName, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory cancel <factory>", args: 1, subject: "cancellation", needsUi: true });
					const view = factory({ action: "inspect", factory_id: factoryId });
					const held = heldReleasedAttempt(view);
					if (!held) throw new Error("No released run holds this factory's capacity");
					const result = await factory({
						action: "cancel_run", factory_id: factoryId, input_id: held.input_id, attempt_id: held.attempt_id, task_id: held.task_id, authority,
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						confirm: target => ctx.ui.confirm("Cancel factory run?", `Factory ${factoryName} (${factoryId}), input ${target.input_id}, attempt ${target.attempt_id}, run ${target.task_id}, version ${target.bound_version}. ${target.consequences}`),
					});
					ctx.ui.notify(result.cancelled ? `Cancellation requested for ${result.target.task_id}. Use /factory inspect ${factoryId} to watch settlement; capacity stays held until the run settles. If the worker never acknowledges, the hold needs operator clearance.` : "Cancellation declined; nothing changed", "info");
					return;
				}
				if (action === "clear") {
					const { factoryId, factoryName, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory clear <factory>", args: 1, subject: "hold clearance", needsUi: true });
					const view = factory({ action: "inspect", factory_id: factoryId });
					const held = heldReleasedAttempt(view);
					if (!held) {
						const unreleased = view.attempts.find(item => !item.historical && !item.release_authorized);
						if (unreleased?.retry_eligibility?.eligible) {
							throw new Error(`No released run holds this factory's capacity; attempt ${unreleased.attempt_id} is proven not released and eligible for /factory retry ${factoryId} ${unreleased.input_id} ${unreleased.attempt_id}`);
						}
						if (unreleased?.state === "failed_before_release") {
							throw new Error(`No released run holds this factory's capacity; attempt ${unreleased.attempt_id} failed before release (${unreleased.retry_eligibility?.reason ?? "non-release not yet proven"}). Run /factory settle ${factoryId} once its nodes exit (or exit Pi and run /factory takeover ${factoryId} if the launch was interrupted), then /factory retry`);
						}
						if (unreleased?.state === "reserved") {
							throw new Error(`No released run holds this factory's capacity; attempt ${unreleased.attempt_id} is still reserved (the original launch may still release). Exit the original Pi session and run /factory takeover ${factoryId} if it died`);
						}
						throw new Error("No released run holds this factory's capacity");
					}
					// Every statement is collected from the human here, after the exact target is shown; a structured tool has no way to supply them.
					const result = await factory({
						action: "clear_hold", factory_id: factoryId, input_id: held.input_id, attempt_id: held.attempt_id, task_id: held.task_id, authority,
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						confirm: async target => {
							const confirmed = await ctx.ui.confirm("Clear uncertain capacity hold?", `Factory ${factoryName} (${factoryId}), input ${target.input_id}, attempt ${target.attempt_id}, run ${target.task_id}, version ${target.bound_version}, checkout ${target.canonical_checkout}. Holds taken: factory ${target.holds.factory_held_at}, checkout ${target.holds.checkout_held_at}. Missing or contradictory: ${target.missing_or_contradictory.join("; ")}. ${target.missing_or_contradictory.some(item => /liveness cannot be determined/.test(item)) ? "WARNING: the worker's liveness could not be determined; verify its process is not running before confirming. " : ""}${target.action} ${target.consequences}`);
							if (!confirmed) return undefined;
							const reason = await ctx.ui.input("Reason for clearing this hold", "why is clearing safe now");
							if (!reason?.trim()) return undefined;
							const evidence = await ctx.ui.input("Evidence that the original work cannot resume", "for example: process stopped, host rebooted and checkout verified");
							if (!evidence?.trim()) return undefined;
							const acknowledged = await ctx.ui.confirm("Acknowledge unknown past effects?", "The original run may have changed the checkout in ways that are not recorded, and clearing does not resolve them. Acknowledge to record the clearance.");
							return acknowledged ? { reason, evidence, acknowledged_unknown_effects: true } : undefined;
						},
					});
					ctx.ui.notify(result.cleared ? `Hold cleared for ${result.target.task_id}: both holds released, the input is retired and nothing was launched. Its recorded outcome is unchanged; submit a new brief to repeat it.` : "Clearance declined; nothing changed", "info");
					return;
				}
				if (action === "redeliver") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory redeliver <factory> <successor-node> [source-node]", args: [2, 3], subject: "redelivery", needsUi: false });
					const report = await factory({
						action: "redeliver_handoff", factory_id: factoryId, authority, agent: rest[1], ...(rest[2] ? { source: rest[2] } : {}),
						wake: wakeViaComs((name, args, options) => ctx.executeTool(name, args, options) as any),
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
					});
					ctx.ui.notify(JSON.stringify(report, null, 2), "info");
					return;
				}
				if (action === "requests") {
					if (rest.length !== 1) throw new Error("Usage: /factory requests <factory>");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					const requests = factory({ action: "requests", factory_id: factoryId });
					try {
						const pendingProposals = factory({ action: "proposals", factory_id: factoryId }).filter(p => p.outcome === "pending");
						if (pendingProposals.length > 0) {
							ctx.ui.notify(
								`${pendingProposals.length} pending constraint proposal(s): ${pendingProposals.map(p => `${p.proposal_id} (/factory review-proposal ${factoryId} ${p.proposal_id})`).join(", ")}`,
								"warning",
							);
						}
					} catch {
						// Requests inspection remains independent when proposal evidence is unavailable (for example pre-v12).
					}
					ctx.ui.notify(JSON.stringify(requests, null, 2), "info");
					return;
				}
				if (action === "proposals") {
					if (rest.length !== 1) throw new Error("Usage: /factory proposals <factory>");
					const { factoryId } = resolveFactoryTarget(rest[0]);
					ctx.ui.notify(JSON.stringify(factory({ action: "proposals", factory_id: factoryId }), null, 2), "info");
					return;
				}
				if (action === "review-proposal") {
					const { factoryId, factoryName, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory review-proposal <factory> <proposal-id>", args: 2, subject: "constraint proposal review", needsUi: true });
					const proposalId = validateFactoryToken(rest[1], "proposal_id");
					const proposal = factory({ action: "proposals", factory_id: factoryId }).find(item => item.proposal_id === proposalId);
					if (!proposal) throw new Error(`Constraint proposal not found: ${proposalId}`);
					if (proposal.outcome !== "pending") {
						throw new Error(`Proposal ${proposalId} is already ${proposal.outcome}; only pending proposals can be reviewed`);
					}
					const checkout = proposal.canonical_checkout;
					if (!checkout) throw new Error("Canonical checkout path is unavailable for reviewing this constraint proposal");
					const beforeSnap = constraintsFileSnapshotState(checkout);
					const activeDoc = readProjectConstraints(checkout);
					const activeConstraints = (activeDoc?.entries ?? []).filter(entry => entry.status === "active").map(entry => ({ id: entry.id, text: entry.text }));
					const summary = formatConstraintReview({
						action: proposal.proposal_action,
						factoryId,
						factoryName,
						proposalId: proposal.proposal_id,
						text: proposal.text,
						constraintId: proposal.target_constraint_id ?? proposal.assigned_constraint_id,
						provenance: proposal.provenance,
						conflictingIds: proposal.conflicting_ids,
						activeConstraints,
					});
					const expectedBinding: ConstraintConfirmationBinding = {
						proposal_id: proposal.proposal_id,
						normalized_text_digest: proposal.normalized_text_digest,
						factory_id: factoryId,
						canonical_checkout: checkout,
						action: proposal.proposal_action,
						constraints_file_digest: beforeSnap.digest,
					};
					const confirmChoice = "Confirm and write to .pi/constraints.json";
					const rejectChoice = "Reject proposal";
					const leaveChoice = "Leave pending";
					const picked = await ctx.ui.select(summary, [confirmChoice, rejectChoice, leaveChoice]);
					if (picked === undefined || picked === leaveChoice) {
						ctx.ui.notify(`Proposal ${proposalId} left pending`, "info");
						return;
					}
					assertLiveAuthority(ctx, authority, capturedBinding);
					if (picked === confirmChoice) {
						const res = await factory({
							action: "confirm_constraint",
							factory_id: factoryId,
							proposal_id: proposalId,
							authority,
							expected_binding: expectedBinding,
							assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
							confirm: async (target: Readonly<ConstraintConfirmationTarget>) => {
								assertLiveAuthority(ctx, authority, capturedBinding);
								const detail = formatConstraintReview({
									action: target.action,
									factoryId: target.factory_id,
									factoryName: target.factory_name,
									proposalId: target.proposal_id,
									text: target.text,
									constraintId: target.constraint_id ?? target.assigned_constraint_id,
									provenance: target.provenance,
									conflictingIds: target.conflicting_ids,
									activeConstraints: target.active_constraints,
								});
								return await ctx.ui.confirm(`Confirm constraint ${target.action} (${target.proposal_id})?`, detail);
							},
						});
						ctx.ui.notify(
							res.confirmed
								? `Proposal ${proposalId} confirmed${res.replayed ? " (already recorded)" : ""} and synced to .pi/constraints.json.`
								: `Proposal ${proposalId} confirmation cancelled; it stays pending.`,
							"info",
						);
						return;
					}
					if (picked === rejectChoice) {
						const reason = await ctx.ui.input("Rejection reason (optional; Esc leaves proposal pending)", "");
						if (reason === undefined) {
							ctx.ui.notify(`Proposal ${proposalId} left pending`, "info");
							return;
						}
						assertLiveAuthority(ctx, authority, capturedBinding);
						const { constraints_file_digest: _ignored, ...rejectBinding } = expectedBinding;
						const res = await factory({
							action: "reject_constraint",
							factory_id: factoryId,
							proposal_id: proposalId,
							authority,
							expected_binding: rejectBinding,
							assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
							confirm: async () => ({ confirmed: true, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
						});
						ctx.ui.notify(
							res.rejected
								? `Proposal ${proposalId} rejected${res.replayed ? " (already recorded)" : ""}.`
								: `Proposal ${proposalId} rejection cancelled.`,
							"info",
						);
						return;
					}
					throw new Error("Choose Confirm, Reject, or Leave pending");
				}
				if (action === "retire-constraint") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory retire-constraint <factory> <constraint-id>", args: 2, subject: "constraint retirement", needsUi: true });
					const constraintId = validateFactoryToken(rest[1], "constraint_id");
					const res = await factory({
						action: "retire_constraint",
						factory_id: factoryId,
						constraint_id: constraintId,
						authority,
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						confirm: async (target: Readonly<ConstraintConfirmationTarget>) => {
							assertLiveAuthority(ctx, authority, capturedBinding);
							const detail = formatConstraintReview({
								action: "retire",
								factoryId: target.factory_id,
								factoryName: target.factory_name,
								proposalId: target.proposal_id,
								text: target.text,
								constraintId: target.constraint_id,
								provenance: target.provenance,
								conflictingIds: target.conflicting_ids,
								activeConstraints: target.active_constraints,
							});
							if (!await ctx.ui.confirm(`Retire learned constraint ${constraintId}?`, detail)) return false;
							const reason = await ctx.ui.input("Reason for retiring constraint (required; Esc cancels)", "");
							if (reason === undefined || !reason.trim()) return false;
							return { reason: reason.trim() };
						},
					});
					ctx.ui.notify(
						res.retired
							? `Constraint ${constraintId} retired in .pi/constraints.json.`
							: `Retirement of ${constraintId} cancelled.`,
						"info",
					);
					return;
				}
				if (action === "resolve-conflict") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory resolve-conflict <factory> <proposal-id>", args: 2, subject: "constraint conflict resolution", needsUi: true });
					const proposalId = validateFactoryToken(rest[1], "proposal_id");
					const res = await factory({
						action: "resolve_constraint_conflict",
						factory_id: factoryId,
						proposal_id: proposalId,
						authority,
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						confirm: async (target: Readonly<ConstraintConflictTarget>) => {
							assertLiveAuthority(ctx, authority, capturedBinding);
							const currentLines = target.current_constraints.length > 0
								? target.current_constraints.map(c => `  - ${c.id} [${c.status}]: ${c.text}`).join("\n")
								: "  (empty)";
							const intendedLine = target.intended_entry
								? `  + ${target.intended_entry.id} [${target.intended_entry.status}]: ${target.intended_entry.text}`
								: `  ! Cannot re-apply automatically: ${target.reapply_error ?? "invalid against current file"}`;
							const diffText = [
								`Factory: ${target.factory_name} (${target.factory_id})`,
								`Constraint conflict for ${target.proposal_id} (${target.action})`,
								`Conflict: ${target.conflict_reason}`,
								`Current .pi/constraints.json (${target.current_constraints_digest}):`,
								currentLines,
								"Intended change:",
								intendedLine,
							].join("\n");
							const reconfirmChoice = "Re-confirm against current .pi/constraints.json";
							const abandonChoice = "Abandon confirmation (leave .pi/constraints.json untouched)";
							const cancelChoice = "Cancel (keep conflict)";
							const options = target.reapply_error ? [abandonChoice, cancelChoice] : [reconfirmChoice, abandonChoice, cancelChoice];
							const picked = await ctx.ui.select(diffText, options);
							if (picked === undefined || picked === cancelChoice) return "cancel";
							assertLiveAuthority(ctx, authority, capturedBinding);
							if (picked === reconfirmChoice) {
								const ok = await ctx.ui.confirm(`Re-confirm ${target.proposal_id} onto current .pi/constraints.json?`, diffText);
								return ok ? { resolution: "reconfirm" } : "cancel";
							}
							if (picked === abandonChoice) {
								const reason = await ctx.ui.input("Abandonment reason (optional; Esc cancels)", "");
								if (reason === undefined) return "cancel";
								return { resolution: "abandon", ...(reason.trim() ? { reason: reason.trim() } : {}) };
							}
							return "cancel";
						},
					});
					ctx.ui.notify(
						res.resolved
							? (res.auto_resolved
								? `Proposal ${proposalId} conflict auto-resolved (${res.constraints_digest}); .pi/constraints.json already matched.`
								: res.resolution === "abandon"
								? `Proposal ${proposalId} conflict abandoned${res.replayed ? " (already abandoned)" : ""}; .pi/constraints.json left untouched and factory unblocked.`
								: `Proposal ${proposalId} conflict re-confirmed${res.replayed ? " (already synced)" : ""} and synced to .pi/constraints.json.`)
							: `Conflict resolution for ${proposalId} cancelled.`,
						"info",
					);
					return;
				}
				if (action === "wake") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory wake <factory> <request-id>", args: 2, subject: "direction wake-up", needsUi: false });
					const item = factory({ action: "redeliver_response", factory_id: factoryId, request_id: rest[1], authority, assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding) });
					ctx.ui.notify(`Wake-up published for the saved response to ${item.request_id}; this does not prove consumption. Check /factory requests ${factoryId}.`, "info");
					return;
				}
				if (action === "respond") {
					const { factoryId, factoryName, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory respond <factory> <request-id>", args: 2, subject: "response", needsUi: true });
					const requestId = validateFactoryToken(rest[1], "request_id");
					const item = factory({ action: "requests", factory_id: factoryId }).find(candidate => candidate.request_id === requestId);
					if (!item) throw new Error(`Request not found: ${requestId}`);
					if (item.state !== "pending") throw new Error(`Request ${requestId} is ${item.state}${item.response_recorded ? " with a recorded response" : ""}; only a pending request can be answered`);
					if (!item.can_respond) throw new Error(`Request ${requestId} is not actionable: ${item.recovery_reason}`);
					const choiceLabel = (choice: (typeof item.choices)[number]) => `${choice.choice_id}: ${choice.label}${choice.route === "approve" ? " (binds this attempt to approval; requires a valid result)" : choice.route === "reject" ? " (binds this attempt to rejection; requires a valid result)" : ""}${item.recommendation?.choice_id === choice.choice_id ? " (recommended)" : ""}`;
					const decline = "Decline (explicit; not approval)";
					const leave = "Leave unanswered (stays pending)";
					const context = [`Factory: ${factoryName} (${factoryId})`, `${item.node_id} asks: ${item.question}`, `Reason: ${item.reason}`, ...(item.risk_lane ? [`Risk lane: ${formatRiskLaneSummary(item.risk_lane)}`] : []), ...(item.evidence.length ? [`Evidence: ${item.evidence.join("; ")}`] : []), ...(item.recommendation ? [`Recommendation: ${item.recommendation.choice_id}${item.recommendation.rationale ? ` (${item.recommendation.rationale})` : ""}`] : [])].join("\n");
					const cap = item.revision;
					const revisionWarning = cap ? `\nRevision capacity: ${cap.remaining_iterations} whole iteration(s); ${cap.loop_revisions_remaining} loop revision(s) and ${cap.run_attempts_remaining} run attempt(s) left, ${cap.attempts_per_iteration} needed per iteration. ${cap.blocked_by ? `Blocked by ${cap.blocked_by === "loop_limit" ? "the loop revision limit" : "the run attempt budget"}; rejection will not revise. ` : "Capacity is rechecked at routing. "}Plan on_exhausted: ${cap.on_exhausted}.` : "";
					const picked = await ctx.ui.select(context + revisionWarning, [...item.choices.map(choiceLabel), ...(item.exhaustion ? [] : [decline]), leave]);
					if (picked === undefined || picked === leave) { ctx.ui.notify(`Request ${requestId} left unanswered; it stays pending`, "info"); return; }
					const choice = item.choices.find(candidate => choiceLabel(candidate) === picked);
					if (item.exhaustion) {
						if (!choice) throw new Error("Choose one of the presented exhaustion actions");
						const { factory_id, input_id, task_id, request_id, node_attempt_id, exhaustion } = item;
						const target = { factory_id, input_id, task_id, request_id, node_attempt_id, exhaustion, choice: choice.choice_id };
						let newBrief: string | undefined;
						if (choice.choice_id === "retry") {
							newBrief = await openBriefEditor(ctx, "New brief for a separate FIFO submission", "Uses the current published definition. Esc leaves the request unanswered.");
							if (newBrief === undefined) return;
						} else if (!await ctx.ui.confirm(`${choice.label}?`, `Factory ${factoryName} (${factory_id}), input ${input_id}, run ${task_id}, review ${node_attempt_id}, request ${request_id}. This records your decision only; it does not cancel, undo effects, free a hold, or grant authority to work on an occupied checkout.`)) return;
						assertLiveAuthority(ctx, authority, capturedBinding);
						const saved = factory({ action: "respond_request", factory_id: factoryId, request_id: requestId, authority,
							response: { kind: "choice", choice_id: choice.choice_id }, newBrief,
							confirmExhaustion: observed => JSON.stringify(observed) === JSON.stringify(target),
							assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
						});
						ctx.ui.notify(saved.retry_receipt ? `Decision recorded. New input ${saved.retry_receipt.input_id} queued at position ${saved.retry_receipt.queue_position}; the original run was not restarted.` : "Exhaustion decision recorded. No original work was restarted or discarded.", "info");
						return;
					}
					const guidanceInput = await ctx.ui.input("Optional guidance within the assignment and route (empty for none; Esc leaves the request unanswered)", "");
					if (guidanceInput === undefined) { ctx.ui.notify(`Request ${requestId} left unanswered; it stays pending`, "info"); return; }
					const guidance = guidanceInput.trim();
					assertLiveAuthority(ctx, authority, capturedBinding);
					const result = factory({
						action: "respond_request", factory_id: factoryId, request_id: requestId, authority,
						response: { kind: choice ? "choice" : "decline", ...(choice ? { choice_id: choice.choice_id } : {}), ...(guidance ? { guidance } : {}) },
						assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding),
					});
					ctx.ui.notify(`${result.replayed ? "Response was already recorded" : "Response recorded"}; the waiting attempt continues only when it consumes it (consumption: ${result.request.consumption}). Check /factory requests ${factoryId}.`, "info");
					return;
				}
				if (action === "settle") {
					const { factoryId, capturedBinding, authority } = beginManagerCommand(ctx, rest, { usage: "/factory settle <factory>", args: 1, subject: "settlement", needsUi: false });
					const result = await factory({ action: "settle_run", factory_id: factoryId, authority, assertAuthority: () => assertLiveAuthority(ctx, authority, capturedBinding) });
					ctx.ui.notify(result.proven_not_released ? `Non-release proven: ${result.reason}` : JSON.stringify(result, null, 2), "info");
					return;
				}
				if (action === "launch") {
					if (rest.length !== 1) throw new Error("Usage: /factory launch <factory>");
					if (inAgentSession()) throw new Error("Factory launch cannot run from a Bootstrap worker session");
					if (!ctx.hasUI) throw new Error("Factory launch requires an interactive Pi session with a UI; use /factory launch <factory> interactively");
					const { factoryId } = resolveFactoryTarget(rest[0]);
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
						try { await graphs.attach(launched.task_id, ctx, service.status(launched.task_id, ctx.cwd), { pruneFinished: true }); } catch { /* launch already committed */ }
					}
					const { manifest, ...summaryResult } = launched;
					ctx.ui.notify(JSON.stringify({ ...summaryResult, manifest: publicManifest(manifest) }, null, 2), "info");
					return;
				}
				throw new Error("Usage: /factory [list | inspect <factory> [version] | queue <factory> [--open | --all] [--json] | receipt <factory> <reference> | viewer [stop | status] | publish | update <factory> | restore <factory> <version> | resume <factory> | takeover <factory> | stop <factory> | discard <factory> <input-id> | delete <factory> | submit <factory> [reference] | launch <factory> | retry <factory> <input-id> <previous-attempt-id> | cancel <factory> | settle <factory> | clear <factory> | redeliver <factory> <successor-node> [source-node] | requests <factory> | respond <factory> <request-id> | wake <factory> <request-id> | proposals <factory> | review-proposal <factory> <proposal-id> | retire-constraint <factory> <constraint-id> | resolve-conflict <factory> <proposal-id>]");
			} catch (error) { ctx.ui.notify(errorMessage(error), "error"); } finally { invalidateCompletionCache(); }
		},
	});

	const graphs = createGraphWidgets((taskId, cwd, onCleaned) => service.statusWithCleanup(taskId, cwd, onCleaned), (taskId, message) => {
		pi.sendMessage({ customType: "bootstrap-cleanup", content: `Run ${taskId}. ${message}`, display: true },
			{ deliverAs: "followUp", triggerTurn: true });
	}, (taskId, cwd) => service.status(taskId, cwd));
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
			use_learned_constraints: Type.Optional(Type.Boolean({ description: "Standalone runs only: opt in to read active learned constraints from <project_cwd>/.pi/constraints.json at launch and inject them into the shared brief. Default false (unchanged)." })),
			collaboration_mode: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("collaborative")], { description: "Peer messaging policy: independent (default for persona/node_id plans; rejects unsolicited peer task activation while keeping internal coordination and user controls) or collaborative (explicit opt-in for peer collaboration). Omitted legacy name requests keep legacy messaging with guidance." })),
			failure_policy: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("fail_fast")], { description: "How other nodes react to a node's failure: independent (default; healthy nodes continue) or fail_fast (cancel remaining unfinished nodes, including parked loop-body agents, on failure)." })),
			agents: Type.Array(Type.Object({
				kind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("command")], { description: "Node kind: agent (default) or command (runs a local executable directly with argv arguments and no model, persona, thinking level, or skills)." })),
				node_id: Type.Optional(Type.String({ minLength: 1, description: "Unique ID of this assignment within the run (letters, digits, _ . -; compared case-insensitively). Defaults to the persona name for agent nodes, and is required for command nodes. Status, reports and cleanup refer to the assignment by this ID." })),
				persona: Type.Optional(Type.String({ minLength: 1, description: "Persona name for agent nodes; case-insensitive. May repeat across nodes. Use together with node_id. Not allowed on command nodes." })),
				name: Type.Optional(Type.String({ minLength: 1, description: "Legacy form for chains and teams: a persona name that is also the node ID (so it cannot repeat). Do not combine with persona or node_id, and not allowed in graphs or on command nodes." })),
				command: Type.Optional(Type.String({ minLength: 1, description: "Command nodes: executable path or name to launch directly as argv without a shell. Required when kind is command; not allowed on agent nodes." })),
				args: Type.Optional(Type.Array(Type.String(), { description: "Command nodes: argument list passed verbatim to the executable without a shell. Not allowed on agent nodes." })),
				working_directory: Type.Optional(Type.String({ minLength: 1, description: "Command nodes: working directory inside project_cwd (defaults to project_cwd). Not allowed on agent nodes." })),
				sub_task: Type.Optional(Type.String({ minLength: 1, description: "This assignment's task (required for agent nodes; optional for command nodes)." })),
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
					try { await graphs.attach(manifest.task_id, ctx, service.status(manifest.task_id, ctx.cwd), { pruneFinished: true }); } catch { /* The launch already succeeded. */ }
				}
				const agents = formatLaunch(manifest);
				const learnedLine = manifest.learned_constraints ? `\nLearned constraints: ${formatLearnedConstraintsSummary(manifest.learned_constraints)}` : "";
				const legacyNote = manifest.collaboration_mode === "legacy" ? "\nNote: legacy request form retains existing peer messaging; migrate to persona/node_id for independent mode or set collaboration_mode explicitly." : "";
				return response(
					failed ? `Bootstrap failed: ${manifest.error}. task_id: "${manifest.task_id}". Partial resources are recorded; use bootstrap_cleanup to close them.\n${agents}` :
						`Bootstrap ${manifest.status}. task_id: "${manifest.task_id}". ${manifest.pane_manifest.length} agent(s); workspace ${manifest.workspace_id} (${manifest.workspace_strategy ?? "shared_cwd"}; mode ${manifest.collaboration_mode ?? "legacy"}; failure_policy ${manifest.failure_policy ?? "independent"}).${manifest.error ? ` Warning: ${manifest.error}.` : ""}${learnedLine}${legacyNote}\n${agents}\n` +
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
				// Read-only: the binding view never resumes management, repairs evidence or substitutes the current version for the bound one.
				const factory_binding = isManaged ? managedBindingFor(status.manifest) : undefined;
				const learnedLine = status.manifest.learned_constraints ? `\nLearned constraints: ${formatLearnedConstraintsSummary(status.manifest.learned_constraints)}` : "";
				const proposalState = proposalsForRun(factory_binding, status.manifest.task_id);
				const text = `Run ${status.manifest.task_id} [${status.manifest.status}/${status.manifest.phase}]: ${status.results.length}/${total} result(s); pending: ${status.pending.join(", ") || "none"}.` +
					(status.manifest.status === "error" && status.manifest.error ? `\nRun error: ${status.manifest.error}` : "") +
					(factory_binding ? `\n${formatFactoryBinding(factory_binding)}` : "") +
					learnedLine +
					formatProposalSummaryLine(proposalState) +
					`\n${formatAgentStates(status.agents, status.manifest.topology)}${errors.length ? `\nErrors:\n${errors.map(error => `- ${error}`).join("\n")}` : ""}` +
					`\n${formatRunOutcome(status.outcome, status.agents)}\n${next}`;
				return response(text, {
					...publicManifest(status.manifest), results: status.results, pending: status.pending, delivery_errors: status.delivery_errors, worker_errors: status.worker_errors,
					agents: status.agents, outcome: status.outcome, timed_out: status.timed_out,
					...(factory_binding ? { factory_binding } : {}),
					...(proposalState.proposals?.length ? { constraint_proposals: proposalState.proposals } : {}),
					...(proposalState.error ? { proposal_evidence_error: proposalState.error } : {}),
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
		description: "For a factory-managed run this is a read-only report (omit results and write_markdown; both are refused): it lists the recorded per-node results and their run outcome, which factory version the run is bound to versus the current one, and the per-node tool and skill policies (declared or inherited), without writing, reconciling or changing anything, and it lists missing, pending or uncertain evidence instead of treating it as success. For other runs: persist report.json and optionally report.md. Omit results to collect agent results automatically (all agents must have finished, or have a recorded final state: a node that did not execute because it was blocked, skipped or cancelled is listed from its record with its causes and has no result; needs_attention is unresolved and refuses automatic collection until resolved). Looped nodes include per-attempt history and verdict history, and blocked joins list their causes. Explicit results must contain exactly one result per node that executed, identified by node_id (agent_name alone is accepted only when exactly one node uses that persona); a node that did not execute (blocked, skipped, cancelled) cannot be given a result and is added from its record. Reports remain writable after bootstrap_cleanup (including automatic cleanup) unless delete_session_files=true deleted the session directory. The report ends with the run outcome (needs_attention, incomplete, failed, blocked, cancelled, skipped, partial or succeeded; only all-success is succeeded). task_id is the run ID, not the workspace ID.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			results: Type.Optional(Type.Array(resultSchema)),
			write_markdown: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				if (service.isFactoryManagedRun(params.task_id, ctx.cwd)) {
					if (params.results !== undefined || params.write_markdown !== undefined) {
						throw new Error(`Factory-managed run "${params.task_id}" supports only a read-only report: omit results and write_markdown (nothing is written, replaced or reconciled for it)`);
					}
					const report = service.readOnlyReport(params.task_id, ctx.cwd);
					const factory_binding = managedBindingFor(report.manifest);
					const proposalState = proposalsForRun(factory_binding, report.manifest.task_id);
					const proposalLine = formatProposalSummaryLine(proposalState).trimStart();
					const text = [
						report.complete ? "Read-only report; nothing was written or changed." : "Read-only report, INCOMPLETE or uncertain; nothing was written or changed. Do not treat it as a success report.",
						`Run ${report.manifest.task_id} [${report.run_status}/${report.phase}]`,
						...(factory_binding ? [formatFactoryBinding(factory_binding)] : []),
						...(proposalLine ? [proposalLine] : []),
						...(report.issues.length ? [`Evidence gaps:\n${report.issues.map(issue => `- ${issue}`).join("\n")}`] : []),
						formatReportDigest(report.results, { runOutcome: formatRunOutcome(report.outcome, report.agents), nodeCounts: report.node_counts, learnedConstraints: report.learned_constraints }),
					].join("\n");
					return response(text, {
						...publicManifest(report.manifest),
						status: report.complete ? "read_only" : "read_only_incomplete", run_status: report.run_status, read_only: true, complete: report.complete, issues: report.issues,
						outcome: report.outcome, results: report.results, unreported: report.unreported,
						...(report.node_counts ? { node_counts: report.node_counts } : {}),
						...(factory_binding ? { factory_binding } : {}),
						...(proposalState.proposals?.length ? { constraint_proposals: proposalState.proposals } : {}),
						...(proposalState.error ? { proposal_evidence_error: proposalState.error } : {}),
					}, report.run_status === "error");
				}
				const paths = await service.report(params.task_id, params.results as BootstrapResult[] | undefined, params.write_markdown ?? false, buildMarkdownReport, ctx.cwd);
				return response(`Report saved: ${paths.report_json}${paths.report_md ? ` (+ ${paths.report_md})` : ""}\n${formatReportDigest(paths.results, { nodeCounts: paths.node_counts, nodeCountsError: paths.node_counts_error, learnedConstraints: paths.learned_constraints })}`, { status: "saved", ...paths });
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
					const learnedLine = status.manifest.learned_constraints ? `\nLearned constraints: ${formatLearnedConstraintsSummary(status.manifest.learned_constraints)}` : "";
					ctx.ui.notify(`Run ${taskId} [${status.manifest.status}/${status.manifest.phase}]${learnedLine}\n${formatAgentStates(status.agents, status.manifest.topology)}\n${formatRunOutcome(status.outcome, status.agents)}${cleanup ? `\n${cleanup}` : ""}`, status.worker_errors.length || status.delivery_errors.length || status.manifest.cleanup_errors?.length ? "warning" : "info");
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
		stopWatchingRequests();
		revokeManagerAuthority(activeAuthority);
		sessionShutDown = false;
		activeBinding = currentBinding(ctx);
		// Factory manager capabilities require OS boot/process identity and are created lazily only
		// when a factory operation is requested; ordinary standalone sessions remain independent.
		activeAuthority = undefined;
		graphs.reset();
		applyExtensionDefaults(import.meta.url, ctx);
	});
	pi.on("session_shutdown", async () => {
		stopWatchingRequests();
		revokeManagerAuthority(activeAuthority);
		activeAuthority = undefined;
		activeBinding = undefined;
		sessionShutDown = true;
		graphs.reset();
	});
}
