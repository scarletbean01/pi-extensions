# Orchestrating the viewer-agent-output build

Spec: `spec.md`. Tickets: `issues/01` to `issues/05`. Prepared 2026-11-28.

The orchestrator (Claude, running inside herdr) **implements nothing and reviews nothing itself**. It delegates every ticket to a builder in its own herdr tab (launched with `hc run --bg`, then shown with `herdr-app`), sends each finished ticket to a read-only Opus reviewer at medium effort, relays findings to the builder, merges, marks the ticket done, then offloads the next ticket. Same loop as `../subagent-widget-persona/ORCHESTRATION.md`.

## Roles and tiers

| Ticket | Builder |
| --- | --- |
| 01 Latest attempt status, summary, detail (route, scrubber, section) | agy `gemini-4-hydrogen-high` (template `agy-builder`) |
| 02 Rest of the recorded report | agy hydrogen high |
| 03 Every attempt, newest first | agy hydrogen high |
| 04 Output appears when an attempt finishes | agy hydrogen high |
| 05 Docs, privacy contract, acceptance | codex `gpt-6-luna`, `model_reasoning_effort=xhigh` |

Reviewer: Opus subagent (Agent tool: `subagent_type: reviewer`, `model: opus`, `effort: medium`), read-only, findings to a scratchpad file. If a ticket is harder than its tier, tell the user before moving a fix round up a tier.

## Order and branches

Strictly one ticket at a time: 01, 02, 03, 04, 05 (a linear chain; all edit the same server projection and client script).

- Integration branch `feature/viewer-agent-output` from `main`. The user decides when it goes to `main`.
- Worktree per ticket: `/home/deplague/.cache/viewer-agent-output-work/wt-NN`, branch `ticket/vao-NN` from the integration tip. Merge `--no-ff`, message `Merge ticket/vao-NN: <title> (ticket NN)`.
- Tracker updates (status `done — merged to feature/viewer-agent-output`, ticked verified criteria, verification note) are docs-only commits on the integration branch.

## Test commands (from the extensions directory)

- Viewer: `timeout 600 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/factory-web-viewer*.test.ts`
- Docs: `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 bootstrap/docs.test.ts`
- Deterministic: `timeout 900 node bootstrap/run-tests.ts deterministic`

## Reviewer checks

Every acceptance criterion against code and tests; whole-body private-sentinel scans on every endpoint (prompts, briefs, tokens, endpoint paths, worker config, metrics, artifact paths, absolute paths); viewer stays read-only and loopback-only; Materialize guard test passes with no new allowlist entry beyond preserved whitespace; no test depends on a real model; no leaked processes or temp files; `bootstrap/README.md`, `bootstrap/HOST.md` and `docs/factory-web-viewer.md` free of stale claims.

## Ask the user

Merging the integration branch into `main`, any push, a third failed review round, a tier change, a spec/ticket conflict, and the agy trust-folder prompt for `~/.cache/viewer-agent-output-work/` (once; a yes covers later worktrees there).
