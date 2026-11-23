# Define human-directed graph routing

Type: grilling
Status: resolved
Assignee: deplague
Blocked by: 03

## Question

How do plan-defined human choices direct a run to continue, complete or request revision of previous work? Evaluate existing bounded decision nodes and feedback edges first, including whether human-requested revision fits their attempt limits, result contracts and finalization. Identify any necessary extension without assuming arbitrary graph jumps.

## Answer

- **Reuse decision nodes.** In the initial version, only an intervention-enabled decision node can offer routing choices. The plan maps those choices to its existing approval or rejection verdict. Other intervention-enabled nodes may ask for direction within their assignments, but cannot change graph edges. No arbitrary jumps, conditional skipping of required work, or new scheduler are needed.
- **Continue and complete are both approval.** Approval finalizes the loop and fires its declared forward edges, subject to normal successor admission. At a decision node with no successors, approval finishes that branch. It completes the run only if the normal whole-run settlement rules are met; independent work is neither stopped nor counted as successful. Cancellation remains a separate control.
- **One binding route per attempt.** A selected routing choice binds the requesting attempt. Later requests in that attempt can clarify guidance but cannot replace the choice. A new review attempt may ask and receive a fresh choice. If the agent never asks, or the human explicitly declines, the agent may submit its own verdict where the plan permits; decline is not approval, and silence keeps the request pending, as decided in [Define dynamic human intervention](03-human-intervention.md).
- **Bootstrap supplies and validates the verdict.** When the agent submits a result after a human selects a route, Bootstrap fills the verdict field from the recorded response. If the agent supplies a conflicting verdict, reject the submission and surface the mismatch rather than silently replacing it. Only a valid `success` result routes. A human choice does not waive the assignment, output contract, artifact integrity, required checks, or successor admission. If guidance conflicts with the plan or the chosen route cannot be honored, surface the problem; correct it within the assignment when possible, otherwise report a non-success outcome without taking either route. Keep the response as evidence independently of the result.
- **Revision uses the existing feedback edge.** Rejection requests another attempt of the entire declared loop body on the same live agents, in dependency order, under the existing loop and run attempt limits. Feedback carries the review findings and any human guidance alongside references to earlier results; it does not change the assignment or plan limits. If the plan offers Request revision, keep it selectable even when the budget is known to be exhausted, and show that consequence before selection. If the budget is exhausted when rejection is applied, finalize under `on_exhausted` (`needs_attention` by default, or `failed`), keep forward edges closed, and record whether the loop limit or run budget prevented revision. Do not substitute approval or start a partial iteration.

## Follow-through

- Existing verdict routing, feedback reservations, and finalization live in [`bootstrap/review-loop.ts`](../../../bootstrap/review-loop.ts); result validation and completion are in [`bootstrap/worker.ts`](../../../bootstrap/worker.ts). The new behavior is the runtime-enforced binding from a recorded human choice to the attempt verdict, not a new execution topology. The managing session records the response; agents still drive graph execution as in [Agents drive graph execution](../../../docs/adr/0001-agents-drive-graph-execution.md).
- [Define durability and recovery guarantees](07-recovery.md) owns reconciliation of an accepted response, its application to a result, and any subsequent handoff. A recorded response alone proves neither completion nor downstream execution. [Define factory operation and visibility](08-observability.md) owns how those stages and budget consequences are shown.
