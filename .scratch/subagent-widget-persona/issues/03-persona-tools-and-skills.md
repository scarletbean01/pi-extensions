# 03: Persona tools and skills

**What to build:** A persona subagent gets the tools and skills its persona declares. A non-empty `tools:` list is used exactly as written; no `tools:` line means the current read-only set. `--write` combined with `--persona` is rejected with a clear error. Persona `skills:` names are resolved through the widget's existing skill resolver and loaded into the subagent; an omitted or empty `skills:` means no skills, as today. A name that does not resolve fails the launch, naming the persona and the skill. `--skills` on a persona launch adds to the persona's skills for that launch. The persona's `extensions:`, `color` and `description` have no effect on a subagent.

Spec: `../spec.md` (user stories 11–18; Implementation Decisions: Tools, Skills, Ignored persona fields, Rejected combinations).

**Blocked by:** 01 (persona launch).

**Status:** done — merged to feature/subagent-widget-persona

**Delegation tier:** easy (argument wiring through existing seams, well specified) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [x] The fake `pi` executable receives a persona's `tools:` list exactly as written; a persona without `tools:` gets the read-only set; names are passed through verbatim.
- [x] `--write` with `--persona` fails with a clear usage error and no child process, on `/sub` and on `subagent_create` (`writeAccess` with `persona`).
- [x] Persona skills names are loaded as `--skills` names are today; no `skills:` line and an empty one both load no skills; an unknown name fails the launch before a child starts and names the persona and the skill.
- [x] `--skills` (or the tool's `skills`) on a persona launch adds to the persona's list for that launch only.
- [x] A persona with `extensions:`, `color` and `description` launches a child with no extra extensions and no changed arguments from those fields.
- [x] No test depends on a real model. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale claims. Status is set to done and verified criteria are ticked on merge.

## Verification note

Merged as `cb3330f` (merged with the integration tip as `f516fc4`) via `ticket/persona-03`, review round 1 (Opus, medium): no blocking findings. Widget suite `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts`: 76 passed on the merged code (orchestrator and reviewer). `timeout 900 node bootstrap/run-tests.ts deterministic`: 1600 passed on the builder's rerun; its first run had one cross-process race failure in `pane-wake.test.ts`, which this diff cannot reach.

Pulled forward from ticket 04 by the builder, accepted by the review: continuations reuse the stored tools and skills, and `--write` is rejected on continue.

Non-blocking review items left open (review: scratchpad `review-03-r1.md`):
- Ticket 04 must decide whether a continue re-resolves persona skill names each turn (current) or uses paths snapshotted at launch, and test it.
- No test proves `--skills` stays for that launch only (continue without `--skills`); ticket 04 criterion 5 covers it.
- The ignored-fields test only checks the extension count; compare argv of twin personas instead.
- `bootstrap/HOST.md` "Scope" section duplicates persona tool and skill detail that belongs in the README; keep the scope sentences and point at the README. README line 40 capitalises "Persona"/"Subagent" mid-sentence.
- Pass-through edge cases to document in ticket 06: `tools: +foo` / `-write` use Pi's modifier syntax, `tools: ,` is passed as is, duplicate skills give duplicate `--skill` args, and the `--write` error text names CLI flags even for `subagent_create`.
