# 17: Release: README, release notes and full suites

**What to build:** Graphs and review loops ship documented.

**Blocked by:** [08: Parked-agent safety](08-parked-agent-safety.md); [11: Loops in the widget and the report](11-loops-in-the-widget-and-the-report.md); [15: Fan-out and joins in the widget and dry run](15-fan-out-and-joins-in-the-widget-and-dry-run.md); [16: Graph-aware cancel, recovery and report](16-graph-aware-cancel-recovery-and-report.md)

**Status:** ready-for-agent

- [ ] The README describes `graph`, decisions, limits, `cleanup` and `/bootgraph`, and no longer lists graphs and revisions as unavailable.
- [ ] Release notes and model-facing tool text use the glossary vocabulary.
- [ ] The deterministic suite and the runtime suite pass.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
