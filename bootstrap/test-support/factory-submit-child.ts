import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations } from "../../factory/operations.ts";
import { BootstrapService } from "../lifecycle.ts";

const [mode, database, factoryId, ...rest] = process.argv.slice(2);
if (!mode || !database || !factoryId) {
	throw new Error("usage: factory-submit-child <resume|race-resume|submit|receipt> <database> <factoryId> ...");
}

const bootstrap = new BootstrapService({
	exec: async () => ({ stdout: "", stderr: "", code: 1 }),
	extensionDir: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
	home: process.env.HOME,
	env: process.env,
});

function withKillPhase(phase: string | undefined) {
	return phase === "before_commit" || phase === "after_commit"
		? (reached: "before_commit" | "after_commit") => {
			if (reached === phase) process.kill(process.pid, "SIGKILL");
		}
		: undefined;
}

if (mode === "resume") {
	const [phase] = rest;
	const auth = createManagerAuthority({ pi_session_id: `child-${process.pid}` });
	const res = factoryOperations(database, bootstrap, withKillPhase(phase))({
		action: "resume",
		factory_id: factoryId,
		authority: auth,
	});
	process.stdout.write(JSON.stringify(res));
} else if (mode === "race-resume") {
	const [readyFile, goFile] = rest;
	if (!readyFile || !goFile) throw new Error("race-resume requires <readyFile> <goFile>");
	const auth = createManagerAuthority({ pi_session_id: `race-${process.pid}` });
	writeFileSync(readyFile, String(process.pid));
	while (!existsSync(goFile)) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	const res = factoryOperations(database, bootstrap)({
		action: "resume",
		factory_id: factoryId,
		authority: auth,
	});
	process.stdout.write(JSON.stringify(res));
} else if (mode === "submit") {
	const [reference, briefFile, phase, resumeFirst] = rest;
	if (!reference || !briefFile) throw new Error("submit requires <reference> <briefFile> [phase] [resumeFirst]");
	const brief = readFileSync(briefFile, "utf8");
	const auth = createManagerAuthority({ pi_session_id: `submit-${process.pid}` });
	const op = factoryOperations(database, bootstrap, withKillPhase(phase));
	if (resumeFirst === "resume_first") {
		factoryOperations(database, bootstrap)({ action: "resume", factory_id: factoryId, authority: auth });
	}
	const receipt = op({
		action: "submit",
		factory_id: factoryId,
		reference,
		brief,
		authority: auth,
	});
	process.stdout.write(JSON.stringify(receipt));
} else if (mode === "receipt") {
	const [reference] = rest;
	if (!reference) throw new Error("receipt requires <reference>");
	const receipt = factoryOperations(database, bootstrap)({
		action: "receipt",
		factory_id: factoryId,
		reference,
	});
	process.stdout.write(JSON.stringify(receipt));
} else {
	throw new Error(`Unknown mode: ${mode}`);
}
