import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { createViewerReader, startViewer, type ViewerOptions, type ViewerReaderOptions, type ViewerServer } from "../factory/viewer/server.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";
import {
	createLiveFixtureAdvancer,
	createManualAcceptanceFixture,
	MAX_ADVANCE_LIVE_MS,
	parseManualFixtureArgs,
} from "./test-support/factory-viewer-manual-fixture.ts";
import {
	assertStateDirUnchanged,
	createExecRecorder,
	probeReaderExec,
	snapshotStateDir,
	verifyReadOnlyViewer,
	verifyReadOnlyViewerInChild,
	type VerifyReadOnlyViewerOptions,
} from "./test-support/factory-viewer-fixture.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "factory", "viewer", "cli.ts");

let root: string;
let server: Awaited<ReturnType<typeof startViewer>>;
let base: string;

function rawHttpGet(urlString: string, requestTarget: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	const parsed = new URL(urlString);
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			hostname: parsed.hostname,
			port: Number(parsed.port),
			method: "GET",
			path: requestTarget,
			headers,
		}, res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "factory-viewer-"));
	const dbPath = join(root, "factories.sqlite");
	const coordPath = join(root, "factory-coordination.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_1','Example','{}','digest');");
	db.close();
	server = await startViewer({ statePath: dbPath, coordinationPath: coordPath, host: "127.0.0.1", port: 0 });
	base = server.url;
});

after(async () => {
	await server?.close();
	if (root) rmSync(root, { recursive: true, force: true });
});

async function assertStartViewerRejects(options: ViewerOptions, pattern: RegExp): Promise<void> {
	let unexpected: ViewerServer | undefined;
	try {
		await assert.rejects(async () => {
			unexpected = await startViewer(options);
		}, pattern);
	} finally {
		await unexpected?.close();
	}
}

test("viewer binds only to 127.0.0.1 or ::1 loopback, formats IPv6 URLs, and rejects non-loopback or invalid ports", async t => {
	const dbPath = join(root, "factories.sqlite");
	const coordPath = join(root, "factory-coordination.sqlite");
	for (const badHost of ["0.0.0.0", "::", "localhost", "example.com", "192.168.1.10"]) {
		await assertStartViewerRejects({ statePath: dbPath, coordinationPath: coordPath, host: badHost, port: 0 }, /loopback/i);
	}
	for (const badPort of [Number.NaN, -1, 65536, 1.5]) {
		await assertStartViewerRejects({ statePath: dbPath, coordinationPath: coordPath, host: "127.0.0.1", port: badPort }, /port/i);
	}
	try {
		const ipv6 = await startViewer({ statePath: dbPath, coordinationPath: coordPath, host: "::1", port: 0 });
		try {
			const parsed = new URL(ipv6.url);
			assert.equal(parsed.hostname, "[::1]");
			const res = await fetch(`${ipv6.url}/api/factories`);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), { factories: [{ factory_id: "fac_1", name: "Example", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
		} finally {
			await ipv6.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw error;
	}
});

test("viewer is loopback-only, serves local pages and a projected factory list without writes", async () => {
	const dbPath = join(root, "factories.sqlite");
	const beforeBytes = readFileSync(dbPath);
	const response = await fetch(`${base}/api/factories`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { factories: [{ factory_id: "fac_1", name: "Example", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Factory Viewer/);
	assert.deepEqual(readFileSync(dbPath), beforeBytes);
	assert.equal(new URL(base).hostname, "127.0.0.1");
});

test("viewer rejects unsupported WAL stores and stray -wal/-shm sidecars without creating or changing sidecars", async t => {
	const walRoot = mkdtempSync(join(tmpdir(), "factory-viewer-wal-"));
	t.after(() => rmSync(walRoot, { recursive: true, force: true }));
	const dbPath = join(walRoot, "factories.sqlite");
	const coordPath = join(walRoot, "factory-coordination.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_wal','WAL','{}','digest'); PRAGMA journal_mode = WAL;");
	db.close();
	let walUrl = "";
	await verifyReadOnlyViewer({ stateDirs: walRoot, viewerOptions: { statePath: dbPath, coordinationPath: coordPath, host: "127.0.0.1", port: 0 } }, async walViewer => {
		walUrl = walViewer.url;
		const response = await fetch(`${walViewer.url}/api/factories`);
		assert.equal(response.status, 503);
	});
	await assert.rejects(() => fetch(`${walUrl}/api/factories`));

	// Rollback-mode database with a stray -wal or -shm sidecar must also fail closed with 503 and unchanged bytes.
	for (const suffix of ["-wal", "-shm"] as const) {
		const sidecarRoot = mkdtempSync(join(tmpdir(), `factory-viewer-sidecar${suffix}-`));
		t.after(() => rmSync(sidecarRoot, { recursive: true, force: true }));
		const sidecarDbPath = join(sidecarRoot, "factories.sqlite");
		const sidecarCoordPath = join(sidecarRoot, "factory-coordination.sqlite");
		const rollbackDb = new DatabaseSync(sidecarDbPath);
		rollbackDb.exec("PRAGMA journal_mode = DELETE; PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_rb','Rollback','{}','digest');");
		rollbackDb.close();
		writeFileSync(`${sidecarDbPath}${suffix}`, Buffer.from("stray-sidecar"));
		await verifyReadOnlyViewer(
			{ stateDirs: sidecarRoot, viewerOptions: { statePath: sidecarDbPath, coordinationPath: sidecarCoordPath, host: "127.0.0.1", port: 0 } },
			async viewer => {
				const res = await fetch(`${viewer.url}/api/factories`);
				assert.equal(res.status, 503);
				assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
			},
		);
	}
});

test("viewer rejects non-GET methods, non-loopback Host headers, bad request targets, and path traversal", async () => {
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
		const res = await fetch(`${base}/api/factories`, { method });
		assert.equal(res.status, 405, `expected 405 for ${method}`);
		assert.equal(res.headers.get("allow"), "GET");
	}
	const evilHost = await rawHttpGet(base, "/api/factories", { Host: "evil.com" });
	assert.equal(evilHost.status, 403);
	const protoRelative = await rawHttpGet(base, "//evil.com/api/factories");
	assert.equal(protoRelative.status, 400);
	const absoluteRemote = await rawHttpGet(base, "http://evil.com/api/factories");
	assert.equal(absoluteRemote.status, 400);
	const backslashPath = await rawHttpGet(base, "/..\\..\\etc\\passwd");
	assert.equal(backslashPath.status, 400);

	for (const badPath of [
		"/api/factories?path=/etc/passwd",
		"/api/factories?statePath=/etc/passwd",
		"/api/factories/fac_1/inspect?version=../../etc/passwd",
		"/api/factories/fac_1/inspect?version=v1%2f..%2f..",
		"/api/factories/fac_1/live?path=/etc/passwd",
		"/api/factories/fac_1/inspect?path=/etc/passwd",
		"/api/factories/fac_1/queue?path=/etc/passwd",
		"/api/factories/fac_1/receipts?path=/etc/passwd",
		"/api/factories/fac_1/requests?path=/etc/passwd",
		"/api/factories/fac_1/proposals?path=/etc/passwd",
		"/api/factories/fac_1/output?path=/etc/passwd",
		"/api/factories/fac_1/output",
		"/api/factories/fac_1/output?node=../bad",
	]) {
		assert.equal((await fetch(`${base}${badPath}`)).status, 400, `expected 400 for ${badPath}`);
	}

	for (const overLongPath of [
		`/api/factories/fac_1/receipts?reference=${"a".repeat(257)}`,
		`/api/factories/fac_1/inspect?version=v${"1".repeat(256)}`,
		`/api/factories/fac_1/queue?filter=${"a".repeat(257)}`,
		`/api/factories/fac_1/output?node=${"a".repeat(257)}`,
	]) {
		const res = await fetch(`${base}${overLongPath}`);
		assert.equal(res.status, 400, `expected 400 for over-long query value`);
		assert.deepEqual(await res.json(), { error: "Unsupported query parameter" });
	}

	for (const blockedPath of [
		"/../../../etc/passwd",
		"/..%2f..%2fetc%2fpasswd",
		"/assets/../server.ts",
		"/api/factories/not-a-factory/inspect",
		"/api/factories/%2e%2e/live",
		"/api/factories/..%2F..%2Fetc%2Fpasswd/inspect",
		"/api/factories/%252e%252e/inspect",
		"/api/factories/fac_1%00/inspect",
		"/api/factories/fac.1/inspect",
		`/api/factories/${"a".repeat(200)}/inspect`,
		"/api/factories/'%20OR%201=1%20--/inspect",
	]) {
		assert.equal((await rawHttpGet(base, blockedPath)).status, 404, `expected 404 for ${blockedPath}`);
	}
});

test("snapshot endpoints return named, fail-closed operator projections", async () => {
	const inspect = await fetch(`${base}/api/factories/fac_1/inspect`);
	assert.equal(inspect.status, 200);
	assert.deepEqual(await inspect.json(), {
		factory_id: "fac_1",
		evidence: "unavailable",
		absence: "evidence unavailable",
		explanation: "Factory inspection evidence is unavailable.",
	});
	const queue = await fetch(`${base}/api/factories/fac_1/queue?filter=open`);
	assert.equal(queue.status, 200);
	assert.deepEqual(await queue.json(), {
		factory_id: "fac_1",
		evidence: "unavailable",
		entries: [],
		absence: "evidence unavailable",
		explanation: "Queue evidence is unavailable.",
	});
	const receipt = await fetch(`${base}/api/factories/fac_1/receipts?reference=missing`);
	assert.equal(receipt.status, 404);
	const requests = await fetch(`${base}/api/factories/fac_1/requests`);
	assert.equal(requests.status, 200);
	const proposals = await fetch(`${base}/api/factories/fac_1/proposals`);
	assert.equal(proposals.status, 200);
	const proposalBody = await proposals.text();
	assert.match(proposalBody, /Proposals are not the active constraints file/);
	assert.doesNotMatch(proposalBody, /raw_prompt/);
});

test("reusable fixture snapshot helper verifies unchanged state and fails on byte or file mutations", async t => {
	const before = snapshotStateDir(root);
	await fetch(`${base}/api/factories`);
	await fetch(`${base}/api/factories/fac_1/inspect`);
	await fetch(`${base}/api/factories/fac_1/inspect?version=v1`);
	await fetch(`${base}/api/factories/fac_1/queue?filter=all`);
	await fetch(`${base}/api/factories/fac_1/receipts?reference=missing`);
	await fetch(`${base}/api/factories/fac_1/requests`);
	await fetch(`${base}/api/factories/fac_1/proposals`);
	assertStateDirUnchanged(root, before);

	// Negative probe: prove assertStateDirUnchanged catches 1-byte edits, added sidecars, and deletions.
	const probeDir = mkdtempSync(join(tmpdir(), "factory-viewer-snap-probe-"));
	t.after(() => rmSync(probeDir, { recursive: true, force: true }));
	const target = join(probeDir, "record.bin");
	writeFileSync(target, Buffer.from("abc"));
	const snap = snapshotStateDir(probeDir);
	writeFileSync(target, Buffer.from("abd"));
	assert.throws(() => assertStateDirUnchanged(probeDir, snap), /File bytes changed/);
	writeFileSync(target, Buffer.from("abc"));
	writeFileSync(join(probeDir, "record.bin-journal"), Buffer.from("j"));
	assert.throws(() => assertStateDirUnchanged(probeDir, snap), /changed structure/);
	rmSync(join(probeDir, "record.bin-journal"));
	rmSync(target);
	assert.throws(() => assertStateDirUnchanged(probeDir, snap), /changed structure/);
});

test("verifyReadOnlyViewer requires isolated coordinationPath under stateDirs and catches exec calls via positive control", async t => {
	const guardRoot = mkdtempSync(join(tmpdir(), "factory-viewer-guard-"));
	const outsideDir = mkdtempSync(join(tmpdir(), "factory-viewer-outside-"));
	t.after(() => {
		rmSync(guardRoot, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});
	const dbPath = join(guardRoot, "factories.sqlite");
	const coordPath = join(guardRoot, "factory-coordination.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT);");
	db.close();

	// Missing/empty coordinationPath must be rejected before starting the viewer.
	await assert.rejects(
		() => verifyReadOnlyViewer(
			{ stateDirs: guardRoot, viewerOptions: { statePath: dbPath, coordinationPath: "" } },
			async () => {},
		),
		/requires viewerOptions\.coordinationPath/,
	);
	await assert.rejects(
		() => verifyReadOnlyViewer(
			{ stateDirs: guardRoot, viewerOptions: { statePath: dbPath } as unknown as VerifyReadOnlyViewerOptions["viewerOptions"] },
			async () => {},
		),
		/requires viewerOptions\.coordinationPath/,
	);

	// coordinationPath outside snapshotted stateDirs must be rejected.
	await assert.rejects(
		() => verifyReadOnlyViewer(
			{ stateDirs: guardRoot, viewerOptions: { statePath: dbPath, coordinationPath: join(outsideDir, "factory-coordination.sqlite") } },
			async () => {},
		),
		/to lie under one of stateDirs/,
	);

	// coordinationPath equal to a stateDirs entry itself (not a file under it) must be rejected.
	await assert.rejects(
		() => verifyReadOnlyViewer(
			{ stateDirs: guardRoot, viewerOptions: { statePath: dbPath, coordinationPath: guardRoot } },
			async () => {},
		),
		/to lie under one of stateDirs/,
	);

	// Positive control (non-HTTP construction seam): an exec call through the viewer's BootstrapService
	// reaches the recorder and recorder.assertNoCalls() throws.
	{
		const recorder = createExecRecorder();
		const reader = createViewerReader({ statePath: dbPath, coordinationPath: coordPath, exec: recorder.exec });
		await assert.rejects(
			() => probeReaderExec(reader, ["api", "snapshot"]),
			/Viewer must not execute external commands/,
		);
		assert.throws(() => recorder.assertNoCalls(), /Expected no Herdr or external command calls/);
	}

	// Positive control (verifyReadOnlyViewer): helper wires recorder.exec into startViewer, startViewer
	// forwards options.exec to the reader it creates, an exec call through that reader's BootstrapService
	// reaches recorder.exec, and recorder.assertNoCalls() throws.
	{
		let handedExec: ViewerReaderOptions["exec"] | undefined;
		let receivedExec: ViewerReaderOptions["exec"] | undefined;
		await assert.rejects(
			() => verifyReadOnlyViewer(
				{
					stateDirs: guardRoot,
					viewerOptions: { statePath: dbPath, coordinationPath: coordPath },
					start: async opts => {
						handedExec = opts.exec;
						let capturedReader: ReturnType<typeof createViewerReader> | undefined;
						const viewer = await startViewer(opts, {
							createReader: readerOpts => {
								receivedExec = readerOpts.exec;
								capturedReader = createViewerReader(readerOpts);
								return capturedReader;
							},
						});
						assert.ok(capturedReader);
						await probeReaderExec(capturedReader, ["api", "snapshot"]).catch(() => {});
						return viewer;
					},
				},
				async () => {},
			),
			/Expected no Herdr or external command calls/,
		);
		assert.strictEqual(receivedExec, handedExec);
		assert.equal(typeof handedExec, "function");
	}

	// Positive control (verifyReadOnlyViewerInChild): a hanging child is SIGKILLed by the watchdog
	// and rejects with the clear non-regular file hang message.
	{
		const hangScript = join(guardRoot, "hang-child.ts");
		writeFileSync(hangScript, "setInterval(() => {}, 1000);\n");
		await assert.rejects(
			() => verifyReadOnlyViewerInChild({
				stateDirs: guardRoot,
				viewerOptions: { statePath: dbPath, coordinationPath: coordPath },
				paths: ["/api/factories"],
				timeoutMs: 150,
				childScript: hangScript,
			}),
			/viewer hung on non-regular file/,
		);
	}

	// Positive control (verifyReadOnlyViewerInChild): a child that mutates a state dir must be rejected.
	{
		const mutateScript = join(guardRoot, "mutate-child.ts");
		writeFileSync(
			mutateScript,
			`import { writeFileSync } from "node:fs";
import { join } from "node:path";
const req = JSON.parse(process.argv[2]);
writeFileSync(join(${JSON.stringify(guardRoot)}, "mutated-by-child.txt"), "dirty");
process.stdout.write(JSON.stringify({ responses: req.paths.map((path: string) => ({ path, status: 200, text: "{}" })) }));
`,
		);
		await assert.rejects(
			() => verifyReadOnlyViewerInChild({
				stateDirs: guardRoot,
				viewerOptions: { statePath: dbPath, coordinationPath: coordPath },
				paths: ["/api/factories"],
				childScript: mutateScript,
			}),
			/changed structure|File bytes changed/,
		);
		rmSync(join(guardRoot, "mutated-by-child.txt"), { force: true });
	}

	// Positive control (verifyReadOnlyViewerInChild): the DEFAULT child rejects when exec is invoked.
	await assert.rejects(
		() => verifyReadOnlyViewerInChild({
			stateDirs: guardRoot,
			viewerOptions: { statePath: dbPath, coordinationPath: coordPath },
			paths: ["/api/factories"],
			probeExec: true,
		}),
		/Expected no Herdr or external command calls/,
	);

	// Isolation check (verifyReadOnlyViewerInChild): child process receives isolated HOME/env rather than parent process.env.
	{
		const isoHome = join(guardRoot, "iso-home");
		mkdirSync(isoHome, { recursive: true });
		const envProbeScript = join(guardRoot, "env-probe-child.ts");
		writeFileSync(
			envProbeScript,
			`const req = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({
	responses: [{
		path: "/env",
		status: 200,
		text: JSON.stringify({ home: process.env.HOME, canary: process.env.OUTER_VIEWER_CANARY ?? null, path: process.env.PATH }),
	}],
}));
`,
		);
		const prevCanary = process.env.OUTER_VIEWER_CANARY;
		process.env.OUTER_VIEWER_CANARY = "must-not-leak";
		try {
			const [res] = await verifyReadOnlyViewerInChild({
				stateDirs: guardRoot,
				viewerOptions: {
					statePath: dbPath,
					coordinationPath: coordPath,
					home: isoHome,
					env: { PATH: join(guardRoot, "bin") },
				},
				paths: ["/env"],
				childScript: envProbeScript,
			});
			const childEnv = JSON.parse(res!.text) as { home: string; canary: string | null; path: string };
			assert.equal(childEnv.home, isoHome);
			assert.equal(childEnv.canary, null);
			assert.equal(childEnv.path, join(guardRoot, "bin"));
		} finally {
			if (prevCanary === undefined) delete process.env.OUTER_VIEWER_CANARY;
			else process.env.OUTER_VIEWER_CANARY = prevCanary;
		}
	}
});

test("static assets are local and expose accessible view navigation with strict CSP", async () => {
	for (const [path, expectedType] of [
		["/", "text/html"],
		["/index.html", "text/html"],
		["/style.css", "text/css"],
		["/app.js", "text/javascript"],
	] as const) {
		const res = await fetch(`${base}${path}`);
		assert.equal(res.status, 200, path);
		assert.match(res.headers.get("content-type") ?? "", new RegExp(expectedType));
		assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		const body = await res.text();
		const sanitized = body.replaceAll("http://www.w3.org/2000/svg", "");
		assert.doesNotMatch(sanitized, /https?:\/\//i, `unexpected external URL in ${path}`);
		assert.doesNotMatch(sanitized, /(?:src|href)\s*=\s*['"]\/\/|url\(\s*['"]?(?:https?:|\/\/)/i, `unexpected external asset reference in ${path}`);
		assert.doesNotMatch(body, /@import\b/i, `unexpected @import in ${path}`);
	}
	const html = await (await fetch(base)).text();
	assert.match(html, /aria-label="Views"/);
	assert.match(html, /Live Graph/);
});

async function runCliViewer(env: Record<string, string>, t: test.TestContext, cwd: string = repoRoot): Promise<{
	url: string;
	stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
	const child = spawn(process.execPath, [cliPath], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += chunk; });
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const url = await new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`));
		}, 8000);
		child.stdout.on("data", chunk => {
			if (settled) return;
			stdout += chunk;
			const match = /^Factory Viewer:\s+(http:\/\/\S+)/m.exec(stdout);
			if (match) {
				settled = true;
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		exitPromise.then(({ code, signal }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`CLI exited early (${code ?? signal}): stdout=${stdout} stderr=${stderr}`));
		});
	});
	return {
		url,
		stop: () => {
			child.kill("SIGTERM");
			return exitPromise;
		},
	};
}

test("CLI starts loopback viewer without Pi or Herdr, prints URL, stops cleanly without affecting factory store", async t => {
	const cliRoot = mkdtempSync(join(tmpdir(), "factory-viewer-cli-"));
	t.after(() => rmSync(cliRoot, { recursive: true, force: true }));
	const dbPath = join(cliRoot, "factories.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_cli','CLI Factory','{}','digest');");
	db.close();
	const emptyBin = join(cliRoot, "empty-bin");
	const before = snapshotStateDir(cliRoot);

	// 1. Explicit FACTORY_STATE_PATH without Pi/Herdr.
	{
		const cli = await runCliViewer({
			PATH: emptyBin,
			HOME: cliRoot,
			FACTORY_STATE_PATH: dbPath,
			FACTORY_VIEWER_HOST: "127.0.0.1",
			FACTORY_VIEWER_PORT: "0",
		}, t);
		assert.equal(new URL(cli.url).hostname, "127.0.0.1");
		const list = await fetch(`${cli.url}/api/factories`);
		assert.equal(list.status, 200);
		assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_cli", name: "CLI Factory", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
		const exit = await cli.stop();
		assert.equal(exit.code, 0);
		await assert.rejects(() => fetch(`${cli.url}/api/factories`));
	}

	// 2. Default state resolution via PI_FACTORY_STATE_DIR when FACTORY_STATE_PATH is omitted.
	{
		const cli = await runCliViewer({
			PATH: emptyBin,
			HOME: cliRoot,
			PI_FACTORY_STATE_DIR: cliRoot,
			PI_FACTORY_COORDINATION_DIR: cliRoot,
		}, t);
		const list = await fetch(`${cli.url}/api/factories`);
		assert.equal(list.status, 200);
		assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_cli", name: "CLI Factory", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
		const exit = await cli.stop();
		assert.equal(exit.code, 0);
	}
	assertStateDirUnchanged(cliRoot, before);

	// 2b. Default state resolution cases: PI_BOOTSTRAP_STATE_DIR only, HOME default, precedence, and empty-string handling.
	{
		const cliPathsRoot = mkdtempSync(join(tmpdir(), "factory-viewer-cli-paths-"));
		t.after(() => rmSync(cliPathsRoot, { recursive: true, force: true }));
		const emptyHome = join(cliPathsRoot, "empty-home");
		const bootstrapDir = join(cliPathsRoot, "bootstrap-dir");
		const factoryDir = join(cliPathsRoot, "factory-dir");
		const homeRoot = join(cliPathsRoot, "home-root");
		const homeDefaultDir = join(homeRoot, ".pi", "agent", "bootstrap-sessions");
		const emptyStringCwd = join(cliPathsRoot, "empty-string-cwd");
		for (const dir of [emptyHome, bootstrapDir, factoryDir, homeDefaultDir, emptyStringCwd]) {
			mkdirSync(dir, { recursive: true });
		}
		const seedStore = (dir: string, id: string, name: string) => {
			const store = new DatabaseSync(join(dir, "factories.sqlite"));
			store.exec(`PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('${id}','${name}','{}','digest');`);
			store.close();
		};
		seedStore(bootstrapDir, "fac_boot", "Bootstrap Only");
		seedStore(factoryDir, "fac_pref", "Factory Precedence");
		seedStore(homeDefaultDir, "fac_home", "Home Default");
		seedStore(emptyStringCwd, "fac_cwd", "Empty String CWD");

		// PI_BOOTSTRAP_STATE_DIR only.
		{
			const cli = await runCliViewer({
				PATH: emptyBin,
				HOME: emptyHome,
				PI_BOOTSTRAP_STATE_DIR: bootstrapDir,
				PI_FACTORY_COORDINATION_DIR: emptyHome,
			}, t);
			const list = await fetch(`${cli.url}/api/factories`);
			assert.equal(list.status, 200);
			assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_boot", name: "Bootstrap Only", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
			assert.equal((await cli.stop()).code, 0);
		}

		// HOME default when both env vars are omitted.
		{
			const cli = await runCliViewer({
				PATH: emptyBin,
				HOME: homeRoot,
				PI_FACTORY_COORDINATION_DIR: homeRoot,
			}, t);
			const list = await fetch(`${cli.url}/api/factories`);
			assert.equal(list.status, 200);
			assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_home", name: "Home Default", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
			assert.equal((await cli.stop()).code, 0);
		}

		// PI_FACTORY_STATE_DIR takes precedence over PI_BOOTSTRAP_STATE_DIR.
		{
			const cli = await runCliViewer({
				PATH: emptyBin,
				HOME: emptyHome,
				PI_FACTORY_STATE_DIR: factoryDir,
				PI_BOOTSTRAP_STATE_DIR: bootstrapDir,
				PI_FACTORY_COORDINATION_DIR: emptyHome,
			}, t);
			const list = await fetch(`${cli.url}/api/factories`);
			assert.equal(list.status, 200);
			assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_pref", name: "Factory Precedence", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
			assert.equal((await cli.stop()).code, 0);
		}

		// Empty-string PI_FACTORY_STATE_DIR preserves `??` behavior (does not fall back to PI_BOOTSTRAP_STATE_DIR).
		{
			const cli = await runCliViewer({
				PATH: emptyBin,
				HOME: emptyHome,
				PI_FACTORY_STATE_DIR: "",
				PI_BOOTSTRAP_STATE_DIR: bootstrapDir,
				PI_FACTORY_COORDINATION_DIR: emptyHome,
			}, t, emptyStringCwd);
			const list = await fetch(`${cli.url}/api/factories`);
			assert.equal(list.status, 200);
			assert.deepEqual(await list.json(), { factories: [{ factory_id: "fac_cwd", name: "Empty String CWD", current_version: "v1", management: "unmanaged" }], deleted: [], damaged: [] });
			assert.equal((await cli.stop()).code, 0);
		}
	}

	// 3. Invalid CLI configuration fails non-zero without creating files.
	for (const badEnv of [
		{ FACTORY_STATE_PATH: "" },
		{ FACTORY_STATE_PATH: dbPath, FACTORY_VIEWER_HOST: "0.0.0.0" },
		{ FACTORY_STATE_PATH: dbPath, FACTORY_VIEWER_PORT: "not-a-port" },
	]) {
		const child = spawn(process.execPath, [cliPath], { cwd: repoRoot, env: { HOME: cliRoot, ...badEnv }, stdio: "ignore" });
		t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
		const code = await new Promise<number | null>(resolve => child.once("exit", c => resolve(c)));
		assert.notEqual(code, 0);
	}
	assertStateDirUnchanged(cliRoot, before);
});

test("missing factory database returns empty list without creating files on disk", async t => {
	const f = serviceFixture(t, ["builder"]);
	const emptyRoot = mkdtempSync(join(tmpdir(), "factory-viewer-empty-"));
	t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
	const missingDb = join(emptyRoot, "factories.sqlite");
	const missingCoord = join(emptyRoot, "factory-coordination.sqlite");
	const ops = factoryOperations(missingDb, f.service, { coordinationPath: missingCoord });

	let viewerUrl = "";
	await verifyReadOnlyViewer(
		{ stateDirs: emptyRoot, viewerOptions: { statePath: missingDb, coordinationPath: missingCoord } },
		async viewer => {
			viewerUrl = viewer.url;
			const res = await fetch(`${viewer.url}/api/factories`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.deepEqual(body, { factories: [], deleted: [], damaged: [] });
			assert.deepEqual(body.factories, ops({ action: "list" }));
		},
	);
	await assert.rejects(() => fetch(`${viewerUrl}/api/factories`));
	assert.equal(existsSync(missingDb), false);
});

test("factory list matches /factory list, excludes other dirs, and preserves closed-manager fixture without Herdr/launch/settlement/cleanup", async t => {
	const f = serviceFixture(t, ["builder"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "Build feature",
		agents: [{ node_id: "build", persona: "builder", sub_task: "Implement" }],
	};

	const alpha = ops({ action: "publish", name: "alpha", draft, sessionModel });
	const authAlpha = createManagerAuthority({ pi_session_id: "sess-alpha" });
	ops({ action: "resume", factory_id: alpha.factory_id, authority: authAlpha });
	ops({ action: "update", factory_id: alpha.factory_id, authority: authAlpha, draft: { ...draft, task: "Build feature v2" }, sessionModel });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: authAlpha, reference: "ref-alpha-1", brief: "Work on alpha" });
	await ops({ action: "launch", factory_id: alpha.factory_id, authority: authAlpha });
	revokeManagerAuthority(authAlpha);

	const beta = ops({ action: "publish", name: "beta", draft, sessionModel });

	// Publish a separate factory into an unrelated state directory; viewer must never discover it.
	const otherDir = mkdtempSync(join(tmpdir(), "factory-viewer-other-dir-"));
	t.after(() => rmSync(otherDir, { recursive: true, force: true }));
	const otherDb = join(otherDir, "factories.sqlite");
	const otherOps = factoryOperations(otherDb, f.service, { coordinationPath: join(otherDir, "factory-coordination.sqlite") });
	const gamma = otherOps({ action: "publish", name: "gamma-other-dir", draft, sessionModel });

	const expectedList = ops({ action: "list" });
	assert.equal(expectedList.length, 2);
	assert.deepEqual(expectedList.map(entry => ({
		name: entry.name,
		current_version: entry.current_version,
		management: entry.management,
	})), [
		{ name: "alpha", current_version: "v2", management: "managed" },
		{ name: "beta", current_version: "v1", management: "unmanaged" },
	]);

	await verifyReadOnlyViewer(
		{ stateDirs: [f.root, otherDir], viewerOptions: { statePath, coordinationPath } },
		async viewer => {
			for (let i = 0; i < 4; i++) {
				const res = await fetch(`${viewer.url}/api/factories`);
				assert.equal(res.status, 200);
				const list = await res.json();
				assert.deepEqual(list, { factories: expectedList, deleted: [], damaged: [] });
				assert.ok(!JSON.stringify(list).includes(gamma.factory_id));
				assert.equal((await fetch(`${viewer.url}/`)).status, 200);
				assert.equal((await fetch(`${viewer.url}/style.css`)).status, 200);
				assert.equal((await fetch(`${viewer.url}/app.js`)).status, 200);
			}
		},
	);

	// Stopping the viewer affected only the viewer: the store and independent /factory list still work.
	assert.deepEqual(ops({ action: "list" }), expectedList);
	assert.equal(beta.factory_id !== alpha.factory_id, true);
});

test("hot-journal fixture returns 503 evidence unavailable and performs no recovery", async t => {
	const f = serviceFixture(t, ["first"]);
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	mkdirSync(join(iso.agentDir, "agents"), { recursive: true });
	writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
	const dbPath = join(f.root, "factories.sqlite");
	const draftFile = join(f.root, "draft.json");
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "Hot journal test",
		agents: [{ persona: "first", node_id: "build", sub_task: "x".repeat(3 * 1024 * 1024) }],
	};
	writeFileSync(draftFile, JSON.stringify(draft));
	const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
	const killed = await runSupervised(process.execPath, [child, dbPath, draftFile, "hot-factory", "before_commit"], {
		env: { ...iso.env, PATH: join(f.root, "bin") },
		timeoutMs: 10_000,
	});
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	assert.equal(existsSync(`${dbPath}-journal`), true);

	const coordPath = join(f.root, "factory-coordination.sqlite");
	const ops = factoryOperations(dbPath, f.service, { coordinationPath: coordPath });
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath } },
		async viewer => {
			for (let i = 0; i < 3; i++) {
				const res = await fetch(`${viewer.url}/api/factories`);
				assert.equal(res.status, 503);
				assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
			}
		},
	);
	assert.throws(() => ops({ action: "list" }));
	assert.equal(existsSync(`${dbPath}-journal`), true);
});

test("damaged-record fixtures fail closed with 503 evidence unavailable and leave bytes unchanged", async t => {
	const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

	// 1. Missing factory_pointers on a multi-version store must not default to v1.
	{
		const f = serviceFixture(t, ["builder"]);
		const dbPath = join(f.root, "factories.sqlite");
		const coordPath = join(f.root, "factory-coordination.sqlite");
		const ops = factoryOperations(dbPath, f.service, { coordinationPath: coordPath });
		const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "Damaged", agents: [{ node_id: "a", persona: "builder", sub_task: "work" }] };
		const fac = ops({ action: "publish", name: "damaged-ptr", draft, sessionModel });
		ops({ action: "update", factory_id: fac.factory_id, draft: { ...draft, task: "Damaged v2" }, sessionModel });
		const db = new DatabaseSync(dbPath);
		try { db.prepare("DELETE FROM factory_pointers WHERE factory_id = ?").run(fac.factory_id); } finally { db.close(); }

		await verifyReadOnlyViewer({ stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath } }, async viewer => {
			const res = await fetch(`${viewer.url}/api/factories`);
			assert.equal(res.status, 503);
			assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
		});
		assert.throws(() => ops({ action: "list" }));
	}

	// 2. Established factory missing factory_managers must not default to unmanaged.
	{
		const f = serviceFixture(t, ["builder"]);
		const dbPath = join(f.root, "factories.sqlite");
		const coordPath = join(f.root, "factory-coordination.sqlite");
		const ops = factoryOperations(dbPath, f.service, { coordinationPath: coordPath });
		const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "Damaged mgr", agents: [{ node_id: "a", persona: "builder", sub_task: "work" }] };
		const fac = ops({ action: "publish", name: "damaged-mgr", draft, sessionModel });
		const auth = createManagerAuthority({ pi_session_id: "sess-dmg" });
		ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
		ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-dmg", brief: "work" });
		revokeManagerAuthority(auth);
		const db = new DatabaseSync(dbPath);
		try {
			db.prepare("DELETE FROM factory_managers WHERE factory_id = ?").run(fac.factory_id);
		} finally { db.close(); }

		await verifyReadOnlyViewer({ stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath } }, async viewer => {
			const res = await fetch(`${viewer.url}/api/factories`);
			assert.equal(res.status, 503);
			assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
		});
		assert.throws(() => ops({ action: "list" }));
	}

	// 3. Corrupt non-SQLite database file returns 503 without overwriting or truncating.
	{
		const f = serviceFixture(t, ["builder"]);
		const corruptRoot = mkdtempSync(join(tmpdir(), "factory-viewer-corrupt-"));
		t.after(() => rmSync(corruptRoot, { recursive: true, force: true }));
		const dbPath = join(corruptRoot, "factories.sqlite");
		const coordPath = join(corruptRoot, "factory-coordination.sqlite");
		writeFileSync(dbPath, "not a sqlite database at all");
		const ops = factoryOperations(dbPath, f.service, { coordinationPath: coordPath });

		await verifyReadOnlyViewer({ stateDirs: corruptRoot, viewerOptions: { statePath: dbPath, coordinationPath: coordPath } }, async viewer => {
			const res = await fetch(`${viewer.url}/api/factories`);
			assert.equal(res.status, 503);
			assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
		});
		assert.throws(() => ops({ action: "list" }));
	}
});

test("manual acceptance fixture helper covers scenarios 1-5 read-only without sentinel leaks or fallback to current version", async t => {
	const fixture = await createManualAcceptanceFixture(t);
	await verifyReadOnlyViewer(
		{
			stateDirs: fixture.root,
			viewerOptions: {
				statePath: fixture.statePath,
				coordinationPath: fixture.coordinationPath,
				env: fixture.env,
				home: fixture.home,
			},
		},
		async viewer => {
			async function getChecked(path: string, expectedStatus = 200) {
				const res = await fetch(`${viewer.url}${path}`);
				const text = await res.text();
				assert.equal(res.status, expectedStatus, `${path} -> ${res.status}: ${text}`);
				for (const s of fixture.sentinels) {
					assert.equal(text.includes(s), false, `${path} leaked sentinel ${JSON.stringify(s)}`);
				}
				return JSON.parse(text) as any;
			}

			const list = await getChecked("/api/factories");
			assert.equal(list.factories.length, 6);
			assert.deepEqual(list.deleted, []);
			assert.deepEqual(list.damaged, []);

			const attemptOutputLive = await getChecked(`/api/factories/${fixture.factories.attemptOutput}/live`);
			const attemptOutputNodes = new Map(attemptOutputLive.graph.nodes.map((node: any) => [node.id, node]));
			for (const nodeId of ["attempt_history", "attempt_review", "command_exit", "command_signal", "missing_result", "still_running"]) {
				assert.ok(attemptOutputNodes.has(nodeId), `manual Attempt output fixture is missing node ${nodeId}`);
			}
			const historyNode = attemptOutputNodes.get("attempt_history");
			assert.equal(historyNode.status_text, "Waiting (parked)");
			assert.equal(historyNode.current_attempt.attempt_number, 3);
			assert.equal(attemptOutputNodes.get("attempt_review").status_text, "Waiting (parked)");
			assert.equal(attemptOutputNodes.get("command_exit").current_attempt.command.exit_code, 17);
			assert.equal(attemptOutputNodes.get("command_signal").current_attempt.command.signal, "SIGTERM");
			assert.equal(attemptOutputNodes.get("still_running").status_text, "Running");

			const attemptOutputBodies = new Map<string, any>();
			for (const nodeId of ["attempt_history", "attempt_review", "command_exit", "command_signal", "missing_result", "still_running"]) {
				attemptOutputBodies.set(nodeId, await getChecked(`/api/factories/${fixture.factories.attemptOutput}/output?node=${nodeId}`));
			}
			assert.equal(attemptOutputBodies.get("attempt_history").evidence, "available");
			for (const nodeId of ["command_exit", "command_signal", "attempt_review"]) {
				assert.equal(attemptOutputBodies.get(nodeId).evidence, "available", `${nodeId} attempt evidence should be available`);
			}
			for (const nodeId of ["command_exit", "command_signal"]) {
				const latest = attemptOutputBodies.get(nodeId).attempts[0];
				assert.equal(latest.status_text, "Failed", `${nodeId} should expose its failed command status`);
				assert.equal(latest.evidence, "available", `${nodeId} should expose its recorded command evidence`);
			}
			const reviewAttempts = attemptOutputBodies.get("attempt_review").attempts;
			assert.equal(reviewAttempts.length, 3, "manual review fixture should return all three review attempts");
			assert.ok(reviewAttempts.every((attempt: any) => attempt.evidence === "available"), "each review attempt should have verified output evidence");
			assert.equal(reviewAttempts[0].status_text, "Succeeded", "the newest successful review attempt keeps its own status while parked");
			assert.equal(attemptOutputBodies.get("missing_result").evidence, "unavailable");
			assert.equal(attemptOutputBodies.get("still_running").evidence, "not applicable");

			// Scenario 1 & 5 initial node state: bound v2 run while v3 is current; left parked with completed_at, right running with timestamps.
			const alphaLive = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/live`);
			assert.equal(alphaLive.state, "running");
			assert.equal(alphaLive.run.bound_version, "v2");
			assert.equal(alphaLive.current_version, "v3");
			const leftNode = alphaLive.graph.nodes.find((n: any) => n.id === "left");
			const rightNode = alphaLive.graph.nodes.find((n: any) => n.id === "right");
			assert.equal(leftNode.status_text, "Waiting (parked)");
			assert.ok(leftNode.current_attempt.completed_at);
			assert.equal(rightNode.status_text, "Running");
			assert.ok(rightNode.current_attempt.started_at);
			assert.ok(rightNode.current_attempt.updated_at);
			const inspV2 = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/inspect?version=v2&node=merge`);
			assert.equal(inspV2.target_node.verified, true);
			assert.equal(inspV2.target_node.version, "v2");
			const inspV3Missing = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/inspect?version=v3&node=merge`);
			assert.equal(inspV3Missing.target_node.verified, false);
			assert.equal(inspV3Missing.target_node.absence, "evidence unavailable");

			// Scenario 2: unreleased reserved launch -> blocked (no graph); contradictory release -> uncertain.
			const betaLive = await getChecked(`/api/factories/${fixture.factories.betaUnreleased}/live`);
			assert.equal(betaLive.state, "blocked");
			assert.equal(betaLive.run, null);
			assert.equal(betaLive.graph.absence, "not applicable");
			const gammaLive = await getChecked(`/api/factories/${fixture.factories.gammaUncertain}/live`);
			assert.equal(gammaLive.state, "uncertain");
			assert.equal(gammaLive.run, null);
			assert.equal(gammaLive.graph.evidence, "unavailable");
			assert.equal(gammaLive.graph.absence, "evidence unavailable");

			// Restored v3<-v1 and damaged v2 (must not fall back to v4), plus Queue Open vs All.
			const epsV3 = await getChecked(`/api/factories/${fixture.factories.epsilonVersions}/inspect?version=v3`);
			assert.equal(epsV3.current_version, "v4");
			assert.equal(epsV3.definition.restored_from.version, "v1");
			const epsV2 = await getChecked(`/api/factories/${fixture.factories.epsilonVersions}/inspect?version=v2`);
			assert.equal(epsV2.inspected_version, "v2");
			assert.equal(epsV2.current_version, "v4");
			assert.equal(epsV2.definition.evidence, "unavailable");
			assert.equal(epsV2.definition.absence, "evidence unavailable");
			const epsQueueOpen = await getChecked(`/api/factories/${fixture.factories.epsilonVersions}/queue?filter=open`);
			assert.equal(epsQueueOpen.entries.length, 1);
			assert.equal(epsQueueOpen.entries[0].bound_version, "v2");
			assert.equal(epsQueueOpen.entries[0].bound_version_evidence, "unavailable");

			// Typed absence distinct on unmanaged delta (blocked by alpha's held checkout) vs managed alpha.
			const deltaLive = await getChecked(`/api/factories/${fixture.factories.deltaUnmanaged}/live`);
			assert.equal(deltaLive.state, "blocked");
			const deltaQueue = await getChecked(`/api/factories/${fixture.factories.deltaUnmanaged}/queue?filter=open`);
			assert.equal(deltaQueue.absence, "not applicable");
			const deltaReqs = await getChecked(`/api/factories/${fixture.factories.deltaUnmanaged}/requests`);
			assert.equal(deltaReqs.absence, "not applicable");
			const deltaProps = await getChecked(`/api/factories/${fixture.factories.deltaUnmanaged}/proposals`);
			assert.equal(deltaProps.absence, "not applicable");

			// Requests, Proposals, Receipts, and HTTP error guards.
			const alphaReqs = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/requests`);
			assert.equal(alphaReqs.records.length, 1);
			const alphaProps = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/proposals`);
			assert.equal(alphaProps.is_active_constraints_file, false);
			assert.equal(alphaProps.records.length, 1);
			const alphaReceipt = await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/receipts?reference=${fixture.references.alphaSettled}`);
			assert.equal(alphaReceipt.is_run_report, false);
			await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/receipts?reference=nonexistent-ref`, 404);
			await getChecked(`/api/factories/unknown-factory/requests`, 404);
			await getChecked(`/api/factories/${fixture.factories.alphaLiveV2}/queue?filter=bogus`, 400);
			assert.equal((await fetch(`${viewer.url}/api/factories`, { method: "POST" })).status, 405);
		},
	);
});

test("manual acceptance fixture CLI rejects invalid arguments, handles SIGHUP, and cleans up temp dirs on failure", async t => {
	assert.throws(() => parseManualFixtureArgs(["--bogus"]), /Unknown argument/);
	assert.throws(() => parseManualFixtureArgs(["--advance-live-ms", "abc"]), /Invalid --advance-live-ms/);
	assert.throws(() => parseManualFixtureArgs(["--advance-live-ms", "0"]), /Invalid --advance-live-ms/);
	assert.throws(() => parseManualFixtureArgs(["--advance-live-ms", String(MAX_ADVANCE_LIVE_MS + 1)]), /Invalid --advance-live-ms/);
	assert.throws(() => parseManualFixtureArgs(["--advance-live-ms", "99999999999"]), /Invalid --advance-live-ms/);
	assert.equal(parseManualFixtureArgs(["--advance-live-ms", String(MAX_ADVANCE_LIVE_MS)]).advanceLiveAfterMs, MAX_ADVANCE_LIVE_MS);
	assert.throws(() => parseManualFixtureArgs(["--host", "0.0.0.0"]), /Invalid --host/);
	assert.throws(() => parseManualFixtureArgs(["--port", "70000"]), /Invalid --port/);

	const manualScript = join(repoRoot, "bootstrap", "test-support", "factory-viewer-manual-fixture.ts");
	const isoTmp = mkdtempSync(join(tmpdir(), "fwv-cli-tmp-"));
	t.after(() => rmSync(isoTmp, { recursive: true, force: true }));
	const childEnv = { ...process.env, TMPDIR: isoTmp };

	// Invalid CLI options exit 2 and create no temp fixture directory.
	for (const badArgs of [
		["--bogus"],
		["--advance-live-ms", "not-a-number"],
		["--advance-live-ms", "99999999999"],
		["--host", "0.0.0.0"],
	]) {
		const res = await runSupervised(process.execPath, [manualScript, ...badArgs], { env: childEnv, timeoutMs: 10_000 });
		assert.equal(res.code, 2, `expected exit 2 for ${badArgs.join(" ")}`);
		assert.deepEqual(
			existsSync(isoTmp) ? readdirSync(isoTmp) : [],
			[],
			`expected no leaked temp dir for ${badArgs.join(" ")}`,
		);
	}

	// Port-in-use failure after fixture creation cleans up the temp fixture directory.
	const occupant = (await import("node:net")).createServer();
	await new Promise<void>(resolve => occupant.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>(resolve => occupant.close(() => resolve())));
	const busyPort = (occupant.address() as { port: number }).port;
	const busyRes = await runSupervised(process.execPath, [manualScript, "--port", String(busyPort)], { env: childEnv, timeoutMs: 15_000 });
	assert.equal(busyRes.code, 2);
	assert.deepEqual(readdirSync(isoTmp), [], "port-in-use failure leaked temp dir");

	// SIGUSR1 trigger updates node 'right' once, second SIGUSR1 is harmless, and SIGHUP cleans up.
	const child = spawn(process.execPath, [manualScript], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	let stdout = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`manual fixture start timeout: ${stdout}`)), 15_000);
		child.stdout.on("data", chunk => {
			stdout += chunk.toString();
			if (stdout.includes("Scenario 5 trigger")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", code => { clearTimeout(timer); reject(new Error(`exited early ${code}: ${stdout}`)); });
	});
	const urlMatch = /Factory Viewer \(isolated temp fixture\): (http:\/\/[^\s]+)/.exec(stdout);
	const alphaMatch = /Scenario 1\/4\/5[^\n]*\?factory=([A-Za-z0-9_-]+)&view=live/.exec(stdout);
	assert.ok(urlMatch && alphaMatch, `Missing startup URL or alpha factory id in stdout: ${stdout}`);
	assert.match(stdout, new RegExp(`kill -USR1 ${child.pid}`));

	const beforeLive = await (await fetch(`${urlMatch[1]}/api/factories/${alphaMatch[1]}/live`)).json() as any;
	assert.equal(beforeLive.graph.nodes.find((n: any) => n.id === "right").status_text, "Running");

	child.kill("SIGUSR1");
	await new Promise<void>((resolve, reject) => {
		if (stdout.includes("Updated node 'right'")) { resolve(); return; }
		const timer = setTimeout(() => reject(new Error(`SIGUSR1 update timeout: ${stdout}`)), 5_000);
		const onData = () => {
			if (stdout.includes("Updated node 'right'")) {
				clearTimeout(timer);
				child.stdout.off("data", onData);
				resolve();
			}
		};
		child.stdout.on("data", onData);
	});
	const afterLive = await (await fetch(`${urlMatch[1]}/api/factories/${alphaMatch[1]}/live`)).json() as any;
	const rightAfter = afterLive.graph.nodes.find((n: any) => n.id === "right");
	assert.equal(rightAfter.status_text, "Succeeded");
	assert.ok(rightAfter.current_attempt.completed_at);

	// Second SIGUSR1 is harmless and does not overwrite or crash.
	child.kill("SIGUSR1");
	await new Promise<void>((resolve, reject) => {
		if (stdout.includes("already updated to succeeded")) { resolve(); return; }
		const timer = setTimeout(() => reject(new Error(`second SIGUSR1 timeout: ${stdout}`)), 5_000);
		const onData = () => {
			if (stdout.includes("already updated to succeeded")) {
				clearTimeout(timer);
				child.stdout.off("data", onData);
				resolve();
			}
		};
		child.stdout.on("data", onData);
	});
	const afterSecond = await (await fetch(`${urlMatch[1]}/api/factories/${alphaMatch[1]}/live`)).json() as any;
	assert.equal(afterSecond.graph.nodes.find((n: any) => n.id === "right").current_attempt.completed_at, rightAfter.current_attempt.completed_at);

	child.kill("SIGHUP");
	const exitCode = await new Promise<number | null>(resolve => child.once("exit", resolve));
	assert.equal(exitCode, 0);
	assert.deepEqual(readdirSync(isoTmp), [], "SIGHUP leaked temp dir");
});

test("createLiveFixtureAdvancer updates once and second invocation is harmless", async t => {
	const fixture = await createManualAcceptanceFixture(t);
	const logs: string[] = [];
	const advance = createLiveFixtureAdvancer(fixture, msg => logs.push(msg));
	assert.equal(advance(), true);
	const resultFile = join(fixture.run.sessionDir, `${fixture.run.rightAttemptId}.result.json`);
	const firstWriteText = readFileSync(resultFile, "utf8");
	const firstWrite = JSON.parse(firstWriteText);
	assert.match(firstWrite.result.detail, /FAKE_DETAIL_LINE_2[\s\S]*\n- FAKE_DETAIL_LIST_ITEM/);
	assert.equal(firstWrite.result.verification[0].check_id, "FAKE_LIVE_CHECK");
	assert.match(firstWrite.result.verification[0].reason, /FAKE_VERIFICATION/);
	assert.match(firstWrite.result.warnings[0], /FAKE_WARNING/);
	assert.match(firstWrite.result.next_steps[0], /FAKE_NEXT_STEP/);
	assert.deepEqual(firstWrite.result.outputs, {
		fixture_only: true,
		fake_id: "FAKE_STRUCTURED_OUTPUT_05",
		values: ["FAKE_VALUE_ALPHA", "FAKE_VALUE_BETA"],
	});
	assert.equal(advance(), false);
	assert.equal(readFileSync(resultFile, "utf8"), firstWriteText);
	assert.equal(logs.length, 2);
	assert.match(logs[0]!, /Updated node 'right'/);
	assert.match(logs[1]!, /already updated to succeeded/);

	await verifyReadOnlyViewer(
		{
			stateDirs: fixture.root,
			viewerOptions: {
				statePath: fixture.statePath,
				coordinationPath: fixture.coordinationPath,
				env: fixture.env,
				home: fixture.home,
			},
		},
		async viewer => {
			const res = await fetch(`${viewer.url}/api/factories/${fixture.factories.alphaLiveV2}/output?node=right`);
			assert.equal(res.status, 200);
			const text = await res.text();
			for (const s of fixture.sentinels) {
				assert.equal(text.includes(s), false, `right /output leaked sentinel ${JSON.stringify(s)}`);
			}
			const out = JSON.parse(text);
			assert.equal(out.evidence, "available");
			const att = out.attempts[0];
			assert.equal(att.status_text, "Succeeded");
			assert.equal(att.evidence, "available");
			assert.match(att.detail, /FAKE_DETAIL_LINE_2[\s\S]*\n- FAKE_DETAIL_LIST_ITEM/);
			assert.equal(att.verification.items[0].check_id, "FAKE_LIVE_CHECK");
			assert.match(att.verification.items[0].reason, /FAKE_VERIFICATION/);
			assert.match(att.warnings.items[0], /FAKE_WARNING/);
			assert.match(att.next_steps.items[0], /FAKE_NEXT_STEP/);
			assert.match(att.outputs_text, /FAKE_STRUCTURED_OUTPUT_05/);
			assert.match(att.outputs_text, /FAKE_VALUE_ALPHA/);
			assert.match(att.outputs_text, /FAKE_VALUE_BETA/);
		},
	);
});

test("manual acceptance fixture CLI cleans up temp dir on signals during build and supports relative TMPDIR", async t => {
	const manualScript = join(repoRoot, "bootstrap", "test-support", "factory-viewer-manual-fixture.ts");
	const isoTmp = mkdtempSync(join(tmpdir(), "fwv-cli-build-"));
	t.after(() => rmSync(isoTmp, { recursive: true, force: true }));

	// L1: Interrupting during fixture build (SIGINT, SIGTERM, SIGHUP) must not leak temp dirs.
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const child = spawn(process.execPath, [manualScript], { env: { ...process.env, TMPDIR: isoTmp }, stdio: ["ignore", "pipe", "pipe"] });
		t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
		const startedBuild = await new Promise<boolean>(resolve => {
			const deadline = Date.now() + 5_000;
			const poll = setInterval(() => {
				if (readdirSync(isoTmp).length > 0 || child.exitCode !== null || Date.now() > deadline) {
					clearInterval(poll);
					resolve(readdirSync(isoTmp).length > 0);
				}
			}, 10);
		});
		assert.equal(startedBuild, true, `expected temp dir creation during build before ${sig}`);
		child.kill(sig);
		const exitCode = await new Promise<number | null>(resolve => child.once("exit", resolve));
		assert.equal(exitCode, 0, `expected clean exit 0 on ${sig} during build`);
		assert.deepEqual(readdirSync(isoTmp), [], `${sig} during build leaked temp dir`);
	}

	// L2: Relative TMPDIR resolves to an absolute path instead of failing with "project_cwd must be absolute".
	const relTmp = "rel-tmp";
	mkdirSync(join(isoTmp, relTmp), { recursive: true });
	const relChild = spawn(process.execPath, [manualScript], {
		cwd: isoTmp,
		env: { ...process.env, TMPDIR: relTmp },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (relChild.exitCode === null && relChild.signalCode === null) relChild.kill("SIGKILL"); });
	let stdout = "";
	let stderr = "";
	relChild.stderr.on("data", chunk => { stderr += chunk.toString(); });
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`relative TMPDIR timeout: ${stdout}\n${stderr}`)), 15_000);
		relChild.stdout.on("data", chunk => {
			stdout += chunk.toString();
			if (stdout.includes("Scenario 5 trigger")) {
				clearTimeout(timer);
				resolve();
			}
		});
		relChild.once("exit", code => { clearTimeout(timer); reject(new Error(`relative TMPDIR exited early ${code}: ${stdout}\n${stderr}`)); });
	});
	relChild.kill("SIGTERM");
	const relExit = await new Promise<number | null>(resolve => relChild.once("exit", resolve));
	assert.equal(relExit, 0);
	assert.deepEqual(readdirSync(join(isoTmp, relTmp)), [], "relative TMPDIR leaked temp dir");
});
