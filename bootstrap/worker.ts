/** Child-only extension: bind the exact persona, acknowledge readiness, and persist/route results. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelMatches } from "./model-utils.ts";
import { resultFields } from "./schemas.ts";
import {
	atomicJson, delay, errorMessage, processStartTime, readJson, readyPath, resultPath,
	type BootstrapResult, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";

function looksLikeResult(input: unknown): boolean {
	const value = input as { status?: unknown; summary?: unknown; detail?: unknown } | undefined;
	return !!value && ["success", "partial", "failure"].includes(value.status as string)
		&& typeof value.summary === "string" && value.summary.length > 0 && typeof value.detail === "string";
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("bootstrap-worker-config", { description: "Bootstrap child launch configuration", type: "string" });
	let config: WorkerConfig | undefined;
	let released = false;
	let initialized = false;
	let completing = false;
	let completionRequested = false;
	let completed = false;
	let delivered = false;
	let started = false;
	let admitted = false;
	/** A specific failure was already recorded; shutdown must not replace it with a generic one. */
	let failureRecorded = false;
	/** This instance belongs to a replacement session (/new, /resume, /fork): not a bootstrap worker any more. */
	let detached = false;
	let predecessorTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	/** Toolset before bootstrap restricted it, restored if this runtime is ever reused for a replacement session. */
	let originalTools: string[] | undefined;
	/** Last observed model/tool activity: a heartbeat proves only a live event loop, this proves progress. */
	let activityAt: number | undefined;
	const markActivity = () => { if (config && released) activityAt = Date.now(); };
	for (const event of ["turn_start", "message_start", "tool_execution_start", "tool_result"] as const) pi.on(event as any, async () => { markActivity(); });
	const stopTimers = () => {
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
	};

	const errorFile = () => join(config!.session_dir, `${config!.instance_id}.error.json`);
	const recordFailure = (message: string) => {
		if (!config) return;
		failureRecorded = true;
		try { atomicJson(errorFile(), { error: message }); } catch { /* cleanup may have removed session files */ }
	};

	pi.on("session_start", async (event, ctx) => {
		const configPath = pi.getFlag("bootstrap-worker-config");
		if (typeof configPath !== "string" || !configPath) return;
		const reason = (event as { reason?: string } | undefined)?.reason;
		// The user replaced this pane's session; the old one already recorded why the bootstrap work stopped.
		if (reason === "new" || reason === "resume" || reason === "fork") {
			// Pi normally builds a fresh runtime for these, so this state is already empty. If a runtime is
			// ever reused, drop every trace of the old run so no hook injects its persona or task again.
			detached = true; stopTimers();
			if (originalTools) { try { pi.setActiveTools(originalTools); } catch { /* best effort */ } }
			config = undefined; originalTools = undefined; activityAt = undefined;
			released = initialized = completing = completionRequested = completed = delivered = started = admitted = failureRecorded = false;
			return;
		}
		try {
			config = readJson<WorkerConfig>(configPath);
			if (!config.task_id || !config.token || !/^a\d+-[a-z0-9-]+$/.test(config.instance_id)) throw new Error("Invalid bootstrap child configuration");
			const active = pi.getActiveTools();
			const registered = new Set(pi.getAllTools().map(tool => tool.name));
			for (const tool of ["coms_send", ...config.tools]) {
				if (!registered.has(tool)) throw new Error(`Required tool is unavailable: ${tool}`);
			}
			// Startup hooks run in extension order; Coms is loaded before this extension.
			const registryPath = join(config.coms_dir, "projects", config.coms_project, "agents", `${config.instance_id}.json`);
			if (!existsSync(registryPath)) throw new Error("Coms did not register the expected child identity");
			const registry = readJson<{ pid: number; name: string; session_id: string; endpoint: string; model: string }>(registryPath);
			if (registry.pid !== process.pid || registry.name !== config.instance_id || !registry.session_id || !registry.endpoint) throw new Error("Coms registry identity mismatch");
			if (!ctx.model) throw new Error("No model was resolved for the child");
			if (config.expected_model && !modelMatches(config.expected_model, `${ctx.model.provider}/${ctx.model.id}`)) throw new Error("Child model does not match the launch plan");
			originalTools = [...active];
			const tools = config.tools.length ? config.tools : active.filter(tool => !tool.startsWith("bootstrap_"));
			pi.setActiveTools([...new Set([...tools.filter(tool => !tool.startsWith("bootstrap_")), "bootstrap_complete", ...active.filter(tool => tool.startsWith("coms_"))])]);
			const ready: WorkerReady = {
				task_id: config.task_id, token: config.token, instance_id: config.instance_id,
				pid: process.pid, name: registry.name, session_id: registry.session_id, endpoint: registry.endpoint,
				model: `${ctx.model.provider}/${ctx.model.id}`, start_time: processStartTime(process.pid),
			};
			atomicJson(readyPath(config.session_dir, config.instance_id), ready);
			initialized = true;
			const deadline = Date.now() + config.ready_timeout_ms;
			while (!released) {
				if (existsSync(join(config.session_dir, "abort.json"))) throw new Error("Dispatcher aborted the bootstrap run");
				const releasePath = join(config.session_dir, "release.json");
				if (existsSync(releasePath)) {
					const release = readJson<{ task_id: string; token: string }>(releasePath);
					if (release.task_id !== config.task_id || release.token !== config.token) throw new Error("Invalid bootstrap release token");
					released = true;
					break;
				}
				if (Date.now() >= deadline) throw new Error("Dispatcher did not release the bootstrap readiness barrier");
				await delay(100);
			}
			// After a reload, durable state decides what this instance may still do; never redo finished work.
			const priorPath = resultPath(config.session_dir, config.instance_id);
			if (existsSync(priorPath)) {
				const prior = readJson<WorkerCompletion>(priorPath);
				completed = true; started = true;
				delivered = prior.delivery === "sent" || prior.delivery === "not_required";
			}
			const heartbeat = () => {
				if (!config) return;
				try { atomicJson(join(config.session_dir, `${config.instance_id}.progress.json`), { token: config.token, updated_at: Date.now(), state: completed ? "completed" : started ? "working" : "waiting", ...(activityAt ? { activity_at: activityAt } : {}) }); }
				catch { /* cleanup may have removed session files */ }
			};
			heartbeat();
			heartbeatTimer = setInterval(heartbeat, 5000); heartbeatTimer.unref?.();
			if (config.predecessor && !completed) {
				// Count inactivity, not total fleet runtime: later steps may wait for long chains.
				const waitingSince = Date.now();
				predecessorTimer = setInterval(() => {
					if (!config || completed || started) return;
					try {
						const path = resultPath(config.session_dir, config.predecessor!);
						const predecessor = existsSync(path) ? readJson<WorkerCompletion>(path) : undefined;
						if (predecessor?.result.status === "failure" && predecessor.delivery !== "sent") throw new Error(`Upstream failure: ${predecessor.result.summary}`);
						const progressPath = join(config.session_dir, `${config.predecessor}.progress.json`);
						const progress = existsSync(progressPath) ? readJson<{ token: string; updated_at: number }>(progressPath) : undefined;
						const lastActivity = predecessor ? Date.parse(predecessor.completed_at) : progress?.token === config.token ? progress.updated_at : waitingSince;
						if (Date.now() - lastActivity <= 300_000) return;
						throw new Error(`No predecessor progress or handoff from ${config.predecessor} for 300000ms`);
					} catch (error) {
						const completion: WorkerCompletion = { result: { agent_name: config.agent_name, status: "failure", summary: "Chain dependency failed", detail: errorMessage(error) }, delivery: "not_required", completed_at: new Date().toISOString() };
						try { atomicJson(resultPath(config.session_dir, config.instance_id), completion); } catch { /* project storage unavailable */ }
						completed = true; ctx.shutdown();
					}
				}, 1000);
				predecessorTimer.unref?.();
			}
		} catch (error) {
			recordFailure(errorMessage(error));
			ctx.ui.notify(`Bootstrap initialization failed: ${errorMessage(error)}`, "error");
			ctx.shutdown();
		}
	});

	pi.on("input", async (event) => {
		if (!config) return;
		if (!initialized || !released) return { action: "handled" as const };
		if (event.text !== config.startup_message) return;
		// The explicit startup message is intercepted for followers; an inbound Coms prompt activates them.
		if (config.predecessor) return { action: "handled" as const };
		return { action: "transform" as const, text: `Bootstrap task ${config.task_id}\n\n${config.sub_task}\n\nWhen finished, call bootstrap_complete with your structured result.` };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config || !released) { if (pi.getFlag("bootstrap-worker-config") && !detached) ctx.abort(); return; }
		admitted = false;
		if (delivered) { ctx.abort(); return; }
		let predecessorInput = "";
		if (config.predecessor && !completed) {
			try {
				const inbound = event.messageType === "custom" ? event.message : undefined;
				const expected = readJson<WorkerReady>(readyPath(config.session_dir, config.predecessor));
				const receiptPath = join(config.session_dir, `${config.instance_id}.handoff.json`);
				const marker = `bootstrap-handoff:${config.token}:${config.predecessor}`;
				const details = inbound?.details as { sender_session?: string } | undefined;
				if (inbound?.customType !== "coms-inbound" || details?.sender_session !== expected.session_id || typeof inbound.content !== "string" || !inbound.content.includes(marker) || existsSync(receiptPath)) {
					ctx.abort(); return;
				}
				const predecessor = readJson<WorkerCompletion>(resultPath(config.session_dir, config.predecessor));
				// Claim a logical handoff before model/tool side effects. Repeated transport messages cannot restart work.
				atomicJson(receiptPath, { task_id: config.task_id, token: config.token, predecessor: config.predecessor, sender_session: expected.session_id });
				if (predecessor.result.status === "failure") {
					atomicJson(resultPath(config.session_dir, config.instance_id), { result: { agent_name: config.agent_name, status: "failure", summary: "Chain aborted by upstream failure", detail: predecessor.result.detail }, delivery: "not_required", completed_at: new Date().toISOString() });
					completed = true; ctx.abort(); ctx.shutdown(); return;
				}
				const serialized = Buffer.from(JSON.stringify(predecessor.result), "utf8");
				// Cut on a UTF-8 character boundary (never inside a multi-byte sequence).
				let end = Math.min(serialized.length, 40_000);
				while (end < serialized.length && end > 0 && (serialized[end] & 0xc0) === 0x80) end--;
				predecessorInput = `\nPredecessor result: ${serialized.subarray(0, end).toString("utf8")}${end < serialized.length ? `\n[Truncated. Full input: ${resultPath(config.session_dir, config.predecessor)}]` : ""}\n`;
			} catch (error) {
				ctx.abort();
				recordFailure(`Chain admission failed: ${errorMessage(error)}`);
				ctx.shutdown(); return;
			}
		}
		admitted = true;
		started = true;
		activityAt = Date.now();
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		return {
			systemPrompt: `${config.persona}\n\n${event.systemPrompt}\n\n## Bootstrap execution contract\n` +
				`Run: ${config.task_id}. Persona: ${config.agent_name}. Instance: ${config.instance_id}.\n` +
				(config.task ? `Overall run task: ${config.task}\n` : "") +
				(config.roster?.length ? `Run roster (for orientation; coordination happens through bootstrap_complete):\n${config.roster.map(member => `- ${member.instance_id} (${member.agent_name})${member.step ? ` step ${member.step}` : ""}${member.instance_id === config!.instance_id ? " ← you" : ""}: ${member.sub_task}`).join("\n")}\n` : "") +
				`Your task: ${config.sub_task}\n` +
				predecessorInput +
				`Call bootstrap_complete exactly once with status, summary, detail, and optional artifacts/metrics/warnings/next_steps. ` +
				`That tool persists your result and routes chain input automatically. Do not manually forward results or wait via coms_await. ` +
				`The Coms API is request/response: coms_send({target,prompt}); coms_await({msg_id}). ` +
				`Do not call coms_send({recipient,message}) or coms_await({sender}). ` +
				`If you cannot finish, call bootstrap_complete with status failure. After completion, do not start more work.`,
		};
	});

	// shutdown() is deferred until idle. Block queued/parallel work after completion or rejected admission.
	pi.on("tool_call", async (event) => {
		if (!config) return pi.getFlag("bootstrap-worker-config") && !detached ? { block: true, reason: "Bootstrap worker is initializing" } : undefined;
		const internalHandoff = completing && event.parentToolCallId && event.toolName === "coms_send";
		if (!released || (!admitted && !internalHandoff) || ((completed || completionRequested) && event.toolName !== "bootstrap_complete" && !internalHandoff)) {
			return { block: true, reason: "Bootstrap worker has no admitted work or has already completed" };
		}
		// Only a well-formed completion locks the toolset; a malformed call is rejected and the work goes on.
		if (event.toolName === "bootstrap_complete" && looksLikeResult(event.input)) completionRequested = true;
	});

	pi.registerTool({
		name: "bootstrap_complete", label: "Bootstrap Complete",
		description: "Persist your final structured result and automatically route it to the next chain agent. Use only when your assigned task is finished.",
		parameters: Type.Object(resultFields),
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (!config || !released) { completionRequested = completed; throw new Error("Bootstrap worker is not ready"); }
			if (delivered) return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
			if (completing) throw new Error("Completion is already in progress");
			completing = true;
			try {
				const path = resultPath(config.session_dir, config.instance_id);
				// Retrying a failed delivery must not replace the original result or create a second completion.
				const existing = existsSync(path) ? readJson<WorkerCompletion>(path) : undefined;
				if (existing && (existing.delivery === "sent" || existing.delivery === "not_required")) {
					completed = true; delivered = true; ctx.shutdown();
					return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
				}
				const result: BootstrapResult = existing?.result ?? { ...params, agent_name: config.agent_name } as BootstrapResult;
				const completion: WorkerCompletion = { result, delivery: "pending", completed_at: existing?.completed_at ?? new Date().toISOString() };
				atomicJson(path, completion);
				completed = true;
				if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
				const successor = config.successor;
				if (successor) {
					const ready = readJson<WorkerReady>(readyPath(config.session_dir, successor));
					if (ready.task_id !== config.task_id || ready.token !== config.token || ready.instance_id !== successor) throw new Error("Successor readiness identity mismatch");
					const response = await ctx.executeTool("coms_send", {
						target: ready.session_id,
						prompt: `bootstrap-handoff:${config.token}:${config.instance_id}\nRun: ${config.task_id}. Predecessor result reference: ${path}\n${result.status === "failure" ? "The chain is aborted." : "Perform your assigned task using the durable predecessor input, then call bootstrap_complete."}`,
					}, { signal });
					if (response.isError) throw new Error(response.content.map(part => part.type === "text" ? part.text : "").join("\n"));
					completion.delivery = "sent";
				} else {
					// The durable result is authoritative; dispatcher messaging is optional and never required for collection.
					completion.delivery = "not_required";
				}
				atomicJson(path, completion);
				delivered = true;
				ctx.shutdown();
				return { content: [{ type: "text", text: "Result persisted; chain handoff complete." }], details: { status: "saved" } };
			} catch (error) {
				// Nothing was persisted: the worker may keep working instead of being locked out of its tools.
				if (!completed) completionRequested = false;
				const path = resultPath(config.session_dir, config.instance_id);
				if (existsSync(path)) {
					const completion = readJson<WorkerCompletion>(path);
					completion.delivery = "failed"; completion.delivery_error = errorMessage(error); atomicJson(path, completion);
				}
				return { isError: true, content: [{ type: "text", text: `Result retained, but chain delivery failed: ${errorMessage(error)}. You may retry bootstrap_complete.` }], details: { status: "error" } };
			} finally { completing = false; }
		},
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!config || !released || !started || !admitted || completed) return;
		recordFailure(event.aborted ? "Worker was aborted before recording a result" : "Worker settled without calling bootstrap_complete");
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (event) => {
		stopTimers();
		if (!config || !initialized || completed || failureRecorded || event.reason === "reload") return;
		// Keep a more specific error written earlier (possibly by a previous instance before a reload).
		if (existsSync(errorFile())) return;
		recordFailure(event.reason === "new" || event.reason === "resume" || event.reason === "fork"
			? `Worker session was replaced (/${event.reason}) before recording a result`
			: "Worker exited before recording a result");
	});
}
