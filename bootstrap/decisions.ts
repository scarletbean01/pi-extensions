/** Planning for decisions in node-form chains and the limits that bound their loops. */
import type { GenerateRequest, PlannedNode } from "./lifecycle.ts";
import { isRecord, nonEmpty } from "./session-store.ts";

export interface RequestedDecision {
	field: string;
	approve: string;
	reject: string;
	on_reject: string;
	max_revisions?: number;
	on_exhausted?: "needs_attention" | "failed";
}

type LimitKey = "maxRevisions" | "maxTotalAttempts";
type Limits = Partial<Record<LimitKey, number>>;
interface GraphLimits {
	defaults: Limits;
	ceilings: Limits;
}

type LimitSource = "request" | "project" | "global" | "built-in";

export interface PlannedDecision extends Required<RequestedDecision> {
	max_revisions_source: LimitSource;
	loop_body: string[];
}

function validateLimit(value: unknown, key: LimitKey, label: string): number {
	const max = key === "maxRevisions" ? 10 : Number.MAX_SAFE_INTEGER;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new Error(`${label} must be ${key === "maxRevisions" ? "an integer between 1 and 10" : "a positive safe integer"}`);
	}
	return value;
}

export function validateGraphLimits(path: string, graph: unknown): GraphLimits {
	if (graph !== undefined && !isRecord(graph)) throw new Error(`${path}: "graph" must be an object`);
	for (const key of Object.keys(graph ?? {})) {
		if (key !== "defaults" && key !== "ceilings") {
			throw new Error(`${path}: "graph.${key}" is not a recognized key`);
		}
	}
	const readLimits = (group: "defaults" | "ceilings"): Limits => {
		const block = graph?.[group];
		if (block === undefined) return {};
		if (!isRecord(block)) throw new Error(`${path}: "graph.${group}" must be an object`);
		const limits: Limits = {};
		for (const [key, value] of Object.entries(block)) {
			if (key !== "maxRevisions" && key !== "maxTotalAttempts") {
				throw new Error(`${path}: "graph.${group}.${key}" is not a recognized limit`);
			}
			limits[key] = validateLimit(value, key, `${path}: "graph.${group}.${key}"`);
		}
		return limits;
	};
	const defaults = readLimits("defaults");
	const ceilings = readLimits("ceilings");
	for (const key of ["maxRevisions", "maxTotalAttempts"] as const) {
		if ((defaults[key] ?? 0) > (ceilings[key] ?? Infinity)) {
			throw new Error(`${path}: "graph.defaults.${key}" exceeds "graph.ceilings.${key}"`);
		}
	}
	return { defaults, ceilings };
}

/** The chain is already normalized into dependency order, including explicit step order. */
export function planDecisions(request: GenerateRequest, nodes: PlannedNode[], project: GraphLimits, global: GraphLimits) {
	const resolveLimit = (key: LimitKey, label: string, requested: unknown, builtIn: number) => {
		const value = requested === undefined
			? project.defaults[key] ?? global.defaults[key] ?? builtIn
			: validateLimit(requested, key, label);
		const source: LimitSource = requested !== undefined ? "request"
			: project.defaults[key] !== undefined ? "project"
			: global.defaults[key] !== undefined ? "global" : "built-in";
		const ceiling = Math.min(project.ceilings[key] ?? Infinity, global.ceilings[key] ?? Infinity);
		if (value > ceiling) {
			const suggestion = source === "built-in" ? `. Set a default at "graph.defaults.${key}" at or below the ceiling` : "";
			throw new Error(`${label} (${value} from ${source}) exceeds the configured ceiling (${ceiling})${suggestion}`);
		}
		return { value, source };
	};

	const requests = new Map<string, RequestedDecision>();
	for (const agent of request.agents) {
		if (agent.decision === undefined) continue;
		if (request.topology !== "chain" || agent.name !== undefined) {
			throw new Error("decision is only supported on node-form chains (use persona and node_id)");
		}
		requests.set((agent.node_id ?? agent.persona!).trim(), agent.decision);
	}
	if (requests.size === 0) {
		if (request.max_total_attempts !== undefined) throw new Error("max_total_attempts requires a decision node");
		return undefined;
	}

	const decisions = new Map<string, PlannedDecision>();
	const inLoop = new Set<string>();
	let derivedTotal = nodes.length;
	for (const [index, node] of nodes.entries()) {
		const decision = requests.get(node.node_id);
		if (decision === undefined) continue;
		const label = `decision for ${node.node_id}`;
		if (!isRecord(decision)) throw new Error(`${label} must be an object`);
		const field = nonEmpty(decision.field, `${label}.field`);
		const approve = nonEmpty(decision.approve, `${label}.approve`);
		const reject = nonEmpty(decision.reject, `${label}.reject`);
		const target = nonEmpty(decision.on_reject, `${label}.on_reject`).trim().toLowerCase();
		const targetIndex = nodes.findIndex(candidate => candidate.node_id.toLowerCase() === target);
		if (targetIndex < 0 || targetIndex >= index) throw new Error(`${label}.on_reject must name a strict ancestor`);

		const property = node.output_contract?.properties?.[field];
		if (property?.type !== "string" || property.enum?.length !== 2 || approve === reject
			|| !property.enum.includes(approve) || !property.enum.includes(reject)) {
			throw new Error(`${label}: output_contract must declare "${field}" as a string enum of exactly the approve and reject values`);
		}
		if (property.required !== true && !node.output_contract?.required_fields?.includes(field)) {
			throw new Error(`${label}: output_contract verdict field "${field}" must be required`);
		}
		const on_exhausted = decision.on_exhausted === undefined ? "needs_attention" : decision.on_exhausted;
		if (on_exhausted !== "needs_attention" && on_exhausted !== "failed") {
			throw new Error(`${label}.on_exhausted must be needs_attention or failed`);
		}
		const loop_body = nodes.slice(targetIndex, index + 1).map(member => member.node_id);
		const overlap = loop_body.find(id => inLoop.has(id));
		if (overlap !== undefined) throw new Error(`${label}: loop bodies overlap at ${overlap}`);
		for (const id of loop_body) inLoop.add(id);
		const revisions = resolveLimit("maxRevisions", `max_revisions for ${node.node_id}`, decision.max_revisions, 3);
		derivedTotal += revisions.value * loop_body.length;
		decisions.set(node.node_id, {
			field, approve, reject, on_reject: nodes[targetIndex].node_id, on_exhausted, loop_body,
			max_revisions: revisions.value, max_revisions_source: revisions.source,
		});
	}
	const total = resolveLimit("maxTotalAttempts", "max_total_attempts", request.max_total_attempts, derivedTotal);
	return { decisions, max_total_attempts: total.value, max_total_attempts_source: total.source };
}

export type DecisionPlan = NonNullable<ReturnType<typeof planDecisions>>;
