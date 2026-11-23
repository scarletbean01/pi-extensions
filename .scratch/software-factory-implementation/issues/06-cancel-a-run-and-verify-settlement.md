# 06: Cancel a run and verify settlement

**What to build:** The managing operator can cancel a factory run, inspect what has actually stopped, and see when the checkout becomes available again. Closing tabs is a distinct action and never substitutes for settlement. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [03: Launch the first input safely](03-launch-the-first-input-safely.md).

**Status:** done — merged to feature/software-factory

- [x] Cancelling factory-managed work requires direct human confirmation bound to the exact target and consequences; recheck management authority and eligibility when committing. Structured tools can prepare actions but cannot confirm them. Existing run controls cannot bypass this boundary, including through force-close or cleanup that changes execution state.
- [x] Persist and display cancellation intent, resource closure, execution settlement and capacity release as distinct observations. Record a failed run as outstanding attention. Preserve unknown or contradictory evidence rather than assuming settlement.
  - Note: factory inspection never queries Herdr, so resource closure reads "closed" only when the run's own record says so, otherwise "unknown"; a tab closed from outside is not seen.
- [x] On the execution-settlement path, automatically release both holds only on reliable evidence no original attempt, revision or in-flight tool can still act. Pre-release reconciliation belongs to the takeover and launch retry ticket. A normal completed run can free capacity while tabs are still open. Cancellation, tab loss, stale heartbeats or reboot alone do not free capacity; suspected detached or remote work keeps the hold until it is stopped or isolated.
- [x] Retain reports and authoritative evidence after ordinary or automatic cleanup. Factory inspection has no cleanup side effect; standalone inspection and controls retain their existing behavior. Only the same demonstrably unclaimed handoff may be redelivered under factory authority to a verified live destination, never replayed or recreated.
  - Note: redelivery is `/factory redeliver`, reusing the existing retry_delivery evidence rules (offer unclaimed, destination live).
- [x] Verify ordinary settlement, cancellation during in-flight work, parked or revising nodes, tab closure without settlement, and interruption at the settlement commit. Use separate observations to show what happened, rather than inferring safety from a resource or outcome label.
