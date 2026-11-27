# 02: Re-create the token benchmark doc and record the after-change run

**What to build:** A committed `docs/token-benchmark/README.md` that lets anyone reproduce the widget-versus-graph token comparison, holding the baseline measured before ticket 01 and the re-run measured after it, with the two follow-up optimizations recorded for later.

Spec: `../spec.md` (user stories 18–20; Implementation Decisions, Benchmark).

**Blocked by:** 01 (the re-run needs the terminating completion merged)

**Status:** ready-for-agent

**Delegation tier:** easy (documentation and measurement from existing session files, well specified) → codex `gpt-6-luna` at `model_reasoning_effort=xhigh`; Opus review at medium effort.

- [ ] The document describes the three workloads (one no-op; two parallel reads; two reads and a join), how each is run, and how tokens and estimated cost are read from the session files, so the method is reproducible. The 13 existing `read-only-token-benchmark-*` session files are identified as the baseline source.
- [ ] Baseline totals per workload (worker tokens, plus the model-dispatched widget-versus-graph comparison including uncached input and estimated cost) are in the document and match the session files. Any figure that cannot be recomputed from them is flagged as quoted, not measured.
- [ ] The same workloads are re-run against the post-ticket-01 code; the measured results sit beside the baseline with the saving per workload. If a result differs from the spec's estimate (3,750 / 15,838 / 21,082), the document says by how much.
- [ ] The document records two follow-ups with their evidence and the decision rule for pursuing them: stable prompt prefix and tool-schema ordering for cache hits (measure cache hits before and after), and command nodes for deterministic extraction, validation and merging.
- [ ] No source code changes. `bootstrap/README.md` and `bootstrap/HOST.md` are checked for stale token or cost claims and updated if any exist. Status is set to done and verified criteria are ticked when this ticket is merged.
