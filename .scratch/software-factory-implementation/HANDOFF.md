# Handoff: software-factory coordinator session (updated 2026-11-23)

## Role
Coordinator only. Delegate; never implement or review yourself. Running inside herdr (`HERDR_ENV=1`). Skill in use: `/engineering implement-spec` (guide: `~/.claude/skills/engineering/implement-spec/GUIDE.md`). Plan files: `.scratch/software-factory-implementation/` (README.md, issues/NN-*.md); spec `.scratch/software-factory/spec.md`.

## Delegation rules (from the user)
- One ticket at a time. Each agent runs interactively in its OWN herdr tab (`herdr tab create --workspace w1A --label X --no-focus`, then `herdr pane run <pane> "<cmd>"`), never a split.
- Builder tiering: easy (docs, small) -> `pi --model openai/gpt-6-luna --thinking high` or agy hydrogen medium. Complex -> `agy --model gemini-4-hydrogen-high -i "<prompt>"` or sol (`pi --model openai/gpt-6.2-sol --thinking medium`). Sol is nearly exhausted: delegate complex work to agy. agy needs `-i`; never use `--dangerously-skip-permissions` (the classifier denied it; do not work around).
- Prompts go in files under `~/.cache/software-factory-work/prompts/` (NOT /tmp: it gets wiped on reboot); the agent prompt just says "Read <file> and do everything in it".
- Reviewer: Opus subagent (Agent tool, subagent_type reviewer, model opus, **effort medium** from 2026-11-23), read-only, runs mutation probes on copies in the scratchpad dir. Reviews loop until "approve".
- On merge: set ticket Status to done and tick verified criteria (`sed -i 's/^\*\*Status:\*\* ready-for-agent/**Status:** done/; s/^- \[ \]/- [x]/' issues/NN-*.md`). Do not edit ticket files in builder prompts. Ticket files are untracked.
- Commits end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_013qRkEfbaNV727MR8YBbpt8`. Never commit `.pi/`. Never share the user's email externally.
- Bounded gate (always include graph tests): `timeout 550 node --test --experimental-strip-types --test-timeout=60000 bootstrap/factory-*.test.ts bootstrap/docs.test.ts bootstrap/automatic-cleanup.test.ts bootstrap/graph-fanout.test.ts bootstrap/graph-joins.test.ts bootstrap/review-loop.test.ts bootstrap/command-node.test.ts` (664 pass at 44a1b1c). 3-4 PID-reaping sandbox tests fail environmentally in the full standalone run (`node bootstrap/run-tests.ts deterministic`). `--experimental-strip-types` does not typecheck.
- Create worktrees from the integration checkout with explicit paths: `git -C ~/.cache/software-factory-work/integration worktree add ../ticket-NN -b ticket/software-factory-NN feature/software-factory`. Never delete a worktree an agent is running in.

## Branches and state
- Integration branch `feature/software-factory` (worktree `~/.cache/software-factory-work/integration`, tip 44a1b1c = merge of ticket 15).
- **`main` now contains tickets 01-15**: merge commit 1cb4959, merged at the user's explicit request on 2026-11-23. On the same day, at the user's request, the GLOSSARY.md edits and the `.scratch` plan/ticket/handoff files were committed on top (ac30cf9, 4f2acd7) and `main` was pushed to origin. Do not push or touch `main` again without an explicit instruction.
- Tickets done and ticked: 01-15. Ticket 16 (write scope) is FROZEN/deferred for this release (user decision; Status line says so). Ready: 17 (risk lanes, blocked by 12 done), 18 (learned constraints at launch), 19 (propose/confirm constraints; blocked by 18 and 09 done). One at a time, order 17, 18, 19.
- Inactive worktrees were removed (all except `integration`). Branches kept. Leftovers: `~/.cache/software-factory-work/review-evidence/` and `ticket-04-agy-bmIQBz.patch` (offered to delete, not asked yet). `~/.cache/bootstrap-gap-work` and `bootstrap-revision-investigation` worktrees belong to other work: leave them.

## In flight
README update for the command node (user request): builder luna (high) in herdr tab pane `w1A:p1C`, worktree `~/.cache/software-factory-work/docs-readme`, branch `docs/readme-command-node`, prompt `prompts/readme15.md`. Luna committed 28c9bde ("docs: document deterministic command nodes"); NOT yet verified. Next: run `bootstrap/docs.test.ts` in that worktree, Opus (medium) reviewer checks every README claim against code (bootstrap/command-runner.ts, node-admission.ts, session-store.ts, lifecycle.ts), merge into `feature/software-factory`, close the tab, remove the worktree. The only README is `bootstrap/README.md`. Also README must be updated for tickets 17-19 as they land (one docs pass after 19 is fine).

## Remaining steps
1. Finish the README pass (above).
2. Ticket 17 -> 18 -> 19: builder agy hydrogen high (complex), Opus-medium review rounds, merge to `feature/software-factory`, rerun the bounded gate, mark done.
3. Final whole-branch Opus code review of `feature/software-factory` (guide step 7), fix in a single fresh builder, then clean up worktrees (step 9). Merging the follow-up to `main` needs a fresh explicit user instruction (stash GLOSSARY.md around it).

## Ticket 15 notes (for later docs/review)
Command node = `kind: "command"`: argv with no shell, working_directory confined to the project, trimmed env allowlist (PWD set), v7 records for runs containing command nodes (older binaries reject them), `.pgid.json` process-group record, cancel kills + verifies the group before recording cancelled/releasing ownership, damaged/unverified -> needs_attention with ownership held, release-validation errors win over a pending cancel when release.json exists, abort.json checked before release. Known non-blocking: restart with abort.json and a live orphan aborts before the orphan kill (cleanup should kill it; confirm); the demo's agent consumer is a mocked worker.

## Known non-blocking leftovers from earlier tickets
Surviving low-value mutants; `report.json` has two shapes (array vs `{results,node_counts_error}`); ticket 10 follow-ups (interrupted wait clearing marker while request pending, three small test gaps); ticket 08 follow-ups (doc inaccuracies, single failed verify_manager check ends the watch, bare catch in discard, missing control-row recovery path); no typecheck step in the gate; runtime/live suites and power-loss durability not verified.

## Recurring review defects (put in builder prompts)
Missing/damaged evidence defaulting to safe; new persisted state without version bump/allowlists; mock-only interruption tests (use real kills: bootstrap/test-support/factory-intervention-child.ts); read-only inspect that mutates; finally-cleanup clearing pending state; guards without negative tests (reviewers run mutation probes, survivors are findings); doc claims not matching code; fixes that move checks and regress an earlier guard (re-run the previous round's mutations).
