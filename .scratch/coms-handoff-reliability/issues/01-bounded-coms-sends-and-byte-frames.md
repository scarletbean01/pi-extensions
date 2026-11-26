# 01: Bounded Coms sends and byte-measured frames

**What to build:** Every Coms send (prompts, end-of-turn replies, pings) gives up after a bounded wait covering connection and acknowledgement. The wait is 5 s by default and can be overridden by a new Coms acknowledgement-timeout environment variable. On expiry the socket is destroyed and the send fails with a "delivery unknown" error. Callers (including bootstrap) can tell it apart from a refusal (nack) and from "unreachable" (no live agent, or connection refused). Both the client and server line readers count received UTF-8 bytes, not characters, against one shared cap raised to 256 KiB. An oversized frame is refused with a clear error, never cut. Name resolution and all other Coms behaviour are unchanged.

Spec: `../spec.md` (Coms implementation decisions; user stories 11–18).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A peer that accepts the connection but never acknowledges makes `coms_send` fail within the timeout with the delivery-unknown error. A real-process runtime test uses a raw socket peer.
- [x] The timeout is overridable by environment variable, and a test uses a short value.
- [x] Refusal, unreachable and delivery-unknown are distinguishable to a caller of `coms_send`, by error type or by a stable message prefix that is documented.
- [x] The end-of-turn reply send is bounded the same way. A stuck original sender does not stall the replying agent.
- [x] A frame with multibyte (non-ASCII) content just under 256 KiB in bytes is delivered, and one just over is refused with a clear error, on both reading sides.
- [x] A handoff notification carrying a 40 KB non-ASCII predecessor preview is delivered.
- [x] Existing Coms and bootstrap test suites show no regressions: runtime 30/30; deterministic 1475 passed, with one PID-reaping sandbox hang reproduced on main.
- [x] The bootstrap README's delivery section mentions the bounded send and the delivery-unknown outcome.

Verification note: the deterministic suite hit its 180 s limit at `factory-web-viewer-materialize-guard.test.ts`; running that unchanged test on main also passed its four subtests and then hung until the 80 s timeout. Follow-up review coverage also verifies that close-without-ack, malformed ack and oversized client-side ack responses report delivery unknown, and that an acknowledgement timeout above Node's timer limit is clamped.
