import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pi supplies TypeBox at runtime; the tool registration check only needs its schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, _context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");
const { default: registerWorker } = await import("./worker.ts");

const bootstrapDir = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(bootstrapDir, "README.md"), "utf8");
const releaseNotes = readFileSync(join(bootstrapDir, "RELEASE-NOTES.md"), "utf8");

function registeredDispatcherSurface() {
	const tools = new Map<string, { name: string; description: string; parameters: unknown }>();
	const commands = new Map<string, { description?: string }>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	return { tools, commands };
}

function registeredWorkerSurface() {
	const tools = new Map<string, { name: string; description: string; parameters: unknown }>();
	registerWorker({
		registerFlag: () => {},
		getFlag: () => undefined,
		registerCommand: () => {},
		on: () => {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	} as any);
	return { tools };
}

function collectDescriptions(node: unknown, out: string[] = []): string[] {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) collectDescriptions(item, out);
		return out;
	}
	const record = node as Record<string, unknown>;
	if (typeof record.description === "string") out.push(record.description);
	for (const value of Object.values(record)) collectDescriptions(value, out);
	return out;
}

function assertNoStaleGraphUnavailability(text: string, sourceLabel: string) {
	// Strip parenthetical "(and parking outside loops)" so the legitimately-unavailable parking-outside-loops clause doesn't trip loop checks.
	const normalized = text.replace(/\(and parking outside loops\)/gi, "");
	const sentences = normalized.split(/(?<=[.!?])\s+|\r?\n+/);
	for (const sentence of sentences) {
		assert.doesNotMatch(
			sentence,
			/(?:\bgraphs?\b|\bgraph (?:scheduler|topolog(?:y|ies))\b|\brevisions?\b|\brevision loops?\b|\breview loops?\b)[^.\n]*\b(?:(?:are|is|remain)\s+(?:unavailable|not available|not supported|pending|refused|disabled)|not (?:yet )?available|not supported|not (?:yet )?enabled)\b/i,
			`${sourceLabel} still claims graphs/revisions/loops are unavailable: ${sentence}`,
		);
		assert.doesNotMatch(
			sentence,
			/\b(?:unavailable|not available|not supported|unsupported|No)\b[^.\n]*(?:\bgraphs?\b|\bgraph (?:scheduler|topolog(?:y|ies))\b|\brevisions?\b|\brevision loops?\b|\breview loops?\b)/i,
			`${sourceLabel} still claims graphs/revisions/loops are unsupported/unavailable: ${sentence}`,
		);
	}
}

test("README documents graph topology, decisions, limits, cleanup and /bootgraph without stale unavailability claims", () => {
	assert.match(readme, /\btopology:\s*"graph"/);
	assert.match(readme, /\bdepends_on\b/);
	assert.match(readme, /\bjoin_policy\b/);
	assert.match(readme, /\ball_success\b[\s\S]*\ballow_partial\b/);
	assert.match(readme, /\bdecision\b[\s\S]*\bon_reject\b[\s\S]*\bmax_revisions\b[\s\S]*\bon_exhausted\b/);
	assert.match(readme, /\bmax_total_attempts\b/);
	assert.match(readme, /\bmaxRevisions\b[\s\S]*\bmaxTotalAttempts\b/);
	assert.match(readme, /\bdependency_wait_timeout_ms\b/);
	assert.match(readme, /\bcleanup\b[\s\S]*\bon_success\b/);
	assert.match(readme, /\/bootgraph\b/);

	assertNoStaleGraphUnavailability(readme, "README.md");
});

test("RELEASE-NOTES cover graphs, review loops, v6 compatibility, known limitations and drop old disabled claims", () => {
	assert.match(releaseNotes, /\bgraph\b/i);
	assert.match(releaseNotes, /\bjoin_policy\b/i);
	assert.match(releaseNotes, /\bdecision\b/i);
	assert.match(releaseNotes, /\bparked\b/i);
	assert.match(releaseNotes, /\bon_success\b/i);
	assert.match(releaseNotes, /\/bootgraph\b/);
	assert.match(releaseNotes, /\bversion 6\b/i);
	assert.match(releaseNotes, /^##\s+Known limitations\b/m);

	const currentReleaseSection = releaseNotes.split(/^#\s+Hardened team\/chain core release\b/m)[0];
	assertNoStaleGraphUnavailability(currentReleaseSection, "RELEASE-NOTES.md");
});

test("real dry-run response for a decision plan does not report review-loop execution as pending", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-docs-dryrun-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const agentDir = join(root, "agent");
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, bin, agentDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "implementer.md"), "---\nname: implementer\ntools: read\n---\nBuild.\n");
	writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ntools: read\n---\nReview.\n");
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["pi", "herdr"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const saved = { PATH: process.env.PATH, HOME: process.env.HOME, state: process.env.PI_BOOTSTRAP_STATE_DIR, agentDir: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = home;
	process.env.PATH = bin;
	process.env.PI_BOOTSTRAP_STATE_DIR = join(root, "state");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		process.env.PATH = saved.PATH;
		if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
		if (saved.state === undefined) delete process.env.PI_BOOTSTRAP_STATE_DIR; else process.env.PI_BOOTSTRAP_STATE_DIR = saved.state;
		if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const tools = new Map<string, any>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any);
	const generate = tools.get("bootstrap_generate");
	assert.ok(generate);

	const res = await generate.execute("call-1", {
		topology: "graph",
		task: "Build and review",
		project_cwd: cwd,
		dry_run: true,
		agents: [
			{ node_id: "build", persona: "implementer", sub_task: "Build" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: {
					required_fields: ["verdict"],
					properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } },
				},
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build" },
			},
		],
	}, undefined, undefined, { cwd, model: { provider: "provider", id: "model" }, hasUI: false });

	assert.equal(res.isError, undefined);
	const text = res.content.map((part: any) => part.text).join("\n");
	assert.match(text, /Dry run OK — nothing was created\./);
	assert.match(text, /Launch with the same parameters and dry_run omitted\./);
	assert.doesNotMatch(text, /review-loop execution is pending/i);
	assertNoStaleGraphUnavailability(text, "bootstrap_generate dry-run response");
});

test("model-facing dispatcher and worker tool descriptions follow GLOSSARY vocabulary and omit avoided terms", () => {
	const dispatcher = registeredDispatcherSurface();
	const worker = registeredWorkerSurface();
	assert.ok(dispatcher.commands.has("bootgraph"));

	const generate = dispatcher.tools.get("bootstrap_generate");
	assert.ok(generate);
	assert.match(generate.description, /\bgraph\b/);
	assert.match(generate.description, /\bdecision\b/);
	assert.match(generate.description, /\bcleanup\b/);
	assert.match(generate.description, /\/bootgraph\b/);
	assert.doesNotMatch(JSON.stringify(generate.parameters), /Available in dry runs/i);

	const complete = worker.tools.get("bootstrap_complete");
	assert.ok(complete);
	assert.doesNotMatch(complete.description, /\bnext chain agent\b/i);
	assert.match(complete.description, /\bfan-out\b/i);
	assert.match(complete.description, /\bjoin\b/i);
	assert.match(complete.description, /\bdecision\b/i);

	const readInput = worker.tools.get("bootstrap_read_input");
	assert.ok(readInput);
	assert.doesNotMatch(readInput.description, /\bearlier stage\b/i);
	assert.match(readInput.description, /\bearlier node\b/i);

	// Narrowed to the synonyms GLOSSARY.md explicitly lists under "Avoid:" for each concept.
	const avoidedPatterns: Array<[string, RegExp]> = [
		["agent file / definition (for Persona)", /\bagent (?:file|definition)s?\b/i],
		["worker / subagent (for Agent)", /\b(?:workers?|subagents?)\b/i],
		["plugin / skill command (for Skill)", /\b(?:plugins?|skill commands?)\b/i],
		["skill filter / whitelist (for Allowed skills)", /\bskill (?:filter|whitelist)s?\b/i],
		["reasoning level / effort (for Thinking level)", /\b(?:reasoning levels?|reasoning effort)\b/i],
		["model shortcut / nickname (for Model alias)", /\bmodel (?:shortcut|nickname)s?\b/i],
		["job (for Run)", /\bjobs?\b/i],
		["step / stage / member (for Node)", /\b(?:(?:chain |earlier |next |workflow )?steps?|(?:earlier |chain )?stages?|(?:team |loop[- ]body )?members?)\b/i],
		["try (for Attempt)", /\b(?:new|another) try\b/i],
		["chain/graph/dependency link / arrow (for Edge)", /\b(?:(?:chain|graph|dependency) links?|arrows?)\b/i],
		["merge node / barrier (for Join)", /\b(?:merge nodes?|barriers?)\b/i],
		["decision/approval gate / router (for Decision node)", /\b(?:(?:decision |approval )gates?|routers?)\b/i],
		["back / retry edge (for Feedback edge)", /\b(?:back|retry) edges?\b/i],
		["review/revision cycle (for Loop body)", /\b(?:review|feedback|revision) cycles?\b/i],
		["sleeping / suspended / leased (for Parked)", /\b(?:sleeping|suspended|leased)\b/i],
	];

	for (const tool of [...dispatcher.tools.values(), ...worker.tools.values()]) {
		const texts = [tool.description, ...collectDescriptions(tool.parameters)];
		for (const rawText of texts) {
			// Ignore literal field names like next_steps when scanning for prose "step".
			const text = rawText.replace(/\bnext_steps\b/g, "");
			for (const [label, pattern] of avoidedPatterns) {
				assert.doesNotMatch(text, pattern, `Tool ${tool.name} description uses glossary-avoided term (${label}): ${rawText}`);
			}
		}
	}
});
