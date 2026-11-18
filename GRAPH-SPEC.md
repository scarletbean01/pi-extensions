# Bootstrap graph topology: high-level spec

Status: draft, decisions resolved 2026-11-18. Scope: a new `graph` topology for `bootstrap_generate` with parallel branches, joins and bounded review/fix loops. This document is the design contract; the [README](bootstrap/README.md) remains the description of shipped behaviour until this is implemented. Vocabulary follows [GLOSSARY.md](GLOSSARY.md). The control-plane choice is recorded in [ADR 0001](docs/adr/0001-agents-drive-graph-execution.md).

Relation to the earlier roadmap (`.scratch/bootstrap-orchestration/`): this spec supersedes tickets 18 (graph execution) and 22 (review and revision). Its parked state replaces ticket 17's lease for loop-body nodes only; collaboration leases stay with ticket 17. Tickets 19–21 (concurrency slots, runtime owner, lazy launch) are untouched and out of scope here. Joins use per-edge handoffs, not the synthesis path of ticket 11.

## 1. Goals and non-goals

Goals

- G1. Express mixed topologies: chains that fan out into parallel agents, which later join and continue as a chain.
- G2. A join node starts only when every inbound branch has delivered an acceptable result, and receives all of them.
- G3. A reviewer can route its result by verdict: forward when approved, back to an earlier node for a fix when not, with a bounded number of revisions.
- G4. Agents inside a loop stay alive between revisions, so a builder keeps its context. Tabs are closed by cleanup once the run is done, automatically when it succeeds.
- G5. Keep the existing guarantees: durable records decide, delivery is not acceptance, no automatic replay of uncertain work, idempotent `request_id`.
- G6. Give the orchestrator a live pseudographic view of the run's graph, built from the same durable status the tools read.

Non-goals (this release)

- No nested or overlapping loops. A node belongs to at most one loop body.
- No LLM-decided routing. Routing reads a validated structured field of a node's result.
- No worktrees or per-node workspaces (`shared_cwd` stays). Ownership remains an advisory scheduling contract.
- No automatic replay of a node whose effects are uncertain. No exactly-once side-effect guarantee.
- No quorum/any joins and no dynamic graph changes after launch.
- No central scheduler, runtime owner, concurrency slots or lazy launch: agents drive execution (ADR 0001) and every agent is launched at release, as today.
- No parking outside loops: an agent that is not in a loop body ends after delivery, as today. Keeping finished agents available for questions is a collaboration concern (earlier ticket 17).

## 2. Terms

- **Edge**: a directed dependency `source -> destination` declared by `depends_on`.
- **Join**: a node with more than one inbound edge. **Fan-out**: a node with more than one outbound edge.
- **Decision node**: a node whose result routes the flow (typically a reviewer). **Feedback edge**: the edge a rejecting decision follows back to an earlier node.
- **Loop body**: the nodes on the forward paths from the feedback target to the decision node, inclusive.
- **Attempt**: one execution of a node, `attempt_id = <instance_id>.<n>`. A revision is a new attempt of the same node by the same live agent.
- **Parked**: a loop-body agent that submitted an attempt and stays alive, idle, waiting for either a revision or finalization.
- **Finalization**: the durable record that a parked node can no longer be revised.

"Worker" names only the `worker.ts` module, the code that runs inside each agent.

## 3. Plan model

New value `topology: "graph"`. `chain` and `team` are unchanged and keep their fingerprints. Node form only (`persona`/`node_id`); the legacy `name` form is rejected for graphs. `decision` (below) is also accepted in the node form of a `chain`, so the smallest loop is a two-node chain, builder then reviewer, with no join and no fan-out. A chain without `decision` is unchanged.

New per-node fields:

| Field | Meaning |
| --- | --- |
| `depends_on: string[]` | Node IDs this node waits for. Empty or absent: a root, started at release. |
| `join_policy` | `all_success` (default) or `allow_partial`. Combines the per-edge outcomes of a join. Per-edge `dependency_policy` rules from the README still apply. |
| `decision` | Makes this node a decision node, see below. |

Loop-body membership alone decides parking; there is no per-node `keep_alive`.

`decision`:

```json
{ "field": "verdict", "approve": "approve", "reject": "changes_requested",
  "on_reject": "build-a", "max_revisions": 3, "on_exhausted": "needs_attention" }
```

Run-level: `max_total_attempts` bounds the attempts of all nodes together, so a runaway loop is bounded even with many loops. When omitted it is resolved as described in "Limits and configuration" below. Attempt limits are a property of the plan, not of a persona: personas do not carry them.

Run-level `cleanup`: `on_success` (default for `graph`) or `manual`. See "Finalization and cleanup" in section 6.

Validation (all at plan time, so a dry run reports them):

1. Node IDs exist, are unique, no self-dependency, at most 32 nodes.
2. The graph formed by `depends_on` is acyclic. The feedback edge (`on_reject`) is not part of it.
3. `on_reject` names a strict ancestor of the decision node. A decision node may have no successors (it is then a sink): see the two-node loop below.
4. The decision node's `output_contract` declares `outputs.<field>` as an enum containing exactly the `approve` and `reject` values.
5. Loop bodies are disjoint. A node that is in a body cannot be the target of another loop.
6. `max_revisions` is between 1 and 10. `on_exhausted` is `needs_attention` (default) or `failed`.
7. The resolved `max_revisions` and `max_total_attempts` do not exceed the configured ceilings (see "Limits and configuration").
8. Dry run warns when two nodes that can run in parallel have overlapping `write_paths` (ownership would serialize them). When either node is in a loop body, the warning says that the whole loop serializes with the other node, because a loop body holds its ownership until finalization (section 6).

### Limits and configuration

`max_revisions` (per loop) and `max_total_attempts` (per run) are resolved per value, first one set wins:

1. The request: `decision.max_revisions` on the node, `max_total_attempts` on the run.
2. `<project>/.pi/bootstrap.json`.
3. The global `bootstrap.json` (`~/.pi/agent/bootstrap.json`, or `$PI_CODING_AGENT_DIR/bootstrap.json`).
4. Built-in: `max_revisions` 3; `max_total_attempts` derived from the plan (the sum over nodes of one attempt plus the revisions its loop allows).

`bootstrap.json` gains an optional `graph` block. Defaults fill values a request omits. Ceilings are operator limits that a request cannot exceed:

```json
{ "graph": { "defaults": { "maxRevisions": 3, "maxTotalAttempts": 24 },
             "ceilings": { "maxRevisions": 5, "maxTotalAttempts": 40 } } }
```

Rules:

- Both files and the whole block are optional. A missing file contributes nothing.
- The block is validated like `modelAliases`: a malformed file, a non-integer or non-positive value, or a default above its own ceiling stops planning, and the error names the file and key, even if the plan would not use the value.
- Project and global entries merge field by field (unlike model aliases, which the project replaces as a whole): a project can set only `maxRevisions` and still inherit the global ceiling. For a ceiling, the lower of the project and global values applies, so a project cannot raise an operator's global limit.
- A request that exceeds a ceiling fails at planning, never silently clamped.
- The dry run shows each resolved value and where it came from (request, project, global or built-in).
- The resolved values are recorded in the manifest and in each decision node's configuration. Editing `bootstrap.json` later never changes a running run, and reusing a `request_id` compares the resolved plan, so a changed default or ceiling that changes a resolved value is a different plan.

Example (two parallel chains, review loops, then a merger):

```json
{ "topology": "graph", "task": "...", "project_cwd": "/abs", "agents": [
  { "node_id": "scout-a", "persona": "scout", "sub_task": "..." },
  { "node_id": "scout-b", "persona": "scout", "sub_task": "..." },
  { "node_id": "build-a", "persona": "implementer", "depends_on": ["scout-a"], "sub_task": "..." },
  { "node_id": "build-b", "persona": "implementer", "depends_on": ["scout-b"], "sub_task": "..." },
  { "node_id": "review-a", "persona": "reviewer", "depends_on": ["build-a"], "sub_task": "...",
    "output_contract": { "required_fields": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["approve", "changes_requested"] } } },
    "decision": { "field": "verdict", "approve": "approve", "reject": "changes_requested", "on_reject": "build-a", "max_revisions": 3 } },
  { "node_id": "review-b", "persona": "reviewer", "depends_on": ["build-b"], "sub_task": "...",
    "output_contract": { "required_fields": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["approve", "changes_requested"] } } },
    "decision": { "field": "verdict", "approve": "approve", "reject": "changes_requested", "on_reject": "build-b", "max_revisions": 3 } },
  { "node_id": "merge", "persona": "integrator", "depends_on": ["review-a", "review-b"], "sub_task": "..." },
  { "node_id": "next", "persona": "...", "depends_on": ["merge"], "sub_task": "..." }
] }
```

Which upstream findings each builder receives is the plan author's choice, expressed with `depends_on`; the engine has no opinion.

Minimal loop (two nodes, the reviewer is the sink):

```json
{ "topology": "chain", "task": "...", "project_cwd": "/abs", "agents": [
  { "node_id": "build", "persona": "implementer", "sub_task": "...", "required_checks": ["tests"] },
  { "node_id": "review", "persona": "reviewer", "sub_task": "...",
    "output_contract": { "required_fields": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["approve", "changes_requested"] } } },
    "decision": { "field": "verdict", "approve": "approve", "reject": "changes_requested", "on_reject": "build", "max_revisions": 3 } }
] }
```

`approve` completes the run. `changes_requested` re-runs `build` as attempt 2, then `review` as attempt 2, on the same two agents. After the revisions are used up, `review` ends as `needs_attention`. The derived `max_total_attempts` is 2 + 2 × `max_revisions` (8 here). Both nodes are loop-body nodes, so both stay parked between revisions.

## 4. Execution model

Agents drive execution, as chains do today (ADR 0001): each agent watches its own inbound edges, claims its own inputs and delivers its own outputs. There is no scheduler. The dispatcher only renders the widget and runs the automatic-cleanup watcher.

The static graph may contain a loop, but execution is acyclic over `(node, attempt)` pairs: a revision is a new attempt that depends on the previous decision.

Edge states, per edge and per attempt of its source:

- `pending`: the source has not produced a verdict for this edge.
- `fired`: the source's accepted result routes along this edge (a normal edge after the source's acceptable outcome; a forward edge of a decision node after `approve`).
- `dead`: the edge can never fire (source failed, blocked, skipped or cancelled; revisions or the run budget exhausted; feedback edge undeliverable; loop settled without approval).

Edge state is derived, not stored. One pure function, `edgeState(records, edge, attempt)`, computes it from records that already exist: the source attempt's result, the decision verdict, finalize records and handoff claims. Agents, `bootstrap_status`, the widget, recovery and the cleanup watcher all use it, so no actor has to be alive to mark an edge `dead`.

Node execution states keep the README set, plus `parked`: a loop-body attempt was submitted and the node may still be revised. `parked` is not terminal and does not make the run `incomplete` once every loop that could revive it has settled. A node reaches its terminal state when it finalizes.

Join admission: a join agent is admitted once, when every inbound edge is `fired` and each edge passes the existing `decideAdmission` (policy and required-check evidence). If any edge is `dead`, the join is `blocked` (or admitted under `allow_partial` for a partial source), with causes inherited from all dead edges. If an edge is `pending` or its source is `needs_attention`, the join waits. Admission is recorded by the join agent's single exclusive claim (section 7); it is the only new stored record joins need.

## 5. Revisions (feedback loops)

1. The decision node completes with `outputs.<field>`. `bootstrap_complete` reads it from the already validated result and routes it; the model never chooses the route.
2. Routing applies only to a decision result with status `success`. A `partial` or `failure` decision result keeps its status, starts no revision and uses up no revision budget; the loop settles, the body is finalized and the forward edges are `dead`.
3. `approve`: forward edges fire; the body nodes finalize. A decision node with no forward edges is a sink: its approval completes the run, and with `cleanup: on_success` the run is then cleaned up.
4. `reject` with revisions left: the feedback edge fires. Every node of the loop body is re-run in dependency order as attempt n+1 (builder first, then anything between builder and reviewer, then the reviewer), so no stale result or evidence ever feeds the next decision. Nodes outside the body are untouched, including the other parallel chain.
5. The re-activated builder receives a bounded handoff: the decision's findings plus references to the durable previous results (`bootstrap_read_input` retrieves the full text). Its original assignment and brief are unchanged. The decision node's attempt n+1 input also references its own previous verdicts and findings, so it can check whether they were addressed even after its context has been compacted.
6. `reject` with no revisions left: the decision node ends in `on_exhausted` (`needs_attention` by default, `failed` on request). Its forward edges become `dead`, so joins that depend on it are blocked with a cause naming the exhausted loop.
7. `reject` with loop revisions left but no run attempts left (the next attempts would exceed `max_total_attempts`): the same outcome as step 6, with a cause naming the run's attempt budget rather than the loop's.
8. A loop-body node that fails during a revision (for example the builder's attempt 2 returns `failure`): the loop settles at once. The decision node's attempt n+1 ends `blocked`, with the failed attempt as its cause, as a chain successor of a failed node does. Its forward edges are `dead`, it writes the finalize records for the body, and no further revision is spent.
9. Counters (`revision` per loop, attempts per run) are durable, so a restarted agent or dispatcher cannot reset them. `max_total_attempts` is enforced at admission.

## 6. Agent lifecycle for parked nodes

```
waiting -> running -> submitted(n) -> parked -+-> revision handoff -> running(n+1)
                                              +-> finalized -> exit
```

- After persisting and delivering attempt n, a loop-body agent does not call `ctx.shutdown()`. It resets its per-attempt flags and idles. Today `worker.ts` sets `completed` and shuts down after delivery (`bootstrap_complete`); agents outside a loop keep that behaviour.
- The tool admission guard becomes attempt-aware: no task tools while parked, full tools once a revision handoff is admitted.
- Ownership: a loop-body node holds its `write_paths` ownership from its first admission until finalization, across parked periods, so no overlapping writer can start between two revisions and then be overwritten. A loop-body node without `write_paths` (a typical reviewer) holds nothing while parked.
- A revision handoff is validated like any handoff: offer, exclusive claim, run token, sender session, digest, contracts, evidence. A duplicate notification is a harmless replay.
- Finalization is a durable state record, separate from ending the process (see "Finalization and cleanup" below). An agent does not need to exit when its loop settles.
- A parked agent that dies: its saved results stay valid, but a revision cannot be delivered. The feedback edge is `dead`, the decision node becomes `needs_attention`, and nothing is replayed. This follows the existing rule for a claimed attempt with no result.
- Tabs are closed by cleanup (below). No operation creates a tab after release.

### Finalization and cleanup

Closing a tab ends the Pi process running in it: Herdr attaches the pane's process to the tab. Cleanup therefore needs no separate kill step, and a parked agent needs no acknowledgement before its tab is closed, because it has nothing in flight (its results are durable, and finalization releases its ownership).

Finalization (state)

- `<instance>.finalize.json` (version 1) records that a node can no longer be revised. It resolves `parked`: the node's execution state becomes that of its latest attempt (`succeeded`, `partial` or `failed`), with a `finalized` marker, and the node's ownership is released. This is what lets the run outcome become terminal while idle agents are still alive.
- Written by the decision node for every loop-body node when the loop settles (approve, exhausted, budget spent, decision not `success`, body node failed, cancelled), or by cleanup (`finalized_by: "dispatcher"`) for any node still parked.
- Published exclusively (`link(2)`) and raced against a revision claim: exactly one wins. If the claim wins, the node is running and a finalize request for it is refused (cleanup then treats the node as running). If the finalize record wins, a late revision handoff is rejected ("node finalized") and the decision node's feedback edge becomes `dead`.
- Idempotent: a retried cleanup finds the record and proceeds.

Ending the process

- An agent may exit by itself once finalized, but nothing depends on it; for the first version, settled agents idle until their tab is closed.
- The `session_shutdown` handler in `worker.ts` already returns without recording anything when the agent is `completed`. A parked agent must count as completed there, so that closing its tab writes no failure. An agent that is running when its tab closes ends as `needs_attention` as today (the shutdown hook records the error if it runs; otherwise the missing heartbeat is diagnosed as exited). Nothing is replayed.

Automatic cleanup

- `cleanup: "on_success"` is the default for `graph`; `manual` keeps today's behaviour (the orchestrator calls `bootstrap_cleanup`). `chain` and `team` default to `manual`.
- Trigger: the run outcome is `succeeded` (every node succeeded, no `needs_attention`, every loop settled), and the run has settled: every node has a durable result with a final delivery state on every outbound edge, and either its agent has exited or `cleanup_settle_ms` (default 3000) has passed since the last result. The settle rule covers the window in `bootstrap_complete` between persisting a result and finishing its delivery bookkeeping, so an agent is never closed mid-write.
- Action: identical to `bootstrap_cleanup` with no selectors. All owned tabs and agents are closed and the run becomes `cleaned`. Session files and reports are retained (automatic cleanup never uses `delete_session_files`), so `bootstrap_report` still works afterwards. The manifest records `cleanup_trigger: "auto"` and the time.
- Not triggered by any other outcome. A `failed`, `blocked`, `partial`, `cancelled`, `skipped` or `needs_attention` run keeps its tabs for inspection and recovery, and is cleaned up manually.
- Evaluated by a watcher in the dispatcher (the same poller as the widget, which runs even when no widget is shown) and lazily by every `bootstrap_status` and `/boot <task_id>` read, so a missed trigger is caught. It runs under the run lock and is idempotent: with several evaluators, exactly one performs the cleanup.
- Visible to the orchestrator: the model-facing text of `bootstrap_status` says the run succeeded and was cleaned up automatically and points to `bootstrap_report`. The watcher also sends a follow-up message (as `subagent-widget.ts` does for `subagent-result`), because tool `details` only feed the UI.
- Failure: cleanup errors are retained with recovery data, status shows them, and `bootstrap_cleanup` retries.
- Limitation: if the dispatcher session ends before the run succeeds, nothing is watching. The next `bootstrap_status` or `/boot` read, or `/bootgraph <task_id>` re-arming the watcher, completes the cleanup.

## 7. Handoffs and records

- Handoffs are per edge and per attempt. The handoff ID formula (run, source attempt, destination node, destination attempt, input digest) already supports this and is unchanged.
- Offer, claim, rejection and recovery records are scoped by destination attempt and source. Attempt scoping and its file names are fixed in stage 1 (loops) and the per-source scoping in stage 2 (joins).
- Record naming is chosen at plan time and never changes during a run. In a plan with any `decision`, every node uses attempt- and source-scoped names from attempt 1. A plan without a decision keeps today's names exactly (`<dest>.handoff-offer.json`, `<dest>.handoff.json`, `<instance>.result.json`). Nothing is ever renamed.
- Fan-out delivery state is tracked per outbound edge. A retried `bootstrap_complete` re-sends only the edges not yet delivered, from the saved result, and never re-runs the task. `bootstrap_recover` judges each edge on its own with the existing verdicts.
- A join's acceptance is one exclusive record that lists the claimed inbound handoff IDs, so two parents finishing together cannot start the join twice.
- Results are attempt-scoped (`<instance>.<n>.result.json`) with a pointer to the latest; `upstream-index.json` records every attempt, keyed by node and attempt.
- All new records carry versions with versioned readers. An unsupported version is reported and left untouched.

## 8. Cross-cutting behaviour

- **Evidence**: required checks are judged per attempt and per inbound edge. A revision invalidates its predecessors' evidence through the existing staleness rules.
- **Ownership**: unchanged semantics outside loops. Parallel branches with disjoint `write_paths` run together; overlapping writers serialize in plan order. A loop body holds its ownership until finalization (section 6), so an overlapping writer waits for the whole loop.
- **Cancel**: node cancellation propagates through the dependency graph and the loop body, parked agents included. `force_close` behaves as today.
- **`fail_fast`**: a failure cancels every unfinished node, including parked ones.
- **Timeouts**: `task_timeout_ms` applies per attempt. A join's dependency wait is measured from the latest useful progress across all upstream nodes. A parked node's wait follows its decision node's progress. Parked agents are never diagnosed as stalled.
- **Recovery**: `bootstrap_recover` inspects every edge and every attempt. It re-sends only a handoff that was demonstrably never claimed, and never reconstructs results.
- **Idempotency**: graph plans get a new fingerprint version. The same plan and `request_id` returns the original run; a changed plan is rejected.

## 9. Observability

- `bootstrap_generate` dry run shows nodes, edges, joins, loop bodies, revision limits and the parallelism warnings from section 3.
- `bootstrap_status` shows per-node attempt ("attempt 2/3"), parked/finalized, per-edge state and, for a join, which inbound edges are still pending or dead.
- The run outcome keeps the README precedence. A parked node counts as unsettled until its loop settles.
- `bootstrap_report` lists every attempt of looped nodes, the verdict history and the causes of any blocked join.

### Orchestrator widget

After a successful non-dry `bootstrap_generate`, the dispatcher session shows a live widget with the run's graph in box-drawing characters. It follows the pattern of `subagent-widget.ts`: `ctx.ui.setWidget(key, factory)` with a `Container`, `Text` and `DynamicBorder`, a timer that refreshes it, and cleanup on `session_start`.

Behaviour

- One widget per run, key `bootstrap-<task_id>`. `bootstrap_generate` stores the tool's `ctx` and registers the widget when the launch succeeds. A failed launch shows no widget.
- Data comes from the same synchronous durable-file read as `bootstrap_status` (`service.status`). Agents are separate Pi processes, so there is no event stream. The widget polls about every 2 seconds with an `unref`'d timer and stops polling once the run outcome is terminal. The last frame stays until cleared.
- Commands (mirroring `/sub` and `/subclear`): `/bootgraph <task_id>` attaches or re-attaches a widget to any run, which works after `/reload` because state lives in files; `/bootgraph clear` removes all bootstrap widgets. `session_start` clears them.
- The widget is registered only in the dispatcher, never in agent sessions. Without a TUI (print or RPC mode) `setWidget` may do nothing; the call is wrapped in a try/catch and skipped silently.
- The widget itself is read-only: it never writes records and never affects a run. The poller it shares with automatic cleanup is the only part that can act (see "Finalization and cleanup"). After an automatic cleanup the last frame shows the run as succeeded and cleaned, polling stops, and the widget stays until cleared.

Rendering

- A pure function `renderGraph(model, width, theme)` lays nodes out left to right by dependency level (longest path from the roots), with parallel chains as lanes. Row order uses a barycenter pass to reduce crossings. Layout is fully deterministic.
- Node glyph and colour follow execution state: `◌` pending or waiting, `●` running (with elapsed time), `✓` succeeded, `◐` partial, `✗` failed, `⊘` blocked, `!` needs attention, `⏸` parked.
- Edge style follows edge state (from `edgeState`): solid `──▶` fired, dim `╌╌▶` pending, a marked cut for dead edges, so a waiting join shows which inbound edge it is waiting on.
- Feedback edges are not routed as lines. A loop-body node shows an annotation `↺ attempt/max` and the last verdict.
- Header: run ID, topology, node count, run outcome and elapsed time. Footer: pending and error counts with a pointer to `bootstrap_status`.
- If the lanes do not fit in `width`, it falls back to a vertical form with one level per row and parallel nodes side by side. Labels are truncated. Above a height cap it shows `+N more`.

Example:

```
 ● run r-3f9a · graph · 8 nodes · running · 02:14
 ✓ scout-a ──▶ ● build-a ──▶ ◌ review-a ──┐
               ↺ 1/3                       ├─▶ ◌ merge ──▶ ◌ next
 ✓ scout-b ──▶ ✓ build-b ──▶ ⏸ review-b ──┘
```

Reuse and structure

- The same renderer prints the planned graph in `bootstrap_generate` dry-run output (static, no status colours), replacing the `a → b → c` link text in `formatPlan`.
- New `graph-view.ts` (pure layout and render) and `graph-widget.ts` (timer and widget lifecycle), plus a few lines in `bootstrap.ts`.

## 10. Compatibility

- `chain` and `team` requests, manifests, configs, results and fingerprints are unchanged. Existing chain tests must pass untouched.
- Graph runs, and chains with a `decision`, use new manifest and config versions. A previous release rejects them rather than misreading them. Do not mix releases within a run.
- A chain stays a first-class topology. It is equivalent to a graph whose nodes each have one `depends_on`.
- Automatic cleanup is the default only for `graph`. `chain` and `team` keep manual cleanup unless `cleanup: "on_success"` is requested. `cleanup` is an additive optional field, so omitting it preserves legacy fingerprints.

## 11. Delivery plan and acceptance

Stage 0: orchestrator widget for existing topologies

- `graph-view.ts` and `graph-widget.ts`, `/bootgraph`, dry-run rendering. Chain and team only: levels come from the existing predecessor links, so no execution changes are needed.
- Acceptance: deterministic snapshot tests for a chain, a team and the narrow-width fallback; the widget appears after a non-dry launch, updates as nodes change state, stops polling when the run is terminal, and is removed by `/bootgraph clear` and `session_start`; no widget is registered in agent sessions; no run record is written by the widget.

Stage 1: loops on chains (decisions, revisions, automatic cleanup)

- Scope: `decision` on node-form chains, including the minimal two-node loop; `max_revisions` and `max_total_attempts`, with the `graph` limits block and ceilings in `bootstrap.json`; plan-time attempt-scoped record naming; the parked state machine; loop-long ownership; finalization; the `cleanup` field and automatic cleanup; status, report and widget support for attempts, verdicts and the parked state. No `graph` topology, fan-out or joins yet.
- Acceptance: the minimal two-node loop (builder, then reviewer as the sink) is the primary scenario. Reject then approve completes with the same agent instance for builder and reviewer; the reviewer's second attempt receives its previous findings; exhausted revisions end as `needs_attention` and the run keeps its tabs; an exhausted run budget ends the same way with its own cause; a `partial` or `failure` review starts no revision; a builder failure during a revision blocks the reviewer and settles the loop; duplicate feedback notifications run the builder once; a parked agent crash yields `needs_attention` and no replay; cancel while parked works; an approval is not admitted while the builder's `required_checks` lack passing evidence; an overlapping writer cannot start while the builder is parked. Plans without a decision keep legacy record names. The widget shows attempt counters, verdicts and the parked state (snapshot test for a loop). All existing chain and team tests pass untouched.
- Finalization: loop settlement resolves parked nodes and releases their ownership, so the run outcome is terminal before cleanup; cleanup finalizes still-parked nodes without waiting for the agent; finalize is refused while an attempt is running; a revision claim and a finalize record racing give exactly one winner in both orders; a parked agent closed with its tab records no failure; a retried cleanup is idempotent.
- Automatic cleanup: with `cleanup: on_success`, a successful run closes every tab and keeps session files and reports; failed, blocked, partial, cancelled and `needs_attention` runs keep their tabs; the cleanup runs exactly once even with several evaluators; an agent is never closed between saving its result and finishing its delivery bookkeeping.

Stage 2: DAG, joins, per-edge handoffs

- Scope: `topology: "graph"`, `depends_on`, `join_policy`, validation, fan-out delivery with per-edge delivery state, per-edge handoff records, join admission with a single exclusive claim, the derived `edgeState` function (`pending`, `fired`, `dead`), and `decision` inside graphs so loops can sit in parallel branches. Dry run, status, report and widget support for fan-out and joins. `cleanup: on_success` is the default for `graph`.
- Acceptance: the plan in section 3 runs end to end; a join starts exactly once when its parents finish simultaneously; one failed parent blocks the join with both causes; an exhausted loop in one branch ends as `needs_attention` and blocks the merger with a cause naming the loop; a join keeps waiting while one branch is in a revision (its edge stays `pending`); loops in two parallel branches revise independently; a fan-out whose second delivery fails is repaired by a retry that re-sends only that edge; the dry run warns when a loop serializes with an overlapping parallel writer; all existing chain and team tests pass. The widget renders fan-out, joins and per-edge state (snapshot tests for a diamond and for parallel chains with a join). Automatic cleanup applies to a successful graph run as in stage 1.

Stage 3: cancel, recover, report, README

- Graph-aware cancellation, recovery inspection per edge and attempt, reports, README and release notes.
- Acceptance: deterministic suite and runtime suite pass; the README no longer lists graphs and revisions as unavailable.

## 12. Decisions

Defaults: `join_policy: all_success`; `on_exhausted: needs_attention`; `max_revisions: 3`; `max_total_attempts` derived from the plan (overridable by request or `bootstrap.json`, bounded by ceilings); only loop-body nodes park; same agent for every revision; `cleanup: on_success` for `graph` only.

Decided (2026-11-18):

- Loops are delivered before DAGs and joins. The two-node builder and reviewer loop is likely the most common graph and the smallest topology that exercises the whole parked-agent state machine, and the two features are largely independent (loops touch the agent state machine and attempt records, joins touch admission and handoff sets).
- Agents drive execution; there is no scheduler (ADR 0001). Edge state is derived from existing records by one pure function.
- A revision re-runs the whole loop body, not only builder and reviewer.
- A loop body holds its write ownership until finalization.
- Only a `success` decision result routes. A body node failing during a revision settles the loop. An exhausted run budget ends the loop like exhausted revisions, with its own cause.
- Record naming is fixed at plan time: attempt-scoped throughout plans with a decision, legacy names otherwise.
- Fan-out delivery is tracked, retried and recovered per edge.
- Attempt limits live in the plan, with `bootstrap.json` supplying defaults and operator ceilings (not the persona), merged field by field. See "Limits and configuration".
- Cleanup is automatic when a graph run succeeds and manual otherwise; `chain` and `team` stay manual by default. Closing a tab ends its Pi process (confirmed in Herdr), so finalization is state, not process control.
- Out of scope: quorum/any joins, `keep_alive` outside loops, concurrency slots, a runtime owner and lazy launch.

No open questions remain.
