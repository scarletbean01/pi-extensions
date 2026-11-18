# 04: Live graph widget for chain and team runs

**What to build:** After a successful non-dry launch, the orchestrator's session shows a live widget of the run's graph with node glyphs by execution state, refreshed from the same durable read as `bootstrap_status`.

**Blocked by:** [03: Draw the planned graph in the dry run (chain, team)](03-draw-the-planned-graph-in-the-dry-run.md)

**Status:** done — merged to main

- [ ] One widget per run, key `bootstrap-<task_id>`, registered only after a successful non-dry launch and only in the dispatcher, never in agent sessions.
- [ ] Polls the status read about every 2 s on an unref'd timer; stops once the run is terminal and keeps the last frame.
- [ ] Node glyphs: `◌` pending/waiting, `●` running with elapsed time, `✓`, `◐`, `✗`, `⊘`, `!`; header with run ID, topology, node count, outcome and elapsed time; footer with pending and error counts.
- [ ] `/bootgraph <task_id>` attaches or re-attaches (also after reload); `/bootgraph clear` removes all; `session_start` clears them.
- [ ] Without a TUI, registration is skipped silently; the widget writes no record.
- [ ] Tested through the dispatcher extension seam with a fake `ui.setWidget`.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
