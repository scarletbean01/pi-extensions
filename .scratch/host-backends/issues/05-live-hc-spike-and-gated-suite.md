# 05: Live hc spike and gated suite

**What to build:** The undocumented hc behaviours are settled against a real but isolated hc core, and a gated live suite is left behind. **The builder writes the spike and the suite but does not run them. The orchestrator asks the operator before anything is run.**

- A gated live suite, enabled by an environment variable and skipped otherwise, mirroring the live Herdr suite. It starts and stops its own isolated hc session with scratch paths and can never touch the operator's own core.
- A spike that records answers to: whether `hc send` wraps text in a note wrapper and when; the exact status-report wire format and how a status appears afterwards; the exact test-isolation recipe; what happens when sending to a still-booting agent; whether label filtering and per-terminal inspection behave as the contract document says; and whether names can be reused after a terminal dies.
- After the operator's go-ahead and a run, the findings replace the unverified tags in the contract document, and tickets 06 and 07 are updated if an answer changes them.

Spec: `../spec.md` (further notes: undocumented hc behaviours).

**Blocked by:** 03

**Status:** in-progress

- [x] The gated suite exists, is skipped without its environment variable, and cannot reach a core other than its own.
- [x] The spike covers each listed question and writes its findings to a file.
- [ ] After the operator runs it: the findings are in the contract document and the unverified tags are resolved or restated.
- [x] The existing live Herdr suite is unchanged.
