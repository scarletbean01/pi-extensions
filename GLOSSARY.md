# Pi extensions

Extensions for the Pi coding agent. Bootstrap launches a graph of Pi agents from persona files so a team can split work.

## Language

**Persona**:
A markdown file with frontmatter that defines who an agent is: its description, model, tools, extensions and allowed skills, plus the system prompt in its body.
_Avoid_: Agent file, agent definition, agent (for the file)

**Agent**:
A running Pi instance launched from a persona. One persona can back several agents.
_Avoid_: Worker (for the instance as a whole)

**Subagent**:
A short-lived child Pi session the parent launches to do one side task and report back. It is not a node of a run. It may optionally be launched with a persona, which supplies its prompt, model, thinking level, tools and skills; without one it uses the parent's model and the lean defaults. By default the parent hears back once per turn, with a bounded final message; a notify-only subagent shows its result to the user without waking the parent model.
_Avoid_: Agent (a subagent is not a node of a run, even when it uses a persona), node

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

**Software factory**:
A long-lived entity that accepts inputs and starts a separate run for each input. It remains the same factory when its definition changes.
_Avoid_: Factory definition version, run, graph execution

**Factory definition version**:
An immutable published definition of what a software factory will launch for an input.
_Avoid_: Factory ID, run plan

**Factory input**:
A work brief submitted to one software factory for a separate run.
_Avoid_: Run, node assignment

**Input admission**:
Durable acceptance of a factory input, independent of whether its run has started.
_Avoid_: Run launch, node admission

**Submission reference**:
An identifier for one intended submission to a factory, reused when checking or retrying that submission.
_Avoid_: Input ID, run ID

**Launch attempt**:
One try to start a run for a factory input. It can end before any node is allowed to execute.
_Avoid_: Node attempt, run retry

**Capacity hold**:
A reservation of both a factory's run slot and its checkout for a launch attempt or its run.
_Avoid_: Manager ownership, node ownership, tab ownership

**Operator clearance**:
A person's recorded decision to release an uncertain capacity hold after establishing that conflicting work cannot resume, without resolving what already happened.
_Avoid_: Successful settlement, cancellation, rollback

**Intervention request**:
An enabled agent's request for human direction during its node attempt. The requesting attempt waits for a response or for the request to be terminated.
_Avoid_: Approval gate, pause (for the request)

**Routing choice**:
A plan-defined option a person can select in an intervention request to bind the requesting decision node’s verdict for that attempt.
_Avoid_: Free-text guidance, verdict

**Run**:
One launch of a plan of nodes, from release to cleanup, identified by its task ID.
_Avoid_: Job, session (for the whole launch)

**Run graph**:
A view of one run’s nodes and edges, including their observed execution state. For a factory run, its topology comes from the factory definition version bound to that run’s input, not the current version.
_Avoid_: Factory definition graph (for a specific run)

**Node**:
One planned assignment in a run, with its own ID, backed by an agent or a deterministic command (`kind: "command"`).
_Avoid_: Task (for the assignment), step, member

**Command node**:
A deterministic node (`kind: "command"`) executed directly as a spawn `argv` command without a Pi session or language model, recording real exit, signal, and process-group `command_evidence`.
_Avoid_: Shell step, script hook

**Attempt**:
One execution of a node. A revision is a new attempt of the same node by the same agent. (In a software factory, a launch attempt is a different thing: one try to launch an input as a run.)
_Avoid_: Retry, try, run (for a single execution)

**Attempt output**:
What an attempt recorded as its report when it finished: its status, summary and detail, plus any verification, warnings and next steps it listed. People see it in scrubbed, bounded form. It is not a transcript or a log, and it does not exist until the attempt has finished.
_Avoid_: Log, transcript, agent message, agent output

**Edge**:
A dependency from a source node to a destination node: the destination needs the source's result.
_Avoid_: Link, arrow

**Join**:
A node with more than one inbound edge, which starts only once all of them are satisfied.
_Avoid_: Merge (for the node kind), barrier

**Decision node**:
A node whose verdict routes the run: forward on approval, back to an earlier node on rejection.
_Avoid_: Gate, router

**Verdict**:
The approval or rejection outcome recorded on a successful decision node attempt. It is distinct from the human’s routing choice and from whether the route could be carried out.
_Avoid_: Response, result status

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

**Stopped factory**:
A durable management state that rejects new admissions and launch starts after acknowledgement while preserving queued inputs, running work, capacity holds and existing run controls. Management may remain active; only explicit resume clears the stop.
_Avoid_: Cancelled (for factory stop), paused run

**Deleted factory**:
A software factory a person has permanently retired. It leaves the default listing and refuses every action that would change it or its work, while its definition versions, receipts and run evidence stay inspectable. Its name stays reserved. It is only possible when the factory has no active work, no uncertainty, no pending requests, no pending constraint proposals and no queued inputs left to launch, and it is not reversible.
_Avoid_: Purged factory, stopped factory, archived factory

**Discarded input**:
An accepted input whose receipt is retained permanently but which is removed from launch eligibility after direct human confirmation and commit-time revalidation.
_Avoid_: Deleted input, cancelled run

**Settlement**:
Reliable evidence that no original attempt, revision or in-flight tool of a run can still act. Settlement (or proof that a launch never released) is what frees a factory's capacity holds.
_Avoid_: Done, finished, closed

**Operator clearance**:
A human's recorded decision to release the capacity holds of a run whose release is uncertain, after establishing that its original work cannot resume. It retires the input from launch eligibility and is shown apart from settlement: it does not settle the run, change its outcome, undo effects or launch anything, and repeating the work needs a new submission. It is never possible while evidence shows conflicting work may still resume.
_Avoid_: Force release, unlock, reset

**Host**:
The terminal multiplexer that launches a run's nodes and holds their terminals. Whether a node is alive is decided from durable records, never from what the Host reports.
_Avoid_: Runtime, multiplexer, terminal backend

**Host backend**:
One implementation of the Host, `herdr` or `hc`. It is chosen when a run is launched and recorded in the run's manifest, and the run keeps it for life.
_Avoid_: Driver, adapter, runtime

**Resource closure**:
Whether a run's node terminals are closed. Independent of settlement and of the run's outcome.

**Outstanding attention**:
What a failed or unresolved run leaves for the operator to look at after it settles.

**Handoff**:
The transfer of one attempt's saved result to the next node's attempt. Delivering it is not accepting it: the destination accepts it by claiming it before doing any work, and whoever claims first owns it.
_Avoid_: Message, notification, delivery (for the whole transfer)

**Redelivery**:
Resending one handoff that nothing has claimed to its live destination, never replaying accepted work.
_Avoid_: Retry (for handoffs; retry is for launches)

**Wake-up**:
A message that tells a handoff's destination to look at its durable handoff offer. It carries no authority: the destination acts only if the offer on record matches, and accepting the handoff is a separate step.
_Avoid_: Notification, ping, trigger

**Direction request**:
An intervention-enabled, admitted attempt's durable ask for a human decision. It holds a question, reason, evidence, presented plan choices and an optional recommendation. At most one per attempt is pending; silence is indefinite waiting, never consent or decline.
_Avoid_: Prompt, approval request

**Human wait**:
The time an admitted attempt is blocked on its pending direction request. It is excluded from that attempt's task deadline and counts as useful upstream progress only along dependent paths; it does not hide requester loss or relax deadlines on unrelated branches.
_Avoid_: Timeout exemption (unbounded blanket exemption)

**Plan choice**:
An option a node's definition lets its agent offer a person. A person selects one of the presented choices or explicitly declines; free text alone is not a response.
_Avoid_: Route (ordinary choices do not map to a verdict)

**Routing choice**:
A plan choice on an intervention-enabled decision node that maps to an existing verdict. Once selected, it binds only that attempt. A valid successful result records the verdict; a destination's own admission claim proves it accepted that result.
_Avoid_: Approval as a synonym for a successful result or admitted successor

**Response recorded / consumed**:
Two separate observations. Recorded: the manager's single saved answer. Consumed: the waiting attempt durably claimed it before continuing. A recorded response can stay unconsumed forever if cancellation or failure wins; it never revives a dead attempt.
_Avoid_: Delivered, acknowledged

**Risk lane**:
A deterministic classification (`contained`, `wide`, or `closed`) of a decision attempt's approval requirement derived strictly from project `.pi/bootstrap.json` `"lanes"` globs and repository snapshots of the loop body's changed paths (`<reviewer>.1.lane-before.json` against `<reviewer>.<n>.lane-after.json`). Most restrictive lane wins (`contained` < `wide` < `closed`), unmatched paths and unknown change scopes fail closed to at least `wide`, models never assign a lane, and `closed` requires a recorded human approval choice for that attempt (or settles `blocked` when the decision node cannot request human approval).
_Avoid_: Trust level, self-declared risk

**Learned constraint**:
A validated project rule in `<project>/.pi/constraints.json` (`id`, `text`, `provenance`, `status: "active" | "retired"`, optional `retirement` provenance). Launch reads the file once, injects active entries into the existing `Constraints:` section of the bounded shared brief for the whole run without modifying or rebinding any published factory definition version, and records the canonical file digest and used IDs in the version 9 (`CONSTRAINTS_VERSION`) run manifest.
_Avoid_: Dynamic prompt patch, per-node rule

**Constraint proposal**:
A persisted candidate rule (`add` or `retire`) recorded in `factory_constraint_proposals` (schema version 12) after a finished factory run that required at least one revision or human intervention, carrying provenance (`run_id`, `attempt_id`, `evidence_ref`), optional `conflicting_ids`, deterministic normalization digest, and outcome (`pending`, `confirmed`, `rejected`, or `dropped_duplicate`). Only human confirmation (`/factory review-proposal`, `/factory retire-constraint`, or `/factory resolve-conflict`) can write, retire, or abandon entries in `.pi/constraints.json`.
_Avoid_: Auto-applied rule, silent rule change
