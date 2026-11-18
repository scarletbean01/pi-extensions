# 06: Fail the launch on an unknown allowed skill

**What to build:** When a persona names a skill Pi did not discover, that agent fails its launch and does no work, and the error names the persona and the skill, so a typo can never silently narrow or widen an agent.

**Blocked by:** 05 (allowed-skills flag and worker filter)

**Status:** done — merged to main (`2ef10b7`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] The worker's readiness record gains optional fields reporting the skills it kept and any names that matched nothing; the record's version rules, fail-closed readers and compatibility fixtures are respected, and old records still read.
- [x] An agent with an unmatched name is marked as failed at launch, before any assignment work, with an error naming the persona and the skill.
- [x] Other agents keep their own readiness outcomes; the existing run-wide readiness barrier still prevents release when a launch fails.
- [x] An agent whose names all match proceeds normally and its readiness record lists the skills it kept.
- [x] `bootstrap_status` shows the launch failure and its reason; recovery and cleanup treat the failed agent like any other launch failure.
- [x] Documentation explains that unknown skill names are caught at agent start, not in the dry run.

## Verification

- Deterministic worker tests with fixture readiness records: all matched, one unmatched, several unmatched, empty list.
- A runtime or fake-launch test showing the failure surfaces through `bootstrap_status` with the right message.

## Constraints and handoff

Do not add plan-time skill discovery; matching stays against what the child's Pi has already discovered. Reuse the existing launch-failure paths instead of inventing a new terminal state.
