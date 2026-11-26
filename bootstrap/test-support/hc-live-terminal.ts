// A foreground PTY fixture. Its mailbox lets the spike coordinate without
// consuming or transforming any of the bytes that hc types into stdin.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command, localAddress, readCoreStatus, type CoreIdentity } from "./hc-live-core.ts";
import { buildHcEnvironment } from "./hc-live-env.ts";

function captureObservedEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(process.env).sort()) {
		if (
			["HOME", "TMPDIR", "SHELL", "TERM", "PATH", "LANG", "LC_ALL", "INVOCATION_ID", "COLORTERM", "TERM_PROGRAM"].includes(key)
			|| /^(?:HC_|XDG_|HERDR_|DBUS_)/.test(key)
		) {
			const val = process.env[key];
			if (val !== undefined) out[key] = val;
		}
	}
	return out;
}

const [name, mode] = process.argv.slice(2);
const root = process.cwd();
const caller = localAddress(process.env.HC_TERMINAL_ID);
assert.match(name, /^[a-z0-9-]+$/);
const path = (suffix: string) => join(root, `${name}.${suffix}`);
const publish = (suffix: string, value: unknown) => {
	writeFileSync(path(suffix + ".tmp"), JSON.stringify(value));
	renameSync(path(suffix + ".tmp"), path(suffix));
};
const observedEnv = captureObservedEnv();

assert.ok(process.stdin.isTTY, "hc fixture needs a PTY");
writeFileSync(path("input"), "");
writeFileSync(path("flushed"), "");
if (mode !== "boot-late-raw") {
	process.stdin.setRawMode(true);
}
publish("boot", { caller, env: observedEnv });
const deadline = Date.now() + 300_000;
while ((mode === "boot" || mode === "boot-late-raw") && !existsSync(path("release")) && Date.now() < deadline) {
	await delay(20);
}
if (mode === "boot-late-raw") {
	process.stdin.setRawMode(true);
	const drain = (bytes: Buffer) => appendFileSync(path("flushed"), bytes);
	process.stdin.on("data", drain);
	await delay(60);
	process.stdin.off("data", drain);
}
process.stdin.on("data", (bytes: Buffer) => appendFileSync(path("input"), bytes));
publish("ready", { caller, env: observedEnv });

while (Date.now() < deadline) {
	await delay(20);
	if (!existsSync(path("request"))) continue;
	const request = JSON.parse(readFileSync(path("request"), "utf8"));
	unlinkSync(path("request"));
	try {
		if (request.action === "osc") {
			await new Promise<void>((resolve, reject) => process.stdout.write(Buffer.from(request.hex, "hex"),
				error => error ? reject(error) : resolve()));
			publish("response", { emitted: true });
		} else if (request.action === "send") {
			const target = localAddress(request.target);
			assert.equal(typeof request.text, "string");
			const env = { ...buildHcEnvironment(root, process.env), HC_TERMINAL_ID: caller };
			await readCoreStatus(root, env, request.core as CoreIdentity);
			const result = await command(root, env, "hc", ["send", "--json", target, request.text]);
			publish("response", { caller, result });
		} else {
			assert.fail("unknown hc fixture request");
		}
	} catch (error) {
		publish("response", { error: String(error) });
	}
}
process.exit(0);
