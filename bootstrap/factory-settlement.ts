/**
 * Factory settlement observations: four separate facts about a run (cancellation intent, resource closure, execution
 * settlement, capacity release), never inferred from one another. Pure over durable run status, so inspection stays read-only.
 */
import type { RunState } from "./outcomes.ts";

export interface SettlementInput {
	manifestStatus: string;
	sessionDirRemoved: boolean;
	cancel: { record?: { reason: string; requested_at: string }; error?: string };
	agents: ReadonlyArray<{ node_id: string; resource: string; execution: string; state: string; cancelling?: boolean; parked?: boolean; finalized?: boolean }>;
	outcome: { state: RunState; terminal: boolean };
	pending: readonly string[];
	workerErrors: readonly string[];
	deliveryErrors: readonly string[];
}

export interface SettlementObservations {
	cancellation: { intent: "none" | "requested" | "unknown"; reason?: string; requested_at?: string; error?: string };
	resource_closure: { state: "open" | "closed" | "mixed" | "unknown"; open: string[]; closed: string[] };
	/** `settled` only on reliable evidence that no attempt, revision or in-flight tool can still act; never from tabs, heartbeat or cancellation alone. */
	execution_settlement: { state: "settled" | "unsettled" | "unknown"; reason: string };
	/** Capacity release is observed from the holds by the factory; here it is always the evidence-side verdict only. */
	outcome: RunState;
	/** Outstanding attention a failed or unresolved run leaves behind. */
	attention: string[];
}

export function observeSettlement(input: SettlementInput): SettlementObservations {
	const cancellation: SettlementObservations["cancellation"] = input.cancel.error
		? { intent: "unknown", error: input.cancel.error }
		: input.cancel.record ? { intent: "requested", reason: input.cancel.record.reason, requested_at: input.cancel.record.requested_at } : { intent: "none" };
	const open = input.agents.filter(agent => agent.resource !== "closed" && agent.resource !== "planned").map(agent => agent.node_id);
	const closed = input.agents.filter(agent => agent.resource === "closed").map(agent => agent.node_id);
	const resource_closure: SettlementObservations["resource_closure"] = {
		state: input.sessionDirRemoved && input.agents.length === 0 ? "unknown" : open.length === 0 ? "closed" : closed.length === 0 ? "open" : "mixed",
		open, closed,
	};
	const blockers: string[] = [];
	const unknown: string[] = [];
	if (cancellation.intent === "unknown") unknown.push(`cancellation record is unreadable (${cancellation.error})`);
	if (input.sessionDirRemoved) unknown.push("run session evidence is no longer present");
	if (input.manifestStatus !== "applied") unknown.push(`run is "${input.manifestStatus}", not an applied run`);
	if (input.agents.length === 0) unknown.push("run reports no nodes");
	if (input.workerErrors.length) unknown.push(`worker errors: ${input.workerErrors.join("; ")}`);
	if (input.deliveryErrors.length) unknown.push(`delivery errors: ${input.deliveryErrors.join("; ")}`);
	if (input.pending.length) blockers.push(`pending nodes: ${input.pending.join(", ")}`);
	if (!input.outcome.terminal) blockers.push(`run outcome is "${input.outcome.state}", not terminal`);
	for (const agent of input.agents) {
		if (agent.cancelling) blockers.push(`${agent.node_id} is still cancelling; in-flight tools may act`);
		if (agent.execution === "running" || agent.execution === "needs_attention" || agent.execution === "pending" || agent.execution === "waiting") blockers.push(`${agent.node_id} execution is ${agent.execution}`);
		if (agent.parked && !agent.finalized) blockers.push(`${agent.node_id} is parked awaiting a possible revision`);
		if (agent.state === "working") blockers.push(`${agent.node_id} is still working`);
	}
	const execution_settlement: SettlementObservations["execution_settlement"] = unknown.length
		? { state: "unknown", reason: unknown.join("; ") }
		: blockers.length ? { state: "unsettled", reason: blockers.join("; ") }
		: { state: "settled", reason: "every node is terminal; nothing is cancelling, parked, working or pending" };
	const attention = ["failed", "needs_attention", "blocked"].includes(input.outcome.state) ? [`run outcome is ${input.outcome.state}`] : [];
	return { cancellation, resource_closure, execution_settlement, outcome: input.outcome.state, attention };
}
