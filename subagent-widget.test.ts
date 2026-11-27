/**
 * Run with: timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts
 * These tests cross the extension entry point; Pi packages are stubbed, while the extension and fake executable are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createFakeHost, createFakePi, getOption, loadSubagentWidget, waitFor, withFakePiEnvironment } from "./subagent-widget.test-helpers.ts";

const textEvent = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const toolEvent = { type: "tool_execution_start", toolName: "read" };

test("/sub launches the fake pi and delivers streamed result after normal exit", async t => {
	const fake = createFakePi({ events: [textEvent("first "), toolEvent, textEvent("answer")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("summarize the fixture", host.ctx));
	const sent = await waitFor(() => host.sentMessages[0], "normal result message");
	const invocation = await waitFor(() => fake.invocations()[0], "fake pi invocation");
	assert.equal(invocation.cwd, process.cwd());
	assert.equal(invocation.env.SUBAGENT_TEST_MARKER, "preserved-env-value");
	assert.equal(invocation.env.HOME, fake.home);
	assert.equal(invocation.argv.at(-1), "summarize the fixture");
	assert.equal(getOption(invocation.argv, "--session")?.startsWith(fake.sessionsDir), true);
	assert.ok(existsSync(fake.sessionsDir), "the session directory is redirected under the temporary HOME");
	assert.equal(sent.message.customType, "subagent-result");
	assert.match(sent.message.content, /Result:\nfirst answer/);
	assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
});

test("subagent_create launches the fake pi and includes stderr and streamed text on an error exit", async t => {
	const fake = createFakePi({ events: [textEvent("partial result")], stderr: "fake failure detail\n", exitCode: 7 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension);
	const create = host.tools.get("subagent_create");
	const launch = await withFakePiEnvironment(fake, () => create.execute("call-1", { task: "inspect failing task", thinking: "high" }, undefined, undefined, host.ctx));
	assert.match(launch.content[0].text, /Subagent #1 spawned/);
	const sent = await waitFor(() => host.sentMessages[0], "error result message");
	const invocation = (await waitFor(() => fake.invocations()[0], "fake pi invocation"));
	assert.equal(invocation.argv.at(-1), "inspect failing task");
	assert.equal(sent.message.customType, "subagent-result");
	// PINS-CURRENT-BEHAVIOUR: failures deliver stderr together with already-streamed text; a later ticket makes stderr failure-only.
	assert.match(sent.message.content, /Result:\npartial resultfake failure detail/);
	assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
});

test("/subcont starts another turn with the original session file", async t => {
	const fake = createFakePi({ events: [textEvent("turn result")] });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("initial task", host.ctx));
	await waitFor(() => host.sentMessages[0], "first turn completion");
	const first = await waitFor(() => fake.invocations()[0], "first invocation");
	await withFakePiEnvironment(fake, () => host.commands.get("subcont").handler("1 follow-up task", host.ctx));
	await waitFor(() => host.sentMessages[1], "continued turn completion");
	const second = await waitFor(() => fake.invocations()[1], "second invocation");
	assert.equal(first.argv.at(-1), "initial task");
	assert.equal(second.argv.at(-1), "follow-up task");
	assert.equal(getOption(second.argv, "--session"), getOption(first.argv, "--session"));
	// PINS-CURRENT-BEHAVIOUR: the continuation notification/result identifies turn 2 while reusing the first session path.
	assert.match(host.sentMessages[1].message.content, /\(Turn 2\)/);
});

test("/subrm kills a running subagent process", async t => {
	const fake = createFakePi({ events: [], delayMs: 30000 });
	t.after(() => fake.cleanup());
	const extension = await loadSubagentWidget();
	const host = createFakeHost(extension);
	await withFakePiEnvironment(fake, () => host.commands.get("sub").handler("long running task", host.ctx));
	const invocation = await waitFor(() => fake.invocations()[0], "running fake pi invocation");
	await host.commands.get("subrm").handler("1", host.ctx);
	await waitFor(() => {
		try { process.kill(invocation.pid, 0); return undefined; } catch { return true; }
	}, "fake pi process to exit");
	assert.equal(host.widgets.has("sub-1"), false);
	assert.ok(host.notifications.some(item => item.message.includes("killed and removed")));
	// PINS-CURRENT-BEHAVIOUR: SIGTERM close currently sends a result and wakes the parent; cancellation ticket 06 changes this.
	await waitFor(() => host.sentMessages[0], "current SIGTERM completion message");
	assert.match(host.sentMessages[0].message.content, /Result:\n/);
});
