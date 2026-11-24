import assert from "node:assert/strict";
import { createViewerReader, startViewer } from "../../factory/viewer/server.ts";
import { createExecRecorder, probeReaderExec } from "./factory-viewer-fixture.ts";

interface ChildViewerRequest {
	statePath: string;
	coordinationPath: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	paths: string[];
	probeExec?: boolean;
}

const input = JSON.parse(process.argv[2]) as ChildViewerRequest;
const recorder = createExecRecorder();
let pendingProbe: Promise<unknown> | undefined;
const viewer = await startViewer(
	{
		statePath: input.statePath,
		coordinationPath: input.coordinationPath,
		env: input.env,
		home: input.home,
		exec: recorder.exec,
	},
	input.probeExec
		? {
				createReader: readerOpts => {
					const reader = createViewerReader(readerOpts);
					pendingProbe = probeReaderExec(reader, ["api", "snapshot"]).catch(() => {});
					return reader;
				},
			}
		: undefined,
);

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

if (pendingProbe) await pendingProbe;
recorder.assertNoCalls();
process.stdout.write(JSON.stringify({ responses }));
