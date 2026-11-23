# Define the factory lifecycle and runtime ownership

Type: grilling
Status: resolved
Blocked by: none

## Question

What starts, hosts, stops and resumes a long-lived factory, and what availability guarantees should it provide when Pi, Herdr or the host is unavailable? Examine the trade-offs against the existing decision in `docs/adr/0001-agents-drive-graph-execution.md`: agent-driven runs currently have no dispatcher-side scheduler. Identify whether a factory needs a durable owner and where its responsibilities end, without assuming that the run execution model must change.

## Answer

- Initially, accepting manual input requires an active managing Pi/Herdr session; the factory definition and pending work survive the session.
- The managing session controls admission and launching. At most one session actively manages a given factory at a time; other sessions may inspect it. Another session needs a safe takeover path if the owner disappears. The ownership mechanism remains to be specified.
- Closing the managing session does not itself cancel active runs. They continue where the existing Bootstrap execution model permits, and a later session can inspect and manage them. This does not promise survival of agent or host termination.
- A new session explicitly resumes the factory; it does not automatically restart admission or launching merely by opening.
- On explicit resume, accepted but unstarted inputs are processed automatically only when it can be established that they have not already started runs. Uncertain execution requires inspection rather than a potentially duplicate launch.
- Explicitly stopping a factory stops new admission and launching, but does not cancel active runs. Accepted queued inputs remain for a later resume; discarding an input is a separate explicit action.
- These lifecycle responsibilities do not require changing the agent-driven execution of individual runs or committing to an always-running service. Detailed crash recovery, ownership takeover, pending human requests, and the guarantees for determining whether a run started remain for subsequent decisions.
