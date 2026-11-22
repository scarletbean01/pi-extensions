# Human direction requests

## Storage
Request tables are created by the factory's user_version 6 migration and retained in v7. Workers accept v6 and v7 only with both request tables present; they never run DDL.

## Opting in
A definition opts a node in with `intervention: { choices: [{ choice_id, label }...], required?: [choice_id...] }`. Publication validates it and names the node and setting on failure; inspection shows it under `node_policies.<node>.intervention`. Only a factory-managed run's worker receives the `bootstrap_request_direction` tool, and the factory re-validates the node's opt-in against the attempt's bound definition version, never against what the worker claims.

## Asking (`bootstrap_request_direction`)
An admitted, released, still-working attempt gives a question, reason, optional evidence or references, a nonempty subset of its plan choices (every `required` choice included) and an optional recommendation among the presented choices. Factory, input, run, node, attempt and request identity are checked against the durable attempt record. At most one request per attempt is pending; another is possible once the first has a response. There is no unsolicited choice and no agent withdrawal. The tool call itself waits with no deadline of its own, and the waiting boundary is read from factory storage, not memory: while this node attempt has a pending request, or an answered one not yet consumed or terminated, every other tool (including `bootstrap_complete`) is blocked, even after an aborted wait. Calling `bootstrap_request_direction` again re-attaches to the open request. The attempt keeps its factory and checkout capacity. Silence is never consent or decline.

## Answering (`/factory respond <factory-id> <request-id>`)
The managing Pi session is alerted when a request appears, `/factory requests <factory-id>` lists every request with durable state, and `inspect` returns `requests` and lists pending ones under `attention`, so a missed alert hides nothing. A person selects one presented choice or explicitly declines, optionally adding guidance; guidance alone is not a response. A decline permits only work the assignment and plan already authorize. Only the current managing session's authority can respond; the agent has no tool to answer. The response is recorded once: an identical retry returns the saved outcome and a changed response is rejected. The responder is recorded as the manager session identity.

## Recorded versus consumed
`response_recorded` is the manager's saved answer. `consumption` is `awaiting_consumption`, `consumed` or `never_consumed`: the waiting attempt records a consumption claim in the factory database before its tool call returns, so a duplicate wake-up cannot start another turn.

## Cancellation and failure
A decision with damaged approval evidence is treated as unknown and fails closed; because direction evidence is read for every completion status, the worker cannot report that decision as a failure either. Cancellation remains available through the independent cancellation path.

Cancellation commits a per-attempt fence in the same transaction as the cancel intent, so response and cancellation are ordered by one lock. If cancellation wins, pending requests close as `cancelled` and a later response is rejected. If a response wins it is kept, but it can never be consumed afterwards (`never_consumed`, `terminated`) and cannot revive the attempt. Settling a run fences the attempt the same way, with the reason taken from the run outcome (`cancelled`, `failed`, otherwise `closed`). A node that ends inside Bootstrap without success (failure or cancellation recorded by its worker) closes its own open request immediately. A worker that dies without recording anything is closed at settlement, and recovery of requests after takeover is ticket 11. Pausing the attempt's execution timeout during a wait and recovery after takeover belong to later tickets.
