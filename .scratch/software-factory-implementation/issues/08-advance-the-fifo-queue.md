# 08: Advance the FIFO queue without skipping the head

**What to build:** The managing Pi session can keep accepting briefs while busy and start the next eligible one automatically when capacity is safe. The operator can see and correct a blocked head, stop new work, and explicitly resume without cancelling runs. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [04: Publish changes without rebinding accepted work](04-publish-without-rebinding-work.md); [07: Clear an uncertain capacity hold](07-clear-an-uncertain-capacity-hold.md).

**Status:** done

- [x] Schedule in durable acceptance order, including after explicit resume and after proven settlement without tab closure. Do not pass a head that has a preflight failure, an uncertain hold or an attempt awaiting confirmed retry. Never overlap factory runs against the same checkout.
- [x] Give Pi a compact live summary and read-only drill-down to queue, receipt, run and recovery evidence. Show management state, current/bound versions, active run and why the head waits: inactive manager, own slot, another factory's checkout hold, preflight/version block or uncertainty. Identify the blocking record where known; later entries wait behind the head. Surface failed runs, blocked heads and uncertain holds without relying on alerts as the record.
- [x] Stop prevents new admissions and launch attempts once acknowledged, without undoing an attempt that already crossed its start boundary. Keep queued inputs, running work, capacity holds, and access to run controls and actionable requests. Opening or publishing never resumes the factory.
- [x] Permit discard only before launch begins, with direct human confirmation and eligibility rechecked at commit. Preserve the discarded receipt and prevent an identical retry from reviving it. Editing an unstarted brief means discarding it and submitting a fresh one.
- [x] Test queue order with multiple accepted inputs and an active run; blocked-head visibility; stop versus launch start; discard versus launch start; and progression after explicit resume, proven settlement or clearance. Show that ordinary inspection changes none of those states.
