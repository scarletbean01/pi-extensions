# 10: Keep human waits from expiring dependent work

**What to build:** An operator can leave an intervention pending longer than ordinary graph timeouts, then respond and see the original work continue. The wait excuses only time attributable to that request, not a dead agent or an independent failure. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [09: Ask for and record human direction](09-ask-for-and-record-human-direction.md).

**Status:** done

- [x] Do not count a human wait against the requesting attempt's execution timeout. Ending the wait resumes the applicable clock without resetting time already spent on ordinary work.
- [x] No direct or transitive dependant, including a join, times out solely because of a pending human wait. Unrelated branches and other prerequisites retain their deadlines and can make progress or fail normally; loss of the requesting agent remains detectable.
- [x] Show what is waiting for a person versus stalled, lost, or waiting on ordinary dependency progress. Waiting does not release existing node ownership or either capacity hold.
- [x] With controlled time and real agent behavior in the fixture, demonstrate an overdue-by-wall-clock request, dependent chain and join, independent deadline expiry, lost requester, and continuation on response without a new attempt.
