# 03: Revalidate preconditions at commit time

**What to build:** Two sessions can race (a submission just as a delete is confirmed) without dropping work. After the confirmation returns, every precondition from ticket 02 is re-read inside the same fenced transaction that writes the deletion record; if anything changed, the delete fails with an "inspect again" style error. No prior `/factory stop` is required.

**Blocked by:** 02

**Status:** done — merged to feature/factory-deletion

- [x] An input admitted between the confirmation and the commit makes the delete fail and writes no deletion record.
- [x] Any other precondition that becomes true between confirmation and commit (for example a new hold, request or proposal) makes the delete fail the same way.
- [x] After a successful commit, a later submission, launch or other mutation is rejected as deleted.
- [x] Deleting a factory that was never stopped works with no extra step.
- [x] A failed delete is clearly distinguishable from a refusal and tells the operator to inspect again.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
