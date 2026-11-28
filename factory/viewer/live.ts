import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import { aggregateRun } from "../../bootstrap/outcomes.ts";
import { inboundEdgesOf } from "../../bootstrap/session-store.ts";
import {
  assertRegularFileIfExists,
  assertRunEvidenceConsistent,
  resolveRunObservations,
} from "./attempt-resolution.ts";
import { headSummary, nodeLink, type TypedAbsence } from "./inspect.ts";
import { deletionMarkerFields } from "./sanitize.ts";

export { assertRegularFileIfExists };

function projectGraph(
  factoryId: string,
  release: ReleasedFactoryRun,
  blockedPaths: readonly string[],
) {
  const { observations, depEdges, bound_version, definition } = resolveRunObservations(factoryId, release, blockedPaths);
  const nodeIds = new Set(definition.agents.map(entry => entry.node.node_id));
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
      attempt: obs.corrupt_or_unverified ? 1 : obs.attempt_number,
      max_attempts: obs.max_attempts,
      parked: Boolean(obs.parked),
      finalized: Boolean(obs.finalized),
      ...(obs.last_verdict ? { last_verdict: obs.last_verdict } : {}),
    } : undefined;
    const attemptIdForLive = obs.corrupt_or_unverified ? undefined : obs.attempt_id;
    return {
      id: node.node_id,
      kind: node.kind ?? "agent",
      ...(attemptIdForLive !== undefined ? { attempt_id: attemptIdForLive } : {}),
      status: obs.status,
      status_text: obs.status_text,
      ...(obs.reason !== undefined ? { reason: obs.reason } : {}),
      ...(obs.parked ? { parked: true } : {}),
      ...(inbound.length > 1 ? { join: { policy: node.join_policy ?? "all_success", sources: inbound } } : {}),
      current_attempt: {
        attempt_id: attemptIdForLive ?? { absence: "evidence unavailable" as TypedAbsence, explanation: "Current attempt identity could not be verified." },
        attempt_number: obs.corrupt_or_unverified ? 1 : obs.attempt_number,
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
export function liveSnapshot(
  inspection: Inspection,
  releases: ReleasedFactoryRun[],
  blockedPaths: readonly string[] = [],
) {
  const { factory, attempts, capacity, head_status } = inspection;
  const deletionFields = deletionMarkerFields(inspection, blockedPaths);
  const base = { factory_id: factory.factory_id, current_version: factory.current_version, checked_at: new Date().toISOString(), ...deletionFields };
  const uncertain = (reason: string) => ({
    ...base,
    state: "uncertain",
    reason,
    run: null,
    graph: { evidence: "unavailable" as const, absence: "evidence unavailable" as const, explanation: reason },
  });
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
      return uncertain("Deleted factory has contradictory release or launch evidence.");
    }
    const deletedAt = "deletion" in deletionFields ? deletionFields.deletion?.deleted_at : undefined;
    return {
      ...base,
      state: "deleted",
      reason: deletedAt
        ? `Factory was permanently deleted at ${deletedAt}.`
        : "Factory is permanently deleted.",
      run: null,
      graph: {
        evidence: "not applicable" as const,
        absence: "not applicable" as const,
        explanation: "This factory is deleted; no live run graph is active.",
      },
    };
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
      return uncertain("The current release could not be verified against its run and capacity records.");
    }
    const attempt = active[0];
    try {
      const graph = projectGraph(factory.factory_id, releases[0], blockedPaths);
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
          ...endedHeadExtras(head_status, headSummary(head_status, inspection), "All nodes have recorded terminal outcomes."),
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
  if (hasUncertainty) {
    return uncertain("Factory launch or release evidence is incomplete or contradictory.");
  }
  const head = headSummary(head_status, inspection);
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
