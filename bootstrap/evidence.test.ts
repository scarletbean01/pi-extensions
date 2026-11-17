import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requiredChecksOf, upstreamRequiredChecks, verifyEvidence } from "./evidence.ts";
import { beginVerificationCheck, finishVerificationCheck } from "./verification.ts";

const identity = { run_id: "run-1", node_id: "impl", persona_name: "builder", attempt_id: "a1-impl.1", instance_id: "a1-impl" };

function workspace(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-evidence-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	const session = join(root, "session");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(session, { recursive: true });
	writeFileSync(join(project, "src", "a.txt"), "one");
	/** Run a check to completion over the project, optionally editing it while the check "runs". */
	const check = (id: string, result: "pass" | "fail" | "error", options: { scope?: string[]; during?: () => void } = {}) => {
		const started = beginVerificationCheck(project, id, options.scope);
		options.during?.();
		return finishVerificationCheck(session, identity, started, { result });
	};
	const status = (checks: string[]) => Object.fromEntries(verifyEvidence(session, "a1-impl", project, checks, "run-1").map(item => [item.check, item.status]));
	return { project, session, check, status };
}

test("evidence for a required check is missing, failed, unverified, stale or passing, and only the latest record decides", t => {
	const f = workspace(t);
	assert.deepEqual(f.status(["tests"]), { tests: "missing" }, "no evidence file at all");
	f.check("tests", "pass");
	f.check("lint", "fail");
	f.check("types", "pass", { during: () => writeFileSync(join(f.project, "src", "during.txt"), "edited while the check ran") });
	f.check("docs", "pass", { scope: ["src/a.txt"] });
	// "tests" passed on the whole project, which the later "types" run then edited: that is a relevant change after the check, so it is stale.
	assert.deepEqual(f.status(["tests", "lint", "types", "docs", "perf"]), { tests: "stale", lint: "failed", types: "unverified", docs: "passing", perf: "missing" });
	// A change outside a declared scope does not make scoped evidence stale; one inside it does.
	writeFileSync(join(f.project, "src", "b.txt"), "new untracked file");
	assert.deepEqual(f.status(["docs"]), { docs: "passing" });
	writeFileSync(join(f.project, "src", "a.txt"), "two");
	assert.deepEqual(f.status(["docs"]), { docs: "stale" });
	// A fresh run after the edit replaces the stale evidence as the latest; the history stays.
	f.check("docs", "pass", { scope: ["src/a.txt"] });
	assert.deepEqual(f.status(["docs"]), { docs: "passing" });
	f.check("docs", "fail", { scope: ["src/a.txt"] });
	assert.deepEqual(f.status(["docs"]), { docs: "failed" });
});

test("a check whose scope or state cannot be established is unverified, and so is an unreadable or foreign evidence file", t => {
	const f = workspace(t);
	f.check("tests", "pass", { scope: [] });
	assert.deepEqual(f.status(["tests"]), { tests: "unverified" }, "an empty declared scope proves nothing");
	f.check("outside", "pass", { scope: ["../elsewhere"] });
	assert.deepEqual(f.status(["outside"]), { outside: "unverified" });
	writeFileSync(join(f.session, "a1-impl.verification.json"), "{torn");
	assert.deepEqual(f.status(["tests", "outside"]), { tests: "unverified", outside: "unverified" });
	writeFileSync(join(f.session, "a1-impl.verification.json"), JSON.stringify({ version: 9, records: [] }));
	assert.match(verifyEvidence(f.session, "a1-impl", f.project, ["tests"], "run-1")[0].reason!, /Unsupported verification file version 9/);
});

test("the checks a node must pass are its own and its output contract's, and a dependent finds them in its upstream contracts", () => {
	assert.deepEqual(requiredChecksOf({ required_checks: ["a", "b"], output_contract: { required_checks: ["b", "c"] } }), ["a", "b", "c"]);
	assert.deepEqual(requiredChecksOf({}), []);
	assert.deepEqual(upstreamRequiredChecks({ predecessor: "a1-impl", upstream_contracts: { "a1-impl": { required_checks: ["tests"], output_contract: { required_checks: ["lint"] } }, other: { required_checks: ["x"] } } }), ["tests", "lint"]);
	assert.deepEqual(upstreamRequiredChecks({ predecessor: "a1-impl" }), []);
	assert.deepEqual(upstreamRequiredChecks({}), []);
});
