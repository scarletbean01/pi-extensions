import { attemptNumber } from "./review-plan.ts";
import type { NodeAttemptCount } from "./contracts.ts";
import { formatLearnedConstraintsSummary, type LearnedConstraintsSummary } from "./constraints.ts";
import { formatRiskLaneSummary } from "./lanes.ts";
import { aggregateRun, executionFromResult, type CauseRef, type ExecutionState, type RunOutcome } from "./outcomes.ts";
import { renderGraph } from "./graph-view.ts";
import { nodeIdentity, nodeLabel, type BootstrapManifest, type CommandEvidence, type ReportEntry } from "./session-store.ts";
import type { AgentState, CancelResult, PlanPreview } from "./lifecycle.ts";
import type { HandoffView } from "./handoff.ts";
import type { RecoveryReport } from "./recovery.ts";

/** Working agents with no model/tool activity for this long are flagged; nothing is killed automatically. */
export const STALL_MS = 10 * 60_000;

// Tool `details` only feed the UI. Everything the dispatcher model must act on goes in these texts.
const clip = (text: string, max = 240) => (text = text.replace(/\s+/g, " ").trim()).length > max ? `${text.slice(0, max - 1)}…` : text;

/** A report entry's node (and its persona when that is a different name). */
const resultLabel = (result: ReportEntry) => result.node_id
	? nodeLabel({ node_id: result.node_id, persona_name: result.agent_name, ...(result.kind === "command" || result.command_evidence ? { kind: "command" as const } : {}) })
	: result.agent_name;

/** "n1 (failed)", or for evidence "n1 (succeeded; check tests stale)": the nodes, and the evidence, that stopped later work. */
const causeText = (cause: CauseRef) => `${cause.node_id} (${cause.check ? `${cause.state}; check ${cause.check.name} ${cause.check.evidence}` : cause.state})`;
function entryState(entry: ReportEntry): ExecutionState {
	if (entry.status === "blocked" || entry.status === "skipped" || entry.status === "cancelled") return entry.status;
	return entry.execution_state ?? executionFromResult(entry.status).state;
}
const reportStatus = (entry: ReportEntry) => {
	const state = entryState(entry);
	return state === "succeeded" ? "success" : state === "failed" ? "failure" : state;
};
const reportReason = (entry: ReportEntry) => "execution_reason" in entry ? entry.execution_reason : undefined;

const isNotExecutedEntry = (entry: ReportEntry) => entry.status === "blocked" || entry.status === "skipped" || entry.status === "cancelled";

function tally(entries: ReportEntry[]) {
	const counts = aggregateRun(entries.map(entryState));
	const { succeeded: success, partial, failed: failure, needs_attention } = counts.counts;
	const notExecutedEntries = entries.filter(isNotExecutedEntry);
	const notExecutedCounts = { blocked: 0, skipped: 0, cancelled: 0 };
	for (const entry of notExecutedEntries) notExecutedCounts[entry.status as keyof typeof notExecutedCounts]++;
	const names = Object.entries(notExecutedCounts).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`);
	const cancelledAfterCompleted = entries.filter(entry => !isNotExecutedEntry(entry) && entryState(entry) === "cancelled").length;
	return {
		counts: { success, partial, failure }, notExecuted: notExecutedEntries.length, names, cancelledAfterCompleted, outcome: counts.state,
		attention: needs_attention ? `, ${needs_attention} needs attention` : "",
	};
}

/** One line per launched agent with the identifiers needed for status checks and subset cleanup. */
export function formatLaunch(manifest: BootstrapManifest): string {
	return manifest.pane_manifest.map(entry => `- ${entry.instance_id} (${nodeIdentity(entry)})${entry.step ? ` step ${entry.step}` : ""}: ${entry.status}` +
		`${entry.tab_id ? `, tab ${entry.tab_id}` : ""}, ${entry.kind === "command" ? `command ${entry.command}` : `model ${entry.expected_model}`}${entry.error ? ` — error: ${clip(entry.error)}` : ""}`).join("\n");
}

/**
 * Handoff delivery, acceptance and rejection, said apart: queued only means Coms acknowledged a notification. A refused handoff says what to do, because
 * nothing was accepted or run for it and nothing retries it on its own.
 */
function handoffText(direction: "in" | "out", view: HandoffView, showDestination = false): string {
	const id = view.handoff_id ?? "(receipt without an ID)";
	const resent = view.recovery ? `; dispatcher re-sent it ${view.recovery.attempts} time${view.recovery.attempts === 1 ? "" : "s"} (last ${view.recovery.last_transport === "acknowledged" ? "Coms acknowledged" : view.recovery.last_transport === "failed" ? "send failed" : "send not confirmed"})` : "";
	const peer = direction === "in" ? view.source : view.destination;
	const target = direction === "out" && showDestination ? ` -> ${view.destination}` : "";
	if (direction === "out" && view.not_delivered_reason && view.state !== "accepted" && view.state !== "queued") {
		return ` [handoff out${target}${view.handoff_id ? ` ${view.handoff_id}` : ""}: not delivered (${clip(view.not_delivered_reason, 120)})]`;
	}
	const rejection = view.rejections.at(-1);
	switch (view.state) {
		case "accepted": return ` [handoff ${direction}${target} ${id} accepted${view.legacy ? " (previous release's receipt)" : view.delivered_by === "dispatcher" ? " (re-sent by the dispatcher)" : ""}]`;
		case "rejected": return ` [handoff ${direction}${target} ${id} rejected: ${clip(rejection?.reason ?? "no reason recorded", 160)}; nothing ran for this handoff; inspect ${view.source}'s saved result, then bootstrap_cleanup and relaunch with a new request_id (no automatic retry)]`;
		case "queued": return ` [handoff ${direction}${target} ${id} queued: not accepted yet${direction === "in" ? ` (${peer} sent it and Coms acknowledged the message; acceptance is recorded only by this node)` : ""}${rejection ? `; last notification refused: ${clip(rejection.reason, 100)}` : ""}${resent}]`;
		case "offered": return ` [handoff ${direction}${target} ${id} offered: not delivered yet${resent}]`;
		default: return rejection
			? ` [handoff ${direction}${target}: no offer on record; last notification refused: ${clip(rejection.reason, 100)}]`
			: (direction === "out" && showDestination ? ` [handoff ${direction}${target}: not offered]` : "");
	}
}

const exitSummary = (ev: CommandEvidence) => ev.spawn_error
	? `spawn_error=${clip(ev.spawn_error, 80)}`
	: ev.signal !== null
	? `signal=${ev.signal}`
	: `exit=${ev.exit_code}`;

function commandEvidenceBadge(ev?: CommandEvidence, cmd?: string, wd?: string): string {
	if (!ev && !cmd) return "";
	if (!ev) return ` [command=${clip(cmd!, 80)}${wd ? `; wd=${clip(wd, 80)}` : ""}]`;
	const extras = [
		`command=${clip(ev.command, 80)}`,
		exitSummary(ev),
		`duration=${ev.duration_ms}ms`,
		`stdout=${ev.stdout_bytes}B`,
		`stderr=${ev.stderr_bytes}B`,
		ev.process_group_id !== undefined ? `pgid=${ev.process_group_id}${ev.process_group_killed ? " killed" : ""}` : "",
	].filter(Boolean);
	return ` [${extras.join("; ")}]`;
}

/** Per-agent progress for bootstrap_status, ordered as planned. */
export function formatAgentStates(agents: AgentState[], topology?: BootstrapManifest["topology"]): string {
	const isGraph = topology === "graph";
	return agents.map(agent => {
		const live = agent.state !== "done" && agent.state !== "closed";
		const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
		const signs = [
			live && agent.heartbeat_age_ms !== undefined ? `heartbeat ${seconds(agent.heartbeat_age_ms)} ago` : "",
			live && agent.state === "working" && agent.wait_reason !== "human" && agent.activity_age_ms !== undefined ? `last activity ${seconds(agent.activity_age_ms)} ago${agent.activity_age_ms > STALL_MS ? " — possibly stalled" : ""}` : "",
		].filter(Boolean);
		const heartbeat = signs.length ? ` (${signs.join(", ")})` : "";
		const liveness = live && agent.liveness && agent.liveness !== "healthy" ? ` [liveness: ${agent.liveness}]` : "";
		const wait = agent.wait_reason === "human" ? " [waiting for a person]"
			: agent.wait_reason === "upstream_human" ? " [waiting behind a human request]"
			: agent.wait_reason === "dependency" ? " [waiting on dependency progress]" : "";
		const duration = live && agent.task_timeout_ms !== undefined && agent.elapsed_ms !== undefined
			? ` [elapsed ${seconds(agent.elapsed_ms)}/${seconds(agent.task_timeout_ms)}${agent.deadline_exceeded ? " — deadline exceeded" : ""}]`
			: "";
		const cancelling = agent.cancelling
			? ` [cancelling${agent.force_close_allowed ? " — force_close available" : (agent.grace_remaining_ms ?? 0) === 0 ? " — grace elapsed; waiting for the worker to acknowledge" : ` — grace ${agent.grace_remaining_ms}ms remaining`}]`
			: "";
		const outcome = agent.result_status ? ` ${agent.result_status}: ${clip(agent.summary ?? "")}` : "";
		const delivery = agent.delivery === "failed" || agent.delivery === "pending" ? ` [handoff ${agent.delivery}]` : "";
		const handoffsOut = agent.handoffs_out
			? Object.values(agent.handoffs_out).map(view => handoffText("out", view, true)).join("")
			: (agent.handoff_out ? handoffText("out", agent.handoff_out) : "");
		const handoffsIn = agent.handoffs_in
			? Object.values(agent.handoffs_in).map(view => handoffText("in", view, true)).join("")
			: (agent.handoff ? handoffText("in", agent.handoff) : "");
		const handoffs = handoffsIn + handoffsOut;
		const edgeEntries = agent.edge_states ? Object.entries(agent.edge_states) : [];
		const edgeStates = isGraph && edgeEntries.length
			? ` [edges: ${edgeEntries.map(([src, s]) => `${src}=${s}`).join(", ")}]`
			: "";
		const pendingEdges = edgeEntries.filter(([, s]) => s === "pending").map(([src]) => src);
		const deadEdges = edgeEntries.filter(([, s]) => s === "dead").map(([src]) => src);
		const joinSummary = edgeEntries.length > 1
			? ` [join: ${agent.join_policy ?? "all_success"}${pendingEdges.length ? `; pending: ${pendingEdges.join(", ")}` : ""}${deadEdges.length ? `; dead: ${deadEdges.join(", ")}` : ""}]`
			: "";
		const checks = agent.verification?.length ? ` [checks: ${agent.verification.map(v => `${v.check_id}=${v.result}/${v.applicability}`).join(", ")}]` : "";
		// Execution state is separate from the legacy state word above: it says whether the node ran, was blocked, or needs attention, and why.
		const why = agent.execution_causes.length ? `; caused by ${agent.execution_causes.map(causeText).join(", ")}` : "";
		const exhaustedFailure = agent.finalized && agent.execution === "failed" && agent.result_status === "success";
		const attentionReason = agent.attempt_limit && agent.execution === "needs_attention" && !agent.error;
		const reason = agent.execution === "blocked" || agent.execution === "skipped" || agent.execution === "cancelled" || exhaustedFailure || attentionReason ? ` — ${clip(agent.execution_reason ?? "")}` : "";
		const evidence = agent.evidence?.length ? ` [evidence: ${agent.evidence.map(item => `${item.check} ${item.status}`).join(", ")}]` : "";
		const ownership = agent.ownership_status === "held_uncertain" && agent.ownership_waiting_on?.length
			? ` [ownership: held by ${agent.ownership_waiting_on.map(w => `${w.node_id} (uncertain: ${clip(w.reason, 80)})`).join(", ")}]`
			: agent.ownership_status === "waiting" && agent.ownership_waiting_on?.length
			? ` [ownership: waiting on ${agent.ownership_waiting_on.map(w => w.node_id).join(", ")}]`
			: "";
		const attempt = agent.attempt_limit ? ` [attempt ${attemptNumber(agent.attempt_id)}/${agent.attempt_limit}${agent.parked ? ", parked" : agent.finalized ? ", finalized" : ""}]` : "";
		const unreviewed = agent.unreviewed_attempts?.length
			? ` [unreviewed later result${agent.unreviewed_attempts.length > 1 ? "s" : ""}: ${agent.unreviewed_attempts.map(u => `${u.attempt_id} (${u.state}: ${clip(u.summary, 80)}, ${u.result_path})`).join("; ")}]`
			: "";
		const cmdBadge = agent.kind === "command" || agent.command_evidence
			? commandEvidenceBadge(agent.command_evidence, agent.command, agent.working_directory)
			: "";
		const laneBadge = agent.risk_lane ? ` [lane: ${formatRiskLaneSummary(agent.risk_lane)}]` : "";
		return `- ${agent.instance_id} (${nodeIdentity(agent)}): ${agent.state}${heartbeat}${liveness}${wait}${duration}${cancelling}${outcome}${delivery}${handoffs}${edgeStates}${joinSummary}${checks}${agent.error ? ` — ${clip(agent.error)}` : ""}${reason} [execution ${agent.execution}${why}]${cmdBadge}${evidence}${ownership}${attempt}${unreviewed}${agent.last_verdict ? ` [last verdict: ${clip(agent.last_verdict)}]` : ""}${laneBadge}`;
	}).join("\n");
}

function formatReviewHistory(result: ReportEntry): string[] {
	const history = result.review_history;
	if (!history) return [];
	if (history.version !== 1) return [`Unsupported review history version ${history.version}`];
	const counter = (number: number) => `${number}/${history.attempt_limit}`;
	const verdicts = history.attempts.flatMap(attempt => attempt.verdict ? [`${counter(attempt.number)} ${clip(attempt.verdict)}`] : []);
	return [
		...history.attempts.map(attempt => `  - Attempt ${counter(attempt.number)}${attempt.unreviewed ? " (unreviewed)" : ""}: ${attempt.state} — ${clip(attempt.summary)}${attempt.risk_lane ? ` [lane: ${formatRiskLaneSummary(attempt.risk_lane)}]` : ""}`),
		...(verdicts.length ? [`  Verdict history: ${verdicts.join(" → ")}`] : []),
		...(history.ended ? [`  Loop ended: ${clip(history.ended)}`] : []),
	];
}

export function formatNodeAttemptCounts(nodeCounts: NodeAttemptCount[]): string {
	return nodeCounts
		.map(item => `${item.node_id} (${item.attempts} attempt${item.attempts === 1 ? "" : "s"}, ${item.rollbacks} rollback${item.rollbacks === 1 ? "" : "s"})`)
		.join("; ");
}

/** Compact report digest so the dispatcher need not re-read report.json to answer the user. */
export function formatReportDigest(results: ReportEntry[], options: { runOutcome?: string; nodeCounts?: NodeAttemptCount[]; nodeCountsError?: string; learnedConstraints?: LearnedConstraintsSummary } = {}): string {
	const { counts, notExecuted, names, cancelledAfterCompleted, outcome, attention } = tally(results);
	return [`${counts.success} success, ${counts.partial} partial, ${counts.failure} failure${attention}.${notExecuted ? ` Not executed: ${names.join(", ")}.` : ""}${cancelledAfterCompleted ? ` Cancelled after completing: ${cancelledAfterCompleted}.` : ""}`,
		// A caller holding the run's own outcome supplies it: the tally of these entries cannot see nodes that have no entry.
		options.runOutcome ?? `Run outcome: ${outcome}.`,
		...(options.learnedConstraints ? [`Learned constraints: ${formatLearnedConstraintsSummary(options.learnedConstraints)}`] : []),
		...results.map(result => {
			const reason = reportReason(result);
			const causes = result.causes?.length ? ` (caused by ${result.causes.map(cause => `${cause.node_id} ${cause.state}`).join(", ")})` : "";
			const undelivered = result.undelivered_edges?.length ? ` [undelivered: ${result.undelivered_edges.map(edge => `${edge.destination} — ${clip(edge.reason, 120)}`).join("; ")}]` : "";
			const next = "next_steps" in result && result.next_steps?.length ? ` (next: ${clip(result.next_steps.join("; "), 160)})` : "";
			const cmdBadge = result.command_evidence ? commandEvidenceBadge(result.command_evidence) : "";
			const laneBadge = result.risk_lane ? ` [lane: ${formatRiskLaneSummary(result.risk_lane)}]` : "";
			return `- ${resultLabel(result)}: ${reportStatus(result)} — ${clip(result.summary)}${reason ? ` — ${clip(reason)}` : ""}${causes}${cmdBadge}${undelivered}${next}${laneBadge}`;
		}),
		...results.filter(result => result.review_history).flatMap(result => [
			`Attempts for ${resultLabel(result)}:`, ...formatReviewHistory(result),
		]),
		...(options.nodeCounts?.length ? [`Node counts (upstream-index.json, report-only): ${formatNodeAttemptCounts(options.nodeCounts)}`] : []),
		...(options.nodeCountsError ? [`Node counts unavailable: ${options.nodeCountsError}`] : []),
	].join("\n");
}

export function buildMarkdownReport(results: ReportEntry[], nodeCounts?: NodeAttemptCount[], nodeCountsError?: string, learnedConstraints?: LearnedConstraintsSummary): string {
	const lines = ["# Bootstrap Results", ""];
	if (learnedConstraints) {
		lines.push(`Learned constraints: ${formatLearnedConstraintsSummary(learnedConstraints)}`, "");
	}
	const { counts, notExecuted, cancelledAfterCompleted, outcome, attention } = tally(results);
	let warnings = 0;
	for (const result of results) {
		if (result.status === "blocked" || result.status === "skipped" || result.status === "cancelled") {
			lines.push(`### ${result.status === "cancelled" ? "🛑" : result.status === "skipped" ? "⏭️" : "⛔"} ${resultLabel(result)}`, `Status: ${result.status} (not executed)`, `Summary: ${result.summary}`);
			if (result.risk_lane) lines.push(`Risk lane: ${formatRiskLaneSummary(result.risk_lane)}`);
			if (result.command_evidence) {
				const ev = result.command_evidence;
				lines.push(`Command: ${ev.command}${ev.args.length ? ` ${JSON.stringify(ev.args)}` : ""}`, `Working directory: ${ev.working_directory}`, `Exit result: ${exitSummary(ev)} (duration=${ev.duration_ms}ms, stdout=${ev.stdout_bytes}B, stderr=${ev.stderr_bytes}B${ev.process_group_killed ? `, pgid=${ev.process_group_id} killed` : ""})`);
			}
			if (result.causes.length) lines.push("Caused by:", ...result.causes.map(cause => `  - ${causeText(cause)}: ${cause.reason}`));
			lines.push(...formatReviewHistory(result), "");
			continue;
		}
		const status = reportStatus(result);
		const icon = status === "success" ? "✅" : status === "partial" || status === "needs_attention" ? "⚠️" : "❌";
		lines.push(`### ${icon} ${resultLabel(result)}`, `Status: ${status}`, `Summary: ${result.summary}`);
		if (result.risk_lane) lines.push(`Risk lane: ${formatRiskLaneSummary(result.risk_lane)}`);
		if (result.command_evidence) {
			const ev = result.command_evidence;
			lines.push(`Command: ${ev.command}${ev.args.length ? ` ${JSON.stringify(ev.args)}` : ""}`, `Working directory: ${ev.working_directory}`, `Exit result: ${exitSummary(ev)} (duration=${ev.duration_ms}ms, stdout=${ev.stdout_bytes}B, stderr=${ev.stderr_bytes}B${ev.process_group_killed ? `, pgid=${ev.process_group_id} killed` : ""})`);
		}
		const reason = reportReason(result);
		if (reason) lines.push(`Execution reason: ${reason}`);
		if (result.causes?.length) lines.push("Caused by:", ...result.causes.map(cause => `  - ${causeText(cause)}: ${cause.reason}`));
		if (result.metrics) lines.push(`Metrics: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(", ")}`);
		if (result.detail) lines.push(`Detail: ${result.detail}`);
		if (result.outputs && Object.keys(result.outputs).length) lines.push(`Outputs: ${JSON.stringify(result.outputs)}`);
		if (result.verification?.length) {
			lines.push("Verification:");
			for (const check of result.verification) lines.push(`  - ${check.check_id}: ${check.result} (${check.applicability}, attempt ${check.attempt_id})${check.reason ? ` — ${check.reason}` : ""}`);
		}
		if (result.artifacts?.length) {
			lines.push("Artifacts:");
			for (const artifact of result.artifacts) {
				const prov = artifact.producer_node_id ? ` [producer ${artifact.producer_node_id}@${artifact.producer_attempt_id ?? "?"}${artifact.sha256 ? `, sha256=${artifact.sha256.slice(0, 12)}…` : ""}]` : "";
				lines.push(`  - [${artifact.type}]${artifact.path ? ` ${artifact.path}` : ""}${artifact.action ? ` (${artifact.action})` : ""}${prov} — ${artifact.description ?? ""}`);
			}
		}
		if (result.warnings?.length) {
			warnings += result.warnings.length;
			lines.push("Warnings:", ...result.warnings.map(warning => `  - ${warning}`));
		}
		if (result.next_steps?.length) lines.push("Next steps:", ...result.next_steps.map(step => `  - ${step}`));
		if (result.undelivered_edges?.length) {
			lines.push("Undelivered edges:", ...result.undelivered_edges.map(edge => `  - to ${edge.destination}: ${edge.reason}`));
		}
		lines.push(...formatReviewHistory(result), "");
	}
	if (nodeCounts?.length) {
		lines.push("## Node attempt and rollback counts", "", ...nodeCounts.map(item => `- ${item.node_id}: ${item.attempts} attempt${item.attempts === 1 ? "" : "s"}, ${item.rollbacks} rollback${item.rollbacks === 1 ? "" : "s"}`), "");
	}
	if (nodeCountsError) lines.push(`Node counts unavailable: ${nodeCountsError}`, "");
	lines.push("---", `Overall: ${counts.success} success, ${counts.partial} partial, ${counts.failure} failure${attention}${notExecuted ? `, ${notExecuted} not executed` : ""}${cancelledAfterCompleted ? `, ${cancelledAfterCompleted} cancelled after completing` : ""} | ${warnings} warnings | run outcome: ${outcome}`);
	return lines.join("\n") + "\n";
}

/** The run's aggregate outcome and any nodes that never executed (they have no results), for bootstrap_status. */
export function formatRunOutcome(outcome: RunOutcome, agents: AgentState[]): string {
	const counts = (Object.entries(outcome.counts) as Array<[ExecutionState, number]>).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
	const notExecuted = agents.filter(agent => !agent.result_status && (agent.execution === "blocked" || agent.execution === "skipped" || agent.execution === "cancelled"));
	const cancelledAfter = agents.filter(agent => Boolean(agent.result_status) && agent.execution === "cancelled");
	return `Run outcome: ${outcome.state}${counts.length ? ` (${counts.join(", ")})` : ""}.` +
		(notExecuted.length ? ` Did not execute: ${notExecuted.map(agent => `${agent.node_id} (${agent.execution})`).join(", ")}. They have no results; the report lists them from their records.` : "") +
		(cancelledAfter.length ? ` Cancelled after completing: ${cancelledAfter.map(agent => agent.node_id).join(", ")}.` : "");
}

/** Dry-run preview: everything that would be launched, so mistakes surface before tabs exist. */
export function formatPlan(plan: PlanPreview, width = 100): string {
	const collabNote = plan.collaboration_mode === "legacy"
		? "legacy (retains existing peer messaging; migrate to persona/node_id for independent mode or set collaboration_mode explicitly)"
		: plan.collaboration_mode;
	const deadlines = [
		plan.task_timeout_ms !== undefined ? `task timeout ${plan.task_timeout_ms}ms` : "",
		plan.dependency_wait_timeout_ms !== undefined ? `dependency wait ${plan.dependency_wait_timeout_ms}ms` : "",
		plan.liveness_timeout_ms !== undefined ? `liveness ${plan.liveness_timeout_ms}ms` : "",
		plan.cancel_grace_ms !== undefined ? `cancel grace ${plan.cancel_grace_ms}ms` : "",
	].filter(Boolean);
	const nodeIdByInstance = new Map(plan.agents.map(agent => [agent.instance_id, agent.node_id]));
	const loopLimits = new Map(plan.agents.flatMap(({ decision }) => decision
		? decision.loop_body.map(id => [id, decision.max_revisions + 1] as const)
		: []));
	const graph = renderGraph({
		mode: "plan",
		topology: plan.topology,
		nodes: plan.agents.map(agent => {
			const inbound = (agent as { inbound_edges?: string[] }).inbound_edges;
			const maxAttempts = loopLimits.get(agent.node_id);
			return {
				id: agent.node_id,
				inboundEdges: inbound
					? inbound.map(src => nodeIdByInstance.get(src) ?? src)
					: agent.predecessor
						? [nodeIdByInstance.get(agent.predecessor) ?? agent.predecessor]
						: [],
				...(maxAttempts !== undefined ? { loop: { attempt: 1, maxAttempts } } : {}),
			};
		}),
	}, width);
	const inboundNodesById = new Map<string, string[]>();
	for (const agent of plan.agents) {
		const inbound = (agent as { inbound_edges?: string[] }).inbound_edges;
		const parents = inbound
			? inbound.map(src => nodeIdByInstance.get(src) ?? src)
			: agent.predecessor
				? [nodeIdByInstance.get(agent.predecessor) ?? agent.predecessor]
				: [];
		inboundNodesById.set(agent.node_id, parents);
	}
	const ancestorsByNode = new Map<string, Set<string>>();
	const ancestorsOf = (id: string): Set<string> => {
		const cached = ancestorsByNode.get(id);
		if (cached) return cached;
		const visited = new Set<string>();
		const queue = [...(inboundNodesById.get(id) ?? [])];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			if (visited.has(cur)) continue;
			visited.add(cur);
			queue.push(...(inboundNodesById.get(cur) ?? []));
		}
		ancestorsByNode.set(id, visited);
		return visited;
	};
	const loopLabelByNode = new Map<string, string>();
	for (const agent of plan.agents) {
		if (!agent.decision) continue;
		const label = `${agent.decision.on_reject} → ${agent.node_id}`;
		for (const id of agent.decision.loop_body) loopLabelByNode.set(id, label);
	}
	const formatConflict = (c: typeof plan.ownership_conflicts[number]) => {
		const nodeLoop = loopLabelByNode.get(c.node_id);
		const waitLoop = loopLabelByNode.get(c.waits_for_node_id);
		const base = `${c.node_id} waits for ${c.waits_for_node_id} (${c.overlapping_paths.join(", ")})`;
		if (ancestorsOf(c.node_id).has(c.waits_for_node_id) || ancestorsOf(c.waits_for_node_id).has(c.node_id)) return base;
		if (nodeLoop && waitLoop && nodeLoop !== waitLoop) return `whole loop (${nodeLoop}) serializes with whole loop (${waitLoop}): ${base}`;
		if (nodeLoop && nodeLoop !== waitLoop) return `whole loop (${nodeLoop}) serializes with ${c.waits_for_node_id}: ${base}`;
		if (waitLoop && nodeLoop !== waitLoop) return `whole loop (${waitLoop}) serializes with ${c.node_id}: ${base}`;
		return base;
	};
	const header = [
		`${plan.topology} in ${plan.project_cwd} (workspace: ${plan.workspace_strategy}; readiness timeout ${plan.ready_timeout_ms}ms${deadlines.length ? `; ${deadlines.join("; ")}` : ""}; Coms ${plan.coms_extension})`,
		`  collaboration: ${collabNote}; failure_policy: ${plan.failure_policy}`,
		`  ownership_contract: shared-cwd path declarations are an advisory scheduling contract unless backed by external enforcement or separate workspaces`,
		...(plan.goal ? [`  goal: ${clip(plan.goal, 200)}`] : []),
		...(plan.acceptance_criteria?.length ? [`  acceptance_criteria: ${clip(plan.acceptance_criteria.join("; "), 200)}`] : []),
		...(plan.constraints?.length ? [`  constraints: ${clip(plan.constraints.join("; "), 200)}`] : []),
		...(plan.learned_constraints ? [`  learned_constraints: ${formatLearnedConstraintsSummary(plan.learned_constraints)}`] : []),
		...(plan.ownership_conflicts.length ? [`  ownership_conflicts: ${plan.ownership_conflicts.map(formatConflict).join("; ")}`] : []),
		...(plan.cleanup ? [`  cleanup: ${plan.cleanup}${plan.cleanup === "on_success" ? ` (settle window ${plan.cleanup_settle_ms}ms)` : ""}`] : []),
		...(plan.max_total_attempts !== undefined ? [`  max_total_attempts: ${plan.max_total_attempts} (${plan.max_total_attempts_source})`] : []),
		...(plan.lanes ? [`  risk_lanes: contained=[${plan.lanes.contained.join(", ") || "none"}], closed=[${plan.lanes.closed.join(", ") || "none"}], unmatched=wide`] : []),
		...(plan.warnings?.length ? plan.warnings.map(warning => `  warning: ${warning}`) : []),
		...graph.split("\n"),
	];
	return [...header,
		...plan.agents.map(agent => (agent.kind === "command"
			? `- ${agent.instance_id}${agent.step ? ` (step ${agent.step})` : ""}: node ${agent.node_id}, command ${JSON.stringify(agent.command)}${agent.args?.length ? ` args ${JSON.stringify(agent.args)}` : ""}` +
				`\n  working_directory ${agent.working_directory}`
			: `- ${agent.instance_id}${agent.step ? ` (step ${agent.step})` : ""}: ${agent.node_id.toLowerCase() === (agent.persona_name ?? agent.node_id).toLowerCase() ? "" : `node ${agent.node_id}, `}persona ${agent.persona_name} from ${agent.persona_file}${agent.persona_source ? ` [${agent.persona_source}]` : ""}` +
				`\n  model ${agent.model}; thinking ${agent.thinking ?? "(default)"}; tools ${(agent.tools ?? []).join(", ") || "(unrestricted)"}${agent.extensions?.length ? `; extensions ${agent.extensions.join(", ")}` : ""}` +
				`; allowed skills: ${agent.allowed_skills === undefined ? "all" : agent.allowed_skills.join(", ") || "none"}`) +
			`${agent.role ? `\n  role: ${clip(agent.role, 160)}` : ""}` +
			`${agent.ownership?.length ? `\n  ownership: ${clip(agent.ownership.join(", "), 160)}` : ""}` +
			`${agent.read_paths?.length ? `\n  read_paths: ${clip(agent.read_paths.join(", "), 160)}` : ""}` +
			`${agent.write_paths?.length ? `\n  write_paths: ${clip(agent.write_paths.join(", "), 160)}` : ""}` +
			`${agent.ownership_wait_for.length ? `\n  ownership_wait_for: ${agent.ownership_wait_for.join(", ")}` : ""}` +
			`${agent.output_contract ? `\n  output_contract: ${clip(JSON.stringify(agent.output_contract), 160)}` : ""}` +
			`${agent.decision ? `\n  decision: ${agent.decision.field} approves on ${JSON.stringify(agent.decision.approve)}, rejects on ${JSON.stringify(agent.decision.reject)}\n  on_reject: ${agent.decision.on_reject}; loop body: ${agent.decision.loop_body.join(", ")}\n  max_revisions: ${agent.decision.max_revisions} (${agent.decision.max_revisions_source}); on_exhausted: ${agent.decision.on_exhausted}` : ""}` +
			`${agent.required_checks?.length ? `\n  required_checks: ${agent.required_checks.join(", ")}` : ""}` +
			`${agent.dependency_policy ? `\n  dependency: ${agent.dependency_policy}` : ""}` +
			`${agent.join_policy ? `\n  join_policy: ${agent.join_policy}` : ""}` +
			`${agent.task_timeout_ms !== undefined || agent.dependency_wait_timeout_ms !== undefined ? `\n  deadlines: ${[agent.task_timeout_ms !== undefined ? `task timeout ${agent.task_timeout_ms}ms` : "", agent.dependency_wait_timeout_ms !== undefined ? `dependency wait ${agent.dependency_wait_timeout_ms}ms` : ""].filter(Boolean).join("; ")}` : ""}` +
			`\n  task: ${clip(agent.sub_task, 160)}`)].join("\n");
}

/** Human- and model-facing summary of a cancellation request, including preserved work, running limits, and downstream blockers. */
export function formatCancelResult(result: CancelResult): string {
	const lines = [`Cancellation (${result.scope}) for run ${result.task_id}: ${result.reason}.`];
	if (result.cancelled.length) lines.push(`Cancelled: ${result.cancelled.join(", ")}.`);
	if (result.cancelling.length) {
		lines.push(`Cancelling (in-flight work): ${result.cancelling.map(c => `${c.node_id} (${c.force_close_allowed ? "grace elapsed; force_close=true available" : c.grace_remaining_ms === 0 ? "grace elapsed; waiting for the worker to acknowledge" : `grace ${c.grace_remaining_ms}ms remaining`})`).join(", ")}.`);
	}
	if (result.already_completed.length) lines.push(`Already completed (preserved): ${result.already_completed.join(", ")}.`);
	if (result.already_settled.length) lines.push(`Already settled: ${result.already_settled.join(", ")}.`);
	if (result.force_closed.length) lines.push(`Force-closed owned resources: ${result.force_closed.join(", ")}.`);
	if (result.blocked_dependents.length) {
		lines.push(`Will not run (downstream blockers): ${result.blocked_dependents.map(d => `${d.node_id} (blocked by ${d.blocked_by})`).join(", ")}.`);
	}
	if (result.record_errors?.length) lines.push(`Record errors: ${result.record_errors.join("; ")}.`);
	if (result.cleanup_errors.length) lines.push(`Force-close errors: ${result.cleanup_errors.join("; ")}.`);
	if (result.cleanup_notes.length) lines.push(`Notes: ${result.cleanup_notes.join("; ")}.`);
	lines.push(`Limits: ${result.limitations}`);
	return lines.join("\n");
}

/** One line per recorded run, newest first. */
export function formatRunList(runs: BootstrapManifest[]): string {
	return runs.map(run => `- ${run.task_id} [${run.status}/${run.phase}] ${run.topology}, ${run.pane_manifest.length} agent(s), updated ${run.updated_at}`).join("\n");
}

/** The recovery report as text for the dispatcher model: what the records show, what was done (if anything), and what to do next. */
export function formatRecovery(report: RecoveryReport): string {
	const lines = [`Recovery ${report.action} for run ${report.task_id}${report.closed ? ` — closed: ${report.closed}` : ""}.`];
	if (!report.assessments.length) lines.push("No chain handoff matches (a team has none, and the first step has no inbound handoff).");
	for (const problem of report.record_errors ?? []) lines.push(`Record error: ${clip(problem, 300)}`);
	for (const item of report.assessments) {
		lines.push(`- ${item.source.node_id} → ${item.destination.node_id}${item.handoff_id ? ` (${item.handoff_id})` : ""}: ${item.stage} [${item.verdict}] — ${clip(item.reason, 300)}`);
		for (const evidence of item.evidence) lines.push(`    evidence: ${clip(evidence, 240)}`);
		for (const problem of item.problems) lines.push(`    problem: ${clip(problem, 240)}`);
	}
	if (report.delivery) lines.push(`Re-sent handoff ${report.delivery.handoff_id} (attempt ${report.delivery.attempt}): Coms ${report.delivery.transport === "acknowledged" ? "acknowledged the message (that is delivery, not acceptance)" : `could not send it (${clip(report.delivery.error ?? "unknown error", 200)})`}${report.delivery.offer === "recorded_by_dispatcher" ? "; the source had exited before recording its offer, so the dispatcher recorded the same offer from the saved result" : ""}.`);
	if (report.refused) lines.push(`Not retried: ${clip(report.refused, 400)}`);
	for (const step of report.next_steps) lines.push(`Next: ${step}`);
	return lines.join("\n");
}

export function formatAutomaticCleanup(manifest: BootstrapManifest): string | undefined {
	if (manifest.cleanup_trigger !== "auto") return;
	if (manifest.cleanup_errors?.length) {
		return `Cleanup incomplete. Retry with bootstrap_cleanup:\n${manifest.cleanup_errors.map(error => `- ${error}`).join("\n")}`;
	}
	if (manifest.status === "cleaned") {
		return "Run succeeded and was cleaned up automatically. Use bootstrap_report to read the retained results.";
	}
}
