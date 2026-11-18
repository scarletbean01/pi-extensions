# 07: Every way a loop can end

**What to build:** Loops that don't end in approval settle deterministically, with a cause the orchestrator can act on, and leave the run outcome terminal.

**Blocked by:** [06: Minimal review loop: reject then approve](06-minimal-review-loop-reject-then-approve.md)

**Status:** ready-for-agent

- [ ] Reject with no revisions left ends the decision node in `on_exhausted` (`needs_attention` default, `failed` on request) with a cause naming the loop.
- [ ] Reject when the next attempts would exceed `max_total_attempts` ends the same way with a cause naming the run budget.
- [ ] A `partial` or `failure` decision result keeps its status, starts no revision and spends no budget.
- [ ] A builder failing during a revision blocks the decision node's next attempt with that failure as cause; no further revision is spent.
- [ ] In every case the decision node writes finalize records for the body and the run outcome is terminal.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
