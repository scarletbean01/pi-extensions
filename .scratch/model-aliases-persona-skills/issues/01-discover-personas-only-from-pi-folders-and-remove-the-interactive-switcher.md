# 01: Discover personas only from Pi's folders and remove the interactive switcher

**What to build:** Bootstrap, including the `bootstrap_generate` dry run, finds personas only in the project `.pi/agents` directory and the global `~/.pi/agent/agents` directory. The interactive persona switcher (`system-select`) is deleted along with every reference to it, so one registry owns persona handling.

**Blocked by:** None (can start immediately)

**Status:** done — merged to main (`0a1d966`) and verified

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [x] A persona in the project `.pi/agents` directory is found; a persona in the global `~/.pi/agent/agents` directory is found; the project persona wins on a case-insensitive name clash; filenames are still ordered deterministically.
- [x] A persona placed only in any of the seven previously scanned directories (other tools' folders and the plain `agents` folder, project and global) is not found, and asking for it fails with the usual unknown-persona error.
- [x] The team definition file keeps working from its current location.
- [x] The interactive persona switcher and its theme mapping and shared-utility references are deleted. The bootstrap README, release notes and migration guide mention `/system`, `--agent` and cycling shortcuts only to document their removal.
- [x] The bootstrap README describes discovery as the two directories only.
- [x] The tests that asserted the old nine-directory order are updated to the two directories; the rest of the suite stays green.

## Verification

- Dry-run `bootstrap_generate` against a temporary project and a temporary home that contain personas in every one of the nine old locations; only the two new locations contribute.
- Search the repository for leftover references to the deleted extension.

## Constraints and handoff

This is a breaking change for anyone with personas elsewhere. Do not add a fallback to the old locations; the migration guide is delivered by the release gate ticket. Use the glossary vocabulary: persona is the file, agent is the running instance.
