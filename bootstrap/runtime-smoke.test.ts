/** Optional host integration tests: real Pi + Coms startup, no model request and no Herdr tab creation. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, delay, readJson, readyPath, type WorkerConfig, type WorkerReady } from "./session-store.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const hasPi = spawnSync("pi", ["--no-extensions", "--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];

test("real Pi loads bootstrap tools with the host SDK and TypeBox", { skip: !hasPi }, () => {
	const result = spawnSync("pi", [...isolated, "-e", join(extensionDir, "bootstrap.ts")], {
		input: '{"id":"smoke","type":"get_commands"}\n', encoding: "utf8", timeout: 15_000,
		env: { ...process.env, HERDR_ENV: "0" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /"name":"boot"/);
});

test("real Coms worker acknowledges startup and consumes follower activation without a model request", { skip: !hasPi || !existsSync(coms), timeout: 20_000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-runtime-smoke-"));
	const config: WorkerConfig = {
		task_id: "smoke-123", token: "smoke-token", session_dir: root, project_cwd: root,
		coms_dir: join(root, "coms"), coms_project: "bootstrap-smoke", instance_id: "a2-follower", agent_name: "follower",
		persona: "Smoke-test persona; never call a model.", tools: [], sub_task: "Wait for predecessor", topology: "chain",
		predecessor: "a1-first", startup_message: "bootstrap-start:smoke-token:a2-follower", ready_timeout_ms: 10_000,
	};
	const configPath = join(root, "config.json");
	atomicJson(configPath, config);
	// Any unexpected model work is confined to a fake provider on localhost, never a user's real provider.
	const modelMarker = join(root, "unexpected-model-request");
	const providerPath = join(root, "fake-provider.ts");
	writeFileSync(providerPath, `import { writeFileSync } from "node:fs";\nexport default function(pi) {\npi.registerProvider("bootstrap-smoke", { baseUrl: "http://127.0.0.1:9", apiKey: "test-only", api: "openai-completions", models: [{ id: "model", name: "Smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });\npi.on("before_provider_request", () => { writeFileSync(${JSON.stringify(modelMarker)}, "unexpected"); });\n}`);
	let stdout = "";
	let stderr = "";
	const child = spawn("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-smoke/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", config.instance_id, "--project", config.coms_project, "--bootstrap-worker-config", configPath], {
		cwd: root, env: { ...process.env, HERDR_ENV: "0", PI_COMS_DIR: config.coms_dir }, stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
	t.after(async () => { child.kill("SIGTERM"); await closed; rmSync(root, { recursive: true, force: true }); });
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
	child.stdin.end();
	await closed;
	assert.equal(child.exitCode, 0, stderr);
});
