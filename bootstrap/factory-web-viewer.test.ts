import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { startViewer } from "../factory/viewer/server.ts";

let root: string;
let server: Awaited<ReturnType<typeof startViewer>>;
let base: string;

/** Whole-fixture byte snapshot used by all viewer HTTP read-only regressions. */
function snapshotFixture(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (path: string, relative: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const key = relative ? `${relative}/${name}` : name;
      if (statSync(child).isDirectory()) visit(child, key);
      else snapshot[key] = readFileSync(child).toString("base64");
    }
  };
  visit(directory, "");
  return snapshot;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "factory-viewer-"));
  const dbPath = join(root, "factories.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_1','Example','{}','digest');");
  db.close();
  server = await startViewer({ statePath: dbPath, host: "127.0.0.1", port: 0 });
  base = server.url;
});

after(async () => {
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("viewer is loopback-only, serves local pages and a projected factory list without writes", async () => {
  const dbPath = join(root, "factories.sqlite");
  const beforeBytes = readFileSync(dbPath);
  const response = await fetch(`${base}/api/factories`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ factory_id: "fac_1", name: "Example", current_version: "v1", management: "unmanaged" }]);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Factory Viewer/);
  assert.deepEqual(readFileSync(dbPath), beforeBytes);
  assert.equal(new URL(base).hostname, "127.0.0.1");
});

test("viewer rejects unsupported WAL stores without creating or changing sidecars", async () => {
  const walRoot = mkdtempSync(join(tmpdir(), "factory-viewer-wal-"));
  const dbPath = join(walRoot, "factories.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT); INSERT INTO factories VALUES('fac_wal','WAL','{}','digest'); PRAGMA journal_mode = WAL;");
  db.close();
  const before = snapshotFixture(walRoot);
  const walViewer = await startViewer({ statePath: dbPath, host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${walViewer.url}/api/factories`);
    assert.equal(response.status, 503);
    assert.deepEqual(snapshotFixture(walRoot), before);
  } finally { await walViewer.close(); rmSync(walRoot, { recursive: true, force: true }); }
});

test("viewer rejects writes and refuses arbitrary path input", async () => {
  assert.equal((await fetch(`${base}/api/factories`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/factories`, { method: "HEAD" })).status, 405);
  assert.equal((await fetch(`${base}/api/factories?path=/etc/passwd`)).status, 400);
  assert.equal((await fetch(`${base}/api/factories/not-a-factory/inspect`)).status, 404);
  assert.equal((await fetch(`${base}/api/factories/fac_1/inspect?version=../../etc/passwd`)).status, 400);
});

test("snapshot endpoints return named, fail-closed operator projections", async () => {
  const inspect = await fetch(`${base}/api/factories/fac_1/inspect`);
  assert.equal(inspect.status, 200);
  assert.deepEqual(await inspect.json(), { factory_id: "fac_1", evidence: "unavailable", explanation: "Factory inspection evidence is unavailable." });
  const queue = await fetch(`${base}/api/factories/fac_1/queue?filter=open`);
  assert.equal(queue.status, 200);
  assert.deepEqual(await queue.json(), { factory_id: "fac_1", entries: [], absence: "evidence unavailable" });
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

test("whole fixture snapshot helper detects any changed bytes", async () => {
  const before = snapshotFixture(root);
  await fetch(`${base}/api/factories`);
  await fetch(`${base}/api/factories/fac_1/inspect`);
  await fetch(`${base}/api/factories/fac_1/inspect?version=v1`);
  await fetch(`${base}/api/factories/fac_1/queue?filter=all`);
  await fetch(`${base}/api/factories/fac_1/receipts?reference=missing`);
  await fetch(`${base}/api/factories/fac_1/requests`);
  await fetch(`${base}/api/factories/fac_1/proposals`);
  assert.deepEqual(snapshotFixture(root), before);
});

test("static assets are local and expose accessible view navigation", async () => {
  const html = await (await fetch(base)).text();
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /aria-label="Views"/);
  assert.match(html, /Live Graph/);
});
