# 05: Limit an agent's skills from its persona

**What to build:** A persona can list its allowed skills, and a bootstrapped agent's prompt then names only those skills. Absent field keeps every skill; an empty field means none.

**Blocked by:** 02 (provider-request capture seam)

**Status:** done — merged to main (`e25993a`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] The persona frontmatter accepts `skills:`, a comma-separated list of skill names matched exactly against the `name` each skill declares.
- [x] Absent field: the agent keeps every skill, exactly as today. Present but empty: the agent keeps none.
- [x] Bootstrap passes the allowed skills to the launched child through an `--allowed-skills` flag carrying the comma-separated names; an empty list is encoded with the reserved value `none`; an absent field means the flag is not passed.
- [x] The worker registers the flag and removes every skill not on the list from the prompt inputs before the model is called. Matching uses the skills Pi has already discovered; bootstrap does no skill discovery of its own.
- [x] The dry-run plan shows each agent's allowed skills as written in the persona, without checking that the names exist.
- [x] The request fingerprint includes each agent's allowed skills.
- [x] The persona prompt is still placed in front of Pi's default prompt, and nothing replaces the default prompt.
- [x] Runtime tests using the capture seam assert, in the provider request itself: only the allowed skills appear; an empty list yields no skills; an absent field yields all of them; the persona text is still present.

## Verification

- Capture-seam runtime tests for one skill, several skills, none and all.
- Dry-run test that the plan lists the skills and that changing the list changes the fingerprint.

## Constraints and handoff

Allowed skills save context; they are not a permission boundary, and the documentation must say so. A graph node cannot override a persona's skills. Unknown names are handled by ticket 06; this ticket must not fail on them yet. Merge the integration tip before reporting done, since ticket 04 also touches the plan and its fingerprint.
