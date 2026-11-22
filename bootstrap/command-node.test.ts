import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryOperations, createManagerAuthority, revokeManagerAuthority } from "../factory/operations.ts";
import { planDecisions, validateGraphLimits } from "./decisions.ts";
import { formatPlan } from "./reporting.ts";
import { model, serviceFixture } from "./test-support/chain-fixture.ts";

test("Slice 1: command node dry-run planning, zero-persona plan, fingerprint, factory publish/inspect", t => {
	const f = serviceFixture(t, [], { independentStateRoots: true });
	const subDir = join(f.cwd, "scripts");
	mkdirSync(subDir, { recursive: true });

	// Pure command-node plan needs no personas, no models, no thinking, no skills.
	const commandOnlyPlan = f.service.plan({
		topology: "graph",
		task: "Command-only graph",
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "merge",
				command: process.execPath,
				args: ["-e", "console.log(JSON.stringify({ ok: true }))"],
				working_directory: "scripts",
				sub_task: "Run deterministic check",
			},
		],
	});

	assert.equal(commandOnlyPlan.agents.length, 1);
	const cmdNode = commandOnlyPlan.agents[0];
	assert.equal(cmdNode.kind, "command");
	assert.equal(cmdNode.node_id, "merge");
	assert.equal(cmdNode.command, process.execPath);
	assert.deepEqual(cmdNode.args, ["-e", "console.log(JSON.stringify({ ok: true }))"]);
	assert.equal(cmdNode.working_directory, realpathSync(subDir));
	// Agent-only fields must be absent on command nodes in plan preview
	for (const key of ["persona_name", "persona_file", "model", "thinking", "tools", "extensions", "allowed_skills"] as const) {
		assert.equal((cmdNode as Record<string, unknown>)[key], undefined, `expected ${key} omitted`);
	}

	const rendered = formatPlan(commandOnlyPlan);
	assert.match(rendered, /command/i);
	assert.match(rendered, /working_directory/);
	assert.doesNotMatch(rendered, /allowed skills:|thinking /);

	// Defaulted working_directory & args keep fingerprint equivalent to explicit defaults
	const f2 = serviceFixture(t, ["first"], { independentStateRoots: true });
	const previewImplicit = f2.service.plan({
		topology: "graph",
		task: "Fingerprint stability",
		project_cwd: f2.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prepare" },
			{ kind: "command", node_id: "build", command: "node", depends_on: ["prep"] },
		],
	} as any, model);
	const previewExplicit = f2.service.plan({
		topology: "graph",
		task: "Fingerprint stability",
		project_cwd: f2.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prepare" },
			{ kind: "command", node_id: "build", command: "node", args: [], working_directory: ".", sub_task: "Run command: node", depends_on: ["prep"] },
		],
	} as any, model);
	assert.equal(previewImplicit.fingerprint, previewExplicit.fingerprint);

	const previewChangedArgs = f2.service.plan({
		topology: "graph",
		task: "Fingerprint stability",
		project_cwd: f2.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prepare" },
			{ kind: "command", node_id: "build", command: "node", args: ["--version"], depends_on: ["prep"] },
		],
	} as any, model);
	assert.notEqual(previewImplicit.fingerprint, previewChangedArgs.fingerprint);

	const previewChangedCmd = f2.service.plan({
		topology: "graph",
		task: "Fingerprint stability",
		project_cwd: f2.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prepare" },
			{ kind: "command", node_id: "build", command: "echo", depends_on: ["prep"] },
		],
	} as any, model);
	assert.notEqual(previewImplicit.fingerprint, previewChangedCmd.fingerprint);

	mkdirSync(join(f2.cwd, "sub"), { recursive: true });
	const previewChangedWd = f2.service.plan({
		topology: "graph",
		task: "Fingerprint stability",
		project_cwd: f2.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prepare" },
			{ kind: "command", node_id: "build", command: "node", working_directory: "sub", depends_on: ["prep"] },
		],
	} as any, model);
	assert.notEqual(previewImplicit.fingerprint, previewChangedWd.fingerprint);

	// Factory publish + inspect summarizes command node without persona/model/thinking/skills
	const factory = factoryOperations(join(f2.root, "factory-state", "factories.sqlite"), f2.service);
	const published = factory({
		action: "publish",
		name: "cmd-factory",
		sessionModel: { ...model, thinkingLevel: "low" },
		draft: {
			topology: "graph",
			task: "Factory command DAG",
			project_cwd: f2.cwd,
			agents: [
				{ node_id: "prep", persona: "first", sub_task: "Prepare" },
				{ kind: "command", node_id: "verify_cmd", command: process.execPath, args: ["-e", "process.exit(0)"], working_directory: "sub", depends_on: ["prep"] },
			],
		},
	});
	const inspected = factory({ action: "inspect", factory_id: published.factory_id });
	assert.equal(inspected.node_policies?.verify_cmd.kind, "command");
	assert.equal((inspected.node_policies?.verify_cmd as any).command, process.execPath);
	assert.deepEqual((inspected.node_policies?.verify_cmd as any).args, ["-e", "process.exit(0)"]);
	assert.equal((inspected.node_policies?.verify_cmd as any).working_directory, realpathSync(join(f2.cwd, "sub")));
	assert.equal((inspected.node_policies?.verify_cmd as any).model, undefined);
	assert.equal((inspected.node_policies?.verify_cmd as any).persona_name, undefined);
});

test("Slice 1 negative guards: planning and factory draft reject invalid command nodes, agent-only settings, command-only on agent, and decisions", t => {
	const f = serviceFixture(t, ["first", "second"], { independentStateRoots: true });
	const factory = factoryOperations(join(f.root, "factory-state", "factories.sqlite"), f.service);
	const outsideDir = mkdirSync(join(f.root, "outside"), { recursive: true }) ?? join(f.root, "outside");
	const symlinkEscape = join(f.cwd, "escape-link");
	symlinkSync(outsideDir, symlinkEscape);
	const regularFile = join(f.cwd, "not-a-dir.txt");
	writeFileSync(regularFile, "hello");

	// Missing node_id on command node
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Missing node_id",
		project_cwd: f.cwd,
		agents: [{ kind: "command", command: "echo" } as any],
	}, model), /node_id/);

	// Missing / blank / NUL command
	for (const badCmd of [undefined, "", "   ", "node\0bad"]) {
		assert.throws(() => f.service.plan({
			topology: "graph",
			task: "Bad command",
			project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "cmd1", ...(badCmd !== undefined ? { command: badCmd } : {}) } as any],
		}, model), /cmd1/i);
	}

	// Invalid args
	for (const badArgs of ["not-array", [123], ["ok", "bad\0arg"]]) {
		assert.throws(() => f.service.plan({
			topology: "graph",
			task: "Bad args",
			project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "cmd2", command: "node", args: badArgs } as any],
		}, model), /cmd2/i);
	}

	// Invalid working_directory (missing dir, regular file, NUL, ../ escape, outside abs, symlink escape)
	for (const badWd of ["", "does-not-exist", "not-a-dir.txt", "sub\0dir", "../outside", outsideDir, tmpdir(), "escape-link"]) {
		assert.throws(() => f.service.plan({
			topology: "graph",
			task: "Bad wd",
			project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "cmd3", command: "node", working_directory: badWd } as any],
		}, model), /cmd3/i);
	}

	// Invalid kind
	assert.throws(() => f.service.plan({
		topology: "graph",
		task: "Bad kind",
		project_cwd: f.cwd,
		agents: [{ kind: "shell", node_id: "cmd4", persona: "first", sub_task: "x" } as any],
	}, model), /cmd4/i);

	// Reject EVERY agent-only setting on a command node, naming both node and setting (via plan AND factory publish)
	const agentOnlyCases: Array<[string, Record<string, unknown>]> = [
		["persona", { persona: "first" }],
		["name", { name: "first" }],
		["model", { model: "openai/gpt-5" }],
		["thinking", { thinking: "low" }],
		["skills", { skills: ["alpha"] }],
		["allowed_skills", { allowed_skills: ["alpha"] }],
		["tools", { tools: ["bash"] }],
		["extensions", { extensions: ["coms.ts"] }],
		["intervention", { intervention: { choices: [{ choice_id: "stop", label: "Stop" }] } }],
		["decision", {
			depends_on: ["upstream"],
			output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "reject"] } } },
			decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "upstream" },
		}],
	];
	for (const [setting, extra] of agentOnlyCases) {
		const cmdEntry = {
			kind: "command",
			node_id: "bad_cmd_node",
			command: process.execPath,
			...extra,
		};
		const agents = setting === "decision"
			? [{ node_id: "upstream", persona: "first", sub_task: "Work" }, cmdEntry]
			: [cmdEntry];
		const req = { topology: "graph" as const, task: `Reject ${setting}`, project_cwd: f.cwd, agents };
		assert.throws(
			() => f.service.plan(req as any, model),
			(err: Error) => err.message.includes("bad_cmd_node") && err.message.includes(setting),
			`plan() must reject ${setting} on command node naming node and setting`,
		);
		assert.throws(
			() => factory({ action: "publish", name: `bad-${setting}`, sessionModel: { ...model, thinkingLevel: "low" }, draft: req }),
			(err: Error) => err.message.includes("bad_cmd_node") && err.message.includes(setting),
			`factory publish must reject ${setting} on command node naming node and setting`,
		);
	}

	// Chain decision on command node also rejected (and planDecisions unit seam rejects it independently)
	assert.throws(() => f.service.plan({
		topology: "chain",
		task: "Chain decision on command",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "build", persona: "first", sub_task: "Build" },
			{
				kind: "command",
				node_id: "gate_cmd",
				command: process.execPath,
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "reject"] } } },
				decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "build" },
			},
		],
	} as any, model), (err: Error) => err.message.includes("gate_cmd") && err.message.includes("decision"));

	const emptyLimits = validateGraphLimits("test", undefined);
	assert.throws(() => planDecisions(
		{
			topology: "graph",
			task: "Direct planDecisions check",
			project_cwd: f.cwd,
			agents: [
				{ node_id: "build", persona: "first", sub_task: "Build" },
				{ kind: "command", node_id: "gate_cmd", command: process.execPath, depends_on: ["build"], decision: { field: "verdict", approve: "approve", reject: "reject", on_reject: "build" } },
			],
		} as any,
		[
			{ node_id: "build", persona: "first", sub_task: "Build", inbound_edges: [] },
			{ kind: "command", node_id: "gate_cmd", persona: "gate_cmd", command: process.execPath, args: [], working_directory: f.cwd, sub_task: "Run", inbound_edges: ["build"] },
		],
		emptyLimits,
		emptyLimits,
	), (err: Error) => err.message.includes("gate_cmd") && err.message.includes("decision"));

	// Reject command-only settings on an agent node, naming node and setting
	for (const [setting, extra] of [
		["command", { command: "echo" }],
		["args", { args: ["hi"] }],
		["working_directory", { working_directory: "." }],
	] as const) {
		const req = {
			topology: "graph" as const,
			task: `Reject ${setting} on agent`,
			project_cwd: f.cwd,
			agents: [{ node_id: "agent_node", persona: "first", sub_task: "Work", ...extra }],
		};
		assert.throws(
			() => f.service.plan(req as any, model),
			(err: Error) => err.message.includes("agent_node") && err.message.includes(setting),
			`plan() must reject ${setting} on agent node naming node and setting`,
		);
		assert.throws(
			() => factory({ action: "publish", name: `bad-agent-${setting}`, sessionModel: { ...model, thinkingLevel: "low" }, draft: req }),
			(err: Error) => err.message.includes("agent_node") && err.message.includes(setting),
			`factory publish must reject ${setting} on agent node naming node and setting`,
		);
	}

	// Factory draft still rejects unrecognized settings
	assert.throws(() => factory({
		action: "publish",
		name: "unknown-key",
		sessionModel: { ...model, thinkingLevel: "low" },
		draft: {
			topology: "graph",
			task: "Unknown key",
			project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "cmd_x", command: "echo", depends_onn: [] }],
		},
	}), /unknown setting "depends_onn"/);
});

import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseCompletion, parseDisposition, readJson, resultPath, type CommandEvidence } from "./session-store.ts";
import { formatAgentStates, formatReportDigest, buildMarkdownReport } from "./reporting.ts";
import { runFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

test("Slice 2: command node consumes task_input/upstream, enforces output_contract & no-shell argv, and failing command blocks dependants", async t => {
	// 1. Happy path: agent producer -> command node -> contract-valid outputs & artifact
	const f = await runFixture(t, {
		topology: "graph",
		task: "Merge upstream artifacts",
		agents: [
			{
				node_id: "producer",
				persona: "first",
				sub_task: "Produce upstream data",
				write_paths: ["src/**"],
			},
			{
				kind: "command",
				node_id: "merge",
				depends_on: ["producer"],
				write_paths: ["out/**"],
				read_paths: ["src/**"],
				output_contract: {
					required_fields: ["merged_count"],
					properties: { merged_count: { type: "integer", required: true } },
					required_artifact_paths: ["out/merged.txt"],
				},
				command: process.execPath,
				args: [
					"-e",
					`
					const fs = require("node:fs");
					const path = require("node:path");
					const taskInput = JSON.parse(fs.readFileSync(process.env.BOOTSTRAP_TASK_INPUT_PATH, "utf8"));
					const upIndex = JSON.parse(fs.readFileSync(process.env.BOOTSTRAP_UPSTREAM_INDEX_PATH, "utf8"));
					const predPaths = JSON.parse(process.env.BOOTSTRAP_PREDECESSOR_PATHS);
					const prodRes = JSON.parse(fs.readFileSync(predPaths.producer, "utf8"));
					fs.mkdirSync(path.join(process.env.BOOTSTRAP_PROJECT_CWD, "out"), { recursive: true });
					const msg = taskInput.assignment.node_id + "|" + upIndex.entries.length + "|" + prodRes.result.outputs.items.join(",") + "|" + process.argv.slice(1).join("|");
					fs.writeFileSync(path.join(process.env.BOOTSTRAP_PROJECT_CWD, "out/merged.txt"), msg);
					console.log(JSON.stringify({ merged_count: prodRes.result.outputs.items.length }));
					`,
					"; touch should-not-run",
					"$(touch pwned)",
				],
			},
			{
				node_id: "consumer",
				persona: "second",
				sub_task: "Consume merge",
				depends_on: ["merge"],
			},
		],
	});

	const producer = f.nodes.get("producer")!;
	const merge = f.nodes.get("merge")!;
	const consumer = f.nodes.get("consumer")!;

	await producer.complete({
		status: "success",
		summary: "Produced items",
		detail: "Produced two items",
		outputs: { items: ["alpha", "beta"] },
	});
	await merge.deliverNotification(producer);
	const afterMerge = f.status();
	assert.equal(
		afterMerge.agents.find(a => a.node_id === "merge")?.execution,
		"succeeded",
		`merge failed: ${JSON.stringify(afterMerge.agents.find(a => a.node_id === "merge"), null, 2)} | errors: ${JSON.stringify(afterMerge.worker_errors)}`,
	);
	// Shell metacharacters must never have been interpreted by a shell
	assert.equal(existsSync(join(f.cwd, "should-not-run")), false);
	assert.equal(existsSync(join(f.cwd, "pwned")), false);
	const mergedFile = readFileSync(join(f.cwd, "out/merged.txt"), "utf8");
	assert.match(mergedFile, /alpha,beta\|; touch should-not-run\|\$\(touch pwned\)/);

	await consumer.deliverNotification(merge);
	await consumer.complete({
		status: "success",
		summary: "Consumed merge",
		detail: "Verified merged output",
	});

	const st = f.status();
	assert.equal(st.outcome.state, "succeeded");
	const mergeAgent = st.agents.find(a => a.node_id === "merge")!;
	assert.equal(mergeAgent.kind, "command");
	assert.equal(mergeAgent.execution, "succeeded");
	assert.equal(mergeAgent.command_evidence?.version, 1);
	assert.equal(mergeAgent.command_evidence?.exit_code, 0);
	assert.equal(mergeAgent.command_evidence?.signal, null);
	assert.equal(mergeAgent.command_evidence?.command, process.execPath);
	const statusText = formatAgentStates(st.agents, st.manifest.topology);
	assert.match(statusText, /merge.*exit=0/);

	const rep = await f.report();
	const mergeEntry = rep.results.find(r => r.node_id === "merge")!;
	assert.equal(mergeEntry.command_evidence?.exit_code, 0);
	assert.match(formatReportDigest(rep.results), /merge.*command=.*exit=0/);
	assert.match(buildMarkdownReport(rep.results), /Exit result:.*0/);

	// 2. Failing command (exit non-zero) blocks downstream agent consumer (even allow_partial)
	const fFail = await runFixture(t, {
		topology: "graph",
		task: "Failing command blocks downstream",
		agents: [
			{
				kind: "command",
				node_id: "failing_cmd",
				command: process.execPath,
				args: ["-e", 'console.error("boom stderr"); process.exit(7);'],
			},
			{
				node_id: "down_req",
				persona: "first",
				sub_task: "Requires success",
				depends_on: ["failing_cmd"],
				dependency_policy: "require_success",
			},
			{
				node_id: "down_partial",
				persona: "second",
				sub_task: "Allows partial",
				depends_on: ["failing_cmd"],
				dependency_policy: "allow_partial",
			},
		],
	});
	const downReq = fFail.nodes.get("down_req")!;
	const downPartial = fFail.nodes.get("down_partial")!;
	await downReq.deliverNotification(fFail.nodes.get("failing_cmd")!);
	await downPartial.deliverNotification(fFail.nodes.get("failing_cmd")!);
	const failStatus = fFail.status();
	assert.equal(failStatus.outcome.state, "failed");
	const cmdFailState = failStatus.agents.find(a => a.node_id === "failing_cmd")!;
	assert.equal(cmdFailState.execution, "failed");
	assert.equal(cmdFailState.command_evidence?.exit_code, 7);
	assert.match(cmdFailState.command_evidence?.stderr_excerpt ?? "", /boom stderr/);
	for (const blockedId of ["down_req", "down_partial"]) {
		const b = failStatus.agents.find(a => a.node_id === blockedId)!;
		assert.equal(b.execution, "blocked", `${blockedId} must be blocked by failing command`);
		assert.equal(b.execution_causes[0]?.node_id, "failing_cmd");
	}

	// 3. Exit 0 but invalid output_contract -> failure with real exit_code 0 recorded in evidence
	const fBadContract = await runFixture(t, {
		topology: "graph",
		task: "Exit 0 violates output contract",
		agents: [
			{
				kind: "command",
				node_id: "bad_contract_cmd",
				command: process.execPath,
				args: ["-e", 'console.log(JSON.stringify({ wrong: true }))'],
				output_contract: {
					required_fields: ["answer"],
					properties: { answer: { type: "string", required: true } },
					required_artifact_paths: ["missing/file.txt"],
				},
			},
			{
				node_id: "after_bad",
				persona: "first",
				sub_task: "After bad contract",
				depends_on: ["bad_contract_cmd"],
			},
		],
	});
	await fBadContract.nodes.get("after_bad")!.deliverNotification(fBadContract.nodes.get("bad_contract_cmd")!);
	const bcStatus = fBadContract.status();
	const bcState = bcStatus.agents.find(a => a.node_id === "bad_contract_cmd")!;
	assert.equal(bcState.execution, "failed");
	assert.equal(bcState.command_evidence?.exit_code, 0);
	assert.equal(bcStatus.agents.find(a => a.node_id === "after_bad")!.execution, "blocked");

	// 4. Spawn error (missing binary) -> failed with spawn_error in command_evidence
	const fSpawnErr = await runFixture(t, {
		topology: "graph",
		task: "Nonexistent executable fails with evidence",
		agents: [
			{
				kind: "command",
				node_id: "missing_bin",
				command: "./definitely-nonexistent-command-binary-12345",
			},
		],
	});
	const seStatus = fSpawnErr.status();
	const seState = seStatus.agents.find(a => a.node_id === "missing_bin")!;
	assert.equal(seState.execution, "failed");
	assert.ok(seState.command_evidence?.spawn_error, "expected spawn_error in command_evidence");
});

test("Slice 2 negative guards: missing/damaged/contradictory command_evidence fails closed", () => {
	const baseIdentity = { run_id: "run-1", node_id: "cmd", persona_name: "cmd", attempt_id: "a1-cmd.1", instance_id: "a1-cmd" };
	const validEvidence: CommandEvidence = {
		version: 1,
		command: process.execPath,
		args: ["-e", "process.exit(0)"],
		working_directory: "/tmp/proj",
		exit_code: 0,
		signal: null,
		started_at: "2026-01-01T00:00:00.000Z",
		finished_at: "2026-01-01T00:00:00.010Z",
		duration_ms: 10,
		stdout_bytes: 0,
		stderr_bytes: 0,
	};
	const cmdExpectation = {
		...baseIdentity,
		kind: "command" as const,
		command: process.execPath,
		args: ["-e", "process.exit(0)"],
		working_directory: "/tmp/proj",
	};

	// Missing command_evidence on command node result
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok" },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /missing command_evidence/i);

	// Unsupported version
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, version: 2 } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /Unsupported command_evidence version/);

	// exit_code != 0 claiming success
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, exit_code: 1 } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /contradicts claimed success/i);

	// signal != null claiming success
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, exit_code: null, signal: "SIGKILL" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /contradicts claimed success/i);

	// Mismatched command / args / working_directory
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, command: "other" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /command mismatch/);

	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, args: ["tampered"] } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /args mismatch/);

	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, working_directory: "/tmp/other" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /working_directory mismatch/);

	// Unexpected command_evidence on agent node result or disposition
	assert.throws(() => parseCompletion({
		version: 2,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: validEvidence },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, { ...baseIdentity, kind: "agent" }), /unexpected command_evidence/i);

	assert.throws(() => parseDisposition({
		version: 1,
		identity: baseIdentity,
		state: "cancelled",
		reason: "stopped",
		causes: [],
		recorded_at: "2026-01-01T00:00:00.020Z",
		command_evidence: validEvidence,
	}, { ...baseIdentity, kind: "agent" }), /unexpected command_evidence/i);
});

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { delay } from "./session-store.ts";

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); }
	catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const rparen = stat.lastIndexOf(")");
			if (rparen !== -1) {
				const state = stat.slice(rparen + 2).split(" ")[0];
				if (state === "Z" || state === "X") return false;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		}
	}
	return true;
}

test("Slice 3 E2E: fan-out -> command-node join merge -> agent consumer, write_paths serialization, edge_states, & require_success guard", async t => {
	const f = await runFixture(t, {
		topology: "graph",
		task: "Fan-out into command-node join merge then consumer",
		agents: [
			{ node_id: "root", persona: "first", sub_task: "Split work" },
			{ node_id: "branch_a", persona: "second", sub_task: "Work A", depends_on: ["root"], write_paths: ["work/**"] },
			{ node_id: "branch_b", persona: "second", sub_task: "Work B", depends_on: ["root"], write_paths: ["work/**"] },
			{
				kind: "command",
				node_id: "merge",
				depends_on: ["branch_a", "branch_b"],
				join_policy: "all_success",
				dependency_policy: "require_success",
				read_paths: ["work/**"],
				write_paths: ["dist/**"],
				output_contract: {
					required_fields: ["combined"],
					properties: { combined: { type: "string", required: true } },
				},
				command: process.execPath,
				args: [
					"-e",
					`
					const fs = require("node:fs");
					const pred = JSON.parse(process.env.BOOTSTRAP_PREDECESSOR_PATHS);
					const a = JSON.parse(fs.readFileSync(pred.branch_a, "utf8")).result.outputs.part;
					const b = JSON.parse(fs.readFileSync(pred.branch_b, "utf8")).result.outputs.part;
					console.log(JSON.stringify({ combined: a + "+" + b }));
					`,
				],
			},
			{
				node_id: "consumer",
				persona: "first",
				sub_task: "Publish summary",
				depends_on: ["merge"],
				read_paths: ["dist/**"],
			},
		],
	});

	const root = f.nodes.get("root")!;
	const branchA = f.nodes.get("branch_a")!;
	const branchB = f.nodes.get("branch_b")!;
	const merge = f.nodes.get("merge")!;
	const consumer = f.nodes.get("consumer")!;

	// Verify write_paths conflict serialized branch_b behind branch_a
	const initialStatus = f.status();
	assert.deepEqual(initialStatus.agents.find(a => a.node_id === "branch_b")?.ownership_wait_for, [branchA.config.instance_id]);
	assert.deepEqual(initialStatus.agents.find(a => a.node_id === "merge")?.edge_states, { branch_a: "pending", branch_b: "pending" });

	await root.complete({ status: "success", summary: "Split complete", detail: "Ready for branches" });
	await branchA.deliverNotification(root);
	await branchB.deliverNotification(root);

	await branchA.complete({ status: "success", summary: "Branch A done", detail: "A", outputs: { part: "A1" } });
	await merge.deliverNotification(branchA);
	const afterOneJoinEdge = f.status();
	assert.deepEqual(afterOneJoinEdge.agents.find(a => a.node_id === "merge")?.edge_states, { branch_a: "fired", branch_b: "pending" });
	assert.equal(afterOneJoinEdge.agents.find(a => a.node_id === "merge")?.execution, "waiting");

	await branchB.complete({ status: "success", summary: "Branch B done", detail: "B", outputs: { part: "B2" } });
	await merge.deliverNotification(branchB);
	const afterMerge = f.status();
	const mergeState = afterMerge.agents.find(a => a.node_id === "merge")!;
	assert.equal(mergeState.execution, "succeeded");
	assert.equal(mergeState.command_evidence?.exit_code, 0);
	assert.deepEqual(mergeState.edge_states, { branch_a: "fired", branch_b: "fired" });

	await consumer.deliverNotification(merge);
	await consumer.complete({ status: "success", summary: "Consumer done", detail: "Consumed A1+B2" });

	const finalStatus = f.status();
	assert.equal(finalStatus.outcome.state, "succeeded");
	const finalReport = await f.report();
	const mergeReport = finalReport.results.find(r => r.node_id === "merge")!;
	assert.deepEqual(mergeReport.outputs, { combined: "A1+B2" });
	assert.equal(mergeReport.command_evidence?.exit_code, 0);
	assert.match(formatAgentStates(finalStatus.agents, finalStatus.manifest.topology), /merge \(command\).*exit=0/);
	assert.match(formatReportDigest(finalReport.results), /merge \(command\): success.*command=.*exit=0/);

	// Negative dependency_policy check: partial predecessor blocks require_success command node without spawning it
	const markerFile = join(f.cwd, "should-never-run.txt");
	const fPartial = await runFixture(t, {
		topology: "graph",
		task: "Partial blocks require_success command node",
		agents: [
			{ node_id: "upstream", persona: "first", sub_task: "Do partial work" },
			{
				kind: "command",
				node_id: "gated_cmd",
				depends_on: ["upstream"],
				dependency_policy: "require_success",
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "ran")`],
			},
		],
	});
	await fPartial.nodes.get("upstream")!.complete({ status: "partial", summary: "Only partial", detail: "Incomplete" });
	await fPartial.nodes.get("gated_cmd")!.deliverNotification(fPartial.nodes.get("upstream")!);
	const pStatus = fPartial.status();
	assert.equal(pStatus.agents.find(a => a.node_id === "gated_cmd")?.execution, "blocked");
	assert.equal(existsSync(markerFile), false, "blocked command node must never execute");
});

test("Slice 3 real subprocess + real Unix Coms sockets + whole process-group cancellation + downstream blocking", async t => {
	const f = serviceFixture(t, ["second"]);
	// Remove pi binary from PATH for a command-only test? Here we have 1 consumer agent via workerFromConfig + real command-runner subprocess!
	// Launch a command root node that ignores SIGTERM and spawns a long-running grandchild in its process group, plus a downstream agent.
	const pidFile = join(f.cwd, "pgid-pids.json");
	const childScript = `
		const fs = require("node:fs");
		const { spawn } = require("node:child_process");
		process.on("SIGTERM", () => {}); // trap SIGTERM to force SIGKILL process-group escalation
		const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: "ignore" });
		fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
		setInterval(() => {}, 1000);
	`;

	// Override pane run to NOT write fake ready.json for command node, and actually spawn command-runner.ts!
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");

	const spawnedRunners: ReturnType<typeof spawn>[] = [];
	t.after(() => {
		for (const p of spawnedRunners) {
			try { process.kill(-p.pid!, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// Plan and launch via BootstrapService with a hook right when launcher .sh is submitted? Easier: use serviceFixture's generated config,
	// or run command-runner directly! Wait: let's test BOTH real subprocess command->command chain AND real cancellation via service.cancel()!
	const run = await f.service.generate({
		topology: "graph",
		task: "Process-group cancel and real Coms command chain",
		cancel_grace_ms: 80,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "trap_cmd",
				command: process.execPath,
				args: ["-e", childScript],
			},
			{
				node_id: "after_cancel",
				persona: "second",
				sub_task: "Depends on cancelled command",
				depends_on: ["trap_cmd"],
			},
		],
	}, model);

	// Kill the fake-ready state isn't right for real subprocess: instead launch a real command-runner.ts subprocess from the generated config!
	const trapEntry = run.pane_manifest.find(e => e.node_id === "trap_cmd")!;
	const trapConfigPath = join(run.session_dir, `${trapEntry.instance_id}.config.json`);
	// Clean the fake ready/registry written by serviceFixture so real command-runner owns ready + socket
	const afterEntry = run.pane_manifest.find(e => e.node_id === "after_cancel")!;
	const afterWorker = workerFromConfig(t, join(run.session_dir, `${afterEntry.instance_id}.config.json`));
	await afterWorker.start();
	rmSync(join(run.session_dir, `${trapEntry.instance_id}.ready.json`), { force: true });
	const runnerProc = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", trapConfigPath], {
		cwd: f.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let runnerOut = "";
	runnerProc.stdout?.on("data", c => { runnerOut += c.toString("utf8"); });
	runnerProc.stderr?.on("data", c => { runnerOut += c.toString("utf8"); });
	spawnedRunners.push(runnerProc);

	// Wait until child + grandchild PIDs are written and runner is actively running
	for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(50);
	assert.equal(existsSync(pidFile), true, "command node must spawn child and write grandchild pids");
	const { child: childPid, grandchild: grandchildPid } = readJson<{ child: number; grandchild: number }>(pidFile);
	assert.equal(pidAlive(childPid), true);
	assert.equal(pidAlive(grandchildPid), true);

	// Now cancel trap_cmd while it is actively running with a SIGTERM-ignoring process + grandchild
	const cancelRes = await f.service.cancel(run.task_id, { agents: ["trap_cmd"], reason: "Abort slow build", grace_ms: 80, cwd: f.cwd });
	assert.ok(cancelRes.cancelled.includes("trap_cmd") || cancelRes.cancelling.some(c => c.node_id === "trap_cmd"));

	// Wait for command-runner to escalate SIGTERM -> SIGKILL on -pgid and finish cleanly
	await new Promise<void>(resolveExit => {
		if (runnerProc.exitCode !== null || runnerProc.signalCode !== null) return resolveExit();
		runnerProc.once("exit", () => resolveExit());
		setTimeout(resolveExit, 5000);
	});

	// Verify BOTH child and grandchild processes are completely gone (whole process group killed!)
	for (let i = 0; i < 20 && (pidAlive(childPid) || pidAlive(grandchildPid)); i++) await delay(25);
	for (let i = 0; i < 60 && f.service.status(run.task_id, f.cwd).agents.find(a => a.node_id === "after_cancel")?.execution !== "blocked"; i++) {
		await delay(50);
	}
	const stDiag = f.service.status(run.task_id, f.cwd);
	assert.equal(pidAlive(childPid), false, `child ${childPid} still alive (runner exit=${runnerProc.exitCode} sig=${runnerProc.signalCode} out=${runnerOut} status=${JSON.stringify(stDiag.agents[0])})`);
	let gcStat = "";
	try { gcStat = readFileSync(`/proc/${grandchildPid}/stat`, "utf8"); } catch { /* gone */ }
	assert.equal(pidAlive(grandchildPid), false, `grandchild ${grandchildPid} still alive (gcStat=${JSON.stringify(gcStat)}, runner exit=${runnerProc.exitCode} sig=${runnerProc.signalCode} out=${runnerOut} status=${JSON.stringify(stDiag.agents[0])})`);

	const stAfterCancel = f.service.status(run.task_id, f.cwd);
	const trapState = stAfterCancel.agents.find(a => a.node_id === "trap_cmd")!;
	assert.equal(trapState.execution, "cancelled", JSON.stringify({ trapState, workerErrors: stAfterCancel.worker_errors, runnerExit: runnerProc.exitCode, runnerOut }));
	assert.equal(trapState.command_evidence?.process_group_killed, true);
	assert.equal(trapState.command_evidence?.process_group_id, childPid);
	assert.match(formatAgentStates(stAfterCancel.agents, stAfterCancel.manifest.topology), /trap_cmd \(command\).*pgid=.*killed/);
	const afterCancelState = stAfterCancel.agents.find(a => a.node_id === "after_cancel")!;
	assert.equal(afterCancelState.execution, "blocked");
	assert.equal(afterCancelState.execution_causes[0]?.node_id, "trap_cmd");
});

test("Slice 3 real Unix Coms subprocess chain (no model/pi needed) & SIGKILL interruption fails closed", async t => {
	// 1. Two command nodes connected via real Unix Coms sockets (NO pi binary, NO persona files)
	const f = serviceFixture(t, []);
	const run = await f.service.generate({
		topology: "graph",
		task: "Command to command via real Unix Coms",
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "step_one",
				output_contract: { required_fields: ["value"], properties: { value: { type: "integer", required: true } } },
				command: process.execPath,
				args: ["-e", "console.log(JSON.stringify({ value: 21 }))"],
			},
			{
				kind: "command",
				node_id: "step_two",
				depends_on: ["step_one"],
				output_contract: { required_fields: ["doubled"], properties: { doubled: { type: "integer", required: true } } },
				command: process.execPath,
				args: [
					"-e",
					`
					const fs = require("node:fs");
					const pred = JSON.parse(process.env.BOOTSTRAP_PREDECESSOR_PATHS);
					const val = JSON.parse(fs.readFileSync(pred.step_one, "utf8")).result.outputs.value;
					console.log(JSON.stringify({ doubled: val * 2 }));
					`,
				],
			},
		],
	});

	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const procs: ReturnType<typeof spawn>[] = [];
	t.after(() => {
		for (const p of procs) try { p.kill("SIGKILL"); } catch { /* ignore */ }
	});

	// Verify generated .sh launcher references command-runner.ts and NOT pi
	for (const entry of run.pane_manifest) {
		const launcher = readFileSync(join(run.session_dir, `${entry.instance_id}.sh`), "utf8");
		assert.match(launcher, /command-runner\.ts/);
		assert.doesNotMatch(launcher, /\/bin\/pi\b|\bpi\b -e/);
		rmSync(join(run.session_dir, `${entry.instance_id}.ready.json`), { force: true });
	}
	// Start step_two first so its real Coms server binds before step_one finishes and wakes it
	const secondEntry = run.pane_manifest.find(e => e.node_id === "step_two")!;
	const firstEntry = run.pane_manifest.find(e => e.node_id === "step_one")!;
	const p2 = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(run.session_dir, `${secondEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	procs.push(p2);
	for (let i = 0; i < 60 && !existsSync(join(run.session_dir, `${secondEntry.instance_id}.ready.json`)); i++) await delay(50);

	const p1 = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(run.session_dir, `${firstEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	procs.push(p1);

	await Promise.all([p1, p2].map(p => new Promise<void>(resolveExit => {
		if (p.exitCode !== null || p.signalCode !== null) return resolveExit();
		p.once("exit", () => resolveExit());
		setTimeout(resolveExit, 8000);
	})));

	const st = f.service.status(run.task_id, f.cwd);
	assert.equal(st.outcome.state, "succeeded");
	const rep = await f.service.report(run.task_id, undefined, true, buildMarkdownReport, f.cwd);
	assert.deepEqual(rep.results.find(r => r.node_id === "step_two")?.outputs, { doubled: 42 });

	// 2. Real SIGKILL interruption on a running command-runner fails closed as needs_attention + factory readOnlyReport never mutates
	const fFactory = serviceFixture(t, ["first"], { independentStateRoots: true });
	const factoryPath = join(fFactory.root, "factory-state", "factories.sqlite");
	const coordPath = join(fFactory.root, "factory-coordination.sqlite");
	const factory = factoryOperations(factoryPath, fFactory.service, { coordinationPath: coordPath });
	const auth = createManagerAuthority({ pi_session_id: "mgr-cmd" });
	t.after(() => revokeManagerAuthority(auth));
	const published = factory({
		action: "publish",
		name: "cmd-sigkill-factory",
		sessionModel: { ...model, thinkingLevel: "low" },
		draft: {
			topology: "graph",
			task: "Managed command node",
			project_cwd: fFactory.cwd,
			agents: [
				{
					kind: "command",
					node_id: "c_only",
					output_contract: { required_fields: ["ok"], properties: { ok: { type: "boolean", required: true } } },
					command: process.execPath,
					args: ["-e", 'const fs=require("node:fs"); const inp=JSON.parse(fs.readFileSync(process.env.BOOTSTRAP_TASK_INPUT_PATH,"utf8")); console.log(JSON.stringify({ ok: inp.brief.submitted_brief === "Run managed" }));'],
				},
			],
		},
	});
	// Read-only inspect must never mutate and summarizes command node cleanly
	const beforeInspect = factory({ action: "inspect", factory_id: published.factory_id });
	assert.equal(beforeInspect.node_policies?.c_only.kind, "command");
	factory({ action: "resume", factory_id: published.factory_id, authority: auth });
	factory({ action: "submit", factory_id: published.factory_id, reference: "run-1", brief: "Run managed", authority: auth });
	const launched = await factory({ action: "launch", factory_id: published.factory_id, authority: auth });
	const managedEntry = launched.manifest.pane_manifest[0];
	rmSync(join(launched.manifest.session_dir, `${managedEntry.instance_id}.ready.json`), { force: true });
	const pManaged = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(launched.manifest.session_dir, `${managedEntry.instance_id}.config.json`)], { cwd: fFactory.cwd, stdio: "ignore" });
	procs.push(pManaged);
	await new Promise<void>(resolveExit => {
		if (pManaged.exitCode !== null || pManaged.signalCode !== null) return resolveExit();
		pManaged.once("exit", () => resolveExit());
		setTimeout(resolveExit, 8000);
	});
	const sessionSnapshot = readdirSync(launched.manifest.session_dir).sort();
	const roReport = fFactory.service.readOnlyReport(launched.task_id, fFactory.cwd);
	assert.equal(roReport.complete, true);
	assert.equal(roReport.outcome.state, "succeeded");
	assert.deepEqual(roReport.results[0].outputs, { ok: true });
	assert.equal(roReport.results[0].command_evidence?.exit_code, 0);
	assert.deepEqual(readdirSync(launched.manifest.session_dir).sort(), sessionSnapshot, "readOnlyReport must never mutate session files");

	// Also test standalone SIGKILL on real running command-runner -> needs_attention (never defaults to succeeded or replays)
	const startedFlag = join(f.cwd, "slow-started.txt");
	const runKill = await f.service.generate({
		topology: "graph",
		task: "SIGKILL interruption test",
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "slow_cmd",
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(startedFlag)}, "started"); setInterval(() => {}, 1000);`],
			},
		],
	});
	const slowEntry = runKill.pane_manifest[0];
	rmSync(join(runKill.session_dir, `${slowEntry.instance_id}.ready.json`), { force: true });
	const pKill = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runKill.session_dir, `${slowEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	procs.push(pKill);
	for (let i = 0; i < 80 && !existsSync(startedFlag); i++) await delay(50);
	assert.equal(existsSync(startedFlag), true);

	process.kill(pKill.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pKill.once("exit", () => resolveExit()));

	const filesBeforeRead = readdirSync(runKill.session_dir).sort();
	const killStatus = f.service.status(runKill.task_id, f.cwd);
	assert.equal(killStatus.outcome.state, "needs_attention");
	assert.equal(killStatus.agents[0].execution, "needs_attention");
	assert.ok(killStatus.worker_errors.some(e => e.includes("exited before recording a result")));
	assert.deepEqual(readdirSync(runKill.session_dir).sort(), filesBeforeRead, "status() must never mutate session dir");
});

