/**
 * Parameterised Host contract suite running the same semantic checks against both
 * `herdr` (via fake herdr exec) and `hc` (via stateful fake hc exec).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHost,
	type Host,
	type HostBackendName,
	type HostExecResult,
	type HostNodeTarget,
} from "./host.ts";
import { BootstrapService, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, readyPath, type WorkerConfig } from "./session-store.ts";
import { makeFakeHcExec } from "./test-support/fake-hc.ts";

function installFakeBinary(dir: string, name: string, script: string): void {
	mkdirSync(dir, { recursive: true });
	const binPath = join(dir, name);
	writeFileSync(binPath, script, "utf8");
	chmodSync(binPath, 0o700);
}

function makeFakeHerdrContractExec(cwd: string) {
	const calls: string[][] = [];
	const tabs: Array<{ tab_id: string; label: string; workspace_id: string }> = [];
	const panes: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; workspace_id: string }> = [];
	const behavior = { failPreflight: false, acknowledge: true };
	let seq = 0;

	const exec = async (command: string, args: string[]): Promise<HostExecResult> => {
		assert.equal(command, "herdr");
		calls.push([...args]);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") {
			if (behavior.failPreflight && args[2] === "caller") return { code: 1, stdout: "", stderr: "caller pane unreachable" };
			if (args[2] === "caller") return ok({ pane: { pane_id: "caller", workspace_id: "ws-origin" } });
			const found = panes.find(p => p.pane_id === args[2]);
			if (!found) return { code: 1, stdout: "", stderr: "pane not found" };
			return ok({ pane: found });
		}
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const label = args[args.indexOf("--label") + 1]!;
			const tab = { tab_id: `t${seq}`, label, workspace_id: "ws-origin" };
			const pane = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label, workspace_id: "ws-origin" };
			tabs.push(tab);
			panes.push(pane);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: pane.pane_id, terminal_id: pane.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			if (behavior.acknowledge) {
				const pane = panes.find(p => p.pane_id === args[2])!;
				const [task, instance] = pane.label.split(":");
				const sessionDir = join(cwd, ".pi", "agent-sessions", task!);
				const configPath = join(sessionDir, `${instance}.config.json`);
				if (existsSync(configPath)) {
					const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
					const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
					atomicJson(readyPath(sessionDir, instance!), ready);
					const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
					mkdirSync(registryDir, { recursive: true });
					atomicJson(join(registryDir, `${instance}.json`), ready);
				}
			}
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") {
			return ok({ workspaces: [{ workspace_id: "ws-origin" }], tabs, panes });
		}
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};

	return { exec, calls, tabs, panes, behavior };
}

interface ContractHarness {
	backend: HostBackendName;
	root: string;
	cwd: string;
	home: string;
	bin: string;
	stateDir: string;
	extensionDir: string;
	env: NodeJS.ProcessEnv;
	host: Host;
	exec: (command: string, args: string[], options: any) => Promise<HostExecResult>;
	failPreflight: () => void;
	removeNodeResource: (target: HostNodeTarget) => void;
	duplicateOwnership: (target: HostNodeTarget) => void;
	markFinishedIfSupported: (target: HostNodeTarget) => boolean;
}

function createContractHarness(t: test.TestContext, backend: HostBackendName): ContractHarness {
	const root = mkdtempSync(join(tmpdir(), `bootstrap-contract-${backend}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const stateDir = join(root, "state");
	const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	mkdirSync(join(cwd, "extensions"), { recursive: true });
	mkdirSync(home, { recursive: true });
	installFakeBinary(bin, "pi", "#!/bin/sh\nexit 0\n");
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: provider/model\ntools: read\n---\nPersona ${name}\n`);
	}

	if (backend === "herdr") {
		installFakeBinary(bin, "herdr", "#!/bin/sh\nexit 0\n");
		const fake = makeFakeHerdrContractExec(cwd);
		const env: NodeJS.ProcessEnv = { PATH: bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" };
		const host = createHost("herdr", { exec: fake.exec, env });
		return {
			backend,
			root,
			cwd,
			home,
			bin,
			stateDir,
			extensionDir,
			env,
			host,
			exec: fake.exec,
			failPreflight: () => { fake.behavior.failPreflight = true; },
			removeNodeResource: target => {
				const pIdx = fake.panes.findIndex(p => p.terminal_id === target.terminal_id);
				if (pIdx !== -1) fake.panes.splice(pIdx, 1);
				const tIdx = fake.tabs.findIndex(tab => tab.tab_id === target.tab_id);
				if (tIdx !== -1) fake.tabs.splice(tIdx, 1);
			},
			duplicateOwnership: target => {
				fake.tabs.push({ tab_id: "t-dup", label: "dup", workspace_id: "ws-origin" });
				fake.panes.push({ tab_id: "t-dup", pane_id: "p-dup", terminal_id: target.terminal_id!, label: "dup", workspace_id: "ws-origin" });
			},
			markFinishedIfSupported: () => false,
		};
	}

	installFakeBinary(bin, "hc", "#!/bin/sh\nexit 0\n");
	const fake = makeFakeHcExec({ cwd, serverRunning: true, acknowledge: true });
	const env: NodeJS.ProcessEnv = { PATH: bin };
	const host = createHost("hc", { exec: fake.exec, env });
	return {
		backend,
		root,
		cwd,
		home,
		bin,
		stateDir,
		extensionDir,
		env,
		host,
		exec: fake.exec,
		failPreflight: () => { fake.behavior.serverRunning = false; },
		removeNodeResource: target => {
			const addr = String((target.host_ref as any)?.address);
			fake.terminals.delete(addr);
		},
		duplicateOwnership: target => {
			const runId = target.run_id ?? target.label.split(":")[0]!;
			fake.terminals.set("t-dup", {
				address: "t-dup",
				name: "look-alike",
				cwd,
				argv: ["/bin/sh", "dup.sh"],
				labels: { bootstrap_run: runId, bootstrap_node: target.instance_id },
				state: "live",
				parent: null,
				notify: false,
				exit_code: null,
				created_ms: Date.now(),
				finished_ms: null,
				screen: "exact",
				cols: 200,
				rows: 120,
			});
		},
		markFinishedIfSupported: target => {
			const addr = String((target.host_ref as any)?.address);
			const term = fake.terminals.get(addr);
			if (!term) return false;
			term.state = "finished";
			term.exit_code = 0;
			term.finished_ms = Date.now();
			return true;
		},
	};
}

for (const backend of ["herdr", "hc"] as const) {
	test(`Host contract (${backend}): preflight failure names backend and operation`, async t => {
		const h = createContractHarness(t, backend);
		h.failPreflight();
		await assert.rejects(
			() => h.host.preflight(),
			err => err instanceof Error && err.message.toLowerCase().includes(backend) && /preflight|get|status/i.test(err.message),
		);

		const emptyBin = join(h.root, "empty-bin");
		mkdirSync(emptyBin, { recursive: true });
		const missingBinHost = createHost(backend, { exec: h.exec, env: { ...h.env, PATH: emptyBin } });
		await assert.rejects(
			() => missingBinHost.preflight(),
			err => err instanceof Error && err.message.includes(backend),
		);
	});

	test(`Host contract (${backend}): launch, discovery, and existence states (present, gone, ambiguous)`, async t => {
		const h = createContractHarness(t, backend);
		const preflight = await h.host.preflight();
		assert.equal(preflight.backend, backend);

		const runId = "contract-run-1";
		const launcher1 = join(h.root, "n1.sh");
		const launcher2 = join(h.root, "n2.sh");
		writeFileSync(launcher1, "#!/bin/sh\nexit 0\n");
		writeFileSync(launcher2, "#!/bin/sh\nexit 0\n");

		const handle1 = await h.host.launchNode({
			name: `${runId}:a1-n1`,
			runId,
			instanceId: "a1-n1",
			directory: h.cwd,
			launcher: launcher1,
			environment: { PI_COMS_DIR: join(h.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
			preflight,
		});
		const handle2 = await h.host.launchNode({
			name: `${runId}:a2-n2`,
			runId,
			instanceId: "a2-n2",
			directory: h.cwd,
			launcher: launcher2,
			environment: { PI_COMS_DIR: join(h.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
			preflight,
		});

		const targets: HostNodeTarget[] = [
			{
				run_id: runId,
				node_id: "n1",
				persona_name: "first",
				instance_id: "a1-n1",
				label: `${runId}:a1-n1`,
				tab_id: handle1.tab_id,
				pane_id: handle1.pane_id,
				terminal_id: handle1.terminal_id,
				host_ref: handle1.host_ref,
			},
			{
				run_id: runId,
				node_id: "n2",
				persona_name: "second",
				instance_id: "a2-n2",
				label: `${runId}:a2-n2`,
				tab_id: handle2.tab_id,
				pane_id: handle2.pane_id,
				terminal_id: handle2.terminal_id,
				host_ref: handle2.host_ref,
			},
		];

		// Both launched nodes are discovered and present.
		const discovered = await h.host.discoverOwnedNodes(targets);
		assert.equal(discovered.length, 2);
		assert.equal(discovered[0]!.existence.state, "present");
		assert.equal(discovered[1]!.existence.state, "present");
		assert.equal((await h.host.nodeExists(targets[0]!)).state, "present");

		// Finished terminal still reports present on backends that retain finished records.
		if (h.markFinishedIfSupported(targets[0]!)) {
			assert.equal((await h.host.nodeExists(targets[0]!)).state, "present");
		}

		// Removing node 1 makes node 1 gone while node 2 stays present.
		h.removeNodeResource(targets[0]!);
		assert.equal((await h.host.nodeExists(targets[0]!)).state, "gone");
		assert.equal((await h.host.nodeExists(targets[1]!)).state, "present");

		// Conflicting ownership makes node 2 ambiguous.
		h.duplicateOwnership(targets[1]!);
		const amb = await h.host.nodeExists(targets[1]!);
		assert.equal(amb.state, "ambiguous");
	});

	test(`Host contract (${backend}): BootstrapService.generate launches end-to-end and records host_backend + host_ref`, async t => {
		const h = createContractHarness(t, backend);
		const service = new BootstrapService({
			exec: h.exec,
			extensionDir: h.extensionDir,
			stateDir: h.stateDir,
			home: h.home,
			env: h.env,
			pollMs: 5,
		});
		const request: GenerateRequest = {
			task: `Contract launch on ${backend}`,
			topology: "chain",
			project_cwd: h.cwd,
			agents: [
				{ node_id: "n1", persona: "first", sub_task: "Step 1" },
				{ node_id: "n2", persona: "second", sub_task: "Step 2" },
			],
			ready_timeout_ms: 200,
		};
		const manifest = await service.generate(request);
		assert.equal(manifest.status, "applied");
		assert.equal(manifest.host_backend, backend);
		assert.equal(manifest.pane_manifest.length, 2);
		for (const entry of manifest.pane_manifest) {
			assert.ok(entry.host_ref && typeof entry.host_ref === "object");
		}
	});
}
