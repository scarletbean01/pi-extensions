# Orchestrating the subagent-widget-persona build

Spec: `spec.md`. Tickets: `issues/01` to `issues/06`. Prepared 2026-11-27.

The orchestrator (Claude, running inside herdr) **implements nothing and reviews nothing itself**. It delegates every ticket to a builder in its own herdr tab, sends every finished ticket to a read-only Opus reviewer, relays findings back to the builder, merges, marks the ticket done, and then offloads the next ticket. The user answers only the questions in "Ask the user".

## Roles

| Role | Who | How it runs |
| --- | --- | --- |
| Orchestrator | Claude (this session) | Launches, watches, relays, merges, updates the tracker. Never edits product code or reviews code. |
| Easy builder | codex `gpt-6-luna`, `model_reasoning_effort=xhigh` | Interactive, in its own herdr tab. |
| Complex builder | agy `gemini-4-hydrogen-high` | Interactive (`-i`), in its own herdr tab. |
| Reviewer | Opus subagent (Agent tool: `subagent_type: reviewer`, `model: opus`, `effort: medium`) | Read-only. Findings go to a file in the scratchpad. |

Tiers per ticket are fixed in each ticket file under "Delegation tier":

| Ticket | Builder |
| --- | --- |
| 01 Launch a subagent as a persona | agy hydrogen high |
| 02 Persona instructions reach the child | agy hydrogen high |
| 03 Persona tools and skills | codex luna xhigh |
| 04 Continuing a persona subagent | agy hydrogen high |
| 05 Show the persona | codex luna xhigh |
| 06 Docs and acceptance | codex luna xhigh |

If a ticket turns out harder than its tier (a builder loops, or a review round finds design-level problems), say so to the user, then move the fix round up one tier. Never silently change a tier.

## Order

```
01 ──┬── 02 ──┐
     ├── 03 ──┼── 04 ── 06
     └── 05 ──┘          ▲
        (02, 03, 05 feed 06 as well as 04's inputs)
```

Run strictly **one ticket at a time**: 01, 02, 03, 05, 04, 06. Tickets 02, 03 and 05 are independent in theory but all edit `subagent-widget.ts`, so parallel builders would conflict. A ticket starts only when every blocker is merged. After each merge, offload the next ticket without waiting to be asked.

## Branches and worktrees

- Integration branch: `feature/subagent-widget-persona`, created from `main`. Every ticket merges into it. The user decides when the integration branch goes to `main`.
- One worktree per ticket under `/home/deplague/.cache/subagent-widget-persona-work/wt-NN`, on branch `ticket/persona-NN` created from the current tip of the integration branch (so each ticket sees its blockers' work).
- The builder commits in its worktree. The orchestrator merges (`--no-ff`, message `Merge ticket/persona-NN: <title> (ticket NN)`) after review passes. Remove the worktree and tab when the ticket is merged.
- Never leave `main` or the user's checkout with uncommitted changes from this work.

## Per-ticket loop

1. **Prepare.** Create the worktree and branch. Write the builder prompt to a file in the scratchpad (see "Builder prompt"). Never paste a long prompt through `herdr pane send-text`; it fragments.
2. **Launch.** New tab, not a split: `herdr tab create --workspace <ws> --label "tNN <agent>" --no-focus`; parse `result.root_pane.pane_id`; `cd` into the worktree; start the builder interactively with a one-line pointer to the prompt file:
   - codex: `codex -m gpt-6-luna -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox "Read <abs prompt path> fully and carry out that task exactly."`
   - agy: `agy --model gemini-4-hydrogen-high --dangerously-skip-permissions -i "Read <abs prompt path> fully and carry out that task exactly."`
   - Never use `codex exec` or `agy -p`: headless output vanishes and the pane cannot be read.
3. **Watch by hand.** No Monitor scripts. Each turn run `herdr pane get <pane>` (agent status), `herdr pane read <pane> --source recent --lines 40`, and `git log` / `git status` in the worktree. Use background `sleep N` timers between checks (foreground sleep is blocked); ignore late timer notifications from finished rounds.
4. **Settled means all of:** status idle/done held across several checks (agy reports `done` early while background tests still run), at least one commit on the ticket branch, a clean working tree, and the pane tail read by the orchestrator. A pane that went idle with the prompt still sitting unsubmitted in the input box is not done: `pane read` a few seconds after sending, and send `Enter` again if needed. Clear a stale paste with `ctrl+u` first.
5. **Review.** Spawn the Opus reviewer (medium effort, read-only) against the exact commit and the ticket file plus the spec. It must not modify the repo or change git state; throwaway probes only in the scratchpad; findings ranked and written to `<scratchpad>/review-NN-rK.md`. Reviewer checks: every acceptance criterion against the code and tests, behaviour of a persona-less launch unchanged, no test depends on a real model, no leaked child processes or temporary files, `bootstrap/README.md` and `bootstrap/HOST.md` free of stale claims.
6. **Fix rounds.** Relay findings to the same builder pane with a file pointer (write `<scratchpad>/fix-NN-rK.md`, send one line). When it settles again, run the review again on the new commit. Stop after three rounds and ask the user.
7. **Close.** Merge to the integration branch, then update the tracker (docs-only commit on the integration branch): set the ticket's `**Status:**` to `done — merged to feature/subagent-widget-persona`, tick only the acceptance criteria verified against the merged code, tests or review, leave unmet ones unticked with a one-line note and tell the user, and add a short verification note (the test command run and its result). Close the tab, remove the worktree, then start the next ticket.

## Builder prompt (every ticket)

Write one file per round. It must contain:

- The ticket file path and the spec path (`.scratch/subagent-widget-persona/spec.md`); tell the builder to read both fully and to use the vocabulary of `GLOSSARY.md`.
- The worktree path and branch, and that all work and commits happen there.
- Test-first, one vertical slice at a time, through the existing subagent widget harness and its fake `pi` executable (the `SUBAGENT_PI_BINARY` seam). No test may depend on a real model or touch the user's real persona folders.
- Wrap every test run in `timeout`, with `--test-timeout`. The widget suite command is `timeout 300 node --test --experimental-strip-types --test-force-exit --test-timeout=60000 subagent-widget/subagent-widget.test.ts` (run from the extensions directory; confirm the path against the repo before sending). Find the Bootstrap suites' command in the repo and use the same wrapping.
- **Update documentation**: `bootstrap/README.md` and `bootstrap/HOST.md` for any behaviour the ticket changes, plus grep them for stale claims such as "a subagent has no persona" or "follow-on ticket".
- Do not touch `GLOSSARY.md` except to fix a contradiction with shipped behaviour, and say so if it does.
- Commit with a conventional message (`feat(subagent-widget): ...`), leave a clean tree, and end by printing a summary: what changed, tests run and results, anything not done.
- Forbidden: editing other tickets' files, other specs, `main`, the user's primary checkout, or global configuration; `git push`; deleting branches.

## Reviewer prompt (every round)

Read-only. Name the exact commit and the diff against the integration branch. Provide the ticket, the spec and `GLOSSARY.md`. Ask for a ranked list: blocking (acceptance criterion unmet, persona-less behaviour changed, leak, race, stale doc claim), then non-blocking. For each finding: file and line, the failure scenario, and the fix direction. Findings go to the scratchpad file; the reviewer's chat reply is only the path and a one-line verdict.

## Tracking

Keep a table in the orchestrator's replies, updated after every state change:

| Ticket | Tier | State | Branch/worktree | Round | Next action |
| --- | --- | --- | --- | --- | --- |

States: `blocked` → `ready` → `building` → `settled` → `in review` → `fixing` → `merged` → `done`. Report a one-line status to the user whenever a ticket changes state, and a short wrap-up after 06 (what merged, test results, open notes).

## Ask the user

Only these are the user's decisions; everything else follows this file:

- Starting the build (launching agents spends usage), unless the user has already said to proceed.
- The first agy launch in a new worktree directory asks "Do you trust this folder?". The earlier pre-authorisation covers only `~/.cache/host-backends-work/`, so ask once for `~/.cache/subagent-widget-persona-work/`; on a yes, confirm later worktrees there without asking again.
- If the permission classifier denies a builder launch (the codex bypass flag and agy skip-permissions flag have been denied before), say so and ask the user to allow it in chat; retry once they have.
- A third failed review round on one ticket, a tier change, or a conflict between a ticket and the spec.
- Merging `feature/subagent-widget-persona` into `main`, and any push.

## Done means

All six tickets merged to the integration branch and marked done; the spec's status line updated to implemented and verified (ticket 06 does this); the widget and Bootstrap suites green; no leftover worktrees, tabs, child processes or temporary files from the run; the user told the integration branch is ready for their decision.
