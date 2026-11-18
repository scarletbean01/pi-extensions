import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { attemptKey, attemptNumber, reviewLoopFor, type ReviewLoop, type ReviewPlan } from "./review-plan.ts";
export { attemptKey, attemptNumber, reviewLoopFor, type ReviewLoop, type ReviewPlan } from "./review-plan.ts";
import { decideAdmission, type AdmissionDecision, type NodeExecution } from "./outcomes.ts";
import { dispositionPath, dispositionRecord, errorMessage, expectedResultVersion, isRecord, parseCompletion, parseDisposition, parseWorkerReady, processAlive, publishExclusive, readJson, readyPath, resultPath, withRunLock, withSyncRunLock, type AgentLaunch, type BootstrapResult, type CompletionIdentity, type Topology, type WorkerConfig } from "./session-store.ts";

function readReviewRecord(path: string, label: string): unknown {
	try {
		return readJson<unknown>(path);
	} catch (error) {
		throw new Error(`Invalid or unsupported ${label} (${basename(path)}): ${errorMessage(error)}`);
	}
}

function resolveReviewResultVersion(dir: string, topology?: Topology): number | undefined {
	let resolved = topology;
	if (resolved === undefined) {
		const manifestFile = join(dir, "manifest.json");
		if (existsSync(manifestFile)) {
			try {
				const raw = readJson<{ topology?: Topology }>(manifestFile);
				if (raw.topology === "chain" || raw.topology === "graph") resolved = raw.topology;
			} catch { /* ignore unreadable manifest */ }
		}
	}
	return resolved ? expectedResultVersion({ topology: resolved, review_plan: { loops: [] } }) : undefined;
}

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
		return outbound.flatMap(instance => loop.members.includes(instance)
			? [{ instance, attempt }]
			: attempt === 1 ? [{ instance, attempt: 1 }] : []);
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
	const raw = readReviewRecord(path, "revision reservation");
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.reviewer !== loop.reviewer || raw.attempt !== attempt) {
		throw new Error(`Invalid or unsupported revision reservation (${basename(path)})`);
	}
	return true;
}

function revisionLimit(loop: ReviewLoop, attempt: number): string | undefined {
	if (attempt > loop.max_revisions + 1) return `Review loop exhausted its revision limit (${loop.target} → ${loop.reviewer})`;
}

function revisionBudget(dir: string, run: string, plan: ReviewPlan, loop: ReviewLoop, attempt: number): string | undefined {
	if (revisionReserved(dir, run, loop, attempt)) return;
	let reserved = plan.node_count;
	for (const candidate of plan.loops) {
		for (let n = 2; n <= candidate.max_revisions + 1; n++) {
			if (revisionReserved(dir, run, candidate, n)) reserved += candidate.members.length;
		}
	}
	if (reserved + loop.members.length > plan.max_total_attempts) return "Run attempt budget exhausted";
}

/** Reserve a whole loop iteration before offering any part of it. Retries reuse the same reservation. */
export async function reserveRevision(dir: string, run: string, plan: ReviewPlan, loop: ReviewLoop, attempt: number): Promise<string | undefined> {
	const limit = revisionLimit(loop, attempt);
	if (limit) return limit;
	return withRunLock(join(dir, "review-budget"), async () =>
		withSyncRunLock(loopLock(dir, loop), () => {
			if (readFinalization(dir, run, loop, loop.reviewer)) return;
			if (revisionReserved(dir, run, loop, attempt)) return;
			const exhausted = revisionBudget(dir, run, plan, loop, attempt);
			if (exhausted) return exhausted;
			publishExclusive(reservePath(dir, loop, attempt), JSON.stringify({ version: 1, run_id: run, reviewer: loop.reviewer, attempt }) + "\n");
		}),
	);
}

interface Finalization {
	version: 1;
	run_id: string;
	instance_id: string;
	attempt_id: string;
	finalized_by: string;
	exhausted?: { state: "needs_attention" | "failed"; reason: string };
}

export function finalizedReviewRejection(
	loop: ReviewLoop, finalization: Finalization | undefined, node_id: string, result: BootstrapResult | undefined,
): Finalization["exhausted"] {
	if (finalization?.instance_id !== loop.reviewer) return;
	if (finalization.exhausted) return finalization.exhausted;
	if (result?.status === "success" && result.outputs?.[loop.field] === loop.reject) {
		return { state: "failed", reason: `${node_id} rejected the work and the review loop was finalized: ${result.summary}` };
	}
}

/** A finalized decision without approval closes its forward edges under every dependency policy. */
export function blockedReviewForwardEdge(
	loop: ReviewLoop, finalization: Finalization | undefined, node_id: string,
	execution: NodeExecution | undefined, result?: BootstrapResult,
): Extract<AdmissionDecision, { outcome: "blocked" }> | undefined {
	if (finalization?.instance_id !== loop.reviewer || !execution) return;
	const rejection = finalizedReviewRejection(loop, finalization, node_id, result);
	if (rejection) return { admit: false, outcome: "blocked", reason: rejection.reason, causes: [{ node_id, ...rejection }] };
	if (execution.state === "partial") {
		const reason = `${node_id} reported a partial result: ${execution.reason ?? "review was inconclusive"}`;
		return { admit: false, outcome: "blocked", reason, causes: [{ node_id, state: "partial", reason: execution.reason ?? reason }] };
	}
	const decision = decideAdmission({ policy: "require_success", predecessor: { node_id, execution } });
	if (!decision.admit && decision.outcome === "blocked") return decision;
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
	const raw = readReviewRecord(path, "loop transition record");
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.instance_id !== instance ||
		raw.from_attempt !== fromAttempt || (raw.winner !== "revision" && raw.winner !== "finalized") ||
		(raw.winner === "revision" && raw.next_attempt !== fromAttempt + 1)) {
		throw new Error(`Invalid or unsupported loop transition record (${basename(path)})`);
	}
	return raw as unknown as LoopTransition;
}

const loopLock = (dir: string, loop: ReviewLoop) => join(dir, `${loop.reviewer}.review`);

/** Claims and finalization serialize across the whole loop, including claims by different members. */
export function claimRevisionTransition(dir: string, run: string, loop: ReviewLoop, instance: string, fromAttempt: number, nextAttempt: number): { outcome: "proceed" } | { outcome: "rejected"; reason: string } {
	return withSyncRunLock(loopLock(dir, loop), () => {
		if (readFinalization(dir, run, loop, loop.reviewer) || readFinalization(dir, run, loop, instance)) {
			return { outcome: "rejected", reason: "node finalized" };
		}
		const record: LoopTransition = { version: 1, run_id: run, instance_id: instance, from_attempt: fromAttempt, winner: "revision", next_attempt: nextAttempt };
		if (publishExclusive(transitionPath(dir, instance, fromAttempt), JSON.stringify(record) + "\n")) return { outcome: "proceed" };
		const prior = readLoopTransition(dir, run, instance, fromAttempt);
		if (prior?.winner === "revision" && prior.next_attempt === nextAttempt) return { outcome: "proceed" };
		return { outcome: "rejected", reason: "node finalized" };
	});
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

function readFinalizeRecord(dir: string, run: string, loop: ReviewLoop, instance: string): Finalization | undefined {
	const path = finalizePath(dir, instance);
	if (!existsSync(path)) return;
	const raw = readReviewRecord(path, "finalization record");
	if (!isRecord(raw) || raw.version !== 1 || raw.run_id !== run || raw.instance_id !== instance ||
		(typeof raw.finalized_by !== "string" || (!loop.members.includes(raw.finalized_by) && raw.finalized_by !== "dispatcher")) ||
		!Array.from({ length: loop.max_revisions + 1 }, (_, i) => `${instance}.${i + 1}`).includes(String(raw.attempt_id)) ||
		(raw.exhausted !== undefined && (!isRecord(raw.exhausted) ||
			(raw.exhausted.state !== loop.on_exhausted && !(raw.finalized_by === "dispatcher" && raw.exhausted.state === "needs_attention")) ||
			typeof raw.exhausted.reason !== "string" || instance !== loop.reviewer))) {
		throw new Error(`Invalid or unsupported finalization record (${basename(path)})`);
	}
	return raw as unknown as Finalization;
}

function finishedAttempt(dir: string, instance: string, attempt: number): boolean {
	const key = `${instance}.${attempt}`;
	return existsSync(resultPath(dir, key)) || existsSync(dispositionPath(dir, key));
}

function recoverTransitionFinalization(dir: string, run: string, loop: ReviewLoop, instance: string, attempt: number, topology?: Topology): Finalization {
	const attempt_id = `${instance}.${attempt}`;
	let reason: string | undefined;
	// Older workers wrote the transition first. Their saved decision and reservations recover
	// the exhaustion cause even if the finalize record was never published.
	if (instance === loop.reviewer && existsSync(resultPath(dir, attempt_id))) {
		const version = resolveReviewResultVersion(dir, topology);
		const saved = parseCompletion(readJson<unknown>(resultPath(dir, attempt_id)), { run_id: run, instance_id: instance, attempt_id, ...(version !== undefined ? { version } : {}) });
		if (reviewVerdict(loop, saved.result) === "reject") {
			reason = revisionLimit(loop, attempt + 1) ??
				(saved.review_plan && !revisionReserved(dir, run, loop, attempt + 1) ? "Run attempt budget exhausted" : undefined);
		}
	}
	return {
		version: 1, run_id: run, instance_id: instance, attempt_id, finalized_by: loop.reviewer,
		...(reason ? { exhausted: { state: loop.on_exhausted, reason } } : {}),
	};
}

export function readFinalization(dir: string, run: string, loop: ReviewLoop, instance: string, topology?: Topology): Finalization | undefined {
	let finalizedAttempt: number | undefined;
	for (let n = 1; n <= loop.max_revisions + 1; n++) {
		if (readLoopTransition(dir, run, instance, n)?.winner === "finalized") finalizedAttempt = n;
	}
	const own = readFinalizeRecord(dir, run, loop, instance);
	if (own) return own;
	const decision = instance !== loop.reviewer && readFinalizeRecord(dir, run, loop, loop.reviewer);
	if (decision) {
		const attempt = attemptNumber(decision.attempt_id);
		if (finishedAttempt(dir, instance, attempt) && readLoopTransition(dir, run, instance, attempt)?.winner !== "revision") {
			return { version: 1, run_id: run, instance_id: instance, attempt_id: `${instance}.${attempt}`, finalized_by: decision.finalized_by };
		}
	}
	if (finalizedAttempt !== undefined) return recoverTransitionFinalization(dir, run, loop, instance, finalizedAttempt, topology);
}

export function attemptStarted(dir: string, instance: string, attempt: number, entries = readdirSync(dir)): boolean {
	return entries.some(name => name.startsWith(`${instance}.${attempt}.`) && name.endsWith(".handoff.json")) ||
		existsSync(resultPath(dir, `${instance}.${attempt}`)) ||
		existsSync(dispositionPath(dir, `${instance}.${attempt}`));
}

/** Whether `attempt` of `instance` has been claimed or started (excludes unclaimed inbound offers). */
export function attemptClaimedOrStarted(dir: string, instance: string, attempt: number, entries = readdirSync(dir)): boolean {
	return entries.some(name => name.startsWith(`${instance}.${attempt}.`) && name.endsWith(".handoff-claim.json")) ||
		existsSync(join(dir, `${instance}.${attempt}.progress.json`)) ||
		existsSync(resultPath(dir, `${instance}.${attempt}`)) ||
		existsSync(dispositionPath(dir, `${instance}.${attempt}`));
}

function revisionAhead(dir: string, _run: string, loop: ReviewLoop, attempt: number): string | undefined {
	const entries = readdirSync(dir);
	for (const instance of loop.members) {
		if (attemptStarted(dir, instance, attempt + 1, entries)) return instance;
	}
}

function publishTransition(dir: string, run: string, instance: string, from_attempt: number, winner: LoopTransition["winner"]): void {
	const record: LoopTransition = {
		version: 1, run_id: run, instance_id: instance, from_attempt, winner,
		...(winner === "revision" ? { next_attempt: from_attempt + 1 } : {}),
	};
	if (!publishExclusive(transitionPath(dir, instance, from_attempt), JSON.stringify(record) + "\n") &&
		readLoopTransition(dir, run, instance, from_attempt)?.winner !== winner) {
		throw new Error(`Conflicting review transition for ${instance}.${from_attempt}`);
	}
}

function finalizeReviewLocked(dir: string, run: string, loop: ReviewLoop, attempt: number, reason: string | undefined, author: string, force: boolean, exhaustedState?: "needs_attention" | "failed", allowAhead = false): void {
	let decision = readFinalization(dir, run, loop, loop.reviewer);
	if (decision && attemptNumber(decision.attempt_id) !== attempt) return;
	const ahead = revisionAhead(dir, run, loop, attempt);
	if (ahead) {
		if (allowAhead && !decision) {
			// A dead parked member makes the in-flight revision uncompletable; finalize the reviewer's attempt anyway.
		} else if (force && !decision) return;
		else throw new Error(`Cannot finalize ${ahead}: revision attempt ${attempt + 1} is running`);
	}
	if (!decision && !force) {
		const running = loop.members.find(instance => !finishedAttempt(dir, instance, attempt));
		if (running) throw new Error(`Cannot finalize ${running}: attempt ${attempt} is still running`);
	}
	if (!decision && !finishedAttempt(dir, loop.reviewer, attempt)) return;
	for (const instance of loop.members) {
		const prior = readFinalization(dir, run, loop, instance);
		if (prior && attemptNumber(prior.attempt_id) !== attempt) throw new Error(`Node ${instance} was already finalized`);
	}
	decision ??= {
		version: 1, run_id: run, instance_id: loop.reviewer, attempt_id: `${loop.reviewer}.${attempt}`, finalized_by: author,
		...(reason ? { exhausted: { state: exhaustedState ?? loop.on_exhausted, reason } } : {}),
	};
	// The decision record commits the loop to one attempt. The lock excludes revision
	// claims until then, and readers can recover member finalizations from it afterwards.
	publishExclusive(finalizePath(dir, loop.reviewer), JSON.stringify(decision) + "\n");
	for (const instance of loop.members) {
		if (!finishedAttempt(dir, instance, attempt)) continue;
		if (attempt > 1) publishTransition(dir, run, instance, attempt - 1, "revision");
		if (readLoopTransition(dir, run, instance, attempt)?.winner !== "revision") {
			publishTransition(dir, run, instance, attempt, "finalized");
		}
		if (instance === loop.reviewer) continue;
		if (readLoopTransition(dir, run, instance, attempt)?.winner === "revision") continue;
		const record: Finalization = {
			version: 1, run_id: run, instance_id: instance, attempt_id: `${instance}.${attempt}`,
			finalized_by: author === "dispatcher" ? author : decision.finalized_by,
		};
		publishExclusive(finalizePath(dir, instance), JSON.stringify(record) + "\n");
	}
}

export function finalizeReview(dir: string, run: string, loop: ReviewLoop, attempt: number, reason?: string, author = loop.reviewer, options?: { force?: boolean; allowAhead?: boolean; exhaustedState?: "needs_attention" | "failed" }): void {
	if (author !== "dispatcher" && !loop.members.includes(author)) throw new Error(`Invalid finalization author ${author}`);
	withSyncRunLock(loopLock(dir, loop), () => finalizeReviewLocked(dir, run, loop, attempt, reason, author, options?.force ?? false, options?.exhaustedState, options?.allowAhead ?? false));
}

/** Finalize a non-reviewer loop member on its completed attempt after the reviewer already finalized an earlier attempt. */
export function finalizeMemberAfterDecision(dir: string, run: string, loop: ReviewLoop, instance: string, attempt: number, author: string): boolean {
	if (instance === loop.reviewer || !loop.members.includes(instance)) return false;
	return withSyncRunLock(loopLock(dir, loop), () => {
		if (readFinalizeRecord(dir, run, loop, instance)) return true;
		if (readLoopTransition(dir, run, instance, attempt)?.winner === "revision") return false;
		if (attemptClaimedOrStarted(dir, instance, attempt + 1)) return false;
		const attempt_id = `${instance}.${attempt}`;
		const resFile = resultPath(dir, attempt_id);
		const dispFile = dispositionPath(dir, attempt_id);
		if (!existsSync(resFile)) {
			if (!existsSync(dispFile)) return false;
			const disp = parseDisposition(readJson<unknown>(dispFile), { run_id: run, instance_id: instance, attempt_id });
			if (disp.state === "needs_attention") return false;
		}
		if (attempt > 1) publishTransition(dir, run, instance, attempt - 1, "revision");
		if (readLoopTransition(dir, run, instance, attempt)?.winner !== "revision") {
			publishTransition(dir, run, instance, attempt, "finalized");
		}
		const record: Finalization = {
			version: 1, run_id: run, instance_id: instance, attempt_id,
			finalized_by: author,
		};
		publishExclusive(finalizePath(dir, instance), JSON.stringify(record) + "\n");
		return true;
	});
}

/** Finish interrupted decision publication, or finalize completed attempts when cleanup ends an open loop. */
export function finishReviewFinalizations(dir: string, run: string, plan: ReviewPlan, topology?: Topology): void {
	const version = resolveReviewResultVersion(dir, topology);
	for (const loop of plan.loops) {
		withSyncRunLock(loopLock(dir, loop), () => {
			if (loop.members.every(instance => readFinalizeRecord(dir, run, loop, instance))) return;
			const decision = readFinalization(dir, run, loop, loop.reviewer);
			let targetAttempt = decision ? attemptNumber(decision.attempt_id) : undefined;
			if (targetAttempt === undefined) {
				for (let n = 1; n <= loop.max_revisions + 1; n++) {
					if (finishedAttempt(dir, loop.reviewer, n)) targetAttempt = n;
				}
				targetAttempt ??= 1;
			}
			const entries = readdirSync(dir);
			const ordered = [loop.reviewer, ...loop.members.filter(instance => instance !== loop.reviewer)];
			for (const instance of ordered) {
				if (readFinalizeRecord(dir, run, loop, instance)) continue;
				let attempt = targetAttempt;
				if (instance !== loop.reviewer) {
					let cancelledOrBlockedAttempt: number | undefined;
					for (let n = targetAttempt + 1; n <= loop.max_revisions + 1; n++) {
						if (existsSync(dispositionPath(dir, `${instance}.${n}`))) cancelledOrBlockedAttempt = n;
					}
					if (cancelledOrBlockedAttempt !== undefined) {
						attempt = cancelledOrBlockedAttempt;
					} else if (attemptStarted(dir, instance, targetAttempt + 1, entries) && !finishedAttempt(dir, instance, targetAttempt + 1)) {
						continue;
					}
				}
				const attempt_id = `${instance}.${attempt}`;
				const resPath = resultPath(dir, attempt_id);
				const dispPath = dispositionPath(dir, attempt_id);
				if (existsSync(resPath)) {
					parseCompletion(readJson<unknown>(resPath), { run_id: run, instance_id: instance, attempt_id, ...(version !== undefined ? { version } : {}) });
				} else if (existsSync(dispPath)) {
					parseDisposition(readJson<unknown>(dispPath), { run_id: run, instance_id: instance, attempt_id });
				} else {
					continue;
				}
				const record: Finalization = {
					version: 1, run_id: run, instance_id: instance, attempt_id,
					finalized_by: "dispatcher",
				};
				publishExclusive(finalizePath(dir, instance), JSON.stringify(record) + "\n");
				if (attempt > 1) publishTransition(dir, run, instance, attempt - 1, "revision");
				if (readLoopTransition(dir, run, instance, attempt)?.winner !== "revision") {
					publishTransition(dir, run, instance, attempt, "finalized");
				}
			}
		});
	}
}

type ReviewActor = Pick<WorkerConfig, "session_dir" | "task_id" | "review_plan" | "instance_id" | "node_id" | "attempt_id"> & {
	roster?: ReadonlyArray<Pick<AgentLaunch, "instance_id" | "node_id" | "persona_name">>;
};

type BlockedAdmission = Extract<AdmissionDecision, { outcome: "blocked" }>;

/** A definitive failure or disposition prevents the remaining members of this chain iteration from starting. */
export function settleReviewFailure(config: ReviewActor, execution: NodeExecution, firstBlock?: BlockedAdmission): void {
	const loop = reviewLoopFor(config.review_plan, config.instance_id);
	if (!loop) return;
	const { session_dir: dir, task_id: run } = config;
	const attempt = attemptNumber(config.attempt_id);
	withSyncRunLock(loopLock(dir, loop), () => {
		if (!readFinalization(dir, run, loop, loop.reviewer)) {
			if (revisionAhead(dir, run, loop, attempt)) return;
			const selfIdx = loop.members.indexOf(config.instance_id);
			const entries = readdirSync(dir);
			const upstreamBlock = firstBlock ?? decideAdmission({ policy: "require_success", predecessor: { node_id: config.node_id, execution } });
			for (const instance of loop.members.slice(0, selfIdx)) {
				if (finishedAttempt(dir, instance, attempt)) continue;
				const key = attemptKey(config.review_plan, instance, attempt);
				let working = false;
				const progressFile = join(dir, `${instance}.progress.json`);
				if (existsSync(progressFile)) {
					try {
						const progress = readJson<unknown>(progressFile);
						working = isRecord(progress) && progress.state === "working" && progress.attempt_id === key;
					} catch { /* ignore unreadable progress */ }
				}
				const startedAttempt = working ||
					(attempt > 1 && readLoopTransition(dir, run, instance, attempt - 1)?.winner === "revision") ||
					attemptStarted(dir, instance, attempt, entries);
				if (startedAttempt) continue;
				const member = config.roster?.find(item => item.instance_id === instance);
				if (!member) throw new Error(`Missing review loop member ${instance} from the roster`);
				if (!upstreamBlock.admit && upstreamBlock.outcome === "blocked") {
					const record = dispositionRecord({ ...member, attempt_id: key, task_id: run }, "blocked", upstreamBlock.reason, upstreamBlock.causes, new Date().toISOString());
					publishExclusive(dispositionPath(dir, key), JSON.stringify(record, null, 2) + "\n");
				}
			}
			let predecessor = { node_id: config.node_id, execution };
			for (const instance of loop.members.slice(selfIdx + 1)) {
				const member = config.roster?.find(item => item.instance_id === instance);
				if (!member) throw new Error(`Missing review loop member ${instance} from the roster`);
				const key = attemptKey(config.review_plan, instance, attempt);
				const blocked = firstBlock ?? decideAdmission({ policy: "require_success", predecessor });
				firstBlock = undefined;
				if (blocked.admit || blocked.outcome !== "blocked") return;
				if (!existsSync(resultPath(dir, key))) {
					const record = dispositionRecord({ ...member, attempt_id: key, task_id: run }, "blocked", blocked.reason, blocked.causes, new Date().toISOString());
					publishExclusive(dispositionPath(dir, key), JSON.stringify(record, null, 2) + "\n");
				}
				predecessor = { node_id: member.node_id, execution: { state: "blocked", reason: blocked.reason, causes: blocked.causes } };
			}
		}
		finalizeReviewLocked(dir, run, loop, attempt, undefined, loop.reviewer, true);
	});
}
