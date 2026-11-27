/**
 * Run with: timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts
 * These tests cross the extension entry point; Pi packages are stubbed, while the extension and fake executable are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFakeHost, createFakePi, getOption, getVisibleWidth, loadSubagentWidget, waitFor, withFakePiEnvironment } from "./subagent-widget.test-helpers.ts";

const textEvent = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const toolEvent = { type: "tool_execution_start", toolName: "read" };
const assistantMessageEnd = (
	text: string,
	usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; cost?: { total?: number } },
	extra?: { stopReason?: string; errorMessage?: string },
) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		...(usage ? { usage } : {}),
		...(extra ?? {}),
	},
});

test("/sub launches the fake pi and delivers final assistant message after normal exit", async t => {
	const fake = createFakePi({ events: [textEvent("first "), toolEvent, textEvent("answer"), assistantMessageEnd("first answer")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	assert.equal(host.ctx.cwd, fake.cwd);
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "test" }));
	await withFakePiEnvironment(fake, async () => assert.doesNotReject(host.emit("session_shutdown", { reason: "test" })));
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "test" }));
	host.setActiveTools(["probe-tool"]);
	assert.deepEqual(host.getActiveTools(), ["probe-tool"]);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, 1);
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
	const widgetFactory = host.getWidgetFactory("subagents");
	assert.equal(typeof widgetFactory, "function", "the fake UI exposes the single combined subagents widget factory");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	const renderedLines = widget.render(80);
	assert.ok(Array.isArray(renderedLines), "the widget factory returns rendered lines at the requested width");
	assert.ok(renderedLines.some(line => line.includes("#1") && line.includes("first answer")));
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
	const widgetFactory = host.getWidgetFactory("subagents");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	assert.ok(widget.render(80).some((line: string) => line.includes("✗")));
	assert.deepEqual(fake.invocations(), []);
});

test("a failed NUL continuation keeps prior done status/result, notes it in list, and stays recoverable", async t => {
	const fake = createFakePi({ events: [textEvent("initial answer"), assistantMessageEnd("initial answer")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const list = host.tools.get("subagent_list");
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("initial task", host.ctx));
	await waitFor(() => host.sentMessages[0], "initial subagent completion");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 invalid\u0000prompt", host.ctx));
	assert.ok(host.notifications.some(item => item.level === "error" && /Could not launch subagent.*(?:ERR_INVALID_ARG_VALUE|null bytes)/.test(item.message)));
	const widgetFactory = host.getWidgetFactory("subagents");
	const widget = widgetFactory({}, { fg: (_color: string, text: string) => text });
	const lines = widget.render(120);
	assert.ok(lines.some((line: string) => line.includes("✓")));
	assert.ok(lines.some((line: string) => line.includes("initial answer")));
	assert.equal(lines.some((line: string) => line.includes("Could not launch subagent")), false);
	const listedAfterFail = await list.execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listedAfterFail.content[0].text, /#1 \[DONE\].*\[last continue failed: Could not launch subagent/);
	assert.equal(fake.invocations().length, 1, "the invalid continuation never starts a child");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 valid follow-up", host.ctx));
	await waitFor(() => host.sentMessages[1], "valid continuation after spawn failure");
	assert.equal(fake.invocations().length, 2);
	const listedAfterRetry = await list.execute("l2", {}, undefined, undefined, host.ctx);
	assert.match(listedAfterRetry.content[0].text, /#1 \[DONE\] \(Turn 2,/);
	assert.doesNotMatch(listedAfterRetry.content[0].text, /last continue failed/);
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
	await waitFor(() => fake.exits().length >= 3 && host.sentMessages[0] ? true : undefined, "all literal-prompt children to exit cleanly");
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
	const widgetFactory = host.getWidgetFactory("subagents");
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
	const continuationWidget = host.getWidgetFactory("subagents")({}, { fg: (_color: string, text: string) => text });
	assert.ok(continuationWidget.render(80).some((line: string) => line.includes("#3") && line.includes("✓")));
	const listed = await host.tools.get("subagent_list").execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listed.content[0].text, /#3 \[DONE\].*\[last continue failed: Could not prepare subagent launch/);
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
	assert.match(continuation.parameters.properties.thinking.description, /this and later turns/);
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
	assert.equal(host.widgets.has("subagents"), false);
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
	const widgetFactory = host.getWidgetFactory("subagents");
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
					assistantMessageEnd("step 1", { input: 100, cacheRead: 40, cacheWrite: 15, output: 20, cost: { total: 0.0012 } }),
					{ type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, usage: { input: 10, cacheRead: 5, cacheWrite: 2, output: 5, cost: { total: 0.0003 } } } },
					assistantMessageEnd("all done", { input: 200, cacheRead: 60, cacheWrite: 25, output: 30, cost: { total: 0.0025 } }),
				],
				stderr: "harmless warning on stderr\n",
				exitCode: 0,
			},
			"fail-task": {
				events: [assistantMessageEnd("failed midway", { input: 50, cacheRead: 0, cacheWrite: 0, output: 12, cost: { total: 0.0005 } })],
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
	assert.match(okSent.message.content, /cacheWrite 42/);
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

test("session_shutdown cancels children, clears the widget and timer, and is idempotent", async t => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const origSetInterval = globalThis.setInterval;
	const origClearInterval = globalThis.clearInterval;
	const activeTimers = new Set<unknown>();
	globalThis.setInterval = ((fn: any, ms?: number, ...args: any[]) => {
		const handle = origSetInterval(fn, ms, ...args);
		activeTimers.add(handle);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle?: any) => {
		activeTimers.delete(handle);
		return origClearInterval(handle);
	}) as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = origSetInterval;
		globalThis.clearInterval = origClearInterval;
		t.mock.timers.reset();
	});
	const fake = createFakePi({ events: [], delayMs: 30000, ignoreSigterm: true });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd, { killGraceMs: 40 });
	assert.equal(existsSync(fake.sessionsDir), false, "first launch starts without an existing sessions directory");
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("shutdown task", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "shutdown child invocation");
	assert.ok(host.widgets.has("subagents"));
	assert.equal(activeTimers.size, 1);
	await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
	await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
	await waitFor(() => {
		try { process.kill(invocation.pid, 0); return undefined; } catch { return true; }
	}, "shutdown child exit");
	assert.equal(host.widgets.has("subagents"), false);
	assert.equal(activeTimers.size, 0, "shutdown stops the shared timer");
	assert.equal(host.sentMessages.length, 0, "shutdown does not wake the parent");
	assert.equal(host.notifications.some(item => /Subagent #1 (done|error)/.test(item.message)), false);
});

test("session_shutdown disables only management tools and avoids redundant tool-set writes", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const managementTools = ["subagent_continue", "subagent_remove", "subagent_list"];
	host.registerTool({ name: "other-active", description: "Active extension tool", parameters: {} });
	host.registerTool({ name: "other-inactive", description: "Inactive extension tool", parameters: {}, defaultActive: false });
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("shutdown active tools", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "shutdown active-tools child");
	assert.ok(managementTools.every(name => host.getActiveTools().includes(name)));
	assert.ok(host.getActiveTools().includes("other-active"));
	assert.equal(host.getActiveTools().includes("other-inactive"), false);
	const setCallsBeforeShutdown = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "other-active"]);
	assert.ok(host.tools.has("other-inactive"), "inactive tools from other extensions remain registered");
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCallsBeforeShutdown + 1);
	await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCallsBeforeShutdown + 1);
	await waitFor(() => { try { process.kill(invocation.pid, 0); return undefined; } catch { return true; } }, "shutdown active-tools child exit");
	await waitFor(() => !existsSync(dirname(getOption(invocation.argv, "--extension")!)) ? true : undefined, "shutdown active-tools extension cleanup");

	const emptyFake = createFakePi({ events: [] });
	t.after(() => emptyFake.cleanup());
	const emptyExtension = await loadSubagentWidget();
	const emptyHost = createFakeHost(emptyExtension, emptyFake.cwd);
	emptyHost.registerTool({ name: "other-active", description: "Active extension tool", parameters: {} });
	emptyHost.registerTool({ name: "other-inactive", description: "Inactive extension tool", parameters: {}, defaultActive: false });
	emptyHost.setActiveTools(["subagent_create", "other-active"]);
	const setCallsBeforeEmptyShutdown = emptyHost.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await withFakePiEnvironment(emptyFake, () => emptyHost.emit("session_shutdown", { reason: "quit" }));
	await withFakePiEnvironment(emptyFake, () => emptyHost.emit("session_shutdown", { reason: "quit" }));
	assert.deepEqual(emptyHost.getActiveTools(), ["subagent_create", "other-active"]);
	assert.equal(emptyHost.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCallsBeforeEmptyShutdown);
});

test("remove paths delete only removed session files and clear does not reuse a session path", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const remove = host.tools.get("subagent_remove");
	await withFakePiEnvironment(fake, async () => {
		await create.execute("c1", { task: "remove-tool", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c2", { task: "remove-command", thinking: "low" }, undefined, undefined, host.ctx);
	});
	await waitFor(() => fake.invocations().length === 2 ? true : undefined, "remove test children");
	const [firstFile, secondFile] = fake.invocations().map(inv => getOption(inv.argv, "--session")!);
	const toolFile = [firstFile, secondFile].find(file => file.includes("/subagent-1-"))!;
	const commandFile = [firstFile, secondFile].find(file => file.includes("/subagent-2-"))!;
	const toolPid = fake.invocations().find(inv => getOption(inv.argv, "--session") === toolFile)!.pid;
	const commandPid = fake.invocations().find(inv => getOption(inv.argv, "--session") === commandFile)!.pid;
	writeFileSync(toolFile, "tool subagent session");
	writeFileSync(commandFile, "command subagent session");
	assert.ok(existsSync(toolFile));
	assert.ok(existsSync(commandFile));
	await remove.execute("r1", { id: 1 }, undefined, undefined, host.ctx);
	await waitFor(() => !existsSync(toolFile) ? true : undefined, "remove-tool session file deletion");
	assert.equal(existsSync(commandFile), true);
	await waitFor(() => { try { process.kill(toolPid, 0); return undefined; } catch { return true; } }, "remove-tool child exit");
	await host.commands.get("subrm").handler("2", host.ctx);
	await waitFor(() => !existsSync(commandFile) ? true : undefined, "remove-command session file deletion");
	await waitFor(() => { try { process.kill(commandPid, 0); return undefined; } catch { return true; } }, "remove-command child exit");

	await withFakePiEnvironment(fake, async () => {
		await create.execute("c3", { task: "clear-one", thinking: "low" }, undefined, undefined, host.ctx);
		await create.execute("c4", { task: "clear-two", thinking: "low" }, undefined, undefined, host.ctx);
	});
	await waitFor(() => fake.invocations().length === 4 ? true : undefined, "clear test children");
	const clearFiles = fake.invocations().slice(2).map(inv => getOption(inv.argv, "--session")!);
	const firstClearedSession = clearFiles.find(file => file.includes("/subagent-1-"))!;
	const clearedPids = fake.invocations().slice(2).map(inv => inv.pid);
	for (const file of clearFiles) writeFileSync(file, "clear subagent session");
	await host.commands.get("subclear").handler("", host.ctx);
	assert.deepEqual(clearFiles.map(existsSync), [false, false]);
	for (const pid of clearedPids) {
		await waitFor(() => { try { process.kill(pid, 0); return undefined; } catch { return true; } }, "cleared child exit");
	}
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("after clear", host.ctx));
	const reusedIdFile = getOption((await waitFor(() => fake.invocations()[4], "post-clear child")).argv, "--session")!;
	assert.notEqual(reusedIdFile, firstClearedSession, "resetting the visible id must not reuse a session filename");
	await host.commands.get("subrm").handler("1", host.ctx);
	const reusedIdPid = fake.invocations()[4].pid;
	await waitFor(() => { try { process.kill(reusedIdPid, 0); return undefined; } catch { return true; } }, "post-clear child exit");
	await waitFor(() => fake.invocations().every(inv => !existsSync(dirname(getOption(inv.argv, "--extension")!))) ? true : undefined, "child extension cleanup");
});

test("session_start prunes only old subagent session files", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	mkdirSync(fake.sessionsDir, { recursive: true });
	const oldFile = join(fake.sessionsDir, "subagent-old.jsonl");
	const recentFile = join(fake.sessionsDir, "subagent-recent.jsonl");
	const unrelatedFile = join(fake.sessionsDir, "other-session.jsonl");
	for (const file of [oldFile, recentFile, unrelatedFile]) writeFileSync(file, "fixture");
	const now = Date.now();
	utimesSync(oldFile, (now - 8 * 24 * 60 * 60 * 1000) / 1000, (now - 8 * 24 * 60 * 60 * 1000) / 1000);
	utimesSync(recentFile, (now - 2 * 24 * 60 * 60 * 1000) / 1000, (now - 2 * 24 * 60 * 60 * 1000) / 1000);
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd, { sessionFileMaxAgeMs: 7 * 24 * 60 * 60 * 1000 });
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "startup" }));
	assert.equal(existsSync(oldFile), false);
	assert.equal(existsSync(recentFile), true);
	assert.equal(existsSync(unrelatedFile), true);
});

test("the harness keeps session pruning inside its isolated home", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const probeHome = join(fake.root, "probe-home");
	const probeSessions = join(probeHome, ".pi", "agent", "sessions", "subagents");
	mkdirSync(probeSessions, { recursive: true });
	const sentinel = join(probeSessions, "subagent-9-1.jsonl");
	writeFileSync(sentinel, "keep");
	const old = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
	utimesSync(sentinel, old, old);
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	mkdirSync(fake.sessionsDir, { recursive: true });
	const fakeStaleFile = join(fake.sessionsDir, "subagent-8-1.jsonl");
	writeFileSync(fakeStaleFile, "prune only this fake home");
	utimesSync(fakeStaleFile, old, old);
	await withFakePiEnvironment(fake, async () => {
		const isolatedHome = process.env.HOME;
		process.env.HOME = probeHome;
		try { await host.emit("session_start", { reason: "startup" }); }
		finally { if (isolatedHome === undefined) delete process.env.HOME; else process.env.HOME = isolatedHome; }
	});
	assert.equal(existsSync(sentinel), true, "the injected fake sessions directory prevents access to HOME");
	assert.equal(existsSync(fakeStaleFile), false, "the harness prunes within its injected fake sessions directory");
});

test("failed session-directory creation is retried on the next launch", async t => {
	const fake = createFakePi({ events: [assistantMessageEnd("retry worked")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	let attempts = 0;
	const host = createFakeHost(extension, fake.cwd, {
		createSessionsDirectory: async dir => {
			attempts++;
			if (attempts === 1) throw new Error("EACCES: probe failure");
			await mkdirAsync(dir, { recursive: true });
		},
	});
	const create = host.tools.get("subagent_create");
	const first = await withFakePiEnvironment(fake, () => create.execute("first", { task: "first attempt", thinking: "low" }, undefined, undefined, host.ctx));
	assert.equal(first.isError, true);
	assert.equal(first.terminate, undefined);
	assert.equal(host.sentMessages.length, 0);
	assert.equal(fake.invocations().length, 0);
	const second = await withFakePiEnvironment(fake, () => create.execute("second", { task: "second attempt", thinking: "low" }, undefined, undefined, host.ctx));
	assert.equal(second.terminate, true);
	assert.equal(attempts, 2);
	await waitFor(() => host.sentMessages[0], "retry launch result");
});

test("removal deletes a session file after the child flushes during SIGTERM", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000, writeSessionOnSigterm: true });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	await withFakePiEnvironment(fake, () => create.execute("create", { task: "flush on stop", thinking: "low" }, undefined, undefined, host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "flush-on-stop child");
	const sessionFile = getOption(invocation.argv, "--session")!;
	writeFileSync(sessionFile, "current session");
	await host.tools.get("subagent_remove").execute("remove", { id: 1 }, undefined, undefined, host.ctx);
	await waitFor(() => !existsSync(sessionFile) ? true : undefined, "session file deletion after child exit");
	await waitFor(() => { try { process.kill(invocation.pid, 0); return undefined; } catch { return true; } }, "flush-on-stop child exit");
	await waitFor(() => !existsSync(dirname(getOption(invocation.argv, "--extension")!)) ? true : undefined, "flush-on-stop extension cleanup");
});

test("shutdown is bounded when a killed child has a background process holding stdout", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000, ignoreSigterm: true, backgroundHoldMs: 1800 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const killGraceMs = 80;
	const host = createFakeHost(extension, fake.cwd, { killGraceMs });
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("background holder", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "background-holder child");
	const holderPid = await waitFor(() => fake.holderPids()[0], "background process holding stdout");
	const startedAt = Date.now();
	await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
	const elapsed = Date.now() - startedAt;
	assert.ok(elapsed < killGraceMs + 1000, `shutdown took ${elapsed}ms`);
	await waitFor(() => { try { process.kill(invocation.pid, 0); return undefined; } catch { return true; } }, "killed parent process exit");
	await waitFor(() => { try { process.kill(holderPid, 0); return undefined; } catch { return true; } }, "background holder exit", 4000);
	await waitFor(() => !existsSync(dirname(getOption(invocation.argv, "--extension")!)) ? true : undefined, "background-holder extension cleanup");
});

test("launch waiting on directory creation is cancelled by removal, clear or shutdown", async t => {
	for (const cancelWith of ["subclear", "subrm", "session_shutdown"] as const) {
		const fake = createFakePi({ events: [] });
		t.after(() => fake.cleanup());
		const extension = await loadSubagentWidget();
		let markStarted!: () => void;
		let releaseCreation!: () => void;
		const started = new Promise<void>(resolve => { markStarted = resolve; });
		const gate = new Promise<void>(resolve => { releaseCreation = resolve; });
		const host = createFakeHost(extension, fake.cwd, {
			createSessionsDirectory: async dir => { markStarted(); await gate; await mkdirAsync(dir, { recursive: true }); },
		});
		const launch = withFakePiEnvironment(fake, () => host.tools.get("subagent_create").execute("race", { task: "cancel race", thinking: "low" }, undefined, undefined, host.ctx));
		await started;
		if (cancelWith === "subclear") await host.commands.get("subclear").handler("", host.ctx);
		else if (cancelWith === "subrm") await host.commands.get("subrm").handler("1", host.ctx);
		else await withFakePiEnvironment(fake, () => host.emit("session_shutdown", { reason: "quit" }));
		releaseCreation();
		const result = await launch;
		assert.equal(result.terminate, undefined);
		assert.equal(fake.invocations().length, 0);
		assert.equal(host.sentMessages.length, 0);
	}
});

test("launch tools mark results terminating and mixed batches stay non-terminating", async t => {
	const fake = createFakePi({ events: [assistantMessageEnd("done")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const continuation = host.tools.get("subagent_continue");

	// Missing / running continuation errors must not terminate the parent turn.
	const missingCont = await continuation.execute("e1", { id: 99, prompt: "nope" }, undefined, undefined, host.ctx);
	assert.equal(missingCont.terminate, undefined);

	// Mixed batch [subagent_create, subagent_list] does not terminate the parent turn.
	const mixedCreateBatch = await withFakePiEnvironment(fake, () => host.runToolBatch([
		{ name: "subagent_create", callId: "c1", args: { task: "task-1", thinking: "low" } },
		{ name: "subagent_list", callId: "l1", args: {} },
	]));
	assert.equal(mixedCreateBatch.results[0].terminate, true);
	assert.equal(mixedCreateBatch.results[1].terminate, undefined);
	assert.equal(mixedCreateBatch.terminatesTurn, false);

	const runningCont = await continuation.execute("e2", { id: 1, prompt: "too early" }, undefined, undefined, host.ctx);
	assert.equal(runningCont.terminate, undefined);

	await waitFor(() => host.sentMessages[0], "first turn finished");

	// Launch-only batch [subagent_create, subagent_continue] terminates the parent turn.
	const launchOnlyBatch = await withFakePiEnvironment(fake, () => host.runToolBatch([
		{ name: "subagent_create", callId: "c2", args: { task: "task-2", thinking: "low" } },
		{ name: "subagent_continue", callId: "c3", args: { id: 1, prompt: "task-1-cont" } },
	]));
	assert.equal(launchOnlyBatch.results[0].terminate, true);
	assert.equal(launchOnlyBatch.results[1].terminate, true);
	assert.equal(launchOnlyBatch.terminatesTurn, true);

	await waitFor(() => host.sentMessages[1], "second batch finished");

	// Mixed batch [subagent_continue, subagent_list] does not terminate the parent turn.
	const mixedContinueBatch = await withFakePiEnvironment(fake, () => host.runToolBatch([
		{ name: "subagent_continue", callId: "c4", args: { id: 1, prompt: "task-1-cont-2" } },
		{ name: "subagent_list", callId: "l2", args: {} },
	]));
	assert.equal(mixedContinueBatch.results[0].terminate, true);
	assert.equal(mixedContinueBatch.results[1].terminate, undefined);
	assert.equal(mixedContinueBatch.terminatesTurn, false);

	await waitFor(() => host.sentMessages[2], "third turn finished");
	await waitFor(() => fake.exits().length >= 4 ? true : undefined, "all launch-tool test processes to exit");
});

test("two text blocks separated by a toolCall block are joined with a newline", async t => {
	const fake = createFakePi({
		events: [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "First block" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
						{ type: "text", text: "Second block" },
					],
				},
			},
		],
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("split blocks task", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "joined blocks message");
	assert.match(sent.message.content, /Result:\nFirst block\nSecond block/);
});

test("final assistant errorMessage marks subagent errored and includes the error text even on exit 0", async t => {
	const fake = createFakePi({
		events: [
			assistantMessageEnd("partial output", { input: 10, output: 2 }, { stopReason: "error", errorMessage: "provider rate limit exceeded" }),
		],
		exitCode: 0,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("provider error task", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "assistant error result");
	assert.match(sent.message.content, /Subagent #1 failed \(exit 0\)/);
	assert.match(sent.message.content, /Error:\nprovider rate limit exceeded/);
	const listed = await host.tools.get("subagent_list").execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listed.content[0].text, /#1 \[ERROR\]/);
});

test("chatty stderr is capped and preserves the tail on failure", async t => {
	const chattyStderr = `OLD_STDERR_${"s".repeat(25000)}_TAIL_STDERR\n`;
	const fake = createFakePi({
		events: [assistantMessageEnd("crashed")],
		stderr: chattyStderr,
		exitCode: 2,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("chatty stderr task", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "capped stderr result");
	assert.match(sent.message.content, /TAIL_STDERR/);
	assert.doesNotMatch(sent.message.content, /OLD_STDERR_/);
});

test("synchronous launch/setup failures do not wake parent, mark terminate, or hold a coalescing batch open", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"healthy-sibling": { events: [assistantMessageEnd("sibling finished")], delayMs: 120 },
		},
	});
	t.after(() => fake.cleanup());
	const createWidget = await loadSubagentWidget();
	let failSetup = false;
	const extension = (pi: any) => createWidget(pi, {
		createChildDocsDirectory: () => {
			const directory = mkdtempSync(join(fake.root, "interplay-docs-"));
			if (failSetup) mkdirSync(join(directory, "strip-pi-docs.mjs"));
			return directory;
		},
	});
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const list = host.tools.get("subagent_list");

	await withFakePiEnvironment(fake, () => create.execute("s1", { task: "healthy-sibling", thinking: "low" }, undefined, undefined, host.ctx));

	const nulFail = await withFakePiEnvironment(fake, () => create.execute("s2", { task: "bad\u0000task", thinking: "low" }, undefined, undefined, host.ctx));
	assert.equal(nulFail.isError, true);
	assert.equal(nulFail.terminate, undefined);

	failSetup = true;
	const setupFail = await withFakePiEnvironment(fake, () => create.execute("s3", { task: "blocked-setup", thinking: "low" }, undefined, undefined, host.ctx));
	assert.equal(setupFail.isError, true);
	assert.equal(setupFail.terminate, undefined);
	failSetup = false;

	const listed = await list.execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listed.content[0].text, /#2 \[ERROR\]/);
	assert.match(listed.content[0].text, /#3 \[ERROR\]/);
	assert.equal(host.sentMessages.length, 0);

	const sent = await waitFor(() => host.sentMessages[0], "healthy sibling settles without blocked batch");
	assert.equal(host.sentMessages.length, 1);
	assert.match(sent.message.content, /sibling finished/);
	assert.doesNotMatch(sent.message.content, /#2 |#3 /);
	await waitFor(() => fake.exits().length >= 1 ? true : undefined, "healthy sibling exit");
});

test("failed continuation during an open batch preserves earlier queued result and stays retryable", async t => {
	const fake = createFakePi({
		scenariosByPrompt: {
			"first-fast": { events: [assistantMessageEnd("first turn answer")], delayMs: 15 },
			"second-slow": { events: [assistantMessageEnd("second sibling answer")], delayMs: 140 },
			"valid-retry": { events: [assistantMessageEnd("retried turn answer")], delayMs: 20 },
		},
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	const list = host.tools.get("subagent_list");

	await withFakePiEnvironment(fake, async () => {
		await create.execute("c1", { task: "first-fast", model: "vendor/orig", thinking: "high" }, undefined, undefined, host.ctx);
		await create.execute("c2", { task: "second-slow", thinking: "low" }, undefined, undefined, host.ctx);
	});

	await waitFor(async () => {
		const listed = await list.execute("l1", {}, undefined, undefined, host.ctx);
		return listed.content[0].text.includes("#1 [DONE]") ? true : undefined;
	}, "subagent #1 to settle while #2 runs");
	assert.equal(host.sentMessages.length, 0);

	const badCont = await withFakePiEnvironment(fake, () => continuation.execute("bad-cont", {
		id: 1, prompt: "bad\u0000retry", model: "vendor/ignored", thinking: "low",
	}, undefined, undefined, host.ctx));
	assert.equal(badCont.isError, true);
	assert.equal(badCont.terminate, undefined);
	assert.equal(host.sentMessages.length, 0);

	const listedAfterFail = await list.execute("l2", {}, undefined, undefined, host.ctx);
	assert.match(listedAfterFail.content[0].text, /#1 \[DONE\] \(Turn 1, vendor\/orig, high\).*\[last continue failed:/);

	const batchSent = await waitFor(() => host.sentMessages[0], "coalesced batch with preserved Turn 1 result");
	assert.equal(host.sentMessages.length, 1);
	assert.match(batchSent.message.content, /first turn answer/);
	assert.match(batchSent.message.content, /second sibling answer/);

	const retryCont = await withFakePiEnvironment(fake, () => continuation.execute("good-cont", {
		id: 1, prompt: "valid-retry",
	}, undefined, undefined, host.ctx));
	assert.equal(retryCont.terminate, true);

	const retrySent = await waitFor(() => host.sentMessages[1], "retried continuation result");
	assert.match(retrySent.message.content, /\(Turn 2\)/);
	assert.match(retrySent.message.content, /retried turn answer/);
	const retryInvocation = fake.invocations().at(-1)!;
	assert.equal(getOption(retryInvocation.argv, "--model"), "vendor/orig");
	assert.equal(getOption(retryInvocation.argv, "--thinking"), "high");
	await waitFor(() => fake.exits().length >= 3 ? true : undefined, "all continuation interplay processes to exit");
});

test("tool-call-only final assistant message delivers explicit notice instead of earlier narration", async t => {
	const fake = createFakePi({
		events: [
			textEvent("Earlier narration"),
			assistantMessageEnd("Earlier narration"),
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
				},
			},
		],
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("tool-only end", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "tool-only final message");
	assert.match(sent.message.content, /Result:\n\(the subagent produced no final message\)/);
	assert.doesNotMatch(sent.message.content, /Earlier narration/);
});

test("empty error final assistant message on exit 0 is reported as errored", async t => {
	const fake = createFakePi({
		events: [
			assistantMessageEnd("Earlier output"),
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "upstream returned empty error",
				},
			},
		],
		exitCode: 0,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("empty error end", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "empty error final message");
	assert.match(sent.message.content, /Subagent #1 failed \(exit 0\)/);
	assert.match(sent.message.content, /Result:\n\(the subagent produced no final message\)/);
	assert.match(sent.message.content, /Error:\nupstream returned empty error/);
	assert.doesNotMatch(sent.message.content, /Earlier output/);
	const listed = await host.tools.get("subagent_list").execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listed.content[0].text, /#1 \[ERROR\]/);
});

test("failed first launch keeps turnCount at 0 so the next successful launch is Turn 1", async t => {
	const fake = createFakePi({ events: [assistantMessageEnd("recovered answer")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");
	const continuation = host.tools.get("subagent_continue");
	const list = host.tools.get("subagent_list");

	const failed = await withFakePiEnvironment(fake, () => create.execute("c1", {
		task: "bad\u0000first", thinking: "low",
	}, undefined, undefined, host.ctx));
	assert.equal(failed.isError, true);

	const listedFailed = await list.execute("l1", {}, undefined, undefined, host.ctx);
	assert.match(listedFailed.content[0].text, /#1 \[ERROR\] \(Turn 0,/);

	const retried = await withFakePiEnvironment(fake, () => continuation.execute("c2", {
		id: 1, prompt: "valid first turn",
	}, undefined, undefined, host.ctx));
	assert.equal(retried.terminate, true);

	const sent = await waitFor(() => host.sentMessages[0], "recovered first turn result");
	assert.match(sent.message.content, /recovered answer/);
	assert.doesNotMatch(sent.message.content, /\(Turn 2\)/);
	const listedDone = await list.execute("l2", {}, undefined, undefined, host.ctx);
	assert.match(listedDone.content[0].text, /#1 \[DONE\] \(Turn 1,/);
	await waitFor(() => fake.exits().length >= 1 ? true : undefined, "recovered child exit");
});

test("combined widget registers once for N subagents, caches unchanged renders, and shows all row fields", async t => {
	const fake = createFakePi({
		events: [
			{ type: "tool_execution_start", toolName: "grep" },
			textEvent("scanning files"),
		],
		delayMs: 30000,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const create = host.tools.get("subagent_create");

	await withFakePiEnvironment(fake, () => create.execute("call-1", { task: "first task with a very long task description", thinking: "low" }, undefined, undefined, host.ctx));
	const factory = host.getWidgetFactory("subagents");
	assert.equal(typeof factory, "function");

	let renderRequests = 0;
	let invalidations = 0;
	const widget = factory({ requestRender() { renderRequests++; } }, { fg: (_color: string, text: string) => text });
	const origInvalidate = widget.invalidate.bind(widget);
	widget.invalidate = () => { invalidations++; origInvalidate(); };

	await withFakePiEnvironment(fake, () => create.execute("call-2", { task: "second task", thinking: "medium" }, undefined, undefined, host.ctx));
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("third task", host.ctx));

	await waitFor(() => {
		const lines = widget.render(120);
		return ["#1", "#2", "#3"].every(id =>
			lines.some((l: string) => l.includes(id) && l.includes("grep") && l.includes("scanning files"))
		) ? lines : undefined;
	}, "all three subagent rows to render streamed tool and last line");

	const registrations = host.widgetCalls.filter(c => c.key === "subagents" && typeof c.widget === "function");
	assert.equal(registrations.length, 1, "setWidget must only register once across N subagents and streamed tokens");
	assert.equal(host.widgets.size, 1);
	assert.ok(renderRequests > 0, "updates trigger tui.requestRender()");
	assert.ok(invalidations > 0, "updates invalidate the mounted component");

	const firstRender = widget.render(120);
	const cachedRender = widget.render(120);
	assert.equal(cachedRender, firstRender, "repeated render at same width with no changes returns cached lines");
	const resizedRender = widget.render(70);
	assert.notEqual(resizedRender, firstRender, "changing width recomputes rendered lines");
	widget.invalidate();
	assert.notEqual(widget.render(70), resizedRender, "invalidate clears cached lines");

	const text = firstRender.join("\n");
	const expectedTasks = [
		["#1", "first task with a ve"],
		["#2", "second task"],
		["#3", "third task"],
	];
	for (const [id, taskPreview] of expectedTasks) {
		assert.ok(
			firstRender.some((l: string) =>
				l.includes(id) &&
				l.includes("running") &&
				/\ds/.test(l) &&
				l.includes(taskPreview) &&
				l.includes("Tools: 1 [grep]") &&
				l.includes("scanning files")
			),
			`row for ${id} shows id, status, elapsed, task label, tool count, tool, and last line:\n${text}`,
		);
	}

	await host.commands.get("subclear").handler("", host.ctx);
	assert.equal(host.widgets.has("subagents"), false, "clearing all subagents removes the combined widget");
	assert.equal(host.sentMessages.length, 0, "clearing running subagents never wakes the parent");
	await waitFor(() => {
		const invs = fake.invocations();
		return invs.length >= 3 && invs.every(inv => !existsSync(dirname(getOption(inv.argv, "--extension")!)))
			? true : undefined;
	}, "killed children close cleanup");
});

test("finished and errored subagent rows persist until removed and widget removes on last removal", async t => {
	const okFake = createFakePi({ events: [{ type: "tool_execution_start", toolName: "read" }, { type: "tool_execution_end", toolName: "read" }, textEvent("ok line\n")], exitCode: 0 });
	const errFake = createFakePi({ events: [textEvent("boom line\n")], exitCode: 1 });
	t.after(() => { okFake.cleanup(); errFake.cleanup(); });
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, okFake.cwd);
	const create = host.tools.get("subagent_create");
	const remove = host.tools.get("subagent_remove");

	await withFakePiEnvironment(okFake, () => create.execute("call-1", { task: "succeeds", thinking: "low" }, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[0], "first subagent completion");
	await withFakePiEnvironment(errFake, () => create.execute("call-2", { task: "fails", thinking: "low" }, undefined, undefined, host.ctx));
	await waitFor(() => host.sentMessages[1], "second subagent completion");

	const widget = host.getWidgetFactory("subagents")({ requestRender() {} }, { fg: (_color: string, text: string) => text });
	const bothLines = widget.render(100);
	assert.ok(bothLines.some((l: string) => l.includes("#1") && l.includes("done") && l.includes("succeeds") && l.includes("Tools: 1 [-]") && l.includes("ok line")));
	assert.ok(bothLines.some((l: string) => l.includes("#2") && l.includes("error") && l.includes("fails") && l.includes("Tools: 0 [-]") && l.includes("boom line")));

	await remove.execute("rm-1", { id: 1 }, undefined, undefined, host.ctx);
	assert.equal(host.widgets.has("subagents"), true, "widget stays while #2 remains");
	const remainingLines = widget.render(100);
	assert.equal(remainingLines.some((l: string) => l.includes("#1")), false);
	assert.ok(remainingLines.some((l: string) => l.includes("#2") && l.includes("error")));

	await remove.execute("rm-2", { id: 2 }, undefined, undefined, host.ctx);
	assert.equal(host.widgets.has("subagents"), false, "removing last subagent removes the widget");
});

test("streaming large text updates last line incrementally without re-registering widget", async t => {
	const chunkLines = Array.from({ length: 200 }, (_, i) => JSON.stringify(textEvent(`narration line ${i}\n`)) + "\n").join("");
	const chunks = [
		...Array.from({ length: 15 }, () => chunkLines),
		JSON.stringify(textEvent("x".repeat(2000) + "\nfinal incremental line\n   \n")) + "\n",
	];
	const fake = createFakePi({ chunks });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);

	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("stream large output", host.ctx));
	await waitFor(() => host.sentMessages[0], "large stream completion");

	const registrations = host.widgetCalls.filter(c => c.key === "subagents" && typeof c.widget === "function");
	assert.equal(registrations.length, 1);
	const widget = host.getWidgetFactory("subagents")({ requestRender() {} }, { fg: (_color: string, text: string) => text });
	const lines = widget.render(100);
	assert.ok(lines.some((l: string) => l.includes("final incremental line")));
	assert.equal(lines.some((l: string) => l.includes("narration line")), false);
});

test("one shared 1-second timer runs only while at least one subagent is running", async t => {
	// Spy on mocked setInterval/clearInterval so active timer count is deterministic while child processes run normally.
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const origSetInterval = globalThis.setInterval;
	const origClearInterval = globalThis.clearInterval;
	const activeTimers = new Set<unknown>();
	let createdTimers = 0;
	globalThis.setInterval = ((fn: any, ms?: number, ...args: any[]) => {
		createdTimers++;
		const handle = origSetInterval(fn, ms, ...args);
		activeTimers.add(handle);
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle?: any) => {
		activeTimers.delete(handle);
		return origClearInterval(handle);
	}) as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = origSetInterval;
		globalThis.clearInterval = origClearInterval;
		t.mock.timers.reset();
	});

	const slowFake = createFakePi({ events: [textEvent("still working")], delayMs: 30000 });
	t.after(() => slowFake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, slowFake.cwd);

	assert.equal(activeTimers.size, 0);
	await withFakePiEnvironment(slowFake, () => host.commands.get("sub").handler("first slow", host.ctx));
	let renderRequests = 0;
	const widget = host.getWidgetFactory("subagents")({ requestRender() { renderRequests++; } }, { fg: (_c: string, s: string) => s });
	assert.equal(activeTimers.size, 1, "one timer starts when first subagent runs");

	await withFakePiEnvironment(slowFake, () => host.commands.get("sub").handler("second slow", host.ctx));
	assert.equal(activeTimers.size, 1, "second running subagent reuses the single shared timer");
	assert.equal(createdTimers, 1);

	await waitFor(() => slowFake.invocations().length >= 2 ? true : undefined, "first two slow children to boot");

	const beforeTickRequests = renderRequests;
	t.mock.timers.tick(1000);
	assert.ok(renderRequests > beforeTickRequests, "1s timer tick triggers tui.requestRender()");
	assert.equal(widget.render(100).some((l: string) => l.includes("1s")), true);

	await host.commands.get("subrm").handler("1", host.ctx);
	assert.equal(activeTimers.size, 1, "timer stays active while #2 is still running");

	await host.commands.get("subrm").handler("2", host.ctx);
	assert.equal(activeTimers.size, 0, "timer stops when all subagents are removed");
	assert.equal(host.widgets.has("subagents"), false);

	// Also verify settling naturally stops the timer while keeping the widget visible.
	const fastFake = createFakePi({ events: [textEvent("quick done")] });
	t.after(() => fastFake.cleanup());
	await withFakePiEnvironment(fastFake, () => host.commands.get("sub").handler("fast task", host.ctx));
	assert.equal(activeTimers.size, 1);
	const settledWidget = host.getWidgetFactory("subagents")({ requestRender() {} }, { fg: (_c: string, s: string) => s });
	await waitFor(() => fastFake.exits()[0] && settledWidget.render(100).some((l: string) => l.includes("✓ #3") && l.includes("done") && l.includes("quick done")) ? true : undefined, "fast subagent to settle");
	assert.equal(activeTimers.size, 0, "timer stops when all subagents have settled");
	assert.equal(host.widgets.has("subagents"), true, "settled row keeps widget visible until removed");

	// Also verify session_start resets a running timer and clears the widget.
	await withFakePiEnvironment(slowFake, () => host.commands.get("sub").handler("third slow", host.ctx));
	assert.equal(activeTimers.size, 1);
	await waitFor(() => slowFake.invocations().length >= 3 ? true : undefined, "third slow child to boot");
	await withFakePiEnvironment(slowFake, () => host.emit("session_start", { reason: "new" }));
	assert.equal(activeTimers.size, 0, "session_start clears shared timer");
	assert.equal(host.widgets.has("subagents"), false);

	t.mock.timers.reset();
	await waitFor(() => {
		const invs = slowFake.invocations();
		return invs.length >= 3 && invs.every(inv => !existsSync(dirname(getOption(inv.argv, "--extension")!)))
			? true : undefined;
	}, "all child close handlers to finish cleanup");
});

test("paragraph breaks and whitespace-only deltas do not hang and keep the last non-empty line", async t => {
	const paraFake = createFakePi({
		events: [textEvent("first para."), textEvent("\n\n"), textEvent("second"), assistantMessageEnd("first para.\n\nsecond")],
	});
	t.after(() => paraFake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, paraFake.cwd);

	await withFakePiEnvironment(paraFake, () => host.commands.get("sub").handler("paragraph break", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "paragraph break completion");
	assert.match(sent.message.content, /first para\.\n\nsecond/);
	const paraWidget = host.getWidgetFactory("subagents")({ requestRender() {} }, { fg: (_c: string, s: string) => s });
	assert.ok(paraWidget.render(100).some((l: string) => l.includes("#1") && l.includes("second")));

	// Step-by-step deltas driven deterministically via requestRender snapshots on a fresh host.
	const stepEvents = [
		textEvent("alpha "),
		textEvent("part"),
		{ type: "tool_execution_start", toolName: "t1" },
		textEvent("\n"),
		{ type: "tool_execution_start", toolName: "t2" },
		textEvent("\n\n"),
		{ type: "tool_execution_start", toolName: "t3" },
		textEvent("\r\n"),
		{ type: "tool_execution_start", toolName: "t4" },
		textEvent(" \n "),
		{ type: "tool_execution_start", toolName: "t5" },
		textEvent("omega"),
	];
	const stepFake = createFakePi({ events: stepEvents });
	t.after(() => stepFake.cleanup());
	const stepHost = createFakeHost(extension, stepFake.cwd);
	const snapshots: string[] = [];
	let stepWidget: any;
	await withFakePiEnvironment(stepFake, () => stepHost.commands.get("sub").handler("step deltas", stepHost.ctx));
	stepWidget = stepHost.getWidgetFactory("subagents")(
		{
			requestRender() {
				const row = stepWidget.render(120).find((l: string) => l.includes("#1")) ?? "";
				snapshots.push(row);
			},
		},
		{ fg: (_c: string, s: string) => s },
	);
	await waitFor(() => stepHost.sentMessages[0], "step deltas completion");
	assert.ok(snapshots.some(row => row.includes("alpha") && !row.includes("part")), "captures initial split delta");
	for (const toolTag of ["[t1]", "[t2]", "[t3]", "[t4]", "[t5]"]) {
		assert.ok(
			snapshots.some(row => row.includes(toolTag) && row.includes("alpha part")),
			`preserves last line "alpha part" across whitespace/newline delta before ${toolTag}`,
		);
	}
	const finalRow = stepWidget.render(120).find((l: string) => l.includes("#1")) ?? "";
	assert.ok(finalRow.includes("omega"), `final row must show omega: ${finalRow}`);
	assert.equal(finalRow.includes("alpha part"), false);
});

function oracleVisibleWidth(str: string): number {
	// Independent plain-text oracle: strips CSI/OSC escapes and sums grapheme column widths.
	const stripped = str
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	const segs = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let cols = 0;
	for (const { segment } of segs.segment(stripped)) {
		if (/[\p{Emoji_Presentation}\uFE0F\u20E3]/u.test(segment)) {
			cols += 2;
			continue;
		}
		const nonMark = [...segment].find(ch => !/[\p{Mark}\p{Default_Ignorable_Code_Point}\p{Control}]/u.test(ch));
		if (!nonMark) continue;
		const cp = nonMark.codePointAt(0)!;
		const isWide =
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe6f) ||
			(cp >= 0xff01 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x20000 && cp <= 0x3fffd);
		cols += isWide ? 2 : 1;
	}
	return cols;
}

test("rendering at narrow and wide widths with wide chars and ANSI colors never exceeds width", async t => {
	// Note: @mariozechner/pi-tui / @earendil-works/pi-tui is bundled in the compiled /usr/lib/pi/pi binary
	// and cannot be imported directly from Node (ERR_MODULE_NOT_FOUND), so we check both the harness stub
	// (getVisibleWidth) and the independent oracleVisibleWidth function above.
	const longLine = "Z".repeat(600);
	const fake = createFakePi({
		events: [
			{ type: "tool_execution_start", toolName: "bash" },
			textEvent(`\x1b[2J\x1b[31m中文測試👨‍👩‍👧‍👦Cafe\u0301 a\u0300\u0323日本語\x1b[0m ${longLine}`),
		],
		delayMs: 30000,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);

	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("寬字元👨‍👩‍👧‍👦任務", host.ctx));
	const widget = host.getWidgetFactory("subagents")(
		{ requestRender() {} },
		{ fg: (color: string, text: string) => `\x1b[3${color === "error" ? 1 : color === "success" ? 2 : 6}m${text}\x1b[39m` },
	);

	await waitFor(() => {
		const lines = widget.render(120);
		return lines.some((l: string) => l.includes("日本語")) ? lines : undefined;
	}, "wide-character last line to arrive");

	const fullLines = widget.render(200);
	assert.equal(fullLines.some(l => l.includes("\x1b[2J")), false, "non-SGR terminal control sequences are stripped");

	for (const width of [1, 2, 5, 10, 20, 40, 80]) {
		const lines = widget.render(width);
		assert.ok(lines.length >= 3, `expected frame + row at width ${width}`);
		for (const line of lines) {
			const stubWidth = await getVisibleWidth(line);
			const oracleWidth = oracleVisibleWidth(line);
			assert.ok(stubWidth <= width, `stub width ${stubWidth} exceeded max width ${width}: ${JSON.stringify(line)}`);
			assert.ok(oracleWidth <= width, `oracle width ${oracleWidth} exceeded max width ${width}: ${JSON.stringify(line)}`);
		}
	}

	await host.commands.get("subclear").handler("", host.ctx);
	await waitFor(() => {
		const invs = fake.invocations();
		return invs.length >= 1 && invs.every(inv => !existsSync(dirname(getOption(inv.argv, "--extension")!)))
			? true : undefined;
	}, "killed child close cleanup");
});

test("narrow widths shrink task label so tool and last line remain visible without dim reset leaks", async t => {
	const fake = createFakePi({
		events: [
			{ type: "tool_execution_start", toolName: "grep" },
			textEvent("scanning files for matches"),
		],
		delayMs: 30000,
	});
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);

	await withFakePiEnvironment(fake, () =>
		host.commands.get("sub").handler("long task description that would crowd out tool and output", host.ctx),
	);
	const widget = host.getWidgetFactory("subagents")(
		{ requestRender() {} },
		{
			fg: (color: string, text: string) =>
				color === "dim" ? `\x1b[2m${text}\x1b[22m` : `\x1b[36m${text}\x1b[39m`,
		},
	);

	await waitFor(() => {
		const lines = widget.render(80);
		return lines.some((l: string) => l.includes("grep") && l.includes("scanning files")) ? lines : undefined;
	}, "running row with tool and last line");

	for (const width of [20, 30, 40, 60]) {
		const lines = widget.render(width);
		const row = lines.find((l: string) => l.includes("#1")) ?? "";
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(plain.includes("grep"), `width ${width} row keeps current tool visible: ${plain}`);
		assert.ok(plain.includes("scan") || plain.includes("s..."), `width ${width} row keeps last line visible: ${plain}`);
		assert.ok(oracleVisibleWidth(row) <= width, `width ${width} fits within terminal columns`);
	}

	// Verify the truncated task label keeps its dim wrap unbroken (no stub-injected \x1b[0m inside \x1b[2m...\x1b[22m).
	const wideRow = widget.render(80).find((l: string) => l.includes("#1")) ?? "";
	const dimTaskMatch = wideRow.match(/\x1b\[2mlong task[^\x1b]*\x1b\[22m/);
	assert.ok(dimTaskMatch, `expected unbroken dim span for truncated task label in: ${JSON.stringify(wideRow)}`);

	await host.commands.get("subclear").handler("", host.ctx);
	await waitFor(() => {
		const invs = fake.invocations();
		return invs.length >= 1 && invs.every(inv => !existsSync(dirname(getOption(inv.argv, "--extension")!)))
			? true : undefined;
	}, "narrow width child close cleanup");
});

test("512-character last-line cap never splits surrogate pairs, ZWJ sequences, or escape sequences", async t => {
	const zwjBoundaryFake = createFakePi({
		events: [textEvent("a".repeat(505) + "👨‍👩‍👧‍👦tail")],
	});
	const surrogateBoundaryFake = createFakePi({
		events: [textEvent("b".repeat(511) + "🚀tail")],
	});
	const escapeBoundaryFake = createFakePi({
		events: [textEvent("c".repeat(508) + "\x1b[38;2;1;2;3mhi")],
	});
	t.after(() => {
		zwjBoundaryFake.cleanup();
		surrogateBoundaryFake.cleanup();
		escapeBoundaryFake.cleanup();
	});

	const extension = await loadSubagentWidget();

	for (const [label, fake, expectedPrefix] of [
		["zwj", zwjBoundaryFake, "a".repeat(505)],
		["surrogate", surrogateBoundaryFake, "b".repeat(511)],
		["escape", escapeBoundaryFake, "c".repeat(508)],
	] as const) {
		const host = createFakeHost(extension, fake.cwd);
		await withFakePiEnvironment(fake, () => host.commands.get("sub").handler(`cap ${label}`, host.ctx));
		await waitFor(() => host.sentMessages[0], `${label} boundary completion`);
		const widget = host.getWidgetFactory("subagents")({ requestRender() {} }, { fg: (_c: string, s: string) => s });
		const row = widget.render(1000).find((l: string) => l.includes("#1")) ?? "";
		assert.ok(row.includes(expectedPrefix), `${label} kept safe prefix`);
		assert.equal(/\p{Surrogate}/u.test(row), false, `${label} produced no lone UTF-16 surrogate`);
		assert.equal(row.includes("\u200D"), false, `${label} did not split ZWJ sequence`);
		assert.equal(/\x1b\[[0-9;]*$/.test(row), false, `${label} left no incomplete ANSI escape sequence`);
	}
});

test("management tools are active only while subagents exist and preserve the host active set", async t => {
	const fake = createFakePi({ events: [] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const managementTools = ["subagent_continue", "subagent_remove", "subagent_list"];
	const create = host.tools.get("subagent_create");
	host.registerTool({ name: "other-extension-lazy", description: "Fixture tool", parameters: { properties: {} }, defaultActive: false });
	assert.deepEqual(host.getActiveTools(), ["subagent_create"]);
	for (const name of managementTools) assert.equal(host.tools.get(name).defaultActive, false);
	for (const tool of host.tools.values()) {
		assert.ok(tool.description.length < 200, `${tool.name} description should be concise`);
		const schemas = [...Object.values(tool.parameters.properties) as any[]];
		while (schemas.length > 0) {
			const schema = schemas.pop();
			if (typeof schema.description === "string") {
				assert.ok(schema.description.length < 120, `${tool.name} parameter descriptions should be concise`);
			}
			if (schema.items) schemas.push(schema.items);
		}
	}
	assert.match(create.parameters.properties.skills.items.description, /launch only/i);
	assert.match(create.parameters.properties.writeAccess.description, /launch only/i);
	assert.match(create.parameters.properties.model.description, /only if the user requests a specific model/i);
	assert.match(create.description, /model override only by user request/i);
	assert.match(host.tools.get("subagent_continue").parameters.properties.skills.items.description, /turn only/i);
	assert.match(host.tools.get("subagent_continue").parameters.properties.writeAccess.description, /turn only/i);

	host.setActiveTools(["subagent_create", "other-active"]);
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "startup" }));
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "other-active"]);
	const callsBeforeNoopStart = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "reload" }));
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, callsBeforeNoopStart);

	// A synchronous launch failure still leaves an error subagent, so it activates management tools.
	const failed = await create.execute("invalid", { task: "bad\u0000task", thinking: "low" }, undefined, undefined, host.ctx);
	assert.equal(failed.isError, true);
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "other-active", ...managementTools]);
	assert.equal(host.getActiveTools().includes("other-extension-lazy"), false);
	let setCalls = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await host.emit("before_agent_start", {});
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCalls);
	// Simulate another extension changing the active set while subagent tools are available.
	host.setActiveTools(["subagent_create", "external-new"]);
	setCalls = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await host.emit("session_tree", {});
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "external-new", ...managementTools]);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCalls + 1);
	setCalls = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	const removed = await host.tools.get("subagent_remove").execute("remove", { id: 1 }, undefined, undefined, host.ctx);
	assert.match(removed.content[0].text, /removed/);
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "external-new"]);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, setCalls + 1);
	assert.equal(host.getActiveTools().includes("other-extension-lazy"), false);

	await withFakePiEnvironment(fake, () => create.execute("recreate", {
		task: "recreated subagent", thinking: "low",
	}, undefined, undefined, host.ctx));
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "external-new", ...managementTools]);
	assert.equal(host.getActiveTools().includes("other-extension-lazy"), false);
	await waitFor(() => host.sentMessages[0], "recreated subagent to settle");
	await host.commands.get("subclear").handler("", host.ctx);
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "external-new"]);
	assert.equal(host.getActiveTools().includes("other-extension-lazy"), false);
	const callsAfterClear = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await host.commands.get("subclear").handler("", host.ctx);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, callsAfterClear);
});

test("a new session resets management tools even when a subagent existed", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const managementTools = ["subagent_continue", "subagent_remove", "subagent_list"];
	host.setActiveTools(["subagent_create", "extension-tool", ...managementTools]);
	host.addHandler("session_start", async () => {
		host.registerTool({ name: "late-session-tool", description: "Fixture tool", parameters: {} });
	});
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("long running", host.ctx));
	await waitFor(() => fake.invocations()[0], "subagent process start");
	assert.equal(host.widgets.has("subagents"), true);
	assert.ok(managementTools.every(name => host.getActiveTools().includes(name)));
	const callsBeforeReset = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await withFakePiEnvironment(fake, () => host.emit("session_start", { reason: "new" }));
	assert.equal(host.widgets.has("subagents"), false, "session_start clears the combined widget");
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "extension-tool", ...managementTools, "late-session-tool"]);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, callsBeforeReset);
	await host.emit("before_agent_start", {});
	assert.deepEqual(host.getActiveTools(), ["subagent_create", "extension-tool", "late-session-tool"]);
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, callsBeforeReset + 1);
	const callsAfterReset = host.activeToolCalls.filter(call => call.method === "setActiveTools").length;
	await host.emit("before_agent_start", {});
	assert.equal(host.activeToolCalls.filter(call => call.method === "setActiveTools").length, callsAfterReset);
});

test("management tools excluded from the host allowlist stay inactive", async t => {
	const fake = createFakePi({ events: [assistantMessageEnd("done")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension, fake.cwd);
	const managementTools = ["subagent_continue", "subagent_remove", "subagent_list"];
	host.excludeTools(managementTools);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("allowlist fixture", host.ctx));
	assert.deepEqual(host.getActiveTools(), ["subagent_create"]);
	await waitFor(() => host.sentMessages[0], "allowlisted subagent to settle");
	await host.commands.get("subclear").handler("", host.ctx);
	assert.deepEqual(host.getActiveTools(), ["subagent_create"]);
});
