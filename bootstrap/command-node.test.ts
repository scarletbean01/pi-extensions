import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryOperations, createManagerAuthority, revokeManagerAuthority } from "../factory/operations.ts";
import { validateDraftShape } from "../factory/draft.ts";
import { planDecisions, validateGraphLimits } from "./decisions.ts";
import { buildCommandEnv, createCommandDriver } from "./command-runner.ts";
import { writeCancelRecord } from "./cancellation.ts";
import { BootstrapService, type ExecResult } from "./lifecycle.ts";
import { handoffClaimPath } from "./handoff.ts";
import { sourceExpectation } from "./node-admission.ts";
import { evaluateOwnershipDependencies, ownershipPath, ownershipRecord, parseOwnershipRecord } from "./ownership.ts";
import { formatPlan } from "./reporting.ts";
import {
	atomicJson, COMMAND_VERSION, commandProcessGroupPath, dispositionPath, parseManifest, parseWorkerConfig, processStartTime,
	type BootstrapManifest, type WorkerConfig,
} from "./session-store.ts";
import * as previousV5 from "./test-support/previous-v5-session-store.ts";
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
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok" },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /missing command_evidence/i);

	// Unsupported version
	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, version: 2 } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /Unsupported command_evidence version/);

	// exit_code != 0 claiming success
	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, exit_code: 1 } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /contradicts claimed success/i);

	// signal != null claiming success
	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, exit_code: null, signal: "SIGKILL" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /contradicts claimed success/i);

	// termination_error claiming success
	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, exit_code: null, termination_error: "termination unconfirmed" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /contradicts claimed success/i);

	// Mismatched command / args / working_directory
	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, command: "other" } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /command mismatch/);

	assert.throws(() => parseCompletion({
		version: 7,
		identity: baseIdentity,
		result: { agent_name: "cmd", node_id: "cmd", status: "success", summary: "ok", detail: "ok", command_evidence: { ...validEvidence, args: ["tampered"] } },
		delivery: "not_required",
		completed_at: "2026-01-01T00:00:00.020Z",
	}, cmdExpectation), /args mismatch/);

	assert.throws(() => parseCompletion({
		version: 7,
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
	const slowChildPidFile = join(f.cwd, "slow-child.pid");
	t.after(() => {
		if (existsSync(slowChildPidFile)) {
			try { process.kill(Number(readFileSync(slowChildPidFile, "utf8").trim()), "SIGKILL"); } catch { /* ignore */ }
		}
	});
	const runKill = await f.service.generate({
		topology: "graph",
		task: "SIGKILL interruption test",
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "slow_cmd",
				command: process.execPath,
				args: ["-e", `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(slowChildPidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(startedFlag)}, "started"); setInterval(() => {}, 1000);`],
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
	assert.ok(killStatus.worker_errors.some(e => e.includes("command runner exited while command process group is still active") || e.includes("exited before recording a result")));
	assert.deepEqual(readdirSync(runKill.session_dir).sort(), filesBeforeRead, "status() must never mutate session dir");
});

test("B1: SIGHUP kills process group; SIGKILL runner holds ownership while child lives, cancel & force_close verify dead and fail closed on corrupt pgid", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const spawnedRunners: ReturnType<typeof spawn>[] = [];
	const trackedPids: number[] = [];
	t.after(() => {
		for (const pid of trackedPids) {
			try { process.kill(pid, "SIGCONT"); } catch { /* ignore */ }
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
		for (const p of spawnedRunners) {
			try { if (p.pid) process.kill(p.pid, "SIGCONT"); } catch { /* ignore */ }
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. SIGHUP delivered to running command-runner must kill the entire child process group before exiting.
	const hupPidsFile = join(f.cwd, "hup-pids.json");
	const runHup = await f.service.generate({
		topology: "graph",
		task: "SIGHUP process-group cleanup",
		cancel_grace_ms: 40,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "hup_cmd",
				command: process.execPath,
				args: ["-e", `
					const fs = require("node:fs");
					const { spawn } = require("node:child_process");
					process.on("SIGTERM", () => {});
					const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: "ignore" });
					fs.writeFileSync(${JSON.stringify(hupPidsFile)}, JSON.stringify({ child: process.pid, grandchild: gc.pid }));
					setInterval(() => {}, 1000);
				`],
			},
		],
	});
	const hupEntry = runHup.pane_manifest[0];
	rmSync(join(runHup.session_dir, `${hupEntry.instance_id}.ready.json`), { force: true });
	const pHup = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runHup.session_dir, `${hupEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pHup);
	for (let i = 0; i < 80 && !existsSync(hupPidsFile); i++) await delay(50);
	assert.equal(existsSync(hupPidsFile), true);
	const hupPids = readJson<{ child: number; grandchild: number }>(hupPidsFile);
	trackedPids.push(hupPids.child, hupPids.grandchild);
	assert.equal(pidAlive(hupPids.child), true);
	assert.equal(pidAlive(hupPids.grandchild), true);

	process.kill(pHup.pid!, "SIGHUP");
	await new Promise<void>(resolveExit => {
		if (pHup.exitCode !== null || pHup.signalCode !== null) return resolveExit();
		pHup.once("exit", () => resolveExit());
		setTimeout(resolveExit, 5000);
	});
	for (let i = 0; i < 40 && (pidAlive(hupPids.child) || pidAlive(hupPids.grandchild)); i++) await delay(25);
	assert.equal(pidAlive(hupPids.child), false, "SIGHUP must kill child process");
	assert.equal(pidAlive(hupPids.grandchild), false, "SIGHUP must kill grandchild in process group");

	// 2. SIGKILL runner while detached child lives: ownership stays held against conflicting writer; cancel kills orphaned pgid and verifies dead.
	const holdPidFile = join(f.cwd, "hold-child.pid");
	const runHold = await f.service.generate({
		topology: "graph",
		task: "Orphaned command holds ownership",
		cancel_grace_ms: 40,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "hold_cmd",
				write_paths: ["shared-owned.txt"],
				command: process.execPath,
				args: ["-e", `
					const fs = require("node:fs");
					process.on("SIGTERM", () => {});
					fs.writeFileSync(${JSON.stringify(holdPidFile)}, String(process.pid));
					setInterval(() => {}, 1000);
				`],
			},
		],
	});
	const holdEntry = runHold.pane_manifest[0];
	const holdKey = holdEntry.instance_id;
	rmSync(join(runHold.session_dir, `${holdEntry.instance_id}.ready.json`), { force: true });
	const pHold = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runHold.session_dir, `${holdEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pHold);
	for (let i = 0; i < 80 && !existsSync(holdPidFile); i++) await delay(50);
	assert.equal(existsSync(holdPidFile), true);
	const holdChildPid = Number(readFileSync(holdPidFile, "utf8").trim());
	trackedPids.push(holdChildPid);
	assert.equal(pidAlive(holdChildPid), true);
	// .pgid.json must already be persisted right after spawn while child runs
	assert.equal(existsSync(commandProcessGroupPath(runHold.session_dir, holdKey)), true);

	process.kill(pHold.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pHold.once("exit", () => resolveExit()));
	assert.equal(pidAlive(holdChildPid), true, "detached command child survives runner SIGKILL");

	const holdStatusBeforeCancel = f.service.status(runHold.task_id, f.cwd);
	assert.equal(holdStatusBeforeCancel.agents[0].execution, "needs_attention");
	assert.ok(holdStatusBeforeCancel.worker_errors.some(e => e.includes("command process group is still active")));

	// Check overlapping writer inside same run / dependency evaluator cannot bypass ownership while orphan lives
	const syntheticContender = evaluateOwnershipDependencies({
		sessionDir: runHold.session_dir,
		taskId: runHold.task_id,
		nodeId: "contender",
		personaName: "second",
		writePaths: ["shared-owned.txt"],
		waitingFor: [holdEntry.instance_id],
		topology: "graph",
		instanceId: "a2-contender",
		roster: [
			{
				instance_id: holdEntry.instance_id,
				node_id: holdEntry.node_id,
				persona_name: holdEntry.persona_name,
				kind: "command",
				command: holdEntry.command!,
				args: holdEntry.args ?? [],
				working_directory: holdEntry.working_directory!,
				write_paths: ["shared-owned.txt"],
				sub_task: "Hold",
			},
			{ instance_id: "a2-contender", node_id: "contender", persona_name: "second", write_paths: ["shared-owned.txt"], sub_task: "Contend" },
		],
	});
	assert.equal(syntheticContender.admitted, false, "conflicting writer must wait while orphaned command child lives");
	assert.equal(syntheticContender.waiting_on[0]?.node_id, "hold_cmd");
	assert.equal(syntheticContender.waiting_on[0]?.status, "running");

	// Cancel runHold after runner died: must kill -pgid, verify dead, mark cancelled, and release ownership
	const deadCancel = await f.service.cancel(runHold.task_id, { reason: "reap orphan", grace_ms: 40, cwd: f.cwd });
	assert.ok(deadCancel.cancelled.includes("hold_cmd"), JSON.stringify(deadCancel));
	for (let i = 0; i < 20 && pidAlive(holdChildPid); i++) await delay(25);
	assert.equal(pidAlive(holdChildPid), false, "cancel() after dead runner must kill orphaned command pgid");
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(runHold.session_dir, holdKey)), { run_id: runHold.task_id, instance_id: holdEntry.instance_id }).state, "released");
	assert.equal(evaluateOwnershipDependencies({
		sessionDir: runHold.session_dir,
		taskId: runHold.task_id,
		nodeId: "contender",
		personaName: "second",
		writePaths: ["shared-owned.txt"],
		waitingFor: [holdEntry.instance_id],
		topology: "graph",
		instanceId: "a2-contender",
		roster: [
			{
				instance_id: holdEntry.instance_id,
				node_id: holdEntry.node_id,
				persona_name: holdEntry.persona_name,
				kind: "command",
				command: holdEntry.command!,
				args: holdEntry.args ?? [],
				working_directory: holdEntry.working_directory!,
				write_paths: ["shared-owned.txt"],
				sub_task: "Hold",
			},
			{ instance_id: "a2-contender", node_id: "contender", persona_name: "second", write_paths: ["shared-owned.txt"], sub_task: "Contend" },
		],
	}).admitted, true, "ownership must release once orphaned command pgid is verified dead");

	// 3. Pin "forceclose-kill": SIGSTOP live runner so grace expires -> force_close: true must kill -pgid AND verify dead before marking cancelled
	const fcPidFile = join(f.cwd, "fc-child.pid");
	const runFc = await f.service.generate({
		topology: "graph",
		task: "force_close kills active command pgid",
		cancel_grace_ms: 20,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "fc_cmd",
				write_paths: ["fc-owned.txt"],
				command: process.execPath,
				args: ["-e", `
					const fs = require("node:fs");
					process.on("SIGTERM", () => {});
					fs.writeFileSync(${JSON.stringify(fcPidFile)}, String(process.pid));
					setInterval(() => {}, 1000);
				`],
			},
		],
	});
	const fcEntry = runFc.pane_manifest[0];
	const fcKey = fcEntry.instance_id;
	rmSync(join(runFc.session_dir, `${fcEntry.instance_id}.ready.json`), { force: true });
	const pFc = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runFc.session_dir, `${fcEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pFc);
	for (let i = 0; i < 80 && !existsSync(fcPidFile); i++) await delay(50);
	assert.equal(existsSync(fcPidFile), true);
	const fcChildPid = Number(readFileSync(fcPidFile, "utf8").trim());
	trackedPids.push(fcChildPid);
	for (let i = 0; i < 40 && !existsSync(commandProcessGroupPath(runFc.session_dir, fcKey)); i++) await delay(25);
	// Pause runner so it stays "working" and ignores soft cancel, requiring force_close
	process.kill(pFc.pid!, "SIGSTOP");

	const fcFirst = await f.service.cancel(runFc.task_id, { reason: "stop hung runner", grace_ms: 20, cwd: f.cwd });
	assert.equal(fcFirst.cancelling.length, 1);
	assert.equal(pidAlive(fcChildPid), true);
	await delay(40);
	const fcSecond = await f.service.cancel(runFc.task_id, { reason: "force close hung", grace_ms: 20, force_close: true, cwd: f.cwd });
	assert.ok(fcSecond.cancelled.includes("fc_cmd"));
	for (let i = 0; i < 20 && pidAlive(fcChildPid); i++) await delay(25);
	assert.equal(pidAlive(fcChildPid), false, "force_close must kill detached command pgid");
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(runFc.session_dir, fcKey)), { run_id: runFc.task_id, instance_id: fcEntry.instance_id }).state, "released");

	// 4. Corrupt .pgid.json during cancel fails closed: needs_attention, NOT cancelled, and ownership stays held
	const corruptPidFile = join(f.cwd, "corrupt-pg.pid");
	const runCorruptPg = await f.service.generate({
		topology: "graph",
		task: "Corrupt pgid fails closed",
		cancel_grace_ms: 20,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "corrupt_pg_cmd",
				write_paths: ["corrupt-pg.txt"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(corruptPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
			},
		],
	});
	const cpgEntry = runCorruptPg.pane_manifest[0];
	const cpgKey = cpgEntry.instance_id;
	rmSync(join(runCorruptPg.session_dir, `${cpgEntry.instance_id}.ready.json`), { force: true });
	const pCpg = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runCorruptPg.session_dir, `${cpgEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pCpg);
	for (let i = 0; i < 80 && !existsSync(corruptPidFile); i++) await delay(50);
	const cpgChildPid = Number(readFileSync(corruptPidFile, "utf8").trim());
	trackedPids.push(cpgChildPid);
	process.kill(pCpg.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pCpg.once("exit", () => resolveExit()));
	writeFileSync(commandProcessGroupPath(runCorruptPg.session_dir, cpgKey), "{corrupt-pgid");
	const cpgCancel = await f.service.cancel(runCorruptPg.task_id, { reason: "cancel corrupt pgid", grace_ms: 20, cwd: f.cwd });
	assert.deepEqual(cpgCancel.cancelled, []);
	assert.ok((cpgCancel.record_errors ?? []).some(p => p.includes("unusable process group record")), JSON.stringify(cpgCancel));
	assert.equal(f.service.status(runCorruptPg.task_id, f.cwd).agents[0].execution, "needs_attention");
	const cpgDisp = parseDisposition(readJson(dispositionPath(runCorruptPg.session_dir, cpgKey)), { run_id: runCorruptPg.task_id, instance_id: cpgEntry.instance_id });
	assert.equal(cpgDisp.state, "needs_attention", "unverified pgid kill must record needs_attention, never cancelled");
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(runCorruptPg.session_dir, cpgKey)), { run_id: runCorruptPg.task_id, instance_id: cpgEntry.instance_id }).state, "admitted", "ownership must stay held on unverified pgid kill");
});

test("B2: damaged cancel record & unconfirmed termination fail closed as needs_attention, hold ownership, without fake SIGKILL", async t => {
	const f = serviceFixture(t, []);
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const b2PidFile = join(f.cwd, "b2-child.pid");
	const spawned: ReturnType<typeof spawn>[] = [];
	const tracked: number[] = [];
	t.after(() => {
		for (const pid of tracked) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
		for (const p of spawned) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. Corrupt .cancel.json while running -> stops child, records needs_attention (never cancelled!), holds ownership
	const runDamaged = await f.service.generate({
		topology: "graph",
		task: "Damaged cancel record fails closed",
		cancel_grace_ms: 40,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "b2_cmd",
				write_paths: ["b2.txt"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(b2PidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
			},
		],
	});
	const b2Entry = runDamaged.pane_manifest[0];
	const b2Key = b2Entry.instance_id;
	rmSync(join(runDamaged.session_dir, `${b2Entry.instance_id}.ready.json`), { force: true });
	const pB2 = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(runDamaged.session_dir, `${b2Entry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawned.push(pB2);
	for (let i = 0; i < 80 && !existsSync(b2PidFile); i++) await delay(50);
	const b2ChildPid = Number(readFileSync(b2PidFile, "utf8").trim());
	tracked.push(b2ChildPid);

	writeFileSync(join(runDamaged.session_dir, `${b2Entry.instance_id}.cancel.json`), "{corrupt-cancel");
	await new Promise<void>(resolveExit => {
		if (pB2.exitCode !== null || pB2.signalCode !== null) return resolveExit();
		pB2.once("exit", () => resolveExit());
		setTimeout(resolveExit, 5000);
	});
	assert.equal(pidAlive(b2ChildPid), false, "damaged cancel check must still terminate running child");
	const dispB2 = parseDisposition(readJson(dispositionPath(runDamaged.session_dir, b2Key)), { run_id: runDamaged.task_id, instance_id: b2Entry.instance_id });
	assert.equal(dispB2.state, "needs_attention", "damaged cancel record must yield needs_attention, NEVER cancelled");
	assert.equal(existsSync(join(runDamaged.session_dir, `${b2Key}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(runDamaged.session_dir, b2Key)), { run_id: runDamaged.task_id, instance_id: b2Entry.instance_id }).state, "admitted", "needs_attention must keep ownership held");
	const stB2 = f.service.status(runDamaged.task_id, f.cwd);
	assert.equal(stB2.outcome.state, "needs_attention");
	assert.equal(stB2.agents[0].execution, "needs_attention");
	assert.equal(stB2.agents[0].command_evidence?.signal, "SIGTERM");

	// 2. Mismatched pgid start_time on alive unrelated process prevents killing wrong process (PID reuse guard)
	const holderProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
	spawned.push(holderProc);
	const runUnconfirmed = await f.service.generate({
		topology: "graph",
		task: "Mismatched pgid identity safety",
		cancel_grace_ms: 20,
		project_cwd: f.cwd,
		agents: [
			{
				kind: "command",
				node_id: "mismatch_pg",
				write_paths: ["unconfirmed.txt"],
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000);"],
			},
		],
	});
	const uncEntry = runUnconfirmed.pane_manifest[0];
	const uncKey = uncEntry.instance_id;
	const uncAttempt = uncEntry.attempt_id ?? uncEntry.instance_id;
	const readyInfo = readJson<{ pid: number; start_time?: string }>(join(runUnconfirmed.session_dir, `${uncEntry.instance_id}.ready.json`));
	atomicJson(join(runUnconfirmed.session_dir, `${uncEntry.instance_id}.ready.json`), { ...readyInfo, pid: 2147483646 });
	atomicJson(ownershipPath(runUnconfirmed.session_dir, uncKey), ownershipRecord({
		run_id: runUnconfirmed.task_id,
		node_id: uncEntry.node_id,
		persona_name: uncEntry.persona_name,
		attempt_id: uncAttempt,
		instance_id: uncEntry.instance_id,
		write_paths: ["unconfirmed.txt"],
		state: "admitted",
	}));
	atomicJson(commandProcessGroupPath(runUnconfirmed.session_dir, uncKey), {
		version: 1,
		identity: { run_id: runUnconfirmed.task_id, node_id: uncEntry.node_id, persona_name: uncEntry.persona_name, attempt_id: uncAttempt, instance_id: uncEntry.instance_id },
		pgid: holderProc.pid!,
		start_time: "wrong-start-time",
		started_at: new Date().toISOString(),
	});
	await f.service.cancel(runUnconfirmed.task_id, { reason: "cancel mismatch", grace_ms: 20, cwd: f.cwd });
	assert.equal(pidAlive(holderProc.pid!), true, "start_time mismatch must prevent killing unrelated process");
});

test("Guards & Compatibility: v7/v5 gating, v1-command & agent-with-cmd rejection, readiness (none), retained definitions, env allowlist", async t => {
	const f = serviceFixture(t, ["first"]);

	// 1. Version gating: v7 manifest/config with command node rejected by previousV5; v1 command and agent-with-command rejected by current parser
	const generated = await f.service.generate({
		topology: "graph",
		task: "v7 compatibility",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "cmd_v7", command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const manifestJson = readJson<BootstrapManifest>(join(generated.session_dir, "manifest.json"));
	const configJson = readJson<WorkerConfig>(join(generated.session_dir, `${generated.pane_manifest[0].instance_id}.config.json`));
	assert.equal(manifestJson.version, COMMAND_VERSION);
	assert.equal(configJson.version, COMMAND_VERSION);
	assert.throws(() => previousV5.parseManifest(manifestJson, generated.task_id), /Unsupported bootstrap manifest version/);
	assert.throws(() => previousV5.parseWorkerConfig(configJson), /Unsupported bootstrap worker configuration version/);

	// Non-command graph keeps non-v7 version and stays readable as before
	const agentOnly = await f.service.generate({
		topology: "graph",
		task: "Non-command remains v4",
		project_cwd: f.cwd,
		agents: [{ node_id: "only_agent", persona: "first", sub_task: "Run" }],
	}, model);
	assert.notEqual(readJson<BootstrapManifest>(join(agentOnly.session_dir, "manifest.json")).version, COMMAND_VERSION);

	// Reject v1 command manifest & config (chain topology + agent_name allows v1 parsing to reach command-version check)
	assert.throws(() => parseManifest({
		...manifestJson,
		topology: "chain",
		version: 1,
		pane_manifest: [{ ...manifestJson.pane_manifest[0], agent_name: "cmd_v7", attempt_id: undefined, inbound_edges: undefined }],
	}, generated.task_id), /require record version/);
	assert.throws(() => parseWorkerConfig({ ...configJson, topology: "chain", version: 1, agent_name: "cmd_v7", attempt_id: undefined, inbound_edges: undefined, outbound_edges: undefined }), /require record version/);

	// Reject agent record carrying command / args / working_directory
	for (const cmdField of [{ command: "echo" }, { args: ["a"] }, { working_directory: f.cwd }] as const) {
		assert.throws(() => parseManifest({
			...manifestJson,
			pane_manifest: [{ ...manifestJson.pane_manifest[0], kind: "agent", ...cmdField }],
		}, generated.task_id), /cannot carry command/);
		assert.throws(() => parseWorkerConfig({
			...configJson,
			kind: "agent",
			...cmdField,
		}), /cannot carry command/);
	}

	// 2. Readiness acknowledgement guard: command node reporting wrong model or skills must be rejected
	for (const badReady of [{ model: "anthropic/claude-sonnet-4-5" }, { model: "(none)", kept_skills: ["sneaky"] }] as const) {
		let createdLabel = "";
		const fakeExec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
			const ok = (v: unknown = "") => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify({ result: v }), stderr: "" });
			if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
			if (args[0] === "tab" && args[1] === "create") {
				createdLabel = args[args.indexOf("--label") + 1] ?? "";
				return ok({ tab: { tab_id: "t1" }, root_pane: { pane_id: "p1", terminal_id: "term1" } });
			}
			if (args[0] === "pane" && args[1] === "run") {
				const [task, instance] = createdLabel.split(":");
				const sDir = join(f.cwd, ".pi", "agent-sessions", task);
				const cfg = readJson<WorkerConfig>(join(sDir, `${instance}.config.json`));
				atomicJson(join(sDir, `${instance}.ready.json`), {
					task_id: task, token: cfg.token, instance_id: instance, name: instance,
					pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake", ...badReady,
				});
				return ok();
			}
			if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
			if (args[0] === "tab" && args[1] === "list") return ok({ tabs: [] });
			if (args[0] === "pane" && args[1] === "list") return ok({ panes: [] });
			return ok();
		};
		const customService = new BootstrapService({
			exec: fakeExec,
			extensionDir: realpathSync(join(import.meta.dirname, "..")),
			stateDir: join(f.root, "custom-state"),
			home: f.home,
			pollMs: 5,
			env: { PATH: process.env.PATH, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		});
		const badGen = await customService.generate({
			topology: "graph",
			task: "Reject bad readiness",
			project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "cmd_r", command: process.execPath }],
		});
		assert.equal(badGen.status, "error");
		assert.match(badGen.error ?? "", /Invalid readiness acknowledgement/);
	}

	// 3. Retained definition guards in prepareFromDefinition (intervention, agent fields, decision)
	const validRetained = f.service.prepareDefinition({
		topology: "graph",
		task: "Retained command checks",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "prep", persona: "first", sub_task: "Prep" },
			{ kind: "command", node_id: "ret_cmd", command: process.execPath, args: ["-e", "process.exit(0)"], depends_on: ["prep"] },
		],
	}, { ...model, thinkingLevel: "low" });
	f.service.prepareFromDefinition(structuredClone(validRetained), { checkHerdrEnv: false });

	const badIntervention = structuredClone(validRetained);
	(badIntervention.agents[1].node as any).intervention = { choices: [{ choice_id: "go", label: "Go" }] };
	assert.throws(() => f.service.prepareFromDefinition(badIntervention, { checkHerdrEnv: false }), /retained command node cannot declare intervention/);

	const badDecision = structuredClone(validRetained);
	(badDecision.agents[1] as any).decision = { field: "verdict", approve: "yes", reject: "no", on_reject: "prep", max_revisions: 1, on_exhausted: "needs_attention" };
	assert.throws(() => f.service.prepareFromDefinition(badDecision, { checkHerdrEnv: false }), /retained command node cannot declare decision/);

	for (const forbidden of ["model", "thinking", "tools", "skills", "extensions", "system_prompt"] as const) {
		const badField = structuredClone(validRetained);
		(badField.agents[1] as any)[forbidden] = "injected";
		assert.throws(() => f.service.prepareFromDefinition(badField, { checkHerdrEnv: false }), new RegExp(`cannot carry ${forbidden}`));
	}

	// 4. Direct validateDraftShape checks for command vs agent fields
	for (const forbiddenKey of ["model", "thinking", "skills", "allowed_skills", "tools", "extensions", "intervention", "decision", "persona", "name"] as const) {
		assert.throws(() => validateDraftShape({
			topology: "graph", task: "Draft check", project_cwd: f.cwd,
			agents: [{ kind: "command", node_id: "c1", command: "echo", [forbiddenKey]: "bad" }],
		}), /cannot declare agent-only setting/);
	}
	for (const cmdKey of ["command", "args", "working_directory"] as const) {
		assert.throws(() => validateDraftShape({
			topology: "graph", task: "Draft check", project_cwd: f.cwd,
			agents: [{ node_id: "a1", persona: "first", sub_task: "x", [cmdKey]: cmdKey === "args" ? ["x"] : "x" }],
		}), /cannot declare command-only setting/);
	}

	// 5. Minimal environment allowlist: provider API keys & secret env vars are stripped before spawn
	const prevAnt = process.env.ANTHROPIC_API_KEY;
	const prevOai = process.env.OPENAI_API_KEY;
	const prevSec = process.env.CUSTOM_SECRET_ENV;
	process.env.ANTHROPIC_API_KEY = "sk-ant-topsecret";
	process.env.OPENAI_API_KEY = "sk-oai-topsecret";
	process.env.CUSTOM_SECRET_ENV = "secret-val";
	try {
		const filtered = buildCommandEnv(process.env);
		assert.equal(filtered.ANTHROPIC_API_KEY, undefined);
		assert.equal(filtered.OPENAI_API_KEY, undefined);
		assert.equal(filtered.CUSTOM_SECRET_ENV, undefined);
		assert.ok(filtered.PATH);

		const fEnv = await runFixture(t, {
			topology: "graph",
			task: "Check spawned env allowlist",
			agents: [
				{
					kind: "command",
					node_id: "env_cmd",
					command: process.execPath,
					args: ["-e", `console.log(JSON.stringify({
						hasPath: !!process.env.PATH,
						hasBootstrap: !!process.env.BOOTSTRAP_TASK_INPUT_PATH,
						ant: process.env.ANTHROPIC_API_KEY ?? null,
						oai: process.env.OPENAI_API_KEY ?? null,
						sec: process.env.CUSTOM_SECRET_ENV ?? null,
					}))`],
				},
			],
		});
		const envRes = (await fEnv.report()).results[0];
		assert.deepEqual(envRes.outputs, { hasPath: true, hasBootstrap: true, ant: null, oai: null, sec: null });
	} finally {
		if (prevAnt === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnt;
		if (prevOai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOai;
		if (prevSec === undefined) delete process.env.CUSTOM_SECRET_ENV; else process.env.CUSTOM_SECRET_ENV = prevSec;
	}
});

test("Runtime & Join Guards: task_timeout_ms, post-exit group kill, partial-as-success, restart claims, join ownership/recheck, delivery fail, sourceExpectation", async t => {
	// 1. task_timeout_ms timeout records failed + command_evidence and blocks downstream
	const fTimeout = await runFixture(t, {
		topology: "graph",
		task: "Command task_timeout_ms test",
		agents: [
			{
				kind: "command",
				node_id: "timeout_cmd",
				task_timeout_ms: 120,
				cancel_grace_ms: 30,
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000);"],
			},
			{
				node_id: "after_timeout",
				persona: "first",
				sub_task: "Blocked by timeout",
				depends_on: ["timeout_cmd"],
			},
		],
	});
	await fTimeout.nodes.get("after_timeout")!.deliverNotification(fTimeout.nodes.get("timeout_cmd")!);
	const tStatus = fTimeout.status();
	assert.equal(tStatus.agents.find(a => a.node_id === "timeout_cmd")!.execution, "failed");
	assert.match(tStatus.agents.find(a => a.node_id === "timeout_cmd")!.execution_reason ?? "", /deadline exceeded/);
	assert.equal(tStatus.agents.find(a => a.node_id === "after_timeout")!.execution, "blocked");

	// 2. Post-exit surviving process group is killed (and dormant when child cleanly has no survivors)
	const fPost = serviceFixture(t, []);
	const bgPidFile = join(fPost.cwd, "bg-orphan.pid");
	const cleanMarker = join(fPost.cwd, "clean.txt");
	t.after(() => {
		if (existsSync(bgPidFile)) {
			try { process.kill(Number(readFileSync(bgPidFile, "utf8").trim()), "SIGKILL"); } catch { /* ignore */ }
		}
	});
	const fBg = await runFixture(t, {
		topology: "graph",
		task: "Kill surviving group after parent exit",
		cancel_grace_ms: 30,
		agents: [
			{
				kind: "command",
				node_id: "bg_spawner",
				command: process.execPath,
				args: ["-e", `
					const fs = require("node:fs");
					const { spawn } = require("node:child_process");
					const bg = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
					bg.unref();
					fs.writeFileSync(${JSON.stringify(bgPidFile)}, String(bg.pid));
					console.log(JSON.stringify({ spawned: true }));
				`],
			},
			{
				kind: "command",
				node_id: "clean_exit",
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(cleanMarker)}, "ok"); console.log(JSON.stringify({ clean: true }));`],
			},
		],
	});
	assert.equal(existsSync(bgPidFile), true);
	const bgPid = Number(readFileSync(bgPidFile, "utf8").trim());
	assert.equal(pidAlive(bgPid), false, "post-exit processGroupAlive check must kill surviving background child in same pgid");
	const cleanState = fBg.status().agents.find(a => a.node_id === "clean_exit")!;
	assert.equal(cleanState.command_evidence?.process_group_killed, undefined);

	// 3. Stdout JSON { status: "partial" } maps to "failure" (never treated as success)
	const fPartial = await runFixture(t, {
		topology: "graph",
		task: "Partial stdout maps to failure",
		agents: [
			{
				kind: "command",
				node_id: "partial_cmd",
				command: process.execPath,
				args: ["-e", 'console.log(JSON.stringify({ status: "partial", summary: "only half worked", outputs: { n: 1 } }))'],
			},
		],
	});
	const pStatus = fPartial.status();
	assert.equal(pStatus.outcome.state, "failed");
	assert.equal(pStatus.agents[0].execution, "failed");
	assert.match(pStatus.agents[0].execution_reason ?? "", /partial/);
	const pReport = await fPartial.report();
	assert.match(pReport.results[0]?.summary ?? "", /partial/);

	// 4. Restart after claim without result fails closed (needs_attention) and never re-runs command (single AND join)
	const fRestart = serviceFixture(t, ["first", "second"]);
	const rerunMarker = join(fRestart.cwd, "should-not-run.txt");
	const rPlan = await fRestart.service.generate({
		topology: "graph",
		task: "Restart claimed command node",
		project_cwd: fRestart.cwd,
		agents: [
			{ node_id: "p1", persona: "first", sub_task: "P1" },
			{ node_id: "p2", persona: "second", sub_task: "P2" },
			{
				kind: "command",
				node_id: "claimed_single",
				depends_on: ["p1"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(rerunMarker)}, "ran");`],
			},
			{
				kind: "command",
				node_id: "claimed_join",
				depends_on: ["p1", "p2"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(rerunMarker)}, "ran");`],
			},
		],
	}, model);
	const sEntry = rPlan.pane_manifest.find(e => e.node_id === "claimed_single")!;
	const jEntry = rPlan.pane_manifest.find(e => e.node_id === "claimed_join")!;
	const p1Entry = rPlan.pane_manifest.find(e => e.node_id === "p1")!;
	const p2Entry = rPlan.pane_manifest.find(e => e.node_id === "p2")!;
	// Write pre-existing handoff claims with no recorded result (using canonical handoffClaimPath)
	atomicJson(handoffClaimPath(rPlan.session_dir, sEntry.instance_id, p1Entry.instance_id), {
		version: 1,
		handoff_id: "h-single",
		state: "accepted",
		run_id: rPlan.task_id,
		source: { node_id: p1Entry.node_id, attempt_id: p1Entry.attempt_id!, instance_id: p1Entry.instance_id, session_id: "s-p1" },
		destination: { node_id: sEntry.node_id, attempt_id: sEntry.attempt_id!, instance_id: sEntry.instance_id },
		input_digest: "d-single",
		offer: "matched",
		accepted_at: new Date().toISOString(),
	});
	atomicJson(handoffClaimPath(rPlan.session_dir, jEntry.instance_id), {
		version: 1,
		kind: "join",
		handoff_ids: ["h-1", "h-2"],
		state: "accepted",
		run_id: rPlan.task_id,
		destination: { node_id: jEntry.node_id, attempt_id: jEntry.attempt_id!, instance_id: jEntry.instance_id },
		sources: [
			{ node_id: p1Entry.node_id, attempt_id: p1Entry.attempt_id!, instance_id: p1Entry.instance_id, handoff_id: "h-1", input_digest: "a".repeat(64) },
			{ node_id: p2Entry.node_id, attempt_id: p2Entry.attempt_id!, instance_id: p2Entry.instance_id, handoff_id: "h-2", input_digest: "b".repeat(64) },
		],
		accepted_at: new Date().toISOString(),
	});
	const dSingle = createCommandDriver(join(rPlan.session_dir, `${sEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	const dJoin = createCommandDriver(join(rPlan.session_dir, `${jEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	await dSingle.start();
	await dJoin.start();
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all([dSingle.waitUntilSettled(), dJoin.waitUntilSettled()]),
			new Promise<never>((_, reject) => {
				settleTimer = setTimeout(() => reject(new Error("Restarted claimed command node did not settle promptly as needs_attention")), 2000);
			}),
		]);
	} finally {
		if (settleTimer) clearTimeout(settleTimer);
	}
	assert.equal(existsSync(rerunMarker), false, "restarted claimed command node must NEVER re-run its command");
	assert.equal(parseDisposition(readJson(dispositionPath(rPlan.session_dir, sEntry.instance_id)), { run_id: rPlan.task_id, instance_id: sEntry.instance_id }).state, "needs_attention");
	assert.equal(parseDisposition(readJson(dispositionPath(rPlan.session_dir, jEntry.instance_id)), { run_id: rPlan.task_id, instance_id: jEntry.instance_id }).state, "needs_attention");

	// 5. Join ownership wait & join failed-upstream recheck
	const joinHolder = { release: () => {} };
	const ranAfterRelease: string[] = [];
	const fJoinOwn = await runFixture(t, {
		topology: "graph",
		task: "Join waits on overlapping writer ownership",
		dependency_wait_timeout_ms: 5000,
		agents: [
			{ kind: "command", node_id: "j_left", command: process.execPath, args: ["-e", 'console.log(JSON.stringify({ l: 1 }))'] },
			{ kind: "command", node_id: "j_right", command: process.execPath, args: ["-e", 'console.log(JSON.stringify({ r: 2 }))'] },
			{
				node_id: "holder",
				persona: "first",
				sub_task: "Holds shared.txt",
				write_paths: ["shared.txt"],
			},
			{
				kind: "command",
				node_id: "cmd_join_writer",
				depends_on: ["j_left", "j_right"],
				write_paths: ["shared.txt"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(join(fRestart.cwd, "join-ran.txt"))}, "yes"); console.log(JSON.stringify({ joined: true }));`],
			},
		],
	}, new Map([
		["holder", {
			executeTool: async name => {
				if (name === "bootstrap_complete") ranAfterRelease.push("holder-complete");
				return { content: [], details: { msg_id: "m" } };
			},
		}],
	]));
	// Hold holder's ownership manually BEFORE join delivers, OR check holder already admitted ownership during runFixture!
	// Write admitted ownership for holder, send both join notifications -> join must stay waiting until holder's ownership releases!
	const holderEntry = fJoinOwn.run.pane_manifest.find(e => e.node_id === "holder")!;
	const joinEntry = fJoinOwn.run.pane_manifest.find(e => e.node_id === "cmd_join_writer")!;
	const joinStartedFlag = join(fRestart.cwd, "join-ran.txt");
	assert.equal(existsSync(joinStartedFlag), false);
	await fJoinOwn.nodes.get("cmd_join_writer")!.deliverNotification(fJoinOwn.nodes.get("j_left")!);
	await fJoinOwn.nodes.get("cmd_join_writer")!.deliverNotification(fJoinOwn.nodes.get("j_right")!);
	await delay(120);
	assert.equal(existsSync(joinStartedFlag), false, "command join must NOT start while overlapping writer holds ownership");
	await fJoinOwn.nodes.get("holder")!.complete({ status: "success", summary: "Done holding", detail: "Released write path" });
	for (let i = 0; i < 60 && !existsSync(resultPath(fJoinOwn.run.session_dir, joinEntry.instance_id)); i++) await delay(40);
	assert.equal(existsSync(joinStartedFlag), true, "command join must proceed once overlapping ownership releases");
	joinHolder.release();

	// 6. Join blocked by failed upstream
	const blockedJoinMarker = join(fRestart.cwd, "blocked-join-must-not-run.txt");
	const fJoinBlocked = await runFixture(t, {
		topology: "graph",
		task: "Failed upstream blocks command join",
		agents: [
			{ kind: "command", node_id: "ok_up", command: process.execPath, args: ["-e", 'console.log(JSON.stringify({ ok: 1 }))'] },
			{ kind: "command", node_id: "fail_up", command: process.execPath, args: ["-e", "process.exit(3)"] },
			{
				kind: "command",
				node_id: "join_blocked",
				depends_on: ["ok_up", "fail_up"],
				join_policy: "all_success",
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(blockedJoinMarker)}, "bad");`],
			},
		],
	});
	await fJoinBlocked.nodes.get("join_blocked")!.deliverNotification(fJoinBlocked.nodes.get("ok_up")!);
	await fJoinBlocked.nodes.get("join_blocked")!.deliverNotification(fJoinBlocked.nodes.get("fail_up")!);
	const jbState = fJoinBlocked.status().agents.find(a => a.node_id === "join_blocked")!;
	assert.equal(jbState.execution, "blocked");
	assert.equal(jbState.execution_causes[0]?.node_id, "fail_up");
	assert.equal(existsSync(blockedJoinMarker), false);

	// 7. Outbound delivery failure sets delivery="failed", delivery_error, and edge_deliveries state="failed"
	const fDeliv = serviceFixture(t, ["second"]);
	const runDeliv = await fDeliv.service.generate({
		topology: "graph",
		task: "Command delivery failure recorded",
		project_cwd: fDeliv.cwd,
		agents: [
			{ kind: "command", node_id: "src_cmd", command: process.execPath, args: ["-e", "process.exit(0)"] },
			{ node_id: "dst_agent", persona: "second", sub_task: "Receive", depends_on: ["src_cmd"] },
		],
	}, model);
	const srcEntry = runDeliv.pane_manifest[0];
	const drvDeliv = createCommandDriver(join(runDeliv.session_dir, `${srcEntry.instance_id}.config.json`), {
		skipComsServer: true,
		sendComs: async () => ({ delivered: false, error: "simulated coms down" }),
	});
	await drvDeliv.start();
	await drvDeliv.beforeStart();
	await drvDeliv.waitUntilSettled();
	const delivComp = readJson<{ delivery: string; delivery_error?: string; edge_deliveries?: Record<string, { state: string; error?: string }> }>(
		resultPath(runDeliv.session_dir, srcEntry.instance_id),
	);
	assert.equal(delivComp.delivery, "failed");
	assert.match(delivComp.delivery_error ?? "", /simulated coms down/);
	const dstEntry = runDeliv.pane_manifest[1];
	assert.equal(delivComp.edge_deliveries?.[dstEntry.instance_id]?.state, "failed");

	// 8. sourceExpectation verifies upstream command kind & command_evidence even when roster omits command metadata (falls back to manifest.json)
	const dstCfg = readJson<WorkerConfig>(join(runDeliv.session_dir, `${dstEntry.instance_id}.config.json`));
	dstCfg.roster = dstCfg.roster?.map(r => ({ instance_id: r.instance_id, node_id: r.node_id, persona_name: r.persona_name, sub_task: r.sub_task }));
	const expFromManifest = sourceExpectation(dstCfg, srcEntry.instance_id);
	assert.equal(expFromManifest.kind, "command");
	assert.equal(expFromManifest.command, process.execPath);
	assert.throws(() => parseCompletion({
		version: COMMAND_VERSION,
		identity: { run_id: runDeliv.task_id, node_id: "src_cmd", persona_name: "src_cmd", attempt_id: srcEntry.attempt_id!, instance_id: srcEntry.instance_id },
		result: { agent_name: "src_cmd", node_id: "src_cmd", status: "success", summary: "ok", detail: "ok" },
		delivery: "sent",
		completed_at: new Date().toISOString(),
	}, expFromManifest), /missing command_evidence/i);
});

test("N1: cancelling a factory or standalone waiting command node leaves live runner to settle cleanly without SIGKILL", async t => {
	const f = serviceFixture(t, ["first"], { independentStateRoots: true });
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const spawnedRunners: ReturnType<typeof spawn>[] = [];
	t.after(() => {
		for (const p of spawnedRunners) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. Factory run: upstream agent + waiting command node -> cancel_run must NOT SIGKILL waiting command runner; settles clean cancelled with no operator clearance.
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "coord.sqlite") });
	const factory = open()({
		action: "publish",
		name: "cmd-wait-cancel",
		draft: {
			topology: "graph",
			task: "Cancel waiting command in factory",
			project_cwd: f.cwd,
			agents: [
				{ node_id: "prep", persona: "first", sub_task: "Prep" },
				{
					kind: "command",
					node_id: "wait_cmd",
					depends_on: ["prep"],
					command: process.execPath,
					args: ["-e", "console.log('should not run')"],
				},
			],
		},
		sessionModel: { ...model, thinkingLevel: "medium" },
	});
	const authority = createManagerAuthority({ pi_session_id: "mgr-n1", pi_session_file: join(f.root, "mgr-n1.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "wait-1", brief: "Brief 1", authority });
	const launch = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	const launchDir = join(f.cwd, ".pi", "agent-sessions", launch.task_id);
	const launchManifest = f.service.status(launch.task_id).manifest;

	const prepEntry = launchManifest.pane_manifest.find(e => e.node_id === "prep")!;
	const cmdEntry = launchManifest.pane_manifest.find(e => e.node_id === "wait_cmd")!;
	const prepWorker = workerFromConfig(t, join(launchDir, `${prepEntry.instance_id}.config.json`), { model });
	await prepWorker.start();
	await prepWorker.beforeStart();

	rmSync(join(launchDir, `${cmdEntry.instance_id}.ready.json`), { force: true });
	const pWait = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(launchDir, `${cmdEntry.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pWait);
	let runnerExitedWithSigkill = false;
	const runnerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
		pWait.once("exit", (code, signal) => {
			if (signal === "SIGKILL") runnerExitedWithSigkill = true;
			resolveExit({ code, signal });
		});
	});
	for (let i = 0; i < 80; i++) {
		if (existsSync(join(launchDir, `${cmdEntry.instance_id}.ready.json`))) {
			try {
				const r = readJson<{ pid: number }>(join(launchDir, `${cmdEntry.instance_id}.ready.json`));
				if (r.pid === pWait.pid) break;
			} catch { /* wait */ }
		}
		await delay(25);
	}
	assert.equal(readJson<{ pid: number }>(join(launchDir, `${cmdEntry.instance_id}.ready.json`)).pid, pWait.pid);

	const cancelRes = await open()({
		action: "cancel_run",
		factory_id: factory.factory_id,
		input_id: launch.input_id,
		attempt_id: launch.attempt_id,
		task_id: launch.task_id,
		authority,
		confirm: async () => true,
	});
	assert.equal(cancelRes.cancelled, true);

	// Live runner must exit cleanly on its own (code 0, NOT SIGKILL) and write its own cancelled disposition.
	const exitInfo = await Promise.race([
		runnerExit,
		delay(5000).then(() => { throw new Error("Waiting command runner did not exit after factory cancel"); }),
	]);
	assert.equal(runnerExitedWithSigkill, false, "cancelFactoryRun must NEVER SIGKILL a live waiting command runner");
	assert.equal(exitInfo.signal, null);
	assert.equal(exitInfo.code, 0);
	const cmdDisp = parseDisposition(readJson(dispositionPath(launchDir, cmdEntry.instance_id)), { run_id: launch.task_id, instance_id: cmdEntry.instance_id });
	assert.equal(cmdDisp.state, "cancelled");
	assert.doesNotMatch(cmdDisp.reason, /orphaned command process group/);

	// Now settle the prep agent too so the whole run settles cleanly with zero operator clearance.
	await prepWorker.hooks.get("agent_settled")!({ aborted: true });
	const obs = open()({ action: "inspect", factory_id: factory.factory_id });
	const settlement = obs.attempts[0].settlement!;
	assert.equal(settlement.execution_settlement.state, "settled", settlement.execution_settlement.reason);
	assert.equal(settlement.outcome, "cancelled");
	assert.deepEqual(settlement.resume_risk, []);
	const settled = await open()({ action: "settle_run", factory_id: factory.factory_id, authority });
	assert.equal(settled.settled, true, settled.reason);
	const afterSettle = open()({ action: "inspect", factory_id: factory.factory_id });
	assert.equal(afterSettle.capacity.factory_slot, "free");
	assert.equal(afterSettle.capacity.checkout_slot, "free");

	// 2. Standalone direct cancel path: waiting live command runner is NOT SIGKILLed and does NOT record "stopped orphaned command process group".
	const standalone = await f.service.generate({
		topology: "graph",
		task: "Standalone cancel waiting command",
		project_cwd: f.cwd,
		agents: [
			{ node_id: "upstream", persona: "first", sub_task: "Upstream" },
			{ kind: "command", node_id: "cmd_wait", depends_on: ["upstream"], command: process.execPath, args: ["-e", "process.exit(0)"] },
		],
	}, model);
	const sCmd = standalone.pane_manifest.find(e => e.node_id === "cmd_wait")!;
	rmSync(join(standalone.session_dir, `${sCmd.instance_id}.ready.json`), { force: true });
	const pStandalone = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", join(standalone.session_dir, `${sCmd.instance_id}.config.json`)], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pStandalone);
	let standaloneSigkill = false;
	const standaloneExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
		pStandalone.once("exit", (code, signal) => {
			if (signal === "SIGKILL") standaloneSigkill = true;
			resolveExit({ code, signal });
		});
	});
	for (let i = 0; i < 80; i++) {
		if (existsSync(join(standalone.session_dir, `${sCmd.instance_id}.ready.json`))) {
			try {
				if (readJson<{ pid: number }>(join(standalone.session_dir, `${sCmd.instance_id}.ready.json`)).pid === pStandalone.pid) break;
			} catch { /* wait */ }
		}
		await delay(25);
	}
	const directCancel = await f.service.cancel(standalone.task_id, { reason: "stop waiting standalone", cwd: f.cwd });
	assert.ok(directCancel.cancelled.includes("cmd_wait"));
	const stExit = await Promise.race([
		standaloneExit,
		delay(5000).then(() => { throw new Error("Standalone waiting runner did not exit after cancel"); }),
	]);
	assert.equal(standaloneSigkill, false, "direct cancel must not SIGKILL live waiting runner");
	assert.equal(stExit.signal, null);
	const directDisp = parseDisposition(readJson(dispositionPath(standalone.session_dir, sCmd.instance_id)), { run_id: standalone.task_id, instance_id: sCmd.instance_id });
	assert.equal(directDisp.state, "cancelled");
	assert.equal(directDisp.reason, "stop waiting standalone");
});

test("N2: mixed review-loop + command-node v7 run finalizes, auto-cleans, manually cleans, and recovers transitions", async t => {
	const { finishReviewFinalizations, finalizePath, readFinalization } = await import("./review-loop.ts");
	const postMarker = join(tmpdir(), `cmd-after-review-${Date.now()}.txt`);
	t.after(() => rmSync(postMarker, { force: true }));

	// 1. E2E mixed review loop (agent build -> agent reviewer -> command node) with rejection, revision, approval, and auto-cleanup.
	const fAuto = await runFixture(t, {
		topology: "graph",
		task: "Mixed v7 review loop + command node",
		cleanup: "on_success",
		cleanup_settle_ms: 0,
		agents: [
			{ node_id: "build", persona: "first", sub_task: "Build feature" },
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review feature",
				output_contract: {
					required_fields: ["verdict"],
					properties: { verdict: { type: "string", enum: ["approve", "revise"] } },
				},
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
			},
			{
				kind: "command",
				node_id: "package_cmd",
				depends_on: ["review"],
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(postMarker)}, "packaged"); console.log(JSON.stringify({ packaged: true }))`],
			},
		],
	});

	const build = fAuto.nodes.get("build")!;
	const review = fAuto.nodes.get("review")!;
	const pkg = fAuto.nodes.get("package_cmd")!;

	// Attempt 1: build -> review rejects -> revision to build.2 -> review.2 approves -> package_cmd runs
	await build.complete({ status: "success", summary: "Draft 1", detail: "v1" });
	await review.deliverNotification(build);
	await review.complete({ status: "success", summary: "Needs fixes", detail: "revise", outputs: { verdict: "revise" } });
	await build.deliverNotification(review);
	await build.complete({ status: "success", summary: "Draft 2", detail: "v2" });
	await review.deliverNotification(build);
	await review.complete({ status: "success", summary: "Approved", detail: "lgtm", outputs: { verdict: "approve" } });
	await pkg.deliverNotification(review);

	assert.equal(existsSync(postMarker), true, "command node downstream of approved review loop must run");
	const beforeClean = fAuto.status();
	assert.equal(beforeClean.manifest.version, COMMAND_VERSION);
	assert.equal(beforeClean.outcome.state, "succeeded");
	assert.equal(beforeClean.agents.find(a => a.node_id === "package_cmd")?.execution, "succeeded");

	// Auto-cleanup must succeed (NOT error / cleanup-incomplete due to v7 vs v6 mismatch).
	const afterAuto = await fAuto.service.statusWithCleanup(fAuto.run.task_id, fAuto.cwd);
	assert.equal(afterAuto.manifest.status, "cleaned", JSON.stringify(afterAuto.manifest.cleanup_errors));
	assert.deepEqual(afterAuto.manifest.cleanup_errors ?? [], []);

	// 2. Manual cleanup + interrupted transition recovery on a v7 mixed review-loop + command-node run.
	const fMan = await runFixture(t, {
		topology: "graph",
		task: "Mixed v7 manual cleanup and transition recovery",
		cleanup: "manual",
		agents: [
			{ node_id: "build", persona: "first", sub_task: "Build" },
			{
				node_id: "review",
				persona: "second",
				depends_on: ["build"],
				sub_task: "Review",
				output_contract: {
					required_fields: ["verdict"],
					properties: { verdict: { type: "string", enum: ["approve", "revise"] } },
				},
				decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 },
			},
			{
				kind: "command",
				node_id: "after_cmd",
				depends_on: ["review"],
				command: process.execPath,
				args: ["-e", 'console.log(JSON.stringify({ ok: true }))'],
			},
		],
	});
	const mBuild = fMan.nodes.get("build")!;
	const mReview = fMan.nodes.get("review")!;
	const mCmd = fMan.nodes.get("after_cmd")!;
	await mBuild.complete({ status: "success", summary: "B1", detail: "ok" });
	await mReview.deliverNotification(mBuild);
	await mReview.complete({ status: "success", summary: "OK", detail: "ok", outputs: { verdict: "approve" } });
	await mCmd.deliverNotification(mReview);

	const loop = fMan.run.review_plan!.loops[0];
	// Simulate interrupted finalize.json publication (transition record exists, finalize.json missing) -> recovery + finishReviewFinalizations + cleanup must all accept v7!
	rmSync(finalizePath(fMan.run.session_dir, loop.reviewer), { force: true });
	rmSync(finalizePath(fMan.run.session_dir, loop.target), { force: true });
	const recovered = readFinalization(fMan.run.session_dir, fMan.run.task_id, loop, loop.reviewer, fMan.run.topology, fMan.run.manifest?.version ?? COMMAND_VERSION);
	assert.ok(recovered, "readFinalization must recover v7 transition finalization");
	assert.equal(recovered?.attempt_id, `${loop.reviewer}.1`);
	// Also test without passing version explicitly (manifest.json inspection fallback).
	assert.ok(readFinalization(fMan.run.session_dir, fMan.run.task_id, loop, loop.reviewer));
	assert.doesNotThrow(() => finishReviewFinalizations(fMan.run.session_dir, fMan.run.task_id, fMan.run.review_plan!));
	const cleanedMan = await fMan.service.cleanup(fMan.run.task_id, undefined, false, fMan.cwd);
	assert.equal(cleanedMan.status, "cleaned", JSON.stringify(cleanedMan.cleanup_errors));
});

test("R1: restarted runner with cancel record kills live orphan before recording cancelled and releasing ownership; unkillable orphan or corrupt ownership records needs_attention", async t => {
	const f = serviceFixture(t, []);
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const spawnedRunners: ReturnType<typeof spawn>[] = [];
	const trackedPids: number[] = [];
	t.after(() => {
		for (const pid of trackedPids) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
		for (const p of spawnedRunners) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. Real runner spawns long-lived child -> SIGKILL runner -> writeCancelRecord -> verify ownership still held while orphan lives -> restart runner -> kills orphan, releases ownership, records cancelled.
	const r1PidFile = join(f.cwd, "r1-orphan.pid");
	const r1Run = await f.service.generate({
		topology: "graph",
		task: "R1 restart with cancel record and live orphan",
		cancel_grace_ms: 40,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "r1_cmd",
			write_paths: ["r1-owned.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(r1PidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
		}],
	});
	const r1Entry = r1Run.pane_manifest[0];
	const r1CfgPath = join(r1Run.session_dir, `${r1Entry.instance_id}.config.json`);
	rmSync(join(r1Run.session_dir, `${r1Entry.instance_id}.ready.json`), { force: true });
	const pR1 = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", r1CfgPath], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pR1);
	for (let i = 0; i < 80 && !existsSync(r1PidFile); i++) await delay(25);
	assert.equal(existsSync(r1PidFile), true);
	const r1OrphanPid = Number(readFileSync(r1PidFile, "utf8").trim());
	trackedPids.push(r1OrphanPid);
	assert.equal(pidAlive(r1OrphanPid), true);

	process.kill(pR1.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pR1.once("exit", () => resolveExit()));
	assert.equal(pidAlive(r1OrphanPid), true);

	writeCancelRecord(r1Run.session_dir, {
		identity: { run_id: r1Run.task_id, node_id: r1Entry.node_id, persona_name: r1Entry.persona_name, attempt_id: r1Entry.attempt_id, instance_id: r1Entry.instance_id },
		scope: "node",
		reason: "operator cancelled after runner crash",
		requestedAt: new Date().toISOString(),
		graceMs: 40,
	});
	// While orphan is still alive, conflicting writer must NOT be admitted.
	const contenderWhileAlive = evaluateOwnershipDependencies({
		sessionDir: r1Run.session_dir,
		taskId: r1Run.task_id,
		nodeId: "contender",
		personaName: "second",
		writePaths: ["r1-owned.txt"],
		waitingFor: [r1Entry.instance_id],
		topology: "graph",
		instanceId: "a2-contender",
		roster: [
			{
				instance_id: r1Entry.instance_id, node_id: r1Entry.node_id, persona_name: r1Entry.persona_name,
				kind: "command", command: r1Entry.command!, args: r1Entry.args ?? [], working_directory: r1Entry.working_directory!,
				write_paths: ["r1-owned.txt"], sub_task: "R1",
			},
			{ instance_id: "a2-contender", node_id: "contender", persona_name: "second", write_paths: ["r1-owned.txt"], sub_task: "Contend" },
		],
	});
	assert.equal(contenderWhileAlive.admitted, false, "ownership must NOT release while orphan command child is alive");

	const dR1Restart = createCommandDriver(r1CfgPath, { skipComsServer: true, pollMs: 10 });
	await dR1Restart.start();
	await dR1Restart.waitUntilSettled();
	for (let i = 0; i < 20 && pidAlive(r1OrphanPid); i++) await delay(25);
	assert.equal(pidAlive(r1OrphanPid), false, "restarted runner with cancel record MUST kill+verify live orphan before recording cancelled");
	const r1Disp = parseDisposition(readJson(dispositionPath(r1Run.session_dir, r1Entry.instance_id)), { run_id: r1Run.task_id, instance_id: r1Entry.instance_id });
	assert.equal(r1Disp.state, "cancelled");
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(r1Run.session_dir, r1Entry.instance_id)), { run_id: r1Run.task_id, instance_id: r1Entry.instance_id }).state, "released");
	assert.equal(evaluateOwnershipDependencies({
		sessionDir: r1Run.session_dir,
		taskId: r1Run.task_id,
		nodeId: "contender",
		personaName: "second",
		writePaths: ["r1-owned.txt"],
		waitingFor: [r1Entry.instance_id],
		topology: "graph",
		instanceId: "a2-contender",
		roster: [
			{
				instance_id: r1Entry.instance_id, node_id: r1Entry.node_id, persona_name: r1Entry.persona_name,
				kind: "command", command: r1Entry.command!, args: r1Entry.args ?? [], working_directory: r1Entry.working_directory!,
				write_paths: ["r1-owned.txt"], sub_task: "R1",
			},
			{ instance_id: "a2-contender", node_id: "contender", persona_name: "second", write_paths: ["r1-owned.txt"], sub_task: "Contend" },
		],
	}).admitted, true);

	// 2. Unkillable/unverified orphan on restart with cancel record -> needs_attention (never cancelled) and ownership stays held.
	const r1FailPidFile = join(f.cwd, "r1-unkillable.pid");
	const r1FailRun = await f.service.generate({
		topology: "graph",
		task: "R1 unkillable orphan with cancel record",
		cancel_grace_ms: 20,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "r1_unkill_cmd",
			write_paths: ["r1-unkill.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(r1FailPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
		}],
	});
	const r1fEntry = r1FailRun.pane_manifest[0];
	const r1fCfgPath = join(r1FailRun.session_dir, `${r1fEntry.instance_id}.config.json`);
	rmSync(join(r1FailRun.session_dir, `${r1fEntry.instance_id}.ready.json`), { force: true });
	const pR1f = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", r1fCfgPath], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pR1f);
	for (let i = 0; i < 80 && !existsSync(r1FailPidFile); i++) await delay(25);
	const r1fOrphanPid = Number(readFileSync(r1FailPidFile, "utf8").trim());
	trackedPids.push(r1fOrphanPid);
	process.kill(pR1f.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pR1f.once("exit", () => resolveExit()));
	writeCancelRecord(r1FailRun.session_dir, {
		identity: { run_id: r1FailRun.task_id, node_id: r1fEntry.node_id, persona_name: r1fEntry.persona_name, attempt_id: r1fEntry.attempt_id, instance_id: r1fEntry.instance_id },
		scope: "node",
		reason: "cancel unkillable",
		requestedAt: new Date().toISOString(),
		graceMs: 20,
	});
	const dR1Fail = createCommandDriver(r1fCfgPath, {
		skipComsServer: true,
		pollMs: 10,
		killProcessGroup: async () => false,
		processGroupAlive: () => true,
	});
	await dR1Fail.start();
	await dR1Fail.waitUntilSettled();
	const r1fDisp = parseDisposition(readJson(dispositionPath(r1FailRun.session_dir, r1fEntry.instance_id)), { run_id: r1FailRun.task_id, instance_id: r1fEntry.instance_id });
	assert.equal(r1fDisp.state, "needs_attention", "unverified orphan kill MUST record needs_attention, never cancelled");
	assert.match(r1fDisp.reason, /found live orphaned process group .* and could not confirm termination/);
	assert.equal(existsSync(join(r1FailRun.session_dir, `${r1fEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(r1FailRun.session_dir, r1fEntry.instance_id)), { run_id: r1FailRun.task_id, instance_id: r1fEntry.instance_id }).state, "admitted");

	// 3. Corrupt ownership record on restart + cancel -> fails closed as needs_attention, never records cancelled.
	const r1CorruptOwn = await f.service.generate({
		topology: "graph",
		task: "R1 corrupt ownership on restart cancel",
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "r1_corrupt_own",
			write_paths: ["r1-corrupt.txt"],
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
		}],
	});
	const r1cEntry = r1CorruptOwn.pane_manifest[0];
	writeFileSync(ownershipPath(r1CorruptOwn.session_dir, r1cEntry.instance_id), "{corrupt-ownership");
	writeCancelRecord(r1CorruptOwn.session_dir, {
		identity: { run_id: r1CorruptOwn.task_id, node_id: r1cEntry.node_id, persona_name: r1cEntry.persona_name, attempt_id: r1cEntry.attempt_id, instance_id: r1cEntry.instance_id },
		scope: "node",
		reason: "cancel corrupt own",
		requestedAt: new Date().toISOString(),
		graceMs: 20,
	});
	const dR1Corrupt = createCommandDriver(join(r1CorruptOwn.session_dir, `${r1cEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	await dR1Corrupt.start();
	await dR1Corrupt.waitUntilSettled();
	const r1cDisp = parseDisposition(readJson(dispositionPath(r1CorruptOwn.session_dir, r1cEntry.instance_id)), { run_id: r1CorruptOwn.task_id, instance_id: r1cEntry.instance_id });
	assert.equal(r1cDisp.state, "needs_attention");
	assert.match(r1cDisp.reason, /Cannot release ownership record/);
});

test("Restart pgid guards: restarted root pgid, damaged pgid on restart, and unkillable orphan reason", async t => {
	const f = serviceFixture(t, ["first", "second"]);
	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const runnerPath = join(extensionDir, "bootstrap", "command-runner.ts");
	const spawnedRunners: ReturnType<typeof spawn>[] = [];
	const trackedPids: number[] = [];
	t.after(() => {
		for (const pid of trackedPids) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
		for (const p of spawnedRunners) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. Restarted root runner while orphaned command is alive kills+verifies orphan, records needs_attention, holds ownership, never starts second copy.
	const orphanPidFile = join(f.cwd, "root-orphan.pid");
	const runCountFile = join(f.cwd, "root-run-count.txt");
	const runRootRestart = await f.service.generate({
		topology: "graph",
		task: "Restarted root runner kills orphan and fails closed",
		cancel_grace_ms: 40,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "root_cmd",
			write_paths: ["root-owned.txt"],
			command: process.execPath,
			args: ["-e", `
				const fs = require("node:fs");
				fs.appendFileSync(${JSON.stringify(runCountFile)}, "1\\n");
				fs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(process.pid));
				setInterval(() => {}, 1000);
			`],
		}],
	});
	const rrEntry = runRootRestart.pane_manifest[0];
	const rrCfgPath = join(runRootRestart.session_dir, `${rrEntry.instance_id}.config.json`);
	rmSync(join(runRootRestart.session_dir, `${rrEntry.instance_id}.ready.json`), { force: true });
	const pRoot1 = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--bootstrap-worker-config", rrCfgPath], { cwd: f.cwd, stdio: "ignore" });
	spawnedRunners.push(pRoot1);
	for (let i = 0; i < 80 && !existsSync(orphanPidFile); i++) await delay(50);
	assert.equal(existsSync(orphanPidFile), true);
	const orphanPid = Number(readFileSync(orphanPidFile, "utf8").trim());
	trackedPids.push(orphanPid);
	assert.equal(pidAlive(orphanPid), true);
	const originalPgRaw = readFileSync(commandProcessGroupPath(runRootRestart.session_dir, rrEntry.instance_id), "utf8");
	process.kill(pRoot1.pid!, "SIGKILL");
	await new Promise<void>(resolveExit => pRoot1.once("exit", () => resolveExit()));
	assert.equal(pidAlive(orphanPid), true);

	const dRoot2 = createCommandDriver(rrCfgPath, { skipComsServer: true, pollMs: 10 });
	await dRoot2.start();
	let rrTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			dRoot2.waitUntilSettled(),
			new Promise<never>((_, reject) => {
				rrTimer = setTimeout(() => reject(new Error("Restarted root runner with existing .pgid.json did not settle promptly as needs_attention")), 2000);
			}),
		]);
	} finally {
		if (rrTimer) clearTimeout(rrTimer);
	}
	for (let i = 0; i < 20 && pidAlive(orphanPid); i++) await delay(25);
	const rrDisp = parseDisposition(readJson(dispositionPath(runRootRestart.session_dir, rrEntry.instance_id)), { run_id: runRootRestart.task_id, instance_id: rrEntry.instance_id });
	assert.equal(pidAlive(orphanPid), false, `restarted root runner must kill+verify orphaned child pgid (disp=${JSON.stringify(rrDisp)})`);
	assert.equal(readFileSync(runCountFile, "utf8").trim(), "1", "restarted root runner must NOT spawn a second copy");
	assert.equal(readFileSync(commandProcessGroupPath(runRootRestart.session_dir, rrEntry.instance_id), "utf8"), originalPgRaw);
	assert.equal(rrDisp.state, "needs_attention");
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(runRootRestart.session_dir, rrEntry.instance_id)), { run_id: runRootRestart.task_id, instance_id: rrEntry.instance_id }).state, "admitted");

	// 2. restart-pg-parse-skip: damaged .pgid.json on restart settles promptly as needs_attention and keeps ownership held.
	const badPgRun = await f.service.generate({
		topology: "graph",
		task: "Damaged pgid on restart fails closed",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "bad_pg_cmd", write_paths: ["badpg.txt"], command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const badPgEntry = badPgRun.pane_manifest[0];
	atomicJson(ownershipPath(badPgRun.session_dir, badPgEntry.instance_id), ownershipRecord({
		identity: { run_id: badPgRun.task_id, node_id: badPgEntry.node_id, persona_name: badPgEntry.persona_name, attempt_id: badPgEntry.attempt_id!, instance_id: badPgEntry.instance_id },
		write_paths: ["badpg.txt"], state: "admitted",
	}));
	writeFileSync(commandProcessGroupPath(badPgRun.session_dir, badPgEntry.instance_id), "{corrupt-pgid");
	const dBadPg = createCommandDriver(join(badPgRun.session_dir, `${badPgEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	await dBadPg.start();
	let badPgTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			dBadPg.waitUntilSettled(),
			new Promise<never>((_, reject) => {
				badPgTimer = setTimeout(() => reject(new Error("Restarted runner with damaged .pgid.json did not settle promptly as needs_attention")), 2000);
			}),
		]);
	} finally {
		if (badPgTimer) clearTimeout(badPgTimer);
	}
	const badPgDisp = parseDisposition(readJson(dispositionPath(badPgRun.session_dir, badPgEntry.instance_id)), { run_id: badPgRun.task_id, instance_id: badPgEntry.instance_id });
	assert.equal(badPgDisp.state, "needs_attention");
	assert.match(badPgDisp.reason, /unusable process group record on restart/);
	assert.equal(existsSync(join(badPgRun.session_dir, `${badPgEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(badPgRun.session_dir, badPgEntry.instance_id)), { run_id: badPgRun.task_id, instance_id: badPgEntry.instance_id }).state, "admitted");

	// 3. restart-pg-killfail-ok: unkillable orphan on restart (no cancel record) asserts exact needs_attention reason.
	const ukRun = await f.service.generate({
		topology: "graph",
		task: "Unkillable orphan on restart asserts reason",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "uk_cmd", write_paths: ["uk.txt"], command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const ukEntry = ukRun.pane_manifest[0];
	atomicJson(ownershipPath(ukRun.session_dir, ukEntry.instance_id), ownershipRecord({
		identity: { run_id: ukRun.task_id, node_id: ukEntry.node_id, persona_name: ukEntry.persona_name, attempt_id: ukEntry.attempt_id!, instance_id: ukEntry.instance_id },
		write_paths: ["uk.txt"], state: "admitted",
	}));
	atomicJson(commandProcessGroupPath(ukRun.session_dir, ukEntry.instance_id), {
		version: 1,
		identity: { run_id: ukRun.task_id, node_id: ukEntry.node_id, persona_name: ukEntry.persona_name, attempt_id: ukEntry.attempt_id!, instance_id: ukEntry.instance_id },
		pgid: 999991,
		started_at: new Date().toISOString(),
	});
	const dUk = createCommandDriver(join(ukRun.session_dir, `${ukEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		killProcessGroup: async () => false,
		processGroupAlive: () => true,
	});
	await dUk.start();
	await dUk.waitUntilSettled();
	const ukDisp = parseDisposition(readJson(dispositionPath(ukRun.session_dir, ukEntry.instance_id)), { run_id: ukRun.task_id, instance_id: ukEntry.instance_id });
	assert.equal(ukDisp.state, "needs_attention");
	assert.match(ukDisp.reason, /found live orphaned process group 999991 and could not confirm termination/);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(ukRun.session_dir, ukEntry.instance_id)), { run_id: ukRun.task_id, instance_id: ukEntry.instance_id }).state, "admitted");
});

test("pgid write fail-closed kills child immediately with SIGKILL (grace 0)", async t => {
	const f = serviceFixture(t, []);
	const trackedPids: number[] = [];
	t.after(() => {
		for (const pid of trackedPids) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
	});
	const pgFailMarker = join(f.cwd, "pgfail-ran.txt");
	const pgFailPidFile = join(f.cwd, "pgfail-child.pid");
	const pgFailRun = await f.service.generate({
		topology: "graph",
		task: "pgid write failure fails closed with immediate kill",
		cancel_grace_ms: 1000,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "pg_fail_cmd",
			write_paths: ["pgfail.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pgFailPidFile)}, String(process.pid)); setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(pgFailMarker)}, "ran"); }, 500);`],
		}],
	});
	const pgfEntry = pgFailRun.pane_manifest[0];
	const dPgFail = createCommandDriver(join(pgFailRun.session_dir, `${pgfEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		writeProcessGroup: () => { throw new Error("simulated EIO writing pgid"); },
	});
	await dPgFail.start();
	const t0 = Date.now();
	await dPgFail.beforeStart();
	await dPgFail.waitUntilSettled();
	const elapsed = Date.now() - t0;
	if (existsSync(pgFailPidFile)) trackedPids.push(Number(readFileSync(pgFailPidFile, "utf8").trim()));
	assert.ok(elapsed < 500, `pgid write failure must kill child immediately (grace 0), took ${elapsed}ms`);
	assert.equal(existsSync(pgFailMarker), false, "child must be killed immediately when .pgid.json write fails");
	const disp = parseDisposition(readJson(dispositionPath(pgFailRun.session_dir, pgfEntry.instance_id)), { run_id: pgFailRun.task_id, instance_id: pgfEntry.instance_id });
	assert.equal(disp.state, "needs_attention");
	assert.equal(disp.command_evidence?.signal, "SIGKILL");
	assert.equal(existsSync(join(pgFailRun.session_dir, `${pgfEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(pgFailRun.session_dir, pgfEntry.instance_id)), { run_id: pgFailRun.task_id, instance_id: pgfEntry.instance_id }).state, "admitted");
});

test("B1-abort: restarted runner with both release.json and abort.json does not run command and settles as needs_attention", async t => {
	const f = serviceFixture(t, []);
	const abortMarker = join(f.cwd, "abort-must-not-run.txt");
	const abortRun = await f.service.generate({
		topology: "graph",
		task: "Released run with abort.json refuses command on restart",
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "abort_root_cmd",
			write_paths: ["abort-owned.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(abortMarker)}, "ran");`],
		}],
	});
	const abortEntry = abortRun.pane_manifest[0];
	atomicJson(join(abortRun.session_dir, "abort.json"), { task_id: abortRun.task_id, token: abortRun.token, error: "Run cleaned up" });
	const dAbort = createCommandDriver(join(abortRun.session_dir, `${abortEntry.instance_id}.config.json`), { skipComsServer: false, pollMs: 10 });
	await dAbort.start();
	await dAbort.waitUntilSettled();
	assert.equal(existsSync(abortMarker), false, "command must NOT run when abort.json is present alongside release.json");
	assert.equal(existsSync(join(abortRun.session_dir, `${abortEntry.instance_id}.error.json`)), true);
	const st = f.service.status(abortRun.task_id, f.cwd);
	assert.equal(st.agents[0].execution, "needs_attention");
	assert.match(st.agents[0].execution_reason ?? "", /Dispatcher aborted/);
});

test("stop-race-order: force_close kills live runner before reading/killing pgid", async t => {
	const f = serviceFixture(t, []);
	const spawned: ReturnType<typeof spawn>[] = [];
	const tracked: number[] = [];
	t.after(() => {
		for (const pid of tracked) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
		for (const p of spawned) {
			try { if (p.pid) process.kill(p.pid, "SIGCONT"); } catch { /* ignore */ }
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	// Spawn a detached SIGTERM-ignoring child recorded in .pgid.json (so killProcessGroup takes ~200ms grace),
	// and a live runner process (ready.pid) that would create sneakyMarker after 40ms if not SIGKILLed first.
	const sneakyMarker = join(f.cwd, "sneaky-spawned.txt");
	const runRace = await f.service.generate({
		topology: "graph",
		task: "stop-race-order kills live runner first",
		cancel_grace_ms: 20,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "race_cmd",
			write_paths: ["race.txt"],
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000);"],
		}],
	});
	const raceEntry = runRace.pane_manifest[0];
	const childProc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { detached: true, stdio: "ignore" });
	spawned.push(childProc);
	tracked.push(childProc.pid!);
	const runnerProc = spawn(process.execPath, ["-e", `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(sneakyMarker)}, "late"); }, 40); setInterval(() => {}, 1000);`], { detached: true, stdio: "ignore" });
	spawned.push(runnerProc);
	tracked.push(runnerProc.pid!);

	const readyPathFile = join(runRace.session_dir, `${raceEntry.instance_id}.ready.json`);
	const prevReady = readJson<Record<string, unknown>>(readyPathFile);
	atomicJson(readyPathFile, { ...prevReady, pid: runnerProc.pid!, start_time: processStartTime(runnerProc.pid!) });
	atomicJson(commandProcessGroupPath(runRace.session_dir, raceEntry.instance_id), {
		version: 1,
		identity: { run_id: runRace.task_id, node_id: raceEntry.node_id, persona_name: raceEntry.persona_name, attempt_id: raceEntry.attempt_id!, instance_id: raceEntry.instance_id },
		pgid: childProc.pid!,
		...(processStartTime(childProc.pid!) ? { start_time: processStartTime(childProc.pid!) } : {}),
		started_at: new Date().toISOString(),
	});
	atomicJson(join(runRace.session_dir, `${raceEntry.instance_id}.progress.json`), {
		token: runRace.token, instance_id: raceEntry.instance_id, attempt_id: raceEntry.attempt_id, state: "working", updated_at: Date.now(),
	});

	const c1 = await f.service.cancel(runRace.task_id, { reason: "stop race", grace_ms: 20, cwd: f.cwd });
	assert.equal(c1.cancelling.length, 1);
	await delay(30);
	const c2 = await f.service.cancel(runRace.task_id, { reason: "force race", grace_ms: 200, force_close: true, cwd: f.cwd });
	assert.ok(c2.cancelled.includes("race_cmd"));
	assert.equal(pidAlive(runnerProc.pid!), false, "force_close MUST kill live runner pid in stopCommandProcessGroup");
	assert.equal(pidAlive(childProc.pid!), false, "force_close MUST kill child process group");
	assert.equal(existsSync(sneakyMarker), false, "runner MUST be killed BEFORE reading/waiting on .pgid.json");
});

test("Root start() and beforeStart() catch errors and settle promptly as needs_attention", async t => {
	const f = serviceFixture(t, []);

	// 1. exec-catch-rethrow (startRoot with skipComsServer: false)
	const goneDir1 = join(f.cwd, "gone-wd-1");
	mkdirSync(goneDir1, { recursive: true });
	const goneRun1 = await f.service.generate({
		topology: "graph",
		task: "exec-catch-rethrow startRoot",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "gone_cmd_1", working_directory: "gone-wd-1", command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const goneEntry1 = goneRun1.pane_manifest[0];
	rmSync(goneDir1, { recursive: true, force: true });
	const dGone1 = createCommandDriver(join(goneRun1.session_dir, `${goneEntry1.instance_id}.config.json`), { skipComsServer: false, pollMs: 10 });
	await dGone1.start();
	await Promise.race([
		dGone1.waitUntilSettled(),
		delay(2000).then(() => { throw new Error("Root command startRoot error was not caught and settled as needs_attention"); }),
	]);
	assert.equal(parseDisposition(readJson(dispositionPath(goneRun1.session_dir, goneEntry1.instance_id)), { run_id: goneRun1.task_id, instance_id: goneEntry1.instance_id }).state, "needs_attention");
	assert.equal(existsSync(join(goneRun1.session_dir, `${goneEntry1.instance_id}.error.json`)), true);

	// 2. exec-catch-rethrow-beforeStart (skipComsServer: true, error thrown during beforeStart)
	const goneDir2 = join(f.cwd, "gone-wd-2");
	mkdirSync(goneDir2, { recursive: true });
	const goneRun2 = await f.service.generate({
		topology: "graph",
		task: "exec-catch-rethrow beforeStart",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "gone_cmd_2", working_directory: "gone-wd-2", command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const goneEntry2 = goneRun2.pane_manifest[0];
	const dGone2 = createCommandDriver(join(goneRun2.session_dir, `${goneEntry2.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	await dGone2.start();
	rmSync(goneDir2, { recursive: true, force: true });
	await dGone2.beforeStart();
	await Promise.race([
		dGone2.waitUntilSettled(),
		delay(2000).then(() => { throw new Error("Root command beforeStart error was not caught and settled as needs_attention"); }),
	]);
	assert.equal(parseDisposition(readJson(dispositionPath(goneRun2.session_dir, goneEntry2.instance_id)), { run_id: goneRun2.task_id, instance_id: goneEntry2.instance_id }).state, "needs_attention");
	assert.equal(existsSync(join(goneRun2.session_dir, `${goneEntry2.instance_id}.error.json`)), true);
});

test("Env PWD/SSL_CERT allowlist and surviving mutant negative guards", async t => {
	const f = serviceFixture(t, ["first"]);
	const trackedPids: number[] = [];
	t.after(() => {
		for (const pid of trackedPids) {
			try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
		}
	});

	// 1. Env allowlist: PWD equals working_directory, SSL_CERT_FILE/SSL_CERT_DIR allowed, SSL_CERT_OTHER blocked.
	const subWd = join(f.cwd, "sub-wd");
	mkdirSync(subWd, { recursive: true });
	const prevSslFile = process.env.SSL_CERT_FILE;
	const prevSslDir = process.env.SSL_CERT_DIR;
	const prevSslOther = process.env.SSL_CERT_OTHER;
	process.env.SSL_CERT_FILE = "/tmp/ca.pem";
	process.env.SSL_CERT_DIR = "/tmp/certs";
	process.env.SSL_CERT_OTHER = "should-not-pass";
	try {
		const filtered = buildCommandEnv(process.env);
		assert.equal(filtered.SSL_CERT_FILE, "/tmp/ca.pem");
		assert.equal(filtered.SSL_CERT_DIR, "/tmp/certs");
		assert.equal(filtered.SSL_CERT_OTHER, undefined);
		const pwdRun = await f.service.generate({
			topology: "graph",
			task: "Check PWD and SSL_CERT allowlist",
			project_cwd: f.cwd,
			agents: [{
				kind: "command",
				node_id: "pwd_cmd",
				working_directory: "sub-wd",
				command: process.execPath,
				args: ["-e", "console.log(JSON.stringify({ pwd: process.env.PWD, cwd: process.cwd(), certFile: process.env.SSL_CERT_FILE ?? null, certOther: process.env.SSL_CERT_OTHER ?? null }))"],
			}],
		});
		const pwdEntry = pwdRun.pane_manifest[0];
		const dPwd = createCommandDriver(join(pwdRun.session_dir, `${pwdEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
		await dPwd.start();
		await dPwd.beforeStart();
		await dPwd.waitUntilSettled();
		const pwdOut = parseCompletion(readJson(resultPath(pwdRun.session_dir, pwdEntry.instance_id)), { run_id: pwdRun.task_id, instance_id: pwdEntry.instance_id, kind: "command", command: pwdEntry.command, args: pwdEntry.args, working_directory: pwdEntry.working_directory, version: COMMAND_VERSION }).result.outputs;
		assert.deepEqual(pwdOut, { pwd: realpathSync(subWd), cwd: realpathSync(subWd), certFile: "/tmp/ca.pem", certOther: null });
	} finally {
		if (prevSslFile === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = prevSslFile;
		if (prevSslDir === undefined) delete process.env.SSL_CERT_DIR; else process.env.SSL_CERT_DIR = prevSslDir;
		if (prevSslOther === undefined) delete process.env.SSL_CERT_OTHER; else process.env.SSL_CERT_OTHER = prevSslOther;
	}

	// 2. forceclose-kill-resultbranch (lifecycle.ts:4658): force_close: true on command node with existing cancelled disposition & corrupt .pgid.json fails closed.
	const fcDispRun = await f.service.generate({
		topology: "graph",
		task: "forceclose-kill-resultbranch guard",
		cancel_grace_ms: 10,
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "fc_res_cmd", command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const fcResEntry = fcDispRun.pane_manifest[0];
	await f.service.cancel(fcDispRun.task_id, { reason: "initial", grace_ms: 10, cwd: f.cwd });
	await delay(30);
	writeFileSync(commandProcessGroupPath(fcDispRun.session_dir, fcResEntry.instance_id), "{corrupt-pgid");
	const fcResCancel = await f.service.cancel(fcDispRun.task_id, { reason: "force after disp", grace_ms: 10, force_close: true, cwd: f.cwd });
	assert.ok((fcResCancel.record_errors ?? []).some(e => e.includes("unusable process group record")), JSON.stringify(fcResCancel));
	assert.deepEqual(fcResCancel.already_settled, []);

	// 3. killfail-as-cancelled (command-runner.ts:727): unverified kill on cancel must record needs_attention, NOT cancelled, and keep ownership held.
	const kfPidFile = join(f.cwd, "kf-child.pid");
	const kfRun = await f.service.generate({
		topology: "graph",
		task: "killfail-as-cancelled",
		cancel_grace_ms: 10,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "kf_cmd",
			write_paths: ["kf.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(kfPidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`],
		}],
	});
	const kfEntry = kfRun.pane_manifest[0];
	const dKf = createCommandDriver(join(kfRun.session_dir, `${kfEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		killProcessGroup: async () => false,
		processGroupAlive: () => true,
	});
	await dKf.start();
	const kfStartPromise = dKf.beforeStart();
	for (let i = 0; i < 80 && !existsSync(kfPidFile); i++) await delay(25);
	trackedPids.push(Number(readFileSync(kfPidFile, "utf8").trim()));
	writeCancelRecord(kfRun.session_dir, {
		identity: { run_id: kfRun.task_id, node_id: kfEntry.node_id, persona_name: kfEntry.persona_name, attempt_id: kfEntry.attempt_id, instance_id: kfEntry.instance_id },
		scope: "node",
		reason: "cancel unverified",
		requestedAt: new Date().toISOString(),
		graceMs: 10,
	});
	await kfStartPromise;
	await dKf.waitUntilSettled();
	const kfDisp = parseDisposition(readJson(dispositionPath(kfRun.session_dir, kfEntry.instance_id)), { run_id: kfRun.task_id, instance_id: kfEntry.instance_id });
	assert.equal(kfDisp.state, "needs_attention", "unverified kill on cancel MUST record needs_attention, never cancelled");
	assert.equal(kfDisp.command_evidence?.process_group_killed, undefined);
	assert.match(kfDisp.command_evidence?.termination_error ?? "", /could not be confirmed/);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(kfRun.session_dir, kfEntry.instance_id)), { run_id: kfRun.task_id, instance_id: kfEntry.instance_id }).state, "admitted");

	// 4. fake-sigkill (:657) & missing-exit-observation (:697).
	const noSigPidFile = join(f.cwd, "nosig-child.pid");
	const noSigRun = await f.service.generate({
		topology: "graph",
		task: "fake-sigkill and missing-exit-observation",
		task_timeout_ms: 100,
		cancel_grace_ms: 10,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "nosig_cmd",
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(noSigPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
		}],
	});
	const nsEntry = noSigRun.pane_manifest[0];
	const dNoSig = createCommandDriver(join(noSigRun.session_dir, `${nsEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		killProcessGroup: async () => false,
		processGroupAlive: () => false,
	});
	await dNoSig.start();
	await dNoSig.beforeStart();
	await dNoSig.waitUntilSettled();
	if (existsSync(noSigPidFile)) trackedPids.push(Number(readFileSync(noSigPidFile, "utf8").trim()));
	const nsRes = parseCompletion(readJson(resultPath(noSigRun.session_dir, nsEntry.instance_id)), { run_id: noSigRun.task_id, instance_id: nsEntry.instance_id, kind: "command", command: nsEntry.command, args: nsEntry.args, working_directory: nsEntry.working_directory, version: COMMAND_VERSION });
	assert.equal(nsRes.result.status, "failure");
	assert.equal(nsRes.result.command_evidence?.signal, null, "must never fabricate SIGKILL when exit is unobserved");
	assert.equal(nsRes.result.command_evidence?.exit_code, null);
	assert.equal(nsRes.result.command_evidence?.termination_error, "command exited without exit code or signal observation");

	// 5. termination-error-success (parseCompletion).
	const badSuccessEvidence = {
		version: 1, command: "echo", args: [], working_directory: f.cwd, exit_code: 0, signal: null,
		started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1,
		termination_error: "termination unconfirmed", stdout_bytes: 0, stderr_bytes: 0,
	};
	for (const kindOpt of ["command", undefined] as const) {
		assert.throws(() => parseCompletion({
			version: COMMAND_VERSION,
			identity: { run_id: "r1", node_id: "n1", persona_name: "n1", attempt_id: "a1", instance_id: "i1" },
			result: { agent_name: "n1", node_id: "n1", status: "success", summary: "ok", detail: "ok", command_evidence: badSuccessEvidence },
			delivery: "not_required",
			completed_at: new Date().toISOString(),
		}, { run_id: "r1", instance_id: "i1", ...(kindOpt ? { kind: kindOpt } : {}) }), /contradicts claimed success/);
	}

	// 6. shutdown-needs-attention (command-runner.ts:1393).
	const sdPidFile = join(f.cwd, "sd-child.pid");
	const sdRun = await f.service.generate({
		topology: "graph",
		task: "shutdown-needs-attention",
		cancel_grace_ms: 10,
		project_cwd: f.cwd,
		agents: [{
			kind: "command",
			node_id: "sd_cmd",
			write_paths: ["sd.txt"],
			command: process.execPath,
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sdPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
		}],
	});
	const sdEntry = sdRun.pane_manifest[0];
	const dSd = createCommandDriver(join(sdRun.session_dir, `${sdEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		killProcessGroup: async () => false,
	});
	await dSd.start();
	const sdRunPromise = dSd.beforeStart();
	for (let i = 0; i < 80 && !dSd.getActivePgid(); i++) await delay(25);
	trackedPids.push(dSd.getActivePgid()!);
	await dSd.shutdown("quit");
	assert.equal(parseDisposition(readJson(dispositionPath(sdRun.session_dir, sdEntry.instance_id)), { run_id: sdRun.task_id, instance_id: sdEntry.instance_id }).state, "needs_attention");
	assert.equal(existsSync(join(sdRun.session_dir, `${sdEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(sdRun.session_dir, sdEntry.instance_id)), { run_id: sdRun.task_id, instance_id: sdEntry.instance_id }).state, "admitted");
	try { process.kill(-dSd.getActivePgid()!, "SIGKILL"); } catch { /* ignore */ }
	await sdRunPromise;

	// 7. outcome-claim-damaged-cancel (command-runner.ts:787).
	const ocRun = await f.service.generate({
		topology: "graph",
		task: "outcome-claim-damaged-cancel",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "oc_cmd", write_paths: ["oc.txt"], command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const ocEntry = ocRun.pane_manifest[0];
	const { claimOutcome } = await import("./cancellation.ts");
	const dOc = createCommandDriver(join(ocRun.session_dir, `${ocEntry.instance_id}.config.json`), {
		skipComsServer: true,
		pollMs: 10,
		beforeOutcomeClaim: () => {
			claimOutcome(ocRun.session_dir, { run_id: ocRun.task_id, node_id: ocEntry.node_id, persona_name: ocEntry.persona_name, attempt_id: ocEntry.attempt_id, instance_id: ocEntry.instance_id }, "cancelled", new Date().toISOString(), ocEntry.instance_id);
			writeFileSync(join(ocRun.session_dir, `${ocEntry.instance_id}.cancel.json`), "{corrupt-cancel");
		},
	});
	await dOc.start();
	await dOc.beforeStart();
	await dOc.waitUntilSettled();
	assert.equal(parseDisposition(readJson(dispositionPath(ocRun.session_dir, ocEntry.instance_id)), { run_id: ocRun.task_id, instance_id: ocEntry.instance_id }).state, "needs_attention");
	assert.equal(existsSync(join(ocRun.session_dir, `${ocEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(ocRun.session_dir, ocEntry.instance_id)), { run_id: ocRun.task_id, instance_id: ocEntry.instance_id }).state, "admitted");

	// 8. post-commit-pending/no-catch (command-runner.ts:892-904).
	const pcRun = await f.service.generate({
		topology: "graph",
		task: "post-commit-pending catch",
		project_cwd: f.cwd,
		agents: [{ kind: "command", node_id: "pc_cmd", write_paths: ["pc.txt"], command: process.execPath, args: ["-e", "process.exit(0)"] }],
	});
	const pcEntry = pcRun.pane_manifest[0];
	writeFileSync(join(pcRun.session_dir, "upstream-index.json"), "{corrupt-upstream-index");
	const dPc = createCommandDriver(join(pcRun.session_dir, `${pcEntry.instance_id}.config.json`), { skipComsServer: true, pollMs: 10 });
	await dPc.start();
	await dPc.beforeStart();
	await dPc.waitUntilSettled();
	const pcRes = readJson<{ delivery: string; delivery_error?: string }>(resultPath(pcRun.session_dir, pcEntry.instance_id));
	assert.equal(pcRes.delivery, "failed");
	assert.match(pcRes.delivery_error ?? "", /Post-completion settlement failed/);
	assert.equal(existsSync(join(pcRun.session_dir, `${pcEntry.instance_id}.error.json`)), true);
	assert.equal(parseOwnershipRecord(readJson(ownershipPath(pcRun.session_dir, pcEntry.instance_id)), { run_id: pcRun.task_id, instance_id: pcEntry.instance_id }).state, "released");

	// 9. v7-manifest-requires-command (:973), v7-config-requires-command (:1034), roster-kind-fields (:1029).
	const agentGraph = await f.service.generate({
		topology: "graph",
		task: "Agent graph baseline",
		project_cwd: f.cwd,
		agents: [{ node_id: "a_only", persona: "first", sub_task: "Work" }],
	}, model);
	const agentManifest = readJson<BootstrapManifest>(join(agentGraph.session_dir, "manifest.json"));
	const agentConfig = readJson<WorkerConfig>(join(agentGraph.session_dir, `${agentGraph.pane_manifest[0].instance_id}.config.json`));
	assert.throws(() => parseManifest({ ...agentManifest, version: COMMAND_VERSION }, agentGraph.task_id), /requires at least one command node/);
	assert.throws(() => parseWorkerConfig({ ...agentConfig, version: COMMAND_VERSION }), /requires a command node/);
	assert.throws(() => parseWorkerConfig({
		...agentConfig,
		version: COMMAND_VERSION,
		roster: [{ instance_id: "i-cmd", node_id: "n-cmd", persona_name: "first", kind: "agent", command: "echo", sub_task: "Bad" }],
	}), /cannot carry command-only field command/);
	assert.throws(() => parseWorkerConfig({
		...agentConfig,
		roster: [{ instance_id: "i-cmd", node_id: "n-cmd", persona_name: "first", kind: "command", command: "echo", sub_task: "Bad" }],
	}), /require record version/);
});

test("Launcher Node resolution: non-node execPath uses real node on PATH and runs end-to-end via /bin/sh", async t => {
	const root = join(tmpdir(), `cmd-node-launcher-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const cwd = join(root, "project");
	const home = join(root, "home");
	const stateDir = join(root, "state");
	const runtimeBin = join(root, "runtime-bin");
	const pathBin = join(root, "path-bin");
	const nodeBin = join(root, "node-bin");
	for (const dir of [join(cwd, ".pi"), join(cwd, "extensions"), home, stateDir, runtimeBin, pathBin, nodeBin]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");

	// Fake pi binary that rejects unknown flags like --experimental-strip-types and --bootstrap-worker-config
	const fakePiPath = join(runtimeBin, "pi");
	const fakePiInvoked = join(root, "fake-pi-invoked");
	writeFileSync(fakePiPath, `#!/bin/sh
printf 'invoked:%s\\n' "$*" >> ${JSON.stringify(fakePiInvoked)}
for arg in "$@"; do
	case "$arg" in
		--experimental-strip-types|--bootstrap-worker-config)
			echo "Error: Unknown options: --experimental-strip-types, --bootstrap-worker-config" >&2
			exit 1
			;;
	esac
done
exit 0
`, { mode: 0o700 });

	// Real node symlinked into nodeBin (separate from pathBin where pi & herdr live)
	const realNodeSymlink = join(nodeBin, "node");
	symlinkSync(process.execPath, realNodeSymlink);
	writeFileSync(join(pathBin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(fakePiPath)} "$@"\n`, { mode: 0o700 });
	writeFileSync(join(pathBin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	const spawnedChildren: ReturnType<typeof spawn>[] = [];
	t.after(() => {
		for (const p of spawnedChildren) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});

	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
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
			// Actually execute the submitted /bin/sh launcher command in a child process!
			const shellCmd = args[3];
			const child = spawn("/bin/sh", ["-c", shellCmd], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PATH: `${pathBin}:${nodeBin}` },
			});
			spawnedChildren.push(child);
			return ok();
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};

	const service = new BootstrapService({
		exec,
		extensionDir,
		stateDir,
		home,
		pollMs: 10,
		execPath: fakePiPath,
		env: { PATH: `${pathBin}:${nodeBin}`, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	} as any);

	const marker = join(cwd, "ran-via-launcher.txt");
	const run = await service.generate({
		topology: "graph",
		task: "Run command node via generated .sh launcher",
		project_cwd: cwd,
		ready_timeout_ms: 5000,
		cleanup: "manual",
		agents: [
			{
				kind: "command",
				node_id: "check_readme",
				command: realNodeSymlink,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log(JSON.stringify({ ok: true }));`],
			},
		],
	});

	assert.equal(run.status, "applied");
	const entry = run.pane_manifest[0];
	const launcherText = readFileSync(join(run.session_dir, `${entry.instance_id}.sh`), "utf8");
	assert.equal(launcherText.includes(fakePiPath), false, `launcher must not exec non-node execPath (${fakePiPath}):\n${launcherText}`);
	assert.match(launcherText, new RegExp(`exec '${realNodeSymlink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' '--experimental-strip-types'`));
	assert.equal(existsSync(fakePiInvoked), false, "non-node execPath must not even be invoked when basename is not node/nodejs");

	// Wait for the real command-runner process launched by /bin/sh to finish
	for (let i = 0; i < 100; i++) {
		const st = service.status(run.task_id, cwd);
		if (st.agents[0]?.execution === "succeeded") break;
		await delay(50);
	}
	const finalStatus = service.status(run.task_id, cwd);
	assert.equal(finalStatus.outcome.state, "succeeded");
	assert.equal(readFileSync(marker, "utf8"), "ran");
	const rep = await service.report(run.task_id, undefined, true, buildMarkdownReport, cwd);
	assert.deepEqual(rep.results[0]?.outputs, { ok: true });
});

test("Launcher Node resolution guards: planning/readiness diagnostics, BOOTSTRAP_NODE override/rejection, stubbed-node fallback, and caching", async t => {
	const root = join(tmpdir(), `cmd-node-guards-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const cwd = join(root, "project");
	const home = join(root, "home");
	const emptyBin = join(root, "empty-bin");
	const badPathBin = join(root, "bad-path-bin");
	const silentPathBin = join(root, "silent-path-bin");
	const fakeNodeExecDir = join(root, "fake-node-exec");
	const overrideDir = join(root, "override-dir");
	for (const dir of [join(cwd, ".pi", "agents"), join(cwd, "extensions"), home, emptyBin, badPathBin, silentPathBin, fakeNodeExecDir, overrideDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	writeFileSync(join(cwd, ".pi", "agents", "first.md"), "---\nname: first\ntools: read\n---\nAgent first\n");

	const fakePiPath = join(root, "fake-pi");
	writeFileSync(fakePiPath, `#!/bin/sh
echo "Error: Unknown options: $*" >&2
exit 1
`, { mode: 0o700 });
	const silentScript = join(root, "silent-bin");
	writeFileSync(silentScript, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const oldNodeScript = join(root, "old-node");
	writeFileSync(oldNodeScript, "#!/bin/sh\necho 'v20.11.0'\n", { mode: 0o700 });
	const node24Script = join(root, "node-24");
	writeFileSync(node24Script, "#!/bin/sh\necho 'v24.11.0'\n", { mode: 0o700 });
	const badNodeInPath = join(badPathBin, "node");
	writeFileSync(badNodeInPath, "#!/bin/sh\necho 'bad option: --experimental-strip-types' >&2\nexit 9\n", { mode: 0o700 });
	writeFileSync(join(silentPathBin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

	for (const dir of [emptyBin, badPathBin, silentPathBin]) {
		writeFileSync(join(dir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	}

	const extensionDir = realpathSync(join(import.meta.dirname, ".."));
	let herdrCalls = 0;
	const spawnedChildren: ReturnType<typeof spawn>[] = [];
	t.after(() => {
		for (const p of spawnedChildren) {
			try { if (p.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* ignore */ }
			try { p.kill("SIGKILL"); } catch { /* ignore */ }
		}
	});
	const tabs: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; cwd: string }> = [];
	let seq = 0;
	const makeExec = (runEnvPath: string) => async (_command: string, args: string[]): Promise<ExecResult> => {
		herdrCalls++;
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const tab = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label: args[args.indexOf("--label") + 1], cwd: args[args.indexOf("--cwd") + 1] };
			tabs.push(tab);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const child = spawn("/bin/sh", ["-c", args[3]], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PATH: runEnvPath },
			});
			spawnedChildren.push(child);
			return ok();
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "origin-workspace" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: tabs });
		if ((args[0] === "tab" || args[0] === "pane") && args[1] === "close") return ok();
		throw new Error(`Unexpected herdr command: ${args.join(" ")}`);
	};

	const cmdReq = {
		topology: "graph" as const,
		task: "Guard command node",
		project_cwd: cwd,
		cleanup: "manual" as const,
		agents: [{ kind: "command" as const, node_id: "cmd_guard", command: process.execPath, args: ["-e", "console.log(JSON.stringify({ ok: true }))"] }],
	};

	// 1. No usable node anywhere (non-node execPath + no node on PATH): plan, prepareDefinition, and generate all fail closed before touching Herdr or sessions
	const noNodeSvc = new BootstrapService({
		exec: makeExec(emptyBin),
		extensionDir,
		stateDir: join(root, "state-none"),
		home,
		pollMs: 10,
		execPath: fakePiPath,
		env: { PATH: emptyBin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	assert.throws(
		() => noNodeSvc.plan(cmdReq),
		(err: Error) => err.message.includes("Required Node binary") && err.message.includes(fakePiPath) && err.message.includes("BOOTSTRAP_NODE") && err.message.includes("--experimental-strip-types"),
	);
	assert.throws(() => noNodeSvc.prepareDefinition(cmdReq), /Required Node binary/);
	await assert.rejects(() => noNodeSvc.generate(cmdReq), /Required Node binary/);
	assert.equal(herdrCalls, 0, "failed Node check must never call Herdr");
	assert.equal(existsSync(join(cwd, ".pi", "agent-sessions")), false, "failed Node check must not create session files");

	// Agent-only plans still succeed without node on PATH
	const agentOnlyPlan = noNodeSvc.plan({
		topology: "graph",
		task: "Agent only without node",
		project_cwd: cwd,
		agents: [{ node_id: "a1", persona: "first", sub_task: "Work" }],
	}, model);
	assert.equal(agentOnlyPlan.agents.length, 1);

	// 2. PATH has a binary named "node" that rejects --experimental-strip-types, or outputs nothing -> planning fails naming the bad candidate
	const badPathSvc = new BootstrapService({
		exec: makeExec(badPathBin),
		extensionDir,
		stateDir: join(root, "state-bad-path"),
		home,
		execPath: fakePiPath,
		env: { PATH: badPathBin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	assert.throws(
		() => badPathSvc.plan(cmdReq),
		(err: Error) => err.message.includes(badNodeInPath) && err.message.includes("rejected --experimental-strip-types"),
	);

	const silentPathSvc = new BootstrapService({
		exec: makeExec(silentPathBin),
		extensionDir,
		stateDir: join(root, "state-silent-path"),
		home,
		execPath: fakePiPath,
		env: { PATH: silentPathBin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	assert.throws(() => silentPathSvc.plan(cmdReq), /does not appear to be Node\.js/);

	// 3. Stubbed execPath literally named "node" that rejects --experimental-strip-types is rejected; falls back to real node on PATH
	const fakeNamedNode = join(fakeNodeExecDir, "node");
	writeFileSync(fakeNamedNode, "#!/bin/sh\necho 'bad option: --experimental-strip-types' >&2\nexit 9\n", { mode: 0o700 });
	const realNodeDir = join(root, "real-node-dir");
	mkdirSync(realNodeDir, { recursive: true });
	const realNodeBin = join(realNodeDir, "node");
	symlinkSync(process.execPath, realNodeBin);
	const fallbackSvc = new BootstrapService({
		exec: makeExec(`${emptyBin}:${realNodeDir}`),
		extensionDir,
		stateDir: join(root, "state-fallback"),
		home,
		execPath: fakeNamedNode,
		env: { PATH: `${emptyBin}:${realNodeDir}`, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	const fallbackRun = await fallbackSvc.generate(cmdReq);
	const fallbackLauncher = readFileSync(join(fallbackRun.session_dir, `${fallbackRun.pane_manifest[0].instance_id}.sh`), "utf8");
	assert.equal(fallbackLauncher.includes(fakeNamedNode), false, "failing execPath named node must not be used");
	assert.ok(fallbackLauncher.includes(realNodeBin), "must fall back to verified real node on PATH");

	// 4. BOOTSTRAP_NODE override is honored (both absolute path outside PATH and bare name on PATH) and works end-to-end with factory
	const overrideNodePath = join(overrideDir, "custom-node");
	symlinkSync(process.execPath, overrideNodePath);
	const envOverride: NodeJS.ProcessEnv = {
		PATH: emptyBin,
		HERDR_ENV: "1",
		HERDR_PANE_ID: "caller",
		BOOTSTRAP_NODE: overrideNodePath,
		PI_BOOTSTRAP_STATE_DIR: join(root, "factory-state"),
		PI_FACTORY_STATE_DIR: join(root, "factory-state"),
	};
	const factorySvc = new BootstrapService({
		exec: makeExec(emptyBin),
		extensionDir,
		stateDir: join(root, "factory-state"),
		home,
		pollMs: 10,
		execPath: fakePiPath,
		env: envOverride,
	});
	const factory = factoryOperations(join(root, "factory-state", "factories.sqlite"), factorySvc);
	const auth = createManagerAuthority({ pi_session_id: "mgr-override" });
	const factoryMarker = join(cwd, "factory-override-ran.txt");
	const fac = factory({
		action: "publish",
		name: "override-cmd-factory",
		sessionModel: { ...model, thinkingLevel: "low" },
		draft: {
			topology: "graph",
			task: "Factory command override",
			project_cwd: cwd,
			cleanup: "manual",
			agents: [{
				kind: "command",
				node_id: "fac_cmd",
				command: overrideNodePath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(factoryMarker)}, "fac-ok"); console.log(JSON.stringify({ fac: true }));`],
			}],
		},
	});
	factory({ action: "resume", factory_id: fac.factory_id, authority: auth });
	factory({ action: "submit", factory_id: fac.factory_id, reference: "ref-1", brief: "Run command", authority: auth });

	// Remove BOOTSTRAP_NODE -> factory readiness (inspect head_status) AND launch fail closed before creating attempts or calling Herdr
	delete envOverride.BOOTSTRAP_NODE;
	const blockedInspect = factory({ action: "inspect", factory_id: fac.factory_id });
	assert.equal(blockedInspect.head_status.eligible, false);
	assert.equal(blockedInspect.head_status.blocking_kind, "preflight");
	assert.match(blockedInspect.head_status.reason ?? "", /Required Node binary.*BOOTSTRAP_NODE/);
	const callsBeforeBlockedLaunch = herdrCalls;
	await assert.rejects(
		() => factory({ action: "launch", factory_id: fac.factory_id, authority: auth }),
		/Required Node binary/,
	);
	assert.equal(herdrCalls, callsBeforeBlockedLaunch, "blocked factory launch must not call Herdr");
	assert.equal(factory({ action: "inspect", factory_id: fac.factory_id }).attempts.length, 0, "blocked factory launch must not reserve an attempt");

	// Restore BOOTSTRAP_NODE -> factory inspect becomes eligible and launch executes /bin/sh launcher E2E
	envOverride.BOOTSTRAP_NODE = overrideNodePath;
	assert.equal(factory({ action: "inspect", factory_id: fac.factory_id }).head_status.eligible, true);
	const facLaunch = await factory({ action: "launch", factory_id: fac.factory_id, authority: auth });
	const facManifest = factorySvc.status(facLaunch.task_id, cwd).manifest;
	const facLauncher = readFileSync(join(facManifest.session_dir, `${facManifest.pane_manifest[0].instance_id}.sh`), "utf8");
	assert.ok(facLauncher.includes(overrideNodePath), `factory launcher must exec BOOTSTRAP_NODE (${overrideNodePath})`);
	for (let i = 0; i < 100; i++) {
		if (factorySvc.status(facLaunch.task_id, cwd).agents[0]?.execution === "succeeded") break;
		await delay(50);
	}
	assert.equal(factorySvc.status(facLaunch.task_id, cwd).outcome.state, "succeeded");
	assert.equal(readFileSync(factoryMarker, "utf8"), "fac-ok");

	// Bare executable name in BOOTSTRAP_NODE is resolved against PATH
	const bareNameSvc = new BootstrapService({
		exec: makeExec(`${emptyBin}:${overrideDir}`),
		extensionDir,
		stateDir: join(root, "state-bare-override"),
		home,
		execPath: fakePiPath,
		env: { PATH: `${emptyBin}:${overrideDir}`, BOOTSTRAP_NODE: "custom-node", HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	assert.equal(bareNameSvc.plan(cmdReq).agents[0].node_id, "cmd_guard");

	// 5. Invalid BOOTSTRAP_NODE values fail closed even when real node is in execPath and PATH
	for (const [badOverride, expectedPattern] of [
		[fakePiPath, /Invalid BOOTSTRAP_NODE.*rejected --experimental-strip-types/],
		[silentScript, /Invalid BOOTSTRAP_NODE.*does not appear to be Node\.js/],
		[oldNodeScript, /Invalid BOOTSTRAP_NODE.*too old/],
		[node24Script, /Invalid BOOTSTRAP_NODE.*too old/],
		[overrideDir, /Invalid BOOTSTRAP_NODE.*is not a regular file/],
		["", /Invalid BOOTSTRAP_NODE override/],
		["./relative/node", /must be an absolute path or an executable name on PATH/],
		[join(root, "does-not-exist"), /Invalid BOOTSTRAP_NODE.*not executable/],
		["no-such-node-on-path", /Invalid BOOTSTRAP_NODE.*was not found on PATH/],
	] as const) {
		const badOverrideSvc = new BootstrapService({
			exec: makeExec(realNodeDir),
			extensionDir,
			stateDir: join(root, "state-bad-override"),
			home,
			execPath: process.execPath,
			env: { PATH: realNodeDir, BOOTSTRAP_NODE: badOverride, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		});
		assert.throws(() => badOverrideSvc.plan(cmdReq), expectedPattern, `BOOTSTRAP_NODE=${JSON.stringify(badOverride)} must be rejected`);
	}

	// 5b. Probe runs with cwd = project_cwd (version-manager shims read per-directory config)
	const expectedCwd = realpathSync(cwd);
	const cwdCheckingWrapper = join(root, "cwd-checking-node");
	writeFileSync(cwdCheckingWrapper, `#!/bin/sh
if [ "$PWD" != ${JSON.stringify(expectedCwd)} ] && [ "$(pwd)" != ${JSON.stringify(expectedCwd)} ]; then
	echo "unexpected probe cwd: $(pwd)" >&2
	exit 1
fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o700 });
	const cwdProbeSvc = new BootstrapService({
		exec: makeExec(emptyBin),
		extensionDir,
		stateDir: join(root, "state-cwd-probe"),
		home,
		execPath: fakePiPath,
		env: { PATH: emptyBin, BOOTSTRAP_NODE: cwdCheckingWrapper, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	assert.equal(cwdProbeSvc.plan(cmdReq).agents[0].node_id, "cmd_guard");

	// 6. Caching & cache invalidation: repeated plan() calls do not re-spawn --version, and replacing the binary invalidates the cache
	const countFile = join(root, "probe-count.txt");
	const countingWrapper = join(root, "counting-node");
	writeFileSync(countingWrapper, `#!/bin/sh
echo x >> ${JSON.stringify(countFile)}
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o700 });
	const cacheSvc = new BootstrapService({
		exec: makeExec(emptyBin),
		extensionDir,
		stateDir: join(root, "state-cache"),
		home,
		execPath: fakePiPath,
		env: { PATH: emptyBin, BOOTSTRAP_NODE: countingWrapper, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
	});
	cacheSvc.plan(cmdReq);
	cacheSvc.plan(cmdReq);
	assert.equal(readFileSync(countFile, "utf8").trim().split("\n").length, 1, "second plan() call must hit verification cache");

	// Replace the binary at the same path -> cache invalidates automatically via stat metadata
	writeFileSync(countingWrapper, "#!/bin/sh\necho 'Error: Unknown options' >&2\nexit 1\n", { mode: 0o700 });
	assert.throws(() => cacheSvc.plan(cmdReq), /Invalid BOOTSTRAP_NODE.*rejected --experimental-strip-types/);
});



