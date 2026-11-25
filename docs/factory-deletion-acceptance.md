# Factory Deletion Manual Acceptance Checklist

Run these checks against an **isolated temporary store** (never against `~/.pi/agent/bootstrap-sessions/factories.sqlite` or a real factory). Automated tests cover the domain operations and HTTP snapshot API (`bootstrap/factory-deletion.test.ts` and `bootstrap/factory-web-viewer-deletion.test.ts`); this checklist covers the interactive UI prompts, browser rendering, and manual storage checks. Requires `sqlite3` for the damaged-record and v12 checks.

## 1. Prerequisites and isolation

1. Create a temporary directory for the isolated store and coordination DB (keep your normal `HOME` so Pi loads your auth and extensions from `~/.pi/agent`):

```sh
TMP_STORE=$(mktemp -d /tmp/fd-manual-XXXXXX)
```

2. Start an interactive Pi session inside Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`, trusted project) with the state and coordination **directories** pointed at `$TMP_STORE` (`PI_FACTORY_STATE_DIR` and `PI_BOOTSTRAP_STATE_DIR` are directory paths; `/factory` commands read `<dir>/factories.sqlite` and ignore `FACTORY_STATE_PATH`):

```sh
PI_FACTORY_STATE_DIR="$TMP_STORE" \
PI_BOOTSTRAP_STATE_DIR="$TMP_STORE" \
PI_FACTORY_COORDINATION_DIR="$TMP_STORE" \
pi
```

3. Inside that Pi session, run `/factory publish` twice to create at least two test factories (`alpha` and `beta`).

## 2. Typed-name confirmation prompt (`/factory delete`)

- [ ] **Decline at confirmation:** Run `/factory resume alpha`, then `/factory delete alpha`. Confirm the first dialog shows the factory name, UUID, `current_version`, and permanent/non-purging/reserved-name consequences. Choose **No / Cancel**. Verify nothing changes and `alpha` remains in `/factory list`.
- [ ] **Wrong name typed:** Run `/factory delete alpha`, accept the first confirmation dialog, then type `beta` (or `ALPHA` — wrong case) at the name prompt. Verify deletion is cancelled (`Factory name did not match "alpha"; deletion cancelled and nothing changed.`), no deletion record is written, and `alpha` remains active.
- [ ] **Correct name typed:** Run `/factory delete alpha`, accept the first dialog, and type `alpha` verbatim. Verify:
  - Deletion succeeds and clears the live status footer for `alpha`.
  - `/factory list` omits `alpha`; `/factory list --all` includes `alpha` marked deleted (note `alpha`'s UUID for Section 5).
  - `/factory inspect alpha`, `/factory queue alpha`, `/factory requests alpha`, and `/factory proposals alpha` still work by name or UUID and show deletion time and managing session.
  - `/factory publish` with name `alpha` (or `ALPHA`) is rejected with a message naming the deleted factory's UUID and deletion time.
  - Any mutating command (e.g., `/factory submit alpha`, `/factory stop alpha`, `/factory resume alpha`) is refused with `"this factory is deleted"`.

## 3. Authority and session refusals

- [ ] **Unmanaged factory refusal:** Without running `/factory resume` on `beta`, run `/factory delete beta`. Verify it refuses immediately (without prompting) and instructs you to run `/factory resume` or `/factory takeover` first.
- [ ] **Worker-session refusal:** In a Bootstrap worker session (for example, inside a launched run's worker tab started with `--bootstrap-worker-config`; also covered by `bootstrap/factory-deletion.test.ts`), run `/factory delete beta`. Verify it refuses with `Factory deletion cannot run from a Bootstrap worker session`.
- [ ] **Force flag / extra args rejected:** Run `/factory delete beta --force`. Verify usage error / refusal (`Usage: /factory delete <factory>`).

## 4. Web viewer in a browser

Start the standalone viewer against the exact same isolated store (`FACTORY_STATE_PATH` is read only by `factory/viewer/cli.ts`) and open the printed loopback URL in a browser:

```sh
FACTORY_STATE_PATH="$TMP_STORE/factories.sqlite" \
PI_FACTORY_COORDINATION_DIR="$TMP_STORE" \
PI_BOOTSTRAP_STATE_DIR="$TMP_STORE" \
node factory/viewer/cli.ts
```

- [ ] **Sidebar `Deleted` section:** Verify `alpha` is absent from the main **Factories** list and appears inside a collapsed `Deleted (1)` `<details>` section. Expand `Deleted (1)` and click `alpha`.
- [ ] **Deleted banner and read-only views:** Visit **Inspect**, **Queue**, **Receipts**, **Requests**, and **Proposals** for `alpha`. Verify each view loads its retained history with a visible **Deleted** banner showing the deletion timestamp (and managing session).
- [ ] **Live Graph:** Open **Live Graph** for `alpha`. Verify it shows a `Deleted` state and **never** implies `idle`, `waiting`, or `running`.
- [ ] **Read-only guarantee:** Confirm no mutating controls appear anywhere in the UI and no writes or migrations occur.

## 5. Damaged deletion record check

Make a temporary copy of `$TMP_STORE`, find `<alpha-id>` from `/factory list --all`, and corrupt `alpha`'s `record_digest` in the copy:

```sh
TMP_DMG=$(mktemp -d /tmp/fd-damaged-XXXXXX)
cp -a "$TMP_STORE/." "$TMP_DMG/"
sqlite3 "$TMP_DMG/factories.sqlite" "UPDATE factory_deletions SET record_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE factory_id = '<alpha-id>';"
```

- [ ] **CLI / operations fail closed:** Start Pi with `PI_FACTORY_STATE_DIR="$TMP_DMG" PI_BOOTSTRAP_STATE_DIR="$TMP_DMG" PI_FACTORY_COORDINATION_DIR="$TMP_DMG" pi`. Verify mutating commands on `alpha` are refused, reads report `"deletion evidence mismatch"`, and `/factory list` and `/factory list --all` fail closed for the list.
- [ ] **Web viewer per-row isolation:** Start the viewer against the corrupted copy (`FACTORY_STATE_PATH="$TMP_DMG/factories.sqlite" PI_FACTORY_COORDINATION_DIR="$TMP_DMG" PI_BOOTSTRAP_STATE_DIR="$TMP_DMG" node factory/viewer/cli.ts`). Verify healthy `beta` remains visible in the main sidebar list, `alpha` appears under **Damaged / uncertain**, `alpha`'s Live Graph returns HTTP `503`, and `alpha`'s Inspect/Queue/Requests/Proposals show `evidence unavailable`.

## 6. Older-build and v12 read-only checks

- [ ] **v13 refusal by v12-era build (if available):** If a v12-era checkout is available, point it read-only at a copy of the v13 `"$TMP_STORE/factories.sqlite"` (written by `resume`/`publish`/`delete` on the new build). Verify the older build checks the version first and refuses to open the database with an unsupported-storage-version error (`Unsupported factory storage version 13` in operations, `Unsupported factory storage version (main=13, ...)` in the evidence reader, or HTTP `503` `Evidence unavailable` in an old viewer) rather than showing `alpha` as active.
- [ ] **Read-only v12 preservation:** Create a v12 copy using the same downgrade the automated tests use, then point `/factory inspect`, `/factory list`, and the web viewer at `$TMP_V12`:

```sh
TMP_V12=$(mktemp -d /tmp/fd-v12-XXXXXX)
cp -a "$TMP_STORE/." "$TMP_V12/"
sqlite3 "$TMP_V12/factories.sqlite" "DROP TABLE factory_deletions; PRAGMA user_version = 12;"
```

  Run `/factory list` and `/factory inspect beta` in Pi with `PI_FACTORY_STATE_DIR="$TMP_V12" PI_BOOTSTRAP_STATE_DIR="$TMP_V12" PI_FACTORY_COORDINATION_DIR="$TMP_V12"`, and open the viewer with `FACTORY_STATE_PATH="$TMP_V12/factories.sqlite" PI_FACTORY_COORDINATION_DIR="$TMP_V12" PI_BOOTSTRAP_STATE_DIR="$TMP_V12" node factory/viewer/cli.ts`. Confirm `sqlite3 "$TMP_V12/factories.sqlite" "PRAGMA user_version;"` still prints `12`.
