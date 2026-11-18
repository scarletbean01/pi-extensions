# Bootstrap graph topology: branches, joins and bounded review loops

Status: ready-for-agent. Prepared 2026-11-18 from the design contract `GRAPH-SPEC.md` at the repository root, after a grilling session whose recommendations were all accepted. Vocabulary follows `GLOSSARY.md` (run, node, attempt, edge, join, decision node, feedback edge, loop body, parked, finalization, agent, persona). Architecture follows ADR 0001: agents drive graph execution; there is no scheduler. This spec supersedes tickets 18 and 22 of the bootstrap-orchestration roadmap, and replaces ticket 17's lease for loop-body agents only.

## Problem Statement

A user who orchestrates agents with bootstrap can only launch a straight chain (each agent hands its result to the next) or an independent team. Real work rarely has that shape:

- Two scouts can investigate in parallel, but there is no way to have two builders each continue from their own scout and then merge their work in one integrator that waits for both.
- Review is one-way. When a reviewer finds problems, the orchestrator has to read the result, launch a new run and re-explain everything; the builder that wrote the code is already gone, along with its context.
- Nothing bounds an improvised review loop, so a disagreement between builder and reviewer can burn attempts and money without limit.
- While a run is going, the orchestrator sees only text status; it cannot see at a glance which branch is waiting, which agent is running and where a join is stuck.
- Successful runs leave every tab open until the orchestrator remembers to clean up.

## Solution

Bootstrap gains a `graph` topology and review loops, delivered in stages:

- A plan can declare, per node, which nodes it depends on. Nodes fan out into parallel branches and join again; a join starts once, only when every inbound branch delivered an acceptable result, and receives all of them.
- A node can be a decision node: its structured verdict routes the run forward on approval or back to an earlier node for a fix on rejection. The builder and everything between it and the reviewer re-run as a new attempt, by the same live agents, which keep their context between revisions. Revisions are bounded per loop and per run, with defaults and operator ceilings in `bootstrap.json`.
- The smallest loop, a two-node chain of builder then reviewer, works without the graph topology.
- The orchestrator sees a live box-drawing view of the run's graph in its own session, and the same picture in the dry-run plan.
- A graph run that succeeds cleans itself up: its tabs close, its records and reports stay. Any other outcome keeps the tabs for inspection.
- All existing guarantees hold: durable records decide, delivery is not acceptance, uncertain work is never replayed automatically, and a `request_id` is idempotent. Chains and teams keep their behaviour, records and fingerprints.

## User Stories

Planning

1. As an orchestrator, I want to declare `depends_on` per node, so that I can describe parallel branches and joins in one plan.
2. As an orchestrator, I want nodes without dependencies to start at release, so that independent roots run in parallel.
3. As an orchestrator, I want an unknown node ID, a duplicate ID, a self-dependency or a cycle rejected at planning, so that a broken plan never launches.
4. As an orchestrator, I want plans capped at 32 nodes, so that a typo cannot launch an unmanageable number of tabs.
5. As an orchestrator, I want the legacy `name` form rejected for graphs, so that every graph node has an explicit node ID.
6. As an orchestrator, I want to mark a node as a decision node with a verdict field, approve and reject values and a feedback target, so that review can route the run.
7. As an orchestrator, I want the decision's verdict field to be checked against the node's output contract at planning, so that a reviewer cannot return a verdict the router does not understand.
8. As an orchestrator, I want a feedback target that is not a strict ancestor of its decision node rejected, so that a loop always points backwards.
9. As an orchestrator, I want overlapping or nested loops rejected, so that each node belongs to at most one loop body.
10. As an orchestrator, I want to use a decision in a node-form chain, so that the common builder-then-reviewer loop needs no graph syntax.
11. As an orchestrator, I want a reviewer with no successors to be allowed, so that its approval simply completes the run.
12. As an orchestrator, I want to choose `all_success` or `allow_partial` per join, so that I decide whether a partial branch may feed the merger.
13. As an orchestrator, I want the dry run to show nodes, edges, joins, loop bodies and revision limits as a graph picture, so that I can see the plan's shape before launch.
14. As an orchestrator, I want the dry run to warn when parallel nodes share write paths, and to say when a whole loop will therefore serialize with another writer, so that I am not surprised by lost parallelism.

Limits and configuration

15. As an orchestrator, I want to set `max_revisions` per loop and `max_total_attempts` per run in the request, so that I control how long a loop may go on.
16. As an operator, I want defaults for those limits in my global and project `bootstrap.json`, so that I don't repeat them in every request.
17. As an operator, I want ceilings in `bootstrap.json` that a request cannot exceed, so that no plan can run away with my budget.
18. As an operator, I want a project to be unable to raise my global ceiling, so that the stricter limit always applies.
19. As an orchestrator, I want a request above a ceiling to fail at planning rather than be clamped, so that I know my plan was not what ran.
20. As an operator, I want a malformed `graph` block reported with the file and key even when the plan doesn't use it, so that configuration errors surface immediately.
21. As an orchestrator, I want the dry run to show each resolved limit and where it came from, so that I can tell a request value from a default.
22. As an orchestrator, I want the resolved limits frozen into the run, so that editing `bootstrap.json` never changes a running run, and a changed resolved value makes a reused `request_id` a different plan.
23. As an orchestrator, I want `max_total_attempts` derived from the plan when nobody sets it, so that a sensible bound always exists.

Review loops

24. As an orchestrator, I want an approving verdict to fire the decision node's forward edges, so that the run continues after a good review.
25. As an orchestrator, I want a rejecting verdict to re-run the builder, everything between builder and reviewer, and the reviewer as new attempts, so that no stale result or evidence feeds the next review.
26. As a builder agent, I want to be revised in the same live session, so that I keep the context of what I built.
27. As a builder agent, I want my revision input to carry the reviewer's findings and references to the earlier results, so that I know exactly what to fix without an unbounded handoff.
28. As a reviewer agent, I want my next attempt's input to reference my previous verdicts and findings, so that I can check they were addressed even after my context was compacted.
29. As an orchestrator, I want a loop that uses up its revisions to end as `needs_attention` (or `failed` if I asked), so that an unresolved disagreement stops and waits for me.
30. As an orchestrator, I want a loop that hits the run's attempt budget to end the same way with a cause naming the budget, so that I can tell which limit stopped it.
31. As an orchestrator, I want only a successful review to route, so that a partial or failed review neither approves nor uses up a revision.
32. As an orchestrator, I want a builder that fails during a revision to settle the loop and block the reviewer with that failure as the cause, so that no further revisions are spent on a broken attempt.
33. As an orchestrator, I want the router to read the verdict from the validated result, never from the model's free text, so that routing is deterministic.
34. As an orchestrator, I want revision counters to be durable, so that a restarted agent or dispatcher cannot reset a loop's budget.
35. As an orchestrator, I want duplicate revision notifications to run the builder once, so that a retried message never doubles work.
36. As an orchestrator, I want an approval not admitted while the builder's required checks lack passing evidence, so that a review cannot wave through untested work.

Parked agents and finalization

37. As an orchestrator, I want loop-body agents to stay alive and idle between attempts, so that revisions reuse them.
38. As an orchestrator, I want parked agents to have no task tools, so that an idle agent cannot start work on its own.
39. As an orchestrator, I want parked agents never diagnosed as stalled, so that waiting for a review is not mistaken for a hang.
40. As an orchestrator, I want a loop body to keep its write ownership until the loop settles, so that no other writer can change the builder's files between revisions.
41. As an orchestrator, I want a parked agent that dies to make its decision node `needs_attention` with nothing replayed, so that uncertain state is never acted on automatically.
42. As an orchestrator, I want a settled loop to finalize its body, so that the run outcome becomes final while the idle agents are still alive.
43. As an orchestrator, I want a finalization and a revision claim racing each other to have exactly one winner, so that a node is never both final and running.
44. As an orchestrator, I want closing a parked agent's tab to record no failure, so that cleanup does not pollute the report.
45. As an orchestrator, I want agents outside loops to end after delivery exactly as today, so that only loops pay for idle agents.

Joins and fan-out

46. As an orchestrator, I want a join to start exactly once when all its parents finish at the same moment, so that the merger never runs twice.
47. As an orchestrator, I want a join blocked when any parent fails, with every failed parent named as a cause, so that I see the whole picture.
48. As an orchestrator, I want a join to wait while one of its branches is in a revision, so that the merger only sees approved work.
49. As an orchestrator, I want a join blocked by an exhausted loop to name that loop, so that I know where to intervene.
50. As an orchestrator, I want loops in parallel branches to revise independently, so that one branch's review does not hold up the other's work.
51. As an orchestrator, I want fan-out delivery tracked per edge, so that a retry or recovery re-sends only the edge that failed and never re-runs the task.
52. As an orchestrator, I want edge state computed the same way by agents, status, the widget, recovery and cleanup, so that every view agrees.

Observability

53. As an orchestrator, I want `bootstrap_status` to show each node's attempt ("attempt 2/3"), parked or finalized state, each edge's state and, for a join, which inbound edges are pending or dead, so that I know exactly what the run is waiting for.
54. As an orchestrator, I want `bootstrap_report` to list every attempt of looped nodes, the verdict history and the causes of a blocked join, so that I can audit what happened.
55. As an orchestrator, I want a live graph widget in my session after a launch, so that I can watch the run without calling status.
56. As an orchestrator, I want node glyphs by state and edge styles by edge state, so that a waiting join shows which branch it waits on.
57. As an orchestrator, I want loop nodes annotated with `↺ attempt/max` and the last verdict instead of drawn back-edges, so that the picture stays readable.
58. As an orchestrator, I want the widget to fall back to a vertical layout when the lanes don't fit, and to show `+N more` above a height cap, so that it works in a narrow terminal.
59. As an orchestrator, I want `/bootgraph <task_id>` to attach a widget to any run, including after a reload, and `/bootgraph clear` to remove them all, so that I control what is on screen.
60. As an orchestrator, I want the widget to stop polling once the run is terminal and keep its last frame, so that it costs nothing afterwards.
61. As an orchestrator, I want no widget in agent sessions and no failure in print or RPC mode, so that the widget never disturbs a run.
62. As an orchestrator, I want the widget to only read records, so that watching a run can never change it.

Automatic cleanup

63. As an orchestrator, I want a successful graph run to close all its tabs automatically, so that I don't have to remember cleanup.
64. As an orchestrator, I want automatic cleanup to keep session files and reports, so that `bootstrap_report` still works afterwards.
65. As an orchestrator, I want failed, blocked, partial, cancelled, skipped and `needs_attention` runs to keep their tabs, so that I can inspect and recover them.
66. As an orchestrator, I want automatic cleanup to wait until every result's delivery bookkeeping is done, so that an agent is never closed mid-write.
67. As an orchestrator, I want cleanup to happen exactly once even when the watcher and several status reads evaluate it together, so that it is safe to call anything at any time.
68. As an orchestrator, I want status to tell me the run was cleaned up automatically and point to the report, and a follow-up message when the watcher does it, so that I'm not left wondering where the tabs went.
69. As an orchestrator, I want a run whose watcher died with my session to be cleaned up by the next status, `/boot` or `/bootgraph` read, so that nothing depends on my session staying open.
70. As an orchestrator, I want chains and teams to keep manual cleanup unless I ask for `cleanup: on_success`, so that existing workflows don't change.

Cancel, recovery and compatibility

71. As an orchestrator, I want cancelling a node to propagate through the dependency graph and the loop body, parked agents included, so that cancel stops everything that depends on it.
72. As an orchestrator, I want `fail_fast` to cancel parked agents too, so that a failure stops the whole run.
73. As an orchestrator, I want `task_timeout_ms` per attempt and a join's dependency wait measured from the latest progress of any upstream node, so that timeouts fit graphs.
74. As an operator, I want `bootstrap_recover` to inspect every edge and every attempt and re-send only handoffs demonstrably never claimed, so that recovery never reconstructs or replays work.
75. As an existing user, I want chain and team requests, records and fingerprints unchanged, so that my existing runs and tests keep working.
76. As an existing user, I want a previous release to reject a graph run's records rather than misread them, so that mixed versions fail safely.
77. As an existing user, I want plans without a decision to keep today's record names, so that nothing about my current runs changes.

## Implementation Decisions

Architecture

- Agents drive execution (ADR 0001). Each agent watches its own inbound edges, claims its own inputs with exclusive file records and delivers its own outputs. The dispatcher runs only the widget and the automatic-cleanup watcher. There is no scheduler, runtime owner, concurrency slot or lazy launch; every agent is launched at release.
- Edge state (`pending`, `fired`, `dead`) is derived, never stored. One pure function computes it from existing records: the source attempt's result, the decision verdict, finalize records and handoff claims. Agents, status, the widget, recovery and the cleanup watcher all call it.
- Execution is acyclic over `(node, attempt)` pairs: a revision is a new attempt that depends on the previous decision.

Plan contract

- New topology value `graph`; node form only. `decision` is also accepted in node-form chains.
- New node fields: `depends_on: string[]`, `join_policy: "all_success" | "allow_partial"` (default `all_success`), `decision`. No `keep_alive`: loop-body membership alone decides parking.
- `decision` shape: `{ field, approve, reject, on_reject, max_revisions?, on_exhausted? }`; `on_exhausted` is `needs_attention` (default) or `failed`; `max_revisions` is 1–10.
- Run-level fields: `max_total_attempts`, and `cleanup: "on_success" | "manual"` (default `on_success` for `graph`, `manual` for `chain` and `team`). `cleanup` is optional and additive, so omitting it keeps legacy fingerprints.
- Validation at planning (so a dry run reports it): IDs exist and are unique, no self-dependency, at most 32 nodes, `depends_on` acyclic (the feedback edge excluded), `on_reject` names a strict ancestor, the decision's output contract declares the verdict field as an enum of exactly the approve and reject values, loop bodies disjoint and no body node is another loop's target, resolved limits within ceilings. The overlapping-write-path warning names a whole loop when a loop body is involved.
- A loop body is every node on the forward paths from the feedback target to the decision node, inclusive.

Limits

- `max_revisions` and `max_total_attempts` resolve per value: request, then project `bootstrap.json`, then global `bootstrap.json` (following `PI_CODING_AGENT_DIR`), then built-in (`max_revisions` 3; `max_total_attempts` = sum over nodes of one attempt plus the revisions its loop allows).
- `bootstrap.json` gains an optional `graph` block with `defaults` and `ceilings`, each holding `maxRevisions` and `maxTotalAttempts`. Project and global merge field by field; for ceilings the lower value wins. It is validated like `modelAliases`: any malformed value stops planning, naming the file and key. A request above a ceiling fails; nothing is clamped.
- Resolved values and their sources go into the manifest, each decision node's configuration and the plan fingerprint.

Revision semantics

- Routing applies only to a decision result with status `success`; the verdict is read from the validated result. `partial` or `failure` keeps its status, starts no revision, spends no budget, settles the loop and kills the forward edges.
- Approve: forward edges fire and the body finalizes. A decision node without forward edges is a sink; its approval completes the run.
- Reject with budget left: the whole loop body re-runs in dependency order as attempt n+1 on the same live agents. The builder's input carries the findings plus references to earlier results; the decision node's input references its own earlier verdicts and findings. Original assignments and briefs are unchanged.
- Reject without loop revisions left: the decision node ends in `on_exhausted`, forward edges dead, cause names the loop. Reject when the next attempts would exceed `max_total_attempts`: the same, with a cause naming the run budget.
- A body node that fails during a revision settles the loop: the decision node's next attempt ends `blocked` with that failure as its cause, and it writes the finalize records.
- Revision and attempt counters are durable; `max_total_attempts` is enforced at admission.

Agent lifecycle (worker module)

- Parked state: after persisting and delivering attempt n, a loop-body agent does not shut down; it resets per-attempt flags and idles. The tool guard is attempt-aware: no task tools while parked.
- A loop body holds its write ownership from its first admission until finalization. A body node without write paths holds nothing while parked.
- A revision handoff is validated like any other handoff (offer, exclusive claim, run token, sender session, digest, contracts, evidence); duplicates are harmless replays.
- A parked agent counts as completed for the shutdown hook, so closing its tab records no failure. A parked agent that dies makes the feedback edge dead and its decision node `needs_attention`; nothing is replayed.
- Finalization record (version 1, one per node): resolves `parked` to the latest attempt's state with a `finalized` marker and releases ownership. Written by the decision node when its loop settles for any reason, or by cleanup (`finalized_by: dispatcher`) for nodes still parked. Published exclusively and raced against revision claims: exactly one wins; a late revision is rejected as "node finalized". Idempotent.

Records and handoffs

- Record naming is fixed at plan time. In a plan with any decision, every node uses attempt- and source-scoped names from attempt 1 (results per attempt with a pointer to the latest; offers, claims, rejections and recovery per destination attempt and source). Plans without a decision keep today's names exactly. Nothing is renamed.
- The handoff ID formula (run, source attempt, destination node, destination attempt, input digest) is unchanged.
- Fan-out delivery state is per outbound edge. A retried completion re-sends only undelivered edges from the saved result.
- A join's admission is one exclusive record listing the claimed inbound handoff IDs. It is the only new stored record joins need. A join is admitted when every inbound edge is `fired` and passes the existing admission decision; it is `blocked` (or admitted under `allow_partial`) when an edge is dead, with causes from all dead edges; it waits while any edge is pending or its source needs attention.
- The upstream index records every attempt, keyed by node and attempt.
- All new records are versioned with versioned readers; an unsupported version is reported and left untouched. Graph runs and chains with a decision use new manifest and config versions.

Cross-cutting

- Required checks are judged per attempt and per inbound edge; a revision invalidates predecessors' evidence through the existing staleness rules.
- Cancellation propagates through the dependency graph and loop body, parked agents included; `fail_fast` cancels parked agents; `force_close` is unchanged.
- `task_timeout_ms` applies per attempt; a join's dependency wait runs from the latest useful progress across all upstream nodes; a parked node's wait follows its decision node's progress.
- Recovery inspects every edge and attempt, re-sends only demonstrably unclaimed handoffs, never reconstructs results.
- Graph plans get a new fingerprint version.

Automatic cleanup

- Trigger: run outcome `succeeded` with every loop settled, every node's result durable with a final delivery state on every outbound edge, and each agent either exited or `cleanup_settle_ms` (default 3000) past its last result.
- Action: the same as `bootstrap_cleanup` with no selectors, never deleting session files. The manifest records `cleanup_trigger: auto` and the time.
- Evaluated by the dispatcher watcher (shared with the widget poller, running even with no widget) and lazily by every `bootstrap_status`, `/boot <task_id>` and `/bootgraph <task_id>` read, under the run lock; exactly one evaluator performs it. Errors are retained with recovery data, shown in status and retried by `bootstrap_cleanup`.
- Status text says the run was cleaned up automatically and points to the report; the watcher also sends a follow-up message.

Observability and widget

- Status adds per-node attempt and limit, parked/finalized, per-edge state and a join's pending/dead inbound edges. Report adds every attempt of looped nodes, the verdict history and blocked-join causes. The run outcome keeps today's precedence; a parked node counts as unsettled until its loop settles.
- New pure module: graph layout and rendering, `renderGraph(model, width, theme)`. Left-to-right by longest path from the roots, parallel chains as lanes, a barycenter pass for row order, fully deterministic. Node glyphs: `◌` pending/waiting, `●` running with elapsed time, `✓` succeeded, `◐` partial, `✗` failed, `⊘` blocked, `!` needs attention, `⏸` parked. Edges: solid fired, dim pending, a marked cut for dead. Loop nodes show `↺ attempt/max` and the last verdict. Header with run ID, topology, node count, outcome and elapsed time; footer with pending and error counts. Vertical fallback when lanes don't fit; `+N more` above a height cap. The dry-run plan uses the same renderer, without status colours, in place of today's arrow text.
- New widget module: one widget per run keyed by task ID, registered only in the dispatcher after a successful non-dry launch, polling the status read about every 2 seconds with an unref'd timer, stopping once the run is terminal and keeping the last frame. `/bootgraph <task_id>` attaches or re-attaches; `/bootgraph clear` removes all; `session_start` clears them. Wrapped so print and RPC modes skip it silently. Read-only.

Delivery stages

- Stage 0: the widget and dry-run rendering for chains and teams, with no execution changes.
- Stage 1: loops on node-form chains: decisions, limits and ceilings, plan-time record naming, the parked state, loop-long ownership, finalization, the `cleanup` field and automatic cleanup, and status, report and widget support for attempts, verdicts and parking.
- Stage 2: the `graph` topology: `depends_on`, `join_policy`, fan-out with per-edge delivery, per-edge handoff records, join admission, the derived edge-state function, decisions inside graphs, and dry run, status, report and widget support for fan-out and joins.
- Stage 3: graph-aware cancellation and recovery, reports, README and release notes; the README stops listing graphs and revisions as unavailable.

## Testing Decisions

A good test drives the system through a public seam and asserts only what an orchestrator or operator can observe: the plan a dry run returns, what `bootstrap_status` and `bootstrap_report` say, the records a run keeps and the text the widget draws. Tests never reach into agent internals, private flags or file layouts beyond what status and report expose.

Seams (confirmed with the user):

1. **The run fixture (primary).** A real bootstrap service with a fake Herdr executor, plus the real worker module loaded once per node from the configurations the service wrote. Tests drive agents (complete, deliver a notification) and observe through the service's status and report. Prior art: the chain fixture used by the handoff-service and outcomes-service tests. It is generalised from two fixed nodes to N nodes, with simulated tab close through the shutdown hook. Nearly every behaviour goes through it: reject then approve, exhaustion and run budget, non-success decisions, builder failure in a revision, duplicate notifications, parked-agent crash, ownership while parked, finalization races in both orders, joins starting once, blocked-join causes, a join waiting on a revising branch, independent parallel loops, per-edge delivery retry, cancel and `fail_fast` while parked, recovery per edge and attempt, and automatic cleanup (exactly once, settle window, retained files, which outcomes keep tabs). Edge state is tested only through what status shows, not on its own.
2. **Planning through the service's dry run.** Validation errors, limits resolution with sources, ceilings and malformed `bootstrap.json`, fingerprints and `request_id` reuse, and the overlap warnings, all without launching anything. Prior art: existing dry-run and model-alias configuration tests.
3. **The dispatcher extension seam.** The bootstrap extension registered with a fake Pi, with the fake context extended by `ui.setWidget`. Covers the widget lifecycle (appears after a non-dry launch only, updates, stops polling when terminal, cleared by `/bootgraph clear` and `session_start`, never registered in agent sessions, silent without a TUI, writes no record) and the watcher's automatic cleanup and follow-up message. Prior art: the tools tests.
4. **The graph renderer (new, pure).** Deterministic snapshot tests for a chain, a team, the narrow-width fallback, a loop, a diamond and parallel chains with a join, plus the dry-run rendering.

The real-Pi runtime suite stays as it is, with one new case: a parked agent's process ending records no failure. Runtime tests create no Herdr tabs, so tab close is simulated at seam 1.

Every stage must leave the existing chain and team tests passing untouched.

## Out of Scope

- Quorum or `any` joins, and cancelling slower parallel agents.
- Nested or overlapping loops.
- Dynamic graph changes after launch.
- LLM-decided routing.
- Worktrees or per-node workspaces; `shared_cwd` stays.
- A central scheduler or runtime owner, active-task concurrency slots and lazy launch (bootstrap-orchestration tickets 19–21).
- Parking agents outside loops, and collaboration leases for answering later questions (bootstrap-orchestration ticket 17).
- Automatic replay of uncertain work, and any exactly-once side-effect guarantee.
- Automatic cleanup by default for chains and teams.
- Agents exiting on their own after finalization (settled agents idle until their tab is closed).

## Further Notes

- `GRAPH-SPEC.md` at the repository root is the detailed design contract this spec was drawn from, including worked plan examples; where the two differ, this spec wins.
- Which upstream findings each builder receives is the plan author's choice through `depends_on`; the engine takes no position.
- Because a loop body holds ownership until finalization, two loops whose write paths overlap run one after the other as whole loops; the dry-run warning says so.
- If the dispatcher session ends before a run succeeds, nothing watches it; the next status, `/boot` or `/bootgraph` read completes the cleanup.
- Persisted-state changes need versioned readers and compatibility fixtures, as in the earlier roadmaps.
