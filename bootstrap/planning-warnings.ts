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

function precomputeReachability(outbound: ReadonlyMap<string, ReadonlyArray<string>>): Map<string, ReadonlySet<string>> {
	const reachable = new Map<string, ReadonlySet<string>>();
	for (const start of outbound.keys()) {
		const pending = [...(outbound.get(start) ?? [])];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			pending.push(...(outbound.get(current) ?? []));
		}
		reachable.set(start, visited);
	}
	return reachable;
}

function canRunConcurrently(a: string, b: string, reachable: ReadonlyMap<string, ReadonlySet<string>>): boolean {
	return a !== b && !reachable.get(a)?.has(b) && !reachable.get(b)?.has(a);
}

function canWrite(node: PlanningWarningNode): boolean {
	// A node with read_paths and no write_paths is the documented read-only form.
	return Boolean(node.write_paths?.length) || !node.read_paths?.length;
}

function riskLaneWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	lanes: LaneConfig | undefined,
	reachable: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
	if (!lanes || !decisions?.size) return [];
	const nodeById = new Map(nodes.map(node => [node.node_id, node]));
	const loops = [...decisions.entries()].map(([reviewerId, decision]) => ({
		reviewerId,
		members: decision.loop_body,
		collisions: new Set<string>(),
		canWrite: decision.loop_body.some(member => {
			const node = nodeById.get(member);
			return Boolean(node && canWrite(node));
		}),
	}));
	const loopMembers = new Set(loops.flatMap(loop => loop.members));

	for (let i = 0; i < loops.length; i++) {
		const left = loops[i];
		for (let j = i + 1; j < loops.length; j++) {
			const right = loops[j];
			if (!left.canWrite && !right.canWrite) continue;
			const concurrent = left.members.some(a => right.members.some(b => canRunConcurrently(a, b, reachable)));
			if (concurrent) {
				if (right.canWrite) left.collisions.add(`loop body for ${right.reviewerId} (${right.members.join(", ")})`);
				if (left.canWrite) right.collisions.add(`loop body for ${left.reviewerId} (${left.members.join(", ")})`);
			}
		}
	}

	const writers = nodes.filter(node => !loopMembers.has(node.node_id) && canWrite(node));
	for (const loop of loops) {
		for (const writer of writers) {
			if (loop.members.some(member => canRunConcurrently(member, writer.node_id, reachable))) {
				loop.collisions.add(`writer ${writer.node_id}`);
			}
		}
	}
	return loops.flatMap(loop => loop.collisions.size > 0 ? [
		`Shared-checkout risk lane warning: loop body for ${loop.reviewerId} (${loop.members.join(", ")}) can run concurrently in the shared checkout with ${[...loop.collisions].join(", and ")}. Lane snapshots cover the whole repository, so this loop's review can count their edits and escalate.`,
	] : []);
}

function verificationWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	reachable: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
	const checkingNodes = nodes.filter(node => node.required_checks?.length);
	const concurrent = new Set<string>();
	for (let i = 0; i < checkingNodes.length; i++) {
		for (let j = i + 1; j < checkingNodes.length; j++) {
			const left = checkingNodes[i];
			const right = checkingNodes[j];
			if (canRunConcurrently(left.node_id, right.node_id, reachable)) {
				concurrent.add(left.node_id);
				concurrent.add(right.node_id);
			}
		}
	}
	if (concurrent.size === 0) return [];
	const nodeNames = checkingNodes.filter(node => concurrent.has(node.node_id)).map(node => node.node_id);
	return [
		`Shared-checkout verification warning: nodes ${nodeNames.join(", ")} can run concurrently with another node that declares required checks. Record those checks with a scope; unscoped verification uses a conservative whole-tree snapshot.`,
	];
}

/** Warnings for whole-checkout snapshots that may include changes from concurrent graph branches. */
export function sharedCheckoutPlanningWarnings(
	nodes: ReadonlyArray<PlanningWarningNode>,
	decisions: ReadonlyMap<string, PlannedDecision> | undefined,
	lanes: LaneConfig | undefined,
	ownershipConflicts: ReadonlyArray<{ node_id: string; waits_for_node_id: string }> = [],
): string[] {
	const loops = decisions ? [...decisions.values()] : [];
	const checkingNodes = nodes.filter(node => node.required_checks?.length);
	const loopMembers = new Set(loops.flatMap(loop => loop.loop_body));
	const hasLaneCandidates = Boolean(lanes && loops.length > 0 && (
		loops.length > 1 || nodes.some(node => !loopMembers.has(node.node_id) && canWrite(node))
	));
	if (!hasLaneCandidates && checkingNodes.length < 2) return [];
	const outbound = outboundByNode(nodes, decisions, ownershipConflicts);
	// Memoize one graph traversal per node; every later pair check is an O(1) set lookup.
	const reachable = precomputeReachability(outbound);
	return [
		...riskLaneWarnings(nodes, decisions, lanes, reachable),
		...verificationWarnings(nodes, reachable),
	];
}
