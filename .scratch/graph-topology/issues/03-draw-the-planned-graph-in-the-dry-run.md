# 03: Draw the planned graph in the dry run (chain, team)

**What to build:** The dry-run plan of `bootstrap_generate` shows the plan as a box-drawing graph instead of the `a → b → c` link text, drawn by a pure, deterministic renderer that later also drives the live widget.

**Blocked by:** [02: Represent every plan internally as nodes with inbound edges](02-represent-every-plan-internally-as-nodes-with-inbound-edges.md)

**Status:** done — merged to main

- [x] A pure `renderGraph(model, width, theme)` lays nodes out left to right by longest path from the roots, parallel chains as lanes, barycenter row ordering, deterministic.
- [x] Dry-run output for chain and team uses it, without status colours.
- [x] Narrow widths fall back to a vertical form, one level per row; labels truncate; `+N more` above a height cap.
- [x] Snapshot tests: a chain, a team, the narrow-width fallback.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
