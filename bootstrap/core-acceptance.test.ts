/**
 * Core release gate composition tests (Ticket 13).
 * Exercises combined end-to-end behaviour across tickets 01–09 through the public service,
 * extension tool, and worker hook seams, plus disabled optional capabilities and unsupported records.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, readJson, readyPath, resultPath, parseWorkerConfig, type WorkerConfig } from "./session-store.ts";
import { buildMarkdownReport } from "./reporting.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	if (specifier === "@sinclair/typebox") return { url: typeboxUrl, shortCircuit: true };
	return next(specifier, context);
} });
const { default: registerExtension } = await import("../bootstrap.ts");
const { default: registerWorker } = await import("./worker.ts");

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }
const TEST_MODEL = { provider: "provider", id: "model" };

function createCompositionFixture(t: test.TestContext, options: { initGit?: boolean; now?: () => number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-core-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), join(cwd, "src"), bin]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd, "src", "api.ts"), "export const api = 1;\n");
	writeFileSync(join(cwd, "src", "ui.ts"), "export const ui = 1;\n");
	for (const name of ["reviewer", "implementer", "verifier", "writer"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	}
	if (options.initGit) {
		execFileSync("git", ["init"], { cwd, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
		execFileSync("git", ["add", "src/api.ts", "src/ui.ts"], { cwd, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
		// Leave an uncommitted dirty file to prove shared_cwd works without snapshots or automatic worktrees.
		writeFileSync(join(cwd, "dirty-uncommitted.txt"), "user work in progress\n");
	}
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
	const herdrCommands: string[][] = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		herdrCommands.push(args);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = {
				tab_id: `t${seq}`,
				pane_id: `p${seq}`,
				terminal_id: `term${seq}`,
				label: args[args.indexOf("--label") + 1],
				cwd: args[args.indexOf("--cwd") + 1],
			};
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(item => item.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			const ready = {
				task_id: task, token: config.token, instance_id: instance, name: instance,
				pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model,
			};
			atomicJson(readyPath(sessionDir, instance), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") {
			const idx = tabs.findIndex(tab => tab.tab_id === args[2] || tab.pane_id === args[2]);
			if (idx >= 0) tabs.splice(idx, 1);
			return ok();
		}
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({
		exec, extensionDir, stateDir, home, pollMs: 5, statusPollMs: 10, now: options.now,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	return { root, cwd, home, stateDir, service, tabs, configs, herdrCommands };
}

function workerFromConfig(
	t: test.TestContext,
	configPath: string,
	overrides: { tools?: string[]; executeTool?: (name: string, params: unknown) => Promise<any>; shutdownOnReload?: boolean } = {},
) {
	const config = readJson<WorkerConfig>(configPath);
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = overrides.tools ?? ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const deliveredMessages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const context = {
		model: TEST_MODEL,
		ui: { notify: (text: string, level = "info") => notifications.push({ text, level }) },
		shutdown: () => { shutdowns++; },
		abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return overrides.executeTool ? overrides.executeTool(name, params) : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {},
		getFlag: (name: string) => name === "bootstrap-worker-config" ? configPath : undefined,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: any, options: any) => { deliveredMessages.push({ message, options }); },
	} as any);
	if (overrides.shutdownOnReload !== false) {
		t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); });
	}
	return {
		config, hooks, tools, context, sent, deliveredMessages, notifications,
		get active() { return active; },
		get shutdowns() { return shutdowns; },
		get aborts() { return aborts; },
		start: (event: Record<string, unknown> = {}) => hooks.get("session_start")!(event, context),
		input: (text: string) => hooks.get("input")!({ text }, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		toolCall: (toolName: string, input: Record<string, unknown> = {}, parentToolCallId?: string) =>
			hooks.get("tool_call")!({ toolName, input, parentToolCallId }, context),
		settled: (event: Record<string, unknown> = {}) => hooks.get("agent_settled")!(event, context),
		shutdown: (event: Record<string, unknown> = { reason: "exit" }) => hooks.get("session_shutdown")!(event, context),
		complete: (params: Record<string, unknown>) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
		readInput: (params: Record<string, unknown>) => tools.get("bootstrap_read_input").execute("id", params, undefined, undefined, context),
		verify: (params: Record<string, unknown>) => tools.get("bootstrap_verify").execute("id", params, undefined, undefined, context),
	};
}

// ---- Slice 1: Disabled optional capabilities & unsupported/binary records ----

test("core release keeps optional capabilities unreachable and rejects unsupported or binary-style records", async t => {
	// 1. Registered extension exposes only the 6 core tools and /boot command.
	const registeredTools: Array<{ name: string; parameters?: any }> = [];
	const registeredCommands: string[] = [];
	registerExtension({
		registerTool: (tool: any) => registeredTools.push(tool),
		registerCommand: (name: string) => registeredCommands.push(name),
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	assert.deepEqual(registeredTools.map(t => t.name).sort(), [
		"bootstrap_cancel", "bootstrap_cleanup", "bootstrap_generate",
		"bootstrap_recover", "bootstrap_report", "bootstrap_status",
	]);
	assert.deepEqual(registeredCommands, ["boot"]);
	const generateProps = Object.keys(registeredTools.find(t => t.name === "bootstrap_generate")!.parameters.args[0]);
	for (const disallowed of ["workspace_strategy", "synthesis", "supervisor", "lazy_launch", "max_revisions", "max_concurrency"]) {
		assert.equal(generateProps.includes(disallowed), false, `optional capability ${disallowed} must not be exposed`);
	}

	// 2. Service rejects unsupported topology or optional workspace_strategy before creating files/tabs.
	const f = createCompositionFixture(t, { initGit: true });
	assert.throws(() => f.service.plan({
		topology: "mesh" as any,
		task: "Unsupported",
		project_cwd: f.cwd,
		agents: [{ node_id: "a", persona: "reviewer", sub_task: "x" }],
	}, TEST_MODEL), /Invalid topology/);
	assert.throws(() => f.service.plan({
		topology: "team",
		workspace_strategy: "git-worktree",
		task: "Unsupported worktree",
		project_cwd: f.cwd,
		agents: [{ node_id: "a", persona: "reviewer", sub_task: "x" }],
	} as GenerateRequest, TEST_MODEL), /workspace_strategy/i);
	assert.equal(f.herdrCommands.length, 0);
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);

	// 3. Persisted manifests/configs with unsupported optional fields or binary/future records are rejected, not misread.
	const run = await f.service.generate({
		topology: "chain",
		task: "Valid core run",
		project_cwd: f.cwd,
		request_id: "core-unsupported-check",
		agents: [
			{ node_id: "step1", persona: "implementer", sub_task: "step 1" },
			{ node_id: "step2", persona: "reviewer", sub_task: "step 2" },
		],
	}, TEST_MODEL);
	// Unsupported optional strategies/topologies must also refuse worker startup.
	const savedConfig = readJson<any>(join(run.session_dir, "a1-step1.config.json"));
	assert.throws(() => parseWorkerConfig({ ...savedConfig, workspace_strategy: "git-worktree" }), /workspace_strategy/i);
	assert.throws(() => parseWorkerConfig({ ...savedConfig, topology: "graph" }), /Unsupported worker topology/);
	const indexFile = join(f.stateDir, `${run.task_id}.json`);
	const originalManifestText = readFileSync(indexFile, "utf8");

	// A graph persisted by a future release must never be executed as a team/chain.
	writeFileSync(indexFile, JSON.stringify({ ...readJson<any>(indexFile), topology: "graph" }));
	assert.throws(() => f.service.status(run.task_id), /Unsupported topology/);
	await assert.rejects(f.service.cleanup(run.task_id), /Unsupported topology/);
	assert.equal(f.tabs.length, 2);
	writeFileSync(indexFile, originalManifestText);

	// Future/optional workspace_strategy on disk must not be misread as shared_cwd.
	const worktreeManifest = { ...readJson<any>(indexFile), workspace_strategy: "git-worktree" };
	writeFileSync(indexFile, JSON.stringify(worktreeManifest));
	assert.throws(() => f.service.status(run.task_id), /workspace_strategy/i);
	await assert.rejects(f.service.cleanup(run.task_id), /workspace_strategy/i);

	// Binary-style garbage bytes in manifest must fail cleanly without rewriting or closing tabs.
	writeFileSync(indexFile, Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x42]));
	assert.throws(() => f.service.status(run.task_id));
	assert.equal(f.tabs.length, 2, "tabs must remain untouched when manifest is unreadable");
	assert.deepEqual(f.service.store.list(), []);

	// Restore valid manifest, then put binary garbage in one agent's result file: healthy agent stays visible.
	writeFileSync(indexFile, originalManifestText);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-step1.config.json"));
	await w1.start();
	await w1.beforeStart();
	await w1.complete({ status: "success", summary: "Step 1 ok", detail: "" });
	writeFileSync(resultPath(run.session_dir, "a2-step2"), Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47]));
	const status = f.service.status(run.task_id);
	assert.equal(status.agents[0].execution, "succeeded");
	assert.equal(status.agents[1].execution, "needs_attention");
	assert.match(status.agents[1].error ?? "", /unusable result file/);
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);
});

// ---- Slice 2: Ownership admission when earlier writer finishes during queued writer /reload ----

test("queued writer whose earlier conflicting writer finished during /reload still triggers on startup", async t => {
	const f = createCompositionFixture(t);
	const run = await f.service.generate({
		topology: "team",
		task: "Queued writer reload race",
		project_cwd: f.cwd,
		request_id: "reload-ownership-race",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/api.ts"], sub_task: "First writer" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Second writer" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w1.start();
	await w2.start();
	await w1.beforeStart();
	assert.equal((await w2.input(w2.config.startup_message)).action, "handled");

	// w2 shuts down for /reload, and w1 completes before w2's reloaded session_start runs.
	await w2.shutdown({ reason: "reload" });
	await w1.complete({ status: "success", summary: "First writer done", detail: "" });

	const w2Reloaded = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w2Reloaded.start({ reason: "reload" });
	assert.equal(w2Reloaded.deliveredMessages.length, 1, "reloaded writer must receive bootstrap-ownership-admit when predecessor finished during reload");
	assert.equal(w2Reloaded.deliveredMessages[0].message.customType, "bootstrap-ownership-admit");
	const p2 = await w2Reloaded.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: w2Reloaded.deliveredMessages[0].message,
	});
	assert.match(p2.systemPrompt, /Second writer/);
});

// ---- Matrix Rows 1, 2, 10, 11 + Zero automatic worktrees ----

test("composition: 3-stage repeat-persona chain in dirty git repo exercises briefs, contracts, verification, handoffs, report, and selective cleanup with zero worktrees", async t => {
	const f = createCompositionFixture(t, { initGit: true });
	const request: GenerateRequest = {
		topology: "chain",
		task: "Harden API module",
		goal: "Ship verified API update without worktrees",
		acceptance_criteria: ["API review passes", "Tests pass"],
		constraints: ["Work in shared_cwd only"],
		project_cwd: f.cwd,
		request_id: "core-comp-chain-1",
		agents: [
			{
				node_id: "review-api",
				persona: "reviewer",
				role: "Initial API reviewer",
				ownership: ["src/api.ts"],
				read_paths: ["src/api.ts"],
				output_contract: { required_fields: ["finding"], require_artifacts: true },
				required_checks: ["lint"],
				sub_task: "Review src/api.ts and produce brief",
			},
			{
				node_id: "implement-api",
				persona: "implementer",
				role: "API implementer",
				write_paths: ["src/api.ts"],
				required_checks: ["tests"],
				sub_task: "Update src/api.ts and run tests",
			},
			{
				node_id: "review-final",
				persona: "reviewer",
				role: "Final reviewer",
				read_paths: ["src/api.ts"],
				sub_task: "Verify final result against initial review",
			},
		],
	};

	const preview = f.service.plan(request, TEST_MODEL);
	assert.equal(preview.workspace_strategy, "shared_cwd");
	assert.equal(preview.collaboration_mode, "independent");
	assert.deepEqual(preview.agents.map(a => [a.node_id, a.persona_name, a.dependency_policy]), [
		["review-api", "reviewer", undefined],
		["implement-api", "implementer", "require_success"],
		["review-final", "reviewer", "require_success"],
	]);
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);

	const run = await f.service.generate(request, TEST_MODEL);
	assert.equal(run.workspace_strategy, "shared_cwd");
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-review-api.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-implement-api.config.json"));
	const w3 = workerFromConfig(t, join(run.session_dir, "a3-review-final.config.json"));
	await w1.start();
	await w2.start();
	await w3.start();

	// Stage 1 runs verification, produces artifact + structured output, hands off to Stage 2.
	const p1 = await w1.beforeStart();
	assert.match(p1.systemPrompt, /Goal: Ship verified API update without worktrees/);
	assert.match(p1.systemPrompt, /Your role: Initial API reviewer/);
	writeFileSync(join(f.cwd, "review-notes.md"), "API note: add validation\n");
	await w1.verify({ action: "start", check_id: "lint", scope: ["src/api.ts"] });
	await w1.verify({ action: "finish", check_id: "lint", result: "pass" });
	const c1 = await w1.complete({
		status: "success",
		summary: "Reviewed API",
		detail: "Needs validation",
		outputs: { finding: "add-validation" },
		artifacts: [{ type: "file", path: "review-notes.md", action: "created", description: "Review notes" }],
	});
	assert.equal(c1.isError, undefined);

	// Queued handoff is not yet accepted until w2 claims it.
	let status = f.service.status(run.task_id);
	assert.equal(status.agents[1].handoff?.state, "queued");
	assert.equal(status.agents[1].execution, "waiting");

	// Stage 2 claims handoff before model work, edits src/api.ts, runs tests check, completes.
	const p2 = await w2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-review-api" }, content: w1.sent[0].params.prompt },
	});
	assert.match(p2.systemPrompt, /Accepted handoff: h-/);
	assert.match(p2.systemPrompt, /add-validation/);
	writeFileSync(join(f.cwd, "src", "api.ts"), "export const api = 2;\n");
	await w2.verify({ action: "start", check_id: "tests", scope: ["src/api.ts"] });
	await w2.verify({ action: "finish", check_id: "tests", result: "pass" });
	await w2.complete({
		status: "success",
		summary: "Updated API",
		detail: "Implemented validation",
		artifacts: [{ type: "file", path: "src/api.ts", action: "modified", description: "Updated API" }],
	});

	// Stage 3 claims handoff, reads Stage 1's full result and verified artifact, completes.
	const p3 = await w3.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a2-implement-api" }, content: w2.sent[0].params.prompt },
	});
	assert.match(p3.systemPrompt, /Accepted handoff: h-/);
	const stage1Read = await w3.readInput({ kind: "result", node_id: "review-api" });
	assert.match(stage1Read.content[0].text, /add-validation/);
	const artifactRead = await w3.readInput({ kind: "artifact", node_id: "review-api", path: "review-notes.md" });
	assert.match(artifactRead.content[0].text, /API note: add validation/);
	await w3.complete({ status: "success", summary: "Final review passed", detail: "All checks current" });

	status = f.service.status(run.task_id);
	assert.equal(status.outcome.state, "succeeded");
	assert.deepEqual(status.pending, []);
	assert.equal(status.agents[0].handoff_out?.state, "accepted");
	assert.equal(status.agents[1].handoff?.state, "accepted");
	assert.equal(status.agents[2].handoff?.state, "accepted");

	const rep = await f.service.report(run.task_id, undefined, true, buildMarkdownReport);
	const jsonReport = readJson<any[]>(rep.report_json);
	assert.deepEqual(jsonReport.map(e => [e.node_id, e.agent_name, e.status]), [
		["review-api", "reviewer", "success"],
		["implement-api", "implementer", "success"],
		["review-final", "reviewer", "success"],
	]);
	assert.equal(jsonReport[0].artifacts[0].producer_node_id, "review-api");
	assert.match(jsonReport[0].artifacts[0].sha256, /^[0-9a-f]{64}$/);
	assert.match(readFileSync(rep.report_md!, "utf8"), /run outcome: succeeded/);

	// Cleanup rejects shared persona name, allows node_id selection, and keeps reports.
	await assert.rejects(f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["reviewer"]), /ambiguous|multiple/i);
	const partialClean = await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, ["review-api"]);
	assert.equal(partialClean.phase, "partially-cleaned");
	assert.equal(f.tabs.length, 2);
	const fullClean = await f.service.cleanup(run.task_id);
	assert.equal(fullClean.status, "cleaned");
	assert.equal(f.tabs.length, 0);
	assert.equal(existsSync(rep.report_json), true);
	const afterCleanup = await f.service.report(run.task_id, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson(afterCleanup.report_json), jsonReport);

	// Verify git repo stayed free of automatic worktrees and dirty file untouched.
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);
	const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: f.cwd, encoding: "utf8" });
	assert.equal(worktreeList.match(/^worktree /gm)?.length, 1);
	assert.equal(readFileSync(join(f.cwd, "dirty-uncommitted.txt"), "utf8"), "user work in progress\n");
});

// ---- Matrix Rows 3, 4, 11, 14 ----

test("composition: partial/failed predecessors, stale verification evidence, and mixed terminal outcomes report causes and provenance", async t => {
	// 1. Partial predecessor: require_success blocks chain; allow_partial admits.
	const f = createCompositionFixture(t, { initGit: true });
	const chainReqSuccess = await f.service.generate({
		topology: "chain",
		task: "Partial blocks require_success",
		project_cwd: f.cwd,
		request_id: "comp-partial-block",
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Step 2" },
			{ node_id: "n3", persona: "writer", sub_task: "Step 3", dependency_policy: "allow_partial" },
		],
	}, TEST_MODEL);
	const a1 = workerFromConfig(t, join(chainReqSuccess.session_dir, "a1-n1.config.json"));
	const a2 = workerFromConfig(t, join(chainReqSuccess.session_dir, "a2-n2.config.json"));
	const a3 = workerFromConfig(t, join(chainReqSuccess.session_dir, "a3-n3.config.json"));
	await a1.start(); await a2.start(); await a3.start();
	await a1.beforeStart();
	await a1.complete({ status: "partial", summary: "Missing edge case", detail: "Incomplete" });
	await a2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: a1.sent[0].params.prompt },
	});
	// Wait briefly for n3's predecessor timer or trigger check by checking disposition after short delay.
	await new Promise(resolve => setTimeout(resolve, 1100));
	let st = f.service.status(chainReqSuccess.task_id);
	assert.equal(st.agents[0].execution, "partial");
	assert.equal(st.agents[1].execution, "blocked");
	assert.equal(st.agents[1].execution_causes[0].node_id, "n1");
	assert.equal(st.agents[2].execution, "blocked");
	assert.deepEqual(st.agents[2].execution_causes.map(c => c.node_id), ["n2", "n1"]);
	assert.equal(st.outcome.state, "blocked");
	const repBlocked = await f.service.report(chainReqSuccess.task_id, undefined, true, buildMarkdownReport);
	const blockedEntries = readJson<any[]>(repBlocked.report_json);
	assert.deepEqual(blockedEntries.map(e => [e.node_id, e.status]), [["n1", "partial"], ["n2", "blocked"], ["n3", "blocked"]]);

	// Allow_partial continues on partial predecessor.
	const chainAllowPartial = await f.service.generate({
		topology: "chain",
		task: "Allow partial continues",
		project_cwd: f.cwd,
		request_id: "comp-partial-allow",
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Step 2", dependency_policy: "allow_partial" },
		],
	}, TEST_MODEL);
	const b1 = workerFromConfig(t, join(chainAllowPartial.session_dir, "a1-n1.config.json"));
	const b2 = workerFromConfig(t, join(chainAllowPartial.session_dir, "a2-n2.config.json"));
	await b1.start(); await b2.start();
	await b1.beforeStart();
	await b1.complete({ status: "partial", summary: "Partial work", detail: "Mostly done" });
	await b2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: b1.sent[0].params.prompt },
	});
	await b2.complete({ status: "success", summary: "Finished on partial", detail: "" });
	assert.equal(f.service.status(chainAllowPartial.task_id).outcome.state, "partial");

	// Failed predecessor blocks all descendants regardless of allow_partial; original cause stays visible.
	const chainFailed = await f.service.generate({
		topology: "chain",
		task: "Failed predecessor blocks all",
		project_cwd: f.cwd,
		request_id: "comp-failed-block",
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Step 2", dependency_policy: "allow_partial" },
			{ node_id: "n3", persona: "writer", sub_task: "Step 3", dependency_policy: "allow_partial" },
		],
	}, TEST_MODEL);
	const c1 = workerFromConfig(t, join(chainFailed.session_dir, "a1-n1.config.json"));
	const c2 = workerFromConfig(t, join(chainFailed.session_dir, "a2-n2.config.json"));
	const c3 = workerFromConfig(t, join(chainFailed.session_dir, "a3-n3.config.json"));
	await c1.start(); await c2.start(); await c3.start();
	await c1.beforeStart();
	await c1.complete({ status: "failure", summary: "Build crashed", detail: "Compiler panic" });
	await c2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: c1.sent[0].params.prompt },
	});
	await new Promise(resolve => setTimeout(resolve, 1100));
	st = f.service.status(chainFailed.task_id);
	assert.equal(st.agents[1].execution, "blocked");
	assert.equal(st.agents[2].execution, "blocked");
	assert.deepEqual(st.agents[2].execution_causes.map(c => [c.node_id, c.state]), [["n2", "blocked"], ["n1", "failed"]]);
	assert.equal(st.outcome.state, "failed");

	// 2. Verification stale after relevant edit: historical result retained, stale check blocks downstream admission.
	const staleChain = await f.service.generate({
		topology: "chain",
		task: "Stale check blocks successor",
		project_cwd: f.cwd,
		request_id: "comp-stale-verify",
		agents: [
			{ node_id: "build", persona: "implementer", required_checks: ["unit"], sub_task: "Build and test" },
			{ node_id: "ship", persona: "reviewer", sub_task: "Verify and ship" },
		],
	}, TEST_MODEL);
	const v1 = workerFromConfig(t, join(staleChain.session_dir, "a1-build.config.json"));
	const v2 = workerFromConfig(t, join(staleChain.session_dir, "a2-ship.config.json"));
	await v1.start(); await v2.start();
	await v1.beforeStart();
	await v1.verify({ action: "start", check_id: "unit", scope: ["src/api.ts"] });
	await v1.verify({ action: "finish", check_id: "unit", result: "pass" });
	await v1.complete({
		status: "success",
		summary: "Tests passed",
		detail: "",
	});
	// Relevant edit happens after check passed.
	writeFileSync(join(f.cwd, "src", "api.ts"), "export const api = 999;\n");
	await v2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-build" }, content: v1.sent[0].params.prompt },
	});
	st = f.service.status(staleChain.task_id);
	assert.equal(st.agents[0].execution, "succeeded", "historical success result must be retained");
	assert.equal(st.agents[0].verification?.[0].applicability, "stale");
	assert.equal(st.agents[0].evidence?.[0].status, "stale");
	assert.equal(st.agents[1].execution, "blocked");
	assert.equal(st.agents[1].execution_causes[0].check?.evidence, "stale");
	const staleReport = await f.service.report(staleChain.task_id, undefined, true, buildMarkdownReport);
	const staleMd = readFileSync(staleReport.report_md!, "utf8");
	assert.match(staleMd, /unit: pass \(current, attempt a1-build\.1\)/);
	assert.match(staleMd, /build \(succeeded; check unit stale\)/);
	assert.match(staleMd, /run outcome: blocked/);
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);

	// 3. Edit DURING a verification check marks applicability unknown / evidence unverified and blocks admission.
	const duringChain = await f.service.generate({
		topology: "chain",
		task: "Edit during check is unverified",
		project_cwd: f.cwd,
		request_id: "comp-during-verify",
		agents: [
			{ node_id: "check-step", persona: "implementer", required_checks: ["lint"], sub_task: "Check" },
			{ node_id: "next-step", persona: "reviewer", sub_task: "Next" },
		],
	}, TEST_MODEL);
	const d1 = workerFromConfig(t, join(duringChain.session_dir, "a1-check-step.config.json"));
	const d2 = workerFromConfig(t, join(duringChain.session_dir, "a2-next-step.config.json"));
	await d1.start(); await d2.start();
	await d1.beforeStart();
	await d1.verify({ action: "start", check_id: "lint", scope: ["src/api.ts"] });
	writeFileSync(join(f.cwd, "src", "api.ts"), "export const api = 1000;\n");
	await d1.verify({ action: "finish", check_id: "lint", result: "pass" });
	// bootstrap_complete blocks non-failure when required_check is unverified; record partial/failure or check status.
	const d1CompleteErr = await d1.complete({ status: "success", summary: "Claimed pass", detail: "" });
	assert.equal(d1CompleteErr.isError, true);
	assert.match(d1CompleteErr.content[0].text, /unknown applicability|changed during check/i);
	const duringStatus = f.service.status(duringChain.task_id);
	assert.equal(duringStatus.agents[0].verification?.[0].applicability, "unknown");
	assert.equal(duringStatus.agents[0].evidence?.[0].status, "unverified");

	// 4. Mixed terminal outcomes (succeeded, partial, failed, cancelled) in one run produce ordered provenance and deterministic precedence.
	const mixedRun = await f.service.generate({
		topology: "team",
		task: "Mixed terminal outcomes",
		project_cwd: f.cwd,
		request_id: "comp-mixed-outcomes",
		agents: [
			{ node_id: "ok-node", persona: "implementer", sub_task: "Ok" },
			{ node_id: "partial-node", persona: "reviewer", sub_task: "Partial" },
			{ node_id: "fail-node", persona: "writer", sub_task: "Fail" },
			{ node_id: "cancel-node", persona: "verifier", sub_task: "Cancel" },
		],
	}, TEST_MODEL);
	const m1 = workerFromConfig(t, join(mixedRun.session_dir, "a1-ok-node.config.json"));
	const m2 = workerFromConfig(t, join(mixedRun.session_dir, "a2-partial-node.config.json"));
	const m3 = workerFromConfig(t, join(mixedRun.session_dir, "a3-fail-node.config.json"));
	const m4 = workerFromConfig(t, join(mixedRun.session_dir, "a4-cancel-node.config.json"));
	await m1.start(); await m2.start(); await m3.start(); await m4.start();
	await m1.beforeStart(); await m2.beforeStart(); await m3.beforeStart();
	writeFileSync(join(f.cwd, "artifact-m1.txt"), "provenance data\n");
	await m1.complete({ status: "success", summary: "Ok", detail: "", artifacts: [{ type: "file", path: "artifact-m1.txt", action: "created", description: "M1" }] });
	await m2.complete({ status: "partial", summary: "Partial", detail: "Gap" });
	await m3.complete({ status: "failure", summary: "Failed", detail: "Err" });
	await f.service.cancel(mixedRun.task_id, { agents: ["cancel-node"], reason: "Cancelled by operator" });
	const mixedRep = await f.service.report(mixedRun.task_id, undefined, true, buildMarkdownReport);
	const mixedJson = readJson<any[]>(mixedRep.report_json);
	assert.deepEqual(mixedJson.map(e => [e.node_id, e.status, e.execution_state]), [
		["ok-node", "success", "succeeded"],
		["partial-node", "partial", "partial"],
		["fail-node", "failure", "failed"],
		["cancel-node", "cancelled", "cancelled"],
	]);
	assert.equal(mixedJson[0].artifacts[0].producer_node_id, "ok-node");
	assert.equal(mixedJson[0].artifacts[0].producer_attempt_id, "a1-ok-node.1");
	assert.match(readFileSync(mixedRep.report_md!, "utf8"), /1 success, 1 partial, 1 failure, 1 not executed.*run outcome: failed/);
});

// ---- Matrix Rows 5, 6, 7, 12 ----

test("composition: handoff ACK vs rejection, duplicate delivery, crash after claim, and concurrent recovery serialization", async t => {
	const f = createCompositionFixture(t, { initGit: true });

	// 1. Queue ACK followed by rejected handoff: no false accepted/running status; recovery refuses.
	const rejRun = await f.service.generate({
		topology: "chain",
		task: "Rejected handoff check",
		project_cwd: f.cwd,
		request_id: "comp-rejected-handoff",
		agents: [
			{ node_id: "s1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "s2", persona: "reviewer", sub_task: "Step 2" },
		],
	}, TEST_MODEL);
	const r1 = workerFromConfig(t, join(rejRun.session_dir, "a1-s1.config.json"));
	const r2 = workerFromConfig(t, join(rejRun.session_dir, "a2-s2.config.json"));
	await r1.start(); await r2.start();
	await r1.beforeStart();
	await r1.complete({ status: "success", summary: "Saved", detail: "" });
	assert.equal(f.service.status(rejRun.task_id).agents[1].handoff?.state, "queued");
	assert.notEqual(f.service.status(rejRun.task_id).agents[1].execution, "running");
	const s1File = resultPath(rejRun.session_dir, "a1-s1");
	const s1Json = readJson<any>(s1File);
	s1Json.result.summary = "Tampered after offer";
	atomicJson(s1File, s1Json);
	await r2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-s1" }, content: r1.sent[0].params.prompt },
	});
	const rejStatus = f.service.status(rejRun.task_id);
	assert.equal(rejStatus.agents[1].handoff?.state, "rejected");
	assert.equal(rejStatus.agents[1].execution, "needs_attention");
	const inspectRej = await f.service.recover(rejRun.task_id, { action: "inspect" });
	assert.equal(inspectRej.assessments[0].verdict, "needs_attention");

	// 2. Duplicate notification + interrupted delivery recovery + crash after claim across 3 stages.
	const run = await f.service.generate({
		topology: "chain",
		task: "Duplicate + recovery + crash after claim",
		project_cwd: f.cwd,
		request_id: "comp-handoff-recover",
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Step 2" },
			{ node_id: "n3", persona: "writer", sub_task: "Step 3" },
		],
	}, TEST_MODEL);
	// Same request_id concurrently resolves to the same single fleet.
	const [dup1, dup2] = await Promise.all([
		f.service.generate({
			topology: "chain", task: "Duplicate + recovery + crash after claim", project_cwd: f.cwd, request_id: "comp-handoff-recover",
			agents: [{ node_id: "n1", persona: "implementer", sub_task: "Step 1" }, { node_id: "n2", persona: "reviewer", sub_task: "Step 2" }, { node_id: "n3", persona: "writer", sub_task: "Step 3" }],
		}, TEST_MODEL),
		f.service.generate({
			topology: "chain", task: "Duplicate + recovery + crash after claim", project_cwd: f.cwd, request_id: "comp-handoff-recover",
			agents: [{ node_id: "n1", persona: "implementer", sub_task: "Step 1" }, { node_id: "n2", persona: "reviewer", sub_task: "Step 2" }, { node_id: "n3", persona: "writer", sub_task: "Step 3" }],
		}, TEST_MODEL),
	]);
	assert.equal(dup1.task_id, run.task_id);
	assert.equal(dup2.task_id, run.task_id);

	const n1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	let failN2Send = true;
	const n2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"), {
		executeTool: async () => failN2Send ? { isError: true, content: [{ type: "text", text: "coms offline" }] } : { content: [], details: { msg_id: "m" } },
	});
	const n3 = workerFromConfig(t, join(run.session_dir, "a3-n3.config.json"));
	await n1.start(); await n2.start(); await n3.start();
	await n1.beforeStart();
	await n1.complete({ status: "success", summary: "n1 ok", detail: "" });

	// Duplicate notification to n2 executes once.
	const handoffPrompt = n1.sent[0].params.prompt;
	const n2Turn1 = await n2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: handoffPrompt },
	});
	assert.match(n2Turn1.systemPrompt, /Accepted handoff: h-/);
	const n2TurnDup = await n2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: handoffPrompt },
	});
	assert.equal(n2TurnDup, undefined, "duplicate notification must abort without starting a second execution");

	// n2 completes, Coms send fails, n2 exits: delivery is failed, result is saved.
	const c2Fail = await n2.complete({ status: "success", summary: "n2 ok", detail: "" });
	assert.equal(c2Fail.isError, true);
	await n2.shutdown({ reason: "exit" });

	// Concurrent recovery calls send only once; n3 accepts once.
	let wakeCount = 0;
	const wakeCalls: string[] = [];
	const wake = async (_target: string, prompt: string) => {
		wakeCount++;
		wakeCalls.push(prompt);
		return { msg_id: `rec-${wakeCount}` };
	};
	const [recA, recB] = await Promise.all([
		f.service.recover(run.task_id, { action: "retry_delivery", agent: "n3" }, { senderSession: "disp-session", wake }),
		f.service.recover(run.task_id, { action: "retry_delivery", agent: "n3" }, { senderSession: "disp-session", wake }),
	]);
	assert.equal(wakeCount, 1, "concurrent retry_delivery must send only once");
	assert.equal([recA.delivery?.transport, recB.delivery?.transport].filter(Boolean).length, 1);

	const n3Turn = await n3.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "disp-session" }, content: wakeCalls[0] },
	});
	assert.match(n3Turn.systemPrompt, /Accepted handoff: h-/);
	// Now n3 crashes after claim (dead PID without saving result): needs_attention, never replayed.
	atomicJson(readyPath(run.session_dir, "a3-n3"), { ...readJson<any>(readyPath(run.session_dir, "a3-n3")), pid: 2147483646 });
	const crashStatus = f.service.status(run.task_id);
	assert.equal(crashStatus.agents[2].execution, "needs_attention");
	assert.equal(crashStatus.outcome.state, "needs_attention");
	const crashInspect = await f.service.recover(run.task_id, { action: "inspect", agent: "n3" });
	assert.equal(crashInspect.assessments[0].verdict, "needs_attention");
	assert.equal(crashInspect.assessments[0].stage, "claimed_unfinished");
	await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /not complete/);
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false, "recovery must not create worktrees");
});

// ---- Matrix Rows 8, 9, 10, 13 ----

test("composition: team ownership concurrency/serialization, independent vs fail_fast, cancel in-flight, and session replacement", async t => {
	const f = createCompositionFixture(t);

	// 1. Team: reader + disjoint writer concurrent, overlapping writer serialized, independent failure policy lets healthy finish.
	const teamRun = await f.service.generate({
		topology: "team",
		task: "Shared-cwd team composition",
		project_cwd: f.cwd,
		request_id: "comp-team-own",
		agents: [
			{ node_id: "reader", persona: "reviewer", read_paths: ["src/api.ts"], sub_task: "Read API" },
			{ node_id: "w-api", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Write API" },
			{ node_id: "w-ui", persona: "writer", write_paths: ["src/ui.ts"], sub_task: "Write UI" },
			{ node_id: "w-api-2", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Second API write" },
		],
	}, TEST_MODEL);
	const r = workerFromConfig(t, join(teamRun.session_dir, "a1-reader.config.json"));
	const wa = workerFromConfig(t, join(teamRun.session_dir, "a2-w-api.config.json"));
	const wu = workerFromConfig(t, join(teamRun.session_dir, "a3-w-ui.config.json"));
	const wa2 = workerFromConfig(t, join(teamRun.session_dir, "a4-w-api-2.config.json"));
	await r.start(); await wa.start(); await wu.start(); await wa2.start();

	// Unsolicited peer task in default independent mode is rejected before model work.
	const peerRejected = await r.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a2-w-api" }, content: "Do extra work" },
	});
	assert.equal(peerRejected, undefined);

	// Disjoint writers + reader start concurrently; conflicting w-api-2 waits.
	await r.beforeStart();
	await wa.beforeStart();
	await wu.beforeStart();
	assert.equal((await wa2.input(wa2.config.startup_message)).action, "handled");
	const concurrentStatus = f.service.status(teamRun.task_id);
	assert.deepEqual(concurrentStatus.agents.slice(0, 3).map(a => a.execution), ["running", "running", "running"]);
	assert.equal(concurrentStatus.agents[3].ownership_status, "waiting");
	assert.equal(concurrentStatus.agents[3].execution, "waiting");
	assert.match(wa.config.sub_task, /Write API/);
	assert.match(wu.config.sub_task, /Write UI/);
	assert.notEqual(wa.config.attempt_id, wu.config.attempt_id);

	// w-ui fails, but default failure_policy=independent lets reader, w-api, and w-api-2 continue.
	await wu.complete({ status: "failure", summary: "UI failed", detail: "" });
	await r.complete({ status: "success", summary: "Read ok", detail: "" });
	await wa.complete({ status: "success", summary: "API 1 ok", detail: "" });
	await new Promise(resolve => setTimeout(resolve, 650));
	assert.equal(wa2.deliveredMessages.length, 1);
	await wa2.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: wa2.deliveredMessages[0].message });
	await wa2.complete({ status: "success", summary: "API 2 ok", detail: "" });
	const teamRep = await f.service.report(teamRun.task_id, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(teamRep.report_json).map(e => [e.node_id, e.status]), [
		["reader", "success"], ["w-api", "success"], ["w-ui", "failure"], ["w-api-2", "success"],
	]);

	// 2. fail_fast team preserves committed result and cancels queued/running members.
	const ffRun = await f.service.generate({
		topology: "team",
		task: "Fail fast team",
		project_cwd: f.cwd,
		failure_policy: "fail_fast",
		request_id: "comp-team-ff",
		agents: [
			{ node_id: "fast-ok", persona: "reviewer", read_paths: ["src/api.ts"], sub_task: "Quick read" },
			{ node_id: "fail-one", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Fail write" },
			{ node_id: "queued-two", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Queued write" },
		],
	}, TEST_MODEL);
	const ffOk = workerFromConfig(t, join(ffRun.session_dir, "a1-fast-ok.config.json"));
	const ffFail = workerFromConfig(t, join(ffRun.session_dir, "a2-fail-one.config.json"));
	const ffQueued = workerFromConfig(t, join(ffRun.session_dir, "a3-queued-two.config.json"));
	await ffOk.start(); await ffFail.start(); await ffQueued.start();
	await ffOk.beforeStart();
	await ffOk.complete({ status: "success", summary: "Committed before failure", detail: "" });
	await ffFail.beforeStart();
	await ffFail.complete({ status: "failure", summary: "Boom", detail: "" });
	await new Promise(resolve => setTimeout(resolve, 650));
	const ffStatus = f.service.status(ffRun.task_id);
	assert.deepEqual(ffStatus.agents.map(a => a.execution), ["succeeded", "failed", "cancelled"]);

	// 2b. Uncertain conflicting writer (dead PID without result) holds queued writer as held_uncertain.
	const uncRun = await f.service.generate({
		topology: "team",
		task: "Uncertain writer holds conflicting peer",
		project_cwd: f.cwd,
		request_id: "comp-team-uncertain",
		agents: [
			{ node_id: "crashed-writer", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Crash" },
			{ node_id: "queued-writer", persona: "writer", write_paths: ["src/api.ts"], sub_task: "Wait" },
		],
	}, TEST_MODEL);
	const uw1 = workerFromConfig(t, join(uncRun.session_dir, "a1-crashed-writer.config.json"));
	const uw2 = workerFromConfig(t, join(uncRun.session_dir, "a2-queued-writer.config.json"));
	await uw1.start(); await uw2.start();
	await uw1.beforeStart();
	assert.equal((await uw2.input(uw2.config.startup_message)).action, "handled");
	atomicJson(readyPath(uncRun.session_dir, "a1-crashed-writer"), { ...readJson<any>(readyPath(uncRun.session_dir, "a1-crashed-writer")), pid: 2147483646 });
	const uncStatus = f.service.status(uncRun.task_id);
	assert.equal(uncStatus.agents[0].execution, "needs_attention");
	assert.equal(uncStatus.agents[1].ownership_status, "held_uncertain");
	assert.equal(uncStatus.agents[1].execution, "waiting");

	// 3. Cancel during chain execution: committed work & evidence remain, in-flight stops new tools, downstream stops admission.
	let clock = 10_000;
	const fc = createCompositionFixture(t, { now: () => clock });
	const cancelRun = await fc.service.generate({
		topology: "chain",
		task: "Cancel mid-chain",
		project_cwd: fc.cwd,
		cancel_grace_ms: 2000,
		request_id: "comp-cancel-chain",
		agents: [
			{ node_id: "done-step", persona: "implementer", required_checks: ["lint"], sub_task: "Step 1" },
			{ node_id: "active-step", persona: "reviewer", sub_task: "Step 2" },
			{ node_id: "waiting-step", persona: "writer", sub_task: "Step 3" },
		],
	}, TEST_MODEL);
	const cr1 = workerFromConfig(t, join(cancelRun.session_dir, "a1-done-step.config.json"));
	const cr2 = workerFromConfig(t, join(cancelRun.session_dir, "a2-active-step.config.json"));
	const cr3 = workerFromConfig(t, join(cancelRun.session_dir, "a3-waiting-step.config.json"));
	await cr1.start(); await cr2.start(); await cr3.start();
	await cr1.beforeStart();
	await cr1.verify({ action: "start", check_id: "lint", scope: ["src/api.ts"] });
	await cr1.verify({ action: "finish", check_id: "lint", result: "pass" });
	await cr1.complete({ status: "success", summary: "Done 1", detail: "" });
	const pCr2 = await cr2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-done-step" }, content: cr1.sent[0].params.prompt },
	});
	assert.ok(pCr2?.systemPrompt, "cr2 must be admitted before cancel");
	const cancelRes = await fc.service.cancel(cancelRun.task_id, { agents: ["active-step"], reason: "User stopped step 2" });
	assert.equal(cancelRes.cancelling.length, 1, JSON.stringify(cancelRes));
	assert.equal(cancelRes.cancelling[0].node_id, "active-step");
	assert.equal(cancelRes.blocked_dependents[0].node_id, "waiting-step");
	// force_close is refused before cancel_grace_ms elapses, and permitted afterwards.
	await assert.rejects(fc.service.cancel(cancelRun.task_id, { agents: ["active-step"], force_close: true }), /grace period/i);
	// Subsequent tool calls are blocked after cancellation; settle records cancelled.
	const blockedTool = await cr2.toolCall("read", { path: "src/api.ts" });
	assert.equal(blockedTool.block, true);
	await cr2.settled({ aborted: true });
	await new Promise(resolve => setTimeout(resolve, 1100));
	const cancelStatus = fc.service.status(cancelRun.task_id);
	assert.deepEqual(cancelStatus.agents.map(a => a.execution), ["succeeded", "cancelled", "blocked"]);
	assert.equal(cancelStatus.agents[0].evidence?.[0].status, "passing");
	clock += 2500;
	const forceRes = await fc.service.cancel(cancelRun.task_id, { agents: ["active-step"], force_close: true });
	assert.deepEqual(forceRes.force_closed, ["active-step"]);
	const cancelReport = await fc.service.report(cancelRun.task_id, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(cancelReport.report_json).map(e => [e.node_id, e.status]), [
		["done-step", "success"], ["active-step", "cancelled"], ["waiting-step", "blocked"],
	]);

	// 4. Initialized session replacement (/new + subsequent /reload) receives no old task authority.
	const replRun = await f.service.generate({
		topology: "team",
		task: "Session replacement",
		project_cwd: f.cwd,
		request_id: "comp-replace",
		agents: [{ node_id: "replaced", persona: "reviewer", sub_task: "Review" }],
	}, TEST_MODEL);
	const origTools = ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	const wOrig = workerFromConfig(t, join(replRun.session_dir, "a1-replaced.config.json"), { tools: origTools, shutdownOnReload: false });
	await wOrig.start();
	await wOrig.beforeStart();
	await wOrig.shutdown({ reason: "new" });
	assert.equal(f.service.status(replRun.task_id).agents[0].execution, "needs_attention");
	// New ordinary session + /reload in same pane: original tools restored, zero bootstrap task injection.
	const wNew = workerFromConfig(t, join(replRun.session_dir, "a1-replaced.config.json"), { tools: origTools, shutdownOnReload: false });
	await wNew.start({ reason: "new" });
	assert.deepEqual(wNew.active, origTools);
	assert.equal(await wNew.beforeStart({ systemPrompt: "USER_BASE" }), undefined);
	await wNew.start({ reason: "reload" });
	assert.equal(await wNew.beforeStart({ systemPrompt: "USER_BASE" }), undefined);
});

// ---- Matrix Row 15: Legacy v1 team/chain inspect, report, cleanup ----

test("composition: legacy v1 run inspects, reports, and cleans up safely without migrating identities", async t => {
	const f = createCompositionFixture(t);
	const taskId = "v1-chain-legacy";
	const project = realpathSync(f.cwd);
	const sessionDir = join(project, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const manifest = {
		version: 1, task_id: taskId, task: "Legacy v1 chain", topology: "chain", project_cwd: project,
		session_dir: sessionDir, workspace_id: "origin-workspace", coms_project: `boot-${taskId}`,
		status: "applied", phase: "released", token: "v1-tok",
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		pane_manifest: [
			{ agent_name: "implementer", instance_id: "a1-implementer", expected_coms_name: "a1-implementer", expected_model: "provider/model", label: `${taskId}:a1-implementer`, step: 1, successor: "a2-reviewer", tab_id: "t1", pane_id: "p1", terminal_id: "term1", status: "released" },
			{ agent_name: "reviewer", instance_id: "a2-reviewer", expected_coms_name: "a2-reviewer", expected_model: "provider/model", label: `${taskId}:a2-reviewer`, step: 2, predecessor: "a1-implementer", tab_id: "t2", pane_id: "p2", terminal_id: "term2", status: "released" },
		],
	};
	for (const entry of manifest.pane_manifest) {
		f.tabs.push({ tab_id: entry.tab_id, pane_id: entry.pane_id, terminal_id: entry.terminal_id, label: entry.label, cwd: f.cwd });
	}
	mkdirSync(f.stateDir, { recursive: true });
	for (const path of [join(f.stateDir, `${taskId}.json`), join(sessionDir, "manifest.json")]) {
		writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
	}
	writeFileSync(join(sessionDir, "a1-implementer.result.json"), JSON.stringify({
		result: { agent_name: "implementer", status: "partial", summary: "V1 partial", detail: "" },
		delivery: "sent", completed_at: "2026-01-01T00:01:00.000Z",
	}));
	writeFileSync(join(sessionDir, "a2-reviewer.handoff.json"), JSON.stringify({
		task_id: taskId, token: "v1-tok", predecessor: "a1-implementer", sender_session: "s1",
	}));
	writeFileSync(join(sessionDir, "a2-reviewer.result.json"), JSON.stringify({
		result: { agent_name: "reviewer", status: "success", summary: "V1 accepted partial", detail: "" },
		delivery: "not_required", completed_at: "2026-01-01T00:02:00.000Z",
	}));

	const status = f.service.status(taskId);
	assert.equal(status.outcome.state, "partial");
	assert.equal(status.agents[1].dependency_policy, "allow_partial");
	assert.equal(status.agents[1].handoff?.legacy, true);
	const rep = await f.service.report(taskId, undefined, true, buildMarkdownReport);
	assert.deepEqual(readJson<any[]>(rep.report_json).map(e => [e.agent_name, e.status]), [
		["implementer", "partial"], ["reviewer", "success"],
	]);
	const clean = await f.service.cleanup(taskId);
	assert.equal(clean.status, "cleaned");
	assert.equal(readJson<any>(join(f.stateDir, `${taskId}.json`)).version, 1);
	assert.equal(readJson<any>(join(f.stateDir, `${taskId}.json`)).pane_manifest[0].node_id, undefined);
});


test("previous-release reader binary rejects a new v2 run without modifying records", async t => {
	const f = createCompositionFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Downgrade boundary", project_cwd: f.cwd,
		agents: [{ node_id: "first", persona: "reviewer", sub_task: "Review" }],
	}, TEST_MODEL);
	const index = join(f.stateDir, `${run.task_id}.json`);
	const before = readFileSync(index, "utf8");
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const readerUrl = new URL("./test-support/previous-session-store.ts", import.meta.url).href;
	const result = await runSupervised(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { SessionStore } from ${JSON.stringify(readerUrl)};
		const store = new SessionStore(process.argv[1]);
		assert.throws(() => store.load(process.argv[2]), /Invalid bootstrap manifest/);
		assert.deepEqual(store.list(), []);
	`, f.stateDir, run.task_id], { timeoutMs: 5000, env: iso.env });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.timedOut, false);
	assert.equal(readFileSync(index, "utf8"), before);
	assert.equal(f.tabs.length, 1);
	assert.deepEqual(iso.homeLeaks(), []);
});
