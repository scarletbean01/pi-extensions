import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
