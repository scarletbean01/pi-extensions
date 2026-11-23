# 07: Clear an uncertain capacity hold

**What to build:** A managing operator can inspect an uncertain hold and, only after establishing that the original work cannot resume in conflict, record an operator clearance that unblocks capacity without resolving past execution. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [05: Take over management and retry a proven unreleased launch](05-take-over-and-retry-a-proven-unreleased-launch.md); [06: Cancel a run and verify settlement](06-cancel-a-run-and-verify-settlement.md).

**Status:** done — merged to feature/software-factory

- [x] Inspection identifies both holds, what is missing or contradictory, and the exact action and consequences. Confirmation, reboot, a closed tab or cancellation intent cannot overcome evidence that conflicting work may still resume.
- [x] Require direct human confirmation, a reason, supporting evidence of non-resumability, and acknowledgement of unknown past effects. Recheck the exact target, operator authority and eligibility at commit; do not accept confirmation from an agent tool.
- [x] Commit clearance, release both holds and retire the input from launch eligibility without rewriting its prior outcome, erasing records, undoing effects or launching anything on its behalf. Intentional repetition requires a new submission.
- [x] Verify refusal with a live or unfenced attempt, durable recovery around the clearance commit, and successful checkout reuse without replay. Preserve contradictory source records and show the clearance separately from execution settlement.
