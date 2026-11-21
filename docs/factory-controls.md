# Factory stop and discard

`/factory stop <factory-id>` is an interactive, directly confirmed control. Its durable record fences new brief admission and FIFO launch reservation. The acknowledgement does not cancel a run or undo a launch that already committed its reservation boundary. Queued receipts, active runs, holds, requests, and run controls remain available. `/factory inspect <factory-id>` reports `stopped: true` and a stopped head reason without changing state.

`/factory resume <factory-id>` explicitly restores management and clears the stop. Opening or inspecting a factory does not resume it, and publishing a version does not clear the stop. Queue progression remains FIFO after resume and after an existing hold is proven settled or cleared.

`/factory discard <factory-id> <input-id>` is available only in an interactive managing session. Pi confirms the exact input, reference, queue position, bound version, and consequences. The operation revalidates current manager authority, the receipt and its queued disposition under a write transaction after confirmation. The launch reservation uses the same durable database write boundary, so whichever commits first determines eligibility. A discarded receipt remains queryable and an identical submission retry returns that historical receipt; it cannot make the input eligible again. Use a new submission reference for intentional repetition.

The persistent record is local factory storage with SQLite `synchronous=EXTRA`; damaged control evidence blocks admission and launch rather than silently resuming. Existing run cancellation, settlement, request response, and clearance operations remain available while stopped.
