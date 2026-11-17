/**
 * Recovery of interrupted handoff delivery, from saved evidence alone (never by asking a model to reconstruct a result).
 *
 * `assessHandoff` reconciles every durable record about one chain edge (source result, handoff offer, acceptance, destination identity,
 * destination result or disposition) into a single verdict. Reading is free of side effects. The one repair the dispatcher may make without
 * a new decision is `retry_delivery`: re-offering the SAME logical handoff to a destination that demonstrably never claimed it. Everything
 * else that is uncertain (claimed but unfinished work, execution without a receipt, unreadable evidence) is `needs_attention`: it is
 * reported with its evidence and nothing is replayed or overwritten.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeHandoff, handoffClaimPath, handoffOfferPath, handoffRejectionsPath, inputDigest, isLegacyClaim, offerMismatch, parseHandoffClaim, parseHandoffOffer, parseHandoffRejections } from "./handoff.ts";
import {
	dispositionPath, errorMessage, expectationFor, parseCompletion, parseDisposition, parseWorkerConfig, processAlive, readJson, readyPath, resultPath,
	type AgentLaunch, type BootstrapManifest, type Disposition, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import { verificationPath } from "./verification.ts";

/**
 * Where one handoff stands. `retry_delivery`: demonstrably unclaimed, destination valid, so the dispatcher may repair delivery. `wait`: nothing is wrong
 * yet. `none`: nothing to recover. `needs_attention`: evidence is uncertain, missing or contradictory; a decision is needed and nothing is replayed.
 */
export type RecoveryVerdict = "retry_delivery" | "wait" | "none" | "needs_attention";
export type RecoveryStage =
	| "source_unfinished" | "source_not_executed" | "source_result_unusable"
	| "deliverable" | "awaiting_destination" | "accepted_running" | "completed"
	| "claimed_unfinished" | "execution_without_receipt" | "receipt_unreadable" | "destination_unavailable" | "destination_ended" | "rejected" | "incompatible_plan";

export interface RecoveryEnd { node_id: string; instance_id: string }
export interface HandoffAssessment {
	source: RecoveryEnd;
	destination: RecoveryEnd;
	handoff_id?: string;
	stage: RecoveryStage;
	verdict: RecoveryVerdict;
	reason: string;
	/** What the records show, in plain sentences. */
	evidence: string[];
	/** Records that are unreadable, unsupported or disagree with each other (preserved as found). */
	problems: string[];
	next_steps: string[];
}

type Read<T> = { state: "missing" } | { state: "ok"; value: T } | { state: "unreadable"; error: string };
function read<T>(path: string, parse: (raw: unknown) => T): Read<T> {
	if (!existsSync(path)) return { state: "missing" };
	try { return { state: "ok", value: parse(readJson<unknown>(path)) }; }
	catch (error) { return { state: "unreadable", error: errorMessage(error) }; }
}

const end = (entry: AgentLaunch): RecoveryEnd => ({ node_id: entry.node_id, instance_id: entry.instance_id });

/** The destination's own records, read once. */
interface DestinationRecords {
	result: Read<WorkerCompletion>;
	disposition: Read<Disposition>;
	claim: Read<ReturnType<typeof parseHandoffClaim>>;
	rejections: Read<ReturnType<typeof parseHandoffRejections>>;
	ready: Read<WorkerReady>;
	config: Read<WorkerConfig>;
	failure?: string;
	/** Anything that shows the destination started work, whether or not it left a receipt. */
	executed: string[];
}

function readDestination(manifest: BootstrapManifest, destination: AgentLaunch): DestinationRecords {
	const dir = manifest.session_dir;
	const instance = destination.instance_id;
	const result = read(resultPath(dir, instance), raw => parseCompletion(raw, expectationFor(manifest, destination)));
	const disposition = read(dispositionPath(dir, instance), raw => parseDisposition(raw, expectationFor(manifest, destination)));
	const claim = read(handoffClaimPath(dir, instance), parseHandoffClaim);
	const rejections = read(handoffRejectionsPath(dir, instance), parseHandoffRejections);
	const ready = read(readyPath(dir, instance), raw => raw as WorkerReady);
	const config = read(join(dir, `${instance}.config.json`), parseWorkerConfig);
	const failureFile = join(dir, `${instance}.error.json`);
	let failure: string | undefined;
	if (existsSync(failureFile)) { try { failure = String(readJson<{ error: unknown }>(failureFile).error); } catch (error) { failure = `unreadable error record (${errorMessage(error)})`; } }
	const executed: string[] = [];
	try {
		const progress = readJson<{ token?: string; state?: string }>(join(dir, `${instance}.progress.json`));
		if (progress.token === manifest.token && progress.state === "working") executed.push(`${destination.node_id}'s heartbeat reported it working (it had been admitted to run its task)`);
	} catch { /* no heartbeat on record */ }
	if (existsSync(verificationPath(dir, instance))) executed.push(`${destination.node_id} recorded verification checks`);
	return { result, disposition, claim, rejections, ready, config, ...(failure !== undefined ? { failure } : {}), executed };
}

/** Whether the destination is the live worker the run launched: same process, same Coms identity, and its tab was not closed. */
function destinationProblem(manifest: BootstrapManifest, destination: AgentLaunch, records: DestinationRecords): string | undefined {
	if (destination.status === "closed") return `${destination.node_id}'s tab was closed`;
	if (records.ready.state !== "ok") return `${destination.node_id} has no valid readiness record${records.ready.state === "unreadable" ? ` (${records.ready.error})` : ""}`;
	const ready = records.ready.value;
	if (ready.task_id !== manifest.task_id || ready.token !== manifest.token || ready.instance_id !== destination.instance_id) return `${destination.node_id}'s readiness record is not for this run and instance`;
	if (!processAlive(ready)) return `${destination.node_id}'s worker process (pid ${ready.pid}) is gone`;
	if (records.config.state !== "ok") return `${destination.node_id}'s configuration is unusable`;
	const registry = read(join(records.config.value.coms_dir, "projects", manifest.coms_project, "agents", `${destination.instance_id}.json`), raw => raw as { pid: number; session_id: string; name: string });
	if (registry.state !== "ok" || registry.value.pid !== ready.pid || registry.value.session_id !== ready.session_id || registry.value.name !== destination.instance_id) return `${destination.node_id}'s Coms identity is not the one it acknowledged readiness with`;
	return undefined;
}

/** Reconcile the durable records of the handoff from `source` into `destination`. Never writes and never throws for a bad record. */
export function assessHandoff(manifest: BootstrapManifest, source: AgentLaunch, destination: AgentLaunch): HandoffAssessment {
	const dir = manifest.session_dir;
	const evidence: string[] = [];
	const problems: string[] = [];
	const src = source.node_id;
	const dst = destination.node_id;
	const make = (stage: RecoveryStage, verdict: RecoveryVerdict, reason: string, nextSteps: string[], handoff_id?: string): HandoffAssessment =>
		({ source: end(source), destination: end(destination), ...(handoff_id ? { handoff_id } : {}), stage, verdict, reason, evidence, problems, next_steps: nextSteps });
	const status = `bootstrap_status with wait_ms`;

	// 1. What the source saved: nothing can be delivered without a trustworthy saved result.
	const sourceResult = read(resultPath(dir, source.instance_id), raw => parseCompletion(raw, expectationFor(manifest, source)));
	const sourceDisposition = read(dispositionPath(dir, source.instance_id), raw => parseDisposition(raw, expectationFor(manifest, source)));
	if (sourceResult.state === "unreadable") {
		problems.push(`source ${src}'s result is unusable: ${sourceResult.error}`);
		return make("source_result_unusable", "needs_attention", `the saved result of ${src} cannot be read, so there is nothing trustworthy to deliver`, [`Do not edit the result file. Inspect ${src}'s result and decide whether to relaunch with a new request_id; a result is never reconstructed for you.`]);
	}
	if (sourceResult.state === "missing") {
		if (sourceDisposition.state === "ok") return make("source_not_executed", "none", `${src} never executed (${sourceDisposition.value.state}), so no handoff exists to repair`, [`${dst} settles on its own from that record; see ${status}.`]);
		const sourceReady = read(readyPath(dir, source.instance_id), raw => raw as WorkerReady);
		return sourceReady.state === "ok" && processAlive(sourceReady.value)
			? make("source_unfinished", "wait", `${src} has not saved a result yet`, [`Wait with ${status}.`])
			: make("source_unfinished", "needs_attention", `${src} exited without saving a result, so there is nothing to deliver`, [`Inspect ${src}'s tab and its effects. This is not a delivery problem and recovery will not reconstruct a result.`]);
	}
	const completion = sourceResult.value;
	const digest = inputDigest(completion.result);
	evidence.push(`source ${src} saved a result (${completion.result.status}), delivery recorded as ${completion.delivery}`);

	// 2. The handoff's own records and the destination's.
	const offer = read(handoffOfferPath(dir, destination.instance_id), parseHandoffOffer);
	if (offer.state === "unreadable") problems.push(`handoff offer: ${offer.error}`);
	const handoffId = offer.state === "ok" ? offer.value.handoff_id : undefined;
	if (offer.state === "missing") evidence.push("no handoff offer was recorded");
	else if (offer.state === "ok") evidence.push(`handoff ${offer.value.handoff_id} was ${offer.value.state === "queued" ? "queued (Coms acknowledged the message)" : "offered but never acknowledged"}`);
	const records = readDestination(manifest, destination);
	if (records.rejections.state === "unreadable") problems.push(`handoff rejections: ${records.rejections.error}`);
	const view = (() => { try { return describeHandoff(dir, source.instance_id, destination.instance_id); } catch { return undefined; } })();
	for (const problem of view?.problems ?? []) if (!problems.includes(problem)) problems.push(problem);
	const claimed = records.claim.state === "ok" ? records.claim.value : undefined;
	const claimedId = claimed && !isLegacyClaim(claimed) ? claimed.handoff_id : undefined;
	const accepted = claimed ? `${dst} accepted ${claimedId ? `handoff ${claimedId}` : `the handoff (a receipt from the previous release, with no handoff ID)`}${claimed && !isLegacyClaim(claimed) ? ` at ${claimed.accepted_at}` : ""}` : undefined;
	if (accepted) evidence.push(accepted);
	if (records.claim.state === "unreadable") problems.push(`handoff acceptance receipt: ${records.claim.error}`);
	const id = claimedId ?? handoffId;
	const delivery = completion.delivery;
	const proof = (finished: boolean) => delivery !== "sent" && delivery !== "not_required" && claimed
		? [`source delivery recorded as ${delivery}, but ${dst} accepted${finished ? " and finished" : ""} anyway: the acceptance proves the handoff arrived`] : [];

	// 3. Whether the destination already has an execution record: that is authoritative, whatever else is missing.
	if (records.result.state === "ok") {
		evidence.push(`${dst} recorded a result (${records.result.value.result.status})`, ...proof(true));
		if (!claimed) problems.push(`no acceptance receipt for ${dst}; the result it recorded is the evidence that it ran`);
		return make("completed", "none", `${dst} already finished: its result stands and nothing is delivered again`, [`Nothing to recover. Continue with ${status}.`], id);
	}
	if (records.result.state === "unreadable") {
		problems.push(`${dst}'s result is unusable: ${records.result.error}`);
		return make("execution_without_receipt", "needs_attention", `${dst} has a result file that cannot be read; it may have run, so nothing is delivered or replayed`, [`Do not edit it. Inspect ${dst}'s result and effects, then decide whether a new run is intended.`], id);
	}
	if (records.claim.state === "unreadable") return make("receipt_unreadable", "needs_attention", `the acceptance receipt for ${dst} cannot be read, so it is unknown whether the handoff was accepted; nothing is delivered or replayed`, [`Do not edit the receipt. Inspect ${dst} and its effects before deciding on a new run.`], id);
	if (claimed) {
		if (records.disposition.state === "ok") evidence.push(`${dst} was recorded as ${records.disposition.value.state}: ${records.disposition.value.reason}`);
		const alive = records.ready.state === "ok" && processAlive(records.ready.value);
		evidence.push(`${dst}'s worker process is ${alive ? "alive" : "gone"}, with no result recorded`, ...proof(false));
		return alive && records.disposition.state !== "ok"
			? make("accepted_running", "wait", `${dst} accepted the handoff and is working on it; no delivery is outstanding`, [`Wait with ${status}.`], id)
			: make("claimed_unfinished", "needs_attention", `${dst} accepted ${claimedId ? `handoff ${claimedId}` : "the handoff"} and no result was recorded; its effects are unknown and the task is not replayed automatically`, [`Inspect ${dst}'s tab and its effects (what it already changed). The claim is never reset. Only an explicit decision (clean up, then a new run) re-executes it.`], id);
	}

	// 4. No acceptance and no result.
	if (records.disposition.state === "ok") {
		const recorded = records.disposition.value;
		evidence.push(`${dst} was recorded as ${recorded.state}: ${recorded.reason}`);
		return recorded.state === "needs_attention"
			? make("destination_ended", "needs_attention", `${dst} ended without accepting the handoff (${recorded.reason}); its worker is not waiting for one`, [`Inspect ${dst}, then bootstrap_cleanup and relaunch with a new request_id if the work should continue. Delivery cannot be repaired into a worker that has ended.`], id)
			: make("destination_ended", "none", `${dst} never executed (${recorded.state}), so there is no delivery to repair`, [`Nothing to recover. Continue with ${status}.`], id);
	}
	const rejected = records.rejections.state === "ok" ? records.rejections.value.filter(rejection => rejection.severity === "integrity") : [];
	if (rejected.length) {
		evidence.push(`${dst} refused the handoff: ${rejected.at(-1)!.reason}`);
		return make("rejected", "needs_attention", `${dst} refused the handoff itself (${rejected.at(-1)!.reason}); nothing ran for it and re-sending the same handoff would be refused again`, [`Inspect ${src}'s saved result, then bootstrap_cleanup and relaunch with a new request_id.`], id);
	}
	// Missing acceptance evidence alone does not mean the work did not run.
	if (records.executed.length) {
		evidence.push(...records.executed);
		return make("execution_without_receipt", "needs_attention", `there is no acceptance receipt for ${dst}, but other evidence shows it started work; it is not treated as unclaimed and is not replayed`, [`Inspect ${dst}'s tab and what it already changed. Nothing is delivered or re-executed without an explicit decision.`], id);
	}
	const unavailable = records.failure !== undefined ? `${dst} recorded a failure: ${records.failure}` : destinationProblem(manifest, destination, records);
	if (unavailable) {
		evidence.push(unavailable);
		return make("destination_unavailable", "needs_attention", `the handoff is unclaimed and nothing shows ${dst} ran, but it cannot receive it: ${unavailable}`, [`Inspect ${dst}. A destination that has gone cannot be woken: bootstrap_cleanup and relaunch with a new request_id.`], id);
	}
	if (offer.state === "unreadable") return make("incompatible_plan", "needs_attention", `the handoff offer for ${dst} is unreadable or unsupported, so it cannot be safely re-sent`, [`Do not edit it. Inspect ${src}'s result and decide whether to relaunch with a new request_id.`]);
	if (offer.state === "ok") {
		const mismatch = offerMismatch(offer.value, { run_id: manifest.task_id, source_instance_id: source.instance_id, source_attempt_id: completion.identity?.attempt_id, destination: { node_id: destination.node_id, instance_id: destination.instance_id, attempt_id: destination.attempt_id }, input_digest: digest });
		if (mismatch) {
			problems.push(mismatch.reason);
			return make("incompatible_plan", "needs_attention", `the recorded offer does not belong to this plan (${mismatch.reason}); it is not re-sent and not replaced`, [`Inspect the offer and ${src}'s result; a changed plan needs a new run (new request_id).`], handoffId);
		}
	}
	evidence.push(`${dst} has not accepted, finished or started anything, and its worker is the live process the run launched`);
	return make("deliverable", "retry_delivery", `${src} saved its result and ${dst} never claimed the handoff`, [`bootstrap_recover with action retry_delivery and agent ${dst} re-sends the same handoff (nothing is re-run, ${src}'s result is untouched), then bootstrap_status with wait_ms.`], id);
}

export interface RecoveryRequest { action: "inspect" | "retry_delivery"; /** The successor node (node ID or instance ID) whose inbound handoff to inspect or repair; inspect covers every chain edge without it. */ agent?: string }
export interface RecoveryReport { task_id: string; action: RecoveryRequest["action"]; assessments: HandoffAssessment[]; next_steps: string[] }

/** The chain edges a request is about: one destination's inbound handoff, or every edge. */
function edges(manifest: BootstrapManifest, destinations: AgentLaunch[]): Array<{ source: AgentLaunch; destination: AgentLaunch }> {
	return destinations.flatMap(destination => {
		const source = manifest.pane_manifest.find(entry => entry.instance_id === destination.predecessor);
		return source ? [{ source, destination }] : [];
	});
}

export function inspectRun(manifest: BootstrapManifest, destinations: AgentLaunch[]): RecoveryReport {
	const assessments = edges(manifest, destinations).map(({ source, destination }) => assessHandoff(manifest, source, destination));
	return { task_id: manifest.task_id, action: "inspect", assessments, next_steps: [...new Set(assessments.flatMap(assessment => assessment.next_steps))] };
}
