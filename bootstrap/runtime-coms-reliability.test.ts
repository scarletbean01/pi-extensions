/** Runtime coverage for Coms transport bounds using real Pi processes and raw socket peers. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delay, type WorkerConfig } from "./session-store.ts";
import { fakeProviderExtensionSource, isolatedPiEnvironment, spawnGroup, type IsolatedPiEnvironment, type SpawnedGroup } from "./test-harness.ts";
import { handoffNotification } from "./handoff.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const coms = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION ?? join(extensionDir, "coms.ts");
const isolated = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session", "--mode", "rpc"];
const project = "coms-reliability";
const FRAME_CAP_BYTES = 256 * 1024;

interface ToolAction {
	target: string;
	prompt: string;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await delay(20);
	}
}

function startToolProvider(actions: ToolAction[]) {
	let requestIndex = 0;
	const server = createHttpServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const requestNumber = requestIndex++;
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-coms-${requestNumber}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (requestNumber % 2 === 0) {
				const action = actions[Math.floor(requestNumber / 2)];
				if (!action) {
					res.write(chunk({ role: "assistant", content: "No scripted Coms action" }, null));
					res.write(chunk({}, "stop"));
				} else {
					res.write(chunk({
						role: "assistant",
						tool_calls: [{
							index: 0,
							id: `call_coms_${requestNumber}`,
							type: "function",
							function: { name: "coms_send", arguments: JSON.stringify(action) },
						}],
					}, null));
					res.write(chunk({}, "tool_calls"));
				}
			} else {
				res.write(chunk({ role: "assistant", content: "Coms action finished." }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-coms-${requestNumber}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
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

async function startComsAgent(
	iso: IsolatedPiEnvironment,
	providerUrl: string,
	ackTimeoutMs: number,
	t: test.TestContext,
): Promise<{ group: SpawnedGroup; stdout: () => string; stderr: () => string; prompt: (id: string) => Promise<void>; endpoint: string }> {
	iso.env.PI_COMS_ACK_TIMEOUT_MS = String(ackTimeoutMs);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(providerUrl));
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "--cname", "sender", "--project", project], { cwd: iso.root, env: iso.env });
	let stdout = "";
	let stderr = "";
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	t.after(() => group.stop());
	await waitFor(() => stdout.includes("coms ready") || group.child.exitCode !== null, `Coms agent did not start\n${stderr}\n${stdout}`);
	assert.equal(group.child.exitCode, null, `Coms agent exited during startup\n${stderr}\n${stdout}`);
	const registryPath = join(iso.comsDir, "projects", project, "agents", "sender.json");
	await waitFor(() => existsSync(registryPath), "Coms agent registry entry was not written");
	const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { endpoint: string };
	return {
		group,
		stdout: () => stdout,
		stderr: () => stderr,
		endpoint: registry.endpoint,
		prompt: async id => {
			const previousEnds = stdout.split('"type":"agent_end"').length - 1;
			group.child.stdin.write(JSON.stringify({ id, type: "prompt", message: "Use coms_send with the scripted arguments." }) + "\n");
			await waitFor(() => stdout.split('"type":"agent_end"').length - 1 > previousEnds, `Pi RPC prompt ${id} did not finish\n${stderr}\n${stdout}`);
		},
	};
}

function registerRawPeer(iso: IsolatedPiEnvironment, name: string, endpoint: string): void {
	const dir = join(iso.comsDir, "projects", project, "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.json`), JSON.stringify({
		session_id: `${name}-session`, name, purpose: "runtime test peer", model: "raw-socket", color: "#72F1B8",
		context_used_pct: 0, queue_depth: 0, pid: process.pid, endpoint, cwd: iso.root, started_at: new Date().toISOString(), explicit: false, version: 1,
	}));
}

function jsonLineAtBytes(value: Record<string, unknown>, totalBytes: number): string {
	const base = JSON.stringify({ ...value, padding: "" }) + "\n";
	const fillerBytes = totalBytes - Buffer.byteLength(base);
	assert.ok(fillerBytes >= 0, "requested line size must fit the JSON envelope");
	const filler = "я".repeat(Math.floor(fillerBytes / 2)) + (fillerBytes % 2 ? "x" : "");
	const line = JSON.stringify({ ...value, padding: filler }) + "\n";
	assert.equal(Buffer.byteLength(line), totalBytes, "fixture must have the specified UTF-8 byte length");
	return line;
}

function rawExchange(endpoint: string, line: string, timeoutMs = 3_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: endpoint });
		let response = Buffer.alloc(0);
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw Coms exchange timed out")); }, timeoutMs);
		socket.once("error", error => { clearTimeout(timer); reject(error); });
		socket.on("connect", () => socket.write(line));
		socket.on("data", chunk => {
			response = Buffer.concat([response, chunk]);
			const nl = response.indexOf(0x0a);
			if (nl < 0) return;
			clearTimeout(timer);
			socket.destroy();
			resolve(response.subarray(0, nl).toString("utf8"));
		});
	});
}

test("real coms_send reports delivery unknown after a short configured acknowledgement timeout", { timeout: 20_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const provider = await startToolProvider([{ target: "silent-peer", prompt: "A message whose delivery is uncertain." }]);
	const rawEndpoint = join(iso.comsDir, "sockets", "silent-peer.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	let accepted = false;
	let receivedPrompt = false;
	let promptSocketClosed = false;
	const rawSockets = new Set<import("node:net").Socket>();
	const rawPeer = createNetServer(socket => {
		accepted = true;
		rawSockets.add(socket);
		let isPrompt = false;
		socket.once("close", () => {
			rawSockets.delete(socket);
			if (isPrompt) promptSocketClosed = true;
		});
		let bytes = "";
		socket.on("data", chunk => {
			bytes += chunk.toString("utf8");
			const nl = bytes.indexOf("\n");
			if (nl >= 0) {
				try {
					isPrompt = JSON.parse(bytes.slice(0, nl)).type === "prompt";
					receivedPrompt ||= isPrompt;
				} catch { /* ping from startup pool refresh */ }
			}
		}); // Deliberately accept the message without acknowledging it.
	});
	await new Promise<void>((resolve, reject) => { rawPeer.once("error", reject); rawPeer.listen(rawEndpoint, resolve); });
	registerRawPeer(iso, "silent-peer", rawEndpoint);
	t.after(async () => { for (const socket of rawSockets) socket.destroy(); rawPeer.close(); await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 350, t);
	const startedAt = Date.now();
	await agent.prompt("delivery-timeout");
	const elapsed = Date.now() - startedAt;
	assert.equal(accepted, true, "raw peer must accept the connection before withholding its acknowledgement");
	assert.equal(receivedPrompt, true, "raw peer must receive the Coms prompt, not only a startup ping");
	assert.ok(elapsed >= 250, `short timeout should cover the configured wait (elapsed ${elapsed}ms)`);
	assert.ok(elapsed < 5_000, `send should finish promptly (elapsed ${elapsed}ms)`);
	assert.match(agent.stdout(), /coms: delivery unknown:/);
	assert.equal(promptSocketClosed, true, "timeout must destroy the socket after delivery becomes unknown");
	assert.equal(agent.stderr(), "");
});

test("real coms_send distinguishes unreachable and refused outcomes", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const provider = await startToolProvider([
		{ target: "missing-peer", prompt: "No registered agent." },
		{ target: "closed-peer", prompt: "A registered but unreachable agent." },
		{ target: "nack-peer", prompt: "A receiver refusal." },
	]);
	const closedEndpoint = join(iso.comsDir, "sockets", "closed-peer.sock");
	const nackEndpoint = join(iso.comsDir, "sockets", "nack-peer.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	registerRawPeer(iso, "closed-peer", closedEndpoint);
	const nackSockets = new Set<import("node:net").Socket>();
	const nackPeer = createNetServer(socket => {
		nackSockets.add(socket);
		socket.once("close", () => nackSockets.delete(socket));
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const nl = bytes.indexOf(0x0a);
			if (nl < 0) return;
			let request: any;
			try { request = JSON.parse(bytes.subarray(0, nl).toString("utf8")); } catch { return; }
			socket.end(JSON.stringify({ type: "nack", msg_id: request.msg_id, error: "blocked by receiver" }) + "\n");
		});
	});
	await new Promise<void>((resolve, reject) => { nackPeer.once("error", reject); nackPeer.listen(nackEndpoint, resolve); });
	registerRawPeer(iso, "nack-peer", nackEndpoint);
	t.after(async () => { for (const socket of nackSockets) socket.destroy(); nackPeer.close(); await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 800, t);
	await agent.prompt("unreachable-missing");
	assert.match(agent.stdout(), /coms: unreachable: no live agent matching/);
	await agent.prompt("unreachable-refused");
	assert.match(agent.stdout(), /coms: unreachable: connect (?:ECONNREFUSED|ENOENT)/);
	await agent.prompt("receiver-refused");
	assert.match(agent.stdout(), /coms: refused: blocked by receiver/);
	assert.equal(agent.stderr(), "");
});

test("Coms client accepts a near-cap multibyte ack, refuses an oversized ack, and delivers a large handoff notification", { timeout: 30_000 }, async t => {
	const preview = "яя".repeat(20 * 1024);
	const notification = handoffNotification({ token: "runtime-token", instance_id: "source", task_id: "run-1" } as WorkerConfig, undefined, preview, false);
	const provider = await startToolProvider([
		{ target: "byte-peer", prompt: "client-under-cap" },
		{ target: "byte-peer", prompt: "client-over-cap" },
		{ target: "byte-peer", prompt: notification },
	]);
	const iso = isolatedPiEnvironment();
	const endpoint = join(iso.comsDir, "sockets", "byte-peer.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const receivedPrompts: string[] = [];
	const receivedPromptIds: string[] = [];
	const peerSockets = new Set<import("node:net").Socket>();
	const peer = createNetServer(socket => {
		peerSockets.add(socket);
		socket.once("close", () => peerSockets.delete(socket));
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const nl = bytes.indexOf(0x0a);
			if (nl < 0) return;
			let request: any;
			try { request = JSON.parse(bytes.subarray(0, nl).toString("utf8")); } catch { return; }
			if (request.type === "ping") {
				socket.end(JSON.stringify({ type: "pong", msg_id: request.msg_id, agent_card: {} }) + "\n");
				return;
			}
			if (request.type !== "prompt") return;
			receivedPrompts.push(request.prompt);
			receivedPromptIds.push(request.msg_id);
			if (request.prompt === "client-under-cap") {
				socket.end(jsonLineAtBytes({ type: "ack", msg_id: request.msg_id }, FRAME_CAP_BYTES - 1));
			} else if (request.prompt === "client-over-cap") {
				socket.end(jsonLineAtBytes({ type: "ack", msg_id: request.msg_id }, FRAME_CAP_BYTES + 1));
			} else {
				socket.end(JSON.stringify({ type: "ack", msg_id: request.msg_id }) + "\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(endpoint, resolve); });
	registerRawPeer(iso, "byte-peer", endpoint);
	t.after(async () => { for (const socket of peerSockets) socket.destroy(); peer.close(); await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 1_000, t);
	await agent.prompt("client-frame-under");
	assert.ok(receivedPrompts.includes("client-under-cap"));
	assert.ok(receivedPromptIds[0] && agent.stdout().includes(receivedPromptIds[0]), "successful coms_send must return the peer-acknowledged msg_id");
	assert.doesNotMatch(agent.stdout(), /coms: frame too large/);
	await agent.prompt("client-frame-over");
	assert.match(agent.stdout(), /coms: frame too large: exceeds 262144-byte Coms frame limit/);
	await agent.prompt("handoff-preview");
	assert.ok(receivedPrompts.includes(notification), "raw peer must receive the complete non-ASCII handoff notification");
	assert.ok(Buffer.byteLength(notification) > 64 * 1024 && Buffer.byteLength(notification) < FRAME_CAP_BYTES);
	assert.equal(agent.stderr(), "");
});

test("Coms server measures incoming UTF-8 frames in bytes and refuses only the oversized frame", { timeout: 20_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const provider = await startToolProvider([]);
	t.after(async () => { await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 800, t);
	const ping = (msgId: string) => ({
		type: "ping", msg_id: msgId, sender_session: "raw-sender", sender_endpoint: join(iso.comsDir, "sockets", "raw-sender.sock"),
		hops: 0, timestamp: new Date().toISOString(),
	});
	const under = JSON.parse(await rawExchange(agent.endpoint, jsonLineAtBytes(ping("under-byte-cap"), FRAME_CAP_BYTES - 1)));
	assert.equal(under.type, "pong");
	const over = JSON.parse(await rawExchange(agent.endpoint, jsonLineAtBytes(ping("over-byte-cap"), FRAME_CAP_BYTES + 1)));
	assert.equal(over.type, "nack");
	assert.match(over.error, /frame too large: exceeds 262144-byte Coms frame limit/);
});

test("end-of-turn Coms replies time out and let the replying agent handle another prompt", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	const provider = await startToolProvider([]);
	const senderEndpoint = join(iso.comsDir, "sockets", "raw-sender.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const receivedResponses: unknown[] = [];
	const openSockets = new Set<import("node:net").Socket>();
	const rawSender = createNetServer(socket => {
		openSockets.add(socket);
		socket.once("close", () => openSockets.delete(socket));
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const nl = bytes.indexOf(0x0a);
			if (nl < 0) return;
			try { receivedResponses.push(JSON.parse(bytes.subarray(0, nl).toString("utf8"))); } catch { /* malformed response is not accepted by this test */ }
			// Keep the socket open without acknowledging; this is the stuck original sender.
		});
	});
	await new Promise<void>((resolve, reject) => { rawSender.once("error", reject); rawSender.listen(senderEndpoint, resolve); });
	t.after(async () => { for (const socket of openSockets) socket.destroy(); rawSender.close(); await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 350, t);
	const sendInbound = async (msgId: string) => rawExchange(agent.endpoint, JSON.stringify({
		type: "prompt", msg_id: msgId, sender_session: "raw-sender-session", sender_endpoint: senderEndpoint,
		sender_name: "raw-sender", sender_cwd: iso.root, hops: 0, timestamp: new Date().toISOString(), prompt: `Reply to ${msgId}`,
	}) + "\n");
	assert.equal(JSON.parse(await sendInbound("inbound-one")).type, "ack");
	await waitFor(() => receivedResponses.length >= 1, "replying Coms agent did not send its end-of-turn response");
	assert.equal((receivedResponses[0] as any).type, "response");
	await waitFor(() => openSockets.size === 0, "reply send did not destroy the unacknowledged socket after its timeout", 5_000);
	assert.equal(JSON.parse(await sendInbound("inbound-two")).type, "ack");
	await waitFor(() => receivedResponses.length >= 2, "replying agent stayed stalled after the original sender withheld its acknowledgement");
	assert.equal((receivedResponses[1] as any).type, "response");
	assert.equal(agent.stderr(), "");
});
