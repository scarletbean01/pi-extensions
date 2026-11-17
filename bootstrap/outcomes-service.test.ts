/** Execution outcomes and dependency policies, observed through the service (plan, launch, status, report, cleanup). */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, completionRecord, dependencyPolicyOf, dispositionPath, dispositionRecord, parseWorkerConfig, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import type { CauseRef, DispositionState } from "./outcomes.ts";
import { beginVerificationCheck, finishVerificationCheck, verificationPath } from "./verification.ts";
import { buildMarkdownReport, formatAgentStates, formatReportDigest } from "./reporting.ts";

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

test("teams have no dependencies, so a dependency policy is rejected there", async t => {
	const f = fixture(t);
	const team = (extra: Record<string, unknown>): GenerateRequest => ({ ...f.base, topology: "team", agents: [{ node_id: "a", persona: "first", sub_task: "x", ...extra }] });
	await assert.rejects(f.service.generate(team({ dependency_policy: "allow_partial" })), /Team agents cannot declare a dependency policy/);
	assert.equal(f.calls.length, 0);
	// Required checks are the node's own contract and are fine in a team.
	const run = await f.service.generate({ ...team({ required_checks: ["tests"] }), request_id: "team-checks" });
	assert.deepEqual(run.pane_manifest[0].required_checks, ["tests"]);
});

test("dependency declarations are validated before anything is launched", async t => {
	const f = fixture(t);
	const bad = async (extra: Array<Record<string, unknown>>, pattern: RegExp) => { await assert.rejects(f.service.generate(f.chain("nodes", extra)), pattern); };
	await bad([{ dependency_policy: "allow_partial" }, {}, {}], /n1 is the first step and has no dependency/);
	await bad([{}, { dependency_policy: "sometimes" }, {}], /dependency_policy for n2 must be require_success or allow_partial/);
	await bad([{}, { dependency_policy: 3 }, {}], /dependency_policy for n2 must be require_success or allow_partial/);
	assert.equal(f.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
});

test("the policy and the checks a node must pass are recorded on the plan, the manifest and the worker configuration", async t => {
	const f = fixture(t);
	const request = f.chain("nodes", [{ required_checks: ["tests"], output_contract: { required_checks: ["lint"] } }, { dependency_policy: "allow_partial" }, {}]);
	const plan = f.service.plan(request);
	assert.deepEqual(plan.agents.map(agent => [agent.node_id, agent.dependency_policy, agent.required_checks]), [["n1", undefined, ["tests"]], ["n2", "allow_partial", undefined], ["n3", "require_success", undefined]]);
	const run = await f.service.generate({ ...request, request_id: "checks" });
	assert.deepEqual(run.pane_manifest.map(entry => [entry.dependency_policy, entry.required_checks]), [[undefined, ["tests", "lint"]], ["allow_partial", undefined], ["require_success", undefined]], "the manifest keeps what status needs: every check the node must pass");
	assert.deepEqual(f.configs.map(config => [config.dependency_policy, config.required_checks, config.upstream_contracts?.["a1-n1"]?.required_checks]), [[undefined, ["tests"], ["tests"]], ["allow_partial", undefined, ["tests"]], ["require_success", undefined, ["tests"]]],
		"the follower's worker is told which checks its predecessor must have passing");
});

test("a different policy or check is a different plan for an idempotency key; an equivalent retry is not", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "key" });
	const same = await f.service.generate({ ...f.chain("nodes", [{}, { dependency_policy: "require_success" }, {}]), request_id: "key" });
	assert.equal(same.task_id, run.task_id, "stating the default explicitly is the same plan");
	await assert.rejects(f.service.generate({ ...f.chain("nodes", [{}, { dependency_policy: "allow_partial" }, {}]), request_id: "key" }), /different bootstrap plan/);
	await assert.rejects(f.service.generate({ ...f.chain("nodes", [{ required_checks: ["tests"] }, {}, {}]), request_id: "key" }), /different bootstrap plan/);
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
	for (const entry of stored.pane_manifest) { delete entry.dependency_policy; delete entry.required_checks; }
	atomicJson(join(f.options.stateDir, `${run.task_id}.json`), stored);
	const loaded = f.service.store.load(run.task_id);
	assert.deepEqual(policies(loaded), [undefined, undefined, undefined]);
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(agent => agent.dependency_policy), [undefined, "allow_partial", "allow_partial"], "an absent policy means the legacy allowance, and the first node has none");
	const config = readJson<WorkerConfig>(join(run.session_dir, `${run.pane_manifest[1].instance_id}.config.json`));
	delete config.dependency_policy;
	assert.equal(dependencyPolicyOf(parseWorkerConfig(config), true), "allow_partial");
});

// ---- status, aggregation and reports ----

/** What a finished worker durably records (the builder the worker itself uses). */
function finish(run: { session_dir: string }, config: WorkerConfig, status: "success" | "partial" | "failure", summary = `${status} summary`): void {
	atomicJson(resultPath(run.session_dir, config.instance_id), completionRecord(config, { agent_name: config.persona_name, status, summary, detail: `${summary} (detail)` }, "not_required", new Date().toISOString()));
}
/** What the system records for a node that did not execute (or whose outcome is unresolved). */
function dispose(run: { session_dir: string }, config: WorkerConfig, state: DispositionState, reason: string, causes: CauseRef[] = []): void {
	atomicJson(dispositionPath(run.session_dir, config.instance_id), dispositionRecord(config, state, reason, causes, new Date().toISOString()));
}
const states = (status: { agents: Array<{ execution: string }> }) => status.agents.map(agent => agent.execution);

test("launch and resource state are reported separately from execution state, reported outcome and evidence", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "separate" });
	let status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["pending", "pending", "pending"], "released work that has not reported a heartbeat has not started");
	assert.deepEqual(status.agents.map(agent => agent.resource), ["released", "released", "released"]);
	const [first, second, third] = run.pane_manifest;
	atomicJson(join(run.session_dir, `${first.instance_id}.progress.json`), { token: run.token, updated_at: Date.now(), state: "working" });
	atomicJson(join(run.session_dir, `${second.instance_id}.progress.json`), { token: run.token, updated_at: Date.now(), state: "waiting" });
	status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["running", "waiting", "pending"]);
	finish(run, f.configs[0], "partial");
	status = f.service.status(run.task_id);
	assert.equal(status.agents[0].execution, "partial");
	assert.equal(status.agents[0].result_status, "partial", "the worker's own report is still its own field");
	assert.equal(status.agents[0].resource, "released");
	assert.equal(status.agents[0].state, "done", "the legacy state field is unchanged");
	// Closing the resource does not change what the node did.
	await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, [first.instance_id]);
	status = f.service.status(run.task_id);
	assert.deepEqual([status.agents[0].resource, status.agents[0].execution], ["closed", "partial"]);
	// ...but a node closed before it recorded anything has an unknown outcome, which is an attention condition, never "cancelled" or "failed".
	await f.service.cleanup(run.task_id, undefined, false, undefined, undefined, [second.instance_id]);
	status = f.service.status(run.task_id);
	assert.equal(status.agents[1].execution, "needs_attention");
	assert.match(status.agents[1].execution_reason!, /closed before an outcome was recorded/);
	assert.equal(third.status, "released");
});

test("a failure upstream blocks every later node with the original cause, and blocked nodes are not failed executions", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "upstream" });
	finish(run, f.configs[0], "failure", "compile error");
	dispose(run, f.configs[1], "blocked", "n1 failed: compile error", [{ node_id: "n1", state: "failed", reason: "compile error" }]);
	dispose(run, f.configs[2], "blocked", "n2 is blocked: n1 failed: compile error", [{ node_id: "n2", state: "blocked", reason: "n1 failed: compile error" }, { node_id: "n1", state: "failed", reason: "compile error" }]);
	const status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["failed", "blocked", "blocked"]);
	assert.deepEqual(status.agents[2].execution_causes.map(cause => [cause.node_id, cause.state]), [["n2", "blocked"], ["n1", "failed"]], "the root cause survives the whole chain");
	assert.deepEqual(status.pending, [], "work that will never execute is not pending");
	assert.deepEqual(status.results.map(result => result.node_id), ["n1"], "only the node that executed has a worker result");
	assert.deepEqual(status.worker_errors, []);
	assert.equal(status.outcome.state, "failed");
	assert.equal(status.outcome.terminal, true);
	assert.deepEqual(status.outcome.counts, { pending: 0, waiting: 0, running: 0, succeeded: 0, partial: 0, failed: 1, blocked: 2, skipped: 0, cancelled: 0, needs_attention: 0 });
	const settled = await f.service.waitForStatus(run.task_id, 50);
	assert.equal(settled.timed_out, false, "a run whose remaining nodes are blocked is settled");
	assert.match(formatAgentStates(status.agents), /a3-n3 \(n3, persona third\): done.* \[execution blocked; caused by n2 \(blocked\), n1 \(failed\)\]/);
});

test("an all-terminal failed run produces a report that lists every node and invents no result for work that never ran", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "report" });
	finish(run, f.configs[0], "failure", "compile error");
	dispose(run, f.configs[1], "blocked", "n1 failed: compile error", [{ node_id: "n1", state: "failed", reason: "compile error" }]);
	dispose(run, f.configs[2], "blocked", "n2 is blocked", [{ node_id: "n2", state: "blocked", reason: "n1 failed" }, { node_id: "n1", state: "failed", reason: "compile error" }]);
	const paths = await f.service.report(run.task_id, undefined, true, buildMarkdownReport);
	const saved = readJson<any[]>(paths.report_json);
	assert.deepEqual(saved.map(entry => [entry.node_id, entry.status, entry.execution_state]), [["n1", "failure", "failed"], ["n2", "blocked", "blocked"], ["n3", "blocked", "blocked"]]);
	assert.equal(saved.some(entry => entry.status === "success"), false);
	assert.deepEqual(saved[2].causes.map((cause: any) => cause.node_id), ["n2", "n1"]);
	assert.match(saved[1].summary, /^Not executed \(blocked\): n1 failed/);
	assert.equal(saved[1].artifacts, undefined);
	const digest = formatReportDigest(paths.results);
	assert.match(digest, /^0 success, 0 partial, 1 failure\. Not executed: 2 blocked\.\nRun outcome: failed\./);
	assert.match(digest, /- n3 \(persona third\): blocked — Not executed \(blocked\): n2 is blocked \(caused by n2 blocked, n1 failed\)/);
	const markdown = readFileSync(paths.report_md!, "utf8");
	assert.match(markdown, /### .* n2 \(persona second\)\nStatus: blocked \(not executed\)/);
	assert.match(markdown, /Caused by:\n  - n2 \(blocked\): n1 failed\n  - n1 \(failed\): compile error/);
	assert.match(markdown, /Overall: 0 success, 0 partial, 1 failure, 2 not executed \| 0 warnings \| run outcome: failed/);
});

test("resource cleanup does not erase execution outcomes, and a report can still be written afterwards", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "cleanup" });
	finish(run, f.configs[0], "failure", "broke");
	dispose(run, f.configs[1], "blocked", "n1 failed", [{ node_id: "n1", state: "failed", reason: "broke" }]);
	dispose(run, f.configs[2], "blocked", "n2 is blocked", [{ node_id: "n2", state: "blocked", reason: "n1 failed" }, { node_id: "n1", state: "failed", reason: "broke" }]);
	const cleaned = await f.service.cleanup(run.task_id);
	assert.equal(cleaned.status, "cleaned");
	const status = f.service.status(run.task_id);
	assert.deepEqual(status.agents.map(agent => [agent.resource, agent.execution]), [["closed", "failed"], ["closed", "blocked"], ["closed", "blocked"]]);
	assert.equal(status.outcome.state, "failed");
	const paths = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.deepEqual(paths.results.map(entry => entry.status), ["failure", "blocked", "blocked"]);
});

test("mixed outcomes in a team are aggregated deterministically and every terminal node is reported", async t => {
	const f = fixture(t);
	const request: GenerateRequest = { ...f.base, topology: "team", agents: [{ node_id: "ok", persona: "first", sub_task: "a" }, { node_id: "half", persona: "first", sub_task: "b" }, { node_id: "bad", persona: "second", sub_task: "c" }] };
	const run = await f.service.generate(request);
	finish(run, f.configs[0], "success");
	finish(run, f.configs[1], "partial");
	let status = f.service.status(run.task_id);
	assert.equal(status.outcome.state, "incomplete", "one node is still to run");
	assert.deepEqual(status.pending, ["bad"]);
	finish(run, f.configs[2], "failure");
	status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["succeeded", "partial", "failed"]);
	assert.equal(status.outcome.state, "failed");
	const paths = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.match(formatReportDigest(paths.results), /^1 success, 1 partial, 1 failure\.\nRun outcome: failed\./);
	// The same mix recorded as success + partial alone is a partial run, and all-success is a success.
	const other = await f.service.generate({ ...request, request_id: "other", agents: request.agents.slice(0, 2) });
	finish(other, f.configs[3], "success");
	finish(other, f.configs[4], "partial");
	assert.equal(f.service.status(other.task_id).outcome.state, "partial");
	finish(other, f.configs[4], "success");
	assert.equal(f.service.status(other.task_id).outcome.state, "succeeded");
});

test("skipped and cancelled records are read and reported without results; an unresolved node keeps the run open", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.base, topology: "team", agents: [{ node_id: "a", persona: "first", sub_task: "a" }, { node_id: "b", persona: "second", sub_task: "b" }, { node_id: "c", persona: "third", sub_task: "c" }] });
	finish(run, f.configs[0], "success");
	dispose(run, f.configs[1], "skipped", "not needed");
	dispose(run, f.configs[2], "cancelled", "run cancelled");
	const status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["succeeded", "skipped", "cancelled"]);
	assert.equal(status.outcome.state, "cancelled");
	const paths = await f.service.report(run.task_id, undefined, false, buildMarkdownReport);
	assert.deepEqual(paths.results.map(entry => entry.status), ["success", "skipped", "cancelled"]);
	// An unresolved node is not terminal: the report is refused until someone decides, and dependants are never admitted meanwhile.
	dispose(run, f.configs[2], "needs_attention", "worker exited during handoff");
	const open = f.service.status(run.task_id);
	assert.equal(open.agents[2].execution, "needs_attention");
	assert.equal(open.outcome.state, "needs_attention");
	assert.deepEqual(open.worker_errors, ["c (persona third): needs attention: worker exited during handoff"]);
	await assert.rejects(f.service.report(run.task_id, undefined, false, buildMarkdownReport), /Run is not complete/);
});

test("a worker's crash, an unusable record or a failed handoff are attention conditions and never replayed as failures", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "attention" });
	writeFileSync(join(run.session_dir, `${run.pane_manifest[0].instance_id}.error.json`), JSON.stringify({ error: "Worker exited before recording a result" }));
	writeFileSync(dispositionPath(run.session_dir, run.pane_manifest[1].instance_id), "{torn");
	const status = f.service.status(run.task_id);
	assert.deepEqual(states(status), ["needs_attention", "needs_attention", "pending"]);
	assert.match(status.agents[0].execution_reason!, /Worker exited before recording a result/);
	assert.match(status.worker_errors.join("\n"), /unusable disposition file/);
	rmSync(dispositionPath(run.session_dir, run.pane_manifest[1].instance_id));
	// A saved result whose handoff failed keeps its outcome; the delivery problem is separate and still visible.
	rmSync(join(run.session_dir, `${run.pane_manifest[0].instance_id}.error.json`));
	atomicJson(resultPath(run.session_dir, run.pane_manifest[0].instance_id), { ...completionRecord(f.configs[0], { agent_name: "first", status: "success", summary: "done", detail: "" }, "failed", new Date().toISOString()), delivery_error: "receiver unreachable" });
	const delivery = f.service.status(run.task_id);
	assert.equal(delivery.agents[0].execution, "succeeded");
	assert.deepEqual(delivery.delivery_errors, ["n1 (persona first): receiver unreachable"]);
});

test("a result cannot be supplied for a node that never executed", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes"), request_id: "explicit" });
	finish(run, f.configs[0], "failure", "broke");
	dispose(run, f.configs[1], "blocked", "n1 failed", [{ node_id: "n1", state: "failed", reason: "broke" }]);
	dispose(run, f.configs[2], "blocked", "n2 is blocked", [{ node_id: "n2", state: "blocked", reason: "n1 failed" }]);
	const result = (node_id: string, status: "success" | "failure") => ({ node_id, status, summary: `${node_id} ${status}`, detail: "" });
	await assert.rejects(f.service.report(run.task_id, [result("n1", "failure"), result("n2", "success"), result("n3", "success")], false, buildMarkdownReport), /Node n2 did not execute \(blocked\); it cannot have a result/);
	await assert.rejects(f.service.report(run.task_id, [], false, buildMarkdownReport), /exactly one result for each planned agent that executed/);
	const paths = await f.service.report(run.task_id, [result("n1", "failure")], false, buildMarkdownReport);
	assert.deepEqual(paths.results.map(entry => [entry.node_id, entry.status]), [["n1", "failure"], ["n2", "blocked"], ["n3", "blocked"]]);
});

test("evidence for the checks a node must pass is exposed as missing, unverified, stale, failed or passing", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes", [{ required_checks: ["tests", "lint", "types", "docs", "perf"] }, {}, {}]), request_id: "evidence" });
	const [first] = run.pane_manifest;
	writeFileSync(join(f.cwd, "code.txt"), "v1");
	const identity = { run_id: run.task_id, node_id: "n1", persona_name: "first", attempt_id: first.attempt_id!, instance_id: first.instance_id };
	const record = (check: string, result: "pass" | "fail", options: { scope?: string[]; during?: () => void } = {}) => {
		const started = beginVerificationCheck(f.cwd, check, options.scope);
		options.during?.();
		finishVerificationCheck(run.session_dir, identity, started, { result });
	};
	record("tests", "pass");
	record("lint", "pass", { during: () => writeFileSync(join(f.cwd, "during.txt"), "edited while the check ran") });
	record("types", "fail");
	record("docs", "pass", { scope: ["docs"] });
	finish(run, f.configs[0], "success");
	const evidenceOf = () => Object.fromEntries(f.service.status(run.task_id).agents[0].evidence!.map(item => [item.check, item.status]));
	// "tests" and "docs" passed; the later "lint" run edited the project, which makes "tests" (whole-project scope) stale already.
	assert.deepEqual(evidenceOf(), { tests: "stale", lint: "unverified", types: "failed", docs: "passing", perf: "missing" });
	record("tests", "pass");
	writeFileSync(join(f.cwd, "code.txt"), "v2: changed after the checks ran");
	assert.deepEqual(evidenceOf(), { tests: "stale", lint: "unverified", types: "failed", docs: "passing", perf: "missing" }, "a change outside docs/ leaves the docs-scoped check current");
	const text = formatAgentStates(f.service.status(run.task_id).agents);
	assert.match(text, /\[evidence: tests stale, lint unverified, types failed, docs passing, perf missing\]/);
	assert.match(text, /\[checks: tests=pass\/stale/, "the recorded verification summary is still shown");
	assert.equal(f.service.status(run.task_id).agents[1].evidence, undefined, "a node with no required checks has no evidence to show");
});

// ---- compatibility fixtures: records written before this release, and records this release cannot read ----

/** A run exactly as the previous release (identities, no policies or outcomes) persisted it: version 2 for the node form, version 1 persona-keyed. */
function writePersistedRun(f: ReturnType<typeof fixture>, version: 1 | 2, taskId: string) {
	const project = realpathSync(f.cwd);
	const sessionDir = join(project, ".pi", "agent-sessions", taskId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	const entry = (n: 1 | 2) => ({
		...(version === 1 ? { agent_name: n === 1 ? "first" : "second" } : { node_id: `n${n}`, persona_name: n === 1 ? "first" : "second", attempt_id: `a${n}-n${n}.1` }),
		instance_id: `a${n}-n${n}`, expected_coms_name: `a${n}-n${n}`, expected_model: "provider/model", label: `${taskId}:a${n}-n${n}`, step: n,
		...(n === 1 ? { successor: "a2-n2" } : { predecessor: "a1-n1" }), tab_id: `t${n}`, pane_id: `p${n}`, terminal_id: `term${n}`, status: "released",
	});
	const manifest = {
		version, ...(version === 2 ? { request_form: "nodes" } : {}), task_id: taskId, task: "Old chain", topology: "chain", project_cwd: project, session_dir: sessionDir, workspace_id: "origin-workspace",
		coms_project: `boot-${taskId}`, status: "applied", phase: "released", token: "old-token", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", pane_manifest: [entry(1), entry(2)],
	};
	mkdirSync(f.options.stateDir, { recursive: true });
	for (const path of [join(f.options.stateDir, `${taskId}.json`), join(sessionDir, "manifest.json")]) writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
	for (const n of [1, 2] as const) f.tabs.push({ tab_id: `t${n}`, pane_id: `p${n}`, terminal_id: `term${n}`, label: `${taskId}:a${n}-n${n}`, cwd: f.cwd });
	const record = (n: 1 | 2, status: string, summary: string) => JSON.stringify(version === 1
		? { result: { agent_name: n === 1 ? "first" : "second", status, summary, detail: "" }, delivery: "not_required", completed_at: "2026-01-01T00:01:00.000Z" }
		: { version: 2, identity: { run_id: taskId, node_id: `n${n}`, persona_name: n === 1 ? "first" : "second", attempt_id: `a${n}-n${n}.1`, instance_id: `a${n}-n${n}` }, result: { agent_name: n === 1 ? "first" : "second", node_id: `n${n}`, status, summary, detail: "" }, delivery: "not_required", completed_at: "2026-01-01T00:01:00.000Z" });
	writeFileSync(join(sessionDir, "a1-n1.result.json"), record(1, "partial", "Half done"));
	writeFileSync(join(sessionDir, "a2-n2.result.json"), record(2, "success", "Went ahead on the partial input"));
	return { taskId, sessionDir, manifestText: readFileSync(join(sessionDir, "manifest.json"), "utf8") };
}

for (const version of [1, 2] as const) {
	test(`a version ${version} run written before outcomes existed is read under its original allow_partial behavior and keeps its stored form`, async t => {
		const f = fixture(t);
		const old = writePersistedRun(f, version, `old-v${version}-run`);
		const status = f.service.status(old.taskId);
		assert.deepEqual(status.agents.map(agent => [agent.dependency_policy, agent.execution, agent.resource, agent.state]), [[undefined, "partial", "released", "done"], ["allow_partial", "succeeded", "released", "done"]],
			"the successor ran on a partial predecessor, as allow_partial permits; nothing is reinterpreted as blocked");
		assert.equal(status.outcome.state, "partial");
		assert.deepEqual(status.pending, []);
		const paths = await f.service.report(old.taskId, undefined, false, buildMarkdownReport);
		assert.deepEqual(paths.results.map(entry => [entry.status, (entry as any).execution_state]), [["partial", "partial"], ["success", "succeeded"]]);
		await f.service.cleanup(old.taskId);
		for (const path of [join(f.options.stateDir, `${old.taskId}.json`), join(old.sessionDir, "manifest.json")]) {
			const stored = readJson<any>(path);
			assert.equal(stored.version, version);
			assert.equal(stored.status, "cleaned");
			assert.equal(JSON.stringify(stored).includes("dependency_policy"), false, "a stored run is never rewritten with policies it never had");
		}
	});
}

test("an unsupported or foreign disposition or evidence record is reported for that node only and is never trusted", async t => {
	const f = fixture(t);
	const run = await f.service.generate({ ...f.chain("nodes", [{ required_checks: ["tests"] }, {}, {}]), request_id: "damaged" });
	const [first, second] = run.pane_manifest;
	const good = dispositionRecord(f.configs[1], "blocked", "n1 failed", [{ node_id: "n1", state: "failed", reason: "x" }], new Date().toISOString());
	const check = (record: unknown, pattern: RegExp) => {
		atomicJson(dispositionPath(run.session_dir, second.instance_id), record);
		const status = f.service.status(run.task_id);
		assert.match(status.agents[1].error!, pattern);
		assert.equal(status.agents[1].execution, "needs_attention", "an unreadable record is an attention condition, not a guess");
		assert.equal(status.agents[0].error, undefined, "the other nodes stay readable");
	};
	check({ ...good, version: 9 }, /unusable disposition file: Unsupported disposition record version 9: this release reads version 1/);
	check({ ...good, identity: { ...good.identity, node_id: "n3" } }, /disposition identity mismatch \(node_id "n3", expected "n2"\)/);
	check({ ...good, state: "succeeded" }, /malformed disposition record/);
	check({ version: 1 }, /disposition identity mismatch \(no identity recorded\)/);
	writeFileSync(verificationPath(run.session_dir, first.instance_id), JSON.stringify({ version: 4, records: [] }));
	rmSync(dispositionPath(run.session_dir, second.instance_id));
	assert.deepEqual(f.service.status(run.task_id).agents[0].evidence, [{ check: "tests", status: "unverified" }]);
});
