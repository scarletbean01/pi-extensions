# 09: Live refresh: polling, in-place updates, stale handling and follow-next-run

**What to build:** An operator can leave the Live Graph open and watch it update without losing their place.

**Blocked by:** 08

**Status:** done

- [x] The selected factory is polled about every two seconds, including while waiting for its next run.
- [x] Refreshing the same run does not reset pan, zoom, selected node, expanded sections or keyboard focus.
- [x] The page automatically switches to the next verified run and keeps an ended run's outcome visible until then or until the factory changes.
- [x] A failed refresh keeps the last good snapshot for the selected factory labelled Stale with its last successful check time; recovery clears it; stale is visibly different from a fresh read reporting uncertainty.
- [x] Verified against the manual checklist, including scenario 3 (lost connection during a run).

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
