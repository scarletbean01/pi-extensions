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

test("/sub launches the fake pi and delivers streamed result after normal exit", async t => {
	const fake = createFakePi({ events: [textEvent("first "), toolEvent, textEvent("answer")] });
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

test("subagent_create launches the fake pi and includes stderr and streamed text on an error exit", async t => {
	const fake = createFakePi({ events: [textEvent("partial result")], stderr: "fake failure detail\n", exitCode: 7 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	assert.match(create.parameters.properties.skills.items.description, /launch only/);
	assert.match(create.parameters.properties.writeAccess.description, /launch only/);
	const launch = await withFakePiEnvironment(fake, () => create.execute("call-1", { task: "inspect failing task", thinking: "high" }, undefined, undefined, host.ctx));
	assert.match(launch.content[0].text, /Subagent #1 spawned/);
	const sent = await waitFor(() => host.sentMessages[0], "error result message");
	const invocation = (await waitFor(() => fake.invocations()[0], "fake pi invocation"));
	assert.equal(invocation.argv.at(-1), "inspect failing task");
	assert.equal(sent.message.customType, "subagent-result");
	// PINS-CURRENT-BEHAVIOUR: failures include stderr with already-streamed text; ticket 03 makes stderr failure-only.
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
	const fake = createFakePi({ events: [textEvent("turn result")] });
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
	// PINS-CURRENT-BEHAVIOUR: the result identifies Turn 2; ticket 03 changes final-result delivery and format.
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

test("CRLF, split lines and large ignored events preserve the same streamed result", async t => {
	const ignoredEvent = `{"type":"agent_start","label":"message_update","payload":"${"x".repeat(2 * 1024 * 1024)}"}\r\n`;
	const fake = createFakePi({ chunks: [
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"split ',
		`line"}}\r\n${ignoredEvent}{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"clean"}}\r\n`,
	] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("stream fixture", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "framed stream result");
	assert.match(sent.message.content, /Result:\nsplit lineclean/);
	assert.doesNotMatch(sent.message.content, /agent_start|x{100}/);
});

test("/subrm kills a running subagent process", async t => {
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
	// PINS-CURRENT-BEHAVIOUR: /subrm sends SIGTERM today; ticket 03 adds a force-kill after 5 seconds.
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(exit.code, 143);
	assert.equal(host.widgets.has("sub-1"), false);
	assert.ok(host.notifications.some(item => item.message.includes("killed and removed")));
	// PINS-CURRENT-BEHAVIOUR: SIGTERM close currently sends a result and wakes the parent; ticket 03 makes cancellation silent.
	await waitFor(() => host.sentMessages[0], "current SIGTERM completion message");
	assert.match(host.sentMessages[0].message.content, /Result:\n/);
});
