# 03: Inspect version selector and version-bound node links

**What to build:** An operator can inspect any retained definition version and follow node relationships within it without leaving the version they chose.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Selecting a retained version returns that version's definition while current-version, queue, capacity and attention fields stay current.
- [ ] Node references in dependencies, joins and feedback targets are links carrying factory, version and node, and resolve to that node's configuration in the same version.
- [ ] A verified run on `v2` linking to a node after `v3` is published resolves the node in `v2`.
- [ ] An unverifiable link target returns an explanation, never a different version's configuration.
- [ ] Read-only proof holds across version selection and link resolution.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- Test only through the viewer's HTTP snapshot API against fixture factory state directories, per the spec's Testing Decisions. Assert response bodies and unchanged state, never read-model internals.
- The viewer must never write, migrate, repair, reconcile, settle, launch or clean up; it must not fall through to generic standalone run status or widget paths.
- Reinspect current code first and preserve edits made by others.
