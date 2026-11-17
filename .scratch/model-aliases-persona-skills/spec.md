# Configurable model aliases, narrower persona discovery and allowed skills

Status: specification draft; every grilling recommendation below was accepted by the user. Prepared 2026-11-17. No implementation is authorized by this document. Vocabulary follows `GLOSSARY.md` at the repository root: **persona** (the file), **agent** (the running instance), **skill**, **allowed skills**, **model alias**.

## Problem Statement

A user who bootstraps a graph of agents cannot control how much context each agent spends before it starts working.

- Every agent is launched with every skill Pi discovers. Skills are about 80% of a default Pi system prompt (9.2 KB of 11.4 KB measured with 13 skills installed), and a reviewer or scout never needs most of them.
- Model aliases are a hardcoded table inside the extension. The user cannot add, remove or retarget an alias without editing code, the shipped aliases are obsolete for this user, and there is no way to attach a thinking level to an alias.
- Personas are discovered from nine directories across four tools' conventions (`.pi`, `.claude`, `.gemini`, `.codex` and a plain `agents` folder, project and global). The user only wants Pi's own folders to count.
- A bootstrapped agent's prompt also carries Pi's harness-documentation block, which a worker assigned a concrete task almost never needs.
- A dedicated interactive persona switcher (`system-select`) duplicates persona handling that bootstrap already does, and it is the only reason persona discovery has to be shared.

## Solution

1. Model aliases become user data. The user defines them in a `bootstrap.json` file, globally or per project. The extension ships none. An alias names a full model and may carry a thinking level.
2. A persona can declare its thinking level separately from its model, and the existing suffix form keeps working.
3. Persona discovery narrows to Pi's own folders: the project `.pi/agents` and the global `~/.pi/agent/agents`.
4. A persona can declare **allowed skills**. Bootstrap launches each agent with exactly that list, so the model is told about only those skills.
5. A bootstrapped agent's system prompt drops Pi's documentation block.
6. The interactive persona switcher is deleted.

The persona prompt still complements Pi's default prompt, as it does today. Nothing replaces the default prompt.

## User Stories

1. As a user, I want to define my own model aliases in a JSON file, so that I choose which models my personas can name.
2. As a user, I want a global alias file and a project alias file, so that a repository can retarget an alias without changing my other projects.
3. As a user, I want the project alias to win over a global alias of the same name, so that I can override locally.
4. As a user, I want an alias to carry a thinking level, so that `sonnet` always means the model and the effort I prefer.
5. As a user, I want my alias names to be case-insensitive, so that `Sonnet` and `sonnet` are the same.
6. As a user, I want no built-in aliases, so that no obsolete model name is ever picked for me.
7. As a user, I want an unknown alias in a persona to stop the plan with a clear error, so that a typo never launches a different model.
8. As a user, I want a persona to be able to name a full provider/model instead of an alias, so that I need no alias for one-off models.
9. As a user, I want a thinking level on a persona's model line, so that the quick suffix form keeps working.
10. As a user, I want a separate `thinking:` field in the persona, so that the level is not squeezed into the model name.
11. As a user, I want the suffix to beat the `thinking:` field and the field to beat the alias level, so that the most specific setting wins.
12. As a user, I want an invalid thinking level in any of those places to stop the plan naming where it came from, so that a typo is never silently ignored.
13. As a user, I want a persona without a model to inherit the model of the session that launched it, so that simple personas need no model line.
14. As a user, I want a clear error when a persona has no model and nothing can be inherited, so that no hardcoded model is ever chosen for me.
15. As a user, I want a missing `bootstrap.json` to mean "no aliases", so that I can start without creating one.
16. As a user, I want a broken `bootstrap.json` to stop the plan naming the file and the key, so that a config mistake is never ignored quietly.
17. As a user, I want personas discovered only from `.pi/agents` in my project and `~/.pi/agent/agents`, so that one registry decides what exists.
18. As a user, I want a project persona to win over a global persona of the same name, so that a project can specialize.
19. As a user, I want clear migration guidance for moving personas out of other tools' folders, so that nothing silently disappears without explanation.
20. As a user, I want a persona to list its allowed skills by name, so that I control what each agent is told about.
21. As a user, I want a persona with no skills field to keep every skill, so that existing personas behave as before.
22. As a user, I want an empty skills field to mean "no skills", so that a narrow worker can carry zero skill descriptions.
23. As a user, I want bootstrap to pass the allowed skills to the launched agent, so that the agent's prompt lists only those skills.
24. As a user, I want a launch to fail when a persona names a skill Pi did not discover, so that a typo cannot silently widen or narrow an agent.
25. As a user, I want that failure to name the persona and the skill, so that I know what to fix.
26. As a user, I want the dry run to show each agent's allowed skills, so that I can review the plan before launching.
27. As a user, I want bootstrapped agents to omit Pi's harness-documentation block, so that workers do not pay for text they do not use.
28. As a user, I want an agent that needs Pi's documentation to still be able to read it by path when its task says so, so that dropping the block loses no capability.
29. As a user, I want the allowed-skills limit described as context saving rather than a permission boundary, so that I do not rely on it for security.
30. As a maintainer, I want one place that decides which skills and prompt text a bootstrapped agent receives, so that behavior is consistent across agents.
31. As a maintainer, I want a test that inspects what a launched agent actually sends to its provider, so that a Pi upgrade that changes prompt wording is caught.
32. As a maintainer, I want the interactive persona switcher removed along with its references, so that no dead persona code path remains.

## Implementation Decisions

**Model alias configuration**

- Aliases live in a `bootstrap.json` file. There is a global file in the Pi agent directory and an optional project file in the project's `.pi` directory, following the same global-plus-project pattern as the sandbox configuration. The file is a JSON object whose `modelAliases` key maps an alias name to an alias definition. The top-level key leaves room for other bootstrap settings later.
- An alias definition is an object with a required `model` field (a full `provider/id`) and an optional `thinking` field. There is no plain-string shorthand: the verbose form is the only form.
- Alias names are case-insensitive. Two names in one file that differ only by case are invalid.
- The project file's entry for an alias replaces the global entry for that alias as a whole. Fields are not merged across files.
- The extension ships no aliases. The hardcoded table and the hardcoded last-resort model are removed.
- Accepted thinking levels are exactly `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.
- A missing file means no aliases. A file that does not parse, an alias that is not an object, a missing or malformed `model` (no `/`), or an invalid `thinking` value stops planning with an error that names the file and the key. Nothing is launched.

**Model resolution**

- A persona's `model:` is an alias name or a full `provider/id`, with an optional `:thinking` suffix on either form. A value containing `/` is a full ID and is passed through as written; otherwise it must be a defined alias or planning stops, as unknown aliases do today.
- A persona may also set `thinking:`. The effective level is the first of: the suffix on `model:`, the persona's `thinking:` field, the alias's `thinking`. A suffix that disagrees with the field is not an error; the suffix wins. An invalid level in any of the three places stops planning and names the source.
- A persona with no `model:` inherits the launching session's model. With nothing to inherit, planning stops with an error naming the persona. The hardcoded fallback model no longer exists.
- The expected-model check that already runs after launch keeps ignoring the thinking level and keeps accepting a dated snapshot of an undated ID.
- The resolved model and the effective thinking level are shown in the dry-run plan.

**Persona discovery**

- Personas are discovered from the project `.pi/agents` directory and then the global `~/.pi/agent/agents` directory only. The project directory wins on a name clash, names compare case-insensitively, and filenames are ordered deterministically, as today. The seven other directories are no longer scanned.
- The team definition file already lives under the project `.pi/agents` directory and is unaffected.
- There is no automatic fallback to the old locations. Migration is manual and documented: copy the persona files into the global directory, then define the aliases they use in the global `bootstrap.json` or change their `model:` lines to full IDs. The user's six existing personas (in `~/.claude/agents`) need this once.
- The bootstrap documentation's description of discovery is updated to the two directories.

**Allowed skills**

- A persona's frontmatter may contain `skills:`, a comma-separated list of skill names, in the same flat style as `tools:` and `extensions:`. A name is the `name` declared in the skill's own file, which is the name Pi shows the model, and is matched exactly.
- Absent field: the agent keeps every skill Pi discovers, as today. Present but empty: the agent keeps none.
- Bootstrap passes the persona's allowed skills to each launched agent through a dedicated launch flag carrying the comma-separated names. An empty list is encoded with the single reserved value `none`, so a skill literally named `none` cannot be allowed. An absent field means the flag is not passed.
- The worker extension, which is already loaded in every bootstrapped agent, registers the flag and removes every skill not on the list from the prompt inputs before the model is called. Matching happens against the skills Pi has already discovered, so bootstrap does no skill discovery of its own.
- The worker reports the skills it kept, and any names that matched nothing, in its readiness record. An agent with an unmatched name fails its launch and does no work. The error names the persona and the skill. Bootstrap's dry run does not check skill names; it shows the persona's allowed skills as written.
- The readiness record gains optional fields for this. Records stay versioned and readers stay fail-closed, following the rules already used for persisted bootstrap records. The resolved plan, and therefore the request fingerprint that lets a retried request find its run, includes each agent's allowed skills and thinking level, so a changed persona is detected as a different plan.
- A graph node cannot override or extend its persona's skills. Two nodes that need different skills use two personas.
- Allowed skills limit what the model is told about, to save context. They are not a permission boundary: an agent can still read a skill file by path, and a human can still invoke a skill command.

**Prompt shape for bootstrapped agents**

- The persona prompt still complements Pi's default prompt. It is placed in front of the default prompt exactly as today. Nothing replaces the default prompt.
- The worker removes Pi's harness-documentation block from every bootstrapped agent's prompt. There is no persona setting for this. Pi exposes no structured option for that block, so the worker removes it from the finished prompt text; if the block is absent or renamed by a later Pi version, nothing is removed and the agent runs with a larger prompt. A worker that needs Pi's documentation can still read it by path.
- Prompt text and tool guidelines contributed by other extensions (for example task-list rules) are not touched.
- Applying the allowed-skills list and removing the documentation block are independent and combine correctly. This was verified against Pi: the filtered skills list is honored even when the worker returns a full prompt with the persona in front.

**Removal of the interactive persona switcher**

- The `system-select` extension is deleted, together with its entry in the theme mapping, its comment mention in the shared utilities and the sentence in the bootstrap documentation that says personas share a registry with it. The `/system` command, the `--agent` flag and the persona-cycling shortcuts cease to exist. Persona handling is then owned entirely by bootstrap.

## Testing Decisions

A good test checks behavior a user can observe: the plan bootstrap reports, the flags it launches with, and what a launched agent actually sends to its provider. Tests do not assert on module internals.

- **Highest seam, runtime:** launch a real child through the existing runtime test suite with a hook that captures the outgoing provider request and then stops the agent. Assert that only the allowed skills appear, that the persona text is present, that the documentation block is absent, that an empty list yields no skills and that an absent field yields all of them. This catches a Pi upgrade that changes prompt wording or the skills mechanism.
- **Plan seam, deterministic:** dry-run planning through `bootstrap_generate`. Assert alias resolution (global, project override, case-insensitivity, full IDs, unknown alias), the three-way thinking precedence, invalid levels, the missing-model error, broken-config errors that name the file and key, persona discovery from the two directories only, and the allowed skills and thinking level shown in the plan and included in the fingerprint.
- **Worker seam, deterministic:** the worker's handling of the allowed-skills flag, the unmatched-name failure and the readiness record fields, using the existing worker test fixtures.
- **Existing tests to change:** the assertion that checks the shipped aliases for retired models is removed with the table. The persona discovery tests change to the two directories.
- **Prior art:** the runtime, deterministic and live suites and fixtures in the existing test harness, the resolution tests in the lifecycle tests, the frontmatter and discovery tests in the utility tests and the fake-launch fixtures used by the worker tests.

## Out of Scope

- Replacing Pi's default prompt with a persona prompt, including an opt-in "replace" mode. The behavior stays complement-only.
- Honoring allowed skills, or the persona's model, in an interactive session. The only interactive persona tool is being deleted.
- Per-node overrides of skills or model in a bootstrap graph.
- Plan-time validation of skill names. An unmatched name is caught when the agent starts.
- Configuring which extensions a persona's agent loads, including excluding globally installed extensions and trimming rules that other extensions add to the prompt. A persona can already name extra extensions; the wider question is reserved for a later session.
- Dropping context files such as AGENTS.md from a worker's prompt.
- Automatic fallback to persona directories of other tools, or an automatic migration tool.
- Treating allowed skills as a security boundary.

## Further Notes

Assumptions made while writing this spec that were not explicitly discussed. Please confirm or correct:

- Skill names are matched exactly and case-sensitively.
- A persona's `thinking:` applies to the effective model even when the model is inherited from the launching session.
- The project alias file replaces a global alias entry as a whole instead of merging fields.
- Two alias names that differ only by case in the same file are an error.
- The readiness record gains optional fields and keeps its current version rules.

Measurements behind the decisions (stock Pi, 13 skills, no extra extensions): default prompt 11,421 characters, of which skills 9,208, documentation 1,086, rules 589, tools 274. Keeping one skill and removing the documentation block reduced the provider request from 16.6 KB to 7.1 KB.
