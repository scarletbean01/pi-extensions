/** Child-only extension: bind the exact persona, acknowledge readiness, and persist/route results. */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelMatches } from "./model-utils.ts";
import { resultFields } from "./schemas.ts";
import {
	atomicJson, completionRecord, delay, errorMessage, nodeIdentity, parseCompletion, parseWorkerConfig, processStartTime, readJson, readyPath, resultPath,
	type BootstrapResult, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import {
	canonicalJson, enrichArtifactsWithProvenance, formatAuthoritativeBrief, formatPeerDataSection, parseTaskInput, readBoundedInput, readUpstreamIndex, sha256Text, taskInputPath, upsertUpstreamIndex,
	validateOutputContract, validateUpstreamAdmission,
	type TaskInputRecord, type UpstreamIndex,
} from "./contracts.ts";
import {
	beginVerificationCheck, evaluateNodeVerification, finishVerificationCheck, runVerificationCommand,
	type StartedVerificationCheck,
} from "./verification.ts";

function looksLikeResult(input: unknown): boolean {
	const value = input as { status?: unknown; summary?: unknown; detail?: unknown } | undefined;
	return !!value && ["success", "partial", "failure"].includes(value.status as string)
		&& typeof value.summary === "string" && value.summary.length > 0 && typeof value.detail === "string";
}

/** What this worker's own result file must say about itself. */
const ownExpectation = (config: WorkerConfig) => ({ run_id: config.task_id, instance_id: config.instance_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id });
/** What the predecessor's result file must say; the roster (when present) says which node and persona it is. */
function predecessorExpectation(config: WorkerConfig) {
	const member = config.roster?.find(member => member.instance_id === config.predecessor);
	return { run_id: config.task_id, instance_id: config.predecessor!, node_id: member?.node_id, persona_name: member?.persona_name };
}
/** The identities the model is told it runs under. Version 1 configurations predate nodes and attempts. */
const identityLine = (config: WorkerConfig) => `Run: ${config.task_id}. ${config.version === 1 ? "" : `Node: ${config.node_id}. `}Persona: ${config.persona_name}. ${config.attempt_id ? `Attempt: ${config.attempt_id}. ` : ""}Instance: ${config.instance_id}.`;

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
	const pendingChecks = new Map<string, StartedVerificationCheck>();
	const markActivity = () => { if (config && released) activityAt = Date.now(); };
	for (const event of ["turn_start", "message_start", "tool_execution_start", "tool_result"] as const) pi.on(event as any, async () => { markActivity(); });
	const stopTimers = () => {
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
	};

	const errorFile = () => join(config!.session_dir, `${config!.instance_id}.error.json`);
	/** Written when the user replaces this worker's session, so a later /reload of the replacement never revives the worker role. */
	const detachedFile = (cfg: WorkerConfig) => join(cfg.session_dir, `${cfg.instance_id}.detached.json`);
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
			detached = true; stopTimers(); pendingChecks.clear();
			if (originalTools) { try { pi.setActiveTools(originalTools); } catch { /* best effort */ } }
			config = undefined; originalTools = undefined; activityAt = undefined;
			released = initialized = completing = completionRequested = completed = delivered = started = admitted = failureRecorded = false;
			return;
		}
		try {
			const rawConfig = readJson<{ instance_id?: unknown; session_dir?: unknown }>(configPath);
			try { config = parseWorkerConfig(rawConfig); }
			catch (error) {
			// Nothing identifies this worker for certain, but when the file names its own instance the dispatcher should still hear why it never became ready.
			if (typeof rawConfig?.instance_id === "string" && typeof rawConfig.session_dir === "string" && /^a\d+-[a-z0-9-]+$/.test(rawConfig.instance_id)) {
			try { atomicJson(join(rawConfig.session_dir, `${rawConfig.instance_id}.error.json`), { error: errorMessage(error) }); failureRecorded = true; } catch { /* session files unavailable */ }
			}
			throw error;
			}
			if (!config.task_id || !config.token || !/^a\d+-[a-z0-9-]+$/.test(config.instance_id)) throw new Error("Invalid bootstrap child configuration");
			// The flag outlives /new, /resume and /fork: a reload of the replacement session is still not this run's worker.
			try {
				if (readJson<{ token?: string }>(detachedFile(config)).token === config.token) { detached = true; config = undefined; return; }
			} catch { /* never replaced */ }
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
			pi.setActiveTools([...new Set([...tools.filter(tool => !tool.startsWith("bootstrap_")), "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify", ...active.filter(tool => tool.startsWith("coms_"))])]);
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
				const prior = parseCompletion(readJson<unknown>(priorPath), ownExpectation(config));
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
						const predecessor = existsSync(path) ? parseCompletion(readJson<unknown>(path), predecessorExpectation(config)) : undefined;
						if (predecessor?.result.status === "failure" && predecessor.delivery !== "sent") throw new Error(`Upstream failure: ${predecessor.result.summary}`);
						const progressPath = join(config.session_dir, `${config.predecessor}.progress.json`);
						const progress = existsSync(progressPath) ? readJson<{ token: string; updated_at: number }>(progressPath) : undefined;
						const lastActivity = predecessor ? Date.parse(predecessor.completed_at) : progress?.token === config.token ? progress.updated_at : waitingSince;
						if (Date.now() - lastActivity <= 300_000) return;
						throw new Error(`No predecessor progress or handoff from ${config.predecessor} for 300000ms`);
					} catch (error) {
						const completion = completionRecord(config, { status: "failure", summary: "Chain dependency failed", detail: errorMessage(error) } as BootstrapResult, "not_required", new Date().toISOString());
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
		let taskInput: TaskInputRecord | undefined;
		const inputFile = taskInputPath(config.session_dir, config.instance_id);
		if (existsSync(inputFile)) {
			try {
				taskInput = parseTaskInput(readJson<unknown>(inputFile), ownExpectation(config));
			} catch (error) {
				ctx.abort();
				recordFailure(`Task input validation failed: ${errorMessage(error)}`);
				ctx.shutdown(); return;
			}
		}
		let upstreamIndex: UpstreamIndex | undefined;
		try {
			upstreamIndex = readUpstreamIndex(config.session_dir, config.task_id);
		} catch (error) {
			ctx.abort();
			recordFailure(`Upstream index validation failed: ${errorMessage(error)}`);
			ctx.shutdown(); return;
		}
		let predecessorResult: BootstrapResult | undefined;
		let predecessorPath: string | undefined;
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
				predecessorPath = resultPath(config.session_dir, config.predecessor);
				const predecessor = parseCompletion(readJson<unknown>(predecessorPath), predecessorExpectation(config));
				const admissionBlockers = validateUpstreamAdmission({ config, predecessor, upstreamIndex });
				if (admissionBlockers.length) {
					throw new Error(admissionBlockers.join("; "));
				}
				// Claim a logical handoff before model/tool side effects. Repeated transport messages cannot restart work.
				atomicJson(receiptPath, { task_id: config.task_id, token: config.token, predecessor: config.predecessor, sender_session: expected.session_id });
				if (predecessor.result.status === "failure") {
					atomicJson(resultPath(config.session_dir, config.instance_id), completionRecord(config, { status: "failure", summary: "Chain aborted by upstream failure", detail: predecessor.result.detail } as BootstrapResult, "not_required", new Date().toISOString()));
					completed = true; ctx.abort(); ctx.shutdown(); return;
				}
				predecessorResult = predecessor.result;
			} catch (error) {
				ctx.abort();
				recordFailure(`Chain admission failed: ${errorMessage(error)}`);
				ctx.shutdown(); return;
			}
		}
		const peerData = formatPeerDataSection({ config, predecessorResult, predecessorPath, upstreamIndex });
		admitted = true;
		started = true;
		activityAt = Date.now();
		if (predecessorTimer) { clearInterval(predecessorTimer); predecessorTimer = undefined; }
		if (completed) {
			// The result is already durable (e.g. after a /reload with a failed handoff): only delivery can still be retried.
			return {
				systemPrompt: `${config.persona}\n\n${event.systemPrompt}\n\n## Bootstrap execution contract\n` +
					`${identityLine(config)}\n` +
					`Your task is already finished and its result is saved. Do not redo or continue the work and do not use other tools. ` +
					`If delivery to the next agent failed, call bootstrap_complete again with your original status, summary and detail; the saved result is kept and only the handoff is retried.`,
			};
		}
		return {
			systemPrompt: `${config.persona}\n\n${event.systemPrompt}\n\n## Bootstrap execution contract — Authoritative assignment instructions\n` +
				`${identityLine(config)}\n` +
				formatAuthoritativeBrief(config, taskInput) +
				`Call bootstrap_complete exactly once with status, summary, detail, and optional outputs/artifacts/metrics/warnings/next_steps. ` +
				`That tool persists your result and routes chain input automatically. Do not manually forward results or wait via coms_await. ` +
				`The Coms API is request/response: coms_send({target,prompt}); coms_await({msg_id}). ` +
				`Do not call coms_send({recipient,message}) or coms_await({sender}). ` +
				`If you cannot finish, call bootstrap_complete with status failure. After completion, do not start more work.` +
				peerData,
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
		description: "Persist your final structured result and automatically route it to the next chain agent. Use only when your assigned task is finished. If the handoff fails, the result stays saved: call it again to retry delivery only (the saved result is never replaced).",
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
				const existing = existsSync(path) ? parseCompletion(readJson<unknown>(path), ownExpectation(config)) : undefined;
				if (existing && (existing.delivery === "sent" || existing.delivery === "not_required")) {
					completed = true; delivered = true; ctx.shutdown();
					return { content: [{ type: "text", text: "Result already persisted and delivered." }], details: { status: "saved" } };
				}
				const rawResult = existing?.result ?? { ...params, agent_name: config.persona_name } as BootstrapResult;
				const enrichedArtifacts = existing?.result
					? rawResult.artifacts
					: enrichArtifactsWithProvenance(rawResult.artifacts, config.project_cwd, config.session_dir, {
						node_id: config.node_id,
						attempt_id: config.attempt_id ?? config.instance_id,
						instance_id: config.instance_id,
					});
				const result: BootstrapResult = enrichedArtifacts !== undefined
					? { ...rawResult, artifacts: enrichedArtifacts }
					: rawResult;
				if (!existing && result.status !== "failure") {
					const blockers: string[] = [];
					if (config.output_contract) {
						blockers.push(...validateOutputContract(config.output_contract, result, config.project_cwd, config.session_dir));
					}
					const requiredChecks = [...new Set([...(config.required_checks ?? []), ...(config.output_contract?.required_checks ?? [])])];
					if (requiredChecks.length || existsSync(join(config.session_dir, `${config.instance_id}.verification.json`))) {
						const ver = evaluateNodeVerification(config.session_dir, config.instance_id, config.project_cwd, requiredChecks, config.task_id);
						blockers.push(...ver.blockers);
						if (ver.summaries.length && !blockers.length) result.verification = ver.summaries;
					}
					if (blockers.length) {
						completionRequested = false;
						return { isError: true, content: [{ type: "text", text: `Output/verification contract validation failed: ${blockers.join("; ")}` }], details: { status: "error", blockers } };
					}
				}
				const completion = completionRecord(config, result, "pending", existing?.completed_at ?? new Date().toISOString());
				atomicJson(path, completion);
				if (config.version !== 1 && existsSync(join(config.session_dir, "upstream-index.json"))) {
					await upsertUpstreamIndex(config.session_dir, config.task_id, {
						node_id: config.node_id,
						persona_name: config.persona_name,
						attempt_id: config.attempt_id ?? config.instance_id,
						instance_id: config.instance_id,
						...(config.step !== undefined ? { step: config.step } : {}),
						status: completion.result.status,
						summary: completion.result.summary,
						completed_at: completion.completed_at,
						result_path: path,
						result_hash: sha256Text(canonicalJson(completion.result)),
						...(completion.result.outputs ? { outputs: completion.result.outputs } : {}),
						...(completion.result.artifacts ? { artifacts: completion.result.artifacts } : {}),
						...(completion.result.verification ? { verification: completion.result.verification } : {}),
					});
				}
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

	pi.registerTool({
		name: "bootstrap_read_input",
		label: "Bootstrap Read Input",
		description: "Retrieve full bounded slices of your immutable task input, the upstream-results index, an earlier stage's full result, or a verified upstream file artifact.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("task_input"), Type.Literal("upstream_index"), Type.Literal("result"), Type.Literal("artifact")]),
			node_id: Type.Optional(Type.String({ description: "Target node_id or instance_id (required for kind=\"result\", optional for kind=\"artifact\" hash verification)" })),
			path: Type.Optional(Type.String({ description: "Artifact path relative to project_cwd (required for kind=\"artifact\")" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-8 byte offset (default 0)" })),
			max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536, description: "Max bytes to return (default 32768, max 65536)" })),
		}),
		async execute(_id, params) {
			if (!config || !released || !admitted) throw new Error("Bootstrap worker is not admitted");
			try {
				const data = readBoundedInput({
					config,
					kind: params.kind,
					node_id: params.node_id,
					path: params.path,
					offset: params.offset,
					max_bytes: params.max_bytes,
				});
				const meta = `[source: ${data.source}; offset ${data.offset}-${data.next_offset} of ${data.totalBytes} bytes${data.truncated ? `; truncated — pass offset=${data.next_offset} for next chunk` : ""}]`;
				return {
					content: [{ type: "text", text: `${meta}\n${data.text}` }],
					details: data,
				};
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: errorMessage(error) }], details: { status: "error", error: errorMessage(error) } };
			}
		},
	});

	pi.registerTool({
		name: "bootstrap_verify",
		label: "Bootstrap Verify",
		description: "Record or run a verification check with before/after repository content snapshots (including untracked files). Historical checks are preserved; edits during or after a check mark applicability stale.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("finish"), Type.Literal("run"), Type.Literal("status")]),
			check_id: Type.Optional(Type.String({ description: "Check identifier (required for start, finish, run)" })),
			scope: Type.Optional(Type.Array(Type.String(), { description: "Optional reliable relative paths/globs for this check; omit for conservative full-project snapshot" })),
			result: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("error")], { description: "Check outcome (required for finish)" })),
			command: Type.Optional(Type.String({ description: "Shell command (only for action=\"run\" when bash is allowed)" })),
			detail: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			if (!config || !released || !admitted) throw new Error("Bootstrap worker is not admitted");
			try {
				const identity = {
					run_id: config.task_id,
					node_id: config.node_id,
					persona_name: config.persona_name,
					attempt_id: config.attempt_id ?? config.instance_id,
					instance_id: config.instance_id,
				};
				if (params.action === "status") {
					const ev = evaluateNodeVerification(config.session_dir, config.instance_id, config.project_cwd, config.required_checks, config.task_id);
					return { content: [{ type: "text", text: JSON.stringify(ev, null, 2) }], details: ev };
				}
				if (!params.check_id?.trim()) throw new Error("check_id is required");
				if (params.action === "start") {
					const started = beginVerificationCheck(config.project_cwd, params.check_id.trim(), params.scope);
					pendingChecks.set(params.check_id.trim(), started);
					return {
						content: [{ type: "text", text: `Started verification check "${started.check_id}" (${started.scope_kind} scope, ${Object.keys(started.before_snapshot.files).length} files snapshotted).` }],
						details: { status: "started", check_id: started.check_id, scope_kind: started.scope_kind, files: Object.keys(started.before_snapshot.files).length },
					};
				}
				if (params.action === "finish") {
					if (!params.result) throw new Error("result is required for action=\"finish\"");
					const started = pendingChecks.get(params.check_id.trim());
					if (!started) throw new Error(`No started verification check found for "${params.check_id}"`);
					pendingChecks.delete(params.check_id.trim());
					const finished = finishVerificationCheck(config.session_dir, identity, started, {
						result: params.result,
						detail: params.detail,
						name: params.name,
					});
					return {
						content: [{ type: "text", text: `Verification "${finished.record.check_id}" recorded: result=${finished.record.result}, applicability=${finished.applicability}${finished.reason ? ` (${finished.reason})` : ""}.` }],
						details: finished,
					};
				}
				if (params.action === "run") {
					if (config.tools.length > 0 && !config.tools.includes("bash")) {
						throw new Error("Verification command execution requires bash tool permission");
					}
					if (!params.command?.trim()) throw new Error("command is required for action=\"run\"");
					const ran = await runVerificationCommand({
						sessionDir: config.session_dir,
						projectCwd: config.project_cwd,
						identity,
						checkId: params.check_id.trim(),
						command: params.command,
						scope: params.scope,
						name: params.name,
					});
					return {
						content: [{ type: "text", text: `Verification "${ran.record.check_id}" ran: result=${ran.record.result}, applicability=${ran.applicability}${ran.reason ? ` (${ran.reason})` : ""}.` }],
						details: ran,
					};
				}
				throw new Error(`Unsupported verification action: ${String(params.action)}`);
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: errorMessage(error) }], details: { status: "error", error: errorMessage(error) } };
			}
		},
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!config || !released || !started || !admitted || completed) return;
		recordFailure(event.aborted ? "Worker was aborted before recording a result" : "Worker settled without calling bootstrap_complete");
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (event) => {
		stopTimers();
		const replaced = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		if (config && initialized && replaced) {
			try { atomicJson(detachedFile(config), { task_id: config.task_id, token: config.token, reason: event.reason, detached_at: new Date().toISOString() }); } catch { /* cleanup may have removed session files */ }
		}
		if (!config || !initialized || completed || failureRecorded || event.reason === "reload") return;
		// Keep a more specific error written earlier (possibly by a previous instance before a reload).
		if (existsSync(errorFile())) return;
		recordFailure(replaced
			? `Worker session was replaced (/${event.reason}) before recording a result`
			: "Worker exited before recording a result");
	});
}
