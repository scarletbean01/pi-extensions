# 04: Output appears when an attempt finishes and survives live polls

**What to build:** While a run is live, a finished attempt's output appears in the selected node's section without reloading the page: the client re-fetches the output when the live snapshot shows that node's attempt reaching a finished status or a new attempt appearing. Output is never polled and never re-downloaded every two seconds. Pan, zoom, selection, open sections and keyboard focus all survive a live poll while output is shown.

Spec: `../spec.md` (user stories 24–28, 31; Implementation Decisions: Client fetching, The pure client-logic script gains the small helper that decides when to re-fetch output; Testing Decisions: Seam 2, Scenario 5 behaviour).

**Blocked by:** 03.

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** complex (in-place patching: element identity that pan/zoom, selection, open disclosures and focus depend on must not change) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A small pure helper in the client-logic script decides when output must be fetched again (the selected node's attempt reached a finished status, or a new attempt appeared) and is unit-tested directly.
- [x] In the DOM harness, a node finishing during a poll shows its output without a page reload, and a plain poll with no change issues no output request.
- [x] Switching node or factory aborts an in-flight output request and discards a stale or mismatched response, including a response that arrives after a poll-triggered refetch started.
- [x] Across a live poll with output shown, the existing in-place patching test (Scenario 5) still passes and additionally asserts that open attempt disclosures, the focused element, pan, zoom and selection are unchanged.
- [x] A failed refetch shows an error inside the section only; the graph and the rest of the panel are untouched.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged via `ticket/vao-04` (builder commit `f34fd83`), one Opus review round (medium): PASS, no blocking findings. The reviewer mutation-tested the new tests in a scratch copy: a helper that always returns false fails two tests (the helper table and Scenario 5's refetch count); a refetch trigger that is always true fails Scenario 5 (fetch count). A real review-loop sequence (running, parked waiting, attempt 2 running, attempt 2 succeeded, three polls per state) issued exactly one refetch per transition (counts 1,1,1,2,2,2,3,3,3,4,4,4).

Tests: viewer suite `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`: 100 passed (the count did not change because the new cases are blocks inside two existing top-level tests: "served safe.js pure client logic" and "served app.js wiring" with block M and the extended Scenario 5); docs test 7 passed; `node bootstrap/run-tests.ts deterministic`: 1620 of 1623 (builder), the 3 failures are `hc-live-isolation.test.ts`, which cannot run inside an hc cgroup.

Done here: pure helper `shouldRefetchNodeOutput` in `safe.js`; refetch on a finished status or a new attempt, never on a plain poll; stale and mismatched responses discarded (including a pre-poll response arriving after a poll-triggered refetch); in-section error on a failed refetch; open state of the attempt, Structured outputs and Artifacts disclosures kept by stable key and keyboard focus restored across a refetch.

Non-blocking notes carried forward (suggested for a small follow-up before or during ticket 05's browser pass; none blocks ticket 05):
- NB1 (accessibility): a refetch replaces the attempt body inside the detail panel's `aria-live="polite"` region, so a screen reader reads the whole new output (up to 64 KB) once per transition. Set `aria-live="off"` on the Attempt output card (or its slot) and announce a short line through the existing announcer ("Attempt N of node X finished: Succeeded"). `app.js` ~2241, 2292, 2345.
- NB2 (test gap): the focus-restoration path is untested because the harness leaves `fakeDocument.activeElement` on a detached node (`FakeNode.remove`, `replaceChildren`, `insertBefore`); the "focus survives refetch" assertions pass only because the summary elements are reused. Make the harness move `activeElement` to body when a subtree containing it is detached, and add a case that focuses a sub-disclosure summary and then refetches with changed content for that attempt.
- NB3: focus restoration calls `focus()` without `{ preventScroll: true }` (`app.js` ~1245), so the page may scroll when focus is restored.
- NB4: the previous snapshot is taken at fetch time, not at the previous poll (`app.js` ~1257, `safe.js` ~887), so a transient `needs_attention` without `completed_at` followed by the same real status can miss a refetch and leave stale content; keep a separate "last seen live node" updated on every poll and pass it as `prev`. No request storm in the reverse direction.
- NB5: every default open state is recorded as if the user had chosen it (`app.js` ~1219), so a long review loop watched live ends with every attempt expanded (record only explicit toggles); a failed fetch on a node that never transitions again recovers only by selecting another node and returning, because `outputLoadedKey` is already set (let re-selecting the same node retry after an error).

Review file: scratchpad `review-04-r1.md`.
