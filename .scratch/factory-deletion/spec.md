# Factory deletion: retire a software factory for good

Status: ready-for-agent. Prepared 2026-11-25 from a grill-with-docs session, with the test seams confirmed with the user (the factory operations entry point and the web viewer's HTTP snapshot API). Vocabulary follows `GLOSSARY.md` (software factory, factory definition version, factory input, discarded input, stopped factory, capacity hold, run, settlement, operator clearance, direction request, intervention request, constraint proposal, **deleted factory**). The decision is recorded in ADR 0002 (deleting a factory retires it instead of purging it). Architecture follows ADR 0001: agents drive graph execution; deletion never touches a run.

## Problem Statement

An operator who is finished with a software factory has no way to say so:

- Every factory ever published stays in `/factory list` and in the web viewer's sidebar forever, mixed in with the ones still in use.
- The nearest tool is `stop`, which is reversible, keeps the factory open to submissions after a `resume`, and keeps its management and evidence fences in play. It says "paused", not "finished".
- Names are unique, so a retired experiment keeps its name taken with no way to mark it as retired.
- Receipts and the version bound to each run are the evidence operators rely on afterwards, so simply erasing a factory would be destructive and would break past receipts.

## Solution

A new `/factory delete <factory>` command that permanently **retires** a factory:

- The factory becomes a **Deleted factory**: hidden from the default `/factory list`, shown with `--all` (marked deleted), and shown in a separate collapsed "Deleted" section of the web viewer.
- Every mutating command refuses a deleted factory with a clear "this factory is deleted" error. Read-only commands (`inspect`, `receipt`, `queue`, `requests`) and the `factory_inspect` tool still work on it, by id or by name.
- Its definition versions, receipts, inputs, attempts and run artifacts are all kept. Nothing is purged.
- Its name stays reserved. Publishing a new factory with that name is rejected with a message pointing at the deleted factory.
- There is no undelete.
- Deletion is refused, with no force option, while the factory still has active or unresolved work, so it is never a shortcut around settlement, clearance, discard or review.
- It needs the live managing session, interactive human confirmation, and typing the factory name.

## User Stories

Deleting

1. As an operator, I want a `/factory delete <factory>` command, so that I can retire a factory I am finished with.
2. As an operator, I want the command to accept the factory's name or its UUID like every other `/factory` command, so that I do not have to look the id up.
3. As an operator, I want the confirmation prompt to show both the factory's name and its UUID, so that I can see exactly what I am about to retire.
4. As an operator, I want the confirmation to bind to the UUID, so that a rename or name swap cannot redirect it to another factory.
5. As an operator, I want to have to type the factory's name to confirm, so that an irreversible action is not one reflexive keypress.
6. As an operator, I want the prompt to state that deletion is permanent and cannot be undone, so that I understand the consequences before I confirm.
7. As an operator, I want the prompt to state that evidence, versions and receipts are kept and the name stays reserved, so that I know what survives.
8. As an operator, I want deleting to need the live managing session of the factory, so that two sessions cannot both act on it.
9. As an operator, I want deletion to be refused inside Bootstrap worker sessions, so that an agent cannot retire a factory.
10. As an operator, I want no agent-facing tool for deleting, so that only a person can do it.
11. As an operator, I want a clear refusal when the factory is unmanaged, saying to `resume` or `takeover` first, so that I know what to do next.
12. As an operator, I want declining the confirmation to change nothing, so that I can safely back out.

Refusals while work remains

13. As an operator, I want deletion refused while the factory holds capacity for a launch attempt or a run, so that retiring it cannot strand a hold.
14. As an operator, I want deletion refused while a run is unsettled, so that settlement still decides when its work is over.
15. As an operator, I want deletion refused while any uncertain evidence exists, so that deleting can never be a way to bypass operator clearance.
16. As an operator, I want deletion refused while a direction request or intervention request is pending, so that a waiting agent is never abandoned.
17. As an operator, I want deletion refused while a constraint proposal is pending, so that no proposal is left that nobody can review.
18. As an operator, I want deletion refused while any queued input is still eligible to launch, so that work is never dropped as a side effect.
19. As an operator, I want confirmed, rejected and dropped-duplicate proposals not to block deletion, so that finished review does not hold the factory open.
20. As an operator, I want discarded, settled and cleared inputs not to block deletion, so that history does not prevent retirement.
21. As an operator, I want the refusal to name every blocking condition at once, so that I can clear them in one pass.
22. As an operator, I want no force option, so that no flag can turn deletion into silent cancellation or discard.
23. As an operator, I want no prior `/factory stop` required, so that deletion is one step once the work is done.

Races

24. As an operator, I want every precondition revalidated at commit time in the same fenced transaction that marks the factory deleted, so that a concurrent submission cannot slip in.
25. As an operator, I want an input admitted just before the commit to make the deletion fail with a "changed during confirmation; inspect again" style error, so that nothing is dropped.
26. As an operator, I want any submission, launch or other mutation after the commit rejected as deleted, so that the factory is truly closed.
27. As an operator, I want deleting an already deleted factory to say so plainly and change nothing, so that a repeated command is harmless.

Visibility and reads

28. As an operator, I want a deleted factory left out of the default `/factory list`, so that the list shows factories still in use.
29. As an operator, I want `/factory list --all` to include deleted factories marked as deleted, so that I can still find one.
30. As an operator, I want `/factory inspect`, `receipt`, `queue` and `requests` to work on a deleted factory, so that I can still answer questions about its history.
31. As an operator, I want the `factory_inspect` tool to read a deleted factory and to say it is deleted, so that agents asked about history are told the truth.
32. As an operator, I want inspection of a deleted factory to show when it was deleted and by which managing session, so that I know who retired it and when.
33. As an operator, I want every retained version of a deleted factory still inspectable, so that I can see what a past run launched.
34. As an operator, I want a clear "this factory is deleted" error from every mutating command (`update`, `restore`, `resume`, `takeover`, `stop`, `discard`, `submit`, `launch`, `retry`, `cancel`, `settle`, `clear`, `redeliver`, `respond`, `wake` and the proposal commands), so that I know why it was refused.
35. As an operator, I want the factory's periodic launch watcher to take no action on a deleted factory, so that it never launches or settles again.
36. As an operator, I want tab completion to offer deleted factories only where `--all` is meaningful or for read-only commands, so that completion does not suggest actions that will be refused.

Names

37. As an operator, I want a deleted factory's name to stay reserved, so that a name never means two things in the history.
38. As an operator, I want `/factory publish` with a reserved name rejected with a message pointing at the deleted factory, so that I know why and which one.
39. As an operator, I want the name reservation to be case-insensitive like today's uniqueness, so that `Fusion` and `fusion` stay one name.

Web viewer

40. As an operator, I want the viewer's factory list to keep deleted factories out of the main list, so that it matches `/factory list`.
41. As an operator, I want a separate collapsed "Deleted" section in the viewer's sidebar, so that I can reach a retired factory's history.
42. As an operator, I want a deleted factory's pages (Inspect, Queue, Receipts, Requests, Proposals) to load as usual, so that the evidence stays readable.
43. As an operator, I want a visible "deleted" banner on those pages with the deletion time, so that I never mistake it for an active factory.
44. As an operator, I want a deleted factory's Live Graph not to imply activity, so that a retired factory never looks idle, waiting or running.
45. As an operator, I want the viewer to remain read-only and make no write, migration or repair when it reads deletion state, so that looking is still safe.

Storage and integrity

46. As an operator, I want the deletion recorded durably with its time and managing-session identity, protected by a digest like other control records, so that tampering is detected.
47. As an operator, I want a damaged or contradictory deletion record to make the factory fail closed (all mutations refused, reads reporting the damage), so that corruption never un-deletes anything.
48. As an operator, I want the existing factory rows, versions and receipts left byte-for-byte untouched by deletion, so that their digests and history stay valid.
49. As an operator, I want opening an older database to migrate it to the new storage version only through the normal explicit path, so that an upgrade never deletes or hides anything.
50. As an operator, I want an older build that cannot understand deletion records to refuse the database rather than show a deleted factory as active, so that a downgrade never revives one.

Documentation

51. As an operator, I want `docs/factory-guide.md` to describe delete, its refusals and `list --all`, so that I can find the procedure.
52. As an operator, I want the glossary and ADR 0002 to match the behaviour, so that vocabulary and rationale stay in sync.

## Implementation Decisions

- **Meaning.** Delete retires; it never purges. A durable deletion record is added alongside the factory's existing records. The factory's row, definition versions, inputs, attempts, holds, requests, proposals and run artifacts stay exactly as they are (ADR 0002).
- **Storage.** A new `factory_deletions` table with one row per deleted factory, keyed by factory id, holding the deletion time and the managing session's identity, with a record digest in the style of the existing control records. The factory storage schema version is bumped to add it. The existing unique, case-insensitive name constraint on the factory row is what keeps the name reserved, with no extra logic.
- **Operation.** A new `delete` action on the factory operations entry point, shaped like `discard`: it takes the factory id, the managing authority, and a `confirm(target)` callback returning a boolean. Confirmation is the caller's direct human decision, not a flag. The target shown to `confirm` carries the factory id, its name, and a plain-language consequences text.
- **Authority.** It requires the current managing session's authority (as `discard` does), and is refused in Bootstrap worker sessions like the other mutating commands. No `factory_inspect`-style agent tool exists for it.
- **Preconditions** (all must hold): no capacity hold (launch attempt or run); no unsettled run; no uncertain evidence; no pending direction or intervention request; no `pending` constraint proposal; no queued input still eligible to launch. Settled, cleared and discarded inputs, and confirmed, rejected and dropped-duplicate proposals, do not block. A refusal lists every blocking condition, not just the first.
- **Commit-time revalidation.** After `confirm` returns, the operation re-reads every precondition inside the same fenced transaction that writes the deletion record, and fails with an "inspect again" style error if anything changed. After the commit, the factory is deleted for every other operation.
- **Mutation fence.** One shared guard turns a deleted factory into a "this factory is deleted" refusal for every mutating action, including admission, launch, retry, cancel, settle, clear, redeliver, respond, wake, update, restore, resume, takeover, stop, discard and the proposal commands. Reads are not guarded. The factory watcher consults the same guard and takes no action.
- **Reads.** `inspect` and its `receipt`, `queue` and `requests` views report a deletion marker (deleted, when, by which managing session) when present. They still work by id or name.
- **Listing.** The default listing omits deleted factories. A listing option (`--all`) includes them, marked as deleted. Name or id resolution still finds a deleted factory so reads work, but suggestions for mutating commands omit it.
- **Names.** Publishing a name held by a deleted factory is refused with a message naming the deleted factory (id and deletion time), instead of the generic duplicate error.
- **Fail closed.** A deletion record whose digest or shape does not verify marks the factory as damaged: mutations are refused, reads report the damage, and nothing treats the factory as active.
- **Viewer.** The viewer's factory list reads the deletion marker through the same read path. Deleted factories go in a separate collapsed "Deleted" section. Their pages carry a "deleted" banner with the time. Their Live Graph shows no activity state. The viewer stays strictly read-only, with no write, migration or repair.
- **Command layer.** `/factory delete <factory>` is a thin interactive command. It resolves the token to a UUID once, shows name and UUID, requires the factory name to be typed, then calls the operation with a `confirm` callback that returns the result of that prompt. `/factory list` gains `--all`.
- **Docs.** `docs/factory-guide.md` gains the delete procedure, the refusal list and `list --all`. The viewer doc gains the Deleted section. `GLOSSARY.md` already holds **Deleted factory**, and ADR 0002 already records the decision.

## Testing Decisions

- **What a good test is.** Drive the system through its external behaviour only: the operation's inputs and results, the stored records the existing tests already inspect, and the viewer's HTTP snapshots. Do not assert on internal helper structure or on how the guard is wired.
- **Seam 1: the factory operations entry point** (`factoryOperations(...)({ action: ... })`). It covers: successful delete after the work is cleared; each refusal (hold, unsettled run, uncertain evidence, pending request, pending proposal, eligible queued input) alone and combined; the non-blocking history cases; decline leaves no record; commit-time race (an input admitted after confirmation makes delete fail); every mutating action refusing a deleted factory; the watcher/scheduler taking no action; reads still working by id and by name; the reserved name rejection with the deleted-factory message; `list` default versus `all`; the deletion marker on `inspect`; repeating delete; the damaged-record fail-closed path; the factory row, versions and receipts unchanged byte-for-byte; migration from the previous storage version; refusal by the previous schema's readers where testable.
- **Seam 2: the web viewer's HTTP snapshot API.** It covers: the factory list separating deleted from active factories, the Deleted section data, the deleted marker and time on the read snapshots, no activity state on a deleted factory's live snapshot, and the existing unchanged-state proof still holding (the viewer writes nothing, migrates nothing).
- **Not tested at the domain level:** the type-the-name prompt in the `/factory delete` command stays a thin UI layer. It is checked manually in the docs' acceptance checklist.
- **Prior art.** `factory-clearance.test.ts` (fixture, `factoryOperations`, manager authority, uncertain-hold setup, `confirm` callbacks), `factory-scheduler.test.ts` (discard through the operations entry point, scheduler behaviour around discarded inputs), `factory-name-queue.test.ts` (names and listing), and the `factory-web-viewer-*.test.ts` files (HTTP snapshot assertions and the unchanged-state proof).

## Out of Scope

- Purging or erasing any factory data, run artifacts, worktrees or logs.
- Undelete, restore-from-deleted, or renaming a deleted factory to free its name.
- A force option, or any way for deletion to cancel runs, settle, clear holds, discard inputs, or resolve proposals on the operator's behalf.
- A free-text deletion reason.
- Bulk deletion of several factories at once.
- Deleting a single definition version or a single input (discard already covers inputs; versions are never deleted).
- Changes to learned constraints in `.pi/constraints.json`, which belong to the project and not to a factory.
- Any agent-facing tool for deleting.

## Further Notes

- `discard` is the closest existing pattern (confirmation callback, authority check, commit-time revalidation, durable record that retains the receipt). Deletion deliberately follows it.
- Deleting does not remove anything, so disk usage is unchanged. That is a deliberate trade-off recorded in ADR 0002. If reclaiming space ever matters, it is a separate decision about an explicit, further-guarded purge of an already deleted factory.
