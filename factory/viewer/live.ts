import { join } from "node:path";
import type { Inspection, ReleasedFactoryRun } from "../operations.ts";
import type { ProgressSnapshot } from "../../bootstrap/cancellation.ts";
import { verifyBoundReviewPlan } from "../../bootstrap/factory-requests.ts";
import { currentAttempt } from "../../bootstrap/handoff.ts";
import { aggregateRun, executionFromResult, type ExecutionState } from "../../bootstrap/outcomes.ts";
import { readFinalization } from "../../bootstrap/review-loop.ts";
import { dispositionPath, expectationFor, inboundEdgesOf, parseCompletion, parseDisposition, parseWorkerReady, pathEntryExists, processAlive, readRegularJsonNoSymlink, readyPath, resultPath, type AgentLaunch, type BootstrapManifest } from "../../bootstrap/session-store.ts";
import { headSummary, inspectLink } from "./inspect.ts";

function nodeObservation(manifest: BootstrapManifest, entry: AgentLaunch): { attempt_id?: string; status: ExecutionState; reason?: string } {
  const { session_dir: dir, task_id, review_plan } = manifest;
  try {
    const attempt = currentAttempt(manifest, entry);
    const loop = review_plan?.loops.find(loop => loop.body.includes(entry.instance_id));
    const finalization = loop && readFinalization(dir, task_id, loop, entry.instance_id, manifest.topology, manifest.version);
    const attemptId = finalization?.attempt_id ?? (attempt ? `${entry.instance_id}.${attempt.number}` : entry.attempt_id);
    const key = review_plan && (attempt || finalization) ? attemptId : entry.instance_id;
    const expected = { ...expectationFor(manifest, entry), attempt_id: attemptId };
    const result = resultPath(dir, key);
    const disposition = dispositionPath(dir, key);
    const hasResult = pathEntryExists(result);
    const hasDisposition = pathEntryExists(disposition);
    if (hasResult && hasDisposition) throw new Error("Contradictory result records");
    if (hasDisposition) {
      const { state } = parseDisposition(readRegularJsonNoSymlink(disposition, "node disposition"), expected);
      return { attempt_id: attemptId, status: state, reason: "The node has a recorded execution disposition." };
    }
    if (hasResult) {
      const record = parseCompletion(readRegularJsonNoSymlink(result, "node result"), expected);
      if (loop && !finalization) return { attempt_id: attemptId, status: "waiting", reason: "An attempt result is recorded; the review loop has not finalized this node." };
      return { attempt_id: attemptId, status: executionFromResult(record.result.status).state };
    }
    const progressPath = join(dir, `${entry.instance_id}.progress.json`);
    const readyFile = readyPath(dir, entry.instance_id);
    if (pathEntryExists(readyFile)) {
      const ready = parseWorkerReady(readRegularJsonNoSymlink(readyFile, "worker readiness"));
      if (ready.token !== manifest.token || ready.task_id !== task_id || ready.instance_id !== entry.instance_id) throw new Error("Foreign readiness");
      if (!processAlive(ready)) return { attempt_id: attemptId, status: "needs_attention", reason: "The worker exited without a verified result." };
      if (pathEntryExists(progressPath)) {
        const progress = readRegularJsonNoSymlink<ProgressSnapshot>(progressPath, "node progress");
        if (progress.token !== manifest.token) throw new Error("Foreign progress");
        if (!loop || progress.attempt_id === attemptId) {
          if (progress.state === "working") return Number.isFinite(progress.waiting_for_human_since)
            ? { attempt_id: attemptId, status: "waiting", reason: "The node is waiting for human direction." }
            : { attempt_id: attemptId, status: "running" };
        }
      }
    }
    return { attempt_id: attemptId, status: "pending", reason: "No verified execution or terminal record is available yet." };
  } catch {
    return { status: "needs_attention", reason: "Node evidence is missing, damaged or contradictory." };
  }
}

function projectGraph(factoryId: string, { definition, manifest, bound_version }: ReleasedFactoryRun) {
  if (manifest.topology !== definition.topology || manifest.pane_manifest.length !== definition.agents.length) throw new Error("Run topology differs from the retained version");
  const roster = new Map(manifest.pane_manifest.map(entry => [entry.node_id, entry]));
  const byInstance = new Map(manifest.pane_manifest.map(entry => [entry.instance_id, entry.node_id]));
  verifyBoundReviewPlan(definition, manifest.review_plan, manifest.pane_manifest);
  const edges: Array<{ from: string; to: string; kind: "dependency" | "feedback" }> = [];
  const nodes = definition.agents.map(entry => {
    const node = entry.node;
    const launched = roster.get(node.node_id);
    const inbound = inboundEdgesOf(node);
    if (!launched || (launched.kind ?? "agent") !== (node.kind ?? "agent") ||
        JSON.stringify(inboundEdgesOf(launched).map(id => byInstance.get(id))) !== JSON.stringify(inbound)) {
      throw new Error("Run roster differs from the retained version");
    }
    for (const source of inbound) edges.push({ from: source, to: node.node_id, kind: "dependency" });
    if (entry.decision) edges.push({ from: node.node_id, to: entry.decision.on_reject, kind: "feedback" });
    return {
      id: node.node_id, kind: node.kind ?? "agent", ...nodeObservation(manifest, launched),
      ...(inbound.length > 1 ? { join: { policy: node.join_policy ?? "all_success", sources: inbound } } : {}),
      configuration_url: inspectLink(factoryId, bound_version, node.node_id),
    };
  });
  return { evidence: "available" as const, nodes, edges };
}

/** Projects only observations from the selected factory's verified release, never generic run status. */
export function liveSnapshot(inspection: Inspection, releases: ReleasedFactoryRun[]) {
  const { factory, attempts, capacity, head_status } = inspection;
  const base = { factory_id: factory.factory_id, current_version: factory.current_version, checked_at: new Date().toISOString() };
  const uncertain = (reason: string) => ({ ...base, state: "uncertain", reason, run: null, graph: { evidence: "unavailable" } });
  const active = attempts.filter(a => !a.historical && a.release_authorized);
  if (active.length || releases.length) {
    if (active.length !== 1 || releases.length !== 1 || active[0].attempt_id !== releases[0].attempt_id || capacity.factory_slot !== "held") {
      return uncertain("The current release could not be verified against its run and capacity records.");
    }
    const attempt = active[0];
    try {
      const graph = projectGraph(factory.factory_id, releases[0]);
      const outcome = aggregateRun(graph.nodes.map(node => node.status));
      return { ...base, state: outcome.terminal ? "ended" : "running", reason: outcome.terminal ? "All nodes have recorded terminal outcomes." : "The run has a verified factory release.",
        run: { run_id: attempt.task_id, attempt_id: attempt.attempt_id, bound_version: attempt.bound_version }, graph,
        outcome: outcome.state, settlement: attempt.settlement?.execution_settlement.state, capacity_release: "held" };
    } catch { return uncertain("The run topology could not be verified against its bound definition."); }
  }
  if (inspection.uncertainty.length || inspection.current_error || head_status.blocking_kind === "uncertain") return uncertain("Factory launch or release evidence is incomplete or contradictory.");
  const ended = attempts.findLast(a => a.release_authorized && a.state === "settled" && a.settlement && !a.uncertainty?.length);
  if (ended?.settlement) return { ...base, state: "ended", reason: "The most recent released run has a durable settlement.",
    run: { run_id: ended.task_id, attempt_id: ended.attempt_id, bound_version: ended.bound_version }, graph: { evidence: "unavailable" },
    outcome: ended.settlement.outcome, settlement: ended.settlement.execution_settlement.state, capacity_release: ended.settlement.capacity_release };
  const head = headSummary(head_status);
  const state = head_status.eligible ? "waiting" : head_status.blocking_kind === "empty" || head_status.blocking_kind === "unmanaged" && capacity.checkout_slot === "free" ? "idle" : "blocked";
  return { ...base, state, reason: head.explanation, run: null, graph: { evidence: "not applicable" } };
}
