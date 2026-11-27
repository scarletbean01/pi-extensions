# Subagent widget efficiency: cheaper workers, fewer parent turns, honest results

Status: ready-for-agent. Prepared 2026-11-27 from a grill-with-docs session (13 decisions, all accepted as recommended). Vocabulary follows `GLOSSARY.md`; **Subagent** was added by this session (a short-lived child Pi session launched by the parent for one side task; not a node, no persona). No ADR: every decision is easy to reverse.

## Problem Statement

The subagent widget (`/sub`, `/subcont`, `/subrm`, `/subclear` and the `subagent_*` tools) costs the parent more than it should and sometimes reports the wrong thing:

- A subagent loads every global skill and Pi's own docs before doing anything. A no-op prompt billed 5,175 input tokens, about 3,400 of them skills and docs.
- Each subagent that finishes wakes the parent with its own LLM turn. Launching three in parallel costs one turn to say "waiting", then three more as they finish.
- The result the parent receives is all the subagent's narration plus stderr, cut at 8 KB. A chatty subagent has its final answer cut off while its intermediate chatter fills the parent's context.
- Removing or clearing a subagent kills it, but it still wakes the parent as if it had finished.
- Continuing a subagent silently switches it to the parent's current model, which also loses the prompt-cache hit.
- The parent pays for three management tool schemas on every turn, even when no subagent exists.
- The widget rebuilds every subagent's box on every streamed token, rescans the whole transcript to find the last line, and runs one timer per subagent.
- Quitting Pi can leave child processes running. Session files for removed subagents are never deleted.
- A prompt that starts with `-` or `@` is parsed as a flag or attachment.

## Solution

Subagents start lean, report once, and clean up after themselves.

- A subagent starts with no skills, MCP servers, prompt templates, themes or Pi docs, and with read-only tools. A launch can opt in to specific skills or to write access.
- When a subagent finishes, the parent hears its final message only, with token and cost usage. Stderr is attached only when the subagent failed.
- Completions are held while any sibling is still running. The parent is woken once, with every result, when the last running subagent settles.
- Launching tools end the parent's turn when nothing else in the batch needs a reply.
- Removing or clearing a subagent never wakes the parent. A subagent that ignores the polite kill is force-killed.
- Continuing a subagent keeps its original model and thinking level unless the call overrides them.
- The list, continue and remove tools exist for the model only while a subagent exists.
- The widget is one combined display with one row per subagent, updated cheaply.
- Quitting Pi stops every child. Session files go when their subagent is removed, and old ones are pruned at startup.

## User Stories

1. As a parent agent, I want a subagent to start without skills, MCP servers, prompt templates, themes or Pi docs, so that a trivial task does not bill thousands of unused input tokens.
2. As a parent agent, I want subagents to default to read-only tools, so that a scouting task cannot modify files and does not carry write-tool schemas.
3. As a parent agent, I want to opt a subagent in to named skills when its task needs them, so that leaner defaults never block a legitimate use.
4. As a parent agent, I want to opt a subagent in to write access explicitly, so that building work is still possible.
5. As a user, I want a prompt that begins with `-` or `@` to reach the subagent as plain text, so that it is not misread as a flag or file attachment.
6. As a user, I want a subagent to run in the directory I am working in, using the Pi binary I am running, so that it never operates on the wrong tree or a different Pi.
7. As a parent agent, I want to receive only a finished subagent's last message, so that its narration does not fill my context.
8. As a parent agent, I want a long final message cut from the front, keeping its end, so that the conclusion survives truncation.
9. As a parent agent, I want a failed subagent's stderr attached to its result, so that I can see why it failed without noise from successful runs.
10. As a parent agent, I want each result to carry the subagent's token and cost usage, so that I can account for what delegation cost.
11. As a parent agent, I want to be woken once when all running subagents have settled, so that three parallel subagents cost one turn, not three.
12. As a parent agent, I want that single wake-up to contain every result that settled meanwhile, so that I can act on them together.
13. As a parent agent, I want to be able to list subagents while some are still running, so that I can peek without waiting for the batch.
14. As a parent agent, I want launching a subagent to end my turn when the batch holds only launches, so that I do not spend a turn saying "launched".
15. As a parent agent, I want a launch batch that also contains other tool calls to behave normally, so that launching never cuts off other work in the same step.
16. As a user, I want removing or clearing a subagent never to wake the parent, so that a cancelled task costs no tokens.
17. As a user, I want a subagent that ignores the polite kill to be force-killed after a short wait, so that removal always works.
18. As a user, I want continuing a subagent to keep the model and thinking level it started with, so that the conversation and prompt cache stay coherent.
19. As a user, I want to override the model or thinking level explicitly when continuing, so that I can still change them on purpose.
20. As a parent agent, I want the list, continue and remove tools to appear only while a subagent exists, so that I do not pay for their schemas otherwise.
21. As a user, I want other extensions' tools untouched when those tools switch on and off, so that this extension cannot disable anything it does not own.
22. As a user, I want one compact widget with one row per subagent showing its id, status, elapsed time, current tool and last line, so that many subagents do not stack many bordered boxes.
23. As a user, I want rows truncated by terminal width, not string length, so that wide characters and colour codes never break the layout.
24. As a user, I want the widget to cost almost nothing while text streams, so that watching a busy subagent does not slow the terminal.
25. As a user, I want quitting Pi to stop every running subagent, so that no child process outlives the session.
26. As a user, I want a removed subagent's session file deleted, so that disk does not fill with files nothing can resume.
27. As a user, I want subagent session files older than a week pruned when Pi starts, so that abandoned files do not accumulate while recent ones stay inspectable.
28. As a maintainer, I want to rerun the token benchmark and see first-turn input tokens fall to about 2,000 or fewer, so that the saving is measured, not claimed.

## Implementation Decisions

- **Lean worker context.** The subagent launch always disables skills, MCP, prompt templates, themes and Pi docs. Opt-ins are per launch: a list of skills to enable, and a write-access flag that adds shell and edit tools to the read-only default. The prompt is passed after an end-of-options marker. The subagent runs in the parent's working directory, resolved Pi binary, and without copying the whole parent environment.
- **Final-message result.** The widget records the last assistant message's text and accumulated usage from the subagent's message-end events. It keeps stderr separate and attaches it only on a non-zero exit. Truncation keeps the tail. Intermediate narration is still shown in the widget's last line but is not delivered.
- **Coalesced completion.** The widget keeps a queue of settled results. A result is delivered immediately when it is the last running subagent; otherwise it waits. One follow-up message carries all queued results and triggers one turn. A subagent continued before the batch settles rejoins the running set.
- **Cancellation.** Removal marks the subagent cancelled before killing it, the close handler does nothing for a cancelled or already-removed subagent, and a force-kill follows after 5 seconds if the process is still alive. A cancelled subagent counts as settled for coalescing so it cannot hold the batch open.
- **Terminate on launch.** `subagent_create` and `subagent_continue` mark their result as terminating. Pi only ends the turn when every result in the batch terminates, so mixed batches are unaffected.
- **Continuation keeps its model.** A continuation uses the subagent's stored model and thinking level; an explicit override replaces them and is stored.
- **Lazy management tools.** `subagent_create` stays always active. List, continue and remove register inactive and are switched on when the first subagent exists and off when the last is removed, by adding and removing only these names from the active set. Descriptions are shortened and no longer duplicated. If the measured per-turn saving is under about 150 tokens, this decision is dropped and the ticket closed without change.
- **One widget.** A single widget replaces the per-subagent boxes. It tracks each subagent's last line incrementally, shares one 1-second timer that runs only while something is running, redraws through the host's render request, and measures width with Pi's terminal-width helpers.
- **Stream handling.** Only the new chunk is split for line framing, carriage returns are stripped, and lines for event types the widget ignores are not parsed.
- **Lifecycle.** A session-shutdown handler stops every child, clears the timer and removes the widget; the existing session-start reset stays. Session files are deleted on remove, clear and the remove tool. Session files older than 7 days are pruned at session start. The directory is created once, asynchronously.
- **Subprocess workers stay.** Workers remain child Pi processes. Moving them in-process is a separate, later spike.
- **Shared pattern is untouched.** `bootstrap`, `bootstrap/worker` and `coms` use the same follow-up-and-trigger-turn pattern. This work changes only the widget's own use of it.

## Testing Decisions

- **One seam:** the extension's entry point, driven by a fake host (a fake extension API recording registered tools, commands and sent messages, and a fake UI context) and a fake `pi` executable placed first on the search path that emits scripted JSON event lines, stderr and exit codes. Tests assert external behaviour: what the fake host was told, what arguments the fake executable received, which files exist, which processes are alive.
- A good test names a user story. It never asserts internal state or private helpers.
- Prior art: bootstrap's runtime tests, using `node --test --experimental-strip-types --test-force-exit --test-timeout=60000`. Wrap runs in `timeout`.
- Covered: launch arguments (lean flags, read-only default, opt-ins, end-of-options marker, working directory); final-message delivery and truncation; usage totals; stderr on failure; coalesced wake-up (one message for a parallel batch, immediate for a lone subagent); cancellation never sends and force-kills; continuation model retention; tool activation set; shutdown stops children; session-file deletion and pruning; widget rendering against a fake terminal width.
- The token benchmark rerun is a measurement documented in `docs/token-benchmark/`, not a test.

## Out of Scope

- Running subagents in-process through the Pi SDK. A spike for it may follow once this work lands.
- Changing the follow-up pattern used by `bootstrap`, `worker` or `coms`.
- Batch or wait-for-result modes on `subagent_create`.
- A debounce window for completions.
- Making subagents resumable across Pi restarts.

## Further Notes

- The fact check found that `--tools` restricts built-in tools only; MCP tools stay available unless MCP is disabled, so the MCP-off flag is required.
- The 5,175-token baseline and its cause are recorded in `docs/token-benchmark/README.md`. Tickets that change prompt size should rerun the benchmark as ticket 07 does.
- `bootstrap/README.md` and `bootstrap/HOST.md` must be checked for stale statements about the widget in every ticket.
