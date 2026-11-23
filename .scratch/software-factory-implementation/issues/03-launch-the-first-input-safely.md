# 03: Launch the first input safely

**What to build:** The managing session can take an accepted factory input from receipt to a real Bootstrap run and inspect the association. Carry the existing agent-driven graph protocol through the factory launch; do not add unattended queue progression until its recovery controls are in place. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [02: Submit a brief and recover its receipt](02-submit-and-recover-a-receipt.md).

**Status:** done — merged to feature/software-factory

- [x] Launch the oldest eligible input, using its preserved executable definition in the managing pane's Herdr workspace. The exact multiline brief is available as immutable task input; a shortened shared brief points to the full text via the existing input reader. Existing within-run parallelism and write ownership are unchanged.
- [x] Before invoking launch, durably record the attempt, stable Bootstrap request ID and both capacity holds. A factory can occupy only one slot, and equivalent checkout paths contend across factories, workspaces and separate factory state roots. A different checkout can proceed; standalone launches do not take factory holds.
- [x] Recheck the managing session's authority at launch and release. Commit affirmative evidence that execution may start before any agent can act on release. Read-only lookup can find the exact launch/run after an acknowledgement is lost without calling generate or acting on the run. Missing or contradictory evidence leaves capacity held and visible.
- [x] Factory inspection, including existing run status paths used for it, never resumes, repairs or cleans up the run. Reject direct run mutations that would bypass factory authority, and never allow destructive cleanup of required factory evidence.
- [x] Demonstrate receipt → launch → run inspection through the real agent fixture, with competing launches across state roots and child-process interruption before and after the release boundary. No duplicate run, premature execution or unsafe capacity reuse is observed; document the crash-durable commit boundary.
