import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { factoryOperations } from "../factory/operations.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

function fixture(t: test.TestContext) {
	const run = serviceFixture(t);
	const database = join(run.root, "factory.sqlite");
	const open = () => factoryOperations(database, run.service);
	const draft: GenerateRequest = {
		project_cwd: run.cwd, topology: "graph", task: "Test changes",
		agents: [{ persona: "first", node_id: "build", sub_task: "Build the change" }],
	};
	return { ...run, draft, database, open };
}

test("explicit publication makes a complete v1 discoverable by a stable ID without launching", t => {
	const { open, draft, configs } = fixture(t);
	assert.deepEqual(open()({ action: "list" }), []);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	assert.match(receipt.factory_id, /^[a-f0-9-]{36}$/);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.equal(receipt.current_version, "v1");
	assert.equal(receipt.management, "unmanaged");
	const saved = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.deepEqual(saved.factory, receipt);
	assert.equal(saved.definition.project_cwd, draft.project_cwd);
	assert.equal(saved.definition.agents[0].node.sub_task, "Build the change");
	assert.equal(saved.definition.agents[0].system_prompt, "Exact persona first");
	assert.deepEqual(configs, []);
});

test("publication rejects invalid executable definitions without touching the current version", t => {
	const { open, draft, configs } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	const decision = { field: "verdict", approve: "yes", reject: "no", on_reject: "build" };
	const review = {
		persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"], decision,
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["yes", "no"] } } },
	};
	const cases: Array<[Partial<GenerateRequest>, RegExp]> = [
		[{ agents: [{ ...draft.agents[0], depends_on: ["missing"] }] }, /Unknown dependency "missing" for node build/],
		[{ agents: [{ ...draft.agents[0], depends_on: ["review"] }, review] }, /Dependency cycle.*build.*review/],
		[{ agents: [{ ...draft.agents[0], required_checks: [" "] }] }, /required_checks for build/],
		[{ agents: [draft.agents[0], { ...review, output_contract: {} }] }, /decision for review.*output_contract/],
		[{ agents: [draft.agents[0], { ...review, decision: { ...decision, on_reject: "review" } }] }, /decision for review.*strict ancestor/],
		[{ agents: [draft.agents[0], { ...review, decision: { ...decision, max_revisions: 11 } }] }, /max_revisions for review/],
		[{ agents: [draft.agents[0], review], max_total_attempts: 1 }, /max_total_attempts.*first attempt/],
		[{ agents: [{ ...draft.agents[0], persona: "missing" }] }, /build.*missing/],
		[{ project_cwd: join(draft.project_cwd, "missing") }, /project_cwd.*missing/],
		[{ coms_extension: "missing.ts" }, /Required Coms extension not found.*missing.ts/],
		[{ task_timeout_ms: -1 }, /task_timeout_ms/],
		[{ agents: [{ ...draft.agents[0], depends_onn: ["missing"] } as GenerateRequest["agents"][number]] }, /build.*depends_onn/],
	];
	for (const [invalid, diagnosis] of cases) {
		assert.throws(() => open()({ action: "publish", name: "quality", draft: { ...draft, ...invalid }, sessionModel }), diagnosis);
	}
	assert.throws(() => open()({ action: "publish", name: "Quality", draft, sessionModel }), /already published/);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.deepEqual(configs, []);
});

test("a lost post-commit acknowledgement is reported as uncertain and inspection recovers the durable factory ID", t => {
	const { open, draft, database, service } = fixture(t);
	const interrupted = factoryOperations(database, service, phase => {
		if (phase === "after_commit") throw new Error("simulated acknowledgement loss");
	});
	assert.throws(() => interrupted({ action: "publish", name: "quality", draft, sessionModel }), /outcome uncertain.*inspect with \/factory list/);
	const [receipt] = open()({ action: "list" });
	assert.ok(receipt.factory_id);
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.task, "Test changes");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), /already published/);
});

test("inspection preserves resolved settings even after the draft, persona, aliases and defaults change", t => {
	const { open, draft, cwd } = fixture(t);
	const persona = join(cwd, ".pi", "agents", "second.md");
	const config = join(cwd, ".pi", "bootstrap.json");
	const extension = join(cwd, "extensions", "extra.ts");
	writeFileSync(extension, "export default function () {}\n");
	writeFileSync(persona, "---\nmodel: reviewer\nskills:\nextensions: extra\n---\nPreserved review prompt\n");
	writeFileSync(config, JSON.stringify({
		modelAliases: { reviewer: { model: "test-provider/review-model", thinking: "high" } },
		graph: { defaults: { maxRevisions: 2, maxTotalAttempts: 5 } },
	}));
	draft.agents.push({
		persona: "second", node_id: "review", sub_task: "Check the change\nPreserve this line", depends_on: ["build"], required_checks: ["deterministic"],
		decision: { field: "verdict", approve: "yes", reject: "no", on_reject: "build" },
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["yes", "no"] } } },
	});
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	draft.agents[1].sub_task = "Edited draft";
	writeFileSync(persona, "Edited persona");
	writeFileSync(config, "not valid JSON");
	const { definition } = open()({ action: "inspect", factory_id: receipt.factory_id });
	const [build, review] = definition.agents;
	assert.equal(definition.goal, "Test changes");
	assert.equal(definition.cleanup, "on_success");
	assert.equal(definition.ready_timeout_ms, 60_000);
	assert.equal(definition.dependency_wait_timeout_ms, 300_000);
	assert.equal(definition.max_total_attempts, 5);
	assert.equal(build.model, "test-provider/test-model");
	assert.equal(build.thinking, "medium");
	assert.deepEqual(build.tools, { mode: "declared", names: ["read", "bash"] });
	assert.deepEqual(build.skills, { mode: "inherit" });
	assert.equal(review.system_prompt, "Preserved review prompt");
	assert.equal(review.model, "test-provider/review-model");
	assert.equal(review.thinking, "high");
	assert.deepEqual(review.tools, { mode: "inherit" });
	assert.deepEqual(review.skills, { mode: "declared", names: [] });
	assert.deepEqual(review.extensions, { mode: "inherit_with_additions", declared: ["extra"], paths: [extension] });
	assert.equal(review.node.sub_task, "Check the change\nPreserve this line");
	assert.deepEqual(review.node.inbound_edges, ["build"]);
	assert.deepEqual(review.node.required_checks, ["deterministic"]);
	assert.deepEqual(review.node.output_contract?.properties?.verdict.enum, ["yes", "no"]);
	assert.equal(review.decision?.max_revisions, 2);
	assert.deepEqual(review.decision?.loop_body, ["build", "review"]);
});

test("a killed publisher exposes no partial v1, but a committed v1 survives a lost acknowledgement", async t => {
	const { root, open, draft, database } = fixture(t);
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
	mkdirSync(join(iso.agentDir, "agents"));
	writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
	const draftFile = join(root, "draft.json");
	// Exercise real database pages, not just a tiny insert held in SQLite's cache.
	const instruction = "x".repeat(3 * 1024 * 1024) + "\nEnd of assignment";
	writeFileSync(draftFile, JSON.stringify({ ...draft, agents: [{ ...draft.agents[0], sub_task: instruction }] }));
	const run = (name: string, phase: string) => runSupervised(process.execPath, [child, database, draftFile, name, phase], {
		env: { ...iso.env, PATH: join(root, "bin") }, timeoutMs: 10_000,
	});
	const before = await run("quality", "before_commit");
	assert.equal(before.signal, "SIGKILL", before.stderr);
	assert.equal(before.stdout, "");
	assert.deepEqual(open()({ action: "list" }), []);

	const after = await run("quality", "after_commit");
	assert.equal(after.signal, "SIGKILL", after.stderr);
	assert.equal(after.stdout, "");
	const [receipt] = open()({ action: "list" });
	assert.equal(receipt.current_version, "v1");
	assert.equal(receipt.management, "unmanaged");
	assert.ok(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.sub_task === instruction);

	const interrupted = await run("another", "before_commit");
	assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
	assert.equal(interrupted.stdout, "");
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.ok(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.sub_task === instruction);
});
