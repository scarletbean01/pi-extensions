#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type test from "node:test";
import { outcomeClaimPath } from "../cancellation.ts";
import { createRequest, inTransaction, openRequestDatabase } from "../factory-requests.ts";
import { handoffClaimPath, inputDigest } from "../handoff.ts";
import { buildProposalRow, insertProposalRow } from "../constraint-proposals.ts";
import { atomicJson, completionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "../session-store.ts";
import { BootstrapService, type ExecResult, type GenerateRequest } from "../lifecycle.ts";
import { spawnGroup, type SpawnedGroup } from "../test-harness.ts";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../../factory/operations.ts";
import { startViewer } from "../../factory/viewer/server.ts";

export interface ManualAcceptanceFixture {
	root: string;
	cwd: string;
	home: string;
	statePath: string;
	coordinationPath: string;
	env: NodeJS.ProcessEnv;
	factories: {
		alphaLiveV2: string;
		attemptOutput: string;
		betaUnreleased: string;
		gammaUncertain: string;
		deltaUnmanaged: string;
		epsilonVersions: string;
	};
	references: {
		alphaSettled: string;
		alphaRunning: string;
		betaReserved: string;
		gammaContradictory: string;
		epsilonDamagedBound: string;
	};
	run: {
		taskId: string;
		attemptId: string;
		sessionDir: string;
		leftInstanceId: string;
		leftAttemptId: string;
		rightInstanceId: string;
		rightAttemptId: string;
		reviewInstanceId: string;
		mergeInstanceId: string;
		attemptOutput: {
			taskId: string;
			attemptHistoryInstanceId: string;
			commandExitInstanceId: string;
			commandSignalInstanceId: string;
			missingResultInstanceId: string;
			stillRunningInstanceId: string;
		};
	};
	sentinels: string[];
	cleanup: () => void;
}

function createIsolatedService(root: string, personas: string[]) {
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "bootstrap-state");
	const extensionDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, bin, stateDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of personas) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nFixture persona ${name}\n`);
	}
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(item => item.pane_id === args[2]);
			if (!tab) return ok();
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(tab.cwd, ".pi", "agent-sessions", task!);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			const ready = {
				task_id: task!,
				token: config.token,
				instance_id: instance!,
				name: instance!,
				pid: process.pid,
				session_id: `session-${instance}`,
				endpoint: "/tmp/fake-coms",
				model: config.expected_model,
			};
			atomicJson(readyPath(sessionDir, instance!), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({
		exec,
		extensionDir,
		stateDir,
		home,
		pollMs: 5,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	return { cwd, home, bin, stateDir, service };
}

export interface ManualFixtureBuildOptions {
	onCleanupReady?: (cleanup: () => void, abortBuild: () => Promise<void>) => void;
}

/**
 * Create a self-contained temporary fixture state directory covering manual acceptance
 * scenarios 1-5 without touching ~/.pi/agent.
 */
export async function createManualAcceptanceFixture(
	t?: test.TestContext,
	options?: ManualFixtureBuildOptions,
): Promise<ManualAcceptanceFixture> {
	const root = mkdtempSync(join(resolve(tmpdir()), "factory-viewer-manual-"));
	let cleaned = false;
	let aborted = false;
	let activeGroup: SpawnedGroup | undefined;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (activeGroup?.child.pid) {
			try { process.kill(-activeGroup.child.pid, "SIGKILL"); } catch { /* group already gone */ }
		}
		rmSync(root, { recursive: true, force: true });
	};
	const abortBuild = async () => {
		aborted = true;
		if (activeGroup) await activeGroup.stop(0);
	};
	const checkAborted = () => {
		if (aborted) throw new Error("Manual fixture build aborted.");
	};
	if (t) t.after(cleanup);
	options?.onCleanupReady?.(cleanup, abortBuild);

	try {
		const { cwd, home, bin, stateDir, service } = createIsolatedService(root, ["builder", "reviewer"]);
		const statePath = join(root, "factories.sqlite");
		const coordinationPath = join(root, "factory-coordination.sqlite");
		const env: NodeJS.ProcessEnv = {
			PATH: bin,
			HOME: home,
			PI_FACTORY_COORDINATION_DIR: root,
			PI_BOOTSTRAP_STATE_DIR: stateDir,
		};
	const ops = factoryOperations(statePath, service, { coordinationPath });
	const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };

	const v1Draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_PROMPT_V1",
		agents: [{ node_id: "init", persona: "builder", sub_task: "SENTINEL_MANUAL_SUB_INIT" }],
	};
	const v2Draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_PROMPT_V2",
		agents: [
			{ node_id: "left", persona: "builder", sub_task: "SENTINEL_MANUAL_SUB_LEFT" },
			{ node_id: "right", persona: "builder", sub_task: "SENTINEL_MANUAL_SUB_RIGHT" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["left"],
				sub_task: "SENTINEL_MANUAL_SUB_REVIEW",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "left", max_revisions: 2, on_exhausted: "needs_attention" },
			},
			{
				node_id: "merge",
				persona: "builder",
				depends_on: ["review", "right"],
				join_policy: "allow_partial",
				sub_task: "SENTINEL_MANUAL_SUB_MERGE",
				intervention: { choices: [{ choice_id: "ship", label: "Approve and continue" }] },
			},
		],
	};
	const v3Draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_PROMPT_V3",
		agents: [{ node_id: "only_v3", persona: "builder", sub_task: "SENTINEL_MANUAL_SUB_V3" }],
	};

	// 1. alpha-live-v2: settled v1 run + active verified v2 run while v3 is current (Scenarios 1, 3, 4, 5).
	const alpha = ops({ action: "publish", name: "alpha-live-v2", draft: v1Draft, sessionModel });
	const authAlpha = createManagerAuthority({ pi_session_id: "manual-alpha" });
	ops({ action: "resume", factory_id: alpha.factory_id, authority: authAlpha });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: authAlpha, reference: "ref-alpha-v1", brief: "SENTINEL_MANUAL_BRIEF_V1" });
	const runV1 = await ops({ action: "launch", factory_id: alpha.factory_id, authority: authAlpha });
	checkAborted();
	const initCfg = runV1.manifest.pane_manifest[0]!;
	const initWorkerCfg = readJson<WorkerConfig>(join(runV1.manifest.session_dir, `${initCfg.instance_id}.config.json`));
	atomicJson(
		resultPath(runV1.manifest.session_dir, initCfg.instance_id),
		completionRecord(initWorkerCfg, {
			agent_name: initCfg.persona_name,
			node_id: "init",
			status: "success",
			summary: "Completed v1 smoke run.",
		}, "not_required", new Date().toISOString()),
	);
	await ops({ action: "settle_run", factory_id: alpha.factory_id, authority: authAlpha });
	checkAborted();

	ops({ action: "update", factory_id: alpha.factory_id, authority: authAlpha, draft: v2Draft, sessionModel });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: authAlpha, reference: "ref-alpha-v2", brief: "SENTINEL_MANUAL_BRIEF_V2" });
	const runV2 = await ops({ action: "launch", factory_id: alpha.factory_id, authority: authAlpha });
	checkAborted();
	ops({ action: "update", factory_id: alpha.factory_id, authority: authAlpha, draft: v3Draft, sessionModel });
	revokeManagerAuthority(authAlpha);

	const leftCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "left")!;
	const rightCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "right")!;
	const reviewCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const mergeCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "merge")!;
	const leftAttemptId = leftCfg.attempt_id ?? `${leftCfg.instance_id}.1`;
	const rightAttemptId = rightCfg.attempt_id ?? `${rightCfg.instance_id}.1`;

	// Give left a completed attempt (Waiting (parked) with completed_at) and right an active
	// progress snapshot (Running with started_at/updated_at) so Optional attempt timestamps
	// <details> exists immediately before any --advance-live-ms update.
	const leftWorkerCfg = readJson<WorkerConfig>(join(runV2.manifest.session_dir, `${leftCfg.instance_id}.config.json`));
	atomicJson(
		resultPath(runV2.manifest.session_dir, leftAttemptId),
		completionRecord(leftWorkerCfg, {
			agent_name: leftCfg.persona_name,
			node_id: "left",
			status: "success",
			summary: "Left draft completed and awaiting review.",
		}, "not_required", new Date().toISOString()),
	);
	const rightProgressNow = Date.now();
	atomicJson(join(runV2.manifest.session_dir, `${rightCfg.instance_id}.progress.json`), {
		attempt_id: rightAttemptId,
		token: runV2.manifest.token,
		started_at: rightProgressNow - 2_000,
		updated_at: rightProgressNow,
		state: "working",
	});

	// Seed one direction request + one pending proposal on alpha so Requests and Proposals views have data.
	const reqDb = openRequestDatabase(statePath);
	try {
		inTransaction(reqDb, () => {
			createRequest(reqDb, {
				request_id: "req-manual-1",
				factory_id: alpha.factory_id,
				input_id: runV2.input_id,
				attempt_id: runV2.attempt_id,
				task_id: runV2.task_id,
				node_id: "merge",
				node_attempt_id: `${mergeCfg.instance_id}.1`,
				question: "Approve merge step for manual acceptance check?",
				reason: "Operator review checkpoint",
				evidence: ["Bound to v2"],
				choices: ["ship"],
				created_at: new Date().toISOString(),
			});
			insertProposalRow(reqDb, buildProposalRow({
				proposal_id: "prop-manual-1",
				factory_id: alpha.factory_id,
				reference: "prop-ref-manual-1",
				proposal_action: "add",
				source: "agent",
				target_constraint_id: null,
				assigned_constraint_id: null,
				text: "Run unit checks before merge approval",
				run_id: runV1.task_id,
				attempt_id: initCfg.instance_id,
				evidence_ref: "result:init",
				note: null,
				conflicting_ids: "[]",
				canonical_checkout: cwd,
				outcome: "pending",
				duplicate_of: null,
				rejection_reason: null,
				proposed_at: new Date().toISOString(),
				decided_at: null,
				decided_by: null,
				file_sync_state: null,
				expected_before_digest: null,
				expected_after_digest: null,
				committed_entry_json: null,
				sync_error: null,
				eligibility_json: JSON.stringify({
					kind: "intervention",
					factory_attempt_id: runV1.attempt_id,
					attempt_id: initCfg.instance_id,
					evidence_ref: "result:init",
					verified_at: new Date().toISOString(),
				}),
			}));
		});
	} finally {
		reqDb.close();
	}

	// Dedicated manual Attempt output run. Keep the existing five-scenario fixture unchanged;
	// this separate checkout has three finished attempts in an unfinalized review loop, so both members stay parked.
	const outputCwd = join(root, "project-attempt-output");
	mkdirSync(join(outputCwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(outputCwd, "extensions"), { recursive: true });
	writeFileSync(join(outputCwd, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read,bash\n---\nFixture persona builder\n");
	writeFileSync(join(outputCwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read,bash\n---\nFixture persona reviewer\n");
	writeFileSync(join(outputCwd, "extensions", "coms.ts"), "export default function () {}\n");
	const outputDraft: GenerateRequest = {
		project_cwd: outputCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_OUTPUT_PROMPT",
		agents: [
			{ node_id: "attempt_history", persona: "builder", sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_HISTORY" },
			{
				node_id: "attempt_review",
				persona: "reviewer",
				depends_on: ["attempt_history"],
				sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_REVIEW",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "attempt_history", max_revisions: 2, on_exhausted: "needs_attention" },
			},
			{ node_id: "command_exit", kind: "command", command: "fixture-fake-command", args: ["--recorded-exit"], working_directory: outputCwd, sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_COMMAND_EXIT" },
			{ node_id: "command_signal", kind: "command", command: "fixture-fake-signal-command", args: ["--recorded-signal"], working_directory: outputCwd, sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_COMMAND_SIGNAL" },
			{ node_id: "missing_result", persona: "builder", sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_MISSING" },
			{ node_id: "still_running", persona: "builder", sub_task: "SENTINEL_MANUAL_OUTPUT_SUB_RUNNING" },
		],
	};
	const outputFactory = ops({ action: "publish", name: "attempt-output-manual", draft: outputDraft, sessionModel });
	const authOutput = createManagerAuthority({ pi_session_id: "manual-attempt-output" });
	ops({ action: "resume", factory_id: outputFactory.factory_id, authority: authOutput });
	ops({ action: "submit", factory_id: outputFactory.factory_id, authority: authOutput, reference: "ref-attempt-output", brief: "SENTINEL_MANUAL_OUTPUT_BRIEF" });
	const outputRun = await ops({ action: "launch", factory_id: outputFactory.factory_id, authority: authOutput });
	checkAborted();
	revokeManagerAuthority(authOutput);
	const outputDir = outputRun.manifest.session_dir;
	const outputEntry = (nodeId: string) => outputRun.manifest.pane_manifest.find(entry => entry.node_id === nodeId)!;
	const historyEntry = outputEntry("attempt_history");
	const reviewEntryOutput = outputEntry("attempt_review");
	const historyCfg = readJson<WorkerConfig>(join(outputDir, `${historyEntry.instance_id}.config.json`));
	const reviewCfgOutput = readJson<WorkerConfig>(join(outputDir, `${reviewEntryOutput.instance_id}.config.json`));
	const attemptTimes = ["2026-11-28T10:00:01.000Z", "2026-11-28T10:00:02.000Z", "2026-11-28T10:00:03.000Z"];
	const historyInputDigests = new Map<number, string>();
	const structuredPathSample = "/fixture-only/structured/review.json";
	const structuredWrapSample = `STRUCTUREDCHECK${"s".repeat(640)}`;
	const historyResults = [
		{ status: "failure" as const, summary: "Attempt 1 found two synthetic checks to fix." },
		{ status: "partial" as const, summary: "Attempt 2 fixed one check; one synthetic warning remains." },
		{ status: "success" as const, summary: "Attempt 3 completed the fixture review successfully." },
	];
	for (let index = 0; index < historyResults.length; index++) {
		const attemptNumber = index + 1;
		const attemptId = `${historyEntry.instance_id}.${attemptNumber}`;
		const resultMeta = historyResults[index]!;
		const detail = [
			`Attempt ${attemptNumber} detail line one: synthetic review fixture only.`,
			`Attempt ${attemptNumber} detail line two: fake absolute path /fixture-only/review/attempt-${attemptNumber}.json.`,
			...(attemptNumber === 3 ? [`Bidirectional scrub sample: left\u202Eright.`] : [`Attempt ${attemptNumber} detail line three: readable on a narrow panel.`]),
			`Unbroken wrap sample ${attemptNumber}: WRAPCHECK${attemptNumber}${"x".repeat(640)}`,
		].join("\n");
		const config = { ...historyCfg, attempt_id: attemptId };
		const completedAt = attemptTimes[index]!;
		const historyCompletion = completionRecord(config, {
			agent_name: historyEntry.persona_name,
			node_id: "attempt_history",
			status: resultMeta.status,
			summary: resultMeta.summary,
			detail,
			verification: [{
				check_id: `fixture-check-${attemptNumber}`,
				result: attemptNumber === 1 ? "fail" : "pass",
				attempt_id: attemptId,
				completed_at: completedAt,
				scope_kind: "declared",
				applicability: "current",
				reason: `Synthetic verification for attempt ${attemptNumber}.`,
			}],
			warnings: [attemptNumber === 3
				? `Synthetic warning path ${structuredPathSample}; WRAPWARNING${"w".repeat(640)}`
				: `Synthetic warning recorded for attempt ${attemptNumber}.`],
			next_steps: [attemptNumber === 3
				? `Review the fixture path ${structuredPathSample}; WRAPNEXTSTEP${"n".repeat(640)}`
				: `Review the fixture's attempt ${attemptNumber} notes.`],
			outputs: {
				review_iteration: attemptNumber,
				outcome: resultMeta.status,
				fixture_only: true,
				...(attemptNumber === 3 ? { sample_path: structuredPathSample, wrap_sample: structuredWrapSample } : {}),
			},
		}, "sent", completedAt);
		atomicJson(resultPath(outputDir, attemptId), historyCompletion);
		historyInputDigests.set(attemptNumber, inputDigest(historyCompletion.result));

		const reviewAttemptId = `${reviewEntryOutput.instance_id}.${attemptNumber}`;
		const reviewConfig = { ...reviewCfgOutput, attempt_id: reviewAttemptId };
		atomicJson(resultPath(outputDir, reviewAttemptId), completionRecord(reviewConfig, {
			agent_name: reviewEntryOutput.persona_name,
			node_id: "attempt_review",
			status: "success",
			summary: attemptNumber < 3 ? `Synthetic review ${attemptNumber} requested a revision.` : "Synthetic review 3 approved the completed fixture.",
			detail: `Review-loop fixture iteration ${attemptNumber}.`,
			outputs: { verdict: attemptNumber < 3 ? "changes_requested" : "approve" },
		}, "sent", completedAt));
	}

	const writeReviewHandoffClaim = (
		destination: typeof historyEntry | typeof reviewEntryOutput,
		destinationAttempt: number,
		source: typeof historyEntry | typeof reviewEntryOutput,
		sourceAttempt: number,
		handoffId: string,
		digest = "0".repeat(64),
	) => atomicJson(handoffClaimPath(outputDir, `${destination.instance_id}.${destinationAttempt}`, source.instance_id), {
		version: 1,
		handoff_id: handoffId,
		state: "accepted",
		run_id: outputRun.task_id,
		source: { node_id: source.node_id, attempt_id: `${source.instance_id}.${sourceAttempt}`, instance_id: source.instance_id, session_id: `session-${source.instance_id}` },
		destination: { node_id: destination.node_id, attempt_id: `${destination.instance_id}.${destinationAttempt}`, instance_id: destination.instance_id },
		input_digest: digest,
		offer: "matched",
		accepted_at: attemptTimes[destinationAttempt - 1]!,
	});
	for (const attemptNumber of [2, 3]) {
		atomicJson(join(outputDir, `${reviewEntryOutput.instance_id}.${attemptNumber}.revision.json`), {
			version: 1,
			run_id: outputRun.task_id,
			reviewer: reviewEntryOutput.instance_id,
			attempt: attemptNumber,
		});
		writeReviewHandoffClaim(historyEntry, attemptNumber, reviewEntryOutput, attemptNumber - 1, `manual-feedback-${attemptNumber}`);
		writeReviewHandoffClaim(
			reviewEntryOutput,
			attemptNumber,
			historyEntry,
			attemptNumber,
			`manual-review-${attemptNumber}`,
			historyInputDigests.get(attemptNumber)!,
		);
	}
	writeReviewHandoffClaim(reviewEntryOutput, 1, historyEntry, 1, "manual-review-1", historyInputDigests.get(1)!);

	const commandExitEntry = outputEntry("command_exit");
	const commandExitCfg = readJson<WorkerConfig>(join(outputDir, `${commandExitEntry.instance_id}.config.json`));
	const commandExitEvidence = {
		version: 1 as const,
		command: commandExitEntry.command!,
		args: commandExitEntry.args ?? [],
		working_directory: commandExitEntry.working_directory!,
		exit_code: 17,
		signal: null,
		started_at: "2026-11-28T10:01:00.000Z",
		finished_at: "2026-11-28T10:01:01.000Z",
		duration_ms: 1000,
		stdout_bytes: Buffer.byteLength(`fixture stdout: three synthetic checks\nFake path ${structuredPathSample}\nWRAPCOMMAND${"c".repeat(640)}\n`),
		stderr_bytes: Buffer.byteLength("fixture stderr: expected sample failure\n"),
		stdout_excerpt: `fixture stdout: three synthetic checks\nFake path ${structuredPathSample}\nWRAPCOMMAND${"c".repeat(640)}\n`,
		stderr_excerpt: "fixture stderr: expected sample failure\n",
	};
	atomicJson(resultPath(outputDir, commandExitEntry.attempt_id!), completionRecord(commandExitCfg, {
		agent_name: commandExitEntry.persona_name,
		node_id: "command_exit",
		status: "failure",
		summary: "Synthetic command evidence records exit code 17.",
		detail: "Fixture-only command output; no command was run.",
		command_evidence: commandExitEvidence,
	}, "not_required", "2026-11-28T10:01:01.000Z"));

	const commandSignalEntry = outputEntry("command_signal");
	const commandSignalCfg = readJson<WorkerConfig>(join(outputDir, `${commandSignalEntry.instance_id}.config.json`));
	atomicJson(resultPath(outputDir, commandSignalEntry.attempt_id!), completionRecord(commandSignalCfg, {
		agent_name: commandSignalEntry.persona_name,
		node_id: "command_signal",
		status: "failure",
		summary: "Synthetic command evidence records SIGTERM.",
		detail: "Fixture-only signal sample; no command was run.",
		command_evidence: {
			version: 1,
			command: commandSignalEntry.command!,
			args: commandSignalEntry.args ?? [],
			working_directory: commandSignalEntry.working_directory!,
			exit_code: null,
			signal: "SIGTERM",
			started_at: "2026-11-28T10:02:00.000Z",
			finished_at: "2026-11-28T10:02:01.000Z",
			duration_ms: 1000,
			stdout_bytes: Buffer.byteLength("fixture stdout before signal\n"),
			stderr_bytes: Buffer.byteLength("fixture stderr before signal\n"),
			stdout_excerpt: "fixture stdout before signal\n",
			stderr_excerpt: "fixture stderr before signal\n",
		},
	}, "not_required", "2026-11-28T10:02:01.000Z"));

	const missingResultEntry = outputEntry("missing_result");
	atomicJson(outcomeClaimPath(outputDir, `${missingResultEntry.instance_id}.1`), {
		version: 1,
		identity: {
			run_id: outputRun.task_id,
			node_id: "missing_result",
			persona_name: missingResultEntry.persona_name,
			attempt_id: missingResultEntry.attempt_id!,
			instance_id: missingResultEntry.instance_id,
		},
		outcome: "completed",
		claimed_at: "2026-11-28T10:03:00.000Z",
	});
	const stillRunningEntry = outputEntry("still_running");
	const runningNow = Date.now();
	atomicJson(join(outputDir, `${stillRunningEntry.instance_id}.progress.json`), {
		attempt_id: stillRunningEntry.attempt_id,
		token: outputRun.manifest.token,
		started_at: runningNow - 2_000,
		updated_at: runningNow,
		state: "working",
	});

	// 2. beta-unreleased: reserved (unreleased) launch attempt on a second checkout (Scenario 2 blocked, never running).
	const betaCwd = join(root, "project-beta");
	mkdirSync(join(betaCwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(betaCwd, "extensions"), { recursive: true });
	writeFileSync(join(betaCwd, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read,bash\n---\nFixture persona builder\n");
	writeFileSync(join(betaCwd, "extensions", "coms.ts"), "export default function () {}\n");
	const betaDraft: GenerateRequest = {
		project_cwd: betaCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_BETA_PROMPT",
		agents: [{ node_id: "build", persona: "builder", sub_task: "SENTINEL_MANUAL_BETA_SUB" }],
	};
	const beta = ops({ action: "publish", name: "beta-unreleased", draft: betaDraft, sessionModel });
	const launchChild = fileURLToPath(new URL("./factory-launch-child.ts", import.meta.url));
	const betaLaunchArgs = [
		launchChild,
		JSON.stringify({
			mode: "kill-launch",
			database: statePath,
			factoryId: beta.factory_id,
			projectCwd: betaCwd,
			stateDir: join(root, "bootstrap-state"),
			home,
			bin,
			killPhase: "reserve_after_commit",
		}),
	];
	const betaGroup = spawnGroup(process.execPath, betaLaunchArgs, {
		env: { ...process.env, PATH: bin, HOME: home, PI_FACTORY_COORDINATION_DIR: root },
	});
	activeGroup = betaGroup;
	betaGroup.child.stdin.end("");
	const betaTimer = setTimeout(() => { void betaGroup.stop(0); }, 10_000);
	let betaKilled: { code: number | null; signal: NodeJS.Signals | null };
	try {
		betaKilled = await betaGroup.closed;
	} finally {
		clearTimeout(betaTimer);
		activeGroup = undefined;
	}
	checkAborted();
	if (betaKilled.signal !== "SIGKILL") {
		throw new Error(`Expected beta-unreleased child to be SIGKILLed at reserve_after_commit (signal=${betaKilled.signal}, code=${betaKilled.code})`);
	}

	// 3. gamma-uncertain: contradictory release evidence (Scenario 2 & 3 uncertain).
	const gammaCwd = join(root, "project-gamma");
	mkdirSync(join(gammaCwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(gammaCwd, "extensions"), { recursive: true });
	writeFileSync(join(gammaCwd, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read,bash\n---\nFixture persona builder\n");
	writeFileSync(join(gammaCwd, "extensions", "coms.ts"), "export default function () {}\n");
	const gammaDraft: GenerateRequest = {
		project_cwd: gammaCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_GAMMA_PROMPT",
		agents: [{ node_id: "build", persona: "builder", sub_task: "SENTINEL_MANUAL_GAMMA_SUB" }],
	};
	const gamma = ops({ action: "publish", name: "gamma-uncertain", draft: gammaDraft, sessionModel });
	const authGamma = createManagerAuthority({ pi_session_id: "manual-gamma" });
	ops({ action: "resume", factory_id: gamma.factory_id, authority: authGamma });
	ops({ action: "submit", factory_id: gamma.factory_id, authority: authGamma, reference: "ref-gamma-contradictory", brief: "SENTINEL_MANUAL_GAMMA_BRIEF" });
	const gammaRun = await ops({ action: "launch", factory_id: gamma.factory_id, authority: authGamma });
	checkAborted();
	revokeManagerAuthority(authGamma);
	rmSync(join(gammaRun.manifest.session_dir, "release.json"), { force: true });

	// 4. delta-unmanaged: published unmanaged factory (Scenario 3 switch target & typed "not applicable").
	const delta = ops({ action: "publish", name: "delta-unmanaged", draft: v1Draft, sessionModel });

	// 5. epsilon-versions: v1, v2 (settled run then damaged definition), v3 (restored from v1), v4 (current).
	const epsCwd = join(root, "project-epsilon");
	mkdirSync(join(epsCwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(epsCwd, "extensions"), { recursive: true });
	writeFileSync(join(epsCwd, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read,bash\n---\nFixture persona builder\n");
	writeFileSync(join(epsCwd, "extensions", "coms.ts"), "export default function () {}\n");
	const epsV1: GenerateRequest = {
		project_cwd: epsCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_EPS_V1",
		agents: [{ node_id: "step_one", persona: "builder", sub_task: "SENTINEL_MANUAL_EPS_SUB1" }],
	};
	const epsV2: GenerateRequest = {
		project_cwd: epsCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_EPS_V2",
		agents: [{ node_id: "step_two", persona: "builder", sub_task: "SENTINEL_MANUAL_EPS_SUB2" }],
	};
	const epsV4: GenerateRequest = {
		project_cwd: epsCwd,
		topology: "graph",
		task: "SENTINEL_MANUAL_EPS_V4",
		agents: [{ node_id: "step_four", persona: "builder", sub_task: "SENTINEL_MANUAL_EPS_SUB4" }],
	};
	const epsilon = ops({ action: "publish", name: "epsilon-versions", draft: epsV1, sessionModel });
	const authEps = createManagerAuthority({ pi_session_id: "manual-epsilon" });
	ops({ action: "resume", factory_id: epsilon.factory_id, authority: authEps });
	ops({ action: "update", factory_id: epsilon.factory_id, authority: authEps, draft: epsV2, sessionModel });
	ops({ action: "submit", factory_id: epsilon.factory_id, authority: authEps, reference: "ref-eps-v2", brief: "SENTINEL_MANUAL_EPS_BRIEF_V2" });
	const epsRun = await ops({ action: "launch", factory_id: epsilon.factory_id, authority: authEps });
	checkAborted();
	const epsNode = epsRun.manifest.pane_manifest[0]!;
	const epsWorkerCfg = readJson<WorkerConfig>(join(epsRun.manifest.session_dir, `${epsNode.instance_id}.config.json`));
	atomicJson(
		resultPath(epsRun.manifest.session_dir, epsNode.instance_id),
		completionRecord(epsWorkerCfg, {
			agent_name: epsNode.persona_name,
			node_id: "step_two",
			status: "success",
			summary: "Completed v2 run before v2 definition damage.",
		}, "not_required", new Date().toISOString()),
	);
	await ops({ action: "settle_run", factory_id: epsilon.factory_id, authority: authEps });
	checkAborted();
	ops({ action: "restore", factory_id: epsilon.factory_id, authority: authEps, from_version: "v1" });
	ops({ action: "update", factory_id: epsilon.factory_id, authority: authEps, draft: epsV4, sessionModel });
	revokeManagerAuthority(authEps);

	const dmgDb = new DatabaseSync(statePath);
	try {
		dmgDb.prepare("UPDATE factory_versions SET definition = '{damaged-json' WHERE factory_id = ? AND version = 'v2'").run(epsilon.factory_id);
	} finally {
		dmgDb.close();
	}

	const sentinels = [
		"SENTINEL_MANUAL_PROMPT_V1",
		"SENTINEL_MANUAL_PROMPT_V2",
		"SENTINEL_MANUAL_PROMPT_V3",
		"SENTINEL_MANUAL_SUB_INIT",
		"SENTINEL_MANUAL_SUB_LEFT",
		"SENTINEL_MANUAL_SUB_RIGHT",
		"SENTINEL_MANUAL_SUB_REVIEW",
		"SENTINEL_MANUAL_SUB_MERGE",
		"SENTINEL_MANUAL_SUB_V3",
		"SENTINEL_MANUAL_OUTPUT_PROMPT",
		"SENTINEL_MANUAL_OUTPUT_SUB_HISTORY",
		"SENTINEL_MANUAL_OUTPUT_SUB_REVIEW",
		"SENTINEL_MANUAL_OUTPUT_SUB_COMMAND_EXIT",
		"SENTINEL_MANUAL_OUTPUT_SUB_COMMAND_SIGNAL",
		"SENTINEL_MANUAL_OUTPUT_SUB_MISSING",
		"SENTINEL_MANUAL_OUTPUT_SUB_RUNNING",
		"SENTINEL_MANUAL_OUTPUT_BRIEF",
		"fixture-fake-command",
		"fixture-fake-signal-command",
		"SENTINEL_MANUAL_BRIEF_V1",
		"SENTINEL_MANUAL_BRIEF_V2",
		"SENTINEL_MANUAL_BETA_PROMPT",
		"SENTINEL_MANUAL_BETA_SUB",
		"SENTINEL_MANUAL_BETA_BRIEF",
		"SENTINEL_MANUAL_GAMMA_PROMPT",
		"SENTINEL_MANUAL_GAMMA_SUB",
		"SENTINEL_MANUAL_GAMMA_BRIEF",
		"SENTINEL_MANUAL_EPS_V1",
		"SENTINEL_MANUAL_EPS_V2",
		"SENTINEL_MANUAL_EPS_V4",
		"SENTINEL_MANUAL_EPS_SUB1",
		"SENTINEL_MANUAL_EPS_SUB2",
		"SENTINEL_MANUAL_EPS_SUB4",
		"SENTINEL_MANUAL_EPS_BRIEF_V2",
		root,
		cwd,
		outputCwd,
		betaCwd,
		gammaCwd,
		epsCwd,
		home,
	];

	return {
		root,
		cwd,
		home,
		statePath,
		coordinationPath,
		env,
		factories: {
			alphaLiveV2: alpha.factory_id,
			attemptOutput: outputFactory.factory_id,
			betaUnreleased: beta.factory_id,
			gammaUncertain: gamma.factory_id,
			deltaUnmanaged: delta.factory_id,
			epsilonVersions: epsilon.factory_id,
		},
		references: {
			alphaSettled: "ref-alpha-v1",
			alphaRunning: "ref-alpha-v2",
			betaReserved: "ref-beta-reserved",
			gammaContradictory: "ref-gamma-contradictory",
			epsilonDamagedBound: "ref-eps-v2",
		},
		run: {
			taskId: runV2.task_id,
			attemptId: runV2.attempt_id,
			sessionDir: runV2.manifest.session_dir,
			leftInstanceId: leftCfg.instance_id,
			leftAttemptId,
			rightInstanceId: rightCfg.instance_id,
			rightAttemptId,
			reviewInstanceId: reviewCfg.instance_id,
			mergeInstanceId: mergeCfg.instance_id,
			attemptOutput: {
				taskId: outputRun.task_id,
				attemptHistoryInstanceId: historyEntry.instance_id,
				commandExitInstanceId: commandExitEntry.instance_id,
				commandSignalInstanceId: commandSignalEntry.instance_id,
				missingResultInstanceId: missingResultEntry.instance_id,
				stillRunningInstanceId: stillRunningEntry.instance_id,
			},
		},
		sentinels,
		cleanup,
	};
	} catch (error) {
		cleanup();
		throw error;
	}
}

export const MAX_ADVANCE_LIVE_MS = 2 ** 31 - 1;
const USAGE = `Usage: node bootstrap/test-support/factory-viewer-manual-fixture.ts [--host 127.0.0.1|::1] [--port <0-65535>] [--advance-live-ms <1-${MAX_ADVANCE_LIVE_MS}>]`;

/**
 * Create an idempotent callback that marks node `right` in Scenario 5 as succeeded.
 * Safe to invoke multiple times (from SIGUSR1, TTY Enter, or `--advance-live-ms`).
 */
export function createLiveFixtureAdvancer(
	fixture: Pick<ManualAcceptanceFixture, "run">,
	log: (message: string) => void = console.log,
): () => boolean {
	let completed = false;
	return () => {
		if (completed) {
			log(`Node 'right' (${fixture.run.rightAttemptId}) already updated to succeeded in ${fixture.run.taskId}.`);
			return false;
		}
		completed = true;
		const rightCfg = readJson<WorkerConfig>(join(fixture.run.sessionDir, `${fixture.run.rightInstanceId}.config.json`));
		const completedAt = new Date().toISOString();
		atomicJson(
			resultPath(fixture.run.sessionDir, fixture.run.rightAttemptId),
			completionRecord(rightCfg, {
				agent_name: rightCfg.persona_name,
				node_id: "right",
				status: "success",
				summary: "Synthetic right-branch completion during the live manual check.",
				detail: [
					"Synthetic live-completion detail; this fixture runs no model.",
					"FAKE_DETAIL_LINE_2: the output appears after the next poll.",
					"- FAKE_DETAIL_LIST_ITEM: all values are illustrative.",
				].join("\n"),
				verification: [{
					check_id: "FAKE_LIVE_CHECK",
					result: "pass",
					attempt_id: fixture.run.rightAttemptId,
					completed_at: completedAt,
					scope_kind: "declared",
					applicability: "current",
					reason: "FAKE_VERIFICATION: synthetic fixture check passed.",
				}],
				warnings: ["FAKE_WARNING: synthetic manual acceptance data only."],
				next_steps: ["FAKE_NEXT_STEP: continue the manual browser check."],
				outputs: {
					fixture_only: true,
					fake_id: "FAKE_STRUCTURED_OUTPUT_05",
					values: ["FAKE_VALUE_ALPHA", "FAKE_VALUE_BETA"],
				},
			}, "not_required", completedAt),
		);
		log(`Updated node 'right' (${fixture.run.rightAttemptId}) to succeeded in ${fixture.run.taskId}.`);
		return true;
	};
}

export function parseManualFixtureArgs(args: string[]): { help?: true; host: string; port: number; advanceLiveAfterMs: number | null } {
	let host = "127.0.0.1";
	let port = 0;
	let advanceLiveAfterMs: number | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--help" || arg === "-h") {
			return { help: true, host, port, advanceLiveAfterMs };
		}
		if (arg === "--host") {
			const val = args[++i];
			if (!val || (val !== "127.0.0.1" && val !== "::1")) {
				throw new Error(`Invalid --host: ${val ?? "(missing)"}\n${USAGE}`);
			}
			host = val;
		} else if (arg === "--port") {
			const raw = args[++i];
			if (!raw || !/^\d+$/.test(raw) || Number(raw) > 65535) {
				throw new Error(`Invalid --port: ${raw ?? "(missing)"}\n${USAGE}`);
			}
			port = Number(raw);
		} else if (arg === "--advance-live-ms") {
			const raw = args[++i];
			if (!raw || !/^[1-9]\d*$/.test(raw)) {
				throw new Error(`Invalid --advance-live-ms: ${raw ?? "(missing)"}\n${USAGE}`);
			}
			const parsedMs = Number(raw);
			if (!Number.isSafeInteger(parsedMs) || parsedMs > MAX_ADVANCE_LIVE_MS) {
				throw new Error(`Invalid --advance-live-ms: ${raw} (must be 1..${MAX_ADVANCE_LIVE_MS})\n${USAGE}`);
			}
			advanceLiveAfterMs = parsedMs;
		} else {
			throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
		}
	}
	return { host, port, advanceLiveAfterMs };
}

async function runCli() {
	const parsed = parseManualFixtureArgs(process.argv.slice(2));
	if (parsed.help) {
		console.log(USAGE);
		return;
	}
	const { host, port, advanceLiveAfterMs } = parsed;
	let fixtureCleanup: (() => void) | undefined;
	let abortFixtureBuild: (() => Promise<void>) | undefined;
	let viewer: Awaited<ReturnType<typeof startViewer>> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closing = false;
	let onSigUsr1: (() => void) | undefined;
	let onStdinData: ((chunk: string) => void) | undefined;
	let buildPromise: Promise<ManualAcceptanceFixture> | undefined;

	const removeSignalHandlers = () => {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGHUP", stop);
		if (onSigUsr1) process.removeListener("SIGUSR1", onSigUsr1);
		if (onStdinData) {
			process.stdin.removeListener("data", onStdinData);
			process.stdin.pause();
		}
	};

	const stop = () => {
		if (closing) return;
		closing = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		removeSignalHandlers();
		const buildDone = buildPromise ? buildPromise.catch(() => undefined) : Promise.resolve();
		void (async () => {
			if (abortFixtureBuild) await abortFixtureBuild().catch(() => {});
			await buildDone;
			if (viewer) await viewer.close().catch(() => {});
			fixtureCleanup?.();
		})().finally(() => {
			process.exit(0);
		});
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);

	try {
		buildPromise = createManualAcceptanceFixture(undefined, {
			onCleanupReady: (cleanup, abortBuild) => {
				fixtureCleanup = cleanup;
				abortFixtureBuild = abortBuild;
			},
		});
		const fixture = await buildPromise;
		if (closing) return;

		viewer = await startViewer({
			statePath: fixture.statePath,
			coordinationPath: fixture.coordinationPath,
			env: fixture.env,
			home: fixture.home,
			host,
			port,
		});
		if (closing) return;

		const advanceOnce = createLiveFixtureAdvancer(fixture);
		const triggerAdvance = () => {
			if (closing) return;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			advanceOnce();
		};
		onSigUsr1 = triggerAdvance;
		process.on("SIGUSR1", onSigUsr1);
		if (process.stdin.isTTY) {
			process.stdin.setEncoding("utf8");
			onStdinData = (chunk: string) => {
				if (chunk.includes("\n") || chunk.includes("\r")) {
					triggerAdvance();
				}
			};
			process.stdin.on("data", onStdinData);
			process.stdin.resume();
		}

		console.log(`Factory Viewer (isolated temp fixture): ${viewer.url}`);
		console.log(`PID: ${process.pid}`);
		console.log(`Temp root (deleted on exit): ${fixture.root}`);
		console.log(`  Scenario 1/4/5 (alpha, v2 running / v3 current): ${viewer.url}/?factory=${fixture.factories.alphaLiveV2}&view=live`);
		console.log(`  Attempt output (review history and commands):    ${viewer.url}/?factory=${fixture.factories.attemptOutput}&view=live`);
		console.log(`  Scenario 2a    (beta, reserved/blocked):         ${viewer.url}/?factory=${fixture.factories.betaUnreleased}&view=live`);
		console.log(`  Scenario 2b/3  (gamma, contradictory/uncertain): ${viewer.url}/?factory=${fixture.factories.gammaUncertain}&view=live`);
		console.log(`  Scenario 3/4   (delta, unmanaged/blocked):       ${viewer.url}/?factory=${fixture.factories.deltaUnmanaged}&view=live`);
		console.log(`  Inspect/Queue  (epsilon, v2 damaged, v3<-v1):    ${viewer.url}/?factory=${fixture.factories.epsilonVersions}&view=inspect&version=v3`);
		console.log(`  Receipt lookup (alpha settled v1):               ${viewer.url}/?factory=${fixture.factories.alphaLiveV2}&view=receipts&reference=${fixture.references.alphaSettled}`);
		console.log(`  Scenario 5 trigger (when ready):                 kill -USR1 ${process.pid}${process.stdin.isTTY ? " (or press Enter here)" : ""}`);

		if (advanceLiveAfterMs !== null) {
			console.log(`  Scenario 5 timer armed:                          ${advanceLiveAfterMs} ms from helper launch`);
			timer = setTimeout(triggerAdvance, advanceLiveAfterMs);
		}
	} catch (error) {
		if (closing) return;
		removeSignalHandlers();
		if (timer) clearTimeout(timer);
		await viewer?.close().catch(() => {});
		fixtureCleanup?.();
		throw error;
	}
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	runCli().catch(err => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	});
}
