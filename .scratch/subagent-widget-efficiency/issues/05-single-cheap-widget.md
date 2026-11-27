# 05: One combined, cheap widget

**What to build:** The widget shows all subagents in one display, one row each (id, status, elapsed, current tool, last line), instead of one bordered box per subagent. It does almost no work per streamed token: the last line is tracked incrementally, one shared 1-second timer runs only while something is running, redraws go through the host's render request, and rows are cut by terminal width.

Spec: `../spec.md` (user stories 22–24; Implementation Decisions: One widget).

**Blocked by:** 02 (launch code settled). Relaxed 2026-11-27 to run in parallel with 03 on a branch stacked on 02; it renders the existing subagent states, so it does not need 03's queue or cancellation. Merge after 03 and resolve conflicts then. Ticket 04 clears the shared timer at shutdown and so follows both.

**Status:** ready-for-agent

**Delegation tier:** complex (render lifecycle, shared timer ownership, width handling, no regression in what users can see) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [ ] With N subagents, exactly one widget is registered; it is registered once and updated through invalidate-and-render, not re-registered per token.
- [ ] Streaming a large amount of text does not join or split the transcript per render; a test bounds the work, for example by counting widget re-registrations and checking the last line without storing every chunk.
- [ ] One timer exists while any subagent runs and none when all have settled or been removed; shutdown clears it.
- [ ] Rendering at several widths, including very narrow ones, with wide characters and colour codes, never exceeds the width.
- [ ] Each row still shows id, status, elapsed, current tool and last line, and finished or errored subagents stay visible until removed.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
