# 11: `/factory viewer` command to start and stop the viewer from Pi

**What to build:** An operator working in a Pi session can start the read-only viewer with one command, get its loopback URL, and stop it again, without leaving Pi or opening a second terminal. The viewer stays a standalone process with no dependency on the Pi session.

**Blocked by:** 10

**Status:** done

- [x] `/factory viewer` starts the viewer as a detached child process (the same `factory/viewer/cli.ts` entry point) against the same default factory store path `/factory list` uses (the shared `defaultFactoryStorePath`), and prints the loopback URL.
- [x] A second `/factory viewer` while a viewer started by this command is still alive reports the existing URL and does not start another one; a recorded viewer whose process is gone is detected and replaced, never trusted.
- [x] `/factory viewer stop` stops only the viewer this command started (verified by its recorded identity, never a broad kill), and reports clearly when none is running.
- [x] The viewer keeps working, unchanged, after the Pi session that started it closes; closing the session does not stop it and starting it does not require a managing factory session.
- [x] Starting, reporting and stopping the viewer never write, migrate, repair, settle, launch or clean up factory or Bootstrap state (the existing read-only proof holds).
- [x] The command is documented in `docs/factory-web-viewer.md` and the orchestrator factory guide, and appears in `/factory` help.

## Constraints

- Specification: [spec.md](../spec.md); design: `docs/factory-web-viewer.md`; vocabulary: `GLOSSARY.md`; architecture: ADR 0001 (the viewer observes, never drives).
- The viewer module itself must not gain a dependency on Pi sessions, Herdr or a managing factory session: the command lives in the factory extension and only spawns the existing standalone entry point.
- Loopback only; no new HTTP routes; the API stays GET-only and identifier-only.
- Child process lifetime must be handled deliberately: record pid and port, verify identity before reuse or stop, and ensure tests leave no stray processes.
- Reinspect current code first and preserve edits made by others.
