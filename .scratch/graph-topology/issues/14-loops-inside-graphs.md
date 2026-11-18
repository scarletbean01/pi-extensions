# 14: Loops inside graphs

**What to build:** Review loops work inside graph branches: the full example plan of two parallel builder–reviewer loops joining into a merger runs end to end, and successful graph runs clean themselves up by default.

**Blocked by:** [07: Every way a loop can end](07-every-way-a-loop-can-end.md); [09: Ownership, evidence, cancel and timeouts in loops](09-ownership-evidence-cancel-and-timeouts-in-loops.md); [10: Automatic cleanup on success](10-automatic-cleanup-on-success.md); [13: Joins](13-joins.md)

**Status:** done — merged to main

- [x] The two-branch plan from `GRAPH-SPEC.md` section 3 runs end to end.
- [x] A join keeps waiting while one branch is in a revision (its edge stays pending).
- [x] An exhausted loop in one branch ends `needs_attention` and blocks the merger with a cause naming the loop.
- [x] Loops in parallel branches revise independently; nodes outside a loop body are untouched by its revisions.
- [x] Validation: loop bodies are disjoint and no body node is another loop's target.
- [x] The dry-run overlap warning says when a whole loop serializes with an overlapping parallel writer.
- [x] `cleanup: on_success` is the default for `graph`.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
