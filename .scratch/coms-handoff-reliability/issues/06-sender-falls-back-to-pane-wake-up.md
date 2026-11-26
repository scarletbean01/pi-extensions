# 06: The sending agent falls back to a pane wake-up when Coms fails

**What to build:** When an agent completes an attempt and Coms cannot deliver its handoff's wake-up, the successor still gets woken without an operator.

- **One shared fallback module.** Given the run's session directory, the destination attempt and the handoff ID, it decides whether a pane wake-up is allowed and, if so, sends the one-line wake-up from ticket 04 through the `herdr` command line (Herdr TUI only). It returns sent, skipped with a reason, or failed with a reason.
- **When a wake-up is allowed.** All of these must hold: the destination's readiness record has a pane ID, its process is alive, the offer exists and is unclaimed, and Herdr reports the pane exists. Herdr agent status (idle, working, blocked, done) is never consulted (ADR 0003).
- **Order of steps.** The completing worker keeps its order: persist the result, write the offer, send by Coms. If Coms fails as unreachable or delivery-unknown (ticket 01), it calls the fallback once before shutting down.
- **Recording the transport.** The handoff records the outcome: queued by Coms, queued by pane fallback, or failed with reason.
- **Older runs.** A run whose readiness records have no pane ID behaves exactly as before.

Spec: `../spec.md` (fallback wake-up and worker decisions; user stories 22–25, 33 and 34; Testing Decisions seams 2 and 5).

**Blocked by:** 01 (bounded sends and the delivery-unknown error), 04 (destination accepts a pane wake-up)

**Status:** done (live-suite criterion pending operator approval to run it)

- [x] With a fake `herdr` binary on `PATH`, the primary path is unchanged: Coms delivers, the fake records no injection, and the handoff records Coms as the transport.
- [x] After the destination's Coms socket is removed, the completing worker injects exactly one wake-up line into the destination's pane. Feeding that recorded line to the destination leads to the handoff being claimed. The handoff records pane fallback as the transport.
- [x] No injection happens when the destination process is dead, when the offer is already claimed, or when the pane no longer exists. The outcome is recorded as skipped with the reason.
- [x] No code path reads Herdr agent status to decide the fallback.
- [x] A run with old-format readiness records (no pane ID) delivers or fails exactly as before.
- [ ] One test in the live Herdr suite, gated as that suite already is, injects a real pane wake-up into a real worker and sees the handoff claimed.
- [x] The bootstrap README's handoff section describes the fallback and updates its note that wake-ups are faked in deterministic tests.

Review note: approved by Opus review at 2069912 (builds 8f14c4e, 85bc19c, f6a0601, 2069912). The gated live test is written but not run; its criterion stays unchecked until the operator allows the live Herdr suite. Known limitations, documented in the README and handled by ticket 07: a crashed caller's `claimed` marker needs manual removal, and a stale marker's leftover pane text can join the next wake line.

Verification note: `bootstrap/run-tests.ts runtime` passed 44/44 (including `bootstrap/runtime-pane-fallback.test.ts` 4/4). Deterministic tests passed across all 31 non-factory test files (894/894), 21/22 `factory-*` files (599/599 across `factory-*.test.ts` excluding `factory-web-viewer-materialize-guard.test.ts`), while `bootstrap/factory-web-viewer-materialize-guard.test.ts` passed 4 subtests and hung on the pre-existing `main` event-loop hang. The gated live test in `bootstrap/live-herdr.test.ts` was written but not run per instructions.
