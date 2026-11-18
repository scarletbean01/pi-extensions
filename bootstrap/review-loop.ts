import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { attemptKey, attemptNumber, reviewLoopFor, type ReviewLoop, type ReviewPlan } from "./review-plan.ts";
export { attemptKey, attemptNumber, reviewLoopFor, type ReviewLoop, type ReviewPlan } from "./review-plan.ts";
import { decideAdmission, type NodeExecution } from "./outcomes.ts";
import { dispositionPath, dispositionRecord, isRecord, parseWorkerReady, processAlive, publishExclusive, readJson, readyPath, resultPath, withRunLock, type AgentLaunch, type BootstrapResult, type CompletionIdentity, type WorkerConfig } from "./session-store.ts";

export function reviewVerdict(loop: ReviewLoop, result: BootstrapResult): "approve" | "reject" | undefined {
	if (result.status !== "success") return;
	const value = result.outputs?.[loop.field];
	if (value === loop.approve) return "approve";
	if (value === loop.reject) return "reject";
	throw new Error("Successful review has no validated verdict");
}

/** Routes persisted review results can take. A rejected review needs a durable reservation to send feedback. */
export function reviewRoutes(dir: string, identity: CompletionIdentity, plan: ReviewPlan, result: BootstrapResult, outbound: string[]) {
	const loop = reviewLoopFor(plan, identity.instance_id);
	const attempt = attemptNumber(identity.attempt_id);
	if (!loop) return outbound.map(instance => ({ instance, attempt: 1 }));
	if (result.status === "failure") return [];
	if (loop.reviewer !== identity.instance_id) {
		return outbound.filter(instance => loop.members.includes(instance)).map(instance => ({ instance, attempt }));
	}
	const verdict = reviewVerdict(loop, result);
	if (verdict === "approve") return outbound.map(instance => ({ instance, attempt: 1 }));
	if (verdict === "reject" && revisionReserved(dir, identity.run_id, loop, attempt + 1)) return [{ instance: loop.target, attempt: attempt + 1 }];
	return [];
}

const reservePath = (dir: string, loop: ReviewLoop, attempt: number) =>
	join(dir, `${loop.reviewer}.${attempt}.revision.json`);

export function revisionReserved(dir: string, run: string, loop: ReviewLoop, attempt: number): boolean {
	const path = reservePath(dir, loop, attempt);
	if (!existsSync(path)) return false;
	const raw = readJson<unknown>(path);
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.reviewer !== loop.reviewer || raw.attempt !== attempt) {
		throw new Error("Invalid or unsupported revision reservation");
	}
	return true;
}

/** Reserve a whole loop iteration before offering any part of it. Retries reuse the same reservation. */
export async function reserveRevision(dir: string, run: string, plan: ReviewPlan, loop: ReviewLoop, attempt: number): Promise<string | undefined> {
	if (attempt > loop.max_revisions + 1) return "Review loop exhausted its revision limit";
	return withRunLock(join(dir, "review-budget"), async () => {
		if (revisionReserved(dir, run, loop, attempt)) return;
		let reserved = plan.node_count;
		for (const candidate of plan.loops) {
			for (let n = 2; n <= candidate.max_revisions + 1; n++) {
				if (revisionReserved(dir, run, candidate, n)) reserved += candidate.members.length;
			}
		}
		if (reserved + loop.members.length > plan.max_total_attempts) return "Run attempt budget exhausted";
		publishExclusive(reservePath(dir, loop, attempt), JSON.stringify({ version: 1, run_id: run, reviewer: loop.reviewer, attempt }) + "\n");
	});
}

interface Finalization {
	version: 1;
	run_id: string;
	instance_id: string;
	attempt_id: string;
	finalized_by: string;
	exhausted?: { state: "needs_attention" | "failed"; reason: string };
}

export const finalizePath = (dir: string, instance: string) => join(dir, `${instance}.finalize.json`);
const transitionPath = (dir: string, instance: string, fromAttempt: number) => join(dir, `${instance}.${fromAttempt}.transition.json`);

interface LoopTransition {
	version: 1;
	run_id: string;
	instance_id: string;
	from_attempt: number;
	winner: "revision" | "finalized";
	next_attempt?: number;
}

export function readLoopTransition(dir: string, run: string, instance: string, fromAttempt: number): LoopTransition | undefined {
	const path = transitionPath(dir, instance, fromAttempt);
	if (!existsSync(path)) return;
	const raw = readJson<unknown>(path);
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.instance_id !== instance ||
		raw.from_attempt !== fromAttempt || (raw.winner !== "revision" && raw.winner !== "finalized") ||
		(raw.winner === "revision" && raw.next_attempt !== fromAttempt + 1)) {
		throw new Error("Invalid or unsupported loop transition record");
	}
	return raw as unknown as LoopTransition;
}

/**
 * Atomically arbitrate between a revision claim for `nextAttempt` and finalization from `fromAttempt`.
 * Exactly one wins; if finalization won, the revision is rejected as "node finalized".
 */
export function claimRevisionTransition(dir: string, run: string, instance: string, fromAttempt: number, nextAttempt: number): { outcome: "proceed" } | { outcome: "rejected"; reason: string } {
	if (existsSync(finalizePath(dir, instance))) return { outcome: "rejected", reason: "node finalized" };
	const record: LoopTransition = { version: 1, run_id: run, instance_id: instance, from_attempt: fromAttempt, winner: "revision", next_attempt: nextAttempt };
	if (publishExclusive(transitionPath(dir, instance, fromAttempt), JSON.stringify(record) + "\n")) {
		if (existsSync(finalizePath(dir, instance))) return { outcome: "rejected", reason: "node finalized" };
		return { outcome: "proceed" };
	}
	const prior = readLoopTransition(dir, run, instance, fromAttempt);
	if (prior?.winner === "revision" && prior.next_attempt === nextAttempt) return { outcome: "proceed" };
	return { outcome: "rejected", reason: "node finalized" };
}

export function deadLoopMembers(
	dir: string,
	loop: ReviewLoop,
	roster: ReadonlyArray<Pick<AgentLaunch, "instance_id" | "node_id" | "status">>,
	excludeInstance?: string,
): Array<{ instance_id: string; node_id: string }> {
	const dead: Array<{ instance_id: string; node_id: string }> = [];
	for (const memberId of loop.members) {
		if (memberId === excludeInstance) continue;
		const entry = roster.find(item => item.instance_id === memberId);
		if (!entry) continue;
		if (entry.status === "closed") {
			dead.push({ instance_id: entry.instance_id, node_id: entry.node_id });
			continue;
		}
		const readyFile = readyPath(dir, memberId);
		if (existsSync(readyFile)) {
			try {
				if (!processAlive(parseWorkerReady(readJson<unknown>(readyFile)))) {
					dead.push({ instance_id: entry.instance_id, node_id: entry.node_id });
				}
			} catch { /* unreadable ready file is handled elsewhere */ }
		}
	}
	return dead;
}

export function readFinalization(dir: string, run: string, loop: ReviewLoop, instance: string): Finalization | undefined {
	let finalizedTransition: LoopTransition | undefined;
	for (let n = 1; n <= loop.max_revisions + 1; n++) {
		const transition = readLoopTransition(dir, run, instance, n);
		if (transition?.winner === "finalized") finalizedTransition = transition;
	}
	const path = finalizePath(dir, instance);
	if (!existsSync(path)) {
		if (!finalizedTransition) return;
		return {
			version: 1,
			run_id: run,
			instance_id: instance,
			attempt_id: `${instance}.${finalizedTransition.from_attempt}`,
			finalized_by: "dispatcher",
		};
	}
	const raw = readJson<unknown>(path);
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.instance_id !== instance ||
		(typeof raw.finalized_by !== "string" || (!loop.members.includes(raw.finalized_by) && raw.finalized_by !== "dispatcher")) ||
		!Array.from({ length: loop.max_revisions + 1 }, (_, i) => `${instance}.${i + 1}`).includes(String(raw.attempt_id)) ||
		(raw.exhausted !== undefined && (!isRecord(raw.exhausted) || raw.exhausted.state !== loop.on_exhausted ||
			typeof raw.exhausted.reason !== "string" || instance !== loop.reviewer))) {
		throw new Error("Invalid or unsupported finalization record");
	}
	return raw as unknown as Finalization;
}

export function finalizeReview(dir: string, run: string, loop: ReviewLoop, attempt: number, reason?: string, author = loop.reviewer, options?: { force?: boolean }): void {
	if (author !== "dispatcher" && !loop.members.includes(author)) {
		throw new Error(`Invalid finalization author ${author}`);
	}
	const entries = readdirSync(dir);
	const targets: string[] = [];
	for (const instance of loop.members) {
		const key = `${instance}.${attempt}`;
		const finished = existsSync(resultPath(dir, key)) || existsSync(dispositionPath(dir, key));
		if (!finished) {
			if (options?.force) continue;
			throw new Error(`Cannot finalize ${instance}: attempt ${attempt} is still running`);
		}
		const priorTransition = readLoopTransition(dir, run, instance, attempt);
		if (priorTransition?.winner === "revision") {
			if (options?.force) continue;
			throw new Error(`Cannot finalize ${instance}: revision attempt ${priorTransition.next_attempt} is running`);
		}
		if (entries.some(name => name.startsWith(`${instance}.${attempt + 1}.`) && name.endsWith(".handoff.json"))) {
			if (options?.force) continue;
			throw new Error(`Cannot finalize ${instance}: revision attempt ${attempt + 1} is running`);
		}
		targets.push(instance);
	}
	for (const instance of targets) {
		const transition: LoopTransition = { version: 1, run_id: run, instance_id: instance, from_attempt: attempt, winner: "finalized" };
		if (!publishExclusive(transitionPath(dir, instance, attempt), JSON.stringify(transition) + "\n")) {
			const prior = readLoopTransition(dir, run, instance, attempt);
			if (prior?.winner === "revision") {
				if (options?.force) continue;
				throw new Error(`Cannot finalize ${instance}: revision attempt ${prior.next_attempt} is running`);
			}
		}
		const record: Finalization = {
			version: 1, run_id: run, instance_id: instance, attempt_id: `${instance}.${attempt}`, finalized_by: author,
			...(instance === loop.reviewer && reason ? { exhausted: { state: loop.on_exhausted, reason } } : {}),
		};
		if (!publishExclusive(finalizePath(dir, instance), JSON.stringify(record) + "\n")) {
			const prior = readFinalization(dir, run, loop, instance);
			if (prior?.attempt_id !== record.attempt_id) throw new Error(`Node ${instance} was already finalized`);
		}
	}
}

type ReviewActor = Pick<WorkerConfig, "session_dir" | "task_id" | "review_plan" | "instance_id" | "node_id" | "attempt_id"> & {
	roster?: ReadonlyArray<Pick<AgentLaunch, "instance_id" | "node_id" | "persona_name">>;
};

/** A definitive failure or disposition prevents the remaining members of this chain iteration from starting. */
export function settleReviewFailure(config: ReviewActor, execution: NodeExecution, author = config.instance_id): void {
	const loop = reviewLoopFor(config.review_plan, config.instance_id);
	if (!loop) return;
	const attempt = attemptNumber(config.attempt_id);
	let predecessor = { node_id: config.node_id, execution };
	for (const instance of loop.members.slice(loop.members.indexOf(config.instance_id) + 1)) {
		const member = config.roster?.find(item => item.instance_id === instance);
		if (!member) throw new Error(`Missing review loop member ${instance} from the roster`);
		const key = attemptKey(config.review_plan, instance, attempt);
		const blocked = decideAdmission({ policy: "require_success", predecessor });
		if (blocked.admit || blocked.outcome !== "blocked") return;
		if (!existsSync(resultPath(config.session_dir, key))) {
			const path = dispositionPath(config.session_dir, key);
			const record = dispositionRecord({ ...member, attempt_id: key, task_id: config.task_id }, "blocked", blocked.reason, blocked.causes, new Date().toISOString());
			publishExclusive(path, JSON.stringify(record, null, 2) + "\n");
		}
		predecessor = { node_id: member.node_id, execution: { state: "blocked", reason: blocked.reason, causes: blocked.causes } };
	}
	finalizeReview(config.session_dir, config.task_id, loop, attempt, undefined, author, { force: true });
}
