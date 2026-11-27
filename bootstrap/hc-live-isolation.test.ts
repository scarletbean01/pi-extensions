import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSuite } from "./run-tests.ts";
import { runSupervised } from "./test-harness.ts";

test("hc live CLI environment contains only allowed parent values, scratch settings, and systemd shims first on PATH", { timeout: 10_000 }, async t => {
	const {
		buildHcEnvironment, assertHcEnvironment, installHcShims, hcShimDir, hcShimLogPath, HC_SYSTEMD_SHIMS,
	} = await import("./test-support/hc-live-env.ts");
	const root = mkdtempSync(join(realpathSync(tmpdir()), "bootstrap-hc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fakeHcDir = join(root, "fake-hc-bin");
	const unrelatedDir = join(root, "unrelated-bin");
	mkdirSync(fakeHcDir, { recursive: true });
	mkdirSync(unrelatedDir, { recursive: true });
	writeFileSync(join(fakeHcDir, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	writeFileSync(join(unrelatedDir, "custom-unrelated"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const rawPath = `${unrelatedDir}:${fakeHcDir}:/usr/bin`;
	const baseline = buildHcEnvironment(root, { PATH: rawPath, LANG: "C" });
	const poisoned = buildHcEnvironment(root, {
		PATH: rawPath, LANG: "C", HOME: "/operator", TMPDIR: "/operator/tmp",
		HC_SESSION: "operator", HC_SOCKET: "/operator/core.sock", HC_RUNTIME: "/operator/run",
		HC_TERMINAL_ID: "operator/t1", HC_FUTURE: "secret",
		XDG_CONFIG_HOME: "/operator/config", XDG_RUNTIME_DIR: "/operator/run",
		XDG_DATA_DIRS: "/operator/data", XDG_FUTURE: "secret",
		HERDR_ENV: "1", HERDR_PANE_ID: "operator", HERDR_FUTURE: "secret",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/dbus/system_bus_socket",
		INVOCATION_ID: "operator-systemd-invocation",
		API_KEY: "secret", NODE_OPTIONS: "--require=/operator/startup",
	});
	assert.deepEqual(poisoned, baseline);
	assert.equal(poisoned.LANG, "C");
	assert.equal(poisoned.DBUS_SESSION_BUS_ADDRESS, undefined);
	assert.equal(poisoned.DBUS_SYSTEM_BUS_ADDRESS, undefined);
	assert.equal(poisoned.INVOCATION_ID, undefined);
	const pathParts = (poisoned.PATH ?? "").split(":");
	assert.equal(pathParts[0], hcShimDir(root), "shim dir must be first on PATH");
	assert.ok(pathParts.includes(fakeHcDir), "PATH keeps directory containing hc");
	assert.ok(pathParts.includes("/usr/bin"), "PATH keeps /usr/bin for sh/script");
	assert.ok(!pathParts.includes(unrelatedDir), "PATH drops directories without needed hc/shell tools");
	assert.match(poisoned.HC_SESSION!, /^bootstrap-hc-/);
	for (const key of ["HOME", "TMPDIR", "HC_SOCKET", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
		"XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
		assert.ok(poisoned[key]?.startsWith(root + "/"), key);
		assert.throws(() => assertHcEnvironment(root, { ...poisoned, [key]: undefined }), /isolation/);
	}
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_SESSION: undefined }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_SOCKET: "/operator/core.sock" }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, PATH: "/usr/bin" }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HERDR_ENV: "1" }), /isolation/);
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_RUNTIME: "1" }), /HC_RUNTIME|isolation/);
	assert.doesNotThrow(() => assertHcEnvironment(root, { ...poisoned, HC_RUNTIME: "1" }, { allowDaemonMarkers: true }));
	for (const badRuntime of ["0", "true", ""]) {
		assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_RUNTIME: badRuntime }, { allowDaemonMarkers: true }), /HC_RUNTIME|isolation/);
	}
	assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_RUNTIME: "1", HC_TERMINAL_ID: "t1" }, { allowDaemonMarkers: true }), /HC_TERMINAL_ID|isolation/);
	assert.doesNotThrow(() => assertHcEnvironment(root, {
		...poisoned,
		HC_TERMINAL_ID: "t1",
		HC_TERMINAL_SOCKET: poisoned.HC_SOCKET,
		HC_SCOPE: "1234-abcd",
	}, { allowTerminalMarkers: true }));
	assert.throws(() => assertHcEnvironment(root, {
		...poisoned,
		HC_TERMINAL_ID: "t1",
		HC_TERMINAL_SOCKET: "/operator/core.sock",
		HC_SCOPE: "1234-abcd",
	}, { allowTerminalMarkers: true }), /HC_TERMINAL_SOCKET|isolation/);
	assert.throws(() => assertHcEnvironment(root, {
		...poisoned,
		HC_RUNTIME: "1",
		HC_TERMINAL_ID: "t1",
	}, { allowTerminalMarkers: true }), /HC_RUNTIME|isolation/);
	assert.throws(() => assertHcEnvironment(root, poisoned, { allowDaemonMarkers: true, allowTerminalMarkers: true }), /mutually exclusive|isolation/i);
	for (const extra of [
		{ HC_EXTRA: "1" },
		{ XDG_EXTRA: "1" },
		{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
		{ HERDR_ENV: "1" },
		{ INVOCATION_ID: "unit-1" },
	]) {
		assert.throws(() => assertHcEnvironment(root, { ...poisoned, HC_RUNTIME: "1", ...extra }, { allowDaemonMarkers: true }), /isolation/);
	}
	assert.doesNotThrow(() => assertHcEnvironment(root, poisoned));

	const installed = installHcShims(root);
	assert.equal(installed.shimDir, hcShimDir(root));
	assert.equal(installed.logPath, hcShimLogPath(root));
	for (const cmd of ["systemd-run", "systemctl", "loginctl", "busctl", "sudo", "pkexec"]) {
		assert.ok((HC_SYSTEMD_SHIMS as readonly string[]).includes(cmd), `missing shim ${cmd}`);
		const shimPath = join(installed.shimDir, cmd);
		assert.ok(existsSync(shimPath), `shim file missing: ${shimPath}`);
		accessSync(shimPath, constants.X_OK);
		const res = await runSupervised(cmd, ["--user", "status", "probe-arg"], { cwd: root, env: poisoned, timeoutMs: 5000 });
		assert.notEqual(res.code, 0, `${cmd} shim must exit non-zero`);
	}
	const logLines = readFileSync(installed.logPath, "utf8").trim().split("\n");
	assert.equal(logLines.length, 6);
	assert.match(logLines[0], /systemd-run\t--user\tstatus\tprobe-arg/);
});

test("readCoreStatus and command enforce socket presence, core pid, /proc environ, systemd guards, and env allowlist", { timeout: 15_000 }, async t => {
	const { buildHcEnvironment, installHcShims } = await import("./test-support/hc-live-env.ts");
	const { assertSafeCoreCgroup, command, readCoreStatus } = await import("./test-support/hc-live-core.ts");
	const root = mkdtempSync(join(realpathSync("/tmp"), "bootstrap-hc-core-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
	installHcShims(root);
	const fakeBin = join(root, "fake-hc");
	mkdirSync(fakeBin, { recursive: true });
	const callsLog = join(root, "hc-calls.log");
	const statusReply = join(root, "status.json");
	writeFileSync(join(fakeBin, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}
cat ${JSON.stringify(statusReply)}
`, { mode: 0o700 });
	const env = buildHcEnvironment(root, { PATH: `${fakeBin}:/usr/bin` });
	const readCalls = () => existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean) : [];

	// Missing socket must fail before any hc call.
	await assert.rejects(() => readCoreStatus(root, env));
	assert.equal(readCalls().length, 0, "missing socket must reject with zero hc calls");

	// command() must reject unisolated env with zero hc calls.
	await assert.rejects(() => command(root, { ...env, HC_SOCKET: "/operator/core.sock" }, "hc", ["server", "status", "--json"]), /isolation/);
	await assert.rejects(() => command(root, { ...env, PATH: `${fakeBin}:/usr/bin` }, "hc", ["server", "status", "--json"]), /isolation/);
	assert.equal(readCalls().length, 0, "command() must reject unisolated env with zero hc calls");

	// Bind a real Unix socket inside the scratch root.
	const server = createServer();
	await new Promise<void>(resolve => server.listen(env.HC_SOCKET!, resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

	// Status without pid must throw.
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22" }));
	await assert.rejects(() => readCoreStatus(root, env), /pid/i);

	// Helper to spawn a real process whose /proc/<pid>/environ we control.
	const spawnSleep = async (childEnv: NodeJS.ProcessEnv) => {
		const child = spawn("/bin/sleep", ["30"], { env: childEnv, stdio: "ignore" });
		t.after(() => { try { child.kill("SIGKILL"); } catch {} });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(child.exitCode, null, "sleep helper exited prematurely");
		return child.pid!;
	};

	// Status pointing at a process with parent/non-isolated env must throw.
	const parentPid = await spawnSleep({ PATH: "/usr/bin", HC_SESSION: "operator", HERDR_ENV: "1" });
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: parentPid }));
	await assert.rejects(() => readCoreStatus(root, env), /isolation/);

	// Status pointing at a process with INVOCATION_ID must fail closed as systemd-launched.
	const systemdPid = await spawnSleep({ ...env, INVOCATION_ID: "systemd-unit-123" });
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: systemdPid }));
	await assert.rejects(() => readCoreStatus(root, env), /INVOCATION_ID|systemd/i);

	// Cgroup unit guard requires identical non-hc cgroup paths and fails closed with an actionable message for hc units.
	const callerScope = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-1.scope";
	assert.doesNotThrow(() => assertSafeCoreCgroup(callerScope, callerScope));
	assert.throws(() => assertSafeCoreCgroup(
		"0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.scope",
		callerScope,
	), /different from the test process/i);
	assert.throws(() => assertSafeCoreCgroup(
		"0::/user.slice/user-1000.slice/user@1000.service/app.slice/hc-t1.scope",
		callerScope,
	), /hosted by hc.*run from a terminal that is not/i);
	assert.throws(() => assertSafeCoreCgroup(
		"0::/user.slice/user-1000.slice/user@1000.service/app.slice/hc-serve-1000.service",
		callerScope,
	), /hosted by hc.*run from a terminal that is not/i);
	assert.throws(() => assertSafeCoreCgroup(
		"0::/user.slice/user-1000.slice/user@1000.service/app.slice/hc-t1.scope",
		"0::/user.slice/user-1000.slice/user@1000.service/app.slice/hc-t1.scope",
	), /hosted by hc.*run from a terminal that is not/i);

	// Valid isolated process (with or without daemon marker HC_RUNTIME=1) succeeds and reports identity + cgroup.
	const isolatedPid = await spawnSleep(env);
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: isolatedPid }));
	const verified = await readCoreStatus(root, env);
	assert.equal(verified.identity.id, "core-1");
	assert.equal(verified.identity.pid, isolatedPid);
	assert.ok(verified.cgroup.length > 0);

	const daemonPid = await spawnSleep({ ...env, HC_RUNTIME: "1" });
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: daemonPid }));
	const verifiedDaemon = await readCoreStatus(root, env);
	assert.equal(verifiedDaemon.identity.pid, daemonPid);

	const badRuntimePid = await spawnSleep({ ...env, HC_RUNTIME: "0" });
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: badRuntimePid }));
	await assert.rejects(() => readCoreStatus(root, env), /HC_RUNTIME|isolation/);

	const coreWithTerminalIdPid = await spawnSleep({ ...env, HC_RUNTIME: "1", HC_TERMINAL_ID: "t1" });
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: coreWithTerminalIdPid }));
	await assert.rejects(() => readCoreStatus(root, env), /HC_TERMINAL_ID|isolation/);

	// Terminal self-probe mode allows HC_TERMINAL_ID, HC_TERMINAL_SOCKET, and HC_SCOPE on the caller env
	// while still enforcing HC_RUNTIME=1-only on the daemon /proc/<pid>/environ and rejecting mismatched HC_TERMINAL_SOCKET.
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: daemonPid }));
	const terminalEnv = { ...env, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: env.HC_SOCKET, HC_SCOPE: "1234-abcd" };
	const terminalCmd = await command(root, terminalEnv, "hc", ["get", "--json", "t1"], 5_000, { allowTerminalMarkers: true });
	assert.equal(terminalCmd.code, 0);
	const terminalStatus = await readCoreStatus(root, terminalEnv, undefined, undefined, undefined, { allowTerminalMarkers: true });
	assert.equal(terminalStatus.identity.id, "core-1");
	assert.equal(terminalStatus.identity.pid, daemonPid);
	await assert.rejects(
		() => command(root, { ...terminalEnv, HC_TERMINAL_SOCKET: "/operator/core.sock" }, "hc", ["get", "--json", "t1"], 5_000, { allowTerminalMarkers: true }),
		/HC_TERMINAL_SOCKET|isolation/,
	);

	// readCoreStatus wires the cgroup check: a foreign cgroup returned for the core pid must throw.
	writeFileSync(statusReply, JSON.stringify({ core: { id: "core-1" }, version: "0.1.22", pid: daemonPid }));
	await assert.rejects(
		() => readCoreStatus(root, env, undefined, undefined, pid =>
			pid === "self" ? callerScope : "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.scope"),
		/different from the test process/i,
	);
	await assert.rejects(
		() => readCoreStatus(root, env, undefined, undefined, pid =>
			pid === "self" ? callerScope : "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hc-serve-1000.service"),
		/hosted by hc/i,
	);
});

test("signal forwarder runs orphan warning, removes listener, and re-raises signal; orphan warning prints kill hint for surviving PIDs", { timeout: 5_000 }, async () => {
	const { createSignalForwarder, formatOrphanWarning } = await import("./test-support/hc-live-core.ts");
	const events: string[] = [];
	const target = {
		pid: 4242,
		off: (sig: NodeJS.Signals, _fn: () => void) => { events.push(`off:${sig}`); },
		kill: (pid: number, sig: NodeJS.Signals) => { events.push(`kill:${pid}:${sig}`); },
	};
	const forwarder = createSignalForwarder(sig => { events.push(`warn:${sig}`); }, target);
	const sigintHandler = forwarder("SIGINT");
	sigintHandler();
	assert.deepEqual(events, ["warn:SIGINT", "off:SIGINT", "kill:4242:SIGINT"]);

	const throwingForwarder = createSignalForwarder(() => { throw new Error("warn failed"); }, target);
	const sigtermHandler = throwingForwarder("SIGTERM");
	assert.throws(() => sigtermHandler(), /warn failed/);
	assert.deepEqual(events.slice(3), ["off:SIGTERM", "kill:4242:SIGTERM"]);

	const postStopWarning = formatOrphanWarning({
		root: "/tmp/bootstrap-hc-abc",
		stopCommand: "env -i HC_SESSION=bootstrap-hc-abc hc server stop --json",
		socketExists: false,
		survivingPids: [101, 202, 203],
	});
	assert.match(postStopWarning, /\bkill 101 202 203\b/);

	const preStopWarning = formatOrphanWarning({
		root: "/tmp/bootstrap-hc-abc",
		stopCommand: "env -i HC_SESSION=bootstrap-hc-abc hc server stop --json",
		socketExists: true,
		survivingPids: [],
	});
	assert.match(preStopWarning, /hc server stop --json/);
	assert.doesNotMatch(preStopWarning, /\bkill \d+/);
});

test("stopCoreWithFallback stops via verified path and falls back to isolated stop + verified-session PID kill when verification fails", { timeout: 15_000 }, async t => {
	const { buildHcEnvironment, installHcShims } = await import("./test-support/hc-live-env.ts");
	const { stopCoreWithFallback } = await import("./test-support/hc-live-core.ts");

	const makeScratch = async (name: string) => {
		const root = mkdtempSync(join(realpathSync("/tmp"), `bootstrap-hc-fb-${name}-`));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
		installHcShims(root);
		const fakeBin = join(root, "fake-hc");
		mkdirSync(fakeBin, { recursive: true });
		const callsLog = join(root, "hc-calls.log");
		const stopBehavior = join(root, "stop-behavior");
		const statusReply = join(root, "status.json");
		const startPidFile = join(root, "start.pid");
		writeFileSync(join(fakeBin, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}
if [ "$1" = "server" ] && [ "$2" = "stop" ]; then
	mode=$(cat ${JSON.stringify(stopBehavior)} 2>/dev/null || echo "remove-all")
	if [ "$mode" = "remove-all" ]; then
		rm -f ${JSON.stringify(join(root, "runtime", "core.sock"))}
		if [ -f ${JSON.stringify(startPidFile)} ]; then
			kill -KILL "$(cat ${JSON.stringify(startPidFile)})" 2>/dev/null || true
		fi
		echo '{"stopped":true}'
		exit 0
	elif [ "$mode" = "remove-sock-only" ]; then
		rm -f ${JSON.stringify(join(root, "runtime", "core.sock"))}
		echo '{"stopped":true}'
		exit 0
	fi
	exit 1
fi
cat ${JSON.stringify(statusReply)}
`, { mode: 0o700 });
		const env = buildHcEnvironment(root, { PATH: `${fakeBin}:/usr/bin` });
		const server = createServer();
		await new Promise<void>(resolve => server.listen(env.HC_SOCKET!, resolve));
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		return { root, env, callsLog, stopBehavior, statusReply, startPidFile };
	};

	const spawnHelper = async (childEnv: NodeJS.ProcessEnv) => {
		const child = spawn("/bin/sleep", ["30"], { env: childEnv, stdio: "ignore" });
		t.after(() => { try { child.kill("SIGKILL"); } catch {} });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(child.exitCode, null);
		return child.pid!;
	};

	// Case 1: verification succeeds -> verified stop removes socket and reaps core pid.
	{
		const s = await makeScratch("verified");
		const pid = await spawnHelper({ ...s.env, HC_RUNTIME: "1" });
		writeFileSync(s.startPidFile, String(pid));
		writeFileSync(s.stopBehavior, "remove-all");
		writeFileSync(s.statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid, holders: [] }));
		const res = await stopCoreWithFallback(s.root, s.env, { startPid: pid });
		assert.equal(res.mode, "verified");
		assert.equal(res.stopped, true);
		assert.equal(res.remainingCoreAlive, false);
	}

	// Case 2: verification fails (unexpected HC_FUTURE) -> fallback runs isolated hc server stop --json and confirms startPid gone.
	{
		const s = await makeScratch("fb-stop");
		const pid = await spawnHelper({ ...s.env, HC_RUNTIME: "1", HC_FUTURE: "unexpected" });
		writeFileSync(s.startPidFile, String(pid));
		writeFileSync(s.stopBehavior, "remove-all");
		writeFileSync(s.statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid, holders: [] }));
		const res = await stopCoreWithFallback(s.root, s.env, { startPid: pid });
		assert.equal(res.mode, "fallback");
		assert.ok(res.verifyError, "expected verification error to be recorded");
		assert.equal(res.stop?.code, 0);
		assert.equal(res.stopped, true);
		assert.equal(res.remainingCoreAlive, false);
		assert.match(readFileSync(s.callsLog, "utf8"), /server stop --json/);
	}

	// Case 3: verification fails AND server stop leaves startPid alive with matching HC_SESSION -> fallback kills startPid.
	{
		const s = await makeScratch("fb-kill");
		const pid = await spawnHelper({ ...s.env, HC_RUNTIME: "1", HC_FUTURE: "unexpected" });
		writeFileSync(s.startPidFile, String(pid));
		writeFileSync(s.stopBehavior, "remove-sock-only");
		writeFileSync(s.statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid, holders: [] }));
		const res = await stopCoreWithFallback(s.root, s.env, { startPid: pid });
		assert.equal(res.mode, "fallback");
		assert.equal(res.fallbackKill?.pid, pid);
		assert.equal(res.fallbackKill?.verifiedHcSession, s.env.HC_SESSION);
		assert.equal(res.stopped, true);
		assert.equal(res.remainingCoreAlive, false);
	}

	// Case 4: verification fails AND startPid belongs to a different HC_SESSION -> fallback refuses to kill it.
	{
		const s = await makeScratch("fb-nokill");
		const foreignPid = await spawnHelper({ PATH: "/usr/bin", HC_SESSION: "operator-session" });
		writeFileSync(s.startPidFile, String(foreignPid));
		writeFileSync(s.stopBehavior, "remove-sock-only");
		writeFileSync(s.statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid: foreignPid, holders: [] }));
		const res = await stopCoreWithFallback(s.root, s.env, { startPid: foreignPid });
		assert.equal(res.mode, "fallback");
		assert.equal(res.fallbackKill, undefined);
		assert.equal(res.fallbackKillSkipped?.pid, foreignPid);
		assert.equal(res.stopped, false);
	}
});

test("stopCoreWithFallback refuses symlinked/foreign sockets and missing/empty HC_SESSION with zero hc calls and no signal", { timeout: 15_000 }, async t => {
	const { buildHcEnvironment, installHcShims } = await import("./test-support/hc-live-env.ts");
	const { processAlive, stopCoreWithFallback } = await import("./test-support/hc-live-core.ts");

	const makeTripwire = (name: string) => {
		const root = mkdtempSync(join(realpathSync("/tmp"), `bootstrap-hc-guard-${name}-`));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
		installHcShims(root);
		const fakeBin = join(root, "fake-hc");
		mkdirSync(fakeBin, { recursive: true });
		const callsLog = join(root, "hc-calls.log");
		writeFileSync(join(fakeBin, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}
exit 99
`, { mode: 0o700 });
		const env = buildHcEnvironment(root, { PATH: `${fakeBin}:/usr/bin` });
		const readCalls = () => existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean) : [];
		return { root, env, readCalls };
	};

	// Foreign listening Unix socket outside the scratch root.
	const foreignRoot = mkdtempSync(join(realpathSync("/tmp"), "bootstrap-hc-foreign-"));
	t.after(() => rmSync(foreignRoot, { recursive: true, force: true }));
	const foreignSocket = join(foreignRoot, "foreign.sock");
	const foreignServer = createServer();
	await new Promise<void>(resolve => foreignServer.listen(foreignSocket, resolve));
	t.after(() => new Promise<void>(resolve => foreignServer.close(() => resolve())));

	// 1a. Symlink at the scratch socket path pointing to a foreign listening Unix socket must fail in fallback with 0 hc calls.
	{
		const s = makeTripwire("symlink");
		symlinkSync(foreignSocket, s.env.HC_SOCKET!);
		await assert.rejects(() => stopCoreWithFallback(s.root, s.env), /private Unix socket|outside the scratch root/i);
		assert.equal(s.readCalls().length, 0, "fallback must not invoke hc when scratch socket is a symlink to a foreign socket");
	}

	// 1a-dangling. Dangling symlink at the scratch socket path pointing to a missing path must fail in fallback with 0 hc calls.
	{
		const s = makeTripwire("dangling-symlink");
		symlinkSync(join(foreignRoot, "missing.sock"), s.env.HC_SOCKET!);
		await assert.rejects(() => stopCoreWithFallback(s.root, s.env), /private Unix socket|outside the scratch root/i);
		assert.equal(s.readCalls().length, 0, "fallback must not invoke hc when scratch socket is a dangling symlink");
	}

	// 1b. HC_SOCKET pointing directly to a socket outside the scratch root must fail at entry with 0 hc calls.
	{
		const s = makeTripwire("foreign-env");
		await assert.rejects(
			() => stopCoreWithFallback(s.root, { ...s.env, HC_SOCKET: foreignSocket }),
			/isolation/i,
		);
		assert.equal(s.readCalls().length, 0, "entry guard must reject foreign HC_SOCKET with 0 hc calls");
	}

	// 2. Missing or empty HC_SESSION in env must refuse at entry with 0 hc calls and no signal to startPid.
	for (const badSession of [undefined, ""]) {
		const s = makeTripwire(`bad-session-${badSession === undefined ? "missing" : "empty"}`);
		const child = spawn("/bin/sleep", ["30"], {
			env: { PATH: "/usr/bin", ...(badSession === "" ? { HC_SESSION: "" } : {}) },
			stdio: "ignore",
		});
		t.after(() => { try { child.kill("SIGKILL"); } catch {} });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(child.exitCode, null);
		const signals: string[] = [];
		await assert.rejects(
			() => stopCoreWithFallback(s.root, { ...s.env, HC_SESSION: badSession }, {
				startPid: child.pid!,
				signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			}),
			/isolation.*HC_SESSION|HC_SESSION/i,
		);
		assert.equal(s.readCalls().length, 0, "missing/empty HC_SESSION must make 0 hc calls");
		assert.deepEqual(signals, [], "missing/empty HC_SESSION must send 0 signals");
		assert.equal(processAlive(child.pid!), true, "child process must remain unsignalled");
	}
});

test("stopCoreWithFallback skips kill on unreadable /proc environ, re-checks HC_SESSION before SIGKILL, refuses invalid/pid-1 startPid, and records verified stopError separately", { timeout: 15_000 }, async t => {
	const { buildHcEnvironment, installHcShims } = await import("./test-support/hc-live-env.ts");
	const { stopCoreWithFallback } = await import("./test-support/hc-live-core.ts");

	const makeEnv = async (name: string, options: { withSocket?: boolean; stopExitCode?: number } = {}) => {
		const root = mkdtempSync(join(realpathSync("/tmp"), `bootstrap-hc-harden-${name}-`));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
		installHcShims(root);
		const fakeBin = join(root, "fake-hc");
		mkdirSync(fakeBin, { recursive: true });
		const callsLog = join(root, "hc-calls.log");
		const statusReply = join(root, "status.json");
		writeFileSync(join(fakeBin, "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}
if [ "$1" = "server" ] && [ "$2" = "stop" ]; then
	exit ${options.stopExitCode ?? 0}
fi
cat ${JSON.stringify(statusReply)}
`, { mode: 0o700 });
		const env = buildHcEnvironment(root, { PATH: `${fakeBin}:/usr/bin` });
		if (options.withSocket) {
			const server = createServer();
			await new Promise<void>(resolve => server.listen(env.HC_SOCKET!, resolve));
			t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		}
		const readCalls = () => existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean) : [];
		return { root, env, statusReply, readCalls };
	};

	// A. Unreadable /proc environ skips kill with recorded reason and sends zero signals.
	{
		const s = await makeEnv("unreadable");
		const signals: string[] = [];
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: 424242,
			isProcessAlive: () => true,
			readProcEnviron: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
			signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.equal(res.fallbackKill, undefined);
		assert.equal(res.fallbackKillSkipped?.pid, 424242);
		assert.match(res.fallbackKillSkipped?.reason ?? "", /unreadable \/proc environ/i);
		assert.deepEqual(signals, []);
	}

	// A2. Readable /proc environ missing HC_SESSION or with empty HC_SESSION skips kill with mismatch reason and sends zero signals.
	for (const [label, rawEnv] of [["missing-hc-session", "PATH=/usr/bin\0"], ["empty-hc-session", "HC_SESSION=\0"]] as const) {
		const s = await makeEnv(label);
		const signals: string[] = [];
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: 424241,
			isProcessAlive: () => true,
			readProcEnviron: () => rawEnv,
			signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.equal(res.fallbackKill, undefined);
		assert.equal(res.fallbackKillSkipped?.pid, 424241);
		assert.match(res.fallbackKillSkipped?.reason ?? "", /HC_SESSION mismatch/i);
		assert.deepEqual(signals, []);
	}

	// B. /proc environ matching before SIGTERM, then changing before SIGKILL -> sends SIGTERM only and skips SIGKILL with recorded reason.
	{
		const s = await makeEnv("changed-before-kill");
		const signals: string[] = [];
		let reads = 0;
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: 424243,
			isProcessAlive: () => true,
			readProcEnviron: () => {
				reads += 1;
				return reads === 1 ? `HC_SESSION=${s.env.HC_SESSION}\0` : "HC_SESSION=reused-other-session\0";
			},
			signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.equal(reads, 2, "must re-read /proc/<pid>/environ before SIGKILL");
		assert.deepEqual(signals, ["424243:SIGTERM"]);
		assert.equal(res.fallbackKill?.signal, "SIGTERM");
		assert.equal(res.fallbackKillSkipped?.pid, 424243);
		assert.match(res.fallbackKillSkipped?.reason ?? "", /before SIGKILL|mismatch/i);
	}

	// C. /proc environ matching before SIGTERM, then unreadable before SIGKILL -> sends SIGTERM only and skips SIGKILL with recorded reason.
	{
		const s = await makeEnv("unreadable-before-kill");
		const signals: string[] = [];
		let reads = 0;
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: 424244,
			isProcessAlive: () => true,
			readProcEnviron: () => {
				reads += 1;
				if (reads === 1) return `HC_SESSION=${s.env.HC_SESSION}\0`;
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
			signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.equal(reads, 2);
		assert.deepEqual(signals, ["424244:SIGTERM"]);
		assert.equal(res.fallbackKill?.signal, "SIGTERM");
		assert.equal(res.fallbackKillSkipped?.pid, 424244);
		assert.match(res.fallbackKillSkipped?.reason ?? "", /unreadable \/proc environ.*SIGKILL/i);
	}

	// D. Positive control: /proc environ matches both before SIGTERM and before SIGKILL -> escalates to SIGKILL.
	{
		const s = await makeEnv("escalate-kill");
		const signals: string[] = [];
		let alive = true;
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: 424245,
			isProcessAlive: () => alive,
			readProcEnviron: () => `HC_SESSION=${s.env.HC_SESSION}\0`,
			signalProcess: (pid, sig) => {
				signals.push(`${pid}:${sig}`);
				if (sig === "SIGKILL") alive = false;
			},
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.deepEqual(signals, ["424245:SIGTERM", "424245:SIGKILL"]);
		assert.equal(res.fallbackKill?.signal, "SIGKILL");
		assert.equal(res.fallbackKillSkipped, undefined);
		assert.equal(res.stopped, true);
	}

	// E. M12: 0, -0, negative, 1, 1.5, 2**40, 2**53, Infinity, NaN, and a string are refused before any alive probe, environ read, or signal.
	for (const badPid of [0, -0, -1, -42, 1, 1.5, 2 ** 40, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN, "123"] as unknown[]) {
		const s = await makeEnv(`bad-pid-${Object.is(badPid, -0) ? "neg0" : String(badPid)}`);
		const signals: string[] = [];
		const aliveProbes: number[] = [];
		const environReads: number[] = [];
		const res = await stopCoreWithFallback(s.root, s.env, {
			startPid: badPid as number,
			isProcessAlive: pid => { aliveProbes.push(pid); return true; },
			readProcEnviron: pid => { environReads.push(pid); return `HC_SESSION=${s.env.HC_SESSION}\0`; },
			signalProcess: (pid, sig) => { signals.push(`${pid}:${sig}`); },
			stopWaitMs: 40,
			termWaitMs: 40,
			killWaitMs: 40,
		});
		assert.equal(res.mode, "fallback");
		assert.equal(res.corePid, null, `badPid ${String(badPid)} must not be accepted as corePid`);
		assert.equal(res.fallbackKill, undefined);
		assert.match(res.fallbackKillSkipped?.reason ?? "", /refused.*startPid/i);
		assert.deepEqual(aliveProbes, [], `badPid ${String(badPid)} must not probe processAlive`);
		assert.deepEqual(environReads, [], `badPid ${String(badPid)} must not read /proc environ`);
		assert.deepEqual(signals, [], `badPid ${String(badPid)} must never be signalled`);
	}

	// F. Verified teardown path: failing `hc server stop` is recorded as stopError, not verifyError / fallback mode.
	{
		const s = await makeEnv("verified-stop-fail", { withSocket: true, stopExitCode: 1 });
		const child = spawn("/bin/sleep", ["30"], { env: { ...s.env, HC_RUNTIME: "1" }, stdio: "ignore" });
		t.after(() => { try { child.kill("SIGKILL"); } catch {} });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(child.exitCode, null);
		writeFileSync(s.statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid: child.pid!, holders: [] }));
		const res = await stopCoreWithFallback(s.root, s.env, { startPid: child.pid! });
		assert.equal(res.mode, "verified");
		assert.equal(res.verifyError, undefined);
		assert.match(res.stopError ?? "", /hc server stop failed/i);
		assert.equal(res.stop.code, 1);
		assert.equal(res.stopped, false);
		assert.deepEqual(
			s.readCalls().filter(line => line.startsWith("server stop")),
			["server stop --json"],
			"verified stop failure must not enter fallback and run server stop twice",
		);
	}

	// G. Verified teardown path: `stopped` must remain false when `stopError` is set even if socket is removed and core/holder pids are dead.
	{
		const root = mkdtempSync(join(realpathSync("/tmp"), "bootstrap-hc-harden-stoperr-clean-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "runtime"), { recursive: true, mode: 0o700 });
		installHcShims(root);
		const fakeBin = join(root, "fake-hc");
		mkdirSync(fakeBin, { recursive: true });
		const statusReply = join(root, "status.json");
		const sockPath = join(root, "runtime", "core.sock");
		const fakeHcPath = join(fakeBin, "hc");
		writeFileSync(fakeHcPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const env = buildHcEnvironment(root, { PATH: `${fakeBin}:/usr/bin` });
		const child = spawn("/bin/sleep", ["30"], { env: { ...env, HC_RUNTIME: "1" }, stdio: "ignore" });
		t.after(() => { try { child.kill("SIGKILL"); } catch {} });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(child.exitCode, null);
		writeFileSync(fakeHcPath, `#!/bin/sh
if [ "$1" = "server" ] && [ "$2" = "stop" ]; then
	rm -f ${JSON.stringify(sockPath)}
	kill -KILL ${child.pid!} 2>/dev/null || true
	/bin/sleep 0.05
	exit 1
fi
cat ${JSON.stringify(statusReply)}
`, { mode: 0o700 });
		const server = createServer();
		await new Promise<void>(resolve => server.listen(env.HC_SOCKET!, resolve));
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		writeFileSync(statusReply, JSON.stringify({ core: { id: "c1" }, version: "0.1.22", pid: child.pid!, holders: [] }));
		const res = await stopCoreWithFallback(root, env, { startPid: child.pid! });
		assert.equal(res.mode, "verified", res.verifyError);
		assert.match(res.stopError ?? "", /hc server stop failed/i);
		assert.equal(res.socketRemaining, false);
		assert.equal(res.remainingCoreAlive, false);
		assert.deepEqual(res.remainingHolderPids, []);
		assert.equal(res.stopped, false);
	}
});

test("isKillablePid, processAlive, and extractHolderPids enforce pid bounds and error semantics", async () => {
	const { extractHolderPids, formatOrphanWarning, isKillablePid, MAX_KILLABLE_PID, processAlive } = await import("./test-support/hc-live-core.ts");
	assert.equal(MAX_KILLABLE_PID, 0x7fffffff);
	for (const valid of [2, 42, 0x7fffffff]) {
		assert.equal(isKillablePid(valid), true, `expected ${valid} to be killable`);
	}
	for (const invalid of [0, -0, -1, 1, 1.5, 2 ** 40, 2 ** 53, 0x80000000, Number.POSITIVE_INFINITY, Number.NaN, "42", null, undefined]) {
		assert.equal(isKillablePid(invalid), false, `expected ${String(invalid)} not to be killable`);
	}

	assert.equal(processAlive(42, () => {}), true);
	assert.equal(processAlive(42, () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }), true);
	for (const code of ["ESRCH", "EINVAL", "EACCES", undefined]) {
		assert.equal(
			processAlive(42, () => { throw Object.assign(new Error(String(code)), code ? { code } : {}); }),
			false,
			`expected error code ${String(code)} to report not alive`,
		);
	}
	for (const bad of [0, -0, -1, 1.5, 2 ** 40, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN]) {
		let called = false;
		assert.equal(processAlive(bad, () => { called = true; }), false);
		assert.equal(called, false, `processAlive must not call kill for out-of-range pid ${String(bad)}`);
	}

	const holders = extractHolderPids({
		holder: { pid: 1 },
		holders: [{ pid: 1 }, { pid: 0 }, { pid: -5 }, { pid: 2 ** 40 }, { pid: 4321 }, { pid: 1234 }, { pid: 4321 }],
	});
	assert.deepEqual(holders, [1234, 4321]);
	const warning = formatOrphanWarning({
		root: "/tmp/bootstrap-hc-abc",
		stopCommand: "env -i HC_SESSION=bootstrap-hc-abc hc server stop --json",
		socketExists: false,
		survivingPids: holders,
	});
	assert.match(warning, /\bkill 1234 4321\b/);
	assert.doesNotMatch(warning, /\bkill 1\b/);
});

test("findings helpers record real hc 0.1.22 status shape, variants, isolation markers, and stopError without verifiedByLiveRun", async () => {
	const {
		recordCoreEnvFindings, recordShimFindings, recordStatusShapeFindings, recordTeardownFindings,
	} = await import("./test-support/hc-live-findings.ts");

	// Copied verbatim from hc 0.1.22 `startResult.stdout` in integration hc-spike-findings.json.
	const realHc0122Stdout = "{\"core\":{\"id\":\"9723cf45749f82e2bcaa31e08b2e83d2\",\"name\":\"cachyos-x8664\"},\"finished\":0,\"holder\":null,\"holders\":[],\"installed_by\":null,\"keeps_running_after_logout\":null,\"live\":0,\"logout_linger_user\":null,\"pid\":454486,\"uptime_ms\":9,\"version\":\"0.1.22\"}\n";
	const realResult = { code: 0, stdout: realHc0122Stdout, stderr: "", timedOut: false };
	const realFindings = recordStatusShapeFindings(realResult);
	assert.deepEqual(realFindings.topLevelKeys, [
		"core", "finished", "holder", "holders", "installed_by",
		"keeps_running_after_logout", "live", "logout_linger_user", "pid", "uptime_ms", "version",
	]);
	assert.deepEqual(realFindings.coreKeys, ["id", "name"]);
	assert.equal(realFindings.expectedKeysPresent, true);
	assert.equal(realFindings.ticket03ProbeMatches, true);

	// Variant: missing version -> expectedKeysPresent=false, ticket03ProbeMatches=false
	const noVersion = JSON.parse(realHc0122Stdout);
	delete noVersion.version;
	const noVersionFindings = recordStatusShapeFindings({ code: 0, stdout: JSON.stringify(noVersion), stderr: "", timedOut: false });
	assert.equal(noVersionFindings.expectedKeysPresent, false);
	assert.equal(noVersionFindings.ticket03ProbeMatches, false);
	assert.equal(noVersionFindings.topLevelKeys.includes("version"), false);

	// Variant: missing core.id -> expectedKeysPresent=false, ticket03ProbeMatches=false
	const noCoreId = JSON.parse(realHc0122Stdout);
	delete noCoreId.core.id;
	const noCoreIdFindings = recordStatusShapeFindings({ code: 0, stdout: JSON.stringify(noCoreId), stderr: "", timedOut: false });
	assert.equal(noCoreIdFindings.expectedKeysPresent, false);
	assert.equal(noCoreIdFindings.ticket03ProbeMatches, false);
	assert.deepEqual(noCoreIdFindings.coreKeys, ["name"]);

	// Variant: extra key -> captured in topLevelKeys, expectedKeysPresent=true
	const extraKey = { ...JSON.parse(realHc0122Stdout), extra_field: "observed" };
	const extraFindings = recordStatusShapeFindings({ code: 0, stdout: JSON.stringify(extraKey), stderr: "", timedOut: false });
	assert.ok(extraFindings.topLevelKeys.includes("extra_field"));
	assert.equal(extraFindings.expectedKeysPresent, true);
	assert.equal(extraFindings.ticket03ProbeMatches, true);

	// Variant: missing expected non-probe key (uptime_ms) -> ticket03ProbeMatches=true, expectedKeysPresent=false
	const missingUptime = JSON.parse(realHc0122Stdout);
	delete missingUptime.uptime_ms;
	const missingUptimeFindings = recordStatusShapeFindings({ code: 0, stdout: JSON.stringify(missingUptime), stderr: "", timedOut: false });
	assert.equal(missingUptimeFindings.expectedKeysPresent, false);
	assert.equal(missingUptimeFindings.ticket03ProbeMatches, true);

	// Shim recording: empty vs non-empty
	assert.deepEqual(recordShimFindings(""), { shimCalls: [], shimCallCount: 0 });
	assert.deepEqual(recordShimFindings("systemd-run\t--user\nloginctl\tshow-user\n"), {
		shimCalls: ["systemd-run\t--user", "loginctl\tshow-user"],
		shimCallCount: 2,
	});

	// Core env recording: HC_RUNTIME=1, absent (null), or "0"
	const baseIdentity = { id: "9723cf45749f82e2bcaa31e08b2e83d2", pid: 454486, socket: "/tmp/s/core.sock", device: 1, inode: 2 };
	assert.equal(recordCoreEnvFindings({
		identity: baseIdentity, cgroup: "0::/app.scope", hasRuntimeMarker: true, coreRuntimeEnv: "1",
	}).observedCoreRuntimeEnv, "1");
	assert.equal(recordCoreEnvFindings({
		identity: baseIdentity, cgroup: "0::/app.scope", hasRuntimeMarker: false, coreRuntimeEnv: null,
	}).observedCoreRuntimeEnv, null);
	assert.equal(recordCoreEnvFindings({
		identity: baseIdentity, cgroup: "0::/app.scope", hasRuntimeMarker: false, coreRuntimeEnv: "0",
	}).observedCoreRuntimeEnv, "0");

	// Teardown recording: stopError preserved, holder/core PID 1 excluded from killCommand
	const td = recordTeardownFindings({
		mode: "verified",
		stop: { code: 1, stdout: "", stderr: "stop err", timedOut: false },
		stopError: "Error: hc server stop failed",
		corePid: 454486,
		holderPids: [999],
		remainingCoreAlive: true,
		remainingHolderPids: [1, 999],
		socketRemaining: false,
		stopped: false,
	});
	assert.equal(td.findings.stopError, "Error: hc server stop failed");
	assert.deepEqual(td.survivingPids, [454486, 999]);
	assert.equal(td.findings.killCommand, "kill 454486 999");

	// Source-scan: verifiedByLiveRun / verified-by-live-run must not appear in live-hc.test.ts or live helpers,
	// --force must never be passed to hc send (including template literals), cli() must call verify(),
	// every until() in live-hc.test.ts must have a finite timeout, and finally must guard readCoreLogTail.
	const bootstrapDir = dirname(fileURLToPath(import.meta.url));
	const extractStringLiterals = (src: string): string[] => {
		const out: string[] = [];
		let i = 0;
		let prevTokenChar = "";
		const canStartRegex = () => prevTokenChar === "" || "(,=:[!&|?{};\n".includes(prevTokenChar);
		const scanRegex = () => {
			i++;
			let inClass = false;
			while (i < src.length) {
				const c = src[i]!;
				if (c === "\\") { i += 2; continue; }
				if (c === "[" && !inClass) { inClass = true; i++; continue; }
				if (c === "]" && inClass) { inClass = false; i++; continue; }
				if (c === "/" && !inClass) {
					i++;
					while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
					prevTokenChar = "/";
					return;
				}
				if (c === "\n") break;
				i++;
			}
		};
		const scanQuoted = (quote: '"' | "'") => {
			let buf = "";
			i++;
			while (i < src.length) {
				const c = src[i]!;
				if (c === "\\") {
					buf += src.slice(i, i + 2);
					i += 2;
					continue;
				}
				if (c === quote) { i++; break; }
				buf += c;
				i++;
			}
			out.push(buf);
			prevTokenChar = quote;
		};
		const scanTemplate = () => {
			let buf = "";
			i++;
			while (i < src.length) {
				const c = src[i]!;
				if (c === "\\") {
					buf += src.slice(i, i + 2);
					i += 2;
					continue;
				}
				if (c === "$" && src[i + 1] === "{") {
					if (buf) out.push(buf);
					buf = "";
					i += 2;
					prevTokenChar = "{";
					scanCode(true);
					continue;
				}
				if (c === "`") { i++; break; }
				buf += c;
				i++;
			}
			if (buf) out.push(buf);
			prevTokenChar = "`";
		};
		const scanCode = (stopOnCloseBrace: boolean) => {
			let braceDepth = 1;
			while (i < src.length) {
				const ch = src[i]!;
				const next = src[i + 1];
				if (ch === "/" && next === "/") {
					i += 2;
					while (i < src.length && src[i] !== "\n") i++;
					continue;
				}
				if (ch === "/" && next === "*") {
					i += 2;
					while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
					i += 2;
					continue;
				}
				if (ch === "/" && canStartRegex()) { scanRegex(); continue; }
				if (ch === '"' || ch === "'") { scanQuoted(ch); continue; }
				if (ch === "`") { scanTemplate(); continue; }
				if (stopOnCloseBrace) {
					if (ch === "{") braceDepth++;
					else if (ch === "}") {
						braceDepth--;
						if (braceDepth === 0) { i++; prevTokenChar = "}"; return; }
					}
				}
				if (!/[ \t\r]/.test(ch)) prevTokenChar = ch;
				i++;
			}
		};
		scanCode(false);
		return out;
	};
	const hasForceFlagLiteral = (src: string) => extractStringLiterals(src).some(lit => /(?:^|[\s"'`])--force(?=$|[\s"'`])/.test(lit));
	assert.equal(hasForceFlagLiteral('const a = "--force";'), true);
	assert.equal(hasForceFlagLiteral("const a = '--force';"), true);
	assert.equal(hasForceFlagLiteral("const a = `--force`;"), true);
	assert.equal(hasForceFlagLiteral("const a = `send --force ${addr}`;"), true);
	assert.equal(hasForceFlagLiteral("const a = `nested ${ok ? `inner` : ''} --force`;"), true);
	assert.equal(hasForceFlagLiteral("const a = `nested ${ok ? `--force` : ''}`;"), true);
	assert.equal(hasForceFlagLiteral("const q = v.replace(/'/g, \"'\\\\''\"); // --force\nconst b = `ok`;"), false);
	assert.equal(hasForceFlagLiteral("const a = `ok`; // never pass --force\nconst b = `still ok`;"), false);

	for (const rel of [
		"live-hc.test.ts",
		"test-support/hc-live-core.ts",
		"test-support/hc-live-env.ts",
		"test-support/hc-live-findings.ts",
		"test-support/hc-live-terminal.ts",
	]) {
		const src = readFileSync(join(bootstrapDir, rel), "utf8");
		assert.doesNotMatch(src, /verifiedByLiveRun|verified-by-live-run/i, `${rel} must not hardcode verifiedByLiveRun`);
		assert.equal(hasForceFlagLiteral(src), false, `${rel} must never pass --force to hc`);
	}
	const hostHcSrc = readFileSync(join(bootstrapDir, "host-hc.ts"), "utf8");
	assert.equal(hasForceFlagLiteral(hostHcSrc), false, "host-hc.ts must never pass --force to hc");

	const liveHcSrc = readFileSync(join(bootstrapDir, "live-hc.test.ts"), "utf8");
	const liveHcCodeOnly = liveHcSrc.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
	assert.doesNotMatch(liveHcCodeOnly, /\bcli\([^)]*["'`]read["'`]/, "live-hc.test.ts must not add hc read commands");
	assert.match(liveHcCodeOnly, /\bevaluateLiveBhRequirements\(/, "live-hc.test.ts must use end-of-run evaluateLiveBhRequirements policy");

	const cliMatch = /const cli = async \([\s\S]*?\n\t\};/.exec(liveHcSrc);
	assert.ok(cliMatch, "live-hc.test.ts must define cli()");
	const cliCodeOnly = cliMatch[0].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
	assert.match(cliCodeOnly, /\bawait\s+verify\(\)/, "cli() must call await verify()");
	const verifyIdx = cliCodeOnly.indexOf("verify()");
	const cmdIdx = cliCodeOnly.indexOf("command(");
	assert.ok(verifyIdx >= 0 && cmdIdx > verifyIdx, "cli() must call await verify() before command()");

	const untilDefMatch = /async function until<T>\([\s\S]*?,\s*ms\s*=\s*([0-9_]+)\):[\s\S]*?\{([\s\S]*?)\n\}/.exec(liveHcSrc);
	assert.ok(untilDefMatch, "live-hc.test.ts must define until() with a numeric default timeout");
	const defaultMs = Number(untilDefMatch[1]!.replace(/_/g, ""));
	assert.ok(Number.isFinite(defaultMs) && defaultMs > 0 && defaultMs <= 60_000, `until() default timeout must be finite and <= 60s, got ${defaultMs}`);
	assert.match(untilDefMatch[2]!, /Number\.isFinite\(ms\)/, "until() must enforce Number.isFinite(ms)");
	assert.match(untilDefMatch[2]!, /Date\.now\(\)\s*<\s*end/, "until() must bound loop with Date.now() < end");

	// Extract every until(...) call site using balanced-paren scanning and verify any 3rd arg is a finite positive number.
	let searchFrom = 0;
	let untilCalls = 0;
	while (true) {
		const idx = liveHcSrc.indexOf("until(", searchFrom);
		if (idx < 0) break;
		const before = idx > 0 ? liveHcSrc[idx - 1]! : " ";
		if (/[A-Za-z0-9_$]/.test(before) || liveHcSrc.slice(Math.max(0, idx - 15), idx).includes("function ")) {
			searchFrom = idx + 6;
			continue;
		}
		let depth = 0;
		let i = idx + "until".length;
		let inQuote: string | undefined;
		const topCommaIndices: number[] = [];
		for (; i < liveHcSrc.length; i++) {
			const ch = liveHcSrc[i]!;
			if (inQuote) {
				if (ch === "\\" && inQuote !== "`") { i++; continue; }
				if (ch === inQuote) inQuote = undefined;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") { inQuote = ch; continue; }
			if (ch === "(" || ch === "{" || ch === "[") depth++;
			else if (ch === ")" || ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) break;
			} else if (ch === "," && depth === 1) {
				topCommaIndices.push(i);
			}
		}
		assert.equal(depth, 0, `unbalanced parens in until() call at offset ${idx}`);
		untilCalls++;
		if (topCommaIndices.length >= 2) {
			const thirdArg = liveHcSrc.slice(topCommaIndices[1]! + 1, i).trim();
			assert.match(thirdArg, /^[0-9][0-9_]*$/, `until() timeout arg must be a finite positive integer literal, got ${thirdArg}`);
			const parsedMs = Number(thirdArg.replace(/_/g, ""));
			assert.ok(Number.isFinite(parsedMs) && parsedMs > 0 && parsedMs <= 60_000, `until() timeout out of bounds: ${parsedMs}`);
		}
		searchFrom = i + 1;
	}
	assert.ok(untilCalls >= 10, `expected >= 10 until() calls in live-hc.test.ts, found ${untilCalls}`);

	const finallyMatch = /\n\t\} finally \{([\s\S]*?)\n\t\}/.exec(liveHcSrc);
	assert.ok(finallyMatch, "live-hc.test.ts must have a finally block");
	assert.match(finallyMatch[1]!, /try\s*\{[\s\S]*?readCoreLogTail\(root\)[\s\S]*?\}\s*catch/, "finally must wrap readCoreLogTail(root) in try/catch before save() and warnOrphan()");
});

test("live hc question selector, OSC 7501 candidate probing/stop condition, and core.log tail reading work deterministically", async t => {
	const {
		HC_LIVE_ONLY, parseLiveHcSelection,
	} = await import("./test-support/hc-live-env.ts");
	const {
		buildOsc7501Candidates, isAnyOscReportAccepted, isOscCandidateAccepted, isOscRecordAccepted, OSC_7501_QUERIES, readCoreLogTail, readFileTailUtf8,
	} = await import("./test-support/hc-live-findings.ts");

	assert.equal(HC_LIVE_ONLY, "PI_BOOTSTRAP_LIVE_HC_ONLY");
	assert.deepEqual([...parseLiveHcSelection(undefined)].sort(), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
	assert.deepEqual([...parseLiveHcSelection("b,h")].sort(), ["b", "h"]);
	assert.deepEqual([...parseLiveHcSelection(" B , h , b ")].sort(), ["b", "h"]);
	for (const bad of ["", "   ", "b,", ",h", "z", "b,unknown"]) {
		assert.throws(() => parseLiveHcSelection(bad), /PI_BOOTSTRAP_LIVE_HC_ONLY|invalid/i, `expected selector ${JSON.stringify(bad)} to throw`);
	}

	// Real failed-status hc get --json shape from run 2 findings (KgYysg).
	const unacceptedGet = {
		address: "t4",
		reported: false,
		state: "live",
		status: null,
		status_ms: null,
		turn: 0,
	};
	assert.equal(isOscCandidateAccepted(unacceptedGet, "working"), false);
	assert.equal(isAnyOscReportAccepted(unacceptedGet), false);

	// Keyed record without root status: reported=true & records non-empty, but root status still null.
	const keyedOnlyGet = {
		address: "t4",
		reported: true,
		state: "live",
		status: null,
		records: { main: { state: "working", msg: "x" } },
	};
	assert.equal(isAnyOscReportAccepted(keyedOnlyGet), true);
	assert.equal(isOscCandidateAccepted(keyedOnlyGet, "working"), false);
	assert.equal(isOscRecordAccepted(keyedOnlyGet, "main", "working"), true);
	assert.equal(isOscRecordAccepted(keyedOnlyGet, "main", "idle"), false);
	assert.equal(isOscRecordAccepted(keyedOnlyGet, "worker1", "working"), false);

	// Root status accepted only when reported=true and status.state matches expected state.
	const rootWorkingGet = {
		address: "t4",
		reported: true,
		state: "live",
		status: { state: "working", app: "spike", msg: "x" },
		records: {},
	};
	assert.equal(isOscCandidateAccepted(rootWorkingGet, "working"), true);
	assert.equal(isOscCandidateAccepted(rootWorkingGet, "idle"), false);
	assert.equal(isAnyOscReportAccepted(rootWorkingGet), true);
	assert.equal(isOscRecordAccepted(rootWorkingGet, "worker1", "working"), false);

	// Capability queries cover bare and suffixed BEL/ST forms.
	const queryWires = OSC_7501_QUERIES.map(q => q.wire);
	assert.ok(queryWires.includes("\x1b]7501;?\x07"));
	assert.ok(queryWires.includes("\x1b]7501;?\x1b\\"));
	assert.ok(queryWires.some(w => w.includes(":states=idle,working,done,blocked,error")));

	// Candidate list starts with mod grammar (no id prefix, state first, colon-separated, ST then BEL)
	// before full keys and legacy/fallback formats.
	const candidates = buildOsc7501Candidates({ state: "working", app: "spike", msg: "plain", title: "Spike" });
	assert.equal(candidates[0]!.wire, "\x1b]7501;state=working\x1b\\");
	assert.equal(candidates[1]!.wire, "\x1b]7501;state=working\x07");
	assert.equal(candidates[2]!.wire, "\x1b]7501;state=working:app=spike\x1b\\");
	assert.equal(candidates[3]!.wire, "\x1b]7501;state=working:app=spike\x07");
	assert.equal(candidates[4]!.wire, "\x1b]7501;state=working:app=spike:msg=plain\x1b\\");
	assert.equal(candidates[5]!.wire, "\x1b]7501;state=working:app=spike:msg=plain\x07");
	assert.equal(
		candidates[0]!.encodeFull({ state: "blocked", app: "spike", kind: "permission", progress: 50, msg: "plain message", title: "Spike" }),
		"\x1b]7501;state=blocked:app=spike:kind=permission:progress=50:msg=plain message:title=Spike\x1b\\",
	);
	assert.equal(
		candidates[0]!.encodeFull({ state: "working", app: "spike", msg: "subtask" }, "worker1"),
		"\x1b]7501;state=working:app=spike:msg=subtask:id=worker1\x1b\\",
	);
	const spacedProbe = buildOsc7501Candidates({ state: "working", app: "spike", msg: "has spaces", title: "Spike" });
	assert.equal(spacedProbe[4]!.body, "state=working:app=spike:msg=has-spaces");

	const bodies = candidates.map(c => c.body);
	assert.ok(bodies.includes("state=working:app=spike:msg=plain:title=Spike"));
	assert.ok(bodies.includes("state=working:app=spike:message=plain:title=Spike"));
	assert.ok(bodies.includes(":state=working:app=spike:msg=plain:title=Spike"));
	assert.ok(bodies.includes(":state=working"));
	assert.ok(bodies.includes("main:state=working:msg=plain"));
	assert.ok(bodies.includes("state=working:msg=plain"));
	assert.ok(bodies.includes("working"));
	assert.ok(bodies.includes("main;working"));
	assert.ok(candidates.some(c => c.terminator === "\x07") && candidates.some(c => c.terminator === "\x1b\\"));

	// Stop condition simulation: stops on first candidate where root status is accepted.
	const tried: string[] = [];
	let matched: string | undefined;
	for (const candidate of candidates) {
		tried.push(candidate.label);
		const simulatedGet = candidate.body === "state=working:app=spike"
			? rootWorkingGet
			: unacceptedGet;
		if (isOscCandidateAccepted(simulatedGet, "working")) {
			matched = candidate.label;
			break;
		}
	}
	assert.ok(matched);
	assert.equal(tried.length, 3, "probing must stop immediately when state=working:app=spike ST is accepted");

	// core.log reader: missing directory, tail limit, 64 KiB cap on huge files, and symlink rejection.
	const root = mkdtempSync(join(tmpdir(), "hc-core-log-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.deepEqual(readCoreLogTail(root), { files: [], tail: [], osc7501Lines: [] });
	const logDir = join(root, "state", "herdr-core");
	mkdirSync(logDir, { recursive: true });
	const logLines = [
		"2026-11-26T22:00:00Z core started",
		"2026-11-26T22:00:01Z invalid OSC 7501 report err=payload is not escape code safe UTF-8",
		"2026-11-26T22:00:02Z OSC 7501 sequence too long len=9999",
		"2026-11-26T22:00:03Z another line",
	];
	writeFileSync(join(logDir, "core.log"), logLines.join("\n") + "\n");
	const logs = readCoreLogTail(root, 2);
	assert.equal(logs.files.length, 1);
	assert.deepEqual(logs.tail, logLines.slice(-2));
	assert.deepEqual(logs.osc7501Lines, [logLines[1], logLines[2]]);

	// Huge file (> 64 KiB): early OSC 7501 line beyond 64 KiB from EOF must NOT be read, while tail lines are read.
	const hugeRoot = mkdtempSync(join(tmpdir(), "hc-core-log-huge-"));
	t.after(() => rmSync(hugeRoot, { recursive: true, force: true }));
	const hugeDir = join(hugeRoot, "state", "herdr-core");
	mkdirSync(hugeDir, { recursive: true });
	const earlySecretLine = "EARLY_TOO_FAR_OSC_7501_SHOULD_NOT_BE_READ";
	const filler = "x".repeat(120) + "\n";
	const fillerCount = Math.ceil((128 * 1024) / filler.length);
	const recent7501 = "2026-11-26T22:59:59Z recent OSC 7501 line";
	const recentEnd = "2026-11-26T23:00:00Z final line";
	writeFileSync(
		join(hugeDir, "core.log"),
		`${earlySecretLine}\n${filler.repeat(fillerCount)}${recent7501}\n${recentEnd}\n`,
	);
	const hugeLogs = readCoreLogTail(hugeRoot, 5);
	assert.equal(hugeLogs.files.length, 1);
	assert.deepEqual(hugeLogs.tail.slice(-2), [recent7501, recentEnd]);
	assert.deepEqual(hugeLogs.osc7501Lines, [recent7501]);
	assert.equal(hugeLogs.osc7501Lines.some(line => line.includes(earlySecretLine)), false);

	// Symlinks (file symlink, subdir symlink, and state-dir symlink) must be ignored.
	const outsideDir = mkdtempSync(join(tmpdir(), "hc-core-log-outside-"));
	t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
	const outsideSecret = join(outsideDir, "secret.log");
	writeFileSync(outsideSecret, "SYMLINKED_7501_LEAK\n");
	const symRoot = mkdtempSync(join(tmpdir(), "hc-core-log-sym-"));
	t.after(() => rmSync(symRoot, { recursive: true, force: true }));
	mkdirSync(join(symRoot, "state", "sub"), { recursive: true });
	symlinkSync(outsideSecret, join(symRoot, "state", "sub", "core.log"));
	assert.equal(readFileTailUtf8(join(symRoot, "state", "sub", "core.log")), undefined, "O_NOFOLLOW must reject direct symlink open");
	mkdirSync(join(outsideDir, "nested"), { recursive: true });
	writeFileSync(join(outsideDir, "nested", "core.log"), "DIR_SYMLINK_7501_LEAK\n");
	symlinkSync(join(outsideDir, "nested"), join(symRoot, "state", "linked-dir"));
	assert.deepEqual(readCoreLogTail(symRoot), { files: [], tail: [], osc7501Lines: [] });

	const symStateRoot = mkdtempSync(join(tmpdir(), "hc-core-log-symstate-"));
	t.after(() => rmSync(symStateRoot, { recursive: true, force: true }));
	symlinkSync(join(outsideDir, "nested"), join(symStateRoot, "state"));
	assert.deepEqual(readCoreLogTail(symStateRoot), { files: [], tail: [], osc7501Lines: [] });

	// Redesigned b/h isolated probe helpers: bounded 200-1000 ms poll, fresh terminal isolation,
	// non-aborting per-probe error/rejection handling, escaping key gating, and end-of-run failure policy.
	const {
		buildRun4EscapingProbes,
		buildRun4MinimalProbes,
		buildRun4RecordByIdProbes,
		buildRun4SingleKeyProbes,
		buildPiProgramStatusProbes,
		evaluateLiveBhRequirements,
		OSC_PROBE_MAX_POLL_MS,
		OSC_PROBE_MIN_POLL_MS,
		pollForOscProbe,
		runBlockedSendSuite,
		runOscProbeSuite,
	} = await import("./test-support/hc-live-findings.ts");

	assert.equal(OSC_PROBE_MIN_POLL_MS, 200);
	assert.equal(OSC_PROBE_MAX_POLL_MS, 1_000);
	await assert.rejects(() => pollForOscProbe({ pollMs: 199, intervalMs: 10, get: async () => ({}), isDone: () => true }), /200.*1000|pollMs/i);
	await assert.rejects(() => pollForOscProbe({ pollMs: 1001, intervalMs: 10, get: async () => ({}), isDone: () => true }), /200.*1000|pollMs/i);
	await assert.rejects(() => pollForOscProbe({ pollMs: Number.POSITIVE_INFINITY, intervalMs: 10, get: async () => ({}), isDone: () => true }), /200.*1000|pollMs/i);

	// Bounded poll sees delayed state update on poll #3.
	{
		let calls = 0;
		const polled = await pollForOscProbe({
			pollMs: 250,
			intervalMs: 10,
			get: async () => {
				calls++;
				return calls >= 3
					? { reported: true, status: { state: "working" } }
					: { reported: false, status: null };
			},
			isDone: term => isOscCandidateAccepted(term, "working"),
		});
		assert.equal(polled.polls, 3);
		assert.equal(isOscCandidateAccepted(polled.after, "working"), true);
	}

	// Probe builders match the run-4 probe matrix.
	const minimalSpecs = buildRun4MinimalProbes();
	assert.deepEqual(minimalSpecs.map(s => s.key), [
		"idle ST", "working ST", "done ST", "blocked ST", "error ST", "working BEL", "blocked BEL",
	]);
	assert.equal(minimalSpecs[0]!.wire, "\x1b]7501;state=idle\x1b\\");
	assert.equal(minimalSpecs[5]!.wire, "\x1b]7501;state=working\x07");

	const singleKeySpecs = buildRun4SingleKeyProbes("\x1b\\");
	assert.deepEqual(singleKeySpecs.map(s => s.key), [
		"app", "msg", "message", "title", "progress", "kind", "id",
	]);
	assert.equal(singleKeySpecs.find(s => s.key === "kind")!.wire, "\x1b]7501;state=blocked:kind=permission\x1b\\");
	assert.equal(singleKeySpecs.find(s => s.key === "id")!.expectedRecordId, "worker1");
	const piStatusSpecs = buildPiProgramStatusProbes("\x1b\\");
	assert.deepEqual(piStatusSpecs.map(s => s.key), ["blocked", "working", "done", "error", "idle", "clear"]);
	assert.equal(piStatusSpecs[0]!.wire, "\x1b]7501;state=blocked:app=pi:msg=TG9nIGluIHRvIHg=\x1b\\");
	assert.equal(piStatusSpecs[1]!.wire, "\x1b]7501;state=working:app=pi:msg=UGkgc2Vzc2lvbg==\x1b\\");
	assert.equal(piStatusSpecs[2]!.wire, "\x1b]7501;state=done:app=pi:msg=UGkgc2Vzc2lvbg==\x1b\\");
	assert.equal(piStatusSpecs[3]!.wire, "\x1b]7501;state=error:app=pi:msg=RmFpbGVkIG9uY2U=\x1b\\");
	assert.equal(piStatusSpecs[4]!.wire, "\x1b]7501;state=idle:app=pi\x1b\\");
	assert.equal(piStatusSpecs[5]!.wire, "\x1b]7501;state=clear\x1b\\");

	const escapingSpecs = buildRun4EscapingProbes("message", "\x1b\\");
	assert.deepEqual(escapingSpecs.map(s => s.key), ["spaces", "colon", "unicode", "percent-encoding"]);
	assert.ok(escapingSpecs.every(s => s.wire.includes(":message=")));

	const idSpecs = buildRun4RecordByIdProbes("\x1b\\");
	assert.deepEqual(idSpecs.map(s => s.key), ["state-first-id", "id-first-state"]);

	// Stateful fake terminal simulator: each fresh terminal starts unreported (status=null),
	// tracks emitted OSC wires, rejects `title=` and `done`, accepts minimal states + `app`/`msg`/`id`,
	// and enforces blocked send refusal without --force.
	const makeFakeProbeOps = (options: { rejectStates?: Set<string>; rejectKeys?: Set<string>; acceptMsgKey?: "msg" | "message" | null } = {}) => {
		let nextId = 1;
		const terminals = new Map<string, {
			address: string;
			name: string;
			reported: boolean;
			status: Record<string, unknown> | null;
			status_ms: number | null;
			turn: number;
			records: Record<string, Record<string, unknown>>;
			stdin: string[];
		}>();
		const closed: string[] = [];
		const sendCalls: Array<{ address: string; args: string[] }> = [];
		const createdNames: string[] = [];

		const parseOsc = (wire: string) => {
			const m = /^\x1b\]7501;([^\x07\x1b]+)(?:\x07|\x1b\\)$/.exec(wire);
			if (!m) return undefined;
			const body = m[1]!;
			if (body.startsWith("?")) return { query: true as const, term: wire.endsWith("\x07") ? "\x07" : "\x1b\\" };
			const fields: Record<string, string> = {};
			for (const part of body.split(":")) {
				const eq = part.indexOf("=");
				if (eq <= 0) return undefined;
				fields[part.slice(0, eq)] = part.slice(eq + 1);
			}
			return { query: false as const, fields };
		};

		return {
			createdNames,
			closed,
			sendCalls,
			ops: {
				createTerminal: async (name: string) => {
					createdNames.push(name);
					const address = `t${nextId++}`;
					terminals.set(address, {
						address,
						name,
						reported: false,
						status: null,
						status_ms: null,
						turn: 0,
						records: {},
						stdin: [],
					});
					return { address, name };
				},
				emitOsc: async (address: string, wire: string) => {
					const tState = terminals.get(address)!;
					const parsed = parseOsc(wire);
					if (!parsed) return "";
					if (parsed.query) {
						return wire === `\x1b]7501;?${parsed.term}`
							? `\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth${parsed.term}`
							: "";
					}
					const f = parsed.fields;
					if (!f.state || options.rejectStates?.has(f.state)) return "";
					for (const k of Object.keys(f)) {
						if (options.rejectKeys?.has(k)) return "";
						if ((k === "msg" || k === "message") && options.acceptMsgKey !== undefined && k !== options.acceptMsgKey) return "";
					}
					if (f.state === "clear") {
						tState.reported = true;
						tState.status = null;
						tState.status_ms = 1000 + nextId;
						return "";
					}
					if (f.id) {
						tState.reported = true;
						tState.records[f.id] = { state: f.state };
						return "";
					}
					tState.reported = true;
					tState.status = { state: f.state, ...(f.app ? { app: f.app } : {}), ...(f.msg ? { msg: f.msg } : {}), ...(f.message ? { msg: f.message } : {}) };
					tState.status_ms = 1000 + nextId;
					return "";
				},
				get: async (address: string) => {
					const tState = terminals.get(address)!;
					return structuredClone({
						address: tState.address,
						name: tState.name,
						state: "live",
						reported: tState.reported,
						status: tState.status,
						status_ms: tState.status_ms,
						turn: tState.turn,
						records: tState.records,
					});
				},
				list: async () => ({
					result: {
						code: 0,
						stdout: JSON.stringify({
							hidden_finished: 0,
							terminals: [...terminals.values()].map(tState => ({
								address: tState.address,
								name: tState.name,
								state: "live",
								...(tState.status?.state ? { status: tState.status.state } : {}),
								turn: tState.turn,
							})),
						}),
						stderr: "",
						timedOut: false,
					},
					terminals: [...terminals.values()].map(tState => ({ address: tState.address, name: tState.name })),
				}),
				send: async (address: string, text: string) => {
					const args = ["send", "--json", address, text];
					sendCalls.push({ address, args });
					const tState = terminals.get(address)!;
					if (tState.status?.state === "blocked") {
						return {
							code: 9,
							stdout: "",
							stderr: JSON.stringify({ error: { kind: "blocked", message: "terminal is blocked" } }),
							timedOut: false,
						};
					}
					tState.stdin.push(text);
					return { code: 0, stdout: JSON.stringify({ started: null, status: tState.status?.state ?? null, turn: 0 }), stderr: "", timedOut: false };
				},
				readStdinSince: async (address: string, offset: number) => Buffer.from(terminals.get(address)!.stdin.slice(offset).join("\r")),
				stdinOffset: async (address: string) => terminals.get(address)!.stdin.length,
				cleanupTerminal: async (address: string) => {
					closed.push(address);
					terminals.delete(address);
				},
			},
		};
	};

	// Case A: `done` rejected and `title`/`message` rejected -> probe suite continues through ALL probes,
	// runs escaping only on accepted `msg`, still runs question (h), and fails only in end-of-run evaluation!
	{
		const sim = makeFakeProbeOps({
			rejectStates: new Set(["done"]),
			rejectKeys: new Set(["title"]),
			acceptMsgKey: "msg",
		});
		const oscRes = await runOscProbeSuite(sim.ops, { pollMs: 220, intervalMs: 10 });
		const piStatuses = (oscRes as any).piProgramStatus;
		const blockedRes = await runBlockedSendSuite(sim.ops, {
			pollMs: 220,
			intervalMs: 10,
			terminator: oscRes.acceptedTerminator ?? "\x1b\\",
			wakeText: id => `[BOOTSTRAP_WAKE handoff=${id}]`,
		});
		// Every probe got its own fresh terminal and was cleaned up.
		assert.ok(sim.createdNames.length >= 15);
		assert.equal(new Set(sim.createdNames).size, sim.createdNames.length, "every probe must use a fresh unique terminal");
		assert.equal(sim.closed.length, sim.createdNames.length, "every probe terminal must be cleaned up");
		assert.equal((oscRes.minimalStates as any)["done ST"].accepted, false);
		assert.equal((oscRes.minimalStates as any)["blocked ST"].accepted, true);
		assert.equal((oscRes.singleKeys as any).title.accepted, false);
		assert.equal((oscRes.singleKeys as any).app.accepted, true);
		assert.equal(oscRes.escapingMsgKey, "msg");
		assert.deepEqual(Object.keys(piStatuses), ["blocked", "working", "done", "error", "idle", "clear"]);
		assert.equal((piStatuses.blocked as any).accepted, true);
		assert.equal((piStatuses.blocked as any).observedFields.app, "pi");
		assert.equal((piStatuses.blocked as any).observedFields.msg, "TG9nIGluIHRvIHg=");
		assert.equal((piStatuses.clear as any).wire.utf8, "\x1b]7501;state=clear\x1b\\");
		assert.equal((piStatuses.clear as any).seedAccepted, true);
		assert.equal((piStatuses.clear as any).accepted, true);
		assert.equal((oscRes.escaping as any).spaces.accepted, true);
		assert.equal((oscRes.recordsById as any)["state-first-id"].accepted, true);
		assert.equal((blockedRes.blocked as any).matchesContract, true);
		assert.equal((blockedRes.piBlocked as any).statusObserved, true);
		assert.equal((blockedRes.piBlocked as any).wire.utf8, "\x1b]7501;state=blocked:app=pi:msg=TG9nIGluIHRvIHg=\x1b\\");
		assert.equal((blockedRes.piBlocked as any).matchesContract, true);
		assert.equal((blockedRes.working as any).delivered, true);
		assert.equal((blockedRes.done as any).statusObserved, false);
		assert.equal((blockedRes.done as any).sendAttempted, true);
		assert.equal(sim.sendCalls.some(c => c.args.includes("--force")), false);

		const evaluated = evaluateLiveBhRequirements({
			selected: new Set(["b", "h"]),
			osc: oscRes,
			blocked: blockedRes,
		});
		assert.equal(evaluated.oscObservations.minimalStates.missing.includes("done"), true);
		assert.equal(evaluated.blockedObservations.blockedRefused.observed, true);
		assert.equal(evaluated.oscObservations.piProgramStatus.blocked.accepted, true);
		assert.equal(evaluated.oscObservations.piProgramStatus.clear.accepted, true);
		assert.equal(evaluated.blockedObservations.piBlockedReport.refused, true);
		assert.ok(evaluated.missing.some(msg => /\bdone\b/.test(msg)), "end-of-run policy must flag missing 'done' state");
	}

	// Case B: No `blocked` status can be produced & neither `msg` nor `message` accepted -> escaping is skipped cleanly,
	// `working`/`done` sends still run, and end-of-run evaluation reports both missing `blocked` and missing `blockedRefused`.
	{
		const sim = makeFakeProbeOps({
			rejectStates: new Set(["blocked"]),
			acceptMsgKey: null,
		});
		const oscRes = await runOscProbeSuite(sim.ops, { pollMs: 210, intervalMs: 10 });
		const piStatuses = (oscRes as any).piProgramStatus;
		const blockedRes = await runBlockedSendSuite(sim.ops, {
			pollMs: 210,
			intervalMs: 10,
			terminator: oscRes.acceptedTerminator ?? "\x1b\\",
			wakeText: id => `[BOOTSTRAP_WAKE handoff=${id}]`,
		});
		assert.equal(oscRes.escapingMsgKey, null);
		assert.equal((piStatuses.blocked as any).accepted, false);
		assert.equal((piStatuses.idle as any).accepted, true);
		assert.equal((piStatuses.clear as any).accepted, true);
		assert.match(String((oscRes.escaping as any).skippedReason), /neither msg= nor message=/i);
		assert.equal((blockedRes.blocked as any).statusObserved, false);
		assert.equal((blockedRes.piBlocked as any).statusObserved, false);
		assert.equal((blockedRes.piBlocked as any).sendAttempted, false);
		assert.equal((blockedRes.blocked as any).sendAttempted, false);
		assert.equal((blockedRes.working as any).statusObserved, true);
		assert.equal((blockedRes.working as any).delivered, true);
		assert.equal((blockedRes.done as any).statusObserved, true);
		const evaluated = evaluateLiveBhRequirements({
			selected: new Set(["b", "h"]),
			osc: oscRes,
			blocked: blockedRes,
		});
		assert.equal(evaluated.blockedObservations.blockedRefused.observed, false);
		assert.equal(evaluated.oscObservations.piProgramStatus.blocked.accepted, false);
		assert.equal(evaluated.blockedObservations.piBlockedReport.statusObserved, false);
		assert.equal(evaluated.blockedObservations.piBlockedReport.refused, false);
		assert.ok(evaluated.missing.some(msg => msg.startsWith("h:") && /blocked/i.test(msg)));
	}

	// Case D: `b` passes completely, but `hc send` delivers to a `blocked` terminal instead of refusing with exit 9 ->
	// `h` must still fail end-of-run evaluation specifically for unrefused blocked send.
	{
		const sim = makeFakeProbeOps();
		sim.ops.send = async (address: string, text: string) => {
			sim.sendCalls.push({ address, args: ["send", "--json", address, text] });
			return { code: 0, stdout: JSON.stringify({ started: null, status: "blocked", turn: 0 }), stderr: "", timedOut: false };
		};
		const oscRes = await runOscProbeSuite(sim.ops, { pollMs: 210, intervalMs: 10 });
		const blockedRes = await runBlockedSendSuite(sim.ops, {
			pollMs: 210,
			intervalMs: 10,
			terminator: oscRes.acceptedTerminator ?? "\x1b\\",
			wakeText: id => `[BOOTSTRAP_WAKE handoff=${id}]`,
		});
		const evaluated = evaluateLiveBhRequirements({
			selected: new Set(["b", "h"]),
			osc: oscRes,
			blocked: blockedRes,
		});
		assert.equal(evaluated.oscObservations.minimalStates.observed, true);
		assert.equal(evaluated.blockedObservations.blockedRefused.observed, false);
		assert.deepEqual(evaluated.missing, [
			"h: blocked send did not refuse with exit 9 / error.kind=blocked and 0 delivered bytes",
		]);
	}

	// Case C: Throwing probe does not stop later probes.
	{
		const sim = makeFakeProbeOps();
		const baseCreate = sim.ops.createTerminal;
		let throwCount = 0;
		sim.ops.createTerminal = async (name: string) => {
			if (name === "osc-min-done-st") {
				throwCount++;
				throw new Error("simulated launch failure");
			}
			return baseCreate(name);
		};
		const oscRes = await runOscProbeSuite(sim.ops, { pollMs: 210, intervalMs: 10 });
		assert.equal(throwCount, 1);
		assert.match(String((oscRes.minimalStates as any)["done ST"].error), /simulated launch failure/);
		assert.equal((oscRes.minimalStates as any)["blocked ST"].accepted, true);
		assert.equal((oscRes.minimalStates as any)["error ST"].accepted, true);
		assert.equal((oscRes.singleKeys as any).app.accepted, true);
	}

	// live-hc.test.ts still skips with 0 hc calls even when PI_BOOTSTRAP_LIVE_HC_ONLY=b,h is set without PI_BOOTSTRAP_LIVE_HC=1.
	const tripwireBin = join(root, "bin");
	mkdirSync(tripwireBin, { recursive: true });
	const tripwireLog = join(root, "tripwire.log");
	writeFileSync(join(tripwireBin, "hc"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(tripwireLog)}\nexit 99\n`, { mode: 0o700 });
	const liveHcFile = join(dirname(fileURLToPath(import.meta.url)), "live-hc.test.ts");
	const skipped = await runSupervised(process.execPath, ["--test", liveHcFile], {
		cwd: root,
		env: { PATH: `${tripwireBin}:${dirname(process.execPath)}:/usr/bin`, HOME: root, PI_BOOTSTRAP_LIVE_HC_ONLY: "b,h" },
		timeoutMs: 12_000,
	});
	assert.equal(skipped.code, 0, skipped.stderr || skipped.stdout);
	assert.match(skipped.stdout, /^ℹ skipped [1-9]/m);
	assert.equal(existsSync(tripwireLog), false);
});

test("real live-hc.test.ts skips at file level without PI_BOOTSTRAP_LIVE_HC and makes zero hc calls", { timeout: 15_000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "hc-skip-tripwire-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tripwireBin = join(root, "bin");
	mkdirSync(tripwireBin, { recursive: true });
	const tripwireLog = join(root, "tripwire.log");
	writeFileSync(join(tripwireBin, "hc"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(tripwireLog)}\nexit 99\n`, { mode: 0o700 });
	const env: NodeJS.ProcessEnv = {
		PATH: `${tripwireBin}:${dirname(process.execPath)}:/usr/bin`,
		HOME: root,
	};
	const liveHcFile = join(dirname(fileURLToPath(import.meta.url)), "live-hc.test.ts");
	const res = await runSupervised(process.execPath, ["--test", liveHcFile], { cwd: root, env, timeoutMs: 12_000 });
	assert.equal(res.timedOut, false);
	assert.equal(res.code, 0, res.stderr || res.stdout);
	assert.match(res.stdout, /^ℹ skipped [1-9]/m);
	assert.match(res.stdout, /UNVERIFIED: live hc tests require PI_BOOTSTRAP_LIVE_HC=1/);
	assert.equal(existsSync(tripwireLog), false, "tripwire hc must never be called when skipped");
});

test("hc live file is skipped without its exact opt-in, including when Herdr is enabled, and fails strict mode when partly gated", { timeout: 15_000 }, async t => {
	const { hcLiveEnabled } = await import("./test-support/hc-live-env.ts");
	assert.equal(hcLiveEnabled({}), false);
	assert.equal(hcLiveEnabled({ PI_BOOTSTRAP_LIVE_HC: "true" }), false);
	assert.equal(hcLiveEnabled({ PI_BOOTSTRAP_LIVE_HC: "1" }), true);
	const dir = mkdtempSync(join(tmpdir(), "hc-gate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "live-hc.test.ts"), 'throw new Error("hc file must not be loaded");');
	writeFileSync(join(dir, "live-herdr.test.ts"), 'import test from "node:test"; test("Herdr fixture", () => {});');
	const env = { PATH: process.env.PATH };
	const neither = await runSuite({ suite: "live", dir, env, timeoutMs: 5000 });
	assert.equal(neither.ran, false);
	assert.match(neither.summary, /PI_BOOTSTRAP_LIVE_HC=1/);
	for (const hc of [undefined, "true"]) {
		const herdr = await runSuite({
			suite: "live", dir, timeoutMs: 5000,
			env: { ...env, PI_BOOTSTRAP_LIVE_HC: hc, PI_BOOTSTRAP_LIVE_HERDR: "1", HERDR_ENV: "1", HERDR_PANE_ID: "fixture" },
		});
		assert.equal(herdr.exitCode, 0, herdr.output);
		assert.deepEqual(herdr.files, ["live-herdr.test.ts"]);

		const herdrStrict = await runSuite({
			suite: "live", dir, timeoutMs: 5000, strict: true,
			env: { ...env, PI_BOOTSTRAP_LIVE_HC: hc, PI_BOOTSTRAP_LIVE_HERDR: "1", HERDR_ENV: "1", HERDR_PANE_ID: "fixture" },
		});
		assert.notEqual(herdrStrict.exitCode, 0, "strict mode must fail when live hc is unverified");
		assert.equal(herdrStrict.ran, false);
		assert.match(herdrStrict.summary, /PI_BOOTSTRAP_LIVE_HC=1/);
		assert.match(herdrStrict.summary, /strict/i);
	}
	const hcOnlyStrict = await runSuite({
		suite: "live", dir, timeoutMs: 5000, strict: true,
		env: { ...env, PI_BOOTSTRAP_LIVE_HC: "1" },
	});
	assert.notEqual(hcOnlyStrict.exitCode, 0, "strict mode must fail when live Herdr is unverified");
	assert.equal(hcOnlyStrict.ran, false);
	assert.match(hcOnlyStrict.summary, /PI_BOOTSTRAP_LIVE_HERDR=1/);
	assert.match(hcOnlyStrict.summary, /strict/i);
});
