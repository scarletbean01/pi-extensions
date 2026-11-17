import type { BootstrapManifest, BootstrapResult } from "./session-store.ts";
import type { AgentState, PlanPreview } from "./lifecycle.ts";

/** Working agents with no model/tool activity for this long are flagged; nothing is killed automatically. */
export const STALL_MS = 10 * 60_000;

// Tool `details` only feed the UI. Everything the dispatcher model must act on goes in these texts.
const clip = (text: string, max = 240) => (text = text.replace(/\s+/g, " ").trim()).length > max ? `${text.slice(0, max - 1)}…` : text;

/** One line per launched agent with the identifiers needed for status checks and subset cleanup. */
export function formatLaunch(manifest: BootstrapManifest): string {
	return manifest.pane_manifest.map(entry => `- ${entry.instance_id} (${entry.agent_name})${entry.step ? ` step ${entry.step}` : ""}: ${entry.status}` +
		`${entry.tab_id ? `, tab ${entry.tab_id}` : ""}, model ${entry.expected_model}${entry.error ? ` — error: ${clip(entry.error)}` : ""}`).join("\n");
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
		const outcome = agent.result_status ? ` ${agent.result_status}: ${clip(agent.summary ?? "")}` : "";
		const delivery = agent.delivery === "failed" || agent.delivery === "pending" ? ` [handoff ${agent.delivery}]` : "";
		return `- ${agent.instance_id} (${agent.agent_name}): ${agent.state}${heartbeat}${outcome}${delivery}${agent.error ? ` — ${clip(agent.error)}` : ""}`;
	}).join("\n");
}

/** Compact report digest so the dispatcher need not re-read report.json to answer the user. */
export function formatReportDigest(results: BootstrapResult[]): string {
	const counts = { success: 0, partial: 0, failure: 0 };
	for (const result of results) counts[result.status]++;
	return [`${counts.success} success, ${counts.partial} partial, ${counts.failure} failure.`,
		...results.map(result => `- ${result.agent_name}: ${result.status} — ${clip(result.summary)}${result.next_steps?.length ? ` (next: ${clip(result.next_steps.join("; "), 160)})` : ""}`)].join("\n");
}

export function buildMarkdownReport(results: BootstrapResult[]): string {
	const lines = ["# Bootstrap Results", ""];
	const counts = { success: 0, partial: 0, failure: 0 };
	let warnings = 0;
	for (const result of results) {
		counts[result.status]++;
		const icon = result.status === "success" ? "✅" : result.status === "partial" ? "⚠️" : "❌";
		lines.push(`### ${icon} ${result.agent_name}`, `Status: ${result.status}`, `Summary: ${result.summary}`);
		if (result.metrics) lines.push(`Metrics: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(", ")}`);
		if (result.detail) lines.push(`Detail: ${result.detail}`);
		if (result.artifacts?.length) {
			lines.push("Artifacts:");
			for (const artifact of result.artifacts) lines.push(`  - [${artifact.type}]${artifact.path ? ` ${artifact.path}` : ""}${artifact.action ? ` (${artifact.action})` : ""} — ${artifact.description ?? ""}`);
		}
		if (result.warnings?.length) {
			warnings += result.warnings.length;
			lines.push("Warnings:", ...result.warnings.map(warning => `  - ${warning}`));
		}
		if (result.next_steps?.length) lines.push("Next steps:", ...result.next_steps.map(step => `  - ${step}`));
		lines.push("");
	}
	lines.push("---", `Overall: ${counts.success} success, ${counts.partial} partial, ${counts.failure} failure | ${warnings} warnings`);
	return lines.join("\n") + "\n";
}

/** Dry-run preview: everything that would be launched, so mistakes surface before tabs exist. */
export function formatPlan(plan: PlanPreview): string {
	return [`${plan.topology} in ${plan.project_cwd}; readiness timeout ${plan.ready_timeout_ms}ms; Coms ${plan.coms_extension}`,
		...plan.agents.map(agent => `- ${agent.instance_id}${agent.step ? ` (step ${agent.step})` : ""}: persona ${agent.agent_name} from ${agent.persona_file}${agent.persona_source ? ` [${agent.persona_source}]` : ""}` +
			`\n  model ${agent.model}; tools ${agent.tools.join(", ") || "(unrestricted)"}${agent.extensions.length ? `; extensions ${agent.extensions.join(", ")}` : ""}` +
			`${agent.predecessor || agent.successor ? `\n  ${agent.predecessor ?? "dispatcher"} → ${agent.instance_id} → ${agent.successor ?? "dispatcher"}` : ""}` +
			`\n  task: ${clip(agent.sub_task, 160)}`)].join("\n");
}

/** One line per recorded run, newest first. */
export function formatRunList(runs: BootstrapManifest[]): string {
	return runs.map(run => `- ${run.task_id} [${run.status}/${run.phase}] ${run.topology}, ${run.pane_manifest.length} agent(s), updated ${run.updated_at}`).join("\n");
}
