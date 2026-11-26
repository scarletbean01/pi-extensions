/** Runtime & process-level hygiene tests for Coms registry writes, keepalive timestamps, and reload listener cleanup. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "./session-store.ts";
import { fakeProviderExtensionSource, isolatedPiEnvironment, spawnGroup, type IsolatedPiEnvironment, type SpawnedGroup } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const comsPath = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await delay(15);
	}
}

function startIdleProvider() {
	let requestIndex = 0;
	const server = createHttpServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const n = requestIndex++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-hygiene-${n}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("fake provider failed to bind"));
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
			});
		});
	});
}

function startComsListProvider(targetDirProject: string) {
	let requestIndex = 0;
	const server = createHttpServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const n = requestIndex++;
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-list-${n}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (n === 0) {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: "call_coms_list",
						type: "function",
						function: { name: "coms_list", arguments: JSON.stringify({ project: targetDirProject }) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: "Listed peers." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-list-${n}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("fake provider failed to bind"));
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
			});
		});
	});
}

function spawnPiWithExtensions(
	iso: IsolatedPiEnvironment,
	providerUrl: string,
	extraExtensions: string[],
	extraArgs: string[],
	cwd: string,
	t: test.TestContext,
): { group: SpawnedGroup; stdout: () => string; stderr: () => string } {
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(providerUrl));
	const extArgs = extraExtensions.flatMap(e => ["-e", e]);
	const group = spawnGroup(
		"pi",
		[...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", ...extArgs, ...extraArgs],
		{ cwd, env: iso.env },
	);
	let stdout = "";
	let stderr = "";
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	t.after(() => group.stop());
	return { group, stdout: () => stdout, stderr: () => stderr };
}

test("keepalive preserves started_at from session start while advancing heartbeat_at", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	iso.env.PI_COMS_KEEPALIVE_INTERVAL_MS = "40";
	const provider = await startIdleProvider();
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const project = "hygiene-keepalive";
	const name = "heartbeat-agent";
	const { group, stdout, stderr } = spawnPiWithExtensions(
		iso,
		provider.url,
		[comsPath],
		["--cname", name, "--project", project],
		iso.root,
		t,
	);

	await waitFor(() => stdout().includes("coms ready") || group.child.exitCode !== null, `Coms agent did not start\n${stderr()}\n${stdout()}`);
	assert.equal(group.child.exitCode, null, `Coms agent exited during startup\n${stderr()}\n${stdout()}`);

	const registryPath = join(iso.comsDir, "projects", project, "agents", `${name}.json`);
	await waitFor(() => existsSync(registryPath), "Coms registry entry was not written");

	const initialEntry = JSON.parse(readFileSync(registryPath, "utf8")) as { started_at: string; heartbeat_at?: string };
	assert.equal(typeof initialEntry.started_at, "string");
	const sessionStartedAt = initialEntry.started_at;

	const observedHeartbeats = new Set<string>();
	await waitFor(() => {
		try {
			const entry = JSON.parse(readFileSync(registryPath, "utf8")) as { started_at: string; heartbeat_at?: string };
			if (entry.heartbeat_at) observedHeartbeats.add(entry.heartbeat_at);
		} catch {
			// retry
		}
		return observedHeartbeats.size >= 3;
	}, "Expected at least 3 distinct heartbeat_at updates within keepalive window", 4_000);

	const finalEntry = JSON.parse(readFileSync(registryPath, "utf8")) as { started_at: string; heartbeat_at?: string };
	const heartbeats = [...observedHeartbeats].sort();
	assert.equal(finalEntry.started_at, sessionStartedAt, "keepalive must preserve original session started_at");
	assert.ok(finalEntry.heartbeat_at, "keepalive must record heartbeat_at");
	assert.ok(Date.parse(heartbeats[0]!) >= Date.parse(sessionStartedAt), "heartbeat_at must not precede started_at");
	assert.ok(Date.parse(heartbeats.at(-1)!) > Date.parse(heartbeats[0]!), "heartbeat_at must advance across keepalive intervals");
	assert.equal(stderr(), "");
});

test("two concurrent writers in separate processes for one name never fail or leave a corrupt entry", { timeout: 30_000 }, async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());

	const workerScriptPath = join(iso.root, "concurrent-writer.ts");
	writeFileSync(workerScriptPath, `
import { registerHooks } from "node:module";
import * as readline from "node:readline";

const typeboxUrl = \`data:text/javascript,\${encodeURIComponent("export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});")}\`;
const piAgentUrl = \`data:text/javascript,\${encodeURIComponent("export class DynamicBorder {}")}\`;
const piTuiUrl = \`data:text/javascript,\${encodeURIComponent("export class Text {} export class Container {} export function truncateToWidth(s) { return s; } export function visibleWidth(s) { return s.length; } export function wrapTextWithAnsi(s) { return [s]; }")}\`;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@sinclair/typebox") return { url: typeboxUrl, shortCircuit: true };
		if (specifier === "@mariozechner/pi-coding-agent") return { url: piAgentUrl, shortCircuit: true };
		if (specifier === "@mariozechner/pi-tui") return { url: piTuiUrl, shortCircuit: true };
		return next(specifier, context);
	},
});

const { default: registerComs } = await import(${JSON.stringify(comsPath)});

let activeHooks = new Map<string, Function>();
let activeFlags = new Map<string, unknown>();

function loadComs(project: string, cname: string) {
	const hooks = new Map<string, Function>();
	const flags = new Map<string, unknown>([["project", project], ["cname", cname]]);
	const errors: string[] = [];
	const pi = {
		registerFlag(name: string, opts: { default?: unknown }) {
			if (!flags.has(name)) flags.set(name, opts?.default);
		},
		getFlag(name: string) { return flags.get(name); },
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
		appendEntry() {},
		on(name: string, fn: Function) { hooks.set(name, fn); },
	};
	registerComs(pi as any);
	activeHooks = hooks;
	activeFlags = flags;
	return { hooks, errors };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
	const msg = JSON.parse(line);
	if (msg.cmd === "round") {
		const { hooks, errors } = loadComs(msg.project, msg.cname);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			model: { id: "test-model" },
			getContextUsage: () => ({ percent: 12 }),
			ui: {
				setTheme: () => ({ success: true }),
				setTitle: () => {},
				setStatus: () => {},
				setWidget: () => {},
				notify: (text: string, level?: string) => {
					if (level === "error") errors.push(text);
				},
			},
		};
		await hooks.get("session_start")?.({}, ctx);
		await new Promise(r => setTimeout(r, msg.holdMs ?? 80));
		await hooks.get("session_shutdown")?.({ reason: "quit" }, ctx);
		process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors, flags: activeFlags.get("cname") }) + "\\n");
	} else if (msg.cmd === "quit") {
		break;
	}
}
`);

	const env = { ...iso.env, PI_COMS_KEEPALIVE_INTERVAL_MS: "5" };
	const spawnWriter = () => {
		const child = spawn(process.execPath, [workerScriptPath], { cwd: iso.root, env, stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", d => { stderr += d.toString(); });
		let lineBuf = "";
		const waiters: Array<(line: string) => void> = [];
		child.stdout.on("data", d => {
			lineBuf += d.toString();
			while (true) {
				const nl = lineBuf.indexOf("\n");
				if (nl < 0) break;
				const line = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				waiters.shift()?.(line);
			}
		});
		const nextLine = () => new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`writer timed out; stderr=${stderr}`)), 10_000);
			waiters.push(line => { clearTimeout(timer); resolve(line); });
		});
		return {
			child,
			nextLine,
			stderr: () => stderr,
			send: (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n"),
		};
	};

	const w1 = spawnWriter();
	const w2 = spawnWriter();
	t.after(() => {
		try { w1.child.kill("SIGKILL"); } catch {}
		try { w2.child.kill("SIGKILL"); } catch {}
	});

	for (let round = 0; round < 15; round++) {
		const project = `concurrent-proj-${round}`;
		const cname = "shared-writer";
		const agentsDir = join(iso.comsDir, "projects", project, "agents");
		const targetFile = join(agentsDir, `${cname}.json`);

		const p1 = w1.nextLine();
		const p2 = w2.nextLine();
		w1.send({ cmd: "round", project, cname, holdMs: 80 });
		w2.send({ cmd: "round", project, cname, holdMs: 80 });

		// Simultaneously poll the registry entry from outside while both processes write & keepalive.
		let done = false;
		const poller = (async () => {
			while (!done) {
				try {
					const raw = readFileSync(targetFile, "utf8");
					const parsed = JSON.parse(raw) as { session_id?: string; name?: string };
					assert.equal(typeof parsed.session_id, "string");
					assert.equal(parsed.name, cname);
				} catch (err: any) {
					// ENOENT is expected before first write or after cleanShutdown unlinks the entry.
					if (err?.code !== "ENOENT") throw err;
				}
				await delay(2);
			}
		})();

		const [[r1Raw, r2Raw]] = await Promise.all([
			Promise.all([p1, p2]).finally(() => { done = true; }),
			poller,
		]);

		const r1 = JSON.parse(r1Raw) as { ok: boolean; errors: string[] };
		const r2 = JSON.parse(r2Raw) as { ok: boolean; errors: string[] };
		assert.equal(r1.ok, true, `writer 1 failed in round ${round}: ${r1.errors.join("; ")}`);
		assert.equal(r2.ok, true, `writer 2 failed in round ${round}: ${r2.errors.join("; ")}`);
		assert.deepEqual(existsSync(agentsDir) ? readdirSync(agentsDir).filter(f => f.endsWith(".tmp")) : [], [], "no temp files left after shutdown");
	}

	w1.send({ cmd: "quit" });
	w2.send({ cmd: "quit" });
	assert.equal(w1.stderr(), "");
	assert.equal(w2.stderr(), "");
});

test("crash leftovers are ignored by listing and default project name derives from cwd portably", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const projectDirName = "portable-cwd-project";
	const workDir = join(iso.root, projectDirName);
	const agentsDir = join(iso.comsDir, "projects", projectDirName, "agents");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });

	// Simulate crash leftovers from dead writers in the real registry directory.
	writeFileSync(join(agentsDir, "peer.json.tmp"), "{broken json");
	writeFileSync(join(agentsDir, "peer.json.99999.dead-uuid.tmp"), JSON.stringify({ session_id: "fake-tmp-session", name: "ghost-tmp", pid: process.pid }));

	const provider = await startComsListProvider(projectDirName);
	t.after(async () => { await provider.close(); iso.cleanup(); });

	// Launch Pi WITHOUT --project so it derives the project namespace from cwd.
	const { group, stdout, stderr } = spawnPiWithExtensions(
		iso,
		provider.url,
		[comsPath],
		["--cname", "lister"],
		workDir,
		t,
	);

	await waitFor(() => stdout().includes("coms ready") || group.child.exitCode !== null, `Coms agent did not start\n${stderr()}\n${stdout()}`);
	assert.equal(group.child.exitCode, null, `Coms agent exited during startup\n${stderr()}\n${stdout()}`);

	// Verify it registered under the cwd-derived project directory.
	const selfRegistry = join(agentsDir, "lister.json");
	await waitFor(() => existsSync(selfRegistry), "Expected Coms agent to register under cwd-derived project");

	// Invoke coms_list via prompt and confirm crash leftovers are ignored.
	group.child.stdin.write(JSON.stringify({ id: "list-1", type: "prompt", message: "Run coms_list." }) + "\n");
	await waitFor(() => stdout().includes('"type":"agent_end"'), `Pi RPC prompt did not finish\n${stderr()}\n${stdout()}`);
	assert.match(stdout(), /No peer agents found\./, "crash leftover .tmp files must never be mistaken for registry entries");
	assert.doesNotMatch(stdout(), /ghost-tmp/);
	assert.equal(stderr(), "");
});

test("repeated reload cycles in real Pi do not grow SIGINT or SIGTERM listener counts", { timeout: 30_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const provider = await startIdleProvider();
	t.after(async () => { await provider.close(); iso.cleanup(); });

	const countsLogPath = join(iso.root, "listener-counts.jsonl");
	const probeExtPath = join(iso.root, "reload-probe.ts");
	writeFileSync(probeExtPath, `
import { appendFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("session_start", async (event: any) => {
		appendFileSync(${JSON.stringify(countsLogPath)}, JSON.stringify({
			reason: event?.reason ?? "unknown",
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
		}) + "\\n");
	});
	pi.registerCommand("probe-reload", {
		description: "Reload runtime",
		handler: async (_args: any, ctx: any) => {
			await ctx.reload();
		},
	});
}
`);

	const { group, stdout, stderr } = spawnPiWithExtensions(
		iso,
		provider.url,
		[comsPath, probeExtPath],
		["--cname", "reload-agent", "--project", "hygiene-reload"],
		iso.root,
		t,
	);

	const readCounts = (): Array<{ reason: string; sigint: number; sigterm: number }> => {
		if (!existsSync(countsLogPath)) return [];
		return readFileSync(countsLogPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
	};

	await waitFor(() => stdout().includes("coms ready") && readCounts().length >= 1, `Agent did not start\n${stderr()}\n${stdout()}`);

	// Trigger three /probe-reload cycles (Pi itself adds one one-time SIGTERM listener on first reload,
	// so repeated reloads after reload 1 must show zero growth in both SIGINT and SIGTERM, and reload 1
	// itself must show zero growth in SIGINT).
	for (let i = 1; i <= 3; i++) {
		group.child.stdin.write(JSON.stringify({ id: `reload-${i}`, type: "prompt", message: "/probe-reload" }) + "\n");
		await waitFor(() => readCounts().length >= i + 1, `Reload ${i} did not fire session_start\n${stderr()}\n${stdout()}`);
	}

	const counts = readCounts();
	assert.equal(counts[0]!.reason, "startup");
	assert.equal(counts[1]!.reason, "reload");
	assert.equal(counts[2]!.reason, "reload");
	assert.equal(counts[3]!.reason, "reload");
	assert.equal(counts[1]!.sigint, counts[0]!.sigint, `SIGINT listeners grew on reload 1: ${JSON.stringify(counts)}`);
	assert.equal(counts[2]!.sigint, counts[1]!.sigint, `SIGINT listeners grew on reload 2: ${JSON.stringify(counts)}`);
	assert.equal(counts[2]!.sigterm, counts[1]!.sigterm, `SIGTERM listeners grew on reload 2: ${JSON.stringify(counts)}`);
	assert.equal(counts[3]!.sigint, counts[1]!.sigint, `SIGINT listeners grew on reload 3: ${JSON.stringify(counts)}`);
	assert.equal(counts[3]!.sigterm, counts[1]!.sigterm, `SIGTERM listeners grew on reload 3: ${JSON.stringify(counts)}`);
	assert.equal(stderr(), "");
});
