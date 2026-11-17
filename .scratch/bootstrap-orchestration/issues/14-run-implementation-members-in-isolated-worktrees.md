# 14: Run implementation members in isolated worktrees

**What to build:** Only when the user explicitly requests worktrees, parallel code-writing members get separate working directories with recoverable ownership. All other runs use the existing project cwd.

**Track:** Workspace

**Blocked by:** [03: Allow multiple tasks to use the same persona](03-allow-multiple-tasks-to-use-the-same-persona.md); [09: Make independent team execution and ownership explicit](09-make-independent-team-execution-and-ownership-explicit.md); [10: Preview the exact executable plan](10-preview-the-exact-executable-plan.md)

**Status:** draft — pending plan review

**Specification:** [Bootstrap orchestration](../spec.md)

## Acceptance criteria

- [ ] Default omitted strategy to shared cwd; create worktrees only for an explicit user request represented in the run plan, within its recorded scope.
- [ ] Never infer worktree creation from topology, parallel edits, ownership overlap, dirty files, retry, recovery or revision; preview creates no worktrees.
- [ ] Validate Git and clean-base prerequisites only for requested worktree creation; shared mode works without Git and in dirty projects. Report requested-creation failures without silently switching strategies.
- [ ] Record base commit, generated branch/worktree identity and node ownership before external creation.
- [ ] Define dirty-worktree behavior explicitly: initial support uses a recorded clean base and never silently discards or copies uncommitted changes.
- [ ] Carry necessary project configuration into worker launch deliberately without copying secrets or silently dropping policy hooks.
- [ ] Cleanup retains dirty worktrees and unmerged work by default and can reconcile partially created workspaces.
- [ ] Update model-facing tool text and usage documentation for this behavior; preserve relevant legacy behavior.

## Verification

- Omitted/shared strategy causes zero worktree creation on launch, recovery and revision, including parallel teams, non-Git projects and dirty repositories.
- Explicit request: two members edit the same filename in different worktrees; user worktree remains unchanged.
- Dirty starting tree, missing Git, interrupted creation, moved/deleted worktree and cleanup with uncommitted changes.
- Exercise behavior through the existing service/worker seams where possible; record environment limitations explicitly.

## Constraints and handoff

Worktrees isolate repository edits, not network access, databases, caches or arbitrary absolute paths.

Reinspect current code before implementation and preserve edits made by others. Persisted-state changes need versioned readers and compatibility fixtures. If this slice cannot fit a fresh implementation context, split it at a demonstrable behavior before starting; do not deliver a partial public contract.
