import type { DecisionPlan, PlannedDecision } from "./decisions.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface ReviewLoop extends PlannedDecision {
	reviewer: string;
	target: string;
	members: string[];
}

export interface ReviewPlan {
	max_total_attempts: number;
	max_total_attempts_source: DecisionPlan["max_total_attempts_source"];
	node_count: number;
	loops: ReviewLoop[];
}

export const attemptNumber = (id?: string): number => Number(id?.split(".").at(-1) ?? 1);
export const attemptKey = (plan: ReviewPlan | undefined, instance: string, attempt = 1): string =>
	plan ? `${instance}.${attempt}` : instance;

export const reviewLoopFor = (plan: ReviewPlan | undefined, instance: string) =>
	plan?.loops.find(loop => loop.members.includes(instance));

export function parseReviewPlan(raw: unknown): ReviewPlan {
	if (!isRecord(raw) || !Number.isSafeInteger(raw.max_total_attempts) || Number(raw.max_total_attempts) < 1 ||
		!["request", "project", "global", "built-in"].includes(String(raw.max_total_attempts_source)) ||
		!Number.isSafeInteger(raw.node_count) || Number(raw.node_count) < 1 || !Array.isArray(raw.loops) || !raw.loops.length) {
		throw new Error("Invalid persisted review plan");
	}
	const instance = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
	const ids = new Set<string>();
	for (const loop of raw.loops) {
		if (!isRecord(loop) || !instance(loop.reviewer) || !instance(loop.target) || !Array.isArray(loop.members) ||
			!loop.members.includes(loop.reviewer) || !loop.members.includes(loop.target) ||
			!loop.members.every(id => instance(id) && !ids.has(id) && ids.add(id)) ||
			!Number.isInteger(loop.max_revisions) || Number(loop.max_revisions) < 1 || Number(loop.max_revisions) > 10 ||
			![loop.field, loop.approve, loop.reject].every(value => typeof value === "string" && value.length > 0) ||
			loop.approve === loop.reject || !["needs_attention", "failed"].includes(String(loop.on_exhausted))) {
			throw new Error("Invalid persisted review loop");
		}
	}
	return raw as unknown as ReviewPlan;
}
