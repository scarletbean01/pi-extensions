# 15: Add a deterministic command node

**What to build:** A graph author can declare a node that runs a fixed command with declared inputs and outputs and no model, for steps that have one correct answer such as merging, deduplicating or comparing results. It joins the graph through the same edges, joins and handoffs as an agent node. This is a post-release extension; it does not gate [ticket 14](14-verify-and-document-in-pi-herdr.md). See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [06: Cancel a run and verify settlement](06-cancel-a-run-and-verify-settlement.md). Do not start before ticket 06 merges: both change `bootstrap/lifecycle.ts`.

**Status:** done

- [x] A plan can declare a node of kind `command` with a command, arguments and working directory. It needs no persona, model, thinking level or skills, and it never starts a model. Planning rejects a command node that declares agent-only settings, with a diagnostic naming the node and the setting.
- [x] A command node consumes upstream results through the existing immutable task-input and `depends_on` edges, and produces a result under the existing `output_contract`. Exit status 0 with a contract-valid result is success; anything else is failure with the real exit result and command recorded as evidence.
- [x] It takes part in fan-out, joins, per-edge dependency policy, handoff offer/claim/admission and `write_paths` ownership exactly as an agent node does. Edge state stays derived, never stored.
- [x] Decision nodes stay agent-only in this ticket. A plan that makes a command node a decision node is rejected at planning.
- [x] The change is additive: plans without command nodes and persisted runs behave unchanged. If a persisted-state version bump is unavoidable, record it in the migration notes.
- [x] Demonstrate a fan-out, a command-node merge and an agent consumer, with a failing command blocking its dependants and cancellation reaching a running command node. Show the node, its exit result and its evidence in status and reports.
