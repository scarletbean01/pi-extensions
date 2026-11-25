# 10: Docs and manual acceptance checklist

**What to build:** An operator can learn how to start and use the viewer, and a reviewer has a checklist that proves the browser-only behaviour.

**Blocked by:** 09

**Status:** done

- [x] Operating documentation covers starting the viewer, what each view shows and the read-only guarantees, and the design draft is turned into or linked from it.
- [x] A manual checklist covers the five acceptance scenarios in the design doc, plus no external requests, keyboard-only use and focus preservation.
- [x] The `GLOSSARY.md` **Run graph** entry and the design doc are committed with the work.
- [x] A docs test, if the repository has one for factory docs, passes.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
