# 03: Launch-time hop limit and Coms name check for bootstrap workers

**What to build:** Two launch-time fixes for bootstrap's agent workers.

1. **Hop limit.** A review loop can run as many revisions as its decision node and the run's attempt budget allow. The generated launcher for agent nodes sets the Coms hop-limit environment variable to the larger of 5 and the run's total attempt budget plus 2. The budget is the bound plan's value. Graphs without a decision node already use the node count. Coms itself is unchanged: there is no conversation-ID exemption, and its default stays 5 for non-bootstrap use. Command nodes are unchanged.
2. **Name collision.** On startup the worker compares the Coms name it was registered under with its expected instance ID. If they differ because Coms renamed it after a collision, the worker writes its node's error record ("coms name collision: wanted X, got Y") and does not acknowledge readiness. The dispatcher's existing readiness loop then fails launch immediately with that text. Coms keeps its automatic renaming for ordinary users. There is no `--strict-name` flag, and `--explicit` is unchanged.

Spec: `../spec.md` (bootstrap launcher and worker decisions; user stories 1–5 and 19–21; Further Notes on the hop bound).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Through the launch harness, the launcher generated for a plan with a known attempt budget sets the hop limit to `max(5, budget + 2)`. A command node's launcher does not set it.
- [x] In a real-process runtime test, a two-node handoff loop passes more than 5 hops when the variable is set, and is stopped at the bound when the chain exceeds it.
- [x] A worker whose Coms name was taken launches under a numbered name, and launch fails at once with an error naming the wanted and the assigned name. There is no readiness timeout.
- [x] A normal launch with no collision is unaffected. Existing bootstrap suites pass. (Verified: all suites pass except the known factory-web-viewer-materialize-guard.test.ts cleanup hang that also occurs on main; one flaky command-node N1 test passed on rerun.)
- [x] The bootstrap README notes the hop limit derivation and the collision failure.

Verification note: normal launch and the runtime suite pass. The full deterministic suite reaches its 180-second suite timeout while the process for `factory-web-viewer-materialize-guard.test.ts` remains pending after its tests complete. Running that same file on `main` reproduces the hang; the combined suite criterion remains unchecked.
