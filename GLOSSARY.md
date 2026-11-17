# Pi extensions

Extensions for the Pi coding agent. Bootstrap launches a graph of Pi agents from persona files so a team can split work.

## Language

**Persona**:
A markdown file with frontmatter that defines who an agent is: its description, model, tools, extensions and allowed skills, plus the system prompt in its body.
_Avoid_: Agent file, agent definition, agent (for the file)

**Agent**:
A running Pi instance launched from a persona. One persona can back several agents.
_Avoid_: Worker (for the instance as a whole), subagent

**Skill**:
A directory with a `SKILL.md` that Pi advertises to the model by name and description and loads only when the task calls for it.
_Avoid_: Plugin, command

**Allowed skills**:
The skills a persona permits its agents to see. A persona that declares no allowed skills leaves its agents every skill Pi discovers; one that declares an empty list gives them none.
_Avoid_: Skill filter, skill whitelist

**Thinking level**:
How much reasoning effort an agent's model is asked to spend: off, minimal, low, medium, high, xhigh or max.
_Avoid_: Reasoning level, effort

**Model alias**:
A short name a user defines that stands for a full provider/model ID, and optionally a thinking level, in a persona's `model:` field.
_Avoid_: Model shortcut, model nickname
