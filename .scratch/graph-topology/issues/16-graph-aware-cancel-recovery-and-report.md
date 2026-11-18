# 16: Graph-aware cancel, recovery and report

**What to build:** Cancelling, recovering and reporting understand graphs and attempts.

**Blocked by:** [14: Loops inside graphs](14-loops-inside-graphs.md)

**Status:** done — merged to main

- [x] Node cancellation propagates through the dependency graph and loop bodies, parked agents included; `force_close` unchanged.
- [x] `bootstrap_recover` inspects every edge and every attempt, re-sends only handoffs demonstrably never claimed and never reconstructs results.
- [x] `bootstrap_report` lists the causes of any blocked join alongside attempt and verdict history.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
