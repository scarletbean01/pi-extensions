# 04: Output appears when an attempt finishes and survives live polls

**What to build:** While a run is live, a finished attempt's output appears in the selected node's section without reloading the page: the client re-fetches the output when the live snapshot shows that node's attempt reaching a finished status or a new attempt appearing. Output is never polled and never re-downloaded every two seconds. Pan, zoom, selection, open sections and keyboard focus all survive a live poll while output is shown.

Spec: `../spec.md` (user stories 24–28, 31; Implementation Decisions: Client fetching, The pure client-logic script gains the small helper that decides when to re-fetch output; Testing Decisions: Seam 2, Scenario 5 behaviour).

**Blocked by:** 03.

**Status:** ready-for-agent

**Delegation tier:** complex (in-place patching: element identity that pan/zoom, selection, open disclosures and focus depend on must not change) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [ ] A small pure helper in the client-logic script decides when output must be fetched again (the selected node's attempt reached a finished status, or a new attempt appeared) and is unit-tested directly.
- [ ] In the DOM harness, a node finishing during a poll shows its output without a page reload, and a plain poll with no change issues no output request.
- [ ] Switching node or factory aborts an in-flight output request and discards a stale or mismatched response, including a response that arrives after a poll-triggered refetch started.
- [ ] Across a live poll with output shown, the existing in-place patching test (Scenario 5) still passes and additionally asserts that open attempt disclosures, the focused element, pan, zoom and selection are unchanged.
- [ ] A failed refetch shows an error inside the section only; the graph and the rest of the panel are untouched.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
