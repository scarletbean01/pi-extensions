import { aggregateRun, executionFromResult, type CauseRef, type ExecutionState, type RunOutcome } from "./outcomes.ts";
import { nodeIdentity, nodeLabel, type BootstrapManifest, type ReportEntry } from "./session-store.ts";
import type { AgentState, CancelResult, PlanPreview } from "./lifecycle.ts";
import type { HandoffView } from "./handoff.ts";
import type { RecoveryReport } from "./recovery.ts";

/** Working agents with no model/tool activity for this long are flagged; nothing is killed automatically. */
export const STALL_MS = 10 * 60_000;

// Tool `details` only feed the UI. Everything the dispatcher model must act on goes in these texts.
const clip = (text: string, max = 240) => (text = text.replace(/\s+/g, " ").trim()).length > max ? `${text.slice(0, max - 1)}…` : text;

/** A report entry's node (and its persona when that is a different name). */
const resultLabel = (result: ReportEntry) => result.node_id ? nodeLabel({ node_id: result.node_id, persona_name: result.agent_name }) : result.agent_name;

/** "n1 (failed)", or for evidence "n1 (succeeded; check tests stale)": the nodes, and the evidence, that stopped later work. */
const causeText = (cause: CauseRef) => `${cause.node_id} (${cause.check ? `${cause.state}; check ${cause.check.name} ${cause.check.evidence}` : cause.state})`;
const entryState = (entry: ReportEntry): ExecutionState => entry.execution_state ?? executionFromResult(entry.status as "success" | "partial" | "failure").state;
/** Counts by what the nodes reported, and (separately) the nodes that never executed; the run's outcome follows from all their states. */
function tally(entries: ReportEntry[]) {
	const counts = { success: 0, partial: 0, failure: 0, blocked: 0, skipped: 0, cancelled: 0 };
	for (const entry of entries) counts[entry.status]++;
	const notExecuted = counts.blocked + counts.skipped + counts.cancelled;
	const names = (["blocked", "skipped", "cancelled"] as const).filter(name => counts[name]).map(name => `${counts[name]} ${name}`);
	return { counts, notExecuted, names, outcome: aggregateRun(entries.map(entryState)).state };
}

/** One line per launched agent with the identifiers needed for status checks and subset cleanup. */
export function formatLaunch(manifest: BootstrapManifest): string {
	return manifest.pane_manifest.map(entry => `- ${entry.instance_id} (${nodeIdentity(entry)})${entry.step ? ` step ${entry.step}` : ""}: ${entry.status}` +
		`${entry.tab_id ? `, tab ${entry.tab_id}` : ""}, model ${entry.expected_model}${entry.error ? ` — error: ${clip(entry.error)}` : ""}`).join("\n");
}

/**
 * Handoff delivery, acceptance and rejection, said apart: queued only means Coms acknowledged a notification. A refused handoff says what to do, because
 * nothing was accepted or run for it and nothing retries it on its own.
 */
function handoffText(direction: "in" | "out", view: HandoffView): string {
	const id = view.handoff_id ?? "(receipt without an ID)";
	const resent = view.recovery ? `; dispatcher re-sent it ${view.recovery.attempts} time${view.recovery.attempts === 1 ? "" : "s"} (last ${view.recovery.last_transport === "acknowledged" ? "Coms acknowledged" : view.recovery.last_transport === "failed" ? "send failed" : "send not confirmed"})` : "";
	const peer = direction === "in" ? view.source : view.destination;
	const rejection = view.rejections.at(-1);
	switch (view.state) {
		case "accepted": return ` [handoff ${direction} ${id} accepted${view.legacy ? " (previous release's receipt)" : view.delivered_by === "dispatcher" ? " (re-sent by the dispatcher)" : ""}]`;
		case "rejected": return ` [handoff ${direction} ${id} rejected: ${clip(rejection?.reason ?? "no reason recorded", 160)}; nothing ran for this handoff; inspect ${view.source}'s saved result, then bootstrap_cleanup and relaunch with a new request_id (no automatic retry)]`;
		case "queued": return ` [handoff ${direction} ${id} queued: not accepted yet${direction === "in" ? ` (${peer} sent it and Coms acknowledged the message; acceptance is recorded only by this node)` : ""}${rejection ? `; last notification refused: ${clip(rejection.reason, 100)}` : ""}${resent}]`;
		case "offered": return ` [handoff ${direction} ${id} offered: not delivered yet${resent}]`;
		default: return rejection ? ` [handoff ${direction}: no offer on record; last notification refused: ${clip(rejection.reason, 100)}]` : "";
	}
}

/** Per-agent progress for bootstrap_status, ordered as planned. */
export function formatAgentStates(agents: AgentState[]): string {
	return agents.map(agent => {
		const live = agent.state !== "done" && agent.state !== "closed";
		const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
		const signs = [
			live && agent.heartbeat_age_ms !== undefined ? `heartbeat ${seconds(agent.heartbeat_age_ms)} ago` : "",
			live && agent.state === "working" && agent.activity_age_ms !== undefined ? `last activity ${seconds(agent.activity_age_ms)} ago${agent.activity_age_ms > STALL_MS ? " — possibly stalled" : ""}` : "",
		].filter(Boolean);
		const heartbeat = signs.length ? ` (${signs.join(", ")})` : "";
		const liveness = live && agent.liveness && agent.liveness !== "healthy" ? ` [liveness: ${agent.liveness}]` : "";
		const duration = live && agent.task_timeout_ms !== undefined && agent.elapsed_ms !== undefined
			? ` [elapsed ${seconds(agent.elapsed_ms)}/${seconds(agent.task_timeout_ms)}${agent.deadline_exceeded ? " — deadline exceeded" : ""}]`
			: "";
		const cancelling = agent.cancelling
			? ` [cancelling${agent.force_close_allowed ? " — force_close available" : ` — grace ${agent.grace_remaining_ms ?? 0}ms remaining`}]`
			: "";
		const outcome = agent.result_status ? ` ${agent.result_status}: ${clip(agent.summary ?? "")}` : "";
		const delivery = agent.delivery === "failed" || agent.delivery === "pending" ? ` [handoff ${agent.delivery}]` : "";
		const handoffs = (agent.handoff ? handoffText("in", agent.handoff) : "") + (agent.handoff_out ? handoffText("out", agent.handoff_out) : "");
		const checks = agent.verification?.length ? ` [checks: ${agent.verification.map(v => `${v.check_id}=${v.result}/${v.applicability}`).join(", ")}]` : "";
		// Execution state is separate from the legacy state word above: it says whether the node ran, was blocked, or needs attention, and why.
		const why = agent.execution_causes.length ? `; caused by ${agent.execution_causes.map(causeText).join(", ")}` : "";
		const reason = agent.execution === "blocked" || agent.execution === "skipped" || agent.execution === "cancelled" ? ` — ${clip(agent.execution_reason ?? "")}` : "";
		const evidence = agent.evidence?.length ? ` [evidence: ${agent.evidence.map(item => `${item.check} ${item.status}`).join(", ")}]` : "";
		const ownership = agent.ownership_status === "held_uncertain" && agent.ownership_waiting_on?.length
			? ` [ownership: held by ${agent.ownership_waiting_on.map(w => `${w.node_id} (uncertain: ${clip(w.reason, 80)})`).join(", ")}]`
			: agent.ownership_status === "waiting" && agent.ownership_waiting_on?.length
			? ` [ownership: waiting on ${agent.ownership_waiting_on.map(w => w.node_id).join(", ")}]`
			: "";
		return `- ${agent.instance_id} (${nodeIdentity(agent)}): ${agent.state}${heartbeat}${liveness}${duration}${cancelling}${outcome}${delivery}${handoffs}${checks}${agent.error ? ` — ${clip(agent.error)}` : ""}${reason} [execution ${agent.execution}${why}]${evidence}${ownership}`;
	}).join("\n");
}

/** Compact report digest so the dispatcher need not re-read report.json to answer the user. */
export function formatReportDigest(results: ReportEntry[]): string {
	const { counts, notExecuted, names, outcome } = tally(results);
	return [`${counts.success} success, ${counts.partial} partial, ${counts.failure} failure.${notExecuted ? ` Not executed: ${names.join(", ")}.` : ""}`,
		`Run outcome: ${outcome}.`,
		...results.map(result => `- ${resultLabel(result)}: ${result.status} — ${clip(result.summary)}${"causes" in result && result.causes?.length ? ` (caused by ${result.causes.map(cause => `${cause.node_id} ${cause.state}`).join(", ")})` : ""}${"next_steps" in result && result.next_steps?.length ? ` (next: ${clip(result.next_steps.join("; "), 160)})` : ""}`)].join("\n");
}

export function buildMarkdownReport(results: ReportEntry[]): string {
	const lines = ["# Bootstrap Results", ""];
	const { counts, notExecuted, outcome } = tally(results);
	let warnings = 0;
	for (const result of results) {
		if (result.status === "blocked" || result.status === "skipped" || result.status === "cancelled") {
			lines.push(`### ${result.status === "cancelled" ? "🛑" : result.status === "skipped" ? "⏭️" : "⛔"} ${resultLabel(result)}`, `Status: ${result.status} (not executed)`, `Summary: ${result.summary}`);
			if (result.causes.length) lines.push("Caused by:", ...result.causes.map(cause => `  - ${causeText(cause)}: ${cause.reason}`));
			lines.push("");
			continue;
		}
		const icon = result.status === "success" ? "✅" : result.status === "partial" ? "⚠️" : "❌";
		lines.push(`### ${icon} ${resultLabel(result)}`, `Status: ${result.status}`, `Summary: ${result.summary}`);
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
		lines.push("");
	}
	lines.push("---", `Overall: ${counts.success} success, ${counts.partial} partial, ${counts.failure} failure${notExecuted ? `, ${notExecuted} not executed` : ""} | ${warnings} warnings | run outcome: ${outcome}`);
	return lines.join("\n") + "\n";
}

/** The run's aggregate outcome and any nodes that never executed (they have no results), for bootstrap_status. */
export function formatRunOutcome(outcome: RunOutcome, agents: AgentState[]): string {
	const counts = (Object.entries(outcome.counts) as Array<[ExecutionState, number]>).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
	const notExecuted = agents.filter(agent => agent.execution === "blocked" || agent.execution === "skipped" || agent.execution === "cancelled");
	return `Run outcome: ${outcome.state}${counts.length ? ` (${counts.join(", ")})` : ""}.` +
		(notExecuted.length ? ` Did not execute: ${notExecuted.map(agent => `${agent.node_id} (${agent.execution})`).join(", ")}. They have no results; the report lists them from their records.` : "");
}

/** Dry-run preview: everything that would be launched, so mistakes surface before tabs exist. */
export function formatPlan(plan: PlanPreview): string {
	const collabNote = plan.collaboration_mode === "legacy"
		? "legacy (retains existing peer messaging; migrate to persona/node_id for independent mode or set collaboration_mode explicitly)"
		: plan.collaboration_mode;
	const deadlines = [
		plan.task_timeout_ms !== undefined ? `task timeout ${plan.task_timeout_ms}ms` : "",
		plan.dependency_wait_timeout_ms !== undefined ? `dependency wait ${plan.dependency_wait_timeout_ms}ms` : "",
		plan.liveness_timeout_ms !== undefined ? `liveness ${plan.liveness_timeout_ms}ms` : "",
		plan.cancel_grace_ms !== undefined ? `cancel grace ${plan.cancel_grace_ms}ms` : "",
	].filter(Boolean);
	const header = [
		`${plan.topology} in ${plan.project_cwd} (workspace: ${plan.workspace_strategy}; readiness timeout ${plan.ready_timeout_ms}ms${deadlines.length ? `; ${deadlines.join("; ")}` : ""}; Coms ${plan.coms_extension})`,
		`  collaboration: ${collabNote}; failure_policy: ${plan.failure_policy}`,
		`  ownership_contract: shared-cwd path declarations are an advisory scheduling contract unless backed by external enforcement or separate workspaces`,
		...(plan.goal ? [`  goal: ${clip(plan.goal, 200)}`] : []),
		...(plan.acceptance_criteria?.length ? [`  acceptance_criteria: ${clip(plan.acceptance_criteria.join("; "), 200)}`] : []),
		...(plan.constraints?.length ? [`  constraints: ${clip(plan.constraints.join("; "), 200)}`] : []),
		...(plan.ownership_conflicts.length ? [`  ownership_conflicts: ${plan.ownership_conflicts.map(c => `${c.node_id} waits for ${c.waits_for_node_id} (${c.overlapping_paths.join(", ")})`).join("; ")}`] : []),
	];
	return [...header,
		...plan.agents.map(agent => `- ${agent.instance_id}${agent.step ? ` (step ${agent.step})` : ""}: ${agent.node_id.toLowerCase() === agent.persona_name.toLowerCase() ? "" : `node ${agent.node_id}, `}persona ${agent.persona_name} from ${agent.persona_file}${agent.persona_source ? ` [${agent.persona_source}]` : ""}` +
			`\n  model ${agent.model}; thinking ${agent.thinking ?? "(default)"}; tools ${agent.tools.join(", ") || "(unrestricted)"}${agent.extensions.length ? `; extensions ${agent.extensions.join(", ")}` : ""}` +
			`; allowed skills: ${agent.allowed_skills === undefined ? "all" : agent.allowed_skills.join(", ") || "none"}` +
			`${agent.role ? `\n  role: ${clip(agent.role, 160)}` : ""}` +
			`${agent.ownership?.length ? `\n  ownership: ${clip(agent.ownership.join(", "), 160)}` : ""}` +
			`${agent.read_paths?.length ? `\n  read_paths: ${clip(agent.read_paths.join(", "), 160)}` : ""}` +
			`${agent.write_paths?.length ? `\n  write_paths: ${clip(agent.write_paths.join(", "), 160)}` : ""}` +
			`${agent.ownership_wait_for.length ? `\n  ownership_wait_for: ${agent.ownership_wait_for.join(", ")}` : ""}` +
			`${agent.output_contract ? `\n  output_contract: ${clip(JSON.stringify(agent.output_contract), 160)}` : ""}` +
			`${agent.required_checks?.length ? `\n  required_checks: ${agent.required_checks.join(", ")}` : ""}` +
			`${agent.predecessor || agent.successor ? `\n  ${agent.predecessor ?? "dispatcher"} → ${agent.instance_id} → ${agent.successor ?? "dispatcher"}` : ""}` +
			`${agent.dependency_policy ? `\n  dependency: ${agent.dependency_policy}` : ""}` +
			`${agent.task_timeout_ms !== undefined || agent.dependency_wait_timeout_ms !== undefined ? `\n  deadlines: ${[agent.task_timeout_ms !== undefined ? `task timeout ${agent.task_timeout_ms}ms` : "", agent.dependency_wait_timeout_ms !== undefined ? `dependency wait ${agent.dependency_wait_timeout_ms}ms` : ""].filter(Boolean).join("; ")}` : ""}` +
			`\n  task: ${clip(agent.sub_task, 160)}`)].join("\n");
}

/** Human- and model-facing summary of a cancellation request, including preserved work, running limits, and downstream blockers. */
export function formatCancelResult(result: CancelResult): string {
	const lines = [`Cancellation (${result.scope}) for run ${result.task_id}: ${result.reason}.`];
	if (result.cancelled.length) lines.push(`Cancelled: ${result.cancelled.join(", ")}.`);
	if (result.cancelling.length) {
		lines.push(`Cancelling (in-flight work): ${result.cancelling.map(c => `${c.node_id} (${c.force_close_allowed ? "grace elapsed; force_close=true available" : `grace ${c.grace_remaining_ms}ms remaining`})`).join(", ")}.`);
	}
	if (result.already_completed.length) lines.push(`Already completed (preserved): ${result.already_completed.join(", ")}.`);
	if (result.already_settled.length) lines.push(`Already settled: ${result.already_settled.join(", ")}.`);
	if (result.force_closed.length) lines.push(`Force-closed owned resources: ${result.force_closed.join(", ")}.`);
	if (result.blocked_dependents.length) {
		lines.push(`Will not run (downstream blockers): ${result.blocked_dependents.map(d => `${d.node_id} (blocked by ${d.blocked_by})`).join(", ")}.`);
	}
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
