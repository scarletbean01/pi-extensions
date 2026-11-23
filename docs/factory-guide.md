# Software Factory Operating Guide

This guide walks an operator through first use, definition publication, brief submission, blocked-queue diagnosis, human direction (intervention), stop/resume, takeover, recovery, settlement, clearance, and per-node attempt/rollback reporting.

For detailed design guarantees per slice, see:
- [Publication & inspection](factory-publication.md)
- [Submission, receipts & RawBriefEditor](factory-submission.md)
- [Launch, coordination & release gate](factory-launch.md)
- [Versions & read-only reporting](factory-versions.md)
- [Management takeover & launch retry](factory-takeover.md)
- [Cancellation, settlement, clearance & redelivery](factory-settlement.md)
- [Queue, stop & discard controls](factory-controls.md)
- [Human direction requests & exhaustion escalations](factory-direction.md)

## Important boundaries (read before operating)

- **Standalone runs and manual edits are NOT coordinated.** Factory checkout holds (`factory-coordination.sqlite`) serialize factory-managed launches across factories and state roots targeting the same canonical checkout and physical `(dev, ino)` identity. Ordinary standalone `bootstrap_generate` runs, manual shell commands, and editor saves in that checkout do **not** acquire or respect factory capacity holds.
- **Cleanup is NOT proof that external effects stopped.** Closing tabs/panes (`bootstrap_cleanup`, `force_close`, or automatic cleanup) only closes Herdr resources (`resource_closure`). It does not settle a run, undo side effects, or prove that detached or external processes stopped.
- **Uncertain execution is NEVER replayed.** If a launch or worker execution may have started and has no reliable settlement, the factory keeps both capacity holds in place, refuses automatic retry, and requires operator investigation and explicit clearance (or a fresh submission after clearance).

---

## 1. First use and prerequisites

A software factory is managed from an interactive Pi session inside Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`) with a trusted project (`ctx.isProjectTrusted()` and `~/.pi/agent/trust.json`).

- **Opening or inspecting a factory is read-only.** Starting Pi, running `/factory list`, `/factory inspect <factory-id>`, `/factory receipt <factory-id> <reference>`, or calling the `factory_inspect` tool never resumes management, mutates state, or launches a run.
- **Worker sessions are fenced.** Factory mutating commands (`/factory publish`, `update`, `restore`, `resume`, `takeover`, `stop`, `discard`, `submit`, `launch`, `retry`, `cancel`, `settle`, `clear`, `redeliver`, `respond`, `wake`) refuse to run inside Bootstrap worker sessions (`--bootstrap-worker-config`).
- **Agent tools cannot consent or mutate.** The model-facing `factory_inspect` tool only supports `action: "list" | "inspect" | "receipt"`. Human confirmations (`publish`, `update`, `restore`, `takeover`, `stop`, `discard`, `retry`, `cancel`, `clear`, `respond`) require direct interactive UI confirmation bound to the exact target.

---

## 2. Publishing and evolving definitions

### Create a factory (`v1`)

```text
/factory publish
```

Opens an editor for JSON `{ "name": "<unique-name>", "draft": { ...bootstrap_generate fields... } }`, validates the executable plan (graph topology, dependencies, contracts, checks, decision loops, limits, and `intervention` policies) without launching, and asks for explicit confirmation.

- Publication creates immutable version `v1` under a stable UUID `factory_id` without creating a run or resuming management.
- Resolved persona prompts, models, thinking levels, limits, and declared tool/skill/extension policies (and for `kind: "command"` nodes, their command, `args`, and canonical `working_directory`) are frozen into the version. Inherited tools/skills/extensions, installed extension/skill contents, the Pi runtime, provider credentials, and checkout contents remain live runtime inputs (`runtime_assumptions.not_frozen`).

### Node kinds: `agent` (default) and deterministic `command` nodes

A draft's `agents` entries default to `kind: "agent"`. A node can instead declare `kind: "command"` to run a deterministic local executable directly without starting a Pi model session:

- **Command specification:** declare required `node_id`, required `command` (executable name or path), optional `args` (string array passed verbatim as `argv` with `shell: false` — never concatenated into a shell string), and optional `working_directory` (must resolve as an existing directory inside `project_cwd`, defaulting to `project_cwd`).
- **Runner Node requirement (`BOOTSTRAP_NODE`):** command nodes are supervised by `bootstrap/command-runner.ts` under a Node 26+ binary supporting `--experimental-strip-types`. Planning, readiness checks (`head_status`), and launch resolve `BOOTSTRAP_NODE` first if set (an absolute path or executable name on `PATH`, failing closed if invalid), otherwise `process.execPath` only when it is a verified Node binary, and otherwise `node`/`nodejs` on `PATH` — failing closed before creating tabs or reserving attempts if no usable Node binary is available.
- **Rejected cross-kind settings:** planning and draft publication reject `command` nodes that declare agent-only settings (`persona`, `name`, `model`, `thinking`, `skills`, `allowed_skills`, `tools`, `extensions`, `intervention`, `decision`), and reject `agent` nodes that declare command-only settings (`command`, `args`, `working_directory`). Decision nodes stay agent-only.
- **Graph, contract, and ownership participation:** command nodes participate in `depends_on`, fan-out, joins (`join_policy`), per-edge `dependency_policy`, durable handoff offers/claims, `write_paths`/`read_paths` ownership serialization, `output_contract`, and `required_checks`. They never start a model and run with a minimal environment allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `LC_*`, `XDG_*`, with `PWD` set to the resolved `working_directory`) plus `BOOTSTRAP_*` pointers (`BOOTSTRAP_TASK_INPUT_PATH`, `BOOTSTRAP_UPSTREAM_INDEX_PATH`, `BOOTSTRAP_PREDECESSOR_PATHS`, and identity/cwd variables) so parent API keys and credentials are not inherited.
- **Outcomes, stdout parsing, restarts, and fail-closed cancellation:** exit status `0` that also satisfies any `output_contract`, artifact hash, and `required_checks` rules is `succeeded`. If stdout parses as a JSON object with an object `outputs` field (or `status` + `summary`), it is read as a structured result envelope (mapping JSON `status: "partial"` to `"failure"`); any other JSON object becomes `result.outputs`. Non-zero exits, spawn failures, signals, timeouts, termination failures, or contract failures record `failed` (blocking downstream dependants) with the real `command_evidence` (`exit_code`, `signal`, `duration_ms`, optional `termination_error`, and stdout/stderr byte counts/excerpts — no synthetic signals are fabricated). The runner persists its child `pgid` + `start_time` immediately after `spawn` and handles `SIGTERM`, `SIGINT`, and `SIGHUP`; cancellation (whether live, after runner `SIGKILL`, or via `force_close` where permitted) kills the process group and verifies it dead before recording `cancelled` or releasing `write_paths` ownership. Damaged cancel/pgid records, unconfirmed kills, or restarts after claiming a handoff or spawning a command (`.pgid.json`) record `needs_attention` and keep ownership held (whereas a restarted root command node with no prior result, disposition, or `.pgid.json` starts normally).

### Inspect, update, and restore versions

- `/factory list` — list published factories with `factory_id`, `name`, `current_version`, and `management`.
- `/factory inspect <factory-id> [version]` — inspect the current version (or a specific retained version like `v1`), `node_policies`, `bound_policies`, `queue`, `attempts`, `capacity`, `head_status`, `requests`, `attention`, and `uncertainty`.
- `/factory update <factory-id>` — edit `{ "draft": { ... } }` and publish `v(N+1)` after confirmation (for a managed factory, only its live managing session may publish).
- `/factory restore <factory-id> <version>` — re-validate preserved `<version>` against live prerequisites and `bootstrap.json` ceilings and republish it unchanged as `v(N+1)`.
- Updating or restoring never rewrites or rebinds already-queued or running inputs, and never resumes a stopped or unmanaged factory.

---

## 3. Resuming management, submitting briefs, and queuing

### Resume management

```text
/factory resume <factory-id>
```

Establishes exclusive local management authority for the active Pi session incarnation (and clears any durable stop fence in the same transaction). Once resumed, the managing session displays a live status footer (`factory-<factory-id>`) and runs a periodic watcher (~3s) that inspects state, settles reliably finished runs, and launches the eligible FIFO head.

### Submit a plain-text brief

```text
/factory submit <factory-id> [reference]
```

1. Displays a stable `reference` (`sub-<uuid>` if omitted) **before** opening the editor and before committing.
2. Opens a raw plain-text editor (`RawBriefEditor` in TUI mode, `ctx.ui.editor` in RPC mode) that preserves multiline text, CRLF/CR/LF endings, tabs, leading/trailing whitespace, and control characters verbatim. File or issue references in the brief stay literal text.
3. Validates limits: **16 KiB UTF-8 (16,384 bytes)** per brief and **32 queued inputs** per factory (`queued`, `blocked`, `retryable`).
4. Commits an immutable receipt binding `input_id`, `reference`, `queue_position`, `brief`, and the `current_version` at the commit instant.
   - **Identical retry:** reusing the same `reference` with the exact same brief returns the original receipt and current disposition without consuming queue capacity or rebinding.
   - **Conflicting retry:** reusing the same `reference` with a different brief is rejected.
   - **Intentional repetition:** use a new `reference`.
   - **Recover a receipt read-only:** `/factory receipt <factory-id> <reference>` or `factory_inspect` with `action: "receipt"`.

### Launch the FIFO head manually (or let the watcher advance)

```text
/factory launch <factory-id>
```

Launches the oldest eligible input at the head of the factory's FIFO queue into the managing pane's Herdr workspace (`HERDR_ENV=1`, `HERDR_PANE_ID`, never the focused workspace). When management is active (`/factory resume` or `/factory takeover`), the periodic watcher automatically settles finished runs and calls the same fenced launch path for the eligible head.

### Discard an unstarted input

```text
/factory discard <factory-id> <input-id>
```

Available only before launch reservation begins. Confirms the exact `input_id`, `reference`, waiting position (or permanent acceptance ordinal), `bound_version`, and consequences, then revalidates authority and disposition under the write transaction. Discarded receipts are retained permanently so a retry cannot revive them.

---

## 4. Understanding a blocked queue head and drilling down

Use the live footer for at-a-glance state, and drill down through authoritative records:

1. **Live summary footer** (`factory-<factory-id>`): shows `<name>: <management> <version> · queue <N> · head <ref>@<ver> <state> · run <task_id>@<ver> · <N> rollbacks · <K> attention` and triggers warning/error alerts for new requests, failed runs, uncertain evidence, and blocked heads.
2. **Factory & queue view:** `/factory inspect <factory-id>` (or `factory_inspect` `action: "inspect"`).
   - `head_status.blocking_kind` distinguishes why the FIFO head cannot launch (FIFO order is never skipped):
     - `empty`: no waiting input in the queue.
     - `unmanaged`: factory has no active manager (`/factory resume <factory-id>` or `/factory takeover <factory-id>`).
     - `stopped`: durable stop fence is active (`/factory resume <factory-id>` clears it; `head_status.without_control_fence` shows underlying eligibility).
     - `factory_held`: this factory's own slot is held by an active or unsettled attempt (`capacity.blocking_hold`).
     - `checkout_held`: another local factory (including via a symlink alias or separate state root) holds the same canonical checkout / physical `(dev, ino)` identity.
     - `preflight` / `compatibility` / `ceiling`: live prerequisites (`project_cwd`, writable sessions, `coms_extension`, `pi`/`herdr`, `required_artifact_paths`, `graph.ceilings` in `bootstrap.json`) failed for the head's bound version.
     - `uncertain`: missing, corrupt, or contradictory storage/release/index evidence blocks launching safely.
3. **Receipt lookup:** `/factory receipt <factory-id> <reference>` (shows bound version, current disposition, latest attempt, `settlement`, and `node_counts`).
4. **Run & graph status:** `bootstrap_status({ task_id })`, `/boot <task-id>`, `/bootgraph <task-id>`, and read-only `bootstrap_report({ task_id })` (note: passing `results` or `write_markdown` to `bootstrap_report` is refused for factory-managed runs).
5. **Handoff recovery evidence:** `bootstrap_recover({ task_id, action: "inspect" })` (read-only) and `/factory redeliver <factory-id> <successor-node> [source-node]` (resends only a demonstrably unclaimed handoff under managing authority).

---

## 5. Resolving interventions (human direction requests)

Definition nodes opted in via `intervention: { choices, required?, require_route? }` receive `bootstrap_request_direction` when factory-managed.

- **Discovering requests (even after a missed alert):**
  - `/factory requests <factory-id>` lists every request with its durable state (`pending`, `resolved`, `cancelled`, `closed`), `response_recorded`, `consumption`, `verdict`, `admissions`, `revision` capacity, `can_respond`, `can_redeliver`, and `reconciliation`.
  - `/factory inspect <factory-id>` includes `requests` and keeps pending/uncertain ones in `attention` until resolved.
- **Answering a request:**
  - `/factory respond <factory-id> <request-id>` (interactive managing session only; agents have no tool to answer).
  - Select one presented choice (optionally with guidance) or explicitly decline (not approval; free text alone is never accepted as a response).
  - Routing choices (`route: "approve"` or `"reject"`) bind only that decision attempt; the agent still passes all output contracts, artifact checks, and `required_checks` before routing.
  - At zero revision capacity, a rejection choice remains selectable with a warning; completion records the blocking limit (`loop_limit` or `run_budget`), applies `on_exhausted`, and raises an exhaustion request (`retry` with a new multiline brief, `takeover` manually, or `discard` the escalation).
- **Waking an unconsumed response:** if a response is recorded (`response_recorded: true`, `consumption: "awaiting_consumption"`, `can_redeliver: true`), `/factory wake <factory-id> <request-id>` resends only the wake-up to the verified waiting invocation.

---

## 6. Stop, takeover, launch retry, cancellation, settlement, and clearance

### Stop and resume

- `/factory stop <factory-id>` (interactive confirmation): durably rejects new `/factory submit` admissions and new FIFO launch reservations without cancelling running work, closing tabs, or disabling `/factory cancel`, `settle`, `clear`, or `respond`.
- `/factory resume <factory-id>`: re-establishes management and clears the stop fence atomically.

### Manager takeover

```text
/factory takeover <factory-id>
```

Shows the recorded manager incarnation ID (`uuid|boot_id|pid|start_ticks`) and confirms takeover. Refuses if `/proc/<pid>/stat` on the same host boot shows the prior manager process is still alive. On success, atomically replaces the manager record and fences stale managers without cancelling runs or releasing holds:

- **Actionable requests:** pending requests whose original worker invocation is verified alive remain actionable under their original `request_id` (no replay or duplicate worker).
- **Uncertain launch (`proven_not_released` vs uncertain):** inspect `/factory inspect <factory-id>` first. Only when `retry_eligibility.eligible` is `true` (affirmative `proven_not_released` evidence) may you run `/factory retry <factory-id> <input-id> <previous-attempt-id>` to create a new attempt/request ID under the same input, bound version, and FIFO position.

### Cancel, settle, and clear uncertain holds

- `/factory cancel <factory-id>`: confirms the exact active target (`input_id`, `attempt_id`, `task_id`, `bound_version`) and writes durable cancellation intent (`cancel.json`). Does **not** close tabs, prove settlement, or release holds.
- `/factory settle <factory-id>` (also run automatically by the watcher): releases both holds only when fresh observation inside the transaction proves every node is terminal with readable evidence and nothing is cancelling, parked, working, pending, in error, holding write ownership, or suspected detached. Works even while tabs remain open.
- `/factory clear <factory-id>`: when settlement is impossible due to missing/contradictory evidence (e.g., worker killed without recording an outcome) and **no** positive `resume_risk` exists (`alive` worker process, recent `working` heartbeat without exit, `cancelling`, `parked`, active `ownership_status`, or `detached_without_outcome`), confirms the exact target and collects human `reason`, supporting `evidence` that original work cannot resume, and `acknowledged_unknown_effects`. Retires the input (`cleared`) and releases both holds without settling the run, undoing effects, or replaying work. Repeating the work requires a new `/factory submit`.

---

## 7. Per-node attempt and rollback counts (report-only)

Factory views (`inspect` / `receipt` `attempt.node_counts`, and the live footer rollback count) and `bootstrap_report` (`node_counts` and report text/markdown) display per-node `attempts` and `rollbacks` (`Math.max(0, attempts - 1)`) derived on demand from `upstream-index.json`.

- **No new persisted state:** counts are computed strictly from existing `upstream-index.json` records at read time.
- **Strictly report-only:** counts never influence admission, decision routing, revision capacity, settlement, launch, or clearance.
- **Unavailable counts are a notice, not a hold.** For released v2+ factory-managed runs with retained session files, a missing or unusable `upstream-index.json` is reported in `bootstrap_report` (`issues`), receipt (`node_counts_error`), and inspect (`node_counts_error` and a `report_notice` attention item). Counts are omitted, never shown as zero. A counts notice cannot block settlement, launch or retry, and does not change the recorded execution outcome. Standalone reporting can still save results when counts are missing or unusable; in that case `report.json` contains `results` and `node_counts_error`.
