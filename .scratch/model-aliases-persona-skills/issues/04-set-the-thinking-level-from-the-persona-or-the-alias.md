# 04: Set the thinking level from the persona or the alias

**What to build:** An agent's thinking level can come from the suffix on `model:`, from a separate `thinking:` field in the persona, or from the alias. The strongest present source wins, and the effective level is planned, shown, fingerprinted and passed to the launched child.

**Blocked by:** 03 (alias definitions)

**Status:** done — merged to main (`581fc55`, review follow-up `3f68aa0`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] The persona frontmatter accepts `thinking:`; accepted levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.
- [x] The effective level is, in order, the suffix on `model:`, the persona's `thinking:`, then the alias's `thinking`. A suffix that disagrees with the field is not an error.
- [x] An invalid persona or alias `thinking:` value, or an invalid suffix on an alias, fails planning and names the source. On a full model ID only a recognized level is taken as a suffix, so IDs like `ollama/llama3:8b` pass through.
- [x] A persona's `thinking:` applies to the effective model even when the model is inherited from the launching session.
- [x] The dry-run plan shows the resolved model and effective level for each agent.
- [x] The request fingerprint includes the effective level, so a retried request against a changed persona or alias is detected as a different plan.
- [x] The launched child runs with the effective level, and the post-launch model check still ignores the level and still accepts a dated snapshot of an undated ID.

## Verification

- Dry-run matrix covering every combination of present and absent sources, including conflicts.
- Fingerprint test: same request before and after changing only the alias level.
- Runtime check that the launched child reports the intended level (using the capture seam if useful).

## Constraints and handoff

Persisted plan records are versioned and readers fail closed; any new persisted field follows the existing versioning rules and compatibility fixtures. This ticket and ticket 05 both touch the plan and its fingerprint: merge the integration tip before reporting done.
