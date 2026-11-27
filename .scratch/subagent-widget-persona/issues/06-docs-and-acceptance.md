# 06: Documentation and acceptance

**What to build:** The persona feature is documented and verified as a whole. The widget's usage documentation gains a short "Subagents with a persona" section: how to launch one, what each persona field does for a subagent (instructions, model, thinking, tools, skills), what is ignored (`extensions:`, `color`, `description`), the precedence rules, the rejected combinations and the continuation rules. The Bootstrap README's persona section gets one line saying a persona can also back a subagent and pointing at that section. The full test suites pass.

Spec: `../spec.md` (Implementation Decisions: Documentation; Further Notes).

**Blocked by:** 02 (prompt delivery), 03 (tools and skills), 04 (continuation), 05 (display).

**Status:** ready-for-agent

**Delegation tier:** easy (documentation and a full-suite run) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [ ] The widget usage documentation has the persona section covering every point above, and each claim matches the behaviour the tests assert (no field is described as working that the code ignores).
- [ ] `bootstrap/README.md` has the one-line pointer in its persona section; `bootstrap/README.md` and `bootstrap/HOST.md` contain no stale claim such as "a subagent has no persona".
- [ ] `GLOSSARY.md` still matches the shipped behaviour (Subagent may use a persona and is still not an Agent or a node).
- [ ] The subagent widget suite and the Bootstrap suites pass; the results are recorded in a verification note. A before/after check shows no leftover child processes or temporary files.
- [ ] Status is set to done and verified criteria are ticked on merge; the spec's status line is updated to implemented and verified.
