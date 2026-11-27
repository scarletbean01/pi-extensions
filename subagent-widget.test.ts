/**
 * Run with: timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts
 * These tests cross the extension entry point; Pi packages are stubbed, while the extension and fake executable are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFakeHost, createFakePi, getOption, loadSubagentWidget, waitFor, withFakePiEnvironment } from "./subagent-widget.test-helpers.ts";

const textEvent = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const toolEvent = { type: "tool_execution_start", toolName: "read" };
const assistantMessageEnd = (text: string, usage?: { input?: number; cacheRead?: number; output?: number; cost?: { total?: number } }) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		...(usage ? { usage } : {}),
	},
});

test("/sub launches the fake pi and delivers final assistant message after normal exit", async t => {
	const fake = createFakePi({ events: [textEvent("first "), toolEvent, textEvent("answer"), assistantMessageEnd("first answer")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	assert.equal(host.ctx.cwd, fake.cwd);
	await host.emit("session_start", { reason: "test" });
	await assert.doesNotReject(host.emit("session_shutdown", { reason: "test" }));
	host.setActiveTools(["probe-tool"]);
	assert.deepEqual(host.getActiveTools(), ["probe-tool"]);
	assert.equal(host.activeToolCalls.length, 2);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("summarize the fixture", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "normal result message");
	const invocation = await waitFor(() => fake.invocations()[0], "fake pi invocation");
	assert.equal(invocation.cwd, fake.cwd);
	assert.equal(invocation.argv.includes("--no-skills"), true);
	assert.equal(invocation.argv.includes("--no-mcp"), true);
	assert.equal(invocation.argv.includes("--no-prompt-templates"), true);
	assert.equal(invocation.argv.includes("--no-themes"), true);
	assert.equal(invocation.argv.includes("--no-context-files"), false, "project AGENTS.md and CLAUDE.md files remain available");
	assert.match(getOption(invocation.argv, "--extension") ?? "", /subagent-widget-child-/);
	assert.equal(existsSync(dirname(getOption(invocation.argv, "--extension")!)), false, "the private child extension directory is removed after exit");
	assert.match(invocation.childExtension ?? "", /<docs>/);
	assert.match(invocation.childExtension ?? "", /before_agent_start/);
	assert.equal(invocation.docsFilteredPrompt, "base instructions\n\nother context");
	assert.equal(invocation.argv.includes("--offline"), true);
	assert.equal(getOption(invocation.argv, "--tools"), "read,grep,find,ls");
	assert.ok(invocation.argv.indexOf("--") >= 0);
	assert.equal(invocation.argv.indexOf("--"), invocation.argv.length - 2);
	assert.equal(invocation.env.SUBAGENT_TEST_MARKER, "preserved-env-value");
	assert.equal(invocation.env.HOME, fake.home);
	assert.equal(invocation.env.HTTP_PROXY, "http://proxy-http.example:8080");
	assert.equal(invocation.env.HTTPS_PROXY, "http://proxy.example:8080");
	assert.equal(invocation.env.NO_PROXY, "localhost,.example.test");
	assert.equal(invocation.env.NODE_EXTRA_CA_CERTS, "/fixture/ca.pem");
	assert.equal(invocation.env.SSL_CERT_FILE, "/fixture/ssl-cert.pem");
	assert.equal(invocation.env.COPILOT_GITHUB_TOKEN, "fixture-copilot-token");
	assert.equal(invocation.env.CUSTOM_PROVIDER_KEY, "fixture-custom-provider-key");
	assert.equal(invocation.env.PI_CACHE_RETENTION, "long");
	assert.equal(invocation.env.LANG, "en_US.UTF-8");
	assert.equal(invocation.env.AI_AGENT, "pi");
	assert.equal(invocation.env.PI_CODING_AGENT, "true");
	for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "SUBAGENT_PI_BINARY"]) {
		assert.equal(invocation.env[name], undefined, `${name} must not enter the child environment`);
	}
	assert.equal(invocation.argv.at(-1), "summarize the fixture");
	const sessionFile = getOption(invocation.argv, "--session");
	assert.equal(sessionFile?.startsWith(`${fake.sessionsDir}/`), true, "the session path stays under the temporary session directory");
	assert.equal(sessionFile?.slice(0, sessionFile.lastIndexOf("/")), fake.sessionsDir);
	assert.ok(existsSync(fake.sessionsDir), "the session directory is redirected under the temporary HOME");
	assert.ok(host.thinkingLevelCalls > 0, "the fake API records thinking-level reads");
	const widgetFactory = host.getWidgetFactory("sub-1");
	assert.equal(typeof widgetFactory, "function", "the fake UI exposes the registered widget factory");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	const renderedLines = widget.render(80);
	assert.ok(Array.isArray(renderedLines), "the widget factory returns rendered lines at the requested width");
	assert.ok(renderedLines.some(line => line.includes("Subagent #1") || line.includes("summarize the fixture")));
	assert.equal(sent.message.customType, "subagent-result");
	assert.match(sent.message.content, /Result:\nfirst answer/);
	assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
});

test("subagent_create launches the fake pi, returns terminate: true, and includes stderr on non-zero exit", async t => {
	const fake = createFakePi({
		events: [textEvent("partial result"), assistantMessageEnd("partial result")],
		stderr: "fake failure detail\n",
		exitCode: 7,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	assert.match(create.parameters.properties.skills.items.description, /launch only/);
	assert.match(create.parameters.properties.writeAccess.description, /launch only/);
	const launch = await withFakePiEnvironment(fake, () => create.execute("call-1", { task: "inspect failing task", thinking: "high" }, undefined, undefined, host.ctx));
	assert.match(launch.content[0].text, /Subagent #1 spawned/);
	assert.equal(launch.terminate, true);
	const sent = await waitFor(() => host.sentMessages[0], "error result message");
	const invocation = (await waitFor(() => fake.invocations()[0], "fake pi invocation"));
	assert.equal(invocation.argv.at(-1), "inspect failing task");
	assert.equal(sent.message.customType, "subagent-result");
	assert.match(sent.message.content, /partial result/);
	assert.match(sent.message.content, /fake failure detail/);
	assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
});

test("subagent_create reports a synchronous spawn failure and removes its temp directory", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const createWidget = await loadSubagentWidget();
	let childDocsDirectory = "";
	const extension = (pi: any) => createWidget(pi, {
		createChildDocsDirectory: () => {
			childDocsDirectory = mkdtempSync(join(fake.root, "spawn-failure-"));
			return childDocsDirectory;
		},
	});
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const result = await withFakePiEnvironment(fake, () => create.execute("nul-task", {
		task: "invalid\u0000task", thinking: "low",
	}, undefined, undefined, host.ctx));
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Could not launch subagent.*(?:ERR_INVALID_ARG_VALUE|null bytes)/);
	assert.equal(existsSync(childDocsDirectory), false, "spawn failure removes the private child-docs directory");
	const widgetFactory = host.getWidgetFactory("sub-1");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	assert.ok(widget.render(80).some((line: string) => line.includes("✗")));
	assert.deepEqual(fake.invocations(), []);
});

test("a failed NUL continuation leaves the subagent recoverable", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("initial task", host.ctx));
	await waitFor(() => host.sentMessages[0], "initial subagent completion");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 invalid\u0000prompt", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && /Could not launch subagent.*(?:ERR_INVALID_ARG_VALUE|null bytes)/.test(item.message)));
	const widgetFactory = host.getWidgetFactory("sub-1");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	assert.ok(widget.render(80).some((line: string) => line.includes("✗")));
	assert.equal(fake.invocations().length, 1, "the invalid continuation never starts a child");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 valid follow-up", host.ctx));
	await waitFor(() => host.sentMessages[1], "valid continuation after spawn failure");
	assert.equal(fake.invocations().length, 2);
});

test("launches keep prompts literal and add only requested skills and write tools", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const subCommand = host.commands.get("sub");
	assert.match(subCommand.description, /--skills/);
	assert.match(subCommand.description, /--write/);
	assert.match(subCommand.description, /\[--\]/);
	assert.match(subCommand.description, /only to this launch/);
	assert.match(host.commands.get("subcont").description, /--skills/);
	assert.match(host.commands.get("subcont").description, /--write/);
	assert.match(host.commands.get("subcont").description, /only to this turn/);
	const create = host.tools.get("subagent_create");
	for (const name of ["alpha", "beta", "gamma"]) host.addPiCommand({
		name: `skill:${name}`, source: "skill", sourceInfo: { path: `/fixture/skills/${name}/SKILL.md` },
	});
	assert.ok(create.parameters.properties.skills);
	assert.ok(create.parameters.properties.writeAccess);
	await withFakePiEnvironment(fake, () => subCommand.handler("--skills alpha,beta --write -literal prompt", host.ctx));
	await withFakePiEnvironment(fake, () => create.execute("call-1", {
		task: "@literal-prompt", thinking: "low", skills: ["gamma"], writeAccess: false,
	}, undefined, undefined, host.ctx));
	await waitFor(() => fake.invocations().length >= 2 ? true : undefined, "both launches");
	const first = fake.invocations().find(invocation => invocation.argv.at(-1) === "-literal prompt")!;
	const second = fake.invocations().find(invocation => invocation.stdin === "@literal-prompt")!;
	assert.equal(first.argv.filter(arg => arg === "--skill").length, 2);
	assert.deepEqual(first.argv.filter(arg => arg.startsWith("/fixture/skills/")), ["/fixture/skills/alpha/SKILL.md", "/fixture/skills/beta/SKILL.md"]);
	assert.equal(getOption(first.argv, "--tools"), "read,grep,find,ls,bash,edit,write");
	assert.equal(first.argv.at(-1), "-literal prompt");
	assert.ok(first.argv.includes("--"));
	assert.equal(second.argv.filter(arg => arg === "--skill").length, 1);
	assert.ok(second.argv.includes("/fixture/skills/gamma/SKILL.md"));
	assert.equal(getOption(second.argv, "--tools"), "read,grep,find,ls");
	assert.equal(second.stdin, "@literal-prompt");
	assert.equal(second.argv.at(-1), "--");
	assert.ok(second.argv.includes("--"));
	await withFakePiEnvironment(fake, () => subCommand.handler("-- --literal prompt", host.ctx));
	const doubleDash = await waitFor(() => fake.invocations().find(invocation => invocation.argv.at(-1) === "--literal prompt"), "double-dash prompt launch");
	assert.equal(doubleDash.stdin, "");
});

test("unknown skills return errors before tool or command launches", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const result = await withFakePiEnvironment(fake, () => create.execute("unknown-skill", {
		task: "inspect something", thinking: "low", skills: ["missing-skill"],
	}, undefined, undefined, host.ctx));
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown skill.*missing-skill/);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("--skills missing-skill inspect something", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && item.message.includes("Unknown skill") && item.message.includes("missing-skill")));
	assert.deepEqual(fake.invocations(), []);
	assert.equal(host.widgets.size, 0);
});

test("tool skill paths are absolute and missing paths are rejected before launch", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const skillDirectory = join(fake.cwd, "local-skills", "path-skill");
	mkdirSync(skillDirectory, { recursive: true });
	writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: path-skill\ndescription: fixture\n---\n");
	await withFakePiEnvironment(fake, () => create.execute("path-skill", {
		task: "inspect path skill", thinking: "low", skills: ["local-skills/path-skill"],
	}, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[0], "path skill launch completion");
	const invocation = await waitFor(() => fake.invocations()[0], "path skill invocation");
	assert.ok(invocation.argv.includes(skillDirectory));
	const result = await withFakePiEnvironment(fake, () => create.execute("missing-path", {
		task: "inspect missing skill", thinking: "low", skills: ["missing-skill-path"],
	}, undefined, undefined, host.ctx));
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Unknown skill.*missing-skill-path/);
	assert.equal(fake.invocations().length, 1);
});

test("tool rejects empty and whitespace-only skill names", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	for (const skill of ["", "   "]) {
		const result = await withFakePiEnvironment(fake, () => create.execute(`empty-${skill.length}`, {
			task: "inspect empty skill", thinking: "low", skills: [skill],
		}, undefined, undefined, host.ctx));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Skill name or path must not be empty/);
	}
	assert.deepEqual(fake.invocations(), []);
});

test("/sub rejects values attached to the --write flag", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("--write=anything inspect something", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && item.message.includes("--write does not take a value")));
	assert.deepEqual(fake.invocations(), []);
});

test("child-extension temp failures mark create and continuation launches as errors", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const createWidget = await loadSubagentWidget();
	let failSetup = true;
	const childDocsDirectories: string[] = [];
	const extension = (pi: any) => createWidget(pi, {
		createChildDocsDirectory: () => {
			const directory = mkdtempSync(join(fake.root, "blocked-child-docs-"));
			childDocsDirectories.push(directory);
			if (failSetup) mkdirSync(join(directory, "strip-pi-docs.mjs"));
			return directory;
		},
	});
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	const result = await withFakePiEnvironment(fake, () => create.execute("temp-failure", {
		task: "inspect something", thinking: "low",
	}, undefined, undefined, host.ctx));
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Could not prepare subagent launch.*EISDIR/);
	const widgetFactory = host.getWidgetFactory("sub-1");
	assert.equal(typeof widgetFactory, "function");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	assert.ok(widget.render(80).some((line: string) => line.includes("✗")));
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("command failure", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && item.message.includes("Could not prepare subagent launch") && item.message.includes("EISDIR")));
	failSetup = false;
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("finished subagent", host.ctx));
	await waitFor(() => host.sentMessages[0], "subagent for continuation setup failure");
	failSetup = true;
	const continuationResult = await withFakePiEnvironment(fake, () => continuation.execute("continue-failure", {
		id: 3, prompt: "tool continuation failure",
	}, undefined, undefined, host.ctx));
	assert.equal(continuationResult.isError, true);
	assert.match(continuationResult.content[0].text, /Could not prepare subagent launch.*EISDIR/);
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("3 command continuation failure", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && item.message.includes("Could not prepare subagent launch") && item.message.includes("EISDIR")));
	assert.deepEqual(fake.invocations().length, 1, "only the valid initial subagent was spawned");
	const continuationWidget = host.getWidgetFactory("sub-3")({}, { fg: (_color: string, text: string) => text });
	assert.ok(continuationWidget.render(80).some((line: string) => line.includes("✗")));
	assert.ok(childDocsDirectories.every(directory => !existsSync(directory)), "all temporary child-docs directories are removed");
});

test("/subcont starts another turn with the original session file", async t => {
	const fake = createFakePi({ events: [textEvent("turn result"), assistantMessageEnd("turn result")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("--model vendor/first --thinking high initial task", host.ctx));
	await waitFor(() => host.sentMessages[0], "first turn completion");
	const first = await waitFor(() => fake.invocations()[0], "first invocation");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 follow-up task", host.ctx));
	await waitFor(() => host.sentMessages[1], "continued turn completion");
	const second = await waitFor(() => fake.invocations()[1], "second invocation");
	assert.equal(first.argv.at(-1), "initial task");
	assert.equal(second.argv.at(-1), "follow-up task");
	assert.equal(getOption(second.argv, "--session"), getOption(first.argv, "--session"));
	assert.equal(getOption(second.argv, "--model"), "vendor/first");
	assert.equal(getOption(second.argv, "--thinking"), "high");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 --model vendor/second --thinking xhigh override task", host.ctx));
	await waitFor(() => host.sentMessages[2], "overridden continuation completion");
	const third = await waitFor(() => fake.invocations()[2], "overridden continuation invocation");
	assert.equal(getOption(third.argv, "--model"), "vendor/second");
	assert.equal(getOption(third.argv, "--thinking"), "xhigh");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 stored override task", host.ctx));
	await waitFor(() => host.sentMessages[3], "stored continuation completion");
	const fourth = await waitFor(() => fake.invocations()[3], "stored continuation invocation");
	assert.equal(getOption(fourth.argv, "--model"), "vendor/second");
	assert.equal(getOption(fourth.argv, "--thinking"), "xhigh");
	assert.match(host.sentMessages[1].message.content, /\(Turn 2\)/);
});

test("subagent_continue reuses its stored model and thinking level without overrides", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	host.addPiCommand({ name: "skill:follow-up", source: "skill", sourceInfo: { path: "/fixture/skills/follow-up/SKILL.md" } });
	assert.equal(continuation.parameters.properties.thinking.optional, true);
	assert.match(continuation.parameters.properties.model.description, /stored model/);
	assert.doesNotMatch(continuation.parameters.properties.model.description, /parent caller/);
	assert.match(continuation.parameters.properties.skills.items.description, /turn only/);
	assert.match(continuation.parameters.properties.writeAccess.description, /turn only/);
	assert.ok(continuation.parameters.properties.skills);
	assert.ok(continuation.parameters.properties.writeAccess);
	await withFakePiEnvironment(fake, () => create.execute("create", {
		task: "first task", model: "vendor/stored", thinking: "high",
	}, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[0], "created subagent completion");
	await withFakePiEnvironment(fake, () => continuation.execute("continue", {
		id: 1, prompt: "continued task", skills: ["follow-up"], writeAccess: true,
	}, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[1], "continued subagent completion");
	const first = await waitFor(() => fake.invocations()[0], "created invocation");
	const second = await waitFor(() => fake.invocations()[1], "continued invocation");
	assert.equal(getOption(second.argv, "--model"), "vendor/stored");
	assert.equal(getOption(second.argv, "--thinking"), "high");
	assert.equal(getOption(second.argv, "--tools"), "read,grep,find,ls,bash,edit,write");
	assert.ok(second.argv.includes("/fixture/skills/follow-up/SKILL.md"));
	assert.equal(getOption(second.argv, "--session"), getOption(first.argv, "--session"));
	await withFakePiEnvironment(fake, () => continuation.execute("override", {
		id: 1, prompt: "override task", model: "vendor/override", thinking: "xhigh",
	}, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[2], "overridden tool continuation completion");
	const third = await waitFor(() => fake.invocations().find(invocation => invocation.argv.at(-1) === "override task"), "overridden tool continuation invocation");
	assert.equal(getOption(third.argv, "--model"), "vendor/override");
	assert.equal(getOption(third.argv, "--thinking"), "xhigh");
	await withFakePiEnvironment(fake, () => continuation.execute("stored", {
		id: 1, prompt: "stored tool task",
	}, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[3], "stored tool continuation completion");
	const fourth = await waitFor(() => fake.invocations().find(invocation => invocation.argv.at(-1) === "stored tool task"), "stored tool continuation invocation");
	assert.equal(getOption(fourth.argv, "--model"), "vendor/override");
	assert.equal(getOption(fourth.argv, "--thinking"), "xhigh");
});

test("CRLF, split lines and large ignored events preserve the same streamed and final result", async t => {
	const ignoredEvent = `{"type":"agent_start","label":"message_update","payload":"${"x".repeat(2 * 1024 * 1024)}"}\r\n`;
	const fake = createFakePi({ chunks: [
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"split ',
		`line"}}\r\n${ignoredEvent}{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"clean"}}\r\n{"type":"message_end","message":{"role":`,
		'"assistant","content":[{"type":"text","text":"split lineclean"}]}}\r\n',
	] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("stream fixture", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "framed stream result");
	assert.match(sent.message.content, /Result:\nsplit lineclean/);
	assert.doesNotMatch(sent.message.content, /agent_start|x{100}/);
});

test("/subrm kills a running subagent process and never wakes the parent", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("long running task", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "running fake pi invocation");
	await host.commands.get("subrm").handler("1", host.ctx);
	await waitFor(() => {
		try { process.kill(invocation.pid, 0); return undefined; } catch { return true; }
	}, "fake pi process to exit");
	const exit = await waitFor(() => fake.exits()[0], "fake pi exit record");
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(exit.code, 143);
	assert.equal(host.widgets.has("sub-1"), false);
	assert.ok(host.notifications.some(item => item.message.includes("killed and removed")));
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(host.sentMessages.length, 0);
	assert.equal(host.notifications.some(item => item.message.includes("Subagent #1 error") || item.message.includes("Subagent #1 done")), false);
});

test("multi-turn narration delivers only the last assistant message while keeping widget narration", async t => {
	const fake = createFakePi({
		events: [
			textEvent("Checking files first..."),
			toolEvent,
			assistantMessageEnd("Checking files first...", { input: 100, cacheRead: 20, output: 10, cost: { total: 0.001 } }),
			textEvent("\nFinal answer: 42"),
			assistantMessageEnd("Final answer: 42", { input: 150, cacheRead: 30, output: 15, cost: { total: 0.002 } }),
		],
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("multi turn task", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "multi-turn final message");
	assert.match(sent.message.content, /Final answer: 42/);
	assert.doesNotMatch(sent.message.content, /Checking files first\.\.\./);
	const widgetFactory = host.getWidgetFactory("sub-1");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	const lines = widget.render(120);
	assert.ok(lines.some((line: string) => line.includes("Final answer: 42")));
});

test("over-limit final message keeps its tail and says it was cut", async t => {
	const longMessage = `HEAD_MARKER_${"a".repeat(9000)}_TAIL_MARKER`;
	const fake = createFakePi({
		events: [textEvent(longMessage), assistantMessageEnd(longMessage)],
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("long output task", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "truncated final message");
	assert.match(sent.message.content, /TAIL_MARKER/);
	assert.doesNotMatch(sent.message.content, /HEAD_MARKER/);
	assert.match(sent.message.content, /truncated/i);
});

test("usage totals are summed across messages and stderr is attached only on non-zero exit", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"ok-task": {
				events: [
					assistantMessageEnd("step 1", { input: 100, cacheRead: 40, output: 20, cost: { total: 0.0012 } }),
					{ type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, usage: { input: 10, cacheRead: 5, output: 5, cost: { total: 0.0003 } } } },
					assistantMessageEnd("all done", { input: 200, cacheRead: 60, output: 30, cost: { total: 0.0025 } }),
				],
				stderr: "harmless warning on stderr\n",
				exitCode: 0,
			},
			"fail-task": {
				events: [assistantMessageEnd("failed midway", { input: 50, cacheRead: 0, output: 12, cost: { total: 0.0005 } })],
				stderr: "fatal crash reason\n",
				exitCode: 5,
			},
		},
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");

	await withFakePiEnvironment(fake, () => create.execute("c1", { task: "ok-task", thinking: "low" }, undefined, undefined, host.ctx));
	const okSent = await waitFor(() => host.sentMessages[0], "ok result");
	assert.match(okSent.message.content, /all done/);
	assert.match(okSent.message.content, /input 310/);
	assert.match(okSent.message.content, /cacheRead 105/);
	assert.match(okSent.message.content, /output 55/);
	assert.match(okSent.message.content, /\$0\.0040/);
	assert.doesNotMatch(okSent.message.content, /harmless warning on stderr/);
	assert.doesNotMatch(okSent.message.content, /Stderr:/);

	await withFakePiEnvironment(fake, () => create.execute("c2", { task: "fail-task", thinking: "low" }, undefined, undefined, host.ctx));
	const failSent = await waitFor(() => host.sentMessages[1], "fail result");
	assert.match(failSent.message.content, /failed midway/);
	assert.match(failSent.message.content, /Stderr:\nfatal crash reason/);
});

test("three parallel subagents produce one coalesced wake-up after the last settles", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"job-1": { events: [assistantMessageEnd("result one")], delayMs: 15 },
			"job-2": { events: [assistantMessageEnd("result two")], delayMs: 80 },
			"job-3": { events: [assistantMessageEnd("result three")], delayMs: 180 },
		},
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");

	await withFakePiEnvironment(fake, async () => {
		await create.execute("c1", { task: "job-1", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c2", { task: "job-2", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c3", { task: "job-3", thinking: "low" }, undefined, undefined, host.ctx);
	});

	// Wait until the first two have exited, while job-3 is still running.
	await waitFor(() => fake.exits().length >= 2 ? true : undefined, "first two subagents to exit");
	assert.equal(host.sentMessages.length, 0);

	const sent = await waitFor(() => host.sentMessages[0], "single coalesced wake-up");
	assert.equal(fake.exits().length, 3);
	assert.equal(host.sentMessages.length, 1);
	assert.match(sent.message.content, /result one/);
	assert.match(sent.message.content, /result two/);
	assert.match(sent.message.content, /result three/);
	assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
});

test("subagent continued while siblings run rejoins the running set", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"branch-a": { events: [assistantMessageEnd("a-turn-1")], delayMs: 15 },
			"branch-b": { events: [assistantMessageEnd("b-done")], delayMs: 140 },
			"branch-a-cont": { events: [assistantMessageEnd("a-turn-2")], delayMs: 260 },
		},
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	const list = host.tools.get("subagent_list");

	await withFakePiEnvironment(fake, async () => {
		await create.execute("c1", { task: "branch-a", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c2", { task: "branch-b", thinking: "low" }, undefined, undefined, host.ctx);
	});

	// Wait for #1 to finish while #2 is still running.
	await waitFor(async () => {
		const listed = await list.execute("l1", {}, undefined, undefined, host.ctx);
		return listed.content[0].text.includes("#1 [DONE]") ? true : undefined;
	}, "subagent #1 to settle");
	assert.equal(host.sentMessages.length, 0);

	// Continue #1 before #2 finishes, with a longer delay so #2 finishes first.
	const contResult = await withFakePiEnvironment(fake, () =>
		continuation.execute("c3", { id: 1, prompt: "branch-a-cont" }, undefined, undefined, host.ctx),
	);
	assert.equal(contResult.terminate, true);

	// Wait for #2 to finish; #1 is running again so no wake-up yet.
	await waitFor(async () => {
		const listed = await list.execute("l2", {}, undefined, undefined, host.ctx);
		return listed.content[0].text.includes("#2 [DONE]") ? true : undefined;
	}, "subagent #2 to settle");
	assert.equal(host.sentMessages.length, 0);

	const sent = await waitFor(() => host.sentMessages[0], "coalesced wake-up after continued subagent settles");
	assert.equal(host.sentMessages.length, 1);
	assert.match(sent.message.content, /a-turn-1/);
	assert.match(sent.message.content, /b-done/);
	assert.match(sent.message.content, /a-turn-2/);
});

test("subagent_remove and /subclear never wake the parent, and removal handles open batches safely", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"quick-done": { events: [assistantMessageEnd("quick result")], delayMs: 15 },
			"hang-1": { events: [], delayMs: 30000 },
			"hang-2": { events: [], delayMs: 30000 },
			"surviving": { events: [assistantMessageEnd("survivor result")], delayMs: 140 },
		},
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const remove = host.tools.get("subagent_remove");
	const list = host.tools.get("subagent_list");

	// Case 1: removing a sibling while another runs leaves the survivor to wake once.
	await withFakePiEnvironment(fake, async () => {
		await create.execute("c1", { task: "hang-1", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c2", { task: "surviving", thinking: "low" }, undefined, undefined, host.ctx);
	});
	await waitFor(() => fake.invocations().length >= 2 ? true : undefined, "two running processes");
	const removed = await remove.execute("r1", { id: 1 }, undefined, undefined, host.ctx);
	assert.match(removed.content[0].text, /removed/);
	assert.equal(removed.terminate, undefined);

	const survivorSent = await waitFor(() => host.sentMessages[0], "survivor result");
	assert.equal(host.sentMessages.length, 1);
	assert.match(survivorSent.message.content, /survivor result/);
	assert.doesNotMatch(survivorSent.message.content, /#1 /);

	// Case 2: removing the LAST running subagent flushes already-queued results of others and sends nothing for the removed one.
	await withFakePiEnvironment(fake, async () => {
		await create.execute("c3", { task: "quick-done", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c4", { task: "hang-2", thinking: "low" }, undefined, undefined, host.ctx);
	});
	await waitFor(async () => {
		const listed = await list.execute("l1", {}, undefined, undefined, host.ctx);
		return listed.content[0].text.includes("#3 [DONE]") ? true : undefined;
	}, "subagent #3 to finish while #4 runs");
	assert.equal(host.sentMessages.length, 1);
	await remove.execute("r2", { id: 4 }, undefined, undefined, host.ctx);
	const flushed = await waitFor(() => host.sentMessages[1], "flushed queued result after last running sibling removed");
	assert.match(flushed.message.content, /quick result/);
	assert.doesNotMatch(flushed.message.content, /#4 /);

	// Wait for #4's process to exit and confirm no extra wake-up arrives.
	const hang2Pid = fake.invocations().find(inv => inv.argv.at(-1) === "hang-2")!.pid;
	await waitFor(() => {
		try { process.kill(hang2Pid, 0); return undefined; } catch { return true; }
	}, "hang-2 exit");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(host.sentMessages.length, 2);

	// Case 3: /subclear kills all running subagents (and drops queued ones) with zero wake-ups.
	await withFakePiEnvironment(fake, async () => {
		await host.commands.get("sub").handler("quick-done", host.ctx);
		await host.commands.get("sub").handler("hang-1", host.ctx);
	});
	await waitFor(() => fake.invocations().length >= 6 ? true : undefined, "subclear targets launched");
	await waitFor(async () => {
		const listed = await list.execute("l2", {}, undefined, undefined, host.ctx);
		return listed.content[0].text.includes("#5 [DONE]") ? true : undefined;
	}, "quick-done #5 to settle and queue before /subclear");
	await host.commands.get("subclear").handler("", host.ctx);
	const hang1ClearPid = fake.invocations().at(-1)!.pid;
	await waitFor(() => {
		try { process.kill(hang1ClearPid, 0); return undefined; } catch { return true; }
	}, "subclear child exit");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(host.sentMessages.length, 2);
});

test("SIGTERM-ignoring child is force-killed after the grace period without waking the parent", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000, ignoreSigterm: true });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	// Uses the documented killGraceMs test seam so the 5s default SIGTERM->SIGKILL grace period runs fast in tests.
	const host = createFakeHost(extension, fake.cwd, { killGraceMs: 60 });
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("stubborn task", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "stubborn fake pi invocation");
	await host.commands.get("subrm").handler("1", host.ctx);
	const sig = await waitFor(() => fake.signals()[0], "SIGTERM delivered to stubborn child");
	assert.equal(sig.signal, "SIGTERM");
	// Still alive immediately after SIGTERM because it ignored it.
	assert.doesNotThrow(() => process.kill(invocation.pid, 0));
	// Force-killed by SIGKILL once the grace period elapses.
	await waitFor(() => {
		try { process.kill(invocation.pid, 0); return undefined; } catch { return true; }
	}, "SIGKILL to terminate stubborn child");
	assert.equal(fake.exits().length, 0);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(host.sentMessages.length, 0);
});

test("launch tools mark results terminating and mixed batches stay non-terminating", async t => {
	const fake = createFakePi({ events: [assistantMessageEnd("done")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	const list = host.tools.get("subagent_list");

	// Missing / running continuation errors must not terminate the parent turn.
	const missingCont = await continuation.execute("e1", { id: 99, prompt: "nope" }, undefined, undefined, host.ctx);
	assert.equal(missingCont.terminate, undefined);

	const [createRes, listRes] = await withFakePiEnvironment(fake, () => Promise.all([
		create.execute("c1", { task: "task-1", thinking: "low" }, undefined, undefined, host.ctx),
		list.execute("l1", {}, undefined, undefined, host.ctx),
	]));
	assert.equal(createRes.terminate, true);
	assert.equal(listRes.terminate, undefined);
	assert.equal([createRes, listRes].every((res: any) => res.terminate === true), false);

	const runningCont = await continuation.execute("e2", { id: 1, prompt: "too early" }, undefined, undefined, host.ctx);
	assert.equal(runningCont.terminate, undefined);

	await waitFor(() => host.sentMessages[0], "first turn finished");
	const [contRes, listAfterRes] = await withFakePiEnvironment(fake, () => Promise.all([
		continuation.execute("c2", { id: 1, prompt: "task-2" }, undefined, undefined, host.ctx),
		list.execute("l2", {}, undefined, undefined, host.ctx),
	]));
	assert.equal(contRes.terminate, true);
	assert.equal(listAfterRes.terminate, undefined);
	assert.equal([contRes, listAfterRes].every((res: any) => res.terminate === true), false);
});
