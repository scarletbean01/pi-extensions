/**
 * Execution outcomes and dependency policies: pure decisions shared by the worker (admission) and the dispatcher (status, reports).
 *
 * Four things are kept apart: launch/resource state (the manifest's per-agent `status`), execution state (this module), the
 * worker's reported result (`success`/`partial`/`failure`) and verification evidence (check records). A reported success does
 * not prove a check passed, and a closed tab does not erase what a node did.
 */

/** Where a node is in its execution. `needs_attention` is unresolved: it is not terminal and never admits dependents. */
export const EXECUTION_STATES = ["pending", "waiting", "running", "succeeded", "partial", "failed", "blocked", "skipped", "cancelled", "needs_attention"] as const;
export type ExecutionState = typeof EXECUTION_STATES[number];
/** Terminal states: nothing more will happen to the node. */
export const TERMINAL_STATES: readonly ExecutionState[] = ["succeeded", "partial", "failed", "blocked", "skipped", "cancelled"];
/** Terminal states in which the node produced no worker result (it never executed, or was stopped): reported without a result. */
export const NOT_EXECUTED_STATES = ["blocked", "skipped", "cancelled"] as const;
/** States a system record (a disposition) may carry: the node has no worker result. */
export const DISPOSITION_STATES = ["blocked", "skipped", "cancelled", "needs_attention"] as const;
export type DispositionState = typeof DISPOSITION_STATES[number];

/**
 * How a dependency treats its predecessor's reported outcome. `require_success` admits only a success; `allow_partial`
 * also admits a partial result. A failed, blocked, skipped or cancelled predecessor never admits, under either policy.
 */
export const DEPENDENCY_POLICIES = ["require_success", "allow_partial"] as const;
export type DependencyPolicy = typeof DEPENDENCY_POLICIES[number];

export const COLLABORATION_MODES = ["independent", "collaborative"] as const;
export type CollaborationMode = typeof COLLABORATION_MODES[number];
export type ResolvedCollaborationMode = CollaborationMode | "legacy";

export const FAILURE_POLICIES = ["independent", "fail_fast"] as const;
export type FailurePolicy = typeof FAILURE_POLICIES[number];

export const WORKSPACE_STRATEGY = "shared_cwd" as const;
export type WorkspaceStrategy = typeof WORKSPACE_STRATEGY;

/** The state of one check's evidence. `passing` is the only one that satisfies a requirement. */
export type EvidenceStatus = "passing" | "missing" | "unverified" | "stale" | "failed";

/** A reference to the node (and the circumstance) that stopped later work. */
export interface CauseRef {
	node_id: string;
	state: ExecutionState;
	reason: string;
	/** Set when the cause is a required check whose evidence was not acceptable. */
	check?: { name: string; evidence: EvidenceStatus };
}

export interface NodeExecution { state: ExecutionState; causes: CauseRef[]; reason?: string }

export function executionFromResult(status: "success" | "partial" | "failure"): NodeExecution {
	return { state: status === "success" ? "succeeded" : status === "partial" ? "partial" : "failed", causes: [] };
}

export function isTerminal(state: ExecutionState): boolean { return TERMINAL_STATES.includes(state); }

export type AdmissionDecision =
	| { admit: true }
	/** The predecessor is not settled (or needs attention): the node keeps waiting. */
	| { admit: false; outcome: "wait"; reason: string }
	/** The dependency can never be satisfied: the node does not execute. `causes` runs from the direct cause to the original ones. */
	| { admit: false; outcome: "blocked"; reason: string; causes: CauseRef[] };

/** Direct cause first, then the original causes the predecessor itself carried (deduplicated), so a long chain keeps its root. */
export function inheritCauses(direct: CauseRef, inherited: CauseRef[]): CauseRef[] {
	const seen = new Set<string>();
	return [direct, ...inherited].filter(cause => { const key = `${cause.node_id}/${cause.state}/${cause.check?.name ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * May a node whose dependency has this policy start? Checks the predecessor's outcome against the policy, then every required
 * check's evidence: a reported success never satisfies a requirement that evidence does not.
 */
export function decideAdmission(input: { policy: DependencyPolicy; predecessor: { node_id: string; execution: NodeExecution }; checks?: Array<{ name: string; status: EvidenceStatus }> }): AdmissionDecision {
	const { policy, predecessor, checks = [] } = input;
	const { node_id: id, execution } = predecessor;
	switch (execution.state) {
		case "pending": case "waiting": case "running": return { admit: false, outcome: "wait", reason: `${id} has not finished (${execution.state})` };
		case "needs_attention": return { admit: false, outcome: "wait", reason: `${id} needs attention and is unresolved` };
		case "failed": case "blocked": case "skipped": case "cancelled": {
			const why = execution.state === "failed" ? "failed" : execution.state === "blocked" ? "is blocked" : execution.state === "skipped" ? "was skipped" : "was cancelled";
			const reason = `${id} ${why}${execution.reason ? `: ${execution.reason}` : ""}`;
			return { admit: false, outcome: "blocked", reason, causes: inheritCauses({ node_id: id, state: execution.state, reason: execution.reason ?? why }, execution.causes) };
		}
		case "partial":
			if (policy === "require_success") {
				const reason = `${id} reported a partial result and this dependency requires success`;
				return { admit: false, outcome: "blocked", reason, causes: inheritCauses({ node_id: id, state: "partial", reason: execution.reason ?? "partial result" }, execution.causes) };
			}
			break;
		case "succeeded": break;
	}
	const unmet = checks.filter(check => check.status !== "passing");
	if (unmet.length) {
		const reason = `${id} reported ${execution.state === "succeeded" ? "success" : "a partial result"}, but ${unmet.map(check => `check "${check.name}" has ${check.status} evidence`).join(", ")}`;
		return { admit: false, outcome: "blocked", reason, causes: unmet.map(check => ({ node_id: id, state: execution.state, reason: `check "${check.name}": ${check.status} evidence`, check: { name: check.name, evidence: check.status } })) };
	}
	return { admit: true };
}

export type RunState = "incomplete" | "needs_attention" | "failed" | "blocked" | "cancelled" | "skipped" | "partial" | "succeeded";
export interface RunOutcome {
	state: RunState;
	/** Every node has a terminal state (no attention needed, nothing still to run). */
	terminal: boolean;
	counts: Record<ExecutionState, number>;
}

/**
 * The run's outcome from its nodes' states, in a fixed precedence (so it never depends on node order):
 * needs_attention, incomplete (anything still to run), failed, blocked, cancelled, skipped, partial, succeeded.
 * Only a run in which every node succeeded is `succeeded`; unexecuted work is never counted as success.
 */
export function aggregateRun(states: ExecutionState[]): RunOutcome {
	const counts = Object.fromEntries(EXECUTION_STATES.map(state => [state, 0])) as Record<ExecutionState, number>;
	for (const state of states) counts[state]++;
	const has = (...wanted: ExecutionState[]) => wanted.some(state => counts[state] > 0);
	const state: RunState = !states.length ? "incomplete"
		: has("needs_attention") ? "needs_attention"
		: has("pending", "waiting", "running") ? "incomplete"
		: has("failed") ? "failed"
		: has("blocked") ? "blocked"
		: has("cancelled") ? "cancelled"
		: has("skipped") ? "skipped"
		: has("partial") ? "partial"
		: "succeeded";
	return { state, terminal: states.length > 0 && !has("pending", "waiting", "running", "needs_attention"), counts };
}

export type EdgeState = "pending" | "fired" | "dead";

/**
 * Purely derive an edge's state (`pending`, `fired`, `dead`) from existing durable records.
 * Never stored: shared by agents, status, the widget, recovery and cleanup.
 */
export function deriveEdgeState(input: {
	sourceExecution: ExecutionState;
	dependencyPolicy: DependencyPolicy;
	handoffClaimed?: boolean;
	destinationExecution?: ExecutionState;
}): EdgeState {
	if (input.handoffClaimed) return "fired";
	switch (input.sourceExecution) {
		case "pending":
		case "waiting":
		case "running":
		case "needs_attention":
			return "pending";
		case "failed":
		case "blocked":
		case "skipped":
		case "cancelled":
			return "dead";
		case "partial":
			if (input.dependencyPolicy === "require_success") return "dead";
			break;
		case "succeeded":
			break;
	}
	if (input.destinationExecution === "blocked" || input.destinationExecution === "skipped" || input.destinationExecution === "cancelled") {
		return "dead";
	}
	return "fired";
}
