# 05: List `--all` and a reserved name

**What to build:** Deleted factories drop out of day-to-day lists but are never lost, and their names never mean two things. `/factory list` hides deleted factories by default, `--all` shows them marked as deleted, and publishing a name held by a deleted factory is rejected with a message that points at it.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `/factory list` omits deleted factories by default.
- [ ] `/factory list --all` includes them, each clearly marked as deleted.
- [ ] `/factory publish` with the name of a deleted factory is rejected with a message naming the deleted factory (id and deletion time), instead of the generic duplicate error.
- [ ] The reservation is case-insensitive, like today's name uniqueness.
- [ ] Tab completion offers deleted factories only for read-only commands and where `--all` applies, not for mutating commands.
- [ ] Name or id resolution still finds a deleted factory for read-only commands.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
