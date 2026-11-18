# 08: Release gate: migration guide, docs and end-to-end run

**What to build:** Close the change as a coherent release: user-facing documentation, a migration guide for existing personas and a real end-to-end run proving the pieces work together.

**Blocked by:** 01, 04, 06, 07

**Status:** done — merged to main (`3f04cfa`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] The bootstrap README and release notes describe: the `bootstrap.json` shape and precedence, thinking-level sources and precedence, persona discovery from the two Pi directories, the `skills:` field (absent, empty and named lists), the unknown-skill failure, the removal of the harness-documentation block, and the removal of the interactive persona switcher.
- [x] A migration guide covers moving existing personas from other tools' folders (for example the six in `~/.claude/agents`) into `~/.pi/agent/agents`, then either defining the aliases they use in the global `bootstrap.json` or switching their `model:` lines to full IDs.
- [x] The documentation states that allowed skills save context and are not a permission boundary, and that extension-contributed prompt rules are untouched.
- [x] The full deterministic and runtime suites pass; no tests in these suites were skipped.
- [x] One end-to-end runtime test with a migrated fixture persona uses the real Pi binary and captures the request to a local fake provider: model, thinking level, kept skills, no documentation block, persona text present.
- [x] The glossary and spec reflect anything learned, and the spec's assumptions list is marked confirmed or corrected.
- [x] Known limitations are recorded: extension-rule trimming and the per-persona extension list are deferred for a later grilling.

## Verification

`node bootstrap/run-tests.ts all` at `b3d6612` (Pi 1.5.2, Node 26.13.1): deterministic 674 passed; runtime 15 passed; zero failures or skips. The opt-in live Herdr suite is not part of `all` and was not run.

The migrated-persona test captures the actual request from the generated launcher running real Pi, with simulated Herdr tabs and a local fake provider. It verifies `bootstrap-fake/model`, `high` thinking and provider `reasoning_effort`, only `capture-review`, no Pi documentation block, and the persona prefix and execution contract retained.

| Spec stories | Evidence (paths under `bootstrap/`) |
| --- | --- |
| 1–16 | `lifecycle.test.ts`, `tools.test.ts`, `runtime-thinking.test.ts`: alias configuration, dry runs, precedence, validation, inheritance and launched thinking level |
| 17–19 | `bootstrap-utils.test.ts`, `lifecycle.test.ts`, `MIGRATION.md`: discovery, precedence and migration |
| 20–26 | `lifecycle.test.ts`, `tools.test.ts`, `worker.test.ts`, `runtime-provider-request.test.ts`: allowed skills, launch flags, status errors and request capture |
| 27–31 | `worker.test.ts`, `runtime-provider-request.test.ts`, `README.md`: documentation trimming, preserved prompt contributions, documentation access by path and context-only filtering |
| 32 | `README.md`, `RELEASE-NOTES.md`, `MIGRATION.md` and repository search: switcher removed, removal notices retained |

## Constraints and handoff

This is the gate, not a place to build features. Defects found here are fixed in the owning ticket's code with a regression test, or recorded as known limitations if deliberately deferred.
