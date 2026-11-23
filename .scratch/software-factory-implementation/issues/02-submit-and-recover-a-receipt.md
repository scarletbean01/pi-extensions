# 02: Submit a brief and recover its receipt

**What to build:** A human explicitly resumes management in Pi, enters or pastes a brief via `/factory`, and receives a durable receipt even when there is no run. The receipt remains available by reference without resuming work. See the [Software Factory spec](../../software-factory/spec.md).

**Blocked by:** [01: Publish and inspect a factory definition](01-publish-and-inspect-a-definition.md).

**Status:** done — merged to feature/software-factory

- [x] Opening is read-only. Initial resume establishes one exclusive local managing session; concurrent sessions cannot both acquire authority or admit work. An orphaned owner is not silently replaced; takeover is a separate slice.
- [x] Direct human entry exposes a stable submission reference before commit. Preserve nonblank multiline text exactly; file and issue references stay literal, and the brief cannot alter checkout, graph or permissions. Neither ordinary chat nor an agent-facing tool submits a brief.
- [x] In one crash-durable commit, bind the input ID, reference, exact brief, FIFO position and then-current definition version. Only then acknowledge with the ID, reference, bound version and disposition. A receipt does not imply launch.
- [x] Reject invalid submissions, briefs exceeding 16 KiB UTF-8, and new inputs beyond 32 queued inputs without evicting work. Blocked or retryable heads count; active runs and history do not. Distinguish a definite rejection from an uncertain commit.
- [x] After a lost acknowledgement or interrupted commit, read-only lookup or an identical retry returns the original receipt and current disposition when committed. Changed text under the same reference conflicts; the same text under a fresh reference is a distinct input. Retries do not consume queue space or rebind a version.
