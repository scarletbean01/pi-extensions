# Human direction requests

## Storage
Current factory storage is SQLite `user_version = 11`. The v10 → v11 migration preserves requests, responses, and approval bindings and adds storage for exhaustion answers. Read-only commands don't migrate; workers don't run DDL. Explicitly resume or take over management to upgrade an older factory.

## Opting in
A definition opts a node in with `intervention: { choices: [{ choice_id, label }...], required?: [choice_id...] }`. Publication validates it and names the node and setting on failure; inspection shows it under `node_policies.<node>.intervention`. Only a factory-managed run's worker receives the `bootstrap_request_direction` tool, and the factory re-validates the node's opt-in against the attempt's bound definition version, never against what the worker claims.

## Asking (`bootstrap_request_direction`)
An admitted, released, still-working attempt gives a question, reason, optional evidence or references, a nonempty subset of its plan choices (every `required` choice included) and an optional recommendation among the presented choices. Factory, input, run, node, attempt and request identity are checked against the durable attempt record. At most one request per attempt is pending; another is possible once the first has a response. There is no unsolicited choice and no agent withdrawal. The tool call itself waits with no deadline of its own, and the waiting boundary is read from factory storage, not memory: while this node attempt has a pending request, or an answered one not yet consumed or terminated, every other tool (including `bootstrap_complete`) is blocked, even after an aborted wait. Calling `bootstrap_request_direction` again re-attaches to the open request. The attempt keeps its factory and checkout capacity. Silence is never consent or decline.

## Answering (`/factory respond <factory-id> <request-id>`)
The managing Pi session is alerted when a request appears, `/factory requests <factory-id>` lists every request with durable state, and `inspect` returns `requests` and lists pending ones under `attention`, so a missed alert hides nothing. A person selects one presented choice or explicitly declines, optionally adding guidance; guidance alone is not a response. A decline permits only work the assignment and plan already authorize. Only the current managing session's authority can respond; the agent has no tool to answer. The response is recorded once: an identical retry returns the saved outcome and a changed response is rejected. The responder is recorded as the manager session identity.

## Recorded versus consumed
`response_recorded` is the manager's saved answer. The waiting attempt records its consumption claim before its tool call returns, so a duplicate wake cannot start a turn. `route_binding`, `verdict`, and `admissions` are separate: selecting a routing choice does not record a verdict, and a verdict doesn't prove that a destination started.

## Routing a bounded revision
At a decision node, a plan choice can set `route: "approve"` or `route: "reject"`. A rejection choice binds the attempt to the decision's declared rejection verdict. The worker supplies that verdict on completion, refuses a conflicting submission, and validates the result and evidence before routing. A successful rejection with capacity follows the existing feedback edge: the same agents revise the whole loop body in dependency order. The builder receives the review findings and any human guidance in the saved result, with references to earlier attempts. The next review attempt can ask for a new choice. Nodes outside the loop do not revise.

The selector shows the remaining loop revisions and run attempts, how many attempts the whole body needs, and `on_exhausted`. This is a preview, not a reservation. A revision choice remains selectable at zero capacity; a successful rejection then records the limit that blocked it, applies `on_exhausted`, and opens neither a forward edge nor part of a revision.

## Exhaustion requests
A rejected review stopped by a limit, or a non-successful loop that settles at a limit, appears in `/factory requests` and `inspect` as an exhaustion request. It is backed by the durable finalization rather than by a waiting worker. An approved review at the limit is not exhaustion. A pending exhaustion request does not revive work, waive checkout holds, or prevent proven settlement. Inspection never writes the answer or wakes an agent. Evidence failures are shown against the affected attempt or saved request and do not make other runs’ requests unactionable. Polling skips proven successful historical runs without saved answers and checks for a local exhaustion candidate before loading the full run.

Answer with `/factory respond <factory-id> <request-id>`:

- **Retry with a new brief:** enter a new multiline brief. The answer and a separate, normal FIFO submission are recorded in one transaction. The new input binds the current published version; it is not a replay or re-plan of the old run. A stopped factory can't accept it. The scheduler still checks FIFO and both capacity holds before launching.
- **Take over the work manually:** confirm the exact request. This records your intention to continue outside the run; it does not authorize work on an occupied checkout or take over factory management.
- **Discard the escalation:** confirm the exact request to dismiss it. This does not discard the old input, change its recorded outcome, cancel any work, or free a hold.

A repeated identical response returns the saved result. A changed choice or changed retry brief is rejected. Escalation answers have no worker consumption or wake-up stage.

## Cancellation and failure
A factory-managed loop with a dead parked agent and an unclaimed feedback edge is reported as needing attention. Read-only status does not finalize it on the dispatcher’s behalf. It stays pending until explicitly cancelled; inspection does not release its holds or revive its agents. Standalone Bootstrap status retains its existing reconciliation behaviour.

A decision with damaged approval evidence is treated as unknown and fails closed; because direction evidence is read for every completion status, the worker cannot report that decision as a failure either. Cancellation remains available through the independent cancellation path.

Cancellation commits a per-attempt fence in the same transaction as the cancel intent, so response and cancellation are ordered by one lock. If cancellation wins, pending requests close as `cancelled` and a later response is rejected. If a response wins it is kept, but it can never be consumed afterwards (`never_consumed`, `terminated`) and cannot revive the attempt. Settling a run fences the attempt the same way, with the reason taken from the run outcome (`cancelled`, `failed`, otherwise `closed`). A node that ends inside Bootstrap without success (failure or cancellation recorded by its worker) closes its own open request immediately. A worker that dies without recording anything is closed at settlement, and recovery of requests after takeover is ticket 11. A verified human wait pauses the requesting attempt and protects its dependent paths from timing out solely because of the wait. After manager takeover, only the same verified waiting invocation can receive a saved response.
