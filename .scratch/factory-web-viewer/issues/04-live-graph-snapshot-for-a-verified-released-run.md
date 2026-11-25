# 04: Live Graph snapshot for a verified released run

**What to build:** An operator can see the nodes, edges, joins and feedback edges of the run that actually launched for the selected factory, with per-node status and details.

**Blocked by:** 02

**Status:** done

- [x] The snapshot draws topology from the verified released run's bound version, shows bound and current versions separately, and distinguishes dependency edges, joins and feedback edges.
- [x] Each node carries status text and, where evidence provides one, a reason for waiting, blocked or uncertain; selecting a node yields details of its current attempt and a reference to its configuration at the bound version.
- [x] A reserved or failed-before-release launch yields no graph.
- [x] Graph reads verify the factory binding and release for the selected factory and never use generic standalone run status or widget paths; a test proves an eligible standalone run is not repaired or cleaned up by viewing.
- [x] A snapshot for one factory is never returned for another.
- [x] Read-only proof holds.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
