# Agents drive graph execution; there is no scheduler

Bootstrap graphs (joins, fan-out and review loops) are executed by the agents themselves, as chains already are: each agent watches its own inbound edges, claims its inputs with exclusive file records and delivers its own outputs, while the dispatcher only renders the widget and runs the automatic-cleanup watcher. We rejected a dispatcher-side scheduler because it would need a runtime owner that outlives the dispatcher session, a much larger scope (earlier roadmap ticket 20), and because the existing claim, offer and recovery records already give exactly-once admission without one.

## Consequences

- No actor is guaranteed alive to mark an edge dead, so edge state is never stored: one pure function derives it from results, verdicts, finalize records and claims, and every reader (agents, status, widget, recovery, cleanup) uses that function.
- Revisions are delivered by the decision node's agent to the feedback target, and loop finalization is written by the decision node, with cleanup as the fallback writer.
