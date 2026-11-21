import assert from "node:assert/strict";
import { readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type ClearanceDecision } from "../factory/operations.ts";
import { createFactoryQueueScheduler } from "../factory/scheduler.ts";
import { buildInputRow } from "./factory-records.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";

async function fixture(t: test.TestContext) {
	const f = serviceFixture(t, ["builder"]);
	const coordinationPath = join(f.root, "coord.sqlite");
	const open = (atLaunchCommit?: (phase: string) => void) => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath, ...(atLaunchCommit ? { atLaunchCommit } : {}) } as any);
	const factory = open()({ action: "publish", name: "clearance", draft: { topology: "graph", task: "Clearance fixture", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "Fixture only" }] as any }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(f.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "first", brief: "Fixture brief", authority });
	const run = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	return { ...f, open, factory, authority, run, dbPath: join(f.root, "factories.sqlite"), coordinationPath };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const inspect = (f: Fixture) => f.open()({ action: "inspect", factory_id: f.factory.factory_id });
const good: ClearanceDecision = { reason: "Operator stopped the host process", evidence: "ps shows no agent process; checkout unlocked", acknowledged_unknown_effects: true };
const clearRequest = (f: Fixture, confirm: (target: any) => Promise<ClearanceDecision | undefined> = async () => good) => ({ action: "clear_hold" as const, factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm });
const clear = (f: Fixture, confirm?: (target: any) => Promise<ClearanceDecision | undefined>) => f.open()(clearRequest(f, confirm));

function startWorker(t: test.TestContext, f: Fixture) {
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const file = readdirSync(dir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
	return workerFromConfig(t, join(dir, file), { model: { provider: "test-provider", id: "test-model" } });
}

/** A finished run whose input record was damaged: execution looks settled, but evidence contradicts it, so the hold is uncertain. */
async function uncertainHold(t: test.TestContext) {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "failure", summary: "Broke", detail: "no" });
	const db = new DatabaseSync(f.dbPath);
	const row = db.prepare("SELECT * FROM factory_inputs").get() as any;
	const next = buildInputRow({ ...row, disposition: "blocked" });
	db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, row.input_id);
	db.close();
	return f;
}

test("inspection names both holds, what is contradictory, and the exact action and consequences", async t => {
	const f = await uncertainHold(t);
	const view = inspect(f);
	assert.equal(view.capacity.factory_slot, "uncertain");
	assert.equal(view.capacity.checkout_slot, "uncertain");
	const eligibility = view.attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, true, eligibility.reason);
	assert.equal(typeof eligibility.holds.factory_held_at, "string");
	assert.equal(typeof eligibility.holds.checkout_held_at, "string");
	assert.match(eligibility.missing_or_contradictory.join(";"), /disposition is "blocked"/);
	assert.match(eligibility.action, /release both/i);
	assert.match(eligibility.consequences, /not resolved/i);
	assert.match(eligibility.consequences, /new submission/i);
	assert.equal(view.attempts[0].clearance, undefined);
});

test("an agent-supplied flag cannot confirm, and the human must give reason, evidence and acknowledgement", async t => {
	const f = await uncertainHold(t);
	await assert.rejects(() => f.open()({ ...clearRequest(f), confirm: undefined, confirmed: true } as any), /direct human confirmation/);
	for (const bad of [{ ...good, reason: " " }, { ...good, evidence: "" }, { ...good, acknowledged_unknown_effects: false }, { reason: "r", evidence: "e" }]) {
		await assert.rejects(() => clear(f, async () => bad as any), /reason, supporting evidence.*acknowledgement/i);
	}
	let shown: any;
	const declined = await clear(f, async target => { shown = target; return undefined; });
	assert.equal(declined.cleared, false);
	assert.equal(shown.task_id, f.run.task_id);
	assert.equal(typeof shown.holds.factory_held_at, "string");
	assert.match(shown.missing_or_contradictory.join(";"), /blocked/);
	assert.equal(inspect(f).capacity.factory_slot, "uncertain", "nothing changed");
});

test("clearance releases both holds, retires the input and keeps every prior record without launching anything", async t => {
	const f = await uncertainHold(t);
	const result = await clear(f);
	assert.equal(result.cleared, true);
	const after = inspect(f);
	assert.equal(after.capacity.factory_slot, "free");
	assert.equal(after.capacity.checkout_slot, "free");
	assert.deepEqual(after.uncertainty, []);
	const attempt = after.attempts[0];
	assert.equal(attempt.state, "cleared");
	assert.equal(attempt.clearance?.reason, good.reason);
	assert.equal(attempt.clearance?.evidence, good.evidence);
	assert.equal(attempt.clearance?.acknowledged_unknown_effects, true);
	assert.equal(attempt.clearance?.prior_input_disposition, "blocked", "the contradictory source record is preserved");
	assert.match(attempt.clearance!.missing_or_contradictory.join(";"), /blocked/);
	assert.equal(attempt.settlement?.outcome, "failed", "the original outcome is not rewritten");
	assert.equal(attempt.settlement?.capacity_release, "released");
	assert.notEqual(attempt.settlement?.execution_settlement.state, "settled", "clearance is shown apart from execution settlement");
	assert.equal(after.queue[0].disposition, "cleared");
	assert.equal(after.attempts.length, 1, "nothing was launched on its behalf");
	assert.equal(after.head_status.blocking_kind, "empty");
	assert.equal(f.service.status(f.run.task_id).manifest.status, "applied", "run evidence is retained");
	assert.equal(attempt.clearance_eligibility, undefined);
	await assert.rejects(() => f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority }), /No queued input/i);
	assert.equal((await f.open()({ action: "settle_run", factory_id: f.factory.factory_id, authority: f.authority })).settled, false);
	await assert.rejects(() => clear(f), /not the run that holds/);
});

test("intentional repetition needs a new submission; an identical retry returns the cleared receipt", async t => {
	const f = await uncertainHold(t);
	await clear(f);
	const retry = f.open()({ action: "submit", factory_id: f.factory.factory_id, reference: "first", brief: "Fixture brief", authority: f.authority });
	assert.equal(retry.input_id, f.run.input_id);
	assert.equal(retry.disposition, "cleared");
	assert.equal(inspect(f).attempts.length, 1);
	f.open()({ action: "submit", factory_id: f.factory.factory_id, reference: "second", brief: "Fixture brief", authority: f.authority });
	const next = await f.open()({ action: "launch", factory_id: f.factory.factory_id, authority: f.authority });
	assert.notEqual(next.task_id, f.run.task_id);
	assert.notEqual(next.input_id, f.run.input_id);
	const view = inspect(f);
	assert.deepEqual(view.uncertainty, []);
	assert.deepEqual(view.attempts.map(item => item.state).sort(), ["cleared", "released"]);
	assert.equal(view.queue.find(item => item.input_id === f.run.input_id)!.disposition, "cleared");
});

test("automatic scheduling waits on uncertainty and advances to the next input after clearance", async t => {
	const f = await uncertainHold(t);
	const factory_id = f.factory.factory_id;
	const waiting = f.open()({ action: "submit", factory_id, authority: f.authority, reference: "next", brief: "Next brief" });
	const launched: string[] = [];
	const scheduler = createFactoryQueueScheduler({ factory: f.open(), factoryId: factory_id, authority: f.authority, onLaunch: result => { launched.push(result.input_id); } });
	await scheduler.advance();
	assert.equal(inspect(f).capacity.factory_slot, "uncertain");
	assert.deepEqual(launched, []);
	assert.equal((await clear(f)).cleared, true);
	await scheduler.advance();
	assert.deepEqual(launched, [waiting.input_id]);
	assert.equal(inspect(f).queue[0].disposition, "cleared");
});

test("a worker woken on a cleared run is refused", async t => {
	const f = await uncertainHold(t);
	await clear(f);
	const late = startWorker(t, f);
	await late.start();
	assert.ok(late.shutdowns >= 1);
});

test("a live attempt cannot be cleared, confirmation notwithstanding", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, false);
	assert.match(eligibility.reason, /may still resume/);
	let asked = false;
	await assert.rejects(() => clear(f, async () => { asked = true; return good; }), /Clearance refused/);
	assert.equal(asked, false, "a refused target never reaches the human dialog");
	assert.equal(inspect(f).capacity.factory_slot, "held");
	// Cancellation intent alone does not change that.
	await f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
	await assert.rejects(() => clear(f), /Clearance refused/);
	assert.equal(inspect(f).capacity.checkout_slot, "held");
});

test("a cancelled run whose worker never acknowledged is the uncertain hold an operator may clear", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
	worker.vanish();
	const before = inspect(f);
	assert.equal(before.attempts[0].settlement?.cancellation.intent, "requested");
	assert.equal(before.attempts[0].clearance_eligibility?.eligible, true, before.attempts[0].clearance_eligibility?.reason);
	assert.match(before.attention.map(item => item.reason).join(";"), /operator clearance is available/);
	assert.equal((await clear(f)).cleared, true);
	const after = inspect(f);
	assert.equal(after.attempts[0].settlement?.cancellation.intent, "requested", "cancellation intent is kept");
	assert.equal(after.attempts[0].settlement?.execution_settlement.state, "unknown", "execution is not declared settled");
	assert.equal(after.capacity.checkout_slot, "free");
});

test("suspected detached work is not cleared", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const instance = f.service.status(f.run.task_id).agents[0].instance_id;
	writeFileSync(join(dir, `${instance}.detached.json`), JSON.stringify({ task_id: f.run.task_id, reason: "reload", detached_at: new Date().toISOString() }));
	await assert.rejects(() => clear(f), /detached/);
	assert.equal(inspect(f).capacity.factory_slot, "held");
});

test("a consistent, reliably settled run is settled, not cleared", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await worker.complete({ status: "success", summary: "Done", detail: "ok" });
	await assert.rejects(() => clear(f), /not uncertain, so settle/);
});

test("authority and eligibility are rechecked after the dialog and at commit", async t => {
	const f = await uncertainHold(t);
	await assert.rejects(() => clear(f, async () => { revokeManagerAuthority(f.authority); return good; }), /authority|closed|replaced/i);
	assert.equal(inspect(f).capacity.factory_slot, "uncertain");
	const g = await uncertainHold(t);
	// A hold that changed while the human was deciding is a different target.
	await assert.rejects(() => clear(g, async () => {
		const db = new DatabaseSync(g.dbPath);
		db.prepare("UPDATE factory_holds SET held_at = '2000-01-01T00:00:00.000Z'").run();
		db.close();
		return good;
	}), /corruption|changed|mismatch/i);
	assert.throws(() => inspect(g), /corruption/, "damaged hold evidence fails closed and nothing was cleared");
	const h = await uncertainHold(t);
	const other = createManagerAuthority({ pi_session_id: "other", pi_session_file: join(h.root, "other.jsonl") });
	await assert.rejects(() => h.open()({ ...clearRequest(h), authority: other }), /authority/i);
});

test("a crash before the clearance commit leaves both holds, and a retry clears once", async t => {
	const f = await uncertainHold(t);
	const crashing = f.open(phase => { if (phase === "clear_before_commit") throw new Error("crash"); });
	await assert.rejects(() => crashing(clearRequest(f)), /crash/);
	const held = inspect(f);
	assert.equal(held.capacity.factory_slot, "uncertain");
	assert.equal(held.attempts[0].state, "released");
	assert.equal((await clear(f)).cleared, true);
	assert.equal(inspect(f).capacity.checkout_slot, "free");
});

test("a lost acknowledgement after the clearance commit leaves it cleared, and reopening shows it", async t => {
	const f = await uncertainHold(t);
	const crashing = f.open(phase => { if (phase === "clear_after_commit") throw new Error("lost ack"); });
	await assert.rejects(() => crashing(clearRequest(f)), /lost ack/);
	const view = inspect(f);
	assert.equal(view.capacity.factory_slot, "free");
	assert.equal(view.attempts[0].clearance?.reason, good.reason);
	await assert.rejects(() => clear(f), /not the run that holds/);
});

test("a malformed stored clearance record is reported as damaged, never shown as authoritative", async t => {
	const f = await uncertainHold(t);
	await clear(f);
	const { buildAttemptRow } = await import("./factory-records.ts");
	const db = new DatabaseSync(f.dbPath);
	const row = db.prepare("SELECT * FROM factory_attempts").get() as any;
	const forged = buildAttemptRow({ ...row, error: 'clearance:{"reason":"x"}' });
	db.prepare("UPDATE factory_attempts SET error = ?, record_digest = ? WHERE attempt_id = ?").run(forged.error, forged.record_digest, row.attempt_id);
	db.close();
	const view = inspect(f);
	assert.equal(view.attempts[0].clearance, undefined);
	assert.match(view.uncertainty.join(";"), /no readable clearance record/);
});

test("the /factory clear command needs an interactive UI and exact arguments", async () => {
	const { default: registerBootstrap } = await import("../bootstrap.ts");
	const commands = new Map<string, { handler: Function }>();
	registerBootstrap({ registerTool: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as any);
	const notes: string[] = [];
	const ctx = { hasUI: false, cwd: process.cwd(), ui: { notify: (message: string) => notes.push(message), confirm: async () => true, input: async () => "x" }, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const run = async (args: string) => { notes.length = 0; await commands.get("factory")!.handler(args, ctx); return notes.join("\n"); };
	assert.match(await run("clear"), /Usage: \/factory clear/);
	assert.match(await run("clear factory-x"), /requires an interactive Pi session with a UI/);
});

async function cancelled(t: test.TestContext) {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	await f.open()({ action: "cancel_run", factory_id: f.factory.factory_id, input_id: f.run.input_id, attempt_id: f.run.attempt_id, task_id: f.run.task_id, authority: f.authority, confirm: async () => true });
	return { f, worker };
}

test("after cancellation a closed pane does not make a live worker clearable", async t => {
	const { f } = await cancelled(t);
	const manifest: any = (f.service as any).store.load(f.run.task_id, f.cwd);
	manifest.pane_manifest = manifest.pane_manifest.map((entry: any) => ({ ...entry, status: "closed" }));
	(f.service as any).store.save(manifest);
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, false);
	assert.match(eligibility.reason, /live worker process/);
	await assert.rejects(() => clear(f), /Clearance refused/);
});

test("after cancellation an unreadable heartbeat does not make a live worker clearable", async t => {
	const { f } = await cancelled(t);
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	rmSync(join(dir, `${f.service.status(f.run.task_id).agents[0].instance_id}.progress.json`), { force: true });
	assert.equal(inspect(f).attempts[0].clearance_eligibility?.eligible, false);
	await assert.rejects(() => clear(f), /Clearance refused/);
});

test("a crashed worker with no cancellation is clearable as missing evidence, without cancelling first", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, true, eligibility.reason);
	assert.deepEqual(eligibility.resume_risk, []);
	assert.equal((await clear(f)).cleared, true);
	assert.equal(inspect(f).capacity.checkout_slot, "free");
});

test("an attempt whose release is not durably fenced is refused with the fencing reason", async t => {
	const f = serviceFixture(t, ["builder"]);
	const coordinationPath = join(f.root, "coord.sqlite");
	const crashing = factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath, atLaunchCommit: (phase: string) => { if (phase === "release_before_commit") throw new Error("crash"); } } as any);
	const factory = crashing({ action: "publish", name: "unfenced", draft: { topology: "graph", task: "x", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "x" }] as any }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(f.root, "manager.jsonl") });
	crashing({ action: "resume", factory_id: factory.factory_id, authority });
	crashing({ action: "submit", factory_id: factory.factory_id, reference: "first", brief: "b", authority });
	await assert.rejects(() => crashing({ action: "launch", factory_id: factory.factory_id, authority }), /crash/);
	const view = crashing({ action: "inspect", factory_id: factory.factory_id });
	const attempt = view.attempts.find(item => !item.historical)!;
	assert.equal(attempt.release_authorized, false);
	assert.equal(attempt.clearance_eligibility?.eligible, false);
	await assert.rejects(() => crashing({ action: "clear_hold", factory_id: factory.factory_id, input_id: attempt.input_id, attempt_id: attempt.attempt_id, task_id: attempt.task_id, authority, confirm: async () => good }), /not durably fenced/);
});

test("clearance keeps the contradictory source rows inside its record", async t => {
	const f = await uncertainHold(t);
	await clear(f);
	const record = inspect(f).attempts[0].clearance!;
	assert.equal(record.source_records.input.disposition, "blocked");
	assert.equal(record.source_records.input.reference, "first");
	assert.equal(record.source_records.managed_run?.task_id, f.run.task_id);
	assert.equal(record.source_records.factory_hold.attempt_id, f.run.attempt_id);
	assert.equal(record.source_records.checkout_hold.attempt_id, f.run.attempt_id);
});

test("a run that becomes reliably settled while the human decides is settled, not cleared", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	await assert.rejects(() => clear(f, async () => {
		// Consistent evidence arrives during the dialog: the worker's own result.
		const late = startWorker(t, f);
		await late.start();
		await late.beforeStart();
		await late.complete({ status: "success", summary: "Done", detail: "ok" });
		return good;
	}), /Clearance refused|changed|settle/);
	assert.equal(inspect(f).attempts[0].state, "released");
});

test("a node whose liveness cannot be determined is listed for the human to verify, not treated as resume risk", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	const dir = join(f.cwd, ".pi", "agent-sessions", f.run.task_id);
	const instance = f.service.status(f.run.task_id).agents[0].instance_id;
	rmSync(join(dir, `${instance}.ready.json`), { force: true });
	rmSync(join(dir, `${instance}.progress.json`), { force: true });
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, true, eligibility.reason);
	assert.deepEqual(eligibility.resume_risk, []);
	assert.match(eligibility.missing_or_contradictory.join(";"), /liveness cannot be determined/);
	assert.match(eligibility.consequences, /VERIFY FIRST/);
	let shown: any;
	assert.equal((await clear(f, async target => { shown = target; return good; })).cleared, true);
	assert.match(shown.missing_or_contradictory.join(";"), /verify that its process is not running/);
});

test("a run whose session folder was deleted is clearable: evidence already unreadable at the dialog is accepted", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	renameSync(join(f.cwd, ".pi", "agent-sessions", f.run.task_id), join(f.cwd, ".pi", "agent-sessions", `${f.run.task_id}.gone`));
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, true, eligibility.reason);
	const result = await clear(f);
	assert.equal(result.cleared, true);
	assert.match(result.clearance!.missing_or_contradictory.join(";"), /unreadable|no longer present|missing/i);
	assert.equal(inspect(f).capacity.checkout_slot, "free");
});

test("a corrupt cleanup policy does not hide a live worker: the hold is refused", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	writeFileSync(join(f.cwd, ".pi", "agent-sessions", f.run.task_id, "cleanup-policy.json"), "{garbage");
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, false);
	assert.match(eligibility.resume_risk.join(";"), /live worker process/);
	await assert.rejects(() => clear(f), /may still resume/);
	assert.equal(inspect(f).capacity.checkout_slot, "uncertain");
});

test("a corrupt cleanup policy with an exited worker is clearable, with unreadable evidence accepted", async t => {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	writeFileSync(join(f.cwd, ".pi", "agent-sessions", f.run.task_id, "cleanup-policy.json"), "{garbage");
	const eligibility = inspect(f).attempts[0].clearance_eligibility!;
	assert.equal(eligibility.eligible, true, eligibility.reason);
	assert.equal((await clear(f)).cleared, true);
});

test("clearing closes the attempt's open direction requests", async t => {
	const choices = [{ choice_id: "proceed", label: "P" }, { choice_id: "stop", label: "S" }];
	const f = serviceFixture(t, ["builder"]);
	const coordinationPath = join(f.root, "coord.sqlite");
	const open = () => factoryOperations(join(f.root, "factories.sqlite"), f.service, { coordinationPath } as any);
	const factory = open()({ action: "publish", name: "asks", draft: { topology: "graph", task: "x", project_cwd: f.cwd, agents: [{ node_id: "build", persona: "builder", sub_task: "x", intervention: { choices } }] as any }, sessionModel: { provider: "test-provider", id: "test-model", thinkingLevel: "medium" } });
	const authority = createManagerAuthority({ pi_session_id: "manager", pi_session_file: join(f.root, "manager.jsonl") });
	open()({ action: "resume", factory_id: factory.factory_id, authority });
	open()({ action: "submit", factory_id: factory.factory_id, reference: "first", brief: "b", authority });
	const run = await open()({ action: "launch", factory_id: factory.factory_id, authority });
	const dir = join(f.cwd, ".pi", "agent-sessions", run.task_id);
	const worker = workerFromConfig(t, join(dir, readdirSync(dir).find(n => n.endsWith(".config.json") && n.includes("build"))!), { model: { provider: "test-provider", id: "test-model" } });
	await worker.start();
	await worker.beforeStart();
	const ac = new AbortController();
	const asked = worker.requestDirection({ question: "Which?", reason: "r", evidence: ["a"], choices: ["proceed", "stop"], recommendation: { choice_id: "proceed", rationale: "x" } } as any, ac.signal).catch(() => undefined);
	let pending: any;
	for (let i = 0; i < 100 && !pending; i++) { pending = (open()({ action: "requests", factory_id: factory.factory_id } as any) as any[]).find(r => r.state === "pending"); await new Promise(r => setTimeout(r, 20)); }
	assert.ok(pending, "a request is pending");
	worker.vanish();
	ac.abort();
	await asked;
	const cleared = await open()({ action: "clear_hold", factory_id: factory.factory_id, input_id: run.input_id, attempt_id: run.attempt_id, task_id: run.task_id, authority, confirm: async () => good } as any);
	assert.equal(cleared.cleared, true);
	assert.deepEqual((open()({ action: "requests", factory_id: factory.factory_id } as any) as any[]).map(r => r.state), ["closed"]);
	assert.throws(() => open()({ action: "respond_request", factory_id: factory.factory_id, request_id: pending.request_id, response: { kind: "choice", choice_id: "proceed" }, authority } as any));
});

/** Operations whose settlement observation is scripted per call: inspection before and after the dialog, then the in-transaction call. */
async function scripted(t: test.TestContext, third: (real: any) => any) {
	const f = await fixture(t);
	const worker = startWorker(t, f);
	await worker.start();
	await worker.beforeStart();
	worker.vanish();
	let calls = 0;
	const service: any = Object.create(f.service);
	service.settlementObservations = (taskId: string, cwd?: string) => {
		calls++;
		const real = (f.service as any).settlementObservations(taskId, cwd);
		return calls >= 3 ? third(real) : real;
	};
	const ops = factoryOperations(f.dbPath, service, { coordinationPath: f.coordinationPath } as any);
	return { f, ops, calls: () => calls };
}

test("the commit transaction recomputes eligibility: a run reliably settled at commit is settled, not cleared", async t => {
	const { f, ops, calls } = await scripted(t, real => ({ ...real, execution_settlement: { state: "settled", reason: "settled at commit" }, resume_risk: [] }));
	await assert.rejects(() => ops(clearRequest(f)), /settle the run instead/);
	assert.ok(calls() >= 3, "the in-transaction observation was the one that refused");
	assert.equal(inspect(f).attempts[0].state, "released");
});

test("the commit transaction fails closed when the run cannot be observed", async t => {
	const { f, ops } = await scripted(t, () => { throw new Error("evidence vanished"); });
	await assert.rejects(() => ops(clearRequest(f)), /could not be observed at commit/);
	assert.equal(inspect(f).attempts[0].state, "released");
});

test("the commit transaction refuses work that appears to resume at commit", async t => {
	const { f, ops } = await scripted(t, real => ({ ...real, resume_risk: ["build is live again"] }));
	await assert.rejects(() => ops(clearRequest(f)), /may still resume/);
});
