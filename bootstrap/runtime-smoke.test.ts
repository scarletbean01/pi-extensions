/**
 * Runtime integration tests: real Pi + Coms startup, no model request and no Herdr tab creation.
 * All Pi config/trust/session/Coms state is isolated (see test-harness.ts); any model call reaches only a local fake provider and fails the test.
 * Missing prerequisites (Pi binary, Coms extension, sandboxed process spawning) are reported as UNVERIFIED skips, or as failures with PI_BOOTSTRAP_TEST_STRICT=1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, delay, dispositionPath, readJson, readyPath, resultPath, type Disposition, type WorkerCompletion, type WorkerConfig, type WorkerReady } from "./session-store.ts";
import { writeCancelRecord } from "./cancellation.ts";
import { fakeProviderExtensionSource, gate, isolatedPiEnvironment, probeCommand, runSupervised, spawnGroup, startFakeProvider } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const piReady = await probeCommand("pi", ["--no-extensions", "--version"]);
const comsReady = existsSync(coms) ? { ok: true } : { ok: false, reason: `Coms extension not found at ${coms} (set PI_BOOTSTRAP_TEST_COMS_EXTENSION)` };
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];

test("real Pi loads bootstrap tools with the host SDK and TypeBox", async t => {
	if (!gate(t, piReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const result = await runSupervised("pi", [...isolated, "-e", join(extensionDir, "bootstrap.ts")], { input: '{"id":"smoke","type":"get_commands"}\n', timeoutMs: 15_000, env: iso.env, cwd: iso.root });
	assert.equal(result.timedOut, false, "Pi timed out");
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /"name":"boot"/);
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
