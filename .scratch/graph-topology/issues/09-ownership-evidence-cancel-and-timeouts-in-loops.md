# 09: Ownership, evidence, cancel and timeouts in loops

**What to build:** Loops respect the existing cross-cutting guarantees: a loop body keeps its files to itself until it settles, a review cannot approve untested work, and cancel and timeouts behave across attempts.

**Blocked by:** [06: Minimal review loop: reject then approve](06-minimal-review-loop-reject-then-approve.md)

**Status:** ready-for-agent

- [ ] A loop body holds its write ownership from first admission until finalization; an overlapping writer waits; a body node without write paths holds nothing while parked; finalization releases ownership.
- [ ] Required checks are judged per attempt; an approval is not admitted while the builder's required checks lack passing evidence; a revision invalidates earlier evidence through the staleness rules.
- [ ] Cancel propagates through the loop body, parked agents included; `fail_fast` cancels parked agents.
- [ ] `task_timeout_ms` applies per attempt; parked agents are never diagnosed as stalled; a parked node's wait follows its decision node's progress.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
