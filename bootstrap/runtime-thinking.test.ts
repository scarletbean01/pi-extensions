import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, executableOnPath, shellQuote } from "./lifecycle.ts";
import { gate, isolatedPiEnvironment, probeCommand, runSupervised } from "./test-harness.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));

test("the launched Pi agent reports the alias thinking level with a dated model snapshot", { timeout: 20_000 }, async t => {
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	if (!gate(t, await probeCommand("pi", ["--no-extensions", "--version"], iso.env))) return;

	const pi = executableOnPath("pi", iso.env);
	const bin = join(iso.root, "bin");
	const personas = join(iso.root, ".pi", "agents");
	mkdirSync(bin);
	mkdirSync(personas, { recursive: true });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	// Run the generated launcher in print mode with isolated Pi resources.
	writeFileSync(join(bin, "pi"), `#!/bin/sh
exec ${shellQuote(pi)} --no-extensions --no-mcp --no-context-files --no-session --offline -p "$@"
`, { mode: 0o700 });

	const capture = join(iso.root, "thinking.json");
	const coms = join(iso.root, "coms-fixture.ts");
	// Stub the transport at the registry boundary so the real worker needs no socket.
	writeFileSync(coms, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
	for (const name of ["cname", "project", "purpose"]) pi.registerFlag(name, { type: "string" });
	pi.registerTool({ name: "coms_send", label: "Coms fixture", description: "Unused transport", parameters: { type: "object" }, execute: () => { throw new Error("Unexpected Coms send"); } });
	pi.registerProvider("bootstrap-thinking", {
		baseUrl: "http://127.0.0.1:65536", apiKey: "test-only", api: "openai-completions",
		models: [{ id: "model-20251001", name: "Thinking fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
	});
	pi.on("session_start", (_event, ctx) => {
		const name = pi.getFlag("cname");
		const dir = join(process.env.PI_COMS_DIR, "projects", pi.getFlag("project"), "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name + ".json"), JSON.stringify({ pid: process.pid, name, session_id: "fixture", endpoint: "unused" }));
	});
	pi.on("before_provider_request", (_event, ctx) => {
		writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ thinking: pi.getThinkingLevel(), model: ctx.model.id }));
		process.exit(0);
	});
}
`);
	writeFileSync(join(personas, "review.md"), "---\nmodel: review\n---\nReview the patch.\n");
	writeFileSync(join(iso.agentDir, "bootstrap.json"), JSON.stringify({
		modelAliases: { review: { model: "bootstrap-thinking/model", thinking: "high" } },
	}));

	let child: ReturnType<typeof runSupervised> | undefined;
	const env = { ...iso.env, HERDR_ENV: "1", HERDR_PANE_ID: "caller", PATH: [bin, iso.env.PATH].join(delimiter) };
	const service = new BootstrapService({ extensionDir, stateDir: iso.stateDir, home: iso.home, env, pollMs: 20,
		exec: async (_command, args) => {
			let result: unknown = {};
			if (args[0] === "pane" && args[1] === "get") result = { pane: { workspace_id: "workspace" } };
			else if (args[0] === "tab" && args[1] === "create") result = { tab: { tab_id: "tab" }, root_pane: { pane_id: "pane", terminal_id: "terminal" } };
			else if (args[0] === "pane" && args[1] === "run") {
				child = runSupervised("/bin/sh", ["-c", args[3]], { cwd: iso.root, env: iso.env, timeoutMs: 12_000 });
				void child.catch(() => {});
			} else assert.fail(`Unexpected Herdr command: ${args.join(" ")}`);
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		},
	});
	const run = await service.generate({
		topology: "chain", task: "Review", project_cwd: iso.root, coms_extension: coms, ready_timeout_ms: 8_000,
		agents: [{ name: "review", sub_task: "Review the patch" }],
	});
	assert.ok(child, run.error);
	const result = await child;
	const diagnostics = [run.error, result.stdout, result.stderr].filter(Boolean).join("\n");
	assert.equal(run.status, "applied", diagnostics);
	assert.equal(result.timedOut, false, diagnostics);
	assert.equal(result.code, 0, diagnostics);
	assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { thinking: "high", model: "model-20251001" });
});
