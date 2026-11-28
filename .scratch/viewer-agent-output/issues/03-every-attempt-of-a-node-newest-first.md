# 03: Every attempt of a node, newest first

**What to build:** The Attempt output section lists every attempt of the selected node in the displayed run, newest first, each in a native disclosure labelled with its attempt number and status, with only the newest open, so an operator can compare a revision with the attempt it replaced in a review loop. The response is bounded as a whole, and a Deleted factory's retained output stays readable.

Spec: `../spec.md` (user stories 3–6, 29, 30, 38; Implementation Decisions: Which attempts, Caps (20 attempts, about 64 KB per response), Typed absence for a Deleted factory and an uncertain run).

**Blocked by:** 02.

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** complex (multi-attempt result discovery across review loops, response-wide bound) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A node with several attempts (including a review-loop revision) shows one disclosure per attempt, newest first, each labelled with its attempt number and status; only the newest is open; a node with one attempt shows one.
- [x] At most 20 attempts per node are returned, and the response as a whole is bounded at about 64 KB; when a bound is reached, later content is cut with the same visible marker stating how much was omitted. Caps never split a surrogate pair.
- [x] Each attempt is independently typed: an unfinished or a damaged attempt among finished ones shows its own "Not applicable" or "Evidence unavailable" without hiding the others; an attempt whose record contradicts the node's identity is never shown.
- [x] A Deleted factory's retained attempt output remains readable like any other; an uncertain run, whose graph is already unavailable, offers no node to select and the route does not invent output for nodes it cannot verify.
- [x] Tests cover ordering, the caps and markers, mixed finished, unfinished and damaged attempts, Deleted factory behaviour and the uncertain run, on the HTTP seam with seeded fixtures and on the DOM-harness seam (newest open, others collapsed, one click away).
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged via `ticket/vao-03` (builder commits `1db4fd4`, `ac4c3f2`, `5a65a32`, `18d488a`, then fix commits `c785edc`, `a1b15d0`), two Opus review rounds (medium). Round 1: three blocking (damaged attempts were all relabelled "Attempt 1", so the list was misnumbered; a damaged progress or readiness record on the running attempt hid a finished earlier attempt and understated the total; the size budget cut older attempts' text to a bare "…" with no omitted count), plus `/live` drift for a damaged latest record and documentation gaps. Round 2: PASS, no blocking findings.

Tests: viewer suite `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`: 100 passed (builder; reviewer reran); docs test 7 passed; `node bootstrap/run-tests.ts deterministic`: 1620 of 1623 (builder), the 3 failures are `hc-live-isolation.test.ts`, which cannot run inside an hc cgroup. `/live` byte-identical to the pre-ticket code for valid and damaged data over a 12-stage review loop (reviewer). Hostile load: 11 attempts of about 850 KB each answered in about 450 ms and exactly 65,536 bytes with no private values; 20 maximal hostile attempts about 730-780 ms.

Done here: per-attempt resolver, every attempt of a node newest first (cap 20, "N attempts omitted" marker), a hard 64 KB budget across attempts with counted markers, per-attempt typed absence and file-safety, Deleted-factory retained output, artifact-path matcher over the union of the returned attempts, the scrubber carry-forwards (`\p{No}`, `\p{Nl}`, `\p{Lm}` as delimiters, runs of leading sigils, linear collection cost).

Notes carried forward (ticket 04 or 05, none blocking):
- NB1: when node-level context fails after the latest attempt finished (damaged readiness record or foreign progress token on a finished attempt 3), that attempt appears twice: an "Uncertain, number unverified" entry plus the verified "3 Succeeded" entry. Fold the unverified entry into the highest verified attempt when nothing records a newer attempt, or say in its explanation that it may be the same attempt.
- NB2: a non-loop node (`max_attempts` 1) shows "Attempt (number unverified) of 1" when its context is damaged, where ticket 02 showed "Attempt 1"; keep the number 1 and an exact total when `max_attempts` is 1.
- NB3: `/output` takes about 37 ms per attempt (20 attempts ≈ 730-780 ms) because every attempt is fully projected and scrubbed before the budget trims most of them; project the newest attempt first and scrub older bodies from a smaller pre-bound.
- N4 (design note): a maximal newest attempt can exceed 64 KB on its own, so older attempts are dropped ("N attempts omitted") before the newest attempt's optional sections are trimmed.
- The 20-attempt cap is reachable only through a hand-built manifest over HTTP (loops are limited to 11 attempts); it is tested that way and documented.
- Case-sensitive POSIX artifact-path matching (`SRC/X.TS` is not redacted for artifact `src/x.ts`) is a documented residual.
- Browser items for ticket 05: heading margins inside `<summary>`, 390px scrolling, keyboard traversal, contrast.

Review files: scratchpad `review-03-r1.md`, `review-03-r2.md`.
