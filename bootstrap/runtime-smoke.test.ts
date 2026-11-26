/**
 * Runtime integration tests: real Pi + Coms startup, no model request and no Herdr tab creation.
 * All Pi config/trust/session/Coms state is isolated (see test-harness.ts); any model call reaches only a local fake provider and fails the test.
 * Missing prerequisites (Pi binary, Coms extension, sandboxed process spawning) are reported as UNVERIFIED skips, or as failures with PI_BOOTSTRAP_TEST_STRICT=1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, completionRecord, delay, dispositionPath, readJson, readyPath, resultPath, workerStartupMessages, type Disposition, type WorkerCompletion, type WorkerConfig, type WorkerReady } from "./session-store.ts";
import { buildTaskInputRecord, resultHash, taskInputPath, upsertUpstreamIndex } from "./contracts.ts";
import { handoffClaimPath, handoffNotification, offerHandoff, type HandoffClaim } from "./handoff.ts";
import { reserveRevision } from "./review-loop.ts";
import { writeCancelRecord } from "./cancellation.ts";
import { BootstrapService, executableOnPath, shellQuote } from "./lifecycle.ts";
import { createManagerAuthority, factoryOperations } from "../factory/operations.ts";
import { fakeProviderExtensionSource, gate, isolatedPiEnvironment, probeCommand, runSupervised, spawnGroup, startFakeProvider, type SpawnedGroup } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const piReady = await probeCommand("pi", ["--no-extensions", "--version"]);
const comsReady = existsSync(coms) ? { ok: true } : { ok: false, reason: `Coms extension not found at ${coms} (set PI_BOOTSTRAP_TEST_COMS_EXTENSION)` };
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];

test("real Pi loads bootstrap tools with the host SDK and TypeBox", async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	// Pi expects a selectable model even for a command-only RPC session. Never load real credentials.
	const provider = await startFakeProvider();
	t.after(() => provider.close());
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl));
	const result = await runSupervised("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", join(extensionDir, "bootstrap.ts")], { input: '{"id":"smoke","type":"get_commands"}\n', timeoutMs: 15_000, env: iso.env, cwd: iso.root });
	assert.equal(result.timedOut, false, "Pi timed out");
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /"name":"boot"/);
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Coms worker acknowledges startup and consumes follower activation without a model request", { timeout: 20_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const config: WorkerConfig = {
		version: 2, task_id: "smoke-123", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-smoke", instance_id: "a2-follower", node_id: "follower", persona_name: "follower", attempt_id: "a2-follower.1",
		persona: "Smoke-test persona; never call a model.", tools: [], sub_task: "Wait for predecessor", topology: "chain",
		predecessor: "a1-first", startup_message: "bootstrap-start:smoke-token:a2-follower", ready_timeout_ms: 10_000,
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	// Any unexpected model work is confined to a fake provider on localhost, never a user's real provider; it is recorded and refused.
	const modelMarker = join(root, "unexpected-model-request");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl, { markerFile: modelMarker }));
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", config.instance_id, "--project", config.coms_project, "--bootstrap-worker-config", configPath], { cwd: root, env: iso.env });
	const { child, closed } = group;
	t.after(async () => { await group.stop(); await provider.close(); iso.cleanup(); });
	child.stdout.on("data", data => { stdout += data.toString(); });
	child.stderr.on("data", data => { stderr += data.toString(); });
	const until = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 12_000;
		while (!predicate()) {
			assert.equal(child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};
	await until(() => existsSync(readyPath(root, config.instance_id)), "Worker did not acknowledge readiness");
	const ready = readJson<WorkerReady>(readyPath(root, config.instance_id));
	assert.equal(ready.pid, child.pid);
	assert.equal(ready.name, config.instance_id);
	assert.ok(ready.session_id);
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: config.startup_message }) + "\n");
	await until(() => stdout.includes('"id":"activate"'), "Follower startup prompt was not consumed");
	assert.equal(stderr, "");
	assert.ok(!stdout.includes('"type":"agent_start"'), "Follower activation must not issue a model request");
	atomicJson(readyPath(root, "a1-first"), { session_id: "expected-predecessor" });
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(ready.endpoint);
		socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Coms admission smoke timed out")); });
		socket.on("error", reject);
		socket.on("connect", () => socket.write(JSON.stringify({ type: "prompt", msg_id: "smoke-untrusted", sender_session: "untrusted-sender", sender_endpoint: join(root, "no-sender.sock"), sender_name: "untrusted", sender_cwd: root, hops: 0, timestamp: new Date().toISOString(), prompt: "bootstrap-handoff:smoke-token:a1-first" }) + "\n"));
		socket.on("data", () => { socket.destroy(); resolve(); });
	});
	await delay(200);
	child.stdin.write('{"id":"after-rejection","type":"get_state"}\n');
	await until(() => stdout.includes('"id":"after-rejection"'), "Rejected handoff did not return to idle");
	assert.equal(existsSync(modelMarker), false, `Untrusted handoff must be aborted before provider work\n${stdout}\n${stderr}`);
	provider.assertNoUnexpectedCalls();
	child.stdin.end();
	await closed;
	assert.equal(child.exitCode, 0, stderr);
	assert.deepEqual(iso.homeLeaks(), [], "worker wrote under the fake HOME");
});

test("real bootstrap launch fails immediately with the wanted and assigned Coms names after a collision", { timeout: 45_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const project = join(root, "collision-project");
	const bin = join(root, "bin");
	const providerPath = join(root, "fake-provider.ts");
	const marker = join(root, "unexpected-model-request");
	mkdirSync(join(project, ".pi", "agents"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl, { markerFile: marker }));
	writeFileSync(join(project, ".pi", "agents", "worker.md"), `---\nname: worker\nmodel: bootstrap-fake/model\nextensions: ${providerPath}\n---\nWait for bootstrap admission.\n`);
	const realPi = executableOnPath("pi", iso.env);
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${shellQuote(realPi)} --mode rpc --no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files --offline --no-session "$@"\n`, { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const env = { ...iso.env, PATH: `${bin}:${iso.env.PATH}`, HERDR_ENV: "1", HERDR_PANE_ID: "collision-dispatcher" };
	const groups: SpawnedGroup[] = [];
	const addOutput = (group: SpawnedGroup) => {
		const stream = { stdout: "", stderr: "" };
		group.child.stdout.on("data", data => { stream.stdout += data.toString(); });
		group.child.stderr.on("data", data => { stream.stderr += data.toString(); });
		groups.push(group);
		return stream;
	};
	t.after(async () => {
		for (const group of groups) await group.stop();
		await provider.close();
		iso.cleanup();
	});
	let sequence = 0;
	let currentLabel = "";
	const service = new BootstrapService({
		extensionDir,
		stateDir: iso.stateDir,
		home: iso.home,
		env,
		pollMs: 10,
		exec: async (_command, args) => {
			const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "collision-workspace" } });
			if (args[0] === "tab" && args[1] === "create") {
				sequence++;
				currentLabel = args[args.indexOf("--label") + 1];
				return ok({ tab: { tab_id: `collision-tab-${sequence}` }, root_pane: { pane_id: `collision-pane-${sequence}`, terminal_id: `collision-terminal-${sequence}` } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const [taskId, instanceId] = currentLabel.split(":");
				const sessionDir = join(project, ".pi", "agent-sessions", taskId!);
				const config = readJson<WorkerConfig>(join(sessionDir, `${instanceId}.config.json`));
				const blocker = spawnGroup("pi", [
					"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc",
					"-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms,
					"--cname", instanceId!, "--project", config.coms_project,
				], { cwd: project, env });
				const blockerOutput = addOutput(blocker);
				const expectedRegistry = join(iso.comsDir, "projects", config.coms_project, "agents", `${instanceId}.json`);
				const deadline = Date.now() + 15_000;
				while (!existsSync(expectedRegistry)) {
					assert.equal(blocker.child.exitCode, null, `Coms name holder exited during startup\n${blockerOutput.stderr}\n${blockerOutput.stdout}`);
					assert.ok(Date.now() < deadline, `Coms name holder did not register\n${blockerOutput.stderr}\n${blockerOutput.stdout}`);
					await delay(25);
				}
				const worker = spawnGroup("/bin/sh", [join(sessionDir, `${instanceId}.sh`)], { cwd: project, env });
				addOutput(worker);
				return ok();
			}
			throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
		},
	});
	const startedAt = Date.now();
	const run = await service.generate({
		topology: "chain", task: "Detect a Coms name collision", project_cwd: project, coms_extension: coms, ready_timeout_ms: 60_000,
		agents: [{ persona: "worker", node_id: "worker", sub_task: "Wait for bootstrap admission." }],
	});
	const expectedName = run.pane_manifest[0]!.instance_id;
	const assignedName = `${expectedName}2`;
	assert.equal(run.status, "error", run.error);
	assert.match(run.error ?? "", new RegExp(`coms name collision: wanted ${expectedName}, got ${assignedName}`));
	assert.doesNotMatch(run.error ?? "", /readiness timeout/i);
	assert.ok(Date.now() - startedAt < 20_000, `collision should fail before the 60s readiness deadline (elapsed ${Date.now() - startedAt}ms)`);
	assert.equal(existsSync(readyPath(run.session_dir, expectedName)), false, "a renamed worker must not acknowledge readiness");
	assert.equal(existsSync(marker), false, "collision must fail before requesting model work");
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Coms worker with handoff_protocol=1 rejects notification without a durable offer before calling provider", { timeout: 20_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const config: WorkerConfig = {
		version: 2, task_id: "smoke-hp1", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-smoke-hp1", instance_id: "a2-follower", node_id: "follower", persona_name: "follower", attempt_id: "a2-follower.1",
		persona: "Smoke-test persona; never call a model.", tools: [], sub_task: "Wait for predecessor", topology: "chain",
		predecessor: "a1-first", handoff_protocol: 1, startup_message: "bootstrap-start:smoke-token:a2-follower", ready_timeout_ms: 10_000,
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	const modelMarker = join(root, "unexpected-model-request");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl, { markerFile: modelMarker }));
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", config.instance_id, "--project", config.coms_project, "--bootstrap-worker-config", configPath], { cwd: root, env: iso.env });
	const { child, closed } = group;
	t.after(async () => { await group.stop(); await provider.close(); iso.cleanup(); });
	child.stdout.on("data", data => { stdout += data.toString(); });
	child.stderr.on("data", data => { stderr += data.toString(); });
	const until = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 12_000;
		while (!predicate()) {
			assert.equal(child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};
	await until(() => existsSync(readyPath(root, config.instance_id)), "Worker did not acknowledge readiness");
	const ready = readJson<WorkerReady>(readyPath(root, config.instance_id));
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: config.startup_message }) + "\n");
	await until(() => stdout.includes('"id":"activate"'), "Follower startup prompt was not consumed");
	atomicJson(readyPath(root, "a1-first"), { session_id: "expected-predecessor" });
	// Even from the genuine predecessor session, a notification without a durable offer must be rejected before any provider call.
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(ready.endpoint);
		socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Coms admission smoke timed out")); });
		socket.on("error", reject);
		socket.on("connect", () => socket.write(JSON.stringify({ type: "prompt", msg_id: "smoke-no-offer", sender_session: "expected-predecessor", sender_endpoint: join(root, "no-sender.sock"), sender_name: "a1-first", sender_cwd: root, hops: 0, timestamp: new Date().toISOString(), prompt: "bootstrap-handoff:smoke-token:a1-first" }) + "\n"));
		socket.on("data", () => { socket.destroy(); resolve(); });
	});
	await delay(200);
	child.stdin.write('{"id":"after-rejection","type":"get_state"}\n');
	await until(() => stdout.includes('"id":"after-rejection"'), "Rejected handoff did not return to idle");
	assert.equal(existsSync(modelMarker), false, `Offerless handoff must be aborted before provider work\n${stdout}\n${stderr}`);
	const rejections = readJson<{ rejections: Array<{ kind: string; severity: string }> }>(join(root, `${config.instance_id}.handoff-rejections.json`));
	assert.deepEqual(rejections.rejections.map(r => [r.kind, r.severity]), [["offer", "notification"]]);
	provider.assertNoUnexpectedCalls();
	child.stdin.end();
	await closed;
	assert.equal(child.exitCode, 0, stderr);
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Coms worker observes durable cancellation after release without calling provider", { timeout: 20_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const config: WorkerConfig = {
		version: 2, task_id: "smoke-cancel-1", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-smoke-cancel", instance_id: "a2-follower", node_id: "follower", persona_name: "follower", attempt_id: "a2-follower.1",
		persona: "Smoke-test persona; never call a model.", tools: [], sub_task: "Wait for predecessor", topology: "chain",
		predecessor: "a1-first", startup_message: "bootstrap-start:smoke-token:a2-follower", ready_timeout_ms: 10_000,
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	const modelMarker = join(root, "unexpected-model-request");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl, { markerFile: modelMarker }));
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", config.instance_id, "--project", config.coms_project, "--bootstrap-worker-config", configPath], { cwd: root, env: iso.env });
	const { child, closed } = group;
	t.after(async () => { await group.stop(); await provider.close(); iso.cleanup(); });
	child.stdout.on("data", data => { stdout += data.toString(); });
	child.stderr.on("data", data => { stderr += data.toString(); });
	const until = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 12_000;
		while (!predicate()) {
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};
	await until(() => existsSync(readyPath(root, config.instance_id)), "Worker did not acknowledge readiness");
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: config.startup_message }) + "\n");
	await until(() => stdout.includes('"id":"activate"'), "Follower startup prompt was not consumed");
	writeCancelRecord(root, {
		identity: { run_id: config.task_id, node_id: config.node_id, persona_name: config.persona_name, attempt_id: config.attempt_id, instance_id: config.instance_id },
		scope: "node", reason: "Smoke test cancel", requestedAt: new Date().toISOString(), graceMs: 5000,
	});
	await until(() => existsSync(dispositionPath(root, config.instance_id)), "Cancelled worker did not record disposition");
	const disp = readJson<Disposition>(dispositionPath(root, config.instance_id));
	assert.equal(disp.state, "cancelled");
	assert.equal(existsSync(modelMarker), false);
	provider.assertNoUnexpectedCalls();
	child.stdin.end();
	await closed;
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi parked loop worker records no failure when its process ends", { timeout: 25_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	let turn = 0;
	const server = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			turn += 1;
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-parked", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (turn === 1) {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: "call_complete_1",
						type: "function",
						function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: "Parked build", detail: "Built before exit" }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Parked and idle" }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-parked", object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("server failed to bind");
	const root = iso.root;
	const config: WorkerConfig = {
		version: 5, task_id: "smoke-parked", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-smoke", instance_id: "a1-n1", node_id: "n1", persona_name: "builder", attempt_id: "a1-n1.1",
		persona: "Complete once and stay parked.", tools: [], sub_task: "Complete the build", topology: "chain",
		next: "a2-n2", handoff_protocol: 1, startup_message: "bootstrap-start:smoke-token:a1-n1", ready_timeout_ms: 10_000,
		review_plan: {
			max_total_attempts: 6, max_total_attempts_source: "built-in", node_count: 2,
			loops: [{ reviewer: "a2-n2", target: "a1-n1", members: ["a1-n1", "a2-n2"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 2, on_exhausted: "needs_attention" }],
		},
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", config.instance_id, "--project", config.coms_project, "--bootstrap-worker-config", configPath], { cwd: root, env: iso.env });
	const { child, closed } = group;
	t.after(async () => { await group.stop(); server.closeAllConnections(); server.close(); iso.cleanup(); });
	child.stdout.on("data", data => { stdout += data.toString(); });
	child.stderr.on("data", data => { stderr += data.toString(); });
	const until = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			assert.equal(child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};
	await until(() => existsSync(readyPath(root, config.instance_id)), "Worker did not acknowledge readiness");
	atomicJson(join(root, "release.json"), { task_id: config.task_id, token: config.token });
	child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: config.startup_message }) + "\n");
	const savedResult = resultPath(root, "a1-n1.1");
	await until(() => existsSync(savedResult) && stdout.includes('"type":"agent_end"'), "Parked worker did not complete attempt 1");
	assert.equal(child.exitCode, null, "Parked worker must stay alive after completing attempt 1");
	child.stdin.end();
	await closed;
	assert.equal(child.exitCode, 0, stderr);
	assert.equal(existsSync(join(root, "a1-n1.1.error.json")), false, "Parked worker shutdown recorded an attempt error");
	assert.equal(existsSync(join(root, "a1-n1.error.json")), false, "Parked worker shutdown recorded a node error");
	assert.equal(readJson<WorkerCompletion>(savedResult).result.summary, "Parked build");
	assert.deepEqual(iso.homeLeaks(), []);
});

interface CapturedProviderRequest {
	turn: number;
	body: {
		model?: string;
		messages?: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
		tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: { required?: string[]; properties?: Record<string, unknown> } } }>;
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(part => (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string")
			? (part as { text: string }).text
			: JSON.stringify(part)).join("\n");
	}
	return content == null ? "" : JSON.stringify(content);
}

async function runAttempt2RevisionHarness(
	t: test.TestContext,
	attempt2Responses: Array<{ kind: "text"; text: string } | { kind: "complete"; summary: string; detail: string }>,
) {
	const iso = isolatedPiEnvironment();
	const root = iso.root;
	const skillDir = join(iso.agentDir, "skills", "rev-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: rev-skill\ndescription: Revision skill instructions.\n---\nFollow revision skill.\n");

	const captured: CapturedProviderRequest[] = [];
	let turn = 0;
	let attempt2Index = 0;
	const server = createServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", chunk => parts.push(chunk));
		req.on("end", () => {
			turn += 1;
			const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
			captured.push({ turn, body });
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-rev-${turn}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (turn === 1) {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: "call_complete_1",
						type: "function",
						function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: "Initial ticket 01 build", detail: "Implemented ticket 01 on attempt 1" }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else if (turn === 2) {
				res.write(chunk({ role: "assistant", content: "Attempt 1 complete and handed off." }, null));
				res.write(chunk({}, "stop"));
			} else {
				const scripted = attempt2Responses[attempt2Index++];
				if (scripted?.kind === "complete") {
					res.write(chunk({
						role: "assistant",
						tool_calls: [{
							index: 0,
							id: `call_complete_2_${attempt2Index}`,
							type: "function",
							function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: scripted.summary, detail: scripted.detail }) },
						}],
					}, null));
					res.write(chunk({}, "tool_calls"));
				} else {
					res.write(chunk({ role: "assistant", content: scripted?.text ?? "Task is complete." }, null));
					res.write(chunk({}, "stop"));
				}
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-rev-${turn}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("server failed to bind");

	const reviewerSock = join(iso.comsDir, "sockets", "a2-n2.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const receivedByReviewer: string[] = [];
	const reviewerNet = createNetServer(sock => {
		let buf = "";
		sock.on("data", data => {
			buf += data.toString();
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				const env = JSON.parse(buf.slice(0, idx)) as { type?: string; msg_id?: string; prompt?: string };
				if (env.type === "prompt") {
					receivedByReviewer.push(env.prompt ?? "");
					sock.write(JSON.stringify({ type: "ack", msg_id: env.msg_id }) + "\n");
				}
				sock.end();
			}
		});
	});
	await new Promise<void>((resolve, reject) => { reviewerNet.once("error", reject); reviewerNet.listen(reviewerSock, () => resolve()); });

	const project = "bootstrap-smoke-rev";
	const reviewerSession = "sess-reviewer-a2";
	mkdirSync(join(iso.comsDir, "projects", project, "agents"), { recursive: true });
	atomicJson(join(iso.comsDir, "projects", project, "agents", "a2-n2.json"), {
		session_id: reviewerSession, name: "a2-n2", purpose: "reviewer", model: "model", color: "blue",
		pid: process.pid, endpoint: reviewerSock, cwd: root, started_at: new Date().toISOString(), explicit: false, version: 1,
	});

	const reviewPlan = {
		max_total_attempts: 6, max_total_attempts_source: "built-in" as const, node_count: 2,
		loops: [{ reviewer: "a2-n2", target: "a1-n1", members: ["a1-n1", "a2-n2"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 2, on_exhausted: "needs_attention" as const }],
	};
	const roster = [
		{ instance_id: "a1-n1", node_id: "write-01", persona_name: "builder", step: 1, sub_task: "Implement ticket 01" },
		{ instance_id: "a2-n2", node_id: "review-01", persona_name: "reviewer", step: 2, sub_task: "Review ticket 01" },
	];
	const builderConfig: WorkerConfig = {
		version: 5, task_id: "smoke-rev-1", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: project, instance_id: "a1-n1", node_id: "write-01", persona_name: "builder", attempt_id: "a1-n1.1",
		persona: "You are a builder persona.", tools: [], task: "Ship ticket 01", goal: "Pass review", sub_task: "Implement ticket 01",
		topology: "chain", successor: "a2-n2", outbound_edges: ["a2-n2"], handoff_protocol: 1,
		startup_message: "bootstrap-start:smoke-token:a1-n1", ready_timeout_ms: 10_000,
		roster, review_plan: reviewPlan,
	};
	const reviewerConfig: WorkerConfig = {
		version: 5, task_id: "smoke-rev-1", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: project, instance_id: "a2-n2", node_id: "review-01", persona_name: "reviewer", attempt_id: "a2-n2.1",
		persona: "You are a reviewer persona.", tools: [], task: "Ship ticket 01", goal: "Pass review", sub_task: "Review ticket 01",
		topology: "chain", predecessor: "a1-n1", handoff_protocol: 1,
		startup_message: "bootstrap-start:smoke-token:a2-n2", ready_timeout_ms: 10_000,
		roster, review_plan: reviewPlan,
	};

	atomicJson(join(root, "a1-n1.config.json"), builderConfig);
	atomicJson(join(root, "a2-n2.config.json"), reviewerConfig);
	atomicJson(readyPath(root, "a2-n2"), {
		version: 1, task_id: "smoke-rev-1", token: "smoke-token", instance_id: "a2-n2",
		pid: process.pid, name: "a2-n2", session_id: reviewerSession, endpoint: reviewerSock, model: "bootstrap-fake/model",
	});
	atomicJson(taskInputPath(root, "a1-n1.1"), buildTaskInputRecord({
		identity: { run_id: "smoke-rev-1", node_id: "write-01", persona_name: "builder", attempt_id: "a1-n1.1", instance_id: "a1-n1" },
		brief: { task: "Ship ticket 01", goal: "Pass review" },
		assignment: { sub_task: "Implement ticket 01" },
		roster,
	}));
	atomicJson(taskInputPath(root, "a2-n2.1"), buildTaskInputRecord({
		identity: { run_id: "smoke-rev-1", node_id: "review-01", persona_name: "reviewer", attempt_id: "a2-n2.1", instance_id: "a2-n2" },
		brief: { task: "Ship ticket 01", goal: "Pass review" },
		assignment: { sub_task: "Review ticket 01" },
		roster,
	}));
	atomicJson(join(root, "upstream-index.json"), { version: 2, run_id: "smoke-rev-1", updated_at: new Date().toISOString(), entries: [] });

	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [
		"--no-extensions", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc",
		"-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", builderConfig.instance_id, "--project", builderConfig.coms_project, "--bootstrap-worker-config", join(root, "a1-n1.config.json"),
		"--allowed-skills", "rev-skill",
	], { cwd: root, env: iso.env });
	const { child, closed } = group;
	t.after(async () => { await group.stop(); server.closeAllConnections(); server.close(); reviewerNet.close(); iso.cleanup(); });
	child.stdout.on("data", data => { stdout += data.toString(); });
	child.stderr.on("data", data => { stderr += data.toString(); });

	const until = async (predicate: () => boolean, message: string, allowExit = false) => {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			if (!allowExit) assert.equal(child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};

	const [launchCmd, startupMsg] = workerStartupMessages(builderConfig.startup_message, true);
	await until(() => stdout.includes("coms ready"), "Coms did not initialize");
	child.stdin.write(JSON.stringify({ id: "launch", type: "prompt", message: launchCmd }) + "\n");
	await until(() => existsSync(readyPath(root, "a1-n1")), "Builder worker did not acknowledge readiness");
	const builderReady = readJson<WorkerReady>(readyPath(root, "a1-n1"));
	atomicJson(join(root, "release.json"), { task_id: builderConfig.task_id, token: builderConfig.token });
	await until(() => stdout.includes('"id":"launch"'), "Builder launch command did not settle after release");
	child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: startupMsg }) + "\n");

	await until(() => existsSync(resultPath(root, "a1-n1.1")) && receivedByReviewer.length >= 1 && stdout.includes('"type":"agent_settled"'), "Builder did not complete and park after attempt 1");

	const revResultPath = resultPath(root, "a2-n2.1");
	const revCompletion = completionRecord(reviewerConfig, {
		status: "success",
		agent_name: "reviewer",
		summary: "Changes requested: missing edge-case test for empty input",
		detail: "Finding 1: Add a test covering empty input in foo.test.ts and fix the null guard in foo.ts.",
		outputs: { verdict: "revise" },
	}, "pending");
	atomicJson(revResultPath, revCompletion);
	await upsertUpstreamIndex(root, "smoke-rev-1", {
		node_id: "review-01", persona_name: "reviewer", attempt_id: "a2-n2.1", instance_id: "a2-n2", step: 2,
		status: "success", summary: revCompletion.result.summary, completed_at: revCompletion.completed_at,
		result_path: revResultPath, result_hash: resultHash(revCompletion.result), outputs: revCompletion.result.outputs,
	});
	assert.equal(await reserveRevision(root, "smoke-rev-1", reviewPlan, reviewPlan.loops[0], 2), undefined);
	const offer = offerHandoff(reviewerConfig, revCompletion, revResultPath, undefined, undefined, "a1-n1", "a2-n2", 2);
	const notification = handoffNotification(reviewerConfig, offer, revResultPath, false);

	await new Promise<void>((resolve, reject) => {
		const sock = createConnection(builderReady.endpoint);
		sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("Coms revision wake timed out")); });
		sock.on("error", reject);
		sock.on("connect", () => sock.write(JSON.stringify({
			type: "prompt", msg_id: "smoke-rev-wake-1", sender_session: reviewerSession, sender_endpoint: reviewerSock,
			sender_name: "a2-n2", sender_cwd: root, hops: 0, timestamp: new Date().toISOString(), prompt: notification,
		}) + "\n"));
		sock.on("data", () => { sock.destroy(); resolve(); });
	});

	return { iso, root, captured, receivedByReviewer, offer, revResultPath, child, closed, until, getOutput: () => ({ stdout, stderr }) };
}

test("real Pi parked loop worker receives unparked tools, skills, and explicit revision directive on attempt 2, and fails closed if model still omits bootstrap_complete", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const run = await runAttempt2RevisionHarness(t, [
		{ kind: "text", text: "Task is complete. Ticket 01 was completed in attempt 1." },
		{ kind: "text", text: "Task is still complete." },
	]);
	await run.until(() => existsSync(join(run.root, "a1-n1.2.error.json")), "Attempt 2 error was not recorded", true);
	await run.closed;

	const claim = readJson<HandoffClaim>(handoffClaimPath(run.root, "a1-n1.2", "a2-n2"));
	assert.equal(claim.state, "accepted");
	assert.equal(claim.destination.attempt_id, "a1-n1.2");
	assert.equal(claim.handoff_id, run.offer.handoff_id);

	// Initial attempt-2 request (turn 3) must carry restored tools, skills, schema, identity, findings, and an unambiguous revision directive.
	assert.equal(run.captured.length, 4, `Expected 2 attempt-1 turns + 1 attempt-2 turn + 1 bounded continuation turn, got ${run.captured.length}`);
	const attempt2Req = run.captured[2]!.body;
	const toolDefs = attempt2Req.tools ?? [];
	const completeTool = toolDefs.find(tool => tool.function?.name === "bootstrap_complete");
	assert.ok(completeTool, "bootstrap_complete tool schema must reach provider on attempt 2");
	assert.deepEqual(completeTool.function?.parameters?.required, ["status", "summary", "detail"]);
	assert.ok(toolDefs.some(tool => tool.function?.name === "read"), "core tools must be restored in attempt-2 tool inventory");

	const messages = attempt2Req.messages ?? [];
	const systemPrompt = messageText(messages.find(m => ["system", "developer"].includes(m.role))?.content);
	assert.match(systemPrompt, /Attempt: a1-n1\.2\./);
	assert.doesNotMatch(systemPrompt, /<tools>\s*\(none\)/, "Attempt-2 system prompt must not advertise <tools>(none) after unparking");
	assert.match(systemPrompt, /- read:/, "Attempt-2 system prompt must include restored tool descriptions");
	assert.match(systemPrompt, /<name>rev-skill<\/name>/, "Attempt-2 system prompt must preserve allowed skills after unparking");
	assert.match(systemPrompt, /Revision directive:.*a1-n1\.2/i);
	assert.match(systemPrompt, /superseded history|do NOT complete attempt a1-n1\.2/i);
	assert.match(systemPrompt, /missing edge-case test for empty input/);
	assert.match(systemPrompt, /Finding 1: Add a test covering empty input/);
	assert.match(systemPrompt, /bootstrap_read_input/);

	// Attempt-1 tool result in conversation history must not tell a parked loop worker it is permanently done.
	const attempt1ToolResult = messages.find(m => m.role === "tool");
	assert.ok(attempt1ToolResult, "Attempt-1 tool result should be in conversation history");
	assert.doesNotMatch(messageText(attempt1ToolResult.content), /you are done and need not wait/i);
	assert.match(messageText(attempt1ToolResult.content), /a1-n1\.1.*parked/i);

	// The last message on the revision turn must be an explicit revision directive referencing attempt 2 and the review findings.
	const lastMsg = messageText(messages[messages.length - 1]?.content);
	assert.match(lastMsg, /NEW REVISION ASSIGNMENT.*a1-n1\.2/);
	assert.match(lastMsg, /a1-n1\.1/);
	assert.match(lastMsg, /missing edge-case test for empty input/);
	assert.match(lastMsg, /bootstrap_complete/);

	// Bounded continuation (turn 4) must ask once for attempt 2 completion without replaying or resetting the claim.
	const continuationMessages = run.captured[3]!.body.messages ?? [];
	const reminderText = messageText(continuationMessages[continuationMessages.length - 1]?.content);
	assert.match(reminderText, /a1-n1\.2.*still active/i);
	assert.match(reminderText, /Do not redo work you already completed/i);
	assert.match(reminderText, /bootstrap_complete/);

	// Persistent plain text must still fail closed with no attempt-2 result and the exact error, keeping the accepted claim intact.
	assert.equal(existsSync(resultPath(run.root, "a1-n1.2")), false);
	assert.deepEqual(readJson<{ error: string }>(join(run.root, "a1-n1.2.error.json")), { error: "Worker settled without calling bootstrap_complete" });
	assert.equal(readJson<HandoffClaim>(handoffClaimPath(run.root, "a1-n1.2", "a2-n2")).handoff_id, run.offer.handoff_id);
	assert.deepEqual(run.iso.homeLeaks(), []);
});

test("real Pi parked loop worker completes attempt 2 on the same worker and routes revised handoff back to reviewer", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const run = await runAttempt2RevisionHarness(t, [
		{ kind: "complete", summary: "Revised ticket 01 build", detail: "Added empty-input test and fixed null guard." },
		{ kind: "text", text: "Attempt 2 complete and parked." },
	]);
	const savedAttempt2 = resultPath(run.root, "a1-n1.2");
	await run.until(() => existsSync(savedAttempt2) && run.receivedByReviewer.length >= 2, "Attempt 2 result was not saved and routed back to reviewer");
	await delay(150);
	assert.equal(run.child.exitCode, null, "Reused loop worker should stay parked after attempt 2");
	const completion = readJson<WorkerCompletion>(savedAttempt2);
	assert.equal(completion.identity?.attempt_id, "a1-n1.2");
	assert.equal(completion.identity?.instance_id, "a1-n1");
	assert.equal(completion.result.summary, "Revised ticket 01 build");
	assert.equal(completion.delivery, "sent");
	assert.match(run.receivedByReviewer[1]!, /a2-n2\.2/);
	assert.equal(existsSync(join(run.root, "a1-n1.2.error.json")), false);

	run.child.stdin.end();
	await run.closed;
	assert.equal(run.child.exitCode, 0, run.getOutput().stderr);
	assert.equal(existsSync(join(run.root, "a1-n1.2.error.json")), false);
	assert.deepEqual(run.iso.homeLeaks(), []);
});

test("real Pi parked loop worker recovers from a plain-text revision reply via one bounded completion reminder", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const run = await runAttempt2RevisionHarness(t, [
		{ kind: "text", text: "Task is complete." },
		{ kind: "complete", summary: "Revised after completion reminder", detail: "Fixed edge case and called bootstrap_complete." },
		{ kind: "text", text: "Attempt 2 complete and parked." },
	]);
	const savedAttempt2 = resultPath(run.root, "a1-n1.2");
	await run.until(() => existsSync(savedAttempt2) && run.receivedByReviewer.length >= 2, "Worker did not recover attempt 2 via bounded reminder");
	await delay(150);
	const completion = readJson<WorkerCompletion>(savedAttempt2);
	assert.equal(completion.identity?.attempt_id, "a1-n1.2");
	assert.equal(completion.result.summary, "Revised after completion reminder");
	assert.equal(existsSync(join(run.root, "a1-n1.2.error.json")), false);
	assert.equal(readJson<HandoffClaim>(handoffClaimPath(run.root, "a1-n1.2", "a2-n2")).handoff_id, run.offer.handoff_id);

	run.child.stdin.end();
	await run.closed;
	assert.equal(run.child.exitCode, 0, run.getOutput().stderr);
	assert.deepEqual(run.iso.homeLeaks(), []);
});

test("real Pi RPC handles /factory resume, exact untrimmed /factory submit, read-only receipt recovery, and second-session fencing without model calls", { timeout: 25_000 }, async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const projectDir = join(root, "project");
	const agentPersonas = join(projectDir, ".pi", "agents");
	mkdirSync(agentPersonas, { recursive: true });
	writeFileSync(join(agentPersonas, "reviewer.md"), "---\nname: reviewer\ntools: read\n---\nReview carefully.\n");
	writeFileSync(join(projectDir, "coms.ts"), "export default function () {}\n");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl));
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const draft = {
		project_cwd: projectDir,
		topology: "graph",
		task: "Factory runtime smoke",
		coms_extension: join(projectDir, "coms.ts"),
		agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review" }],
	};
	const exactBrief = "  \tleading space\nline 2 #42 src/app.ts 🚀\ntrailing space  \n\n";

	async function runRpcSession(sessionFile: string | undefined, script: (req: any) => unknown) {
		const args = [...isolated.filter(a => a !== "--no-session"), ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]),
			"-e", providerPath, "--model", "bootstrap-fake/model", "-e", join(extensionDir, "bootstrap.ts")];
		const group = spawnGroup("pi", args, { cwd: projectDir, env: iso.env });
		let buf = "";
		let stderr = "";
		const notifications: Array<{ notifyType: string; message: string }> = [];
		const responses: any[] = [];
		group.child.stderr.on("data", d => { stderr += d.toString(); });
		group.child.stdout.on("data", d => {
			buf += d.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const msg = JSON.parse(line);
				responses.push(msg);
				if (msg.type === "extension_ui_request") {
					if (msg.method === "notify") {
						notifications.push({ notifyType: msg.notifyType ?? "info", message: msg.message });
					} else if (msg.method === "editor" || msg.method === "confirm") {
						const reply = script(msg);
						group.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, ...reply }) + "\n");
					}
				}
			}
		});
		const until = async (predicate: () => boolean, label: string) => {
			const deadline = Date.now() + 12_000;
			while (!predicate()) {
				assert.equal(group.child.exitCode, null, `${label}: child exited\n${stderr}`);
				assert.ok(Date.now() < deadline, `${label}\n${stderr}`);
				await delay(20);
			}
		};
		const sendPrompt = async (id: string, message: string) => {
			group.child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
			await until(() => responses.some(r => r.type === "agent_end" || (r.id === id && r.type === "response" && r.success === false)), `prompt ${id}`);
			// For slash commands in RPC mode, Pi returns {type:"response", id, command:"prompt", success:true} after handler completes.
		};
		const runCmd = async (id: string, message: string) => {
			const beforeCount = notifications.length;
			group.child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
			await until(() => responses.some(r => r.id === id && r.type === "response") && notifications.length > beforeCount, `command ${id}`);
			await delay(50);
			return notifications.slice(beforeCount);
		};
		return { group, notifications, responses, until, runCmd, sendPrompt, getStderr: () => stderr };
	}

	const sessionFile = join(root, "shared-transcript.jsonl");
	const s1 = await runRpcSession(sessionFile, req => {
		if (req.method === "editor" && req.title.includes("Publish factory")) {
			return { value: JSON.stringify({ name: "rpc-factory", draft }) };
		}
		if (req.method === "confirm") return { confirmed: true };
		if (req.method === "editor" && req.title.includes("Submit plain-text brief")) {
			return { value: exactBrief };
		}
		return { cancelled: true };
	});
	t.after(async () => { await s1.group.stop(); });

	const pubNotes = await s1.runCmd("pub", "/factory publish");
	const published = JSON.parse(pubNotes.at(-1)!.message);
	assert.equal(published.management, "unmanaged");

	const resNotes = await s1.runCmd("res", `/factory resume ${published.factory_id}`);
	assert.equal(resNotes.at(-1)!.notifyType, "info");
	assert.equal(JSON.parse(resNotes.at(-1)!.message).factory.management, "managed");

	const subNotes = await s1.runCmd("sub", `/factory submit ${published.factory_id}`);
	assert.ok(subNotes.some(n => n.notifyType === "info" && /Submission reference: sub-[a-f0-9-]+/.test(n.message)));
	const receipt = JSON.parse(subNotes.at(-1)!.message);
	assert.equal(receipt.brief, exactBrief);
	assert.equal(receipt.bound_version, "v1");
	assert.equal(receipt.disposition, "queued");
	assert.equal(receipt.queue_position, 1);

	s1.group.child.stdin.end();
	await s1.group.closed;

	// Second process even pointing at the same transcript file cannot silently inherit authority,
	// while read-only receipt recovery works cleanly.
	const s2 = await runRpcSession(sessionFile, () => ({ cancelled: true }));
	t.after(async () => { await s2.group.stop(); });

	const fencedResume = await s2.runCmd("res2", `/factory resume ${published.factory_id}`);
	assert.equal(fencedResume.at(-1)!.notifyType, "error");
	assert.match(fencedResume.at(-1)!.message, /already managed|another session/i);

	const fencedSubmit = await s2.runCmd("sub2", `/factory submit ${published.factory_id}`);
	assert.equal(fencedSubmit.at(-1)!.notifyType, "error");
	assert.match(fencedSubmit.at(-1)!.message, /authority|managing session/i);

	const recNotes = await s2.runCmd("rec2", `/factory receipt ${published.factory_id} ${receipt.reference}`);
	assert.equal(recNotes.at(-1)!.notifyType, "info");
	assert.deepEqual(JSON.parse(recNotes.at(-1)!.message), receipt);

	s2.group.child.stdin.end();
	await s2.group.closed;
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("RawBriefEditor preserves leading/trailing whitespace and newlines on Pi's real Editor while stock Editor trims", { timeout: 20_000 }, async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	const probeExt = join(iso.root, "probe-editor.ts");
	const editorModule = join(extensionDir, "factory", "editor.ts");
	writeFileSync(probeExt, `
import { Editor } from "@mariozechner/pi-tui";
import { createRawBriefEditorClass } from ${JSON.stringify(editorModule)};
export default function (pi) {
	pi.registerCommand("probe-editor", {
		description: "Probe real Pi Editor vs RawBriefEditor",
		handler: async (_args, ctx) => {
			const tui = { requestRender() {}, terminal: { rows: 100, columns: 120 } };
			const theme = {
				borderColor: s => s,
				selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s },
			};
			const inputText = "  leading\\nmiddle\\ntrailing  \\n";
			let stockResult = "";
			const stock = new Editor(tui, theme);
			stock.onSubmit = text => { stockResult = text; };
			stock.setText(inputText);
			stock.handleInput("\\r");

			let rawResult = "";
			const RawBriefEditor = createRawBriefEditorClass(Editor);
			const raw = new RawBriefEditor(tui, theme, text => { rawResult = text; });
			raw.setText(inputText);
			raw.handleInput("\\r");

			ctx.ui.notify(JSON.stringify({ stockResult, rawResult }), "info");
		},
	});
}
`);
	t.after(() => iso.cleanup());

	const group = spawnGroup("pi", [...isolated, "-e", probeExt], { cwd: iso.root, env: iso.env });
	t.after(async () => { await group.stop(); });
	let buf = "";
	let stderr = "";
	let notified: string | undefined;
	group.child.stderr.on("data", d => { stderr += d.toString(); });
	group.child.stdout.on("data", d => {
		buf += d.toString();
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			if (msg.type === "extension_ui_request" && msg.method === "notify") {
				notified = msg.message;
			}
		}
	});
	group.child.stdin.write(JSON.stringify({ id: "probe", type: "prompt", message: "/probe-editor" }) + "\n");
	const deadline = Date.now() + 12_000;
	while (!notified) {
		assert.equal(group.child.exitCode, null, `child exited: ${stderr}`);
		assert.ok(Date.now() < deadline, `timed out waiting for probe-editor: ${stderr}`);
		await delay(20);
	}
	group.child.stdin.end();
	await group.closed;
	const parsed = JSON.parse(notified);
	assert.equal(parsed.stockResult, "leading\nmiddle\ntrailing");
	assert.equal(parsed.rawResult, "  leading\nmiddle\ntrailing  \n");
	assert.deepEqual(iso.homeLeaks(), []);
});

test("RawBriefEditor preserves adversarial bracketed-paste payloads, avoids raw control output in TUI rows, supports edits/cancel, and uses ctx.mode + injected keybindings", { timeout: 25_000 }, async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	const probeExt = join(iso.root, "probe-paste-editor.ts");
	const editorModule = join(extensionDir, "factory", "editor.ts");
	writeFileSync(probeExt, `
import { Editor } from "@mariozechner/pi-tui";
import { createRawBriefEditorClass, openBriefEditor } from ${JSON.stringify(editorModule)};
export default function (pi) {
	pi.registerCommand("probe-paste", {
		description: "Probe real Pi Editor bracketed paste vs RawBriefEditor",
		handler: async (_args, ctx) => {
			const tui = { requestRender() {}, terminal: { rows: 100, columns: 120 } };
			const theme = {
				fg: (_role, text) => text,
				borderColor: s => s,
				selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s },
			};
			// Adversarial payload: leading/trailing spaces & newlines, tabs, CRLF, standalone CR, non-ASCII + combining mark + emoji,
			// path/tilde/dot after a typed word, >1000 chars + >10 lines to trigger paste markers in stock Editor,
			// literal paste-marker lookalikes, and control chars (BEL, SGR ANSI, DEL).
			const longBlock = Array.from({ length: 12 }, (_, i) => "row-" + i + "-" + "x".repeat(90)).join("\\n");
			const pastedTail = "/src/app.ts\\t~home\\r\\n.dot #42 café e\\u0301 🚀\\rCR-line\\n"
				+ "[paste #1 1234 chars]\\n[paste #1 +12 lines]\\n"
				+ "\\x07\\x1b[31mred\\x1b[0m\\x7f\\n"
				+ longBlock + "\\n  trailing  \\n\\n";

			// Stock Editor mangles this payload across normalizeText, control filtering, auto-space before /~., and paste markers.
			let stockResult = "";
			const stock = new Editor(tui, theme);
			stock.onSubmit = text => { stockResult = text; };
			stock.handleInput("word");
			stock.handleInput("\\x1b[200~" + pastedTail + "\\x1b[201~");
			stock.handleInput("\\r");

			// RawBriefEditor preserves exact payload across chunked bracketed paste + editing + newline.
			let rawResult = "";
			const RawBriefEditor = createRawBriefEditorClass(Editor);
			const raw = new RawBriefEditor(tui, theme, text => { rawResult = text; });
			raw.handleInput("word");
			const half = Math.floor(pastedTail.length / 2);
			raw.handleInput("\\x1b[200~" + pastedTail.slice(0, half));
			raw.handleInput(pastedTail.slice(half) + "\\x1b[201~");
			const renderedRows = raw.render(120);
			// Edit after paste: type, backspace, Shift/Alt+Enter newline, type, Enter submit.
			raw.handleInput("A");
			raw.handleInput("B");
			raw.handleInput("\\x7f");
			raw.handleInput("\\n");
			raw.handleInput("Z");
			raw.handleInput("\\r");

			// Verify openBriefEditor honors ctx.mode === "tui" and uses injected keybindings (cancel + paste submit).
			let injectedMatches = 0;
			const fakeKeybindings = {
				matches: (data, action) => {
					injectedMatches++;
					return action === "tui.select.cancel" && data === "\\x1b";
				},
			};
			const customTuiCtx = {
				mode: "tui",
				hasUI: true,
				ui: {
					custom: async (factory) => {
						let resolved;
						const comp = factory(tui, theme, fakeKeybindings, val => { resolved = val; });
						comp.handleInput("\\x1b[200~  \\ta\\r\\nb  \\x1b[201~");
						comp.handleInput("\\x1b");
						return resolved;
					},
					editor: async () => "fallback-should-not-run",
				},
			};
			const cancelledResult = await openBriefEditor(customTuiCtx, "Title", "Help");

			const customSubmitCtx = {
				mode: "tui",
				hasUI: true,
				ui: {
					custom: async (factory) => {
						let resolved;
						const comp = factory(tui, theme, fakeKeybindings, val => { resolved = val; });
						comp.handleInput("\\x1b[200~  \\ta\\r\\nb  \\x1b[201~");
						comp.handleInput("\\r");
						return resolved;
					},
					editor: async () => "fallback-should-not-run",
				},
			};
			const submittedViaCustom = await openBriefEditor(customSubmitCtx, "Title", "Help");

			ctx.ui.notify(JSON.stringify({
				stockResult,
				rawResult,
				expectedRaw: "word" + pastedTail + "A\\nZ",
				renderedJoined: renderedRows.join("\\n"),
				cancelledResult: cancelledResult === undefined ? null : cancelledResult,
				submittedViaCustom,
				injectedMatches,
			}), "info");
		},
	});
}
`);
	t.after(() => iso.cleanup());

	const group = spawnGroup("pi", [...isolated, "-e", probeExt], { cwd: iso.root, env: iso.env });
	t.after(async () => { await group.stop(); });
	let buf = "";
	let stderr = "";
	let notified: string | undefined;
	group.child.stderr.on("data", d => { stderr += d.toString(); });
	group.child.stdout.on("data", d => {
		buf += d.toString();
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			if (msg.type === "extension_ui_request" && msg.method === "notify") {
				notified = msg.message;
			}
		}
	});
	group.child.stdin.write(JSON.stringify({ id: "probe-paste", type: "prompt", message: "/probe-paste" }) + "\n");
	const deadline = Date.now() + 15_000;
	while (!notified) {
		assert.equal(group.child.exitCode, null, `child exited: ${stderr}`);
		assert.ok(Date.now() < deadline, `timed out waiting for probe-paste: ${stderr}`);
		await delay(20);
	}
	group.child.stdin.end();
	await group.closed;
	const parsed = JSON.parse(notified);
	assert.notEqual(parsed.stockResult, parsed.expectedRaw, "stock Editor is expected to mangle adversarial bracketed paste");
	assert.equal(parsed.rawResult, parsed.expectedRaw);
	assert.ok(parsed.renderedJoined.includes("\u2407\u241b[31mred\u241b[0m\u2421"), "rendered TUI rows must show sanitized control pictures");
	const withoutPiCursorMarkers = parsed.renderedJoined.replace(/\x1b_pi:(?:\/?fc|c)\x07/g, "");
	assert.equal(withoutPiCursorMarkers.includes("\t"), false, "rendered TUI rows must not contain raw tab");
	assert.equal(withoutPiCursorMarkers.includes("\r"), false, "rendered TUI rows must not contain raw CR");
	assert.equal(withoutPiCursorMarkers.includes("\x07"), false, "rendered TUI rows must not contain raw BEL");
	assert.equal(withoutPiCursorMarkers.includes("\x1b"), false, "rendered TUI rows must not contain raw pasted ESC");
	assert.equal(withoutPiCursorMarkers.includes("\x7f"), false, "rendered TUI rows must not contain raw DEL");
	assert.equal(parsed.cancelledResult, null);
	assert.equal(parsed.submittedViaCustom, "  \ta\r\nb  ");
	assert.ok(parsed.injectedMatches > 0);
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi TUI PTY smoke executes /factory resume and /factory submit with bracketed paste verbatim without model calls", { timeout: 25_000 }, async t => {
	const pyReady = await probeCommand("python3", ["--version"]);
	if (!gate(t, piReady) || !gate(t, pyReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const projectDir = join(root, "project");
	const agentPersonas = join(projectDir, ".pi", "agents");
	mkdirSync(agentPersonas, { recursive: true });
	writeFileSync(join(agentPersonas, "reviewer.md"), "---\nname: reviewer\ntools: read\n---\nReview carefully.\n");
	writeFileSync(join(projectDir, "coms.ts"), "export default function () {}\n");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl));
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const service = new BootstrapService({
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		extensionDir,
		home: iso.home,
		env: iso.env,
	});
	const dbPath = join(iso.stateDir, "factories.sqlite");
	const published = factoryOperations(dbPath, service)({
		action: "publish",
		name: "pty-factory",
		draft: {
			project_cwd: projectDir,
			topology: "graph",
			task: "PTY smoke",
			coms_extension: join(projectDir, "coms.ts"),
			agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review" }],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "medium" },
	});

	const exactBrief = "  \tleading\r\nword/path ~home .dot #77 [paste #1 500 chars] café 🚀\rCR\n\x07\x1b[31mred\x1b[0m  \n\n";
	const pyDriver = join(root, "pty_driver.py");
	writeFileSync(pyDriver, `
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

factory_id = sys.argv[1]
ext_path = sys.argv[2]
provider_path = sys.argv[3]
brief = json.loads(sys.argv[4])

env = os.environ.copy()
env["TERM"] = "xterm-256color"
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
p = subprocess.Popen(
    ["pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session",
     "-e", provider_path, "--model", "bootstrap-fake/model", "-e", ext_path],
    stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True
)
os.close(slave)
out = bytearray()

def read_until(needle, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in out:
            return True
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            chunk = os.read(master, 16384)
            if not chunk:
                break
            out.extend(chunk)
        if p.poll() is not None:
            return needle in out
    return needle in out

assert read_until(b"\\x1b[?2004h"), f"Pi TUI did not become ready: {bytes(out[-500:])!r}"
time.sleep(0.25)
os.write(master, f"/factory resume {factory_id}\\r".encode("utf-8"))
assert read_until(b"already_managed"), f"resume did not succeed: {bytes(out[-800:])!r}"
time.sleep(0.1)
os.write(master, f"/factory submit {factory_id} pty-exact-ref\\r".encode("utf-8"))
assert read_until(b"Submit plain-text brief"), f"submit editor did not open: {bytes(out[-800:])!r}"
time.sleep(0.1)
payload = b"\\x1b[200~" + brief.encode("utf-8") + b"\\x1b[201~"
os.write(master, payload)
time.sleep(0.15)
os.write(master, b"\\r")
assert read_until(b'"input_id"'), f"submit receipt not shown: {bytes(out[-1200:])!r}"
os.write(master, b"\\x04")
p.wait(timeout=5)
os.close(master)
assert p.returncode == 0, f"pi exited {p.returncode}"
sys.stdout.buffer.write(bytes(out))
`);

	const ptyResult = await runSupervised("python3", [pyDriver, published.factory_id, join(extensionDir, "bootstrap.ts"), providerPath, JSON.stringify(exactBrief)], {
		cwd: projectDir,
		env: { ...iso.env, PI_FACTORY_STATE_DIR: iso.stateDir },
		timeoutMs: 20_000,
	});
	assert.equal(ptyResult.code, 0, ptyResult.stderr);
	assert.equal(ptyResult.stdout.includes("\x1b[31m"), false, "PTY TUI output must not emit raw pasted SGR escape");
	assert.equal(ptyResult.stdout.includes("\x07red"), false, "PTY TUI output must not emit raw pasted BEL");

	const saved = factoryOperations(dbPath, service)({
		action: "receipt",
		factory_id: published.factory_id,
		reference: "pty-exact-ref",
	});
	assert.equal(saved.brief, exactBrief);
	assert.equal(saved.brief_bytes, Buffer.byteLength(exactBrief, "utf8"));
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi RPC enforces project trust and executes /factory launch into managing Herdr workspace without model calls", { timeout: 25_000 }, async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const projectDir = join(root, "project");
	const binDir = join(root, "bin");
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	// Adding .pi/settings.json engages Pi's project trust gate (defaultProjectTrust: "never" in isolatedPiEnvironment).
	writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
	writeFileSync(join(projectDir, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read\nmodel: bootstrap-fake/model\nthinking: medium\n---\nReview carefully.\n");
	writeFileSync(join(projectDir, "coms.ts"), "export default function () {}\n");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl));
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const herdrLog = join(root, "herdr.log");
	const fakeHerdr = join(binDir, "herdr");
	writeFileSync(fakeHerdr, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(herdrLog)}, JSON.stringify(args) + "\\n");
const ok = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
	if (args[2] !== "managing-pane-rpc") process.exit(1);
	ok({ pane: { workspace_id: "managing-ws-rpc" } });
} else if (args[0] === "tab" && args[1] === "create") {
	ok({ tab: { tab_id: "tab-rpc-1" }, root_pane: { pane_id: "pane-rpc-1", terminal_id: "term-rpc-1" } });
} else if (args[0] === "pane" && args[1] === "run") {
	const m = args[3].match(/\\/bin\\/sh (\\S+)/);
	const sh = readFileSync(m[1], "utf8");
	const cfgPath = sh.match(/--bootstrap-worker-config' '([^']+)'/)[1];
	const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
	const ready = { version: 1, task_id: cfg.task_id, token: cfg.token, instance_id: cfg.instance_id, name: cfg.instance_id, pid: process.ppid, session_id: "s-rpc-1", endpoint: "/tmp/rpc-coms", model: cfg.expected_model };
	writeFileSync(join(cfg.session_dir, cfg.instance_id + ".ready.json"), JSON.stringify(ready));
	const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
	mkdirSync(regDir, { recursive: true });
	writeFileSync(join(regDir, cfg.instance_id + ".json"), JSON.stringify(ready));
	ok({});
} else {
	process.exit(1);
}
`, { mode: 0o700 });

	const service = new BootstrapService({
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		extensionDir,
		home: iso.home,
		env: { ...iso.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
	});
	const dbPath = join(iso.stateDir, "factories.sqlite");
	const published = factoryOperations(dbPath, service)({
		action: "publish",
		name: "rpc-launch-factory",
		draft: {
			project_cwd: projectDir,
			topology: "graph",
			task: "RPC launch smoke",
			coms_extension: join(projectDir, "coms.ts"),
			agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review" }],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "medium" },
	});

	const runRpcCmds = async (extraFlags: string[], cmds: Array<{ id: string; message: string }>) => {
		const args = [...isolated, ...extraFlags, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", join(extensionDir, "bootstrap.ts")];
		const rpcEnv = {
			...iso.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "managing-pane-rpc",
		};
		const group = spawnGroup("pi", args, { cwd: projectDir, env: rpcEnv });
		let buf = "";
		let stderr = "";
		const notifications: Array<{ notifyType: string; message: string }> = [];
		const responses: any[] = [];
		group.child.stderr.on("data", d => { stderr += d.toString(); });
		group.child.stdout.on("data", d => {
			buf += d.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const msg = JSON.parse(line);
				responses.push(msg);
				if (msg.type === "extension_ui_request") {
					if (msg.method === "notify") {
						notifications.push({ notifyType: msg.notifyType ?? "info", message: msg.message });
					} else if (msg.method === "editor") {
						group.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, value: "RPC multiline\r\nbrief" }) + "\n");
					} else if (msg.method === "confirm") {
						group.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: true }) + "\n");
					}
				}
			}
		});
		const out: Array<Array<{ notifyType: string; message: string }>> = [];
		try {
			for (const cmd of cmds) {
				const before = notifications.length;
				group.child.stdin.write(JSON.stringify({ id: cmd.id, type: "prompt", message: cmd.message }) + "\n");
				const deadline = Date.now() + 12_000;
				while (!(responses.some(r => r.id === cmd.id && r.type === "response") && notifications.length > before)) {
					assert.equal(group.child.exitCode, null, `child exited: ${stderr}`);
					assert.ok(Date.now() < deadline, `timed out on ${cmd.id}: ${stderr}`);
					await delay(20);
				}
				await delay(30);
				out.push(notifications.slice(before));
			}
		} finally {
			group.child.stdin.end();
			await group.closed;
		}
		return out;
	};

	// Untrusted session (defaultProjectTrust: "never" with .pi/settings.json) blocks /factory launch without taking holds!
	const untrustedNotes = await runRpcCmds([], [
		{ id: "r1", message: `/factory resume ${published.factory_id}` },
		{ id: "s1", message: `/factory submit ${published.factory_id} rpc-ref-1` },
		{ id: "l1", message: `/factory launch ${published.factory_id}` },
	]);
	assert.equal(untrustedNotes[2].at(-1)!.notifyType, "error");
	assert.match(untrustedNotes[2].at(-1)!.message, /not trusted/i);

	// Trusted session (--approve) launches into managing-ws-rpc; same session resumes idempotently and launches FIFO head!
	// Note: s1 exited above so we publish a second trusted-ready factory for the --approve session.
	const pub2 = factoryOperations(dbPath, service)({
		action: "publish",
		name: "rpc-launch-trusted",
		draft: {
			project_cwd: projectDir,
			topology: "graph",
			task: "RPC trusted launch",
			coms_extension: join(projectDir, "coms.ts"),
			agents: [{ persona: "reviewer", node_id: "review", sub_task: "Review" }],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "medium" },
	});
	const trustedNotes = await runRpcCmds(["--approve"], [
		{ id: "r2", message: `/factory resume ${pub2.factory_id}` },
		{ id: "s2", message: `/factory submit ${pub2.factory_id} rpc-ref-2` },
		{ id: "l2", message: `/factory launch ${pub2.factory_id}` },
		{ id: "i2", message: `/factory inspect ${pub2.factory_id}` },
	]);
	assert.equal(trustedNotes[2].at(-1)!.notifyType, "info", trustedNotes[2].at(-1)!.message);
	const launchJson = JSON.parse(trustedNotes[2].at(-1)!.message);
	assert.equal(launchJson.release_authorized, true);
	assert.equal(launchJson.bound_version, "v1");
	const inspectJson = JSON.parse(trustedNotes[3].at(-1)!.message);
	assert.equal(inspectJson.capacity.factory_slot, "held");
	assert.equal(inspectJson.attempts[0].task_id, launchJson.task_id);
	assert.equal(inspectJson.attempts[0].run.release_marker_present, true);
	const herdrLines = readFileSync(herdrLog, "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.ok(herdrLines.some(args => args[0] === "tab" && args.includes("managing-ws-rpc")));
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi worker refuses factory admission without model call when run-local manifest token is tampered after launch", { timeout: 25_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider();
	const root = iso.root;
	const projectDir = join(root, "project");
	const binDir = join(root, "bin");
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(projectDir, ".pi", "agents", "worker.md"), "---\nname: worker\ntools: read\nmodel: bootstrap-fake/model\nthinking: medium\n---\nWork carefully.\n");
	writeFileSync(join(binDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(binDir, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const modelMarker = join(root, "unexpected-model-request");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.baseUrl, { markerFile: modelMarker }));
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string }> = [];
	let seq = 0;
	const service = new BootstrapService({
		exec: async (_cmd, args) => {
			const ok = (val: unknown = "") => ({ code: 0, stdout: typeof val === "string" ? val : JSON.stringify({ result: val }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "ws-smoke" } });
			if (args[0] === "tab" && args[1] === "create") {
				seq++;
				const tab = { tab_id: `ts-${seq}`, pane_id: `ps-${seq}`, terminal_id: `terms-${seq}`, label: args[args.indexOf("--label") + 1] };
				tabs.push(tab);
				return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const tab = tabs.find(item => item.pane_id === args[2])!;
				const [task, instance] = tab.label.split(":");
				const sDir = join(projectDir, ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				const ready = { version: 1, task_id: task, token: cfg.token, instance_id: instance, name: instance, pid: process.pid, session_id: `s-${instance}`, endpoint: "/tmp/s-smoke", model: cfg.expected_model };
				atomicJson(readyPath(sDir, instance), ready);
				const regDir = join(cfg.coms_dir, "projects", cfg.coms_project, "agents");
				mkdirSync(regDir, { recursive: true });
				atomicJson(join(regDir, `${instance}.json`), ready);
				return ok();
			}
			throw new Error(`Unexpected herdr ${args.join(" ")}`);
		},
		extensionDir,
		stateDir: iso.stateDir,
		home: iso.home,
		env: { ...iso.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-smoke" },
		pollMs: 5,
	});
	const dbPath = join(iso.stateDir, "factories.sqlite");
	const open = () => factoryOperations(dbPath, service);
	const fac = open()({
		action: "publish",
		name: "smoke-local-manifest-fac",
		draft: {
			project_cwd: projectDir,
			topology: "graph",
			task: "Smoke local manifest guard",
			coms_extension: coms,
			agents: [{ persona: "worker", node_id: "work", sub_task: "Do work" }],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "medium" },
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-smoke" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "smoke-ref", brief: "Exact smoke brief", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

	const sessionDir = launched.manifest.session_dir;
	const localManifestPath = join(sessionDir, "manifest.json");
	const localManifest = readJson<Record<string, unknown>>(localManifestPath);
	atomicJson(localManifestPath, { ...localManifest, token: "tampered-smoke-manifest-token" });

	const cfgPath = join(sessionDir, "a1-work.config.json");
	const cfg = readJson<WorkerConfig>(cfgPath);
	rmSync(readyPath(sessionDir, cfg.instance_id), { force: true });
	rmSync(join(cfg.coms_dir, "projects", cfg.coms_project, "agents", `${cfg.instance_id}.json`), { force: true });
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [
		...isolated, "-e", providerPath, "--model", "bootstrap-fake/model",
		"-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", cfg.instance_id, "--project", cfg.coms_project,
		"--bootstrap-worker-config", cfgPath,
		...workerStartupMessages(cfg.startup_message),
	], { cwd: projectDir, env: iso.env });
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	t.after(() => group.stop());

	const deadline = Date.now() + 12_000;
	const childPid = group.child.pid;
	let activated = false;
	while (group.child.exitCode === null && !existsSync(join(sessionDir, "a1-work.error.json")) && !existsSync(modelMarker) && Date.now() < deadline) {
		if (!activated && existsSync(readyPath(sessionDir, cfg.instance_id))) {
			try {
				if (readJson<WorkerReady>(readyPath(sessionDir, cfg.instance_id)).pid === childPid) {
					activated = true;
					group.child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: cfg.startup_message }) + "\n");
				}
			} catch { /* wait for atomic write */ }
		}
		await delay(25);
	}
	group.child.stdin.end();
	await group.closed;

	assert.equal(existsSync(modelMarker), false, `Worker must never reach model provider on tampered manifest token\n${stdout}\n${stderr}`);
	assert.equal(readJson<WorkerReady>(readyPath(sessionDir, "a1-work")).pid, childPid, "Real Pi worker must reach finishStartup release barrier");
	assert.equal(existsSync(join(sessionDir, "a1-work.error.json")), true, "Worker must record startup failure");
	assert.match(readJson<{ error: string }>(join(sessionDir, "a1-work.error.json")).error, /manifest\.json.*token|run manifest\.json/i);
	provider.assertNoUnexpectedCalls();
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi worker records pane_id when running in Herdr and omits it otherwise, and accepts exact pane wake-ups end-to-end", { timeout: 45_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const root = iso.root;
	const capturedBodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
	const server = createServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", chunk => parts.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
			capturedBodies.push(body);
			const callNum = capturedBodies.length;
			const lastText = messageText(body.messages?.at(-1)?.content);
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-wake-${callNum}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (lastText.includes("please also inspect README")) {
				// Non-exact input reached a worker as normal user input: complete with a tool call.
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: `call_normal_${callNum}`,
						type: "function",
						function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: "Normal input handled", detail: "Completed normal prompt" }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else if (lastText.includes("bootstrap-handoff:")) {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: `call_wake_${callNum}`,
						type: "function",
						function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: "Accepted via pane wake-up", detail: "Ran after pane wake-up" }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Done." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-wake-${callNum}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("fake provider failed to bind");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	t.after(async () => { server.closeAllConnections(); server.close(); iso.cleanup(); });

	const roster = [
		{ instance_id: "a1-first", node_id: "first", persona_name: "first", sub_task: "Produce upstream output" },
		{ instance_id: "a2-follower", node_id: "follower", persona_name: "follower", sub_task: "Consume upstream output" },
	];
	const srcConfig: WorkerConfig = {
		version: 2, task_id: "wake-run-1", token: "wake-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-wake-smoke", instance_id: "a1-first", node_id: "first", persona_name: "first", attempt_id: "a1-first.1",
		persona: "Producer persona.", tools: [], sub_task: "Produce upstream output", topology: "chain",
		successor: "a2-follower", handoff_protocol: 1, roster, startup_message: "bootstrap-start:wake-token:a1-first", ready_timeout_ms: 10_000,
	};
	const destConfig: WorkerConfig = {
		version: 2, task_id: "wake-run-1", token: "wake-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-wake-smoke", instance_id: "a2-follower", node_id: "follower", persona_name: "follower", attempt_id: "a2-follower.1",
		persona: "Follower persona.", tools: [], sub_task: "Consume upstream output", topology: "chain",
		predecessor: "a1-first", dependency_policy: "require_success", handoff_protocol: 1, roster,
		startup_message: "bootstrap-start:wake-token:a2-follower", ready_timeout_ms: 10_000,
	};
	atomicJson(taskInputPath(root, "a2-follower"), buildTaskInputRecord({
		identity: { run_id: "wake-run-1", node_id: "follower", persona_name: "follower", attempt_id: "a2-follower.1", instance_id: "a2-follower" },
		brief: { task: "Wake smoke", goal: "Claim via pane wake-up" },
		assignment: { sub_task: "Consume upstream output" },
		roster,
	}));
	const srcResultFile = resultPath(root, "a1-first");
	const srcCompletion = completionRecord(srcConfig, { status: "success", agent_name: "first", node_id: "first", summary: "Upstream ready", detail: "Produced artifact" }, "pending", new Date().toISOString());
	atomicJson(srcResultFile, srcCompletion);
	atomicJson(join(root, "upstream-index.json"), {
		version: 2, run_id: "wake-run-1", updated_at: new Date().toISOString(),
		entries: [{
			node_id: "first", persona_name: "first", attempt_id: "a1-first.1", instance_id: "a1-first",
			status: "success", summary: srcCompletion.result.summary, completed_at: srcCompletion.completed_at,
			result_path: srcResultFile, result_hash: resultHash(srcCompletion.result),
		}],
	});
	// Notice: no a1-first.ready.json is written; pane wake-up does not require sender identity.
	const offer = offerHandoff(srcConfig, srcCompletion, srcResultFile);
	const destConfigPath = join(root, "a2-follower.config.json");
	atomicJson(destConfigPath, destConfig);
	atomicJson(join(root, "release.json"), { task_id: destConfig.task_id, token: destConfig.token });

	const spawnDest = (env: NodeJS.ProcessEnv) => {
		let stdout = "";
		let stderr = "";
		const group = spawnGroup("pi", [
			...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
			"--cname", destConfig.instance_id, "--project", destConfig.coms_project, "--bootstrap-worker-config", destConfigPath,
		], { cwd: root, env });
		group.child.stdout.on("data", data => { stdout += data.toString(); });
		group.child.stderr.on("data", data => { stderr += data.toString(); });
		const until = async (predicate: () => boolean, message: string, allowExit = false) => {
			const deadline = Date.now() + 12_000;
			while (!predicate()) {
				if (!allowExit) assert.equal(group.child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
				assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
				await delay(25);
			}
		};
		return { group, until, stdout: () => stdout, stderr: () => stderr };
	};

	// 1. Worker outside Herdr omits pane_id and still starts cleanly.
	const noPaneWorker = spawnDest(iso.env);
	t.after(() => noPaneWorker.group.stop());
	await noPaneWorker.until(() => existsSync(readyPath(root, destConfig.instance_id)), "Worker without Herdr pane did not acknowledge readiness");
	const readyWithoutPane = readJson<Record<string, unknown>>(readyPath(root, destConfig.instance_id));
	assert.equal("pane_id" in readyWithoutPane, false);
	noPaneWorker.group.child.stdin.end();
	await noPaneWorker.group.closed;
	rmSync(readyPath(root, destConfig.instance_id), { force: true });
	rmSync(join(iso.comsDir, "projects", destConfig.coms_project, "agents", `${destConfig.instance_id}.json`), { force: true });

	// 2. Worker inside Herdr records pane_id, refuses mismatched wake-ups, passes non-exact inputs, and claims exact wake-up.
	const herdrEnv = { ...iso.env, HERDR_ENV: "1", HERDR_PANE_ID: "pane-dest-99" };
	const workerProc = spawnDest(herdrEnv);
	t.after(() => workerProc.group.stop());
	await workerProc.until(() => existsSync(readyPath(root, destConfig.instance_id)), "Worker inside Herdr pane did not acknowledge readiness");
	const readyWithPane = readJson<WorkerReady>(readyPath(root, destConfig.instance_id));
	assert.equal(readyWithPane.pane_id, "pane-dest-99");

	workerProc.group.child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: destConfig.startup_message }) + "\n");
	await workerProc.until(() => workerProc.stdout().includes('"id":"activate"'), "Follower startup prompt was not consumed");

	// Exact wake-up naming an unknown handoff refuses safely without claiming or calling provider.
	workerProc.group.child.stdin.write(JSON.stringify({ id: "unknown-wake", type: "prompt", message: `[BOOTSTRAP_WAKE handoff=h-${"0".repeat(32)}]` }) + "\n");
	await workerProc.until(() => workerProc.stdout().includes('"id":"unknown-wake"'), "Unknown pane wake-up was not handled");
	await delay(150);
	assert.equal(capturedBodies.length, 0, "Unknown pane wake-up must not call provider");
	assert.equal(existsSync(handoffClaimPath(root, destConfig.instance_id)), false);

	// Exact wake-up matching an offer for a different run or different attempt refuses safely without claiming.
	atomicJson(join(root, `${destConfig.instance_id}.handoff-offer.json`), { ...offer, run_id: "other-run" });
	workerProc.group.child.stdin.write(JSON.stringify({ id: "other-run-wake", type: "prompt", message: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]` }) + "\n");
	await workerProc.until(() => workerProc.stdout().includes('"id":"other-run-wake"'), "Other-run pane wake-up was not handled");
	await delay(150);
	assert.equal(capturedBodies.length, 0, "Other-run pane wake-up must not call provider");
	assert.equal(existsSync(handoffClaimPath(root, destConfig.instance_id)), false);

	atomicJson(join(root, `${destConfig.instance_id}.handoff-offer.json`), { ...offer, destination: { ...offer.destination, attempt_id: "a2-follower.2" } });
	workerProc.group.child.stdin.write(JSON.stringify({ id: "other-attempt-wake", type: "prompt", message: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]` }) + "\n");
	await workerProc.until(() => workerProc.stdout().includes('"id":"other-attempt-wake"'), "Other-attempt pane wake-up was not handled");
	await delay(150);
	assert.equal(capturedBodies.length, 0, "Other-attempt pane wake-up must not call provider");
	assert.equal(existsSync(handoffClaimPath(root, destConfig.instance_id)), false);
	const allRejections = readJson<{ rejections: Array<{ kind: string }> }>(join(root, `${destConfig.instance_id}.handoff-rejections.json`));
	assert.deepEqual(allRejections.rejections.map(r => r.kind), ["conflict", "run", "attempt"]);

	// Restore valid offer and send exact matching wake-up.
	atomicJson(join(root, `${destConfig.instance_id}.handoff-offer.json`), offer);
	workerProc.group.child.stdin.write(JSON.stringify({ id: "valid-wake", type: "prompt", message: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]` }) + "\n");
	await workerProc.until(() => existsSync(resultPath(root, destConfig.instance_id)), "Valid pane wake-up did not claim and complete the attempt", true);
	await workerProc.group.closed;
	const claim = readJson<HandoffClaim>(handoffClaimPath(root, destConfig.instance_id));
	assert.equal(claim.state, "accepted");
	assert.equal(claim.handoff_id, offer.handoff_id);
	assert.equal(readJson<WorkerCompletion>(resultPath(root, destConfig.instance_id)).result.summary, "Accepted via pane wake-up");

	// 3. Non-exact input (form with extra text) passes through untouched to the agent as normal user input.
	const rootConfig: WorkerConfig = {
		version: 2, task_id: "wake-run-1", token: "wake-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-wake-smoke", instance_id: "a3-root", node_id: "root", persona_name: "first", attempt_id: "a3-root.1",
		persona: "Root persona.", tools: [], sub_task: "Handle normal input", topology: "team",
		startup_message: "bootstrap-start:wake-token:a3-root", ready_timeout_ms: 10_000,
	};
	const rootConfigPath = join(root, "a3-root.config.json");
	atomicJson(rootConfigPath, rootConfig);
	let rootStdout = "";
	let rootStderr = "";
	const rootGroup = spawnGroup("pi", [
		...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", rootConfig.instance_id, "--project", rootConfig.coms_project, "--bootstrap-worker-config", rootConfigPath,
	], { cwd: root, env: herdrEnv });
	t.after(() => rootGroup.stop());
	rootGroup.child.stdout.on("data", data => { rootStdout += data.toString(); });
	rootGroup.child.stderr.on("data", data => { rootStderr += data.toString(); });
	const waitRoot = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 12_000;
		while (!predicate()) {
			assert.ok(Date.now() < deadline, `${message}\n${rootStderr}\n${rootStdout}`);
			await delay(25);
		}
	};
	await waitRoot(() => existsSync(readyPath(root, rootConfig.instance_id)), "Root worker did not acknowledge readiness");
	const extraTextLine = `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}] please also inspect README`;
	rootGroup.child.stdin.write(JSON.stringify({ id: "non-exact", type: "prompt", message: extraTextLine }) + "\n");
	await waitRoot(() => existsSync(resultPath(root, rootConfig.instance_id)), "Non-exact input did not reach model as normal input");
	await rootGroup.closed;
	const normalCall = capturedBodies.find(b => messageText(b.messages?.at(-1)?.content) === extraTextLine);
	assert.ok(normalCall, "Non-exact wake-up line with extra text must reach the model untouched");
	assert.equal(readJson<WorkerCompletion>(resultPath(root, rootConfig.instance_id)).result.summary, "Normal input handled");
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi worker treats a pane wake-up as a harmless replay after Coms already claimed the handoff", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	const root = iso.root;
	let providerCalls = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			providerCalls += 1;
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-replay-${providerCalls}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (providerCalls === 1) {
				// Pause slightly or reply with plain text first? Even better: stay in a turn or reply with text,
				// wait for the duplicate pane wake-up, or complete and verify a follow-up wake-up doesn't re-run!
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: "call_coms_first",
						type: "function",
						function: { name: "bootstrap_complete", arguments: JSON.stringify({ status: "success", summary: "Completed from Coms", detail: "Coms won", outputs: { verdict: "approve" } }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Done." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-replay-${providerCalls}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("fake provider failed to bind");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	t.after(async () => { server.closeAllConnections(); server.close(); iso.cleanup(); });

	const reviewPlan = {
		max_total_attempts: 4, max_total_attempts_source: "built-in" as const, node_count: 2,
		loops: [{ reviewer: "a2-review", target: "a1-build", members: ["a1-build", "a2-review"], field: "verdict", approve: "approve", reject: "revise", max_revisions: 1, on_exhausted: "needs_attention" as const }],
	};
	const roster = [
		{ instance_id: "a1-build", node_id: "build", persona_name: "builder", sub_task: "Build" },
		{ instance_id: "a2-review", node_id: "review", persona_name: "reviewer", sub_task: "Review" },
	];
	const srcConfig: WorkerConfig = {
		version: 5, task_id: "replay-run-1", token: "replay-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-wake-replay", instance_id: "a1-build", node_id: "build", persona_name: "builder", attempt_id: "a1-build.1",
		persona: "Builder.", tools: [], sub_task: "Build", topology: "chain",
		successor: "a2-review", outbound_edges: ["a2-review"], handoff_protocol: 1, roster, review_plan: reviewPlan,
		startup_message: "bootstrap-start:replay-token:a1-build", ready_timeout_ms: 10_000,
	};
	const destConfig: WorkerConfig = {
		version: 5, task_id: "replay-run-1", token: "replay-token", session_dir: root, project_cwd: root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-wake-replay", instance_id: "a2-review", node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.1",
		persona: "Reviewer.", tools: [], sub_task: "Review", topology: "chain",
		predecessor: "a1-build", dependency_policy: "require_success", handoff_protocol: 1, roster, review_plan: reviewPlan,
		startup_message: "bootstrap-start:replay-token:a2-review", ready_timeout_ms: 10_000,
	};
	atomicJson(readyPath(root, "a1-build"), {
		version: 1, task_id: "replay-run-1", token: "replay-token", instance_id: "a1-build",
		pid: process.pid, name: "a1-build", session_id: "sess-a1-build", endpoint: join(root, "unused.sock"), model: "bootstrap-fake/model",
	});
	atomicJson(taskInputPath(root, "a2-review.1"), buildTaskInputRecord({
		identity: { run_id: "replay-run-1", node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.1", instance_id: "a2-review" },
		brief: { task: "Replay smoke", goal: "Replay safely" },
		assignment: { sub_task: "Review" },
		roster,
	}));
	const srcResultFile = resultPath(root, "a1-build.1");
	const srcCompletion = completionRecord(srcConfig, { status: "success", agent_name: "builder", node_id: "build", summary: "Built v1", detail: "Done", outputs: { verdict: "approve" } }, "pending", new Date().toISOString());
	atomicJson(srcResultFile, srcCompletion);
	atomicJson(join(root, "upstream-index.json"), {
		version: 2, run_id: "replay-run-1", updated_at: new Date().toISOString(),
		entries: [{
			node_id: "build", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build",
			status: "success", summary: srcCompletion.result.summary, completed_at: srcCompletion.completed_at,
			result_path: srcResultFile, result_hash: resultHash(srcCompletion.result),
		}],
	});
	const offer = offerHandoff(srcConfig, srcCompletion, srcResultFile, undefined, undefined, "a2-review", "a1-build", 1);
	const notification = handoffNotification(srcConfig, offer, srcResultFile, false);
	const destConfigPath = join(root, "a2-review.config.json");
	atomicJson(destConfigPath, destConfig);

	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [
		...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", destConfig.instance_id, "--project", destConfig.coms_project, "--bootstrap-worker-config", destConfigPath,
	], { cwd: root, env: { ...iso.env, HERDR_ENV: "1", HERDR_PANE_ID: "pane-rev-1" } });
	t.after(() => group.stop());
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	const until = async (predicate: () => boolean, message: string) => {
		const deadline = Date.now() + 12_000;
		while (!predicate()) {
			assert.equal(group.child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};

	await until(() => existsSync(readyPath(root, "a2-review")), "Reviewer did not acknowledge readiness");
	const ready = readJson<WorkerReady>(readyPath(root, "a2-review"));
	assert.equal(ready.pane_id, "pane-rev-1");
	atomicJson(join(root, "release.json"), { task_id: destConfig.task_id, token: destConfig.token });
	group.child.stdin.write(JSON.stringify({ id: "activate", type: "prompt", message: destConfig.startup_message }) + "\n");
	await until(() => stdout.includes('"id":"activate"'), "Startup prompt was not consumed");

	// Deliver via Coms first, claiming and running attempt 1 (and parking the reviewer).
	await new Promise<void>((resolve, reject) => {
		const sock = createConnection(ready.endpoint);
		sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("Coms delivery timed out")); });
		sock.on("error", reject);
		sock.on("connect", () => sock.write(JSON.stringify({
			type: "prompt", msg_id: "coms-replay-1", sender_session: "sess-a1-build", sender_endpoint: join(root, "unused.sock"),
			sender_name: "a1-build", sender_cwd: root, hops: 0, timestamp: new Date().toISOString(), prompt: notification,
		}) + "\n"));
		sock.on("data", () => { sock.destroy(); resolve(); });
	});
	await until(() => existsSync(resultPath(root, "a2-review.1")) && stdout.includes('"type":"agent_settled"'), "Coms handoff did not complete");
	const callsAfterComs = providerCalls;
	const savedClaim = readJson<HandoffClaim>(handoffClaimPath(root, "a2-review.1", "a1-build"));

	// Now send a pane wake-up for the already-claimed handoff: must be a harmless replay and never run work a second time.
	group.child.stdin.write(JSON.stringify({ id: "dup-pane-wake", type: "prompt", message: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]` }) + "\n");
	await until(() => stdout.includes('"id":"dup-pane-wake"'), "Duplicate pane wake-up was not handled");
	await delay(200);
	assert.equal(providerCalls, callsAfterComs, "Duplicate pane wake-up after Coms claim must not call provider");
	assert.deepEqual(readJson<HandoffClaim>(handoffClaimPath(root, "a2-review.1", "a1-build")), savedClaim);
	assert.equal(existsSync(join(root, "a2-review.1.from-a1-build.handoff-rejections.json")), false, "Harmless replay must not record a rejection");
	group.child.stdin.end();
	await group.closed;
	assert.equal(group.child.exitCode, 0, stderr);
	assert.deepEqual(iso.homeLeaks(), []);
});
