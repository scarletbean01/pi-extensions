/** Planning for decisions in node-form chains and the limits that bound their loops. */
import type { GenerateRequest, PlannedNode } from "./lifecycle.ts";
import { pathsOverlap } from "./ownership.ts";
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
		if ((request.topology !== "chain" && request.topology !== "graph") || agent.name !== undefined) {
			throw new Error("decision is only supported on node-form chains and graphs (use persona and node_id)");
		}
		requests.set((agent.node_id ?? agent.persona!).trim(), agent.decision);
	}
	if (requests.size === 0) {
		if (request.max_total_attempts !== undefined) throw new Error("max_total_attempts requires a decision node");
		return undefined;
	}

	const inboundById = new Map(nodes.map(node => [node.node_id, node.inbound_edges]));
	const outboundById = new Map<string, string[]>(nodes.map(node => [node.node_id, []]));
	for (const node of nodes) {
		for (const parent of node.inbound_edges) outboundById.get(parent)?.push(node.node_id);
	}
	const collectReachable = (start: string, edges: Map<string, string[]>, includeStart: boolean): Set<string> => {
		const visited = new Set<string>(includeStart ? [start] : []);
		const queue = [start];
		while (queue.length > 0) {
			const current = queue.shift()!;
			for (const next of edges.get(current) ?? []) {
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(next);
			}
		}
		return visited;
	};

	const decisions = new Map<string, PlannedDecision>();
	const inLoop = new Set<string>();
	let derivedTotal = nodes.length;
	for (const node of nodes) {
		const decision = requests.get(node.node_id);
		if (decision === undefined) continue;
		const label = `decision for ${node.node_id}`;
		if (!isRecord(decision)) throw new Error(`${label} must be an object`);
		const field = nonEmpty(decision.field, `${label}.field`);
		const approve = nonEmpty(decision.approve, `${label}.approve`);
		const reject = nonEmpty(decision.reject, `${label}.reject`);
		const target = nonEmpty(decision.on_reject, `${label}.on_reject`).trim().toLowerCase();
		const targetNode = nodes.find(candidate => candidate.node_id.toLowerCase() === target);
		const strictAncestors = collectReachable(node.node_id, inboundById, false);
		if (!targetNode || !strictAncestors.has(targetNode.node_id)) {
			throw new Error(`${label}.on_reject must name a strict ancestor`);
		}

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
		const forwardFromTarget = collectReachable(targetNode.node_id, outboundById, true);
		const loop_body = nodes
			.filter(member => forwardFromTarget.has(member.node_id) && (member.node_id === node.node_id || strictAncestors.has(member.node_id)))
			.map(member => member.node_id);
		const overlap = loop_body.find(id => inLoop.has(id));
		if (overlap !== undefined) throw new Error(`${label}: loop bodies overlap at ${overlap}`);
		const loopJoin = loop_body.find(id => id !== targetNode.node_id && (inboundById.get(id)?.length ?? 0) > 1);
		if (loopJoin !== undefined) {
			throw new Error(`${label}: join node ${loopJoin} is not supported inside loop body (${loop_body.join(" → ")})`);
		}
		const bodySet = new Set(loop_body);
		for (const member of loop_body) {
			if (member === node.node_id) continue;
			const outside = (outboundById.get(member) ?? []).find(succ => !bodySet.has(succ));
			if (outside !== undefined) {
				throw new Error(`${label}: loop body member ${member} cannot have successor ${outside} outside the loop body`);
			}
		}
		for (const id of loop_body) inLoop.add(id);
		const revisions = resolveLimit("maxRevisions", `max_revisions for ${node.node_id}`, decision.max_revisions, 3);
		derivedTotal += revisions.value * loop_body.length;
		decisions.set(node.node_id, {
			field, approve, reject, on_reject: targetNode.node_id, on_exhausted, loop_body,
			max_revisions: revisions.value, max_revisions_source: revisions.source,
		});
	}
	const nodeById = new Map(nodes.map(node => [node.node_id, node]));
	const decisionEntries = [...decisions.entries()];
	for (let i = 0; i < decisionEntries.length; i++) {
		const [r1, d1] = decisionEntries[i];
		const reach1 = collectReachable(r1, outboundById, false);
		for (let j = i + 1; j < decisionEntries.length; j++) {
			const [r2, d2] = decisionEntries[j];
			const reach2 = collectReachable(r2, outboundById, false);
			if (reach1.has(d2.on_reject) || reach2.has(d1.on_reject)) continue;
			for (const m1 of d1.loop_body) {
				const w1 = nodeById.get(m1)?.write_paths ?? [];
				if (!w1.length) continue;
				for (const m2 of d2.loop_body) {
					const w2 = nodeById.get(m2)?.write_paths ?? [];
					for (const p1 of w1) {
						for (const p2 of w2) {
							if (pathsOverlap(p1, p2)) {
								throw new Error(`parallel loops (${d1.on_reject} → ${r1}) and (${d2.on_reject} → ${r2}) have overlapping write_paths (${m1} and ${m2}: ${p1 === p2 ? p1 : `${p1} <-> ${p2}`})`);
							}
						}
					}
				}
			}
		}
	}
	const total = resolveLimit("maxTotalAttempts", "max_total_attempts", request.max_total_attempts, derivedTotal);
	return { decisions, max_total_attempts: total.value, max_total_attempts_source: total.source };
}

export type DecisionPlan = NonNullable<ReturnType<typeof planDecisions>>;
