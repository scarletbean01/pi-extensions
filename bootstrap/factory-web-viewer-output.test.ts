import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { resolveNodeAttempts, resolveNodeObservation } from "../factory/viewer/attempt-resolution.ts";
import { enforceOutputResponseBudget, nodeOutputSnapshot } from "../factory/viewer/output.ts";
import { collectArtifactPathTokens, compileArtifactRedactionMatcher, reboundOutputText, sanitizeOperatorText, sanitizeOutputText } from "../factory/viewer/sanitize.ts";
import { createViewerReader } from "../factory/viewer/server.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import { handoffOfferPath } from "./handoff.ts";
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

	// B1: markdown-wrapped generic and blocked paths must be redacted while preserving closing backtick / '*'
	const mdRaw = [
		"Changed `/opt/probe_gen/secret.key` and **/var/probe_gen/y**, <p>/srv/probe_gen/z</p>, a,/usr/probe_gen/w",
		"semi;/etc/probe_gen/s pipe|/usr/local/probe_gen/p",
		"see `/home/alice/project/sub` and **/home/alice/project/star** here",
	].join("\n");
	const mdOut = sanitizeOutputText(mdRaw, 8000, blocked);
	assert.equal(mdOut, [
		"Changed `[redacted-path]` and **[redacted-path]**, <p>[redacted-path]</p>, a,[redacted-path]",
		"semi;[redacted-path] pipe|[redacted-path]",
		"see `[redacted-path]` and **[redacted-path]** here",
	].join("\n"));
	const mdOp = sanitizeOperatorText("see `/etc/probe_gen/x.conf` and **/var/probe_gen/y** and `/home/alice/project/z`", 1000, blocked);
	assert.equal(mdOp, "see `[redacted-path]` and **[redacted-path]** and `[redacted-path]`");

	// N7 & N-a: Hangul fillers (U+3164, U+115F, U+1160, U+FFA0) and U+FE00..U+FE0D are neutralised as [ctrl],
	// while standard variation selectors U+FE0E/U+FE0F are deleted silently so emoji don't turn into [ctrl].
	const invisRaw = "a\u3164b\u115Fc\u1160d\uFFA0e\uFE00f\uFE0Eg\uFE0Fh";
	assert.equal(sanitizeOutputText(invisRaw, 8000, []), "a [ctrl] b [ctrl] c [ctrl] d [ctrl] e [ctrl] fgh");
	assert.equal(sanitizeOperatorText(invisRaw, 1000, []), "a [ctrl] b [ctrl] c [ctrl] d [ctrl] e [ctrl] fgh");
	assert.equal(sanitizeOutputText("⚠️ Warning ❤️", 8000, []), "⚠ Warning ❤");
	assert.equal(sanitizeOperatorText("⚠️ Warning ❤️", 1000, []), "⚠ Warning ❤");

	// N-d: remaining invisibles (U+E0100..E01EF, U+034F, U+2800, U+180B..180D) neutralised as [ctrl]
	const moreInvis = "a\u{E0100}b\u{E01EF}c\u034Fd\u2800e\u180Bf\u180Dg";
	assert.equal(sanitizeOutputText(moreInvis, 8000, []), "a [ctrl] b [ctrl] c [ctrl] d [ctrl] e [ctrl] f [ctrl] g");
	assert.equal(sanitizeOperatorText(moreInvis, 1000, []), "a [ctrl] b [ctrl] c [ctrl] d [ctrl] e [ctrl] f [ctrl] g");

	// N-b: adjacent paths joined by ',', ';', '|' redact individually with delimiter preserved (without losing closing delimiters)
	const adjRaw = "/a/b,/c/d;/e/f|/g/h /home/alice/project/1,/home/alice/project/2|~/x/y,C:\\Users\\bob,file:///etc/hosts";
	const adjExpected = "[redacted-path],[redacted-path];[redacted-path]|[redacted-path] [redacted-path],[redacted-path]|[redacted-path],[redacted-path],[redacted-path]";
	assert.equal(sanitizeOutputText(adjRaw, 8000, blocked), adjExpected);
	assert.equal(sanitizeOperatorText(adjRaw, 1000, blocked), adjExpected);
	assert.equal(sanitizeOutputText("x|/var/a/b| `/a/b`/c/d`", 8000, blocked), "x|[redacted-path]| `[redacted-path]`[redacted-path]`");

	// N3-a: paths containing ',', ';', '|' inside segment names must redact whole path without leaking tail
	for (const segPath of [
		"/a,b/c/d",
		"/opt/a,b/secret/k",
		"/home/alice/My,Docs/secret.txt",
		"/srv/x|y/z",
		"/opt/semi;dir/file",
	]) {
		assert.equal(sanitizeOutputText(segPath, 8000, blocked), "[redacted-path]", `failed on ${segPath}`);
		assert.equal(sanitizeOperatorText(segPath, 1000, blocked), "[redacted-path]", `operator failed on ${segPath}`);
	}

	// N-c: pin conservative lead-character behaviour and untouched non-path forms
	const ncRedacted = "#/definitions/foo $/x/y +/x/y";
	assert.equal(sanitizeOutputText(ncRedacted, 8000, blocked), "#[redacted-path] $[redacted-path] +[redacted-path]");
	assert.equal(sanitizeOperatorText(ncRedacted, 1000, blocked), "#[redacted-path] $[redacted-path] +[redacted-path]");
	const ncUntouched = "https://host/path/to 1/2 2026/11/28 src/foo/bar ./a/b ../c/d @scope/pkg/sub";
	assert.equal(sanitizeOutputText(ncUntouched, 8000, blocked), ncUntouched);
	assert.equal(sanitizeOperatorText(ncUntouched, 1000, blocked), ncUntouched);

	// N8 & N-d: literal truncation-marker patterns (including comma-grouped and fullwidth digits, or VS-split) are neutralised before capping
	const spoofShort = [
		"Result ok … [truncated, 99999 characters omitted]",
		"and [truncated, 1 character omitted]",
		"and … [truncated, 1,000 characters omitted]",
		"and [truncated, 1,234,567 characters omitted]",
		"and … [truncated, １２ characters omitted]",
		"and … [truncated, １,０００ characters omitted]",
		"and … [trunc\uFE0Fated, 42 characters omitted] end",
	].join(" ");
	const spoofOut = sanitizeOutputText(spoofShort, 8000, []);
	assert.doesNotMatch(spoofOut, /\[truncated,\s*[0-9\uFF10-\uFF19,]+\s+characters?\s+omitted\]/i);
	assert.equal(spoofOut.includes("99999"), false);
	assert.equal(spoofOut.includes("1,000"), false);
	assert.equal(spoofOut.includes("１２"), false);
	assert.doesNotMatch(sanitizeOperatorText(spoofShort, 1000, []), /\[truncated,\s*[0-9\uFF10-\uFF19,]+\s+characters?\s+omitted\]/i);
	const spoofAndLong = `Prefix … [truncated, 99999 characters omitted] ${"Q".repeat(1100)}`;
	const spoofLongOut = sanitizeOutputText(spoofAndLong, 1000, []);
	assert.ok(Array.from(spoofLongOut).length <= 1000);
	assert.equal(spoofLongOut.includes("99999"), false);
	assert.match(spoofLongOut, /^Prefix \[truncated-marker\] Q+… \[truncated, \d+ characters? omitted\]$/);
});

test("sanitizeOutputText and sanitizeOperatorText handle 200k hostile inputs in linear time and preserve exact marker arithmetic", () => {
	const blocked = ["/home/alice", "/srv/sess/run-1", "/work/proj"];
	const repeatTo = (s: string, len: number) => s.repeat(Math.ceil(len / s.length)).slice(0, len);
	const hostileInputs: Record<string, string> = {
		puncTailDots: `/a/${".".repeat(200_000)}x`,
		puncTailCommas: `/a/b${",;".repeat(100_000)}z`,
		puncTailBlocked: `/home/alice/${".".repeat(200_000)}x`,
		slashes: repeatTo("/", 200_000),
		commaSlash: repeatTo(",/a", 200_000),
		tildeRun: `,~${"a".repeat(200_000)}`,
		deepPath: `/${"a/".repeat(100_000)}`,
		commaInSeg: `/${"a,b/".repeat(50_000)}`,
		pipeInSeg: `/${"a|b/".repeat(50_000)}`,
	};
	for (const [name, input] of Object.entries(hostileInputs)) {
		const t0 = performance.now();
		const out = sanitizeOutputText(input, 8000, blocked);
		const op = sanitizeOperatorText(input, 1000, blocked);
		const uncapped = sanitizeOutputText(input, 300_000, blocked);
		const elapsed = performance.now() - t0;
		assert.ok(elapsed < 1000, `${name} took too long: ${elapsed.toFixed(1)}ms`);
		assert.ok(Array.from(out).length <= 8000, `${name} output exceeded cap`);
		assert.ok(Array.from(op).length <= 1000, `${name} operator exceeded cap`);
		assert.equal(uncapped.isWellFormed(), true);
	}

	// Marker arithmetic exactness across pre-bound threshold (4 * 8000 = 32000) and surrogate pairs
	for (const len of [7999, 8000, 8001, 8040, 9000, 12345, 32000, 32001, 100000]) {
		const out = sanitizeOutputText("x".repeat(len), 8000, blocked);
		const cp = Array.from(out).length;
		assert.ok(cp <= 8000, `len=${len} exceeded cap: ${cp}`);
		const m = /… \[truncated, (\d+) characters? omitted\]$/.exec(out);
		if (len <= 8000) {
			assert.equal(m, null, `len=${len} should not be truncated`);
			assert.equal(cp, len);
		} else {
			assert.ok(m, `len=${len} missing truncation marker`);
			const kept = cp - Array.from(m[0]).length;
			assert.equal(kept + Number(m[1]), len, `len=${len} marker arithmetic mismatch`);
		}
	}

	const astral = "🚀".repeat(50_000);
	const astralOut = sanitizeOutputText(astral, 8000, []);
	assert.equal(astralOut.isWellFormed(), true, "pre-bound astral truncation must not split surrogate pairs");
	const astralCp = Array.from(astralOut).length;
	assert.ok(astralCp <= 8000);
	const astralMatch = /… \[truncated, (\d+) characters? omitted\]$/.exec(astralOut);
	assert.ok(astralMatch);
	assert.equal(astralCp - Array.from(astralMatch[0]).length + Number(astralMatch[1]), 50_000);

	// When a 4*cap prefix collapses into a short marker, pre-dropped chars still produce a truncation marker
	const giantPath = `/a/${"x".repeat(50_000)}`;
	const giantOut = sanitizeOutputText(giantPath, 1000, []);
	assert.ok(Array.from(giantOut).length <= 1000);
	assert.match(giantOut, /^\[redacted-path\]… \[truncated, \d+ characters? omitted\]$/);

	// N3-b: pre-bound cut inside a ~user or /first-segment prefix trims back to whitespace/delimiter without leaking ~alice or /secretdir
	for (const cap of [50, 200]) {
		const vsPrefix = "w\uFE0F ".repeat(cap); // 3 code points per "w\uFE0F ", shrinks to 2 ("w ")
		const vsLen = Array.from(vsPrefix).length;
		const padNeeded = 4 * cap - 7 - vsLen;
		if (padNeeded >= 0) {
			const input = `${vsPrefix}${"a".repeat(padNeeded)} ~alice/.ssh/id_rsa`;
			const scrubbedCp = Array.from(input.replace(/\uFE0F/g, "").replace("~alice/.ssh/id_rsa", "[redacted-path]")).length;
			const out = sanitizeOutputText(input, cap, []);
			assert.equal(out.includes("~alice"), false, `cap=${cap} leaked ~alice: ${out}`);
			assert.equal(out.includes("~al"), false, `cap=${cap} leaked ~al: ${out}`);
			const m = /… \[truncated, (\d+) characters? omitted\]$/.exec(out);
			assert.ok(m, `cap=${cap} missing marker`);
			const kept = Array.from(out).length - Array.from(m[0]).length;
			assert.equal(kept + Number(m[1]), scrubbedCp, `cap=${cap} N3-b marker arithmetic mismatch`);
		}
		const vsPad = "\uFE0F".repeat(4 * cap - 10);
		const segInput = `${vsPad} /secretdir/inner/file`;
		const segOut = sanitizeOutputText(segInput, cap, []);
		assert.equal(segOut.includes("/secret"), false, `cap=${cap} leaked /secret: ${segOut}`);
		assert.equal(segOut.includes("secretdir"), false, `cap=${cap} leaked secretdir: ${segOut}`);
	}

	// B1: no-space N3-b reproducers for ~alice/..., /secretdir/..., C:\Users\..., file:///... across caps and k
	const leakPatterns = ["~alice", "~al", "/secretdir", "secretdir", "Users", "/etc", "bob", "alice"];
	for (const cap of [50, 200, 1000, 8000]) {
		for (const k of [0, 1, 5, 7, 10, 15, 25]) {
			for (const tail of ["~alice/.ssh/id", "/home/alice/secret", "/secretdir/inner/file", "C:\\Users\\bob\\x", "file:///etc/pw"]) {
				for (const fillerChar of ["\uFE0F", "§"]) {
					const input = `${fillerChar.repeat(Math.max(0, 4 * cap - k))}${tail} end`;
					const strippedCp = Array.from(input.replace(/[\uFE0E\uFE0F]/g, "")).length;
					const out = sanitizeOutputText(input, cap, ["/home/alice"]);
					const op = sanitizeOperatorText(input, cap, ["/home/alice"]);
					assert.ok(Array.from(out).length <= cap, `B1 output exceeded cap=${cap}`);
					assert.ok(Array.from(op).length <= cap, `B1 operator exceeded cap=${cap}`);
					assert.equal(out.isWellFormed(), true);
					assert.equal(op.isWellFormed(), true);
					for (const bad of leakPatterns) {
						assert.equal(out.includes(bad), false, `B1 output leaked ${JSON.stringify(bad)} (cap=${cap}, k=${k}, tail=${tail}, filler=${JSON.stringify(fillerChar)}): ${out}`);
						assert.equal(op.includes(bad), false, `B1 operator leaked ${JSON.stringify(bad)} (cap=${cap}, k=${k}, tail=${tail}, filler=${JSON.stringify(fillerChar)}): ${op}`);
					}
					const m = /… \[truncated, (\d+) characters? omitted\]$/.exec(out);
					if (m) {
						const kept = Array.from(out).length - Array.from(m[0]).length;
						const scrubbedTailInPreBound = fillerChar === "§" && k >= tail.length + 1;
						const expectedCp = scrubbedTailInPreBound
							? Array.from(input.replace(/[\uFE0E\uFE0F]/g, "").replace(tail, "[redacted-path]")).length
							: strippedCp;
						assert.equal(kept + Number(m[1]), expectedCp, `B1 marker arithmetic mismatch (cap=${cap}, k=${k}, tail=${tail})`);
					} else {
						assert.equal(fillerChar, "\uFE0F");
					}
				}
			}
		}
	}
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
				summary: `Summary at ${dir} and ${f.cwd}/src/a.ts and \`/etc/probe_gen/x.conf\` and **/opt/probe_gen/sum**\nwith\u202ectrl\u200b\u3164\uFE0F`,
				detail: `Line 1 in ${f.home}/.pi/file\nLine 2 in ${statePath}\nLine 3 /etc/shadow \u0007alert <script>alert(1)</script>\nChanged \`/opt/probe_gen/secret.key\` and **/var/probe_gen/y**, <p>/srv/probe_gen/z</p>, a,/usr/probe_gen/w\nSpoof … [truncated, 99999 characters omitted]`,
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

	// 8. cmd_node: command result with command_evidence excerpts (now allowed, scrubbed and bounded; command/args/cwd stay private)
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
					stdout_excerpt: `PUBLIC_CMD_STDOUT_EXCERPT\nfrom ${f.cwd}/out.txt\u200b`,
					stderr_excerpt: "PUBLIC_CMD_STDERR_EXCERPT\nwarn /etc/probe_gen/cmd.err",
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
		"/etc/probe_gen/x.conf",
		"/opt/probe_gen/sum",
		"/opt/probe_gen/secret.key",
		"/var/probe_gen/y",
		"/srv/probe_gen/z",
		"/usr/probe_gen/w",
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
			assert.ok(liveDone.current_attempt.summary.includes("`[redacted-path]`"), "closing backtick must survive in live summary");
			assert.ok(liveDone.current_attempt.summary.includes("**[redacted-path]**"), "closing ** must survive in live summary");
			assert.match(liveDone.current_attempt.summary, /\[ctrl\]/);
			assert.equal(liveDone.current_attempt.summary.includes("\n"), false);
			assert.equal(liveDone.current_attempt.summary.includes("\u3164"), false);
			assert.equal(liveDone.current_attempt.summary.includes("\uFE0F"), false);
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
			assert.equal(doneOut.attempts.length, 1);
			assert.equal(doneOut.total_attempts, 1);
			assert.equal(doneOut.omitted_attempts, 0);
			assert.equal(doneOut.attempts[0].evidence, "available");
			assert.equal(doneOut.attempts[0].status, "succeeded");
			assert.match(doneOut.attempts[0].summary, /\n/);
			assert.match(doneOut.attempts[0].summary, /\[redacted-path\]/);
			assert.ok(doneOut.attempts[0].summary.includes("`[redacted-path]`"));
			assert.ok(doneOut.attempts[0].summary.includes("**[redacted-path]**"));
			assert.match(doneOut.attempts[0].summary, /\[ctrl\]/);
			assert.equal(
				doneOut.attempts[0].detail,
				"Line 1 in [redacted-path]\nLine 2 in [redacted-path]\nLine 3 [redacted-path] [ctrl] alert <script>alert(1)</script>\nChanged `[redacted-path]` and **[redacted-path]**, <p>[redacted-path]</p>, a,[redacted-path]\nSpoof [truncated-marker]",
			);

			// /output for long_node: caps 1,000 summary & 8,000 detail with omission markers and valid surrogate pairs
			const longRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=long_node`);
			assert.equal(longRes.status, 200);
			const longOut = await longRes.json() as any;
			assert.equal(longOut.attempts[0].evidence, "available");
			assert.equal(longOut.attempts[0].status, "partial");
			assert.equal(longOut.attempts[0].summary.isWellFormed(), true);
			assert.ok(Array.from(longOut.attempts[0].summary).length <= 1000);
			assert.match(longOut.attempts[0].summary, /\[truncated, \d+ characters? omitted\]$/);
			assert.equal(longOut.attempts[0].detail.isWellFormed(), true);
			assert.ok(Array.from(longOut.attempts[0].detail).length <= 8000);
			assert.match(longOut.attempts[0].detail, /\[truncated, \d+ characters? omitted\]$/);

			// /output for running and pending nodes -> Not applicable
			for (const activeNode of ["run_node", "pend_node"]) {
				const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${activeNode}`);
				assert.equal(res.status, 200);
				const out = await res.json() as any;
				assert.equal(out.attempts[0].evidence, "not applicable", activeNode);
				assert.equal(out.attempts[0].absence, "not applicable", activeNode);
				assert.match(out.attempts[0].explanation, /when the attempt finishes/i, activeNode);
			}

			// /output for corrupt, wrong-identity, oversize, missing result -> Evidence unavailable & zero leaks
			for (const badNode of ["bad_json_node", "wrong_id_node", "oversize_node", "missing_res_node"]) {
				const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${badNode}`);
				assert.equal(res.status, 200);
				const text = await res.text();
				scanSentinels(text, sentinels, `output ${badNode}`);
				const out = JSON.parse(text);
				assert.equal(out.attempts[0].evidence, "unavailable", badNode);
				assert.equal(out.attempts[0].absence, "evidence unavailable", badNode);
			}

			// /output for cmd_node returns scrubbed stdout/stderr excerpts without leaking command/args/cwd/metrics
			const cmdRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_node`);
			assert.equal(cmdRes.status, 200);
			const cmdText = await cmdRes.text();
			scanSentinels(cmdText, [...sentinels, "/etc/probe_gen/cmd.err"], "output cmd_node");
			const cmdOut = JSON.parse(cmdText);
			assert.equal(cmdOut.attempts[0].command.exit_code, 0);
			assert.equal(cmdOut.attempts[0].command.signal, null);
			assert.equal(cmdOut.attempts[0].command.stdout_excerpt, "PUBLIC_CMD_STDOUT_EXCERPT\nfrom [redacted-path] [ctrl]");
			assert.equal(cmdOut.attempts[0].command.stderr_excerpt, "PUBLIC_CMD_STDERR_EXCERPT\nwarn [redacted-path]");
			assert.equal("command" in cmdOut.attempts[0].command, false);
			assert.equal("args" in cmdOut.attempts[0].command, false);
			assert.equal("working_directory" in cmdOut.attempts[0].command, false);
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
		assert.equal(body.attempts[0].evidence, "unavailable");
		assert.equal(body.attempts[0].absence, "evidence unavailable");
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
			assert.equal(out.attempts.length, 2);
			assert.equal(out.attempts[0].attempt_number, 2);
			assert.equal(out.attempts[0].evidence, "not applicable");
			assert.equal(out.attempts[0].absence, "not applicable");
			assert.match(out.attempts[0].explanation, /when the attempt finishes/i);
			assert.equal(out.attempts[1].attempt_number, 1);
			assert.equal(out.attempts[1].evidence, "available");
			assert.equal(out.attempts[1].summary, "Attempt 1 summary");
		},
	);

	// Now attempt 2 finishes -> attempts [2, 1] newest first are returned.
	await build.complete({ status: "success", summary: "Attempt 2 summary", detail: "Attempt 2 line 1\nAttempt 2 line 2" });

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(res.status, 200);
			const out = await res.json() as any;
			assert.equal(out.attempts.length, 2);
			assert.equal(out.attempts[0].attempt_number, 2);
			assert.equal(out.attempts[0].evidence, "available");
			assert.equal(out.attempts[0].status, "succeeded");
			assert.equal(out.attempts[0].summary, "Attempt 2 summary");
			assert.equal(out.attempts[0].detail, "Attempt 2 line 1\nAttempt 2 line 2");
			assert.equal(out.attempts[1].attempt_number, 1);
			assert.equal(out.attempts[1].evidence, "available");
			assert.equal(out.attempts[1].summary, "Attempt 1 summary");
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

test("GET /api/factories/:id/output returns 404 for unknown node on uncertain or topology-mismatch runs when a release exists (N2)", async t => {
	const { readFileSync } = await import("node:fs");
	const { DatabaseSync } = await import("node:sqlite");
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_N2_PROMPT",
		agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_N2_SUB" }],
	};
	const fac = ops({ action: "publish", name: "n2-output-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-n2-out" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "n2-ref", brief: "PRIVATE_N2_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	// 1. Uncertain run where a release still exists (e.g. checkout slot becomes uncertain while release is observed):
	const reader = createViewerReader({ statePath, coordinationPath, env: viewerEnv, home: f.home });
	const { inspection, releases } = reader.inspectLive(fac.factory_id);
	assert.equal(releases.length, 1);
	const uncertainInspection = {
		...inspection,
		capacity: { ...inspection.capacity, checkout_slot: "uncertain" as const },
	};
	const nfOutcome = nodeOutputSnapshot(fac.factory_id, "typo_not_in_run", uncertainInspection, releases);
	assert.equal(nfOutcome.kind, "not_found", "unknown node on uncertain run with release must return not_found (404)");
	const okOutcome = nodeOutputSnapshot(fac.factory_id, "build", uncertainInspection, releases);
	assert.equal(okOutcome.kind, "ok");
	assert.equal(okOutcome.body.evidence, "unavailable");
	assert.equal(okOutcome.body.absence, "evidence unavailable");

	// HTTP uncertain run without a release (missing checkout hold) still documents typed absence for known node:
	const db = new DatabaseSync(coordinationPath);
	try { db.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(fac.factory_id); } finally { db.close(); }

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const knownRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(knownRes.status, 200);
			const knownBody = await knownRes.json() as any;
			assert.equal(knownBody.evidence, "unavailable");
			assert.equal(knownBody.absence, "evidence unavailable");
		},
	);

	// 2. Topology-mismatch run (manifest topology differs from bound definition) while release exists:
	const f2 = serviceFixture(t, ["builder"]);
	const statePath2 = join(f2.root, "factories.sqlite");
	const coordinationPath2 = join(f2.root, "factory-coordination.sqlite");
	const viewerEnv2 = { PATH: join(f2.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f2.stateDir };
	const ops2 = factoryOperations(statePath2, f2.service, { coordinationPath: coordinationPath2 });
	const fac2 = ops2({ action: "publish", name: "n2-topo-fac", draft: { ...draft, project_cwd: f2.cwd }, sessionModel });
	const auth2 = createManagerAuthority({ pi_session_id: "sess-n2-topo" });
	ops2({ action: "resume", factory_id: fac2.factory_id, authority: auth2 });
	ops2({ action: "submit", factory_id: fac2.factory_id, authority: auth2, reference: "n2-topo-ref", brief: "PRIVATE_N2_TOPO_BRIEF" });
	const launched2 = await ops2({ action: "launch", factory_id: fac2.factory_id, authority: auth2 });
	revokeManagerAuthority(auth2);

	const manifestPath2 = join(launched2.manifest.session_dir, "manifest.json");
	const manifestObj = JSON.parse(readFileSync(manifestPath2, "utf8"));
	manifestObj.pane_manifest[0].node_id = "tampered_node";
	atomicJson(manifestPath2, manifestObj);

	await verifyReadOnlyViewer(
		{ stateDirs: f2.root, viewerOptions: { statePath: statePath2, coordinationPath: coordinationPath2, env: viewerEnv2, home: f2.home } },
		async viewer => {
			const nfRes = await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=typo_not_in_run`);
			assert.equal(nfRes.status, 404, "unknown node on topology-mismatch run must return 404");

			const knownRes = await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=build`);
			assert.equal(knownRes.status, 200);
			const knownBody = await knownRes.json() as any;
			assert.equal(knownBody.evidence, "unavailable");
			assert.equal(knownBody.absence, "evidence unavailable");
		},
	);
});

test("GET /api/factories/:id/output keeps Live execution status alongside evidence unavailable for error.json, exited worker, and missing result (N3)", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_N3_PROMPT",
		agents: [
			{ node_id: "err_node", persona: "builder", sub_task: "PRIVATE_N3_ERR" },
			{ node_id: "exited_node", persona: "builder", sub_task: "PRIVATE_N3_EXIT" },
			{ node_id: "claim_only_node", persona: "builder", sub_task: "PRIVATE_N3_CLAIM" },
		],
	};
	const fac = ops({ action: "publish", name: "n3-output-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-n3-out" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "n3-ref", brief: "PRIVATE_N3_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;

	const errEntry = entryOf("err_node");
	atomicJson(join(dir, `${errEntry.instance_id}.error.json`), { error: `PUBLIC_ERR_JSON_MSG in ${f.cwd}/bad\u200b` });

	const exitedEntry = entryOf("exited_node");
	atomicJson(readyPath(dir, exitedEntry.instance_id), {
		version: 2,
		direction_incarnation: "inc-exit",
		task_id: launched.task_id,
		token: launched.manifest.token,
		instance_id: exitedEntry.instance_id,
		pid: 2_147_483_646,
		session_id: "sess-exit",
		name: exitedEntry.instance_id,
		endpoint: "/tmp/PRIVATE_EXIT_EP",
		model: "test-provider/test-model",
	});

	const claimEntry = entryOf("claim_only_node");
	atomicJson(join(dir, `${claimEntry.instance_id}.outcome-claim.json`), {
		version: 1,
		identity: {
			run_id: launched.task_id,
			node_id: "claim_only_node",
			persona_name: claimEntry.persona_name,
			attempt_id: claimEntry.attempt_id!,
			instance_id: claimEntry.instance_id,
		},
		outcome: "completed",
		claimed_at: "2026-01-01T00:00:03.000Z",
	});

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			const live = JSON.parse(liveText) as any;
			const liveById = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));

			for (const nodeId of ["err_node", "exited_node", "claim_only_node"]) {
				const outRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${nodeId}`);
				assert.equal(outRes.status, 200);
				const outText = await outRes.text();
				assert.equal(outText.includes("PRIVATE_"), false, `output for ${nodeId} leaked private sentinel`);
				assert.equal(outText.includes(f.cwd), false, `output for ${nodeId} leaked project_cwd`);
				const out = JSON.parse(outText);
				const liveNode = liveById.get(nodeId);
				assert.ok(liveNode, `missing ${nodeId} in live snapshot`);
				assert.equal(out.attempts[0].evidence, "unavailable", nodeId);
				assert.equal(out.attempts[0].absence, "evidence unavailable", nodeId);
				assert.equal(out.attempts[0].status, liveNode.status, `${nodeId} status must match Live`);
				assert.equal(out.attempts[0].status_text, liveNode.status_text, `${nodeId} status_text must match Live`);
				if (nodeId === "err_node") {
					assert.equal(out.attempts[0].error_message, "PUBLIC_ERR_JSON_MSG in [redacted-path] [ctrl]");
					assert.equal(liveText.includes("PUBLIC_ERR_JSON_MSG"), false, "/live must still not expose raw .error.json message");
				}
			}
		},
	);
});

test("GET /api/factories/:id/output and /live respond quickly on 60k hostile punctuation-tail summary and detail (R2-B1)", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_HOSTILE_PERF_PROMPT",
		agents: [{ node_id: "hostile_perf", persona: "builder", sub_task: "PRIVATE_HOSTILE_PERF_SUB" }],
	};
	const fac = ops({ action: "publish", name: "hostile-perf-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-hostile-perf" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "hostile-perf-ref", brief: "PRIVATE_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entry = launched.manifest.pane_manifest.find(e => e.node_id === "hostile_perf")!;
	const cfg = readJson<WorkerConfig>(join(dir, `${entry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, entry.instance_id),
		completionRecord(
			cfg,
			{
				agent_name: entry.persona_name,
				node_id: "hostile_perf",
				status: "success",
				summary: `/b/secret/${".".repeat(60_000)}y`,
				detail: `/a/secret/${".".repeat(60_000)}x`,
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const tOut = performance.now();
			const outRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=hostile_perf`);
			const outMs = performance.now() - tOut;
			assert.equal(outRes.status, 200);
			const outText = await outRes.text();
			assert.equal(outText.includes("/a/secret"), false);
			assert.equal(outText.includes("/b/secret"), false);
			assert.ok(outMs < 1000, `/output with 60k hostile payload took ${outMs.toFixed(0)}ms`);

			const tLive = performance.now();
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			const liveMs = performance.now() - tLive;
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			assert.equal(liveText.includes("/b/secret"), false);
			assert.ok(liveMs < 1000, `/live with 60k hostile payload took ${liveMs.toFixed(0)}ms`);
		},
	);
});


test("GET /api/factories/:id/output projects verification, warnings, next_steps, command excerpts, structured outputs, artifact descriptions, dispositions, 64KB cap, and N-e alignment without leaking private sentinels", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_T02_PROMPT",
		agents: [
			{ node_id: "rich_node", persona: "builder", sub_task: "PRIVATE_T02_RICH_SUB" },
			{
				node_id: "cmd_fail",
				kind: "command",
				command: process.execPath,
				args: ["-e", "process.exit(2)", "--sentinel-cmd-fail-arg"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_T02_CMD_SUB",
			},
			{ node_id: "blk_node", persona: "builder", sub_task: "PRIVATE_T02_BLK_SUB" },
			{ node_id: "skip_node", persona: "builder", sub_task: "PRIVATE_T02_SKIP_SUB" },
			{ node_id: "cancel_node", persona: "builder", sub_task: "PRIVATE_T02_CAN_SUB" },
			{ node_id: "huge_node", persona: "builder", sub_task: "PRIVATE_T02_HUGE_SUB" },
			{ node_id: "handoff_src", persona: "builder", sub_task: "PRIVATE_T02_HSRC_SUB" },
			{ node_id: "handoff_bad", persona: "builder", sub_task: "PRIVATE_T02_HBAD_SUB", depends_on: ["handoff_src"] },
		],
	};

	const fac = ops({ action: "publish", name: "t02-output-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-t02-out", pi_session_file: join(f.root, "PRIVATE_MGR_SESSION.jsonl") });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t02-ref-1", brief: "PRIVATE_T02_RAW_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;

	// 1. rich_node: >20 verification/warnings/next_steps with >500-char items, >8000-char outputs, artifacts with paths, metrics
	const richEntry = entryOf("rich_node");
	const richCfg = readJson<WorkerConfig>(join(dir, `${richEntry.instance_id}.config.json`));
	const verList = Array.from({ length: 24 }, (_, idx) => ({
		check_id: idx === 0 ? `chk-long-${"V".repeat(520)}` : `chk-${idx}`,
		result: (idx === 0 ? "pass" : idx === 1 ? "fail" : idx === 2 ? "error" : "pass") as "pass" | "fail" | "error",
		attempt_id: richEntry.attempt_id!,
		completed_at: "2026-01-01T00:00:01.000Z",
		scope_kind: "declared" as const,
		applicability: idx === 1 ? ("stale" as const) : ("current" as const),
		...(idx === 0 ? { reason: `Reason in ${f.cwd}/src/a.ts ${"R".repeat(520)}` } : {}),
	}));
	const warnList = Array.from({ length: 23 }, (_, idx) =>
		idx === 0 ? `Warn at ${dir}/x \u202e ${"W".repeat(520)}` : `Warning ${idx}`,
	);
	const nextList = Array.from({ length: 22 }, (_, idx) =>
		idx === 0 ? `Next step /opt/probe_gen/next ${"N".repeat(520)}` : `Next step ${idx}`,
	);
	const bigOutputs = {
		verdict: "ok",
		secretPathInJson: `${f.home}/.ssh/id_rsa`,
		items: Array.from({ length: 250 }, (_, idx) => `item-${idx}-${"O".repeat(35)}`),
	};
	atomicJson(
		resultPath(dir, richEntry.instance_id),
		completionRecord(
			richCfg,
			{
				agent_name: richEntry.persona_name,
				node_id: "rich_node",
				status: "success",
				summary: "Rich summary",
				detail: "Rich detail\nline 2",
				verification: verList,
				warnings: warnList,
				next_steps: nextList,
				outputs: bigOutputs,
				metrics: { PRIVATE_METRIC_KEY: 12345 },
				artifacts: [
					{ type: "file", path: join(f.cwd, "PRIVATE_ARTIFACT_FILE_1.txt"), action: "created", description: `Built bundle at ${f.cwd}/dist/app.js` },
					{ type: "file", path: join(f.cwd, "PRIVATE_ARTIFACT_FILE_2.txt"), action: "modified", description: `Long desc ${"A".repeat(530)}`, missing: true },
				],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	// 2. cmd_fail: failed command node with exit_code 2, signal SIGTERM, >4000 stdout & stderr excerpts
	const cmdFailEntry = entryOf("cmd_fail");
	const cmdFailCfg = readJson<WorkerConfig>(join(dir, `${cmdFailEntry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, cmdFailEntry.instance_id),
		completionRecord(
			cmdFailCfg,
			{
				agent_name: cmdFailEntry.persona_name,
				node_id: "cmd_fail",
				status: "failure",
				summary: "Command failed",
				detail: "Exited with 2",
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "process.exit(2)", "--sentinel-cmd-fail-arg"],
					working_directory: f.cwd,
					exit_code: 2,
					signal: "SIGTERM",
					started_at: "2026-01-01T00:00:00.000Z",
					finished_at: "2026-01-01T00:00:02.000Z",
					duration_ms: 2000,
					stdout_bytes: 5000,
					stderr_bytes: 5000,
					stdout_excerpt: `STDOUT_HEAD ${f.cwd}/a.log\n${"S".repeat(4200)}`,
					stderr_excerpt: `STDERR_HEAD /etc/probe_gen/fail.err\u200b\n${"E".repeat(4200)}`,
				},
			},
			"not_required",
			"2026-01-01T00:00:02.000Z",
		),
	);

	// 3. Dispositions: blocked, skipped, cancelled
	const blkEntry = entryOf("blk_node");
	atomicJson(
		dispositionPath(dir, blkEntry.instance_id),
		dispositionRecord(
			{ ...blkEntry, task_id: launched.task_id },
			"blocked",
			`Blocked due to upstream failure in ${f.cwd}/upstream`,
			[{ node_id: "cmd_fail", state: "failed", reason: `Failed at /opt/probe_gen/cause` }],
			"2026-01-01T00:00:03.000Z",
		),
	);

	const skipEntry = entryOf("skip_node");
	atomicJson(
		dispositionPath(dir, skipEntry.instance_id),
		dispositionRecord(
			{ ...skipEntry, task_id: launched.task_id },
			"skipped",
			`Skipped optional step under ${dir}/skip`,
			[],
			"2026-01-01T00:00:03.000Z",
		),
	);

	const canEntry = entryOf("cancel_node");
	atomicJson(
		dispositionPath(dir, canEntry.instance_id),
		dispositionRecord(
			{ ...canEntry, task_id: launched.task_id },
			"cancelled",
			`Cancelled by operator in ${f.home}/.pi`,
			[],
			"2026-01-01T00:00:03.000Z",
		),
	);

	// 4. huge_node: every field maxed out to exercise the 64 KB response budget
	const hugeEntry = entryOf("huge_node");
	const hugeCfg = readJson<WorkerConfig>(join(dir, `${hugeEntry.instance_id}.config.json`));
	atomicJson(
		resultPath(dir, hugeEntry.instance_id),
		completionRecord(
			hugeCfg,
			{
				agent_name: hugeEntry.persona_name,
				node_id: "huge_node",
				status: "partial",
				summary: "H".repeat(950),
				detail: "€".repeat(7950),
				verification: Array.from({ length: 20 }, (_, idx) => ({
					check_id: `huge-chk-${idx}-${"C".repeat(450)}`,
					result: "pass" as const,
					attempt_id: hugeEntry.attempt_id!,
					completed_at: "2026-01-01T00:00:01.000Z",
					scope_kind: "declared" as const,
					applicability: "current" as const,
					reason: "R".repeat(480),
				})),
				warnings: Array.from({ length: 20 }, (_, idx) => `W${idx}-${"W".repeat(480)}`),
				next_steps: Array.from({ length: 20 }, (_, idx) => `N${idx}-${"N".repeat(480)}`),
				outputs: { blob: "J".repeat(7900) },
				artifacts: Array.from({ length: 20 }, (_, idx) => ({
					type: "file",
					path: join(f.cwd, `PRIVATE_HUGE_${idx}.txt`),
					description: `Art${idx}-${"A".repeat(480)}`,
				})),
			},
			"sent",
			"2026-01-01T00:00:04.000Z",
		),
	);

	// 5. N-e: handoff_bad has damaged handoff offer from handoff_src -> Live shows Uncertain, /output must also show Uncertain
	const hBadEntry = entryOf("handoff_bad");
	const { writeFileSync } = await import("node:fs");
	writeFileSync(handoffOfferPath(dir, hBadEntry.instance_id, entryOf("handoff_src").instance_id), "{corrupt");

	const sentinels = [
		"PRIVATE_",
		f.root,
		f.cwd,
		f.home,
		dir,
		statePath,
		coordinationPath,
		launched.manifest.token,
		"/opt/probe_gen/next",
		"/etc/probe_gen/fail.err",
		"/opt/probe_gen/cause",
	];
	const runtimeCommandSentinels = [...sentinels, process.execPath, "--sentinel-cmd-fail-arg"];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Whole-body sentinel scans on every endpoint
			for (const ep of [
				"/api/factories",
				`/api/factories/${fac.factory_id}/live`,
				`/api/factories/${fac.factory_id}/inspect`,
				`/api/factories/${fac.factory_id}/queue?filter=all`,
				`/api/factories/${fac.factory_id}/receipts?reference=t02-ref-1`,
				`/api/factories/${fac.factory_id}/requests`,
				`/api/factories/${fac.factory_id}/proposals`,
			]) {
				const res = await fetch(`${viewer.url}${ep}`);
				assert.equal(res.status, 200, ep);
				const bodyText = await res.text();
				scanSentinels(bodyText, ep.endsWith("/live") ? runtimeCommandSentinels : sentinels, ep);
			}

			// rich_node: verification/warnings/next_steps capped at 20 items & 500 chars, outputs_text <= 8000, artifacts without paths
			const richRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=rich_node`);
			assert.equal(richRes.status, 200);
			const richText = await richRes.text();
			scanSentinels(richText, runtimeCommandSentinels, "output rich_node");
			const richOut = JSON.parse(richText);
			const richAtt = richOut.attempts[0];
			assert.equal(richAtt.verification.items.length, 20);
			assert.equal(richAtt.verification.total_count, 24);
			assert.equal(richAtt.verification.omitted_count, 4);
			assert.match(richAtt.verification.omitted_marker, /\[truncated, 4 items omitted\]/);
			assert.ok(Array.from(richAtt.verification.items[0].check_id).length <= 500);
			assert.match(richAtt.verification.items[0].check_id, /\[truncated, \d+ characters? omitted\]$/);
			assert.ok(Array.from(richAtt.verification.items[0].reason).length <= 500);
			assert.match(richAtt.verification.items[0].reason, /\[redacted-path\]/);
			assert.match(richAtt.verification.items[0].reason, /\[truncated, \d+ characters? omitted\]$/);

			assert.equal(richAtt.warnings.items.length, 20);
			assert.equal(richAtt.warnings.omitted_count, 3);
			assert.match(richAtt.warnings.omitted_marker, /\[truncated, 3 items omitted\]/);
			assert.ok(Array.from(richAtt.warnings.items[0]).length <= 500);
			assert.match(richAtt.warnings.items[0], /\[redacted-path\]/);
			assert.match(richAtt.warnings.items[0], /\[ctrl\]/);

			assert.equal(richAtt.next_steps.items.length, 20);
			assert.equal(richAtt.next_steps.omitted_count, 2);
			assert.match(richAtt.next_steps.omitted_marker, /\[truncated, 2 items omitted\]/);
			assert.ok(Array.from(richAtt.next_steps.items[0]).length <= 500);
			assert.match(richAtt.next_steps.items[0], /\[redacted-path\]/);

			assert.ok(Array.from(richAtt.outputs_text).length <= 8000);
			assert.match(richAtt.outputs_text, /"verdict": "ok"/);
			assert.match(richAtt.outputs_text, /"secretPathInJson": "\[redacted-path\]"/);
			assert.match(richAtt.outputs_text, /\[truncated, \d+ characters? omitted\]$/);

			assert.equal(richAtt.artifacts.items.length, 2);
			assert.equal("path" in richAtt.artifacts.items[0], false);
			assert.equal(richAtt.artifacts.items[0].description, "Built bundle at [redacted-path]");
			assert.ok(Array.from(richAtt.artifacts.items[1].description).length <= 500);
			assert.equal(richAtt.artifacts.items[1].missing, true);

			// cmd_fail: exit_code, signal, 4000-char capped excerpts
			const cmdRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_fail`);
			assert.equal(cmdRes.status, 200);
			const cmdText = await cmdRes.text();
			scanSentinels(cmdText, runtimeCommandSentinels, "output cmd_fail");
			const cmdOut = JSON.parse(cmdText);
			assert.equal(cmdOut.attempts[0].status, "failed");
			assert.equal(cmdOut.attempts[0].command.exit_code, 2);
			assert.equal(cmdOut.attempts[0].command.signal, "SIGTERM");
			assert.ok(Array.from(cmdOut.attempts[0].command.stdout_excerpt).length <= 4000);
			assert.match(cmdOut.attempts[0].command.stdout_excerpt, /^STDOUT_HEAD \[redacted-path\]\n/);
			assert.match(cmdOut.attempts[0].command.stdout_excerpt, /\[truncated, \d+ characters? omitted\]$/);
			assert.ok(Array.from(cmdOut.attempts[0].command.stderr_excerpt).length <= 4000);
			assert.match(cmdOut.attempts[0].command.stderr_excerpt, /^STDERR_HEAD \[redacted-path\] \[ctrl\]\n/);
			assert.match(cmdOut.attempts[0].command.stderr_excerpt, /\[truncated, \d+ characters? omitted\]$/);

			// Dispositions: blocked, skipped, cancelled
			const blkRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=blk_node`);
			assert.equal(blkRes.status, 200);
			const blkText = await blkRes.text();
			scanSentinels(blkText, sentinels, "output blk_node");
			const blkOut = JSON.parse(blkText);
			assert.equal(blkOut.attempts[0].evidence, "not applicable");
			assert.equal(blkOut.attempts[0].status, "blocked");
			assert.equal(blkOut.attempts[0].disposition_reason, "Blocked due to upstream failure in [redacted-path]");
			assert.equal(blkOut.attempts[0].causes.items[0].reason, "Failed at [redacted-path]");

			const skipOut = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=skip_node`)).json() as any;
			assert.equal(skipOut.attempts[0].status, "skipped");
			assert.equal(skipOut.attempts[0].disposition_reason, "Skipped optional step under [redacted-path]");

			const canOut = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cancel_node`)).json() as any;
			assert.equal(canOut.attempts[0].status, "cancelled");
			assert.equal(canOut.attempts[0].disposition_reason, "Cancelled by operator in [redacted-path]");

			// huge_node: 64 KB response budget
			const hugeRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=huge_node`);
			assert.equal(hugeRes.status, 200);
			const hugeText = await hugeRes.text();
			scanSentinels(hugeText, sentinels, "output huge_node");
			assert.ok(Buffer.byteLength(hugeText, "utf8") <= 64 * 1024, `expected <= 65536 bytes, got ${Buffer.byteLength(hugeText, "utf8")}`);
			const hugeOut = JSON.parse(hugeText);
			assert.ok(hugeOut.attempts[0].outputs_text.includes("truncated") || hugeOut.attempts[0].artifacts.omitted_count > 0);

			// N-e: handoff_bad matches Live Graph status ("needs_attention" / "Uncertain")
			const liveData = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
			const liveHBad = liveData.graph.nodes.find((n: any) => n.id === "handoff_bad");
			const outHBad = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=handoff_bad`)).json() as any;
			assert.equal(liveHBad.status, "needs_attention");
			assert.equal(outHBad.attempts[0].status, "needs_attention");
			assert.equal(outHBad.attempts[0].status_text, "Uncertain");
			assert.equal(outHBad.attempts[0].evidence, "unavailable");
		},
	);
});

test("GET /api/factories/:id/output matches Live Graph upstream review-closure Blocked override (N-e)", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_CLOSURE_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_CLOSURE_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_CLOSURE_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1, on_exhausted: "failed" },
			},
			{ node_id: "deploy", persona: "builder", depends_on: ["review"], sub_task: "PRIVATE_CLOSURE_DEP" },
		],
	};
	const fac = ops({ action: "publish", name: "ne-closure-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-ne-close" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ne-close-ref", brief: "PRIVATE_CLOSURE_BRIEF" });
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

	await build.complete({ status: "success", summary: "Build 1", detail: "Detail 1" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise 1", detail: "Needs fix", outputs: { verdict: "revise" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "Build 2", detail: "Detail 2" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Still bad", detail: "Exhausted", outputs: { verdict: "revise" } });

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
			const liveDeploy = live.graph.nodes.find((n: any) => n.id === "deploy");
			assert.equal(liveDeploy.status, "blocked");

			const outRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=deploy`);
			assert.equal(outRes.status, 200);
			const outText = await outRes.text();
			assert.equal(outText.includes("PRIVATE_"), false);
			const out = JSON.parse(outText);
			assert.equal(out.attempts[0].status, "blocked");
			assert.equal(out.attempts[0].status_text, "Blocked");
			assert.equal(out.attempts[0].evidence, "not applicable");
			assert.equal(out.attempts[0].absence, "not applicable");
			assert.ok(typeof out.attempts[0].disposition_reason === "string" && out.attempts[0].disposition_reason.length > 0);
		},
	);
});

test("GET /api/factories/:id/output and /live validate/scrub hostile timestamps, causes, signals, relative artifact paths, deep outputs, item caps, corrupt loop identity, and upstream size limits (B2, B3, N1, N2, N3, N5)", async t => {
	const { writeFileSync } = await import("node:fs");
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_R1_PROMPT",
		agents: [
			{ node_id: "art_node", persona: "builder", sub_task: "PRIVATE_R1_ART" },
			{ node_id: "deep_node", persona: "builder", sub_task: "PRIVATE_R1_DEEP" },
			{ node_id: "disp_hostile", persona: "builder", sub_task: "PRIVATE_R1_DISP" },
			{ node_id: "big_ts_node", persona: "builder", sub_task: "PRIVATE_R1_BIGTS" },
			{
				node_id: "cmd_hostile",
				kind: "command",
				command: process.execPath,
				args: ["-e", "process.exit(2)"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_R1_CMD",
			},
			{ node_id: "item_cap_node", persona: "builder", sub_task: "PRIVATE_R1_ITEMS" },
		],
	};

	const fac = ops({ action: "publish", name: "r1-hardening-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-r1-hard" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "r1-ref", brief: "PRIVATE_R1_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const cfgOf = (e: ReturnType<typeof entryOf>) => readJson<WorkerConfig>(join(dir, `${e.instance_id}.config.json`));

	// B2 + B3: art_node with relative artifact path in description/summary/detail/outputs, hostile completed_at, hostile verification fields
	const artEntry = entryOf("art_node");
	atomicJson(
		resultPath(dir, artEntry.instance_id),
		completionRecord(
			cfgOf(artEntry),
			{
				agent_name: artEntry.persona_name,
				node_id: "art_node",
				status: "success",
				summary: "Updated src/PRIVREL_ART.ts and ./src/PRIVREL_ART.ts",
				detail: "Changed src\\PRIVREL_ART.ts in detail",
				artifacts: [
					{
						type: "file",
						path: "src/PRIVREL_ART.ts",
						action: "modified",
						description: `Wrote src/PRIVREL_ART.ts, ./src/PRIVREL_ART.ts, src\\PRIVREL_ART.ts, and ${join(f.cwd, "src/PRIVREL_ART.ts")}`,
					},
				],
				outputs: {
					artifact_ref: "src/PRIVREL_ART.ts",
					public_rel: "src/PUBLIC_REL_OUT.ts",
				},
				verification: [
					{
						check_id: "v-hostile",
						result: "pass",
						applicability: { p: "/home/alice/PRIV_APP" } as any,
						scope_kind: "/home/alice/PRIV_SCOPE" as any,
						completed_at: "/home/alice/PRIV_VCOMP",
					},
				],
			},
			"sent",
			"/home/alice/PRIV_COMPLETED_AT",
		),
	);

	// N1: deep_node with 6,500-level nested outputs (under 1 MiB) must still render 200 with summary, detail, verification
	const deepEntry = entryOf("deep_node");
	const deepRec = JSON.stringify(
		completionRecord(
			cfgOf(deepEntry),
			{
				agent_name: deepEntry.persona_name,
				node_id: "deep_node",
				status: "success",
				summary: "Deep summary ok",
				detail: "Deep detail ok",
				verification: [{ check_id: "deep-chk", result: "pass", applicability: "current", scope_kind: "declared" }],
				outputs: { nested: "@@DEEP@@" },
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);
	writeFileSync(resultPath(dir, deepEntry.instance_id), deepRec.replace('"@@DEEP@@"', `${"[".repeat(6500)}1${"]".repeat(6500)}`));

	// B2: disp_hostile with hostile state, check.evidence, node_id, and recorded_at
	const dispEntry = entryOf("disp_hostile");
	atomicJson(
		dispositionPath(dir, dispEntry.instance_id),
		dispositionRecord(
			{ ...dispEntry, task_id: launched.task_id },
			"blocked",
			"Blocked reason",
			[
				{
					node_id: "/home/alice/PRIV_CAUSE_NODE",
					state: "/home/alice/PRIV_STATE" as any,
					reason: "Cause reason",
					check: { name: "chk", evidence: { p: "/home/alice/PRIV_EVID" } as any },
				},
			],
			"/home/alice/PRIV_RECORDED_AT",
		),
	);

	// B2: big_ts_node with 200,000-char completed_at must not exceed 64 KB response budget
	const bigTsEntry = entryOf("big_ts_node");
	atomicJson(
		resultPath(dir, bigTsEntry.instance_id),
		completionRecord(
			cfgOf(bigTsEntry),
			{ agent_name: bigTsEntry.persona_name, node_id: "big_ts_node", status: "success", summary: "ok", detail: "ok" },
			"sent",
			"Z".repeat(200_000),
		),
	);

	// B2: cmd_hostile with hostile command_evidence.signal
	const cmdHostileEntry = entryOf("cmd_hostile");
	atomicJson(
		resultPath(dir, cmdHostileEntry.instance_id),
		completionRecord(
			cfgOf(cmdHostileEntry),
			{
				agent_name: cmdHostileEntry.persona_name,
				node_id: "cmd_hostile",
				status: "failure",
				summary: "Cmd hostile",
				detail: "Cmd failed",
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "process.exit(2)"],
					working_directory: f.cwd,
					exit_code: null,
					signal: "/home/alice/PRIV_SIG" as any,
					started_at: "2026-01-01T00:00:00.000Z",
					finished_at: "2026-01-01T00:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 0,
					stderr_bytes: 0,
				},
			},
			"not_required",
			"2026-01-01T00:00:01.000Z",
		),
	);

	// N2: item_cap_node with verification item and artifact item whose combined fields exceed 500 chars
	const itemCapEntry = entryOf("item_cap_node");
	atomicJson(
		resultPath(dir, itemCapEntry.instance_id),
		completionRecord(
			cfgOf(itemCapEntry),
			{
				agent_name: itemCapEntry.persona_name,
				node_id: "item_cap_node",
				status: "success",
				summary: "Item cap",
				detail: "Item cap detail",
				verification: [
					{
						check_id: `chk-${"C".repeat(450)}`,
						result: "pass",
						applicability: "current",
						scope_kind: "declared",
						completed_at: "2026-01-01T00:00:01.000Z",
						reason: `rsn-${"R".repeat(450)}`,
					},
				],
				artifacts: [
					{
						type: `type-${"T".repeat(120)}`,
						path: "src/ok.ts",
						action: `act-${"A".repeat(120)}`,
						description: `desc-${"D".repeat(450)}`,
					},
				],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	const sentinels = [
		"PRIVREL_ART",
		"PRIV_APP",
		"PRIV_SCOPE",
		"PRIV_VCOMP",
		"PRIV_COMPLETED_AT",
		"PRIV_CAUSE_NODE",
		"PRIV_STATE",
		"PRIV_EVID",
		"PRIV_RECORDED_AT",
		"PRIV_SIG",
		"/home/alice",
	];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			scanSentinels(liveText, sentinels, "r1 live");

			// art_node: relative artifact path redacted everywhere; public relative output path preserved
			const artRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=art_node`);
			assert.equal(artRes.status, 200);
			const artText = await artRes.text();
			scanSentinels(artText, sentinels, "r1 art_node");
			const artOut = JSON.parse(artText);
			assert.equal("completed_at" in artOut.attempts[0], false, "invalid completed_at must be omitted");
			assert.match(artOut.attempts[0].summary, /\[redacted-path\]/);
			assert.match(artOut.attempts[0].detail, /\[redacted-path\]/);
			assert.match(artOut.attempts[0].artifacts.items[0].description, /\[redacted-path\]/);
			assert.match(artOut.attempts[0].outputs_text, /"public_rel": "src\/PUBLIC_REL_OUT\.ts"/);

			// deep_node: 200 OK with summary, detail, verification, outputs_text
			const deepRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=deep_node`);
			assert.equal(deepRes.status, 200);
			const deepOut = await deepRes.json() as any;
			assert.equal(deepOut.attempts[0].evidence, "available");
			assert.equal(deepOut.attempts[0].summary, "Deep summary ok");
			assert.equal(deepOut.attempts[0].detail, "Deep detail ok");
			assert.equal(deepOut.attempts[0].verification.items.length, 1);
			assert.equal(typeof deepOut.attempts[0].outputs_text, "string");

			// disp_hostile: causes validated/scrubbed, invalid recorded_at omitted
			const dispRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=disp_hostile`);
			assert.equal(dispRes.status, 200);
			const dispText = await dispRes.text();
			scanSentinels(dispText, sentinels, "r1 disp_hostile");
			const dispOut = JSON.parse(dispText);
			assert.equal("recorded_at" in dispOut.attempts[0], false, "invalid recorded_at must be omitted");
			assert.equal(dispOut.attempts[0].causes.items[0].state, "needs_attention");
			assert.equal(dispOut.attempts[0].causes.items[0].check.evidence, "unverified");

			// big_ts_node: <= 64 KB
			const bigRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=big_ts_node`);
			assert.equal(bigRes.status, 200);
			const bigText = await bigRes.text();
			assert.ok(Buffer.byteLength(bigText, "utf8") <= 64 * 1024, `big_ts_node exceeded 64KB: ${Buffer.byteLength(bigText, "utf8")}`);

			// cmd_hostile: hostile signal scrubbed
			const cmdRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_hostile`);
			assert.equal(cmdRes.status, 200);
			const cmdText = await cmdRes.text();
			scanSentinels(cmdText, sentinels, "r1 cmd_hostile");

			// N2: total code points of verification item and artifact item <= 500
			const itemRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=item_cap_node`);
			assert.equal(itemRes.status, 200);
			const itemOut = await itemRes.json() as any;
			const vItem = itemOut.attempts[0].verification.items[0];
			const vTotalCp = Array.from(
				`${vItem.check_id}${vItem.result}${vItem.applicability}${vItem.scope_kind}${vItem.completed_at ?? ""}${vItem.reason ?? ""}`,
			).length;
			assert.ok(vTotalCp <= 500, `verification item total code points ${vTotalCp} exceeded 500`);
			const aItem = itemOut.attempts[0].artifacts.items[0];
			const aTotalCp = Array.from(`${aItem.type}${aItem.action ?? ""}${aItem.description ?? ""}`).length;
			assert.ok(aTotalCp <= 500, `artifact item total code points ${aTotalCp} exceeded 500`);
		},
	);

	// N3 + N5: review loop with corrupt attempt-2 result (N3 identity masked) and >1 MiB upstream record (N5 matches /live)
	const fLoop = serviceFixture(t, ["builder", "reviewer"]);
	const statePath2 = join(fLoop.root, "factories.sqlite");
	const coordinationPath2 = join(fLoop.root, "factory-coordination.sqlite");
	const viewerEnv2 = { PATH: join(fLoop.root, "bin"), PI_BOOTSTRAP_STATE_DIR: fLoop.stateDir };
	const ops2 = factoryOperations(statePath2, fLoop.service, { coordinationPath: coordinationPath2 });
	const loopDraft: GenerateRequest = {
		project_cwd: fLoop.cwd,
		topology: "graph",
		task: "PRIVATE_LOOP_R1",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1, on_exhausted: "failed" },
			},
			{ node_id: "deploy", persona: "builder", depends_on: ["review"], sub_task: "PRIVATE_DEP" },
		],
	};
	const fac2 = ops2({ action: "publish", name: "r1-loop-fac", draft: loopDraft, sessionModel });
	const auth2 = createManagerAuthority({ pi_session_id: "sess-r1-loop" });
	ops2({ action: "resume", factory_id: fac2.factory_id, authority: auth2 });
	ops2({ action: "submit", factory_id: fac2.factory_id, authority: auth2, reference: "r1-loop-ref", brief: "PRIVATE_BRIEF" });
	const launched2 = await ops2({ action: "launch", factory_id: fac2.factory_id, authority: auth2 });
	revokeManagerAuthority(auth2);

	const dir2 = launched2.manifest.session_dir;
	const be = launched2.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const re = launched2.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const wm = { provider: "test-provider", id: "test-model" };
	const buildW = workerFromConfig(t, join(dir2, `${be.instance_id}.config.json`), { model: wm });
	const reviewW = workerFromConfig(t, join(dir2, `${re.instance_id}.config.json`), { model: wm });
	await buildW.start();
	await reviewW.start();
	await buildW.beforeStart();
	await reviewW.beforeStart();
	await buildW.complete({ status: "success", summary: "B1", detail: "D1" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "R1", detail: "Revise", outputs: { verdict: "revise" } });
	await buildW.beforeStart(notification(reviewW, buildW));
	await buildW.deliverFollowUps();
	await buildW.complete({ status: "success", summary: "B2", detail: "D2" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "R2", detail: "Exhausted", outputs: { verdict: "revise" } });

	// N5: Make review's progress.json > 1 MiB (valid JSON padded with spaces) and verify /live and /output?node=deploy agree on Blocked
	const revProgPath = join(dir2, `${re.instance_id}.progress.json`);
	const revProgText = JSON.stringify({
		attempt_id: `${re.instance_id}.2`,
		token: launched2.manifest.token,
		updated_at: Date.now(),
		started_at: Date.now() - 1000,
		state: "completed",
	});
	writeFileSync(revProgPath, `${revProgText}${" ".repeat(1_200_000)}`);

	// N3 (ticket 02) + B1 (ticket 03): Corrupt build attempt 2 result keeps verified positional attempt_number=2 on /output while /live masks to 1
	writeFileSync(resultPath(dir2, `${be.instance_id}.2`), "{corrupt");

	await verifyReadOnlyViewer(
		{ stateDirs: fLoop.root, viewerOptions: { statePath: statePath2, coordinationPath: coordinationPath2, env: viewerEnv2, home: fLoop.home } },
		async viewer => {
			const live = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/live`)).json() as any;
			const liveBuild = live.graph.nodes.find((n: any) => n.id === "build");
			const liveDeploy = live.graph.nodes.find((n: any) => n.id === "deploy");

			const outBuild = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=build`)).json() as any;
			assert.equal(outBuild.attempts.length, 2);
			assert.equal(outBuild.attempts[0].evidence, "unavailable");
			assert.equal(liveBuild.current_attempt.attempt_number, 1);
			assert.equal(outBuild.attempts[0].attempt_number, 2);
			assert.equal(typeof outBuild.attempts[0].attempt_id, "object");
			assert.equal(outBuild.attempts[0].attempt_id.absence, "evidence unavailable");
			assert.equal(outBuild.attempts[1].evidence, "available");
			assert.equal(outBuild.attempts[1].attempt_number, 1);
			assert.equal(outBuild.attempts[1].summary, "B1");

			const outDeploy = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=deploy`)).json() as any;
			assert.equal(liveDeploy.status, "blocked");
			assert.equal(outDeploy.attempts[0].status, liveDeploy.status);
			assert.equal(outDeploy.attempts[0].status_text, liveDeploy.status_text);
		},
	);

	// B2 hard budget fallback: when trims cannot bring the response under maxBytes, latest_attempt collapses to an evidence-unavailable stub
	const overBudget = enforceOutputResponseBudget(
		{
			factory_id: fac.factory_id,
			node_id: "art_node",
			evidence: "available",
			latest_attempt: {
				attempt_id: "a1-art_node.1",
				attempt_number: 1,
				max_attempts: 1,
				status: "succeeded",
				status_text: "Succeeded",
				evidence: "available",
				summary: "S".repeat(500),
				detail: "D".repeat(500),
				disposition_reason: "R".repeat(500),
				error_message: "M".repeat(500),
				command: {
					exit_code: 0,
					signal: null,
					duration_ms: 1000,
					stdout_bytes: 500,
					stderr_bytes: 500,
					stdout_excerpt: "O".repeat(500),
					stderr_excerpt: "E".repeat(500),
					spawn_error: "X".repeat(500),
					termination_error: "Y".repeat(500),
				},
			},
		},
		380,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(overBudget), "utf8") <= 380);
	assert.equal(overBudget.evidence, "unavailable");
	assert.equal((overBudget.latest_attempt as any).absence, "evidence unavailable");
});

test("Round 2 unit hardening: whole-token artifact redaction after path scrub (B1), O(N) perf (B2), prose trim (N1), single-word exclusion (N2), normalized forms (N3)", () => {
	const cwd = "/home/alice/proj";
	const blocked = ["/home/alice", cwd];

	// B1: artifact path must never break absolute/tilde/win/file path scrubbing
	const srcTokens = collectArtifactPathTokens([{ path: "src" }], cwd);
	const docsTokens = collectArtifactPathTokens([{ path: "docs/a.md" }], cwd);
	for (const [tokens, text] of [
		[srcTokens, "see /opt/src/X now"],
		[srcTokens, "at ~bob/src/X done"],
		[srcTokens, "at C:\\w\\src\\X done"],
		[srcTokens, "at file:///o/src/X done"],
		[docsTokens, "and /srv/x/docs/a.md/X ok"],
		[docsTokens, "at ~bob/docs/a.md/X done"],
		[docsTokens, "at C:\\w\\docs\\a.md\\X done"],
		[docsTokens, "at file:///o/docs/a.md/X done"],
	] as const) {
		const out = sanitizeOutputText(text, 1000, blocked, tokens);
		const op = sanitizeOperatorText(text, 1000, blocked, tokens);
		assert.equal(out.includes("X"), false, `output leaked X for ${JSON.stringify(text)}: ${out}`);
		assert.equal(op.includes("X"), false, `operator leaked X for ${JSON.stringify(text)}: ${op}`);
		assert.equal(out.includes("~bob"), false, `output leaked ~bob for ${JSON.stringify(text)}: ${out}`);
		assert.equal(op.includes("~bob"), false, `operator leaked ~bob for ${JSON.stringify(text)}: ${op}`);
		assert.equal(out.includes("[redacted-path][redacted-path]"), false, `doubled marker in ${out}`);
	}

	// B1 whole-token boundaries: must not partially match inside larger path/word tokens
	assert.equal(
		sanitizeOutputText("foo/docs/a.md/bar x-docs/a.md docs/a.md_2 docs/a.md.bak foo:docs/a.md", 1000, blocked, docsTokens),
		"foo/docs/a.md/bar x-docs/a.md docs/a.md_2 docs/a.md.bak foo:docs/a.md",
	);
	assert.equal(
		sanitizeOutputText("see docs/a.md, (docs/a.md), \"docs\\\\a.md\", docs/a.md. and docs/a.md:", 1000, blocked, docsTokens),
		"see [redacted-path], ([redacted-path]), \"[redacted-path]\", [redacted-path]. and [redacted-path]:",
	);

	// N1: prose containing ' /' or '(/' before cap must not drop legitimate prose
	const apiProse = `Use the API (/ v2) for this. ${"Then more words here. ".repeat(400)}`;
	const apiOut = sanitizeOutputText(apiProse, 100, []);
	assert.ok(apiOut.startsWith("Use the API (/ v2) for this. "), `unexpected API prose trim: ${apiOut}`);
	assert.equal(sanitizeOperatorText(apiProse, 50, []).startsWith("Use the API (/ v2) for this."), true);

	const slashProse = `a /b ${"lorem ipsum ".repeat(200)}`;
	const slashOut = sanitizeOutputText(slashProse, 128, []);
	assert.ok(slashOut.startsWith("a /b lorem ipsum "), `unexpected slash prose trim: ${slashOut}`);
	assert.ok(sanitizeOperatorText(slashProse, 128, []).startsWith("a /b lorem ipsum "));

	// N2: bare single-word artifacts must not redact prose or scrubber markers
	const wordTokens = collectArtifactPathTokens(
		[{ path: "src" }, { path: "it" }, { path: "path" }, { path: "ctrl" }, { path: "truncated" }, { path: "a" }],
		cwd,
	);
	assert.equal(sanitizeOutputText("the src folder and it is what it is", 1000, blocked, wordTokens), "the src folder and it is what it is");
	assert.equal(sanitizeOperatorText("the src folder and it is what it is", 1000, blocked, wordTokens), "the src folder and it is what it is");
	assert.equal(
		sanitizeOutputText("x\u0001y path [truncated, 5 characters omitted]", 1000, blocked, wordTokens),
		"x [ctrl] y path [truncated-marker]",
	);
	const dotExtTokens = collectArtifactPathTokens([{ path: "secret-file.ts" }], cwd);
	assert.equal(sanitizeOutputText("touched secret-file.ts ok", 1000, blocked, dotExtTokens), "touched [redacted-path] ok");

	// N3: trailing separator, ../ stripped form, and case-insensitive drive/backslash forms
	const trailSingle = collectArtifactPathTokens([{ path: "src/" }], cwd);
	assert.equal(sanitizeOutputText("src/PRIVTR.ts is new", 1000, blocked, trailSingle), "src/PRIVTR.ts is new");
	const trailSub = collectArtifactPathTokens([{ path: "src/sub/" }], cwd);
	assert.equal(sanitizeOutputText("see src/sub and src/sub/ and src/sub/other.ts", 1000, blocked, trailSub), "see [redacted-path] and [redacted-path] and src/sub/other.ts");

	const dotDotTokens = collectArtifactPathTokens([{ path: "../PRIVUP/x.ts" }], cwd);
	assert.equal(sanitizeOutputText("see ../PRIVUP/x.ts and PRIVUP/x.ts", 1000, blocked, dotDotTokens), "see [redacted-path] and [redacted-path]");

	const caseTokens = collectArtifactPathTokens([{ path: "src/PRIVCASE.ts" }], cwd);
	assert.equal(
		sanitizeOutputText("SRC\\privcase.ts .\\Src\\PRIVCASE.TS SRC/privcase.ts", 1000, blocked, caseTokens),
		"[redacted-path] [redacted-path] SRC/privcase.ts",
	);
	const winCaseTokens = collectArtifactPathTokens([{ path: "C:\\Work\\PRIV.ts" }], cwd);
	assert.equal(
		sanitizeOutputText("see \"src\\\\PRIVREL.ts\" and c:\\work\\priv.ts", 1000, blocked, collectArtifactPathTokens([{ path: "src/PRIVREL.ts" }], cwd).concat(winCaseTokens)),
		"see \"[redacted-path]\" and [redacted-path]",
	);

	// B2: only the first 20 projected artifacts are collected into free-text tokens
	const beyond20Arts = Array.from({ length: 25 }, (_, i) => ({ path: `src/item_${i}.ts` }));
	const beyond20Tokens = collectArtifactPathTokens(beyond20Arts, cwd);
	assert.equal(sanitizeOutputText("keep src/item_0.ts vs src/item_20.ts", 1000, blocked, beyond20Tokens), "keep [redacted-path] vs src/item_20.ts");

	// B2: 25,000 prefix-sharing artifacts + repeated prefix text must run in well under 500ms
	const pre = `s/${"a".repeat(8)}`;
	const manyArts = Array.from({ length: 25_000 }, (_, i) => ({ type: "file", path: `${pre}${i}` }));
	const manyText = `${pre}x `.repeat(4000);
	const t0 = performance.now();
	const manyToks = collectArtifactPathTokens(manyArts, cwd);
	assert.ok(manyToks.length <= 512, `expected bounded token count, got ${manyToks.length}`);
	sanitizeOperatorText(manyText, 1000, blocked, manyToks);
	sanitizeOutputText(manyText, 8000, blocked, manyToks);
	for (let i = 0; i < 60; i++) sanitizeOutputText(manyText, 500, blocked, manyToks);
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 500, `25k-artifact unit scrub took too long: ${elapsed.toFixed(0)}ms`);
});

test("GET /api/factories/:id/output and /live fix B1 mid-segment leaks, B2 19k-artifact latency, and B3 true omitted counts", async t => {
	const { writeFileSync } = await import("node:fs");
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_R2_PROMPT",
		agents: [
			{ node_id: "mid", persona: "builder", sub_task: "PRIVATE_R2_MID" },
			{ node_id: "many", persona: "builder", sub_task: "PRIVATE_R2_MANY" },
			{ node_id: "bigstr", persona: "builder", sub_task: "PRIVATE_R2_BIGSTR" },
			{ node_id: "wide", persona: "builder", sub_task: "PRIVATE_R2_WIDE" },
			{ node_id: "astral", persona: "builder", sub_task: "PRIVATE_R2_ASTRAL" },
			{ node_id: "d63", persona: "builder", sub_task: "PRIVATE_R2_D63" },
			{ node_id: "d64", persona: "builder", sub_task: "PRIVATE_R2_D64" },
		],
	};
	const fac = ops({ action: "publish", name: "r2-fixes-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-r2-fixes" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "r2-ref", brief: "PRIVATE_R2_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const cfgOf = (e: ReturnType<typeof entryOf>) => readJson<WorkerConfig>(join(dir, `${e.instance_id}.config.json`));

	// B1: mid node with artifact "src" and "docs/a.md" inside absolute/tilde/win/file paths
	const midEntry = entryOf("mid");
	atomicJson(
		resultPath(dir, midEntry.instance_id),
		completionRecord(
			cfgOf(midEntry),
			{
				agent_name: midEntry.persona_name,
				node_id: "mid",
				status: "success",
				summary: "Read /opt/build/src/PRIV_MID_SUM and ~bob/src/PRIV_TILDE and C:\\w\\src\\PRIV_WIN and file:///o/src/PRIV_FILE",
				detail: "see /var/data/src/PRIV_MID_DET and /srv/x/docs/a.md/PRIV_DOC_DET",
				artifacts: [
					{ type: "dir", path: "src", description: "touched /etc/src/PRIV_MID_DESC and ~bob/src/PRIV_DESC_TILDE" },
					{ type: "file", path: "docs/a.md", description: "see C:\\w\\docs\\a.md\\PRIV_DOC_DESC" },
				],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	// B2: 19,000 artifacts sharing prefix s/aaaaaaaa
	const pre = "s/aaaaaaaa";
	const txt = `${pre}x `.repeat(170);
	const manyEntry = entryOf("many");
	writeFileSync(
		resultPath(dir, manyEntry.instance_id),
		JSON.stringify(
			completionRecord(
				cfgOf(manyEntry),
				{
					agent_name: manyEntry.persona_name,
					node_id: "many",
					status: "success",
					summary: txt,
					detail: txt.repeat(14),
					warnings: Array.from({ length: 20 }, () => txt),
					next_steps: Array.from({ length: 20 }, () => txt),
					artifacts: Array.from({ length: 19_000 }, (_, i) => ({ type: "file", path: `${pre}${i}` })),
				},
				"sent",
				"2026-01-01T00:00:01.000Z",
			),
		),
	);

	// B3: 100k string, 100k-element array, depth 63 vs 64
	const nest = (d: number): any => {
		let v: any = { leaf: 1 };
		for (let i = 0; i < d; i++) v = { k: v };
		return v;
	};
	const bigStrVal = { s: "x".repeat(100_000) };
	const wideVal = Array.from({ length: 100_000 }, (_, i) => i);
	const astralVal = { s: "🚀".repeat(30_000) };
	const d63Val = nest(63);
	const d64Val = nest(64);
	for (const [nodeId, outputs] of [
		["bigstr", bigStrVal],
		["wide", wideVal],
		["astral", astralVal],
		["d63", d63Val],
		["d64", d64Val],
	] as const) {
		const ent = entryOf(nodeId);
		writeFileSync(
			resultPath(dir, ent.instance_id),
			JSON.stringify(
				completionRecord(
					cfgOf(ent),
					{ agent_name: ent.persona_name, node_id: nodeId, status: "success", summary: `S-${nodeId}`, detail: "D", outputs },
					"sent",
					"2026-01-01T00:00:01.000Z",
				),
			),
		);
	}

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// B1 + B2 on /live
			const tLive0 = performance.now();
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			const liveMs = performance.now() - tLive0;
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			assert.equal(liveText.includes("PRIV_"), false, `live leaked PRIV_: ${liveText}`);
			assert.equal(liveText.includes("~bob"), false, `live leaked ~bob: ${liveText}`);
			assert.ok(liveMs < 1000, `/live with 19k artifacts took ${liveMs.toFixed(0)}ms`);

			// B1 on /output?node=mid
			const midRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=mid`);
			assert.equal(midRes.status, 200);
			const midText = await midRes.text();
			assert.equal(midText.includes("PRIV_"), false, `output mid leaked PRIV_: ${midText}`);
			assert.equal(midText.includes("~bob"), false, `output mid leaked ~bob: ${midText}`);
			assert.equal("path" in JSON.parse(midText).attempts[0].artifacts.items[0], false);

			// B2 on /output?node=many
			const tMany0 = performance.now();
			const manyRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=many`);
			const manyMs = performance.now() - tMany0;
			assert.equal(manyRes.status, 200);
			assert.ok(manyMs < 1000, `/output with 19k artifacts took ${manyMs.toFixed(0)}ms`);

			// B3 on bigstr, wide, astral, d63, d64
			for (const [nodeId, rawVal] of [
				["bigstr", bigStrVal],
				["wide", wideVal],
				["astral", astralVal],
				["d63", d63Val],
			] as const) {
				const out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=${nodeId}`)).json() as any;
				const txtOut: string = out.attempts[0].outputs_text;
				const fullLen = Array.from(JSON.stringify(rawVal, null, 2)).length;
				const m = /… \[truncated, (\d+) characters? omitted\]$/.exec(txtOut);
				assert.ok(m, `${nodeId} missing truncation marker`);
				const kept = Array.from(txtOut).length - Array.from(m[0]).length;
				assert.equal(kept + Number(m[1]), fullLen, `${nodeId} omitted count mismatch`);
				if (nodeId === "d63") {
					assert.equal(txtOut, sanitizeOutputText(JSON.stringify(rawVal, null, 2), 8000, [], []));
				}
			}
			const d64Out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=d64`)).json() as any;
			const d64Txt: string = d64Out.attempts[0].outputs_text;
			assert.ok(d64Txt.includes('"{...}"'), `d64 should contain depth-elided "{...}"`);
			const d64m = /… \[truncated, (\d+) characters? omitted\]$/.exec(d64Txt);
			assert.ok(d64m);
		},
	);
});

test("Round 3 unit hardening: R3-B1 line/anchor suffixes and file: prefix, R3-B2 drop multi-part with O(N) perf, N1 dotted stem/ext", () => {
	const cwd = "/home/alice/proj";
	const blocked = ["/home/alice", cwd];
	const tokens = collectArtifactPathTokens(
		[{ path: "src/PRIV_A.ts" }, { path: "src/@scope/PRIV_AT.ts" }, { path: "C:\\W\\Proj\\PRIV_WIN.ts" }, { path: "src\\PRIV_BS.ts" }],
		cwd,
	);

	// R3-B1: suffixes and file: prefix redact in both scrubbers
	const lineRefInput = "fixed src/PRIV_A.ts:12 and src/PRIV_A.ts:12:3, src/PRIV_A.ts#L5, src/PRIV_A.ts@HEAD, src/PRIV_A.ts/ , src/PRIV_A.ts~ , file:src/PRIV_A.ts, file:src/PRIV_A.ts:12, src/PRIV_A.ts&x, src/PRIV_A.ts+1, src/PRIV_A.ts%20, src/@scope/PRIV_AT.ts#L5, src\\PRIV_BS.ts:9, SRC\\priv_bs.ts@HEAD";
	const lineRefExpected = "fixed [redacted-path]:12 and [redacted-path]:12:3, [redacted-path]#L5, [redacted-path]@HEAD, [redacted-path]/ , [redacted-path]~ , file:[redacted-path], file:[redacted-path]:12, [redacted-path]&x, [redacted-path]+1, [redacted-path]%20, [redacted-path]#L5, [redacted-path]:9, [redacted-path]@HEAD";
	assert.equal(sanitizeOutputText(lineRefInput, 2000, blocked, tokens), lineRefExpected);
	assert.equal(sanitizeOperatorText(lineRefInput, 2000, blocked, tokens), lineRefExpected);

	// R3-B1: untouched non-matching words and subpaths
	const untouched = "mysrc/PRIV_A.tsx src/PRIV_A.tsx xsrc/PRIV_A.ts src/PRIV_A.ts.bak src/PRIV_A.tsfoo PRIV_A.ts foo:src/PRIV_A.ts";
	assert.equal(sanitizeOutputText(untouched, 2000, blocked, tokens), untouched);
	assert.equal(sanitizeOperatorText(untouched, 2000, blocked, tokens), untouched);

	// R3-B2: delimiter-containing artifact paths are excluded from free-text matching (and their pieces are not matched),
	// while absolute/tilde/drive paths still scrub via generic scrubber
	const multiTokens = collectArtifactPathTokens(
		[{ path: "docs/my plan.md" }, { path: "a]b/c.ts" }, { path: "x[1]/y.ts" }],
		cwd,
	);
	assert.deepEqual(multiTokens, []);
	assert.equal(
		sanitizeOutputText("docs/my plan.md and docs/my and plan.md and a]b/c.ts and x[1]/y.ts", 1000, blocked, multiTokens),
		"docs/my plan.md and docs/my and plan.md and a]b/c.ts and x[1]/y.ts",
	);
	assert.equal(
		sanitizeOutputText("at /opt/docs/my plan.md and ~bob/docs/my plan.md", 1000, blocked, multiTokens),
		"at [redacted-path] plan.md and [redacted-path] plan.md",
	);

	// R3-B2: spaced prefix-sharing artifact paths + long repeating text run in linear time
	const spacedArts = Array.from({ length: 20 }, (_, i) => ({ path: `${"a ".repeat(350)}/z${i}` }));
	const spacedTokens = collectArtifactPathTokens(spacedArts, cwd);
	assert.deepEqual(spacedTokens, []);
	const spacedText = "a ".repeat(20_000);
	const t0 = performance.now();
	sanitizeOutputText(spacedText, 8000, blocked, spacedTokens);
	for (let i = 0; i < 80; i++) sanitizeOutputText("a ".repeat(1000), 500, blocked, spacedTokens);
	sanitizeOperatorText(spacedText, 1000, blocked, spacedTokens);
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 500, `spaced-artifact unit scrub took too long: ${elapsed.toFixed(0)}ms`);

	// N1 / R4-N3: dotted prose words e.g, i.e, v1.2, x.12, a.c are not redacted as bare dotted paths,
	// while >=3-char dotfiles (.env, .gitignore) and 1-char stems with >=2-letter extensions (x.py, a.ts) are redacted
	const n1Tokens = collectArtifactPathTokens(
		[{ path: "e.g" }, { path: "i.e" }, { path: "v1.2" }, { path: "x.12" }, { path: "a.c" }, { path: "a.ts" }, { path: "x.py" }, { path: ".env" }, { path: ".gitignore" }, { path: "secret-file.ts" }],
		cwd,
	);
	assert.equal(
		sanitizeOutputText("e.g i.e v1.2 x.12 a.c vs a.ts x.py .env .gitignore secret-file.ts", 1000, blocked, n1Tokens),
		"e.g i.e v1.2 x.12 a.c vs [redacted-path] [redacted-path] [redacted-path] [redacted-path] [redacted-path]",
	);
	assert.equal(
		sanitizeOperatorText("e.g i.e v1.2 x.12 a.c vs a.ts x.py .env .gitignore secret-file.ts", 1000, blocked, n1Tokens),
		"e.g i.e v1.2 x.12 a.c vs [redacted-path] [redacted-path] [redacted-path] [redacted-path] [redacted-path]",
	);
});

test("Round 4 unit hardening: R4-B1 non-ASCII punctuation delimiters, N1 leading sigils, N2 $/^ and first .digit splits, N3 dotfiles/short stems", () => {
	const cwd = "/home/alice/proj";
	const blocked = ["/home/alice", cwd];
	const tokens = collectArtifactPathTokens([{ path: "src/a.ts" }], cwd);

	// R4-B1: non-ASCII punctuation delimits like ASCII punctuation in both scrubbers
	const uniCases: Array<[string, string]> = [
		["“src/a.ts”", "“[redacted-path]”"],
		["‘src/a.ts’", "‘[redacted-path]’"],
		["«src/a.ts»", "«[redacted-path]»"],
		["（src/a.ts）", "（[redacted-path]）"],
		["src/a.ts—x", "[redacted-path]—x"],
		["src/a.ts…", "[redacted-path]…"],
		["src/a.ts’s", "[redacted-path]’s"],
		["src/a.ts。", "[redacted-path]。"],
		["src/a.ts、x", "[redacted-path]、x"],
		["src/a.ts→x", "[redacted-path]→x"],
		["→src/a.ts", "→[redacted-path]"],
		["•src/a.ts", "•[redacted-path]"],
		["🚀src/a.ts🚀", "🚀[redacted-path]🚀"],
	];
	for (const [input, expected] of uniCases) {
		assert.equal(sanitizeOutputText(input, 1000, blocked, tokens), expected, `output failed on ${input}`);
		assert.equal(sanitizeOperatorText(input, 1000, blocked, tokens), expected, `operator failed on ${input}`);
	}

	// R4-B1: ASCII word boundaries and non-ASCII letters still extend words (must stay untouched)
	const nonMatches = "mysrc/a.tsx src/a.tsx xsrc/a.ts src/a.ts.bak src/a.tsfoo a.ts foo:src/a.ts ésrc/a.ts src/a.tsé e\u0301src/a.ts";
	assert.equal(sanitizeOutputText(nonMatches, 1000, blocked, tokens), nonMatches);
	assert.equal(sanitizeOperatorText(nonMatches, 1000, blocked, tokens), nonMatches);

	// R4-B1: hasArtifactDelim agrees with scanning on non-ASCII punctuation / surrogate halves
	assert.deepEqual(collectArtifactPathTokens([{ path: "src/a—b.ts" }, { path: "src/🚀.ts" }], cwd), []);

	// N1: leading @, #, &, % prefixes redact while preserving prefix and leaving foo:src/a.ts untouched
	const sigilInput = "@src/a.ts @src/a.ts:12 #src/a.ts &src/a.ts %src/a.ts @file:src/a.ts:3 foo:src/a.ts";
	const sigilExpected = "@[redacted-path] @[redacted-path]:12 #[redacted-path] &[redacted-path] %[redacted-path] @file:[redacted-path]:3 foo:src/a.ts";
	assert.equal(sanitizeOutputText(sigilInput, 1000, blocked, tokens), sigilExpected);
	assert.equal(sanitizeOperatorText(sigilInput, 1000, blocked, tokens), sigilExpected);

	// N2: $ and ^ split chars, plus first .digit split for multi-segment .1.2 / .1.1.1
	const n2Tokens = collectArtifactPathTokens(
		[{ path: "src/a.ts" }, { path: "a/b.ts" }, { path: "src/v1" }],
		cwd,
	);
	const n2Input = "src/a.ts$x src/a.ts^x src/a.ts.1.2 a/b.ts.1.1.1 src/v1.2.3";
	const n2Expected = "[redacted-path]$x [redacted-path]^x [redacted-path].1.2 [redacted-path].1.1.1 [redacted-path].2.3";
	assert.equal(sanitizeOutputText(n2Input, 1000, blocked, n2Tokens), n2Expected);
	assert.equal(sanitizeOperatorText(n2Input, 1000, blocked, n2Tokens), n2Expected);
	const n2Untouched = "a/b.tsx.1 src/a.ts.bak a/b.ts.x1 a/b.ts.bak.1";
	assert.equal(sanitizeOutputText(n2Untouched, 1000, blocked, n2Tokens), n2Untouched);
	assert.equal(sanitizeOperatorText(n2Untouched, 1000, blocked, n2Tokens), n2Untouched);

	// N2 perf: 200k runs of $, ^, and dots stay linear
	const matcher = compileArtifactRedactionMatcher(n2Tokens);
	const t0 = performance.now();
	for (const unit of ["$", "^", ".", "src/a.ts$x "]) {
		const big = unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000);
		sanitizeOutputText(big, 200_000, blocked, matcher);
		sanitizeOperatorText(big, 1000, blocked, matcher);
	}
	assert.ok(performance.now() - t0 < 500, "200k split-char run took too long");

	// N3: dotfiles >=3 chars and 1-char stem with >=2-letter extension; keep x.y / a.c / .a / .12 out
	const n3Tokens = collectArtifactPathTokens(
		[{ path: ".env" }, { path: ".gitignore" }, { path: "x.py" }, { path: "a.ts" }, { path: "a.c" }, { path: "e.g" }, { path: "i.e" }, { path: "v1.2" }, { path: "x.12" }, { path: ".a" }, { path: ".12" }],
		cwd,
	);
	assert.equal(
		sanitizeOutputText(".env .gitignore x.py a.ts a.c e.g i.e v1.2 x.12 .a .12", 1000, blocked, n3Tokens),
		"[redacted-path] [redacted-path] [redacted-path] [redacted-path] a.c e.g i.e v1.2 x.12 .a .12",
	);
});

test("GET /api/factories/:id/output and /live redact R3-B1 path:line/#L/@/file: forms across all fields and stay fast on spaced artifacts (R3-B2)", async t => {
	const { writeFileSync } = await import("node:fs");
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_R3_PROMPT",
		agents: [
			{ node_id: "lineref", persona: "builder", sub_task: "PRIVATE_R3_LINE" },
			{ node_id: "spaced", persona: "builder", sub_task: "PRIVATE_R3_SPACED" },
		],
	};
	const fac = ops({ action: "publish", name: "r3-fixes-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-r3-fixes" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "r3-ref", brief: "PRIVATE_R3_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const cfgOf = (e: ReturnType<typeof entryOf>) => readJson<WorkerConfig>(join(dir, `${e.instance_id}.config.json`));

	// R3-B1: path:line, path:line:col, path#L5, path@HEAD, file:path across summary, detail, lists, outputs, artifact description, and /live summary
	const lineEntry = entryOf("lineref");
	atomicJson(
		resultPath(dir, lineEntry.instance_id),
		completionRecord(
			cfgOf(lineEntry),
			{
				agent_name: lineEntry.persona_name,
				node_id: "lineref",
				status: "success",
				summary: "Fixed src/PRIV_R3.ts:12 and src/PRIV_R3.ts:12:3 and src/PRIV_R3.ts#L5 and src/PRIV_R3.ts@HEAD and file:src/PRIV_R3.ts",
				detail: "Details: src/PRIV_R3.ts:12 src/PRIV_R3.ts:12:3 src/PRIV_R3.ts#L5 src/PRIV_R3.ts@HEAD file:src/PRIV_R3.ts; keep mysrc/PRIV_R3.tsx src/PRIV_R3.ts.bak",
				verification: [{ check_id: "chk src/PRIV_R3.ts:12", result: "pass", reason: "verified src/PRIV_R3.ts#L5 and file:src/PRIV_R3.ts" }],
				warnings: ["warn src/PRIV_R3.ts:12:3 and src/PRIV_R3.ts@HEAD"],
				next_steps: ["next file:src/PRIV_R3.ts and src/PRIV_R3.ts:99"],
				outputs: { ref: "src/PRIV_R3.ts:12", anchor: "src/PRIV_R3.ts#L5", rev: "src/PRIV_R3.ts@HEAD", uri: "file:src/PRIV_R3.ts", safe: "src/PRIV_R3.tsx" },
				artifacts: [{ type: "file", path: "src/PRIV_R3.ts", description: "desc src/PRIV_R3.ts:12 src/PRIV_R3.ts:12:3 src/PRIV_R3.ts#L5 src/PRIV_R3.ts@HEAD file:src/PRIV_R3.ts" }],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	// R3-B2: route8-shape 339 KB record with 20 spaced prefix-sharing artifacts and long repeating text
	const repeatTxt = "a ".repeat(2000);
	const spacedEntry = entryOf("spaced");
	writeFileSync(
		resultPath(dir, spacedEntry.instance_id),
		JSON.stringify(
			completionRecord(
				cfgOf(spacedEntry),
				{
					agent_name: spacedEntry.persona_name,
					node_id: "spaced",
					status: "success",
					summary: repeatTxt,
					detail: "a ".repeat(20_000),
					outputs: { k: "a ".repeat(20_000) },
					warnings: Array.from({ length: 20 }, () => repeatTxt),
					next_steps: Array.from({ length: 20 }, () => repeatTxt),
					artifacts: Array.from({ length: 20 }, (_, i) => ({
						type: "file",
						path: `${"a ".repeat(350)}/z${i}`,
						description: repeatTxt,
					})),
				},
				"sent",
				"2026-01-01T00:00:01.000Z",
			),
		),
	);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const tLive0 = performance.now();
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			const liveMs = performance.now() - tLive0;
			assert.equal(liveRes.status, 200);
			const liveText = await liveRes.text();
			assert.ok(liveMs < 1000, `/live with spaced artifacts took ${liveMs.toFixed(0)}ms`);
			const live = JSON.parse(liveText);
			const liveLine = live.graph.nodes.find((n: any) => n.id === "lineref");
			assert.equal(
				liveLine.current_attempt.summary,
				"Fixed [redacted-path]:12 and [redacted-path]:12:3 and [redacted-path]#L5 and [redacted-path]@HEAD and file:[redacted-path]",
			);

			const lineOutRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=lineref`);
			assert.equal(lineOutRes.status, 200);
			const lineOutText = await lineOutRes.text();
			const lineOut = JSON.parse(lineOutText);
			const att = lineOut.attempts[0];
			assert.equal(
				att.summary,
				"Fixed [redacted-path]:12 and [redacted-path]:12:3 and [redacted-path]#L5 and [redacted-path]@HEAD and file:[redacted-path]",
			);
			assert.equal(
				att.detail,
				"Details: [redacted-path]:12 [redacted-path]:12:3 [redacted-path]#L5 [redacted-path]@HEAD file:[redacted-path]; keep mysrc/PRIV_R3.tsx src/PRIV_R3.ts.bak",
			);
			assert.match(att.verification.items[0].reason, /\[redacted-path\]#L5 and file:\[redacted-path\]/);
			assert.equal(att.warnings.items[0], "warn [redacted-path]:12:3 and [redacted-path]@HEAD");
			assert.equal(att.next_steps.items[0], "next file:[redacted-path] and [redacted-path]:99");
			assert.ok(att.outputs_text.includes('"[redacted-path]:12"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]#L5"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]@HEAD"'));
			assert.ok(att.outputs_text.includes('"file:[redacted-path]"'));
			assert.ok(att.outputs_text.includes('"src/PRIV_R3.tsx"'));
			assert.equal(
				att.artifacts.items[0].description,
				"desc [redacted-path]:12 [redacted-path]:12:3 [redacted-path]#L5 [redacted-path]@HEAD file:[redacted-path]",
			);
			assert.equal("path" in att.artifacts.items[0], false);
			assert.equal(lineOutText.includes("src/PRIV_R3.ts:"), false);
			assert.equal(lineOutText.includes("src/PRIV_R3.ts#"), false);
			assert.equal(lineOutText.includes("src/PRIV_R3.ts@"), false);
			assert.equal(lineOutText.includes("file:src/PRIV_R3.ts"), false);

			const tSpaced0 = performance.now();
			const spacedRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=spaced`);
			const spacedMs = performance.now() - tSpaced0;
			assert.equal(spacedRes.status, 200);
			const spacedText = await spacedRes.text();
			assert.ok(spacedMs < 1000, `/output with spaced artifacts took ${spacedMs.toFixed(0)}ms`);
			const spacedBody = JSON.parse(spacedText);
			assert.equal("path" in spacedBody.attempts[0].artifacts.items[0], false);
			assert.equal(spacedText.includes("/z0"), false);
		},
	);
});

test("GET /api/factories/:id/output and /live redact R4-B1 non-ASCII punctuation, N1 @, N2 $/^/.1.2, and N3 .env/x.py across all fields", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_R4_PROMPT",
		agents: [
			{ node_id: "uni", persona: "builder", sub_task: "PRIVATE_R4_UNI" },
		],
	};
	const fac = ops({ action: "publish", name: "r4-fixes-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-r4-fixes" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "r4-ref", brief: "PRIVATE_R4_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const uniEntry = launched.manifest.pane_manifest.find(e => e.node_id === "uni")!;
	const uniCfg = readJson<WorkerConfig>(join(dir, `${uniEntry.instance_id}.config.json`));

	const textPayload = "“src/a.ts” src/a.ts—x src/a.ts… （src/a.ts） src/a.ts。 @src/a.ts src/a.ts$x src/a.ts^x src/a.ts.1.2 .env x.py | keep ésrc/a.ts src/a.tsé foo:src/a.ts mysrc/a.tsx src/a.ts.bak";
	const expectedRedacted = "“[redacted-path]” [redacted-path]—x [redacted-path]… （[redacted-path]） [redacted-path]。 @[redacted-path] [redacted-path]$x [redacted-path]^x [redacted-path].1.2 [redacted-path] [redacted-path] | keep ésrc/a.ts src/a.tsé foo:src/a.ts mysrc/a.tsx src/a.ts.bak";

	atomicJson(
		resultPath(dir, uniEntry.instance_id),
		completionRecord(
			uniCfg,
			{
				agent_name: uniEntry.persona_name,
				node_id: "uni",
				status: "success",
				summary: textPayload,
				detail: textPayload,
				verification: [{ check_id: "chk-uni", result: "pass", reason: textPayload }],
				warnings: [textPayload],
				next_steps: [textPayload],
				outputs: {
					quoted: "“src/a.ts”",
					dash: "src/a.ts—x",
					ellipsis: "src/a.ts…",
					fullwidth: "（src/a.ts）",
					cjk: "src/a.ts。",
					mention: "@src/a.ts",
					dollar: "src/a.ts$x",
					caret: "src/a.ts^x",
					multiDot: "src/a.ts.1.2",
					dotfile: ".env",
					shortStem: "x.py",
					keepAccent: "ésrc/a.ts src/a.tsé",
				},
				artifacts: [
					{ type: "file", path: "src/a.ts", description: textPayload },
					{ type: "file", path: ".env", description: "dotfile .env" },
					{ type: "file", path: "x.py", description: "short x.py" },
				],
			},
			"sent",
			"2026-01-01T00:00:01.000Z",
		),
	);

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
			assert.equal(liveRes.status, 200);
			const live = await liveRes.json() as any;
			const liveUni = live.graph.nodes.find((n: any) => n.id === "uni");
			assert.equal(liveUni.current_attempt.summary, expectedRedacted);

			const outRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=uni`);
			assert.equal(outRes.status, 200);
			const outText = await outRes.text();
			const out = JSON.parse(outText);
			const att = out.attempts[0];
			assert.equal(att.summary, expectedRedacted);
			assert.equal(att.detail, expectedRedacted);
			assert.equal(att.verification.items[0].reason, expectedRedacted);
			assert.equal(att.warnings.items[0], expectedRedacted);
			assert.equal(att.next_steps.items[0], expectedRedacted);
			assert.equal(att.artifacts.items[0].description, expectedRedacted);
			assert.equal(att.artifacts.items[1].description, "dotfile [redacted-path]");
			assert.equal(att.artifacts.items[2].description, "short [redacted-path]");
			assert.ok(att.outputs_text.includes('"“[redacted-path]”"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]—x"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]…"'));
			assert.ok(att.outputs_text.includes('"（[redacted-path]）"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]。"'));
			assert.ok(att.outputs_text.includes('"@[redacted-path]"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]$x"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]^x"'));
			assert.ok(att.outputs_text.includes('"[redacted-path].1.2"'));
			assert.ok(att.outputs_text.includes('"[redacted-path]"'));
			assert.ok(att.outputs_text.includes('"ésrc/a.ts src/a.tsé"'));
			for (const art of att.artifacts.items) {
				assert.equal("path" in art, false);
			}
			for (const leakedForm of ["“src/a.ts”", "src/a.ts—", "src/a.ts…", "（src/a.ts）", "src/a.ts。", "@src/a.ts", "src/a.ts$", "src/a.ts^", "src/a.ts.1.2", "\".env\"", "\"x.py\""]) {
				assert.equal(outText.includes(leakedForm), false, `/output leaked ${leakedForm}`);
			}
		},
	);
});

test("Carried-forward scrubber items: \\p{No}/\\p{Nl}/\\p{Lm} delimiters, leading sigil runs, and fast 1 MiB artifact cap check", () => {
	const cwd = "/home/alice/proj";
	const blocked = ["/home/alice", cwd];
	const tokens = collectArtifactPathTokens([{ path: "src/a.ts" }], cwd);

	// (a) Non-ASCII numbers (\p{No}, \p{Nl}) and modifier letters (\p{Lm}) delimit in both scrubbers,
	// and runs of leading sigils (@, #, &, %, +, $, ^) are stripped before matching.
	const cases: Array<[string, string]> = [
		["src/a.ts¹", "[redacted-path]¹"],
		["②src/a.ts②", "②[redacted-path]②"],
		["src/a.ts½", "[redacted-path]½"],
		["src/a.tsʼs", "[redacted-path]ʼs"],
		["src/a.tsⅠ", "[redacted-path]Ⅰ"],
		["@@src/a.ts", "@@[redacted-path]"],
		["+src/a.ts", "+[redacted-path]"],
		["$src/a.ts", "$[redacted-path]"],
		["^src/a.ts", "^[redacted-path]"],
		["+@$^src/a.ts:12", "+@$^\[redacted-path]:12".replace("\\", "")],
		["@@file:src/a.ts:3", "@@file:[redacted-path]:3"],
	];
	for (const [input, expected] of cases) {
		assert.equal(sanitizeOutputText(input, 1000, blocked, tokens), expected, `output failed on ${input}`);
		assert.equal(sanitizeOperatorText(input, 1000, blocked, tokens), expected, `operator failed on ${input}`);
	}
	assert.deepEqual(
		collectArtifactPathTokens([
			{ path: "src/a¹.ts" },
			{ path: "src/a②.ts" },
			{ path: "src/a½.ts" },
			{ path: "src/aʼs.ts" },
			{ path: "src/aⅠ.ts" },
		], cwd),
		[],
	);

	// (b) 1+ MiB of artifact paths is rejected/bounded fast without per-code-unit regex overhead
	const hugeArtifacts = Array.from({ length: 20 }, (_, i) => ({
		type: "file",
		path: `dir_${i}/${"a".repeat(60_000)}.ts`,
	}));
	const t0 = performance.now();
	const hugeTokens = collectArtifactPathTokens(hugeArtifacts, cwd);
	const elapsed = performance.now() - t0;
	assert.ok(elapsed < 100, `1.2 MiB artifact path collection took too long: ${elapsed.toFixed(1)}ms`);
	assert.ok(hugeTokens.reduce((sum, tok) => sum + tok.length, 0) <= 256 * 1024);
});

test("Ticket 03: multi-attempt ordering, 20-attempt cap, 64KB response budget + trim order, independent per-attempt typing, and linear perf", async t => {
	const { symlinkSync, writeFileSync } = await import("node:fs");
	const { handoffClaimPath, inputDigest } = await import("./handoff.ts");
	const { finalizePath } = await import("./review-loop.ts");
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	// 1. 11-attempt persisted review loop (max_revisions: 10 limit in parseReviewPlan) + 23-attempt cap verification via resolveNodeAttempts
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_T03_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_T03_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_T03_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 10, on_exhausted: "needs_attention" },
			},
			{ node_id: "solo", persona: "builder", sub_task: "PRIVATE_T03_SOLO" },
		],
	};

	const fac = ops({ action: "publish", name: "t03-loop-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-t03" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t03-ref", brief: "PRIVATE_T03_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const buildEntry = entryOf("build");
	const reviewEntry = entryOf("review");
	const soloEntry = entryOf("solo");
	const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
	const reviewCfg = readJson<WorkerConfig>(join(dir, `${reviewEntry.instance_id}.config.json`));
	const soloCfg = readJson<WorkerConfig>(join(dir, `${soloEntry.instance_id}.config.json`));

	// Solo node has 1 attempt
	atomicJson(
		resultPath(dir, soloEntry.attempt_id!),
		completionRecord(soloCfg, { agent_name: soloEntry.persona_name, node_id: "solo", status: "success", summary: "Solo summary", detail: "Solo detail" }, "not_required", "2026-11-28T10:00:00.000Z"),
	);

	const seedLoopIteration = (
		n: number,
		buildResOpts: { status?: "success" | "partial" | "failure"; summary?: string; detail?: string; outputs?: Record<string, unknown>; warnings?: string[] },
		verdict: "approve" | "revise",
		writeBuildResult = true,
	) => {
		const bId = `${buildEntry.instance_id}.${n}`;
		const rId = `${reviewEntry.instance_id}.${n}`;
		const ts = `2026-11-28T10:00:${String(n).padStart(2, "0")}.000Z`;
		let bDigest = "0".repeat(64);
		if (writeBuildResult) {
			const rec = completionRecord(
				{ ...buildCfg, attempt_id: bId },
				{
					agent_name: buildEntry.persona_name,
					node_id: "build",
					status: buildResOpts.status ?? "success",
					summary: buildResOpts.summary ?? `Build summary ${n}`,
					detail: buildResOpts.detail ?? `Build detail ${n}\nline 2`,
					...(buildResOpts.outputs ? { outputs: buildResOpts.outputs } : {}),
					...(buildResOpts.warnings ? { warnings: buildResOpts.warnings } : {}),
				},
				"sent",
				ts,
			);
			atomicJson(resultPath(dir, bId), rec);
			bDigest = inputDigest(rec.result);
		}
		if (n >= 2) {
			atomicJson(join(dir, `${reviewEntry.instance_id}.${n}.revision.json`), {
				version: 1,
				run_id: launched.task_id,
				reviewer: reviewEntry.instance_id,
				attempt: n,
			});
			atomicJson(handoffClaimPath(dir, bId, reviewEntry.instance_id), {
				version: 1,
				handoff_id: `h-fb-${n}`,
				state: "accepted",
				run_id: launched.task_id,
				source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.${n - 1}`, instance_id: reviewEntry.instance_id, session_id: "s-rev" },
				destination: { node_id: "build", attempt_id: bId, instance_id: buildEntry.instance_id },
				input_digest: "0".repeat(64),
				offer: "matched",
				accepted_at: ts,
			});
		}
		const rRec = completionRecord(
			{ ...reviewCfg, attempt_id: rId },
			{
				agent_name: reviewEntry.persona_name,
				node_id: "review",
				status: "success",
				summary: `Review summary ${n}`,
				detail: `Review detail ${n}`,
				outputs: { verdict },
			},
			"sent",
			ts,
		);
		atomicJson(resultPath(dir, rId), rRec);
		atomicJson(handoffClaimPath(dir, rId, buildEntry.instance_id), {
			version: 1,
			handoff_id: `h-rev-${n}`,
			state: "accepted",
			run_id: launched.task_id,
			source: { node_id: "build", attempt_id: bId, instance_id: buildEntry.instance_id, session_id: "s-bld" },
			destination: { node_id: "review", attempt_id: rId, instance_id: reviewEntry.instance_id },
			input_digest: bDigest,
			offer: "matched",
			accepted_at: ts,
		});
		if (n >= 2) {
			atomicJson(handoffClaimPath(dir, rId, buildEntry.instance_id), {
				version: 1,
				handoff_id: `h-rev-${n}`,
				state: "accepted",
				run_id: launched.task_id,
				source: { node_id: "build", attempt_id: bId, instance_id: buildEntry.instance_id, session_id: "s-bld" },
				destination: { node_id: "review", attempt_id: rId, instance_id: reviewEntry.instance_id },
				input_digest: bDigest,
				offer: "matched",
				accepted_at: ts,
			});
		}
	};

	for (let n = 1; n <= 11; n++) {
		// Make attempt 9 have wrong node identity and attempt 10 be corrupt JSON to verify independent typing across attempts
		if (n === 9) {
			seedLoopIteration(n, {}, "revise", false);
			atomicJson(resultPath(dir, `${buildEntry.instance_id}.9`), {
				version: 6,
				identity: {
					run_id: launched.task_id,
					node_id: "other_wrong_node",
					persona_name: buildEntry.persona_name,
					attempt_id: `${buildEntry.instance_id}.9`,
					instance_id: buildEntry.instance_id,
				},
				result: { agent_name: buildEntry.persona_name, node_id: "other_wrong_node", status: "success", summary: "PRIVATE_WRONG_NODE_SUM", detail: "PRIVATE_WRONG_NODE_DET" },
				delivery: "not_required",
				completed_at: "2026-11-28T10:00:09.000Z",
			});
		} else if (n === 10) {
			seedLoopIteration(n, {}, "revise", false);
			writeFileSync(resultPath(dir, `${buildEntry.instance_id}.10`), "{corrupt PRIVATE_BAD_10");
		} else {
			seedLoopIteration(n, {
				status: n === 11 ? "success" : (n % 2 === 0 ? "partial" : "failure"),
				summary: `Build summary ${n} in ${f.cwd}/file${n}.ts`,
				detail: `Build detail ${n}\nline 2`,
				outputs: { iter: n, note: `iter-${n}` },
			}, n === 11 ? "approve" : "revise");
		}
	}
	atomicJson(finalizePath(dir, reviewEntry.instance_id), {
		version: 1,
		run_id: launched.task_id,
		instance_id: reviewEntry.instance_id,
		attempt_id: `${reviewEntry.instance_id}.11`,
		finalized_by: reviewEntry.instance_id,
	});
	atomicJson(finalizePath(dir, buildEntry.instance_id), {
		version: 1,
		run_id: launched.task_id,
		instance_id: buildEntry.instance_id,
		attempt_id: `${buildEntry.instance_id}.11`,
		finalized_by: reviewEntry.instance_id,
	});

	const sentinels = ["PRIVATE_", f.root, f.cwd, f.home, dir, statePath, coordinationPath];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Single-attempt node shows 1
			const soloOut = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=solo`)).json() as any;
			assert.equal(soloOut.attempts.length, 1);
			assert.equal(soloOut.total_attempts, 1);
			assert.equal(soloOut.omitted_attempts, 0);
			assert.equal("omitted_marker" in soloOut, false);

			// 11-attempt node over HTTP -> newest first [11..1], mixed damaged attempts 10 & 9 do not hide 11 or 8..1
			const bRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(bRes.status, 200);
			const bText = await bRes.text();
			scanSentinels(bText, sentinels, "output build 11-attempt");
			const bOut = JSON.parse(bText);
			assert.equal(bOut.attempts.length, 11);
			assert.equal(bOut.total_attempts, 11);
			assert.equal(bOut.omitted_attempts, 0);
			assert.equal("omitted_marker" in bOut, false);
			assert.equal(bOut.attempts[0].attempt_number, 11);
			assert.equal(bOut.attempts[0].max_attempts, 11);
			assert.equal(bOut.attempts[0].status, "succeeded");
			assert.equal(bOut.attempts[0].evidence, "available");
			assert.equal(bOut.attempts[0].summary, "Build summary 11 in [redacted-path]");
			// Attempt 10 (index 1) corrupt JSON -> evidence unavailable with verified attempt_number 10 without hiding 11 or 8..1
			assert.equal(bOut.attempts[1].attempt_number, 10);
			assert.equal(bOut.attempts[1].evidence, "unavailable");
			assert.equal(bOut.attempts[1].absence, "evidence unavailable");
			assert.equal(typeof bOut.attempts[1].attempt_id, "object");
			assert.equal(bOut.attempts[1].attempt_id.absence, "evidence unavailable");
			// Attempt 9 (index 2) wrong node_id -> evidence unavailable with verified attempt_number 9, zero leaked text
			assert.equal(bOut.attempts[2].attempt_number, 9);
			assert.equal(bOut.attempts[2].evidence, "unavailable");
			assert.equal(bOut.attempts[2].absence, "evidence unavailable");
			// Attempt 8 (index 3) and Attempt 1 (index 10) remain readable in order
			assert.equal(bOut.attempts[3].attempt_number, 8);
			assert.equal(bOut.attempts[3].evidence, "available");
			assert.equal(bOut.attempts[10].attempt_number, 1);
			assert.equal(bOut.attempts[10].evidence, "available");
		},
	);

	// Extend disk loop fixture to 23 attempts and test OUTPUT_MAX_ATTEMPTS = 20 cap via resolveNodeAttempts + enforceOutputResponseBudget
	for (let n = 12; n <= 23; n++) {
		if (n === 21) {
			seedLoopIteration(n, {}, "revise", false);
			atomicJson(resultPath(dir, `${buildEntry.instance_id}.21`), {
				version: 6,
				identity: {
					run_id: launched.task_id,
					node_id: "other_wrong_node",
					persona_name: buildEntry.persona_name,
					attempt_id: `${buildEntry.instance_id}.21`,
					instance_id: buildEntry.instance_id,
				},
				result: { agent_name: buildEntry.persona_name, node_id: "other_wrong_node", status: "success", summary: "PRIVATE_WRONG_NODE_SUM", detail: "PRIVATE_WRONG_NODE_DET" },
				delivery: "not_required",
				completed_at: "2026-11-28T10:00:21.000Z",
			});
		} else if (n === 22) {
			seedLoopIteration(n, {}, "revise", false);
			writeFileSync(resultPath(dir, `${buildEntry.instance_id}.22`), "{corrupt PRIVATE_BAD_22");
		} else {
			seedLoopIteration(n, {
				status: n === 23 ? "success" : (n % 2 === 0 ? "partial" : "failure"),
				summary: `Build summary ${n} in ${f.cwd}/file${n}.ts`,
				detail: `Build detail ${n}\nline 2`,
				outputs: { iter: n, note: `iter-${n}` },
			}, n === 23 ? "approve" : "revise");
		}
	}
	atomicJson(finalizePath(dir, reviewEntry.instance_id), {
		version: 1,
		run_id: launched.task_id,
		instance_id: reviewEntry.instance_id,
		attempt_id: `${reviewEntry.instance_id}.23`,
		finalized_by: reviewEntry.instance_id,
	});
	atomicJson(finalizePath(dir, buildEntry.instance_id), {
		version: 1,
		run_id: launched.task_id,
		instance_id: buildEntry.instance_id,
		attempt_id: `${buildEntry.instance_id}.23`,
		finalized_by: reviewEntry.instance_id,
	});
	const manifest25 = {
		...launched.manifest,
		review_plan: {
			...launched.manifest.review_plan!,
			max_total_attempts: 60,
			loops: [{ ...launched.manifest.review_plan!.loops[0], max_revisions: 24 }],
		},
	};
	const byInstance = new Map(manifest25.pane_manifest.map(e => [e.instance_id, e.node_id]));
	const resolved23 = resolveNodeAttempts(
		manifest25,
		buildEntry,
		byInstance,
		sentinels.filter(s => s !== "PRIVATE_"),
		{
			attempt_id: `${buildEntry.instance_id}.23`,
			attempt_number: 23,
			max_attempts: 25,
			instance_id: buildEntry.instance_id,
			key: `${buildEntry.instance_id}.23`,
			has_result: true,
			has_disposition: false,
			corrupt_or_unverified: false,
			status: "succeeded",
			status_text: "Succeeded",
			attempt_status: "succeeded",
			attempt_status_text: "Succeeded",
			completed_at: "2026-11-28T10:00:23.000Z",
			resource_state: "finished",
			process_state: "exited",
		} as any,
		20,
	);
	assert.equal(resolved23.attempts.length, 20);
	assert.equal(resolved23.totalAttempts, 23);
	assert.equal(resolved23.omittedAttempts, 3);
	assert.equal(resolved23.attempts[0].attempt_number, 23);
	assert.equal(resolved23.attempts[0].status, "succeeded");
	assert.equal(resolved23.attempts[1].attempt_number, 22);
	assert.equal(resolved23.attempts[1].corrupt_or_unverified, true);
	assert.equal(resolved23.attempts[1].status, "needs_attention");
	assert.equal(resolved23.attempts[2].attempt_number, 21);
	assert.equal(resolved23.attempts[2].corrupt_or_unverified, true);
	assert.equal(resolved23.attempts[2].status, "needs_attention");
	assert.equal(resolved23.attempts[3].attempt_number, 20);
	assert.equal(Boolean(resolved23.attempts[3].corrupt_or_unverified), false);
	assert.equal(resolved23.attempts[19].attempt_number, 4);
	assert.equal(Boolean(resolved23.attempts[19].corrupt_or_unverified), false);

	// 2. Maximal fields: 11 attempts over HTTP + 20 attempts in enforceOutputResponseBudget -> <= 64KB, < 1s, valid surrogate pairs
	const fMax = serviceFixture(t, ["builder", "reviewer"]);
	const stateMax = join(fMax.root, "factories.sqlite");
	const coordMax = join(fMax.root, "factory-coordination.sqlite");
	const envMax = { PATH: join(fMax.root, "bin"), PI_BOOTSTRAP_STATE_DIR: fMax.stateDir };
	const opsMax = factoryOperations(stateMax, fMax.service, { coordinationPath: coordMax });
	const draftMax: GenerateRequest = {
		project_cwd: fMax.cwd,
		topology: "graph",
		task: "PRIVATE_MAX_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_MAX_B" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_MAX_R",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 10, on_exhausted: "needs_attention" },
			},
		],
	};
	const facMax = opsMax({ action: "publish", name: "t03-max-fac", draft: draftMax, sessionModel });
	const authMax = createManagerAuthority({ pi_session_id: "sess-t03-max" });
	opsMax({ action: "resume", factory_id: facMax.factory_id, authority: authMax });
	opsMax({ action: "submit", factory_id: facMax.factory_id, authority: authMax, reference: "t03-max-ref", brief: "PRIVATE_MAX_BRIEF" });
	const launchedMax = await opsMax({ action: "launch", factory_id: facMax.factory_id, authority: authMax });
	revokeManagerAuthority(authMax);

	const dirMax = launchedMax.manifest.session_dir;
	const maxBuild = launchedMax.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const maxRev = launchedMax.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const maxBuildCfg = readJson<WorkerConfig>(join(dirMax, `${maxBuild.instance_id}.config.json`));
	const maxRevCfg = readJson<WorkerConfig>(join(dirMax, `${maxRev.instance_id}.config.json`));

	for (let n = 1; n <= 11; n++) {
		const bId = `${maxBuild.instance_id}.${n}`;
		const rId = `${maxRev.instance_id}.${n}`;
		const ts = `2026-11-28T11:00:${String(n).padStart(2, "0")}.000Z`;
		const rec = completionRecord(
			{ ...maxBuildCfg, attempt_id: bId },
			{
				agent_name: maxBuild.persona_name,
				node_id: "build",
				status: n === 11 ? "success" : "partial",
				summary: `Newest-protected summary ${n} ${"S".repeat(900)}`,
				detail: `${"D".repeat(7900)}🚀${"E".repeat(100)}`,
				verification: Array.from({ length: 20 }, (_, i) => ({
					check_id: `chk-${n}-${i}-${"C".repeat(440)}`,
					result: "pass" as const,
					scope_kind: "declared" as const,
					applicability: "current" as const,
				})),
				warnings: Array.from({ length: 20 }, (_, i) => `W${n}-${i}-${"W".repeat(480)}`),
				next_steps: Array.from({ length: 20 }, (_, i) => `N${n}-${i}-${"N".repeat(480)}`),
				outputs: { blob: `${"J".repeat(7900)}🚀` },
				artifacts: Array.from({ length: 20 }, (_, i) => ({
					type: "file",
					path: join(fMax.cwd, `PRIVATE_MAX_ART_${n}_${i}.ts`),
					description: `Art-${n}-${i}-${"A".repeat(480)}`,
				})),
			},
			"sent",
			ts,
		);
		writeFileSync(resultPath(dirMax, bId), JSON.stringify(rec));
		const bDigest = inputDigest(rec.result);
		if (n >= 2) {
			atomicJson(join(dirMax, `${maxRev.instance_id}.${n}.revision.json`), {
				version: 1,
				run_id: launchedMax.task_id,
				reviewer: maxRev.instance_id,
				attempt: n,
			});
			atomicJson(handoffClaimPath(dirMax, bId, maxRev.instance_id), {
				version: 1,
				handoff_id: `hm-fb-${n}`,
				state: "accepted",
				run_id: launchedMax.task_id,
				source: { node_id: "review", attempt_id: `${maxRev.instance_id}.${n - 1}`, instance_id: maxRev.instance_id, session_id: "sr" },
				destination: { node_id: "build", attempt_id: bId, instance_id: maxBuild.instance_id },
				input_digest: "0".repeat(64),
				offer: "matched",
				accepted_at: ts,
			});
		}
		atomicJson(resultPath(dirMax, rId), completionRecord(
			{ ...maxRevCfg, attempt_id: rId },
			{ agent_name: maxRev.persona_name, node_id: "review", status: "success", summary: `R${n}`, outputs: { verdict: n === 11 ? "approve" : "revise" } },
			"sent",
			ts,
		));
		atomicJson(handoffClaimPath(dirMax, rId, maxBuild.instance_id), {
			version: 1,
			handoff_id: `hm-r-${n}`,
			state: "accepted",
			run_id: launchedMax.task_id,
			source: { node_id: "build", attempt_id: bId, instance_id: maxBuild.instance_id, session_id: "sb" },
			destination: { node_id: "review", attempt_id: rId, instance_id: maxRev.instance_id },
			input_digest: bDigest,
			offer: "matched",
			accepted_at: ts,
		});
	}

	await verifyReadOnlyViewer(
		{ stateDirs: fMax.root, viewerOptions: { statePath: stateMax, coordinationPath: coordMax, env: envMax, home: fMax.home } },
		async viewer => {
			const tOut0 = performance.now();
			const outRes = await fetch(`${viewer.url}/api/factories/${facMax.factory_id}/output?node=build`);
			const outMs = performance.now() - tOut0;
			assert.equal(outRes.status, 200);
			const outText = await outRes.text();
			assert.ok(outMs < 1000, `11 maximal attempts /output took ${outMs.toFixed(0)}ms`);
			assert.ok(Buffer.byteLength(outText, "utf8") <= 64 * 1024, `expected <= 65536 bytes, got ${Buffer.byteLength(outText, "utf8")}`);
			assert.equal(outText.includes("PRIVATE_"), false);
			const parsed = JSON.parse(outText);
			assert.equal(parsed.attempts[0].attempt_number, 11);
			assert.equal(parsed.attempts[0].status, "succeeded");
			assert.ok(parsed.attempts[0].summary.startsWith("Newest-protected summary 11 "));
			assert.equal(parsed.attempts.length + parsed.omitted_attempts, 11);
			assert.ok(parsed.attempts.length >= 1);
			if (parsed.omitted_attempts > 0) {
				assert.match(parsed.omitted_marker, /\[truncated, \d+ attempts? omitted\]/);
			}
			assert.ok(typeof parsed.attempts[0].detail === "string");
			for (const a of parsed.attempts) {
				if (typeof a.detail === "string") assert.equal(a.detail.isWellFormed(), true);
				if (typeof a.outputs_text === "string") assert.equal(a.outputs_text.isWellFormed(), true);
			}
			// B3: Every trimmed older attempt field carries a counted truncation marker, never a bare "…"
			for (const a of parsed.attempts.slice(1)) {
				for (const field of ["summary", "detail", "outputs_text"] as const) {
					const val = a[field];
					if (typeof val === "string") {
						assert.notEqual(val, "…", `Attempt ${a.attempt_number}.${field} must not be trimmed to bare "…"`);
						assert.match(val, /… \[truncated, \d+ characters? omitted\]$/, `Attempt ${a.attempt_number}.${field} missing counted marker`);
					}
				}
			}

			const tLive0 = performance.now();
			const liveRes = await fetch(`${viewer.url}/api/factories/${facMax.factory_id}/live`);
			const liveMs = performance.now() - tLive0;
			assert.equal(liveRes.status, 200);
			assert.ok(liveMs < 1000, `11 maximal attempts /live took ${liveMs.toFixed(0)}ms`);
		},
	);

	// 20 maximal attempts (with 4-byte UTF-8 emojis so even 20 summaries exceed 64KB) directly through enforceOutputResponseBudget
	const max20Attempts = Array.from({ length: 20 }, (_, idx) => {
		const n = 20 - idx;
		return {
			attempt_id: `b.${n}`,
			attempt_number: n,
			max_attempts: 20,
			status: n === 20 ? "succeeded" : "partial",
			status_text: n === 20 ? "Succeeded" : "Partial",
			evidence: "available",
			summary: `Newest-protected summary ${n} ${"🚀".repeat(900)}`,
			detail: `${"D".repeat(7900)}🚀${"E".repeat(99)}`,
			outputs_text: `${"J".repeat(7900)}🚀`,
			verification: Array.from({ length: 20 }, (_, i) => ({ check_id: `chk-${n}-${i}-${"C".repeat(440)}`, result: "pass", applicability: "current" })),
			warnings: Array.from({ length: 20 }, (_, i) => `W${n}-${i}-${"W".repeat(480)}`),
			next_steps: Array.from({ length: 20 }, (_, i) => `N${n}-${i}-${"N".repeat(480)}`),
			artifacts: Array.from({ length: 20 }, (_, i) => ({ type: "file", description: `Art-${n}-${i}-${"A".repeat(480)}` })),
		};
	});
	const tBudget0 = performance.now();
	const budgeted20 = enforceOutputResponseBudget({
		factory_id: "fmax",
		node_id: "build",
		run_id: "r1",
		bound_version: "v1",
		evidence: "available",
		attempts: max20Attempts,
		total_attempts: 20,
		omitted_attempts: 0,
	});
	const budgetMs = performance.now() - tBudget0;
	const budgetedJson = JSON.stringify(budgeted20);
	assert.ok(budgetMs < 1000, `20 maximal attempts budget enforcement took ${budgetMs.toFixed(0)}ms`);
	assert.ok(Buffer.byteLength(budgetedJson, "utf8") <= 64 * 1024);
	assert.equal((budgeted20.attempts as any[])[0].attempt_number, 20);
	assert.equal((budgeted20.attempts as any[])[0].status, "succeeded");
	assert.ok((budgeted20.attempts as any[])[0].summary.startsWith("Newest-protected summary 20 "));
	assert.ok((budgeted20.omitted_attempts as number) > 0);
	assert.match(String(budgeted20.omitted_marker), /\[truncated, \d+ attempts? omitted\]/);
	for (const a of budgeted20.attempts as any[]) {
		if (typeof a.detail === "string") assert.equal(a.detail.isWellFormed(), true);
		if (typeof a.outputs_text === "string") assert.equal(a.outputs_text.isWellFormed(), true);
	}

	// 3. Controlled trim order unit test: older attempts' optional sections first, then older attempts' bodies, never newest summary/status
	const trimBody = enforceOutputResponseBudget(
		{
			factory_id: "f1",
			node_id: "n1",
			evidence: "available",
			total_attempts: 2,
			omitted_attempts: 0,
			attempts: [
				{
					attempt_id: "a.2",
					attempt_number: 2,
					max_attempts: 2,
					status: "succeeded",
					status_text: "Succeeded",
					evidence: "available",
					summary: "NEWEST_SUMMARY",
					detail: "NEWEST_DETAIL",
					outputs_text: "{\"newest\":true}",
				},
				{
					attempt_id: "a.1",
					attempt_number: 1,
					max_attempts: 2,
					status: "failure",
					status_text: "Failed",
					evidence: "available",
					summary: "OLDER_SUMMARY",
					detail: "D".repeat(400),
					outputs_text: "O".repeat(600),
				},
			],
		},
		1050,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(trimBody), "utf8") <= 1050);
	const trimAtts = trimBody.attempts as any[];
	assert.equal(trimAtts[0].summary, "NEWEST_SUMMARY");
	assert.equal(trimAtts[0].detail, "NEWEST_DETAIL");
	assert.equal(trimAtts[0].outputs_text, "{\"newest\":true}");
	assert.equal(trimAtts[0].status, "succeeded");
	// Optional section outputs_text is trimmed first before older attempt's detail
	assert.ok(trimAtts[1].outputs_text.includes("truncated"));
	assert.equal(trimAtts[1].detail, "D".repeat(400));

	// Tighter budget drops oldest attempt while preserving newest attempt's summary and status
	const dropOlderBody = enforceOutputResponseBudget(
		{
			factory_id: "f1",
			node_id: "n1",
			evidence: "available",
			total_attempts: 2,
			omitted_attempts: 0,
			attempts: [
				{
					attempt_id: "a.2",
					attempt_number: 2,
					max_attempts: 2,
					status: "succeeded",
					status_text: "Succeeded",
					evidence: "available",
					summary: "NEWEST_SUMMARY",
					detail: "NEWEST_DETAIL",
					outputs_text: "{\"newest\":true}",
				},
				{
					attempt_id: "a.1",
					attempt_number: 1,
					max_attempts: 2,
					status: "failure",
					status_text: "Failed",
					evidence: "available",
					summary: "OLDER_SUMMARY",
					detail: "D".repeat(400),
					outputs_text: "O".repeat(600),
				},
			],
		},
		420,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(dropOlderBody), "utf8") <= 420);
	assert.equal(dropOlderBody.omitted_attempts, 1);
	assert.equal(dropOlderBody.omitted_marker, "… [truncated, 1 attempt omitted]");
	assert.equal((dropOlderBody.attempts as any[]).length, 1);
	assert.equal((dropOlderBody.attempts as any[])[0].summary, "NEWEST_SUMMARY");
	assert.equal((dropOlderBody.attempts as any[])[0].status, "succeeded");

	// 4. Child watchdog: FIFO in attempt 1 alongside valid attempt 2 never blocks or hides attempt 2
	const fFifo = serviceFixture(t, ["builder", "reviewer"]);
	const stateFifo = join(fFifo.root, "factories.sqlite");
	const coordFifo = join(fFifo.root, "factory-coordination.sqlite");
	const envFifo = { PATH: join(fFifo.root, "bin"), PI_BOOTSTRAP_STATE_DIR: fFifo.stateDir };
	const opsFifo = factoryOperations(stateFifo, fFifo.service, { coordinationPath: coordFifo });
	const facFifo = opsFifo({
		action: "publish",
		name: "t03-fifo-fac",
		draft: {
			project_cwd: fFifo.cwd,
			topology: "graph",
			task: "PRIVATE_FIFO_P",
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "PRIVATE_FIFO_B" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "PRIVATE_FIFO_R",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
					decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2, on_exhausted: "failed" },
				},
			],
		},
		sessionModel,
	});
	const authFifo = createManagerAuthority({ pi_session_id: "sess-t03-fifo" });
	opsFifo({ action: "resume", factory_id: facFifo.factory_id, authority: authFifo });
	opsFifo({ action: "submit", factory_id: facFifo.factory_id, authority: authFifo, reference: "t03-fifo-ref", brief: "PRIVATE_FIFO_BRIEF" });
	const launchedFifo = await opsFifo({ action: "launch", factory_id: facFifo.factory_id, authority: authFifo });
	revokeManagerAuthority(authFifo);

	const dirFifo = launchedFifo.manifest.session_dir;
	const bFifo = launchedFifo.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const rFifo = launchedFifo.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const bFifoCfg = readJson<WorkerConfig>(join(dirFifo, `${bFifo.instance_id}.config.json`));
	const rFifoCfg = readJson<WorkerConfig>(join(dirFifo, `${rFifo.instance_id}.config.json`));

	// Attempt 1 build result is a FIFO; attempt 2 build result is valid; attempt 1 review requested revise
	execFileSync("mkfifo", [resultPath(dirFifo, `${bFifo.instance_id}.1`)]);
	atomicJson(resultPath(dirFifo, `${rFifo.instance_id}.1`), completionRecord(
		{ ...rFifoCfg, attempt_id: `${rFifo.instance_id}.1` },
		{ agent_name: rFifo.persona_name, node_id: "review", status: "success", summary: "Revise", outputs: { verdict: "revise" } },
		"sent",
		"2026-11-28T12:00:01.000Z",
	));
	atomicJson(join(dirFifo, `${rFifo.instance_id}.2.revision.json`), {
		version: 1,
		run_id: launchedFifo.task_id,
		reviewer: rFifo.instance_id,
		attempt: 2,
	});
	atomicJson(handoffClaimPath(dirFifo, `${bFifo.instance_id}.2`, rFifo.instance_id), {
		version: 1,
		handoff_id: "hf-2",
		state: "accepted",
		run_id: launchedFifo.task_id,
		source: { node_id: "review", attempt_id: `${rFifo.instance_id}.1`, instance_id: rFifo.instance_id, session_id: "sr" },
		destination: { node_id: "build", attempt_id: `${bFifo.instance_id}.2`, instance_id: bFifo.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T12:00:02.000Z",
	});
	atomicJson(resultPath(dirFifo, `${bFifo.instance_id}.2`), completionRecord(
		{ ...bFifoCfg, attempt_id: `${bFifo.instance_id}.2` },
		{ agent_name: bFifo.persona_name, node_id: "build", status: "success", summary: "Valid attempt 2 summary", detail: "Valid attempt 2 detail" },
		"sent",
		"2026-11-28T12:00:03.000Z",
	));
	// Also test symlink in another node? Attempt 1 FIFO + Attempt 2 valid is already verified in child watchdog:
	const fifoResponses = await verifyReadOnlyViewerInChild({
		stateDirs: fFifo.root,
		viewerOptions: { statePath: stateFifo, coordinationPath: coordFifo, env: envFifo, home: fFifo.home },
		paths: [`/api/factories/${facFifo.factory_id}/output?node=build`],
	});
	assert.equal(fifoResponses[0]!.status, 200);
	const fifoBody = JSON.parse(fifoResponses[0]!.text);
	assert.equal(fifoBody.attempts.length, 2);
	assert.equal(fifoBody.attempts[0].attempt_number, 2);
	assert.equal(fifoBody.attempts[0].evidence, "available");
	assert.equal(fifoBody.attempts[0].summary, "Valid attempt 2 summary");
	assert.equal(fifoBody.attempts[1].evidence, "unavailable");
	assert.equal(fifoBody.attempts[1].absence, "evidence unavailable");
	// Prevent symlinkSync unused warning by testing symlinked attempt 1 directly too
	void symlinkSync;
});

test("Ticket 03: Deleted factory retained multi-attempt output stays readable, damaged retained fails closed, and uncertain run offers no invented output", async t => {
	const { rmSync, writeFileSync } = await import("node:fs");
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_DEL_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_DEL_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_DEL_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2, on_exhausted: "failed" },
			},
		],
	};

	const fac = ops({ action: "publish", name: "t03-del-fac", draft, sessionModel });
	const secretMgrSession = join(f.root, "PRIVATE_DEL_MGR.jsonl");
	const auth = createManagerAuthority({ pi_session_id: "sess-t03-del", pi_session_file: secretMgrSession });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t03-del-ref", brief: "PRIVATE_DEL_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });

	const dir = launched.manifest.session_dir;
	const be = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const re = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const wm = { provider: "test-provider", id: "test-model" };
	const buildW = workerFromConfig(t, join(dir, `${be.instance_id}.config.json`), { model: wm });
	const reviewW = workerFromConfig(t, join(dir, `${re.instance_id}.config.json`), { model: wm });
	await buildW.start();
	await reviewW.start();
	await buildW.beforeStart();
	await reviewW.beforeStart();

	await buildW.complete({ status: "success", summary: "Deleted fac attempt 1", detail: "Attempt 1 retained\nline 2" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "Revise", detail: "Try again", outputs: { verdict: "revise" } });
	await buildW.beforeStart(notification(reviewW, buildW));
	await buildW.deliverFollowUps();
	await buildW.complete({ status: "success", summary: "Deleted fac attempt 2", detail: "Attempt 2 retained\nline 2" });
	await reviewW.beforeStart(notification(buildW, reviewW));
	await reviewW.deliverFollowUps();
	await reviewW.complete({ status: "success", summary: "Approved", detail: "Done", outputs: { verdict: "approve" } });

	assert.equal((await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);
	const delRes = await ops({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	revokeManagerAuthority(auth);
	assert.equal(delRes.deleted, true);

	// Empty deleted factory (no run)
	const emptyFac = ops({ action: "publish", name: "t03-del-empty", draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE_EMPTY", agents: [{ node_id: "only", persona: "builder", sub_task: "PRIVATE_E" }] }, sessionModel });
	const authE = createManagerAuthority({ pi_session_id: "sess-t03-empty" });
	ops({ action: "resume", factory_id: emptyFac.factory_id, authority: authE });
	await ops({ action: "delete", factory_id: emptyFac.factory_id, authority: authE, confirm: async () => true });
	revokeManagerAuthority(authE);

	const sentinels = ["PRIVATE_", f.root, f.cwd, f.home, dir, statePath, coordinationPath, secretMgrSession];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// /live remains state: "deleted", run: null, graph.absence: "not applicable"
			const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
			assert.equal(live.state, "deleted");
			assert.equal(live.run, null);
			assert.equal(live.graph.absence, "not applicable");

			// /output for deleted factory keeps retained multi-attempt output readable with deletion metadata
			const outRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(outRes.status, 200);
			const outText = await outRes.text();
			scanSentinels(outText, sentinels, "deleted output build");
			const out = JSON.parse(outText);
			assert.equal(out.deleted, true);
			assert.equal(out.deletion.deleted_at, delRes.deletion!.deleted_at);
			assert.equal("pi_session_file" in out.deletion.deleted_by, false);
			assert.equal(out.attempts.length, 2);
			assert.equal(out.attempts[0].attempt_number, 2);
			assert.equal(out.attempts[0].status, "succeeded");
			assert.equal(out.attempts[0].summary, "Deleted fac attempt 2");
			assert.equal(out.attempts[0].detail, "Attempt 2 retained\nline 2");
			assert.equal(out.attempts[1].attempt_number, 1);
			assert.equal(out.attempts[1].status, "succeeded");
			assert.equal(out.attempts[1].summary, "Deleted fac attempt 1");

			// Unknown node on deleted factory -> 404; empty deleted factory -> 404
			assert.equal((await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=missing_node`)).status, 404);
			assert.equal((await fetch(`${viewer.url}/api/factories/${emptyFac.factory_id}/output?node=only`)).status, 404);
		},
	);

	// Corrupt retained attempt 1 result on deleted factory -> attempt 2 stays readable, attempt 1 becomes evidence unavailable
	writeFileSync(resultPath(dir, `${be.instance_id}.1`), "{corrupt PRIVATE_DEL_CORRUPT");
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const outText = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).text();
			scanSentinels(outText, sentinels, "deleted corrupt attempt 1");
			const out = JSON.parse(outText);
			assert.equal(out.deleted, true);
			assert.equal(out.attempts[0].attempt_number, 2);
			assert.equal(out.attempts[0].evidence, "available");
			assert.equal(out.attempts[1].evidence, "unavailable");
			assert.equal(out.attempts[1].absence, "evidence unavailable");
		},
	);

	// Remove retained manifest on deleted factory -> /output refuses to invent output and returns evidence unavailable
	rmSync(join(dir, "manifest.json"));
	rmSync(join(f.stateDir, `${launched.task_id}.json`), { force: true });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const outText = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).text();
			assert.equal(outText.includes("Deleted fac attempt 2"), false);
			const out = JSON.parse(outText);
			assert.equal(out.deleted, true);
			assert.equal(out.evidence, "unavailable");
			assert.equal(out.absence, "evidence unavailable");
		},
	);
});

test("Fix round 1 (B1, B2, B3, N3, N5): verified attempt numbers, context-failure fallback, counted budget markers, retained-run scope, and cross-attempt artifact redaction", async t => {
	const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
	const { DatabaseSync } = await import("node:sqlite");

	// B1 + B2 + N5: 3-attempt review loop covering corrupt newest (build.3), contradictory older (build.2),
	// unfinished latest (attempt 3 running) with foreign progress and damaged readiness, and cross-attempt artifact redaction.
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_R1_PROMPT",
		agents: [
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_R1_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_R1_REVIEW",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 3, on_exhausted: "failed" },
			},
		],
	};
	const fac = ops({ action: "publish", name: "r1-loop-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-r1" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "r1-ref", brief: "PRIVATE_R1_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const dir = launched.manifest.session_dir;
	const be = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const re = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const m = { provider: "test-provider", id: "test-model" };
	const build = workerFromConfig(t, join(dir, `${be.instance_id}.config.json`), { model: m });
	const review = workerFromConfig(t, join(dir, `${re.instance_id}.config.json`), { model: m });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();

	mkdirSync(join(f.cwd, "src", "PRIVATE_CROSS_ATT1"), { recursive: true });
	writeFileSync(join(f.cwd, "src", "PRIVATE_CROSS_ATT1", "secret.ts"), "export const a = 1;\n");
	await build.complete({
		status: "success",
		summary: "Build 1",
		detail: "D1",
		artifacts: [{ type: "file", action: "created", path: "src/PRIVATE_CROSS_ATT1/secret.ts", description: "First attempt artifact" }],
	});
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise 1", detail: "r1", outputs: { verdict: "revise" } });

	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	mkdirSync(join(f.cwd, "src", "PRIVATE_CROSS_ATT2"), { recursive: true });
	writeFileSync(join(f.cwd, "src", "PRIVATE_CROSS_ATT2", "secret.ts"), "export const b = 2;\n");
	await build.complete({
		status: "success",
		summary: "Build 2",
		detail: "D2",
		artifacts: [{ type: "file", action: "created", path: "src/PRIVATE_CROSS_ATT2/secret.ts", description: "Second attempt artifact" }],
	});
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Revise 2", detail: "r2", outputs: { verdict: "revise" } });

	// Attempt 3 running (unfinished latest)
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();

	// B2 case 1: Unfinished attempt 3 with foreign progress record -> lists [unverified, 2, 1], total_attempts typed unavailable
	const progPath = join(dir, `${be.instance_id}.progress.json`);
	const savedProg = readFileSync(progPath, "utf8");
	writeFileSync(progPath, JSON.stringify({ ...JSON.parse(savedProg), token: "FOREIGN_TOKEN" }));
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).json() as any;
			assert.equal(out.attempts.length, 3, "B2 foreign progress must not hide attempt 2");
			assert.equal(typeof out.total_attempts, "object", "total_attempts must not be presented as exact");
			assert.equal(out.total_attempts.absence, "evidence unavailable");
			assert.equal(typeof out.attempts[0].attempt_number, "object");
			assert.equal(out.attempts[0].attempt_number.absence, "evidence unavailable");
			assert.match(out.attempts[0].attempt_number.explanation, /number unverified/i);
			assert.equal(out.attempts[0].evidence, "unavailable");
			assert.equal(out.attempts[1].attempt_number, 2);
			assert.equal(out.attempts[1].status, "succeeded");
			assert.equal(out.attempts[1].summary, "Build 2");
			assert.equal(out.attempts[2].attempt_number, 1);
			assert.equal(out.attempts[2].status, "succeeded");
			assert.equal(out.attempts[2].summary, "Build 1");
		},
	);
	writeFileSync(progPath, savedProg);

	// B2 case 2: Unfinished attempt 3 with damaged readiness record -> lists [unverified, 2, 1], total_attempts typed unavailable
	const rdyPath = readyPath(dir, be.instance_id);
	const savedReady = readFileSync(rdyPath, "utf8");
	writeFileSync(rdyPath, "{bad-ready");
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).json() as any;
			assert.equal(out.attempts.length, 3, "B2 damaged readiness must not hide attempt 2");
			assert.equal(typeof out.total_attempts, "object");
			assert.equal(out.total_attempts.absence, "evidence unavailable");
			assert.equal(typeof out.attempts[0].attempt_number, "object");
			assert.equal(out.attempts[0].attempt_number.absence, "evidence unavailable");
			assert.match(out.attempts[0].attempt_number.explanation, /number unverified/i);
			assert.equal(out.attempts[1].attempt_number, 2);
			assert.equal(out.attempts[1].summary, "Build 2");
			assert.equal(out.attempts[2].attempt_number, 1);
			assert.equal(out.attempts[2].summary, "Build 1");
		},
	);
	writeFileSync(rdyPath, savedReady);

	// Complete attempt 3 referencing attempt 2 & attempt 1 artifact paths (N5)
	await build.complete({
		status: "success",
		summary: "Build 3 mentions src/PRIVATE_CROSS_ATT2/secret.ts",
		detail: "D3 references src/PRIVATE_CROSS_ATT1/secret.ts and src/PRIVATE_CROSS_ATT2/secret.ts",
		outputs: { prev: "src/PRIVATE_CROSS_ATT2/secret.ts" },
	});
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "Approve", detail: "ok", outputs: { verdict: "approve" } });

	// N5: Attempt 3 text naming Attempt 2/1 artifact paths is redacted across the response
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const outText = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).text();
			assert.equal(outText.includes("PRIVATE_CROSS_ATT"), false, "N5 cross-attempt artifact paths must be redacted");
			const out = JSON.parse(outText);
			assert.equal(out.attempts[0].attempt_number, 3);
			assert.equal(out.attempts[0].summary, "Build 3 mentions [redacted-path]");
			assert.match(out.attempts[0].detail, /D3 references \[redacted-path\] and \[redacted-path\]/);
		},
	);

	// B1 case 1: Corrupt build.3.result.json -> ["3 Uncertain masked", "2 Succeeded", "1 Succeeded"]
	const p3 = resultPath(dir, `${be.instance_id}.3`);
	const s3 = readFileSync(p3, "utf8");
	writeFileSync(p3, "{corrupt-build3");
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).json() as any;
			assert.equal(out.total_attempts, 3);
			assert.equal(out.attempts[0].attempt_number, 3);
			assert.equal(out.attempts[0].status, "needs_attention");
			assert.equal(out.attempts[0].evidence, "unavailable");
			assert.equal(out.attempts[0].attempt_id.absence, "evidence unavailable");
			assert.equal(out.attempts[1].attempt_number, 2);
			assert.equal(out.attempts[1].status, "succeeded");
			assert.equal(out.attempts[2].attempt_number, 1);
			assert.equal(out.attempts[2].status, "succeeded");
		},
	);
	writeFileSync(p3, s3);

	// B1 case 2: Contradictory build.2 (both result and disposition) -> ["3 Succeeded", "2 Uncertain masked", "1 Succeeded"]
	const d2 = dispositionPath(dir, `${be.instance_id}.2`);
	writeFileSync(d2, "{}");
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const out = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`)).json() as any;
			assert.equal(out.total_attempts, 3);
			assert.equal(out.attempts[0].attempt_number, 3);
			assert.equal(out.attempts[0].status, "succeeded");
			assert.equal(out.attempts[1].attempt_number, 2);
			assert.equal(out.attempts[1].status, "needs_attention");
			assert.equal(out.attempts[1].evidence, "unavailable");
			assert.equal(out.attempts[1].attempt_id.absence, "evidence unavailable");
			assert.equal(out.attempts[2].attempt_number, 1);
			assert.equal(out.attempts[2].status, "succeeded");
		},
	);
	rmSync(d2);

	// N3: Active factory whose last run settled returns 404 on /output (retained path is Deleted-only)
	assert.equal((await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth })).settled, true);
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const settledRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(settledRes.status, 404, "Settled active factory must return 404 on /output");
		},
	);

	// N3: Deleted factory with corrupt bound definition (while v2 is current) returns 404 for unknown node (verified via index manifest)
	// and 200 unavailable for known node, and when both definition and index manifest are unavailable, returns 200 unavailable.
	ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: { ...draft, task: "PRIVATE_R1_V2" }, sessionModel });
	await ops({ action: "delete", factory_id: fac.factory_id, authority: auth, confirm: async () => true });
	revokeManagerAuthority(auth);
	const db = new DatabaseSync(statePath);
	try {
		db.prepare("UPDATE factory_versions SET definition = '{corrupt-def' WHERE factory_id = ? AND version = 'v1'").run(fac.factory_id);
	} finally {
		db.close();
	}
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const unknownRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=not_a_node`);
			assert.equal(unknownRes.status, 404, "Unknown node with corrupt bound definition and intact index manifest must return 404");
			const knownRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(knownRes.status, 200);
			const knownBody = await knownRes.json() as any;
			assert.equal(knownBody.evidence, "unavailable");
			assert.equal(knownBody.absence, "evidence unavailable");
		},
	);
	rmSync(join(f.stateDir, `${launched.task_id}.json`));
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(res.status, 200);
			const body = await res.json() as any;
			assert.equal(body.evidence, "unavailable");
			assert.equal(body.absence, "evidence unavailable");
		},
	);

	// B3: Budget trimming always emits counted marker (kept + omitted = true length), allows kept=0 bare marker,
	// and drops the field with visible omission count only when even the bare marker does not fit.
	const bareMarkerExact = reboundOutputText("abcdef… [truncated, 10 characters omitted]", 36);
	assert.equal(bareMarkerExact, "… [truncated, 16 characters omitted]");

	const preTruncated = sanitizeOutputText("A".repeat(12000), 8000);
	const olderTrimmed = enforceOutputResponseBudget(
		{
			factory_id: "f1",
			node_id: "build",
			evidence: "available",
			total_attempts: 2,
			omitted_attempts: 0,
			attempts: [
				{
					attempt_id: "a.2",
					attempt_number: 2,
					max_attempts: 2,
					status: "succeeded",
					status_text: "Succeeded",
					evidence: "available",
					summary: "NEWEST_SUMMARY",
					detail: "NEWEST_DETAIL",
				},
				{
					attempt_id: "a.1",
					attempt_number: 1,
					max_attempts: 2,
					status: "partial",
					status_text: "Partial",
					evidence: "available",
					summary: "S".repeat(200),
					detail: preTruncated,
					outputs_text: "O".repeat(300),
				},
			],
		},
		650,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(olderTrimmed), "utf8") <= 650);
	const trimmedAtt1 = (olderTrimmed.attempts as any[])[1];
	for (const [field, trueLen] of [["summary", 200], ["detail", 12000], ["outputs_text", 300]] as const) {
		const v = trimmedAtt1[field];
		if (v !== undefined) {
			assert.notEqual(v, "…");
			const m = /^(.*?)… \[truncated, (\d+) characters? omitted\]$/.exec(v);
			assert.ok(m, `Expected counted marker on ${field}, got ${JSON.stringify(v)}`);
			assert.equal(Array.from(m![1]!).length + Number(m![2]!), trueLen, `Exact count mismatch for ${field}`);
		}
	}

	// When even the bare marker does not fit on the newest attempt's optional field, drop it and record visible omission count
	const droppedFieldBody = enforceOutputResponseBudget(
		{
			factory_id: "f1",
			node_id: "build",
			evidence: "available",
			total_attempts: 1,
			omitted_attempts: 0,
			attempts: [
				{
					attempt_id: "a.1",
					attempt_number: 1,
					max_attempts: 1,
					status: "succeeded",
					status_text: "Succeeded",
					evidence: "available",
					summary: "S".repeat(280),
					outputs_text: "O".repeat(500),
				},
			],
		},
		570,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(droppedFieldBody), "utf8") <= 570);
	const droppedAtt = (droppedFieldBody.attempts as any[])[0];
	assert.equal("outputs_text" in droppedAtt, false, "outputs_text must be dropped when bare marker cannot fit");
	assert.equal(droppedAtt.omitted_characters, 500);
	assert.equal(droppedAtt.summary, "S".repeat(280));
});

test("Fix round 1 (ticket 05 B1): artifact-path redaction runs on command excerpts/errors, disposition reasons, error messages, and causes in /output, and 11-attempt prefix timing stays < 1s", async t => {
	const { writeFileSync } = await import("node:fs");
	const { runCancelPath } = await import("./cancellation.ts");
	const { handoffClaimPath, inputDigest } = await import("./handoff.ts");
	const { finalizePath } = await import("./review-loop.ts");

	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_T05_B1_PROMPT",
		agents: [
			{
				node_id: "cmd_json_ok",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_T05_CMD_OK",
			},
			{
				node_id: "cmd_json_fail",
				kind: "command",
				command: process.execPath,
				args: ["-e", "process.exit(1)"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_T05_CMD_FAIL",
			},
			{ node_id: "build", persona: "builder", sub_task: "PRIVATE_T05_BUILD" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_T05_REV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 4, on_exhausted: "failed" },
			},
			{ node_id: "cancel_loop", persona: "builder", sub_task: "PRIVATE_T05_CL" },
			{
				node_id: "cancel_rev",
				persona: "reviewer",
				depends_on: ["cancel_loop"],
				sub_task: "PRIVATE_T05_CREV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "cancel_loop", max_revisions: 2, on_exhausted: "failed" },
			},
			{
				node_id: "cmd_loop",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_T05_CMDL",
			},
			{
				node_id: "cmd_rev",
				persona: "reviewer",
				depends_on: ["cmd_loop"],
				sub_task: "PRIVATE_T05_CMDREV",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "cmd_loop", max_revisions: 2, on_exhausted: "failed" },
			},
		],
	};

	const fac = ops({ action: "publish", name: "t05-b1-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-t05-b1" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t05-b1-ref", brief: "PRIVATE_T05_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const cfgOf = (e: ReturnType<typeof entryOf>) => readJson<WorkerConfig>(join(dir, `${e.instance_id}.config.json`));

	// 1. Single-attempt successful command node whose stdout JSON contains the artifact path and line ref, > 4000 chars
	const cmdOkEntry = entryOf("cmd_json_ok");
	const longJsonStdout = `{"artifacts":[{"path":"src/PRIV_ART.ts","description":"cmd"}]} ref src/PRIV_ART.ts:12\n${"X".repeat(4200)} tail src/PRIV_ART.ts`;
	atomicJson(
		resultPath(dir, cmdOkEntry.attempt_id ?? cmdOkEntry.instance_id),
		completionRecord(
			cfgOf(cmdOkEntry),
			{
				agent_name: cmdOkEntry.persona_name,
				node_id: "cmd_json_ok",
				status: "success",
				summary: "Command succeeded",
				detail: "Parsed JSON from stdout",
				artifacts: [{ type: "file", path: "src/PRIV_ART.ts", action: "created", description: "Command output artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: f.cwd,
					exit_code: 0,
					signal: null,
					started_at: "2026-11-28T13:00:00.000Z",
					finished_at: "2026-11-28T13:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: longJsonStdout.length,
					stderr_bytes: 0,
					stdout_excerpt: longJsonStdout,
					stderr_excerpt: "",
				},
			},
			"not_required",
			"2026-11-28T13:00:01.000Z",
		),
	);

	// 2. Single-attempt failed command node whose stderr, stdout, spawn_error, and termination_error name an artifact path
	const cmdFailEntry = entryOf("cmd_json_fail");
	atomicJson(
		resultPath(dir, cmdFailEntry.attempt_id ?? cmdFailEntry.instance_id),
		completionRecord(
			cfgOf(cmdFailEntry),
			{
				agent_name: cmdFailEntry.persona_name,
				node_id: "cmd_json_fail",
				status: "failure",
				summary: "Command failed",
				detail: "Command failed with partial artifact",
				artifacts: [{ type: "file", path: "src/PRIV_FAIL_ART.ts", action: "modified", description: "Failed command artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "process.exit(1)"],
					working_directory: f.cwd,
					exit_code: 1,
					signal: "SIGTERM",
					started_at: "2026-11-28T13:00:00.000Z",
					finished_at: "2026-11-28T13:00:02.000Z",
					duration_ms: 2000,
					stdout_bytes: 128,
					stderr_bytes: 128,
					stdout_excerpt: "partial src/PRIV_FAIL_ART.ts:5",
					stderr_excerpt: "Compile error in src/PRIV_FAIL_ART.ts and src/PRIV_FAIL_ART.ts:12",
					spawn_error: "Spawn failed near src/PRIV_FAIL_ART.ts",
					termination_error: "Kill failed near src/PRIV_FAIL_ART.ts",
				},
			},
			"not_required",
			"2026-11-28T13:00:02.000Z",
		),
	);

	// 3. Multi-attempt node `build`: Attempt 1 has artifacts, Attempt 2 has disposition (reason, causes, command_evidence), Attempt 3 has error.json
	const buildEntry = entryOf("build");
	const revEntry = entryOf("review");
	const buildCfg = cfgOf(buildEntry);
	const revCfg = cfgOf(revEntry);

	const b1Rec = completionRecord(
		{ ...buildCfg, attempt_id: `${buildEntry.instance_id}.1` },
		{
			agent_name: buildEntry.persona_name,
			node_id: "build",
			status: "success",
			summary: "Attempt 1 built",
			detail: "Built file",
			artifacts: [{ type: "file", path: "src/PRIV_LOOP_ART.ts", action: "created", description: "Loop artifact" }],
		},
		"sent",
		"2026-11-28T13:01:00.000Z",
	);
	atomicJson(resultPath(dir, `${buildEntry.instance_id}.1`), b1Rec);
	atomicJson(resultPath(dir, `${revEntry.instance_id}.1`), completionRecord(
		{ ...revCfg, attempt_id: `${revEntry.instance_id}.1` },
		{ agent_name: revEntry.persona_name, node_id: "review", status: "success", summary: "Revise 1", outputs: { verdict: "revise" } },
		"sent",
		"2026-11-28T13:01:01.000Z",
	));
	atomicJson(handoffClaimPath(dir, `${revEntry.instance_id}.1`, buildEntry.instance_id), {
		version: 1,
		handoff_id: "hf-r1",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "build", attempt_id: `${buildEntry.instance_id}.1`, instance_id: buildEntry.instance_id, session_id: "sb" },
		destination: { node_id: "review", attempt_id: `${revEntry.instance_id}.1`, instance_id: revEntry.instance_id },
		input_digest: inputDigest(b1Rec.result),
		offer: "matched",
		accepted_at: "2026-11-28T13:01:01.000Z",
	});

	// Attempt 2: disposition (blocked) with reason, causes, and command_evidence naming src/PRIV_LOOP_ART.ts
	atomicJson(join(dir, `${revEntry.instance_id}.2.revision.json`), {
		version: 1,
		run_id: launched.task_id,
		reviewer: revEntry.instance_id,
		attempt: 2,
	});
	atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.2`, revEntry.instance_id), {
		version: 1,
		handoff_id: "hf-b2",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "review", attempt_id: `${revEntry.instance_id}.1`, instance_id: revEntry.instance_id, session_id: "sr" },
		destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T13:01:02.000Z",
	});
	atomicJson(dispositionPath(dir, `${buildEntry.instance_id}.2`), dispositionRecord(
		{ ...buildEntry, attempt_id: `${buildEntry.instance_id}.2`, task_id: launched.task_id },
		"blocked",
		"Blocked on src/PRIV_LOOP_ART.ts and src/PRIV_LOOP_ART.ts:44",
		[{
			node_id: "src/PRIV_LOOP_ART.ts",
			state: "failed",
			reason: "Broken in src/PRIV_LOOP_ART.ts",
			check: { name: "check src/PRIV_LOOP_ART.ts", evidence: "failed" },
		}],
		"2026-11-28T13:01:03.000Z",
	));
	atomicJson(resultPath(dir, `${revEntry.instance_id}.2`), completionRecord(
		{ ...revCfg, attempt_id: `${revEntry.instance_id}.2` },
		{ agent_name: revEntry.persona_name, node_id: "review", status: "success", summary: "Revise 2", outputs: { verdict: "revise" } },
		"sent",
		"2026-11-28T13:01:04.000Z",
	));
	atomicJson(handoffClaimPath(dir, `${revEntry.instance_id}.2`, buildEntry.instance_id), {
		version: 1,
		handoff_id: "hf-r2",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id, session_id: "sb" },
		destination: { node_id: "review", attempt_id: `${revEntry.instance_id}.2`, instance_id: revEntry.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T13:01:04.000Z",
	});

	// Attempt 3: error.json naming src/PRIV_LOOP_ART.ts
	atomicJson(join(dir, `${revEntry.instance_id}.3.revision.json`), {
		version: 1,
		run_id: launched.task_id,
		reviewer: revEntry.instance_id,
		attempt: 3,
	});
	atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.3`, revEntry.instance_id), {
		version: 1,
		handoff_id: "hf-b3",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "review", attempt_id: `${revEntry.instance_id}.2`, instance_id: revEntry.instance_id, session_id: "sr" },
		destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.3`, instance_id: buildEntry.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T13:01:05.000Z",
	});
	atomicJson(join(dir, `${buildEntry.instance_id}.3.error.json`), {
		error: "Execution failed at src/PRIV_LOOP_ART.ts:99",
	});

	// 4. Multi-attempt node `cancel_loop`: Attempt 1 has artifacts, Attempt 2 is cancelled naming src/PRIV_CAN_ART.ts
	const clEntry = entryOf("cancel_loop");
	const crEntry = entryOf("cancel_rev");
	const clCfg = cfgOf(clEntry);
	const crCfg = cfgOf(crEntry);
	const cl1Rec = completionRecord(
		{ ...clCfg, attempt_id: `${clEntry.instance_id}.1` },
		{
			agent_name: clEntry.persona_name,
			node_id: "cancel_loop",
			status: "success",
			summary: "Cancel loop 1",
			artifacts: [{ type: "file", path: "src/PRIV_CAN_ART.ts", action: "created", description: "Cancel loop artifact" }],
		},
		"sent",
		"2026-11-28T13:02:00.000Z",
	);
	atomicJson(resultPath(dir, `${clEntry.instance_id}.1`), cl1Rec);
	atomicJson(resultPath(dir, `${crEntry.instance_id}.1`), completionRecord(
		{ ...crCfg, attempt_id: `${crEntry.instance_id}.1` },
		{ agent_name: crEntry.persona_name, node_id: "cancel_rev", status: "success", summary: "Revise cl", outputs: { verdict: "revise" } },
		"sent",
		"2026-11-28T13:02:01.000Z",
	));
	atomicJson(handoffClaimPath(dir, `${crEntry.instance_id}.1`, clEntry.instance_id), {
		version: 1,
		handoff_id: "hf-cr1",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "cancel_loop", attempt_id: `${clEntry.instance_id}.1`, instance_id: clEntry.instance_id, session_id: "scl" },
		destination: { node_id: "cancel_rev", attempt_id: `${crEntry.instance_id}.1`, instance_id: crEntry.instance_id },
		input_digest: inputDigest(cl1Rec.result),
		offer: "matched",
		accepted_at: "2026-11-28T13:02:01.000Z",
	});
	atomicJson(join(dir, `${crEntry.instance_id}.2.revision.json`), {
		version: 1,
		run_id: launched.task_id,
		reviewer: crEntry.instance_id,
		attempt: 2,
	});
	atomicJson(handoffClaimPath(dir, `${clEntry.instance_id}.2`, crEntry.instance_id), {
		version: 1,
		handoff_id: "hf-cl2",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "cancel_rev", attempt_id: `${crEntry.instance_id}.1`, instance_id: crEntry.instance_id, session_id: "scr" },
		destination: { node_id: "cancel_loop", attempt_id: `${clEntry.instance_id}.2`, instance_id: clEntry.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T13:02:02.000Z",
	});
	atomicJson(runCancelPath(dir), {
		version: 1,
		run_id: launched.task_id,
		reason: "Cancelled while editing src/PRIV_CAN_ART.ts",
		requested_at: "2026-11-28T13:02:03.000Z",
		grace_ms: 1000,
		force_close_after: "2026-11-28T13:02:04.000Z",
	});

	// 5. Multi-attempt command node `cmd_loop`: Attempt 1 has artifacts, Attempt 2 has disposition with command_evidence
	const cmdLoopEntry = entryOf("cmd_loop");
	const cmdRevEntry = entryOf("cmd_rev");
	const cmdLoopCfg = cfgOf(cmdLoopEntry);
	const cmdRevCfg = cfgOf(cmdRevEntry);
	const cmdLoop1Rec = completionRecord(
		{ ...cmdLoopCfg, attempt_id: `${cmdLoopEntry.instance_id}.1` },
		{
			agent_name: cmdLoopEntry.persona_name,
			node_id: "cmd_loop",
			status: "success",
			summary: "Cmd loop 1",
			artifacts: [{ type: "file", path: "src/PRIV_CMD_LOOP.ts", action: "created", description: "Cmd loop artifact" }],
			command_evidence: {
				version: 1,
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				exit_code: 0,
				signal: null,
				started_at: "2026-11-28T13:03:00.000Z",
				finished_at: "2026-11-28T13:03:00.500Z",
				duration_ms: 500,
				stdout_bytes: 42,
				stderr_bytes: 0,
				stdout_excerpt: '{"artifacts":[{"path":"src/PRIV_CMD_LOOP.ts"}]}',
				stderr_excerpt: "",
			},
		},
		"not_required",
		"2026-11-28T13:03:00.500Z",
	);
	atomicJson(resultPath(dir, `${cmdLoopEntry.instance_id}.1`), cmdLoop1Rec);
	atomicJson(resultPath(dir, `${cmdRevEntry.instance_id}.1`), completionRecord(
		{ ...cmdRevCfg, attempt_id: `${cmdRevEntry.instance_id}.1` },
		{ agent_name: cmdRevEntry.persona_name, node_id: "cmd_rev", status: "success", summary: "Revise cmd", outputs: { verdict: "revise" } },
		"sent",
		"2026-11-28T13:03:01.000Z",
	));
	atomicJson(handoffClaimPath(dir, `${cmdRevEntry.instance_id}.1`, cmdLoopEntry.instance_id), {
		version: 1,
		handoff_id: "hf-cmdr1",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "cmd_loop", attempt_id: `${cmdLoopEntry.instance_id}.1`, instance_id: cmdLoopEntry.instance_id, session_id: "scmdl" },
		destination: { node_id: "cmd_rev", attempt_id: `${cmdRevEntry.instance_id}.1`, instance_id: cmdRevEntry.instance_id },
		input_digest: inputDigest(cmdLoop1Rec.result),
		offer: "matched",
		accepted_at: "2026-11-28T13:03:01.000Z",
	});
	atomicJson(join(dir, `${cmdRevEntry.instance_id}.2.revision.json`), {
		version: 1,
		run_id: launched.task_id,
		reviewer: cmdRevEntry.instance_id,
		attempt: 2,
	});
	atomicJson(handoffClaimPath(dir, `${cmdLoopEntry.instance_id}.2`, cmdRevEntry.instance_id), {
		version: 1,
		handoff_id: "hf-cmdl2",
		state: "accepted",
		run_id: launched.task_id,
		source: { node_id: "cmd_rev", attempt_id: `${cmdRevEntry.instance_id}.1`, instance_id: cmdRevEntry.instance_id, session_id: "scmdr" },
		destination: { node_id: "cmd_loop", attempt_id: `${cmdLoopEntry.instance_id}.2`, instance_id: cmdLoopEntry.instance_id },
		input_digest: "0".repeat(64),
		offer: "matched",
		accepted_at: "2026-11-28T13:03:02.000Z",
	});
	atomicJson(dispositionPath(dir, `${cmdLoopEntry.instance_id}.2`), dispositionRecord(
		{ ...cmdLoopEntry, attempt_id: `${cmdLoopEntry.instance_id}.2`, task_id: launched.task_id },
		"needs_attention",
		"Termination unverified near src/PRIV_CMD_LOOP.ts",
		[],
		"2026-11-28T13:03:03.000Z",
		{
			version: 1,
			command: process.execPath,
			args: ["-e", "0"],
			working_directory: f.cwd,
			exit_code: null,
			signal: "SIGTERM",
			started_at: "2026-11-28T13:03:02.000Z",
			finished_at: "2026-11-28T13:03:03.000Z",
			duration_ms: 1000,
			stdout_bytes: 64,
			stderr_bytes: 64,
			stdout_excerpt: '{"artifacts":[{"path":"src/PRIV_CMD_LOOP.ts"}]}',
			stderr_excerpt: "stderr src/PRIV_CMD_LOOP.ts:12",
			spawn_error: "spawn src/PRIV_CMD_LOOP.ts",
			termination_error: "term src/PRIV_CMD_LOOP.ts",
		},
	));

	const sentinels = ["PRIV_ART", "PRIV_FAIL_ART", "PRIV_LOOP_ART", "PRIV_CAN_ART", "PRIV_CMD_LOOP", f.root, f.cwd, f.home, dir];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			// Single-attempt cmd_json_ok: stdout JSON artifact path and :12 redacted before 4,000-char cap
			const okRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_json_ok`);
			assert.equal(okRes.status, 200);
			const okText = await okRes.text();
			scanSentinels(okText, sentinels, "cmd_json_ok");
			const okBody = JSON.parse(okText);
			const okExcerpt: string = okBody.attempts[0].command.stdout_excerpt;
			assert.match(okExcerpt, /\{"artifacts":\[\{"path":"\[redacted-path\]","description":"cmd"\}\]\} ref \[redacted-path\]:12\n/);
			assert.ok(Array.from(okExcerpt).length <= 4000);
			assert.match(okExcerpt, /… \[truncated, \d+ characters? omitted\]$/);

			// Single-attempt cmd_json_fail: stderr, stdout, spawn_error, termination_error all redacted
			const failRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_json_fail`);
			assert.equal(failRes.status, 200);
			const failText = await failRes.text();
			scanSentinels(failText, sentinels, "cmd_json_fail");
			const failBody = JSON.parse(failText);
			assert.equal(failBody.attempts[0].command.stdout_excerpt, "partial [redacted-path]:5");
			assert.equal(failBody.attempts[0].command.stderr_excerpt, "Compile error in [redacted-path] and [redacted-path]:12");
			assert.equal(failBody.attempts[0].command.spawn_error, "Spawn failed near [redacted-path]");
			assert.equal(failBody.attempts[0].command.termination_error, "Kill failed near [redacted-path]");

			// Multi-attempt build: error_message, disposition_reason, causes, and disposition command_evidence redacted
			const buildRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=build`);
			assert.equal(buildRes.status, 200);
			const buildText = await buildRes.text();
			scanSentinels(buildText, sentinels, "multi-attempt build");
			const buildBody = JSON.parse(buildText);
			assert.equal(buildBody.attempts.length, 3);
			assert.equal(buildBody.attempts[0].attempt_number, 3);
			assert.equal(buildBody.attempts[0].error_message, "Execution failed at [redacted-path]:99");
			assert.equal(buildBody.attempts[1].attempt_number, 2);
			assert.equal(buildBody.attempts[1].disposition_reason, "Blocked on [redacted-path] and [redacted-path]:44");
			assert.equal(buildBody.attempts[1].causes.items[0].node_id, "[redacted-path]");
			assert.equal(buildBody.attempts[1].causes.items[0].reason, "Broken in [redacted-path]");
			assert.equal(buildBody.attempts[1].causes.items[0].check.name, "check [redacted-path]");
			assert.equal(buildBody.attempts[2].attempt_number, 1);
			assert.equal(buildBody.attempts[2].evidence, "available");

			// Multi-attempt cmd_loop: disposition command_evidence and reason redacted
			const cmdLoopRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_loop`);
			assert.equal(cmdLoopRes.status, 200);
			const cmdLoopText = await cmdLoopRes.text();
			scanSentinels(cmdLoopText, sentinels, "multi-attempt cmd_loop");
			const cmdLoopBody = JSON.parse(cmdLoopText);
			assert.equal(cmdLoopBody.attempts.length, 2);
			assert.equal(cmdLoopBody.attempts[0].disposition_reason, "Termination unverified near [redacted-path]");
			assert.equal(cmdLoopBody.attempts[0].command.stdout_excerpt, '{"artifacts":[{"path":"[redacted-path]"}]}');
			assert.equal(cmdLoopBody.attempts[0].command.stderr_excerpt, "stderr [redacted-path]:12");
			assert.equal(cmdLoopBody.attempts[0].command.spawn_error, "spawn [redacted-path]");
			assert.equal(cmdLoopBody.attempts[0].command.termination_error, "term [redacted-path]");
			assert.equal(cmdLoopBody.attempts[1].command.stdout_excerpt, '{"artifacts":[{"path":"[redacted-path]"}]}');

			// Multi-attempt cancel_loop: cancelled disposition_reason redacted
			const cancelRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cancel_loop`);
			assert.equal(cancelRes.status, 200);
			const cancelText = await cancelRes.text();
			scanSentinels(cancelText, sentinels, "multi-attempt cancel_loop");
			const cancelBody = JSON.parse(cancelText);
			assert.equal(cancelBody.attempts[0].disposition_reason, "Cancelled while editing [redacted-path]");
		},
	);

	// 5. Timing test (N2): 11 maximal command attempts on /output with 4,000-char excerpts containing real artifact tokens
	const fPerf = serviceFixture(t, ["builder", "reviewer"]);
	const statePerf = join(fPerf.root, "factories.sqlite");
	const coordPerf = join(fPerf.root, "factory-coordination.sqlite");
	const envPerf = { PATH: join(fPerf.root, "bin"), PI_BOOTSTRAP_STATE_DIR: fPerf.stateDir };
	const opsPerf = factoryOperations(statePerf, fPerf.service, { coordinationPath: coordPerf });
	const draftPerf: GenerateRequest = {
		project_cwd: fPerf.cwd,
		topology: "graph",
		task: "PRIVATE_PERF11_PROMPT",
		agents: [
			{
				node_id: "build",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: fPerf.cwd,
				sub_task: "PRIVATE_PERF11_B",
			},
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["build"],
				sub_task: "PRIVATE_PERF11_R",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 10, on_exhausted: "needs_attention" },
			},
		],
	};
	const facPerf = opsPerf({ action: "publish", name: "t05-perf11-fac", draft: draftPerf, sessionModel });
	const authPerf = createManagerAuthority({ pi_session_id: "sess-t05-perf11" });
	opsPerf({ action: "resume", factory_id: facPerf.factory_id, authority: authPerf });
	opsPerf({ action: "submit", factory_id: facPerf.factory_id, authority: authPerf, reference: "t05-perf11-ref", brief: "PRIVATE_PERF11_BRIEF" });
	const launchedPerf = await opsPerf({ action: "launch", factory_id: facPerf.factory_id, authority: authPerf });
	revokeManagerAuthority(authPerf);

	const dirPerf = launchedPerf.manifest.session_dir;
	const pBuild = launchedPerf.manifest.pane_manifest.find(e => e.node_id === "build")!;
	const pRev = launchedPerf.manifest.pane_manifest.find(e => e.node_id === "review")!;
	const pBuildCfg = readJson<WorkerConfig>(join(dirPerf, `${pBuild.instance_id}.config.json`));
	const pRevCfg = readJson<WorkerConfig>(join(dirPerf, `${pRev.instance_id}.config.json`));
	const prefix = "src/shared/PRIVPFX/aaaaaaaa";

	for (let n = 1; n <= 11; n++) {
		const bId = `${pBuild.instance_id}.${n}`;
		const rId = `${pRev.instance_id}.${n}`;
		const ts = `2026-11-28T14:00:${String(n).padStart(2, "0")}.000Z`;
		const unit = `${prefix}${n}_0.ts ${prefix}${n}_1.ts:12 @${prefix}${n}_2.ts# "${prefix}${n}_3.ts" ${prefix}${n}_0.js ${prefix}${n}_ `;
		const excerpt = unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
		const rec = completionRecord(
			{ ...pBuildCfg, attempt_id: bId },
			{
				agent_name: pBuild.persona_name,
				node_id: "build",
				status: n === 11 ? "success" : "partial",
				summary: `Perf summary ${n}`,
				detail: `Perf detail ${n}`,
				artifacts: Array.from({ length: 20 }, (_, i) => ({
					type: "file",
					path: `${prefix}${n}_${i}.ts`,
					description: `Artifact ${n}-${i}`,
				})),
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: fPerf.cwd,
					exit_code: n === 11 ? 0 : 1,
					signal: null,
					started_at: ts,
					finished_at: ts,
					duration_ms: 100,
					stdout_bytes: 4000,
					stderr_bytes: 4000,
					stdout_excerpt: excerpt,
					stderr_excerpt: excerpt,
				},
			},
			"sent",
			ts,
		);
		writeFileSync(resultPath(dirPerf, bId), JSON.stringify(rec));
		if (n >= 2) {
			atomicJson(join(dirPerf, `${pRev.instance_id}.${n}.revision.json`), {
				version: 1,
				run_id: launchedPerf.task_id,
				reviewer: pRev.instance_id,
				attempt: n,
			});
			atomicJson(handoffClaimPath(dirPerf, bId, pRev.instance_id), {
				version: 1,
				handoff_id: `hp-fb-${n}`,
				state: "accepted",
				run_id: launchedPerf.task_id,
				source: { node_id: "review", attempt_id: `${pRev.instance_id}.${n - 1}`, instance_id: pRev.instance_id, session_id: "sr" },
				destination: { node_id: "build", attempt_id: bId, instance_id: pBuild.instance_id },
				input_digest: "0".repeat(64),
				offer: "matched",
				accepted_at: ts,
			});
		}
		atomicJson(resultPath(dirPerf, rId), completionRecord(
			{ ...pRevCfg, attempt_id: rId },
			{ agent_name: pRev.persona_name, node_id: "review", status: "success", summary: `R${n}`, outputs: { verdict: n === 11 ? "approve" : "revise" } },
			"sent",
			ts,
		));
		atomicJson(handoffClaimPath(dirPerf, rId, pBuild.instance_id), {
			version: 1,
			handoff_id: `hp-r-${n}`,
			state: "accepted",
			run_id: launchedPerf.task_id,
			source: { node_id: "build", attempt_id: bId, instance_id: pBuild.instance_id, session_id: "sb" },
			destination: { node_id: "review", attempt_id: rId, instance_id: pRev.instance_id },
			input_digest: inputDigest(rec.result),
			offer: "matched",
			accepted_at: ts,
		});
	}

	await verifyReadOnlyViewer(
		{ stateDirs: fPerf.root, viewerOptions: { statePath: statePerf, coordinationPath: coordPerf, env: envPerf, home: fPerf.home } },
		async viewer => {
			// Verify real attempts are returned and redaction is active BEFORE timing
			const checkRes = await fetch(`${viewer.url}/api/factories/${facPerf.factory_id}/output?node=build`);
			assert.equal(checkRes.status, 200);
			const checkText = await checkRes.text();
			const checkBody = JSON.parse(checkText);
			assert.notEqual(checkBody.evidence, "unavailable", `Unexpected unavailable output: ${checkBody.explanation ?? checkText}`);
			assert.ok(Array.isArray(checkBody.attempts) && checkBody.attempts.length > 1, `Expected >1 attempts, got ${checkBody.attempts?.length}`);
			assert.equal(checkBody.attempts[0].attempt_number, 11);
			scanSentinels(checkText, ["PRIVATE_", `${prefix}11_0.ts`, `${prefix}11_1.ts`, `${prefix}11_2.ts`, `${prefix}11_3.ts`], "perf11");
			for (const att of checkBody.attempts as Array<Record<string, any>>) {
				const ownRe = new RegExp(`aaaaaaaa${att.attempt_number}_\\d+\\.ts(?:$|[^A-Za-z0-9_])`);
				for (const field of ["stdout_excerpt", "stderr_excerpt"] as const) {
					const val = att.command?.[field];
					if (typeof val === "string") {
						assert.doesNotMatch(val, ownRe, `Attempt ${att.attempt_number} leaked own artifact in ${field}`);
					}
				}
			}
			const newestOut: string = checkBody.attempts[0].command.stdout_excerpt;
			assert.match(newestOut, /\[redacted-path\] \[redacted-path\]:12 @\[redacted-path\]# "\[redacted-path\]" src\/shared\/PRIVPFX\/aaaaaaaa11_0\.js/);

			const t0 = performance.now();
			const res = await fetch(`${viewer.url}/api/factories/${facPerf.factory_id}/output?node=build`);
			const elapsedMs = performance.now() - t0;
			assert.equal(res.status, 200);
			const text = await res.text();
			const body = JSON.parse(text);
			assert.notEqual(body.evidence, "unavailable");
			assert.ok(Array.isArray(body.attempts) && body.attempts.length > 1);
			assert.ok(elapsedMs < 1000, `11 maximal command attempts with 4000-char artifact-laden excerpts took ${elapsedMs.toFixed(0)}ms`);
			assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024);
		},
	);
});

test("Fix round 2 (ticket 05 B1 & N6): runner-clipped command excerpts drop trailing partial path without over-trimming prose, and command signal redacts artifacts", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin"), PI_BOOTSTRAP_STATE_DIR: f.stateDir };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });

	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "PRIVATE_T05_R2_PROMPT",
		agents: [
			{
				node_id: "cmd_clip_json",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_CLIP_JSON",
			},
			{
				node_id: "cmd_clip_prefix",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_CLIP_PREFIX",
			},
			{
				node_id: "cmd_clip_slash_prose",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_CLIP_SLASH_PROSE",
			},
			{
				node_id: "cmd_clip_long",
				kind: "command",
				command: process.execPath,
				args: ["-e", "0"],
				working_directory: f.cwd,
				sub_task: "PRIVATE_CLIP_LONG",
			},
		],
	};
	const fac = ops({ action: "publish", name: "t05-r2-fac", draft, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-t05-r2" });
	ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
	ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t05-r2-ref", brief: "PRIVATE_T05_R2_BRIEF" });
	const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
	revokeManagerAuthority(auth);

	const dir = launched.manifest.session_dir;
	const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
	const cfgOf = (e: ReturnType<typeof entryOf>) => readJson<WorkerConfig>(join(dir, `${e.instance_id}.config.json`));

	// 1. Reviewer end-to-end case: 980 filler chars + JSON artifact path clipped at `…`, plus stderr clip and N6 signal
	const jsonEntry = entryOf("cmd_clip_json");
	atomicJson(
		resultPath(dir, jsonEntry.instance_id),
		completionRecord(
			cfgOf(jsonEntry),
			{
				agent_name: jsonEntry.persona_name,
				node_id: "cmd_clip_json",
				status: "failure",
				summary: "Clipped command",
				detail: "Runner clipped stdout and stderr",
				artifacts: [{ type: "file", path: "src/PRIV_ART.ts", action: "created", description: "Clipped artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: f.cwd,
					exit_code: 1,
					signal: "src/PRIV_ART.ts",
					started_at: "2026-11-28T15:00:00.000Z",
					finished_at: "2026-11-28T15:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 2048,
					stderr_bytes: 2048,
					stdout_excerpt: `${"Y".repeat(980)}{"artifacts":[{"path":"src/PRIV_ART…`,
					stderr_excerpt: `${"E".repeat(980)} src/PRIV_ART…`,
				},
			},
			"not_required",
			"2026-11-28T15:00:01.000Z",
		),
	);

	// 2. Clip after `src/app/` prefix
	const prefixEntry = entryOf("cmd_clip_prefix");
	atomicJson(
		resultPath(dir, prefixEntry.instance_id),
		completionRecord(
			cfgOf(prefixEntry),
			{
				agent_name: prefixEntry.persona_name,
				node_id: "cmd_clip_prefix",
				status: "failure",
				summary: "Prefix clip",
				detail: "Clipped after src/app/",
				artifacts: [{ type: "file", path: "src/app/PRIV_APP_ART.ts", action: "modified", description: "App artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: f.cwd,
					exit_code: 1,
					signal: "SIGTERM",
					started_at: "2026-11-28T15:00:00.000Z",
					finished_at: "2026-11-28T15:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 1200,
					stderr_bytes: 0,
					stdout_excerpt: "prefix src/app/PRIV_APP_ART…",
					stderr_excerpt: "",
				},
			},
			"not_required",
			"2026-11-28T15:00:01.000Z",
		),
	);

	// 3. Clip right after `/` (raw ends `src/…`) and ordinary prose clip (`…`)
	const slashProseEntry = entryOf("cmd_clip_slash_prose");
	atomicJson(
		resultPath(dir, slashProseEntry.instance_id),
		completionRecord(
			cfgOf(slashProseEntry),
			{
				agent_name: slashProseEntry.persona_name,
				node_id: "cmd_clip_slash_prose",
				status: "success",
				summary: "Slash and prose clips",
				detail: "Slash clip and ordinary prose clip",
				artifacts: [{ type: "file", path: "src/PRIV_SLASH.ts", action: "created", description: "Slash artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: f.cwd,
					exit_code: 0,
					signal: null,
					started_at: "2026-11-28T15:00:00.000Z",
					finished_at: "2026-11-28T15:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 1024,
					stderr_bytes: 1024,
					stdout_excerpt: "prefix src/…",
					stderr_excerpt: "Keep this ordinary prose clippedword…",
				},
			},
			"not_required",
			"2026-11-28T15:00:01.000Z",
		),
	);

	// 4. Long (>4000 chars) excerpt ending with ` src/PRIV_LONG…` to verify exact 4,000-cap marker arithmetic
	const longEntry = entryOf("cmd_clip_long");
	atomicJson(
		resultPath(dir, longEntry.instance_id),
		completionRecord(
			cfgOf(longEntry),
			{
				agent_name: longEntry.persona_name,
				node_id: "cmd_clip_long",
				status: "success",
				summary: "Long clip",
				detail: "Over 4000 chars ending in partial path clip",
				artifacts: [{ type: "file", path: "src/PRIV_LONG.ts", action: "created", description: "Long artifact" }],
				command_evidence: {
					version: 1,
					command: process.execPath,
					args: ["-e", "0"],
					working_directory: f.cwd,
					exit_code: 0,
					signal: null,
					started_at: "2026-11-28T15:00:00.000Z",
					finished_at: "2026-11-28T15:00:01.000Z",
					duration_ms: 1000,
					stdout_bytes: 4500,
					stderr_bytes: 0,
					stdout_excerpt: `${"A".repeat(4200)} src/PRIV_LONG…`,
					stderr_excerpt: "",
				},
			},
			"not_required",
			"2026-11-28T15:00:01.000Z",
		),
	);

	const sentinels = ["PRIV_ART", "PRIV_APP_ART", "PRIV_SLASH", "PRIV_LONG", "PRIVATE_T05_R2", f.root, f.cwd, f.home, dir];
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			const jsonRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_clip_json`);
			assert.equal(jsonRes.status, 200);
			const jsonText = await jsonRes.text();
			scanSentinels(jsonText, sentinels, "cmd_clip_json");
			const jsonBody = JSON.parse(jsonText);
			assert.equal(jsonBody.attempts[0].command.stdout_excerpt, `${"Y".repeat(980)}{"artifacts":[{"path":"…`);
			assert.equal(jsonBody.attempts[0].command.stderr_excerpt, `${"E".repeat(980)} …`);
			assert.equal(jsonBody.attempts[0].command.signal, "[redacted-path]");

			const prefixRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_clip_prefix`);
			assert.equal(prefixRes.status, 200);
			const prefixText = await prefixRes.text();
			scanSentinels(prefixText, sentinels, "cmd_clip_prefix");
			const prefixBody = JSON.parse(prefixText);
			assert.equal(prefixBody.attempts[0].command.stdout_excerpt, "prefix …");
			assert.equal(prefixBody.attempts[0].command.signal, "SIGTERM");

			const slashRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_clip_slash_prose`);
			assert.equal(slashRes.status, 200);
			const slashText = await slashRes.text();
			scanSentinels(slashText, sentinels, "cmd_clip_slash_prose");
			const slashBody = JSON.parse(slashText);
			assert.equal(slashBody.attempts[0].command.stdout_excerpt, "prefix …");
			const proseOut: string = slashBody.attempts[0].command.stderr_excerpt;
			assert.ok(proseOut.startsWith("Keep this ordinary prose "), `Unexpected prose over-trim: ${proseOut}`);
			assert.ok(proseOut.endsWith("…"));

			const longRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_clip_long`);
			assert.equal(longRes.status, 200);
			const longText = await longRes.text();
			scanSentinels(longText, sentinels, "cmd_clip_long");
			const longBody = JSON.parse(longText);
			const longOut: string = longBody.attempts[0].command.stdout_excerpt;
			assert.equal(Array.from(longOut).length, 4000);
			const markerMatch = /… \[truncated, (\d+) characters? omitted\]$/.exec(longOut);
			assert.ok(markerMatch, `Expected counted truncation marker in ${longOut.slice(-60)}`);
			const kept = Array.from(longOut.slice(0, markerMatch.index)).length;
			const omitted = Number(markerMatch[1]);
			assert.equal(kept + omitted, 4202);
		},
	);

	// 64 KB budget arithmetic on a runner-clipped excerpt
	const budgetBody = enforceOutputResponseBudget(
		{
			factory_id: "f-clip",
			node_id: "cmd_clip_json",
			evidence: "available",
			total_attempts: 1,
			omitted_attempts: 0,
			attempts: [
				{
					attempt_id: "a.1",
					attempt_number: 1,
					max_attempts: 1,
					status: "succeeded",
					status_text: "Succeeded",
					evidence: "available",
					summary: "Clipped budget check",
					command: {
						exit_code: 0,
						signal: null,
						duration_ms: 10,
						stdout_bytes: 2048,
						stderr_bytes: 0,
						stdout_excerpt: `${"Y".repeat(980)}{"artifacts":[{"path":"…`,
					},
				},
			],
		},
		450,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(budgetBody), "utf8") <= 450);
	const trimmedClipped = (budgetBody.attempts as any[])[0].command.stdout_excerpt as string;
	const budgetMarker = /… \[truncated, (\d+) characters? omitted\]$/.exec(trimmedClipped);
	assert.ok(budgetMarker, `Expected counted marker after budget trim: ${trimmedClipped}`);
	assert.equal(
		Array.from(trimmedClipped.slice(0, budgetMarker.index)).length + Number(budgetMarker[1]),
		`${"Y".repeat(980)}{"artifacts":[{"path":"…`.length,
	);
});
