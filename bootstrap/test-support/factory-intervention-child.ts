import { DatabaseSync } from "node:sqlite";
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createManagerAuthority, factoryOperations } from "../../factory/operations.ts";
import { BootstrapService } from "../lifecycle.ts";
import { atomicJson, readJson } from "../session-store.ts";
import { serviceFixture, workerFromConfig } from "./chain-fixture.ts";

const [mode, ...args] = process.argv.slice(2);
if (mode === "setup") {
	const f = serviceFixture({ after: () => {} } as any, ["builder"]);
	const operate = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath: join(f.root, "factory-coordination.sqlite") });
	const factory = operate({ action: "publish", name: "direction", draft: { topology: "graph", task: "Interruption fixture", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Ask for direction", intervention: { choices: [{ choice_id: "proceed", label: "Proceed" }, { choice_id: "stop", label: "Stop" }] } }] }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority();
	const target = { factory_id: factory.factory_id, authority };
	operate({ action: "resume", ...target });
	operate({ action: "submit", ...target, reference: "first", brief: "Fixture brief" });
	await operate({ action: "launch", ...target });
	writeSync(1, JSON.stringify({ root: f.root, cwd: f.cwd, factory, configs: f.configs, manager: authority.incarnation_id }));
	process.exit(0);
}
if (mode === "manager") {
	const [root, factoryId, previousManager, requestId, phase] = args;
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
	operate({ action: "respond_request", factory_id: factoryId, request_id: requestId, authority, response: { kind: "decline" } });
	throw new Error("Manager missed requested interruption point");
}
if (mode === "hot_journal") {
	const db = new DatabaseSync(args[0]);
	db.exec("PRAGMA cache_size = 10; BEGIN IMMEDIATE; UPDATE factory_requests SET reason = hex(randomblob(3000000));");
	process.kill(process.pid, "SIGKILL");
}
if (mode !== "agent") throw new Error(`Unknown mode: ${mode}`);
const [path, phase, continuedFile] = args;
const worker = workerFromConfig({ after: () => {} } as any, path, { model: { provider: "test-provider", id: "test-model" } });
const registry = join(worker.config.coms_dir, "projects", worker.config.coms_project, "agents", `${worker.config.instance_id}.json`);
atomicJson(registry, { ...readJson<object>(registry), pid: process.pid });
await worker.start();
await worker.beforeStart();

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
	if (armed && sql === "COMMIT" && phase === "after_commit") process.kill(process.pid, "SIGKILL");
	return result;
};
const waiting = worker.requestDirection({ question: "Which scope?", reason: "The brief is ambiguous", choices: ["proceed", "stop"] });
armed = true;
if (phase === "pause") process.kill(process.pid, "SIGSTOP");
const result = await waiting;
if (result.isError) throw new Error(result.content[0].text);
const blocked = await worker.hooks.get("tool_call")!({ toolName: "bash", input: {} });
if (blocked) throw new Error(blocked.reason);
appendFileSync(continuedFile, `${worker.config.instance_id}\n`);
const completion = await worker.complete({ status: "success", summary: "Continued once", detail: "Original attempt consumed the saved response" });
if (completion.isError) throw new Error(completion.content[0].text);
await worker.shutdown("quit");
