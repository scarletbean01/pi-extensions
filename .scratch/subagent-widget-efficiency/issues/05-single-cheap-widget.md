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

**Verification:** Rebased onto `main` after tickets 02 and 03 and verified with `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget.test.ts` (3 consecutive runs, 38/38 passing in each, including all ticket 01, 02, 03, and 05 tests) against the fake host and fake `pi` executable. Confirmed a single `"subagents"` widget is registered once across multiple subagents and updated via `invalidate()` + `tui.requestRender()` with `(width, version, theme)` caching; each row shows id, status, elapsed, a width-adaptive task label (truncated without ellipsis so dim styling does not reset mid-row), `Tools: N [currentTool]` (or compact narrow layout at widths `20, 30, 40`), and sanitized `lastLine` (non-SGR control sequences stripped); `appendLastLine` tracks `lastLine` incrementally in O(chunk) time across split lines and newline/whitespace-only deltas (`\n`, `\n\n`, `\r\n`, ` \n `) with safe 512-char boundary capping (never splitting surrogate pairs, ZWJ sequences, or ANSI escapes) without `textChunks`; a single shared 1-second timer runs only while at least one subagent is running and is cleared on settlement, cancellation/removal, `/subclear`, and `session_start` via `clearWidget` (ticket 04 should call `clearWidget` from `session_shutdown`; `session_start` also uses it to reset); width truncation stays within widths `1..80` under both the harness stub and an independent grapheme-width oracle for CJK, ZWJ emoji, combining marks, ANSI colors, and a 600-character line (`@mariozechner/pi-tui` is bundled in the Pi binary and not directly importable in Node); zero `/tmp/subagent-widget-*` directories or `fake-pi` processes leak across a full run; and `bootstrap/README.md` and `bootstrap/HOST.md` contain no stale claims about the subagent widget.
