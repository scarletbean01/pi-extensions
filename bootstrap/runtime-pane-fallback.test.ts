/**
 * Runtime integration tests for sender pane wake-up fallback (ticket 06 / Seam 2):
 * real Pi + real Coms + fake provider + fake `herdr` binary on `PATH`, plus raw socket peers for delivery-unknown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskInputRecord, taskInputPath } from "./contracts.ts";
import { handoffClaimPath, handoffOfferPath, offerHandoff, parseHandoffOffer, type HandoffClaim } from "./handoff.ts";
import { atomicJson, completionRecord, delay, processStartTime, readJson, readyPath, resultPath, type WorkerCompletion, type WorkerConfig, type WorkerReady } from "./session-store.ts";
import { fakeProviderExtensionSource, gate, isolatedPiEnvironment, probeCommand, spawnGroup } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const piReady = await probeCommand("pi", ["--no-extensions", "--version"]);
const comsReady = existsSync(coms) ? { ok: true } : { ok: false, reason: `Coms extension not found at ${coms}` };
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];

function createFakeHerdr(root: string, options: { paneExists?: boolean; sendFail?: boolean } = {}) {
	const binDir = join(root, "bin");
	const logPath = join(root, "herdr-calls.jsonl");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
	if (${JSON.stringify(options.paneExists === false)}) {
		process.stderr.write(JSON.stringify({ error: "pane not found" }) + "\\n");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: "ws-runtime", agent_status: "working" } } }));
	process.exit(0);
}
if (args[0] === "pane" && (args[1] === "send-text" || args[1] === "send-keys")) {
	if (${JSON.stringify(Boolean(options.sendFail))}) {
		process.stderr.write("fake herdr send failed\\n");
		process.exit(1);
	}
	process.exit(0);
}
process.stderr.write("unexpected herdr command: " + args.join(" ") + "\\n");
process.exit(2);
`;
	const fakeBin = join(binDir, "herdr");
	writeFileSync(fakeBin, script, "utf8");
	chmodSync(fakeBin, 0o755);
	return {
		binDir,
		calls: (): string[][] => existsSync(logPath)
			? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
			: [],
	};
}

async function startCompletingProvider(t: test.TestContext) {
	let calls = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", chunk => chunks.push(chunk));
		req.on("end", () => {
			calls += 1;
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const messages = body.messages ?? [];
			const lastRole = messages.at(-1)?.role;
			const isFollower = JSON.stringify(messages).includes("Instance: a2-second.");
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-${calls}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (lastRole !== "tool") {
				const args = isFollower
					? { status: "success", summary: "Second done", detail: "Claimed" }
					: { status: "success", summary: "First done", detail: "Handing off" };
				res.write(chunk({
					role: "assistant",
					tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "bootstrap_complete", arguments: JSON.stringify(args) } }],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Done." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-${calls}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address() as { port: number };
	t.after(() => { server.closeAllConnections(); server.close(); });
	return { url: `http://127.0.0.1:${addr.port}`, calls: () => calls };
}

function spawnRealWorker(t: test.TestContext, cfg: WorkerConfig, providerPath: string, env: NodeJS.ProcessEnv) {
	const cfgPath = join(cfg.session_dir, `${cfg.instance_id}.config.json`);
	atomicJson(cfgPath, cfg);
	let stdout = "";
	let stderr = "";
	const group = spawnGroup("pi", [
		...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "-e", join(extensionDir, "bootstrap", "worker.ts"),
		"--cname", cfg.instance_id, "--project", cfg.coms_project, "--bootstrap-worker-config", cfgPath,
	], { cwd: cfg.session_dir, env });
	t.after(() => group.stop());
	group.child.stdout.on("data", d => { stdout += d.toString(); });
	group.child.stderr.on("data", d => { stderr += d.toString(); });
	const until = async (predicate: () => boolean, message: string, allowExit = false) => {
		const deadline = Date.now() + 15_000;
		while (!predicate()) {
			if (!allowExit) assert.equal(group.child.exitCode, null, `${message}: child exited\n${stderr}\n${stdout}`);
			assert.ok(Date.now() < deadline, `${message}\n${stderr}\n${stdout}`);
			await delay(25);
		}
	};
	return { group, until, stdout: () => stdout, stderr: () => stderr };
}

function chainConfigs(root: string, comsDir: string, comsProject: string) {
	const roster = [
		{ instance_id: "a1-first", node_id: "first", persona_name: "p1", sub_task: "First task" },
		{ instance_id: "a2-second", node_id: "second", persona_name: "p2", sub_task: "Second task" },
	];
	const first: WorkerConfig = {
		version: 2, task_id: "rt-wake-1", token: "rt-token", session_dir: root, project_cwd: root,
		coms_dir: comsDir, coms_project: comsProject, instance_id: "a1-first", node_id: "first", persona_name: "p1", attempt_id: "a1-first.1",
		persona: "First.", tools: [], sub_task: "First task", topology: "chain", successor: "a2-second", handoff_protocol: 1, roster,
		startup_message: "bootstrap-start:rt-token:a1-first", ready_timeout_ms: 10_000,
	};
	const second: WorkerConfig = {
		version: 2, task_id: "rt-wake-1", token: "rt-token", session_dir: root, project_cwd: root,
		coms_dir: comsDir, coms_project: comsProject, instance_id: "a2-second", node_id: "second", persona_name: "p2", attempt_id: "a2-second.1",
		persona: "Second.", tools: [], sub_task: "Second task", topology: "chain", predecessor: "a1-first", dependency_policy: "require_success", handoff_protocol: 1, roster,
		startup_message: "bootstrap-start:rt-token:a2-second", ready_timeout_ms: 10_000,
	};
	atomicJson(taskInputPath(root, "a2-second"), buildTaskInputRecord({
		identity: { run_id: "rt-wake-1", node_id: "second", persona_name: "p2", attempt_id: "a2-second.1", instance_id: "a2-second" },
		brief: { task: "Runtime fallback", goal: "Verify fallback" }, assignment: { sub_task: "Second task" }, roster,
	}));
	atomicJson(join(root, "upstream-index.json"), { version: 2, run_id: "rt-wake-1", updated_at: new Date().toISOString(), entries: [] });
	return { first, second };
}

test("real Pi workers keep Coms as primary transport and leave fake herdr untouched", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const provider = await startCompletingProvider(t);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.url));
	const fake = createFakeHerdr(iso.root);
	const { first, second } = chainConfigs(iso.root, iso.comsDir, "rt-primary");

	const dest = spawnRealWorker(t, second, providerPath, { ...iso.env, PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-second-1" });
	const src = spawnRealWorker(t, first, providerPath, { ...iso.env, PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-first-1" });
	await dest.until(() => existsSync(readyPath(iso.root, "a2-second")), "Destination did not become ready");
	await src.until(() => existsSync(readyPath(iso.root, "a1-first")), "Source did not become ready");
	atomicJson(join(iso.root, "release.json"), { task_id: first.task_id, token: first.token });

	dest.group.child.stdin.write(JSON.stringify({ id: "d-start", type: "prompt", message: second.startup_message }) + "\n");
	await dest.until(() => dest.stdout().includes('"id":"d-start"'), "Destination startup not consumed");

	src.group.child.stdin.write(JSON.stringify({ id: "s-start", type: "prompt", message: first.startup_message }) + "\n");
	await src.until(() => existsSync(resultPath(iso.root, "a1-first")), "Source did not save result", true);
	await dest.until(() => existsSync(resultPath(iso.root, "a2-second")), "Destination did not complete via Coms", true);
	await src.group.closed;
	await dest.group.closed;

	assert.equal(src.group.child.exitCode, 0, src.stderr());
	assert.equal(dest.group.child.exitCode, 0, dest.stderr());
	assert.deepEqual(fake.calls(), []);
	const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(iso.root, "a2-second")));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "coms");
	assert.equal(readJson<HandoffClaim>(handoffClaimPath(iso.root, "a2-second")).handoff_id, offer.handoff_id);
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi sender falls back to fake herdr once after destination Coms socket is removed, and destination claims the recorded line", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const provider = await startCompletingProvider(t);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.url));
	const fake = createFakeHerdr(iso.root);
	const { first, second } = chainConfigs(iso.root, iso.comsDir, "rt-fallback-unreachable");

	const dest = spawnRealWorker(t, second, providerPath, { ...iso.env, PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-second-2" });
	const src = spawnRealWorker(t, first, providerPath, { ...iso.env, PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-first-2" });
	await dest.until(() => existsSync(readyPath(iso.root, "a2-second")), "Destination did not become ready");
	await src.until(() => existsSync(readyPath(iso.root, "a1-first")), "Source did not become ready");

	const destReady = readJson<WorkerReady>(readyPath(iso.root, "a2-second"));
	assert.equal(destReady.pane_id, "pane-second-2");
	// Remove destination's Coms socket so Coms fails as unreachable.
	rmSync(destReady.endpoint, { force: true });

	atomicJson(join(iso.root, "release.json"), { task_id: first.task_id, token: first.token });
	dest.group.child.stdin.write(JSON.stringify({ id: "d-start", type: "prompt", message: second.startup_message }) + "\n");
	await dest.until(() => dest.stdout().includes('"id":"d-start"'), "Destination startup not consumed");

	src.group.child.stdin.write(JSON.stringify({ id: "s-start", type: "prompt", message: first.startup_message }) + "\n");
	await src.group.closed;
	assert.equal(src.group.child.exitCode, 0, src.stderr());

	const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(iso.root, "a2-second")));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "pane_fallback");
	assert.equal(readJson<WorkerCompletion>(resultPath(iso.root, "a1-first")).delivery, "sent");

	const calls = fake.calls();
	assert.deepEqual(calls, [
		["pane", "get", "pane-second-2"],
		["pane", "send-text", "pane-second-2", `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`],
		["pane", "send-keys", "pane-second-2", "Enter"],
	]);

	// Feed the exact recorded line from fake herdr into the real destination Pi to prove it claims and completes.
	const injectedLine = calls[1]![3]!;
	dest.group.child.stdin.write(JSON.stringify({ id: "pane-wake", type: "prompt", message: injectedLine }) + "\n");
	await dest.until(() => existsSync(resultPath(iso.root, "a2-second")), "Destination did not complete from recorded wake-up", true);
	await dest.group.closed;
	assert.equal(dest.group.child.exitCode, 0, dest.stderr());
	assert.equal(readJson<HandoffClaim>(handoffClaimPath(iso.root, "a2-second")).handoff_id, offer.handoff_id);
	assert.deepEqual(iso.homeLeaks(), []);
});

test("real Pi sender falls back once on coms: delivery unknown: when peer accepts socket without acknowledging", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const provider = await startCompletingProvider(t);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.url));
	const fake = createFakeHerdr(iso.root);
	const { first } = chainConfigs(iso.root, iso.comsDir, "rt-delivery-unknown");

	const silentSock = join(iso.comsDir, "sockets", "a2-second.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const sockets = new Set<import("node:net").Socket>();
	const silentPeer = createNetServer(sock => {
		sockets.add(sock);
		sock.once("close", () => sockets.delete(sock));
		let buf = "";
		sock.on("data", chunk => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					const env = JSON.parse(buf.slice(0, nl)) as { type?: string; msg_id?: string };
					if (env.type === "ping") sock.end(JSON.stringify({ type: "pong", msg_id: env.msg_id, agent_card: {} }) + "\n");
				} catch { /* hold prompt without ack */ }
			}
		});
	});
	await new Promise<void>((resolve, reject) => { silentPeer.once("error", reject); silentPeer.listen(silentSock, () => resolve()); });
	t.after(() => { for (const s of sockets) s.destroy(); silentPeer.close(); });

	mkdirSync(join(iso.comsDir, "projects", first.coms_project, "agents"), { recursive: true });
	atomicJson(join(iso.comsDir, "projects", first.coms_project, "agents", "a2-second.json"), {
		session_id: "sess-silent-2", name: "a2-second", purpose: "p2", model: "model", color: "blue",
		pid: process.pid, endpoint: silentSock, cwd: iso.root, started_at: new Date().toISOString(), explicit: false, version: 1,
	});
	atomicJson(readyPath(iso.root, "a2-second"), {
		version: 1, task_id: first.task_id, token: first.token, instance_id: "a2-second",
		pid: process.pid, start_time: processStartTime(process.pid), name: "a2-second", session_id: "sess-silent-2",
		endpoint: silentSock, model: "bootstrap-fake/model", pane_id: "pane-silent-2",
	});

	const src = spawnRealWorker(t, first, providerPath, {
		...iso.env,
		PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`,
		PI_COMS_ACK_TIMEOUT_MS: "350",
		HERDR_ENV: "1",
		HERDR_PANE_ID: "pane-first-u",
	});
	await src.until(() => existsSync(readyPath(iso.root, "a1-first")), "Source did not become ready");
	atomicJson(join(iso.root, "release.json"), { task_id: first.task_id, token: first.token });
	src.group.child.stdin.write(JSON.stringify({ id: "s-start", type: "prompt", message: first.startup_message }) + "\n");
	await src.group.closed;

	assert.equal(src.group.child.exitCode, 0, src.stderr());
	const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(iso.root, "a2-second")));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "pane_fallback");
	assert.deepEqual(fake.calls(), [
		["pane", "get", "pane-silent-2"],
		["pane", "send-text", "pane-silent-2", `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`],
		["pane", "send-keys", "pane-silent-2", "Enter"],
	]);
});

test("real Pi sender skips fallback for dead process, claimed offer, missing pane, or old readiness without pane_id", { timeout: 45_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;

	for (const mode of ["dead_process", "already_claimed", "pane_missing", "no_pane_id"] as const) {
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const provider = await startCompletingProvider(t);
		const providerPath = join(iso.root, "fake-provider.ts");
		writeFileSync(providerPath, fakeProviderExtensionSource(provider.url));
		const fake = createFakeHerdr(iso.root, { paneExists: mode !== "pane_missing" });
		const { first } = chainConfigs(iso.root, iso.comsDir, `rt-skip-${mode}`);

		let destPid = process.pid;
		if (mode === "dead_process") {
			const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
			await once(child, "close");
			destPid = child.pid!;
		}
		const deadSock = join(iso.comsDir, "sockets", "missing.sock");
		mkdirSync(join(iso.comsDir, "projects", first.coms_project, "agents"), { recursive: true });
		atomicJson(join(iso.comsDir, "projects", first.coms_project, "agents", "a2-second.json"), {
			session_id: "sess-a2-skip", name: "a2-second", purpose: "p2", model: "model", color: "blue",
			pid: destPid, endpoint: deadSock, cwd: iso.root, started_at: new Date().toISOString(), explicit: false, version: 1,
		});
		atomicJson(readyPath(iso.root, "a2-second"), {
			...(mode === "no_pane_id" ? {} : { version: 1, start_time: processStartTime(destPid), pane_id: `pane-${mode}` }),
			task_id: first.task_id, token: first.token, instance_id: "a2-second",
			pid: destPid, name: "a2-second", session_id: "sess-a2-skip", endpoint: deadSock, model: "bootstrap-fake/model",
		});

		const src = spawnRealWorker(t, first, providerPath, { ...iso.env, PATH: `${fake.binDir}:${iso.env.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "pane-first-skip" });
		await src.until(() => existsSync(readyPath(iso.root, "a1-first")), "Source did not become ready");

		if (mode === "already_claimed") {
			const resFile = resultPath(iso.root, "a1-first");
			const comp = completionRecord(first, { status: "success", agent_name: "p1", node_id: "first", summary: "First done", detail: "Handing off" }, "pending", new Date().toISOString());
			const offered = offerHandoff(first, comp, resFile);
			atomicJson(handoffClaimPath(iso.root, "a2-second"), {
				version: 1, handoff_id: offered.handoff_id, state: "accepted", run_id: first.task_id,
				source: { node_id: "first", attempt_id: "a1-first.1", instance_id: "a1-first", session_id: "s1" },
				destination: offered.destination, input_digest: offered.input_digest, offer: "matched", accepted_at: new Date().toISOString(),
			});
			rmSync(handoffOfferPath(iso.root, "a2-second"));
		}

		atomicJson(join(iso.root, "release.json"), { task_id: first.task_id, token: first.token });
		src.group.child.stdin.write(JSON.stringify({ id: "s-start", type: "prompt", message: first.startup_message }) + "\n");
		await src.until(() => existsSync(handoffOfferPath(iso.root, "a2-second")) && readJson<WorkerCompletion>(resultPath(iso.root, "a1-first")).delivery === "failed", `Source did not record failed delivery for ${mode}`);
		await src.until(() => src.stdout().includes('"type":"agent_settled"'), `Source did not settle for ${mode}`);
		await src.group.stop();

		const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(iso.root, "a2-second")));
		assert.equal(offer.state, "offered", `${mode}: offer must not be queued`);
		assert.equal(offer.transport, "skipped", `${mode}: offer must record skipped: ${JSON.stringify(offer)}`);
		assert.ok(offer.transport_reason, `${mode}: offer must record skip reason`);
		assert.equal(fake.calls().some(c => c[1] === "send-text" || c[1] === "send-keys"), false, `${mode}: must never inject into pane`);
		if (mode === "pane_missing") {
			assert.deepEqual(fake.calls(), [["pane", "get", "pane-pane_missing"]]);
		} else {
			assert.deepEqual(fake.calls(), []);
		}
	}
});

test("real Pi sender routes fallback through fake hc on an hc run (without --force), and real Pi destination claims <hc> wrapped wake-up", { timeout: 30_000 }, async t => {
	if (!gate(t, piReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const provider = await startCompletingProvider(t);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(provider.url));

	const binDir = join(iso.root, "hc-bin");
	const logPath = join(iso.root, "hc-calls.jsonl");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(binDir, "hc"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "ls") {
	process.stdout.write(JSON.stringify({ terminals: [{ address: "t2", name: "rt-hc-dest", labels: { bootstrap_run: "rt-wake-1", bootstrap_node: "a2-second" }, state: "live" }], hidden_finished: 0, machines: [] }));
	process.exit(0);
}
if (args[0] === "get") {
	process.stdout.write(JSON.stringify({ address: args[2], name: "rt-hc-dest", labels: { bootstrap_run: "rt-wake-1", bootstrap_node: "a2-second" }, state: "live" }));
	process.exit(0);
}
if (args[0] === "send") {
	process.stdout.write(JSON.stringify({ turn: 1, started: true, status: "idle", wait: null }));
	process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
	writeFileSync(join(binDir, "herdr"), "#!/bin/sh\necho 'herdr must not be called for hc run' >&2\nexit 99\n", { mode: 0o755 });

	const { first, second } = chainConfigs(iso.root, iso.comsDir, "rt-hc-fallback");
	atomicJson(join(iso.root, "manifest.json"), {
		version: 2, request_form: "nodes", task_id: first.task_id, task: "RT hc wake", topology: "chain",
		project_cwd: iso.root, session_dir: iso.root, workspace_id: "hc", coms_project: first.coms_project,
		host_backend: "hc", status: "applied", phase: "released", token: first.token,
		created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
		pane_manifest: [
			{ node_id: "first", persona_name: "p1", attempt_id: "a1-first.1", instance_id: "a1-first", expected_coms_name: "a1-first", expected_model: "bootstrap-fake/model", label: `${first.task_id}:a1-first`, status: "released", host_ref: { name: "rt-hc-src", address: "t1" } },
			{ node_id: "second", persona_name: "p2", attempt_id: "a2-second.1", instance_id: "a2-second", expected_coms_name: "a2-second", expected_model: "bootstrap-fake/model", label: `${first.task_id}:a2-second`, status: "released", host_ref: { name: "rt-hc-dest", address: "t2" } },
		],
	});

	const dest = spawnRealWorker(t, second, providerPath, { ...iso.env, PATH: `${binDir}:${iso.env.PATH ?? ""}`, HC_TERMINAL_ID: "t2" });
	const src = spawnRealWorker(t, first, providerPath, { ...iso.env, PATH: `${binDir}:${iso.env.PATH ?? ""}`, HC_TERMINAL_ID: "t1" });
	await dest.until(() => existsSync(readyPath(iso.root, "a2-second")), "Destination did not become ready");
	await src.until(() => existsSync(readyPath(iso.root, "a1-first")), "Source did not become ready");

	const destReady = readJson<WorkerReady>(readyPath(iso.root, "a2-second"));
	assert.deepEqual(destReady.host_ref, { backend: "hc", address: "t2" });
	assert.equal("pane_id" in destReady, false);
	rmSync(destReady.endpoint, { force: true });

	atomicJson(join(iso.root, "release.json"), { task_id: first.task_id, token: first.token });
	dest.group.child.stdin.write(JSON.stringify({ id: "d-start", type: "prompt", message: second.startup_message }) + "\n");
	await dest.until(() => dest.stdout().includes('"id":"d-start"'), "Destination startup not consumed");

	src.group.child.stdin.write(JSON.stringify({ id: "s-start", type: "prompt", message: first.startup_message }) + "\n");
	await src.group.closed;
	assert.equal(src.group.child.exitCode, 0, src.stderr());

	const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(iso.root, "a2-second")));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "pane_fallback");
	const hcCalls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]);
	const sendCalls = hcCalls.filter(c => c[0] === "send");
	assert.deepEqual(sendCalls, [["send", "--json", "t2", `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`]]);
	assert.equal(hcCalls.some(c => c.includes("--force")), false);

	// Deliver wrapped <hc from="..." reach="...">...</hc> wake line to real destination Pi.
	const wrapped = `<hc from="t1 rt-hc-src" reach="hc send t1 when done or stuck">${sendCalls[0]![3]!}</hc>`;
	dest.group.child.stdin.write(JSON.stringify({ id: "hc-wake", type: "prompt", message: wrapped }) + "\n");
	await dest.until(() => existsSync(resultPath(iso.root, "a2-second")), "Destination did not complete from wrapped hc wake-up", true);
	await dest.group.closed;
	assert.equal(dest.group.child.exitCode, 0, dest.stderr());
	assert.equal(readJson<HandoffClaim>(handoffClaimPath(iso.root, "a2-second")).handoff_id, offer.handoff_id);
	assert.deepEqual(iso.homeLeaks(), []);
});
