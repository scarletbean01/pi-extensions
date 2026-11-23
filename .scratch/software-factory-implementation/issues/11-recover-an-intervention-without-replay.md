# 11: Recover an intervention without replaying an attempt

**What to build:** After takeover, the managing operator can find the original request and recover a response delivery only when the same attempt is verified able to continue. Where progress is ambiguous, inspect what is known instead of starting another turn. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [05: Take over management and retry a proven unreleased launch](05-take-over-and-retry-a-proven-unreleased-launch.md); [09: Ask for and record human direction](09-ask-for-and-record-human-direction.md).

**Status:** done

- [x] Reconcile pending, resolved, cancelled and uncertain requests by their original IDs. A pending request remains actionable only if its original attempt is verified able to continue; never recreate an agent or reset its claim.
- [x] Reconcile separately whether a response was durably recorded and whether the attempt claimed it. Re-send only a wake-up for the same saved response and verified waiting attempt. The durable consumption claim precedes ordinary work and prevents duplicates from authorizing another turn.
- [x] If an interruption leaves it unclear whether a claimed response led to continuation, report uncertainty rather than replaying. Cancelled or failed attempts cannot be revived. Missing, unreadable or contradictory evidence is reported and left intact.
- [x] Use supervised process interruptions around response and consumption to verify lost acknowledgement, duplicate wakes, takeover of a still-actionable request, and loss of manager, agent or Herdr where continuation is uncertain or impossible.
