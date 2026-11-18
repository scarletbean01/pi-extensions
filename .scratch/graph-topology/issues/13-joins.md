# 13: Joins

**What to build:** A node with several inbound edges starts exactly once, only when all its parents delivered acceptable results, and receives all of them; a failed parent blocks it with every cause.

**Blocked by:** [12: Graph topology with fan-out](12-graph-topology-with-fan-out.md)

**Status:** done — merged to main

- [x] Join admission is one exclusive record listing the claimed inbound handoff IDs; parents finishing simultaneously start the join once.
- [x] `join_policy`: `all_success` (default) or `allow_partial`; per-edge dependency policy still applies.
- [x] Any dead inbound edge blocks the join (or admits it under `allow_partial` for a partial source), with causes from every dead edge.
- [x] The join waits while an edge is pending or its source needs attention.
- [x] The dependency wait runs from the latest useful progress across all upstream nodes.
- [x] `bootstrap_status` shows a join's pending and dead inbound edges.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
