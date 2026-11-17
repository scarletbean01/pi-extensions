/** Independent team execution, read/write ownership serialization, and failure policies. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { formatAgentStates, formatPlan, formatReportDigest } from "./reporting.ts";
import { buildMarkdownReport } from "./reporting.ts";
import { atomicJson, collaborationModeOf, dispositionPath, dispositionRecord, failurePolicyOf, parseManifest, parseWorkerConfig, readJson, readyPath, resultPath, type Disposition, type WorkerConfig } from "./session-store.ts";
import { computeOwnershipSchedule, failFastPath, normalizeOwnershipPaths, ownershipPath, parseFailFastRecord, parseOwnershipRecord, pathsOverlap } from "./ownership.ts";

const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

function serviceFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-ownership-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["writer", "reviewer", "tester"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: provider/model\ntools: read,write,edit,bash\n---\nExact persona ${name}\n`);
	}
	const calls: string[][] = [];
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	const configs: WorkerConfig[] = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		calls.push(args);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(t => t.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
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
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	const options = { exec, extensionDir, stateDir, home, env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" }, pollMs: 5 };
	const service = new BootstrapService(options);
	return { root, cwd, home, stateDir, options, service, calls, tabs, configs };
}

// ---- Slice 1: Read/write ownership normalization, overlap detection & deterministic plan preview ----

test("ownership path normalization and overlap rules handle files, parent dirs, segment boundaries, globs and whole-project scopes", () => {
	const cwd = "/tmp/example-project";
	assert.deepEqual(normalizeOwnershipPaths(cwd, ["./src/a.ts", "/tmp/example-project/src/b.ts", "src/a.ts"], "write_paths"), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(normalizeOwnershipPaths(cwd, ["**"], "write_paths"), ["."]);
	assert.deepEqual(normalizeOwnershipPaths(cwd, ["*"], "write_paths"), ["."]);
	assert.throws(() => normalizeOwnershipPaths(cwd, ["../outside.ts"], "write_paths"), /escapes project_cwd/);
	assert.throws(() => normalizeOwnershipPaths(cwd, ["/etc/passwd"], "write_paths"), /escapes project_cwd/);

	// Disjoint paths & segment boundary
	assert.equal(pathsOverlap("src/a.ts", "src/b.ts"), false);
	assert.equal(pathsOverlap("src/foo", "src/foobar"), false);
	assert.equal(pathsOverlap("src/*.ts", "src/sub/a.ts"), false);
	assert.equal(pathsOverlap("src/**/*.ts", "docs/readme.md"), false);
	assert.equal(pathsOverlap("src/**/*.ts", "src/sub/a.md"), false);

	// Overlapping files, parent dirs, globs & whole-project
	assert.equal(pathsOverlap("src/a.ts", "src/a.ts"), true);
	assert.equal(pathsOverlap("src", "src/a.ts"), true);
	assert.equal(pathsOverlap("src/sub/a.ts", "src"), true);
	assert.equal(pathsOverlap(".", "src/a.ts"), true);
	assert.equal(pathsOverlap("src/**/*.ts", "src/sub/a.ts"), true);
	assert.equal(pathsOverlap("src/**/*.ts", "src/sub"), true);
});

test("computeOwnershipSchedule keeps readers and disjoint writers concurrent and serializes overlapping writers in plan order", () => {
	const schedule = computeOwnershipSchedule([
		{ node_id: "read-only", instance_id: "a1-read-only", read_paths: ["src/a.ts"], write_paths: [] },
		{ node_id: "w-a", instance_id: "a2-w-a", write_paths: ["src/a.ts"] },
		{ node_id: "w-b", instance_id: "a3-w-b", write_paths: ["src/b.ts"] },
		{ node_id: "w-a2", instance_id: "a4-w-a2", write_paths: ["src/a.ts"] },
		{ node_id: "w-all", instance_id: "a5-w-all", write_paths: ["."] },
		{ node_id: "r-after", instance_id: "a6-r-after", read_paths: ["src"], write_paths: [] },
	]);
	assert.deepEqual(schedule.waitsFor.get("a1-read-only"), []);
	assert.deepEqual(schedule.waitsFor.get("a2-w-a"), []);
	assert.deepEqual(schedule.waitsFor.get("a3-w-b"), []);
	assert.deepEqual(schedule.waitsFor.get("a4-w-a2"), ["a2-w-a"]);
	assert.deepEqual(schedule.waitsFor.get("a5-w-all"), ["a2-w-a", "a3-w-b", "a4-w-a2"]);
	assert.deepEqual(schedule.waitsFor.get("a6-r-after"), []);
	assert.deepEqual(schedule.conflicts.map(c => [c.node_id, c.waits_for_node_id]), [
		["w-a2", "w-a"],
		["w-all", "w-a"],
		["w-all", "w-b"],
		["w-all", "w-a2"],
	]);
});

test("dry-run plan reports shared_cwd strategy, read/write ownership, serialization waits, and advisory contract without creating worktrees", async t => {
	const f = serviceFixture(t);
	const request: GenerateRequest = {
		topology: "team",
		task: "Implement features",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "api", persona: "writer", write_paths: ["src/api.ts"], read_paths: ["src/types.ts"], sub_task: "Update API" },
			{ node_id: "ui", persona: "writer", write_paths: ["src/ui.ts"], sub_task: "Update UI" },
			{ node_id: "api-docs", persona: "writer", write_paths: ["src"], sub_task: "Document src" },
		],
	};
	const plan = f.service.plan(request);
	assert.equal(plan.workspace_strategy, "shared_cwd");
	assert.deepEqual(plan.agents[0].write_paths, ["src/api.ts"]);
	assert.deepEqual(plan.agents[0].read_paths, ["src/types.ts"]);
	assert.deepEqual(plan.agents[0].ownership_wait_for, []);
	assert.deepEqual(plan.agents[1].ownership_wait_for, []);
	assert.deepEqual(plan.agents[2].ownership_wait_for, ["a1-api", "a2-ui"]);
	assert.equal(plan.ownership_conflicts.length, 2);

	const preview = formatPlan(plan);
	assert.match(preview, /shared_cwd/);
	assert.match(preview, /advisory/i);
	assert.doesNotMatch(preview, /sandbox/i);
	assert.match(preview, /read_paths: src\/types\.ts/);
	assert.match(preview, /write_paths: src\/api\.ts/);
	assert.match(preview, /ownership_wait_for:.*api.*ui/);
	assert.equal(f.calls.length, 0, "preview never creates tabs or worktrees");
});

// ---- Slice 2: Collaboration modes, failure policies, fingerprints & versioned readers ----

test("new plans default to independent collaboration and independent failure policy; legacy keeps legacy messaging with visible guidance", async t => {
	const f = serviceFixture(t);
	const modernReq: GenerateRequest = {
		topology: "team",
		task: "Review and write",
		project_cwd: f.cwd,
		request_id: "modern-defaults",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Edit a" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Edit a after w1" },
		],
	};
	const modernPlan = f.service.plan(modernReq);
	assert.equal(modernPlan.collaboration_mode, "independent");
	assert.equal(modernPlan.failure_policy, "independent");
	const modernRun = await f.service.generate(modernReq);
	assert.equal(modernRun.collaboration_mode, "independent");
	assert.equal(modernRun.failure_policy, "independent");
	assert.equal(modernRun.workspace_strategy, "shared_cwd");
	assert.deepEqual(modernRun.pane_manifest[0].write_paths, ["src/a.ts"]);
	assert.deepEqual(modernRun.pane_manifest[1].ownership_wait_for, ["a1-w1"]);
	assert.equal(f.configs[0].collaboration_mode, "independent");
	assert.equal(f.configs[0].failure_policy, "independent");
	assert.deepEqual(f.configs[1].ownership_wait_for, ["a1-w1"]);
	const input2 = readJson<any>(join(modernRun.session_dir, "a2-w2.input.json"));
	assert.deepEqual(input2.assignment.write_paths, ["src/a.ts"]);
	assert.deepEqual(input2.assignment.ownership_wait_for, ["a1-w1"]);

	// Explicit opt-in for collaborative mode and fail_fast
	const collabReq: GenerateRequest = {
		topology: "team",
		task: "Collaborate",
		project_cwd: f.cwd,
		request_id: "collab-opt-in",
		collaboration_mode: "collaborative",
		failure_policy: "fail_fast",
		agents: [{ node_id: "w1", persona: "writer", sub_task: "Discuss" }],
	};
	const collabRun = await f.service.generate(collabReq);
	assert.equal(collabRun.collaboration_mode, "collaborative");
	assert.equal(collabRun.failure_policy, "fail_fast");
	assert.equal(f.configs[2].collaboration_mode, "collaborative");
	assert.equal(f.configs[2].failure_policy, "fail_fast");

	// Legacy form retains legacy messaging and old fingerprint, with visible guidance
	const legacyReq: GenerateRequest = {
		topology: "team",
		task: "Legacy team",
		project_cwd: f.cwd,
		request_id: "legacy-team",
		agents: [{ name: "reviewer", sub_task: "Review" }],
	};
	const legacyPlan = f.service.plan(legacyReq);
	assert.equal(legacyPlan.collaboration_mode, "legacy");
	assert.match(formatPlan(legacyPlan), /collaboration: legacy.*persona\/node_id/i);
	const legacyRun = await f.service.generate(legacyReq);
	assert.equal(legacyRun.collaboration_mode, "legacy");
	const expectedOldFp = createHash("sha256").update(JSON.stringify({
		v: 2, topology: "team", task: "Legacy team", project_cwd: realpathSync(f.cwd), ready_timeout_ms: 60_000,
		coms_extension: null, agents: [["reviewer", "Review", null]], model: null,
	})).digest("hex");
	const resPath = join(f.stateDir, `request-${createHash("sha256").update("legacy-team").digest("hex")}.json`);
	assert.equal(readJson<{ fingerprint: string }>(resPath).fingerprint, expectedOldFp);
});

test("invalid policies fail preflight and canonical fingerprints distinguish mode, failure_policy and ownership changes", async t => {
	const f = serviceFixture(t);
	await assert.rejects(f.service.generate({
		topology: "team", task: "Bad mode", project_cwd: f.cwd, collaboration_mode: "open" as any,
		agents: [{ node_id: "a", persona: "writer", sub_task: "x" }],
	}), /collaboration_mode must be/);
	await assert.rejects(f.service.generate({
		topology: "team", task: "Bad failure", project_cwd: f.cwd, failure_policy: "abort_all" as any,
		agents: [{ node_id: "a", persona: "writer", sub_task: "x" }],
	}), /failure_policy must be/);
	assert.equal(f.calls.length, 0);

	const base: GenerateRequest = {
		topology: "team", task: "Retry check", project_cwd: f.cwd, request_id: "fp-check",
		agents: [{ node_id: "w1", persona: "writer", write_paths: ["./src/a.ts"], sub_task: "Edit" }],
	};
	const first = await f.service.generate(base);
	const explicitDefaults = await f.service.generate({
		...base,
		collaboration_mode: "independent",
		failure_policy: "independent",
		agents: [{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Edit" }],
	});
	assert.equal(explicitDefaults.task_id, first.task_id);
	await assert.rejects(f.service.generate({ ...base, collaboration_mode: "collaborative" }), /different bootstrap plan/);
	await assert.rejects(f.service.generate({ ...base, failure_policy: "fail_fast" }), /different bootstrap plan/);
	await assert.rejects(f.service.generate({ ...base, agents: [{ node_id: "w1", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Edit" }] }), /different bootstrap plan/);
});

test("versioned readers preserve pre-09 v1/v2 compatibility and validate ownership records", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Compat", project_cwd: f.cwd, request_id: "compat",
		agents: [{ node_id: "w1", persona: "writer", sub_task: "Work" }],
	});
	// Pre-09 v2 manifest/config without collaboration_mode or failure_policy reads as legacy/independent
	const storedManifest = readJson<any>(join(f.stateDir, `${run.task_id}.json`));
	delete storedManifest.collaboration_mode;
	delete storedManifest.failure_policy;
	delete storedManifest.workspace_strategy;
	const parsedManifest = parseManifest(storedManifest, run.task_id);
	assert.equal(collaborationModeOf(parsedManifest), "legacy");
	assert.equal(failurePolicyOf(parsedManifest), "independent");

	const storedConfig = readJson<any>(join(run.session_dir, "a1-w1.config.json"));
	delete storedConfig.collaboration_mode;
	delete storedConfig.failure_policy;
	const parsedConfig = parseWorkerConfig(storedConfig);
	assert.equal(collaborationModeOf(parsedConfig), "legacy");
	assert.equal(failurePolicyOf(parsedConfig), "independent");

	// Versioned ownership record reader validates identity and rejects unsupported versions
	const ownFile = ownershipPath(run.session_dir, "a1-w1");
	const validOwn = {
		version: 1,
		identity: { run_id: run.task_id, node_id: "w1", persona_name: "writer", attempt_id: "a1-w1.1", instance_id: "a1-w1" },
		state: "admitted",
		write_paths: ["src/a.ts"],
		read_paths: [],
		waiting_for: [],
		admitted_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
	atomicJson(ownFile, validOwn);
	const parsedOwn = parseOwnershipRecord(readJson(ownFile), { run_id: run.task_id, node_id: "w1", persona_name: "writer", attempt_id: "a1-w1.1", instance_id: "a1-w1" });
	assert.equal(parsedOwn.state, "admitted");
	assert.throws(() => parseOwnershipRecord({ ...validOwn, version: 99 }, { run_id: run.task_id, instance_id: "a1-w1" }), /Unsupported ownership record version 99/);
	assert.throws(() => parseOwnershipRecord({ ...validOwn, identity: { ...validOwn.identity, node_id: "other" } }, { run_id: run.task_id, node_id: "w1", instance_id: "a1-w1" }), /identity mismatch/);
});

function workerFromConfig(t: test.TestContext, configPath: string, overrides: { tools?: string[] } = {}) {
	const config = readJson<WorkerConfig>(configPath);
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = overrides.tools ?? ["read", "write", "edit", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const deliveredMessages: Array<{ message: any; options: any }> = [];
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} },
		shutdown: () => { shutdowns++; },
		abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {},
		getFlag: () => configPath,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
		sendMessage: (message: unknown, options: unknown) => { deliveredMessages.push({ message, options }); },
	} as any);
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); });
	return {
		config, hooks, tools, context, sent, deliveredMessages,
		get active() { return active; },
		get shutdowns() { return shutdowns; },
		get aborts() { return aborts; },
		start: (event: Record<string, unknown> = {}) => hooks.get("session_start")!(event, context),
		input: (text: string) => hooks.get("input")!({ text }, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		toolCall: (event: Record<string, unknown>) => hooks.get("tool_call")!(event, context),
		complete: (params: Record<string, unknown> = { status: "success", summary: "Done", detail: "Work complete" }) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
	};
}

// ---- Slice 3: Independent mode peer rejection vs collaborative/legacy preservation ----

const TEST_MODEL = { provider: "provider", id: "model" };

test("independent mode rejects unsolicited peer task activation while preserving internal chain handoffs and user controls", async t => {
	const f = serviceFixture(t);
	const teamRun = await f.service.generate({
		topology: "team", task: "Independent team", project_cwd: f.cwd, request_id: "ind-team",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Edit a" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Edit b" },
		],
	}, TEST_MODEL);
	const w1 = workerFromConfig(t, join(teamRun.session_dir, "a1-w1.config.json"));
	await w1.start();

	// Unsolicited peer prompt before task starts must abort without failing or shutting down the worker
	await w1.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a2-w2" }, content: "Please also rewrite src/b.ts" },
	});
	assert.equal(w1.aborts, 1);
	assert.equal(w1.shutdowns, 0);
	assert.equal(existsSync(join(teamRun.session_dir, "a1-w1.error.json")), false);

	// User / startup prompt still proceeds and receives independent + advisory contract instructions
	const prompt = await w1.beforeStart({ systemPrompt: "BASE" });
	assert.match(prompt.systemPrompt, /Execution mode: independent/i);
	assert.match(prompt.systemPrompt, /advisory/i);
	assert.match(prompt.systemPrompt, /not a filesystem sandbox/i);

	// Direct model-initiated coms_send is blocked in independent mode
	const blockedSend = await w1.toolCall({ toolName: "coms_send", input: { target: "a2-w2", prompt: "Do extra work" } });
	assert.equal(blockedSend?.block, true);
	assert.match(blockedSend.reason, /independent/i);

	// Unsolicited peer prompt arriving after worker started is also rejected
	await w1.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a2-w2" }, content: "Extra task" },
	});
	assert.equal(w1.aborts, 2);
	assert.equal(w1.shutdowns, 0);

	// User /new session replacement control still detaches cleanly and restores original tools
	await w1.start({ reason: "new" });
	assert.ok(w1.active.includes("bootstrap_generate"));

	// Chain in independent mode still allows internal bootstrap_complete -> coms_send handoff and validated predecessor handoff
	const chainRun = await f.service.generate({
		topology: "chain", task: "Independent chain", project_cwd: f.cwd, request_id: "ind-chain",
		agents: [
			{ node_id: "step1", persona: "writer", sub_task: "First" },
			{ node_id: "step2", persona: "reviewer", sub_task: "Second" },
		],
	}, TEST_MODEL);
	const c1 = workerFromConfig(t, join(chainRun.session_dir, "a1-step1.config.json"));
	await c1.start();
	await c1.beforeStart();
	const c1Done = await c1.complete();
	assert.equal(c1Done.isError, undefined);
	assert.equal(c1.sent.length, 1, "internal chain handoff uses coms_send");

	const c2 = workerFromConfig(t, join(chainRun.session_dir, "a2-step2.config.json"));
	await c2.start();
	// Random peer prompt is rejected, while valid predecessor handoff is admitted
	await c2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "other-peer" }, content: "Unsolicited" },
	});
	assert.equal(c2.aborts, 1);
	const accepted = await c2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-step1" }, content: `bootstrap-handoff:${chainRun.token}:a1-step1` },
	});
	assert.match(accepted.systemPrompt, /Predecessor result/);
});

test("collaborative opt-in and legacy requests retain peer Coms messaging", async t => {
	const f = serviceFixture(t);
	const collabRun = await f.service.generate({
		topology: "team", task: "Collab team", project_cwd: f.cwd, request_id: "collab-msg",
		collaboration_mode: "collaborative",
		agents: [{ node_id: "w1", persona: "writer", sub_task: "Work" }],
	}, TEST_MODEL);
	const wc = workerFromConfig(t, join(collabRun.session_dir, "a1-w1.config.json"));
	await wc.start();
	const collabPrompt = await wc.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "peer-1" }, content: "Question from peer" },
	});
	assert.equal(wc.aborts, 0);
	assert.match(collabPrompt.systemPrompt, /Execution mode: collaborative/i);
	assert.equal(await wc.toolCall({ toolName: "coms_send", input: { target: "peer", prompt: "hi" } }), undefined);

	const legacyRun = await f.service.generate({
		topology: "team", task: "Legacy team", project_cwd: f.cwd, request_id: "legacy-msg",
		agents: [{ name: "writer", sub_task: "Work" }],
	}, TEST_MODEL);
	const wl = workerFromConfig(t, join(legacyRun.session_dir, "a1-writer.config.json"));
	await wl.start();
	const legacyPrompt = await wl.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "peer-1" }, content: "Legacy peer message" },
	});
	assert.equal(wl.aborts, 0);
	assert.match(legacyPrompt.systemPrompt, /legacy/i);
	assert.equal(await wl.toolCall({ toolName: "coms_send", input: { target: "peer", prompt: "hi" } }), undefined);
});

// ---- Slice 4: Durable ownership serialization, reload/recovery, uncertain-execution hold & status ----

test("disjoint writers execute concurrently while overlapping writers serialize in deterministic plan order", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Parallel and serialized writers", project_cwd: f.cwd, request_id: "serialize-1",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Write A first" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Write B concurrently" },
			{ node_id: "w3", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Write A second" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	const w3 = workerFromConfig(t, join(run.session_dir, "a3-w3.config.json"));
	await w1.start();
	await w2.start();
	await w3.start();

	// w1 and w2 are disjoint and start immediately (concurrently)
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a1-w1")).state, "admitted");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "admitted");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "waiting");
	assert.equal((await w1.input(w1.config.startup_message)).action, "transform");
	assert.equal((await w2.input(w2.config.startup_message)).action, "transform");
	assert.equal((await w3.input(w3.config.startup_message)).action, "handled");

	await w1.beforeStart();
	await w2.beforeStart();
	// w3 cannot start while w1 holds src/a.ts
	await w3.beforeStart();
	assert.equal(w3.aborts, 1);
	assert.equal((await w3.toolCall({ toolName: "write", input: {} })).block, true);

	// Status shows w3 waiting on w1
	const statusWhileRunning = f.service.status(run.task_id);
	assert.equal(statusWhileRunning.agents[2].ownership_status, "waiting");
	assert.deepEqual(statusWhileRunning.agents[2].ownership_waiting_on?.map(w => w.node_id), ["w1"]);
	assert.match(formatAgentStates(statusWhileRunning.agents), /ownership: waiting on w1/);

	// w2 finishes independently while w1 still runs
	await w2.complete();
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "released");

	// w1 finishes -> w3 is durably admitted and triggered
	await w1.complete();
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a1-w1")).state, "released");
	t.mock.timers.tick(600);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "admitted");
	assert.equal(w3.deliveredMessages.length, 1);
	assert.equal(w3.deliveredMessages[0].message.customType, "bootstrap-ownership-admit");
	const w3Prompt = await w3.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: w3.deliveredMessages[0].message });
	assert.match(w3Prompt.systemPrompt, /Write A second/);
});

test("missing heartbeat, crash, needs_attention and corrupt results hold conflicting writers instead of releasing ownership", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Uncertain writer", project_cwd: f.cwd, request_id: "uncertain-hold",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src"], sub_task: "Modify src" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/sub/file.ts"], sub_task: "Modify child" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w1.start();
	await w2.start();
	await w1.beforeStart();
	await w2.input(w2.config.startup_message);

	// Delete w1's heartbeat and advance 20 minutes: heartbeat disappeared, execution remains uncertain -> w2 stays held!
	rmSync(join(run.session_dir, "a1-w1.progress.json"), { force: true });
	t.mock.timers.tick(20 * 60_000);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");
	assert.equal(w2.deliveredMessages.length, 0);
	await w2.beforeStart();
	assert.equal(w2.aborts, 1);

	// Even if w1 writes an error or needs_attention disposition or corrupt result, w2 stays held
	atomicJson(join(run.session_dir, "a1-w1.error.json"), { error: "crashed mid-edit" });
	t.mock.timers.tick(2000);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");
	let st = f.service.status(run.task_id);
	assert.equal(st.agents[1].ownership_status, "held_uncertain");
	assert.match(formatAgentStates(st.agents), /ownership: held by w1 \(uncertain/);

	rmSync(join(run.session_dir, "a1-w1.error.json"), { force: true });
	atomicJson(dispositionPath(run.session_dir, "a1-w1"), dispositionRecord(w1.config, "needs_attention", "Uncertain prior edit", [], new Date().toISOString()));
	t.mock.timers.tick(2000);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");

	// Corrupt result file also holds ownership
	rmSync(dispositionPath(run.session_dir, "a1-w1"), { force: true });
	writeFileSync(resultPath(run.session_dir, "a1-w1"), "{corrupt");
	t.mock.timers.tick(2000);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");
	st = f.service.status(run.task_id);
	assert.equal(st.agents[1].ownership_status, "held_uncertain");
});

test("ownership admission persists across reload/recovery and clean cancellation releases queued writers", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Reload and cancel", project_cwd: f.cwd, request_id: "reload-own",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/shared.ts"], sub_task: "First" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/shared.ts"], sub_task: "Second" },
			{ node_id: "w3", persona: "writer", write_paths: ["src/shared.ts"], sub_task: "Third" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	const w3 = workerFromConfig(t, join(run.session_dir, "a3-w3.config.json"));
	await w1.start();
	await w2.start();
	await w3.start();

	// Reload w2 while w1 is still running: w2 remains waiting
	const w2ReloadedWhileWaiting = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w2ReloadedWhileWaiting.start({ reason: "reload" });
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");
	await w2ReloadedWhileWaiting.beforeStart();
	assert.equal(w2ReloadedWhileWaiting.aborts, 1);

	// Clean cancellation of w1 (never executed) releases w2, while w3 still waits on w2
	atomicJson(dispositionPath(run.session_dir, "a1-w1"), dispositionRecord(w1.config, "cancelled", "Cancelled before execution", [], new Date().toISOString()));
	t.mock.timers.tick(600);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "admitted");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "waiting");

	// Reload w2 after it was admitted: admission persists across reload, and w3 still waits on w2
	const w2ReloadedAdmitted = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w2ReloadedAdmitted.start({ reason: "reload" });
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "admitted");
	await w2ReloadedAdmitted.beforeStart();
	assert.equal(w2ReloadedAdmitted.aborts, 0);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "waiting");
	await w3.beforeStart();
	assert.equal(w3.aborts, 1);

	await w2ReloadedAdmitted.complete();
	t.mock.timers.tick(600);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "admitted");
});

// ---- Slice 5: Member failure independence and explicit fail_fast policy ----

test("default failure_policy keeps healthy and serialized members independent of another member's failure", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Independent failures", project_cwd: f.cwd, request_id: "ind-fail",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Fail cleanly" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Succeed independently" },
			{ node_id: "w3", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Run after w1 finishes" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	const w3 = workerFromConfig(t, join(run.session_dir, "a3-w3.config.json"));
	await w1.start();
	await w2.start();
	await w3.start();
	await w1.beforeStart();
	await w2.beforeStart();
	await w3.input(w3.config.startup_message);

	await w1.complete({ status: "failure", summary: "lint failed", detail: "err" });
	assert.equal(existsSync(failFastPath(run.session_dir)), false);
	await w2.complete({ status: "success", summary: "w2 ok", detail: "done" });

	t.mock.timers.tick(600);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a3-w3")).state, "admitted");
	await w3.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: w3.deliveredMessages[0].message });
	await w3.complete({ status: "success", summary: "w3 ok", detail: "done" });

	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["failed", "succeeded", "succeeded"]);
	assert.equal(status.outcome.state, "failed");
	assert.equal(status.outcome.terminal, true);
	const report = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.match(formatReportDigest(report.results), /^2 success, 0 partial, 1 failure\.\nRun outcome: failed\./);
});

test("explicit fail_fast policy preserves committed results and cancels running and ownership-queued members", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Fail fast team", project_cwd: f.cwd, request_id: "fail-fast-1",
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "w0", persona: "writer", write_paths: ["src/z.ts"], sub_task: "Finish early" },
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Fail" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Still running" },
			{ node_id: "w3", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Queued on w1" },
		],
	}, TEST_MODEL);

	const w0 = workerFromConfig(t, join(run.session_dir, "a1-w0.config.json"));
	const w1 = workerFromConfig(t, join(run.session_dir, "a2-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a3-w2.config.json"));
	const w3 = workerFromConfig(t, join(run.session_dir, "a4-w3.config.json"));
	await w0.start(); await w1.start(); await w2.start(); await w3.start();
	await w0.beforeStart(); await w1.beforeStart(); await w2.beforeStart();
	await w3.input(w3.config.startup_message);

	// w0 completes before w1 fails
	await w0.complete({ status: "success", summary: "w0 committed", detail: "ok" });

	// w1 fails -> triggers fail-fast
	await w1.complete({ status: "failure", summary: "build broke", detail: "compile error" });
	assert.equal(existsSync(failFastPath(run.session_dir)), true);
	const ff = parseFailFastRecord(readJson(failFastPath(run.session_dir)), run.task_id, run.token);
	assert.equal(ff.cause.node_id, "w1");

	// Timer ticks: w2 and w3 are cancelled without w3 ever being admitted to ownership; w0 stays succeeded
	t.mock.timers.tick(600);
	assert.equal(readJson<any>(resultPath(run.session_dir, "a1-w0")).result.status, "success");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a4-w3")).state, "waiting");
	assert.equal(w3.deliveredMessages.length, 0);

	await w2.hooks.get("agent_settled")!({ aborted: true });
	const d2 = readJson<Disposition>(dispositionPath(run.session_dir, "a3-w2"));
	assert.equal(d2.state, "cancelled");
	assert.equal(d2.causes[0].node_id, "w1");
	const d3 = readJson<Disposition>(dispositionPath(run.session_dir, "a4-w3"));
	assert.equal(d3.state, "cancelled");
	assert.equal(d3.causes[0].node_id, "w1");
	assert.equal((await w2.toolCall({ toolName: "write", input: {} })).block, true);

	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(a => a.execution), ["succeeded", "failed", "cancelled", "cancelled"]);
	assert.equal(status.outcome.terminal, true);
	const report = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.match(formatReportDigest(report.results), /^1 success, 0 partial, 1 failure\. Not executed: 2 cancelled\./);
});

test("fail_fast also cancels peers when a member fails via worker error without a result", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Fail fast crash", project_cwd: f.cwd, request_id: "fail-fast-err",
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Crash" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Waiting" },
		],
	}, TEST_MODEL);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w1.start(); await w2.start();
	await w1.beforeStart();
	await w1.hooks.get("agent_settled")!({ aborted: false }, w1.context);

	assert.equal(existsSync(failFastPath(run.session_dir)), true);
	t.mock.timers.tick(600);
	const d2 = readJson<Disposition>(dispositionPath(run.session_dir, "a2-w2"));
	assert.equal(d2.state, "cancelled");
	assert.equal(d2.causes[0].node_id, "w1");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "waiting");
});

// ---- Review Fix Slice A: Glob directory containment, braces/char-classes & symlink resolution ----

test("glob overlap handles ** directory containment, dotted dir names, brace expansion and character classes", () => {
	assert.equal(pathsOverlap("src/**/a.ts", "src/sub"), true);
	assert.equal(pathsOverlap("src/sub", "src/**/a.ts"), true);
	assert.equal(pathsOverlap("src/**/*.ts", "src/v1.0"), true);
	assert.equal(pathsOverlap("src/**/a.ts", "src/b.ts"), false);

	assert.equal(pathsOverlap("src/*.{ts,tsx}", "src/a.ts"), true);
	assert.equal(pathsOverlap("src/*.{ts,tsx}", "src/a.tsx"), true);
	assert.equal(pathsOverlap("src/*.{ts,tsx}", "src/a.css"), false);
	assert.equal(pathsOverlap("src/{a,b}.ts", "src/a.ts"), true);
	assert.equal(pathsOverlap("src/{a,b}.ts", "src/c.ts"), false);
	assert.equal(pathsOverlap("src/[ab].ts", "src/a.ts"), true);
	assert.equal(pathsOverlap("src/[ab].ts", "src/c.ts"), false);
	assert.equal(pathsOverlap("src/[!a].ts", "src/a.ts"), false);
	assert.equal(pathsOverlap("src/[!a].ts", "src/b.ts"), true);
});

test("normalizeOwnershipPaths resolves symlinks for aliases, internal links and escape detection", t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-symlink-own-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const realProj = join(root, "real-proj");
	const linkProj = join(root, "link-proj");
	const outside = join(root, "outside");
	mkdirSync(join(realProj, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(realProj, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(outside, "secret.txt"), "nope\n");
	symlinkSync(realProj, linkProj);
	symlinkSync(join(realProj, "src"), join(realProj, "alias"));
	symlinkSync(outside, join(realProj, "escape"));

	// Symlinked cwd alias and realpath normalize consistently
	assert.deepEqual(normalizeOwnershipPaths(realpathSync(realProj), [join(linkProj, "src", "a.ts")], "write_paths"), ["src/a.ts"]);
	// Internal symlink resolves to the same canonical target so overlapping writers serialize
	assert.deepEqual(normalizeOwnershipPaths(realProj, ["alias/a.ts"], "write_paths"), ["src/a.ts"]);
	assert.deepEqual(normalizeOwnershipPaths(realProj, ["alias/*.ts"], "write_paths"), ["src/*.ts"]);
	// Symlink pointing outside project_cwd is rejected
	assert.throws(() => normalizeOwnershipPaths(realProj, ["escape/secret.txt"], "write_paths"), /escapes project_cwd/);
});

// ---- Review Fix Slice B: Pre-09 node-form request_id reservation compatibility ----

test("pre-09 node-form team and chain request_id reservations still resolve to their original runs after upgrade", async t => {
	const f = serviceFixture(t);
	const reservationFile = (key: string) => join(f.stateDir, `request-${createHash("sha256").update(key).digest("hex")}.json`);

	// 1. Pre-09 node-form team (v: 3, no collaboration_mode / failure_policy on reservation or manifest)
	const teamReq: GenerateRequest = {
		topology: "team", task: "Pre09 team", project_cwd: f.cwd, request_id: "pre09-team",
		agents: [{ node_id: "n1", persona: "writer", sub_task: "Do work" }],
	};
	const teamRun = await f.service.generate(teamReq);
	const pre09TeamFp = createHash("sha256").update(JSON.stringify({
		v: 3, topology: "team", task: "Pre09 team", project_cwd: realpathSync(f.cwd), ready_timeout_ms: 60_000, coms_extension: null,
		agents: [["n1", "writer", "Do work", null]], model: null,
	})).digest("hex");
	atomicJson(reservationFile("pre09-team"), { fingerprint: pre09TeamFp, task_id: teamRun.task_id });
	const teamManifest = readJson<any>(join(f.stateDir, `${teamRun.task_id}.json`));
	delete teamManifest.collaboration_mode; delete teamManifest.failure_policy; delete teamManifest.workspace_strategy;
	atomicJson(join(f.stateDir, `${teamRun.task_id}.json`), teamManifest);
	const retriedTeam = await new BootstrapService(f.options).generate(teamReq);
	assert.equal(retriedTeam.task_id, teamRun.task_id);

	// 2. Ticket 04-08 node-form chain with require_success (v: 3 + outcomes, no collaboration_mode / failure_policy)
	const chainReq: GenerateRequest = {
		topology: "chain", task: "Pre09 chain", project_cwd: f.cwd, request_id: "pre09-chain",
		agents: [
			{ node_id: "n1", persona: "writer", sub_task: "First" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Second" },
		],
	};
	const chainRun = await f.service.generate(chainReq);
	const pre09ChainFp = createHash("sha256").update(JSON.stringify({
		v: 3, topology: "chain", task: "Pre09 chain", project_cwd: realpathSync(f.cwd), ready_timeout_ms: 60_000, coms_extension: null,
		agents: [["n1", "writer", "First", 1], ["n2", "reviewer", "Second", 2]], model: null, outcomes: [null, "require_success"],
	})).digest("hex");
	atomicJson(reservationFile("pre09-chain"), { fingerprint: pre09ChainFp, task_id: chainRun.task_id });
	const chainManifest = readJson<any>(join(f.stateDir, `${chainRun.task_id}.json`));
	delete chainManifest.collaboration_mode; delete chainManifest.failure_policy; delete chainManifest.workspace_strategy;
	atomicJson(join(f.stateDir, `${chainRun.task_id}.json`), chainManifest);
	const retriedChain = await new BootstrapService(f.options).generate(chainReq);
	assert.equal(retriedChain.task_id, chainRun.task_id);

	// 3. Post-09 run (manifest HAS collaboration_mode) does NOT match a pre-09 reservation fingerprint
	const post09Run = await f.service.generate({ ...teamReq, request_id: "post09-team" });
	atomicJson(reservationFile("post09-team"), { fingerprint: pre09TeamFp, task_id: post09Run.task_id });
	await assert.rejects(f.service.generate({ ...teamReq, request_id: "post09-team" }), /different bootstrap plan/);
});

// ---- Review Fix Slice C: Persist startup_seen across /reload while queued for ownership ----

test("queued writer whose startup_message was consumed before /reload still triggers on admission after reload", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Startup seen across reload", project_cwd: f.cwd, request_id: "startup-reload",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "First" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Second after reload" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w1.start();
	await w2.start();
	await w1.beforeStart();

	// w2 consumes startup_message while waiting behind w1, then reloads before w1 finishes
	assert.equal((await w2.input(w2.config.startup_message)).action, "handled");
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).startup_seen, true);

	const w2Reloaded = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w2Reloaded.start({ reason: "reload" });

	// Now w1 finishes: w2Reloaded must admit and send bootstrap-ownership-admit without needing a second startup_message
	await w1.complete();
	t.mock.timers.tick(600);
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-w2")).state, "admitted");
	assert.equal(w2Reloaded.deliveredMessages.length, 1);
	assert.equal(w2Reloaded.deliveredMessages[0].message.customType, "bootstrap-ownership-admit");
});

// ---- Review Fix Slice D: Fail closed on unsupported/foreign ownership records & preserve own failure under fail_fast ----

test("unsupported or foreign ownership records surface as needs_attention in status and fail closed in worker without overwriting", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Unsupported ownership", project_cwd: f.cwd, request_id: "bad-own-record",
		agents: [{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Work" }],
	}, TEST_MODEL);

	const ownFile = ownershipPath(run.session_dir, "a1-w1");
	const unsupportedPayload = {
		version: 99,
		identity: { run_id: run.task_id, node_id: "w1", persona_name: "writer", attempt_id: "a1-w1.1", instance_id: "a1-w1" },
		state: "admitted",
	};
	atomicJson(ownFile, unsupportedPayload);

	// status() must surface needs_attention + error state without modifying the file
	const st = f.service.status(run.task_id);
	assert.equal(st.agents[0].execution, "needs_attention");
	assert.equal(st.agents[0].state, "error");
	assert.match(st.agents[0].error ?? "", /ownership/i);
	assert.equal(st.worker_errors.length, 1);
	assert.deepEqual(readJson(ownFile), unsupportedPayload);

	// Worker must fail closed without overwriting the unsupported record
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	await w1.start();
	assert.equal(w1.shutdowns, 1);
	assert.match(readJson<any>(join(run.session_dir, "a1-w1.error.json")).error, /Unsupported ownership record version 99/);
	assert.deepEqual(readJson(ownFile), unsupportedPayload);
	await w1.beforeStart();
	assert.equal(w1.aborts, 1);
});

test("fail_fast never overwrites a worker's own recorded failure with a cancelled disposition", async t => {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Own failure wins", project_cwd: f.cwd, request_id: "ff-own-fail",
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "w1", persona: "writer", write_paths: ["src/a.ts"], sub_task: "Fail first" },
			{ node_id: "w2", persona: "writer", write_paths: ["src/b.ts"], sub_task: "Hit own failure" },
		],
	}, TEST_MODEL);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-w1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-w2.config.json"));
	await w1.start();
	await w2.start();
	await w1.beforeStart();
	await w2.beforeStart();

	// w1 fails -> publishes fail-fast.json; simultaneously w2 settles without calling bootstrap_complete (records own error)
	await w1.complete({ status: "failure", summary: "w1 failed", detail: "err" });
	await w2.hooks.get("agent_settled")!({ aborted: false }, w2.context);
	assert.equal(existsSync(join(run.session_dir, "a2-w2.error.json")), true);

	t.mock.timers.tick(600);
	assert.equal(existsSync(dispositionPath(run.session_dir, "a2-w2")), false, "own error must not be masked by cancelled disposition");
	const st = f.service.status(run.task_id);
	assert.equal(st.agents[1].execution, "needs_attention");
	assert.match(st.agents[1].error ?? "", /without calling bootstrap_complete/);
});

test("recovery treats a valid fail-fast marker as a closed run and refuses redelivery", async t => {
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "chain", task: "Fail-fast closed recovery", project_cwd: f.cwd, request_id: "ff-recovery-closed",
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "n1", persona: "writer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "writer", sub_task: "Step 2" },
		],
	}, TEST_MODEL);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();
	await w1.complete({ status: "failure", summary: "n1 failed", detail: "err" });
	assert.equal(existsSync(failFastPath(run.session_dir)), true);

	const inspected = await f.service.recover(run.task_id, { action: "inspect" });
	assert.match(inspected.closed ?? "", /fail-fast/i);
	const retried = await f.service.recover(run.task_id, { action: "retry_delivery", agent: "n2" }, { wake: async () => { throw new Error("must not wake"); }, senderSession: "s-disp" });
	assert.match(retried.refused ?? "", /fail-fast.*closed run/i);
});

test("fail-fast holds active verification ownership and blocks reporting until agent settlement", async t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = serviceFixture(t);
	const run = await f.service.generate({
		topology: "team", task: "Fail during verification", project_cwd: f.cwd, request_id: "fail-fast-settlement",
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "n1", persona: "writer", sub_task: "Fail" },
			{ node_id: "n2", persona: "writer", write_paths: ["effect.txt"], sub_task: "Verify" },
		],
	}, TEST_MODEL);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await w1.start(); await w2.start();
	await w1.beforeStart(); await w2.beforeStart();
	let settled = false;
	const verification = w2.tools.get("bootstrap_verify").execute("slow", {
		action: "run", check_id: "slow", command: "while ! test -f release-tool; do sleep 0.01; done; printf late > effect.txt", scope: ["effect.txt"],
	}, undefined, undefined, w2.context).finally(() => { settled = true; });
	try {
		await w1.complete({ status: "failure", summary: "build broke", detail: "compile error" });
		t.mock.timers.tick(650);
		assert.equal(w2.aborts, 1);
		assert.equal((await w2.complete()).isError, true);
		assert.equal(settled, false);
		assert.equal(existsSync(join(f.cwd, "effect.txt")), false);
		const status = f.service.status(run.task_id);
		assert.deepEqual(status.agents.map(a => a.execution), ["failed", "running"]);
		assert.equal(status.agents[1].cancelling, true);
		assert.equal(status.outcome.terminal, false);
		assert.deepEqual(status.pending, ["n2"]);
		assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-n2")).state, "admitted");
		await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /Run is not complete/);
	} finally {
		writeFileSync(join(f.cwd, "release-tool"), "release");
		await verification;
	}
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-n2")).state, "admitted");
	await w2.hooks.get("agent_settled")!({ aborted: true });
	assert.equal(readJson<any>(ownershipPath(run.session_dir, "a2-n2")).state, "released");
	const disp = readJson<Disposition>(dispositionPath(run.session_dir, "a2-n2"));
	assert.equal(disp.state, "cancelled");
	assert.equal(disp.causes[0].node_id, "n1");
	assert.match(disp.reason, /build broke/);
	assert.equal(f.service.status(run.task_id).outcome.terminal, true);
	const report = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.deepEqual(report.results.map(r => r.status), ["failure", "cancelled"]);
});

test("invalid fail-fast evidence denies admission and recovery and retains attention without rewriting files", async t => {
	for (const topology of ["team", "chain"] as const) for (const kind of ["unsupported", "corrupt", "foreign"]) {
		const f = serviceFixture(t);
		const run = await f.service.generate({
			topology, task: "Invalid cancellation evidence", project_cwd: f.cwd, request_id: `invalid-ff-${kind}`,
			failure_policy: "fail_fast",
			agents: [{ node_id: "n1", persona: "writer", sub_task: "Fail" }, { node_id: "n2", persona: "writer", sub_task: "Must not start" }],
		}, TEST_MODEL);
		const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
		await w1.start(); await w1.beforeStart();
		const record = { version: kind === "unsupported" ? 99 : 1, task_id: kind === "foreign" ? "other-run" : run.task_id, token: run.token,
			cause: { node_id: "n1", instance_id: "a1-n1", state: "failed", reason: "original failure" }, recorded_at: new Date().toISOString() };
		const bytes = kind === "corrupt" ? "{torn" : JSON.stringify(record);
		writeFileSync(failFastPath(run.session_dir), bytes);
		await w1.complete({ status: "failure", summary: "build broke", detail: "err" });
		// Inspect before the peer starts: status must diagnose the record itself.
		const initial = f.service.status(run.task_id);
		assert.match(initial.worker_errors.join("\n"), /unusable fail-fast record/i, kind);
		assert.equal(initial.outcome.terminal, false, kind);
		const w2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
		await w2.start();
		assert.equal(await w2.beforeStart(), undefined, kind);
		assert.equal((await w2.toolCall({ toolName: "bash", input: { command: "echo forbidden" } })).block, true, kind);
		const status = f.service.status(run.task_id);
		assert.equal(status.agents[1].execution, "needs_attention", kind);
		assert.match(status.worker_errors.join("\n"), /unusable fail-fast record/i, kind);
		await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /Run is not complete/);
		if (topology === "chain") {
			const inspected = await f.service.recover(run.task_id, { action: "inspect" });
			assert.match(inspected.closed ?? "", /fail-fast.*cannot be read/i, kind);
			const retried = await f.service.recover(run.task_id, { action: "retry_delivery", agent: "n2" }, {
				wake: async () => { assert.fail("invalid fail-fast evidence must deny delivery"); }, senderSession: "dispatcher",
			});
			assert.match(retried.refused ?? "", /fail-fast/i, kind);
		}
		assert.equal(readFileSync(failFastPath(run.session_dir), "utf8"), bytes, kind);
		assert.equal(readJson<Disposition>(dispositionPath(run.session_dir, "a2-n2")).state, "needs_attention", kind);
		const reloaded = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
		await reloaded.start({ reason: "reload" });
		assert.equal(await reloaded.beforeStart(), undefined, `${kind}: reload must retain attention`);
		assert.equal((await reloaded.toolCall({ toolName: "bash", input: {} })).block, true, kind);

	}
});
