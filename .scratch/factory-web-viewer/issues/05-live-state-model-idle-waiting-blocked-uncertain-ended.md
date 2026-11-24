# 05: Live state model: idle, waiting, blocked, uncertain, ended

**What to build:** An operator can tell what a factory is doing when no run is live, and can trust that missing or contradictory evidence is never shown as Idle or Running.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] A selected factory's live state is one of running, ended, idle, waiting, blocked or uncertain, with a reason where known.
- [ ] Missing or inconsistent release evidence yields uncertain, not idle or running.
- [ ] A finished run's final outcome stays in the snapshot until another run starts or the factory changes, and the ended run is never reported as active.
- [ ] Run outcome, execution settlement and capacity release are reported as distinct facts; a finished outcome with a held capacity hold stays reported as held.
- [ ] Each snapshot carries a run identity and a checked-at time; a failing read returns an error response, never a fabricated snapshot.
- [ ] A known launch blocker for a factory with no released run is explained; a verified release switches the snapshot to the graph.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
