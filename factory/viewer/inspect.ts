import type { HeadStatus, Inspection } from "../operations.ts";
import { inboundEdgesOf } from "../../bootstrap/session-store.ts";

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_FROZEN = "The definition does not freeze its runtime environment, installed tools or skills, checkout contents, or external service state.";
type RetainedAgent = NonNullable<Inspection["definition"]>["agents"][number];

export function inspectLink(factory: string, version: string, node?: string) {
  return `/?${new URLSearchParams({ factory, view: "inspect", version, ...(node ? { node } : {}) })}`;
}

export function headSummary(head: HeadStatus) {
  const messages = {
    empty: "No queued input is waiting to launch.", unmanaged: "The factory is not managed.", stopped: "New launches are paused by the factory stop fence.",
    factory_held: "A launch attempt holds the factory slot.", checkout_held: "A launch attempt holds the checkout slot.",
    preflight: "The input's bound version did not pass launch prerequisites.", compatibility: "A retained launch prerequisite is incompatible.",
    ceiling: "The bound definition exceeds a current limit.", uncertain: "Launch evidence could not be verified.",
  };
  return { eligible: head.eligible, blocking_kind: head.blocking_kind, input_id: head.input_id, bound_version: head.bound_version,
    explanation: head.blocking_kind ? messages[head.blocking_kind] : "No blocker was observed in read-only launch preflight." };
}

function nodeLink(factoryId: string, version: string, knownIds: ReadonlySet<string>, target: unknown) {
  if (typeof target !== "string" || !NODE_ID.test(target) || !knownIds.has(target)) {
    return { evidence: "unavailable", explanation: "This relationship target cannot be verified in the inspected version." };
  }
  return {
    node_id: target,
    href: inspectLink(factoryId, version, target),
  };
}
function relationship(factoryId: string, version: string, knownIds: ReadonlySet<string>, label: string, value: unknown) {
  if (value === undefined || value === null) return { label, absence: "not applicable" };
  const values = Array.isArray(value) ? value : [value];
  return { label, targets: values.map(target => nodeLink(factoryId, version, knownIds, target)) };
}
function projectNode(factoryId: string, version: string, knownIds: ReadonlySet<string>, entry: RetainedAgent) {
  const { node: n, decision } = entry;
  const id = n.node_id;
  const inbound = inboundEdgesOf(n);
  const relationships = [
    relationship(factoryId, version, knownIds, "Dependencies", inbound.length ? inbound : undefined),
    ...(inbound.length > 1 ? [{ ...relationship(factoryId, version, knownIds, "Join", inbound), policy: n.join_policy ?? "all_success" }] : []),
    relationship(factoryId, version, knownIds, "Feedback target", decision?.on_reject),
  ];
  return {
    id, anchor: `node-${id}`, kind: n.kind ?? "agent",
    persona: entry.persona_name, model: entry.model, thinking: entry.thinking,
    required_checks: n.required_checks ?? [], limits: {
      task_timeout_ms: n.task_timeout_ms, dependency_wait_timeout_ms: n.dependency_wait_timeout_ms,
    },
    policies: { tools: entry.tools?.mode, skills: entry.skills?.mode, extensions: entry.extensions?.mode,
      dependency: n.dependency_policy, ...(decision ? { max_revisions: decision.max_revisions, on_exhausted: decision.on_exhausted } : {}) },
    relationships,
  };
}

/** Operator-facing Inspect projection. Its input is the verified retained Inspection, not a raw store row. */
export function publicInspect(value: Inspection | undefined, factoryId: string) {
  if (!value || typeof value !== "object") {
    return { factory_id: factoryId, evidence: "unavailable", explanation: "Factory inspection evidence is unavailable." };
  }
  const definition = value.definition;
  const nodeIds = new Set((definition?.agents ?? []).map(entry => entry.node.node_id).filter((id): id is string => typeof id === "string"));
  const versionRecords = value.versions.map(v => ({
    version: v.version, current: v.version === value.factory.current_version,
    restored_from_version: v.restored_from_version,
    evidence: v.corrupt_reason ? "unavailable" : "available",
    ...(v.corrupt_reason ? { explanation: "The retained definition record is damaged or unreadable." } : {}),
  }));
  const operationEvidence = {
    attempts: value.attempts.map(a => {
      const reference = value.queue.find(q => q.input_id === a.input_id)?.reference;
      return { attempt_id: a.attempt_id, input_id: a.input_id, bound_version: a.bound_version,
        state: a.state, release_authorized: a.release_authorized,
        settlement: a.settlement ? { outcome: a.settlement.outcome, execution: a.settlement.execution_settlement.state, capacity_release: a.settlement.capacity_release } : { evidence: "not applicable" },
        ...(reference ? { receipt_url: `/api/factories/${encodeURIComponent(factoryId)}/receipts?reference=${encodeURIComponent(reference)}` } : { receipt: { evidence: "unavailable", explanation: "No submission reference is available for this attempt." } }) };
    }),
    requests: value.requests ? { count: value.requests.length, detail_url: `/api/factories/${encodeURIComponent(factoryId)}/requests` } : { absence: value.request_evidence_error ? "evidence unavailable" : "not applicable" },
    proposals: value.proposals ? { count: value.proposals.length, detail_url: `/api/factories/${encodeURIComponent(factoryId)}/proposals` } : { absence: value.proposal_evidence_error ? "evidence unavailable" : "not applicable" },
  };
  return {
    factory_id: factoryId, name: value.factory.name, management: value.factory.management,
    stopped: value.stopped === undefined ? { evidence: value.control_error ? "unavailable" : "not applicable" } : value.stopped,
    current_version: value.factory.current_version, inspected_version: value.inspected_version,
    versions: versionRecords,
    definition: definition ? {
      topology: definition.topology,
      nodes: definition.agents.map(entry => projectNode(factoryId, value.inspected_version, nodeIds, entry)),
      limits: { max_total_attempts: definition.max_total_attempts, ready_timeout_ms: definition.ready_timeout_ms, task_timeout_ms: definition.task_timeout_ms, dependency_wait_timeout_ms: definition.dependency_wait_timeout_ms, liveness_timeout_ms: definition.liveness_timeout_ms },
      runtime_assumptions: { evidence: "available", note: NOT_FROZEN },
      not_frozen: NOT_FROZEN,
    } : { evidence: "unavailable", explanation: "The selected retained definition is unavailable." },
    current_definition: value.current_error ? { evidence: "unavailable", explanation: "Current definition evidence is unavailable." } : { evidence: "available" },
    capacity: value.capacity ? {
      queue_used: value.capacity.queue_used, queue_limit: value.capacity.queue_limit,
      factory_slot: value.capacity.factory_slot, checkout_slot: value.capacity.checkout_slot,
        blocking_hold: value.capacity.blocking_hold ? {
        scope: value.capacity.blocking_hold.scope, factory_id: value.capacity.blocking_hold.factory_id,
        input_id: value.capacity.blocking_hold.input_id, attempt_id: value.capacity.blocking_hold.attempt_id, state: value.capacity.blocking_hold.state,
        explanation: "A recorded capacity hold affects this factory or its checkout.",
      } : { absence: "no records" },
    } : { evidence: "unavailable" },
    queue_head: headSummary(value.head_status),
    attention: (value.attention ?? []).length ? value.attention.map(a => ({ kind: a.kind, reason: "Attention requires review in Pi.", input_id: a.input_id, attempt_id: a.attempt_id })) : { absence: "no records" },
    operation_evidence: operationEvidence,
    uncertainty: (value.uncertainty ?? []).length ? { evidence: "unavailable", explanation: "Some factory evidence could not be verified." } : { absence: "no records" },
    evidence: (value.uncertainty ?? []).length || value.inspected_error || value.current_error ? "uncertain" : "available",
  };
}
