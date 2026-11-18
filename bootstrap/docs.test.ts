import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pi supplies TypeBox at runtime; the tool registration check only needs its schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, _context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

const bootstrapDir = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(bootstrapDir, "README.md"), "utf8");
const releaseNotes = readFileSync(join(bootstrapDir, "RELEASE-NOTES.md"), "utf8");

function registeredSurface() {
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

	assert.doesNotMatch(readme, /Graphs,\s*synthesis.*unavailable/i);
	assert.doesNotMatch(readme, /\brevisions,\s*supervision.*unavailable/i);
	assert.doesNotMatch(readme, /unsupported strategies and graph topologies are refused/i);
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

	assert.doesNotMatch(releaseNotes, /\bNo\b[^.\n]*\bgraph scheduler\b[^.\n]*\benabled\b/i);
	assert.doesNotMatch(releaseNotes, /\bNo\b[^.\n]*\brevision loop\b[^.\n]*\benabled\b/i);
});

test("model-facing tool and parameter descriptions follow GLOSSARY vocabulary and omit avoided terms", () => {
	const { tools, commands } = registeredSurface();
	assert.ok(commands.has("bootgraph"));

	const generate = tools.get("bootstrap_generate");
	assert.ok(generate);
	assert.match(generate.description, /\bgraph\b/);
	assert.match(generate.description, /\bdecision\b/);
	assert.match(generate.description, /\bcleanup\b/);
	assert.match(generate.description, /\/bootgraph\b/);
	assert.doesNotMatch(generate.description, /review-loop execution is pending/i);
	assert.doesNotMatch(JSON.stringify(generate.parameters), /Available in dry runs/i);

	const avoidedPatterns: Array<[string, RegExp]> = [
		["agent file / definition", /\bagent (?:file|definition)s?\b/i],
		["worker", /\bworkers?\b/i],
		["subagent", /\bsubagents?\b/i],
		["plugin", /\bplugins?\b/i],
		["command", /\bcommands?\b/i],
		["skill filter / whitelist", /\bskill (?:filter|whitelist)s?\b/i],
		["reasoning level", /\breasoning levels?\b/i],
		["model shortcut / nickname", /\bmodel (?:shortcut|nickname)s?\b/i],
		["job", /\bjobs?\b/i],
		["step", /\bsteps?\b/i],
		["member", /\bmembers?\b/i],
		["link", /\blinks?\b/i],
		["arrow", /\barrows?\b/i],
		["barrier", /\bbarriers?\b/i],
		["gate", /\bgates?\b|\bgated\b/i],
		["router", /\brouters?\b/i],
		["back / retry edge", /\b(?:back|retry) edges?\b/i],
		["cycle", /\bcycles?\b/i],
		["sleeping / suspended / leased", /\b(?:sleeping|suspended|leased)\b/i],
	];

	for (const tool of tools.values()) {
		const texts = [tool.description, ...collectDescriptions(tool.parameters)];
		for (const text of texts) {
			for (const [label, pattern] of avoidedPatterns) {
				assert.doesNotMatch(text, pattern, `Tool ${tool.name} description uses glossary-avoided term (${label}): ${text}`);
			}
		}
	}
});
