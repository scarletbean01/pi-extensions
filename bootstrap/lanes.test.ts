import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { canonicalJson, sha256Text } from "./contracts.ts";
import {
	assessChangedPaths,
	assessRiskLane,
	captureLaneSnapshot,
	laneAfterPath,
	laneBeforePath,
	matchesLaneGlob,
	parseLaneConfig,
	validateLaneConfig,
} from "./lanes.ts";
import { admission, evaluateJoinAdmission } from "./node-admission.ts";
import { buildMarkdownReport, formatAgentStates, formatPlan, formatReportDigest } from "./reporting.ts";
import { atomicJson, dispositionPath, parseManifest, parseWorkerConfig, readJson, resultPath, type BootstrapResult, type WorkerConfig } from "./session-store.ts";
import { createManagerAuthority, factoryOperations } from "../factory/operations.ts";
import { commandFromConfig, notification, serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const model = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

test("validateLaneConfig disables lanes when omitted or empty and rejects malformed settings", () => {
	assert.equal(validateLaneConfig("/p/.pi/bootstrap.json", undefined), undefined);
	assert.equal(validateLaneConfig("/p/.pi/bootstrap.json", {}), undefined);
	assert.equal(validateLaneConfig("/p/.pi/bootstrap.json", { contained: [], closed: [] }), undefined);

	const ok = validateLaneConfig("/p/.pi/bootstrap.json", {
		contained: ["./docs/", "README.md", "notes/**/*.md"],
		closed: ["auth/**", ".github/"],
	});
	assert.deepEqual(ok, {
		contained: ["docs/**", "README.md", "notes/**/*.md"],
		closed: ["auth/**", ".github/**"],
	});

	for (const [bad, pattern] of [
		[null, /"lanes" must be an object/],
		["contained", /"lanes" must be an object/],
		[[], /"lanes" must be an object/],
		[{ wide: ["src/**"] }, /"lanes\.wide" is not a recognized key/],
		[{ contained: "docs/**" }, /"lanes\.contained" must be an array/],
		[{ closed: [123] }, /"lanes\.closed\[0\]" must be a non-empty string/],
		[{ contained: ["   "] }, /"lanes\.contained\[0\]" must be a non-empty string/],
		[{ contained: ["a\0b"] }, /"lanes\.contained\[0\]" must be a non-empty string/],
		[{ closed: ["/etc/passwd"] }, /must be project-relative/],
		[{ closed: ["C:\\secret\\a"] }, /must be project-relative/],
		[{ contained: ["../outside/**"] }, /path traversal/],
		[{ contained: ["docs/../secret"] }, /path traversal/],
		[{ contained: ["."] }, /ambiguous/],
		[{ contained: ["./"] }, /ambiguous/],
		[{ contained: ["src/[unclosed"] }, /invalid glob/i],
		[{ closed: ["src/{a,b"] }, /invalid glob/i],
		[{ closed: ["src/{"] }, /invalid glob/i],
		[{ contained: ["docs//guide.md"] }, /empty path segments/],
		[{ closed: ["auth//"] }, /empty path segments/],
		[{ closed: ["{d0,d1,d2,d3,d4,d5,d6,d7,d8}/{d0,d1,d2,d3,d4,d5,d6,d7,d8}/x"] }, /exceeds maximum brace expansions/],
		[{ closed: [".git/**"] }, /excluded snapshot directory.*\.git/],
		[{ closed: [".git/"] }, /excluded snapshot directory.*\.git/],
		[{ closed: ["node_modules/**"] }, /excluded snapshot directory.*node_modules/],
		[{ closed: [".pi/agent-sessions/**"] }, /excluded snapshot directory.*\.pi\/agent-sessions/],
		[{ closed: ["{.git,node_modules}/**"] }, /excluded snapshot directory/],
	] as const) {
		assert.throws(() => validateLaneConfig("/p/.pi/bootstrap.json", bad), pattern);
	}

	// Valid multi-brace within limit, nested .git, .pi/**, mixed excluded+non-excluded brace, and root-anchored behavior
	assert.doesNotThrow(() => validateLaneConfig("/p/.pi/bootstrap.json", {
		contained: ["**/.git/**", ".pi/**", "{.git,src}/**", "{a,b}/{c,d}/x"],
	}));
	assert.equal(matchesLaneGlob(".env", ".env*"), true);
	assert.equal(matchesLaneGlob("sub/.env", ".env*"), false);
	assert.equal(matchesLaneGlob("sub/.env", "**/.env*"), true);
	assert.equal(matchesLaneGlob("a/b", "[!x]b"), false);
	assert.equal(matchesLaneGlob("ab", "[!x]b"), true);
	assert.equal(matchesLaneGlob("a/c", "[a/b]c"), false);
	assert.equal(matchesLaneGlob("d8/d8/x", "{d0,d1}/{d0,d1}/x"), false);
	assert.equal(matchesLaneGlob("d1/d1/x", "{d0,d1}/{d0,d1}/x"), true);

	assert.throws(() => parseLaneConfig({ contained: ["/abs"] }), /must be project-relative/);
	assert.throws(() => parseLaneConfig({}), /at least one/i);
});

test("glob matching covers **, dotfiles, trailing slashes, case sensitivity, mixed lanes, renames, deletions, and escapes", t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lanes-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(join(project, "docs", "nested"), { recursive: true });
	mkdirSync(join(project, "auth"), { recursive: true });
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "top secret");
	writeFileSync(join(project, "auth", "token.ts"), "secret");

	const lanes = validateLaneConfig("/p/.pi/bootstrap.json", {
		contained: ["docs/", "src/**/readme.md", "*.txt"],
		closed: ["auth/", "**/.env*", "src/*.{key,pem}"],
	})!;

	// ** matches zero or more directories
	assert.equal(assessChangedPaths(lanes, ["src/readme.md"], project).lane, "contained");
	assert.equal(assessChangedPaths(lanes, ["src/a/b/readme.md"], project).lane, "contained");

	// Trailing slash matches descendants, not unrelated sibling prefix
	assert.equal(assessChangedPaths(lanes, ["docs/nested/guide.md"], project).lane, "contained");
	assert.equal(assessChangedPaths(lanes, ["docs2/guide.md"], project).lane, "wide");
	assert.equal(assessChangedPaths(lanes, ["auth/login.ts"], project).lane, "closed");

	// Dotfiles match ** and * patterns
	assert.equal(assessChangedPaths(lanes, [".env"], project).lane, "closed");
	assert.equal(assessChangedPaths(lanes, ["config/.env.prod"], project).lane, "closed");
	assert.equal(assessChangedPaths(lanes, ["docs/.hidden.md"], project).lane, "contained");

	// Brace expansion
	assert.equal(assessChangedPaths(lanes, ["src/signing.key"], project).lane, "closed");

	// Case-sensitive matching
	const caseMismatch = assessChangedPaths(lanes, ["Docs/guide.md"], project);
	assert.equal(caseMismatch.lane, "wide");
	assert.deepEqual(caseMismatch.deciding_paths, ["Docs/guide.md"]);
	assert.equal(assessChangedPaths(lanes, ["Auth/login.ts"], project).lane, "wide");

	// Unmatched path falls into wide, never contained
	const unmatched = assessChangedPaths(lanes, ["src/app.ts"], project);
	assert.equal(unmatched.lane, "wide");
	assert.deepEqual(unmatched.deciding_paths, ["src/app.ts"]);

	// Mixed changes: most restrictive wins and only deciding paths are listed
	const wideMixed = assessChangedPaths(lanes, ["docs/a.md", "src/app.ts"], project);
	assert.equal(wideMixed.lane, "wide");
	assert.deepEqual(wideMixed.deciding_paths, ["src/app.ts"]);

	const closedMixed = assessChangedPaths(lanes, ["docs/a.md", "src/app.ts", "auth/login.ts"], project);
	assert.equal(closedMixed.lane, "closed");
	assert.deepEqual(closedMixed.deciding_paths, ["auth/login.ts"]);

	// Renames: both old and new paths count
	const renameOutOfClosed = assessChangedPaths(lanes, [{ path: "docs/moved.md", oldPath: "auth/login.ts" }], project);
	assert.equal(renameOutOfClosed.lane, "closed");
	assert.deepEqual(renameOutOfClosed.deciding_paths, ["auth/login.ts"]);
	const renameIntoClosed = assessChangedPaths(lanes, [{ path: "auth/moved.ts", oldPath: "docs/guide.md" }], project);
	assert.equal(renameIntoClosed.lane, "closed");
	assert.deepEqual(renameIntoClosed.deciding_paths, ["auth/moved.ts"]);

	// Deletions
	const deletedClosed = assessChangedPaths(lanes, ["auth/deleted.ts"], project);
	assert.equal(deletedClosed.lane, "closed");

	// Absolute inside project_cwd normalizes to relative; outside/traversal fails closed (closed when closed globs configured, wide when only contained configured)
	const containedOnly = validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["docs/**"] })!;
	assert.equal(assessChangedPaths(lanes, [join(project, "docs", "a.md")], project).lane, "contained");
	assert.equal(assessChangedPaths(lanes, [join(project, "auth", "a.ts")], project).lane, "closed");
	const absOutside = assessChangedPaths(lanes, ["/etc/passwd"], project);
	assert.equal(absOutside.lane, "closed");
	assert.equal(absOutside.unknown_scope, true);
	assert.equal(assessChangedPaths(containedOnly, ["/etc/passwd"], project).lane, "wide");
	const traversal = assessChangedPaths(lanes, ["docs/../../outside/secret.txt"], project);
	assert.equal(traversal.lane, "closed");
	assert.equal(traversal.unknown_scope, true);

	// Symlink escaping project_cwd inside docs/ cannot be contained; with closed globs it fails closed as closed
	symlinkSync(join(outside, "secret.txt"), join(project, "docs", "escape-link.txt"));
	const escapingSymlink = assessChangedPaths(lanes, ["docs/escape-link.txt"], project);
	assert.equal(escapingSymlink.lane, "closed");
	assert.equal(escapingSymlink.unknown_scope, true);
	assert.match(escapingSymlink.reason ?? "", /symlink/i);
	assert.equal(assessChangedPaths(containedOnly, ["docs/escape-link.txt"], project).lane, "wide");

	// Symlink inside docs/ pointing to closed auth/ inside project_cwd resolves to closed
	symlinkSync("../auth/token.ts", join(project, "docs", "auth-link.ts"));
	const internalClosedSymlink = assessChangedPaths(lanes, ["docs/auth-link.ts"], project);
	assert.equal(internalClosedSymlink.lane, "closed");
	assert.deepEqual(internalClosedSymlink.deciding_paths, ["auth/token.ts"]);
});

test("assessRiskLane derives lane from before/after snapshots and fails closed on missing, truncated, incomplete, or digest-tampered snapshots", t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lane-snap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const session = join(root, "session");
	mkdirSync(join(project, "docs"), { recursive: true });
	mkdirSync(join(project, "auth"), { recursive: true });
	mkdirSync(session, { recursive: true });
	writeFileSync(join(project, "docs", "guide.md"), "v1");
	writeFileSync(join(project, "auth", "login.ts"), "v1");

	const lanes = validateLaneConfig("/p/.pi/bootstrap.json", {
		contained: ["docs/**"],
		closed: ["auth/**"],
	})!;
	const containedOnly = validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["docs/**"] })!;

	captureLaneSnapshot({
		sessionDir: session,
		kind: "before",
		runId: "run-1",
		reviewer: "a2-review",
		nodeId: "review",
		attempt: 1,
		projectCwd: project,
	});
	writeFileSync(join(project, "docs", "guide.md"), "v2");
	captureLaneSnapshot({
		sessionDir: session,
		kind: "after",
		runId: "run-1",
		reviewer: "a2-review",
		nodeId: "review",
		attempt: 1,
		projectCwd: project,
	});

	const contained = assessRiskLane({
		sessionDir: session,
		runId: "run-1",
		projectCwd: project,
		lanes,
		reviewerInstance: "a2-review",
		reviewerNodeId: "review",
		attempt: 1,
		liveIfNoAfterSnapshot: false,
	});
	assert.equal(contained.lane, "contained");
	assert.deepEqual(contained.deciding_paths, ["docs/guide.md"]);

	// Tampered baseline snapshot without matching snapshot_sha256 digest fails closed -> closed (with lanes.closed) or wide (without lanes.closed)
	const beforeOrig = readJson<any>(laneBeforePath(session, "a2-review", 1));
	const tamperedAfter = readJson<any>(laneAfterPath(session, "a2-review", 1));
	writeFileSync(laneAfterPath(session, "a2-review", 1), JSON.stringify({ ...tamperedAfter, snapshot: beforeOrig.snapshot }));
	const digestMismatch = assessRiskLane({
		sessionDir: session, runId: "run-1", projectCwd: project, lanes,
		reviewerInstance: "a2-review", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: false,
	});
	assert.equal(digestMismatch.lane, "closed");
	assert.equal(digestMismatch.unknown_scope, true);
	assert.match(digestMismatch.error ?? "", /digest mismatch/i);

	// M18: incomplete/non-conservative baseline snapshot (with valid digest) forces unknown_scope -> closed / wide
	writeFileSync(laneAfterPath(session, "a2-review", 1), JSON.stringify(tamperedAfter));
	const incSnap = { ...beforeOrig.snapshot, complete: false, scope_kind: "unknown", reason: "Snapshot exceeded 5000 files" };
	const incompleteBefore = {
		...beforeOrig,
		snapshot_sha256: sha256Text(canonicalJson(incSnap)),
		snapshot: incSnap,
	};
	writeFileSync(laneBeforePath(session, "a2-review", 1), JSON.stringify(incompleteBefore));
	const truncated = assessRiskLane({
		sessionDir: session, runId: "run-1", projectCwd: project, lanes,
		reviewerInstance: "a2-review", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: false,
	});
	assert.equal(truncated.lane, "closed");
	assert.equal(truncated.unknown_scope, true);
	assert.match(truncated.reason ?? "", /5000 files/);
	assert.equal(assessRiskLane({
		sessionDir: session, runId: "run-1", projectCwd: project, lanes: containedOnly,
		reviewerInstance: "a2-review", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: false,
	}).lane, "wide");

	// Corrupt after-snapshot fails closed to closed (when lanes.closed non-empty) / wide (when closed empty) with unknown_scope + error
	writeFileSync(laneBeforePath(session, "a2-review", 1), JSON.stringify(beforeOrig));
	writeFileSync(laneAfterPath(session, "a2-review", 1), "{torn");
	const corrupt = assessRiskLane({
		sessionDir: session,
		runId: "run-1",
		projectCwd: project,
		lanes,
		reviewerInstance: "a2-review",
		reviewerNodeId: "review",
		attempt: 1,
		liveIfNoAfterSnapshot: false,
	});
	assert.equal(corrupt.lane, "closed");
	assert.equal(corrupt.unknown_scope, true);
	assert.ok(corrupt.error);

	// Missing before-snapshot fails closed to closed (with closed globs) or wide (without closed globs)
	rmSync(laneBeforePath(session, "a2-review", 1));
	const missing = assessRiskLane({
		sessionDir: session,
		runId: "run-1",
		projectCwd: project,
		lanes,
		reviewerInstance: "a2-review",
		reviewerNodeId: "review",
		attempt: 1,
		liveIfNoAfterSnapshot: true,
	});
	assert.equal(missing.lane, "closed");
	assert.equal(missing.unknown_scope, true);
	assert.equal(assessRiskLane({
		sessionDir: session,
		runId: "run-1",
		projectCwd: project,
		lanes: containedOnly,
		reviewerInstance: "a2-review",
		reviewerNodeId: "review",
		attempt: 1,
		liveIfNoAfterSnapshot: true,
	}).lane, "wide");
});

const SUCCESS: Omit<BootstrapResult, "agent_name"> = {
	status: "success",
	summary: "Done",
	detail: "Completed step",
};

function writeProjectConfig(cwd: string, payload: Record<string, unknown>) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "bootstrap.json"), JSON.stringify(payload, null, 2));
}

function makeLoopNodes(options: {
	builderChecks?: string[];
	builderWrites?: string[];
	reviewerWrites?: string[];
	reviewerChecks?: string[];
	reviewerArtifact?: boolean;
	maxRevisions?: number;
	intervention?: Record<string, unknown>;
} = {}) {
	return [
		{
			node_id: "build",
			persona: "first",
			sub_task: "Build changes",
			...(options.builderChecks ? { required_checks: options.builderChecks } : {}),
			...(options.builderWrites ? { write_paths: options.builderWrites } : {}),
		},
		{
			node_id: "review",
			persona: "second",
			sub_task: "Review changes",
			depends_on: ["build"],
			...(options.reviewerWrites ? { write_paths: options.reviewerWrites } : {}),
			...(options.reviewerChecks ? { required_checks: options.reviewerChecks } : {}),
			decision: {
				field: "verdict",
				approve: "approve",
				reject: "revise",
				on_reject: "build",
				max_revisions: options.maxRevisions ?? 1,
			},
			output_contract: {
				required_fields: ["verdict"],
				properties: { verdict: { type: "string", enum: ["approve", "revise"] } },
				...(options.reviewerArtifact ? { require_artifacts: true, required_artifact_paths: ["review.md"] } : {}),
			},
			...(options.intervention ? { intervention: options.intervention } : {}),
		},
		{
			node_id: "deploy",
			persona: "first",
			sub_task: "Deploy",
			depends_on: ["review"],
		},
	];
}

test("config rejection, global bootstrap.json guard, planning warnings, and lanes-off compatibility", async t => {
	const f = serviceFixture(t, ["first", "second"]);

	// Malformed project .pi/bootstrap.json rejects cleanly
	writeProjectConfig(f.cwd, { lanes: { wide: ["src/**"] } });
	assert.throws(() => f.service.plan({
		topology: "graph", task: "Check config", project_cwd: f.cwd, agents: makeLoopNodes(),
	}, model), /"lanes\.wide" is not a recognized key/);

	// Global bootstrap.json rejects lanes
	mkdirSync(join(f.home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(f.home, ".pi", "agent", "bootstrap.json"), JSON.stringify({ lanes: { closed: ["auth/**"] } }));
	writeProjectConfig(f.cwd, {});
	assert.throws(() => f.service.plan({
		topology: "graph", task: "Check global config", project_cwd: f.cwd, agents: makeLoopNodes(),
	}, model), /"lanes" is only supported in project \.pi\/bootstrap\.json/);
	rmSync(join(f.home, ".pi", "agent", "bootstrap.json"));

	// Lanes off (empty object): no lanes on plan, no warnings, unchanged behavior
	const offPlan = f.service.plan({
		topology: "graph", task: "No lanes", project_cwd: f.cwd, agents: makeLoopNodes(),
	}, model);
	assert.equal(offPlan.lanes, undefined);
	assert.equal(offPlan.warnings, undefined);

	// Closed lanes with non-intervention decision node emit planning warnings (both unrestricted & overlapping write_paths)
	writeProjectConfig(f.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	const unrestrictedWarn = f.service.plan({
		topology: "graph", task: "Unrestricted loop", project_cwd: f.cwd, agents: makeLoopNodes(),
	}, model);
	assert.deepEqual(unrestrictedWarn.lanes, { contained: ["docs/**"], closed: ["auth/**"] });
	assert.equal(unrestrictedWarn.warnings?.length, 1);
	assert.match(unrestrictedWarn.warnings![0], /review.*not intervention-enabled/i);
	assert.match(formatPlan(unrestrictedWarn), /risk_lanes: contained=\[docs\/\*\*\], closed=\[auth\/\*\*\]/);
	assert.match(formatPlan(unrestrictedWarn), /warning: Risk lane warning:/);

	// Unrestricted reviewer (even when builder is restricted to safe paths!) emits planning warning; restricting both suppresses it
	const unrestrictedReviewerWarn = f.service.plan({
		topology: "graph", task: "Unrestricted reviewer", project_cwd: f.cwd,
		agents: makeLoopNodes({ builderWrites: ["docs/**"] }),
	}, model);
	assert.equal(unrestrictedReviewerWarn.warnings?.length, 1);
	assert.match(unrestrictedReviewerWarn.warnings![0], /loop member review has no write_paths restriction/);

	const safePlan = f.service.plan({
		topology: "graph", task: "Safe write_paths", project_cwd: f.cwd,
		agents: makeLoopNodes({ builderWrites: ["docs/**"], reviewerWrites: ["docs/**"] }),
	}, model);
	assert.equal(safePlan.warnings, undefined);

	// Overlapping closed write_paths in factory without approve route warns; with approve route does not warn
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "factory-coordination.sqlite") });
	const withoutApproveRoute = open()({
		action: "publish",
		name: "no-approve-route",
		draft: {
			topology: "graph", task: "Factory no approve", project_cwd: f.cwd,
			agents: makeLoopNodes({
				builderWrites: ["auth/**"],
				intervention: { choices: [{ choice_id: "notes", label: "Notes" }] },
			}),
		},
		sessionModel: model,
	});
	const inspected = open()({ action: "inspect", factory_id: withoutApproveRoute.factory_id });
	assert.equal(inspected.definition?.warnings?.length, 1);
	assert.match(inspected.definition!.warnings![0], /review.*without a route: "approve"/i);

	const withApproveRoute = f.service.prepareDefinition({
		topology: "graph", task: "Factory with approve", project_cwd: f.cwd,
		agents: makeLoopNodes({
			builderWrites: ["auth/**"],
			intervention: { choices: [{ choice_id: "ship", label: "Ship", route: "approve" }] },
		}),
	}, model);
	assert.equal(withApproveRoute.warnings, undefined);
});

test("contained lane allows reviewer approval alone; unmatched path falls into wide and requires loop checks; mid-run config edit does not lower lane", async t => {
	// Configure lanes BEFORE launch
	const f = (() => {
		const fix = serviceFixture(t, ["first", "second"]);
		writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
		mkdirSync(join(fix.cwd, "docs"), { recursive: true });
		mkdirSync(join(fix.cwd, "src"), { recursive: true });
		writeFileSync(join(fix.cwd, "docs", "guide.md"), "v1\n");
		writeFileSync(join(fix.cwd, "src", "app.ts"), "export const x = 1;\n");
		return fix;
	})();

	// Sub-run A: contained edit only -> reviewer approval is enough, even when builder declared a required check on a standalone review
	const planNodes = makeLoopNodes({ builderChecks: ["tests"] });
	const runA = await f.service.generate({ topology: "graph", task: "Contained", project_cwd: f.cwd, agents: planNodes }, model);
	const driversA = new Map(runA.pane_manifest.map(entry => [entry.node_id, workerFromConfig(t, join(runA.session_dir, `${entry.instance_id}.config.json`), { model })]));
	for (const d of driversA.values()) await d.start();
	const buildA = driversA.get("build")!;
	const reviewA = driversA.get("review")!;
	const deployA = driversA.get("deploy")!;
	await buildA.beforeStart();
	writeFileSync(join(f.cwd, "docs", "guide.md"), "v2\n");
	assert.ok(!(await buildA.verify({ action: "run", check_id: "tests", command: "true" })).isError);
	assert.ok(!(await buildA.complete(SUCCESS)).isError);
	await reviewA.beforeStart(notification(buildA, reviewA));
	await reviewA.deliverFollowUps();
	const resA = await reviewA.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.ok(!resA.isError);
	await deployA.beforeStart(notification(reviewA, deployA));
	await deployA.deliverFollowUps();
	assert.ok(!(await deployA.complete(SUCCESS)).isError);

	const statusA = f.service.status(runA.task_id, f.cwd);
	const revStateA = statusA.agents.find(a => a.node_id === "review")!;
	assert.equal(revStateA.risk_lane?.lane, "contained");
	assert.deepEqual(revStateA.risk_lane?.deciding_paths, ["docs/guide.md"]);
	assert.match(revStateA.risk_lane?.requirement ?? "", /reviewer approval/);
	assert.match(formatAgentStates(statusA.agents), /\[lane: contained \(paths: docs\/guide\.md; requires: reviewer approval\)\]/);

	const reportA = await f.service.report(runA.task_id, undefined, true, buildMarkdownReport);
	const revRepA = reportA.results.find(r => r.node_id === "review")!;
	assert.equal(revRepA.risk_lane?.lane, "contained");
	assert.match(formatReportDigest(reportA.results), /contained \(paths: docs\/guide\.md/);
	assert.match(readFileSync(reportA.report_md!, "utf8"), /Risk lane: contained \(paths: docs\/guide\.md/);

	// Sub-run B: mixed docs/guide.md + unmatched src/app.ts -> wide lane; stale check blocks approval even after mid-run .pi/bootstrap.json edit tries to classify src/** as contained
	const runB = await f.service.generate({ topology: "graph", task: "Wide mixed + mid-run tamper", project_cwd: f.cwd, agents: planNodes }, model);
	const driversB = new Map(runB.pane_manifest.map(entry => [entry.node_id, workerFromConfig(t, join(runB.session_dir, `${entry.instance_id}.config.json`), { model })]));
	for (const d of driversB.values()) await d.start();
	const buildB = driversB.get("build")!;
	const reviewB = driversB.get("review")!;
	const deployB = driversB.get("deploy")!;
	await buildB.beforeStart();
	writeFileSync(join(f.cwd, "docs", "guide.md"), "v3\n");
	writeFileSync(join(f.cwd, "src", "app.ts"), "export const x = 2;\n");
	assert.ok(!(await buildB.verify({ action: "run", check_id: "tests", command: "true" })).isError);
	assert.ok(!(await buildB.complete(SUCCESS)).isError);
	await reviewB.beforeStart(notification(buildB, reviewB));
	await reviewB.deliverFollowUps();

	// Attempt to lower lane mid-run via .pi/bootstrap.json edit
	writeProjectConfig(f.cwd, { lanes: { contained: ["**"] } });
	// Modify src/app.ts making builder's check stale!
	writeFileSync(join(f.cwd, "src", "app.ts"), "export const x = 3;\n");
	const inFlightStatus = f.service.status(runB.task_id, f.cwd);
	const inFlightLane = inFlightStatus.agents.find(a => a.node_id === "review")?.risk_lane;
	assert.equal(inFlightLane?.lane, "wide");
	assert.ok(inFlightLane?.deciding_paths.includes("src/app.ts"));

	const staleApprove = await reviewB.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.equal(staleApprove.isError, true);
	assert.match(staleApprove.content[0].text, /wide risk lane.*stale/i);

	// Restore both app.ts and .pi/bootstrap.json to match verified check snapshot, approve, then mutate app.ts BEFORE deploy admits!
	writeProjectConfig(f.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	writeFileSync(join(f.cwd, "src", "app.ts"), "export const x = 2;\n");
	const okApprove = await reviewB.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.ok(!okApprove.isError);

	// Now mutate src/app.ts after review approved -> downstream admission MUST block because builder check is stale!
	writeFileSync(join(f.cwd, "src", "app.ts"), "export const x = 999;\n");
	const deployCfg = readJson<WorkerConfig>(join(runB.session_dir, `${deployB.config.instance_id}.config.json`));
	const reviewComp = readJson<any>(resultPath(runB.session_dir, `${reviewB.config.instance_id}.1`));
	const blockedAdm = admission(deployCfg, { completion: reviewComp });
	assert.equal(blockedAdm.admit, false);
	if (!blockedAdm.admit) {
		assert.equal(blockedAdm.outcome, "blocked");
		assert.match(blockedAdm.reason, /wide risk lane.*stale/i);
	}
	const blockedJoin = evaluateJoinAdmission({ ...deployCfg, inbound_edges: [reviewB.config.instance_id] }, [reviewB.config.instance_id]);
	assert.equal(blockedJoin.outcome, "blocked");
	if (blockedJoin.outcome === "blocked") {
		assert.match(blockedJoin.reason, /wide risk lane.*stale/i);
	}
});

test("non-intervention closed-lane decision settles blocked naming lane and path without falling back to wide", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(f.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(f.cwd, "auth"), { recursive: true });
	writeFileSync(join(f.cwd, "auth", "secret.ts"), "export const k = 1;\n");

	const run = await f.service.generate({
		topology: "graph",
		task: "Standalone closed block",
		project_cwd: f.cwd,
		agents: makeLoopNodes(),
	}, model);
	const drivers = new Map(run.pane_manifest.map(entry => [entry.node_id, workerFromConfig(t, join(run.session_dir, `${entry.instance_id}.config.json`), { model })]));
	for (const d of drivers.values()) await d.start();
	const build = drivers.get("build")!;
	const review = drivers.get("review")!;
	await build.beforeStart();
	writeFileSync(join(f.cwd, "auth", "secret.ts"), "export const k = 2;\n");
	await build.complete(SUCCESS);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	const res = await review.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.match(res.content[0].text, /closed risk lane/i);
	assert.match(res.content[0].text, /auth\/secret\.ts/);
	assert.equal(review.sent.length, 0, "must not notify deploy");

	const disp = readJson<any>(dispositionPath(run.session_dir, `${review.config.instance_id}.1`));
	assert.equal(disp.state, "blocked");
	assert.match(disp.reason, /closed/i);
	assert.match(disp.reason, /auth\/secret\.ts/);

	const status = f.service.status(run.task_id, f.cwd);
	const revState = status.agents.find(a => a.node_id === "review")!;
	assert.equal(revState.execution, "blocked");
	assert.equal(revState.risk_lane?.lane, "closed");
	assert.deepEqual(revState.risk_lane?.deciding_paths, ["auth/secret.ts"]);
	assert.equal(status.agents.find(a => a.node_id === "deploy")?.execution, "blocked");

	// Report (not-executed closed decision) shows risk_lane on entry and in review_history
	const rep = await f.service.report(run.task_id, undefined, true, buildMarkdownReport);
	const revEntry = rep.results.find(r => r.node_id === "review")!;
	assert.equal(revEntry.risk_lane?.lane, "closed");
	assert.equal(revEntry.review_history?.attempts[0]?.risk_lane?.lane, "closed");
	assert.match(formatReportDigest(rep.results), /closed \(paths: auth\/secret\.ts/);
});

test("closed-lane intervention requires recorded human approval, preserves cumulative lane across revisions, and never bypasses contracts/checks/artifacts", async t => {
	const fix = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fix.cwd, "auth"), { recursive: true });
	mkdirSync(join(fix.cwd, "docs"), { recursive: true });
	writeFileSync(join(fix.cwd, "auth", "token.ts"), "export const t = 1;\n");
	writeFileSync(join(fix.cwd, "docs", "readme.md"), "v1\n");

	const open = () => factoryOperations(join(fix.root, "factories.sqlite"), fix.service, { coordinationPath: join(fix.root, "factory-coordination.sqlite") });
	const factory = open()({
		action: "publish",
		name: "closed-factory",
		draft: {
			topology: "graph",
			task: "Closed factory gating",
			project_cwd: fix.cwd,
			agents: makeLoopNodes({
				builderChecks: ["tests"],
				reviewerArtifact: true,
				maxRevisions: 1,
				intervention: {
					choices: [
						{ choice_id: "ship", label: "Approve closed change", route: "approve" },
						{ choice_id: "revise", label: "Request revision", route: "reject" },
						{ choice_id: "notes", label: "Just notes" },
					],
				},
			}) as any,
		},
		sessionModel: model,
	});
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(fix.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "r1", brief: "Modify auth", authority });
	const run = await open()({ action: "launch", factory_id: factory.factory_id, authority });

	const startW = (node: string) => {
		const dir = join(fix.cwd, ".pi", "agent-sessions", run.task_id);
		const file = readdirSync(dir).find(name => name.endsWith(`-${node}.config.json`))!;
		return workerFromConfig(t, join(dir, file), { model: { provider: "test-provider", id: "test-model" } });
	};
	const build = startW("build");
	const review = startW("review");
	const deploy = startW("deploy");
	await build.start(); await review.start(); await deploy.start();
	await build.beforeStart();

	// Attempt 1 modifies a closed file AND creates review.md BEFORE running passing check so every check passes & is current
	writeFileSync(join(fix.cwd, "auth", "token.ts"), "export const t = 2;\n");
	writeFileSync(join(fix.cwd, "review.md"), "Review notes\n");
	assert.ok(!(await build.verify({ action: "run", check_id: "tests", command: "true" })).isError);
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	// Reviewer tries to approve WITHOUT recorded human choice -> REJECTED even though reviewer approves & checks pass
	const unapproved = await review.complete({
		...SUCCESS,
		outputs: { verdict: "approve" },
		artifacts: [{ type: "file", path: "review.md" }],
	});
	assert.equal(unapproved.isError, true);
	assert.match(unapproved.content[0].text, /closed risk lane.*auth\/token\.ts.*recorded human approval/i);

	// Downstream admission also blocks if someone crafts a review result without recorded human choice!
	const deployCfg = readJson<WorkerConfig>(join(fix.cwd, ".pi", "agent-sessions", run.task_id, `${deploy.config.instance_id}.config.json`));
	const fakeAfter = captureLaneSnapshot({
		sessionDir: join(fix.cwd, ".pi", "agent-sessions", run.task_id),
		kind: "after",
		runId: run.task_id,
		reviewer: review.config.instance_id,
		nodeId: "review",
		attempt: 1,
		projectCwd: fix.cwd,
	});
	const directAdm = admission(deployCfg, {
		completion: {
			version: 8,
			task_id: run.task_id,
			delivery: "pending",
			completed_at: new Date().toISOString(),
			result: { agent_name: "second", status: "success", summary: "Fake", detail: "", outputs: { verdict: "approve" } },
			identity: { instance_id: review.config.instance_id, node_id: "review", attempt_id: `${review.config.instance_id}.1` },
		} as any,
	});
	assert.equal(directAdm.admit, false);
	if (!directAdm.admit) assert.match(directAdm.reason, /closed risk lane.*recorded human approval/i);
	rmSync(fakeAfter.path, { force: true });

	// Reviewer requests direction; human request view shows closed risk lane + paths + requirement
	const req1Wait = review.requestDirection({
		question: "Closed file touched; approve or revise?",
		reason: "Auth changed",
		choices: ["ship", "revise", "notes"],
	});
	let req1: any;
	for (let i = 0; i < 50; i++) {
		req1 = open()({ action: "requests", factory_id: factory.factory_id }).find(r => r.state === "pending");
		if (req1) break;
		await sleep(20);
	}
	assert.equal(req1.risk_lane?.lane, "closed");
	assert.deepEqual(req1.risk_lane?.deciding_paths, ["auth/token.ts"]);
	assert.match(req1.risk_lane?.requirement ?? "", /human approval choice/);

	// Mid-run .pi/bootstrap.json edit tries to remove closed rules -> does not affect frozen run
	writeProjectConfig(fix.cwd, { lanes: { contained: ["**"] } });

	open()({ action: "respond_request", factory_id: factory.factory_id, request_id: req1.request_id, response: { kind: "choice", choice_id: "revise", guidance: "Add doc too" }, authority });
	assert.ok(!(await req1Wait).isError);
	assert.ok(!(await review.complete({ ...SUCCESS, outputs: { verdict: "revise" }, artifacts: [{ type: "file", path: "review.md" }] })).isError);

	// Attempt 2: builder edits ONLY a contained file (docs/readme.md) WITHOUT reverting auth/token.ts -> cumulative loop baseline keeps lane CLOSED!
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	writeFileSync(join(fix.cwd, "docs", "readme.md"), "v2\n");
	assert.ok(!(await build.verify({ action: "run", check_id: "tests", command: "true" })).isError);
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	// Request approval for attempt 2 and grant human approval
	const req2Wait = review.requestDirection({
		question: "Attempt 2 closed file still modified; approve?",
		reason: "Docs added",
		choices: ["ship", "revise"],
	});
	let req2: any;
	for (let i = 0; i < 50; i++) {
		req2 = open()({ action: "requests", factory_id: factory.factory_id }).find(r => r.state === "pending");
		if (req2) break;
		await sleep(20);
	}
	assert.equal(req2.risk_lane?.lane, "closed");
	assert.deepEqual(req2.risk_lane?.deciding_paths, ["auth/token.ts"]);
	open()({ action: "respond_request", factory_id: factory.factory_id, request_id: req2.request_id, response: { kind: "choice", choice_id: "ship" }, authority });
	assert.ok(!(await req2Wait).isError);

	// Confirm human approval CANNOT bypass missing/tampered artifact or output contract!
	const missingArtifact = await review.complete({ ...SUCCESS, artifacts: [] });
	assert.equal(missingArtifact.isError, true);
	assert.match(missingArtifact.content[0].text, /Output\/verification contract/i);

	// Confirm human approval CANNOT bypass stale loop check!
	writeFileSync(join(fix.cwd, "docs", "readme.md"), "v3-stale\n");
	const staleCheckAttempt = await review.complete({
		...SUCCESS,
		artifacts: [{ type: "file", path: "review.md" }],
	});
	assert.equal(staleCheckAttempt.isError, true);
	assert.match(staleCheckAttempt.content[0].text, /stale/i);

	// Restore file matching verified check snapshot -> now completes and routes to deploy!
	writeFileSync(join(fix.cwd, "docs", "readme.md"), "v2\n");
	const ok = await review.complete({
		...SUCCESS,
		artifacts: [{ type: "file", path: "review.md" }],
	});
	assert.ok(!ok.isError);
	await deploy.beforeStart(notification(review, deploy));
	await deploy.deliverFollowUps();
	await deploy.complete(SUCCESS);

	const readOnly = fix.service.readOnlyReport(run.task_id, fix.cwd);
	assert.equal(readOnly.complete, true);
	const revRep = readOnly.results.find(r => r.node_id === "review")!;
	assert.equal(revRep.risk_lane?.lane, "closed");
	assert.equal(revRep.review_history?.attempts.length, 2);
	assert.equal(revRep.review_history?.attempts[0]?.risk_lane?.lane, "closed");
	assert.equal(revRep.review_history?.attempts[1]?.risk_lane?.lane, "closed");
});

test("unknown scope (corrupt/missing snapshot) classifies contained change as wide, enforces checks, and is reported", async t => {
	const fix = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fix.cwd, "docs"), { recursive: true });
	writeFileSync(join(fix.cwd, "docs", "note.md"), "v1\n");

	const open = () => factoryOperations(join(fix.root, "factories.sqlite"), fix.service, { coordinationPath: join(fix.root, "factory-coordination.sqlite") });
	const factory = open()({
		action: "publish",
		name: "unknown-scope",
		draft: { topology: "graph", task: "Unknown scope check", project_cwd: fix.cwd, agents: makeLoopNodes({ builderChecks: ["tests"] }) as any },
		sessionModel: model,
	});
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(fix.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "u1", brief: "Unknown scope", authority });
	const run = await open()({ action: "launch", factory_id: factory.factory_id, authority });

	const startW = (node: string) => {
		const dir = join(fix.cwd, ".pi", "agent-sessions", run.task_id);
		const file = readdirSync(dir).find(name => name.endsWith(`-${node}.config.json`))!;
		return workerFromConfig(t, join(dir, file), { model: { provider: "test-provider", id: "test-model" } });
	};
	const build = startW("build");
	const review = startW("review");
	await build.start(); await review.start();
	await build.beforeStart();
	writeFileSync(join(fix.cwd, "docs", "note.md"), "v2\n");
	assert.ok(!(await build.verify({ action: "run", check_id: "tests", command: "true" })).isError);
	assert.ok(!(await build.complete(SUCCESS)).isError);
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();

	// Corrupt the baseline snapshot: only a contained path changed, yet with lanes.closed active it fails closed as CLOSED (never contained/wide) and reports unknown scope!
	writeFileSync(laneBeforePath(review.config.session_dir, review.config.instance_id, 1), "{corrupt-json");

	const st = fix.service.status(run.task_id, fix.cwd);
	const revSt = st.agents.find(a => a.node_id === "review")!;
	assert.equal(revSt.risk_lane?.lane, "closed");
	assert.equal(revSt.risk_lane?.unknown_scope, true);
	assert.ok(st.worker_errors.some(e => /lane snapshot/i.test(e)));
	assert.match(formatAgentStates(st.agents), /closed.*unknown change scope/i);

	const rpt = fix.service.readOnlyReport(run.task_id, fix.cwd);
	assert.equal(rpt.complete, false);
	assert.ok(rpt.issues.some(i => /lane snapshot|unknown risk-lane/i.test(i)));

	// Deleting the baseline snapshot also stays CLOSED (not wide), and without intervention settles blocked
	rmSync(laneBeforePath(review.config.session_dir, review.config.instance_id, 1));
	const deletedApprove = await review.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.match(deletedApprove.content[0].text, /closed risk lane.*Missing baseline lane snapshot/i);
	const disp = readJson<any>(dispositionPath(review.config.session_dir, `${review.config.instance_id}.1`));
	assert.equal(disp.state, "blocked");
	assert.match(disp.reason, /closed risk lane/i);
});

test("command-node loop target captures before-snapshot and gates closed-lane approval", async t => {
	const f = serviceFixture(t, ["second"]);
	writeProjectConfig(f.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(f.cwd, "auth"), { recursive: true });
	writeFileSync(join(f.cwd, "auth", "cmd.txt"), "before\n");
	const run = await f.service.generate({
		topology: "graph",
		task: "Command loop lane",
		project_cwd: f.cwd,
		agents: [
			{
				node_id: "build",
				kind: "command",
				command: process.execPath,
				args: ["-e", `require("fs").writeFileSync(${JSON.stringify(join(f.cwd, "auth", "cmd.txt"))}, "after\\n")`],
				sub_task: "Run command",
			},
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review command change",
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 },
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
			},
			{ node_id: "deploy", persona: "second", depends_on: ["review"], sub_task: "Deploy" },
		],
	}, model);
	const buildEntry = run.pane_manifest.find(e => e.node_id === "build")!;
	const reviewEntry = run.pane_manifest.find(e => e.node_id === "review")!;
	const buildCmd = commandFromConfig(t, join(run.session_dir, `${buildEntry.instance_id}.config.json`));
	const review = workerFromConfig(t, join(run.session_dir, `${reviewEntry.instance_id}.config.json`), { model });
	await review.start();
	await buildCmd.start();
	await buildCmd.beforeStart();
	await buildCmd.waitUntilSettled();
	await review.beforeStart(notification(buildCmd, review));
	await review.deliverFollowUps();
	const res = await review.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.match(res.content[0].text, /closed risk lane.*auth\/cmd\.txt/i);
	const disp = readJson<any>(dispositionPath(run.session_dir, `${reviewEntry.instance_id}.1`));
	assert.equal(disp.state, "blocked");
	assert.match(disp.reason, /auth\/cmd\.txt/);
});

test("lanes-off admission does not read finalization; surviving mutant guards M14/M17/M23/M24, transient/corrupt DB, and factory per-launch lane freeze", async t => {
	// B4: When config.lanes is unset and no finalization argument is passed, admission() must NOT call readFinalization
	const fixOff = serviceFixture(t, ["first", "second"]);
	const offRun = await fixOff.service.generate({
		topology: "graph",
		task: "Lanes off check",
		project_cwd: fixOff.cwd,
		agents: makeLoopNodes(),
	}, model);
	const reviewInstOff = offRun.pane_manifest.find(e => e.node_id === "review")!.instance_id;
	const deployInstOff = offRun.pane_manifest.find(e => e.node_id === "deploy")!.instance_id;
	const deployCfgOff = readJson<WorkerConfig>(join(offRun.session_dir, `${deployInstOff}.config.json`));
	assert.equal(deployCfgOff.lanes, undefined);
	// Corrupt finalize file that would throw if admission() called readFinalization
	writeFileSync(join(offRun.session_dir, `${reviewInstOff}.finalize.json`), "{corrupt");
	const offDec = admission(deployCfgOff, {
		completion: {
			version: 6, task_id: offRun.task_id, delivery: "pending", completed_at: new Date().toISOString(),
			result: { agent_name: "second", status: "success", summary: "ok", detail: "", outputs: { verdict: "approve" } },
			identity: { instance_id: reviewInstOff, node_id: "review", attempt_id: `${reviewInstOff}.1` },
		} as any,
	});
	assert.equal(offDec.admit, true);

	// M14: Manifest / WorkerConfig reject `lanes` on version < 8
	assert.throws(() => parseManifest({
		version: 7, task_id: "t1", token: "tok", task: "x", project_cwd: "/tmp", session_dir: "/tmp/s",
		coms_extension: "/tmp/c.ts", topology: "graph", coms_project: "p", pane_manifest: [],
		lanes: { contained: ["docs/**"], closed: [] },
	}, "t1"), /require.*version 8|Unsupported/i);
	assert.throws(() => parseWorkerConfig({
		version: 7, task_id: "t1", token: "tok", task: "x", project_cwd: "/tmp", session_dir: "/tmp/s",
		coms_dir: "/tmp", coms_project: "p", instance_id: "a1-n", node_id: "n", persona_name: "p", persona: "p",
		tools: ["read"], expected_model: "p/m", sub_task: "s", topology: "graph", startup_message: "s", ready_timeout_ms: 1000,
		lanes: { contained: ["docs/**"], closed: [] },
	}), /require.*version 8|Unsupported/i);

	// M17 & M23 & transient/corrupt DB errors & M24 digest badge & factory per-launch lane resolution
	const fix = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fix.cwd, "docs"), { recursive: true });
	mkdirSync(join(fix.cwd, "auth"), { recursive: true });
	writeFileSync(join(fix.cwd, "docs", "a.md"), "1");
	writeFileSync(join(fix.cwd, "auth", "k.ts"), "1");

	const open = () => factoryOperations(join(fix.root, "factories.sqlite"), fix.service, { coordinationPath: join(fix.root, "factory-coordination.sqlite") });
	const factory = open()({
		action: "publish",
		name: "non-approve-intervention",
		draft: {
			topology: "graph",
			task: "Factory lane gates",
			project_cwd: fix.cwd,
			agents: makeLoopNodes({
				intervention: { choices: [{ choice_id: "notes", label: "Notes only" }] },
			}) as any,
		},
		sessionModel: model,
	});
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(fix.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "in1", brief: "Input 1", authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "in2", brief: "Input 2", authority });
	const run1 = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	const session1 = join(fix.cwd, ".pi", "agent-sessions", run1.task_id);
	const deploy1Inst = readJson<any>(join(session1, "manifest.json")).pane_manifest.find((e: any) => e.node_id === "deploy").instance_id;
	const review1Inst = readJson<any>(join(session1, "manifest.json")).pane_manifest.find((e: any) => e.node_id === "review").instance_id;
	const deploy1Cfg = readJson<WorkerConfig>(join(session1, `${deploy1Inst}.config.json`));

	// Edit .pi/bootstrap.json between inputs (while run1 is in flight): run1 manifest stays frozen with closed=["auth/**"]
	writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: [] } });
	const frozenManifest = readJson<any>(join(session1, "manifest.json"));
	assert.deepEqual(frozenManifest.lanes, { contained: ["docs/**"], closed: ["auth/**"] });

	// Review waiting before admission does NOT pay live snapshot cost in status(); once review is running, status computes risk_lane
	const preReviewStatus = fix.service.status(run1.task_id, fix.cwd);
	assert.equal(preReviewStatus.agents.find(a => a.node_id === "review")?.risk_lane, undefined);

	// M17: liveIfNoAfterSnapshot:false with missing after-snapshot fails closed (closed -> blocked; also no before-snapshot yet -> missing before & after)
	const fakeReviewComp = {
		version: 8, task_id: run1.task_id, delivery: "pending", completed_at: new Date().toISOString(),
		result: { agent_name: "second", status: "success", summary: "ok", detail: "", outputs: { verdict: "approve" } },
		identity: { instance_id: review1Inst, node_id: "review", attempt_id: `${review1Inst}.1` },
	} as any;
	captureLaneSnapshot({
		sessionDir: session1, kind: "before", runId: run1.task_id, reviewer: review1Inst, nodeId: "review", attempt: 1, projectCwd: fix.cwd,
	});
	// Missing after-snapshot forces unknown scope -> closed (with lanes.closed)
	// First, test M23 (factory_managed node with intervention lacking route: "approve") when auth/k.ts is touched
	writeFileSync(join(fix.cwd, "auth", "k.ts"), "2");
	captureLaneSnapshot({
		sessionDir: session1, kind: "after", runId: run1.task_id, reviewer: review1Inst, nodeId: "review", attempt: 1, projectCwd: fix.cwd,
	});
	const m23 = admission(deploy1Cfg, { completion: fakeReviewComp });
	assert.equal(m23.admit, false);
	if (!m23.admit) {
		assert.equal(m23.outcome, "blocked");
		assert.match(m23.reason, /not intervention-enabled for human approval/);
	}
	// Remove after-snapshot -> M17 missing after-snapshot also blocks as closed!
	rmSync(laneAfterPath(session1, review1Inst, 1));
	const m17 = admission(deploy1Cfg, { completion: fakeReviewComp });
	assert.equal(m17.admit, false);
	if (!m17.admit) assert.equal(m17.outcome, "blocked");

	// Corrupt state DB during closed-lane admission must throw (settling needs_attention in worker, NOT permanently blocked)
	const dbPath = deploy1Cfg.factory_managed!.state_db_path;
	const origDb = readFileSync(dbPath);
	writeFileSync(dbPath, "not-a-sqlite-db");
	assert.throws(() => admission(deploy1Cfg, { completion: fakeReviewComp }));
	writeFileSync(dbPath, origDb);

	// Exclusive transaction lock (SQLITE_BUSY) must yield "wait" (NOT permanent "blocked")
	const lockDb = new DatabaseSync(dbPath);
	lockDb.exec("BEGIN EXCLUSIVE");
	try {
		const busyDec = admission(deploy1Cfg, { completion: fakeReviewComp });
		assert.equal(busyDec.admit, false);
		if (!busyDec.admit) assert.equal(busyDec.outcome, "wait");
	} finally {
		lockDb.exec("ROLLBACK");
		lockDb.close();
	}

	// Settle run1 cleanly so input 2 launches under the edited .pi/bootstrap.json (same factory version does not pin lanes!)
	const m24Digest = formatReportDigest([
		{
			agent_name: "second",
			node_id: "review",
			status: "success",
			summary: "Approved",
			detail: "",
			risk_lane: { lane: "wide", deciding_paths: ["src/a.ts"], requirement: "declared required checks passing and current" },
		},
	]);
	assert.match(m24Digest, /\[lane: wide \(paths: src\/a\.ts; requires: declared required checks passing and current\)\]/);

	// Settle run1 cleanly so input 2 launches under the edited .pi/bootstrap.json (same factory version does not pin lanes!)
	const w1Build = workerFromConfig(t, join(session1, `${frozenManifest.pane_manifest.find((e: any) => e.node_id === "build").instance_id}.config.json`), { model });
	const w1Rev = workerFromConfig(t, join(session1, `${review1Inst}.config.json`), { model });
	const w1Dep = workerFromConfig(t, join(session1, `${deploy1Inst}.config.json`), { model });
	await w1Build.start();
	await w1Rev.start();
	await w1Dep.start();
	await w1Build.beforeStart();
	assert.ok(!(await w1Build.complete({ status: "failure", summary: "fail run1", detail: "end run1" })).isError);
	for (let i = 0; i < 60; i++) {
		if ((await open()({ action: "settle_run", factory_id: factory.factory_id, authority })).settled) break;
		await sleep(50);
	}
	const run2 = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	const session2Manifest = readJson<any>(join(fix.cwd, ".pi", "agent-sessions", run2.task_id, "manifest.json"));
	assert.deepEqual(session2Manifest.lanes, { contained: ["docs/**"], closed: [] });
});
