# 08: Parked-agent safety

**What to build:** Idle loop agents are safe against duplicates, crashes, tab closes and races: nothing runs twice, nothing is replayed, and closing an idle agent records no failure.

**Blocked by:** [06: Minimal review loop: reject then approve](06-minimal-review-loop-reject-then-approve.md)

**Status:** done — merged to main

- [ ] A duplicate revision notification runs the builder once (harmless replay).
- [ ] A parked agent that dies leaves its results valid; the feedback edge is dead and the decision node becomes `needs_attention`; nothing is replayed.
- [ ] A parked agent counts as completed for the shutdown hook: closing its tab records no failure. One real-Pi runtime case proves a parked agent's process ending records no failure.
- [ ] A finalize record and a revision claim race to exactly one winner, in both orders; a late revision is rejected as "node finalized"; finalize is refused while an attempt runs.
- [ ] Finalize is idempotent.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
