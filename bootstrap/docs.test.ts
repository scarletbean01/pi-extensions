import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const repoRoot = dirname(bootstrapDir);
const readme = readFileSync(join(bootstrapDir, "README.md"), "utf8");
const releaseNotes = readFileSync(join(bootstrapDir, "RELEASE-NOTES.md"), "utf8");
const factoryGuide = readFileSync(join(repoRoot, "docs", "factory-guide.md"), "utf8");
const viewerDocPath = join(repoRoot, "docs", "factory-web-viewer.md");
const viewerDoc = readFileSync(viewerDocPath, "utf8");
const glossary = readFileSync(join(repoRoot, "GLOSSARY.md"), "utf8");
const viewerServerSrc = readFileSync(join(repoRoot, "factory", "viewer", "server.ts"), "utf8");
const viewerCliSrc = readFileSync(join(repoRoot, "factory", "viewer", "cli.ts"), "utf8");
const viewerSafeSrc = readFileSync(join(repoRoot, "factory", "viewer", "assets", "safe.js"), "utf8");
const viewerAppSrc = readFileSync(join(repoRoot, "factory", "viewer", "assets", "app.js"), "utf8");

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
	assert.match(readme, /factory-guide\.md/);

	assertNoStaleGraphUnavailability(readme, "README.md");
});

test("docs/factory-guide.md matches actual registered /factory commands, tool limits, and safety disclosures", () => {
	const dispatcher = registeredDispatcherSurface();
	assert.ok(dispatcher.commands.has("factory"));
	const factoryInspect = dispatcher.tools.get("factory_inspect");
	assert.ok(factoryInspect);
	assert.match(JSON.stringify(factoryInspect.parameters), /"list".*"inspect".*"receipt"/);
	const factoryPropose = dispatcher.tools.get("factory_propose_constraint");
	assert.ok(factoryPropose);

	for (const subcommand of [
		"list", "inspect", "receipt", "publish", "update", "restore", "resume", "takeover",
		"stop", "discard", "submit", "launch", "retry", "cancel", "settle", "clear", "redeliver", "requests", "respond", "wake",
		"proposals", "review-proposal", "retire-constraint", "resolve-conflict",
	]) {
		assert.match(factoryGuide, new RegExp(`/factory ${subcommand}\\b`), `missing /factory ${subcommand} in docs/factory-guide.md`);
	}
	assert.match(factoryGuide, /16 KiB UTF-8 \(16,384 bytes\)/);
	assert.match(factoryGuide, /32 queued inputs/);
	assert.match(factoryGuide, /upstream-index\.json/);
	assert.match(factoryGuide, /Standalone runs and manual edits are NOT coordinated/i);
	assert.match(factoryGuide, /Cleanup is NOT proof that external effects stopped/i);
	assert.match(factoryGuide, /Uncertain execution is NEVER replayed/i);
	assert.match(factoryGuide, /report-only/i);
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

function parseViewerSourceContract() {
	const pollMatch = /const LIVE_POLL_INTERVAL_MS = (\d+);/.exec(viewerSafeSrc);
	assert.ok(pollMatch, "Could not parse LIVE_POLL_INTERVAL_MS from factory/viewer/assets/safe.js");
	const pollIntervalMs = Number(pollMatch[1]);

	const timeoutMatch = /const FETCH_TIMEOUT_MS = (\d+);/.exec(viewerAppSrc);
	assert.ok(timeoutMatch, "Could not parse FETCH_TIMEOUT_MS from factory/viewer/assets/app.js");
	const fetchTimeoutMs = Number(timeoutMatch[1]);

	const defaultHostMatch = /const host = options\.host \?\? "([^"]+)";/.exec(viewerServerSrc);
	assert.ok(defaultHostMatch, "Could not parse default host from factory/viewer/server.ts");
	const defaultHost = defaultHostMatch[1];

	const hostRejectMatch = /!isLoopbackHostHeader\(req\.headers\.host\)\)\s*\{\s*json\(res,\s*(\d+),/.exec(viewerServerSrc);
	assert.ok(hostRejectMatch, "Could not parse Host header rejection status from factory/viewer/server.ts");
	const hostRejectStatus = Number(hostRejectMatch[1]);

	const staticMapMatch = /const STATIC_ASSETS = new Map[^(]*\(\[([\s\S]*?)\]\);/.exec(viewerServerSrc);
	assert.ok(staticMapMatch, "Could not parse STATIC_ASSETS from factory/viewer/server.ts");
	const staticAssets = [...staticMapMatch[1].matchAll(/\["([^"]+)",\s*\{/g)].map(m => m[1]);
	assert.ok(staticAssets.length >= 6, "Expected STATIC_ASSETS keys");

	const routeRegexMatch = /\/\^\\\/api\\\/factories\\\/\(\[\^\/\]\+\)\\\/\(([^)]+)\)\$\//.exec(viewerServerSrc);
	assert.ok(routeRegexMatch, "Could not parse API route regex from factory/viewer/server.ts");
	const apiViews = routeRegexMatch[1].split("|");
	assert.ok(apiViews.length >= 6, "Expected API views from route regex");

	const defaultPortMatch = /if \(raw === undefined\) return (\d+);/.exec(viewerCliSrc);
	assert.ok(defaultPortMatch, "Could not parse default port from factory/viewer/cli.ts");
	const defaultPort = Number(defaultPortMatch[1]);

	return { pollIntervalMs, fetchTimeoutMs, defaultHost, hostRejectStatus, staticAssets, apiViews, defaultPort };
}

export function assertViewerDocMatchesSource(docText: string, docPath = viewerDocPath, rootDir = repoRoot) {
	const spec = parseViewerSourceContract();
	const pollSeconds = spec.pollIntervalMs / 1000;
	const timeoutSeconds = spec.fetchTimeoutMs / 1000;

	// 1. Every relative link in docs/factory-web-viewer.md must resolve to a real file.
	const docDir = dirname(docPath);
	const links = [...docText.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m => m[1]);
	assert.ok(links.length >= 3, "Expected relative links in docs/factory-web-viewer.md");
	for (const rawTarget of links) {
		if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
		const relPath = rawTarget.split("#")[0]!.split("?")[0]!;
		const resolved = resolve(docDir, relPath);
		assert.equal(existsSync(resolved), true, `Broken relative link in ${docPath}: ${rawTarget} -> ${resolved}`);
	}
	assert.match(docText, /\[[^\]]+\]\(adr\/0001-agents-drive-graph-execution\.md\)/);
	assert.match(docText, /\[[^\]]+\]\(\.\.\/GLOSSARY\.md\)/);
	assert.match(docText, /\[[^\]]+\]\(factory-guide\.md\)/);

	// 2. Every documented `node <script>` command path must resolve to a real file in the repo.
	const nodeScriptPaths = [...docText.matchAll(/\bnode\s+([^\s`"']+\.(?:ts|js|mjs))\b/g)].map(m => m[1]);
	assert.ok(nodeScriptPaths.includes("factory/viewer/cli.ts"), "Expected node factory/viewer/cli.ts command");
	assert.ok(nodeScriptPaths.includes("bootstrap/test-support/factory-viewer-manual-fixture.ts"), "Expected manual fixture command");
	for (const scriptPath of nodeScriptPaths) {
		assert.equal(existsSync(join(rootDir, scriptPath)), true, `Documented node command target does not exist: ${scriptPath}`);
	}

	// 3. Static assets and HTTP API routes must match server.ts exactly with zero undocumented/fake routes or methods.
	for (const assetPath of spec.staticAssets) {
		assert.ok(docText.includes(assetPath), `Missing STATIC_ASSETS key in docs/factory-web-viewer.md: ${assetPath}`);
	}
	assert.ok(docText.includes("GET /api/factories"), "Missing GET /api/factories in docs/factory-web-viewer.md");
	for (const view of spec.apiViews) {
		assert.ok(docText.includes(`GET /api/factories/:id/${view}`), `Missing GET /api/factories/:id/${view} in docs/factory-web-viewer.md`);
	}
	const allowedStaticSet = new Set(spec.staticAssets);
	const allowedApiViews = new Set(spec.apiViews);
	for (const match of docText.matchAll(/`(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/(?:api\/[^\s`?]+|vendor\/[^\s`?]+|index\.html|style\.css|safe\.js|app\.js))(?:\?[^`]*)?`/g)) {
		const [, method, path] = match;
		if (method) assert.equal(method, "GET", `Viewer doc documented non-GET route: ${match[0]}`);
		if (path!.startsWith("/api/")) {
			if (path === "/api/factories" || path === "/api/...") continue;
			const apiMatch = /^\/api\/factories\/(?::id|\*|<[^>]+>)\/([a-z0-9_-]+)$/.exec(path!);
			assert.ok(apiMatch && allowedApiViews.has(apiMatch[1]!), `Documented API route outside server.ts allowlist: ${match[0]}`);
		} else {
			assert.ok(allowedStaticSet.has(path!), `Documented static path outside STATIC_ASSETS: ${match[0]}`);
		}
	}
	for (const methodMatch of docText.matchAll(/\b(POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[^\s`]+/g)) {
		assert.fail(`Documented non-GET HTTP route in viewer doc: ${methodMatch[0]}`);
	}

	// 4. Timing, host, port, and status numbers must match source files.
	assert.ok(docText.includes(`LIVE_POLL_INTERVAL_MS = ${spec.pollIntervalMs}`), `Missing LIVE_POLL_INTERVAL_MS = ${spec.pollIntervalMs}`);
	assert.ok(docText.includes(`FETCH_TIMEOUT_MS = ${spec.fetchTimeoutMs}`), `Missing FETCH_TIMEOUT_MS = ${spec.fetchTimeoutMs}`);
	const pollSectionMatch = /### Polling and in-place Live Graph updates([\s\S]*?)### Distinguishing/.exec(docText);
	assert.ok(pollSectionMatch, "Missing polling subsection");
	assert.ok(pollSectionMatch[1]!.includes(`${pollSeconds} seconds`), `Polling subsection must state ${pollSeconds} seconds`);
	for (const secMatch of pollSectionMatch[1]!.matchAll(/\b(\d+)\s*(?:-\s*)?seconds?\b/gi)) {
		assert.equal(Number(secMatch[1]), pollSeconds, `Unexpected poll interval ${secMatch[0]} (expected ${pollSeconds} seconds)`);
	}
	const timeoutSectionMatch = /### Loading states and ([^\n]+)([\s\S]*?)### Polling/.exec(docText);
	assert.ok(timeoutSectionMatch, "Missing loading/timeout subsection");
	assert.ok(timeoutSectionMatch[0].includes(`${timeoutSeconds}-second`), `Timeout subsection must state ${timeoutSeconds}-second`);
	for (const secMatch of timeoutSectionMatch[0].matchAll(/\b(\d+)\s*(?:-\s*)?seconds?\b/gi)) {
		assert.equal(Number(secMatch[1]), timeoutSeconds, `Unexpected timeout ${secMatch[0]} (expected ${timeoutSeconds} seconds)`);
	}

	const hostRowMatch = /\|\s*`FACTORY_VIEWER_HOST`\s*\|\s*`([^`]+)`\s*\|([^\n]*)\|/.exec(docText);
	assert.ok(hostRowMatch, "Missing FACTORY_VIEWER_HOST row in Section 1");
	assert.equal(hostRowMatch[1], spec.defaultHost, `Default host must match server.ts (${spec.defaultHost})`);
	assert.doesNotMatch(docText, /\b0\.0\.0\.0\b/, "Viewer doc must never mention 0.0.0.0");
	const portRowMatch = /\|\s*`FACTORY_VIEWER_PORT`\s*\|\s*`(\d+)`/.exec(docText);
	assert.ok(portRowMatch, "Missing FACTORY_VIEWER_PORT row in Section 1");
	assert.equal(Number(portRowMatch[1]), spec.defaultPort);

	for (const sentence of docText.split(/(?<=[.!?])\s+|\r?\n+/)) {
		if (/\bHost\b/.test(sentence) && /\bHTTP\s+\d{3}\b|\breturn(?:s|ed)?\s+\d{3}\b|\brefused with\s+(?:HTTP\s+)?\d{3}\b/i.test(sentence)) {
			assert.ok(sentence.includes(String(spec.hostRejectStatus)), `Host header sentence must report ${spec.hostRejectStatus}: ${sentence}`);
			assert.doesNotMatch(sentence, /\b400\b/, `Host header sentence must not claim 400: ${sentence}`);
		}
	}
	assert.match(docText, /\blocalhost\b[^\n]*403/);
	assert.ok(docText.includes("PI_FACTORY_COORDINATION_DIR"));
	assert.ok(docText.includes("PI_BOOTSTRAP_STATE_DIR"));
	assert.ok(docText.includes("PI_FACTORY_STATE_DIR"));
	assert.ok(docText.includes("FACTORY_STATE_PATH"));

	// 5. All 5 manual checklist scenarios must be present, and Scenarios 2 & 4 must stay marked NOT YET RUN.
	for (const n of [1, 2, 3, 4, 5]) {
		assert.match(docText, new RegExp(`^#### Scenario ${n}\\b`, "m"), `Missing Scenario ${n} heading`);
	}
	const scenarioBlocks = new Map<number, string>();
	const blockMatches = [...docText.matchAll(/^#### Scenario (\d+)[^\n]*\n([\s\S]*?)(?=^#### |\Z)/gm)];
	for (const m of blockMatches) scenarioBlocks.set(Number(m[1]), `${m[0]}`);
	for (const unrun of [2, 4]) {
		const block = scenarioBlocks.get(unrun);
		assert.ok(block, `Missing Scenario ${unrun} section body`);
		assert.match(block, /NOT YET RUN/, `Scenario ${unrun} must be marked NOT YET RUN`);
		assert.doesNotMatch(block, /\bexercised\b/i, `Scenario ${unrun} must not be marked exercised`);
		assert.doesNotMatch(block, /\[x\]\s*Pass/i, `Scenario ${unrun} must not be checked Pass`);
	}
	const execStatusMatch = /\*\*Execution status:\*\*([\s\S]*?)\*\*Launch an isolated temporary fixture/.exec(docText);
	assert.ok(execStatusMatch, "Missing Execution status summary");
	assert.match(execStatusMatch[1]!, /Scenarios 2 and 4[^\n]*NOT YET RUN/);
}

test("docs/factory-web-viewer.md, links, and GLOSSARY Run graph entry match the shipped viewer", () => {
	assert.match(factoryGuide, /\[[^\]]+\]\(factory-web-viewer\.md\)/);
	assert.match(readme, /\[[^\]]+\]\(\.\.\/docs\/factory-web-viewer\.md\)/);
	assert.match(glossary, /\*\*Run graph\*\*:\s+A view of one run’s nodes and edges[\s\S]*bound to that run’s input/);

	assertViewerDocMatchesSource(viewerDoc);

	for (const snippet of [
		"127.0.0.1",
		"::1",
		"Ctrl-C",
		"Factories",
		"Live Graph",
		"Inspect",
		"Queue",
		"Receipts",
		"Requests",
		"Proposals",
		"no records",
		"not applicable",
		"evidence unavailable",
		"Stale",
		"Uncertain",
		"reconciliation",
		"Request timed out",
		"/factory queue --open",
		"/factory requests",
		"factory/operations.ts",
		"sanitizeOperatorText",
		"TOCTOU",
		"No external requests",
		"Keyboard-only use",
		"bootstrap/factory-web-viewer*.test.ts",
	]) {
		assert.ok(viewerDoc.includes(snippet), `docs/factory-web-viewer.md missing expected content: ${snippet}`);
	}
	assert.doesNotMatch(viewerDoc, /\blive_run\b/);
	for (const liveState of ["running", "ended", "idle", "waiting", "blocked", "uncertain"]) {
		assert.match(viewerDoc, new RegExp(`\`${liveState}\``), `docs/factory-web-viewer.md missing live state ${liveState}`);
	}
});
