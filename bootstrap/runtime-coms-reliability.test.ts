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
	name = "sender",
): Promise<{ group: SpawnedGroup; stdout: () => string; stderr: () => string; prompt: (id: string, message?: string) => Promise<void>; endpoint: string }> {
	iso.env.PI_COMS_ACK_TIMEOUT_MS = String(ackTimeoutMs);
	const providerPath = join(iso.root, "fake-provider.ts");
	writeFileSync(providerPath, fakeProviderExtensionSource(providerUrl));
	const group = spawnGroup("pi", [...isolated, "-e", providerPath, "--model", "bootstrap-fake/model", "-e", coms, "--cname", name, "--project", project], { cwd: iso.root, env: iso.env });
	let stdout = "";
	let stderr = "";
	group.child.stdout.on("data", data => { stdout += data.toString(); });
	group.child.stderr.on("data", data => { stderr += data.toString(); });
	t.after(() => group.stop());
	await waitFor(() => stdout.includes("coms ready") || group.child.exitCode !== null, `Coms agent did not start\n${stderr}\n${stdout}`);
	assert.equal(group.child.exitCode, null, `Coms agent exited during startup\n${stderr}\n${stdout}`);
	const registryPath = join(iso.comsDir, "projects", project, "agents", `${name}.json`);
	await waitFor(() => existsSync(registryPath), "Coms agent registry entry was not written");
	const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { endpoint: string };
	return {
		group,
		stdout: () => stdout,
		stderr: () => stderr,
		endpoint: registry.endpoint,
		prompt: async (id, message = "Use coms_send with the scripted arguments.") => {
			const previousEnds = stdout.split('"type":"agent_end"').length - 1;
			group.child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
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
		{ target: "byte-peer", prompt: "client-close-without-ack" },
		{ target: "byte-peer", prompt: "client-malformed-ack" },
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
		socket.on("error", () => {});
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
			if (request.prompt === "client-close-without-ack") {
				socket.end();
			} else if (request.prompt === "client-malformed-ack") {
				socket.end("not-json\n");
			} else if (request.prompt === "client-under-cap") {
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
	assert.match(agent.stdout(), /coms: delivery unknown: frame too large: exceeds 262144-byte Coms frame limit/);
	await agent.prompt("handoff-preview");
	assert.ok(receivedPrompts.includes(notification), "raw peer must receive the complete non-ASCII handoff notification");
	assert.ok(Buffer.byteLength(notification) > 64 * 1024 && Buffer.byteLength(notification) < FRAME_CAP_BYTES);
	const closeOutputOffset = agent.stdout().length;
	await agent.prompt("client-close-without-ack");
	assert.match(agent.stdout().slice(closeOutputOffset), /coms: delivery unknown: connection closed before line received/);
	const malformedOutputOffset = agent.stdout().length;
	await agent.prompt("client-malformed-ack");
	assert.match(agent.stdout().slice(malformedOutputOffset), /coms: delivery unknown: (?:JSON Parse error|Unexpected)/);
	assert.equal(agent.stderr(), "");
});

test("acknowledgement timeout values above the Node timer limit are clamped", { timeout: 20_000 }, async t => {
	const provider = await startToolProvider([{ target: "delayed-peer", prompt: "A delayed but acknowledged message." }]);
	const iso = isolatedPiEnvironment();
	const endpoint = join(iso.comsDir, "sockets", "delayed-peer.sock");
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const receivedPromptIds: string[] = [];
	const peerSockets = new Set<import("node:net").Socket>();
	const peer = createNetServer(socket => {
		peerSockets.add(socket);
		socket.once("close", () => peerSockets.delete(socket));
		socket.on("error", () => {});
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const nl = bytes.indexOf(0x0a);
			if (nl < 0) return;
			let request: any;
			try { request = JSON.parse(bytes.subarray(0, nl).toString("utf8")); } catch { return; }
			if (request.type === "ping") {
				socket.end(JSON.stringify({ type: "pong", msg_id: request.msg_id, agent_card: {} }) + "\n");
			} else if (request.type === "prompt") {
				receivedPromptIds.push(request.msg_id);
				setTimeout(() => socket.end(JSON.stringify({ type: "ack", msg_id: request.msg_id }) + "\n"), 35);
			}
		});
	});
	await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(endpoint, resolve); });
	registerRawPeer(iso, "delayed-peer", endpoint);
	t.after(async () => { for (const socket of peerSockets) socket.destroy(); peer.close(); await provider.close(); iso.cleanup(); });
	const agent = await startComsAgent(iso, provider.url, 2_147_483_648, t);
	await agent.prompt("timeout-clamp");
	assert.ok(receivedPromptIds[0] && agent.stdout().includes(receivedPromptIds[0]), "delayed acknowledgement must arrive before the clamped timer");
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

type ScriptedProviderReply =
	| { text: string }
	| { toolCall: { name: string; arguments: Record<string, unknown> } };

function startScriptedProvider(handler: (requestNumber: number, body: string) => Promise<ScriptedProviderReply> | ScriptedProviderReply) {
	let requestIndex = 0;
	const bodies: string[] = [];
	const server = createHttpServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", chunk => parts.push(chunk));
		req.on("end", async () => {
			const requestNumber = requestIndex++;
			const body = Buffer.concat(parts).toString("utf8");
			bodies.push(body);
			const reply = await handler(requestNumber, body);
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: `chatcmpl-scripted-${requestNumber}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if ("toolCall" in reply) {
				res.write(chunk({
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: `call_scripted_${requestNumber}`,
						type: "function",
						function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) },
					}],
				}, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: reply.text }, null));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: `chatcmpl-scripted-${requestNumber}`, object: "chat.completion.chunk", created: 0, model: "model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise<{ url: string; bodies: () => string[]; close: () => Promise<void> }>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("scripted provider failed to bind"));
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				bodies: () => [...bodies],
				close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
			});
		});
	});
}

function listenAckPeer(
	endpoint: string,
	onEnvelope: (env: any) => void,
): Promise<{ close: () => Promise<void> }> {
	const sockets = new Set<import("node:net").Socket>();
	const server = createNetServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let bytes = Buffer.alloc(0);
		socket.on("data", chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const nl = bytes.indexOf(0x0a);
			if (nl < 0) return;
			let env: any;
			try { env = JSON.parse(bytes.subarray(0, nl).toString("utf8")); } catch { return; }
			if (env.type === "ping") {
				socket.end(JSON.stringify({ type: "pong", msg_id: env.msg_id, agent_card: {} }) + "\n");
				return;
			}
			onEnvelope(env);
			socket.end(JSON.stringify({ type: "ack", msg_id: env.msg_id }) + "\n");
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve({
			close: async () => {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>(done => server.close(() => done()));
			},
		}));
	});
}

test("two Coms prompts arriving mid-turn receive replies to their own senders, oldest first", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const senderAEndpoint = join(iso.comsDir, "sockets", "sender-a.sock");
	const senderBEndpoint = join(iso.comsDir, "sockets", "sender-b.sock");
	const receivedOrder: Array<{ sender: "A" | "B"; envelope: any }> = [];
	const peerA = await listenAckPeer(senderAEndpoint, env => receivedOrder.push({ sender: "A", envelope: env }));
	const peerB = await listenAckPeer(senderBEndpoint, env => receivedOrder.push({ sender: "B", envelope: env }));

	let releaseInitialTurn!: () => void;
	const initialTurnGate = new Promise<void>(resolve => { releaseInitialTurn = resolve; });
	let initialTurnStartedResolve!: () => void;
	const initialTurnStarted = new Promise<void>(resolve => { initialTurnStartedResolve = resolve; });

	const provider = await startScriptedProvider(async (requestNumber, body) => {
		if (requestNumber === 0) {
			initialTurnStartedResolve();
			await initialTurnGate;
			return { text: "Initial turn finished." };
		}
		if (requestNumber === 1) {
			assert.match(body, /Prompt from A/);
			return { text: "Reply for A" };
		}
		if (requestNumber === 2) {
			assert.match(body, /Prompt from B/);
			return { text: "Reply for B" };
		}
		throw new Error(`Unexpected provider request ${requestNumber}`);
	});
	t.after(async () => { await peerA.close(); await peerB.close(); await provider.close(); iso.cleanup(); });

	const receiver = await startComsAgent(iso, provider.url, 2_000, t, "receiver");
	const initialPromptPromise = receiver.prompt("hold-turn", "Start an in-progress turn.");
	await initialTurnStarted;

	const ackA = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "msg-from-a", sender_session: "sender-a-session", sender_endpoint: senderAEndpoint,
		sender_name: "sender-a", sender_cwd: iso.root, hops: 0, timestamp: new Date().toISOString(), prompt: "Prompt from A",
	}) + "\n"));
	assert.equal(ackA.type, "ack");

	const ackB = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "msg-from-b", sender_session: "sender-b-session", sender_endpoint: senderBEndpoint,
		sender_name: "sender-b", sender_cwd: iso.root, hops: 0, timestamp: new Date().toISOString(), prompt: "Prompt from B",
	}) + "\n"));
	assert.equal(ackB.type, "ack");

	releaseInitialTurn();
	await initialPromptPromise;

	await waitFor(() => receivedOrder.length >= 2, `Expected replies for both senders, got ${receivedOrder.length}`);
	assert.equal(receivedOrder.length, 2);
	assert.equal(receivedOrder[0].sender, "A");
	assert.equal(receivedOrder[0].envelope.type, "response");
	assert.equal(receivedOrder[0].envelope.msg_id, "msg-from-a");
	assert.equal(receivedOrder[0].envelope.response, "Reply for A");
	assert.equal(receivedOrder[1].sender, "B");
	assert.equal(receivedOrder[1].envelope.type, "response");
	assert.equal(receivedOrder[1].envelope.msg_id, "msg-from-b");
	assert.equal(receivedOrder[1].envelope.response, "Reply for B");
	assert.equal(receiver.stderr(), "");
});

test("coms_send during a turn inherits the answered prompt's hop count even when a later prompt arrives mid-turn", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const senderAEndpoint = join(iso.comsDir, "sockets", "sender-a-hops.sock");
	const senderBEndpoint = join(iso.comsDir, "sockets", "sender-b-hops.sock");
	const downstreamEndpoint = join(iso.comsDir, "sockets", "downstream.sock");
	const replies: Array<{ sender: "A" | "B"; envelope: any }> = [];
	const downstreamPrompts: any[] = [];
	const peerA = await listenAckPeer(senderAEndpoint, env => replies.push({ sender: "A", envelope: env }));
	const peerB = await listenAckPeer(senderBEndpoint, env => replies.push({ sender: "B", envelope: env }));
	const downstreamPeer = await listenAckPeer(downstreamEndpoint, env => { if (env.type === "prompt") downstreamPrompts.push(env); });
	registerRawPeer(iso, "downstream", downstreamEndpoint);

	let releaseFirstModelCall!: () => void;
	const firstModelCallGate = new Promise<void>(resolve => { releaseFirstModelCall = resolve; });
	let firstModelCallStartedResolve!: () => void;
	const firstModelCallStarted = new Promise<void>(resolve => { firstModelCallStartedResolve = resolve; });

	const provider = await startScriptedProvider(async (requestNumber, body) => {
		if (requestNumber === 0) {
			assert.match(body, /Task A/);
			firstModelCallStartedResolve();
			await firstModelCallGate;
			return { toolCall: { name: "coms_send", arguments: { target: "downstream", prompt: "forwarded-from-A" } } };
		}
		if (requestNumber === 1) {
			return { text: "Completed A" };
		}
		if (requestNumber === 2) {
			assert.match(body, /Task B/);
			return { toolCall: { name: "coms_send", arguments: { target: "downstream", prompt: "forwarded-from-B" } } };
		}
		if (requestNumber === 3) {
			return { text: "Completed B" };
		}
		throw new Error(`Unexpected provider request ${requestNumber}`);
	});
	t.after(async () => { await peerA.close(); await peerB.close(); await downstreamPeer.close(); await provider.close(); iso.cleanup(); });

	const receiver = await startComsAgent(iso, provider.url, 2_000, t, "receiver");

	// Prompt A enters at hops=1; prompt B arrives mid-turn at hops=4 so A forwards at hops=2 while B hits MAX_HOPS (5).
	const ackA = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "hop-msg-a", sender_session: "sender-a-session", sender_endpoint: senderAEndpoint,
		sender_name: "sender-a", sender_cwd: iso.root, hops: 1, timestamp: new Date().toISOString(), prompt: "Task A: forward to downstream",
	}) + "\n"));
	assert.equal(ackA.type, "ack");

	await firstModelCallStarted;

	const ackB = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "hop-msg-b", sender_session: "sender-b-session", sender_endpoint: senderBEndpoint,
		sender_name: "sender-b", sender_cwd: iso.root, hops: 4, timestamp: new Date().toISOString(), prompt: "Task B: try forwarding to downstream",
	}) + "\n"));
	assert.equal(ackB.type, "ack");

	releaseFirstModelCall();

	await waitFor(() => replies.length >= 2, `Expected both A and B replies, got ${replies.length}`);
	assert.equal(downstreamPrompts.length, 1, "Only Task A (hops=1 -> 2) should reach downstream; Task B (hops=4 -> 5) hits MAX_HOPS");
	assert.equal(downstreamPrompts[0].prompt, "forwarded-from-A");
	assert.equal(downstreamPrompts[0].hops, 2);

	assert.equal(replies[0].sender, "A");
	assert.equal(replies[0].envelope.msg_id, "hop-msg-a");
	assert.equal(replies[0].envelope.response, "Completed A");
	assert.equal(replies[1].sender, "B");
	assert.equal(replies[1].envelope.msg_id, "hop-msg-b");
	assert.equal(replies[1].envelope.response, "Completed B");
	assert.match(receiver.stdout(), /coms: hop limit reached \(5 >= 5\)/);
	assert.equal(receiver.stderr(), "");
});

test("human steer during a Coms turn preserves reply routing and hop count for the active prompt", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const senderAEndpoint = join(iso.comsDir, "sockets", "steer-sender-a.sock");
	const downstreamEndpoint = join(iso.comsDir, "sockets", "steer-downstream.sock");
	const replies: any[] = [];
	const downstreamPrompts: any[] = [];
	const peerA = await listenAckPeer(senderAEndpoint, env => replies.push(env));
	const peerD = await listenAckPeer(downstreamEndpoint, env => { if (env.type === "prompt") downstreamPrompts.push(env); });
	registerRawPeer(iso, "downstream", downstreamEndpoint);

	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let startedResolve!: () => void;
	const started = new Promise<void>(resolve => { startedResolve = resolve; });

	const provider = await startScriptedProvider(async (requestNumber) => {
		if (requestNumber === 0) {
			startedResolve();
			await gate;
			return { toolCall: { name: "coms_send", arguments: { target: "downstream", prompt: "first" } } };
		}
		if (requestNumber === 1) {
			return { toolCall: { name: "coms_send", arguments: { target: "downstream", prompt: "after-steer" } } };
		}
		return { text: "Final answer for A" };
	});
	t.after(async () => { await peerA.close(); await peerD.close(); await provider.close(); iso.cleanup(); });

	const receiver = await startComsAgent(iso, provider.url, 2_000, t, "receiver");
	const ackA = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "pa", sender_session: "sender-a-session", sender_endpoint: senderAEndpoint,
		sender_name: "sender-a", sender_cwd: iso.root, hops: 1, timestamp: new Date().toISOString(), prompt: "Task A",
	}) + "\n"));
	assert.equal(ackA.type, "ack");

	await started;
	receiver.group.child.stdin.write(JSON.stringify({ id: "st", type: "steer", message: "operator nudge" }) + "\n");
	await delay(200);
	release();

	await waitFor(() => replies.length >= 1, "expected final reply for steered Coms turn");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].msg_id, "pa");
	assert.equal(replies[0].response, "Final answer for A");
	assert.deepEqual(downstreamPrompts.map(d => [d.prompt, d.hops]), [["first", 2], ["after-steer", 2]]);
	assert.equal(receiver.stderr(), "");
});

test("followUpMode all delivers the shared reply to back-to-back inbound prompts oldest first", { timeout: 25_000 }, async t => {
	const iso = isolatedPiEnvironment();
	writeFileSync(join(iso.agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never",
		retry: { enabled: false },
		followUpMode: "all",
	}), { mode: 0o600 });
	mkdirSync(join(iso.comsDir, "sockets"), { recursive: true });
	const senderAEndpoint = join(iso.comsDir, "sockets", "all-sender-a.sock");
	const senderBEndpoint = join(iso.comsDir, "sockets", "all-sender-b.sock");
	const receivedOrder: Array<{ sender: "A" | "B"; envelope: any }> = [];
	const peerA = await listenAckPeer(senderAEndpoint, env => receivedOrder.push({ sender: "A", envelope: env }));
	const peerB = await listenAckPeer(senderBEndpoint, env => receivedOrder.push({ sender: "B", envelope: env }));

	let releaseInitialTurn!: () => void;
	const initialTurnGate = new Promise<void>(resolve => { releaseInitialTurn = resolve; });
	let initialTurnStartedResolve!: () => void;
	const initialTurnStarted = new Promise<void>(resolve => { initialTurnStartedResolve = resolve; });

	const provider = await startScriptedProvider(async (requestNumber, body) => {
		if (requestNumber === 0) {
			initialTurnStartedResolve();
			await initialTurnGate;
			return { text: "Initial turn finished." };
		}
		if (requestNumber === 1) {
			assert.match(body, /Prompt from A/);
			assert.match(body, /Prompt from B/);
			return { text: "Shared reply for A and B" };
		}
		throw new Error(`Unexpected provider request ${requestNumber}`);
	});
	t.after(async () => { await peerA.close(); await peerB.close(); await provider.close(); iso.cleanup(); });

	const receiver = await startComsAgent(iso, provider.url, 2_000, t, "receiver");
	const initialPromptPromise = receiver.prompt("hold-turn", "Start an in-progress turn.");
	await initialTurnStarted;

	const ackA = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "all-msg-a", sender_session: "sender-a-session", sender_endpoint: senderAEndpoint,
		sender_name: "sender-a", sender_cwd: iso.root, hops: 0, timestamp: new Date().toISOString(), prompt: "Prompt from A",
	}) + "\n"));
	assert.equal(ackA.type, "ack");

	const ackB = JSON.parse(await rawExchange(receiver.endpoint, JSON.stringify({
		type: "prompt", msg_id: "all-msg-b", sender_session: "sender-b-session", sender_endpoint: senderBEndpoint,
		sender_name: "sender-b", sender_cwd: iso.root, hops: 0, timestamp: new Date().toISOString(), prompt: "Prompt from B",
	}) + "\n"));
	assert.equal(ackB.type, "ack");

	releaseInitialTurn();
	await initialPromptPromise;

	await waitFor(() => receivedOrder.length >= 2, `Expected shared replies for both senders, got ${receivedOrder.length}`);
	assert.equal(receivedOrder.length, 2);
	assert.equal(receivedOrder[0].sender, "A");
	assert.equal(receivedOrder[0].envelope.msg_id, "all-msg-a");
	assert.equal(receivedOrder[0].envelope.response, "Shared reply for A and B");
	assert.equal(receivedOrder[1].sender, "B");
	assert.equal(receivedOrder[1].envelope.msg_id, "all-msg-b");
	assert.equal(receivedOrder[1].envelope.response, "Shared reply for A and B");
	assert.equal(receiver.stderr(), "");
});
