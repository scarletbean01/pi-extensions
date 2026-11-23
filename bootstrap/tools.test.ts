import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import type { ExecResult } from "./lifecycle.ts";
import { handoffClaimPath, handoffId, handoffOfferPath, inputDigest } from "./handoff.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, SessionStore, type BootstrapManifest, type WorkerConfig } from "./session-store.ts";

// Pi supplies TypeBox at runtime; the tool layer only needs its schema constructors here (the runtime suite loads the real package).
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

/** Load the extension against a recording stub of Pi's API, with a project that has one persona. */
function loaded(t: test.TestContext, model = "", exec?: (command: string, args: string[]) => ExecResult) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-tools-test-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const agentDir = join(root, "agent");
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, bin, agentDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), `---\nname: reviewer\ntools: read\n${model ? `model: ${model}\n` : ""}---\nReview carefully.\n`);
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["pi", "herdr"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const saved = { PATH: process.env.PATH, home: process.env.HOME, state: process.env.PI_BOOTSTRAP_STATE_DIR, agentDir: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = home;
	process.env.PATH = bin;
	process.env.PI_BOOTSTRAP_STATE_DIR = join(root, "state");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		process.env.PATH = saved.PATH;
		if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
		if (saved.state === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR; else process.env.PI_BOOTSTRAP_STATE_DIR = saved.state;
		if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});
	const execCalls: string[] = [];
	const followUps: string[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function>();
	const flags = new Set<string>();
	registerBootstrap({ sendMessage: (message: { content: string }) => followUps.push(message.content), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: Function) => hooks.set(name, handler), registerFlag: (name: string) => flags.add(name), getFlag: (name: string) => flags.has(name) && process.argv.includes(`--${name}`) ? "/worker-config" : undefined, exec: async (command: string, args: string[]) => {
		execCalls.push(command);
		return exec?.(command, args) ?? { stdout: "", stderr: "", code: 0 };
	} } as any);
	const widgets = new Map<string, { render(width: number): string[] }>();
	let redraws = 0;
	const notifications: Array<[string, string]> = [];
	const ctx = {
		cwd, model: { provider: "provider", id: "model" } as { provider: string; id: string } | undefined,
		hasUI: false,
		ui: {
			notify: (message: string, level: string) => { notifications.push([message, level]); },
			setTheme: () => ({ success: true }),
			setWidget(key: string, factory?: Function) {
				if (factory) widgets.set(key, factory({ requestRender: () => { redraws++; } }, { fg: (_color: string, text: string) => text }));
				else widgets.delete(key);
			},
		},
	};
	return { cwd, home, agentDir, ctx, tools, commands, hooks, widgets, notifications, followUps, execCalls, get redraws() { return redraws; }, call: (name: string, params: unknown) => tools.get(name).execute("call-1", params, undefined, undefined, ctx) };
}

const text = (result: any) => result.content.map((part: any) => part.text).join("\n");

function reviewPlan(f: ReturnType<typeof loaded>, dry_run = true) {
	return f.call("bootstrap_generate", {
		topology: "team", task: "Review", project_cwd: f.cwd, dry_run,
		agents: [{ persona: "reviewer", sub_task: "Review it" }],
	});
}

test("bootstrap_status names the persona and unknown skill after a failed launch", async t => {
	const previousHerdr = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	t.after(() => {
		for (const [key, value] of Object.entries(previousHerdr)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "dispatcher";
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
		if (args[0] === "tab" && args[1] === "create") {
			const id = String(tabs.length + 1);
			const tab = { tab_id: id, pane_id: id, terminal_id: id, label: args[args.indexOf("--label") + 1], cwd: f.cwd };
			tabs.push(tab);
			return ok({ tab, root_pane: { pane_id: id, terminal_id: id } });
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs, panes: tabs });
		if (args[0] === "tab" && args[1] === "close") {
			const index = tabs.findIndex(tab => tab.tab_id === args[2]);
			assert.notEqual(index, -1);
			tabs.splice(index, 1);
			return ok({});
		}
		assert.deepEqual(args.slice(0, 2), ["pane", "run"]);
		const [task, instance] = tabs.find(tab => tab.pane_id === args[2])!.label.split(":");
		const dir = join(f.cwd, ".pi", "agent-sessions", task);
		const config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
		const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
		atomicJson(readyPath(dir, instance), config.node_id === "audit"
			? { ...ready, kept_skills: [], unmatched_skills: ["serach"] }
			: ready);
		return ok({});
	});
	writeFileSync(join(f.cwd, ".pi", "agents", "reviewer.md"), "---\nmodel: provider/model\nskills: serach\n---\nReview.");
	writeFileSync(join(f.cwd, ".pi", "agents", "helper.md"), "---\nmodel: provider/model\n---\nHelp.");
	const run = await f.call("bootstrap_generate", {
		task: "Review", topology: "chain", project_cwd: f.cwd,
		agents: [{ node_id: "help", persona: "helper", sub_task: "Help", step: 1 }, { node_id: "audit", persona: "reviewer", sub_task: "Review", step: 2 }],
	});
	const status = await f.call("bootstrap_status", { task_id: run.details.task_id });
	const failure = 'Persona "reviewer" names skills Pi did not discover: "serach"';
	assert.match(text(status), /\[error\/failed\]/);
	// Standalone runs have no factory binding to show (ticket 04 regression).
	assert.equal(status.details.factory_binding, undefined);
	assert.doesNotMatch(text(status), /Factory version/);
	assert.equal(status.details.agents[1].state, "error");
	assert.equal(status.details.agents[1].error, failure);
	assert.equal(status.details.agents[0].resource, "ready");
	assert.equal(status.details.agents[0].error, undefined);
	assert.equal(existsSync(join(run.details.session_dir, "release.json")), false);
	assert.equal(existsSync(join(run.details.session_dir, "abort.json")), true);
	const recovery = await f.call("bootstrap_recover", { task_id: run.details.task_id, action: "retry_delivery", agent: "audit" });
	assert.equal(recovery.details.status, "not_retried");
	assert.ok(recovery.details.refused.includes(failure));
	const cleanup = await f.call("bootstrap_cleanup", { task_id: run.details.task_id });
	assert.equal(cleanup.details.status, "cleaned");
	assert.deepEqual(tabs, []);
});

test("a dry run shows each persona's allowed skills without checking discovery or using node overrides", async t => {
	const f = loaded(t, "provider/model");
	const dir = join(f.cwd, ".pi", "agents");
	writeFileSync(join(dir, "reviewer.md"), '---\nmodel: provider/model\nskills: "missing-skill, Review"\n---\nReview.');
	writeFileSync(join(dir, "scout.md"), "---\nmodel: provider/model\nskills:\n---\nScout.");
	writeFileSync(join(dir, "general.md"), "---\nmodel: provider/model\n---\nHelp.");
	const result = await f.call("bootstrap_generate", {
		topology: "team", task: "Review", project_cwd: f.cwd, dry_run: true,
		agents: [
			{ persona: "reviewer", sub_task: "Review it", skills: ["override"] },
			{ persona: "scout", sub_task: "Scout it" },
			{ persona: "general", sub_task: "Help out" },
		],
	});
	assert.equal(result.isError, undefined, text(result));
	assert.deepEqual(result.details.plan.agents.map((agent: any) => agent.allowed_skills), [["missing-skill", "Review"], [], undefined]);
	assert.match(text(result), /allowed skills: missing-skill, Review/);
	assert.match(text(result), /allowed skills: none/);
	assert.match(text(result), /allowed skills: all/);
});

test("bootstrap_generate rejects a skill named none during planning in both launch modes", async t => {
	const f = loaded(t);
	const persona = join(f.cwd, ".pi", "agents", "reviewer.md");
	for (const skills of ["none", "Review, none"]) {
		writeFileSync(persona, `---\nmodel: provider/model\nskills: ${skills}\n---\nReview.`);
		for (const dryRun of [true, false]) {
			const result = await reviewPlan(f, dryRun);
			assert.equal(result.isError, true, text(result));
			assert.equal(result.details.phase, "preflight", text(result));
			assert.ok(text(result).includes(`${persona} ("skills")`), text(result));
			assert.match(text(result), /empty `skills:` field.*no skills/);
			assert.match(text(result), /skill named "none" cannot be allowed/);
		}
	}
	assert.deepEqual(f.execCalls, []);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);

	writeFileSync(persona, "---\nmodel: provider/model\nskills: None\n---\nReview.");
	const result = await reviewPlan(f);
	assert.equal(result.isError, undefined, text(result));
	assert.deepEqual(result.details.plan.agents[0].allowed_skills, ["None"]);
});

test("a dry run resolves a case-insensitive global model alias and keeps the persona's thinking suffix", async t => {
	const f = loaded(t, "ReviewModel:low");
	writeFileSync(join(f.agentDir, "bootstrap.json"), JSON.stringify({
		modelAliases: { reviewmodel: { model: "example/Review-v2", thinking: "high" } },
		futureSetting: true,
	}));
	const result = await reviewPlan(f);
	assert.equal(result.isError, undefined, text(result));
	assert.equal(result.details.plan.agents[0].model, "example/Review-v2");
	assert.match(text(result), /example\/Review-v2; thinking low/);
});

test("a dry run uses the project model alias over the global alias of the same name", async t => {
	const f = loaded(t, "reviewmodel");
	writeFileSync(join(f.agentDir, "bootstrap.json"), JSON.stringify({
		modelAliases: { ReviewModel: { model: "example/global", thinking: "high" } },
	}));
	const global = await reviewPlan(f);
	assert.equal(global.isError, undefined, text(global));
	assert.equal(global.details.plan.agents[0].model, "example/global");

	writeFileSync(join(f.cwd, ".pi", "bootstrap.json"), JSON.stringify({
		modelAliases: { REVIEWMODEL: { model: "example/project" } },
	}));
	const result = await reviewPlan(f);
	assert.equal(result.isError, undefined, text(result));
	assert.equal(result.details.plan.agents[0].model, "example/project");
});

test("invalid bootstrap configuration identifies the file or invalid alias key before launching anything", async t => {
	const f = loaded(t, "example/explicit");
	const projectConfig = join(f.cwd, ".pi", "bootstrap.json");
	const globalConfig = join(f.agentDir, "bootstrap.json");
	const cases = [
		[globalConfig, '{"modelAliases":', "configuration file contains invalid JSON"],
		[projectConfig, "[]", "configuration file must contain a JSON object"],
		[projectConfig, '{"modelAliases":null}', "modelAliases"],
		[projectConfig, '{"modelAliases":{"review":"example/model"}}', "modelAliases.review"],
		[projectConfig, '{"modelAliases":{"review":[]}}', "modelAliases.review"],
		[projectConfig, '{"modelAliases":{"review":{}}}', "modelAliases.review.model"],
		[projectConfig, '{"modelAliases":{"review":{"model":42}}}', "modelAliases.review.model"],
		[projectConfig, '{"modelAliases":{"review":{"model":"short-name"}}}', "modelAliases.review.model"],
		[projectConfig, '{"modelAliases":{"review":{"model":"example/"}}}', "modelAliases.review.model"],
		[projectConfig, '{"modelAliases":{"review":{"model":"example/model","thinking":true}}}', "modelAliases.review.thinking"],
		[projectConfig, '{"modelAliases":{"review":{"model":"example/model","thinking":"extreme"}}}', "modelAliases.review.thinking"],
		[projectConfig, '{"modelAliases":{"Review":{"model":"example/one"},"review":{"model":"example/two"}}}', "modelAliases.review"],
	];
	for (const [file, config, key] of cases) {
		writeFileSync(file, config);
		for (const dryRun of [true, false]) {
			const result = await reviewPlan(f, dryRun);
			assert.equal(result.isError, true, config);
			assert.equal(result.details.phase, "preflight", text(result));
			assert.ok(text(result).includes(file), text(result));
			assert.ok(text(result).includes(key.startsWith("modelAliases") ? `"${key}"` : key), text(result));
		}
		rmSync(file);
	}
	assert.deepEqual(f.execCalls, []);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
});

test("with no config files, an undeclared persona model inherits the session model or fails if there is none", async t => {
	const f = loaded(t);
	const inherited = await reviewPlan(f);
	assert.equal(inherited.isError, undefined, text(inherited));
	assert.equal(inherited.details.plan.agents[0].model, "provider/model");

	f.ctx.model = undefined;
	const missing = await reviewPlan(f);
	assert.equal(missing.isError, true, text(missing));
	assert.match(text(missing), /reviewer\.md.*"model".*persona "reviewer".*inherit/i);
});

test("a dry run rejects an undefined model alias even if it was previously built in", async t => {
	const f = loaded(t, "Sonnet");
	const result = await reviewPlan(f);
	assert.equal(result.isError, true, text(result));
	assert.match(text(result), /reviewer\.md.*"model".*Unknown model alias "Sonnet"/);
});

test("a dry run preserves a full model ID with a thinking suffix without any alias files", async t => {
	const f = loaded(t, "example/Vendor/Review-v2:xhigh");
	f.ctx.model = undefined;
	const result = await reviewPlan(f);
	assert.equal(result.isError, undefined, text(result));
	assert.equal(result.details.plan.agents[0].model, "example/Vendor/Review-v2");
	assert.match(text(result), /example\/Vendor\/Review-v2; thinking xhigh/);
});

test("a dry run preserves colon tags in full model IDs and resolves optional thinking levels", async t => {
	const f = loaded(t);
	const persona = join(f.cwd, ".pi", "agents", "reviewer.md");
	for (const [spec, field, model, thinking] of [
		["ollama/llama3:8b", undefined, "ollama/llama3:8b", undefined],
		["provider/model:0", "low", "provider/model:0", "low"],
		["ollama/llama3:8b:HIGH", "low", "ollama/llama3:8b", "high"],
	]) {
		writeFileSync(persona, `---\nmodel: ${spec}\n${field ? `thinking: ${field}\n` : ""}---\nReview.`);
		const result = await reviewPlan(f);
		assert.equal(result.isError, undefined, text(result));
		assert.equal(result.details.plan.agents[0].model, model);
		assert.equal(result.details.plan.agents[0].thinking, thinking);
	}
});

test("a dry run shows two assignments of one persona with their node IDs", async t => {
	const f = loaded(t);
	const result = await f.call("bootstrap_generate", {
		topology: "team", task: "Review the change", project_cwd: f.cwd, dry_run: true,
		agents: [{ node_id: "review-api", persona: "reviewer", sub_task: "Review the API" }, { node_id: "review-ui", persona: "reviewer", sub_task: "Review the UI" }],
	});
	assert.equal(result.isError, undefined, text(result));
	assert.match(text(result), /a1-review-api: node review-api, persona reviewer from /);
	assert.match(text(result), /a2-review-ui: node review-ui, persona reviewer from /);
	assert.deepEqual(result.details.plan.agents.map((agent: any) => [agent.node_id, agent.persona_name, agent.attempt_id]), [["review-api", "reviewer", "a1-review-api.1"], ["review-ui", "reviewer", "a2-review-ui.1"]]);
});

test("a dry run discovers personas only in Pi's project and global folders", async t => {
	const f = loaded(t);
	const projectPersona = realpathSync(join(f.cwd, ".pi", "agents", "reviewer.md"));
	const globalDir = join(f.agentDir, "agents");
	mkdirSync(globalDir, { recursive: true });
	const globalPersona = join(globalDir, "scout.md");
	writeFileSync(globalPersona, "Scout the project.");
	writeFileSync(join(globalDir, "duplicate.md"), "---\nname: Reviewer\n---\nGlobal reviewer.");

	const ignored = [
		["project-claude", join(f.cwd, ".claude", "agents")],
		["project-gemini", join(f.cwd, ".gemini", "agents")],
		["project-codex", join(f.cwd, ".codex", "agents")],
		["project-plain", join(f.cwd, "agents")],
		["home-default", join(f.home, ".pi", "agent", "agents")], // not used while PI_CODING_AGENT_DIR points elsewhere
		["global-claude", join(f.home, ".claude", "agents")],
		["global-gemini", join(f.home, ".gemini", "agents")],
		["global-codex", join(f.home, ".codex", "agents")],
	];
	for (const [persona, dir] of ignored) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${persona}.md`), "Ignored persona.");
	}
	const dryRun = (...personas: string[]) => f.call("bootstrap_generate", {
		topology: "team", task: "Review the project", project_cwd: f.cwd, dry_run: true,
		agents: personas.map(persona => ({ persona, sub_task: "Inspect the project" })),
	});
	const result = await dryRun("REVIEWER", "scout");
	assert.equal(result.isError, undefined, text(result));
	assert.deepEqual(result.details.plan.agents.map((agent: any) => [agent.persona_name, agent.persona_file, agent.persona_source]), [
		["reviewer", projectPersona, ".pi"],
		["scout", globalPersona, "~/.pi"],
	]);
	for (const [persona] of ignored) {
		const rejected = await dryRun(persona);
		assert.equal(rejected.isError, true, `Expected ${persona} to be unknown. ${text(rejected)}`);
		assert.equal(text(rejected), `Node ${persona}: Agent "${persona}" not found. Available: reviewer, scout`);
	}
});

test("a legacy dry run still reads naturally, and duplicate node IDs are reported to the model as an error", async t => {
	const f = loaded(t);
	const legacy = await f.call("bootstrap_generate", { topology: "team", task: "Review", project_cwd: f.cwd, dry_run: true, agents: [{ name: "reviewer", sub_task: "Review it" }] });
	assert.match(text(legacy), /a1-reviewer: persona reviewer from /);
	const duplicate = await f.call("bootstrap_generate", { topology: "team", task: "Review", project_cwd: f.cwd, dry_run: true, agents: [{ name: "reviewer", sub_task: "a" }, { persona: "reviewer", sub_task: "b" }] });
	assert.equal(duplicate.isError, true);
	assert.match(text(duplicate), /Duplicate node ID: reviewer\. Give assignments that share a persona distinct node_id values/);
});

test("model-facing tool descriptions and schemas explain node IDs, personas and selection", async t => {
	const f = loaded(t);
	const generate = f.tools.get("bootstrap_generate");
	assert.match(generate.description, /unique node_id/);
	assert.match(generate.description, /several assignments can use the same persona/);
	assert.match(generate.description, /name \+ sub_task.* still works/);
	assert.match(JSON.stringify(generate.parameters), /"node_id"[\s\S]*"persona"[\s\S]*"name"/);
	assert.match(f.tools.get("bootstrap_cleanup").description, /ambiguous selector is rejected without closing anything/);
	assert.match(f.tools.get("bootstrap_report").description, /identified by node_id/);
	assert.match(JSON.stringify(f.tools.get("bootstrap_report").parameters), /"node_id"/);
});

// ---- ticket 04: outcomes and dependency policies in the model-facing layer ----

test("tool text and schemas describe dependency policies, required checks and the outcome states", async t => {
	const f = loaded(t);
	const generate = f.tools.get("bootstrap_generate");
	assert.match(generate.description, /require_success/);
	assert.match(generate.description, /allow_partial/);
	assert.match(generate.description, /legacy name form keeps allow_partial/);
	assert.match(generate.description, /blocked.*not.*failed/i);
	assert.match(JSON.stringify(generate.parameters), /"dependency_policy"/);
	assert.match(generate.description, /required_checks are also what its dependent needs.*missing, failed, unverified and stale evidence each block it/);
	assert.match(f.tools.get("bootstrap_status").description, /pending, waiting, running, succeeded, partial, failed, blocked, skipped, cancelled or needs_attention/);
	assert.match(f.tools.get("bootstrap_report").description, /did not execute.*blocked.*cannot be given a result/);
});

test("a dry run shows each dependency's policy", async t => {
	const f = loaded(t);
	const agents = [{ node_id: "build", persona: "reviewer", sub_task: "Build", required_checks: ["tests"] }, { node_id: "ship", persona: "reviewer", sub_task: "Ship" }];
	const modern = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents });
	assert.match(text(modern), /plan · chain · 2 nodes\n◌ build ──▶ ◌ ship\n/);
	assert.doesNotMatch(text(modern), /\x1b\[/);
	assert.match(text(modern), /a2-ship \(step 2\): node ship, persona reviewer from .*\n  model .*\n  dependency: require_success\n  task: Ship/);
	const teamDry = await f.call("bootstrap_generate", { topology: "team", task: "Review", project_cwd: f.cwd, dry_run: true, agents: [{ node_id: "a", persona: "reviewer", sub_task: "A" }, { node_id: "b", persona: "reviewer", sub_task: "B" }] });
	assert.match(text(teamDry), /plan · team · 2 nodes\n◌ a\n◌ b\n/);
	assert.doesNotMatch(text(teamDry), /\x1b\[/);
	assert.doesNotMatch(text(modern).split("a2-ship")[0], /dependency:/, "the first node has no dependency");
	const lenient = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents: [agents[0], { ...agents[1], dependency_policy: "allow_partial" }] });
	assert.match(text(lenient), /dependency: allow_partial\n/);
	const legacy = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents: [{ name: "reviewer", sub_task: "a" }] });
	assert.doesNotMatch(text(legacy), /dependency:/, "a single node has no dependency");
	const rejected = await f.call("bootstrap_generate", { topology: "team", task: "x", project_cwd: f.cwd, dry_run: true, agents: [{ node_id: "a", persona: "reviewer", sub_task: "x", dependency_policy: "allow_partial" }] });
	assert.equal(rejected.isError, true);
	assert.match(text(rejected), /Team agents cannot declare a dependency policy/);
});

/** A released three-node chain whose first node failed: written exactly as the service persists it. */
function failedChain(f: ReturnType<typeof loaded>, root: string) {
	const taskId = "chain-failed-1";
	const project = realpathSync(f.cwd);
	const sessionDir = join(project, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const nodes = ["n1", "n2", "n3"].map((node, i, all) => ({
		node_id: node, persona_name: "reviewer", attempt_id: `a${i + 1}-${node}.1`, instance_id: `a${i + 1}-${node}`, expected_coms_name: `a${i + 1}-${node}`, expected_model: "provider/model", label: `${taskId}:a${i + 1}-${node}`, step: i + 1,
		predecessor: i ? `a${i}-${all[i - 1]}` : undefined, successor: all[i + 1] ? `a${i + 2}-${all[i + 1]}` : undefined, status: "released", ...(i ? { dependency_policy: "require_success" } : {}),
	}));
	const manifest = { version: 2, request_form: "nodes", task_id: taskId, task: "Chain", topology: "chain", project_cwd: project, session_dir: sessionDir, workspace_id: "w", coms_project: `boot-${taskId}`, status: "applied", phase: "released", token: "tok", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", pane_manifest: nodes };
	mkdirSync(join(root, "state"), { recursive: true });
	for (const path of [join(root, "state", `${taskId}.json`), join(sessionDir, "manifest.json")]) writeFileSync(path, JSON.stringify(manifest));
	const identity = (node: (typeof nodes)[number]) => ({ run_id: taskId, node_id: node.node_id, persona_name: "reviewer", attempt_id: node.attempt_id, instance_id: node.instance_id });
	writeFileSync(join(sessionDir, `${nodes[0].instance_id}.result.json`), JSON.stringify({ version: 2, identity: identity(nodes[0]), result: { agent_name: "reviewer", node_id: "n1", status: "failure", summary: "compile error", detail: "" }, delivery: "sent", completed_at: "2026-01-01T00:01:00.000Z" }));
	const blocked = (node: (typeof nodes)[number], reason: string, causes: unknown[]) => writeFileSync(join(sessionDir, `${node.instance_id}.disposition.json`), JSON.stringify({ version: 1, identity: identity(node), state: "blocked", reason, causes, recorded_at: "2026-01-01T00:02:00.000Z" }));
	blocked(nodes[1], "n1 failed: compile error", [{ node_id: "n1", state: "failed", reason: "compile error" }]);
	blocked(nodes[2], "n2 is blocked: n1 failed: compile error", [{ node_id: "n2", state: "blocked", reason: "n1 failed" }, { node_id: "n1", state: "failed", reason: "compile error" }]);
	return taskId;
}

test("status and report tell the dispatcher what ran, what was blocked and why, and what the run amounts to", async t => {
	const f = loaded(t);
	const taskId = failedChain(f, dirname(f.cwd));
	const status = await f.call("bootstrap_status", { task_id: taskId });
	assert.equal(status.isError, undefined, text(status));
	assert.match(text(status), /1\/3 result\(s\); pending: none\./);
	assert.match(text(status), /a1-n1 \(n1, persona reviewer\): done failure: compile error \[execution failed\]/);
	assert.match(text(status), /a3-n3 \(n3, persona reviewer\): done — n2 is blocked.* \[execution blocked; caused by n2 \(blocked\), n1 \(failed\)\]/);
	assert.match(text(status), /Run outcome: failed \(1 failed, 2 blocked\)\./);
	assert.match(text(status), /Did not execute: n2 \(blocked\), n3 \(blocked\)\. They have no results/);
	assert.match(text(status), /every node reached a final state\): call bootstrap_report without results/);
	assert.deepEqual(status.details.agents.map((agent: any) => agent.execution), ["failed", "blocked", "blocked"]);
	assert.equal(status.details.outcome.state, "failed");
	const report = await f.call("bootstrap_report", { task_id: taskId, write_markdown: true });
	assert.equal(report.isError, undefined, text(report));
	assert.match(text(report), /0 success, 0 partial, 1 failure\. Not executed: 2 blocked\.\nRun outcome: failed\./);
	assert.deepEqual(report.details.results.map((entry: any) => [entry.node_id, entry.status]), [["n1", "failure"], ["n2", "blocked"], ["n3", "blocked"]]);
});

test("/boot <task_id> shows each node's execution state and the run outcome", async t => {
	const f = loaded(t);
	const taskId = failedChain(f, dirname(f.cwd));
	const notes: Array<[string, string]> = [];
	await f.commands.get("boot").handler(taskId, { cwd: f.cwd, ui: { notify: (message: string, level: string) => notes.push([message, level]) } });
	assert.match(notes[0][0], /\[execution blocked; caused by n2 \(blocked\), n1 \(failed\)\]/);
	assert.match(notes[0][0], /Run outcome: failed \(1 failed, 2 blocked\)\./);
});

test("model-facing tool descriptions and schemas expose shared briefs, output contracts and verification freshness", async t => {
	const f = loaded(t);
	const generate = f.tools.get("bootstrap_generate");
	const status = f.tools.get("bootstrap_status");
	assert.match(generate.description, /goal|acceptance_criteria|output_contract/i);
	assert.match(generate.description, /immutable/i);
	assert.match(status.description, /verification|stale|unknown/i);
	const genSchema = JSON.stringify(generate.parameters);
	for (const field of ["goal", "acceptance_criteria", "constraints", "role", "ownership", "output_contract", "required_checks"]) {
		assert.match(genSchema, new RegExp(`"${field}"`), `bootstrap_generate schema missing ${field}`);
	}
	assert.match(JSON.stringify(f.tools.get("bootstrap_report").parameters), /"outputs"/);

	const dry = await f.call("bootstrap_generate", {
		topology: "chain",
		task: "Review and verify",
		goal: "Ship safe change",
		acceptance_criteria: ["All checks pass"],
		constraints: ["No worktrees"],
		project_cwd: f.cwd,
		dry_run: true,
		agents: [
			{
				node_id: "review-api",
				persona: "reviewer",
				role: "API reviewer",
				ownership: ["src/api.ts"],
				output_contract: { required_fields: ["verdict"] },
				required_checks: ["api-tests"],
				sub_task: "Review API",
			},
		],
	});
	assert.equal(dry.isError, undefined, text(dry));
	assert.match(text(dry), /goal: Ship safe change/);
	assert.match(text(dry), /role: API reviewer/);
	assert.match(text(dry), /ownership: src\/api\.ts/);
	assert.match(text(dry), /output_contract:/);
	assert.match(text(dry), /required_checks: api-tests/);
});

// ---- ticket 09: independent teams, read/write ownership & failure policies in the model-facing layer ----

test("model-facing tool text and schemas describe independent mode, read/write ownership, failure policy and advisory shared-cwd contract", async t => {
	const f = loaded(t);
	const generate = f.tools.get("bootstrap_generate");
	const status = f.tools.get("bootstrap_status");
	assert.match(generate.description, /collaboration_mode/i);
	assert.match(generate.description, /independent/i);
	assert.match(generate.description, /collaborative/i);
	assert.match(generate.description, /failure_policy/i);
	assert.match(generate.description, /fail_fast/i);
	assert.match(generate.description, /read_paths/);
	assert.match(generate.description, /write_paths/);
	assert.match(generate.description, /advisory/i);
	assert.match(generate.description, /not a filesystem sandbox/i);
	assert.match(status.description, /ownership/i);

	const genSchema = JSON.stringify(generate.parameters);
	for (const field of ["collaboration_mode", "failure_policy", "read_paths", "write_paths"]) {
		assert.match(genSchema, new RegExp(`"${field}"`), `bootstrap_generate schema missing ${field}`);
	}

	const dry = await f.call("bootstrap_generate", {
		topology: "team",
		task: "Parallel edits",
		project_cwd: f.cwd,
		dry_run: true,
		failure_policy: "fail_fast",
		agents: [
			{ node_id: "w1", persona: "reviewer", write_paths: ["src/a.ts"], read_paths: ["src/types.ts"], sub_task: "Edit a" },
			{ node_id: "w2", persona: "reviewer", write_paths: ["src/a.ts"], sub_task: "Edit a next" },
		],
	});
	assert.equal(dry.isError, undefined, text(dry));
	assert.match(text(dry), /workspace: shared_cwd/);
	assert.match(text(dry), /collaboration: independent; failure_policy: fail_fast/);
	assert.match(text(dry), /ownership_wait_for: a1-w1/);
	assert.match(text(dry), /advisory scheduling contract/i);

	const legacyDry = await f.call("bootstrap_generate", {
		topology: "team",
		task: "Legacy team",
		project_cwd: f.cwd,
		dry_run: true,
		agents: [{ name: "reviewer", sub_task: "Review" }],
	});
	assert.equal(legacyDry.isError, undefined, text(legacyDry));
	assert.match(text(legacyDry), /collaboration: legacy.*persona\/node_id/i);
});

// ---- ticket 06: handoff delivery versus acceptance in the model-facing layer ----

test("tool text separates handoff delivery from task acceptance", async t => {
	const f = loaded(t);
	assert.match(f.tools.get("bootstrap_generate").description, /handoff.*(queued|delivered).*not.*accept.*successor.*claims/i);
	assert.match(f.tools.get("bootstrap_status").description, /handoff.*queued.*accepted.*rejected.*independent.*execution/i);
	assert.match(f.tools.get("bootstrap_status").description, /accepted.*no result.*needs_attention.*not replayed/i);
});

// ---- ticket 08: cancellation and configurable deadlines in the model-facing layer ----

test("tool text and schemas expose bootstrap_cancel, separate deadlines, liveness diagnosis, and hook limits", async t => {
	const f = loaded(t);
	const cancel = f.tools.get("bootstrap_cancel");
	assert.ok(cancel, "bootstrap_cancel tool must be registered");
	assert.match(cancel.description, /separate from closing tabs and deleting/i);
	assert.match(cancel.description, /grace period/i);
	assert.match(cancel.description, /force_close/i);
	assert.match(cancel.description, /cannot undo.*tool side effect/i);
	assert.match(cancel.description, /preserved|preserve/i);
	const cancelSchema = JSON.stringify(cancel.parameters);
	for (const field of ["task_id", "agents", "reason", "grace_ms", "force_close"]) {
		assert.match(cancelSchema, new RegExp(`"${field}"`), `bootstrap_cancel schema missing ${field}`);
	}

	const generate = f.tools.get("bootstrap_generate");
	const genSchema = JSON.stringify(generate.parameters);
	for (const field of ["task_timeout_ms", "dependency_wait_timeout_ms", "liveness_timeout_ms", "cancel_grace_ms"]) {
		assert.match(genSchema, new RegExp(`"${field}"`), `bootstrap_generate schema missing ${field}`);
	}
	assert.match(generate.description, /task_timeout_ms.*dependency_wait_timeout_ms.*liveness_timeout_ms/i);
	assert.match(f.tools.get("bootstrap_status").description, /heartbeat.*useful progress|liveness.*diagnosis/i);
	assert.match(f.tools.get("bootstrap_cleanup").description, /bootstrap_cancel/i);

	// Dry run prints configured deadlines.
	const dry = await f.call("bootstrap_generate", {
		topology: "chain",
		task: "Deadline check",
		project_cwd: f.cwd,
		dry_run: true,
		task_timeout_ms: 15_000,
		dependency_wait_timeout_ms: 30_000,
		liveness_timeout_ms: 45_000,
		cancel_grace_ms: 3_000,
		agents: [
			{ node_id: "s1", persona: "reviewer", sub_task: "First", task_timeout_ms: 8_000 },
			{ node_id: "s2", persona: "reviewer", sub_task: "Second", dependency_wait_timeout_ms: 20_000 },
		],
	});
	assert.equal(dry.isError, undefined, text(dry));
	assert.match(text(dry), /task_timeout_ms=15000|task timeout 15000ms/);
	assert.match(text(dry), /task timeout 8000ms/);
	assert.match(text(dry), /dependency wait 20000ms/);
});

test("bootstrap_cancel tool cancels nodes, explains downstream blockers and hook limits, and checks grace period", async t => {
	const f = loaded(t);
	const taskId = "chain-cancel-tool-1";
	const project = realpathSync(f.cwd);
	const sessionDir = join(project, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const nodes = ["n1", "n2", "n3"].map((node, i, all) => ({
		node_id: node, persona_name: "reviewer", attempt_id: `a${i + 1}-${node}.1`, instance_id: `a${i + 1}-${node}`,
		expected_coms_name: `a${i + 1}-${node}`, expected_model: "provider/model", label: `${taskId}:a${i + 1}-${node}`, step: i + 1,
		predecessor: i ? `a${i}-${all[i - 1]}` : undefined, successor: all[i + 1] ? `a${i + 2}-${all[i + 1]}` : undefined,
		status: "released", ...(i ? { dependency_policy: "require_success" } : {}),
	}));
	const manifest = {
		version: 2, request_form: "nodes", task_id: taskId, task: "Chain", topology: "chain", project_cwd: project, session_dir: sessionDir,
		workspace_id: "w", coms_project: `boot-${taskId}`, status: "applied", phase: "released", token: "tok",
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", pane_manifest: nodes,
	};
	mkdirSync(join(dirname(f.cwd), "state"), { recursive: true });
	for (const path of [join(dirname(f.cwd), "state", `${taskId}.json`), join(sessionDir, "manifest.json")]) writeFileSync(path, JSON.stringify(manifest));
	writeFileSync(join(sessionDir, "release.json"), JSON.stringify({ task_id: taskId, token: "tok" }));
	// n1 is actively running tool work; n2 and n3 are waiting.
	writeFileSync(join(sessionDir, "a1-n1.progress.json"), JSON.stringify({ token: "tok", updated_at: Date.now(), activity_at: Date.now(), started_at: Date.now() - 1000, state: "working" }));

	const res = await f.call("bootstrap_cancel", { task_id: taskId, agents: ["n1"], reason: "User stopped step 1", grace_ms: 10_000 });
	assert.equal(res.isError, undefined, text(res));
	assert.match(text(res), /Cancelling \(in-flight work\): n1/);
	assert.match(text(res), /Will not run.*n2 \(blocked by n1\), n3 \(blocked by n2\)/);
	assert.match(text(res), /cannot undo tool side effects already in progress/i);

	const earlyForce = await f.call("bootstrap_cancel", { task_id: taskId, agents: ["n1"], force_close: true });
	assert.equal(earlyForce.isError, true);
	assert.match(text(earlyForce), /grace period/i);
});

// ---- ticket 07: recovering interrupted handoff delivery ----

test("bootstrap_recover is offered with inspect and retry_delivery, and says what it will and will not do", async t => {
	const f = loaded(t);
	const recover = f.tools.get("bootstrap_recover");
	assert.ok(recover, "the recovery tool is registered");
	assert.match(recover.description, /inspect.*retry_delivery/s);
	assert.match(recover.description, /re-sends the same handoff.*unclaimed/is);
	assert.match(recover.description, /never replaces.*(original|saved) result/is);
	assert.match(recover.description, /does not (re-run|rerun|replay).*task/is);
	assert.match(recover.description, /needs_attention.*explicit decision.*new (attempt|run)/is);
	assert.match(recover.description, /acknowledg.*not acceptance/is);
	const schema = JSON.stringify(recover.parameters);
	assert.match(schema, /"inspect"[\s\S]*"retry_delivery"/);
	assert.match(schema, /"agent"/);
	assert.match(f.tools.get("bootstrap_status").description, /bootstrap_recover/);
	assert.match(f.tools.get("bootstrap_generate").description, /bootstrap_recover/);
});

test("bootstrap_recover reports an unknown run as an error the model can read", async t => {
	const f = loaded(t);
	const result = await f.call("bootstrap_recover", { task_id: "nope", action: "inspect" });
	assert.equal(result.isError, true);
	assert.match(text(result), /No bootstrap session found for task_id "nope"/);
});

test("bootstrap_recover retry_delivery reports isError=true and status=delivery_failed when coms_send fails", async t => {
	const f = loaded(t);
	const root = dirname(f.cwd);
	const comsDir = join(root, "coms");
	const savedComs = process.env.PI_COMS_DIR;
	process.env.PI_COMS_DIR = comsDir;
	t.after(() => { if (savedComs === undefined) delete process.env.PI_COMS_DIR; else process.env.PI_COMS_DIR = savedComs; });

	const taskId = "chain-recover-fail-1";
	const project = realpathSync(f.cwd);
	const sessionDir = join(project, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const comsProject = `boot-${taskId}`;
	mkdirSync(join(comsDir, "projects", comsProject, "agents"), { recursive: true });
	mkdirSync(join(comsDir, "projects", "dispatch", "agents"), { recursive: true });
	writeFileSync(join(comsDir, "projects", "dispatch", "agents", "dispatcher.json"), JSON.stringify({ pid: process.pid, name: "dispatcher", session_id: "sess-disp", endpoint: "/tmp/disp", cwd: f.cwd, model: "provider/model" }));
	writeFileSync(join(comsDir, "projects", comsProject, "agents", "a2-n2.json"), JSON.stringify({ pid: process.pid, name: "a2-n2", session_id: "sess-n2", endpoint: "/tmp/n2", cwd: f.cwd, model: "provider/model" }));

	const nodes = [
		{ node_id: "n1", persona_name: "reviewer", attempt_id: "a1-n1.1", instance_id: "a1-n1", expected_coms_name: "a1-n1", expected_model: "provider/model", label: `${taskId}:a1-n1`, step: 1, successor: "a2-n2", status: "released" },
		{ node_id: "n2", persona_name: "reviewer", attempt_id: "a2-n2.1", instance_id: "a2-n2", expected_coms_name: "a2-n2", expected_model: "provider/model", label: `${taskId}:a2-n2`, step: 2, predecessor: "a1-n1", status: "released", dependency_policy: "require_success" },
	];
	const manifest = { version: 2, request_form: "nodes", task_id: taskId, task: "Recover", topology: "chain", project_cwd: project, session_dir: sessionDir, workspace_id: "w", coms_project: comsProject, status: "applied", phase: "released", token: "tok", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", pane_manifest: nodes };
	mkdirSync(join(root, "state"), { recursive: true });
	for (const p of [join(root, "state", `${taskId}.json`), join(sessionDir, "manifest.json")]) writeFileSync(p, JSON.stringify(manifest));

	const baseCfg = { version: 2, task_id: taskId, token: "tok", session_dir: sessionDir, project_cwd: project, coms_dir: comsDir, coms_project: comsProject, persona: "p", tools: ["read"], sub_task: "s", topology: "chain", handoff_protocol: 1, startup_message: "go", ready_timeout_ms: 1000 };
	writeFileSync(join(sessionDir, "a1-n1.config.json"), JSON.stringify({ ...baseCfg, instance_id: "a1-n1", node_id: "n1", persona_name: "reviewer", attempt_id: "a1-n1.1", step: 1, successor: "a2-n2" }));
	writeFileSync(join(sessionDir, "a2-n2.config.json"), JSON.stringify({ ...baseCfg, instance_id: "a2-n2", node_id: "n2", persona_name: "reviewer", attempt_id: "a2-n2.1", step: 2, predecessor: "a1-n1", dependency_policy: "require_success" }));
	const { buildTaskInputRecord } = await import("./contracts.ts");
	writeFileSync(join(sessionDir, "a2-n2.input.json"), JSON.stringify(buildTaskInputRecord({
		identity: { run_id: taskId, node_id: "n2", persona_name: "reviewer", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		brief: { task: "Recover", goal: "g" },
		assignment: { sub_task: "s" },
		roster: [],
	})));
	writeFileSync(join(sessionDir, "a2-n2.ready.json"), JSON.stringify({ task_id: taskId, token: "tok", instance_id: "a2-n2", pid: process.pid, session_id: "sess-n2", name: "a2-n2", endpoint: "/tmp/n2", model: "provider/model" }));
	writeFileSync(join(sessionDir, "a1-n1.result.json"), JSON.stringify({
		version: 2,
		identity: { run_id: taskId, node_id: "n1", persona_name: "reviewer", attempt_id: "a1-n1.1", instance_id: "a1-n1" },
		result: { agent_name: "reviewer", node_id: "n1", status: "success", summary: "ok", detail: "ok" },
		delivery: "pending",
		completed_at: "2026-01-01T00:01:00.000Z",
	}));

	const res = await f.tools.get("bootstrap_recover").execute("call-rec", { task_id: taskId, action: "retry_delivery", agent: "n2" }, undefined, undefined, {
		cwd: f.cwd,
		model: { provider: "provider", id: "model" },
		executeTool: async () => ({ isError: true, content: [{ type: "text", text: "coms unreachable" }] }),
	});
	assert.equal(res.isError, true);
	assert.equal(res.details.status, "delivery_failed");
	assert.equal(res.details.delivery?.transport, "failed");
});

test("dry run resolves every combination of suffix, persona and alias thinking levels", async t => {
	const f = loaded(t);
	const persona = join(f.cwd, ".pi", "agents", "reviewer.md");
	for (const [suffix, field, alias, expected] of [
		[undefined, undefined, undefined, undefined],
		[undefined, undefined, "low", "low"],
		[undefined, "medium", undefined, "medium"],
		[undefined, "medium", "low", "medium"],
		["high", undefined, undefined, "high"],
		["high", undefined, "low", "high"],
		["high", "medium", undefined, "high"],
		["off", "medium", "low", "off"],
	]) {
		writeFileSync(persona, `---\nmodel: review${suffix === undefined ? "" : `:${suffix}`}\n${field === undefined ? "" : `thinking: ${field}\n`}---\nReview.`);
		writeFileSync(join(f.agentDir, "bootstrap.json"), JSON.stringify({ modelAliases: { review: { model: "example/model", thinking: alias } } }));
		const result = await reviewPlan(f);
		assert.equal(result.isError, undefined, text(result));
		assert.equal(result.details.plan.agents[0].model, "example/model");
		assert.equal(result.details.plan.agents[0].thinking, expected, JSON.stringify([suffix, field, alias]));
		assert.ok(text(result).includes(`thinking ${expected ?? "(default)"}`), text(result));
	}
});

test("an invalid thinking declaration fails preflight even when another source would win", async t => {
	const f = loaded(t);
	const persona = join(f.cwd, ".pi", "agents", "reviewer.md");
	const config = join(f.agentDir, "bootstrap.json");
	for (const [frontmatter, alias, source, key] of [
		["model: review:extreme\nthinking: low", "medium", persona, '"model"'],
		["model: review:high\nthinking: extreme", "medium", persona, '"thinking"'],
		["thinking:", "medium", persona, '"thinking"'],
		["model: review:high\nthinking: low", "extreme", config, '"modelAliases.review.thinking"'],
	]) {
		writeFileSync(persona, `---\n${frontmatter}\n---\nReview.`);
		writeFileSync(config, JSON.stringify({ modelAliases: { review: { model: "example/model", thinking: alias } } }));
		const result = await reviewPlan(f);
		assert.equal(result.isError, true, frontmatter);
		assert.equal(result.details.phase, "preflight", text(result));
		assert.ok(text(result).includes(source) && text(result).includes(key), text(result));
		assert.match(text(result), /off, minimal, low, medium, high, xhigh, max/);
	}
});

test("/bootgraph renders a durable chain and clears it with the command or a new session", async t => {
	const f = loaded(t);
	const taskId = failedChain(f, dirname(f.cwd));
	const attach = () => f.commands.get("bootgraph").handler(taskId, f.ctx);
	const key = `bootstrap-${taskId}`;
	await attach();
	assert.equal(f.widgets.size, 0, "headless sessions show no graph");
	f.ctx.hasUI = true;
	const unsupported = t.mock.method(f.ctx.ui, "setWidget", () => { throw new Error("Unsupported"); });
	await attach();
	assert.equal(f.widgets.size, 0);
	unsupported.mock.restore();
	await attach();
	await attach();
	assert.equal(f.widgets.size, 1);
	const frame = f.widgets.get(key)!.render(120).join("\n");
	assert.match(frame, /run chain-failed-1 · chain · 3 nodes · failed · 02:00/);
	assert.match(frame, /✗ n1 ─✗▶ ⊘ n2 ─✗▶ ⊘ n3\n0 pending · 1 error/);
	await f.commands.get("bootgraph").handler("clear", f.ctx);
	assert.equal(f.widgets.size, 0);
	await attach();
	assert.equal(f.widgets.size, 1);
	await f.hooks.get("session_start")!({}, f.ctx);
	assert.equal(f.widgets.size, 0);
	process.argv.push("--bootstrap-worker-config", "/worker-config");
	t.after(() => { process.argv.splice(-2); });
	await attach();
	assert.equal(f.widgets.size, 0, "agent sessions show no graph");
});

test("a released team widget follows status and keeps its final frame", async t => {
	for (const [key, value] of Object.entries({ HERDR_ENV: "1", HERDR_PANE_ID: "dispatcher" })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	let config: WorkerConfig | undefined;
	let label: string;
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
		if (args[0] === "tab" && args[1] === "create") {
			label = args[args.indexOf("--label") + 1];
			const tab = { tab_id: "t", pane_id: "p", terminal_id: "term", label, cwd: f.cwd };
			return ok({ tab, root_pane: tab });
		}
		assert.deepEqual(args.slice(0, 2), ["pane", "run"]);
		assert.equal(f.widgets.size, 0, "the run is still launching");
		const [taskId, instance] = label.split(":");
		const dir = join(f.cwd, ".pi", "agent-sessions", taskId);
		config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
		const ready = { task_id: taskId, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
		const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
		mkdirSync(registry, { recursive: true });
		atomicJson(join(registry, `${instance}.json`), ready);
		atomicJson(readyPath(dir, instance), ready);
		return ok({});
	});
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;
	const dryRun = await reviewPlan(f);
	assert.match(text(dryRun), /plan · team · 1 node\n◌ reviewer/);
	assert.equal(f.widgets.size, 0);

	const run = await reviewPlan(f, false);
	assert.equal(run.isError, undefined, text(run));
	const taskId = run.details.task_id;
	const frame = () => f.widgets.get(`bootstrap-${taskId}`)!.render(120).join("\n");
	assert.match(frame(), /1 node · incomplete · 00:00\n◌ reviewer\n1 pending · 0 errors/);

	const worker = config!;
	atomicJson(join(worker.session_dir, `${worker.instance_id}.progress.json`), {
		token: worker.token, state: "working", started_at: Date.now(), updated_at: Date.now(),
	});
	t.mock.timers.tick(2000);
	const active = await f.call("bootstrap_status", { task_id: taskId });
	assert.match(text(active), /\[execution running\]/);
	assert.match(frame(), /● reviewer 00:02/);

	atomicJson(resultPath(worker.session_dir, worker.instance_id), completionRecord(worker,
		{ agent_name: "reviewer", status: "success", summary: "Reviewed", detail: "" }, "none", new Date().toISOString()));
	t.mock.timers.tick(2000);
	const finalFrame = frame();
	assert.match(finalFrame, /1 node · succeeded · 00:02\n✓ reviewer\n0 pending · 0 errors/);
	const redraws = f.redraws;
	t.mock.timers.tick(6000);
	assert.equal(f.redraws, redraws, "the terminal frame needs no redraws");
	assert.equal(frame(), finalFrame);

	await f.commands.get("bootgraph").handler(taskId, f.ctx);
	assert.equal(frame(), finalFrame, "reattaching uses the time recorded by the run");

	const status = await f.call("bootstrap_status", { task_id: taskId });
	assert.match(text(status), /Run outcome: succeeded/);
	const report = await f.call("bootstrap_report", { task_id: taskId });
	assert.match(text(report), /Run outcome: succeeded/);
});

function graphRun(f: ReturnType<typeof loaded>, taskId: string) {
	const session_dir = join(realpathSync(f.cwd), ".pi", "agent-sessions", taskId);
	mkdirSync(session_dir, { recursive: true, mode: 0o700 });
	const store = new SessionStore(join(dirname(f.cwd), "state"));
	const instance_id = "a1-reviewer";
	const manifest: BootstrapManifest = {
		version: 2, task_id: taskId, task: "Review", topology: "team", project_cwd: realpathSync(f.cwd), session_dir,
		workspace_id: "w", coms_project: taskId, token: "test-token", status: "applied", phase: "released",
		created_at: new Date(Date.now() - 10_000).toISOString(), updated_at: "",
		pane_manifest: [{ instance_id, node_id: "reviewer", persona_name: "reviewer", attempt_id: `${instance_id}.1`,
			expected_coms_name: instance_id, expected_model: "provider/model", label: `${taskId}:${instance_id}`, status: "released" }],
	};
	store.save(manifest);
	atomicJson(join(session_dir, `${instance_id}.progress.json`), {
		token: manifest.token, state: "working", started_at: Date.now(), updated_at: Date.now(),
	});
	return { store, manifest, index: store.indexPath(taskId), sessionDir: session_dir };
}

function snapshotRecords(dir: string) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => join(entry.parentPath, entry.name))
		.sort()
		.map(path => [path, readFileSync(path).toString("base64")]);
}

test("two widgets poll read-only, replacement keeps one poller, and shutdown clears both", async t => {
	const f = loaded(t);
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;
	const first = graphRun(f, "review-first");
	const second = graphRun(f, "review-second");
	const snapshot = () => [snapshotRecords(first.store.indexRoot), snapshotRecords(first.sessionDir), snapshotRecords(second.sessionDir)];
	const before = snapshot();
	const attach = (id: string) => f.commands.get("bootgraph").handler(id, f.ctx);
	await attach("review-first");
	await attach("review-second");
	t.mock.timers.tick(2000);
	assert.equal(f.redraws, 2);
	assert.match(f.widgets.get("bootstrap-review-first")!.render(120).join("\n"), /● reviewer 00:02/);
	assert.match(f.widgets.get("bootstrap-review-second")!.render(120).join("\n"), /● reviewer 00:02/);

	await attach("review-first");
	assert.equal(f.widgets.size, 2);
	assert.match(f.widgets.get("bootstrap-review-first")!.render(120).join("\n"), /incomplete · 00:10/);
	t.mock.timers.tick(2000);
	assert.equal(f.redraws, 4, "replacement leaves one poller for each run");
	assert.deepEqual(snapshot(), before);
	await f.hooks.get("session_shutdown")!({ reason: "reload" }, f.ctx);
	assert.equal(f.widgets.size, 0);
	t.mock.timers.tick(6000);
	assert.equal(f.redraws, 4);
	assert.deepEqual(snapshot(), before);
});

test("starting a new run removes finished/cancelled/cleaned widgets while keeping active and needs_attention runs", async t => {
	for (const [key, value] of Object.entries({ HERDR_ENV: "1", HERDR_PANE_ID: "dispatcher" })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const configs = new Map<string, WorkerConfig>();
	const tabs = new Map<string, string>();
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
		if (args[0] === "tab" && args[1] === "create") {
			const id = `t-${tabs.size + 1}`;
			const label = args[args.indexOf("--label") + 1];
			tabs.set(id, label);
			const tab = { tab_id: id, pane_id: id, terminal_id: id, label, cwd: f.cwd };
			return ok({ tab, root_pane: tab });
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] });
		if (args[0] === "tab" && args[1] === "close") return ok({});
		assert.deepEqual(args.slice(0, 2), ["pane", "run"]);
		const [taskId, instance] = tabs.get(args[2])!.split(":");
		const dir = join(f.cwd, ".pi", "agent-sessions", taskId);
		const config = readJson<WorkerConfig>(join(dir, `${instance}.config.json`));
		configs.set(taskId, config);
		const ready = { task_id: taskId, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: instance, endpoint: "/unused", model: "provider/model" };
		const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
		mkdirSync(registry, { recursive: true });
		atomicJson(join(registry, `${instance}.json`), ready);
		atomicJson(readyPath(dir, instance), ready);
		return ok({});
	});
	f.ctx.hasUI = true;

	// Start run A and finish it.
	const runA = await f.call("bootstrap_generate", {
		topology: "team", task: "Review A", project_cwd: f.cwd, request_id: "req-graph-a",
		agents: [{ persona: "reviewer", sub_task: "Review A" }],
	});
	assert.equal(runA.isError, undefined, text(runA));
	const taskIdA = runA.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdA}`), true);
	const workerA = configs.get(taskIdA)!;
	atomicJson(resultPath(workerA.session_dir, workerA.instance_id), completionRecord(workerA,
		{ agent_name: "reviewer", status: "success", summary: "Run A done", detail: "" }, "none", new Date().toISOString()));

	// Start run B in the same session: finished run A's widget must be removed automatically.
	const runB = await f.call("bootstrap_generate", {
		topology: "team", task: "Review B", project_cwd: f.cwd, request_id: "req-graph-b",
		agents: [{ persona: "reviewer", sub_task: "Review B" }],
	});
	assert.equal(runB.isError, undefined, text(runB));
	const taskIdB = runB.details.task_id as string;
	assert.notEqual(taskIdB, taskIdA);
	assert.equal(f.widgets.has(`bootstrap-${taskIdA}`), false, "finished run A widget should be removed when run B starts");
	assert.equal(f.widgets.has(`bootstrap-${taskIdB}`), true, "new run B widget should be shown");

	// Start run C while run B is still active: both active runs stay shown without mixing nodes.
	const runC = await f.call("bootstrap_generate", {
		topology: "team", task: "Concurrent C", project_cwd: f.cwd, request_id: "req-graph-c",
		agents: [{ node_id: "second", persona: "reviewer", sub_task: "Check C" }],
	});
	assert.equal(runC.isError, undefined, text(runC));
	const taskIdC = runC.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdB}`), true, "active run B must remain shown");
	assert.equal(f.widgets.has(`bootstrap-${taskIdC}`), true, "active run C must be shown");
	assert.doesNotMatch(f.widgets.get(`bootstrap-${taskIdB}`)!.render(120).join("\n"), /\bsecond\b/);
	assert.doesNotMatch(f.widgets.get(`bootstrap-${taskIdC}`)!.render(120).join("\n"), /\breviewer\b/);

	// Mark run B as needs_attention, cancel run C, then start run D:
	// needs_attention run B is kept, cancelled run C is removed, run D is shown.
	const workerB = configs.get(taskIdB)!;
	atomicJson(dispositionPath(workerB.session_dir, workerB.instance_id), dispositionRecord(workerB, "needs_attention", "Needs human review", [], new Date().toISOString()));
	await f.call("bootstrap_cancel", { task_id: taskIdC, reason: "No longer needed" });
	const workerC = configs.get(taskIdC)!;
	atomicJson(dispositionPath(workerC.session_dir, workerC.instance_id), dispositionRecord(workerC, "cancelled", "Cancelled", [], new Date().toISOString()));

	const runD = await f.call("bootstrap_generate", {
		topology: "team", task: "Review D", project_cwd: f.cwd, request_id: "req-graph-d",
		agents: [{ persona: "reviewer", sub_task: "Review D" }],
	});
	assert.equal(runD.isError, undefined, text(runD));
	const taskIdD = runD.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdB}`), true, "needs_attention run B must never be removed");
	assert.equal(f.widgets.has(`bootstrap-${taskIdC}`), false, "cancelled run C must be removed when run D starts");
	assert.equal(f.widgets.has(`bootstrap-${taskIdD}`), true, "new run D must be shown");

	// Clean up run D, then start run E: cleaned-up run D must be removed, needs_attention run B still kept.
	const workerD = configs.get(taskIdD)!;
	atomicJson(resultPath(workerD.session_dir, workerD.instance_id), completionRecord(workerD,
		{ agent_name: "reviewer", status: "success", summary: "Run D done", detail: "" }, "none", new Date().toISOString()));
	const cleanedD = await f.call("bootstrap_cleanup", { task_id: taskIdD });
	assert.equal(cleanedD.details.status, "cleaned");
	const runE = await f.call("bootstrap_generate", {
		topology: "team", task: "Review E", project_cwd: f.cwd, request_id: "req-graph-e",
		agents: [{ persona: "reviewer", sub_task: "Review E" }],
	});
	assert.equal(runE.isError, undefined, text(runE));
	const taskIdE = runE.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdD}`), false, "cleaned run D must be removed when run E starts");
	assert.equal(f.widgets.has(`bootstrap-${taskIdB}`), true, "needs_attention run B still kept");
	assert.equal(f.widgets.has(`bootstrap-${taskIdE}`), true, "new run E must be shown");

	// Active run whose status read fails (corrupt manifest/index) must KEEP its widget when a new run starts (W7 / Blocking 2).
	const workerE = configs.get(taskIdE)!;
	const indexE = join(dirname(f.cwd), "state", `${taskIdE}.json`);
	const localManifestE = join(workerE.session_dir, "manifest.json");
	const savedIndexE = readFileSync(indexE, "utf8");
	const savedLocalE = readFileSync(localManifestE, "utf8");
	writeFileSync(indexE, "{corrupt");
	writeFileSync(localManifestE, "{corrupt");
	const runF = await f.call("bootstrap_generate", {
		topology: "team", task: "Review F", project_cwd: f.cwd, request_id: "req-graph-f",
		agents: [{ persona: "reviewer", sub_task: "Review F" }],
	});
	assert.equal(runF.isError, undefined, text(runF));
	const taskIdF = runF.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdE}`), true, "active run E whose status read failed must keep its widget");
	assert.equal(f.widgets.has(`bootstrap-${taskIdF}`), true, "new run F must be shown");
	writeFileSync(indexE, savedIndexE);
	writeFileSync(localManifestE, savedLocalE);
	atomicJson(resultPath(workerE.session_dir, workerE.instance_id), completionRecord(workerE,
		{ agent_name: "reviewer", status: "success", summary: "Run E done", detail: "" }, "none", new Date().toISOString()));
	const workerF = configs.get(taskIdF)!;
	atomicJson(resultPath(workerF.session_dir, workerF.instance_id), completionRecord(workerF,
		{ agent_name: "reviewer", status: "success", summary: "Run F done", detail: "" }, "none", new Date().toISOString()));

	// Standalone on_success run that becomes cleanup-ready just before a new run starts:
	// pruning must be pure read-only (never mutating run records) and must never lose the cleanup announcement (Blocking 1).
	const runAuto = await f.call("bootstrap_generate", {
		topology: "graph", task: "Auto cleanup run", project_cwd: f.cwd, request_id: "req-graph-auto",
		cleanup: "on_success", cleanup_settle_ms: 0,
		agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review auto" }],
	});
	assert.equal(runAuto.isError, undefined, text(runAuto));
	const taskIdAuto = runAuto.details.task_id as string;
	const workerAuto = configs.get(taskIdAuto)!;
	assert.equal(f.widgets.has(`bootstrap-${taskIdAuto}`), true);
	// Complete workerAuto and mark its PID exited so automatic cleanup is immediately ready before the 2s poller ticks.
	atomicJson(resultPath(workerAuto.session_dir, workerAuto.instance_id), completionRecord(workerAuto,
		{ agent_name: "reviewer", node_id: "review", status: "success", summary: "Auto done", detail: "" }, "not_required", new Date().toISOString()));
	const readyAuto = readJson<Record<string, unknown>>(readyPath(workerAuto.session_dir, workerAuto.instance_id));
	atomicJson(readyPath(workerAuto.session_dir, workerAuto.instance_id), { ...readyAuto, pid: 999999 });
	const autoSessionSnapBeforePrune = readdirSync(workerAuto.session_dir).sort().map(name => [name, readFileSync(join(workerAuto.session_dir, name), "utf8")]);
	const autoIndexSnapBeforePrune = readFileSync(join(dirname(f.cwd), "state", `${taskIdAuto}.json`), "utf8");

	// Also start an on_success graph run whose result has delivery: "failed" (W4: delivery_errors keep widget).
	const runDelivErr = await f.call("bootstrap_generate", {
		topology: "graph", task: "Delivery error run", project_cwd: f.cwd, request_id: "req-graph-deliv-err",
		cleanup: "on_success", cleanup_settle_ms: 0,
		agents: [{ node_id: "review", persona: "reviewer", sub_task: "Review deliv err" }],
	});
	assert.equal(runDelivErr.isError, undefined, text(runDelivErr));
	const taskIdDelivErr = runDelivErr.details.task_id as string;
	const workerDelivErr = configs.get(taskIdDelivErr)!;
	// Verify pruning of runAuto during runDelivErr launch did NOT mutate runAuto's session dir or index!
	assert.equal(f.widgets.has(`bootstrap-${taskIdAuto}`), false, "finished on_success runAuto widget must be pruned when runDelivErr starts");
	assert.deepEqual(
		readdirSync(workerAuto.session_dir).sort().map(name => [name, readFileSync(join(workerAuto.session_dir, name), "utf8")]),
		autoSessionSnapBeforePrune,
		"pruning must be pure read-only and never mutate runAuto session records",
	);
	assert.equal(
		readFileSync(join(dirname(f.cwd), "state", `${taskIdAuto}.json`), "utf8"),
		autoIndexSnapBeforePrune,
		"pruning must not save or auto-clean runAuto index record",
	);
	// Wait for runAuto's background poller to run automatic cleanup and announce via followUp.
	const waitCleanupAnnouncement = async () => {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (f.followUps.some(msg => msg.includes(`Run ${taskIdAuto}.`) && msg.includes("cleaned up automatically"))) return true;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return false;
	};
	assert.equal(await waitCleanupAnnouncement(), true, "pruned on_success runAuto must still announce automatic cleanup when its poller ticks");

	// Complete runDelivErr with delivery: "failed" so outcome is succeeded + terminal, but delivery_errors is non-empty (W4).
	atomicJson(resultPath(workerDelivErr.session_dir, workerDelivErr.instance_id), {
		...completionRecord(workerDelivErr, { agent_name: "reviewer", node_id: "review", status: "success", summary: "Done with delivery err", detail: "" }, "failed", new Date().toISOString()),
		delivery_error: "coms send failed",
	});

	// Error-status runs (W6): phase === "uncertain" must be kept, whereas terminal-known phase ("cancelled") must be removed.
	const indexA = join(dirname(f.cwd), "state", `${taskIdA}.json`);
	const localA = join(workerA.session_dir, "manifest.json");
	const manifestAData = JSON.parse(readFileSync(localA, "utf8"));
	writeFileSync(indexA, JSON.stringify({ ...manifestAData, status: "error", phase: "uncertain", error: "Release state uncertain" }));
	writeFileSync(localA, JSON.stringify({ ...manifestAData, status: "error", phase: "uncertain", error: "Release state uncertain" }));
	await f.commands.get("bootgraph").handler(taskIdA, f.ctx);
	assert.equal(f.widgets.has(`bootstrap-${taskIdA}`), true);

	const indexF = join(dirname(f.cwd), "state", `${taskIdF}.json`);
	const localF = join(workerF.session_dir, "manifest.json");
	const manifestFData = JSON.parse(readFileSync(localF, "utf8"));
	writeFileSync(indexF, JSON.stringify({ ...manifestFData, status: "error", phase: "cancelled", error: "Cancelled pre-release" }));
	writeFileSync(localF, JSON.stringify({ ...manifestFData, status: "error", phase: "cancelled", error: "Cancelled pre-release" }));
	await f.commands.get("bootgraph").handler(taskIdF, f.ctx);
	assert.equal(f.widgets.has(`bootstrap-${taskIdF}`), true);

	const runG = await f.call("bootstrap_generate", {
		topology: "team", task: "Review G", project_cwd: f.cwd, request_id: "req-graph-g",
		agents: [{ persona: "reviewer", sub_task: "Review G" }],
	});
	assert.equal(runG.isError, undefined, text(runG));
	const taskIdG = runG.details.task_id as string;
	assert.equal(f.widgets.has(`bootstrap-${taskIdDelivErr}`), true, "on_success run with delivery_errors must be kept (W4)");
	assert.equal(f.widgets.has(`bootstrap-${taskIdA}`), true, "error run with phase uncertain must be kept (W6)");
	assert.equal(f.widgets.has(`bootstrap-${taskIdF}`), false, "error run with terminal-known phase cancelled must be removed (W6)");
	assert.equal(f.widgets.has(`bootstrap-${taskIdG}`), true);

	// Restore run A to normal finished state so /bootgraph <task_id> below tests a finished run.
	writeFileSync(indexA, JSON.stringify(manifestAData));
	writeFileSync(localA, JSON.stringify(manifestAData));

	// Cancelling and parked-unfinalized agents keep their widgets even if outcome.terminal is true (W3).
	{
		const { createGraphWidgets } = await import("./graph-widget.ts");
		const baseStatus = (await f.call("bootstrap_status", { task_id: taskIdF })).details;
		const statusByTask = new Map<string, any>();
		const makeUnitStatus = (id: string, agentOverrides: Record<string, unknown>) => ({
			manifest: {
				...manifestAData,
				task_id: id,
				status: "applied",
				phase: "released",
				cleanup_policy: { version: 1, mode: "manual", settle_ms: 3000 },
			},
			results: [],
			pending: [],
			delivery_errors: [],
			worker_errors: [],
			outcome: { state: "cancelled", terminal: true, counts: { ...(baseStatus.outcome?.counts ?? {}), cancelled: 1 } },
			agents: [{
				node_id: "reviewer",
				instance_id: "a1-reviewer",
				persona_name: "reviewer",
				attempt_id: "a1-reviewer.1",
				state: "working",
				execution: "cancelled",
				execution_causes: [],
				cancelling: false,
				parked: false,
				finalized: false,
				...agentOverrides,
			}],
		});
		statusByTask.set("w1-terminal-attention", {
			...makeUnitStatus("w1-terminal-attention", { execution: "needs_attention" }),
			outcome: { state: "needs_attention", terminal: true, counts: { ...(baseStatus.outcome?.counts ?? {}), needs_attention: 1 } },
		});
		statusByTask.set("w3-cancelling", makeUnitStatus("w3-cancelling", { cancelling: true }));
		statusByTask.set("w3-parked", makeUnitStatus("w3-parked", { parked: true, finalized: false }));
		statusByTask.set("w3-done", makeUnitStatus("w3-done", { cancelling: false, parked: false, finalized: true }));
		statusByTask.set("w5-cleaned-nonterminal", {
			...makeUnitStatus("w5-cleaned-nonterminal", { execution: "running" }),
			manifest: { ...makeUnitStatus("w5-cleaned-nonterminal", {}).manifest, status: "cleaned", phase: "cleaned" },
			outcome: { state: "incomplete", terminal: false, counts: { ...(baseStatus.outcome?.counts ?? {}), running: 1 } },
		});
		statusByTask.set("w3-new", makeUnitStatus("w3-new", { execution: "running" }));
		const unitWidgets = new Map<string, { render(w: number): string[] }>();
		const unitCtx: any = {
			cwd: f.cwd,
			hasUI: true,
			ui: {
				setWidget(k: string, fn?: Function) {
					if (fn) unitWidgets.set(k, fn({ requestRender() {} }, { fg: (_c: string, s: string) => s }));
					else unitWidgets.delete(k);
				},
			},
		};
		const gw = createGraphWidgets((id: string) => statusByTask.get(id));
		await gw.attach("w1-terminal-attention", unitCtx, statusByTask.get("w1-terminal-attention"));
		await gw.attach("w3-cancelling", unitCtx, statusByTask.get("w3-cancelling"));
		await gw.attach("w3-parked", unitCtx, statusByTask.get("w3-parked"));
		await gw.attach("w3-done", unitCtx, statusByTask.get("w3-done"));
		await gw.attach("w5-cleaned-nonterminal", unitCtx, statusByTask.get("w5-cleaned-nonterminal"));
		await gw.attach("w3-new", unitCtx, statusByTask.get("w3-new"), { pruneFinished: true });
		assert.equal(unitWidgets.has("bootstrap-w1-terminal-attention"), true, "terminal needs_attention widget must be kept (W1)");
		assert.equal(unitWidgets.has("bootstrap-w3-cancelling"), true, "cancelling agent widget must be kept (W3)");
		assert.equal(unitWidgets.has("bootstrap-w3-parked"), true, "parked unfinalized agent widget must be kept (W3)");
		assert.equal(unitWidgets.has("bootstrap-w3-done"), false, "finalized terminal agent widget must be removed");
		assert.equal(unitWidgets.has("bootstrap-w5-cleaned-nonterminal"), false, "cleaned run widget must be removed even if outcome was non-terminal (W5)");
		assert.equal(unitWidgets.has("bootstrap-w3-new"), true);

		// W9: re-attaching an existing key with pruneFinished: true must exclude that key from pruning so its previous frame.graph is preserved when session_dir_removed becomes true.
		await gw.attach("w9-self", unitCtx, makeUnitStatus("w9-self", { execution: "succeeded" }));
		const w9RemovedDirStatus = {
			...makeUnitStatus("w9-self", { execution: "succeeded" }),
			manifest: { ...makeUnitStatus("w9-self", {}).manifest, status: "cleaned", session_dir_removed: true },
		};
		statusByTask.set("w9-self", w9RemovedDirStatus);
		await gw.attach("w9-self", unitCtx, w9RemovedDirStatus, { pruneFinished: true });
		assert.ok(unitWidgets.get("bootstrap-w9-self")!.render(120).length > 1, "re-attaching same key with pruneFinished must not prune itself before attach preserves frame.graph (W9)");
		gw.reset();
	}

	// /bootgraph <task_id> on a finished run still shows it on demand, and /bootgraph clear clears all.
	await f.commands.get("bootgraph").handler(taskIdA, f.ctx);
	assert.equal(f.widgets.has(`bootstrap-${taskIdA}`), true, "/bootgraph <task_id> attaches finished run on demand");
	await f.commands.get("bootgraph").handler("clear", f.ctx);
	assert.equal(f.widgets.size, 0, "/bootgraph clear removes all widgets");
});

test("/bootgraph reports unknown IDs and marks a frame stale after consecutive read failures", async t => {
	const f = loaded(t);
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;
	const attach = (id: string) => f.commands.get("bootgraph").handler(id, f.ctx);
	await attach("unknown-run");
	assert.equal(f.widgets.size, 0);
	assert.match(f.notifications.at(-1)![0], /No bootstrap session found.*unknown-run/);
	assert.equal(f.notifications.at(-1)![1], "error");

	const run = graphRun(f, "flaky-status");
	await attach("flaky-status");
	const frame = () => f.widgets.get("bootstrap-flaky-status")!.render(120).join("\n");
	const goodManifest = readFileSync(run.index);
	const failRead = () => writeFileSync(run.index, "{");
	failRead();
	for (let poll = 0; poll < 2; poll++) t.mock.timers.tick(2000);
	assert.doesNotMatch(frame(), /stale/i);
	writeFileSync(run.index, goodManifest);
	t.mock.timers.tick(2000);
	assert.match(frame(), /● reviewer 00:06/);

	failRead();
	for (let poll = 0; poll < 2; poll++) t.mock.timers.tick(2000);
	assert.doesNotMatch(frame(), /stale/i, "a successful read resets the failure count");
	t.mock.timers.tick(2000);
	assert.match(frame(), /stale/i);
	assert.match(frame(), /● reviewer 00:06/);
	const redraws = f.redraws;
	writeFileSync(run.index, goodManifest);
	t.mock.timers.tick(4000);
	assert.match(frame(), /stale/i);
	assert.equal(f.redraws, redraws);
	await attach("flaky-status");
	assert.doesNotMatch(frame(), /stale/i);
	await f.hooks.get("session_shutdown")!({ reason: "reload" }, f.ctx);
});

test("widgets stop on cleanup or missing files and keep the last known node state", async t => {
	const f = loaded(t);
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;
	const cleaned = graphRun(f, "cleaned-run");
	const deleted = graphRun(f, "deleted-run");
	const removed = graphRun(f, "removed-run");
	for (const id of ["cleaned-run", "deleted-run", "removed-run"]) await f.commands.get("bootgraph").handler(id, f.ctx);
	t.mock.timers.tick(2000);
	cleaned.store.save({ ...cleaned.manifest, status: "cleaned" });
	deleted.store.save({ ...deleted.manifest, status: "cleaned", session_dir_removed: true, session_files_deleted: true });
	for (const run of [deleted, removed]) rmSync(run.sessionDir, { recursive: true });
	t.mock.timers.tick(2000);

	const frame = (id: string) => f.widgets.get(`bootstrap-${id}`)!.render(120).join("\n");
	assert.match(frame("cleaned-run"), /cleaned · 00:12/);
	assert.match(frame("deleted-run"), /cleaned.*files unavailable/);
	assert.match(frame("removed-run"), /files unavailable/);
	for (const id of ["deleted-run", "removed-run"]) assert.match(frame(id), /● reviewer 00:02/);
	const redraws = f.redraws;
	t.mock.timers.tick(8000);
	assert.equal(f.redraws, redraws);
	await f.commands.get("bootgraph").handler("deleted-run", f.ctx);
	assert.match(frame("deleted-run"), /files unavailable/);
	assert.doesNotMatch(frame("deleted-run"), /◌ reviewer/);
});

test("dry-run and /bootgraph widget agree on diamond, parallel-chain join, and skip-level shapes and show live edge states", async t => {
	for (const [key, value] of Object.entries({ HERDR_ENV: "1", HERDR_PANE_ID: "dispatcher" })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const configs = new Map<string, WorkerConfig>();
	const panes = new Map<string, string>();
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
		if (args[0] === "tab" && args[1] === "create") {
			const label = args[args.indexOf("--label") + 1];
			const paneId = `p-${label}`;
			panes.set(paneId, label);
			const tab = { tab_id: `t-${label}`, pane_id: paneId, terminal_id: "term", label, cwd: f.cwd };
			return ok({ tab, root_pane: tab });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const paneId = args[2];
			const label = panes.get(paneId)!;
			const [taskId, instance] = label.split(":");
			const sessionDir = join(f.cwd, ".pi", "agent-sessions", taskId);
			const cfg = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.set(`${taskId}:${cfg.node_id}`, cfg);
			const ready = { task_id: taskId, token: cfg.token, instance_id: cfg.instance_id, name: cfg.instance_id, pid: process.pid, session_id: cfg.instance_id, endpoint: "/unused", model: "provider/model" };
			const registry = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${cfg.instance_id}.json`), ready);
			atomicJson(readyPath(sessionDir, cfg.instance_id), ready);
			return ok({});
		}
		return ok({});
	});
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;

	const shapes = [
		{
			name: "diamond",
			agents: [
				{ node_id: "root", persona: "reviewer", sub_task: "Root" },
				{ node_id: "left", persona: "reviewer", sub_task: "Left", depends_on: ["root"] },
				{ node_id: "right", persona: "reviewer", sub_task: "Right", depends_on: ["root"] },
				{ node_id: "merge", persona: "reviewer", sub_task: "Merge", depends_on: ["left", "right"] },
			],
		},
		{
			name: "parallel-chains-join",
			agents: [
				{ node_id: "a", persona: "reviewer", sub_task: "A" },
				{ node_id: "b", persona: "reviewer", sub_task: "B" },
				{ node_id: "c", persona: "reviewer", sub_task: "C", depends_on: ["a"] },
				{ node_id: "d", persona: "reviewer", sub_task: "D", depends_on: ["b"] },
				{ node_id: "e", persona: "reviewer", sub_task: "E", depends_on: ["c", "d"] },
			],
		},
		{
			name: "skip-level",
			agents: [
				{ node_id: "a", persona: "reviewer", sub_task: "A" },
				{ node_id: "b", persona: "reviewer", sub_task: "B", depends_on: ["a"] },
				{ node_id: "c", persona: "reviewer", sub_task: "C", depends_on: ["b", "a"] },
			],
		},
	];

	const stripColors = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const bodyLines = (rendered: string, isLive: boolean) => {
		const lines = rendered.split("\n");
		return isLive ? lines.slice(1, -1) : lines.slice(1);
	};

	const taskIds: Record<string, string> = {};
	for (const shape of shapes) {
		const dry = await f.call("bootstrap_generate", {
			topology: "graph",
			task: shape.name,
			project_cwd: f.cwd,
			dry_run: true,
			agents: shape.agents,
		});
		assert.equal(dry.isError, undefined, text(dry));
		const dryLines = text(dry).split("\n");
		const dryHeaderIdx = dryLines.findIndex(l => l.startsWith("plan · graph"));
		const dryEndIdx = dryLines.findIndex((l, idx) => idx > dryHeaderIdx && l.startsWith("- "));
		const dryBody = dryLines.slice(dryHeaderIdx + 1, dryEndIdx === -1 ? undefined : dryEndIdx);

		const live = await f.call("bootstrap_generate", {
			topology: "graph",
			task: shape.name,
			request_id: `req-${shape.name}`,
			project_cwd: f.cwd,
			dry_run: false,
			agents: shape.agents,
		});
		assert.equal(live.isError, undefined, text(live));
		const taskId = live.details.task_id as string;
		taskIds[shape.name] = taskId;
		const widgetFrame = stripColors(f.widgets.get(`bootstrap-${taskId}`)!.render(100).join("\n"));
		const liveBody = bodyLines(widgetFrame, true);
		assert.deepEqual(
			liveBody.map(l => l.replace(/╌/g, "─")),
			dryBody,
			`${shape.name}: dry-run and initial widget body shapes must agree`,
		);
	}

	// Drive the diamond to a waiting join (left succeeded, right running) and verify edge states in widget.
	const diaId = taskIds["diamond"];
	const rootCfg = configs.get(`${diaId}:root`)!;
	const leftCfg = configs.get(`${diaId}:left`)!;
	atomicJson(resultPath(rootCfg.session_dir, rootCfg.instance_id), completionRecord(rootCfg,
		{ agent_name: "root", status: "success", summary: "Root done", detail: "" }, "none", new Date().toISOString()));
	atomicJson(resultPath(leftCfg.session_dir, leftCfg.instance_id), completionRecord(leftCfg,
		{ agent_name: "left", status: "success", summary: "Left done", detail: "" }, "none", new Date().toISOString()));
	t.mock.timers.tick(2000);
	const diaWaiting = f.widgets.get(`bootstrap-${diaId}`)!.render(100).join("\n");
	assert.match(diaWaiting, /✓ root ──┬──▶ ✓ left  ──┬╌╌▶ ◌ merge/);
	assert.match(diaWaiting, /└──▶ ◌ right ╌╌┘/);

	// Drive parallel-chains-join (a->c, b->d, c,d->e) to a live state: a & c succeeded, b failed.
	const pcjId = taskIds["parallel-chains-join"];
	const pcjA = configs.get(`${pcjId}:a`)!;
	const pcjC = configs.get(`${pcjId}:c`)!;
	const pcjB = configs.get(`${pcjId}:b`)!;
	atomicJson(resultPath(pcjA.session_dir, pcjA.instance_id), completionRecord(pcjA,
		{ agent_name: "a", status: "success", summary: "A done", detail: "" }, "none", new Date().toISOString()));
	atomicJson(resultPath(pcjC.session_dir, pcjC.instance_id), completionRecord(pcjC,
		{ agent_name: "c", status: "success", summary: "C done", detail: "" }, "none", new Date().toISOString()));
	atomicJson(resultPath(pcjB.session_dir, pcjB.instance_id), completionRecord(pcjB,
		{ agent_name: "b", status: "failure", summary: "B failed", detail: "" }, "none", new Date().toISOString()));
	t.mock.timers.tick(2000);
	const pcjLive = f.widgets.get(`bootstrap-${pcjId}`)!.render(100).join("\n");
	assert.match(pcjLive, /✓ a ──▶ ✓ c ──┬╌╌▶ ◌ e/);
	assert.match(pcjLive, /✗ b ─✗▶ ◌ d ╌╌┘/);

	// Drive skip-level (a->b, a->c, b->c) to a live state: a succeeded, b failed.
	const skipId = taskIds["skip-level"];
	const skipA = configs.get(`${skipId}:a`)!;
	const skipB = configs.get(`${skipId}:b`)!;
	atomicJson(resultPath(skipA.session_dir, skipA.instance_id), completionRecord(skipA,
		{ agent_name: "a", status: "success", summary: "A done", detail: "" }, "none", new Date().toISOString()));
	atomicJson(resultPath(skipB.session_dir, skipB.instance_id), completionRecord(skipB,
		{ agent_name: "b", status: "failure", summary: "B failed", detail: "" }, "none", new Date().toISOString()));
	t.mock.timers.tick(2000);
	const skipLive = f.widgets.get(`bootstrap-${skipId}`)!.render(100).join("\n");
	assert.match(skipLive, /✓ a ──┬──▶ ✗ b ─✗┬─✗▶ ◌ c/);
	assert.match(skipLive, /└──────────┘/);

	// Verify status() also populates edge_states for chain runs (single source of truth), while chain status text omits [edges: ...].
	const chainId = failedChain(f, dirname(f.cwd));
	const chainStatus = await f.call("bootstrap_status", { task_id: chainId });
	assert.doesNotMatch(text(chainStatus), /\[edges:/);
	const chainAgents = chainStatus.details.agents as Array<{ node_id: string; edge_states?: Record<string, string> }>;
	assert.equal(chainAgents.find(a => a.node_id === "n1")?.edge_states, undefined);
	assert.deepEqual(chainAgents.find(a => a.node_id === "n2")?.edge_states, { n1: "dead" });
	assert.deepEqual(chainAgents.find(a => a.node_id === "n3")?.edge_states, { n2: "dead" });

	// A chain edge whose source succeeded and destination was cancelled before claiming stays 'fired' (source-only).
	const cancelChain = await f.call("bootstrap_generate", {
		topology: "chain",
		task: "Cancel second node after first succeeds",
		request_id: "req-cancel-chain-edge",
		project_cwd: f.cwd,
		dry_run: false,
		agents: [
			{ node_id: "first", persona: "reviewer", sub_task: "First" },
			{ node_id: "second", persona: "reviewer", sub_task: "Second" },
		],
	});
	assert.equal(cancelChain.isError, undefined, text(cancelChain));
	const ccId = cancelChain.details.task_id as string;
	const firstCfg = configs.get(`${ccId}:first`)!;
	atomicJson(resultPath(firstCfg.session_dir, firstCfg.instance_id), completionRecord(firstCfg,
		{ agent_name: "first", status: "success", summary: "First done", detail: "" }, "none", new Date().toISOString()));
	const cancelRes = await f.call("bootstrap_cancel", { task_id: ccId, agents: ["second"], reason: "Cancelled before handoff claim" });
	assert.equal(cancelRes.isError, undefined, text(cancelRes));
	const ccStatus = await f.call("bootstrap_status", { task_id: ccId });
	assert.doesNotMatch(text(ccStatus), /\[edges:/);
	const ccAgents = ccStatus.details.agents as Array<{ node_id: string; edge_states?: Record<string, string> }>;
	assert.deepEqual(ccAgents.find(a => a.node_id === "second")?.edge_states, { first: "fired" });
	await f.commands.get("bootgraph").handler(ccId, f.ctx);
	const ccFrame = f.widgets.get(`bootstrap-${ccId}`)!.render(100).join("\n");
	assert.match(ccFrame, /✓ first ──▶ ⊗ second/);
});

test("join edge_states and widget keep succeeded parent fired under fail_fast and cancellation", async t => {
	for (const [key, value] of Object.entries({ HERDR_ENV: "1", HERDR_PANE_ID: "dispatcher" })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const configs = new Map<string, WorkerConfig>();
	const panes = new Map<string, string>();
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "w" } });
		if (args[0] === "tab" && args[1] === "create") {
			const label = args[args.indexOf("--label") + 1];
			const paneId = `p-${label}`;
			panes.set(paneId, label);
			const tab = { tab_id: `t-${label}`, pane_id: paneId, terminal_id: "term", label, cwd: f.cwd };
			return ok({ tab, root_pane: tab });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const paneId = args[2];
			const [taskId, instance] = panes.get(paneId)!.split(":");
			const sessionDir = join(f.cwd, ".pi", "agent-sessions", taskId);
			const cfg = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.set(`${taskId}:${cfg.node_id}`, cfg);
			const ready = { task_id: taskId, token: cfg.token, instance_id: cfg.instance_id, name: cfg.instance_id, pid: process.pid, session_id: cfg.instance_id, endpoint: "/unused", model: "provider/model" };
			const registry = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${cfg.instance_id}.json`), ready);
			atomicJson(readyPath(sessionDir, cfg.instance_id), ready);
			return ok({});
		}
		return ok({});
	});
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	f.ctx.hasUI = true;

	const joinPlan = [
		{ node_id: "A", persona: "reviewer", sub_task: "Root A" },
		{ node_id: "B", persona: "reviewer", sub_task: "Root B" },
		{ node_id: "J", persona: "reviewer", sub_task: "Join J", depends_on: ["A", "B"] },
	];

	// (a) fail_fast graph: A succeeds, B fails, J cancelled with cause B => J.edge_states = { A: fired, B: dead }.
	const ff = await f.call("bootstrap_generate", {
		topology: "graph",
		task: "Fail fast join",
		request_id: "req-ff-join",
		project_cwd: f.cwd,
		fail_fast: true,
		dry_run: false,
		agents: joinPlan,
	});
	assert.equal(ff.isError, undefined, text(ff));
	const ffId = ff.details.task_id as string;
	const ffA = configs.get(`${ffId}:A`)!;
	const ffB = configs.get(`${ffId}:B`)!;
	const ffJ = configs.get(`${ffId}:J`)!;
	atomicJson(resultPath(ffA.session_dir, ffA.instance_id), completionRecord(ffA,
		{ agent_name: "A", status: "success", summary: "A ok", detail: "" }, "none", new Date().toISOString()));
	atomicJson(resultPath(ffB.session_dir, ffB.instance_id), completionRecord(ffB,
		{ agent_name: "B", status: "failure", summary: "B failed", detail: "" }, "none", new Date().toISOString()));
	atomicJson(dispositionPath(ffJ.session_dir, ffJ.instance_id), dispositionRecord(
		ffJ, "cancelled", "fail-fast after B failed", [{ node_id: "B", state: "failed" }], new Date().toISOString()));

	const ffStatus = await f.call("bootstrap_status", { task_id: ffId });
	const ffAgents = ffStatus.details.agents as Array<{ node_id: string; edge_states?: Record<string, string> }>;
	assert.deepEqual(ffAgents.find(a => a.node_id === "J")?.edge_states, { A: "fired", B: "dead" });
	t.mock.timers.tick(2000);
	const ffFrame = f.widgets.get(`bootstrap-${ffId}`)!.render(100).join("\n");
	assert.match(ffFrame, /✓ A ──┬─✗▶ ⊗ J/);
	assert.match(ffFrame, /✗ B ─✗┘/);

	// (b) Run-level bootstrap_cancel while J waits on B => A->J stays fired, B->J becomes dead.
	const rc = await f.call("bootstrap_generate", {
		topology: "graph",
		task: "Run cancel join",
		request_id: "req-rc-join",
		project_cwd: f.cwd,
		dry_run: false,
		agents: joinPlan,
	});
	assert.equal(rc.isError, undefined, text(rc));
	const rcId = rc.details.task_id as string;
	const rcA = configs.get(`${rcId}:A`)!;
	atomicJson(resultPath(rcA.session_dir, rcA.instance_id), completionRecord(rcA,
		{ agent_name: "A", status: "success", summary: "A ok", detail: "" }, "none", new Date().toISOString()));
	assert.equal((await f.call("bootstrap_cancel", { task_id: rcId, reason: "abort run" })).isError, undefined);
	const rcStatus = await f.call("bootstrap_status", { task_id: rcId });
	const rcAgents = rcStatus.details.agents as Array<{ node_id: string; edge_states?: Record<string, string> }>;
	assert.deepEqual(rcAgents.find(a => a.node_id === "J")?.edge_states, { A: "fired", B: "dead" });

	// (c) Node-level cancel of J alone while A succeeded and B is still pending => A->J stays fired, B->J stays pending.
	const nc = await f.call("bootstrap_generate", {
		topology: "graph",
		task: "Node cancel join",
		request_id: "req-nc-join",
		project_cwd: f.cwd,
		dry_run: false,
		agents: joinPlan,
	});
	assert.equal(nc.isError, undefined, text(nc));
	const ncId = nc.details.task_id as string;
	const ncA = configs.get(`${ncId}:A`)!;
	atomicJson(resultPath(ncA.session_dir, ncA.instance_id), completionRecord(ncA,
		{ agent_name: "A", status: "success", summary: "A ok", detail: "" }, "none", new Date().toISOString()));
	assert.equal((await f.call("bootstrap_cancel", { task_id: ncId, agents: ["J"], reason: "cancel J only" })).isError, undefined);
	const ncStatus = await f.call("bootstrap_status", { task_id: ncId });
	const ncAgents = ncStatus.details.agents as Array<{ node_id: string; edge_states?: Record<string, string> }>;
	assert.deepEqual(ncAgents.find(a => a.node_id === "J")?.edge_states, { A: "fired", B: "pending" });
});

test("the dispatcher watches without a widget and each status entry point can finish automatic cleanup", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	});
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "dispatcher";
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string }> = [];
	const configs = new Map<string, WorkerConfig>();
	let seq = 0;
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		const [resource, action, id] = args;
		if (resource === "pane" && action === "get") return ok({ pane: { workspace_id: "w" } });
		if (resource === "tab" && action === "create") {
			const key = String(++seq);
			const tab = { tab_id: key, pane_id: key, terminal_id: key, label: args[args.indexOf("--label") + 1] };
			tabs.push(tab);
			return ok({ tab, root_pane: tab });
		}
		if (resource === "pane" && action === "run") {
			const [task_id, instance_id] = tabs.find(tab => tab.pane_id === id)!.label.split(":");
			const dir = join(f.cwd, ".pi", "agent-sessions", task_id);
			const config = readJson<WorkerConfig>(join(dir, `${instance_id}.config.json`));
			configs.set(task_id, config);
			const ready = { task_id, token: config.token, instance_id, name: instance_id, pid: process.pid, session_id: instance_id, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance_id}.json`), ready);
			atomicJson(readyPath(dir, instance_id), ready);
			return ok({});
		}
		if (resource === "api" && action === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs, panes: tabs });
		if (resource === "tab" && action === "close") {
			const index = tabs.findIndex(tab => tab.tab_id === id);
			if (index < 0) throw new Error("Tab closed twice");
			tabs.splice(index, 1);
			return ok({});
		}
		throw new Error(`Unexpected Herdr command ${args.join(" ")}`);
	});
	t.after(() => f.hooks.get("session_shutdown")!());
	const autoText = /cleaned up automatically.*bootstrap_report/;
	const launch = async (task: string) => {
		const run = await f.call("bootstrap_generate", {
			task, topology: "graph", project_cwd: f.cwd, request_id: task,
			agents: [{ persona: "reviewer", sub_task: "Review" }],
		});
		const taskId = run.details.task_id;
		const config = configs.get(taskId)!;
		atomicJson(resultPath(config.session_dir, config.instance_id), completionRecord(config,
			{ agent_name: "reviewer", status: "success", summary: task, detail: "" }, "not_required", new Date().toISOString()));
		return taskId;
	};
	const tick = async (ms: number) => {
		t.mock.timers.tick(ms);
		await new Promise<void>(resolve => setImmediate(resolve));
	};
	const automatic = await launch("Headless");
	await tick(2000);
	assert.doesNotMatch(text(await f.call("bootstrap_status", { task_id: automatic })), autoText);
	await tick(2000);
	assert.match(f.followUps[0], autoText);
	assert.match(text(await f.call("bootstrap_status", { task_id: automatic })), autoText);
	await tick(6000);
	assert.equal(f.followUps.length, 1);

	for (const entryPoint of ["bootstrap_status", "boot", "bootgraph"] as const) {
		const taskId = await launch(entryPoint);
		// Leave the watcher armed, but let the foreground read run first at the settle deadline.
		await tick(2000);
		t.mock.timers.tick(1000);
		if (entryPoint === "bootstrap_status") {
			assert.match(text(await f.call(entryPoint, { task_id: taskId })), autoText);
		} else {
			f.ctx.hasUI = true;
			await f.commands.get(entryPoint).handler(taskId, f.ctx);
			const visible = entryPoint === "boot" ? f.notifications.at(-1)![0] : f.widgets.get(`bootstrap-${taskId}`)!.render(120).join("\n");
			assert.match(visible, autoText);
			f.ctx.hasUI = false;
		}
		assert.match(text(await f.call("bootstrap_report", { task_id: taskId })), /Run outcome: succeeded/);
		await tick(4000);
		assert.equal(f.followUps.length, 1, entryPoint);
	}
	f.ctx.hasUI = true;
	await f.hooks.get("session_start")!({}, f.ctx);
	for (const taskId of configs.keys()) {
		await f.commands.get("bootgraph").handler(taskId, f.ctx);
		assert.match(f.widgets.get(`bootstrap-${taskId}`)!.render(120).join("\n"), autoText);
	}
	const unwatched = await launch("Previous session");
	await f.hooks.get("session_start")!({}, f.ctx);
	await tick(4000);
	await f.commands.get("bootgraph").handler(unwatched, f.ctx);
	assert.match(f.widgets.get(`bootstrap-${unwatched}`)!.render(120).join("\n"), autoText);
	await tick(4000);
	assert.equal(f.followUps.length, 1);
});

test("all evaluators apply the unified delivery settlement rule and status explains why cleanup is waiting", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	});
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "dispatcher";
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string }> = [];
	const configs = new Map<string, WorkerConfig>();
	let seq = 0;
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		const [resource, action, id] = args;
		if (resource === "pane" && action === "get") return ok({ pane: { workspace_id: "w" } });
		if (resource === "tab" && action === "create") {
			const key = String(++seq);
			const tab = { tab_id: key, pane_id: key, terminal_id: key, label: args[args.indexOf("--label") + 1] };
			tabs.push(tab);
			return ok({ tab, root_pane: tab });
		}
		if (resource === "pane" && action === "run") {
			const [task_id, instance_id] = tabs.find(tab => tab.pane_id === id)!.label.split(":");
			const dir = join(f.cwd, ".pi", "agent-sessions", task_id);
			const config = readJson<WorkerConfig>(join(dir, `${instance_id}.config.json`));
			configs.set(`${task_id}:${config.node_id}`, config);
			const ready = { task_id, token: config.token, instance_id, name: instance_id, pid: process.pid, session_id: instance_id, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance_id}.json`), ready);
			atomicJson(readyPath(dir, instance_id), ready);
			return ok({});
		}
		if (resource === "api" && action === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs, panes: tabs });
		if (resource === "tab" && action === "close") {
			const index = tabs.findIndex(tab => tab.tab_id === id);
			if (index < 0) throw new Error("Tab closed twice");
			tabs.splice(index, 1);
			return ok({});
		}
		throw new Error(`Unexpected Herdr command ${args.join(" ")}`);
	});
	t.after(() => f.hooks.get("session_shutdown")!());
	const autoText = /cleaned up automatically.*bootstrap_report/;
	const tick = async (ms: number) => {
		t.mock.timers.tick(ms);
		await new Promise<void>(resolve => setImmediate(resolve));
	};

	const setupRoutedPending = async (name: string) => {
		const run = await f.call("bootstrap_generate", {
			task: name, topology: "graph", project_cwd: f.cwd, request_id: name,
			agents: [
				{ node_id: "first", persona: "reviewer", sub_task: "First" },
				{ node_id: "second", persona: "reviewer", depends_on: ["first"], sub_task: "Second" },
			],
		});
		const taskId = run.details.task_id as string;
		const c1 = configs.get(`${taskId}:first`)!;
		const c2 = configs.get(`${taskId}:second`)!;
		const r1 = { agent_name: "reviewer", node_id: "first", status: "success" as const, summary: `${name} 1`, detail: "" };
		const comp1 = completionRecord(c1, r1, "pending", new Date(Date.now()).toISOString());
		atomicJson(resultPath(c1.session_dir, c1.instance_id), comp1);
		const digest = inputDigest(comp1.result);
		const hId = handoffId({
			run_id: taskId, source_attempt_id: c1.attempt_id!, destination_node_id: "second",
			destination_attempt_id: c2.attempt_id!, input_digest: digest,
		});
		atomicJson(join(c2.session_dir, `${c2.instance_id}.from-${c1.instance_id}.handoff-offer.json`), {
			version: 1, handoff_id: hId, run_id: taskId, state: "queued",
			source: { node_id: "first", attempt_id: c1.attempt_id, instance_id: c1.instance_id, persona_name: "reviewer" },
			destination: { node_id: "second", attempt_id: c2.attempt_id, instance_id: c2.instance_id },
			input_digest: digest, result_path: resultPath(c1.session_dir, c1.instance_id), offered_at: new Date().toISOString(),
		});
		atomicJson(join(c2.session_dir, `${c2.instance_id}.from-${c1.instance_id}.handoff.json`), {
			version: 1, handoff_id: hId, state: "accepted", run_id: taskId,
			source: { node_id: "first", attempt_id: c1.attempt_id, instance_id: c1.instance_id, session_id: c1.instance_id },
			destination: { node_id: "second", attempt_id: c2.attempt_id, instance_id: c2.instance_id },
			input_digest: digest, offer: "matched", accepted_at: new Date().toISOString(),
		});
		atomicJson(resultPath(c2.session_dir, c2.instance_id), completionRecord(c2,
			{ agent_name: "reviewer", node_id: "second", status: "success", summary: `${name} 2`, detail: "" }, "not_required", new Date(Date.now()).toISOString()));
		return { taskId, c1, c2 };
	};

	// While first is still live with delivery: "pending", bootstrap_status and /boot explain why cleanup hasn't run yet.
	const liveCase = await setupRoutedPending("wait-reason");
	await tick(4000);
	const statusWait = await f.call("bootstrap_status", { task_id: liveCase.taskId });
	assert.equal(statusWait.details.status, "applied");
	assert.match(statusWait.details.cleanup_wait_reason ?? "", /Automatic cleanup has not run yet: waiting for first delivery.*still live/i);
	assert.match(text(statusWait), /Automatic cleanup has not run yet: waiting for first delivery.*still live/i);
	f.ctx.hasUI = true;
	await f.commands.get("boot").handler(liveCase.taskId, f.ctx);
	assert.match(f.notifications.at(-1)![0], /Automatic cleanup has not run yet: waiting for first delivery.*still live/i);
	f.ctx.hasUI = false;

	// Once first exits (still delivery: "pending"), watcher cleans up and sends one follow-up.
	atomicJson(readyPath(liveCase.c1.session_dir, liveCase.c1.instance_id), { ...readJson<any>(readyPath(liveCase.c1.session_dir, liveCase.c1.instance_id)), pid: 2147483646 });
	await tick(2000);
	assert.equal(f.followUps.length, 1);
	assert.match(f.followUps[0], autoText);
	const cleanedStatus = await f.call("bootstrap_status", { task_id: liveCase.taskId });
	assert.equal(cleanedStatus.details.cleanup_wait_reason, undefined);
	assert.match(text(cleanedStatus), autoText);

	// Test lazy evaluators (bootstrap_status, /boot, /bootgraph) on unwatched runs after session_start reset.
	for (const entryPoint of ["bootstrap_status", "boot", "bootgraph"] as const) {
		const c = await setupRoutedPending(`lazy-${entryPoint}`);
		await f.hooks.get("session_start")!({}, f.ctx);
		atomicJson(readyPath(c.c1.session_dir, c.c1.instance_id), { ...readJson<any>(readyPath(c.c1.session_dir, c.c1.instance_id)), pid: 2147483646 });
		atomicJson(readyPath(c.c2.session_dir, c.c2.instance_id), { ...readJson<any>(readyPath(c.c2.session_dir, c.c2.instance_id)), pid: 2147483646 });
		if (entryPoint === "bootstrap_status") {
			assert.match(text(await f.call("bootstrap_status", { task_id: c.taskId })), autoText);
		} else {
			f.ctx.hasUI = true;
			await f.commands.get(entryPoint).handler(c.taskId, f.ctx);
			const visible = entryPoint === "boot" ? f.notifications.at(-1)![0] : f.widgets.get(`bootstrap-${c.taskId}`)!.render(120).join("\n");
			assert.match(visible, autoText);
			f.ctx.hasUI = false;
		}
		assert.match(text(await f.call("bootstrap_report", { task_id: c.taskId })), /Run outcome: succeeded/);
	}
	assert.equal(f.followUps.length, 1, "lazy evaluators must not emit duplicate watcher follow-ups");

	// m16: pending > 0 with cleanup_wait_reason surfaces wait reason in bootstrap_status text.
	{
		const c = await setupRoutedPending("pending-wait-reason");
		await f.hooks.get("session_start")!({}, f.ctx);
		const comp1 = readJson<any>(resultPath(c.c1.session_dir, c.c1.instance_id));
		atomicJson(resultPath(c.c1.session_dir, c.c1.instance_id), {
			...comp1,
			delivery: "sent",
			edge_deliveries: { [c.c2.instance_id]: { state: "sent", updated_at: new Date().toISOString() } },
		});
		const comp2 = readJson<any>(resultPath(c.c2.session_dir, c.c2.instance_id));
		atomicJson(resultPath(c.c2.session_dir, c.c2.instance_id), { ...comp2, delivery: "pending" });
		await tick(4000);
		const res = await f.call("bootstrap_status", { task_id: c.taskId });
		assert.deepEqual(res.details.pending, ["second"]);
		assert.match(res.details.cleanup_wait_reason ?? "", /waiting for second delivery to settle while its agent is still live/i);
		assert.match(text(res), /Automatic cleanup has not run yet: waiting for second delivery to settle while its agent is still live/);
	}

	// m20 + LOW: settle-window wait reason is deterministic (no remaining ms) in bootstrap_status and /boot.
	{
		const c = await setupRoutedPending("settle-window-deterministic");
		await f.hooks.get("session_start")!({}, f.ctx);
		const comp1 = readJson<any>(resultPath(c.c1.session_dir, c.c1.instance_id));
		atomicJson(resultPath(c.c1.session_dir, c.c1.instance_id), {
			...comp1,
			delivery: "sent",
			edge_deliveries: { [c.c2.instance_id]: { state: "sent", updated_at: new Date().toISOString() } },
		});
		await tick(1000);
		const res = await f.call("bootstrap_status", { task_id: c.taskId });
		assert.equal(res.details.status, "applied");
		assert.equal(res.details.cleanup_wait_reason, "Automatic cleanup has not run yet: within the cleanup settle window (cleanup_settle_ms).");
		assert.match(text(res), /Automatic cleanup has not run yet: within the cleanup settle window \(cleanup_settle_ms\)\./);
		assert.doesNotMatch(res.details.cleanup_wait_reason ?? "", /\d+ms/);
		f.ctx.hasUI = true;
		await f.commands.get("boot").handler(c.taskId, f.ctx);
		assert.match(f.notifications.at(-1)![0], /Automatic cleanup has not run yet: within the cleanup settle window \(cleanup_settle_ms\)\./);
		f.ctx.hasUI = false;
	}

	// m19 + LOW: permanent conditions (agent errors in /boot, missing claim with finished successor) do not say "waiting".
	{
		const c = await setupRoutedPending("agent-error-wait-reason");
		await f.hooks.get("session_start")!({}, f.ctx);
		const comp1 = readJson<any>(resultPath(c.c1.session_dir, c.c1.instance_id));
		atomicJson(resultPath(c.c1.session_dir, c.c1.instance_id), {
			...comp1,
			delivery: "sent",
			edge_deliveries: { [c.c2.instance_id]: { state: "sent", updated_at: new Date().toISOString() } },
		});
		writeFileSync(join(c.c2.session_dir, `${c.c2.instance_id}.from-${c.c1.instance_id}.handoff.json`), "{not json");
		const res = await f.call("bootstrap_status", { task_id: c.taskId });
		assert.equal(res.details.cleanup_wait_reason, "Automatic cleanup has not run: agent errors have not settled; resolve with bootstrap_recover or bootstrap_cleanup.");
		assert.doesNotMatch(res.details.cleanup_wait_reason ?? "", /\bwaiting\b/i);
		f.ctx.hasUI = true;
		await f.commands.get("boot").handler(c.taskId, f.ctx);
		assert.match(f.notifications.at(-1)![0], /Automatic cleanup has not run: agent errors have not settled; resolve with bootstrap_recover or bootstrap_cleanup\./);
		assert.doesNotMatch(f.notifications.at(-1)![0], /\bwaiting\b/i);
		f.ctx.hasUI = false;
	}

	{
		const run = await f.call("bootstrap_generate", {
			task: "missing-claim-wait-reason", topology: "graph", project_cwd: f.cwd, request_id: "missing-claim-wait-reason",
			agents: [
				{ node_id: "first", persona: "reviewer", sub_task: "First" },
				{ node_id: "second", persona: "reviewer", depends_on: ["first"], sub_task: "Second" },
			],
		});
		const taskId = run.details.task_id as string;
		const c1 = configs.get(`${taskId}:first`)!;
		const c2 = configs.get(`${taskId}:second`)!;
		atomicJson(resultPath(c1.session_dir, c1.instance_id), completionRecord(c1,
			{ agent_name: "reviewer", node_id: "first", status: "success", summary: "1", detail: "" }, "pending", new Date(Date.now()).toISOString()));
		atomicJson(resultPath(c2.session_dir, c2.instance_id), completionRecord(c2,
			{ agent_name: "reviewer", node_id: "second", status: "success", summary: "2", detail: "" }, "not_required", new Date(Date.now()).toISOString()));
		atomicJson(readyPath(c1.session_dir, c1.instance_id), { ...readJson<any>(readyPath(c1.session_dir, c1.instance_id)), pid: 2147483646 });
		atomicJson(readyPath(c2.session_dir, c2.instance_id), { ...readJson<any>(readyPath(c2.session_dir, c2.instance_id)), pid: 2147483646 });
		const res = await f.call("bootstrap_status", { task_id: taskId });
		assert.equal(res.details.cleanup_wait_reason, "Automatic cleanup has not run yet: first handoff to second has not settled; resolve with bootstrap_recover or bootstrap_cleanup.");
		assert.match(text(res), /Automatic cleanup has not run yet: first handoff to second has not settled; resolve with bootstrap_recover or bootstrap_cleanup\./);
		assert.doesNotMatch(res.details.cleanup_wait_reason ?? "", /\bwaiting\b/i);
		f.ctx.hasUI = true;
		await f.commands.get("boot").handler(taskId, f.ctx);
		assert.match(f.notifications.at(-1)![0], /Automatic cleanup has not run yet: first handoff to second has not settled; resolve with bootstrap_recover or bootstrap_cleanup\./);
		assert.doesNotMatch(f.notifications.at(-1)![0], /\bwaiting\b/i);
		f.ctx.hasUI = false;
	}
});

test("routed live source with unknown delivery fails closed in bootstrap_status for graph and chain (pin)", async t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
	const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	});
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "dispatcher";
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string }> = [];
	const configs = new Map<string, WorkerConfig>();
	let seq = 0;
	const f = loaded(t, "provider/model", (_command, args) => {
		const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
		const [resource, action, id] = args;
		if (resource === "pane" && action === "get") return ok({ pane: { workspace_id: "w" } });
		if (resource === "tab" && action === "create") {
			const key = String(++seq);
			const tab = { tab_id: key, pane_id: key, terminal_id: key, label: args[args.indexOf("--label") + 1] };
			tabs.push(tab);
			return ok({ tab, root_pane: tab });
		}
		if (resource === "pane" && action === "run") {
			const [task_id, instance_id] = tabs.find(tab => tab.pane_id === id)!.label.split(":");
			const dir = join(f.cwd, ".pi", "agent-sessions", task_id);
			const config = readJson<WorkerConfig>(join(dir, `${instance_id}.config.json`));
			configs.set(`${task_id}:${config.node_id}`, config);
			const ready = { task_id, token: config.token, instance_id, name: instance_id, pid: process.pid, session_id: instance_id, endpoint: "/unused", model: "provider/model" };
			const registry = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registry, { recursive: true });
			atomicJson(join(registry, `${instance_id}.json`), ready);
			atomicJson(readyPath(dir, instance_id), ready);
			return ok({});
		}
		if (resource === "api" && action === "snapshot") return ok({ workspaces: [{ workspace_id: "w" }], tabs, panes: tabs });
		if (resource === "tab" && action === "close") {
			const index = tabs.findIndex(tab => tab.tab_id === id);
			if (index < 0) throw new Error("Tab closed twice");
			tabs.splice(index, 1);
			return ok({});
		}
		throw new Error(`Unexpected Herdr command ${args.join(" ")}`);
	});
	t.after(() => f.hooks.get("session_shutdown")!());
	const tick = async (ms: number) => {
		t.mock.timers.tick(ms);
		await new Promise<void>(resolve => setImmediate(resolve));
	};

	for (const topology of ["graph", "chain"] as const) {
		await t.test(topology, async () => {
			const run = await f.call("bootstrap_generate", {
				task: `routed-unknown-${topology}`, topology, cleanup: "on_success", cleanup_settle_ms: 0, project_cwd: f.cwd, request_id: `routed-unknown-${topology}`,
				agents: topology === "graph"
					? [
						{ node_id: "first", persona: "reviewer", write_paths: ["src/a.ts"], sub_task: "First" },
						{ node_id: "second", persona: "reviewer", depends_on: ["first"], sub_task: "Second" },
					]
					: [
						{ node_id: "first", persona: "reviewer", write_paths: ["src/a.ts"], sub_task: "First" },
						{ node_id: "second", persona: "reviewer", sub_task: "Second" },
					],
			});
			const taskId = run.details.task_id as string;
			const c1 = configs.get(`${taskId}:first`)!;
			const c2 = configs.get(`${taskId}:second`)!;
			const r1 = { agent_name: "reviewer", node_id: "first", status: "success" as const, summary: "1", detail: "" };
			const comp1 = {
				...completionRecord(c1, r1, "none" as unknown as "sent", new Date(Date.now()).toISOString()),
				...(topology === "graph" ? { edge_deliveries: { [c2.instance_id]: { state: "sent", updated_at: new Date().toISOString() } } } : {}),
			};
			atomicJson(resultPath(c1.session_dir, c1.instance_id), comp1);
			const digest = inputDigest(comp1.result);
			const hId = handoffId({
				run_id: taskId, source_attempt_id: c1.attempt_id!, destination_node_id: "second",
				destination_attempt_id: c2.attempt_id!, input_digest: digest,
			});
			const scope = topology === "graph" ? c1.instance_id : undefined;
			atomicJson(handoffOfferPath(c2.session_dir, c2.instance_id, scope), {
				version: 1, handoff_id: hId, run_id: taskId, state: "queued",
				source: { node_id: "first", attempt_id: c1.attempt_id, instance_id: c1.instance_id, persona_name: "reviewer" },
				destination: { node_id: "second", attempt_id: c2.attempt_id, instance_id: c2.instance_id },
				input_digest: digest, result_path: resultPath(c1.session_dir, c1.instance_id), offered_at: new Date().toISOString(),
			});
			atomicJson(handoffClaimPath(c2.session_dir, c2.instance_id, scope), {
				version: 1, handoff_id: hId, state: "accepted", run_id: taskId,
				source: { node_id: "first", attempt_id: c1.attempt_id, instance_id: c1.instance_id, session_id: c1.instance_id },
				destination: { node_id: "second", attempt_id: c2.attempt_id, instance_id: c2.instance_id },
				input_digest: digest, offer: "matched", accepted_at: new Date().toISOString(),
			});
			atomicJson(resultPath(c2.session_dir, c2.instance_id), completionRecord(c2,
				{ agent_name: "reviewer", node_id: "second", status: "success", summary: "2", detail: "" }, "not_required", new Date(Date.now()).toISOString()));
			atomicJson(readyPath(c2.session_dir, c2.instance_id), { ...readJson<any>(readyPath(c2.session_dir, c2.instance_id)), pid: 2147483646 });

			await tick(4000);
			const res = await f.call("bootstrap_status", { task_id: taskId });
			assert.equal(res.details.status, "applied", topology);
			assert.equal(res.details.cleanup_trigger, undefined, topology);
			assert.equal(readJson<BootstrapManifest>(join(c1.session_dir, "manifest.json")).status, "applied", topology);
			assert.deepEqual(res.details.worker_errors, [], topology);
			assert.deepEqual(res.details.delivery_errors, [], topology);
			assert.equal(res.details.outcome.state, "succeeded", topology);
			assert.equal(res.details.outcome.terminal, true, topology);
			assert.ok(res.details.agents.every((a: any) => a.execution_causes.length === 0), topology);
			assert.ok(res.details.agents.every((a: any) => a.ownership_status !== "admitted" && a.ownership_status !== "held_uncertain"), topology);
			assert.equal(res.details.agents.find((a: any) => a.node_id === "first")?.resource, "released", topology);
			assert.ok(tabs.some(tab => tab.label === `${taskId}:${c1.instance_id}`), `${topology}: live source tab must stay open`);
			assert.equal(res.details.cleanup_wait_reason, 'Automatic cleanup has not run yet: first delivery state is "none".', topology);
			assert.match(text(res), /Automatic cleanup has not run yet: first delivery state is "none"\./, topology);
			assert.match(text(await f.call("bootstrap_report", { task_id: taskId })), /Run outcome: succeeded/, topology);
		});
	}
});

// ---- factory ticket 02: command/tool surface, exact brief entry, session isolation & receipt recovery ----

function interactiveFactoryContext(
	f: ReturnType<typeof loaded>,
	options: {
		sessionId?: string;
		sessionFile?: string;
		editor?: (title: string, prefill?: string) => Promise<string | undefined>;
		confirm?: (title: string, message: string) => Promise<boolean>;
	} = {},
) {
	const notifications: Array<[string, string]> = [];
	const sessionId = options.sessionId ?? "pi-session-1";
	const sessionFile = options.sessionFile ?? "/tmp/pi-session-1.jsonl";
	const ctx: any = {
		cwd: f.cwd,
		model: { provider: "provider", id: "model" },
		thinkingLevel: "medium",
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		ui: {
			notify: (message: string, level: string) => { notifications.push([message, level]); },
			editor: options.editor ?? (async () => undefined),
			confirm: options.confirm ?? (async () => true),
			setTheme: () => ({ success: true }),
			setWidget: () => {},
		},
	};
	return { ctx, notifications };
}

async function publishTestFactory(f: ReturnType<typeof loaded>, name = "quality") {
	const draft = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "Factory task",
		agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }],
	};
	const { ctx, notifications } = interactiveFactoryContext(f, {
		editor: async () => JSON.stringify({ name, draft }),
		confirm: async () => true,
	});
	await f.commands.get("factory").handler("publish", ctx);
	assert.equal(notifications.at(-1)?.[1], "info", notifications.at(-1)?.[0]);
	return JSON.parse(notifications.at(-1)![0]) as { factory_id: string; name: string; current_version: string; management: string };
}

test("factory_inspect tool supports read-only receipt recovery with strict action-specific validation and no mutating factory tools", async t => {
	const savedFactoryDir = process.env.PI_FACTORY_STATE_DIR;
	delete process.env.PI_FACTORY_STATE_DIR;
	t.after(() => {
		if (savedFactoryDir === undefined) delete process.env.PI_FACTORY_STATE_DIR;
		else process.env.PI_FACTORY_STATE_DIR = savedFactoryDir;
	});

	const f = loaded(t);
	const factoryTools = [...f.tools.keys()].filter(name => name.startsWith("factory")).sort();
	assert.deepEqual(factoryTools, ["factory_inspect", "factory_propose_constraint"]);

	const published = await publishTestFactory(f, "receipt-tool");
	const { ctx, notifications } = interactiveFactoryContext(f, {
		editor: async () => "  Exact multiline\nbrief #42  \n",
	});
	await f.commands.get("factory").handler(`resume ${published.factory_id}`, ctx);
	assert.equal(notifications.at(-1)?.[1], "info", notifications.at(-1)?.[0]);

	await f.commands.get("factory").handler(`submit ${published.factory_id} Ref-Case`, ctx);
	assert.equal(notifications.at(-1)?.[1], "info", notifications.at(-1)?.[0]);
	const receipt = JSON.parse(notifications.at(-1)![0]) as { input_id: string; reference: string; brief: string };

	// Action-specific validation failures.
	for (const badParams of [
		{ action: "list", factory_id: published.factory_id },
		{ action: "list", reference: "Ref-Case" },
		{ action: "inspect" },
		{ action: "inspect", factory_id: "   " },
		{ action: "inspect", factory_id: published.factory_id, reference: "Ref-Case" },
		{ action: "receipt" },
		{ action: "receipt", factory_id: published.factory_id },
		{ action: "receipt", factory_id: published.factory_id, reference: "Ref-Case", input_id: receipt.input_id },
		{ action: "receipt", factory_id: published.factory_id, reference: "Ref-Case", brief: "forbidden" },
		{ action: "submit", factory_id: published.factory_id, brief: "no" },
	]) {
		const res = await f.call("factory_inspect", badParams);
		assert.equal(res.isError, true, `expected validation error for ${JSON.stringify(badParams)}`);
	}

	// Read-only receipt recovery by literal reference and by input_id.
	const byRef = await f.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, reference: "Ref-Case" });
	assert.equal(byRef.isError, undefined, text(byRef));
	assert.deepEqual(byRef.details.result, receipt);

	const byId = await f.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, input_id: receipt.input_id });
	assert.equal(byId.isError, undefined, text(byId));
	assert.deepEqual(byId.details.result, receipt);

	// Literal case sensitivity: ref-case does not match Ref-Case.
	const wrongCase = await f.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, reference: "ref-case" });
	assert.equal(wrongCase.isError, true);
	assert.match(text(wrongCase), /not found/i);
	assert.deepEqual(f.execCalls, []);
});

test("/factory command exposes pre-write reference, preserves exact untrimmed brief, handles cancellation/invalid args, and isolates sessions", async t => {
	const savedFactoryDir = process.env.PI_FACTORY_STATE_DIR;
	delete process.env.PI_FACTORY_STATE_DIR;
	t.after(() => {
		if (savedFactoryDir === undefined) delete process.env.PI_FACTORY_STATE_DIR;
		else process.env.PI_FACTORY_STATE_DIR = savedFactoryDir;
	});

	const f = loaded(t);
	const published = await publishTestFactory(f, "cmd-factory");
	const cmd = f.commands.get("factory");

	// Read-only commands work without UI; mutating commands reject without UI.
	await cmd.handler("list", f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info");
	await cmd.handler(`inspect ${published.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info");
	await cmd.handler(`resume ${published.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	await cmd.handler(`submit ${published.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");

	// Invalid and excess arguments produce clear usage errors.
	const { ctx, notifications } = interactiveFactoryContext(f);
	for (const badArgs of [
		"list extra",
		"inspect",
		`inspect ${published.factory_id} extra`,
		"receipt",
		`receipt ${published.factory_id}`,
		`receipt ${published.factory_id} ref extra`,
		"publish extra",
		"resume",
		`resume ${published.factory_id} extra`,
		"submit",
		`submit ${published.factory_id} ref extra`,
		"unknown-subcommand",
	]) {
		await cmd.handler(badArgs, ctx);
		assert.equal(notifications.at(-1)?.[1], "error", `expected error for /factory ${badArgs}`);
		assert.match(notifications.at(-1)![0], /usage/i);
	}

	// Submitting before resuming fails cleanly without calling editor.
	let editorCalled = false;
	const preResume = interactiveFactoryContext(f, { editor: async () => { editorCalled = true; return "hello"; } });
	await cmd.handler(`submit ${published.factory_id}`, preResume.ctx);
	assert.equal(preResume.notifications.at(-1)?.[1], "error");
	assert.match(preResume.notifications.at(-1)![0], /unmanaged|resume/i);
	assert.equal(editorCalled, false);

	// Resume in session 1.
	await cmd.handler(`resume ${published.factory_id}`, ctx);
	assert.equal(notifications.at(-1)?.[1], "info", notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(notifications.at(-1)![0]).factory.management, "managed");

	// Cancel in editor does not record anything.
	let exposedTitle = "";
	const cancelCtx = interactiveFactoryContext(f, {
		editor: async title => { exposedTitle = title; return undefined; },
	});
	await cmd.handler(`submit ${published.factory_id}`, cancelCtx.ctx);
	assert.match(exposedTitle, /ref:\s*sub-[a-f0-9-]+/i);
	assert.ok(cancelCtx.notifications.some(([msg, lvl]) => lvl === "info" && /Submission reference: sub-[a-f0-9-]+/.test(msg)));
	assert.match(cancelCtx.notifications.at(-1)![0], /cancel/i);
	assert.equal((await f.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result.queue.length, 0);

	// Auto-generated reference exposed before write + exact untrimmed multiline UTF-8 brief preserved.
	const exactBrief = "  leading space\n\tsecond line\n#99 docs/a.md 🚀\ntrailing space  \n\n";
	let preWriteRef = "";
	const submitCtx = interactiveFactoryContext(f, {
		editor: async title => {
			const match = /ref:\s*([^\]]+)/.exec(title);
			assert.ok(match);
			preWriteRef = match[1]!;
			return exactBrief;
		},
	});
	await cmd.handler(`submit ${published.factory_id}`, submitCtx.ctx);
	assert.equal(submitCtx.notifications.at(-1)?.[1], "info", submitCtx.notifications.at(-1)?.[0]);
	const receipt = JSON.parse(submitCtx.notifications.at(-1)![0]);
	assert.equal(receipt.reference, preWriteRef);
	assert.equal(receipt.brief, exactBrief);
	assert.equal(receipt.bound_version, "v1");
	assert.equal(receipt.disposition, "queued");
	assert.equal("task_id" in receipt, false);

	// Explicit retry with the same literal reference recovers original receipt without adding queue entry.
	const retryCtx = interactiveFactoryContext(f, { editor: async () => exactBrief });
	await cmd.handler(`submit ${published.factory_id} ${preWriteRef}`, retryCtx.ctx);
	assert.equal(retryCtx.notifications.at(-1)?.[1], "info", retryCtx.notifications.at(-1)?.[0]);
	assert.deepEqual(JSON.parse(retryCtx.notifications.at(-1)![0]), receipt);

	// Read-only /factory receipt works even without UI.
	await cmd.handler(`receipt ${published.factory_id} ${preWriteRef}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "info");
	assert.deepEqual(JSON.parse(f.notifications.at(-1)![0]), receipt);

	// Session switch / reload via session_start invalidates old authority and prevents silent inheritance (even with same transcript ID).
	await f.hooks.get("session_start")!({ reason: "resume" }, ctx);
	await cmd.handler(`resume ${published.factory_id}`, ctx);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)![0], /already managed|another session/i);
	await cmd.handler(`submit ${published.factory_id}`, submitCtx.ctx);
	assert.equal(submitCtx.notifications.at(-1)?.[1], "error");

	// Switching sessionManager identity without session_start also rotates authority.
	const f2 = loaded(t);
	const pub2 = await publishTestFactory(f2, "switch-test");
	const s1 = interactiveFactoryContext(f2, { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
	await f2.commands.get("factory").handler(`resume ${pub2.factory_id}`, s1.ctx);
	assert.equal(s1.notifications.at(-1)?.[1], "info");
	const s2 = interactiveFactoryContext(f2, { sessionId: "s2", sessionFile: "/tmp/s2.jsonl", editor: async () => "should fail" });
	await f2.commands.get("factory").handler(`submit ${pub2.factory_id}`, s2.ctx);
	assert.equal(s2.notifications.at(-1)?.[1], "error");

	// session_shutdown revokes authority permanently for that incarnation.
	await f2.hooks.get("session_shutdown")!({ reason: "quit" }, s1.ctx);
	await f2.commands.get("factory").handler(`resume ${pub2.factory_id}`, s1.ctx);
	assert.equal(s1.notifications.at(-1)?.[1], "error");
	assert.match(s1.notifications.at(-1)![0], /shut down|authority/i);

	// Worker session (--bootstrap-worker-config) cannot publish, resume, or submit.
	const savedArgv = [...process.argv];
	process.argv.push("--bootstrap-worker-config", "/tmp/w.json");
	t.after(() => { process.argv.splice(0, process.argv.length, ...savedArgv); });
	const workerCtx = interactiveFactoryContext(f, { editor: async () => "worker brief" });
	for (const blocked of ["publish", `resume ${published.factory_id}`, `submit ${published.factory_id}`]) {
		await cmd.handler(blocked, workerCtx.ctx);
		assert.equal(workerCtx.notifications.at(-1)?.[1], "error");
		assert.match(workerCtx.notifications.at(-1)![0], /worker/i);
	}
	assert.deepEqual(f.execCalls, []);
});

test("suspended /factory submit re-checks live session binding after editor returns without allocating authority or rescuing revoked instance", async t => {
	const savedFactoryDir = process.env.PI_FACTORY_STATE_DIR;
	delete process.env.PI_FACTORY_STATE_DIR;
	t.after(() => {
		if (savedFactoryDir === undefined) delete process.env.PI_FACTORY_STATE_DIR;
		else process.env.PI_FACTORY_STATE_DIR = savedFactoryDir;
	});

	const f = loaded(t);
	const published = await publishTestFactory(f, "suspended-binding");
	const cmd = f.commands.get("factory");

	let liveSessionId = "live-s1";
	let liveSessionFile = "/tmp/live-s1.jsonl";
	const suspendedNotifications: Array<[string, string]> = [];
	const suspendedCtx: any = {
		cwd: f.cwd,
		model: { provider: "provider", id: "model" },
		thinkingLevel: "medium",
		hasUI: true,
		sessionManager: {
			getSessionId: () => liveSessionId,
			getSessionFile: () => liveSessionFile,
		},
		ui: {
			notify: (message: string, level: string) => { suspendedNotifications.push([message, level]); },
			editor: async () => {
				// Simulate the session binding changing while /factory submit is suspended in the editor (without session_start).
				liveSessionId = "live-s2";
				liveSessionFile = "/tmp/live-s2.jsonl";
				return "Brief submitted after session binding changed";
			},
			confirm: async () => true,
			setTheme: () => ({ success: true }),
			setWidget: () => {},
		},
	};

	await cmd.handler(`resume ${published.factory_id}`, suspendedCtx);
	assert.equal(suspendedNotifications.at(-1)?.[1], "info");

	await cmd.handler(`submit ${published.factory_id} Ref-Suspended`, suspendedCtx);
	assert.equal(suspendedNotifications.at(-1)?.[1], "error", suspendedNotifications.at(-1)?.[0]);
	assert.match(suspendedNotifications.at(-1)![0], /binding changed|suspended|authority/i);

	// Nothing was written and receipt does not exist.
	const inspected = await f.call("factory_inspect", { action: "inspect", factory_id: published.factory_id });
	assert.deepEqual(inspected.details.result.queue, []);
	const missingReceipt = await f.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, reference: "Ref-Suspended" });
	assert.equal(missingReceipt.isError, true);

	// Switching back to live-s1 did not lose/replace ownership or allocate a rogue authority for s2;
	// and if session_shutdown runs while editor is open, returning from editor fails closed without rescuing.
	liveSessionId = "live-s1";
	liveSessionFile = "/tmp/live-s1.jsonl";
	let shutdownDuringEditor = false;
	const shutdownCtx: any = {
		...suspendedCtx,
		ui: {
			...suspendedCtx.ui,
			editor: async () => {
				shutdownDuringEditor = true;
				await f.hooks.get("session_shutdown")!({ reason: "quit" }, shutdownCtx);
				return "Brief after shutdown";
			},
		},
	};
	await cmd.handler(`submit ${published.factory_id} Ref-Shutdown`, shutdownCtx);
	assert.equal(shutdownDuringEditor, true);
	assert.equal(suspendedNotifications.at(-1)?.[1], "error");
	assert.match(suspendedNotifications.at(-1)![0], /shut down|authority/i);
	assert.deepEqual((await f.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result.queue, []);
});

// ---- factory ticket 04: operator publication update/restore commands and read-only version inspection ----

test("operator /factory update and /factory restore need a UI and an exact-target human confirmation; agent tools cannot publish or restore", async t => {
	const savedFactoryDir = process.env.PI_FACTORY_STATE_DIR;
	delete process.env.PI_FACTORY_STATE_DIR;
	t.after(() => {
		if (savedFactoryDir === undefined) delete process.env.PI_FACTORY_STATE_DIR;
		else process.env.PI_FACTORY_STATE_DIR = savedFactoryDir;
	});
	const f = loaded(t);
	const published = await publishTestFactory(f, "versioned");
	const cmd = f.commands.get("factory");
	const draftFor = (task: string) => ({
		project_cwd: f.cwd, topology: "graph", task,
		agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }],
	});
	const current = async () => (await f.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result;

	// No UI: rejected before anything is read or written.
	await cmd.handler(`update ${published.factory_id}`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	assert.match(f.notifications.at(-1)![0], /interactive|UI/i);
	await cmd.handler(`restore ${published.factory_id} v1`, f.ctx);
	assert.equal(f.notifications.at(-1)?.[1], "error");
	assert.match(f.notifications.at(-1)![0], /interactive|UI/i);

	// Usage errors.
	const usage = interactiveFactoryContext(f);
	for (const bad of ["update", `update ${published.factory_id} extra`, "restore", `restore ${published.factory_id}`, `restore ${published.factory_id} v1 extra`, `restore ${published.factory_id} latest`]) {
		await cmd.handler(bad, usage.ctx);
		assert.equal(usage.notifications.at(-1)?.[1], "error", bad);
		assert.match(usage.notifications.at(-1)![0], /usage|version token/i, bad);
	}

	// Declined confirmation and malformed input leave v1 current.
	let confirmMessage = "";
	const declined = interactiveFactoryContext(f, {
		editor: async () => JSON.stringify({ draft: draftFor("Declined v2") }),
		confirm: async (_title, message) => { confirmMessage = message; return false; },
	});
	await cmd.handler(`update ${published.factory_id}`, declined.ctx);
	assert.match(confirmMessage, /versioned/);
	assert.ok(confirmMessage.includes(published.factory_id));
	assert.match(confirmMessage, /publish v2 of versioned/);
	assert.match(confirmMessage, /replacing current v1/);
	assert.equal((await current()).factory.current_version, "v1");
	for (const badJson of ["{", JSON.stringify({}), JSON.stringify({ draft: draftFor("x"), name: "other" })]) {
		const bad = interactiveFactoryContext(f, { editor: async () => badJson });
		await cmd.handler(`update ${published.factory_id}`, bad.ctx);
		assert.equal(bad.notifications.at(-1)?.[1], "error", badJson);
	}
	const cancelled = interactiveFactoryContext(f, { editor: async () => undefined });
	await cmd.handler(`update ${published.factory_id}`, cancelled.ctx);
	assert.equal((await current()).factory.current_version, "v1");

	// Confirmed update publishes v2 without resuming management.
	const confirmedUpdate = interactiveFactoryContext(f, { editor: async () => JSON.stringify({ draft: draftFor("Confirmed v2") }) });
	await cmd.handler(`update ${published.factory_id}`, confirmedUpdate.ctx);
	assert.equal(confirmedUpdate.notifications.at(-1)?.[1], "info", confirmedUpdate.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(confirmedUpdate.notifications.at(-1)![0]).version, "v2");
	assert.equal((await current()).factory.management, "unmanaged");

	// Restore names the exact preserved version and the new version it would create.
	const declinedRestore = interactiveFactoryContext(f, { confirm: async (_title, message) => { confirmMessage = message; return false; } });
	await cmd.handler(`restore ${published.factory_id} v1`, declinedRestore.ctx);
	assert.match(confirmMessage, /versioned/);
	assert.match(confirmMessage, /v1/);
	assert.match(confirmMessage, /v3/);
	assert.equal((await current()).factory.current_version, "v2");

	// The confirmed target binds to the version that was current when confirmation was requested: a concurrent publication invalidates it.
	const racing = interactiveFactoryContext(f, {
		confirm: async () => {
			const other = interactiveFactoryContext(f, { editor: async () => JSON.stringify({ draft: draftFor("Raced v3") }) });
			await cmd.handler(`update ${published.factory_id}`, other.ctx);
			assert.equal(other.notifications.at(-1)?.[1], "info", other.notifications.at(-1)?.[0]);
			return true;
		},
	});
	await cmd.handler(`restore ${published.factory_id} v1`, racing.ctx);
	assert.equal(racing.notifications.at(-1)?.[1], "error");
	assert.match(racing.notifications.at(-1)![0], /current version changed from v2 to v3/);
	assert.equal((await current()).factory.current_version, "v3");

	const confirmedRestore = interactiveFactoryContext(f);
	await cmd.handler(`restore ${published.factory_id} v1`, confirmedRestore.ctx);
	assert.equal(confirmedRestore.notifications.at(-1)?.[1], "info", confirmedRestore.notifications.at(-1)?.[0]);
	const restored = JSON.parse(confirmedRestore.notifications.at(-1)![0]);
	assert.equal(restored.version, "v4");
	assert.equal(restored.restored_from_version, "v1");

	// A Bootstrap worker session can never publish, restore or confirm.
	process.argv.push("--bootstrap-worker-config", "/tmp/fake-worker.json");
	try {
		const worker = interactiveFactoryContext(f, { editor: async () => JSON.stringify({ draft: draftFor("Worker v5") }) });
		await cmd.handler(`update ${published.factory_id}`, worker.ctx);
		assert.match(worker.notifications.at(-1)![0], /worker session/i);
		await cmd.handler(`restore ${published.factory_id} v1`, worker.ctx);
		assert.match(worker.notifications.at(-1)![0], /worker session/i);
	} finally {
		process.argv.splice(process.argv.length - 2, 2);
	}
	assert.equal((await current()).factory.current_version, "v4");

	// The model-facing tool is read-only: it cannot update/restore, and may inspect one retained version.
	for (const params of [
		{ action: "update", factory_id: published.factory_id, draft: draftFor("agent") },
		{ action: "restore", factory_id: published.factory_id, from_version: "v1" },
		{ action: "publish", name: "agent", draft: draftFor("agent") },
		{ action: "list", version: "v1" },
		{ action: "receipt", factory_id: published.factory_id, reference: "x", version: "v1" },
		{ action: "inspect", factory_id: published.factory_id, version: "latest" },
	]) {
		const res = await f.call("factory_inspect", params);
		assert.equal(res.isError, true, JSON.stringify(params));
	}
	const historical = (await f.call("factory_inspect", { action: "inspect", factory_id: published.factory_id, version: "v2" })).details.result;
	assert.equal(historical.inspected_version, "v2");
	assert.equal(historical.definition.task, "Confirmed v2");
	assert.equal(historical.factory.current_version, "v4");
	assert.equal(historical.factory.management, "unmanaged");

	await cmd.handler(`inspect ${published.factory_id} v1`, f.ctx);
	assert.equal(JSON.parse(f.notifications.at(-1)![0]).inspected_version, "v1");
});

// ---- factory ticket 04 review: publication of a managed factory belongs to its live owning session ----

/** Two Pi extension instances sharing one factory store, as two Pi sessions on the same machine would. */
function sharedStoreSessions(t: test.TestContext) {
	const saved = process.env.PI_FACTORY_STATE_DIR;
	const store = mkdtempSync(join(tmpdir(), "bootstrap-shared-factory-store-"));
	process.env.PI_FACTORY_STATE_DIR = store;
	t.after(() => {
		if (saved === undefined) delete process.env.PI_FACTORY_STATE_DIR; else process.env.PI_FACTORY_STATE_DIR = saved;
		rmSync(store, { recursive: true, force: true });
	});
	const first = loaded(t);
	const second = loaded(t);
	return { first, second, store };
}

test("operator /factory update and /factory restore of a managed factory need the live owning session: another session, a revoked owner and a mid-command takeover are refused without writing", async t => {
	const { first, second } = sharedStoreSessions(t);
	const published = await publishTestFactory(first, "owned-versions");
	const cmdA = first.commands.get("factory");
	const cmdB = second.commands.get("factory");
	const draftFor = (task: string) => ({
		project_cwd: first.cwd, topology: "graph", task,
		agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }],
	});
	const versions = async () => (await first.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result;
	const owner = interactiveFactoryContext(first, { sessionId: "owner-A", sessionFile: "/tmp/owner-A.jsonl", editor: async () => JSON.stringify({ draft: draftFor("A v2") }) });
	const other = interactiveFactoryContext(second, { sessionId: "other-B", sessionFile: "/tmp/other-B.jsonl", editor: async () => JSON.stringify({ draft: draftFor("B v2") }) });

	// A resumes management of F. B never resumed it, yet its confirmation must not let it publish or restore.
	await cmdA.handler(`resume ${published.factory_id}`, owner.ctx);
	assert.equal(owner.notifications.at(-1)?.[1], "info", owner.notifications.at(-1)?.[0]);
	await cmdB.handler(`update ${published.factory_id}`, other.ctx);
	assert.equal(other.notifications.at(-1)?.[1], "error");
	assert.match(other.notifications.at(-1)![0], /authority/i);
	assert.deepEqual((await versions()).versions.map((v: { version: string }) => v.version), ["v1"]);

	// The owner publishes v2; another session still cannot restore v1 as v3.
	await cmdA.handler(`update ${published.factory_id}`, owner.ctx);
	assert.equal(owner.notifications.at(-1)?.[1], "info", owner.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(owner.notifications.at(-1)![0]).version, "v2");
	await cmdB.handler(`restore ${published.factory_id} v1`, other.ctx);
	assert.equal(other.notifications.at(-1)?.[1], "error");
	assert.match(other.notifications.at(-1)![0], /authority/i);
	assert.equal((await versions()).factory.current_version, "v2");

	// The owner's session is revoked while the editor is open: the command aborts and nothing is written.
	const revokedDuringEditor = interactiveFactoryContext(first, {
		sessionId: "owner-A", sessionFile: "/tmp/owner-A.jsonl",
		editor: async () => {
			await first.hooks.get("session_shutdown")!({ reason: "quit" }, revokedDuringEditor.ctx);
			return JSON.stringify({ draft: draftFor("A after shutdown") });
		},
	});
	await cmdA.handler(`update ${published.factory_id}`, revokedDuringEditor.ctx);
	assert.equal(revokedDuringEditor.notifications.at(-1)?.[1], "error");
	assert.match(revokedDuringEditor.notifications.at(-1)![0], /shut down|authority/i);
	assert.equal((await versions()).factory.current_version, "v2");
	// Once shut down the owner cannot publish or restore at all, and no other session inherits ownership.
	await cmdA.handler(`restore ${published.factory_id} v1`, owner.ctx);
	assert.equal(owner.notifications.at(-1)?.[1], "error");
	assert.match(owner.notifications.at(-1)![0], /shut down|authority/i);
	await cmdB.handler(`restore ${published.factory_id} v1`, other.ctx);
	assert.equal(other.notifications.at(-1)?.[1], "error");
	assert.equal((await versions()).factory.current_version, "v2");
});

test("operator /factory restore re-checks the live owner across confirmation, and a successful owner restore creates one new version", async t => {
	const { first } = sharedStoreSessions(t);
	const published = await publishTestFactory(first, "owner-restore");
	const cmd = first.commands.get("factory");
	const draftFor = (task: string) => ({ project_cwd: first.cwd, topology: "graph", task, agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }] });
	const versions = async () => (await first.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result;
	const owner = interactiveFactoryContext(first, { sessionId: "owner-R", sessionFile: "/tmp/owner-R.jsonl", editor: async () => JSON.stringify({ draft: draftFor("R v2") }) });
	await cmd.handler(`resume ${published.factory_id}`, owner.ctx);
	await cmd.handler(`update ${published.factory_id}`, owner.ctx);
	assert.equal(owner.notifications.at(-1)?.[1], "info", owner.notifications.at(-1)?.[0]);

	// The session binding changes while the confirmation is open: abort without writing.
	let sessionId = "owner-R";
	const rebinding = interactiveFactoryContext(first, { sessionId: "owner-R", sessionFile: "/tmp/owner-R.jsonl" });
	rebinding.ctx.sessionManager.getSessionId = () => sessionId;
	rebinding.ctx.ui.confirm = async () => { sessionId = "owner-R-2"; return true; };
	await cmd.handler(`restore ${published.factory_id} v1`, rebinding.ctx);
	assert.equal(rebinding.notifications.at(-1)?.[1], "error");
	assert.match(rebinding.notifications.at(-1)![0], /binding changed|authority/i);
	assert.equal((await versions()).factory.current_version, "v2");

	// The owner's own confirmed restore succeeds and the factory stays managed.
	const confirmed = interactiveFactoryContext(first, { sessionId: "owner-R", sessionFile: "/tmp/owner-R.jsonl" });
	await cmd.handler(`restore ${published.factory_id} v1`, confirmed.ctx);
	assert.equal(confirmed.notifications.at(-1)?.[1], "info", confirmed.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(confirmed.notifications.at(-1)![0]).version, "v3");
	const after = await versions();
	assert.equal(after.factory.management, "managed");
	assert.equal(after.factory.current_version, "v3");
});

test("operator /factory update of an unmanaged factory needs no authority, but a factory that becomes managed during the editor window is refused", async t => {
	const { first, second } = sharedStoreSessions(t);
	const published = await publishTestFactory(first, "window-factory");
	const draftFor = (task: string) => ({ project_cwd: first.cwd, topology: "graph", task, agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }] });
	const versions = async () => (await first.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result;

	// Unmanaged: explicit human action alone, creating no authority and no management.
	const plain = interactiveFactoryContext(first, { editor: async () => JSON.stringify({ draft: draftFor("Unmanaged v2") }) });
	await first.commands.get("factory").handler(`update ${published.factory_id}`, plain.ctx);
	assert.equal(plain.notifications.at(-1)?.[1], "info", plain.notifications.at(-1)?.[0]);
	assert.equal((await versions()).factory.management, "unmanaged");
	await first.commands.get("factory").handler(`restore ${published.factory_id} v1`, interactiveFactoryContext(first).ctx);
	assert.equal((await versions()).factory.current_version, "v3");
	assert.equal((await versions()).factory.management, "unmanaged");

	// Another session resumes management while this command sits in its editor: the stale unmanaged decision does not publish.
	const racing = interactiveFactoryContext(first, {
		sessionId: "late-A", sessionFile: "/tmp/late-A.jsonl",
		editor: async () => {
			const taker = interactiveFactoryContext(second, { sessionId: "taker-B", sessionFile: "/tmp/taker-B.jsonl" });
			await second.commands.get("factory").handler(`resume ${published.factory_id}`, taker.ctx);
			assert.equal(taker.notifications.at(-1)?.[1], "info", taker.notifications.at(-1)?.[0]);
			return JSON.stringify({ draft: draftFor("Stale v4") });
		},
	});
	await first.commands.get("factory").handler(`update ${published.factory_id}`, racing.ctx);
	assert.equal(racing.notifications.at(-1)?.[1], "error");
	assert.match(racing.notifications.at(-1)![0], /authority/i);
	assert.equal((await versions()).factory.current_version, "v3");
	assert.equal((await versions()).factory.management, "managed");
});

test("unmanaged publication aborts if the initiating Pi session shuts down or changes binding while suspended", async t => {
	const { first } = sharedStoreSessions(t);
	const published = await publishTestFactory(first, "unmanaged-session-lifecycle");
	const cmd = first.commands.get("factory");
	const draftFor = (task: string) => ({ project_cwd: first.cwd, topology: "graph", task, agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }] });
	const current = async () => (await first.call("factory_inspect", { action: "inspect", factory_id: published.factory_id })).details.result.factory.current_version;

	const switched = interactiveFactoryContext(first, { sessionId: "unmanaged-A", sessionFile: "/tmp/unmanaged-A.jsonl" });
	let sessionId = "unmanaged-A";
	switched.ctx.sessionManager.getSessionId = () => sessionId;
	switched.ctx.ui.editor = async () => { sessionId = "unmanaged-B"; return JSON.stringify({ draft: draftFor("must not publish after switch") }); };
	await cmd.handler(`update ${published.factory_id}`, switched.ctx);
	assert.equal(switched.notifications.at(-1)?.[1], "error");
	assert.match(switched.notifications.at(-1)![0], /binding changed/i);
	assert.equal(await current(), "v1");

	const closed = interactiveFactoryContext(first, { sessionId: "unmanaged-C", sessionFile: "/tmp/unmanaged-C.jsonl" });
	closed.ctx.ui.confirm = async () => {
		await first.hooks.get("session_shutdown")!({ reason: "quit" }, closed.ctx);
		return true;
	};
	await cmd.handler(`restore ${published.factory_id} v1`, closed.ctx);
	assert.equal(closed.notifications.at(-1)?.[1], "error");
	assert.match(closed.notifications.at(-1)![0], /shut down/i);
	assert.equal(await current(), "v1");
});

test("exact submit retry survives damaged legacy factory payload and publication targets ignore unrelated broken pointers", async t => {
	const { first, store } = sharedStoreSessions(t);
	const firstFactory = await publishTestFactory(first, "damaged-legacy-receipt");
	const targetFactory = await publishTestFactory(first, "isolated-publication-target");
	const secondFactory = await publishTestFactory(first, "broken-sibling-pointer");
	const cmd = first.commands.get("factory");
	const session = { sessionId: "retry-legacy", sessionFile: "/tmp/retry-legacy.jsonl" };
	const owner = interactiveFactoryContext(first, session);
	await cmd.handler(`resume ${firstFactory.factory_id}`, owner.ctx);
	const acceptedContext = interactiveFactoryContext(first, { ...session, editor: async () => "accepted under v1" });
	await cmd.handler(`submit ${firstFactory.factory_id} Stable-ref`, acceptedContext.ctx);
	const accepted = JSON.parse(acceptedContext.notifications.at(-1)![0]);
	assert.equal(acceptedContext.notifications.at(-1)?.[1], "info");
	const draftFor = (task: string) => ({ project_cwd: first.cwd, topology: "graph", task, agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }] });
	const upgrade = interactiveFactoryContext(first, { ...session, editor: async () => JSON.stringify({ draft: draftFor("v2 before damage") }) });
	await cmd.handler(`update ${targetFactory.factory_id}`, upgrade.ctx);
	assert.equal(upgrade.notifications.at(-1)?.[1], "info", upgrade.notifications.at(-1)?.[0]);

	const raw = new DatabaseSync(join(store, "factories.sqlite"));
	try {
		raw.prepare("UPDATE factories SET definition = ? WHERE factory_id = ?").run("{damaged", firstFactory.factory_id);
		raw.prepare("DELETE FROM factory_pointers WHERE factory_id = ?").run(secondFactory.factory_id);
	} finally { raw.close(); }

	const retry = interactiveFactoryContext(first, { ...session, editor: async () => "accepted under v1" });
	await cmd.handler(`submit ${firstFactory.factory_id} Stable-ref`, retry.ctx);
	assert.equal(retry.notifications.at(-1)?.[1], "info", retry.notifications.at(-1)?.[0]);
	assert.equal(JSON.parse(retry.notifications.at(-1)![0]).input_id, accepted.input_id);

	const coordinationDir = join(first.home, ".pi", "agent");
	mkdirSync(coordinationDir, { recursive: true });
	writeFileSync(join(coordinationDir, "factory-coordination.sqlite"), "not a sqlite database");
	for (const action of [`update ${targetFactory.factory_id}`, `restore ${targetFactory.factory_id} v1`]) {
		const publication = interactiveFactoryContext(first, { ...session, editor: async () => JSON.stringify({ draft: draftFor("target A update") }) });
		await cmd.handler(action, publication.ctx);
		assert.equal(publication.notifications.at(-1)?.[1], "info", publication.notifications.at(-1)?.[0]);
	}
});

test("/factory submit retry of an accepted reference is not pre-blocked by damaged current version metadata, while a changed brief conflicts and fresh work fails closed", async t => {
	const { first, store } = sharedStoreSessions(t);
	const published = await publishTestFactory(first, "retry-public-route");
	const cmd = first.commands.get("factory");
	const draftFor = (task: string) => ({ project_cwd: first.cwd, topology: "graph", task, agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review changes" }] });
	const session = { sessionId: "owner-retry", sessionFile: "/tmp/owner-retry.jsonl" };
	const owner = interactiveFactoryContext(first, { ...session, editor: async () => "queued under v1" });
	await cmd.handler(`resume ${published.factory_id}`, owner.ctx);
	await cmd.handler(`submit ${published.factory_id} Ref-Old`, owner.ctx);
	assert.equal(owner.notifications.at(-1)?.[1], "info", owner.notifications.at(-1)?.[0]);
	const original = JSON.parse(owner.notifications.at(-1)![0]);
	const publisher = interactiveFactoryContext(first, { ...session, editor: async () => JSON.stringify({ draft: draftFor("v2") }) });
	await cmd.handler(`update ${published.factory_id}`, publisher.ctx);
	assert.equal(publisher.notifications.at(-1)?.[1], "info", publisher.notifications.at(-1)?.[0]);

	// Only the current version's definition row is lost; the pointer and v1 stay intact.
	const raw = new DatabaseSync(join(store, "factories.sqlite"));
	try { raw.prepare("DELETE FROM factory_versions WHERE factory_id = ? AND version = 'v2'").run(published.factory_id); } finally { raw.close(); }

	const retry = interactiveFactoryContext(first, { ...session, editor: async () => "queued under v1" });
	await cmd.handler(`submit ${published.factory_id} Ref-Old`, retry.ctx);
	assert.equal(retry.notifications.at(-1)?.[1], "info", retry.notifications.at(-1)?.[0]);
	const recovered = JSON.parse(retry.notifications.at(-1)![0]);
	assert.equal(recovered.input_id, original.input_id);
	assert.equal(recovered.bound_version, "v1");
	assert.equal(recovered.brief, "queued under v1");
	const viaTool = await first.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, reference: "Ref-Old" });
	assert.deepEqual(viaTool.details.result, recovered, "the read-only receipt route returns the same receipt");

	const changed = interactiveFactoryContext(first, { ...session, editor: async () => "a different brief" });
	await cmd.handler(`submit ${published.factory_id} Ref-Old`, changed.ctx);
	assert.equal(changed.notifications.at(-1)?.[1], "error");
	assert.match(changed.notifications.at(-1)![0], /Submission conflict/);
	const fresh = interactiveFactoryContext(first, { ...session, editor: async () => "new work" });
	await cmd.handler(`submit ${published.factory_id} Ref-New`, fresh.ctx);
	assert.equal(fresh.notifications.at(-1)?.[1], "error");
	assert.match(fresh.notifications.at(-1)![0], /missing retained version v2/);
	const missing = await first.call("factory_inspect", { action: "receipt", factory_id: published.factory_id, reference: "Ref-New" });
	assert.equal(missing.isError, true);
});
