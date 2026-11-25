# 04: A deleted factory refuses every mutation but stays readable

**What to build:** Once deleted, a factory is closed for changes but open for questions. One shared guard turns every mutating action on a deleted factory into a clear "this factory is deleted" refusal, the launch watcher takes no action on it, and every read-only view and the `factory_inspect` tool keep working by id or by name.

**Blocked by:** 01

**Status:** done — merged to feature/factory-deletion

- [x] Each mutating action is refused with a "this factory is deleted" error: `update`, `restore`, `resume`, `takeover`, `stop`, `discard`, `submit`, `launch`, `retry`, `cancel`, `settle`, `clear`, `redeliver`, `respond`, `wake`, and the proposal commands (`review-proposal`, `retire-constraint`, `resolve-conflict`).
- [x] The periodic launch watcher takes no action on a deleted factory: it never launches or settles.
- [x] `inspect`, `receipt`, `queue` and `requests` work on a deleted factory by UUID and by name, and show it as deleted.
- [x] The `factory_inspect` tool reads a deleted factory and says it is deleted.
- [x] Every retained definition version of a deleted factory is still inspectable.
- [x] The refusals leave all records unchanged.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
