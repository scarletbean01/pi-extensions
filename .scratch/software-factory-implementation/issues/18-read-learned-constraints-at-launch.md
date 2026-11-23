# 18: Read learned constraints at launch

**What to build:** A project keeps a file of learned constraints. Launch adds the active ones to each run's shared brief and records exactly which ones the run used, without changing any published definition version. This is a post-release extension; it does not gate [ticket 14](14-verify-and-document-in-pi-herdr.md). See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [06: Cancel a run and verify settlement](06-cancel-a-run-and-verify-settlement.md). Do not start before ticket 06 merges: both change `bootstrap/lifecycle.ts`.

**Status:** done

- [x] Define a project constraints file, for example `.pi/constraints.json`. Each entry has an id, text, provenance (run, attempt and evidence reference, or a human note) and a status of `active` or `retired`. A missing file means no constraints and no behavior change.
- [x] At launch, read the file once, validate it and inject the active constraints into the existing constraints section of the bounded shared brief. Constraints apply to the whole run, not to individual nodes. A published definition version is never modified or rebound by constraints.
- [x] Record in the run manifest the file's digest and the ids of the constraints used. Show them in run status and reports so a regression can be traced to a specific rule.
- [x] Fail closed. When the active constraints do not fit in the brief's bound, or the file is unreadable or invalid, launch does not proceed. In a factory this blocks the head with a cause naming the overflow or the defect, and nothing is truncated or dropped silently.
- [x] A run uses the constraints it read at launch. Later edits to the file do not change a run in flight, and a recovered or taken-over run keeps its recorded digest.
- [x] Cover no file, a valid file, retired entries excluded, overflow, an invalid file, an edit during a run, and standalone Bootstrap runs, which stay unchanged unless they opt in. Confirm the version binding from tickets 01 and 04 is unaffected.
