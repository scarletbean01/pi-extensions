# 12: Make inspection, reporting and recovery usable from /boot

**What to build:** Find runs and act on blockers without remembering IDs or parsing large manifests.

**Track:** Follow-on usability

**Blocked by:** [04: Expose execution outcomes and dependency policies](04-expose-execution-outcomes-and-dependency-policies.md); [07: Recover interrupted handoff delivery without rerunning work](07-recover-interrupted-handoff-delivery-without-rerunning-work.md); [08: Cancel runs and enforce configurable deadlines](08-cancel-runs-and-enforce-configurable-deadlines.md); [10: Preview the exact executable plan](10-preview-the-exact-executable-plan.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Extend /boot with list, inspect and help/recovery guidance, backed by the independent run index.
- [ ] Build on existing per-agent state, wait_ms and report digests; show dependencies, attempt, cause and actionable next steps.
- [ ] Return compact summaries by default and fetch full result/artifact data explicitly; do not expose protocol tokens.
- [ ] Support terminal failed/blocked/cancelled runs in reports and label explicit operator-supplied results with provenance.
- [ ] Maintain useful inspection when one worker record is corrupt; retain safe cleanup from valid ownership evidence.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Fresh dispatcher finds old run; mixed outcomes; large result; corrupt one-member record.
- Wait exits for completion, cancellation and needs_attention; all required next-action identifiers appear in model-facing text.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Do not duplicate the bounded-wait and stable-agent cleanup work already present.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
