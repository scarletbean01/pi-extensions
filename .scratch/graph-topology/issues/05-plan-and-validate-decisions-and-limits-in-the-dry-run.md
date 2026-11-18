# 05: Plan and validate decisions and limits in the dry run

**What to build:** An orchestrator can put a `decision` on a node of a node-form chain and see it validated, with resolved revision limits and where each came from, in the dry run. Launching such a plan is still refused until the loop ticket lands.

**Blocked by:** [02: Represent every plan internally as nodes with inbound edges](02-represent-every-plan-internally-as-nodes-with-inbound-edges.md)

**Status:** done — merged to main

- [ ] `decision` (`field`, `approve`, `reject`, `on_reject`, `max_revisions`, `on_exhausted`) is accepted on node-form chains and rejected on the legacy form.
- [ ] Validation: the output contract declares the verdict field as an enum of exactly approve and reject; `on_reject` names a strict ancestor; `max_revisions` 1–10; `on_exhausted` is `needs_attention` or `failed`.
- [ ] `max_revisions` and `max_total_attempts` resolve from request, project `bootstrap.json`, global `bootstrap.json`, built-in (derived total), shown with their source.
- [ ] The `graph` block's defaults and ceilings merge field by field; the lower ceiling wins; a request above a ceiling fails; malformed values fail naming file and key even when unused.
- [ ] Resolved values enter the fingerprint: a changed resolved value with the same `request_id` is a different plan; plans without a decision keep their fingerprints.
- [ ] A non-dry launch of a plan with a decision is refused with a clear message.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
