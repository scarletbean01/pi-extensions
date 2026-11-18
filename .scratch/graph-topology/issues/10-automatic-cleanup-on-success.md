# 10: Automatic cleanup on success

**What to build:** A run that asks for `cleanup: on_success` closes all its tabs by itself once it has succeeded and settled, keeps its records and reports, and tells the orchestrator. Every other outcome keeps its tabs.

**Blocked by:** [04: Live graph widget for chain and team runs](04-live-graph-widget-for-chain-and-team-runs.md); [07: Every way a loop can end](07-every-way-a-loop-can-end.md)

**Status:** done — merged to main

- [x] Optional run field `cleanup: on_success | manual`; chain and team default to manual; omitting it keeps legacy fingerprints.
- [ ] Trigger: outcome `succeeded`, every loop settled, every result durable with final delivery state, each agent exited or `cleanup_settle_ms` (default 3000) past its last result. — NOT VERIFIED: An exited approving reviewer with no delivery routes can qualify with a persisted pending delivery state.
- [ ] Action equals `bootstrap_cleanup` with no selectors, never deleting session files; still-parked nodes are finalized by the dispatcher first; the manifest records `cleanup_trigger: auto` and the time. — NOT VERIFIED: Automatic cleanup shares whole-run resource closure and finalizes loop records, but manual cleanup also writes abort.json and automatic cleanup does not.
- [x] Evaluated by the dispatcher watcher (shared with the widget poller, running without a widget) and lazily by `bootstrap_status`, `/boot <id>` and `/bootgraph <id>`, under the run lock; exactly one evaluator performs it.
- [x] Status text says the run was cleaned up automatically and points to `bootstrap_report`; the watcher sends a follow-up message.
- [x] Failed, blocked, partial, cancelled, skipped and `needs_attention` runs keep their tabs; cleanup errors are retained, shown and retried by `bootstrap_cleanup`.
- [x] An agent is never closed between saving its result and finishing its delivery bookkeeping.

## Constraints

- Specification: [spec.md](../spec.md); vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (agents drive graph execution, no scheduler).
- Existing chain and team tests pass untouched; chain and team records and fingerprints do not change.
- Test through the seams named in the spec's Testing Decisions; assert only what status, report, dry-run output or widget text expose.
- Persisted-state changes carry versions with versioned readers and compatibility fixtures. Reinspect current code first and preserve edits made by others.
