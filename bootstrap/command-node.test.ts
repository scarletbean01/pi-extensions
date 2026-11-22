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
	atomicJson, COMMAND_VERSION, commandProcessGroupPath, dispositionPath, parseManifest, parseWorkerConfig,
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
	const dSingle = createCommandDriver(join(rPlan.session_dir, `${sEntry.instance_id}.config.json`), { skipComsServer: true });
	const dJoin = createCommandDriver(join(rPlan.session_dir, `${jEntry.instance_id}.config.json`), { skipComsServer: true });
	await dSingle.start();
	await dJoin.start();
	await dSingle.waitUntilSettled();
	await dJoin.waitUntilSettled();
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

