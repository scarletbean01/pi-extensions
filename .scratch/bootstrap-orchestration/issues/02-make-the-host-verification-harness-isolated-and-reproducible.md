# 02: Make the host verification harness isolated and reproducible

**What to build:** Run bootstrap verification without writing the user's Pi state or making real provider requests.

**Track:** Foundation

**Blocked by:** None (can start immediately after draft review)

**Status:** done — merged to main (via integration/bootstrap-orchestration)

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Put Pi config, trust, session and Coms state in temporary directories using the installed runtime's supported configuration mechanism.
- [ ] Use a harmless fake provider that records unexpected model calls and supports deterministic successful runs.
- [ ] Separate deterministic tests, runtime integration tests, and explicit live-Herdr tests.
- [ ] Report missing capabilities and sandbox restrictions as skips or infrastructure failures with reasons, never as successful coverage.
- [ ] Document one command per suite and supported runtime assumptions; clean up child processes even on timeout.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Start real Pi with isolated state and confirm no user configuration changes.
- Verify unexpected provider access is detected; child timeout cleanup; launcher quoting where process spawning is allowed.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Earlier tests were limited by spawnSync EPERM and a read-only Pi trust directory; these are environment limitations, not evidence that the behavior passed.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
