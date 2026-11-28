import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { enforceOutputResponseBudget, nodeOutputSnapshot } from "../factory/viewer/output.ts";
import { sanitizeOperatorText, sanitizeOutputText } from "../factory/viewer/sanitize.ts";
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
			assert.equal(doneOut.latest_attempt.evidence, "available");
			assert.equal(doneOut.latest_attempt.status, "succeeded");
			assert.match(doneOut.latest_attempt.summary, /\n/);
			assert.match(doneOut.latest_attempt.summary, /\[redacted-path\]/);
			assert.ok(doneOut.latest_attempt.summary.includes("`[redacted-path]`"));
			assert.ok(doneOut.latest_attempt.summary.includes("**[redacted-path]**"));
			assert.match(doneOut.latest_attempt.summary, /\[ctrl\]/);
			assert.equal(
				doneOut.latest_attempt.detail,
				"Line 1 in [redacted-path]\nLine 2 in [redacted-path]\nLine 3 [redacted-path] [ctrl] alert <script>alert(1)</script>\nChanged `[redacted-path]` and **[redacted-path]**, <p>[redacted-path]</p>, a,[redacted-path]\nSpoof [truncated-marker]",
			);

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

			// /output for cmd_node returns scrubbed stdout/stderr excerpts without leaking command/args/cwd/metrics
			const cmdRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cmd_node`);
			assert.equal(cmdRes.status, 200);
			const cmdText = await cmdRes.text();
			scanSentinels(cmdText, [...sentinels, "/etc/probe_gen/cmd.err"], "output cmd_node");
			const cmdOut = JSON.parse(cmdText);
			assert.equal(cmdOut.latest_attempt.command.exit_code, 0);
			assert.equal(cmdOut.latest_attempt.command.signal, null);
			assert.equal(cmdOut.latest_attempt.command.stdout_excerpt, "PUBLIC_CMD_STDOUT_EXCERPT\nfrom [redacted-path] [ctrl]");
			assert.equal(cmdOut.latest_attempt.command.stderr_excerpt, "PUBLIC_CMD_STDERR_EXCERPT\nwarn [redacted-path]");
			assert.equal("command" in cmdOut.latest_attempt.command, false);
			assert.equal("args" in cmdOut.latest_attempt.command, false);
			assert.equal("working_directory" in cmdOut.latest_attempt.command, false);
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
				assert.equal(out.latest_attempt.evidence, "unavailable", nodeId);
				assert.equal(out.latest_attempt.absence, "evidence unavailable", nodeId);
				assert.equal(out.latest_attempt.status, liveNode.status, `${nodeId} status must match Live`);
				assert.equal(out.latest_attempt.status_text, liveNode.status_text, `${nodeId} status_text must match Live`);
				if (nodeId === "err_node") {
					assert.equal(out.latest_attempt.error_message, "PUBLIC_ERR_JSON_MSG in [redacted-path] [ctrl]");
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
			const richAtt = richOut.latest_attempt;
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
			assert.equal(cmdOut.latest_attempt.status, "failed");
			assert.equal(cmdOut.latest_attempt.command.exit_code, 2);
			assert.equal(cmdOut.latest_attempt.command.signal, "SIGTERM");
			assert.ok(Array.from(cmdOut.latest_attempt.command.stdout_excerpt).length <= 4000);
			assert.match(cmdOut.latest_attempt.command.stdout_excerpt, /^STDOUT_HEAD \[redacted-path\]\n/);
			assert.match(cmdOut.latest_attempt.command.stdout_excerpt, /\[truncated, \d+ characters? omitted\]$/);
			assert.ok(Array.from(cmdOut.latest_attempt.command.stderr_excerpt).length <= 4000);
			assert.match(cmdOut.latest_attempt.command.stderr_excerpt, /^STDERR_HEAD \[redacted-path\] \[ctrl\]\n/);
			assert.match(cmdOut.latest_attempt.command.stderr_excerpt, /\[truncated, \d+ characters? omitted\]$/);

			// Dispositions: blocked, skipped, cancelled
			const blkRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=blk_node`);
			assert.equal(blkRes.status, 200);
			const blkText = await blkRes.text();
			scanSentinels(blkText, sentinels, "output blk_node");
			const blkOut = JSON.parse(blkText);
			assert.equal(blkOut.latest_attempt.evidence, "not applicable");
			assert.equal(blkOut.latest_attempt.status, "blocked");
			assert.equal(blkOut.latest_attempt.disposition_reason, "Blocked due to upstream failure in [redacted-path]");
			assert.equal(blkOut.latest_attempt.causes.items[0].reason, "Failed at [redacted-path]");

			const skipOut = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=skip_node`)).json() as any;
			assert.equal(skipOut.latest_attempt.status, "skipped");
			assert.equal(skipOut.latest_attempt.disposition_reason, "Skipped optional step under [redacted-path]");

			const canOut = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=cancel_node`)).json() as any;
			assert.equal(canOut.latest_attempt.status, "cancelled");
			assert.equal(canOut.latest_attempt.disposition_reason, "Cancelled by operator in [redacted-path]");

			// huge_node: 64 KB response budget
			const hugeRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=huge_node`);
			assert.equal(hugeRes.status, 200);
			const hugeText = await hugeRes.text();
			scanSentinels(hugeText, sentinels, "output huge_node");
			assert.ok(Buffer.byteLength(hugeText, "utf8") <= 64 * 1024, `expected <= 65536 bytes, got ${Buffer.byteLength(hugeText, "utf8")}`);
			const hugeOut = JSON.parse(hugeText);
			assert.ok(hugeOut.latest_attempt.outputs_text.includes("truncated") || hugeOut.latest_attempt.artifacts.omitted_count > 0);

			// N-e: handoff_bad matches Live Graph status ("needs_attention" / "Uncertain")
			const liveData = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
			const liveHBad = liveData.graph.nodes.find((n: any) => n.id === "handoff_bad");
			const outHBad = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=handoff_bad`)).json() as any;
			assert.equal(liveHBad.status, "needs_attention");
			assert.equal(outHBad.latest_attempt.status, "needs_attention");
			assert.equal(outHBad.latest_attempt.status_text, "Uncertain");
			assert.equal(outHBad.latest_attempt.evidence, "unavailable");
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
			assert.equal(out.latest_attempt.status, "blocked");
			assert.equal(out.latest_attempt.status_text, "Blocked");
			assert.equal(out.latest_attempt.evidence, "not applicable");
			assert.equal(out.latest_attempt.absence, "not applicable");
			assert.ok(typeof out.latest_attempt.disposition_reason === "string" && out.latest_attempt.disposition_reason.length > 0);
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
			assert.equal("completed_at" in artOut.latest_attempt, false, "invalid completed_at must be omitted");
			assert.match(artOut.latest_attempt.summary, /\[redacted-path\]/);
			assert.match(artOut.latest_attempt.detail, /\[redacted-path\]/);
			assert.match(artOut.latest_attempt.artifacts.items[0].description, /\[redacted-path\]/);
			assert.match(artOut.latest_attempt.outputs_text, /"public_rel": "src\/PUBLIC_REL_OUT\.ts"/);

			// deep_node: 200 OK with summary, detail, verification, outputs_text
			const deepRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=deep_node`);
			assert.equal(deepRes.status, 200);
			const deepOut = await deepRes.json() as any;
			assert.equal(deepOut.latest_attempt.evidence, "available");
			assert.equal(deepOut.latest_attempt.summary, "Deep summary ok");
			assert.equal(deepOut.latest_attempt.detail, "Deep detail ok");
			assert.equal(deepOut.latest_attempt.verification.items.length, 1);
			assert.equal(typeof deepOut.latest_attempt.outputs_text, "string");

			// disp_hostile: causes validated/scrubbed, invalid recorded_at omitted
			const dispRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=disp_hostile`);
			assert.equal(dispRes.status, 200);
			const dispText = await dispRes.text();
			scanSentinels(dispText, sentinels, "r1 disp_hostile");
			const dispOut = JSON.parse(dispText);
			assert.equal("recorded_at" in dispOut.latest_attempt, false, "invalid recorded_at must be omitted");
			assert.equal(dispOut.latest_attempt.causes.items[0].state, "needs_attention");
			assert.equal(dispOut.latest_attempt.causes.items[0].check.evidence, "unverified");

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
			const vItem = itemOut.latest_attempt.verification.items[0];
			const vTotalCp = Array.from(
				`${vItem.check_id}${vItem.result}${vItem.applicability}${vItem.scope_kind}${vItem.completed_at ?? ""}${vItem.reason ?? ""}`,
			).length;
			assert.ok(vTotalCp <= 500, `verification item total code points ${vTotalCp} exceeded 500`);
			const aItem = itemOut.latest_attempt.artifacts.items[0];
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

	// N3: Corrupt build attempt 2 result and verify /output masks attempt_id and attempt_number to 1 like /live
	writeFileSync(resultPath(dir2, `${be.instance_id}.2`), "{corrupt");

	await verifyReadOnlyViewer(
		{ stateDirs: fLoop.root, viewerOptions: { statePath: statePath2, coordinationPath: coordinationPath2, env: viewerEnv2, home: fLoop.home } },
		async viewer => {
			const live = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/live`)).json() as any;
			const liveBuild = live.graph.nodes.find((n: any) => n.id === "build");
			const liveDeploy = live.graph.nodes.find((n: any) => n.id === "deploy");

			const outBuild = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=build`)).json() as any;
			assert.equal(outBuild.latest_attempt.evidence, "unavailable");
			assert.equal(outBuild.latest_attempt.attempt_number, liveBuild.current_attempt.attempt_number);
			assert.equal(outBuild.latest_attempt.attempt_number, 1);
			assert.equal(typeof outBuild.latest_attempt.attempt_id, "object");
			assert.equal(outBuild.latest_attempt.attempt_id.absence, "evidence unavailable");

			const outDeploy = await (await fetch(`${viewer.url}/api/factories/${fac2.factory_id}/output?node=deploy`)).json() as any;
			assert.equal(liveDeploy.status, "blocked");
			assert.equal(outDeploy.latest_attempt.status, liveDeploy.status);
			assert.equal(outDeploy.latest_attempt.status_text, liveDeploy.status_text);
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
		450,
	);
	assert.ok(Buffer.byteLength(JSON.stringify(overBudget), "utf8") <= 450);
	assert.equal(overBudget.evidence, "unavailable");
	assert.equal((overBudget.latest_attempt as any).absence, "evidence unavailable");
});
