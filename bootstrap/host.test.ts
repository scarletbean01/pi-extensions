/** Outside-in tests for Host selection, Herdr Host backend, manifest host_backend/host_ref, and legacy compatibility. */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostBackendOf, requireSupportedHost, selectHostBackend } from "./host.ts";
import { HerdrHost } from "./host-herdr.ts";
import { BootstrapService, type ExecResult, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, parseManifest, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";

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
	installFakeBinary(liveHcBin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then echo '{"running":true}'; exit 0; fi\nexit 1\n`);
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
	// HERDR_ENV=0 or missing HERDR_PANE_ID does not count as Herdr context.
	await assert.rejects(
		() => selectHostBackend({ HERDR_ENV: "0", HERDR_PANE_ID: "p-9", PATH: emptyBin }),
		/hc.*herdr/i,
	);
	await assert.rejects(
		() => selectHostBackend({ HERDR_ENV: "1", PATH: emptyBin }),
		/hc.*herdr/i,
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

	// Ticket 02 guard: hc selection is rejected clearly with "not available yet".
	assert.throws(() => requireSupportedHost({ backend: "hc", source: "explicit" }), /hc backend is not available yet/i);
	assert.equal(requireSupportedHost({ backend: "herdr", source: "context" }), "herdr");
});

test("BootstrapService rejects hc selection before launch without touching Herdr or creating session files", async t => {
	const f = makeProjectFixture(t);
	const hcBin = join(f.root, "hc-bin");
	installFakeBinary(hcBin, "pi", "#!/bin/sh\nexit 0\n");
	installFakeBinary(hcBin, "herdr", "#!/bin/sh\nexit 0\n");
	installFakeBinary(hcBin, "hc", `#!/bin/sh\nif [ "$1" = "server" ] && [ "$2" = "status" ]; then echo '{"running":true}'; exit 0; fi\nexit 1\n`);

	for (const env of [
		{ PATH: f.bin, PI_BOOTSTRAP_HOST: "hc", HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		{ PATH: f.bin, HC_TERMINAL_ID: "t1", HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
		{ PATH: hcBin },
	]) {
		const service = new BootstrapService({
			exec: f.fake.exec,
			extensionDir: f.extensionDir,
			stateDir: f.stateDir,
			home: f.home,
			env,
			pollMs: 5,
		});
		await assert.rejects(() => service.generate(f.request), /hc backend is not available yet/i);
	}
	assert.equal(f.fake.calls.length, 0);
	assert.equal(existsSync(join(f.cwd, ".pi", "agent-sessions")), false);
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
