# 07: hc status extension

**Status:** superseded

## Why this ticket is superseded

Pi 1.6.1 already has a native OSC 7501 reporter. A Bootstrap extension would add a second, conflicting status stream: for example, the proposed extension reports `idle` at `agent_settled` while Pi can report `done`, and it marks every UI prompt as blocked. Bootstrap therefore adds no hc status extension. Host status remains advisory and never affects workflow state (ADR 0003).

Pi's `terminal-setup.md` documents `working`, `blocked`, `done`, `error`, and `idle`, their meanings, and that Pi reports only after the terminal confirms OSC 7501 support. `environment-variables.md` documents `PI_PROGRAM_STATUS=1` to always report and `PI_PROGRAM_STATUS=0` to disable reporting. The installed Pi 1.6.1 binary reports `app=pi` and sends `msg` as base64. These Pi sources document native reporter behavior; they do not verify its behavior inside hc.

hc's OSC 7501 capability-query reply was verified in live run 3, and hc's refusal to send to a `blocked` terminal without `--force` (exit 9, mapped to skipped with Redelivery covering the offer) was verified with a fixture and documented in `bootstrap/HOST.md`. The run-4 `msg=hello` probe used a raw, non-base64 value. Whether hc accepts Pi's base64 `msg=` remains unverified.

## Original criteria disposition

| Original criterion | Current evidence |
| --- | --- |
| Reports each mapped event under hc | Pi docs describe the native state vocabulary and conditions, but the original event mapping is not the Pi mapping. This is documentation-only evidence; the actual Pi-in-hc behavior was never live-tested. |
| Emits nothing without `HC_TERMINAL_ID` | Not met by Pi's documented design: reporting follows the terminal capability reply or `PI_PROGRAM_STATUS` override, not hc identity. Behavior inside a real hc terminal is unverified. |
| Leaves the Herdr-managed state extension unchanged | Verified separately: `herdr-agent-state.ts` remains untouched. |
| Documents status and its advisory role | Updated in `bootstrap/README.md` and `bootstrap/HOST.md`; manually checked and the focused docs suite passes. |

The deleted fake-process tests for the proposed extension are not evidence for Pi's native reporter. Pi's behavior inside a real hc terminal with a real Pi agent was never live-tested.

Spec: `../spec.md` (status publishing).
