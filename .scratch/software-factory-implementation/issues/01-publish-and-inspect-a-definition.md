# 01: Publish and inspect a factory definition

**What to build:** A person can explicitly publish a validated definition for a named software factory in Pi and inspect what was published, without starting a run. Use the shared factory operation boundary for the command and structured read-only inspection. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** None (can start immediately).

**Status:** done — merged to feature/software-factory

- [x] Before implementation, create or switch to the dedicated `feature/software-factory` integration branch. All 14 tickets land there, not on `main`; see the [branch policy](../README.md).
- [x] A successful first publication gives the factory a stable ID and makes a complete immutable `v1` current in one crash-durable commit. Discovering or opening it does not activate admission or launching.
- [x] Validate the exact executable definition, sharing launch validation where practical: graph and dependencies, contracts/checks, revision rules and limits, and the floor for first attempts. An invalid publication names the node, setting or unmet prerequisite where known and leaves the previous current state intact; preview alone is not sufficient validation.
- [x] Preserve the checkout, plan, instructions, persona prompts, resolved models, thinking levels and limits, and declared tool, skill and extension policies. Distinguish policies that inherit live availability from preserved settings; do not claim to snapshot the environment.
- [x] Exercise publication, discovery and inspection through the operation boundary; exercise interruption around commit on real local storage. No partial version becomes current or is acknowledged; document the durability semantics beyond process-kill testing.
