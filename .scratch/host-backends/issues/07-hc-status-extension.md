# 07: hc status extension

**What to build:** Under hc, an agent reports its status to hc so it shows correctly in hc's own views. The reporting is advisory and never affects workflow state (ADR 0003).

## Why this ticket is superseded

Pi 1.6.1 already has a native OSC 7501 reporter. A Bootstrap extension would add a second, conflicting status stream: for example, the proposed extension reports `idle` at `agent_settled` while Pi can report `done`, and it marks every UI prompt as blocked. Bootstrap therefore adds no hc status extension. Host status remains advisory and never affects workflow state.

Pi's `terminal-setup.md` documents `working`, `blocked`, `done`, `error`, and `idle`, their meanings, and capability-query gating. `environment-variables.md` documents `PI_PROGRAM_STATUS=1` to always report and `PI_PROGRAM_STATUS=0` to disable reporting. The installed Pi 1.6.1 binary reports `app=pi` and base64-encodes `msg`. `blocked` and `error` reports carry a message, as do `working` and `done` when a session name is set; `idle` has no `msg`. Pi can emit `state=clear` when its TUI stops; `clear` is outside hc's verified vocabulary and hc's handling is unverified.

Run 3 verified that hc answers the same OSC 7501 query bytes Pi sends, but a fixture sent the bytes, not Pi. That did not verify Pi's query exchange. hc's acceptance of Pi's base64 `msg=` is unverified, so every non-idle Pi status depends on that acceptance. Run 4 only established rejection of the raw, non-base64 value `msg=hello`. A fixture's bare `state=blocked` report made `hc send` refuse without `--force` (exit 9), but there is no live evidence that hc refuses wake-ups into Pi dialogs. If hc rejects Pi's base64 `msg=`, it may not recognize the `blocked` report, and a wake-up could be typed into an open Pi dialog or login prompt; Redelivery is the only backstop. Pi reporting inside a real hc terminal with a real Pi agent was never live-tested.

Spec: `../spec.md` (status publishing).

**Status:** superseded

- [ ] With the hc terminal identity set, the extension emits the documented reports for each mapped event. — SUPERSEDED by Pi's native reporter; Pi docs describe the state vocabulary, but the actual Pi-in-hc behavior was never live-tested.
- [ ] Without the hc terminal identity, nothing is emitted. — SUPERSEDED by Pi's native reporter, which follows capability-query support or the `PI_PROGRAM_STATUS` override, not `HC_TERMINAL_ID`.
- [ ] The Herdr-managed state extension is unchanged. — SUPERSEDED by the decision to add no hc extension; `herdr-agent-state.ts` remains untouched and was verified separately.
- [ ] The documentation describes the extension and its advisory role. — SUPERSEDED by documentation of Pi's native reporter and the advisory role of Host status.
