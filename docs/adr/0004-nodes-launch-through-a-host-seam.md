# Nodes launch through a Host seam with two backends, Herdr and hc

Bootstrap launched every node by calling the `herdr` command line directly from one class, so it could run only from inside a Herdr pane. We put a narrow **Host** interface between bootstrap and the terminal multiplexer and add an `hc` (herdr-core) backend beside the existing Herdr one. hc is more flexible (it works from any shell, addresses terminals by stable name and label, and needs no workspace), but Herdr users must keep working, so both backends stay fully supported.

## Decisions

- **The seam is sized to what bootstrap needs, not to a CLI.** Its operations are: preflight, launch a node, report whether a node's terminal exists, close a node, send a wake-up, and discover which nodes a run owns. Anything about Herdr tabs, panes or workspaces stays inside the Herdr backend. `bootstrap/HOST.md` is the contract.
- **The backend is chosen once per run and frozen.** First rule that applies: `PI_BOOTSTRAP_HOST`; then the calling context (`HC_TERMINAL_ID` means hc, `HERDR_ENV=1` with `HERDR_PANE_ID` means herdr, hc wins if both); then, outside any Host, hc if the binary is on `PATH` and its core answers. The result is `host_backend` in the manifest. Recovery uses the recorded backend whatever the caller's environment, and a manifest without one reads as `herdr`. `HC_TERMINAL_ID` alone cannot decide, because an orchestrator in an ordinary shell never has it.
- **Manifests stay readable.** The Herdr fields stay as they are; each launch gains an opaque `host_ref` that the backend owns.
- **hc nodes are independent of the dispatcher.** They launch with `--no-parent --no-notify`, so a node neither dies with the dispatching turn nor has notes typed into its input. Cleanup stays explicit, as with Herdr tabs. Ownership is decided by labels and the terminal id, never by the name.
- **A wake-up never forces a blocked agent.** `hc send` refuses a blocked terminal unless forced, and forcing could type into a permission prompt or a human request. The hc backend never forces and never gates on status: a refusal is `skipped(blocked)`, the offer stays on disk, and recovery redelivers it. This is ADR 0003 applied to the new backend: status is never workflow state.
- **Status publishing is separate and advisory.** `herdr-agent-state.ts` is Herdr-managed and is not edited. A distinct extension emits OSC 7501 status only when `HC_TERMINAL_ID` is set.

## Considered options

- **Detect hc from `HC_TERMINAL_ID` alone.** Rejected: unset outside hc terminals, which is where the orchestrator usually sits.
- **Replace Herdr with hc.** Rejected: existing Herdr users and the live Herdr suite must keep working.
- **A thin pass-through of CLI commands.** Rejected: the two CLIs differ in ids, closing and status, so a pass-through would leak those differences into bootstrap.

## Consequences

- Remote hc (`--on`) is a non-goal: paths, cwd and the shared checkout assume one machine.
- Relocating `.pi/agent-sessions/<task_id>/` out of the project checkout is not part of this work. It is the shared-checkout trust gap named in ADR 0003 and is validated in several places, so it needs its own spec.
- Several hc behaviours are not documented upstream (the `<hc from=…>` wrapper on `hc send`, the OSC 7501 bytes, the test-isolation recipe, sending to a booting agent). `bootstrap/HOST.md` tags each as verified or not, and a gated live spike resolves them.
