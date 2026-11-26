import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const HC_LIVE_GATE = "PI_BOOTSTRAP_LIVE_HC";
export const HC_LIVE_FINDINGS_DIR = "PI_BOOTSTRAP_HC_FINDINGS_DIR";
export const HC_LIVE_FILE = "live-hc.test.ts";

export const HC_SYSTEMD_SHIMS = ["systemd-run", "systemctl", "loginctl", "busctl", "sudo", "pkexec"] as const;
const HC_ALLOWED_PATH_TOOLS = ["hc", "herdr-core", "sh", "script", "node"] as const;
const HC_CHILD_ALLOWED_ENV_KEYS = new Set(["HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID"]);
const HC_DAEMON_ALLOWED_ENV_KEYS = new Set(["HC_SESSION", "HC_SOCKET"]);
const XDG_ALLOWED_ENV_KEYS = new Set([
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
]);

export function hcLiveEnabled(env: NodeJS.ProcessEnv): boolean {
	return env[HC_LIVE_GATE] === "1";
}

export function hcShimDir(root: string): string {
	assert.ok(isAbsolute(root) && basename(root) !== "", "hc isolation requires an absolute scratch root");
	return join(root, "bin");
}

export function hcShimLogPath(root: string): string {
	assert.ok(isAbsolute(root) && basename(root) !== "", "hc isolation requires an absolute scratch root");
	return join(root, "shim-calls.log");
}

function shQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Install failing shims first on PATH so `hc server start` never touches the
 * operator's systemd user manager, logind, or system D-Bus and falls back to a
 * direct child daemon.
 */
export function installHcShims(root: string): { shimDir: string; logPath: string; shims: string[] } {
	const shimDir = hcShimDir(root);
	const logPath = hcShimLogPath(root);
	mkdirSync(shimDir, { recursive: true, mode: 0o700 });
	writeFileSync(logPath, "", { flag: "a", mode: 0o600 });
	const shims: string[] = [];
	const script = `#!/bin/sh
{
	printf '%s' "$0"
	for arg in "$@"; do
		printf '\\t%s' "$arg"
	done
	printf '\\n'
} >> ${shQuote(logPath)}
exit 1
`;
	for (const name of HC_SYSTEMD_SHIMS) {
		const target = join(shimDir, name);
		writeFileSync(target, script, { mode: 0o700 });
		shims.push(target);
	}
	return { shimDir, logPath, shims };
}

function hasNeededTool(dir: string): boolean {
	for (const tool of HC_ALLOWED_PATH_TOOLS) {
		try {
			accessSync(join(dir, tool), constants.X_OK);
			return true;
		} catch {
			// continue
		}
	}
	return false;
}

function filterHcPath(shimDir: string, parentPath: string | undefined): string {
	const dirs = [shimDir];
	const seen = new Set<string>([shimDir]);
	for (const entry of (parentPath ?? "").split(":")) {
		if (!entry || seen.has(entry)) continue;
		if (!hasNeededTool(entry)) continue;
		seen.add(entry);
		dirs.push(entry);
	}
	return dirs.join(":");
}

function isolationSettings(root: string) {
	assert.ok(isAbsolute(root) && basename(root) !== "", "hc isolation requires an absolute scratch root");
	return {
		HOME: join(root, "home"),
		TMPDIR: join(root, "tmp"),
		HC_SESSION: basename(root),
		HC_SOCKET: join(root, "runtime", "core.sock"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "runtime"),
	};
}

export function buildHcEnvironment(root: string, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["LANG", "LC_ALL"]) {
		if (parent[key] !== undefined) env[key] = parent[key];
	}
	const shimDir = hcShimDir(root);
	return {
		...env,
		...isolationSettings(root),
		PATH: filterHcPath(shimDir, parent.PATH),
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
	};
}

export interface HcEnvironmentOptions {
	/** Only for inspecting the daemon's own `/proc/<pid>/environ`, where `hc serve` sets `HC_RUNTIME=1`. */
	allowDaemonMarkers?: boolean;
}

export function assertHcEnvironment(root: string, env: NodeJS.ProcessEnv, options: HcEnvironmentOptions = {}): void {
	for (const [key, value] of Object.entries(isolationSettings(root))) {
		assert.equal(env[key], value, `invalid hc isolation setting: ${key}`);
	}
	const shimDir = hcShimDir(root);
	const path = env.PATH ?? "";
	assert.ok(path === shimDir || path.startsWith(shimDir + ":"), "invalid hc isolation setting: PATH must start with shim dir");
	const allowedHcKeys = options.allowDaemonMarkers ? HC_DAEMON_ALLOWED_ENV_KEYS : HC_CHILD_ALLOWED_ENV_KEYS;
	for (const key of Object.keys(env)) {
		if (key === "INVOCATION_ID" || key.startsWith("DBUS_") || key.startsWith("HERDR_")) {
			assert.fail(`invalid hc isolation setting: leaked ${key}`);
		}
		if (key === "HC_RUNTIME") {
			if (!options.allowDaemonMarkers || env[key] !== "1") {
				assert.fail(`invalid hc isolation setting: unexpected ${key}`);
			}
			continue;
		}
		if (key.startsWith("HC_") && !allowedHcKeys.has(key)) {
			assert.fail(`invalid hc isolation setting: unexpected ${key}`);
		}
		if (key.startsWith("XDG_") && !XDG_ALLOWED_ENV_KEYS.has(key)) {
			assert.fail(`invalid hc isolation setting: unexpected ${key}`);
		}
	}
}
