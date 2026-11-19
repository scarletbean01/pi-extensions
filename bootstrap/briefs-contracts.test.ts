import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { formatPlan } from "./reporting.ts";

// Pi supplies TypeBox at runtime; the deterministic suite only needs schema constructors.
const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, context);
} });
const { default: registerWorker } = await import("./worker.ts");

interface FakeTab { tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }

function serviceFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-briefs-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["reviewer", "implementer", "verifier"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ntools: read,bash\n---\nExact persona ${name}\n`);
	}
	const tabs: FakeTab[] = [];
	const configs: WorkerConfig[] = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const tab = tabs.find(item => item.pane_id === args[2])!;
			const [task, instance] = tab.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			configs.push(config);
			const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
			atomicJson(readyPath(sessionDir, instance), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") return ok({ workspaces: [{ workspace_id: "origin-workspace" }], tabs, panes: tabs });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};
	const service = new BootstrapService({
		exec, extensionDir, stateDir, home, pollMs: 5,
		env: { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	return { root, cwd, home, stateDir, service, configs };
}

function workerFromConfig(t: test.TestContext, configPath: string, overrides: { tools?: string[] } = {}) {
	const config = readJson<WorkerConfig>(configPath);
	const hooks = new Map<string, Function>();
	const tools = new Map<string, any>();
	let active = overrides.tools ?? ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"];
	let shutdowns = 0;
	let aborts = 0;
	const sent: Array<{ name: string; params: any }> = [];
	const context = {
		model: { provider: "provider", id: "model" },
		ui: { notify: () => {} },
		shutdown: () => { shutdowns++; },
		abort: () => { aborts++; },
		executeTool: async (name: string, params: unknown) => {
			sent.push({ name, params });
			return { content: [], details: { msg_id: "msg1" } };
		},
	};
	registerWorker({
		registerFlag: () => {},
		getFlag: (name: string) => name === "bootstrap-worker-config" ? configPath : undefined,
		on: (name: string, handler: Function) => hooks.set(name, (event: unknown, ctx = context) => handler(event, ctx)),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		getAllTools: () => [...active, "bootstrap_complete", "bootstrap_read_input", "bootstrap_verify"].map(name => ({ name })),
		setActiveTools: (names: string[]) => { active = names; },
	} as any);
	t.after(async () => { await hooks.get("session_shutdown")?.({ reason: "reload" }, context); });
	return {
		config, hooks, tools, context, sent,
		get active() { return active; },
		get shutdowns() { return shutdowns; },
		get aborts() { return aborts; },
		start: () => hooks.get("session_start")!({}, context),
		beforeStart: (event: Record<string, unknown> = { systemPrompt: "BASE" }) => hooks.get("before_agent_start")!(event, context),
		complete: (params: Record<string, unknown>) => tools.get("bootstrap_complete").execute("id", params, undefined, undefined, context),
		readInput: (params: Record<string, unknown>) => tools.get("bootstrap_read_input").execute("id", params, undefined, undefined, context),
		verify: (params: Record<string, unknown>) => tools.get("bootstrap_verify").execute("id", params, undefined, undefined, context),
	};
}

// ---- Slice 1: Bounded shared briefs & immutable task inputs ----

test("shared brief injects goal, acceptance criteria, constraints, role, ownership and bounded multibyte roster", async t => {
	const f = serviceFixture(t);
	const longCriterion = "Must preserve multibyte UTF-8 characters: " + "é🚀".repeat(1500);
	const request: GenerateRequest = {
		topology: "team",
		task: "Harden parser",
		goal: "Ship a safe parser without breaking legacy callers",
		acceptance_criteria: ["All existing tests pass", longCriterion],
		constraints: ["Do not create git worktrees", "Keep v1 readers working"],
		project_cwd: f.cwd,
		request_id: "brief-1",
		agents: [
			{
				node_id: "review-api",
				persona: "reviewer",
				role: "API boundary reviewer",
				ownership: ["src/api.ts", "tests/api.test.ts"],
				acceptance_criteria: ["Check error codes"],
				constraints: ["Read-only review"],
				sub_task: "Review the API surface " + "Ω".repeat(600),
			},
			{
				node_id: "review-ui",
				persona: "reviewer",
				role: "UI flow reviewer",
				ownership: ["src/ui.ts"],
				sub_task: "Review the UI flows",
			},
		],
	};

	const model = { provider: "provider", id: "model" };
	const plan = f.service.plan(request, model);
	assert.equal(plan.goal, "Ship a safe parser without breaking legacy callers");
	assert.deepEqual(plan.agents[0].ownership, ["src/api.ts", "tests/api.test.ts"]);
	assert.match(formatPlan(plan), /goal: Ship a safe parser/);
	assert.match(formatPlan(plan), /role: API boundary reviewer/);
	assert.match(formatPlan(plan), /ownership: src\/api\.ts, tests\/api\.test\.ts/);

	const run = await f.service.generate(request, model);
	// Canonical fingerprint must distinguish brief/contract changes on the same request_id.
	await assert.rejects(f.service.generate({ ...request, goal: "Different goal" }, model), /different bootstrap plan/);

	// Immutable task input file exists and records full, un-truncated assignment data + hash.
	const apiInputPath = join(run.session_dir, "a1-review-api.input.json");
	assert.equal(existsSync(apiInputPath), true);
	const apiInput = readJson<any>(apiInputPath);
	assert.equal(apiInput.version, 2);
	assert.equal(apiInput.authoritative, true);
	assert.equal(apiInput.identity.node_id, "review-api");
	assert.equal(apiInput.brief.goal, request.goal);
	assert.deepEqual(apiInput.brief.acceptance_criteria, request.acceptance_criteria);
	assert.deepEqual(apiInput.brief.constraints, request.constraints);
	assert.equal(apiInput.assignment.role, "API boundary reviewer");
	assert.deepEqual(apiInput.assignment.ownership, ["src/api.ts", "tests/api.test.ts"]);
	assert.ok(typeof apiInput.input_hash === "string" && apiInput.input_hash.length === 64);

	// Worker receives bounded brief, role, ownership, bounded multibyte roster, and truncation + retrieval guidance.
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-review-api.config.json"));
	await w1.start();
	const p1 = await w1.beforeStart();
	assert.match(p1.systemPrompt, /Authoritative assignment instructions/);
	assert.match(p1.systemPrompt, /Goal: Ship a safe parser without breaking legacy callers/);
	assert.match(p1.systemPrompt, /Acceptance criteria:/);
	assert.match(p1.systemPrompt, /Constraints:/);
	assert.match(p1.systemPrompt, /Your role: API boundary reviewer/);
	assert.match(p1.systemPrompt, /Your ownership: src\/api\.ts, tests\/api\.test\.ts/);
	assert.match(p1.systemPrompt, /bootstrap_read_input/);
	assert.match(p1.systemPrompt, /Truncated/);
	assert.ok(!p1.systemPrompt.includes("\uFFFD"), "UTF-8 truncation must never produce replacement characters");

	// Tampered immutable task input file is rejected before work starts.
	const w2 = workerFromConfig(t, join(run.session_dir, "a2-review-ui.config.json"));
	await w2.start();
	const uiInputPath = join(run.session_dir, "a2-review-ui.input.json");
	const tampered = readJson<any>(uiInputPath);
	tampered.assignment.sub_task = "Hijacked task";
	atomicJson(uiInputPath, tampered);
	await w2.beforeStart();
	assert.equal(w2.aborts, 1);
	assert.match(readJson<any>(join(run.session_dir, "a2-review-ui.error.json")).error, /input_hash|integrity/i);
});

// ---- Slice 2: Upstream-results index, peer vs authoritative separation, provenance & retrieval ----

test("3-stage chain preserves earlier decisions in upstream index, separates peer data, and retrieves full inputs/artifacts", async t => {
	const f = serviceFixture(t);
	// Persona with restricted tools (no `read`) must still get bootstrap_read_input.
	writeFileSync(join(f.cwd, ".pi", "agents", "narrow.md"), "---\nname: narrow\ntools: grep\n---\nNarrow persona\n");
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "chain",
		task: "Decide, plan, and execute",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "decide", persona: "reviewer", sub_task: "Make architectural decision" },
			{ node_id: "plan", persona: "implementer", sub_task: "Draft plan from decision" },
			{ node_id: "execute", persona: "narrow", sub_task: "Execute using earlier decision and plan" },
		],
	}, model);

	mkdirSync(join(f.cwd, "docs"), { recursive: true });
	const decisionPath = join(f.cwd, "docs", "decision.md");
	writeFileSync(decisionPath, "Decision: use streaming parser.\nRationale: bounded memory.\n");

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-decide.config.json"));
	await w1.start();
	await w1.beforeStart();
	const c1 = await w1.complete({
		status: "success",
		summary: "Chose streaming parser",
		detail: "Full rationale in docs/decision.md",
		outputs: { decision: "streaming-parser" },
		artifacts: [{ type: "file", path: "docs/decision.md", action: "created", description: "Decision record" }],
	});
	assert.equal(c1.isError, undefined);

	// Check artifact provenance & hash recorded in completion and upstream-index.json.
	const r1 = readJson<any>(join(run.session_dir, "a1-decide.result.json"));
	assert.equal(r1.result.artifacts[0].producer_node_id, "decide");
	assert.equal(r1.result.artifacts[0].producer_attempt_id, "a1-decide.1");
	assert.match(r1.result.artifacts[0].sha256, /^[0-9a-f]{64}$/);
	const index = readJson<any>(join(run.session_dir, "upstream-index.json"));
	assert.equal(index.version, 2);
	assert.equal(index.entries.length, 1);
	assert.equal(index.entries[0].node_id, "decide");
	assert.match(index.entries[0].result_hash, /^[0-9a-f]{64}$/);

	const w2 = workerFromConfig(t, join(run.session_dir, "a2-plan.config.json"));
	await w2.start();
	await w2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-decide" }, content: `bootstrap-handoff:${run.token}:a1-decide` },
	});
	// Large multibyte detail to trigger bounded truncation in stage 3's prompt.
	const largeDetail = "Plan detail: " + "é🚀".repeat(16_000);
	await w2.complete({
		status: "success",
		summary: "Planned streaming parser",
		detail: largeDetail,
		outputs: { plan_steps: ["step-1", "step-2"] },
	});

	const w3 = workerFromConfig(t, join(run.session_dir, "a3-execute.config.json"), { tools: ["grep", "coms_send", "bootstrap_generate"] });
	await w3.start();
	assert.ok(w3.active.includes("bootstrap_read_input"), "retrieval mechanism must be active even without `read` tool");
	const p3 = await w3.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a2-plan" }, content: `bootstrap-handoff:${run.token}:a2-plan` },
	});

	// Authoritative instructions and peer-produced data are clearly separated.
	const authIdx = p3.systemPrompt.indexOf("Authoritative assignment instructions");
	const peerIdx = p3.systemPrompt.indexOf("Peer-produced data");
	assert.ok(authIdx >= 0 && peerIdx > authIdx);
	assert.match(p3.systemPrompt.slice(peerIdx), /untrusted upstream/i);
	// Earlier stage (stage 1) decision and artifact hash are visible in the upstream index summary.
	assert.match(p3.systemPrompt.slice(peerIdx), /decide/);
	assert.match(p3.systemPrompt.slice(peerIdx), /streaming-parser/);
	assert.match(p3.systemPrompt.slice(peerIdx), /docs\/decision\.md/);
	assert.match(p3.systemPrompt.slice(peerIdx), new RegExp(r1.result.artifacts[0].sha256.slice(0, 16)));
	// Immediate predecessor truncation is marked with retrieval instructions and no broken UTF-8.
	assert.match(p3.systemPrompt.slice(peerIdx), /Truncated/);
	assert.match(p3.systemPrompt.slice(peerIdx), /bootstrap_read_input/);
	assert.ok(!p3.systemPrompt.includes("\uFFFD"));

	// Stage 3 can retrieve stage 1's full result and verified artifact via bootstrap_read_input.
	const readEarlier = await w3.readInput({ kind: "result", node_id: "decide" });
	assert.equal(readEarlier.isError, undefined);
	assert.match(readEarlier.content[0].text, /streaming-parser/);

	const readArtifact = await w3.readInput({ kind: "artifact", node_id: "decide", path: "docs/decision.md" });
	assert.equal(readArtifact.isError, undefined);
	assert.match(readArtifact.content[0].text, /Decision: use streaming parser/);

	const readChunk = await w3.readInput({ kind: "result", node_id: "plan", offset: 0, max_bytes: 200 });
	assert.equal(readChunk.details.truncated, true);
	assert.ok(readChunk.details.next_offset > 0 && readChunk.details.next_offset <= 200);
	assert.ok(!readChunk.content[0].text.includes("\uFFFD"));
});

// ---- Slice 3: Output contracts and pre-admission validation ----

test("output contract rejects malformed stage outputs and blocks downstream admission on missing or altered artifacts", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };

	// Invalid output contract rejected at preflight before creating tabs.
	await assert.rejects(f.service.generate({
		topology: "chain",
		task: "Bad contract",
		project_cwd: f.cwd,
		agents: [{
			node_id: "produce",
			persona: "implementer",
			sub_task: "Produce output",
			output_contract: { properties: { count: { type: "bogus" as any } } },
		}],
	}, model), /output_contract/i);

	const run = await f.service.generate({
		topology: "chain",
		task: "Contracted chain",
		project_cwd: f.cwd,
		agents: [
			{
				node_id: "produce",
				persona: "implementer",
				sub_task: "Produce structured findings and artifact",
				output_contract: {
					required_fields: ["verdict"],
					properties: {
						verdict: { type: "string", enum: ["approved", "rejected"], required: true },
						issue_count: { type: "integer", required: true },
					},
					require_artifacts: true,
					required_artifact_paths: ["out/report.json"],
				},
			},
			{
				node_id: "consume",
				persona: "reviewer",
				sub_task: "Consume validated findings",
			},
		],
	}, model);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-produce.config.json"));
	await w1.start();
	await w1.beforeStart();

	// Missing required fields / wrong types / missing artifact are rejected by bootstrap_complete without locking out worker.
	const bad1 = await w1.complete({
		status: "success",
		summary: "Done",
		detail: "Details",
		outputs: { verdict: "maybe", issue_count: 1.5 },
	});
	assert.equal(bad1.isError, true);
	assert.match(bad1.content[0].text, /verdict|issue_count|artifact/i);

	// Missing or deleted file artifacts cannot satisfy require_artifacts or bootstrap_complete.
	const badMissingArt = await w1.complete({
		status: "success",
		summary: "Done",
		detail: "Claims missing file",
		outputs: { verdict: "approved", issue_count: 0 },
		artifacts: [{ type: "file", path: "out/missing.txt", action: "created" }],
	});
	assert.equal(badMissingArt.isError, true);
	assert.match(badMissingArt.content[0].text, /missing|artifact/i);
	assert.equal(existsSync(join(run.session_dir, "a1-produce.result.json")), false);

	const badDeletedArt = await w1.complete({
		status: "success",
		summary: "Done",
		detail: "Only deleted artifact",
		outputs: { verdict: "approved", issue_count: 0 },
		artifacts: [{ type: "file", path: "out/report.json", action: "deleted" }],
	});
	assert.equal(badDeletedArt.isError, true);
	assert.match(badDeletedArt.content[0].text, /require|artifact/i);

	// Create the required artifact and complete with valid outputs.
	mkdirSync(join(f.cwd, "out"), { recursive: true });
	const artifactFile = join(f.cwd, "out", "report.json");
	writeFileSync(artifactFile, '{"ok":true}\n');
	const good = await w1.complete({
		status: "success",
		summary: "Produced valid output",
		detail: "All good",
		outputs: { verdict: "approved", issue_count: 0 },
		artifacts: [{ type: "file", path: "out/report.json", action: "created" }],
	});
	assert.equal(good.isError, undefined);

	// Tamper with the artifact content hash before stage 2 admits.
	writeFileSync(artifactFile, '{"ok":false}\n');
	const w2Hash = workerFromConfig(t, join(run.session_dir, "a2-consume.config.json"));
	await w2Hash.start();
	await w2Hash.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-produce" }, content: `bootstrap-handoff:${run.token}:a1-produce` },
	});
	assert.equal(w2Hash.aborts, 1);
	assert.equal(existsSync(join(run.session_dir, "a2-consume.handoff.json")), false, "rejected admission must not claim handoff");
	assert.match(readJson<any>(join(run.session_dir, "a2-consume.error.json")).error, /hash/i);

	// Delete the artifact and verify concrete missing-artifact blocker.
	rmSync(artifactFile);
	rmSync(join(run.session_dir, "a2-consume.error.json"), { force: true });
	const w2Missing = workerFromConfig(t, join(run.session_dir, "a2-consume.config.json"));
	await w2Missing.start();
	await w2Missing.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-produce" }, content: `bootstrap-handoff:${run.token}:a1-produce` },
	});
	assert.equal(w2Missing.aborts, 1);
	assert.match(readJson<any>(join(run.session_dir, "a2-consume.error.json")).error, /missing|deleted/i);

	// Restore artifact, but corrupt upstream required output directly in result.json (while updating hash to isolate output contract check).
	writeFileSync(artifactFile, '{"ok":true}\n');
	rmSync(join(run.session_dir, "a2-consume.error.json"), { force: true });
	const resPath = join(run.session_dir, "a1-produce.result.json");
	const resRec = readJson<any>(resPath);
	delete resRec.result.outputs;
	atomicJson(resPath, resRec);
	const idxPath = join(run.session_dir, "upstream-index.json");
	const idxRec = readJson<any>(idxPath);
	delete idxRec.entries[0].result_hash;
	atomicJson(idxPath, idxRec);

	// Changing the saved result after it was offered is now refused by the handoff itself (see handoff.test.ts). Contract validation is what this
	// step exercises, so the successor is run without the durable handoff protocol, as a run from the previous release would be.
	const bareConfig = join(run.session_dir, "a2-consume.bare-config.json");
	atomicJson(bareConfig, { ...readJson<any>(join(run.session_dir, "a2-consume.config.json")), handoff_protocol: undefined });
	const w2BadOut = workerFromConfig(t, bareConfig);
	await w2BadOut.start();
	await w2BadOut.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-produce" }, content: `bootstrap-handoff:${run.token}:a1-produce` },
	});
	assert.equal(w2BadOut.aborts, 1);
	assert.match(readJson<any>(join(run.session_dir, "a2-consume.error.json")).error, /verdict|outputs/i);
});

// ---- Slice 4: Verification evidence, snapshots, applicability (current/stale/unknown) ----

test("verification evidence tracks content before/after including untracked files, handles scope/edits, preserves history, and blocks stale/unknown admission", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	// Non-Git project with tracked-like source, untracked input, and unrelated doc.
	mkdirSync(join(f.cwd, "src"), { recursive: true });
	mkdirSync(join(f.cwd, "fixtures"), { recursive: true });
	mkdirSync(join(f.cwd, "docs"), { recursive: true });
	writeFileSync(join(f.cwd, "src", "parser.ts"), "export const parse = (s: string) => s;\n");
	writeFileSync(join(f.cwd, "fixtures", "untracked-input.txt"), "input-v1\n");
	writeFileSync(join(f.cwd, "docs", "notes.md"), "doc-v1\n");

	const run = await f.service.generate({
		topology: "chain",
		task: "Implement and review with required verification",
		project_cwd: f.cwd,
		agents: [
			{
				node_id: "impl",
				persona: "implementer",
				sub_task: "Implement and verify parser",
				required_checks: ["parser-tests"],
			},
			{
				node_id: "verify-downstream",
				persona: "verifier",
				sub_task: "Review verified implementation",
			},
		],
	}, model);

	// No worktree must ever be created.
	assert.equal(existsSync(join(f.cwd, ".git", "worktrees")), false);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-impl.config.json"));
	await w1.start();
	await w1.beforeStart();

	// 1) Edit DURING a check invalidates applicability immediately (unknown/unverified) even if check passed.
	await w1.verify({ action: "start", check_id: "parser-tests", scope: ["src/", "fixtures/"] });
	writeFileSync(join(f.cwd, "fixtures", "untracked-input.txt"), "input-changed-during-check\n");
	const duringRes = await w1.verify({ action: "finish", check_id: "parser-tests", result: "pass", detail: "Tests ran while file changed" });
	assert.equal(duringRes.details.applicability, "unknown");
	assert.ok(duringRes.details.record.changed_during_check.includes("fixtures/untracked-input.txt"));
	const statusDuring = f.service.status(run.task_id);
	assert.equal(statusDuring.agents[0].verification?.[0].applicability, "unknown");
	assert.equal(statusDuring.agents[0].evidence?.[0].status, "unverified");

	// Completing while required check has unknown applicability is rejected.
	const rejectUnverifiedComplete = await w1.complete({ status: "success", summary: "Done", detail: "With unverified check" });
	assert.equal(rejectUnverifiedComplete.isError, true);
	assert.match(rejectUnverifiedComplete.content[0].text, /unknown/i);

	// 2) Refresh check cleanly (no edits during check). Historical record #1 is preserved!
	await w1.verify({ action: "start", check_id: "parser-tests", scope: ["src/", "fixtures/"] });
	const cleanRes = await w1.verify({ action: "finish", check_id: "parser-tests", result: "pass", detail: "Clean pass" });
	assert.equal(cleanRes.details.applicability, "current");

	const verFile = readJson<any>(join(run.session_dir, "a1-impl.verification.json"));
	assert.equal(verFile.records.length, 2, "historical check results are preserved");

	// 3) Unrelated edit outside declared scope does NOT invalidate applicability.
	writeFileSync(join(f.cwd, "docs", "notes.md"), "doc-v2-unrelated\n");
	const statusUnrelated = f.service.status(run.task_id);
	assert.equal(statusUnrelated.agents[0].verification?.[0].applicability, "current");

	// Complete stage 1 while check is current.
	const okComplete = await w1.complete({ status: "success", summary: "Verified", detail: "Passed" });
	assert.equal(okComplete.isError, undefined);

	// 4) Relevant edit AFTER passing check marks applicability stale in status and blocks downstream admission.
	writeFileSync(join(f.cwd, "fixtures", "untracked-input.txt"), "input-v3-after\n");
	const statusAfterEdit = f.service.status(run.task_id);
	assert.equal(statusAfterEdit.agents[0].verification?.[0].applicability, "stale");
	assert.equal(statusAfterEdit.agents[0].verification?.[0].history_count, 2);

	const w2Stale = workerFromConfig(t, join(run.session_dir, "a2-verify-downstream.config.json"));
	await w2Stale.start();
	await w2Stale.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-impl" }, content: `bootstrap-handoff:${run.token}:a1-impl` },
	});
	assert.equal(w2Stale.aborts, 1);
	// Required evidence that is not current blocks the dependent with a recorded cause; it is not an execution failure (ticket 04).
	const staleBlock = readJson<any>(join(run.session_dir, "a2-verify-downstream.disposition.json"));
	assert.equal(staleBlock.state, "blocked");
	assert.match(staleBlock.reason, /parser-tests.*stale/i);
	assert.equal(existsSync(join(run.session_dir, "a2-verify-downstream.error.json")), false);

	// 5) Unknown scope / commit-ID-only evidence is marked "unknown" and also blocks dependent admission.
	const verMut = readJson<any>(join(run.session_dir, "a1-impl.verification.json"));
	verMut.records.push({
		...verMut.records[1],
		scope_kind: "unknown",
		scope: undefined,
		before_snapshot: { ...verMut.records[1].before_snapshot, scope_kind: "unknown", complete: false, reason: "commit ID only; working tree not captured" },
		after_snapshot: { ...verMut.records[1].after_snapshot, scope_kind: "unknown", complete: false, reason: "commit ID only; working tree not captured" },
	});
	atomicJson(join(run.session_dir, "a1-impl.verification.json"), verMut);
	rmSync(join(run.session_dir, "a2-verify-downstream.disposition.json"), { force: true });
	assert.equal(f.service.status(run.task_id).agents[0].verification?.[0].applicability, "unknown");

	const w2Unknown = workerFromConfig(t, join(run.session_dir, "a2-verify-downstream.config.json"));
	await w2Unknown.start();
	await w2Unknown.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-impl" }, content: `bootstrap-handoff:${run.token}:a1-impl` },
	});
	assert.equal(w2Unknown.aborts, 1);
	assert.match(readJson<any>(join(run.session_dir, "a2-verify-downstream.disposition.json")).reason, /parser-tests.*unverified/i);

	// 6) Conservative scope (omitted scope) works in non-Git projects and invalidates on any project edit; refreshing unblocks admission!
	rmSync(join(run.session_dir, "a2-verify-downstream.disposition.json"), { force: true });
	const { beginVerificationCheck, finishVerificationCheck } = await import("./verification.ts");
	const startedConservative = beginVerificationCheck(f.cwd, "parser-tests");
	const conservativePass = finishVerificationCheck(
		run.session_dir,
		{ run_id: run.task_id, node_id: "impl", persona_name: "implementer", attempt_id: "a1-impl.1", instance_id: "a1-impl" },
		startedConservative,
		{ result: "pass" },
	);
	assert.equal(conservativePass.applicability, "current");
	assert.equal(conservativePass.record.scope_kind, "conservative");

	const w2Clean = workerFromConfig(t, join(run.session_dir, "a2-verify-downstream.config.json"));
	await w2Clean.start();
	const admitted = await w2Clean.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-impl" }, content: `bootstrap-handoff:${run.token}:a1-impl` },
	});
	assert.equal(w2Clean.aborts, 0);
	assert.match(admitted.systemPrompt, /Predecessor result/);

	// 7) Worker without bash cannot run commands via bootstrap_verify({ action: "run" }).
	writeFileSync(join(f.cwd, ".pi", "agents", "nobash.md"), "---\nname: nobash\ntools: read\n---\nNo bash\n");
	const runNoBash = await f.service.generate({
		topology: "team",
		task: "No bash check",
		project_cwd: f.cwd,
		agents: [{ node_id: "reader", persona: "nobash", sub_task: "Read only" }],
	}, model);
	const wNoBash = workerFromConfig(t, join(runNoBash.session_dir, "a1-reader.config.json"), { tools: ["read", "bash", "coms_send"] });
	await wNoBash.start();
	await wNoBash.beforeStart();
	const deniedRun = await wNoBash.verify({ action: "run", check_id: "x", command: "echo hi" });
	assert.equal(deniedRun.isError, true);
	assert.match(deniedRun.content[0].text, /bash/i);

	// 8) Even when .git/HEAD commit ID is unchanged, dirty working-tree / untracked edits invalidate applicability.
	mkdirSync(join(f.cwd, ".git"), { recursive: true });
	writeFileSync(join(f.cwd, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
	await wNoBash.verify({ action: "start", check_id: "git-dirty-check", scope: ["src/"] });
	const cleanGit = await wNoBash.verify({ action: "finish", check_id: "git-dirty-check", result: "pass" });
	assert.equal(cleanGit.details.applicability, "current");
	assert.equal(cleanGit.details.record.before_snapshot.git_head, "0123456789abcdef0123456789abcdef01234567");
	writeFileSync(join(f.cwd, "src", "parser.ts"), "export const parse = (s: string) => s.trim();\n");
	const statusAfterDirty = await wNoBash.verify({ action: "status" });
	assert.equal(statusAfterDirty.details.evaluations[0].applicability, "stale");
});

test("require_artifacts and bootstrap_complete reject missing or deleted file artifacts", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "chain",
		task: "Artifact checks",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "p1", persona: "implementer", sub_task: "Require artifacts", output_contract: { require_artifacts: true } },
			{ node_id: "p2", persona: "reviewer", sub_task: "No contract, still checks declared files" },
		],
	}, model);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-p1.config.json"));
	await w1.start();
	await w1.beforeStart();

	const missingFile = await w1.complete({ status: "success", summary: "ok", detail: "ok", artifacts: [{ type: "file", path: "missing.txt", action: "created" }] });
	assert.equal(missingFile.isError, true);
	assert.match(missingFile.content[0].text, /missing/i);
	assert.equal(existsSync(join(run.session_dir, "a1-p1.result.json")), false);

	writeFileSync(join(f.cwd, "temp.txt"), "hi");
	const onlyDeleted = await w1.complete({ status: "success", summary: "ok", detail: "ok", artifacts: [{ type: "file", path: "temp.txt", action: "deleted" }] });
	assert.equal(onlyDeleted.isError, true);
	assert.match(onlyDeleted.content[0].text, /artifact/i);

	const noFilePath = await w1.complete({ status: "success", summary: "ok", detail: "ok", artifacts: [{ type: "file", action: "created" }] });
	assert.equal(noFilePath.isError, true);
	assert.match(noFilePath.content[0].text, /artifact/i);

	const w2 = workerFromConfig(t, join(run.session_dir, "a2-p2.config.json"));
	await w2.start();
	await w2.beforeStart();
	const missingWithoutContract = await w2.complete({ status: "success", summary: "ok", detail: "ok", artifacts: [{ type: "file", path: "nope.txt", action: "created" }] });
	assert.equal(missingWithoutContract.isError, true);
	assert.match(missingWithoutContract.content[0].text, /missing/i);
	assert.equal(existsSync(join(run.session_dir, "a2-p2.result.json")), false);
});

test("validateOutputContract validates non-object outputs without required fields and reports artifact blockers alongside missing outputs", async t => {
	const f = serviceFixture(t);
	const { validateOutputContract } = await import("./contracts.ts");
	const sessionDir = join(f.cwd, ".pi", "agent-sessions", "unit-vc");
	mkdirSync(sessionDir, { recursive: true });

	// Optional properties only: non-object outputs (array/primitive/null) must still be rejected.
	const optContract = { properties: { count: { type: "integer" as const } } };
	assert.ok(validateOutputContract(optContract, { agent_name: "p", status: "success", summary: "ok", detail: "ok", outputs: ["bad"] as any }, f.cwd, sessionDir).length > 0);
	assert.ok(validateOutputContract(optContract, { agent_name: "p", status: "success", summary: "ok", detail: "ok", outputs: 42 as any }, f.cwd, sessionDir).length > 0);
	assert.deepEqual(validateOutputContract(optContract, { agent_name: "p", status: "success", summary: "ok", detail: "ok" }, f.cwd, sessionDir), []);

	// Missing required outputs must not skip artifact blockers.
	const bothContract = { required_fields: ["verdict"], require_artifacts: true, required_artifact_paths: ["out/needed.txt"] };
	const blockers = validateOutputContract(bothContract, { agent_name: "p", status: "success", summary: "ok", detail: "ok" }, f.cwd, sessionDir);
	assert.ok(blockers.some(b => /outputs/i.test(b)), `expected outputs blocker in ${JSON.stringify(blockers)}`);
	assert.ok(blockers.some(b => /non-missing artifact/i.test(b)), `expected require_artifacts blocker in ${JSON.stringify(blockers)}`);
	assert.ok(blockers.some(b => /out\/needed\.txt/.test(b)), `expected required_artifact_paths blocker in ${JSON.stringify(blockers)}`);
});

test("snapshotScope matches zero intermediate directories for **/ globs", async t => {
	const f = serviceFixture(t);
	const { snapshotScope, evaluateApplicability, beginVerificationCheck, finishVerificationCheck } = await import("./verification.ts");
	mkdirSync(join(f.cwd, "src", "nested"), { recursive: true });
	writeFileSync(join(f.cwd, "root.ts"), "export const r = 1;\n");
	writeFileSync(join(f.cwd, "src", "foo.ts"), "export const a = 1;\n");
	writeFileSync(join(f.cwd, "src", "nested", "foo.ts"), "export const b = 2;\n");

	const snap = snapshotScope(f.cwd, ["src/**/foo.ts", "**/root.ts"]);
	assert.equal(snap.complete, true);
	assert.ok("src/foo.ts" in snap.files, "src/**/foo.ts must match src/foo.ts with zero intermediate directories");
	assert.ok("src/nested/foo.ts" in snap.files, "src/**/foo.ts must match src/nested/foo.ts");
	assert.ok("root.ts" in snap.files, "**/root.ts must match root.ts with zero intermediate directories");

	const started = beginVerificationCheck(f.cwd, "glob-check", ["src/**/foo.ts"]);
	const res = finishVerificationCheck(f.cwd, { run_id: "r1", node_id: "n1", persona_name: "p", attempt_id: "a1.1", instance_id: "a1" }, started, { result: "pass" });
	assert.equal(res.applicability, "current");
	writeFileSync(join(f.cwd, "src", "foo.ts"), "export const a = 2;\n");
	assert.equal(evaluateApplicability(res.record, f.cwd).applicability, "stale");
});

test("snapshotScope prunes unrelated directories so unreadable outside paths do not mark scoped checks unknown", async t => {
	const f = serviceFixture(t);
	const { chmodSync } = await import("node:fs");
	const { snapshotScope, evaluateApplicability, beginVerificationCheck, finishVerificationCheck } = await import("./verification.ts");
	mkdirSync(join(f.cwd, "src"), { recursive: true });
	writeFileSync(join(f.cwd, "src", "foo.ts"), "export const a = 1;\n");
	const secretDir = join(f.cwd, "secret-unrelated");
	mkdirSync(secretDir, { recursive: true });
	writeFileSync(join(secretDir, "hidden.txt"), "secret\n");
	chmodSync(secretDir, 0o000);
	try {
		const snapExact = snapshotScope(f.cwd, ["src/foo.ts"]);
		assert.equal(snapExact.complete, true, snapExact.reason);
		assert.equal(snapExact.scope_kind, "declared");
		assert.deepEqual(Object.keys(snapExact.files), ["src/foo.ts"]);

		const snapGlob = snapshotScope(f.cwd, ["src/**/*.ts"]);
		assert.equal(snapGlob.complete, true, snapGlob.reason);
		assert.deepEqual(Object.keys(snapGlob.files), ["src/foo.ts"]);

		const started = beginVerificationCheck(f.cwd, "scoped-check", ["src/foo.ts"]);
		const res = finishVerificationCheck(f.cwd, { run_id: "r1", node_id: "n1", persona_name: "p", attempt_id: "a1.1", instance_id: "a1" }, started, { result: "pass" });
		assert.equal(res.applicability, "current");
		assert.equal(evaluateApplicability(res.record, f.cwd).applicability, "current");
	} finally {
		chmodSync(secretDir, 0o700);
	}
});

test("readBoundedInput artifact without node_id checks the latest producer hash when multiple stages modify the same file", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "chain",
		task: "Multi-stage shared artifact",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Create file" },
			{ node_id: "n2", persona: "implementer", sub_task: "Modify file" },
			{ node_id: "n3", persona: "reviewer", sub_task: "Read shared file" },
		],
	}, model);
	mkdirSync(join(f.cwd, "src"), { recursive: true });
	const sharedPath = join(f.cwd, "src", "shared.txt");
	writeFileSync(sharedPath, "v1");
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();
	await w1.complete({ status: "success", summary: "Created", detail: "v1", artifacts: [{ type: "file", path: "src/shared.txt", action: "created" }] });

	const w2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await w2.start();
	await w2.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: `bootstrap-handoff:${run.token}:a1-n1` } });
	writeFileSync(sharedPath, "v2");
	await w2.complete({ status: "success", summary: "Modified", detail: "v2", artifacts: [{ type: "file", path: "src/shared.txt", action: "modified" }] });

	const w3 = workerFromConfig(t, join(run.session_dir, "a3-n3.config.json"));
	await w3.start();
	await w3.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a2-n2" }, content: `bootstrap-handoff:${run.token}:a2-n2` } });

	const withoutNode = await w3.readInput({ kind: "artifact", path: "src/shared.txt" });
	assert.equal(withoutNode.isError, undefined, withoutNode.content?.[0]?.text);
	assert.match(withoutNode.content[0].text, /v2/);

	const explicitOldNode = await w3.readInput({ kind: "artifact", node_id: "n1", path: "src/shared.txt" });
	assert.equal(explicitOldNode.isError, true);
	assert.match(explicitOldNode.content[0].text, /Changed content hash/);
});

test("readBoundedInput artifact skips deleted child records before resolving when producer replaces directory report/old.txt with file report", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	mkdirSync(join(f.cwd, "report"), { recursive: true });
	writeFileSync(join(f.cwd, "report", "old.txt"), "old report content\n");
	const run = await f.service.generate({
		topology: "chain",
		task: "Read replaced report artifact",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Replace report/old.txt directory with file report" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Read report artifact" },
		],
	}, model);

	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();
	rmSync(join(f.cwd, "report"), { recursive: true, force: true });
	writeFileSync(join(f.cwd, "report"), "new report content\n");
	const completed = await w1.complete({
		status: "success",
		summary: "Replaced report/old.txt with report",
		detail: "ok",
		artifacts: [
			{ type: "file", path: "report/old.txt", action: "deleted" },
			{ type: "file", path: "report", action: "created" },
		],
	});
	assert.equal(completed.isError, undefined, completed.content?.[0]?.text);
	assert.equal(completed.details.status, "saved");

	const w2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await w2.start();
	await w2.beforeStart({
		systemPrompt: "BASE",
		messageType: "custom",
		message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: `bootstrap-handoff:${run.token}:a1-n1` },
	});

	const readReport = await w2.readInput({ kind: "artifact", path: "report" });
	assert.equal(readReport.isError, undefined, readReport.content?.[0]?.text);
	assert.equal(readReport.details.text, "new report content\n");
	assert.match(readReport.content[0].text, /new report content/);

	const readReportByNode = await w2.readInput({ kind: "artifact", node_id: "n1", path: "report" });
	assert.equal(readReportByNode.isError, undefined, readReportByNode.content?.[0]?.text);
	assert.equal(readReportByNode.details.text, "new report content\n");
});

test("readBoundedInput result rejects result_path outside session_dir or through a symlink", async t => {
	const f = serviceFixture(t);
	const { symlinkSync } = await import("node:fs");
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "chain",
		task: "Containment check",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "n1", persona: "implementer", sub_task: "Step 1" },
			{ node_id: "n2", persona: "reviewer", sub_task: "Step 2" },
		],
	}, model);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();
	await w1.complete({ status: "success", summary: "ok", detail: "ok" });

	const w2 = workerFromConfig(t, join(run.session_dir, "a2-n2.config.json"));
	await w2.start();
	await w2.beforeStart({ systemPrompt: "BASE", messageType: "custom", message: { customType: "coms-inbound", details: { sender_session: "session-a1-n1" }, content: `bootstrap-handoff:${run.token}:a1-n1` } });

	const secretFile = join(f.root, "secret.json");
	writeFileSync(secretFile, readFileSync(join(run.session_dir, "a1-n1.result.json"), "utf8"));
	const idxPath = join(run.session_dir, "upstream-index.json");
	const idx = readJson<any>(idxPath);
	idx.entries[0].result_path = secretFile;
	atomicJson(idxPath, idx);
	const externalRead = await w2.readInput({ kind: "result", node_id: "n1" });
	assert.equal(externalRead.isError, true);
	assert.match(externalRead.content[0].text, /session|scope|escapes|symlink/i);

	const linkPath = join(run.session_dir, "escape-link.json");
	symlinkSync(secretFile, linkPath);
	idx.entries[0].result_path = linkPath;
	atomicJson(idxPath, idx);
	const symlinkRead = await w2.readInput({ kind: "result", node_id: "n1" });
	assert.equal(symlinkRead.isError, true);
	assert.match(symlinkRead.content[0].text, /session|scope|escapes|symlink/i);
});

test("readBoundedInput makes forward progress even when max_bytes is smaller than a multibyte UTF-8 character", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "team",
		task: "Emoji pagination",
		project_cwd: f.cwd,
		agents: [{ node_id: "n1", persona: "implementer", sub_task: "🚀" }],
	}, model);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();

	const full = await w1.readInput({ kind: "task_input" });
	const emojiOffset = Buffer.from(full.details.text, "utf8").indexOf("🚀");
	assert.ok(emojiOffset >= 0);

	// Paginating from emojiOffset with max_bytes=2 must advance past the 4-byte character instead of stalling.
	const chunk = await w1.readInput({ kind: "task_input", offset: emojiOffset, max_bytes: 2 });
	assert.equal(chunk.isError, undefined);
	assert.ok(chunk.details.next_offset > emojiOffset, `expected next_offset > ${emojiOffset}, got ${chunk.details.next_offset}`);
	assert.equal(chunk.details.text, "🚀");
});

test("input hook sub_task, output_contract brief, and peer upstream index entry 0 are bounded with truncation hints", async t => {
	const f = serviceFixture(t);
	const { formatAuthoritativeBrief, formatPeerDataSection, UPSTREAM_INDEX_MAX_BYTES, BRIEF_FIELD_MAX_BYTES } = await import("./contracts.ts");
	const model = { provider: "provider", id: "model" };
	const hugeSubTask = "Work item: " + "x".repeat(20_000);
	const hugeContract = {
		properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, { type: "string" as const, description: "d".repeat(120) }])),
	};
	const run = await f.service.generate({
		topology: "team",
		task: "Bounded prompts",
		project_cwd: f.cwd,
		agents: [{ node_id: "n1", persona: "implementer", sub_task: hugeSubTask, output_contract: hugeContract }],
	}, model);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	const inputRes = await w1.hooks.get("input")!({ text: w1.config.startup_message });
	assert.equal(inputRes.action, "transform");
	assert.ok(Buffer.byteLength(inputRes.text, "utf8") < BRIEF_FIELD_MAX_BYTES * 2 + 1024, `expected bounded input prompt, got ${Buffer.byteLength(inputRes.text, "utf8")}`);
	assert.match(inputRes.text, /Truncated/);
	assert.match(inputRes.text, /bootstrap_read_input/);

	const brief = formatAuthoritativeBrief(w1.config);
	const ocLine = brief.split("\n").find(l => l.startsWith("Required output contract:"))!;
	assert.match(ocLine, /Truncated/);
	assert.match(ocLine, /bootstrap_read_input/);

	const peer = formatPeerDataSection({
		config: { ...w1.config, instance_id: "a2-n2" },
		upstreamIndex: {
			version: 2,
			run_id: run.task_id,
			updated_at: new Date().toISOString(),
			entries: [{
				node_id: "n1",
				persona_name: "implementer",
				attempt_id: "a1-n1.1",
				instance_id: "a1-n1",
				status: "success",
				summary: "s".repeat(500),
				completed_at: new Date().toISOString(),
				result_path: join(run.session_dir, "a1-n1.result.json"),
				result_hash: "a".repeat(64),
				outputs: { big: "o".repeat(1000) },
				artifacts: Array.from({ length: 200 }, (_, i) => ({ type: "file", path: `src/file-${i}.ts`, producer_node_id: "n1", producer_attempt_id: "a1-n1.1", sha256: "b".repeat(64) })),
				verification: Array.from({ length: 100 }, (_, i) => ({ check_id: `check-${i}`, result: "pass" as const, attempt_id: "a1-n1.1", completed_at: new Date().toISOString(), scope_kind: "declared" as const, applicability: "current" as const })),
			}],
		},
	});
	assert.ok(Buffer.byteLength(peer, "utf8") <= UPSTREAM_INDEX_MAX_BYTES + 1024, `expected bounded peer section, got ${Buffer.byteLength(peer, "utf8")}`);
	assert.match(peer, /Truncated/);
	assert.match(peer, /bootstrap_read_input/);
});

test("bootstrap_verify status includes output_contract.required_checks and pre-write completion errors do not claim Result retained", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	const run = await f.service.generate({
		topology: "team",
		task: "Verify status & pre-write throw",
		project_cwd: f.cwd,
		agents: [{
			node_id: "n1",
			persona: "implementer",
			sub_task: "Check status",
			output_contract: { required_checks: ["lint"] },
		}],
	}, model);
	const w1 = workerFromConfig(t, join(run.session_dir, "a1-n1.config.json"));
	await w1.start();
	await w1.beforeStart();

	const verStatus = await w1.verify({ action: "status" });
	assert.equal(verStatus.isError, undefined);
	assert.ok(verStatus.details.blockers.some((b: string) => /lint/.test(b)), `expected lint blocker, got ${JSON.stringify(verStatus.details.blockers)}`);

	const escaping = await w1.complete({
		status: "success",
		summary: "ok",
		detail: "ok",
		artifacts: [{ type: "file", path: "../outside.txt", action: "created" }],
	});
	assert.equal(escaping.isError, true);
	assert.match(escaping.content[0].text, /^Completion failed:/);
	assert.doesNotMatch(escaping.content[0].text, /Result retained/);
	assert.equal(existsSync(join(run.session_dir, "a1-n1.result.json")), false);
});

test("standalone plan and generate accept an existing ordinary directory that the node replaces before completing the required file", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	mkdirSync(join(f.cwd, "report"));
	const request: GenerateRequest = {
		topology: "team",
		task: "Replace directory with required file",
		project_cwd: f.cwd,
		agents: [{
			node_id: "n1",
			persona: "implementer",
			sub_task: "Remove empty report/ and write regular file report",
			output_contract: { required_artifact_paths: ["report"] },
		}],
	};

	for (const directoryOnly of [".", ".pi", ".pi/agent-sessions"]) {
		const bad: GenerateRequest = { ...request, agents: [{ ...request.agents[0], output_contract: { required_artifact_paths: [directoryOnly] } }] };
		assert.throws(() => f.service.plan(bad, model), /required_artifact_paths.*must be files/i);
		await assert.rejects(f.service.generate(bad, model), /required_artifact_paths.*must be files/i);
	}
	for (const escaping of ["../outside.txt", "/[report].json"]) {
		const bad: GenerateRequest = { ...request, agents: [{ ...request.agents[0], output_contract: { required_artifact_paths: [escaping] } }] };
		assert.throws(() => f.service.plan(bad, model), /required_artifact_paths.*escapes project\/session scope/i);
		await assert.rejects(f.service.generate(bad, model), /required_artifact_paths.*escapes project\/session scope/i);
	}

	const preview = f.service.plan(request, model);
	assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, ["report"]);
	const run = await f.service.generate(request, model);
	const w1 = workerFromConfig(t, join(run.session_dir, `${run.pane_manifest[0].instance_id}.config.json`));
	await w1.start();
	await w1.beforeStart();

	const stillDir = await w1.complete({
		status: "success",
		summary: "Still a directory",
		detail: "not replaced yet",
		artifacts: [{ type: "file", path: "report", action: "created" }],
	});
	assert.equal(stillDir.isError, true);

	rmdirSync(join(f.cwd, "report"));
	writeFileSync(join(f.cwd, "report"), "regular file content\n");
	const saved = await w1.complete({
		status: "success",
		summary: "Replaced directory with file",
		detail: "ok",
		artifacts: [{ type: "file", path: "report", action: "created" }],
	});
	assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
	assert.equal(saved.details.status, "saved");
});

test("standalone worker requiring report saves result when replacing directory report/old.txt with regular file report and reporting deleted child first", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	mkdirSync(join(f.cwd, "report"), { recursive: true });
	writeFileSync(join(f.cwd, "report", "old.txt"), "old report content\n");
	const request: GenerateRequest = {
		topology: "team",
		task: "Replace non-empty directory with required file",
		project_cwd: f.cwd,
		agents: [{
			node_id: "n1",
			persona: "implementer",
			sub_task: "Remove report/old.txt and write regular file report",
			output_contract: { required_artifact_paths: ["report"] },
		}],
	};

	const preview = f.service.plan(request, model);
	assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, ["report"]);
	const run = await f.service.generate(request, model);
	const w1 = workerFromConfig(t, join(run.session_dir, `${run.pane_manifest[0].instance_id}.config.json`));
	await w1.start();
	await w1.beforeStart();

	rmSync(join(f.cwd, "report"), { recursive: true, force: true });
	writeFileSync(join(f.cwd, "report"), "regular file content\n");
	const saved = await w1.complete({
		status: "success",
		summary: "Replaced directory report/old.txt with file report",
		detail: "ok",
		artifacts: [
			{ type: "file", path: "report/old.txt", action: "deleted" },
			{ type: "file", path: "report", action: "created" },
		],
	});
	assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
	assert.equal(saved.details.status, "saved");
	assert.equal(existsSync(join(run.session_dir, `${run.pane_manifest[0].instance_id}.result.json`)), true);
});

test("standalone plan and generate accept an existing ordinary regular-file ancestor replaced with a directory before completion", async t => {
	const f = serviceFixture(t);
	const model = { provider: "provider", id: "model" };
	writeFileSync(join(f.cwd, "report"), "ordinary regular file\n");
	writeFileSync(join(f.root, "outside-file"), "outside regular file\n");
	symlinkSync(join(f.root, "outside-file"), join(f.cwd, "outside-link"));

	const request: GenerateRequest = {
		topology: "team",
		task: "Replace regular file with directory and write required file",
		project_cwd: f.cwd,
		request_id: "replace-regular-file",
		agents: [{
			node_id: "n1",
			persona: "implementer",
			sub_task: "Replace regular file report with directory report/ and write report/summary.txt",
			output_contract: { required_artifact_paths: ["report/summary.txt"] },
		}],
	};

	for (const badPath of ["../outside-file/summary.txt", "../outside-file/../project/summary.txt", "outside-link/summary.txt"]) {
		const bad: GenerateRequest = { ...request, request_id: undefined, agents: [{ ...request.agents[0], output_contract: { required_artifact_paths: [badPath] } }] };
		assert.throws(() => f.service.plan(bad, model), /required_artifact_paths/i);
		await assert.rejects(f.service.generate(bad, model), /required_artifact_paths/i);
	}

	const sessionsFile = join(f.cwd, ".pi", "agent-sessions");
	writeFileSync(sessionsFile, "not a directory\n");
	try {
		const managedBad: GenerateRequest = { ...request, request_id: undefined, agents: [{ ...request.agents[0], output_contract: { required_artifact_paths: [".pi/agent-sessions/summary.txt"] } }] };
		assert.throws(() => f.service.plan(managedBad, model), /required_artifact_paths/i);
		await assert.rejects(f.service.generate(managedBad, model), /required_artifact_paths/i);
	} finally {
		rmSync(sessionsFile);
	}

	const preview = f.service.plan(request, model);
	assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, ["report/summary.txt"]);
	const run = await f.service.generate(request, model);
	const w1 = workerFromConfig(t, join(run.session_dir, `${run.pane_manifest[0].instance_id}.config.json`));
	await w1.start();
	await w1.beforeStart();

	const stillFile = await w1.complete({
		status: "success",
		summary: "Still a regular file",
		detail: "not replaced yet",
		artifacts: [{ type: "file", path: "report/summary.txt", action: "created" }],
	});
	assert.equal(stillFile.isError, true);

	const missingArtifacts = await w1.complete({
		status: "success",
		summary: "Still a regular file without artifacts",
		detail: "not replaced yet",
	});
	assert.equal(missingArtifacts.isError, true);

	rmSync(join(f.cwd, "report"));
	mkdirSync(join(f.cwd, "report"));
	writeFileSync(join(f.cwd, "report", "summary.txt"), "summary content\n");

	const replay = await f.service.generate(request, model);
	assert.equal(replay.task_id, run.task_id);

	const saved = await w1.complete({
		status: "success",
		summary: "Replaced file with directory and wrote summary",
		detail: "ok",
		artifacts: [{ type: "file", path: "report/summary.txt", action: "created" }],
	});
	assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
	assert.equal(saved.details.status, "saved");
});
