/** Deterministic tests for the host verification harness itself (test-harness.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { isolatedPiEnvironment } from "./test-harness.ts";

const inside = (root: string, path: string) => !relative(root, path).startsWith("..") && !isAbsolute(relative(root, path));

test("isolated Pi environment keeps config, trust, sessions, Coms and bootstrap state in a private temp root", t => {
	const iso = isolatedPiEnvironment({ HOME: "/home/real", ANTHROPIC_API_KEY: "secret", HERDR_PANE_ID: "real-pane", PATH: "/usr/bin" });
	t.after(() => iso.cleanup());
	for (const key of ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_COMS_DIR", "PI_BOOTSTRAP_STATE_DIR"] as const) {
		assert.ok(inside(iso.root, resolve(iso.env[key]!)), `${key}=${iso.env[key]} must be inside ${iso.root}`);
		assert.ok(existsSync(iso.env[key]!), `${key} directory is created`);
	}
	// The real user's ~/.pi can never be the target.
	assert.ok(!inside(resolve(homedir(), ".pi"), iso.env.PI_CODING_AGENT_DIR!));
	assert.equal(iso.env.PI_CODING_AGENT_DIR, resolve(iso.root, "agent"));
	assert.equal(iso.agentDir, iso.env.PI_CODING_AGENT_DIR);
	assert.equal(iso.env.PI_OFFLINE, "1");
	assert.equal(iso.env.HERDR_ENV, "0");
	assert.equal(iso.env.PATH, "/usr/bin", "unrelated variables are kept so the runtime still starts");
});

test("isolated Pi settings are deterministic: no project trust is granted and failed model calls are not retried", t => {
	const iso = isolatedPiEnvironment({});
	t.after(() => iso.cleanup());
	assert.deepEqual(JSON.parse(readFileSync(resolve(iso.agentDir, "settings.json"), "utf8")), { defaultProjectTrust: "never", retry: { enabled: false } });
});

test("isolated Pi environment drops provider credentials and Herdr identity from the parent environment", t => {
	const iso = isolatedPiEnvironment({
		OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b", ANTHROPIC_OAUTH_TOKEN: "c", GEMINI_API_KEY: "d", AWS_ACCESS_KEY_ID: "e", AWS_PROFILE: "f",
		AZURE_OPENAI_BASE_URL: "g", OPENROUTER_API_KEY: "h", HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "s", HC_TERMINAL_ID: "t",
		PI_CODING_AGENT_DIR: "/real/agent", PI_COMS_DIR: "/real/coms", PI_BOOTSTRAP_STATE_DIR: "/real/state", EDITOR: "vi",
	});
	t.after(() => iso.cleanup());
	const leaked = Object.keys(iso.env).filter(key => /API_KEY|TOKEN|^AWS_|^AZURE_|^HERDR_(?!ENV$)|^HC_/.test(key));
	assert.deepEqual(leaked, []);
	assert.equal(iso.env.HERDR_ENV, "0");
	assert.notEqual(iso.env.PI_CODING_AGENT_DIR, "/real/agent");
	assert.notEqual(iso.env.PI_COMS_DIR, "/real/coms");
	assert.notEqual(iso.env.PI_BOOTSTRAP_STATE_DIR, "/real/state");
	assert.equal(iso.env.EDITOR, "vi");
});

test("cleanup removes the isolated root and reports anything the code under test wrote to the fake home", t => {
	const iso = isolatedPiEnvironment({});
	assert.deepEqual(iso.homeLeaks(), []);
	writeFileSync(resolve(iso.env.HOME!, "stray.txt"), "x");
	assert.deepEqual(iso.homeLeaks(), ["stray.txt"]);
	assert.equal(readFileSync(resolve(iso.env.HOME!, "stray.txt"), "utf8"), "x");
	iso.cleanup();
	assert.equal(existsSync(iso.root), false);
	iso.cleanup(); // idempotent
});

// ---- supervised child processes ----
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervised } from "./test-harness.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise(r => setTimeout(r, 20)); return !alive(pid); };

test("a timed-out child and its descendants are killed, and the result says it timed out", async t => {
	const dir = mkdtempSync(join(tmpdir(), "supervised-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pidFile = join(dir, "grandchild.pid");
	const started = Date.now();
	const result = await runSupervised("/bin/sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { timeoutMs: 300, graceMs: 100 });
	assert.equal(result.timedOut, true);
	assert.ok(Date.now() - started < 5000);
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	assert.ok(grandchild > 0);
	assert.equal(await waitDead(grandchild), true, "grandchild must not outlive the timeout");
});

test("a child that exits normally returns its output and leaves no orphaned descendants", async t => {
	const dir = mkdtempSync(join(tmpdir(), "supervised-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pidFile = join(dir, "orphan.pid");
	const result = await runSupervised("/bin/sh", ["-c", `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; echo out; echo err >&2; exit 3`], { timeoutMs: 5000 });
	assert.deepEqual({ code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr }, { code: 3, timedOut: false, stdout: "out\n", stderr: "err\n" });
	assert.equal(await waitDead(Number(readFileSync(pidFile, "utf8"))), true, "background child is reaped when its parent exits");
});

test("stdin input is delivered and closed", async () => {
	const result = await runSupervised("/bin/sh", ["-c", "cat"], { timeoutMs: 5000, input: "hello\n" });
	assert.equal(result.stdout, "hello\n");
});

// ---- capability reporting ----
import { classifyFailure, gate, probeCommand, probeWritableDir } from "./test-harness.ts";

const errno = (code: string, message = code) => Object.assign(new Error(message), { code });

test("sandbox and missing-tool failures are classified with a human reason", () => {
	assert.match(classifyFailure(errno("EPERM", "spawnSync /bin/sh EPERM"), "process spawning"), /process spawning.*denied.*EPERM/i);
	assert.match(classifyFailure(errno("EACCES"), "process spawning"), /denied.*EACCES/i);
	assert.match(classifyFailure(errno("EROFS"), "state directory"), /read-only/i);
	assert.match(classifyFailure(errno("ENOENT", "spawn pi ENOENT"), "pi"), /not found/i);
	assert.match(classifyFailure(new Error("boom"), "pi"), /boom/);
});

test("probes report a reason instead of throwing when the capability is missing", async () => {
	assert.deepEqual(await probeCommand("/bin/sh", ["-c", "exit 0"]), { ok: true });
	const missing = await probeCommand("/nonexistent/definitely-not-here", []);
	assert.equal(missing.ok, false);
	assert.match(missing.reason!, /not found/i);
	const failing = await probeCommand("/bin/sh", ["-c", "echo bad >&2; exit 4"]);
	assert.equal(failing.ok, false);
	assert.match(failing.reason!, /exit 4.*bad/s);
	const readonly = probeWritableDir("/proc/definitely/not/writable");
	assert.equal(readonly.ok, false);
	assert.ok(readonly.reason);
	const iso = isolatedPiEnvironment({});
	assert.deepEqual(probeWritableDir(iso.agentDir), { ok: true });
	iso.cleanup();
});

test("a missing capability skips with an UNVERIFIED reason by default and fails as an infrastructure error in strict mode", () => {
	const skipped: string[] = [];
	const t = { skip: (reason?: string) => { skipped.push(reason ?? ""); } };
	assert.equal(gate(t, { ok: true }, {}), true);
	assert.deepEqual(skipped, []);
	assert.equal(gate(t, { ok: false, reason: "process spawning denied (EPERM)" }, {}), false);
	assert.deepEqual(skipped, ["UNVERIFIED: process spawning denied (EPERM)"]);
	assert.throws(() => gate(t, { ok: false, reason: "pi not found" }, { PI_BOOTSTRAP_TEST_STRICT: "1" }), /infrastructure.*pi not found/i);
	assert.equal(skipped.length, 1, "strict mode does not skip");
});

// ---- fake provider ----
import { startFakeProvider, fakeProviderExtensionSource } from "./test-harness.ts";

const chat = (baseUrl: string, content = "hi") => fetch(`${baseUrl}/chat/completions`, {
	method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only" },
	body: JSON.stringify({ model: "model", stream: true, messages: [{ role: "user", content }] }),
});

test("fake provider with no scripted replies records every model call as unexpected and refuses it", async t => {
	const provider = await startFakeProvider();
	t.after(() => provider.close());
	assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.deepEqual(provider.unexpectedCalls(), []);
	const response = await chat(provider.baseUrl, "secret prompt");
	assert.equal(response.status, 503);
	assert.equal(provider.unexpectedCalls().length, 1);
	assert.equal(provider.unexpectedCalls()[0].path, "/chat/completions");
	assert.match(provider.unexpectedCalls()[0].body, /secret prompt/);
	assert.equal(provider.unexpectedCalls()[0].headers.authorization, undefined, "credentials are never retained");
	assert.throws(() => provider.assertNoUnexpectedCalls(), /unexpected model call.*\/chat\/completions/is);
});

test("fake provider streams scripted replies deterministically, in order, and flags calls beyond the script", async t => {
	const provider = await startFakeProvider({ replies: ["first answer", "second answer"] });
	t.after(() => provider.close());
	for (const expected of ["first answer", "second answer"]) {
		const response = await chat(provider.baseUrl);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type")!, /text\/event-stream/);
		const text = await response.text();
		const chunks = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6))).filter(c => c.choices.length > 0);
		assert.equal(chunks.map(c => c.choices[0].delta.content ?? "").join(""), expected);
		assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
		assert.ok(text.trimEnd().endsWith("data: [DONE]"));
	}
	assert.equal((await chat(provider.baseUrl)).status, 503, "the script is exhausted");
	assert.equal(provider.requests().length, 3);
	assert.equal(provider.unexpectedCalls().length, 1, "only the call beyond the script is unexpected");
});

test("fake provider extension registers an offline model pointing at the local server", async t => {
	const provider = await startFakeProvider();
	t.after(() => provider.close());
	const source = fakeProviderExtensionSource(provider.baseUrl);
	assert.match(source, /registerProvider\("bootstrap-fake"/);
	assert.ok(source.includes(JSON.stringify(provider.baseUrl)));
	assert.ok(!/api\.(openai|anthropic)\.com/.test(source));
});
