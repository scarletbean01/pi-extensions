import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryOperations } from "../../factory/operations.ts";
import { BootstrapService, type GenerateRequest } from "../lifecycle.ts";

const [database, draftPath, name, phase] = process.argv.slice(2);
if (!database || !draftPath || !name || (phase !== "before_commit" && phase !== "after_commit")) {
	throw new Error("usage: factory-publish-child <database> <draft.json> <name> <before_commit|after_commit>");
}
const draft = JSON.parse(readFileSync(draftPath, "utf8")) as GenerateRequest;
const bootstrap = new BootstrapService({
	exec: async () => ({ stdout: "", stderr: "", code: 1 }),
	extensionDir: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
	home: process.env.HOME,
	env: process.env,
});
factoryOperations(database, bootstrap, reached => {
	if (reached !== phase) return;
	process.kill(process.pid, "SIGKILL");
})({ action: "publish", name, draft, sessionModel: { provider: "test", id: "model", thinkingLevel: "medium" } });
