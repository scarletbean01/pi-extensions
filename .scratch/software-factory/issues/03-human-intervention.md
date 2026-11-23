# Define dynamic human intervention

Type: grilling
Status: resolved
Assignee: deplague
Blocked by: none

## Question

When and how may an enabled agent request human direction, what context and plan-defined choices does the human receive, and what do response, decline, cancellation and absence mean? Establish the user experience in Pi/Herdr and distinguish an optional opportunity to ask from an optional response. Consider future interfaces without requiring a web wrapper.

## Answer

- **Permission and timing.** The graph author enables intervention for particular nodes. An enabled agent may request human direction dynamically at any point in its assignment, but need not ask. A new request originates from the agent, not from an unsolicited human routing instruction; existing run controls remain separate. An attempt has at most one pending request at a time and may ask again after resolution when it needs a new decision.
- **Request and context.** The agent supplies a concise question, why direction is needed, relevant evidence or artifact references, and optionally a recommendation. The request identifies the factory, input, run, node and stable request ID. It presents a nonempty subset of applicable plan-defined choices; the agent cannot invent or change choices, and the plan may require particular choices to be presented.
- **Human response.** In the managing Pi/Herdr session, the person explicitly selects a presented choice or declines to direct, optionally adding free-text guidance to either. Text alone is not a response or a routing choice. A selected choice is authoritative for its plan-defined outcome: the agent cannot silently substitute another choice based on guidance. Conflicting or unsafe guidance must be surfaced, not silently overridden. A decline is neither a choice nor approval: the agent may proceed only within its assignment and plan; otherwise it reports that it cannot proceed.
- **Waiting and absence.** Once requested, the requesting attempt waits for a response or termination. Silence is neither consent nor decline; the request remains pending indefinitely by default. Human waiting must not consume the requesting attempt's execution timeout or cause direct or transitive dependants, including joins, to time out solely because of the wait. Independent work retains its own deadlines and may continue, as may later factory inputs, subject to applicable capacity and safety constraints.
- **Visibility and access.** New requests are prominently surfaced in the managing session and remain discoverable in a list that distinguishes pending, resolved, cancelled and uncertain requests. Anyone with access to that session may respond in the initial version; record actor information only where reliably available, without inventing a verified identity. The underlying request/response boundary should accommodate future interfaces, without requiring a web wrapper.
- **Durability and retries.** Persist the request and its resolution. Retrying the same response for the same request returns the recorded outcome; a conflicting response is rejected. Acknowledgement means the response was recorded, not that the agent consumed it or routing succeeded. Preserve the request and any response as evidence if a manager or worker disappears; never automatically replay an attempt with uncertain execution merely because a response exists.
- **Termination and races.** The agent cannot withdraw a pending request in the initial version. Cancellation or execution failure can terminate it. A response racing cancellation is settled durably: the response is accepted before cancellation takes effect, or cancellation closes the request and the response is rejected. An accepted response does not prevent subsequent cancellation or guarantee execution. If the attempt can no longer resume, the request is non-actionable; if that ability is uncertain, surface the uncertainty rather than promise delivery. No response revives a cancelled or dead attempt.

## Boundaries for later decisions

- [Define human-directed graph routing](04-directed-routing.md) decides how choices enforce continue, completion or bounded revision, and how conflicts or inability to proceed affect the run; free text alone never determines a route.
- [Define durability and recovery guarantees](07-recovery.md) decides reconciliation across manager, worker and host interruptions, including response consumption and uncertain execution; do not infer that an answer was consumed or replay uncertain work.
- [Define factory operation and visibility](08-observability.md) owns detailed request presentation, notification and controls. [Decide concurrency and side-effect isolation](05-concurrency-isolation.md) owns capacity and shared-side-effect safety.
- Current Bootstrap has no dedicated durable human-request protocol or human-wait deadline exemption; ordinary user controls and existing handoff recovery are not equivalent. The build specification must account for this change.
