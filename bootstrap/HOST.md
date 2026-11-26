# Host contract

Bootstrap uses a **Host** to launch and manage each node's terminal. The
selected **Host backend** is `herdr` or `hc`; it is fixed for the life of a
run. This document records the interface and backend mapping specified in
[the host-backends spec](../.scratch/host-backends/spec.md). The Herdr commands
below are the commands the current `bootstrap/lifecycle.ts` and
`bootstrap/pane-wake.ts` run. The hc commands document the contract for its
implementation; this documentation ticket does not add that implementation.

Host status is resource information only. Durable records and the worker
process decide execution and liveness; a Host never decides workflow state
([ADR 0003](../docs/adr/0003-handoff-offer-is-the-only-authority.md)).

## Operations

Each operation shows the command sequence and the meaning Bootstrap assigns to
its result. The `hc evidence` column tags hc facts with their source. Sources
are the installed `hc` command's help or `hc schema`; **not documented** means
neither source specifies the behavior.

| Operation | Herdr (current commands) | hc (contract commands) | Semantic result and hc evidence |
| --- | --- | --- | --- |
| **Preflight** | Require `HERDR_ENV=1`, `HERDR_PANE_ID`, and `herdr` on `PATH`; run `herdr pane get "$HERDR_PANE_ID"` and retain its `workspace_id`. | Check `hc` is on `PATH`; run `hc server status --json` and require a response. In an hc calling context, validate the terminal identity with `hc get --json "$HC_TERMINAL_ID"`. | Preflight failure names the selected backend and operation. **Verified — source: `hc server status --help`, `hc get --help`, `hc schema` (`terminal.get`).** |
| **Launch** | Create a per-node launcher script, then run `herdr tab create --workspace "$workspace_id" --label "$label" --cwd "$directory" --no-focus --env PI_COMS_DIR=… --env PI_COMS_TIMEOUT_MS=300000`; submit it with `herdr pane run "$pane_id" <launcher-command>`. The created tab, pane, terminal and label form the Herdr handle. | Run `hc run --json --bg --name "$name" --cwd "$directory" --label bootstrap_run="$task_id" --label bootstrap_node="$instance_id" --no-parent --no-notify <launcher-script>`. Save the returned `address` with the chosen `name` in the hc handle. | Herdr's public tab/pane IDs can compact after a close; hc's returned address is stable on its core. **Verified — source: `hc run --help`, `hc schema` (`RunResult.address`).** `hc run` CLI help has no environment flag, so the launcher script exports the node environment before `exec`; **verified — source: `hc run --help`** (the API schema's separate `env` parameter is not a CLI flag). |
| **Report terminal existence** | Resolve the recorded pane/terminal from `herdr api snapshot` (or workspace and pane listings on older servers); `herdr pane get "$pane_id"` is also used for the wake-up check. | Query the saved address with `hc get --json "$address"`; its `state` is `live` or `finished`. | Report `present`, `gone`, or `ambiguous`: `finished` still means the hc terminal record exists, while `gone` means the exact saved resource is absent; conflicting label/identity matches are `ambiguous`. Do not infer worker liveness from this result. **Verified — source: `hc get --help`, `hc schema` (`Terminal.state`, `Terminal.address`).** |
| **Close a node** | Verify ownership, then run `herdr pane close "$pane_id"` if the owned pane moved or its tab contains other panes; otherwise run `herdr tab close "$tab_id"`. This preserves unrelated panes in a rearranged tab. | Verify the saved address and labels, then run `hc kill --json "$address"` followed by `hc rm --json "$address"`. If already finished, remove the finished terminal with `hc rm`. | Herdr closes a tab or pane. hc hangs up/escalates to end the program, then removes the finished terminal. Herdr public IDs may compact; hc addresses remain stable. **Verified — source: `hc kill --help`, `hc rm --help`, `hc schema` (`terminal.kill`, `terminal.remove`, `Terminal.address`).** |
| **Send a wake-up** | Only after checking the destination process is alive, its durable offer is unclaimed and its pane exists, run `herdr pane send-text "$pane_id" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`, then `herdr pane send-keys "$pane_id" Enter`. Preserve the pending marker if submission is uncertain. | After the same durable checks, run `hc send --json "$address" "[BOOTSTRAP_WAKE handoff=$handoff_id]"`; do not pass `--force` or gate on the Host's status. | Return `sent`, `skipped` with a reason, or `failed` with a reason. A blocked hc terminal is a skip; a send error is a failure. `hc send` presses Enter itself and waits for a person's unfinished draft to clear before sending. **Verified — source: `hc send --help`, `hc schema` (`terminal.send`, `SendResult`).** Whether hc wraps the text in a note such as `<hc from=…>` is **unverified — source: not documented**. Sending to a booting agent is **unverified — source: not documented**. |
| **Discover a run's owned nodes** | Prefer `herdr api snapshot`; if unsupported, run `herdr workspace list`, then `herdr tab list --workspace "$workspace_id"` and `herdr pane list --workspace "$workspace_id"`. Match the run/node label and confirm the recorded terminal identity before treating a resource as owned. | Filter with `hc ls --json --label bootstrap_run="$task_id"`; for each candidate, run `hc get --json "$address"` and confirm both ownership labels and the saved address/terminal identity. Never decide ownership from the name alone. | The contract requires label filtering followed by per-terminal confirmation. The compact `hc ls` display omits labels: **unverified — source: not documented**; the JSON schema does expose terminal labels (**verified — source: `hc schema` (`ListResult`, `Terminal.labels`)**). The `--label` filter is **verified — source: `hc ls --help`**. |

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
   Validate the identity with that Host. If both contexts are present, hc
   wins. **Verified — hc identity fields/options: source `hc schema`
   (`terminal.run` caller and `terminal.get`); Herdr context: current
   `bootstrap/lifecycle.ts`.**
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
**Verified — allowed hc name length/characters: source `hc run --help`** (the
contract's name derivation is a Bootstrap rule). Nodes are separate terminals
independent of the dispatcher; `--no-parent` avoids inheriting its parent
relationship, so cleanup stays explicit, and `--no-notify` prevents notes
being typed into the parent. **Verified — source: `hc run --help`.**

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
| `run`, `ls`, `get`, `kill`, `rm`, `label`, `send`, and `server status` command forms and listed options | **Verified — source: corresponding `hc <command> --help` text.** |
| A terminal address such as `t7` identifies that terminal on its core; returned `address` is the terminal reference | **Verified — source: `hc schema` (`Terminal.address`, `RunResult.address`).** |
| `hc send` pastes and submits with Enter, waits for a person's unfinished draft, and refuses blocked programs unless forced | **Verified — source: `hc send --help` and `hc schema` (`terminal.send`).** |
| `hc send` note wrapper around submitted text | **Unverified — source: not documented.** |
| Status record fields and state words; exact OSC byte framing/escaping | Payload fields and words **verified — source: `hc schema` (`Status`)**; byte framing/escaping **unverified — source: not documented**. |
| Isolated-core test recipe | **Unverified — source: not documented.** |
| Sending while the agent is still booting | **Unverified — source: not documented.** |
| Whether compact `hc ls` text includes labels | **Unverified — source: not documented.** Use label filtering and per-terminal `get` confirmation. |

The unverified items must be settled by the gated live hc spike before code
depends on them. The live suite must use an isolated hc core and scratch paths;
its exact isolation recipe is currently **unverified — source: not documented**.

## Non-goals

- Remote hc (`hc run --on …`) is out of scope. The CLI option is **verified — source: `hc run --help`**; this contract does not use it.
- Moving the session directory out of the checkout is out of scope.
