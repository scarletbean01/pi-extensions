# 15: Fan-out and joins in the widget and dry run

**What to build:** The live widget and dry-run picture draw fan-out and joins, with edges styled by edge state so a waiting join shows which branch it waits on.

**Blocked by:** [04: Live graph widget for chain and team runs](04-live-graph-widget-for-chain-and-team-runs.md); [13: Joins](13-joins.md)

**Status:** done — merged to main

- [ ] Edges: solid `──▶` fired, dim `╌╌▶` pending, a marked cut for dead, using the shared edge-state function.
- [ ] Fan-out and joins drawn as lanes merging, as in the spec's example.
- [ ] Snapshot tests: a diamond, and parallel chains with a join.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
