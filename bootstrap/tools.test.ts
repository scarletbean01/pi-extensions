import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Pi supplies TypeBox at runtime; the tool layer only needs its schema constructors here (the runtime suite loads the real package).
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

/** Load the extension against a recording stub of Pi's API, with a project that has one persona. */
function loaded(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-tools-test-"));
	const cwd = join(root, "project");
	const bin = join(root, "bin");
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read\n---\nReview carefully.\n");
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["pi", "herdr"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const saved = { PATH: process.env.PATH, state: process.env.PI_BOOTSTRAP_STATE_DIR };
	process.env.PATH = bin;
	process.env.PI_BOOTSTRAP_STATE_DIR = join(root, "state");
	t.after(() => {
		process.env.PATH = saved.PATH;
		if (saved.state === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR; else process.env.PI_BOOTSTRAP_STATE_DIR = saved.state;
		rmSync(root, { recursive: true, force: true });
	});
	const tools = new Map<string, any>();
	registerBootstrap({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as any);
	const ctx = { cwd, model: { provider: "provider", id: "model" } };
	return { cwd, tools, call: (name: string, params: unknown) => tools.get(name).execute("call-1", params, undefined, undefined, ctx) };
}

const text = (result: any) => result.content.map((part: any) => part.text).join("\n");

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
	assert.match(JSON.stringify(generate.parameters), /"dependency_policy"[\s\S]*"required_checks"[\s\S]*"checks"/);
	assert.match(f.tools.get("bootstrap_status").description, /pending, waiting, running, succeeded, partial, failed, blocked, skipped, cancelled or needs_attention/);
	assert.match(f.tools.get("bootstrap_report").description, /did not execute.*blocked.*cannot be given a result/);
});

test("a dry run shows each dependency's policy and the checks a node declares", async t => {
	const f = loaded(t);
	const agents = [{ node_id: "build", persona: "reviewer", sub_task: "Build", checks: [{ name: "tests", command: "npm test", scope: ["src"] }] }, { node_id: "ship", persona: "reviewer", sub_task: "Ship", required_checks: ["tests"] }];
	const modern = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents });
	assert.match(text(modern), /a2-ship \(step 2\): node ship, persona reviewer from .*\n  model .*\n  a1-build → a2-ship → dispatcher\n  dependency: require_success; requires checks tests/);
	assert.match(text(modern), /a1-build \(step 1\).*\n.*\n.*\n  checks: tests \(npm test; scope src\)/);
	const legacy = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents: [{ name: "reviewer", sub_task: "a" }].concat([]) });
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
