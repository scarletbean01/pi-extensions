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
	const commands = new Map<string, any>();
	registerBootstrap({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as any);
	const ctx = { cwd, model: { provider: "provider", id: "model" } };
	return { cwd, tools, commands, call: (name: string, params: unknown) => tools.get(name).execute("call-1", params, undefined, undefined, ctx) };
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
	assert.match(JSON.stringify(generate.parameters), /"dependency_policy"/);
	assert.match(generate.description, /required_checks are also what its dependent needs.*missing, failed, unverified and stale evidence each block it/);
	assert.match(f.tools.get("bootstrap_status").description, /pending, waiting, running, succeeded, partial, failed, blocked, skipped, cancelled or needs_attention/);
	assert.match(f.tools.get("bootstrap_report").description, /did not execute.*blocked.*cannot be given a result/);
});

test("a dry run shows each dependency's policy", async t => {
	const f = loaded(t);
	const agents = [{ node_id: "build", persona: "reviewer", sub_task: "Build", required_checks: ["tests"] }, { node_id: "ship", persona: "reviewer", sub_task: "Ship" }];
	const modern = await f.call("bootstrap_generate", { topology: "chain", task: "Release", project_cwd: f.cwd, dry_run: true, agents });
	assert.match(text(modern), /a2-ship \(step 2\): node ship, persona reviewer from .*\n  model .*\n  a1-build → a2-ship → dispatcher\n  dependency: require_success\n  task: Ship/);
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
