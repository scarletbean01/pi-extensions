# 08: Release gate: migration guide, docs and end-to-end run

**What to build:** Close the change as a coherent release: user-facing documentation, a migration guide for existing personas and a real end-to-end run proving the pieces work together.

**Blocked by:** 01, 04, 06, 07

**Status:** ready-for-agent

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [ ] The bootstrap README and release notes describe: the `bootstrap.json` shape and precedence, thinking-level sources and precedence, persona discovery from the two Pi directories, the `skills:` field (absent, empty and named lists), the unknown-skill failure, the removal of the harness-documentation block, and the removal of the interactive persona switcher.
- [ ] A migration guide covers moving existing personas from other tools' folders (for example the six in `~/.claude/agents`) into `~/.pi/agent/agents`, then either defining the aliases they use in the global `bootstrap.json` or switching their `model:` lines to full IDs.
- [ ] The documentation states that allowed skills save context and are not a permission boundary, and that extension-contributed prompt rules are untouched.
- [ ] The full deterministic and runtime suites pass; any skipped test is listed with the reason.
- [ ] One real end-to-end run with a migrated persona (using an alias with a thinking level, a limited skills list and the real Pi binary) is captured and matches expectations: model, thinking level, kept skills, no documentation block, persona text present.
- [ ] The glossary and spec reflect anything learned, and the spec's assumptions list is marked confirmed or corrected.
- [ ] Known limitations are recorded: extension-rule trimming and the per-persona extension list are deferred for a later grilling.

## Verification

- Full suite output, the captured end-to-end request and a short checklist mapping each spec user story to the test or document that covers it.

## Constraints and handoff

This is the gate, not a place to build features. Defects found here are fixed in the owning ticket's code with a regression test, or recorded as known limitations if deliberately deferred.
