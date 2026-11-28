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
const factoryLaunchDoc = readFileSync(join(repoRoot, "docs", "factory-launch.md"), "utf8");
const glossary = readFileSync(join(repoRoot, "GLOSSARY.md"), "utf8");

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
	assert.doesNotMatch(readme, /does not observe the cancellation signal/i);
	assert.doesNotMatch(readme, /keeps waiting \(up to 15 minutes\), and cancels as soon as it gets the lock/i);
	assert.match(readme, /observes the cancellation signal/i);

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
		"list", "inspect", "receipt", "viewer", "publish", "update", "restore", "resume", "takeover",
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
	assert.doesNotMatch(generate.description, /cancellation takes effect only once that wait ends/i);
	assert.match(generate.description, /cancellation stops the wait/i);
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

function parseViewerSourceContract(rootDir = repoRoot) {
	const viewerServerSrc = readFileSync(join(rootDir, "factory", "viewer", "server.ts"), "utf8");
	const viewerCliSrc = readFileSync(join(rootDir, "factory", "viewer", "cli.ts"), "utf8");
	const viewerSafeSrc = readFileSync(join(rootDir, "factory", "viewer", "assets", "safe.js"), "utf8");
	const viewerAppSrc = readFileSync(join(rootDir, "factory", "viewer", "assets", "app.js"), "utf8");
	const operationsSrc = readFileSync(join(rootDir, "factory", "operations.ts"), "utf8");
	const lifecycleSrc = readFileSync(join(rootDir, "bootstrap", "lifecycle.ts"), "utf8");
	const viewerCommandSrc = readFileSync(join(rootDir, "factory", "viewer-command.ts"), "utf8");

	const parseViewerCommandConst = (name: string): number => {
		const m = new RegExp(`const ${name}\\s*=\\s*([0-9_]+);`).exec(viewerCommandSrc);
		assert.ok(m, `Could not parse ${name} from factory/viewer-command.ts`);
		return Number(m[1]!.replace(/_/g, ""));
	};
	const startupTimeoutMs = parseViewerCommandConst("DEFAULT_STARTUP_TIMEOUT_MS");
	const stopSigtermWaitMs = parseViewerCommandConst("STOP_SIGTERM_WAIT_MS");
	const stopSigkillWaitMs = parseViewerCommandConst("STOP_SIGKILL_WAIT_MS");
	const healthTimeoutMs = parseViewerCommandConst("HEALTH_TIMEOUT_MS");
	const maxStderrBytes = parseViewerCommandConst("MAX_STDERR_BYTES");
	const allowedEnvMatch = /const ALLOWED_VIEWER_ENV_VARS\s*=\s*\[([\s\S]*?)\]\s*as const;/.exec(viewerCommandSrc);
	assert.ok(allowedEnvMatch, "Could not parse ALLOWED_VIEWER_ENV_VARS from factory/viewer-command.ts");
	const allowedViewerEnvVars = [...allowedEnvMatch[1]!.matchAll(/"([A-Z0-9_]+)"/g)].map(m => m[1]!);
	assert.ok(allowedViewerEnvVars.length >= 10, "Expected allowlisted viewer env vars");

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

	const cliExitCodeMatch = /process\.exitCode\s*=\s*(\d+);/.exec(viewerCliSrc);
	assert.ok(cliExitCodeMatch, "Could not parse error exit code from factory/viewer/cli.ts");
	const cliErrorExitCode = Number(cliExitCodeMatch[1]);

	const defaultStoreFnMatch = /export function defaultFactoryStorePath[\s\S]*?\n\}/.exec(operationsSrc);
	assert.ok(defaultStoreFnMatch, "Could not parse defaultFactoryStorePath from factory/operations.ts");
	const bootstrapServiceSectionMatch = /constructor\(options: ServiceOptions\)[\s\S]*?defaultCoordinationPath\(\): string \{[\s\S]*?\n\t\}/.exec(lifecycleSrc);
	assert.ok(bootstrapServiceSectionMatch, "Could not parse BootstrapService env reads from bootstrap/lifecycle.ts");

	const envVars = new Set<string>();
	for (const m of viewerCliSrc.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g)) envVars.add(m[1]!);
	for (const m of viewerServerSrc.matchAll(/(?:options\.env\?\.|env\.)([A-Z][A-Z0-9_]*)/g)) envVars.add(m[1]!);
	for (const m of defaultStoreFnMatch[0].matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) envVars.add(m[1]!);
	for (const m of bootstrapServiceSectionMatch[0].matchAll(/\bthis\.env\.([A-Z][A-Z0-9_]*)/g)) envVars.add(m[1]!);
	assert.ok(envVars.size >= 7, "Expected viewer environment variables from source files");

	return {
		pollIntervalMs,
		fetchTimeoutMs,
		defaultHost,
		hostRejectStatus,
		staticAssets,
		apiViews,
		defaultPort,
		cliErrorExitCode,
		envVars: [...envVars].sort(),
		startupTimeoutMs,
		stopSigtermWaitMs,
		stopSigkillWaitMs,
		healthTimeoutMs,
		maxStderrBytes,
		allowedViewerEnvVars,
	};
}

export function assertViewerDocMatchesSource(docText: string, docPath = viewerDocPath, rootDir = repoRoot) {
	const spec = parseViewerSourceContract(rootDir);
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

	// 3. Static assets (specifically in the Local assets list) and HTTP API routes must match server.ts.
	const assetSectionMatch = /### Local assets and strict CSP([\s\S]*?)### HTTP snapshot API contract/.exec(docText);
	assert.ok(assetSectionMatch, "Missing Local assets and strict CSP subsection");
	const assetBullets = assetSectionMatch[1]!.match(/^- .*$/gm) ?? [];
	const documentedAssets = new Set<string>();
	for (const bullet of assetBullets) {
		for (const m of bullet.matchAll(/`(?:GET\s+)?(\/[^`\s]*)`/g)) {
			documentedAssets.add(m[1]!);
		}
	}
	for (const assetPath of spec.staticAssets) {
		assert.ok(documentedAssets.has(assetPath), `Missing STATIC_ASSETS key in Local assets list: ${assetPath}`);
	}
	for (const docAsset of documentedAssets) {
		assert.ok(spec.staticAssets.includes(docAsset), `Extra static asset in Local assets list not in STATIC_ASSETS: ${docAsset}`);
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

	// 4. Timing, host, port, exit code, env table, and status numbers must match source files.
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
	const staleSectionMatch = /### Distinguishing `Stale`, `Uncertain`, and `reconciliation`([\s\S]*?)^---/m.exec(docText);
	assert.ok(staleSectionMatch, "Missing Distinguishing Stale/Uncertain/reconciliation subsection");
	assert.ok(
		new RegExp(`\\b${timeoutSeconds}(?:\\s*-\\s*|\\s+)seconds?\\s+timeout\\b`, "i").test(staleSectionMatch[1]!),
		`Stale subsection must document ${timeoutSeconds}-second timeout`,
	);
	const timeoutMentions = [...docText.matchAll(/\b(\d+)(?:\s*-\s*|\s+)seconds?(?:\s+(?:client\s+)?request)?\s+timeout\b/gi)];
	assert.ok(timeoutMentions.length >= 4, "Expected timeout mentions across Loading, Stale, and Scenario 3");
	for (const tm of timeoutMentions) {
		assert.equal(Number(tm[1]), timeoutSeconds, `Timeout mention "${tm[0]}" disagrees with FETCH_TIMEOUT_MS (${timeoutSeconds}s)`);
	}

	const envTableMatch = /\| Variable \| Default \| Rules \|\r?\n\| --- \| --- \| --- \|\r?\n((?:\|[^\n]*(?:\r?\n|$))+)/.exec(docText);
	assert.ok(envTableMatch, "Missing Section 1 environment variables table");
	const documentedEnvVars = new Set<string>();
	for (const row of envTableMatch[1]!.trim().split(/\r?\n/)) {
		const rowVarMatch = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(row);
		assert.ok(rowVarMatch, `Malformed env table row: ${row}`);
		documentedEnvVars.add(rowVarMatch[1]!);
	}
	for (const envVar of spec.envVars) {
		assert.ok(documentedEnvVars.has(envVar), `Missing env var row in Section 1 table: ${envVar}`);
	}
	for (const docEnvVar of documentedEnvVars) {
		assert.ok(spec.envVars.includes(docEnvVar), `Documented env var row not read in cli.ts/server.ts/operations.ts/lifecycle.ts: ${docEnvVar}`);
	}

	assert.match(
		docText.replace(/[*`]/g, ""),
		/\bFACTORY_STATE_PATH\s+moves\s+only\s+the\s+factory\s+store\b/i,
		"Doc must state that FACTORY_STATE_PATH moves only the factory store",
	);
	assert.match(
		docText.replace(/[*`]/g, ""),
		/FACTORY_STATE_PATH\b[\s\S]{0,400}\buncertain\b/i,
		"Doc must explain the consequence of setting FACTORY_STATE_PATH alone",
	);

	const exitCodeMentions = [...envTableMatch[1]!.replace(/`/g, "").matchAll(/\bexit(?:\s+with)?(?:\s+code)?\s+(\d+)\b/gi)];
	assert.ok(exitCodeMentions.length >= 2, "Expected CLI error exit code mentions in Section 1 env table");
	for (const ec of exitCodeMentions) {
		assert.equal(Number(ec[1]), spec.cliErrorExitCode, `Documented CLI exit code ${ec[0]} disagrees with cli.ts (${spec.cliErrorExitCode})`);
	}

	const hostRowMatch = /\|\s*`FACTORY_VIEWER_HOST`\s*\|\s*`([^`]+)`\s*\|([^\n]*)\|/.exec(docText);
	assert.ok(hostRowMatch, "Missing FACTORY_VIEWER_HOST row in Section 1");
	assert.equal(hostRowMatch[1], spec.defaultHost, `Default host must match server.ts (${spec.defaultHost})`);
	assert.doesNotMatch(docText, /\b0\.0\.0\.0\b/, "Viewer doc must never mention 0.0.0.0");
	const portRowMatch = /\|\s*`FACTORY_VIEWER_PORT`\s*\|\s*`(\d+)`/.exec(docText);
	assert.ok(portRowMatch, "Missing FACTORY_VIEWER_PORT row in Section 1");
	assert.equal(Number(portRowMatch[1]), spec.defaultPort);

	let hostStatusChecks = 0;
	for (const clause of docText.replace(/`/g, "").split(/(?<=[.!?;])\s+|\r?\n+/)) {
		if (/\bHost\b/i.test(clause) && /(?:\bHTTP\s+\d{3}\b|\breturn(?:s|ed)?\s+\d{3}\b|\brefused\s+with\s+(?:HTTP\s+)?\d{3}\b)/i.test(clause)) {
			const statuses = [...clause.matchAll(/(?:\bHTTP\s+|\breturn(?:s|ed)?\s+|\brefused\s+with\s+(?:HTTP\s+)?)(\d{3})\b/gi)].map(m => Number(m[1]));
			assert.ok(statuses.length >= 1, `Expected HTTP status code in Host header clause: ${clause}`);
			for (const status of statuses) {
				assert.equal(status, spec.hostRejectStatus, `Host header clause must report ${spec.hostRejectStatus} (got ${status}): ${clause}`);
			}
			hostStatusChecks++;
		}
	}
	assert.ok(hostStatusChecks >= 2, "Expected Host header rejection status clauses in Section 1 and Section 5");
	assert.match(
		docText.replace(/`/g, ""),
		new RegExp(`\\blocalhost\\b[^\\n]*\\b${spec.hostRejectStatus}\\b`),
		`Expected localhost rejection status ${spec.hostRejectStatus}`,
	);

	// 4b. "Starting and stopping from Pi" section must match factory/viewer-command.ts constants and behaviours (D3, D5).
	const piViewerMatch = /### Starting and stopping from Pi \(`\/factory viewer`\)([\s\S]*?)^---/m.exec(docText);
	assert.ok(piViewerMatch, "Missing 'Starting and stopping from Pi (`/factory viewer`)' subsection");
	const piViewerSection = piViewerMatch[1]!;
	const startupSeconds = spec.startupTimeoutMs / 1000;
	const stopTermSeconds = spec.stopSigtermWaitMs / 1000;
	const healthSeconds = spec.healthTimeoutMs / 1000;
	const waitStartMatch = /waits up to (\d+) seconds/i.exec(piViewerSection);
	assert.ok(waitStartMatch, "Pi viewer section must document startup wait duration in seconds");
	assert.equal(Number(waitStartMatch[1]), startupSeconds, `Pi viewer startup wait (${waitStartMatch[1]}s) must match DEFAULT_STARTUP_TIMEOUT_MS (${startupSeconds}s)`);
	const sigtermWaitMatch = /escalat(?:ing|es) to `SIGKILL` after (\d+) seconds/i.exec(piViewerSection);
	assert.ok(sigtermWaitMatch, "Pi viewer section must document SIGTERM wait duration before SIGKILL");
	assert.equal(Number(sigtermWaitMatch[1]), stopTermSeconds, `Pi viewer SIGTERM wait (${sigtermWaitMatch[1]}s) must match STOP_SIGTERM_WAIT_MS (${stopTermSeconds}s)`);
	assert.ok(piViewerSection.includes(`${healthSeconds}s`) || piViewerSection.includes(`${healthSeconds} seconds`) || piViewerSection.includes(`${spec.healthTimeoutMs}ms`), "Pi viewer section must document health probe timeout");
	assert.match(piViewerSection, /\b0600\b/);
	assert.match(piViewerSection, /\bfactory-viewer\.json\b/);
	assert.match(piViewerSection, /\bPI_CODING_AGENT_DIR\b/);
	assert.match(piViewerSection, /\bstarting\b[\s\S]*\brunning\b/);
	assert.match(piViewerSection, /\bcoordination_dir\b/);
	assert.match(piViewerSection, /\bsessions_dir\b/);
	assert.match(piViewerSection, /\bstore_path\b/);
	assert.match(piViewerSection, /\/proc\/<pid>\/cmdline/);
	assert.match(piViewerSection, /\buid\b/i);
	assert.match(piViewerSection, /0o?022/);
	assert.match(piViewerSection, /non-Linux/i);
	assert.match(piViewerSection, /\bNODE_OPTIONS\b/);
	assert.match(piViewerSection, /\bBOOTSTRAP_NODE\b[\s\S]*process\.execPath[\s\S]*\bPATH\b/);
	assert.match(piViewerSection, /--experimental-strip-types/);
	assert.match(piViewerSection, /exited before printing URL/i);
	assert.match(piViewerSection, /timed out after/i);
	assert.match(piViewerSection, /interpreter[\s\S]*entry/i);
	assert.ok(piViewerSection.includes(String(spec.maxStderrBytes)), `Pi viewer section missing MAX_STDERR_BYTES (${spec.maxStderrBytes})`);
	assert.match(piViewerSection, /never\b[\s\S]{0,80}\bauto-start/i);
	assert.match(piViewerSection, /does \*\*not\*\* open a browser/i);
	for (const envVar of spec.allowedViewerEnvVars) {
		assert.ok(piViewerSection.includes(`\`${envVar}\``), `Pi viewer section missing allowlisted env var \`${envVar}\``);
	}

	// 5. All 5 manual checklist scenarios must be present, Scenario 3 wait agrees with FETCH_TIMEOUT_MS,
	//    and Scenarios 2 & 4 must stay marked NOT YET RUN everywhere in the checklist and execution status.
	for (const n of [1, 2, 3, 4, 5]) {
		assert.match(docText, new RegExp(`^#### Scenario ${n}\\b`, "m"), `Missing Scenario ${n} heading`);
	}
	const scenarioBlocks = new Map<number, string>();
	const blockMatches = [...docText.matchAll(/^#### Scenario (\d+)[^\n]*\n([\s\S]*?)(?=^#### |$(?![\s\S]))/gm)];
	for (const m of blockMatches) scenarioBlocks.set(Number(m[1]), `${m[0]}`);
	assert.equal(scenarioBlocks.size, 5, "Expected all 5 Scenario sections to be parsed");
	for (const unrun of [2, 4]) {
		const block = scenarioBlocks.get(unrun);
		assert.ok(block, `Missing Scenario ${unrun} section body`);
		assert.match(block, /NOT YET RUN/, `Scenario ${unrun} must be marked NOT YET RUN`);
		assert.match(block, /^-\s+\*\*Status:\*\*[^\n]*NOT YET RUN/m, `Scenario ${unrun} Status line must state NOT YET RUN`);
		assert.doesNotMatch(block, /\bexercised\b/i, `Scenario ${unrun} must not be marked exercised`);
		assert.doesNotMatch(block, /\[x\]\s*Pass/i, `Scenario ${unrun} must not be checked Pass`);
	}
	const scenario3Block = scenarioBlocks.get(3);
	assert.ok(scenario3Block, "Missing Scenario 3 section body");
	const stopWaitMatch = /kill -STOP[^\n]*?\bwait\s*>\s*(\d+)\s*s\b/i.exec(scenario3Block);
	assert.ok(stopWaitMatch, "Scenario 3 must specify wait >Ns after kill -STOP");
	assert.ok(
		Number(stopWaitMatch[1]) >= timeoutSeconds + pollSeconds,
		`Scenario 3 kill -STOP wait (${stopWaitMatch[1]}s) must be >= FETCH_TIMEOUT_MS + LIVE_POLL_INTERVAL_MS (${timeoutSeconds + pollSeconds}s)`,
	);

	const execStatusMatch = /\*\*Execution status:\*\*([\s\S]*?)\*\*Launch an isolated temporary fixture/.exec(docText);
	assert.ok(execStatusMatch, "Missing Execution status summary");
	assert.match(execStatusMatch[1]!, /Scenarios 2 and 4[^\n]*NOT YET RUN/);
	for (const line of execStatusMatch[1]!.split(/\r?\n/)) {
		const scenarioLists = [...line.matchAll(/\bScenarios?\s+(\d+(?:\s*(?:,|and|&|-|–)\s*\d+)*)/gi)];
		for (const listMatch of scenarioLists) {
			const nums: number[] = [];
			for (const part of listMatch[1]!.split(/\s*(?:,|and|&)\s*/i)) {
				const rangeMatch = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part.trim());
				if (rangeMatch) {
					const start = Number(rangeMatch[1]);
					const end = Number(rangeMatch[2]);
					for (let n = Math.min(start, end); n <= Math.max(start, end); n++) nums.push(n);
				} else {
					const single = /\d+/.exec(part);
					if (single) nums.push(Number(single[0]));
				}
			}
			if (nums.includes(2) || nums.includes(4)) {
				assert.match(line, /NOT YET RUN/, `Execution status line referencing Scenario 2/4 must state NOT YET RUN: ${line}`);
				assert.doesNotMatch(
					line,
					/\b(?:pass(?:ed)?|ran|verified|exercised)\b|\[x\]/i,
					`Execution status must not claim Scenario 2 or 4 ran/passed: ${line}`,
				);
			}
		}
	}
}

test("docs/factory-web-viewer.md, links, and GLOSSARY Run graph entry match the shipped viewer", () => {
	assert.match(factoryGuide, /\[[^\]]+\]\(factory-web-viewer\.md\)/);
	assert.match(readme, /\[[^\]]+\]\(\.\.\/docs\/factory-web-viewer\.md\)/);
	assert.match(glossary, /\*\*Run graph\*\*:\s+A view of one run’s nodes and edges[\s\S]*bound to that run’s input/);

	assertViewerDocMatchesSource(viewerDoc);
	const attemptOutputMatch = /^### Attempt output\n([\s\S]*?)(?=^### |^---)/m.exec(viewerDoc);
	assert.ok(attemptOutputMatch, "Missing consolidated Attempt output section");
	const attemptOutput = attemptOutputMatch[1]!;
	const attemptOutputLower = attemptOutput.toLowerCase();
	assert.match(attemptOutput, /Attempt output is allowed in scrubbed, bounded form/);
	assert.doesNotMatch(
		attemptOutput,
		/(?:responses?|the viewer)\s+(?:still\s+)?exclude[^\n]*\b(?:logs?|internal records)\b/i,
		"Attempt output privacy wording must not exclude logs or internal records wholesale",
	);
	for (const privacyTerm of [
		"raw prompts", "input briefs", "tokens", "endpoint paths", "worker configuration", "metrics",
		"artifact paths", "canonical checkout paths", "session transcripts", "terminal capture",
		"thinking text", "any log", "unprojected internal records",
	]) {
		assert.ok(attemptOutputLower.includes(privacyTerm.toLowerCase()), `Attempt output privacy statement missing: ${privacyTerm}`);
	}

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

	// Verify doc guard catches deletion or numeric drift in Starting and stopping from Pi (D3, D5).
	assert.throws(() => assertViewerDocMatchesSource(viewerDoc.replace(/### Starting and stopping from Pi[\s\S]*?^---/m, "---")), /Starting and stopping from Pi/);
	assert.throws(() => assertViewerDocMatchesSource(viewerDoc.replace(/after 5 seconds/, "after 99 seconds")), /STOP_SIGTERM_WAIT_MS/);
	assert.throws(() => assertViewerDocMatchesSource(viewerDoc.replace(/waits up to 10 seconds/, "waits up to 99 seconds")), /DEFAULT_STARTUP_TIMEOUT_MS/);
});

test("model-facing tool descriptions and factory docs are Host-backend-neutral and drop ticket-01 Herdr-only placeholders", () => {
	const dispatcher = registeredDispatcherSurface();
	const generate = dispatcher.tools.get("bootstrap_generate")!;
	const status = dispatcher.tools.get("bootstrap_status")!;
	const recover = dispatcher.tools.get("bootstrap_recover")!;
	const cleanup = dispatcher.tools.get("bootstrap_cleanup")!;
	const tabIdsDesc = collectDescriptions((cleanup.parameters as any).args[0].tab_ids).join("\n");

	assert.doesNotMatch(generate.description, /originating Herdr workspace/i);
	assert.doesNotMatch(status.description, /from Herdr idle status/i);
	assert.doesNotMatch(recover.description, /shared Herdr pane wake-up fallback/i);
	assert.match(tabIdsDesc, /Herdr-only/i);
	assert.match(tabIdsDesc, /refused on hc/i);

	for (const [label, doc] of [
		["docs/factory-guide.md", factoryGuide],
		["docs/factory-launch.md", factoryLaunchDoc],
	] as const) {
		assert.doesNotMatch(doc, /currently uses Herdr/i, `${label} still has ticket-01 Herdr-only wording`);
		assert.doesNotMatch(doc, /follow-on implementation/i, `${label} still claims hc is follow-on work`);
		assert.doesNotMatch(doc, /herdr in this checkout/i, `${label} still claims herdr-only checkout`);
		assert.doesNotMatch(doc, /inside Herdr/i, `${label} still requires running inside Herdr`);
		assert.match(doc, /bootstrap\/HOST\.md/, `${label} must link to bootstrap/HOST.md`);
		assert.match(doc, /\bhc\b/i, `${label} must document hc backend support`);
		assert.match(doc, /\bherdr\b/i, `${label} must document herdr backend support`);
	}
});
