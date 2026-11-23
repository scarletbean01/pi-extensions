# 13: Request a bounded revision

**What to build:** A human can select a plan-defined revision choice at a decision node. A valid rejection runs the declared loop body again on the same live agents, or records why the bounded revision cannot proceed. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [12: Bind human approval to a valid decision result](12-bind-human-approval-to-a-valid-result.md).

**Status:** done

- [x] Map the human choice to the existing rejection verdict. A valid successful decision result follows the existing feedback edge to the entire loop body, in dependency order on the same agents, with review findings, earlier-result references and optional human guidance. Outside nodes remain untouched; a fresh review attempt can ask for a fresh choice.
- [x] Respect both per-loop and run-wide limits, even with multiple loops competing for run budget. Show remaining capacity and the plan's exhaustion consequence before selection, but keep the revision choice selectable.
- [x] When rejection is applied at an exhausted limit, record which limit blocked revision and apply the declared `on_exhausted` disposition. Do not turn rejection into approval, open forward edges or start a partial iteration.
- [x] When a loop exhausts, whether by a rejection at an exhausted limit or by the loop settling at its limit, raise a human intervention request through the ticket 09 mechanism instead of leaving only `needs_attention`. Offer the routing choices retry with a new brief, take over, or discard (discard and takeover keep their own confirmations). Do not re-plan automatically, and do not start another attempt without a recorded choice. Show the blocked limit and the `on_exhausted` disposition in the request.
- [x] Demonstrate revision then approval with the same agents and distinguish the choice, verdict, and actual new attempt admission. Test each exhausted limit and confirm that result validation and handoff checks still apply.
