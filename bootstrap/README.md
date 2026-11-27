# Bootstrap

`extensions/bootstrap.ts` launches teams, linear chains, or dependency graphs (with optional bounded review loops) through a Host (`herdr` or `hc`). See the [Host contract](HOST.md) for backend selection and command mappings. Under Herdr, launch uses the **calling pane's** Herdr workspace rather than whichever workspace happens to be focused.

## Prerequisites

- POSIX system with `/bin/sh`, `pi`, and a Host (`herdr` inside a Herdr pane with `HERDR_ENV=1` and `HERDR_PANE_ID`, or `hc` from an `hc` terminal or an ordinary shell with a running `hc` core).
- See the [Host contract](HOST.md) for backend selection (`PI_BOOTSTRAP_HOST`, calling context, or `hc` probe). Launch, existence reporting, discovery, node closing, and fallback wake-up work on both backends.
- Install `coms.ts` under `<project>/extensions/` or alongside `bootstrap.ts`, or pass `coms_extension` explicitly.
- Put personas in the project `.pi/agents` or in the global `agents` folder inside Pi's agent directory (see [Personas](#personas)).
- Declared persona extensions must exist. Relative names resolve under `<project>/extensions/` first, then under the `extensions/` directory beside the persona's agents directory (e.g. `~/.pi/agent/extensions/` for global personas), then beside `bootstrap.ts`. Missing tools, a mismatched model, or a failed Coms registration prevent readiness.

Children retain normal Pi extension discovery (including policy/sandbox hooks); bootstrap does **not** silently disable global extensions. Do not enable incompatible messaging backends that register the same flags/tools, such as Coms and Coms Net, together. This bootstrap backend uses the local Coms registry and request/response API.

## hc status reporting

Bootstrap adds no status extension for hc. Pi 1.6.1 has a native OSC 7501 reporter: Pi's `terminal-setup.md` documents `working`, `blocked`, `done`, `error`, and `idle`, and says Pi reports after the terminal confirms support. Run 3 verified hc answers the query bytes Pi sends (`ESC]7501;?` with its terminator); the query was fixture-sent, not sent from Pi. In run 5 (`bootstrap-hc-findings-jRcpfo`), a real Pi process started inside the isolated hc core with `PI_PROGRAM_STATUS` unset and no input; `hc get --json` showed `reported: true` and `status: {app: "pi", state: "idle"}`. This observed Pi's startup report in that isolated terminal, which does not by itself prove Pi's capability query to hc worked end to end. Set `PI_PROGRAM_STATUS=1` to report without the query or `PI_PROGRAM_STATUS=0` to disable reporting; otherwise Pi follows the query result.

Pi's installed binary emits fields in `state`, `app`, `kind` (for `blocked`; Pi's blocked callers always supply `auth`, `permission`, or `question`), then base64 `msg` order, always terminated with ST (`ESC \`). It sends messages for `blocked` and `error`, and for `working` and `done` when a session name is set; `idle` has no `msg`. It emits `state=clear` when its TUI stops. In run 5 (`bootstrap-hc-findings-jRcpfo`), fixtures sent these exact Pi-shaped reports: hc accepted `blocked` (`kind=auth`, `kind=permission`, and `kind=question`), `working`, `done`, `error`, and `idle`, returning decoded messages in `hc get --json`; after an `idle` report, `state=clear` left `reported: true` and cleared `status` to `null`. A separate Pi-shaped `kind=auth` blocked fixture with valid base64 `msg=` made `hc send` refuse without `--force` (exit 9, `error.kind: "blocked"`, zero delivered bytes). This verifies hc's handling of those fixture payloads. The run did not exercise real non-idle Pi transitions or open a real Pi dialog, so those transitions and a real blocked-dialog wake-up remain unverified. If a future or different Pi blocked payload is rejected, a wake-up could reach the open dialog; Redelivery is the only backstop. Host status remains advisory and never determines Bootstrap workflow state (ADR 0003).

## Personas

A **persona** is a Markdown file that describes a kind of agent: its name, its tools, its model, and its instructions. An **agent** is a running Pi session that was started from a persona.

Bootstrap looks for personas in two places only:

| Where | Use it for |
| --- | --- |
| `<project>/.pi/agents` | Personas that belong to one project |
| `~/.pi/agent/agents` (or `$PI_CODING_AGENT_DIR/agents`) | Personas you want everywhere |

The global folder lives inside Pi's agent directory. That is `~/.pi/agent` unless you set `PI_CODING_AGENT_DIR`, in which case it is `$PI_CODING_AGENT_DIR/agents`. The same directory holds your global `bootstrap.json`. A `~/.pi/agent/agents` folder is ignored when `PI_CODING_AGENT_DIR` points somewhere else.

If both places have a persona with the same name (upper or lower case does not matter), the project one is used. Team definitions stay in `<project>/.pi/agents/teams.yaml`.

Personas in other folders (`.claude/agents`, `.gemini/agents`, `.codex/agents`, or a plain `agents` folder) are **not** found. Bootstrap does not fall back to them. To move your old personas over, follow the [migration guide](MIGRATION.md).

The old interactive persona switcher (`system-select`) is gone, along with its `/system` command, its `--agent` flag and its shortcuts for cycling personas. Both Bootstrap and `subagent-widget` (`/sub --persona` and `subagent_create`) discover and resolve personas from these two places; `subagent-widget` delivers the persona body through the launch environment (`PI_SUBAGENT_PERSONA_PROMPT`, removed from the child's environment after its helper loads), so it rejects persona bodies containing NUL bytes or exceeding 100 KiB (102,400 UTF-8 bytes) before launching a child.

A persona can also back a subagent: `subagent-widget` snapshots its prompt, resolved model and thinking level, non-empty `tools:` list (absent or empty tools keep the read-only set), and resolved `skills:` paths (none when omitted or empty) at launch. Explicit `--model` and `--thinking` flags (or tool parameters) override the persona, which overrides the parent's model and thinking level, and those overrides stay sticky across continuations; `--skills` adds skills for that launch or turn only, `extensions:`, `color` and `description` are ignored, and `--write` cannot be combined with a persona, at launch or on continue. Continuations (`/subcont` and `subagent_continue`) reuse the launch snapshot—so later edits or deletions of the persona file do not affect already-started subagents—and `/subcont` rejects `--persona` while `subagent_continue` rejects a `persona` argument. Before continuing, `subagent-widget` checks that each snapshotted persona skill path still exists on disk and fails before starting a child if one is missing.

When `/sub` or `/subcont` starts a turn immediately, its info line shows the persona name with the model and thinking level selected for that turn. The subagent widget row shows the persona name with its active or queued model and thinking level when terminal width permits; narrow rows prioritize the name. A launch that fails before spawn falls back to the persona's model. The result delivered to the parent and the notify-only notice do not include the persona name.

For details on how a persona can back a subagent, see [Subagents with a persona](../subagent-widget.ts#L15).

### Example persona

```markdown
---
name: reviewer
model: review
thinking: medium
tools: read, grep
skills: code-search
---
You review code. Point out bugs and risky changes. Do not edit files.
```

## Models and thinking levels

### Model aliases

An alias is a short name for a model. You define your own. Bootstrap does not come with any.

Put aliases in a file called `bootstrap.json`:

- `~/.pi/agent/bootstrap.json` for aliases you want everywhere (this is `$PI_CODING_AGENT_DIR/bootstrap.json` if you set that variable).
- `<project>/.pi/bootstrap.json` for aliases that only one project should use.

Both files are optional. A missing file just means "no aliases".

```json
{
  "modelAliases": {
    "review": { "model": "openai/gpt-5", "thinking": "high" }
  }
}
```

Rules:

- `model` is required and must be a full `provider/id`.
- `thinking` is optional.
- Alias names ignore case. `Review` and `review` are the same alias, so you cannot define both in one file.
- If the project file and the global file both define an alias, the project one wins **as a whole**. Fields are not mixed. If the project entry leaves out `thinking`, the thinking level from the global entry is dropped too.
- If a file is broken (bad JSON, an alias that is not an object, a missing or malformed `model`, an invalid `thinking`), planning stops. The error names the file and the key. This happens even if your plan would not use that alias.

### Choosing a model in a persona

The `model:` line can be:

- an alias, such as `model: review`
- a full ID, such as `model: openai/gpt-5`
- either one with a thinking level added after a colon, such as `model: review:low`

Full IDs are used exactly as you wrote them. They may contain a colon (for example `ollama/llama3:8b`). Bootstrap only treats the text after the last colon as a thinking level if it really is one.

An unknown alias stops planning. Bootstrap never picks a different model for you.

If a persona has no `model:` line (or leaves it blank), it uses the model of the session that launched it. If there is no such model, planning stops and names the persona.

### Thinking levels

The levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

A level can come from three places. The first one that is set wins:

1. the suffix on `model:` (for example `review:low`)
2. the persona's `thinking:` line
3. the alias's `thinking`

An invalid level in any of these places stops planning and tells you where it came from. Write the `thinking:` line and alias levels in lowercase. The suffix may be any case.

If none of the three sets a level, Pi uses its own default.

### What you will see

- A dry run (`bootstrap_generate` with `dry_run: true`) shows each agent's resolved model and thinking level.
- After launch, the model the agent is really running must match the plan. The check ignores the thinking level, and it accepts a dated version of an undated ID.
- Changing a level changes the plan's fingerprint, so a changed persona is not mistaken for the same request.

## Allowed skills

By default, every agent is told about every skill Pi finds. Skills take up most of Pi's default prompt, so a reviewer or a scout often carries a lot of text it never uses.

The `skills:` line in a persona lets you pick:

| In the persona | What the agent is told about |
| --- | --- |
| no `skills:` line | every skill (same as before) |
| `skills:` (empty) | no skills |
| `skills: code-search, review` | only those skills |

Things to know:

- Use the skill's own `name` (the one in its `SKILL.md`). Spelling and case must match exactly.
- The name `none` is reserved, so a skill called `none` cannot be allowed. Putting `none` in `skills:` stops planning. For no skills, leave the field empty.
- A dry run shows the list as you wrote it. It does **not** check the names.
- The names are checked when the agent starts, against the skills Pi actually found. If one is unknown, the launch fails before any work starts. The error (also shown by `bootstrap_status`) names the persona and the skill.
- A graph node cannot change its persona's skills. If two nodes need different skills, use two personas.

**This saves context. It is not a security limit.** An agent can still read a skill file if it knows the path, and a person can still run a skill command.

## What the agent's prompt looks like

Bootstrap adds your persona text **in front of** Pi's normal prompt. It does not replace Pi's prompt.

Bootstrap also removes the section of Pi's prompt that explains Pi's own documentation. Agents doing normal work rarely need it. If an agent does need it, tell it the path to the installed Pi package's `README.md` or to a file in its `docs/` folder, and it can read it from there.

Two limits:

- If a later Pi version changes how that section is written, Bootstrap leaves it in. The agent still works, with a longer prompt.
- Prompt text and tool rules added by other extensions are not touched.

## Known limitations

- Removing prompt rules that other extensions add is not supported yet.
- You cannot yet control the full list of extensions each persona loads. The `extensions:` line only adds extensions.

## Identities

A **run** is one invocation; its public identifier is the `task_id` (the run ID). Each requested assignment is a **node** with a unique `node_id`. A node runs a **persona** (a reusable configuration discovered as described above). An **attempt** (`attempt_id`, `<instance_id>.1` initially, and `<instance_id>.2`, `<instance_id>.3`, ... on revisions) is one execution of a node, and an **agent** is the live Pi process for it, identified by its `instance_id` (`a<position>-<node>`, also its Coms name) and the Coms session recorded in its ready file. These are separate: several nodes can run the same persona, and `task_id` is never used to identify a node.

- Node IDs match `[A-Za-z0-9][A-Za-z0-9_.-]{0,79}`, are unique within a run and compare case-insensitively. A duplicate node ID is rejected before anything is launched. Persona names may repeat freely.
- Each agent entry takes either the explicit form, `persona` plus an optional `node_id` (default: the persona name, so a repeated persona needs distinct node IDs), or the legacy form `name` (persona and node ID at once, so it cannot repeat). The two forms cannot be mixed in one entry. A legacy request is normalized to the explicit form (`node_id` = `persona` = `name`): it resolves to the same plan, keeps its chain order and `step` handling, and keeps the same request fingerprint, so an existing `request_id` still finds its run.
- Chain `predecessor`/`successor` consistency checks name node IDs.
- Model-facing text names the node, and the persona when it differs (`a2-review-ui (review-ui, persona reviewer)`). Pending lists use node IDs. `bootstrap_cleanup` `agents` selectors match an instance ID or a node ID first; a persona name works only when exactly one node uses it, and an ambiguous selector (a persona shared by several nodes, or a node ID that is also another node's instance ID) is rejected without closing anything.
- `bootstrap_report` attributes explicit results by `node_id`; an `agent_name` (persona) alone is accepted only when exactly one node uses that persona. Collected results carry `node_id` and the persona as `agent_name`.

## Coms transport for bootstrap workers

Each agent process gets a Coms hop limit of `max(5, total attempt budget + 2)`. For a plan without a decision node, the attempt budget is the number of planned nodes. This leaves room for every handoff allowed by the run while keeping Coms's default limit of 5 for ordinary agents. Command nodes do not use Coms and receive no bootstrap hop limit.

Coms still assigns a numbered name when a requested name is already in use. A bootstrap worker checks its registered Coms name before acknowledging readiness; if Coms renamed it, launch fails immediately with an error naming the planned and assigned names.

## Workflow

0. `bootstrap_generate` with `dry_run: true`: validate and show the fully resolved plan (persona file and source, model, thinking level, tools, extensions, allowed skills, edges, joins, loop bodies, resolved limits and sources, cleanup policy, whole-loop ownership warnings, and a static box-drawing graph preview) without creating Host terminals or files.
1. `bootstrap_generate`: validate the plan and dependencies, persist a manifest, create Host terminals, submit launchers, wait for every child's readiness acknowledgement, then release work. In an interactive dispatcher session, attaches a live graph widget (`/bootgraph`); when `cleanup` is `on_success` (the default for `graph`), also arms the automatic-cleanup watcher.
2. `bootstrap_status`: read per-agent state (`waiting`/`working`/`done`/`error`/`closed`, heartbeat age, result summary), each node's execution state, causes and evidence (see [Execution outcomes](#execution-outcomes-and-dependency-policies)), derived edge states (`pending`/`fired`/`dead`), join pending/dead inbound edges, loop attempt counters (`attempt N/M`), `parked`/`finalized` state, `last_verdict`, the run outcome, pending nodes, durable results, agent initialization/exit errors, delivery errors, and each dependent node's handoff (`handoff`/`handoffs_in` and `handoff_out`/`handoffs_out`; see [Handoffs](#handoffs-delivery-is-not-acceptance)). Ownership waits name the conflicting holder and identify when that holder or its review loop is waiting for a person. Also evaluates automatic cleanup lazily. Host idle status is **not** treated as task completion. Pass `wait_ms` (≤ 30 min) to block until every agent finished, any error appears, or the wait expires, instead of polling turn by turn.
2a. `bootstrap_recover` (when a chain, graph, join, or feedback handoff was not delivered or accepted): `inspect` reconciles the saved evidence across every edge (or one node); `retry_delivery` re-sends the same unclaimed handoff (passing `source` as well as `agent` for a join node; see [Recovering interrupted delivery](#recovering-interrupted-handoff-delivery)). It never re-runs a task.
3. `bootstrap_cancel`: omit `agents` to cancel the whole run, or pass `agents` (node IDs, instance IDs, or unique persona names) to cancel selected nodes without closing Host terminals or deleting session files. Cancellation intent (`<instance>.cancel.json` / `cancel.json`) is persisted before signalling agents; agents observe it after release, deny new handoff admission and new completions, preserve results already committed before cancellation (completion vs cancellation races are resolved durably via `<instance>.outcome-claim.json`), propagate cancellation through loop bodies (including parked agents), and mark downstream dependents `blocked`. When a run or an unclaimed successor is cancelled while a source's handoff delivery is still `pending` or `failed` (including an approved decision node or a live loop node blocked while sending), the source's saved result stays untouched and the run settles because its cancellation means the handoff can never be delivered; edges that were never sent (persisted delivery `pending` or `failed` with no `queued`/`accepted` offer or recorded send) are reported in `bootstrap_status` and `bootstrap_report` as not delivered due to the cancellation, while queued offers keep their queued state and an already-claimed successor keeps its own outcome. Because a hook cannot undo a tool side effect already in progress, active tool work remains `cancelling` until it settles or, after the grace period (`cancel_grace_ms`, default 5000ms), `bootstrap_cancel` is called with `force_close: true` to close verified owned Host terminals for those cancelled nodes (session files and reports remain retained).
4. `bootstrap_report`: omit `results` to collect the durable agent results automatically (nodes that never executed are listed from their records, with their causes and no result; looped nodes include per-attempt and verdict history; blocked joins list their causes); alternatively supply exactly one structured result per planned node that executed. Reports are written under the recorded project, even if the dispatcher cwd has changed. Without `write_markdown`, a stale `report.md` from an earlier call is removed. A delivery error is ignored once the successor has its own durable result (e.g. it already failed on the upstream failure) or settles as cancelled by `bootstrap_cancel` (when never sent, the undelivered edge is recorded on the source entry as not delivered due to the cancellation).
5. `bootstrap_cleanup`: omit `agents` and `tab_ids` to close all owned Host terminals, including ambiguous partial launches, finalize any still-parked loop nodes, and end the run. For `graph` runs, `cleanup` defaults to `on_success`, which runs cleanup automatically once every node succeeds and delivery settles (`chain` and `team` default to `manual`). Passing `agents` (node IDs or instance IDs — stable, preferred on both `herdr` and `hc`; a persona name only when it names exactly one node) or `tab_ids` (Herdr-only, refused on `hc` runs; as recorded, may go stale after Herdr compacts IDs) closes only those agents; on success the run keeps its status (phase `partially-cleaned`) and the call is not an error. Agents whose terminal was already gone are listed in `cleanup_notes`. Reports and session files are retained by default (including after automatic cleanup). Set `delete_session_files: true` to delete them only after every owned Host terminal is closed.

Example team in which two nodes use one persona (distinct assignments, distinct results):

```json
{
  "topology": "team",
  "task": "Review the change",
  "project_cwd": "/absolute/project",
  "agents": [
    { "node_id": "review-api", "persona": "reviewer", "sub_task": "Review the API surface" },
    { "node_id": "review-ui", "persona": "reviewer", "sub_task": "Review the UI flows" }
  ]
}
```

Example ordered chain in the legacy form (links are derived; old `step`, `predecessor`, and `successor` fields remain optional consistency checks):

```json
{
  "topology": "chain",
  "task": "Review and improve the parser",
  "request_id": "parser-review-1",
  "project_cwd": "/absolute/project",
  "agents": [
    { "name": "researcher", "sub_task": "Identify parser edge cases" },
    { "name": "implementer", "sub_task": "Address the preceding findings and run tests" }
  ]
}
```

The legacy chain above keeps `allow_partial` dependencies. In the node form every dependency defaults to `require_success`: in this chain the reviewer starts only after a successful implementer whose required `tests` check still has passing, current evidence (the implementer records it with `bootstrap_verify`), and the final step is allowed to proceed on a partial review:

```json
{
  "topology": "chain",
  "task": "Fix the parser",
  "project_cwd": "/absolute/project",
  "agents": [
    { "node_id": "implement", "persona": "implementer", "sub_task": "Fix the parser bug",
      "required_checks": ["tests"] },
    { "node_id": "review", "persona": "reviewer", "sub_task": "Review the fix" },
    { "node_id": "summarize", "persona": "writer", "sub_task": "Summarize the review", "dependency_policy": "allow_partial" }
  ]
}
```

Reusing `request_id` with the same plan returns the original run (plans are compared canonically, so key order, persona-name case and explicit-vs-omitted defaults do not matter), including its failure or cleanup state; it never blindly launches duplicates. A changed plan with the same key is rejected. Use a new key for an intentional fresh launch. Without an explicit key, the tool-call ID is used.

The same key launched from two dispatcher processes at once creates one fleet: the second process waits for the first (the key's run lock, up to 15 minutes unless cancelled) and then returns the same run. If the first launcher died, the retry returns the reconciled run (`error/interrupted` before release, `applied/released` after it) and never launches again; clean it up and use a new key to start over. Personas without a `model` inherit the dispatcher's current model, which is therefore part of the plan: retrying a key after switching the dispatcher's model is rejected as a different plan.

## Execution outcomes and dependency policies

Four things are recorded separately and never inferred from one another: **resource state** (the manifest's per-agent `status`: planned, creating, ... released, closed), **execution state**, the **agent-reported result** (`success`/`partial`/`failure`) and **verification evidence**. Closing a tab or pane is a resource operation: it does not erase recorded results, and a report can still be written after cleanup (note: a full `bootstrap_cleanup` on an unfinalized review loop also finalizes still-parked loop nodes on the decision node's last reviewed attempt, which settles an unfinalized rejection as `failed` and leaves later unreviewed attempts out of the final outcome). `bootstrap_status` shows each node's `resource`, `execution`, `execution_causes`, `result_status` (the agent's own report) and `verification`; the legacy `state` word (`done`, `error`, ...) is unchanged.

**Execution states.** `pending` (released, no heartbeat yet), `waiting` (alive, not started, e.g. a chain follower), `running`, `succeeded`, `partial`, `failed` (the three terminal states an agent's own report produces), `blocked` (never executed: a dependency can never be satisfied), `skipped` and `cancelled` (never executed, or stopped, by a decision recorded for the node; `cancelled` is produced by `bootstrap_cancel`, pre-release launch cancellation, or expired `task_timeout_ms`, and `skipped` is reserved in the schema and reporting — not produced automatically by current features), and `needs_attention`. `needs_attention` is **unresolved**, not terminal: an agent that exited or crashed, an unreadable or foreign record, a predecessor whose handoff never came (after `dependency_wait_timeout_ms` without useful upstream progress; default 5 minutes), or a node whose tab was closed before any outcome was recorded. It never admits dependants, and nothing here replays the task: a transport failure or an ambiguous execution is for the dispatcher to look at, and the node's prior effects are not assumed away.

**Deadlines and liveness.** Running-task duration (`task_timeout_ms`, optional per-run or per-node, measured from admission rather than fleet launch/wait time), dependency wait (`dependency_wait_timeout_ms`, default 300000ms, per-run or per-follower-node), readiness (`ready_timeout_ms`, default 60000ms), and liveness diagnosis (`liveness_timeout_ms`, default 600000ms) are configured and evaluated separately. Heartbeats (`updated_at`) prove only that the agent process event loop is alive; useful progress is tracked separately via `activity_at` (model turns and tool calls). A live-but-stalled agent (fresh heartbeat, stale `activity_at`) is diagnosed as `stalled` in `bootstrap_status` without auto-killing, while a waiting chain follower does not treat its predecessor's heartbeat as useful progress and times out with `needs_attention` after `dependency_wait_timeout_ms`. Omitting `task_timeout_ms` preserves existing unlimited long-running workflow behavior.

**Causes.** A node that did not execute has a `<instance>.disposition.json` (version 1, with the run, node, persona, attempt and instance identity, the state, a reason and `causes`) instead of a result. `causes` lists the direct cause first and then the original causes it inherited, as `{ node_id, state, reason }` (plus `check: { name, evidence }` when the cause is required evidence). Node A fails, B is blocked by A, C by B: C's causes are `[B blocked, A failed]`. A blocked node is **not** a failed execution: it has no agent result, counts as "not executed" in digests, and the original failure stays the root cause. A node with a result never has a disposition.

**Dependency policy.** Each dependent node (a chain node after the first, or a graph node with `depends_on`) has `dependency_policy` governing how it treats each inbound source's reported outcome:

| Inbound source | `require_success` | `allow_partial` |
| --- | --- | --- |
| succeeded | admit | admit |
| partial | blocked | admit |
| failed, blocked, skipped, cancelled | blocked | blocked |
| needs_attention, still pending/waiting/running | wait | wait |

Requests in the node form (`persona`/`node_id`) default every dependency to `require_success`; the legacy `name` form defaults to `allow_partial`, as before. Either form can set `dependency_policy` per dependent node (not in a team, on the first chain node, or on a graph root node with no `depends_on`, which have no dependencies). On a graph join, an omitted `dependency_policy` follows `join_policy` (`require_success` for `all_success`, `allow_partial` for `allow_partial`). The resolved policy is recorded on the manifest and in the agent's configuration. Records written before policies existed have none and are read as `allow_partial`, the behavior they ran under. A request key reserved by the previous release for a node-form chain still finds its run; a plan that uses `require_success` has its own fingerprint (alongside any brief or contract fields).

The decision is made by the follower before it admits any task tool, from the predecessor's durable record, and again by its timer when no handoff will come (a predecessor that never executed sends none; neither does one whose handoff failed). A `partial` predecessor under `allow_partial` is admitted and its result is passed on as before.

**Verification evidence.** Checks are recorded by `bootstrap_verify` (see below): each record has the check ID, the real result, the node's identity, and content snapshots of the relevant project state before and after the check (including untracked files; `.git`, `node_modules` and the run's own `.pi/agent-sessions` are ignored). A node lists the check IDs it must pass in `required_checks` (or its `output_contract`'s). Those are also what its dependent needs: when the dependent is admitted, each of the predecessor's required checks is judged against the project **as it is then**, from the latest record for that check (earlier records are history):

- `missing`: no record for the check. `failed`: the latest run did not pass (`fail` or `error`).
- `unverified`: relevance cannot be established (an empty or unreadable scope, a snapshot that could not be taken, an unreadable or unsupported evidence file), or the project changed *while* the check ran, so the run says nothing about any single state.
- `stale`: it passed on a consistent state, but the relevant files (the declared scope, or the whole project when none was declared) have changed since.
- `passing`: it passed and nothing relevant changed.

Anything but `passing` blocks the dependent (`blocked`, with a `check` cause) even though the predecessor reported `success`; the reason, `execution_causes[].check.evidence` and `bootstrap_status` (`evidence`, per required check) distinguish them. Required evidence also gates an allowed `partial` predecessor. `bootstrap_status` also lists each recorded check's result and applicability (`verification`).

The scope is chosen when a check is recorded; nodes declare only required check IDs. `dry_run` emits one warning listing every concurrently runnable node with required checks that has at least one concurrent peer with required checks, and advises recording those checks with a scope. This warning does not fail planning. Without a scope, verification keeps its conservative whole-tree snapshot.

**Run outcome.** `bootstrap_status` and the report aggregate the nodes' states by a fixed precedence, so the result never depends on node order: `needs_attention`, `incomplete` (anything still pending, waiting or running), `failed`, `blocked`, `cancelled`, `skipped`, `partial`, `succeeded`. Only a run in which every node succeeded is `succeeded`; unexecuted work is never counted as success. A report lists every node: executed nodes with their result and `execution_state`, nodes that did not execute as an entry with `status` `blocked`/`skipped`/`cancelled`, a "Not executed" summary and their `causes`. Such nodes cannot be given a result through explicit `results`. A run with a `needs_attention` node is not complete and the automatic report is refused until it is resolved.

## Independent teams, ownership and failure policies

- **Collaboration mode (`collaboration_mode`):** New plans (`persona`/`node_id`) default to `independent` execution. In `independent` mode, unsolicited peer task activation via Coms (`coms-inbound` prompts and direct `coms_send` calls by an agent's model) is rejected while internal coordination (validated chain handoffs and ownership admission) and user controls (direct user prompts, `/new`, `/resume`, `/fork`, `/reload`) are preserved. Pass `collaboration_mode: "collaborative"` to opt into peer collaboration explicitly. Legacy `name` requests default to `legacy` and retain their existing messaging behavior with visible guidance in preview, launch, and agent instructions.
- **Shared-cwd default and advisory ownership:** All runs use the existing `project_cwd` (`shared_cwd`) by default. Known ownership conflicts queue overlapping writers in `project_cwd`; diagnostics and conflicts never authorize or automatically create git worktrees. Path declarations (`read_paths`, `write_paths`) and active tool lists are an **advisory scheduling contract** unless backed by external enforcement or separate workspaces — never a filesystem sandbox.
- **Read/write ownership and serialization:** Each node may declare `read_paths` and `write_paths` within `project_cwd` (`.` / `*` / `**` denotes whole-project scope; parent directories conflict with descendants, while segment boundaries like `src/foo` vs `src/foobar` do not). Readers (`read_paths` without `write_paths`) and disjoint writers execute concurrently. Known overlapping writers are serialized in deterministic plan order (`ownership_wait_for`), and resulting waits are reported in `bootstrap_generate` (`dry_run: true`) and `bootstrap_status`. A queued writer's status names the holder: when a live holder has a pending direction request, it renders `X (waiting for a person)`, and when a review loop holds the paths while one of its members has a pending direction request, it renders `<holder> (loop waiting for a person at <requesting_node>)` (with `ownership_waiting_on[].human_wait_node_id` in `bootstrap_status` details, replacing the earlier `wait_reason: "human"` field on waiting-on entries). Ordinary running and uncertain holder wording remains unchanged.
- **Durable ownership admission and uncertain execution:** Ownership admission is persisted in `<instance_id>.ownership.json` (`waiting` / `admitted` / `released`) and survives agent `/reload` and recovery. A queued writer is admitted only when every earlier conflicting writer has a valid durable result or a clean terminal non-executed disposition (`blocked`, `skipped`, `cancelled`). A conflicting writer is **never** released solely because its heartbeat disappears when execution remains uncertain (`needs_attention`, `.error.json`, process exit, or corrupt record).
- **Failure policy (`failure_policy`):** Defaults to `independent`, keeping healthy members (and serialized writers after an explicit failure result) independent of another member's failure. Set `failure_policy: "fail_fast"` to publish `fail-fast.json` on failure and cancel remaining unfinished or ownership-queued members (`cancelled` disposition) while preserving already-committed results. Started agents retain ownership and remain `running` / `cancelling` until `agent_settled` records cancellation with the original cause; only unstarted agents terminalize immediately. Automatic reporting waits for settlement. Unsupported-version, malformed, or foreign `fail-fast.json` files remain untouched and surface as attention errors in status; they deny admission, tool work, automatic reporting, and delivery recovery until the evidence is resolved.

## Graphs, review loops, limits and automatic cleanup

### Splitting and joining work (`topology: "graph"`)

A `graph` plan lets you run branches in parallel and bring them back together at a **join** node (up to 32 nodes). Every agent node must use the `persona` / `node_id` form (`name`, `step`, `predecessor` and `successor` are not allowed in a graph); command nodes are excepted.

Use `depends_on` to list the node IDs a node waits for:

- Leave `depends_on` empty (or omit it) for starting nodes that begin right away.
- When one node is listed in several nodes' `depends_on`, its result is sent along each outgoing edge separately. If one edge fails to deliver, `bootstrap_complete` or `bootstrap_recover` re-sends only that edge without re-running the node.
- A node with two or more entries in `depends_on` is a **join**. It starts once, after every incoming edge has finished and passed its checks (`required_checks` and policy).
- Circular `depends_on` edges, unknown IDs, self-dependencies, and duplicate names in `depends_on` are stopped during planning.

Example: two parallel scouts that feed one integrator join (`join_policy: "allow_partial"` lets the integrator run even if one scout returns `partial`):

```json
{
  "topology": "graph",
  "task": "Check API and UI, then summarize",
  "project_cwd": "/absolute/project",
  "agents": [
    { "node_id": "scout-api", "persona": "scout", "sub_task": "Inspect the API" },
    { "node_id": "scout-ui", "persona": "scout", "sub_task": "Inspect the UI" },
    {
      "node_id": "merge",
      "persona": "integrator",
      "depends_on": ["scout-api", "scout-ui"],
      "join_policy": "allow_partial",
      "sub_task": "Combine both reports"
    }
  ]
}
```

**Join policies (`join_policy`).** Set `join_policy` only on a join (a node with more than one dependency):

| `join_policy` | What happens when an inbound source finishes | Default `dependency_policy` on the join |
| --- | --- | --- |
| `all_success` (default) | Every inbound source must return `success` (cannot be combined with `dependency_policy: "allow_partial"`) | `require_success` |
| `allow_partial` | A `partial` inbound source can still admit the join; a `failed`, `blocked`, `skipped` or `cancelled` source still blocks it | `allow_partial` |

**What `bootstrap_status` shows for graphs.** Each edge has a derived state (`pending`, `fired` or `dead`), and joins list which incoming edges are still waiting or dead (for the join example above while `scout-ui` is still running):

```text
- a3-merge (merge, persona integrator): waiting (heartbeat 2s ago) [handoff in h-c39188d2eee521f17936175808ab9866 queued: not accepted yet (a1-scout-api sent it and Coms acknowledged the message; acceptance is recorded only by this node)] [edges: scout-api=fired, scout-ui=pending] [join: allow_partial; pending: scout-ui] [execution waiting]
```

**Wait timeouts and write conflicts:**

- `dependency_wait_timeout_ms` defaults to `300000`ms (5 minutes). In a graph, useful upstream activity normally keeps a waiting node alive. A live worker's explicit human-wait marker excuses only unresolved dependency paths through that worker. At a join, other unresolved prerequisites still time out independently; a completed prerequisite with its handoff in place does not need to make more progress. Heartbeats verify liveness, not useful activity, so an unanswered request from a lost worker does not excuse its dependants. `task_timeout_ms` applies per attempt from admission, excluding time spent waiting for human direction; elapsed ordinary-work time is preserved when the clock resumes. Status distinguishes “waiting for a person”, “waiting behind a human request”, and ordinary dependency waiting from worker liveness problems.
- Nodes with non-overlapping `write_paths` (or only `read_paths`) run at the same time. When two nodes write to overlapping paths, they take turns in plan order. If one of them is inside a review loop, `dry_run: true` warns that the **whole loop** waits or runs before the other writer, because a loop holds its `write_paths` until it finishes. Ownership deadlocks involving loops are caught during planning.

### Deterministic command nodes (`kind: "command"`)

Use a command node for a fixed local operation that should not ask a model to decide what to do. It runs as a direct process, not as a Pi session. In a graph it can be a root, a branch after another node, or a join consumer; command nodes are also supported in chains and teams. Graph nodes use `depends_on` edges; chains and teams use predecessor edges. All use handoffs as for agent nodes.

Declare `node_id`, `kind: "command"`, and `command`. `args` is optional and is passed as individual `argv` entries; Bootstrap does not build a shell command or invoke a shell. `working_directory` is optional (defaults to `project_cwd`) and must resolve to an existing directory within the project. A command node has no `persona`, `model`, `thinking`, or `skills`; planning rejects agent-only settings such as those, `tools`, `extensions`, `intervention`, and `decision`, naming the node and setting. Agent nodes conversely cannot declare `command`, `args`, or `working_directory`. Decision nodes are agent-only.

Command nodes are supervised by `command-runner.ts` under a real Node 26+ binary that supports `--experimental-strip-types` (never the compiled `pi` runtime binary). Planning, publication, factory readiness (`head_status`), and launch resolve `BOOTSTRAP_NODE` first if set (an absolute path or executable name on `PATH`, failing closed if invalid), otherwise `process.execPath` only if it is a verified Node binary (`node`/`nodejs`), and otherwise `node` or `nodejs` on `PATH` — failing closed with a diagnostic before creating tabs or attempts when no usable Node binary is found.

A command receives the immutable task input and upstream results through the graph's `depends_on` edges (or the chain/team predecessor edges) and their handoffs. `output_contract`, artifact requirements, and `required_checks` are validated as for other nodes. Exit code 0 is a success only when the result also passes its contract, artifact, and verification checks. A nonzero exit, spawn/signal/timeout problem, invalid contract, or a stdout envelope declaring `status: "partial"` or `status: "failure"` records a failed result; it blocks dependants under `require_success` and `all_success`. `task_timeout_ms` applies to the running command and records failure when exceeded.

The command receives a trimmed environment: only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `LC_*` and `XDG_*` variables are inherited. `PWD` is set to the resolved working directory. Bootstrap also supplies `BOOTSTRAP_*` paths and identity variables, including the task-input path, upstream-index path and predecessor-path map; the dispatcher's other environment variables (including API credentials) are not inherited.

**Stdout result format.** If trimmed stdout (captured up to 512 KiB) is a JSON object with an object-valued `outputs`, Bootstrap treats it as a result envelope. An object also qualifies when `status` is `success`, `partial` or `failure` and `summary` is a string. Supported envelope fields include `status`, `summary`, `detail`, `outputs`, `artifacts`, `metrics`, `warnings` and `next_steps`. `status: "partial"` and `status: "failure"` both become a failed command result; only `success` can succeed. Any other JSON object is used as `outputs`; JSON larger than the 512 KiB capture limit is truncated and treated as non-JSON. Non-JSON output is allowed when no contract requires JSON outputs. Stdout/stderr byte counts and trimmed excerpts are retained in command evidence; excerpts are cut at 1000 characters. Stdout is not a way to bypass the output contract.

**Example — fan-out, deterministic merge, then agent consumer:**

```json
{
  "topology": "graph",
  "task": "Collect two reports, merge their JSON, then explain the result",
  "project_cwd": "/absolute/project",
  "agents": [
    { "node_id": "api", "persona": "scout", "sub_task": "Write api.json" },
    { "node_id": "ui", "persona": "scout", "sub_task": "Write ui.json" },
    {
      "node_id": "merge", "kind": "command", "command": "node",
      "args": ["scripts/merge-reports.mjs", "api.json", "ui.json"],
      "working_directory": ".", "depends_on": ["api", "ui"],
      "join_policy": "all_success",
      "output_contract": { "required_fields": ["merged"], "properties": { "merged": { "type": "object" } } }
    },
    { "node_id": "explain", "persona": "writer", "depends_on": ["merge"],
      "sub_task": "Explain the merged result" }
  ]
}
```

The command's stdout can be `{"outputs":{"merged":{"count":2}}}`. The command node participates in fan-out, joins, dependency policy, durable handoff offer/claim, and `read_paths`/`write_paths` ownership just like an agent node. Path ownership remains advisory scheduling, not a sandbox. In `bootstrap_status`, the text status line shows the command, exit status, duration, byte counts and process-group ID; status details carry `kind`, command, arguments, working directory and structured `command_evidence` (including excerpts). `bootstrap_report` includes the command result and `command_evidence`; blocked commands have no result, as for other unexecuted nodes. (In the test suite's end-to-end demo of this topology, `command-node.test.ts` drives the downstream agent consumer with a mocked test-only worker rather than a live Pi session.)

Cancellation and process-group termination are fail-closed. Bootstrap kills the command's whole process group and verifies it is dead before recording `cancelled` or releasing its `write_paths` ownership. During cancellation, timeout, normal exit, restart, or `bootstrap_cleanup` (full, subset, and automatic cleanup), damaged or unverified process-group evidence, or an unconfirmed process-group kill, makes the node `needs_attention` (not `failure`, not `success` even if the command exited 0 with a valid contract, and without triggering `fail_fast` on the timeout/exit unconfirmed-termination path), keeps `write_paths` ownership held, and records full `command_evidence` (including `termination_error`, exit result, signal, timing, and excerpts) naming the surviving process group and how to resolve it; a missing exit observation alone with a verified-dead group still records `failure` and releases ownership. On `bootstrap_cleanup` (full or subset) for direct runs, a verified kill of the `.pgid.json` group releases `write_paths` ownership while leaving the `needs_attention` disposition and evidence intact; an unverifiable group reports `cleanup-incomplete` and keeps ownership held (if the command already saved a result or disposition, cleanup still fails closed as `cleanup-incomplete` without overwriting that outcome). For factory-managed runs, `bootstrap_cleanup` is refused and neither `/factory clear` nor `bootstrap_recover` kills or verifies the process group (the operator must stop and verify the named process group by hand before clearing the hold). **Termination verification limit:** termination is verified only for the command's original process group; a descendant that calls `setsid` or daemonizes leaves the group and cannot be tracked or verified — only an OS boundary (such as a cgroup or container) could track or stop escaped descendants. The runner writes `<key>.pgid.json` when it spawns the process. On restart, a live orphan is stopped and verified; a command already spawned without a result is not automatically run again. Such restarts become `needs_attention` (or `cancelled` if cancellation was pending and the orphan was confirmed dead). A root command with no result, disposition or `.pgid.json` may start normally. Before release, abort handling checks `abort.json` before `release.json`; if `release.json` exists but fails validation, that release-validation error is recorded instead of a pending cancel.

### Recovering a factory direction request

Use `/factory requests <factory-id>` to inspect the original request, response and consumption claim. For decision nodes, inspection also shows the saved verdict and each applicable successor or revision admission separately. `not_admitted` means there is no matching destination claim; a queued handoff is not admission. A terminal approval has no applicable destination. Inspection never sends a wake-up or resumes work.

A factory definition can add a routing choice to an intervention-enabled decision node, for example `intervention: { "choices": [{ "choice_id": "ship", "label": "Approve this review", "route": "approve" }] }`. `route: "approve"` maps to the node's own `decision.approve`, not the choice ID. The operator's selection binds just that attempt. The decision agent may ask for ordinary clarification, but cannot offer another routing choice for the bound attempt. `intervention.require_route: true` makes a human-selected route mandatory for a successful decision; otherwise decline or an unselected route leaves the existing agent verdict policy in place.

The agent may omit the verdict in `bootstrap_complete` when a choice binds it. Bootstrap rejects a conflicting verdict and still verifies outputs, checks and artifacts before saving a successful result. Guidance does not change the plan or bound verdict: report irreconcilable guidance with `status: "failure"` and `direction_conflict`. Such a result takes neither route. Approval of a terminal decision finalizes its branch; independent work and factory capacity still follow normal settlement.

After confirmed takeover, `/factory respond <factory-id> <request-id>` can answer an actionable pending request. If the response was already saved but not claimed, `/factory wake <factory-id> <request-id>` resends only the wake-up for that exact answer and the verified original wait. It does not change the choice, create an agent, or start a turn. A consumed response is never woken again. A verified live attempt is shown as continuing once Pi records receiving the answer. A claim without that receipt or a recorded run result leaves continuation uncertain, even if the worker is still alive. Settled requests remain history and do not become actionable if run files are lost. Missing, damaged, or contradictory request evidence blocks response recovery, but does not prevent cancellation or independently verified settlement or clearance. Pending waits saved by older versions without receiver identity cannot be recovered by this command.

### Review loops (`decision`)

Add `decision` to a node (usually a reviewer) so its verdict routes the run: move forward when approved, or send the work back to an earlier node for a new attempt.

`decision` works in both `topology: "graph"` and node-form `topology: "chain"` (not in `team` or legacy `name` plans).

**Smallest example — a two-node chain loop:**

```json
{
  "topology": "chain",
  "task": "Build and review the parser fix",
  "project_cwd": "/absolute/project",
  "agents": [
    {
      "node_id": "build",
      "persona": "implementer",
      "required_checks": ["tests"],
      "sub_task": "Implement the parser fix and run tests"
    },
    {
      "node_id": "review",
      "persona": "reviewer",
      "output_contract": {
        "required_fields": ["verdict"],
        "properties": {
          "verdict": { "type": "string", "enum": ["approve", "changes_requested"] }
        }
      },
      "decision": {
        "field": "verdict",
        "approve": "approve",
        "reject": "changes_requested",
        "on_reject": "build",
        "max_revisions": 3,
        "on_exhausted": "needs_attention"
      },
      "sub_task": "Review the fix and return verdict"
    }
  ]
}
```

How `decision` works:

1. **Contract check:** The decision node's `output_contract` must require `field` as a `string` `enum` with **only** the two values named in `approve` and `reject`. Routing reads that structured field, never free text.
2. **Loop body:** `on_reject` must name an earlier node that leads to the decision node. That target, the decision node, and every node on the paths between them form the **loop body**. Loop bodies cannot overlap, cannot contain another join (except as the `on_reject` target), and non-decision nodes in a loop body cannot have outgoing edges (successors) outside the loop body.
3. **Approval (`approve`):** When the decision node finishes with `status: "success"` and returns `approve`, its outgoing edges fire, the loop body is marked finalized, and any downstream nodes start. If the decision node is the last node in the run, the run completes.
4. **Rejection (`reject`):** When it returns `status: "success"` and `reject` with revisions left:
   - The feedback edge sends the reviewer's findings back to `on_reject`.
   - Every node in the loop body runs again in order as attempt 2, 3, ... on the **same live agents**, so the builder keeps its session context.
   - Re-activated builders get the reviewer's findings plus references to earlier results (`bootstrap_read_input` reads full details). The reviewer's next attempt input also links back to its earlier verdicts and findings.
   - Required checks (`required_checks`) are checked again on every attempt.
5. **Non-`success` outcomes:** If the decision node returns `partial` or `failure`, or if any node in the loop body fails, is blocked or is cancelled during a revision, the loop stops right away: remaining loop-body nodes are marked `blocked`, outgoing edges become `dead`, and the loop body finalizes without spending more revisions.
6. **Running out of revisions (`on_exhausted`):** If `reject` happens when `max_revisions` (1–10, built-in default `3`) or `max_total_attempts` is used up, the decision node ends as `on_exhausted` (`needs_attention` by default, or `failed`), its outgoing edges become `dead`, and any waiting join is blocked with a cause naming the loop or run budget.
7. **Parked agents and finalization:** Between attempts, agents in a loop body stay alive and idle (**parked**) instead of exiting. While parked, task tools are turned off and the agent is never marked stalled. When the loop finishes (by approval, exhaustion, failure or cancel), **finalization** writes `<instance>.finalize.json`, releases `write_paths` ownership, and allows the run to reach a final outcome even before tabs close. Closing a parked or finalized agent's tab records no failure. If a parked agent crashes when a revision is needed, the feedback edge becomes `dead` and the decision node becomes `needs_attention` without re-running work.

**Full graph example — two parallel review loops feeding a join:**

```json
{
  "topology": "graph",
  "task": "Parallel features and review",
  "project_cwd": "/absolute/project",
  "agents": [
    { "node_id": "scout-a", "persona": "scout", "sub_task": "Scout A" },
    { "node_id": "scout-b", "persona": "scout", "sub_task": "Scout B" },
    { "node_id": "build-a", "persona": "implementer", "depends_on": ["scout-a"], "write_paths": ["src/a"], "sub_task": "Build A" },
    { "node_id": "build-b", "persona": "implementer", "depends_on": ["scout-b"], "write_paths": ["src/b"], "sub_task": "Build B" },
    {
      "node_id": "review-a", "persona": "reviewer", "depends_on": ["build-a"], "sub_task": "Review A",
      "output_contract": { "required_fields": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["approve", "changes_requested"] } } },
      "decision": { "field": "verdict", "approve": "approve", "reject": "changes_requested", "on_reject": "build-a", "max_revisions": 3 }
    },
    {
      "node_id": "review-b", "persona": "reviewer", "depends_on": ["build-b"], "sub_task": "Review B",
      "output_contract": { "required_fields": ["verdict"], "properties": { "verdict": { "type": "string", "enum": ["approve", "changes_requested"] } } },
      "decision": { "field": "verdict", "approve": "approve", "reject": "changes_requested", "on_reject": "build-b", "max_revisions": 2 }
    },
    { "node_id": "merge", "persona": "integrator", "depends_on": ["review-a", "review-b"], "sub_task": "Integrate A and B" }
  ]
}
```

Calling `bootstrap_generate` with `dry_run: true` prints the resolved limits, cleanup mode, and a static graph view:

```text
  cleanup: on_success (settle window 3000ms)
  max_total_attempts: 17 (built-in)
plan · graph · 7 nodes
◌ scout-a ──▶ ◌ build-a ──▶ ◌ review-a ──┬──▶ ◌ merge
              ↺ 1/4         ↺ 1/4
◌ scout-b ──▶ ◌ build-b ──▶ ◌ review-b ──┘
              ↺ 1/3         ↺ 1/3
```

### Limits and `bootstrap.json`

Two limits keep loops from running forever:

- `max_revisions` (per decision node): integer from `1` to `10`. Built-in default is `3` (so up to 4 attempts: 1 initial + 3 revisions).
- `max_total_attempts` (per run): total attempts allowed across every node in the run (only valid when the plan has at least one decision node). Built-in default is `node_count + sum(max_revisions * loop_body.length)` — for example, `17` in the 7-node graph above (`7 + 3×2 + 2×2`). At launch it must cover at least the first attempt of every planned node (`>= node_count`, otherwise launch fails with `"max_total_attempts must cover the first attempt of every planned node"`; note that `dry_run: true` does not enforce this floor).

For each limit, Bootstrap uses the first place that sets it:

1. The request (`decision.max_revisions` or `max_total_attempts`)
2. `<project>/.pi/bootstrap.json`
3. Global `~/.pi/agent/bootstrap.json` (or `$PI_CODING_AGENT_DIR/bootstrap.json`)
4. Built-in default

You can put defaults and hard ceilings in `bootstrap.json` under `"graph"`:

```json
{
  "graph": {
    "defaults": { "maxRevisions": 3, "maxTotalAttempts": 24 },
    "ceilings": { "maxRevisions": 5, "maxTotalAttempts": 40 }
  }
}
```

- Project and global `graph` settings mix field by field (unlike `modelAliases`, which replace per alias). For `ceilings`, the **smaller** limit wins, so a project file cannot raise an operator's global ceiling.
- A bad `graph` block (wrong type, non-positive integer, `maxRevisions > 10`, or a default above its own ceiling) stops planning and names the file and key, even if the plan has no loops.
- Exceeding a ceiling always fails planning (Bootstrap never silently lowers your number), including when the value comes from the built-in derived `max_total_attempts` or a global default; if a tight `ceilings.maxTotalAttempts` rejects the built-in derived default, set `graph.defaults.maxTotalAttempts` (or `max_total_attempts` on the request) at or below the ceiling. Dry run shows each resolved limit and where it came from (`request`, `project`, `global` or `built-in`), and those values are frozen into the run.

### Risk lanes (`lanes` in project `.pi/bootstrap.json`)

Projects may optionally gate decision-node approvals by changed repository paths using `"lanes"` in `<project>/.pi/bootstrap.json` (global `bootstrap.json` must not set `"lanes"`):

```json
{
  "lanes": {
    "contained": ["docs/**", "README.md"],
    "closed": ["auth/**", ".env*"]
  }
}
```

- **Off by default:** When `"lanes"` is omitted or both arrays are empty, lanes are disabled and existing flows keep their original behavior and record versions. Malformed lane objects, unknown keys (`contained` and `closed` are the only allowed keys), absolute paths, `".."`, empty path segments (such as `docs//a`), empty brace alternatives (such as `{,src}/x`), globs exceeding 64 brace expansions, globs that can only match excluded snapshot directories (`.git`, `node_modules`, `.pi/agent-sessions`), or invalid glob syntax fail planning and publication explicitly. Because the excluded-directory check uses conservative wildcard matching, some patterns that could also match real paths (such as `.p?/agent-sessions/**`, `.pi/*-sessions/**`, `.pi/agent-sessions*`, or `.gi?/**`) are likewise rejected explicitly. Globs are **anchored at the project root** (so `.env*` matches only top-level `.env*`; use `**/.env*` to match dotfiles at any depth).
- **Frozen per launch & deterministic:** Active lane globs are frozen into version 8 (`LANE_VERSION = 8`) run manifests and node configs at launch so mid-run edits to `.pi/bootstrap.json` cannot lower an active attempt's classification (for factories, published versions do not pin `.pi/bootstrap.json` `"lanes"`—each input launch reads live `.pi/bootstrap.json` `"lanes"` at launch time and freezes them into that run). Each decision attempt derives its lane deterministically from cumulative repository snapshots of the loop body (`<reviewer>.1.lane-before.json` captured when the loop target begins executing vs `<reviewer>.<n>.lane-after.json` at decision completion, or a live read-only snapshot while in flight). Models never choose a lane.
- **Concurrent writers in a shared checkout:** `dry_run` emits one warning per affected loop, listing the concurrent loop bodies and outside writers it can collide with. It warns for concurrent loop bodies when either can write, and when a loop body can run alongside another writer. Lane snapshots remain whole-repository snapshots; a loop's review can count another branch's edits and escalate. These warnings do not fail planning.
- **Classification precedence:** Most restrictive wins (`contained` < `wide` < `closed`). Any changed path (including renames, deletions, or symlink targets) matching no configured glob falls into `wide` (never `contained`). Missing, incomplete, truncated (> 5000 files or > 64 MiB), corrupt, digest-mismatched, or symlink-escaping snapshots fail closed as unknown change scope: **`closed`** when `lanes.closed` is non-empty, or `wide` otherwise, and are reported in `bootstrap_status` and `bootstrap_report`.
- **Approval requirements & views:** `contained` requires reviewer approval; `wide` additionally requires every loop-body member's declared `required_checks` to be passing and current; `closed` requires a recorded human approval choice for that attempt even when the reviewer approves and all checks pass (and human approval still cannot bypass contracts, checks, or artifact integrity). A `closed`-lane attempt on a decision node without human-approval intervention does not fall back to `wide`—it settles `blocked` naming `closed` and the matching path(s), and planning emits a warning whenever `lanes.closed` is configured alongside any unprotected loop member (including an unrestricted decision node with no `write_paths`). Derived `risk_lane` (`lane`, `deciding_paths`, `requirement`, and any unknown scope) appears in decision (`bootstrap_status`), request (`/factory requests`, `/factory respond`), and report (`bootstrap_report` JSON/digest/Markdown) views.
- **Shared-checkout snapshot trust boundary (Ticket 16 frozen):** Deleting, corrupting, truncating, or mismatched-digest editing `<reviewer>.1.lane-before.json` or `<reviewer>.<n>.lane-after.json` fails closed (classified as `closed` when `lanes.closed` is non-empty), and the reviewer worker refuses an existing `<reviewer>.<n>.lane-after.json` that does not match its live working-tree snapshot (even if it matches a forged baseline). However, because session records currently live inside `.pi/agent-sessions/<task>/` on the shared filesystem while Ticket 16 OS/workspace isolation is frozen, a loop-body agent with write access inside `.pi/agent-sessions/<task>/` could still forge `<reviewer>.1.lane-before.json` with a recomputed `snapshot_sha256` matching the modified working tree, pre-plant `<reviewer>.<n>.lane-after.json` equal to the live tree, or tamper with `<reviewer>.<n>.lane-after.json` after the worker writes it, and yield `contained`.

### Learned constraints (`.pi/constraints.json`)

Projects can maintain learned rules in `<project>/.pi/constraints.json` (`version: 1`, `constraints: [{ id, text, provenance, status: "active" | "retired" }]`):

- **Missing file and standalone opt-in / replay:** When `.pi/constraints.json` is missing (`ENOENT`), there is no behavior change and records/fingerprints remain unchanged. Standalone `bootstrap_generate` runs ignore `.pi/constraints.json` unless `use_learned_constraints: true` is passed; standalone `request_id` replay re-validates `.pi/constraints.json` during `prepare()` to verify `samePlan` (failing if the file was corrupted or modified, naming the learned constraints digest change when constraints differ). Factory launches read `.pi/constraints.json` automatically at launch without altering or rebinding any published factory definition version, and `/factory restore` also validates preserved definitions against live `.pi/constraints.json` and fails if the file is invalid or overflows.
- **Validation, prompt safety, and bounds:** Reads reject symlinks, non-regular files, files over 1 MiB, invalid UTF-8 bytes (a leading UTF-8 BOM is stripped and accepted as valid JSON), invalid JSON, unknown keys, unsupported versions, duplicate IDs (case-insensitive), unknown statuses, incomplete provenance (requires `note` or `run_id` + `attempt_id` + `evidence_ref`), > 64 total entries, > 32 active entries, per-entry `text` over 512 UTF-8 bytes, ASCII/C1/Unicode line-separator, Unicode zero-width/format (`\p{Cf}`, including ZWJ emoji sequences, ZWNJ in Persian/Indic scripts, and soft hyphens), and bidi control characters (including newlines and tabs), and prompt-structure injection markers (code fences, markdown headings, `<|...|>` tokens, `[INST]`, `<<SYS>>`, prompt XML/role tags, or Bootstrap section/protocol markers).
- **Shared-brief injection & fail-closed overflow:** Active entries (`status: "active"`, formatted as `[id] text`; `retired` entries are validated but excluded) are appended to the run-level `Constraints:` section of the bounded shared brief for the whole run (never per-node `node_constraints`). Combined plan `constraints` and active learned constraints must fit within `BRIEF_LIST_MAX_BYTES` (`2048` UTF-8 bytes) and `BRIEF_LIST_ITEM_MAX_BYTES` (`768` UTF-8 bytes per item) without truncating or dropping anything; overflow, unreadable files, or schema errors fail closed at launch (blocking a factory's FIFO head with the cause).
- **Launch-time snapshot & immutability:** The validated snapshot (`version: 1`, canonical `digest` computed via SHA-256 over canonicalized validated `{ version, constraints }` JSON rather than raw file bytes, `used_ids`, `entries`) is frozen at launch into the version 9 (`CONSTRAINTS_VERSION = 9`) run manifest, worker configurations, and `<instance>.input.json` (`brief.learned_constraints`, protected by `input_hash`), and surfaced in `bootstrap_status`, `/boot`, `bootstrap_report`, and factory `inspect`. Mid-run edits, corruptions, or deletions of `.pi/constraints.json` do not change in-flight runs, loop revisions, recoveries, or takeovers; missing or digest-mismatched `learned_constraints` on a v9 manifest fails closed on recovery, status, and reports.
- **Shared-checkout trust boundary (before Ticket 16 isolation):** Because `.pi/constraints.json` lives inside the project checkout and Ticket 16 write-scope isolation is not enabled, edits made by loop agents during a run are ignored by that run (which uses its manifest snapshot with digest verification on recovery), while pre-launch writes to `.pi/constraints.json` can affect subsequent launches (and same-user processes with access to `.pi/agent-sessions/<task>/` could rewrite both `manifest.json` and its digest).
- **Proposals, human review, and durable writes (schema v12):** After a finished factory run that needed at least one loop revision or a human-responded direction intervention, `factory_propose_constraint` can propose adding or retiring a constraint with verifiable run evidence (`result:`, `attempt:`, `request:`, or `artifact:`) and optional `conflicting_ids`. Deterministic normalization (`NFC`, trimmed, whitespace-collapsed, lowercased) records duplicates as `dropped_duplicate`; pending proposals surface in `/factory proposals <factory-id>`, `/factory requests`, `factory_inspect`, `bootstrap_status`, and `bootstrap_report`. Only human-confirmed `/factory review-proposal <factory-id> <proposal-id>`, `/factory retire-constraint <factory-id> <constraint-id>`, or `/factory resolve-conflict <factory-id> <proposal-id>` writes, retires (recording `retirement` provenance while keeping original `provenance`), or abandons entries in `.pi/constraints.json` (preserving permissions, `fsync` + pre-rename digest check + `rename` + dir `fsync`, ETag/binding checks, and two-phase `pending_write` -> `synced` crash recovery in `factory_constraint_proposals`, schema version 12); agents can never confirm or retire constraints, and in-flight runs stay unaffected until the next launch.

### Automatic cleanup (`cleanup` and `cleanup_settle_ms`)

Set `cleanup` on the run to choose whether Bootstrap closes tabs when the run succeeds:

- `"on_success"` — **default for `graph`**. Once every node finishes as `succeeded`, every loop is finalized, and every result's delivery is settled (every outgoing edge is recorded as delivered or demonstrably claimed/accepted by its successor after the source exited, or an unrouted node settles only when delivery is `"sent"` or `"not_required"`, or when no longer live with delivery `"pending"`; `"failed"` or an unknown value never settles), Bootstrap closes all owned tabs automatically. Session files and reports are kept, so `bootstrap_report` still works afterwards. On `on_success` runs, an unrouted approving decision node or final node whose result records `delivery: "failed"` is reported as a delivery error and blocks `bootstrap_report`.
- `"manual"` — **default for `chain` and `team`**. Tabs stay open until you call `bootstrap_cleanup`.
- `cleanup_settle_ms` — integer `0`–`86400000` (default `3000`ms). Wait time after a still-live agent saves its last result before automatic cleanup closes its tab, so delivery bookkeeping can finish cleanly (agents that already exited do not wait).

Automatic cleanup **only** runs when the whole run is `succeeded`. Any `failed`, `blocked`, `partial`, `cancelled`, `skipped` or `needs_attention` run leaves its tabs open for inspection. A background watcher checks every ~2 seconds (even without a TUI) and sends a follow-up message when cleanup finishes; if the original dispatcher session closed first, the next `bootstrap_status`, `/boot <task_id>` or `/bootgraph <task_id>` call finishes cleanup.

### Live graph widget (`/bootgraph`)

In an interactive dispatcher session, a successful non-dry `bootstrap_generate` shows a live box-drawing graph of the run. It is read-only, refreshes every ~2 seconds from the durable files, and stops polling once the run finishes (keeping the final frame on screen). It is never shown inside agent sessions and is skipped silently without a TUI.

- `/bootgraph <task_id>` — attach or re-attach the graph widget to any recorded run (works after `/reload`).
- A newly started run (`bootstrap_generate`, `/factory launch`/`retry`, or the factory's automatic next-FIFO launch) automatically removes the widgets of earlier runs in the session that are finished, cancelled or cleaned up, so only current runs are shown. Runs that are still active, cancelling, need attention, or whose status cannot be read are never removed. Use `/bootgraph <task_id>` to show any finished run again on demand.
- `/bootgraph clear` — remove all bootstrap graph widgets. (Starting a new session or shutting down also clears them.)

**What the symbols mean:**

- Nodes: `◌` pending or waiting, `●` running (with `MM:SS`), `✓` succeeded, `◐` partial, `✗` failed, `⊘` blocked, `↷` skipped, `⊗` cancelled, `!` needs attention, `⏸` parked.
- Live edges: solid `──▶` fired, dashed `╌╌▶` pending, cut `─✗▶` dead.
- Loops: `↺ attempt/maxAttempts` (and last verdict if known). Narrow terminals switch to a vertical level-by-level layout, and tall graphs trim with `+N more`.

Example live frame (a diamond where `right` failed and blocked `merge`):

```text
⊘ run r-notheme · graph · 5 nodes · blocked
✓ root ──┬──▶ ✓ left  ──┬─✗▶ ⊘ merge
         ├──▶ ✗ right ─✗┘
         └╌╌▶ ◌ extra
1 pending · 1 error · bootstrap_status
```

And a live loop in progress (from the two-node chain loop example above, while `review` is running attempt 2/4 after returning `changes_requested` and `build` is parked):

```text
● run build-and-review-the-parser-fix-f35b0913-ecdb-47ac-aa54-29c14e7a2052 · chain · 2 nodes · inco…
⏸ build               ──▶ ● review 00:15
↺ 2/4 (changes_requested) ↺ 2/4 (changes_requested)
2 pending · 0 errors · bootstrap_status
```

## Agent protocol

A child loads an immutable persona snapshot, not a second name-based lookup. Its generated launcher keeps task text and paths literal through POSIX quoting parsed by `/bin/sh` itself. The only text typed into the pane's interactive shell is `/bin/sh <launcher>` with a path that needs no quoting in any shell (the cwd-relative path is used when the project path contains special characters).

Each agent child (command nodes excepted) receives a bounded shared brief alongside its own sub-task: the run's overall task and `goal`, run/node `acceptance_criteria` and `constraints` (plus any active learned constraints injected at launch from `.pi/constraints.json` for factory launches or opted-in standalone runs), its `role` and `ownership`, and a UTF-8 safely bounded roster (node, persona, role, ownership, sub-task of every member). Full authoritative task inputs are persisted immutably in `<instance_id>.input.json` (version 2, protected by `input_hash`), while peer outputs and `upstream-index.json` are injected in a separate peer-produced data section clearly distinguished from authoritative assignment instructions. Each agent child acknowledges its actual process, Coms session, instance identity, and model (and records a backend-neutral `host_ref` in its readiness record when running inside Herdr or `hc` — alongside `pane_id` inside Herdr — omitting both otherwise; older records with `pane_id` only remain valid). Command nodes use the separate `command-runner.ts` process (model `(none)`) and do not start a Pi session. Processes and registry identities are revalidated immediately before release. No task starts until every planned node is ready. Team members and chain-first agents then start their tasks. Followers consume an explicit startup message without a model turn; a validated inbound Coms prompt activates them later. The worker's input hook also accepts the exact single-line wake-up `[BOOTSTRAP_WAKE handoff=<handoff_id>]` (bare or inside at most one `<hc from="…" [reach="…"]>…</hc>` wrapper, stripped before matching): when an unclaimed durable handoff offer for the worker's current attempt matches the ID, run and destination attempt, it rebuilds the handoff notification and routes it through the same claim and admission path as a Coms handoff without checking sender identity; already-claimed handoffs replay harmlessly, unknown or mismatched wake-ups are refused without claiming, and any nested, partial, extra-text, or non-exact input passes through untouched. Five-second heartbeats keep later steps waiting while predecessors are working or waiting upstream; five minutes without predecessor progress, or without a handoff after a recorded completion, causes dependency failure rather than timing out healthy long chains.

Agents are told what each status means for their dependants: `success` means the task is done; `partial` means gaps remain, and a dependant that requires success will not start; `failure` means they could not do it.

The agent's tools (`bootstrap_complete`, `bootstrap_read_input`, `bootstrap_verify`):

- `bootstrap_complete` assigns the result to its own node (and persona), recording the run, node, persona, attempt and instance identity with it;
- validates any declared `output_contract` (`required_fields`, bounded `properties` schema, `require_artifacts`, `required_artifact_paths`) and `required_checks` before completing non-failure outcomes;
- stamps file artifacts with producer identity (`producer_node_id`, `producer_attempt_id`, `producer_instance_id`) and `sha256` content hashes, and updates `upstream-index.json` so later nodes can inspect earlier nodes' decisions;
- persists the result before attempting a handoff;
- records a durable handoff offer (see [Handoffs](#handoffs-delivery-is-not-acceptance)) and then uses `coms_send({ target: successorSessionId, prompt: ... })` with a bounded reference to the durable result, avoiding Coms' envelope-size limit; a Coms acknowledgement queues the handoff, it does not mean the successor accepted it;
- validates the predecessor session, run token, the durable handoff offer (run, source and destination attempts, input digest), `upstream-index.json` `result_hash`, declared `output_contract`, upstream artifact existence/hashes, and current passing `required_checks`, then atomically claims the handoff, before authorizing model/tool work (missing/deleted artifacts, changed hashes, invalid outputs, or stale/unknown checks produce a concrete blocker);
- injects structured upstream index summaries and up to 40 KB of predecessor input (cut on a UTF-8 character boundary), marking truncation and explaining how to retrieve full input;
- `bootstrap_read_input` retrieves bounded UTF-8 chunks of the immutable `task_input`, `upstream_index`, any earlier node's (or earlier attempt's) `result`, or a hash-verified `artifact` (even when the persona restricts `read`);
- `bootstrap_verify` records or runs verification checks (`start`/`finish`/`run`/`status`, with `run` requiring `bash` permission), capturing relevant working-tree content hashes before and after execution (including relevant untracked inputs, in both Git and non-Git projects, never relying on commit ID alone). Historical check records are preserved in `<instance_id>.verification.json`; edits during a check or unestablished scope/snapshots mark applicability `unknown` (`unverified` evidence), while edits after a check within its declared scope (or anywhere in the project under conservative omitted scope) mark applicability `stale`. Required checks must be `pass` and `current` before dependent admission; no git worktrees are created;
- records its result as the node's execution outcome; the agent's `partial` or `failure` is its own report, and later nodes decide what to do with it by their dependency policy (a node that is not admitted records a blocked disposition, never a failed result);
- propagates an unsatisfied dependency (an unacceptable predecessor outcome, or required checks whose evidence is missing, failed, unverified or stale) as a blocked node, without authorizing downstream task tools. The integrity checks above (result hash, output contract, artifacts) still fail admission as an attention condition. A version 1 agent (a run launched by an older release) keeps its original behavior and records an upstream failure as its own failure result;
- retains failed deliveries for retry;
- requests graceful child shutdown (for non-loop nodes) or parks loop-body agents before returning `terminate: true` whenever the attempt's result is durably saved and every required handoff is queued or not required (including `not_required`, `sent`, `partial` or `failure` results, approving/rejecting/exhausted decision outcomes, and retries that find the result already persisted and settled), skipping Pi's follow-up acknowledgment model request without changing shutdown/park timing or `activity_at` liveness tracking; validation failures and failed or partial handoff deliveries omit `terminate` so the turn stays open to fix or retry, while blocked risk-lane returns (which still record the node as blocked and call `ctx.shutdown()`) and cancellation or fail-fast refusals also omit `terminate` so the refusal reaches the agent. The runtime-composed system prompt asks the agent to call `bootstrap_complete` on its own as a separate step (without altering persisted `<instance_id>.input.json` or `input_hash`), while sequential completion and tool/turn admission guards prevent queued or parallel work from continuing afterward.

If the user runs `/new`, `/resume` or `/fork` in an agent tab, the old session records why the bootstrap work stopped (an error record, or no failure if it had already completed), restores nothing of the persona/task/tool restriction, and leaves a `<instance>.detached.json` marker. The new session is an ordinary Pi session, and a later `/reload` of it (the launch flag survives) does not turn it back into the agent. After a `/reload` of a live agent, it restores its completion state from durable files and never redoes finished work: an agent whose result is already saved is told only to retry the handoff with `bootstrap_complete` (the saved result is kept), not to redo its task; once delivery succeeds or is found already settled, that retry also terminates the turn with `terminate: true` (while a failed delivery retry keeps the turn open). A reload while a task is still being worked on is not resumed automatically; the agent stays idle and the status view flags it as possibly stalled.

There is no `coms_await({ sender })` inbox API. `coms_await` is only for replies keyed by `msg_id`. The dispatcher need not have Coms loaded: `bootstrap_status` and automatic reports collect files directly.

A recorded successful delivery is not sent again on a completion retry, and the destination's exclusive claim discards duplicate handoffs. This is **not** an exactly-once execution/recovery protocol: an agent crash after claiming a handoff but before saving its result is `needs_attention` and requires operator recovery or an intentional new run, never automatic replay of potentially completed side effects. Inspect the successor before retrying an ambiguous transport failure: `bootstrap_recover` does exactly that and re-sends only a handoff that was demonstrably never claimed.

## Handoffs: delivery is not acceptance

A **handoff** is the immutable transfer of a source attempt's saved result to its successor, plus the successor's acceptance evidence. Three things are recorded separately and never inferred from one another: the handoff's own stage (offered, queued, accepted, rejected), the successor's execution state (waiting, running, succeeded, ...) and Coms delivery. Coms is only the wake-up: its acknowledgement means a message was queued, never that the successor accepted or started anything. The durable records decide whether work may execute.

Every Coms envelope send (prompt, reply and ping) waits at most 5 seconds by default for both connection and acknowledgement. Set `PI_COMS_ACK_TIMEOUT_MS` in the sending process to change that bound. When the wait expires, Coms closes the socket and reports `coms: delivery unknown:` because the peer may already have received the message. `coms: refused:` means the peer returned a nack; `coms: unreachable:` means no live agent matched or the socket could not be reached. Coms readers on both sides enforce a shared 256 KiB limit measured in UTF-8 bytes. An oversized inbound frame is refused as `coms: refused: frame too large: ...`; an oversized acknowledgement read by the sender is `coms: delivery unknown: frame too large: ...` because the original message may already have arrived.

- **Identity.** The handoff ID (`h-` plus 32 hex characters) is derived from the run, the source attempt, the destination node and attempt, and the **input digest** (the sha256 of the canonical saved result, the same value as the upstream index's `result_hash`). Retrying the same completion offers the same logical handoff; a different input, attempt or run is a different handoff.
- **Offer** (`<destination>.handoff-offer.json`, written only by the source): `offered` before the notification is sent, `queued` once Coms acknowledged it or the pane fallback delivered the wake-up. The notification repeats the ID and digest, but only as a hint: the destination checks it against the offer. The offer also records `transport` (`coms`, `pane_fallback`, `skipped`, or `failed`) and `transport_reason` when not queued.
- **Fallback wake-up.** When an agent completing its task gets `coms: unreachable:` or `coms: delivery unknown:` from `coms_send`, or recovery redelivery gets either error from Coms, it routes the wake-up through the run's recorded Host (`host.nodeExists` and `host.sendWakeUp` via `pane-wake.ts`). The completing agent persists the result, writes the offer, sends by Coms, tries the fallback if eligible, then shuts down. The fallback injects `[BOOTSTRAP_WAKE handoff=<handoff_id>]` **only** when all four conditions hold: the destination's readiness record has a Host reference (`host_ref` or legacy `pane_id`), its process is alive, the offer exists and is unclaimed, and the Host reports the node exists. Under `hc`, it runs `hc send --json "$address" "[BOOTSTRAP_WAKE handoff=$handoff_id]"` without `--force` or status gating: a `blocked` (exit 9), `finished` (exit 11), or `not_found` (exit 3) refusal is recorded as `skipped` and leaves the offer on disk for Redelivery, while `unavailable` or other errors record `failed`. Under Herdr, before `pane send-text`, it writes a temp file and atomically claims a pane-keyed pending marker (`pane-<hash>.pane-wake-pending.json`, keyed by `pane_id`, destination `pid`, and `start_time` so a reused PID cannot inherit a marker) with `link(2)` in state `claimed`. The marker also records the claiming caller's PID and start time. Once `pane send-text` succeeds, it is atomically rewritten (`temp` + `rename`) to `text_sent`; once `pane send-keys Enter` succeeds (`sent`), it is removed only if its `claim_id` still matches. If `pane send-text` fails, the `claimed` marker is removed; if `pane send-keys Enter` fails, the `text_sent` marker is kept. For the same handoff, `text_sent` sends only `Enter` without doubling the wake line. A `claimed` marker owned by a live caller returns `failed` (`wake-up in progress or interrupted`) without sending `Enter`; a marker whose recorded caller is provably dead is treated like `text_sent` and recovered by sending only `Enter`. For a different handoff, the fallback checks the old handoff's offer: while it remains unclaimed for this destination, the new wake is refused and both handoffs are named. If it is claimed, missing, or addressed elsewhere, the fallback first sends `Enter` once to submit the old leftover line, then removes that marker by `claim_id` and continues with the new wake. A corrupt marker is left in place and its failure names the marker path and says it can be removed to retry. Write errors, unreadable/corrupt markers and failed stale-line flushes return `failed` without deleting another caller's marker or sending untracked new text. An already-claimed skip also removes its own marker if present. Host agent status (`idle`, `working`, `blocked`, `done`) is never consulted on either backend. Runs whose readiness records have no `host_ref` or `pane_id` skip the fallback. Both backends record the same transport outcomes (`coms`, `pane_fallback`, `skipped`, `failed`).
- **Pending marker repair.** A refusal caused by another live unclaimed handoff names the marker path and says removal allows a retry. Keep that marker while the other handoff is valid; before deleting a wedged marker, submit or clear its leftover pane input so the next wake-up is not appended to the old line.
- **Acceptance** (`<destination>.handoff.json`, written only by the destination): published exclusively (`link(2)`) before any model work, after the admission checks (outcome policy, contracts, evidence). Of any number of racing notifications, in this process or others, exactly one claims; the rest find the claim and are harmless replays (the original acceptance evidence is returned, the task is not restarted and work already under way keeps its tools). The record names the handoff ID, run, source session, source and destination node/attempt/instance, the input digest and when it was accepted.
- **Rejection.** Nothing is claimed and no task authority is granted for a wrong run (token), sender (not the predecessor's recorded session), destination (node, instance or attempt), source attempt, an offer that does not match its bound ID, a missing offer, or an input whose digest changed after it was offered. Refusals are recorded in `<destination>.handoff-rejections.json` (bounded, newest kept). A refusal of one notification (`notification`: wrong sender or token, a notification naming another handoff or digest, no offer) leaves a sound offer acceptable to the genuine notification; a refusal of the handoff itself (`integrity`: the offer or saved input is invalid) is an attention condition for the destination (`error.json`, `needs_attention`) and shows as `rejected`.
- **Crashes.** Crash before the claim: the delivery is demonstrably unclaimed and a replayed notification is accepted exactly once (the dispatcher can repair it, see [Recovering interrupted delivery](#recovering-interrupted-handoff-delivery)). Crash after the claim and before a result: the node is `needs_attention` (status names the accepted handoff; a restarted agent records the same), the claim is never reset, and a replayed notification starts nothing. Crash after the result is saved: the result is kept and nothing is re-accepted or re-run.
- **Status.** `bootstrap_status` shows `handoff` (into the node) and `handoff_out` (to its successor) with the ID, state, digest, timestamps, recent refusals and `problems` (unreadable or unsupported records, or an acceptance whose digest no longer matches the source's saved result, which is also an agent error). Joins use `handoffs_in` keyed by source instance ID in place of `handoff`. Fan-out uses `handoffs_out` keyed by destination instance ID in place of `handoff_out`. A decision node also exposes its feedback handoff in `handoffs_out` once offered. A source can check the destination’s acceptance and digest in the outgoing handoff status. A queued handoff that was rejected shows `rejected` with recovery guidance (nothing ran; inspect the source's saved result, then `bootstrap_cleanup` and relaunch with a new `request_id`); the node is never shown as accepted or running for it.
- **Compatibility.** Chains launched by this release set `handoff_protocol: 1` in agent configurations; agents without it (version 1 runs and runs launched by the previous release) keep the original notification and receipt, now written exclusively. Their receipt has no handoff ID or digest and shows as `accepted` with `legacy`. Records are version 1 with versioned readers; an unsupported version is reported clearly and left untouched.

## Recovering interrupted handoff delivery

`bootstrap_recover` repairs **delivery** of a chain, graph, join, or feedback-edge handoff from saved evidence. Delivery retry is distinct from a new task attempt: it never re-runs a task, never replaces the source's original result, never resets or overrides a claim, and never asks a model to reconstruct a result. It works when the source has exited.

- **`inspect`** (read-only, takes an optional successor `agent`; covers every chain, graph, join, and active feedback edge without it) reconciles, per edge: the source's saved result (and its recorded delivery), the handoff offer, the successor's acceptance receipt and rejections, the successor's identity (readiness record, live process, Coms registration, tab) and the successor's own result or disposition. It returns a `stage`, a `verdict`, the evidence, any problems found in the records (preserved as found) and the next steps.
- **Verdicts.** `retry_delivery`: the successor demonstrably never claimed the handoff and is the live agent the run launched (stage `deliverable`). `wait`: nothing is wrong yet (`source_unfinished`, `accepted_running`, `awaiting_destination`). `none`: nothing to recover (`completed`; `source_not_executed`; `destination_ended` after a blocked, skipped or cancelled node). `needs_attention`: evidence is uncertain, missing or contradictory and nothing is sent: `claimed_unfinished` (accepted, no result, agent gone: effects unknown), `execution_without_receipt` (no receipt, but a heartbeat or verification record shows it started work; missing acceptance evidence alone never overrides evidence of execution), `receipt_unreadable`, `source_result_unusable`, `destination_unavailable` (gone, closed, refused or recorded a failure), `destination_ended` (needs_attention disposition), `rejected`, `incompatible_plan` (an offer, task input or result for other attempts or an unreadable or unsupported offer or recovery record) and `retries_exhausted`.
- **`retry_delivery`** (needs the successor `agent`, and `source` when the successor is a join node with multiple inbound edges) re-sends the *same logical handoff* (same ID, same saved input, same notification) with no new confirmation, because it starts no new work: the successor validates the offer and the saved input itself and still claims exactly once. Recovery tries Coms first; when Coms reports unreachable or delivery unknown it uses the shared Host wake-up fallback (`HerdrHost.sendWakeUp` / `HcHost.sendWakeUp`) if the durable readiness, offer and Host terminal checks pass. The result and next steps say whether Coms acknowledged, pane fallback sent, fallback skipped with a reason, or both transports failed. A pane wake-up is delivery, not acceptance: the handoff shows `accepted` only when the successor claims it (`delivered_by: "dispatcher"` on the claim). If the source exited before recording its offer, the dispatcher records the same offer from the saved result (`offered_by: "dispatcher"`; created exclusively, never replaced).
- **Authority.** Before waking, recovery still records the dispatcher's Coms session and the exact handoff ID in `<successor>.handoff-recovery.json`; the successor accepts a Coms wake-up from a session other than its predecessor's only when that record names that session for exactly that handoff ID, and then runs every ordinary check (offer binding, digest, outcome policy, contracts, evidence). Pane wake-ups carry no sender identity and rely on the same offer and exclusive destination claim. The authorization record's sender and handoff checks are unchanged. Same-user processes are not isolated by this; it protects against accidents, not malice. Agents launched before durable handoffs (no `handoff_protocol`) cannot verify a redelivery, so they can be inspected but not repaired.
- **Serialization and bounds.** `retry_delivery` holds the run lock, so it is serialized with launch, report and cleanup and concurrent recovery callers (in one process or two) send once. The sender agent and recovery are separate processes, so the pane-keyed pending marker also arbitrates their fallback attempts. A re-send acknowledged by Coms or sent by pane fallback is given 30 seconds before another is allowed (`awaiting_destination`); failed or skipped attempts can be retried at once; five attempts in all are allowed (`retries_exhausted`). An in-progress or interrupted pane marker is reported as retryable and does not consume the redelivery attempt limit.
- **Refused outright.** A run that was cleaned up, cancelled or aborted, or is in error, is not recovered (inspect still reports what the records show, with `closed`); neither is a run whose session files are unavailable. A plan that changed (the offer, the successor's saved task input or the source's result are for other attempts than the manifest now records) is `incompatible_plan`: nothing is sent and nothing is rewritten.
- **Explicit decisions.** Anything `needs_attention` needs a person's (or the dispatcher model's explicit) decision: inspect the effects, then `bootstrap_cleanup` and a new run with a new `request_id`. Starting a new run after uncertain side effects is never done by recovery, and no exactly-once side-effect guarantee is promised.
- **Limits.** A waiting successor gives up on a predecessor that has made no progress for 5 minutes (it records `needs_attention` and exits); recovery must happen before that, and cannot wake an agent that has gone. Status treats an accepted handoff as proof of delivery: a source whose acknowledgement was lost no longer shows a delivery error once the successor accepted. Recovery's Coms and pane fallback paths are exercised through its injected wake-up dependencies; the real `coms_send` path from a dispatcher session to a live Pi agent is not covered by an automated test. Pane injection is exercised in deterministic and runtime tests against fake `herdr` and `hc` binaries on `PATH` and in the opt-in `live` suite against real Herdr.

## Upgrade, rollback and operator playbook

This release ships `graph` topology (fan-out and joins), bounded review loops (`decision`), `bootstrap.json` `graph` limits, `cleanup: "on_success"`, and the `/bootgraph` live widget alongside the hardened chain/team core. See [release notes](RELEASE-NOTES.md) for shipped capabilities and limits. The six dispatcher tools remain `bootstrap_generate`, `bootstrap_status`, `bootstrap_report`, `bootstrap_recover`, `bootstrap_cancel` and `bootstrap_cleanup`; `/boot` lists or inspects runs and `/bootgraph` attaches or clears live graph widgets. Synthesis, collaboration leases (and parking outside loops), supervision, lazy launch, concurrency slots and isolated worktrees remain unavailable. Deterministic `kind: "command"` nodes are also supported; they run a declared executable without a model and may participate in graph edges and joins.

Before upgrading, collect reports for completed runs, inspect unresolved work, and cancel/clean up old agents as appropriate. Upgrade the dispatcher and agents together between runs. **Do not mix releases within a run**, including changing extension code under a live agent and then using `/reload`. Keep session files and the independent recovery index until effects and reports have been reviewed. There is no in-place migration command: older manifests retain their original format, and new runs use the current version for their plan shape (versions 2–7). Runs containing command nodes use record version 7 (manifest, worker configuration and result records); older binaries reject those records rather than interpreting them. Runs without command nodes keep the existing record versions and behavior unchanged.

Defaults for new runs differ from legacy runs:

- Teams are explicitly independent; unsolicited peer tasks are refused. Healthy nodes continue after another node fails unless `failure_policy: "fail_fast"` is selected.
- New chains and graphs require successful predecessors and current passing required checks. Set a node's `dependency_policy: "allow_partial"` (or `join_policy: "allow_partial"` on a join) deliberately to consume partial output. Old records without a policy retain `allow_partial`.
- `graph` runs default `cleanup` to `"on_success"` (closing owned tabs automatically once all nodes succeed and delivery settles, while keeping session files and reports); `chain` and `team` default to `"manual"`.
- All agents use the existing project directory (`shared_cwd`), including dirty repositories. Disjoint declared writers can run together; known conflicting writers wait in plan order (loop bodies hold ownership until finalization). Declare `read_paths`/`write_paths` to express ownership. No operation creates a worktree automatically; unsupported workspace strategies and unknown topologies are refused at record boundaries as well as launch.
- Node IDs identify assignments; persona names can repeat. Use node IDs for selection when a persona is ambiguous. New handoffs require durable offer validation and destination acceptance before work starts; a queue ACK alone is insufficient.

Rollback is a between-run operation. Older readers reject newer manifest versions (such as v3–v7 graph, review and command runs, or v2 runs on a v1 reader) rather than misreading them. In particular, an older binary cannot inspect or continue a run containing command nodes; return to a supporting release first. Plans without command nodes are unchanged by this addition. Restore the current release to inspect/report/clean up those runs before downgrading; do not change version numbers by hand or delete claims to force admission. Additive gates on older-format records are not enforced by older agents, so compatibility of the file format does not make mixed-release execution safe. Back up retained evidence before intentional deletion.

For an interrupted or uncertain run:

1. Call `bootstrap_status` with the run's `task_id`. Inspect per-node execution, causes, ownership, handoff state and verification separately from resource state. Preserve the original files if any record is corrupt or unsupported.
2. For a delivery issue (on a chain, graph, join, or feedback edge), call `bootstrap_recover` with `action: "inspect"`. Only a `retry_delivery` verdict authorizes `action: "retry_delivery"` with `agent` set to the successor node ID (and `source` for a join node). This resends the same saved input, even if the source exited; it does not reconstruct results or reset a claim. Coms must be loaded for the dispatcher authorization; if Coms reports unreachable or delivery unknown, recovery tries the pane fallback and reports its result. Retry before the waiting agent's dependency deadline (default 5 minutes); an agent that exited cannot be revived by recovery.
3. For `needs_attention` (especially a claim without a result, an uncertain writer, missing acceptance evidence despite execution, changed input or corrupt records), inspect actual repository/external effects. Do not remove the claim, release ownership or rerun automatically. Decide explicitly whether to retain the effects or repair them. Stop surviving work with `bootstrap_cancel` if needed, then `bootstrap_cleanup`, and start any intentional fresh launch with a new `request_id` and revised task. Recovery itself never makes this decision.
4. Use `bootstrap_cancel` to stop admission and request running agents to abort, retaining tabs and evidence. Node cancellation blocks downstream dependents and preserves unrelated work and committed results. Hooks stop subsequent tools but cannot interrupt a tool already in flight. Wait for settlement; `force_close: true` is available only after `cancel_grace_ms` and is not proof that external effects stopped.
5. Use `bootstrap_report` to collect results once executed nodes have results and other nodes have recorded final dispositions. `needs_attention` refuses automatic collection. Mixed outcomes retain causes and artifact provenance; an agent's success remains historical even when its check evidence becomes stale.
6. Use `bootstrap_cleanup` to close owned resources. Cleanup does not cancel semantically or erase recorded results (note: a full `bootstrap_cleanup` on an unfinalized review loop finalizes still-parked loop nodes on the decision node's last reviewed attempt, settling an unfinalized rejection as `failed`). By default files remain, and reports can still be written after cleanup. `delete_session_files: true` removes evidence only after all owned resources close, and prevents subsequent report generation. Cleanup failures retain recovery data; retry cleanup rather than removing the index or guessing current tab IDs.

## Persisted formats and compatibility

Newly written records carry an explicit version on run manifests (`version`), agent configurations (`version`), and agent result files (`version` plus an `identity` block with `run_id`, `node_id`, `persona_name`, `attempt_id`, `instance_id`):

- **Version 1**: legacy persona-keyed runs (still read, reported on, and cleaned up, normalized in memory with `node_id` = persona name, and written back in version 1 shape without rewriting). A version 1 result cannot distinguish multiple nodes sharing one persona, so it is rejected for such a run.
- **Version 2 (`CURRENT_VERSION`)**: `chain` and `team` runs without `decision` nodes (unchanged manifests, configs, results and fingerprints when `cleanup` and `cleanup_settle_ms` are omitted); also used for **result files** of loop-free `graph` runs (including joins).
- **Version 3 (`GRAPH_VERSION`)**: manifests and agent configurations for `graph` runs without joins and without `decision` nodes (their result files remain version 2).
- **Version 4 (`JOIN_GRAPH_VERSION`)**: manifests and agent configurations for `graph` runs with joins and without `decision` nodes or command nodes (their result files remain version 2).
- **Version 5 (`REVIEW_VERSION`)**: manifests, agent configurations and result files for `chain` runs with `decision` nodes (`review_plan` on manifest/config/results; attempt-scoped filenames from attempt 1).
- **Version 6 (`GRAPH_REVIEW_VERSION`)**: manifests, agent configurations and result files for `graph` runs with `decision` nodes and without command nodes (`review_plan` on manifest/config/results, plus `topology: "graph"` on manifest and agent configuration; rejected by previous v1–v2 readers).
- **Version 7 (`COMMAND_VERSION`)**: manifests, worker configurations and result records for any run containing at least one `kind: "command"` node. Command result records include `command_evidence`. Readers from releases that predate command nodes reject version 7 rather than misreading it. Plans without command nodes retain their prior versions and behavior.
- **Version 8 (`LANE_VERSION`)**: manifests, worker configurations and result records for decision runs with active project `.pi/bootstrap.json` `"lanes"` configuration (when `.pi/constraints.json` is not active).
- **Version 9 (`CONSTRAINTS_VERSION`)**: manifests, worker configurations and result records for runs launched with a `.pi/constraints.json` snapshot (`learned_constraints`, verified by canonical SHA-256 `digest` and `used_ids`). Older readers reject version 9 rather than misreading it; runs without learned constraints keep versions 2–8 and byte-identical records/fingerprints.

Readers validate at the read boundary:

- An unsupported version, or a record whose identity is missing, malformed or does not match the node whose file it is (wrong run, node, persona, attempt or instance), is reported clearly for that agent (results) or as a failed read (manifest, configuration). The manifest of an unsupported version is never modified, nothing is closed on its behalf, and it is left out of `/boot` listings; use a release that supports it.
- Request reservations are unchanged for legacy/chain/team plans without decisions or cleanup overrides. A plan in which every node ID equals its persona name (every legacy request) keeps the fingerprint written by the previous release; non-default `cleanup` or `cleanup_settle_ms` options on a `chain` or `team` without decisions are included in the existing v2/v3/v4 canonical fingerprint (skipping the pre-canonical legacy fallback); `graph` topologies and plans with `decision` nodes (and their limits) use version 5 fingerprints. Plans with command nodes always have a fingerprint.
- `report.json` stays an array of entries; each result has `node_id` and `execution_state`, and a node that did not execute has an entry with `status` `blocked`/`skipped`/`cancelled` and `causes` (no agent result is invented). Looped nodes include `review_history` (version 1), and executed nodes whose outbound handoff was never sent (persisted delivery `pending` or `failed`, with no `queued`/`accepted` offer or recorded send) before the destination or run was cancelled via `bootstrap_cancel` include `undelivered_edges`.
- Command nodes record execution details in `command_evidence`: executable, argv, working directory, exit code or signal, timing, stdout/stderr byte counts and bounded excerpts, and any spawn or termination error. `<key>.pgid.json` (version 1) records the spawned process-group ID and process start time for cancellation, cleanup, and restart checks. During cancellation, timeout, normal exit, restart, or cleanup, damaged or unverified process-group evidence or an unconfirmed kill fails closed as `needs_attention` (without triggering `fail_fast` on the timeout/exit unconfirmed-termination path) and retains `write_paths` ownership while the command's process group may still be running; a missing exit observation alone with a verified-dead process group records `failure` and releases ownership. Only the command's original process group is verified; descendants that call `setsid`/daemonize cannot be tracked without an OS boundary (cgroup/container).
- Handoff records (`<dest>.handoff-offer.json` or per-source `<dest>.<src>.handoff-offer.json`, `<dest>.handoff.json` version 1 for chains or joins, `<dest>.<src>.handoff.json` for graphs/loops, `<dest>.handoff-rejections.json`, and `<dest>.handoff-recovery.json` version 1, plus `offered_by`/`delivered_by`) and `handoff_protocol: 1` are versioned and validated on read. Cancellation records (`<instance>.cancel.json`, `cancel.json`, `<instance>.outcome-claim.json`, all version 1), dispositions (`<instance>.disposition.json` version 1), ownership (`<instance>.ownership.json` version 1), `fail-fast.json` (version 1), automatic cleanup (`cleanup-policy.json` version 1 and `cleanup_trigger`/`cleanup_at`), and review-loop records (`<instance>.finalize.json` version 1, or version 2 for a non-successful factory review settled at a revision limit, `<instance>.<n>.transition.json` version 1, `<reviewer>.<n>.revision.json` version 1) all carry versioned readers and fail closed on unsupported versions.
- Run manifests also record `host_backend` (`"herdr"` or `"hc"`; absent on older manifests and read as `"herdr"`) and an opaque per-launch `host_ref` on each `pane_manifest` entry (for Herdr, mirroring `tab_id`, `pane_id`, `terminal_id`, and `label`; for `hc`, storing `{ name, address }`, with `workspace_id: "hc"`). Backend selection (`host.ts`) checks `PI_BOOTSTRAP_HOST` first, then the caller context (`HC_TERMINAL_ID`, or `HERDR_ENV=1` with `HERDR_PANE_ID`), then an `hc` server on `PATH`. `hc` launches unset inherited `HERDR_*` variables and export `PI_COMS_DIR`, `PI_COMS_TIMEOUT_MS`, and `PI_COMS_MAX_HOPS` in the launcher script, using `--no-parent --no-notify` with labels `bootstrap_run` and `bootstrap_node`. `hc` cleanup (automatic, explicit full or `agents`-subset `bootstrap_cleanup`, and `force_close` on `bootstrap_cancel`) runs `hc kill` then `hc rm` against verified owned addresses (removing already-finished terminals directly with `hc rm`), while `tab_ids` selection remains Herdr-only and refuses `hc` runs cleanly without modifying them; `hc` wake-ups use the recorded backend through Host. `hc` sends without `--force` or gating on status (letting `hc` refuse `blocked` with exit 9) and accepts a bare wake-up line or one `<hc from="…" [reach="…"]>…</hc>` wrapper: bare wake-up delivery on plain raw-mode terminals (without a wrapper), booting-terminal behavior (`hc send` exits 0 and writes to the PTY immediately; whether early input survives depends on the program's own startup handling — the fixture's 60 ms startup drain discarded it, and in cooked mode CR arrives as LF; covered by Redelivery), and `hc send` without `--force` against `blocked` (exit 9, `error.kind="blocked"`, 0 bytes delivered), `working` (exit 0, `started: true`), and `done` (exit 0, `started: false`, ~6 s, supporting the 70 s wake send timeout) are **verified by live run (`hc 0.1.22`, `bootstrap-hc-findings-FbreNh` and `bootstrap-hc-findings-6bLWs8`)**. Pi's native status details are in [hc status reporting](#hc-status-reporting); run 5 observed a real Pi startup `idle` report in the isolated hc core, and exact fixture reports verified base64 `msg=` handling and blocked-send refusal. A real Pi non-idle transition and an actual blocked-dialog wake-up remain unverified. Remaining unverified: whether a real `pi` agent launched through `hc run` receives an `<hc from="…" [reach="…"]>` wrapper, the unaltered-env terminal self-probe and `HC_SCOPE`-preserving fixture sends (not selected in run 5), whether `hc` injects `HC_SESSION`/`HC_SOCKET` when unset, and the visible effect of `message=`.
- Agents are always launched from the same extension code as the dispatcher. A `/reload` of an old dispatcher in the middle of a live run is not supported.

## Recovery and storage

- Project data: `<project>/.pi/agent-sessions/<task_id>/`.
- Independent recovery index: `~/.pi/agent/bootstrap-sessions/` (override with `PI_BOOTSTRAP_STATE_DIR`).
- JSON, Markdown reports, and launchers use atomic rename and private file permissions, including protection against overwriting targets of leaf symlinks.
- The index records progress before/after external actions and retains a tombstone after file deletion. Cleanup can recover owned resources from that index even when project session files have disappeared.
- A failed or cancelled launch writes an abort marker for children still waiting at the readiness barrier, returns the partial manifest, and leaves tabs available for explicit cleanup.
- Tool `details` only feed the UI; every identifier, error and summary the dispatcher must act on is included in the model-facing text.
- Cleanup, recovery, and `force_close` delegate Host operations through the manifest's recorded `host_backend` (`host-herdr.ts` for Herdr runs and legacy manifests, `host-hc.ts` for `hc` runs), regardless of the caller's shell environment. On Herdr, cleanup resolves live tabs/panes from one `herdr api snapshot` (falling back to concurrent per-workspace listings on older servers) and refreshes that view only after something was actually closed, because public IDs may compact; stable terminal identities take precedence, and renamed/moved terminals or tabs containing other panes are cleaned by closing only the owned pane. On `hc`, cleanup filters with `hc ls --all --label` and confirms each terminal's saved `address` and `bootstrap_run`/`bootstrap_node` labels with `hc get` (never matching by name alone), then runs `hc kill` + `hc rm` (or `hc rm` directly when already `finished`), reporting `not_found` as already closed and failing closed on ambiguity or transient errors. Unrelated supplied IDs, `tab_ids` on `hc` runs, and replaced terminals are rejected.
- A manifest left in `launching` by a launcher that died (crash, kill, `/reload` mid-launch) is reconciled once its run lock is free: if `release.json` carries the run token the run is `applied/released`, otherwise it becomes `error/interrupted` and waiting children are aborted. Status shows the reconciled view; cleanup, report and request-ID retries persist it.
- Request reservations are published with `link(2)`: complete and exclusive, never empty or partial after a crash.
- Heartbeats carry the time of the agent's last model/tool activity. Status shows it and flags working agents silent for 10+ minutes as possibly stalled; nothing is killed automatically.
- One malformed or foreign result/error file is reported for that agent only; healthy results stay visible.
- `/boot` lists recent runs; `/boot <task_id>` shows one run's per-agent status, execution states and the run outcome; `/bootgraph <task_id>` attaches the live graph widget and `/bootgraph clear` clears all widgets.
- Cleanup errors preserve files and recovery information for retry. Directory traversal and symlinked session paths are rejected.

Do not remove manifests or rename ambiguous partial-launch tabs before recovery. A process crash before an external command's result is recorded can leave an uncertain outcome; unique run labels allow cleanup to reconcile those tabs. Operations on a run are serialized in-process and across processes by a `<key>.lock` file in the recovery index (owner PID + start time + runtime instance). A dead owner's lock (including a recycled PID) is recovered automatically; a live one, including another module instance in the same process after `/reload`, is waited for up to 15 minutes. Recovering a stale lock needs an exclusive per-record claim (`<key>.lock.break-<record>-<n>`), so simultaneous contenders cannot remove a live holder's freshly published lock; a claim left by a dead recovering process is superseded automatically. **Cancellation while waiting:** waiting for a run lock (both in the in-process queue and while polling a contended lock file) observes the cancellation signal. A cancelled caller stops waiting immediately without creating, breaking, or removing any lock or break files it does not hold, and without creating any run file, reservation, or tab. Cancellation during the launch itself is handled as described above. Writes are atomic but not fsynced: power loss can lose the most recent update.

## Software factories

Persistent named factories (`/factory` commands, which accept a factory name or id, `/factory queue <factory>` for a compact queue table, and the read-only `factory_inspect` tool) queue plain-text briefs, coordinate checkout capacity, support human direction requests (`bootstrap_request_direction`), and preserve receipts, holds, and reports across sessions. Factory definitions may include deterministic `kind: "command"` nodes under the same command-node rules described above; a factory run containing one uses version 7 records. See the [Software Factory Operating Guide](../docs/factory-guide.md) for first use, publication, submission, blocked-queue diagnosis, intervention, stop/resume, takeover, clearance, and report-only per-node attempt and rollback counts (derived from `upstream-index.json` with no new persisted state), and the [Factory Web Viewer](../docs/factory-web-viewer.md) for the standalone loopback read-only dashboard. Standalone `bootstrap_generate` runs and manual checkout edits are not coordinated with factory capacity holds.

## Tests

Runtime assumptions: Node 26+ (runs `.ts` directly), a POSIX `/bin/sh`, process spawning allowed for the test run, and, for the runtime suite only, the installed `pi` CLI (tested with 1.5.x) and `coms.ts` beside `bootstrap.ts` (or `PI_BOOTSTRAP_TEST_COMS_EXTENSION`). Run from the `extensions/` directory.

| Suite | Command | What it covers |
| --- | --- | --- |
| deterministic | `node bootstrap/run-tests.ts deterministic` | Service, `worker.ts` hooks, storage, reporting and harness tests on real temp files with a fake Herdr CLI and a harmless Pi stand-in. No real Pi, provider or Herdr. |
| runtime | `node bootstrap/run-tests.ts runtime` | The installed Pi (+ Coms) in RPC/print mode: extension loading, agent readiness, handoff admission and an end-to-end deterministic run against a local fake provider. No Herdr tab creation. |
| live | `PI_BOOTSTRAP_LIVE_HERDR=1 node bootstrap/run-tests.ts live` | Explicit opt-in, inside a Herdr pane: read-only checks against the real Herdr CLI. Never part of `all`; without the opt-in it reports `UNVERIFIED` and does nothing. |
| live | `PI_BOOTSTRAP_LIVE_HC=1 node bootstrap/run-tests.ts live` | Independent operator opt-in for the isolated hc core and spike on Linux (optional `PI_BOOTSTRAP_LIVE_HC_ONLY=b,h` selects a question subset while keeping all isolation guards and teardown): must start from a terminal not hosted by `hc`, puts failing systemd/D-Bus shims first on `PATH`, verifies `/proc/<pid>/environ` (allowing only `HC_RUNTIME=1` on the daemon) and `/proc/<pid>/cgroup`, falls back to isolated `hc server stop` + `HC_SESSION`-reverified PID kill if core verification fails, writes `hc-spike-findings.{json,md}` under `PI_BOOTSTRAP_HC_FINDINGS_DIR` (or temp dir), and prints an isolated stop (or `kill <pids>`) command if teardown fails. See the [live spike procedure](HOST.md#live-spike-procedure). |
| all | `node bootstrap/run-tests.ts all` | deterministic, then runtime (never live). |

`node --test bootstrap/*.test.ts` also works for a quick local run (it includes runtime tests; live tests skip without the opt-in), but only the runner provides the isolation below.

`reliability.test.ts` spawns real processes (helpers in `test-support/`) to exercise competing launchers, simultaneous stale-lock recovery, and a launcher killed mid-launch; it takes about 15 seconds and needs permission to spawn Node child processes.

Files belong to suites by name: `live-*.test.ts`, `runtime-*.test.ts`, otherwise deterministic. Add `--strict` (or `PI_BOOTSTRAP_TEST_STRICT=1`) for release/CI runs and `--timeout-ms <n>` to change the suite time limit (defaults 3 / 5 / 10 minutes).

**Isolation.** The runner builds a temporary root and points Pi at it with the runtime's supported variables: `PI_CODING_AGENT_DIR` (config, `auth.json`, `trust.json`), `PI_CODING_AGENT_SESSION_DIR`, plus `PI_COMS_DIR`, `PI_BOOTSTRAP_STATE_DIR` and a fake `HOME`/`XDG_*`. The isolated Pi settings set `defaultProjectTrust: "never"` and disable agent retries. Provider credentials (`*_API_KEY`, `*_TOKEN`, `AWS_*`, `AZURE_*`, ...) and Herdr/hc identity are removed from the child environment. Anything a test writes under the fake `HOME` (for example into `~/.pi`) fails the suite as a user-state leak; the root is deleted afterwards.

**No real providers.** Runtime tests register a local fake OpenAI-compatible provider (`test-harness.ts`). It serves scripted replies deterministically; any call that is not scripted is recorded and refused with 503, and the test asserts `provider.assertNoUnexpectedCalls()`. Request credentials are never retained.

**Honest coverage.** A missing capability (no `pi`, no Coms, sandboxed process spawning `EPERM`/`EACCES`, read-only state directory) makes the test skip with an `UNVERIFIED: <reason>` message; skipped tests are not coverage and the runner prints a count. With `--strict` the same condition is an infrastructure failure (non-zero exit). Earlier environment limits (`spawnSync EPERM`, read-only Pi trust directory) are these cases, not evidence that behavior passed.

**Process cleanup.** Every suite and every child started by the harness runs in its own process group. On a timeout the group gets SIGTERM, then SIGKILL after a grace period; descendants left behind after a normal exit are killed too, and any groups still alive when the runner exits are killed with it.

Live model-backed task execution and live Herdr tab creation are intentionally not part of the automated suites. The real-Coms smoke test also verifies rejection of an unexpected sender before provider work.

Legacy manifests from the previous implementation lack versioned ownership metadata and cannot be safely adopted automatically. Close/review those tabs before reloading into a new run. Dispatcher personas describing the old sender/recipient inbox API should be updated to use bootstrap_status and automatic bootstrap_report collection.
