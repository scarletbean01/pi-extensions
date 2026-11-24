import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { startViewer } from "../factory/viewer/server.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";

function tree(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name);
    return [name, lstatSync(path).isDirectory() ? tree(path) : readFileSync(path)];
  });
}

async function fixture(t: test.TestContext) {
  const { root, cwd, service } = serviceFixture(t, ["builder"]);
  const statePath = join(root, "factories.sqlite");
  const coordinationPath = join(root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const node = (node_id: string, depends_on?: string[]) => ({ node_id, persona: "builder", sub_task: "PRIVATE TASK", depends_on });
  const draft: GenerateRequest = { project_cwd: cwd, topology: "graph", task: "PRIVATE PROMPT", agents: [node("old")] };
  const { factory_id } = ops({ action: "publish", name: "Example", draft, sessionModel });
  const other = ops({ action: "publish", name: "Other", draft, sessionModel });
  const authority = createManagerAuthority();
  const target = { factory_id, authority };
  ops({ action: "resume", ...target });
  ops({ action: "update", ...target, draft: { ...draft, agents: [node("left"), node("right"), { ...node("merge", ["left", "right"]), join_policy: "allow_partial" }] }, sessionModel });
  ops({ action: "submit", ...target, reference: "ops:002", brief: "PRIVATE BRIEF" });
  const run = await ops({ action: "launch", ...target });
  ops({ action: "update", ...target, draft: { ...draft, agents: [node("new")] }, sessionModel });
  revokeManagerAuthority(authority);
  return { root, statePath, coordinationPath, factory_id, other, run };
}

test("closed-manager HTTP views follow the verified v2 run, not v3, without changing the fixture", async t => {
  const { root, statePath, coordinationPath, factory_id, other, run } = await fixture(t);
  const before = tree(root);
  const viewer = await startViewer({ statePath, coordinationPath });
  const factoryURL = `/api/factories/${factory_id}`;
  async function snapshot(url: string) {
    const response = await fetch(viewer.url + url);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(!body.includes(root));
    assert.doesNotMatch(body, /PRIVATE (PROMPT|TASK|BRIEF)/);
    return JSON.parse(body);
  }
  try {
    for (let i = 0; i < 2; i++) {
      const live = await snapshot(`${factoryURL}/live`);
      assert.equal(live.state, "running");
      assert.ok(Number.isFinite(Date.parse(live.checked_at)));
      assert.deepEqual(live.run, { run_id: run.task_id, attempt_id: run.attempt_id, bound_version: "v2" });
      assert.equal(live.current_version, "v3");
      assert.deepEqual(live.graph.nodes.map((node: { id: string }) => node.id), ["left", "right", "merge"]);
      assert.deepEqual(live.graph.edges.map(({ from, to }: { from: string; to: string }) => [from, to]), [["left", "merge"], ["right", "merge"]]);
    }
    await snapshot("/api/factories");
    const inspect = await snapshot(`${factoryURL}/inspect?version=v2`);
    assert.equal(inspect.inspected_version, "v2");
    assert.equal(inspect.current_version, "v3");
    const merge = inspect.definition.nodes.find((n: { id: string }) => n.id === "merge");
    assert.deepEqual(merge.relationships[0].targets.map((target: { node_id: string }) => target.node_id), ["left", "right"]);
    const queue = await snapshot(`${factoryURL}/queue?filter=all`);
    assert.equal(queue.entries[0].reference, "ops:002");
    const receipt = await snapshot(`${factoryURL}/receipts?reference=ops%3A002`);
    assert.equal(receipt.attempt.attempt_id, run.attempt_id);
    await snapshot(`${factoryURL}/requests`);
    await snapshot(`${factoryURL}/proposals`);
    const otherLive = await snapshot(`/api/factories/${other.factory_id}/live`);
    assert.equal(otherLive.run, null);
    await snapshot(`/api/factories/${other.factory_id}/inspect`);
    assert.equal((await fetch(`${viewer.url}/api/factories/nonexistent/live`)).status, 404);
  } finally { await viewer.close(); }
  assert.deepEqual(tree(root), before);
});

test("WAL coordination evidence is refused without creating sidecars", async t => {
  const { root, statePath, coordinationPath, factory_id } = await fixture(t);
  const db = new DatabaseSync(coordinationPath);
  try { db.exec("PRAGMA journal_mode = WAL"); } finally { db.close(); }
  const before = tree(root);
  const viewer = await startViewer({ statePath, coordinationPath });
  try {
    for (let i = 0; i < 2; i++) {
      const inspect = await fetch(`${viewer.url}/api/factories/${factory_id}/inspect`);
      assert.equal((await inspect.json() as { evidence: string }).evidence, "unavailable");
      assert.equal((await fetch(`${viewer.url}/api/factories/${factory_id}/live`)).status, 503);
      assert.deepEqual(tree(root), before);
    }
  } finally { await viewer.close(); }
});
