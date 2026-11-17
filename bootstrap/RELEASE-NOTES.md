# Hardened team/chain core release

The first core milestone ships tickets 01–09 plus release gate 13. Optional tickets 10–12 and 14–24 are not shipped. See [migration and recovery guidance](README.md#upgrade-rollback-and-operator-playbook).

Shipped capabilities:

- Repeated personas with distinct node, attempt and worker identities; v2 manifests/configs/results and safe v1 inspection, reporting and cleanup.
- Bounded run briefs, peer rosters, output contracts, artifact digests/provenance and on-demand upstream input reads.
- Explicit execution outcomes and dependency policies, original cause chains, mixed-outcome reports and verification evidence whose applicability changes after relevant edits.
- Durable handoff offers and exclusive destination claims before execution, duplicate notification suppression, rejection diagnostics and serialized delivery repair from saved results.
- Cancellation, configurable execution/dependency/liveness deadlines, grace-bounded force close and session replacement without inherited task authority.
- Independent teams, optional fail-fast behavior, declared shared-directory ownership and serialization of known conflicting writers; no automatic worktrees.
- Request idempotency, cross-process locks, interrupted launch reconciliation and cleanup by stable owned resource identity.
- Existing generate/status/report/cleanup surfaces, required recover/cancel operations and basic `/boot` inspection. Unsupported workspace strategies and topologies fail closed.

Known limitations:

- Atomic file publication is not fsynced; power loss may lose recent updates. Ownership is advisory, not a filesystem sandbox or protection from same-user processes.
- A claimed attempt with no result needs an explicit effects review. There is no automatic side-effect replay or exactly-once side-effect guarantee.
- Handoff repair requires a live waiting successor and dispatcher Coms. The default dependency wait window is 5 minutes; retries have a 30-second delivery wait and a five-attempt budget.
- Hooks cannot interrupt in-flight tools. Force-closing a pane does not prove external side effects stopped. Cancellation queued behind a run lock waits until the lock is acquired (up to 15 minutes).
- Read scopes do not lock writers. Check evidence can become stale after a worker's successful result; that historical result is retained. Declare relevant scopes and recheck when needed.
- All workers are eagerly launched in the existing project directory. No synthesis, graph scheduler, collaborator lease, supervisor, lazy launch, revision loop, archive service or isolated workspace implementation is enabled.
- Runtime requires POSIX `/bin/sh`, Node 26+, installed Pi and compatible Coms/Herdr. Windows launching is unsupported. Do not mix releases within a run.

Release validation uses the isolated deterministic and runtime suites (`node bootstrap/run-tests.ts all`), including combined core acceptance scenarios. Runtime uses installed Pi and Coms with a scripted local fake provider. Real-provider execution and live Herdr tab lifecycle are not verified by these suites. Live Herdr coverage remains explicitly opt-in; consult the release report for exact counts and skips.
