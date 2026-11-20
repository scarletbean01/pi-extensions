import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";
import { BootstrapService, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, coordAnchorPath, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { isolatedPiEnvironment, runSupervised, spawnGroup } from "./test-harness.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

function launchFixture(t: test.TestContext) {
	const run = serviceFixture(t, ["builder", "reviewer"]);
	const database = join(run.root, "factories.sqlite");
	const coordDatabase = join(run.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(database, run.service, { coordinationPath: coordDatabase });
	return { ...run, database, coordDatabase, open };
}

test("Slice 1: receipt -> FIFO launch uses retained definition, preserves exact brief in task_input, and inspects read-only", async t => {
	const { root, cwd, home, service, configs, open } = launchFixture(t);
	const extPath = join(cwd, "extensions", "custom-helper.ts");
	writeFileSync(extPath, "export default function () {}\n");
	writeFileSync(
		join(cwd, ".pi", "agents", "builder.md"),
		`---\nname: builder\ntools: read,bash\nskills: alpha, beta\nextensions: custom-helper\nmodel: buildalias\n---\nRetained builder prompt.\n`,
	);
	writeFileSync(
		join(cwd, ".pi", "agents", "reviewer.md"),
		`---\nname: reviewer\ntools: read\nskills:\nmodel: test-provider/review-v1:high\n---\nRetained reviewer prompt.\n`,
	);
	writeFileSync(join(cwd, ".pi", "bootstrap.json"), JSON.stringify({
		modelAliases: { buildalias: { model: "provider/model", thinking: "low" } },
		graph: { defaults: { maxRevisions: 2 } },
	}));

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Factory quality pipeline",
		goal: "Validate retained graph execution",
		agents: [
			{ persona: "builder", node_id: "build", sub_task: "Implement the requested change", write_paths: ["src/**"] },
			{
				persona: "reviewer",
				node_id: "review",
				depends_on: ["build"],
				sub_task: "Review implementation",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "reject"] } } },
				decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "build" },
			},
		],
	};

	const factory = open()({ action: "publish", name: "quality", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-1", pi_session_file: join(root, "mgr-1.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority: auth });

	const longExactBrief =
		"  leading spaces\r\n\tindented line\rline3\ncafé e\u0301 🚀\n"
		+ "Literal path src/app.ts and #999 [paste #1 50 chars]\n"
		+ `${"detail-segment-".repeat(220)}\n`
		+ "trailing spaces  \n\n";
	assert.ok(Buffer.byteLength(longExactBrief, "utf8") > 3000);
	const secondBrief = "Second queued brief";

	const r1 = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-1", brief: longExactBrief, authority: auth });
	const r2 = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-2", brief: secondBrief, authority: auth });
	assert.equal(r1.queue_position, 1);
	assert.equal(r2.queue_position, 2);

	// Mutate persona files, model aliases, and graph defaults AFTER admission!
	// Retained v1 definition must still be used verbatim without re-resolving.
	writeFileSync(
		join(cwd, ".pi", "agents", "builder.md"),
		`---\nname: builder\ntools: write\nskills: gamma\nmodel: test-provider/mutated\nthinking: xhigh\n---\nMUTATED builder prompt.\n`,
	);
	writeFileSync(join(cwd, ".pi", "bootstrap.json"), JSON.stringify({
		modelAliases: { buildalias: { model: "test-provider/mutated-alias", thinking: "xhigh" } },
		graph: { defaults: { maxRevisions: 1 } },
	}));

	const launched = await open()({ action: "launch", factory_id: factory.factory_id, authority: auth });
	assert.equal(launched.factory_id, factory.factory_id);
	assert.equal(launched.input_id, r1.input_id);
	assert.equal(launched.bound_version, "v1");
	assert.match(launched.attempt_id, /^att-/);
	assert.ok(launched.request_id.length > 0);
	assert.ok(launched.task_id.length > 0);
	assert.equal(launched.manifest.status, "applied");
	assert.equal(launched.manifest.phase, "released");
	assert.equal(launched.manifest.workspace_id, "origin-workspace");

	// Verify retained definition fields in spawned worker configs.
	assert.equal(configs.length, 2);
	const buildCfg = configs.find(c => c.node_id === "build")!;
	const reviewCfg = configs.find(c => c.node_id === "review")!;
	assert.equal(buildCfg.persona, "Retained builder prompt.");
	assert.equal(buildCfg.expected_model, "provider/model");
	assert.deepEqual(buildCfg.tools, ["read", "bash"]);
	assert.equal(buildCfg.review_plan?.loops[0].max_revisions, 2);
	assert.equal(reviewCfg.persona, "Retained reviewer prompt.");
	assert.equal(reviewCfg.expected_model, "test-provider/review-v1");
	assert.deepEqual(reviewCfg.tools, ["read"]);

	// Real worker behavior: prompt carries bounded excerpt + pointer (NOT entire >3KB brief),
	// while bootstrap_read_input({ kind: "task_input" }) retrieves the exact verbatim brief.
	const w1 = workerFromConfig(t, join(launched.manifest.session_dir, `${buildCfg.instance_id}.config.json`));
	await w1.start();
	const promptEvent = await w1.beforeStart();
	assert.ok(promptEvent?.systemPrompt, "Root worker should receive authoritative prompt after release");
	assert.ok(!promptEvent.systemPrompt.includes("trailing spaces  \n\n"), "Long brief tail must be truncated in prompt");
	assert.match(promptEvent.systemPrompt, /bootstrap_read_input\(\{\s*kind:\s*"task_input"\s*\}\)/);

	const taskInputRead = await w1.readInput({ kind: "task_input" });
	assert.equal(taskInputRead.isError, undefined);
	const parsedInput = JSON.parse(taskInputRead.details.text);
	assert.equal(parsedInput.brief.submitted_brief, longExactBrief);

	// Read-only inspect and receipt expose exact association, bound version, capacity, and run status without secrets.
	const inspected = open()({ action: "inspect", factory_id: factory.factory_id });
	assert.equal(inspected.capacity.factory_slot, "held");
	assert.equal(inspected.capacity.checkout_slot, "held");
	assert.equal(inspected.capacity.blocking_hold?.attempt_id, launched.attempt_id);
	assert.equal(inspected.capacity.blocking_hold?.task_id, launched.task_id);
	assert.equal(inspected.attempts.length, 1);
	assert.equal(inspected.attempts[0].input_id, r1.input_id);
	assert.equal(inspected.attempts[0].request_id, launched.request_id);
	assert.equal(inspected.attempts[0].task_id, launched.task_id);
	assert.equal(inspected.attempts[0].release_authorized, true);
	assert.equal(inspected.head_status.eligible, false);
	assert.equal(inspected.head_status.blocking_kind, "factory_held");
	assert.equal(JSON.stringify(inspected).includes("mgr-1"), false);

	const r1After = open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-1" });
	assert.equal(r1After.attempt?.attempt_id, launched.attempt_id);
	assert.equal(r1After.attempt?.request_id, launched.request_id);
	assert.equal(r1After.attempt?.task_id, launched.task_id);

	// Cannot launch a second time while factory/checkout holds are active; queue position 2 is never skipped ahead.
	await assert.rejects(
		() => open()({ action: "launch", factory_id: factory.factory_id, authority: auth }),
		/held|occupied|capacity/i,
	);
	const r2After = open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-2" });
	assert.equal(r2After.disposition, "queued");
	assert.equal(r2After.attempt, undefined);
});

test("Slice 1b: live ceiling / missing prerequisite blocks FIFO head without taking holds or skipping to input #2", async t => {
	const { root, cwd, open } = launchFixture(t);
	writeFileSync(join(cwd, ".pi", "bootstrap.json"), JSON.stringify({
		graph: { defaults: { maxRevisions: 3 } },
	}));
	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Ceiling test",
		agents: [
			{ persona: "builder", node_id: "build", sub_task: "Build" },
			{
				persona: "reviewer",
				node_id: "review",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "reject"] } } },
				decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "build" },
			},
		],
	};
	const factory = open()({ action: "publish", name: "ceiling-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-ceil" });
	open()({ action: "resume", factory_id: factory.factory_id, authority: auth });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "Head-1", brief: "First", authority: auth });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "Next-2", brief: "Second", authority: auth });

	// Lower live ceiling below retained max_revisions (3).
	writeFileSync(join(cwd, ".pi", "bootstrap.json"), JSON.stringify({
		graph: { ceilings: { maxRevisions: 1 } },
	}));

	await assert.rejects(
		() => open()({ action: "launch", factory_id: factory.factory_id, authority: auth }),
		/ceiling/i,
	);

	// No holds taken, head remains queued at position 1, input #2 not launched.
	const inspected = open()({ action: "inspect", factory_id: factory.factory_id });
	assert.equal(inspected.capacity.factory_slot, "free");
	assert.equal(inspected.capacity.checkout_slot, "free");
	assert.equal(inspected.attempts.length, 0);
	assert.equal(inspected.head_status.eligible, false);
	assert.equal(inspected.head_status.blocking_kind, "ceiling");
	assert.equal(inspected.queue[0].disposition, "queued");
	assert.equal(inspected.queue[1].disposition, "queued");
});

test("Slice 2: concurrent equivalent-checkout launches across symlink aliases and separate state roots contend atomically while different checkouts and standalone proceed", async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const root = iso.root;
	const extensionDir = join(fileURLToPath(new URL("..", import.meta.url)));
	const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));

	const bin = join(root, "bin");
	const repoA = join(root, "repo-a");
	const repoAAlias = join(root, "repo-a-alias");
	const repoB = join(root, "repo-b");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	for (const repo of [repoA, repoB]) {
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
	}
	symlinkSync(repoA, repoAAlias);

	// Separate PI_FACTORY_STATE_DIR and separate PI_BOOTSTRAP_STATE_DIR roots!
	const factoryState1 = join(root, "factory-state-1");
	const factoryState2 = join(root, "factory-state-2");
	const factoryState3 = join(root, "factory-state-3");
	const bsState1 = join(root, "bs-state-1");
	const bsState2 = join(root, "bs-state-2");
	const bsState3 = join(root, "bs-state-3");
	const db1 = join(factoryState1, "factories.sqlite");
	const db2 = join(factoryState2, "factories.sqlite");
	const db3 = join(factoryState3, "factories.sqlite");

	// Omit PI_FACTORY_COORDINATION_DIR so production host-wide coordination domain (via OS account home) is exercised!
	const baseEnv = { ...iso.env, PATH: bin };
	delete (baseEnv as Record<string, unknown>).PI_FACTORY_COORDINATION_DIR;
	const makeSvc = (stateDir: string) => new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir, stateDir, home: iso.home, env: baseEnv });

	const f1 = factoryOperations(db1, makeSvc(bsState1))({
		action: "publish",
		name: "fac-canonical",
		draft: { project_cwd: repoA, topology: "graph", task: "Canonical", agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }] },
		sessionModel,
	});
	const f2 = factoryOperations(db2, makeSvc(bsState2))({
		action: "publish",
		name: "fac-alias",
		draft: { project_cwd: repoAAlias, topology: "graph", task: "Alias", agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }] },
		sessionModel,
	});
	const f3 = factoryOperations(db3, makeSvc(bsState3))({
		action: "publish",
		name: "fac-other-checkout",
		draft: { project_cwd: repoB, topology: "graph", task: "Other", agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }] },
		sessionModel,
	});
	assert.equal(f2.current_version, "v1");
	assert.equal(realpathSync(repoAAlias), realpathSync(repoA));

	const tabsLog = join(root, "tabs.log");
	const ready1 = join(root, "r1");
	const ready2 = join(root, "r2");
	const go = join(root, "go");

	const g1 = spawnGroup(process.execPath, [childScript, JSON.stringify({
		mode: "race-launch",
		database: db1,
		factoryId: f1.factory_id,
		projectCwd: repoA,
		stateDir: bsState1,
		home: iso.home,
		bin,
		workspaceId: "ws-1",
		tabsLog,
		readyFile: ready1,
		goFile: go,
		holdCreateMs: 120,
	})], { env: { ...baseEnv, PI_FACTORY_STATE_DIR: factoryState1, PI_BOOTSTRAP_STATE_DIR: bsState1 } });
	const g2 = spawnGroup(process.execPath, [childScript, JSON.stringify({
		mode: "race-launch",
		database: db2,
		factoryId: f2.factory_id,
		projectCwd: repoAAlias,
		stateDir: bsState2,
		home: iso.home,
		bin,
		workspaceId: "ws-2",
		tabsLog,
		readyFile: ready2,
		goFile: go,
		holdCreateMs: 120,
	})], { env: { ...baseEnv, PI_FACTORY_STATE_DIR: factoryState2, PI_BOOTSTRAP_STATE_DIR: bsState2 } });
	t.after(async () => { await g1.stop(); await g2.stop(); });

	let out1 = "", out2 = "", err1 = "", err2 = "";
	g1.child.stdout.on("data", d => { out1 += d.toString(); });
	g2.child.stdout.on("data", d => { out2 += d.toString(); });
	g1.child.stderr.on("data", d => { err1 += d.toString(); });
	g2.child.stderr.on("data", d => { err2 += d.toString(); });

	const deadline = Date.now() + 8000;
	while ((!existsSync(ready1) || !existsSync(ready2)) && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(existsSync(ready1) && existsSync(ready2), "racing launch children did not become ready");
	writeFileSync(go, "go");

	const [r1, r2] = await Promise.all([g1.closed, g2.closed]);
	assert.deepEqual([r1.code, r2.code].sort(), [0, 1], `Expected 1 winner and 1 loser: r1=${r1.code}(${err1}) r2=${r2.code}(${err2})`);

	const winnerOut = JSON.parse(r1.code === 0 ? out1 : out2);
	const loserErr = r1.code === 1 ? err1 : err2;
	const loserDb = r1.code === 1 ? db1 : db2;
	const loserFactoryId = r1.code === 1 ? f1.factory_id : f2.factory_id;
	const loserStateDir = r1.code === 1 ? bsState1 : bsState2;

	assert.match(loserErr, /held|checkout/i);
	assert.equal(winnerOut.launched.manifest.status, "applied");

	// Only 1 run's tabs were created on repoA; loser created 0 tabs and took no factory hold.
	const loggedTabs = readFileSync(tabsLog, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(loggedTabs.length, 1);

	const loserInspected = factoryOperations(loserDb, makeSvc(loserStateDir))({ action: "inspect", factory_id: loserFactoryId });
	assert.equal(loserInspected.capacity.factory_slot, "free");
	assert.equal(loserInspected.capacity.checkout_slot, "held");
	assert.equal(loserInspected.capacity.blocking_hold?.attempt_id, winnerOut.launched.attempt_id);
	assert.equal(loserInspected.capacity.blocking_hold?.task_id, winnerOut.launched.task_id);
	assert.equal(loserInspected.head_status.blocking_kind, "checkout_held");

	// Different checkout (repoB) proceeds even while repoA is held!
	const resB = await runSupervised(process.execPath, [childScript, JSON.stringify({
		mode: "launch",
		database: db3,
		factoryId: f3.factory_id,
		projectCwd: repoB,
		stateDir: bsState3,
		home: iso.home,
		bin,
		workspaceId: "ws-3",
	})], { env: { ...baseEnv, PI_FACTORY_STATE_DIR: factoryState3, PI_BOOTSTRAP_STATE_DIR: bsState3 }, timeoutMs: 10_000 });
	assert.equal(resB.code, 0, resB.stderr);
	assert.equal(JSON.parse(resB.stdout).launched.manifest.status, "applied");

	// Standalone Bootstrap launch on repoA does NOT take factory holds or get blocked by factory checkout holds.
	const standaloneTabs: string[] = [];
	const standaloneSvc = new BootstrapService({
		exec: async (_cmd, args) => {
			const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-standalone" } });
			if (args[0] === "tab" && args[1] === "create") {
				const label = args[args.indexOf("--label") + 1];
				standaloneTabs.push(label);
				return ok({ tab: { tab_id: "ts1" }, root_pane: { pane_id: "ps1", terminal_id: "terms1" } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const [task, instance] = standaloneTabs[0].split(":");
				const sDir = join(repoA, ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: "s-st", endpoint: "/tmp/s", model: cfg.expected_model };
				atomicJson(readyPath(sDir, instance), ready);
				const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
				mkdirSync(regDir, { recursive: true });
				atomicJson(join(regDir, `${instance}.json`), ready);
				return ok();
			}
			throw new Error(`Unexpected herdr ${args.join(" ")}`);
		},
		extensionDir,
		stateDir: join(root, "bs-standalone"),
		home: iso.home,
		env: { ...baseEnv, HERDR_ENV: "1", HERDR_PANE_ID: "standalone-caller" },
		pollMs: 5,
	});
	const standaloneManifest = await standaloneSvc.generate(
		{ project_cwd: repoA, topology: "graph", task: "Standalone run", agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }] },
		{ provider: "provider", id: "model" },
	);
	assert.equal(standaloneManifest.status, "applied");
	assert.equal(standaloneManifest.factory_managed, undefined);
});

test("Slice 3: supervised SIGKILL before/after reserve and release commits, worker release gating, ack loss, and contradictory evidence", async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const root = iso.root;
	const extensionDir = join(fileURLToPath(new URL("..", import.meta.url)));
	const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const baseEnv = { ...iso.env, PATH: bin };

	const setupRepo = (name: string) => {
		const repo = join(root, name);
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWorker.\n");
		return repo;
	};
	const makeSvc = (stateDir: string) => new BootstrapService({
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		extensionDir,
		stateDir,
		home: iso.home,
		env: baseEnv,
	});
	const publishFor = (db: string, stateDir: string, facName: string, repo: string) =>
		factoryOperations(db, makeSvc(stateDir))({
			action: "publish",
			name: facName,
			draft: { project_cwd: repo, topology: "graph", task: `Task ${facName}`, agents: [{ persona: "worker", node_id: "w", sub_task: "Do work" }] },
			sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" },
		});

	// 1. SIGKILL at reserve_before_commit rolls back both DBs cleanly; factory and checkout remain free.
	{
		const repo = setupRepo("repo-reserve-before");
		const fState = join(root, "fs-1");
		const bState = join(root, "bs-1");
		const db = join(fState, "factories.sqlite");
		const fac = publishFor(db, bState, "k-res-before", repo);
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "reserve_before_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);
		const inspected = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.capacity.factory_slot, "free");
		assert.equal(inspected.capacity.checkout_slot, "free");
		assert.equal(inspected.attempts.length, 0);
		assert.equal(inspected.queue[0].disposition, "queued");
	}

	// 2. SIGKILL at reserve_after_commit retains attempt + both holds conservatively; contender is blocked.
	{
		const repo = setupRepo("repo-reserve-after");
		const fState = join(root, "fs-2");
		const fStateOther = join(root, "fs-2-other");
		const bState = join(root, "bs-2");
		const db = join(fState, "factories.sqlite");
		const dbOther = join(fStateOther, "factories.sqlite");
		const fac = publishFor(db, bState, "k-res-after", repo);
		const facOther = publishFor(dbOther, bState, "k-res-after-other", repo);
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "reserve_after_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const roChild = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "inspect", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin,
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(roChild.code, 0, roChild.stderr);
		const inspected = JSON.parse(roChild.stdout);
		assert.equal(inspected.capacity.factory_slot, "held");
		assert.equal(inspected.capacity.checkout_slot, "held");
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].state, "reserved");
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(existsSync(join(repo, ".pi", "agent-sessions")), false);

		// Another factory on same checkout is blocked.
		const contender = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "launch", database: dbOther, factoryId: facOther.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin,
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(contender.code, 1);
		assert.match(contender.stderr, /held|checkout/i);
	}

	// 3. SIGKILL at release_before_commit: manifest stays launching on disk, no release.json, worker cannot act even with rogue release.json!
	{
		const repo = setupRepo("repo-release-before");
		const fState = join(root, "fs-3");
		const bState = join(root, "bs-3");
		const db = join(fState, "factories.sqlite");
		const fac = publishFor(db, bState, "k-rel-before", repo);
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "release_before_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const inspected = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.capacity.factory_slot, "held");
		assert.equal(inspected.capacity.checkout_slot, "held");
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.attempts[0].run?.release_marker_present, false);
		// Read-only inspect must not mutate index manifest on disk from "launching".
		const taskId = inspected.attempts[0].task_id;
		const indexManifest = readJson<any>(join(bState, `${taskId}.json`));
		assert.equal(indexManifest.status, "launching");

		const sessionDir = join(repo, ".pi", "agent-sessions", taskId);
		assert.equal(existsSync(join(sessionDir, "release.json")), false);

		// Forging release.json without SQLite release_authorized=1 is rejected by worker.ts!
		atomicJson(join(sessionDir, "release.json"), {
			task_id: taskId,
			token: indexManifest.token,
			factory_managed: {
				factory_id: fac.factory_id,
				input_id: inspected.attempts[0].input_id,
				attempt_id: inspected.attempts[0].attempt_id,
				request_id: inspected.attempts[0].request_id,
			},
		});
		const cfgFile = readdirSync(sessionDir).find(f => f.endsWith(".config.json"))!;
		const rogueWorker = workerFromConfig(t, join(sessionDir, cfgFile));
		await rogueWorker.start();
		const prompt = await rogueWorker.beforeStart();
		assert.equal(prompt, undefined, "Worker must refuse to release without durable SQLite authorization");
		assert.equal(rogueWorker.aborts, 1);

		// And inspect visibly flags the contradictory release.json vs release_authorized=0!
		const contradicted = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(contradicted.capacity.factory_slot, "uncertain");
		assert.ok(contradicted.uncertainty.some(msg => /release\.json exists without SQLite release authorization/i.test(msg)));
	}

	// 4. SIGKILL at release_after_commit (before release.json) retains authorized attempt and surfaces uncertainty read-only.
	{
		const repo = setupRepo("repo-release-after");
		const fState = join(root, "fs-4");
		const bState = join(root, "bs-4");
		const db = join(fState, "factories.sqlite");
		const fac = publishFor(db, bState, "k-rel-after", repo);
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "release_after_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const inspected = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, true);
		assert.equal(inspected.attempts[0].run?.release_marker_present, false);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.ok(inspected.uncertainty.some(msg => /without release\.json/i.test(msg)));
	}

	// 5. SIGKILL after release.json (lost ack): worker completes, read-only inspect recovers full association & run status, holds remain.
	{
		const repo = setupRepo("repo-lost-ack");
		const fState = join(root, "fs-5");
		const bState = join(root, "bs-5");
		const db = join(fState, "factories.sqlite");
		const fac = publishFor(db, bState, "k-lost-ack", repo);
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "lost_ack",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);
		assert.equal(res.stdout, "");

		const inspected = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.uncertainty.length, 0);
		assert.equal(inspected.capacity.factory_slot, "held");
		assert.equal(inspected.capacity.checkout_slot, "held");
		assert.equal(inspected.attempts.length, 1);
		const att = inspected.attempts[0];
		assert.equal(att.release_authorized, true);
		assert.equal(att.run?.status, "applied");
		assert.equal(att.run?.release_marker_present, true);

		// Real worker acts after release authorization + release.json and reads exact task input.
		const sessionDir = join(repo, ".pi", "agent-sessions", att.task_id);
		const cfgFile = readdirSync(sessionDir).find(f => f.endsWith(".config.json"))!;
		const cfg = readJson<WorkerConfig>(join(sessionDir, cfgFile));
		const regFile = join(cfg.coms_dir, "projects", cfg.coms_project, "agents", `${cfg.instance_id}.json`);
		atomicJson(regFile, { ...readJson<Record<string, unknown>>(regFile), pid: process.pid });
		const w = workerFromConfig(t, join(sessionDir, cfgFile));
		await w.start();
		const prompt = await w.beforeStart();
		assert.ok(prompt?.systemPrompt);
		const done = await w.complete({ status: "success", summary: "Finished after lost ack", detail: "ok" });
		assert.equal(done.isError, undefined);

		// Even after worker settlement, holds remain conservatively in this slice.
		const settledInspect = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(settledInspect.capacity.factory_slot, "held");
		assert.equal(settledInspect.capacity.checkout_slot, "held");
		assert.equal((settledInspect.attempts[0].run?.outcome as any)?.state, "succeeded");
	}

	// 6. Contradictory evidence (missing factory_holds while checkout_holds exists) fails closed and retains remaining hold.
	{
		const repo = setupRepo("repo-contradict");
		const fState = join(root, "fs-6");
		const bState = join(root, "bs-6");
		const db = join(fState, "factories.sqlite");
		const fac = publishFor(db, bState, "k-contradict", repo);
		const launchChild = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin,
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(launchChild.code, 0, launchChild.stderr);

		const rawDb = new DatabaseSync(db);
		try {
			rawDb.prepare("DELETE FROM factory_holds WHERE factory_id = ?").run(fac.factory_id);
		} finally {
			rawDb.close();
		}

		const inspected = factoryOperations(db, makeSvc(bState))({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.ok(inspected.uncertainty.length > 0);
	}
});

test("Slice 4: read-only status/wait/list/recover(inspect) never mutate managed runs and direct mutations reject across alternate roots and tampered metadata", async t => {
	const { root, cwd, home, service, database, coordDatabase, open } = launchFixture(t);
	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		cleanup: "on_success",
		cleanup_settle_ms: 0,
		task_timeout_ms: 100,
		task: "Guard test",
		agents: [
			{ persona: "builder", node_id: "build", sub_task: "Build" },
			{ persona: "reviewer", node_id: "review", depends_on: ["build"], sub_task: "Review" },
		],
	};
	const fac = open()({ action: "publish", name: "guard-fac", draft, sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" } });
	const auth = createManagerAuthority({ pi_session_id: "mgr-guard" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-G1", brief: "Guarded brief", authority: auth });

	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const taskId = launched.task_id;
	const sessionDir = launched.manifest.session_dir;

	// Complete both workers (by writing valid completions via workerFromConfig) so on_success cleanup WOULD fire if unguarded!
	const buildW = workerFromConfig(t, join(sessionDir, "a1-build.config.json"));
	await buildW.start();
	await buildW.beforeStart();
	await buildW.complete({ status: "success", summary: "Built", detail: "ok" });

	const manifestBefore = readFileSync(join(sessionDir, "manifest.json"), "utf8");
	const indexBefore = readFileSync(join(service.store.indexRoot, `${taskId}.json`), "utf8");

	// Read-only views must succeed without mutating files or triggering cleanup/cancel.
	const st1 = service.status(taskId, cwd);
	const st2 = await service.statusWithCleanup(taskId, cwd, () => {
		throw new Error("onCleaned must never fire for a factory-managed run");
	});
	const st3 = await service.waitForStatus(taskId, 30, cwd);
	const recInspect = await service.recover(taskId, { action: "inspect" }, { cwd });
	const listed = service.store.list();
	assert.equal(st1.manifest.task_id, taskId);
	assert.equal(st2.manifest.status, "applied");
	assert.equal(st3.manifest.status, "applied");
	assert.equal(recInspect.task_id, taskId);
	assert.ok(listed.some(m => m.task_id === taskId));
	assert.equal(readFileSync(join(sessionDir, "manifest.json"), "utf8"), manifestBefore);
	assert.equal(readFileSync(join(service.store.indexRoot, `${taskId}.json`), "utf8"), indexBefore);

	// Direct mutation controls reject on same root.
	await assert.rejects(() => service.cancel(taskId, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.cleanup(taskId, undefined, true, cwd), /factory-managed/i);
	await assert.rejects(() => service.recover(taskId, { action: "retry_delivery", agent: "review" }, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.report(taskId, undefined, false, () => "", cwd), /factory-managed/i);
	await assert.rejects(() => service.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);

	// Direct mutation controls ALSO reject from an alternate PI_BOOTSTRAP_STATE_DIR root (even without cwd).
	const altStateDir = join(root, "alt-bs-state");
	const altService = new BootstrapService({
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: altStateDir,
		home,
		env: { ...service.getEnvironment().env, PI_FACTORY_COORDINATION_DIR: join(root) },
	});
	// Even with defaultCoordinationPath pointing elsewhere, factory-run.json + coord_db_path in sidecar/manifest catch alternate roots with cwd!
	await assert.rejects(() => altService.cancel(taskId, { cwd }), /factory-managed/i);
	await assert.rejects(() => altService.cleanup(taskId, undefined, true, cwd), /factory-managed/i);
	await assert.rejects(() => altService.report(taskId, undefined, false, () => "", cwd), /factory-managed/i);
	await assert.rejects(() => altService.recover(taskId, { action: "retry_delivery", agent: "review" }, { cwd }), /factory-managed/i);

	// When sharing the host-wide coordination DB (default in production across PI_BOOTSTRAP_STATE_DIR roots),
	// direct generate replay and mutations are blocked even WITHOUT cwd or local index files.
	const altSharedCoordService = new BootstrapService({
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: join(root, "alt-bs-state-2"),
		home,
		env: { ...service.getEnvironment().env, PI_FACTORY_COORDINATION_DIR: root },
	});
	// Note: coordDatabase in launchFixture is at join(run.root, "factory-coordination.sqlite").
	await assert.rejects(() => altSharedCoordService.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => altSharedCoordService.cancel(taskId), /factory-managed/i);
	await assert.rejects(() => altSharedCoordService.cleanup(taskId, undefined, true), /factory-managed/i);
	await assert.rejects(() => altSharedCoordService.report(taskId, undefined, false, () => ""), /factory-managed/i);

	// Verify holds are cleanly held before tampering, then test tampered/missing ancillary metadata.
	assert.equal(open()({ action: "inspect", factory_id: fac.factory_id }).capacity.factory_slot, "held");

	// Delete factory-run.json and strip factory_managed from index manifest -> still blocked via session_dir manifest & coord!
	rmSync(join(sessionDir, "factory-run.json"));
	const strippedIndex = { ...readJson<Record<string, unknown>>(join(service.store.indexRoot, `${taskId}.json`)) };
	delete strippedIndex.factory_managed;
	atomicJson(join(service.store.indexRoot, `${taskId}.json`), strippedIndex);
	await assert.rejects(() => service.cancel(taskId, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.cleanup(taskId, undefined, true, cwd), /factory-managed/i);

	// Corrupt factory-run.json -> fails closed, still blocked!
	writeFileSync(join(sessionDir, "factory-run.json"), "{not-json");
	await assert.rejects(() => altService.cancel(taskId, { cwd }), /factory-managed/i);
	await assert.rejects(() => altService.cleanup(taskId, undefined, true, cwd), /factory-managed/i);

	// Factory DB and holds remain intact and contradiction is visibly surfaced as uncertain.
	const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(inspected.capacity.factory_slot, "uncertain");
	assert.ok(inspected.uncertainty.some(msg => /missing factory_managed metadata/i.test(msg)));
	assert.equal(existsSync(database), true);
	assert.equal(existsSync(coordDatabase), true);
});

test("Slice 4b: Pi /factory launch adapter enforces UI, worker, trust, managing workspace, and fences in-flight authority/trust revocation before release", async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const root = iso.root;
	const cwd = join(root, "project");
	const bin = join(root, "bin");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

	const savedEnv = {
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BOOTSTRAP_STATE_DIR: process.env.PI_BOOTSTRAP_STATE_DIR,
		PI_FACTORY_STATE_DIR: process.env.PI_FACTORY_STATE_DIR,
		PI_COMS_DIR: process.env.PI_COMS_DIR,
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	};
	Object.assign(process.env, {
		...iso.env,
		PATH: bin,
		PI_FACTORY_STATE_DIR: join(root, "factory-state"),
		HERDR_ENV: "1",
		HERDR_PANE_ID: "managing-pane-42",
	});
	t.after(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; workspace: string; cwd: string }> = [];
	let onPaneRun: (() => void) | undefined;
	let seq = 0;
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: (name: string, handler: Function) => hooks.set(name, handler),
		sendMessage: () => {},
		exec: async (_command: string, args: string[]) => {
			const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") {
				assert.equal(args[2], "managing-pane-42", "Must query managing pane, never focused workspace");
				return ok({ pane: { workspace_id: "managing-ws-42" } });
			}
			if (args[0] === "tab" && args[1] === "create") {
				seq++;
				const ws = args[args.indexOf("--workspace") + 1];
				const tabCwd = args[args.indexOf("--cwd") + 1];
				const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], workspace: ws, cwd: tabCwd };
				tabs.push(tab);
				return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const tab = tabs.find(item => item.pane_id === args[2])!;
				const [task, instance] = tab.label.split(":");
				const sDir = join(tab.cwd, ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `s-${instance}`, endpoint: "/tmp/c", model: cfg.expected_model };
				atomicJson(readyPath(sDir, instance), ready);
				const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
				mkdirSync(regDir, { recursive: true });
				atomicJson(join(regDir, `${instance}.json`), ready);
				onPaneRun?.();
				return ok();
			}
			throw new Error(`Unexpected herdr ${args.join(" ")}`);
		},
	} as any);

	const notifications: Array<[string, string]> = [];
	let trusted = true;
	let sessionId = "sess-mgr-1";
	const makeCtx = (hasUI = true) => ({
		cwd,
		hasUI,
		model: { provider: "provider", id: "model" },
		thinkingLevel: "medium",
		isProjectTrusted: () => trusted,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, `${sessionId}.jsonl`) },
		ui: {
			notify: (msg: string, level: string) => { notifications.push([msg, level]); },
			editor: async () => "",
			confirm: async () => true,
			setWidget: () => {},
			setTheme: () => ({ success: true }),
		},
	});

	await hooks.get("session_start")!({}, makeCtx());
	const factoryCmd = commands.get("factory");
	const factoryInspectTool = tools.get("factory_inspect");
	assert.equal((await factoryInspectTool.execute("t1", { action: "launch", factory_id: "x" })).isError, true);

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Adapter test",
		agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }],
	};
	const dbPath = join(root, "factory-state", "factories.sqlite");
	const svc = new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir: fileURLToPath(new URL("..", import.meta.url)), home: iso.home, env: process.env });
	const fac1 = factoryOperations(dbPath, svc)({ action: "publish", name: "adapter-1", draft, sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" } });
	const fac2 = factoryOperations(dbPath, svc)({ action: "publish", name: "adapter-2", draft, sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" } });

	// Non-UI refused.
	await factoryCmd.handler(`launch ${fac1.factory_id}`, makeCtx(false));
	assert.match(notifications.at(-1)![0], /interactive/i);
	assert.equal(notifications.at(-1)![1], "error");

	// Worker session refused even with UI.
	process.argv.push("--bootstrap-worker-config", "/tmp/fake-worker.json");
	try {
		await factoryCmd.handler(`launch ${fac1.factory_id}`, makeCtx(true));
		assert.match(notifications.at(-1)![0], /worker session/i);
		assert.equal(notifications.at(-1)![1], "error");
	} finally {
		process.argv.splice(process.argv.length - 2, 2);
	}

	// Untrusted refused before launch.
	trusted = false;
	await factoryCmd.handler(`resume ${fac1.factory_id}`, makeCtx(true));
	await factoryCmd.handler(`launch ${fac1.factory_id}`, makeCtx(true));
	assert.match(notifications.at(-1)![0], /not trusted/i);
	assert.equal(notifications.at(-1)![1], "error");
	trusted = true;

	// Resume + submit in active session, then revoke trust mid-flight during pane run!
	const briefExt = factoryOperations(dbPath, svc);
	await factoryCmd.handler(`resume ${fac1.factory_id}`, makeCtx(true));
	// Submit via brief helper: openBriefEditor in non-tui mode uses ctx.ui.editor().
	const submitCtx = makeCtx(true);
	submitCtx.ui.editor = async () => "Brief for in-flight trust revocation";
	await factoryCmd.handler(`submit ${fac1.factory_id} ref-trust`, submitCtx);

	onPaneRun = () => { trusted = false; };
	await factoryCmd.handler(`launch ${fac1.factory_id}`, makeCtx(true));
	assert.equal(notifications.at(-1)![1], "error");
	assert.match(notifications.at(-1)![0], /not trusted/i);
	const fac1Inspected = briefExt({ action: "inspect", factory_id: fac1.factory_id });
	assert.equal(fac1Inspected.attempts.length, 1);
	assert.equal(fac1Inspected.attempts[0].release_authorized, false);
	assert.equal(fac1Inspected.attempts[0].run?.release_marker_present, false);
	onPaneRun = undefined;
	trusted = true;

	// Now test in-flight authority revocation (session_shutdown during pane run) on a separate repo/factory!
	const cwd2 = join(root, "project-2");
	mkdirSync(join(cwd2, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd2, "extensions"), { recursive: true });
	writeFileSync(join(cwd2, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd2, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork 2.\n");
	const fac2b = factoryOperations(dbPath, svc)({
		action: "publish",
		name: "adapter-2b",
		draft: { ...draft, project_cwd: cwd2 },
		sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" },
	});
	const ctx2 = { ...makeCtx(true), cwd: cwd2 };
	await factoryCmd.handler(`resume ${fac2b.factory_id}`, ctx2);
	const subCtx2 = { ...ctx2, ui: { ...ctx2.ui, editor: async () => "Brief for in-flight shutdown" } };
	await factoryCmd.handler(`submit ${fac2b.factory_id} ref-shut`, subCtx2);

	onPaneRun = () => { void hooks.get("session_shutdown")!({ reason: "new" }, ctx2); };
	await factoryCmd.handler(`launch ${fac2b.factory_id}`, ctx2);
	assert.equal(notifications.at(-1)![1], "error");
	assert.match(notifications.at(-1)![0], /authority|shut down/i);
	const fac2Inspected = briefExt({ action: "inspect", factory_id: fac2b.factory_id });
	assert.equal(fac2Inspected.attempts[0].release_authorized, false);
	assert.equal(fac2Inspected.attempts[0].run?.release_marker_present, false);
	onPaneRun = undefined;

	// Fresh session + trusted project launches successfully into managing pane's workspace!
	const cwd3 = join(root, "project-3");
	mkdirSync(join(cwd3, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd3, "extensions"), { recursive: true });
	writeFileSync(join(cwd3, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd3, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork 3.\n");
	const fac3 = factoryOperations(dbPath, svc)({
		action: "publish",
		name: "adapter-3",
		draft: { ...draft, project_cwd: cwd3 },
		sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" },
	});
	sessionId = "sess-mgr-3";
	const ctx3 = { ...makeCtx(true), cwd: cwd3 };
	await hooks.get("session_start")!({}, ctx3);
	await factoryCmd.handler(`resume ${fac3.factory_id}`, ctx3);
	const subCtx3 = { ...ctx3, ui: { ...ctx3.ui, editor: async () => "Brief for clean launch" } };
	await factoryCmd.handler(`submit ${fac3.factory_id} ref-ok`, subCtx3);
	tabs.length = 0;
	await factoryCmd.handler(`launch ${fac3.factory_id}`, ctx3);
	assert.equal(notifications.at(-1)![1], "info", notifications.at(-1)![0]);
	const launchOut = JSON.parse(notifications.at(-1)![0]);
	assert.equal(launchOut.release_authorized, true);
	assert.equal(launchOut.manifest.workspace_id, "managing-ws-42");
	assert.equal(tabs.length, 1);
	assert.equal(tabs[0].workspace, "managing-ws-42");
	assert.equal(fac2.current_version, "v1");
});

test("Slice 5a: cross-factory fail-closed on orphaned/deleted checkout_holds, checkout isolation, and missing central DB continuity anchor", async t => {
	const run = serviceFixture(t, ["builder", "reviewer"]);
	const runOther = serviceFixture(t, ["builder", "reviewer"]);
	const { root, cwd, service } = run;
	const cwdOther = runOther.cwd;

	const coordDatabase = join(root, "shared-factory-coordination.sqlite");
	const dbA = join(root, "state-a", "factories.sqlite");
	const dbB = join(root, "state-b", "factories.sqlite");
	const dbC = join(root, "state-c", "factories.sqlite");
	const openA = () => factoryOperations(dbA, service, { coordinationPath: coordDatabase });
	const openB = () => factoryOperations(dbB, service, { coordinationPath: coordDatabase });
	const openC = () => factoryOperations(dbC, runOther.service, { coordinationPath: coordDatabase });

	const draftSame: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Shared checkout fault test",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	};
	const draftOther: GenerateRequest = {
		project_cwd: cwdOther,
		topology: "graph",
		task: "Independent checkout test",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build other" }],
	};

	const facA = openA()({ action: "publish", name: "fac-a", draft: draftSame, sessionModel });
	const facB = openB()({ action: "publish", name: "fac-b", draft: draftSame, sessionModel });
	const facC = openC()({ action: "publish", name: "fac-c", draft: draftOther, sessionModel });
	const authA = createManagerAuthority({ pi_session_id: "mgr-a" });
	const authB = createManagerAuthority({ pi_session_id: "mgr-b" });
	const authC = createManagerAuthority({ pi_session_id: "mgr-c" });
	openA()({ action: "resume", factory_id: facA.factory_id, authority: authA });
	openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
	openC()({ action: "resume", factory_id: facC.factory_id, authority: authC });
	openA()({ action: "submit", factory_id: facA.factory_id, reference: "Ref-A", brief: "Brief A", authority: authA });
	openB()({ action: "submit", factory_id: facB.factory_id, reference: "Ref-B", brief: "Brief B", authority: authB });
	openC()({ action: "submit", factory_id: facC.factory_id, reference: "Ref-C", brief: "Brief C", authority: authC });

	const launchedA = await openA()({ action: "launch", factory_id: facA.factory_id, authority: authA });
	assert.equal(launchedA.release_authorized, true);

	// Fault injection: delete A's checkout_holds row while leaving coord.managed_runs and A's local records intact.
	const rawCoord = new DatabaseSync(coordDatabase);
	try {
		rawCoord.prepare("DELETE FROM checkout_holds WHERE task_id = ?").run(launchedA.task_id);
	} finally {
		rawCoord.close();
	}

	const inspectA = openA()({ action: "inspect", factory_id: facA.factory_id });
	assert.equal(inspectA.capacity.checkout_slot, "uncertain");
	assert.equal(inspectA.capacity.factory_slot, "uncertain");

	const inspectB = openB()({ action: "inspect", factory_id: facB.factory_id });
	assert.equal(inspectB.capacity.checkout_slot, "uncertain");
	assert.equal(inspectB.head_status.eligible, false);
	assert.equal(inspectB.head_status.blocking_kind, "uncertain");
	assert.ok(inspectB.uncertainty.length > 0);

	await assert.rejects(
		() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }),
		/uncertain|managed_run|checkout|hold/i,
	);
	const inspectBAfter = openB()({ action: "inspect", factory_id: facB.factory_id });
	assert.equal(inspectBAfter.attempts.length, 0);
	assert.equal(inspectBAfter.queue[0].disposition, "queued");

	// Independent checkout (cwdOther) can still inspect free and launch cleanly!
	const inspectC = openC()({ action: "inspect", factory_id: facC.factory_id });
	assert.equal(inspectC.capacity.checkout_slot, "free");
	assert.equal(inspectC.head_status.eligible, true);
	const launchedC = await openC()({ action: "launch", factory_id: facC.factory_id, authority: authC });
	assert.equal(launchedC.release_authorized, true);

	// Deleting the previously-initialized central coordination DB must fail closed across separate state roots without recreating a clean slate!
	rmSync(coordDatabase);
	const dbD = join(root, "state-d", "factories.sqlite");
	const openD = () => factoryOperations(dbD, service, { coordinationPath: coordDatabase });
	const facD = openD()({ action: "publish", name: "fac-d", draft: draftOther, sessionModel });
	const authD = createManagerAuthority({ pi_session_id: "mgr-d" });
	openD()({ action: "resume", factory_id: facD.factory_id, authority: authD });
	openD()({ action: "submit", factory_id: facD.factory_id, reference: "Ref-D", brief: "Brief D", authority: authD });

	const inspectD = openD()({ action: "inspect", factory_id: facD.factory_id });
	assert.equal(inspectD.capacity.checkout_slot, "uncertain");
	assert.equal(inspectD.head_status.eligible, false);
	assert.equal(inspectD.head_status.blocking_kind, "uncertain");
	assert.equal(existsSync(coordDatabase), false, "Read-only inspect must not recreate missing coordination DB");

	await assert.rejects(
		() => openD()({ action: "launch", factory_id: facD.factory_id, authority: authD }),
		/coordination|anchor|missing|uncertain/i,
	);
	assert.equal(existsSync(coordDatabase), false, "Launch must not silently recreate missing coordination DB");
});

test("Slice 5b: default production coordination spans separate Pi profiles (PI_CODING_AGENT_DIR) and separate state roots", async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const root = iso.root;
	const extensionDir = fileURLToPath(new URL("..", import.meta.url));
	const repo = join(root, "repo");
	const bin = join(root, "bin");
	mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
	mkdirSync(join(repo, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

	const makeExec = () => {
		const tabs: Array<{ pane_id: string; label: string }> = [];
		let seq = 0;
		const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
		return async (_cmd: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-prof" } });
			if (args[0] === "tab" && args[1] === "create") {
				seq++;
				const label = args[args.indexOf("--label") + 1];
				const tab = { tab_id: `t-${seq}`, pane_id: `p-${seq}`, terminal_id: `term-${seq}` };
				tabs.push({ pane_id: tab.pane_id, label });
				return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const [task, instance] = tabs.find(tab => tab.pane_id === args[2])!.label.split(":");
				const sDir = join(repo, ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `s-${instance}`, endpoint: "/tmp/c", model: cfg.expected_model };
				atomicJson(readyPath(sDir, instance), ready);
				const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
				mkdirSync(regDir, { recursive: true });
				atomicJson(join(regDir, `${instance}.json`), ready);
				return ok();
			}
			throw new Error(`Unexpected herdr ${args.join(" ")}`);
		};
	};

	const envProfile1 = { ...iso.env, PATH: bin, PI_CODING_AGENT_DIR: join(root, "profile-1"), PI_FACTORY_STATE_DIR: join(root, "fstate-1"), PI_BOOTSTRAP_STATE_DIR: join(root, "bstate-1"), HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" };
	const envProfile2 = { ...iso.env, PATH: bin, PI_CODING_AGENT_DIR: join(root, "profile-2"), PI_FACTORY_STATE_DIR: join(root, "fstate-2"), PI_BOOTSTRAP_STATE_DIR: join(root, "bstate-2"), HERDR_ENV: "1", HERDR_PANE_ID: "pane-2" };
	delete (envProfile1 as Record<string, unknown>).PI_FACTORY_COORDINATION_DIR;
	delete (envProfile2 as Record<string, unknown>).PI_FACTORY_COORDINATION_DIR;

	const svc1 = new BootstrapService({ exec: makeExec(), extensionDir, home: iso.home, env: envProfile1, pollMs: 5 });
	const svc2 = new BootstrapService({ exec: makeExec(), extensionDir, home: iso.home, env: envProfile2, pollMs: 5 });
	const ops1 = factoryOperations(join(root, "fstate-1", "factories.sqlite"), svc1);
	const ops2 = factoryOperations(join(root, "fstate-2", "factories.sqlite"), svc2);

	const draft: GenerateRequest = { project_cwd: repo, topology: "graph", task: "Profile separation", agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }] };
	const fac1 = ops1({ action: "publish", name: "prof-1", draft, sessionModel });
	const fac2 = ops2({ action: "publish", name: "prof-2", draft, sessionModel });
	const auth1 = createManagerAuthority({ pi_session_id: "p1" });
	const auth2 = createManagerAuthority({ pi_session_id: "p2" });
	ops1({ action: "resume", factory_id: fac1.factory_id, authority: auth1 });
	ops2({ action: "resume", factory_id: fac2.factory_id, authority: auth2 });
	ops1({ action: "submit", factory_id: fac1.factory_id, reference: "ref-p1", brief: "Profile 1", authority: auth1 });
	ops2({ action: "submit", factory_id: fac2.factory_id, reference: "ref-p2", brief: "Profile 2", authority: auth2 });

	const launched1 = await ops1({ action: "launch", factory_id: fac1.factory_id, authority: auth1 });
	assert.equal(launched1.release_authorized, true);

	const inspect2 = ops2({ action: "inspect", factory_id: fac2.factory_id });
	assert.equal(inspect2.capacity.checkout_slot, "held");
	assert.equal(inspect2.head_status.blocking_kind, "checkout_held");
	await assert.rejects(() => ops2({ action: "launch", factory_id: fac2.factory_id, authority: auth2 }), /held|checkout/i);
});

test("Slice 5c: manager revocation race at shared operation boundary, final release fence evidence check, and read-only release.json content inspection", async t => {
	const { root, cwd, service, database, coordDatabase, open } = launchFixture(t);
	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Revocation & release evidence test",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	};

	// 1. Revoking manager authority during async workspace lookup at shared operation boundary (no adapter callback) prevents reservation!
	{
		const fac = open()({ action: "publish", name: "revoke-race", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-revoke-race" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-Rev", brief: "Revoke before reserve", authority: auth });

		const ops = open();
		const promise = ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
		revokeManagerAuthority(auth);
		await assert.rejects(promise, /authority/i);

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 0);
		assert.equal(inspected.capacity.factory_slot, "free");
		assert.equal(inspected.capacity.checkout_slot, "free");
		assert.equal(inspected.queue[0].disposition, "queued");
	}

	// 2. Final release fence rejects missing/contradictory managed_runs and does not report release success or write release.json!
	{
		const fac = open()({ action: "publish", name: "release-fence-fault", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-rel-fence" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-RF", brief: "Release fence check", authority: auth });

		let injectedTaskId: string | undefined;
		const opsWithFault = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "reserve_after_commit") {
					const rawCoord = new DatabaseSync(coordDatabase);
					try {
						const row = rawCoord.prepare("SELECT task_id FROM managed_runs LIMIT 1").get() as { task_id: string } | undefined;
						injectedTaskId = row?.task_id;
						rawCoord.prepare("DELETE FROM managed_runs").run();
					} finally {
						rawCoord.close();
					}
				}
			},
		});
		await assert.rejects(
			() => opsWithFault({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/managed_run|contradict|missing|release/i,
		);
		assert.ok(injectedTaskId);
		assert.equal(existsSync(join(cwd, ".pi", "agent-sessions", injectedTaskId!, "release.json")), false);

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
	}

	// 3. Read-only inspect verifies release.json contents (invalid JSON or mismatched identity/token is uncertain, not valid release).
	{
		const run2 = launchFixture(t);
		const fac = run2.open()({
			action: "publish",
			name: "release-json-inspect",
			draft: { ...draft, project_cwd: run2.cwd },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-rel-json" });
		run2.open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		run2.open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-RJ", brief: "Inspect release marker", authority: auth });
		const launched = await run2.open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
		const releaseFile = join(run2.cwd, ".pi", "agent-sessions", launched.task_id, "release.json");

		// Replace valid release.json with mismatched factory_managed identity.
		atomicJson(releaseFile, {
			task_id: launched.task_id,
			token: launched.manifest.token,
			factory_managed: {
				factory_id: fac.factory_id,
				input_id: launched.input_id,
				attempt_id: "att-wrong",
				request_id: launched.request_id,
			},
		});
		const rawBeforeCorrupt = readFileSync(releaseFile, "utf8");
		const inspectedBadIdentity = run2.open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectedBadIdentity.capacity.factory_slot, "uncertain");
		assert.equal(inspectedBadIdentity.capacity.checkout_slot, "uncertain");
		assert.equal(inspectedBadIdentity.head_status.blocking_kind, "uncertain");
		assert.ok(inspectedBadIdentity.uncertainty.some(msg => /release\.json/i.test(msg)));
		assert.equal(readFileSync(releaseFile, "utf8"), rawBeforeCorrupt, "inspect must not modify release.json");

		// Replace release.json with corrupt JSON.
		writeFileSync(releaseFile, "{corrupt-release");
		const inspectedCorrupt = run2.open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectedCorrupt.capacity.factory_slot, "uncertain");
		assert.equal(inspectedCorrupt.capacity.checkout_slot, "uncertain");
		assert.equal(inspectedCorrupt.head_status.blocking_kind, "uncertain");
		assert.ok(inspectedCorrupt.uncertainty.some(msg => /release\.json/i.test(msg)));
	}
});

test("Slice 6: standalone replay/fresh/controls survive central coordination DB loss while factory and managed guards remain fail-closed", async t => {
	const { root, cwd, home, service } = serviceFixture(t, ["builder", "reviewer"]);
	const database = join(root, "factories.sqlite");
	const coordDb = service.defaultCoordinationPath();
	const open = () => factoryOperations(database, service, { coordinationPath: coordDb });

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		cleanup: "on_success",
		cleanup_settle_ms: 0,
		task: "Standalone survival test",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	};

	const existingStandalone = await service.generate({ ...draft, request_id: "standalone-existing" }, { provider: "provider", id: "model" });
	assert.equal(existingStandalone.status, "applied");
	assert.equal(existingStandalone.factory_managed, undefined);

	const fac = open()({ action: "publish", name: "loss-guard", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-loss" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-L1", brief: "Managed run", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

	// Remove coordination DB only; continuity anchor survives.
	rmSync(coordDb);
	assert.equal(existsSync(coordDb), false);
	assert.equal(existsSync(coordAnchorPath(coordDb)), true);

	// Factory inspection and launch remain fail-closed (uncertain).
	const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(inspected.capacity.checkout_slot, "uncertain");
	assert.equal(inspected.head_status.blocking_kind, "uncertain");
	open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-L2", brief: "Blocked launch", authority: auth });
	await assert.rejects(() => open()({ action: "launch", factory_id: fac.factory_id, authority: auth }), /coordination|anchor|missing|uncertain/i);

	// Standalone replay and fresh generate (and tool-supplied request_id) must continue working normally.
	const replayed = await service.generate({ ...draft, request_id: "standalone-existing" }, { provider: "provider", id: "model" });
	assert.equal(replayed.task_id, existingStandalone.task_id);
	const freshStandalone = await service.generate({ ...draft, request_id: "standalone-fresh" }, { provider: "provider", id: "model" });
	assert.equal(freshStandalone.status, "applied");
	assert.equal(freshStandalone.factory_managed, undefined);

	// Standalone direct controls and graph auto-cleanup on standalone records still work without false factory rejection.
	const wFresh = workerFromConfig(t, join(freshStandalone.session_dir, "a1-build.config.json"));
	await wFresh.start();
	await wFresh.beforeStart();
	await wFresh.complete({ status: "success", summary: "Fresh done", detail: "ok" });
	const freshCleaned = await service.statusWithCleanup(freshStandalone.task_id, cwd);
	assert.equal(freshCleaned.manifest.status, "cleaned");
	await service.cancel(existingStandalone.task_id, { cwd });
	await service.cleanup(existingStandalone.task_id, undefined, false, cwd);

	// Managed run direct controls and replay STILL reject across missing coordination DB, alternate roots, and stripped/corrupt metadata.
	await assert.rejects(() => service.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => service.cancel(launched.task_id, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.cleanup(launched.task_id, undefined, true, cwd), /factory-managed/i);

	const altService = new BootstrapService({
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: join(root, "alt-loss-state"),
		home,
		env: { ...service.getEnvironment().env },
	});
	await assert.rejects(() => altService.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => altService.cancel(launched.task_id), /factory-managed/i);

	rmSync(join(launched.manifest.session_dir, "factory-run.json"));
	const strippedIdx = { ...readJson<Record<string, unknown>>(join(service.store.indexRoot, `${launched.task_id}.json`)) };
	delete strippedIdx.factory_managed;
	atomicJson(join(service.store.indexRoot, `${launched.task_id}.json`), strippedIdx);
	await assert.rejects(() => service.cancel(launched.task_id, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.cleanup(launched.task_id, undefined, true, cwd), /factory-managed/i);
});

test("Slice 7: read-only managed observation shares worker release validation and never infers released/cleanup from release.json alone", async t => {
	// 1. Pre-release rollback followed by legacy-shaped release.json + 'launching' persisted manifest must NOT report applied/released.
	{
		const { root, cwd, service, database, coordDatabase, open } = launchFixture(t);
		const draft: GenerateRequest = {
			project_cwd: cwd,
			topology: "graph",
			task: "Legacy marker contradiction",
			agents: [
				{ persona: "builder", node_id: "build", sub_task: "Build" },
				{ persona: "reviewer", node_id: "review", depends_on: ["build"], sub_task: "Review" },
			],
		};
		const fac = open()({ action: "publish", name: "legacy-marker-fac", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-legacy-marker" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-LM", brief: "Rollback then rogue marker", authority: auth });

		let rolledBackTaskId: string | undefined;
		const opsAbort = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_before_commit") {
					const rawCoord = new DatabaseSync(coordDatabase);
					try {
						rolledBackTaskId = (rawCoord.prepare("SELECT task_id FROM managed_runs LIMIT 1").get() as { task_id: string } | undefined)?.task_id;
					} finally {
						rawCoord.close();
					}
					throw new Error("Simulated pre-release rollback");
				}
			},
		});
		await assert.rejects(() => opsAbort({ action: "launch", factory_id: fac.factory_id, authority: auth }), /Simulated pre-release rollback/);
		assert.ok(rolledBackTaskId);

		const indexPath = join(service.store.indexRoot, `${rolledBackTaskId}.json`);
		const sessionDir = join(cwd, ".pi", "agent-sessions", rolledBackTaskId!);
		const sessionManifestPath = join(sessionDir, "manifest.json");
		const persisted = readJson<Record<string, unknown>>(indexPath);
		const launchingManifest = { ...persisted, status: "launching", phase: "waiting-ready" };
		delete (launchingManifest as { error?: unknown }).error;
		atomicJson(indexPath, launchingManifest);
		atomicJson(sessionManifestPath, launchingManifest);
		rmSync(join(sessionDir, "abort.json"), { force: true });

		// Plant a legacy-shaped release.json with matching task_id and token, without factory_managed.
		atomicJson(join(sessionDir, "release.json"), { task_id: rolledBackTaskId, token: persisted.token });

		const indexBefore = readFileSync(indexPath, "utf8");
		const st = service.status(rolledBackTaskId!, cwd);
		assert.notEqual(st.manifest.status, "applied");
		assert.notEqual(st.manifest.phase, "released");
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "uncertain");
		assert.doesNotMatch(st.manifest.error ?? "", /bootstrap_cleanup/i);
		assert.equal(readFileSync(indexPath, "utf8"), indexBefore, "status must not mutate disk");

		const rec = await service.recover(rolledBackTaskId!, { action: "inspect" }, { cwd });
		assert.ok(rec.closed);
		assert.doesNotMatch(rec.closed, /bootstrap_cleanup/i);

		const listed = service.list().find(item => item.task_id === rolledBackTaskId);
		assert.equal(listed?.status, "error");
		assert.equal(listed?.phase, "uncertain");

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.attempts[0].run?.status, "error");
		assert.equal(inspected.attempts[0].run?.phase, "uncertain");
	}

	// 2. Supervised SIGKILL at release_after_commit (before release.json) and release_before_commit surface uncertain/held without cleanup advice.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const baseEnv = { ...iso.env, PATH: bin };
		const makeSvc = (stateDir: string) => new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir, stateDir, home: iso.home, env: baseEnv });

		for (const [label, killPhase, expectedPhase] of [
			["after", "release_after_commit", "uncertain"],
			["before", "release_before_commit", "held"],
		] as const) {
			const repo = join(root, `repo-${label}`);
			mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
			mkdirSync(join(repo, "extensions"), { recursive: true });
			writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
			writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWorker.\n");
			const fState = join(root, `fs-${label}`);
			const bState = join(root, `bs-${label}`);
			const db = join(fState, "factories.sqlite");
			const svc = makeSvc(bState);
			const fac = factoryOperations(db, svc)({
				action: "publish",
				name: `obs-${label}`,
				draft: { project_cwd: repo, topology: "graph", task: `Obs ${label}`, agents: [{ persona: "worker", node_id: "w", sub_task: "Work" }] },
				sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" },
			});
			const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
				mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase,
			})], { env: baseEnv, timeoutMs: 10_000 });
			assert.equal(res.signal, "SIGKILL", res.stderr);

			const inspected = factoryOperations(db, svc)({ action: "inspect", factory_id: fac.factory_id });
			const taskId = inspected.attempts[0].task_id;
			const diskBefore = readFileSync(join(bState, `${taskId}.json`), "utf8");
			const st = svc.status(taskId, repo);
			assert.equal(st.manifest.status, "error");
			assert.equal(st.manifest.phase, expectedPhase);
			assert.doesNotMatch(st.manifest.error ?? "", /bootstrap_cleanup/i);
			assert.doesNotMatch(st.manifest.error ?? "", /interrupted before work was released/i);
			assert.equal(readFileSync(join(bState, `${taskId}.json`), "utf8"), diskBefore);
			assert.equal(inspected.attempts[0].run?.status, "error");
			assert.equal(inspected.attempts[0].run?.phase, expectedPhase);
			assert.equal(svc.list().find(item => item.task_id === taskId)?.phase, expectedPhase);
		}
	}

	// 3. Contradictory SQLite state (release_authorized=1 but attempt/hold state != 'released') cannot bypass worker or status checks.
	{
		const { cwd, service, database, open } = launchFixture(t);
		const draft: GenerateRequest = {
			project_cwd: cwd,
			topology: "graph",
			task: "State contradiction check",
			agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
		};
		const fac = open()({ action: "publish", name: "state-contra", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-state-contra" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-SC", brief: "State contradiction", authority: auth });
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

		const rawDb = new DatabaseSync(database);
		try {
			rawDb.prepare("UPDATE factory_attempts SET state = 'reserved' WHERE attempt_id = ?").run(launched.attempt_id);
		} finally {
			rawDb.close();
		}

		const w = workerFromConfig(t, join(launched.manifest.session_dir, "a1-build.config.json"));
		await w.start();
		const prompt = await w.beforeStart();
		assert.equal(prompt, undefined, "Worker must reject contradictory SQLite attempt state even when release_authorized=1");
		assert.equal(w.aborts, 1);

		const st = service.status(launched.task_id, cwd);
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "uncertain");
	}
});

test("Slice 8a: release reader validates record_digest on all five SQLite rows and blocks worker admission on damage", async t => {
	const cases: Array<{
		label: string;
		dbTarget: "main" | "coord";
		sql: string;
	}> = [
		{
			label: "factory_attempts.record_digest",
			dbTarget: "main",
			sql: "UPDATE factory_attempts SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE attempt_id = ?",
		},
		{
			label: "factory_inputs.record_digest",
			dbTarget: "main",
			sql: "UPDATE factory_inputs SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE input_id = ?",
		},
		{
			label: "factory_holds.record_digest",
			dbTarget: "main",
			sql: "UPDATE factory_holds SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?",
		},
		{
			label: "coord.checkout_holds.record_digest",
			dbTarget: "coord",
			sql: "UPDATE checkout_holds SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE task_id = ?",
		},
		{
			label: "coord.managed_runs.record_digest",
			dbTarget: "coord",
			sql: "UPDATE managed_runs SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE task_id = ?",
		},
	];

	for (const tc of cases) {
		await t.test(tc.label, async t2 => {
			const { cwd, service, database, coordDatabase, open } = launchFixture(t2);
			const draft: GenerateRequest = {
				project_cwd: cwd,
				topology: "graph",
				task: `Digest fault ${tc.label}`,
				agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
			};
			const fac = open()({ action: "publish", name: "digest-fac", draft, sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" } });
			const auth = createManagerAuthority({ pi_session_id: "mgr-digest" });
			open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
			const receipt = open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-D1", brief: "Check digest", authority: auth });
			const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

			const targetDb = tc.dbTarget === "main" ? database : coordDatabase;
			const param = tc.label.startsWith("factory_attempts")
				? launched.attempt_id
				: tc.label.startsWith("factory_inputs")
					? receipt.input_id
					: tc.label.startsWith("factory_holds")
						? fac.factory_id
						: launched.task_id;
			const rawDb = new DatabaseSync(targetDb);
			try {
				rawDb.prepare(tc.sql).run(param);
			} finally {
				rawDb.close();
			}

			// Start real worker before first turn: damaged evidence must block admission and produce no model prompt.
			const w = workerFromConfig(t2, join(launched.manifest.session_dir, "a1-build.config.json"));
			await w.start();
			const prompt = await w.beforeStart();
			assert.equal(prompt, undefined, `Worker must not receive a prompt when ${tc.label} is damaged`);
			assert.ok(w.aborts >= 1, `Worker must abort when ${tc.label} is damaged`);
			const errRecord = readJson<{ error: string }>(join(launched.manifest.session_dir, "a1-build.error.json"));
			assert.match(errRecord.error, /corruption|mismatch|evidence/i);

			// Bootstrap status must surface uncertainty without repairing records.
			const st = service.status(launched.task_id, cwd);
			assert.equal(st.manifest.status, "error");
			assert.equal(st.manifest.phase, "uncertain");
			assert.match(st.manifest.error ?? "", /corruption|mismatch|evidence/i);

			// Factory inspect must reject damaged row at read boundary and never repair digest or clear holds.
			assert.throws(
				() => open()({ action: "inspect", factory_id: fac.factory_id }),
				/corruption|mismatch|evidence/i,
			);
			const checkDb = new DatabaseSync(targetDb);
			try {
				const holdCheck = tc.dbTarget === "main"
					? checkDb.prepare("SELECT COUNT(*) AS n FROM factory_holds WHERE factory_id = ?").get(fac.factory_id)
					: checkDb.prepare("SELECT COUNT(*) AS n FROM checkout_holds WHERE task_id = ?").get(launched.task_id);
				assert.equal((holdCheck as { n: number }).n, 1, "Damaged digest must never clear holds");
			} finally {
				checkDb.close();
			}
		});
	}
});

test("Slice 8b: managed workers enforce attempt-keyed immutable task input against authoritative brief while preserving revisions and standalone fallback", async t => {
	const workerSessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" };
	const longBrief =
		"  head line\r\n\tsecond line\n"
		+ `${"immutable-segment-".repeat(170)}\n`
		+ "tail-marker  \n";
	assert.ok(Buffer.byteLength(longBrief, "utf8") > 2048);

	const faultCases: Array<{
		name: string;
		timing: "before_start" | "before_turn";
		corrupt: (inputFile: string, rootDir: string, cfg: WorkerConfig) => void;
	}> = [
		{
			name: "missing input before start",
			timing: "before_start",
			corrupt: inputFile => { rmSync(inputFile); },
		},
		{
			name: "missing input before first worker turn",
			timing: "before_turn",
			corrupt: inputFile => { rmSync(inputFile); },
		},
		{
			name: "bad input_hash integrity",
			timing: "before_turn",
			corrupt: inputFile => {
				const rec = readJson<Record<string, unknown>>(inputFile);
				atomicJson(inputFile, { ...rec, input_hash: "f".repeat(64) });
			},
		},
		{
			name: "wrong attempt_id identity",
			timing: "before_turn",
			corrupt: inputFile => {
				const rec = readJson<any>(inputFile);
				const rebuilt = buildTaskInputRecord({
					identity: { ...rec.identity, attempt_id: "wrong-attempt" },
					brief: rec.brief,
					assignment: rec.assignment,
					roster: rec.roster,
					...(rec.upstream_contracts ? { upstream_contracts: rec.upstream_contracts } : {}),
				});
				atomicJson(inputFile, rebuilt);
			},
		},
		{
			name: "self-consistently re-encoded different submitted_brief",
			timing: "before_turn",
			corrupt: inputFile => {
				const rec = readJson<any>(inputFile);
				const rebuilt = buildTaskInputRecord({
					identity: rec.identity,
					brief: { ...rec.brief, submitted_brief: "Tampered different brief!" },
					assignment: rec.assignment,
					roster: rec.roster,
					...(rec.upstream_contracts ? { upstream_contracts: rec.upstream_contracts } : {}),
				});
				atomicJson(inputFile, rebuilt);
			},
		},
		{
			name: "symlinked input file",
			timing: "before_turn",
			corrupt: (inputFile, rootDir) => {
				const altFile = join(rootDir, "alt-input.json");
				writeFileSync(altFile, readFileSync(inputFile, "utf8"));
				rmSync(inputFile);
				symlinkSync(altFile, inputFile);
			},
		},
	];

	for (const tc of faultCases) {
		await t.test(tc.name, async t2 => {
			const { root, open } = launchFixture(t2);
			const draft: GenerateRequest = {
				project_cwd: join(root, "project"),
				topology: "graph",
				task: `Input gate ${tc.name}`,
				agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
			};
			const fac = open()({ action: "publish", name: "input-gate", draft, sessionModel: workerSessionModel });
			const auth = createManagerAuthority({ pi_session_id: "mgr-gate" });
			open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
			open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-IG", brief: longBrief, authority: auth });
			const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

			const cfgPath = join(launched.manifest.session_dir, "a1-build.config.json");
			const cfg = readJson<WorkerConfig>(cfgPath);
			const inputFile = taskInputPath(launched.manifest.session_dir, "a1-build");
			assert.equal(existsSync(inputFile), true);

			const w = workerFromConfig(t2, cfgPath);
			if (tc.timing === "before_start") {
				tc.corrupt(inputFile, root, cfg);
				await w.start();
			} else {
				await w.start();
				tc.corrupt(inputFile, root, cfg);
			}
			const prompt = await w.beforeStart();
			assert.equal(prompt, undefined, `Managed worker must fail closed without prompt for ${tc.name}`);
			assert.ok(w.aborts >= 1);
			await assert.rejects(() => w.readInput({ kind: "task_input" }), /not admitted|missing|symlink|mismatch/i);
			const errRecord = readJson<{ error: string }>(join(launched.manifest.session_dir, "a1-build.error.json"));
			assert.match(errRecord.error, /task input|submitted_brief|symlink|mismatch|missing/i);
		});
	}

	// Positive roundtrip + managed review-loop feedback revision (uses original .1.input.json without needing .2.input.json).
	await t.test("positive long brief roundtrip and managed feedback revision", async t2 => {
		const { cwd, open } = launchFixture(t2);
		const draft: GenerateRequest = {
			project_cwd: cwd,
			topology: "graph",
			task: "Managed review loop",
			agents: [
				{ persona: "builder", node_id: "build", sub_task: "Build feature" },
				{
					persona: "reviewer",
					node_id: "review",
					depends_on: ["build"],
					sub_task: "Review feature",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "reject"] } } },
					decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "build", max_revisions: 2 },
				},
			],
		};
		const fac = open()({ action: "publish", name: "rev-fac", draft, sessionModel: workerSessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-rev" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-Rev", brief: longBrief, authority: auth });
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

		assert.equal(existsSync(taskInputPath(launched.manifest.session_dir, "a1-build.1")), true);
		assert.equal(existsSync(taskInputPath(launched.manifest.session_dir, "a1-build.2")), false);

		const wBuild = workerFromConfig(t2, join(launched.manifest.session_dir, "a1-build.config.json"));
		const wReview = workerFromConfig(t2, join(launched.manifest.session_dir, "a2-review.config.json"));
		await wBuild.start();
		await wReview.start();

		const p1 = await wBuild.beforeStart();
		assert.ok(p1?.systemPrompt);
		assert.ok(!p1.systemPrompt.includes("tail-marker  \n"), "Prompt must truncate long brief");
		const read1 = await wBuild.readInput({ kind: "task_input" });
		assert.equal(read1.isError, undefined);
		assert.equal(JSON.parse(read1.details.text).brief.submitted_brief, longBrief);

		const c1 = await wBuild.complete({ status: "success", summary: "v1 built", detail: "first attempt" });
		assert.equal(c1.isError, undefined);
		const sendToReview = wBuild.sent.findLast(call => call.name === "coms_send")!;
		const pRev1 = await wReview.beforeStart({
			systemPrompt: "BASE",
			messageType: "custom",
			message: { customType: "coms-inbound", details: { sender_session: "session-a1-build" }, content: sendToReview.params.prompt },
		});
		assert.ok(pRev1?.systemPrompt);
		const readRev = await wReview.readInput({ kind: "task_input" });
		assert.equal(readRev.isError, undefined);
		assert.equal(JSON.parse(readRev.details.text).brief.submitted_brief, longBrief);

		const reject1 = await wReview.complete({ status: "success", summary: "Needs fix", detail: "fix it", outputs: { verdict: "reject" } });
		assert.equal(reject1.isError, undefined);

		const sendFeedback = wReview.sent.findLast(call => call.name === "coms_send")!;
		const pBuild2 = await wBuild.beforeStart({
			systemPrompt: "BASE",
			messageType: "custom",
			message: { customType: "coms-inbound", details: { sender_session: "session-a2-review" }, content: sendFeedback.params.prompt },
		});
		assert.ok(pBuild2?.systemPrompt, "Managed revision must succeed using original .1.input.json");
		assert.match(pBuild2.systemPrompt, /a1-build\.2/);
		assert.equal(existsSync(taskInputPath(launched.manifest.session_dir, "a1-build.2")), false);
	});

	// Standalone legacy fallback: removing .input.json on a standalone run still allows worker prompt from config.
	await t.test("standalone legacy missing-input fallback preserved", async t2 => {
		const { cwd, service } = launchFixture(t2);
		const run = await service.generate({
			project_cwd: cwd,
			topology: "graph",
			task: "Standalone legacy input fallback",
			agents: [{ persona: "builder", node_id: "build", sub_task: "Build standalone" }],
		}, { provider: "provider", id: "model" });
		rmSync(taskInputPath(run.session_dir, "a1-build"));
		const w = workerFromConfig(t2, join(run.session_dir, "a1-build.config.json"));
		await w.start();
		const prompt = await w.beforeStart();
		assert.ok(prompt?.systemPrompt, "Standalone worker retains optional legacy fallback when .input.json is absent");
	});
});

test("Slice 8c: standalone status, controls, and request-ID replay survive symlinked or corrupt coordination DB while managed guards stay fail-closed", async t => {
	const { root, cwd, home, service } = launchFixture(t);
	const database = join(root, "factories.sqlite");
	const coordDb = service.defaultCoordinationPath();
	const open = () => factoryOperations(database, service, { coordinationPath: coordDb });

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Symlinked coord survival",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	};

	const existingStandalone = await service.generate({ ...draft, request_id: "standalone-symlink-existing" }, { provider: "provider", id: "model" });
	assert.equal(existingStandalone.status, "applied");

	const fac = open()({ action: "publish", name: "sym-coord-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-sym-coord" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-SC1", brief: "Managed run", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

	// Replace coordination DB path with a symlink pointing to the same DB.
	const realCoord = join(root, "real-factory-coordination.sqlite");
	renameSync(coordDb, realCoord);
	symlinkSync(realCoord, coordDb);

	const st = service.status(existingStandalone.task_id, cwd);
	assert.equal(st.manifest.task_id, existingStandalone.task_id);
	const replayed = await service.generate({ ...draft, request_id: "standalone-symlink-existing" }, { provider: "provider", id: "model" });
	assert.equal(replayed.task_id, existingStandalone.task_id);
	const fresh = await service.generate({ ...draft, request_id: "standalone-symlink-fresh" }, { provider: "provider", id: "model" });
	assert.equal(fresh.status, "applied");
	await service.cancel(existingStandalone.task_id, { cwd });
	await service.cleanup(existingStandalone.task_id, undefined, false, cwd);

	// Managed runs and reserved factory IDs still fail closed (and across alternate roots via reserved IDs / sidecars).
	await assert.rejects(() => service.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => service.generate({ ...draft, request_id: "factory_run_req_forged" }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => service.cancel(launched.task_id, { cwd }), /factory-managed/i);
	await assert.rejects(() => service.cleanup(launched.task_id, undefined, true, cwd), /factory-managed/i);

	const altService = new BootstrapService({
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: join(root, "alt-sym-state"),
		home,
		env: { ...service.getEnvironment().env },
	});
	await assert.rejects(() => altService.generate({ ...draft, request_id: launched.request_id }, { provider: "provider", id: "model" }), /factory-managed/i);
	await assert.rejects(() => altService.cancel(launched.task_id, { cwd }), /factory-managed/i);

	// Factory operations still reject the symlinked coordination path rather than following it.
	assert.throws(() => open()({ action: "inspect", factory_id: fac.factory_id }), /symlink/i);

	// Also verify corrupt non-SQLite coordination DB does not break standalone replay/status.
	rmSync(coordDb);
	writeFileSync(coordDb, "not-a-sqlite-db");
	assert.equal(service.status(fresh.task_id, cwd).manifest.task_id, fresh.task_id);
	const replayedFresh = await service.generate({ ...draft, request_id: "standalone-symlink-fresh" }, { provider: "provider", id: "model" });
	assert.equal(replayedFresh.task_id, fresh.task_id);
});

test("Slice 8d: missing factory-run.json sidecar after release propagates shared release diagnosis to inspect and handles unavailable status", async t => {
	// 1. Missing sidecar alone after acknowledged release (with BootstrapService.status available).
	{
		const { cwd, service, database, coordDatabase, open } = launchFixture(t);
		const draft: GenerateRequest = {
			project_cwd: cwd,
			topology: "graph",
			task: "Missing sidecar diagnosis",
			agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
		};
		const fac = open()({ action: "publish", name: "missing-sidecar", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-sidecar" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-MS", brief: "Sidecar loss test", authority: auth });
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

		const sessionDir = launched.manifest.session_dir;
		const sidecarPath = join(sessionDir, "factory-run.json");
		const manifestPath = join(sessionDir, "manifest.json");
		const releasePath = join(sessionDir, "release.json");
		const manifestBefore = readFileSync(manifestPath, "utf8");
		const releaseBefore = readFileSync(releasePath, "utf8");

		rmSync(sidecarPath);
		assert.equal(existsSync(sidecarPath), false);

		const st = service.status(launched.task_id, cwd);
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "uncertain");
		assert.match(st.manifest.error ?? "", /Missing factory-run\.json/i);

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].run?.status, "error");
		assert.equal(inspected.attempts[0].run?.phase, "uncertain");
		assert.match(inspected.attempts[0].run?.error ?? "", /Missing factory-run\.json/i);
		assert.ok(inspected.attempts[0].uncertainty?.some(msg => /Missing factory-run\.json/i.test(msg)));
		assert.ok(inspected.uncertainty.some(msg => /Missing factory-run\.json/i.test(msg)));
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.match(inspected.head_status.reason ?? "", /Missing factory-run\.json/i);

		// Read-only inspect must leave holds and run files untouched.
		assert.equal(existsSync(sidecarPath), false);
		assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
		assert.equal(readFileSync(releasePath, "utf8"), releaseBefore);
		const dbCheck = new DatabaseSync(database);
		const coordCheck = new DatabaseSync(coordDatabase);
		try {
			assert.equal((dbCheck.prepare("SELECT state FROM factory_holds WHERE factory_id = ?").get(fac.factory_id) as { state: string }).state, "released");
			assert.equal((coordCheck.prepare("SELECT state FROM checkout_holds WHERE task_id = ?").get(launched.task_id) as { state: string }).state, "released");
		} finally {
			dbCheck.close();
			coordCheck.close();
		}

		// Inspect with bootstrap.status unavailable still diagnoses missing sidecar via shared release reader.
		const noStatusOps = factoryOperations(
			database,
			{ prepareDefinition: (d, m) => service.prepareDefinition(d, m) },
			{ coordinationPath: coordDatabase },
		);
		const noStatusInspected = noStatusOps({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(noStatusInspected.capacity.factory_slot, "uncertain");
		assert.equal(noStatusInspected.capacity.checkout_slot, "uncertain");
		assert.equal(noStatusInspected.head_status.blocking_kind, "uncertain");
		assert.ok(noStatusInspected.attempts[0].uncertainty?.some(msg => /Missing factory-run\.json/i.test(msg)));
		assert.ok(noStatusInspected.uncertainty.some(msg => /Missing factory-run\.json/i.test(msg)));
	}

	// 2. With bootstrap.status unavailable, a pre-run reserve_after_commit hold (no sessionDir yet) remains 'held', not 'uncertain'.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo-pre-run");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));
		const fState = join(root, "fs");
		const bState = join(root, "bs");
		const db = join(fState, "factories.sqlite");
		const baseEnv = { ...iso.env, PATH: bin };
		const svc = new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir, stateDir: bState, home: iso.home, env: baseEnv });
		const fac = factoryOperations(db, svc)({
			action: "publish",
			name: "pre-run-no-status",
			draft: { project_cwd: repo, topology: "graph", task: "Pre-run hold", agents: [{ persona: "worker", node_id: "w", sub_task: "Work" }] },
			sessionModel,
		});
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "reserve_after_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const noStatusOps = factoryOperations(db, {
			prepareDefinition: (d, m) => svc.prepareDefinition(d, m),
			defaultCoordinationPath: () => svc.defaultCoordinationPath(),
		});
		const inspected = noStatusOps({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.uncertainty.length, 0);
		assert.equal(inspected.capacity.factory_slot, "held");
		assert.equal(inspected.capacity.checkout_slot, "held");
		assert.equal(inspected.head_status.blocking_kind, "factory_held");
		assert.equal(inspected.attempts[0].release_authorized, false);
	}
});

test("Slice 8e: active launch with premature factory release.json surfaces uncertainty while normal in-progress launch stays launching", async t => {
	const { root, cwd, service, configs } = serviceFixture(t, ["builder"]);
	const database = join(root, "factories.sqlite");
	const coordDatabase = join(root, "factory-coordination.sqlite");
	const open = () => factoryOperations(database, service, { coordinationPath: coordDatabase });

	const draft: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: "Active launch marker contradiction",
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	};
	const fac = open()({ action: "publish", name: "active-launch-marker", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "mgr-active-marker" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-ALM", brief: "Check live release.json", authority: auth });

	let observedNormalLive = false;
	let checkedInjectedMarker = false;
	const launched = await open()({
		action: "launch",
		factory_id: fac.factory_id,
		authority: auth,
		assertAuthorityAndTrust: () => {
			if (configs.length !== 1 || checkedInjectedMarker) return;
			checkedInjectedMarker = true;
			const cfg = configs[0]!;

			// Normal in-progress launch with no release.json remains launching / factory_held with zero uncertainty.
			const normalStatus = service.status(cfg.task_id, cwd);
			assert.equal(normalStatus.manifest.status, "launching");
			const normalInspected = open()({ action: "inspect", factory_id: fac.factory_id });
			assert.equal(normalInspected.uncertainty.length, 0);
			assert.equal(normalInspected.capacity.factory_slot, "held");
			assert.equal(normalInspected.capacity.checkout_slot, "held");
			assert.equal(normalInspected.head_status.blocking_kind, "factory_held");
			assert.equal(normalInspected.attempts[0].release_authorized, false);
			assert.equal(normalInspected.attempts[0].run?.status, "launching");
			observedNormalLive = true;

			// Inject valid factory-shaped release.json before SQLite release authorization.
			const releaseFile = join(cfg.session_dir, "release.json");
			atomicJson(releaseFile, {
				task_id: cfg.task_id,
				token: cfg.token,
				factory_managed: {
					factory_id: cfg.factory_managed!.factory_id,
					input_id: cfg.factory_managed!.input_id,
					attempt_id: cfg.factory_managed!.attempt_id,
					request_id: cfg.factory_managed!.request_id,
				},
			});
			try {
				const stDuring = service.status(cfg.task_id, cwd);
				assert.equal(stDuring.manifest.status, "error");
				assert.equal(stDuring.manifest.phase, "uncertain");
				assert.match(stDuring.manifest.error ?? "", /release\.json.*without.*authorization/i);

				const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
				assert.equal(inspected.capacity.factory_slot, "uncertain");
				assert.equal(inspected.capacity.checkout_slot, "uncertain");
				assert.equal(inspected.head_status.blocking_kind, "uncertain");
				assert.match(inspected.head_status.reason ?? "", /release\.json.*without.*authorization/i);
				assert.ok(inspected.uncertainty.some(msg => /release\.json.*without.*authorization/i.test(msg)));
				assert.equal(inspected.attempts[0].release_authorized, false);
				assert.equal(inspected.attempts[0].run?.status, "error");
				assert.equal(inspected.attempts[0].run?.phase, "uncertain");
			} finally {
				rmSync(releaseFile, { force: true });
			}
		},
	});

	assert.equal(observedNormalLive, true);
	assert.equal(checkedInjectedMarker, true);
	assert.equal(launched.release_authorized, true);
	assert.equal(launched.manifest.status, "applied");
	assert.equal(launched.manifest.phase, "released");

	const finalInspected = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(finalInspected.uncertainty.length, 0);
	assert.equal(finalInspected.capacity.factory_slot, "held");
	assert.equal(finalInspected.capacity.checkout_slot, "held");
	assert.equal(finalInspected.attempts[0].release_authorized, true);
});

test("Slice 9a: final release fence rejects existing/broken-symlink release.json before commit and publishExclusive prevents post-commit overwrite", async t => {
	const draftFor = (cwd: string, task: string): GenerateRequest => ({
		project_cwd: cwd,
		topology: "graph",
		task,
		agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }],
	});

	// 1. Unexpected malformed release.json left in place during readiness is rejected before SQLite release authorization;
	// exact bytes are preserved, holds remain occupied/uncertain, and real worker receives no prompt.
	{
		const { cwd, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "pre-commit-unexpected-marker", draft: draftFor(cwd, "Unexpected marker"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-1" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-1", brief: "Leave malformed marker", authority: auth });

		const malformedBytes = "{malformed-unexpected-release-marker\n";
		let plantedPath: string | undefined;
		let cfgPath: string | undefined;
		await assert.rejects(
			() => open()({
				action: "launch",
				factory_id: fac.factory_id,
				authority: auth,
				assertAuthorityAndTrust: () => {
					if (configs.length !== 1 || plantedPath) return;
					const cfg = configs[0]!;
					plantedPath = join(cfg.session_dir, "release.json");
					cfgPath = join(cfg.session_dir, `${cfg.instance_id}.config.json`);
					writeFileSync(plantedPath, malformedBytes, "utf8");
				},
			}),
			/release\.json|exists|unexpected/i,
		);

		assert.ok(plantedPath && cfgPath);
		assert.equal(readFileSync(plantedPath!, "utf8"), malformedBytes, "Unexpected release.json bytes must be retained untouched");

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");

		const w = workerFromConfig(t, cfgPath!);
		await w.start();
		const prompt = await w.beforeStart();
		assert.equal(prompt, undefined, "Worker must not receive first prompt when release_authorized=false");
		assert.ok(w.aborts >= 1);
	}

	// 2. Broken symlink at release.json planted in release_before_commit also fails closed before commit and stays untouched.
	{
		const { cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "pre-commit-broken-symlink", draft: draftFor(cwd, "Broken symlink marker"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-2" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-2", brief: "Broken symlink", authority: auth });

		let symlinkedReleasePath: string | undefined;
		const opsWithFault = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_before_commit") {
					const cfg = configs[0]!;
					symlinkedReleasePath = join(cfg.session_dir, "release.json");
					symlinkSync(join(cfg.session_dir, "nonexistent-target.json"), symlinkedReleasePath);
				}
			},
		});
		await assert.rejects(
			() => opsWithFault({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/release\.json|exists|symlink|unexpected/i,
		);

		assert.ok(symlinkedReleasePath);
		assert.equal(lstatSync(symlinkedReleasePath!).isSymbolicLink(), true, "Broken symlink must remain untouched");
		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
	}

	// 3. Racing marker introduced at release_after_commit (after SQLite release authorization commit)
	// cannot be overwritten by publishExclusive; launch rejects, original bytes preserved, no abort.json,
	// holds retained as uncertain, and worker does not receive a prompt.
	{
		const { cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "post-commit-race-marker", draft: draftFor(cwd, "Post-commit race"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-3" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-3", brief: "Post-commit race", authority: auth });

		const racingBytes = JSON.stringify({ task_id: "wrong-task", token: "racing-token" });
		let sessionDir: string | undefined;
		let cfgPath: string | undefined;
		const opsWithRace = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_after_commit") {
					const cfg = configs[0]!;
					sessionDir = cfg.session_dir;
					cfgPath = join(cfg.session_dir, `${cfg.instance_id}.config.json`);
					writeFileSync(join(cfg.session_dir, "release.json"), racingBytes, "utf8");
				}
			},
		});
		await assert.rejects(
			() => opsWithRace({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/release\.json|overwrite|exists|contradictory/i,
		);

		assert.ok(sessionDir && cfgPath);
		assert.equal(readFileSync(join(sessionDir!, "release.json"), "utf8"), racingBytes, "Racing marker bytes must be preserved");
		assert.equal(existsSync(join(sessionDir!, "abort.json")), false, "Must not write abort.json after release commit");

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, true);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.equal(inspected.attempts[0].run?.status, "error");
		assert.equal(inspected.attempts[0].run?.phase, "uncertain");

		const w = workerFromConfig(t, cfgPath!);
		await w.start();
		const prompt = await w.beforeStart();
		assert.equal(prompt, undefined, "Worker must reject contradictory racing release.json without prompt");
		assert.ok(w.aborts >= 1);
	}

	// 3b. Racing marker introduced at release_after_commit using pre-release worker config identifiers
	// ({ task_id, token, factory_managed }) is NOT overwritten by publishExclusive, rejects launch,
	// and real workerFromConfig + beforeStart MUST reject without a first prompt.
	{
		const { cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "post-commit-prerelease-id-race", draft: draftFor(cwd, "Pre-release ID race"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-3b" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-3b", brief: "Pre-release ID race", authority: auth });

		let racingBytes: string | undefined;
		let sessionDir: string | undefined;
		let cfgPath: string | undefined;
		const opsWithPreReleaseIdRace = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_after_commit") {
					const cfg = configs[0]!;
					sessionDir = cfg.session_dir;
					cfgPath = join(cfg.session_dir, `${cfg.instance_id}.config.json`);
					racingBytes = JSON.stringify({
						task_id: cfg.task_id,
						token: cfg.token,
						factory_managed: cfg.factory_managed,
					});
					writeFileSync(join(cfg.session_dir, "release.json"), racingBytes, "utf8");
				}
			},
		});
		await assert.rejects(
			() => opsWithPreReleaseIdRace({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/release\.json|overwrite|exists|contradictory/i,
		);

		assert.ok(sessionDir && cfgPath && racingBytes);
		assert.equal(readFileSync(join(sessionDir!, "release.json"), "utf8"), racingBytes, "Pre-release racing marker bytes must be preserved");
		assert.equal(existsSync(join(sessionDir!, "abort.json")), false, "Must not write abort.json after release commit");

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, true);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.equal(inspected.attempts[0].run?.status, "error");
		assert.equal(inspected.attempts[0].run?.phase, "uncertain");

		const w = workerFromConfig(t, cfgPath!);
		await w.start();
		const prompt = await w.beforeStart();
		assert.equal(prompt, undefined, "Worker must reject pre-release-identifier racing release.json without prompt");
		assert.ok(w.aborts >= 1);

		// Even adding a guessed/wrong release_nonce still fails digest verification against SQLite attempt row.
		const parsedRace = JSON.parse(racingBytes!) as Record<string, unknown>;
		atomicJson(join(sessionDir!, "release.json"), {
			...parsedRace,
			factory_managed: {
				...(parsedRace.factory_managed as Record<string, unknown>),
				release_nonce: "00000000-0000-4000-8000-000000000000",
			},
		});
		const inspectWrongNonce = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectWrongNonce.capacity.factory_slot, "uncertain");
		assert.match(inspectWrongNonce.uncertainty.join("; "), /nonce digest mismatch/i);
		const wWrongNonce = workerFromConfig(t, cfgPath!);
		await wWrongNonce.start();
		assert.equal(await wWrongNonce.beforeStart(), undefined);
		assert.ok(wWrongNonce.aborts >= 1);
	}

	// 3c. Release nonce is never written to pre-release manifest/configs/sidecar, and managed workers/inspect
	// reject symlink or FIFO release.json before any read without blocking.
	{
		const { cwd, database, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "nonce-isolation-and-fifo", draft: draftFor(cwd, "Nonce & FIFO guard"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-3c" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-3c", brief: "Nonce & FIFO", authority: auth });

		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
		const cfg = configs[0]!;
		const cfgPath = join(launched.manifest.session_dir, `${cfg.instance_id}.config.json`);
		const releaseFile = join(launched.manifest.session_dir, "release.json");
		const releaseJsonText = readFileSync(releaseFile, "utf8");
		const parsedRelease = JSON.parse(releaseJsonText) as { factory_managed: { release_nonce: string } };
		const nonce = parsedRelease.factory_managed.release_nonce;
		assert.ok(typeof nonce === "string" && nonce.length > 0);
		assert.equal(readFileSync(join(launched.manifest.session_dir, "manifest.json"), "utf8").includes(nonce), false);
		assert.equal(readFileSync(cfgPath, "utf8").includes(nonce), false);
		assert.equal(readFileSync(join(launched.manifest.session_dir, "factory-run.json"), "utf8").includes(nonce), false);
		const checkDb = new DatabaseSync(database);
		try {
			const row = checkDb.prepare("SELECT release_nonce_digest FROM factory_attempts WHERE attempt_id = ?").get(launched.attempt_id) as { release_nonce_digest: string } | undefined;
			assert.ok(row && /^[a-f0-9]{64}$/.test(row.release_nonce_digest));
			assert.notEqual(row.release_nonce_digest, nonce);
		} finally {
			checkDb.close();
		}

		// Replace release.json with a symlink to a copy of the valid marker: managed worker and inspect must reject without reading.
		const targetCopy = join(launched.manifest.session_dir, "copied-release.json");
		writeFileSync(targetCopy, releaseJsonText, "utf8");
		rmSync(releaseFile);
		symlinkSync(targetCopy, releaseFile);
		const inspectSymlink = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectSymlink.capacity.factory_slot, "uncertain");
		assert.match(inspectSymlink.uncertainty.join("; "), /symlink/i);
		const wSymlink = workerFromConfig(t, cfgPath);
		await wSymlink.start();
		assert.equal(await wSymlink.beforeStart(), undefined);
		assert.ok(wSymlink.aborts >= 1);

		// Replace release.json with a FIFO (named pipe): managed worker and inspect must fail immediately without blocking.
		rmSync(releaseFile);
		execFileSync("mkfifo", [releaseFile]);
		assert.equal(lstatSync(releaseFile).isFIFO(), true);
		const inspectFifo = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectFifo.capacity.factory_slot, "uncertain");
		assert.match(inspectFifo.uncertainty.join("; "), /non-regular/i);
		const wFifo = workerFromConfig(t, cfgPath);
		await wFifo.start();
		assert.equal(await wFifo.beforeStart(), undefined);
		assert.ok(wFifo.aborts >= 1);
	}

	// 4. Failure after release.json link but before directory fsync fails conservatively without declaring pre-release failure or writing abort.json.
	if (process.getuid?.() !== 0) {
		const { cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({ action: "publish", name: "post-link-dirsync-fail", draft: draftFor(cwd, "Dir sync failure"), sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "mgr-9a-4" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9a-4", brief: "Dir sync error", authority: auth });

		let sessionDir: string | undefined;
		t.after(() => { if (sessionDir) try { chmodSync(sessionDir, 0o700); } catch { /* ignore */ } });
		const opsDirSyncFail = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_after_commit") {
					sessionDir = configs[0]!.session_dir;
					chmodSync(sessionDir, 0o300);
				}
			},
		});
		await assert.rejects(
			() => opsDirSyncFail({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/EACCES|permission/i,
		);
		chmodSync(sessionDir!, 0o700);

		assert.equal(existsSync(join(sessionDir!, "release.json")), true, "Valid release.json was already linked before dir sync");
		assert.equal(existsSync(join(sessionDir!, "abort.json")), false, "Must not write abort.json when release.json may already be linked");
		const persisted = readJson<{ status: string; phase: string }>(join(sessionDir!, "manifest.json"));
		assert.equal(persisted.status, "error");
		assert.equal(persisted.phase, "uncertain");
	}
});

test("Slice 9b: physical checkout identity blocks concurrent launch across directory rename, replacement, and path-only legacy schema", async t => {
	// 1. Live supervised child holding cwd across rename + real fixture worker + separate state roots + orphaned managed_runs + recreated path + unrelated checkout.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const bin = join(root, "bin");
		const repoA = join(root, "repo-a");
		const repoAMoved = join(root, "repo-a-moved");
		const repoC = join(root, "repo-c");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		for (const repo of [repoA, repoC]) {
			mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
			mkdirSync(join(repo, "extensions"), { recursive: true });
			writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
			writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		}
		const baseEnv = { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-rename" };
		const makeSvc = (stateDir: string, tabs: string[]) => new BootstrapService({
			exec: async (_cmd, args) => {
				const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
				if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-rename" } });
				if (args[0] === "tab" && args[1] === "create") {
					const label = args[args.indexOf("--label") + 1];
					const cwdArg = args[args.indexOf("--cwd") + 1];
					tabs.push(`${label}@${cwdArg}`);
					return ok({ tab: { tab_id: `t-${tabs.length}` }, root_pane: { pane_id: `p-${tabs.length}`, terminal_id: `term-${tabs.length}` } });
				}
				if (args[0] === "pane" && args[1] === "run") {
					const [label, tabCwd] = tabs.at(-1)!.split("@");
					const [task, instance] = label.split(":");
					const sDir = join(tabCwd, ".pi", "agent-sessions", task);
					const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
					const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `s-${instance}`, endpoint: "/tmp/c", model: cfg.expected_model };
					atomicJson(readyPath(sDir, instance), ready);
					const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
					mkdirSync(regDir, { recursive: true });
					atomicJson(join(regDir, `${instance}.json`), ready);
					return ok();
				}
				throw new Error(`Unexpected herdr ${args.join(" ")}`);
			},
			extensionDir,
			stateDir,
			home: iso.home,
			env: baseEnv,
			pollMs: 5,
		});

		const dbA = join(root, "fstate-a", "factories.sqlite");
		const dbB = join(root, "fstate-b", "factories.sqlite");
		const dbB2 = join(root, "fstate-b2", "factories.sqlite");
		const dbC = join(root, "fstate-c", "factories.sqlite");
		const coordDb = join(root, "coord", "factory-coordination.sqlite");

		const tabsA: string[] = [];
		const tabsB: string[] = [];
		const tabsB2: string[] = [];
		const tabsC: string[] = [];
		const svcA = makeSvc(join(root, "bstate-a"), tabsA);
		const svcB = makeSvc(join(root, "bstate-b"), tabsB);
		const svcB2 = makeSvc(join(root, "bstate-b2"), tabsB2);
		const svcC = makeSvc(join(root, "bstate-c"), tabsC);
		const openA = () => factoryOperations(dbA, svcA, { coordinationPath: coordDb });
		const openB = () => factoryOperations(dbB, svcB, { coordinationPath: coordDb });
		const openB2 = () => factoryOperations(dbB2, svcB2, { coordinationPath: coordDb });
		const openC = () => factoryOperations(dbC, svcC, { coordinationPath: coordDb });

		const draftFor = (repo: string, task: string): GenerateRequest => ({
			project_cwd: repo,
			topology: "graph",
			task,
			agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }],
		});
		const workerSessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" };
		const facA = openA()({ action: "publish", name: "fac-a-rename", draft: draftFor(repoA, "Hold A"), sessionModel: workerSessionModel });
		const authA = createManagerAuthority({ pi_session_id: "mgr-rename-a" });
		openA()({ action: "resume", factory_id: facA.factory_id, authority: authA });
		openA()({ action: "submit", factory_id: facA.factory_id, reference: "Ref-RA", brief: "Brief A", authority: authA });
		const launchedA = await openA()({ action: "launch", factory_id: facA.factory_id, authority: authA });
		assert.equal(launchedA.release_authorized, true);

		// Admit real fixture worker in A before renaming directory.
		const workerA = workerFromConfig(t, join(launchedA.manifest.session_dir, "a1-w.config.json"));
		await workerA.start();
		const promptA = await workerA.beforeStart();
		assert.ok(promptA?.systemPrompt);

		// Supervised child whose process cwd is repoA stays alive across the directory rename and confirms inode identity.
		const watcher = spawnGroup(process.execPath, ["-e", [
			'const fs = require("node:fs");',
			'const statNow = () => { const s = fs.statSync(".", { bigint: true }); return `${s.dev}:${s.ino}`; };',
			'process.stdout.write(statNow() + "\\n");',
			'process.stdin.on("data", () => { process.stdout.write(statNow() + "\\n"); });',
		].join(" ")], { cwd: repoA, env: baseEnv });
		t.after(() => watcher.stop());
		const lines: string[] = [];
		let buf = "";
		watcher.child.stdout.on("data", chunk => {
			buf += chunk.toString();
			while (buf.includes("\n")) {
				const idx = buf.indexOf("\n");
				lines.push(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
			}
		});
		const waitLine = async (count: number) => {
			const deadline = Date.now() + 3000;
			while (lines.length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
			assert.ok(lines.length >= count, `Timed out waiting for watcher output line ${count}`);
			return lines[count - 1]!;
		};
		const beforeInode = await waitLine(1);

		renameSync(repoA, repoAMoved);
		watcher.child.stdin.write("check\n");
		const afterInode = await waitLine(2);
		assert.equal(afterInode, beforeInode, "Supervised child cwd must retain identical (dev, ino) across rename");

		// Factory B (separate state roots, shared coordDb) targets the renamed path repoAMoved.
		const facB = openB()({ action: "publish", name: "fac-b-moved", draft: draftFor(repoAMoved, "Contender B"), sessionModel });
		const authB = createManagerAuthority({ pi_session_id: "mgr-rename-b" });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
		openB()({ action: "submit", factory_id: facB.factory_id, reference: "Ref-RB", brief: "Brief B", authority: authB });

		const inspectB = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.notEqual(inspectB.capacity.checkout_slot, "free", "Renamed checkout must not appear free");
		assert.equal(inspectB.head_status.eligible, false);
		await assert.rejects(() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }), /held|uncertain|physical|checkout|prior path/i);
		const inspectBAfter = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectBAfter.attempts.length, 0);
		assert.equal(inspectBAfter.queue[0].disposition, "queued");
		assert.equal(tabsB.length, 0, "Blocked Factory B must not create tabs or launch workers");

		// Unrelated checkout repoC proceeds normally even while repoA was renamed.
		const facC = openC()({ action: "publish", name: "fac-c-unrelated", draft: draftFor(repoC, "Unrelated C"), sessionModel });
		const authC = createManagerAuthority({ pi_session_id: "mgr-rename-c" });
		openC()({ action: "resume", factory_id: facC.factory_id, authority: authC });
		openC()({ action: "submit", factory_id: facC.factory_id, reference: "Ref-RC", brief: "Brief C", authority: authC });
		const inspectC = openC()({ action: "inspect", factory_id: facC.factory_id });
		assert.equal(inspectC.capacity.checkout_slot, "free");
		assert.equal(inspectC.head_status.eligible, true);
		const launchedC = await openC()({ action: "launch", factory_id: facC.factory_id, authority: authC });
		assert.equal(launchedC.release_authorized, true);

		// Recreating a new directory at original repoA path still blocks conservatively against A's path-keyed hold.
		mkdirSync(join(repoA, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repoA, "extensions"), { recursive: true });
		writeFileSync(join(repoA, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repoA, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		const facB2 = openB2()({ action: "publish", name: "fac-b2-recreated", draft: draftFor(repoA, "Recreated path"), sessionModel });
		const authB2 = createManagerAuthority({ pi_session_id: "mgr-rename-b2" });
		openB2()({ action: "resume", factory_id: facB2.factory_id, authority: authB2 });
		openB2()({ action: "submit", factory_id: facB2.factory_id, reference: "Ref-RB2", brief: "Brief B2", authority: authB2 });
		const inspectB2 = openB2()({ action: "inspect", factory_id: facB2.factory_id });
		assert.equal(inspectB2.capacity.checkout_slot, "uncertain");
		assert.equal(inspectB2.head_status.blocking_kind, "uncertain");
		await assert.rejects(() => openB2()({ action: "launch", factory_id: facB2.factory_id, authority: authB2 }), /uncertain|physical|hold/i);
		assert.equal(tabsB2.length, 0);

		// Missing checkout_holds while managed_runs survives STILL blocks after rename by physical identity.
		const rawCoord = new DatabaseSync(coordDb);
		try {
			rawCoord.prepare("DELETE FROM checkout_holds WHERE task_id = ?").run(launchedA.task_id);
		} finally {
			rawCoord.close();
		}
		const inspectBOrphan = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectBOrphan.capacity.checkout_slot, "uncertain");
		assert.equal(inspectBOrphan.head_status.blocking_kind, "uncertain");
		await assert.rejects(() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }), /managed_run|uncertain|orphaned/i);
	}

	// 2. Physical directory replacement between readiness and release fails closed at release fence without authorizing release.
	{
		const { root, cwd, configs, open } = launchFixture(t);
		const fac = open()({
			action: "publish",
			name: "replace-before-release",
			draft: { project_cwd: cwd, topology: "graph", task: "Replace checkout", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-replace-rel" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-Rep", brief: "Replace dir", authority: auth });

		let swapped = false;
		const movedAside = join(root, "project-moved-aside");
		await assert.rejects(
			() => open()({
				action: "launch",
				factory_id: fac.factory_id,
				authority: auth,
				assertAuthorityAndTrust: () => {
					if (configs.length !== 1 || swapped) return;
					swapped = true;
					renameSync(cwd, movedAside);
					cpSync(movedAside, cwd, { recursive: true });
				},
			}),
			/physical|checkout|identity|mismatch/i,
		);
		assert.equal(swapped, true);
		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts.length, 1);
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(existsSync(join(cwd, ".pi", "agent-sessions", inspected.attempts[0].task_id, "release.json")), false);
	}

	// 2b. Physical directory replacement after SQLite release commit (at release_after_commit) fails as uncertain without publishing release.json,
	// and worker-side final physical checkout check rejects replacement before passing release without invalidating already-admitted work.
	{
		const { root, cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({
			action: "publish",
			name: "replace-after-release-commit",
			draft: { project_cwd: cwd, topology: "graph", task: "Replace after commit", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-replace-post" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-Rep-Post", brief: "Replace dir post commit", authority: auth });

		let swapped = false;
		let sessionDir: string | undefined;
		const movedAside = join(root, "project-moved-post-commit");
		const opsPostReplace = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_after_commit" && !swapped) {
					swapped = true;
					sessionDir = configs[0]!.session_dir;
					renameSync(cwd, movedAside);
					cpSync(movedAside, cwd, { recursive: true });
				}
			},
		});
		await assert.rejects(
			() => opsPostReplace({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/physical|checkout|identity|changed/i,
		);
		assert.equal(swapped, true);
		assert.ok(sessionDir);
		assert.equal(existsSync(join(sessionDir!, "release.json")), false, "Must not publish release.json if checkout was replaced post-commit");
		assert.equal(existsSync(join(sessionDir!, "abort.json")), false, "Must not write abort.json after release commit");
		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts[0].release_authorized, true);
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.attempts[0].run?.status, "error");
		assert.equal(inspected.attempts[0].run?.phase, "uncertain");

		// Separate checkout: healthy launch succeeds, then checkout is replaced before worker passes release barrier -> worker must refuse prompt.
		const run2 = launchFixture(t);
		const fac2 = run2.open()({
			action: "publish",
			name: "worker-replace-before-release-pass",
			draft: { project_cwd: run2.cwd, topology: "graph", task: "Worker pre-release checkout swap", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth2 = createManagerAuthority({ pi_session_id: "mgr-worker-swap" });
		run2.open()({ action: "resume", factory_id: fac2.factory_id, authority: auth2 });
		run2.open()({ action: "submit", factory_id: fac2.factory_id, reference: "Ref-W-Swap", brief: "Worker checkout swap", authority: auth2 });
		const launched2 = await run2.open()({ action: "launch", factory_id: fac2.factory_id, authority: auth2 });
		const cfg2Path = join(launched2.manifest.session_dir, `${launched2.manifest.pane_manifest[0]!.instance_id}.config.json`);

		const moved2 = join(run2.root, "repo2-moved");
		renameSync(run2.cwd, moved2);
		cpSync(moved2, run2.cwd, { recursive: true });

		const w2 = workerFromConfig(t, cfg2Path);
		await w2.start();
		const prompt2 = await w2.beforeStart();
		assert.equal(prompt2, undefined, "Worker must refuse prompt when physical checkout identity changed before release pass");
		assert.ok(w2.aborts >= 1);
	}

	// 3. Healthy ticket-02 (user_version = 2) DB reads/admission are preserved and upgrade cleanly on launch;
	// path-only v3 / coord v1 records fail closed with diagnostic without silent rekeying/clearance.
	{
		const { cwd, service, database, coordDatabase, open } = launchFixture(t);
		const fac = open()({
			action: "publish",
			name: "v2-upgrade",
			draft: { project_cwd: cwd, topology: "graph", task: "V2 upgrade", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-v2" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-V2", brief: "V2 brief", authority: auth });

		const checkV2 = new DatabaseSync(database);
		try {
			assert.equal(checkV2.prepare("PRAGMA user_version").get()?.user_version, 2);
		} finally {
			checkV2.close();
		}
		assert.equal(open()({ action: "inspect", factory_id: fac.factory_id }).head_status.eligible, true);
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
		assert.equal(launched.release_authorized, true);

		// Simulate unintegrated path-only v3 DB / coord v1 DB -> must fail closed with diagnostic.
		const legacyDb = join(cwd, "..", "legacy-v3.sqlite");
		const legacyCoord = join(cwd, "..", "legacy-coord-v1.sqlite");
		const d1 = new DatabaseSync(legacyDb);
		try {
			d1.exec("CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT; PRAGMA user_version = 3;");
		} finally {
			d1.close();
		}
		const d2 = new DatabaseSync(legacyCoord);
		try {
			d2.exec("CREATE TABLE coord_meta (id INTEGER PRIMARY KEY, anchor_id TEXT NOT NULL, created_at TEXT NOT NULL, record_digest TEXT NOT NULL) STRICT; PRAGMA user_version = 1;");
		} finally {
			d2.close();
		}
		assert.throws(
			() => factoryOperations(legacyDb, service, { coordinationPath: coordDatabase })({ action: "list" }),
			/path-only|version 3|unsupported/i,
		);
		const inspectedLegacyCoord = factoryOperations(database, service, { coordinationPath: legacyCoord })({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectedLegacyCoord.capacity.checkout_slot, "uncertain");
		assert.match(inspectedLegacyCoord.uncertainty.join("; "), /path-only|version 1|unsupported/i);
	}
});

test("Slice 9c: cross-root holder inspection validates release token and durable proof via shared release reader without nested SQLite self-locking", async t => {
	// 1. Cross-root release.json token tampered to another non-empty string propagates uncertainty read-only to contender B.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const baseEnv = { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-cross" };
		const makeSvc = (stateDir: string) => {
			const tabs: Array<{ pane_id: string; label: string }> = [];
			let seq = 0;
			return new BootstrapService({
				exec: async (_cmd, args) => {
					const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
					if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-cross" } });
					if (args[0] === "tab" && args[1] === "create") {
						seq++;
						const tab = { tab_id: `tc-${seq}`, pane_id: `pc-${seq}`, terminal_id: `termc-${seq}`, label: args[args.indexOf("--label") + 1] };
						tabs.push(tab);
						return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
					}
					if (args[0] === "pane" && args[1] === "run") {
						const tab = tabs.find(item => item.pane_id === args[2])!;
						const [task, instance] = tab.label.split(":");
						const sDir = join(repo, ".pi", "agent-sessions", task);
						const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
						const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `s-${instance}`, endpoint: "/tmp/c", model: cfg.expected_model };
						atomicJson(readyPath(sDir, instance), ready);
						const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
						mkdirSync(regDir, { recursive: true });
						atomicJson(join(regDir, `${instance}.json`), ready);
						return ok();
					}
					throw new Error(`Unexpected herdr ${args.join(" ")}`);
				},
				extensionDir,
				stateDir,
				home: iso.home,
				env: baseEnv,
				pollMs: 5,
			});
		};

		const dbA = join(root, "fstate-a", "factories.sqlite");
		const dbB = join(root, "fstate-b", "factories.sqlite");
		const coordDb = join(root, "shared-coord.sqlite");
		const svcA = makeSvc(join(root, "bstate-a"));
		const svcB = makeSvc(join(root, "bstate-b"));
		const openA = () => factoryOperations(dbA, svcA, { coordinationPath: coordDb });
		const openB = () => factoryOperations(dbB, svcB, { coordinationPath: coordDb });

		const draft: GenerateRequest = {
			project_cwd: repo,
			topology: "graph",
			task: "Cross-root proof",
			agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }],
		};
		const facA = openA()({ action: "publish", name: "cross-a", draft, sessionModel });
		const facB = openB()({ action: "publish", name: "cross-b", draft, sessionModel });
		const authA = createManagerAuthority({ pi_session_id: "mgr-ca" });
		const authB = createManagerAuthority({ pi_session_id: "mgr-cb" });
		openA()({ action: "resume", factory_id: facA.factory_id, authority: authA });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
		openA()({ action: "submit", factory_id: facA.factory_id, reference: "Ref-CA", brief: "Brief A", authority: authA });
		openB()({ action: "submit", factory_id: facB.factory_id, reference: "Ref-CB", brief: "Brief B", authority: authB });

		const launchedA = await openA()({ action: "launch", factory_id: facA.factory_id, authority: authA });
		assert.equal(launchedA.release_authorized, true);

		// Healthy cross-root inspection sees checkout_held with zero uncertainty.
		const healthyB = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(healthyB.capacity.checkout_slot, "held");
		assert.equal(healthyB.head_status.blocking_kind, "checkout_held");
		assert.equal(healthyB.uncertainty.length, 0);

		// Change ONLY A's release.json token to another non-empty string.
		const releaseFile = join(launchedA.manifest.session_dir, "release.json");
		const parsedRelease = readJson<Record<string, unknown>>(releaseFile);
		atomicJson(releaseFile, { ...parsedRelease, token: "forged-nonempty-token" });
		const tamperedBytes = readFileSync(releaseFile, "utf8");

		const inspectA = openA()({ action: "inspect", factory_id: facA.factory_id });
		assert.equal(inspectA.capacity.checkout_slot, "uncertain");
		assert.match(inspectA.uncertainty.join("; "), /token mismatch/i);

		const inspectB = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectB.capacity.checkout_slot, "uncertain");
		assert.equal(inspectB.head_status.blocking_kind, "uncertain");
		assert.match(inspectB.head_status.reason ?? "", /token mismatch/i);
		assert.ok(inspectB.uncertainty.some(msg => /token mismatch/i.test(msg)));

		// Read-only inspect did not touch release.json bytes or clear holds.
		assert.equal(readFileSync(releaseFile, "utf8"), tamperedBytes);
		const checkA = new DatabaseSync(dbA);
		const checkCoord = new DatabaseSync(coordDb);
		try {
			assert.equal((checkA.prepare("SELECT COUNT(*) AS n FROM factory_holds WHERE factory_id = ?").get(facA.factory_id) as { n: number }).n, 1);
			assert.equal((checkCoord.prepare("SELECT COUNT(*) AS n FROM checkout_holds WHERE task_id = ?").get(launchedA.task_id) as { n: number }).n, 1);
		} finally {
			checkA.close();
			checkCoord.close();
		}

		await assert.rejects(() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }), /token mismatch|uncertain|held/i);
		assert.equal(openB()({ action: "inspect", factory_id: facB.factory_id }).attempts.length, 0);

		// Restore valid release.json, then test missing factory-run.json sidecar and damaged factory_holds.record_digest in A's DB.
		atomicJson(releaseFile, parsedRelease);
		const sidecarPath = join(launchedA.manifest.session_dir, "factory-run.json");
		const sidecarBytes = readFileSync(sidecarPath, "utf8");
		rmSync(sidecarPath);
		const inspectBMissingSidecar = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectBMissingSidecar.capacity.checkout_slot, "uncertain");
		assert.equal(inspectBMissingSidecar.head_status.blocking_kind, "uncertain");
		assert.match(inspectBMissingSidecar.head_status.reason ?? "", /Missing factory-run\.json/i);

		writeFileSync(sidecarPath, sidecarBytes, "utf8");
		const corruptA = new DatabaseSync(dbA);
		try {
			corruptA.prepare("UPDATE factory_holds SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = ?").run(facA.factory_id);
		} finally {
			corruptA.close();
		}
		const inspectBDamagedDb = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectBDamagedDb.capacity.checkout_slot, "uncertain");
		assert.equal(inspectBDamagedDb.head_status.blocking_kind, "uncertain");
		assert.match(inspectBDamagedDb.head_status.reason ?? "", /corruption|mismatch|evidence/i);
	}

	// 2. Healthy interrupted pre-release launch (release_before_commit SIGKILL) in A preserves clean checkout_held in B;
	// and same-DB different-factory launch in B does not self-lock SQLite during reservation.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo-int");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));
		const baseEnv = { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-int" };
		const dbShared = join(root, "shared-fstate", "factories.sqlite");
		const bStateA = join(root, "bs-int-a");
		const bStateB = join(root, "bs-int-b");
		const makeSvc = (stateDir: string) => new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir, stateDir, home: iso.home, env: baseEnv });

		const draft: GenerateRequest = {
			project_cwd: repo,
			topology: "graph",
			task: "Interrupted cross-factory",
			agents: [{ persona: "worker", node_id: "w", sub_task: "Work" }],
		};
		const facA = factoryOperations(dbShared, makeSvc(bStateA))({ action: "publish", name: "int-a", draft, sessionModel });
		const facB = factoryOperations(dbShared, makeSvc(bStateB))({ action: "publish", name: "int-b", draft, sessionModel });
		const authB = createManagerAuthority({ pi_session_id: "mgr-int-b" });
		factoryOperations(dbShared, makeSvc(bStateB))({ action: "resume", factory_id: facB.factory_id, authority: authB });
		factoryOperations(dbShared, makeSvc(bStateB))({ action: "submit", factory_id: facB.factory_id, reference: "Ref-IB", brief: "Brief B", authority: authB });

		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: dbShared, factoryId: facA.factory_id, projectCwd: repo, stateDir: bStateA, home: iso.home, bin, killPhase: "release_before_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const inspectB = factoryOperations(dbShared, makeSvc(bStateB))({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectB.capacity.checkout_slot, "held");
		assert.equal(inspectB.head_status.blocking_kind, "checkout_held");
		assert.equal(inspectB.uncertainty.length, 0);

		await assert.rejects(
			() => factoryOperations(dbShared, makeSvc(bStateB))({ action: "launch", factory_id: facB.factory_id, authority: authB }),
			/held|checkout/i,
		);
	}
});

test("Slice 9d: run-local manifest.json token/identity verification across worker admission, owner inspection, cross-root inspection, and session_dir_removed claims", async t => {
	// 1. Corrupting ONLY A's run-local manifest.json token after launch blocks real worker admission,
	//    surfaces uncertainty on both owning and cross-root inspection, preserves valid local/index transitions,
	//    and leaves files/holds untouched without leaking secrets.
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const baseEnv = { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-9d" };
		const makeSvc = (stateDir: string) => {
			const tabs: Array<{ pane_id: string; label: string }> = [];
			let seq = 0;
			return new BootstrapService({
				exec: async (_cmd, args) => {
					const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
					if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-9d" } });
					if (args[0] === "tab" && args[1] === "create") {
						seq++;
						const tab = { tab_id: `t9d-${seq}`, pane_id: `p9d-${seq}`, terminal_id: `term9d-${seq}`, label: args[args.indexOf("--label") + 1] };
						tabs.push(tab);
						return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
					}
					if (args[0] === "pane" && args[1] === "run") {
						const tab = tabs.find(item => item.pane_id === args[2])!;
						const [task, instance] = tab.label.split(":");
						const sDir = join(repo, ".pi", "agent-sessions", task);
						const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
						const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/9d", model: cfg.expected_model };
						atomicJson(readyPath(sDir, instance), ready);
						const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
						mkdirSync(regDir, { recursive: true });
						atomicJson(join(regDir, `${instance}.json`), ready);
						return ok();
					}
					throw new Error(`Unexpected herdr ${args.join(" ")}`);
				},
				extensionDir,
				stateDir,
				home: iso.home,
				env: baseEnv,
				pollMs: 5,
			});
		};

		const dbA = join(root, "fstate-a", "factories.sqlite");
		const dbB = join(root, "fstate-b", "factories.sqlite");
		const coordDb = join(root, "shared-coord.sqlite");
		const bStateA = join(root, "bstate-a");
		const bStateB = join(root, "bstate-b");
		const svcA = makeSvc(bStateA);
		const svcB = makeSvc(bStateB);
		const openA = () => factoryOperations(dbA, svcA, { coordinationPath: coordDb });
		const openB = () => factoryOperations(dbB, svcB, { coordinationPath: coordDb });

		const draft: GenerateRequest = {
			project_cwd: repo,
			topology: "graph",
			task: "Local manifest release proof",
			agents: [{ persona: "worker", node_id: "w", sub_task: "Run" }],
		};
		const workerSessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" };
		const facA = openA()({ action: "publish", name: "local-a", draft, sessionModel: workerSessionModel });
		const facB = openB()({ action: "publish", name: "local-b", draft, sessionModel: workerSessionModel });
		const authA = createManagerAuthority({ pi_session_id: "mgr-9da" });
		const authB = createManagerAuthority({ pi_session_id: "mgr-9db" });
		openA()({ action: "resume", factory_id: facA.factory_id, authority: authA });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
		openA()({ action: "submit", factory_id: facA.factory_id, reference: "Ref-9dA", brief: "Brief 9d A", authority: authA });
		openB()({ action: "submit", factory_id: facB.factory_id, reference: "Ref-9dB", brief: "Brief 9d B", authority: authB });

		const launchedA = await openA()({ action: "launch", factory_id: facA.factory_id, authority: authA });
		assert.equal(launchedA.release_authorized, true);

		const sessionDir = launchedA.manifest.session_dir;
		const localManifestPath = join(sessionDir, "manifest.json");
		const indexManifestPath = join(bStateA, `${launchedA.task_id}.json`);
		const releasePath = join(sessionDir, "release.json");
		const cfgPath = join(sessionDir, "a1-w.config.json");
		const originalLocalManifestBytes = readFileSync(localManifestPath, "utf8");
		const originalLocalManifest = JSON.parse(originalLocalManifestBytes) as Record<string, any>;
		const originalIndexBytes = readFileSync(indexManifestPath, "utf8");
		const originalReleaseBytes = readFileSync(releasePath, "utf8");
		const realToken = String(originalLocalManifest.token);

		// Pin legitimate local/index phase & progress transition difference:
		// local manifest still has launching/waiting-ready while index has applied/released.
		atomicJson(localManifestPath, {
			...originalLocalManifest,
			status: "launching",
			phase: "waiting-ready",
			pane_manifest: originalLocalManifest.pane_manifest.map((entry: Record<string, unknown>) => ({ ...entry, status: "ready" })),
		});
		const transitionStatusA = svcA.status(launchedA.task_id, repo);
		assert.equal(transitionStatusA.manifest.status, "applied");
		assert.equal(transitionStatusA.manifest.phase, "released");
		const transitionInspectA = openA()({ action: "inspect", factory_id: facA.factory_id });
		assert.equal(transitionInspectA.uncertainty.length, 0);
		assert.equal(transitionInspectA.capacity.factory_slot, "held");
		assert.equal(transitionInspectA.capacity.checkout_slot, "held");
		const transitionInspectB = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(transitionInspectB.uncertainty.length, 0);
		assert.equal(transitionInspectB.capacity.checkout_slot, "held");
		assert.equal(transitionInspectB.head_status.blocking_kind, "checkout_held");
		const wTransition = workerFromConfig(t, cfgPath);
		await wTransition.start();
		const transitionPrompt = await wTransition.beforeStart();
		assert.ok(transitionPrompt?.systemPrompt, "Valid local/index phase transition must allow real worker admission");
		await wTransition.shutdown("reload");

		// Restore local manifest, then corrupt ONLY token in run-local manifest.json.
		writeFileSync(localManifestPath, originalLocalManifestBytes, "utf8");
		const tamperedToken = "tampered-local-manifest-secret-token";
		atomicJson(localManifestPath, { ...originalLocalManifest, token: tamperedToken });
		const tamperedBytes = readFileSync(localManifestPath, "utf8");

		// Real worker fixture must reject at barrier/admission without first model prompt or secret leak.
		const wBad = workerFromConfig(t, cfgPath);
		await wBad.start();
		const badPrompt = await wBad.beforeStart();
		assert.equal(badPrompt, undefined, "Worker must reject tampered run-local manifest token without prompt");
		assert.ok(wBad.aborts >= 1);
		const workerErrPath = join(sessionDir, "a1-w.error.json");
		const workerErrText = readFileSync(workerErrPath, "utf8");
		assert.equal(workerErrText.includes(realToken), false, "Worker error must not leak real token");
		assert.equal(workerErrText.includes(tamperedToken), false, "Worker error must not leak tampered token");
		rmSync(workerErrPath, { force: true });

		// Owning status, owning inspect, owner fallback (noStatusOps), and cross-root inspect must all report uncertain.
		const stA = svcA.status(launchedA.task_id, repo);
		assert.equal(stA.manifest.status, "error");
		assert.equal(stA.manifest.phase, "uncertain");
		assert.equal((stA.manifest.error ?? "").includes(realToken), false);
		assert.equal((stA.manifest.error ?? "").includes(tamperedToken), false);

		const inspectA = openA()({ action: "inspect", factory_id: facA.factory_id });
		assert.equal(inspectA.capacity.factory_slot, "uncertain");
		assert.equal(inspectA.capacity.checkout_slot, "uncertain");
		assert.equal(inspectA.head_status.blocking_kind, "uncertain");
		assert.equal(inspectA.attempts[0].run?.phase, "uncertain");
		assert.ok(inspectA.uncertainty.length > 0);
		assert.equal(JSON.stringify(inspectA).includes(realToken), false, "Owner inspect must not leak real token");
		assert.equal(JSON.stringify(inspectA).includes(tamperedToken), false, "Owner inspect must not leak tampered token");

		const noStatusOpsA = factoryOperations(dbA, { prepareDefinition: (d, m) => svcA.prepareDefinition(d, m) }, { coordinationPath: coordDb });
		const fallbackInspectA = noStatusOpsA({ action: "inspect", factory_id: facA.factory_id });
		assert.equal(fallbackInspectA.capacity.factory_slot, "uncertain");
		assert.equal(fallbackInspectA.capacity.checkout_slot, "uncertain");
		assert.ok(fallbackInspectA.uncertainty.length > 0);

		const inspectB = openB()({ action: "inspect", factory_id: facB.factory_id });
		assert.equal(inspectB.capacity.checkout_slot, "uncertain");
		assert.equal(inspectB.head_status.blocking_kind, "uncertain");
		assert.ok(inspectB.uncertainty.length > 0);
		assert.equal(JSON.stringify(inspectB).includes(realToken), false, "Cross-root inspect must not leak real token");
		assert.equal(JSON.stringify(inspectB).includes(tamperedToken), false, "Cross-root inspect must not leak tampered token");

		await assert.rejects(() => openB()({ action: "launch", factory_id: facB.factory_id, authority: authB }), /uncertain|mismatch|held|contradictory/i);

		// Read-only inspections and worker failure must leave files untouched and holds retained.
		assert.equal(readFileSync(localManifestPath, "utf8"), tamperedBytes);
		assert.equal(readFileSync(indexManifestPath, "utf8"), originalIndexBytes);
		assert.equal(readFileSync(releasePath, "utf8"), originalReleaseBytes);
		const dbCheckA = new DatabaseSync(dbA);
		const dbCheckCoord = new DatabaseSync(coordDb);
		try {
			assert.equal((dbCheckA.prepare("SELECT COUNT(*) AS n FROM factory_holds WHERE factory_id = ?").get(facA.factory_id) as { n: number }).n, 1);
			assert.equal((dbCheckCoord.prepare("SELECT COUNT(*) AS n FROM checkout_holds WHERE task_id = ?").get(launchedA.task_id) as { n: number }).n, 1);
		} finally {
			dbCheckA.close();
			dbCheckCoord.close();
		}

		// Restore valid local manifest; verify post-barrier / pre-admission tamper is also blocked at beforeStart fence.
		writeFileSync(localManifestPath, originalLocalManifestBytes, "utf8");
		const wPostBarrier = workerFromConfig(t, cfgPath);
		await wPostBarrier.start();
		atomicJson(localManifestPath, { ...originalLocalManifest, token: tamperedToken });
		const postBarrierPrompt = await wPostBarrier.beforeStart();
		assert.equal(postBarrierPrompt, undefined, "Admission fence must block first prompt if local manifest token changed after release barrier");
		assert.ok(wPostBarrier.aborts >= 1);
		rmSync(workerErrPath, { force: true });

		// Missing, symlinked, FIFO, and identity-mismatched run-local manifest.json all fail closed across worker, owner, and cross-root.
		rmSync(localManifestPath);
		const wMissing = workerFromConfig(t, cfgPath);
		await wMissing.start();
		assert.equal(await wMissing.beforeStart(), undefined);
		rmSync(workerErrPath, { force: true });
		assert.equal(openA()({ action: "inspect", factory_id: facA.factory_id }).capacity.factory_slot, "uncertain");
		assert.equal(openB()({ action: "inspect", factory_id: facB.factory_id }).capacity.checkout_slot, "uncertain");

		const copiedManifest = join(sessionDir, "copied-manifest.json");
		writeFileSync(copiedManifest, originalLocalManifestBytes, "utf8");
		symlinkSync(copiedManifest, localManifestPath);
		const wSymlink = workerFromConfig(t, cfgPath);
		await wSymlink.start();
		assert.equal(await wSymlink.beforeStart(), undefined);
		rmSync(workerErrPath, { force: true });
		assert.match(openA()({ action: "inspect", factory_id: facA.factory_id }).uncertainty.join("; "), /symlink/i);
		assert.match(openB()({ action: "inspect", factory_id: facB.factory_id }).uncertainty.join("; "), /symlink/i);
		rmSync(localManifestPath);

		execFileSync("mkfifo", [localManifestPath]);
		assert.equal(lstatSync(localManifestPath).isFIFO(), true);
		assert.match(openA()({ action: "inspect", factory_id: facA.factory_id }).uncertainty.join("; "), /non-regular/i);
		assert.match(openB()({ action: "inspect", factory_id: facB.factory_id }).uncertainty.join("; "), /non-regular/i);
		rmSync(localManifestPath);

		// Identity discrepancy (checkout_key mismatch in local manifest factory_managed) fails closed across all 3 paths.
		atomicJson(localManifestPath, {
			...originalLocalManifest,
			factory_managed: { ...originalLocalManifest.factory_managed, checkout_key: "dev:0:ino:999999999" },
		});
		const wBadIdentity = workerFromConfig(t, cfgPath);
		await wBadIdentity.start();
		assert.equal(await wBadIdentity.beforeStart(), undefined);
		rmSync(workerErrPath, { force: true });
		assert.equal(openA()({ action: "inspect", factory_id: facA.factory_id }).capacity.factory_slot, "uncertain");
		assert.equal(openB()({ action: "inspect", factory_id: facB.factory_id }).capacity.checkout_slot, "uncertain");

		// Claiming session_dir_removed: true in indexed manifest cannot bypass required release/local evidence.
		writeFileSync(localManifestPath, originalLocalManifestBytes, "utf8");
		const parsedIdx = JSON.parse(originalIndexBytes) as Record<string, unknown>;
		atomicJson(indexManifestPath, { ...parsedIdx, session_dir_removed: true });
		assert.equal(svcA.status(launchedA.task_id, repo).manifest.phase, "uncertain");
		assert.equal(openA()({ action: "inspect", factory_id: facA.factory_id }).capacity.factory_slot, "uncertain");

		// Even with sessionDir actually deleted after release, session_dir_removed: true must stay uncertain (not applied/released).
		rmSync(sessionDir, { recursive: true, force: true });
		assert.equal(svcA.status(launchedA.task_id, repo).manifest.phase, "uncertain");
		assert.equal(openA()({ action: "inspect", factory_id: facA.factory_id }).capacity.factory_slot, "uncertain");
		assert.equal(openB()({ action: "inspect", factory_id: facB.factory_id }).capacity.checkout_slot, "uncertain");
	}

	// 2. Legitimate pre-release interruption with session_dir_removed: true and no local dir on disk preserves held capacity (not uncertain).
	{
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo-pre");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const childScript = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));
		const baseEnv = { ...iso.env, PATH: bin };
		const fState = join(root, "fs-pre");
		const bState = join(root, "bs-pre");
		const db = join(fState, "factories.sqlite");
		const svc = new BootstrapService({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), extensionDir, stateDir: bState, home: iso.home, env: baseEnv });
		const fac = factoryOperations(db, svc)({
			action: "publish",
			name: "pre-removed",
			draft: { project_cwd: repo, topology: "graph", task: "Pre-release removed", agents: [{ persona: "worker", node_id: "w", sub_task: "Work" }] },
			sessionModel,
		});
		const res = await runSupervised(process.execPath, [childScript, JSON.stringify({
			mode: "kill-launch", database: db, factoryId: fac.factory_id, projectCwd: repo, stateDir: bState, home: iso.home, bin, killPhase: "release_before_commit",
		})], { env: baseEnv, timeoutMs: 10_000 });
		assert.equal(res.signal, "SIGKILL", res.stderr);

		const preInspect = factoryOperations(db, svc)({ action: "inspect", factory_id: fac.factory_id });
		const taskId = preInspect.attempts[0].task_id;
		const idxPath = join(bState, `${taskId}.json`);
		const sDir = join(repo, ".pi", "agent-sessions", taskId);
		rmSync(sDir, { recursive: true, force: true });
		atomicJson(idxPath, { ...readJson<Record<string, unknown>>(idxPath), status: "error", phase: "held", session_dir_removed: true });

		const st = svc.status(taskId, repo);
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "held");
		const afterInspect = factoryOperations(db, svc)({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(afterInspect.uncertainty.length, 0);
		assert.equal(afterInspect.capacity.factory_slot, "held");
		assert.equal(afterInspect.capacity.checkout_slot, "held");
		assert.equal(afterInspect.head_status.blocking_kind, "factory_held");
	}

	// 3. Pre-commit local manifest token corruption at release_before_commit must not authorize,
	//    must reject launch, preserve BOTH persisted manifest copies untouched, keep both holds active,
	//    and retain read-only uncertainty without leaking secrets.
	{
		const { cwd, database, coordDatabase, service, configs, open } = launchFixture(t);
		const fac = open()({
			action: "publish",
			name: "pre-commit-manifest-tamper",
			draft: { project_cwd: cwd, topology: "graph", task: "Pre-commit manifest tamper", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-9d-pre" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9d-pre", brief: "Pre-commit tamper", authority: auth });

		const tamperedPreToken = "tampered-pre-commit-secret-token";
		let sessionDir: string | undefined;
		let cfgPath: string | undefined;
		let realToken: string | undefined;
		let tamperedBytes: string | undefined;
		let indexBytesBeforeFault: string | undefined;
		let taskId: string | undefined;
		const opsPreTamper = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_before_commit") {
					const cfg = configs[0]!;
					taskId = cfg.task_id;
					realToken = cfg.token;
					sessionDir = cfg.session_dir;
					cfgPath = join(sessionDir, `${cfg.instance_id}.config.json`);
					const localPath = join(sessionDir, "manifest.json");
					const localRaw = readJson<Record<string, unknown>>(localPath);
					atomicJson(localPath, { ...localRaw, token: tamperedPreToken });
					tamperedBytes = readFileSync(localPath, "utf8");
					indexBytesBeforeFault = readFileSync(join(service.store.indexRoot, `${taskId}.json`), "utf8");
				}
			},
		});

		await assert.rejects(
			() => opsPreTamper({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/token|manifest\.json/i,
		);

		assert.ok(sessionDir && cfgPath && realToken && tamperedBytes && indexBytesBeforeFault && taskId);
		assert.equal(existsSync(join(sessionDir!, "release.json")), false, "Pre-commit manifest tamper must not publish release.json");
		assert.equal(readFileSync(join(sessionDir!, "manifest.json"), "utf8"), tamperedBytes, "Run-local manifest.json tamper evidence must be preserved");
		assert.equal(readFileSync(join(service.store.indexRoot, `${taskId!}.json`), "utf8"), indexBytesBeforeFault, "Index manifest must be preserved without overwriting");

		const dbCheck = new DatabaseSync(database);
		const coordCheck = new DatabaseSync(coordDatabase);
		try {
			const att = dbCheck.prepare("SELECT state, release_authorized FROM factory_attempts WHERE task_id = ?").get(taskId!) as { state: string; release_authorized: number };
			assert.equal(att.release_authorized, 0);
			assert.equal(att.state, "failed_before_release");
			const fHold = dbCheck.prepare("SELECT state FROM factory_holds WHERE factory_id = ?").get(fac.factory_id) as { state: string };
			assert.equal(fHold.state, "failed_before_release");
			const cHold = coordCheck.prepare("SELECT state FROM checkout_holds WHERE task_id = ?").get(taskId!) as { state: string };
			assert.equal(cHold.state, "failed_before_release");
		} finally {
			dbCheck.close();
			coordCheck.close();
		}

		const st = service.status(taskId!, cwd);
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "uncertain");
		assert.equal((st.manifest.error ?? "").includes(realToken!), false);
		assert.equal((st.manifest.error ?? "").includes(tamperedPreToken), false);

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts[0].release_authorized, false);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.ok(inspected.uncertainty.length > 0);
		assert.equal(JSON.stringify(inspected).includes(realToken!), false);
		assert.equal(JSON.stringify(inspected).includes(tamperedPreToken), false);
		assert.equal(readFileSync(join(sessionDir!, "manifest.json"), "utf8"), tamperedBytes);
		assert.equal(readFileSync(join(service.store.indexRoot, `${taskId!}.json`), "utf8"), indexBytesBeforeFault);

		const w = workerFromConfig(t, cfgPath!);
		await w.start();
		assert.equal(await w.beforeStart(), undefined, "Worker must not admit work after pre-commit manifest tamper");
		assert.ok(w.aborts >= 1);
	}

	// 4. Post-commit local manifest token corruption at release_after_commit must fail closed even while
	//    the launcher lock is held (before release.json publication), while observing the healthy
	//    committed-but-awaiting-publication gap in the same hook before mutating the token keeps
	//    owner launching/held and cross-root uncertain.
	await t.test("4. post-commit release_after_commit live window: healthy awaiting-publication gap and local manifest token tamper", async t2 => {
		const { cwd, home, database, coordDatabase, service, configs, open } = launchFixture(t2);
		const bRoot = join(dirname(database), "cross-b");
		const bState = join(bRoot, "bstate");
		const databaseB = join(bRoot, "factories.sqlite");
		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const serviceB = new BootstrapService({
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			extensionDir,
			stateDir: bState,
			home,
			env: { ...service.getEnvironment().env, HERDR_PANE_ID: "caller-b" },
			pollMs: 5,
		});
		const openB = () => factoryOperations(databaseB, serviceB, { coordinationPath: coordDatabase });

		const facB = openB()({
			action: "publish",
			name: "post-commit-cross-b",
			draft: { project_cwd: cwd, topology: "graph", task: "Cross B", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const authB = createManagerAuthority({ pi_session_id: "mgr-9d-post-b" });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
		openB()({ action: "submit", factory_id: facB.factory_id, reference: "Ref-9d-post-b", brief: "Cross B brief", authority: authB });

		const fac = open()({
			action: "publish",
			name: "post-commit-manifest-tamper",
			draft: { project_cwd: cwd, topology: "graph", task: "Post-commit manifest tamper", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-9d-post" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9d-post", brief: "Post-commit tamper", authority: auth });

		const tamperedPostToken = "tampered-post-commit-secret-token";
		let sessionDir: string | undefined;
		let cfgPath: string | undefined;
		let realToken: string | undefined;
		let tamperedBytes: string | undefined;
		let indexBytesBeforeFault: string | undefined;
		let taskId: string | undefined;
		let observedHealthyGap = false;
		let liveChecked = false;
		let liveError: unknown;
		const opsPostTamper = factoryOperations(database, service, {
			coordinationPath: coordDatabase,
			atLaunchCommit: phase => {
				if (phase === "release_after_commit") {
					const cfg = configs[0]!;
					taskId = cfg.task_id;
					realToken = cfg.token;
					sessionDir = cfg.session_dir;
					cfgPath = join(sessionDir, `${cfg.instance_id}.config.json`);
					const localPath = join(sessionDir, "manifest.json");
					const indexPath = join(service.store.indexRoot, `${taskId}.json`);

					try {
						// Observe healthy committed-but-awaiting-publication gap under owner's live lock BEFORE mutating local manifest.
						assert.equal(existsSync(join(sessionDir, "release.json")), false);
						const healthySt = service.status(taskId, cwd);
						assert.equal(healthySt.manifest.status, "launching");
						assert.equal(healthySt.manifest.phase, "waiting-ready");
						const healthyOwnerInspect = open()({ action: "inspect", factory_id: fac.factory_id });
						assert.equal(healthyOwnerInspect.uncertainty.length, 0);
						assert.equal(healthyOwnerInspect.capacity.factory_slot, "held");
						assert.equal(healthyOwnerInspect.capacity.checkout_slot, "held");
						assert.equal(healthyOwnerInspect.head_status.blocking_kind, "factory_held");
						assert.equal(healthyOwnerInspect.attempts[0].release_authorized, true);
						assert.equal(healthyOwnerInspect.attempts[0].run?.status, "launching");
						assert.equal(healthyOwnerInspect.attempts[0].run?.phase, "waiting-ready");
						assert.equal(healthyOwnerInspect.attempts[0].run?.release_marker_present, false);
						const healthyCrossInspect = openB()({ action: "inspect", factory_id: facB.factory_id });
						assert.equal(healthyCrossInspect.capacity.checkout_slot, "uncertain");
						assert.equal(healthyCrossInspect.head_status.blocking_kind, "uncertain");
						assert.ok(healthyCrossInspect.uncertainty.length > 0);
						observedHealthyGap = true;

						// Now mutate ONLY local manifest.json token while lock is still held before release.json publication.
						const localRaw = readJson<Record<string, unknown>>(localPath);
						atomicJson(localPath, { ...localRaw, token: tamperedPostToken });
						tamperedBytes = readFileSync(localPath, "utf8");
						indexBytesBeforeFault = readFileSync(indexPath, "utf8");

						// Live window (lock held, no release.json): owner status, owner inspect, and cross-root inspect must all surface uncertainty.
						const liveSt = service.status(taskId, cwd);
						assert.equal(liveSt.manifest.status, "error", "Live owner status at release_after_commit must fail closed on local token tamper");
						assert.equal(liveSt.manifest.phase, "uncertain", "Live owner status at release_after_commit must report uncertain");
						assert.equal((liveSt.manifest.error ?? "").includes(realToken), false);
						assert.equal((liveSt.manifest.error ?? "").includes(tamperedPostToken), false);

						const liveOwnerInspect = open()({ action: "inspect", factory_id: fac.factory_id });
						assert.equal(liveOwnerInspect.attempts[0].release_authorized, true);
						assert.equal(liveOwnerInspect.attempts[0].run?.status, "error");
						assert.equal(liveOwnerInspect.attempts[0].run?.phase, "uncertain");
						assert.equal(liveOwnerInspect.capacity.factory_slot, "uncertain");
						assert.equal(liveOwnerInspect.capacity.checkout_slot, "uncertain");
						assert.equal(liveOwnerInspect.head_status.blocking_kind, "uncertain");
						assert.ok(liveOwnerInspect.uncertainty.length > 0);
						assert.equal(JSON.stringify(liveOwnerInspect).includes(realToken), false);
						assert.equal(JSON.stringify(liveOwnerInspect).includes(tamperedPostToken), false);

						const liveCrossInspect = openB()({ action: "inspect", factory_id: facB.factory_id });
						assert.equal(liveCrossInspect.capacity.checkout_slot, "uncertain");
						assert.equal(liveCrossInspect.head_status.blocking_kind, "uncertain");
						assert.ok(liveCrossInspect.uncertainty.length > 0);
						assert.equal(JSON.stringify(liveCrossInspect).includes(realToken), false);
						assert.equal(JSON.stringify(liveCrossInspect).includes(tamperedPostToken), false);

						assert.equal(readFileSync(localPath, "utf8"), tamperedBytes, "Live inspection must preserve local manifest bytes");
						assert.equal(readFileSync(indexPath, "utf8"), indexBytesBeforeFault, "Live inspection must preserve index manifest bytes");
						liveChecked = true;
					} catch (err) {
						liveError = err;
					}
				}
			},
		});

		await assert.rejects(
			() => opsPostTamper({ action: "launch", factory_id: fac.factory_id, authority: auth }),
			/token|manifest\.json/i,
		);
		assert.ifError(liveError);
		assert.equal(observedHealthyGap, true);
		assert.equal(liveChecked, true);

		assert.ok(sessionDir && cfgPath && realToken && tamperedBytes && indexBytesBeforeFault && taskId);
		assert.equal(existsSync(join(sessionDir!, "release.json")), false, "Post-commit manifest tamper must not publish release.json");
		assert.equal(existsSync(join(sessionDir!, "abort.json")), false, "Post-commit manifest tamper must not write abort.json");
		assert.equal(readFileSync(join(sessionDir!, "manifest.json"), "utf8"), tamperedBytes, "Run-local manifest.json tamper evidence must be preserved");
		assert.equal(readFileSync(join(service.store.indexRoot, `${taskId!}.json`), "utf8"), indexBytesBeforeFault, "Index manifest must be preserved without overwriting");

		const dbCheck = new DatabaseSync(database);
		const coordCheck = new DatabaseSync(coordDatabase);
		try {
			const att = dbCheck.prepare("SELECT state, release_authorized FROM factory_attempts WHERE task_id = ?").get(taskId!) as { state: string; release_authorized: number };
			assert.equal(att.release_authorized, 1);
			assert.equal(att.state, "released");
			const fHold = dbCheck.prepare("SELECT state FROM factory_holds WHERE factory_id = ?").get(fac.factory_id) as { state: string };
			assert.equal(fHold.state, "released");
			const cHold = coordCheck.prepare("SELECT state FROM checkout_holds WHERE task_id = ?").get(taskId!) as { state: string };
			assert.equal(cHold.state, "released");
		} finally {
			dbCheck.close();
			coordCheck.close();
		}

		const st = service.status(taskId!, cwd);
		assert.equal(st.manifest.status, "error");
		assert.equal(st.manifest.phase, "uncertain");
		assert.equal((st.manifest.error ?? "").includes(realToken!), false);
		assert.equal((st.manifest.error ?? "").includes(tamperedPostToken), false);

		const inspected = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspected.attempts[0].release_authorized, true);
		assert.equal(inspected.capacity.factory_slot, "uncertain");
		assert.equal(inspected.capacity.checkout_slot, "uncertain");
		assert.equal(inspected.head_status.blocking_kind, "uncertain");
		assert.ok(inspected.uncertainty.length > 0);
		assert.equal(JSON.stringify(inspected).includes(realToken!), false);
		assert.equal(JSON.stringify(inspected).includes(tamperedPostToken), false);

		const noStatusOps = factoryOperations(database, { prepareDefinition: (d, m) => service.prepareDefinition(d, m) }, { coordinationPath: coordDatabase });
		const noStatusInspected = noStatusOps({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(noStatusInspected.capacity.factory_slot, "uncertain");
		assert.equal(noStatusInspected.capacity.checkout_slot, "uncertain");
		assert.ok(noStatusInspected.uncertainty.length > 0);

		assert.equal(readFileSync(join(sessionDir!, "manifest.json"), "utf8"), tamperedBytes);
		assert.equal(readFileSync(join(service.store.indexRoot, `${taskId!}.json`), "utf8"), indexBytesBeforeFault);

		const w = workerFromConfig(t2, cfgPath!);
		await w.start();
		assert.equal(await w.beforeStart(), undefined, "Worker must not admit work after post-commit manifest tamper");
		assert.ok(w.aborts >= 1);
	});

	// 5. Malformed manifest JSON uses generic safe diagnostic (no JSON.parse snippets) and owner inspection
	//    with absent index + FIFO local manifest.json fails closed immediately without blocking.
	{
		const { cwd, database, coordDatabase, service, open } = launchFixture(t);
		const fac = open()({
			action: "publish",
			name: "malformed-and-absent-index-fifo",
			draft: { project_cwd: cwd, topology: "graph", task: "Malformed and FIFO", agents: [{ persona: "builder", node_id: "build", sub_task: "Build" }] },
			sessionModel,
		});
		const auth = createManagerAuthority({ pi_session_id: "mgr-9d-malformed" });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: "Ref-9d-m", brief: "Malformed & FIFO", authority: auth });
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

		const sessionDir = launched.manifest.session_dir;
		const localManifestPath = join(sessionDir, "manifest.json");
		const indexPath = join(service.store.indexRoot, `${launched.task_id}.json`);
		const secretSnippet = "SECRET_SNIPPET_SHOULD_NOT_LEAK";
		writeFileSync(localManifestPath, `{"token":"${secretSnippet}", invalid-json`, "utf8");

		const stMalformed = service.status(launched.task_id, cwd);
		assert.equal(stMalformed.manifest.phase, "uncertain");
		assert.equal((stMalformed.manifest.error ?? "").includes(secretSnippet), false, "status must not leak malformed JSON snippets");

		const inspectedMalformed = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectedMalformed.capacity.factory_slot, "uncertain");
		assert.equal(JSON.stringify(inspectedMalformed).includes(secretSnippet), false, "inspect must not leak malformed JSON snippets");

		// Remove index manifest and replace local manifest.json with a FIFO:
		// owner inspection and direct status must fail closed immediately without blocking.
		rmSync(indexPath, { force: true });
		rmSync(localManifestPath, { force: true });
		execFileSync("mkfifo", [localManifestPath]);
		assert.equal(lstatSync(localManifestPath).isFIFO(), true);

		assert.throws(() => service.status(launched.task_id, cwd), /non-regular/i);
		const inspectedFifoNoIndex = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(inspectedFifoNoIndex.capacity.factory_slot, "uncertain");
		assert.equal(inspectedFifoNoIndex.capacity.checkout_slot, "uncertain");
		assert.match(inspectedFifoNoIndex.uncertainty.join("; "), /non-regular/i);
	}

	// 6. Active pane-run live window: healthy launching/held status, local manifest.json checkout_key tamper,
	//    missing required local evidence, and progress-save token tamper (both normal return and normal pre-release error).
	const setupPaneRunProgressFixture = (tSub: test.TestContext, name: string, onPaneRun: (ctx: {
		repo: string;
		stateDir: string;
		database: string;
		coordDatabase: string;
		taskId: string;
		sessionDir: string;
		cfg: WorkerConfig;
		facId: string;
		facBId: string;
		svc: BootstrapService;
		open: () => ReturnType<typeof factoryOperations>;
		openB: () => ReturnType<typeof factoryOperations>;
	}) => void) => {
		const iso = isolatedPiEnvironment();
		tSub.after(() => iso.cleanup());
		const root = iso.root;
		const repo = join(root, "repo-progress");
		const bin = join(root, "bin");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		mkdirSync(join(repo, "extensions"), { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(repo, "extensions", "coms.ts"), "export default function () {}\n");
		writeFileSync(join(repo, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\n---\nWork.\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

		const extensionDir = fileURLToPath(new URL("..", import.meta.url));
		const stateDir = join(root, "bstate-progress");
		const stateDirB = join(root, "bstate-progress-b");
		const database = join(root, "fstate-progress", "factories.sqlite");
		const databaseB = join(root, "fstate-progress-b", "factories.sqlite");
		const coordDatabase = join(root, "coord-progress.sqlite");
		const tabs: Array<{ tab_id: string; pane_id: string; label: string }> = [];
		let seq = 0;

		let facId = "";
		let facBId = "";
		let svc!: BootstrapService;
		const open = () => factoryOperations(database, svc, { coordinationPath: coordDatabase });
		const svcB = new BootstrapService({
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			extensionDir,
			stateDir: stateDirB,
			home: iso.home,
			env: { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-progress-b" },
			pollMs: 5,
		});
		const openB = () => factoryOperations(databaseB, svcB, { coordinationPath: coordDatabase });

		svc = new BootstrapService({
			exec: async (_cmd, args) => {
				const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
				if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-progress" } });
				if (args[0] === "tab" && args[1] === "create") {
					seq++;
					const tab = { tab_id: `tp-${seq}`, pane_id: `pp-${seq}`, terminal_id: `termp-${seq}`, label: args[args.indexOf("--label") + 1] };
					tabs.push(tab);
					return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
				}
				if (args[0] === "pane" && args[1] === "run") {
					const tab = tabs.find(item => item.pane_id === args[2])!;
					const [task, instance] = tab.label.split(":");
					const sDir = join(repo, ".pi", "agent-sessions", task);
					const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
					onPaneRun({ repo, stateDir, database, coordDatabase, taskId: task, sessionDir: sDir, cfg, facId, facBId, svc, open, openB });
					const ready = { task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/progress", model: cfg.expected_model };
					atomicJson(readyPath(sDir, instance), ready);
					const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
					mkdirSync(regDir, { recursive: true });
					atomicJson(join(regDir, `${instance}.json`), ready);
					return ok();
				}
				throw new Error(`Unexpected herdr ${args.join(" ")}`);
			},
			extensionDir,
			stateDir,
			home: iso.home,
			env: { ...iso.env, PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "pane-progress" },
			pollMs: 5,
		});

		const fac = open()({
			action: "publish",
			name,
			draft: { project_cwd: repo, topology: "graph", task: `Progress ${name}`, agents: [{ persona: "worker", node_id: "work", sub_task: "Run" }] },
			sessionModel,
		});
		facId = fac.factory_id;
		const auth = createManagerAuthority({ pi_session_id: `mgr-${name}` });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: `Ref-${name}`, brief: `Brief ${name}`, authority: auth });

		const facB = openB()({
			action: "publish",
			name: `${name}-b`,
			draft: { project_cwd: repo, topology: "graph", task: `Cross ${name}`, agents: [{ persona: "worker", node_id: "work", sub_task: "Run" }] },
			sessionModel,
		});
		facBId = facB.factory_id;
		const authB = createManagerAuthority({ pi_session_id: `mgr-${name}-b` });
		openB()({ action: "resume", factory_id: facB.factory_id, authority: authB });
		openB()({ action: "submit", factory_id: facB.factory_id, reference: `Ref-${name}-b`, brief: `Brief ${name} B`, authority: authB });

		return { repo, stateDir, database, coordDatabase, facId, facBId, auth, svc, open, openB };
	};

	await t.test("6a. active pane-run live window: healthy launching and local manifest.json checkout_key tamper", async t2 => {
		let capturedTaskId: string | undefined;
		let capturedSessionDir: string | undefined;
		let tamperedLocalBytes: string | undefined;
		let indexBytesBeforeFault: string | undefined;
		let liveChecked = false;
		let liveError: unknown;
		const fix = setupPaneRunProgressFixture(t2, "pane-run-checkout-key", ctx => {
			capturedTaskId = ctx.taskId;
			capturedSessionDir = ctx.sessionDir;
			const localPath = join(ctx.sessionDir, "manifest.json");
			const indexPath = join(ctx.stateDir, `${ctx.taskId}.json`);
			indexBytesBeforeFault = readFileSync(indexPath, "utf8");

			try {
				// Healthy active launch (lock held, no release.json) must report launching/held on owner & cross-root.
				const healthySt = ctx.svc.status(ctx.taskId, ctx.repo);
				assert.equal(healthySt.manifest.status, "launching");
				assert.equal(healthySt.manifest.phase, "creating:a1-work");
				const healthyOwner = ctx.open()({ action: "inspect", factory_id: ctx.facId });
				assert.equal(healthyOwner.uncertainty.length, 0);
				assert.equal(healthyOwner.capacity.factory_slot, "held");
				assert.equal(healthyOwner.capacity.checkout_slot, "held");
				assert.equal(healthyOwner.head_status.blocking_kind, "factory_held");
				assert.equal(healthyOwner.attempts[0].release_authorized, false);
				assert.equal(healthyOwner.attempts[0].run?.status, "launching");
				assert.equal(healthyOwner.attempts[0].run?.phase, "creating:a1-work");
				const healthyCross = ctx.openB()({ action: "inspect", factory_id: ctx.facBId });
				assert.equal(healthyCross.uncertainty.length, 0);
				assert.equal(healthyCross.capacity.checkout_slot, "held");
				assert.equal(healthyCross.head_status.blocking_kind, "checkout_held");

				// Tamper ONLY local manifest.json factory_managed.checkout_key while lock is held.
				const localRaw = readJson<Record<string, any>>(localPath);
				atomicJson(localPath, {
					...localRaw,
					factory_managed: { ...localRaw.factory_managed, checkout_key: "dev:0:ino:999999999" },
				});
				tamperedLocalBytes = readFileSync(localPath, "utf8");

				const liveSt = ctx.svc.status(ctx.taskId, ctx.repo);
				assert.equal(liveSt.manifest.status, "error", "Live owner status at pane run must fail closed on local checkout_key tamper");
				assert.equal(liveSt.manifest.phase, "uncertain", "Live owner status at pane run must report uncertain");

				const liveOwner = ctx.open()({ action: "inspect", factory_id: ctx.facId });
				assert.equal(liveOwner.attempts[0].release_authorized, false);
				assert.equal(liveOwner.attempts[0].run?.status, "error");
				assert.equal(liveOwner.attempts[0].run?.phase, "uncertain");
				assert.equal(liveOwner.capacity.factory_slot, "uncertain");
				assert.equal(liveOwner.capacity.checkout_slot, "uncertain");
				assert.equal(liveOwner.head_status.blocking_kind, "uncertain");
				assert.ok(liveOwner.uncertainty.length > 0);

				const liveCross = ctx.openB()({ action: "inspect", factory_id: ctx.facBId });
				assert.equal(liveCross.capacity.checkout_slot, "uncertain");
				assert.equal(liveCross.head_status.blocking_kind, "uncertain");
				assert.ok(liveCross.uncertainty.length > 0);

				assert.equal(readFileSync(localPath, "utf8"), tamperedLocalBytes, "Live inspection must preserve tampered local manifest");
				assert.equal(readFileSync(indexPath, "utf8"), indexBytesBeforeFault, "Live inspection must preserve index manifest");
				liveChecked = true;
			} catch (err) {
				liveError = err;
			}
		});

		await assert.rejects(
			() => fix.open()({ action: "launch", factory_id: fix.facId, authority: fix.auth }),
			/checkout_key|manifest\.json|mismatch/i,
		);
		assert.ifError(liveError);
		assert.equal(liveChecked, true);
		assert.ok(capturedTaskId && capturedSessionDir && tamperedLocalBytes && indexBytesBeforeFault);
		assert.equal(existsSync(join(capturedSessionDir!, "release.json")), false);
		assert.equal(readFileSync(join(capturedSessionDir!, "manifest.json"), "utf8"), tamperedLocalBytes);
		assert.equal(readFileSync(join(fix.stateDir, `${capturedTaskId!}.json`), "utf8"), indexBytesBeforeFault);

		const afterOwner = fix.open()({ action: "inspect", factory_id: fix.facId });
		assert.equal(afterOwner.capacity.factory_slot, "uncertain");
		assert.equal(afterOwner.capacity.checkout_slot, "uncertain");
		assert.ok(afterOwner.uncertainty.length > 0);
		assert.equal(fix.openB()({ action: "inspect", factory_id: fix.facBId }).capacity.checkout_slot, "uncertain");
	});

	await t.test("6b. active pane-run live window: missing required local evidence and progress-save token tamper", async t2 => {
		for (const throwAfterTamper of [false, true]) {
			const tamperedProgressToken = "tampered-progress-save-secret-token";
			let capturedTaskId: string | undefined;
			let capturedSessionDir: string | undefined;
			let capturedRealToken: string | undefined;
			let tamperedLocalBytes: string | undefined;
			let indexBytesBeforeLaunchSubmitted: string | undefined;
			let missingSidecarChecked = false;
			let missingManifestChecked = false;
			let liveTokenChecked = false;
			let liveError: unknown;

			const fix = setupPaneRunProgressFixture(t2, `progress-tamper-${throwAfterTamper ? "err" : "ok"}`, ctx => {
				capturedTaskId = ctx.taskId;
				capturedSessionDir = ctx.sessionDir;
				capturedRealToken = ctx.cfg.token;
				const indexPath = join(ctx.stateDir, `${ctx.taskId}.json`);
				const localPath = join(ctx.sessionDir, "manifest.json");
				const sidecarPath = join(ctx.sessionDir, "factory-run.json");
				indexBytesBeforeLaunchSubmitted = readFileSync(indexPath, "utf8");

				try {
					// Missing required local sidecar and missing required local manifest while lock is held
					// must each independently fail closed (not report healthy launching).
					if (!throwAfterTamper) {
						const sidecarBytes = readFileSync(sidecarPath, "utf8");
						rmSync(sidecarPath);
						try {
							const missingSidecarSt = ctx.svc.status(ctx.taskId, ctx.repo);
							assert.equal(missingSidecarSt.manifest.status, "error");
							assert.equal(missingSidecarSt.manifest.phase, "uncertain");
							const missingSidecarOwner = ctx.open()({ action: "inspect", factory_id: ctx.facId });
							assert.equal(missingSidecarOwner.capacity.factory_slot, "uncertain");
							assert.equal(missingSidecarOwner.capacity.checkout_slot, "uncertain");
							assert.ok(missingSidecarOwner.uncertainty.length > 0);
							assert.equal(ctx.openB()({ action: "inspect", factory_id: ctx.facBId }).capacity.checkout_slot, "uncertain");
							missingSidecarChecked = true;
						} finally {
							writeFileSync(sidecarPath, sidecarBytes, "utf8");
						}

						const localBytes = readFileSync(localPath, "utf8");
						rmSync(localPath);
						try {
							const missingManifestSt = ctx.svc.status(ctx.taskId, ctx.repo);
							assert.equal(missingManifestSt.manifest.status, "error");
							assert.equal(missingManifestSt.manifest.phase, "uncertain");
							assert.match(missingManifestSt.manifest.error ?? "", /manifest\.json/i);
							const missingManifestOwner = ctx.open()({ action: "inspect", factory_id: ctx.facId });
							assert.equal(missingManifestOwner.attempts[0].run?.status, "error");
							assert.equal(missingManifestOwner.attempts[0].run?.phase, "uncertain");
							assert.equal(missingManifestOwner.capacity.factory_slot, "uncertain");
							assert.equal(missingManifestOwner.capacity.checkout_slot, "uncertain");
							assert.ok(missingManifestOwner.uncertainty.length > 0);
							assert.equal(ctx.openB()({ action: "inspect", factory_id: ctx.facBId }).capacity.checkout_slot, "uncertain");
							missingManifestChecked = true;
						} finally {
							writeFileSync(localPath, localBytes, "utf8");
						}
					}

					const localRaw = readJson<Record<string, unknown>>(localPath);
					atomicJson(localPath, { ...localRaw, token: tamperedProgressToken });
					tamperedLocalBytes = readFileSync(localPath, "utf8");

					const liveSt = ctx.svc.status(ctx.taskId, ctx.repo);
					assert.equal(liveSt.manifest.status, "error");
					assert.equal(liveSt.manifest.phase, "uncertain");
					assert.equal((liveSt.manifest.error ?? "").includes(capturedRealToken!), false);
					assert.equal((liveSt.manifest.error ?? "").includes(tamperedProgressToken), false);

					const liveOwner = ctx.open()({ action: "inspect", factory_id: ctx.facId });
					assert.equal(liveOwner.capacity.factory_slot, "uncertain");
					assert.equal(liveOwner.capacity.checkout_slot, "uncertain");
					assert.equal(liveOwner.head_status.blocking_kind, "uncertain");
					assert.equal(JSON.stringify(liveOwner).includes(capturedRealToken!), false);
					assert.equal(JSON.stringify(liveOwner).includes(tamperedProgressToken), false);
					liveTokenChecked = true;
				} catch (err) {
					liveError = err;
				}

				if (throwAfterTamper) throw new Error("Simulated pane run failure after local tamper");
			});

			await assert.rejects(
				() => fix.open()({ action: "launch", factory_id: fix.facId, authority: fix.auth }),
				throwAfterTamper ? /Simulated pane run failure after local tamper/ : /token|manifest\.json/i,
			);
			assert.ifError(liveError);
			assert.equal(liveTokenChecked, true);
			if (!throwAfterTamper) {
				assert.equal(missingSidecarChecked, true);
				assert.equal(missingManifestChecked, true);
			}

			assert.ok(capturedTaskId && capturedSessionDir && capturedRealToken && tamperedLocalBytes && indexBytesBeforeLaunchSubmitted);
			assert.equal(existsSync(join(capturedSessionDir!, "release.json")), false, "Progress-save tamper must not authorize release.json");
			assert.equal(readFileSync(join(capturedSessionDir!, "manifest.json"), "utf8"), tamperedLocalBytes, "Tampered local manifest must remain intact across progress/error saves");
			assert.equal(readFileSync(join(fix.stateDir, `${capturedTaskId!}.json`), "utf8"), indexBytesBeforeLaunchSubmitted, "Index manifest must not be overwritten after local tamper");

			const dbCheck = new DatabaseSync(fix.database);
			const coordCheck = new DatabaseSync(fix.coordDatabase);
			try {
				const att = dbCheck.prepare("SELECT state, release_authorized FROM factory_attempts WHERE task_id = ?").get(capturedTaskId!) as { state: string; release_authorized: number };
				assert.equal(att.release_authorized, 0);
				assert.equal(att.state, "failed_before_release");
				const fHold = dbCheck.prepare("SELECT state FROM factory_holds WHERE factory_id = ?").get(fix.facId) as { state: string };
				assert.equal(fHold.state, "failed_before_release");
				const cHold = coordCheck.prepare("SELECT state FROM checkout_holds WHERE task_id = ?").get(capturedTaskId!) as { state: string };
				assert.equal(cHold.state, "failed_before_release");
			} finally {
				dbCheck.close();
				coordCheck.close();
			}

			const st = fix.svc.status(capturedTaskId!, fix.repo);
			assert.equal(st.manifest.status, "error");
			assert.equal(st.manifest.phase, "uncertain");
			assert.equal((st.manifest.error ?? "").includes(capturedRealToken!), false);
			assert.equal((st.manifest.error ?? "").includes(tamperedProgressToken), false);

			const inspected = fix.open()({ action: "inspect", factory_id: fix.facId });
			assert.equal(inspected.attempts[0].release_authorized, false);
			assert.equal(inspected.capacity.factory_slot, "uncertain");
			assert.equal(inspected.capacity.checkout_slot, "uncertain");
			assert.equal(inspected.head_status.blocking_kind, "uncertain");
			assert.equal(JSON.stringify(inspected).includes(capturedRealToken!), false);
			assert.equal(JSON.stringify(inspected).includes(tamperedProgressToken), false);
		}
	});
});
