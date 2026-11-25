# 06: Integrity: fail closed, migrate safely, leave evidence untouched

**What to build:** Deletion can be trusted because it can neither be silently undone nor silently damage history. A damaged or contradictory deletion record makes the factory fail closed; deleting leaves the factory row, versions and receipts byte-for-byte untouched; migration to the new storage version never deletes or hides anything; and an older build refuses a database containing a deletion instead of showing the factory as active.

**Blocked by:** 01

**Status:** done — merged to feature/factory-deletion

- [x] A deletion record whose digest or shape does not verify marks the factory as damaged: every mutation is refused and reads report the damage; it is never treated as active.
- [x] After a delete, the factory row, its definition versions, inputs, attempts, receipts and run artifacts are unchanged byte-for-byte (their existing digests still verify).
- [x] Migrating a database from the previous storage version through the normal path leaves every existing factory active and unchanged, and hides nothing.
- [x] An older reader's behaviour is documented, and where it can be tested it refuses a database that contains a deletion rather than showing the factory as active.
- [x] Deleting a factory does not affect other factories in the same database.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
