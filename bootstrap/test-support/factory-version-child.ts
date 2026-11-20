/**
 * Supervised child for factory publication/admission durability tests (ticket 04).
 * Usage: node factory-version-child.ts '<json>'
 *   { mode: "update" | "restore" | "submit", database, factoryId, draftPath?, fromVersion?, expectedCurrent?, reference?, brief?,
 *     killPhase?: "before_commit" | "after_commit", pause?: { readyFile, goFile } }
 * `pause` holds the open write transaction at `before_commit` (after all rows are written, before COMMIT) until `goFile` exists,
 * which gives the parent deterministic control over which durable commit happens first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations } from "../../factory/operations.ts";
import { BootstrapService, type GenerateRequest } from "../lifecycle.ts";

interface ChildConfig {
	mode: "update" | "restore" | "submit";
	database: string;
	factoryId: string;
	draftPath?: string;
	fromVersion?: string;
	expectedCurrent?: string;
	reference?: string;
	brief?: string;
	killPhase?: "before_commit" | "after_commit";
	pause?: { readyFile: string; goFile: string };
}

const input = JSON.parse(process.argv[2]) as ChildConfig;
const bootstrap = new BootstrapService({
	exec: async () => ({ stdout: "", stderr: "", code: 1 }),
	extensionDir: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
	home: process.env.HOME,
	env: process.env,
});

function waitForFile(path: string): void {
	const cell = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 20_000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		Atomics.wait(cell, 0, 0, 10);
	}
}

const boundary = (phase: "before_commit" | "after_commit") => {
	if (phase === "before_commit" && input.pause) {
		writeFileSync(input.pause.readyFile, String(process.pid));
		waitForFile(input.pause.goFile);
	}
	if (phase === input.killPhase) process.kill(process.pid, "SIGKILL");
};

const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
if (input.mode === "update") {
	const draft = JSON.parse(readFileSync(input.draftPath!, "utf8")) as GenerateRequest;
	const result = factoryOperations(input.database, bootstrap, boundary)({
		action: "update", factory_id: input.factoryId, draft, sessionModel,
		...(input.expectedCurrent ? { expected_current_version: input.expectedCurrent } : {}),
	});
	process.stdout.write(JSON.stringify(result));
} else if (input.mode === "restore") {
	const result = factoryOperations(input.database, bootstrap, boundary)({
		action: "restore", factory_id: input.factoryId, from_version: input.fromVersion!,
		...(input.expectedCurrent ? { expected_current_version: input.expectedCurrent } : {}),
	});
	process.stdout.write(JSON.stringify(result));
} else {
	const authority = createManagerAuthority({ pi_session_id: `version-child-${process.pid}` });
	factoryOperations(input.database, bootstrap)({ action: "resume", factory_id: input.factoryId, authority });
	const receipt = factoryOperations(input.database, bootstrap, boundary)({
		action: "submit", factory_id: input.factoryId, reference: input.reference!, brief: input.brief!, authority,
	});
	process.stdout.write(JSON.stringify(receipt));
}
