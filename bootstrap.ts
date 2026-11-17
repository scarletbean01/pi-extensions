/** Herdr-native bootstrap: preflight → durable plan → readiness barrier → release → recoverable cleanup. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, MAX_WAIT_MS, type GenerateRequest } from "./bootstrap/lifecycle.ts";
import { buildMarkdownReport, formatAgentStates, formatLaunch, formatPlan, formatReportDigest, formatRunList } from "./bootstrap/reporting.ts";
import { errorMessage, type BootstrapManifest, type BootstrapResult } from "./bootstrap/session-store.ts";
import { resultSchema } from "./bootstrap/schemas.ts";
import { applyExtensionDefaults } from "./themeMap.ts";

function response(text: string, details: Record<string, unknown>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function publicManifest(manifest: BootstrapManifest): Record<string, unknown> {
	// Acknowledgement tokens are internal; callers only need identities and recovery state.
	const { token: _token, ...visible } = manifest;
	return visible;
}

export default function (pi: ExtensionAPI) {
	const service = new BootstrapService({
		exec: (command, args, options) => pi.exec(command, args, options),
		extensionDir: dirname(fileURLToPath(import.meta.url)),
	});

	pi.registerTool({
		name: "bootstrap_generate", label: "Bootstrap Generate",
		description: "Spawn a chain or team as tabs in the originating Herdr workspace. Validates dependencies, persists partial progress, and waits for every agent to be ready before releasing work. Returns task_id and pane_manifest. On failure, resources are retained for bootstrap_cleanup; do not blindly retry. Reuse request_id for idempotent retries.",
		parameters: Type.Object({
			topology: Type.Union([Type.Literal("chain"), Type.Literal("team")]),
			task: Type.String({ minLength: 1, description: "High-level task for the run" }),
			agents: Type.Array(Type.Object({
				name: Type.String({ minLength: 1, description: "Persona name; case-insensitive" }),
				sub_task: Type.String({ minLength: 1 }),
				step: Type.Optional(Type.Integer({ minimum: 1, description: "Optional chain order. If supplied, supply unique contiguous steps for all agents." })),
				predecessor: Type.Optional(Type.String({ description: "Optional consistency check; links are derived from chain order." })),
				successor: Type.Optional(Type.String({ description: "Optional consistency check; links are derived from chain order." })),
			}), { minItems: 1, maxItems: 32 }),
			project_cwd: Type.String({ minLength: 1, description: "Absolute project directory" }),
			request_id: Type.Optional(Type.String({ minLength: 1, description: "Idempotency key. Reusing this key with the same plan returns the original run; a different plan is rejected." })),
			coms_extension: Type.Optional(Type.String({ description: "Path to coms.ts when it is not installed under project/extensions or alongside bootstrap.ts" })),
			ready_timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000, description: "Readiness deadline after all launch commands have been submitted; default 60000ms" })),
			dry_run: Type.Optional(Type.Boolean({ description: "Validate and return the fully resolved plan (persona files, models, tools, extensions, chain links) without creating tabs or files. Recommended before a first launch." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				if (params.dry_run) {
					const { dry_run: _dryRun, ...request } = params;
					const plan = service.plan(request as GenerateRequest, ctx.model);
					return response(`Dry run OK — nothing was created.\n${formatPlan(plan)}\nLaunch with the same parameters and dry_run omitted.`, { status: "planned", plan });
				}
				const manifest = await service.generate({ ...params, request_id: params.request_id ?? toolCallId } as GenerateRequest, ctx.model, signal, manifest => {
					onUpdate?.(response(`Bootstrap ${manifest.task_id}: ${manifest.phase}`, publicManifest(manifest)));
				});
				const failed = manifest.status === "error";
				const agents = formatLaunch(manifest);
				return response(
					failed ? `Bootstrap failed: ${manifest.error}. task_id: "${manifest.task_id}". Partial resources are recorded; use bootstrap_cleanup to close them.\n${agents}` :
						`Bootstrap ${manifest.status}. task_id: "${manifest.task_id}". ${manifest.pane_manifest.length} agent(s); workspace ${manifest.workspace_id}.${manifest.error ? ` Warning: ${manifest.error}.` : ""}\n${agents}\n` +
						`Next: bootstrap_status with wait_ms to block until agents finish or need attention, then bootstrap_report without results.`,
					publicManifest(manifest), failed,
				);
			} catch (error) { return response(errorMessage(error), { status: "error", phase: "preflight", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_status", label: "Bootstrap Status",
		description: "Read per-agent progress (waiting/working/done/error, heartbeat age, result summaries), pending agents, worker errors and chain delivery errors from durable files. Does not infer task completion from Herdr idle status. Pass wait_ms to block until every agent finished, any error appears, or the wait expires — prefer this over repeated polling.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Block up to this long (max ${MAX_WAIT_MS}ms) until the run settles or needs attention. Default 0 (return immediately).` })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const status = params.wait_ms ? await service.waitForStatus(params.task_id, params.wait_ms, ctx.cwd, signal) : { ...service.status(params.task_id, ctx.cwd), timed_out: false };
				const total = status.manifest.pane_manifest.length;
				const errors = [...status.worker_errors.map(error => `worker: ${error}`), ...status.delivery_errors.map(error => `delivery: ${error}`)];
				const next = status.manifest.status === "cleaned" ? "Run is cleaned up."
					: errors.length ? "Needs attention: inspect the agent tab, or bootstrap_cleanup the affected agents (agents parameter)."
					: status.pending.length ? (status.timed_out ? "Still running; call again with wait_ms." : "Still running.")
					: "All agents finished: call bootstrap_report without results.";
				const text = `Run ${status.manifest.task_id} [${status.manifest.status}/${status.manifest.phase}]: ${status.results.length}/${total} result(s); pending: ${status.pending.join(", ") || "none"}.` +
					`\n${formatAgentStates(status.agents)}${errors.length ? `\nErrors:\n${errors.map(error => `- ${error}`).join("\n")}` : ""}\n${next}`;
				return response(text, {
					...publicManifest(status.manifest), results: status.results, pending: status.pending, delivery_errors: status.delivery_errors, worker_errors: status.worker_errors,
					agents: status.agents, timed_out: status.timed_out,
				});
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_report", label: "Bootstrap Report",
		description: "Persist report.json and optionally report.md. Omit results to collect worker results automatically (all agents must have finished). Explicit results must contain exactly one result per planned agent. task_id is the run ID, not the workspace ID.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			results: Type.Optional(Type.Array(resultSchema)),
			write_markdown: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const paths = await service.report(params.task_id, params.results as BootstrapResult[] | undefined, params.write_markdown ?? false, buildMarkdownReport, ctx.cwd);
				return response(`Report saved: ${paths.report_json}${paths.report_md ? ` (+ ${paths.report_md})` : ""}\n${formatReportDigest(paths.results)}`, { status: "saved", ...paths });
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerTool({
		name: "bootstrap_cleanup", label: "Bootstrap Cleanup",
		description: "Close tabs owned by a bootstrap run. Re-resolves live IDs before closing and retains recovery state on failure. Session files and reports are kept by default; set delete_session_files=true to delete them only after every owned tab is closed. Safe to retry.",
		parameters: Type.Object({
			task_id: Type.String({ minLength: 1 }),
			agents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional subset by agent name or instance ID (e.g. a2-reviewer). Preferred over tab_ids, which can go stale when Herdr compacts IDs." })),
			tab_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional subset of tab IDs as recorded in the manifest; unrelated IDs are rejected. Omit both agents and tab_ids to close all owned tabs, including ambiguous partial launches." })),
			delete_session_files: Type.Optional(Type.Boolean({ description: "Explicitly delete session files and reports after all tabs are closed. Default false." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			try {
				const manifest = await service.cleanup(params.task_id, params.tab_ids, params.delete_session_files ?? false, ctx.cwd, signal, params.agents);
				const closed = manifest.pane_manifest.filter(entry => entry.status === "closed").length;
				const open = manifest.pane_manifest.filter(entry => entry.status !== "closed" && entry.status !== "planned").length;
				// Closing a requested subset successfully is not a failure, even though other tabs stay open.
				const subset = params.tab_ids !== undefined || params.agents !== undefined;
				const failed = (manifest.cleanup_errors?.length ?? 0) > 0 || (!subset && manifest.status !== "cleaned");
				const files = manifest.session_files_deleted ? "deleted" : manifest.session_dir_removed ? "unavailable (project session directory is missing)" : "retained (including reports)";
				const notes = manifest.cleanup_notes?.length ? ` Notes: ${manifest.cleanup_notes.join("; ")}.` : "";
				const text = failed ? `Cleanup incomplete: ${manifest.cleanup_errors?.join("; ") || "some owned tabs remain"}. Session files retained for retry.`
					: manifest.status === "cleaned" ? `Cleanup complete. Session files ${files}.`
					: `Closed the selected tab(s); ${open} owned tab(s) remain open.${params.delete_session_files ? " Session files were kept because the run still has open tabs." : ""}`;
				return response(text + notes,
					{ ...publicManifest(manifest), tabs_closed: closed, tabs_total: manifest.pane_manifest.length, session_dir_removed: manifest.session_dir_removed ?? false, session_files_deleted: manifest.session_files_deleted ?? false }, failed,
				);
			} catch (error) { return response(errorMessage(error), { status: "error", error: errorMessage(error) }, true); }
		},
	});

	pi.registerCommand("boot", {
		description: "Bootstrap help and recent runs; /boot <task_id> shows one run's status",
		handler: async (args, ctx) => {
			const taskId = typeof args === "string" ? args.trim() : "";
			try {
				if (taskId) {
					const status = service.status(taskId, ctx.cwd);
					ctx.ui.notify(`Run ${taskId} [${status.manifest.status}/${status.manifest.phase}]\n${formatAgentStates(status.agents)}`, status.worker_errors.length || status.delivery_errors.length ? "warning" : "info");
					return;
				}
				const runs = service.store.list(8);
				ctx.ui.notify("Ask the dispatcher to bootstrap a chain or team. Tools: bootstrap_generate (dry_run first) → bootstrap_status (wait_ms) → bootstrap_report → bootstrap_cleanup. Cleanup keeps reports unless delete_session_files=true." +
					(runs.length ? `\nRecent runs (/boot <task_id> for details):\n${formatRunList(runs)}` : "\nNo recorded runs."), "info");
			} catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
		},
	});
	pi.on("session_start", async (_event, ctx) => { applyExtensionDefaults(import.meta.url, ctx); });
}
