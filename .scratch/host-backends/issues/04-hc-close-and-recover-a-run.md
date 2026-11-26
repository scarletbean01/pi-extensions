# 04: hc: close and recover a run

**What to build:** A run launched on hc can be cleaned up safely and recovered from any environment.

- Closing a node ends its process and removes its terminal (hangup then remove). **Resource closure** means the terminal is finished and removed, on either backend.
- Ownership is decided by labels and the terminal id, never by name, so a renamed or look-alike terminal is never closed by mistake, and a terminal the run does not own is left alone. Closing reports ambiguity rather than guessing.
- Cleanup by agent selection works on hc; cleanup by tab id remains Herdr only and says so clearly for an hc run.
- A run launched on hc and recovered or cleaned up from an environment with no hc context still uses hc, because recovery follows the recorded backend.
- The contract suite is extended to cover close, ownership safety and recovery with a different environment, against both backends. The existing "leave a rearranged tab alone" behaviour stays Herdr only.

Spec: `../spec.md`. Contract document from ticket 01.

**Blocked by:** 03

**Status:** done

- [x] With the fake `hc`, cleanup closes exactly the nodes a run owns and nothing else, including when another terminal has a matching name.
- [x] A finished-but-not-removed terminal is removed; an already-gone terminal is reported as gone, not as an error.
- [x] Recovery and cleanup from a shell with no hc context use hc for an hc run and Herdr for a Herdr run.
- [x] Cleanup by tab id on an hc run gives a clear message and changes nothing.
- [x] The contract suite covers close, ownership and recovery on both backends; existing suites still pass.
- [x] The contract document is updated.
