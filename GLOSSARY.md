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
The skills Pi advertises in a persona's agent prompts. Omitting `skills:` keeps every discovered skill; an explicit empty list advertises none. This saves prompt context; it does not restrict access to skill files.
_Avoid_: Skill filter, skill whitelist

**Thinking level**:
How much reasoning effort an agent's model is asked to spend: off, minimal, low, medium, high, xhigh or max.
_Avoid_: Reasoning level, effort

**Model alias**:
A short name a user defines that stands for a full provider/model ID, and optionally a thinking level, in a persona's `model:` field.
_Avoid_: Model shortcut, model nickname

### Runs and graphs

**Run**:
One launch of a plan of nodes, from release to cleanup, identified by its task ID.
_Avoid_: Job, session (for the whole launch)

**Node**:
One planned assignment in a run, with its own ID, backed by one agent.
_Avoid_: Task (for the assignment), step, member

**Attempt**:
One execution of a node. A revision is a new attempt of the same node by the same agent. (In a software factory, a launch attempt is a different thing: one try to launch an input as a run.)
_Avoid_: Retry, try, run (for a single execution)

**Edge**:
A dependency from a source node to a destination node: the destination needs the source's result.
_Avoid_: Link, arrow

**Join**:
A node with more than one inbound edge, which starts only once all of them are satisfied.
_Avoid_: Merge (for the node kind), barrier

**Decision node**:
A node whose verdict routes the run: forward on approval, back to an earlier node on rejection.
_Avoid_: Gate, router

**Feedback edge**:
The edge a rejecting decision node follows back to the earlier node it asks to revise.
_Avoid_: Back edge, retry edge

**Loop body**:
The nodes from a feedback edge's target forward to its decision node, inclusive; they are re-run together on each revision.
_Avoid_: Cycle, loop (for the set of nodes)

**Parked**:
The state of a loop-body agent that has submitted an attempt and waits, alive and idle, for a revision or finalization.
_Avoid_: Sleeping, suspended, leased

**Finalization**:
The point after which a parked node can no longer be revised and its latest attempt's outcome becomes final.
_Avoid_: Release, close

**Cancellation intent**:
The durable record that an operator asked a run to stop. It is not settlement: a cancelled run may still have in-flight work.
_Avoid_: Cancelled (for a run whose workers have not acknowledged)

**Settlement**:
Reliable evidence that no original attempt, revision or in-flight tool of a run can still act. Settlement (or proof that a launch never released) is what frees a factory's capacity holds.
_Avoid_: Done, finished, closed

**Resource closure**:
Whether a run's tabs and panes are closed. Independent of settlement and of the run's outcome.

**Outstanding attention**:
What a failed or unresolved run leaves for the operator to look at after it settles.

**Redelivery**:
Resending one handoff that nothing has claimed to its live destination, never replaying accepted work.
_Avoid_: Retry (for handoffs; retry is for launches)
