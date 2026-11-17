import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerConfig } from "./session-store.ts";
import { classifyFailure, gate, isolatedPiEnvironment, probeCommand, type Capability } from "./test-harness.ts";
import { captureProviderRequest } from "./test-support/capture-provider-request.ts";

const comsOverride = process.env.PI_BOOTSTRAP_TEST_COMS_EXTENSION;
const coms = comsOverride ?? fileURLToPath(new URL("../coms.ts", import.meta.url));
const persona = "Review the proposed patch for correctness.";
const baseline = readFileSync(new URL("./test-support/fixtures/default-provider-prompt.txt", import.meta.url), "utf8").trimEnd();

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

async function captureFixture(t: test.TestContext, extraSkills: string[][] = []) {
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

test("a bootstrapped agent sends its persona and Pi's default prompt with every discovered skill", { timeout: 45_000 }, async t => {
	const fixture = await captureFixture(t);
	if (!fixture) return;
	const { iso, config } = fixture;
	const { systemPrompt, skillNames } = await captureProviderRequest(iso, config, coms);
	const personaPrefix = `${persona}\n\n`;
	assert.ok(systemPrompt.startsWith(personaPrefix), "The provider prompt should start with the persona");
	assert.deepEqual([...skillNames].sort(), ["capture-review", "capture-search"], systemPrompt);
	const [defaultPrompt] = systemPrompt.slice(personaPrefix.length).split("\n\n## Bootstrap execution contract", 1);
	const packageDir = /^- Main documentation: (.+)\/README\.md$/m.exec(defaultPrompt)?.[1];
	assert.ok(packageDir, "Pi's default prompt should contain the harness documentation block");
	const normalized = defaultPrompt
		.replaceAll(`${packageDir}/`, "<pi-package>/")
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
	{ label: "several allowed skills", flag: "capture-review,capture-search,CAPTURE-BUILD,none", expected: ["capture-review", "capture-search"] },
	{ label: "an empty list of allowed skills", flag: "none", expected: [] },
]) {
	test(`a bootstrapped agent applies ${label} to its provider prompt`, { timeout: 45_000 }, async t => {
		const fixture = await captureFixture(t, [["capture-build", "Build a project."], ["none", "Reserved skill name."]]);
		if (!fixture) return;
		const { iso, config } = fixture;
		const { systemPrompt, skillNames } = await captureProviderRequest(iso, config, coms, ["--allowed-skills", flag]);
		assert.ok(systemPrompt.startsWith(`${persona}\n\nYou are a coding assistant running inside pi`), "The provider prompt should start with the persona and Pi's default instructions");
		assert.deepEqual([...skillNames].sort(), expected, systemPrompt);
		assert.doesNotMatch(systemPrompt, /capture-build|Build a project\.|Reserved skill name\./);
		if (!expected.length) assert.doesNotMatch(systemPrompt, /<skills>|<available_skills>/);
		assert.deepEqual(iso.homeLeaks(), []);
	});
}
