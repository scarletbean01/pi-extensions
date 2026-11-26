# 07: Recovery redelivery falls back to the pane

**What to build:** An operator's **Redelivery** through recovery works whether or not Coms can reach the destination. Recovery's injectable wake-up dependency tries Coms first. If Coms fails as unreachable or delivery-unknown, it uses the shared fallback module from ticket 06. The redelivery result and its next steps say which transport was used, or why neither worked. The existing recovery record that authorises the dispatcher as a sender is unchanged, and redelivery still never replays an accepted handoff.

Spec: `../spec.md` (recovery decisions; user story 32; Testing Decisions seam 3).

**Blocked by:** 06 (the sending agent falls back to a pane wake-up)

**Status:** done

- [x] Through the recovery service with its injected wake-up, redelivery to a reachable destination uses Coms and reports it.
- [x] Redelivery when Coms is unreachable or delivery-unknown uses the pane fallback and reports it.
- [x] Redelivery when the fallback is skipped (dead process, pane gone, no pane ID) reports the reason and claims nothing.
- [x] Redelivery of a claimed handoff is still refused as before.
