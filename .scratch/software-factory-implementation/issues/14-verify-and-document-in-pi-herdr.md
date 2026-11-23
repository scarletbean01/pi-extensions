# 14: Verify and document the factory in Pi/Herdr

**What to build:** A new operator can follow a verified operating guide to use a software factory, resolve an intervention, understand a blocked queue, and recover or clear work safely. This is the release gate, not a deferral of the earlier safety guarantees. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [08: Advance the FIFO queue without skipping the head](08-advance-the-fifo-queue.md); [10: Keep human waits from expiring dependent work](10-preserve-deadlines-during-human-waits.md); [11: Recover an intervention without replaying an attempt](11-recover-an-intervention-without-replay.md); [13: Request a bounded revision](13-request-a-bounded-revision.md).

**Status:** done

- [x] Verify the complete implementation on `feature/software-factory`. Passing this gate does not merge the branch into `main`; see the [branch policy](../README.md).
- [x] In isolated Pi/Herdr, demonstrate direct multiline submission, request discovery even after a missed alert, human confirmation unavailable to agent tools, and drill-down from the live summary through receipt, queue, run and recovery evidence.
- [x] Retain an end-to-end scenario that revises, approves, settles, and starts the next input; and a takeover scenario that exposes an actionable request or an uncertain hold without replay. Use the opt-in live harness with isolated state and no production credentials.
- [x] Show per-node attempt and rollback counts in the factory views and in `bootstrap_report`, derived from the existing per-attempt records (`upstream-index.json`) with no new persisted state. They are report-only: they must not influence admission, routing or any gate.
- [x] Run the deterministic, runtime and standalone Bootstrap regressions. Verify commit boundaries against OS/filesystem durability semantics and exercise controlled durability faults where supported; process kills alone do not establish power-loss durability. Record missing runtime capabilities as unverified, not passing release coverage.
- [x] Document first use, publication and definitions, a blocked head, intervention, stop/resume, takeover, and clearance. Explain that standalone runs and manual edits are not coordinated, that cleanup is not proof external effects stopped, and that uncertain execution is not replayed.
