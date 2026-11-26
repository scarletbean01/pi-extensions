/**
 * Child process for cross-process pane wake-up contention tests.
 * argv: <sessionDir> <destinationAttempt> <handoffId> <startAtEpochMs>
 */
import { tryPaneWake } from "../pane-wake.ts";

const [sessionDir, destinationAttempt, handoffId, startAt] = process.argv.slice(2);
const targetMs = Number(startAt ?? "0");
while (Date.now() < targetMs) { /* align contenders to maximize race window */ }

const result = await tryPaneWake({
	sessionDir,
	destinationAttempt,
	handoffId,
});
console.log(JSON.stringify(result));
