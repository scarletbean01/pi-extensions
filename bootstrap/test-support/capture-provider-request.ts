import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, workerStartupMessages, type WorkerConfig } from "../session-store.ts";
import { fakeProviderExtensionSource, runSupervised, type IsolatedPiEnvironment } from "../test-harness.ts";

const worker = fileURLToPath(new URL("../worker.ts", import.meta.url));
const fakeModel = "bootstrap-fake/model";

export function providerRequestCapture(root: string, reasoning = false) {
	const captureDir = mkdtempSync(join(root, "provider-capture-"));
	const capturePath = join(captureDir, "provider-request.json");
	const providerPath = join(captureDir, "fake-provider.ts");
	const extensionPath = join(captureDir, "capture-provider.ts");
	// An invalid port makes the fallback fail before connecting if Pi stops emitting the hook.
	writeFileSync(providerPath, fakeProviderExtensionSource("http://127.0.0.1:65536", { reasoning }));
	// The hook can replace the payload but has no return value that cancels the request.
	writeFileSync(extensionPath, `import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("before_provider_request", ({ payload }, ctx) => {
		try {
			const model = ctx.model.provider + "/" + ctx.model.id;
			writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ payload, model, thinking: pi.getThinkingLevel() }), { flag: "wx", mode: 0o600 });
		} catch (error) {
			console.error("Cannot capture provider request:", error);
			process.exit(1);
		}
		process.exit(0);
	});
}
`);
	return { providerPath, extensionPath, capturePath };
}

export function readProviderRequest(capturePath: string, diagnostics: string) {
	assert.ok(existsSync(capturePath), `Pi exited without capturing a provider request${diagnostics}`);
	const { payload, model, thinking } = JSON.parse(readFileSync(capturePath, "utf8")) as {
		payload: { model?: string; reasoning_effort?: string; messages?: Array<{ role: string; content: unknown }> };
		model: string;
		thinking: string;
	};
	const systemPrompt = payload.messages?.find(message => ["system", "developer"].includes(message.role))?.content;
	assert.ok(typeof systemPrompt === "string", `Expected a system or developer message in the OpenAI-compatible payload${diagnostics}`);
	const skillsBlock = /^<available_skills>\n([\s\S]*?)\n<\/available_skills>$/m.exec(systemPrompt)?.[1] ?? "";
	const skillNames = Array.from(skillsBlock.matchAll(/^\s*<name>([^<]+)<\/name>$/gm), ([, name]) => name);
	return { payload, model, thinking, systemPrompt, skillNames };
}

/** Run a chain head through the real Coms and bootstrap startup hooks in print mode. */
export async function captureProviderRequest(iso: IsolatedPiEnvironment, config: WorkerConfig, coms: string, extraArgs: string[] = []) {
	const { providerPath, extensionPath, capturePath } = providerRequestCapture(iso.root);
	const configPath = join(dirname(capturePath), "config.json");
	atomicJson(configPath, { ...config, expected_model: fakeModel });
	// The worker records readiness and reads the release itself before it handles the startup message.
	atomicJson(join(config.session_dir, "release.json"), { task_id: config.task_id, token: config.token });
	const result = await runSupervised("pi", [
		"--no-extensions", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session",
		"-e", coms, "-e", worker, "-e", providerPath, "-e", extensionPath,
		"--cname", config.instance_id, "--project", config.coms_project, "--model", fakeModel,
		"--bootstrap-worker-config", configPath, ...extraArgs, "-p",
		...workerStartupMessages(config.startup_message, extraArgs.includes("--allowed-skills")),
	], { cwd: config.project_cwd, env: iso.env, timeoutMs: 20_000 });
	const errorPath = join(config.session_dir, `${config.instance_id}.error.json`);
	const workerError = existsSync(errorPath) ? `\nworker error: ${readFileSync(errorPath, "utf8")}` : "";
	const diagnostics = `\nstdout: ${result.stdout}\nstderr: ${result.stderr}${workerError}`;
	assert.equal(result.timedOut, false, `Pi timed out capturing the provider request${diagnostics}`);
	assert.equal(result.code, 0, `Pi failed to capture the provider request (${result.signal ?? "exit"})${diagnostics}`);
	return readProviderRequest(capturePath, diagnostics);
}
