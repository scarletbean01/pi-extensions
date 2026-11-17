/** Handoff delivery versus task acceptance, observed through the worker hooks (source and destination) and the service's status. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, dispositionPath, readJson, readyPath, resultPath, type Disposition, type WorkerCompletion, type WorkerConfig } from "./session-store.ts";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

const roster = [
	{ instance_id: "a1-n1", node_id: "n1", persona_name: "first", sub_task: "one" },
	{ instance_id: "a2-n2", node_id: "n2", persona_name: "second", sub_task: "two" },
];
/** Chain node `n` of the two-node chain, speaking the durable handoff protocol. */
const chainNode = (n: 1 | 2, more: Partial<WorkerConfig> = {}): Partial<WorkerConfig> => ({
	topology: "chain", instance_id: `a${n}-n${n}`, node_id: `n${n}`, persona_name: roster[n - 1].persona_name, attempt_id: `a${n}-n${n}.1`, roster, handoff_protocol: 1,
	...(n === 1 ? { successor: "a2-n2" } : { predecessor: "a1-n1", dependency_policy: "require_success" as const }), ...more,
});

/** `sameRoot` starts another runtime (the other node, a /reload, or the next process) on the durable state of an earlier fixture. */
function worker(t: test.TestContext, overrides: Partial<WorkerConfig> = {}, sameRoot?: string) {
	const root = sameRoot ?? mkdtempSync(join(tmpdir(), "bootstrap-handoff-test-"));
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); if (!sameRoot) rmSync(root, { recursive: true, force: true }); });
	const config: WorkerConfig = {
		version: 2, task_id: "run-1", token: "token", session_dir: root, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "boot-run-1", instance_id: "a1-n1", node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1",
		persona: "PERSONA", tools: ["read"], sub_task: "Do the work", topology: "team",
		startup_message: "bootstrap-start:token:a1-n1", ready_timeout_ms: 1000, ...overrides,
	};
	const configPath = join(root, `${config.instance_id}.config.json`);
	atomicJson(configPath, config);
	const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
	mkdirSync(registryDir, { recursive: true });
	atomicJson(join(registryDir, `${config.instance_id}.json`), { pid: process.pid, name: config.instance_id, session_id: `session-${config.instance_id}`, endpoint: "/fake/socket", model: "model" });
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = ["read", "bash", "coms_send", "coms_get", "coms_await"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const behavior = { sendError: false };
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} }, shutdown: () => { shutdowns++; }, abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return behavior.sendError ? { isError: true, content: [{ type: "text", text: "receiver unreachable" }] } : { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {}, getFlag: () => configPath,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	return {
		root, config, configPath, hooks, tools, context, sent, behavior,
		get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		complete: (params = { status: "success", summary: "Done", detail: "Work complete" }) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
	};
}

/** What the dispatcher persists for a node before launch: its authoritative identity and input. */
function writeTaskInput(root: string, node: 1 | 2, runId = "run-1") {
	const identity = { run_id: runId, node_id: `n${node}`, persona_name: roster[node - 1].persona_name, attempt_id: `a${node}-n${node}.1`, instance_id: `a${node}-n${node}` };
	atomicJson(taskInputPath(root, identity.instance_id), buildTaskInputRecord({ identity, brief: { task: "Chain", goal: "Chain" }, assignment: { sub_task: roster[node - 1].sub_task }, roster }));
}

/** The source (n1) completes its work and offers the result to n2, whose readiness is on record. */
async function completedSource(t: test.TestContext, more: Partial<WorkerConfig> = {}, result?: { status: string; summary: string; detail: string }) {
	const source = worker(t, chainNode(1, more));
	const runId = more.task_id ?? "run-1";
	writeTaskInput(source.root, 2, runId);
	atomicJson(join(source.root, "upstream-index.json"), { version: 2, run_id: runId, updated_at: new Date().toISOString(), entries: [] });
	atomicJson(readyPath(source.root, "a2-n2"), { task_id: runId, token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	await source.start();
	await source.beforeStart();
	const done = await source.complete(result);
	assert.equal(done.isError, undefined, JSON.stringify(done));
	return source;
}
const offerPath = (root: string) => join(root, "a2-n2.handoff-offer.json");
const claimPath = (root: string) => join(root, "a2-n2.handoff.json");

test("a completed source records a durable handoff offer bound to run, source attempt, destination node and input digest before it notifies", async t => {
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	assert.match(offer.handoff_id, /^h-[0-9a-f]{32}$/);
	assert.equal(offer.version, 1);
	assert.equal(offer.run_id, "run-1");
	assert.deepEqual(offer.source, { node_id: "n1", persona_name: "first", attempt_id: "a1-n1.1", instance_id: "a1-n1" });
	assert.deepEqual(offer.destination, { node_id: "n2", attempt_id: "a2-n2.1", instance_id: "a2-n2" });
	assert.equal(offer.input_digest, readJson<any>(join(source.root, "upstream-index.json")).entries[0].result_hash, "the digest is the hash of the saved result the upstream index records");
	assert.match(offer.input_digest, /^[0-9a-f]{64}$/);
	// The notification only wakes the destination: it names the handoff and digest, but the durable offer is what decides.
	const prompt: string = source.sent[0].params.prompt;
	assert.match(prompt, new RegExp(`^bootstrap-handoff:token:a1-n1\\n`));
	assert.ok(prompt.includes(`handoff-id: ${offer.handoff_id}`) && prompt.includes(`input-digest: ${offer.input_digest}`));
});

test("a Coms transport ACK queues the handoff; it never records acceptance", async t => {
	const source = await completedSource(t);
	const offer = readJson<any>(offerPath(source.root));
	assert.equal(offer.state, "queued");
	assert.ok(offer.queued_at);
	assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
	assert.equal(existsSync(claimPath(source.root)), false, "no acceptance exists until the destination claims the handoff");
	assert.equal(existsSync(resultPath(source.root, "a2-n2")), false);
});

test("a failed notification leaves the offer unqueued, and the retry re-offers the same logical handoff", async t => {
	const source = worker(t, chainNode(1));
	writeTaskInput(source.root, 2);
	atomicJson(readyPath(source.root, "a2-n2"), { task_id: "run-1", token: "token", instance_id: "a2-n2", session_id: "session-a2-n2" });
	await source.start();
	await source.beforeStart();
	source.behavior.sendError = true;
	assert.equal((await source.complete()).isError, true);
	const offered = readJson<any>(offerPath(source.root));
	assert.equal(offered.state, "offered");
	assert.equal(offered.queued_at, undefined);
	source.behavior.sendError = false;
	await source.complete({ status: "success", summary: "Changed", detail: "ignored: the saved result is kept" });
	const queued = readJson<any>(offerPath(source.root));
	assert.equal(queued.handoff_id, offered.handoff_id);
	assert.equal(queued.input_digest, offered.input_digest);
	assert.equal(queued.state, "queued");
	assert.equal(source.sent.length, 2);
});

test("the handoff ID follows the run, source attempt, destination node and input digest", async t => {
	const base = readJson<any>(offerPath((await completedSource(t)).root)).handoff_id;
	const sameInputs = readJson<any>(offerPath((await completedSource(t)).root)).handoff_id;
	assert.equal(sameInputs, base, "identical run, attempt, destination and input give the same logical handoff");
	const otherInput = readJson<any>(offerPath((await completedSource(t, {}, { status: "success", summary: "Other", detail: "other input" })).root)).handoff_id;
	assert.notEqual(otherInput, base);
	const otherAttempt = readJson<any>(offerPath((await completedSource(t, { attempt_id: "a1-n1.2" })).root)).handoff_id;
	assert.notEqual(otherAttempt, base);
	const otherRun = readJson<any>(offerPath((await completedSource(t, { task_id: "run-2" })).root)).handoff_id;
	assert.notEqual(otherRun, base);
});

test("a worker without the durable handoff protocol (a run from the previous release) keeps the original notification and writes no offer", async t => {
	const source = await completedSource(t, { handoff_protocol: undefined });
	assert.equal(existsSync(offerPath(source.root)), false);
	assert.doesNotMatch(source.sent[0].params.prompt, /handoff-id:/);
	assert.equal(readJson<WorkerCompletion>(resultPath(source.root, "a1-n1")).delivery, "sent");
});

void readFileSync; void writeFileSync; void dispositionPath; void ({} as Disposition);
