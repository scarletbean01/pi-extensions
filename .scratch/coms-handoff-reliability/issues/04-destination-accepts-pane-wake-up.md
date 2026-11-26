# 04: A destination accepts a pane wake-up

**What to build:** This ticket builds the receiving half of the fallback **Wake-up** (ADR 0003: the handoff offer is the only authority; a wake-up is a hint).

- Each agent worker records its own Herdr pane ID, taken from its Herdr environment, as a new optional field in its readiness record. Records with or without it parse, and older runs' records stay valid.
- The worker's existing input hook recognises exactly one line form, `[BOOTSTRAP_WAKE handoff=<handoff_id>]`, with nothing else on the line.
- On a match it reads the handoff offer for its own current attempt from disk. If the offer exists, matches the handoff ID, run and destination attempt, and is unclaimed, the worker rebuilds the normal handoff notification from the offer. It feeds that into the same path a Coms-delivered **Handoff** takes: the claim, then admission checks.
- Sender identity is not checked for a pane wake-up; the offer match replaces it.
- A wake-up for a handoff that is already claimed is a harmless replay.
- A line naming an unknown or mismatched handoff is ignored safely.
- Any input that does not match the exact form reaches the agent untouched.

Spec: `../spec.md` (bootstrap worker decisions; user stories 26–31 and 34).

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The readiness record includes the pane ID when the worker runs with a Herdr pane, and omits it otherwise. Old-format records still parse.
- [x] In a real-process test, typing the exact wake-up line into a waiting destination whose offer is on disk leads to the handoff being claimed and the attempt running, as for a Coms delivery.
- [x] A wake-up for an already-claimed handoff does not run work a second time. This holds after a Coms delivery of the same handoff too.
- [x] A wake-up naming a handoff with no matching offer, or an offer for a different attempt or run, does not claim anything and is recorded or reported as refused.
- [x] Input that is not exactly the wake-up form, including the form with extra text, reaches the agent as normal input.
