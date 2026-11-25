# 01: Delete an idle factory and see it marked deleted

**What to build:** An operator can run `/factory delete <factory>` on a factory that has never received an input and see it retired: the first end-to-end path from command to durable record to `inspect`. This ticket adds the deletion record (a new `factory_deletions` table with a storage schema version bump, holding time and managing-session identity under a record digest) and a `delete` action on the factory operations entry point shaped like `discard`. Its only precondition is the conservative stand-in "the factory has no inputs at all"; ticket 02 replaces that with the real precondition set.

**Blocked by:** None (can start immediately)

**Status:** done — merged to feature/factory-deletion

- [x] `/factory delete <factory>` accepts a name or UUID, resolved once to the UUID, and works only from the live managing session; an unmanaged factory is refused with a message pointing at `resume` / `takeover`.
- [x] It is refused inside Bootstrap worker sessions and no agent-facing tool for deleting exists.
- [x] The prompt shows the factory name and UUID, states that deletion is permanent and what is kept (evidence, versions, receipts; name stays reserved), and requires typing the factory name; the confirmation binds to the UUID.
- [x] Declining the confirmation changes nothing and writes no record.
- [x] A confirmed delete of an input-less factory writes the deletion record and `inspect` then reports it as deleted, with when and by which managing session.
- [x] Deleting an already deleted factory says so plainly and changes nothing.
- [x] The factory row, versions and every other existing record are untouched.
- [x] Opening an older database migrates it to the new storage version through the normal explicit path only.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
