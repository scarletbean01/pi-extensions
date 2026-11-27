# Host backends: launch nodes through Herdr or hc, plus Coms and lock hygiene

Status: done — merged to main. Tickets 01–06 and 08–11 done; ticket 07 superseded (Pi's native OSC 7501 reporter; see the ticket). Verified by tests and isolated live hc runs (findings `bootstrap-hc-findings-6bLWs8`, `FbreNh`, `jRcpfo` under this directory). Still unverified: real non-idle Pi transitions inside hc, Pi's end-to-end capability negotiation with hc, and a wake-up against a real open Pi dialog (tagged in `bootstrap/HOST.md`). Original note:, but **start only after `coms-handoff-reliability` (its tickets 01–07) has merged to `main`**: this work touches launch, the worker and the pane wake-up module those tickets create. Prepared 2026-11-26 from a grill-with-docs session (28 decisions, all accepted as recommended; the backend-selection decision was revised once because `HC_TERMINAL_ID` is unset outside hc terminals). Vocabulary follows `GLOSSARY.md` (**Host** and **Host backend** are new, **Resource closure** was reworded; also **Wake-up**, **Handoff**, **Redelivery**, **Human wait**). Architecture follows ADR 0003 (the handoff offer on disk is the only authority; Host status is never workflow state) and ADR 0004 (the Host seam), both written in the same session.

## Problem Statement

An operator who runs bootstrap graphs can do so only from inside a Herdr pane. Every call to the `herdr` command line sits inside one class that also plans, launches and cleans up runs, so using any other terminal multiplexer means editing launch, cleanup and discovery in place. The operator wants to move to `hc` (herdr-core), which works from any shell, names and labels its terminals and has no workspace concept, and wants the Herdr runtime to keep working. Neither runtime is documented anywhere as an interface: what a Host must do, which command does it on each backend, and which behaviours are verified are all unwritten.

Alongside that, a few smaller defects make runs less trustworthy:

- A session's recorded start time is overwritten on every heartbeat, which defeats boot-time and process-reuse checks.
- Coms registry files are written through a fixed temporary name, so two writers can collide.
- Repeated `/reload` leaks signal listeners.
- A cancelled call waits up to 15 minutes on a contended run lock before it can stop.
- A loop paused on a human request keeps its write paths, and nothing in `bootstrap_status` says why a downstream writer is waiting.

## Solution

Bootstrap launches nodes through a narrow **Host** interface with two backends, `herdr` and `hc`. The operator can run it from a Herdr pane, from an hc terminal or from an ordinary shell. The backend is chosen once per run and frozen, so recovery works from any environment. Herdr behaves as it does today. hc nodes are independent terminals that survive the dispatching session and are cleaned up explicitly. The fallback wake-up reaches either backend, never forces an agent that is blocked, and leaves the handoff offer on disk as the only authority. A written contract (`HOST.md`) describes the interface, both command lines side by side, and which hc behaviours are still unverified; a gated live spike settles those. The hygiene defects are fixed as small independent changes, and `bootstrap_status` explains when a loop is holding write paths because it is waiting on a person.

## User Stories

Choosing and keeping a backend

1. As an operator working from a Herdr pane, I want bootstrap to keep launching through Herdr exactly as it does today, so that moving to a new backend never changes my existing workflow.
2. As an operator working from an hc terminal, I want runs to launch through hc without any setup, so that I can use hc as my daily tool.
3. As an operator whose orchestrator runs in an ordinary shell, I want bootstrap to use hc when the `hc` binary is installed and its core answers, so that I do not have to launch my agent inside a multiplexer first.
4. As an operator, I want one setting that forces `hc` or `herdr`, so that I can override detection when my setup is unusual.
5. As an operator with both tools installed who works inside a Herdr pane, I want Herdr to stay the backend, so that installing hc does not silently move my runs.
6. As an operator with neither tool available, I want a clear failure that names both options, so that I know what to install.
7. As an operator, I want the backend chosen once when a run launches and recorded in its manifest, so that the run keeps one backend for its whole life.
8. As an operator recovering a run from a different shell, I want recovery to use the run's recorded backend, so that it does not matter where I recover from.
9. As an operator with older runs, I want a manifest with no recorded backend to be treated as Herdr, so that those runs still recover and clean up.
10. As an operator, I want existing Herdr fields and `bootstrap_cleanup` by tab id to behave exactly as before, so that nothing I scripted breaks.

Launching, inspecting and closing nodes

11. As an operator, I want each node to launch in its own terminal in the right directory with the same environment on both backends, so that agents behave the same wherever they run.
12. As an operator on hc, I want the node's Coms settings (directory, timeout and hop limit) to reach the agent, so that Coms behaves identically to Herdr runs.
13. As an operator on hc, I want nodes to keep running after the session that launched them ends, so that a finished dispatcher turn does not kill my graph.
14. As an operator on hc, I want nodes not to type notes into the dispatcher's input, so that the dispatcher is not confused by terminal chatter.
15. As an operator, I want a node's name to be valid and unique on hc even when the task or instance id is long or awkward, so that launch never fails on naming.
16. As an operator, I want a run to recognise its own nodes by labels and terminal id rather than by name, so that a renamed or look-alike terminal is never closed by mistake.
17. As an operator, I want cleanup to close only terminals the run owns, on either backend, so that my other terminals are safe.
18. As an operator on Herdr, I want cleanup to keep leaving a tab alone if I rearranged it, so that the existing protection stays.
19. As an operator on hc, I want closing a node to end its process and remove its terminal, so that Resource closure means the same thing on both backends.
20. As an operator, I want liveness and status to keep coming from durable records and the process, never from what the Host reports, so that a Host quirk can never change workflow state.
21. As an operator, I want a launch failure caused by the Host to say which backend and operation failed, so that I can fix my setup.

The fallback wake-up

22. As an operator, I want the fallback wake-up to work on both backends, so that a Coms failure is recovered the same way everywhere.
23. As an operator, I want a wake-up to a blocked agent to be skipped rather than forced, so that it can never type into a permission prompt or a human request.
24. As an operator, I want a skipped wake-up to leave the offer on disk for Redelivery, so that no handoff is lost.
25. As an operator, I want the wake-up never to depend on the Host's idle, working or done status, so that status stays advisory.
26. As a destination agent on hc, I want a wake-up delivered inside the single wrapper hc may add to be recognised, so that the wrapper does not defeat the fallback.
27. As a destination agent, I want anything other than that exact wake-up line, with at most one wrapper, ignored, so that arbitrary pasted text can never claim a handoff.
28. As an operator, I want the handoff's transport (Coms, pane wake-up, skipped, failed) recorded the same way on both backends, so that status reads the same.

Documentation and verification

29. As a maintainer, I want one document that lists every Host operation with the Herdr and hc commands side by side, so that I can add or change a backend with confidence.
30. As a maintainer, I want each hc behaviour tagged verified or unverified with its source, so that I know what I can rely on.
31. As a maintainer, I want an ADR that records why the seam is shaped this way and what was rejected, so that nobody re-proposes detection by `HC_TERMINAL_ID` alone or a Herdr replacement.
32. As a maintainer, I want one contract test suite that runs against both backends, so that they cannot drift apart.
33. As a maintainer, I want a fake `hc` beside the fake Herdr executors, so that deterministic tests need no real multiplexer.
34. As a maintainer, I want a gated live hc suite on an isolated core, so that I can verify the real behaviour without risking my own terminals.
35. As an operator, I want a live spike to settle the undocumented hc behaviours before anything depends on them, so that nothing is built on a guess.
36. As an operator, I want the live suites to run only when I say so, so that automated builders never touch my real terminals.

Status on hc

37. As an operator on hc, I want agents to report working, idle, blocked and done to hc, so that they appear correctly in hc's own views.
38. As an operator, I want that reporting to switch on only under hc and never to affect Herdr's own reporting, so that the two cannot interfere.
39. As an operator, I want that status to stay advisory, so that no workflow decision depends on it.

Coms and lock hygiene

40. As an operator, I want a session's start time to stay what it was at start across heartbeats, so that boot-time and process-reuse checks work.
41. As an operator, I want two writers for the same Coms name never to collide or corrupt a registry entry, so that registration is reliable.
42. As an operator, I want repeated reloads not to accumulate signal listeners, so that long sessions stay healthy.
43. As an operator, I want a cancelled call to stop waiting on a contended run lock immediately, so that I am not stuck for up to 15 minutes.
44. As an operator, I want a cancelled waiter to leave the lock and its break files exactly as it found them, so that cancelling is always safe.
45. As an operator, I want `bootstrap_status` to say when a node is waiting because a loop is paused on a person, so that I understand why downstream work has not started.
46. As an operator, I want ordinary ownership waits described as before, so that the new wording appears only when it applies.

## Implementation Decisions

Backend choice and manifest

- Backend selection uses the first rule that applies: an explicit setting naming `hc` or `herdr`; then the calling context (an hc terminal identity selects hc, a Herdr pane identity selects Herdr, and hc wins if both are present); then, with neither, hc if the binary is on the path and its core answers, otherwise a clear failure naming both options. Detection never relies on the hc terminal identity alone, because an orchestrator in an ordinary shell does not have it.
- The chosen backend is frozen as `host_backend` in the run manifest. A recovered or resumed run uses its recorded backend whatever the caller's environment. A manifest with no recorded backend reads as Herdr.
- The existing Herdr manifest fields keep their names and meaning, so older runs and `bootstrap_cleanup` by tab id are unchanged. Each launch gains an opaque, backend-owned reference. For Herdr it mirrors the old fields. For hc it holds the terminal name and the address hc returned.

The Host interface

- Operations: preflight; launch a node (name, directory, launcher, environment → handle); report whether a node's terminal exists (present, gone or ambiguous); close a node; send a wake-up; and discover which nodes a run owns. Anything about Herdr tabs, panes or workspaces stays inside the Herdr backend, including leaving a rearranged tab alone.
- Liveness stays on durable records and the process. The Host never decides workflow state (ADR 0003).
- The existing injectable executor stays the seam to the command line, so current fakes keep working.

The hc backend

- Node name is deterministic, sanitized, hashed and truncated to hc's length and character limits. Ownership is decided by labels and the terminal id, never by the name. Discovery filters by label and then confirms each terminal, because the compact listing carries no labels.
- Environment for the node is exported by the launcher script; hc's launch command has no environment flag. The Herdr backend keeps passing environment through its own flag.
- Nodes launch independent of the dispatcher and without notes typed into its input; cleanup stays explicit.
- Closing is hangup-then-remove. Resource closure means the node's terminal is finished and removed, on either backend.
- Terminal ids are stable on a core, so the "refetch after close" workaround is not needed.
- Remote hc is a documented non-goal.

The wake-up through the Host

- The send operation returns sent, skipped with a reason, or failed with a reason. The hc backend never forces and never gates on status; a refusal because the terminal is blocked is skipped, the offer stays on disk and Redelivery covers it.
- The worker accepts the bare wake-up line or exactly one wrapper around it, stripped before matching. The offer on disk stays the only authority.
- The ready record's optional pane reference becomes a backend-neutral reference, and older records read as before.

Status publishing

- Bootstrap adds no hc status extension. Pi 1.6.1 has a native OSC 7501 reporter; Pi docs describe its `working`, `blocked`, `done`, `error`, and `idle` states, capability-query behavior, and `PI_PROGRAM_STATUS=1|0` override, and Pi's blocked callers carry `kind` (`auth`, `permission`, or `question`) with ST termination. Run 3 verified hc answers the query bytes Pi sends, but a fixture sent the query, not Pi. In run 5 (`bootstrap-hc-findings-jRcpfo`), a real Pi process started in the isolated hc core with `PI_PROGRAM_STATUS` unset and reported `app=pi,state=idle` (which does not by itself prove Pi's capability query to hc worked end to end). Exact Pi-shaped ST-terminated fixtures verified hc accepts base64 `msg=` for `blocked` (`kind=auth`, `kind=permission`, `kind=question`), `working`, `done`, and `error`, returns decoded message text in `hc get --json`, accepts `idle`, and clears a seeded idle status on `state=clear` (`reported: true`, `status: null`). A separate Pi-shaped `kind=auth` blocked fixture made `hc send` refuse without `--force` (exit 9, `error.kind=blocked`, zero delivered bytes). This did not exercise non-idle Pi transitions or test a wake-up against a live Pi dialog; if a different blocked payload is rejected, Redelivery is the only backstop. Status remains advisory and never workflow state. Ticket 07 was superseded after review because a second extension would produce conflicting state reports.

Hygiene

- The Coms session keeps its start time across keepalives; heartbeat time still advances.
- Registry temporary files have a per-process, per-write unique name, and the working-directory name is derived portably.
- Signal handlers are named and removed on shutdown.
- The run-lock wait accepts a cancellation signal in both its in-process queue and its polling sleep, and a cancelled waiter never creates, breaks or removes lock files it does not hold. Callers that have a signal pass it through.
- `bootstrap_status` names the holder of contested write paths and says when the holder is waiting for a person. No planning warning about shared root manifests is added.

Documentation

- A contract document describes the interface, both command lines side by side, ids, closing, status vocabularies, manifest fields and non-goals, with every hc behaviour tagged verified or unverified. The README and the two factory guides lose their Herdr-only wording and point to it.

## Testing Decisions

- A good test drives behaviour from outside: real processes, the injectable executor, a fake binary on the path, or a held lock and an abort signal. It does not mock the module under test or assert implementation detail.
- New seam: one Host contract suite, parameterised over both backends through the executor seam, with a fake `hc` beside the existing fake Herdr executors. It covers launch, discovery, state, close, ownership, preflight failure, and recovery from a different environment using the recorded backend.
- Existing seams reused: real Pi and Coms processes (as in the runtime Coms reliability tests) for the registry fixes and a wake-up reaching a fake hc node; the `bootstrap_status` and planning tool output for the human-wait diagnostic; the run-lock API with a held lock for cancellation.
- The extraction of the Herdr backend is a pure refactor: existing suites pass with no change to their assertions.
- Gated live suites: the existing live Herdr suite stays. A new live hc suite (gated by an environment variable) runs against an isolated hc session with scratch paths, never against the operator's core. Builders write live tests but never run them; the orchestrator asks the operator first.
- Prior art: the live Herdr suite, the fake Herdr executors, the Coms reliability runtime tests, and the handoff and pane wake-up tests from the coms-handoff-reliability work.
- Every test run is wrapped in a timeout; the deterministic suite is known to hang on one web-viewer guard test, which also hangs on `main`.

## Out of Scope

- Moving a run's session directory out of the project checkout. It is the known shared-checkout trust gap (ADR 0003 and 0004), is validated in several places, and needs its own spec.
- Remote hc machines.
- Deriving verification scope from a node's declared paths, and scoping lane diffs. The earlier coms work only warns.
- An HMAC token on the wake-up (ADR 0003 explains why it adds nothing).
- Launching nodes through hc's JSON API instead of its command line.
- A planning warning about shared root manifests.

## Further Notes

- hc behaviours not documented upstream: whether `hc send` wraps text in a note wrapper and under what conditions, the test-isolation recipe, and what happens when sending to a booting agent. Pi documents its OSC 7501 report states and query/override behavior; the capability query was fixture-sent, and run 5 (`bootstrap-hc-findings-jRcpfo`) also observed a real Pi startup `idle` report inside the isolated hc core (which does not prove Pi's capability query worked end to end). hc's handling of exact Pi-shaped base64 `msg=` reports (including `blocked` with `kind=auth`/`permission`/`question`) and `state=clear` (`status: null`) is live-verified with ST-terminated fixtures; the real Pi's non-idle state transitions and a real blocked-dialog wake-up remain unverified.
- The orchestrator's builders run interactively in their own tabs; this work is meant to be built on a feature branch cut after the coms merge, one ticket at a time, with an Opus-medium review per ticket.
- Tickets live beside this file under `issues/`: 01 contract documentation, 02 launch through a Host seam (Herdr only), 03 hc launch and inspect, 04 hc close and recover, 05 live hc spike and gated suite, 06 wake-up through the Host, 07 hc status extension (superseded by Pi's native reporter), 08 Coms registry hygiene, 09 abort-aware lock wait, 10 status for held write paths. After the coms merge, 01, 08, 09 and 10 can start at once; the hc chain runs 01 → 02 → 03, then 04, 05 and 06 in parallel. Ticket 07 is superseded.
