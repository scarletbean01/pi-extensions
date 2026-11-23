/** Deterministic non-model runner for `kind: "command"` nodes. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	claimOutcome, DEFAULT_CANCEL_GRACE_MS, DEFAULT_DEPENDENCY_WAIT_MS, HEARTBEAT_STALE_MS, humanWaitStartedAt,
	readCancelRecordSafe, readOutcomeClaimSafe, readRunCancelRecordSafe, writeCancelRecord,
	type CancelIdentity, type ProgressSnapshot,
} from "./cancellation.ts";
import {
	enrichArtifactsWithProvenance, parseTaskInput, readUpstreamIndex, resultHash, taskInputPath,
	upstreamIndexPath, upsertUpstreamIndex, validateArtifactHashes, validateOutputContract, validateUpstreamAdmission,
	type ArtifactMetadata, type TaskInputRecord, type UpstreamIndex,
} from "./contracts.ts";
import { requiredChecksOf } from "./evidence.ts";
import {
	claimHandoff, claimJoinHandoff, evaluateHandoff, evaluateJoinHandoff, handoffClaimPath, handoffNotification,
	handoffOfferPath, handoffSourceScope, inputDigest, isLegacyClaim, markHandoffQueued, offerHandoff,
	parseHandoffClaim, parseHandoffOffer, parseJoinHandoffClaim, recordHandoffRejection, reviewDeliveryClaimed,
	type HandoffOffer,
} from "./handoff.ts";
import {
	activeKey, admission, admissionForEdge, evaluateJoinAdmission, executionOf, graphAncestors, graphPredecessors,
	isManagedWorker, ownExpectation, ownershipExpectation, ownLoop, predecessorExpectation, predecessorKey,
	predecessorNode, predecessorRecord, requireManagedTaskInput, sourceExpectation, sourceKey, sourceNode,
	sourceRecord, verifyFactoryReleaseAuthority,
} from "./node-admission.ts";
import { executionFromResult, type CauseRef, type DispositionState } from "./outcomes.ts";
import {
	evaluateOwnershipDependencies, ownershipPath, ownershipRecord, parseOwnershipRecord, publishFailFast, readFailFast,
	type OwnershipState,
} from "./ownership.ts";
import {
	attemptKey, attemptNumber, blockedReviewForwardEdge, deadLoopMembers, finalizeMemberAfterDecision, finalizeReview,
	readFinalization, reserveRevision, reviewLoopFor, reviewRoutes, reviewVerdict, settleReviewFailure,
} from "./review-loop.ts";
import {
	atomicJson, commandProcessGroupPath, completionRecord, delay, dispositionPath, dispositionRecord, errorMessage,
	failurePolicyOf, inboundEdgesOf, isRecord, killProcessGroup, parseCommandProcessGroupRecord, parseCompletion, parseDisposition, parseWorkerConfig,
	parseWorkerReady, pathEntryExists, processAlive, processGroupAlive, processStartTime, publishExclusive, readJson, readRegularJsonNoSymlink,
	readyPath, resolveCommandWorkingDirectory, resultPath, validateCommandArgs, validateCommandString,
	type BootstrapResult, type CommandEvidence, type CommandProcessGroupRecord, type Disposition,
	type EdgeDeliveryState, type WorkerCompletion, type WorkerConfig, type WorkerReady,
} from "./session-store.ts";
import { evaluateNodeVerification } from "./verification.ts";

const MAX_STDOUT_CAPTURE_BYTES = 512 * 1024;
const MAX_EXCERPT_CHARS = 1000;

interface InboundComsMessage {
	sender_session?: string;
	content: string;
}

export interface CommandDriverOptions {
	skipComsServer?: boolean;
	sessionId?: string;
	sendComs?: (targetSession: string, prompt: string) => Promise<{ delivered: boolean; error?: string; msgId?: string }>;
	onShutdown?: () => void;
	pollMs?: number;
	killProcessGroup?: (pgid: number, graceMs: number, leaderStartTime?: string) => Promise<boolean>;
	processGroupAlive?: (pgid: number, leaderStartTime?: string) => boolean;
	writeProcessGroup?: (path: string, text: string, durable: boolean) => boolean;
	beforeOutcomeClaim?: () => void;
}

const ALLOWED_COMMAND_ENV_VARS = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ",
	"TMPDIR", "TMP", "TEMP", "PWD", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const ALLOWED_COMMAND_ENV_PREFIXES = ["LC_", "XDG_"];

export function buildCommandEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value === undefined) continue;
		if (ALLOWED_COMMAND_ENV_VARS.has(key) || ALLOWED_COMMAND_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

function clipExcerpt(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= MAX_EXCERPT_CHARS ? trimmed : `${trimmed.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

async function sendViaUnixComs(
	config: WorkerConfig,
	senderSessionId: string,
	senderEndpoint: string,
	targetSessionOrInstance: string,
	prompt: string,
): Promise<{ delivered: boolean; error?: string; msgId?: string }> {
	const agentsDir = join(config.coms_dir, "projects", config.coms_project, "agents");
	let targetEndpoint: string | undefined;
	if (existsSync(join(agentsDir, `${targetSessionOrInstance}.json`))) {
		try {
			targetEndpoint = readJson<{ endpoint?: string }>(join(agentsDir, `${targetSessionOrInstance}.json`)).endpoint;
		} catch { /* fallback scan */ }
	}
	if (!targetEndpoint && existsSync(agentsDir)) {
		for (const file of readdirSync(agentsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const rec = readJson<{ session_id?: string; name?: string; endpoint?: string }>(join(agentsDir, file));
				if (rec.session_id === targetSessionOrInstance || rec.name === targetSessionOrInstance) {
					targetEndpoint = rec.endpoint;
					break;
				}
			} catch { /* continue */ }
		}
	}
	if (!targetEndpoint || !existsSync(targetEndpoint)) {
		return { delivered: false, error: `Coms endpoint unavailable for ${targetSessionOrInstance}` };
	}
	const msgId = `cmd-${randomUUID()}`;
	return await new Promise(resolveSend => {
		const socket = createConnection(targetEndpoint!);
		let buffer = "";
		let settled = false;
		const finish = (res: { delivered: boolean; error?: string; msgId?: string }) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolveSend(res);
		};
		socket.setTimeout(5000, () => finish({ delivered: false, error: "Coms send timed out" }));
		socket.on("error", err => finish({ delivered: false, error: errorMessage(err) }));
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			for (const line of buffer.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as { type?: string; error?: string };
					if (parsed.type === "ack") finish({ delivered: true, msgId });
					else if (parsed.type === "nack") finish({ delivered: false, error: parsed.error ?? "rejected" });
				} catch { /* wait for full line */ }
			}
		});
		socket.on("connect", () => {
			socket.write(JSON.stringify({
				type: "prompt",
				msg_id: msgId,
				sender_session: senderSessionId,
				sender_endpoint: senderEndpoint,
				sender_name: config.instance_id,
				sender_cwd: config.project_cwd,
				hops: 0,
				timestamp: new Date().toISOString(),
				prompt,
			}) + "\n");
		});
	});
}

function discoverDeclaredArtifacts(
	contract: WorkerConfig["output_contract"] | undefined,
	projectCwd: string,
	sessionDir: string,
): ArtifactMetadata[] | undefined {
	if (!contract?.required_artifact_paths?.length) return undefined;
	const realProject = realpathSync(projectCwd);
	const realSession = existsSync(sessionDir) ? realpathSync(sessionDir) : undefined;
	const found: ArtifactMetadata[] = [];
	for (const reqPath of contract.required_artifact_paths) {
		const resolved = resolve(projectCwd, reqPath);
		if (!existsSync(resolved)) continue;
		try {
			const stat = statSync(resolved);
			if (!stat.isFile()) continue;
			const realTarget = realpathSync(resolved);
			const inProject = realTarget === realProject || realTarget.startsWith(realProject === "/" ? "/" : `${realProject}/`);
			const inSession = realSession !== undefined && (realTarget === realSession || realTarget.startsWith(`${realSession}/`));
			if (!inProject && !inSession) continue;
			found.push({ type: "file", path: reqPath, action: "created" });
		} catch { /* ignore unreadable path */ }
	}
	return found.length ? found : undefined;
}

function parseCommandResultFromStdout(
	stdout: string,
	config: WorkerConfig,
	evidence: CommandEvidence,
): BootstrapResult {
	const trimmed = stdout.trim();
	let summary = `Command ${config.command} exited with code 0`;
	let detail = clipExcerpt(stdout) ?? `Command ${config.command} succeeded with no output.`;
	let outputs: Record<string, unknown> | undefined;
	let artifacts: ArtifactMetadata[] | undefined;
	let metrics: Record<string, number> | undefined;
	let warnings: string[] | undefined;
	let next_steps: string[] | undefined;
	let declaredStatus: BootstrapResult["status"] | undefined;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isRecord(parsed)) {
				const looksEnvelope = ("outputs" in parsed && isRecord(parsed.outputs))
					|| ("status" in parsed && ["success", "partial", "failure"].includes(String(parsed.status)) && typeof parsed.summary === "string");
				if (looksEnvelope) {
					if (parsed.status === "success" || parsed.status === "partial" || parsed.status === "failure") {
						declaredStatus = parsed.status;
					}
					if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary;
					if (typeof parsed.detail === "string") detail = parsed.detail;
					if (isRecord(parsed.outputs)) outputs = parsed.outputs;
					if (Array.isArray(parsed.artifacts)) artifacts = parsed.artifacts as ArtifactMetadata[];
					if (isRecord(parsed.metrics)) metrics = parsed.metrics as Record<string, number>;
					if (Array.isArray(parsed.warnings)) warnings = parsed.warnings as string[];
					if (Array.isArray(parsed.next_steps)) next_steps = parsed.next_steps as string[];
				} else {
					outputs = parsed;
				}
			}
		} catch {
			// Non-JSON stdout is allowed if no structured contract requires JSON fields.
		}
	}

	if (artifacts === undefined) {
		artifacts = discoverDeclaredArtifacts(config.output_contract, config.project_cwd, config.session_dir);
	}

	const enrichedArtifacts = enrichArtifactsWithProvenance(artifacts, config.project_cwd, config.session_dir, {
		node_id: config.node_id,
		attempt_id: config.attempt_id ?? config.instance_id,
		instance_id: config.instance_id,
	});

	const candidate: BootstrapResult = {
		agent_name: config.persona_name,
		node_id: config.node_id,
		status: declaredStatus && declaredStatus !== "success" ? "failure" : "success",
		summary,
		detail,
		...(enrichedArtifacts !== undefined ? { artifacts: enrichedArtifacts } : {}),
		...(outputs !== undefined ? { outputs } : {}),
		...(metrics !== undefined ? { metrics } : {}),
		...(warnings !== undefined ? { warnings } : {}),
		...(next_steps !== undefined ? { next_steps } : {}),
		command_evidence: evidence,
	};

	if (candidate.status === "success") {
		const blockers: string[] = [];
		if (config.output_contract) {
			blockers.push(...validateOutputContract(config.output_contract, candidate, config.project_cwd, config.session_dir));
		}
		blockers.push(...validateArtifactHashes(candidate.artifacts, config.project_cwd, config.session_dir, config.node_id));
		const requiredChecks = requiredChecksOf(config);
		if (requiredChecks.length || existsSync(join(config.session_dir, `${activeKey(config)}.verification.json`))) {
			const ver = evaluateNodeVerification(config.session_dir, config.instance_id, config.project_cwd, requiredChecks, config.task_id, activeKey(config));
			blockers.push(...ver.blockers);
			if (ver.summaries.length && !blockers.length) candidate.verification = ver.summaries;
		}
		if (blockers.length) {
			candidate.status = "failure";
			candidate.summary = `Command exited 0 but failed contract/verification: ${blockers.join("; ")}`;
			candidate.detail = `${candidate.summary}\n${detail}`;
		}
	} else {
		candidate.summary = `Command exited 0 with non-success status (${declaredStatus})`;
	}

	return candidate;
}

export function createCommandDriver(configPath: string, options: CommandDriverOptions = {}) {
	let config = parseWorkerConfig(readJson<unknown>(configPath));
	if (config.kind !== "command") {
		throw new Error(`command-runner refuses non-command node ${config.node_id} (kind: ${config.kind ?? "agent"})`);
	}

	const sessionId = options.sessionId ?? (options.skipComsServer ? `session-${config.instance_id}` : `session-${config.instance_id}-${randomUUID().slice(0, 8)}`);
	let socketPath = "/tmp/fake-coms";
	let server: Server | undefined;
	let registryPath: string | undefined;

	let authoritativeBrief: { taskId: string; text: string; digest: string } | undefined;
	let released = false;
	let started = false;
	let completed = false;
	let holdForAttention = false;
	let ownershipAdmitted = false;
	let startedAt: number | undefined;
	let activityAt: number | undefined;
	let activeChild: ChildProcess | undefined;
	let activeChildPgid: number | undefined;
	let activeChildPgStartTime: string | undefined;
	let childCancelPromise: Promise<void> | undefined;
	let activeShutdownPromise: Promise<void> | undefined;
	let stopped = false;

	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let cancelTimer: ReturnType<typeof setInterval> | undefined;
	let ownershipTimer: ReturnType<typeof setInterval> | undefined;
	let predecessorTimer: ReturnType<typeof setInterval> | undefined;

	const joinWakeSources = new Set<string>();
	const sent: Array<{ name: string; params: { target: string; prompt: string } }> = [];

	let settledResolve!: () => void;
	const settledPromise = new Promise<void>(resolveSettled => { settledResolve = resolveSettled; });
	const settleNow = () => {
		stopTimers();
		closeComsServer();
		options.onShutdown?.();
		settledResolve();
	};

	const stopTimers = () => {
		for (const timer of [heartbeatTimer, cancelTimer, ownershipTimer, predecessorTimer]) {
			if (timer) clearInterval(timer);
		}
		heartbeatTimer = cancelTimer = ownershipTimer = predecessorTimer = undefined;
	};

	const closeComsServer = () => {
		if (server) {
			try { server.close(); } catch { /* ignore */ }
			server = undefined;
		}
		if (socketPath.startsWith(tmpdir()) && socketPath.endsWith(".sock")) {
			try { rmSync(socketPath, { force: true }); } catch { /* ignore */ }
		}
		if (registryPath) {
			try { rmSync(registryPath, { force: true }); } catch { /* ignore */ }
			registryPath = undefined;
		}
	};

	const pollIntervalMs = options.pollMs ?? 50;
	const killPg = options.killProcessGroup ?? killProcessGroup;
	const pgAlive = options.processGroupAlive ?? processGroupAlive;
	const writePg = options.writeProcessGroup ?? publishExclusive;
	const inboundSources = inboundEdgesOf(config);

	const progressFile = () => join(config.session_dir, `${config.instance_id}.progress.json`);
	const errorFile = (cfg = config) => join(cfg.session_dir, `${activeKey(cfg)}.error.json`);
	const cancelIdentity = (cfg = config): CancelIdentity => ({
		run_id: cfg.task_id,
		node_id: cfg.node_id,
		persona_name: cfg.persona_name,
		attempt_id: cfg.attempt_id,
		instance_id: cfg.instance_id,
	});

	const readCancellation = (cfg = config): { cancelled: boolean; reason?: string; error?: string } => {
		const ff = readFailFast(cfg.session_dir, cfg.task_id, cfg.token);
		if (ff.error) return { cancelled: false, error: ff.error };
		const node = readCancelRecordSafe(cfg.session_dir, cancelIdentity(cfg));
		if (node.error) return { cancelled: false, error: node.error };
		if (node.record) return { cancelled: true, reason: node.record.reason };
		const run = readRunCancelRecordSafe(cfg.session_dir, cfg.task_id, cfg.token);
		if (run.error) return { cancelled: false, error: run.error };
		if (run.record) return { cancelled: true, reason: run.record.reason };
		if (ff.record && ff.record.cause.instance_id !== cfg.instance_id) {
			return { cancelled: true, reason: `Cancelled by fail-fast policy after ${ff.record.cause.node_id} failed: ${ff.record.cause.reason}` };
		}
		return { cancelled: false };
	};

	const readOutcomeClaim = (cfg = config) =>
		readOutcomeClaimSafe(cfg.session_dir, { ...cancelIdentity(cfg), attempt_id: cfg.attempt_id }, activeKey(cfg));

	const heartbeat = (cfg = config) => {
		if (stopped) return;
		const now = Date.now();
		const payload: ProgressSnapshot = {
			token: cfg.token,
			instance_id: cfg.instance_id,
			attempt_id: cfg.attempt_id,
			state: completed ? "completed" : started ? "working" : "waiting",
			...(startedAt !== undefined ? { started_at: startedAt } : {}),
			...(activityAt !== undefined ? { activity_at: activityAt } : {}),
			updated_at: now,
		};
		try { atomicJson(progressFile(), payload); } catch { /* ignore cleanup race */ }
	};

	const persistOwnership = (state: OwnershipState, cfg = config) => {
		if (!cfg.write_paths?.length && !cfg.read_paths?.length && !cfg.ownership_wait_for?.length && !existsSync(ownershipPath(cfg.session_dir, cfg.instance_id))) return;
		const path = ownershipPath(cfg.session_dir, cfg.instance_id);
		let prevAdmittedAt: string | undefined;
		let prevStartupSeen = false;
		if (existsSync(path)) {
			const existing = parseOwnershipRecord(readJson<unknown>(path), ownershipExpectation(cfg));
			prevAdmittedAt = existing.admitted_at;
			prevStartupSeen = existing.startup_seen === true;
		}
		const nowIso = new Date().toISOString();
		const record = ownershipRecord({
			identity: {
				run_id: cfg.task_id,
				node_id: cfg.node_id,
				persona_name: cfg.persona_name,
				attempt_id: cfg.review_plan ? attemptKey(cfg.review_plan, cfg.instance_id, 1) : (cfg.attempt_id ?? cfg.instance_id),
				instance_id: cfg.instance_id,
			},
			state,
			write_paths: cfg.write_paths ?? [],
			read_paths: cfg.read_paths ?? [],
			waiting_for: cfg.ownership_wait_for ?? [],
			startup_seen: state === "waiting" ? (started || prevStartupSeen) : false,
			admitted_at: state === "admitted" ? (prevAdmittedAt ?? nowIso) : prevAdmittedAt,
			released_at: state === "released" ? nowIso : undefined,
			updated_at: nowIso,
		});
		try { atomicJson(path, record); } catch { /* ignore */ }
	};

	const checkOwnership = () => evaluateOwnershipDependencies({
		sessionDir: config.session_dir,
		taskId: config.task_id,
		token: config.token,
		waitingFor: config.ownership_wait_for ?? [],
		topology: config.topology,
		reviewPlan: config.review_plan,
		instanceId: config.instance_id,
		roster: config.roster ?? [],
	});

	const tryAdmitOwnership = (): boolean => {
		if (!config.write_paths?.length && !config.read_paths?.length && !config.ownership_wait_for?.length) return true;
		const evalResult = checkOwnership();
		if (evalResult.admitted) {
			ownershipAdmitted = true;
			persistOwnership("admitted");
			return true;
		}
		ownershipAdmitted = false;
		persistOwnership("waiting");
		return false;
	};

	const recordFailure = (message: string, cfg = config) => {
		holdForAttention = true;
		try { atomicJson(errorFile(cfg), { error: message }); } catch { /* ignore */ }
		if (failurePolicyOf(cfg) === "fail_fast") {
			try {
				publishFailFast({
					sessionDir: cfg.session_dir,
					taskId: cfg.task_id,
					token: cfg.token,
					cause: { node_id: cfg.node_id, instance_id: cfg.instance_id, state: "needs_attention", reason: message },
				});
			} catch { /* best effort */ }
		}
	};

	const endWithoutExecuting = (state: DispositionState, reason: string, causes: CauseRef[], errMsg?: string, commandEvidence?: CommandEvidence, cfg = config) => {
		const dispFile = dispositionPath(cfg.session_dir, activeKey(cfg));
		if (state !== "needs_attention" && (ownershipAdmitted || existsSync(ownershipPath(cfg.session_dir, cfg.instance_id)))) {
			try {
				persistOwnership("released", cfg);
			} catch (error) {
				const ownMsg = `Cannot release ownership record: ${errorMessage(error)}`;
				recordFailure(ownMsg, cfg);
				if (!existsSync(resultPath(cfg.session_dir, activeKey(cfg))) && !existsSync(dispFile)) {
					try {
						atomicJson(dispFile, dispositionRecord(cfg, "needs_attention", ownMsg, [{ node_id: cfg.node_id, state: "needs_attention", reason: ownMsg }], new Date().toISOString(), commandEvidence));
					} catch { /* ignore */ }
				}
				completed = true;
				heartbeat(cfg);
				settleNow();
				return;
			}
		}
		if (!existsSync(resultPath(cfg.session_dir, activeKey(cfg))) && !existsSync(dispFile)) {
			try {
				atomicJson(dispFile, dispositionRecord(cfg, state, reason, causes, new Date().toISOString(), commandEvidence));
			} catch { /* ignore */ }
		}
		completed = true;
		if (state === "needs_attention") {
			holdForAttention = true;
			try { atomicJson(errorFile(cfg), { error: errMsg ?? reason }); } catch { /* ignore */ }
		}
		heartbeat(cfg);
		settleNow();
	};

	const failClosedCancelError = (message: string, commandEvidence?: CommandEvidence, cfg = config) => {
		if (completed) return;
		recordFailure(message, cfg);
		endWithoutExecuting(
			"needs_attention",
			message,
			[{ node_id: cfg.node_id, state: "needs_attention", reason: message }],
			message,
			commandEvidence,
			cfg,
		);
	};

	const recordCancelled = (reason: string, commandEvidence?: CommandEvidence, settled = false, cfg = config) => {
		if (completed) return;
		if (started && !settled && reason.startsWith("Cancelled by fail-fast policy") && !commandEvidence) return;
		if (existsSync(resultPath(cfg.session_dir, activeKey(cfg)))) {
			completed = true;
			settleNow();
			return;
		}
		try {
			const claim = claimOutcome(cfg.session_dir, cancelIdentity(cfg), "cancelled", new Date().toISOString(), activeKey(cfg));
			if (!claim.won && claim.claim.outcome !== "cancelled") return;
		} catch (error) {
			recordFailure(`unusable outcome claim: ${errorMessage(error)}`, cfg);
			completed = true;
			settleNow();
			return;
		}
		const ff = reason.startsWith("Cancelled by fail-fast policy")
			? readFailFast(cfg.session_dir, cfg.task_id, cfg.token).record : undefined;
		const causes: CauseRef[] = ff ? [{ node_id: ff.cause.node_id, state: ff.cause.state, reason: ff.cause.reason }] : [];
		endWithoutExecuting("cancelled", reason, causes, undefined, commandEvidence, cfg);
	};

	const sendNotification = async (dest: string, content: string): Promise<{ delivered: boolean; error?: string; msgId?: string }> => {
		const targetReady = readyPath(config.session_dir, dest);
		let targetSession = `session-${dest}`;
		if (existsSync(targetReady)) {
			try {
				const r = parseWorkerReady(readJson<unknown>(targetReady));
				targetSession = r.session_id;
			} catch { /* fallback */ }
		}
		sent.push({ name: "coms_send", params: { target: targetSession, prompt: content } });
		if (options.sendComs) return options.sendComs(targetSession, content);
		if (options.skipComsServer) return { delivered: true, msgId: `cmd-${randomUUID().slice(0, 8)}` };
		return sendViaUnixComs(config, sessionId, socketPath, dest, content);
	};

	const runSpawnedCommand = async (): Promise<{ result?: BootstrapResult; cancelledReason?: string; cancelErrorReason?: string; evidence: CommandEvidence }> => {
		const cmd = validateCommandString(config.command, `command for ${config.node_id}`);
		const args = validateCommandArgs(config.args, `args for ${config.node_id}`);
		const wd = resolveCommandWorkingDirectory(config.project_cwd, config.working_directory ?? config.project_cwd, `working_directory for ${config.node_id}`);

		const key = activeKey(config);
		const pgFile = commandProcessGroupPath(config.session_dir, key);
		if (pathEntryExists(pgFile)) {
			throw new Error(`Command process group record already exists for ${key}`);
		}
		const predecessorsMap: Record<string, string> = {};
		for (const src of inboundEdgesOf(config)) {
			const srcNode = sourceNode(config, src);
			const sKey = sourceKey(config, src);
			predecessorsMap[srcNode] = resultPath(config.session_dir, sKey);
		}
		const env: NodeJS.ProcessEnv = {
			...buildCommandEnv(process.env),
			PWD: wd,
			BOOTSTRAP_TASK_ID: config.task_id,
			BOOTSTRAP_NODE_ID: config.node_id,
			BOOTSTRAP_INSTANCE_ID: config.instance_id,
			BOOTSTRAP_ATTEMPT_ID: config.attempt_id ?? key,
			BOOTSTRAP_SESSION_DIR: config.session_dir,
			BOOTSTRAP_PROJECT_CWD: config.project_cwd,
			BOOTSTRAP_WORKING_DIRECTORY: wd,
			BOOTSTRAP_TASK_INPUT_PATH: taskInputPath(config.session_dir, key),
			BOOTSTRAP_UPSTREAM_INDEX_PATH: upstreamIndexPath(config.session_dir),
			BOOTSTRAP_PREDECESSOR_PATHS: JSON.stringify(predecessorsMap),
		};

		const startedIso = new Date().toISOString();
		const startMs = Date.now();
		started = true;
		startedAt = startMs;
		activityAt = startMs;
		heartbeat();

		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let capturedStdoutLen = 0;
		let capturedStderrLen = 0;
		let spawnError: string | undefined;
		let cancelledReason: string | undefined;
		let cancelErrorReason: string | undefined;
		let timedOutReason: string | undefined;
		let pgKilled = false;

		let spawnedPid: number | undefined;
		let pgStartTime: string | undefined;
		const childResult = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolveExec => {
			let settled = false;
			let child: ChildProcess;
			try {
				child = spawn(cmd, args, {
					cwd: wd,
					shell: false,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env,
				});
			} catch (error) {
				spawnError = errorMessage(error);
				resolveExec({ exitCode: null, signal: null });
				return;
			}
			activeChild = child;
			activeChildPgid = child.pid;
			spawnedPid = child.pid;
			if (child.pid) {
				pgStartTime = processStartTime(child.pid);
				activeChildPgStartTime = pgStartTime;
			}

			let execWatcher: ReturnType<typeof setInterval> | undefined;
			const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (execWatcher) clearInterval(execWatcher);
				activeChild = undefined;
				activeChildPgid = undefined;
				activeChildPgStartTime = undefined;
				resolveExec({ exitCode, signal });
			};

			let closeResolve!: () => void;
			const closePromise = new Promise<void>(resolveClose => { closeResolve = resolveClose; });
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				activityAt = Date.now();
				if (capturedStdoutLen < MAX_STDOUT_CAPTURE_BYTES) {
					const slice = chunk.subarray(0, MAX_STDOUT_CAPTURE_BYTES - capturedStdoutLen);
					stdoutChunks.push(slice);
					capturedStdoutLen += slice.length;
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				activityAt = Date.now();
				if (capturedStderrLen < MAX_STDOUT_CAPTURE_BYTES) {
					const slice = chunk.subarray(0, MAX_STDOUT_CAPTURE_BYTES - capturedStderrLen);
					stderrChunks.push(slice);
					capturedStderrLen += slice.length;
				}
			});
			child.on("error", err => {
				spawnError = errorMessage(err);
				closeResolve();
				finish(null, null);
			});
			child.on("close", (code, sig) => {
				closeResolve();
				finish(code, sig);
			});

			const triggerKill = async (why: { cancel?: string; cancelError?: string; timeout?: string; immediate?: boolean }) => {
				if (childCancelPromise) return;
				if (why.cancelError) cancelErrorReason = why.cancelError;
				if (why.cancel) cancelledReason = why.cancel;
				if (why.timeout) timedOutReason = why.timeout;
				childCancelPromise = (async () => {
					if (child.pid) {
						const grace = why.immediate ? 0 : (config.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS);
						pgKilled = await killPg(child.pid, grace, pgStartTime);
						if (child.exitCode === null && child.signalCode === null) {
							await Promise.race([closePromise, delay(1500)]);
						}
					}
					finish(child.exitCode, child.signalCode);
				})();
			};

			if (child.pid) {
				const pgRecord: CommandProcessGroupRecord = {
					version: 1,
					identity: {
						run_id: config.task_id,
						node_id: config.node_id,
						persona_name: config.persona_name,
						attempt_id: config.attempt_id ?? key,
						instance_id: config.instance_id,
					},
					pgid: child.pid,
					...(pgStartTime !== undefined ? { start_time: pgStartTime } : {}),
					started_at: startedIso,
				};
				try {
					const published = writePg(pgFile, JSON.stringify(pgRecord, null, 2) + "\n", Boolean(config.factory_managed));
					if (!published) {
						void triggerKill({ cancelError: `Command process group record already exists for ${key}`, immediate: true });
						return;
					}
				} catch (error) {
					void triggerKill({ cancelError: `Failed to persist command process group record: ${errorMessage(error)}`, immediate: true });
					return;
				}
			}

			execWatcher = setInterval(() => {
				const cancel = readCancellation();
				if (cancel.error) {
					void triggerKill({ cancelError: `Cancellation check failed closed: ${cancel.error}` });
					return;
				}
				if (cancel.cancelled) {
					void triggerKill({ cancel: cancel.reason ?? "Run or node cancelled" });
					return;
				}
				if (config.task_timeout_ms !== undefined && Date.now() - startMs >= config.task_timeout_ms) {
					void triggerKill({ timeout: `Command duration deadline exceeded (${config.task_timeout_ms}ms)` });
				}
			}, Math.min(pollIntervalMs, 50));
			execWatcher.unref?.();
		});

		if (childCancelPromise) {
			await childCancelPromise;
			childCancelPromise = undefined;
		}
		let survivingGroup = false;
		if (spawnedPid && pgAlive(spawnedPid, pgStartTime)) {
			pgKilled = await killPg(spawnedPid, config.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS, pgStartTime);
			survivingGroup = !pgKilled && pgAlive(spawnedPid, pgStartTime);
		} else if (spawnedPid && (cancelledReason || cancelErrorReason || timedOutReason)) {
			survivingGroup = pgAlive(spawnedPid, pgStartTime);
		}

		const finishedIso = new Date().toISOString();
		const durationMs = Math.max(0, Date.now() - startMs);
		const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
		const stderrText = Buffer.concat(stderrChunks).toString("utf8");
		const missingExitObservation = !spawnError && childResult.exitCode === null && childResult.signal === null;
		const terminationError = survivingGroup
			? "command process group termination could not be confirmed"
			: missingExitObservation
			? "command exited without exit code or signal observation"
			: undefined;
		const evidence: CommandEvidence = {
			version: 1,
			command: cmd,
			args: [...args],
			working_directory: wd,
			exit_code: childResult.exitCode,
			signal: childResult.signal,
			started_at: startedIso,
			finished_at: finishedIso,
			duration_ms: durationMs,
			...(spawnError ? { spawn_error: spawnError } : {}),
			...(terminationError ? { termination_error: terminationError } : {}),
			...(spawnedPid ? { process_group_id: spawnedPid } : {}),
			...(pgKilled ? { process_group_killed: true } : {}),
			stdout_bytes: stdoutBytes,
			stderr_bytes: stderrBytes,
			...(clipExcerpt(stdoutText) ? { stdout_excerpt: clipExcerpt(stdoutText) } : {}),
			...(clipExcerpt(stderrText) ? { stderr_excerpt: clipExcerpt(stderrText) } : {}),
		};

		if (cancelErrorReason) {
			return { cancelErrorReason, evidence };
		}
		if (cancelledReason) {
			if (survivingGroup || (spawnedPid && pgAlive(spawnedPid, pgStartTime))) {
				return {
					cancelErrorReason: `Cancellation did not confirm process group ${spawnedPid} termination`,
					evidence,
				};
			}
			return { cancelledReason, evidence };
		}

		let result: BootstrapResult;
		if (timedOutReason) {
			result = {
				agent_name: config.persona_name,
				node_id: config.node_id,
				status: "failure",
				summary: timedOutReason,
				detail: [timedOutReason, clipExcerpt(stderrText), clipExcerpt(stdoutText)].filter(Boolean).join("\n"),
				command_evidence: evidence,
			};
		} else if (spawnError || terminationError || childResult.signal !== null || childResult.exitCode !== 0) {
			const why = spawnError
				? `Command failed to spawn (${cmd}): ${spawnError}`
				: terminationError
				? `Command termination could not be confirmed (${cmd}): ${terminationError}`
				: childResult.signal !== null
				? `Command killed by signal ${childResult.signal}`
				: `Command exited with code ${childResult.exitCode}`;
			result = {
				agent_name: config.persona_name,
				node_id: config.node_id,
				status: "failure",
				summary: why,
				detail: [why, clipExcerpt(stderrText), clipExcerpt(stdoutText)].filter(Boolean).join("\n"),
				command_evidence: evidence,
			};
		} else {
			result = parseCommandResultFromStdout(stdoutText, config, evidence);
		}
		return { result, evidence };
	};

	const executeAdmittedCommand = async () => {
		if (completed || started) return;
		const { result, cancelledReason, cancelErrorReason, evidence } = await runSpawnedCommand();
		if (cancelErrorReason) {
			failClosedCancelError(cancelErrorReason, evidence);
			return;
		}
		if (cancelledReason) {
			recordCancelled(cancelledReason, evidence, true);
			return;
		}
		if (!result) return;

		const key = activeKey(config);
		const path = resultPath(config.session_dir, key);
		try {
			options.beforeOutcomeClaim?.();
			const claim = claimOutcome(config.session_dir, cancelIdentity(), "completed", new Date().toISOString(), key);
			if (!claim.won) {
				const cancel = readCancellation();
				if (cancel.error) {
					failClosedCancelError(`Outcome claim lost amid damaged cancellation record: ${cancel.error}`, evidence);
				} else {
					recordCancelled(cancel.reason ?? "Cancelled concurrently with command completion", evidence, true);
				}
				return;
			}
		} catch (error) {
			failClosedCancelError(`unusable outcome claim: ${errorMessage(error)}`, evidence);
			return;
		}

		const completion = completionRecord(config, result, "pending", new Date().toISOString());
		atomicJson(path, completion);
		try {
			if (existsSync(join(config.session_dir, "upstream-index.json"))) {
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
					result_hash: resultHash(completion.result),
					...(completion.result.outputs ? { outputs: completion.result.outputs } : {}),
					...(completion.result.artifacts ? { artifacts: completion.result.artifacts } : {}),
					...(completion.result.verification ? { verification: completion.result.verification } : {}),
				});
			}

			completed = true;
			if (ownershipAdmitted) persistOwnership("released");
			if (result.status === "failure" && failurePolicyOf(config) === "fail_fast") {
				try {
					publishFailFast({
						sessionDir: config.session_dir,
						taskId: config.task_id,
						token: config.token,
						cause: { node_id: config.node_id, instance_id: config.instance_id, state: "failed", reason: result.summary },
					});
				} catch { /* best effort */ }
			}

			const outbound = config.outbound_edges ?? (config.successor ? [config.successor] : []);
			if (outbound.length === 0) {
				completion.delivery = "not_required";
				atomicJson(path, completion);
				heartbeat();
				settleNow();
				return;
			}

			const edgeDeliveries: Record<string, EdgeDeliveryState> = {};
			const queuedOffers: HandoffOffer[] = [];
			const failedEdges: Array<[string, string]> = [];
			for (const dest of outbound) {
				let offer: HandoffOffer | undefined;
				try {
					const ready = parseWorkerReady(readJson<unknown>(readyPath(config.session_dir, dest)));
					if (ready.task_id !== config.task_id || ready.token !== config.token || ready.instance_id !== dest) {
						throw new Error(`Successor ${dest} readiness identity mismatch`);
					}
					const destinationAttempt = attemptNumber(config.attempt_id);
					offer = config.handoff_protocol
						? offerHandoff(config, completion, path, undefined, undefined, dest, config.instance_id, destinationAttempt)
						: undefined;
					const msg = handoffNotification(config, offer, path, result.status === "failure");
					const res = await sendNotification(dest, msg);
					if (!res.delivered) {
						throw new Error(res.error ?? `Failed to deliver handoff notification to ${dest}`);
					}
					if (offer) offer = markHandoffQueued(config, offer, undefined, config.instance_id);
					if (offer) queuedOffers.push(offer);
					edgeDeliveries[dest] = {
						state: "sent",
						...(offer ? { handoff_id: offer.handoff_id } : {}),
						updated_at: new Date().toISOString(),
					};
				} catch (edgeError) {
					const reason = errorMessage(edgeError);
					const handoffId = offer?.handoff_id;
					edgeDeliveries[dest] = {
						state: "failed",
						...(handoffId ? { handoff_id: handoffId } : {}),
						error: reason,
						updated_at: new Date().toISOString(),
					};
					failedEdges.push([dest, reason]);
				}
			}

			if (config.topology === "graph" || config.outbound_edges !== undefined) {
				completion.edge_deliveries = edgeDeliveries;
			}
			completion.delivery = failedEdges.length === 0 ? "sent" : "failed";
			if (failedEdges.length) {
				completion.delivery_error = failedEdges.map(([dest, reason]) => `${dest}: ${reason}`).join("; ");
			}
			atomicJson(path, completion);
			heartbeat();
			settleNow();
		} catch (postCommitError) {
			const msg = `Post-completion settlement failed: ${errorMessage(postCommitError)}`;
			if (completion.delivery === "pending") {
				completion.delivery = "failed";
				completion.delivery_error = msg;
				try { atomicJson(path, completion); } catch { /* ignore */ }
			}
			if (ownershipAdmitted) persistOwnership("released");
			recordFailure(msg);
			completed = true;
			heartbeat();
			settleNow();
		}
	};

	let admissionInProgress = false;
	const tryAdmitInboundMessage = async (inbound: InboundComsMessage): Promise<void> => {
		if (completed || started || holdForAttention || admissionInProgress) return;
		admissionInProgress = true;
		try {
			const cancel = readCancellation();
			if (cancel.error) {
				failClosedCancelError(cancel.error);
				return;
			}
			if (cancel.cancelled) {
				recordCancelled(cancel.reason ?? "Run or node cancelled");
				return;
			}
			if (inbound.content.startsWith(`bootstrap-cancel:${config.token}:${config.instance_id}`)) {
				recordCancelled(inbound.content.split("\n").slice(1).join("\n").trim() || "Run or node cancelled");
				return;
			}
			if (!inbound.content.includes(`bootstrap-handoff:${config.token}:`)) return;

			if (isManagedWorker(config)) {
				authoritativeBrief ??= verifyFactoryReleaseAuthority(config);
				requireManagedTaskInput(config, authoritativeBrief);
			} else {
				const inputFile = taskInputPath(config.session_dir, activeKey(config));
				if (existsSync(inputFile)) {
					parseTaskInput(readJson<unknown>(inputFile), ownExpectation(config));
				}
			}

			const upstreamIndexPath = join(config.session_dir, "upstream-index.json");
			const upstreamIndex: UpstreamIndex | undefined = existsSync(upstreamIndexPath)
				? readUpstreamIndex(config.session_dir, config.task_id)
				: undefined;

			if (inboundSources.length > 1) {
				const prefix = `bootstrap-handoff:${config.token}:`;
				const idx = inbound.content.indexOf(prefix);
				const sourceInstanceId = idx >= 0 ? inbound.content.slice(idx + prefix.length).split(/\s/)[0] : "";
				if (!inboundSources.includes(sourceInstanceId)) {
					try {
						recordHandoffRejection(config, {
							at: new Date().toISOString(),
							kind: "run",
							severity: "notification",
							reason: idx < 0 ? "the notification is not for this run's handoff (token mismatch)" : `${JSON.stringify(sourceInstanceId)} is not an inbound edge of ${config.instance_id}`,
						});
					} catch { /* ignore */ }
					return;
				}
				const expected = parseWorkerReady(readJson<unknown>(readyPath(config.session_dir, sourceInstanceId)));
				const sessionOf = (srcId: string): string | undefined => {
					try { return readJson<WorkerReady>(readyPath(config.session_dir, srcId)).session_id; } catch { return undefined; }
				};
				const decision = evaluateJoinHandoff({
					config,
					inboundInstances: inboundSources,
					sourceInstanceId,
					expectedSession: expected.session_id,
					senderSession: inbound.sender_session,
					content: inbound.content,
					loadPredecessor: srcId => {
						const srcLoop = reviewLoopFor(config.review_plan, srcId);
						let srcAttempt: number | undefined;
						if (srcLoop) {
							const fin = readFinalization(config.session_dir, config.task_id, srcLoop, srcId);
							if (!fin) return undefined;
							srcAttempt = attemptNumber(fin.attempt_id);
						}
						const p = resultPath(config.session_dir, sourceKey(config, srcId, srcAttempt));
						return existsSync(p) ? parseCompletion(readJson<unknown>(p), sourceExpectation(config, srcId, srcAttempt)) : undefined;
					},
					sessionOf,
				});
				if (decision.outcome === "duplicate") return;
				if (decision.outcome === "reject") {
					try { recordHandoffRejection(config, decision.rejection, decision.sourceInstanceId); } catch { /* ignore */ }
					if (decision.rejection.severity === "integrity") {
						const node = sourceNode(config, decision.sourceInstanceId);
						const reason = `Handoff rejected from ${node}: ${decision.rejection.reason}`;
						endWithoutExecuting("needs_attention", reason, [{ node_id: node, state: "needs_attention", reason }], "Handoff validation failed");
					}
					return;
				}
				joinWakeSources.add(sourceInstanceId);
				if (decision.outcome === "wait") {
					const joinState = evaluateJoinAdmission(config, inboundSources);
					if (joinState.outcome === "blocked") {
						endWithoutExecuting("blocked", joinState.reason, joinState.causes, "Join aborted by upstream failure");
					}
					return;
				}
				for (const edge of decision.edges) {
					const blockers = validateUpstreamAdmission({ config, predecessor: edge.predecessor, sourceInstanceId: edge.sourceInstanceId, upstreamIndex, includeChecks: false });
					if (blockers.length) throw new Error(blockers.join("; "));
				}
				const recheck = evaluateJoinAdmission(config, inboundSources);
				if (recheck.outcome === "blocked") {
					endWithoutExecuting("blocked", recheck.reason, recheck.causes, "Join aborted by upstream failure");
					return;
				}
				if (recheck.outcome === "wait") return;
				if (!tryAdmitOwnership()) {
					startOwnershipPoll(() => void tryAdmitInboundMessage(inbound));
					return;
				}
				const claimed = claimJoinHandoff(config, decision.edges);
				if (claimed.outcome === "duplicate") return;
				await executeAdmittedCommand();
				return;
			}

			if (config.predecessor) {
				const ready = parseWorkerReady(readJson<unknown>(readyPath(config.session_dir, config.predecessor)));
				let incoming = config;
				const sourceLoop = reviewLoopFor(config.review_plan, config.predecessor);
				if (sourceLoop) {
					const fin = readFinalization(config.session_dir, config.task_id, sourceLoop, config.predecessor);
					if (!fin) return;
					incoming = { ...config, predecessor_attempt: attemptNumber(fin.attempt_id) };
				}
				const predPath = resultPath(incoming.session_dir, predecessorKey(incoming));
				const decision = evaluateHandoff({
					config: incoming,
					expectedSession: ready.session_id,
					senderSession: inbound.sender_session,
					content: inbound.content,
					loadPredecessor: () => parseCompletion(readJson<unknown>(predPath), predecessorExpectation(incoming)),
				});
				if (decision.outcome === "duplicate") return;
				if (decision.outcome === "reject") {
					try { recordHandoffRejection(incoming, decision.rejection); } catch { /* ignore */ }
					if (decision.rejection.severity === "integrity") {
						recordFailure(`Handoff rejected: ${decision.rejection.reason}`, incoming);
						completed = true;
						settleNow();
					}
					return;
				}
				const predecessor = decision.predecessor;
				const blockers = validateUpstreamAdmission({ config: incoming, predecessor, upstreamIndex, includeChecks: false });
				if (blockers.length) throw new Error(blockers.join("; "));
				const verdict = admission(incoming, { completion: predecessor });
				if (!verdict.admit) {
					if (verdict.outcome === "blocked") {
						endWithoutExecuting("blocked", verdict.reason, verdict.causes, "Chain dependency failed");
					} else {
						recordFailure(`Admission failed: ${verdict.reason}`);
						completed = true;
						settleNow();
					}
					return;
				}
				if (!tryAdmitOwnership()) {
					startOwnershipPoll(() => void tryAdmitInboundMessage(inbound));
					return;
				}
				const claimed = claimHandoff(incoming, decision, ready.session_id);
				if (claimed.outcome === "rejected") {
					try { recordHandoffRejection(incoming, { at: new Date().toISOString(), kind: "conflict", severity: "notification", reason: claimed.reason }); } catch { /* ignore */ }
					return;
				}
				config = incoming;
				await executeAdmittedCommand();
			}
		} catch (error) {
			recordFailure(`Command node admission failed: ${errorMessage(error)}`);
			completed = true;
			settleNow();
		} finally {
			admissionInProgress = false;
		}
	};

	const startOwnershipPoll = (retry: () => void) => {
		if (ownershipTimer || completed || started) return;
		const ownershipWaitMs = config.dependency_wait_timeout_ms ?? DEFAULT_DEPENDENCY_WAIT_MS;
		const waitingSince = Date.now();
		ownershipTimer = setInterval(() => {
			if (completed || started) {
				if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
				return;
			}
			try {
				const evalResult = checkOwnership();
				if (evalResult.admitted) {
					if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
					retry();
					return;
				}
				const stalled = evalResult.waiting_on.filter(holder => {
					if (holder.status === "uncertain") return true;
					return Date.now() - waitingSince > ownershipWaitMs;
				});
				if (stalled.length) {
					if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
					const reason = `Timed out waiting for write ownership held by ${stalled.map(h => h.node_id).join(", ")}`;
					const causes: CauseRef[] = stalled.map(h => ({
						node_id: h.node_id,
						state: h.status === "uncertain" ? "needs_attention" : "running",
						reason: h.reason,
					}));
					endWithoutExecuting("needs_attention", reason, causes, "Ownership wait failed");
				}
			} catch (error) {
				if (ownershipTimer) { clearInterval(ownershipTimer); ownershipTimer = undefined; }
				recordFailure(`Ownership wait error: ${errorMessage(error)}`);
				completed = true;
				settleNow();
			}
		}, pollIntervalMs);
		ownershipTimer.unref?.();
	};

	const startPredecessorWatcher = () => {
		if (inboundSources.length === 0 || completed) return;
		const waitingSince = Date.now();
		const dependencyWaitMs = config.dependency_wait_timeout_ms ?? DEFAULT_DEPENDENCY_WAIT_MS;
		const predecessors = config.topology === "graph" ? graphPredecessors(config) : undefined;
		const upstreamInstances = predecessors ? graphAncestors(predecessors, inboundSources) : inboundSources;
		const processState = (id: string): "alive" | "exited" | "unknown" => {
			try {
				const r = parseWorkerReady(readJson<unknown>(readyPath(config.session_dir, id)));
				if (r.task_id === config.task_id && r.token === config.token && r.instance_id === id) return processAlive(r) ? "alive" : "exited";
			} catch { /* ignore */ }
			return "unknown";
		};
		const latestUpstreamActivity = (): number => {
			let best = waitingSince;
			for (const id of upstreamInstances) {
				try {
					const p = readJson<ProgressSnapshot>(join(config.session_dir, `${id}.progress.json`));
					if (p.token === config.token && p.state === "working") {
						const ts = p.activity_at ?? p.started_at ?? p.updated_at;
						if (Number.isFinite(ts) && ts > best) best = ts;
					}
				} catch { /* ignore */ }
			}
			return best;
		};
		predecessorTimer = setInterval(() => {
			if (completed || started || holdForAttention) return;
			try {
				if (inboundSources.length > 1) {
					const joinDecision = evaluateJoinAdmission(config, inboundSources);
					if (joinDecision.outcome === "blocked") {
						endWithoutExecuting("blocked", joinDecision.reason, joinDecision.causes, "Join dependency failed");
						return;
					}
					if (joinDecision.outcome === "admit") {
						const withoutOffers = config.handoff_protocol ? inboundSources.filter(src => !existsSync(handoffOfferPath(config.session_dir, activeKey(config), src))) : [];
						if (withoutOffers.length === 0 && !options.skipComsServer) {
							// Wait for incoming Coms wake-up or timeout if delivery failed silently.
						}
					}
				} else if (config.predecessor) {
					const rec = predecessorRecord(config);
					const execState = executionOf(rec);
					if (execState && (rec.disposition || rec.completion!.delivery !== "sent")) {
						const dec = admission(config, rec);
						if (!dec.admit && dec.outcome === "blocked") {
							endWithoutExecuting("blocked", dec.reason, dec.causes, "Chain dependency failed");
							return;
						}
					}
				}
				if (Date.now() - latestUpstreamActivity() > dependencyWaitMs) {
					endWithoutExecuting("needs_attention", `No upstream progress or handoff for ${dependencyWaitMs}ms`, [], "Dependency wait timeout");
				}
			} catch (error) {
				recordFailure(errorMessage(error));
				completed = true;
				settleNow();
			}
		}, Math.max(pollIntervalMs, 100));
		predecessorTimer.unref?.();
	};

	const startComsEndpoint = async (): Promise<void> => {
		if (options.skipComsServer) return;
		socketPath = join(tmpdir(), `bs-cmd-${randomUUID().slice(0, 12)}.sock`);
		server = createServer((conn: Socket) => {
			let buf = "";
			const safeWrite = (payload: string) => {
				if (conn.destroyed || !conn.writable) return;
				try { conn.write(payload, () => { /* ignore EPIPE if client closed */ }); } catch { /* ignore */ }
			};
			conn.on("error", () => { /* peer closed connection */ });
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line) as { type?: string; msg_id?: string; sender_session?: string; prompt?: string };
						if (msg.type === "ping") {
							safeWrite(JSON.stringify({ type: "pong" }) + "\n");
						} else if (msg.type === "prompt" && typeof msg.prompt === "string") {
							safeWrite(JSON.stringify({ type: "ack", msg_id: msg.msg_id ?? "" }) + "\n");
							if (msg.prompt.startsWith(`bootstrap-cancel:${config.token}:${config.instance_id}`)) {
								if (!started) recordCancelled(msg.prompt.split("\n").slice(1).join("\n").trim() || "Cancelled");
							} else if (released && inboundSources.length > 0) {
								void tryAdmitInboundMessage({ sender_session: msg.sender_session, content: msg.prompt });
							}
						}
					} catch { /* ignore malformed frame */ }
				}
			});
		});
		await new Promise<void>((resolveBind, rejectBind) => {
			server!.once("error", rejectBind);
			server!.listen(socketPath, () => {
				server!.off("error", rejectBind);
				resolveBind();
			});
		});
		const agentsDir = join(config.coms_dir, "projects", config.coms_project, "agents");
		mkdirSync(agentsDir, { recursive: true });
		registryPath = join(agentsDir, `${config.instance_id}.json`);
		atomicJson(registryPath, {
			pid: process.pid,
			name: config.instance_id,
			session_id: sessionId,
			endpoint: socketPath,
			cwd: config.project_cwd,
			model: "(none)",
		});
	};

	const start = async () => {
		try {
			await startComsEndpoint();
			const ready: WorkerReady = {
				version: 1,
				task_id: config.task_id,
				token: config.token,
				instance_id: config.instance_id,
				pid: process.pid,
				session_id: sessionId,
				name: config.instance_id,
				endpoint: socketPath,
				model: "(none)",
				...(processStartTime(process.pid) ? { start_time: processStartTime(process.pid) } : {}),
			};
			atomicJson(readyPath(config.session_dir, config.instance_id), ready);
			heartbeat();

			const deadline = Date.now() + config.ready_timeout_ms;
			while (!released) {
				const releasePath = join(config.session_dir, "release.json");
				const managed = isManagedWorker(config);
				if (managed ? pathEntryExists(releasePath) : existsSync(releasePath)) {
					if (managed) {
						authoritativeBrief = verifyFactoryReleaseAuthority(config);
						requireManagedTaskInput(config, authoritativeBrief);
					} else {
						const rel = readJson<{ task_id: string; token: string; factory_managed?: unknown }>(releasePath);
						if (rel.task_id !== config.task_id || rel.token !== config.token) throw new Error("Invalid bootstrap release token");
						if (rel.factory_managed !== undefined) throw new Error("Contradictory release marker: factory_managed metadata on standalone run");
						const inputFile = taskInputPath(config.session_dir, activeKey(config));
						if (existsSync(inputFile)) parseTaskInput(readJson<unknown>(inputFile), ownExpectation(config));
					}
					released = true;
					break;
				}
				const preCancel = readCancellation();
				if (preCancel.error) {
					failClosedCancelError(preCancel.error);
					return;
				}
				if (preCancel.cancelled) {
					recordCancelled(preCancel.reason ?? "Cancelled before release");
					return;
				}
				if (existsSync(join(config.session_dir, "abort.json"))) {
					throw new Error("Dispatcher aborted the bootstrap run");
				}
				if (Date.now() >= deadline) throw new Error("Dispatcher did not release the bootstrap readiness barrier");
				await delay(pollIntervalMs);
			}

			// Restart / already settled checks
			if (existsSync(resultPath(config.session_dir, activeKey(config)))) {
				parseCompletion(readJson<unknown>(resultPath(config.session_dir, activeKey(config))), ownExpectation(config));
				completed = true;
				settleNow();
				return;
			}
			const existingPgFile = commandProcessGroupPath(config.session_dir, activeKey(config));
			let hadLiveOrphanOnRestart = false;
			let priorPgRecord: CommandProcessGroupRecord | undefined;
			if (pathEntryExists(existingPgFile)) {
				try {
					priorPgRecord = parseCommandProcessGroupRecord(
						readRegularJsonNoSymlink<unknown>(existingPgFile, "command process group record"),
						ownExpectation(config),
					);
				} catch (error) {
					const reason = `unusable process group record on restart: ${errorMessage(error)}`;
					endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], reason);
					return;
				}
				if (pgAlive(priorPgRecord.pgid, priorPgRecord.start_time)) {
					hadLiveOrphanOnRestart = true;
					const killed = await killPg(priorPgRecord.pgid, config.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS, priorPgRecord.start_time);
					if (!killed || pgAlive(priorPgRecord.pgid, priorPgRecord.start_time)) {
						const reason = `restarted command node found live orphaned process group ${priorPgRecord.pgid} and could not confirm termination`;
						endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], reason);
						return;
					}
				}
			}
			if (existsSync(dispositionPath(config.session_dir, activeKey(config)))) {
				completed = true;
				holdForAttention = true;
				settleNow();
				return;
			}
			const postCancel = readCancellation();
			if (postCancel.error) {
				failClosedCancelError(postCancel.error);
				return;
			}
			if (postCancel.cancelled) {
				const baseReason = postCancel.reason ?? "Run or node cancelled";
				const cancelReason = hadLiveOrphanOnRestart
					? `${baseReason} (stopped orphaned command process group; prior side effects could not be undone)`
					: baseReason;
				recordCancelled(cancelReason);
				return;
			}
			if (priorPgRecord) {
				const reason = `command process group ${priorPgRecord.pgid} was already started before this command node restarted; the command is not re-run automatically`;
				endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], "Command node restarted after spawning its command");
				return;
			}

			if (inboundSources.length > 1 && existsSync(handoffClaimPath(config.session_dir, activeKey(config)))) {
				const claim = parseJoinHandoffClaim(readJson<unknown>(handoffClaimPath(config.session_dir, activeKey(config))));
				const reason = `join handoffs (${claim.handoff_ids.join(", ")}) were accepted but no result was recorded before this command node restarted; the command is not re-run automatically`;
				endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], "Command node restarted after accepting its task");
				return;
			}
			if (inboundSources.length === 1 && existsSync(handoffClaimPath(config.session_dir, activeKey(config), handoffSourceScope(config)))) {
				const reason = `handoff from ${predecessorNode(config)} was accepted but no result was recorded before this command node restarted; the command is not re-run automatically`;
				endWithoutExecuting("needs_attention", reason, [{ node_id: config.node_id, state: "needs_attention", reason }], "Command node restarted after accepting its task");
				return;
			}

			heartbeatTimer = setInterval(() => heartbeat(), 1000);
			heartbeatTimer.unref?.();
			cancelTimer = setInterval(() => {
				if (completed || started) return;
				const cancel = readCancellation();
				if (cancel.error) {
					failClosedCancelError(cancel.error);
					return;
				}
				if (cancel.cancelled) {
					recordCancelled(cancel.reason ?? "Run or node cancelled");
				}
			}, pollIntervalMs);
			cancelTimer.unref?.();

			if (inboundSources.length === 0) {
				const startRoot = () => {
					if (completed || started || holdForAttention) return;
					try {
						if (!tryAdmitOwnership()) {
							startOwnershipPoll(startRoot);
							return;
						}
						void executeAdmittedCommand().catch(error => {
							failClosedCancelError(`Command node execution failed: ${errorMessage(error)}`);
						});
					} catch (error) {
						failClosedCancelError(`Command node root start failed: ${errorMessage(error)}`);
					}
				};
				if (options.skipComsServer) {
					// Wait for explicit beforeStart() in runFixture, mirroring workerFromConfig.
					return;
				}
				startRoot();
			} else {
				startPredecessorWatcher();
			}
		} catch (error) {
			recordFailure(errorMessage(error));
			completed = true;
			settleNow();
		}
	};

	const beforeStart = async (event: { systemPrompt?: string; messageType?: string; message?: { customType?: string; details?: { sender_session?: string }; content?: string } } = {}) => {
		if (completed) return;
		if (!released) return;
		if (inboundSources.length === 0) {
			if (!started && !holdForAttention) {
				try {
					if (!tryAdmitOwnership()) {
						startOwnershipPoll(() => void beforeStart());
						return;
					}
					await executeAdmittedCommand();
				} catch (error) {
					failClosedCancelError(`Command node execution failed: ${errorMessage(error)}`);
				}
			}
			return;
		}
		if (event.messageType === "custom" && event.message?.customType === "coms-inbound" && typeof event.message.content === "string") {
			await tryAdmitInboundMessage({ sender_session: event.message.details?.sender_session, content: event.message.content });
		}
	};

	const shutdown = async (reason: "quit" | "reload" = "reload") => {
		if (activeShutdownPromise) return activeShutdownPromise;
		activeShutdownPromise = (async () => {
			if (stopped) return;
			stopped = true;
			stopTimers();
			if (activeChildPgid) {
				const killed = await killPg(activeChildPgid, config.cancel_grace_ms ?? DEFAULT_CANCEL_GRACE_MS, activeChildPgStartTime);
				if (!killed && !completed) {
					failClosedCancelError(`Shutdown could not confirm termination of process group ${activeChildPgid}`);
				}
			}
			if (reason === "quit") {
				try {
					const ready = readJson<WorkerReady>(readyPath(config.session_dir, config.instance_id));
					atomicJson(readyPath(config.session_dir, config.instance_id), { ...ready, pid: 2147483646 });
				} catch { /* ignore */ }
			}
			closeComsServer();
		})();
		return activeShutdownPromise;
	};

	return {
		config,
		sent,
		start,
		beforeStart,
		shutdown,
		vanish: () => {
			if (stopped) return;
			stopped = true;
			stopTimers();
			closeComsServer();
			try {
				const ready = readJson<WorkerReady>(readyPath(config.session_dir, config.instance_id));
				atomicJson(readyPath(config.session_dir, config.instance_id), { ...ready, pid: 2147483646 });
			} catch { /* ignore */ }
		},
		waitUntilSettled: () => settledPromise,
		getActivePgid: () => activeChildPgid,
	};
}

export async function runCommandCli(configPath: string): Promise<void> {
	const driver = createCommandDriver(configPath);
	const handleSignal = () => {
		void driver.shutdown("quit").finally(() => process.exit(1));
	};
	process.on("SIGTERM", handleSignal);
	process.on("SIGINT", handleSignal);
	process.on("SIGHUP", handleSignal);
	await driver.start();
	await driver.waitUntilSettled();
}

const isDirectEntry = (() => {
	const script = process.argv[1];
	if (!script) return false;
	try { return import.meta.url === pathToFileURL(resolve(script)).href; }
	catch { return false; }
})();

if (isDirectEntry) {
	const flagIdx = process.argv.indexOf("--bootstrap-worker-config");
	const configPath = flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined;
	if (!configPath) {
		console.error("Usage: command-runner.ts --bootstrap-worker-config <config.json>");
		process.exit(2);
	}
	await runCommandCli(configPath);
}
