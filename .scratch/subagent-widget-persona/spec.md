# Subagent widget personas: launch a subagent as a persona

Status: ready-for-agent. Prepared 2026-11-27 from a grill-with-docs session (13 decisions, all accepted as recommended). Vocabulary follows `GLOSSARY.md`: **Persona**, **Subagent** (updated by this session: a subagent may optionally be launched with a persona, and is still not an **Agent** or a node of a run), **Allowed skills**, **Model alias**, **Thinking level**. No ADR: every decision is easy to reverse.

## Problem Statement

A subagent launched with `/sub` or `subagent_create` always runs as a generic Pi session. Its system prompt is Pi's default. Its model, thinking level, tools and skills come only from per-launch flags or the parent's own settings. A user who has already written a persona (for example a `reviewer` with a model alias, `tools: read, grep` and a focused prompt) cannot reuse it for a side task. They must repeat the model, thinking level, tool and skill choices by hand on every launch, and the persona's instructions never reach the subagent.

## Solution

A subagent can be launched as a persona. The user names the persona and the subagent takes its instructions, model, thinking level, tools and skills from the persona file, resolved the same way Bootstrap resolves them for an agent. Per-launch flags still override the persona. A launch that names no persona behaves exactly as it does today.

- `/sub --persona <name> <task>` and an optional `persona` parameter on `subagent_create`.
- The persona's body goes in front of Pi's base prompt, with the Pi-docs section removed, as Bootstrap does.
- Model and thinking level come from the persona; skills come from its `skills:` list; tools come from its `tools:` list.
- Continuing a persona subagent keeps its persona. The persona does not change mid-conversation.
- The widget shows the persona name next to the subagent.

## User Stories

1. As a user, I want to launch a subagent with `--persona reviewer`, so that it works with the instructions I already wrote for that persona.
2. As a parent agent, I want a `persona` parameter on `subagent_create`, so that I can launch a persona subagent when the user names one.
3. As a user, I want a launch without a persona to behave exactly as it does today, so that nothing I rely on changes.
4. As a user, I want personas found in the same places Bootstrap finds them (project `.pi/agents`, then the global agents folder, case-insensitive), so that one persona file serves both Bootstrap agents and subagents.
5. As a user, I want the persona's body placed in front of Pi's normal prompt, with the Pi-docs section stripped, so that a persona subagent behaves like a Bootstrap agent.
6. As a user, I want the persona's `model:` (an alias, a full provider/model ID, or either with a thinking suffix) to choose the subagent's model, so that a reviewer persona runs on its reviewer model.
7. As a user, I want the persona's thinking level to apply, including `off`, `minimal` and `max`, so that the persona is not forced into the four levels the flag accepts.
8. As a user, I want a persona with no `model:` to use the parent's model, so that a minimal persona still works.
9. As a user, I want an explicit `--model` or `--thinking` to win over the persona, so that I can adjust one launch without editing the file.
10. As a parent agent, I want `thinking` to be optional on `subagent_create` when a persona is given, so that the persona's level is used and I am not made to pick one.
11. As a user, I want a persona's `tools:` list used exactly as written, so that a read-only reviewer cannot edit and a builder persona can.
12. As a user, I want a persona with no `tools:` line to get the current read-only set, so that an unrestricted persona does not silently gain write access.
13. As a user, I want `--write` combined with `--persona` to be rejected with a clear error, so that two sources of tool access never disagree.
14. As a user, I want a persona's `skills:` names loaded into the subagent, so that the persona has the skills it declared.
15. As a user, I want a persona with no `skills:` line, or an empty one, to load no skills, so that persona subagents stay as lean as other subagents.
16. As a user, I want an unknown skill named by a persona to fail the launch, naming the persona and the skill, so that a typo never silently drops a skill.
17. As a user, I want `--skills` on a persona launch to add to the persona's skills for that launch, so that I can extend a persona for one task.
18. As a user, I want a persona's `extensions:`, `color` and `description` ignored by subagents, so that a subagent does not load Coms or other graph-only extensions or pay their startup cost.
19. As a user, I want an unknown persona name to fail before any process starts, naming where I searched, so that I notice the typo at once.
20. As a user, I want an unknown model alias, an invalid model suffix or an invalid persona `thinking:` to fail the launch with the persona file and field named, so that nothing silently runs on a different model.
21. As a user, I want `/subcont` to keep the subagent's persona, prompt, tools and skills, so that a follow-up continues the same conversation as the same persona.
22. As a user, I want editing a persona file after launch not to change a subagent that already started, so that its conversation stays coherent.
23. As a user, I want `--persona` and `--write` rejected when continuing, so that a conversation cannot change who it is part-way through.
24. As a user, I want `--model` and `--thinking` still allowed when continuing, and sticky as today, so that I can switch them on purpose.
25. As a user, I want `--skills` on a continue to add to the persona's skills for that turn only, so that a one-off need does not change the subagent.
26. As a user, I want the widget row and the `/sub` and `/subcont` info lines to show the persona name with the model and thinking level, so that I can tell my subagents apart.
27. As a parent agent, I want the result sent to me unchanged by this feature, so that a persona subagent costs me no more context than any other.
28. As a parent agent, I want the tool description not to list personas, so that I pay no tokens for a list that depends on the folder.
29. As a maintainer, I want persona parsing, discovery and model resolution reused from Bootstrap, so that a persona means the same thing for an agent and a subagent.

## Implementation Decisions

- **Module boundary.** The widget gains a persona resolution step that runs before a subagent is created. It uses Bootstrap's persona discovery, persona file parsing, model and thinking resolution and the `bootstrap.json` alias reader. This adds a dependency from the widget extension on Bootstrap's shared helper modules. The widget does not reimplement persona rules.
- **Resolution result.** Resolving a persona yields: the persona name and file, the prompt text, the model, the optional thinking level, the tools list, and the allowed skill names. The result is a snapshot stored on the subagent's state at creation. Continuations read it from the state, never from the file.
- **Precedence.** Model and thinking: explicit flag or tool parameter, then persona (suffix, then `thinking:`, then alias level), then the parent's model and level as today. Tools: a non-empty persona list, otherwise the read-only set. Skills: persona names, plus any per-launch `--skills` names.
- **Thinking range.** The `/sub` flag and the `subagent_create` parameter keep their four values. A persona's level may be any Bootstrap thinking level and is passed through unchanged. With a persona, the tool's `thinking` parameter is optional; without one it stays required.
- **Prompt delivery.** The child already loads a helper extension that removes the Pi-docs section in `before_agent_start`. That helper also puts the persona text in front of the base prompt when the launch has a persona. The persona text reaches the child through the launch environment or a file the launch owns, not through a position in the task prompt. The persona body is never placed in the task text, so it cannot be mistaken for a flag or attachment.
- **Tools.** The persona's list is passed to the child as its tool list exactly as written. Names are passed through; the child's own tool handling reports names it does not know.
- **Skills.** Persona skill names go through the widget's existing skill resolver, so names and paths resolve the same way as for `--skills`. A name that does not resolve fails the launch with the persona and skill named. `none` is not special-cased beyond what Bootstrap already reserves.
- **Ignored persona fields.** `extensions:`, `color` and `description` have no effect on a subagent. The child keeps `--no-extensions` apart from the helper.
- **Errors.** Unknown persona, unknown alias, invalid suffix, invalid `thinking:` and unresolved skill all fail the launch before any child process starts. The message names the persona file and the field. The failure surfaces the way other launch failures do, to the caller of the tool or the command, and a queued launch reports it as it already reports queued failures. Nothing falls back to another model or to a persona-less launch.
- **Rejected combinations.** `--write` with a persona, on launch or on continue. `--persona` on continue. These are usage errors with a clear message and no child process.
- **Continuation.** The state holds the persona snapshot. A continue reuses prompt, tools and skills from it, applies the existing sticky model and thinking behaviour, and adds `--skills` names for that turn only.
- **Display.** The persona name is part of the widget row and of the `/sub` and `/subcont` info line. The result text delivered to the parent and the notify-only notice are unchanged.
- **Tool schema.** `subagent_create` gains an optional `persona` string parameter described as "only if the user names a persona". The tool description does not enumerate personas. `subagent_continue` gains no persona parameter.
- **Concurrency pool, batching, bounded results, lifecycle cleanup and lazy management tools** are unchanged.
- **Documentation.** The widget's usage documentation gains a short section on persona subagents: how to launch one, what each persona field does for a subagent, what is ignored, and the precedence rules. The Bootstrap README's persona section gets one line saying a persona can also back a subagent and which fields apply. `GLOSSARY.md` is already updated.

## Testing Decisions

- **One seam.** Tests go through the existing subagent widget harness: the extension is loaded against the host stub, and a fake Pi executable (selected by the `SUBAGENT_PI_BINARY` seam) records its argv and environment. Tests assert what the child was launched with and what the parent saw, never internal functions.
- **Child helper.** One unit-level test covers the helper extension's prompt order: persona text first, then Pi's base prompt with the docs section removed, and an unchanged prompt for a launch with no persona.
- **A good test** checks external behaviour: the child's model, thinking level, tool list, skills and prompt delivery for a given persona file and flags; the error text and the absence of a child process for each failure; the widget and info-line text; the state a continue reuses. It does not check how resolution is split into functions.
- **Cases to cover.** No persona (unchanged launch, byte-for-byte argv); persona with alias model and thinking; persona with a full ID and suffix; persona with no `model:`; each precedence rule (flag over persona, persona over parent); `off`/`minimal`/`max` pass-through; tools listed versus absent; `--write` rejection on launch and continue; skills present, absent, empty and unknown; `--skills` added to a persona's; ignored fields; each launch error; continue keeping the snapshot after the persona file changes; `--persona` rejected on continue; display text; tool schema optionality of `thinking`.
- **Prior art.** The existing widget tests for lean launch (argv assertions), launch failures and queued failures, `/subcont` model and thinking stickiness, and the widget text assertions. Bootstrap's own tests cover persona parsing and model resolution; they are not repeated here.
- **Persona fixtures** are written into a temporary project and global agents folder per test, so tests never read the user's real personas.

## Out of Scope

- Persona `extensions:` for subagents, including Coms and other graph-only extensions.
- Skills for persona subagents beyond the persona's listed names. "All discovered skills" is not offered.
- Changing the persona of an existing subagent, or editing a snapshot.
- Listing or discovering personas in the tool description or through a new command.
- Replacing Pi's base prompt entirely.
- Making a subagent an agent or a node, or giving it Coms, handoff, ownership or evidence behaviour.
- Any change to Bootstrap's own persona rules, aliases or the planning flow.
- Showing the persona name in the result text sent to the parent.

## Further Notes

- Where a persona subagent differs from a Bootstrap agent: no extensions, no Coms registration, and skills default to none instead of all.
- Persona files are trusted the way they already are for Bootstrap. A persona's `tools:` can include write tools, so a launch from a persona is a deliberate grant of write access by whoever wrote the persona.
- The work splits naturally into tracer-bullet tickets: persona resolution and launch errors; child prompt delivery; tools, skills and model wiring; continuation and display; documentation.
