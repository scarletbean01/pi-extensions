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

> **Factory names work everywhere a `<factory-id>` does.** Every `/factory` subcommand that takes a factory, and the read-only `factory_inspect` tool, accepts either the UUID `factory_id` or the exact, case-sensitive factory name (for example `/factory resume fusion-mixed-smoke`). The token is resolved once at the command/tool boundary to the canonical UUID; an existing id always wins over a name; unknown, ambiguous, or UUID-looking-but-name-matching tokens are refused (the error lists the available names). Confirmation prompts of mutating commands show both the name and the resolved UUID, and the confirmation binds to the UUID, so a rename or name swap cannot redirect it. Tab completion offers names and ids.

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
- **Outcomes, stdout parsing, restarts, and fail-closed cancellation:** exit status `0` that also satisfies any `output_contract`, artifact hash, and `required_checks` rules is `succeeded`. If stdout parses as a JSON object with an object `outputs` field (or `status` + `summary`), it is read as a structured result envelope (mapping JSON `status: "partial"` to `"failure"`); any other JSON object becomes `result.outputs`. Non-zero exits, spawn failures, signals, timeouts, termination failures, or contract failures record `failed` (blocking downstream dependants) with the real `command_evidence` (`exit_code`, `signal`, `duration_ms`, optional `termination_error`, and stdout/stderr byte counts/excerpts — no synthetic signals are fabricated). The runner persists its child `pgid` + `start_time` immediately after `spawn` and handles `SIGTERM`, `SIGINT`, and `SIGHUP`; cancellation (whether live, after runner `SIGKILL`, or via `force_close` where permitted) and `bootstrap_cleanup` (full, subset, and automatic cleanup) kill the process group and verify it dead before recording `cancelled`/`cleaned` or releasing `write_paths` ownership. During cancellation, restart, or cleanup, damaged cancel/pgid records, unconfirmed kills, or restarts after claiming a handoff or spawning a command (`.pgid.json`) record `needs_attention` (and `cleanup-incomplete` on cleanup) and keep ownership held (whereas a restarted root command node with no prior result, disposition, or `.pgid.json` starts normally). By contrast, on a timeout or a normal exit where killing a leftover process group cannot be confirmed, the runner records `failure` (`failed`) with `termination_error` and releases `write_paths` ownership while a grandchild may still run.

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
   - **Compact queue view:** `/factory queue <factory> [--open|--all] [--json]` (or `factory_inspect` `action: "queue"` with optional `open: true`) prints one line per submitted input, oldest first: position, reference, disposition, latest attempt state (with a `+N prior` marker for retried inputs), run outcome when known, short task id, accepted_at and a ~60-character single-line brief (cut by Unicode code points with control and bidi/format characters stripped), then the head's blocker and capacity. It is read-only, reuses `inspect`'s evidence, and shows uncertain evidence in a header line instead of hiding rows (uncertain finished rows remain visible under `--open`). `--json` and `factory_inspect` `action: "queue"` return a stable JSON shape where optional fields are always present (`null` when absent): `{ factory: { factory_id, name, current_version, management, stopped, control_error, current_error }, filter, total_inputs, shown_inputs, uncertainty, inputs: [{ queue_position, input_id, reference, disposition, bound_version, is_head, attempt_count, earlier_attempts, attempt_state, run_outcome, task_id, short_task_id, accepted_at, brief_preview, uncertainty }], head_status: { eligible, input_id, reference, blocking_kind, reason, without_control_fence }, capacity: { queue_used, queue_limit, factory_slot, checkout_slot, blocking_hold } }`. Use it instead of scanning `inspect`.
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
  - `/factory requests <factory-id>` lists every request with its durable state (`pending`, `resolved`, `cancelled`, `closed`), `response_recorded`, `consumption`, `verdict`, `admissions`, `risk_lane` (derived lane, deciding paths, and approval requirement when `.pi/bootstrap.json` `"lanes"` are active), `revision` capacity, `can_respond`, `can_redeliver`, and `reconciliation`.
  - `/factory inspect <factory-id>` includes `requests` and keeps pending/uncertain ones in `attention` until resolved; when `.pi/bootstrap.json` configures `lanes.closed`, `definition.warnings` flags any decision node whose loop body could touch closed paths without an `intervention` `route: "approve"` choice.
- **Answering a request:**
  - `/factory respond <factory-id> <request-id>` (interactive managing session only; agents have no tool to answer). Shows any derived `Risk lane` summary alongside question, reason, evidence, and revision capacity.
  - Select one presented choice (optionally with guidance) or explicitly decline (not approval; free text alone is never accepted as a response).
  - Routing choices (`route: "approve"` or `"reject"`) bind only that decision attempt; the agent still passes all output contracts, artifact checks, and `required_checks` before routing.
  - At zero revision capacity, a rejection choice remains selectable with a warning; completion records the blocking limit (`loop_limit` or `run_budget`), applies `on_exhausted`, and raises an exhaustion request (`retry` with a new multiline brief, `takeover` manually, or `discard` the escalation).
- **Risk lanes (optional `.pi/bootstrap.json` `"lanes"` block):**
  - Configure `{ "lanes": { "contained": ["..."], "closed": ["..."] } }` in `<project>/.pi/bootstrap.json` (never in global `bootstrap.json`; omitted or empty keeps lanes off with unchanged behavior, and malformed lane settings, empty path segments, empty brace alternatives like `{,src}/x`, brace expansions over 64, or globs targeting excluded snapshot dirs `.git`, `node_modules`, `.pi/agent-sessions` — including conservative wildcard hits like `.p?/agent-sessions/**`, `.pi/*-sessions/**`, `.pi/agent-sessions*`, `.gi?/**` — fail planning/publication). Globs are anchored at project root (e.g. `.env*` is top-level only; use `**/.env*` for any depth).
  - Published factory versions do **not** pin `.pi/bootstrap.json` `"lanes"`; each queued input launch reads live `.pi/bootstrap.json` `"lanes"` at launch time and freezes them into that run's `manifest.json` (`LANE_VERSION = 8`) so mid-run `.pi/bootstrap.json` edits cannot lower an in-flight attempt's lane.
  - Derived deterministically per decision attempt from cumulative loop-body repository snapshots (`<reviewer>.1.lane-before.json` vs `<reviewer>.<n>.lane-after.json`): most restrictive lane wins (`contained` < `wide` < `closed`), unmatched paths fall into `wide`, and missing, truncated (> 5000 files or > 64 MiB), corrupt, digest-mismatched, or symlink-escaping snapshots fail closed as **`closed`** when `lanes.closed` is non-empty (or `wide` otherwise) and report the unknown scope. While the reviewer refuses an existing `<reviewer>.<n>.lane-after.json` that does not match its live snapshot, in the shared OS/checkout environment while Ticket 16 isolation is frozen, an agent with write access inside `.pi/agent-sessions/<task>/` could still forge `<reviewer>.1.lane-before.json` with a recomputed `snapshot_sha256` matching the modified working tree, or pre-plant `<reviewer>.<n>.lane-after.json` with a valid digest, and yield `contained`.
  - Approval rules: `contained` requires reviewer approval; `wide` additionally requires all declared `required_checks` across the loop body to be passing and current; `closed` requires a recorded human `route: "approve"` choice for that attempt even when the reviewer approves and all checks pass (and human approval still cannot bypass contracts, checks, or artifact hashes). A `closed`-lane decision node without human approval intervention durably settles `blocked` naming `closed` and the deciding path(s) rather than falling back to `wide`.
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
- **Uncertain launch (`proven_not_released` vs uncertain):** inspect `/factory inspect <factory-id>` first. When a launch fails before release in the current session with `abort.json` written, `release.json` absent, intact run/index/request/hold evidence, and every node that acknowledged readiness verified exited (release is impossible because the durable fence is closed), the current session records `proven_not_released` automatically (or on `/factory settle <factory-id>` / the factory watcher once remaining ready nodes exit). Only when `retry_eligibility.eligible` is `true` (affirmative `proven_not_released` evidence) may you run `/factory retry <factory-id> <input-id> <previous-attempt-id>` to create a new attempt/request ID under the same input, bound version, and FIFO position. If the prior launcher crashed or was killed mid-launch, exit the dead session and run `/factory takeover <factory-id>`. Once a later retry of that input reaches `settled` or `cleared` with `release_authorized = 1`, the prior `proven_not_released` attempt remains `historical: true` with `retry_eligibility.eligible: false` while its `coord.managed_runs` row is retired in the same settlement/clearance commit. Inspection treats any unretired, verified terminally superseded `coord.managed_runs` row as non-blocking, the release gate accepts verified superseded extra rows on non-retry launches (including cross-root), and `/factory takeover` (or `/factory settle` when nothing holds capacity) idempotently retires leftover rows from earlier builds as long as full non-release evidence remains intact.

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

---

## 8. Learned constraints at launch (`.pi/constraints.json`)

When `<project_cwd>/.pi/constraints.json` exists, each factory launch reads and validates it once at launch without modifying or rebinding any published factory definition version:

- **Missing file = no behavior change:** If `.pi/constraints.json` does not exist, factory runs behave identically to prior releases (manifest versions 2–8). Standalone `bootstrap_generate` runs ignore `.pi/constraints.json` unless they explicitly pass `use_learned_constraints: true`.
- **Schema, active filtering, and prompt safety:** `.pi/constraints.json` (`version: 1`; leading UTF-8 BOM is stripped cleanly) holds `constraints` entries (`<= 64` total, `<= 32` active), each with unique `id`, `text` (`<= 512` UTF-8 bytes, single-line, no control characters, Unicode zero-width/format characters `\p{Cf}` — including ZWJ emoji sequences, ZWNJ in Persian/Indic scripts, and soft hyphens — bidi overrides, or prompt-structure injection markers), `provenance` (`note` or `run_id` + `attempt_id` + `evidence_ref`), and `status` (`"active"` or `"retired"`). Retired entries are validated but excluded from the brief.
- **Whole-run brief injection & fail-closed head blocking:** Active constraints are appended into the existing run-level `Constraints:` section of the shared brief (`<= 2048` UTF-8 bytes combined with plan `constraints`, `<= 768` bytes per entry; never injected into per-node `node_constraints`). Nothing is truncated or dropped silently: overflow, unreadable files, symlinks, or invalid entries fail closed and block the FIFO head (`head_status.eligible: false` with a reason naming the overflow or defect), and `/factory restore` also validates against live `.pi/constraints.json` and fails if `.pi/constraints.json` is invalid or overflows.
- **Launch-time snapshot & traceability:** The canonical SHA-256 `digest` (computed over the canonicalized validated `{ version, constraints }` JSON structure rather than raw file bytes, so formatting whitespace and object key order do not change it) and `used_ids` are frozen into the version 9 (`CONSTRAINTS_VERSION = 9`) run manifest, worker configurations, and immutable task inputs, and displayed in `bootstrap_status`, `bootstrap_report`, and `/factory inspect` (`attempt.run.learned_constraints`). Mid-run edits to `.pi/constraints.json` do not change in-flight runs, revisions, recoveries, or takeovers; missing or digest-mismatched `learned_constraints` on a v9 manifest fails closed on recovery and inspection.
- **Shared-checkout boundary (Ticket 16 frozen):** Edits made by loop agents to `.pi/constraints.json` during a run are ignored by the running/recovered run, but pre-launch file contents are read at the next launch (and until Ticket 16 isolation, same-user processes with write access to `.pi/agent-sessions/<task>/` could modify both `manifest.json` and its digest).

### Proposing, confirming, and retiring constraints

- **Agent proposal (`factory_propose_constraint`):** Only after a **finished** factory-managed run (`status.outcome.terminal === true`) that required **at least one loop revision or a human-responded direction intervention** (opening and closing an unanswered request does not qualify) may the manager propose adding or retiring a constraint with verifiable provenance (`run_id`, `attempt_id`, and `evidence_ref` resolving to a real `result:`, `attempt:`, `request:`, or `artifact:` record of that run) and optional `conflicting_ids` or `reference`. First-pass runs, in-flight runs, and Bootstrap worker sessions are rejected. Verified eligibility (`eligibility_json`) is stored with `record_digest` protection so subsequent automatic cleanup does not strand pending proposals. Agents can never confirm, retire, resolve conflicts, or write `.pi/constraints.json`.
- **Deterministic deduplication:** Each proposal's text is normalized deterministically (`NFC`, trimmed, whitespace-collapsed, lowercased) against active constraints in `.pi/constraints.json` and pending proposals; exact duplicates are recorded as `dropped_duplicate` and never enter human review.
- **Surfacing and read-only views:** Pending proposals appear in `factory_inspect` (`proposals` and `attention`), `bootstrap_status`, `bootstrap_report`, live alerts/footer, `/factory requests <factory-id>`, and `/factory proposals <factory-id>` without mutating anything.
- **Human-only confirmation, rejection, retirement, and conflict resolution:**
  - `/factory review-proposal <factory-id> <proposal-id>` displays the proposal, provenance, note/reason, and named conflicts highlighted next to the full active constraints list, requiring interactive confirmation bound to `(proposal_id, normalized_text_digest, factory_id, canonical_checkout, action, constraints_file_digest)` before durably writing `.pi/constraints.json` (preserving file permissions, temp file + `fsync` + pre-rename digest check + `rename` + dir `fsync`, refusing symlinks; a residual concurrent-edit race window remains from the pre-rename digest check through completion of `rename(2)`), or records an explicit rejection with optional reason.
  - `/factory retire-constraint <factory-id> <constraint-id>` lets a human confirm retiring an active constraint with a required non-empty reason (`status: "retired"`, keeping original provenance intact and recording `retirement: { retired_at, retired_by, action_ref, reason }` inside `.pi/constraints.json`).
  - `/factory resolve-conflict <factory-id> <proposal-id>` clears a `conflict` sync state interactively (targeting `file_sync_state: "conflict"` only) by showing the diff between current `.pi/constraints.json` and the intended entry so a human can either **re-confirm** against the current file or **abandon** the conflicted confirmation without modifying `.pi/constraints.json`, preserving original `decided_at`/`decided_by` while recording `resolved_at`/`resolved_by`. Note: if `.pi/constraints.json` was restored back to its pre-conflict `expected_before_digest` or already contains the exact intended entry (`expected_after_digest` / `hasExactCommittedEntry`), `/factory takeover` or `/factory resume` automatically completes/marks `synced` without re-prompting because it is the exact change the human already confirmed.
  - Both re-check validation limits and `.pi/constraints.json`'s canonical digest (ETag) at commit time, refusing concurrent edits rather than overwriting them. Confirmed two-phase SQLite intent (`pending_write` → `synced`) recovers automatically on `/factory takeover` or `/factory resume` without duplicating or dropping confirmed writes, and factories at schema v12 (`factory_constraint_proposals`) block new launches while any confirmed constraint write is `pending_write` or `conflict`.
