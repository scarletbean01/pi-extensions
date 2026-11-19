import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { factoryOperations } from "../factory/operations.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
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
	try { db.exec("DROP TABLE factories; CREATE VIEW prior_evidence AS SELECT 123; PRAGMA user_version = 0"); } finally { db.close(); }
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
