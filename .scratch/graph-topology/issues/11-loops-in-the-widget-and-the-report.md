# 11: Loops in the widget and the report

**What to build:** The orchestrator sees loops: the widget shows attempt counters, the last verdict and parked agents, and the report lists every attempt and the verdict history.

**Blocked by:** [04: Live graph widget for chain and team runs](04-live-graph-widget-for-chain-and-team-runs.md); [07: Every way a loop can end](07-every-way-a-loop-can-end.md)

**Status:** done — merged to main

- [ ] Loop-body nodes show `↺ attempt/max` and the last verdict; feedback edges are not drawn as lines; parked nodes use `⏸`.
- [ ] After an automatic cleanup the widget's last frame shows the run as succeeded and cleaned.
- [ ] `bootstrap_report` lists every attempt of looped nodes, verdict history and the cause that ended the loop.
- [ ] Snapshot test for a loop.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
