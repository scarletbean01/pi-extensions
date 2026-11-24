#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type test from "node:test";
import { createRequest, inTransaction, openRequestDatabase } from "../factory-requests.ts";
import { buildProposalRow, insertProposalRow } from "../constraint-proposals.ts";
import { atomicJson, completionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "../session-store.ts";
import { BootstrapService, type ExecResult, type GenerateRequest } from "../lifecycle.ts";
import { runSupervised } from "../test-harness.ts";
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
		rightInstanceId: string;
		reviewInstanceId: string;
		mergeInstanceId: string;
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

/**
 * Create a self-contained temporary fixture state directory covering manual acceptance
 * scenarios 1-5 without touching ~/.pi/agent.
 */
export async function createManualAcceptanceFixture(t?: test.TestContext): Promise<ManualAcceptanceFixture> {
	const root = mkdtempSync(join(tmpdir(), "factory-viewer-manual-"));
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	if (t) t.after(cleanup);

	const { cwd, home, bin, service } = createIsolatedService(root, ["builder", "reviewer"]);
	const statePath = join(root, "factories.sqlite");
	const coordinationPath = join(root, "factory-coordination.sqlite");
	const env: NodeJS.ProcessEnv = { PATH: bin };
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

	ops({ action: "update", factory_id: alpha.factory_id, authority: authAlpha, draft: v2Draft, sessionModel });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: authAlpha, reference: "ref-alpha-v2", brief: "SENTINEL_MANUAL_BRIEF_V2" });
	const runV2 = await ops({ action: "launch", factory_id: alpha.factory_id, authority: authAlpha });
	ops({ action: "update", factory_id: alpha.factory_id, authority: authAlpha, draft: v3Draft, sessionModel });
	revokeManagerAuthority(authAlpha);

	const leftCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "left")!;
	const rightCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "right")!;
	const reviewCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const mergeCfg = runV2.manifest.pane_manifest.find(m => m.node_id === "merge")!;

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
	const betaKilled = await runSupervised(process.execPath, [
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
	], {
		env: { ...process.env, PATH: bin, HOME: home, PI_FACTORY_COORDINATION_DIR: root },
		timeoutMs: 10_000,
	});
	if (betaKilled.signal !== "SIGKILL") {
		throw new Error(`Expected beta-unreleased child to be SIGKILLed at reserve_after_commit: ${betaKilled.stderr}`);
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
			rightInstanceId: rightCfg.instance_id,
			reviewInstanceId: reviewCfg.instance_id,
			mergeInstanceId: mergeCfg.instance_id,
		},
		sentinels,
		cleanup,
	};
}

async function runCli() {
	const args = process.argv.slice(2);
	let host = "127.0.0.1";
	let port = 0;
	let advanceLiveAfterMs: number | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--host" && args[i + 1]) host = args[++i]!;
		else if (arg === "--port" && args[i + 1]) {
			const raw = args[++i]!;
			if (!/^\d+$/.test(raw)) throw new Error(`Invalid --port: ${raw}`);
			port = Number(raw);
		}
		else if (arg === "--advance-live-ms" && args[i + 1]) advanceLiveAfterMs = Number(args[++i]!);
	}
	const fixture = await createManualAcceptanceFixture();
	const viewer = await startViewer({
		statePath: fixture.statePath,
		coordinationPath: fixture.coordinationPath,
		env: fixture.env,
		home: fixture.home,
		host,
		port,
	});
	console.log(`Factory Viewer (isolated temp fixture): ${viewer.url}`);
	console.log(`Temp root (deleted on exit): ${fixture.root}`);
	console.log(`  Scenario 1/4/5 (alpha, v2 running / v3 current): ${viewer.url}/?factory=${fixture.factories.alphaLiveV2}&view=live`);
	console.log(`  Scenario 2a    (beta, reserved/blocked):         ${viewer.url}/?factory=${fixture.factories.betaUnreleased}&view=live`);
	console.log(`  Scenario 2b/3  (gamma, contradictory/uncertain): ${viewer.url}/?factory=${fixture.factories.gammaUncertain}&view=live`);
	console.log(`  Scenario 3/4   (delta, unmanaged/idle):          ${viewer.url}/?factory=${fixture.factories.deltaUnmanaged}&view=live`);
	console.log(`  Inspect/Queue  (epsilon, v2 damaged, v3<-v1):    ${viewer.url}/?factory=${fixture.factories.epsilonVersions}&view=inspect&version=v3`);
	console.log(`  Receipt lookup (alpha settled v1):               ${viewer.url}/?factory=${fixture.factories.alphaLiveV2}&view=receipts&reference=${fixture.references.alphaSettled}`);

	let timer: ReturnType<typeof setTimeout> | undefined;
	if (advanceLiveAfterMs !== null && Number.isFinite(advanceLiveAfterMs) && advanceLiveAfterMs > 0) {
		timer = setTimeout(() => {
			const leftCfg = readJson<WorkerConfig>(join(fixture.run.sessionDir, `${fixture.run.leftInstanceId}.config.json`));
			atomicJson(
				resultPath(fixture.run.sessionDir, fixture.run.leftInstanceId),
				completionRecord(leftCfg, {
					agent_name: leftCfg.agent_name,
					node_id: "left",
					status: "success",
					summary: "Left branch succeeded during live manual check.",
				}, "not_required", new Date().toISOString()),
			);
			console.log(`Updated node 'left' to succeeded in ${fixture.run.taskId}.`);
		}, advanceLiveAfterMs);
	}

	let closing = false;
	const stop = () => {
		if (closing) return;
		closing = true;
		if (timer) clearTimeout(timer);
		void viewer.close().finally(() => {
			fixture.cleanup();
			process.exit(0);
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	runCli().catch(err => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	});
}
