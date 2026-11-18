# 01: Validate the current reliability changes

**What to build:** Close the earlier review findings against the code that is actually present, preserving concurrent edits.

**Track:** Foundation

**Blocked by:** None (can start immediately after draft review)

**Status:** done — merged to main (via integration/bootstrap-orchestration)

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Record the baseline revision or file hashes and classify each earlier finding as fixed, incomplete, or still reproducible.
- [ ] Verify initialized-worker replacement for /new, /resume and /fork, tool restoration, and reload with saved results.
- [ ] Verify canonical request retries, atomic reservations, interrupted-release reconciliation, and lock ownership using the existing implementations.
- [ ] Exercise competing processes and simultaneous stale-lock recovery; a live holder must never lose exclusivity.
- [ ] Fix only remaining defects and document cancellation while waiting for a lock; retain existing cleanup ownership protections.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Initialized-session replacement sequence; reordered equivalent request; two-process same-key launch.
- Kill at reservation/release boundaries; simultaneous stale-lock contenders; launcher interrupted before/after release.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Current changes are moving; do not rebuild features merely because the earlier review described them as missing.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
