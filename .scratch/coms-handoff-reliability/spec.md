# Coms delivery reliability and the fallback wake-up for handoffs

Status: ready-for-agent. Prepared 2026-11-26 from a grill-with-docs session (20 decisions, all accepted as recommended; the strict-name flag from decision 6 was replaced by decision 11). It covers tiers P0 and P1 of the engineering roadmap; P2 and P3 are separate later efforts. Vocabulary follows `GLOSSARY.md` (**Handoff**, **Wake-up** and **Redelivery** were added or used here; also run, node, attempt, join, decision node, loop body, risk lane). Architecture follows ADR 0001 (agents drive graph execution) and ADR 0003 (the handoff offer is the only authority; a wake-up is a hint; Herdr status is never workflow state), which this session wrote.

## Problem Statement

Bootstrap runs move work between agents through Coms, and today Coms can break a valid run, misroute a reply or hang it outright:

- A review loop that needs a third revision dies with "hop limit reached", because every handoff in the chain adds a hop and the limit is a fixed 5, however many attempts the run allows.
- When two Coms prompts reach one agent close together (as at a join), the reply to the first can be sent to the sender of the second, because the agent tracks whichever prompt arrived last and answers the newest unanswered prompt first, while Pi processes queued prompts oldest first.
- If a destination agent's process is alive but its event loop is stuck, the sender waits forever for an acknowledgement. Its completion never finishes, and nothing falls back or retries.
- A handoff notification with a large non-ASCII predecessor preview can exceed the frame limit, which counts characters, not bytes, and is only 64 KiB.
- When a worker's Coms name is already held, Coms quietly registers it under a numbered name. Launch then fails with a generic "Invalid readiness acknowledgement" that does not say why.
- When Coms cannot reach a live destination at all (its socket is gone), the handoff waits until an operator runs recovery. The destination is sitting in a Herdr pane that could have been woken directly.

Two planning gaps also produce misleading results in parallel graphs that share one checkout:

- A risk lane compares whole-repository snapshots, so one loop's review sees a parallel branch's edits as its own and escalates (for example to `closed`).
- Verification checks recorded without a scope snapshot the whole tree, so a parallel branch saving any file during a check makes it unverified or stale.

Nothing warns the operator about either before launch.

## Solution

Coms becomes deterministic and fails fast:

- The hop limit for bootstrap workers is sized from the run's attempt budget.
- Replies go to the prompt the turn actually answered, oldest first.
- Every send gives up after a bounded wait with a distinct "delivery unknown" error.
- Frames are measured in bytes with a 256 KiB cap.
- A worker whose Coms name was changed fails launch at once with an exact reason.

When Coms cannot deliver a handoff's wake-up, bootstrap falls back to typing a one-line wake-up into the destination's Herdr pane. The destination accepts it only if the handoff offer on record matches. This happens once, automatically, from the sending agent, and again whenever an operator uses recovery's redelivery.

Planning (`dry_run`) warns when risk lanes or required checks would be confused by concurrent writers in one checkout. Lane and verification snapshots keep their current conservative behaviour.

## User Stories

Review loops and hop limits

1. As an operator, I want a review loop to run as many revisions as its decision node and the run's attempt budget allow, so that valid runs are not killed by a transport limit.
2. As an operator, I want the hop limit for bootstrap workers to be derived from the run's total attempt budget, so that I never have to tune it by hand.
3. As an operator, I want runaway Coms loops outside bootstrap to stay bounded by the existing default limit, so that ordinary agent-to-agent use keeps its protection.
4. As an operator, I want a runaway chain inside a bootstrap run to still stop at a bound, so that a misbehaving graph cannot ping-pong forever.
5. As an agent, I want a hop limit that sender and receiver agree on, so that a handoff the sender allowed is not rejected by the receiver.

Reply routing

6. As an agent at a join, I want each Coms prompt's reply to go back to that prompt's sender, so that predecessors are not handed each other's answers.
7. As an agent, I want queued Coms prompts answered oldest first, so that the order matches the order Pi processes them in.
8. As an agent, I want a Coms send made during a turn to inherit the hop count of the prompt that turn is answering, not of a prompt that arrived later, so that hop counts stay accurate.
9. As an agent, I want a prompt arriving mid-turn to leave the current turn's routing alone, so that a late arrival cannot hijack the reply in progress.
10. As an operator, I want replies to be correct even when two predecessors finish in the same instant, so that joins behave the same however close the timing is.

Bounded sends

11. As an agent, I want a Coms send to give up after a bounded wait (5 s by default, configurable) when the peer accepts the connection but never acknowledges, so that my completion is not stuck forever.
12. As an agent, I want a Coms send to give up when the connection itself cannot be made in time, so that a dead or stuck peer is reported quickly.
13. As an agent, I want a timed-out send reported as "delivery unknown", distinct from a refusal, so that I know the message may still have arrived.
14. As an agent, I want the reply I send back at the end of a turn to be bounded the same way, so that a stuck original sender cannot stall me.
15. As an operator, I want a stuck destination to surface as a fast, named failure, so that fallback or recovery can act on it.

Frame size

16. As an agent, I want handoff notifications with up to 40 KB of non-ASCII predecessor preview to be delivered, so that runs in any language work the same.
17. As an agent, I want the frame limit measured in bytes on both sending and receiving sides, so that the limit means the same thing everywhere.
18. As an agent, I want an oversized frame refused with a clear error rather than cut, so that a handoff is never delivered half-read.

Name collisions

19. As an operator, I want a worker whose Coms name was changed because of a collision to fail launch immediately, so that I am not left waiting for a readiness timeout.
20. As an operator, I want that failure to name the wanted and the assigned name, so that I can see at once that it was a collision.
21. As an operator, I want ordinary Coms users to keep today's automatic renaming, so that only bootstrap workers fail on a collision.

Fallback wake-up

22. As an agent completing an attempt, I want my handoff's wake-up to fall back to the destination's Herdr pane when Coms fails or times out, so that my successor starts without an operator.
23. As an agent, I want the fallback to be tried once and its outcome recorded, so that a failure is visible to recovery and status.
24. As an agent, I want the fallback attempted only when the destination's process is still alive, its handoff is unclaimed and its pane still exists, so that I never type into a dead or reused pane.
25. As an operator, I want the fallback never to depend on Herdr's idle or working status, so that a misleading status cannot start or stop work.
26. As a destination agent, I want each worker to report its own Herdr pane in its readiness record, so that a sender can find me without the dispatcher's manifest.
27. As a destination agent, I want a wake-up that arrives in my pane to be accepted only if it names a handoff offer on record for my own current attempt, so that typed text cannot start work it should not.
28. As a destination agent, I want an accepted pane wake-up to go through exactly the same claim and validation as a Coms-delivered one, so that there is one acceptance path.
29. As a destination agent, I want a pane wake-up for a handoff I already claimed to be a harmless replay, so that a Coms delivery and a fallback wake-up for the same handoff never run it twice.
30. As a person typing in a worker's pane, I want anything that is not exactly a wake-up line to reach the agent as normal input, so that the fallback does not swallow what I type.
31. As an operator, I want the wake-up to be a single line with no secret token, so that it cannot submit early in a terminal and there is no key to manage.
32. As an operator running recovery, I want redelivery to use the same fallback when Coms cannot reach the destination, so that one recovery action works in both cases.
33. As an operator, I want the record of a handoff to show whether its wake-up went by Coms or by the pane fallback, so that I can tell how a handoff was delivered.
34. As an operator of a run launched before this change (no pane in its readiness records), I want handoffs to behave exactly as before, so that old runs are not affected.

Planning warnings in a shared checkout

35. As an operator, I want `dry_run` to warn when risk lanes are configured and loop bodies can write concurrently in one shared checkout, so that I expect possible false escalations before launch.
36. As an operator, I want risk lanes to keep comparing whole-repository snapshots, so that writes outside a node's declared paths are still caught.
37. As an operator, I want `dry_run` to warn when parallel branches declare required checks in one shared checkout, so that I know to give their verification a scope.
38. As an operator, I want verification without a scope to keep snapshotting the whole tree, so that a check is never reported current after an edit to a file it reads but did not declare.
39. As an operator, I want these warnings to be warnings, not planning failures, so that existing graphs still launch.

Docs and vocabulary

40. As a maintainer, I want the bootstrap README to describe the bounded send, the fallback wake-up and the new warnings, so that its account of delivery matches the code.
41. As a maintainer, I want the README's note about wake-ups being faked in deterministic tests updated, so that it reflects the new coverage.

## Implementation Decisions

Coms (transport only; it knows nothing about bootstrap)

- The hop limit stays configurable through the existing per-process environment variable. Coms does not special-case any conversation ID. The default stays 5.
- The prompt a turn answers is found from the `coms-inbound` message of that turn (its message ID in the message details), not from the order prompts arrived on the socket. Arrival only adds a prompt to the pending set.
- End-of-turn reply dispatch fulfils the oldest unfulfilled pending prompt, matching Pi's default one-at-a-time, first-in first-out follow-up queue.
- Every envelope send (prompts, replies and pings) has one bounded wait covering connection and acknowledgement: 5 seconds by default, overridable with a new Coms environment variable for the acknowledgement timeout. On expiry the socket is destroyed and the send fails with an error that callers can tell apart from a refusal (nack) and from "unreachable" (no live agent or connection refused): "delivery unknown".
- Both line readers (client and server) count received bytes, not characters, against one shared cap of 256 KiB.
- Name resolution is unchanged: a collision still produces a numbered name and a `coms-log` entry.

Bootstrap launcher

- The generated launcher for agent nodes sets the Coms hop-limit variable to the larger of 5 and the run's total attempt budget plus 2. The total attempt budget is the bound plan's value. Graphs without a decision node already use the node count. Command nodes do not use Coms and are unchanged.

Bootstrap worker

- On startup the worker compares the Coms name it was registered under with its expected instance ID. If they differ, it writes its node's error record ("coms name collision: wanted X, got Y") and does not acknowledge readiness. The dispatcher's existing readiness loop already fails at once on that record.
- The readiness record gains an optional pane ID, taken from the worker's own Herdr environment. Parsing accepts records with or without it, and records from older runs stay valid.
- When completing an attempt with a successor, the worker keeps the existing order: persist the result, write the durable handoff offer, then send the wake-up by Coms. If the Coms send fails as unreachable or delivery-unknown, the worker calls the fallback wake-up once before shutting down, and records the outcome on the handoff (queued by Coms, queued by pane fallback, or failed with reason).
- The worker's existing input hook recognises exactly one line form: `[BOOTSTRAP_WAKE handoff=<handoff_id>]`, with nothing else on the line. On a match, it reads the handoff offer for its own current attempt from disk. If the offer exists, matches the handoff ID, run and destination attempt, and is unclaimed, it rebuilds the normal handoff notification from the offer and feeds it into the same path a Coms-delivered handoff takes (claim, then admission checks). A match against a claimed handoff is a harmless replay. Any input that does not match the form exactly passes through untouched.
- For a pane wake-up, sender identity is not checked. The offer match replaces it (ADR 0003).

Fallback wake-up (one shared module used by the worker and by recovery)

- Interface: given the run's session directory, the destination attempt and the handoff ID, it decides whether a pane wake-up is allowed and, if so, sends it. It returns sent, skipped with a reason, or failed with a reason.
- A wake-up is allowed only if all of these hold: the destination's readiness record has a pane ID; its process is alive; the offer exists and is unclaimed; and Herdr reports the pane exists. Herdr idle, working, blocked or done status is never consulted (ADR 0003).
- The wake-up is sent as one line through the `herdr` command line. Only the Herdr TUI backend is in scope.

Recovery

- Recovery's injectable wake-up dependency gains the fallback. Redelivery tries Coms first. If Coms fails as unreachable or delivery-unknown, it tries the pane fallback and reports which transport was used. The existing recovery record that authorises the dispatcher as a sender is unchanged.

Planning warnings (both at `dry_run`; neither fails planning)

- Risk lanes: if lanes are configured and two or more loop bodies (or a loop body and another writer) can run concurrently in the same shared checkout, emit a warning. It names them and explains that lane snapshots are whole-repository, so one loop's review can count another's edits. Snapshot scope and classification are unchanged.
- Verification: nodes declare only required check IDs. The scope of a check is chosen when the agent records it. So if two or more concurrently runnable nodes in one shared checkout declare required checks, emit a warning advising that their checks be recorded with a scope. The conservative whole-tree default is unchanged.

## Testing Decisions

- A good test drives behaviour from outside, through real processes and records: a Pi session with the real Coms and worker extensions and a fake model provider, the durable session records, and the `dry_run` output. Tests do not reach into Coms internals or mock the module under test.
- Seam 1, the real-process runtime harness, is the existing pattern in the runtime smoke tests: real `pi`, real Coms, real worker, the fake provider, and an isolated Coms directory and state directory. New runtime Coms tests cover:
  - a two-node loop that passes more hops than 5 when the hop-limit variable is set, and fails at the bound when it is not;
  - a raw socket peer that accepts but never acknowledges, so the send fails as delivery-unknown within the timeout;
  - a multibyte frame just under and just over the byte cap;
  - two prompts arriving while a turn is in progress, each reply reaching its own sender, oldest first;
  - a name collision that fails launch with the exact reason.
- Seam 2 is a fake `herdr` binary on `PATH`, following the existing launch-child test support, which already runs the service against a fake `herdr`. It records pane-existence queries and injected text. Tests cover:
  - the primary Coms wake-up;
  - the fallback after the destination's socket is removed, with the recorded line fed back into the destination's input to prove it claims;
  - no fallback when the process is dead, the offer is claimed or the pane is gone;
  - non-matching input passing through;
  - a duplicate wake-up as a harmless replay;
  - an old-format readiness record with no fallback.
- Seam 3 is the recovery service with its injected wake-up, as in the existing recovery service tests. Redelivery falls back to the pane and reports the transport.
- Seam 4 is planning output (`dry_run`), as in the existing lane and ownership planning tests. Each warning appears for concurrent writers in a shared checkout and does not appear for a serial graph or a graph without lanes or required checks.
- Seam 5 is one test in the live Herdr suite, gated as that suite already is on running inside Herdr. It injects a real pane wake-up into a real worker and sees the handoff claimed.
- The generated launcher's hop-limit value is checked through the launch harness: the launcher it writes, for a plan with a known attempt budget.

## Out of Scope

- All of roadmap P2: preserving `started_at` across Coms heartbeats, random temporary registry file names, removing signal listeners on reload, abort-aware run-lock waits, and diagnostics for write-path starvation during human waits.
- All of roadmap P3:
  - Program Status (OSC 7501) from `herdr-agent-state.ts`;
  - a host runtime interface with the herdr-core (`hc`) backend, including `hc send` and `<hc>` tag stripping for wake-ups;
  - moving session records out of the project checkout.
- Detecting recycled process IDs in the Coms registry.
- A `--strict-name` Coms flag (replaced by the worker-side check) and any change to `--explicit`.
- Scoping risk-lane snapshots to declared write paths, or subtracting other units' paths from them (accurate attribution is a possible later effort).
- Auto-scoping verification snapshots to declared paths.
- Signed or nonce-bearing wake-ups.
- Gating the fallback on Herdr agent status.

## Further Notes

- **Hop bound.** In the session, a `2 × attempts` bound was briefly suggested and retracted. The total attempt budget already counts every node's attempts, and a handoff chain cannot be longer than it, so `budget + 2` is a sound bound.
- **Name collisions today.** A collision already fails launch today, through the readiness identity check, but with a generic message. This work makes it immediate and specific, and does not change Coms.
- **Delivery unknown.** A "delivery unknown" result means the destination may already hold the wake-up. That is safe because acceptance is the destination's exclusive claim, and every later wake-up for a claimed handoff is a replay.
