import type { PlannedDecision } from "./decisions.ts";
import type { LaneConfig } from "./lanes.ts";

interface PlanningWarningNode {
	node_id: string;
	inbound_edges: string[];
	read_paths?: string[];
	write_paths?: string[];
	required_checks?: string[];
}

function outboundByNode(
	nodes: ReadonlyArray<PlanningWarningNode>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	ownershipConflicts: ReadonlyArray<{ node_id: string; waits_for_node_id: string }>,
): Map<string, string[]> {
	const outbound = new Map(nodes.map(node => [node.node_id, [] as string[]]));
	const addEdge = (from: string, to: string) => {
		const targets = outbound.get(from);
		if (targets && !targets.includes(to)) targets.push(to);
	};
	for (const node of nodes) {
		for (const predecessor of node.inbound_edges) addEdge(predecessor, node.node_id);
	}

	const loopByMember = new Map<string, string[]>();
	for (const decision of decisions?.values() ?? []) {
		for (const member of decision.loop_body) loopByMember.set(member, decision.loop_body);
	}
	for (const conflict of ownershipConflicts) {
		const holderLoop = loopByMember.get(conflict.waits_for_node_id);
		const waiterLoop = loopByMember.get(conflict.node_id);
		if (holderLoop && holderLoop === waiterLoop) {
			addEdge(conflict.waits_for_node_id, conflict.node_id);
			continue;
		}
		// A holder inside a loop keeps ownership through that loop's finalization, so every loop member
		// precedes the waiter. A member waiting on an outside holder waits only at that member's boundary.
		for (const before of holderLoop ?? [conflict.waits_for_node_id]) {
			addEdge(before, conflict.node_id);
		}
	}
	return outbound;
}

function reaches(from: string, to: string, outbound: ReadonlyMap<string, ReadonlyArray<string>>): boolean {
	const pending = [...(outbound.get(from) ?? [])];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === to) return true;
		if (visited.has(current)) continue;
		visited.add(current);
		pending.push(...(outbound.get(current) ?? []));
	}
	return false;
}

function canRunConcurrently(a: string, b: string, outbound: ReadonlyMap<string, ReadonlyArray<string>>): boolean {
	return a !== b && !reaches(a, b, outbound) && !reaches(b, a, outbound);
}

function canWrite(node: PlanningWarningNode): boolean {
	// A node with read_paths and no write_paths is the documented read-only form.
	return Boolean(node.write_paths?.length) || !node.read_paths?.length;
}

function riskLaneWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	lanes: LaneConfig | undefined,
	outbound: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
	if (!lanes || !decisions?.size) return [];
	const loops = [...decisions.entries()].map(([reviewerId, decision]) => ({ reviewerId, members: decision.loop_body }));
	const loopMembers = new Set(loops.flatMap(loop => loop.members));
	const warnings: string[] = [];

	for (let i = 0; i < loops.length; i++) {
		const left = loops[i];
		for (let j = i + 1; j < loops.length; j++) {
			const right = loops[j];
			const concurrent = left.members.some(a => right.members.some(b => canRunConcurrently(a, b, outbound)));
			if (!concurrent) continue;
			warnings.push(
				`Shared-checkout risk lane warning: loop bodies for ${left.reviewerId} (${left.members.join(", ")}) and ${right.reviewerId} (${right.members.join(", ")}) can run concurrently in the shared checkout. Lane snapshots cover the whole repository, so one loop's review can count the other loop's edits and escalate.`,
			);
		}
	}

	const writers = nodes.filter(node => !loopMembers.has(node.node_id) && canWrite(node));
	for (const loop of loops) {
		for (const writer of writers) {
			if (!loop.members.some(member => canRunConcurrently(member, writer.node_id, outbound))) continue;
			warnings.push(
				`Shared-checkout risk lane warning: loop body for ${loop.reviewerId} (${loop.members.join(", ")}) can run concurrently with writer ${writer.node_id} in the shared checkout. Lane snapshots cover the whole repository, so the loop's review can count the other writer's edits and escalate.`,
			);
		}
	}
	return warnings;
}

function verificationWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	outbound: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
	const checkingNodes = nodes.filter(node => node.required_checks?.length);
	const warnings: string[] = [];
	for (let i = 0; i < checkingNodes.length; i++) {
		for (let j = i + 1; j < checkingNodes.length; j++) {
			const left = checkingNodes[i];
			const right = checkingNodes[j];
			if (!canRunConcurrently(left.node_id, right.node_id, outbound)) continue;
			warnings.push(
				`Shared-checkout verification warning: nodes ${left.node_id} and ${right.node_id} can run concurrently and declare required checks. Record those checks with a scope; unscoped verification uses a conservative whole-tree snapshot.`,
			);
		}
	}
	return warnings;
}

/** Warnings for whole-checkout snapshots that may include changes from concurrent graph branches. */
export function sharedCheckoutPlanningWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	lanes: LaneConfig | undefined,
	ownershipConflicts: ReadonlyArray<{ node_id: string; waits_for_node_id: string }> = [],
): string[] {
	const outbound = outboundByNode(nodes, decisions, ownershipConflicts);
	return [
		...riskLaneWarnings(nodes, decisions, lanes, outbound),
		...verificationWarnings(nodes, outbound),
	];
}
