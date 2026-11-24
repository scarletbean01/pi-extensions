import assert from "node:assert/strict";
import { startViewer } from "../../factory/viewer/server.ts";
import { createExecRecorder } from "./factory-viewer-fixture.ts";

interface ChildViewerRequest {
	statePath: string;
	coordinationPath: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	paths: string[];
}

const input = JSON.parse(process.argv[2]) as ChildViewerRequest;
const recorder = createExecRecorder();
const viewer = await startViewer({
	statePath: input.statePath,
	coordinationPath: input.coordinationPath,
	env: input.env,
	home: input.home,
	exec: recorder.exec,
});

const responses: Array<{ path: string; status: number; text: string }> = [];
try {
	for (const path of input.paths) {
		const res = await fetch(`${viewer.url}${path}`);
		const text = await res.text();
		responses.push({ path, status: res.status, text });
	}
} finally {
	await viewer.close();
	assert.equal(viewer.server.listening, false, "Expected viewer server to stop listening after close");
}

recorder.assertNoCalls();
process.stdout.write(JSON.stringify({ responses }));
