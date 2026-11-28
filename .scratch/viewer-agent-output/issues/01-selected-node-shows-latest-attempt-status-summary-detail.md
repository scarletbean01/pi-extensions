# 01: Selecting a node shows its latest attempt's status, summary and detail

**What to build:** In Live Graph, selecting a node adds an **Attempt output** section to the detail panel (below the existing attempt facts) showing the status, summary and detail the node's latest attempt recorded when it finished. Behind it, one new read-only route returns the output for a node of a factory's displayed run. The one-line summary already shown in the node detail is also scrubbed and bounded, so the old unscrubbed route to the same text is closed. Text keeps its line breaks, has paths and unsafe characters scrubbed, is bounded with a visible "truncated, N characters omitted" marker, and is rendered as plain text (never markdown or HTML) that wraps rather than scrolls sideways.

Spec: `../spec.md` (user stories 1, 2, 7, 15–23, 26, 28, 30, 36, 37; Implementation Decisions: Meaning of output, Where it shows, Scrubbing, Blocked paths, Existing summary, Caps (summary and detail), Endpoint, Client fetching (selection, abort, stale discard, in-section error), Typed absence, Components and styling).

**Blocked by:** None (can start immediately).

**Status:** done — merged to feature/viewer-agent-output

**Delegation tier:** complex (new route, new scrubber, client section with in-place patching constraints) → agy `gemini-4-hydrogen` at high; Opus review at medium effort.

- [x] A new line-preserving text scrubber sits beside the existing operator-text scrubber: same control, bidirectional and zero-width neutralisation, same blocked-path redaction and conservative generic absolute-path redaction, but line breaks survive. Caps count Unicode code points and never split a surrogate pair. Blocked paths for the new route include the run's session directory and project directory as well as the store, coordination, index, checkout and home paths.
- [x] The existing one-line summary in the node detail goes through the same scrubbing and a bound; a seeded path or control character in a result summary no longer appears raw in the live snapshot.
- [x] `/api/factories/<id>/output?node=<id>` returns the latest attempt's status, summary (cap 1,000) and detail (cap 8,000) from the recorded result, each truncated with a marker stating how many characters were omitted. It follows the existing method, host, cache and identifier-only rules; unknown or duplicate keys and malformed node values return a client error; an unknown factory, or a node not in the displayed run, returns not found (never an empty report).
- [x] The route reads only regular, non-symlink, non-blocking files under the run directory with the viewer's safe-read checks and a size limit before parsing, and performs no write, repair or recovery. A missing, damaged, unreadable, oversize, symlinked, FIFO or wrong-identity result record on a finished attempt returns "Evidence unavailable" and leaks nothing. A running or not-yet-started attempt returns "Not applicable" with the explanation that output is recorded when the attempt finishes.
- [x] Selecting a node fetches its output once; selecting another node or factory aborts the in-flight request and discards a stale or mismatched response; a failed request shows an error inside the section only, without disturbing the graph or the rest of the panel. Output is not re-fetched on the two-second poll in this ticket either.
- [ ] The section renders output as plain text with preserved whitespace and wrapping (no markup injected from output, no horizontal page scroll at 390px). The typed absence wording matches the rest of the viewer ("Not applicable", "Evidence unavailable"). Statuses carry a symbol or word as well as colour; the section uses the existing Materialize card, collapsible and chip components with a complete tone class set; the Materialize guard test passes with the only new custom rule being preserved whitespace under the existing "wrapping for long identifiers" category. NOT YET VERIFIED: no horizontal page scroll at 390px needs the browser pass in ticket 05; everything else in this criterion is covered by tests and review.
- [x] Tests cover the HTTP seam (query rules, not-found cases, caps and markers, line breaks, path and control-character scrubbing, absence states, hostile files, scrubbed summary, whole-body private-sentinel scans) and the DOM-harness seam (rendering, plain text, selection fetch, abort and stale discard, in-section error). No test depends on a real model.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `0508a69` via `ticket/vao-01` (builder commits `be0f788`, `84d2981`, `ab194d3`), three Opus review rounds (medium): round 1 one blocking (generic paths wrapped in backticks or other markdown delimiters were not redacted), round 2 one blocking (quadratic backtracking in the punctuation split stalled `/output` and `/live` on hostile text), round 3 PASS. Viewer suite `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`: 85 passed (builder and reviewer). Docs test: 7 passed. `node bootstrap/run-tests.ts deterministic`: 1605 of 1608 (builder); the 3 failures are `hc-live-isolation.test.ts`, which cannot run inside an hc cgroup.

Notes carried forward (ticket 02 unless stated):
- N4: about 280 lines of attempt and status derivation are duplicated between `live.ts` `nodeObservation` and `output.ts` `latestAttemptOutputForNode`; extract a shared resolver before extending either copy. N-e (output status differs from the graph's graph-level overrides: handoff evidence gives Uncertain, upstream closure gives Blocked) belongs to the same resolver.
- N3-a: excluding `,;|` from the path token body leaks the tail of a path whose directory name contains those characters (`/opt/a,b/secret/k` becomes `[redacted-path],b/secret/k`). Split only where a new path starts after the delimiter, and add a test.
- N3-b: the 4 × cap pre-bound can cut inside a path's first segment or a `~user` prefix when scrubbing shrinks the text by 3 × cap or more. Drop the trailing non-whitespace run after the cut and count it as dropped.
- N3-c (cosmetic): marker look-alikes with dot or space grouping, Arabic-Indic digits and fullwidth brackets still pass through.
- The 390px no-horizontal-scroll check and the other browser checks are ticket 05.

Review files: scratchpad `review-01-r1.md`, `review-01-r2.md`, `review-01-r3.md`.
