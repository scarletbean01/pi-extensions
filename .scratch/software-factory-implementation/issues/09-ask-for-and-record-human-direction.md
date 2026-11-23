# 09: Ask for and record human direction

**What to build:** An intervention-enabled agent can ask a human for direction during its assignment. A person sees the request in managing Pi and selects an offered non-routing choice or explicitly declines; the same live attempt can then continue within its assignment. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [06: Cancel a run and verify settlement](06-cancel-a-run-and-verify-settlement.md).

**Status:** done — merged to feature/software-factory

- [x] Only an enabled, admitted attempt may create a request. Validate factory, input, run, node, attempt and request identity; allow at most one pending request per attempt and validate the applicable and required plan choices. No unsolicited choice or agent withdrawal.
- [x] Persist the question, reason, evidence or references, presented choices and optional recommendation. Alert the managing session and keep a discoverable request list with durable state; missing an alert does not hide a request. Record actor identity only where reliably available.
- [x] While requesting, the attempt cannot continue ordinary work. Silence is indefinite waiting, not consent or decline. Keep ownership and factory capacity. A human selects an offered choice or explicitly declines, optionally adding guidance; free text alone is not a response. A decline permits only work already authorized by the assignment and plan.
- [x] Record the response once; identical retry returns the saved outcome, changed response conflicts. Reject agent-supplied responses and non-manager mutations. Record a consumption claim before ordinary work can continue; duplicate notifications cannot start another turn.
- [x] Order response and cancellation durably in both race orders. Cancellation or failure can terminate a request; an accepted response does not prevent later cancellation or revive a dead attempt. Distinguish response recorded from response consumed in Pi and structured inspection.
