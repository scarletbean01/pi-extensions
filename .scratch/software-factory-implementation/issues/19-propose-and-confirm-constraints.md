# 19: Propose and confirm learned constraints

**What to build:** After a run where something went wrong and was understood, agents can propose a constraint. A person confirms or rejects it, and only a confirmed constraint reaches the file that later runs read. This is a post-release extension; it does not gate [ticket 14](14-verify-and-document-in-pi-herdr.md). See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [18: Read learned constraints at launch](18-read-learned-constraints-at-launch.md); [09: Ask for and record human direction](09-ask-for-and-record-human-direction.md).

**Status:** ready-for-agent

- [ ] An agent-facing operation can propose a constraint with text and provenance (run, attempt and evidence reference). It may only be used after a run in which a loop needed at least one revision or a human intervention occurred. Proposals after first-pass successes are rejected. Agents never write the constraints file.
- [ ] A deterministic check compares a proposal with existing constraints by normalized exact text and drops duplicates before a person sees them. It uses no model.
- [ ] The proposer may name the ids of existing constraints it believes conflict. At confirmation the person sees the proposal, its provenance and evidence, and the full list of active constraints with any named conflicts highlighted next to the proposal. Nothing judges contradiction or near-duplication automatically.
- [ ] Adding a constraint and retiring one are human actions through the existing human-confirmation mechanism, bound to the exact target and action. Agent tools cannot supply that confirmation, and eligibility is validated again at commit. Retiring changes status to `retired` and keeps the entry and its history.
- [ ] A confirmed addition or retirement is written to the constraints file durably, with its provenance. The next launch reads it as in ticket 18. It never changes a run already in flight.
- [ ] Surface pending proposals in the same views as pending requests so a missed alert hides nothing. Show the outcome of each proposal: pending, confirmed, rejected or dropped as a duplicate.
- [ ] Cover a duplicate, a named conflict, a rejected proposal, a retirement, a proposal after a first-pass success, an agent attempting to confirm, a lost acknowledgement retried safely, and a crash between confirmation and write.
