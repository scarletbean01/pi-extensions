# 17: Gate approval by risk lane

**What to build:** A project can sort changes into contained, wide and closed lanes by path, derived deterministically, so that the cost of being wrong, not a model's confidence, decides when a person must approve. This is a post-release extension; it does not gate [ticket 14](14-verify-and-document-in-pi-herdr.md). See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [12: Bind human approval to a valid decision result](12-bind-human-approval-to-a-valid-result.md).

**Status:** ready-for-agent

- [ ] Add lane settings in `.pi/bootstrap.json`: path globs for the contained lane and for the closed lane. Lanes are off when no globs are configured, and existing flows behave unchanged. A model never assigns a lane.
- [ ] When lanes are configured, derive each decision attempt's lane from the paths changed by the loop body, using the existing evidence snapshots. The most restrictive lane any changed path falls into wins. A path that matches no glob is in the wide lane, never the contained lane. An unknown change scope is treated as wide at minimum.
- [ ] Contained: the existing reviewer approval is enough. Wide: approval routes only with the declared required checks passing and current. Closed: an approve verdict cannot route until a recorded human choice (ticket 12) exists for that attempt, even when the reviewer approves and every check passes.
- [ ] A closed-lane attempt whose decision node is not intervention-enabled does not route. It settles with a blocked cause naming the lane and the matching path, and does not silently fall back to the wide lane. Planning warns when lanes are configured and a decision node that could touch a closed path is not intervention-enabled.
- [ ] Show the derived lane, the paths that decided it and what it requires in the decision, request and report views.
- [ ] Cover each lane, a mixed change, an unmatched path, an unknown scope, lanes off, and a closed lane with the reviewer approving and no human choice recorded. Confirm that a human approval in a closed lane still cannot bypass contracts, checks or artifact integrity.
