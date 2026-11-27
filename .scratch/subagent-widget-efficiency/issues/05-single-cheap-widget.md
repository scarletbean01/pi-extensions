# 05: One combined, cheap widget

**What to build:** The widget shows all subagents in one display, one row each (id, status, elapsed, current tool, last line), instead of one bordered box per subagent. It does almost no work per streamed token: the last line is tracked incrementally, one shared 1-second timer runs only while something is running, redraws go through the host's render request, and rows are cut by terminal width.

Spec: `../spec.md` (user stories 22–24; Implementation Decisions: One widget).

**Blocked by:** 03 (settled and queued states), 04 (shared timer is cleared at shutdown)

**Status:** ready-for-agent

**Delegation tier:** complex (render lifecycle, shared timer ownership, width handling, no regression in what users can see) → agy `gemini-4-hydrogen-high`; Opus review at medium effort.

- [ ] With N subagents, exactly one widget is registered; it is registered once and updated through invalidate-and-render, not re-registered per token.
- [ ] Streaming a large amount of text does not join or split the transcript per render; a test bounds the work, for example by counting widget re-registrations and checking the last line without storing every chunk.
- [ ] One timer exists while any subagent runs and none when all have settled or been removed; shutdown clears it.
- [ ] Rendering at several widths, including very narrow ones, with wide characters and colour codes, never exceeds the width.
- [ ] Each row still shows id, status, elapsed, current tool and last line, and finished or errored subagents stay visible until removed.
- [ ] `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
