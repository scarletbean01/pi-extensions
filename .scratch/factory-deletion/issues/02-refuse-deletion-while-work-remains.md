# 02: Refuse deletion while work remains

**What to build:** Deleting can never be a shortcut around settlement, clearance, discard or review. Replace ticket 01's stand-in precondition with the full set: the factory is refused deletion while it still has active or unresolved work, and the refusal tells the operator everything that blocks it at once. There is no force option.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Delete is refused while the factory holds a capacity hold for a launch attempt or a run.
- [ ] Delete is refused while a run is unsettled.
- [ ] Delete is refused while any uncertain evidence exists (an uncertain hold is not bypassable by deleting).
- [ ] Delete is refused while a direction request or intervention request is pending.
- [ ] Delete is refused while a constraint proposal is `pending`.
- [ ] Delete is refused while any queued input is still eligible to launch.
- [ ] Settled, cleared and discarded inputs, and confirmed, rejected and dropped-duplicate proposals, do not block deletion.
- [ ] When several conditions apply, the refusal names every one of them in one message.
- [ ] No flag or option turns any refusal into a cancel, discard, clear or review; after the work is cleared the same command succeeds.
- [ ] A refused delete changes nothing and writes no record.

## Constraints

- Specification: [spec.md](../spec.md); decision: ADR 0002 (deleting a factory retires it instead of purging it); vocabulary: `GLOSSARY.md` (**Deleted factory**); architecture: ADR 0001 (agents drive graph execution; deletion never touches a run).
- Test only through the seams in the spec's Testing Decisions: the factory operations entry point, and the web viewer's HTTP snapshot API. Assert behaviour and stored results, never internal helper structure.
- Nothing is purged. Deletion adds a record; it never removes or rewrites existing factory, version, input, attempt, request, proposal or run data.
- Follow `discard` as the closest pattern (confirmation callback, manager authority, commit-time revalidation).
- Reinspect current code first and preserve edits made by others.
