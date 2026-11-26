# Factory web viewer: show each agent's attempt output

Status: ready-for-agent. Prepared 2026-11-25 from a grill-with-docs session (11 decisions, all accepted as recommended). Build it AFTER the `viewer-materialize-components` branch is merged: both touch the client script, the stylesheet and the viewer guide, and the Materialize guard test will reject any new custom selector that is not on its allowlist. The test seams are the two existing ones: the viewer's HTTP snapshot API (seeded fixtures, whole-body sentinel scans) and the served assets with the DOM harness (accepted by the user). Vocabulary follows `GLOSSARY.md`, including the new term **Attempt output** (software factory, **Node**, **Attempt**, **Run graph**, **Deleted factory**). Architecture follows ADR 0001: the viewer observes and never drives.

## Problem Statement

When I watch a software factory run in the viewer, I can see which node is running, what its status is and a one-line summary, but not what an agent actually reported. To read a node's report I have to leave the viewer and open run files by hand. That is slow, it is easy to open the wrong attempt, and it means the viewer cannot answer the question I most often have: what did this agent say it did, and what did it find?

## Solution

When I select a node in Live Graph, the detail panel gains an **Attempt output** section. It lists every attempt of that node in the displayed run, newest first, with the newest open. Each attempt shows what the agent recorded when it finished: its status, summary and detail, plus any verification, warnings and next steps, and for command nodes the command's output excerpts. Structured outputs and artifact descriptions sit in collapsed sections. Text keeps its line breaks, is scrubbed of paths and unsafe characters, and is bounded with a visible marker when something is cut. A node that has not finished says so plainly; a finished attempt whose record is missing or damaged says the evidence is unavailable. The viewer stays read-only and loopback-only, and still never shows raw prompts, briefs, tokens or logs.

## User Stories

1. As an operator watching a run, I want to select a node and see the report its agent recorded, so that I can understand what happened without opening run files.
2. As an operator, I want the report in the same detail panel as the node's status, so that I do not have to switch views to connect the two.
3. As an operator, I want the newest attempt of a node open by default, so that the most relevant report is visible immediately.
4. As an operator, I want to see every attempt of a node in the displayed run, newest first, so that I can compare a revision with the attempt it replaced.
5. As an operator reviewing a review loop, I want older attempts collapsed but one click away, so that the panel stays readable.
6. As an operator, I want each attempt labelled with its attempt number and status, so that I know which one I am reading.
7. As an operator, I want to see the attempt's status, summary and detail, so that I get the agent's own account of the work.
8. As an operator, I want the verification results the agent listed, so that I can see what it claims to have checked.
9. As an operator, I want the warnings the agent listed, so that I notice caveats it flagged.
10. As an operator, I want the next steps the agent listed, so that I know what it thinks should happen next.
11. As an operator looking at a command node, I want its standard output and standard error excerpts next to its exit code and signal, so that I can see why a command failed.
12. As an operator, I want structured outputs shown collapsed as readable text, so that they are available without crowding the panel.
13. As an operator, I want artifact descriptions shown without file paths, so that I learn what was produced without exposing machine paths.
14. As an operator, I want a node that never produced a result to show its disposition reason or error message, so that a blocked, skipped, cancelled or failed node is still explained.
15. As an operator, I want a running or not-yet-started attempt to say that output is recorded when the attempt finishes, so that I do not mistake silence for a problem.
16. As an operator, I want a finished attempt whose result record is missing, damaged or unreadable to say the evidence is unavailable, so that the viewer never guesses.
17. As an operator, I want those absence states to use the same typed wording as the rest of the viewer (not applicable, no records, evidence unavailable), so that I read them the same way everywhere.
18. As an operator, I want multi-line text to keep its line breaks, so that lists, code and paragraphs stay legible.
19. As an operator, I want long text bounded with a visible "truncated" marker that says how many characters were omitted, so that I know when I am not seeing everything.
20. As an operator, I want very long lines to wrap rather than force sideways scrolling, so that the panel stays usable at 390px.
21. As an operator, I want absolute paths in output replaced with a redaction marker, so that machine and home directory paths do not appear on screen.
22. As an operator, I want control, bidirectional and zero-width characters neutralised, so that an agent's text cannot disguise itself or reorder what I read.
23. As an operator, I want the existing one-line summary in the node detail to be scrubbed the same way, so that the old path to the same text is not a leak.
24. As an operator, I want the output to appear when an attempt finishes without reloading the page, so that I see fresh results during a run.
25. As an operator, I want the output not to be re-downloaded every two seconds, so that the viewer stays light and the panel does not flicker.
26. As an operator, I want selecting a different node to load that node's output only, so that the viewer does not fetch every node's report up front.
27. As an operator, I want pan, zoom, selection, open sections and keyboard focus to survive a live poll while output is shown, so that reading is not interrupted.
28. As an operator, I want a failed output fetch to show an error in the section without disturbing the graph or the rest of the panel, so that one failure does not hide everything.
29. As an operator viewing a Deleted factory, I want its retained attempt output to remain readable, so that the evidence stays inspectable as the glossary promises.
30. As an operator viewing a run whose evidence is uncertain, I want the viewer to refuse to invent output for nodes it cannot verify, so that I am not misled.
31. As a keyboard-only user, I want the output section's accordions and controls reachable and operable with the keyboard, so that I do not need a mouse.
32. As a screen-reader user, I want attempts and sections to have real headings and native disclosure controls, so that I can navigate the output by structure.
33. As a user relying on text cues, I want every status in the output section to carry a symbol or word as well as colour, so that colour is never the only signal.
34. As a security-conscious operator, I want raw prompts, input briefs, tokens, endpoint paths, worker configuration and metrics never to appear, so that showing output does not widen what the viewer exposes.
35. As a security-conscious operator, I want the viewer to remain read-only, so that the new section offers no way to respond, retry, redeliver or edit anything.
36. As a maintainer, I want the output endpoint to follow the same query rules as the other endpoints (identifier-only, unknown and duplicate keys refused), so that the API contract stays uniform.
37. As a maintainer, I want an unknown factory or a node that is not in the displayed run to return not found rather than an empty report, so that mistakes are visible.
38. As a maintainer, I want the caps to be fixed, documented and tested, so that a huge result cannot make the viewer slow or exhaust memory.
39. As a maintainer, I want the viewer guide to state exactly what output the viewer now exposes and what it still excludes, so that the privacy contract has one honest description.
40. As a maintainer, I want leak tests to keep protecting everything that must stay private on every endpoint, including the new one, so that the contract cannot erode quietly.
41. As a maintainer, I want the new section built from the Materialize components already in use and no new custom rule beyond the allowed categories, so that the viewer keeps one visual language.

## Implementation Decisions

- **Meaning of output.** Output is the **Attempt output** defined in the glossary: the report an attempt recorded when it finished. It is not a transcript, terminal capture or log, and it does not exist until the attempt has finished. The agents' session transcripts are out of scope: they hold full prompts, tool output and thinking text, are not linked to nodes by any run record, and are the "logs" the privacy contract excludes.
- **Where it shows.** A new section in Live Graph's selected-node detail panel, below the existing attempt facts. No new view and nothing in Inspect, which describes definitions rather than runs. The panel keeps its existing in-place patching: element identity that pan/zoom, selection, open disclosures and focus depend on must not change.
- **Which attempts.** Every attempt of the selected node in the displayed run, newest first, each in a native disclosure with only the newest open. A node with one attempt shows one. The displayed run is the one Live Graph already shows (the active or most recent observed run); no historical run browser is added.
- **Fields shown per attempt.**
  - Status, summary, detail, verification entries, warnings and next steps from the recorded result.
  - For command nodes, the recorded exit code and signal plus the standard output and standard error excerpts.
  - The structured outputs, collapsed, as pretty-printed text.
  - Artifact descriptions without their paths.
  - For a node with no result record, the disposition reason, or the recorded error message.
  - Never shown: metrics, tokens, endpoint paths, worker configuration, the raw input brief or its identity roster, and artifact paths.
- **Scrubbing.** A new text scrubber sits beside the existing operator-text scrubber. It performs the same control, bidirectional and zero-width neutralisation, the same redaction of blocked paths and the same conservative redaction of generic absolute path tokens, but it preserves line breaks instead of collapsing whitespace. The client renders the result as plain text with preserved whitespace and wrapping. It never renders markdown or HTML.
- **Blocked paths.** The set of paths redacted for the new endpoint includes the run's session directory and project directory as well as the store, coordination, index, checkout and home paths already redacted elsewhere.
- **Existing summary.** The one-line summary already shown in the node detail passes through the same scrubbing and a bound, so the old route to the same text is closed. This is the only change to an existing field.
- **Caps.** Each field is bounded separately, with a visible marker stating how many characters were omitted. Summary: 1,000 characters. Detail: 8,000. Structured outputs as text: 8,000. Each command excerpt: 4,000. Each verification, warning and next-step item: 500, with at most 20 items per list. At most 20 attempts per node, and about 64 KB per response; when the response bound is reached, later content is cut with the same visible marker. Caps count Unicode code points and never split a surrogate pair.
- **Endpoint.** One new read-only route returns the output for a node of a factory's displayed run.
  - It requires a single node identifier query value of the same restricted form used elsewhere; unknown or duplicate keys and malformed values return a client error.
  - It returns not found for an unknown factory, and for a node that is not in the displayed run. It never returns an empty report for a mistake.
  - It follows the existing method, host, cache and identifier-only rules, and never accepts a filesystem path.
  - It reads only regular, non-symlink, non-blocking files under the run directory, using the viewer's existing safe-read checks, with a size limit before parsing. It performs no write, repair or recovery.
- **Client fetching.** The client requests the output when a node is selected, and requests it again when the live snapshot shows that node's attempt reaching a finished status or a new attempt appearing. Output is never polled. Switching node or factory aborts an in-flight request and discards a stale or mismatched response, as for other views. A failed request shows an error inside the section only.
- **Typed absence.** A running or not-yet-started attempt shows "Not applicable" with an explanation that output is recorded when the attempt finishes. A finished attempt whose result record is missing, damaged, unreadable or contradicts the node's identity shows "Evidence unavailable". A Deleted factory behaves like any other, because its evidence stays inspectable. An uncertain run, for which the graph is already unavailable, offers no node to select.
- **Privacy contract change.** The viewer guide's statement that responses exclude "logs" and "internal records" is reworded: Attempt output is allowed in scrubbed, bounded form; raw prompts, input briefs, tokens, endpoint paths, worker configuration, metrics, artifact paths and canonical checkout paths remain excluded. The guide also documents the new endpoint, the caps and the new section.
- **Components and styling.** The section uses the Materialize components the viewer already uses (card, native disclosures with the collapsible classes, collection, chip with tone classes). The only new custom rule needed is preserved whitespace for output text, which belongs to the existing "wrapping for long identifiers" category of the Materialize spec's allowlist.
- **Modules touched.** The viewer server and its snapshot projections (one new projection module plus the shared scrubber), the client application script, the stylesheet, the asset and snapshot tests, the viewer guide and the vendor-neutral docs test. The pure client-logic script gains the small helper that decides when to re-fetch output. Pi, factory operations and the stores do not change.
- **Sequencing.** Build after the Materialize branch merges, so the new markup is written against the final component set and passes the guard test without a temporary allowlist.

## Testing Decisions

- **What a good test is.** Assert on what the viewer serves: the HTTP responses, and the DOM that the served scripts produce in the existing harness. Do not assert on helper structure.
- **Seam 1: the HTTP snapshot API.** Seeded fixtures with whole-body sentinel scans, as in the live snapshot tests. Cover the endpoint's query rules, not-found cases, every cap and its truncation marker, line-break preservation, path and control-character scrubbing, command excerpts, the disposition and error cases, multi-attempt review loops ordering, Deleted factory behaviour, damaged or hostile files (symlink, FIFO, oversize, wrong identity) producing "Evidence unavailable" and never leaking, and the scrubbed existing summary.
- **Seam 2: served assets and the DOM harness.** Cover the new section: attempts listed newest first with only the newest open, plain-text rendering with preserved whitespace (and no markup injected from output), fetch on selection and on completion and never on a poll, abort and stale-response discard when switching node or factory, in-section error handling, the typed absence wording, focus and open-disclosure survival across a poll (Scenario 5 behaviour), and that every chip and card panel in the section carries a tone class set. The existing sink scanner, CSP, local-only and guard tests keep their strength; the Materialize guard must pass with no new allowlist entry beyond the category already named.
- **Leak tests split in two.**
  - Newly allowed fields use non-private sentinels and are asserted present, scrubbed and capped.
  - Everything that must stay private keeps its sentinel scans on every endpoint including the new one: raw prompts and briefs, tokens, endpoint paths, worker configuration and input records, artifact paths, metrics, and absolute paths. Existing fixtures that put private sentinels into result detail and command excerpts are re-seeded so that the allowed fields use the new sentinels and the private ones stay private.
  - The viewer guide statement and the docs test are updated together; the docs test keeps its existing constant checks.
- **Prior art.** The live snapshot tests (seeded fixtures, `assertNoLeaks`, symlink and FIFO cases), the requests and proposals tests (scrubbed bounded text), the asset hygiene test and the served-app wiring test with its DOM harness, and the Scenario 5 in-place patching test.
- **Manual acceptance (browser).** Against the manual fixture, extended with a node that has several attempts and a command node with output: select nodes and read the output at 1280px and 390px with no horizontal page scroll; keyboard-only use of the section; no CSP errors and no external requests; a node finishing during a poll shows its output without disturbing pan, zoom, selection, open sections or focus; contrast of every rendered text pair. Record in the viewer guide only what was actually run.

## Out of Scope

- Session transcripts, terminal or pane capture, thinking text, tool-call history and any "log" view, and live streaming of an attempt while it runs.
- Output from runs other than the displayed one, and any historical run browser.
- Showing prompts, input briefs, persona prompts, tokens, worker configuration, metrics or artifact paths.
- Markdown or HTML rendering of output, copy-to-clipboard or download controls, search, or diffing attempts.
- Any control that responds, retries, redelivers, cancels or edits.
- Changes to Pi, factory operations, the stores or how agents record results.
- Automated browser tests or visual regression tooling.

## Further Notes

- Today the node detail already projects the one-line result summary verbatim and unscrubbed. Closing that gap is part of this spec because the same text is about to be shown at greater length.
- The existing operator-text scrubber collapses all whitespace, which would flatten multi-line detail, structured outputs and command excerpts into one run-on line. That is why a sibling scrubber that preserves line breaks is needed rather than reusing it as is.
- Progress records hold only timestamps and state, never text, so nothing can be shown live for a running attempt without reading transcripts. That is the reason live output is out of scope, not an oversight.
- A later spec could add transcripts if a reliable node-to-session link and a safe scrubbing story exist. Neither does today.
