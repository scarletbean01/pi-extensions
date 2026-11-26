# 07: hc status extension

**What to build:** Under hc, an agent reports its status to hc so it shows correctly in hc's own views. The reporting is advisory and never affects workflow state (ADR 0003).

- A separate extension, beside the Herdr-managed state extension (which Herdr overwrites and which is never edited), is enabled only when the hc terminal identity is set and does nothing under Herdr or in an ordinary shell.
- It reports working during a turn, idle when the turn settles, blocked on a direction request and done on completion.
- The wire format comes from ticket 05's findings or from a specification the operator supplies. It is not guessed; if neither exists, stop and say so.

Spec: `../spec.md` (status publishing).

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] With the hc terminal identity set, the extension emits the documented reports for each mapped event (verified by capturing terminal output).
- [ ] Without the hc terminal identity, nothing is emitted.
- [ ] The Herdr-managed state extension is unchanged.
- [ ] The documentation describes the extension and its advisory role.
