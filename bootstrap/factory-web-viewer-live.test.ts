import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority, type ClearanceDecision } from "../factory/operations.ts";
import { createViewerReader, startViewer } from "../factory/viewer/server.ts";
import { cancelPath } from "./cancellation.ts";
import { buildAttemptRow, buildInputRow } from "./factory-records.ts";
import { handoffClaimPath, handoffOfferPath, handoffRecoveryPath, handoffRejectionsPath, inputDigest } from "./handoff.ts";
import { BootstrapService, type GenerateRequest } from "./lifecycle.ts";
import { atomicJson, completionRecord, dispositionPath, dispositionRecord, readJson, readyPath, resultPath, type WorkerConfig } from "./session-store.ts";
import { finalizePath } from "./review-loop.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture, workerFromConfig } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer, verifyReadOnlyViewerInChild } from "./test-support/factory-viewer-fixture.ts";

function tree(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name);
    return [name, lstatSync(path).isDirectory() ? tree(path) : readFileSync(path)];
  });
}

async function fixture(t: test.TestContext) {
  const { root, cwd, home, service } = serviceFixture(t, ["builder"]);
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
  return { root, home, statePath, coordinationPath, factory_id, other, run };
}

test("closed-manager HTTP views follow the verified v2 run, not v3, without changing the fixture", async t => {
  const { root, home, statePath, coordinationPath, factory_id, other, run } = await fixture(t);
  const before = tree(root);
  const viewer = await startViewer({ statePath, coordinationPath, env: { PATH: join(root, "bin") }, home });
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
  const { root, home, statePath, coordinationPath, factory_id } = await fixture(t);
  const db = new DatabaseSync(coordinationPath);
  try { db.exec("PRAGMA journal_mode = WAL"); } finally { db.close(); }
  const before = tree(root);
  const viewer = await startViewer({ statePath, coordinationPath, env: { PATH: join(root, "bin") }, home });
  try {
    for (let i = 0; i < 2; i++) {
      const inspect = await fetch(`${viewer.url}/api/factories/${factory_id}/inspect`);
      assert.equal((await inspect.json() as { evidence: string }).evidence, "unavailable");
      assert.equal((await fetch(`${viewer.url}/api/factories/${factory_id}/live`)).status, 503);
      assert.deepEqual(tree(root), before);
    }
  } finally { await viewer.close(); }
});

test("Live Graph projects bound-version topology, joins, feedback edges, current attempt details, and version-bound links with factory isolation", async t => {
  const f = serviceFixture(t, ["builder", "reviewer"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const viewerEnv = { PATH: join(f.root, "bin") };

  const v1Draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_PROMPT_V1",
    agents: [{ node_id: "init", persona: "builder", sub_task: "PRIVATE_SUBTASK_V1" }],
  };
  const v2Draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_PROMPT_V2",
    agents: [
      { kind: "command", node_id: "prep", command: process.execPath, args: ["-e", "process.exit(0)", "--sentinel-cmd-arg"], working_directory: f.cwd, sub_task: "PRIVATE_PREP" },
      { node_id: "build", persona: "builder", sub_task: "PRIVATE_BUILD", depends_on: ["prep"], task_timeout_ms: 15_000 },
      { node_id: "check", persona: "builder", sub_task: "PRIVATE_CHECK", depends_on: ["prep"] },
      {
        node_id: "review",
        persona: "reviewer",
        sub_task: "PRIVATE_REVIEW",
        depends_on: ["build"],
        output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
        decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
      },
      { node_id: "merge", persona: "builder", sub_task: "PRIVATE_MERGE", depends_on: ["check", "review"], join_policy: "allow_partial" },
    ],
  };
  const v4Draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_PROMPT_V4",
    agents: [{ node_id: "ship", persona: "builder", sub_task: "PRIVATE_SHIP" }],
  };

  const fac = ops({ action: "publish", name: "live-graph-fac", draft: v1Draft, sessionModel });
  const auth = createManagerAuthority({ pi_session_id: "sess-live-graph" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v2Draft, sessionModel });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "live-ref-1", brief: "PRIVATE_BRIEF_V2" });
  const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  // Restore v3 from v1, then publish v4 so current_version diverges from bound_version v2.
  ops({ action: "restore", factory_id: fac.factory_id, authority: auth, from_version: "v1" });
  ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v4Draft, sessionModel });
  revokeManagerAuthority(auth);

  // Record a completed command node result (with stdout/stderr excerpts that must NOT leak) and an active running node.
  const sessionDir = launched.manifest.session_dir;
  const prepEntry = launched.manifest.pane_manifest.find(e => e.node_id === "prep")!;
  const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
  atomicJson(resultPath(sessionDir, prepEntry.attempt_id!), {
    version: 7,
    identity: { run_id: launched.task_id, node_id: "prep", persona_name: prepEntry.persona_name, attempt_id: prepEntry.attempt_id!, instance_id: prepEntry.instance_id },
    result: {
      agent_name: prepEntry.persona_name,
      node_id: "prep",
      status: "success",
      summary: "Prep command exited 0",
      detail: "PUBLIC_LOG_DETAIL",
      command_evidence: {
        version: 1,
        command: process.execPath,
        args: ["-e", "process.exit(0)", "--sentinel-cmd-arg"],
        working_directory: f.cwd,
        exit_code: 0,
        signal: null,
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z",
        duration_ms: 1000,
        stdout_bytes: 12,
        stderr_bytes: 0,
        stdout_excerpt: "PUBLIC_STDOUT_LOG",
        stderr_excerpt: "PUBLIC_STDERR_LOG",
      },
    },
    delivery: "sent",
    completed_at: "2026-01-01T00:00:01.000Z",
  });
  atomicJson(readyPath(sessionDir, buildEntry.instance_id), {
    version: 2,
    direction_incarnation: "inc-build-1",
    task_id: launched.task_id,
    token: launched.manifest.token,
    instance_id: buildEntry.instance_id,
    pid: process.pid,
    session_id: "sess-build",
    name: buildEntry.instance_id,
    endpoint: "/tmp/sentinel-endpoint-coms",
    model: "test-provider/test-model",
  });
  atomicJson(join(sessionDir, `${buildEntry.instance_id}.progress.json`), {
    attempt_id: `${buildEntry.instance_id}.1`,
    token: launched.manifest.token,
    updated_at: Date.now(),
    started_at: Date.now() - 2000,
    state: "working",
  });

  // Second factory with its own released run in its own checkout to prove strict cross-factory isolation.
  const otherF = serviceFixture(t, ["builder"]);
  const otherOps = factoryOperations(statePath, otherF.service, { coordinationPath });
  const otherFac = otherOps({
    action: "publish",
    name: "other-live-fac",
    draft: {
      project_cwd: otherF.cwd,
      topology: "graph",
      task: "PRIVATE_OTHER_TASK",
      agents: [
        { node_id: "other_alpha", persona: "builder", sub_task: "PRIVATE_OTHER_SUB_A" },
        { node_id: "other_beta", persona: "builder", sub_task: "PRIVATE_OTHER_SUB_B", depends_on: ["other_alpha"] },
      ],
    },
    sessionModel,
  });
  const otherAuth = createManagerAuthority({ pi_session_id: "sess-other-live" });
  otherOps({ action: "resume", factory_id: otherFac.factory_id, authority: otherAuth });
  otherOps({ action: "submit", factory_id: otherFac.factory_id, authority: otherAuth, reference: "other-ref-1", brief: "PRIVATE_OTHER_BRIEF" });
  const otherLaunched = await otherOps({ action: "launch", factory_id: otherFac.factory_id, authority: otherAuth });
  revokeManagerAuthority(otherAuth);

  const sentinels = [
    "PRIVATE_",
    f.root,
    f.cwd,
    f.home,
    otherF.root,
    otherF.cwd,
    otherF.home,
    statePath,
    coordinationPath,
    process.execPath,
    "--sentinel-cmd-arg",
    "/tmp/sentinel-endpoint-coms",
  ];
  const assertNoLeaks = (text: string, label: string) => {
    for (const s of sentinels) assert.equal(text.includes(s), false, `${label} leaked ${s}`);
  };

  await verifyReadOnlyViewer(
    { stateDirs: [f.root, otherF.root], viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
    async viewer => {
      const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
      assert.equal(liveRes.status, 200);
      const liveText = await liveRes.text();
      assertNoLeaks(liveText, "live snapshot");
      assert.equal(liveText.includes("PUBLIC_LOG_DETAIL"), false, "live snapshot must not expose detail");
      assert.equal(liveText.includes("PUBLIC_STDOUT_LOG"), false, "live snapshot must not expose stdout_excerpt");
      assert.equal(liveText.includes("PUBLIC_STDERR_LOG"), false, "live snapshot must not expose stderr_excerpt");
      assert.equal(liveText.includes(otherLaunched.task_id), false);
      assert.equal(liveText.includes(otherLaunched.attempt_id), false);
      assert.equal(liveText.includes("other_alpha"), false);
      assert.equal(liveText.includes("other_beta"), false);
      const live = JSON.parse(liveText);

      assert.equal(live.factory_id, fac.factory_id);
      assert.equal(live.state, "running");
      assert.equal(live.current_version, "v4");
      assert.deepEqual(live.run, { run_id: launched.task_id, attempt_id: launched.attempt_id, bound_version: "v2" });
      assert.equal(live.graph.evidence, "available");
      assert.equal(live.graph.bound_version, "v2");
      assert.equal(live.graph.topology, "graph");
      assert.deepEqual(live.graph.nodes.map((n: any) => n.id), ["prep", "build", "check", "review", "merge"]);

      // Distinguishes dependency edges (with derived state), joins, and feedback edges.
      const depEdges = live.graph.edges.filter((e: any) => e.kind === "dependency");
      const fbEdges = live.graph.edges.filter((e: any) => e.kind === "feedback");
      assert.deepEqual(depEdges.map((e: any) => [e.from, e.to]), [
        ["prep", "build"],
        ["prep", "check"],
        ["build", "review"],
        ["check", "merge"],
        ["review", "merge"],
      ]);
      assert.equal(depEdges[0].state, "fired");
      assert.deepEqual(fbEdges.map((e: any) => [e.from, e.to]), [["review", "build"]]);

      assert.equal(live.graph.joins.length, 1);
      assert.equal(live.graph.joins[0].node_id, "merge");
      assert.equal(live.graph.joins[0].policy, "allow_partial");
      assert.deepEqual(live.graph.joins[0].sources, ["check", "review"]);
      assert.equal(live.graph.joins[0].source_links.length, 2);
      assert.deepEqual(
        live.graph.joins[0].source_links.map((l: any) => ({ factory_id: l.factory_id, version: l.version, node_id: l.node_id })),
        [
          { factory_id: fac.factory_id, version: "v2", node_id: "check" },
          { factory_id: fac.factory_id, version: "v2", node_id: "review" },
        ],
      );
      for (const link of live.graph.joins[0].source_links) {
        assert.ok(link.snapshot_url.includes("version=v2"), link.snapshot_url);
      }

      assert.equal(live.graph.feedback_edges.length, 1);
      assert.equal(live.graph.feedback_edges[0].from, "review");
      assert.equal(live.graph.feedback_edges[0].to, "build");
      assert.equal(live.graph.feedback_edges[0].max_revisions, 2);
      assert.equal(live.graph.feedback_edges[0].target_link.version, "v2");
      assert.equal(live.graph.feedback_edges[0].target_link.node_id, "build");

      // Per-node status text, current attempt details, and version-bound links to v2.
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      const prep = byId.get("prep");
      assert.equal(prep.kind, "command");
      assert.equal(prep.status, "succeeded");
      assert.equal(prep.status_text, "Succeeded");
      assert.equal(prep.current_attempt.result_status, "success");
      assert.equal(prep.current_attempt.command.exit_code, 0);
      assert.equal(prep.current_attempt.configuration.version, "v2");
      assert.equal(prep.configuration_link.snapshot_url, `/api/factories/${encodeURIComponent(fac.factory_id)}/inspect?version=v2&node=prep`);

      const build = byId.get("build");
      assert.equal(build.status, "running");
      assert.equal(build.status_text, "Running");
      assert.equal(build.current_attempt.attempt_id, `${buildEntry.instance_id}.1`);
      assert.equal(build.current_attempt.attempt_number, 1);
      assert.equal(build.current_attempt.max_attempts, 3);
      assert.equal(build.current_attempt.process_state, "alive");
      assert.equal(typeof build.current_attempt.started_at, "string");
      assert.equal(build.current_attempt.loop.attempt, 1);
      assert.equal(build.current_attempt.loop.max_attempts, 3);
      assert.equal(build.configuration_link.version, "v2");

      // Following build's configuration_link resolves in v2 (task_timeout_ms: 15_000), never v4.
      const cfgSnap = await (await fetch(`${viewer.url}${build.configuration_link.snapshot_url}`)).json() as any;
      assert.equal(cfgSnap.inspected_version, "v2");
      assert.equal(cfgSnap.current_version, "v4");
      assert.equal(cfgSnap.target_node.verified, true);
      assert.equal(cfgSnap.target_node.node.limits.task_timeout_ms.value, 15_000);

      // /output for prep exposes scrubbed detail & command excerpts while keeping PRIVATE_ and command/args/cwd/endpoint sentinels out.
      const prepOutRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/output?node=prep`);
      assert.equal(prepOutRes.status, 200);
      const prepOutText = await prepOutRes.text();
      assertNoLeaks(prepOutText, "output prep");
      const prepOut = JSON.parse(prepOutText);
      assert.equal(prepOut.attempts.length, 1);
      assert.equal(prepOut.attempts[0].detail, "PUBLIC_LOG_DETAIL");
      assert.equal(prepOut.attempts[0].command.stdout_excerpt, "PUBLIC_STDOUT_LOG");
      assert.equal(prepOut.attempts[0].command.stderr_excerpt, "PUBLIC_STDERR_LOG");

      // Factory isolation: other factory returns only its own launched graph and never leaks fac's ids/nodes.
      const otherText = await (await fetch(`${viewer.url}/api/factories/${otherFac.factory_id}/live`)).text();
      assertNoLeaks(otherText, "other live");
      assert.equal(otherText.includes(launched.task_id), false);
      assert.equal(otherText.includes(launched.attempt_id), false);
      assert.equal(otherText.includes(fac.factory_id), false);
      for (const facNode of ["prep", "build", "check", "review", "merge"]) {
        assert.equal(otherText.includes(`"${facNode}"`), false, `other live leaked node ${facNode}`);
      }
      const otherLive = JSON.parse(otherText);
      assert.equal(otherLive.factory_id, otherFac.factory_id);
      assert.equal(otherLive.state, "running");
      assert.deepEqual(otherLive.run, { run_id: otherLaunched.task_id, attempt_id: otherLaunched.attempt_id, bound_version: "v1" });
      assert.deepEqual(otherLive.graph.nodes.map((n: any) => n.id), ["other_alpha", "other_beta"]);
      assert.deepEqual(otherLive.graph.edges.map((e: any) => [e.from, e.to]), [["other_alpha", "other_beta"]]);
    },
  );

  // Also verify a run launched on a restored version (v3 restored from v1, while v4 is current) draws v3's restored topology.
  {
    const fRest = serviceFixture(t, ["builder"]);
    const restState = join(fRest.root, "factories.sqlite");
    const restCoord = join(fRest.root, "factory-coordination.sqlite");
    const restOps = factoryOperations(restState, fRest.service, { coordinationPath: restCoord });
    const restV1 = { ...v1Draft, project_cwd: fRest.cwd };
    const restV4 = { ...v4Draft, project_cwd: fRest.cwd };
    const restFac = restOps({ action: "publish", name: "restored-run-fac", draft: restV1, sessionModel });
    const restAuth = createManagerAuthority({ pi_session_id: "sess-rest-run" });
    restOps({ action: "resume", factory_id: restFac.factory_id, authority: restAuth });
    restOps({ action: "update", factory_id: restFac.factory_id, authority: restAuth, draft: restV4, sessionModel });
    restOps({ action: "restore", factory_id: restFac.factory_id, authority: restAuth, from_version: "v1" });
    restOps({ action: "submit", factory_id: restFac.factory_id, authority: restAuth, reference: "ref-rest-v3", brief: "PRIVATE_REST_BRIEF" });
    await restOps({ action: "launch", factory_id: restFac.factory_id, authority: restAuth });
    restOps({ action: "update", factory_id: restFac.factory_id, authority: restAuth, draft: restV4, sessionModel });
    revokeManagerAuthority(restAuth);

    await verifyReadOnlyViewer(
      { stateDirs: fRest.root, viewerOptions: { statePath: restState, coordinationPath: restCoord, env: { PATH: join(fRest.root, "bin") }, home: fRest.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${restFac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "running");
        assert.equal(live.run.bound_version, "v3");
        assert.equal(live.current_version, "v4");
        assert.deepEqual(live.graph.nodes.map((n: any) => n.id), ["init"]);
        assert.equal(live.graph.nodes[0].configuration_link.version, "v3");
      },
    );
  }
});

test("Live Graph reports per-node status text and reasons for waiting, parked, blocked, and uncertain nodes", async t => {
  const f = serviceFixture(t, ["builder", "reviewer"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const viewerEnv = { PATH: join(f.root, "bin") };

  const draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_STATES_PROMPT",
    agents: [
      { node_id: "build", persona: "builder", sub_task: "PRIVATE_STATES_BUILD" },
      {
        node_id: "review",
        persona: "reviewer",
        sub_task: "PRIVATE_STATES_REVIEW",
        depends_on: ["build"],
        output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
        decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1, on_exhausted: "failed" },
      },
      { node_id: "deploy", persona: "builder", sub_task: "PRIVATE_STATES_DEPLOY", depends_on: ["review"] },
      { node_id: "after_review", persona: "builder", sub_task: "PRIVATE_STATES_AFTER", depends_on: ["review"] },
      { node_id: "human_wait", persona: "builder", sub_task: "PRIVATE_STATES_HUMAN" },
      { node_id: "dep_wait", persona: "builder", sub_task: "PRIVATE_STATES_DEP", depends_on: ["human_wait"] },
      { node_id: "exited", persona: "builder", sub_task: "PRIVATE_STATES_EXITED" },
      { node_id: "contradict", persona: "builder", sub_task: "PRIVATE_STATES_CONTRA" },
      { node_id: "corrupt_prog", persona: "builder", sub_task: "PRIVATE_STATES_CORRUPT" },
      { node_id: "symlink_res", persona: "builder", sub_task: "PRIVATE_STATES_SYMLINK" },
    ],
  };

  const fac = ops({ action: "publish", name: "node-states-fac", draft, sessionModel });
  const auth = createManagerAuthority({ pi_session_id: "sess-node-states" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-states", brief: "PRIVATE_STATES_BRIEF" });
  const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  revokeManagerAuthority(auth);

  const dir = launched.manifest.session_dir;
  const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;
  const writeReady = (entry: ReturnType<typeof entryOf>, pid: number) => {
    atomicJson(readyPath(dir, entry.instance_id), {
      version: 2,
      direction_incarnation: `inc-${entry.instance_id}`,
      task_id: launched.task_id,
      token: launched.manifest.token,
      instance_id: entry.instance_id,
      pid,
      session_id: `sess-${entry.instance_id}`,
      name: entry.instance_id,
      endpoint: "/tmp/fake-coms",
      model: "test-provider/test-model",
    });
  };

  // 1. build: completed result in unfinalized review loop -> parked ("Waiting (parked)").
  const buildEntry = entryOf("build");
  const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
  atomicJson(
    resultPath(dir, buildEntry.attempt_id!),
    completionRecord(buildCfg, { agent_name: buildEntry.persona_name, node_id: "build", status: "success", summary: "Built v1", detail: "PRIVATE_DETAIL" }, "sent", "2026-01-01T00:00:01.000Z"),
  );

  // 2. human_wait: waiting for human direction.
  const humanEntry = entryOf("human_wait");
  writeReady(humanEntry, process.pid);
  atomicJson(join(dir, `${humanEntry.instance_id}.progress.json`), {
    attempt_id: humanEntry.attempt_id,
    token: launched.manifest.token,
    updated_at: Date.now(),
    started_at: Date.now() - 5000,
    waiting_for_human_since: Date.now() - 2000,
    state: "working",
  });

  // 3. dep_wait: waiting on inbound dependency (human_wait).
  const depEntry = entryOf("dep_wait");
  writeReady(depEntry, process.pid);
  atomicJson(join(dir, `${depEntry.instance_id}.progress.json`), {
    attempt_id: depEntry.attempt_id,
    token: launched.manifest.token,
    updated_at: Date.now(),
    state: "waiting",
  });

  // 4. deploy: explicit blocked disposition with reason & causes.
  const deployEntry = entryOf("deploy");
  atomicJson(
    dispositionPath(dir, deployEntry.attempt_id!),
    dispositionRecord({ ...deployEntry, task_id: launched.task_id }, "blocked", "Upstream review rejected changes", [{ node_id: "review", state: "failed", reason: "Review rejected" }], "2026-01-01T00:00:01.000Z"),
  );

  // 5. exited: dead PID without result -> Uncertain.
  const exitedEntry = entryOf("exited");
  writeReady(exitedEntry, 2_147_483_646);

  // 6. contradict: both result and disposition -> Uncertain.
  const contraEntry = entryOf("contradict");
  atomicJson(resultPath(dir, contraEntry.attempt_id!), {
    version: 6,
    identity: { run_id: launched.task_id, node_id: "contradict", persona_name: contraEntry.persona_name, attempt_id: contraEntry.attempt_id!, instance_id: contraEntry.instance_id },
    result: { agent_name: contraEntry.persona_name, node_id: "contradict", status: "success", summary: "Done", detail: "PRIVATE" },
    delivery: "not_required",
    completed_at: "2026-01-01T00:00:01.000Z",
  });
  atomicJson(dispositionPath(dir, contraEntry.attempt_id!), dispositionRecord({ ...contraEntry, task_id: launched.task_id }, "cancelled", "Cancelled late", [], "2026-01-01T00:00:01.000Z"));

  // 7. corrupt_prog: malformed JSON in progress -> Uncertain (without leaking root paths or crashing snapshot).
  const corruptEntry = entryOf("corrupt_prog");
  writeReady(corruptEntry, process.pid);
  writeFileSync(join(dir, `${corruptEntry.instance_id}.progress.json`), "{bad-json");

  // 8. symlink_res: symlinked result file -> refused by readRegularJsonNoSymlink -> Uncertain.
  const symlinkEntry = entryOf("symlink_res");
  const targetJson = join(f.root, "outside-result.json");
  writeFileSync(targetJson, JSON.stringify({ secret: "PRIVATE_SYMLINK_LEAK" }));
  symlinkSync(targetJson, resultPath(dir, symlinkEntry.attempt_id!));

  const sentinels = ["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath];
  const assertNoLeaks = (text: string, label: string) => {
    for (const s of sentinels) assert.equal(text.includes(s), false, `${label} leaked ${s}`);
  };

  await verifyReadOnlyViewer(
    { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
    async viewer => {
      const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assertNoLeaks(text, "node states");
      const live = JSON.parse(text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));

      assert.equal(byId.get("build").status, "waiting");
      assert.equal(byId.get("build").status_text, "Waiting (parked)");
      assert.equal(byId.get("build").parked, true);
      assert.match(byId.get("build").reason, /not finalized/i);

      assert.equal(byId.get("human_wait").status, "waiting");
      assert.equal(byId.get("human_wait").status_text, "Waiting");
      assert.match(byId.get("human_wait").reason, /human direction/i);
      assert.deepEqual(byId.get("human_wait").current_attempt.waiting_on, ["human_direction"]);

      assert.equal(byId.get("dep_wait").status, "waiting");
      assert.equal(byId.get("dep_wait").status_text, "Waiting");
      assert.match(byId.get("dep_wait").reason, /human_wait/);
      assert.deepEqual(byId.get("dep_wait").current_attempt.waiting_on, ["human_wait"]);

      assert.equal(byId.get("deploy").status, "blocked");
      assert.equal(byId.get("deploy").status_text, "Blocked");
      assert.equal(byId.get("deploy").reason, "Upstream review rejected changes");
      assert.equal(byId.get("deploy").current_attempt.causes[0].node_id, "review");

      for (const uncertainNode of ["exited", "contradict", "corrupt_prog", "symlink_res"]) {
        const node = byId.get(uncertainNode);
        assert.equal(node.status, "needs_attention", uncertainNode);
        assert.equal(node.status_text, "Uncertain", uncertainNode);
        assert.equal(typeof node.reason, "string", uncertainNode);
        assert.ok(node.reason.length > 0, uncertainNode);
      }
      assert.match(byId.get("exited").reason, /exited without a verified result/i);
    },
  );

  // Finalize the review loop with an exhausted rejection -> review becomes failed and unadmitted successor review->deploy edge is dead.
  const reviewEntry = entryOf("review");
  const reviewCfg = readJson<WorkerConfig>(join(dir, `${reviewEntry.instance_id}.config.json`));
  atomicJson(
    resultPath(dir, reviewEntry.attempt_id!),
    completionRecord(reviewCfg, { agent_name: reviewEntry.persona_name, node_id: "review", status: "success", summary: "Needs fixes", outputs: { verdict: "revise" }, detail: "PRIVATE" }, "not_required", "2026-01-01T00:00:02.000Z"),
  );
  atomicJson(finalizePath(dir, reviewEntry.instance_id), {
    version: 1,
    run_id: launched.task_id,
    instance_id: reviewEntry.instance_id,
    attempt_id: reviewEntry.attempt_id!,
    finalized_by: reviewEntry.instance_id,
    exhausted: { state: "failed", reason: "Review loop exhausted its revision limit (build -> review)" },
  });
  atomicJson(finalizePath(dir, buildEntry.instance_id), {
    version: 1,
    run_id: launched.task_id,
    instance_id: buildEntry.instance_id,
    attempt_id: buildEntry.attempt_id!,
    finalized_by: reviewEntry.instance_id,
  });

  await verifyReadOnlyViewer(
    { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
    async viewer => {
      const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
      assert.equal(res.status, 200);
      const live = JSON.parse(await res.text());
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      assert.equal(byId.get("build").status, "succeeded");
      assert.equal(byId.get("build").status_text, "Succeeded");
      assert.equal(byId.get("review").status, "failed");
      assert.equal(byId.get("review").status_text, "Failed");
      assert.match(byId.get("review").reason, /exhausted/i);
      assert.equal(byId.get("after_review").status, "blocked");
      assert.equal(byId.get("after_review").status_text, "Blocked");
      assert.match(byId.get("after_review").reason, /exhausted/i);
      const revToDeploy = live.graph.edges.find((e: any) => e.from === "review" && e.to === "deploy");
      assert.equal(revToDeploy.state, "dead");
    },
  );
});

test("Live Graph returns no graph with typed absence for reserved, failed-before-release, idle, and unmanaged states, and fails closed on damaged/contradictory release evidence", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const launchChild = fileURLToPath(new URL("./test-support/factory-launch-child.ts", import.meta.url));

  // 1. Reserved launch (killed right after reservation commit) vs idle managed vs unmanaged -> distinct typed absence, no graph.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const viewerEnv = { PATH: join(f.root, "bin") };
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_RESERVE_PROMPT",
      agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_RESERVE_SUB" }],
    };

    const unmFac = ops({ action: "publish", name: "unmanaged-fac", draft, sessionModel });
    const idleFac = ops({ action: "publish", name: "idle-fac", draft, sessionModel });
    const authIdle = createManagerAuthority({ pi_session_id: "sess-idle" });
    ops({ action: "resume", factory_id: idleFac.factory_id, authority: authIdle });
    revokeManagerAuthority(authIdle);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const idleLive = await (await fetch(`${viewer.url}/api/factories/${idleFac.factory_id}/live`)).json() as any;
        assert.equal(idleLive.run, null);
        assert.equal(idleLive.state, "idle");
        assert.equal(idleLive.graph.evidence, "not applicable");
        assert.equal(idleLive.graph.absence, "no records");

        const unmLive = await (await fetch(`${viewer.url}/api/factories/${unmFac.factory_id}/live`)).json() as any;
        assert.equal(unmLive.run, null);
        assert.equal(unmLive.state, "idle");
        assert.equal(unmLive.graph.evidence, "not applicable");
        assert.equal(unmLive.graph.absence, "not applicable");
      },
    );

    const resFac = ops({ action: "publish", name: "reserved-fac", draft, sessionModel });
    const killed = await runSupervised(process.execPath, [
      launchChild,
      JSON.stringify({
        mode: "kill-launch",
        database: statePath,
        factoryId: resFac.factory_id,
        projectCwd: f.cwd,
        stateDir: f.stateDir,
        home: f.home,
        bin: join(f.root, "bin"),
        killPhase: "reserve_after_commit",
      }),
    ], {
      env: { ...process.env, PATH: join(f.root, "bin"), HOME: f.home, PI_FACTORY_COORDINATION_DIR: f.root },
      timeoutMs: 10_000,
    });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const resLive = await (await fetch(`${viewer.url}/api/factories/${resFac.factory_id}/live`)).json() as any;
        assert.equal(resLive.run, null);
        assert.equal(resLive.state, "blocked");
        assert.equal(resLive.head_status.blocking_kind, "factory_held");
        assert.equal(resLive.reason, "A launch attempt currently holds this factory's run slot.");
        assert.equal(resLive.graph.evidence, "not applicable");
        assert.equal(resLive.graph.absence, "not applicable");
        assert.match(resLive.graph.explanation, /reserved/i);
      },
    );
  }

  // 2. Failed-before-release launch -> no graph (run: null, graph.absence: "not applicable").
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const failingOps = factoryOperations(statePath, f.service, {
      coordinationPath,
      atLaunchCommit: phase => {
        if (phase === "release_before_commit") throw new Error("stop before release");
      },
    });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_FAIL_PROMPT",
      agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_FAIL_SUB" }],
    };
    const fac = ops({ action: "publish", name: "failed-before-release-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-fbr" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-fbr", brief: "PRIVATE_FBR_BRIEF" });
    await assert.rejects(() => failingOps({ action: "launch", factory_id: fac.factory_id, authority: auth }), /stop before release/);
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.run, null);
        assert.equal(live.state, "blocked");
        assert.equal(live.graph.evidence, "not applicable");
        assert.equal(live.graph.absence, "not applicable");
        assert.match(live.graph.explanation, /failed_before_release|before release/i);
      },
    );
  }

  // 3. Negative guard tests on released runs: missing release.json, missing checkout hold, tampered topology, and damaged bound version (never fall back to v3).
  for (const scenario of ["missing_release_marker", "missing_checkout_hold", "tampered_manifest_topology", "damaged_bound_version"] as const) {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const v1Draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P1", agents: [{ node_id: "v1_node", persona: "builder", sub_task: "S1" }] };
    const v2Draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P2", agents: [{ node_id: "v2_node", persona: "builder", sub_task: "S2" }] };
    const v3Draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P3", agents: [{ node_id: "v3_node", persona: "builder", sub_task: "S3" }] };
    const fac = ops({ action: "publish", name: `guard-${scenario}`, draft: v1Draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-${scenario}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v2Draft, sessionModel });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-${scenario}`, brief: "Brief" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v3Draft, sessionModel });
    revokeManagerAuthority(auth);

    if (scenario === "missing_release_marker") {
      rmSync(join(launched.manifest.session_dir, "release.json"));
    } else if (scenario === "missing_checkout_hold") {
      const db = new DatabaseSync(coordinationPath);
      try { db.prepare("DELETE FROM checkout_holds WHERE factory_id = ?").run(fac.factory_id); } finally { db.close(); }
    } else if (scenario === "tampered_manifest_topology") {
      const manifestPath = join(launched.manifest.session_dir, "manifest.json");
      const raw = readJson<any>(manifestPath);
      raw.pane_manifest[0].node_id = "v3_node";
      atomicJson(manifestPath, raw);
    } else if (scenario === "damaged_bound_version") {
      const db = new DatabaseSync(statePath);
      try { db.prepare("UPDATE factory_versions SET definition = '{corrupt-v2' WHERE factory_id = ? AND version = 'v2'").run(fac.factory_id); } finally { db.close(); }
    }

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain", scenario);
        assert.equal(live.run, null, scenario);
        assert.equal(live.graph.evidence, "unavailable", scenario);
        assert.equal(live.graph.absence, "evidence unavailable", scenario);
        assert.equal("nodes" in live.graph, false, scenario);
        assert.equal(live.current_version, "v3", scenario);
      },
    );
  }

  // 4. Defense-in-depth release/capacity/identity guards fail closed to uncertain if reader evidence contradicts.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P1", agents: [{ node_id: "build", persona: "builder", sub_task: "S1" }] };
    const fac = ops({ action: "publish", name: "defense-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-defense" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-def", brief: "Brief" });
    await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const perturbations = [
      "checkout_not_held",
      "factory_not_held",
      "foreign_release_factory",
      "mismatched_release_attempt",
      "mismatched_release_bound_version",
      "mismatched_release_task_id",
      "mismatched_manifest_attempt_id",
      "non_released_active_state",
    ] as const;
    for (const mode of perturbations) {
      await verifyReadOnlyViewer(
        {
          stateDirs: f.root,
          viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
          start: opts => startViewer(opts, {
            createReader: readerOpts => {
              const inner = createViewerReader(readerOpts);
              return {
                ...inner,
                inspectLive: (id: string) => {
                  const { inspection, releases } = inner.inspectLive(id);
                  const cloneInsp = structuredClone(inspection);
                  const cloneRel = structuredClone(releases);
                  if (mode === "checkout_not_held") cloneInsp.capacity.checkout_slot = "free";
                  else if (mode === "factory_not_held") cloneInsp.capacity.factory_slot = "free";
                  else if (mode === "foreign_release_factory") cloneRel[0]!.manifest.factory_managed!.factory_id = "other_fac";
                  else if (mode === "mismatched_release_attempt") cloneRel[0]!.attempt_id = "other-att";
                  else if (mode === "mismatched_release_bound_version") cloneRel[0]!.bound_version = "v99";
                  else if (mode === "mismatched_release_task_id") cloneRel[0]!.manifest.task_id = "other-task";
                  else if (mode === "mismatched_manifest_attempt_id") cloneRel[0]!.manifest.factory_managed!.attempt_id = "other-att";
                  else if (mode === "non_released_active_state") cloneInsp.attempts[0]!.state = "settled";
                  return { inspection: cloneInsp, releases: cloneRel };
                },
              };
            },
          }),
        },
        async viewer => {
          const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
          assert.equal(live.state, "uncertain", mode);
          assert.equal(live.run, null, mode);
          assert.equal(live.graph.evidence, "unavailable", mode);
          assert.equal(live.graph.absence, "evidence unavailable", mode);
        },
      );
    }
  }
});

test("Viewing Live Graph and all viewer routes never repairs, cleans up, or touches an eligible standalone run", async t => {
  const f = serviceFixture(t, ["builder"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const viewerEnv = { PATH: join(f.root, "bin") };

  // Create a standalone run in the same checkout/stateDir that is immediately eligible for automatic cleanup.
  const standalone = await f.service.generate({
    project_cwd: f.cwd,
    topology: "graph",
    cleanup: "on_success",
    cleanup_settle_ms: 0,
    task: "PRIVATE_STANDALONE_TASK",
    agents: [{ node_id: "solo", persona: "builder", sub_task: "PRIVATE_STANDALONE_SUB" }],
  }, sessionModel);
  const soloEntry = standalone.pane_manifest[0]!;
  const soloCfg = readJson<WorkerConfig>(join(standalone.session_dir, `${soloEntry.instance_id}.config.json`));
  atomicJson(
    resultPath(standalone.session_dir, soloEntry.instance_id),
    completionRecord(soloCfg, { agent_name: soloEntry.persona_name, node_id: "solo", status: "success", summary: "Standalone done", detail: "PRIVATE_STANDALONE_DETAIL" }, "not_required", "2026-01-01T00:00:00.000Z"),
  );
  // Pre-verify standalone run is still "applied" before viewer runs.
  assert.equal(f.service.status(standalone.task_id, f.cwd).manifest.status, "applied");

  // Also publish and launch a factory in the same state root.
  const fac = ops({
    action: "publish",
    name: "standalone-isolation-fac",
    draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE_FAC_TASK", agents: [{ node_id: "work", persona: "builder", sub_task: "PRIVATE_FAC_SUB" }] },
    sessionModel,
  });
  const auth = createManagerAuthority({ pi_session_id: "sess-standalone-iso" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-standalone", brief: "PRIVATE_FAC_BRIEF" });
  await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  revokeManagerAuthority(auth);

  await verifyReadOnlyViewer(
    { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
    async viewer => {
      for (let i = 0; i < 3; i++) {
        const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
        assert.equal(liveRes.status, 200);
        const liveText = await liveRes.text();
        assert.equal(liveText.includes(standalone.task_id), false);
        assert.equal(liveText.includes("PRIVATE_"), false);
        const live = JSON.parse(liveText);
        assert.equal(live.state, "running");
        assert.deepEqual(live.graph.nodes.map((n: any) => n.id), ["work"]);
        assert.equal((await fetch(`${viewer.url}/api/factories/${fac.factory_id}/inspect`)).status, 200);
        assert.equal((await fetch(`${viewer.url}/api/factories/${fac.factory_id}/queue?filter=all`)).status, 200);
      }
    },
  );

  // Standalone run remained untouched ("applied", not "cleaned").
  const afterView = f.service.status(standalone.task_id, f.cwd);
  assert.equal(afterView.manifest.status, "applied");
  assert.equal(afterView.manifest.cleanup_trigger, undefined);

  // Positive control: prove the standalone run truly WAS eligible for automatic cleanup when statusWithCleanup is called.
  const cleaned = await f.service.statusWithCleanup(standalone.task_id, f.cwd);
  assert.equal(cleaned.manifest.status, "cleaned");
  assert.equal(cleaned.manifest.cleanup_trigger, "auto");
});

test("Live Graph reports graph.absence as not applicable for a settled historical run", async t => {
  const f = serviceFixture(t, ["builder"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_SETTLED_TASK",
    agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_SETTLED_SUB" }],
  };
  const fac = ops({ action: "publish", name: "settled-live-fac", draft, sessionModel });
  const auth = createManagerAuthority({ pi_session_id: "sess-settled-live" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-settled-live", brief: "PRIVATE_SETTLED_BRIEF" });
  const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  const entry = launched.manifest.pane_manifest[0]!;
  const cfg = readJson<WorkerConfig>(join(launched.manifest.session_dir, `${entry.instance_id}.config.json`));
  atomicJson(
    resultPath(launched.manifest.session_dir, entry.instance_id),
    completionRecord(cfg, { agent_name: entry.persona_name, node_id: "build", status: "success", summary: "Done", detail: "PRIVATE_DETAIL" }, "not_required", "2026-01-01T00:00:01.000Z"),
  );
  const settled = await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
  assert.equal(settled.settled, true, settled.reason);
  revokeManagerAuthority(auth);

  await verifyReadOnlyViewer(
    { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
    async viewer => {
      const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
      assert.equal(res.status, 200);
      const live = await res.json() as any;
      assert.equal(live.state, "ended");
      assert.deepEqual(live.run, { run_id: launched.task_id, attempt_id: launched.attempt_id, bound_version: "v1" });
      assert.equal(live.outcome, "succeeded");
      assert.equal(live.settlement, "settled");
      assert.equal(live.capacity_release, "released");
      assert.equal(live.graph.evidence, "not applicable");
      assert.equal(live.graph.absence, "not applicable");
    },
  );
});

test("Live Graph refuses FIFOs, symlinks, and oversized handoff files (offer, rejections, recovery, claim, and source result) in a child watchdog without blocking", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // Part A: Non-review graph (src -> dest) testing offer, rejections, recovery, claim, and source result guards.
  for (const mode of [
    "offer_fifo",
    "offer_symlink",
    "rejections_fifo",
    "rejections_symlink",
    "recovery_fifo",
    "recovery_symlink",
    "recovery_oversized",
    "source_result_fifo",
    "source_result_symlink",
    "claim_fifo",
    "claim_symlink",
  ] as const) {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_HANDOFF_${mode}`,
      agents: [
        { node_id: "src", persona: "builder", sub_task: "PRIVATE_SRC" },
        { node_id: "dest", persona: "builder", sub_task: "PRIVATE_DEST", depends_on: ["src"] },
      ],
    };
    const fac = ops({ action: "publish", name: `handoff-guard-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-hg-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-hg-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const srcEntry = launched.manifest.pane_manifest.find(e => e.node_id === "src")!;
    const destEntry = launched.manifest.pane_manifest.find(e => e.node_id === "dest")!;
    const srcCfg = readJson<WorkerConfig>(join(dir, `${srcEntry.instance_id}.config.json`));
    const srcCompletion = completionRecord(
      srcCfg,
      { agent_name: srcEntry.persona_name, node_id: "src", status: "success", summary: "Src done", detail: "PRIVATE_SRC_DETAIL" },
      "sent",
      "2026-01-01T00:00:01.000Z",
    );
    const digest = inputDigest(srcCompletion.result);
    const srcResPath = resultPath(dir, srcEntry.instance_id);
    const offerPath = handoffOfferPath(dir, destEntry.instance_id, srcEntry.instance_id);
    const claimPath = handoffClaimPath(dir, destEntry.instance_id, srcEntry.instance_id);
    const rejPath = handoffRejectionsPath(dir, destEntry.instance_id, srcEntry.instance_id);
    const recPath = handoffRecoveryPath(dir, destEntry.instance_id, srcEntry.instance_id);

    const offerPayload = {
      version: 1,
      handoff_id: `hoff-${mode}`,
      run_id: launched.task_id,
      state: "queued",
      source: { node_id: "src", attempt_id: srcEntry.attempt_id!, instance_id: srcEntry.instance_id, persona_name: srcEntry.persona_name },
      destination: { node_id: "dest", attempt_id: destEntry.attempt_id!, instance_id: destEntry.instance_id },
      input_digest: digest,
      result_path: srcResPath,
      offered_at: "2026-01-01T00:00:01.000Z",
      queued_at: "2026-01-01T00:00:01.000Z",
    };
    const claimPayload = {
      version: 1,
      handoff_id: `hoff-${mode}`,
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "src", attempt_id: srcEntry.attempt_id!, instance_id: srcEntry.instance_id, session_id: "sess-src" },
      destination: { node_id: "dest", attempt_id: destEntry.attempt_id!, instance_id: destEntry.instance_id },
      input_digest: digest,
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    };

    if (mode === "offer_fifo") {
      execFileSync("mkfifo", [offerPath]);
    } else if (mode === "offer_symlink") {
      const outsideOffer = join(f.root, "outside-offer.json");
      atomicJson(outsideOffer, { ...offerPayload, secret: "PRIVATE_OFFER_LEAK" });
      symlinkSync(outsideOffer, offerPath);
    } else {
      atomicJson(offerPath, offerPayload);
    }

    if (mode === "claim_fifo") {
      execFileSync("mkfifo", [claimPath]);
      atomicJson(srcResPath, srcCompletion);
    } else if (mode === "claim_symlink") {
      const outsideClaim = join(f.root, "outside-claim.json");
      atomicJson(outsideClaim, claimPayload);
      symlinkSync(outsideClaim, claimPath);
      atomicJson(srcResPath, srcCompletion);
    } else {
      if (mode !== "rejections_fifo" && mode !== "rejections_symlink") {
        atomicJson(claimPath, claimPayload);
      }
      if (mode === "source_result_fifo") {
        execFileSync("mkfifo", [srcResPath]);
      } else if (mode === "source_result_symlink") {
        const outsideRes = join(f.root, "outside-src-result.json");
        atomicJson(outsideRes, srcCompletion);
        symlinkSync(outsideRes, srcResPath);
      } else {
        atomicJson(srcResPath, srcCompletion);
      }
    }

    if (mode === "rejections_fifo") {
      execFileSync("mkfifo", [rejPath]);
    } else if (mode === "rejections_symlink") {
      const outsideRej = join(f.root, "outside-rejections.json");
      atomicJson(outsideRej, {
        version: 1,
        rejections: [{ at: "2026-01-01T00:00:01.000Z", kind: "input", severity: "notification", reason: "PRIVATE_REJ_LEAK" }],
      });
      symlinkSync(outsideRej, rejPath);
    }

    if (mode === "recovery_fifo") {
      execFileSync("mkfifo", [recPath]);
    } else if (mode === "recovery_symlink") {
      const outsideRec = join(f.root, "outside-recovery.json");
      atomicJson(outsideRec, { version: 1, retries: [], secret: "PRIVATE_REC_LEAK" });
      symlinkSync(outsideRec, recPath);
    } else if (mode === "recovery_oversized") {
      const validRec = JSON.stringify({
        version: 1,
        handoff_id: `hoff-${mode}`,
        run_id: launched.task_id,
        input_digest: digest,
        source: srcEntry.instance_id,
        destination: destEntry.instance_id,
        retries: [],
      });
      writeFileSync(recPath, validRec + " ".repeat(1_200_000));
    }

    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, mode);
      assert.equal(res!.text.includes("PRIVATE_"), false, `${mode} leaked sentinel`);
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      const dest = byId.get("dest");
      assert.equal(dest.status, "needs_attention", mode);
      assert.equal(dest.status_text, "Uncertain", mode);
      assert.match(dest.reason, /handoff/i, mode);
      if (mode === "source_result_fifo" || mode === "source_result_symlink") {
        const edge = live.graph.edges.find((e: any) => e.from === "src" && e.to === "dest");
        assert.equal(edge.state, "pending", mode);
      }
    } finally {
      for (const p of [offerPath, rejPath, recPath, srcResPath, claimPath]) {
        try { rmSync(p, { force: true }); } catch { /* ignore */ }
      }
    }
  }

  // Part B: Review-loop run where claim points to an earlier source attempt (build.1.result.json) that is a FIFO or symlink while build is on attempt 2.
  for (const mode of ["attempt_source_result_fifo", "attempt_source_result_symlink"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_RL_${mode}`,
      agents: [
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_RL_BUILD" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_RL_REV",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: `rl-src-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-rl-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-rl-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
    const build1Completion = completionRecord(
      buildCfg,
      { agent_name: buildEntry.persona_name, node_id: "build", status: "success", summary: "Build 1", detail: "PRIVATE_B1" },
      "sent",
      "2026-01-01T00:00:01.000Z",
    );
    const digest = inputDigest(build1Completion.result);

    // Advance build to attempt 2 via revision reservation + feedback claim so nodeObservation(build) checks build.2, NOT build.1.
    atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
      version: 1,
      run_id: launched.task_id,
      reviewer: reviewEntry.instance_id,
      attempt: 2,
    });
    atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.2`, reviewEntry.instance_id), {
      version: 1,
      handoff_id: `hoff-fb-${mode}`,
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id, session_id: "sess-rev" },
      destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
      input_digest: "0".repeat(64),
      offer: "matched",
      accepted_at: "2026-01-01T00:00:03.000Z",
    });

    // Review attempt 1 has a claim pointing back to build.1.
    const build1ResPath = resultPath(dir, `${buildEntry.instance_id}.1`);
    atomicJson(handoffOfferPath(dir, `${reviewEntry.instance_id}.1`, buildEntry.instance_id), {
      version: 1,
      handoff_id: `hoff-r1-${mode}`,
      run_id: launched.task_id,
      state: "queued",
      source: { node_id: "build", attempt_id: `${buildEntry.instance_id}.1`, instance_id: buildEntry.instance_id, persona_name: buildEntry.persona_name },
      destination: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id },
      input_digest: digest,
      result_path: build1ResPath,
      offered_at: "2026-01-01T00:00:01.000Z",
      queued_at: "2026-01-01T00:00:01.000Z",
    });
    atomicJson(handoffClaimPath(dir, `${reviewEntry.instance_id}.1`, buildEntry.instance_id), {
      version: 1,
      handoff_id: `hoff-r1-${mode}`,
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "build", attempt_id: `${buildEntry.instance_id}.1`, instance_id: buildEntry.instance_id, session_id: "sess-build" },
      destination: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id },
      input_digest: digest,
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    });

    if (mode === "attempt_source_result_fifo") {
      execFileSync("mkfifo", [build1ResPath]);
    } else {
      const outsideB1 = join(f.root, "outside-build1.json");
      atomicJson(outsideB1, build1Completion);
      symlinkSync(outsideB1, build1ResPath);
    }

    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, mode);
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      const review = byId.get("review");
      assert.equal(review.status, "needs_attention", mode);
      assert.equal(review.status_text, "Uncertain", mode);
    } finally {
      try { rmSync(build1ResPath, { force: true }); } catch { /* ignore */ }
    }
  }
});

test("Live Graph fails closed to Uncertain on foreign readiness/progress, mismatched progress attempt, symlinked session_dir, review-loop file checks, and finalization mismatch", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. Non-review-plan guards: foreign readiness (token/task/instance), foreign progress, mismatched progress attempt_id (Item 10), and symlinked session_dir.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_NODE_GUARDS",
      agents: [
        { node_id: "bad_ready_tok", persona: "builder", sub_task: "PRIVATE_1" },
        { node_id: "bad_ready_task", persona: "builder", sub_task: "PRIVATE_2" },
        { node_id: "bad_ready_inst", persona: "builder", sub_task: "PRIVATE_3" },
        { node_id: "bad_prog_tok", persona: "builder", sub_task: "PRIVATE_4" },
        { node_id: "bad_prog_att", persona: "builder", sub_task: "PRIVATE_5" },
        { node_id: "pend_node", persona: "builder", sub_task: "PRIVATE_6" },
      ],
    };
    const fac = ops({ action: "publish", name: "node-guards-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-node-guards" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-ng", brief: "PRIVATE_NG_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const entryOf = (id: string) => launched.manifest.pane_manifest.find(e => e.node_id === id)!;
    const writeReadyFields = (entry: ReturnType<typeof entryOf>, overrides: Partial<{ token: string; task_id: string; instance_id: string }> = {}) => {
      atomicJson(readyPath(dir, entry.instance_id), {
        version: 2,
        direction_incarnation: `inc-${entry.instance_id}`,
        task_id: overrides.task_id ?? launched.task_id,
        token: overrides.token ?? launched.manifest.token,
        instance_id: overrides.instance_id ?? entry.instance_id,
        pid: process.pid,
        session_id: `sess-${entry.instance_id}`,
        name: entry.instance_id,
        endpoint: "/tmp/fake-coms",
        model: "test-provider/test-model",
      });
    };
    const writeProgress = (entry: ReturnType<typeof entryOf>, overrides: Record<string, unknown> = {}) => {
      atomicJson(join(dir, `${entry.instance_id}.progress.json`), {
        token: launched.manifest.token,
        updated_at: Date.now(),
        started_at: Date.now() - 1000,
        state: "working",
        ...overrides,
      });
    };

    const eTok = entryOf("bad_ready_tok");
    writeReadyFields(eTok, { token: "foreign-token" });
    writeProgress(eTok);

    const eTask = entryOf("bad_ready_task");
    writeReadyFields(eTask, { task_id: "foreign-task-id" });
    writeProgress(eTask);

    const eInst = entryOf("bad_ready_inst");
    writeReadyFields(eInst, { instance_id: "foreign-instance-id" });
    writeProgress(eInst);

    const eProgTok = entryOf("bad_prog_tok");
    writeReadyFields(eProgTok);
    writeProgress(eProgTok, { token: "foreign-token" });

    const eProgAtt = entryOf("bad_prog_att");
    writeReadyFields(eProgAtt);
    writeProgress(eProgAtt, { attempt_id: "wrong-attempt-id" });

    // Remove ready.json on pend_node so it has no node-level evidence files; only line 95 assertNoSymlinkPath(dir) catches symlinked session_dir.
    rmSync(readyPath(dir, entryOf("pend_node").instance_id), { force: true });

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
        assert.equal(res.status, 200);
        const live = await res.json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        for (const id of ["bad_ready_tok", "bad_ready_task", "bad_ready_inst", "bad_prog_tok", "bad_prog_att"]) {
          const node = byId.get(id);
          assert.equal(node.status, "needs_attention", id);
          assert.equal(node.status_text, "Uncertain", id);
          assert.ok(typeof node.reason === "string" && node.reason.length > 0, id);
        }
        assert.equal(byId.get("pend_node").status, "pending");
      },
    );

    // Symlinked session_dir passed to nodeObservation catches even a bare pending node (line 95).
    const symlinkDir = join(f.root, "symlinked-session-dir");
    symlinkSync(dir, symlinkDir);
    await verifyReadOnlyViewer(
      {
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        start: opts => startViewer(opts, {
          createReader: readerOpts => {
            const inner = createViewerReader(readerOpts);
            return {
              ...inner,
              inspectLive: (id: string) => {
                const res = inner.inspectLive(id);
                const cloneRel = structuredClone(res.releases);
                cloneRel[0]!.manifest.session_dir = symlinkDir;
                return { inspection: res.inspection, releases: cloneRel };
              },
            };
          },
        }),
      },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        const pend = byId.get("pend_node");
        assert.equal(pend.status, "needs_attention");
        assert.equal(pend.status_text, "Uncertain");
      },
    );
  }

  // 2. Review-loop guards: progress attempt match, finalization mismatch (~118-119), and review-loop file checks (~96-110).
  for (const mode of [
    "rl_mismatched_progress",
    "rl_missing_progress_attempt",
    "rl_finalization_mismatch",
    "rl_symlink_feedback_claim",
    "rl_symlink_revision_claim",
    "rl_fifo_feedback_claim",
    "rl_symlink_finalize",
    "rl_symlink_transition",
    "rl_symlink_revision",
  ] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_RLG_${mode}`,
      agents: [
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_RLG_B" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_RLG_R",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: `rl-guard-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-rlg-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-rlg-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    const cleanupPaths: string[] = [];
    let targetNodeId = "build";

    if (mode === "rl_mismatched_progress" || mode === "rl_missing_progress_attempt") {
      atomicJson(readyPath(dir, buildEntry.instance_id), {
        version: 2,
        direction_incarnation: "inc-b",
        task_id: launched.task_id,
        token: launched.manifest.token,
        instance_id: buildEntry.instance_id,
        pid: process.pid,
        session_id: "sess-b",
        name: buildEntry.instance_id,
        endpoint: "/tmp/fake-coms",
        model: "test-provider/test-model",
      });
      atomicJson(join(dir, `${buildEntry.instance_id}.progress.json`), {
        token: launched.manifest.token,
        ...(mode === "rl_mismatched_progress" ? { attempt_id: "wrong-attempt" } : {}),
        updated_at: Date.now(),
        started_at: Date.now() - 1000,
        state: "working",
      });
    } else if (mode === "rl_finalization_mismatch") {
      const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
      atomicJson(
        resultPath(dir, `${buildEntry.instance_id}.1`),
        completionRecord(buildCfg, { agent_name: buildEntry.persona_name, node_id: "build", status: "success", summary: "Built 1", detail: "PRIVATE_D" }, "not_required", "2026-01-01T00:00:01.000Z"),
      );
      atomicJson(finalizePath(dir, buildEntry.instance_id), {
        version: 1,
        run_id: launched.task_id,
        instance_id: buildEntry.instance_id,
        attempt_id: `${buildEntry.instance_id}.2`,
        finalized_by: reviewEntry.instance_id,
      });
    } else if (mode === "rl_symlink_feedback_claim" || mode === "rl_fifo_feedback_claim") {
      atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
        version: 1,
        run_id: launched.task_id,
        reviewer: reviewEntry.instance_id,
        attempt: 2,
      });
      const fbClaim = handoffClaimPath(dir, `${buildEntry.instance_id}.2`, reviewEntry.instance_id);
      cleanupPaths.push(fbClaim);
      if (mode === "rl_fifo_feedback_claim") {
        execFileSync("mkfifo", [fbClaim]);
      } else {
        const outside = join(f.root, "outside-fb-claim.json");
        atomicJson(outside, {
          version: 1,
          handoff_id: "hoff-fb-sym",
          state: "accepted",
          run_id: launched.task_id,
          source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id, session_id: "sess-rev" },
          destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
          input_digest: "0".repeat(64),
          offer: "matched",
          accepted_at: "2026-01-01T00:00:02.000Z",
        });
        symlinkSync(outside, fbClaim);
      }
    } else if (mode === "rl_symlink_revision_claim") {
      targetNodeId = "review";
      atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
        version: 1,
        run_id: launched.task_id,
        reviewer: reviewEntry.instance_id,
        attempt: 2,
      });
      const revClaim = handoffClaimPath(dir, `${reviewEntry.instance_id}.2`, buildEntry.instance_id);
      cleanupPaths.push(revClaim);
      const outside = join(f.root, "outside-rev-claim.json");
      atomicJson(outside, {
        version: 1,
        handoff_id: "hoff-rev-sym",
        state: "accepted",
        run_id: launched.task_id,
        source: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id, session_id: "sess-b" },
        destination: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.2`, instance_id: reviewEntry.instance_id },
        input_digest: "0".repeat(64),
        offer: "matched",
        accepted_at: "2026-01-01T00:00:02.000Z",
      });
      symlinkSync(outside, revClaim);
    } else if (mode === "rl_symlink_finalize") {
      const fin = finalizePath(dir, buildEntry.instance_id);
      cleanupPaths.push(fin);
      const outside = join(f.root, "outside-fin.json");
      atomicJson(outside, {
        version: 1,
        run_id: launched.task_id,
        instance_id: buildEntry.instance_id,
        attempt_id: `${buildEntry.instance_id}.1`,
        finalized_by: reviewEntry.instance_id,
      });
      symlinkSync(outside, fin);
    } else if (mode === "rl_symlink_transition") {
      const trans = join(dir, `${buildEntry.instance_id}.1.transition.json`);
      cleanupPaths.push(trans);
      const outside = join(f.root, "outside-trans.json");
      atomicJson(outside, {
        version: 1,
        run_id: launched.task_id,
        instance_id: buildEntry.instance_id,
        from_attempt: 1,
        winner: "finalized",
      });
      symlinkSync(outside, trans);
    } else if (mode === "rl_symlink_revision") {
      const rev = join(dir, `${reviewEntry.instance_id}.2.revision.json`);
      cleanupPaths.push(rev);
      const outside = join(f.root, "outside-rev.json");
      atomicJson(outside, {
        version: 1,
        run_id: launched.task_id,
        reviewer: reviewEntry.instance_id,
        attempt: 2,
      });
      symlinkSync(outside, rev);
    }

    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, mode);
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      const target = byId.get(targetNodeId);
      assert.equal(target.status, "needs_attention", mode);
      assert.equal(target.status_text, "Uncertain", mode);
      assert.ok(typeof target.reason === "string" && target.reason.length > 0, mode);
    } finally {
      for (const p of cleanupPaths) {
        try { rmSync(p, { force: true }); } catch { /* ignore */ }
      }
    }
  }
});

test("Live Graph projectGraph guards fail closed on mismatched bound_version, topology, roster, duplicate ids, review plan, kind, and inbound edges", async t => {
  const f = serviceFixture(t, ["builder", "reviewer"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  const draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_PG_TASK",
    agents: [
      { node_id: "build", persona: "builder", sub_task: "PRIVATE_PG_B" },
      {
        node_id: "review",
        persona: "reviewer",
        sub_task: "PRIVATE_PG_R",
        depends_on: ["build"],
        output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
        decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 },
      },
    ],
  };
  const fac = ops({ action: "publish", name: "project-graph-guards-fac", draft, sessionModel });
  const auth = createManagerAuthority({ pi_session_id: "sess-pg-guards" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-pg", brief: "PRIVATE_PG_BRIEF" });
  await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  revokeManagerAuthority(auth);

  const modes = [
    "mismatched_manifest_bound_version",
    "different_topology",
    "different_roster_length",
    "duplicate_node_id",
    "duplicate_instance_id",
    "mismatched_review_plan",
    "missing_review_plan",
    "different_node_id",
    "kind_mismatch",
    "inbound_edge_mismatch",
  ] as const;

  for (const mode of modes) {
    await verifyReadOnlyViewer(
      {
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        start: opts => startViewer(opts, {
          createReader: readerOpts => {
            const inner = createViewerReader(readerOpts);
            return {
              ...inner,
              inspectLive: (id: string) => {
                const { inspection, releases } = inner.inspectLive(id);
                const cloneInsp = structuredClone(inspection);
                const cloneRel = structuredClone(releases);
                const m = cloneRel[0]!.manifest;
                if (mode === "mismatched_manifest_bound_version") {
                  m.factory_managed!.bound_version = "v99";
                } else if (mode === "different_topology") {
                  m.topology = "chain";
                } else if (mode === "different_roster_length") {
                  m.pane_manifest.push({ ...m.pane_manifest[0]!, node_id: "extra", instance_id: "a3-extra" });
                } else if (mode === "duplicate_node_id") {
                  m.pane_manifest[1]!.node_id = m.pane_manifest[0]!.node_id;
                } else if (mode === "duplicate_instance_id") {
                  m.pane_manifest[1]!.instance_id = m.pane_manifest[0]!.instance_id;
                } else if (mode === "mismatched_review_plan") {
                  m.review_plan!.loops[0]!.max_revisions = 99;
                } else if (mode === "missing_review_plan") {
                  m.review_plan = undefined;
                } else if (mode === "different_node_id") {
                  m.pane_manifest[0]!.node_id = "other_node";
                } else if (mode === "kind_mismatch") {
                  m.pane_manifest[0]!.kind = "command";
                } else if (mode === "inbound_edge_mismatch") {
                  m.pane_manifest[1]!.depends_on = [];
                  m.pane_manifest[1]!.inbound_edges = [];
                }
                return { inspection: cloneInsp, releases: cloneRel };
              },
            };
          },
        }),
      },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain", mode);
        assert.equal(live.run, null, mode);
        assert.equal(live.graph.evidence, "unavailable", mode);
        assert.equal(live.graph.absence, "evidence unavailable", mode);
        assert.equal("nodes" in live.graph, false, mode);
      },
    );
  }

  // Independent two-node run with duplicate instance_id (no edges/review_plan) specifically exercises line 509 byInstance.size check.
  {
    const fDup = serviceFixture(t, ["builder"]);
    const dupState = join(fDup.root, "factories.sqlite");
    const dupCoord = join(fDup.root, "factory-coordination.sqlite");
    const dupOps = factoryOperations(dupState, fDup.service, { coordinationPath: dupCoord });
    const dupDraft: GenerateRequest = {
      project_cwd: fDup.cwd,
      topology: "graph",
      task: "P_DUP",
      agents: [
        { node_id: "alpha", persona: "builder", sub_task: "S1" },
        { node_id: "beta", persona: "builder", sub_task: "S2" },
      ],
    };
    const dupFac = dupOps({ action: "publish", name: "dup-inst-fac", draft: dupDraft, sessionModel });
    const dupAuth = createManagerAuthority({ pi_session_id: "sess-dup-inst" });
    dupOps({ action: "resume", factory_id: dupFac.factory_id, authority: dupAuth });
    dupOps({ action: "submit", factory_id: dupFac.factory_id, authority: dupAuth, reference: "ref-dup", brief: "Brief" });
    await dupOps({ action: "launch", factory_id: dupFac.factory_id, authority: dupAuth });
    revokeManagerAuthority(dupAuth);

    await verifyReadOnlyViewer(
      {
        stateDirs: fDup.root,
        viewerOptions: { statePath: dupState, coordinationPath: dupCoord, env: { PATH: join(fDup.root, "bin") }, home: fDup.home },
        start: opts => startViewer(opts, {
          createReader: readerOpts => {
            const inner = createViewerReader(readerOpts);
            return {
              ...inner,
              inspectLive: (id: string) => {
                const { inspection, releases } = inner.inspectLive(id);
                const cloneRel = structuredClone(releases);
                cloneRel[0]!.manifest.pane_manifest[1]!.instance_id = cloneRel[0]!.manifest.pane_manifest[0]!.instance_id;
                return { inspection, releases: cloneRel };
              },
            };
          },
        }),
      },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${dupFac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain", "independent duplicate_instance_id");
        assert.equal(live.run, null);
        assert.equal(live.graph.evidence, "unavailable");
        assert.equal(live.graph.absence, "evidence unavailable");
      },
    );
  }
});

test("Live Graph liveSnapshot guards cover unreleased uncertainty, multiple active authorized attempts, and historical attempt filters", async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. L21 (~764): unreleased factory whose evidence is uncertain (damaged current_version + uncertain hold).
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P1", agents: [{ node_id: "build", persona: "builder", sub_task: "S1" }] };
    const fac = ops({ action: "publish", name: "unreleased-uncertain-fac", draft, sessionModel });
    const db = new DatabaseSync(statePath);
    try {
      db.prepare("UPDATE factory_versions SET definition = '{corrupt-v1' WHERE factory_id = ? AND version = 'v1'").run(fac.factory_id);
    } finally { db.close(); }

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain");
        assert.equal(live.run, null);
        assert.equal(live.graph.evidence, "unavailable");
        assert.equal(live.graph.absence, "evidence unavailable");
      },
    );
  }

  // 2. L01 (~733): exactly one authorized active attempt (two non-historical release_authorized attempts fail closed).
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P1", agents: [{ node_id: "build", persona: "builder", sub_task: "S1" }] };
    const fac = ops({ action: "publish", name: "two-auth-active-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-two-auth" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-two", brief: "Brief" });
    await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      {
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        start: opts => startViewer(opts, {
          createReader: readerOpts => {
            const inner = createViewerReader(readerOpts);
            return {
              ...inner,
              inspectLive: (id: string) => {
                const { inspection, releases } = inner.inspectLive(id);
                const cloneInsp = structuredClone(inspection);
                cloneInsp.attempts.push({ ...cloneInsp.attempts[0]!, attempt_id: "att-duplicate-active", historical: false, release_authorized: true, state: "settled" });
                return { inspection: cloneInsp, releases };
              },
            };
          },
        }),
      },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain");
        assert.equal(live.run, null);
        assert.equal(live.graph.evidence, "unavailable");
        assert.equal(live.graph.absence, "evidence unavailable");
      },
    );
  }

  // 3. L20 (~729): earlier settled (historical) run on v1 followed by new released run on v2 follows the new run.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const v1Draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P1", agents: [{ node_id: "old_step", persona: "builder", sub_task: "S1" }] };
    const v2Draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P2", agents: [{ node_id: "new_step", persona: "builder", sub_task: "S2" }] };
    const fac = ops({ action: "publish", name: "hist-then-new-fac", draft: v1Draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-hist-new" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-v1", brief: "Brief 1" });
    const run1 = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    const r1Entry = run1.manifest.pane_manifest[0]!;
    const r1Cfg = readJson<WorkerConfig>(join(run1.manifest.session_dir, `${r1Entry.instance_id}.config.json`));
    atomicJson(
      resultPath(run1.manifest.session_dir, r1Entry.instance_id),
      completionRecord(r1Cfg, { agent_name: r1Entry.persona_name, node_id: "old_step", status: "success", summary: "v1 done", detail: "PRIVATE" }, "not_required", "2026-01-01T00:00:01.000Z"),
    );
    const settled = await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
    assert.equal(settled.settled, true, settled.reason);

    ops({ action: "update", factory_id: fac.factory_id, authority: auth, draft: v2Draft, sessionModel });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-v2", brief: "Brief 2" });
    const run2 = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "running");
        assert.deepEqual(live.run, { run_id: run2.task_id, attempt_id: run2.attempt_id, bound_version: "v2" });
        assert.equal(live.graph.bound_version, "v2");
        assert.deepEqual(live.graph.nodes.map((n: any) => n.id), ["new_step"]);
      },
    );
  }

  // 4. L47 (~784): historical non-released attempt (proven_not_released) is ignored when checking active unreleased attempts.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const failingService = new BootstrapService({
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "create") {
          return { code: 1, stdout: "", stderr: "tab create failed before release" };
        }
        return { code: 0, stdout: JSON.stringify({ result: { pane: { workspace_id: "w" }, workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] } }), stderr: "" };
      },
      extensionDir: fileURLToPath(new URL("..", import.meta.url)),
      stateDir: join(f.root, "state-fail"),
      home: f.home,
      env: { PATH: join(f.root, "bin"), HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
    });
    const ops = factoryOperations(statePath, failingService, { coordinationPath });
    const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P_FBR", agents: [{ node_id: "build", persona: "builder", sub_task: "S1" }] };
    const fac = ops({ action: "publish", name: "hist-nonrel-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-hist-nonrel" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    const sub = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-hist-nonrel", brief: "Brief" });
    void sub;
    await assert.rejects(() => ops({ action: "launch", factory_id: fac.factory_id, authority: auth }), /tab create failed before release/);
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      {
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        start: opts => startViewer(opts, {
          createReader: readerOpts => {
            const inner = createViewerReader(readerOpts);
            return {
              ...inner,
              inspectLive: (id: string) => {
                const { inspection, releases } = inner.inspectLive(id);
                const cloneInsp = structuredClone(inspection);
                cloneInsp.attempts[0]!.historical = true;
                return { inspection: cloneInsp, releases };
              },
            };
          },
        }),
      },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "blocked");
        assert.equal(live.run, null);
        assert.equal(live.graph.evidence, "not applicable");
        assert.equal(live.graph.absence, "no records");
      },
    );
  }
});

test("Live Graph covers cancellation, resource closed, error file, entry.error, and ended run when all nodes are terminal", async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. Cancellation (cancelled + running cancelling), resource closed, error file, and entry.error.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_BRANCHES_TASK",
      agents: [
        { node_id: "cancelling_node", persona: "builder", sub_task: "PRIVATE_1" },
        { node_id: "cancelled_node", persona: "builder", sub_task: "PRIVATE_2" },
        { node_id: "closed_node", persona: "builder", sub_task: "PRIVATE_3" },
        { node_id: "err_file_node", persona: "builder", sub_task: "PRIVATE_4" },
        { node_id: "entry_err_node", persona: "builder", sub_task: "PRIVATE_5" },
      ],
    };
    const fac = ops({ action: "publish", name: "status-branches-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-branches" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-br", brief: "PRIVATE_BR_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const entryOf = (id: string) => launched.manifest.pane_manifest.find(e => e.node_id === id)!;

    // cancelling_node: alive + working progress + cancel record -> Running (cancelling)
    const cing = entryOf("cancelling_node");
    atomicJson(readyPath(dir, cing.instance_id), {
      version: 2,
      direction_incarnation: "inc-cing",
      task_id: launched.task_id,
      token: launched.manifest.token,
      instance_id: cing.instance_id,
      pid: process.pid,
      session_id: "sess-cing",
      name: cing.instance_id,
      endpoint: "/tmp/fake-coms",
      model: "test-provider/test-model",
    });
    atomicJson(join(dir, `${cing.instance_id}.progress.json`), {
      token: launched.manifest.token,
      updated_at: Date.now(),
      started_at: Date.now() - 1000,
      state: "working",
    });
    atomicJson(cancelPath(dir, cing.instance_id), {
      version: 1,
      identity: { run_id: launched.task_id, node_id: "cancelling_node", persona_name: cing.persona_name, attempt_id: cing.attempt_id, instance_id: cing.instance_id },
      scope: "node",
      reason: "Operator stopping node",
      requested_at: "2026-01-01T00:00:01.000Z",
      grace_ms: 5000,
      force_close_after: "2026-01-01T00:00:06.000Z",
    });

    // cancelled_node: cancel record without working progress -> Cancelled
    const ced = entryOf("cancelled_node");
    atomicJson(cancelPath(dir, ced.instance_id), {
      version: 1,
      identity: { run_id: launched.task_id, node_id: "cancelled_node", persona_name: ced.persona_name, attempt_id: ced.attempt_id, instance_id: ced.instance_id },
      scope: "node",
      reason: "Operator cancelled node",
      requested_at: "2026-01-01T00:00:01.000Z",
      grace_ms: 5000,
      force_close_after: "2026-01-01T00:00:06.000Z",
    });

    // err_file_node: <key>.error.json -> Uncertain without leaking raw error message
    const errFileEntry = entryOf("err_file_node");
    atomicJson(join(dir, `${errFileEntry.instance_id}.error.json`), { error: "PRIVATE_NODE_FILE_ERR" });

    // closed_node (status: "closed") and entry_err_node (error: "PRIVATE_ENTRY_ERR") in manifest.json
    const manifestPath = join(dir, "manifest.json");
    const manifest = readJson<any>(manifestPath);
    manifest.pane_manifest.find((e: any) => e.node_id === "closed_node").status = "closed";
    manifest.pane_manifest.find((e: any) => e.node_id === "entry_err_node").error = "PRIVATE_ENTRY_ERR";
    atomicJson(manifestPath, manifest);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text.includes("PRIVATE_"), false, "leaked private sentinel");
        const live = JSON.parse(text);
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));

        assert.equal(byId.get("cancelling_node").status, "running");
        assert.equal(byId.get("cancelling_node").status_text, "Running (cancelling)");
        assert.match(byId.get("cancelling_node").reason, /cancellation requested/i);

        assert.equal(byId.get("cancelled_node").status, "cancelled");
        assert.equal(byId.get("cancelled_node").status_text, "Cancelled");
        assert.equal(byId.get("cancelled_node").reason, "Operator cancelled node");

        assert.equal(byId.get("closed_node").status, "needs_attention");
        assert.equal(byId.get("closed_node").status_text, "Uncertain");
        assert.match(byId.get("closed_node").reason, /resource closed/i);

        assert.equal(byId.get("err_file_node").status, "needs_attention");
        assert.equal(byId.get("err_file_node").status_text, "Uncertain");
        assert.match(byId.get("err_file_node").reason, /execution error/i);

        assert.equal(byId.get("entry_err_node").status, "needs_attention");
        assert.equal(byId.get("entry_err_node").status_text, "Uncertain");
        assert.match(byId.get("entry_err_node").reason, /launch recorded an error/i);
      },
    );
  }

  // 2. L46 (~752): released run with all nodes terminal becomes state: "ended" while capacity is still held.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "P_ENDED",
      agents: [{ node_id: "only_node", persona: "builder", sub_task: "S1" }],
    };
    const fac = ops({ action: "publish", name: "ended-held-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-ended-held" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-ended", brief: "Brief" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const entry = launched.manifest.pane_manifest[0]!;
    const cfg = readJson<WorkerConfig>(join(launched.manifest.session_dir, `${entry.instance_id}.config.json`));
    atomicJson(
      resultPath(launched.manifest.session_dir, entry.instance_id),
      completionRecord(cfg, { agent_name: entry.persona_name, node_id: "only_node", status: "success", summary: "Done", detail: "PRIVATE" }, "not_required", "2026-01-01T00:00:01.000Z"),
    );

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "ended");
        assert.equal(live.reason, "All nodes have recorded terminal outcomes.");
        assert.equal(live.outcome, "succeeded");
        assert.equal(live.capacity_release, "held");
        assert.equal(live.graph.evidence, "available");
        assert.equal(live.graph.nodes[0].status, "succeeded");
      },
    );
  }
});

test("Live Graph allows prior completed progress in a review loop and fails closed on non-completed mismatched progress", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };
  for (const state of ["completed", "working"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_PROG_${state}`,
      agents: [
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_B" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_R",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: `prog-exc-${state}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-pe-${state}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-pe-${state}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
    atomicJson(
      resultPath(dir, `${buildEntry.instance_id}.1`),
      completionRecord(buildCfg, { agent_name: buildEntry.persona_name, node_id: "build", status: "success", summary: "Build 1", detail: "PRIVATE" }, "sent", "2026-01-01T00:00:01.000Z"),
    );
    atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
      version: 1,
      run_id: launched.task_id,
      reviewer: reviewEntry.instance_id,
      attempt: 2,
    });
    atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.2`, reviewEntry.instance_id), {
      version: 1,
      handoff_id: `hoff-pe-${state}`,
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id, session_id: "sess-rev" },
      destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
      input_digest: "0".repeat(64),
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    });
    atomicJson(join(dir, `${buildEntry.instance_id}.progress.json`), {
      attempt_id: `${buildEntry.instance_id}.1`,
      token: launched.manifest.token,
      updated_at: Date.now(),
      started_at: Date.now() - 2000,
      state,
    });

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        const build = byId.get("build");
        if (state === "completed") {
          assert.equal(build.status, "pending");
          assert.equal(build.status_text, "Pending");
          assert.equal(build.current_attempt.attempt_id, `${buildEntry.instance_id}.2`);
          assert.equal("started_at" in build.current_attempt, false);
          assert.equal("updated_at" in build.current_attempt, false);
        } else {
          assert.equal(build.status, "needs_attention");
          assert.equal(build.status_text, "Uncertain");
        }
      },
    );
  }

  // Foreign-prefix attempt_id in completed prior progress (review-plan) and completed mismatched attempt in non-review-plan both fail closed.
  for (const mode of ["review_foreign_prefix", "non_review_completed_mismatch"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = mode === "review_foreign_prefix"
      ? {
        project_cwd: f.cwd,
        topology: "graph",
        task: `PRIVATE_${mode}`,
        agents: [
          { node_id: "build", persona: "builder", sub_task: "PRIVATE_B" },
          {
            node_id: "review",
            persona: "reviewer",
            sub_task: "PRIVATE_R",
            depends_on: ["build"],
            output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
            decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
          },
        ],
      }
      : {
        project_cwd: f.cwd,
        topology: "graph",
        task: `PRIVATE_${mode}`,
        agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_B" }],
      };
    const fac = ops({ action: "publish", name: `prog-guard-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-pg-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-pg-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    if (mode === "review_foreign_prefix") {
      const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
      atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
        version: 1,
        run_id: launched.task_id,
        reviewer: reviewEntry.instance_id,
        attempt: 2,
      });
      atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.2`, reviewEntry.instance_id), {
        version: 1,
        handoff_id: "hoff-foreign-prefix",
        state: "accepted",
        run_id: launched.task_id,
        source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id, session_id: "sess-rev" },
        destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
        input_digest: "0".repeat(64),
        offer: "matched",
        accepted_at: "2026-01-01T00:00:02.000Z",
      });
    }
    atomicJson(join(dir, `${buildEntry.instance_id}.progress.json`), {
      attempt_id: mode === "review_foreign_prefix" ? "foreign-node.1" : `${buildEntry.instance_id}.2`,
      token: launched.manifest.token,
      updated_at: Date.now(),
      started_at: Date.now() - 2000,
      state: "completed",
    });

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        const build = byId.get("build");
        assert.equal(build.status, "needs_attention", mode);
        assert.equal(build.status_text, "Uncertain", mode);
      },
    );
  }
});

test("Live Graph fails closed on view.problems digest mismatch, unsafe attempt keys, and loop result FIFO/symlink", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. view.problems throw (digest mismatch between claim and saved source result).
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_DIGEST_MISMATCH",
      agents: [
        { node_id: "src", persona: "builder", sub_task: "PRIVATE_SRC" },
        { node_id: "dest", persona: "builder", sub_task: "PRIVATE_DEST", depends_on: ["src"] },
      ],
    };
    const fac = ops({ action: "publish", name: "digest-mismatch-fac", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-dm" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-dm", brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const srcEntry = launched.manifest.pane_manifest.find(e => e.node_id === "src")!;
    const destEntry = launched.manifest.pane_manifest.find(e => e.node_id === "dest")!;
    const srcCfg = readJson<WorkerConfig>(join(dir, `${srcEntry.instance_id}.config.json`));
    const srcCompletion = completionRecord(
      srcCfg,
      { agent_name: srcEntry.persona_name, node_id: "src", status: "success", summary: "Src done", detail: "PRIVATE" },
      "sent",
      "2026-01-01T00:00:01.000Z",
    );
    const srcResPath = resultPath(dir, srcEntry.instance_id);
    const mismatchedDigest = "f".repeat(64);
    atomicJson(srcResPath, srcCompletion);
    atomicJson(handoffOfferPath(dir, destEntry.instance_id, srcEntry.instance_id), {
      version: 1,
      handoff_id: "hoff-dm",
      run_id: launched.task_id,
      state: "queued",
      source: { node_id: "src", attempt_id: srcEntry.attempt_id!, instance_id: srcEntry.instance_id, persona_name: srcEntry.persona_name },
      destination: { node_id: "dest", attempt_id: destEntry.attempt_id!, instance_id: destEntry.instance_id },
      input_digest: mismatchedDigest,
      result_path: srcResPath,
      offered_at: "2026-01-01T00:00:01.000Z",
      queued_at: "2026-01-01T00:00:01.000Z",
    });
    atomicJson(handoffClaimPath(dir, destEntry.instance_id, srcEntry.instance_id), {
      version: 1,
      handoff_id: "hoff-dm",
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "src", attempt_id: srcEntry.attempt_id!, instance_id: srcEntry.instance_id, session_id: "sess-src" },
      destination: { node_id: "dest", attempt_id: destEntry.attempt_id!, instance_id: destEntry.instance_id },
      input_digest: mismatchedDigest,
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    });

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        assert.equal(byId.get("dest").status, "needs_attention");
        assert.equal(byId.get("dest").status_text, "Uncertain");
        assert.match(byId.get("dest").reason, /handoff/i);
      },
    );
  }

  // 2. assertSafeAttemptKey path-traversal regex (slash without "..", and ".." within allowed chars).
  for (const unsafeAttempt of ["sub/bad", "foo..bar"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_SAFE_KEY",
      agents: [
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_B" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_R",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: `safe-key-${unsafeAttempt.replace(/[^A-Za-z0-9_.-]/g, "_")}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-sk" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-sk", brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    const buildCfg = readJson<WorkerConfig>(join(dir, `${buildEntry.instance_id}.config.json`));
    const b1Completion = completionRecord(
      buildCfg,
      { agent_name: buildEntry.persona_name, node_id: "build", status: "success", summary: "B1", detail: "PRIVATE" },
      "sent",
      "2026-01-01T00:00:01.000Z",
    );
    const digest = inputDigest(b1Completion.result);
    atomicJson(resultPath(dir, `${buildEntry.instance_id}.1`), b1Completion);
    atomicJson(handoffOfferPath(dir, `${reviewEntry.instance_id}.1`, buildEntry.instance_id), {
      version: 1,
      handoff_id: "hoff-sk",
      run_id: launched.task_id,
      state: "queued",
      source: { node_id: "build", attempt_id: unsafeAttempt, instance_id: buildEntry.instance_id, persona_name: buildEntry.persona_name },
      destination: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id },
      input_digest: digest,
      result_path: resultPath(dir, `${buildEntry.instance_id}.1`),
      offered_at: "2026-01-01T00:00:01.000Z",
      queued_at: "2026-01-01T00:00:01.000Z",
    });
    atomicJson(handoffClaimPath(dir, `${reviewEntry.instance_id}.1`, buildEntry.instance_id), {
      version: 1,
      handoff_id: "hoff-sk",
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "build", attempt_id: unsafeAttempt, instance_id: buildEntry.instance_id, session_id: "sess-b" },
      destination: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id },
      input_digest: digest,
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    });

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
        assert.equal(byId.get("review").status, "needs_attention", unsafeAttempt);
        assert.equal(byId.get("review").status_text, "Uncertain", unsafeAttempt);
      },
    );
  }

  // 3. loop result assert (live.ts ~146): prior attempt result build.1.result.json is a FIFO or symlink with no claim on review.
  for (const mode of ["loop_result_fifo", "loop_result_symlink"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_${mode}`,
      agents: [
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_B" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_R",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 2 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: `loop-res-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-lr-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-lr-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const buildEntry = launched.manifest.pane_manifest.find(e => e.node_id === "build")!;
    const reviewEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    atomicJson(join(dir, `${reviewEntry.instance_id}.2.revision.json`), {
      version: 1,
      run_id: launched.task_id,
      reviewer: reviewEntry.instance_id,
      attempt: 2,
    });
    atomicJson(handoffClaimPath(dir, `${buildEntry.instance_id}.2`, reviewEntry.instance_id), {
      version: 1,
      handoff_id: `hoff-lr-${mode}`,
      state: "accepted",
      run_id: launched.task_id,
      source: { node_id: "review", attempt_id: `${reviewEntry.instance_id}.1`, instance_id: reviewEntry.instance_id, session_id: "sess-rev" },
      destination: { node_id: "build", attempt_id: `${buildEntry.instance_id}.2`, instance_id: buildEntry.instance_id },
      input_digest: "0".repeat(64),
      offer: "matched",
      accepted_at: "2026-01-01T00:00:02.000Z",
    });

    const build1Res = resultPath(dir, `${buildEntry.instance_id}.1`);
    if (mode === "loop_result_fifo") {
      execFileSync("mkfifo", [build1Res]);
    } else {
      const outside = join(f.root, "outside-loop-res.json");
      atomicJson(outside, { secret: "PRIVATE_LOOP_LEAK" });
      symlinkSync(outside, build1Res);
    }

    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, mode);
      assert.equal(res!.text.includes("PRIVATE_"), false, `${mode} leaked sentinel`);
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      assert.equal(byId.get("build").status, "needs_attention", mode);
      assert.equal(byId.get("build").status_text, "Uncertain", mode);
    } finally {
      try { rmSync(build1Res, { force: true }); } catch { /* ignore */ }
    }
  }
});

test("Live Graph fails closed on join-claim source result and sourceKey result FIFOs, symlinks, and unsafe keys", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. join-claim FIFO (no edge claim) and join-claim source result (~128-129): FIFO join claim, unsafe attempt key, FIFO, symlink, and invalid-edge fallback.
  for (const mode of ["join_claim_fifo", "join_unsafe_key", "join_source_fifo", "join_source_symlink", "join_invalid_edge_fallback_fifo"] as const) {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: `PRIVATE_JOIN_${mode}`,
      agents: [
        { node_id: "a", persona: "builder", sub_task: "PRIVATE_A" },
        { node_id: "b", persona: "builder", sub_task: "PRIVATE_B" },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_REV",
          depends_on: ["b"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "b", max_revisions: 1 },
        },
        { node_id: "merge", persona: "builder", sub_task: "PRIVATE_MERGE", depends_on: ["a", "review"], join_policy: "all_success" },
      ],
    };
    const fac = ops({ action: "publish", name: `join-guard-${mode}`, draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: `sess-jg-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: `ref-jg-${mode}`, brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const aEntry = launched.manifest.pane_manifest.find(e => e.node_id === "a")!;
    const revEntry = launched.manifest.pane_manifest.find(e => e.node_id === "review")!;
    const mergeEntry = launched.manifest.pane_manifest.find(e => e.node_id === "merge")!;
    const aAttempt = mode === "join_unsafe_key" ? "../outside" : `${aEntry.instance_id}.0`;
    const joinClaimPath = handoffClaimPath(dir, `${mergeEntry.instance_id}.1`);
    const edgeClaimPath = handoffClaimPath(dir, `${mergeEntry.instance_id}.1`, aEntry.instance_id);
    const targetResPath = resultPath(dir, `${aEntry.instance_id}.0`);
    if (mode === "join_claim_fifo") {
      execFileSync("mkfifo", [joinClaimPath]);
    } else {
      atomicJson(joinClaimPath, {
        version: 1,
        kind: "join",
        state: "accepted",
        run_id: launched.task_id,
        destination: { node_id: "merge", attempt_id: `${mergeEntry.instance_id}.1`, instance_id: mergeEntry.instance_id },
        handoff_ids: ["h-a", "h-rev"],
        sources: [
          { node_id: "a", attempt_id: aAttempt, instance_id: aEntry.instance_id, handoff_id: "h-a", input_digest: "0".repeat(64) },
          { node_id: "review", attempt_id: `${revEntry.instance_id}.1`, instance_id: revEntry.instance_id, handoff_id: "h-rev", input_digest: "1".repeat(64) },
        ],
        accepted_at: "2026-01-01T00:00:02.000Z",
      });
    }

    if (mode === "join_invalid_edge_fallback_fifo") {
      // Edge claim fails identity check (foreign run_id) so describeHandoff falls back to joinClaimPath -> must still pre-check joinClaimPath's source result FIFO.
      atomicJson(edgeClaimPath, {
        version: 1,
        handoff_id: "h-bad-edge",
        state: "accepted",
        run_id: "foreign-run-id",
        source: { node_id: "a", attempt_id: `${aEntry.instance_id}.1`, instance_id: aEntry.instance_id, session_id: "sess-a" },
        destination: { node_id: "merge", attempt_id: `${mergeEntry.instance_id}.1`, instance_id: mergeEntry.instance_id },
        input_digest: "0".repeat(64),
        offer: "matched",
        accepted_at: "2026-01-01T00:00:02.000Z",
      });
    }

    if (mode === "join_source_fifo" || mode === "join_invalid_edge_fallback_fifo") {
      execFileSync("mkfifo", [targetResPath]);
    } else if (mode === "join_source_symlink") {
      const outside = join(f.root, "outside-join-src.json");
      atomicJson(outside, { secret: "PRIVATE_JOIN_LEAK" });
      symlinkSync(outside, targetResPath);
    }

    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, mode);
      assert.equal(res!.text.includes("PRIVATE_"), false, `${mode} leaked sentinel`);
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      assert.equal(byId.get("merge").status, "needs_attention", mode);
      assert.equal(byId.get("merge").status_text, "Uncertain", mode);
    } finally {
      try { rmSync(joinClaimPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(edgeClaimPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(targetResPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // 1b. Non-loop join-claim FIFO (destKey === destInstance, so the loop-key block is skipped; pre-check on joinClaimPath is the sole guard before describeHandoff).
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_NONLOOP_JOIN_FIFO",
      agents: [
        { node_id: "a", persona: "builder", sub_task: "PRIVATE_A" },
        { node_id: "b", persona: "builder", sub_task: "PRIVATE_B" },
        { node_id: "merge", persona: "builder", sub_task: "PRIVATE_MERGE", depends_on: ["a", "b"], join_policy: "all_success" },
      ],
    };
    const fac = ops({ action: "publish", name: "nonloop-join-fifo", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-nl-join-fifo" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-nl-join-fifo", brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    assert.equal(launched.manifest.review_plan, undefined);
    const dir = launched.manifest.session_dir;
    const mergeEntry = launched.manifest.pane_manifest.find(e => e.node_id === "merge")!;
    const joinClaimPath = handoffClaimPath(dir, mergeEntry.instance_id);
    execFileSync("mkfifo", [joinClaimPath]);
    try {
      const [res] = await verifyReadOnlyViewerInChild({
        stateDirs: f.root,
        viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
        paths: [`/api/factories/${fac.factory_id}/live`],
      });
      assert.equal(res!.status, 200, "nonloop_join_claim_fifo");
      assert.equal(res!.text.includes("PRIVATE_"), false, "nonloop_join_claim_fifo leaked sentinel");
      const live = JSON.parse(res!.text);
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      assert.equal(byId.get("merge").status, "needs_attention", "nonloop_join_claim_fifo");
      assert.equal(byId.get("merge").status_text, "Uncertain", "nonloop_join_claim_fifo");
    } finally {
      try { rmSync(joinClaimPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // 2. sourceKey result (~110-112): non-loop source in a review_plan run with oversized valid completion at <source>.1.result.json and no claim.
  {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_SK_oversized",
      agents: [
        { node_id: "prep", persona: "builder", sub_task: "PRIVATE_PREP" },
        { node_id: "build", persona: "builder", sub_task: "PRIVATE_BUILD", depends_on: ["prep"] },
        {
          node_id: "review",
          persona: "reviewer",
          sub_task: "PRIVATE_REV",
          depends_on: ["build"],
          output_contract: { properties: { verdict: { type: "string", enum: ["approve", "revise"], required: true } } },
          decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1 },
        },
      ],
    };
    const fac = ops({ action: "publish", name: "sk-guard-oversized", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-skg-oversized" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-skg-oversized", brief: "PRIVATE_BRIEF" });
    const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
    revokeManagerAuthority(auth);

    const dir = launched.manifest.session_dir;
    const prepEntry = launched.manifest.pane_manifest.find(e => e.node_id === "prep")!;
    const prepCfg = readJson<WorkerConfig>(join(dir, `${prepEntry.instance_id}.config.json`));
    const prepCompletion = completionRecord(
      prepCfg,
      { agent_name: prepEntry.persona_name, node_id: "prep", status: "success", summary: "Prep done", detail: "PRIVATE_PREP_DETAIL" },
      "not_required",
      "2026-01-01T00:00:01.000Z",
    );
    const prepKeyRes = resultPath(dir, `${prepEntry.instance_id}.1`);
    writeFileSync(prepKeyRes, JSON.stringify(prepCompletion) + " ".repeat(1_200_000));

    const [res] = await verifyReadOnlyViewerInChild({
      stateDirs: f.root,
      viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
      paths: [`/api/factories/${fac.factory_id}/live`],
    });
    assert.equal(res!.status, 200, "source_key_oversized");
    assert.equal(res!.text.includes("PRIVATE_"), false, "source_key_oversized leaked sentinel");
    const live = JSON.parse(res!.text);
    const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
    assert.equal(byId.get("prep").status, "succeeded", "source_key_oversized prep");
    assert.equal(byId.get("build").status, "needs_attention", "source_key_oversized build");
    assert.equal(byId.get("build").status_text, "Uncertain", "source_key_oversized build");
    assert.match(byId.get("build").reason, /handoff/i, "source_key_oversized build");
  }
});

test("Ticket 05: Live state covers closed set (idle, waiting, blocked, running, ended, uncertain), blockers, release transition, and distinct outcome/settlement/capacity", { timeout: 30000 }, async t => {
  const CLOSED_STATES = new Set(["running", "ended", "idle", "waiting", "blocked", "uncertain"]);
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. Idle -> Blocked (stopped, preflight, ceiling, checkout_held, unmanaged+checkout_held) -> Waiting -> Running -> Ended(held) -> Ended(settled) -> Queued stays Ended -> Failed-before-release blocks -> Released switches to graph.
  {
    const f = serviceFixture(t, ["builder", "reviewer"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const viewerEnv = { PATH: join(f.root, "bin") };
    const sentinels = ["PRIVATE_", f.root, f.cwd, f.home, statePath, coordinationPath];
    const assertLiveShape = (text: string, label: string) => {
      for (const s of sentinels) assert.equal(text.includes(s), false, `${label} leaked ${s}`);
      const snap = JSON.parse(text);
      assert.ok(CLOSED_STATES.has(snap.state), `${label} invalid state: ${snap.state}`);
      assert.ok(typeof snap.reason === "string" && snap.reason.length > 0, `${label} missing reason`);
      assert.ok("run" in snap, `${label} missing run key`);
      assert.ok(Number.isFinite(Date.parse(snap.checked_at)), `${label} invalid checked_at`);
      return snap;
    };

    const draft: GenerateRequest = {
      project_cwd: f.cwd,
      topology: "graph",
      task: "PRIVATE_T05_PROMPT",
      agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_T05_SUB" }],
    };
    const fac = ops({ action: "publish", name: "t05-main", draft, sessionModel });
    const peer = ops({ action: "publish", name: "t05-peer", draft, sessionModel });
    const unmPeer = ops({ action: "publish", name: "t05-unmanaged-peer", draft, sessionModel });
    const auth = createManagerAuthority({ pi_session_id: "sess-t05-main" });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

    // 1a. Managed empty -> idle with reason, run: null, head_status.blocking_kind === "empty".
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
        assert.equal(res.status, 200);
        const live = assertLiveShape(await res.text(), "idle managed");
        assert.equal(live.state, "idle");
        assert.equal(live.run, null);
        assert.equal(live.head_status.blocking_kind, "empty");
        assert.equal(live.graph.absence, "no records");
      },
    );

    // 1b. Submit input -> waiting -> stop -> blocked (stopped) -> missing PATH -> blocked (preflight).
    ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t05-ref-1", brief: "PRIVATE_T05_BRIEF_1" });
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "waiting");
        assert.equal(live.state, "waiting");
        assert.equal(live.reason, "An admitted input is eligible and waiting to launch.");
        assert.equal(live.run, null);
        assert.equal(live.head_status.eligible, true);
        assert.equal(live.head_status.input.reference, "t05-ref-1");
        assert.equal(live.graph.absence, "no records");
      },
    );

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "preflight blocked");
        assert.equal(live.state, "blocked");
        assert.equal(live.run, null);
        assert.equal(live.head_status.blocking_kind, "preflight");
        assert.equal(live.head_status.blocker.kind, "preflight");
        assert.match(live.reason, /prerequisite/i);
      },
    );

    ops({ action: "stop", factory_id: fac.factory_id, authority: auth });
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "stopped blocked");
        assert.equal(live.state, "blocked");
        assert.equal(live.run, null);
        assert.equal(live.head_status.blocking_kind, "stopped");
        assert.equal(live.head_status.without_control_fence.eligible, true);
        assert.match(live.reason, /stop fence/i);
      },
    );

    // 1c. Resume & launch -> switches snapshot from waiting/blocked to running with graph and distinct settlement/capacity_release.
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    const run1 = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });

    const authPeer = createManagerAuthority({ pi_session_id: "sess-t05-peer" });
    ops({ action: "resume", factory_id: peer.factory_id, authority: authPeer });
    ops({ action: "submit", factory_id: peer.factory_id, authority: authPeer, reference: "t05-peer-1", brief: "PRIVATE_T05_PEER" });
    revokeManagerAuthority(authPeer);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "running");
        assert.equal(live.state, "running");
        assert.deepEqual(live.run, { run_id: run1.task_id, attempt_id: run1.attempt_id, bound_version: "v1" });
        assert.equal(live.outcome, "incomplete");
        assert.equal(live.settlement, "unsettled");
        assert.equal(live.capacity_release, "held");
        assert.equal(live.graph.evidence, "available");

        // Peer factory sharing checkout reports checkout_held blocker; unmanaged peer reports blocked (checkout held).
        const peerLive = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${peer.factory_id}/live`)).text(), "peer checkout_held");
        assert.equal(peerLive.state, "blocked");
        assert.equal(peerLive.run, null);
        assert.equal(peerLive.head_status.blocking_kind, "checkout_held");
        assert.match(peerLive.reason, /checkout slot/i);

        const unmPeerLive = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${unmPeer.factory_id}/live`)).text(), "unmanaged checkout_held");
        assert.equal(unmPeerLive.state, "blocked");
        assert.equal(unmPeerLive.run, null);
        assert.equal(unmPeerLive.head_status.blocking_kind, "unmanaged");
        assert.match(unmPeerLive.reason, /checkout slot/i);
      },
    );

    // 1d. Complete node with failure (still held, not settled yet) -> state: "ended" (never active/running), outcome: "failed", settlement: "unsettled", capacity_release: "held".
    const entry1 = run1.manifest.pane_manifest[0]!;
    const cfg1 = readJson<WorkerConfig>(join(run1.manifest.session_dir, `${entry1.instance_id}.config.json`));
    atomicJson(
      resultPath(run1.manifest.session_dir, entry1.instance_id),
      completionRecord(cfg1, { agent_name: entry1.persona_name, node_id: "build", status: "failure", summary: "Build failed", detail: "PRIVATE_FAIL_DETAIL" }, "not_required", "2026-01-01T00:00:01.000Z"),
    );

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended held");
        assert.equal(live.state, "ended");
        assert.notEqual(live.state, "running");
        assert.deepEqual(live.run, { run_id: run1.task_id, attempt_id: run1.attempt_id, bound_version: "v1" });
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "unsettled");
        assert.equal(live.capacity_release, "held");
        assert.equal(live.graph.evidence, "available");
        assert.equal(live.head_status.eligible, false);
        assert.equal(live.head_status.blocking_kind, "factory_held");
        assert.equal(live.launch_blocker, undefined);
        assert.equal(live.reason, "All nodes have recorded terminal outcomes.");
      },
    );

    // 1d-queued. Held ended run with a later queued input -> still state: "ended", but head_status + launch_blocker + reason explain factory_held.
    const subHeldNext = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t05-ref-held-next", brief: "PRIVATE_T05_BRIEF_HELD_NEXT" });
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended held with queued next");
        assert.equal(live.state, "ended");
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "unsettled");
        assert.equal(live.capacity_release, "held");
        assert.equal(live.head_status.eligible, false);
        assert.equal(live.head_status.blocking_kind, "factory_held");
        assert.equal(live.head_status.input.reference, "t05-ref-held-next");
        assert.equal(live.launch_blocker.kind, "factory_held");
        assert.match(live.reason, /terminal outcomes/i);
        assert.match(live.reason, /run slot/i);
      },
    );
    await ops({ action: "discard", factory_id: fac.factory_id, input_id: subHeldNext.input_id, authority: auth, confirm: async () => true });

    // 1e. Settle run1 -> state: "ended", outcome: "failed", settlement: "settled", capacity_release: "released".
    const settled1 = await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
    assert.equal(settled1.settled, true, settled1.reason);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended settled");
        assert.equal(live.state, "ended");
        assert.deepEqual(live.run, { run_id: run1.task_id, attempt_id: run1.attempt_id, bound_version: "v1" });
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "settled");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.graph.absence, "not applicable");
        assert.equal(live.head_status.eligible, false);
        assert.equal(live.head_status.blocking_kind, "empty");
        assert.equal(live.head_status.input.absence, "no records");
        assert.equal(live.launch_blocker, undefined);
        assert.equal(live.reason, "The most recent released run has a durable settlement.");
      },
    );

    // 1f. Submit new queued input (no launch started yet) -> finished outcome stays in snapshot until another run starts; head_status & launch_blocker surface eligibility/blockers; other factory unaffected.
    const sub2 = ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "t05-ref-2", brief: "PRIVATE_T05_BRIEF_2" });
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended with queued next");
        assert.equal(live.state, "ended");
        assert.deepEqual(live.run, { run_id: run1.task_id, attempt_id: run1.attempt_id, bound_version: "v1" });
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "settled");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.head_status.eligible, true);
        assert.equal(live.head_status.input.reference, "t05-ref-2");
        assert.equal(live.launch_blocker, undefined);
        assert.equal(live.reason, "The most recent released run has a durable settlement.");

        const peerLive = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${peer.factory_id}/live`)).text(), "peer waiting after release");
        assert.equal(peerLive.state, "waiting");
        assert.equal(peerLive.run, null);
      },
    );

    // 1f-preflight: ended + queued input + preflight failure -> head_status.blocking_kind === "preflight", launch_blocker, reason explains preflight.
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended preflight blocked");
        assert.equal(live.state, "ended");
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "settled");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.head_status.eligible, false);
        assert.equal(live.head_status.blocking_kind, "preflight");
        assert.equal(live.launch_blocker.kind, "preflight");
        assert.match(live.reason, /durable settlement/i);
        assert.match(live.reason, /prerequisite/i);
      },
    );

    // 1f-compatibility: ended + queued input + unsupported constraints file version -> head_status.blocking_kind === "compatibility".
    const constraintsDir = join(f.cwd, ".pi");
    const constraintsPath = join(constraintsDir, "constraints.json");
    mkdirSync(constraintsDir, { recursive: true });
    writeFileSync(constraintsPath, JSON.stringify({ version: 99, constraints: [] }));
    try {
      await verifyReadOnlyViewer(
        { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
        async viewer => {
          const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended compatibility blocked");
          assert.equal(live.state, "ended");
          assert.equal(live.outcome, "failed");
          assert.equal(live.settlement, "settled");
          assert.equal(live.capacity_release, "released");
          assert.equal(live.head_status.eligible, false);
          assert.equal(live.head_status.blocking_kind, "compatibility");
          assert.equal(live.launch_blocker.kind, "compatibility");
          assert.match(live.reason, /durable settlement/i);
          assert.match(live.reason, /incompatible/i);
        },
      );
    } finally {
      rmSync(constraintsPath, { force: true });
    }

    // 1f-stopped+preflight: ended + queued input + stop fence + preflight failure -> both stop fence and underlying preflight are explained.
    ops({ action: "stop", factory_id: fac.factory_id, authority: auth });
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "missing-bin") }, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "ended stopped + preflight");
        assert.equal(live.state, "ended");
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "settled");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.head_status.eligible, false);
        assert.equal(live.head_status.blocking_kind, "stopped");
        assert.equal(live.head_status.without_control_fence.blocking_kind, "preflight");
        assert.equal(live.launch_blocker.kind, "stopped");
        assert.match(live.reason, /stop fence/i);
        assert.match(live.reason, /prerequisite/i);
      },
    );
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });

    // 1g. Launch attempt 2 fails before release -> snapshot reports blocked (does not falsely report ended/released while attempt 2 holds capacity!).
    const failingService = new BootstrapService({
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "create") {
          return { code: 1, stdout: "", stderr: "stop run2 before release" };
        }
        return { code: 0, stdout: JSON.stringify({ result: { pane: { workspace_id: "w" }, workspaces: [{ workspace_id: "w" }], tabs: [], panes: [] } }), stderr: "" };
      },
      extensionDir: fileURLToPath(new URL("..", import.meta.url)),
      stateDir: f.stateDir,
      home: f.home,
      env: { PATH: join(f.root, "bin"), HERDR_ENV: "1", HERDR_PANE_ID: "caller" },
    });
    const failingOps = factoryOperations(statePath, failingService, { coordinationPath });
    await assert.rejects(() => failingOps({ action: "launch", factory_id: fac.factory_id, authority: auth }), /stop run2 before release/);
    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "failed before release after settled");
        assert.equal(live.state, "blocked");
        assert.equal(live.run, null);
        assert.equal(live.head_status.blocking_kind, "factory_held");
        assert.equal(live.reason, "A launch attempt currently holds this factory's run slot.");
        assert.match(live.graph.explanation, /failed_before_release|proven_not_released/);
      },
    );

    // 1h. Retry launch after proven_not_released -> verified release switches snapshot to run 2's graph!
    const failedAtt = ops({ action: "inspect", factory_id: fac.factory_id }).attempts.find(a => a.input_id === sub2.input_id)!;
    const run2 = await ops({
      action: "retry_launch",
      factory_id: fac.factory_id,
      authority: auth,
      input_id: sub2.input_id,
      previous_attempt_id: failedAtt.attempt_id,
      confirmed: true,
    });
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
      async viewer => {
        const live = assertLiveShape(await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).text(), "run2 released");
        assert.equal(live.state, "running");
        assert.deepEqual(live.run, { run_id: run2.task_id, attempt_id: run2.attempt_id, bound_version: "v1" });
        assert.notEqual(live.run.run_id, run1.task_id);
        assert.equal(live.settlement, "unsettled");
        assert.equal(live.capacity_release, "held");
        assert.equal(live.graph.evidence, "available");
      },
    );
  }

  // 2. Ceiling blocker on a factory with no released run.
  {
    const fCeil = serviceFixture(t, ["builder"]);
    const ceilState = join(fCeil.root, "factories.sqlite");
    const ceilCoord = join(fCeil.root, "coord.sqlite");
    const ceilOps = factoryOperations(ceilState, fCeil.service, { coordinationPath: ceilCoord });
    const ceilFac = ceilOps({
      action: "publish",
      name: "t05-ceil-fac",
      draft: {
        project_cwd: fCeil.cwd,
        topology: "graph",
        task: "PRIVATE_CEIL_TASK",
        agents: [
          { node_id: "work", persona: "builder", sub_task: "PRIVATE_CEIL_W" },
          {
            node_id: "review",
            persona: "builder",
            sub_task: "PRIVATE_CEIL_R",
            depends_on: ["work"],
            output_contract: { properties: { v: { type: "string", enum: ["yes", "no"], required: true } } },
            decision: { field: "v", approve: "yes", reject: "no", on_reject: "work", max_revisions: 2 },
          },
        ],
      },
      sessionModel,
    });
    const authCeil = createManagerAuthority({ pi_session_id: "sess-t05-ceil" });
    ceilOps({ action: "resume", factory_id: ceilFac.factory_id, authority: authCeil });
    ceilOps({ action: "submit", factory_id: ceilFac.factory_id, authority: authCeil, reference: "ref-t05-ceil", brief: "PRIVATE_CEIL_BRIEF" });
    revokeManagerAuthority(authCeil);
    mkdirSync(join(fCeil.cwd, ".pi"), { recursive: true });
    writeFileSync(join(fCeil.cwd, ".pi", "bootstrap.json"), JSON.stringify({ graph: { ceilings: { maxRevisions: 1 } } }));

    await verifyReadOnlyViewer(
      { stateDirs: fCeil.root, viewerOptions: { statePath: ceilState, coordinationPath: ceilCoord, env: { PATH: join(fCeil.root, "bin") }, home: fCeil.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/${ceilFac.factory_id}/live`);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text.includes("PRIVATE_"), false);
        const live = JSON.parse(text);
        assert.equal(live.state, "blocked");
        assert.equal(live.run, null);
        assert.equal(live.head_status.blocking_kind, "ceiling");
        assert.match(live.reason, /ceiling/i);
      },
    );
  }

  // 3. Cleared run keeps outcome, execution settlement ("unknown"), and capacity_release ("released") as three distinct facts.
  {
    const fClear = serviceFixture(t, ["builder"]);
    const cState = join(fClear.root, "factories.sqlite");
    const cCoord = join(fClear.root, "coord.sqlite");
    const cOps = factoryOperations(cState, fClear.service, { coordinationPath: cCoord });
    const cFac = cOps({
      action: "publish",
      name: "t05-clear-fac",
      draft: { project_cwd: fClear.cwd, topology: "graph", task: "PRIVATE_CLEAR_P", agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_CLEAR_S" }] },
      sessionModel,
    });
    const cAuth = createManagerAuthority({ pi_session_id: "sess-t05-clear" });
    cOps({ action: "resume", factory_id: cFac.factory_id, authority: cAuth });
    cOps({ action: "submit", factory_id: cFac.factory_id, authority: cAuth, reference: "ref-t05-clear", brief: "PRIVATE_CLEAR_B" });
    const cRun = await cOps({ action: "launch", factory_id: cFac.factory_id, authority: cAuth });
    const cDir = join(fClear.cwd, ".pi", "agent-sessions", cRun.task_id);
    const cfgFile = readdirSync(cDir).find(name => name.endsWith(".config.json") && name.includes("build"))!;
    const w = workerFromConfig(t, join(cDir, cfgFile), { model: { provider: "test-provider", id: "test-model" } });
    await w.start();
    await w.beforeStart();
    await w.complete({ status: "failure", summary: "Failed", detail: "err" });
    const db = new DatabaseSync(cState);
    try {
      const row = db.prepare("SELECT * FROM factory_inputs").get() as any;
      const next = buildInputRow({ ...row, disposition: "blocked" });
      db.prepare("UPDATE factory_inputs SET disposition = ?, record_digest = ? WHERE input_id = ?").run(next.disposition, next.record_digest, row.input_id);
    } finally { db.close(); }
    const cleared = await cOps({
      action: "clear_hold",
      factory_id: cFac.factory_id,
      input_id: cRun.input_id,
      attempt_id: cRun.attempt_id,
      task_id: cRun.task_id,
      authority: cAuth,
      confirm: async () => ({
        reason: "Operator stopped process",
        evidence: "Verified exited",
        acknowledged_unknown_effects: true,
      } satisfies ClearanceDecision),
    });
    assert.equal(cleared.cleared, true);

    await verifyReadOnlyViewer(
      { stateDirs: fClear.root, viewerOptions: { statePath: cState, coordinationPath: cCoord, env: { PATH: join(fClear.root, "bin") }, home: fClear.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/${cFac.factory_id}/live`);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text.includes("PRIVATE_"), false);
        const live = JSON.parse(text);
        assert.equal(live.state, "ended");
        assert.deepEqual(live.run, { run_id: cRun.task_id, attempt_id: cRun.attempt_id, bound_version: "v1" });
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "unknown");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.graph.absence, "not applicable");
        assert.equal(live.head_status.blocking_kind, "empty");
        assert.equal(live.launch_blocker, undefined);
        assert.equal(live.reason, "The most recent released run's capacity holds were cleared by an operator.");
      },
    );

    cOps({ action: "submit", factory_id: cFac.factory_id, authority: cAuth, reference: "ref-clear-next", brief: "PRIVATE_CLEAR_NEXT" });
    cOps({ action: "stop", factory_id: cFac.factory_id, authority: cAuth });
    revokeManagerAuthority(cAuth);

    await verifyReadOnlyViewer(
      { stateDirs: fClear.root, viewerOptions: { statePath: cState, coordinationPath: cCoord, env: { PATH: join(fClear.root, "bin") }, home: fClear.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${cFac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "ended");
        assert.equal(live.outcome, "failed");
        assert.equal(live.settlement, "unknown");
        assert.equal(live.capacity_release, "released");
        assert.equal(live.head_status.blocking_kind, "stopped");
        assert.equal(live.launch_blocker.kind, "stopped");
        assert.match(live.reason, /cleared by an operator/i);
        assert.match(live.reason, /stop fence/i);
      },
    );
  }
});

test("Ticket 05: Failing reads return HTTP error (never fabricated snapshot), damaged settlement/control fails closed to uncertain, and all liveSnapshot guards are pinned", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" };

  // 1. Hot-journal and corrupt factories.sqlite return 503 on /live (never 200 fabricated snapshot).
  {
    const f = serviceFixture(t, ["first"]);
    const iso = isolatedPiEnvironment();
    t.after(() => iso.cleanup());
    mkdirSync(join(iso.agentDir, "agents"), { recursive: true });
    writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
    const dbPath = join(f.root, "factories.sqlite");
    const coordPath = join(f.root, "factory-coordination.sqlite");
    const draftFile = join(f.root, "draft.json");
    writeFileSync(draftFile, JSON.stringify({
      project_cwd: f.cwd,
      topology: "graph",
      task: "Hot journal live test",
      agents: [{ persona: "first", node_id: "build", sub_task: "x".repeat(3 * 1024 * 1024) }],
    }));
    const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
    const killed = await runSupervised(process.execPath, [child, dbPath, draftFile, "hot-live-fac", "before_commit"], {
      env: { ...iso.env, PATH: join(f.root, "bin") },
      timeoutMs: 10_000,
    });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/fac_any/live`);
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
      },
    );
  }
  {
    const f = serviceFixture(t, ["builder"]);
    const corruptRoot = mkdtempSync(join(tmpdir(), "factory-viewer-live-corrupt-"));
    t.after(() => rmSync(corruptRoot, { recursive: true, force: true }));
    const dbPath = join(corruptRoot, "factories.sqlite");
    const coordPath = join(corruptRoot, "factory-coordination.sqlite");
    writeFileSync(dbPath, "corrupt sqlite bytes");
    await verifyReadOnlyViewer(
      { stateDirs: corruptRoot, viewerOptions: { statePath: dbPath, coordinationPath: coordPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const res = await fetch(`${viewer.url}/api/factories/fac_any/live`);
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
      },
    );
  }

  // 2. Real SQLite damaged settlement record and damaged factory_control record fail closed to uncertain.
  for (const mode of ["damaged_settlement", "damaged_control"] as const) {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const fac = ops({
      action: "publish",
      name: `t05-${mode}`,
      draft: { project_cwd: f.cwd, topology: "graph", task: "PRIVATE_P", agents: [{ node_id: "build", persona: "builder", sub_task: "PRIVATE_S" }] },
      sessionModel,
    });
    const auth = createManagerAuthority({ pi_session_id: `sess-${mode}` });
    ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
    if (mode === "damaged_settlement") {
      ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "ref-dmg-settle", brief: "Brief" });
      const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
      const entry = launched.manifest.pane_manifest[0]!;
      const cfg = readJson<WorkerConfig>(join(launched.manifest.session_dir, `${entry.instance_id}.config.json`));
      atomicJson(
        resultPath(launched.manifest.session_dir, entry.instance_id),
        completionRecord(cfg, { agent_name: entry.persona_name, node_id: "build", status: "success", summary: "Done", detail: "d" }, "not_required", "2026-01-01T00:00:01.000Z"),
      );
      await ops({ action: "settle_run", factory_id: fac.factory_id, authority: auth });
      const db = new DatabaseSync(statePath);
      try {
        const row = db.prepare("SELECT * FROM factory_attempts WHERE attempt_id = ?").get(launched.attempt_id) as any;
        const rebuilt = buildAttemptRow({ ...row, error: "settlement:{corrupt" });
        db.prepare("UPDATE factory_attempts SET error = ?, record_digest = ? WHERE attempt_id = ?").run(rebuilt.error, rebuilt.record_digest, launched.attempt_id);
      } finally { db.close(); }
    } else {
      ops({ action: "stop", factory_id: fac.factory_id, authority: auth });
      const db = new DatabaseSync(statePath);
      try {
        db.prepare("UPDATE factory_controls SET record_digest = 'bad-digest' WHERE factory_id = ?").run(fac.factory_id);
      } finally { db.close(); }
    }
    revokeManagerAuthority(auth);

    await verifyReadOnlyViewer(
      { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
      async viewer => {
        const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
        assert.equal(live.state, "uncertain", mode);
        assert.equal(live.run, null, mode);
        assert.equal(live.graph.evidence, "unavailable", mode);
        assert.equal(live.graph.absence, "evidence unavailable", mode);
      },
    );

    if (mode === "damaged_settlement") {
      // Tampering attempt digest without updating record_digest fails the read with HTTP 503 (never a fabricated snapshot).
      const db = new DatabaseSync(statePath);
      try {
        db.prepare("UPDATE factory_attempts SET record_digest = 'bad-digest' WHERE factory_id = ?").run(fac.factory_id);
      } finally { db.close(); }
      await verifyReadOnlyViewer(
        { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
        async viewer => {
          const res = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
          assert.equal(res.status, 503);
          assert.deepEqual(await res.json(), { error: "Evidence unavailable" });
        },
      );
    }
  }

  // 3. Pin every individual guard branch in liveSnapshot via minimal single-field perturbations.
  {
    const f = serviceFixture(t, ["builder"]);
    const statePath = join(f.root, "factories.sqlite");
    const coordinationPath = join(f.root, "factory-coordination.sqlite");
    const ops = factoryOperations(statePath, f.service, { coordinationPath });
    const draft: GenerateRequest = { project_cwd: f.cwd, topology: "graph", task: "P", agents: [{ node_id: "build", persona: "builder", sub_task: "S" }] };

    // 3a. Perturbations on an active released factory.
    const activeFac = ops({ action: "publish", name: "t05-guards-active", draft, sessionModel });
    const authA = createManagerAuthority({ pi_session_id: "sess-ga" });
    ops({ action: "resume", factory_id: activeFac.factory_id, authority: authA });
    ops({ action: "submit", factory_id: activeFac.factory_id, authority: authA, reference: "ref-ga", brief: "Brief" });
    await ops({ action: "launch", factory_id: activeFac.factory_id, authority: authA });
    revokeManagerAuthority(authA);

    for (const mode of ["duplicate_releases", "release_without_active_attempt", "active_attempt_uncertainty"] as const) {
      await verifyReadOnlyViewer(
        {
          stateDirs: f.root,
          viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
          start: opts => startViewer(opts, {
            createReader: readerOpts => {
              const inner = createViewerReader(readerOpts);
              return {
                ...inner,
                inspectLive: (id: string) => {
                  const { inspection, releases } = inner.inspectLive(id);
                  const cloneInsp = structuredClone(inspection);
                  const cloneRel = structuredClone(releases);
                  if (mode === "duplicate_releases") {
                    cloneRel.push(structuredClone(cloneRel[0]!));
                  } else if (mode === "release_without_active_attempt") {
                    cloneInsp.attempts = [];
                  } else if (mode === "active_attempt_uncertainty") {
                    cloneInsp.attempts[0]!.uncertainty = ["Injected attempt problem"];
                  }
                  return { inspection: cloneInsp, releases: cloneRel };
                },
              };
            },
          }),
        },
        async viewer => {
          const live = await (await fetch(`${viewer.url}/api/factories/${activeFac.factory_id}/live`)).json() as any;
          assert.equal(live.state, "uncertain", mode);
          assert.equal(live.run, null, mode);
          assert.equal(live.graph.evidence, "unavailable", mode);
        },
      );
    }

    // 3b. Perturbations on an independent idle factory (free checkout) pinning each individual condition in the non-active uncertainty / idle / ended guards.
    const fIdle = serviceFixture(t, ["builder"]);
    const idleStatePath = join(fIdle.root, "factories.sqlite");
    const idleCoordPath = join(fIdle.root, "factory-coordination.sqlite");
    const idleOps = factoryOperations(idleStatePath, fIdle.service, { coordinationPath: idleCoordPath });
    const idleFac = idleOps({ action: "publish", name: "t05-guards-idle", draft: { ...draft, project_cwd: fIdle.cwd }, sessionModel });
    const authI = createManagerAuthority({ pi_session_id: "sess-gi" });
    idleOps({ action: "resume", factory_id: idleFac.factory_id, authority: authI });
    revokeManagerAuthority(authI);

    const idleUncertainModes = [
      "inspection_uncertainty_only",
      "current_error_only",
      "control_error_only",
      "head_uncertain_only",
      "factory_slot_uncertain_only",
      "checkout_slot_uncertain_only",
      "bad_historical_settlement",
      "settled_without_release_authorization",
      "historical_attempt_uncertainty",
      "contradictory_historical_released",
      "empty_with_factory_held",
      "unmanaged_with_factory_held",
    ] as const;

    for (const mode of idleUncertainModes) {
      await verifyReadOnlyViewer(
        {
          stateDirs: fIdle.root,
          viewerOptions: { statePath: idleStatePath, coordinationPath: idleCoordPath, env: { PATH: join(fIdle.root, "bin") }, home: fIdle.home },
          start: opts => startViewer(opts, {
            createReader: readerOpts => {
              const inner = createViewerReader(readerOpts);
              return {
                ...inner,
                inspectLive: (id: string) => {
                  const { inspection, releases } = inner.inspectLive(id);
                  const cloneInsp = structuredClone(inspection);
                  if (mode === "inspection_uncertainty_only") {
                    cloneInsp.uncertainty = ["Injected uncertainty"];
                  } else if (mode === "current_error_only") {
                    cloneInsp.current_error = "Injected current error";
                  } else if (mode === "control_error_only") {
                    cloneInsp.control_error = "Injected control error";
                  } else if (mode === "head_uncertain_only") {
                    cloneInsp.head_status.blocking_kind = "uncertain";
                  } else if (mode === "factory_slot_uncertain_only") {
                    cloneInsp.capacity.factory_slot = "uncertain";
                  } else if (mode === "checkout_slot_uncertain_only") {
                    cloneInsp.capacity.checkout_slot = "uncertain";
                  } else if (mode === "bad_historical_settlement") {
                    cloneInsp.attempts = [{
                      attempt_id: "att-bad-settled",
                      factory_id: idleFac.factory_id,
                      input_id: "in-1",
                      bound_version: "v1",
                      request_id: "req-1",
                      task_id: "task-1",
                      canonical_checkout: fIdle.cwd,
                      state: "settled",
                      release_authorized: true,
                      release_authorized_at: "2026-01-01T00:00:00.000Z",
                      error: null,
                      created_at: "2026-01-01T00:00:00.000Z",
                      updated_at: "2026-01-01T00:00:00.000Z",
                      historical: true,
                    }];
                  } else if (mode === "settled_without_release_authorization") {
                    cloneInsp.attempts = [{
                      attempt_id: "att-settled-unauth",
                      factory_id: idleFac.factory_id,
                      input_id: "in-1",
                      bound_version: "v1",
                      request_id: "req-1",
                      task_id: "task-1",
                      canonical_checkout: fIdle.cwd,
                      state: "settled",
                      release_authorized: false,
                      release_authorized_at: null,
                      error: null,
                      created_at: "2026-01-01T00:00:00.000Z",
                      updated_at: "2026-01-01T00:00:00.000Z",
                      historical: true,
                      settlement: {
                        cancellation: { intent: "none" },
                        resource_closure: { state: "closed", recorded_closed: ["build"], not_recorded_closed: [] },
                        execution_settlement: { state: "settled", reason: "ok" },
                        outcome: "succeeded",
                        resume_risk: [],
                        attention: [],
                        capacity_release: "released",
                      },
                    }];
                  } else if (mode === "historical_attempt_uncertainty") {
                    cloneInsp.attempts = [{
                      attempt_id: "att-hist-unc",
                      factory_id: idleFac.factory_id,
                      input_id: "in-1",
                      bound_version: "v1",
                      request_id: "req-1",
                      task_id: "task-1",
                      canonical_checkout: fIdle.cwd,
                      state: "settled",
                      release_authorized: true,
                      release_authorized_at: "2026-01-01T00:00:00.000Z",
                      error: null,
                      created_at: "2026-01-01T00:00:00.000Z",
                      updated_at: "2026-01-01T00:00:00.000Z",
                      historical: true,
                      uncertainty: ["Corrupt historical evidence"],
                      settlement: {
                        cancellation: { intent: "none" },
                        resource_closure: { state: "closed", recorded_closed: ["build"], not_recorded_closed: [] },
                        execution_settlement: { state: "settled", reason: "ok" },
                        outcome: "succeeded",
                        resume_risk: [],
                        attention: [],
                        capacity_release: "released",
                      },
                    }];
                  } else if (mode === "contradictory_historical_released") {
                    cloneInsp.attempts = [{
                      attempt_id: "att-contra-rel",
                      factory_id: idleFac.factory_id,
                      input_id: "in-1",
                      bound_version: "v1",
                      request_id: "req-1",
                      task_id: "task-1",
                      canonical_checkout: fIdle.cwd,
                      state: "released",
                      release_authorized: true,
                      release_authorized_at: "2026-01-01T00:00:00.000Z",
                      error: null,
                      created_at: "2026-01-01T00:00:00.000Z",
                      updated_at: "2026-01-01T00:00:00.000Z",
                      historical: true,
                    }];
                  } else if (mode === "empty_with_factory_held") {
                    cloneInsp.capacity.factory_slot = "held";
                  } else if (mode === "unmanaged_with_factory_held") {
                    cloneInsp.factory.management = "unmanaged";
                    cloneInsp.head_status = { eligible: false, blocking_kind: "unmanaged", reason: "Factory is unmanaged" };
                    cloneInsp.capacity.factory_slot = "held";
                  }
                  return { inspection: cloneInsp, releases };
                },
              };
            },
          }),
        },
        async viewer => {
          const live = await (await fetch(`${viewer.url}/api/factories/${idleFac.factory_id}/live`)).json() as any;
          assert.equal(live.state, "uncertain", mode);
          assert.equal(live.run, null, mode);
          assert.equal(live.graph.evidence, "unavailable", mode);
        },
      );
    }

    for (const mode of ["empty_with_factory_held_explained", "empty_with_checkout_held", "proven_not_released_not_ended"] as const) {
      await verifyReadOnlyViewer(
        {
          stateDirs: fIdle.root,
          viewerOptions: { statePath: idleStatePath, coordinationPath: idleCoordPath, env: { PATH: join(fIdle.root, "bin") }, home: fIdle.home },
          start: opts => startViewer(opts, {
            createReader: readerOpts => {
              const inner = createViewerReader(readerOpts);
              return {
                ...inner,
                inspectLive: (id: string) => {
                  const { inspection, releases } = inner.inspectLive(id);
                  const cloneInsp = structuredClone(inspection);
                  if (mode === "empty_with_factory_held_explained") {
                    cloneInsp.capacity.factory_slot = "held";
                    cloneInsp.head_status = {
                      eligible: false,
                      blocking_kind: "factory_held",
                      reason: "Factory slot is held by an active launch attempt.",
                    };
                  } else if (mode === "empty_with_checkout_held") {
                    cloneInsp.capacity.checkout_slot = "held";
                  } else if (mode === "proven_not_released_not_ended") {
                    cloneInsp.attempts = [{
                      attempt_id: "att-pnr",
                      factory_id: idleFac.factory_id,
                      input_id: "in-1",
                      bound_version: "v1",
                      request_id: "req-1",
                      task_id: "task-1",
                      canonical_checkout: fIdle.cwd,
                      state: "proven_not_released",
                      release_authorized: false,
                      release_authorized_at: null,
                      error: "release permission was never committed",
                      created_at: "2026-01-01T00:00:00.000Z",
                      updated_at: "2026-01-01T00:00:00.000Z",
                      historical: true,
                    }];
                  }
                  return { inspection: cloneInsp, releases };
                },
              };
            },
          }),
        },
        async viewer => {
          const live = await (await fetch(`${viewer.url}/api/factories/${idleFac.factory_id}/live`)).json() as any;
          if (mode === "proven_not_released_not_ended") {
            assert.equal(live.state, "idle", mode);
            assert.equal(live.run, null, mode);
          } else if (mode === "empty_with_factory_held_explained") {
            assert.equal(live.state, "blocked", mode);
            assert.equal(live.run, null, mode);
            assert.match(live.reason, /holds this factory's run slot/i, mode);
          } else {
            assert.equal(live.state, "blocked", mode);
            assert.equal(live.run, null, mode);
          }
        },
      );
    }
  }
});

test("Live Graph scrubs and bounds disposition, cancel, closure, cause, and admission reasons, fails closed on missing session_dir, and rejects non-regular loop disposition/error files (N6)", { timeout: 30000 }, async t => {
  const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };
  const f = serviceFixture(t, ["builder", "reviewer"]);
  const statePath = join(f.root, "factories.sqlite");
  const coordinationPath = join(f.root, "factory-coordination.sqlite");
  const ops = factoryOperations(statePath, f.service, { coordinationPath });

  const draft: GenerateRequest = {
    project_cwd: f.cwd,
    topology: "graph",
    task: "PRIVATE_N6_PROMPT",
    agents: [
      { node_id: "build", persona: "builder", sub_task: "PRIVATE_N6_BUILD" },
      {
        node_id: "review",
        persona: "reviewer",
        depends_on: ["build"],
        sub_task: "PRIVATE_N6_REV",
        output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "revise"] } } },
        decision: { field: "verdict", approve: "approve", reject: "revise", on_reject: "build", max_revisions: 1, on_exhausted: "failed" },
      },
      { node_id: "deploy", persona: "builder", depends_on: ["review"], sub_task: "PRIVATE_N6_DEP" },
      { node_id: "disp_n6", persona: "builder", sub_task: "PRIVATE_N6_DISP" },
      { node_id: "cancel_n6", persona: "builder", sub_task: "PRIVATE_N6_CAN" },
      { node_id: "adm_src", persona: "builder", sub_task: "PRIVATE_N6_ASRC" },
      { node_id: "adm_wait", persona: "builder", sub_task: "PRIVATE_N6_AWAIT", depends_on: ["adm_src"], dependency_policy: "require_success" },
    ],
  };

  const fac = ops({ action: "publish", name: "n6-live-fac", draft, sessionModel });
  const auth = createManagerAuthority({ pi_session_id: "sess-n6-live" });
  ops({ action: "resume", factory_id: fac.factory_id, authority: auth });
  ops({ action: "submit", factory_id: fac.factory_id, authority: auth, reference: "n6-ref", brief: "PRIVATE_N6_BRIEF" });
  const launched = await ops({ action: "launch", factory_id: fac.factory_id, authority: auth });
  revokeManagerAuthority(auth);

  const dir = launched.manifest.session_dir;
  const entryOf = (nodeId: string) => launched.manifest.pane_manifest.find(e => e.node_id === nodeId)!;

  // 1. Disposition reason + cause reason with newlines, project/session paths, and > 1000 chars
  const dispEntry = entryOf("disp_n6");
  atomicJson(
    dispositionPath(dir, dispEntry.attempt_id!),
    dispositionRecord(
      { ...dispEntry, task_id: launched.task_id },
      "blocked",
      `Line 1 in ${dir}/x\nLine 2 in ${f.cwd}/y ${"D".repeat(1100)}`,
      [{ node_id: "adm_src", state: "failed", reason: `Cause at ${f.cwd}/c\nline2 ${"C".repeat(1100)}` }],
      "2026-01-01T00:00:01.000Z",
    ),
  );

  // 2. Cancel reason with newlines, path, and > 1000 chars
  const cancelEntry = entryOf("cancel_n6");
  atomicJson(cancelPath(dir, cancelEntry.instance_id), {
    version: 1,
    identity: { run_id: launched.task_id, node_id: "cancel_n6", persona_name: cancelEntry.persona_name, attempt_id: cancelEntry.attempt_id, instance_id: cancelEntry.instance_id },
    scope: "node",
    reason: `Cancelled in ${f.cwd}/stop\n${"K".repeat(1100)}`,
    requested_at: "2026-01-01T00:00:01.000Z",
    grace_ms: 5000,
    force_close_after: "2026-01-01T00:00:06.000Z",
  });

  // 3. Admission wait reason with upstream failure reason containing path & > 1000 chars
  const admSrcEntry = entryOf("adm_src");
  const admSrcCfg = readJson<WorkerConfig>(join(dir, `${admSrcEntry.instance_id}.config.json`));
  atomicJson(
    resultPath(dir, admSrcEntry.attempt_id!),
    completionRecord(admSrcCfg, { agent_name: admSrcEntry.persona_name, node_id: "adm_src", status: "failure", summary: `Failed at ${f.cwd}/src\n${"S".repeat(1100)}`, detail: "d" }, "not_required", "2026-01-01T00:00:01.000Z"),
  );
  const admWaitEntry = entryOf("adm_wait");
  atomicJson(readyPath(dir, admWaitEntry.instance_id), {
    version: 2,
    direction_incarnation: "inc-adm-wait",
    task_id: launched.task_id,
    token: launched.manifest.token,
    instance_id: admWaitEntry.instance_id,
    pid: process.pid,
    session_id: "sess-adm-wait",
    name: admWaitEntry.instance_id,
    model: "test-provider/test-model",
  });
  atomicJson(join(dir, `${admWaitEntry.instance_id}.progress.json`), {
    attempt_id: admWaitEntry.attempt_id,
    token: launched.manifest.token,
    updated_at: Date.now(),
    started_at: Date.now() - 500,
    state: "waiting",
  });

  await verifyReadOnlyViewer(
    { stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
    async viewer => {
      const liveRes = await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`);
      assert.equal(liveRes.status, 200);
      const liveText = await liveRes.text();
      assert.equal(liveText.includes(f.cwd), false, "live leaked project_cwd");
      assert.equal(liveText.includes(dir), false, "live leaked session_dir");
      const live = JSON.parse(liveText) as any;
      const byId = new Map<string, any>(live.graph.nodes.map((n: any) => [n.id, n]));
      for (const id of ["disp_n6", "cancel_n6", "adm_wait"]) {
        const node = byId.get(id);
        assert.equal(node.reason.includes("\n"), false, `${id} reason must collapse whitespace`);
        assert.ok(Array.from(node.reason).length <= 1000, `${id} reason exceeded 1000`);
      }
      assert.equal(byId.get("disp_n6").status, "blocked");
      assert.equal(byId.get("cancel_n6").status, "cancelled");
      assert.equal(byId.get("adm_wait").status, "waiting");
      const dispNode = byId.get("disp_n6");
      assert.equal(dispNode.current_attempt.causes[0].reason.includes("\n"), false);
      assert.ok(Array.from(dispNode.current_attempt.causes[0].reason).length <= 1000);
    },
  );

  // 4. Loop pre-checks reject non-regular .disposition.json and .error.json for any attempt number (FIFO + symlink) without blocking
  const buildEntry = entryOf("build");
  const loopErrSym = join(dir, `${buildEntry.instance_id}.2.error.json`);
  const outsideFile = join(f.root, "outside-loop-err.json");
  writeFileSync(outsideFile, JSON.stringify({ error: "PRIVATE_LOOP_ERR" }));
  symlinkSync(outsideFile, loopErrSym);

  const reviewEntry = entryOf("review");
  const loopDispFifo = dispositionPath(dir, `${reviewEntry.instance_id}.2`);
  execFileSync("mkfifo", [loopDispFifo]);

  const [fifoLiveResp] = await verifyReadOnlyViewerInChild({
    stateDirs: f.root,
    viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
    paths: [`/api/factories/${fac.factory_id}/live`],
  });
  assert.equal(fifoLiveResp!.status, 200);
  assert.equal(fifoLiveResp!.text.includes("PRIVATE_"), false);
  const fifoLive = JSON.parse(fifoLiveResp!.text) as any;
  const fifoById = new Map<string, any>(fifoLive.graph.nodes.map((n: any) => [n.id, n]));
  assert.equal(fifoById.get("build").status, "needs_attention");
  assert.equal(fifoById.get("review").status, "needs_attention");

  // 5. Missing session directory gives Uncertain instead of Pending
  await verifyReadOnlyViewer(
    {
      stateDirs: f.root,
      viewerOptions: { statePath, coordinationPath, env: { PATH: join(f.root, "bin") }, home: f.home },
      start: opts => startViewer(opts, {
        createReader: readerOpts => {
          const inner = createViewerReader(readerOpts);
          return {
            ...inner,
            inspectLive: (id: string) => {
              const { inspection, releases } = inner.inspectLive(id);
              const clonedReleases = structuredClone(releases);
              if (clonedReleases[0]) {
                clonedReleases[0].manifest.session_dir = join(f.root, "missing-session-dir");
              }
              return { inspection, releases: clonedReleases };
            },
          };
        },
      }),
    },
    async viewer => {
      const live = await (await fetch(`${viewer.url}/api/factories/${fac.factory_id}/live`)).json() as any;
      for (const node of live.graph.nodes) {
        assert.equal(node.status, "needs_attention", `missing session_dir should yield needs_attention for ${node.id}`);
        assert.equal(node.status_text, "Uncertain");
      }
    },
  );
});
