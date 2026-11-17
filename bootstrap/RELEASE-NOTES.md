# Model aliases, persona discovery and allowed skills

See the [migration guide](MIGRATION.md) before launching personas carried over from other tools or personas that use old aliases.

- Bootstrap discovers personas in `<project>/.pi/agents` and the global `agents` folder in Pi's agent directory (`~/.pi/agent/agents`, or `$PI_CODING_AGENT_DIR/agents` when that variable is set). The project wins on case-insensitive name collisions. Project team definitions stay in `.pi/agents/teams.yaml`. The interactive `system-select` extension, `/system` command, `--agent` flag and persona-cycling shortcuts are removed.
- Define aliases in global `~/.pi/agent/bootstrap.json` (or `$PI_CODING_AGENT_DIR/bootstrap.json`) and optionally in `<project>/.pi/bootstrap.json`. The shape is `{"modelAliases":{"review":{"model":"openai/gpt-5","thinking":"high"}}}`. Each alias has a full model ID and an optional thinking level. Alias names are case-insensitive, duplicate names within a file are invalid, and a project entry replaces the entire global entry. Missing files contribute no aliases. Bootstrap ships zero aliases. Invalid config stops planning with the file and key.
- A persona can use an alias or full model ID. The `model:` suffix takes precedence over the persona's `thinking:` field, which takes precedence over the alias's `thinking`. An invalid level or unknown alias stops planning. An omitted model inherits the launching session's model, and planning fails if there is no model to inherit. The dry run shows the resolved model and thinking level.
- A missing `skills:` field keeps every skill Pi discovers, an empty field keeps zero, and a comma-separated list keeps the named skills with exact, case-sensitive matching. The dry run previews the list. Unknown names fail agent startup before work is released, and diagnostics name the persona and the unknown skills. Allowed skills save prompt context. They provide no permission boundary.
- Agents prepend the persona text to Pi's default prompt and omit Pi's built-in harness-documentation block when it matches the installed prompt shape. Agents can still read the installed documentation by path. Extension-contributed prompt rules and tool guidelines stay in the prompt.

## Known limitations

- Trimming extension-contributed rules and configuring the full extension list per persona are deferred. Personas can still name extra extensions with `extensions:`.

# Hardened team/chain core release

The first core milestone ships tickets 01–09 plus release gate 13. Optional tickets 10–12 and 14–24 are not shipped. See [migration and recovery guidance](README.md#upgrade-rollback-and-operator-playbook).

Shipped capabilities:

- Repeated personas with distinct node, attempt and agent identities; v2 manifests/configs/results and safe v1 inspection, reporting and cleanup.
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
- Read scopes do not lock writers. Check evidence can become stale after a agent's successful result; that historical result is retained. Declare relevant scopes and recheck when needed.
- All agents are eagerly launched in the existing project directory. No synthesis, graph scheduler, collaborator lease, supervisor, lazy launch, revision loop, archive service or isolated workspace implementation is enabled.
- Runtime requires POSIX `/bin/sh`, Node 26+, installed Pi and compatible Coms/Herdr. Windows launching is unsupported. Do not mix releases within a run.

Release validation uses the isolated deterministic and runtime suites (`node bootstrap/run-tests.ts all`), including combined core acceptance scenarios. Runtime uses installed Pi and Coms with a scripted local fake provider. Real-provider execution and live Herdr tab lifecycle are not verified by these suites. Live Herdr coverage remains explicitly opt-in; consult the release report for exact counts and skips.
