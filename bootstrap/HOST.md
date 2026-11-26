# Host contract

Bootstrap uses a **Host** to launch and manage each node's terminal. The
selected **Host backend** is `herdr` or `hc`; it is fixed for the life of a
run. This document records the interface and backend mapping specified in
[the host-backends spec](../.scratch/host-backends/spec.md). `bootstrap/host-herdr.ts`
implements the Herdr backend; `bootstrap/host-hc.ts` implements hc selection,
preflight, node launch, existence reporting, and owned-node discovery (hc close
and wake-up are implemented by follow-on tickets 04 and 06).

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
| **Preflight** | Require `HERDR_ENV=1`, `HERDR_PANE_ID`, and `herdr` on `PATH`; run `herdr pane get "$HERDR_PANE_ID"` and retain its `workspace_id`. | Check `hc` is on `PATH`; run `hc server status --json` and require a response with `core.id` and `version`. In an hc calling context, validate the terminal identity with `hc get --json "$HC_TERMINAL_ID"`. | Preflight failure names the selected backend and operation. **Verified (documented, not live-tested until ticket 05) — source: `hc server status --help`, `hc get --help`, `hc schema` (`StatusResult`, `terminal.get`).** |
| **Launch** | Create a per-node launcher script, then run `herdr tab create --workspace "$workspace_id" --label "$label" --cwd "$directory" --no-focus --env PI_COMS_DIR=… --env PI_COMS_TIMEOUT_MS=300000`; submit it with `herdr pane run "$pane_id" <launcher-command>`. The created tab, pane, terminal and label form the Herdr handle. | Write the per-node launcher script unsetting inherited `HERDR_*` variables and exporting `PI_COMS_DIR`, `PI_COMS_TIMEOUT_MS` (and `PI_COMS_MAX_HOPS` for agent nodes), then run `hc run --json --bg --name "$name" --cwd "$directory" --label bootstrap_run="$task_id" --label bootstrap_node="$instance_id" --no-parent --no-notify /bin/sh <launcher-script>`. Save the returned `address` with the chosen `name` in the hc handle (`workspace_id` in the manifest is `"hc"`). | Herdr's public tab/pane IDs can compact after a close; hc's returned address is stable on its core. **Verified (documented, not live-tested until ticket 05) — source: `hc run --help`, `hc schema` (`RunResult.address`).** The CLI stdout shape of `hc run --json --bg` is **unverified (documented, not live-tested until ticket 05) — source: `hc run --help`, `hc schema` (`RunResult`)**. `hc run` CLI help has no environment flag, so the launcher script exports the node environment before `exec`; **verified (documented, not live-tested until ticket 05) — source: `hc run --help`** (the API schema's separate `env` parameter is not a CLI flag). |
| **Report terminal existence** | Resolve the recorded pane/terminal from `herdr api snapshot` (or workspace and pane listings on older servers); `herdr pane get "$pane_id"` is also used for the wake-up check. | Discover run candidates with `hc ls --all --json --label bootstrap_run="$task_id"` and confirm each candidate (plus the saved `address` if absent from the listing) with `hc get --json "$address"`; its `state` is `live` or `finished`. | Report `present`, `gone`, or `ambiguous`: `finished` still means the hc terminal record exists, while `gone` means the exact saved resource is absent (`error.kind === "not_found"`, or exit code 3 with no other `error.kind`); conflicting label/identity matches or unrecorded label-only matches are `ambiguous`. Do not infer worker liveness from this result. **Verified (documented, not live-tested until ticket 05) — source: `hc get --help`, `hc --skill` (exit code 3), `hc schema` (`Terminal.state`, `Terminal.address`).** |
| **Close a node** | Verify ownership, then run `herdr pane close "$pane_id"` if the owned pane moved or its tab contains other panes; otherwise run `herdr tab close "$tab_id"`. This preserves unrelated panes in a rearranged tab. | Verify the saved address and labels, then run `hc kill --json "$address"` followed by `hc rm --json "$address"`. If already finished, remove the finished terminal with `hc rm`. *(Not implemented yet in `host-hc.ts`; ticket 04 wires it.)* | Herdr closes a tab or pane. hc hangs up/escalates to end the program, then removes the finished terminal. Herdr public IDs may compact; hc addresses remain stable. **Verified (documented, not live-tested until ticket 05) — source: `hc kill --help`, `hc rm --help`, `hc schema` (`terminal.kill`, `terminal.rm`, `Terminal.address`).** The schema's `live` error on `terminal.rm` backs the kill-then-remove order. |
| **Send a wake-up** | Only after checking the destination process is alive, its durable offer is unclaimed and its pane exists, run `herdr pane send-text "$pane_id" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`, then `herdr pane send-keys "$pane_id" Enter`. Preserve the pending marker if submission is uncertain. | After the same durable checks, run `hc send --json "$address" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`; do not pass `--force` or gate on the Host's status. *(Not implemented yet in `host-hc.ts`, which returns `failed`; ticket 06 wires it.)* | Return `sent`, `skipped` with a reason, or `failed` with a reason. Map `blocked` (exit code 9) to skipped; map `finished` and `not_found` to skipped because the program is no longer wakeable (`finished` remains a record; `not_found` has no record); map `unavailable` and other send errors to failed with the error reason. `hc send` presses Enter itself and waits for a person's unfinished draft to clear before sending. **Verified (documented, not live-tested until ticket 05) — source: `hc send --help`, `hc --skill` (exit code 9), `hc schema` (`terminal.send`, `SendResult` and error kinds).** Whether submitted text is wrapped in an hc note is **unverified (documented, not live-tested) — source: `hc --help` settings note and `hc --skill`**: help says `notes = false` produces no notes or `<hc>` tags on messages, while the skill shows child reports wrapped as `<hc from="…">…</hc>` and an example with a `reach="…"` attribute. A wake-up sent while an agent is booting can be dropped; that behavior is **unverified (documented, not live-tested) — source: `hc --skill`**. |
| **Discover a run's owned nodes** | Prefer `herdr api snapshot`; if unsupported, run `herdr workspace list`, then `herdr tab list --workspace "$workspace_id"` and `herdr pane list --workspace "$workspace_id"`. Match the run/node label and confirm the recorded terminal identity before treating a resource as owned. | Filter with `hc ls --all --json --label bootstrap_run="$task_id"`; for each candidate, run `hc get --json "$address"` and confirm both ownership labels and the saved address/terminal identity. Never decide ownership from the name alone. | The contract requires label filtering followed by per-terminal confirmation. The compact `hc ls` display omits labels: **unverified — source: not documented**; the JSON schema does expose terminal labels (**verified (documented, not live-tested until ticket 05) — source: `hc schema` (`ListResult`, `Terminal.labels`)**). The `--label` filter is **verified (documented, not live-tested until ticket 05) — source: `hc ls --help`**. |

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
behavior. **Verified — CLI name length/characters and uniqueness among live
terminals: source `hc run --help`; duplicate-name error kind `name_taken`:
source `hc schema` (`terminal.run`).** Nodes are separate terminals
independent of the dispatcher; `--no-parent` avoids
inheriting its parent relationship, so cleanup stays explicit, and
`--no-notify` prevents notes being typed into the parent. **Verified — source:
`hc run --help`.**

For hc discovery, filter by the run label, then confirm each candidate's
terminal identity and both labels through `hc get`. A label or name match
alone is never permission to close a terminal. The compact listing's label
display is **unverified — source: not documented**; confirmation is required
either way.

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
| `run`, `ls`, `get`, `kill`, `rm`, `label`, `send`, and `server status` command forms and listed options | **Verified (documented, not live-tested until ticket 05) — source: corresponding `hc <command> --help` text.** |
| A terminal address such as `t7` identifies that terminal on its core; returned `address` is the terminal reference; CLI stdout shape of `hc run --json --bg` | **Verified (documented, not live-tested until ticket 05) — source: `hc schema` (`Terminal.address`, `RunResult.address`);** CLI stdout shape of `hc run --json --bg` is **unverified (documented, not live-tested until ticket 05) — source: `hc run --help`, `hc schema` (`RunResult`).** |
| `hc send` pastes and submits with Enter, waits for a person's unfinished draft, and refuses blocked programs unless forced | **Verified (documented, not live-tested until ticket 05) — source: `hc send --help` and `hc schema` (`terminal.send`).** |
| `hc send` note wrapper around submitted text | **Unverified (documented, not live-tested) — source: `hc --help` settings note and `hc --skill`.** The settings note describes when hc emits no notes/tags; the skill shows child report wrappers, sometimes with a `reach` attribute. The live spike must determine whether wake-up input itself is wrapped and whether the worker's “at most one wrapper” matching must account for `reach`. |
| Status record fields and state words; exact OSC byte framing/escaping | Payload fields and words **verified — source: `hc schema` (`Status`)**; byte framing/escaping **unverified — source: not documented**. |
| Isolated-core test recipe | **Unverified (documented, not live-tested) — source: `hc --skill`.** Tests need their own `HC_SESSION` and scratch XDG paths. |
| Sending while the agent is still booting | **Unverified (documented, not live-tested) — source: `hc --skill`.** A send to a booting agent can be dropped, so the live spike must establish a safe readiness boundary. |
| Whether compact `hc ls` text includes labels | **Unverified — source: not documented.** Use label filtering and per-terminal `get` confirmation. |

The unverified items must be settled by the gated live hc spike before code
depends on them. The live suite must use an isolated hc core and scratch paths;
the documented recipe requires its own `HC_SESSION` and scratch XDG paths, but
the recipe remains **unverified (documented, not live-tested) — source:
`hc --skill`**.

## Live spike procedure

Run this only after the operator approves the live hc check. From the
repository root on Linux, with Node 26+, `hc`, and util-linux `script`
on `PATH`, run:

```sh
env -u PI_BOOTSTRAP_LIVE_HERDR PI_BOOTSTRAP_LIVE_HC=1 \
  PI_BOOTSTRAP_HC_FINDINGS_DIR="$PWD/.scratch/host-backends" \
  timeout 620 node bootstrap/run-tests.ts live
```

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
`busctl`, `sudo`, and `pkexec`, forcing `hc` to fall back to a direct child
daemon. After `hc server start --json`, `readCoreStatus` verifies the socket
path and inode, reads the core ID and PID from `hc server status --json`,
rejects any core whose `/proc/<pid>/environ` contains `INVOCATION_ID` or does
not match the scratch settings, and rejects any `/proc/<pid>/cgroup` matching
an hc/herdr systemd unit or newly entered `.service` unit. Terminal operations
and server stop require that same verified identity. Both `/proc/<pid>/cgroup`
and the shim call log (`shim-calls.log`) are recorded in `isolation` findings.
All addresses are local.

**Resources created during the live run:**
- Scratch root `/tmp/bootstrap-hc-*` (removed after confirmed core and holder
  exit; retained on failure or unconfirmed stop for diagnosis), containing `bin/`,
  `home/`, `tmp/`, `config/`, `cache/`, `data/`, `state/`, `runtime/`,
  `shim-calls.log`, and fixture mailbox/capture files (`*.boot`, `*.ready`,
  `*.input`, `*.flushed`, `*.request`, `*.response`, `*.release`).
- Disposable PTY fixtures (`bootstrap/test-support/hc-live-terminal.ts`) named
  `receiver`, `sender`, `child`, `status`, `booting`, `booting-late-raw`, and
  `other-label`, capturing raw stdin, testing pre-read buffering vs late raw
  mode + startup flush, and emitting candidate OSC 7501 records.
- Non-PTY terminals (`/bin/sleep 240` and `/bin/true`) named `owned`, `reuse`,
  `reuse-after-rm`, and `finished-kill` (probing labels, name reuse, and
  `hc kill` on an already-`finished` terminal for question (i)).
- Findings directory `bootstrap-hc-findings-*` under
  `PI_BOOTSTRAP_HC_FINDINGS_DIR` (or the OS temp directory when unset),
  containing `hc-spike-findings.json` and `hc-spike-findings.md` (including
  partial results if a probe fails).

**Teardown and orphaned core recovery:** The suite kills and removes its
terminals, stops the verified core, and checks that the core PID and all
recorded holder PIDs have exited. If verification fails, the run exits early, or
shutdown cannot be confirmed, the suite retains `/tmp/bootstrap-hc-*` and prints
the exact `isolation.stopCommand` (`env -i ... hc server stop --json` using the
isolated env recorded in `isolation.env` in `hc-spike-findings.json`). Run that
printed command (never `hc server stop` in your normal environment) to stop an
orphaned isolated core.

Use the observed results after the operator's run to update the verification
tags and, if needed, tickets 04, 06, and 07.

## Non-goals

- Remote hc (`hc run --on …`) is out of scope. The CLI option is **verified — source: `hc run --help`**; this contract does not use it.
- Moving the session directory out of the checkout is out of scope.

## Known implementation gaps

- Until ticket 04, cleanup (automatic or explicit) of an `hc` run ends in `error`/`cleanup-incomplete` and leaves the terminals running.
- `HcHost.closeNode` (ticket 04) and `HcHost.sendWakeUp` (ticket 06) are not implemented yet (`closeNode` throws not implemented; `sendWakeUp` returns `failed`).
- The worker's own wake-up fallback (`bootstrap/worker.ts`) still calls `tryPaneWake` directly instead of routing through the Host interface (`sendWakeUp`); ticket 06 moves it. (To prevent `hc` nodes started from an `hc` core inside Herdr from inheriting `HERDR_*` and firing `tryPaneWake`, `hc` launcher scripts unset `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, and `HERDR_SOCKET_PATH`.)
