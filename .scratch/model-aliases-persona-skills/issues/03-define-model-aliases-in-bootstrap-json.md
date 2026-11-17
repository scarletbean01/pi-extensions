# 03: Define model aliases in bootstrap.json

**What to build:** Model aliases become user data. The user defines them in a `bootstrap.json` file, globally and per project, and a persona's `model:` can name one. The extension ships no aliases and no hardcoded last-resort model.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Specification:** [Configurable model aliases, narrower persona discovery and allowed skills](../spec.md)

## Acceptance criteria

- [ ] A global `bootstrap.json` in the Pi agent directory and an optional project `bootstrap.json` in the project's `.pi` directory are read. The top-level `modelAliases` key maps an alias name to an object with a required `model` (a full `provider/id`) and an optional `thinking` (accepted and validated here, applied by the next ticket).
- [ ] Alias names are case-insensitive; two names differing only by case in one file are invalid.
- [ ] The project file's entry replaces the global entry of the same name as a whole; fields are not merged.
- [ ] A persona `model:` containing `/` is a full ID and passes through unchanged; otherwise it must be a defined alias, with an unknown alias failing the plan as it does today. An optional `:thinking` suffix is still accepted on both forms.
- [ ] A missing file means no aliases. A file that does not parse, an alias that is not an object, a missing or malformed `model`, or an invalid `thinking` value fails the plan with an error naming the file and the key; nothing is launched.
- [ ] The built-in alias table and the hardcoded fallback model are removed. A persona with no `model:` inherits the launching session's model; with nothing to inherit, planning fails with an error naming the persona.
- [ ] The resolved model is shown in the dry-run plan, and the post-launch expected-model check behaves as before.
- [ ] The test that checked the shipped aliases for retired models is removed with the table.

## Verification

- Dry-run `bootstrap_generate` with: no files, global only, project overriding global, mixed-case names, full IDs, unknown alias, broken JSON, wrong types and an invalid level.
- Confirm the error text for each failure names the file and the key.

## Constraints and handoff

Settings follow the existing global-plus-project pattern used by the sandbox configuration. Keep the file's top level open for future bootstrap settings. Update the bootstrap README's model section. The persona's own `thinking:` field is not part of this ticket.
