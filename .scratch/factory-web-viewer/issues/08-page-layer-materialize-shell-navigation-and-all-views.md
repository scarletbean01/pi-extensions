# 08: Page layer: Materialize shell, navigation and all views rendered

**What to build:** An operator can open the dashboard in a browser, switch factories and move between all seven views.

**Blocked by:** 03, 05, 06, 07

**Status:** done

- [x] Materialize and any icons or fonts are served locally, with no runtime CDN or font requests.
- [x] The Factories sidebar is persistent on desktop and a keyboard-accessible drawer on narrow screens; selecting a factory opens its Live Graph.
- [x] Factories, Live Graph, Inspect, Queue, Receipts, Requests and Proposals render from the snapshot API with semantic headings and tables, meaningful link labels, visible focus and status cues that do not rely on colour.
- [x] Accordions hide only optional detail, never the main summary or a blocker.
- [x] Switching factories never displays the previous factory's graph or data.
- [x] Verified against the manual checklist (browser behaviour is manual by decision).

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
