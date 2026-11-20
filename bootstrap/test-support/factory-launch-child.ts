import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, type LaunchCommitBoundary } from "../../factory/operations.ts";
import { BootstrapService, type ExecResult } from "../lifecycle.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "../session-store.ts";

interface ChildConfig {
	mode: "launch" | "race-launch" | "kill-launch" | "inspect";
	database: string;
	factoryId: string;
	projectCwd: string;
	stateDir: string;
	home: string;
	bin: string;
	workspaceId?: string;
	tabsLog?: string;
	readyFile?: string;
	goFile?: string;
	killPhase?: "reserve_before_commit" | "reserve_after_commit" | "release_before_commit" | "release_after_commit" | "lost_ack";
	holdCreateMs?: number;
	holdAfterReadyMs?: number;
	piSessionId?: string;
}

const input = JSON.parse(process.argv[2]) as ChildConfig;
const extensionDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tabs: Array<{ pane_id: string; label: string }> = [];
let seq = 0;

const ok = (value: unknown = ""): ExecResult => ({
	code: 0,
	stdout: typeof value === "string" ? value : JSON.stringify({ result: value }),
	stderr: "",
});

const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
	if (args[0] === "pane" && args[1] === "get") {
		return ok({ pane: { workspace_id: input.workspaceId ?? `ws-${process.pid}` } });
	}
	if (args[0] === "tab" && args[1] === "create") {
		seq++;
		const label = args[args.indexOf("--label") + 1];
		const tab = {
			tab_id: `t${process.pid}-${seq}`,
			pane_id: `p${process.pid}-${seq}`,
			terminal_id: `term${process.pid}-${seq}`,
		};
		tabs.push({ pane_id: tab.pane_id, label });
		if (input.tabsLog) appendFileSync(input.tabsLog, `${process.pid}:${label}\n`);
		if (input.holdCreateMs) await new Promise(resolve => setTimeout(resolve, input.holdCreateMs));
		return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: tab.pane_id, terminal_id: tab.terminal_id } });
	}
	if (args[0] === "pane" && args[1] === "run") {
		const [task, instance] = tabs.find(tab => tab.pane_id === args[2])!.label.split(":");
		const sessionDir = join(input.projectCwd, ".pi", "agent-sessions", task);
		const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
		const ready = {
			task_id: task,
			token: config.token,
			instance_id: instance,
			name: instance,
			pid: process.pid,
			session_id: `session-${instance}`,
			endpoint: "/tmp/fake-coms",
			model: config.expected_model,
		};
		atomicJson(readyPath(sessionDir, instance), ready);
		const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
		mkdirSync(registryDir, { recursive: true });
		atomicJson(join(registryDir, `${instance}.json`), ready);
		if (input.holdAfterReadyMs) await new Promise(resolve => setTimeout(resolve, input.holdAfterReadyMs));
		return ok();
	}
	throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
};

const service = new BootstrapService({
	exec,
	extensionDir,
	stateDir: input.stateDir,
	home: input.home,
	env: { ...process.env, PATH: input.bin, HERDR_ENV: "1", HERDR_PANE_ID: `pane-${process.pid}` },
	pollMs: 5,
});

if (input.mode === "inspect") {
	const inspected = factoryOperations(input.database, service)({ action: "inspect", factory_id: input.factoryId });
	process.stdout.write(JSON.stringify(inspected));
	process.exit(0);
}

const killBoundary: LaunchCommitBoundary | undefined =
	input.killPhase && input.killPhase !== "lost_ack"
		? phase => {
			if (phase === input.killPhase) process.kill(process.pid, "SIGKILL");
		}
		: undefined;

const auth = createManagerAuthority({ pi_session_id: input.piSessionId ?? `child-${process.pid}` });
const ops = factoryOperations(input.database, service, { atLaunchCommit: killBoundary });
ops({ action: "resume", factory_id: input.factoryId, authority: auth });
const receipt = ops({
	action: "submit",
	factory_id: input.factoryId,
	reference: `ref-${process.pid}`,
	brief: `Brief from pid ${process.pid}`,
	authority: auth,
});

if (input.mode === "race-launch") {
	if (!input.readyFile || !input.goFile) throw new Error("race-launch requires readyFile and goFile");
	writeFileSync(input.readyFile, String(process.pid));
	while (!existsSync(input.goFile)) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

const launched = await ops({ action: "launch", factory_id: input.factoryId, authority: auth });
if (input.killPhase === "lost_ack") {
	process.kill(process.pid, "SIGKILL");
}
process.stdout.write(JSON.stringify({ receipt, launched }));
