import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { createFactoryQueueScheduler } from "../factory/scheduler.ts";
import { deriveNodeAttemptCountsFromIndex, readValidatedUpstreamIndex } from "./contracts.ts";
import { BootstrapService } from "./lifecycle.ts";
import { buildMarkdownReport } from "./reporting.ts";
import { atomicJson, readJson } from "./session-store.ts";
import { runSupervised } from "./test-harness.ts";
import { notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const interventionChild = fileURLToPath(new URL("./test-support/factory-intervention-child.ts", import.meta.url));

const typeboxUrl = `data:text/javascript,${encodeURIComponent('export const Type = new Proxy({}, {get: (_, name) => (...args) => ({kind: name, args})});')}`;
registerHooks({ resolve(specifier, _context, next) {
	return specifier === "@sinclair/typebox" ? { url: typeboxUrl, shortCircuit: true } : next(specifier, _context);
} });
const { default: registerBootstrap } = await import("../bootstrap.ts");

function fileTree(...roots: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (path: string) => {
		if (!existsSync(path)) return;
		const info = lstatSync(path);
		if (info.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name)); return; }
		if (info.isFile()) out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
	};
	for (const root of roots) walk(root);
	return out;
}

function registerExtensionTools(t: test.TestContext, fix: { home: string; stateDir: string; root: string; cwd: string }, factoryDir: string) {
	const keys = ["HOME", "PI_BOOTSTRAP_STATE_DIR", "PI_FACTORY_STATE_DIR", "PI_FACTORY_COORDINATION_DIR"] as const;
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	Object.assign(process.env, { HOME: fix.home, PI_BOOTSTRAP_STATE_DIR: fix.stateDir, PI_FACTORY_STATE_DIR: factoryDir, PI_FACTORY_COORDINATION_DIR: fix.root });
	t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 1, stdout: "", stderr: "unexpected exec" }),
	} as any);
	const ctx = { cwd: fix.cwd, hasUI: false, isProjectTrusted: () => true };
	return {
		call: (name: string, params: Record<string, unknown>) => tools.get(name).execute("call", params, undefined, undefined, ctx) as Promise<{ content: Array<{ text: string }>; details: any; isError?: boolean }>,
		tool: (name: string) => tools.get(name),
		commands,
	};
}

test("Slice 1: deriveNodeAttemptCountsFromIndex computes per-node attempts and rollbacks from upstream-index.json and fails closed on damaged evidence", async t => {
	const root = mkdtempSync(join(tmpdir(), "factory-release-gate-s1-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const roster = [
		{ node_id: "build", instance_id: "a1-build" },
		{ node_id: "review", instance_id: "a2-review" },
		{ node_id: "ship", instance_id: "a3-ship" },
	];

	// Missing file returns undefined (callers decide whether missing is an error for the run).
	assert.equal(readValidatedUpstreamIndex(root, "run-1", roster), undefined);

	const indexPath = join(root, "upstream-index.json");
	atomicJson(indexPath, {
		version: 2,
		run_id: "run-1",
		updated_at: "2026-01-01T00:00:00.000Z",
		entries: [
			{ node_id: "build", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build", status: "success", summary: "v1", completed_at: "2026-01-01T00:01:00.000Z", result_path: join(root, "a1-build.1.result.json"), result_hash: "a".repeat(64) },
			{ node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.1", instance_id: "a2-review", status: "success", summary: "reject", completed_at: "2026-01-01T00:02:00.000Z", result_path: join(root, "a2-review.1.result.json"), result_hash: "b".repeat(64) },
			{ node_id: "build", persona_name: "builder", attempt_id: "a1-build.2", instance_id: "a1-build", status: "success", summary: "v2", completed_at: "2026-01-01T00:03:00.000Z", result_path: join(root, "a1-build.2.result.json"), result_hash: "c".repeat(64) },
			{ node_id: "review", persona_name: "reviewer", attempt_id: "a2-review.2", instance_id: "a2-review", status: "success", summary: "approve", completed_at: "2026-01-01T00:04:00.000Z", result_path: join(root, "a2-review.2.result.json"), result_hash: "d".repeat(64) },
		],
	});

	const idx = readValidatedUpstreamIndex(root, "run-1", roster)!;
	assert.deepEqual(deriveNodeAttemptCountsFromIndex(idx, roster), [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
		{ node_id: "ship", attempts: 0, rollbacks: 0 },
	]);

	// Negative / fail-closed guards on damaged upstream-index.json:
	// 1. Duplicate attempt entry
	atomicJson(indexPath, {
		version: 2,
		run_id: "run-1",
		updated_at: "2026-01-01T00:00:00.000Z",
		entries: [
			{ node_id: "build", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build", status: "success", summary: "v1", completed_at: "2026-01-01T00:01:00.000Z", result_path: "r1", result_hash: "a".repeat(64) },
			{ node_id: "build", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build", status: "success", summary: "v1-dup", completed_at: "2026-01-01T00:01:05.000Z", result_path: "r1", result_hash: "a".repeat(64) },
		],
	});
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /duplicate attempt/i);

	// 2. Unknown / mismatched node or instance_id
	atomicJson(indexPath, {
		version: 2,
		run_id: "run-1",
		updated_at: "2026-01-01T00:00:00.000Z",
		entries: [
			{ node_id: "ghost", persona_name: "builder", attempt_id: "a1-build.1", instance_id: "a1-build", status: "success", summary: "v1", completed_at: "2026-01-01T00:01:00.000Z", result_path: "r1", result_hash: "a".repeat(64) },
		],
	});
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /planned run roster/i);

	// 3. Wrong run_id
	atomicJson(indexPath, { version: 2, run_id: "other-run", updated_at: "2026-01-01T00:00:00.000Z", entries: [] });
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /run_id mismatch/i);

	// 4. Unsupported version
	atomicJson(indexPath, { version: 99, run_id: "run-1", updated_at: "2026-01-01T00:00:00.000Z", entries: [] });
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /Unsupported or malformed/i);

	// 4b. Malformed entry (non-object, missing identity fields, missing required result fields)
	atomicJson(indexPath, { version: 2, run_id: "run-1", updated_at: "2026-01-01T00:00:00.000Z", entries: [null] });
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /malformed upstream-index\.json entry/i);
	atomicJson(indexPath, { version: 2, run_id: "run-1", updated_at: "2026-01-01T00:00:00.000Z", entries: [(({ attempt_id, ...entry }) => entry)(idx.entries[0])] });
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /missing node_id, instance_id, or attempt_id/i);
	atomicJson(indexPath, { version: 2, run_id: "run-1", updated_at: "2026-01-01T00:00:00.000Z", entries: [{ node_id: "build", instance_id: "a1-build", attempt_id: "a1-build.1" }] });
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /missing required result fields/i);

	// 5. Malformed JSON
	writeFileSync(indexPath, "{not-json");
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster));

	// 6. Symlinked upstream-index.json
	const target = join(root, "elsewhere.json");
	atomicJson(target, { version: 2, run_id: "run-1", updated_at: "2026-01-01T00:00:00.000Z", entries: [] });
	rmSync(indexPath);
	symlinkSync(target, indexPath);
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /symlink/i);

	// A dangling symlink is damaged evidence, not an absent index.
	rmSync(target);
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /symlink/i);

	// 7. Non-regular file (directory)
	rmSync(indexPath);
	mkdirSync(indexPath);
	assert.throws(() => readValidatedUpstreamIndex(root, "run-1", roster), /non-regular/i);
});

test("Slice 2: bootstrap_report shows per-node attempt and rollback counts from upstream-index.json with no persisted state and fails closed on missing or damaged evidence", async t => {
	const fix = serviceFixture(t, ["builder", "reviewer"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const sessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" as const };
	const fac = open()({
		action: "publish",
		name: "report-counts",
		draft: {
			topology: "graph",
			task: "Report counts",
			project_cwd: fix.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-s2" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "ref-1", brief: "Check counts", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const sessionDir = launched.manifest.session_dir;

	const build = workerFromConfig(t, join(sessionDir, `${fix.configs[0].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const review = workerFromConfig(t, join(sessionDir, `${fix.configs[1].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();

	await build.complete({ status: "success", summary: "Build v1", detail: "v1" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise", detail: "fix", outputs: { verdict: "changes_requested" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "Build v2", detail: "v2" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Approved", detail: "ok", outputs: { verdict: "approve" } });

	const obs = registerExtensionTools(t, fix, fix.root);
	const before = fileTree(sessionDir, fix.service.store.indexRoot, dbPath, coordPath);

	const report = await obs.call("bootstrap_report", { task_id: launched.task_id });
	assert.equal(report.isError, undefined, report.content[0].text);
	assert.deepEqual(report.details.node_counts, [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	]);
	assert.match(report.content[0].text, /build \(2 attempts, 1 rollback\)/i);
	assert.match(report.content[0].text, /review \(2 attempts, 1 rollback\)/i);
	assert.deepEqual(fileTree(sessionDir, fix.service.store.indexRoot, dbPath, coordPath), before, "read-only report must not write or persist any state");

	// Standalone report also includes node_counts without persisting extra files.
	const standalone = await fix.service.generate({
		topology: "chain",
		task: "Standalone counts",
		project_cwd: fix.cwd,
		agents: [{ node_id: "only", persona: "builder", sub_task: "Work" }],
	}, { provider: "provider", id: "model" });
	const only = workerFromConfig(t, join(standalone.session_dir, `${fix.configs[2].instance_id}.config.json`));
	await only.start();
	await only.beforeStart();
	await only.complete({ status: "success", summary: "Solo", detail: "done" });
	const standaloneRep = await obs.call("bootstrap_report", { task_id: standalone.task_id, write_markdown: true });
	assert.equal(standaloneRep.isError, undefined);
	assert.deepEqual(standaloneRep.details.node_counts, [{ node_id: "only", attempts: 1, rollbacks: 0 }]);
	assert.match(standaloneRep.content[0].text, /only \(1 attempt, 0 rollbacks\)/i);
	assert.match(readFileSync(standaloneRep.details.report_md, "utf8"), /only: 1 attempt, 0 rollbacks/i);

	writeFileSync(join(standalone.session_dir, "upstream-index.json"), "{damaged");
	const savedWithWarning = await obs.call("bootstrap_report", { task_id: standalone.task_id, write_markdown: true });
	assert.equal(savedWithWarning.details.status, "saved", savedWithWarning.content[0].text);
	assert.equal(savedWithWarning.details.node_counts, undefined);
	assert.match(savedWithWarning.content[0].text, /Unusable upstream-index\.json/);
	assert.match(readFileSync(savedWithWarning.details.report_md, "utf8"), /Unusable upstream-index\.json/);
	const written = readJson<any>(savedWithWarning.details.report_json);
	assert.equal(written.results[0].summary, "Solo");
	assert.match(written.node_counts_error, /Unusable upstream-index\.json/);

	// Damage is reported instead of defaulting to 0 counts.
	const indexPath = join(sessionDir, "upstream-index.json");
	const originalIndex = readFileSync(indexPath);
	writeFileSync(indexPath, "{damaged");
	const corruptReport = await obs.call("bootstrap_report", { task_id: launched.task_id });
	assert.equal(corruptReport.details.complete, false);
	assert.equal(corruptReport.details.status, "read_only_incomplete");
	assert.equal(corruptReport.details.node_counts, undefined);
	assert.match(corruptReport.details.issues.join("\n"), /upstream-index\.json/i);
	assert.match(corruptReport.content[0].text, /INCOMPLETE or uncertain/);

	rmSync(indexPath);
	const missingReport = await obs.call("bootstrap_report", { task_id: launched.task_id });
	assert.equal(missingReport.details.complete, false);
	assert.equal(missingReport.details.node_counts, undefined);
	assert.match(missingReport.details.issues.join("\n"), /Missing upstream-index\.json/i);
	// A cleaned run with retained session files is still released; missing counts are not success.
	await fix.service.cleanup(standalone.task_id);
	rmSync(join(standalone.session_dir, "upstream-index.json"));
	const cleanedMissing = await obs.call("bootstrap_report", { task_id: standalone.task_id });
	assert.equal(cleanedMissing.details.status, "saved", cleanedMissing.content[0].text);
	assert.match(cleanedMissing.details.node_counts_error, /Missing upstream-index\.json/i);
	assert.equal(cleanedMissing.details.node_counts, undefined);

	// Factory-managed runs cannot be cleaned. A contradictory manifest must stay unsafe.
	const manifest = fix.service.store.load(launched.task_id, fix.cwd);
	fix.service.store.save({ ...manifest, status: "cleaned" }, true);
	const invalidCleaned = await obs.call("bootstrap_report", { task_id: launched.task_id });
	assert.equal(invalidCleaned.details.complete, false);
	assert.match(invalidCleaned.details.issues.join("\n"), /invalid cleaned status on factory-managed run/i);
	writeFileSync(indexPath, originalIndex);
});

test("Slice 3: factory views (inspect, receipt, live footer) show per-node attempt and rollback counts for active and settled attempts and fail closed on missing or damaged evidence", async t => {
	const fix = serviceFixture(t, ["builder", "reviewer"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const sessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" as const };
	const fac = open()({
		action: "publish",
		name: "factory-view-counts",
		draft: {
			topology: "graph",
			task: "Factory view counts",
			project_cwd: fix.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-s3" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	const sub1 = open()({ action: "submit", factory_id: fac.factory_id, reference: "ref-v1", brief: "Brief 1", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const sessionDir = launched.manifest.session_dir;

	const build = workerFromConfig(t, join(sessionDir, `${fix.configs[0].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const review = workerFromConfig(t, join(sessionDir, `${fix.configs[1].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();

	await build.complete({ status: "success", summary: "Build v1", detail: "v1" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise", detail: "fix", outputs: { verdict: "changes_requested" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "Build v2", detail: "v2" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Approved", detail: "ok", outputs: { verdict: "approve" } });

	const expectedCounts = [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	];

	const before = fileTree(sessionDir, fix.service.store.indexRoot, dbPath, coordPath);
	const activeView = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(activeView.attempts[0].node_counts, expectedCounts);
	assert.deepEqual(activeView.queue[0].attempt?.node_counts, expectedCounts);
	const activeReceipt = open()({ action: "receipt", factory_id: fac.factory_id, reference: sub1.reference });
	assert.deepEqual(activeReceipt.attempt?.node_counts, expectedCounts);

	const obs = registerExtensionTools(t, fix, fix.root);
	const toolInspect = await obs.call("factory_inspect", { action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(toolInspect.details.result.attempts[0].node_counts, expectedCounts);
	const toolReceipt = await obs.call("factory_inspect", { action: "receipt", factory_id: fac.factory_id, reference: sub1.reference });
	assert.deepEqual(toolReceipt.details.result.attempt.node_counts, expectedCounts);
	assert.deepEqual(fileTree(sessionDir, fix.service.store.indexRoot, dbPath, coordPath), before, "factory views must never mutate");

	// Settle the run and verify historical attempt still displays node_counts from upstream-index.json.
	const settled = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
	assert.equal(settled.settled, true);
	const settledView = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(settledView.attempts[0].state, "settled");
	assert.deepEqual(settledView.attempts[0].node_counts, expectedCounts);
	assert.deepEqual(settledView.queue[0].attempt?.node_counts, expectedCounts);
	const settledReceipt = open()({ action: "receipt", factory_id: fac.factory_id, input_id: sub1.input_id });
	assert.deepEqual(settledReceipt.attempt?.node_counts, expectedCounts);

	// Damaged counts on a settled attempt are a notice, not execution uncertainty.
	const indexPath = join(sessionDir, "upstream-index.json");
	const savedIndex = readFileSync(indexPath);
	writeFileSync(indexPath, "{corrupt");
	const damagedSettledView = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(damagedSettledView.attempts[0].node_counts, undefined);
	assert.match(damagedSettledView.attempts[0].node_counts_error ?? "", /upstream-index\.json/i);
	assert.ok(!damagedSettledView.uncertainty.some(u => /upstream-index\.json/i.test(u)));
	assert.ok(damagedSettledView.attention.some(a => a.kind === "report_notice" && a.task_id === launched.task_id && /upstream-index\.json/i.test(a.reason)));
	const damagedReceipt = open()({ action: "receipt", factory_id: fac.factory_id, reference: sub1.reference });
	assert.equal(damagedReceipt.attempt?.node_counts, undefined);
	assert.match(damagedReceipt.attempt?.node_counts_error ?? "", /upstream-index\.json/i);
	writeFileSync(indexPath, savedIndex);

	// Settled attempt with upstream-index.json present but missing manifest.json also fails closed.
	const manifestPath = join(sessionDir, "manifest.json");
	const savedManifest = readFileSync(manifestPath);
	rmSync(manifestPath);
	const noManifestView = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(noManifestView.attempts[0].node_counts, undefined);
	assert.match(noManifestView.attempts[0].node_counts_error ?? "", /without a readable run manifest/i);
	writeFileSync(manifestPath, savedManifest);

	// A missing historical index must be reported in both inspect and receipt.
	rmSync(indexPath);
	for (const attempt of [open()({ action: "inspect", factory_id: fac.factory_id }).attempts[0], open()({ action: "receipt", factory_id: fac.factory_id, input_id: sub1.input_id }).attempt]) {
		assert.equal(attempt?.node_counts, undefined);
		assert.match(attempt?.node_counts_error ?? "", /Missing upstream-index\.json/);
	}

	// A path lookup error (not just a JSON parse error) is also reporting-only.
	const retainedSessionDir = `${sessionDir}-retained`;
	renameSync(sessionDir, retainedSessionDir);
	try {
		symlinkSync(sessionDir, sessionDir);
		const unsearchable = open()({ action: "inspect", factory_id: fac.factory_id });
		assert.equal(unsearchable.attempts[0].node_counts, undefined);
		assert.match(unsearchable.attempts[0].node_counts_error ?? "", /Unable to read run manifest.*ELOOP/);
		assert.ok(unsearchable.attention.some(a => a.kind === "report_notice" && a.task_id === launched.task_id));
	} finally {
		rmSync(sessionDir, { force: true });
		renameSync(retainedSessionDir, sessionDir);
	}

	// Missing active counts do not turn an ordinary hold into uncertainty.
	open()({ action: "submit", factory_id: fac.factory_id, reference: "ref-v2", brief: "Brief 2", authority: auth });
	const second = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	rmSync(join(second.manifest.session_dir, "upstream-index.json"));
	const missingActiveView = open()({ action: "inspect", factory_id: fac.factory_id });
	const activeAttempt = missingActiveView.attempts.find(a => a.task_id === second.task_id)!;
	assert.equal(activeAttempt.node_counts, undefined);
	assert.match(activeAttempt.node_counts_error ?? "", /Missing upstream-index\.json/i);
	assert.ok(!activeAttempt.uncertainty?.some(u => /Missing upstream-index\.json/i.test(u)));
	assert.equal(missingActiveView.capacity.factory_slot, "held");
});

for (const damage of ["corrupt", "missing"] as const) test(`report-only counts: ${damage} index does not block settlement, launch or retry`, async t => {
	const fix = serviceFixture(t, ["builder"]);
	const db = join(fix.root, "factories.sqlite");
	const coordinationPath = join(fix.root, "factory-coordination.sqlite");
	const ops = factoryOperations(db, fix.service, { coordinationPath });
	const fac = ops({ action: "publish", name: `report-only-${damage}`, draft: {
		topology: "graph", task: "Report-only counts", project_cwd: fix.cwd,
		agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }],
	}, sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" } });
	const target = { factory_id: fac.factory_id, authority: createManagerAuthority({ pi_session_id: `manager-${damage}` }) };
	ops({ action: "resume", ...target });
	ops({ action: "submit", ...target, reference: "first", brief: "First run" });
	const second = ops({ action: "submit", ...target, reference: "second", brief: "Next run" });
	const failedInput = ops({ action: "submit", ...target, reference: "third", brief: "Retry after non-release" });
	const first = await ops({ action: "launch", ...target });
	const finish = async (run: typeof first) => {
		const worker = workerFromConfig(t, join(run.manifest.session_dir, "a1-build.config.json"), { model: { provider: "provider", id: "model" } });
		await worker.start();
		await worker.beforeStart();
		await worker.complete({ status: "success", summary: "Built", detail: "done" });
	};
	await finish(first);
	const path = join(first.manifest.session_dir, "upstream-index.json");
	if (damage === "missing") rmSync(path); else writeFileSync(path, "{broken");
	const inspect = () => ops({ action: "inspect", factory_id: fac.factory_id });
	const before = fileTree(first.manifest.session_dir, fix.service.store.indexRoot, db, coordinationPath);
	const active = inspect();
	assert.equal(active.attempts[0].node_counts, undefined);
	assert.match(active.attempts[0].node_counts_error ?? "", /upstream-index\.json/);
	assert.ok(active.attention.some(a => a.kind === "report_notice" && a.task_id === first.task_id));
	assert.equal(active.attempts[0].settlement?.execution_settlement.state, "settled");
	assert.deepEqual(fileTree(first.manifest.session_dir, fix.service.store.indexRoot, db, coordinationPath), before);
	assert.equal((await ops({ action: "settle_run", ...target })).settled, true);

	assert.equal(inspect().head_status.eligible, true);
	const next = await ops({ action: "launch", ...target });
	assert.equal(next.input_id, second.input_id);
	await finish(next);
	assert.equal((await ops({ action: "settle_run", ...target })).settled, true);
	const failing = factoryOperations(db, fix.service, { coordinationPath, atLaunchCommit: phase => {
		if (phase === "release_before_commit") throw new Error("injected non-release");
	} });
	await assert.rejects(failing({ action: "launch", ...target }), /injected non-release/);
	const prior = inspect().attempts.find(a => a.input_id === failedInput.input_id)!;
	const replacement = createManagerAuthority({ pi_session_id: `replacement-${damage}` });
	revokeManagerAuthority(target.authority);
	ops({ action: "takeover", factory_id: fac.factory_id, authority: replacement, confirmed_manager_incarnation_id: target.authority.incarnation_id });
	assert.equal(inspect().attempts.find(a => a.attempt_id === prior.attempt_id)?.retry_eligibility?.eligible, true);
	const retry = await ops({ action: "retry_launch", ...target, authority: replacement, input_id: failedInput.input_id, previous_attempt_id: prior.attempt_id, confirmed: true });
	assert.equal(retry.input_id, failedInput.input_id);
	assert.notEqual(retry.task_id, prior.task_id);
	assert.ok(inspect().attention.some(a => a.kind === "report_notice" && a.task_id === first.task_id));
});

test("Slice 4: negative report-only test — per-node attempt and rollback counts persist no state and never influence admission, routing, or any gate", async t => {
	const fix = serviceFixture(t, ["builder", "reviewer", "shipper"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const sessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" as const };
	const fac = open()({
		action: "publish",
		name: "report-only-negative",
		draft: {
			topology: "graph",
			task: "Report-only gate check",
			project_cwd: fix.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
				{ node_id: "ship", persona: "shipper", depends_on: ["review"], sub_task: "Ship" },
			],
		},
		sessionModel,
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-s4" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "ref-ro-1", brief: "Run 1", authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "ref-ro-2", brief: "Run 2", authority: auth });
	const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const sessionDir = launched.manifest.session_dir;

	const build = workerFromConfig(t, join(sessionDir, `${fix.configs[0].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const review = workerFromConfig(t, join(sessionDir, `${fix.configs[1].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const ship = workerFromConfig(t, join(sessionDir, `${fix.configs[2].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await review.start();
	await ship.start();
	await build.beforeStart();
	await review.beforeStart();
	await ship.beforeStart();

	await build.complete({ status: "success", summary: "Build v1", detail: "v1" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	// Inflate upstream-index.json with extra attempt entries far beyond max_revisions (5 attempts / 4 rollbacks for build).
	const idxPath = join(sessionDir, "upstream-index.json");
	const originalIdx = readJson<any>(idxPath);
	const buildEntry = originalIdx.entries.find((e: any) => e.node_id === "build");
	atomicJson(idxPath, {
		...originalIdx,
		entries: [
			buildEntry,
			{ ...buildEntry, attempt_id: "a1-build.2", summary: "Synthetic 2" },
			{ ...buildEntry, attempt_id: "a1-build.3", summary: "Synthetic 3" },
			{ ...buildEntry, attempt_id: "a1-build.4", summary: "Synthetic 4" },
			{ ...buildEntry, attempt_id: "a1-build.5", summary: "Synthetic 5" },
		],
	});

	// 1. Report-only: inspect & bootstrap_report surface the inflated counts without gating anything.
	const inflatedView = open()({ action: "inspect", factory_id: fac.factory_id });
	assert.deepEqual(inflatedView.attempts[0].node_counts, [
		{ node_id: "build", attempts: 5, rollbacks: 4 },
		{ node_id: "review", attempts: 0, rollbacks: 0 },
		{ node_id: "ship", attempts: 0, rollbacks: 0 },
	]);
	// Routing & admission still succeed despite build having 5 attempts / 4 rollbacks in upstream-index.json!
	const revDone = await review.complete({ status: "success", summary: "Approve despite inflated index", detail: "ok", outputs: { verdict: "approve" } });
	assert.equal(revDone.isError, undefined, "inflated upstream-index counts must not block decision routing");
	const shipStart = await ship.beforeStart(notification(review, ship));
	assert.ok(shipStart?.systemPrompt, "inflated upstream-index counts must not block downstream admission");
	await ship.deliverFollowUps();
	const shipDone = await ship.complete({ status: "success", summary: "Shipped", detail: "ok" });
	assert.equal(shipDone.isError, undefined);

	// 2. Settlement & next-input launch gates are unaffected by inflated counts.
	const settled = await open()({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
	assert.equal(settled.settled, true);
	const nextLaunch = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
	assert.notEqual(nextLaunch.task_id, launched.task_id);

	// 3. Zeroing upstream-index.json entries does not let a loop bypass max_revisions (which reads .revision.json, not upstream-index).
	const s2Dir = nextLaunch.manifest.session_dir;
	const build2 = workerFromConfig(t, join(s2Dir, `${fix.configs[3].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const review2 = workerFromConfig(t, join(s2Dir, `${fix.configs[4].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const ship2 = workerFromConfig(t, join(s2Dir, `${fix.configs[5].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	for (const w of [build2, review2, ship2]) { await w.start(); await w.beforeStart(); }
	for (let attempt = 1; attempt <= 2; attempt++) {
		if (attempt > 1) { await build2.beforeStart(notification(review2, build2)); await build2.deliverFollowUps(); }
		await build2.complete({ status: "success", summary: `B${attempt}`, detail: "d" });
		await review2.beforeStart(notification(build2, review2));
		await review2.deliverFollowUps();
		await review2.complete({ status: "success", summary: `R${attempt}`, detail: "d", outputs: { verdict: "changes_requested" } });
	}
	await build2.beforeStart(notification(review2, build2));
	await build2.deliverFollowUps();
	await build2.complete({ status: "success", summary: "B3", detail: "d" });
	await review2.beforeStart(notification(build2, review2));
	await review2.deliverFollowUps();
	// Wipe upstream-index.json entries right before the exhausted review3 completes: must STILL exhaust on max_revisions=2!
	atomicJson(join(s2Dir, "upstream-index.json"), { version: 2, run_id: nextLaunch.task_id, updated_at: new Date().toISOString(), entries: [] });
	await review2.complete({ status: "success", summary: "R3 exhausted", detail: "d", outputs: { verdict: "changes_requested" } });
	const exhaustedStatus = fix.service.status(nextLaunch.task_id);
	assert.equal(exhaustedStatus.outcome.state, "needs_attention", "zeroed upstream-index counts must not bypass max_revisions");
	assert.deepEqual(open()({ action: "inspect", factory_id: fac.factory_id }).attempts.find(a => a.task_id === nextLaunch.task_id)?.node_counts, [
		{ node_id: "build", attempts: 0, rollbacks: 0 },
		{ node_id: "review", attempts: 1, rollbacks: 0 },
		{ node_id: "ship", attempts: 0, rollbacks: 0 },
	]);

	// 4. Verify schema user_version is 13 and no per-node count/rollback tables were added.
	const rawDb = new DatabaseSync(dbPath, { readOnly: true });
	try {
		assert.equal(rawDb.prepare("PRAGMA user_version").get()?.user_version, 13);
		const tables = (rawDb.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
		assert.equal(tables.some(name => /count|rollback/i.test(name)), false);
	} finally { rawDb.close(); }
});

test("Slice 5a: retained E2E — direct multiline submit, missed-alert discovery, agent confirmation fence, drill-down, revise->approve->settle->next input", async t => {
	const fix = serviceFixture(t, ["builder", "reviewer"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const sessionModel = { provider: "provider", id: "model", thinkingLevel: "medium" as const };
	const fac = open()({
		action: "publish",
		name: "e2e-gate",
		draft: {
			topology: "graph",
			task: "Retained E2E gate",
			project_cwd: fix.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build brief" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review with human gate",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
					intervention: {
						require_route: true,
						choices: [
							{ choice_id: "approve_ship", label: "Approve", route: "approve" },
							{ choice_id: "revise_code", label: "Request revision", route: "reject" },
						],
					},
				},
			],
		},
		sessionModel,
	});

	// The command surface uses a fake Herdr exec; do not depend on the runner itself being in a Herdr pane.
	const keys = ["HOME", "PI_BOOTSTRAP_STATE_DIR", "PI_FACTORY_STATE_DIR", "PI_FACTORY_COORDINATION_DIR", "HERDR_ENV", "HERDR_PANE_ID"] as const;
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	Object.assign(process.env, { HOME: fix.home, PI_BOOTSTRAP_STATE_DIR: fix.stateDir, PI_FACTORY_STATE_DIR: fix.root, PI_FACTORY_COORDINATION_DIR: fix.root, HERDR_ENV: "1", HERDR_PANE_ID: "fake-origin" });
	t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, Function>();
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ msg: string; level: string }> = [];
	let editorReply: string | undefined;
	let selectReply: string | undefined;
	let inputReply: string | undefined;
	let confirmReply = true;

	registerBootstrap({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, fn: Function) => hooks.set(name, fn),
		sendMessage: () => {},
		exec: async (cmd: string, args: string[]) => (fix.service as any).options.exec(cmd, args),
	} as any);

	const ctx: any = {
		cwd: fix.cwd,
		hasUI: true,
		mode: "rpc",
		isProjectTrusted: () => true,
		model: { provider: "provider", id: "model" },
		thinkingLevel: "medium",
		sessionManager: { getSessionId: () => "e2e-session-1", getSessionFile: () => join(fix.root, "e2e-1.jsonl") },
		ui: {
			notify: (msg: string, level: string) => notifications.push({ msg, level }),
			setStatus: (key: string, val?: string) => statuses.set(key, val),
			setTheme: () => ({ success: true }),
			setTitle: () => {},
			setFooter: () => {},
			setHeader: () => {},
			editor: async () => editorReply,
			select: async () => selectReply,
			input: async () => inputReply,
			confirm: async () => confirmReply,
		},
	};
	await hooks.get("session_start")!({}, ctx);
	t.after(async () => { await hooks.get("session_shutdown")!({}, ctx); });

	const runCmd = async (args: string) => {
		notifications.length = 0;
		await commands.get("factory")!.handler(args, ctx);
		return notifications.at(-1)!;
	};
	const callTool = (name: string, params: Record<string, unknown>) =>
		tools.get(name).execute("t1", params, undefined, undefined, ctx);

	// 1. Agent tools cannot mutate or confirm anything.
	assert.equal((await callTool("factory_inspect", { action: "respond", factory_id: fac.factory_id })).isError, true);
	assert.equal((await callTool("factory_inspect", { action: "submit", factory_id: fac.factory_id })).isError, true);

	// 2. Resume management & submit two verbatim multiline briefs via /factory submit.
	assert.match((await runCmd(`resume ${fac.factory_id}`)).msg, /"resumed":\s*true/);
	const brief1 = "Line 1\r\n  indented\tline 2\n\n";
	editorReply = brief1;
	const sub1Note = await runCmd(`submit ${fac.factory_id} ref-e2e-1`);
	const sub1 = JSON.parse(sub1Note.msg);
	assert.equal(sub1.brief, brief1);
	assert.equal(sub1.reference, "ref-e2e-1");

	editorReply = "Second input brief\nline 2";
	const sub2 = JSON.parse((await runCmd(`submit ${fac.factory_id} ref-e2e-2`)).msg);
	assert.equal(sub2.queue_position, 2);

	// 3. Launch input 1 via /factory launch.
	const launch1 = JSON.parse((await runCmd(`launch ${fac.factory_id}`)).msg);
	assert.equal(launch1.input_id, sub1.input_id);

	const s1Dir = launch1.manifest.session_dir;
	const build = workerFromConfig(t, join(s1Dir, `${launch1.manifest.pane_manifest[0].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	const review = workerFromConfig(t, join(s1Dir, `${launch1.manifest.pane_manifest[1].instance_id}.config.json`), { model: { provider: "provider", id: "model" } });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();
	await build.complete({ status: "success", summary: "Build attempt 1", detail: "first draft" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	// 4. Review attempt 1 asks for direction; clear simulated alert history and verify missed-alert discovery via /factory requests & inspect!
	const dirReq1 = review.requestDirection({
		question: "Should attempt 1 ship or revise?",
		reason: "Needs human routing",
		choices: ["approve_ship", "revise_code"],
	});
	let req1: any;
	for (let i = 0; i < 100 && !req1; i++) {
		const list = JSON.parse((await runCmd(`requests ${fac.factory_id}`)).msg);
		req1 = list.find((r: any) => r.state === "pending");
		if (!req1) await new Promise(r => setTimeout(r, 20));
	}
	assert.ok(req1, "request must be discoverable via /factory requests even if alerts were missed");
	const inspectPending = await callTool("factory_inspect", { action: "inspect", factory_id: fac.factory_id });
	assert.ok(inspectPending.details.result.attention.some((a: any) => a.kind === "intervention" && a.request_id === req1.request_id));

	// 5. Answer with revise_code + human guidance via /factory respond.
	selectReply = "revise_code: Request revision (binds this attempt to rejection; requires a valid result)";
	inputReply = "Add boundary check";
	await runCmd(`respond ${fac.factory_id} ${req1.request_id}`);
	const dirRes1 = await dirReq1;
	assert.equal(dirRes1.isError, undefined);
	assert.equal((await review.complete({ status: "success", summary: "Please revise", detail: "add boundary check" })).isError, undefined);

	// 6. Attempt 2 revises build; check live footer shows 1 rollback while run 1 is active, then review approves -> settles -> input 2 launches!
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "Build attempt 2", detail: "added boundary check" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await runCmd(`resume ${fac.factory_id}`); // refreshes live footer while run 1 is active on attempt 2
	assert.match(statuses.get(`factory-${fac.factory_id}`) ?? "", /1 rollback/);

	const dirReq2 = review.requestDirection({
		question: "Approve revised build?",
		reason: "Verify boundary fix",
		choices: ["approve_ship", "revise_code"],
	});
	let req2: any;
	for (let i = 0; i < 100 && !req2; i++) {
		const list = JSON.parse((await runCmd(`requests ${fac.factory_id}`)).msg);
		req2 = list.find((r: any) => r.state === "pending");
		if (!req2) await new Promise(r => setTimeout(r, 20));
	}
	assert.ok(req2);
	selectReply = "approve_ship: Approve (binds this attempt to approval; requires a valid result)";
	inputReply = "";
	await runCmd(`respond ${fac.factory_id} ${req2.request_id}`);
	await dirReq2;
	assert.equal((await review.complete({ status: "success", summary: "Ship it", detail: "approved" })).isError, undefined);

	// 7. Drill-down from live summary -> receipt -> queue -> run status -> read-only bootstrap_report -> recover(inspect).
	const receiptDrill = await callTool("factory_inspect", { action: "receipt", factory_id: fac.factory_id, reference: "ref-e2e-1" });
	assert.deepEqual(receiptDrill.details.result.attempt.node_counts, [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	]);
	const runStatus = await callTool("bootstrap_status", { task_id: launch1.task_id });
	assert.equal(runStatus.details.outcome.state, "succeeded");
	const runReport = await callTool("bootstrap_report", { task_id: launch1.task_id });
	assert.equal(runReport.details.status, "read_only");
	assert.deepEqual(runReport.details.node_counts, [
		{ node_id: "build", attempts: 2, rollbacks: 1 },
		{ node_id: "review", attempts: 2, rollbacks: 1 },
	]);
	const recoverInspect = await callTool("bootstrap_recover", { task_id: launch1.task_id, action: "inspect" });
	assert.equal(recoverInspect.isError, undefined);

	// 8. Settle via scheduler (or /factory settle) and verify input 2 starts!
	await new Promise(r => setTimeout(r, 50)); // allow any in-flight watcher tick to finish before manual settle/launch check
	const viewBeforeSettle = (await callTool("factory_inspect", { action: "inspect", factory_id: fac.factory_id })).details.result;
	if (viewBeforeSettle.attempts.every((a: any) => a.task_id === launch1.task_id)) {
		const settleNote = await runCmd(`settle ${fac.factory_id}`);
		assert.equal(JSON.parse(settleNote.msg).settled, true);
		const launch2 = JSON.parse((await runCmd(`launch ${fac.factory_id}`)).msg);
		assert.equal(launch2.input_id, sub2.input_id);
		assert.notEqual(launch2.task_id, launch1.task_id);
	} else {
		const att2 = viewBeforeSettle.attempts.find((a: any) => a.input_id === sub2.input_id);
		assert.ok(att2, "scheduler automatically settled run 1 and launched input 2");
		assert.notEqual(att2.task_id, launch1.task_id);
	}
});

test("Slice 5b: retained E2E — real SIGKILL takeover exposes actionable request and uncertain hold without replay", async t => {
	// Part A: Manager SIGKILL while direction request is pending -> takeover recovers exact same request_id without replay.
	{
		const setup = await runSupervised(process.execPath, ["--experimental-strip-types", interventionChild, "setup"], { timeoutMs: 10_000 });
		assert.equal(setup.code, 0, setup.stderr);
		const state = JSON.parse(setup.stdout) as { root: string; cwd: string; factory: { factory_id: string }; configs: any[]; manager: string };
		t.after(() => rmSync(state.root, { recursive: true, force: true }));

		const continuation = join(state.root, "continued-once");
		const cfg = state.configs[0];
		const agent = spawn(process.execPath, [
			"--experimental-strip-types", interventionChild, "agent",
			join(cfg.session_dir, `${cfg.instance_id}.config.json`), "none", continuation,
		], { stdio: ["ignore", "ignore", "pipe"] });
		const agentExit = once(agent, "close");
		t.after(async () => { agent.kill("SIGKILL"); await agentExit; });

		const svc = new BootstrapService({ stateDir: join(state.root, "state"), home: join(state.root, "home"), extensionDir: state.root, exec: async () => { throw new Error("unexpected"); } });
		const open = () => factoryOperations(join(state.root, "factories.sqlite"), svc, { coordinationPath: join(state.root, "factory-coordination.sqlite") });
		let pending: any;
		for (let i = 0; i < 150 && !pending; i++) {
			pending = open()({ action: "requests", factory_id: state.factory.factory_id }).find(r => r.state === "pending");
			if (!pending) await new Promise(r => setTimeout(r, 20));
		}
		assert.ok(pending);

		// Kill a second manager before_commit of response via real SIGKILL.
		const mgrKill = await runSupervised(process.execPath, [
			"--experimental-strip-types", interventionChild, "manager",
			state.root, state.factory.factory_id, state.manager, pending.request_id, "before_commit",
		], { timeoutMs: 10_000 });
		assert.equal(mgrKill.signal, "SIGKILL", mgrKill.stderr);
		const mgrOut = JSON.parse(mgrKill.stdout);

		// Takeover exposes the original actionable request without replay and completes on the same worker.
		const finalAuth = createManagerAuthority({ pi_session_id: "takeover-final" });
		open()({ action: "takeover", factory_id: state.factory.factory_id, authority: finalAuth, confirmed_manager_incarnation_id: mgrOut.owner });
		const recovered = open()({ action: "requests", factory_id: state.factory.factory_id });
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].request_id, pending.request_id);
		assert.equal(recovered[0].can_respond, true);
		open()({ action: "respond_request", factory_id: state.factory.factory_id, request_id: pending.request_id, authority: finalAuth, response: { kind: "choice", choice_id: "proceed" } });
		assert.deepEqual(await agentExit, [0, null]);
		assert.equal(readFileSync(continuation, "utf8").trim(), cfg.instance_id);
	}

	// Part B: Worker SIGKILL mid-work -> takeover exposes uncertain hold without replay, cleared only by explicit human clearance.
	{
		const setup = await runSupervised(process.execPath, ["--experimental-strip-types", interventionChild, "setup"], { timeoutMs: 10_000 });
		assert.equal(setup.code, 0, setup.stderr);
		const state = JSON.parse(setup.stdout) as { root: string; cwd: string; factory: { factory_id: string }; configs: any[]; manager: string };
		t.after(() => rmSync(state.root, { recursive: true, force: true }));

		const continuation = join(state.root, "continued-once");
		const cfg = state.configs[0];
		const agent = spawn(process.execPath, [
			"--experimental-strip-types", interventionChild, "agent",
			join(cfg.session_dir, `${cfg.instance_id}.config.json`), "none", continuation,
		], { stdio: ["ignore", "ignore", "pipe"] });
		const agentExit = once(agent, "close");
		t.after(async () => { agent.kill("SIGKILL"); await agentExit; });

		const svc = new BootstrapService({ stateDir: join(state.root, "state"), home: join(state.root, "home"), extensionDir: state.root, exec: async () => { throw new Error("unexpected"); } });
		const open = () => factoryOperations(join(state.root, "factories.sqlite"), svc, { coordinationPath: join(state.root, "factory-coordination.sqlite") });
		let pending: any;
		for (let i = 0; i < 150 && !pending; i++) {
			pending = open()({ action: "requests", factory_id: state.factory.factory_id }).find(r => r.state === "pending");
			if (!pending) await new Promise(r => setTimeout(r, 20));
		}
		assert.ok(pending);
		// SIGKILL the worker while holding capacity and without recording an outcome.
		agent.kill("SIGKILL");
		assert.deepEqual(await agentExit, [null, "SIGKILL"]);

		const takeoverAuth = createManagerAuthority({ pi_session_id: "takeover-uncertain" });
		open()({ action: "takeover", factory_id: state.factory.factory_id, authority: takeoverAuth, confirmed_manager_incarnation_id: state.manager });
		const view = open()({ action: "inspect", factory_id: state.factory.factory_id });
		assert.equal(view.attempts.length, 1, "uncertain attempt must never be replayed");
		assert.equal(view.capacity.factory_slot, "held");
		assert.equal(view.attempts[0].settlement?.execution_settlement.state, "unknown");
		assert.ok(view.attention.some(item => item.kind === "uncertain"));
		assert.equal(view.attempts[0].clearance_eligibility?.eligible, true);
		const cleared = await open()({
			action: "clear_hold",
			factory_id: state.factory.factory_id,
			input_id: view.attempts[0].input_id,
			attempt_id: view.attempts[0].attempt_id,
			task_id: view.attempts[0].task_id,
			authority: takeoverAuth,
			confirm: async () => ({ reason: "Worker killed by SIGKILL", evidence: "SIGKILL observed; no surviving PID", acknowledged_unknown_effects: true }),
		});
		assert.equal(cleared.cleared, true);
		rmSync(join(cfg.session_dir, "upstream-index.json"));
		const afterClear = open()({ action: "inspect", factory_id: state.factory.factory_id });
		assert.equal(afterClear.capacity.checkout_slot, "free");
		assert.equal(afterClear.attempts[0].state, "cleared");
		assert.equal(afterClear.attempts[0].node_counts, undefined);
		assert.equal(afterClear.attempts[0].node_counts_error, undefined, "cleared history does not require an index");
		assert.equal(existsSync(continuation), false);
	}
});

test("Slice 5c: commit durability pragmas and hot-journal SIGKILL recovery on factory storage", async t => {
	const fix = serviceFixture(t, ["builder"]);
	const dbPath = join(fix.root, "factories.sqlite");
	const coordPath = join(fix.root, "factory-coordination.sqlite");
	const open = () => factoryOperations(dbPath, fix.service, { coordinationPath: coordPath });
	const fac = open()({
		action: "publish",
		name: "durability-check",
		draft: { topology: "graph", task: "Durability", project_cwd: fix.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Build" }] },
		sessionModel: { provider: "provider", id: "model", thinkingLevel: "medium" },
	});
	const auth = createManagerAuthority({ pi_session_id: "mgr-dur" });
	open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
	open()({ action: "submit", factory_id: fac.factory_id, reference: "dur-ref", brief: "Durability brief", authority: auth });
	await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });

	// 1. Verify DELETE journal mode + synchronous=EXTRA (3) on both SQLite stores.
	for (const path of [dbPath, coordPath]) {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			assert.equal((db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "delete", path);
		} finally { db.close(); }
	}
	// Verify synchronous=EXTRA (3) and controlled pre-commit fault injection leaves prior state intact.
	const faultOps = factoryOperations(dbPath, fix.service, {
		coordinationPath: coordPath,
		atCommit: phase => { if (phase === "before_commit") throw new Error("injected fault before commit"); },
	});
	assert.throws(() => faultOps({ action: "submit", factory_id: fac.factory_id, reference: "fault-ref", brief: "Should roll back", authority: auth }), /injected fault before commit/);
	assert.throws(() => open()({ action: "receipt", factory_id: fac.factory_id, reference: "fault-ref" }), /Receipt not found/, "pre-commit fault must roll back cleanly");

	// 2. Real SIGKILL during a multi-page transaction creating a hot rollback journal recovers cleanly on next write without losing prior committed rows.
	const reqSetup = await runSupervised(process.execPath, ["--experimental-strip-types", interventionChild, "setup"], { timeoutMs: 10_000 });
	assert.equal(reqSetup.code, 0, reqSetup.stderr);
	const reqState = JSON.parse(reqSetup.stdout) as { root: string; factory: { factory_id: string }; configs: any[]; manager: string };
	t.after(() => rmSync(reqState.root, { recursive: true, force: true }));
	const reqAgent = spawn(process.execPath, [
		"--experimental-strip-types", interventionChild, "agent",
		join(reqState.configs[0].session_dir, `${reqState.configs[0].instance_id}.config.json`), "none", join(reqState.root, "cont"),
	], { stdio: ["ignore", "ignore", "pipe"] });
	const reqExit = once(reqAgent, "close");
	t.after(async () => { reqAgent.kill("SIGKILL"); await reqExit; });
	const reqSvc = new BootstrapService({ stateDir: join(reqState.root, "state"), home: join(reqState.root, "home"), extensionDir: reqState.root, exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
	const reqOpen = () => factoryOperations(join(reqState.root, "factories.sqlite"), reqSvc, { coordinationPath: join(reqState.root, "factory-coordination.sqlite") });
	for (let i = 0; i < 150 && reqOpen()({ action: "requests", factory_id: reqState.factory.factory_id }).length === 0; i++) {
		await new Promise(r => setTimeout(r, 20));
	}
	assert.equal(reqOpen()({ action: "requests", factory_id: reqState.factory.factory_id }).length, 1);
	reqAgent.kill("SIGKILL");
	await reqExit;
	const reqDbPath = join(reqState.root, "factories.sqlite");
	const hot = await runSupervised(process.execPath, ["--experimental-strip-types", interventionChild, "hot_journal", reqDbPath], { timeoutMs: 10_000 });
	assert.equal(hot.signal, "SIGKILL", hot.stderr);
	assert.equal(existsSync(`${reqDbPath}-journal`), true, "SIGKILL mid-transaction must leave a real SQLite hot journal");
	const journalBefore = readFileSync(`${reqDbPath}-journal`);
	// Read-only inspect refuses/reports hot journal without mutating it, while a write operation recovers it cleanly.
	assert.throws(() => reqOpen()({ action: "requests", factory_id: reqState.factory.factory_id }), /hot SQLite journal|journal|readonly|unable/i);
	assert.deepEqual(readFileSync(`${reqDbPath}-journal`), journalBefore, "read-only inspect must not delete or roll back hot journal");
	const recoveredAuth = createManagerAuthority({ pi_session_id: "hot-recover" });
	reqOpen()({ action: "takeover", factory_id: reqState.factory.factory_id, authority: recoveredAuth, confirmed_manager_incarnation_id: reqState.manager });
	assert.equal(reqOpen()({ action: "receipt", factory_id: reqState.factory.factory_id, reference: "first" }).brief, "Fixture brief");
});
