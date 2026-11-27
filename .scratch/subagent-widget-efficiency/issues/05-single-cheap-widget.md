# 05: One combined, cheap widget

**What to build:** The widget shows all subagents in one display, one row each (id, status, elapsed, current tool, last line), instead of one bordered box per subagent. It does almost no work per streamed token: the last line is tracked incrementally, one shared 1-second timer runs only while something is running, redraws go through the host's render request, and rows are cut by terminal width.

Spec: `../spec.md` (user stories 22–24; Implementation Decisions: One widget).

**Blocked by:** 02 (launch code settled). Relaxed 2026-11-27 to run in parallel with 03 on a branch stacked on 02; it renders the existing subagent states, so it does not need 03's queue or cancellation. Merge after 03 and resolve conflicts then. Ticket 04 clears the shared timer at shutdown and so follows both.

**Status:** done

**Delegation tier:** complex (render lifecycle, shared timer ownership, width handling, no regression in what users can see) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [x] With N subagents, exactly one widget is registered; it is registered once and updated through invalidate-and-render, not re-registered per token.
- [x] Streaming a large amount of text does not join or split the transcript per render; a test bounds the work, for example by counting widget re-registrations and checking the last line without storing every chunk.
- [x] One timer exists while any subagent runs and none when all have settled or been removed; shutdown clears it. (Exposed internal `clearWidget` clears the shared timer and widget; ticket 04 wires `session_shutdown` to call it, while `session_start` and `/subclear` already exercise it.)
- [x] Rendering at several widths, including very narrow ones, with wide characters and colour codes, never exceeds the width.
- [x] Each row still shows id, status, elapsed, current tool and last line, and finished or errored subagents stay visible until removed.
- [x] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

**Verification:** Verified with `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` (3 consecutive runs, 12/12 passing in each) against the fake host and fake `pi` executable. Confirmed a single `"subagents"` widget is registered once across multiple subagents and updated via `invalidate()` + `tui.requestRender()` with `(width, version, theme)` caching, `lastLine` updates incrementally without joining or splitting `textChunks` on render, a single shared 1-second timer runs only while at least one subagent is running and is cleared on settlement, removal, `/subclear`, and `session_start` via `clearWidget` (ready for ticket 04's `session_shutdown`), width truncation via `visibleWidth`/`truncateToWidth` stays within widths `1..80` for wide CJK/emoji and ANSI colors, and `bootstrap/README.md` and `bootstrap/HOST.md` contain no stale claims about the subagent widget.
