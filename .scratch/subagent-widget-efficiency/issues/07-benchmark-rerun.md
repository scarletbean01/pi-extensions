# 07: Rerun the token benchmark and record the savings

**What to build:** The token benchmark is rerun against the finished widget and the results are recorded beside the existing baseline, so the saving is measured. No source code changes.

Spec: `../spec.md` (user story 28; Testing Decisions).

**Blocked by:** 02 (lean launch), 03 (final-message delivery and coalescing), 06 (tool schema change, or its recorded revert)

**Status:** ready-for-agent

**Delegation tier:** easy (measurement and documentation from session files, procedure already documented) → codex `gpt-6-luna` at `model_reasoning_effort=high`; Opus review at medium effort.

- [ ] The no-op, two-parallel-reads and two-reads-and-join workloads are run on the finished code using the method already in `docs/token-benchmark/README.md`.
- [ ] First-turn input tokens for the no-op subagent are recorded beside the 5,175 baseline. The target is about 2,000 or fewer; if it is higher, the document says by how much and which remaining content explains it.
- [ ] The number of parent LLM turns for the parallel workloads is recorded beside the baseline and shows the coalescing effect.
- [ ] Figures that cannot be recomputed from retained session files are flagged as quoted, not measured, and the evidence session files are kept where pruning will not delete them.
- [ ] No source code changes. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale token or cost claims. Status is set to done and verified criteria are ticked on merge.
