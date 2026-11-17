/** Execution outcomes and dependency policies, observed through the service (plan, launch, status, report, cleanup). */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, dependencyPolicyOf, parseWorkerConfig, readJson, readyPath, type WorkerConfig } from "./session-store.ts";

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

/** A project with three personas, a fake Herdr and a Pi stand-in: the same seams the lifecycle suite uses. */
function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-outcomes-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second", "third"]) writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	const calls: string[][] = [];
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
	let sequence = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		calls.push(args);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			sequence++;
			const tab = { tab_id: `t${sequence}`, pane_id: `p${sequence}`, terminal_id: `term${sequence}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(tab => tab.pane_id === args[2])!;
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
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") {
			const index = tabs.findIndex(tab => (args[0] === "pane" ? tab.pane_id : tab.tab_id) === args[2]);
			assert.notEqual(index, -1);
			tabs.splice(index, 1);
			tabs.forEach((tab, i) => { tab.tab_id = `t${i + 1}`; tab.pane_id = `p${i + 1}`; });
			return ok();
		}
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	const options = { exec, extensionDir, stateDir, home, env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" }, pollMs: 5 };
	const service = new BootstrapService(options);
	const base = { task: "Test launch", project_cwd: cwd, ready_timeout_ms: 100 };
	/** A three-node chain in the explicit node form (new format) or the legacy name form. */
	const chain = (form: "nodes" | "legacy", extra: Array<Record<string, unknown>> = [{}, {}, {}]): GenerateRequest => ({
		...base, topology: "chain",
		agents: ["first", "second", "third"].map((name, i) => ({ ...(form === "nodes" ? { node_id: `n${i + 1}`, persona: name } : { name }), sub_task: `${name} task`, ...extra[i] })),
	});
	return { root, cwd, options, service, base, chain, calls, tabs, configs };
}

const policies = (run: { pane_manifest: Array<{ dependency_policy?: string }> }) => run.pane_manifest.map(entry => entry.dependency_policy);

test("a new-format chain defaults each dependency to require_success; a legacy chain keeps allow_partial", async t => {
	const f = fixture(t);
	const modern = await f.service.generate({ ...f.chain("nodes"), request_id: "modern" });
	assert.deepEqual(policies(modern), [undefined, "require_success", "require_success"], "the first node has no dependency");
	assert.deepEqual(f.configs.map(config => config.dependency_policy), [undefined, "require_success", "require_success"], "the worker is told the policy it must enforce");
	const legacy = await f.service.generate({ ...f.chain("legacy"), request_id: "legacy" });
	assert.deepEqual(policies(legacy), [undefined, "allow_partial", "allow_partial"]);
	assert.equal(legacy.request_form, "legacy");
	// Each dependency can choose explicitly, in either request form.
	const mixed = await f.service.generate({ ...f.chain("nodes", [{}, { dependency_policy: "allow_partial" }, {}]), request_id: "mixed" });
	assert.deepEqual(policies(mixed), [undefined, "allow_partial", "require_success"]);
	const strictLegacy = await f.service.generate({ ...f.chain("legacy", [{}, { dependency_policy: "require_success" }, {}]), request_id: "strict-legacy" });
	assert.deepEqual(policies(strictLegacy), [undefined, "require_success", "allow_partial"]);
	// The recorded policy is durable: a fresh service reads it back.
	assert.deepEqual(policies(new BootstrapService(f.options).store.load(modern.task_id)), policies(modern));
});

test("teams have no dependencies, so policies and required checks are rejected there", async t => {
	const f = fixture(t);
	const team = (extra: Record<string, unknown>): GenerateRequest => ({ ...f.base, topology: "team", agents: [{ node_id: "a", persona: "first", sub_task: "x", ...extra }] });
	await assert.rejects(f.service.generate(team({ dependency_policy: "allow_partial" })), /Team agents cannot declare a dependency policy or required checks/);
	await assert.rejects(f.service.generate(team({ required_checks: ["tests"] })), /Team agents cannot declare a dependency policy or required checks/);
	assert.equal(f.calls.length, 0);
});

test("dependency declarations are validated before anything is launched", async t => {
	const f = fixture(t);
	const bad = async (extra: Array<Record<string, unknown>>, pattern: RegExp) => { await assert.rejects(f.service.generate(f.chain("nodes", extra)), pattern); };
	await bad([{ dependency_policy: "allow_partial" }, {}, {}], /n1 is the first step and has no dependency/);
	await bad([{ required_checks: ["tests"] }, {}, {}], /n1 is the first step and has no dependency/);
	await bad([{}, { dependency_policy: "sometimes" }, {}], /dependency_policy for n2 must be require_success or allow_partial/);
	await bad([{}, { required_checks: ["tests"] }, {}], /n2 requires check "tests", which its predecessor n1 does not declare/);
	await bad([{ checks: [{ name: "tests", command: "true" }, { name: "TESTS", command: "true" }] }, {}, {}], /Duplicate check name for n1: TESTS/);
	await bad([{ checks: [{ name: "bad name", command: "true" }] }, {}, {}], /Unsafe check name/);
	await bad([{ checks: [{ name: "tests", command: "  " }] }, {}, {}], /command for check "tests" of n1 must be a non-empty string/);
	await bad([{ checks: [{ name: "tests", command: "true", scope: ["../elsewhere"] }] }, {}, {}], /scope .* must stay inside the project/);
	await bad([{ checks: [{ name: "tests", command: "true", timeout_ms: 5 }] }, {}, {}], /timeout_ms for check "tests" of n1/);
	await bad([{ checks: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, command: "true" })) }, {}, {}], /at most 8 checks/);
	assert.equal(f.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
});

test("declared checks and the policy that requires them are recorded on the plan, the manifest and the worker configuration", async t => {
	const f = fixture(t);
	const checks = [{ name: "tests", command: "npm test", scope: ["src"], timeout_ms: 60_000 }];
	const request = f.chain("nodes", [{ checks }, { required_checks: ["tests"], dependency_policy: "allow_partial" }, {}]);
	const plan = f.service.plan(request);
	assert.deepEqual(plan.agents.map(agent => [agent.node_id, agent.dependency_policy, agent.required_checks, agent.checks?.map(check => check.name)]),
		[["n1", undefined, undefined, ["tests"]], ["n2", "allow_partial", ["tests"], undefined], ["n3", "require_success", undefined, undefined]]);
	const run = await f.service.generate({ ...request, request_id: "checks" });
	assert.deepEqual(run.pane_manifest[0].checks, checks);
	assert.deepEqual(run.pane_manifest[1].required_checks, ["tests"]);
	assert.deepEqual(f.configs.map(config => [config.checks, config.required_checks, config.dependency_policy]), [[checks, undefined, undefined], [undefined, ["tests"], "allow_partial"], [undefined, undefined, "require_success"]]);
});

test("a different policy or check is a different plan for an idempotency key; an equivalent retry is not", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "key" });
	const same = await f.service.generate({ ...f.chain("nodes", [{}, { dependency_policy: "require_success" }, {}]), request_id: "key" });
	assert.equal(same.task_id, run.task_id, "stating the default explicitly is the same plan");
	await assert.rejects(f.service.generate({ ...f.chain("nodes", [{}, { dependency_policy: "allow_partial" }, {}]), request_id: "key" }), /different bootstrap plan/);
	await assert.rejects(f.service.generate({ ...f.chain("nodes", [{ checks: [{ name: "tests", command: "true" }] }, {}, {}]), request_id: "key" }), /different bootstrap plan/);
	assert.equal(f.tabs.length, 3, "nothing was launched twice");
});

test("a legacy request keeps the exact fingerprint of the previous release, and so does a reservation made before policies existed", async t => {
	const f = fixture(t);
	// The previous release's canonical fingerprint for a persona-keyed plan (no dependency fields).
	const previous = (form: "legacy" | "nodes") => createHash("sha256").update(JSON.stringify({
		v: form === "legacy" ? 2 : 3, topology: "chain", task: "Test launch", project_cwd: realpathSync(f.cwd), ready_timeout_ms: 100, coms_extension: null,
		agents: [["first", "first task", 1], ["second", "second task", 2], ["third", "third task", 3]].map(agent => form === "legacy" ? agent : [`n${agent[2]}`, agent[0], agent[1], agent[2]]), model: null,
	})).digest("hex");
	const reservation = (key: string) => join(f.options.stateDir, `request-${createHash("sha256").update(key).digest("hex")}.json`);
	// A legacy plan's behavior is unchanged, so its reservation is untouched by this release.
	const legacy = await f.service.generate({ ...f.chain("legacy"), request_id: "old-legacy" });
	assert.equal(readJson<{ fingerprint: string }>(reservation("old-legacy")).fingerprint, previous("legacy"));
	// A new-format chain launched by the previous release ran without policies: retrying its key finds that run rather than a "different plan".
	const old = await f.service.generate({ ...f.chain("nodes"), request_id: "old-modern" });
	atomicJson(reservation("old-modern"), { fingerprint: previous("nodes"), task_id: old.task_id });
	for (const entry of old.pane_manifest) delete entry.dependency_policy;
	f.service.store.save(old);
	const tabsBefore = f.tabs.length;
	const retry = await new BootstrapService(f.options).generate({ ...f.chain("nodes"), request_id: "old-modern" });
	assert.equal(retry.task_id, old.task_id);
	assert.equal(f.tabs.length, tabsBefore);
	assert.notEqual(legacy.task_id, old.task_id);
	// ...but a run that was launched with policies owns its key under the new fingerprint only.
	const current = await f.service.generate({ ...f.chain("nodes"), request_id: "current" });
	atomicJson(reservation("current"), { fingerprint: previous("nodes"), task_id: current.task_id });
	await assert.rejects(f.service.generate({ ...f.chain("nodes"), request_id: "current" }), /different bootstrap plan/);
});

test("manifests and worker configurations written before policies existed read as allow_partial, the behavior they ran under", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "fixture" });
	const stored = readJson<any>(join(f.options.stateDir, `${run.task_id}.json`));
	for (const entry of stored.pane_manifest) { delete entry.dependency_policy; delete entry.required_checks; delete entry.checks; }
	atomicJson(join(f.options.stateDir, `${run.task_id}.json`), stored);
	const loaded = f.service.store.load(run.task_id);
	assert.deepEqual(policies(loaded), [undefined, undefined, undefined]);
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(agent => agent.dependency_policy), [undefined, "allow_partial", "allow_partial"], "an absent policy means the legacy allowance, and the first node has none");
	const config = readJson<WorkerConfig>(join(run.session_dir, `${run.pane_manifest[1].instance_id}.config.json`));
	delete config.dependency_policy;
	assert.equal(dependencyPolicyOf(parseWorkerConfig(config), true), "allow_partial");
});
