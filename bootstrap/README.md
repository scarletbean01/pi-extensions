# Bootstrap

`extensions/bootstrap.ts` launches teams or linear chains in the **calling pane's** Herdr workspace. It does not use whichever workspace happens to be focused.

## Prerequisites

- POSIX system with `/bin/sh`, `pi`, and `herdr` on PATH.
- Run inside Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID` set).
- Install `coms.ts` under `<project>/extensions/` or alongside `bootstrap.ts`, or pass `coms_extension` explicitly.
- Personas are discovered through the same registry as `system-select.ts`: project `.pi/agents`, `.claude/agents`, `.gemini/agents`, `.codex/agents`, `agents`, then the corresponding global directories. The first case-insensitive name wins; filenames are sorted deterministically.
- Declared persona extensions must exist. Relative names resolve under `<project>/extensions/` first, then under the `extensions/` directory beside the persona's agents directory (e.g. `~/.pi/agent/extensions/` for global personas), then beside `bootstrap.ts`. Missing tools, a mismatched model, or a failed Coms registration prevent readiness.
- Model aliases (`opus`, `sonnet`, `haiku`, `fable`, `flash`, ...) map to current catalog IDs in `model-utils.ts`; a `:thinking` suffix is kept. The child's actual model must match the plan, ignoring the thinking suffix and allowing a dated snapshot of an undated ID.

Children retain normal Pi extension discovery (including policy/sandbox hooks); bootstrap does **not** silently disable global extensions. Do not enable incompatible messaging backends that register the same flags/tools, such as Coms and Coms Net, together. This bootstrap backend uses the local Coms registry and request/response API.

## Identities

A **run** is one invocation; its public identifier is the `task_id` (the run ID). Each requested assignment is a **node** with a unique `node_id`. A node runs a **persona** (a reusable configuration discovered as described above). An **attempt** (`attempt_id`, currently `<instance_id>.1`) is one execution of a node, and a **worker** is the live Pi process for it, identified by its `instance_id` (`a<position>-<node>`, also its Coms name) and the Coms session recorded in its ready file. These are separate: several nodes can run the same persona, and `task_id` is never used to identify a node.

- Node IDs match `[A-Za-z0-9][A-Za-z0-9_.-]{0,79}`, are unique within a run and compare case-insensitively. A duplicate node ID is rejected before anything is launched. Persona names may repeat freely.
- Each agent entry takes either the explicit form, `persona` plus an optional `node_id` (default: the persona name, so a repeated persona needs distinct node IDs), or the legacy form `name` (persona and node ID at once, so it cannot repeat). The two forms cannot be mixed in one entry. A legacy request is normalized to the explicit form (`node_id` = `persona` = `name`): it resolves to the same plan, keeps its chain order and `step` handling, and keeps the same request fingerprint, so an existing `request_id` still finds its run.
- Chain `predecessor`/`successor` consistency checks name node IDs.
- Model-facing text names the node, and the persona when it differs (`a2-review-ui (review-ui, persona reviewer)`). Pending lists use node IDs. `bootstrap_cleanup` `agents` selectors match an instance ID or a node ID first; a persona name works only when exactly one node uses it, and an ambiguous selector (a persona shared by several nodes, or a node ID that is also another node's instance ID) is rejected without closing anything.
- `bootstrap_report` attributes explicit results by `node_id`; an `agent_name` (persona) alone is accepted only when exactly one node uses that persona. Collected results carry `node_id` and the persona as `agent_name`.

## Workflow

0. `bootstrap_generate` with `dry_run: true`: validate and show the fully resolved plan (persona file and source, model, tools, extensions, chain links) without creating tabs or files.
1. `bootstrap_generate`: validate the plan and dependencies, persist a manifest, create tabs, submit launchers, wait for every child's readiness acknowledgement, then release work.
2. `bootstrap_status`: read per-agent state (`waiting`/`working`/`done`/`error`/`closed`, heartbeat age, result summary), each node's execution state, causes and evidence (see [Execution outcomes](#execution-outcomes-and-dependency-policies)), the run outcome, pending agents, durable results, worker initialization/exit errors, and chain delivery errors. Herdr idle status is **not** treated as task completion. Pass `wait_ms` (≤ 30 min) to block until every agent finished, any error appears, or the wait expires, instead of polling turn by turn.
3. `bootstrap_report`: omit `results` to collect the durable worker results automatically (nodes that never executed are listed from their records, with their causes and no result); alternatively supply exactly one structured result per planned agent that executed. Reports are written under the recorded project, even if the dispatcher cwd has changed. Without `write_markdown`, a stale `report.md` from an earlier call is removed. A delivery error is ignored once the successor has its own durable result (e.g. it already failed on the upstream failure).
4. `bootstrap_cleanup`: omit `agents` and `tab_ids` to close all owned resources, including ambiguous partial launches, and end the run. Passing `agents` (node IDs or instance IDs — stable, preferred; a persona name only when it names exactly one node) or `tab_ids` (as recorded; may go stale after Herdr compacts IDs) closes only those agents; on success the run keeps its status (phase `partially-cleaned`) and the call is not an error. Agents whose tab or pane was already gone are listed in `cleanup_notes`. Reports and session files are retained by default. Set `delete_session_files: true` to delete them only after every owned resource is closed.

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

Reusing `request_id` with the same plan returns the original run (plans are compared canonically, so key order, persona-name case and explicit-vs-omitted defaults do not matter), including its failure or cleanup state; it never blindly launches duplicates. A changed plan with the same key is rejected. Use a new key for an intentional new attempt. Without an explicit key, the tool-call ID is used.

The same key launched from two dispatcher processes at once creates one fleet: the second process waits for the first (the key's run lock, up to 15 minutes) and then returns the same run. If the first launcher died, the retry returns the reconciled run (`error/interrupted` before release, `applied/released` after it) and never launches again; clean it up and use a new key to start over. Personas without a `model` inherit the dispatcher's current model, which is therefore part of the plan: retrying a key after switching the dispatcher's model is rejected as a different plan.

## Execution outcomes and dependency policies

Four things are recorded separately and never inferred from one another: **resource state** (the manifest's per-agent `status`: planned, creating, ... released, closed), **execution state**, the **worker-reported result** (`success`/`partial`/`failure`) and **verification evidence**. Closing a tab or pane is a resource operation: it never changes what a node did, and a report can still be written after cleanup. `bootstrap_status` shows each node's `resource`, `execution`, `execution_causes`, `result_status` (the worker's own report) and `verification`; the legacy `state` word (`done`, `error`, ...) is unchanged.

**Execution states.** `pending` (released, no heartbeat yet), `waiting` (alive, not started, e.g. a chain follower), `running`, `succeeded`, `partial`, `failed` (the three terminal states a worker's own report produces), `blocked` (never executed: a dependency can never be satisfied), `skipped` and `cancelled` (never executed, or stopped, by a decision recorded for the node; the status/report layer reads them, and cancellation and skipping are produced by later tickets), and `needs_attention`. `needs_attention` is **unresolved**, not terminal: a worker that exited or crashed, an unreadable or foreign record, a predecessor whose handoff never came (after the existing five minutes without progress), or a node whose tab was closed before any outcome was recorded. It never admits dependants, and nothing here replays the task: a transport failure or an ambiguous execution is for the dispatcher to look at, and the node's prior effects are not assumed away.

**Causes.** A node that did not execute has a `<instance>.disposition.json` (version 1, with the run, node, persona, attempt and instance identity, the state, a reason and `causes`) instead of a result. `causes` lists the direct cause first and then the original causes it inherited, as `{ node_id, state, reason }` (plus `check: { name, evidence }` when the cause is required evidence). Node A fails, B is blocked by A, C by B: C's causes are `[B blocked, A failed]`. A blocked node is **not** a failed execution: it has no worker result, counts as "not executed" in digests, and the original failure stays the root cause. A node with a result never has a disposition.

**Dependency policy.** Each chain node after the first has `dependency_policy` governing how it treats its predecessor's reported outcome:

| Predecessor | `require_success` | `allow_partial` |
| --- | --- | --- |
| succeeded | admit | admit |
| partial | blocked | admit |
| failed, blocked, skipped, cancelled | blocked | blocked |
| needs_attention, still pending/waiting/running | wait | wait |

Requests in the node form (`persona`/`node_id`) default every dependency to `require_success`; the legacy `name` form defaults to `allow_partial`, as before. Either form can set `dependency_policy` per node (not on the first chain node or in a team, which have no dependency). The resolved policy is recorded on the manifest and in the worker's configuration. Records written before policies existed have none and are read as `allow_partial`, the behavior they ran under. A request key reserved by the previous release for a node-form chain still finds its run; a plan that uses `require_success` has its own fingerprint (alongside any brief or contract fields).

The decision is made by the follower's worker before it admits any task tool, from the predecessor's durable record, and again by its timer when no handoff will come (a predecessor that never executed sends none; neither does one whose handoff failed). A `partial` predecessor under `allow_partial` is admitted and its result is passed on as before.

**Verification evidence.** Checks are recorded by `bootstrap_verify` (see below): each record has the check ID, the real result, the node's identity, and content snapshots of the relevant project state before and after the check (including untracked files; `.git`, `node_modules` and the run's own `.pi/agent-sessions` are ignored). A node lists the check IDs it must pass in `required_checks` (or its `output_contract`'s). Those are also what its dependent needs: when the dependent is admitted, each of the predecessor's required checks is judged against the project **as it is then**, from the latest record for that check (earlier records are history):

- `missing`: no record for the check. `failed`: the latest run did not pass (`fail` or `error`).
- `unverified`: relevance cannot be established (an empty or unreadable scope, a snapshot that could not be taken, an unreadable or unsupported evidence file), or the project changed *while* the check ran, so the run says nothing about any single state.
- `stale`: it passed on a consistent state, but the relevant files (the declared scope, or the whole project when none was declared) have changed since.
- `passing`: it passed and nothing relevant changed.

Anything but `passing` blocks the dependent (`blocked`, with a `check` cause) even though the predecessor reported `success`; the reason, `execution_causes[].check.evidence` and `bootstrap_status` (`evidence`, per required check) distinguish them. Required evidence also gates an allowed `partial` predecessor. `bootstrap_status` also lists each recorded check's result and applicability (`verification`).

**Run outcome.** `bootstrap_status` and the report aggregate the nodes' states by a fixed precedence, so the result never depends on node order: `needs_attention`, `incomplete` (anything still pending, waiting or running), `failed`, `blocked`, `cancelled`, `skipped`, `partial`, `succeeded`. Only a run in which every node succeeded is `succeeded`; unexecuted work is never counted as success. A report lists every node: executed nodes with their result and `execution_state`, nodes that did not execute as an entry with `status` `blocked`/`skipped`/`cancelled`, a "Not executed" summary and their `causes`. Such nodes cannot be given a result through explicit `results`. A run with a `needs_attention` node is not complete and the automatic report is refused until it is resolved.

## Worker protocol

A child loads an immutable persona snapshot, not a second name-based lookup. Its generated launcher keeps task text and paths literal through POSIX quoting parsed by `/bin/sh` itself. The only text typed into the pane's interactive shell is `/bin/sh <launcher>` with a path that needs no quoting in any shell (the cwd-relative path is used when the project path contains special characters).

Each child receives a bounded shared brief alongside its own sub-task: the run's overall task and `goal`, run/node `acceptance_criteria` and `constraints`, its `role` and `ownership`, and a UTF-8 safely bounded roster (node, persona, role, ownership, sub-task of every member). Full authoritative task inputs are persisted immutably in `<instance_id>.input.json` (version 2, protected by `input_hash`), while peer outputs and `upstream-index.json` are injected in a separate peer-produced data section clearly distinguished from authoritative assignment instructions. Each child acknowledges its actual process, Coms session, instance identity, and model. Processes and registry identities are revalidated immediately before release. No task starts until every child is ready. Team members and chain-first agents then start their tasks. Followers consume an explicit startup message without a model turn; a validated inbound Coms prompt activates them later. Five-second heartbeats keep later steps waiting while predecessors are working or waiting upstream; five minutes without predecessor progress, or without a handoff after a recorded completion, causes dependency failure rather than timing out healthy long chains.

Workers are told what each status means for their dependants: `success` means the task is done; `partial` means gaps remain, and a dependant that requires success will not start; `failure` means they could not do it.

The worker's tools (`bootstrap_complete`, `bootstrap_read_input`, `bootstrap_verify`):

- `bootstrap_complete` assigns the result to its own node (and persona), recording the run, node, persona, attempt and instance identity with it;
- validates any declared `output_contract` (`required_fields`, bounded `properties` schema, `require_artifacts`, `required_artifact_paths`) and `required_checks` before completing non-failure outcomes;
- stamps file artifacts with producer identity (`producer_node_id`, `producer_attempt_id`, `producer_instance_id`) and `sha256` content hashes, and updates `upstream-index.json` so later chain stages can inspect earlier stages' decisions;
- persists the result before attempting a handoff;
- uses `coms_send({ target: successorSessionId, prompt: ... })` with a bounded reference to the durable result, avoiding Coms' envelope-size limit;
- validates the predecessor session, run token, `upstream-index.json` `result_hash`, declared `output_contract`, upstream artifact existence/hashes, and current passing `required_checks` before claiming the logical handoff or authorizing model/tool work (missing/deleted artifacts, changed hashes, invalid outputs, or stale/unknown checks produce a concrete blocker);
- injects structured upstream index summaries and up to 40 KB of predecessor input (cut on a UTF-8 character boundary), marking truncation and explaining how to retrieve full input;
- `bootstrap_read_input` retrieves bounded UTF-8 chunks of the immutable `task_input`, `upstream_index`, any earlier stage's `result`, or a hash-verified `artifact` (even when the persona restricts `read`);
- `bootstrap_verify` records or runs verification checks (`start`/`finish`/`run`/`status`, with `run` requiring `bash` permission), capturing relevant working-tree content hashes before and after execution (including relevant untracked inputs, in both Git and non-Git projects, never relying on commit ID alone). Historical check records are preserved in `<instance_id>.verification.json`; edits during or after a check within its declared scope (or anywhere in the project under conservative omitted scope) mark applicability `stale`, while unestablished scope/snapshots mark applicability `unknown`. Required checks must be `pass` and `current` before dependent admission; no git worktrees are created;
- records its result as the node's execution outcome; the worker's `partial` or `failure` is its own report, and later nodes decide what to do with it by their dependency policy (a node that is not admitted records a blocked disposition, never a failed result);
- propagates an unsatisfied dependency (an unacceptable predecessor outcome, or required checks whose evidence is missing, failed, unverified or stale) as a blocked node, without authorizing downstream task tools. The integrity checks above (result hash, output contract, artifacts) still fail admission as an attention condition. A version 1 worker (a run launched by an older release) keeps its original behavior and records an upstream failure as its own failure result;
- retains failed deliveries for retry;
- requests graceful child shutdown after successful persistence/delivery, with sequential completion and tool/turn admission guards preventing queued or parallel work from continuing afterward.

If the user runs `/new`, `/resume` or `/fork` in a worker tab, the old session records why the bootstrap work stopped (an error record, or no failure if it had already completed), restores nothing of the persona/task/tool restriction, and leaves a `<instance>.detached.json` marker. The new session is an ordinary Pi session, and a later `/reload` of it (the launch flag survives) does not turn it back into the worker. After a `/reload` of a live worker, it restores its completion state from durable files and never redoes finished work: a worker whose result is already saved is told only to retry the handoff with `bootstrap_complete` (the saved result is kept), not to redo its task. A reload while a task is still being worked on is not resumed automatically; the worker stays idle and the status view flags it as possibly stalled.

There is no `coms_await({ sender })` inbox API. `coms_await` is only for replies keyed by `msg_id`. The dispatcher need not have Coms loaded: `bootstrap_status` and automatic reports collect files directly.

A recorded successful delivery is not sent again on a completion retry, and receiver-side receipts discard duplicate handoffs. This is **not** an exactly-once execution/recovery protocol: a worker crash after claiming a handoff but before saving its result requires operator recovery or an intentional new run, not automatic replay of potentially completed side effects. Inspect the successor before retrying an ambiguous transport failure.

## Persisted formats and compatibility

Newly written records carry an explicit version: run manifests (`version`), worker configurations (`version`) and worker result files (`version` plus an `identity` block with `run_id`, `node_id`, `persona_name`, `attempt_id`, `instance_id`) are version 2. Readers validate at the read boundary:

- Version 1 records (the persona-keyed format written by earlier releases) are still read, reported on and cleaned up. They are normalized in memory (`node_id` = persona name, no attempt) and, when saved again (for example a cleanup updating status), are written back in the version 1 shape: a live version 1 run is never migrated or rewritten into version 2, and a version 1 worker keeps writing version 1 results. A version 1 result cannot say which of several same-persona nodes it belongs to, so it is rejected for such a run.
- An unsupported version, or a record whose identity is missing, malformed or does not match the node whose file it is (wrong run, node, persona, attempt or instance), is reported clearly for that agent (results) or as a failed read (manifest, configuration). The manifest of an unsupported version is never modified, nothing is closed on its behalf, and it is left out of `/boot` listings; use a release that supports it. A previous release rejects version 2 manifests rather than misinterpreting them.
- Request reservations are unchanged. A plan in which every node ID equals its persona name (every legacy request) keeps the fingerprint written by the previous release; a plan that gives a persona a different node ID is a different plan (a new fingerprint version), so reusing a `request_id` with it is rejected.
- `report.json` stays an array of entries; each result has `node_id` and `execution_state`, and a node that did not execute has an entry with `status` `blocked`/`skipped`/`cancelled` and `causes` (no worker result is invented).
- Policies and outcomes are additive, optional fields (`dependency_policy` on manifest entries and worker configurations, `required_checks` on manifest entries) and one new record kind with its own version 1 reader: `<instance>.disposition.json`. An absent policy reads as `allow_partial`; a manifest or result written before this release is never rewritten to add them. An unsupported or malformed disposition, or one whose identity is another node's, is reported for that node (an attention condition); an unreadable or unsupported evidence file makes every required check of that node `unverified`. A previous release ignores these fields and files: it would run a successor without the new gates, so do not mix releases within one run.
- Workers are always launched from the same extension code as the dispatcher. A `/reload` of an old dispatcher in the middle of a version 2 run is not supported.

## Recovery and storage

- Project data: `<project>/.pi/agent-sessions/<task_id>/`.
- Independent recovery index: `~/.pi/agent/bootstrap-sessions/` (override with `PI_BOOTSTRAP_STATE_DIR`).
- JSON, Markdown reports, and launchers use atomic rename and private file permissions, including protection against overwriting targets of leaf symlinks.
- The index records progress before/after external actions and retains a tombstone after file deletion. Cleanup can recover owned resources from that index even when project session files have disappeared.
- A failed or cancelled launch writes an abort marker for children still waiting at the readiness barrier, returns the partial manifest, and leaves tabs available for explicit cleanup.
- Tool `details` only feed the UI; every identifier, error and summary the dispatcher must act on is included in the model-facing text.
- Cleanup resolves live tabs/panes from one `herdr api snapshot` (falling back to concurrent per-workspace listings on older servers) and refreshes that view only after something was actually closed, because public IDs may compact. Stable terminal identities take precedence; renamed/moved terminals or tabs containing other panes are cleaned by closing only the owned pane. Unrelated supplied IDs and replaced terminals are rejected.
- A manifest left in `launching` by a launcher that died (crash, kill, `/reload` mid-launch) is reconciled once its run lock is free: if `release.json` carries the run token the run is `applied/released`, otherwise it becomes `error/interrupted` and waiting children are aborted. Status shows the reconciled view; cleanup, report and request-ID retries persist it.
- Request reservations are published with `link(2)`: complete and exclusive, never empty or partial after a crash.
- Heartbeats carry the time of the worker's last model/tool activity. Status shows it and flags working agents silent for 10+ minutes as possibly stalled; nothing is killed automatically.
- One malformed or foreign result/error file is reported for that agent only; healthy results stay visible.
- `/boot` lists recent runs; `/boot <task_id>` shows one run's per-agent status, execution states and the run outcome.
- Cleanup errors preserve files and recovery information for retry. Directory traversal and symlinked session paths are rejected.

Do not remove manifests or rename ambiguous partial-launch tabs before recovery. A process crash before an external command's result is recorded can leave an uncertain outcome; unique run labels allow cleanup to reconcile those tabs. Operations on a run are serialized in-process and across processes by a `<key>.lock` file in the recovery index (owner PID + start time + runtime instance). A dead owner's lock (including a recycled PID) is recovered automatically; a live one, including another module instance in the same process after `/reload`, is waited for up to 15 minutes. Recovering a stale lock needs an exclusive per-record claim (`<key>.lock.break-<record>-<n>`), so simultaneous contenders cannot remove a live holder's freshly published lock; a claim left by a dead recovering process is superseded automatically. **Cancellation while waiting:** the wait for a run lock does not observe the cancellation signal. A cancelled `bootstrap_generate` queued behind another launch of the same key keeps waiting (up to 15 minutes), and cancels as soon as it gets the lock, before creating any file, reservation or tab. Cancellation during the launch itself is handled as described above. Writes are atomic but not fsynced: power loss can lose the most recent update.

## Tests

Runtime assumptions: Node 26+ (runs `.ts` directly), a POSIX `/bin/sh`, process spawning allowed for the test run, and, for the runtime suite only, the installed `pi` CLI (tested with 1.5.x) and `coms.ts` beside `bootstrap.ts` (or `PI_BOOTSTRAP_TEST_COMS_EXTENSION`). Run from the `extensions/` directory.

| Suite | Command | What it covers |
| --- | --- | --- |
| deterministic | `node bootstrap/run-tests.ts deterministic` | Service, worker-hook, storage, reporting and harness tests on real temp files with a fake Herdr CLI and a harmless Pi stand-in. No real Pi, provider or Herdr. |
| runtime | `node bootstrap/run-tests.ts runtime` | The installed Pi (+ Coms) in RPC/print mode: extension loading, worker readiness, handoff admission and an end-to-end deterministic run against a local fake provider. No Herdr tab creation. |
| live | `PI_BOOTSTRAP_LIVE_HERDR=1 node bootstrap/run-tests.ts live` | Explicit opt-in, inside a Herdr pane: read-only checks against the real Herdr CLI. Never part of `all`; without the opt-in it reports `UNVERIFIED` and does nothing. |
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
