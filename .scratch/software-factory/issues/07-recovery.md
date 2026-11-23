# Define durability and recovery guarantees

Type: grilling
Status: resolved
Assignee: pi
Blocked by: 01, 02, 03, 04, 05, 06

## Question

What durable records and recovery outcomes are required for queued inputs, active runs and pending human requests across Pi, Herdr and host restarts? Distinguish safe resumption from uncertain side effects and explicit operator decisions. Reconcile this with existing Bootstrap handoff, cancellation and recovery semantics. Under [Decide concurrency and side-effect isolation](05-concurrency-isolation.md), determine how takeover preserves factory and checkout capacity, what evidence allows release, and how an operator explicitly clears an uncertain hold without replaying work.

Under [Define factory definition changes](06-versioning.md), determine how interrupted publication, acceptance and launch preserve the last committed current version, each input's original version, and the distinction between a known pre-launch block and an uncertain launch.

## Answer

### Durable records and ownership

- **Durable records, not durable execution.** On one host with intact, non-rolled-back local storage, acknowledged records survive Pi and Herdr crashes, OS crashes and ordinary reboot. A publication makes a complete immutable definition current as one commit. Admission commits the brief, submission reference, FIFO position and then-current version together. A lost acknowledgement is checked by the same submission reference; an uncertain write is not a rejection. Keep definition versions, input and discard receipts, launch associations, intervention records, and the authoritative evidence for cancellation, settlement and clearance. No automatic pruning of that evidence or destructive Bootstrap cleanup that would remove it. Storage exhaustion must not silently discard accepted work.
- **Explicit takeover.** A new session only manages the factory after explicit resume or takeover. It must establish exclusive authority and prevent a stale manager from committing or launching after takeover. Account for reboot and process identity; heartbeat age alone cannot establish ownership. All local factories targeting the same checkout must use one coordination authority for that checkout, even if they use different workspaces or state directories. Preserve both factory and checkout holds across stop, manager loss and reboot; takeover neither releases the holds nor cancels live runs.
- **Fail closed on damaged evidence.** If missing, unreadable or contradictory authoritative records prevent safe reconciliation, preserve the remaining evidence and block affected operations. An ordinary resume never guesses, overwrites evidence or treats an uncertain reservation as free. Cross-host takeover, disk-loss recovery, corruption repair and restoring backups are not guarantees of this release.

### Launch reconciliation

- Record a launch attempt, its stable Bootstrap `request_id` and both capacity holds before initiating launch. Reconcile that exact request and its associated run without starting work or re-resolving the bound definition. Commit evidence that execution **may start** before any agent can act on release; a missing release marker or an `interrupted` label is not proof that execution never started. Evidence of possible execution without reliable settlement keeps both holds.
- On explicit resume, process FIFO inputs whose launch is known not to have begun. A validation or compatibility problem known to occur before launch blocks the head input without changing its bound version. For a launch attempt already begun, allow a fresh attempt only by explicit operator retry after durable evidence establishes that the old attempt never released execution and can no longer release. Preserve its history; assign the new attempt a new `request_id` while retaining the input, version and FIFO position. Do not relaunch an input that may already have executed. Intentionally repeating that work after clearance requires a new submission.

### Live runs, intervention and capacity release

- Surviving agents may continue under the existing agent-driven protocol. Do not recreate agents or replay their work after agent, Herdr or host failure. Existing handoff recovery only redelivers the same demonstrably unclaimed handoff to a verified live destination. Any record that authorizes further work must protect that decision across a crash; neither missing evidence nor a notification acknowledgement authorizes replay.
- After takeover, an existing pending intervention request remains actionable under the same request ID only if the original attempt is verified able to continue. Preserve unknown or terminated requests as evidence. Record a response once, subject to the durable response-versus-cancellation ordering. Recovery may repeat a wake-up about the same response to the same verified waiting attempt, not the permission to continue. If it is unclear whether the attempt already continued, surface the uncertainty rather than restart its turn. Recording a response, consuming it, recording a verdict and admitting a successor are separate facts.
- Release capacity automatically only when non-release is established and the old launch cannot release, or when execution is known to have settled and no original attempt, revision or in-flight tool can still act on the checkout. Tab cleanup is not required for settled execution. Cancellation remains durable intent, not proof of termination; a cancelled disposition, closed tab or reboot is insufficient on its own. Known or suspected detached or remote work that could still conflict must stop or be isolated. The factory cannot guarantee that arbitrary tools left no undisclosed background work or promise exactly-once external effects.
- **Operator clearance** is an explicit decision after inspection. Record the reason, supporting evidence and acknowledgement of residual uncertainty about past effects. Do not permit it while the original launch or agents might still resume conflicting work. A committed clearance retires that input from launch eligibility and releases the holds without changing the historical run outcome, undoing effects or replaying work.

## Evidence and follow-through

- [Bootstrap launch and reconciliation](../../../bootstrap/lifecycle.ts#L1162) publish a release marker an agent can immediately observe, then update the manifest. The current reconciler treats a missing, unreadable or mismatched marker as an interrupted pre-release launch. [Atomic writes](../../../bootstrap/session-store.ts#L301) are not synced to disk. Neither that reconciliation nor reissuing `bootstrap_generate` is a safe substitute for the factory's durable release boundary and read-only launch lookup.
- [Bootstrap handoff recovery](../../../bootstrap/README.md#recovering-interrupted-handoff-delivery) repairs delivery, not execution. [Cancellation and cleanup](../../../bootstrap/README.md#upgrade-rollback-and-operator-playbook) distinguish cancellation intent, in-flight effects and resource closure.
- The build specification must cover crashes before and after release, lost acknowledgements, competing managers, and checkout holds during cancellation and clearance. [Define factory operation and visibility](08-observability.md) owns how operators inspect that evidence and invoke the permitted actions.
