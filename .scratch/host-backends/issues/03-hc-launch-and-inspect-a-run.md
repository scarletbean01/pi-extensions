# 03: hc: launch and inspect a run

**What to build:** From an hc terminal, an ordinary shell with hc installed, or by explicit setting, a run launches its nodes through hc and reports their state. Proven with a fake `hc` and a contract suite that runs the same checks against both backends.

- Backend selection can now choose hc: explicit setting first; then calling context; then hc when the binary is on the path and its core answers; otherwise a clear failure naming both options. Detection never relies on the hc terminal identity alone.
- hc preflight checks the binary and a reachable core and does not require the hc terminal identity.
- Node launch: a deterministic, sanitized, hashed name that fits hc's limits; labels for run and instance; the node's working directory; the launcher exporting the Coms directory, timeout and hop limit itself; and nodes that are independent of the dispatcher with no notes typed into its input.
- Discovery by label followed by confirming each terminal, and node state (present, gone or ambiguous) from the terminal's state. The manifest records the backend and a per-launch reference holding the terminal name and the address hc returned.
- A fake `hc` executor beside the existing fake Herdr executors, and one contract suite parameterised over both backends covering launch, discovery, state and preflight failure.
- Sending a wake-up on hc may report "not implemented" here; a later ticket wires it.

Spec: `../spec.md` (the hc backend). Contract document from ticket 01.

**Blocked by:** 02

**Status:** done

- [x] With the fake `hc`, a run launches on hc, its nodes are discovered and their state is reported.
- [x] Backend selection chooses correctly in every case of the decided rules, including an orchestrator with no Host context, and fails clearly when neither tool is available.
- [x] Names are valid and distinct for long and awkward task and instance ids.
- [x] The contract suite passes against both Herdr and hc backends, and the existing suites still pass.
- [x] No real hc terminal is created by any test in this ticket.
- [x] The contract document is updated; hc behaviours stay tagged unverified until ticket 05.
