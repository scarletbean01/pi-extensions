# The handoff offer is the only authority; a wake-up is a hint

A destination decides whether to accept a handoff only from the durable handoff offer on record (run, source and destination attempts, input digest) and its own exclusive claim, never from how the wake-up reached it. So the fallback wake-up typed into a destination's Herdr pane when Coms fails carries only the handoff ID, with no HMAC or nonce: a forged wake-up can at most trigger a claim attempt that the offer check would refuse anyway, and a token would have needed a key distributed to every worker for no extra protection. For the same reason Host status is never workflow state: Herdr's status extension and hc's OSC 7501 reports (including Pi's native reports) are advisory. The fallback is gated on durable records (the destination's ready-record process alive, the offer unclaimed) plus the terminal merely existing.

## Consequences

- A Coms envelope's sender session is self-declared, so the sender check on a Coms-delivered handoff was never stronger than the offer check; a wake-up that arrives with no sender at all loses nothing real.
- Anyone who can write the run's session records can forge an offer. That is the existing shared-checkout trust gap (moving session records out of the project checkout), not something a signed wake-up would close.
