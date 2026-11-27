import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
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
	prepareLaneSnapshot,
	readLaneSnapshotSafe,
	validateLaneConfig,
	writePreparedLaneSnapshot,
} from "./lanes.ts";
import { admission, evaluateJoinAdmission, isCorruptDbError, isTransientDbError, LaneDirectionDbError } from "./node-admission.ts";
import { globToRegExp } from "./ownership.ts";
import { MAX_SNAPSHOT_HASH_CACHE_ENTRIES, snapshotScope, type SnapshotFileCacheEntry } from "./verification.ts";
import { buildMarkdownReport, formatAgentStates, formatPlan, formatReportDigest } from "./reporting.ts";
import { atomicJson, dispositionPath, parseDisposition, parseManifest, parseWorkerConfig, readJson, resultPath, type BootstrapResult, type WorkerConfig } from "./session-store.ts";
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

test("dry-run warns when risk-lane loop snapshots can include concurrent writers", t => {
	const f = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(f.cwd, { lanes: { contained: ["src/**"] } });
	const parallelLoops = [
		{ node_id: "build-a", persona: "first", write_paths: ["src/a/**"], sub_task: "Build A" },
		{
			node_id: "review-a", persona: "second", depends_on: ["build-a"], write_paths: ["src/a/**"], sub_task: "Review A",
			output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "revise"] } } },
			decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build-a" },
		},
		{ node_id: "build-b", persona: "first", write_paths: ["src/b/**"], sub_task: "Build B" },
		{
			node_id: "review-b", persona: "second", depends_on: ["build-b"], write_paths: ["src/b/**"], sub_task: "Review B",
			output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "revise"] } } },
			decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build-b" },
		},
	];
	const concurrent = f.service.plan({ topology: "graph", task: "Concurrent loops", project_cwd: f.cwd, agents: parallelLoops }, model);
	const warnings = concurrent.warnings?.filter(value => /shared-checkout risk lane warning/i.test(value)) ?? [];
	assert.equal(warnings.length, 2, "emit one aggregate lane warning for each affected loop");
	for (const warning of warnings) {
		assert.match(warning, /review-a|review-b/);
		assert.match(warning, /whole repository/i);
		assert.match(warning, /count.*edits.*escalat/i);
	}
	assert.match(warnings.find(value => /review-a/.test(value)) ?? "", /review-b/);
	assert.match(warnings.find(value => /review-b/.test(value)) ?? "", /review-a/);
	assert.match(formatPlan(concurrent), /warning: .*shared-checkout risk lane warning/i);

	const parallelLoopAndWriter = f.service.plan({
		topology: "graph", task: "Loop with parallel writer", project_cwd: f.cwd,
		agents: [
			{ ...parallelLoops[0] }, { ...parallelLoops[1] },
			{ node_id: "other-writer", persona: "first", write_paths: ["src/other.ts"], sub_task: "Edit another file" },
		],
	}, model);
	const loopWriterWarnings = parallelLoopAndWriter.warnings?.filter(value => /shared-checkout risk lane warning/i.test(value)) ?? [];
	assert.equal(loopWriterWarnings.length, 1);
	assert.match(loopWriterWarnings[0], /review-a.*other-writer|other-writer.*review-a/i);

	const serializedLoopAndWriter = f.service.plan({
		topology: "graph", task: "Serialized loop and writer", project_cwd: f.cwd,
		agents: [
			{ ...parallelLoops[0], write_paths: ["src/shared/**"] },
			{ ...parallelLoops[1], write_paths: undefined, read_paths: ["src/shared/**"] },
			{ node_id: "other-writer", persona: "first", write_paths: ["src/shared/other.ts"], sub_task: "Edit shared file" },
		],
	}, model);
	assert.doesNotMatch(formatPlan(serializedLoopAndWriter), /shared-checkout risk lane warning/i);

	const reviewerWaitingForWriter = f.service.plan({
		topology: "graph", task: "Loop starts before reviewer waits", project_cwd: f.cwd,
		agents: [
			{ node_id: "outside", persona: "first", write_paths: ["src/shared/**"], required_checks: ["outside-check"], sub_task: "Write shared files" },
			{ node_id: "build", persona: "first", write_paths: ["src/other/**"], required_checks: ["build-check"], sub_task: "Build other files" },
			{
				node_id: "review", persona: "second", depends_on: ["build"], write_paths: ["src/shared/**"], sub_task: "Review",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build" },
			},
		],
	}, model);
	assert.match(formatPlan(reviewerWaitingForWriter), /shared-checkout risk lane warning/i);
	assert.match(formatPlan(reviewerWaitingForWriter), /shared-checkout verification warning/i);

	const readOnlyLoops = f.service.plan({
		topology: "graph", task: "Concurrent read-only loops", project_cwd: f.cwd,
		agents: parallelLoops.map(node => ({ ...node, write_paths: undefined, read_paths: ["src/**"] })),
	}, model);
	assert.doesNotMatch(formatPlan(readOnlyLoops), /shared-checkout risk lane warning/i);

	const oneWritableLoop = f.service.plan({
		topology: "graph", task: "Concurrent loop with one read-only body", project_cwd: f.cwd,
		agents: parallelLoops.map(node => node.node_id.endsWith("-b") || node.node_id === "review-b"
			? { ...node, write_paths: undefined, read_paths: ["src/**"] }
			: node),
	}, model);
	const oneWritableWarnings = oneWritableLoop.warnings?.filter(value => /shared-checkout risk lane warning/i.test(value)) ?? [];
	assert.equal(oneWritableWarnings.length, 1);
	assert.match(oneWritableWarnings[0], /review-b/);
	assert.match(oneWritableWarnings[0], /review-a/);

	const serialLoops = f.service.plan({
		topology: "graph", task: "Serial loops", project_cwd: f.cwd,
		agents: [
			{ node_id: "build-a", persona: "first", sub_task: "Build A" },
			{ ...parallelLoops[1], depends_on: ["build-a"] },
			{ node_id: "build-b", persona: "first", depends_on: ["review-a"], sub_task: "Build B" },
			{ ...parallelLoops[3], depends_on: ["build-b"] },
		],
	}, model);
	assert.doesNotMatch(formatPlan(serialLoops), /shared-checkout risk lane warning/i);

	writeProjectConfig(f.cwd, {});
	const noLanes = f.service.plan({ topology: "graph", task: "No lanes", project_cwd: f.cwd, agents: parallelLoops }, model);
	assert.doesNotMatch(formatPlan(noLanes), /shared-checkout risk lane warning/i);
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
	assert.equal(res.details.status, "blocked");
	assert.equal("terminate" in res, false, "blocked risk-lane return must keep turn open");
	assert.equal(review.shutdowns, 1);
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
	assert.equal("terminate" in unapproved, false, "unapproved closed-lane error must keep turn open");
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

	// Corrupt state DB during closed-lane admission must throw LaneDirectionDbError (settling needs_attention in worker/command-runner, NOT failure/blocked/fail_fast)
	const dbPath = deploy1Cfg.factory_managed!.state_db_path;
	const origDb = readFileSync(dbPath);
	writeFileSync(dbPath, "not-a-sqlite-db");
	assert.throws(() => admission(deploy1Cfg, { completion: fakeReviewComp }), err => err instanceof LaneDirectionDbError);
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

test("B1-B5: pre-planted after-snapshot refusal, transient/corrupt DB handoffs, surviving mutants, worker snapshot failures, and nits", async t => {
	// B1: writePreparedLaneSnapshot refuses mismatched existing after-file, assessRiskLane(liveIfNoAfterSnapshot:true) treats mismatch as unknown scope -> closed
	const root = mkdtempSync(join(tmpdir(), "bootstrap-lanes-b-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const proj = join(root, "proj");
	const sess = join(proj, ".pi", "agent-sessions", "run-b1");
	mkdirSync(join(proj, "docs"), { recursive: true });
	mkdirSync(join(proj, "auth"), { recursive: true });
	mkdirSync(sess, { recursive: true });
	writeFileSync(join(proj, "docs", "readme.md"), "v1");
	writeFileSync(join(proj, "auth", "secret.ts"), "v1");
	const lanes = validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["docs/**"], closed: ["auth/**"] })!;
	captureLaneSnapshot({ sessionDir: sess, kind: "before", runId: "run-b1", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj });

	// Agent edits closed file, then pre-plants a clean-tree after-snapshot with a valid sha256
	const forgedCleanSnap = prepareLaneSnapshot({ sessionDir: sess, kind: "after", runId: "run-b1", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj });
	writeFileSync(join(proj, "auth", "secret.ts"), "modified-closed");
	writePreparedLaneSnapshot(forgedCleanSnap); // plants the stale/forged after-snapshot

	// Live assessment sees mismatch vs live working tree -> unknown scope -> closed
	const liveMismatch = assessRiskLane({ sessionDir: sess, runId: "run-b1", projectCwd: proj, lanes, reviewerInstance: "a2-rev", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: true });
	assert.equal(liveMismatch.lane, "closed");
	assert.equal(liveMismatch.unknown_scope, true);
	assert.match(liveMismatch.reason ?? "", /does not match live working tree/);

	// Worker prepare + writePreparedLaneSnapshot refuses the mismatched existing after-file
	const workerPrepared = prepareLaneSnapshot({ sessionDir: sess, kind: "after", runId: "run-b1", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj });
	assert.throws(() => writePreparedLaneSnapshot(workerPrepared), /does not match what the worker would write/);

	// Matching existing after-file (same snapshot files/state) succeeds idempotently (returns false without throwing)
	const matchingPrepared = prepareLaneSnapshot({ sessionDir: sess, kind: "after", runId: "run-b1", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj });
	rmSync(laneAfterPath(sess, "a2-rev", 1));
	assert.equal(writePreparedLaneSnapshot(matchingPrepared), true);
	assert.equal(writePreparedLaneSnapshot(workerPrepared), false);

	// B1 end-to-end with worker: pre-planted clean after-snapshot on non-intervention closed-lane run settles blocked (unknown scope -> closed)
	const fixB1 = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fixB1.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fixB1.cwd, "docs"), { recursive: true });
	mkdirSync(join(fixB1.cwd, "auth"), { recursive: true });
	writeFileSync(join(fixB1.cwd, "docs", "a.md"), "1");
	writeFileSync(join(fixB1.cwd, "auth", "a.ts"), "1");
	const runB1 = await fixB1.service.generate({ topology: "graph", task: "Pre-planted after refusal", project_cwd: fixB1.cwd, agents: makeLoopNodes() }, model);
	const wB1Build = workerFromConfig(t, join(runB1.session_dir, `${runB1.pane_manifest.find(e => e.node_id === "build")!.instance_id}.config.json`), { model });
	const wB1Rev = workerFromConfig(t, join(runB1.session_dir, `${runB1.pane_manifest.find(e => e.node_id === "review")!.instance_id}.config.json`), { model });
	await wB1Build.start(); await wB1Rev.start();
	await wB1Build.beforeStart();
	const prePlanted = prepareLaneSnapshot({ sessionDir: runB1.session_dir, kind: "after", runId: runB1.task_id, reviewer: wB1Rev.config.instance_id, nodeId: "review", attempt: 1, projectCwd: fixB1.cwd });
	writeFileSync(join(fixB1.cwd, "docs", "a.md"), "2");
	assert.ok(!(await wB1Build.complete(SUCCESS)).isError);
	writePreparedLaneSnapshot(prePlanted);
	await wB1Rev.beforeStart(notification(wB1Build, wB1Rev));
	await wB1Rev.deliverFollowUps();
	const b1Res = await wB1Rev.complete({ ...SUCCESS, outputs: { verdict: "approve" } });
	assert.equal(b1Res.isError, undefined);
	assert.equal(b1Res.details.status, "blocked");
	assert.equal(parseDisposition(readJson(dispositionPath(runB1.session_dir, `${wB1Rev.config.instance_id}.1`)), { run_id: runB1.task_id, instance_id: wB1Rev.config.instance_id }).state, "blocked");

	// B3: M18b >5000 files so closed path `zzz-auth/secret.ts` falls past cutoff -> incomplete after-snapshot fails closed as closed
	const proj5k = join(root, "proj5k");
	const sess5k = join(root, "sess5k");
	mkdirSync(join(proj5k, "zzz-auth"), { recursive: true });
	mkdirSync(sess5k, { recursive: true });
	const lanes5k = validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["a-*"], closed: ["zzz-auth/**"] })!;
	captureLaneSnapshot({ sessionDir: sess5k, kind: "before", runId: "run-5k", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj5k });
	for (let i = 0; i < 5005; i++) {
		writeFileSync(join(proj5k, `a-${String(i).padStart(4, "0")}.txt`), "");
	}
	writeFileSync(join(proj5k, "zzz-auth", "secret.ts"), "secret");
	captureLaneSnapshot({ sessionDir: sess5k, kind: "after", runId: "run-5k", reviewer: "a2-rev", nodeId: "review", attempt: 1, projectCwd: proj5k });
	const res5k = assessRiskLane({ sessionDir: sess5k, runId: "run-5k", projectCwd: proj5k, lanes: lanes5k, reviewerInstance: "a2-rev", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: false });
	assert.equal(res5k.lane, "closed");
	assert.equal(res5k.unknown_scope, true);
	assert.match(res5k.reason ?? "", /5000 files/);

	// B3: typeof raw.snapshot_sha256 !== "string" (missing and non-string)
	const missingDigestRec = readJson<any>(laneBeforePath(sess, "a2-rev", 1));
	delete missingDigestRec.snapshot_sha256;
	const missingDigestFile = join(root, "missing-digest.json");
	writeFileSync(missingDigestFile, JSON.stringify(missingDigestRec));
	const missingDigestRes = readLaneSnapshotSafe(missingDigestFile, { kind: "before", runId: "run-b1", reviewer: "a2-rev", attempt: 1, projectCwd: proj });
	assert.match(missingDigestRes.error ?? "", /missing snapshot_sha256/);
	writeFileSync(missingDigestFile, JSON.stringify({ ...missingDigestRec, snapshot_sha256: 12345 }));
	assert.match(readLaneSnapshotSafe(missingDigestFile, { kind: "before", runId: "run-b1", reviewer: "a2-rev", attempt: 1, projectCwd: proj }).error ?? "", /missing snapshot_sha256/);

	// B3: live-snapshot catch (lanes.ts:582)
	rmSync(laneAfterPath(sess, "a2-rev", 1));
	const catchPastSec = Math.floor((Date.now() - 10_000) / 1000);
	utimesSync(join(proj, "docs", "readme.md"), catchPastSec, catchPastSec);
	utimesSync(join(proj, "auth", "secret.ts"), catchPastSec, catchPastSec);
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 10_000 });
	const catchRes = assessRiskLane({
		sessionDir: sess, runId: "run-b1", projectCwd: proj, lanes,
		reviewerInstance: "a2-rev", reviewerNodeId: "review", attempt: 1, liveIfNoAfterSnapshot: true,
		fileHashCache: { get() { throw new Error("cache boom"); } } as unknown as Map<string, SnapshotFileCacheEntry>,
	});
	t.mock.timers.reset();
	assert.equal(catchRes.lane, "closed");
	assert.equal(catchRes.unknown_scope, true);
	assert.match(catchRes.reason ?? "", /Failed live risk-lane snapshot.*cache boom/);

	// B3: (?!/) in globToRegExp (ownership.ts:218)
	assert.equal(globToRegExp("a[!b]c").test("a/c"), false);
	assert.equal(globToRegExp("a[!b]c").test("axc"), true);
	assert.equal(globToRegExp("src/[!a]b.ts").test("src//b.ts"), false);
	assert.equal(globToRegExp("src/[!a]b.ts").test("src/xb.ts"), true);

	// B3 & B5: verification.ts cache age, ctime guards, and bounded LRU eviction
	const cacheDir = join(root, "cache-proj");
	mkdirSync(cacheDir, { recursive: true });
	const cacheFileA = join(cacheDir, "a.txt");
	const cacheFileB = join(cacheDir, "b.txt");
	const cacheFileC = join(cacheDir, "c.txt");
	writeFileSync(cacheFileA, "aaaa");
	writeFileSync(cacheFileB, "bbbb");
	writeFileSync(cacheFileC, "cccc");
	// Fresh file (<2000ms) must NOT be served from cache on same-size overwrite
	const freshCache = new Map<string, SnapshotFileCacheEntry>();
	const fresh1 = snapshotScope(cacheDir, undefined, { fileHashCache: freshCache });
	assert.equal(freshCache.size, 0, "fresh files (<2000ms) must not populate cache");
	writeFileSync(cacheFileA, "a222");
	const fresh2 = snapshotScope(cacheDir, undefined, { fileHashCache: freshCache });
	assert.notEqual(fresh2.files["a.txt"].sha256, fresh1.files["a.txt"].sha256);

	// Old file (>2000ms via mocked Date.now) populates cache, detects ctime change even when mtime is backdated, and evicts LRU
	const pastSec = Math.floor((Date.now() - 10_000) / 1000);
	utimesSync(cacheFileA, pastSec, pastSec);
	utimesSync(cacheFileB, pastSec, pastSec);
	utimesSync(cacheFileC, pastSec, pastSec);
	// Make ctime appear > 2000ms old via mocked Date.now, then update fileA while preserving mtime (ctime changes)
	const realNow = Date.now();
	t.mock.timers.enable({ apis: ["Date"], now: realNow + 10_000 });
	const lruCache = new Map<string, SnapshotFileCacheEntry>();
	const snapOld = snapshotScope(cacheDir, undefined, { fileHashCache: lruCache, maxFileHashCacheEntries: 2 });
	assert.equal(lruCache.size, 2, "LRU cache must stay bounded by maxFileHashCacheEntries");
	assert.deepEqual([...lruCache.keys()], [cacheFileB, cacheFileC], "a.txt evicted as oldest");
	assert.equal(MAX_SNAPSHOT_HASH_CACHE_ENTRIES, 10_000);

	// LRU recency-on-hit: touching A promotes A above B so scanning C evicts B rather than A
	const lruHitCache = new Map<string, SnapshotFileCacheEntry>();
	snapshotScope(cacheDir, ["a.txt", "b.txt"], { fileHashCache: lruHitCache, maxFileHashCacheEntries: 2 });
	snapshotScope(cacheDir, ["a.txt"], { fileHashCache: lruHitCache, maxFileHashCacheEntries: 2 });
	snapshotScope(cacheDir, ["c.txt"], { fileHashCache: lruHitCache, maxFileHashCacheEntries: 2 });
	assert.deepEqual([...lruHitCache.keys()], [cacheFileA, cacheFileC], "touching a.txt must move it to MRU so b.txt is evicted");

	// Default cache bound (10,000 entries when maxFileHashCacheEntries is omitted)
	const defaultCapCache = new Map<string, SnapshotFileCacheEntry>();
	for (let i = 0; i < MAX_SNAPSHOT_HASH_CACHE_ENTRIES; i++) {
		defaultCapCache.set(`/dummy-cache/${i}`, { dev: 1, ino: i, size: 1, mtimeMs: 0, ctimeMs: 0, sha256: "0".repeat(64) });
	}
	snapshotScope(cacheDir, ["a.txt"], { fileHashCache: defaultCapCache });
	assert.equal(defaultCapCache.size, MAX_SNAPSHOT_HASH_CACHE_ENTRIES, "default cache cap must evict beyond MAX_SNAPSHOT_HASH_CACHE_ENTRIES");
	assert.equal(defaultCapCache.has("/dummy-cache/0"), false);

	// Overwrite b.txt with same length and backdate mtime to match old mtime; ctime is realNow (so nowMs - ctimeMs >= 10_000 still passes age guard, testing cached.ctimeMs !== stat.ctimeMs!)
	const prevBStat = readJson<any>; // just use fs stat via utimesSync back to pastSec
	void prevBStat;
	writeFileSync(cacheFileB, "b222");
	utimesSync(cacheFileB, pastSec, pastSec);
	const snapCtime = snapshotScope(cacheDir, undefined, { fileHashCache: lruCache, maxFileHashCacheEntries: 2 });
	assert.notEqual(snapCtime.files["b.txt"].sha256, snapOld.files["b.txt"].sha256, "ctimeMs change must invalidate cache even when size and mtimeMs match");
	t.mock.timers.reset();

	// Also verify age guard blocks cache hit when ctime is < 2000ms old even if mtime is old
	const ctimeAgeCache = new Map<string, SnapshotFileCacheEntry>();
	writeFileSync(cacheFileA, "1111");
	utimesSync(cacheFileA, pastSec, pastSec);
	// Pretend cache had an entry with same mtimeMs while current ctimeMs is < 2000ms old
	snapshotScope(cacheDir, undefined, { fileHashCache: ctimeAgeCache });
	assert.equal(ctimeAgeCache.size, 0, "ctimeMs < 2000ms must prevent caching even when mtimeMs is old");

	// B5: empty brace alternative rejected; conservative B3 excluded-dir patterns rejected
	assert.throws(() => validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["{,src}/x"] }), /empty brace alternative/);
	assert.throws(() => validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["{src,}/x"] }), /empty brace alternative/);
	assert.throws(() => validateLaneConfig("/p/.pi/bootstrap.json", { contained: ["a/{b,,c}/x"] }), /empty brace alternative/);
	for (const overRejected of [".p?/agent-sessions/**", ".pi/*-sessions/**", ".pi/agent-sessions*", ".gi?/**"]) {
		assert.throws(() => validateLaneConfig("/p/.pi/bootstrap.json", { contained: [overRejected] }), /excluded snapshot directory/);
	}

	// B2 & B3: transient DB error (by error code), blocked-error classification regex, join wait branch, and corrupt-DB needs_attention at worker & command-runner handoff sites
	assert.equal(isTransientDbError(Object.assign(new Error("unusual message"), { errcode: 5 })), true);
	assert.equal(isTransientDbError(Object.assign(new Error("unusual message"), { errcode: 261 })), true); // SQLITE_BUSY_RECOVERY
	assert.equal(isTransientDbError(Object.assign(new Error("unusual message"), { errcode: 6 })), true); // SQLITE_LOCKED
	assert.equal(isTransientDbError(Object.assign(new Error("unusual message"), { code: "SQLITE_BUSY" })), true);
	assert.equal(isTransientDbError(Object.assign(new Error("unusual message"), { errcode: 26 })), false); // SQLITE_NOTADB
	assert.equal(isCorruptDbError(Object.assign(new Error("numeric errcode corrupt"), { errcode: 26 })), true);
	assert.equal(isCorruptDbError(Object.assign(new Error("numeric errcode busy"), { errcode: 5 })), false);

	// B1 laneSnapshotMatches symlinks clause: matching files cleanly while differing ONLY in symlinks must be refused
	const symSnapDir = mkdtempSync(join(tmpdir(), "bootstrap-lane-sym-match-"));
	t.after(() => rmSync(symSnapDir, { recursive: true, force: true }));
	const symProj = join(symSnapDir, "proj");
	const symSess = join(symSnapDir, "sess");
	mkdirSync(symProj, { recursive: true });
	mkdirSync(symSess, { recursive: true });
	writeFileSync(join(symProj, "f.txt"), "ok");
	const symPrepared = prepareLaneSnapshot({
		sessionDir: symSess,
		kind: "after",
		runId: "r-sym",
		reviewer: "rev",
		nodeId: "rev",
		attempt: 1,
		projectCwd: symProj,
	});
	const mismatchedSymlinksRecord = { ...symPrepared.record, symlinks: { "evil-link": "/outside" } };
	assert.throws(() => {
		writeFileSync(symPrepared.path, JSON.stringify(mismatchedSymlinksRecord));
		writePreparedLaneSnapshot(symPrepared);
	}, /does not match/);

	const fixDb = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fixDb.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fixDb.cwd, "docs"), { recursive: true });
	mkdirSync(join(fixDb.cwd, "auth"), { recursive: true });
	writeFileSync(join(fixDb.cwd, "docs", "a.md"), "1");
	writeFileSync(join(fixDb.cwd, "auth", "k.ts"), "1");
	const openDb = () => factoryOperations(join(fixDb.root, "factories.sqlite"), fixDb.service, { coordinationPath: join(fixDb.root, "factory-coordination.sqlite") });
	const facDb = openDb()({
		action: "publish",
		name: "handoff-db-lanes",
		draft: {
			topology: "graph",
			failure_policy: "fail_fast",
			task: "DB handoff tests",
			project_cwd: fixDb.cwd,
			agents: [
				...makeLoopNodes({ intervention: { choices: [{ choice_id: "ship", label: "Approve", route: "approve" }] } }),
				{
					kind: "command",
					node_id: "deploy_cmd",
					depends_on: ["review"],
					command: process.execPath,
					args: ["-e", "console.log(JSON.stringify({ deployed: true }))"],
				},
			],
		} as any,
		sessionModel: model,
	});
	const authDb = createManagerAuthority({ pi_session_id: "mgr-db", pi_session_file: join(fixDb.root, "mgr-db.jsonl") });
	openDb()({ action: "resume", factory_id: facDb.factory_id, authority: authDb });
	openDb()({ action: "submit", factory_id: facDb.factory_id, reference: "in-db", brief: "Run db test", authority: authDb });
	const runDb = await openDb()({ action: "launch", factory_id: facDb.factory_id, authority: authDb });
	const sessDb = join(fixDb.cwd, ".pi", "agent-sessions", runDb.task_id);
	const manDb = readJson<any>(join(sessDb, "manifest.json"));
	const bInst = manDb.pane_manifest.find((e: any) => e.node_id === "build").instance_id;
	const rInst = manDb.pane_manifest.find((e: any) => e.node_id === "review").instance_id;
	const dInst = manDb.pane_manifest.find((e: any) => e.node_id === "deploy").instance_id;
	const cInst = manDb.pane_manifest.find((e: any) => e.node_id === "deploy_cmd").instance_id;

	const wB = workerFromConfig(t, join(sessDb, `${bInst}.config.json`), { model });
	const wR = workerFromConfig(t, join(sessDb, `${rInst}.config.json`), { model });
	const wD = workerFromConfig(t, join(sessDb, `${dInst}.config.json`), { model });
	const cD = commandFromConfig(t, join(sessDb, `${cInst}.config.json`), { pollMs: 25 });
	await wB.start(); await wR.start(); await wD.start(); await cD.start();
	await wB.beforeStart();
	writeFileSync(join(fixDb.cwd, "auth", "k.ts"), "2");
	assert.ok(!(await wB.complete(SUCCESS)).isError);
	await wR.beforeStart(notification(wB, wR));
	await wR.deliverFollowUps();
	const dirWait = wR.requestDirection({ question: "Approve?", reason: "Auth edited", choices: ["ship"] });
	let dirReq: any;
	for (let i = 0; i < 50; i++) {
		dirReq = openDb()({ action: "requests", factory_id: facDb.factory_id }).find(r => r.state === "pending");
		if (dirReq) break;
		await sleep(20);
	}
	openDb()({ action: "respond_request", factory_id: facDb.factory_id, request_id: dirReq.request_id, response: { kind: "choice", choice_id: "ship" }, authority: authDb });
	assert.ok(!(await dirWait).isError);
	assert.ok(!(await wR.complete({ ...SUCCESS, outputs: { verdict: "approve" } })).isError);

	// B3: blocked-error classification regex (undelivered delivery -> blocked, missing approval binding -> blocked)
	const dbFile = wD.config.factory_managed!.state_db_path;
	const sqlite = new DatabaseSync(dbFile);
	const savedDelivery = sqlite.prepare("SELECT request_id, record_digest FROM factory_direction_deliveries WHERE request_id = ?").get(dirReq.request_id) as { request_id: string; record_digest: string };
	sqlite.prepare("DELETE FROM factory_direction_deliveries WHERE request_id = ?").run(dirReq.request_id);
	const notReceivedAdm = admission(wD.config, { completion: readJson(resultPath(sessDb, `${rInst}.1`)) });
	assert.equal(notReceivedAdm.admit, false);
	if (!notReceivedAdm.admit) {
		assert.equal(notReceivedAdm.outcome, "blocked");
		assert.match(notReceivedAdm.reason, /cannot route:.*was not received/);
	}
	sqlite.prepare("INSERT INTO factory_direction_deliveries (request_id, record_digest) VALUES (?, ?)").run(savedDelivery.request_id, savedDelivery.record_digest);

	const savedApproval = sqlite.prepare("SELECT attempt_id, node_id, node_attempt_id, request_id, record_digest FROM factory_direction_approvals WHERE request_id = ?").get(dirReq.request_id) as {
		attempt_id: string; node_id: string; node_attempt_id: string; request_id: string; record_digest: string;
	};
	sqlite.prepare("DELETE FROM factory_direction_approvals WHERE request_id = ?").run(dirReq.request_id);
	const missingBindingAdm = admission(wD.config, { completion: readJson(resultPath(sessDb, `${rInst}.1`)) });
	assert.equal(missingBindingAdm.admit, false);
	if (!missingBindingAdm.admit) {
		assert.equal(missingBindingAdm.outcome, "blocked");
		assert.match(missingBindingAdm.reason, /cannot route:.*Missing or contradictory approval binding/);
	}
	sqlite.prepare("INSERT INTO factory_direction_approvals (attempt_id, node_id, node_attempt_id, request_id, record_digest) VALUES (?, ?, ?, ?, ?)").run(
		savedApproval.attempt_id, savedApproval.node_id, savedApproval.node_attempt_id, savedApproval.request_id, savedApproval.record_digest,
	);
	sqlite.close();

	// B2 & B3: SQLITE_BUSY at handoff time (both join admission AND worker/command-runner handoffs) waits without failing or triggering fail_fast, then retries & succeeds
	const busyLock = new DatabaseSync(dbFile);
	busyLock.exec("BEGIN EXCLUSIVE");
	const joinWait = evaluateJoinAdmission({ ...wD.config, inbound_edges: [rInst] }, [rInst]);
	assert.deepEqual(joinWait, { outcome: "wait", pendingSources: [rInst] });

	await wD.beforeStart(notification(wR, wD));
	await cD.beforeStart(notification(wR, cD));
	const ffPath = join(sessDb, "fail-fast.json");
	assert.equal(existsSync(ffPath), false, `transient SQLITE_BUSY must not trigger fail_fast: ${existsSync(ffPath) ? readFileSync(ffPath, "utf8") : ""}`);
	assert.equal(existsSync(join(sessDb, `${dInst}.error.json`)), false, "transient SQLITE_BUSY must not write error.json on worker");
	assert.equal(existsSync(join(sessDb, `${dInst}.1.error.json`)), false, "transient SQLITE_BUSY must not write error.json on worker");
	assert.equal(existsSync(join(sessDb, `${cInst}.error.json`)), false, "transient SQLITE_BUSY must not write error.json on command-runner");
	assert.equal(existsSync(join(sessDb, `${cInst}.1.error.json`)), false, "transient SQLITE_BUSY must not write error.json on command-runner");
	assert.equal(existsSync(dispositionPath(sessDb, `${dInst}.1`)), false);
	assert.equal(existsSync(dispositionPath(sessDb, `${cInst}.1`)), false);
	busyLock.exec("ROLLBACK");
	busyLock.close();

	// Command-runner automatically retries and succeeds; worker retries via followUp
	await cD.waitUntilSettled();
	assert.equal(readJson<any>(resultPath(sessDb, `${cInst}.1`)).result.status, "success");
	await sleep(80);
	await wD.deliverFollowUps();
	assert.ok(!(await wD.complete(SUCCESS)).isError);

	// B2: corrupt DB at worker & command-runner handoff time settles fail-closed as needs_attention (NOT failure, NO fail-fast.json)
	const fixCorrupt = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fixCorrupt.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	mkdirSync(join(fixCorrupt.cwd, "auth"), { recursive: true });
	writeFileSync(join(fixCorrupt.cwd, "auth", "k.ts"), "1");
	const openCorrupt = () => factoryOperations(join(fixCorrupt.root, "factories.sqlite"), fixCorrupt.service, { coordinationPath: join(fixCorrupt.root, "factory-coordination.sqlite") });
	const facCorrupt = openCorrupt()({
		action: "publish",
		name: "corrupt-db-handoff",
		draft: {
			topology: "graph",
			failure_policy: "fail_fast",
			task: "Corrupt DB handoff",
			project_cwd: fixCorrupt.cwd,
			agents: [
				...makeLoopNodes({ intervention: { choices: [{ choice_id: "ship", label: "Approve", route: "approve" }] } }),
				{
					kind: "command",
					node_id: "deploy_cmd",
					depends_on: ["review"],
					command: process.execPath,
					args: ["-e", "console.log(JSON.stringify({ deployed: true }))"],
				},
			],
		} as any,
		sessionModel: model,
	});
	const authCorrupt = createManagerAuthority({ pi_session_id: "mgr-corrupt", pi_session_file: join(fixCorrupt.root, "mgr-corrupt.jsonl") });
	openCorrupt()({ action: "resume", factory_id: facCorrupt.factory_id, authority: authCorrupt });
	openCorrupt()({ action: "submit", factory_id: facCorrupt.factory_id, reference: "in-corrupt", brief: "Corrupt DB test", authority: authCorrupt });
	const runCorrupt = await openCorrupt()({ action: "launch", factory_id: facCorrupt.factory_id, authority: authCorrupt });
	const sessCorrupt = join(fixCorrupt.cwd, ".pi", "agent-sessions", runCorrupt.task_id);
	const manCorrupt = readJson<any>(join(sessCorrupt, "manifest.json"));
	const cbInst = manCorrupt.pane_manifest.find((e: any) => e.node_id === "build").instance_id;
	const crInst = manCorrupt.pane_manifest.find((e: any) => e.node_id === "review").instance_id;
	const cdInst = manCorrupt.pane_manifest.find((e: any) => e.node_id === "deploy").instance_id;
	const ccInst = manCorrupt.pane_manifest.find((e: any) => e.node_id === "deploy_cmd").instance_id;
	const wCB = workerFromConfig(t, join(sessCorrupt, `${cbInst}.config.json`), { model });
	const wCR = workerFromConfig(t, join(sessCorrupt, `${crInst}.config.json`), { model });
	const wCD = workerFromConfig(t, join(sessCorrupt, `${cdInst}.config.json`), { model });
	const cCD = commandFromConfig(t, join(sessCorrupt, `${ccInst}.config.json`), { pollMs: 25 });
	await wCB.start(); await wCR.start(); await wCD.start(); await cCD.start();
	await wCB.beforeStart();
	writeFileSync(join(fixCorrupt.cwd, "auth", "k.ts"), "2");
	assert.ok(!(await wCB.complete(SUCCESS)).isError);
	await wCR.beforeStart(notification(wCB, wCR));
	await wCR.deliverFollowUps();
	const cDirWait = wCR.requestDirection({ question: "Approve?", reason: "Auth edited", choices: ["ship"] });
	let cDirReq: any;
	for (let i = 0; i < 50; i++) {
		cDirReq = openCorrupt()({ action: "requests", factory_id: facCorrupt.factory_id }).find(r => r.state === "pending");
		if (cDirReq) break;
		await sleep(20);
	}
	openCorrupt()({ action: "respond_request", factory_id: facCorrupt.factory_id, request_id: cDirReq.request_id, response: { kind: "choice", choice_id: "ship" }, authority: authCorrupt });
	assert.ok(!(await cDirWait).isError);
	assert.ok(!(await wCR.complete({ ...SUCCESS, outputs: { verdict: "approve" } })).isError);

	// Corrupt the factory DB right before successor handoffs
	writeFileSync(wCD.config.factory_managed!.state_db_path, "not-a-sqlite-db");
	await wCD.beforeStart(notification(wCR, wCD));
	await cCD.beforeStart(notification(wCR, cCD));
	await cCD.waitUntilSettled();
	assert.equal(existsSync(join(sessCorrupt, "fail-fast.json")), false, "corrupt DB at handoff must settle needs_attention, not trigger fail_fast");
	assert.equal(parseDisposition(readJson(dispositionPath(sessCorrupt, `${cdInst}.1`)), { run_id: runCorrupt.task_id, instance_id: cdInst }).state, "needs_attention");
	assert.equal(parseDisposition(readJson(dispositionPath(sessCorrupt, `${ccInst}.1`)), { run_id: runCorrupt.task_id, instance_id: ccInst }).state, "needs_attention");

	// B4: worker after-snapshot capture failure (worker.ts:1823) and persist failure (worker.ts:1848, stops timers & shuts down)
	const fixB4 = serviceFixture(t, ["first", "second"]);
	writeProjectConfig(fixB4.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
	const runB4 = await fixB4.service.generate({ topology: "graph", task: "Worker after-snapshot capture failure", project_cwd: fixB4.cwd, agents: makeLoopNodes({ builderChecks: [] }) }, model);
	const b4Build = workerFromConfig(t, join(runB4.session_dir, `${runB4.pane_manifest.find(e => e.node_id === "build")!.instance_id}.config.json`), { model });
	const b4RevCfgPath = join(runB4.session_dir, `${runB4.pane_manifest.find(e => e.node_id === "review")!.instance_id}.config.json`);
	const b4RevCfg = readJson<WorkerConfig>(b4RevCfgPath);

	// Capture failure: isolated worker import where prepareLaneSnapshot throws
	const realLanesUrl = new URL("./lanes.ts", import.meta.url).href;
	const throwingLanesUrl = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(realLanesUrl)}; export function prepareLaneSnapshot() { throw new Error("injected capture failure"); }`)}`;
	registerHooks({
		resolve(specifier, context, next) {
			if (context.parentURL?.includes("capfail=1") && specifier === "./lanes.ts") {
				return { url: throwingLanesUrl, shortCircuit: true };
			}
			return next(specifier, context);
		},
	});
	const { default: registerWorkerCapFail } = await import("./worker.ts?capfail=1");
	const capHooks = new Map<string, Function>();
	const capTools = new Map<string, any>();
	const capFollowUps: unknown[] = [];
	let capShutdowns = 0;
	const capCtx = {
		model,
		ui: { notify: () => {} },
		shutdown: () => { capShutdowns++; },
		abort: () => {},
		executeTool: async () => ({ content: [], details: { msg_id: "cap1" } }),
	};
	registerWorkerCapFail({
		registerFlag: () => {},
		getFlag: (name: string) => name === "bootstrap-worker-config" ? b4RevCfgPath : undefined,
		on: (name: string, fn: Function) => capHooks.set(name, fn),
		registerTool: (tool: any) => capTools.set(tool.name, tool),
		sendMessage: (msg: unknown) => capFollowUps.push(msg),
		getActiveTools: () => ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"],
		getAllTools: () => ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate", "bootstrap_complete"].map(name => ({ name })),
		setActiveTools: () => {},
	} as any);
	await b4Build.start();
	await capHooks.get("session_start")!({}, capCtx);
	await b4Build.beforeStart();
	assert.ok(!(await b4Build.complete(SUCCESS)).isError);
	await capHooks.get("before_agent_start")!(notification(b4Build, { config: b4RevCfg } as any), capCtx);
	for (const message of capFollowUps.splice(0)) {
		await capHooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message }, capCtx);
	}
	const capFailRes = await capTools.get("bootstrap_complete").execute("id", { ...SUCCESS, outputs: { verdict: "revise" } }, undefined, undefined, capCtx);
	assert.equal(capFailRes.isError, true);
	assert.match(capFailRes.content[0].text, /Failed to capture post-attempt risk-lane snapshot: injected capture failure/);
	assert.equal(capShutdowns, 0, "capture failure is recoverable without shutting down");
	await capHooks.get("session_shutdown")?.({ reason: "reload" }, capCtx);

	// Persist failure: directory at lane-after.json causes writePreparedLaneSnapshot to throw after claimOutcome -> saves failure, stops timers & shuts down
	const runB4p = await fixB4.service.generate({ topology: "graph", task: "Worker after-snapshot persist failure", project_cwd: fixB4.cwd, agents: makeLoopNodes({ builderChecks: [] }) }, model);
	const p4Build = workerFromConfig(t, join(runB4p.session_dir, `${runB4p.pane_manifest.find(e => e.node_id === "build")!.instance_id}.config.json`), { model });
	const p4RevCfgPath = join(runB4p.session_dir, `${runB4p.pane_manifest.find(e => e.node_id === "review")!.instance_id}.config.json`);
	const p4RevCfg = readJson<WorkerConfig>(p4RevCfgPath);
	const wPersistFail = workerFromConfig(t, p4RevCfgPath, { model });
	await p4Build.start();
	const origSetInterval = globalThis.setInterval;
	const origClearInterval = globalThis.clearInterval;
	const activePersistIntervals = new Set<unknown>();
	let createdPersistIntervals = 0;
	globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
		const handle = origSetInterval(...args);
		activePersistIntervals.add(handle);
		createdPersistIntervals++;
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
		activePersistIntervals.delete(handle);
		return origClearInterval(handle);
	}) as typeof clearInterval;
	try {
		await wPersistFail.start();
		await p4Build.beforeStart();
		assert.ok(!(await p4Build.complete(SUCCESS)).isError);
		await wPersistFail.beforeStart(notification(p4Build, wPersistFail));
		await wPersistFail.deliverFollowUps();
		assert.ok(createdPersistIntervals > 0, "admitted worker must start periodic timers before completion");
		mkdirSync(laneAfterPath(runB4p.session_dir, p4RevCfg.instance_id, 1), { recursive: true });
		const persistFailRes = await wPersistFail.complete({ ...SUCCESS, outputs: { verdict: "revise" } });
		assert.equal(persistFailRes.isError, true);
		assert.match(persistFailRes.content[0].text, /Failed to persist post-attempt risk-lane snapshot/);
		assert.equal(wPersistFail.shutdowns, 1, "persist failure must call ctx.shutdown()");
		assert.equal(activePersistIntervals.size, 0, "persist failure must stopTimers() and clear all interval handles");
		assert.equal(readJson<any>(resultPath(runB4p.session_dir, `${p4RevCfg.instance_id}.1`)).result.status, "failure");
	} finally {
		for (const h of activePersistIntervals) origClearInterval(h as ReturnType<typeof setInterval>);
		globalThis.setInterval = origSetInterval;
		globalThis.clearInterval = origClearInterval;
	}
});

test("Blocking B2 + non-blocking worker/command-runner handoff, poll, root, non-coms, and exponential backoff guards", async t => {
	type FaultHook = {
		onVerifyFactoryReleaseAuthority?: () => void;
		onEvaluateJoinAdmission?: () => void;
		onAdmission?: () => void;
		onReadDecisionDirection?: () => void;
	};
	const faultState: FaultHook = {};
	(globalThis as Record<string, unknown>).__b2Fault = faultState;
	t.after(() => { delete (globalThis as Record<string, unknown>).__b2Fault; });

	const realAdmissionUrl = new URL("./node-admission.ts", import.meta.url).href;
	const realReqUrl = new URL("./factory-requests.ts", import.meta.url).href;
	const wrapAdmissionUrl = `data:text/javascript,${encodeURIComponent(`
		import * as real from ${JSON.stringify(`${realAdmissionUrl}?b2fault=1`)};
		export * from ${JSON.stringify(`${realAdmissionUrl}?b2fault=1`)};
		export function verifyFactoryReleaseAuthority(...args) {
			globalThis.__b2Fault?.onVerifyFactoryReleaseAuthority?.();
			return real.verifyFactoryReleaseAuthority(...args);
		}
		export function evaluateJoinAdmission(...args) {
			globalThis.__b2Fault?.onEvaluateJoinAdmission?.();
			return real.evaluateJoinAdmission(...args);
		}
		export function admission(...args) {
			globalThis.__b2Fault?.onAdmission?.();
			return real.admission(...args);
		}
	`)}`;
	const wrapReqUrl = `data:text/javascript,${encodeURIComponent(`
		import * as real from ${JSON.stringify(realReqUrl)};
		export * from ${JSON.stringify(realReqUrl)};
		export function readDecisionDirection(...args) {
			globalThis.__b2Fault?.onReadDecisionDirection?.();
			return real.readDecisionDirection(...args);
		}
	`)}`;
	registerHooks({
		resolve(specifier, context, next) {
			if (context.parentURL?.includes("b2fault=1")) {
				if (specifier === "./node-admission.ts") return { url: wrapAdmissionUrl, shortCircuit: true };
				if (specifier === "./factory-requests.ts") return { url: wrapReqUrl, shortCircuit: true };
			}
			return next(specifier, context);
		},
	});
	const { default: registerWorkerFault } = await import("./worker.ts?b2fault=1");
	const { createCommandDriver: createCmdFault } = await import("./command-runner.ts?b2fault=1");

	const makeBusyErr = () => Object.assign(new Error("database is busy (injected)"), { errcode: 5, code: "ERR_SQLITE_ERROR" });
	const makeCorruptErr = () => Object.assign(new Error("database disk image is malformed (injected)"), { errcode: 26, code: "ERR_SQLITE_ERROR" });

	const mountFaultWorker = async (cfgPath: string) => {
		const hooks = new Map<string, Function>();
		const tools = new Map<string, any>();
		const followUps: any[] = [];
		const aborts = { count: 0 };
		const shutdowns = { count: 0 };
		const ctx: any = {
			model,
			ui: { notify: () => {} },
			shutdown: () => { shutdowns.count++; },
			abort: () => { aborts.count++; },
			executeTool: async () => ({ content: [], details: { msg_id: `m-${followUps.length}` } }),
		};
		registerWorkerFault({
			registerFlag: () => {},
			getFlag: (name: string) => name === "bootstrap-worker-config" ? cfgPath : undefined,
			on: (name: string, fn: Function) => hooks.set(name, fn),
			registerTool: (tool: any) => tools.set(tool.name, tool),
			sendMessage: (msg: any) => followUps.push(msg),
			getActiveTools: () => ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate"],
			getAllTools: () => ["read", "bash", "coms_send", "coms_get", "coms_await", "bootstrap_generate", "bootstrap_complete"].map(name => ({ name })),
			setActiveTools: () => {},
		} as any);
		const cfg = readJson<WorkerConfig>(cfgPath);
		await hooks.get("session_start")!({}, ctx);
		return { hooks, tools, followUps, aborts, shutdowns, ctx, cfg };
	};

	const resetFaults = () => {
		faultState.onVerifyFactoryReleaseAuthority = undefined;
		faultState.onEvaluateJoinAdmission = undefined;
		faultState.onAdmission = undefined;
		faultState.onReadDecisionDirection = undefined;
	};

	// Helper to launch a closed-lane factory run with loop + chain worker + join worker + join command + chain command
	const setupClosedFactory = async (name: string, opts: { depWaitMs?: number } = {}) => {
		const fix = serviceFixture(t, ["first", "second"]);
		writeProjectConfig(fix.cwd, { lanes: { contained: ["docs/**"], closed: ["auth/**"] } });
		mkdirSync(join(fix.cwd, "auth"), { recursive: true });
		writeFileSync(join(fix.cwd, "auth", "k.ts"), "1");
		const open = () => factoryOperations(join(fix.root, "factories.sqlite"), fix.service, { coordinationPath: join(fix.root, "factory-coordination.sqlite") });
		const fac = open()({
			action: "publish",
			name,
			draft: {
				topology: "graph",
				failure_policy: "fail_fast",
				...(opts.depWaitMs !== undefined ? { dependency_wait_timeout_ms: opts.depWaitMs } : {}),
				task: `Fault matrix ${name}`,
				project_cwd: fix.cwd,
				agents: [
					...makeLoopNodes({ intervention: { choices: [{ choice_id: "ship", label: "Approve", route: "approve" }] } }),
					{ node_id: "side", persona: "first", sub_task: "Side root" },
					{ node_id: "chain_w", persona: "first", depends_on: ["review"], sub_task: "Chain deploy" },
					{ node_id: "join_w", persona: "first", depends_on: ["review", "side"], sub_task: "Join worker" },
					{ kind: "command", node_id: "chain_cmd", depends_on: ["review"], command: process.execPath, args: ["-e", "console.log(JSON.stringify({ ok: 1 }))"] },
					{ kind: "command", node_id: "join_cmd", depends_on: ["review", "side"], command: process.execPath, args: ["-e", "console.log(JSON.stringify({ ok: 2 }))"] },
				],
			} as any,
			sessionModel: model,
		});
		const auth = createManagerAuthority({ pi_session_id: `mgr-${name}`, pi_session_file: join(fix.root, `mgr-${name}.jsonl`) });
		open()({ action: "resume", factory_id: fac.factory_id, authority: auth });
		open()({ action: "submit", factory_id: fac.factory_id, reference: `ref-${name}`, brief: "Run fault matrix", authority: auth });
		const launched = await open()({ action: "launch", factory_id: fac.factory_id, authority: auth });
		const sess = join(fix.cwd, ".pi", "agent-sessions", launched.task_id);
		const man = readJson<any>(join(sess, "manifest.json"));
		const inst = (nodeId: string) => man.pane_manifest.find((e: any) => e.node_id === nodeId).instance_id as string;
		const approveUpstream = async () => {
			const wB = workerFromConfig(t, join(sess, `${inst("build")}.config.json`), { model });
			const wS = workerFromConfig(t, join(sess, `${inst("side")}.config.json`), { model });
			const wR = workerFromConfig(t, join(sess, `${inst("review")}.config.json`), { model });
			await wB.start(); await wS.start(); await wR.start();
			await wB.beforeStart();
			writeFileSync(join(fix.cwd, "auth", "k.ts"), "2");
			assert.ok(!(await wB.complete(SUCCESS)).isError);
			await wS.beforeStart();
			assert.ok(!(await wS.complete(SUCCESS)).isError);
			await wR.beforeStart(notification(wB, wR));
			await wR.deliverFollowUps();
			const waitDir = wR.requestDirection({ question: "Approve?", reason: "Auth modified", choices: ["ship"] });
			let req: any;
			for (let i = 0; i < 50; i++) {
				req = open()({ action: "requests", factory_id: fac.factory_id }).find(r => r.state === "pending");
				if (req) break;
				await sleep(20);
			}
			open()({ action: "respond_request", factory_id: fac.factory_id, request_id: req.request_id, response: { kind: "choice", choice_id: "ship" }, authority: auth });
			assert.ok(!(await waitDir).isError);
			assert.ok(!(await wR.complete({ ...SUCCESS, outputs: { verdict: "approve" } })).isError);
			return { wR, wS };
		};
		return { fix, sess, man, inst, approveUpstream };
	};

	const assertNoErrorOrFailFast = (sess: string, instId: string, key = `${instId}.1`) => {
		assert.equal(existsSync(join(sess, "fail-fast.json")), false, "fail-fast.json must NOT be written");
		assert.equal(existsSync(join(sess, `${instId}.error.json`)), false, "unscoped error.json must NOT be written");
		assert.equal(existsSync(join(sess, `${key}.error.json`)), false, "attempt-scoped error.json must NOT be written");
	};

	// 1. Worker chain verdict.outcome === "wait" (worker.ts:1486) + exponential backoff + display:false + non-coms wake (worker.ts:1255)
	{
		resetFaults();
		const fx = await setupClosedFactory("b2-chain-wait");
		const { wR } = await fx.approveUpstream();
		const deployId = fx.inst("chain_w");
		const d = await mountFaultWorker(join(fx.sess, `${deployId}.config.json`));

		// Spy on setTimeout delays to verify exponential backoff (50 -> 100 -> 200ms) cleanly without long waits
		const scheduledDelays: Array<{ fn: () => void; ms: number }> = [];
		const origSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			if (typeof ms === "number" && ms >= 50 && ms <= 2000) {
				scheduledDelays.push({ fn, ms });
				return { unref: () => {} } as any;
			}
			return origSetTimeout(fn, ms);
		}) as any;

		try {
			faultState.onReadDecisionDirection = () => { throw makeBusyErr(); }; // release authority passes; evaluateForwardLaneGate -> verdict.outcome === "wait"
			const notif = notification(wR, { config: d.cfg } as any);
			await d.hooks.get("before_agent_start")!(notif, d.ctx);
			assert.equal(d.shutdowns.count, 0, "verdict wait must NOT shutdown");
			assertNoErrorOrFailFast(fx.sess, deployId);
			assert.equal(existsSync(dispositionPath(fx.sess, `${deployId}.1`)), false);
			assert.equal(scheduledDelays.length, 1);
			assert.equal(scheduledDelays[0]!.ms, 50);

			// Fire retry 1 & 2 to confirm backoff doubles (100, 200) and display === false
			scheduledDelays[0]!.fn();
			assert.equal(d.followUps.at(-1)?.display, false);
			await d.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: d.followUps.at(-1) }, d.ctx);
			assert.equal(scheduledDelays[1]!.ms, 100);
			scheduledDelays[1]!.fn();
			assert.equal(d.followUps.at(-1)?.display, false);
			await d.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: d.followUps.at(-1) }, d.ctx);
			assert.equal(scheduledDelays[2]!.ms, 200);

			// Clear fault -> retry succeeds & admits deploy
			resetFaults();
			scheduledDelays[2]!.fn();
			await d.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: d.followUps.at(-1) }, d.ctx);
			assert.equal(d.shutdowns.count, 0);
			const done = await d.tools.get("bootstrap_complete").execute("c1", SUCCESS, undefined, undefined, d.ctx);
			assert.ok(!done.isError);
		} finally {
			globalThis.setTimeout = origSetTimeout;
			resetFaults();
			await d.hooks.get("session_shutdown")?.({ reason: "quit" }, d.ctx);
		}

		// Non-coms wake transient (bootstrap-ownership-admit at worker.ts:1255): retries via scheduleHandoffRetry with display:false and succeeds when transient clears
		const chainCmdId = fx.inst("join_w"); // separate follower instance; deliver a bootstrap-ownership-admit wake with fault in verifyFactoryReleaseAuthority
		const jw = await mountFaultWorker(join(fx.sess, `${chainCmdId}.config.json`));
		try {
			faultState.onVerifyFactoryReleaseAuthority = () => { throw makeBusyErr(); };
			await jw.hooks.get("before_agent_start")!({
				systemPrompt: "BASE",
				messageType: "custom",
				message: { customType: "bootstrap-ownership-admit", content: "admit wake", display: true, details: { token: jw.cfg.token, instance_id: jw.cfg.instance_id } },
			}, jw.ctx);
			assertNoErrorOrFailFast(fx.sess, chainCmdId);
			assert.equal(jw.shutdowns.count, 0);
			// Poll until the 50ms backoff wake arrives in followUps
			for (let i = 0; i < 40 && jw.followUps.length === 0; i++) await sleep(10);
			assert.equal(jw.followUps.length, 1, "non-coms transient must schedule wake retry instead of dropping silently");
			assert.equal(jw.followUps[0]!.display, false);
			resetFaults();
			// Now feed real handoff notification to confirm worker wasn't failed or poisoned
			await jw.hooks.get("before_agent_start")!(notification(wR, { config: jw.cfg } as any), jw.ctx);
			assert.equal(jw.shutdowns.count, 0);
		} finally {
			resetFaults();
			await jw.hooks.get("session_shutdown")?.({ reason: "quit" }, jw.ctx);
		}
	}

	// 2. Root input path (worker.ts:1124-1135): transient schedules retry without error/shutdown; corrupt records needs_attention
	{
		resetFaults();
		const fx = await setupClosedFactory("b2-root-input");
		const sideId = fx.inst("side");
		const r1 = await mountFaultWorker(join(fx.sess, `${sideId}.config.json`));
		try {
			faultState.onVerifyFactoryReleaseAuthority = () => { throw makeBusyErr(); };
			const inpRes = await r1.hooks.get("input")!({ text: r1.cfg.startup_message }, r1.ctx);
			assert.equal(inpRes.action, "handled");
			assert.equal(r1.shutdowns.count, 0, "root input transient DB must not shut down");
			assertNoErrorOrFailFast(fx.sess, sideId);
			for (let i = 0; i < 40 && r1.followUps.length === 0; i++) await sleep(10);
			assert.equal(r1.followUps.length, 1, "root input transient must schedule follow-up retry");
			assert.equal(r1.followUps[0]!.display, false);
			resetFaults();
			await r1.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: r1.followUps[0] }, r1.ctx);
			const ok = await r1.tools.get("bootstrap_complete").execute("r-ok", SUCCESS, undefined, undefined, r1.ctx);
			assert.ok(!ok.isError);
		} finally {
			resetFaults();
			await r1.hooks.get("session_shutdown")?.({ reason: "quit" }, r1.ctx);
		}

		// Corrupt root input
		const fx2 = await setupClosedFactory("b2-root-corrupt");
		const buildId = fx2.inst("build");
		const r2 = await mountFaultWorker(join(fx2.sess, `${buildId}.config.json`));
		try {
			faultState.onVerifyFactoryReleaseAuthority = () => { throw makeCorruptErr(); };
			await r2.hooks.get("input")!({ text: r2.cfg.startup_message }, r2.ctx);
			assertNoErrorOrFailFast(fx2.sess, buildId);
			assert.equal(r2.shutdowns.count, 1);
			assert.equal(parseDisposition(readJson(dispositionPath(fx2.sess, `${buildId}.1`)), { run_id: fx2.man.task_id, instance_id: buildId }).state, "needs_attention");
		} finally {
			resetFaults();
			await r2.hooks.get("session_shutdown")?.({ reason: "quit" }, r2.ctx);
		}
	}

	// 3. Worker join catch (worker.ts:1413-1425) & worker chain catch (worker.ts:1541-1556): transient & corrupt
	{
		resetFaults();
		const fx = await setupClosedFactory("b2-worker-catches");
		const { wR } = await fx.approveUpstream();
		const joinId = fx.inst("join_w");
		const deployId = fx.inst("chain_w");

		// Join catch transient -> retry -> clear -> complete; Join catch corrupt -> needs_attention
		const jw1 = await mountFaultWorker(join(fx.sess, `${joinId}.config.json`));
		try {
			faultState.onEvaluateJoinAdmission = () => { throw makeBusyErr(); };
			await jw1.hooks.get("before_agent_start")!(notification(wR, { config: jw1.cfg } as any), jw1.ctx);
			assertNoErrorOrFailFast(fx.sess, joinId);
			assert.equal(existsSync(dispositionPath(fx.sess, `${joinId}.1`)), false);
			assert.equal(jw1.shutdowns.count, 0);
			for (let i = 0; i < 40 && jw1.followUps.length === 0; i++) await sleep(10);
			assert.equal(jw1.followUps.length, 1);
			resetFaults();
			await jw1.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: jw1.followUps[0] }, jw1.ctx);
			assert.ok(!(await jw1.tools.get("bootstrap_complete").execute("jw1", SUCCESS, undefined, undefined, jw1.ctx)).isError);
		} finally {
			resetFaults();
			await jw1.hooks.get("session_shutdown")?.({ reason: "quit" }, jw1.ctx);
		}

		// Corrupt join catch (using fresh factory so join_w has no result)
		const fxJoinBad = await setupClosedFactory("b2-join-corrupt");
		const { wR: wrBad } = await fxJoinBad.approveUpstream();
		const joinBadId = fxJoinBad.inst("join_w");
		const jwBad = await mountFaultWorker(join(fxJoinBad.sess, `${joinBadId}.config.json`));
		try {
			faultState.onReadDecisionDirection = () => { throw makeCorruptErr(); };
			await jwBad.hooks.get("before_agent_start")!(notification(wrBad, { config: jwBad.cfg } as any), jwBad.ctx);
			assertNoErrorOrFailFast(fxJoinBad.sess, joinBadId);
			assert.equal(jwBad.shutdowns.count, 1);
			assert.equal(parseDisposition(readJson(dispositionPath(fxJoinBad.sess, `${joinBadId}.1`)), { run_id: fxJoinBad.man.task_id, instance_id: joinBadId }).state, "needs_attention");
		} finally {
			resetFaults();
			await jwBad.hooks.get("session_shutdown")?.({ reason: "quit" }, jwBad.ctx);
		}

		// Worker chain catch transient -> retry -> clear -> complete; Worker chain catch corrupt -> needs_attention
		const dw1 = await mountFaultWorker(join(fx.sess, `${deployId}.config.json`));
		try {
			faultState.onAdmission = () => { throw makeBusyErr(); };
			await dw1.hooks.get("before_agent_start")!(notification(wR, { config: dw1.cfg } as any), dw1.ctx);
			assertNoErrorOrFailFast(fx.sess, deployId);
			assert.equal(existsSync(dispositionPath(fx.sess, `${deployId}.1`)), false);
			assert.equal(dw1.shutdowns.count, 0);
			for (let i = 0; i < 40 && dw1.followUps.length === 0; i++) await sleep(10);
			assert.equal(dw1.followUps.length, 1);
			resetFaults();
			await dw1.hooks.get("before_agent_start")!({ systemPrompt: "BASE", messageType: "custom", message: dw1.followUps[0] }, dw1.ctx);
			assert.ok(!(await dw1.tools.get("bootstrap_complete").execute("dw1", SUCCESS, undefined, undefined, dw1.ctx)).isError);
		} finally {
			resetFaults();
			await dw1.hooks.get("session_shutdown")?.({ reason: "quit" }, dw1.ctx);
		}

		const dwBad = await mountFaultWorker(join(fxJoinBad.sess, `${fxJoinBad.inst("chain_w")}.config.json`));
		try {
			faultState.onReadDecisionDirection = () => { throw makeCorruptErr(); };
			await dwBad.hooks.get("before_agent_start")!(notification(wrBad, { config: dwBad.cfg } as any), dwBad.ctx);
			assertNoErrorOrFailFast(fxJoinBad.sess, fxJoinBad.inst("chain_w"));
			assert.equal(dwBad.shutdowns.count, 1);
			assert.equal(parseDisposition(readJson(dispositionPath(fxJoinBad.sess, `${fxJoinBad.inst("chain_w")}.1`)), { run_id: fxJoinBad.man.task_id, instance_id: fxJoinBad.inst("chain_w") }).state, "needs_attention");
		} finally {
			resetFaults();
			await dwBad.hooks.get("session_shutdown")?.({ reason: "quit" }, dwBad.ctx);
		}
	}

	// 4. Worker poll transient guards (worker.ts:870 join poll & worker.ts:921 chain poll) + expiry past dependencyWaitMs
	{
		resetFaults();
		const fxJoinPoll = await setupClosedFactory("b2-worker-join-poll", { depWaitMs: 2500 });
		const fxChainPoll = await setupClosedFactory("b2-worker-chain-poll", { depWaitMs: 2500 });
		const { wR: wrPoll } = await fxChainPoll.approveUpstream();
		const rPollPath = resultPath(fxChainPoll.sess, `${wrPoll.config.instance_id}.1`);
		atomicJson(rPollPath, { ...readJson<any>(rPollPath), delivery: "pending" });
		t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
		try {
			const joinId = fxJoinPoll.inst("join_w");
			const deployId = fxChainPoll.inst("chain_w");
			const jp = await mountFaultWorker(join(fxJoinPoll.sess, `${joinId}.config.json`));
			const cp = await mountFaultWorker(join(fxChainPoll.sess, `${deployId}.config.json`));
			try {
				faultState.onEvaluateJoinAdmission = () => { throw makeBusyErr(); };
				faultState.onAdmission = () => { throw makeBusyErr(); };
				// Tick past 1000ms (< 2500ms dependencyWaitMs): transient must NOT fail or write disposition
				t.mock.timers.tick(1100);
				assertNoErrorOrFailFast(fxJoinPoll.sess, joinId);
				assertNoErrorOrFailFast(fxChainPoll.sess, deployId);
				assert.equal(existsSync(dispositionPath(fxJoinPoll.sess, `${joinId}.1`)), false);
				assert.equal(existsSync(dispositionPath(fxChainPoll.sess, `${deployId}.1`)), false);
				assert.equal(jp.shutdowns.count, 0);
				assert.equal(cp.shutdowns.count, 0);

				// Tick past 2500ms: expired transient must settle needs_attention cleanly without error.json or fail-fast.json
				t.mock.timers.tick(2000);
				assertNoErrorOrFailFast(fxJoinPoll.sess, joinId);
				assertNoErrorOrFailFast(fxChainPoll.sess, deployId);
				assert.equal(jp.shutdowns.count, 1);
				assert.equal(cp.shutdowns.count, 1);
				assert.equal(parseDisposition(readJson(dispositionPath(fxJoinPoll.sess, `${joinId}.1`)), { run_id: fxJoinPoll.man.task_id, instance_id: joinId }).state, "needs_attention");
				assert.equal(parseDisposition(readJson(dispositionPath(fxChainPoll.sess, `${deployId}.1`)), { run_id: fxChainPoll.man.task_id, instance_id: deployId }).state, "needs_attention");
			} finally {
				await jp.hooks.get("session_shutdown")?.({ reason: "quit" }, jp.ctx);
				await cp.hooks.get("session_shutdown")?.({ reason: "quit" }, cp.ctx);
			}
		} finally {
			t.mock.timers.reset();
			resetFaults();
		}
	}

	// 5. Command-runner join recheck wait (command-runner.ts:1075), catch transient & corrupt (:1144), and poll transient/corrupt (:1268-1273)
	{
		resetFaults();
		const fx = await setupClosedFactory("b2-cmd-faults");
		const { wR } = await fx.approveUpstream();
		const joinCmdId = fx.inst("join_cmd");
		const chainCmdId = fx.inst("chain_cmd");

		// 5a: command-runner join recheck wait (:1075) via readDecisionDirection SQLITE_BUSY -> retry -> clear -> succeeds
		const cJoin = createCmdFault(join(fx.sess, `${joinCmdId}.config.json`), { pollMs: 40 });
		await cJoin.start();
		faultState.onReadDecisionDirection = () => { throw makeBusyErr(); };
		await cJoin.beforeStart(notification(wR, { config: readJson(join(fx.sess, `${joinCmdId}.config.json`)) } as any));
		assertNoErrorOrFailFast(fx.sess, joinCmdId);
		assert.equal(existsSync(dispositionPath(fx.sess, `${joinCmdId}.1`)), false);
		resetFaults();
		await cJoin.waitUntilSettled();
		assert.equal(readJson<any>(resultPath(fx.sess, `${joinCmdId}.1`)).result.status, "success");

		// 5b: command-runner catch transient (:1144) -> retry -> succeeds
		const cChain = createCmdFault(join(fx.sess, `${chainCmdId}.config.json`), { pollMs: 40 });
		await cChain.start();
		faultState.onAdmission = () => { throw makeBusyErr(); };
		await cChain.beforeStart(notification(wR, { config: readJson(join(fx.sess, `${chainCmdId}.config.json`)) } as any));
		assertNoErrorOrFailFast(fx.sess, chainCmdId);
		assert.equal(existsSync(dispositionPath(fx.sess, `${chainCmdId}.1`)), false);
		resetFaults();
		await cChain.waitUntilSettled();
		assert.equal(readJson<any>(resultPath(fx.sess, `${chainCmdId}.1`)).result.status, "success");

		// 5c: command-runner catch corrupt (:1148) -> needs_attention without fail-fast.json
		const fxCmdBad = await setupClosedFactory("b2-cmd-catch-corrupt");
		const { wR: wrCmdBad } = await fxCmdBad.approveUpstream();
		const chainCmdBadId = fxCmdBad.inst("chain_cmd");
		const cChainBad = createCmdFault(join(fxCmdBad.sess, `${chainCmdBadId}.config.json`), { pollMs: 40 });
		await cChainBad.start();
		faultState.onReadDecisionDirection = () => { throw makeCorruptErr(); };
		await cChainBad.beforeStart(notification(wrCmdBad, { config: readJson(join(fxCmdBad.sess, `${chainCmdBadId}.config.json`)) } as any));
		await cChainBad.waitUntilSettled();
		assert.equal(existsSync(join(fxCmdBad.sess, "fail-fast.json")), false);
		assert.equal(existsSync(resultPath(fxCmdBad.sess, `${chainCmdBadId}.1`)), false);
		assert.equal(parseDisposition(readJson(dispositionPath(fxCmdBad.sess, `${chainCmdBadId}.1`)), { run_id: fxCmdBad.man.task_id, instance_id: chainCmdBadId }).state, "needs_attention");
		resetFaults();

		// 5d: command-runner poll transient (:1268 within wait -> ok, past wait -> needs_attention) & poll corrupt (:1269 -> needs_attention)
		const fxCmdPoll = await setupClosedFactory("b2-cmd-poll", { depWaitMs: 300 });
		const { wR: wrCmdPoll } = await fxCmdPoll.approveUpstream();
		const rCmdPollPath = resultPath(fxCmdPoll.sess, `${wrCmdPoll.config.instance_id}.1`);
		atomicJson(rCmdPollPath, { ...readJson<any>(rCmdPollPath), delivery: "pending" });
		const pollChainId = fxCmdPoll.inst("chain_cmd");
		const cPollTrans = createCmdFault(join(fxCmdPoll.sess, `${pollChainId}.config.json`), { pollMs: 100 });
		faultState.onAdmission = () => { throw makeBusyErr(); };
		await cPollTrans.start();
		await sleep(140); // first poll at 100ms hits transient < 300ms
		assert.equal(existsSync(dispositionPath(fxCmdPoll.sess, `${pollChainId}.1`)), false);
		assert.equal(existsSync(join(fxCmdPoll.sess, "fail-fast.json")), false);
		await cPollTrans.waitUntilSettled(); // past 300ms -> settles needs_attention without fail-fast.json
		assert.equal(existsSync(join(fxCmdPoll.sess, "fail-fast.json")), false);
		assert.equal(parseDisposition(readJson(dispositionPath(fxCmdPoll.sess, `${pollChainId}.1`)), { run_id: fxCmdPoll.man.task_id, instance_id: pollChainId }).state, "needs_attention");
		resetFaults();

		const pollJoinId = fxCmdPoll.inst("join_cmd");
		const cPollCorrupt = createCmdFault(join(fxCmdPoll.sess, `${pollJoinId}.config.json`), { pollMs: 100 });
		faultState.onReadDecisionDirection = () => { throw makeCorruptErr(); };
		await cPollCorrupt.start();
		await cPollCorrupt.waitUntilSettled();
		assert.equal(existsSync(join(fxCmdPoll.sess, "fail-fast.json")), false);
		assert.equal(parseDisposition(readJson(dispositionPath(fxCmdPoll.sess, `${pollJoinId}.1`)), { run_id: fxCmdPoll.man.task_id, instance_id: pollJoinId }).state, "needs_attention");
		resetFaults();
	}
});

