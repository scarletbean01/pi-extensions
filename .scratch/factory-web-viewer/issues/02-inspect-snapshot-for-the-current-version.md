# 02: Inspect snapshot for the current version

**What to build:** An operator can read a factory's Inspect snapshot: the answer to "What needs my attention?", definition and versions, node configuration as labelled fields, and an operation-and-evidence summary, with typed absence and no raw internals.

**Blocked by:** 01

**Status:** done

- [x] The attention summary covers name, management and stop state, current version, factory and checkout capacity, queue-head blocker and outstanding attention, each with an explanation rather than a bare status code.
- [x] Definition and versions shows inspected version, current version, retained versions, restore provenance, unavailable or damaged records, and what the definition does not freeze.
- [x] Node configuration shows IDs, kinds, persona and model where applicable, declared or inherited policies, dependencies, joins, decision and feedback targets, required checks and limits as labelled fields.
- [x] Operation and evidence summarises launch attempts, bound versions, admission and settlement or clearance, capacity evidence and blockers, requests, proposals and outstanding attention, with references to the relevant detail view.
- [x] `no records`, `not applicable` and `evidence unavailable` are distinguishable in the snapshot.
- [x] A damaged or unreadable record is reported as unavailable evidence and triggers no recovery, including an inspection that would need hot-journal recovery.
- [x] No raw prompts, full briefs, logs, store paths or raw internal records appear in any response; read-only proof holds.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
