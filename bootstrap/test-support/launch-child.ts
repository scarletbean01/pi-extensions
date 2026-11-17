/**
 * Child process for cross-process launch tests: one dispatcher process with a fake Herdr boundary.
 * Tab creations are appended to a log shared by every child so tests can count real launches.
 * argv: <json {root, cwd, home, stateDir, bin, startAt, request}>
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService, type ExecResult } from "../lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "../session-store.ts";

const input = JSON.parse(process.argv[2]);
const extensionDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tabs: Array<{ pane_id: string; label: string }> = [];
let sequence = 0;
const ok = (value: unknown = ""): ExecResult => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
	if (args[0] === "pane" && args[1] === "get") return ok({ pane: { workspace_id: "origin-workspace" } });
	if (args[0] === "tab" && args[1] === "create") {
		sequence++;
		const label = args[args.indexOf("--label") + 1];
		const tab = { tab_id: `t${process.pid}-${sequence}`, pane_id: `p${process.pid}-${sequence}`, terminal_id: `term${process.pid}-${sequence}` };
		tabs.push({ pane_id: tab.pane_id, label });
		appendFileSync(join(input.root, "tabs.log"), `${label}\n`);
		if (input.holdCreateMs) await new Promise(resolve => setTimeout(resolve, input.holdCreateMs));
		return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
	}
	if (args[0] === "pane" && args[1] === "run") {
		const [task, instance] = tabs.find(tab => tab.pane_id === args[2])!.label.split(":");
		const sessionDir = join(input.cwd, ".pi", "agent-sessions", task);
		const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
		const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
		atomicJson(readyPath(sessionDir, instance), ready);
		const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
		mkdirSync(registryDir, { recursive: true });
		atomicJson(join(registryDir, `${instance}.json`), ready);
		return ok();
	}
	throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
};
const service = new BootstrapService({ exec, extensionDir, stateDir: input.stateDir, home: input.home, env: { PATH: input.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" }, pollMs: 5 });
while (Date.now() < input.startAt) { /* align processes so they genuinely compete */ }
try {
	const manifest = await service.generate(input.request);
	console.log(JSON.stringify({ task_id: manifest.task_id, status: manifest.status, phase: manifest.phase }));
} catch (error) {
	console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
