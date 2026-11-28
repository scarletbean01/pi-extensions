import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import {
	cancelPath,
	outcomeClaimPath,
	readCancelRecordSafe,
	readOutcomeClaimSafe,
	readRunCancelRecordSafe,
	runCancelPath,
	type ProgressSnapshot,
} from "../../bootstrap/cancellation.ts";
import { verifyBoundReviewPlan } from "../../bootstrap/factory-requests.ts";
import { currentAttempt, handoffClaimPath } from "../../bootstrap/handoff.ts";
import { executionFromResult, type ExecutionState } from "../../bootstrap/outcomes.ts";
import { failFastPath, readFailFast } from "../../bootstrap/ownership.ts";
import {
	attemptNumber,
	finalizePath,
	finalizedReviewRejection,
	readFinalization,
	reviewLoopFor,
} from "../../bootstrap/review-loop.ts";
import {
	assertNoSymlinkPath,
	dispositionPath,
	expectationFor,
	inboundEdgesOf,
	parseCompletion,
	parseDisposition,
	parseWorkerReady,
	pathEntryExists,
	processAlive,
	readyPath,
	resultPath,
	type AgentLaunch,
	type BootstrapManifest,
} from "../../bootstrap/session-store.ts";
import type { TypedAbsence } from "./inspect.ts";
import { assertRegularFileIfExists } from "./live.ts";
import { deletionMarkerFields, sanitizeOutputText } from "./sanitize.ts";

export const OUTPUT_SUMMARY_MAX_CHARS = 1000;
export const OUTPUT_DETAIL_MAX_CHARS = 8000;
const MAX_OUTPUT_FILE_BYTES = 1024 * 1024;

const OUTPUT_STATUS_TEXT: Record<ExecutionState, string> = {
	pending: "Pending",
	waiting: "Waiting",
	running: "Running",
	succeeded: "Succeeded",
	partial: "Partial",
	failed: "Failed",
	blocked: "Blocked",
	skipped: "Skipped",
	cancelled: "Cancelled",
	needs_attention: "Uncertain",
};

function assertPathInsideDir(dir: string, targetPath: string, label: string): void {
	const rel = relative(resolve(dir), resolve(targetPath));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Refusing ${label} outside session directory`);
	}
}

function assertRegularDirNoSymlink(dir: string, label: string): void {
	assertNoSymlinkPath(dir);
	if (!pathEntryExists(dir)) {
		throw new Error(`Missing ${label}`);
	}
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`Refusing non-directory ${label}`);
	}
}

function readBoundedRegularJsonIfExists<T>(
	dir: string,
	filePath: string,
	label: string,
	maxBytes = MAX_OUTPUT_FILE_BYTES,
): { exists: false } | { exists: true; value: T } {
	assertPathInsideDir(dir, filePath, label);
	if (!pathEntryExists(filePath)) return { exists: false };
	assertNoSymlinkPath(filePath);
	const st = lstatSync(filePath);
	if (st.isSymbolicLink() || !st.isFile()) {
		throw new Error(`Refusing non-regular ${label}`);
	}
	if (st.size > maxBytes) {
		throw new Error(`Refusing oversized ${label}`);
	}
	const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const fst = fstatSync(fd);
		if (!fst.isFile()) {
			throw new Error(`Refusing non-regular ${label}`);
		}
		if (fst.size > maxBytes) {
			throw new Error(`Refusing oversized ${label}`);
		}
		return { exists: true, value: JSON.parse(readFileSync(fd, "utf8")) as T };
	} finally {
		closeSync(fd);
	}
}

function assertRunEvidenceConsistent(inspection: Inspection, releases: ReleasedFactoryRun[]) {
	const { factory, attempts, capacity, head_status } = inspection;
	const anyActiveAuthorized = attempts.filter(a => !a.historical && a.release_authorized);
	const active = anyActiveAuthorized.filter(a => a.state === "released");
	const badHistoricalReleased = attempts.some(
		a => ((a.state === "settled" || a.state === "cleared") && (!a.release_authorized || !a.settlement || Boolean(a.uncertainty?.length)))
			|| (a.state === "proven_not_released" && a.release_authorized),
	);
	const contradictoryHistoricalReleased = attempts.some(
		a => a.historical && a.release_authorized && a.state === "released",
	);
	const hasCurrentAttempt = attempts.some(a => !a.historical);
	const headExplainsFactoryHold = head_status.blocking_kind === "factory_held" || head_status.without_control_fence?.blocking_kind === "factory_held";
	const contradictoryFactoryHold = capacity.factory_slot === "held" && !hasCurrentAttempt && !headExplainsFactoryHold;
	const hasUncertainty = Boolean(
		inspection.uncertainty.length ||
		inspection.current_error ||
		inspection.control_error ||
		head_status.blocking_kind === "uncertain" ||
		capacity.factory_slot === "uncertain" ||
		capacity.checkout_slot === "uncertain" ||
		badHistoricalReleased ||
		contradictoryHistoricalReleased ||
		contradictoryFactoryHold,
	);

	if (inspection.deleted) {
		if (anyActiveAuthorized.length || releases.length || hasUncertainty || capacity.factory_slot === "held") {
			return { state: "uncertain" as const };
		}
		return { state: "no_displayed_run" as const };
	}
	if (anyActiveAuthorized.length || releases.length) {
		if (
			anyActiveAuthorized.length !== 1 ||
			active.length !== 1 ||
			releases.length !== 1 ||
			Boolean(active[0].uncertainty?.length) ||
			active[0].attempt_id !== releases[0].attempt_id ||
			active[0].bound_version !== releases[0].bound_version ||
			active[0].task_id !== releases[0].manifest.task_id ||
			releases[0].manifest.factory_managed?.factory_id !== factory.factory_id ||
			releases[0].manifest.factory_managed?.attempt_id !== active[0].attempt_id ||
			capacity.factory_slot !== "held" ||
			capacity.checkout_slot !== "held"
		) {
			return { state: "uncertain" as const };
		}
		return { state: "released" as const, release: releases[0] };
	}
	if (hasUncertainty) {
		return { state: "uncertain" as const };
	}
	return { state: "no_displayed_run" as const };
}

function verifyReleaseMatchesDefinition(factoryId: string, release: ReleasedFactoryRun): Map<string, AgentLaunch> {
	const { definition, manifest, bound_version } = release;
	if (manifest.factory_managed?.factory_id !== factoryId || manifest.factory_managed?.bound_version !== bound_version) {
		throw new Error("Run factory binding does not match the selected factory release");
	}
	if (manifest.topology !== definition.topology || manifest.pane_manifest.length !== definition.agents.length) {
		throw new Error("Run topology differs from the retained version");
	}
	const roster = new Map(manifest.pane_manifest.map(entry => [entry.node_id, entry]));
	const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry.node_id]));
	if (roster.size !== definition.agents.length || byInstance.size !== definition.agents.length) {
		throw new Error("Run roster contains duplicate node or instance identifiers");
	}
	verifyBoundReviewPlan(definition, manifest.review_plan, manifest.pane_manifest);
	for (const entry of definition.agents) {
		const node = entry.node;
		const launched = roster.get(node.node_id);
		const inbound = inboundEdgesOf(node);
		if (!launched || (launched.kind ?? "agent") !== (node.kind ?? "agent") ||
			JSON.stringify(inboundEdgesOf(launched).map(id => byInstance.get(id))) !== JSON.stringify(inbound)) {
			throw new Error("Run roster differs from the retained version");
		}
	}
	return roster;
}

function latestAttemptOutputForNode(
	manifest: BootstrapManifest,
	entry: AgentLaunch,
	blockedPaths: readonly string[],
) {
	const { session_dir: dir, task_id, review_plan } = manifest;
	const loop = reviewLoopFor(review_plan, entry.instance_id);
	const maxAttempts = loop ? loop.max_revisions + 1 : 1;

	const unavailable = (
		attemptId: string | undefined,
		attemptNumberVal: number,
		explanation: string,
	) => ({
		attempt_id: attemptId ?? { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity could not be verified." },
		attempt_number: attemptNumberVal,
		max_attempts: maxAttempts,
		status: "needs_attention" as ExecutionState,
		status_text: OUTPUT_STATUS_TEXT.needs_attention,
		evidence: "unavailable" as const,
		absence: "evidence unavailable" as TypedAbsence,
		explanation,
	});

	const notApplicable = (
		attemptId: string | undefined,
		attemptNumberVal: number,
		status: ExecutionState,
		statusText: string,
		explanation: string,
	) => ({
		attempt_id: attemptId ?? { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity could not be verified." },
		attempt_number: attemptNumberVal,
		max_attempts: maxAttempts,
		status,
		status_text: statusText,
		evidence: "not applicable" as const,
		absence: "not applicable" as TypedAbsence,
		explanation,
	});

	let resolvedAttemptNum = 1;
	let resolvedAttemptId = entry.attempt_id;

	try {
		assertRegularDirNoSymlink(dir, "session directory");
		if (loop) {
			assertPathInsideDir(dir, finalizePath(dir, entry.instance_id), "finalization record");
			assertRegularFileIfExists(finalizePath(dir, entry.instance_id), "finalization record", MAX_OUTPUT_FILE_BYTES);
			assertPathInsideDir(dir, finalizePath(dir, loop.reviewer), "reviewer finalization record");
			assertRegularFileIfExists(finalizePath(dir, loop.reviewer), "reviewer finalization record", MAX_OUTPUT_FILE_BYTES);
			for (let n = 1; n <= maxAttempts; n++) {
				const keyN = `${entry.instance_id}.${n}`;
				for (const [p, lbl] of [
					[resultPath(dir, keyN), "loop result"],
					[dispositionPath(dir, keyN), "loop disposition"],
					[join(dir, `${keyN}.error.json`), "loop error"],
					[join(dir, `${keyN}.transition.json`), "loop transition"],
					[join(dir, `${loop.reviewer}.${n}.revision.json`), "revision reservation"],
				] as const) {
					assertPathInsideDir(dir, p, lbl);
					assertRegularFileIfExists(p, lbl, MAX_OUTPUT_FILE_BYTES);
				}
				for (const src of inboundEdgesOf(entry)) {
					const claimP = handoffClaimPath(dir, keyN, src);
					assertPathInsideDir(dir, claimP, "revision handoff claim");
					assertRegularFileIfExists(claimP, "revision handoff claim", MAX_OUTPUT_FILE_BYTES);
				}
				if (loop.target === entry.instance_id) {
					const fbClaimP = handoffClaimPath(dir, keyN, loop.reviewer);
					assertPathInsideDir(dir, fbClaimP, "feedback handoff claim");
					assertRegularFileIfExists(fbClaimP, "feedback handoff claim", MAX_OUTPUT_FILE_BYTES);
				}
			}
		}

		let attempt = currentAttempt(manifest, entry);
		const finalization = loop && readFinalization(dir, task_id, loop, entry.instance_id, manifest.topology, manifest.version);
		if (finalization && attempt && attemptNumber(finalization.attempt_id) < attempt.number) {
			attempt = { ...attempt, number: attemptNumber(finalization.attempt_id) };
		}
		const attemptNum = attempt?.number ?? 1;
		const attemptId = attempt ? `${entry.instance_id}.${attempt.number}` : entry.attempt_id;
		resolvedAttemptNum = attemptNum;
		resolvedAttemptId = attemptId;
		if (finalization && attemptId && finalization.attempt_id !== attemptId) {
			throw new Error("Finalization does not match the latest attempt");
		}

		const key = review_plan && (attempt || finalization) ? (attemptId ?? entry.instance_id) : entry.instance_id;
		const expected = { ...expectationFor(manifest, entry), attempt_id: attemptId };
		const resFile = resultPath(dir, key);
		const dispFile = dispositionPath(dir, key);
		assertPathInsideDir(dir, resFile, "node result");
		assertPathInsideDir(dir, dispFile, "node disposition");
		const hasResult = pathEntryExists(resFile);
		const hasDisposition = pathEntryExists(dispFile);
		if (hasResult && hasDisposition) {
			throw new Error("Contradictory result and disposition records");
		}

		// Pre-check supporting status records with size limit before parsing.
		const readyFile = readyPath(dir, entry.instance_id);
		const progressFile = join(dir, `${entry.instance_id}.progress.json`);
		const cancelFile = cancelPath(dir, entry.instance_id);
		const runCancelFile = runCancelPath(dir);
		const ffFile = failFastPath(dir);
		const claimFile = outcomeClaimPath(dir, key);
		assertPathInsideDir(dir, cancelFile, "cancel record");
		assertPathInsideDir(dir, runCancelFile, "run cancel record");
		assertPathInsideDir(dir, ffFile, "fail-fast record");
		assertPathInsideDir(dir, claimFile, "outcome claim");
		assertRegularFileIfExists(cancelFile, "cancel record", MAX_OUTPUT_FILE_BYTES);
		assertRegularFileIfExists(runCancelFile, "run cancel record", MAX_OUTPUT_FILE_BYTES);
		assertRegularFileIfExists(ffFile, "fail-fast record", MAX_OUTPUT_FILE_BYTES);
		assertRegularFileIfExists(claimFile, "outcome claim", MAX_OUTPUT_FILE_BYTES);

		const readyRead = readBoundedRegularJsonIfExists<unknown>(dir, readyFile, "worker readiness");
		let readyAlive = false;
		let processState: "alive" | "exited" | "not_started" = "not_started";
		if (readyRead.exists) {
			const ready = parseWorkerReady(readyRead.value);
			if (ready.token !== manifest.token || ready.task_id !== task_id || ready.instance_id !== entry.instance_id) {
				throw new Error("Foreign readiness");
			}
			readyAlive = processAlive(ready);
			processState = readyAlive ? "alive" : "exited";
		}

		const cancelInfo = readCancelRecordSafe(dir, {
			run_id: task_id,
			node_id: entry.node_id,
			persona_name: entry.persona_name,
			instance_id: entry.instance_id,
			...(attemptId ? { attempt_id: attemptId } : {}),
		});
		const runCancelInfo = readRunCancelRecordSafe(dir, task_id);
		const failFastInfo = readFailFast(dir, task_id, manifest.token);
		const claimInfo = readOutcomeClaimSafe(dir, {
			run_id: task_id,
			node_id: entry.node_id,
			persona_name: entry.persona_name,
			instance_id: entry.instance_id,
			...(attemptId ? { attempt_id: attemptId } : {}),
		}, key);
		if (cancelInfo.error || runCancelInfo.error || failFastInfo.error || claimInfo.error) {
			throw new Error(cancelInfo.error ?? runCancelInfo.error ?? failFastInfo.error ?? claimInfo.error);
		}

		const progressRead = readBoundedRegularJsonIfExists<ProgressSnapshot>(dir, progressFile, "node progress");
		let matchingProgress: ProgressSnapshot | undefined;
		if (progressRead.exists) {
			const progress = progressRead.value;
			if (progress.token !== manifest.token) throw new Error("Foreign progress");
			if (progress.attempt_id !== undefined && progress.attempt_id !== attemptId) {
				if (!(review_plan && progress.state === "completed" && progress.attempt_id.startsWith(`${entry.instance_id}.`))) {
					throw new Error("Progress attempt mismatch");
				}
			} else if (review_plan && progress.attempt_id === undefined) {
				throw new Error("Missing review progress attempt");
			} else {
				matchingProgress = progress;
			}
		}

		if (hasDisposition) {
			const dispRead = readBoundedRegularJsonIfExists<unknown>(dir, dispFile, "node disposition");
			if (!dispRead.exists) {
				return unavailable(attemptId, attemptNum, "Disposition record could not be read.");
			}
			const disp = parseDisposition(dispRead.value, expected);
			if (disp.state === "needs_attention") {
				return unavailable(attemptId, attemptNum, "Attempt ended with unresolved evidence and no recorded result.");
			}
			return notApplicable(
				attemptId,
				attemptNum,
				disp.state,
				OUTPUT_STATUS_TEXT[disp.state],
				`No attempt result was recorded (${disp.state}).`,
			);
		}

		if (hasResult) {
			const resRead = readBoundedRegularJsonIfExists<unknown>(dir, resFile, "node result");
			if (!resRead.exists) {
				return unavailable(attemptId, attemptNum, "Result record could not be read.");
			}
			const record = parseCompletion(resRead.value, expected);
			const baseState = executionFromResult(record.result.status).state;
			const rejection = loop && finalization
				? finalizedReviewRejection(loop, finalization, entry.node_id, record.result)
				: undefined;
			const status = rejection ? rejection.state : baseState;
			const statusText = OUTPUT_STATUS_TEXT[status];
			const summary = sanitizeOutputText(record.result.summary, OUTPUT_SUMMARY_MAX_CHARS, blockedPaths);
			const rawDetail = typeof record.result.detail === "string" ? record.result.detail : "";
			const detail = sanitizeOutputText(rawDetail, OUTPUT_DETAIL_MAX_CHARS, blockedPaths);
			return {
				attempt_id: attemptId ?? { absence: "evidence unavailable" as TypedAbsence, explanation: "Attempt identity could not be verified." },
				attempt_number: attemptNum,
				max_attempts: maxAttempts,
				status,
				status_text: statusText,
				result_status: record.result.status,
				evidence: "available" as const,
				summary,
				detail,
				...(record.completed_at ? { completed_at: record.completed_at } : {}),
			};
		}

		const scopedErrorFile = join(dir, `${key}.error.json`);
		const fallbackErrorFile = join(dir, `${entry.instance_id}.error.json`);
		const errorFile = review_plan && !pathEntryExists(scopedErrorFile) && attemptNum === 1
			? fallbackErrorFile
			: scopedErrorFile;
		if (pathEntryExists(errorFile)) {
			readBoundedRegularJsonIfExists<unknown>(dir, errorFile, "node error");
			return unavailable(attemptId, attemptNum, "The attempt recorded an execution error without a verified result.");
		}
		if (entry.error) {
			return unavailable(attemptId, attemptNum, "The attempt launch recorded an error without a verified result.");
		}
		if (claimInfo.claim?.outcome === "completed") {
			return unavailable(attemptId, attemptNum, "The attempt recorded completion without a readable result record.");
		}

		const matchingNodeCancel = cancelInfo.record && (!review_plan || !cancelInfo.record.identity.attempt_id || cancelInfo.record.identity.attempt_id === attemptId)
			? cancelInfo.record
			: undefined;
		const activeCancel = matchingNodeCancel ?? (claimInfo.claim?.outcome === "completed" ? undefined : runCancelInfo.record);
		if (activeCancel) {
			if (matchingProgress?.state === "working" && readyAlive && entry.status !== "closed") {
				return notApplicable(
					attemptId,
					attemptNum,
					"running",
					"Running (cancelling)",
					"Attempt output is recorded when the attempt finishes.",
				);
			}
			return notApplicable(
				attemptId,
				attemptNum,
				"cancelled",
				OUTPUT_STATUS_TEXT.cancelled,
				"No attempt result was recorded because the attempt was cancelled.",
			);
		}

		if (processState === "exited" || entry.status === "closed") {
			return unavailable(attemptId, attemptNum, "The attempt ended before a verified result record was saved.");
		}

		if (readyAlive && matchingProgress) {
			const status: ExecutionState = matchingProgress.state === "working" && matchingProgress.waiting_for_human_since === undefined
				? "running"
				: "waiting";
			return notApplicable(
				attemptId,
				attemptNum,
				status,
				OUTPUT_STATUS_TEXT[status],
				"Attempt output is recorded when the attempt finishes.",
			);
		}

		return notApplicable(
			attemptId,
			attemptNum,
			"pending",
			OUTPUT_STATUS_TEXT.pending,
			"Attempt output is recorded when the attempt finishes.",
		);
	} catch {
		return unavailable(
			resolvedAttemptId,
			resolvedAttemptNum,
			"Attempt output evidence is unavailable because the result record is missing, damaged, unreadable, or fails verification.",
		);
	}
}

export type OutputSnapshotOutcome =
	| { kind: "not_found"; error: string }
	| { kind: "ok"; body: Record<string, unknown> };

/** Project the latest attempt's scrubbed, bounded output for one node of a factory's displayed run. */
export function nodeOutputSnapshot(
	factoryId: string,
	nodeId: string,
	inspection: Inspection,
	releases: ReleasedFactoryRun[],
	blockedPaths: readonly string[] = [],
): OutputSnapshotOutcome {
	const deletionFields = deletionMarkerFields(inspection, blockedPaths);
	const consistent = assertRunEvidenceConsistent(inspection, releases);
	if (consistent.state === "no_displayed_run") {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}
	if (consistent.state === "uncertain") {
		return {
			kind: "ok",
			body: {
				factory_id: factoryId,
				node_id: nodeId,
				...deletionFields,
				evidence: "unavailable",
				absence: "evidence unavailable" as TypedAbsence,
				explanation: "Run evidence is uncertain; attempt output cannot be verified.",
			},
		};
	}

	const release = consistent.release;
	let roster: Map<string, AgentLaunch>;
	try {
		roster = verifyReleaseMatchesDefinition(factoryId, release);
	} catch {
		return {
			kind: "ok",
			body: {
				factory_id: factoryId,
				node_id: nodeId,
				...deletionFields,
				evidence: "unavailable",
				absence: "evidence unavailable" as TypedAbsence,
				explanation: "Run topology could not be verified against its bound definition.",
			},
		};
	}

	const entry = roster.get(nodeId);
	if (!entry) {
		return { kind: "not_found", error: "Node not found in displayed run" };
	}

	const { manifest, bound_version } = release;
	const runBlockedPaths = [
		...blockedPaths,
		manifest.session_dir,
		manifest.project_cwd,
		...(manifest.factory_managed?.canonical_checkout ? [manifest.factory_managed.canonical_checkout] : []),
	];
	const latestAttempt = latestAttemptOutputForNode(manifest, entry, runBlockedPaths);

	return {
		kind: "ok",
		body: {
			factory_id: factoryId,
			node_id: nodeId,
			run_id: manifest.task_id,
			bound_version,
			...deletionFields,
			evidence: latestAttempt.evidence,
			latest_attempt: latestAttempt,
		},
	};
}
