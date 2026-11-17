import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, executableOnPath, shellQuote, type GenerateRequest } from "./lifecycle.ts";
import type { WorkerConfig } from "./session-store.ts";
import { classifyFailure, gate, isolatedPiEnvironment, probeCommand, runSupervised, type Capability } from "./test-harness.ts";
import { captureProviderRequest, providerRequestCapture, readProviderRequest } from "./test-support/capture-provider-request.ts";

const comsOverride = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION;
const coms = comsOverride ?? fileURLToPath(new URL("../coms.ts", import.meta.url));
const persona = "Review the proposed patch for correctness.";
const baseline = readFileSync(new URL("./test-support/fixtures/default-provider-prompt.txt", import.meta.url), "utf8")
	.trimEnd().replace(/\n\n<docs>\n[\s\S]+?\n<\/docs>/, "");

async function probeComsSocket(dir: string): Promise<Capability> {
	const server = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(join(dir, "probe.sock"), resolve);
		});
		await new Promise<void>(resolve => server.close(() => resolve()));
		return { ok: true };
	} catch (error) {
		if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		return { ok: false, reason: classifyFailure(error, "Coms socket binding") };
	}
}

async function setupCapture(t: test.TestContext, extraSkills: [string, string][] = []) {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	if (!gate(t, await probeCommand("pi", ["--no-extensions", "--version"], iso.env))) return;
	if (!gate(t, { ok: existsSync(coms), reason: `Coms extension not found at ${coms} (set PI_BOOTSTRAP_TEST_COMS_EXTENSION)` })) return;
	if (!comsOverride && !gate(t, await probeComsSocket(iso.comsDir))) return;

	for (const [name, description] of [["capture-review", "Review a patch."], ["capture-search", "Search a codebase."], ...extraSkills]) {
		const dir = join(iso.agentDir, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nFixture instructions.\n`);
	}

	const config: WorkerConfig = {
		version: 2, task_id: "capture", token: "capture-token", session_dir: iso.sessionDir, project_cwd: iso.root,
		coms_dir: iso.comsDir, coms_project: "bootstrap-capture", instance_id: "a1-review", node_id: "review",
		persona_name: "review", attempt_id: "a1-review.1", persona, tools: ["read"], sub_task: "Review the patch.",
		topology: "chain", startup_message: "bootstrap-start:capture-token:a1-review", ready_timeout_ms: 10_000,
	};
	return { iso, config };
}

const personaPrefix = `${persona}\n\n`;

function assertWorkerPrompt(systemPrompt: string) {
	assert.ok(systemPrompt.startsWith(`${personaPrefix}You are a coding assistant running inside pi`), "The provider prompt should start with the persona and Pi's default instructions");
	assert.doesNotMatch(systemPrompt, /^<docs>$|^- Main documentation:/m);
	assert.match(systemPrompt, /^## Bootstrap execution contract — Authoritative assignment instructions$/m);
	assert.match(systemPrompt, /Call bootstrap_complete exactly once/);
}

test("a bootstrapped agent sends its persona and all discovered skills without Pi's documentation", { timeout: 45_000 }, async t => {
	const fixture = await setupCapture(t);
	if (!fixture) return;
	const { iso, config } = fixture;
	const { systemPrompt, skillNames } = await captureProviderRequest(iso, config, coms);
	assertWorkerPrompt(systemPrompt);
	assert.deepEqual([...skillNames].sort(), ["capture-review", "capture-search"], systemPrompt);
	const [defaultPrompt] = systemPrompt.slice(personaPrefix.length).split("\n\n## Bootstrap execution contract", 1);
	const normalized = defaultPrompt
		.replaceAll(realpathSync(iso.root), "<fixture-root>")
		.replaceAll(iso.root, "<fixture-root>")
		.replace(/(?<=^<available_skills>\n)[\s\S]*?(?=\n<\/available_skills>$)/m,
			block => block.split(/(?<=<\/skill>)\n/).sort().join("\n"));
	assert.equal(normalized, baseline, "Pi's default prompt changed");
	const repeated = await captureProviderRequest(iso, config, coms);
	assert.equal(repeated.systemPrompt, systemPrompt, "Identical launch inputs should produce the same provider prompt");
	assert.deepEqual(iso.homeLeaks(), []);
});

for (const { label, flag, expected } of [
	{ label: "one allowed skill", flag: "capture-review", expected: ["capture-review"] },
	{ label: "several allowed skills", flag: "capture-review,capture-search", expected: ["capture-review", "capture-search"] },
	{ label: "an empty list of allowed skills", flag: "none", expected: [] },
]) {
	test(`a bootstrapped agent applies ${label} to its provider prompt`, { timeout: 45_000 }, async t => {
		const fixture = await setupCapture(t, [["capture-build", "Build a project."], ["none", "Reserved skill name."]]);
		if (!fixture) return;
		const { iso, config } = fixture;
		const { systemPrompt, skillNames } = await captureProviderRequest(iso, config, coms, ["--allowed-skills", flag]);
		assertWorkerPrompt(systemPrompt);
		assert.deepEqual([...skillNames].sort(), expected, systemPrompt);
		assert.doesNotMatch(systemPrompt, /capture-build|Build a project\.|Reserved skill name\./);
		if (!expected.length) assert.doesNotMatch(systemPrompt, /<skills>|<available_skills>/);
		assert.deepEqual(iso.homeLeaks(), []);
	});
}

test("a bootstrapped agent with one selected skill omits Pi's documentation", { timeout: 30_000 }, async t => {
	const fixture = await setupCapture(t);
	if (!fixture) return;
	const { iso, config } = fixture;
	const skill = join(iso.agentDir, "skills", "capture-review", "SKILL.md");
	const { systemPrompt, skillNames } = await captureProviderRequest(iso, config, coms, ["--no-skills", "--skill", skill]);
	assertWorkerPrompt(systemPrompt);
	assert.deepEqual(skillNames, ["capture-review"], systemPrompt);
	assert.deepEqual(iso.homeLeaks(), []);
});

test("a migrated global persona applies its alias, thinking level and allowed skills in a real Pi child", { timeout: 45_000 }, async t => {
	const fixture = await setupCapture(t);
	if (!fixture) return;
	const { iso } = fixture;
	const legacyDir = join(iso.home, ".claude", "agents");
	const personaDir = join(iso.home, ".pi", "agent", "agents");
	mkdirSync(legacyDir, { recursive: true });
	mkdirSync(personaDir, { recursive: true });
	const { providerPath, extensionPath, capturePath } = providerRequestCapture(iso.root, true);
	const legacyPersona = join(legacyDir, "review.md");
	writeFileSync(legacyPersona, `---
model: ReviewModel
tools: read
skills: capture-review
extensions: ${providerPath}, ${extensionPath}
---
${persona}
`);
	copyFileSync(legacyPersona, join(personaDir, "review.md"));
	writeFileSync(join(iso.agentDir, "bootstrap.json"), JSON.stringify({
		modelAliases: { reviewmodel: { model: "bootstrap-fake/model", thinking: "high" } },
	}));
	const homeBeforeLaunch = iso.homeLeaks();

	// Replace the Herdr pane with a supervised process running the generated launcher in print mode.
	const bin = join(iso.root, "bin");
	const pi = executableOnPath("pi", iso.env);
	mkdirSync(bin);
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "pi"), `#!/bin/sh
exec ${shellQuote(pi)} --no-extensions --no-prompt-templates --no-mcp --no-context-files --offline --no-session -p "$@"
`, { mode: 0o700 });
	const env = { ...iso.env, HERDR_ENV: "1", HERDR_PANE_ID: "caller", PATH: [bin, iso.env.PATH].join(delimiter) };
	let child: ReturnType<typeof runSupervised> | undefined;
	const service = new BootstrapService({
		extensionDir: fileURLToPath(new URL("..", import.meta.url)),
		stateDir: iso.stateDir, home: iso.home, env, pollMs: 20,
		exec: async (_command, args) => {
			let result: unknown = {};
			if (args[0] === "pane" && args[1] === "get") result = { pane: { workspace_id: "workspace" } };
			else if (args[0] === "tab" && args[1] === "create") result = { tab: { tab_id: "tab" }, root_pane: { pane_id: "pane", terminal_id: "terminal" } };
			else if (args[0] === "pane" && args[1] === "run") {
				child = runSupervised("/bin/sh", ["-c", args[3]], { cwd: iso.root, env: iso.env, timeoutMs: 20_000 });
				void child.catch(() => {});
			} else assert.fail(`Unexpected Herdr command: ${args.join(" ")}`);
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		},
	});
	const request: GenerateRequest = {
		topology: "chain", task: "Review", project_cwd: iso.root, coms_extension: coms, ready_timeout_ms: 15_000,
		agents: [{ persona: "review", sub_task: "Review the patch." }],
	};
	assert.equal(service.plan(request).agents[0].persona_file, join(personaDir, "review.md"));
	const run = await service.generate(request);
	assert.ok(child, run.error);
	const result = await child;
	const diagnostics = `\n${run.error ?? ""}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
	assert.equal(run.status, "applied", diagnostics);
	assert.equal(result.timedOut, false, diagnostics);
	assert.equal(result.code, 0, diagnostics);

	const capture = readProviderRequest(capturePath, diagnostics);
	assert.equal(capture.model, "bootstrap-fake/model");
	assert.equal(capture.payload.model, "model");
	assert.equal(capture.thinking, "high");
	assert.equal(capture.payload.reasoning_effort, "high");
	assert.deepEqual(capture.skillNames, ["capture-review"], capture.systemPrompt);
	assert.doesNotMatch(capture.systemPrompt, /capture-search|Search a codebase\./);
	assertWorkerPrompt(capture.systemPrompt);
	assert.deepEqual(iso.homeLeaks(), homeBeforeLaunch);
});
