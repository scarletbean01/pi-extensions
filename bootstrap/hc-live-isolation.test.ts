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

	// E. M12: 0, negative, NaN, a string, and 1 are refused before any alive probe, environ read, or signal.
	for (const badPid of [0, -1, -42, Number.NaN, "123", 1] as unknown[]) {
		const s = await makeEnv(`bad-pid-${String(badPid)}`);
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
