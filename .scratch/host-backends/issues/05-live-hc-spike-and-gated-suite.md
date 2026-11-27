# 05: Live hc spike and gated suite

**What to build:** The undocumented hc behaviours are settled against a real but isolated hc core, and a gated live suite is left behind. **The builder writes the spike and the suite but does not run them. The orchestrator asks the operator before anything is run.**

- A gated live suite, enabled by an environment variable and skipped otherwise, mirroring the live Herdr suite. It starts and stops its own isolated hc session with scratch paths and can never touch the operator's own core.
- A spike that records answers to: whether `hc send` wraps text in a note wrapper and when; the exact status-report wire format and how a status appears afterwards; the exact test-isolation recipe; what happens when sending to a still-booting agent; whether label filtering and per-terminal inspection behave as the contract document says; and whether names can be reused after a terminal dies.
- After the operator's go-ahead and a run, the findings replace the unverified tags in the contract document, and tickets 06 and 07 are updated if an answer changes them.

Spec: `../spec.md` (further notes: undocumented hc behaviours).

**Blocked by:** 03

**Status:** done

- [x] The gated suite exists, is skipped without its environment variable, and cannot reach a core other than its own.
- [x] The spike covers each listed question and writes its findings to a file.
- [x] After the operator runs it: the findings are in the contract document and the unverified tags are resolved or restated. *(Runs 2, 3 (`FbreNh`), and 4 (`6bLWs8`) on `hc 0.1.22` verified `(a)–(i)`: (a) plain raw-mode delivery with `HC_SCOPE` excluded caveat, (b) OSC 7501 `ESC]7501;state=<word>[:key=value…] ST`/BEL, all 5 words, `app`/`progress`/`kind`, raw non-base64 `msg=hello` and `title` rejection (base64 `msg=` acceptance unverified), `message=` accepted/not shown in `get`, `id=` in `get.records`, capability queries, (c) isolation and exact added env keys, (d) immediate PTY write vs target startup drain, (e) compact `run`/`ls` vs full `get`, (f) name reuse, (g) status shape, (h) `blocked` exit 9/0 bytes, `working` exit 0/`started:true`, `done` exit 0/`started:false` ~6 s, (i) `kill` on finished. Explicitly restated unverified follow-ups in `HOST.md`/`README.md`: whether a real `pi` agent launched via `hc run … launcher` receives an `<hc from="…" [reach="…"]>` wrapper; unaltered-env terminal `self-probe`, unset `HC_SESSION`/`HC_SOCKET` injection, and `HC_SCOPE`-preserving sends (in full `a–i` run); and `message=`'s visible effect.)*
- [x] The existing live Herdr suite is unchanged.
