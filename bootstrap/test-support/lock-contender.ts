/**
 * Child process for lock tests. Acquires the run lock `rounds` times and reports any moment it found
 * the critical section already occupied (another process inside while it held the lock).
 * argv: <lockKey> <markerPath> <startAtEpochMs> <rounds> [crashAfterAcquire]
 */
import { rmSync, writeFileSync } from "node:fs";
import { withRunLock } from "../session-store.ts";

const [key, marker, startAt, rounds, crash] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* align contenders to maximize the stale-lock race window */ }
let violations = 0;
let entered = 0;
for (let i = 0; i < Number(rounds); i++) {
	await withRunLock(key, async () => {
		if (crash === "crash") process.kill(process.pid, "SIGKILL");
		try { writeFileSync(marker, String(process.pid), { flag: "wx" }); } catch { violations++; await new Promise(resolve => setTimeout(resolve, 5)); return; }
		entered++;
		await new Promise(resolve => setTimeout(resolve, 3 + Math.floor(Math.random() * 6)));
		rmSync(marker, { force: true });
	}, 60_000);
}
console.log(JSON.stringify({ pid: process.pid, violations, entered }));
