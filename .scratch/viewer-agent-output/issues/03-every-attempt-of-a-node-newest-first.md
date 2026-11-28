# 03: Every attempt of a node, newest first

**What to build:** The Attempt output section lists every attempt of the selected node in the displayed run, newest first, each in a native disclosure labelled with its attempt number and status, with only the newest open, so an operator can compare a revision with the attempt it replaced in a review loop. The response is bounded as a whole, and a Deleted factory's retained output stays readable.

Spec: `../spec.md` (user stories 3–6, 29, 30, 38; Implementation Decisions: Which attempts, Caps (20 attempts, about 64 KB per response), Typed absence for a Deleted factory and an uncertain run).

**Blocked by:** 02.

**Status:** ready-for-agent

**Delegation tier:** complex (multi-attempt result discovery across review loops, response-wide bound) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] A node with several attempts (including a review-loop revision) shows one disclosure per attempt, newest first, each labelled with its attempt number and status; only the newest is open; a node with one attempt shows one.
- [ ] At most 20 attempts per node are returned, and the response as a whole is bounded at about 64 KB; when a bound is reached, later content is cut with the same visible marker stating how much was omitted. Caps never split a surrogate pair.
- [ ] Each attempt is independently typed: an unfinished or a damaged attempt among finished ones shows its own "Not applicable" or "Evidence unavailable" without hiding the others; an attempt whose record contradicts the node's identity is never shown.
- [ ] A Deleted factory's retained attempt output remains readable like any other; an uncertain run, whose graph is already unavailable, offers no node to select and the route does not invent output for nodes it cannot verify.
- [ ] Tests cover ordering, the caps and markers, mixed finished, unfinished and damaged attempts, Deleted factory behaviour and the uncertain run, on the HTTP seam with seeded fixtures and on the DOM-harness seam (newest open, others collapsed, one click away).
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
