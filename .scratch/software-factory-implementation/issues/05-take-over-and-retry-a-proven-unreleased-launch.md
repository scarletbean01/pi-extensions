# 05: Take over management and retry a proven unreleased launch

**What to build:** After losing the managing Pi session, a person can inspect and take over a factory, distinguish launch uncertainty from a proven non-release, and deliberately retry only the latter. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [03: Launch the first input safely](03-launch-the-first-input-safely.md).

**Status:** done — merged to feature/software-factory

- [x] Takeover is explicit, human-confirmed and exclusive. Account for process identity, PID reuse and reboot; heartbeat age alone never transfers ownership. Fence old managers and launchers at mutations, launch and release, and reconcile before scheduling. Takeover neither cancels a live run nor frees its capacity.
- [x] Resolve the exact request and run from saved evidence, without generating again or resolving the draft. Distinguish a never-started input from an attempt proven never released and fenced from all future release, and from a possibly executed or unknown attempt. A missing release record or generic interrupted status is not proof.
- [x] Show why retry is eligible or what evidence is missing. Retry requires a human confirmation bound to the exact input and old attempt, revalidated at commit. It preserves the history, input, bound version and FIFO position and creates a new attempt with a new request ID. A model-supplied confirmation flag never authorizes it.
- [x] Test racing managers and a stale launcher attempting release, crashes before and after release permission, lost acknowledgement and damaged evidence using real local storage and supervised processes. When execution may have occurred without reliable settlement, preserve both holds and never relaunch or recreate an agent.
