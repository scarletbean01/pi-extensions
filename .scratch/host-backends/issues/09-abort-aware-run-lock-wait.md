# 09: Abort-aware run lock wait

**What to build:** A cancelled bootstrap call stops waiting on a contended run lock immediately instead of up to 15 minutes later.

- The run lock accepts a cancellation signal. Both its in-process queue wait and its polling sleep race the signal, using the abortable delay helper that already exists beside it.
- On cancellation the call rejects with the existing cancellation error and never creates, breaks or removes lock or break files it does not hold.
- Callers that have a signal pass it through. The tool description that says cancellation waits for the lock is updated.

Spec: `../spec.md` (hygiene).

**Blocked by:** the `coms-handoff-reliability` work merged to `main`.

**Status:** done

- [x] With the lock held by another party, cancelling the caller makes it return the cancellation error promptly (tested with a short wait budget).
- [x] A cancelled waiter leaves the lock and any break files exactly as it found them.
- [x] A waiter that is not cancelled still acquires the lock once it is released; existing lock tests pass.
- [x] The documentation and tool description are updated.
