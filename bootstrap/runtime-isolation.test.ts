/** Runtime integration: the installed Pi runs against isolated state and a fake provider; the user's real ~/.pi is never written. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fakeProviderExtensionSource, gate, isolatedPiEnvironment, probeCommand, runSupervised, startFakeProvider } from "./test-harness.ts";

const piReady = await probeCommand("pi", ["--no-extensions", "--version"], process.env);
const noExtras = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline", "--no-session"];

/** Fingerprint of the user's real Pi configuration/trust files (content hash + mtime), or null when absent. */
function realUserState(): Record<string, string | null> {
	const state: Record<string, string | null> = {};
	for (const name of ["settings.json", "auth.json", "trust.json", "models-store.json", "sandbox.json"]) {
		const path = join(homedir(), ".pi", "agent", name);
		state[name] = existsSync(path) ? `${createHash("sha256").update(readFileSync(path)).digest("hex")}@${statSync(path).mtimeMs}` : null;
	}
	return state;
}

async function runPi(t: { after: (fn: () => unknown) => void }, replies: string[]) {
	const iso = isolatedPiEnvironment();
	const provider = await startFakeProvider({ replies });
	t.after(async () => { await provider.close(); iso.cleanup(); });
	const extension = join(iso.root, "fake-provider.ts");
	writeFileSync(extension, fakeProviderExtensionSource(provider.baseUrl));
	const project = join(iso.root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true }); // project-local resources are what trust decisions are about
	writeFileSync(join(project, ".pi", "settings.json"), "{}");
	const before = realUserState();
	const result = await runSupervised("pi", [...noExtras, "-e", extension, "--model", "bootstrap-fake/model", "-p", "Say hello"], { timeoutMs: 45_000, cwd: project, env: iso.env });
	return { iso, provider, result, before, after: realUserState() };
}

test("real Pi completes a deterministic run against the fake provider with all state isolated", { timeout: 60_000 }, async t => {
	if (!gate(t, piReady)) return;
	const { iso, provider, result, before, after } = await runPi(t, ["deterministic fake reply"]);
	assert.equal(result.timedOut, false);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout.trim(), "deterministic fake reply");
	assert.equal(provider.requests().length, 1);
	provider.assertNoUnexpectedCalls();
	// Pi's config, auth and trust live in the temporary agent directory; the real ones are byte- and mtime-identical.
	assert.ok(existsSync(join(iso.agentDir, "auth.json")), "isolated agent dir was used");
	assert.deepEqual(after, before, "the user's real Pi configuration must not change");
	assert.deepEqual(iso.homeLeaks(), [], "nothing was written under the fake HOME either");
});

test("an unexpected provider call is detected and reported, never silently served", { timeout: 60_000 }, async t => {
	if (!gate(t, piReady)) return;
	const { provider, result, before, after } = await runPi(t, []);
	assert.notEqual(result.code, 0, "the refused model call surfaces as a failed run");
	assert.ok(provider.unexpectedCalls().length >= 1);
	assert.throws(() => provider.assertNoUnexpectedCalls(), /unexpected model call/i);
	assert.deepEqual(after, before);
});
