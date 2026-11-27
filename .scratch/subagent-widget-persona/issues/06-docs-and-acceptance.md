# 06: Documentation and acceptance

**What to build:** The persona feature is documented and verified as a whole. The widget's usage documentation gains a short "Subagents with a persona" section: how to launch one, what each persona field does for a subagent (instructions, model, thinking, tools, skills), what is ignored (`extensions:`, `color`, `description`), the precedence rules, the rejected combinations and the continuation rules. The Bootstrap README's persona section gets one line saying a persona can also back a subagent and pointing at that section. The full test suites pass.

Spec: `../spec.md` (Implementation Decisions: Documentation; Further Notes).

**Blocked by:** 02 (prompt delivery), 03 (tools and skills), 04 (continuation), 05 (display).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** easy (documentation and a full-suite run) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [x] The widget usage documentation has the persona section covering every point above, and each claim matches the behaviour the tests assert (no field is described as working that the code ignores).
- [x] `bootstrap/README.md` has the one-line pointer in its persona section; `bootstrap/README.md` and `bootstrap/HOST.md` contain no stale claim such as "a subagent has no persona".
- [x] `GLOSSARY.md` still matches the shipped behaviour (Subagent may use a persona and is still not an Agent or a node).
- [x] The subagent widget suite and the Bootstrap suites pass; the results are recorded in a verification note. A before/after check shows no leftover child processes or temporary files.
- [x] Status is set to done and verified criteria are ticked on merge; the spec's status line is updated to implemented and verified.

## Verification note

Merged as `6f96cd2` plus `ac88d81` (header wording fixes) via `ticket/persona-06`, review rounds 1 to 3 (Opus, medium); round 3 approved. Round 1 requested changes (dropped skills-default rule, wrong continue-error wording, over-broad control-character claim); round 2 two wording claims (invisible names, `persona` guidance versus enforcement); all fixed. The documentation is the "Subagents with a persona" bullets in the `subagent-widget.ts` header comment (the widget's usage documentation; there is no separate widget README), plus one anchor-free pointer line in `bootstrap/README.md`. No executable line changed in this ticket (reviewer confirmed byte-identical code after the header comment).

Verification on the merged integration branch (orchestrator, tip `ca229e5`):
- `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 98 tests, 98 passed.
- `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 tests, 1600 passed.
- Leftovers: fake-pi processes 0 before, 0 after the widget run and 0 after the Bootstrap run; `/tmp/subagent-widget-test-*` directories 0 before and 0 after each.
- `GLOSSARY.md` matches the shipped persona behaviour (Subagent may use a persona and is still not an Agent or a node). It was not edited.

Open items (reviews: scratchpad `review-06-r1.md` to `review-06-r3.md`):
- `GLOSSARY.md` line 16 ("The parent hears back once, with the subagent's final message") has been stale since notify-only delivery (`bb14e7f`); it predates this work and is unchanged.
- `bootstrap/README.md` line 42 says a launch that fails before spawn shows "the persona's own model"; a persona without `model:` actually shows the inherited parent model, and the row ignores an explicit `--model` in that failure case. Suggested wording: "the persona's resolved model (inherited from the parent if `model:` is omitted)".
- Header wording nits: the name is capped at 16 columns at every width, and the invisible-name clause lists control characters that a separate earlier error already rejects. README line 41 still writes `extensions:`, `color` and `description` without colons.
