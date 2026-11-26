# 06: Wake-up through the Host

**What to build:** When Coms cannot deliver a handoff's wake-up, the fallback reaches a Herdr or an hc node through the Host, and never forces an agent that is blocked.

- The shared fallback module uses the Host to send the wake-up and to check the node exists. The ready record's optional pane reference becomes a backend-neutral reference, and older records read as before. The allowed-when rules are unchanged (reference present, destination process alive, offer exists and is unclaimed, the Host reports the node exists) and Host status is never consulted.
- Herdr behaves exactly as today. On hc, the send is never forced and never gated on status. A refusal because the terminal is blocked is **skipped(blocked)**, other errors are **failed(reason)**, and the offer stays on disk so Redelivery covers it.
- The destination's wake-up check accepts the bare wake-up line or exactly one wrapper around it, stripped before matching. Anything else is ignored as today, and the offer on disk stays the only authority (ADR 0003).
- If ticket 05's findings differ from these assumptions, follow the findings and say so.

Spec: `../spec.md` (the wake-up through the Host). ADR 0003 and 0004.

**Blocked by:** 03 (05 preferred, for the verified wrapper behaviour)

**Status:** done

- [x] With the fake `hc`, a Coms failure triggers one hc wake-up; a blocked terminal is skipped and not forced.
- [x] Herdr-backed wake-up tests pass unchanged.
- [x] The destination accepts the bare line and one wrapper, rejects nested, partial or extra text, and still requires the matching unclaimed offer.
- [x] Recovery redelivery reaches an hc node through the Host.
- [x] The contract document and README are updated.
