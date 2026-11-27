# 05: Show the persona

**What to build:** A user can tell persona subagents apart. The widget row and the `/sub` and `/subcont` info lines show the persona name together with the model and thinking level, for example `#3 reviewer · openai/gpt-5 (high)`. A subagent with no persona is shown exactly as today. The result text and notice delivered to the parent are unchanged.

Spec: `../spec.md` (user stories 26, 27; Implementation Decisions: Display).

**Blocked by:** 01 (persona launch).

**Status:** ready-for-agent

**Delegation tier:** easy (display text through the existing widget assertions) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [ ] The widget row for a persona subagent includes the persona name; a persona-less subagent's row is identical to today's.
- [ ] The `/sub` and `/subcont` info line shows the persona name with the model and thinking level; persona-less lines are unchanged.
- [ ] Rows stay truncated by terminal width with a long persona name, wide characters included.
- [ ] The result text and notify-only notice for a persona subagent contain no persona name and are identical to a persona-less result.
- [ ] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.
