# Factory Deletion Manual Acceptance Checklist

Run these checks against an **isolated temporary store/fixture** (never against `~/.pi/agent` or a real factory). Automated tests cover the domain operations and HTTP snapshot API (`bootstrap/factory-deletion.test.ts` and `bootstrap/factory-web-viewer-deletion.test.ts`); this checklist covers the interactive UI prompts and browser rendering.

---

## 1. Prerequisites & isolation

1. Create a temporary directory (for example `mktemp -d /tmp/fd-manual-XXXXXX`) and set:
   - `PI_BOOTSTRAP_STATE_DIR` / `FACTORY_STATE_PATH` to `<tmp>/factories.sqlite`
   - `PI_FACTORY_COORDINATION_DIR` to `<tmp>`
   - `HOME` to `<tmp>/home`
2. Publish at least two test factories (`alpha` and `beta`) in an interactive Pi session inside Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`, trusted project).

---

## 2. Typed-name confirmation prompt (`/factory delete`)

- [ ] **Decline at confirmation:** Run `/factory resume alpha`, then `/factory delete alpha`. Confirm the first dialog shows the factory name, UUID, `current_version`, and permanent/non-purging/reserved-name consequences. Choose **No / Cancel**. Verify nothing changes and `alpha` remains in `/factory list`.
- [ ] **Wrong name typed:** Run `/factory delete alpha`, accept the first confirmation dialog, then type `beta` (or `ALPHA` — wrong case) at the name prompt. Verify deletion is cancelled (`Factory name did not match "alpha"; deletion cancelled and nothing changed.`), no deletion record is written, and `alpha` remains active.
- [ ] **Correct name typed:** Run `/factory delete alpha`, accept the first dialog, and type `alpha` verbatim. Verify:
  - Deletion succeeds and clears the live status footer for `alpha`.
  - `/factory list` omits `alpha`; `/factory list --all` includes `alpha` marked deleted.
  - `/factory inspect alpha`, `/factory queue alpha`, `/factory requests alpha`, and `/factory proposals alpha` still work by name or UUID and show deletion time and managing session.
  - `/factory publish` with name `alpha` (or `ALPHA`) is rejected with a message naming the deleted factory's UUID and deletion time.
  - Any mutating command (e.g., `/factory submit alpha`, `/factory stop alpha`, `/factory resume alpha`) is refused with `"this factory is deleted"`.

---

## 3. Authority & session refusals

- [ ] **Unmanaged factory refusal:** Without running `/factory resume` on `beta`, run `/factory delete beta`. Verify it refuses immediately (without prompting) and instructs you to run `/factory resume` or `/factory takeover` first.
- [ ] **Worker-session refusal:** Inside a Bootstrap worker session (`--bootstrap-worker-config`), run `/factory delete beta`. Verify it is refused.
- [ ] **Force flag / extra args rejected:** Run `/factory delete beta --force`. Verify usage error / refusal.

---

## 4. Web viewer in a browser

Start the standalone viewer against the isolated temp store (`node factory/viewer/cli.ts`) and open the printed loopback URL in a browser:

- [ ] **Sidebar `Deleted` section:** Verify `alpha` is absent from the main **Factories** list and appears inside a collapsed `Deleted (1)` `<details>` section. Expand `Deleted (1)` and click `alpha`.
- [ ] **Deleted banner & read-only views:** Visit **Inspect**, **Queue**, **Receipts**, **Requests**, and **Proposals** for `alpha`. Verify each view loads its retained history with a visible **Deleted** banner showing the deletion timestamp (and managing session).
- [ ] **Live Graph:** Open **Live Graph** for `alpha`. Verify it shows a `Deleted` state and **never** implies `idle`, `waiting`, or `running`.
- [ ] **Read-only guarantee:** Confirm no mutating controls appear anywhere in the UI and no writes or migrations occur.

---

## 5. Damaged deletion record check

On a temporary copy of `<tmp>/factories.sqlite`, corrupt `alpha`'s `record_digest` in `factory_deletions` (e.g., `UPDATE factory_deletions SET record_digest = '0000...' WHERE factory_id = '<alpha-id>'`):

- [ ] **CLI / operations fail closed:** Verify mutating commands on `alpha` are refused, reads report `"deletion evidence mismatch"`, and `/factory list` and `/factory list --all` fail closed for the list.
- [ ] **Web viewer per-row isolation:** Reload the viewer against the damaged DB copy. Verify healthy `beta` remains visible in the main sidebar list, `alpha` appears under **Damaged / uncertain**, `alpha`'s Live Graph returns HTTP `503`, and `alpha`'s Inspect/Queue/Requests/Proposals show `evidence unavailable`.

---

## 6. Older-build check (if feasible)

- [ ] **v13 refusal by v12-era build:** If a v12-era checkout is available, point it read-only at a copy of the v13 `<tmp>/factories.sqlite` (written by `resume`/`publish`/`delete` on the new build). Verify the older build refuses to open the database (`Unsupported factory storage version 13`) rather than showing `alpha` as active. Note: ignore any older-build generic message suggesting `/factory resume` to migrate, as the DB is already at a newer version.
- [ ] **Read-only v12 preservation:** Point `/factory inspect`, `/factory list`, and the web viewer at an un-migrated v12 DB copy and confirm `PRAGMA user_version` remains `12`.
