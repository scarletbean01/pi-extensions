/**
 * Durable handoffs: delivery is not acceptance.
 *
 * A handoff transfers the source attempt's saved result to the destination node's attempt. Three durable records, each written by exactly one side,
 * keep the stages apart (Coms is only the wake-up path; these records decide whether work may execute):
 *
 * - `<destination>.handoff-offer.json`  (source) the immutable transfer: handoff ID bound to run, source attempt, destination node/attempt and the
 *   input digest, `offered` before the notification is sent and `queued` once Coms acknowledged transport. Queued is not accepted.
 * - `<destination>.handoff.json`         (destination) the acceptance: published exclusively (link(2)) by the destination before any model work.
 *   Whoever publishes it first owns the handoff; every later notification finds it and is a harmless replay.
 * - `<destination>.handoff-rejections.json` (destination) what the destination refused and why.
 * - `<destination>.handoff-recovery.json` (dispatcher) the dispatcher's own redeliveries of the same handoff when the source could not finish delivery
 *   (see recovery.ts). It authorizes the dispatcher's Coms session as a sender for that one handoff; the destination still checks the offer and claims.
 *
 * Whether the destination then runs or completes is the destination's execution record (result / disposition), never inferred from these.
 */
import { attemptKey, attemptNumber, claimRevisionTransition, revisionReserved, reviewLoopFor, type ReviewPlan } from "./review-loop.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, parseTaskInput, sha256Text, taskInputPath } from "./contracts.ts";
import { atomicJson, checkVersion, dispositionPath, errorMessage, inboundEdgesOf, isRecord, nonEmpty, parseCompletion, publishExclusive, readJson, resultPath, type AgentLaunch, type BootstrapManifest, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";

/** The durable handoff protocol version a worker configuration may declare. Absent: the original receipt-only behavior (and version 1 workers). */
export const HANDOFF_PROTOCOL = 1;
const READABLE_RECORD_VERSIONS = [1];

const edgePrefix = (destinationInstance: string, sourceInstance?: string) =>
	sourceInstance ? `${destinationInstance}.from-${sourceInstance}` : destinationInstance;

export const handoffOfferPath = (dir: string, destinationInstance: string, sourceInstance?: string) =>
	join(dir, `${edgePrefix(destinationInstance, sourceInstance)}.handoff-offer.json`);
/** The acceptance (claim). The same file the original release wrote as a bare receipt. */
export const handoffClaimPath = (dir: string, destinationInstance: string, sourceInstance?: string) =>
	join(dir, `${edgePrefix(destinationInstance, sourceInstance)}.handoff.json`);
export const handoffRejectionsPath = (dir: string, destinationInstance: string, sourceInstance?: string) =>
	join(dir, `${edgePrefix(destinationInstance, sourceInstance)}.handoff-rejections.json`);
export const handoffRecoveryPath = (dir: string, destinationInstance: string, sourceInstance?: string) =>
	join(dir, `${edgePrefix(destinationInstance, sourceInstance)}.handoff-recovery.json`);

export const handoffSourceScope = (config: Pick<WorkerConfig, "topology" | "predecessor" | "review_plan">, sourceInstance?: string): string | undefined =>
	config.topology === "graph" || config.review_plan ? (sourceInstance ?? config.predecessor) : undefined;

export interface HandoffEnd { node_id: string; attempt_id: string; instance_id: string }
export interface HandoffOffer {
	version: 1;
	handoff_id: string;
	run_id: string;
	state: "offered" | "queued";
	source: HandoffEnd & { persona_name: string };
	destination: HandoffEnd;
	/** sha256 of the canonical saved result: exactly the input the destination is being handed. */
	input_digest: string;
	result_path: string;
	offered_at: string;
	queued_at?: string;
	/** Absent: the source made the offer. `dispatcher`: the source exited after saving its result, so the dispatcher recorded the same offer from the saved evidence. */
	offered_by?: "dispatcher";
}
export interface HandoffClaim {
	version: 1;
	handoff_id: string;
	state: "accepted";
	run_id: string;
	source: HandoffEnd & { session_id: string };
	destination: HandoffEnd;
	input_digest: string;
	/** This release always backs a modern claim with a durable offer. */
	offer: "matched";
	accepted_at: string;
	/** Absent: the source's own notification. `dispatcher`: the dispatcher re-sent the same handoff (an authorized recovery). */
	delivered_by?: "dispatcher";
}
export interface JoinHandoffSource {
	node_id: string;
	attempt_id: string;
	instance_id: string;
	handoff_id: string;
	input_digest: string;
	session_id?: string;
	delivered_by?: "dispatcher";
}
/** Single exclusive acceptance record for a join node, listing all claimed inbound handoff IDs. */
export interface JoinHandoffClaim {
	version: 1;
	kind: "join";
	state: "accepted";
	run_id: string;
	destination: HandoffEnd;
	handoff_ids: string[];
	sources: JoinHandoffSource[];
	accepted_at: string;
}
/** The original release's receipt: it recorded that a handoff was consumed, but not which one. */
export interface LegacyHandoffClaim { task_id: string; token: string; predecessor: string; sender_session: string }

export type RejectionKind = "sender" | "run" | "offer" | "destination" | "attempt" | "input" | "conflict";
/** A `notification` rejection refuses one message (the offer may still be fine); an `integrity` rejection means the handoff itself cannot be accepted. */
export type RejectionSeverity = "notification" | "integrity";
export interface HandoffRejection { at: string; kind: RejectionKind; severity: RejectionSeverity; reason: string; handoff_id?: string }

/** The input a handoff transfers: the digest of the saved result, which is also what the upstream index records as its `result_hash`. */
export const inputDigest = (result: unknown): string => sha256Text(canonicalJson(result));

/** Bound to the run, the source attempt, the destination node (and attempt) and the exact input. */
export function handoffId(parts: { run_id: string; source_attempt_id: string; destination_node_id: string; destination_attempt_id: string; input_digest: string }): string {
	return `h-${createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32)}`;
}

function end(value: unknown, field: string): HandoffEnd {
	if (!isRecord(value)) throw new Error(`${field} is missing`);
	return { node_id: nonEmpty(value.node_id, `${field}.node_id`), attempt_id: nonEmpty(value.attempt_id, `${field}.attempt_id`), instance_id: nonEmpty(value.instance_id, `${field}.instance_id`) };
}

export interface HandoffIdentityExpectation {
	run_id?: string;
	source_instance_id?: string;
	destination?: { node_id?: string; instance_id?: string; attempt_id?: string };
}

function assertHandoffIdentity(what: string, record: { run_id: string; source: { instance_id: string }; destination: HandoffEnd }, expected?: HandoffIdentityExpectation): void {
	if (!expected) return;
	if (expected.run_id !== undefined && record.run_id !== expected.run_id) {
		throw new Error(`${what} identity mismatch (run_id ${JSON.stringify(record.run_id)}, expected ${JSON.stringify(expected.run_id)})`);
	}
	if (expected.source_instance_id !== undefined && record.source.instance_id !== expected.source_instance_id) {
		throw new Error(`${what} identity mismatch (source ${JSON.stringify(record.source.instance_id)}, expected ${JSON.stringify(expected.source_instance_id)})`);
	}
	if (expected.destination?.instance_id !== undefined && record.destination.instance_id !== expected.destination.instance_id) {
		throw new Error(`${what} identity mismatch (destination instance ${JSON.stringify(record.destination.instance_id)}, expected ${JSON.stringify(expected.destination.instance_id)})`);
	}
	if (expected.destination?.node_id !== undefined && record.destination.node_id !== expected.destination.node_id) {
		throw new Error(`${what} identity mismatch (destination node ${JSON.stringify(record.destination.node_id)}, expected ${JSON.stringify(expected.destination.node_id)})`);
	}
	if (expected.destination?.attempt_id !== undefined && record.destination.attempt_id !== expected.destination.attempt_id) {
		throw new Error(`${what} identity mismatch (destination attempt ${JSON.stringify(record.destination.attempt_id)}, expected ${JSON.stringify(expected.destination.attempt_id)})`);
	}
}

/** What an offer must be bound to for a given destination to act on it. */
export interface OfferExpectation { run_id: string; source_instance_id: string; source_attempt_id?: string; destination: { node_id: string; instance_id: string; attempt_id?: string }; input_digest: string }
/** The first way the offer is not for this run, source, destination, attempt and input; undefined when it is. Shared by the destination's admission and the dispatcher's recovery. */
export function offerMismatch(found: HandoffOffer, expected: OfferExpectation): { kind: RejectionKind; reason: string } | undefined {
	if (found.run_id !== expected.run_id) return { kind: "run", reason: `the offer was made for run ${found.run_id}, not ${expected.run_id}` };
	if (found.source.instance_id !== expected.source_instance_id) return { kind: "sender", reason: `the offer is from ${found.source.instance_id}, not ${expected.source_instance_id}` };
	const destination = expected.destination;
	if (found.destination.instance_id !== destination.instance_id || found.destination.node_id !== destination.node_id) return { kind: "destination", reason: `the offer is addressed to destination node ${found.destination.node_id} (${found.destination.instance_id}), not ${destination.node_id} (${destination.instance_id})` };
	if (destination.attempt_id !== undefined && found.destination.attempt_id !== destination.attempt_id) return { kind: "attempt", reason: `the offer is for destination attempt ${found.destination.attempt_id}, not ${destination.attempt_id}` };
	if (found.source.attempt_id !== expected.source_attempt_id) return { kind: "attempt", reason: `the offer is for source attempt ${found.source.attempt_id}, but the saved result is from attempt ${expected.source_attempt_id ?? "(none)"}` };
	if (found.input_digest !== expected.input_digest) return { kind: "input", reason: `the saved input changed after it was offered (offered digest ${found.input_digest}, saved result ${expected.input_digest})` };
	const expectedId = handoffId({ run_id: expected.run_id, source_attempt_id: found.source.attempt_id, destination_node_id: destination.node_id, destination_attempt_id: found.destination.attempt_id, input_digest: expected.input_digest });
	if (found.handoff_id !== expectedId) return { kind: "conflict", reason: `the offer's handoff ID ${found.handoff_id} is not the one bound to this run, attempts and input (${expectedId})` };
	return undefined;
}

/** Validate a persisted offer at the read boundary. */
export function parseHandoffOffer(raw: unknown, expected?: HandoffIdentityExpectation): HandoffOffer {
	if (!isRecord(raw)) throw new Error("malformed handoff offer");
	checkVersion(raw.version, "handoff offer", false, "", READABLE_RECORD_VERSIONS);
	if (raw.state !== "offered" && raw.state !== "queued") throw new Error("malformed handoff offer (state)");
	const source = end(raw.source, "source");
	const digest = nonEmpty(raw.input_digest, "input_digest");
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("malformed handoff offer (input_digest)");
	const parsed = { ...raw, source: { ...source, persona_name: nonEmpty((raw.source as Record<string, unknown>).persona_name, "source.persona_name") }, destination: end(raw.destination, "destination"), handoff_id: nonEmpty(raw.handoff_id, "handoff_id"), run_id: nonEmpty(raw.run_id, "run_id"), input_digest: digest, result_path: nonEmpty(raw.result_path, "result_path"), offered_at: nonEmpty(raw.offered_at, "offered_at") } as HandoffOffer;
	assertHandoffIdentity("handoff offer", parsed, expected);
	return parsed;
}

/** Validate a persisted acceptance. The original release's receipt (no version) is returned as is: it proves consumption, not which handoff. */
export function parseHandoffClaim(raw: unknown, expected?: HandoffIdentityExpectation): HandoffClaim | LegacyHandoffClaim {
	if (!isRecord(raw)) throw new Error("malformed handoff acceptance");
	if (raw.version === undefined) {
		if (typeof raw.task_id !== "string" || typeof raw.predecessor !== "string") throw new Error("malformed handoff acceptance");
		if (expected?.run_id !== undefined && raw.task_id !== expected.run_id) {
			throw new Error(`handoff acceptance identity mismatch (task_id ${JSON.stringify(raw.task_id)}, expected ${JSON.stringify(expected.run_id)})`);
		}
		if (expected?.source_instance_id !== undefined && raw.predecessor !== expected.source_instance_id) {
			throw new Error(`handoff acceptance identity mismatch (predecessor ${JSON.stringify(raw.predecessor)}, expected ${JSON.stringify(expected.source_instance_id)})`);
		}
		return raw as unknown as LegacyHandoffClaim;
	}
	checkVersion(raw.version, "handoff acceptance", false, "", READABLE_RECORD_VERSIONS);
	if (raw.state !== "accepted" || raw.offer !== "matched") throw new Error("malformed handoff acceptance (state)");
	const source = end(raw.source, "source");
	const digest = nonEmpty(raw.input_digest, "input_digest");
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("malformed handoff acceptance (input_digest)");
	const parsed = { ...raw, source: { ...source, session_id: nonEmpty((raw.source as Record<string, unknown>).session_id, "source.session_id") }, destination: end(raw.destination, "destination"), handoff_id: nonEmpty(raw.handoff_id, "handoff_id"), run_id: nonEmpty(raw.run_id, "run_id"), input_digest: digest, accepted_at: nonEmpty(raw.accepted_at, "accepted_at") } as HandoffClaim;
	assertHandoffIdentity("handoff acceptance", parsed, expected);
	return parsed;
}
export const isLegacyClaim = (claim: HandoffClaim | LegacyHandoffClaim): claim is LegacyHandoffClaim => !("version" in claim);

export function isJoinClaim(raw: unknown): raw is JoinHandoffClaim {
	return isRecord(raw) && raw.kind === "join";
}

export function parseJoinHandoffClaim(raw: unknown, expected?: HandoffIdentityExpectation): JoinHandoffClaim {
	if (!isRecord(raw) || raw.kind !== "join") throw new Error("malformed join handoff acceptance");
	checkVersion(raw.version, "join handoff acceptance", false, "", READABLE_RECORD_VERSIONS);
	if (raw.state !== "accepted") throw new Error("malformed join handoff acceptance (state)");
	const run_id = nonEmpty(raw.run_id, "run_id");
	const destination = end(raw.destination, "destination");
	const accepted_at = nonEmpty(raw.accepted_at, "accepted_at");
	if (!Array.isArray(raw.handoff_ids) || raw.handoff_ids.length < 2) throw new Error("malformed join handoff acceptance (handoff_ids)");
	const handoff_ids = raw.handoff_ids.map((id, i) => nonEmpty(id, `handoff_ids[${i}]`));
	if (!Array.isArray(raw.sources) || raw.sources.length !== handoff_ids.length) throw new Error("malformed join handoff acceptance (sources)");
	const sources: JoinHandoffSource[] = raw.sources.map((src, i) => {
		if (!isRecord(src)) throw new Error(`malformed join handoff acceptance (sources[${i}])`);
		const digest = nonEmpty(src.input_digest, `sources[${i}].input_digest`);
		if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`malformed join handoff acceptance (sources[${i}].input_digest)`);
		return {
			node_id: nonEmpty(src.node_id, `sources[${i}].node_id`),
			attempt_id: nonEmpty(src.attempt_id, `sources[${i}].attempt_id`),
			instance_id: nonEmpty(src.instance_id, `sources[${i}].instance_id`),
			handoff_id: nonEmpty(src.handoff_id, `sources[${i}].handoff_id`),
			input_digest: digest,
			...(typeof src.session_id === "string" && src.session_id ? { session_id: src.session_id } : {}),
			...(src.delivered_by === "dispatcher" ? { delivered_by: "dispatcher" as const } : {}),
		};
	});
	if (expected?.run_id !== undefined && run_id !== expected.run_id) {
		throw new Error(`join handoff acceptance identity mismatch (run_id ${JSON.stringify(run_id)}, expected ${JSON.stringify(expected.run_id)})`);
	}
	if (expected?.destination?.instance_id !== undefined && destination.instance_id !== expected.destination.instance_id) {
		throw new Error(`join handoff acceptance identity mismatch (destination instance ${JSON.stringify(destination.instance_id)}, expected ${JSON.stringify(expected.destination.instance_id)})`);
	}
	if (expected?.destination?.node_id !== undefined && destination.node_id !== expected.destination.node_id) {
		throw new Error(`join handoff acceptance identity mismatch (destination node ${JSON.stringify(destination.node_id)}, expected ${JSON.stringify(expected.destination.node_id)})`);
	}
	if (expected?.destination?.attempt_id !== undefined && destination.attempt_id !== expected.destination.attempt_id) {
		throw new Error(`join handoff acceptance identity mismatch (destination attempt ${JSON.stringify(destination.attempt_id)}, expected ${JSON.stringify(expected.destination.attempt_id)})`);
	}
	if (expected?.source_instance_id !== undefined && !sources.some(s => s.instance_id === expected.source_instance_id)) {
		throw new Error(`join handoff acceptance identity mismatch (source ${JSON.stringify(expected.source_instance_id)} not in sources)`);
	}
	return { version: 1, kind: "join", state: "accepted", run_id, destination, handoff_ids, sources, accepted_at };
}

export function parseHandoffRejections(raw: unknown): HandoffRejection[] {
	if (!isRecord(raw) || !Array.isArray(raw.rejections)) throw new Error("malformed handoff rejections");
	checkVersion(raw.version, "handoff rejections", false, "", READABLE_RECORD_VERSIONS);
	return raw.rejections.map(entry => {
		if (!isRecord(entry) || typeof entry.reason !== "string" || typeof entry.kind !== "string") throw new Error("malformed handoff rejections");
		return entry as unknown as HandoffRejection;
	});
}

/** One redelivery attempt by the dispatcher. `transport` is what Coms said, never acceptance. */
export interface HandoffRetry { seq: number; at: string; sender_session: string; transport: "pending" | "acknowledged" | "failed"; acknowledged_at?: string; error?: string }
/** The dispatcher's redeliveries of one logical handoff. Written only by the dispatcher, under the run lock. */
export interface HandoffRecovery {
	version: 1;
	run_id: string;
	handoff_id: string;
	input_digest: string;
	source: string;
	destination: string;
	retries: HandoffRetry[];
}
export function parseHandoffRecovery(raw: unknown): HandoffRecovery {
	if (!isRecord(raw)) throw new Error("malformed handoff recovery record");
	checkVersion(raw.version, "handoff recovery record", false, "", READABLE_RECORD_VERSIONS);
	if (!Array.isArray(raw.retries)) throw new Error("malformed handoff recovery record (retries)");
	const retries = raw.retries.map(entry => {
		if (!isRecord(entry) || !Number.isInteger(entry.seq) || typeof entry.at !== "string" || typeof entry.sender_session !== "string" || !["pending", "acknowledged", "failed"].includes(entry.transport as string)) throw new Error("malformed handoff recovery record (retry)");
		return entry as unknown as HandoffRetry;
	});
	return { ...raw, handoff_id: nonEmpty(raw.handoff_id, "handoff_id"), run_id: nonEmpty(raw.run_id, "run_id"), input_digest: nonEmpty(raw.input_digest, "input_digest"), source: nonEmpty(raw.source, "source"), destination: nonEmpty(raw.destination, "destination"), retries } as HandoffRecovery;
}
/** Whether the dispatcher recorded a redelivery of exactly this handoff from exactly this Coms session. Unreadable evidence authorizes nothing. */
function recoverySends(config: WorkerConfig, senderSession: string | undefined, handoffId: string | undefined, sourceInstance = config.predecessor): boolean {
	if (!senderSession || !handoffId || !sourceInstance) return false;
	const path = handoffRecoveryPath(config.session_dir, attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id)), handoffSourceScope(config, sourceInstance));
	try {
		if (!existsSync(path)) return false;
		const record = parseHandoffRecovery(readJson<unknown>(path));
		return record.run_id === config.task_id && record.destination === config.instance_id && record.source === sourceInstance && record.handoff_id === handoffId
			&& record.retries.some(retry => retry.sender_session === senderSession);
	} catch { return false; }
}

// ---- source side ----

/**
 * Offer the saved result to the destination. Idempotent: a retry of the same logical handoff (same run, source attempt, destination and input)
 * finds the existing offer; an offer that disagrees with what is being offered now is refused, never overwritten.
 */
export function offerHandoff(
	config: WorkerConfig,
	completion: WorkerCompletion,
	resultFile: string,
	now = new Date().toISOString(),
	offeredBy?: "dispatcher",
	destinationInstance = config.successor!,
	sourceScope = config.topology === "graph" || config.review_plan ? config.instance_id : undefined,
	destinationAttempt = 1,
): HandoffOffer {
	const input = parseTaskInput(readJson<unknown>(taskInputPath(config.session_dir, attemptKey(config.review_plan, destinationInstance))), { run_id: config.task_id, instance_id: destinationInstance });
	const destination: HandoffEnd = { node_id: input.identity.node_id, attempt_id: config.review_plan ? `${destinationInstance}.${destinationAttempt}` : input.identity.attempt_id, instance_id: destinationInstance };
	const digest = inputDigest(completion.result);
	const offer: HandoffOffer = {
		version: 1,
		handoff_id: handoffId({ run_id: config.task_id, source_attempt_id: config.attempt_id!, destination_node_id: destination.node_id, destination_attempt_id: destination.attempt_id, input_digest: digest }),
		run_id: config.task_id, state: "offered",
		source: { node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id!, instance_id: config.instance_id },
		destination, input_digest: digest, result_path: resultFile, offered_at: now,
		...(offeredBy ? { offered_by: offeredBy } : {}),
	};
	const path = handoffOfferPath(config.session_dir, attemptKey(config.review_plan, destinationInstance, destinationAttempt), sourceScope);
	if (publishExclusive(path, JSON.stringify(offer, null, 2) + "\n")) return offer;
	const existing = parseHandoffOffer(readJson<unknown>(path));
	if (existing.handoff_id !== offer.handoff_id) throw new Error(`A different handoff (${existing.handoff_id}) was already offered to ${destinationInstance}; refusing to replace it with ${offer.handoff_id}`);
	return existing;
}

/** Coms acknowledged the notification. Transport only: this is not acceptance. Written by the source alone, and never moves a queued offer back. */
export function markHandoffQueued(
	config: WorkerConfig,
	offer: HandoffOffer,
	now = new Date().toISOString(),
	sourceScope = config.topology === "graph" || config.review_plan ? offer.source.instance_id : undefined,
): HandoffOffer {
	if (offer.state === "queued") return offer;
	const queued: HandoffOffer = { ...offer, state: "queued", queued_at: now };
	atomicJson(handoffOfferPath(config.session_dir, attemptKey(config.review_plan, offer.destination.instance_id, attemptNumber(offer.destination.attempt_id)), sourceScope), queued);
	return queued;
}

/** The wake-up message: the original marker first (what receivers key on), then the handoff it is about. The destination still verifies it against the durable offer. */
export function handoffNotification(config: WorkerConfig, offer: HandoffOffer | undefined, resultFile: string, failed: boolean): string {
	return `bootstrap-handoff:${config.token}:${config.instance_id}\n` +
		(offer ? `handoff-id: ${offer.handoff_id}\ninput-digest: ${offer.input_digest}\n` : "") +
		`Run: ${config.task_id}. Predecessor result reference: ${resultFile}\n` +
		(failed ? "The chain is aborted." : "Perform your assigned task using the durable predecessor input, then call bootstrap_complete.");
}

/** An accepted offer proves delivery even if the source never received the transport acknowledgement. */
export function reviewDeliveryClaimed(dir: string, completion: WorkerCompletion, routes: Array<{ instance: string; attempt: number }>): boolean {
	const source = completion.identity;
	if (!source || !routes.length) return false;
	return routes.every(({ instance, attempt }) => {
		const destinationKey = attemptKey(completion.review_plan, instance, attempt);
		const file = handoffClaimPath(dir, destinationKey, source.instance_id);
		try {
			const claim = parseHandoffClaim(readJson<unknown>(file), {
				run_id: source.run_id, source_instance_id: source.instance_id,
				destination: { instance_id: instance, attempt_id: destinationKey },
			});
			return !isLegacyClaim(claim) && claim.source.attempt_id === source.attempt_id &&
				claim.input_digest === inputDigest(completion.result);
		} catch { return false; }
	});
}

// ---- destination side ----

/** The fields a handoff notification may carry. Everything in it is a claim to be checked against the durable offer, never an authority. */
export function parseNotification(content: string): { handoff_id?: string; input_digest?: string } {
	return { handoff_id: /^handoff-id: (\S+)$/m.exec(content)?.[1], input_digest: /^input-digest: (\S+)$/m.exec(content)?.[1] };
}

export type HandoffDecision =
	/** Nothing refuses this handoff and nobody has claimed it yet. `offer` is absent for a configuration without the durable protocol. */
	| { outcome: "proceed"; offer?: HandoffOffer; input_digest: string; predecessor: WorkerCompletion; delivered_by?: "dispatcher" }
	/** The handoff was already accepted (by this worker, a concurrent one, or an earlier incarnation): the replay changes nothing. */
	| { outcome: "duplicate"; claim: HandoffClaim | LegacyHandoffClaim }
	| { outcome: "reject"; rejection: HandoffRejection };

const reject = (kind: RejectionKind, severity: RejectionSeverity, reason: string, handoff_id?: string): HandoffDecision =>
	({ outcome: "reject", rejection: { at: new Date().toISOString(), kind, severity, reason, ...(handoff_id ? { handoff_id } : {}) } });

function readClaim(config: WorkerConfig, expected: HandoffIdentityExpectation): HandoffClaim | LegacyHandoffClaim | undefined {
	const path = handoffClaimPath(config.session_dir, attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id)), handoffSourceScope(config));
	return existsSync(path) ? parseHandoffClaim(readJson<unknown>(path), expected) : undefined;
}

/**
 * Decide, from durable records, whether this destination may accept the notified handoff. Checks, in order: who sent it, whether it was already
 * accepted (a harmless replay), and, for a worker speaking the durable protocol, that the offer is for this run, this source and this destination
 * (node and attempt) and that the saved input still has the offered digest. `loadPredecessor` is called only for a notification that passed the
 * sender check. Nothing is written: claiming is a separate step.
 */
export function evaluateHandoff(input: { config: WorkerConfig; expectedSession: string; senderSession?: string; content: string; loadPredecessor: () => WorkerCompletion }): HandoffDecision {
	const { config, expectedSession, senderSession, content } = input;
	if (!content.includes(`bootstrap-handoff:${config.token}:${config.predecessor}`)) return reject("run", "notification", `the notification is not for this run's handoff from ${config.predecessor} (token mismatch)`);
	const notified = parseNotification(content);
	// The predecessor's own session notifies, or the dispatcher does, for the one handoff it recorded redelivering (recovery.ts).
	const viaDispatcher = senderSession !== expectedSession && recoverySends(config, senderSession, notified.handoff_id);
	if (senderSession !== expectedSession && !viaDispatcher) return reject("sender", "notification", `the sender is not the recorded session of ${config.predecessor}`);
	const offerFile = handoffOfferPath(config.session_dir, attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id)), handoffSourceScope(config));
	let offer: HandoffOffer | undefined;
	let offerProblem: HandoffDecision | undefined;
	if (config.handoff_protocol) {
		try { offer = existsSync(offerFile) ? parseHandoffOffer(readJson<unknown>(offerFile)) : undefined; }
		catch (error) { offerProblem = reject("offer", "integrity", `the handoff offer is unusable: ${errorMessage(error)}`); }
		if (!offer && !offerProblem) offerProblem = reject("offer", "notification", `there is no handoff offer for ${config.instance_id}; the notification alone cannot authorize work`);
	}
	let claim: HandoffClaim | LegacyHandoffClaim | undefined;
	try {
		claim = readClaim(config, {
			run_id: config.task_id,
			source_instance_id: config.predecessor,
			destination: { instance_id: config.instance_id, node_id: config.node_id, attempt_id: config.attempt_id },
		});
	}
	catch (error) { return reject("conflict", "integrity", `the recorded acceptance is unusable: ${errorMessage(error)}; it was not reset`); }
	if (claim) {
		const accepted = isLegacyClaim(claim) ? undefined : claim.handoff_id;
		const named = notified.handoff_id ?? offer?.handoff_id;
		if (accepted && named && named !== accepted) return reject("conflict", "notification", `handoff ${named} cannot be accepted: handoff ${accepted} was already accepted for ${config.instance_id}`, named);
		return { outcome: "duplicate", claim };
	}
	if (config.handoff_protocol && offerProblem) return offerProblem;
	const predecessor = input.loadPredecessor();
	const digest = inputDigest(predecessor.result);
	if (!config.handoff_protocol) return { outcome: "proceed", input_digest: digest, predecessor, ...(viaDispatcher ? { delivered_by: "dispatcher" as const } : {}) };
	const found = offer!;
	const mismatch = offerMismatch(found, { run_id: config.task_id, source_instance_id: config.predecessor!, source_attempt_id: predecessor.identity?.attempt_id, destination: { node_id: config.node_id, instance_id: config.instance_id, attempt_id: config.attempt_id! }, input_digest: digest });
	if (mismatch) return reject(mismatch.kind, "integrity", mismatch.reason, found.handoff_id);
	if (notified.handoff_id !== undefined && notified.handoff_id !== found.handoff_id) return reject("conflict", "notification", `the notification names handoff ${notified.handoff_id}, but the offer is ${found.handoff_id}`, notified.handoff_id);
	if (notified.input_digest !== undefined && notified.input_digest !== found.input_digest) return reject("input", "notification", `the notification carries input digest ${notified.input_digest}, but the offer is for ${found.input_digest}`, found.handoff_id);
	return { outcome: "proceed", offer: found, input_digest: digest, predecessor, ...(viaDispatcher ? { delivered_by: "dispatcher" as const } : {}) };
}

/**
 * Claim the handoff: publish the acceptance exclusively (link(2)), so of any number of racing notifications, in this process or others, exactly one
 * wins and the rest get that winner's evidence back. Call it after every check that could refuse the work and before any model work or side effect.
 */
export function claimHandoff(config: WorkerConfig, proceed: Extract<HandoffDecision, { outcome: "proceed" }>, senderSession: string, now = new Date().toISOString()): { outcome: "accepted"; claim: HandoffClaim | LegacyHandoffClaim } | { outcome: "duplicate"; claim: HandoffClaim | LegacyHandoffClaim } | { outcome: "rejected"; reason: string; claim?: undefined } {
	const attempt = attemptNumber(config.attempt_id);
	const loop = reviewLoopFor(config.review_plan, config.instance_id);
	if (loop && attempt > 1) {
		const transition = claimRevisionTransition(config.session_dir, config.task_id, loop, config.instance_id, attempt - 1, attempt);
		if (transition.outcome === "rejected") return transition;
	}
	const path = handoffClaimPath(config.session_dir, attemptKey(config.review_plan, config.instance_id, attempt), handoffSourceScope(config));
	const claim: HandoffClaim | LegacyHandoffClaim = config.handoff_protocol
		? {
			version: 1, handoff_id: proceed.offer!.handoff_id, state: "accepted", run_id: config.task_id,
			source: { node_id: proceed.offer!.source.node_id, attempt_id: proceed.offer!.source.attempt_id, instance_id: proceed.offer!.source.instance_id, session_id: senderSession }, destination: proceed.offer!.destination,
			input_digest: proceed.input_digest, offer: "matched", accepted_at: now,
			...(proceed.delivered_by ? { delivered_by: proceed.delivered_by } : {}),
		}
		: { task_id: config.task_id, token: config.token, predecessor: config.predecessor!, sender_session: senderSession };
	if (publishExclusive(path, JSON.stringify(claim, null, 2) + "\n")) return { outcome: "accepted", claim };
	return { outcome: "duplicate", claim: parseHandoffClaim(readJson<unknown>(path)) };
}

export interface JoinEdgeReady {
	sourceInstanceId: string;
	offer?: HandoffOffer;
	input_digest: string;
	predecessor: WorkerCompletion;
	session_id?: string;
	delivered_by?: "dispatcher";
}

export type JoinHandoffDecision =
	| { outcome: "proceed"; edges: JoinEdgeReady[] }
	| { outcome: "wait"; pendingSources: string[] }
	| { outcome: "duplicate"; claim: JoinHandoffClaim }
	| { outcome: "reject"; sourceInstanceId: string; rejection: HandoffRejection };

/**
 * Validate an inbound notification for a join node against the named source, and check whether all inbound edges
 * have valid offers and saved results ready to be claimed together.
 */
export function evaluateJoinHandoff(input: {
	config: WorkerConfig;
	inboundInstances: string[];
	sourceInstanceId: string;
	expectedSession: string;
	senderSession?: string;
	content: string;
	loadPredecessor: (sourceInstanceId: string) => WorkerCompletion | undefined;
	sessionOf: (sourceInstanceId: string) => string | undefined;
}): JoinHandoffDecision {
	const { config, inboundInstances, sourceInstanceId, expectedSession, senderSession, content } = input;
	if (!content.includes(`bootstrap-handoff:${config.token}:${sourceInstanceId}`)) {
		return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "run", severity: "notification", reason: `the notification is not for this run's handoff from ${sourceInstanceId} (token mismatch)` } };
	}
	const notified = parseNotification(content);
	const viaDispatcher = senderSession !== expectedSession && recoverySends(config, senderSession, notified.handoff_id, sourceInstanceId);
	if (senderSession !== expectedSession && !viaDispatcher) {
		return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "sender", severity: "notification", reason: `the sender is not the recorded session of ${sourceInstanceId}` } };
	}
	const joinClaimFile = handoffClaimPath(config.session_dir, config.instance_id);
	if (existsSync(joinClaimFile)) {
		try {
			const claim = parseJoinHandoffClaim(readJson<unknown>(joinClaimFile), {
				run_id: config.task_id,
				destination: { instance_id: config.instance_id, node_id: config.node_id, attempt_id: config.attempt_id },
			});
			return { outcome: "duplicate", claim };
		} catch (error) {
			return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "conflict", severity: "integrity", reason: `the recorded acceptance is unusable: ${errorMessage(error)}; it was not reset` } };
		}
	}
	const notifyOfferFile = handoffOfferPath(config.session_dir, config.instance_id, sourceInstanceId);
	if (config.handoff_protocol) {
		let notifyOffer: HandoffOffer | undefined;
		try { notifyOffer = existsSync(notifyOfferFile) ? parseHandoffOffer(readJson<unknown>(notifyOfferFile)) : undefined; }
		catch (error) {
			return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "offer", severity: "integrity", reason: `the handoff offer is unusable: ${errorMessage(error)}` } };
		}
		if (!notifyOffer) {
			return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "offer", severity: "notification", reason: `there is no handoff offer for ${config.instance_id} from ${sourceInstanceId}; the notification alone cannot authorize work` } };
		}
		if (notified.handoff_id !== undefined && notified.handoff_id !== notifyOffer.handoff_id) {
			return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "conflict", severity: "notification", reason: `the notification names handoff ${notified.handoff_id}, but the offer is ${notifyOffer.handoff_id}`, handoff_id: notified.handoff_id } };
		}
		if (notified.input_digest !== undefined && notified.input_digest !== notifyOffer.input_digest) {
			return { outcome: "reject", sourceInstanceId, rejection: { at: new Date().toISOString(), kind: "input", severity: "notification", reason: `the notification carries input digest ${notified.input_digest}, but the offer is for ${notifyOffer.input_digest}`, handoff_id: notifyOffer.handoff_id } };
		}
	}

	const edges: JoinEdgeReady[] = [];
	const pendingSources: string[] = [];
	for (const src of inboundInstances) {
		const predecessor = input.loadPredecessor(src);
		if (!predecessor) { pendingSources.push(src); continue; }
		const digest = inputDigest(predecessor.result);
		if (!config.handoff_protocol) {
			edges.push({ sourceInstanceId: src, input_digest: digest, predecessor, session_id: input.sessionOf(src), ...(src === sourceInstanceId && viaDispatcher ? { delivered_by: "dispatcher" as const } : {}) });
			continue;
		}
		const offerFile = handoffOfferPath(config.session_dir, config.instance_id, src);
		let offer: HandoffOffer | undefined;
		try { offer = existsSync(offerFile) ? parseHandoffOffer(readJson<unknown>(offerFile)) : undefined; }
		catch (error) {
			return { outcome: "reject", sourceInstanceId: src, rejection: { at: new Date().toISOString(), kind: "offer", severity: "integrity", reason: `the handoff offer from ${src} is unusable: ${errorMessage(error)}` } };
		}
		if (!offer) { pendingSources.push(src); continue; }
		const mismatch = offerMismatch(offer, {
			run_id: config.task_id,
			source_instance_id: src,
			source_attempt_id: predecessor.identity?.attempt_id,
			destination: { node_id: config.node_id, instance_id: config.instance_id, attempt_id: config.attempt_id! },
			input_digest: digest,
		});
		if (mismatch) {
			return { outcome: "reject", sourceInstanceId: src, rejection: { at: new Date().toISOString(), kind: mismatch.kind, severity: "integrity", reason: mismatch.reason, handoff_id: offer.handoff_id } };
		}
		edges.push({
			sourceInstanceId: src,
			offer,
			input_digest: digest,
			predecessor,
			session_id: input.sessionOf(src),
			...(src === sourceInstanceId && viaDispatcher ? { delivered_by: "dispatcher" as const } : {}),
		});
	}
	if (pendingSources.length > 0) return { outcome: "wait", pendingSources };
	return { outcome: "proceed", edges };
}

/** Atomically publish the single exclusive join claim listing all claimed inbound handoff IDs. */
export function claimJoinHandoff(config: WorkerConfig, edges: JoinEdgeReady[], now = new Date().toISOString()): { outcome: "accepted"; claim: JoinHandoffClaim } | { outcome: "duplicate"; claim: JoinHandoffClaim } {
	const path = handoffClaimPath(config.session_dir, config.instance_id);
	const sources: JoinHandoffSource[] = edges.map(edge => ({
		node_id: edge.offer?.source.node_id ?? edge.predecessor.identity?.node_id ?? edge.sourceInstanceId,
		attempt_id: edge.offer?.source.attempt_id ?? edge.predecessor.identity?.attempt_id ?? edge.sourceInstanceId,
		instance_id: edge.sourceInstanceId,
		handoff_id: edge.offer?.handoff_id ?? handoffId({
			run_id: config.task_id,
			source_attempt_id: edge.predecessor.identity?.attempt_id ?? edge.sourceInstanceId,
			destination_node_id: config.node_id,
			destination_attempt_id: config.attempt_id ?? config.instance_id,
			input_digest: edge.input_digest,
		}),
		input_digest: edge.input_digest,
		...(edge.session_id ? { session_id: edge.session_id } : {}),
		...(edge.delivered_by ? { delivered_by: edge.delivered_by } : {}),
	}));
	const destination: HandoffEnd = edges[0]?.offer?.destination ?? {
		node_id: config.node_id,
		attempt_id: config.attempt_id ?? config.instance_id,
		instance_id: config.instance_id,
	};
	const claim: JoinHandoffClaim = {
		version: 1,
		kind: "join",
		state: "accepted",
		run_id: config.task_id,
		destination,
		handoff_ids: sources.map(s => s.handoff_id),
		sources,
		accepted_at: now,
	};
	if (publishExclusive(path, JSON.stringify(claim, null, 2) + "\n")) return { outcome: "accepted", claim };
	return { outcome: "duplicate", claim: parseJoinHandoffClaim(readJson<unknown>(path)) };
}

const MAX_RECORDED_REJECTIONS = 10;
/** Record a rejection on the edge-scoped rejections file. */
export function recordHandoffRejection(config: WorkerConfig, rejection: HandoffRejection, sourceInstance?: string): void {
	const path = handoffRejectionsPath(config.session_dir, attemptKey(config.review_plan, config.instance_id, attemptNumber(config.attempt_id)), handoffSourceScope(config, sourceInstance));
	let earlier: HandoffRejection[] = [];
	if (existsSync(path)) {
		try { earlier = parseHandoffRejections(readJson<unknown>(path)); }
		catch (error) {
			if (errorMessage(error).includes("Unsupported ")) throw error;
		}
	}
	atomicJson(path, { version: 1, rejections: [...earlier, rejection].slice(-MAX_RECORDED_REJECTIONS) });
}

/** A reservation permits the next iteration. A claim or a terminal admission record advances the destination. */
export function latestReviewAttempt(input: {
	dir: string;
	runId: string;
	plan: ReviewPlan;
	instance: string;
	node: string;
	predecessor?: string;
}): { number: number; source?: string; sourceAttempt?: number } {
	const { dir, runId, plan, instance, node, predecessor } = input;
	const loop = reviewLoopFor(plan, instance);
	let current = { number: 1, source: predecessor, sourceAttempt: predecessor ? 1 : undefined };
	if (!loop) return current;
	const feedback = instance === loop.target;
	const source = feedback ? loop.reviewer : predecessor;
	if (!source) return current;
	for (let number = 2; number <= loop.max_revisions + 1; number++) {
		const attemptId = `${instance}.${number}`;
		const path = handoffClaimPath(dir, attemptId, source);
		if (!existsSync(path)) {
			if (revisionReserved(dir, runId, loop, number) &&
				(existsSync(dispositionPath(dir, attemptId)) || existsSync(join(dir, `${attemptId}.error.json`)))) {
				current = { number, source, sourceAttempt: feedback ? number - 1 : number };
			}
			break;
		}
		if (!revisionReserved(dir, runId, loop, number)) throw new Error(`Claim for unreserved attempt ${attemptId}`);
		const claim = parseHandoffClaim(readJson<unknown>(path), {
			run_id: runId, source_instance_id: source, destination: { instance_id: instance, node_id: node, attempt_id: attemptId },
		});
		const sourceAttempt = feedback ? number - 1 : number;
		if (isLegacyClaim(claim) || claim.source.attempt_id !== `${source}.${sourceAttempt}`) {
			throw new Error(`Invalid revision handoff claim for ${attemptId}`);
		}
		current = { number, source, sourceAttempt };
	}
	return current;
}

/** Resolve a launch entry to the same attempt the worker restores on reload. */
export function currentAttempt(manifest: BootstrapManifest, entry: AgentLaunch) {
	return manifest.review_plan && !manifest.session_dir_removed ? latestReviewAttempt({
		dir: manifest.session_dir, runId: manifest.task_id, plan: manifest.review_plan,
		instance: entry.instance_id, node: entry.node_id, predecessor: inboundEdgesOf(entry)[0],
	}) : undefined;
}

// ---- dispatcher side: what the durable records say about one handoff ----

/**
 * One handoff as recorded. `queued` means only that Coms acknowledged the notification; `accepted` is the destination's own claim; `rejected` means
 * the destination refused the handoff itself. None of these says whether the destination then ran or finished (that is its execution record).
 */
export interface HandoffView {
	handoff_id?: string;
	state: "none" | "offered" | "queued" | "accepted" | "rejected";
	/** Instance IDs. */
	source: string;
	destination: string;
	input_digest?: string;
	offered_at?: string;
	queued_at?: string;
	accepted_at?: string;
	/** Accepted by the previous release's receipt, which recorded no handoff ID or digest. */
	legacy?: true;
	/** The acceptance followed a redelivery by the dispatcher rather than the source's own notification. */
	delivered_by?: "dispatcher";
	/** Redeliveries the dispatcher made (delivery only; acceptance is `state`). */
	recovery?: { attempts: number; last_transport: HandoffRetry["transport"]; last_at: string };
	/** Recent refusals, newest last. */
	rejections: HandoffRejection[];
	/** Evidence that does not add up (unreadable or unsupported records, an acceptance that disagrees with the offer or the saved input). */
	problems: string[];
}

/** The records for the handoff into `destination` from `source`, or undefined when nothing was ever offered, accepted or refused. Never throws: one bad record is a problem on the view. */
export function describeHandoff(sessionDir: string, source: string, destination: string, expected?: HandoffIdentityExpectation, sourceScope?: string, destinationInstance = destination): HandoffView | undefined {
	const problems: string[] = [];
	const read = <T>(path: string, parse: (raw: unknown) => T): T | undefined => {
		if (!existsSync(path)) return undefined;
		try { return parse(readJson<unknown>(path)); } catch (error) { problems.push(errorMessage(error)); return undefined; }
	};
	const identity: HandoffIdentityExpectation = {
		...expected,
		source_instance_id: expected?.source_instance_id ?? source,
		destination: { ...expected?.destination, instance_id: expected?.destination?.instance_id ?? destinationInstance },
	};
	const offer = read(handoffOfferPath(sessionDir, destination, sourceScope), raw => parseHandoffOffer(raw, identity));
	const edgeClaimFile = handoffClaimPath(sessionDir, destination, sourceScope);
	const joinClaimFile = sourceScope ? handoffClaimPath(sessionDir, destination) : undefined;
	let claim = read(edgeClaimFile, raw => parseHandoffClaim(raw, identity));
	let joinSource: JoinHandoffSource | undefined;
	let joinAcceptedAt: string | undefined;
	let joinRunId: string | undefined;
	if (!claim && joinClaimFile && existsSync(joinClaimFile)) {
		const joinClaim = read(joinClaimFile, raw => parseJoinHandoffClaim(raw, identity));
		if (joinClaim) {
			joinSource = joinClaim.sources.find(s => s.instance_id === source);
			if (joinSource) {
				joinAcceptedAt = joinClaim.accepted_at;
				joinRunId = joinClaim.run_id;
			}
		}
	}
	const rejections = read(handoffRejectionsPath(sessionDir, destination, sourceScope), parseHandoffRejections) ?? [];
	const claimedFile = existsSync(edgeClaimFile) || (joinSource !== undefined);
	const recovery = read(handoffRecoveryPath(sessionDir, destination, sourceScope), parseHandoffRecovery);
	if (!offer && !claim && !joinSource && !rejections.length && !problems.length && !claimedFile && !recovery) return undefined;
	const modern = claim && !isLegacyClaim(claim) ? claim : undefined;
	const acceptedHandoffId = modern?.handoff_id ?? joinSource?.handoff_id;
	const acceptedDigest = modern?.input_digest ?? joinSource?.input_digest;
	const acceptedRunId = modern?.run_id ?? joinRunId;
	const acceptedAt = modern?.accepted_at ?? joinAcceptedAt;
	const deliveredBy = modern?.delivered_by ?? joinSource?.delivered_by;
	if (acceptedHandoffId && offer && acceptedHandoffId !== offer.handoff_id) problems.push(`the recorded acceptance is for handoff ${acceptedHandoffId}, but the offer is ${offer.handoff_id}`);
	if (acceptedDigest && acceptedRunId) {
		// The acceptance must still describe the input the source saved: proof that the successor took exactly that.
		try {
			const sourceAttempt = destinationInstance !== destination ? modern?.source.attempt_id ?? joinSource?.attempt_id : undefined;
			const saved = parseCompletion(readJson<unknown>(resultPath(sessionDir, sourceAttempt ?? source)), {
				run_id: expected?.run_id ?? acceptedRunId, instance_id: source, attempt_id: sourceAttempt,
			});
			if (inputDigest(saved.result) !== acceptedDigest) problems.push("the accepted input digest does not match the saved result of the source");
		} catch { /* the source's result is reported by its own node */ }
	}
	const state: HandoffView["state"] = (claim || joinSource) ? "accepted"
		: rejections.some(rejection => rejection.severity === "integrity") ? "rejected"
		: offer ? offer.state : "none";
	return {
		...(acceptedHandoffId ?? offer?.handoff_id ? { handoff_id: acceptedHandoffId ?? offer?.handoff_id } : {}),
		state, source, destination: destinationInstance,
		...(acceptedDigest ?? offer?.input_digest ? { input_digest: acceptedDigest ?? offer?.input_digest } : {}),
		...(offer ? { offered_at: offer.offered_at } : {}), ...(offer?.queued_at ? { queued_at: offer.queued_at } : {}),
		...(acceptedAt ? { accepted_at: acceptedAt } : {}), ...(claim && isLegacyClaim(claim) ? { legacy: true as const } : {}),
		...(deliveredBy ? { delivered_by: deliveredBy } : {}),
		...(recovery?.retries.length ? { recovery: { attempts: recovery.retries.length, last_transport: recovery.retries.at(-1)!.transport, last_at: recovery.retries.at(-1)!.at } } : {}),
		rejections: rejections.slice(-3), problems,
	};
}
