import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type ClearanceDecision } from "../factory/operations.ts";
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
