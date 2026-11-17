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
import {
	describeHandoff, handoffClaimPath, handoffId, handoffNotification, handoffOfferPath, handoffRecoveryPath, handoffRejectionsPath, inputDigest, isLegacyClaim, offerHandoff, offerMismatch, parseHandoffClaim, parseHandoffOffer, parseHandoffRecovery, parseHandoffRejections,
	type HandoffRecovery, type HandoffRetry,
} from "./handoff.ts";
import {
	atomicJson, dispositionPath, errorMessage, expectationFor, parseCompletion, parseDisposition, parseWorkerConfig, parseWorkerReady, processAlive, readJson, readyPath, resultPath,
	type AgentLaunch, type BootstrapManifest, type Disposition, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import { parseTaskInput, taskInputPath } from "./contracts.ts";
import { readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe } from "./cancellation.ts";
import { readFailFast } from "./ownership.ts";
import { verificationPath } from "./verification.ts";

/**
 * Where one handoff stands. `retry_delivery`: demonstrably unclaimed, destination valid, so the dispatcher may repair delivery. `wait`: nothing is wrong
 * yet. `none`: nothing to recover. `needs_attention`: evidence is uncertain, missing or contradictory; a decision is needed and nothing is replayed.
 */
export type RecoveryVerdict = "retry_delivery" | "wait" | "none" | "needs_attention";
export type RecoveryStage =
	| "source_unfinished" | "source_not_executed" | "source_result_unusable"
	| "deliverable" | "awaiting_destination" | "accepted_running" | "completed"
	| "retries_exhausted" | "claimed_unfinished" | "execution_without_receipt" | "receipt_unreadable" | "destination_unavailable" | "destination_ended" | "rejected" | "incompatible_plan";

/** How long a redelivery that Coms accepted is given before the destination is considered not to have acted on it. */
export const RETRY_WINDOW_MS = 30_000;
/** The most redelivery attempts (sent or failed) for one handoff: a destination that ignores this many is not going to claim it. */
export const MAX_RETRIES = 5;

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
	const ready = read(readyPath(dir, instance), parseWorkerReady);
	const config = read(join(dir, `${instance}.config.json`), parseWorkerConfig);
	const failureFile = join(dir, `${instance}.error.json`);
	let failure: string | undefined;
	if (existsSync(failureFile)) { try { failure = String(readJson<{ error: unknown }>(failureFile).error); } catch (error) { failure = `unreadable error record (${errorMessage(error)})`; } }
	const executed: string[] = [];
	try {
		const progress = readJson<{ token?: string; state?: string; activity_at?: number }>(join(dir, `${instance}.progress.json`));
		if (progress.token === manifest.token && (progress.state === "working" || progress.state === "completed" || Number.isFinite(progress.activity_at))) {
			const detail = progress.state === "working" ? "working" : progress.state === "completed" ? "completed" : "active";
			executed.push(`${destination.node_id}'s heartbeat reported it ${detail} (it had been admitted to run its task)`);
		}
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
export function assessHandoff(manifest: BootstrapManifest, source: AgentLaunch, destination: AgentLaunch, now = Date.now()): HandoffAssessment {
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
		if (sourceDisposition.state === "unreadable") {
			problems.push(`source ${src}'s disposition is unusable: ${sourceDisposition.error}`);
			return make("source_unfinished", "needs_attention", `${src}'s disposition record cannot be read (${sourceDisposition.error}), so it is unknown whether ${src} executed`, [`Do not edit the disposition file. Inspect ${src} before deciding on a new run.`]);
		}
		const sourceReady = read(readyPath(dir, source.instance_id), parseWorkerReady);
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
	const offeredId = offer.state === "ok" ? offer.value.handoff_id : undefined;
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
	const id = claimedId ?? offeredId;
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
		if (records.disposition.state === "unreadable") problems.push(`${dst}'s disposition is unusable: ${records.disposition.error}`);
		const alive = records.ready.state === "ok" && processAlive(records.ready.value);
		evidence.push(`${dst}'s worker process is ${alive ? "alive" : "gone"}, with no result recorded`, ...proof(false));
		return alive && records.disposition.state === "missing"
			? make("accepted_running", "wait", `${dst} accepted the handoff and is working on it; no delivery is outstanding`, [`Wait with ${status}.`], id)
			: make("claimed_unfinished", "needs_attention", `${dst} accepted ${claimedId ? `handoff ${claimedId}` : "the handoff"} and no result was recorded; its effects are unknown and the task is not replayed automatically`, [`Inspect ${dst}'s tab and its effects (what it already changed). The claim is never reset. Only an explicit decision (clean up, then a new run) re-executes it.`], id);
	}

	// 4. No acceptance and no result.
	if (records.disposition.state === "unreadable") {
		problems.push(`${dst}'s disposition is unusable: ${records.disposition.error}`);
		return make("destination_ended", "needs_attention", `${dst}'s disposition record cannot be read (${records.disposition.error}); nothing is delivered or replayed`, [`Do not edit it. Inspect ${dst} before deciding on a new run.`], id);
	}
	if (records.disposition.state === "ok") {
		const recorded = records.disposition.value;
		evidence.push(`${dst} was recorded as ${recorded.state}: ${recorded.reason}`);
		return recorded.state === "needs_attention"
			? make("destination_ended", "needs_attention", `${dst} ended without accepting the handoff (${recorded.reason}); its worker is not waiting for one`, [`Inspect ${dst}, then bootstrap_cleanup and relaunch with a new request_id if the work should continue. Delivery cannot be repaired into a worker that has ended.`], id)
			: make("destination_ended", "none", `${dst} never executed (${recorded.state}), so there is no delivery to repair`, [`Nothing to recover. Continue with ${status}.`], id);
	}
	const destExpected = { run_id: manifest.task_id, node_id: destination.node_id, persona_name: destination.persona_name, attempt_id: destination.attempt_id, instance_id: destination.instance_id };
	const destClaim = readOutcomeClaimSafe(dir, destExpected);
	if (destClaim.error) {
		problems.push(`${dst} outcome claim: ${destClaim.error}`);
		return make("destination_ended", "needs_attention", `${dst}'s outcome claim cannot be read (${destClaim.error}); nothing is delivered or replayed`, [`Do not edit it. Inspect ${dst} before deciding on a new run.`], id);
	}
	const destCancel = readCancelRecordSafe(dir, destExpected);
	if (destCancel.error) {
		problems.push(`${dst} cancellation record: ${destCancel.error}`);
		return make("destination_ended", "needs_attention", `${dst}'s cancellation record cannot be read (${destCancel.error}); nothing is delivered or replayed`, [`Do not edit it. Inspect ${dst} before deciding on a new run.`], id);
	}
	if (destCancel.record && destClaim.claim?.outcome !== "completed") {
		evidence.push(`${dst} cancellation requested: ${destCancel.record.reason}`);
		return make("destination_ended", "none", `${dst} was cancelled (${destCancel.record.reason}), so there is no delivery to repair`, [`Nothing to recover. Continue with ${status}.`], id);
	}
	const runCancel = readRunCancelRecordSafe(dir, manifest.task_id);
	if (runCancel.error) {
		problems.push(`run cancellation record: ${runCancel.error}`);
		return make("destination_ended", "needs_attention", `the run's cancellation record cannot be read (${runCancel.error}); nothing is delivered or replayed`, [`Do not edit it. Inspect the run before deciding on a new run.`], id);
	}
	if (runCancel.record && destClaim.claim?.outcome !== "completed") {
		evidence.push(`run cancellation requested: ${runCancel.record.reason}`);
		return make("destination_ended", "none", `the run was cancelled (${runCancel.record.reason}), so there is no delivery to repair`, [`Nothing to recover. Continue with ${status}.`], id);
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
	// The plan this handoff belongs to: the destination's immutable task input and the source's result must be for the attempts the run now records.
	const input = read(taskInputPath(dir, destination.instance_id), raw => parseTaskInput(raw, { run_id: manifest.task_id, instance_id: destination.instance_id }));
	if (input.state === "unreadable") {
		problems.push(`${dst}'s saved task input: ${input.error}`);
		return make("incompatible_plan", "needs_attention", `${dst}'s saved task input is unreadable (${input.error}); it is not re-sent`, [`Do not edit it. Inspect ${dst}'s task input and decide whether to relaunch with a new request_id.`], id);
	}
	if (input.state === "missing" && records.config.state === "ok" && records.config.value.handoff_protocol) {
		problems.push(`${dst}'s saved task input is missing`);
		return make("incompatible_plan", "needs_attention", `${dst}'s saved task input is missing, so the handoff cannot be safely prepared or re-sent`, [`Inspect ${dst} and decide whether to relaunch with a new request_id.`], id);
	}
	if (input.state === "ok") {
		const recorded = input.value.identity;
		const changed = recorded.node_id !== destination.node_id ? `${dst}'s saved task input is for node ${recorded.node_id}, but the plan now says ${destination.node_id}`
			: destination.attempt_id !== undefined && recorded.attempt_id !== destination.attempt_id ? `${dst}'s saved task input is for attempt ${recorded.attempt_id}, but the plan now says ${destination.attempt_id}` : undefined;
		if (changed) { problems.push(changed); return make("incompatible_plan", "needs_attention", `the plan changed since this handoff was prepared (${changed}); it is not re-sent`, [`A changed plan needs a new run (new request_id). Nothing was altered.`], offeredId); }
	}
	if (source.attempt_id !== undefined && completion.identity && completion.identity.attempt_id !== source.attempt_id) {
		const changed = `${src}'s saved result is for attempt ${completion.identity.attempt_id}, but the plan now says ${source.attempt_id}`;
		problems.push(changed);
		return make("incompatible_plan", "needs_attention", `the plan changed since this handoff was prepared (${changed}); it is not re-sent`, [`A changed plan needs a new run (new request_id). Nothing was altered.`], offeredId);
	}
	if (offer.state === "unreadable") return make("incompatible_plan", "needs_attention", `the handoff offer for ${dst} is unreadable or unsupported, so it cannot be safely re-sent`, [`Do not edit it. Inspect ${src}'s result and decide whether to relaunch with a new request_id.`]);
	if (offer.state === "ok") {
		const mismatch = offerMismatch(offer.value, { run_id: manifest.task_id, source_instance_id: source.instance_id, source_attempt_id: completion.identity?.attempt_id, destination: { node_id: destination.node_id, instance_id: destination.instance_id, attempt_id: destination.attempt_id }, input_digest: digest });
		if (mismatch) {
			problems.push(mismatch.reason);
			return make("incompatible_plan", "needs_attention", `the recorded offer does not belong to this plan (${mismatch.reason}); it is not re-sent and not replaced`, [`Inspect the offer and ${src}'s result; a changed plan needs a new run (new request_id).`], offeredId);
		}
	}
	// 5. Redeliveries the dispatcher already made: one that Coms accepted is given time to be acted on before another is sent.
	const sourceAttemptId = completion.identity?.attempt_id ?? source.attempt_id;
	const destAttemptId = input.state === "ok" ? input.value.identity.attempt_id : destination.attempt_id;
	const expectedHandoffId = sourceAttemptId && destAttemptId
		? handoffId({ run_id: manifest.task_id, source_attempt_id: sourceAttemptId, destination_node_id: destination.node_id, destination_attempt_id: destAttemptId, input_digest: digest })
		: undefined;
	const recovery = read(handoffRecoveryPath(dir, destination.instance_id), parseHandoffRecovery);
	if (recovery.state === "unreadable") {
		problems.push(`handoff recovery record: ${recovery.error}`);
		return make("incompatible_plan", "needs_attention", `the dispatcher's record of earlier redeliveries to ${dst} is unreadable, so the handoff is not re-sent blindly`, [`Do not edit it. Inspect ${dst} and decide whether to relaunch with a new request_id.`], id);
	}
	if (recovery.state === "ok") {
		const rec = recovery.value;
		const recMismatch = rec.run_id !== manifest.task_id ? `run ${rec.run_id}, expected ${manifest.task_id}`
			: rec.source !== source.instance_id ? `source ${rec.source}, expected ${source.instance_id}`
			: rec.destination !== destination.instance_id ? `destination ${rec.destination}, expected ${destination.instance_id}`
			: rec.input_digest !== digest ? `input digest ${rec.input_digest}, expected ${digest}`
			: expectedHandoffId !== undefined && rec.handoff_id !== expectedHandoffId ? `handoff ${rec.handoff_id}, expected ${expectedHandoffId}`
			: offeredId !== undefined && rec.handoff_id !== offeredId ? `handoff ${rec.handoff_id}, offer is ${offeredId}`
			: undefined;
		if (recMismatch) {
			problems.push(`handoff recovery record mismatch: ${recMismatch}`);
			return make("incompatible_plan", "needs_attention", `the dispatcher's record of earlier redeliveries to ${dst} is for another handoff (${recMismatch}); it is not re-sent`, [`Inspect the handoff recovery record and ${src}'s result; a changed plan needs a new run (new request_id).`], id);
		}
		const sent = rec.retries.filter(retry => retry.transport !== "failed");
		const last = sent.at(-1);
		const age = last ? now - Date.parse(last.acknowledged_at ?? last.at) : Infinity;
		evidence.push(`the dispatcher already re-sent this handoff ${sent.length} time${sent.length === 1 ? "" : "s"} (${rec.retries.length} attempt${rec.retries.length === 1 ? "" : "s"} in all)`);
		if (last && age < RETRY_WINDOW_MS) return make("awaiting_destination", "wait", `the handoff was already re-sent (attempt ${last.seq}, ${Math.max(0, Math.round(age / 1000))}s ago); waiting for ${dst} to claim it`, [`Wait with ${status}; ${dst} records its own acceptance. Retry after ${Math.ceil((RETRY_WINDOW_MS - age) / 1000)}s if it still has not claimed.`], id);
		if (rec.retries.length >= MAX_RETRIES) return make("retries_exhausted", "needs_attention", `the dispatcher tried ${rec.retries.length} times to re-send the handoff and ${dst} never claimed it; it is not responding`, [`Inspect ${dst}'s tab. If it cannot act, bootstrap_cleanup and relaunch with a new request_id.`], id);
	}
	if (records.config.state === "ok" && !records.config.value.handoff_protocol) {
		return make("destination_unavailable", "needs_attention", `${dst} was launched before durable handoffs: it cannot verify a redelivery from the dispatcher, so only its own predecessor can notify it`, [`Inspect ${src} and ${dst}. If ${src} cannot notify ${dst}, bootstrap_cleanup and relaunch with a new request_id.`], id);
	}
	evidence.push(`${dst} has not accepted, finished or started anything, and its worker is the live process the run launched`);
	return make("deliverable", "retry_delivery", `${src} saved its result and ${dst} never claimed the handoff`, [`bootstrap_recover with action retry_delivery and agent ${dst} re-sends the same handoff (nothing is re-run, ${src}'s result is untouched), then bootstrap_status with wait_ms.`], id);
}

export interface RecoveryRequest { action: "inspect" | "retry_delivery"; /** The successor node (node ID or instance ID) whose inbound handoff to inspect or repair. Inspect covers every chain edge without it; retry_delivery needs it. */ agent?: string }
/** What the caller supplies for acting: the Coms wake-up (the only thing that can reach a live worker) and the dispatcher's own Coms session. */
export interface RecoveryDeps {
	/** Send `prompt` to the Coms session `target`. Resolves once Coms accepted the message (transport only); rejects when it could not be sent. */
	wake?: (target: string, prompt: string, signal?: AbortSignal) => Promise<void>;
	/** The dispatcher's own Coms session ID, recorded as the sender the destination may accept for this handoff. */
	senderSession?: string;
	signal?: AbortSignal;
	/** Clock for the redelivery window; tests supply one. */
	now?: () => number;
}
/**
 * Why the run as a whole is no longer open to recovery, or undefined while it is. A run that was cleaned up, aborted or failed to launch must not have work
 * delivered into it: its tabs are (or are being) closed and a woken worker would start work nobody collects.
 */
export function runClosedReason(manifest: BootstrapManifest): string | undefined {
	if (manifest.status === "cleaned") return "the run was cleaned up (its tabs were closed)";
	const abortFile = join(manifest.session_dir, "abort.json");
	if (existsSync(abortFile)) {
		try {
			const abort = readJson<{ task_id?: string; token?: string; error?: string }>(abortFile);
			if (abort.task_id === manifest.task_id && abort.token === manifest.token) return `the run was cancelled or aborted (${abort.error ?? "no reason recorded"})`;
		} catch (error) {
			return `the run's abort marker cannot be read (${errorMessage(error)})`;
		}
	}
	const runCancel = readRunCancelRecordSafe(manifest.session_dir, manifest.task_id);
	if (runCancel.error) return `the run's cancellation record cannot be read (${runCancel.error})`;
	if (runCancel.record) return `the run was cancelled (${runCancel.record.reason})`;
	const failFast = readFailFast(manifest.session_dir, manifest.task_id, manifest.token);
	if (failFast) return `the run triggered fail-fast cancellation after ${failFast.cause.node_id} (${failFast.cause.state}): ${failFast.cause.reason}`;
	if (manifest.status === "error") return `the run is in error (${manifest.error ?? manifest.phase}) and its work may never have been released`;
	return undefined;
}

export interface RecoveryDelivery { handoff_id: string; attempt: number; transport: "acknowledged" | "failed"; error?: string; offer: "existing" | "recorded_by_dispatcher" }
export interface RecoveryReport {
	task_id: string;
	action: RecoveryRequest["action"];
	/** The state of each handoff after the action (or as it is, for inspect). */
	assessments: HandoffAssessment[];
	/** Set when the run as a whole is closed to recovery (cleaned up, cancelled, failed); inspection still reports what the records show. */
	closed?: string;
	/** Set when delivery was actually re-sent. */
	delivery?: RecoveryDelivery;
	/** Why a retry was not made, when one was asked for. */
	refused?: string;
	next_steps: string[];
}

/** The chain edges a request is about: one destination's inbound handoff, or every edge. */
export function chainEdges(manifest: BootstrapManifest, destinations: AgentLaunch[]): Array<{ source: AgentLaunch; destination: AgentLaunch }> {
	return destinations.flatMap(destination => {
		const source = manifest.pane_manifest.find(entry => entry.instance_id === destination.predecessor);
		return source ? [{ source, destination }] : [];
	});
}

const nextStepsOf = (assessments: HandoffAssessment[]) => [...new Set(assessments.flatMap(assessment => assessment.next_steps))];

export function inspectRun(manifest: BootstrapManifest, destinations: AgentLaunch[], now = Date.now()): RecoveryReport {
	const assessments = chainEdges(manifest, destinations).map(({ source, destination }) => assessHandoff(manifest, source, destination, now));
	const closed = runClosedReason(manifest);
	return { task_id: manifest.task_id, action: "inspect", assessments, ...(closed ? { closed } : {}), next_steps: nextStepsOf(assessments) };
}

/**
 * Re-send the same logical handoff to a destination that demonstrably never claimed it. The caller holds the run lock, so this cannot interleave with a
 * launch or cleanup. The original result is never rewritten; the offer is only ever created (when the source exited before recording it), never replaced;
 * the redelivery is recorded BEFORE the wake-up is sent, because that record is what lets the destination accept the dispatcher as a sender.
 */
export async function retryDelivery(manifest: BootstrapManifest, source: AgentLaunch, destination: AgentLaunch, deps: RecoveryDeps): Promise<RecoveryReport> {
	const dir = manifest.session_dir;
	const now = deps.now ?? Date.now;
	const closed = runClosedReason(manifest);
	const before = assessHandoff(manifest, source, destination, now());
	const refuse = (why: string): RecoveryReport => ({ task_id: manifest.task_id, action: "retry_delivery", assessments: [before], refused: why, next_steps: before.verdict === "retry_delivery" ? [] : before.next_steps });
	if (closed) return refuse(`${closed}; recovery is not attempted for a closed run. Nothing was sent`);
	if (before.verdict !== "retry_delivery") return refuse(`${before.reason}. Nothing was sent`);
	const destinationConfig = parseWorkerConfig(readJson<unknown>(join(dir, `${destination.instance_id}.config.json`)));
	if (!destinationConfig.handoff_protocol) return refuse(`${destination.node_id} was launched before durable handoffs: it cannot verify a redelivery from the dispatcher, so only its own predecessor can notify it. Nothing was sent`);
	if (!deps.senderSession) return refuse("the dispatcher has no Coms identity in this session, so the successor could not verify a message from it (load Coms in this session). Nothing was sent");
	if (!deps.wake) return refuse("no way to reach the successor from this session (Coms is not available). Nothing was sent");
	const sourceConfig = parseWorkerConfig(readJson<unknown>(join(dir, `${source.instance_id}.config.json`)));
	const resultFile = resultPath(dir, source.instance_id);
	const completion = parseCompletion(readJson<unknown>(resultFile), expectationFor(manifest, source));
	const existing = existsSync(handoffOfferPath(dir, destination.instance_id));
	const recoveryFile = handoffRecoveryPath(dir, destination.instance_id);
	const destInput = parseTaskInput(readJson<unknown>(taskInputPath(dir, destination.instance_id)), { run_id: manifest.task_id, instance_id: destination.instance_id });
	const expectedId = handoffId({
		run_id: manifest.task_id,
		source_attempt_id: sourceConfig.attempt_id!,
		destination_node_id: destInput.identity.node_id,
		destination_attempt_id: destInput.identity.attempt_id,
		input_digest: inputDigest(completion.result),
	});
	const existingRecovery = existsSync(recoveryFile) ? parseHandoffRecovery(readJson<unknown>(recoveryFile)) : undefined;
	if (existingRecovery && existingRecovery.handoff_id !== expectedId) {
		throw new Error(`Recovery was recorded for handoff ${existingRecovery.handoff_id}, but this handoff is ${expectedId}; it was left untouched`);
	}
	// The same logical handoff: derived from the run, the source attempt, the destination and the exact saved input. Creating it never overwrites one.
	const offer = offerHandoff(sourceConfig, completion, resultFile, undefined, "dispatcher");
	const record: HandoffRecovery = existingRecovery
		?? { version: 1, run_id: manifest.task_id, handoff_id: offer.handoff_id, input_digest: offer.input_digest, source: source.instance_id, destination: destination.instance_id, retries: [] };
	const retry: HandoffRetry = { seq: record.retries.length + 1, at: new Date(now()).toISOString(), sender_session: deps.senderSession, transport: "pending" };
	record.retries.push(retry);
	atomicJson(recoveryFile, record);
	const ready = parseWorkerReady(readJson<unknown>(readyPath(dir, destination.instance_id)));
	try {
		await deps.wake(ready.session_id, handoffNotification(sourceConfig, offer, resultFile, completion.result.status === "failure"), deps.signal);
		retry.transport = "acknowledged"; retry.acknowledged_at = new Date(now()).toISOString();
	} catch (error) {
		retry.transport = "failed"; retry.error = errorMessage(error);
	}
	atomicJson(recoveryFile, record);
	const after = assessHandoff(manifest, source, destination, now());
	const delivery: RecoveryDelivery = { handoff_id: offer.handoff_id, attempt: retry.seq, transport: retry.transport === "acknowledged" ? "acknowledged" : "failed", ...(retry.error ? { error: retry.error } : {}), offer: existing ? "existing" : "recorded_by_dispatcher" };
	return {
		task_id: manifest.task_id, action: "retry_delivery", assessments: [after], delivery,
		next_steps: delivery.transport === "acknowledged"
			? [`Delivery of handoff ${offer.handoff_id} was re-sent (Coms acknowledged it: that is not acceptance). Wait with bootstrap_status wait_ms and look for the handoff to show accepted on ${destination.node_id}.`]
			: [`Re-sending failed (${retry.error}). Nothing was claimed or run. Inspect again, and retry_delivery once the destination can be reached.`],
	};
}

/** A `wake` that sends through the dispatcher's own Coms tool; a refused or failed send is an error (nothing was delivered). */
export function wakeViaComs(executeTool: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>): NonNullable<RecoveryDeps["wake"]> {
	return async (target, prompt, signal) => {
		const response = await executeTool("coms_send", { target, prompt }, { signal });
		if (response.isError) throw new Error(response.content.map(part => part.type === "text" ? part.text ?? "" : "").join("\n").trim() || "coms_send failed");
	};
}
