import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import { readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe, type ProgressSnapshot } from "../../bootstrap/cancellation.ts";
import { verifyBoundReviewPlan } from "../../bootstrap/factory-requests.ts";
import { currentAttempt, describeHandoff, handoffClaimPath, handoffOfferPath, handoffRecoveryPath, handoffRejectionsPath } from "../../bootstrap/handoff.ts";
import { aggregateRun, decideAdmission, deriveEdgeState, effectiveDependencyPolicy, executionFromResult, type CauseRef, type EdgeState, type EvidenceStatus, type ExecutionState } from "../../bootstrap/outcomes.ts";
import { readFailFast } from "../../bootstrap/ownership.ts";
import { attemptNumber, blockedReviewForwardEdge, finalizePath, finalizedReviewRejection, readFinalization, reviewLoopFor, type ReviewLoop } from "../../bootstrap/review-loop.ts";
import { assertNoSymlinkPath, dispositionPath, expectationFor, inboundEdgesOf, parseCompletion, parseDisposition, parseWorkerReady, pathEntryExists, processAlive, readRegularJsonNoSymlink, readyPath, resultPath, type AgentLaunch, type BootstrapManifest, type CommandEvidence } from "../../bootstrap/session-store.ts";
import { headSummary, nodeLink, type TypedAbsence } from "./inspect.ts";

const STATUS_TEXT: Record<ExecutionState, string> = {
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

const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

function assertRegularFileIfExists(path: string, label: string, maxBytes = MAX_EVIDENCE_FILE_BYTES): boolean {
  if (!pathEntryExists(path)) return false;
  assertNoSymlinkPath(path);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing non-regular ${label}`);
  }
  if (st.size > maxBytes) {
    throw new Error(`Refusing oversized ${label}`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      throw new Error(`Refusing non-regular ${label}`);
    }
    if (fst.size > maxBytes) {
      throw new Error(`Refusing oversized ${label}`);
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

function projectCommandOutcome(ev: CommandEvidence | undefined) {
  if (!ev) return undefined;
  return {
    exit_code: ev.exit_code,
    signal: ev.signal,
    duration_ms: ev.duration_ms,
  };
}

function projectCauses(causes: CauseRef[] | undefined) {
  if (!causes?.length) return undefined;
  return causes.map(cause => ({
    node_id: cause.node_id,
    state: cause.state,
    reason: cause.reason,
    ...(cause.check ? { check: { name: cause.check.name, evidence: cause.check.evidence } } : {}),
  }));
}

interface InternalNodeObservation {
  attempt_id?: string;
  attempt_number: number;
  max_attempts: number;
  instance_id: string;
  key: string;
  status: ExecutionState;
  status_text: string;
  reason?: string;
  causes?: Array<{ node_id: string; state: ExecutionState; reason: string; check?: { name: string; evidence: EvidenceStatus } }>;
  parked?: boolean;
  finalized?: boolean;
  last_verdict?: string;
  resource_state: AgentLaunch["status"];
  process_state: "alive" | "exited" | "not_started" | "unknown";
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
  waiting_for_human_since?: string;
  result_status?: "success" | "partial" | "failure";
  summary?: string;
  command?: { exit_code: number | null; signal: NodeJS.Signals | null; duration_ms: number };
  waiting_on?: string[];
  loop?: ReviewLoop;
  review_rejected_closure?: ReturnType<typeof blockedReviewForwardEdge>;
  source_instance?: string;
}

function assertSafeAttemptKey(attemptId: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(attemptId) || attemptId.includes("..")) {
    throw new Error(`Refusing unsafe ${label} key`);
  }
}

function verifyRegularHandoffFiles(
  dir: string,
  destKey: string,
  destInstance: string,
  sourceInstance: string,
  sourceKey: string,
  sourceId?: string,
) {
  assertRegularFileIfExists(handoffOfferPath(dir, destKey, sourceId), "handoff offer");
  const edgeClaimPath = handoffClaimPath(dir, destKey, sourceId);
  const hasEdgeClaim = assertRegularFileIfExists(edgeClaimPath, "handoff claim");
  const joinClaimPath = sourceId ? handoffClaimPath(dir, destKey) : undefined;
  const hasJoinClaim = joinClaimPath ? assertRegularFileIfExists(joinClaimPath, "join handoff claim") : false;
  assertRegularFileIfExists(handoffRejectionsPath(dir, destKey, sourceId), "handoff rejections");
  assertRegularFileIfExists(handoffRecoveryPath(dir, destKey, sourceId), "handoff recovery");
  assertRegularFileIfExists(resultPath(dir, sourceInstance), "source result");
  if (sourceKey !== sourceInstance) {
    assertRegularFileIfExists(resultPath(dir, sourceKey), "source result");
  }
  if (destKey !== destInstance) {
    if (hasEdgeClaim) {
      const claim = readRegularJsonNoSymlink<{ source?: { attempt_id?: unknown } }>(edgeClaimPath, "handoff claim");
      const attempt = claim?.source?.attempt_id;
      if (typeof attempt === "string" && attempt.length > 0) {
        assertSafeAttemptKey(attempt, "source result");
        assertRegularFileIfExists(resultPath(dir, attempt), "source result");
      }
    }
    if (hasJoinClaim && joinClaimPath) {
      const joinClaim = readRegularJsonNoSymlink<{ sources?: Array<{ instance_id?: unknown; attempt_id?: unknown }> }>(joinClaimPath, "join handoff claim");
      const joinSrc = Array.isArray(joinClaim?.sources)
        ? joinClaim.sources.find(s => s && s.instance_id === sourceInstance)
        : undefined;
      const attempt = joinSrc?.attempt_id;
      if (typeof attempt === "string" && attempt.length > 0) {
        assertSafeAttemptKey(attempt, "source result");
        assertRegularFileIfExists(resultPath(dir, attempt), "source result");
      }
    }
  }
}

function nodeObservation(manifest: BootstrapManifest, entry: AgentLaunch, byInstanceNodeId: ReadonlyMap<string, string>): InternalNodeObservation {
  const { session_dir: dir, task_id, review_plan } = manifest;
  const loop = reviewLoopFor(review_plan, entry.instance_id);
  const maxAttempts = loop ? loop.max_revisions + 1 : 1;
  try {
    assertNoSymlinkPath(dir);
    if (loop) {
      assertRegularFileIfExists(finalizePath(dir, entry.instance_id), "finalization record");
      assertRegularFileIfExists(finalizePath(dir, loop.reviewer), "reviewer finalization record");
      for (let n = 1; n <= maxAttempts; n++) {
        const keyN = `${entry.instance_id}.${n}`;
        assertRegularFileIfExists(resultPath(dir, keyN), "loop result");
        assertRegularFileIfExists(join(dir, `${entry.instance_id}.${n}.transition.json`), "loop transition");
        assertRegularFileIfExists(join(dir, `${loop.reviewer}.${n}.revision.json`), "revision reservation");
        for (const src of inboundEdgesOf(entry)) {
          assertRegularFileIfExists(handoffClaimPath(dir, keyN, src), "revision handoff claim");
        }
        if (loop.target === entry.instance_id) {
          assertRegularFileIfExists(handoffClaimPath(dir, keyN, loop.reviewer), "feedback handoff claim");
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
    if (finalization && attemptId && finalization.attempt_id !== attemptId) {
      throw new Error("Finalization does not match the latest attempt");
    }
    const key = review_plan && (attempt || finalization) ? (attemptId ?? entry.instance_id) : entry.instance_id;
    const expected = { ...expectationFor(manifest, entry), attempt_id: attemptId };
    const result = resultPath(dir, key);
    const disposition = dispositionPath(dir, key);
    const hasResult = pathEntryExists(result);
    const hasDisposition = pathEntryExists(disposition);
    if (hasResult && hasDisposition) throw new Error("Contradictory result records");

    const readyFile = readyPath(dir, entry.instance_id);
    let processState: InternalNodeObservation["process_state"] = "not_started";
    let readyAlive = false;
    if (pathEntryExists(readyFile)) {
      const ready = parseWorkerReady(readRegularJsonNoSymlink(readyFile, "worker readiness"));
      if (ready.token !== manifest.token || ready.task_id !== task_id || ready.instance_id !== entry.instance_id) throw new Error("Foreign readiness");
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

    const progressPath = join(dir, `${entry.instance_id}.progress.json`);
    let matchingProgress: ProgressSnapshot | undefined;
    if (pathEntryExists(progressPath)) {
      const progress = readRegularJsonNoSymlink<ProgressSnapshot>(progressPath, "node progress");
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
    const startedAt = matchingProgress && Number.isFinite(matchingProgress.started_at) ? new Date(matchingProgress.started_at!).toISOString() : undefined;
    const updatedAt = matchingProgress && Number.isFinite(matchingProgress.updated_at) ? new Date(matchingProgress.updated_at).toISOString() : undefined;
    const waitingForHumanSince = matchingProgress && Number.isFinite(matchingProgress.waiting_for_human_since)
      ? new Date(matchingProgress.waiting_for_human_since!).toISOString()
      : undefined;

    if (hasDisposition) {
      const disp = parseDisposition(readRegularJsonNoSymlink(disposition, "node disposition"), expected);
      const command = projectCommandOutcome(disp.command_evidence);
      const causes = projectCauses(disp.causes);
      const closedEdge = loop && blockedReviewForwardEdge(loop, finalization, entry.node_id, {
        state: disp.state,
        causes: disp.causes,
        reason: disp.reason,
      });
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: disp.state,
        status_text: STATUS_TEXT[disp.state],
        reason: disp.reason || "The node has a recorded execution disposition.",
        ...(causes ? { causes } : {}),
        ...(finalization ? { finalized: true } : {}),
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        completed_at: disp.recorded_at,
        ...(command ? { command } : {}),
        ...(loop ? { loop } : {}),
        ...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
        source_instance: attempt?.source,
      };
    }

    if (hasResult) {
      const record = parseCompletion(readRegularJsonNoSymlink(result, "node result"), expected);
      const command = projectCommandOutcome(record.result.command_evidence);
      const baseFields = {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        completed_at: record.completed_at,
        result_status: record.result.status,
        ...(record.result.summary ? { summary: record.result.summary } : {}),
        ...(command ? { command } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
      const lastVerdict = loop && loop.reviewer === entry.instance_id && record.result.status === "success"
        ? (typeof record.result.outputs?.[loop.field] === "string" ? String(record.result.outputs[loop.field]) : undefined)
        : undefined;
      if (loop && !finalization) {
        return {
          ...baseFields,
          status: "waiting",
          status_text: "Waiting (parked)",
          parked: true,
          finalized: false,
          ...(lastVerdict ? { last_verdict: lastVerdict } : {}),
          reason: "An attempt result is recorded; the review loop has not finalized this node.",
        };
      }
      if (loop && finalization) {
        const rejection = finalizedReviewRejection(loop, finalization, entry.node_id, record.result);
        const closedEdge = blockedReviewForwardEdge(
          loop,
          finalization,
          entry.node_id,
          { ...executionFromResult(record.result.status), reason: record.result.summary },
          record.result,
        );
        if (rejection) {
          return {
            ...baseFields,
            status: rejection.state,
            status_text: STATUS_TEXT[rejection.state],
            reason: rejection.reason,
            finalized: true,
            ...(lastVerdict ? { last_verdict: lastVerdict } : {}),
            ...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
          };
        }
        const state = executionFromResult(record.result.status).state;
        return {
          ...baseFields,
          status: state,
          status_text: STATUS_TEXT[state],
          ...(state === "failed" || state === "partial" ? { reason: record.result.summary } : {}),
          finalized: true,
          ...(lastVerdict ? { last_verdict: lastVerdict } : {}),
          ...(closedEdge ? { review_rejected_closure: closedEdge } : {}),
        };
      }
      const state = executionFromResult(record.result.status).state;
      return {
        ...baseFields,
        status: state,
        status_text: STATUS_TEXT[state],
        ...(state === "failed" || state === "partial" ? { reason: record.result.summary } : {}),
      };
    }

    const scopedErrorFile = join(dir, `${key}.error.json`);
    const errorFile = review_plan && !pathEntryExists(scopedErrorFile) && attemptNum === 1
      ? join(dir, `${entry.instance_id}.error.json`)
      : scopedErrorFile;
    if (pathEntryExists(errorFile)) {
      readRegularJsonNoSymlink<{ error?: unknown }>(errorFile, "node error");
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: "needs_attention",
        status_text: "Uncertain",
        reason: "The node recorded an execution error without a verified outcome.",
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
    }
    if (entry.error) {
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: "needs_attention",
        status_text: "Uncertain",
        reason: "The node launch recorded an error without a verified outcome.",
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
    }

    const matchingNodeCancel = cancelInfo.record && (!review_plan || !cancelInfo.record.identity.attempt_id || cancelInfo.record.identity.attempt_id === attemptId)
      ? cancelInfo.record
      : undefined;
    const activeCancel = matchingNodeCancel ?? (claimInfo.claim?.outcome === "completed" ? undefined : runCancelInfo.record);
    if (activeCancel) {
      if (matchingProgress?.state === "working" && readyAlive && entry.status !== "closed") {
        return {
          attempt_id: attemptId,
          attempt_number: attemptNum,
          max_attempts: maxAttempts,
          instance_id: entry.instance_id,
          key,
          status: "running",
          status_text: "Running (cancelling)",
          reason: "Cancellation requested; waiting for in-progress work to stop.",
          resource_state: entry.status,
          process_state: processState,
          ...(startedAt ? { started_at: startedAt } : {}),
          ...(updatedAt ? { updated_at: updatedAt } : {}),
          ...(loop ? { loop } : {}),
          source_instance: attempt?.source,
        };
      }
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: "cancelled",
        status_text: "Cancelled",
        reason: activeCancel.reason || "Cancelled.",
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
    }

    if (processState === "exited") {
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: "needs_attention",
        status_text: "Uncertain",
        reason: "The worker exited without a verified result.",
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
    }

    if (entry.status === "closed") {
      return {
        attempt_id: attemptId,
        attempt_number: attemptNum,
        max_attempts: maxAttempts,
        instance_id: entry.instance_id,
        key,
        status: "needs_attention",
        status_text: "Uncertain",
        reason: "The node's resource closed before an outcome was recorded.",
        resource_state: entry.status,
        process_state: processState,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(loop ? { loop } : {}),
        source_instance: attempt?.source,
      };
    }

    if (readyAlive && matchingProgress) {
      if (matchingProgress.state === "working") {
        if (waitingForHumanSince !== undefined) {
          return {
            attempt_id: attemptId,
            attempt_number: attemptNum,
            max_attempts: maxAttempts,
            instance_id: entry.instance_id,
            key,
            status: "waiting",
            status_text: "Waiting",
            reason: "The node is waiting for human direction.",
            waiting_on: ["human_direction"],
            waiting_for_human_since: waitingForHumanSince,
            resource_state: entry.status,
            process_state: processState,
            ...(startedAt ? { started_at: startedAt } : {}),
            ...(updatedAt ? { updated_at: updatedAt } : {}),
            ...(loop ? { loop } : {}),
            source_instance: attempt?.source,
          };
        }
        return {
          attempt_id: attemptId,
          attempt_number: attemptNum,
          max_attempts: maxAttempts,
          instance_id: entry.instance_id,
          key,
          status: "running",
          status_text: "Running",
          resource_state: entry.status,
          process_state: processState,
          ...(startedAt ? { started_at: startedAt } : {}),
          ...(updatedAt ? { updated_at: updatedAt } : {}),
          ...(loop ? { loop } : {}),
          source_instance: attempt?.source,
        };
      }
      if (matchingProgress.state === "waiting") {
        const inboundNodes = inboundEdgesOf(entry).map(id => byInstanceNodeId.get(id) ?? id);
        const waitingOn = inboundNodes.length ? inboundNodes : (entry.ownership_wait_for?.map(id => byInstanceNodeId.get(id) ?? id) ?? []);
        let reason = "The node is waiting before starting execution.";
        if (inboundNodes.length > 0) {
          reason = `Waiting for inbound dependency (${inboundNodes.join(", ")}) to complete and deliver handoff.`;
        } else if (entry.ownership_wait_for?.length) {
          reason = `Waiting for workspace path ownership release (${waitingOn.join(", ")}).`;
        }
        return {
          attempt_id: attemptId,
          attempt_number: attemptNum,
          max_attempts: maxAttempts,
          instance_id: entry.instance_id,
          key,
          status: "waiting",
          status_text: "Waiting",
          reason,
          ...(waitingOn.length ? { waiting_on: waitingOn } : {}),
          resource_state: entry.status,
          process_state: processState,
          ...(startedAt ? { started_at: startedAt } : {}),
          ...(updatedAt ? { updated_at: updatedAt } : {}),
          ...(loop ? { loop } : {}),
          source_instance: attempt?.source,
        };
      }
    }

    return {
      attempt_id: attemptId,
      attempt_number: attemptNum,
      max_attempts: maxAttempts,
      instance_id: entry.instance_id,
      key,
      status: "pending",
      status_text: "Pending",
      reason: "No verified execution or terminal record is available yet.",
      resource_state: entry.status,
      process_state: processState,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      ...(loop ? { loop } : {}),
      source_instance: attempt?.source,
    };
  } catch {
    return {
      attempt_number: 1,
      max_attempts: maxAttempts,
      instance_id: entry.instance_id,
      key: entry.instance_id,
      status: "needs_attention",
      status_text: "Uncertain",
      reason: "Node evidence is missing, damaged or contradictory.",
      resource_state: entry.status,
      process_state: "unknown",
      ...(loop ? { loop } : {}),
    };
  }
}

function projectGraph(factoryId: string, { definition, manifest, bound_version }: ReleasedFactoryRun) {
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

  const nodeIds = new Set(definition.agents.map(entry => entry.node.node_id));
  const observations = new Map<string, InternalNodeObservation>();
  for (const entry of definition.agents) {
    const node = entry.node;
    const launched = roster.get(node.node_id);
    const inbound = inboundEdgesOf(node);
    if (!launched || (launched.kind ?? "agent") !== (node.kind ?? "agent") ||
        JSON.stringify(inboundEdgesOf(launched).map(id => byInstance.get(id))) !== JSON.stringify(inbound)) {
      throw new Error("Run roster differs from the retained version");
    }
    observations.set(node.node_id, nodeObservation(manifest, launched, byInstance));
  }

  // Propagate finalized non-approval loop closures onto unadmitted pending/waiting successors without writing to disk.
  const entryByNode = new Map(definition.agents.map(entry => [entry.node.node_id, entry]));
  const orderedNodes: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string) => {
    if (visited.has(nodeId) || visiting.has(nodeId)) return;
    visiting.add(nodeId);
    const defEntry = entryByNode.get(nodeId);
    if (defEntry) {
      for (const src of inboundEdgesOf(defEntry.node)) visit(src);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    orderedNodes.push(nodeId);
  };
  for (const entry of definition.agents) visit(entry.node.node_id);

  const depEdges: Array<{
    from: string;
    to: string;
    kind: "dependency";
    dependency_policy: "require_success" | "allow_partial";
    state: EdgeState;
  }> = [];
  const feedbackEdges: Array<{
    from: string;
    to: string;
    kind: "feedback";
    field: string;
    approve: string;
    reject: string;
    max_revisions: number;
    on_exhausted: "needs_attention" | "failed";
    loop_body: string[];
    target_link: ReturnType<typeof nodeLink>;
  }> = [];
  const joins: Array<{
    node_id: string;
    policy: "all_success" | "allow_partial";
    sources: string[];
    source_links: Array<ReturnType<typeof nodeLink>>;
  }> = [];

  for (const nodeId of orderedNodes) {
    const entry = entryByNode.get(nodeId)!;
    const node = entry.node;
    const obs = observations.get(nodeId)!;
    const launched = roster.get(nodeId)!;
    const inbound = inboundEdgesOf(node);
    const sourceScope = (srcInst: string) => (manifest.topology === "graph" || manifest.review_plan ? srcInst : undefined);
    for (const srcNode of inbound) {
      const srcLaunched = roster.get(srcNode)!;
      const srcObs = observations.get(srcNode)!;
      const edgePolicy = inbound.length > 1
        ? effectiveDependencyPolicy(node.join_policy ?? "all_success", node.dependency_policy)
        : (node.dependency_policy ?? "allow_partial");
      let handoffClaimed = false;
      let handoffRejectedReason: string | undefined;
      try {
        verifyRegularHandoffFiles(
          manifest.session_dir,
          obs.key,
          launched.instance_id,
          srcLaunched.instance_id,
          srcObs.key,
          sourceScope(srcLaunched.instance_id),
        );
        const view = describeHandoff(manifest.session_dir, srcLaunched.instance_id, obs.key, {
          run_id: manifest.task_id,
          source_instance_id: srcLaunched.instance_id,
          destination: { node_id: node.node_id, instance_id: launched.instance_id, attempt_id: manifest.review_plan ? obs.key : launched.attempt_id },
        }, sourceScope(srcLaunched.instance_id), launched.instance_id);
        if (view?.problems.length) {
          throw new Error(view.problems[0]);
        }
        handoffClaimed = view?.state === "accepted";
        if (view?.rejections.length) {
          handoffRejectedReason = view.rejections.at(-1)?.reason;
        }
      } catch {
        obs.status = "needs_attention";
        obs.status_text = STATUS_TEXT.needs_attention;
        obs.parked = false;
        obs.reason = "Node handoff evidence is missing, damaged or contradictory.";
      }

      const closed = !handoffClaimed ? srcObs.review_rejected_closure : undefined;
      if (closed && (obs.status === "pending" || obs.status === "waiting")) {
        obs.status = "blocked";
        obs.status_text = STATUS_TEXT.blocked;
        obs.reason = closed.reason;
        obs.causes = projectCauses(closed.causes);
      } else if (!closed && !handoffClaimed && (obs.status === "pending" || obs.status === "waiting")) {
        const adm = decideAdmission({
          policy: edgePolicy,
          predecessor: { node_id: srcNode, execution: { state: srcObs.status, causes: srcObs.causes ?? [], reason: srcObs.reason } },
        });
        if (!adm.admit && adm.outcome === "blocked" && obs.status === "waiting") {
          obs.reason = `Waiting for disposition (${adm.reason}).`;
        } else if (handoffRejectedReason && obs.status === "waiting") {
          obs.reason = `Waiting on handoff after rejection from ${srcNode}: ${handoffRejectedReason}`;
        }
      }

      const sourceExecution: ExecutionState = srcObs.parked ? "waiting" : srcObs.status;
      const edgeState: EdgeState = closed ? "dead" : deriveEdgeState({
        sourceExecution,
        dependencyPolicy: edgePolicy,
        handoffClaimed,
      });
      depEdges.push({
        from: srcNode,
        to: node.node_id,
        kind: "dependency",
        dependency_policy: edgePolicy,
        state: edgeState,
      });
    }
  }

  const nodes = definition.agents.map(entry => {
    const node = entry.node;
    const obs = observations.get(node.node_id)!;
    const inbound = inboundEdgesOf(node);
    const configLink = nodeLink(nodeIds, factoryId, bound_version, node.node_id);
    if (inbound.length > 1) {
      joins.push({
        node_id: node.node_id,
        policy: node.join_policy ?? "all_success",
        sources: inbound,
        source_links: inbound.map(dep => nodeLink(nodeIds, factoryId, bound_version, dep)),
      });
    }
    if (entry.decision) {
      feedbackEdges.push({
        from: node.node_id,
        to: entry.decision.on_reject,
        kind: "feedback",
        field: entry.decision.field,
        approve: entry.decision.approve,
        reject: entry.decision.reject,
        max_revisions: entry.decision.max_revisions,
        on_exhausted: entry.decision.on_exhausted,
        loop_body: [...entry.decision.loop_body],
        target_link: nodeLink(nodeIds, factoryId, bound_version, entry.decision.on_reject),
      });
    }
    const loopInfo = obs.loop ? {
      attempt: obs.attempt_number,
      max_attempts: obs.max_attempts,
      parked: Boolean(obs.parked),
      finalized: Boolean(obs.finalized),
      ...(obs.last_verdict ? { last_verdict: obs.last_verdict } : {}),
    } : undefined;
    return {
      id: node.node_id,
      kind: node.kind ?? "agent",
      ...(obs.attempt_id !== undefined ? { attempt_id: obs.attempt_id } : {}),
      status: obs.status,
      status_text: obs.status_text,
      ...(obs.reason !== undefined ? { reason: obs.reason } : {}),
      ...(obs.parked ? { parked: true } : {}),
      ...(inbound.length > 1 ? { join: { policy: node.join_policy ?? "all_success", sources: inbound } } : {}),
      current_attempt: {
        attempt_id: obs.attempt_id ?? { absence: "evidence unavailable" as TypedAbsence, explanation: "Current attempt identity could not be verified." },
        attempt_number: obs.attempt_number,
        max_attempts: obs.max_attempts,
        instance_id: obs.instance_id,
        status: obs.status,
        status_text: obs.status_text,
        ...(obs.reason !== undefined ? { reason: obs.reason } : {}),
        resource_state: obs.resource_state,
        process_state: obs.process_state,
        ...(obs.started_at ? { started_at: obs.started_at } : {}),
        ...(obs.updated_at ? { updated_at: obs.updated_at } : {}),
        ...(obs.completed_at ? { completed_at: obs.completed_at } : {}),
        ...(obs.waiting_for_human_since ? { waiting_for_human_since: obs.waiting_for_human_since } : {}),
        ...(obs.result_status ? { result_status: obs.result_status } : {}),
        ...(obs.summary ? { summary: obs.summary } : {}),
        ...(obs.causes ? { causes: obs.causes } : {}),
        ...(loopInfo ? { loop: loopInfo } : {}),
        ...(obs.command ? { command: obs.command } : {}),
        ...(obs.waiting_on?.length ? { waiting_on: obs.waiting_on } : {}),
        configuration: configLink,
      },
      ...("href" in configLink ? { configuration_url: configLink.href } : {}),
      configuration_link: configLink,
    };
  });

  const edges = [
    ...depEdges,
    ...feedbackEdges.map(({ target_link: _link, ...rest }) => rest),
  ];
  return {
    evidence: "available" as const,
    bound_version,
    topology: definition.topology,
    nodes,
    edges,
    joins,
    feedback_edges: feedbackEdges,
  };
}

function endedHeadExtras(
  head_status: Inspection["head_status"],
  head: ReturnType<typeof headSummary>,
  baseReason: string,
) {
  const waitingBlocked = Boolean(head_status.input_id)
    && !head_status.eligible
    && Boolean(head_status.blocking_kind)
    && head_status.blocking_kind !== "empty";
  if (!waitingBlocked) {
    return { reason: baseReason, head_status: head };
  }
  const wcf = head_status.without_control_fence;
  const wcfSummary = head.without_control_fence as Record<string, unknown> | undefined;
  const wcfSentence = wcf && !wcf.eligible && wcf.blocking_kind && wcf.blocking_kind !== "empty" && wcfSummary?.explanation
    ? ` Without the stop fence: ${String(wcfSummary.explanation)}`
    : "";
  return {
    reason: `${baseReason} ${String(head.explanation)}${wcfSentence}`,
    head_status: head,
    launch_blocker: head.blocker,
  };
}

/** Projects only observations from the selected factory's verified release, never generic run status. */
export function liveSnapshot(inspection: Inspection, releases: ReleasedFactoryRun[]) {
  const { factory, attempts, capacity, head_status } = inspection;
  const base = { factory_id: factory.factory_id, current_version: factory.current_version, checked_at: new Date().toISOString() };
  const uncertain = (reason: string) => ({
    ...base,
    state: "uncertain",
    reason,
    run: null,
    graph: { evidence: "unavailable" as const, absence: "evidence unavailable" as const, explanation: reason },
  });
  const anyActiveAuthorized = attempts.filter(a => !a.historical && a.release_authorized);
  const active = anyActiveAuthorized.filter(a => a.state === "released");
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
      return uncertain("The current release could not be verified against its run and capacity records.");
    }
    const attempt = active[0];
    try {
      const graph = projectGraph(factory.factory_id, releases[0]);
      const outcome = aggregateRun(graph.nodes.map(node => node.status));
      const baseFields = {
        ...base,
        state: outcome.terminal ? "ended" : "running",
        run: { run_id: attempt.task_id, attempt_id: attempt.attempt_id, bound_version: attempt.bound_version },
        graph,
        outcome: outcome.state,
        settlement: attempt.settlement?.execution_settlement.state ?? "unsettled",
        capacity_release: "held",
      };
      if (outcome.terminal) {
        return {
          ...baseFields,
          ...endedHeadExtras(head_status, headSummary(head_status), "All nodes have recorded terminal outcomes."),
        };
      }
      return {
        ...baseFields,
        reason: "The run has a verified factory release.",
      };
    } catch {
      return uncertain("The run topology could not be verified against its bound definition.");
    }
  }
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
  if (
    inspection.uncertainty.length ||
    inspection.current_error ||
    inspection.control_error ||
    head_status.blocking_kind === "uncertain" ||
    capacity.factory_slot === "uncertain" ||
    capacity.checkout_slot === "uncertain" ||
    badHistoricalReleased ||
    contradictoryHistoricalReleased ||
    contradictoryFactoryHold
  ) {
    return uncertain("Factory launch or release evidence is incomplete or contradictory.");
  }
  const head = headSummary(head_status);
  const unreleased = attempts.findLast(a => !a.historical && !a.release_authorized);
  if (unreleased) {
    const explanation = unreleased.state === "reserved"
      ? `Launch attempt ${unreleased.attempt_id} is reserved and has not been authorized for release; no live run graph exists.`
      : `Launch attempt ${unreleased.attempt_id} ended before release (${unreleased.state}); no live run graph exists.`;
    const reason = head_status.blocking_kind && head_status.blocking_kind !== "empty"
      ? String(head.explanation)
      : explanation;
    return {
      ...base,
      state: "blocked",
      reason,
      run: null,
      head_status: head,
      graph: {
        evidence: "not applicable" as const,
        absence: "not applicable" as const,
        explanation,
      },
    };
  }
  const ended = attempts.findLast(
    a => a.release_authorized && (a.state === "settled" || a.state === "cleared") && a.settlement && !a.uncertainty?.length,
  );
  if (ended?.settlement) {
    const baseReason = ended.state === "cleared"
      ? "The most recent released run's capacity holds were cleared by an operator."
      : "The most recent released run has a durable settlement.";
    return {
      ...base,
      state: "ended",
      ...endedHeadExtras(head_status, head, baseReason),
      run: { run_id: ended.task_id, attempt_id: ended.attempt_id, bound_version: ended.bound_version },
      graph: {
        evidence: "not applicable" as const,
        absence: "not applicable" as const,
        explanation: ended.state === "cleared"
          ? "Historical cleared run topology is not mounted as a live graph."
          : "Historical settled run topology is not mounted as a live graph.",
      },
      outcome: ended.settlement.outcome,
      settlement: ended.settlement.execution_settlement.state,
      capacity_release: ended.settlement.capacity_release,
    };
  }
  const isIdle = !head_status.eligible && (
    (head_status.blocking_kind === "empty" && capacity.factory_slot === "free" && capacity.checkout_slot === "free") ||
    (head_status.blocking_kind === "unmanaged" && capacity.factory_slot === "free" && capacity.checkout_slot === "free")
  );
  const state = head_status.eligible ? "waiting" : isIdle ? "idle" : "blocked";
  const reason = state === "waiting"
    ? "An admitted input is eligible and waiting to launch."
    : head_status.blocking_kind === "unmanaged" && capacity.checkout_slot === "held"
      ? "The factory is unmanaged and the target checkout slot is held by another factory or run."
      : state === "blocked" && (head_status.blocking_kind === "empty" || !head_status.blocking_kind)
        ? "A capacity hold blocks launching for this factory."
        : String(head.explanation);
  if (factory.management === "unmanaged") {
    return {
      ...base,
      state,
      reason,
      run: null,
      head_status: head,
      graph: {
        evidence: "not applicable" as const,
        absence: "not applicable" as const,
        explanation: "Live run graph applies only after a factory is managed and releases a run.",
      },
    };
  }
  return {
    ...base,
    state,
    reason,
    run: null,
    head_status: head,
    graph: {
      evidence: "not applicable" as const,
      absence: "no records" as const,
      explanation: "No verified released run has been recorded for this factory.",
    },
  };
}
