# Host contract

Bootstrap uses a **Host** to launch and manage each node's terminal. The
selected **Host backend** is `herdr` or `hc`; it is fixed for the life of a
run. This document records the interface and backend mapping specified in
[the host-backends spec](../.scratch/host-backends/spec.md). `bootstrap/host-herdr.ts`
implements the Herdr backend; `bootstrap/host-hc.ts` implements hc selection,
preflight, node launch, existence reporting, owned-node discovery, node closing,
and wake-up.

Host status is resource information only. Durable records and the worker
process decide execution and liveness; a Host never decides workflow state
([ADR 0003](../docs/adr/0003-handoff-offer-is-the-only-authority.md) and
[ADR 0004](../docs/adr/0004-nodes-launch-through-a-host-seam.md)).

## Operations

Each operation shows the command sequence and the meaning Bootstrap assigns to
its result. The `hc evidence` column tags hc facts with their source. Sources
are the installed `hc` command's help (`hc <command> --help`), `hc --skill`, or
`hc schema`; **not documented** means none of those sources specifies the
behavior.

| Operation | Herdr (current commands) | hc (contract commands) | Semantic result and hc evidence |
| --- | --- | --- | --- |
| **Preflight** | Require `HERDR_ENV=1`, `HERDR_PANE_ID`, and `herdr` on `PATH`; run `herdr pane get "$HERDR_PANE_ID"` and retain its `workspace_id`. | Check `hc` is on `PATH`; run `hc server status --json` and require a response with `core.id` and `version`. In an hc calling context, validate the terminal identity with `hc get --json "$HC_TERMINAL_ID"`. | Preflight failure names the selected backend and operation. **Verified by live run (hc 0.1.22):** `hc server status --json` returns nested `core.id`/`core.name` and top-level `version`, `pid`, etc. (run from the test runner process). **Documented-only / unverified:** `hc get --json "$HC_TERMINAL_ID"` from inside an `hc` terminal was not run in run 2 (Part 2 adds a terminal self-probe; source: `hc server status --help`, `hc get --help`, `hc schema` (`StatusResult`, `terminal.get`)). |
| **Launch** | Create a per-node launcher script, then run `herdr tab create --workspace "$workspace_id" --label "$label" --cwd "$directory" --no-focus --env PI_COMS_DIR=… --env PI_COMS_TIMEOUT_MS=300000`; submit it with `herdr pane run "$pane_id" <launcher-command>`. The created tab, pane, terminal and label form the Herdr handle. | Write the per-node launcher script unsetting inherited `HERDR_*` variables (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH`) and exporting `PI_COMS_DIR`, `PI_COMS_TIMEOUT_MS` (and `PI_COMS_MAX_HOPS` for agent nodes), then run `hc run --json --bg --name "$name" --cwd "$directory" --label bootstrap_run="$task_id" --label bootstrap_node="$instance_id" --no-parent --no-notify /bin/sh <launcher-script>`. Save the returned `address` with the chosen `name` in the hc handle (`workspace_id` in the manifest is `"hc"`). | Herdr's public tab/pane IDs can compact after a close; hc's returned address is stable on its core. **Verified by live run (hc 0.1.22)**: `hc run --json --bg` stdout is compact `{address, agent, cwd, name, state, turn}` (missing `labels`, `argv`, `created_ms`, `screen`, `cols`, `rows` from `RunResult`), and `HcHost.launchNode` requires only `address` (optional `name`). Compared with the supplied `isolation.env`, `hc` added only `COLORTERM=truecolor`, `HC_SCOPE`, `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, and `TERM_PROGRAM=ghostty` (identical key sets across all 7 `terminalEnvs`; `HC_RUNTIME=1` is in the daemon environ only, never in terminals), while `HC_SESSION`, `HC_SOCKET`, `SHELL`, `TERM`, `HOME`, `PATH`, `LANG`, and `XDG_*` were already in the supplied environment and passed through. Whether `hc` injects `HC_SESSION`/`HC_SOCKET` into terminals on a core where they were unset, and how nested `hc` calls resolve using only the unaltered terminal-provided env, remain **unverified** (the run-2 fixture's `hc send` rebuilt `HC_SESSION`/`HC_SOCKET` explicitly; Part 2 adds an unaltered-env terminal self-probe). `hc run` CLI help has no environment flag, so the launcher script exports the node environment before `exec` (**verified — source: `hc run --help`**). |
| **Report terminal existence** | Resolve the recorded pane/terminal from `herdr api snapshot` (or workspace and pane listings on older servers); `herdr pane get "$pane_id"` is also used for the wake-up check. | Discover run candidates with `hc ls --all --json --label bootstrap_run="$task_id"` and confirm each candidate (plus the saved `address` if absent from the listing) with `hc get --json "$address"`; its `state` is `live` or `finished`. | Report `present`, `gone`, or `ambiguous`: `finished` still means the hc terminal record exists, while `gone` means the exact saved resource is absent (`error.kind === "not_found"`, or exit code 3 with no other `error.kind`); conflicting label/identity matches or unrecorded label-only matches are `ambiguous`. Do not infer worker liveness from this result. **Verified by live run (hc 0.1.22)** for `hc ls --all --json --label ...` (`{hidden_finished, terminals:[compact]}`), `hc get --json` (full record with `labels`), and `not_found` exit code `3`; **source: `hc get --help`, `hc --skill`, `hc schema`.** |
| **Close a node** | Verify ownership, then run `herdr pane close "$pane_id"` if the owned pane moved or its tab contains other panes; otherwise run `herdr tab close "$tab_id"`. This preserves unrelated panes in a rearranged tab. | Discover/confirm the saved address and ownership labels (`bootstrap_run`, `bootstrap_node`) via `hc ls --all --json --label bootstrap_run="$task_id"` and `hc get --json "$address"` (never by name alone); refuse ambiguity without closing. If `live`, run `hc kill --json "$address"` followed by `hc rm --json "$address"`. If already `finished`, remove it directly with `hc rm --json "$address"`. If already gone (`not_found`), report `already_gone` (not an error); never treat `unavailable`/transient errors as gone. | Herdr closes a tab or pane. hc hangs up/escalates to end the program, then removes the finished terminal: resource closure means the terminal is both finished and removed. Herdr public IDs may compact; hc addresses remain stable. **Verified by live run (hc 0.1.22)**: `hc kill --json` transitions `live` to `finished`, `hc rm --json` removes `finished` terminals (`{"removed": address}`), and `hc kill --json` on an already-`finished` terminal succeeds with exit `0` returning the unchanged terminal record (`HcHost.closeNode` still skips `kill` when already `finished`). **Source: `hc kill --help`, `hc rm --help`, `hc schema`.** |
| **Send a wake-up** | Only after checking the destination process is alive, its durable offer is unclaimed and its pane exists (`herdr pane get`), run `herdr pane send-text "$pane_id" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`, then `herdr pane send-keys "$pane_id" Enter`. Preserve the pending marker if submission is uncertain. | After the same durable checks and `host.nodeExists`, run `hc send --json "$address" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`; never pass `--force` or `--if` / gate on the Host's status. On the destination side, accept the bare wake-up line or at most one `<hc from="…" [reach="…"]>…</hc>` wrapper stripped before matching (the offer on disk stays the only authority). | Return `sent`, `skipped` with a reason, or `failed` with a reason. Map `blocked` (exit code 9) to `skipped` (`blocked`); map `finished` (exit code 11) and `not_found` (exit code 3) to `skipped` because the program is no longer wakeable (`finished` remains a record; `not_found` has no record); map `unavailable` and other send errors to `failed` with the error reason. `hc send` presses Enter (`\r`) itself and waits for a person's unfinished draft to clear before sending. **Verified by live run (hc 0.1.22) for plain raw-mode programs:** `hc send` delivers the bare text + `\r` from the test runner process, an unrelated terminal, parent→child, and child→parent with NO `<hc from=… reach=…>` wrapper observed (`wrapped: false`, `reach: null`). Caveat: in run 2, the fixture sends (`unrelated`, `parent→child`, `child→parent`) ran with `HC_SCOPE` excluded and `reach: null`, so "no wrapper observed" is accurate for those runs but does not prove `hc` recognised the caller relationship. The `<hc from="…" [reach="…"]>` wrapper is documented (`hc --skill`: "Reports arrive tagged") for template-run agents/notes; **whether a real `pi` agent launched through `hc run … launcher` receives a wrapper is STILL UNVERIFIED** (destination keeps accepting bare line or one wrapper). **Booting-program send verified by live run (hc 0.1.22):** `hc send` exits 0 and writes to the PTY immediately; whether early input survives depends on the program's own startup handling (the fixture's 60 ms startup drain discarded it; in cooked mode CR arrives as LF; Redelivery covers it per ADR 0003). Documented rule (**source: `hc --skill`, `hc send --help`**): `blocked` means a person is needed and `hc send` refuses unless `--force` (Bootstrap never forces); **live `blocked`/`working`/`done` send behavior (question (h)) remains UNVERIFIED until Part 2 live run.** |
| **Discover a run's owned nodes** | Prefer `herdr api snapshot`; if unsupported, run `herdr workspace list`, then `herdr tab list --workspace "$workspace_id"` and `herdr pane list --workspace "$workspace_id"`. Match the run/node label and confirm the recorded terminal identity before treating a resource as owned. | Filter with `hc ls --all --json --label bootstrap_run="$task_id"`; for each candidate, run `hc get --json "$address"` and confirm both ownership labels and the saved address/terminal identity. Never decide ownership from the name alone. | The contract requires label filtering followed by per-terminal confirmation. **Verified by live run (hc 0.1.22):** compact human `hc ls` omits labels (`compactShowsLabel: false`), JSON `hc ls --all --json --label …` filters by label and returns `{hidden_finished, terminals:[compact]}` without labels, and `hc get --json <address>` returns the full terminal record including `labels`. **Source: `hc ls --help`, `hc schema`.** |

`hc send` waits for a person's draft; the caller must treat an hc refusal as
`skipped` only when the refusal identifies a blocked terminal. It must never
force a send. The handoff offer on disk remains the only authority, so a
skipped wake-up leaves the offer available for Redelivery. Return `skipped`
with a reason when the offer is already claimed, the destination process is no
longer alive, the terminal is gone, or hc refuses because the terminal is
blocked. Return `failed` with a reason for transport, command, or ambiguous
ownership errors.

## Backend selection and recovery

Choose the backend once, in this order:

1. An explicit `PI_BOOTSTRAP_HOST=herdr` or `PI_BOOTSTRAP_HOST=hc` wins. An
   invalid value is an error; do not silently select another backend.
2. Otherwise use a validated calling context: an hc terminal identity selects
   hc; a Herdr pane identity (`HERDR_ENV=1` and `HERDR_PANE_ID`) selects Herdr.
   Validate the identity with that Host. If both contexts are present, hc wins
   as a Bootstrap selection rule. The hc caller identity is represented by
   `HC_TERMINAL_ID`. **Verified — source: `hc schema` (`terminal.run` caller
   and `terminal.get`); Herdr context: current `bootstrap/lifecycle.ts`.**
3. With no Host context, select hc only when its binary is on `PATH` and
   `hc server status` answers. Otherwise fail clearly, naming both `hc`
   (herdr-core) and `herdr` as the available choices. **Verified — command
   syntax: source `hc server status --help`.**

Do not select hc from `HC_TERMINAL_ID` alone. A normal shell running the
dispatcher may have no hc terminal identity; the no-context rule must probe
the binary and core. A selected backend failing preflight is an error, not a
signal to switch backends.

Store the choice in the run manifest as `host_backend`. Recovery, cleanup and
redelivery use that recorded value, regardless of the recovery caller's
environment. If an older manifest has no `host_backend`, read it as `herdr`.

## Handles, fields and ownership

Keep existing Herdr manifest fields and their meanings, including `tab_id`,
`pane_id`, `terminal_id`, and the node label. Existing `bootstrap_cleanup`
selection by tab ID remains compatible; a Herdr tab ID can become stale after
another tab closes because Herdr compacts public IDs. Add an opaque per-launch
`host_ref` owned by the backend: for Herdr it mirrors the existing resource
fields; for hc it stores the terminal name and the address returned by
`hc run`. The hc name helps operators find a terminal, but ownership comes
from the recorded address plus matching labels, never the name.

Herdr currently labels each node as `<task_id>:<instance_id>` and checks the
stable terminal identity before closing. For hc, use labels
`bootstrap_run=<task_id>` and `bootstrap_node=<instance_id>`. Generate each hc
name deterministically from the run and node identities: lowercase and
sanitize to hc's documented name alphabet, include a digest of the original
identities to prevent collisions, and truncate to the 32-character limit.
The generated name does not include an attempt id; attempts of the same node
use the same name. If a re-launch encounters a still-live terminal with that
name, the intended behavior is to treat `name_taken` as a launch conflict.
Recovery may reconcile the terminal only when its saved `host_ref` address and
matching run/node labels confirm ownership; otherwise it fails closed for
operator cleanup. It must not adopt the terminal by name alone or invent a
second name. This collision handling is a Bootstrap rule, not an implemented
behavior. **Verified by live run (hc 0.1.22) — `name_taken` (exit 1) occurs
only while a live terminal holds the name; after `hc kill`, the name is
reusable immediately even before `hc rm` (as well as after `hc rm`), so two
terminals (one `finished`, one `live`) can share a name — confirming ownership
must come from `address` plus labels, never the name; source: `hc run --help`,
`hc schema` (`terminal.run`).** Nodes are separate terminals
independent of the dispatcher; `--no-parent` avoids
inheriting its parent relationship, so cleanup stays explicit, and
`--no-notify` prevents notes being typed into the parent. **Verified — source:
`hc run --help`.**

For hc discovery, filter by the run label, then confirm each candidate's
terminal identity and both labels through `hc get`. A label or name match
alone is never permission to close a terminal. **Verified by live run
(hc 0.1.22):** compact human `hc ls` omits labels (`compactShowsLabel: false`),
`hc ls --all --json` omits labels on compact terminal items, and `hc get --json`
includes `labels`; confirmation via `hc get` is required.

## Status vocabularies

These Host/application statuses are advisory and are separate from Bootstrap's
resource state (`planned`, `creating`, `tab_created`, `launch_submitted`,
`ready`, `released`, `closed`) and execution state.

| Source | Reported words | Meaning here |
| --- | --- | --- |
| Herdr agent-state extension | `working`, `blocked`, `idle` | Current extension publishes these states. It does not report completion as workflow state. **Source: `herdr-agent-state.ts`.** |
| hc OSC 7501 record | `idle`, `working`, `done`, `blocked`, `error` | The schema calls these the program's own words; null means no report or an exited program. Bootstrap must not translate them into execution outcomes. **Verified — source: `hc schema` (`Status`, `Terminal.status`).** |

The hc schema documents a 7501 record with `state` and optional `app`, `kind`,
`msg`, `progress`, and `title`. That payload shape and vocabulary are
**verified — source: `hc schema` (`Status`)**. Exact OSC byte framing and
escaping are **unverified — source: not documented**.

## hc verification notes

| Behavior | Evidence |
| --- | --- |
| `run`, `ls`, `get`, `kill`, `rm`, `label`, `send`, and `server status` command forms and listed options | **Verified by live run (hc 0.1.22)** for `server status`, `run --bg`, `ls --all --label`, `get`, `kill` (including no-op exit 0 on already-`finished`), `rm`, and `send` (non-blocked); `label` command **verified (documented) — source: `hc label --help`**. |
| A terminal address such as `t7` identifies that terminal on its core; returned `address` is the terminal reference; CLI stdout shape of `hc run --json --bg` | **Verified by live run (hc 0.1.22):** `hc run --json --bg` stdout is compact `{address, agent, cwd, name, state, turn}` (without `labels`, `argv`, `created_ms`, `screen`, `cols`, `rows` from `RunResult`); `HcHost.launchNode` only requires `address` (optional `name`). **Source: `hc schema` (`Terminal.address`, `RunResult`).** |
| `hc send` pastes and submits with Enter (`\r`), waits for a person's unfinished draft, and refuses blocked programs unless `--force` | Bare text + `\r` delivery **verified by live run (hc 0.1.22)** on plain raw-mode terminals; `blocked` means a person is needed and `hc send` refuses unless `--force` (**verified — source: `hc send --help`, `hc --skill`, `hc schema`**; live `blocked`/`working`/`done` send behavior (question (h)) **unverified until Part 2 live run**). Bootstrap never passes `--force`. |
| `hc send` note wrapper around submitted text | **Verified by live run (hc 0.1.22) for plain programs:** no `<hc from=… reach=…>` wrapper was added (`wrapped: false`, `reach: null`) from the test runner process, unrelated terminal, parent→child, or child→parent. Caveat: in run 2, the fixture sends ran with `HC_SCOPE` excluded and `reach: null`, so "no wrapper observed" is accurate for those runs, but does not prove `hc` recognised the caller relationship. The `<hc from="…" [reach="…"]>` wrapper is documented (`hc --skill`: "Reports arrive tagged") for template-run agents/notes; **whether a real `pi` agent launched through `hc run … launcher` receives a wrapper is STILL UNVERIFIED** (destination parser keeps accepting bare line or one wrapper). |
| Name reuse (`name_taken` while live; reusable immediately after `hc kill` before `hc rm`, and after `hc rm`) | **Verified by live run (hc 0.1.22).** |
| Status record fields and state words; exact OSC 7501 byte framing/escaping and `records` by id | Payload fields and words **verified — source: `hc schema` (`Status`)**. **Verified by live run 3 (`hc 0.1.22`, `bootstrap-hc-findings-FbreNh`):** capability queries `ESC]7501;?\x07` (`1b5d373530313b3f07`) and `ESC]7501;?\x1b\\` (`1b5d373530313b3f1b5c`) make `hc` write back `ESC]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth` with the matching terminator (`1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c6175746807` for BEL, `…1b5c` for ST; queries carrying `:states=…` got no reply), and `ESC]7501;state=working\x1b\\` (`1b5d373530313b73746174653d776f726b696e671b5c`) is accepted and shown in `hc get --json` (`reported: true`, `status: {"state":"working"}`) and `hc ls --all --json` (`"status":"working"`). In run 2, semicolon-delimited `;state=…` and JSON payloads were rejected (`status: null`, `reported: false`). Everything else about `(b)` — `idle`/`done`/`blocked`/`error`, extra keys (`app`, `msg`/`message`, `title`, `progress`, `kind`), escaping, BEL report framing, and `records` by `id` — remains **UNVERIFIED** (working Herdr-app/OpenCode plugins emit `OSC 7501 ; key=value[:key=value…] ST`, and `hc schema` / libghostty define `{state, kind, progress, id, app, title, message/msg}`). |
| Isolated-core test recipe and terminal environment inheritance | **Verified by live run (hc 0.1.22):** `hc server start --json` runs under systemd shims with `shimCalls: []` in caller cgroup, `HC_RUNTIME=1` appears only in daemon `/proc/<pid>/environ`, and compared with `isolation.env` `hc` added only `COLORTERM=truecolor`, `HC_SCOPE`, `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, and `TERM_PROGRAM=ghostty` (identical key sets across all 7 terminals), while `HC_SESSION`, `HC_SOCKET`, `SHELL`, `TERM`, `HOME`, `PATH`, `LANG`, and `XDG_*` were already in the supplied env and passed through. Whether `hc` injects `HC_SESSION`/`HC_SOCKET` when unset and how nested `hc` calls resolve with unaltered terminal env remain **unverified** (Part 2 adds an unaltered-env terminal self-probe). |
| Sending while the agent is still booting | **Verified by live run (hc 0.1.22):** `hc send` exits 0 (`{"started":null,"status":null,"turn":0}`) and writes to the PTY immediately; whether early input survives depends on the program's own startup handling (the fixture's 60 ms startup drain discarded it; in cooked mode CR arrives as LF); Redelivery covers it (ADR 0003). |
| Compact `hc ls` label display vs `hc ls --all --json --label` and `hc get --json` | **Verified by live run (hc 0.1.22):** compact human `hc ls` omits labels, `hc ls --all --json --label …` filters by label and returns compact records without labels, and `hc get --json` returns full records including `labels`. |

The remaining unverified items — `(b)` OSC 7501 byte framing/escaping/records-by-id, `(h)` live `blocked`/`working`/`done` `hc send` behavior, and whether a real `pi` agent launched through `hc run … launcher` receives an `<hc from=…>` wrapper — stay explicitly tagged unverified until settled by a live run.

## Live spike procedure

Run this only after the operator approves the live hc check. **Start the live
run from a terminal not hosted by `hc`** (if started from an `hc`-hosted
terminal, the cgroup guard fails closed so the isolated core cannot share or
escape into an `hc` cgroup). From the repository root on Linux, with Node 26+,
`hc`, and util-linux `script` on `PATH`, run:

```sh
env -u PI_BOOTSTRAP_LIVE_HERDR PI_BOOTSTRAP_LIVE_HC=1 \
  PI_BOOTSTRAP_HC_FINDINGS_DIR="$PWD/.scratch/host-backends" \
  timeout 620 node bootstrap/run-tests.ts live
```

To run only a subset of questions (for example `b` and `h`), pass
`PI_BOOTSTRAP_LIVE_HC_ONLY=b,h` (still gated on `PI_BOOTSTRAP_LIVE_HC=1`; unknown
question IDs fail closed; omitting it runs all questions `a–i`). Both full and
filtered runs enforce all isolation guards and teardown.

The suite creates a fresh private directory under `/tmp` (`bootstrap-hc-*`)
with its own `HC_SESSION`, explicit `HC_SOCKET`, HOME, temporary directory, and
XDG config, cache, data, state, and runtime directories. It takes only a
filtered `PATH` (directories needed for `hc`, `herdr-core`, `sh`, `script`, and
`node`, with the scratch `bin/` shim directory placed first) and locale
(`LANG`, `LC_ALL`) from the parent, and sets `SHELL=/bin/sh` and
`TERM=xterm-256color`. `DBUS_*`, `HERDR_*`, `HC_*`, `XDG_*`, and
`INVOCATION_ID` from the parent are never inherited.

**Systemd isolation:** On Linux, `hc server start` can delegate daemon startup
to the user's systemd manager (`systemd-run --user`, `systemctl`, `loginctl`,
`busctl`), which could touch the operator's systemd user manager or collide
with unit names. To prevent this, `<root>/bin` is placed first on `PATH` with
failing (exit 1) logging shims for `systemd-run`, `systemctl`, `loginctl`,
`busctl`, `sudo`, and `pkexec`, expected to fall back to a direct child; only
the live run will show whether it does (it fails safe either way: if `hc`
cannot start without `systemd-run`, the run aborts and reports it). After
`hc server start --json`, `readCoreStatus` verifies the socket path and inode,
reads the core ID and PID from `hc server status --json`, rejects any core
whose `/proc/<pid>/environ` contains `INVOCATION_ID` or does not match the
scratch settings (allowing only `HC_RUNTIME=1` as a daemon marker on the core,
and never `HC_TERMINAL_ID` or any other extra `HC_*`/`XDG_*`/`DBUS_*`/`HERDR_*`),
and requires the core's `/proc/<pid>/cgroup` paths to equal
the test process's own cgroup paths (failing closed with an actionable message
if either belongs to an `hc` or `herdr-core` unit, or if the core moved to any
different cgroup). Terminal operations and server stop require that same
verified identity. Both `/proc/<pid>/cgroup` and the shim call log
(`shim-calls.log`) are recorded in `isolation` findings. All addresses are
local.

**Recorded in prior live runs (`hc 0.1.22`):**
- `hc server start --json` succeeded under the systemd shims with `shimCalls: []`.
- `hc server status --json` and `hc server start --json` stdout both carry
  `core.id`/`core.name` nested under `core`, and top-level `version`, `pid`,
  `uptime_ms`, `live`, `finished`, `holder`, `holders`, `installed_by`,
  `keeps_running_after_logout`, and `logout_linger_user` (confirming ticket
  03's probe requirement of `core.id` and `version`).
- Run 2 verified answers `(a)` (plain raw-mode bare delivery + `\r`, with `HC_SCOPE` excluded on fixture sends), `(c)`
  (isolation recipe, `HC_RUNTIME=1` on daemon only, `hc` adding `COLORTERM=truecolor`, `HC_SCOPE`,
  `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, and `TERM_PROGRAM=ghostty` while passing through `HC_SESSION`,
  `HC_SOCKET`, `SHELL`, `TERM`, `HOME`, `PATH`, `LANG`, and `XDG_*`), `(d)` (`hc send` exits 0 and writes to
  the PTY immediately; survival depends on the program's own startup handling — the fixture's 60 ms startup
  drain discarded it, and in cooked mode CR arrives as LF), `(e)` (compact `run`/`ls` vs full `get` and
  label-less PTY `ls`), `(f)` (name reuse after `kill` before `rm`), `(g)` (status shape), and `(i)` (`kill`
  on `finished` exits 0 returning unchanged record). Questions `(b)` and `(h)` failed in run 2 because
  semicolon-delimited `;state=…` and JSON OSC 7501 payloads were not accepted (`status: null`, `reported: false`).
- Run 3 (`hc 0.1.22`, `bootstrap-hc-findings-FbreNh`) verified OSC 7501 capability-query replies (`1b5d373530313b3f07` -> `1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c6175746807`; `1b5d373530313b3f1b5c` -> `…1b5c`; `:states=…` suffix queries got no reply) and that `ESC]7501;state=working\x1b\\` (`1b5d373530313b73746174653d776f726b696e671b5c`) is accepted (`hc get --json` `reported: true`, `status: {"state":"working"}`; `hc ls --all --json` `"status":"working"`). Later multi-key reports (`app`, `msg`, `title`, `progress`, `kind`) left `status` unchanged at `working`, and `(b)` aborted before `(h)` ran. Everything else about `(b)` and `(h)` remains **UNVERIFIED**; run 4 isolates each probe on a fresh terminal, polls `200–1000` ms, adds extra keys one at a time, and only fails at the end after saving findings so `(h)` always runs.

**Observed by the operator/orchestrator during the first live run (not recorded in findings):**
- The daemon's parent was the init/user manager process, same cgroup as the
  caller, with `HC_RUNTIME=1` in `/proc/<pid>/environ` (the operator's own core
  shows the same).

**Resources created during the live run:**
- Scratch root `/tmp/bootstrap-hc-*` (removed after confirmed core and holder
  exit; retained on failure or unconfirmed stop for diagnosis), containing `bin/`,
  `home/`, `tmp/`, `config/`, `cache/`, `data/`, `state/`, `runtime/`,
  `shim-calls.log`, and fixture mailbox/capture files (`*.boot`, `*.ready`,
  `*.input`, `*.flushed`, `*.request`, `*.response`, `*.release`).
- Disposable PTY fixtures (`bootstrap/test-support/hc-live-terminal.ts`) named
  `probe`, `receiver`, `sender`, `child`, `status`, `booting`, `booting-late-raw`, and
  `other-label`, capturing raw stdin, testing pre-read buffering vs late raw
  mode + 60 ms startup drain, running the unaltered-env terminal self-probe, and emitting candidate OSC 7501 records.
- Non-PTY terminals (`/bin/sleep 240` and `/bin/true`) named `owned`, `reuse`,
  `reuse-after-rm`, and `finished-kill` (probing labels, name reuse, and
  `hc kill` on an already-`finished` terminal for question (i)).
- Findings directory `bootstrap-hc-findings-*` under
  `PI_BOOTSTRAP_HC_FINDINGS_DIR` (or the OS temp directory when unset),
  containing `hc-spike-findings.json` and `hc-spike-findings.md` (including
  partial results if a probe fails).

**Teardown and orphaned core recovery:** The suite kills and removes its
terminals, stops the verified core, and checks that the core PID and all
recorded holder PIDs have exited; on the verified path, a failing
`hc server stop --json` is recorded separately as `stopError` rather than as a
verification failure. If `readCoreStatus` verification fails after
`hc server start --json` (while the socket path and `HC_SESSION` match the
scratch values), teardown falls back to running the isolated
`hc server stop --json` with the scratch environment and then checks that any
valid core PID (`2..0x7fffffff`) recorded from `hc server start --json` has exited
(sending `SIGTERM` only after confirming a non-empty `HC_SESSION` match in
`/proc/<pid>/environ`, and re-reading `/proc/<pid>/environ` to re-verify
`HC_SESSION` immediately before any `SIGKILL`). If verification fails, the run exits early, or
shutdown cannot be confirmed, the suite retains `/tmp/bootstrap-hc-*` and prints
the exact `isolation.stopCommand` (`env -i ... hc server stop --json` using the
isolated env recorded in `isolation.env` in `hc-spike-findings.json`). If a
core or holder PID outlives `hc server stop` after the socket is already gone,
it also prints a `kill <corePid> <holderPids>` hint from
`isolation.teardownPids`. Run that printed command (never `hc server stop` in
your normal environment) to stop an orphaned isolated core.

Use the observed results after the operator's run to update the verification
tags and, if needed, tickets 04, 06, and 07.

## Non-goals

- Remote hc (`hc run --on …`) is out of scope. The CLI option is **verified — source: `hc run --help`**; this contract does not use it.
- Moving the session directory out of the checkout is out of scope.
