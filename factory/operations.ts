import { DIRECTION_APPROVAL_TABLE_SQL, DIRECTION_DELIVERY_TABLE_SQL, REQUEST_TABLE_SQL, REVISION_ESCALATION_TABLE_SQL, boundDirectionDefinition, directionDeliveryRecorded, fenceAttempt, hasRequestTables, inTransaction, isEscalationRequest, listRequests, migrateRequestMailboxes, originalReceiver, readRequest, recordResponse, requestDecisionEvidence, requestFence, requestVersion, requestView, saveEscalationResponse, wakeResponse, type DirectionRequestView, type StoredRequest } from "../bootstrap/factory-requests.ts";
import type { InterventionPolicy } from "../bootstrap/intervention.ts";
import type { RecoveryDeps, RecoveryReport } from "../bootstrap/recovery.ts";
import type { SettlementObservations } from "../bootstrap/factory-settlement.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BootstrapService } from "../bootstrap/lifecycle.ts";
import { reserveFactoryRunIndex } from "../bootstrap/factory-index.ts";
import {
	evaluateTerminallySupersededStructure,
	generateFactoryRequestId,
	inspectFactoryReleaseState,
	ManagedManifestContradictionError,
	metadataMismatch,
	parseNormalizedFactoryManagedInfo,
	PROVEN_NON_RELEASE_ERROR,
	readAndValidateManagedManifest,
	resolveCheckoutIdentity,
	verifyFactoryNonReleaseEvidence,
	verifyTerminallySupersededNonReleaseAttempt,
	type StoredAttemptWithRowId,
	type TerminallySupersededSiblingView,
} from "../bootstrap/factory-evidence.ts";
import {
	buildAttemptRow,
	buildCheckoutHoldRow,
	buildFactoryHoldRow,
	buildFactoryPointerRow,
	buildFactoryVersionRow,
	buildInputRow,
	buildManagedRunRow,
	buildStateRow,
	inputRecordDigest,
	managerRecordDigest,
	parseVersionToken,
	QUEUED_DISPOSITIONS,
	sha256Hex,
	stateRecordDigest,
	VALID_HOLD_STATES,
	validateAttemptRow,
	validateCheckoutHoldRow,
	validateFactoryHoldRow,
	validateFactoryPointerRow,
	validateFactoryVersionRow,
	validateInputRow,
	validateManagedRunRow,
	type InputDisposition,
	type StoredAttempt,
	type StoredCheckoutHold,
	type StoredFactory,
	type StoredFactoryHold,
	type StoredFactoryPointer,
	type StoredFactoryVersion,
	type StoredInput,
	type StoredManagedRun,
	type StoredManager,
	type StoredState,
} from "../bootstrap/factory-records.ts";
import {
	atomicJson,
	coordAnchorPath,
	coordMetaRecordDigest,
	errorMessage,
	factoryRunPath,
	parseCoordAnchor,
	parseManifest,
	pathEntryExists,
	readJson,
	readRegularJsonNoSymlink,
	type BootstrapManifest,
	type FactoryManagedInfo,
} from "../bootstrap/session-store.ts";
import { deriveNodeAttemptCountsFromIndex, readValidatedUpstreamIndex, upstreamIndexPath, type NodeAttemptCount } from "../bootstrap/contracts.ts";
import { validateDraftShape } from "./draft.ts";

export const MAX_BRIEF_BYTES = 16 * 1024;
export const MAX_QUEUED_INPUTS = 32;
export const MAX_REFERENCE_BYTES = 256;

type Definition = ReturnType<BootstrapService["prepareDefinition"]>;
type SessionModel = Parameters<BootstrapService["prepareDefinition"]>[1];

export interface SessionBinding {
	pi_session_id?: string;
	pi_session_file?: string;
}

export interface ManagerAuthority {
	readonly incarnation_id: string;
}

interface AuthorityRecord {
	incarnation_id: string;
	secret_digest: string;
	pi_session_id: string | null;
	pi_session_file: string | null;
	pid: number;
	revoked: boolean;
}

const authorities = new WeakMap<ManagerAuthority, AuthorityRecord>();
const revokedIncarnations = new Set<string>();

function processIncarnation(pid: number): { boot: string; start: string } {
	try {
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		const start = afterCommand[19]; // proc stat field 22 (starttime)
		if (!/^[0-9a-f-]{36}$/i.test(boot) || !/^\d+$/.test(start ?? "")) throw new Error("invalid process incarnation evidence");
		return { boot, start };
	} catch (error) {
		throw new Error(`Cannot establish durable process incarnation identity for PID ${pid}; refusing management without boot and process-start evidence (${errorMessage(error)})`);
	}
}

function managerIncarnationId(pid: number): string {
	const identity = processIncarnation(pid);
	return `${randomUUID()}|${identity.boot}|${pid}|${identity.start}`;
}

function priorManagerCanStillRun(manager: StoredManager): boolean {
	// A live Pi process may have replaced /new or /resume'd its session. Its old authority was
	// explicitly revoked by the extension lifecycle, so PID identity alone must not strand takeover.
	if (manager.pid === process.pid && revokedIncarnations.has(manager.incarnation_id)) return false;
	const parts = manager.incarnation_id.split("|");
	if (parts.length !== 4 || !/^[0-9a-f-]{36}$/i.test(parts[0]) || !/^[0-9a-f-]{36}$/i.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) throw new Error("Recorded manager incarnation identity is unavailable or damaged; refusing takeover");
	if (Number(parts[2]) !== manager.pid) throw new Error("Recorded manager incarnation PID does not match manager record; refusing takeover");
	const currentBoot = processIncarnation(process.pid).boot;
	if (parts[1] !== currentBoot) return false;
	try { return processIncarnation(manager.pid).start === parts[3]; }
	catch (error) {
		if (/ENOENT|ESRCH/.test(errorMessage(error))) return false;
		throw error;
	}
}

export function createManagerAuthority(binding?: SessionBinding): ManagerAuthority {
	const incarnation_id = managerIncarnationId(process.pid);
	const secret = randomBytes(32).toString("hex");
	const handle: ManagerAuthority = Object.freeze({ incarnation_id });
	authorities.set(handle, {
		incarnation_id,
		secret_digest: digest(secret),
		pi_session_id: typeof binding?.pi_session_id === "string" && binding.pi_session_id.length > 0 ? binding.pi_session_id : null,
		pi_session_file: typeof binding?.pi_session_file === "string" && binding.pi_session_file.length > 0 ? binding.pi_session_file : null,
		pid: process.pid,
		revoked: false,
	});
	return handle;
}

export function revokeManagerAuthority(authority: ManagerAuthority | undefined): void {
	if (!authority) return;
	const record = authorities.get(authority);
	if (record) { record.revoked = true; revokedIncarnations.add(record.incarnation_id); }
}

function requireAuthority(authority: unknown): AuthorityRecord {
	if (!authority || typeof authority !== "object") {
		throw new Error("Untrusted or missing managing session authority; explicitly resume management in an interactive Pi session");
	}
	const record = authorities.get(authority as ManagerAuthority);
	if (!record) {
		throw new Error("Untrusted managing session authority; authority cannot be forged or inherited from saved state");
	}
	if (record.revoked) {
		throw new Error("Managing session authority has been closed or replaced; explicitly resume management in the active session");
	}
	return record;
}

type List = { action: "list" };
type Inspect = { action: "inspect"; factory_id: string; version?: string };
type PublicationTarget = { action: "publication_target"; factory_id: string };
type ReceiptLookup =
	| { action: "receipt"; factory_id: string; reference: string; input_id?: never }
	| { action: "receipt"; factory_id: string; input_id: string; reference?: never };
type VerifyManager = { action: "verify_manager"; factory_id: string; authority: ManagerAuthority };
type Publish = { action: "publish"; name: string; draft: unknown; sessionModel?: SessionModel };
/**
 * Publication of an already-managed factory is owned by its managing session: `authority` must be that session's live capability, and the optional
 * `assertAuthority` hook (the caller's live session/binding check) runs inside the write transaction and again at the commit boundary. A factory that is
 * unmanaged when the transaction runs may still be updated or restored by explicit human action without any authority, which creates none.
 */
type PublicationAuthority = { authority?: ManagerAuthority; assertAuthority?: () => void };
type Update = { action: "update"; factory_id: string; draft: unknown; sessionModel?: SessionModel; expected_current_version?: string } & PublicationAuthority;
type Restore = { action: "restore"; factory_id: string; from_version: string; expected_current_version?: string } & PublicationAuthority;
type Resume = { action: "resume"; factory_id: string; authority: ManagerAuthority };
type StopFactory = { action: "stop"; factory_id: string; authority: ManagerAuthority };
type DiscardInput = { action: "discard"; factory_id: string; input_id: string; authority: ManagerAuthority; assertAuthority?: () => void; confirm: (target: Readonly<{ factory_id: string; input_id: string; reference: string; queue_position: number; queue_position_kind: "waiting" | "acceptance"; bound_version: string; consequences: string }>) => Promise<boolean> };
type Takeover = { action: "takeover"; factory_id: string; authority: ManagerAuthority; confirmed_manager_incarnation_id: string };
type Submit = { action: "submit"; factory_id: string; reference: string; brief: string; authority: ManagerAuthority };
type Launch = {
	action: "launch";
	factory_id: string;
	/** If supplied by the scheduler, never substitute another head. */
	input_id?: string;
	authority: ManagerAuthority;
	signal?: AbortSignal;
	assertAuthorityAndTrust?: (projectCwd?: string) => void;
};
type RetryLaunch = {
	action: "retry_launch";
	factory_id: string;
	authority: ManagerAuthority;
	input_id: string;
	previous_attempt_id: string;
	confirmed: true;
	signal?: AbortSignal;
	assertAuthorityAndTrust?: (projectCwd?: string) => void;
};
export interface FactoryCancellationTarget {
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	bound_version: string;
	consequences: string;
}
type CancelRun = {
	action: "cancel_run";
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	authority: ManagerAuthority;
	/** Supplied only by the direct command adapter, never by a structured tool or a JSON flag. */
	confirm: (target: Readonly<FactoryCancellationTarget>) => Promise<boolean>;
	assertAuthority?: () => void;
};
type SettleRun = {
	action: "settle_run";
	factory_id: string;
	authority: ManagerAuthority;
	assertAuthority?: () => void;
};
/** What the direct human sees and confirms: the exact run, both holds, what is missing or contradictory, and the consequences. */
export interface ClearanceTarget {
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	bound_version: string;
	canonical_checkout: string;
	holds: { factory_held_at: string; checkout_held_at: string };
	missing_or_contradictory: string[];
	/** The part of `missing_or_contradictory` that comes from the attempt's own records, as opposed to the run's execution observations. */
	evidence_problems: string[];
	/** True when the run's evidence could not be read at all when the dialog was shown; the human accepts that, and a run readable at the dialog but unreadable at commit is refused. */
	evidence_unreadable: boolean;
	action: string;
	consequences: string;
}
/** The human's own statements, collected by the direct command adapter alongside the confirmation; never a model-supplied flag. */
export interface ClearanceDecision { reason: string; evidence: string; acknowledged_unknown_effects: boolean }
export interface ClearanceRecord {
	cleared_at: string;
	reason: string;
	evidence: string;
	acknowledged_unknown_effects: true;
	/** The input's disposition at clearance, kept because clearance retires it without rewriting what was recorded. */
	prior_input_disposition: string;
	missing_or_contradictory: string[];
	/** The run's own settlement observations at clearance, kept apart from clearance: execution settlement stays whatever the evidence said. */
	observations: SettlementObservations;
	released_holds: { factory_held_at: string; checkout_held_at: string };
	/** Source rows exactly as they were at clearance. Retiring the input and deleting the holds and run association must never destroy a contradictory record, so their full content is kept here. */
	source_records: { input: StoredInput; managed_run: StoredManagedRun | null; factory_hold: StoredFactoryHold; checkout_hold: StoredCheckoutHold };
}
type ClearHold = {
	action: "clear_hold";
	factory_id: string;
	input_id: string;
	attempt_id: string;
	task_id: string;
	authority: ManagerAuthority;
	/** Supplied only by the direct command adapter, never by a structured tool or a JSON flag. Resolves to the human's statements, or undefined when declined. */
	confirm: (target: Readonly<ClearanceTarget>) => Promise<ClearanceDecision | undefined>;
	assertAuthority?: () => void;
};
export type RetirementDiagnostic = { attempt_id: string; task_id: string; reason: string };
type ClearHoldResult = { cleared: boolean; target: ClearanceTarget; clearance?: ClearanceRecord; retirement_diagnostics?: RetirementDiagnostic[] };
type SettleRunResult = { settled: boolean; proven_not_released?: boolean; reason: string; settlement?: AttemptSettlement; retirement_diagnostics?: RetirementDiagnostic[] };
type RedeliverHandoff = {
	action: "redeliver_handoff";
	factory_id: string;
	authority: ManagerAuthority;
	/** Successor node whose inbound handoff to redeliver. */
	agent: string;
	source?: string;
	wake?: RecoveryDeps["wake"];
	senderSession?: string;
	signal?: AbortSignal;
	assertAuthority?: () => void;
};
type RespondRequest = {
	action: "respond_request";
	factory_id: string;
	request_id: string;
	/** A presented choice or an explicit decline, each with optional guidance; text alone is not a response. */
	response: unknown;
	newBrief?: string;
	confirmExhaustion?: (target: ExhaustionConfirmation) => boolean;
	authority: ManagerAuthority;
	assertAuthority?: () => void;
};
export type ExhaustionConfirmation = Readonly<Pick<DirectionRequestView, "factory_id" | "input_id" | "task_id" | "request_id" | "node_attempt_id" | "exhaustion"> & { choice: "takeover" | "discard" }>;
type RedeliverResponse = Omit<RespondRequest, "action" | "response"> & { action: "redeliver_response" };
type ListRequests = { action: "requests"; factory_id: string };
type RespondRequestResult = { request: DirectionRequestView; replayed: boolean; retry_receipt?: InputReceipt };
type CancelRunResult = { cancelled: boolean; target: FactoryCancellationTarget };
type Binding = { action: "binding"; factory_id: string; bound_version: string };
export type FactoryRead = List | Inspect | PublicationTarget | ReceiptLookup | Binding;

export type { InputDisposition };
type Identity = { factory_id: string; name: string };
export type ManagementState = "unmanaged" | "managed";
export type Factory = Identity & { current_version: string; management: ManagementState };

export type FactoryNodePolicySummary =
	| {
		kind?: "agent";
		node_id: string;
		persona_name: string;
		model: string;
		thinking: string;
		tools: { mode: "declared"; names: string[] } | { mode: "inherit"; note: string };
		skills: { mode: "declared"; names: string[] } | { mode: "inherit"; note: string };
		extensions: { mode: "inherit_with_additions"; declared: string[]; paths: string[]; note: string };
		/** Present only for a node the definition opted in to ask a human for direction. */
		intervention?: InterventionPolicy;
	}
	| {
		kind: "command";
		node_id: string;
		command: string;
		args: string[];
		working_directory: string;
	};

export interface FactoryVersionSummary {
	version: string;
	digest: string;
	created_at: string | null;
	restored_from_version: string | null;
	corrupt_reason?: string;
}

export interface AttemptSummary {
	attempt_id: string;
	factory_id: string;
	input_id: string;
	bound_version: string;
	current_version?: string;
	request_id: string;
	task_id: string;
	canonical_checkout: string;
	state: string;
	release_authorized: boolean;
	release_authorized_at: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	uncertainty?: string[];
	non_release_proof?: { status: "proven" | "not_proven"; reason: string };
	retry_eligibility?: { eligible: boolean; reason: string };
	/** For the attempt holding capacity: whether an operator may clear the hold, what is missing or contradictory, and the exact action. */
	clearance_eligibility?: ClearanceEligibility;
	/** Set once an operator cleared the hold; separate from `settlement`, which keeps what the evidence said about execution. */
	clearance?: ClearanceRecord;
	historical?: boolean;
	/** Cancellation intent, resource closure, execution settlement and capacity release, each observed separately. */
	settlement?: AttemptSettlement;
	node_policies?: Record<string, FactoryNodePolicySummary>;
	/** Report-only per-node attempt and rollback counts derived from upstream-index.json. */
	node_counts?: NodeAttemptCount[];
	node_counts_error?: string;
	run?: {
		status: BootstrapManifest["status"];
		phase: string;
		error?: string;
		release_marker_present: boolean;
		abort_marker_present: boolean;
		outcome?: unknown;
		pending?: string[];
		worker_errors?: string[];
		delivery_errors?: string[];
	};
}

export interface ClearanceEligibility {
	eligible: boolean;
	reason: string;
	holds: { factory_held_at?: string; checkout_held_at?: string };
	missing_or_contradictory: string[];
	evidence_problems: string[];
	evidence_unreadable: boolean;
	resume_risk: string[];
	action: string;
	consequences: string;
}

const CLEARANCE_ACTION = "Record an operator clearance for this exact run: release both its factory capacity hold and its checkout hold, and retire its input from launch eligibility.";
const CLEARANCE_CONSEQUENCES = "VERIFY FIRST that no process of this run is still running; confirmation is your own assurance, the factory cannot check it. Past execution is not resolved: its recorded outcome and every source record are kept, no effect is undone, and nothing is launched or replayed on its behalf (intentional repetition needs a new submission). Effects of the original run on the checkout are unknown. If its work can still resume, it will conflict with whatever uses the checkout next. Confirmation never overrides evidence that conflicting work may still resume.";

/** The current released attempt that owns the factory's capacity holds, if any. */
export function heldReleasedAttempt(view: Pick<Inspection, "attempts">): AttemptSummary | undefined {
	return view.attempts.find(item => !item.historical && item.release_authorized && item.state === "released");
}

/** Both holds must belong to exactly this attempt's run in this factory database. */
function assertOwnsBothHolds(db: DatabaseSync, factoryId: string, attempt: Pick<StoredAttempt, "attempt_id" | "task_id" | "canonical_checkout">, factoryDbPath: string, subject: string): { fHold: StoredFactoryHold; cHold: StoredCheckoutHold } {
	const fHold = selectFactoryHold(db, factoryId);
	const cHold = selectCheckoutHold(db, attempt.canonical_checkout);
	if (!fHold || !cHold || fHold.attempt_id !== attempt.attempt_id || cHold.attempt_id !== attempt.attempt_id || fHold.task_id !== attempt.task_id || cHold.task_id !== attempt.task_id || cHold.factory_db_path !== realpathSync(factoryDbPath)) throw new Error(`${subject} does not own both capacity holds`);
	return { fHold, cHold };
}

export interface AttentionItem { kind: "failed_run" | "uncertain" | "intervention" | "report_notice"; attempt_id?: string; input_id?: string; task_id?: string; request_id?: string; reason: string }

export type AttemptSettlement = SettlementObservations & { capacity_release: "held" | "released"; settled_at?: string; released_holds?: { factory_held_at: string; checkout_held_at: string } };

const SETTLEMENT_PREFIX = "settlement:";
function encodeSettlement(obs: SettlementObservations, settledAt: string, holds: { factory_held_at: string; checkout_held_at: string }): string {
	// The hold rows are deleted on settlement; their history is kept here, inside the digest-protected attempt record.
	return SETTLEMENT_PREFIX + JSON.stringify({ ...obs, capacity_release: "released", settled_at: settledAt, released_holds: holds });
}
function decodeSettlement(error: string | null): AttemptSettlement | undefined {
	if (!error?.startsWith(SETTLEMENT_PREFIX)) return undefined;
	try {
		const value = JSON.parse(error.slice(SETTLEMENT_PREFIX.length)) as Partial<AttemptSettlement> | null;
		const intents = ["none", "requested", "unknown"], closures = ["closed", "unknown"];
		if (!value || typeof value !== "object"
			|| !intents.includes(value.cancellation?.intent as string)
			|| !closures.includes(value.resource_closure?.state as string)
			|| value.execution_settlement?.state !== "settled" || typeof value.execution_settlement.reason !== "string"
			|| value.capacity_release !== "released" || typeof value.settled_at !== "string"
			|| typeof value.outcome !== "string" || !Array.isArray(value.attention)) return undefined;
		return value as AttemptSettlement;
	} catch { return undefined; }
}

function validObservations(value: unknown): value is SettlementObservations {
	const obs = value as Partial<SettlementObservations> | null;
	return Boolean(obs && typeof obs === "object"
		&& ["none", "requested", "unknown"].includes(obs.cancellation?.intent as string)
		&& ["closed", "unknown"].includes(obs.resource_closure?.state as string)
		&& ["settled", "unsettled", "unknown"].includes(obs.execution_settlement?.state as string) && typeof obs.execution_settlement?.reason === "string"
		&& typeof obs.outcome === "string" && Array.isArray(obs.resume_risk) && Array.isArray(obs.attention));
}

const CLEARANCE_PREFIX = "clearance:";
function encodeClearance(record: ClearanceRecord): string { return CLEARANCE_PREFIX + JSON.stringify(record); }
function decodeClearance(error: string | null): ClearanceRecord | undefined {
	if (!error?.startsWith(CLEARANCE_PREFIX)) return undefined;
	try {
		const value = JSON.parse(error.slice(CLEARANCE_PREFIX.length)) as Partial<ClearanceRecord> | null;
		if (!value || typeof value !== "object"
			|| typeof value.cleared_at !== "string" || typeof value.reason !== "string" || !value.reason
			|| typeof value.evidence !== "string" || !value.evidence || value.acknowledged_unknown_effects !== true
			|| typeof value.prior_input_disposition !== "string" || !Array.isArray(value.missing_or_contradictory)
			|| !validObservations(value.observations) || !value.source_records?.input || typeof value.source_records.input !== "object" || !value.source_records.factory_hold || !value.source_records.checkout_hold || !("managed_run" in value.source_records)
			|| !value.released_holds
			|| typeof value.released_holds.factory_held_at !== "string" || typeof value.released_holds.checkout_held_at !== "string") return undefined;
		return value as ClearanceRecord;
	} catch { return undefined; }
}

export interface InputReceipt {
	factory_id: string;
	input_id: string;
	reference: string;
	bound_version: string;
	current_version?: string;
	disposition: InputDisposition;
	queue_position: number;
	brief: string;
	brief_bytes: number;
	accepted_at: string;
	attempt?: AttemptSummary;
}

export interface CapacityView {
	queue_used: number;
	queue_limit: number;
	factory_slot: "free" | "held" | "uncertain";
	checkout_slot: "free" | "held" | "uncertain";
	canonical_checkout: string;
	blocking_hold?: {
		scope: "factory" | "checkout" | "both";
		factory_id: string;
		factory_name?: string;
		input_id: string;
		attempt_id: string;
		request_id?: string;
		task_id: string;
		state: string;
		release_authorized?: boolean;
		held_at: string;
		reason?: string;
	};
}

export interface HeadStatus {
	eligible: boolean;
	input_id?: string;
	reference?: string;
	bound_version?: string;
	current_version?: string;
	blocking_kind?: "empty" | "unmanaged" | "stopped" | "factory_held" | "checkout_held" | "preflight" | "compatibility" | "ceiling" | "uncertain";
	reason?: string;
	/** Eligibility and any other blocker, independent of the control fence. */
	without_control_fence?: HeadStatus;
}

export interface RuntimeAssumptions {
	not_frozen: readonly string[];
	note: string;
}

export type Inspection = {
	factory: Factory;
	inspected_version: string;
	/** Absent when the inspected version's own record is damaged (see `inspected_error`); never another version's definition. */
	definition?: Definition;
	/** Set when the current version's definition (the pointer itself is intact) is missing or damaged. */
	current_error?: string;
	inspected_error?: string;
	/** Set when the head's own definition was unavailable: the retained version whose checkout path the capacity/hold evidence was computed against. */
	checkout_evidence_stand_in?: string;
	versions: FactoryVersionSummary[];
	node_policies?: Record<string, FactoryNodePolicySummary>;
	/** Policies of each retained version the queue or attempts are bound to (keyed by version), separate from the inspected version's `node_policies`. */
	bound_policies?: Record<string, Record<string, FactoryNodePolicySummary>>;
	runtime_assumptions: RuntimeAssumptions;
	/** Outstanding items that stay listed until resolved, so a missed notification never hides them: failed or unresolved runs and uncertain evidence. */
	attention: AttentionItem[];
	/** Human-direction requests (pending, resolved, cancelled or failed) with response and consumption as separate observations. Absent while unmanaged. */
	requests?: DirectionRequestView[];
	/** Request evidence is independent of authority to stop execution or release a proven-safe hold. */
	request_evidence_error?: string;
	queue: InputReceipt[];
	/** Durable stop fence; absent when unmanaged or the control evidence is unreadable. */
	stopped?: boolean;
	control_error?: string;
	capacity: CapacityView;
	attempts: AttemptSummary[];
	head_status: HeadStatus;
	uncertainty: string[];
};
export type UpdateResult = {
	factory: Factory;
	version: string;
	digest: string;
	created_at: string;
	restored_from_version?: string;
};
/** Read-only account of the version a run or input is bound to, kept separate from whatever is current. */
export interface BindingView {
	factory_id: string;
	factory_name: string;
	bound_version: string;
	/** Absent when the factory's current pointer evidence is missing or damaged; never inferred from the bound version. */
	current_version?: string;
	bound_matches_current?: boolean;
	/** Set when the current pointer, or the current version's definition, cannot be verified. */
	current_error?: string;
	/** False when the retained bound version is missing, damaged or unreadable. */
	bound_retained: boolean;
	error?: string;
	node_policies?: Record<string, FactoryNodePolicySummary>;
	runtime_assumptions: RuntimeAssumptions;
}
export type LaunchResult = {
	factory_id: string;
	input_id: string;
	reference: string;
	bound_version: string;
	attempt_id: string;
	request_id: string;
	task_id: string;
	release_authorized: boolean;
	manifest: BootstrapManifest;
};
type ResumeResult = { factory: Factory; resumed: true; already_managed: boolean };
type CommitBoundary = (phase: "before_commit" | "after_commit") => void;
export type LaunchCommitBoundary = (phase: "reserve_before_commit" | "reserve_after_commit" | "release_before_commit" | "release_after_commit" | "settle_before_commit" | "settle_after_commit" | "pre_release_settle_before_tx" | "clear_before_commit" | "clear_after_commit") => void;
export interface FactoryOperationsOptions {
	atCommit?: CommitBoundary;
	atLaunchCommit?: LaunchCommitBoundary;
	coordinationPath?: string;
}

const MANAGER_TABLE_SQL = `
	CREATE TABLE factory_managers (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		incarnation_id TEXT NOT NULL,
		authority_digest TEXT NOT NULL,
		pi_session_id TEXT,
		pi_session_file TEXT,
		pid INTEGER NOT NULL,
		resumed_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const INPUT_TABLE_SQL = `
	CREATE TABLE factory_inputs (
		input_id TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL REFERENCES factories(factory_id),
		reference TEXT NOT NULL,
		queue_position INTEGER NOT NULL,
		bound_version TEXT NOT NULL,
		disposition TEXT NOT NULL,
		brief TEXT NOT NULL,
		brief_bytes INTEGER NOT NULL,
		brief_digest TEXT NOT NULL,
		accepted_at TEXT NOT NULL,
		record_digest TEXT NOT NULL,
		UNIQUE(factory_id, reference),
		UNIQUE(factory_id, queue_position)
	) STRICT;
`;

const STATE_TABLE_SQL = `
	CREATE TABLE factory_state (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		established INTEGER NOT NULL CHECK (established IN (0, 1)),
		last_input_position INTEGER NOT NULL CHECK (last_input_position >= 0),
		record_digest TEXT NOT NULL
	) STRICT;
`;

const ATTEMPT_TABLE_SQL = `
	CREATE TABLE factory_attempts (
		attempt_id TEXT PRIMARY KEY NOT NULL,
		factory_id TEXT NOT NULL REFERENCES factories(factory_id),
		input_id TEXT NOT NULL REFERENCES factory_inputs(input_id),
		bound_version TEXT NOT NULL,
		request_id TEXT NOT NULL UNIQUE,
		task_id TEXT NOT NULL UNIQUE,
		canonical_checkout TEXT NOT NULL,
		checkout_key TEXT NOT NULL,
		state TEXT NOT NULL,
		release_authorized INTEGER NOT NULL CHECK (release_authorized IN (0, 1)),
		release_authorized_at TEXT,
		release_token_digest TEXT,
		release_nonce_digest TEXT,
		error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const FACTORY_VERSION_TABLE_SQL = `
	CREATE TABLE factory_versions (
		factory_id TEXT NOT NULL REFERENCES factories(factory_id),
		version TEXT NOT NULL,
		version_num INTEGER NOT NULL CHECK (version_num >= 1),
		definition TEXT NOT NULL,
		digest TEXT NOT NULL,
		restored_from_version TEXT,
		created_at TEXT NOT NULL,
		record_digest TEXT NOT NULL,
		PRIMARY KEY (factory_id, version),
		UNIQUE (factory_id, version_num)
	) STRICT;
`;

const FACTORY_POINTER_TABLE_SQL = `
	CREATE TABLE factory_pointers (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		current_version TEXT NOT NULL,
		current_version_num INTEGER NOT NULL CHECK (current_version_num >= 1),
		definition_digest TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const FACTORY_HOLD_TABLE_SQL = `
	CREATE TABLE factory_holds (
		factory_id TEXT PRIMARY KEY NOT NULL REFERENCES factories(factory_id),
		attempt_id TEXT NOT NULL UNIQUE REFERENCES factory_attempts(attempt_id),
		input_id TEXT NOT NULL REFERENCES factory_inputs(input_id),
		request_id TEXT NOT NULL,
		task_id TEXT NOT NULL,
		state TEXT NOT NULL,
		held_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const COORD_META_TABLE_SQL = `
	CREATE TABLE coord.coord_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		anchor_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const CHECKOUT_HOLD_TABLE_SQL = `
	CREATE TABLE coord.checkout_holds (
		canonical_checkout TEXT PRIMARY KEY NOT NULL,
		checkout_key TEXT NOT NULL UNIQUE,
		factory_id TEXT NOT NULL,
		factory_name TEXT NOT NULL,
		factory_db_path TEXT NOT NULL,
		attempt_id TEXT NOT NULL UNIQUE,
		input_id TEXT NOT NULL,
		request_id TEXT NOT NULL,
		task_id TEXT NOT NULL,
		state TEXT NOT NULL,
		held_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
`;

const MANAGED_RUN_TABLE_SQL = `
	CREATE TABLE coord.managed_runs (
		task_id TEXT PRIMARY KEY NOT NULL,
		request_id_digest TEXT NOT NULL UNIQUE,
		factory_id TEXT NOT NULL,
		factory_name TEXT NOT NULL,
		factory_db_path TEXT NOT NULL,
		input_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL UNIQUE,
		canonical_checkout TEXT NOT NULL,
		checkout_key TEXT NOT NULL,
		created_at TEXT NOT NULL,
		record_digest TEXT NOT NULL
	) STRICT;
	CREATE INDEX coord.managed_runs_checkout_idx ON managed_runs(canonical_checkout);
	CREATE INDEX coord.managed_runs_checkout_key_idx ON managed_runs(checkout_key);
`;

const digest = sha256Hex;

function validateToken(value: unknown, label: string, maxBytes = MAX_REFERENCE_BYTES): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty literal token`);
	}
	if (!value.isWellFormed()) {
		throw new Error(`${label} must be well-formed UTF-8 text`);
	}
	if (/[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`${label} cannot contain whitespace or control characters`);
	}
	if (Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
	}
	return value;
}

function validateBrief(value: unknown): { brief: string; brief_bytes: number; brief_digest: string } {
	if (typeof value !== "string") {
		throw new Error("Brief must be plain UTF-8 text");
	}
	if (!value.isWellFormed()) {
		throw new Error("Brief must be well-formed UTF-8 text");
	}
	if (value.trim().length === 0) {
		throw new Error("Brief must be nonblank plain text");
	}
	const brief_bytes = Buffer.byteLength(value, "utf8");
	if (brief_bytes > MAX_BRIEF_BYTES) {
		throw new Error(`Brief exceeds the 16 KiB (${MAX_BRIEF_BYTES} UTF-8 bytes) limit (got ${brief_bytes} bytes)`);
	}
	return { brief: value, brief_bytes, brief_digest: digest(value) };
}

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Persist every newly-created directory entry, not only the leaf database parent. */
function assertNoSymlinkComponents(path: string): void {
	const absolute = resolve(path);
	const components: string[] = [];
	for (let current = absolute; ; current = dirname(current)) {
		components.push(current);
		if (dirname(current) === current) break;
	}
	for (const component of components.reverse()) {
		try {
			if (lstatSync(component).isSymbolicLink()) throw new Error(`Factory storage path contains a symlink: ${component}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function createDurableDirectory(path: string): void {
	assertNoSymlinkComponents(path);
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) throw new Error(`Cannot find an existing parent for factory state directory ${path}`);
		current = parent;
	}
	mkdirSync(path, { recursive: true, mode: 0o700 });
	// Sync the entire extant ancestry, not only directories this process created: a concurrent
	// creator may have made an entry but not yet persisted its parent before this publisher arrives.
	for (current = path; ; current = dirname(current)) {
		syncDirectory(current);
		if (dirname(current) === current) break;
		syncDirectory(dirname(current));
	}
}

const FACTORY_RUNTIME_ASSUMPTIONS: RuntimeAssumptions = Object.freeze({
	not_frozen: Object.freeze([
		"pi_runtime",
		"live_tool_availability",
		"live_skill_availability",
		"extension_and_skill_contents",
		"provider_catalog_and_credentials",
		"checkout_contents",
	]),
	note: "Retained versions preserve graph, checkout, instructions, contracts, resolved persona/model/thinking, limits, and declared policies; inherited tools/skills/extensions, runtime prerequisites, extension/skill contents, provider catalog/credentials, and checkout contents remain live runtime inputs.",
});

export function summarizeNodePolicies(definition: Definition): Record<string, FactoryNodePolicySummary> {
	const out: Record<string, FactoryNodePolicySummary> = {};
	for (const agent of definition.agents) {
		if (agent.node.kind === "command" || ("kind" in agent && agent.kind === "command")) {
			out[agent.node.node_id] = {
				kind: "command",
				node_id: agent.node.node_id,
				command: agent.node.command!,
				args: [...(agent.node.args ?? [])],
				working_directory: agent.node.working_directory ?? definition.project_cwd,
			};
			continue;
		}
		const agentEntry = agent as Exclude<(typeof definition.agents)[number], { kind: "command" }>;
		out[agentEntry.node.node_id] = {
			node_id: agentEntry.node.node_id,
			persona_name: agentEntry.persona_name,
			model: agentEntry.model,
			thinking: agentEntry.thinking,
			tools: agentEntry.tools.mode === "declared"
				? { mode: "declared", names: [...agentEntry.tools.names] }
				: { mode: "inherit", note: "Inherits live Pi runtime tool availability at launch" },
			skills: agentEntry.skills.mode === "declared"
				? { mode: "declared", names: [...agentEntry.skills.names] }
				: { mode: "inherit", note: "Inherits live Pi runtime skill availability at launch" },
			extensions: {
				mode: "inherit_with_additions",
				declared: [...(agentEntry.extensions?.declared ?? [])],
				paths: [...(agentEntry.extensions?.paths ?? [])],
				note: "Inherits live Pi extensions plus declared additions; extension contents are not snapshotted",
			},
			...(agentEntry.node.intervention ? { intervention: agentEntry.node.intervention } : {}),
		};
	}
	return out;
}

function summary(identity: Identity, management: ManagementState = "unmanaged", current_version = "v1"): Factory {
	return { factory_id: identity.factory_id, name: identity.name, current_version, management };
}

/** Admit a new immutable input under the caller's already verified manager transaction. */
function admitInput(db: DatabaseSync, factoryRow: StoredFactory, state: StoredState, reference: string, brief: ReturnType<typeof validateBrief>): InputReceipt {
	const { factory_id, name } = factoryRow;
	if (isFactoryStopped(db, factory_id)) throw new Error(`Factory "${name}" (${factory_id}) is stopped; explicitly resume it before admitting new work`);
	verifyStoredFactory(factoryRow);
	const currentVersion = loadFactoryVersionCatalog(db, schemaVersion(db), factoryRow, { strictHistory: false }).currentVersion;
	const rows = db.prepare("SELECT * FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC").all(factory_id) as unknown as StoredInput[];
	const verified = verifyQueueCompleteness(factoryRow, rows, state.last_input_position, currentVersion);
	if (queueOccupancy(verified, selectAttemptsWithTokens(db, factory_id).attempts) >= MAX_QUEUED_INPUTS) {
		throw new Error(`Factory "${name}" (${factory_id}) queue is full (${MAX_QUEUED_INPUTS}/${MAX_QUEUED_INPUTS} queued inputs); no inputs were evicted`);
	}
	const row: Omit<StoredInput, "record_digest"> = {
		input_id: randomUUID(), factory_id, reference, queue_position: state.last_input_position + 1,
		bound_version: currentVersion, disposition: "queued", ...brief, accepted_at: new Date().toISOString(),
	};
	db.prepare(`INSERT INTO factory_inputs (input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.input_id, factory_id, reference, row.queue_position, row.bound_version, row.disposition, row.brief, row.brief_bytes, row.brief_digest, row.accepted_at, inputRecordDigest(row));
	const next = buildStateRow(factory_id, 1, row.queue_position);
	db.prepare("UPDATE factory_state SET established = ?, last_input_position = ?, record_digest = ? WHERE factory_id = ?")
		.run(next.established, next.last_input_position, next.record_digest, factory_id);
	return verifyInputRow({ ...row, record_digest: inputRecordDigest(row) }, currentVersion);
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

type SchemaVer = 0 | 1 | 2 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
function schemaVersion(db: DatabaseSync): SchemaVer {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	if (version === 3) {
		throw new Error("Unsupported path-only factory launch schema version 3 without physical checkout identity; refusing unsafe rekeying or clearance");
	}
	if (version !== 0 && version !== 1 && version !== 2 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11) throw new Error(`Unsupported factory storage version ${version}`);
	if (version === 0 && db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
		throw new Error("Factory storage corruption detected: version-zero database has a nonempty schema");
	}
	if (version >= 1 && !hasTable(db, "factories")) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing factories table`);
	}
	if (version >= 2 && (!hasTable(db, "factory_managers") || !hasTable(db, "factory_inputs") || !hasTable(db, "factory_state"))) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing required tables`);
	}
	if (version >= 4 && (!hasTable(db, "factory_attempts") || !hasTable(db, "factory_holds"))) {
		throw new Error(`Factory storage corruption detected: version-${version} database is missing required tables`);
	}
	if (version >= 5 && (!hasTable(db, "factory_versions") || !hasTable(db, "factory_pointers"))) {
		throw new Error("Factory storage corruption detected: version-five database is missing required tables");
	}
	if (version >= 6) requestVersion(db);
	return version;
}

function hasCoordTable(db: DatabaseSync, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM coord.sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function readAnchorFile(coordPath: string): ReturnType<typeof parseCoordAnchor> | undefined {
	const anchorPath = coordAnchorPath(coordPath);
	assertNoSymlinkComponents(anchorPath);
	if (!existsSync(anchorPath)) return undefined;
	return parseCoordAnchor(readJson<unknown>(anchorPath));
}

function writeAnchorFile(coordPath: string, anchor: ReturnType<typeof parseCoordAnchor>): void {
	const anchorPath = coordAnchorPath(coordPath);
	assertNoSymlinkComponents(anchorPath);
	atomicJson(anchorPath, anchor, true);
}

function inspectCoordContinuityReadOnly(
	coordPath: string,
	db: DatabaseSync | undefined,
): { coordVersion: 0 | 2; error?: string } {
	let anchor: ReturnType<typeof parseCoordAnchor> | undefined;
	try {
		anchor = readAnchorFile(coordPath);
	} catch (error) {
		return { coordVersion: 0, error: `Invalid factory coordination continuity anchor: ${errorMessage(error)}` };
	}
	if (!db) {
		if (anchor?.state === "committed") {
			return { coordVersion: 0, error: "Factory coordination database is missing despite prior initialization continuity anchor" };
		}
		return { coordVersion: 0 };
	}
	const version = db.prepare("PRAGMA coord.user_version").get()?.user_version;
	if (version === 1) {
		return { coordVersion: 0, error: "Unsupported path-only factory coordination storage version 1 without physical checkout identity; refusing unsafe rekeying or clearance" };
	}
	if (version !== 0 && version !== 2) {
		return { coordVersion: 0, error: `Unsupported factory coordination storage version ${version}` };
	}
	if (version === 0) {
		if (db.prepare("SELECT 1 FROM coord.sqlite_schema LIMIT 1").get()) {
			return { coordVersion: 0, error: "Factory coordination storage corruption detected: version-zero database has a nonempty schema" };
		}
		if (anchor?.state === "committed") {
			return { coordVersion: 0, error: "Factory coordination database is uninitialized despite prior initialization continuity anchor" };
		}
		return { coordVersion: 0 };
	}
	if (!hasCoordTable(db, "coord_meta") || !hasCoordTable(db, "checkout_holds") || !hasCoordTable(db, "managed_runs")) {
		return { coordVersion: 2, error: "Factory coordination storage corruption detected: version-two database is missing required tables" };
	}
	if (!anchor) {
		return { coordVersion: 2, error: "Factory coordination continuity anchor is missing for initialized coordination database" };
	}
	const meta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
		| { id: number; anchor_id: string; created_at: string; record_digest: string }
		| undefined;
	if (!meta || coordMetaRecordDigest(meta.id, meta.anchor_id, meta.created_at) !== meta.record_digest) {
		return { coordVersion: 2, error: "Factory coordination metadata corruption detected: continuity record digest mismatch" };
	}
	if (meta.anchor_id !== anchor.anchor_id) {
		return { coordVersion: 2, error: "Factory coordination continuity mismatch: database identity does not match continuity anchor" };
	}
	return { coordVersion: 2 };
}

function ensureCoordSchema(db: DatabaseSync, coordPath: string): { newlyInitialized: boolean; anchor: ReturnType<typeof parseCoordAnchor> } {
	const version = db.prepare("PRAGMA coord.user_version").get()?.user_version;
	if (version === 1) {
		throw new Error("Unsupported path-only factory coordination storage version 1 without physical checkout identity; refusing unsafe rekeying or clearance");
	}
	if (version !== 0 && version !== 2) throw new Error(`Unsupported factory coordination storage version ${version}`);
	const existingAnchor = readAnchorFile(coordPath);
	if (version === 0) {
		if (db.prepare("SELECT 1 FROM coord.sqlite_schema LIMIT 1").get()) {
			throw new Error("Factory coordination storage corruption detected: version-zero database has a nonempty schema");
		}
		if (existingAnchor && existingAnchor.state !== "pending") {
			throw new Error("Factory coordination database is uninitialized despite prior initialization continuity anchor");
		}
		const anchor: ReturnType<typeof parseCoordAnchor> = {
			version: 1,
			anchor_id: randomUUID(),
			state: "pending",
			created_at: new Date().toISOString(),
		};
		db.exec(`
			${COORD_META_TABLE_SQL}
			${CHECKOUT_HOLD_TABLE_SQL}
			${MANAGED_RUN_TABLE_SQL}
			PRAGMA coord.user_version = 2;
		`);
		db.prepare("INSERT INTO coord.coord_meta (id, anchor_id, created_at, record_digest) VALUES (?, ?, ?, ?)").run(
			1,
			anchor.anchor_id,
			anchor.created_at,
			coordMetaRecordDigest(1, anchor.anchor_id, anchor.created_at),
		);
		writeAnchorFile(coordPath, anchor);
		return { newlyInitialized: true, anchor };
	}
	if (!hasCoordTable(db, "coord_meta") || !hasCoordTable(db, "checkout_holds") || !hasCoordTable(db, "managed_runs")) {
		throw new Error("Factory coordination storage corruption detected: version-two database is missing required tables");
	}
	if (!existingAnchor) {
		throw new Error("Factory coordination continuity anchor is missing for initialized coordination database");
	}
	const meta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
		| { id: number; anchor_id: string; created_at: string; record_digest: string }
		| undefined;
	if (!meta || coordMetaRecordDigest(meta.id, meta.anchor_id, meta.created_at) !== meta.record_digest) {
		throw new Error("Factory coordination metadata corruption detected: continuity record digest mismatch");
	}
	if (meta.anchor_id !== existingAnchor.anchor_id) {
		throw new Error("Factory coordination continuity mismatch: database identity does not match continuity anchor");
	}
	return { newlyInitialized: existingAnchor.state === "pending", anchor: existingAnchor };
}

function verifyCoordSchemaForRelease(db: DatabaseSync, coordPath: string): void {
	const check = inspectCoordContinuityReadOnly(coordPath, db);
	if (check.error) throw new Error(check.error);
	if (check.coordVersion !== 2) throw new Error("Factory coordination storage is not initialized at release gate");
}

function ensureV2Schema(db: DatabaseSync): SchemaVer {
	const version = schemaVersion(db);
	if (version === 0) {
		db.exec(`
			CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			${STATE_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
	} else if (version === 1) {
		const existingFactories = db.prepare("SELECT factory_id, name, definition, digest FROM factories").all() as StoredFactory[];
		for (const row of existingFactories) verifyStoredFactory(row);
		db.exec(`
			${MANAGER_TABLE_SQL}
			${INPUT_TABLE_SQL}
			${STATE_TABLE_SQL}
			PRAGMA user_version = 2;
		`);
		const insertState = db.prepare(
			"INSERT INTO factory_state (factory_id, established, last_input_position, record_digest) VALUES (?, ?, ?, ?)",
		);
		for (const row of existingFactories) {
			const state = buildStateRow(row.factory_id, 0, 0);
			insertState.run(state.factory_id, state.established, state.last_input_position, state.record_digest);
		}
	}
	return version;
}

/** Migrate within the caller's write transaction; never reconstruct a v7 stop fence. */
function ensureV7Schema(db: DatabaseSync): void {
	if (schemaVersion(db) >= 7) {
		if (!hasTable(db, "factory_controls")) throw new Error("Factory control table is missing in storage version 7 or newer; restore control evidence before proceeding");
		return;
	}
	ensureV6Schema(db);
	// Preserve any control records written before the schema version was bumped, including stops.
	if (!hasTable(db, "factory_controls")) {
		db.exec("CREATE TABLE factory_controls (factory_id TEXT PRIMARY KEY NOT NULL, stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)), updated_at TEXT NOT NULL, record_digest TEXT NOT NULL) STRICT;");
		const initialAt = new Date().toISOString();
		for (const { factory_id } of db.prepare("SELECT factory_id FROM factories").all() as { factory_id: string }[]) {
			insertInitialControl(db, factory_id, initialAt);
		}
	}
	db.exec("PRAGMA user_version = 7");
}

function readFailure(error: unknown): unknown {
	// SQLITE_READONLY_ROLLBACK: report uncertainty instead of recovering on an inspection path.
	return (error as { errcode?: number })?.errcode === 776
		? new Error("Factory evidence is unreadable without recovering a hot SQLite journal; read-only inspection left it intact", { cause: error })
		: error;
}

function ensureCurrentSchema(db: DatabaseSync): void {
	ensureV7Schema(db);
	if (schemaVersion(db) === 7) {
		migrateRequestMailboxes(db);
		db.exec("PRAGMA user_version = 8");
	}
	if (schemaVersion(db) === 8) db.exec(`${DIRECTION_DELIVERY_TABLE_SQL}\nPRAGMA user_version = 9;`);
	if (schemaVersion(db) === 9) {
		// No v9 definition could offer a route. Do not synthesize authority from old answers.
		db.exec(`${DIRECTION_APPROVAL_TABLE_SQL}\nPRAGMA user_version = 10;`);
	}
	// schemaVersion checks all required v10 request tables before allowing this upgrade.
	if (schemaVersion(db) === 10) db.exec(`${REVISION_ESCALATION_TABLE_SQL}\nPRAGMA user_version = 11;`);
}

function ensureV4Schema(db: DatabaseSync): SchemaVer {
	const prior = ensureV2Schema(db);
	const current = schemaVersion(db);
	if (current === 2) {
		db.exec(`
			${ATTEMPT_TABLE_SQL}
			${FACTORY_HOLD_TABLE_SQL}
			PRAGMA user_version = 4;
		`);
	}
	return prior;
}

/** Version 6 adds the human-direction request and fence tables; workers never create them. */
function ensureV6Schema(db: DatabaseSync): SchemaVer {
	const prior = ensureV5Schema(db);
	if (schemaVersion(db) === 5) db.exec(`${REQUEST_TABLE_SQL}\nPRAGMA user_version = 6;`);
	return prior;
}

function ensureV5Schema(db: DatabaseSync): SchemaVer {
	const prior = ensureV4Schema(db);
	const current = schemaVersion(db);
	if (current === 4) {
		const existingFactories = db.prepare("SELECT factory_id, name, definition, digest FROM factories").all() as StoredFactory[];
		for (const row of existingFactories) verifyStoredFactory(row);
		db.exec(`
			${FACTORY_VERSION_TABLE_SQL}
			${FACTORY_POINTER_TABLE_SQL}
			PRAGMA user_version = 5;
		`);
		const nowIso = new Date().toISOString();
		const insertVersion = db.prepare(
			"INSERT INTO factory_versions (factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const insertPointer = db.prepare(
			"INSERT INTO factory_pointers (factory_id, current_version, current_version_num, definition_digest, updated_at, record_digest) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const row of existingFactories) {
			const v1 = buildFactoryVersionRow({
				factory_id: row.factory_id,
				version: "v1",
				version_num: 1,
				definition: row.definition,
				digest: row.digest,
				restored_from_version: null,
				created_at: nowIso,
			});
			insertVersion.run(v1.factory_id, v1.version, v1.version_num, v1.definition, v1.digest, v1.restored_from_version, v1.created_at, v1.record_digest);
			const ptr = buildFactoryPointerRow({
				factory_id: row.factory_id,
				current_version: "v1",
				current_version_num: 1,
				definition_digest: row.digest,
				updated_at: nowIso,
			});
			insertPointer.run(ptr.factory_id, ptr.current_version, ptr.current_version_num, ptr.definition_digest, ptr.updated_at, ptr.record_digest);
		}
	}
	return prior;
}

function verifyDefinitionJson(factoryId: string, definitionJson: string, expectedDigest: string, versionLabel = "v1"): Definition {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(definitionJson) !== expectedDigest) {
		throw new Error(`Factory storage corruption detected for ${factoryId} (${versionLabel}): definition digest mismatch`);
	}
	let definition: unknown;
	try { definition = JSON.parse(definitionJson); }
	catch { throw new Error(`Factory storage corruption detected for ${factoryId} (${versionLabel}): invalid definition JSON`); }
	if (!definition || typeof definition !== "object" || Array.isArray(definition) || (definition as Record<string, unknown>).topology === undefined || !Array.isArray((definition as Record<string, unknown>).agents)) {
		throw new Error(`Factory storage corruption detected for ${factoryId} (${versionLabel}): invalid ${versionLabel} definition envelope`);
	}
	return definition as Definition;
}

function verifyStoredFactory(row: StoredFactory): Definition {
	return verifyDefinitionJson(row.factory_id, row.definition, row.digest, "v1");
}

function selectPointer(db: DatabaseSync, factoryId: string): StoredFactoryPointer | undefined {
	return db.prepare(
		"SELECT factory_id, current_version, current_version_num, definition_digest, updated_at, record_digest FROM factory_pointers WHERE factory_id = ?",
	).get(factoryId) as StoredFactoryPointer | undefined;
}

function verifyPointerRow(row: StoredFactoryPointer | undefined, identity: Identity): StoredFactoryPointer {
	if (!row) {
		throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing current version pointer evidence`);
	}
	return validateFactoryPointerRow(row);
}

interface VerifiedVersionCatalog {
	currentVersion: string;
	currentNum: number;
	currentDefinition: Definition;
	versions: FactoryVersionSummary[];
	definitionsByVersion: Map<string, Definition>;
	rawByVersion: Map<string, { definition: string; digest: string }>;
	versionErrors: Map<string, string>;
}

function loadFactoryVersionCatalog(
	db: DatabaseSync,
	schemaVer: SchemaVer,
	factoryRow: StoredFactory,
	options: { strictHistory?: boolean; currentVersion?: string } = {},
): VerifiedVersionCatalog {
	const v1Def = verifyStoredFactory(factoryRow);
	if (schemaVer < 5) {
		return {
			currentVersion: "v1",
			currentNum: 1,
			currentDefinition: v1Def,
			versions: [{ version: "v1", digest: factoryRow.digest, created_at: null, restored_from_version: null }],
			definitionsByVersion: new Map([["v1", v1Def]]),
			rawByVersion: new Map([["v1", { definition: factoryRow.definition, digest: factoryRow.digest }]]),
			versionErrors: new Map(),
		};
	}

	const pointer = verifyPointerRow(selectPointer(db, factoryRow.factory_id), factoryRow);
	const rows = db.prepare(
		"SELECT factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest FROM factory_versions WHERE factory_id = ? ORDER BY version_num ASC",
	).all(factoryRow.factory_id) as StoredFactoryVersion[];

	const definitionsByVersion = new Map<string, Definition>();
	const rawByVersion = new Map<string, { definition: string; digest: string }>();
	const versionErrors = new Map<string, string>();
	const rowByNum = new Map<number, StoredFactoryVersion>();

	for (const row of rows) {
		if (rowByNum.has(row.version_num)) {
			throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): duplicate version number ${row.version_num}`);
		}
		rowByNum.set(row.version_num, row);
	}

	if (rows.some(row => row.version_num > pointer.current_version_num)) {
		throw new Error(
			`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): version history exceeds current pointer ${pointer.current_version}`,
		);
	}

	const versions: FactoryVersionSummary[] = [];
	for (let num = 1; num <= pointer.current_version_num; num++) {
		const ver = `v${num}`;
		const row = rowByNum.get(num);
		if (!row) {
			const msg = `Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): missing retained version ${ver}`;
			if (options.strictHistory !== false || num === pointer.current_version_num) {
				throw new Error(msg);
			}
			versionErrors.set(ver, msg);
			versions.push({ version: ver, digest: "", created_at: null, restored_from_version: null, corrupt_reason: msg });
			continue;
		}
		try {
			validateFactoryVersionRow(row);
			if (num === 1 && (row.definition !== factoryRow.definition || row.digest !== factoryRow.digest)) {
				throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): v1 payload contradicts factories record`);
			}
			const parsed = verifyDefinitionJson(factoryRow.factory_id, row.definition, row.digest, ver);
			if (num === pointer.current_version_num && row.digest !== pointer.definition_digest) {
				throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): current pointer digest mismatch for ${ver}`);
			}
			definitionsByVersion.set(ver, parsed);
			rawByVersion.set(ver, { definition: row.definition, digest: row.digest });
			versions.push({
				version: row.version,
				digest: row.digest,
				created_at: row.created_at,
				restored_from_version: row.restored_from_version,
			});
		} catch (error) {
			const msg = errorMessage(error);
			if (options.strictHistory !== false || num === pointer.current_version_num) {
				throw error;
			}
			versionErrors.set(ver, msg);
			versions.push({
				version: row.version,
				digest: row.digest,
				created_at: row.created_at,
				restored_from_version: row.restored_from_version,
				corrupt_reason: msg,
			});
		}
	}

	const currentDefinition = definitionsByVersion.get(pointer.current_version);
	if (!currentDefinition) {
		throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): missing current version ${pointer.current_version}`);
	}
	return {
		currentVersion: pointer.current_version,
		currentNum: pointer.current_version_num,
		currentDefinition,
		versions,
		definitionsByVersion,
		rawByVersion,
		versionErrors,
	};
}

/**
 * Read-only view of the version history when the current pointer or the current version's row may be damaged.
 * Retained versions are verified independently, so a bound version that is intact stays readable; the current
 * version is reported as unknown (`currentVersion` absent) or unreadable (`currentError`) instead of throwing,
 * and is never inferred from the bound version or any other surviving row.
 */
type ReadCatalog = Omit<VerifiedVersionCatalog, "currentVersion" | "currentNum" | "currentDefinition"> & {
	currentVersion?: string;
	currentNum?: number;
	currentDefinition?: Definition;
	/** Why the current pointer or the current version's definition cannot be verified. */
	currentError?: string;
};

function loadReadCatalog(db: DatabaseSync, schemaVer: SchemaVer, factoryRow: StoredFactory): ReadCatalog {
	try {
		return loadFactoryVersionCatalog(db, schemaVer, factoryRow, { strictHistory: false });
	} catch (strictError) {
		// Only schema 5 has a pointer and version rows; a damaged factory record or earlier schema stays an error.
		if (schemaVer < 5) throw strictError;
		verifyStoredFactory(factoryRow);
		let pointer: StoredFactoryPointer | undefined;
		let pointerError: string | undefined;
		try { pointer = verifyPointerRow(selectPointer(db, factoryRow.factory_id), factoryRow); }
		catch (error) { pointerError = errorMessage(error); }
		const rows = db.prepare(
			"SELECT factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest FROM factory_versions WHERE factory_id = ? ORDER BY version_num ASC",
		).all(factoryRow.factory_id) as StoredFactoryVersion[];
		const rowByNum = new Map<number, StoredFactoryVersion>();
		for (const row of rows) {
			if (rowByNum.has(row.version_num)) throw strictError;
			rowByNum.set(row.version_num, row);
		}
		// Structural contradictions (history beyond the pointer) are not something to read around.
		if (pointer && rows.some(row => row.version_num > pointer!.current_version_num)) throw strictError;
		const last = pointer ? pointer.current_version_num : Math.max(0, ...rows.map(row => row.version_num));
		const definitionsByVersion = new Map<string, Definition>();
		const rawByVersion = new Map<string, { definition: string; digest: string }>();
		const versionErrors = new Map<string, string>();
		const versions: FactoryVersionSummary[] = [];
		for (let num = 1; num <= last; num++) {
			const ver = `v${num}`;
			const row = rowByNum.get(num);
			if (!row) {
				const msg = `Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): missing retained version ${ver}`;
				versionErrors.set(ver, msg);
				versions.push({ version: ver, digest: "", created_at: null, restored_from_version: null, corrupt_reason: msg });
				continue;
			}
			try {
				validateFactoryVersionRow(row);
				if (num === 1 && (row.definition !== factoryRow.definition || row.digest !== factoryRow.digest)) {
					throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): v1 payload contradicts factories record`);
				}
				const parsed = verifyDefinitionJson(factoryRow.factory_id, row.definition, row.digest, ver);
				if (pointer && num === pointer.current_version_num && row.digest !== pointer.definition_digest) {
					throw new Error(`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): current pointer digest mismatch for ${ver}`);
				}
				definitionsByVersion.set(ver, parsed);
				rawByVersion.set(ver, { definition: row.definition, digest: row.digest });
				versions.push({ version: row.version, digest: row.digest, created_at: row.created_at, restored_from_version: row.restored_from_version });
			} catch (error) {
				const msg = errorMessage(error);
				versionErrors.set(ver, msg);
				versions.push({ version: row.version, digest: row.digest, created_at: row.created_at, restored_from_version: row.restored_from_version, corrupt_reason: msg });
			}
		}
		const currentDefinition = pointer ? definitionsByVersion.get(pointer.current_version) : undefined;
		const currentError = pointer
			? (currentDefinition ? undefined : versionErrors.get(pointer.current_version))
			: `Current version pointer cannot be verified: ${pointerError}`;
		// Nothing readable explains the strict failure: do not paper over it.
		if (!currentError) throw strictError;
		return {
			...(pointer ? { currentVersion: pointer.current_version, currentNum: pointer.current_version_num } : {}),
			...(currentDefinition ? { currentDefinition } : {}),
			currentError,
			versions,
			definitionsByVersion,
			rawByVersion,
			versionErrors,
		};
	}
}

/** Resolve the exact retained definition an input is bound to. Never substitutes the current or any other version. */
function resolveBoundVersion(
	catalog: Pick<ReadCatalog, "definitionsByVersion" | "rawByVersion" | "versionErrors">,
	identity: Identity,
	boundVersion: string,
): { definition?: Definition; raw?: { definition: string; digest: string }; error?: string } {
	const definition = catalog.definitionsByVersion.get(boundVersion);
	const raw = catalog.rawByVersion.get(boundVersion);
	if (definition && raw) return { definition, raw };
	return {
		error: catalog.versionErrors.get(boundVersion)
			?? `Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): bound version ${boundVersion} is not retained`,
	};
}

/** Run controls and release gates also accept legacy runs, without migrating their storage. */
function assertLaunchStorageSchema(db: DatabaseSync, gate: string): 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 {
	const version = schemaVersion(db);
	if (version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11) throw new Error(`Factory storage version mismatch at ${gate}`);
	return version;
}

function verifyBoundVersionAtGate(
	db: DatabaseSync,
	schemaVer: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
	factoryRow: StoredFactory,
	boundVersion: string,
	checkout: string,
	gate: string,
): void {
	const catalog = loadFactoryVersionCatalog(db, schemaVer, factoryRow, { strictHistory: false });
	const bound = resolveBoundVersion(catalog, factoryRow, boundVersion);
	if (!bound.definition) throw new Error(`${bound.error} (${gate})`);
	if (bound.definition.project_cwd !== checkout) {
		throw new Error(`Bound version ${boundVersion} checkout contradicts the reserved checkout at ${gate}`);
	}
}

function bindingView(
	request: { bound_version: string },
	row: StoredFactory,
	catalog: ReadCatalog | undefined,
	catalogError: string | undefined,
): BindingView {
	const boundVersion = parseVersionToken(request.bound_version, "bound_version").version;
	const base = { factory_id: row.factory_id, factory_name: row.name, bound_version: boundVersion, runtime_assumptions: FACTORY_RUNTIME_ASSUMPTIONS };
	if (!catalog) return { ...base, bound_retained: false, error: catalogError ?? "Factory version evidence is unavailable" };
	const bound = resolveBoundVersion(catalog, row, boundVersion);
	return {
		...base,
		// Absent when the pointer is damaged; present with `current_error` when only the current version's definition is.
		...(catalog.currentVersion !== undefined ? { current_version: catalog.currentVersion, bound_matches_current: catalog.currentVersion === boundVersion } : {}),
		...(catalog.currentError ? { current_error: catalog.currentError } : {}),
		bound_retained: Boolean(bound.definition),
		...(bound.error ? { error: bound.error } : {}),
		...(bound.definition ? { node_policies: summarizeNodePolicies(bound.definition) } : {}),
	};
}

function verifyManagerRow(row: StoredManager): void {
	if (!/^[a-f0-9]{64}$/.test(row.authority_digest) || !/^[a-f0-9]{64}$/.test(row.record_digest) || managerRecordDigest(row) !== row.record_digest) {
		throw new Error(`Factory storage corruption detected for ${row.factory_id}: manager authority evidence mismatch`);
	}
}

function verifyInputRow(row: StoredInput, currentVersion?: string): InputReceipt {
	const validated = validateInputRow(row);
	return {
		factory_id: validated.factory_id,
		input_id: validated.input_id,
		reference: validated.reference,
		bound_version: validated.bound_version,
		...(currentVersion !== undefined ? { current_version: currentVersion } : {}),
		disposition: validated.disposition as InputDisposition,
		queue_position: validated.queue_position,
		brief: validated.brief,
		brief_bytes: validated.brief_bytes,
		accepted_at: validated.accepted_at,
	};
}

function verifyAttemptRow(row: StoredAttempt, currentVersion?: string): AttemptSummary {
	const validated = validateAttemptRow(row);
	return {
		attempt_id: validated.attempt_id,
		factory_id: validated.factory_id,
		input_id: validated.input_id,
		bound_version: validated.bound_version,
		...(currentVersion !== undefined ? { current_version: currentVersion } : {}),
		request_id: validated.request_id,
		task_id: validated.task_id,
		canonical_checkout: validated.canonical_checkout,
		state: validated.state,
		release_authorized: validated.release_authorized === 1,
		release_authorized_at: validated.release_authorized_at,
		error: validated.state === "settled" || validated.state === "cleared" ? null : validated.error,
		...(validated.state === "settled" && decodeSettlement(validated.error) ? { settlement: decodeSettlement(validated.error)! } : {}),
		...(validated.state === "cleared" && decodeClearance(validated.error) ? { clearance: decodeClearance(validated.error)! } : {}),
		...(validated.state === "proven_not_released" ? {
			non_release_proof: { status: "proven" as const, reason: validated.error ?? "release permission was never committed" },
			retry_eligibility: { eligible: true, reason: "attempt is durably fenced from release" },
		} : {
			non_release_proof: { status: "not_proven" as const, reason: validated.release_authorized === 1 ? "release permission was committed" : "authoritative non-release evidence is incomplete" },
			retry_eligibility: { eligible: false, reason: validated.release_authorized === 1 ? "release permission was committed" : "authoritative non-release evidence is incomplete" },
		}),
		created_at: validated.created_at,
		updated_at: validated.updated_at,
	};
}

const verifyFactoryHoldRow = validateFactoryHoldRow;
const verifyCheckoutHoldRow = validateCheckoutHoldRow;
const verifyManagedRunRow = validateManagedRunRow;

function verifyStateRow(row: StoredState | undefined, identity: Identity): StoredState {
	if (!row) {
		throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing factory state evidence`);
	}
	if (
		(row.established !== 0 && row.established !== 1)
		|| !Number.isInteger(row.last_input_position)
		|| row.last_input_position < 0
		|| !/^[a-f0-9]{64}$/.test(row.record_digest)
		|| stateRecordDigest(row) !== row.record_digest
	) {
		throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): factory state evidence mismatch`);
	}
	return row;
}

function verifyEstablishedState(
	identity: Identity,
	state: StoredState | undefined,
	manager: StoredManager | undefined,
	hasInputs: boolean,
): { state: StoredState; manager: StoredManager | undefined } {
	const verifiedState = verifyStateRow(state, identity);
	if (verifiedState.established === 0) {
		if (manager) {
			throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): manager record exists for unmanaged factory state`);
		}
		if (verifiedState.last_input_position !== 0 || hasInputs) {
			throw new Error(`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): accepted input evidence exists for unmanaged factory state`);
		}
		return { state: verifiedState, manager: undefined };
	}
	if (!manager) {
		throw missingManagerCorruptionError(identity);
	}
	verifyManagerRow(manager);
	return { state: verifiedState, manager };
}

function verifyQueueCompleteness(identity: Identity, inputs: StoredInput[], lastInputPosition: number, currentVersion?: string): InputReceipt[] {
	const verified = inputs.map(row => verifyInputRow(row, currentVersion));
	if (verified.length !== lastInputPosition) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): expected ${lastInputPosition} contiguous queued inputs, found ${verified.length}`,
		);
	}
	for (let i = 0; i < verified.length; i++) {
		if (verified[i]!.queue_position !== i + 1) {
			throw new Error(
				`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing or non-contiguous queue position ${i + 1}`,
			);
		}
	}
	return verified;
}

/** Active attempts are not waiting, except for a proven non-release that still needs explicit retry. */
function waitingInputs<T extends Pick<StoredInput, "input_id" | "disposition">>(inputs: readonly T[], attempts: readonly Pick<AttemptSummary, "input_id" | "state">[]): T[] {
	const latestState = new Map(attempts.map(attempt => [attempt.input_id, attempt.state]));
	return inputs.filter(input => QUEUED_DISPOSITIONS.has(input.disposition) || (input.disposition === "launching" && latestState.get(input.input_id) === "proven_not_released"));
}

/** The earliest waiting input keeps its place even if blocked or awaiting retry. */
function firstWaitingInput<T extends Pick<StoredInput, "input_id" | "disposition" | "queue_position">>(inputs: readonly T[], attempts: readonly Pick<AttemptSummary, "input_id" | "state">[]): T | undefined {
	return waitingInputs(inputs, attempts).reduce<T | undefined>((head, input) => !head || input.queue_position < head.queue_position ? input : head, undefined);
}

function queueOccupancy(inputs: readonly Pick<StoredInput, "input_id" | "disposition">[], attempts: readonly Pick<AttemptSummary, "input_id" | "state">[]): number {
	const latestState = new Map<string, string>();
	for (const attempt of attempts) latestState.set(attempt.input_id, attempt.state);
	return inputs.filter(input => QUEUED_DISPOSITIONS.has(input.disposition) || (input.disposition === "launching" && ["reserved", "failed_before_release", "proven_not_released"].includes(latestState.get(input.input_id) ?? ""))).length;
}

function verifyQueueSummary(
	identity: Identity,
	lastInputPosition: number,
	inputCount: number,
	minPos: number,
	maxPos: number,
): void {
	if (inputCount !== lastInputPosition) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): expected ${lastInputPosition} queued inputs, found ${inputCount}`,
		);
	}
	if (lastInputPosition > 0 && (minPos !== 1 || maxPos !== lastInputPosition)) {
		throw new Error(
			`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): missing or out-of-range queue positions (expected 1..${lastInputPosition}, got ${minPos}..${maxPos})`,
		);
	}
}

function insertInitialControl(db: DatabaseSync, factoryId: string, timestamp: string): void {
	const digest = sha256Hex(JSON.stringify([factoryId, false, timestamp]));
	try {
		db.prepare("INSERT INTO factory_controls (factory_id, stopped, updated_at, record_digest) VALUES (?, 0, ?, ?)").run(factoryId, timestamp, digest);
	} catch (cause) {
		throw new Error(`Could not initialize factory control evidence for ${factoryId}; no changes committed`, { cause });
	}
}

function isFactoryStopped(db: DatabaseSync, factoryId: string, version: SchemaVer = 7): boolean {
	if (!hasTable(db, "factory_controls")) {
		// Read-only legacy preflight/inspection sees the state that migration will initialize.
		if (version < 7) return false;
		throw new Error(`Factory control table is missing for ${factoryId}; refusing admission and launch`);
	}
	const row = db.prepare("SELECT stopped, updated_at, record_digest FROM factory_controls WHERE factory_id = ?").get(factoryId) as { stopped: number; updated_at: string; record_digest: string } | undefined;
	if (!row) throw new Error(`Factory control record for ${factoryId} is missing; refusing admission and launch`);
	if ((row.stopped !== 0 && row.stopped !== 1) || sha256Hex(JSON.stringify([factoryId, row.stopped === 1, row.updated_at])) !== row.record_digest) throw new Error(`Factory control record for ${factoryId} is damaged; refusing admission and launch`);
	return row.stopped === 1;
}

function setFactoryStopped(db: DatabaseSync, factoryId: string, stopped: boolean): void {
	if (isFactoryStopped(db, factoryId) === stopped) return;
	const updatedAt = new Date().toISOString();
	const digest = sha256Hex(JSON.stringify([factoryId, stopped, updatedAt]));
	db.prepare("UPDATE factory_controls SET stopped=?, updated_at=?, record_digest=? WHERE factory_id=?").run(Number(stopped), updatedAt, digest, factoryId);
}

function selectState(db: DatabaseSync, factoryId: string): StoredState | undefined {
	return db.prepare(
		"SELECT factory_id, established, last_input_position, record_digest FROM factory_state WHERE factory_id = ?",
	).get(factoryId) as StoredState | undefined;
}

function selectManager(db: DatabaseSync, factoryId: string): StoredManager | undefined {
	return db.prepare(
		"SELECT factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest FROM factory_managers WHERE factory_id = ?",
	).get(factoryId) as StoredManager | undefined;
}

function hasAcceptedInputs(db: DatabaseSync, factoryId: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM factory_inputs WHERE factory_id = ? LIMIT 1").get(factoryId));
}

function missingManagerCorruptionError(identity: Identity): Error {
	return new Error(
		`Factory storage corruption detected for "${identity.name}" (${identity.factory_id}): established management evidence exists without a manager record; refusing takeover or mutation. Recover valid receipts read-only with /factory receipt ${identity.factory_id} <reference>`,
	);
}

function databaseExists(path: string): boolean {
	try {
		if (!statSync(path).isFile()) throw new Error(`Not a factory database file: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function openWritableDb(path: string, createIfMissing: boolean): DatabaseSync | undefined {
	assertNoSymlinkComponents(path);
	if (createIfMissing) {
		// Do not depend on the umask for definitions containing private project instructions.
		createDurableDirectory(dirname(path));
		try { closeSync(openSync(path, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !databaseExists(path)) throw error; }
		syncDirectory(dirname(path));
	} else if (!databaseExists(path)) {
		return undefined;
	}
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON");
		if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 3) throw new Error("Factory storage requires SQLite synchronous=EXTRA");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function authorityMatches(row: StoredManager, record: AuthorityRecord): boolean {
	return (
		!record.revoked
		&& row.incarnation_id === record.incarnation_id
		&& row.authority_digest === record.secret_digest
		&& row.pi_session_id === record.pi_session_id
		&& row.pi_session_file === record.pi_session_file
		&& row.pid === record.pid
	);
}

function openWritableWithCoord(mainPath: string, coordPath: string, allowMissingCoordInit = false): DatabaseSync {
	assertNoSymlinkComponents(mainPath);
	assertNoSymlinkComponents(coordPath);
	if (!databaseExists(coordPath)) {
		const existingAnchor = readAnchorFile(coordPath);
		if (existingAnchor?.state === "committed") {
			throw new Error("Factory coordination database is missing despite prior initialization continuity anchor");
		}
		if (!allowMissingCoordInit) {
			throw new Error("Factory coordination database is missing");
		}
	}
	for (const dbPath of [mainPath, coordPath]) {
		createDurableDirectory(dirname(dbPath));
		try { closeSync(openSync(dbPath, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !databaseExists(dbPath)) throw error; }
		syncDirectory(dirname(dbPath));
	}
	const db = new DatabaseSync(mainPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA main.synchronous = EXTRA; PRAGMA foreign_keys = ON");
		db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
		db.exec("PRAGMA coord.synchronous = EXTRA");
		if (db.prepare("PRAGMA main.journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA coord.journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory coordination storage requires SQLite DELETE journal mode");
		if (db.prepare("PRAGMA main.synchronous").get()?.synchronous !== 3) throw new Error("Factory storage requires SQLite synchronous=EXTRA");
		if (db.prepare("PRAGMA coord.synchronous").get()?.synchronous !== 3) throw new Error("Factory coordination storage requires SQLite synchronous=EXTRA");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function selectAttemptsWithTokens(db: DatabaseSync, factoryId: string, currentVersion?: string): {
	attempts: AttemptSummary[];
	tokenDigests: Map<string, string | null>;
	nonceDigests: Map<string, string | null>;
	checkoutKeys: Map<string, string>;
} {
	const rows = db.prepare(
		`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
			release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
		FROM factory_attempts WHERE factory_id = ? ORDER BY created_at ASC, rowid ASC`,
	).all(factoryId) as StoredAttempt[];
	const tokenDigests = new Map<string, string | null>();
	const nonceDigests = new Map<string, string | null>();
	const checkoutKeys = new Map<string, string>();
	const attempts = rows.map(row => {
		const summaryRow = verifyAttemptRow(row, currentVersion);
		tokenDigests.set(row.attempt_id, row.release_token_digest);
		nonceDigests.set(row.attempt_id, row.release_nonce_digest);
		checkoutKeys.set(row.attempt_id, row.checkout_key);
		return summaryRow;
	});
	return { attempts, tokenDigests, nonceDigests, checkoutKeys };
}

function hasConsistentUnreleasedHoldBinding(params: {
	attempt: Pick<StoredAttempt, "attempt_id" | "input_id" | "bound_version" | "request_id" | "task_id" | "canonical_checkout" | "checkout_key" | "release_authorized" | "release_authorized_at" | "release_token_digest" | "release_nonce_digest">;
	input: InputReceipt;
	fHold: StoredFactoryHold | undefined;
	cHold: StoredCheckoutHold | undefined;
	mRun: StoredManagedRun | undefined;
	factoryId: string;
	factoryName: string;
	canonicalDb: string;
	expectedHoldState: "reserved" | "failed_before_release";
}): boolean {
	const { attempt, input, fHold, cHold, mRun, factoryId, factoryName, canonicalDb, expectedHoldState } = params;
	return Boolean(
		attempt.release_authorized === 0
		&& attempt.release_authorized_at === null
		&& attempt.release_token_digest === null
		&& attempt.release_nonce_digest === null
		&& input.factory_id === factoryId
		&& input.bound_version === attempt.bound_version
		&& input.disposition === "launching"
		&& fHold && cHold && mRun
		&& fHold.state === expectedHoldState
		&& cHold.state === expectedHoldState
		&& fHold.attempt_id === attempt.attempt_id
		&& fHold.input_id === attempt.input_id
		&& fHold.request_id === attempt.request_id
		&& fHold.task_id === attempt.task_id
		&& cHold.attempt_id === attempt.attempt_id
		&& cHold.input_id === attempt.input_id
		&& cHold.request_id === attempt.request_id
		&& cHold.task_id === attempt.task_id
		&& cHold.factory_id === factoryId
		&& cHold.factory_name === factoryName
		&& cHold.factory_db_path === canonicalDb
		&& cHold.canonical_checkout === attempt.canonical_checkout
		&& cHold.checkout_key === attempt.checkout_key
		&& mRun.attempt_id === attempt.attempt_id
		&& mRun.factory_id === factoryId
		&& mRun.factory_name === factoryName
		&& mRun.factory_db_path === canonicalDb
		&& mRun.input_id === attempt.input_id
		&& mRun.request_id_digest === digest(attempt.request_id)
		&& mRun.canonical_checkout === attempt.canonical_checkout
		&& mRun.checkout_key === attempt.checkout_key
	);
}

function verifyTerminallySupersededRunRowInDb(
	db: DatabaseSync,
	runRow: StoredManagedRun,
	factoryName: string,
	factoryDbPath: string,
	coordDbPath: string,
	bootstrap: NonReleaseEvidenceReader,
): boolean {
	try {
		const raw = db.prepare(
			`SELECT rowid, attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
				release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
			FROM main.factory_attempts WHERE attempt_id = ?`,
		).get(runRow.attempt_id) as StoredAttemptWithRowId | undefined;
		if (!raw) return false;
		const attempt = validateAttemptRow(raw);
		if (
			attempt.factory_id !== runRow.factory_id
			|| attempt.input_id !== runRow.input_id
			|| attempt.task_id !== runRow.task_id
			|| attempt.canonical_checkout !== runRow.canonical_checkout
			|| attempt.checkout_key !== runRow.checkout_key
			|| runRow.factory_name !== factoryName
			|| runRow.factory_db_path !== factoryDbPath
			|| runRow.request_id_digest !== digest(attempt.request_id)
		) {
			return false;
		}
		const inputRaw = db.prepare(
			"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM main.factory_inputs WHERE input_id = ?",
		).get(attempt.input_id) as StoredInput | undefined;
		if (!inputRaw) return false;
		const inputRow = validateInputRow(inputRaw);
		const meta: FactoryManagedInfo = {
			version: 1,
			factory_id: runRow.factory_id,
			factory_name: factoryName,
			input_id: attempt.input_id,
			attempt_id: attempt.attempt_id,
			request_id: attempt.request_id,
			bound_version: attempt.bound_version,
			canonical_checkout: attempt.canonical_checkout,
			checkout_key: attempt.checkout_key,
			state_db_path: factoryDbPath,
			coord_db_path: coordDbPath,
		};
		if (!bootstrap.validateFactoryNonReleaseEvidence) return false;
		const res = verifyTerminallySupersededNonReleaseAttempt({ db, attempt: raw, inputRow, meta });
		return res.matched && res.ok;
	} catch {
		return false;
	}
}

function retireSupersededNonReleaseManagedRuns(
	db: DatabaseSync,
	params: {
		factoryId: string;
		factoryName: string;
		factoryDbPath: string;
		coordDbPath: string;
		bootstrap: NonReleaseEvidenceReader;
		inputId?: string;
	},
): { retired: number; kept: RetirementDiagnostic[] } {
	const { factoryId, factoryName, factoryDbPath, coordDbPath, bootstrap, inputId } = params;
	const rows = (inputId !== undefined
		? db.prepare(
			`SELECT rowid, attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
				release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
			FROM main.factory_attempts WHERE factory_id = ? AND input_id = ? AND state = 'proven_not_released' ORDER BY created_at ASC, rowid ASC`,
		).all(factoryId, inputId)
		: db.prepare(
			`SELECT rowid, attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
				release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
			FROM main.factory_attempts WHERE factory_id = ? AND state = 'proven_not_released' ORDER BY created_at ASC, rowid ASC`,
		).all(factoryId)) as StoredAttemptWithRowId[];
	let retired = 0;
	const kept: RetirementDiagnostic[] = [];
	const recordKeptIfRowExists = (attemptId: string, taskId: string, reason: string) => {
		try {
			if (db.prepare("SELECT 1 AS x FROM coord.managed_runs WHERE task_id = ? OR attempt_id = ? LIMIT 1").get(taskId, attemptId)) {
				kept.push({ attempt_id: attemptId, task_id: taskId, reason });
			}
		} catch {
			kept.push({ attempt_id: attemptId, task_id: taskId, reason });
		}
	};
	for (const raw of rows) {
		try {
			const attempt = validateAttemptRow(raw);
			if (!bootstrap.validateFactoryNonReleaseEvidence) {
				recordKeptIfRowExists(attempt.attempt_id, attempt.task_id, "Authoritative non-release evidence reader is unavailable");
				continue;
			}
			const inputRaw = db.prepare(
				"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM main.factory_inputs WHERE input_id = ?",
			).get(attempt.input_id) as StoredInput | undefined;
			if (!inputRaw) {
				recordKeptIfRowExists(attempt.attempt_id, attempt.task_id, `Input ${attempt.input_id} is missing`);
				continue;
			}
			const inputRow = validateInputRow(inputRaw);
			const meta: FactoryManagedInfo = {
				version: 1,
				factory_id: factoryId,
				factory_name: factoryName,
				input_id: attempt.input_id,
				attempt_id: attempt.attempt_id,
				request_id: attempt.request_id,
				bound_version: attempt.bound_version,
				canonical_checkout: attempt.canonical_checkout,
				checkout_key: attempt.checkout_key,
				state_db_path: factoryDbPath,
				coord_db_path: coordDbPath,
			};
			const res = verifyTerminallySupersededNonReleaseAttempt({ db, attempt: raw, inputRow, meta });
			if (!res.matched) {
				recordKeptIfRowExists(attempt.attempt_id, attempt.task_id, `Attempt ${attempt.attempt_id} has no later terminal sibling`);
				continue;
			}
			if (!res.ok) {
				recordKeptIfRowExists(attempt.attempt_id, attempt.task_id, res.reason);
				continue;
			}
			if (!res.managedRunPresent) continue;
			const deleted = db.prepare("DELETE FROM coord.managed_runs WHERE task_id = ? AND attempt_id = ?").run(attempt.task_id, attempt.attempt_id);
			if (Number(deleted.changes) > 0) retired += Number(deleted.changes);
		} catch (error) {
			recordKeptIfRowExists(raw.attempt_id, raw.task_id, errorMessage(error));
		}
	}
	return { retired, kept };
}

function hasUnretiredSupersededManagedRun(factoryDbPath: string, coordPath: string, factoryId: string): boolean {
	if (!databaseExists(factoryDbPath) || !databaseExists(coordPath)) return false;
	assertNoSymlinkComponents(factoryDbPath);
	assertNoSymlinkComponents(coordPath);
	const db = new DatabaseSync(factoryDbPath, { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
		db.exec("PRAGMA query_only = ON; BEGIN");
		if (schemaVersion(db) < 4 || Number(db.prepare("PRAGMA coord.user_version").get()?.user_version) !== 2) return false;
		return Boolean(db.prepare(
			`SELECT 1 AS x FROM coord.managed_runs m
			JOIN main.factory_attempts a ON a.attempt_id = m.attempt_id
			WHERE a.factory_id = ? AND a.state = 'proven_not_released' LIMIT 1`,
		).get(factoryId));
	} catch {
		return false;
	} finally {
		db.close();
	}
}

function reconcileProvenNonRelease(db: DatabaseSync, factoryId: string, factoryDbPath: string, coordPath: string, factoryName: string, bootstrap: BootstrapService): RetirementDiagnostic[] {
	// Takeover is called only after the exact prior manager process is fenced. An intact reserved
	// attempt can therefore be fenced too, but only with its exact run manifest/sidecar, both holds,
	// managed-run association and no release marker. Marker absence alone is never proof.
	const attempts = db.prepare(`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
		release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
		FROM factory_attempts WHERE factory_id = ? AND state IN ('failed_before_release', 'reserved', 'proven_not_released') ORDER BY created_at, rowid`).all(factoryId) as StoredAttempt[];
	if (attempts.length === 0) return [];
	// ATTACH with a write-capable connection creates a missing database. Never let takeover turn
	// lost coordination evidence into an empty store outside rollback.
	assertNoSymlinkComponents(coordPath);
	if (!databaseExists(coordPath)) {
		const anchor = readAnchorFile(coordPath);
		throw new Error(anchor?.state === "committed"
			? "Factory coordination database is missing despite its committed continuity anchor; takeover refused without recreating it"
			: "Factory coordination database is missing for retained attempts; takeover refused without recreating it");
	}
	try {
		db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
		// Direct validated reads: this transaction is only a proof attempt, and any missing or
		// malformed coordination table fails closed without changing its evidence.
		db.prepare("SELECT task_id FROM coord.managed_runs LIMIT 0").all();
		db.prepare("SELECT task_id FROM coord.checkout_holds LIMIT 0").all();
		const continuity = inspectCoordContinuityReadOnly(coordPath, db);
		if (continuity.error) throw new Error(`Cannot prove non-release with invalid coordination continuity: ${continuity.error}`);
		const canonicalCoord = realpathSync(coordPath);
		for (const raw of attempts) {
			if (raw.state === "proven_not_released") continue;
			const attempt = validateAttemptRow(raw);
			const inputRaw = db.prepare("SELECT * FROM factory_inputs WHERE input_id = ?").get(attempt.input_id) as StoredInput | undefined;
			if (!inputRaw) continue;
			const input = validateInputRow(inputRaw);
			const fh = selectFactoryHold(db, factoryId);
			const ch = selectCheckoutHold(db, attempt.canonical_checkout);
			if (!fh || !ch) continue;
			const vf = validateFactoryHoldRow(fh);
			const vc = validateCheckoutHoldRow(ch);
			const run = db.prepare("SELECT * FROM coord.managed_runs WHERE task_id = ?").get(attempt.task_id) as StoredManagedRun | undefined;
			if (!run) continue;
			const verifiedRun = validateManagedRunRow(run);
			if (!hasConsistentUnreleasedHoldBinding({
				attempt,
				input,
				fHold: vf,
				cHold: vc,
				mRun: verifiedRun,
				factoryId,
				factoryName,
				canonicalDb: factoryDbPath,
				expectedHoldState: attempt.state as "reserved" | "failed_before_release",
			})) continue;
			const sessionDir = join(attempt.canonical_checkout, ".pi", "agent-sessions", attempt.task_id);
			const releasePath = join(sessionDir, "release.json");
			// Existing or unreadable release evidence is contradictory/unknown, never repair it.
			try { if (pathEntryExists(releasePath)) continue; } catch { continue; }
			try {
				validateNonReleaseEvidence(attempt, factoryId, factoryName, factoryDbPath, canonicalCoord, bootstrap);
			} catch { continue; }
			const next = buildAttemptRow({ ...attempt, state: "proven_not_released", error: PROVEN_NON_RELEASE_ERROR, updated_at: new Date().toISOString() });
			db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ? AND state = ? AND release_authorized = 0").run(next.state, next.error, next.updated_at, next.record_digest, next.attempt_id, attempt.state);
			const nextFactoryHold = buildFactoryHoldRow({ ...vf, state: "failed_before_release", updated_at: next.updated_at });
			db.prepare("UPDATE factory_holds SET state = ?, updated_at = ?, record_digest = ? WHERE factory_id = ? AND attempt_id = ?").run(nextFactoryHold.state, nextFactoryHold.updated_at, nextFactoryHold.record_digest, factoryId, attempt.attempt_id);
			const nextCheckoutHold = buildCheckoutHoldRow({ ...vc, state: "failed_before_release", updated_at: next.updated_at });
			db.prepare("UPDATE coord.checkout_holds SET state = ?, updated_at = ?, record_digest = ? WHERE canonical_checkout = ? AND attempt_id = ?").run(nextCheckoutHold.state, nextCheckoutHold.updated_at, nextCheckoutHold.record_digest, vc.canonical_checkout, attempt.attempt_id);
		}
		return retireSupersededNonReleaseManagedRuns(db, {
			factoryId,
			factoryName,
			factoryDbPath,
			coordDbPath: canonicalCoord,
			bootstrap,
		}).kept;
	} finally { try { db.exec("DETACH DATABASE coord"); } catch { /* no attachment after a failed attach */ } }
}

type NonReleaseEvidenceReader = Partial<Pick<BootstrapService, "validateFactoryNonReleaseEvidence" | "validateFactoryPreReleaseAbortAndExit">>;

// A reservation can be inspected before Bootstrap writes any files. Once launch has
// failed, its exact persisted state still requires raw evidence even if the local
// manifest (or the whole session directory) has disappeared. This is applicability,
// not proof: only the authoritative evaluator below can establish non-release.
function requiresNonReleaseEvidence(attempt: { release_authorized: boolean | number; state: string; canonical_checkout: string; task_id: string }): boolean {
	return !attempt.release_authorized && (
		attempt.state === "proven_not_released"
		|| attempt.state === "failed_before_release"
		|| pathEntryExists(join(attempt.canonical_checkout, ".pi", "agent-sessions", attempt.task_id, "manifest.json"))
	);
}

function validateNonReleaseEvidence(attempt: Pick<StoredAttempt, "task_id" | "input_id" | "attempt_id" | "request_id" | "bound_version" | "canonical_checkout" | "checkout_key">, factoryId: string, factoryName: string, factoryDbPath: string, coordDbPath: string, bootstrap: NonReleaseEvidenceReader): void {
	if (!bootstrap.validateFactoryNonReleaseEvidence) throw new Error("Authoritative non-release evidence reader is unavailable");
	bootstrap.validateFactoryNonReleaseEvidence(attempt.task_id, { version: 1, factory_id: factoryId, factory_name: factoryName, input_id: attempt.input_id, attempt_id: attempt.attempt_id, request_id: attempt.request_id, bound_version: attempt.bound_version, canonical_checkout: attempt.canonical_checkout, checkout_key: attempt.checkout_key, state_db_path: factoryDbPath, coord_db_path: coordDbPath });
}

function checkSelfSessionPreReleaseNonRelease(
	attempt: Pick<StoredAttempt, "task_id" | "input_id" | "attempt_id" | "request_id" | "bound_version" | "canonical_checkout" | "checkout_key" | "release_authorized" | "release_authorized_at" | "release_token_digest" | "release_nonce_digest">,
	factoryId: string,
	factoryName: string,
	factoryDbPath: string,
	coordDbPath: string,
	bootstrap: NonReleaseEvidenceReader,
): { ok: true } | { ok: false; reason: string } {
	if (attempt.release_authorized !== 0 || attempt.release_authorized_at !== null || attempt.release_token_digest !== null || attempt.release_nonce_digest !== null) {
		return { ok: false, reason: "release permission metadata is present" };
	}
	if (!bootstrap.validateFactoryPreReleaseAbortAndExit) {
		return { ok: false, reason: "pre-release non-release evidence verifier is unavailable" };
	}
	return bootstrap.validateFactoryPreReleaseAbortAndExit(attempt.task_id, {
		version: 1,
		factory_id: factoryId,
		factory_name: factoryName,
		input_id: attempt.input_id,
		attempt_id: attempt.attempt_id,
		request_id: attempt.request_id,
		bound_version: attempt.bound_version,
		canonical_checkout: attempt.canonical_checkout,
		checkout_key: attempt.checkout_key,
		state_db_path: factoryDbPath,
		coord_db_path: coordDbPath,
	});
}

function verifyHistoricalNonReleaseRun(attempt: StoredAttempt, factoryId: string, factoryName: string, factoryDbPath: string, coordDbPath: string, bootstrap: NonReleaseEvidenceReader): void {
	if (attempt.state !== "proven_not_released" || attempt.release_authorized !== 0 || attempt.release_authorized_at !== null || attempt.release_token_digest !== null || attempt.release_nonce_digest !== null || attempt.error !== PROVEN_NON_RELEASE_ERROR) throw new Error(`Attempt ${attempt.attempt_id} is not an exact proven non-release history row`);
	validateNonReleaseEvidence(attempt, factoryId, factoryName, factoryDbPath, coordDbPath, bootstrap);
}

function selectFactoryHold(db: DatabaseSync, factoryId: string): StoredFactoryHold | undefined {
	const row = db.prepare(
		"SELECT factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest FROM factory_holds WHERE factory_id = ?",
	).get(factoryId) as StoredFactoryHold | undefined;
	return row ? verifyFactoryHoldRow(row) : undefined;
}

function selectCheckoutHold(db: DatabaseSync, canonicalCheckout: string): StoredCheckoutHold | undefined {
	const row = db.prepare(
		`SELECT canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE canonical_checkout = ?`,
	).get(canonicalCheckout) as StoredCheckoutHold | undefined;
	return row ? verifyCheckoutHoldRow(row) : undefined;
}

function selectCheckoutHoldsForIdentity(db: DatabaseSync, paths: string[], keys: string[]): StoredCheckoutHold[] {
	const byPath = new Map<string, StoredCheckoutHold>();
	const byPathStmt = db.prepare(
		`SELECT canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE canonical_checkout = ?`,
	);
	const byKeyStmt = db.prepare(
		`SELECT canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE checkout_key = ?`,
	);
	for (const p of new Set(paths)) {
		for (const row of byPathStmt.all(p) as StoredCheckoutHold[]) {
			const verified = verifyCheckoutHoldRow(row);
			byPath.set(verified.canonical_checkout, verified);
		}
	}
	for (const k of new Set(keys)) {
		for (const row of byKeyStmt.all(k) as StoredCheckoutHold[]) {
			const verified = verifyCheckoutHoldRow(row);
			byPath.set(verified.canonical_checkout, verified);
		}
	}
	return [...byPath.values()];
}

function selectCheckoutHoldsForFactory(db: DatabaseSync, factoryId: string, factoryDbPath: string): StoredCheckoutHold[] {
	const rows = db.prepare(
		`SELECT canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
		FROM coord.checkout_holds WHERE factory_id = ? AND factory_db_path = ?`,
	).all(factoryId, factoryDbPath) as StoredCheckoutHold[];
	return rows.map(verifyCheckoutHoldRow);
}

function selectManagedRunsForFactory(db: DatabaseSync, factoryId: string, factoryDbPath: string): StoredManagedRun[] {
	const rows = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
		FROM coord.managed_runs WHERE factory_id = ? AND factory_db_path = ?`,
	).all(factoryId, factoryDbPath) as StoredManagedRun[];
	return rows.map(verifyManagedRunRow);
}

function selectManagedRunsForCheckout(db: DatabaseSync, canonicalCheckout: string): StoredManagedRun[] {
	const rows = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
		FROM coord.managed_runs WHERE canonical_checkout = ? ORDER BY created_at ASC, rowid ASC`,
	).all(canonicalCheckout) as StoredManagedRun[];
	return rows.map(verifyManagedRunRow);
}

function selectManagedRunsForCheckoutKey(db: DatabaseSync, checkoutKey: string): StoredManagedRun[] {
	const rows = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
		FROM coord.managed_runs WHERE checkout_key = ? ORDER BY created_at ASC, rowid ASC`,
	).all(checkoutKey) as StoredManagedRun[];
	return rows.map(verifyManagedRunRow);
}

function selectManagedRunByTaskId(db: DatabaseSync, taskId: string): StoredManagedRun | undefined {
	const row = db.prepare(
		`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
		FROM coord.managed_runs WHERE task_id = ?`,
	).get(taskId) as StoredManagedRun | undefined;
	return row ? verifyManagedRunRow(row) : undefined;
}

/**
 * Recorded physical checkout keys of the attempts that ran on `checkout`. A hold is matched by physical key so a renamed checkout still finds its own
 * hold; keys of attempts on other checkouts are never mixed in, because a head retargeted to another checkout must not mistake an active run's hold
 * on its own checkout for a hold on the head's checkout.
 */
function attemptCheckoutKeysFor(attempts: readonly AttemptSummary[], keys: ReadonlyMap<string, string>, checkout: string): string[] {
	return attempts
		.filter(attempt => attempt.canonical_checkout === checkout)
		.map(attempt => keys.get(attempt.attempt_id))
		.filter((key): key is string => key !== undefined);
}

function collectCheckoutEvidence(
	db: DatabaseSync,
	params: {
		coordVersion: 0 | 2;
		retainedCheckout: string;
		liveCheckout: string;
		liveCheckoutKey?: string;
		extraCheckouts?: string[];
		extraCheckoutKeys?: string[];
		attemptCheckoutKeys?: string[];
		factoryId: string;
		factoryDbPath: string;
	},
): {
	checkoutHold: StoredCheckoutHold | undefined;
	checkoutHoldConflictError?: string;
	checkoutManagedRuns: StoredManagedRun[];
	factoryCheckoutHolds: StoredCheckoutHold[];
	managedRuns: StoredManagedRun[];
} {
	if (params.coordVersion !== 2) {
		return { checkoutHold: undefined, checkoutManagedRuns: [], factoryCheckoutHolds: [], managedRuns: [] };
	}
	const paths = [params.retainedCheckout];
	if (params.liveCheckout !== params.retainedCheckout) paths.push(params.liveCheckout);
	for (const extra of params.extraCheckouts ?? []) {
		if (extra && !paths.includes(extra)) paths.push(extra);
	}
	const keys = [...new Set([
		...(params.liveCheckoutKey ? [params.liveCheckoutKey] : []),
		...(params.extraCheckoutKeys ?? []),
		...(params.attemptCheckoutKeys ?? []),
	])];

	const matchingHolds = selectCheckoutHoldsForIdentity(db, paths, keys);
	const checkoutHold = matchingHolds[0];
	const checkoutHoldConflictError = matchingHolds.length > 1
		? `Conflicting checkout holds match ${params.retainedCheckout}: ${matchingHolds.map(h => `${h.canonical_checkout} (${h.checkout_key}, task ${h.task_id})`).join(", ")}`
		: undefined;

	const byTask = new Map<string, StoredManagedRun>();
	for (const p of paths) {
		for (const row of selectManagedRunsForCheckout(db, p)) byTask.set(row.task_id, row);
	}
	for (const k of keys) {
		for (const row of selectManagedRunsForCheckoutKey(db, k)) byTask.set(row.task_id, row);
	}
	return {
		checkoutHold,
		checkoutHoldConflictError,
		checkoutManagedRuns: [...byTask.values()],
		factoryCheckoutHolds: selectCheckoutHoldsForFactory(db, params.factoryId, params.factoryDbPath),
		managedRuns: selectManagedRunsForFactory(db, params.factoryId, params.factoryDbPath),
	};
}

function classifyHeadBlockKind(errorMessageText: string): "preflight" | "compatibility" | "ceiling" {
	if (/ceiling/i.test(errorMessageText)) return "ceiling";
	if (/unsupported|canonical checkout mismatch|incompatible/i.test(errorMessageText)) return "compatibility";
	return "preflight";
}

function readHolderBoundVersion(checkoutHold: StoredCheckoutHold, coordDbPath: string, bootstrap: NonReleaseEvidenceReader): string {
	assertNoSymlinkComponents(checkoutHold.factory_db_path);
	if (!databaseExists(checkoutHold.factory_db_path)) {
		throw new Error(`Holder factory database is missing: ${checkoutHold.factory_db_path}`);
	}
	const db = new DatabaseSync(checkoutHold.factory_db_path, { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
		const ver = schemaVersion(db);
		if (ver < 4) throw new Error(`Unsupported holder factory storage version ${ver}`);
		const row = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(checkoutHold.attempt_id) as StoredAttempt | undefined;
		if (!row) throw new Error(`Missing holder attempt ${checkoutHold.attempt_id}`);
		verifyAttemptRow(row);
		// Use the owner's applicability guard and original routed evaluator, not the
		// observer's Bootstrap root or status-normalized manifest.
		if (requiresNonReleaseEvidence(row)) {
			if (row.state === "proven_not_released") {
				verifyHistoricalNonReleaseRun(row, checkoutHold.factory_id, checkoutHold.factory_name, checkoutHold.factory_db_path, coordDbPath, bootstrap);
			} else {
				validateNonReleaseEvidence(row, checkoutHold.factory_id, checkoutHold.factory_name, checkoutHold.factory_db_path, coordDbPath, bootstrap);
			}
		}
		return parseVersionToken(row.bound_version, "holder bound_version").version;
	} finally {
		db.close();
	}
}

function verifyCrossRootHistoricalRun(runRow: StoredManagedRun, checkoutHold: StoredCheckoutHold, coordDbPath: string, bootstrap: NonReleaseEvidenceReader): boolean {
	try {
		assertNoSymlinkComponents(checkoutHold.factory_db_path);
		if (!databaseExists(checkoutHold.factory_db_path)) return false;
		const holderDb = new DatabaseSync(checkoutHold.factory_db_path, { readOnly: true });
		try {
			holderDb.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
			const raw = holderDb.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(runRow.attempt_id) as StoredAttempt | undefined;
			if (!raw) return false;
			const attempt = verifyAttemptRow(raw);
			if (attempt.state !== "proven_not_released" || attempt.release_authorized || attempt.factory_id !== checkoutHold.factory_id || attempt.input_id !== checkoutHold.input_id || attempt.task_id !== runRow.task_id || runRow.request_id_digest !== digest(attempt.request_id)) return false;
			verifyHistoricalNonReleaseRun(raw, checkoutHold.factory_id, checkoutHold.factory_name, checkoutHold.factory_db_path, coordDbPath, bootstrap);
			return true;
		} finally { holderDb.close(); }
	} catch { return false; }
}

function verifyCrossRootTerminallySupersededRun(runRow: StoredManagedRun, coordDbPath: string, bootstrap: NonReleaseEvidenceReader): boolean {
	try {
		assertNoSymlinkComponents(runRow.factory_db_path);
		assertNoSymlinkComponents(coordDbPath);
		if (!databaseExists(runRow.factory_db_path) || !databaseExists(coordDbPath)) return false;
		const anchorPath = coordAnchorPath(coordDbPath);
		if (!pathEntryExists(anchorPath) || !lstatSync(anchorPath).isFile()) return false;
		const anchor = parseCoordAnchor(readRegularJsonNoSymlink<unknown>(anchorPath, "coordination continuity anchor"));
		if (anchor.state !== "committed") return false;
		const holderDb = new DatabaseSync(runRow.factory_db_path, { readOnly: true });
		try {
			holderDb.exec("PRAGMA busy_timeout = 5000");
			holderDb.prepare("ATTACH DATABASE ? AS coord").run(coordDbPath);
			holderDb.exec("PRAGMA query_only = ON; BEGIN");
			const ver = schemaVersion(holderDb);
			const coordVer = Number(holderDb.prepare("PRAGMA coord.user_version").get()?.user_version);
			if (ver < 4 || coordVer !== 2) return false;
			const coordMeta = holderDb.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
				| { id: number; anchor_id: string; created_at: string; record_digest: string }
				| undefined;
			if (!coordMeta || coordMetaRecordDigest(coordMeta.id, coordMeta.anchor_id, coordMeta.created_at) !== coordMeta.record_digest || coordMeta.anchor_id !== anchor.anchor_id) {
				return false;
			}
			const factoryRow = holderDb.prepare("SELECT factory_id, name, definition, digest FROM main.factories WHERE factory_id = ?").get(runRow.factory_id) as StoredFactory | undefined;
			if (!factoryRow) return false;
			verifyStoredFactory(factoryRow);
			return verifyTerminallySupersededRunRowInDb(holderDb, runRow, factoryRow.name, realpathSync(runRow.factory_db_path), realpathSync(coordDbPath), bootstrap);
		} finally {
			holderDb.close();
		}
	} catch {
		return false;
	}
}

function inspectCrossRootHoldProof(
	checkoutHold: StoredCheckoutHold,
	coordDbPath: string,
	bootstrap: NonReleaseEvidenceReader,
): string | undefined {
	const formatHoldReason = (reason: string | undefined, fallback: string): string => {
		if (!reason) return fallback;
		return /checkout/i.test(reason) ? reason : `Checkout hold for ${checkoutHold.task_id}: ${reason}`;
	};
	const holderSessionDir = join(checkoutHold.canonical_checkout, ".pi", "agent-sessions", checkoutHold.task_id);
	const holderManifestPath = join(holderSessionDir, "manifest.json");
	const holderReleasePath = join(holderSessionDir, "release.json");
	try {
		assertNoSymlinkComponents(holderSessionDir);
		const sessionExists = pathEntryExists(holderSessionDir);
		const releaseExists = pathEntryExists(holderReleasePath);
		const boundVersion = readHolderBoundVersion(checkoutHold, coordDbPath, bootstrap);
		if (!sessionExists && !releaseExists) {
			const expectedMeta: FactoryManagedInfo = {
				version: 1,
				factory_id: checkoutHold.factory_id,
				factory_name: checkoutHold.factory_name,
				input_id: checkoutHold.input_id,
				attempt_id: checkoutHold.attempt_id,
				request_id: checkoutHold.request_id,
				bound_version: boundVersion,
				canonical_checkout: checkoutHold.canonical_checkout,
				checkout_key: checkoutHold.checkout_key,
				state_db_path: checkoutHold.factory_db_path,
				coord_db_path: coordDbPath,
			};
			const check = inspectFactoryReleaseState({
				taskId: checkoutHold.task_id,
				token: "",
				sessionDir: holderSessionDir,
				sessionDirRemoved: true,
				primaryMeta: expectedMeta,
			});
			if (checkoutHold.state === "released") {
				return formatHoldReason(check.reason, `Checkout hold for ${checkoutHold.task_id} is released without release.json marker`);
			}
			if (check.kind !== "held") {
				return formatHoldReason(check.reason, `Checkout hold for ${checkoutHold.task_id} has inconsistent durable proof (${check.kind})`);
			}
			return undefined;
		}
		const rawHolderManifest = readRegularJsonNoSymlink<unknown>(holderManifestPath, `Checkout hold ${checkoutHold.task_id} run manifest.json`);
		const holderBoundVersion =
			rawHolderManifest && typeof rawHolderManifest === "object" && !Array.isArray(rawHolderManifest)
			&& (rawHolderManifest as Record<string, unknown>).factory_managed
			&& typeof (rawHolderManifest as Record<string, unknown>).factory_managed === "object"
				? parseVersionToken(
					((rawHolderManifest as Record<string, unknown>).factory_managed as Record<string, unknown>).bound_version,
					"holder bound_version",
				).version
				: boundVersion;
		const expectedMeta: FactoryManagedInfo = {
			version: 1,
			factory_id: checkoutHold.factory_id,
			factory_name: checkoutHold.factory_name,
			input_id: checkoutHold.input_id,
			attempt_id: checkoutHold.attempt_id,
			request_id: checkoutHold.request_id,
			bound_version: holderBoundVersion,
			canonical_checkout: checkoutHold.canonical_checkout,
			checkout_key: checkoutHold.checkout_key,
			state_db_path: checkoutHold.factory_db_path,
			coord_db_path: coordDbPath,
		};
		const holderManifest = readAndValidateManagedManifest({
			manifestPath: holderManifestPath,
			taskId: checkoutHold.task_id,
			expectedSessionDir: holderSessionDir,
			expectedMeta,
			sourceLabel: `Checkout hold ${checkoutHold.task_id} run manifest.json`,
		});
		const check = inspectFactoryReleaseState({
			taskId: checkoutHold.task_id,
			token: holderManifest.token,
			sessionDir: holderSessionDir,
			sessionDirRemoved: holderManifest.session_dir_removed,
			primaryMeta: holderManifest.factory_managed,
		});
		if (check.kind === "uncertain") {
			return formatHoldReason(check.reason, `Checkout hold for ${checkoutHold.task_id} has uncertain release proof`);
		}
		if (checkoutHold.state === "released" && check.kind !== "released") {
			return formatHoldReason(check.reason, `Checkout hold for ${checkoutHold.task_id} is released without valid release proof`);
		}
		if (checkoutHold.state !== "released" && check.kind !== "held") {
			return formatHoldReason(check.reason, `Checkout hold for ${checkoutHold.task_id} has state "${checkoutHold.state}" contradicting release proof`);
		}
		return undefined;
	} catch (error) {
		return `Checkout hold for ${checkoutHold.task_id} failed release proof check: ${errorMessage(error)}`;
	}
}

function deriveAttemptNodeCounts(params: {
	taskId: string;
	sessionDir: string;
	manifest?: Pick<BootstrapManifest, "version" | "status" | "session_dir_removed" | "pane_manifest">;
	requirePresent: boolean;
}): { node_counts?: NodeAttemptCount[]; node_counts_error?: string } {
	const { taskId, sessionDir, manifest, requirePresent } = params;
	if (manifest?.version === 1 || manifest?.session_dir_removed) return {};
	let resolvedManifest = manifest;
	if (!resolvedManifest) {
		const mPath = join(sessionDir, "manifest.json");
		try {
			if (!pathEntryExists(mPath)) {
				if (!pathEntryExists(upstreamIndexPath(sessionDir))) return {};
				return { node_counts_error: `upstream-index.json exists for ${taskId} without a readable run manifest` };
			}
			resolvedManifest = parseManifest(readRegularJsonNoSymlink<unknown>(mPath, "run manifest.json"), taskId);
		} catch (error) {
			return { node_counts_error: `Unable to read run manifest for node counts (${taskId}): ${errorMessage(error)}` };
		}
		if (resolvedManifest.version === 1 || resolvedManifest.session_dir_removed) return {};
	}
	try {
		const index = readValidatedUpstreamIndex(sessionDir, taskId, resolvedManifest.pane_manifest);
		if (!index) {
			if (requirePresent && (resolvedManifest.status === "applied" || resolvedManifest.status === "cleaned")) {
				return { node_counts_error: `Missing upstream-index.json for released run ${taskId}` };
			}
			return {};
		}
		return { node_counts: deriveNodeAttemptCountsFromIndex(index, resolvedManifest.pane_manifest) };
	} catch (error) {
		return { node_counts_error: `Unusable upstream-index.json for ${taskId}: ${errorMessage(error)}` };
	}
}

function inspectLaunchEvidence(params: {
	factory: Identity;
	factoryDbPath: string;
	coordDbPath: string;
	definition: Definition;
	currentVersion?: string;
	definitionsByVersion?: Map<string, Definition>;
	versionErrors?: Map<string, string>;
	/** Set when the FIFO head's bound version cannot be loaded; `definition` is then only a stand-in for checkout evidence and the head is blocked. */
	headVersionError?: string;
	/** Why the current pointer's version cannot be verified. Launch refuses on exactly this, so the head is reported blocked with the same cause. */
	currentVersionError?: string;
	managed: boolean;
	inputs: InputReceipt[];
	attempts: AttemptSummary[];
	attemptTokenDigests?: Map<string, string | null>;
	attemptNonceDigests?: Map<string, string | null>;
	attemptCheckoutKeys?: Map<string, string>;
	factoryHold: StoredFactoryHold | undefined;
	checkoutHold: StoredCheckoutHold | undefined;
	checkoutHoldConflictError?: string;
	checkoutManagedRuns: StoredManagedRun[];
	factoryCheckoutHolds: StoredCheckoutHold[];
	managedRuns: StoredManagedRun[];
	coordContinuityError?: string;
	skipCrossRootProofCheck?: boolean;
	pendingRequests?: DirectionRequestView[];
	bootstrap: NonReleaseEvidenceReader & Pick<BootstrapService, "prepareDefinition"> & Partial<Pick<BootstrapService, "prepareFromDefinition" | "status">>;
}): { capacity: CapacityView; attempts: AttemptSummary[]; head_status: HeadStatus; uncertainty: string[]; interventions?: AttentionItem[] } {
	const {
		factory,
		factoryDbPath,
		coordDbPath,
		definition,
		currentVersion,
		definitionsByVersion,
		versionErrors,
		headVersionError,
		currentVersionError,
		managed,
		inputs,
		attempts,
		attemptTokenDigests,
		attemptNonceDigests,
		attemptCheckoutKeys,
		factoryHold,
		checkoutHold,
		checkoutHoldConflictError,
		checkoutManagedRuns,
		factoryCheckoutHolds,
		managedRuns,
		coordContinuityError,
		skipCrossRootProofCheck,
		bootstrap,
	} = params;
	const uncertainty: string[] = [];
	const foreignProblems = new Set<string>();
	const checkoutUncertainty: string[] = [];
	const recordCheckoutUncertainty = (msg: string) => {
		uncertainty.push(msg);
		checkoutUncertainty.push(msg);
	};
	if (coordContinuityError) {
		recordCheckoutUncertainty(coordContinuityError);
	}
	if (checkoutHoldConflictError) {
		recordCheckoutUncertainty(checkoutHoldConflictError);
	}
	const attemptById = new Map(attempts.map(a => [a.attempt_id, a]));
	const inputById = new Map(inputs.map(i => [i.input_id, i]));
	const managedRunByAttempt = new Map(managedRuns.map(r => [r.attempt_id, r]));
	const checkoutManagedRunByTask = new Map(checkoutManagedRuns.map(r => [r.task_id, r]));
	const canonicalCheckout = definition.project_cwd;

	let liveResolvedCheckout = canonicalCheckout;
	let liveCheckoutKey: string | undefined;
	try {
		const liveIdentity = resolveCheckoutIdentity(canonicalCheckout);
		liveResolvedCheckout = liveIdentity.canonical_checkout;
		liveCheckoutKey = liveIdentity.checkout_key;
		if (liveResolvedCheckout !== canonicalCheckout) {
			recordCheckoutUncertainty(`Canonical checkout ${canonicalCheckout} now resolves to ${liveResolvedCheckout}`);
		}
	} catch {
		// Missing checkout is surfaced at preflight / head_status.
	}

	const requestingAttempts = new Set(params.pendingRequests?.map(item => item.attempt_id));
	const isBaseTerminallySuperseded = (attempt: AttemptSummary): boolean => {
		const expectedKey = attemptCheckoutKeys?.get(attempt.attempt_id);
		const inputRow = inputById.get(attempt.input_id);
		if (!expectedKey || !inputRow) return false;
		const siblings: TerminallySupersededSiblingView[] = attempts
			.filter(item => item.factory_id === factory.factory_id && item.input_id === attempt.input_id)
			.map(item => ({
				attempt_id: item.attempt_id,
				factory_id: item.factory_id,
				input_id: item.input_id,
				bound_version: item.bound_version,
				state: item.state,
				release_authorized: item.release_authorized,
				release_authorized_at: item.release_authorized_at,
				release_token_digest: attemptTokenDigests?.get(item.attempt_id) ?? null,
				release_nonce_digest: attemptNonceDigests?.get(item.attempt_id) ?? null,
				has_terminal_record: item.state === "settled"
					? Boolean(item.settlement ?? decodeSettlement(item.error))
					: item.state === "cleared"
						? Boolean(item.clearance ?? decodeClearance(item.error))
						: false,
			}));
		const hasActiveHold = Boolean(
			factoryHold?.attempt_id === attempt.attempt_id
			|| factoryHold?.input_id === attempt.input_id
			|| checkoutHold?.attempt_id === attempt.attempt_id
			|| checkoutHold?.input_id === attempt.input_id
			|| factoryCheckoutHolds.some(hold => hold.attempt_id === attempt.attempt_id || hold.input_id === attempt.input_id),
		);
		const matchingRuns = new Map<string, StoredManagedRun>();
		for (const r of [...managedRuns, ...checkoutManagedRuns]) {
			if (r.attempt_id === attempt.attempt_id || r.task_id === attempt.task_id) matchingRuns.set(r.task_id, r);
		}
		const res = evaluateTerminallySupersededStructure({
			attempt: {
				attempt_id: attempt.attempt_id,
				factory_id: attempt.factory_id,
				input_id: attempt.input_id,
				bound_version: attempt.bound_version,
				request_id: attempt.request_id,
				task_id: attempt.task_id,
				canonical_checkout: attempt.canonical_checkout,
				checkout_key: expectedKey,
				state: attempt.state,
				release_authorized: attempt.release_authorized,
				release_authorized_at: attempt.release_authorized_at,
				release_token_digest: attemptTokenDigests?.get(attempt.attempt_id) ?? null,
				release_nonce_digest: attemptNonceDigests?.get(attempt.attempt_id) ?? null,
				error: attempt.error,
			},
			inputRow,
			siblings,
			hasActiveHold,
			matchingManagedRuns: [...matchingRuns.values()],
			expectedFactoryId: factory.factory_id,
			expectedFactoryName: factory.name,
			expectedStateDbPath: factoryDbPath,
		});
		return res.matched && res.ok;
	};
	const terminallySupersededIds = new Set<string>();
	const enrichedAttempts = attempts.map(attempt => {
		if (attempt.state === "settled") {
			const { error: _persisted, ...rest } = attempt;
			const settlement = attempt.settlement ?? decodeSettlement(attempt.error);
			const bad = !settlement || !attempt.release_authorized ? [`Settled attempt ${attempt.attempt_id} has no readable settlement record`] : [];
			const counts = deriveAttemptNodeCounts({ taskId: attempt.task_id, sessionDir: join(attempt.canonical_checkout, ".pi", "agent-sessions", attempt.task_id), requirePresent: true });
			for (const item of bad) uncertainty.push(item);
			return { ...rest, historical: true, ...(settlement ? { settlement } : {}), ...(counts.node_counts ? { node_counts: counts.node_counts } : {}), ...(counts.node_counts_error ? { node_counts_error: counts.node_counts_error } : {}), ...(bad.length ? { uncertainty: bad } : {}) };
		}
		if (attempt.state === "cleared") {
			const { error: _persisted, ...rest } = attempt;
			const clearance = attempt.clearance ?? decodeClearance(attempt.error);
			const bad = !clearance || !attempt.release_authorized ? [`Cleared attempt ${attempt.attempt_id} has no readable clearance record`] : [];
			const counts = deriveAttemptNodeCounts({ taskId: attempt.task_id, sessionDir: join(attempt.canonical_checkout, ".pi", "agent-sessions", attempt.task_id), requirePresent: false });
			for (const item of bad) uncertainty.push(item);
			// Clearance is shown beside, never inside, the execution settlement: the observations keep whatever the evidence said.
			return { ...rest, historical: true, ...(clearance ? { clearance, settlement: { ...clearance.observations, capacity_release: "released" as const, released_holds: clearance.released_holds } } : {}), ...(counts.node_counts ? { node_counts: counts.node_counts } : {}), ...(counts.node_counts_error ? { node_counts_error: counts.node_counts_error } : {}), ...(bad.length ? { uncertainty: bad } : {}) };
		}
		const attemptUncertainty: string[] = [];
		// Only the attempt's own retained version is evidence; never another version's definition.
		const boundDef = definitionsByVersion?.get(attempt.bound_version);
		const boundVerErr = versionErrors?.get(attempt.bound_version);
		if (!boundDef) {
			attemptUncertainty.push(boundVerErr ?? `Attempt ${attempt.attempt_id} references missing or invalid bound version ${attempt.bound_version}`);
		} else if (boundDef.project_cwd !== attempt.canonical_checkout) {
			attemptUncertainty.push(`Attempt ${attempt.attempt_id} bound version ${attempt.bound_version} checkout (${boundDef.project_cwd}) contradicts attempt checkout (${attempt.canonical_checkout})`);
		}
		const attemptCheckout = attempt.canonical_checkout;
		let attemptLiveCheckoutKey = liveCheckoutKey;
		if (attemptCheckout !== canonicalCheckout) {
			try {
				const attIdentity = resolveCheckoutIdentity(attemptCheckout);
				attemptLiveCheckoutKey = attIdentity.checkout_key;
				if (attIdentity.canonical_checkout !== attemptCheckout) {
					attemptUncertainty.push(`Attempt ${attempt.attempt_id} checkout ${attemptCheckout} now resolves to ${attIdentity.canonical_checkout}`);
				}
			} catch {
				attemptLiveCheckoutKey = undefined;
			}
		}
		const expectedCheckoutKey = attemptCheckoutKeys?.get(attempt.attempt_id);
		const managedRun = managedRunByAttempt.get(attempt.attempt_id) ?? checkoutManagedRunByTask.get(attempt.task_id);
		const baseSuperseded = isBaseTerminallySuperseded(attempt);
		if (
			(!managedRun && !baseSuperseded)
			|| (managedRun && (
				managedRun.task_id !== attempt.task_id
				|| managedRun.attempt_id !== attempt.attempt_id
				|| managedRun.input_id !== attempt.input_id
				|| managedRun.factory_id !== factory.factory_id
				|| managedRun.factory_name !== factory.name
				|| managedRun.factory_db_path !== factoryDbPath
				|| managedRun.canonical_checkout !== attemptCheckout
				|| (expectedCheckoutKey !== undefined && managedRun.checkout_key !== expectedCheckoutKey)
				|| managedRun.request_id_digest !== digest(attempt.request_id)
			))
		) {
			attemptUncertainty.push(`Missing or mismatched coordination managed_run record for attempt ${attempt.attempt_id}`);
		}
		if (attemptLiveCheckoutKey && expectedCheckoutKey && expectedCheckoutKey !== attemptLiveCheckoutKey) {
			attemptUncertainty.push(`Canonical checkout ${attemptCheckout} physical identity (${attemptLiveCheckoutKey}) changed from attempt (${expectedCheckoutKey})`);
		}
		const sessionDir = join(attemptCheckout, ".pi", "agent-sessions", attempt.task_id);
		const releasePath = join(sessionDir, "release.json");
		let releaseMarkerPresent = false;
		try { releaseMarkerPresent = pathEntryExists(releasePath); }
		catch { releaseMarkerPresent = true; }
		const abortMarkerPresent = existsSync(join(sessionDir, "abort.json"));
		const expectedTokenDigest = attemptTokenDigests?.get(attempt.attempt_id) ?? null;

		const manifestPath = join(sessionDir, "manifest.json");
		let run: AttemptSummary["run"];
		let statusObservedRelease = false;
		let manifestForFallback: BootstrapManifest | undefined;
		let observedRunManifest: BootstrapManifest | undefined;
		if (bootstrap.status) {
			// Guard against SessionStore.load falling back to blocking readJson when index is absent and local manifest is a FIFO/symlink.
			let unsafeLocalManifestError: string | undefined;
			try {
				assertNoSymlinkComponents(manifestPath);
				if (pathEntryExists(manifestPath) && !lstatSync(manifestPath).isFile()) {
					unsafeLocalManifestError = `Refusing non-regular file for run manifest.json: ${manifestPath}`;
				}
			} catch (error) {
				unsafeLocalManifestError = errorMessage(error);
			}
			if (unsafeLocalManifestError) {
				attemptUncertainty.push(`Unable to read run ${attempt.task_id}: ${unsafeLocalManifestError}`);
				statusObservedRelease = true;
			}
		}
		if (bootstrap.status && !statusObservedRelease) {
			try {
				const st = bootstrap.status(attempt.task_id, attemptCheckout);
				observedRunManifest = st.manifest;
				run = {
					status: st.manifest.status,
					phase: st.manifest.phase,
					...(st.manifest.error !== undefined ? { error: st.manifest.error } : {}),
					release_marker_present: releaseMarkerPresent,
					abort_marker_present: abortMarkerPresent,
					outcome: st.outcome,
					pending: st.pending,
					worker_errors: st.worker_errors,
					delivery_errors: st.delivery_errors,
				};
				const beforeIdentityChecks = attemptUncertainty.length;
				if (st.manifest.factory_managed) {
					const fm = st.manifest.factory_managed;
					if (
						fm.factory_id !== factory.factory_id
						|| fm.factory_name !== factory.name
						|| fm.attempt_id !== attempt.attempt_id
						|| fm.input_id !== attempt.input_id
						|| fm.request_id !== attempt.request_id
						|| fm.bound_version !== attempt.bound_version
						|| fm.canonical_checkout !== attemptCheckout
						|| (expectedCheckoutKey !== undefined && fm.checkout_key !== expectedCheckoutKey)
						|| fm.state_db_path !== factoryDbPath
						|| fm.coord_db_path !== coordDbPath
					) {
						attemptUncertainty.push(`Manifest factory_managed metadata contradicts attempt ${attempt.attempt_id}`);
					}
				} else {
					attemptUncertainty.push(`Manifest for run ${attempt.task_id} is missing factory_managed metadata`);
				}
				if (attempt.release_authorized && (!expectedTokenDigest || digest(st.manifest.token) !== expectedTokenDigest)) {
					attemptUncertainty.push(`Manifest token digest contradicts SQLite release authorization for attempt ${attempt.attempt_id}`);
				}
				if (attempt.release_authorized && beforeIdentityChecks === attemptUncertainty.length && requestingAttempts.has(attempt.attempt_id)) {
				}
				if (st.manifest.status === "error" && st.manifest.phase === "uncertain") {
					attemptUncertainty.push(st.manifest.error ?? `Factory release state is uncertain for attempt ${attempt.attempt_id}`);
					statusObservedRelease = true;
				} else if (st.manifest.status !== "cleaned" && !st.manifest.session_dir_removed && !(st.manifest.status === "launching" && releaseMarkerPresent)) {
					statusObservedRelease = true;
				} else {
					manifestForFallback = st.manifest;
				}
			} catch (error) {
				const msg = errorMessage(error);
				if (!/No bootstrap session found/i.test(msg)) {
					attemptUncertainty.push(`Unable to read run ${attempt.task_id}: ${msg}`);
					statusObservedRelease = true;
				} else if (attempt.release_authorized) {
					attemptUncertainty.push(`Release was authorized for attempt ${attempt.attempt_id} (${attempt.task_id}), but run manifest is missing`);
					statusObservedRelease = true;
				}
			}
		}

		if (!statusObservedRelease) {
			let fallbackManifest = manifestForFallback;
			if (!fallbackManifest) {
				try {
					if (pathEntryExists(manifestPath)) {
						if (expectedCheckoutKey) {
							fallbackManifest = readAndValidateManagedManifest({
								manifestPath,
								taskId: attempt.task_id,
								expectedSessionDir: sessionDir,
								expectedMeta: {
									version: 1,
									factory_id: factory.factory_id,
									factory_name: factory.name,
									input_id: attempt.input_id,
									attempt_id: attempt.attempt_id,
									request_id: attempt.request_id,
									bound_version: attempt.bound_version,
									canonical_checkout: attemptCheckout,
									checkout_key: expectedCheckoutKey,
									state_db_path: factoryDbPath,
									coord_db_path: coordDbPath,
								},
								sourceLabel: "run manifest.json",
							});
						} else {
							let rawDiskManifest: unknown;
							try {
								rawDiskManifest = readRegularJsonNoSymlink<unknown>(manifestPath, "run manifest.json");
							} catch (error) {
								if (error instanceof SyntaxError) throw new Error("Malformed JSON in run manifest.json");
								throw error;
							}
							fallbackManifest = parseManifest(rawDiskManifest, attempt.task_id);
						}
					}
				} catch (error) {
					attemptUncertainty.push(`Unable to read run ${attempt.task_id}: ${errorMessage(error)}`);
					statusObservedRelease = true;
				}
			}
			if (!statusObservedRelease) {
				if (fallbackManifest) {
					observedRunManifest ??= fallbackManifest;
					if (attempt.release_authorized && (!expectedTokenDigest || digest(fallbackManifest.token) !== expectedTokenDigest)) {
						attemptUncertainty.push(`Manifest token digest contradicts SQLite release authorization for attempt ${attempt.attempt_id}`);
					}
					const check = inspectFactoryReleaseState({
						taskId: attempt.task_id,
						token: fallbackManifest.token,
						sessionDir,
						sessionDirRemoved: fallbackManifest.session_dir_removed,
						primaryMeta: fallbackManifest.factory_managed,
					});
					if (check.kind === "uncertain") {
						attemptUncertainty.push(check.reason ?? `Factory release state is uncertain for attempt ${attempt.attempt_id}`);
					} else if (fallbackManifest.status === "applied" && check.kind !== "released") {
						attemptUncertainty.push(check.reason ?? "Durable factory release proof is inconsistent");
					} else if (fallbackManifest.status === "error" && check.kind !== "held" && check.kind !== "historical_non_release") {
						attemptUncertainty.push(check.reason ?? "Persisted error manifest contradicts durable factory release evidence");
					} else if (fallbackManifest.status === "cleaned") {
						attemptUncertainty.push(`Factory-managed run ${attempt.task_id} has invalid cleaned manifest status`);
					}
				} else if (attempt.release_authorized) {
					attemptUncertainty.push(`Release was authorized for attempt ${attempt.attempt_id} (${attempt.task_id}), but run manifest is missing`);
				} else {
					let sessionDirVisible = false;
					let sessionCheckError: string | undefined;
					try {
						sessionDirVisible = pathEntryExists(sessionDir);
					} catch (error) {
						sessionCheckError = errorMessage(error);
					}
					if (sessionCheckError) {
						attemptUncertainty.push(`Unable to inspect session directory for attempt ${attempt.attempt_id}: ${sessionCheckError}`);
					} else if (attempt.state === "proven_not_released") {
						attemptUncertainty.push(`Proven non-release attempt ${attempt.attempt_id} is missing its run manifest and retained evidence`);
					} else if (sessionDirVisible || releaseMarkerPresent) {
						const check = inspectFactoryReleaseState({
							taskId: attempt.task_id,
							token: "",
							sessionDir,
							primaryMeta: {
								version: 1,
								factory_id: factory.factory_id,
								factory_name: factory.name,
								input_id: attempt.input_id,
								attempt_id: attempt.attempt_id,
								request_id: attempt.request_id,
								bound_version: attempt.bound_version,
								canonical_checkout: attemptCheckout,
								checkout_key: expectedCheckoutKey ?? attemptLiveCheckoutKey ?? "dev:0:ino:0",
								state_db_path: factoryDbPath,
								coord_db_path: coordDbPath,
							},
						});
						if (check.kind === "uncertain") {
							attemptUncertainty.push(check.reason ?? `Factory release state is uncertain for attempt ${attempt.attempt_id}`);
						}
					}
				}
			}
		}
		// Eligibility and takeover/retry must read the same raw evidence, even when status has
		// normalized a contradictory saved manifest into an error observation.
		try {
			if (requiresNonReleaseEvidence(attempt)) {
				if (!expectedCheckoutKey) throw new Error("Missing attempt checkout identity for non-release evidence");
				validateNonReleaseEvidence({ ...attempt, checkout_key: expectedCheckoutKey }, factory.factory_id, factory.name, factoryDbPath, coordDbPath, bootstrap);
			}
		} catch (error) {
			attemptUncertainty.push(`Invalid non-release evidence for ${attempt.task_id}: ${errorMessage(error)}`);
		}
		let settlement: SettlementObservations | undefined;
		if (attempt.release_authorized && bootstrap.settlementObservations) {
			// Uncertain evidence still reports its observations, each as unknown, so cancellation intent never disappears with it.
			try { settlement = bootstrap.settlementObservations(attempt.task_id, attemptCheckout); } catch (error) {
				const reason = `settlement evidence is unreadable: ${errorMessage(error)}`;
				settlement = { evidence_unreadable: true, cancellation: { intent: "unknown", error: reason }, resource_closure: { state: "unknown", recorded_closed: [], not_recorded_closed: [] }, execution_settlement: { state: "unknown", reason }, outcome: "incomplete", resume_risk: [], attention: [] };
			}
		}
		if (baseSuperseded && attemptUncertainty.length === 0 && expectedCheckoutKey && bootstrap.validateFactoryNonReleaseEvidence) {
			try {
				verifyFactoryNonReleaseEvidence(attempt.task_id, {
					version: 1,
					factory_id: factory.factory_id,
					factory_name: factory.name,
					input_id: attempt.input_id,
					attempt_id: attempt.attempt_id,
					request_id: attempt.request_id,
					bound_version: attempt.bound_version,
					canonical_checkout: attemptCheckout,
					checkout_key: expectedCheckoutKey,
					state_db_path: factoryDbPath,
					coord_db_path: coordDbPath,
				}, { requireAbortWhenError: true, rejectUncertainManifest: true });
			} catch (error) {
				attemptUncertainty.push(`Invalid non-release evidence for ${attempt.task_id}: ${errorMessage(error)}`);
			}
		}
		const terminallySuperseded = baseSuperseded && attemptUncertainty.length === 0;
		const inputRow = inputById.get(attempt.input_id);
		if (!inputRow) {
			attemptUncertainty.push(`Attempt ${attempt.attempt_id} references missing input ${attempt.input_id}`);
		} else {
			if (inputRow.bound_version !== attempt.bound_version) {
				attemptUncertainty.push(`Attempt ${attempt.attempt_id} bound version (${attempt.bound_version}) contradicts input ${inputRow.input_id} (${inputRow.bound_version})`);
			}
			if (attempt.release_authorized && inputRow.disposition !== "running") {
				attemptUncertainty.push(`Attempt ${attempt.attempt_id} is release_authorized but input ${inputRow.input_id} disposition is "${inputRow.disposition}"`);
			} else if (
				!attempt.release_authorized
				&& inputRow.disposition !== "launching"
				&& !(attempt.state === "proven_not_released" && factoryHold?.input_id === inputRow.input_id && factoryHold.attempt_id !== attempt.attempt_id && inputRow.disposition === "running")
				&& !terminallySuperseded
			) {
				attemptUncertainty.push(`Attempt ${attempt.attempt_id} is unreleased but input ${inputRow.input_id} disposition is "${inputRow.disposition}"`);
			}
		}
		if (terminallySuperseded && attemptUncertainty.length === 0) {
			terminallySupersededIds.add(attempt.attempt_id);
		}

		const counts = deriveAttemptNodeCounts({
			taskId: attempt.task_id,
			sessionDir: observedRunManifest?.session_dir ?? sessionDir,
			manifest: observedRunManifest,
			requirePresent: Boolean(attempt.release_authorized && observedRunManifest && !observedRunManifest.session_dir_removed),
		});

		if (settlement && attemptUncertainty.length > 0 && settlement.execution_settlement.state === "settled") {
			settlement = { ...settlement, execution_settlement: { state: "unknown", reason: `run evidence is uncertain: ${attemptUncertainty.join("; ")}` } };
		}
		for (const item of attemptUncertainty) uncertainty.push(item);
		const isCurrentHeldAttempt = factoryHold?.attempt_id === attempt.attempt_id;
		let nonReleaseReasonOverride: string | undefined;
		if (!attempt.release_authorized && attempt.state === "failed_before_release" && isCurrentHeldAttempt && attemptUncertainty.length === 0 && expectedCheckoutKey) {
			const proof = checkSelfSessionPreReleaseNonRelease({
				...attempt,
				checkout_key: expectedCheckoutKey,
				release_authorized: attempt.release_authorized ? 1 : 0,
				release_authorized_at: attempt.release_authorized_at,
				release_token_digest: attemptTokenDigests?.get(attempt.attempt_id) ?? null,
				release_nonce_digest: attemptNonceDigests?.get(attempt.attempt_id) ?? null,
			}, factory.factory_id, factory.name, factoryDbPath, coordDbPath, bootstrap);
			nonReleaseReasonOverride = proof.ok
				? `Every node that acknowledged readiness has exited and non-release evidence is intact (release is impossible because the durable fence is closed); run /factory settle ${factory.factory_id} to prove non-release for /factory retry ${factory.factory_id} ${attempt.input_id} ${attempt.attempt_id}`
				: `Cannot prove non-release yet (${proof.reason}); wait for nodes to exit and run /factory settle ${factory.factory_id}, or exit Pi and run /factory takeover ${factory.factory_id} if the launch was interrupted`;
		}
		return {
			...attempt,
			historical: !isCurrentHeldAttempt,
			...(nonReleaseReasonOverride ? {
				non_release_proof: { status: "not_proven" as const, reason: nonReleaseReasonOverride },
				retry_eligibility: { eligible: false, reason: nonReleaseReasonOverride },
			} : {}),
			...(attempt.state === "proven_not_released" && !isCurrentHeldAttempt ? { retry_eligibility: { eligible: false, reason: "historical attempt superseded by a later retry; it is not the current held attempt" } } : {}),
			...(attempt.state === "proven_not_released" && isCurrentHeldAttempt && attemptUncertainty.length > 0 ? { retry_eligibility: { eligible: false, reason: attemptUncertainty.join("; ") } } : {}),
			...(boundDef ? { node_policies: summarizeNodePolicies(boundDef) } : {}),
			...(counts.node_counts ? { node_counts: counts.node_counts } : {}),
			...(counts.node_counts_error ? { node_counts_error: counts.node_counts_error } : {}),
			...(attemptUncertainty.length ? { uncertainty: attemptUncertainty } : {}),
			...(run ? { run } : {}),
			...(settlement ? { settlement: { ...settlement, capacity_release: isCurrentHeldAttempt ? "held" as const : "released" as const } } : {}),
		};
	});

	const isVerifiedTerminallySupersededManagedRun = (runRow: StoredManagedRun): boolean => {
		if (runRow.factory_id === factory.factory_id && runRow.factory_db_path === factoryDbPath) {
			if (!terminallySupersededIds.has(runRow.attempt_id)) return false;
			const att = attemptById.get(runRow.attempt_id);
			const expectedKey = att ? attemptCheckoutKeys?.get(att.attempt_id) : undefined;
			return Boolean(
				att
				&& expectedKey
				&& runRow.task_id === att.task_id
				&& runRow.input_id === att.input_id
				&& runRow.factory_name === factory.name
				&& runRow.canonical_checkout === att.canonical_checkout
				&& runRow.checkout_key === expectedKey
				&& runRow.request_id_digest === digest(att.request_id),
			);
		}
		return verifyCrossRootTerminallySupersededRun(runRow, coordDbPath, bootstrap);
	};
	const unexpectedOrphanRuns = checkoutHold ? [] : checkoutManagedRuns.filter(runRow => !isVerifiedTerminallySupersededManagedRun(runRow));

	if (checkoutHold) {
		// Problems with another factory's hold are not this attempt's own evidence problems; everything else is, so no own problem can be dropped.
		const holdIsOwn = checkoutHold.factory_id === factory.factory_id && checkoutHold.factory_db_path === factoryDbPath;
		const recordHold = (msg: string) => { recordCheckoutUncertainty(msg); if (!holdIsOwn) foreignProblems.add(msg); };
		if (!VALID_HOLD_STATES.has(checkoutHold.state)) {
			recordHold(`Checkout hold on ${checkoutHold.canonical_checkout} has invalid state "${checkoutHold.state}"`);
		}
		const matchingRun = checkoutManagedRunByTask.get(checkoutHold.task_id);
		if (
			!matchingRun
			|| matchingRun.attempt_id !== checkoutHold.attempt_id
			|| matchingRun.factory_id !== checkoutHold.factory_id
			|| matchingRun.factory_name !== checkoutHold.factory_name
			|| matchingRun.factory_db_path !== checkoutHold.factory_db_path
			|| matchingRun.input_id !== checkoutHold.input_id
			|| matchingRun.canonical_checkout !== checkoutHold.canonical_checkout
			|| matchingRun.checkout_key !== checkoutHold.checkout_key
			|| matchingRun.request_id_digest !== digest(checkoutHold.request_id)
		) {
			recordHold(`Checkout hold on ${checkoutHold.canonical_checkout} (task ${checkoutHold.task_id}) lacks matching coordination managed_run record`);
		}
		for (const runRow of checkoutManagedRuns) {
			if (runRow.task_id === checkoutHold.task_id) continue;
			const historical = attemptById.get(runRow.attempt_id);
			if (
				(historical?.state === "proven_not_released" && !historical.release_authorized && historical.factory_id === checkoutHold.factory_id && historical.input_id === checkoutHold.input_id && historical.task_id === runRow.task_id && historical.request_id && runRow.request_id_digest === digest(historical.request_id))
				|| verifyCrossRootHistoricalRun(runRow, checkoutHold, coordDbPath, bootstrap)
				|| isVerifiedTerminallySupersededManagedRun(runRow)
			) continue;
			recordHold(`Extra coordination managed_run record (${runRow.task_id}) on checkout ${canonicalCheckout} contradicts active hold (${checkoutHold.task_id})`);
		}
		const ownHold = checkoutHold.factory_id === factory.factory_id && checkoutHold.factory_db_path === factoryDbPath;
		const pathMatchesHold = checkoutHold.canonical_checkout === canonicalCheckout;
		const physicalMatchesHold = !liveCheckoutKey || checkoutHold.checkout_key === liveCheckoutKey;
		if (!pathMatchesHold) {
			if (liveCheckoutKey && checkoutHold.checkout_key === liveCheckoutKey) {
				recordHold(
					`Physical checkout (${liveCheckoutKey}) at ${canonicalCheckout} is already held under prior path ${checkoutHold.canonical_checkout} by factory "${checkoutHold.factory_name}" (${checkoutHold.factory_id}, attempt ${checkoutHold.attempt_id}, run ${checkoutHold.task_id})`,
				);
			} else {
				recordHold(
					`Checkout hold on ${checkoutHold.canonical_checkout} (${checkoutHold.checkout_key}) contradicts ${canonicalCheckout}`,
				);
			}
		} else if (!physicalMatchesHold) {
			recordHold(
				`Canonical checkout ${canonicalCheckout} physical identity (${liveCheckoutKey}) does not match active hold (${checkoutHold.checkout_key})`,
			);
		}
		if (!ownHold && pathMatchesHold && physicalMatchesHold && !skipCrossRootProofCheck) {
			const crossRootReason = inspectCrossRootHoldProof(checkoutHold, coordDbPath, bootstrap);
			if (crossRootReason) {
				recordHold(crossRootReason);
			}
		}
	} else if (unexpectedOrphanRuns.length > 0) {
		const orphanMsg = `Orphaned coordination managed_run record(s) for checkout ${canonicalCheckout} without an active checkout hold (task_id: ${unexpectedOrphanRuns.map(r => r.task_id).join(", ")})`;
		recordCheckoutUncertainty(orphanMsg);
		if (unexpectedOrphanRuns.some(run => run.factory_id !== factory.factory_id)) foreignProblems.add(orphanMsg);
	}

	if (factoryHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		if (
			!att
			|| att.task_id !== factoryHold.task_id
			|| att.input_id !== factoryHold.input_id
			|| att.request_id !== factoryHold.request_id
			|| (att.state !== factoryHold.state && !(att.state === "proven_not_released" && factoryHold.state === "failed_before_release"))
		) {
			uncertainty.push(`Factory hold references missing or mismatched attempt ${factoryHold.attempt_id}`);
		}
		// The hold belongs to its own attempt's checkout, which may differ from the head's target when versions retarget the checkout.
		const holdCheckout = att?.canonical_checkout ?? canonicalCheckout;
		const ownRecord = checkoutHold?.attempt_id === factoryHold.attempt_id
			? checkoutHold
			: factoryCheckoutHolds.find(ch => ch.attempt_id === factoryHold.attempt_id);
		if (
			!ownRecord
			|| ownRecord.factory_id !== factory.factory_id
			|| ownRecord.factory_db_path !== factoryDbPath
			|| ownRecord.attempt_id !== factoryHold.attempt_id
			|| ownRecord.input_id !== factoryHold.input_id
			|| ownRecord.request_id !== factoryHold.request_id
			|| ownRecord.task_id !== factoryHold.task_id
			|| ownRecord.state !== factoryHold.state
		) {
			recordCheckoutUncertainty(`Factory hold ${factoryHold.attempt_id} lacks matching checkout hold for ${holdCheckout}`);
		}
	}
	for (const ch of factoryCheckoutHolds) {
		const holdAttempt = attemptById.get(ch.attempt_id);
		const expectedCheckout = holdAttempt?.canonical_checkout ?? canonicalCheckout;
		if (!factoryHold || factoryHold.attempt_id !== ch.attempt_id || ch.canonical_checkout !== expectedCheckout) {
			recordCheckoutUncertainty(`Checkout hold on ${ch.canonical_checkout} for factory ${factory.factory_id} lacks matching factory hold`);
		}
	}
	const unsettledAttempts = attempts.filter(item => item.state !== "settled" && item.state !== "cleared" && !terminallySupersededIds.has(item.attempt_id));
	if (unsettledAttempts.length > 0 && !factoryHold) {
		uncertainty.push(`Attempt ${unsettledAttempts.at(-1)!.attempt_id} exists without an active factory hold`);
	}
	if (attempts.length > 1) {
		const currentAttemptId = factoryHold?.attempt_id;
		const invalidHistory = attempts.filter(item => item.attempt_id !== currentAttemptId && item.state !== "settled" && item.state !== "cleared" && !terminallySupersededIds.has(item.attempt_id) && (item.state !== "proven_not_released" || item.release_authorized || item.input_id !== factoryHold?.input_id));
		if (invalidHistory.length > 0) uncertainty.push(`Factory has attempts without a valid proven non-release history: ${invalidHistory.map(item => item.attempt_id).join(", ")}`);
	}

	const clearanceFor = (attempt: AttemptSummary): ClearanceEligibility | undefined => {
		if (attempt.historical || attempt.state === "proven_not_released") return undefined;
		const ownFactoryHold = factoryHold?.attempt_id === attempt.attempt_id ? factoryHold : undefined;
		const ownCheckout = [checkoutHold, ...factoryCheckoutHolds].find(hold => hold?.attempt_id === attempt.attempt_id);
		const holds = { ...(ownFactoryHold ? { factory_held_at: ownFactoryHold.held_at } : {}), ...(ownCheckout ? { checkout_held_at: ownCheckout.held_at } : {}) };
		const settlement = attempt.settlement;
		// Only this attempt's own record and hold problems count, never another factory's unrelated coordination conflict.
		let evidenceProblems = [...new Set([...(attempt.uncertainty ?? []), ...uncertainty.filter(item => !foreignProblems.has(item))])];
		// Settlement refuses on any factory-wide uncertainty, so when nothing else is wrong with this run, those problems must stay listed or the hold could be stuck between settle and clear.
		if (evidenceProblems.length === 0 && settlement?.execution_settlement.state === "settled") evidenceProblems = [...new Set(uncertainty)];
		const missing = [...evidenceProblems, ...(settlement && settlement.execution_settlement.state !== "settled" ? [settlement.execution_settlement.reason] : [])].filter((item, index, all) => all.indexOf(item) === index);
		const resumeRisk = settlement?.resume_risk ?? [];
		const base = { holds, missing_or_contradictory: missing, evidence_problems: evidenceProblems, evidence_unreadable: settlement?.evidence_unreadable === true, resume_risk: resumeRisk, action: CLEARANCE_ACTION, consequences: CLEARANCE_CONSEQUENCES };
		if (!attempt.release_authorized || attempt.state !== "released") {
			const reason = attempt.state === "failed_before_release"
				? `Release permission for this attempt is not durably fenced for clearance (state failed_before_release); run /factory settle ${factory.factory_id} once nodes exit to prove non-release for /factory retry, or exit Pi and run /factory takeover ${factory.factory_id} if the launch was interrupted`
				: `Release permission for this attempt is not durably fenced (state ${attempt.state}); the original launch may still release, so it cannot be cleared`;
			return { eligible: false, reason, ...base };
		}
		if (!ownFactoryHold || !ownCheckout) return { eligible: false, reason: "The attempt does not hold both its factory and checkout capacity holds; clearance releases exactly those two holds", ...base };
		if (!settlement) return { eligible: false, reason: "Run settlement evidence is unavailable, so whether conflicting work may resume cannot be judged", ...base };
		if (resumeRisk.length > 0) return { eligible: false, reason: `Conflicting work may still resume; stop or isolate it first: ${resumeRisk.join("; ")}`, ...base };
		if (missing.length === 0) return { eligible: false, reason: "Execution is reliably settled and the evidence is consistent; the hold is not uncertain, so settle it instead", ...base };
		return { eligible: true, reason: "Evidence is missing, contradictory or incomplete and no positive evidence shows work able to resume; an operator may clear the hold with supporting evidence", ...base };
	};
	const clearableAttempts = enrichedAttempts.map(attempt => {
		const clearance_eligibility = clearanceFor(attempt);
		return clearance_eligibility ? { ...attempt, clearance_eligibility } : attempt;
	});

	const queue_used = queueOccupancy(inputs, attempts);
	const ownCheckoutHold = checkoutHold && checkoutHold.factory_id === factory.factory_id && checkoutHold.factory_db_path === factoryDbPath;
	const factory_slot: CapacityView["factory_slot"] = uncertainty.length > 0 && (factoryHold || factoryCheckoutHolds.length > 0 || attempts.length > 0)
		? "uncertain"
		: factoryHold ? "held" : "free";
	const checkout_slot: CapacityView["checkout_slot"] =
		checkoutUncertainty.length > 0
		|| (uncertainty.length > 0 && Boolean(checkoutHold || factoryCheckoutHolds.length > 0 || factoryHold || checkoutManagedRuns.length > 0))
			? "uncertain"
			: checkoutHold ? "held" : "free";

	let blocking_hold: CapacityView["blocking_hold"];
	if (factoryHold && checkoutHold && ownCheckoutHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		blocking_hold = {
			scope: "both",
			factory_id: factory.factory_id,
			factory_name: factory.name,
			input_id: factoryHold.input_id,
			attempt_id: factoryHold.attempt_id,
			request_id: factoryHold.request_id,
			task_id: factoryHold.task_id,
			state: factoryHold.state,
			release_authorized: att?.release_authorized,
			held_at: factoryHold.held_at,
		};
	} else if (checkoutHold && !ownCheckoutHold) {
		blocking_hold = {
			scope: "checkout",
			factory_id: checkoutHold.factory_id,
			factory_name: checkoutHold.factory_name,
			input_id: checkoutHold.input_id,
			attempt_id: checkoutHold.attempt_id,
			task_id: checkoutHold.task_id,
			state: checkoutHold.state,
			held_at: checkoutHold.held_at,
			reason: `Checkout ${canonicalCheckout} is held by factory "${checkoutHold.factory_name}" (${checkoutHold.factory_id}, attempt ${checkoutHold.attempt_id}, run ${checkoutHold.task_id})`,
		};
	} else if (factoryHold) {
		const att = attemptById.get(factoryHold.attempt_id);
		blocking_hold = {
			scope: "factory",
			factory_id: factory.factory_id,
			factory_name: factory.name,
			input_id: factoryHold.input_id,
			attempt_id: factoryHold.attempt_id,
			request_id: factoryHold.request_id,
			task_id: factoryHold.task_id,
			state: factoryHold.state,
			release_authorized: att?.release_authorized,
			held_at: factoryHold.held_at,
		};
	} else if (unexpectedOrphanRuns.length > 0) {
		const orphan = unexpectedOrphanRuns[0]!;
		blocking_hold = {
			scope: "checkout",
			factory_id: orphan.factory_id,
			factory_name: orphan.factory_name,
			input_id: orphan.input_id,
			attempt_id: orphan.attempt_id,
			task_id: orphan.task_id,
			state: "uncertain",
			held_at: orphan.created_at,
			reason: `Orphaned coordination managed_run for checkout ${canonicalCheckout} (factory "${orphan.factory_name}", ${orphan.factory_id}, run ${orphan.task_id})`,
		};
	}

	const capacity: CapacityView = {
		queue_used,
		queue_limit: MAX_QUEUED_INPUTS,
		factory_slot,
		checkout_slot,
		canonical_checkout: canonicalCheckout,
		...(blocking_hold ? { blocking_hold } : {}),
	};

	let head_status: HeadStatus;
	const head = firstWaitingInput(inputs, attempts);
	const headFields = head
		? {
			input_id: head.input_id,
			reference: head.reference,
			bound_version: head.bound_version,
			...(currentVersion !== undefined ? { current_version: currentVersion } : {}),
		}
		: {};
	if (!managed) {
		head_status = { eligible: false, blocking_kind: "unmanaged", reason: `Factory "${factory.name}" (${factory.factory_id}) is unmanaged` };
	} else if (currentVersionError) {
		// Launch validates the current version's metadata before anything else and refuses; an intact bound version does not make the head eligible.
		head_status = { eligible: false, ...headFields, blocking_kind: "uncertain", reason: currentVersionError };
	} else if (uncertainty.length > 0) {
		head_status = { eligible: false, ...headFields, blocking_kind: "uncertain", reason: uncertainty.join("; ") };
	} else if (factoryHold) {
		head_status = {
			eligible: false,
			...headFields,
			blocking_kind: "factory_held",
			reason: `Factory slot is held by attempt ${factoryHold.attempt_id} (input ${factoryHold.input_id}, run ${factoryHold.task_id}, state ${factoryHold.state})`,
		};
	} else if (checkoutHold) {
		head_status = {
			eligible: false,
			...headFields,
			blocking_kind: "checkout_held",
			reason: `Checkout ${canonicalCheckout} is held by factory "${checkoutHold.factory_name}" (${checkoutHold.factory_id}, attempt ${checkoutHold.attempt_id}, run ${checkoutHold.task_id})`,
		};
	} else if (!head) {
		head_status = { eligible: false, blocking_kind: "empty", reason: "No queued input waiting to launch" };
	} else if (head.disposition !== "queued") {
		head_status = {
			eligible: false,
			...headFields,
			blocking_kind: "factory_held",
			reason: `Head input ${head.input_id} (${head.reference}) has disposition "${head.disposition}"`,
		};
	} else if (headVersionError) {
		// The bound version is the only definition this input may use; never fall back to the current or another version.
		head_status = { eligible: false, ...headFields, blocking_kind: "uncertain", reason: headVersionError };
	} else if (bootstrap.prepareFromDefinition) {
		try {
			bootstrap.prepareFromDefinition(definition, { checkHerdrEnv: false });
			head_status = { eligible: true, ...headFields };
		} catch (error) {
			const reason = errorMessage(error);
			head_status = { eligible: false, ...headFields, blocking_kind: classifyHeadBlockKind(reason), reason };
		}
	} else {
		head_status = { eligible: true, ...headFields };
	}

	const interventions = params.pendingRequests?.map((item): AttentionItem => {
		const state = item.can_respond ? item.exhaustion ? `${item.node_id} exhausted its revision capacity` : `${item.node_id} is waiting for a person`
			: item.can_redeliver ? `${item.node_id} has a recorded response awaiting consumption`
			: `${item.node_id}'s request is uncertain: ${item.recovery_reason}`;
		return { kind: "intervention", attempt_id: item.attempt_id, input_id: item.input_id, task_id: item.task_id, request_id: item.request_id, reason: `${state}: ${item.question}` };
	});
	return { capacity, attempts: clearableAttempts, head_status, uncertainty, ...(interventions ? { interventions } : {}) };
}

export { validateToken as validateFactoryToken };

/** Shared operation boundary for factory publication, explicit resume, brief submission, launch, and read-only inspection/receipts. */
export function factoryOperations(
	path: string,
	bootstrap: NonReleaseEvidenceReader & Pick<BootstrapService, "prepareDefinition"> & Partial<Pick<BootstrapService, "prepareFromDefinition" | "launchFromDefinition" | "status" | "defaultCoordinationPath" | "store" | "cancelFactoryRun" | "settlementObservations" | "retryFactoryDelivery" | "directionObservation" | "directionRouting" | "directionExhaustions">>,
	commitOrOptions?: CommitBoundary | FactoryOperationsOptions,
) {
	const options: FactoryOperationsOptions = typeof commitOrOptions === "function" ? { atCommit: commitOrOptions } : (commitOrOptions ?? {});
	const atCommit = options.atCommit;
	const atLaunchCommit = options.atLaunchCommit;
	const presettled = new WeakSet<object>();
	const coordPath = options.coordinationPath ?? bootstrap.defaultCoordinationPath?.() ?? join(dirname(resolve(path)), "factory-coordination.sqlite");

	function reconcileRequest(db: DatabaseSync, row: StoredRequest): DirectionRequestView {
		const view: DirectionRequestView = { ...requestView(row), can_respond: false, can_redeliver: false, verdict: { state: "unknown" }, admissions: "unknown" };
		const uncertain = (reason: string): DirectionRequestView => ({ ...view, reconciliation: "uncertain", recovery_reason: reason });
		const ended = (reason: "cancelled" | "failed" | "closed"): DirectionRequestView => ({ ...view, reconciliation: reason === "closed" ? "resolved" : reason,
			...(view.consumption === "awaiting_consumption" ? { consumption: "never_consumed" } : {}), recovery_reason: `Original attempt ${reason === "closed" ? "ended" : reason}; no continuation can be authorized` });
		try {
			const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(row.attempt_id) as StoredAttempt | undefined;
			if (!raw) return uncertain("Original factory attempt is missing");
			const attempt = validateAttemptRow(raw);
			if (attempt.factory_id !== row.factory_id || attempt.input_id !== row.input_id || attempt.task_id !== row.task_id || attempt.release_authorized !== 1) return uncertain("Original factory attempt binding is contradictory");
			const routing = requestDecisionEvidence(db, row);
			if (routing.approval) {
				view.route_binding = routing.approval;
				if (routing.approval.verdict === routing.decision?.approve) view.approval = routing.approval;
			}
			if (routing.decision) {
				try {
					if (!bootstrap.directionRouting) throw new Error("Verdict and admission inspection is unavailable");
					Object.assign(view, bootstrap.directionRouting(row, attempt.canonical_checkout, realpathSync(path), { ...routing, decision: routing.decision }));
				} catch (error) { view.routing_error = errorMessage(error); }
			} else {
				view.verdict = { state: "not_applicable" };
				view.admissions = null;
			}
			const fence = requestFence(db, row.attempt_id);
			if (row.terminated_reason) return ended(row.terminated_reason);
			if (fence === "cancelled" || fence === "failed" || (fence === "closed" && attempt.state === "settled" && row.consumed_at)) return ended(fence);
			if (view.routing_error) return uncertain(view.routing_error);
			if (!bootstrap.directionObservation) return uncertain("Original requester verification is unavailable");
			let receiver: ReturnType<typeof originalReceiver> | undefined;
			let receiverError: string | undefined;
			try { receiver = originalReceiver(db, row, !row.consumed_at); }
			catch (error) { receiverError = errorMessage(error); }
			const observed = bootstrap.directionObservation(row, attempt.canonical_checkout, realpathSync(path), receiver);
			if (observed === "result") return row.consumed_at ? { ...view, reconciliation: "resolved" } : uncertain("Original attempt has a result without consuming this open request");
			if (observed === "cancelled" || observed === "failed") return ended(observed);
			if (fence || attempt.state !== "released") return uncertain(`Original factory attempt is no longer released and its result is missing`);
			if (observed !== "receiver_verified") return uncertain(receiverError ?? "Original requester could not be verified");
			if (row.consumed_at) return directionDeliveryRecorded(db, row)
				? { ...view, reconciliation: "continuing" }
				: uncertain("Response claimed, but answer delivery was not recorded and there is no recorded result yet. Never wake again.");
			return { ...view, reconciliation: row.response ? "resolved" : "pending", can_respond: !row.response, can_redeliver: Boolean(row.response) };
		} catch (error) { return uncertain(errorMessage(error)); }
	}

	function uncertainEscalation(factoryId: string, scope: Partial<StoredRequest>, error: unknown): DirectionRequestView {
		const reason = errorMessage(error);
		return { factory_id: factoryId, input_id: scope.input_id ?? "", attempt_id: scope.attempt_id ?? "", task_id: scope.task_id ?? "",
			node_id: scope.node_id ?? "", node_attempt_id: scope.node_attempt_id ?? "", request_id: scope.request_id ?? `exhaust_evidence_${scope.attempt_id}`,
			question: "Revision escalation evidence unavailable", reason, created_at: "", evidence: [], choices: [], state: "unknown",
			response_recorded: null, consumption: "unknown", reconciliation: "uncertain", recovery_reason: reason, can_respond: false, can_redeliver: false,
			verdict: { state: "unknown" }, admissions: "unknown" };
	}

	function exhaustionRequests(db: DatabaseSync, factoryId: string): DirectionRequestView[] {
		if (requestVersion(db) < 11 || !bootstrap.directionExhaustions) return [];
		const attempts = db.prepare("SELECT * FROM factory_attempts WHERE factory_id = ? AND release_authorized = 1").all(factoryId) as unknown as StoredAttempt[];
		// Use identities here only to locate evidence. Validate the request and mailbox within its own attempt's boundary.
		type SavedScope = Pick<StoredRequest, "request_id" | "attempt_id" | "task_id" | "input_id" | "node_id" | "node_attempt_id">;
		const rows = db.prepare("SELECT request_id, attempt_id, task_id, input_id, node_id, node_attempt_id FROM factory_requests WHERE factory_id = ? AND substr(request_id, 1, 8) = 'exhaust_'").all(factoryId) as SavedScope[];
		const answers = db.prepare("SELECT * FROM factory_revision_escalation_answers WHERE factory_id = ?").all(factoryId) as Array<{ request_id: string; answer: string; record_digest: string }>;
		const orphanMailboxes = db.prepare("SELECT m.request_id FROM factory_direction_mailboxes m LEFT JOIN factory_requests r USING (request_id) WHERE m.factory_id = ? AND r.request_id IS NULL AND substr(m.request_id, 1, 8) = 'exhaust_'").all(factoryId) as Array<{ request_id: string }>;
		const rowsByAttempt = new Map<string, SavedScope[]>();
		for (const row of rows) {
			const group = rowsByAttempt.get(row.attempt_id);
			if (group) group.push(row);
			else rowsByAttempt.set(row.attempt_id, [row]);
		}
		const persistedIds = new Map<string, Partial<StoredRequest>>([...orphanMailboxes, ...answers, ...rows].map(row => [row.request_id, row]));
		const answerById = new Map(answers.map(answer => [answer.request_id, answer]));
		const definitions = new Map<string, ReturnType<typeof boundDirectionDefinition>>();
		const dbPath = realpathSync(path);
		const results: DirectionRequestView[] = [];
		for (const raw of attempts) {
			const saved = rowsByAttempt.get(raw.attempt_id) ?? [];
			try {
				const attempt = validateAttemptRow(raw);
				const { factory_id, input_id, attempt_id, task_id, canonical_checkout, bound_version } = attempt;
				// A proven all-success settlement cannot have exhausted a loop. Retained answers still require their original evidence.
				if (!saved.length && attempt.state === "settled" && decodeSettlement(attempt.error)?.outcome === "succeeded") continue;
				let definition = definitions.get(bound_version);
				if (!definition) {
					definition = boundDirectionDefinition(db, attempt);
					definitions.set(bound_version, definition);
				}
				if (!definition.agents.some(entry => entry.decision) && !saved.length) continue;
				const ids = { factory_id, input_id, attempt_id, task_id };
				const views = bootstrap.directionExhaustions(ids, canonical_checkout, dbPath, definition,
					(node_id, node_attempt_id) => requestDecisionEvidence(db, { ...ids, node_id, node_attempt_id }), saved.length > 0);
				for (const view of views) {
					persistedIds.delete(view.request_id);
					try {
						const row = readRequest(db, view.request_id);
						const answer = answerById.get(view.request_id);
						const receipt = retryReceipt(db, view);
						if (!row && !answer && !receipt) { results.push(view); continue; }
						if (!row || !answer || typeof answer.answer !== "string" ||
							answer.record_digest !== escalationDigest(view, row, answer.answer)) throw new Error(`Missing or damaged answer evidence for escalation ${view.request_id}`);
						const saved = requestView(row);
						const choice = saved.response?.kind === "choice" ? saved.response.choice_id : undefined;
						if (!choice || !view.choices.some(item => item.choice_id === choice) || (choice === "retry") !== Boolean(receipt) || JSON.stringify(receipt?.input_id ?? null) !== answer.answer) {
							throw new Error(`Contradictory response or retry receipt for escalation ${view.request_id}`);
						}
						results.push({ ...view, state: "responded", response_recorded: true, response: saved.response, can_respond: false, reconciliation: "resolved" });
					} catch (error) { results.push(uncertainEscalation(factoryId, view, error)); }
				}
			} catch (error) {
				if (!saved.length) results.push(uncertainEscalation(factoryId, {
					attempt_id: raw.attempt_id, task_id: raw.task_id, input_id: raw.input_id,
				}, error));
				for (const row of saved) {
					persistedIds.delete(row.request_id);
					results.push(uncertainEscalation(factoryId, row, error));
				}
			}
		}
		for (const scope of persistedIds.values()) results.push(uncertainEscalation(factoryId, scope, "Saved escalation answer has missing or contradictory finalization evidence"));
		return results;
	}

	function escalationDigest(view: DirectionRequestView, row: StoredRequest, answer: string): string {
		return sha256Hex(JSON.stringify([view.request_id, view.factory_id, view.input_id, view.attempt_id, view.task_id, view.node_attempt_id, view.exhaustion, view.verdict, row.record_digest, answer]));
	}

	function retryReceipt(db: DatabaseSync, view: DirectionRequestView): InputReceipt | undefined {
		const row = db.prepare("SELECT * FROM factory_inputs WHERE factory_id = ? AND reference = ?").get(view.factory_id, view.request_id) as StoredInput | undefined;
		return row && verifyInputRow(row);
	}

	function reconciledRequests(db: DatabaseSync, factoryId: string): DirectionRequestView[] {
		const requests = listRequests(db, factoryId).map(row => reconcileRequest(db, row));
		return [...requests, ...exhaustionRequests(db, factoryId)];
	}

	function operate(request: List): Factory[];
	function operate(request: Inspect): Inspection;
	function operate(request: PublicationTarget): Factory;
	function operate(request: ReceiptLookup): InputReceipt;
	function operate(request: VerifyManager): Omit<Factory, "current_version"> & { current_version?: string };
	function operate(request: Publish): Factory;
	function operate(request: Update): UpdateResult;
	function operate(request: Restore): UpdateResult;
	function operate(request: Binding): BindingView;
	function operate(request: Resume): ResumeResult;
	function operate(request: StopFactory): { stopped: boolean };
	function operate(request: DiscardInput): Promise<InputReceipt | undefined>;
	function operate(request: Takeover): ResumeResult;
	function operate(request: Submit): InputReceipt;
	function operate(request: Launch): Promise<LaunchResult>;
	function operate(request: RetryLaunch): Promise<LaunchResult>;
	function operate(request: CancelRun): Promise<CancelRunResult>;
	function operate(request: SettleRun): Promise<SettleRunResult>;
	function operate(request: ClearHold): Promise<ClearHoldResult>;
	function operate(request: RespondRequest): RespondRequestResult;
	function operate(request: ListRequests): DirectionRequestView[];
	function operate(request: RedeliverResponse): DirectionRequestView;
	function operate(request: RedeliverHandoff): Promise<RecoveryReport>;
	function operate(request: FactoryRead): Factory[] | Inspection | InputReceipt | Factory;
	function operate(request: FactoryRead | VerifyManager | Publish | Update | Restore | Resume | StopFactory | DiscardInput | Takeover | Submit | Launch | RetryLaunch | CancelRun | SettleRun | ClearHold | RespondRequest | ListRequests | RedeliverHandoff | RedeliverResponse): Factory[] | Inspection | InputReceipt | Factory | (Omit<Factory, "current_version"> & { current_version?: string }) | UpdateResult | BindingView | ResumeResult | Promise<LaunchResult> | Promise<InputReceipt | undefined> | Promise<CancelRunResult> | Promise<SettleRunResult> | Promise<ClearHoldResult> | RespondRequestResult | DirectionRequestView[] | DirectionRequestView | Promise<RecoveryReport> {
		if (request.action === "launch" && bootstrap.settlementObservations && !presettled.has(request)) {
			// Release capacity held by a run that has reliably settled before judging whether the head may launch; failure to settle never blocks the normal path.
			presettled.add(request);
			return (async () => {
				let settleNote: string | undefined;
				try {
					const settled = await operate({ action: "settle_run", factory_id: request.factory_id, authority: request.authority, ...(request.assertAuthorityAndTrust ? { assertAuthority: () => request.assertAuthorityAndTrust!() } : {}) });
					if (!settled.settled && settled.settlement) settleNote = `the held run was not released: ${settled.reason}`;
				} catch (error) { settleNote = `pre-launch settlement failed: ${errorMessage(error)}`; }
				try { return await operate(request); } catch (error) {
					// Launch reports the real blocker; why the pre-launch settlement did not free capacity is kept as diagnostic context, never dropped.
					if (settleNote && error instanceof Error) error.message += ` (${settleNote})`;
					throw error;
				}
			})();
		}
		if (request.action === "redeliver_handoff") return (async (): Promise<RecoveryReport> => {
			if (!bootstrap.retryFactoryDelivery) throw new Error("Factory redelivery runtime is unavailable");
			const factoryId = validateToken(request.factory_id, "factory_id");
			const view = operate({ action: "inspect", factory_id: factoryId }) as Inspection;
			const held = heldReleasedAttempt(view);
			if (!held) throw new Error("No released run holds this factory's capacity");
			const check = () => {
				request.assertAuthority?.();
				const db = openWritableWithCoord(path, coordPath);
				try {
					const manager = selectManager(db, factoryId);
					if (!manager || !authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Factory redelivery requires the current managing session authority");
					const fh = selectFactoryHold(db, factoryId);
					if (!fh || fh.attempt_id !== held.attempt_id) throw new Error("Redelivery target no longer owns the factory hold");
				} finally { db.close(); }
			};
			check();
			return bootstrap.retryFactoryDelivery(held.task_id, { agent: request.agent, ...(request.source !== undefined ? { source: request.source } : {}) }, { cwd: held.canonical_checkout, ...(request.wake ? { wake: request.wake } : {}), ...(request.senderSession ? { senderSession: request.senderSession } : {}), ...(request.signal ? { signal: request.signal } : {}) }, check);
		})();
		if (request.action === "settle_run") return (async (): Promise<SettleRunResult> => {
			if (!bootstrap.settlementObservations) throw new Error("Factory settlement runtime is unavailable");
			const factoryId = validateToken(request.factory_id, "factory_id");
			request.assertAuthority?.();
			// Settlement is judged from the same fenced evidence as inspection: contradictory or missing evidence never settles.
			const view = operate({ action: "inspect", factory_id: factoryId }) as Inspection;
			if (view.uncertainty.length > 0) return { settled: false, reason: `Evidence is uncertain: ${view.uncertainty.join("; ")}` };
			const held = heldReleasedAttempt(view);
			if (!held) {
				const heldFailed = view.attempts.find(item => !item.historical && item.state === "failed_before_release" && !item.release_authorized);
				if (!heldFailed) {
					let keptDiagnostics: RetirementDiagnostic[] = [];
					if (view.attempts.some(item => item.state === "proven_not_released") && hasUnretiredSupersededManagedRun(path, coordPath, factoryId)) {
						const db = openWritableWithCoord(path, coordPath);
						let inTx = false;
						try {
							db.exec("BEGIN IMMEDIATE");
							inTx = true;
							assertLaunchStorageSchema(db, "factory settlement");
							verifyCoordSchemaForRelease(db, coordPath);
							const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
							if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
							const manager = selectManager(db, factoryId);
							if (!manager || !authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Factory settlement requires the current managing session authority");
							keptDiagnostics = retireSupersededNonReleaseManagedRuns(db, {
								factoryId,
								factoryName: factoryRow.name,
								factoryDbPath: realpathSync(path),
								coordDbPath: realpathSync(coordPath),
								bootstrap,
							}).kept;
							request.assertAuthority?.();
							if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Settlement authority changed before commit");
							db.exec("COMMIT");
							inTx = false;
						} catch (error) {
							if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already finished */ } }
							throw error;
						} finally { db.close(); }
					}
					return {
						settled: false,
						reason: keptDiagnostics.length > 0
							? `No released attempt holds capacity (leftover managed_runs kept: ${keptDiagnostics.map(k => `${k.task_id}: ${k.reason}`).join("; ")})`
							: "No released attempt holds capacity",
						...(keptDiagnostics.length > 0 ? { retirement_diagnostics: keptDiagnostics } : {}),
					};
				}
				atLaunchCommit?.("pre_release_settle_before_tx");
				const db = openWritableWithCoord(path, coordPath);
				let inTx = false;
				try {
					db.exec("BEGIN IMMEDIATE");
					inTx = true;
					assertLaunchStorageSchema(db, "factory settlement");
					verifyCoordSchemaForRelease(db, coordPath);
					const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
					if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
					const manager = selectManager(db, factoryId);
					if (!manager || !authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Factory settlement requires the current managing session authority");
					const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(heldFailed.attempt_id) as StoredAttempt | undefined;
					if (!raw) throw new Error("Failed pre-release attempt is missing");
					const attempt = validateAttemptRow(raw);
					if (attempt.factory_id !== factoryId || attempt.state !== "failed_before_release" || attempt.release_authorized !== 0 || attempt.release_authorized_at !== null || attempt.release_token_digest !== null || attempt.release_nonce_digest !== null) {
						throw new Error("Failed pre-release attempt changed before commit");
					}
					const fHold = selectFactoryHold(db, factoryId);
					const cHold = selectCheckoutHold(db, attempt.canonical_checkout);
					const mRun = selectManagedRunByTaskId(db, attempt.task_id);
					const inputRaw = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?").get(attempt.input_id) as StoredInput | undefined;
					if (!fHold || !cHold || !mRun || !inputRaw) throw new Error("Required durable hold or input records are missing");
					const input = verifyInputRow(inputRaw);
					const canonicalDb = realpathSync(path);
					const canonicalCoord = realpathSync(coordPath);
					if (!hasConsistentUnreleasedHoldBinding({
						attempt,
						input,
						fHold,
						cHold,
						mRun,
						factoryId,
						factoryName: factoryRow.name,
						canonicalDb,
						expectedHoldState: "failed_before_release",
					})) {
						throw new Error("Pre-release non-release evidence contradicts durable holds or run association");
					}
					const proof = checkSelfSessionPreReleaseNonRelease(attempt, factoryId, factoryRow.name, canonicalDb, canonicalCoord, bootstrap);
					if (!proof.ok) {
						db.exec("ROLLBACK");
						inTx = false;
						return { settled: false, reason: `Launch failed before release and non-release is not yet proven: ${proof.reason}` };
					}
					const nowIso = new Date().toISOString();
					const next = buildAttemptRow({ ...attempt, state: "proven_not_released", error: "release permission was never committed", updated_at: nowIso });
					db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ? AND state = 'failed_before_release' AND release_authorized = 0")
						.run(next.state, next.error, next.updated_at, next.record_digest, next.attempt_id);
					request.assertAuthority?.();
					if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Settlement authority changed before commit");
					db.exec("COMMIT");
					inTx = false;
					return { settled: false, proven_not_released: true, reason: `Attempt ${attempt.attempt_id} is proven not released and eligible for /factory retry ${factoryId} ${attempt.input_id} ${attempt.attempt_id}` };
				} catch (error) {
					if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already finished */ } }
					throw error;
				} finally { db.close(); }
			}
			const db = openWritableWithCoord(path, coordPath);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				assertLaunchStorageSchema(db, "factory settlement");
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				const manager = selectManager(db, factoryId);
				if (!manager || !authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Factory settlement requires the current managing session authority");
				const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(held.attempt_id) as StoredAttempt | undefined;
				if (!raw) throw new Error("Settlement target attempt is missing");
				const attempt = validateAttemptRow(raw);
				if (attempt.factory_id !== factoryId || attempt.state !== "released" || attempt.release_authorized !== 1) throw new Error("Settlement target changed before commit");
				const { fHold, cHold } = assertOwnsBothHolds(db, factoryId, attempt, path, "Settlement target");
				const inputRaw = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?").get(attempt.input_id) as StoredInput | undefined;
				if (!inputRaw) throw new Error("Settlement input is missing");
				verifyInputRow(inputRaw);
				if (inputRaw.disposition !== "running") throw new Error(`Settlement input is "${inputRaw.disposition}", not running`);
				// Re-observe inside the write transaction: only evidence read at the commit counts.
				const observed = bootstrap.settlementObservations(attempt.task_id, attempt.canonical_checkout);
				if (observed.execution_settlement.state !== "settled") {
					db.exec("ROLLBACK");
					inTx = false;
					return { settled: false, reason: `Execution is ${observed.execution_settlement.state}: ${observed.execution_settlement.reason}`, settlement: { ...observed, capacity_release: "held" } };
				}
				const nowIso = new Date().toISOString();
				const next = buildAttemptRow({ ...attempt, state: "settled", error: encodeSettlement(observed, nowIso, { factory_held_at: fHold.held_at, checkout_held_at: cHold.held_at }), updated_at: nowIso });
				db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ? AND state = 'released'").run(next.state, next.error, next.updated_at, next.record_digest, next.attempt_id);
				const nextInput = buildInputRow({ ...inputRaw, disposition: "settled" });
				db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(nextInput.disposition, nextInput.record_digest, nextInput.input_id);
				db.prepare("DELETE FROM factory_holds WHERE factory_id = ? AND attempt_id = ?").run(factoryId, attempt.attempt_id);
				db.prepare("DELETE FROM coord.checkout_holds WHERE canonical_checkout = ? AND attempt_id = ?").run(attempt.canonical_checkout, attempt.attempt_id);
				// The coordination association is retired with the holds so no other factory on this checkout reads it as an orphan; the attempt row keeps the history.
				db.prepare("DELETE FROM coord.managed_runs WHERE task_id = ? AND attempt_id = ?").run(attempt.task_id, attempt.attempt_id);
				const keptDiagnostics = retireSupersededNonReleaseManagedRuns(db, {
					factoryId,
					factoryName: factoryRow.name,
					factoryDbPath: realpathSync(path),
					coordDbPath: realpathSync(coordPath),
					bootstrap,
					inputId: attempt.input_id,
				}).kept;
				// A settled attempt can no longer act on any request: close what is still open so it is neither answered nor consumed later.
				if (hasRequestTables(db)) fenceAttempt(db, attempt.attempt_id, observed.outcome === "cancelled" ? "cancelled" : observed.outcome === "failed" ? "failed" : "closed");
				request.assertAuthority?.();
				if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Settlement authority changed before commit");
				atLaunchCommit?.("settle_before_commit");
				db.exec("COMMIT");
				inTx = false;
				atLaunchCommit?.("settle_after_commit");
				return {
					settled: true,
					reason: observed.execution_settlement.reason,
					settlement: { ...observed, capacity_release: "released", settled_at: nowIso },
					...(keptDiagnostics.length > 0 ? { retirement_diagnostics: keptDiagnostics } : {}),
				};
			} catch (error) {
				if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already finished */ } }
				throw error;
			} finally { db.close(); }
		})();
		if (request.action === "clear_hold") return (async (): Promise<ClearHoldResult> => {
			if (typeof request.confirm !== "function") throw new Error("Clearing a hold requires direct human confirmation, not a confirmed flag");
			if (!bootstrap.settlementObservations) throw new Error("Factory settlement runtime is unavailable");
			const factoryId = validateToken(request.factory_id, "factory_id");
			const inputId = validateToken(request.input_id, "input_id");
			const attemptId = validateToken(request.attempt_id, "attempt_id");
			const taskId = validateToken(request.task_id, "task_id");
			// Eligibility is judged from the same fenced evidence as inspection, before the dialog and again after it.
			const eligibleTarget = (): { held: AttemptSummary; target: ClearanceTarget } => {
				request.assertAuthority?.();
				const view = operate({ action: "inspect", factory_id: factoryId }) as Inspection;
				const held = view.attempts.find(item => item.attempt_id === attemptId && !item.historical);
				if (!held || held.input_id !== inputId || held.task_id !== taskId) throw new Error("Clearance target is not the run that holds this factory's capacity; inspect again");
				const eligibility = held.clearance_eligibility;
				if (!eligibility?.eligible || !eligibility.holds.factory_held_at || !eligibility.holds.checkout_held_at) throw new Error(`Clearance refused: ${eligibility?.reason ?? "this hold is not eligible for clearance"}`);
				return { held, target: Object.freeze({ factory_id: factoryId, input_id: inputId, attempt_id: attemptId, task_id: taskId, bound_version: held.bound_version, canonical_checkout: held.canonical_checkout, holds: { factory_held_at: eligibility.holds.factory_held_at, checkout_held_at: eligibility.holds.checkout_held_at }, missing_or_contradictory: eligibility.missing_or_contradictory, evidence_problems: eligibility.evidence_problems, evidence_unreadable: eligibility.evidence_unreadable, action: eligibility.action, consequences: eligibility.consequences }) };
			};
			const first = eligibleTarget();
			const decision = await request.confirm(first.target);
			if (!decision) return { cleared: false, target: first.target };
			const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
			const evidence = typeof decision.evidence === "string" ? decision.evidence.trim() : "";
			if (!reason || !evidence || decision.acknowledged_unknown_effects !== true) throw new Error("Clearance requires a reason, supporting evidence that the original work cannot resume, and acknowledgement that past effects are unknown");
			const { target } = eligibleTarget();
			if (JSON.stringify(target) !== JSON.stringify(first.target)) throw new Error("The confirmed clearance target changed during confirmation; inspect again");
			const db = openWritableWithCoord(path, coordPath);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				assertLaunchStorageSchema(db, "factory clearance");
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				const manager = selectManager(db, factoryId);
				if (!manager || !authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Factory clearance requires the current managing session authority");
				const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(attemptId) as StoredAttempt | undefined;
				if (!raw) throw new Error("Clearance target attempt is missing");
				const attempt = validateAttemptRow(raw);
				if (attempt.factory_id !== factoryId || attempt.input_id !== inputId || attempt.task_id !== taskId || attempt.bound_version !== target.bound_version || attempt.state !== "released" || attempt.release_authorized !== 1) throw new Error("Clearance target identity or eligibility changed before commit");
				const { fHold, cHold } = assertOwnsBothHolds(db, factoryId, attempt, path, "Clearance target");
				if (fHold.held_at !== target.holds.factory_held_at || cHold.held_at !== target.holds.checkout_held_at) throw new Error("Clearance holds changed after confirmation");
				const inputRaw = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?").get(inputId) as StoredInput | undefined;
				if (!inputRaw) throw new Error("Clearance input is missing");
				verifyInputRow(inputRaw);
				if (inputRaw.disposition === "settled" || inputRaw.disposition === "cleared") throw new Error(`Clearance input is already "${inputRaw.disposition}"`);
				// Re-observe inside the write transaction: affirmative evidence that work may resume can never be overcome by confirmation.
				let observed: SettlementObservations;
				// Fail closed: a run that was readable when the dialog was shown and is unreadable at commit is refused. Evidence that was already unreadable when shown is part of what the human accepted.
				try { observed = bootstrap.settlementObservations(taskId, attempt.canonical_checkout); } catch (error) {
					const unreadable = `settlement evidence is unreadable: ${errorMessage(error)}`;
					if (!target.evidence_unreadable) throw new Error(`Clearance refused: the run could not be observed at commit (${errorMessage(error)})`);
					observed = { evidence_unreadable: true, cancellation: { intent: "unknown", error: unreadable }, resource_closure: { state: "unknown", recorded_closed: [], not_recorded_closed: [] }, execution_settlement: { state: "unknown", reason: unreadable }, outcome: "incomplete", resume_risk: [], attention: [] };
				}
				if (observed.evidence_unreadable && !target.evidence_unreadable && observed.resume_risk.length === 0) throw new Error("Clearance refused: the run could not be observed at commit");
				if (observed.resume_risk.length > 0) throw new Error(`Clearance refused: conflicting work may still resume; stop or isolate it first: ${observed.resume_risk.join("; ")}`);
				// Eligibility is recomputed from the commit-time observation: a run that became reliably settled with consistent own records is settled, not cleared.
				const missingNow = [...target.evidence_problems, ...(observed.execution_settlement.state !== "settled" ? [observed.execution_settlement.reason] : [])];
				if (missingNow.length === 0) throw new Error("Clearance refused: execution is now reliably settled and the evidence is consistent; settle the run instead");
				const managedRunRaw = db.prepare("SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest FROM coord.managed_runs WHERE task_id = ? AND attempt_id = ?").get(taskId, attemptId) as StoredManagedRun | undefined;
				const nowIso = new Date().toISOString();
				const clearance: ClearanceRecord = { cleared_at: nowIso, reason, evidence, acknowledged_unknown_effects: true, prior_input_disposition: inputRaw.disposition, missing_or_contradictory: missingNow, observations: observed, released_holds: target.holds, source_records: { input: { ...inputRaw }, managed_run: managedRunRaw ? { ...managedRunRaw } : null, factory_hold: { ...fHold }, checkout_hold: { ...cHold } } };
				const next = buildAttemptRow({ ...attempt, state: "cleared", error: encodeClearance(clearance), updated_at: nowIso });
				db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ? AND state = 'released'").run(next.state, next.error, next.updated_at, next.record_digest, next.attempt_id);
				const nextInput = buildInputRow({ ...inputRaw, disposition: "cleared" });
				db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(nextInput.disposition, nextInput.record_digest, nextInput.input_id);
				db.prepare("DELETE FROM factory_holds WHERE factory_id = ? AND attempt_id = ?").run(factoryId, attemptId);
				db.prepare("DELETE FROM coord.checkout_holds WHERE canonical_checkout = ? AND attempt_id = ?").run(attempt.canonical_checkout, attemptId);
				db.prepare("DELETE FROM coord.managed_runs WHERE task_id = ? AND attempt_id = ?").run(taskId, attemptId);
				const keptDiagnostics = retireSupersededNonReleaseManagedRuns(db, {
					factoryId,
					factoryName: factoryRow.name,
					factoryDbPath: realpathSync(path),
					coordDbPath: realpathSync(coordPath),
					bootstrap,
					inputId,
				}).kept;
				// A cleared attempt can no longer act on any request: close what is still open so it is neither answered nor consumed later.
				if (hasRequestTables(db)) fenceAttempt(db, attemptId, "closed");
				request.assertAuthority?.();
				if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Clearance authority changed before commit");
				atLaunchCommit?.("clear_before_commit");
				db.exec("COMMIT");
				inTx = false;
				atLaunchCommit?.("clear_after_commit");
				return {
					cleared: true,
					target,
					clearance,
					...(keptDiagnostics.length > 0 ? { retirement_diagnostics: keptDiagnostics } : {}),
				};
			} catch (error) {
				if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already finished */ } }
				throw error;
			} finally { db.close(); }
		})();
		if (request.action === "requests") {
			// A cheap, strictly read-only list for the managing session's alerts: it never resumes, repairs or settles anything.
			const factoryId = validateToken(request.factory_id, "factory_id");
			if (!databaseExists(path)) throw new Error(`Factory storage is missing; direction evidence for ${factoryId} cannot be verified`);
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
				if (schemaVersion(db) === 0 || !db.prepare("SELECT 1 FROM factories WHERE factory_id = ?").get(factoryId)) throw missing(factoryId);
				return reconciledRequests(db, factoryId);
			} catch (error) { throw readFailure(error); }
			finally { db.close(); }
		}
		if (request.action === "respond_request" || request.action === "redeliver_response") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const requestId = validateToken(request.request_id, "request_id");
			request.assertAuthority?.();
			const authority = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			try {
				if (isEscalationRequest(requestId)) {
					if (request.action !== "respond_request") throw new Error("An exhaustion request has no worker to wake");
					const result = inTransaction(db, () => {
						const manager = selectManager(db, factoryId);
						if (!manager || !authorityMatches(manager, authority)) throw new Error("Escalation response requires the current managing session authority");
						request.assertAuthority?.();
						const view = exhaustionRequests(db, factoryId).find(item => item.request_id === requestId);
						if (!view) throw new Error(`Exhaustion request not found: ${requestId}`);
						if (view.reconciliation === "uncertain") throw new Error(`Cannot verify exhaustion request ${requestId}: ${view.recovery_reason}`);
						const response = request.response as { kind?: unknown; choice_id?: "retry" | "takeover" | "discard" } | undefined;
						const choice = response?.choice_id;
						if (response?.kind !== "choice" || !choice || !view.choices.some(item => item.choice_id === choice) || Object.keys(response).some(key => key !== "kind" && key !== "choice_id")) throw new Error("Choose retry, takeover or discard for this exhaustion request (or leave it unanswered)");
						const brief = choice === "retry" ? validateBrief(request.newBrief) : undefined;
						if (view.response_recorded) {
							const receipt = retryReceipt(db, view);
							if (view.response?.kind !== "choice" || view.response.choice_id !== choice || receipt?.brief !== brief?.brief) throw new Error("Escalation already has a different recorded response or brief");
							return { request: view, replayed: true, retry_receipt: receipt };
						}
						if (choice !== "retry") {
							const { factory_id, input_id, task_id, request_id, node_attempt_id, exhaustion } = view;
							const target = Object.freeze({ factory_id, input_id, task_id, request_id, node_attempt_id, exhaustion: Object.freeze({ ...exhaustion! }), choice });
							if (typeof request.confirmExhaustion !== "function" || request.confirmExhaustion(target) !== true) throw new Error(`${choice} requires direct human confirmation of this exhaustion request`);
						}
						request.assertAuthority?.();
						if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Escalation response requires the current managing session authority");
						const factoryRow = db.prepare("SELECT * FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory;
						const state = verifyStateRow(selectState(db, factoryId), factoryRow);
						const retry_receipt = brief && admitInput(db, factoryRow, state, requestId, brief);
						const row = saveEscalationResponse(db, view, { kind: "choice", choice_id: choice }, { incarnation_id: manager.incarnation_id, pi_session_id: manager.pi_session_id });
						const answer = JSON.stringify(retry_receipt?.input_id ?? null);
						db.prepare("INSERT INTO factory_revision_escalation_answers VALUES (?, ?, ?, ?)").run(requestId, factoryId, answer, escalationDigest(view, row, answer));
						atCommit?.("before_commit");
						return { request: { ...view, state: "responded" as const, response_recorded: true, response: requestView(row).response, can_respond: false, reconciliation: "resolved" as const }, replayed: false, retry_receipt };
					});
					if (!result.replayed) atCommit?.("after_commit");
					return result;
				}
				const target = () => {
					const manager = selectManager(db, factoryId);
					if (!manager || !authorityMatches(manager, authority)) throw new Error("Direction recovery requires the current managing session authority");
					request.assertAuthority?.();
					const row = readRequest(db, requestId);
					if (!row || row.factory_id !== factoryId) throw new Error(`Request not found: ${requestId}`);
					return { manager, row };
				};
				const sendWake = (strict: boolean) => inTransaction(db, () => {
					const { row } = target();
					const view = reconcileRequest(db, row);
					if (!view.can_redeliver) {
						if (strict) throw new Error(`Request ${requestId}: no wake sent. ${view.recovery_reason ?? "Need a saved, unconsumed response and a verified waiting attempt."}`);
						return view;
					}
					request.assertAuthority?.();
					wakeResponse(db, row);
					return view;
				});
				if (request.action === "redeliver_response") return sendWake(true);
				const { replayed } = inTransaction(db, () => {
					const { manager, row } = target();
					if (row.state === "pending") {
						const view = reconcileRequest(db, row);
						if (!view.can_respond) throw new Error(`Cannot verify that request ${requestId} can be answered: ${view.recovery_reason}`);
					}
					const saved = recordResponse(db, requestId, factoryId, request.response, { incarnation_id: manager.incarnation_id, pi_session_id: manager.pi_session_id });
					if (!saved.replayed) atCommit?.("before_commit");
					return saved;
				});
				if (!replayed) atCommit?.("after_commit");
				// The response is already durable. Losing this wake or its acknowledgement cannot change it.
				return { request: sendWake(false), replayed };
			} finally { db.close(); }
		}
		if (request.action === "cancel_run") return (async () => {
			if (typeof request.confirm !== "function") throw new Error("Factory cancellation requires direct human confirmation, not a confirmed flag");
			if (!bootstrap.cancelFactoryRun) throw new Error("Factory cancellation runtime is unavailable");
			const factoryId = validateToken(request.factory_id, "factory_id");
			const inputId = validateToken(request.input_id, "input_id");
			const attemptId = validateToken(request.attempt_id, "attempt_id");
			const taskId = validateToken(request.task_id, "task_id");
			let target: FactoryCancellationTarget | undefined;
			const authorized = (write?: (attempt: StoredAttempt, db: DatabaseSync) => void) => {
				request.assertAuthority?.();
				const authority = requireAuthority(request.authority);
				const db = openWritableWithCoord(path, coordPath);
				try {
					db.exec("BEGIN IMMEDIATE");
					assertLaunchStorageSchema(db, "factory cancellation");
					const manager = selectManager(db, factoryId);
					if (!manager || !authorityMatches(manager, authority)) throw new Error("Factory cancellation requires the current managing session authority");
					const raw = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(attemptId) as StoredAttempt | undefined;
					if (!raw) throw new Error("Cancellation target attempt is missing");
					const attempt = validateAttemptRow(raw);
					if (attempt.factory_id !== factoryId || attempt.input_id !== inputId || attempt.task_id !== taskId || attempt.state !== "released" || attempt.release_authorized !== 1) throw new Error("Cancellation target identity or release eligibility changed");
					assertOwnsBothHolds(db, factoryId, attempt, path, "Cancellation target");
					request.assertAuthority?.();
					if (!authorityMatches(manager, requireAuthority(request.authority))) throw new Error("Cancellation authority changed before intent commit");
					write?.(attempt, db);
					db.exec("COMMIT");
					return attempt;
				} catch (error) { try { db.exec("ROLLBACK"); } catch { /* already committed */ } throw error; }
				finally { db.close(); }
			};
			const attempt = authorized();
			target = Object.freeze({ factory_id: factoryId, input_id: inputId, attempt_id: attemptId, task_id: taskId, bound_version: attempt.bound_version, consequences: "Cancel this exact run, including parked nodes and future revisions. In-flight tools may still act. This does not close tabs, prove settlement, undo effects, or release either capacity hold." });
			if (!(await request.confirm(target))) return { cancelled: false, target };
			authorized();
			await bootstrap.cancelFactoryRun(taskId, (manifest, writeIntent) => authorized((current, db) => {
				const meta = manifest.factory_managed;
				if (!meta || meta.factory_id !== factoryId || meta.input_id !== inputId || meta.attempt_id !== attemptId || meta.bound_version !== target!.bound_version || manifest.task_id !== taskId || meta.request_id !== current.request_id || meta.state_db_path !== realpathSync(path) || meta.coord_db_path !== realpathSync(coordPath)) throw new Error("Cancellation run/session binding changed before intent commit");
				// Cancellation and a racing response are ordered by this one transaction: the fence closes pending requests and voids unconsumed responses.
				if (hasRequestTables(db)) fenceAttempt(db, attemptId, "cancelled");
				writeIntent();
			}), attempt.canonical_checkout);
			return { cancelled: true, target };
		})();
		if (request.action === "publish") {
			const name = request.name.trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("Factory name must be 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit");
			validateDraftShape(request.draft);
			const prepared = bootstrap.prepareDefinition(request.draft, request.sessionModel);
			const definition = JSON.stringify(prepared);
			const definitionDigest = digest(definition);
			const identity = { factory_id: randomUUID(), name };
			const db = openWritableDb(path, true)!;
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				ensureCurrentSchema(db);
				const existing = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE name = ?").get(name) as StoredFactory | undefined;
				if (existing) {
					const currentVersion = selectPointer(db, existing.factory_id)?.current_version ?? "v1";
					throw new Error(`Factory "${name}" is already published; its ${currentVersion} is unchanged`);
				}
				db.prepare("INSERT INTO factories (factory_id, name, definition, digest) VALUES (?, ?, ?, ?)").run(identity.factory_id, name, definition, definitionDigest);
				insertInitialControl(db, identity.factory_id, new Date().toISOString());
				const initialState = buildStateRow(identity.factory_id, 0, 0);
				db.prepare("INSERT INTO factory_state (factory_id, established, last_input_position, record_digest) VALUES (?, ?, ?, ?)").run(
					initialState.factory_id,
					initialState.established,
					initialState.last_input_position,
					initialState.record_digest,
				);
				{
					const nowIso = new Date().toISOString();
					const v1 = buildFactoryVersionRow({
						factory_id: identity.factory_id,
						version: "v1",
						version_num: 1,
						definition,
						digest: definitionDigest,
						restored_from_version: null,
						created_at: nowIso,
					});
					db.prepare(
						"INSERT INTO factory_versions (factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					).run(v1.factory_id, v1.version, v1.version_num, v1.definition, v1.digest, v1.restored_from_version, v1.created_at, v1.record_digest);
					const ptr = buildFactoryPointerRow({
						factory_id: identity.factory_id,
						current_version: "v1",
						current_version_num: 1,
						definition_digest: definitionDigest,
						updated_at: nowIso,
					});
					db.prepare(
						"INSERT INTO factory_pointers (factory_id, current_version, current_version_num, definition_digest, updated_at, record_digest) VALUES (?, ?, ?, ?, ?, ?)",
					).run(ptr.factory_id, ptr.current_version, ptr.current_version_num, ptr.definition_digest, ptr.updated_at, ptr.record_digest);
				}
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Publication outcome uncertain for "${name}" (${identity.factory_id}); inspect with /factory list before retrying: ${error}`);
				}
				return summary(identity);
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "update" || request.action === "restore") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const expectedCurrent = request.expected_current_version !== undefined
				? parseVersionToken(request.expected_current_version, "expected_current_version").version
				: undefined;
			const restoreFrom = request.action === "restore" ? parseVersionToken(request.from_version, "from_version").version : undefined;
			// An update resolves a new draft exactly as publication does; a restore reuses a retained payload verbatim and never re-resolves anything.
			let publication: { definition: string; digest: string } | undefined;
			if (request.action === "update") {
				validateDraftShape(request.draft);
				const definition = JSON.stringify(bootstrap.prepareDefinition(request.draft, request.sessionModel));
				publication = { definition, digest: digest(definition) };
			}
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				const priorSchema = schemaVersion(db);
				if (priorSchema === 0) throw new Error(`Factory not found: ${factoryId}`);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				verifyStoredFactory(factoryRow);
				ensureV6Schema(db);
				const { manager: existingManager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				// The manager row cannot change while this write transaction is open, so it is the authority evidence checked here and at commit.
				const assertPublicationAuthority = (gate: string) => {
					if (existingManager) {
						const live = requireAuthority(request.authority);
						if (!authorityMatches(existingManager, live)) {
							throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}) at ${gate}; only the active managing session can ${request.action}`);
						}
					}
					request.assertAuthority?.();
				};
				assertPublicationAuthority("start");
				const catalog = loadFactoryVersionCatalog(db, 5, factoryRow, { strictHistory: true });
				if (expectedCurrent !== undefined && catalog.currentVersion !== expectedCurrent) {
					throw new Error(
						`Factory "${factoryRow.name}" (${factoryRow.factory_id}) current version changed from ${expectedCurrent} to ${catalog.currentVersion}; inspect before retrying`,
					);
				}
				if (restoreFrom !== undefined) {
					if (restoreFrom === catalog.currentVersion) {
						throw new Error(`Version ${restoreFrom} is already the current version of "${factoryRow.name}" (${factoryRow.factory_id}); nothing to restore`);
					}
					const source = resolveBoundVersion(catalog, factoryRow, restoreFrom);
					if (!source.definition || !source.raw) {
						throw new Error(source.error ?? `Version "${restoreFrom}" not found for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
					}
					if (!bootstrap.prepareFromDefinition) throw new Error("Live validation of a preserved version is unavailable; restore refused");
					// Same live validation as launch preflight, so an incompatible preserved definition is rejected before anything is written.
					try { bootstrap.prepareFromDefinition(source.definition, { checkHerdrEnv: false }); }
					catch (error) { throw new Error(`Cannot restore ${restoreFrom} of "${factoryRow.name}" (${factoryRow.factory_id}): ${errorMessage(error)}`); }
					publication = { definition: source.raw.definition, digest: source.raw.digest };
				}
				const { definition, digest: definitionDigest } = publication!;
				const nextNum = catalog.currentNum + 1;
				const nextVersion = `v${nextNum}`;
				const nowIso = new Date().toISOString();
				const nextRow = buildFactoryVersionRow({
					factory_id: factoryRow.factory_id,
					version: nextVersion,
					version_num: nextNum,
					definition,
					digest: definitionDigest,
					restored_from_version: restoreFrom ?? null,
					created_at: nowIso,
				});
				db.prepare(
					"INSERT INTO factory_versions (factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				).run(nextRow.factory_id, nextRow.version, nextRow.version_num, nextRow.definition, nextRow.digest, nextRow.restored_from_version, nextRow.created_at, nextRow.record_digest);
				const nextPointer = buildFactoryPointerRow({
					factory_id: factoryRow.factory_id,
					current_version: nextVersion,
					current_version_num: nextNum,
					definition_digest: definitionDigest,
					updated_at: nowIso,
				});
				db.prepare(
					"UPDATE factory_pointers SET current_version = ?, current_version_num = ?, definition_digest = ?, updated_at = ?, record_digest = ? WHERE factory_id = ?",
				).run(nextPointer.current_version, nextPointer.current_version_num, nextPointer.definition_digest, nextPointer.updated_at, nextPointer.record_digest, nextPointer.factory_id);
				atCommit?.("before_commit");
				assertPublicationAuthority("commit boundary");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`${request.action === "restore" ? "Restore" : "Update"} outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}, target ${nextVersion}); inspect with /factory inspect ${factoryRow.factory_id} before retrying: ${error}`);
				}
				return {
					factory: summary(factoryRow, existingManager ? "managed" : "unmanaged", nextVersion),
					version: nextVersion,
					digest: definitionDigest,
					created_at: nowIso,
					...(restoreFrom !== undefined ? { restored_from_version: restoreFrom } : {}),
				};
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "takeover") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const authRecord = requireAuthority(request.authority);
			if (request.confirmed_manager_incarnation_id !== request.confirmed_manager_incarnation_id.trim() || request.confirmed_manager_incarnation_id.length === 0) throw new Error("Takeover confirmation must name the exact current manager incarnation");
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE"); inTx = true;
				const schema = schemaVersion(db);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				if (schema < 2) throw new Error(`Factory "${factoryRow.name}" is unmanaged; resume management first`);
				verifyStoredFactory(factoryRow);
				const { manager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				if (!manager) throw missingManagerCorruptionError(factoryRow);
				if (manager.incarnation_id !== request.confirmed_manager_incarnation_id) throw new Error("Takeover confirmation does not match the exact current manager incarnation; inspect again");
				if (priorManagerCanStillRun(manager)) throw new Error(`Cannot take over factory "${factoryRow.name}": recorded manager process ${manager.pid} with the confirmed boot/process incarnation is still alive`);
				// Validate strict retained history before replacing authority; a failure must leave the old manager intact.
				const takeoverCurrentVersion = schema >= 5 ? loadFactoryVersionCatalog(db, schema, factoryRow, { strictHistory: true }).currentVersion : "v1";
				const keptDiagnostics = schema >= 4 ? reconcileProvenNonRelease(db, factoryId, realpathSync(path), coordPath, factoryRow.name, bootstrap) : [];
				ensureCurrentSchema(db);
				const replacement: Omit<StoredManager, "record_digest"> = { factory_id: factoryId, incarnation_id: authRecord.incarnation_id, authority_digest: authRecord.secret_digest, pi_session_id: authRecord.pi_session_id, pi_session_file: authRecord.pi_session_file, pid: authRecord.pid, resumed_at: new Date().toISOString() };
				db.prepare("UPDATE factory_managers SET incarnation_id=?, authority_digest=?, pi_session_id=?, pi_session_file=?, pid=?, resumed_at=?, record_digest=? WHERE factory_id=? AND incarnation_id=?").run(replacement.incarnation_id, replacement.authority_digest, replacement.pi_session_id, replacement.pi_session_file, replacement.pid, replacement.resumed_at, managerRecordDigest(replacement), factoryId, manager.incarnation_id);
				if (Number(db.prepare("SELECT changes() AS n").get() && (db.prepare("SELECT changes() AS n").get() as { n: number }).n) !== 1) throw new Error("Takeover lost an exclusive manager race; inspect and retry explicitly");
				db.exec("COMMIT"); inTx = false;
				return {
					factory: summary(factoryRow, "managed", takeoverCurrentVersion),
					resumed: true,
					already_managed: false,
					...(keptDiagnostics.length > 0 ? { retirement_diagnostics: keptDiagnostics } : {}),
				};
			} finally { if (inTx) try { db.exec("ROLLBACK"); } catch {} db.close(); }
		}

		if (request.action === "resume") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const authRecord = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				const priorVersion = schemaVersion(db);
				if (priorVersion === 0) throw new Error(`Factory not found: ${factoryId}`);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				verifyStoredFactory(factoryRow);
				ensureCurrentSchema(db);
				const currentVersion = loadFactoryVersionCatalog(db, 7, factoryRow, { strictHistory: true }).currentVersion;
				const { manager: existingManager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				if (existingManager) {
					if (!authorityMatches(existingManager, authRecord)) throw new Error(
						`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is already managed by another session; orphaned or active managers are not replaced in this slice`,
					);
				}
				if (!existingManager) {
					const manager: Omit<StoredManager, "record_digest"> = {
						factory_id: factoryId,
						incarnation_id: authRecord.incarnation_id,
						authority_digest: authRecord.secret_digest,
						pi_session_id: authRecord.pi_session_id,
						pi_session_file: authRecord.pi_session_file,
						pid: authRecord.pid,
						resumed_at: new Date().toISOString(),
					};
					db.prepare(
						"INSERT INTO factory_managers (factory_id, incarnation_id, authority_digest, pi_session_id, pi_session_file, pid, resumed_at, record_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					).run(factoryId, manager.incarnation_id, manager.authority_digest, manager.pi_session_id, manager.pi_session_file, manager.pid, manager.resumed_at, managerRecordDigest(manager));
					const state = buildStateRow(factoryId, 1, 0);
					db.prepare("UPDATE factory_state SET established = ?, last_input_position = ?, record_digest = ? WHERE factory_id = ?").run(state.established, state.last_input_position, state.record_digest, factoryId);
				}
				setFactoryStopped(db, factoryId, false);
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Resume outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}); inspect with /factory inspect ${factoryRow.factory_id} or retry /factory resume ${factoryRow.factory_id}: ${error}`);
				}
				return { factory: summary(factoryRow, "managed", currentVersion), resumed: true, already_managed: !!existingManager };
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "stop") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const auth = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			try { return inTransaction(db, () => {
				const manager = schemaVersion(db) >= 2 ? selectManager(db, factoryId) : undefined;
				if (!manager || !authorityMatches(manager, auth)) throw new Error("Factory control requires the current managing session authority");
				ensureCurrentSchema(db);
				setFactoryStopped(db, factoryId, true);
				return { stopped: true };
			}); } finally { db.close(); }
		}
		if (request.action === "discard") return (async () => {
			if (typeof request.confirm !== "function") throw new Error("Discard requires direct human confirmation, not a confirmed flag");
			const factoryId = validateToken(request.factory_id, "factory_id");
			const inputId = validateToken(request.input_id, "input_id");
			request.assertAuthority?.();
			const auth = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			try {
				const readTarget = () => {
					const row = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ? AND factory_id = ?").get(inputId, factoryId) as StoredInput | undefined;
					if (!row) throw new Error("Discard input not found");
					const receipt = verifyInputRow(row);
					if (receipt.disposition !== "queued") throw new Error(`Discard refused: input is ${receipt.disposition}; launch may have started`);
					return receipt;
				};
				const targetReceipt = readTarget();
				let queuePosition = targetReceipt.queue_position;
				let positionKind: "waiting" | "acceptance" = "acceptance";
				try {
					const earlier = db.prepare("SELECT input_id, disposition FROM factory_inputs WHERE factory_id = ? AND queue_position < ?").all(factoryId, targetReceipt.queue_position) as Pick<StoredInput, "input_id" | "disposition">[];
					const attempts = schemaVersion(db) >= 4 ? selectAttemptsWithTokens(db, factoryId).attempts : [];
					queuePosition = waitingInputs(earlier, attempts).length + 1;
					positionKind = "waiting";
				} catch { /* Display only: unrelated attempt evidence must not prevent discard of an intact queued input. */ }
				const target = Object.freeze({ factory_id: factoryId, input_id: inputId, reference: targetReceipt.reference, queue_position: queuePosition, queue_position_kind: positionKind, bound_version: targetReceipt.bound_version, consequences: "Retain this receipt permanently and remove this unstarted input from launch eligibility; this cannot cancel a started run." });
				if (!(await request.confirm(target))) return undefined;
				request.assertAuthority?.();
				return inTransaction(db, () => {
					const manager = selectManager(db, factoryId);
					if (!manager || !authorityMatches(manager, auth)) throw new Error("Discard requires the current managing session authority");
					request.assertAuthority?.();
					const current = readTarget();
					if (current.input_id !== target.input_id || current.queue_position !== targetReceipt.queue_position || current.bound_version !== target.bound_version || current.disposition !== targetReceipt.disposition) throw new Error("Discard target changed during confirmation; inspect again");
					const row = db.prepare("SELECT * FROM factory_inputs WHERE input_id = ? AND factory_id = ?").get(inputId, factoryId) as StoredInput;
					const next = buildInputRow({ ...row, disposition: "discarded" });
					db.prepare("UPDATE factory_inputs SET disposition=?, record_digest=? WHERE input_id=? AND disposition=?").run(next.disposition, next.record_digest, inputId, row.disposition);
					return { ...current, disposition: "discarded" as const };
				});
			} finally { db.close(); }
		})();

		if (request.action === "submit") {
			const factoryId = validateToken(request.factory_id, "factory_id");
			const reference = validateToken(request.reference, "reference");
			const { brief, brief_bytes, brief_digest } = validateBrief(request.brief);
			const authRecord = requireAuthority(request.authority);
			const db = openWritableDb(path, false);
			if (!db) throw new Error(`Factory not found: ${factoryId}`);
			let inTx = false;
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
				const version = schemaVersion(db);
				if (version === 0) throw new Error(`Factory not found: ${factoryId}`);
				const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
				if (version === 1) {
					verifyStoredFactory(factoryRow);
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
				}
				const { state, manager: existingManager } = verifyEstablishedState(
					factoryRow,
					selectState(db, factoryId),
					selectManager(db, factoryId),
					hasAcceptedInputs(db, factoryId),
				);
				if (!existingManager) {
					throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
				}
				if (!authorityMatches(existingManager, authRecord)) {
					throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can submit`);
				}
				const existingStored = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND reference = ?",
				).get(factoryId, reference) as StoredInput | undefined;
				if (existingStored) {
					// An exact retry is a point lookup of the receipt already accepted: it needs only that intact row and the owner's authority, never the
					// current version metadata that admitting new work must validate. Like the read-only receipt, it reports the current version only when it
					// verifies, never infers it from damaged evidence, and never rebinds, writes or mutates anything.
					let retryCurrentVersion: string | undefined;
					try { retryCurrentVersion = loadFactoryVersionCatalog(db, version, factoryRow, { strictHistory: false }).currentVersion; } catch { retryCurrentVersion = undefined; }
					const verified = verifyInputRow(existingStored, retryCurrentVersion);
					if (verified.queue_position > state.last_input_position) {
						throw new Error(
							`Factory storage corruption detected for "${factoryRow.name}" (${factoryRow.factory_id}): input ${verified.input_id} position ${verified.queue_position} exceeds durable high-water mark ${state.last_input_position}`,
						);
					}
					if (verified.brief !== brief || existingStored.brief_digest !== brief_digest) {
						throw new Error(`Submission conflict for factory "${factoryRow.name}" (${factoryRow.factory_id}): reference "${reference}" already exists with a different brief`);
					}
					db.exec("COMMIT");
					inTx = false;
					return verified;
				}
				if (/^exhaust_[0-9a-f]{64}$/.test(reference)) throw new Error("That submission reference is reserved for a revision escalation response");
				ensureCurrentSchema(db);
				const accepted = admitInput(db, factoryRow, state, reference, { brief, brief_bytes, brief_digest });
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					inTx = false;
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Submission outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}, reference "${reference}"); inspect with /factory receipt ${factoryRow.factory_id} ${reference} or retry with the same reference: ${error}`);
				}
				return accepted;
			} finally {
				if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
				db.close();
			}
		}

		if (request.action === "launch" || request.action === "retry_launch") {
			const retry = request.action === "retry_launch";
			return (async (): Promise<LaunchResult> => {
				if (!bootstrap.launchFromDefinition || !bootstrap.prepareFromDefinition) {
					throw new Error("Bootstrap launch service is unavailable");
				}
				const factoryId = validateToken(request.factory_id, "factory_id");
				const retryRequest = retry ? request as RetryLaunch : undefined;
				const expectedHeadId = request.action === "launch" && request.input_id !== undefined ? validateToken(request.input_id, "input_id") : undefined;
				if (retry && (!retryRequest!.confirmed || !retryRequest!.input_id || !retryRequest!.previous_attempt_id)) throw new Error("Retry requires exact input, prior attempt, and human confirmation");
				const authRecord = requireAuthority(request.authority);
				request.assertAuthorityAndTrust?.();
				assertNoSymlinkComponents(path);
				assertNoSymlinkComponents(coordPath);
				if (!databaseExists(path)) throw new Error(`Factory not found: ${factoryId}`);

				// Pre-flight read-only check before contacting Herdr or taking any holds.
				let preflightDefinition: Definition;
				let preflightDefinitionDigest: string;
				let headInput: InputReceipt;
				{
					const ro = new DatabaseSync(path);
					const hasCoord = databaseExists(coordPath);
					try {
						// ATTACH itself reads the coordination database and can encounter a concurrent commit.
						ro.exec("PRAGMA busy_timeout = 5000");
						if (hasCoord) ro.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
						ro.exec("PRAGMA query_only = ON; BEGIN");
						const version = schemaVersion(ro);
						if (version === 0) throw new Error(`Factory not found: ${factoryId}`);
						const factoryRow = ro.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
						if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
						verifyStoredFactory(factoryRow);
						if (version === 1) {
							throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
						}
						// Damage in an unrelated retained version must not block a head bound to an intact one.
						const catalog = loadFactoryVersionCatalog(ro, version, factoryRow, { strictHistory: false });
						const inputs = ro.prepare(
							"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
						).all(factoryId) as StoredInput[];
						const { state, manager } = verifyEstablishedState(factoryRow, selectState(ro, factoryId), selectManager(ro, factoryId), inputs.length > 0);
						if (!manager) {
							throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
						}
						if (!authorityMatches(manager, authRecord)) {
							throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can launch`);
						}
						if (isFactoryStopped(ro, factoryId, version)) throw new Error(`Factory "${factoryRow.name}" (${factoryId}) is stopped; explicitly resume it before launching`);
						const verifiedInputs = verifyQueueCompleteness(factoryRow, inputs, state.last_input_position, catalog.currentVersion);
						const coordCheck = inspectCoordContinuityReadOnly(coordPath, hasCoord ? ro : undefined);
						const { attempts, tokenDigests, nonceDigests, checkoutKeys } = version >= 4
							? selectAttemptsWithTokens(ro, factoryId, catalog.currentVersion)
							: { attempts: [], tokenDigests: new Map<string, string | null>(), nonceDigests: new Map<string, string | null>(), checkoutKeys: new Map<string, string>() };
						const factoryHold = version >= 4 ? selectFactoryHold(ro, factoryId) : undefined;
						// Retry is permitted only for the exact attempt whose durable takeover reconciliation fenced release.
						let retryProofValid = false;
						if (retryRequest) {
							const priorRaw = ro.prepare(`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest FROM factory_attempts WHERE attempt_id = ?`).get(retryRequest.previous_attempt_id) as StoredAttempt | undefined;
							if (!priorRaw) throw new Error(`Retry prior attempt ${retryRequest.previous_attempt_id} is missing`);
							const prior = verifyAttemptRow(priorRaw);
							const retryInput = verifiedInputs.find(item => item.input_id === retryRequest.input_id);
							if (prior.state !== "proven_not_released" || prior.release_authorized || prior.input_id !== retryRequest.input_id || prior.factory_id !== factoryId || !retryInput || retryInput.bound_version !== prior.bound_version || retryInput.disposition !== "launching" || verifiedInputs.some(item => QUEUED_DISPOSITIONS.has(item.disposition) && item.queue_position < retryInput.queue_position)) throw new Error("Retry requires exact, durably proven non-release attempt and its unchanged FIFO input");
							const oldFactoryHold = selectFactoryHold(ro, factoryId);
							const oldCheckoutHold = selectCheckoutHold(ro, prior.canonical_checkout);
							if (!oldFactoryHold || oldFactoryHold.attempt_id !== prior.attempt_id || oldFactoryHold.input_id !== prior.input_id || oldFactoryHold.request_id !== prior.request_id || oldFactoryHold.task_id !== prior.task_id || oldFactoryHold.state !== "failed_before_release" || !oldCheckoutHold || oldCheckoutHold.attempt_id !== prior.attempt_id || oldCheckoutHold.input_id !== prior.input_id || oldCheckoutHold.request_id !== prior.request_id || oldCheckoutHold.task_id !== prior.task_id || oldCheckoutHold.factory_id !== factoryId || oldCheckoutHold.factory_db_path !== realpathSync(path) || oldCheckoutHold.canonical_checkout !== prior.canonical_checkout || oldCheckoutHold.checkout_key !== priorRaw.checkout_key || oldCheckoutHold.state !== "failed_before_release") throw new Error("Retry refused: exact durable holds for the proven prior attempt are missing or contradictory");
							verifyHistoricalNonReleaseRun(priorRaw, factoryId, factoryRow.name, realpathSync(path), realpathSync(coordPath), bootstrap);
							retryProofValid = true;
						}
						// Launch consumes FIFO head; retry consumes the exact original input/version without changing FIFO position.
						const head = retryRequest ? verifiedInputs.find(item => item.input_id === retryRequest.input_id) : firstWaitingInput(verifiedInputs, attempts);
						if (expectedHeadId !== undefined && head?.input_id !== expectedHeadId) throw new Error(`FIFO head changed before launch (expected ${expectedHeadId}, found ${head?.input_id ?? "none"})`);
						const headBound = head ? resolveBoundVersion(catalog, factoryRow, head.bound_version) : undefined;
						if (headBound?.error) throw new Error(headBound.error);
						const targetDefinition = headBound?.definition ?? catalog.currentDefinition;
						const checkoutIdentity = resolveCheckoutIdentity(targetDefinition.project_cwd);
						if (checkoutIdentity.canonical_checkout !== targetDefinition.project_cwd) {
							throw new Error(`Canonical checkout mismatch: retained ${targetDefinition.project_cwd} now resolves to ${checkoutIdentity.canonical_checkout}`);
						}
						const canonicalCheckout = checkoutIdentity.canonical_checkout;
						const canonicalFactoryDb = realpathSync(path);
						const coordEv = collectCheckoutEvidence(ro, {
							coordVersion: coordCheck.coordVersion,
							retainedCheckout: canonicalCheckout,
							liveCheckout: canonicalCheckout,
							liveCheckoutKey: checkoutIdentity.checkout_key,
							attemptCheckoutKeys: attemptCheckoutKeysFor(attempts, checkoutKeys, canonicalCheckout),
							factoryId,
							factoryDbPath: canonicalFactoryDb,
						});
						const inspected = inspectLaunchEvidence({
							factory: factoryRow,
							factoryDbPath: canonicalFactoryDb,
							coordDbPath: existsSync(coordPath) ? realpathSync(coordPath) : coordPath,
							definition: targetDefinition,
							currentVersion: catalog.currentVersion,
							definitionsByVersion: catalog.definitionsByVersion,
							versionErrors: catalog.versionErrors,
							managed: true,
							inputs: verifiedInputs,
							attempts,
							attemptTokenDigests: tokenDigests,
							attemptNonceDigests: nonceDigests,
							attemptCheckoutKeys: checkoutKeys,
							factoryHold,
							checkoutHold: coordEv.checkoutHold,
							checkoutHoldConflictError: coordEv.checkoutHoldConflictError,
							checkoutManagedRuns: coordEv.checkoutManagedRuns,
							factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
							managedRuns: coordEv.managedRuns,
							coordContinuityError: coordCheck.error,
							bootstrap,
						});
						if (retryProofValid && inspected.uncertainty.length > 0) {
							throw new Error(`Retry refused because prior evidence is missing or contradictory: ${inspected.uncertainty.join("; ")}`);
						}
						if (!inspected.head_status.eligible && !retryProofValid) {
							throw new Error(inspected.head_status.reason ?? "FIFO head is not eligible to launch");
						}
						request.assertAuthorityAndTrust?.(canonicalCheckout);
						headInput = head!;
						preflightDefinition = headBound!.definition!;
						preflightDefinitionDigest = headBound!.raw!.digest;
					} finally {
						ro.close();
					}
				}

				let committedAttemptId: string | undefined;
				let committedRequestId: string | undefined;
				let committedTaskId: string | undefined;
				let committedFactoryDbPath: string | undefined;
				let committedCoordDbPath: string | undefined;
				let committedCheckout: string | undefined;
				let committedCheckoutKey: string | undefined;
				let committedBoundVersion: string | undefined;

				const manifest = await bootstrap.launchFromDefinition({
					definition: preflightDefinition,
					submittedBrief: headInput.brief,
					signal: request.signal,
					reserveAttempt: (_workspaceId, candidateTaskId) => {
						const liveAuth = requireAuthority(request.authority);
						request.assertAuthorityAndTrust?.(realpathSync(preflightDefinition.project_cwd));
						const db = openWritableWithCoord(path, coordPath, true);
						let inTx = false;
						try {
							db.exec("BEGIN IMMEDIATE");
							inTx = true;
							const priorVersion = schemaVersion(db);
							if (priorVersion === 0) throw new Error(`Factory not found: ${factoryId}`);
							const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
							if (!factoryRow) throw new Error(`Factory not found: ${factoryId}`);
							verifyStoredFactory(factoryRow);
							if (priorVersion === 1) {
								throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
							}
							ensureCurrentSchema(db);
							const inputs = db.prepare(
								"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
							).all(factoryId) as StoredInput[];
							const { state, manager } = verifyEstablishedState(factoryRow, selectState(db, factoryId), selectManager(db, factoryId), inputs.length > 0);
							if (!manager) {
								throw new Error(`Factory "${factoryRow.name}" (${factoryRow.factory_id}) is unmanaged; explicitly resume management with /factory resume ${factoryRow.factory_id} first`);
							}
							if (!authorityMatches(manager, liveAuth)) {
								throw new Error(`Management authority mismatch for factory "${factoryRow.name}" (${factoryRow.factory_id}); only the active managing session can launch`);
							}
							if (isFactoryStopped(db, factoryId)) throw new Error(`Factory "${factoryRow.name}" (${factoryId}) is stopped; launch start was fenced`);
							const catalog = loadFactoryVersionCatalog(db, 7, factoryRow, { strictHistory: false });
							const verifiedInputs = verifyQueueCompleteness(factoryRow, inputs, state.last_input_position, catalog.currentVersion);
							const { attempts: existingAttempts, tokenDigests: existingTokenDigests, nonceDigests: existingNonceDigests, checkoutKeys: existingCheckoutKeys } = selectAttemptsWithTokens(db, factoryId, catalog.currentVersion);
							// Re-resolve the normal FIFO head or exact retry input inside the reservation transaction.
							const reserveHead = retryRequest ? verifiedInputs.find(item => item.input_id === retryRequest.input_id) : firstWaitingInput(verifiedInputs, existingAttempts);
							if (!reserveHead || reserveHead.input_id !== headInput.input_id) {
								throw new Error(`FIFO head changed before reservation (${reserveHead?.input_id} !== ${headInput.input_id})`);
							}
							const reserveBound = resolveBoundVersion(catalog, factoryRow, reserveHead.bound_version);
							if (!reserveBound.definition || !reserveBound.raw) throw new Error(reserveBound.error);
							if (reserveBound.raw.digest !== preflightDefinitionDigest) {
								throw new Error(`Bound version ${reserveHead.bound_version} changed between launch preflight and reservation`);
							}
							const def = reserveBound.definition;
							const checkoutIdentity = resolveCheckoutIdentity(def.project_cwd);
							const canonicalCheckout = checkoutIdentity.canonical_checkout;
							const checkoutKey = checkoutIdentity.checkout_key;
							if (canonicalCheckout !== def.project_cwd) {
								throw new Error(`Canonical checkout mismatch: retained ${def.project_cwd} now resolves to ${canonicalCheckout}`);
							}
							const canonicalFactoryDb = realpathSync(path);
							const coordInit = ensureCoordSchema(db, coordPath);
							const canonicalCoordDb = realpathSync(coordPath);
							const existingFactoryHold = selectFactoryHold(db, factoryId);
							const coordEv = collectCheckoutEvidence(db, {
								coordVersion: 2,
								retainedCheckout: canonicalCheckout,
								liveCheckout: canonicalCheckout,
								liveCheckoutKey: checkoutKey,
								attemptCheckoutKeys: attemptCheckoutKeysFor(existingAttempts, existingCheckoutKeys, canonicalCheckout),
								factoryId,
								factoryDbPath: canonicalFactoryDb,
							});
							const inspected = inspectLaunchEvidence({
								factory: factoryRow,
								factoryDbPath: canonicalFactoryDb,
								coordDbPath: canonicalCoordDb,
								definition: def,
								currentVersion: catalog.currentVersion,
								definitionsByVersion: catalog.definitionsByVersion,
								versionErrors: catalog.versionErrors,
								managed: true,
								inputs: verifiedInputs,
								attempts: existingAttempts,
								attemptTokenDigests: existingTokenDigests,
								attemptNonceDigests: existingNonceDigests,
								attemptCheckoutKeys: existingCheckoutKeys,
								factoryHold: existingFactoryHold,
								checkoutHold: coordEv.checkoutHold,
								checkoutHoldConflictError: coordEv.checkoutHoldConflictError,
								checkoutManagedRuns: coordEv.checkoutManagedRuns,
								factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
								managedRuns: coordEv.managedRuns,
								skipCrossRootProofCheck: true,
								bootstrap,
							});
							let retryReservationValid = false;
							if (retryRequest) {
								const priorRaw = db.prepare(`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest FROM factory_attempts WHERE attempt_id = ?`).get(retryRequest.previous_attempt_id) as StoredAttempt | undefined;
								if (!priorRaw) throw new Error("Retry prior attempt disappeared before reservation");
								const prior = verifyAttemptRow(priorRaw);
								const oldF = selectFactoryHold(db, factoryId);
								const oldC = selectCheckoutHold(db, prior.canonical_checkout);
								if (prior.state !== "proven_not_released" || prior.release_authorized || prior.input_id !== retryRequest.input_id || prior.factory_id !== factoryId || prior.bound_version !== reserveHead.bound_version || prior.request_id !== oldF?.request_id || prior.request_id !== oldC?.request_id || prior.task_id !== oldF?.task_id || prior.task_id !== oldC?.task_id || prior.attempt_id !== oldF?.attempt_id || prior.attempt_id !== oldC?.attempt_id || oldF.input_id !== prior.input_id || oldF.state !== "failed_before_release" || oldC.input_id !== prior.input_id || oldC.state !== "failed_before_release" || oldC.factory_id !== factoryId || oldC.factory_db_path !== realpathSync(path) || oldC.canonical_checkout !== prior.canonical_checkout || oldC.checkout_key !== priorRaw.checkout_key || reserveHead.disposition !== "launching" || verifiedInputs.some(item => QUEUED_DISPOSITIONS.has(item.disposition) && item.queue_position < reserveHead.queue_position)) throw new Error("Retry proof, FIFO position, or held identities changed before reservation");
								verifyHistoricalNonReleaseRun(priorRaw, factoryId, factoryRow.name, realpathSync(path), realpathSync(coordPath), bootstrap);
								retryReservationValid = true;
							}
							if (retryReservationValid && inspected.uncertainty.length > 0) {
								throw new Error(`Retry refused because prior evidence changed or is contradictory: ${inspected.uncertainty.join("; ")}`);
							}
							if (!inspected.head_status.eligible && !retryReservationValid) {
								throw new Error(inspected.head_status.reason ?? "FIFO head is not eligible to launch");
							}
							const headRow = inputs.find(row => row.input_id === reserveHead!.input_id)!;
							if (headRow.input_id !== headInput.input_id) {
								throw new Error(`FIFO head changed before reservation (${headRow.input_id} !== ${headInput.input_id})`);
							}
							const attemptId = `att-${randomUUID()}`;
							const requestId = generateFactoryRequestId(factoryId, attemptId);
							const taskId = candidateTaskId;
							const nowIso = new Date().toISOString();

							const updatedInput = buildInputRow({
								input_id: headRow.input_id,
								factory_id: headRow.factory_id,
								reference: headRow.reference,
								queue_position: headRow.queue_position,
								bound_version: headRow.bound_version,
								disposition: "launching",
								brief: headRow.brief,
								brief_bytes: headRow.brief_bytes,
								brief_digest: headRow.brief_digest,
								accepted_at: headRow.accepted_at,
							});
							db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(
								updatedInput.disposition,
								updatedInput.record_digest,
								updatedInput.input_id,
							);

							const attemptRow = buildAttemptRow({
								attempt_id: attemptId,
								factory_id: factoryId,
								input_id: headRow.input_id,
								bound_version: headRow.bound_version,
								request_id: requestId,
								task_id: taskId,
								canonical_checkout: canonicalCheckout,
								checkout_key: checkoutKey,
								state: "reserved",
								release_authorized: 0,
								release_authorized_at: null,
								release_token_digest: null,
								release_nonce_digest: null,
								error: null,
								created_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO factory_attempts (attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								attemptRow.attempt_id, attemptRow.factory_id, attemptRow.input_id, attemptRow.bound_version,
								attemptRow.request_id, attemptRow.task_id, attemptRow.canonical_checkout, attemptRow.checkout_key, attemptRow.state,
								attemptRow.release_authorized, attemptRow.release_authorized_at, attemptRow.release_token_digest, attemptRow.release_nonce_digest,
								attemptRow.error, attemptRow.created_at, attemptRow.updated_at, attemptRow.record_digest,
							);

							const fHoldRow = buildFactoryHoldRow({
								factory_id: factoryId,
								attempt_id: attemptId,
								input_id: headRow.input_id,
								request_id: requestId,
								task_id: taskId,
								state: "reserved",
								held_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO factory_holds (factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
								ON CONFLICT(factory_id) DO UPDATE SET attempt_id=excluded.attempt_id, input_id=excluded.input_id, request_id=excluded.request_id, task_id=excluded.task_id, state=excluded.state, held_at=excluded.held_at, updated_at=excluded.updated_at, record_digest=excluded.record_digest`,
							).run(
								fHoldRow.factory_id, fHoldRow.attempt_id, fHoldRow.input_id, fHoldRow.request_id,
								fHoldRow.task_id, fHoldRow.state, fHoldRow.held_at, fHoldRow.updated_at, fHoldRow.record_digest,
							);

							const cHoldRow = buildCheckoutHoldRow({
								canonical_checkout: canonicalCheckout,
								checkout_key: checkoutKey,
								factory_id: factoryId,
								factory_name: factoryRow.name,
								factory_db_path: canonicalFactoryDb,
								attempt_id: attemptId,
								input_id: headRow.input_id,
								request_id: requestId,
								task_id: taskId,
								state: "reserved",
								held_at: nowIso,
								updated_at: nowIso,
							});
							db.prepare(
								`INSERT INTO coord.checkout_holds (canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
								ON CONFLICT(canonical_checkout) DO UPDATE SET checkout_key=excluded.checkout_key, factory_id=excluded.factory_id, factory_name=excluded.factory_name, factory_db_path=excluded.factory_db_path, attempt_id=excluded.attempt_id, input_id=excluded.input_id, request_id=excluded.request_id, task_id=excluded.task_id, state=excluded.state, held_at=excluded.held_at, updated_at=excluded.updated_at, record_digest=excluded.record_digest`,
							).run(
								cHoldRow.canonical_checkout, cHoldRow.checkout_key, cHoldRow.factory_id, cHoldRow.factory_name, cHoldRow.factory_db_path,
								cHoldRow.attempt_id, cHoldRow.input_id, cHoldRow.request_id, cHoldRow.task_id,
								cHoldRow.state, cHoldRow.held_at, cHoldRow.updated_at, cHoldRow.record_digest,
							);

							const mRunRow = buildManagedRunRow({
								task_id: taskId,
								request_id_digest: digest(requestId),
								factory_id: factoryId,
								factory_name: factoryRow.name,
								factory_db_path: canonicalFactoryDb,
								input_id: headRow.input_id,
								attempt_id: attemptId,
								canonical_checkout: canonicalCheckout,
								checkout_key: checkoutKey,
								created_at: nowIso,
							});
							db.prepare(
								`INSERT INTO coord.managed_runs (task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(
								mRunRow.task_id, mRunRow.request_id_digest, mRunRow.factory_id, mRunRow.factory_name,
								mRunRow.factory_db_path, mRunRow.input_id, mRunRow.attempt_id, mRunRow.canonical_checkout, mRunRow.checkout_key,
								mRunRow.created_at, mRunRow.record_digest,
							);

							const commitAuth = requireAuthority(request.authority);
							if (!authorityMatches(manager, commitAuth)) {
								throw new Error(`Management authority mismatch at reservation commit for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							request.assertAuthorityAndTrust?.(canonicalCheckout);
							const commitCheckoutIdentity = resolveCheckoutIdentity(def.project_cwd);
							if (commitCheckoutIdentity.canonical_checkout !== canonicalCheckout || commitCheckoutIdentity.checkout_key !== checkoutKey) {
								throw new Error(`Checkout physical identity changed before reservation commit for "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							const factory_managed: FactoryManagedInfo = {
								version: 1,
								factory_id: factoryId,
								factory_name: factoryRow.name,
								input_id: headRow.input_id,
								attempt_id: attemptId,
								request_id: requestId,
								bound_version: headRow.bound_version,
								canonical_checkout: canonicalCheckout,
								checkout_key: checkoutKey,
								state_db_path: canonicalFactoryDb,
								coord_db_path: canonicalCoordDb,
							};
							if (!bootstrap.store) throw new Error("Authoritative Bootstrap index is unavailable at reservation");
							reserveFactoryRunIndex(db, taskId, factory_managed, bootstrap.store.indexRoot);
							atLaunchCommit?.("reserve_before_commit");
							try {
								db.exec("COMMIT");
								inTx = false;
								if (coordInit.newlyInitialized) {
									writeAnchorFile(coordPath, { ...coordInit.anchor, state: "committed" });
								}
								atLaunchCommit?.("reserve_after_commit");
							} catch (error) {
								throw new Error(`Launch reservation outcome uncertain for "${factoryRow.name}" (${factoryRow.factory_id}); inspect with /factory inspect ${factoryRow.factory_id}: ${error}`);
							}

							committedAttemptId = attemptId;
							committedRequestId = requestId;
							committedTaskId = taskId;
							committedFactoryDbPath = canonicalFactoryDb;
							committedCoordDbPath = canonicalCoordDb;
							committedCheckout = canonicalCheckout;
							committedCheckoutKey = checkoutKey;
							committedBoundVersion = headRow.bound_version;
							return { request_id: requestId, task_id: taskId, factory_managed };
						} finally {
							if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
							db.close();
						}
					},
					beforeRelease: (manifest, markReleaseCommitted) => {
						// Synchronous authority + trust + hold + run identity fence with zero async gap before committing release_authorized = 1.
						const liveAuth = requireAuthority(request.authority);
						request.assertAuthorityAndTrust?.(committedCheckout);
						if (!committedAttemptId || !committedRequestId || !committedTaskId || !committedCheckout || !committedCheckoutKey || !committedFactoryDbPath || !committedCoordDbPath || !committedBoundVersion) {
							throw new Error("Missing committed launch reservation at release gate");
						}
						if (manifest.task_id !== committedTaskId) {
							throw new Error(`Task ID mismatch at release gate (${manifest.task_id} !== ${committedTaskId})`);
						}
						const liveCheckoutIdentity = resolveCheckoutIdentity(committedCheckout);
						if (manifest.project_cwd !== committedCheckout || liveCheckoutIdentity.canonical_checkout !== committedCheckout) {
							throw new Error("Canonical checkout mismatch at release gate");
						}
						if (liveCheckoutIdentity.checkout_key !== committedCheckoutKey) {
							throw new Error(`Checkout physical identity mismatch at release gate (${liveCheckoutIdentity.checkout_key} !== ${committedCheckoutKey})`);
						}
						if (realpathSync(path) !== committedFactoryDbPath || realpathSync(coordPath) !== committedCoordDbPath) {
							throw new Error("Factory database path mismatch at release gate");
						}
						if (typeof manifest.token !== "string" || !manifest.token.trim() || manifest.token.includes("\0")) {
							throw new Error("Missing or invalid launch token at release gate");
						}
						if (!manifest.factory_managed) {
							throw new Error("Manifest is missing factory_managed metadata at release gate");
						}
						const manifestMeta = parseNormalizedFactoryManagedInfo(manifest.factory_managed, "manifest.factory_managed");
						const expectedManaged: FactoryManagedInfo = {
							version: 1,
							factory_id: factoryId,
							factory_name: manifestMeta.factory_name,
							input_id: headInput.input_id,
							attempt_id: committedAttemptId,
							request_id: committedRequestId,
							bound_version: committedBoundVersion,
							canonical_checkout: committedCheckout,
							checkout_key: committedCheckoutKey,
							state_db_path: committedFactoryDbPath,
							coord_db_path: committedCoordDbPath,
						};
						const manifestMismatch = metadataMismatch(expectedManaged, manifestMeta, "manifest");
						if (manifestMismatch) {
							throw new Error(manifestMismatch);
						}
						const verifyLocalRunEvidenceFence = (expectedFactoryName?: string): FactoryManagedInfo => {
							assertNoSymlinkComponents(manifest.session_dir);
							if (manifest.session_dir !== join(committedCheckout, ".pi", "agent-sessions", committedTaskId)) {
								throw new Error("Session directory mismatch at release gate");
							}
							const sidecarPath = factoryRunPath(manifest.session_dir);
							const diskManifestPath = join(manifest.session_dir, "manifest.json");
							const releasePath = join(manifest.session_dir, "release.json");
							if (pathEntryExists(releasePath)) {
								throw new Error(`Unexpected release.json entry already exists before release authorization for run ${committedTaskId}`);
							}
							const diskManifest = readAndValidateManagedManifest({
								manifestPath: diskManifestPath,
								taskId: committedTaskId,
								expectedToken: manifest.token,
								expectedSessionDir: manifest.session_dir,
								expectedMeta: expectedManaged,
								sourceLabel: "run manifest.json",
							});
							const diskMeta = parseNormalizedFactoryManagedInfo(diskManifest.factory_managed, "run manifest.json");
							if (!pathEntryExists(sidecarPath)) {
								throw new ManagedManifestContradictionError("Missing required factory run metadata files at release gate");
							}
							const sidecarRaw = readRegularJsonNoSymlink<Record<string, unknown>>(sidecarPath, "factory-run.json");
							const sidecarMeta = parseNormalizedFactoryManagedInfo(sidecarRaw, "factory-run.json");
							if (sidecarRaw.task_id !== undefined && sidecarRaw.task_id !== committedTaskId) {
								throw new Error("factory-run.json task_id mismatch at release gate");
							}
							const sidecarMismatch = metadataMismatch(expectedManaged, sidecarMeta, "factory-run.json");
							if (sidecarMismatch) {
								throw new Error(sidecarMismatch);
							}
							if (expectedFactoryName !== undefined && (sidecarMeta.factory_name !== expectedFactoryName || diskMeta.factory_name !== expectedFactoryName)) {
								throw new Error("Factory name mismatch in run metadata at release gate");
							}
							return sidecarMeta;
						};
						const initialSidecarMeta = verifyLocalRunEvidenceFence();
						const db = openWritableWithCoord(path, coordPath);
						let inTx = false;
						try {
							db.exec("BEGIN IMMEDIATE");
							inTx = true;
							const releaseSchema = assertLaunchStorageSchema(db, "release gate");
							verifyCoordSchemaForRelease(db, coordPath);
							const factoryRow = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
							if (!factoryRow) throw new Error(`Factory not found at release gate: ${factoryId}`);
							verifyStoredFactory(factoryRow);
							verifyBoundVersionAtGate(db, releaseSchema, factoryRow, committedBoundVersion, committedCheckout, "release gate");
							if (manifestMeta.factory_name !== factoryRow.name || initialSidecarMeta.factory_name !== factoryRow.name) {
								throw new Error("Factory name mismatch in run metadata at release gate");
							}
							const { manager } = verifyEstablishedState(factoryRow, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
							if (!manager || !authorityMatches(manager, liveAuth)) {
								throw new Error(`Management authority mismatch at release gate for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							const attemptRow = db.prepare(
								`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
									release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
								FROM factory_attempts WHERE attempt_id = ?`,
							).get(committedAttemptId) as StoredAttempt | undefined;
							if (!attemptRow) throw new Error(`Attempt ${committedAttemptId} missing at release gate`);
							verifyAttemptRow(attemptRow);
							if (
								attemptRow.factory_id !== factoryId
								|| attemptRow.input_id !== headInput.input_id
								|| attemptRow.bound_version !== committedBoundVersion
								|| attemptRow.request_id !== committedRequestId
								|| attemptRow.task_id !== committedTaskId
								|| attemptRow.canonical_checkout !== committedCheckout
								|| attemptRow.checkout_key !== committedCheckoutKey
								|| attemptRow.state !== "reserved"
								|| attemptRow.release_authorized !== 0
								|| attemptRow.release_token_digest !== null
								|| attemptRow.release_nonce_digest !== null
							) {
								throw new Error(`Attempt ${committedAttemptId} state or identity is not eligible for release (${attemptRow.state})`);
							}
							const fHold = selectFactoryHold(db, factoryId);
							const cHold = selectCheckoutHold(db, committedCheckout);
							const mRun = selectManagedRunByTaskId(db, committedTaskId);
							const checkoutRuns = selectManagedRunsForCheckout(db, committedCheckout);
							if (
								!fHold
								|| fHold.attempt_id !== committedAttemptId
								|| fHold.input_id !== headInput.input_id
								|| fHold.request_id !== committedRequestId
								|| fHold.task_id !== committedTaskId
								|| fHold.state !== "reserved"
								|| !cHold
								|| cHold.canonical_checkout !== committedCheckout
								|| cHold.checkout_key !== committedCheckoutKey
								|| cHold.factory_id !== factoryId
								|| cHold.factory_name !== factoryRow.name
								|| cHold.factory_db_path !== committedFactoryDbPath
								|| cHold.attempt_id !== committedAttemptId
								|| cHold.input_id !== headInput.input_id
								|| cHold.request_id !== committedRequestId
								|| cHold.task_id !== committedTaskId
								|| cHold.state !== "reserved"
							) {
								throw new Error(`Hold mismatch at release gate for attempt ${committedAttemptId}`);
							}
							const historicalRows = retryRequest ? db.prepare(`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest FROM factory_attempts WHERE input_id = ? AND attempt_id <> ? ORDER BY created_at, rowid`).all(headInput.input_id, committedAttemptId) as StoredAttempt[] : [];
							const isReleaseGateSupersededRun = (run: StoredManagedRun): boolean =>
								run.factory_id === factoryId && run.factory_db_path === committedFactoryDbPath
									? verifyTerminallySupersededRunRowInDb(db, run, factoryRow.name, committedFactoryDbPath!, committedCoordDbPath!, bootstrap)
									: verifyCrossRootTerminallySupersededRun(run, committedCoordDbPath!, bootstrap);
							let historicalRunsValid = !retryRequest
								? checkoutRuns.some(run => run.task_id === committedTaskId)
									&& checkoutRuns.every(run => run.task_id === committedTaskId || isReleaseGateSupersededRun(run))
								: false;
							if (retryRequest && historicalRows.length >= 1 && checkoutRuns.length >= historicalRows.length + 1) {
								try {
									for (const historical of historicalRows) {
										const valid = validateAttemptRow(historical);
										if (valid.factory_id !== factoryId || valid.bound_version !== committedBoundVersion || valid.canonical_checkout !== committedCheckout || valid.checkout_key !== committedCheckoutKey) throw new Error("Historical attempt identity does not match retry target");
										verifyHistoricalNonReleaseRun(valid, factoryId, factoryRow.name, committedFactoryDbPath!, committedCoordDbPath!, bootstrap);
										const historicalRun = checkoutRuns.find(run => run.attempt_id === valid.attempt_id);
										if (!historicalRun || historicalRun.task_id !== valid.task_id || historicalRun.input_id !== valid.input_id || historicalRun.request_id_digest !== digest(valid.request_id)) throw new Error("Historical attempt has no exact managed-run association");
									}
									historicalRunsValid = historicalRows.some(row => row.attempt_id === retryRequest.previous_attempt_id)
										&& checkoutRuns.every(run =>
											run.task_id === committedTaskId
											|| historicalRows.some(row => row.task_id === run.task_id)
											|| isReleaseGateSupersededRun(run),
										);
								} catch { historicalRunsValid = false; }
							}
							if (
								!mRun
								|| !historicalRunsValid
								|| mRun.task_id !== committedTaskId
								|| mRun.request_id_digest !== digest(committedRequestId)
								|| mRun.factory_id !== factoryId
								|| mRun.factory_name !== factoryRow.name
								|| mRun.factory_db_path !== committedFactoryDbPath
								|| mRun.input_id !== headInput.input_id
								|| mRun.attempt_id !== committedAttemptId
								|| mRun.canonical_checkout !== committedCheckout
								|| mRun.checkout_key !== committedCheckoutKey
							) {
								throw new Error(`Managed run association missing or mismatched at release gate for run ${committedTaskId}`);
							}
							const inputRow = db.prepare(
								"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?",
							).get(headInput.input_id) as StoredInput | undefined;
							if (!inputRow) throw new Error(`Input ${headInput.input_id} missing at release gate`);
							verifyInputRow(inputRow);
							if (inputRow.factory_id !== factoryId || inputRow.bound_version !== committedBoundVersion || inputRow.disposition !== "launching") {
								throw new Error(`Input ${headInput.input_id} state is not eligible for release (${inputRow.disposition})`);
							}

							const nowIso = new Date().toISOString();
							const tokenDigest = digest(manifest.token);
							const releaseNonce = randomUUID();
							const releaseNonceDigest = digest(releaseNonce);
							const nextAttempt = buildAttemptRow({
								attempt_id: attemptRow.attempt_id,
								factory_id: attemptRow.factory_id,
								input_id: attemptRow.input_id,
								bound_version: attemptRow.bound_version,
								request_id: attemptRow.request_id,
								task_id: attemptRow.task_id,
								canonical_checkout: attemptRow.canonical_checkout,
								checkout_key: attemptRow.checkout_key,
								state: "released",
								release_authorized: 1,
								release_authorized_at: nowIso,
								release_token_digest: tokenDigest,
								release_nonce_digest: releaseNonceDigest,
								error: null,
								created_at: attemptRow.created_at,
								updated_at: nowIso,
							});
							db.prepare(
								"UPDATE factory_attempts SET state = ?, release_authorized = ?, release_authorized_at = ?, release_token_digest = ?, release_nonce_digest = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ?",
							).run(
								nextAttempt.state,
								nextAttempt.release_authorized,
								nextAttempt.release_authorized_at,
								nextAttempt.release_token_digest,
								nextAttempt.release_nonce_digest,
								nextAttempt.updated_at,
								nextAttempt.record_digest,
								nextAttempt.attempt_id,
							);

							const nextInput = buildInputRow({
								input_id: inputRow.input_id,
								factory_id: inputRow.factory_id,
								reference: inputRow.reference,
								queue_position: inputRow.queue_position,
								bound_version: inputRow.bound_version,
								disposition: "running",
								brief: inputRow.brief,
								brief_bytes: inputRow.brief_bytes,
								brief_digest: inputRow.brief_digest,
								accepted_at: inputRow.accepted_at,
							});
							db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(
								nextInput.disposition,
								nextInput.record_digest,
								nextInput.input_id,
							);

							const nextFHold = buildFactoryHoldRow({
								factory_id: fHold.factory_id,
								attempt_id: fHold.attempt_id,
								input_id: fHold.input_id,
								request_id: fHold.request_id,
								task_id: fHold.task_id,
								state: "released",
								held_at: fHold.held_at,
								updated_at: nowIso,
							});
							db.prepare("UPDATE factory_holds SET state = ?, updated_at = ?, record_digest = ? WHERE factory_id = ?").run(
								nextFHold.state, nextFHold.updated_at, nextFHold.record_digest, nextFHold.factory_id,
							);

							const nextCHold = buildCheckoutHoldRow({
								canonical_checkout: cHold.canonical_checkout,
								checkout_key: cHold.checkout_key,
								factory_id: cHold.factory_id,
								factory_name: cHold.factory_name,
								factory_db_path: cHold.factory_db_path,
								attempt_id: cHold.attempt_id,
								input_id: cHold.input_id,
								request_id: cHold.request_id,
								task_id: cHold.task_id,
								state: "released",
								held_at: cHold.held_at,
								updated_at: nowIso,
							});
							db.prepare("UPDATE coord.checkout_holds SET state = ?, updated_at = ?, record_digest = ? WHERE canonical_checkout = ?").run(
								nextCHold.state, nextCHold.updated_at, nextCHold.record_digest, nextCHold.canonical_checkout,
							);

							const commitAuth = requireAuthority(request.authority);
							if (!authorityMatches(manager, commitAuth)) {
								throw new Error(`Management authority mismatch at release commit for factory "${factoryRow.name}" (${factoryRow.factory_id})`);
							}
							request.assertAuthorityAndTrust?.(committedCheckout);
							const commitCheckoutIdentity = resolveCheckoutIdentity(committedCheckout);
							if (commitCheckoutIdentity.canonical_checkout !== committedCheckout || commitCheckoutIdentity.checkout_key !== committedCheckoutKey) {
								throw new Error(`Checkout physical identity changed before release commit (${commitCheckoutIdentity.checkout_key} !== ${committedCheckoutKey})`);
							}
							atLaunchCommit?.("release_before_commit");
							verifyLocalRunEvidenceFence(factoryRow.name);
							try {
								db.exec("COMMIT");
								inTx = false;
								markReleaseCommitted?.();
								atLaunchCommit?.("release_after_commit");
							} catch (error) {
								markReleaseCommitted?.();
								throw new Error(`Release authorization outcome uncertain for attempt ${committedAttemptId}: ${error}`);
							}

							const postCommitCheckoutIdentity = resolveCheckoutIdentity(committedCheckout);
							if (postCommitCheckoutIdentity.canonical_checkout !== committedCheckout || postCommitCheckoutIdentity.checkout_key !== committedCheckoutKey) {
								throw new Error(`Checkout physical identity changed after release commit (${postCommitCheckoutIdentity.checkout_key} !== ${committedCheckoutKey}); release marker was not published`);
							}
							verifyLocalRunEvidenceFence(factoryRow.name);

							return {
								factory_id: factoryId,
								input_id: headInput.input_id,
								attempt_id: committedAttemptId,
								request_id: committedRequestId,
								bound_version: committedBoundVersion,
								release_authorized_at: nowIso,
								release_nonce: releaseNonce,
							};
						} finally {
							if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
							db.close();
						}
					},
					onBeforeReleaseError: (taskId, errorText) => {
						if (!committedAttemptId) return;
						try {
							const db = openWritableWithCoord(path, coordPath, false);
							let inTx = false;
							try {
								db.exec("BEGIN IMMEDIATE");
								inTx = true;
								assertLaunchStorageSchema(db, "launch failure recording");
								verifyCoordSchemaForRelease(db, coordPath);
								const liveAuthority = requireAuthority(request.authority);
								const failureFactory = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
								if (!failureFactory) throw new Error("Factory disappeared while recording launch failure");
								const { manager: failureManager } = verifyEstablishedState(failureFactory, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
								if (!failureManager || !authorityMatches(failureManager, liveAuthority)) throw new Error("Stale manager cannot record launch failure after takeover");
								const attemptRow = db.prepare(
									`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
										release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
									FROM factory_attempts WHERE attempt_id = ?`,
								).get(committedAttemptId) as StoredAttempt | undefined;
								if (attemptRow) {
									verifyAttemptRow(attemptRow);
									if (attemptRow.release_authorized === 0 && attemptRow.task_id === taskId && (attemptRow.state === "reserved" || attemptRow.state === "failed_before_release")) {
										const nowIso = new Date().toISOString();
										const fHold = selectFactoryHold(db, factoryId);
										const cHold = committedCheckout ? selectCheckoutHold(db, committedCheckout) : undefined;
										const mRun = selectManagedRunByTaskId(db, taskId);
										const inputRaw = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE input_id = ?").get(attemptRow.input_id) as StoredInput | undefined;
										const canonicalDb = realpathSync(path);
										const canonicalCoord = realpathSync(coordPath);
										let nextAttemptState: "failed_before_release" | "proven_not_released" = "failed_before_release";
										let nextAttemptError = errorText;
										if (inputRaw && fHold && cHold && mRun) {
											try {
												const verifiedInput = verifyInputRow(inputRaw);
												if (hasConsistentUnreleasedHoldBinding({
													attempt: attemptRow,
													input: verifiedInput,
													fHold,
													cHold,
													mRun,
													factoryId,
													factoryName: failureFactory.name,
													canonicalDb,
													expectedHoldState: attemptRow.state as "reserved" | "failed_before_release",
												})) {
													const proof = checkSelfSessionPreReleaseNonRelease(attemptRow, factoryId, failureFactory.name, canonicalDb, canonicalCoord, bootstrap);
													if (proof.ok) {
														nextAttemptState = "proven_not_released";
														nextAttemptError = "release permission was never committed";
													}
												}
											} catch { /* fall back to failed_before_release */ }
										}
										const failedAttempt = buildAttemptRow({
											...attemptRow,
											state: nextAttemptState,
											error: nextAttemptError,
											updated_at: nowIso,
										});
										db.prepare("UPDATE factory_attempts SET state = ?, error = ?, updated_at = ?, record_digest = ? WHERE attempt_id = ?").run(
											failedAttempt.state, failedAttempt.error, failedAttempt.updated_at, failedAttempt.record_digest, failedAttempt.attempt_id,
										);
										if (fHold && fHold.attempt_id === committedAttemptId) {
											const nextFHold = buildFactoryHoldRow({ ...fHold, state: "failed_before_release", updated_at: nowIso });
											db.prepare("UPDATE factory_holds SET state = ?, updated_at = ?, record_digest = ? WHERE factory_id = ?").run(
												nextFHold.state, nextFHold.updated_at, nextFHold.record_digest, nextFHold.factory_id,
											);
										}
										if (cHold && cHold.attempt_id === committedAttemptId) {
											const nextCHold = buildCheckoutHoldRow({ ...cHold, state: "failed_before_release", updated_at: nowIso });
											db.prepare("UPDATE coord.checkout_holds SET state = ?, updated_at = ?, record_digest = ? WHERE canonical_checkout = ?").run(
												nextCHold.state, nextCHold.updated_at, nextCHold.record_digest, nextCHold.canonical_checkout,
											);
										}
									}
								}
								db.exec("COMMIT");
								inTx = false;
							} finally {
								if (inTx) try { db.exec("ROLLBACK"); } catch { /* already closed or rolled back */ }
								db.close();
							}
						} catch {
							// Conservative holds remain even if recording failure text could not commit.
						}
					},
				});
				if (manifest.status === "error") {
					throw new Error(manifest.error ?? "Factory launch failed before release");
				}
				return {
					factory_id: factoryId,
					input_id: headInput.input_id,
					reference: headInput.reference,
					bound_version: committedBoundVersion!,
					attempt_id: committedAttemptId!,
					request_id: committedRequestId!,
					task_id: committedTaskId!,
					release_authorized: true,
					manifest,
				};
			})();
		}

		if (request.action !== "list" && request.action !== "inspect" && request.action !== "publication_target" && request.action !== "receipt" && request.action !== "verify_manager" && request.action !== "binding") {
			throw new Error("Unknown factory operation");
		}
		if (request.action === "verify_manager") requireAuthority(request.authority);
		assertNoSymlinkComponents(path);
		const missing = (id = "") => new Error(`Factory not found: ${id}`);
		if (!databaseExists(path)) {
			if (request.action === "list") return [];
			throw missing(request.factory_id);
		}
		// Inspection may report a hot journal; only a write operation may recover it.
		const hasCoord = request.action === "inspect" && databaseExists(coordPath);
		if (hasCoord) assertNoSymlinkComponents(coordPath);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			if (hasCoord) db.prepare("ATTACH DATABASE ? AS coord").run(coordPath);
			db.exec("PRAGMA query_only = ON; BEGIN");
			const version = schemaVersion(db);
			if (version === 0) {
				if (request.action === "list") return [];
				throw missing(request.factory_id);
			}
			if (request.action === "publication_target") {
				const factoryId = validateToken(request.factory_id, "factory_id");
				const row = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
				if (!row) throw missing(factoryId);
				let management: ManagementState = "unmanaged";
				let currentVersion = "v1";
				if (version >= 2) {
					const established = verifyEstablishedState(row, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
					management = established.manager ? "managed" : "unmanaged";
				}
				if (version >= 5) currentVersion = verifyPointerRow(selectPointer(db, factoryId), row).current_version;
				else verifyStoredFactory(row);
				const manager = version >= 2 ? selectManager(db, factoryId) : undefined;
				return { ...summary(row, management, currentVersion), ...(manager ? { manager_incarnation_id: manager.incarnation_id } : {}) };
			}
			if (request.action === "list") {
				if (version === 1) {
					return (db.prepare("SELECT factory_id, name FROM factories ORDER BY name").all() as Identity[]).map(row => summary(row, "unmanaged"));
				}
				const rows = db.prepare(
					`SELECT f.factory_id, f.name,
						s.factory_id AS s_factory_id, s.established, s.last_input_position, s.record_digest AS s_record_digest,
						m.factory_id AS m_factory_id, m.incarnation_id, m.authority_digest, m.pi_session_id, m.pi_session_file, m.pid, m.resumed_at, m.record_digest AS m_record_digest,
						COALESCE(i.input_count, 0) AS input_count,
						COALESCE(i.min_pos, 0) AS min_pos,
						COALESCE(i.max_pos, 0) AS max_pos
					FROM factories f
					LEFT JOIN factory_state s ON s.factory_id = f.factory_id
					LEFT JOIN factory_managers m ON m.factory_id = f.factory_id
					LEFT JOIN (
						SELECT factory_id, COUNT(*) AS input_count, MIN(queue_position) AS min_pos, MAX(queue_position) AS max_pos
						FROM factory_inputs
						GROUP BY factory_id
					) i ON i.factory_id = f.factory_id
					ORDER BY f.name`,
				).all() as Array<Identity & {
					s_factory_id: string | null;
					established: number | null;
					last_input_position: number | null;
					s_record_digest: string | null;
					m_factory_id: string | null;
					m_record_digest: string | null;
					input_count: number;
					min_pos: number;
					max_pos: number;
				} & Partial<Omit<StoredManager, "record_digest">>>;
				return rows.map(row => {
					const identity = { factory_id: row.factory_id, name: row.name };
					const state: StoredState | undefined = row.s_factory_id !== null ? {
						factory_id: row.s_factory_id,
						established: row.established!,
						last_input_position: row.last_input_position!,
						record_digest: row.s_record_digest!,
					} : undefined;
					const manager: StoredManager | undefined = row.m_factory_id !== null ? {
						factory_id: row.m_factory_id,
						incarnation_id: row.incarnation_id!,
						authority_digest: row.authority_digest!,
						pi_session_id: row.pi_session_id ?? null,
						pi_session_file: row.pi_session_file ?? null,
						pid: row.pid!,
						resumed_at: row.resumed_at!,
						record_digest: row.m_record_digest!,
					} : undefined;
					const { state: verifiedState, manager: verifiedManager } = verifyEstablishedState(identity, state, manager, row.input_count > 0);
					if (verifiedManager) {
						verifyQueueSummary(identity, verifiedState.last_input_position, row.input_count, row.min_pos, row.max_pos);
					}
					let currentVersion = "v1";
					if (version >= 5) {
						const ptr = verifyPointerRow(selectPointer(db, identity.factory_id), identity);
						currentVersion = ptr.current_version;
					}
					return summary(identity, verifiedManager ? "managed" : "unmanaged", currentVersion);
				});
			}

			const factoryId = validateToken(request.factory_id, "factory_id");
			const row = db.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id = ?").get(factoryId) as StoredFactory | undefined;
			if (!row) throw missing(factoryId);
			// A binding view reports damaged version evidence rather than throwing, so status surfaces never hide or infer it.
			let catalogError: string | undefined;
			let bindingCatalog: ReadCatalog | undefined;
			if (request.action === "binding") {
				try { bindingCatalog = loadReadCatalog(db, version, row); }
				catch (error) { catalogError = errorMessage(error); }
				return bindingView(request, row, bindingCatalog, catalogError);
			}
			// Reads never fail on damaged *history*: it is surfaced (corrupt_reason) instead. Receipt recovery needs only its own intact rows, so a
			// lost pointer there yields no current_version rather than an error, and the current version is never inferred from surviving rows.
			let maybeCatalog: ReadCatalog | undefined;
			if (request.action === "receipt" || request.action === "verify_manager") {
				// Receipt recovery and the manager check that precedes an exact submit retry need no current version at all.
				try { maybeCatalog = loadFactoryVersionCatalog(db, version, row, { strictHistory: false }); }
				catch { maybeCatalog = undefined; }
			} else if (request.action === "inspect") {
				// Inspect shows damaged current evidence as unknown/error rather than hiding the queue and head behind it.
				maybeCatalog = loadReadCatalog(db, version, row);
			} else {
				maybeCatalog = loadFactoryVersionCatalog(db, version, row, { strictHistory: false });
			}

			if (request.action === "inspect") {
				const catalog = maybeCatalog!;
				// A lost or damaged pointer is not read around: it defines which history and current version exist at all.
				if (catalog.currentVersion === undefined) throw new Error(catalog.currentError ?? "Factory current version pointer cannot be verified");
				const currentVersion = catalog.currentVersion;
				const requestedVersion = request.version !== undefined
					? parseVersionToken(request.version, "version").version
					: currentVersion;
				// The inspected definition is exactly the requested version's own verified record: when it (by default the current version) is
				// damaged or the pointer is unreadable it is omitted with `inspected_error`, never replaced by another version's data.
				let definition: Definition | undefined;
				let inspectedError: string | undefined;
				if (requestedVersion === currentVersion) {
					definition = catalog.currentDefinition;
					inspectedError = definition ? undefined : catalog.currentError;
				} else {
					const requestedError = catalog.versionErrors.get(requestedVersion);
					if (requestedError) throw new Error(requestedError);
					definition = catalog.definitionsByVersion.get(requestedVersion);
					if (!definition) {
						throw new Error(`Version "${requestedVersion}" not found for factory "${row.name}" (${factoryId})`);
					}
				}
				const node_policies = definition ? summarizeNodePolicies(definition) : undefined;
				const currentFields = {
					...(catalog.currentError ? { current_error: catalog.currentError } : {}),
					...(inspectedError ? { inspected_error: inspectedError } : {}),
				};
				// Stand-in for checkout/capacity evidence only when the head's own definition cannot be loaded; reported as such.
				const standIn = (preferred?: Definition): { definition: Definition; version: string; headBound: boolean } => {
					if (preferred) return { definition: preferred, version: "", headBound: true };
					if (catalog.currentDefinition) return { definition: catalog.currentDefinition, version: currentVersion, headBound: false };
					const newest = [...catalog.definitionsByVersion.entries()].sort((a, b) => Number(b[0].slice(1)) - Number(a[0].slice(1)))[0];
					if (newest) return { definition: newest[1], version: newest[0], headBound: false };
					return { definition: verifyStoredFactory(row), version: "v1", headBound: false };
				};
				const coordCheck = inspectCoordContinuityReadOnly(coordPath, hasCoord ? db : undefined);
				const canonicalFactoryDb = realpathSync(path);
				const canonicalCoordDb = existsSync(coordPath) ? realpathSync(coordPath) : coordPath;
				const versionEvidence = {
					currentVersion: catalog.currentVersion,
					definitionsByVersion: catalog.definitionsByVersion,
					versionErrors: catalog.versionErrors,
				};
				const checkoutEvidenceFor = (target: Definition, attemptCheckoutKeys?: string[]) => {
					let liveCheckout = target.project_cwd;
					let liveCheckoutKey: string | undefined;
					try {
						const liveIdentity = resolveCheckoutIdentity(target.project_cwd);
						liveCheckout = liveIdentity.canonical_checkout;
						liveCheckoutKey = liveIdentity.checkout_key;
					} catch { /* handled in inspectLaunchEvidence */ }
					return collectCheckoutEvidence(db, {
						coordVersion: coordCheck.coordVersion,
						retainedCheckout: target.project_cwd,
						liveCheckout,
						liveCheckoutKey,
						...(attemptCheckoutKeys ? { attemptCheckoutKeys } : {}),
						factoryId,
						factoryDbPath: canonicalFactoryDb,
					});
				};
				let checkoutBasis: { version?: string; head_bound: boolean } = { head_bound: true };
				const unmanagedResult = (ev: ReturnType<typeof inspectLaunchEvidence>): Inspection => ({
					factory: summary(row, "unmanaged", currentVersion),
					inspected_version: requestedVersion,
					...(definition ? { definition } : {}),
					...currentFields,
					versions: catalog.versions,
					...(node_policies ? { node_policies } : {}),
					runtime_assumptions: FACTORY_RUNTIME_ASSUMPTIONS,
					queue: [],
					...ev,
				});
				const evidenceParams = (coordEv: ReturnType<typeof checkoutEvidenceFor>) => ({
					factory: row,
					factoryDbPath: canonicalFactoryDb,
					coordDbPath: canonicalCoordDb,
					...versionEvidence,
					checkoutHold: coordEv.checkoutHold,
					checkoutHoldConflictError: coordEv.checkoutHoldConflictError,
					checkoutManagedRuns: coordEv.checkoutManagedRuns,
					factoryCheckoutHolds: coordEv.factoryCheckoutHolds,
					managedRuns: coordEv.managedRuns,
					coordContinuityError: coordCheck.error,
					bootstrap,
				});

				if (version === 1) {
					const target = definition ?? standIn().definition;
					const ev = inspectLaunchEvidence({
						...evidenceParams(checkoutEvidenceFor(target)),
						definition: target,
						managed: false,
						inputs: [],
						attempts: [],
						factoryHold: undefined,
					});
					return unmanagedResult(ev);
				}
				const inputs = db.prepare(
					"SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC",
				).all(factoryId) as StoredInput[];
				const { state, manager } = verifyEstablishedState(row, selectState(db, factoryId), selectManager(db, factoryId), inputs.length > 0);
				const { attempts, tokenDigests, nonceDigests, checkoutKeys } = version >= 4
					? selectAttemptsWithTokens(db, factoryId, catalog.currentVersion)
					: { attempts: [], tokenDigests: new Map<string, string | null>(), nonceDigests: new Map<string, string | null>(), checkoutKeys: new Map<string, string>() };
				const factoryHold = version >= 4 ? selectFactoryHold(db, factoryId) : undefined;
				if (!manager) {
					const target = definition ?? standIn().definition;
					const ev = inspectLaunchEvidence({
						...evidenceParams(checkoutEvidenceFor(target, attemptCheckoutKeysFor(attempts, checkoutKeys, target.project_cwd))),
						definition: target,
						managed: false,
						inputs: [],
						attempts,
						attemptTokenDigests: tokenDigests,
						attemptNonceDigests: nonceDigests,
						attemptCheckoutKeys: checkoutKeys,
						factoryHold,
					});
					return unmanagedResult(ev);
				}
				const verifiedQueue = verifyQueueCompleteness(row, inputs, state.last_input_position, catalog.currentVersion);
				let stopped: boolean | undefined;
				let controlError: string | undefined;
				try { stopped = isFactoryStopped(db, factoryId, version); } catch (error) { controlError = errorMessage(error); }
				// Launch eligibility is evaluated against the head's bound version, never the current pointer.
				const head = firstWaitingInput(verifiedQueue, attempts);
				const headBound = head ? resolveBoundVersion(catalog, row, head.bound_version) : undefined;
				const stand = standIn(headBound?.definition);
				const launchTarget = stand.definition;
				checkoutBasis = { ...(stand.headBound ? {} : { version: stand.version }), head_bound: stand.headBound || !head };
				let requests: DirectionRequestView[] | undefined;
				let requestEvidenceError: string | undefined;
				try { requests = reconciledRequests(db, factoryId); }
				catch (error) { requestEvidenceError = errorMessage(error); }
				const { interventions, ...ev } = inspectLaunchEvidence({
					...evidenceParams(checkoutEvidenceFor(launchTarget, attemptCheckoutKeysFor(attempts, checkoutKeys, launchTarget.project_cwd))),
					pendingRequests: requests?.filter(item => item.can_respond || item.can_redeliver || item.reconciliation === "uncertain"),
					definition: launchTarget,
					headVersionError: headBound?.error,
					currentVersionError: catalog.currentError,
					managed: true,
					inputs: verifiedQueue,
					attempts,
					attemptTokenDigests: tokenDigests,
					attemptNonceDigests: nonceDigests,
					attemptCheckoutKeys: checkoutKeys,
					factoryHold,
				});
				const attemptByInput = new Map(ev.attempts.map(a => [a.input_id, a]));
				const queueWithAttempts = verifiedQueue.map(item => {
					const att = attemptByInput.get(item.input_id);
					return att ? { ...item, attempt: att } : item;
				});
				const bound_policies: Record<string, Record<string, FactoryNodePolicySummary>> = {};
				for (const boundVersion of new Set([...verifiedQueue.map(item => item.bound_version), ...attempts.map(item => item.bound_version)])) {
					const retained = catalog.definitionsByVersion.get(boundVersion);
					if (retained) bound_policies[boundVersion] = summarizeNodePolicies(retained);
				}
				return {
					factory: summary(row, "managed", currentVersion),
					inspected_version: requestedVersion,
					...(definition ? { definition } : {}),
					...currentFields,
					versions: catalog.versions,
					...(node_policies ? { node_policies } : {}),
					bound_policies,
					...(!checkoutBasis.head_bound ? { checkout_evidence_stand_in: checkoutBasis.version } : {}),
					runtime_assumptions: FACTORY_RUNTIME_ASSUMPTIONS,
					queue: queueWithAttempts,
					...ev,
					...(controlError ? { control_error: controlError } : { stopped }),
					...(stopped || controlError ? { head_status: {
						...ev.head_status, eligible: false, blocking_kind: stopped ? "stopped" : "uncertain",
						reason: controlError ?? "Factory is stopped; explicitly resume to permit new launch starts",
						without_control_fence: ev.head_status,
					} } : {}),
					...(requestEvidenceError ? { request_evidence_error: requestEvidenceError } : { requests }),
					attention: [
						...(requestEvidenceError ? [{ kind: "uncertain" as const, reason: requestEvidenceError }] : []),
						...(controlError ? [{ kind: "uncertain" as const, reason: controlError }] : []),
						...(interventions ?? []),
						...ev.attempts.flatMap((att): AttentionItem[] => att.node_counts_error ? [{ kind: "report_notice", attempt_id: att.attempt_id, input_id: att.input_id, task_id: att.task_id, reason: att.node_counts_error }] : []),
						...ev.attempts.filter(att => att.state === "failed_before_release" && !att.historical).map((att): AttentionItem => ({ kind: "failed_run", attempt_id: att.attempt_id, input_id: att.input_id, task_id: att.task_id, reason: att.error ?? "Launch failed before release; inspect the retained attempt" })),
						...ev.attempts.flatMap(att => (att.settlement?.attention ?? []).map((reason): AttentionItem => ({ kind: "failed_run", attempt_id: att.attempt_id, input_id: att.input_id, task_id: att.task_id, reason }))),
						...ev.attempts.filter(att => att.settlement?.capacity_release === "held" && att.settlement.execution_settlement.state === "unknown" && !att.uncertainty?.length).map((att): AttentionItem => ({ kind: "uncertain", attempt_id: att.attempt_id, input_id: att.input_id, task_id: att.task_id, reason: `capacity hold cannot be released: ${att.settlement!.execution_settlement.reason}${att.clearance_eligibility?.eligible ? "; operator clearance is available (/factory clear)" : ""}` })),
						...ev.uncertainty.map((reason): AttentionItem => ({ kind: "uncertain", reason })),
					],
				};
			}

			if (request.action === "verify_manager") {
				const authRecord = requireAuthority(request.authority);
				if (version === 1) {
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
				const { manager } = verifyEstablishedState(row, selectState(db, factoryId), selectManager(db, factoryId), hasAcceptedInputs(db, factoryId));
				if (!manager) {
					throw new Error(`Factory "${row.name}" (${row.factory_id}) is unmanaged; explicitly resume management with /factory resume ${row.factory_id} first`);
				}
				if (!authorityMatches(manager, authRecord)) {
					throw new Error(`Management authority mismatch for factory "${row.name}" (${row.factory_id}); only the active managing session can submit`);
				}
				// The current version is reported only when it verifies; a damaged pointer or definition never blocks the owner check.
				return maybeCatalog ? summary(row, "managed", maybeCatalog.currentVersion) : { factory_id: row.factory_id, name: row.name, management: "managed" };
			}

			const hasRef = request.reference !== undefined;
			const hasId = request.input_id !== undefined;
			if (hasRef && hasId) throw new Error('Receipt lookup accepts either "reference" or "input_id", not both');
			if (!hasRef && !hasId) throw new Error('Receipt lookup requires "reference" or "input_id"');
			const lookupRef = hasRef ? validateToken(request.reference, "reference") : undefined;
			const lookupId = hasId ? validateToken(request.input_id, "input_id") : undefined;
			if (version === 1) {
				throw new Error(`Receipt not found for factory ${factoryId} (${hasRef ? `reference "${lookupRef}"` : `input_id "${lookupId}"`})`);
			}
			const stored = (hasRef
				? db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND reference = ?").get(factoryId, lookupRef!)
				: db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM factory_inputs WHERE factory_id = ? AND input_id = ?").get(factoryId, lookupId!)
			) as StoredInput | undefined;
			if (!stored) {
				throw new Error(`Receipt not found for factory ${factoryId} (${hasRef ? `reference "${lookupRef}"` : `input_id "${lookupId}"`})`);
			}
			const receipt = verifyInputRow(stored, maybeCatalog?.currentVersion);
			if (version >= 4) {
				const attemptRow = db.prepare(
					`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
						release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
					FROM factory_attempts WHERE input_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				).get(receipt.input_id) as StoredAttempt | undefined;
				if (attemptRow) {
					const verifiedAttempt = verifyAttemptRow(attemptRow, maybeCatalog?.currentVersion);
					const counts = verifiedAttempt.release_authorized
						? deriveAttemptNodeCounts({
							taskId: verifiedAttempt.task_id,
							sessionDir: join(verifiedAttempt.canonical_checkout, ".pi", "agent-sessions", verifiedAttempt.task_id),
							requirePresent: verifiedAttempt.state !== "cleared",
						})
						: {};
					return {
						...receipt,
						attempt: {
							...verifiedAttempt,
							...(counts.node_counts ? { node_counts: counts.node_counts } : {}),
							...(counts.node_counts_error ? { node_counts_error: counts.node_counts_error } : {}),
						},
					};
				}
			}
			return receipt;
		} catch (error) { throw readFailure(error); }
		finally { db.close(); }
	}
	return operate;
}
