# 04: Set the thinking level from the persona or the alias

**What to build:** An agent's thinking level can come from the suffix on `model:`, from a separate `thinking:` field in the persona, or from the alias. The strongest present source wins, and the effective level is planned, shown, fingerprinted and passed to the launched child.

**Blocked by:** 03 (alias definitions)

**Status:** ready-for-agent

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [ ] The persona frontmatter accepts `thinking:`; accepted levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.
- [ ] The effective level is, in order, the suffix on `model:`, the persona's `thinking:`, then the alias's `thinking`. A suffix that disagrees with the field is not an error.
- [ ] An invalid level in any of the three places fails the plan with an error naming the source (persona file or alias and file).
- [ ] A persona's `thinking:` applies to the effective model even when the model is inherited from the launching session.
- [ ] The dry-run plan shows the resolved model and effective level for each agent.
- [ ] The request fingerprint includes the effective level, so a retried request against a changed persona or alias is detected as a different plan.
- [ ] The launched child runs with the effective level, and the post-launch model check still ignores the level and still accepts a dated snapshot of an undated ID.

## Verification

- Dry-run matrix covering every combination of present and absent sources, including conflicts.
- Fingerprint test: same request before and after changing only the alias level.
- Runtime check that the launched child reports the intended level (using the capture seam if useful).

## Constraints and handoff

Persisted plan records are versioned and readers fail closed; any new persisted field follows the existing versioning rules and compatibility fixtures. This ticket and ticket 05 both touch the plan and its fingerprint: merge the integration tip before reporting done.
