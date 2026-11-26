/** Outside-in tests for Host selection, Herdr Host backend, manifest host_backend/host_ref, and legacy compatibility. */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, hostBackendOf, requireSupportedHost, selectHostBackend } from "./host.ts";
import { hcTerminalName } from "./host-hc.ts";
import { HerdrHost } from "./host-herdr.ts";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, parseManifest, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import { makeFakeHcExec } from "./test-support/fake-hc.ts";

const FAKE_HC_STATUS_JSON = JSON.stringify({
	core: { id: "fake-hc-core", name: "fake-host" },
	version: "0.1.25",
	pid: 1234,
	uptime_ms: 1000,
	holders: [],
	live: 0,
	finished: 0,
});

function installFakeBinary(dir: string, name: string, script: string): void {
	mkdirSync(dir, { recursive: true });
	const binPath = join(dir, name);
	writeFileSync(binPath, script, "utf8");
	chmodSync(binPath, 0o700);
}

function makeFakeHerdrExec(cwd: string) {
	const calls: string[][] = [];
	const tabs: Array<{ tab_id: string; label: string; workspace_id: string }> = [];
	const panes: Array<{ tab_id: string; pane_id: string; terminal_id: string; label: string; workspace_id: string }> = [];
	let seq = 0;
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		calls.push(args);
		const ok = (value: unknown = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify({ result: value }), stderr: "" });
		if (args[0] === "pane" && args[1] === "get") {
			if (args[2] === "caller") return ok({ pane: { pane_id: "caller", workspace_id: "ws-origin" } });
			const found = panes.find(p => p.pane_id === args[2]);
			if (!found) return { code: 1, stdout: "", stderr: "pane not found" };
			return ok({ pane: found });
		}
		if (args[0] === "tab" && args[1] === "create") {
			seq++;
			const label = args[args.indexOf("--label") + 1];
			const tab = { tab_id: `t${seq}`, label, workspace_id: "ws-origin" };
			const pane = { tab_id: `t${seq}`, pane_id: `p${seq}`, terminal_id: `term${seq}`, label, workspace_id: "ws-origin" };
			tabs.push(tab);
			panes.push(pane);
			return ok({ tab: { tab_id: tab.tab_id }, root_pane: { pane_id: pane.pane_id, terminal_id: pane.terminal_id } });
		}
		if (args[0] === "pane" && args[1] === "run") {
			const pane = panes.find(p => p.pane_id === args[2])!;
			const [task, instance] = pane.label.split(":");
			const sessionDir = join(cwd, ".pi", "agent-sessions", task);
			const config = readJson<WorkerConfig>(join(sessionDir, `${instance}.config.json`));
			const ready = { task_id: task, token: config.token, instance_id: instance, name: instance, pid: process.pid, session_id: `session-${instance}`, endpoint: "/tmp/fake-coms", model: config.expected_model };
			atomicJson(readyPath(sessionDir, instance), ready);
			const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
			mkdirSync(registryDir, { recursive: true });
			atomicJson(join(registryDir, `${instance}.json`), ready);
			return ok();
		}
		if (args[0] === "api" && args[1] === "snapshot") {
			return ok({ workspaces: [{ workspace_id: "ws-origin" }], tabs, panes });
		}
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "ws-origin" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes });
		if (args[0] === "pane" && args[1] === "close") {
			const idx = panes.findIndex(p => p.pane_id === args[2]);
			if (idx === -1) return { code: 1, stdout: "", stderr: "not found" };
			const [removed] = panes.splice(idx, 1);
			if (!panes.some(p => p.tab_id === removed.tab_id)) {
				const tIdx = tabs.findIndex(t => t.tab_id === removed.tab_id);
				if (tIdx !== -1) tabs.splice(tIdx, 1);
			}
			return ok();
		}
		if (args[0] === "tab" && args[1] === "close") {
			const idx = tabs.findIndex(t => t.tab_id === args[2]);
			if (idx === -1) return { code: 1, stdout: "", stderr: "not found" };
			const [removed] = tabs.splice(idx, 1);
			for (let i = panes.length - 1; i >= 0; i--) {
				if (panes[i].tab_id === removed.tab_id) panes.splice(i, 1);
			}
			return ok();
		}
		throw new Error(`Unexpected fake Herdr command: ${args.join(" ")}`);
	};
	return { exec, calls, tabs, panes };
}

function makeProjectFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-host-seam-"));
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
	installFakeBinary(bin, "herdr", "#!/bin/sh\nexit 0\n");
	writeFileSync(join(cwd, "extensions", "coms.ts"), "export default function () {}\n");
	for (const name of ["first", "second"]) {
		writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\nmodel: provider/model\ntools: read\n---\nPersona ${name}\n`);
	}
	const fake = makeFakeHerdrExec(cwd);
	const request: GenerateRequest = {
		task: "Host test",
		topology: "chain",
		project_cwd: cwd,
		agents: [
			{ node_id: "n1", persona: "first", sub_task: "Step 1" },
			{ node_id: "n2", persona: "second", sub_task: "Step 2" },
		],
		ready_timeout_ms: 200,
	};
	return { root, cwd, home, bin, stateDir, extensionDir, fake, request };
}

test("selectHostBackend follows explicit override, calling context, and hc PATH/core probe rules", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-select-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const liveHcBin = join(root, "live-hc-bin");
	const deadHcBin = join(root, "dead-hc-bin");
	const emptyBin = join(root, "empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	installFakeBinary(liveHcBin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then printf '%s\\n' '${FAKE_HC_STATUS_JSON}'; exit 0; fi\nexit 1\n`);
	installFakeBinary(deadHcBin, "hc", `#!/bin/sh\necho 'core offline' >&2\nexit 1\n`);

	// 1. Explicit PI_BOOTSTRAP_HOST wins over conflicting contexts and binaries.
	assert.deepEqual(await selectHostBackend({ PI_BOOTSTRAP_HOST: "herdr", HC_TERMINAL_ID: "hc-1", PATH: liveHcBin }), {
		backend: "herdr",
		source: "explicit",
	});
	assert.deepEqual(await selectHostBackend({ PI_BOOTSTRAP_HOST: "hc", HERDR_ENV: "1", HERDR_PANE_ID: "p-1", PATH: emptyBin }), {
		backend: "hc",
		source: "explicit",
	});
	for (const bad of ["", "tmux", "HERDR", "unknown"]) {
		await assert.rejects(
			() => selectHostBackend({ PI_BOOTSTRAP_HOST: bad, HERDR_ENV: "1", HERDR_PANE_ID: "p-1" }),
			/PI_BOOTSTRAP_HOST.*herdr.*hc/i,
		);
	}

	// 2. Calling context: HC_TERMINAL_ID -> hc; HERDR_ENV=1 + HERDR_PANE_ID -> herdr; hc wins if both.
	assert.deepEqual(await selectHostBackend({ HC_TERMINAL_ID: "t-7", PATH: emptyBin }), {
		backend: "hc",
		source: "context",
	});
	assert.deepEqual(await selectHostBackend({ HERDR_ENV: "1", HERDR_PANE_ID: "p-9", PATH: emptyBin }), {
		backend: "herdr",
		source: "context",
	});
	assert.deepEqual(await selectHostBackend({ HC_TERMINAL_ID: "t-7", HERDR_ENV: "1", HERDR_PANE_ID: "p-9", PATH: emptyBin }), {
		backend: "hc",
		source: "context",
	});
	// HERDR_ENV=1 inside a Herdr pane with a live hc binary on PATH still selects herdr (story 5).
	assert.deepEqual(await selectHostBackend({ HERDR_ENV: "1", HERDR_PANE_ID: "p-9", PATH: liveHcBin }), {
		backend: "herdr",
		source: "context",
	});

	// HERDR_ENV=0 or missing HERDR_PANE_ID does not count as Herdr context.
	await assert.rejects(
		() => selectHostBackend({ HERDR_ENV: "0", HERDR_PANE_ID: "p-9", PATH: emptyBin }),
		/hc.*herdr/i,
	);
	// When HERDR_ENV=1 is set without HERDR_PANE_ID, preserve the helpful Herdr pane hint while still naming both options.
	await assert.rejects(
		() => selectHostBackend({ HERDR_ENV: "1", PATH: emptyBin }),
		err => err instanceof Error && /Bootstrap must run inside a Herdr-managed pane.*HERDR_PANE_ID/i.test(err.message) && /hc.*herdr/i.test(err.message),
	);

	// 3. Neither context: hc if binary is on PATH and core answers, else clear error naming both.
	assert.deepEqual(await selectHostBackend({ PATH: liveHcBin }), {
		backend: "hc",
		source: "probe",
	});
	await assert.rejects(
		() => selectHostBackend({ PATH: deadHcBin }),
		err => err instanceof Error && /hc/i.test(err.message) && /herdr/i.test(err.message),
	);
	await assert.rejects(
		() => selectHostBackend({ PATH: emptyBin }),
		err => err instanceof Error && /hc/i.test(err.message) && /herdr/i.test(err.message),
	);

	// Both backends are selectable in ticket 03.
	assert.equal(requireSupportedHost({ backend: "hc", source: "explicit" }), "hc");
	assert.equal(requireSupportedHost({ backend: "herdr", source: "context" }), "herdr");
});

test("selectHostBackend probe resolves on hard deadline when fake hc leaves stdout open", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-probe-hang-"));
	const pidFile = join(root, "holder.pid");
	t.after(() => {
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	const bin = join(root, "bin");
	const holderScript = join(root, "holder.js");
	writeFileSync(
		holderScript,
		`const { spawn } = require("node:child_process");\n` +
		`const fs = require("node:fs");\n` +
		`const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", 1, "ignore"], detached: true });\n` +
		`fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
		`child.unref();\n` +
		`process.exit(0);\n`,
		"utf8",
	);
	installFakeBinary(bin, "hc", `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(holderScript)}\n`);

	const started = Date.now();
	await assert.rejects(
		() => selectHostBackend({ PATH: bin }, { probeTimeoutMs: 5_000 }),
		/No Host backend is available/i,
	);
	assert.ok(Date.now() - started < 1500, "probe should resolve promptly on exit 0 with empty output even when grandchild holds stdout open");
});

test("selectHostBackend probe resolves true on exit when valid status JSON is printed despite grandchild holding stdout", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-probe-open-ok-"));
	const pidFile = join(root, "holder.pid");
	t.after(() => {
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	const bin = join(root, "bin");
	const holderScript = join(root, "holder.js");
	writeFileSync(
		holderScript,
		`const { spawn } = require("node:child_process");\n` +
		`const fs = require("node:fs");\n` +
		`const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", 1, "ignore"], detached: true });\n` +
		`fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
		`child.unref();\n` +
		`process.stdout.write(${JSON.stringify(FAKE_HC_STATUS_JSON + "\n")});\n` +
		`process.exit(0);\n`,
		"utf8",
	);
	installFakeBinary(bin, "hc", `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(holderScript)}\n`);

	const started = Date.now();
	assert.deepEqual(await selectHostBackend({ PATH: bin }, { probeTimeoutMs: 5_000 }), {
		backend: "hc",
		source: "probe",
	});
	assert.ok(Date.now() - started < 1500, "probe should resolve promptly on exit without waiting for grandchild stdout EOF");
});

test("selectHostBackend probe still enforces hard deadline when child ignores SIGTERM and holds stdout open", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-probe-deadline-"));
	const pidFile = join(root, "stubborn.pid");
	t.after(() => {
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	const bin = join(root, "bin");
	const stubbornScript = join(root, "stubborn.js");
	writeFileSync(
		stubbornScript,
		`const fs = require("node:fs");\n` +
		`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
		`process.on("SIGTERM", () => {});\n` +
		`setTimeout(() => {}, 30000);\n`,
		"utf8",
	);
	installFakeBinary(bin, "hc", `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubbornScript)}\n`);

	const started = Date.now();
	await assert.rejects(
		() => selectHostBackend({ PATH: bin }, { probeTimeoutMs: 120 }),
		/No Host backend is available/i,
	);
	assert.ok(Date.now() - started < 3000, "probe hard deadline must settle even when child ignores SIGTERM");
});

test("hc server status rejects invalid/incomplete StatusResult in both probe and HcHost.preflight", async t => {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-hc-bad-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	installFakeBinary(bin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then echo '{"running":true}'; exit 0; fi\nexit 1\n`);

	await assert.rejects(
		() => selectHostBackend({ PATH: bin }),
		/No Host backend is available/i,
	);

	const host = createHost("hc", {
		env: { PATH: bin },
		exec: async (_cmd, args) => {
			if (args[0] === "server" && args[1] === "status") {
				return { code: 0, stdout: JSON.stringify({ running: true }), stderr: "" };
			}
			throw new Error(`Unexpected: ${args.join(" ")}`);
		},
	});
	await assert.rejects(
		() => host.preflight(),
		/hc preflight \(server status\) failed/i,
	);
});

test("hcTerminalName produces valid, deterministic, attempt-free, collision-resistant names", () => {
	const longA = "a".repeat(100) + "-alpha";
	const longB = "a".repeat(100) + "-beta";
	const nameA = hcTerminalName(longA, "a1-" + "x".repeat(40));
	const nameB = hcTerminalName(longB, "a1-" + "x".repeat(40));
	assert.match(nameA, /^[a-z0-9_-]{1,32}$/);
	assert.match(nameB, /^[a-z0-9_-]{1,32}$/);
	assert.notEqual(nameA, nameB);
	assert.equal(hcTerminalName(longA, "a1-" + "x".repeat(40)), nameA);

	const awkward1 = hcTerminalName("Task.With:Spaces/And!Symbols", "a1-node.1");
	const awkward2 = hcTerminalName("task-with-spaces-and-symbols", "a1-node_1");
	const punctuationOnly = hcTerminalName("!!!", "???");
	for (const candidate of [awkward1, awkward2, punctuationOnly]) {
		assert.match(candidate, /^[a-z0-9_-]{1,32}$/);
	}
	assert.notEqual(awkward1, awkward2);
});

test("BootstrapService launches on hc from ordinary shell, hc context, or explicit override without touching Herdr", async t => {
	const f = makeProjectFixture(t);
	const hcBin = join(f.root, "hc-bin");
	installFakeBinary(hcBin, "pi", "#!/bin/sh\nexit 0\n");
	installFakeBinary(hcBin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then printf '%s\\n' '${FAKE_HC_STATUS_JSON}'; exit 0; fi\nexit 1\n`);

	for (const env of [
		{ PATH: hcBin, PI_BOOTSTRAP_HOST: "hc", HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		{ PATH: hcBin, HC_TERMINAL_ID: "t0", HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		{ PATH: hcBin },
	]) {
		const fakeHc = makeFakeHcExec({
			cwd: f.cwd,
			acknowledge: true,
			callerTerminalId: env.HC_TERMINAL_ID,
		});
		const service = new BootstrapService({
			exec: fakeHc.exec,
			extensionDir: f.extensionDir,
			stateDir: f.stateDir,
			home: f.home,
			env,
			pollMs: 5,
		});
		const run = await service.generate(f.request);
		assert.equal(run.status, "applied");
		assert.equal(run.host_backend, "hc");
		assert.equal(run.workspace_id, "hc");
		assert.equal(hostBackendOf(run), "hc");
		assert.equal(run.pane_manifest.length, 2);
		for (const entry of run.pane_manifest) {
			assert.equal(entry.tab_id, undefined);
			assert.equal(entry.pane_id, undefined);
			assert.equal(entry.terminal_id, undefined);
			const expectedName = hcTerminalName(run.task_id, entry.instance_id);
			assert.deepEqual(entry.host_ref, {
				name: expectedName,
				address: (entry.host_ref as any).address,
			});
			const term = fakeHc.terminals.get((entry.host_ref as any).address)!;
			assert.ok(term);
			assert.equal(term.parent, null, "hc nodes must launch with --no-parent");
			assert.equal(term.notify, false, "hc nodes must launch with --no-notify");
			assert.equal(term.cwd, f.cwd);
			assert.deepEqual(term.labels, { bootstrap_run: run.task_id, bootstrap_node: entry.instance_id });

			const launcherText = readFileSync(join(run.session_dir, `${entry.instance_id}.sh`), "utf8");
			assert.match(launcherText, /^unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_SOCKET_PATH$/m);
			assert.match(launcherText, /export PI_COMS_DIR=/);
			assert.match(launcherText, /export PI_COMS_TIMEOUT_MS='300000'/);
			assert.match(launcherText, /export PI_COMS_MAX_HOPS=/);
		}
		// Name collision on live duplicate fails closed with name_taken via HcHost.launchNode instead of adopting or renaming.
		const host = createHost("hc", { exec: fakeHc.exec, env });
		const preflight = await host.preflight();
		const firstEntry = run.pane_manifest[0]!;
		await assert.rejects(
			() => host.launchNode({
				name: firstEntry.label,
				runId: run.task_id,
				instanceId: firstEntry.instance_id,
				directory: f.cwd,
				launcher: join(run.session_dir, `${firstEntry.instance_id}.sh`),
				environment: { PI_COMS_DIR: join(f.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
				preflight,
			}),
			/name_taken/,
		);
		// Launching twice directly through host.launchNode also rejects the second live duplicate with name_taken.
		const dupLauncher = join(f.root, "dup-node.sh");
		writeFileSync(dupLauncher, "#!/bin/sh\nexit 0\n");
		await host.launchNode({
			name: "dup-run:a1-dup",
			runId: "dup-run",
			instanceId: "a1-dup",
			directory: f.cwd,
			launcher: dupLauncher,
			environment: { PI_COMS_DIR: join(f.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
			preflight,
		});
		await assert.rejects(
			() => host.launchNode({
				name: "dup-run:a1-dup",
				runId: "dup-run",
				instanceId: "a1-dup",
				directory: f.cwd,
				launcher: dupLauncher,
				environment: { PI_COMS_DIR: join(f.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
				preflight,
			}),
			/name_taken/,
		);
	}
	assert.equal(f.fake.calls.length, 0);
});

test("executed hc launcher strips inherited HERDR_* env vars while preserving PI_COMS_* vars (Herdr launcher unchanged)", async t => {
	const f = makeProjectFixture(t);
	const envDumpPath = join(f.root, "child-env.txt");
	const hcBin = join(f.root, "hc-exec-bin");
	installFakeBinary(
		hcBin,
		"pi",
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(envDumpPath)}\n`,
	);
	installFakeBinary(
		hcBin,
		"hc",
		`#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then printf '%s\\n' '${FAKE_HC_STATUS_JSON}'; exit 0; fi\nexit 1\n`,
	);

	const fakeHc = makeFakeHcExec({
		cwd: f.cwd,
		acknowledge: true,
		runLauncher: true,
		launcherEnv: {
			PATH: hcBin,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "p-inherited",
			HERDR_TAB_ID: "t-inherited",
			HERDR_WORKSPACE_ID: "ws-inherited",
			HERDR_SOCKET_PATH: "/tmp/inherited-herdr.sock",
		},
	});
	const hcService = new BootstrapService({
		exec: fakeHc.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: hcBin, PI_BOOTSTRAP_HOST: "hc" },
		pollMs: 5,
	});
	const hcRun = await hcService.generate({
		...f.request,
		agents: [{ node_id: "n1", persona: "first", sub_task: "Step 1" }],
	});
	assert.equal(hcRun.status, "applied");
	const childEnv = JSON.parse(readFileSync(envDumpPath, "utf8")) as Record<string, string>;
	for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]) {
		assert.equal(key in childEnv, false, `hc child process must not inherit ${key}`);
	}
	assert.ok(childEnv.PI_COMS_DIR, "hc child process must receive PI_COMS_DIR");
	assert.equal(childEnv.PI_COMS_TIMEOUT_MS, "300000");
	assert.ok(Number(childEnv.PI_COMS_MAX_HOPS) >= 5, "hc child process must receive PI_COMS_MAX_HOPS");

	// Herdr launcher keeps its exact structure without `unset HERDR_*` or `export PI_COMS_DIR`.
	const herdrService = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		pollMs: 5,
	});
	const herdrRun = await herdrService.generate({
		...f.request,
		agents: [{ node_id: "n1", persona: "first", sub_task: "Step 1" }],
	});
	const herdrLauncher = readFileSync(join(herdrRun.session_dir, `${herdrRun.pane_manifest[0]!.instance_id}.sh`), "utf8");
	assert.doesNotMatch(herdrLauncher, /\bunset HERDR_ENV\b/);
	assert.doesNotMatch(herdrLauncher, /\bexport PI_COMS_DIR=/);
});

test("hc discovery queries hc ls --label then confirms each terminal with hc get; never decides by name alone", async t => {
	const f = makeProjectFixture(t);
	const hcBin = join(f.root, "hc-disc-bin");
	installFakeBinary(hcBin, "hc", "#!/bin/sh\nexit 0\n");
	const fakeHc = makeFakeHcExec({ cwd: f.cwd, omitLabelsInLs: true });
	const host = createHost("hc", { exec: fakeHc.exec, env: { PATH: hcBin } });

	const runId = "hc-disc-run";
	const launcher = join(f.root, "worker.sh");
	writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
	const preflight = await host.preflight();
	const handle = await host.launchNode({
		name: `${runId}:a1-n1`,
		runId,
		instanceId: "a1-n1",
		directory: f.cwd,
		launcher,
		environment: { PI_COMS_DIR: join(f.root, "coms"), PI_COMS_TIMEOUT_MS: "300000" },
		preflight,
	});
	const target = {
		run_id: runId,
		node_id: "n1",
		persona_name: "first",
		instance_id: "a1-n1",
		label: `${runId}:a1-n1`,
		host_ref: handle.host_ref,
	};

	// Even when `ls` omits labels, `get` confirms ownership.
	const discovered = await host.discoverOwnedNodes([target]);
	assert.equal(discovered[0]!.existence.state, "present");
	const lsIdx = fakeHc.calls.findIndex(c => c[0] === "ls");
	const getIdx = fakeHc.calls.findIndex(c => c[0] === "get");
	assert.ok(lsIdx !== -1 && getIdx > lsIdx, "must filter with hc ls first, then confirm with hc get");

	// Renaming the terminal in hc keeps it owned (address + labels still match).
	const addr = String((handle.host_ref as any).address);
	fakeHc.terminals.get(addr)!.name = "operator-renamed";
	assert.equal((await host.nodeExists(target)).state, "present");

	// Replacing the terminal with a look-alike of the same name at another address without matching labels reports gone.
	fakeHc.terminals.delete(addr);
	fakeHc.terminals.set("t99", {
		address: "t99",
		name: String((handle.host_ref as any).name),
		cwd: f.cwd,
		argv: ["/bin/sh", launcher],
		labels: {},
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
	assert.equal((await host.nodeExists(target)).state, "gone");

	// Unrecorded handle (no saved address) with matching labels fails closed as ambiguous rather than adopting by label alone.
	fakeHc.terminals.get("t99")!.labels = { bootstrap_run: runId, bootstrap_node: "a1-n1" };
	assert.equal((await host.nodeExists({ ...target, host_ref: undefined })).state, "ambiguous");

	// Close on hc reports not-implemented-yet; wake-up runs through HcHost and skips cleanly when no readiness record exists.
	await assert.rejects(() => host.closeNode(target), /not implemented yet/i);
	const wakeRes = await host.sendWakeUp({
		sessionDir: f.root,
		destinationAttempt: "a1-n1.1",
		handoffId: "h-" + "0".repeat(32),
	});
	assert.equal(wakeRes.outcome, "skipped");
	assert.match((wakeRes as { reason: string }).reason, /no readiness record/i);
});

test("new manifests record host_backend=herdr and per-launch host_ref mirroring Herdr fields", async t => {
	const f = makeProjectFixture(t);
	const service = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		pollMs: 5,
	});
	const run = await service.generate(f.request);
	assert.equal(run.status, "applied");
	assert.equal(run.host_backend, "herdr");
	assert.equal(hostBackendOf(run), "herdr");
	assert.equal(run.pane_manifest.length, 2);
	for (const entry of run.pane_manifest) {
		assert.deepEqual(entry.host_ref, {
			tab_id: entry.tab_id,
			pane_id: entry.pane_id,
			terminal_id: entry.terminal_id,
			label: entry.label,
		});
	}
	const persistedIndex = readJson<any>(join(f.stateDir, `${run.task_id}.json`));
	const persistedLocal = readJson<any>(join(run.session_dir, "manifest.json"));
	for (const persisted of [persistedIndex, persistedLocal]) {
		assert.equal(persisted.host_backend, "herdr");
		assert.deepEqual(persisted.pane_manifest[0].host_ref, {
			tab_id: "t1",
			pane_id: "p1",
			terminal_id: "term1",
			label: `${run.task_id}:a1-n1`,
		});
		assert.doesNotThrow(() => parseManifest(persisted, run.task_id));
	}
});

test("old manifests without host_backend or host_ref read as Herdr and clean up by tab_id even in an hc caller env", async t => {
	const f = makeProjectFixture(t);
	const service = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		pollMs: 5,
	});
	const run = await service.generate(f.request);
	// Strip host_backend and host_ref from persisted manifests to simulate a pre-Host-seam run.
	for (const path of [join(f.stateDir, `${run.task_id}.json`), join(run.session_dir, "manifest.json")]) {
		const raw = readJson<any>(path);
		delete raw.host_backend;
		for (const entry of raw.pane_manifest) delete entry.host_ref;
		atomicJson(path, raw);
	}

	// Inspect/recover/cleanup from a different caller environment (HC_TERMINAL_ID / PI_BOOTSTRAP_HOST=hc)
	// still uses the manifest's recorded backend (absent -> herdr).
	const alienService = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HC_TERMINAL_ID: "t-99", PI_BOOTSTRAP_HOST: "hc" },
		pollMs: 5,
	});
	const loaded = alienService.store.load(run.task_id);
	assert.equal(loaded.host_backend, undefined);
	assert.equal(hostBackendOf(loaded), "herdr");
	assert.equal(alienService.status(run.task_id).manifest.task_id, run.task_id);

	// Subset cleanup by tab_id still works on old manifests.
	const partial = await alienService.cleanup(run.task_id, [run.pane_manifest[0].tab_id!]);
	assert.equal(partial.phase, "partially-cleaned");
	assert.equal(f.fake.tabs.length, 1);

	const full = await alienService.cleanup(run.task_id);
	assert.equal(full.status, "cleaned");
	assert.equal(f.fake.tabs.length, 0);
});

test("parseManifest validates host_backend and host_ref strictly while accepting both old and new manifests", () => {
	const base = {
		version: 2,
		request_form: "nodes",
		task_id: "run-validate-1",
		task: "Validate",
		topology: "team",
		project_cwd: "/tmp/proj",
		session_dir: "/tmp/proj/.pi/agent-sessions/run-validate-1",
		workspace_id: "ws-1",
		coms_project: "boot-run-validate-1",
		status: "applied",
		phase: "released",
		token: "tok",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		pane_manifest: [
			{
				node_id: "n1",
				persona_name: "first",
				attempt_id: "a1-n1.1",
				instance_id: "a1-n1",
				expected_coms_name: "a1-n1",
				expected_model: "provider/model",
				label: "run-validate-1:a1-n1",
				tab_id: "t1",
				pane_id: "p1",
				terminal_id: "term1",
				status: "released",
			},
		],
	};
	// Old manifest (no host_backend, no host_ref)
	assert.equal(hostBackendOf(parseManifest(base, "run-validate-1")), "herdr");
	// New manifest with herdr or hc
	assert.equal(parseManifest({ ...base, host_backend: "herdr", pane_manifest: [{ ...base.pane_manifest[0], host_ref: { tab_id: "t1" } }] }, "run-validate-1").host_backend, "herdr");
	assert.equal(parseManifest({ ...base, host_backend: "hc", pane_manifest: [{ ...base.pane_manifest[0], host_ref: { name: "n", address: "t1" } }] }, "run-validate-1").host_backend, "hc");
	// Invalid host_backend / host_ref
	assert.throws(() => parseManifest({ ...base, host_backend: "tmux" }, "run-validate-1"), /host_backend/);
	assert.throws(() => parseManifest({ ...base, pane_manifest: [{ ...base.pane_manifest[0], host_ref: "bad" }] }, "run-validate-1"), /host_ref/);
	assert.throws(() => parseManifest({ ...base, pane_manifest: [{ ...base.pane_manifest[0], host_ref: [] }] }, "run-validate-1"), /host_ref/);
	assert.throws(() => parseManifest({ ...base, host_backend: "hc", pane_manifest: [{ ...base.pane_manifest[0], host_ref: { name: "n" } }] }, "run-validate-1"), /host_ref\.address/);
	assert.throws(() => parseManifest({ ...base, host_backend: "hc", pane_manifest: [{ ...base.pane_manifest[0], host_ref: { address: "t1" } }] }, "run-validate-1"), /host_ref\.name/);
});

test("HerdrHost ignores empty-string tab/pane/terminal IDs in early onUpdate", async t => {
	const f = makeProjectFixture(t);
	const updates: any[] = [];
	const host = new HerdrHost({
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		exec: async (_cmd, args) => {
			if (args[0] === "tab" && args[1] === "create") {
				return {
					code: 0,
					stdout: JSON.stringify({ result: { tab: { tab_id: "t1" }, root_pane: { pane_id: "", terminal_id: "" } } }),
					stderr: "",
				};
			}
			throw new Error(`Unexpected: ${args.join(" ")}`);
		},
	});
	const launcher = join(f.root, "a1.sh");
	writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
	await assert.rejects(() => host.launchNode({
		name: "r1:a1-n1",
		directory: f.cwd,
		launcher,
		environment: {},
		preflight: { backend: "herdr", workspace_id: "ws-origin" },
		onUpdate: partial => updates.push(partial),
	}), /Created root pane_id/);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].tab_id, "t1");
	assert.equal("pane_id" in updates[0], false);
	assert.equal("terminal_id" in updates[0], false);
	assert.deepEqual(updates[0].host_ref, { tab_id: "t1", label: "r1:a1-n1" });
});

test("recovery redelivery from a different caller env uses the manifest's recorded host_backend", async t => {
	const f = makeProjectFixture(t);
	const herdrService = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		pollMs: 5,
	});
	const run = await herdrService.generate(f.request);
	// Record completion on first agent so second agent has an unclaimed offer to redeliver.
	const n1 = run.pane_manifest[0]!;
	const n2 = run.pane_manifest[1]!;
	const { completionRecord, resultPath } = await import("./session-store.ts");
	const { offerHandoff } = await import("./handoff.ts");
	const n1Config = readJson<WorkerConfig>(join(run.session_dir, `${n1.instance_id}.config.json`));
	const n2ReadyPath = readyPath(run.session_dir, n2.instance_id);
	const n2Ready = readJson<Record<string, unknown>>(n2ReadyPath);
	atomicJson(n2ReadyPath, { ...n2Ready, pane_id: n2.pane_id });
	const completion = completionRecord(n1Config, { agent_name: n1.persona_name, status: "success", summary: "done", detail: "ok" }, "failed", new Date().toISOString());
	const n1Result = resultPath(run.session_dir, n1.instance_id);
	atomicJson(n1Result, completion);
	offerHandoff(n1Config, completion, n1Result, undefined, undefined, n2.instance_id);

	// Recover from an hc caller env: must still dispatch wake-up via HerdrHost (not hc).
	const hcCallerBin = join(f.root, "hc-caller-bin");
	installFakeBinary(hcCallerBin, "pi", "#!/bin/sh\nexit 0\n");
	installFakeBinary(
		hcCallerBin,
		"herdr",
		`#!/bin/sh\nif [ "$1" = "pane" ] && [ "$2" = "get" ]; then echo '{"result":{"pane":{"pane_id":"'"$3"'"}}}'; exit 0; fi\nexit 0\n`,
	);
	installFakeBinary(hcCallerBin, "hc", `#!/bin/sh\nprintf '%s\\n' '${FAKE_HC_STATUS_JSON}'\n`);
	const alienRecoverService = new BootstrapService({
		exec: f.fake.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: hcCallerBin, HC_TERMINAL_ID: "t0", PI_BOOTSTRAP_HOST: "hc" },
		pollMs: 5,
	});
	const report = await alienRecoverService.recover(run.task_id, { action: "retry_delivery", agent: n2.node_id }, {
		wake: async () => { throw new Error("coms: unreachable: no peer"); },
		senderSession: "s-disp",
	});
	// HerdrHost.sendWakeUp calls tryPaneWake which spawns `herdr` on PATH, proving recovery routed through
	// the manifest's recorded Herdr backend rather than the caller's hc environment.
	assert.equal(report.delivery?.transport, "pane_fallback");
});

test("recovery redelivery on an hc run reaches the hc node through HcHost from a different caller env", async t => {
	const f = makeProjectFixture(t);
	const hcBin = join(f.root, "hc-recover-bin");
	installFakeBinary(hcBin, "pi", "#!/bin/sh\nexit 0\n");
	installFakeBinary(hcBin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then printf '%s\\n' '${FAKE_HC_STATUS_JSON}'; exit 0; fi\nexit 1\n`);
	const fakeHc = makeFakeHcExec({ cwd: f.cwd, acknowledge: true });
	const hcService = new BootstrapService({
		exec: fakeHc.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: hcBin, PI_BOOTSTRAP_HOST: "hc" },
		pollMs: 5,
	});
	const run = await hcService.generate(f.request);
	const n1 = run.pane_manifest[0]!;
	const n2 = run.pane_manifest[1]!;
	const { completionRecord, resultPath } = await import("./session-store.ts");
	const { offerHandoff } = await import("./handoff.ts");
	const n1Config = readJson<WorkerConfig>(join(run.session_dir, `${n1.instance_id}.config.json`));
	const n2ReadyPath = readyPath(run.session_dir, n2.instance_id);
	const n2Ready = readJson<Record<string, unknown>>(n2ReadyPath);
	atomicJson(n2ReadyPath, { ...n2Ready, host_ref: n2.host_ref });
	const completion = completionRecord(n1Config, { agent_name: n1.persona_name, status: "success", summary: "done", detail: "ok" }, "failed", new Date().toISOString());
	const n1Result = resultPath(run.session_dir, n1.instance_id);
	atomicJson(n1Result, completion);
	const offer = offerHandoff(n1Config, completion, n1Result, undefined, undefined, n2.instance_id);

	// Recover from an environment with NO hc context (and even HERDR_ENV=1 + PI_BOOTSTRAP_HOST=herdr):
	// recovery must still use the manifest's recorded host_backend ("hc").
	const alienRecoverService = new BootstrapService({
		exec: fakeHc.exec,
		extensionDir: f.extensionDir,
		stateDir: f.stateDir,
		home: f.home,
		env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller", PI_BOOTSTRAP_HOST: "herdr" },
		pollMs: 5,
	});

	// 1. When destination hc terminal is blocked, redelivery skips without --force and leaves offer on disk.
	const n2Addr = String((n2.host_ref as any).address);
	fakeHc.terminals.get(n2Addr)!.status = "blocked";
	const skippedReport = await alienRecoverService.recover(run.task_id, { action: "retry_delivery", agent: n2.node_id }, {
		wake: async () => { throw new Error("coms: unreachable: no peer"); },
		senderSession: "s-disp",
	});
	assert.equal(skippedReport.delivery?.transport, "skipped");
	assert.match(skippedReport.delivery?.error ?? "", /blocked/i);
	assert.equal(fakeHc.calls.some(c => c.includes("--force")), false);
	assert.equal(fakeHc.sent.length, 0);

	// 2. Once unblocked, redelivery sends through hc send without --force.
	fakeHc.terminals.get(n2Addr)!.status = "idle";
	const sentReport = await alienRecoverService.recover(run.task_id, { action: "retry_delivery", agent: n2.node_id }, {
		wake: async () => { throw new Error("coms: unreachable: no peer"); },
		senderSession: "s-disp",
	});
	assert.equal(sentReport.delivery?.transport, "pane_fallback");
	assert.deepEqual(fakeHc.sent, [{ address: n2Addr, text: `[BOOTSTRAP_WAKE handoff=${offer.handoff_id}]`, forced: false }]);
	assert.equal(fakeHc.calls.some(c => c.includes("--force")), false);
});

test("HerdrHost implements nodeExists, discoverOwnedNodes, and closeNode with rearranged-tab protection", async t => {
	const f = makeProjectFixture(t);
	const host = new HerdrHost({ exec: f.fake.exec, env: { PATH: f.bin, HERDR_ENV: "1", HERDR_PANE_ID: "caller" } });
	const preflight = await host.preflight();
	assert.equal(preflight.backend, "herdr");
	assert.equal(preflight.workspace_id, "ws-origin");

	const target = {
		node_id: "n1",
		persona_name: "first",
		instance_id: "a1-n1",
		label: "run-x:a1-n1",
		tab_id: "t1",
		pane_id: "p1",
		terminal_id: "term1",
	};
	assert.equal((await host.nodeExists(target)).state, "gone");
	f.fake.tabs.push({ tab_id: "t1", label: "run-x:a1-n1", workspace_id: "ws-origin" });
	f.fake.panes.push({ tab_id: "t1", pane_id: "p1", terminal_id: "term1", label: "run-x:a1-n1", workspace_id: "ws-origin" });
	assert.equal((await host.nodeExists(target)).state, "present");

	// Ambiguous terminal ownership when two panes share terminal_id
	f.fake.tabs.push({ tab_id: "t2", label: "other", workspace_id: "ws-origin" });
	f.fake.panes.push({ tab_id: "t2", pane_id: "p2", terminal_id: "term1", label: "other", workspace_id: "ws-origin" });
	assert.equal((await host.nodeExists(target)).state, "ambiguous");

	// Rearranged tab (tab contains an extra unrelated pane) closes only our pane, leaving the tab's other pane intact.
	f.fake.tabs.splice(0, f.fake.tabs.length, { tab_id: "t1", label: "run-x:a1-n1", workspace_id: "ws-origin" });
	f.fake.panes.splice(0, f.fake.panes.length,
		{ tab_id: "t1", pane_id: "p1", terminal_id: "term1", label: "run-x:a1-n1", workspace_id: "ws-origin" },
		{ tab_id: "t1", pane_id: "p-user", terminal_id: "term-user", label: "user", workspace_id: "ws-origin" },
	);
	const discovered = await host.discoverOwnedNodes([target]);
	assert.equal(discovered[0].existence.state, "present");
	const closed = await host.closeNode(target);
	assert.equal(closed.outcome, "closed");
	assert.ok(f.fake.calls.some(c => c[0] === "pane" && c[1] === "close" && c[2] === "p1"));
	assert.ok(!f.fake.calls.some(c => c[0] === "tab" && c[1] === "close"));
	assert.equal(f.fake.tabs.length, 1);
	assert.equal(f.fake.panes.length, 1);
	assert.equal(f.fake.panes[0].pane_id, "p-user");
});
