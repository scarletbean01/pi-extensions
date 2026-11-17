/**
 * Child process for handoff race tests: one destination worker process receiving one notification. It evaluates the handoff against the durable
 * records and, if nothing refuses it, claims it, then reports what it got.
 * argv: <worker config path> <notification file> <sender session> <startAtEpochMs>
 */
import { readFileSync } from "node:fs";
import { claimHandoff, evaluateHandoff } from "../handoff.ts";
import { parseCompletion, parseWorkerConfig, readJson, resultPath, type WorkerConfig } from "../session-store.ts";

const [configPath, notificationPath, sender, startAt] = process.argv.slice(2);
const config: WorkerConfig = parseWorkerConfig(readJson<unknown>(configPath));
const content = readFileSync(notificationPath, "utf8");
while (Date.now() < Number(startAt)) { /* align contenders to maximize the race window */ }
const decision = evaluateHandoff({ config, expectedSession: sender, senderSession: sender, content, loadPredecessor: () => parseCompletion(readJson<unknown>(resultPath(config.session_dir, config.predecessor!)), { run_id: config.task_id, instance_id: config.predecessor! }) });
if (decision.outcome === "proceed") {
	const claimed = claimHandoff(config, decision, sender);
	console.log(JSON.stringify({ pid: process.pid, outcome: claimed.outcome, claim: claimed.claim }));
} else console.log(JSON.stringify({ pid: process.pid, outcome: decision.outcome }));
