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

async function setupCapture(t: test.TestContext) {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	if (!gate(t, await probeCommand("pi", ["--no-extensions", "--version"], iso.env))) return;
	if (!gate(t, { ok: existsSync(coms), reason: `Coms extension not found at ${coms} (set PI_BOOTSTRAP_TEST_COMS_EXTENSION)` })) return;
	if (!comsOverride && !gate(t, await probeComsSocket(iso.comsDir))) return;

	for (const [name, description] of [["capture-review", "Review a patch."], ["capture-search", "Search a codebase."]]) {
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
	assert.ok(systemPrompt.startsWith(personaPrefix), "The provider prompt should start with the persona");
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
