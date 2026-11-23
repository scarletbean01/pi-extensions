import { DatabaseSync } from "node:sqlite";
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createManagerAuthority, factoryOperations } from "../../factory/operations.ts";
import { BootstrapService } from "../lifecycle.ts";
import { atomicJson, readJson } from "../session-store.ts";
import { notification, serviceFixture, workerFromConfig } from "./chain-fixture.ts";

const [mode, ...args] = process.argv.slice(2);
if (mode === "setup") {
	const f = serviceFixture({ after: () => {} } as any, ["builder"]);
	const operate = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "factory-coordination.sqlite") });
	const exhaustion = args[0] === "exhaustion";
	const factory = operate({ action: "publish", name: "direction", draft: {
		topology: "graph", task: "Interruption fixture", project_cwd: f.cwd,
		...(exhaustion ? { max_total_attempts: 2, agents: [
			{ node_id: "build", persona: "builder", sub_task: "Build" },
			{ node_id: "review", persona: "builder", sub_task: "Review", depends_on: ["build"],
				decision: { field: "verdict", on_reject: "build", approve: "ship", reject: "revise" },
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["ship", "revise"] } } } },
		] } : { agents: [{ node_id: "build", persona: "builder", sub_task: "Ask for direction", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }] } }] }),
	}, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority();
	const target = { factory_id: factory.factory_id, authority };
	operate({ action: "resume", ...target });
	operate({ action: "submit", ...target, reference: "first", brief: "Fixture brief" });
	await operate({ action: "launch", ...target });
	if (exhaustion) {
		const [build, review] = f.configs.map(config => workerFromConfig({ after: () => {} } as any, join(config.session_dir, `${config.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } }));
		for (const worker of [build, review]) { await worker.start(); await worker.beforeStart(); }
		const result = { status: "success", summary: "Fixture complete", detail: "Fixture findings" };
		await build.complete(result);
		await review.beforeStart(notification(build, review));
		await review.deliverFollowUps();
		const completed = await review.complete({ ...result, outputs: { verdict: "revise" } });
		if (completed.isError) throw new Error(completed.content[0].text);
	}
	writeSync(1, JSON.stringify({ root: f.root, cwd: f.cwd, factory, configs: f.configs, manager: authority.incarnation_id }));
	process.exit(0);
}
if (mode === "manager") {
	const [root, factoryId, previousManager, requestId, phase, retryBrief] = args;
	const bootstrap = new BootstrapService({
		stateDir: join(root, "state"), home: join(root, "home"), extensionDir: root,
		exec: async () => { throw new Error("Recovery must not launch or control panes"); },
	});
	const authority = createManagerAuthority({ pi_session_id: `manager-${process.pid}` });
	const operate = factoryOperations(join(root, "factories.sqlite"), bootstrap, {
		coordinationPath: join(root, "factory-coordination.sqlite"),
		atCommit: reached => { if (reached === phase) process.kill(process.pid, "SIGKILL"); },
	});
	operate({ action: "takeover", factory_id: factoryId, authority, confirmed_manager_incarnation_id: previousManager });
	const recovered = operate({ action: "requests", factory_id: factoryId }).find(request => request.request_id === requestId);
	writeSync(1, JSON.stringify({ owner: authority.incarnation_id, recovered }));
	operate({ action: "respond_request", factory_id: factoryId, request_id: requestId, authority,
		response: retryBrief === undefined ? { kind: "decline" } : { kind: "choice", choice_id: "retry" }, newBrief: retryBrief });
	throw new Error("Manager missed requested interruption point");
}
if (mode === "constraint_setup") {
	const text = args[0] ?? "Run lint before PR";
	const f = serviceFixture({ after: () => {} } as any, ["builder", "reviewer"]);
	const operate = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "factory-coordination.sqlite") });
	const factory = operate({
		action: "publish",
		name: "constraint-crash",
		draft: {
			topology: "graph",
			task: "Constraint crash recovery fixture",
			project_cwd: f.cwd,
			agents: [
				{ node_id: "build", persona: "builder", sub_task: "Build" },
				{
					node_id: "review",
					persona: "reviewer",
					depends_on: ["build"],
					sub_task: "Review",
					output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
					decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "build", max_revisions: 2 },
				},
			],
		},
		sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" },
	});
	const authority = createManagerAuthority();
	operate({ action: "resume", factory_id: factory.factory_id, authority });
	operate({ action: "submit", factory_id: factory.factory_id, reference: "sub-crash", brief: "Crash test brief", authority });
	const launch = await operate({ action: "launch", factory_id: factory.factory_id, authority });
	const buildCfg = launch.manifest.pane_manifest.find(m => m.node_id === "build")!;
	const reviewCfg = launch.manifest.pane_manifest.find(m => m.node_id === "review")!;
	const build = workerFromConfig({ after: () => {} } as any, join(launch.manifest.session_dir, `${buildCfg.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } });
	const review = workerFromConfig({ after: () => {} } as any, join(launch.manifest.session_dir, `${reviewCfg.instance_id}.config.json`), { model: { provider: "test-provider", id: "test-model" } });
	await build.start();
	await review.start();
	await build.beforeStart();
	await review.beforeStart();
	await build.complete({ status: "success", summary: "v1", detail: "first" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "revise", detail: "need fix", outputs: { verdict: "changes_requested" } });
	await build.beforeStart(notification(review, build));
	await build.deliverFollowUps();
	await build.complete({ status: "success", summary: "v2", detail: "second" });
	await review.beforeStart(notification(build, review));
	await review.deliverFollowUps();
	await review.complete({ status: "success", summary: "ok", detail: "good", outputs: { verdict: "approve" } });
	const settled = await operate({ action: "settle_run", factory_id: factory.factory_id, authority });
	if (!settled.settled) throw new Error(`Settle failed: ${settled.reason}`);
	const prop = operate({
		action: "propose_constraint",
		factory_id: factory.factory_id,
		authority,
		text,
		run_id: launch.task_id,
		attempt_id: `${buildCfg.instance_id}.2`,
		evidence_ref: `result:${buildCfg.instance_id}.1`,
	});
	writeSync(1, JSON.stringify({ root: f.root, cwd: f.cwd, factoryId: factory.factory_id, proposalId: prop.proposal.proposal_id, manager: authority.incarnation_id }));
	process.exit(0);
}
if (mode === "constraint_confirm") {
	const [root, factoryId, previousManager, proposalId, phase] = args;
	const bootstrap = new BootstrapService({
		stateDir: join(root, "state"), home: join(root, "home"), extensionDir: root,
		exec: async () => { throw new Error("Constraint confirmation must not launch panes"); },
	});
	const authority = createManagerAuthority({ pi_session_id: `manager-${process.pid}` });
	let armed = false;
	const operate = factoryOperations(join(root, "factories.sqlite"), bootstrap, {
		coordinationPath: join(root, "factory-coordination.sqlite"),
		atCommit: reached => { if (armed && reached === phase) process.kill(process.pid, "SIGKILL"); },
	});
	operate({ action: "takeover", factory_id: factoryId, authority, confirmed_manager_incarnation_id: previousManager });
	writeSync(1, JSON.stringify({ owner: authority.incarnation_id }));
	armed = true;
	await operate({
		action: "confirm_constraint",
		factory_id: factoryId,
		proposal_id: proposalId,
		authority,
		confirm: async () => true,
	});
	throw new Error("Constraint confirmation missed requested interruption point");
}
if (mode === "constraint_resolve") {
	const [root, factoryId, previousManager, proposalId, resolution, phase] = args;
	const bootstrap = new BootstrapService({
		stateDir: join(root, "state"), home: join(root, "home"), extensionDir: root,
		exec: async () => { throw new Error("Conflict resolution must not launch panes"); },
	});
	const authority = createManagerAuthority({ pi_session_id: `manager-${process.pid}` });
	let armed = false;
	const operate = factoryOperations(join(root, "factories.sqlite"), bootstrap, {
		coordinationPath: join(root, "factory-coordination.sqlite"),
		atCommit: reached => { if (armed && reached === phase) process.kill(process.pid, "SIGKILL"); },
	});
	operate({ action: "takeover", factory_id: factoryId, authority, confirmed_manager_incarnation_id: previousManager });
	writeSync(1, JSON.stringify({ owner: authority.incarnation_id }));
	armed = true;
	await operate({
		action: "resolve_constraint_conflict",
		factory_id: factoryId,
		proposal_id: proposalId,
		authority,
		confirm: async () => resolution === "abandon" ? { resolution: "abandon", reason: "Abandon crash test" } : { resolution: "reconfirm" },
	});
	throw new Error("Conflict resolution missed requested interruption point");
}
if (mode === "hot_journal") {
	const db = new DatabaseSync(args[0]);
	db.exec("PRAGMA cache_size = 10; BEGIN IMMEDIATE; UPDATE factory_requests SET reason = hex(randomblob(3000000));");
	process.kill(process.pid, "SIGKILL");
}
if (mode !== "agent") throw new Error(`Unknown mode: ${mode}`);
const [path, phase, continuedFile, startupEvent] = args;
const worker = workerFromConfig({ after: () => {} } as any, path, { model: { provider: "test-provider", id: "test-model" } });
const registry = join(worker.config.coms_dir, "projects", worker.config.coms_project, "agents", `${worker.config.instance_id}.json`);
atomicJson(registry, { ...readJson<object>(registry), pid: process.pid });
await worker.start();
await worker.beforeStart();
if (startupEvent) {
	await worker.beforeStart(JSON.parse(startupEvent));
	await worker.deliverFollowUps();
}

if (phase === "park_after_complete") {
	const result = await worker.complete({ status: "success", summary: "Parked", detail: "Fixture work" });
	if (result.isError) throw new Error(result.content[0].text);
	writeFileSync(continuedFile, JSON.stringify(worker.sent));
	process.kill(process.pid, "SIGSTOP");
	throw new Error("Expected a parked agent to be killed without running cleanup");
}

// Observe the real SQLite commit used by the tool's claim, not a mocked write. While the tool
// waits, its reads end with ROLLBACK/close; after it publishes the request the next COMMIT is
// its consumption claim. Restoring the method after a kill is unnecessary: this process dies.
const exec = DatabaseSync.prototype.exec;
let armed = false;
let sawUnwokenResponse = false;
DatabaseSync.prototype.exec = function (sql) {
	if (phase === "observe" && sawUnwokenResponse && sql === "BEGIN IMMEDIATE") writeFileSync(`${continuedFile}.premature-claim`, "attempted");
	if (armed && sql === "COMMIT" && phase === "before_commit") process.kill(process.pid, "SIGKILL");
	const result = exec.call(this, sql);
	if (armed && phase === "observe" && sql === "BEGIN") {
		sawUnwokenResponse = Boolean(this.prepare("SELECT 1 FROM factory_requests r JOIN factory_direction_mailboxes m USING (request_id) WHERE r.response IS NOT NULL AND m.wake = 0").get());
		// Signal after this wait iteration, including any claim it attempted, gets a chance to run.
		if (sawUnwokenResponse) queueMicrotask(() => writeFileSync(`${continuedFile}.observed-response`, "observed"));
	}
	if (armed && sql === "COMMIT" && (phase === "after_commit" || phase === "approval_after_claim")) process.kill(process.pid, "SIGKILL");
	return result;
};
const waiting = worker.requestDirection({ question: "Which scope?", reason: "The brief is ambiguous", choices: phase.startsWith("approval_") ? ["ship"] : ["proceed", "stop"] });
armed = true;
if (phase === "pause") process.kill(process.pid, "SIGSTOP");
const result = await waiting;
if (result.isError) throw new Error(result.content[0].text);
const blocked = await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} });
if (blocked) throw new Error(blocked.reason);
appendFileSync(continuedFile, `${worker.config.instance_id}\n`);
const completion = await worker.complete({ status: "success", summary: "Continued once", detail: "Original attempt consumed the saved response" });
if (completion.isError) throw new Error(completion.content[0].text);
if (phase === "approval_after_verdict") process.kill(process.pid, "SIGKILL");
await worker.shutdown("quit");
