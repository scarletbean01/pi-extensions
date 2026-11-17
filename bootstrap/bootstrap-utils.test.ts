import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseAgentFile, parseFrontmatter, scanAgents, loadTeamsYaml, generateTaskId, ensureSessionDir, resolveSessionDir, resolveExtensionPaths } from "./bootstrap-utils.ts";

function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "bootstrap-utils-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function write(file: string, content = ""): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

test("agent parsing normalizes CRLF and quoted scalar metadata", (t) => {
	const root = fixture(t);
	const file = write(join(root, "reviewer.md"), [
		"---", 'name: "Reviewer"', "description: 'Review: carefully'",
		'tools: "read, grep"', 'model: "provider/model"', "color: '#abcdef'",
		'extensions: "coms, minimal, "', "---", "", "Review code.", "Use care.", "",
	].join("\r\n"));
	assert.deepEqual(parseAgentFile(file), {
		name: "Reviewer", description: "Review: carefully", tools: "read, grep",
		model: "provider/model", color: "#abcdef", extensions: ["coms", "minimal"],
		systemPrompt: "Review code.\nUse care.", file,
	});
});

test("unnamed personas use the filename and missing or empty tools do not restrict tools", (t) => {
	const root = fixture(t);
	for (const [name, content] of [
		["plain", "Use all tools.\r\nBe helpful."],
		["empty", '---\nname: ""\ntools: ""\n---\nBe helpful.'],
	]) {
		const def = parseAgentFile(write(join(root, `${name}.md`), content));
		assert.equal(def?.name, name);
		assert.equal(def?.tools, "");
		assert.ok(!def?.systemPrompt.includes("\r"));
	}
	assert.equal(parseAgentFile(join(root, "missing.md")), null);
	assert.equal(parseAgentFile(root), null);
	assert.deepEqual(parseFrontmatter("plain\r\nbody"), { fields: {}, body: "plain\nbody" });
	assert.deepEqual(parseFrontmatter("---  \nname: 'End'\n---"), { fields: { name: "End" }, body: "" });
});

test("discovery uses project then global precedence, sorted filenames and case-insensitive names", (t) => {
	const root = fixture(t);
	const cwd = join(root, "project");
	const home = join(root, "home");
	const dirs = [
		[join(cwd, ".pi/agents"), ".pi"],
		[join(home, ".pi/agent/agents"), "~/.pi"],
	];
	// Each name appears in its own directory and every lower-priority one.
	for (let i = 0; i < dirs.length; i++) {
		for (let j = i; j >= 0; j--) {
			write(join(dirs[i][0], `persona-${j}.md`), `---\nname: ${i === j ? "Persona" : "PERSONA"}-${j}\n---\nFrom ${i}`);
		}
	}
	write(join(dirs[0][0], "z-last.md"), "---\nname: SAME\n---\nWrong duplicate");
	const first = write(join(dirs[0][0], "a-first.md"), "---\nname: Same\n---\nFirst duplicate");
	write(join(dirs[0][0], "ignore.txt"), "Ignored");
	mkdirSync(join(dirs[0][0], "directory.md"));
	const agents = scanAgents(cwd, home);
	assert.deepEqual(agents.map(a => a.name), ["Same", "Persona-0", "Persona-1"]);
	assert.equal(agents[0].file, first);
	assert.deepEqual(agents.slice(1).map(a => [a.source, a.systemPrompt]), [
		[".pi", "From 0"], ["~/.pi", "From 1"],
	]);
	assert.deepEqual(scanAgents(join(root, "absent"), join(root, "absent-home")), []);
});

test("team definitions load from the project's .pi/agents/teams.yaml", (t) => {
	const cwd = fixture(t);
	write(join(cwd, ".pi", "agents", "teams.yaml"), "review-team:\n  - reviewer\n  - scout\n");
	assert.deepEqual(loadTeamsYaml(cwd), { "review-team": ["reviewer", "scout"] });
});

test("task IDs stay readable and unique even at the same timestamp", (t) => {
	t.mock.method(Date, "now", () => 1234567890);
	const ids = Array.from({ length: 1000 }, () => generateTaskId("Audit and fix security issues"));
	assert.equal(new Set(ids).size, ids.length);
	const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
	assert.match(ids[0], new RegExp(`^audit-and-fix-security-issues-${uuid}$`));
	assert.match(generateTaskId("!?"), new RegExp(`^task-${uuid}$`));
	assert.match(generateTaskId("A".repeat(100)), new RegExp(`^${"a".repeat(40)}-${uuid}$`));
});

test("session directories are created idempotently and resolved without creating missing sessions", (t) => {
	const cwd = fixture(t);
	const sessionsRoot = join(cwd, ".pi", "agent-sessions");
	assert.deepEqual(resolveSessionDir(cwd, "missing"), {
		error: "session directory not found", available: [], sessionsRoot,
	});
	assert.equal(existsSync(sessionsRoot), false);
	const sessionDir = join(sessionsRoot, "audit-123");
	assert.equal(ensureSessionDir(cwd, "audit-123"), sessionDir);
	assert.equal(ensureSessionDir(cwd, "audit-123"), sessionDir);
	assert.deepEqual(resolveSessionDir(cwd, "audit-123"), { sessionDir });
});

test("both session helpers reject unsafe task IDs before creating any directories", (t) => {
	const cwd = fixture(t);
	for (const id of ["", " ", ".", "..", "../escape", "a/b", "a\\b", "\\escape", "/absolute", "a\0b", "a\nb", "C:escape", " padded "]) {
		assert.throws(() => ensureSessionDir(cwd, id), undefined, JSON.stringify(id));
		assert.deepEqual(resolveSessionDir(cwd, id), {
			error: "session directory not found", available: [], sessionsRoot: join(cwd, ".pi", "agent-sessions"),
		});
	}
	assert.equal(existsSync(join(cwd, ".pi")), false);
});

test("session files and symlinks are rejected and excluded from available task IDs", (t) => {
	const cwd = fixture(t);
	const root = join(cwd, ".pi", "agent-sessions");
	ensureSessionDir(cwd, "z-valid");
	ensureSessionDir(cwd, "a-valid");
	write(join(root, "file"));
	symlinkSync(join(root, "a-valid"), join(root, "link"));
	symlinkSync(join(root, "absent"), join(root, "dangling"));
	for (const id of ["file", "link", "dangling", "missing"]) {
		if (id !== "missing") assert.throws(() => ensureSessionDir(cwd, id));
		assert.deepEqual(resolveSessionDir(cwd, id), {
			error: "session directory not found", available: ["a-valid", "z-valid"], sessionsRoot: root,
		});
	}
});

test("session helpers do not follow symlinked or non-directory session parents", (t) => {
	const root = fixture(t);
	for (const parent of [".pi", ".pi/agent-sessions"]) {
		for (const kind of ["file", "symlink"]) {
			const cwd = join(root, `${parent.replaceAll("/", "-")}-${kind}`);
			const target = join(cwd, parent);
			mkdirSync(dirname(target), { recursive: true });
			const outside = join(root, `outside-${parent.replaceAll("/", "-")}`);
			mkdirSync(outside, { recursive: true });
			if (kind === "file") write(target);
			else symlinkSync(outside, target);
			assert.throws(() => ensureSessionDir(cwd, "unsafe"));
			assert.ok("error" in resolveSessionDir(cwd, "unsafe"));
			assert.equal(existsSync(join(outside, "unsafe")), false);
			assert.equal(existsSync(join(outside, "agent-sessions")), false);
		}
	}
});

test("declared extensions resolve bare, relative, nested, and absolute paths without doubling suffixes", (t) => {
	const cwd = fixture(t);
	const coms = write(join(cwd, "extensions", "coms.ts"));
	const nested = write(join(cwd, "extensions", "nested", "agent.ts"));
	const js = write(join(cwd, "extensions", "custom.js"));
	const absolute = write(join(cwd, "external", "special.ts"));
	assert.deepEqual(resolveExtensionPaths(cwd, [
		"coms", "coms.ts", " ./coms.ts ", "extensions/coms", "./extensions/coms.ts",
		"nested/agent", "nested/agent.ts", "custom.js", absolute, absolute.slice(0, -3),
	]), [coms, coms, coms, coms, coms, nested, nested, js, absolute, absolute]);
	assert.deepEqual(resolveExtensionPaths(cwd, []), []);
});

test("missing declared extensions fail instead of silently returning a partial list", (t) => {
	const cwd = fixture(t);
	write(join(cwd, "extensions", "present.ts"));
	assert.throws(() => resolveExtensionPaths(cwd, ["present", "missing"]), /extension not found.*missing/i);
	assert.throws(() => resolveExtensionPaths(cwd, [join(cwd, "absent.ts")]), /extension not found.*absent/i);
	mkdirSync(join(cwd, "extensions", "directory.ts"));
	assert.throws(() => resolveExtensionPaths(cwd, ["directory.ts"]), /extension not found/i);
	assert.throws(() => resolveExtensionPaths(cwd, [" "]), /extension/i);
});

test("relative extensions missing from the project fall back to the persona's extension directories", (t) => {
	const cwd = fixture(t);
	const globalDir = join(cwd, "global-extensions");
	const helper = write(join(globalDir, "helper.ts"));
	const local = write(join(cwd, "extensions", "shared.ts"));
	write(join(globalDir, "shared.ts"));
	assert.deepEqual(resolveExtensionPaths(cwd, ["helper", "extensions/helper.ts", "shared"], [globalDir]), [helper, helper, local]);
	assert.throws(() => resolveExtensionPaths(cwd, ["nowhere"], [globalDir]), /extension not found.*nowhere/i);
});
