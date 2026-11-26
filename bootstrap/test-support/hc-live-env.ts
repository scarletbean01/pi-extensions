import assert from "node:assert/strict";
import { basename, isAbsolute, join } from "node:path";

export const HC_LIVE_GATE = "PI_BOOTSTRAP_LIVE_HC";
export const HC_LIVE_FINDINGS_DIR = "PI_BOOTSTRAP_HC_FINDINGS_DIR";
export const HC_LIVE_FILE = "live-hc.test.ts";

export function hcLiveEnabled(env: NodeJS.ProcessEnv): boolean {
	return env[HC_LIVE_GATE] === "1";
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
	for (const key of ["PATH", "LANG", "LC_ALL"]) {
		if (parent[key] !== undefined) env[key] = parent[key];
	}
	return { ...env, ...isolationSettings(root), SHELL: "/bin/sh", TERM: "xterm-256color" };
}

export function assertHcEnvironment(root: string, env: NodeJS.ProcessEnv): void {
	for (const [key, value] of Object.entries(isolationSettings(root))) {
		assert.equal(env[key], value, `invalid hc isolation setting: ${key}`);
	}
}
