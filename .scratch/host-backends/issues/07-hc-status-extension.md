# 07: hc status extension

**What to build:** Under hc, an agent reports its status to hc so it shows correctly in hc's own views. The reporting is advisory and never affects workflow state (ADR 0003).

## Why this ticket is superseded

Pi 1.6.1 already has a native OSC 7501 reporter. A Bootstrap extension would add a second, conflicting status stream: for example, the proposed extension reports `idle` at `agent_settled` while Pi can report `done`, and it marks every UI prompt as blocked. Bootstrap therefore adds no hc status extension. Host status remains advisory and never affects workflow state.

Pi's `terminal-setup.md` documents `working`, `blocked`, `done`, `error`, and `idle`, their meanings, and capability-query gating. `environment-variables.md` documents `PI_PROGRAM_STATUS=1` to always report and `PI_PROGRAM_STATUS=0` to disable reporting. The installed Pi 1.6.1 binary emits `state`, `app`, optional blocked `kind`, then base64 `msg`; `blocked` and `error` reports carry a message, as do `working` and `done` when a session name is set; `idle` has no `msg`. Pi can emit `state=clear` when its TUI stops.

Run 3 verified hc answers the query bytes Pi sends, but the query was fixture-sent, not sent from Pi. Run 5 started a real Pi process inside the isolated hc core with `PI_PROGRAM_STATUS` unset and no input; `hc get --json` showed `reported: true` and `status: {app: "pi", state: "idle"}`. This verifies Pi's startup report in that isolated terminal, not its other state transitions. Run 5 fixture-sent exact Pi-shaped reports for `blocked`, `working`, `done`, and `error` with valid base64 `msg=`; hc accepted them and returned decoded message text. `idle` was accepted without `msg`, and `state=clear` cleared a seeded idle status (`reported: true`, `status: null`). A separate Pi-shaped blocked fixture made `hc send` refuse without `--force` (exit 9, `error.kind: "blocked"`, 0 delivered bytes). This verifies hc's response to the tested payload, but no real Pi dialog was open and a real blocked-dialog wake-up was not tested end to end. If a different Pi blocked payload is rejected, a wake-up could reach the dialog; Redelivery is the only backstop. The raw `msg=hello` rejection from run 4 was not evidence about base64 `msg=`.

Spec: `../spec.md` (status publishing).

**Status:** superseded

- [ ] With the hc terminal identity set, the extension emits the documented reports for each mapped event. — SUPERSEDED by Pi's native reporter. Pi docs describe the state vocabulary and query gating; a real Pi startup `idle` report was observed in run 5. Pi's real `working`, `blocked`, `done`, `error`, and `clear` transitions were not observed; exact fixture payloads for them were accepted by hc.
- [ ] Without the hc terminal identity, nothing is emitted. — SUPERSEDED by Pi's native reporter, which follows capability-query support or the `PI_PROGRAM_STATUS` override, not `HC_TERMINAL_ID`. The behavior of a real Pi process without an hc terminal was not tested.
- [ ] The Herdr-managed state extension is unchanged. — SUPERSEDED by the decision to add no hc extension; `herdr-agent-state.ts` remains untouched.
- [ ] The documentation describes the extension and its advisory role. — SUPERSEDED by documentation of Pi's native reporter, the run 5 evidence, the remaining live-dialog limitation, and the advisory role of Host status.
