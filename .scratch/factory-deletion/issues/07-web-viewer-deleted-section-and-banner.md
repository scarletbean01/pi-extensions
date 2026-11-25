# 07: Web viewer: the "Deleted" section and banner

**What to build:** An operator looking at the read-only web viewer sees the same picture as `/factory list`: active factories in the main list, deleted ones in a separate collapsed "Deleted" section whose pages still load, marked with a banner and the deletion time, and whose Live Graph never looks active. The viewer stays strictly read-only.

**Blocked by:** 01, 05

**Status:** ready-for-agent

- [ ] The viewer's factory list keeps deleted factories out of the main list and returns them in a separate "Deleted" group.
- [ ] The sidebar shows a collapsed "Deleted" section.
- [ ] A deleted factory's Inspect, Queue, Receipts, Requests and Proposals pages load as usual.
- [ ] Those pages show a visible "deleted" banner with the deletion time.
- [ ] A deleted factory's Live Graph does not imply activity (never idle, waiting or running).
- [ ] The viewer's unchanged-state proof still holds: it writes, migrates and repairs nothing when reading deletion state, including with no managing session.
- [ ] A damaged deletion record is shown as uncertain/damaged, never as an active factory.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
