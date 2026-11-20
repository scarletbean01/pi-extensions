import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createManagerAuthority, factoryOperations, MAX_BRIEF_BYTES, MAX_QUEUED_INPUTS, revokeManagerAuthority } from "../factory/operations.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised, spawnGroup } from "./test-harness.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

function fixture(t: test.TestContext) {
	const run = serviceFixture(t);
	const database = join(run.root, "factory.sqlite");
	const open = () => factoryOperations(database, run.service);
	const draft: GenerateRequest = {
		project_cwd: run.cwd, topology: "graph", task: "Test changes",
		agents: [{ persona: "first", node_id: "build", sub_task: "Build the change" }],
	};
	return { ...run, draft, database, open };
}

test("explicit publication makes a complete v1 discoverable by a stable ID without launching", t => {
	const { open, draft, configs } = fixture(t);
	assert.deepEqual(open()({ action: "list" }), []);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	assert.match(receipt.factory_id, /^[a-f0-9-]{36}$/);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.equal(receipt.current_version, "v1");
	assert.equal(receipt.management, "unmanaged");
	const saved = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.deepEqual(saved.factory, receipt);
	assert.equal(saved.definition.project_cwd, draft.project_cwd);
	assert.equal(saved.definition.agents[0].node.sub_task, "Build the change");
	assert.equal(saved.definition.agents[0].system_prompt, "Exact persona first");
	assert.deepEqual(configs, []);
});

test("publication rejects invalid executable definitions without touching the current version", t => {
	const { open, draft, configs } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	const decision = { field: "verdict", approve: "yes", reject: "no", on_reject: "build" };
	const review = {
		persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"], decision,
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string" as const, enum: ["yes", "no"] } } },
	};
	const cases: Array<[Partial<GenerateRequest>, RegExp]> = [
		[{ agents: [{ ...draft.agents[0], depends_on: ["missing"] }] }, /Unknown dependency "missing" for node build/],
		[{ agents: [{ ...draft.agents[0], depends_on: ["review"] }, review] }, /Dependency cycle.*build.*review/],
		[{ agents: [{ ...draft.agents[0], required_checks: [" "] }] }, /required_checks for build/],
		[{ agents: [{ ...draft.agents[0], required_checks: [" smoke "] }] }, /required_checks.*whitespace|whitespace.*required_checks/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_checks: [" smoke "] } }] }, /required_checks.*whitespace|whitespace.*required_checks/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: ["../outside.txt"] } }] }, /required_artifact_paths.*\.\..*traversal/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: ["/[report].json"] } }] }, /required_artifact_paths.*escapes project\/session scope/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: ["."] } }] }, /required_artifact_paths.*must be files/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: [".pi"] } }] }, /required_artifact_paths.*must be files/i],
		[{ agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: [".pi/agent-sessions"] } }] }, /required_artifact_paths.*must be files/i],
		[{ agents: [draft.agents[0], { ...review, output_contract: {} }] }, /decision for review.*output_contract/],
		[{ agents: [draft.agents[0], { ...review, decision: { ...decision, on_reject: "review" } }] }, /decision for review.*strict ancestor/],
		[{ agents: [draft.agents[0], { ...review, decision: { ...decision, max_revisions: 11 } }] }, /max_revisions for review/],
		[{ agents: [draft.agents[0], review], max_total_attempts: 1 }, /max_total_attempts.*first attempt/],
		[{ agents: [{ ...draft.agents[0], persona: "missing" }] }, /build.*missing/],
		[{ project_cwd: join(draft.project_cwd, "missing") }, /project_cwd.*missing/],
		[{ coms_extension: "missing.ts" }, /Required Coms extension not found.*missing.ts/],
		[{ task_timeout_ms: -1 }, /task_timeout_ms/],
		[{ agents: [{ ...draft.agents[0], depends_onn: ["missing"] } as GenerateRequest["agents"][number]] }, /build.*depends_onn/],
	];
	for (const [index, [invalid, diagnosis]] of cases.entries()) {
		assert.throws(() => open()({ action: "publish", name: `quality-${index}`, draft: { ...draft, ...invalid }, sessionModel }), diagnosis);
	}
	assert.throws(() => open()({ action: "publish", name: "Quality", draft, sessionModel }), /already published/);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.deepEqual(configs, []);
});

test("standalone plan preview works when its session parent is not writable", t => {
	const { draft, cwd, service } = fixture(t);
	const sessions = join(cwd, ".pi", "agent-sessions");
	mkdirSync(sessions);
	const original = statSync(sessions).mode;
	try {
		chmodSync(sessions, 0o500);
		assert.doesNotThrow(() => service.plan(draft, sessionModel));
	} finally {
		chmodSync(sessions, original);
	}
});

test("a named request replay survives required-artifact symlink drift without weakening new-launch validation", async t => {
	const { draft, cwd, root, service } = fixture(t);
	const inside = join(cwd, "inside");
	const outside = join(root, "outside");
	mkdirSync(inside);
	mkdirSync(outside);
	symlinkSync(inside, join(cwd, "out"));
	draft.agents[0].output_contract = { required_artifact_paths: ["out/report.txt"] };
	const request = { ...draft, request_id: "artifact-replay" };
	const first = await service.generate(request, { provider: sessionModel.provider, id: sessionModel.id });
	rmSync(join(cwd, "out"));
	symlinkSync(outside, join(cwd, "out"));
	const replay = await service.generate(request, { provider: sessionModel.provider, id: sessionModel.id });
	assert.equal(replay.task_id, first.task_id);
	await assert.rejects(service.generate({ ...request, request_id: "fresh-artifact-request" }, { provider: sessionModel.provider, id: sessionModel.id }), /required_artifact_paths.*escapes project\/session scope/);
});

test("publication accepts a valid future artifact path deeper than 256 components", t => {
	const { open, draft } = fixture(t);
	const future = `${"a/".repeat(260)}report.txt`;
	draft.agents[0].output_contract = { required_artifact_paths: [future] };
	const receipt = open()({ action: "publish", name: "deep-future-output", draft, sessionModel });
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.output_contract?.required_artifact_paths?.[0], future);
});

test("publication rejects an artifact symlink cycle and leaves the current v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	symlinkSync("loop", join(cwd, "loop"));
	for (const [index, artifactPath] of ["loop/report.txt", "loop"].entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [artifactPath] };
		assert.throws(
			() => open()({ action: "publish", name: `cycle-output-${index}`, draft, sessionModel }),
			/build.*required_artifact_paths.*symlink/i,
		);
	}
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects an artifact symlink cycle formed through .. after a linked component and leaves v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	symlinkSync("alias/../missing.txt", join(cwd, "report"));
	symlinkSync("report", join(cwd, "alias"));
	draft.agents[0].output_contract = { required_artifact_paths: ["report"] };
	assert.throws(
		() => open()({ action: "publish", name: "cycle-dotdot-output", draft, sessionModel }),
		/build.*required_artifact_paths.*symlink/i,
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication accepts a required artifact resolved through a linked parent and .. when the real target is a file", t => {
	const { open, draft, cwd } = fixture(t);
	mkdirSync(join(cwd, "actual", "reports"), { recursive: true });
	writeFileSync(join(cwd, "actual", "current.txt"), "actual report\n");
	mkdirSync(join(cwd, "current.txt"));
	symlinkSync("actual/reports", join(cwd, "alias"));
	symlinkSync("alias/../current.txt", join(cwd, "report"));
	draft.agents[0].output_contract = { required_artifact_paths: ["report"] };
	const receipt = open()({ action: "publish", name: "linked-parent-dotdot", draft, sessionModel });
	assert.deepEqual(
		open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.output_contract?.required_artifact_paths,
		["report"],
	);
});

test("publication rejects escaping required artifact paths through .. after a linked component or dangling link", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	symlinkSync("..", join(cwd, "alias"));
	symlinkSync("alias/../missing.txt", join(cwd, "report"));
	symlinkSync("../outside/missing-dir", join(cwd, "dangling"));
	for (const [index, artifactPath] of ["report", "dangling/file.txt"].entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [artifactPath] };
		assert.throws(
			() => open()({ action: "publish", name: `escaping-linked-${index}`, draft, sessionModel }),
			/build.*required_artifact_paths.*escapes project\/session scope/i,
		);
	}
	draft.agents[0].output_contract = { required_artifact_paths: ["alias/../missing.txt"] };
	assert.throws(
		() => open()({ action: "publish", name: "escaping-linked-traversal", draft, sessionModel }),
		/build.*required_artifact_paths.*alias\/\.\.\/missing\.txt.*\.\..*traversal/i,
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects a non-missing lookup failure in required_artifact_paths and leaves state unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	writeFileSync(join(cwd, "regular-file"), "content\n");
	draft.agents[0].output_contract = { required_artifact_paths: ["regular-file/report.txt"] };
	assert.throws(
		() => open()({ action: "publish", name: "notdir-output", draft, sessionModel }),
		/build.*required_artifact_paths.*(not a directory|ENOTDIR)/i,
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects a required artifact symlink whose trailing slash targets an ordinary file and leaves state unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	writeFileSync(join(cwd, "leaf"), "ordinary file\n");
	symlinkSync("leaf/", join(cwd, "report"));
	symlinkSync("report", join(cwd, "alias"));
	symlinkSync("plain-mid", join(cwd, "via-mid"));
	symlinkSync("leaf/", join(cwd, "plain-mid"));
	symlinkSync("dir-mid/", join(cwd, "via-trailing-mid"));
	symlinkSync("leaf", join(cwd, "dir-mid"));
	for (const [index, artifactPath] of ["report", "alias", "via-mid", "via-trailing-mid"].entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [artifactPath] };
		assert.throws(
			() => open()({ action: "publish", name: `trailing-slash-file-${index}`, draft, sessionModel }),
			/build.*required_artifact_paths.*ENOTDIR/i,
		);
	}
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects a required artifact path that already names a directory", t => {
	const { open, draft, cwd } = fixture(t);
	const directory = join(cwd, "output-directory");
	mkdirSync(directory);
	draft.agents[0].output_contract = { required_artifact_paths: [directory] };
	assert.throws(() => open()({ action: "publish", name: "directory-output", draft, sessionModel }), /required_artifact_paths.*must be files/i);
});

test("publication accepts an in-scope required artifact path before the output exists", t => {
	const { open, draft, cwd } = fixture(t);
	const future = join(cwd, "out", "report.json");
	const paddedRelative = " ../report.txt";
	draft.agents[0].output_contract = { required_artifact_paths: [future, paddedRelative] };
	const receipt = open()({ action: "publish", name: "future-output", draft, sessionModel });
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.output_contract?.required_artifact_paths, [future, paddedRelative]);
});

test("publication rejects same-node strict file and descendant conflicts in required_artifact_paths and leaves v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	const cases: Array<[string, string]> = [
		["reports", "reports/summary.txt"],
		["reports/summary.txt", "reports"],
		["reports", "reports/nested/summary.txt"],
		["reports", join(cwd, "reports/summary.txt")],
		[join(cwd, "reports"), "./reports/./summary.txt"],
	];
	for (const [index, [first, second]] of cases.entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [first, second] };
		assert.throws(
			() => open()({ action: "publish", name: `conflict-output-${index}`, draft, sessionModel }),
			error => {
				const message = error instanceof Error ? error.message : String(error);
				return /\bbuild\b/.test(message)
					&& /\brequired_artifact_paths\b/.test(message)
					&& message.includes(first)
					&& message.includes(second);
			},
		);
	}
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication accepts non-conflicting future required_artifact_paths across prefix lookalikes, equivalent paths, and separate nodes", t => {
	const { open, draft, cwd } = fixture(t);
	const sameNodePaths = ["reports", "reports.txt", "reports-old/summary.txt", "./reports", join(cwd, "reports")];
	draft.agents[0].output_contract = { required_artifact_paths: sameNodePaths };
	draft.agents.push({
		persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"],
		output_contract: { required_artifact_paths: ["reports/summary.txt"] },
	});
	const receipt = open()({ action: "publish", name: "compatible-future-outputs", draft, sessionModel });
	const inspected = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.deepEqual(inspected.definition.agents[0].node.output_contract?.required_artifact_paths, sameNodePaths);
	assert.deepEqual(inspected.definition.agents[1].node.output_contract?.required_artifact_paths, ["reports/summary.txt"]);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects directory-only required_artifact_paths spellings including reports/. and trailing slashes and leaves v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	const cases = [
		"reports/.",
		"reports/",
		"reports///",
		"reports/./",
		"/",
		`${cwd}/reports/.`,
		`${cwd}/reports/`,
	];
	for (const [index, artifactPath] of cases.entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [artifactPath] };
		assert.throws(
			() => open()({ action: "publish", name: `dir-spelling-${index}`, draft, sessionModel }),
			error => {
				const message = error instanceof Error ? error.message : String(error);
				return /\bbuild\b/.test(message)
					&& /\brequired_artifact_paths\b/.test(message)
					&& message.includes(artifactPath)
					&& /must be files|directory/i.test(message);
			},
			`expected publication rejection for directory-only path ${JSON.stringify(artifactPath)}`,
		);
	}
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects traversal segments like reports/../summary.txt even with reports and leaves v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	const cases: Array<[string[], string]> = [
		[["reports", "reports/../summary.txt"], "reports/../summary.txt"],
		[["reports/../summary.txt"], "reports/../summary.txt"],
		[["reports/.."], "reports/.."],
		[[".."], ".."],
		[["./sub/../summary.txt"], "./sub/../summary.txt"],
		[[`${cwd}/reports/../summary.txt`], `${cwd}/reports/../summary.txt`],
	];
	for (const [index, [paths, offending]] of cases.entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: paths };
		assert.throws(
			() => open()({ action: "publish", name: `traversal-${index}`, draft, sessionModel }),
			error => {
				const message = error instanceof Error ? error.message : String(error);
				return /\bbuild\b/.test(message)
					&& /\brequired_artifact_paths\b/.test(message)
					&& message.includes(offending)
					&& /\.\./.test(message);
			},
			`expected publication rejection for traversal path ${JSON.stringify(paths)}`,
		);
	}
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication rejects dangling symlink chains with directory-only final targets and leaves v1 unchanged", t => {
	const { open, draft, cwd } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	symlinkSync("missing/", join(cwd, "trail-slash"));
	symlinkSync("missing/.", join(cwd, "trail-dot"));
	symlinkSync("trail-slash", join(cwd, "alias-trail"));
	symlinkSync("mid-missing/", join(cwd, "via-trail-mid"));
	symlinkSync("missing", join(cwd, "mid-missing"));
	symlinkSync("missing/sub/..", join(cwd, "trail-dotdot"));
	symlinkSync("../outside/", join(cwd, "escaping-trail"));
	for (const [index, artifactPath] of ["trail-slash", "trail-dot", "alias-trail", "via-trail-mid", "trail-dotdot"].entries()) {
		draft.agents[0].output_contract = { required_artifact_paths: [artifactPath] };
		assert.throws(
			() => open()({ action: "publish", name: `dangling-dir-link-${index}`, draft, sessionModel }),
			error => {
				const message = error instanceof Error ? error.message : String(error);
				return /\bbuild\b/.test(message)
					&& /\brequired_artifact_paths\b/.test(message)
					&& message.includes(artifactPath)
					&& /must be files|directory/i.test(message);
			},
			`expected publication rejection for dangling directory-only symlink ${JSON.stringify(artifactPath)}`,
		);
	}
	draft.agents[0].output_contract = { required_artifact_paths: ["escaping-trail"] };
	assert.throws(
		() => open()({ action: "publish", name: "dangling-dir-escape", draft, sessionModel }),
		/build.*required_artifact_paths.*escapes project\/session scope/i,
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
});

test("publication preserves valid future required_artifact_paths with leading ./, nonterminal ., dots, spaces, and dangling dir parent", t => {
	const { open, draft, cwd } = fixture(t);
	symlinkSync("missing/", join(cwd, "future-dir"));
	const validPaths = [
		"./report.txt",
		"./reports/./summary.txt",
		"reports//nested/out.txt",
		"reports/.hidden",
		"reports/file..v2.txt",
		"reports/ .txt",
		"reports/name with spaces.txt",
		"future-dir/summary.txt",
		`${cwd}/./abs/./leaf.txt`,
	];
	draft.agents[0].output_contract = { required_artifact_paths: validPaths };
	const receipt = open()({ action: "publish", name: "valid-future-spellings", draft, sessionModel });
	assert.deepEqual(
		open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.output_contract?.required_artifact_paths,
		validPaths,
	);
});

async function runStandaloneSingleWorker(
	t: test.TestContext,
	requiredPaths: string[],
	options?: {
		setup?: (cwd: string, root: string) => void;
		beforeComplete?: (cwd: string) => void;
		artifacts?: Array<{ type: "file"; path: string; action: "created" }>;
	},
) {
	const workerModel = { provider: "provider", id: "model" };
	const { cwd, root, service } = serviceFixture(t);
	options?.setup?.(cwd, root);
	const request: GenerateRequest = {
		project_cwd: cwd,
		topology: "graph",
		task: `Standalone artifact check (${requiredPaths.join(", ")})`,
		agents: [{
			persona: "first",
			node_id: "build",
			sub_task: "Produce required artifacts",
			output_contract: { required_artifact_paths: requiredPaths },
		}],
	};
	const preview = service.plan(request, workerModel);
	assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, requiredPaths);
	const run = await service.generate(request, workerModel);
	const w1 = workerFromConfig(t, join(run.session_dir, `${run.pane_manifest[0].instance_id}.config.json`));
	await w1.start();
	await w1.beforeStart();
	options?.beforeComplete?.(cwd);
	const completion = await w1.complete({
		status: "success",
		summary: "Completed",
		detail: "ok",
		...(options?.artifacts ? { artifacts: options.artifacts } : {}),
	});
	return { cwd, root, service, preview, run, w1, completion };
}

function assertPublishRejectedLeavingV1(
	open: ReturnType<typeof fixture>["open"],
	draft: GenerateRequest,
	publishName: string,
	expectedTerms: Array<string | RegExp>,
) {
	const receipt = open()({ action: "publish", name: "quality", draft: { ...draft, agents: [{ ...draft.agents[0], output_contract: undefined }] }, sessionModel });
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.throws(
		() => open()({ action: "publish", name: publishName, draft, sessionModel }),
		error => {
			const message = error instanceof Error ? error.message : String(error);
			return /\bbuild\b/.test(message)
				&& /\brequired_artifact_paths\b/.test(message)
				&& expectedTerms.every(term => (typeof term === "string" ? message.includes(term) : term.test(message)));
		},
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
	assert.deepEqual(open()({ action: "list" }), [receipt]);
}

test("publication rejects same-node symlink .. traversal conflicts with required file paths in any order and leaves v1 unchanged", async t => {
	const conflictCases: Array<{
		title: string;
		setup: (cwd: string) => void;
		paths: string[];
		expectedTerms?: Array<string | RegExp>;
	}> = [
		{
			title: "rejects [reports, alias] when alias -> reports/../summary.txt and reports is absent",
			setup: cwd => symlinkSync("reports/../summary.txt", join(cwd, "alias")),
			paths: ["reports", "alias"],
		},
		{
			title: "rejects [alias, reports] when alias -> reports/../summary.txt and reports is absent",
			setup: cwd => symlinkSync("reports/../summary.txt", join(cwd, "alias")),
			paths: ["alias", "reports"],
		},
		{
			title: "rejects transitive symlinks and aliased file paths conflicting with symlink .. traversal",
			setup: cwd => {
				symlinkSync("reports/../summary.txt", join(cwd, "hop"));
				symlinkSync("hop", join(cwd, "outer"));
				symlinkSync("reports", join(cwd, "target-alias"));
			},
			paths: ["target-alias", "outer"],
		},
		{
			title: "rejects transitive symlinks and aliased file paths in reverse order",
			setup: cwd => {
				symlinkSync("reports/../summary.txt", join(cwd, "hop"));
				symlinkSync("hop", join(cwd, "outer"));
				symlinkSync("reports", join(cwd, "target-alias"));
			},
			paths: ["outer", "target-alias"],
		},
		{
			title: "rejects intrinsic self-conflict when single path alias -> reports/../reports and reports is absent",
			setup: cwd => symlinkSync("reports/../reports", join(cwd, "alias")),
			paths: ["alias"],
			expectedTerms: ["alias", /traversed|directory/i],
		},
		{
			title: "rejects transitive intrinsic self-conflict when outer -> alias -> reports/sub/../../reports and reports is absent",
			setup: cwd => {
				symlinkSync("reports/sub/../../reports", join(cwd, "alias"));
				symlinkSync("alias", join(cwd, "outer"));
			},
			paths: ["outer"],
			expectedTerms: ["outer", /traversed|directory/i],
		},
	];

	for (const [index, entry] of conflictCases.entries()) {
		await t.test(entry.title, () => {
			const { open, draft, cwd } = fixture(t);
			entry.setup(cwd);
			draft.agents[0].output_contract = { required_artifact_paths: entry.paths };
			assertPublishRejectedLeavingV1(open, draft, `symlink-traversal-${index}`, entry.expectedTerms ?? entry.paths);
		});
	}

	await t.test("accepts compatible symlink .. traversal when paths do not conflict or span separate nodes", () => {
		const { open, draft, cwd } = fixture(t);
		mkdirSync(join(cwd, "actual", "reports"), { recursive: true });
		writeFileSync(join(cwd, "actual", "current.txt"), "actual report\n");
		symlinkSync("actual/reports", join(cwd, "dir-alias"));
		symlinkSync("dir-alias/../current.txt", join(cwd, "report"));
		symlinkSync("future/../summary.txt", join(cwd, "future-alias"));
		symlinkSync("reentry/../reentry/leaf.txt", join(cwd, "reentry-alias"));
		draft.agents[0].output_contract = { required_artifact_paths: ["report", "actual/current.txt", "future/item.txt", "future-alias", "reentry-alias"] };
		draft.agents.push({
			persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"],
			output_contract: { required_artifact_paths: ["future"] },
		});
		const receipt = open()({ action: "publish", name: "compatible-symlink-dotdot", draft, sessionModel });
		const inspected = open()({ action: "inspect", factory_id: receipt.factory_id });
		assert.deepEqual(inspected.definition.agents[0].node.output_contract?.required_artifact_paths, ["report", "actual/current.txt", "future/item.txt", "future-alias", "reentry-alias"]);
		assert.deepEqual(inspected.definition.agents[1].node.output_contract?.required_artifact_paths, ["future"]);
	});
});

test("standalone plan, generate, and real worker completion remain compatible with normalized dot and .. syntax", async t => {
	const workerModel = { provider: "provider", id: "model" };

	const completionCases: Array<{
		title: string;
		requiredPaths: string[];
		setup?: (cwd: string) => void;
		beforeComplete?: (cwd: string) => void;
		reportedPath: string;
	}> = [
		{
			title: "reports/. succeeds when reports is absent at plan/generate and written as a regular file before completion",
			requiredPaths: ["reports/."],
			beforeComplete: cwd => writeFileSync(join(cwd, "reports"), "final report\n"),
			reportedPath: "reports",
		},
		{
			title: "reports/. succeeds when reports already exists as a regular file at plan, generate, and completion",
			requiredPaths: ["reports/."],
			setup: cwd => writeFileSync(join(cwd, "reports"), "existing regular file\n"),
			reportedPath: "reports",
		},
		{
			title: "reports/../summary.txt succeeds when reports already exists as a regular file at plan, generate, and completion",
			requiredPaths: ["reports/../summary.txt"],
			setup: cwd => writeFileSync(join(cwd, "reports"), "existing regular file\n"),
			beforeComplete: cwd => writeFileSync(join(cwd, "summary.txt"), "summary content\n"),
			reportedPath: "summary.txt",
		},
		{
			title: "reports/nested/../../summary.txt normalizes to summary.txt when reports is a regular file",
			requiredPaths: ["reports/nested/../../summary.txt"],
			setup: cwd => writeFileSync(join(cwd, "reports"), "existing regular file\n"),
			beforeComplete: cwd => writeFileSync(join(cwd, "summary.txt"), "normalized summary\n"),
			reportedPath: "summary.txt",
		},
		{
			title: "report-link/../summary.txt normalizes to cwd/summary.txt when report-link -> actual/reports is an in-scope directory symlink",
			requiredPaths: ["report-link/../summary.txt"],
			setup: cwd => {
				mkdirSync(join(cwd, "actual", "reports"), { recursive: true });
				symlinkSync("actual/reports", join(cwd, "report-link"));
			},
			beforeComplete: cwd => writeFileSync(join(cwd, "summary.txt"), "cwd summary\n"),
			reportedPath: "summary.txt",
		},
		{
			title: "does not lexically rewrite readlink payloads when resolving a symlinked output name",
			requiredPaths: ["alias"],
			setup: cwd => {
				mkdirSync(join(cwd, "actual", "reports"), { recursive: true });
				symlinkSync("actual/reports", join(cwd, "report-link"));
				symlinkSync("report-link/../current.txt", join(cwd, "alias"));
			},
			beforeComplete: cwd => writeFileSync(join(cwd, "actual", "current.txt"), "actual current\n"),
			reportedPath: "actual/current.txt",
		},
	];

	for (const entry of completionCases) {
		await t.test(entry.title, async () => {
			const { completion } = await runStandaloneSingleWorker(t, entry.requiredPaths, {
				setup: entry.setup,
				beforeComplete: entry.beforeComplete,
				artifacts: [{ type: "file", path: entry.reportedPath, action: "created" }],
			});
			assert.equal(completion.isError, undefined, completion.content?.[0]?.text);
			assert.equal(completion.details.status, "saved");
		});
	}

	await t.test("report-link/../summary.txt does not accept actual/summary.txt as satisfying the normalized declared target", async () => {
		const { completion } = await runStandaloneSingleWorker(t, ["report-link/../summary.txt"], {
			setup: cwd => {
				mkdirSync(join(cwd, "actual", "reports"), { recursive: true });
				symlinkSync("actual/reports", join(cwd, "report-link"));
			},
			beforeComplete: cwd => writeFileSync(join(cwd, "actual", "summary.txt"), "wrong summary\n"),
			artifacts: [{ type: "file", path: "actual/summary.txt", action: "created" }],
		});
		assert.equal(completion.isError, true);
	});

	await t.test("standalone plan and generate do not apply publication-only symlink traversal conflict rejection", async () => {
		const { cwd, service } = serviceFixture(t);
		symlinkSync("reports/../summary.txt", join(cwd, "alias"));
		const request: GenerateRequest = {
			project_cwd: cwd,
			topology: "graph",
			task: "Standalone symlink traversal allowed",
			agents: [{ persona: "first", node_id: "build", sub_task: "Build", output_contract: { required_artifact_paths: ["reports", "alias"] } }],
		};
		const preview = service.plan(request, workerModel);
		assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, ["reports", "alias"]);
		const run = await service.generate(request, workerModel);
		assert.ok(run.task_id);
	});

	await t.test("standalone preflight remains fail-closed for escaping or protected paths using dot and .. syntax", async () => {
		const { cwd, root, service } = serviceFixture(t);
		writeFileSync(join(cwd, "reports"), "regular file\n");
		writeFileSync(join(root, "outside-file"), "outside regular file\n");
		mkdirSync(join(root, "outside-dir"), { recursive: true });
		symlinkSync(join(root, "outside-dir"), join(cwd, "outside-dir-link"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agent-sessions"), "not a directory\n");

		for (const badPath of [
			"../outside-file/../project/summary.txt",
			"outside-dir-link/../summary.txt",
			"reports/nested/../../../outside.txt",
			"reports/nested/../../.pi/agent-sessions",
			".pi/agent-sessions/../summary.txt",
		]) {
			const bad: GenerateRequest = {
				project_cwd: cwd,
				topology: "graph",
				task: "Fail-closed preflight",
				agents: [{ persona: "first", node_id: "build", sub_task: "Build", output_contract: { required_artifact_paths: [badPath] } }],
			};
			assert.throws(() => service.plan(bad, workerModel), /required_artifact_paths/i, `expected plan rejection for ${badPath}`);
			await assert.rejects(service.generate(bad, workerModel), /required_artifact_paths/i, `expected generate rejection for ${badPath}`);
		}
	});
});

test("standalone runtime rejects dangling symlink traversal until missing intermediate directory exists", async t => {
	const cases: Array<{
		title: string;
		reportedPath: string;
		expectedReason: RegExp;
	}> = [
		{
			title: "rejects reporting regular summary.txt while alias -> reports/../summary.txt is dangling, then saves after mkdir reports",
			reportedPath: "summary.txt",
			expectedReason: /Missing required artifact "alias" in result artifacts/,
		},
		{
			title: "rejects reporting dangling alias while alias -> reports/../summary.txt cannot resolve, then saves after mkdir reports",
			reportedPath: "alias",
			expectedReason: /Missing or deleted required artifact file "alias"/,
		},
	];

	for (const entry of cases) {
		await t.test(entry.title, async st => {
			const { cwd, run, w1, completion } = await runStandaloneSingleWorker(st, ["alias"], {
				setup: dir => symlinkSync("reports/../summary.txt", join(dir, "alias")),
				beforeComplete: dir => writeFileSync(join(dir, "summary.txt"), "summary content\n"),
				artifacts: [{ type: "file", path: entry.reportedPath, action: "created" }],
			});
			const resultFile = join(run.session_dir, `${run.pane_manifest[0].instance_id}.result.json`);
			assert.equal(existsSync(join(cwd, "alias")), false);
			assert.equal(completion.isError, true);
			assert.equal(completion.details.status, "error");
			assert.match(completion.content?.[0]?.text ?? "", entry.expectedReason);
			assert.equal(existsSync(resultFile), false);

			const readDangling = await w1.readInput({ kind: "artifact", path: "alias" });
			assert.equal(readDangling.isError, true);
			assert.match(readDangling.content?.[0]?.text ?? "", /Missing or deleted artifact: alias/);

			mkdirSync(join(cwd, "reports"));
			assert.equal(existsSync(join(cwd, "alias")), true);

			const retried = await w1.complete({
				status: "success",
				summary: "Completed after reports dir created",
				detail: "ok",
				artifacts: [{ type: "file", path: entry.reportedPath, action: "created" }],
			});
			assert.equal(retried.isError, undefined, retried.content?.[0]?.text);
			assert.equal(retried.details.status, "saved");
			assert.equal(existsSync(resultFile), true);

			const saved = JSON.parse(readFileSync(resultFile, "utf8")) as {
				result: { status: string; artifacts?: Array<{ path?: string; sha256?: string; missing?: boolean }> };
			};
			assert.equal(saved.result.status, "success");
			assert.equal(saved.result.artifacts?.[0]?.path, entry.reportedPath);
			assert.equal(saved.result.artifacts?.[0]?.missing, undefined);
			assert.ok(saved.result.artifacts?.[0]?.sha256);

			const readResolved = await w1.readInput({ kind: "artifact", path: "alias" });
			assert.equal(readResolved.isError, undefined, readResolved.content?.[0]?.text);
			assert.match(readResolved.content?.[0]?.text ?? "", /summary content/);
		});
	}
});

test("standalone plan and generate remain compatible with in-scope .. and directory-like spellings rejected only at publication", async t => {
	const { draft, service } = fixture(t);
	for (const paths of [["reports", "reports/../summary.txt"], ["reports/."], ["reports/"]]) {
		const request: GenerateRequest = {
			...draft,
			agents: [{ ...draft.agents[0], output_contract: { required_artifact_paths: paths } }],
		};
		const preview = service.plan(request, sessionModel);
		assert.deepEqual(preview.agents[0].output_contract?.required_artifact_paths, paths);
		const manifest = await service.generate(request, { provider: sessionModel.provider, id: sessionModel.id });
		assert.ok(manifest.task_id);
	}
});

test("publication rejects impossible routed contracts and leaves the current v1 unchanged", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const invalid = structuredClone(draft);
	invalid.agents.push({
		persona: "second", node_id: "review", sub_task: "Review", depends_on: ["build"],
		decision: { field: "verdict", approve: "yes", reject: "no", on_reject: "build" },
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["yes", "no"], min_length: 4 } } },
	});
	const before = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.throws(() => open()({ action: "publish", name: "other", draft: invalid, sessionModel }), /verdict.*(min_length|satisfying)|decision.*contract/i);
	assert.deepEqual(open()({ action: "inspect", factory_id: receipt.factory_id }), before);
});

test("version-zero stores with any existing schema object are reported as corrupt", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const db = new DatabaseSync(database);
	try { db.exec("DROP TABLE IF EXISTS factory_inputs; DROP TABLE IF EXISTS factory_managers; DROP TABLE IF EXISTS factory_state; DROP TABLE factories; CREATE VIEW prior_evidence AS SELECT 123; PRAGMA user_version = 0"); } finally { db.close(); }
	assert.throws(() => open()({ action: "list" }), /corrupt|schema|version/i);
	assert.throws(() => open()({ action: "inspect", factory_id: receipt.factory_id }), /corrupt|schema|version/i);
});

test("publication rejects required array lengths beyond JavaScript's representable array length", t => {
	const { open, draft } = fixture(t);
	const invalid = structuredClone(draft);
	invalid.agents[0].output_contract = { required_fields: ["items"], properties: { items: { type: "array", min_length: 4294967296 } } };
	assert.throws(() => open()({ action: "publish", name: "impossible-array", draft: invalid, sessionModel }), /items.*(length|represent|possible|satisfy)/i);
});

test("publication rejects an unsatisfiable ordinary required output field", t => {
	const { open, draft } = fixture(t);
	const invalid = structuredClone(draft);
	invalid.agents[0].output_contract = { required_fields: ["answer"], properties: { answer: { type: "string", enum: ["yes"], min_length: 4 } } };
	assert.throws(() => open()({ action: "publish", name: "impossible", draft: invalid, sessionModel }), /build.*answer.*(impossible|satisfy|enum|length)/i);
});

test("inspection detects valid-JSON payload corruption in the real SQLite store", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	const db = new DatabaseSync(database);
	try { db.prepare("UPDATE factories SET definition = replace(definition, 'Build the change', 'Altered the change') WHERE factory_id = ?").run(receipt.factory_id); }
	finally { db.close(); }
	assert.throws(() => open()({ action: "inspect", factory_id: receipt.factory_id }), /corrupt|digest/i);
});

test("publication refuses a symlinked state directory before creating a database", t => {
	const { open, draft, root, service } = fixture(t);
	const canonical = join(root, "canonical");
	mkdirSync(canonical);
	const alias = join(root, "alias");
	symlinkSync(canonical, alias);
	const path = join(alias, "new", "factories.sqlite");
	assert.throws(() => factoryOperations(path, service)({ action: "publish", name: "quality", draft, sessionModel }), /symlink/i);
	assert.equal(existsSync(join(canonical, "new")), false);
});

test("publication refuses a symlinked database file without opening its target", t => {
	const { draft, root, service } = fixture(t);
	const target = join(root, "target.sqlite");
	writeFileSync(target, "preserve this file");
	const link = join(root, "linked.sqlite");
	symlinkSync(target, link);
	assert.throws(() => factoryOperations(link, service)({ action: "publish", name: "quality", draft, sessionModel }), /symlink/i);
	assert.equal(readFileSync(target, "utf8"), "preserve this file");
});

test("publication syncs newly created nested storage directory entries", t => {
	const { open, draft, root, service } = fixture(t);
	const nested = join(root, "new", "deep", "state", "factories.sqlite");
	const publish = factoryOperations(nested, service);
	const receipt = publish({ action: "publish", name: "quality", draft, sessionModel });
	assert.deepEqual(factoryOperations(nested, service)({ action: "inspect", factory_id: receipt.factory_id }).factory, receipt);
});

test("a lost post-commit acknowledgement is reported as uncertain and inspection recovers the durable factory ID", t => {
	const { open, draft, database, service } = fixture(t);
	const interrupted = factoryOperations(database, service, phase => {
		if (phase === "after_commit") throw new Error("simulated acknowledgement loss");
	});
	assert.throws(() => interrupted({ action: "publish", name: "quality", draft, sessionModel }), /outcome uncertain.*inspect with \/factory list/);
	const [receipt] = open()({ action: "list" });
	assert.ok(receipt.factory_id);
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.task, "Test changes");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), /already published/);
});

test("publication accepts Pi's max thinking level", t => {
	const { open, draft, cwd } = fixture(t);
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nmodel: test-provider/test-model:max\n---\nPrompt\n");
	const receipt = open()({ action: "publish", name: "max-thinking", draft, sessionModel });
	assert.equal(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].thinking, "max");
});

test("publication rejects an explicit model whose effective thinking level cannot be frozen", t => {
	const { open, draft, cwd } = fixture(t);
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nmodel: test-provider/other-model#variant\n---\nPrompt\n");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), /no valid resolved thinking level/i);
});

test("publication refuses a known non-directory managed session path", t => {
	const { open, draft, cwd } = fixture(t);
	const sessions = join(cwd, ".pi", "agent-sessions");
	writeFileSync(sessions, "not a directory");
	assert.throws(() => open()({ action: "publish", name: "quality", draft, sessionModel }), error => String(error).includes(sessions));
});

test("inspection preserves resolved settings even after the draft, persona, aliases and defaults change", t => {
	const { open, draft, cwd } = fixture(t);
	const persona = join(cwd, ".pi", "agents", "second.md");
	const config = join(cwd, ".pi", "bootstrap.json");
	const extension = join(cwd, "extensions", "extra.ts");
	writeFileSync(extension, "export default function () {}\n");
	writeFileSync(persona, "---\nmodel: reviewer\nskills:\nextensions: extra\n---\nPreserved review prompt\n");
	writeFileSync(config, JSON.stringify({
		modelAliases: { reviewer: { model: "test-provider/review-model", thinking: "high" } },
		graph: { defaults: { maxRevisions: 2, maxTotalAttempts: 5 } },
	}));
	draft.agents.push({
		persona: "second", node_id: "review", sub_task: "Check the change\nPreserve this line", depends_on: ["build"], required_checks: ["deterministic"],
		decision: { field: "verdict", approve: "yes", reject: "no", on_reject: "build" },
		output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["yes", "no"] } } },
	});
	const receipt = open()({ action: "publish", name: "quality", draft, sessionModel });
	draft.agents[1].sub_task = "Edited draft";
	writeFileSync(persona, "Edited persona");
	writeFileSync(config, "not valid JSON");
	const { definition } = open()({ action: "inspect", factory_id: receipt.factory_id });
	const [build, review] = definition.agents;
	assert.equal(definition.goal, "Test changes");
	assert.equal(definition.cleanup, "on_success");
	assert.equal(definition.ready_timeout_ms, 60_000);
	assert.equal(definition.dependency_wait_timeout_ms, 300_000);
	assert.equal(definition.max_total_attempts, 5);
	assert.equal(build.model, "test-provider/test-model");
	assert.equal(build.thinking, "medium");
	assert.deepEqual(build.tools, { mode: "declared", names: ["read", "bash"] });
	assert.deepEqual(build.skills, { mode: "inherit" });
	assert.equal(review.system_prompt, "Preserved review prompt");
	assert.equal(review.model, "test-provider/review-model");
	assert.equal(review.thinking, "high");
	assert.deepEqual(review.tools, { mode: "inherit" });
	assert.deepEqual(review.skills, { mode: "declared", names: [] });
	assert.deepEqual(review.extensions, { mode: "inherit_with_additions", declared: ["extra"], paths: [extension] });
	assert.equal(review.node.sub_task, "Check the change\nPreserve this line");
	assert.deepEqual(review.node.inbound_edges, ["build"]);
	assert.deepEqual(review.node.required_checks, ["deterministic"]);
	assert.deepEqual(review.node.output_contract?.properties?.verdict.enum, ["yes", "no"]);
	assert.equal(review.decision?.max_revisions, 2);
	assert.deepEqual(review.decision?.loop_body, ["build", "review"]);
});

test("a killed publisher exposes no partial v1, but a committed v1 survives a lost acknowledgement", async t => {
	const { root, open, draft, database } = fixture(t);
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
	mkdirSync(join(iso.agentDir, "agents"));
	writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
	const draftFile = join(root, "draft.json");
	// Exercise real database pages, not just a tiny insert held in SQLite's cache.
	const instruction = "x".repeat(3 * 1024 * 1024) + "\nEnd of assignment";
	writeFileSync(draftFile, JSON.stringify({ ...draft, agents: [{ ...draft.agents[0], sub_task: instruction }] }));
	const run = (name: string, phase: string) => runSupervised(process.execPath, [child, database, draftFile, name, phase], {
		env: { ...iso.env, PATH: join(root, "bin") }, timeoutMs: 10_000,
	});
	const before = await run("quality", "before_commit");
	assert.equal(before.signal, "SIGKILL", before.stderr);
	assert.equal(before.stdout, "");
	assert.deepEqual(open()({ action: "list" }), []);

	const after = await run("quality", "after_commit");
	assert.equal(after.signal, "SIGKILL", after.stderr);
	assert.equal(after.stdout, "");
	const [receipt] = open()({ action: "list" });
	assert.equal(receipt.current_version, "v1");
	assert.equal(receipt.management, "unmanaged");
	const recovered = open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0];
	assert.equal(recovered.node.sub_task, instruction);
	assert.equal(recovered.thinking, "medium");

	const interrupted = await run("another", "before_commit");
	assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
	assert.equal(interrupted.stdout, "");
	assert.deepEqual(open()({ action: "list" }), [receipt]);
	assert.ok(open()({ action: "inspect", factory_id: receipt.factory_id }).definition.agents[0].node.sub_task === instruction);
});

type StoredFactoryRow = { factory_id: string; name: string; definition: string; digest: string };

function snapshotFactories(dbPath: string): StoredFactoryRow[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare("SELECT factory_id, name, definition, digest FROM factories ORDER BY name").all() as StoredFactoryRow[];
	} finally {
		db.close();
	}
}

function downgradeToSchemaV1(dbPath: string): StoredFactoryRow[] {
	const rows = snapshotFactories(dbPath);
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`
			DROP TABLE IF EXISTS factory_inputs;
			DROP TABLE IF EXISTS factory_managers;
			DROP TABLE IF EXISTS factory_state;
			DROP TABLE IF EXISTS factories;
			CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
			PRAGMA user_version = 1;
		`);
		const insert = db.prepare("INSERT INTO factories (factory_id, name, definition, digest) VALUES (?, ?, ?, ?)");
		for (const row of rows) insert.run(row.factory_id, row.name, row.definition, row.digest);
	} finally {
		db.close();
	}
	return rows;
}

test("read operations preserve compatibility with real schema-v1 databases without mutating them", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "legacy-v1", draft, sessionModel });
	downgradeToSchemaV1(database);

	assert.deepEqual(open()({ action: "list" }), [receipt]);
	const inspected = open()({ action: "inspect", factory_id: receipt.factory_id });
	assert.deepEqual(inspected.factory, receipt);
	assert.deepEqual(inspected.queue, []);
	assert.throws(() => open()({ action: "receipt", factory_id: receipt.factory_id, reference: "ref-1" }), /not found/i);

	const checkDb = new DatabaseSync(database);
	try {
		assert.equal(checkDb.prepare("PRAGMA user_version").get()?.user_version, 1);
		assert.equal(checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_managers'").get(), undefined);
		assert.equal(checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_state'").get(), undefined);
	} finally {
		checkDb.close();
	}
});

test("explicit resume admits one unforgeable managing incarnation, is idempotent for it, fences others/orphans, and does not block publishing another factory", t => {
	const { open, draft, configs } = fixture(t);
	const factoryA = open()({ action: "publish", name: "alpha", draft, sessionModel });
	assert.equal(factoryA.management, "unmanaged");

	const authA = createManagerAuthority({ pi_session_id: "pi-sess-a", pi_session_file: "/tmp/a.jsonl" });
	const authB = createManagerAuthority({ pi_session_id: "pi-sess-a", pi_session_file: "/tmp/a.jsonl" }); // even same transcript ID cannot inherit
	const forged = { incarnation_id: authA.incarnation_id } as typeof authA;

	assert.throws(() => open()({ action: "resume", factory_id: factoryA.factory_id, authority: forged }), /authority|invalid|untrusted/i);
	assert.deepEqual(open()({ action: "list" }), [factoryA]);

	const resumed = open()({ action: "resume", factory_id: factoryA.factory_id, authority: authA });
	assert.equal(resumed.factory.factory_id, factoryA.factory_id);
	assert.equal(resumed.factory.management, "managed");
	assert.equal(resumed.already_managed, false);

	const retried = open()({ action: "resume", factory_id: factoryA.factory_id, authority: authA });
	assert.equal(retried.factory.management, "managed");
	assert.equal(retried.already_managed, true);

	assert.throws(() => open()({ action: "resume", factory_id: factoryA.factory_id, authority: authB }), /already managed|another session|takeover/i);

	// Revoking authA simulates session shutdown / reload; an orphan is not replaced.
	revokeManagerAuthority(authA);
	assert.throws(() => open()({ action: "resume", factory_id: factoryA.factory_id, authority: authA }), /authority|closed|revoked|replaced/i);
	assert.throws(() => open()({ action: "resume", factory_id: factoryA.factory_id, authority: authB }), /already managed|another session|takeover/i);

	// Ticket-01 publication of another factory does not depend on factory A's authority.
	const factoryB = open()({ action: "publish", name: "beta", draft, sessionModel });
	assert.equal(factoryB.management, "unmanaged");
	assert.equal(open()({ action: "list" }).find(f => f.factory_id === factoryA.factory_id)?.management, "managed");
	assert.deepEqual(configs, []);
});

test("submission fences authority inside the transaction, preserves exact UTF-8 text and literal references, and creates no run", t => {
	const { open, draft, configs } = fixture(t);
	const factory = open()({ action: "publish", name: "alpha", draft, sessionModel });
	const authA = createManagerAuthority({ pi_session_id: "sess-a", pi_session_file: "/tmp/a.jsonl" });
	const authB = createManagerAuthority({ pi_session_id: "sess-b", pi_session_file: "/tmp/b.jsonl" });

	// Unmanaged factory rejects submission.
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-1", brief: "Initial brief", authority: authA }),
		/unmanaged|resume/i,
	);

	open()({ action: "resume", factory_id: factory.factory_id, authority: authA });

	// Different or forged authority is fenced inside the admission transaction.
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-1", brief: "Initial brief", authority: authB }),
		/authority|managing session/i,
	);
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-1", brief: "Initial brief", authority: { incarnation_id: authA.incarnation_id } as typeof authA }),
		/authority|untrusted/i,
	);

	// Blank, whitespace-only, invalid UTF-16/UTF-8, and invalid references are rejected cleanly.
	for (const badBrief of ["", "   ", "\n\t\r\n", "bad\uD800surrogate"]) {
		assert.throws(
			() => open()({ action: "submit", factory_id: factory.factory_id, reference: "bad-brief", brief: badBrief, authority: authA }),
			/nonblank|well-formed|UTF-8/i,
		);
	}
	for (const badRef of ["", "  ", "Ref with space", "Ref\nnewline", "bad\uD800ref", "r".repeat(300)]) {
		assert.throws(
			() => open()({ action: "submit", factory_id: factory.factory_id, reference: badRef, brief: "Valid brief", authority: authA }),
			/reference/i,
		);
	}

	// Exact multiline UTF-8 preservation (distinctions that SQLite TEXT or Pi's editor could normalize).
	const exactBrief1 = "  leading spaces\r\n\tindented line\rline3\ncafé e\u0301 🚀\nSee #123 and src/app.ts\ntrailing spaces   \n\n";
	const exactBrief2 = "  leading spaces\n    indented line\nline3\ncaf\u00e9 \u00e9 🚀\nSee #123 and src/app.ts\ntrailing spaces   ";

	const r1 = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-A", brief: exactBrief1, authority: authA });
	const r2 = open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-a", brief: exactBrief2, authority: authA });
	const r3 = open()({ action: "submit", factory_id: factory.factory_id, reference: "001", brief: exactBrief1, authority: authA });

	assert.equal(r1.factory_id, factory.factory_id);
	assert.match(r1.input_id, /^[a-f0-9-]{36}$/);
	assert.equal(r1.reference, "Ref-A");
	assert.equal(r1.bound_version, "v1");
	assert.equal(r1.disposition, "queued");
	assert.equal(r1.queue_position, 1);
	assert.equal(r1.brief, exactBrief1);
	assert.equal(r1.brief_bytes, Buffer.byteLength(exactBrief1, "utf8"));
	assert.equal("task_id" in r1, false);
	assert.equal("run_id" in r1, false);

	// Literal reference tokens: Ref-A vs ref-a vs 001 are all distinct, and identical text at a new ref is distinct.
	assert.equal(r2.reference, "ref-a");
	assert.equal(r2.queue_position, 2);
	assert.equal(r2.brief, exactBrief2);
	assert.notEqual(r2.input_id, r1.input_id);

	assert.equal(r3.reference, "001");
	assert.equal(r3.queue_position, 3);
	assert.equal(r3.brief, exactBrief1);
	assert.notEqual(r3.input_id, r1.input_id);

	// Inspection exposes FIFO queue order without leaking private session metadata.
	const inspected = open()({ action: "inspect", factory_id: factory.factory_id });
	assert.deepEqual(inspected.queue.map(entry => [entry.queue_position, entry.reference, entry.input_id, entry.bound_version, entry.disposition, entry.brief]), [
		[1, "Ref-A", r1.input_id, "v1", "queued", exactBrief1],
		[2, "ref-a", r2.input_id, "v1", "queued", exactBrief2],
		[3, "001", r3.input_id, "v1", "queued", exactBrief1],
	]);
	const serialized = JSON.stringify(inspected);
	assert.equal(serialized.includes("sess-a"), false);
	assert.equal(serialized.includes("/tmp/a.jsonl"), false);
	assert.equal(serialized.includes(authA.incarnation_id), false);
	assert.deepEqual(configs, []);
});

test("submission enforces 16 KiB UTF-8 byte boundary and 32-entry queue capacity with retry precedence", t => {
	const { open, draft } = fixture(t);
	assert.equal(MAX_BRIEF_BYTES, 16 * 1024);
	assert.equal(MAX_QUEUED_INPUTS, 32);

	const factory = open()({ action: "publish", name: "limits", draft, sessionModel });
	const auth = createManagerAuthority();
	open()({ action: "resume", factory_id: factory.factory_id, authority: auth });

	// 4096 * 4-byte emoji = 16,384 bytes exactly (must succeed even though string.length is 8192).
	const exactMaxUtf8 = "🚀".repeat(4096);
	assert.equal(Buffer.byteLength(exactMaxUtf8, "utf8"), 16_384);
	const r1 = open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-1", brief: exactMaxUtf8, authority: auth });
	assert.equal(r1.brief_bytes, 16_384);
	assert.equal(r1.queue_position, 1);

	const overMaxUtf8 = exactMaxUtf8 + "a";
	assert.equal(Buffer.byteLength(overMaxUtf8, "utf8"), 16_385);
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-over", brief: overMaxUtf8, authority: auth }),
		/16\s*KiB|16384/,
	);

	// Fill remaining 31 queue slots (total 32).
	for (let i = 2; i <= 32; i++) {
		const receipt = open()({ action: "submit", factory_id: factory.factory_id, reference: `ref-${i}`, brief: `Brief #${i}`, authority: auth });
		assert.equal(receipt.queue_position, i);
	}

	// 33rd fresh reference is rejected without evicting work.
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-33", brief: "Overflow brief", authority: auth }),
		/32|full/i,
	);
	assert.equal(open()({ action: "inspect", factory_id: factory.factory_id }).queue.length, 32);

	// At 32/32 capacity, identical-reference retry is checked BEFORE capacity and returns the original receipt.
	const retried = open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-1", brief: exactMaxUtf8, authority: auth });
	assert.deepEqual(retried, r1);
	assert.equal(open()({ action: "inspect", factory_id: factory.factory_id }).queue.length, 32);

	// At 32/32 capacity, same reference with changed brief is a definite conflict.
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "ref-2", brief: "Changed brief", authority: auth }),
		/conflict|different brief/i,
	);
	assert.equal(open()({ action: "inspect", factory_id: factory.factory_id }).queue[1]?.brief, "Brief #2");
});

test("uncertain commit vs pre-commit rollback, read-only receipt recovery from any session, and input corruption detection", t => {
	const { open, draft, database, service } = fixture(t);
	const factory = open()({ action: "publish", name: "recover", draft, sessionModel });
	const auth = createManagerAuthority();

	// Simulated lost ack on resume.
	const afterCommitFail = factoryOperations(database, service, phase => {
		if (phase === "after_commit") throw new Error("lost ack");
	});
	assert.throws(
		() => afterCommitFail({ action: "resume", factory_id: factory.factory_id, authority: auth }),
		/outcome uncertain.*\/factory inspect/i,
	);
	assert.equal(open()({ action: "inspect", factory_id: factory.factory_id }).factory.management, "managed");
	assert.equal(open()({ action: "resume", factory_id: factory.factory_id, authority: auth }).already_managed, true);

	// Pre-commit error rolls back cleanly with no partial receipt.
	const beforeCommitFail = factoryOperations(database, service, phase => {
		if (phase === "before_commit") throw new Error("pre-commit abort");
	});
	assert.throws(
		() => beforeCommitFail({ action: "submit", factory_id: factory.factory_id, reference: "ref-pre", brief: "Pre-commit text", authority: auth }),
		/pre-commit abort/,
	);
	assert.deepEqual(open()({ action: "inspect", factory_id: factory.factory_id }).queue, []);
	assert.throws(
		() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "ref-pre" }),
		/not found/i,
	);

	// Post-commit lost ack reports uncertain outcome with factory + reference recovery path.
	assert.throws(
		() => afterCommitFail({ action: "submit", factory_id: factory.factory_id, reference: "Ref-Post", brief: "  Exact post-commit\nbrief  ", authority: auth }),
		/outcome uncertain.*\/factory receipt .* Ref-Post/i,
	);

	// Any session (read-only, no authority) can recover by literal reference or input_id.
	const byRef = open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-Post" });
	assert.equal(byRef.reference, "Ref-Post");
	assert.equal(byRef.bound_version, "v1");
	assert.equal(byRef.disposition, "queued");
	assert.equal(byRef.queue_position, 1);
	assert.equal(byRef.brief, "  Exact post-commit\nbrief  ");

	const byId = open()({ action: "receipt", factory_id: factory.factory_id, input_id: byRef.input_id });
	assert.deepEqual(byId, byRef);

	// Case-literal mismatch is not found.
	assert.throws(
		() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "ref-post" }),
		/not found/i,
	);

	// Identical retry recovers the exact original receipt without consuming a second slot.
	const retried = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-Post", brief: "  Exact post-commit\nbrief  ", authority: auth });
	assert.deepEqual(retried, byRef);
	assert.equal(open()({ action: "inspect", factory_id: factory.factory_id }).queue.length, 1);

	// Invalid receipt query combinations fail cleanly.
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id } as never), /requires/i);
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-Post", input_id: byRef.input_id } as never), /not both/i);

	// Input row tampering is detected and fails closed.
	const db = new DatabaseSync(database);
	try {
		db.prepare("UPDATE factory_inputs SET brief = 'tampered' WHERE input_id = ?").run(byRef.input_id);
	} finally {
		db.close();
	}
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-Post" }), /corruption detected.*input evidence mismatch/i);
	assert.throws(() => open()({ action: "inspect", factory_id: factory.factory_id }), /corruption detected.*input evidence mismatch/i);
});

test("concurrent isolated processes contend on resume, orphans are not replaced, and SIGKILL around commit preserves durability", async t => {
	const { root, open, draft, database } = fixture(t);
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	const child = fileURLToPath(new URL("./test-support/factory-submit-child.ts", import.meta.url));
	const env = { ...iso.env, PATH: join(root, "bin") };

	// 1. Concurrent race on resume: only one process acquires, the other is fenced.
	const facRace = open()({ action: "publish", name: "race-fac", draft, sessionModel });
	const ready1 = join(root, "ready-1");
	const ready2 = join(root, "ready-2");
	const goFile = join(root, "go");
	const g1 = spawnGroup(process.execPath, [child, "race-resume", database, facRace.factory_id, ready1, goFile], { env });
	const g2 = spawnGroup(process.execPath, [child, "race-resume", database, facRace.factory_id, ready2, goFile], { env });
	t.after(async () => { await g1.stop(); await g2.stop(); });
	let out1 = "";
	let out2 = "";
	let err1 = "";
	let err2 = "";
	g1.child.stdout.on("data", d => { out1 += d.toString(); });
	g2.child.stdout.on("data", d => { out2 += d.toString(); });
	g1.child.stderr.on("data", d => { err1 += d.toString(); });
	g2.child.stderr.on("data", d => { err2 += d.toString(); });
	const deadline = Date.now() + 8000;
	while ((!existsSync(ready1) || !existsSync(ready2)) && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 15));
	}
	assert.ok(existsSync(ready1) && existsSync(ready2), "race children did not signal ready");
	writeFileSync(goFile, "go");
	const [r1, r2] = await Promise.all([g1.closed, g2.closed]);
	const codes = [r1.code, r2.code].sort();
	assert.deepEqual(codes, [0, 1], `Expected one winner and one fenced loser: r1=${r1.code}(${err1}) r2=${r2.code}(${err2})`);
	const loserErr = r1.code === 1 ? err1 : err2;
	assert.match(loserErr, /already managed|another session/i);
	const winnerOut = r1.code === 0 ? out1 : out2;
	assert.equal(JSON.parse(winnerOut).factory.management, "managed");

	// Orphan from exited winner is NOT replaced by another process.
	const afterExit = await runSupervised(process.execPath, [child, "resume", database, facRace.factory_id, "none"], { env, timeoutMs: 10_000 });
	assert.equal(afterExit.code, 1);
	assert.match(afterExit.stderr, /already managed|another session/i);

	// 2. SIGKILL before_commit on resume rolls back cleanly so another process can resume.
	const facKill = open()({ action: "publish", name: "kill-fac", draft, sessionModel });
	const resumeBefore = await runSupervised(process.execPath, [child, "resume", database, facKill.factory_id, "before_commit"], { env, timeoutMs: 10_000 });
	assert.equal(resumeBefore.signal, "SIGKILL", resumeBefore.stderr);
	assert.equal(open()({ action: "inspect", factory_id: facKill.factory_id }).factory.management, "unmanaged");

	// SIGKILL after_commit on resume persists managed state and fences subsequent processes.
	const resumeAfter = await runSupervised(process.execPath, [child, "resume", database, facKill.factory_id, "after_commit"], { env, timeoutMs: 10_000 });
	assert.equal(resumeAfter.signal, "SIGKILL", resumeAfter.stderr);
	assert.equal(open()({ action: "inspect", factory_id: facKill.factory_id }).factory.management, "managed");
	const contested = await runSupervised(process.execPath, [child, "resume", database, facKill.factory_id, "none"], { env, timeoutMs: 10_000 });
	assert.equal(contested.code, 1);
	assert.match(contested.stderr, /already managed|another session/i);

	// 3. SIGKILL around submit commit on real on-disk SQLite pages.
	const facSub = open()({ action: "publish", name: "submit-kill", draft, sessionModel });
	const briefFile = join(root, "brief.txt");
	const exactLargeBrief = `  leading\r\n\t${"é".repeat(4000)}  \n`;
	writeFileSync(briefFile, exactLargeBrief, "utf8");

	// If child resumes AND submits with before_commit kill on submit: resume committed, submit rolled back.
	const subBefore = await runSupervised(process.execPath, [child, "submit", database, facSub.factory_id, "Ref-Before", briefFile, "before_commit", "resume_first"], { env, timeoutMs: 10_000 });
	assert.equal(subBefore.signal, "SIGKILL", subBefore.stderr);
	assert.equal(subBefore.stdout, "");
	assert.equal(open()({ action: "inspect", factory_id: facSub.factory_id }).factory.management, "managed");
	assert.deepEqual(open()({ action: "inspect", factory_id: facSub.factory_id }).queue, []);
	assert.throws(() => open()({ action: "receipt", factory_id: facSub.factory_id, reference: "Ref-Before" }), /not found/i);

	// On a fresh factory, child resumes and submits with after_commit kill on submit: receipt survives SIGKILL!
	const facSubAfter = open()({ action: "publish", name: "submit-after", draft, sessionModel });
	const subAfter = await runSupervised(process.execPath, [child, "submit", database, facSubAfter.factory_id, "Ref-After", briefFile, "after_commit", "resume_first"], { env, timeoutMs: 10_000 });
	assert.equal(subAfter.signal, "SIGKILL", subAfter.stderr);
	assert.equal(subAfter.stdout, "");

	// Independent read-only process recovers the exact committed receipt.
	const recovered = await runSupervised(process.execPath, [child, "receipt", database, facSubAfter.factory_id, "Ref-After"], { env, timeoutMs: 10_000 });
	assert.equal(recovered.code, 0, recovered.stderr);
	const receipt = JSON.parse(recovered.stdout);
	assert.equal(receipt.reference, "Ref-After");
	assert.equal(receipt.bound_version, "v1");
	assert.equal(receipt.disposition, "queued");
	assert.equal(receipt.queue_position, 1);
	assert.equal(receipt.brief, exactLargeBrief);

	// Direct inspect(queue) verifies factory_state.last_input_position and full queue integrity survived SIGKILL.
	const inspectedAfter = open()({ action: "inspect", factory_id: facSubAfter.factory_id });
	assert.equal(inspectedAfter.factory.management, "managed");
	assert.deepEqual(inspectedAfter.queue, [receipt]);

	// Different process is still fenced from submitting to that orphaned manager.
	const fencedSubmit = await runSupervised(process.execPath, [child, "submit", database, facSubAfter.factory_id, "Ref-Other", briefFile, "none"], { env, timeoutMs: 10_000 });
	assert.equal(fencedSubmit.code, 1);
	assert.match(fencedSubmit.stderr, /authority|managing session/i);
});

test("missing manager row contradicting existing receipt evidence blocks takeover and fails status/management paths closed without mutating valid receipts", t => {
	const { open, draft, database } = fixture(t);
	const factory = open()({ action: "publish", name: "damaged-orphan", draft, sessionModel });
	const auth1 = createManagerAuthority({ pi_session_id: "sess-1", pi_session_file: "/tmp/s1.jsonl" });
	open()({ action: "resume", factory_id: factory.factory_id, authority: auth1 });
	const originalReceipt = open()({
		action: "submit",
		factory_id: factory.factory_id,
		reference: "Ref-Valid",
		brief: "  Exact valid brief\r\n\tbefore damage  ",
		authority: auth1,
	});

	const db = new DatabaseSync(database);
	try {
		db.prepare("DELETE FROM factory_managers WHERE factory_id = ?").run(factory.factory_id);
	} finally {
		db.close();
	}

	const auth2 = createManagerAuthority({ pi_session_id: "sess-2", pi_session_file: "/tmp/s2.jsonl" });
	const missingManagerErr = /corruption detected.*without a manager record/i;
	assert.throws(() => open()({ action: "resume", factory_id: factory.factory_id, authority: auth2 }), missingManagerErr);
	assert.throws(() => open()({ action: "resume", factory_id: factory.factory_id, authority: auth1 }), missingManagerErr);
	assert.throws(() => open()({ action: "verify_manager", factory_id: factory.factory_id, authority: auth2 }), missingManagerErr);
	assert.throws(() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-New", brief: "Blocked brief", authority: auth2 }), missingManagerErr);
	assert.throws(() => open()({ action: "list" }), missingManagerErr);
	assert.throws(() => open()({ action: "inspect", factory_id: factory.factory_id }), missingManagerErr);

	assert.deepEqual(open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-Valid" }), originalReceipt);
	assert.deepEqual(open()({ action: "receipt", factory_id: factory.factory_id, input_id: originalReceipt.input_id }), originalReceipt);
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-Missing" }), /not found/i);

	const verifyDb = new DatabaseSync(database, { readOnly: true });
	try {
		assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM factory_managers WHERE factory_id = ?").get(factory.factory_id)?.count, 0);
		assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM factory_inputs WHERE factory_id = ?").get(factory.factory_id)?.count, 1);
	} finally {
		verifyDb.close();
	}
});

function assertQueueGapOrTruncation(t: test.TestContext, mode: "interior" | "tail") {
	const { open, draft, database } = fixture(t);
	const damaged = open()({ action: "publish", name: `${mode}-damaged`, draft, sessionModel });
	const healthy = open()({ action: "publish", name: `${mode}-healthy`, draft, sessionModel });
	const authDamaged = createManagerAuthority({ pi_session_id: `sess-${mode}` });
	const authHealthy = createManagerAuthority({ pi_session_id: `sess-${mode}-healthy` });
	open()({ action: "resume", factory_id: damaged.factory_id, authority: authDamaged });
	const r1 = open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-1", brief: "Brief 1", authority: authDamaged });
	const r2 = open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-2", brief: "Brief 2", authority: authDamaged });
	const r3 = mode === "interior"
		? open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-3", brief: "Brief 3", authority: authDamaged })
		: undefined;

	const db = new DatabaseSync(database);
	try {
		db.prepare("DELETE FROM factory_inputs WHERE input_id = ?").run(r2.input_id);
	} finally {
		db.close();
	}

	const queueIntegrityErr = /corruption detected.*(?:expected \d+ contiguous queued inputs|missing or non-contiguous queue position)/i;
	const listIntegrityErr = /corruption detected.*expected \d+ queued inputs, found \d+/i;
	assert.throws(() => open()({ action: "inspect", factory_id: damaged.factory_id }), queueIntegrityErr);
	assert.throws(() => open()({ action: "list" }), listIntegrityErr);

	// Existing owner can still verify management and recover intact retries independent of unrelated queue damage.
	assert.equal(open()({ action: "verify_manager", factory_id: damaged.factory_id, authority: authDamaged }).management, "managed");
	assert.deepEqual(open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-1", brief: "Brief 1", authority: authDamaged }), r1);

	const freshRef = mode === "interior" ? "Ref-4" : "Ref-3";
	assert.throws(() => open()({ action: "submit", factory_id: damaged.factory_id, reference: freshRef, brief: "Fresh brief", authority: authDamaged }), queueIntegrityErr);
	assert.throws(() => open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-2", brief: "Brief 2", authority: authDamaged }), queueIntegrityErr);

	assert.deepEqual(open()({ action: "receipt", factory_id: damaged.factory_id, reference: "Ref-1" }), r1);
	if (r3) assert.deepEqual(open()({ action: "receipt", factory_id: damaged.factory_id, reference: "Ref-3" }), r3);
	assert.throws(() => open()({ action: "receipt", factory_id: damaged.factory_id, reference: "Ref-2" }), /not found/i);
	assert.throws(() => open()({ action: "receipt", factory_id: damaged.factory_id, reference: freshRef }), /not found/i);

	// Unrelated healthy factory in the same DB remains operable.
	assert.equal(open()({ action: "inspect", factory_id: healthy.factory_id }).factory.management, "unmanaged");
	open()({ action: "resume", factory_id: healthy.factory_id, authority: authHealthy });
	assert.equal(open()({ action: "submit", factory_id: healthy.factory_id, reference: "Healthy-1", brief: "Healthy brief", authority: authHealthy }).queue_position, 1);

	const verifyDb = new DatabaseSync(database, { readOnly: true });
	try {
		const rows = verifyDb.prepare("SELECT input_id, reference, queue_position FROM factory_inputs WHERE factory_id = ? ORDER BY queue_position ASC").all(damaged.factory_id) as Array<{ input_id: string; reference: string; queue_position: number }>;
		const expected = r3
			? [
				{ input_id: r1.input_id, reference: "Ref-1", queue_position: 1 },
				{ input_id: r3.input_id, reference: "Ref-3", queue_position: 3 },
			]
			: [{ input_id: r1.input_id, reference: "Ref-1", queue_position: 1 }];
		assert.deepEqual(rows.map(r => ({ input_id: r.input_id, reference: r.reference, queue_position: r.queue_position })), expected);
	} finally {
		verifyDb.close();
	}
}

test("interior gap in factory_inputs blocks inspect, list, fresh admission, and vanished-ref retry while intact retry survives", t => {
	assertQueueGapOrTruncation(t, "interior");
});

test("lost tail in factory_inputs blocks inspect, list, fresh admission, and vanished-tail retry while intact retry survives", t => {
	assertQueueGapOrTruncation(t, "tail");
});

test("missing manager row on an empty established factory blocks status, verification, resume takeover, and submission", t => {
	const { open, draft, database } = fixture(t);
	const damaged = open()({ action: "publish", name: "empty-established", draft, sessionModel });
	const healthy = open()({ action: "publish", name: "healthy-unmanaged", draft, sessionModel });
	const auth1 = createManagerAuthority({ pi_session_id: "sess-1" });
	open()({ action: "resume", factory_id: damaged.factory_id, authority: auth1 });
	revokeManagerAuthority(auth1);

	const db = new DatabaseSync(database);
	try {
		db.prepare("DELETE FROM factory_managers WHERE factory_id = ?").run(damaged.factory_id);
	} finally {
		db.close();
	}

	const auth2 = createManagerAuthority({ pi_session_id: "sess-2" });
	const missingManagerErr = /corruption detected.*without a manager record/i;
	assert.throws(() => open()({ action: "inspect", factory_id: damaged.factory_id }), missingManagerErr);
	assert.throws(() => open()({ action: "list" }), missingManagerErr);
	assert.throws(() => open()({ action: "verify_manager", factory_id: damaged.factory_id, authority: auth2 }), missingManagerErr);
	assert.throws(() => open()({ action: "resume", factory_id: damaged.factory_id, authority: auth2 }), missingManagerErr);
	assert.throws(() => open()({ action: "submit", factory_id: damaged.factory_id, reference: "Ref-1", brief: "Brief 1", authority: auth2 }), missingManagerErr);

	assert.equal(open()({ action: "inspect", factory_id: healthy.factory_id }).factory.management, "unmanaged");
	assert.equal(open()({ action: "resume", factory_id: healthy.factory_id, authority: auth2 }).factory.management, "managed");

	const verifyDb = new DatabaseSync(database, { readOnly: true });
	try {
		assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM factory_managers WHERE factory_id = ?").get(damaged.factory_id)?.count, 0);
	} finally {
		verifyDb.close();
	}
});

test("unsupported old v2 database without factory_state fails closed without migrating or defaulting to unmanaged", t => {
	const { open, draft, database } = fixture(t);
	const receipt = open()({ action: "publish", name: "old-topic-v2", draft, sessionModel });
	const db = new DatabaseSync(database);
	try {
		db.exec("DROP TABLE IF EXISTS factory_state");
	} finally {
		db.close();
	}

	const auth = createManagerAuthority({ pi_session_id: "sess-old-v2" });
	const missingTablesErr = /corruption detected.*missing required tables/i;
	assert.throws(() => open()({ action: "list" }), missingTablesErr);
	assert.throws(() => open()({ action: "inspect", factory_id: receipt.factory_id }), missingTablesErr);
	assert.throws(() => open()({ action: "verify_manager", factory_id: receipt.factory_id, authority: auth }), missingTablesErr);
	assert.throws(() => open()({ action: "resume", factory_id: receipt.factory_id, authority: auth }), missingTablesErr);
	assert.throws(() => open()({ action: "receipt", factory_id: receipt.factory_id, reference: "Ref-1" }), missingTablesErr);
});

test("point-lookup retry of intact reference succeeds under auth fencing even when another queue row is damaged", t => {
	const { open, draft, database } = fixture(t);
	const factory = open()({ action: "publish", name: "point-retry", draft, sessionModel });
	const authA = createManagerAuthority({ pi_session_id: "sess-a" });
	const authB = createManagerAuthority({ pi_session_id: "sess-b" });
	open()({ action: "resume", factory_id: factory.factory_id, authority: authA });
	const rA = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-A", brief: "Brief A", authority: authA });
	const rB = open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-B", brief: "Brief B\r\nexact", authority: authA });

	const db = new DatabaseSync(database);
	try {
		db.prepare("UPDATE factory_inputs SET brief = 'tampered' WHERE input_id = ?").run(rA.input_id);
	} finally {
		db.close();
	}

	assert.equal(open()({ action: "verify_manager", factory_id: factory.factory_id, authority: authA }).management, "managed");

	const inputCorruptionErr = /corruption detected.*input evidence mismatch/i;
	assert.deepEqual(open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-B" }), rB);
	assert.deepEqual(open()({ action: "receipt", factory_id: factory.factory_id, input_id: rB.input_id }), rB);
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-A" }), inputCorruptionErr);

	assert.deepEqual(
		open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-B", brief: "Brief B\r\nexact", authority: authA }),
		rB,
	);
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-B", brief: "Brief B changed", authority: authA }),
		/conflict|different brief/i,
	);
	assert.throws(
		() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-B", brief: "Brief B\r\nexact", authority: authB }),
		/authority|managing session/i,
	);

	assert.throws(() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-A", brief: "Brief A", authority: authA }), inputCorruptionErr);
	assert.throws(() => open()({ action: "submit", factory_id: factory.factory_id, reference: "Ref-C", brief: "Brief C", authority: authA }), inputCorruptionErr);
	assert.throws(() => open()({ action: "receipt", factory_id: factory.factory_id, reference: "Ref-C" }), /not found/i);

	const verifyDb = new DatabaseSync(database, { readOnly: true });
	try {
		assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM factory_inputs WHERE factory_id = ?").get(factory.factory_id)?.count, 2);
		assert.equal(verifyDb.prepare("SELECT brief FROM factory_inputs WHERE input_id = ?").get(rA.input_id)?.brief, "tampered");
		assert.equal(verifyDb.prepare("SELECT brief FROM factory_inputs WHERE input_id = ?").get(rB.input_id)?.brief, "Brief B\r\nexact");
	} finally {
		verifyDb.close();
	}
});

test("schema-v1 databases stay v1 on reads, roll back cleanly on failed/killed upgrade, and initialize evidence for all factories on resume or publish", async t => {
	// 1. Resume upgrade path (with two existing v1 factories, rollback, SIGKILL before_commit, and successful resume + admission).
	{
		const { root, open, draft, database, service } = fixture(t);
		const f1 = open()({ action: "publish", name: "legacy-one", draft, sessionModel });
		const f2 = open()({ action: "publish", name: "legacy-two", draft, sessionModel });
		const originalRows = downgradeToSchemaV1(database);

		const auth1 = createManagerAuthority({ pi_session_id: "v1-sess-1" });
		const auth2 = createManagerAuthority({ pi_session_id: "v1-sess-2" });

		// Reads and rejected unmanaged submit must not migrate schema v1.
		assert.equal(open()({ action: "list" }).length, 2);
		assert.equal(open()({ action: "inspect", factory_id: f1.factory_id }).factory.management, "unmanaged");
		assert.throws(() => open()({ action: "verify_manager", factory_id: f1.factory_id, authority: auth1 }), /unmanaged/i);
		assert.throws(() => open()({ action: "submit", factory_id: f1.factory_id, reference: "Ref-Early", brief: "No", authority: auth1 }), /unmanaged/i);
		{
			const check = new DatabaseSync(database, { readOnly: true });
			try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1); } finally { check.close(); }
		}

		// Pre-commit error during v1->v2 resume rolls back DDL and user_version.
		const failBeforeCommit = factoryOperations(database, service, phase => {
			if (phase === "before_commit") throw new Error("abort v1 upgrade");
		});
		assert.throws(() => failBeforeCommit({ action: "resume", factory_id: f1.factory_id, authority: auth1 }), /abort v1 upgrade/);
		{
			const check = new DatabaseSync(database, { readOnly: true });
			try {
				assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
				assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_managers'").get(), undefined);
			} finally {
				check.close();
			}
		}

		// Real SIGKILL before_commit during v1->v2 resume also leaves schema v1 intact.
		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const child = fileURLToPath(new URL("./test-support/factory-submit-child.ts", import.meta.url));
		const env = { ...iso.env, PATH: join(root, "bin") };
		const killUpgrade = await runSupervised(process.execPath, [child, "resume", database, f1.factory_id, "before_commit"], { env, timeoutMs: 10_000 });
		assert.equal(killUpgrade.signal, "SIGKILL", killUpgrade.stderr);
		{
			const check = new DatabaseSync(database, { readOnly: true });
			try {
				assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1);
				assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_managers'").get(), undefined);
			} finally {
				check.close();
			}
		}

		// Successful resume upgrades to v2, initializes evidence for both f1 (managed) and f2 (unmanaged), and preserves definitions.
		const resumed = open()({ action: "resume", factory_id: f1.factory_id, authority: auth1 });
		assert.equal(resumed.factory.management, "managed");
		assert.equal(resumed.already_managed, false);
		assert.deepEqual(snapshotFactories(database), originalRows);
		assert.equal(open()({ action: "inspect", factory_id: f2.factory_id }).factory.management, "unmanaged");

		const s1 = open()({ action: "submit", factory_id: f1.factory_id, reference: "Ref-V1-1", brief: "First after v1 upgrade", authority: auth1 });
		assert.equal(s1.queue_position, 1);
		assert.equal(open()({ action: "resume", factory_id: f2.factory_id, authority: auth2 }).factory.management, "managed");
		const s2 = open()({ action: "submit", factory_id: f2.factory_id, reference: "Ref-V1-2", brief: "Second factory after v1 upgrade", authority: auth2 });
		assert.equal(s2.queue_position, 1);
	}

	// 2. Publish upgrade path on a real v1 database with existing factories.
	{
		const { open, draft, database, service } = fixture(t);
		const f1 = open()({ action: "publish", name: "pub-legacy-1", draft, sessionModel });
		const f2 = open()({ action: "publish", name: "pub-legacy-2", draft, sessionModel });
		const originalRows = downgradeToSchemaV1(database);

		const failBeforeCommit = factoryOperations(database, service, phase => {
			if (phase === "before_commit") throw new Error("abort publish v1 upgrade");
		});
		assert.throws(() => failBeforeCommit({ action: "publish", name: "pub-new-3", draft, sessionModel }), /abort publish v1 upgrade/);
		{
			const check = new DatabaseSync(database, { readOnly: true });
			try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 1); } finally { check.close(); }
		}

		const f3 = open()({ action: "publish", name: "pub-new-3", draft, sessionModel });
		assert.equal(f3.management, "unmanaged");
		const check = new DatabaseSync(database, { readOnly: true });
		try {
			assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2);
			assert.deepEqual(
				check.prepare("SELECT factory_id, name, definition, digest FROM factories WHERE factory_id IN (?, ?) ORDER BY name").all(f1.factory_id, f2.factory_id),
				originalRows,
			);
		} finally {
			check.close();
		}

		const auth = createManagerAuthority({ pi_session_id: "pub-v1-sess" });
		for (const fac of [f1, f2, f3]) {
			assert.equal(open()({ action: "inspect", factory_id: fac.factory_id }).factory.management, "unmanaged");
			assert.equal(open()({ action: "resume", factory_id: fac.factory_id, authority: auth }).factory.management, "managed");
			assert.equal(open()({ action: "submit", factory_id: fac.factory_id, reference: `Ref-${fac.name}`, brief: "Ok", authority: auth }).queue_position, 1);
		}
	}

	// 3. SIGKILL after_commit during v1->v2 resume persists upgrade and initialized state evidence for all factories.
	{
		const { root, open, draft, database } = fixture(t);
		const f1 = open()({ action: "publish", name: "kill-v1-1", draft, sessionModel });
		const f2 = open()({ action: "publish", name: "kill-v1-2", draft, sessionModel });
		downgradeToSchemaV1(database);

		const iso = isolatedPiEnvironment();
		t.after(() => iso.cleanup());
		const child = fileURLToPath(new URL("./test-support/factory-submit-child.ts", import.meta.url));
		const env = { ...iso.env, PATH: join(root, "bin") };
		const killAfter = await runSupervised(process.execPath, [child, "resume", database, f1.factory_id, "after_commit"], { env, timeoutMs: 10_000 });
		assert.equal(killAfter.signal, "SIGKILL", killAfter.stderr);

		const check = new DatabaseSync(database, { readOnly: true });
		try {
			assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2);
			assert.equal(check.prepare("SELECT established FROM factory_state WHERE factory_id = ?").get(f1.factory_id)?.established, 1);
			assert.equal(check.prepare("SELECT established FROM factory_state WHERE factory_id = ?").get(f2.factory_id)?.established, 0);
		} finally {
			check.close();
		}
		assert.equal(open()({ action: "inspect", factory_id: f1.factory_id }).factory.management, "managed");
		assert.equal(open()({ action: "inspect", factory_id: f2.factory_id }).factory.management, "unmanaged");
	}
});

test("missing or contradictory factory_state evidence fails closed without defaulting to unmanaged", t => {
	const { open, draft, database } = fixture(t);
	const f1 = open()({ action: "publish", name: "missing-state", draft, sessionModel });
	const f2 = open()({ action: "publish", name: "contradictory-unmanaged", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-state" });

	{
		const db = new DatabaseSync(database);
		try {
			db.prepare("DELETE FROM factory_state WHERE factory_id = ?").run(f1.factory_id);
		} finally {
			db.close();
		}
	}
	const missingStateErr = /corruption detected.*missing factory state evidence/i;
	assert.throws(() => open()({ action: "list" }), missingStateErr);
	assert.throws(() => open()({ action: "inspect", factory_id: f1.factory_id }), missingStateErr);
	assert.throws(() => open()({ action: "verify_manager", factory_id: f1.factory_id, authority: auth }), missingStateErr);
	assert.throws(() => open()({ action: "resume", factory_id: f1.factory_id, authority: auth }), missingStateErr);
	assert.throws(() => open()({ action: "submit", factory_id: f1.factory_id, reference: "Ref-1", brief: "Brief", authority: auth }), missingStateErr);

	assert.equal(open()({ action: "inspect", factory_id: f2.factory_id }).factory.management, "unmanaged");
	open()({ action: "resume", factory_id: f2.factory_id, authority: auth });
	open()({ action: "submit", factory_id: f2.factory_id, reference: "Ref-2", brief: "Brief 2", authority: auth });

	{
		const db = new DatabaseSync(database);
		try {
			db.prepare("UPDATE factory_state SET established = 0 WHERE factory_id = ?").run(f2.factory_id);
		} finally {
			db.close();
		}
	}
	const contradictoryStateErr = /corruption detected.*factory state evidence mismatch/i;
	assert.throws(() => open()({ action: "inspect", factory_id: f2.factory_id }), contradictoryStateErr);
	assert.throws(() => open()({ action: "verify_manager", factory_id: f2.factory_id, authority: auth }), contradictoryStateErr);
	assert.throws(() => open()({ action: "resume", factory_id: f2.factory_id, authority: auth }), contradictoryStateErr);
	assert.throws(() => open()({ action: "submit", factory_id: f2.factory_id, reference: "Ref-2", brief: "Brief 2", authority: auth }), contradictoryStateErr);
});
