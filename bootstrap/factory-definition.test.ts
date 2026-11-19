import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
		[{ agents: [{ ...draft.agents[0], required_checks: [" smoke "] }] }, /required_checks.*whitespace|whitespace.*required_checks/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_checks: [" smoke "] } }] }, /required_checks.*whitespace|whitespace.*required_checks/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: ["../outside.txt"] } }] }, /required_artifact_paths.*escapes project_cwd/i],
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
	for (const [index, [invalid, diagnosis]] of cases.entries()) {
		assert.throws(() => open()({ action: "publish", name: `quality-${index}`, draft: { ...draft, ...invalid }, sessionModel }), diagnosis);
	}
	assert.throws(() => open()({ action: "publish", name: "Quality", draft, sessionModel }), /already published/);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.deepEqual(configs, []);
});

test("standalone plan preview works when its session parent is not writable", t => {
	const { draft, cwd, service } = fixture(t);
	const sessions = join(cwd, ".pi", "agent-sessions");
	mkdirSync(sessions);
	const original = statSync(sessions).mode;
	try {
		chmodSync(sessions, 0o500);
		assert.doesNotThrow(() => service.plan(draft, sessionModel));
	} finally {
		chmodSync(sessions, original);
	}
});

test("publication accepts an in-scope required artifact path before the output exists", t => {
	const { open, draft, cwd } = fixture(t);
	const future = join(cwd, "out", "report.json");
	draft.agents[0].output_contract = { required_artifact_paths: [future] };
	const receipt = open()({ action: "publish", name: "future-output", draft, sessionModel });
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.output_contract?.required_artifact_paths?.[0], future);
});

test("publication rejects impossible routed contracts and leaves the current v1 unchanged", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const invalid = structuredClone(draft);
	invalid.agents.push({
		persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"],
		decision: { field: "verdict", approve: "yes", reject: "no", on_reject: "build" },
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["yes", "no"], min_length: 4 } } },
	});
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.throws(() => open()({ action: "publish", name: "other", draft: invalid, sessionModel }), /verdict.*(min_length|satisfying)|decision.*contract/i);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
});

test("version-zero stores with any existing schema object are reported as corrupt", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const db = new DatabaseSync(database);
	try { db.exec("DROP TABLE factories; CREATE VIEW prior_evidence AS SELECT 123; PRAGMA user_version = 0"); } finally { db.close(); }
	assert.throws(() => open()({ action: "list" }), /corrupt|schema|version/i);
	assert.throws(() => open()({ action: "inspect", factory_id: receipt.factory_id }), /corrupt|schema|version/i);
});

test("publication rejects required array lengths beyond JavaScript's representable array length", t => {
	const { open, draft } = fixture(t);
	const invalid = structuredClone(draft);
	invalid.agents[0].output_contract = { required_fields: ["items"], properties: { items: { type: "array", min_length: 4294967296 } } };
	assert.throws(() => open()({ action: "publish", name: "impossible-array", draft: invalid, sessionModel }), /items.*(length|represent|possible|satisfy)/i);
});

test("publication rejects an unsatisfiable ordinary required output field", t => {
	const { open, draft } = fixture(t);
	const invalid = structuredClone(draft);
	invalid.agents[0].output_contract = { required_fields: ["answer"], properties: { answer: { type: "string", enum: ["yes"], min_length: 4 } } };
	assert.throws(() => open()({ action: "publish", name: "impossible", draft: invalid, sessionModel }), /build.*answer.*(impossible|satisfy|enum|length)/i);
});

test("inspection detects valid-JSON payload corruption in the real SQLite store", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const db = new DatabaseSync(database);
	try { db.prepare("UPDATE factories SET definition = replace(definition, 'Build the change', 'Altered the change') WHERE factory_id = ?").run(receipt.factory_id); }
	finally { db.close(); }
	assert.throws(() => open()({ action: "inspect", factory_id: receipt.factory_id }), /corrupt|digest/i);
});

test("publication refuses a symlinked state directory before creating a database", t => {
	const { open, draft, root, service } = fixture(t);
	const canonical = join(root, "canonical");
	mkdirSync(canonical);
	const alias = join(root, "alias");
	symlinkSync(canonical, alias);
	const path = join(alias, "new", "factories.sqlite");
	assert.throws(() => factoryOperations(path, service)({ action: "publish", name: "quality", draft, sessionModel }), /symlink/i);
	assert.equal(existsSync(join(canonical, "new")), false);
});

test("publication refuses a symlinked database file without opening its target", t => {
	const { draft, root, service } = fixture(t);
	const target = join(root, "target.sqlite");
	writeFileSync(target, "preserve this file");
	const link = join(root, "linked.sqlite");
	symlinkSync(target, link);
	assert.throws(() => factoryOperations(link, service)({ action: "publish", name: "quality", draft, sessionModel }), /symlink/i);
	assert.equal(readFileSync(target, "utf8"), "preserve this file");
});

test("publication syncs newly created nested storage directory entries", t => {
	const { open, draft, root, service } = fixture(t);
	const nested = join(root, "new", "deep", "state", "factories.sqlite");
	const publish = factoryOperations(nested, service);
	const receipt = publish({ action: "publish", name: "quality", draft, sessionModel });
	assert.deepEqual(factoryOperations(nested, service)({ action: "inspect", factory_id: receipt.factory_id }).factory, receipt);
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

test("publication accepts Pi's max thinking level", t => {
	const { open, draft, cwd } = fixture(t);
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nmodel: test-provider/test-model:max\n---\nPrompt\n");
	const receipt = open()({ action: "publish", name: "max-thinking", draft, sessionModel });
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].thinking, "max");
});

test("publication rejects an explicit model whose effective thinking level cannot be frozen", t => {
	const { open, draft, cwd } = fixture(t);
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nmodel: test-provider/other-model#variant\n---\nPrompt\n");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), /no valid resolved thinking level/i);
});

test("publication refuses a known non-directory managed session path", t => {
	const { open, draft, cwd } = fixture(t);
	const sessions = join(cwd, ".pi", "agent-sessions");
	writeFileSync(sessions, "not a directory");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), error => String(error).includes(sessions));
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
	const recovered = open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0];
	assert.equal(recovered.node.sub_task, instruction);
	assert.equal(recovered.thinking, "medium");

	const interrupted = await run("another", "before_commit");
	assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
	assert.equal(interrupted.stdout, "");
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.ok(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.sub_task === instruction);
});
