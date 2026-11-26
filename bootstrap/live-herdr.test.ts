/**
 * Explicit live-Herdr suite. Never runs from the default suites: `node bootstrap/run-tests.ts live` with PI_BOOTSTRAP_LIVE_HERDR=1,
 * inside a Herdr pane. Pi config/trust/session/Coms/Herdr state is isolated; only the read-only calling-pane check inspects the caller.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { createFactoryQueueScheduler } from "../factory/scheduler.ts";
import { handoffClaimPath, handoffOfferPath, parseHandoffClaim, parseHandoffOffer } from "./handoff.ts";
import { BootstrapService } from "./lifecycle.ts";
import { delay, parseWorkerReady, processAlive, readJson, readyPath, resultPath } from "./session-store.ts";
import { fakeProviderExtensionSource, gate, isolatedPiEnvironment, probeCommand, runSupervised, type Capability } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const optedIn = process.env.PI_BOOTSTRAP_LIVE_HERDR === "1";
const insideHerdr = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
const live: Capability = !optedIn ? { ok: false, reason: "live Herdr tests require PI_BOOTSTRAP_LIVE_HERDR=1" }
	: !insideHerdr ? { ok: false, reason: "live Herdr tests must run inside a Herdr pane (HERDR_ENV=1, HERDR_PANE_ID)" } : { ok: true };
const piReady = await probeCommand("pi", ["--no-extensions", "--version"]);
const herdrReady = await probeCommand("herdr", ["--version"]);
const comsReady: Capability = existsSync(coms) ? { ok: true } : { ok: false, reason: `Coms extension not found at ${coms}` };

async function startIsolatedHerdr(t: test.TestContext, iso: ReturnType<typeof isolatedPiEnvironment>, sessionName: string) {
	const binDir = join(iso.root, "bin");
	const runtimeDir = join(iso.root, "runtime");
	mkdirSync(binDir, { recursive: true, mode: 0o700 });
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const realHerdr = (await runSupervised("which", ["herdr"], { timeoutMs: 5000 })).stdout.trim() || "herdr";
	// Wrapper injects --session so Bootstrap's `herdr` calls (and worker pane fallbacks inside panes) target only the isolated server.
	const wrapper = join(binDir, "herdr");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(realHerdr)} --session ${JSON.stringify(sessionName)} "$@"\n`, { mode: 0o700 });
	const herdrEnv: NodeJS.ProcessEnv = {
		...iso.env,
		PATH: `${binDir}:${iso.env.PATH ?? ""}`,
		XDG_RUNTIME_DIR: runtimeDir,
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
	};
	const sock = join(iso.home, ".config", "herdr", "sessions", sessionName, "herdr-client.sock");
	const server = spawn(realHerdr, ["--session", sessionName, "server"], { env: herdrEnv, stdio: "ignore" });
	const closed = once(server, "close");
	t.after(async () => { server.kill("SIGKILL"); await closed; });
	const deadline = Date.now() + 10_000;
	while (!existsSync(sock)) {
		assert.equal(server.exitCode, null, "isolated Herdr server exited before creating socket");
		assert.ok(Date.now() < deadline, "isolated Herdr server did not start");
		await delay(25);
	}
	const cli = async (...args: string[]) => {
		const res = await runSupervised(wrapper, args, { timeoutMs: 10_000, env: herdrEnv });
		assert.equal(res.code, 0, `herdr ${args.join(" ")} failed: ${res.stderr}`);
		const out = res.stdout.trim();
		if (!out) return undefined;
		try { return JSON.parse(out).result; } catch { return out; }
	};
	const ws = await cli("workspace", "create", "--cwd", iso.root);
	const paneId = ws.root_pane.pane_id as string;
	const env = { ...herdrEnv, HERDR_ENV: "1", HERDR_PANE_ID: paneId };
	return { env, paneId, server, closed, cli };
}

test("live: the Herdr CLI answers a read-only snapshot from the calling pane", { timeout: 30_000 }, async t => {
	if (!gate(t, live)) return;
	const result = await runSupervised("herdr", ["api", "snapshot"], { timeoutMs: 20_000, env: process.env });
	assert.equal(result.timedOut, false);
	assert.equal(result.code, 0, result.stderr);
	assert.ok(result.stdout.trim().length > 0, "snapshot output");
});

test("live retained E2E: isolated Pi/Herdr factory revises, approves, settles, and starts the next input without production credentials", { timeout: 120_000 }, async t => {
	if (!gate(t, live) || !gate(t, piReady) || !gate(t, herdrReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const herdr = await startIsolatedHerdr(t, iso, `factory-live-e2e-${process.pid}`);

	// Deterministic local fake OpenAI provider that scripts build1 -> review1(reject) -> build2 -> review2(approve) -> input2.
	let callSeq = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", c => chunks.push(c));
		req.on("end", () => {
			callSeq++;
			const bodyStr = Buffer.concat(chunks).toString("utf8");
			const body = JSON.parse(bodyStr);
			const userText = JSON.stringify(body.messages ?? []);
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-${callSeq}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			const messages = body.messages ?? [];
			const lastRole = messages.at(-1)?.role;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const isReviewer = userText.includes("Instance: a2-review.");
			const isRevision = userText.includes("changes_requested") || userText.includes("please revise") || messages.some((m: any) => m.role === "user" && typeof m.content === "string" && /revision|attempt 2/i.test(m.content));
			let toolArgs: Record<string, unknown>;
			if (!isReviewer) {
				toolArgs = { status: "success", summary: isRevision ? "Build v2" : "Build v1", detail: "built" };
			} else {
				const approve = userText.includes("Build v2");
				toolArgs = {
					status: "success",
					summary: approve ? "Approved v2" : "Changes requested v1",
					detail: approve ? "looks good" : "please revise",
					outputs: { verdict: approve ? "approve" : "changes_requested" },
				};
			}
			if (lastRole !== "tool") {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{ index: 0, id: `call_${callSeq}`, type: "function", function: { name: "bootstrap_complete", arguments: JSON.stringify(toolArgs) } }],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Done." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-${callSeq}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address() as { port: number };
	t.after(() => { server.closeAllConnections(); server.close(); });

	const projectDir = join(iso.root, "project");
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	mkdirSync(join(projectDir, "extensions"), { recursive: true });
	const providerPath = join(projectDir, "extensions", "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	writeFileSync(join(iso.agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
	writeFileSync(join(projectDir, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read\nextensions: fake-provider.ts\nmodel: bootstrap-fake/model\nthinking: off\n---\nBuild the brief.\n");
	writeFileSync(join(projectDir, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read\nextensions: fake-provider.ts\nmodel: bootstrap-fake/model\nthinking: off\n---\nReview the build.\n");

	const service = new BootstrapService({
		exec: async (cmd, args) => {
			const res = await runSupervised(cmd, args, { timeoutMs: 30_000, env: herdr.env, cwd: projectDir });
			return { code: res.code ?? 1, stdout: res.stdout, stderr: res.stderr };
		},
		extensionDir,
		stateDir: iso.stateDir,
		home: iso.home,
		env: herdr.env,
	});
	const dbPath = join(iso.stateDir, "factories.sqlite");
	const open = () => factoryOperations(dbPath, service, { coordinationPath: join(iso.coordDir, "factory-coordination.sqlite") });
	const fac = open()({
		action: "publish",
		name: "live-e2e",
		draft: {
			topology: "graph",
			task: "Live isolated factory E2E",
			project_cwd: projectDir,
			coms_extension: coms,
			cleanup: "manual",
			ready_timeout_ms: 20_000,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build the brief" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review the build",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "off" },
	});
	const auth = createManagerAuthority({ pi_session_id: "live-mgr-1" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const sub1 = open()({ action: "submit", factory_id: fac.factory_id, reference: "live-1", brief: "First live brief\nline 2", authority: auth });
	const sub2 = open()({ action: "submit", factory_id: fac.factory_id, reference: "live-2", brief: "Second live brief", authority: auth });

	const launchedIds: string[] = [];
	const scheduler = createFactoryQueueScheduler({
		factory: open(),
		factoryId: fac.factory_id,
		authority: auth,
		onLaunch: result => { launchedIds.push(result.input_id); },
	});

	await scheduler.advance();
	assert.deepEqual(launchedIds, [sub1.input_id]);

	const deadline = Date.now() + 60_000;
	while (launchedIds.length < 2 && Date.now() < deadline) {
		await scheduler.advance();
		if (launchedIds.length < 2) await delay(300);
	}
	assert.deepEqual(launchedIds, [sub1.input_id, sub2.input_id], () => `scheduler did not advance to input 2 (calls=${callSeq}): ${JSON.stringify(open()({ action: "inspect", factory_id: fac.factory_id }), null, 2)}`);
	const view = open()({ action: "inspect", factory_id: fac.factory_id });
	const settled1 = view.attempts.find(a => a.input_id === sub1.input_id)!;
	assert.equal(settled1.state, "settled");
	assert.deepEqual(settled1.node_counts, [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	]);
	const rep1 = service.readOnlyReport(settled1.task_id, projectDir);
	assert.equal(rep1.complete, true);
	assert.deepEqual(rep1.node_counts, [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	]);
});

test("live retained E2E: takeover after isolated Herdr loss exposes an uncertain hold without replay", { timeout: 60_000 }, async t => {
	if (!gate(t, live) || !gate(t, piReady) || !gate(t, herdrReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const herdr = await startIsolatedHerdr(t, iso, `factory-live-takeover-${process.pid}`);
	let providerReached = false;
	const provider = createServer((_req, res) => {
		providerReached = true;
		// Keep the isolated worker in flight; an empty completed response lets it settle before the crash.
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.flushHeaders();
	});
	await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", () => resolve()); });
	const pAddr = provider.address() as { port: number };
	t.after(() => { provider.closeAllConnections(); provider.close(); });

	const projectDir = join(iso.root, "project");
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	mkdirSync(join(projectDir, "extensions"), { recursive: true });
	writeFileSync(join(projectDir, "extensions", "fake-provider.ts"), fakeProviderExtensionSource(`http://127.0.0.1:${pAddr.port}`));
	writeFileSync(join(iso.agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
	writeFileSync(join(projectDir, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read\nextensions: fake-provider.ts\nmodel: bootstrap-fake/model\nthinking: off\n---\nBuild.\n");

	const service = new BootstrapService({
		exec: async (cmd, args) => {
			const res = await runSupervised(cmd, args, { timeoutMs: 30_000, env: herdr.env, cwd: projectDir });
			return { code: res.code ?? 1, stdout: res.stdout, stderr: res.stderr };
		},
		extensionDir,
		stateDir: iso.stateDir,
		home: iso.home,
		env: herdr.env,
	});
	const dbPath = join(iso.stateDir, "factories.sqlite");
	const open = () => factoryOperations(dbPath, service, { coordinationPath: join(iso.coordDir, "factory-coordination.sqlite") });
	const fac = open()({
		action: "publish",
		name: "live-takeover",
		draft: {
			topology: "graph",
			task: "Live isolated takeover",
			project_cwd: projectDir,
			coms_extension: coms,
			ready_timeout_ms: 20_000,
			agents: [{ node_id: "build", persona: "builder", sub_task: "Wait", intervention: { choices: [{ choice_id: "go", label: "Go" }] } }],
		},
		sessionModel: { provider: "bootstrap-fake", id: "model", thinkingLevel: "off" },
	});
	const mgr1 = createManagerAuthority({ pi_session_id: "live-mgr-old" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: mgr1 });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "t-ref-1", brief: "Takeover brief", authority: mgr1 });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: mgr1 });

	const deadline = Date.now() + 10_000;
	while (!providerReached && Date.now() < deadline) await delay(25);
	assert.ok(providerReached, "isolated worker must reach the provider before the crash");
	const worker = parseWorkerReady(readJson(readyPath(launched.manifest.session_dir, launched.manifest.pane_manifest[0].instance_id)));
	assert.equal(worker.task_id, launched.task_id);
	assert.ok(processAlive(worker));
	// Killing Herdr alone need not kill its child immediately. Kill the verified isolated worker
	// as well so the test observes lost execution, not just a routine hold on a live agent.
	revokeManagerAuthority(mgr1);
	process.kill(worker.pid, "SIGKILL");
	herdr.server.kill("SIGKILL");
	await herdr.closed;
	const exitDeadline = Date.now() + 5_000;
	while (processAlive(worker) && Date.now() < exitDeadline) await delay(25);
	assert.equal(processAlive(worker), false, "isolated worker did not exit");

	const mgr2 = createManagerAuthority({ pi_session_id: "live-mgr-new" });
	open()({ action: "takeover", factory_id: fac.factory_id, authority: mgr2, confirmed_manager_incarnation_id: mgr1.incarnation_id });
	const view = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(view.attempts.length, 1, "takeover must never replay a launched run");
	assert.equal(view.attempts[0].task_id, launched.task_id);
	assert.equal(view.capacity.factory_slot, "held");
	assert.equal(view.attempts[0].settlement?.execution_settlement.state, "unknown");
	assert.ok(view.attention.some(item => item.kind === "uncertain" && item.task_id === launched.task_id), JSON.stringify(view.attention));
});

test("live: sender falls back to real Herdr pane wake-up when destination Coms socket is removed and destination claims handoff", { timeout: 90_000 }, async t => {
	if (!gate(t, live) || !gate(t, piReady) || !gate(t, herdrReady) || !gate(t, comsReady)) return;
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const herdr = await startIsolatedHerdr(t, iso, `bootstrap-live-pane-wake-${process.pid}`);

	const projectDir = join(iso.root, "project");
	mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
	mkdirSync(join(projectDir, "extensions"), { recursive: true });

	const sessionReady = Promise.withResolvers<string>();
	sessionReady.promise.catch(() => {});
	const handlerErrors: string[] = [];
	let socketRemoved = false;
	let callSeq = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", c => chunks.push(c));
		req.on("end", async () => {
			try {
				callSeq++;
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const userText = JSON.stringify(body.messages ?? []);
				const messages = body.messages ?? [];
				const lastRole = messages.at(-1)?.role;
				const isFollower = userText.includes("Instance: a2-follow.");

				if (!isFollower && !socketRemoved) {
					const dir = await sessionReady.promise;
					const followerReady = parseWorkerReady(readJson<unknown>(readyPath(dir, "a2-follow")));
					if (!followerReady.pane_id) {
						handlerErrors.push("follower readiness record must include pane_id inside Herdr");
					} else {
						rmSync(followerReady.endpoint, { force: true });
						socketRemoved = true;
					}
				}

				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: `chatcmpl-wake-${callSeq}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				if (lastRole !== "tool") {
					const toolArgs = isFollower
						? { status: "success", summary: "Follower woke via pane", detail: "Claimed from real Herdr pane wake-up" }
						: { status: "success", summary: "Builder finished", detail: "Handing off via pane fallback" };
					res.write(chunk({
						role: "assistant",
						tool_calls: [{ index: 0, id: `call_${callSeq}`, type: "function", function: { name: "bootstrap_complete", arguments: JSON.stringify(toolArgs) } }],
					}, null));
					res.write(chunk({}, "tool_calls"));
				} else {
					res.write(chunk({ role: "assistant", content: "Done." }, null));
					res.write(chunk({}, "stop"));
				}
				res.write(`data: ${JSON.stringify({ id: `chatcmpl-wake-${callSeq}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
				res.end("data: [DONE]\n\n");
			} catch (err) {
				handlerErrors.push(err instanceof Error ? err.message : String(err));
				if (!res.headersSent) res.writeHead(500);
				res.end();
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
	const addr = server.address() as { port: number };
	t.after(() => { server.closeAllConnections(); server.close(); });

	const providerPath = join(projectDir, "extensions", "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(`http://127.0.0.1:${addr.port}`));
	writeFileSync(join(iso.agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
	writeFileSync(join(projectDir, ".pi", "agents", "builder.md"), "---\nname: builder\ntools: read\nextensions: fake-provider.ts\nmodel: bootstrap-fake/model\nthinking: off\n---\nBuild.\n");
	writeFileSync(join(projectDir, ".pi", "agents", "follower.md"), "---\nname: follower\ntools: read\nextensions: fake-provider.ts\nmodel: bootstrap-fake/model\nthinking: off\n---\nFinish after builder.\n");

	const service = new BootstrapService({
		exec: async (cmd, args) => {
			const res = await runSupervised(cmd, args, { timeoutMs: 30_000, env: herdr.env, cwd: projectDir });
			return { code: res.code ?? 1, stdout: res.stdout, stderr: res.stderr };
		},
		extensionDir,
		stateDir: iso.stateDir,
		home: iso.home,
		env: herdr.env,
	});
	let run: Awaited<ReturnType<BootstrapService["generate"]>>;
	try {
		run = await service.generate({
			topology: "chain",
			task: "Live pane wake fallback",
			project_cwd: projectDir,
			coms_extension: coms,
			ready_timeout_ms: 20_000,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build first" },
				{ node_id: "follow", persona: "follower", sub_task: "Run second" },
			],
		}, { provider: "bootstrap-fake", id: "model", thinkingLevel: "off" });
	} catch (err) {
		sessionReady.reject(err);
		throw err;
	}
	const sessionDir = run.session_dir;
	sessionReady.resolve(sessionDir);
	t.after(async () => { try { await service.cleanup(run.task_id, projectDir); } catch { /* best effort */ } });

	const deadline = Date.now() + 45_000;
	while (!existsSync(resultPath(sessionDir, "a2-follow")) && Date.now() < deadline) {
		await delay(100);
	}
	assert.deepEqual(handlerErrors, [], "provider handler must not fail");
	assert.ok(socketRemoved, "follower Coms socket must have been removed before builder completed");
	assert.ok(existsSync(handoffClaimPath(sessionDir, "a2-follow")), "follower must claim handoff after real pane wake-up");
	assert.ok(existsSync(resultPath(sessionDir, "a2-follow")), "follower must complete after claiming handoff");
	const offer = parseHandoffOffer(readJson<unknown>(handoffOfferPath(sessionDir, "a2-follow")));
	const claim = parseHandoffClaim(readJson<unknown>(handoffClaimPath(sessionDir, "a2-follow")));
	assert.equal(offer.state, "queued");
	assert.equal(offer.transport, "pane_fallback");
	assert.equal(claim.handoff_id, offer.handoff_id);
	assert.equal(service.status(run.task_id, projectDir).outcome.state, "succeeded");
});
