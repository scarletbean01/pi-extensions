import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { sanitizeOperatorText, sanitizeOutputText } from "../factory/viewer/sanitize.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { serviceFixture, workerFromConfig, notification } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer, verifyReadOnlyViewerInChild } from "./test-support/factory-viewer-fixture.ts";

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };

function scanSentinels(text: string, sentinels: readonly string[], label: string) {
	for (const s of sentinels) {
		assert.equal(text.includes(s), false, `${label} leaked sentinel ${JSON.stringify(s)}`);
	}
}

test("sanitizeOutputText preserves line breaks, scrubs blocked/generic paths and control chars, and bounds by code points without splitting surrogate pairs", () => {
	const blocked = ["/var/lib/factory/store", "/home/alice/project"];
	const raw = [
		"Line 1\r\n  indented line 2",
		"path /var/lib/factory/store/factories.sqlite.",
		"prefix /home/alice/projectExtra",
		"generic /etc/passwd ~/secret C:\\Users\\bob\\key.txt file:///tmp/x",
		"ctrl \u202e\u200b\u0007end",
		"prose A/B ~5",
	].join("\n");

	const scrubbed = sanitizeOutputText(raw, 8000, blocked);
	assert.ok(scrubbed.includes("\n"), "line breaks must survive");
	assert.equal(scrubbed.includes("\r"), false, "CRLF must normalize to LF");
	assert.ok(scrubbed.includes("\n  indented line 2"), "indentation must survive");
	assert.ok(scrubbed.includes("path [redacted-path]."));
	assert.equal(scrubbed.includes("[redacted-path]Extra"), false, "prefix blocked path must scrub entire token");
	assert.equal(scrubbed.includes("/var/lib/factory/store"), false);
	assert.equal(scrubbed.includes("/home/alice/project"), false);
	assert.equal(scrubbed.includes("/etc/passwd"), false);
	assert.equal(scrubbed.includes("~/secret"), false);
	assert.equal(scrubbed.includes("C:\\Users\\bob\\key.txt"), false);
	assert.equal(scrubbed.includes("file:///tmp/x"), false);
	assert.ok(scrubbed.includes("[ctrl]"));
	assert.equal(scrubbed.includes("\u202e"), false);
	assert.equal(scrubbed.includes("\u200b"), false);
	assert.equal(scrubbed.includes("\u0007"), false);
	assert.ok(scrubbed.includes("prose A/B ~5"));

	// Surrogate pair right near truncation boundary + omission count marker
	const longSurrogate = `${"A".repeat(960)}🚀${"B".repeat(200)}`;
	const bounded = sanitizeOutputText(longSurrogate, 1000, []);
	assert.equal(bounded.isWellFormed(), true, "truncation must not split surrogate pair");
	assert.ok(Array.from(bounded).length <= 1000, `expected <= 1000 code points, got ${Array.from(bounded).length}`);
	const markerMatch = /\[truncated, (\d+) characters? omitted\]$/.exec(bounded);
	assert.ok(markerMatch, `expected truncation marker in: ${bounded}`);
	const omitted = Number(markerMatch[1]);
	assert.ok(omitted > 160, `expected omitted count > 160, got ${omitted}`);

	// Compare with sanitizeOperatorText (one-line)
	const single = sanitizeOperatorText("a\nb\tc", 100, []);
	assert.equal(single, "a b c");
});

test("GET /api/factories/:id/output enforces query/not-found rules, scrubs summary/detail/live-summary, caps fields, and handles absence and hostile files", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const idleFac = ops({
		action: "publish",
		name: "output-idle-fac",
		draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE_IDLE_PROMPT", agents: [{ node_id: "idle_node", persona: "builder", sub_task: "PRIVATE_IDLE_SUB" }] },
		sessionModel,
	});

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_OUT_PROMPT",
		agents: [
			{ node_id: "done_node", persona: "builder", sub_task: "PRIVATE_DONE_SUB" },
			{ node_id: "long_node", persona: "builder", sub_task: "PRIVATE_LONG_SUB" },
			{ node_id: "run_node", persona: "builder", sub_task: "PRIVATE_RUN_SUB" },
			{ node_id: "pend_node", persona: "builder", sub_task: "PRIVATE_PEND_SUB", depends_on: ["run_node"] },
			{ node_id: "bad_json_node", persona: "builder", sub_task: "PRIVATE_BADJSON_SUB" },
			{ node_id: "wrong_id_node", persona: "builder", sub_task: "PRIVATE_WRONGID_SUB" },
			{ node_id: "oversize_node", persona: "builder", sub_task: "PRIVATE_OVERSIZE_SUB" },
			{ node_id: "missing_res_node", persona: "builder", sub_task: "PRIVATE_MISSING_SUB" },
			{
				node_id: "cmd_node",
				kind: "command",
				command: process.execPath,
				args: ["-e", "process.exit(0)", "--sentinel-cmd-arg"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_CMD_SUB",
			},
		],
	};

	const fac = ops({ action: "publish", name: "output-main-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-output-main" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "out-ref-1", brief: "PRIVATE_OUT_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;

	// 1. done_node: multi-line detail + paths + control/bidi chars in BOTH summary and detail
	const doneEntry = entryOf("done_node");
	const doneCfg = readJson<WorkerConfig>(join(dir, `${doneEntry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, doneEntry.instance_id),
		completionRecord(
			doneCfg,
			{
				agent_name: doneEntry.persona_name,
				node_id: "done_node",
				status: "success",
				summary: `Summary at ${dir} and ${f.cwd}/src/a.ts\nwith\u202ectrl\u200b`,
				detail: `Line 1 in ${f.home}/.pi/file\nLine 2 in ${statePath}\nLine 3 /etc/shadow \u0007alert <script>alert(1)</script>`,
				metrics: { PRIVATE_METRIC: 99 },
				artifacts: [{ type: "file", path: join(f.cwd, "PRIVATE_ARTIFACT_PATH.txt"), description: "Out file" }],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	// 2. long_node: summary > 1000 code points, detail > 8000 code points (with surrogate pair near boundary)
	const longEntry = entryOf("long_node");
	const longCfg = readJson<WorkerConfig>(join(dir, `${longEntry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, longEntry.instance_id),
		completionRecord(
			longCfg,
			{
				agent_name: longEntry.persona_name,
				node_id: "long_node",
				status: "partial",
				summary: `${"S".repeat(960)}🚀${"X".repeat(200)}`,
				detail: `${"D".repeat(7950)}🚀\n${"Y".repeat(400)}`,
			},
			"sent",
			"2026-01-01T00:00:02.000Z",
		),
	);

	// 3. run_node: alive ready + working progress
	const runEntry = entryOf("run_node");
	atomicJson(readyPath(dir, runEntry.instance_id), {
		version: 2,
		direction_incarnation: "inc-run",
		task_id: launched.task_id,
		token: launched.manifest.token,
		instance_id: runEntry.instance_id,
		pid: process.pid,
		session_id: "sess-run",
		name: runEntry.instance_id,
		endpoint: "/tmp/PRIVATE_ENDPOINT_SOCKET",
		model: "test-provider/test-model",
	});
	atomicJson(join(dir, `${runEntry.instance_id}.progress.json`), {
		attempt_id: runEntry.attempt_id,
		token: launched.manifest.token,
		updated_at: Date.now(),
		started_at: Date.now() - 1000,
		state: "working",
	});

	// 4. bad_json_node: corrupt JSON result file
	const badJsonEntry = entryOf("bad_json_node");
	const badJsonPath = resultPath(dir, badJsonEntry.instance_id);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(badJsonPath, "{corrupt PRIVATE_BAD_JSON");

	// 5. wrong_id_node: valid JSON completion for a foreign run_id
	const wrongEntry = entryOf("wrong_id_node");
	atomicJson(resultPath(dir, wrongEntry.instance_id), {
		version: 2,
		identity: {
			run_id: "foreign-run",
			node_id: "wrong_id_node",
			persona_name: wrongEntry.persona_name,
			attempt_id: wrongEntry.attempt_id!,
			instance_id: wrongEntry.instance_id,
		},
		result: {
			agent_name: wrongEntry.persona_name,
			node_id: "wrong_id_node",
			status: "success",
			summary: "PRIVATE_WRONG_ID_SUMMARY",
			detail: "PRIVATE_WRONG_ID_DETAIL",
		},
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:03.000Z",
	});

	// 6. oversize_node: > 1 MiB result file containing private sentinel
	const oversizeEntry = entryOf("oversize_node");
	writeFileSync(
		resultPath(dir, oversizeEntry.instance_id),
		JSON.stringify({
			summary: "PRIVATE_OVERSIZE_LEAK",
			padding: "Z".repeat(1024 * 1024 + 128),
		}),
	);

	// 7. missing_res_node: outcome-claim completed without result file
	const missingEntry = entryOf("missing_res_node");
	atomicJson(join(dir, `${missingEntry.instance_id}.outcome-claim.json`), {
		version: 1,
		identity: {
			run_id: launched.task_id,
			node_id: "missing_res_node",
			persona_name: missingEntry.persona_name,
			attempt_id: missingEntry.attempt_id!,
			instance_id: missingEntry.instance_id,
		},
		outcome: "completed",
		claimed_at: "2026-01-01T00:00:03.000Z",
	});

	// 8. cmd_node: command result with command_evidence excerpts that must NOT leak in Ticket 01
	const cmdEntry = entryOf("cmd_node");
	const cmdCfg = readJson<WorkerConfig>(join(dir, `${cmdEntry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, cmdEntry.instance_id),
		completionRecord(
			cmdCfg,
			{
				agent_name: cmdEntry.persona_name,
				node_id: "cmd_node",
				status: "success",
				summary: "Command ran cleanly",
				detail: "Stdout captured.",
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "process.exit(0)", "--sentinel-cmd-arg"],
					working_directory: f.cwd,
					exit_code: 0,
					signal: null,
					started_at: "2026-01-01T00:00:00.000Z",
					finished_at: "2026-01-01T00:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 12,
					stderr_bytes: 0,
					stdout_excerpt: "PRIVATE_CMD_STDOUT_EXCERPT",
					stderr_excerpt: "PRIVATE_CMD_STDERR_EXCERPT",
				},
			},
			"not_required",
			"2026-01-01T00:00:04.000Z",
		),
	);

	const sentinels = [
		"PRIVATE_",
		f.root,
		f.cwd,
		f.home,
		dir,
		statePath,
		coordinationPath,
		"/etc/shadow",
		"--sentinel-cmd-arg",
		"/tmp/PRIVATE_ENDPOINT_SOCKET",
	];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Method, host, cache, query validation & not-found rules
			const postRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=done_node`, { method: "POST" });
			assert.equal(postRes.status, 405);
			assert.equal(postRes.headers.get("allow"), "GET");

			for (const badUrl of [
				`/api/factories/${fac.factory_id}/output`,
				`/api/factories/${fac.factory_id}/output?node=`,
				`/api/factories/${fac.factory_id}/output?node=../bad`,
				`/api/factories/${fac.factory_id}/output?node=done_node&extra=1`,
				`/api/factories/${fac.factory_id}/output?node=done_node&node=long_node`,
				`/api/factories/${fac.factory_id}/output?node=${"a".repeat(257)}`,
			]) {
				const res = await fetch(`${viewer.url}${badUrl}`);
				assert.equal(res.status, 400, `expected 400 for ${badUrl}`);
			}

			for (const nfUrl of [
				`/api/factories/unknown_fac/output?node=done_node`,
				`/api/factories/${fac.factory_id}/output?node=nonexistent_node`,
				`/api/factories/${idleFac.factory_id}/output?node=idle_node`,
			]) {
				const res = await fetch(`${viewer.url}${nfUrl}`);
				assert.equal(res.status, 404, `expected 404 for ${nfUrl}`);
			}

			// Existing live snapshot one-line summary is scrubbed & bounded
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			scanSentinels(liveText, sentinels, "live snapshot");
			const live = JSON.parse(liveText);
			const liveDone = live.graph.nodes.find((n: any) => n.id === "done_node");
			assert.match(liveDone.current_attempt.summary, /\[redacted-path\]/);
			assert.match(liveDone.current_attempt.summary, /\[ctrl\]/);
			assert.equal(liveDone.current_attempt.summary.includes("\n"), false);
			const liveLong = live.graph.nodes.find((n: any) => n.id === "long_node");
			assert.ok(Array.from(liveLong.current_attempt.summary).length <= 1000);

			// /output for done_node: status, scrubbed summary/detail with preserved line breaks
			const doneRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=done_node`);
			assert.equal(doneRes.status, 200);
			assert.equal(doneRes.headers.get("cache-control"), "no-store");
			const doneText = await doneRes.text();
			scanSentinels(doneText, sentinels, "output done_node");
			const doneOut = JSON.parse(doneText);
			assert.equal(doneOut.factory_id, fac.factory_id);
			assert.equal(doneOut.node_id, "done_node");
			assert.equal(doneOut.latest_attempt.evidence, "available");
			assert.equal(doneOut.latest_attempt.status, "succeeded");
			assert.match(doneOut.latest_attempt.summary, /\n/);
			assert.match(doneOut.latest_attempt.summary, /\[redacted-path\]/);
			assert.match(doneOut.latest_attempt.summary, /\[ctrl\]/);
			assert.match(doneOut.latest_attempt.detail, /^Line 1 in \[redacted-path\]\nLine 2 in \[redacted-path\]\nLine 3 \[redacted-path\] \[ctrl\] alert <script>alert\(1\)<\/script>$/);

			// /output for long_node: caps 1,000 summary & 8,000 detail with omission markers and valid surrogate pairs
			const longRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=long_node`);
			assert.equal(longRes.status, 200);
			const longOut = await longRes.json() as any;
			assert.equal(longOut.latest_attempt.evidence, "available");
			assert.equal(longOut.latest_attempt.status, "partial");
			assert.equal(longOut.latest_attempt.summary.isWellFormed(), true);
			assert.ok(Array.from(longOut.latest_attempt.summary).length <= 1000);
			assert.match(longOut.latest_attempt.summary, /\[truncated, \d+ characters? omitted\]$/);
			assert.equal(longOut.latest_attempt.detail.isWellFormed(), true);
			assert.ok(Array.from(longOut.latest_attempt.detail).length <= 8000);
			assert.match(longOut.latest_attempt.detail, /\[truncated, \d+ characters? omitted\]$/);

			// /output for running and pending nodes -> Not applicable
			for (const activeNode of ["run_node", "pend_node"]) {
				const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${activeNode}`);
				assert.equal(res.status, 200);
				const out = await res.json() as any;
				assert.equal(out.latest_attempt.evidence, "not applicable", activeNode);
				assert.equal(out.latest_attempt.absence, "not applicable", activeNode);
				assert.match(out.latest_attempt.explanation, /when the attempt finishes/i, activeNode);
			}

			// /output for corrupt, wrong-identity, oversize, missing result -> Evidence unavailable & zero leaks
			for (const badNode of ["bad_json_node", "wrong_id_node", "oversize_node", "missing_res_node"]) {
				const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${badNode}`);
				assert.equal(res.status, 200);
				const text = await res.text();
				scanSentinels(text, sentinels, `output ${badNode}`);
				const out = JSON.parse(text);
				assert.equal(out.latest_attempt.evidence, "unavailable", badNode);
				assert.equal(out.latest_attempt.absence, "evidence unavailable", badNode);
			}

			// /output for cmd_node must not leak command excerpts
			const cmdRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_node`);
			assert.equal(cmdRes.status, 200);
			scanSentinels(await cmdRes.text(), sentinels, "output cmd_node");
		},
	);
});

test("GET /api/factories/:id/output refuses symlinked and FIFO result files without blocking or leaking", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_HOSTILE_PROMPT",
		agents: [
			{ node_id: "symlink_node", persona: "builder", sub_task: "PRIVATE_SYM" },
			{ node_id: "fifo_node", persona: "builder", sub_task: "PRIVATE_FIFO" },
		],
	};
	const fac = ops({ action: "publish", name: "hostile-output-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-hostile-out" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "hostile-ref", brief: "PRIVATE_HOSTILE_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const { symlinkSync, writeFileSync } = await import("node:fs");
	const symEntry = launched.manifest.pane_manifest.find(e => e.node_id === "symlink_node")!;
	const outside = join(f.root, "outside-output.json");
	writeFileSync(outside, JSON.stringify({ result: { summary: "PRIVATE_SYMLINK_OUT" } }));
	symlinkSync(outside, resultPath(dir, symEntry.instance_id));

	const fifoEntry = launched.manifest.pane_manifest.find(e => e.node_id === "fifo_node")!;
	execFileSync("mkfifo", [resultPath(dir, fifoEntry.instance_id)]);

	const responses = await verifyReadOnlyViewerInChild({
		stateDirs: f.root,
		viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home },
		paths: [
			`/api/factories/${fac.factory_id}/output?node=symlink_node`,
			`/api/factories/${fac.factory_id}/output?node=fifo_node`,
		],
	});

	for (const resp of responses) {
		assert.equal(resp.status, 200);
		assert.equal(resp.text.includes("PRIVATE_"), false, `leaked private sentinel in ${resp.path}`);
		const body = JSON.parse(resp.text);
		assert.equal(body.latest_attempt.evidence, "unavailable");
		assert.equal(body.latest_attempt.absence, "evidence unavailable");
	}
});

test("GET /api/factories/:id/output tracks latest attempt in review loops and fails closed on uncertain run evidence", async t => {
	const { rmSync } = await import("node:fs");
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_LOOP_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_LOOP_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_LOOP_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
			},
		],
	};
	const fac = ops({ action: "publish", name: "loop-output-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-loop-out" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "loop-out-ref", brief: "PRIVATE_LOOP_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const workerModel = { provider: "test-provider", id: "test-model" };
	const build = workerFromConfig(t, join(dir, `${buildEntry.instance_id}.config.json`), { model: workerModel });
	const review = workerFromConfig(t, join(dir, `${reviewEntry.instance_id}.config.json`), { model: workerModel });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();

	// Attempt 1 finishes, reviewer rejects & triggers attempt 2, attempt 2 is running (no result yet).
	await build.complete({ status: "success", summary: "Attempt 1 summary", detail: "Attempt 1 detail" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise", detail: "Needs attempt 2", outputs: { verdict: "revise" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(res.status, 200);
			const out = await res.json() as any;
			assert.equal(out.latest_attempt.attempt_number, 2);
			assert.equal(out.latest_attempt.evidence, "not applicable");
			assert.equal(out.latest_attempt.absence, "not applicable");
			assert.match(out.latest_attempt.explanation, /when the attempt finishes/i);
		},
	);

	// Now attempt 2 finishes -> latest attempt 2 output is returned.
	await build.complete({ status: "success", summary: "Attempt 2 summary", detail: "Attempt 2 line 1\nAttempt 2 line 2" });

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(res.status, 200);
			const out = await res.json() as any;
			assert.equal(out.latest_attempt.attempt_number, 2);
			assert.equal(out.latest_attempt.evidence, "available");
			assert.equal(out.latest_attempt.status, "succeeded");
			assert.equal(out.latest_attempt.summary, "Attempt 2 summary");
			assert.equal(out.latest_attempt.detail, "Attempt 2 line 1\nAttempt 2 line 2");
		},
	);

	// Remove release.json -> run becomes uncertain -> /output refuses to invent output and returns evidence unavailable.
	rmSync(join(dir, "release.json"));
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(res.status, 200);
			const text = await res.text();
			assert.equal(text.includes("Attempt 2 summary"), false, "uncertain run must not serve unverified output");
			const out = JSON.parse(text);
			assert.equal(out.evidence, "unavailable");
			assert.equal(out.absence, "evidence unavailable");
		},
	);
});
