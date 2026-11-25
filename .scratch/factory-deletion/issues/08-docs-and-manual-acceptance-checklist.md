# 08: Docs and manual acceptance checklist

**What to build:** An operator can learn to delete a factory from the guide, and a person can verify the parts tests deliberately skip. Update the factory guide and viewer doc, and add a manual acceptance checklist covering the typed-name prompt and the viewer.

**Blocked by:** 02, 03, 04, 05, 06, 07

**Status:** ready-for-agent

- [ ] `docs/factory-guide.md` documents `/factory delete`, the full refusal list, no force option, that nothing is purged, the reserved name, no undelete, and `/factory list --all`.
- [ ] The web viewer doc documents the Deleted section, banner and absence of activity state.
- [ ] The docs state the older-build behaviour and the storage version bump.
- [ ] `GLOSSARY.md` and ADR 0002 match the shipped behaviour.
- [ ] A manual checklist covers: the typed-name prompt (wrong name, correct name, decline), the unmanaged and worker-session refusals, and the viewer's Deleted section in a browser.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
