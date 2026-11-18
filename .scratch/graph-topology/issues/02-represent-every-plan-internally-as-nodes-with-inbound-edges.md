# 02: Represent every plan internally as nodes with inbound edges

**What to build:** Planning and launch work from one internal model: nodes with their inbound edges. A chain becomes one inbound edge per node (the previous node), a team none. Refactor only: nothing observable changes.

**Blocked by:** None (can start immediately)

**Status:** done — merged to main

- [x] The planned model carries inbound edges per node; code that read the single predecessor link reads edges instead.
- [ ] Records, configs, manifests and fingerprints for chain and team are byte-identical to before (compatibility fixtures prove it). — NOT VERIFIED: The fixtures compare normalized pane manifests and parsed configs plus exact fingerprints, but do not pin byte identity for full manifests and records.
- [ ] Dry-run output and status text are unchanged. — NOT VERIFIED: Later tickets added a graph to dry-run output and automatic-cleanup notices to status; the compatibility test has no status-text equality assertion.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
