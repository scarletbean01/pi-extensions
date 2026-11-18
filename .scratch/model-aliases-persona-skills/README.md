# Model aliases, persona discovery and allowed skills: tickets

Specification: [spec.md](spec.md). Vocabulary: `GLOSSARY.md` at the repository root. Tracker: local files. Prepared 2026-11-17.

**Status: all 8 tickets done.** See [ticket 08](issues/08-release-gate-migration-guide-docs-and-end-to-end-run.md#verification) for the suite results and release verification.

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Discover personas only from Pi's folders and remove the interactive switcher](issues/01-discover-personas-only-from-pi-folders-and-remove-the-interactive-switcher.md) | None |
| 02 | [Capture what a launched agent sends to its provider](issues/02-capture-what-a-launched-agent-sends-to-its-provider.md) | None |
| 03 | [Define model aliases in bootstrap.json](issues/03-define-model-aliases-in-bootstrap-json.md) | None |
| 04 | [Set the thinking level from the persona or the alias](issues/04-set-the-thinking-level-from-the-persona-or-the-alias.md) | 03 |
| 05 | [Limit an agent's skills from its persona](issues/05-limit-an-agents-skills-from-its-persona.md) | 02 |
| 06 | [Fail the launch on an unknown allowed skill](issues/06-fail-the-launch-on-an-unknown-allowed-skill.md) | 05 |
| 07 | [Drop the harness-docs block from worker prompts](issues/07-drop-the-harness-docs-block-from-worker-prompts.md) | 02 |
| 08 | [Release gate: migration guide, docs and end-to-end run](issues/08-release-gate-migration-guide-docs-and-end-to-end-run.md) | 01, 04, 06, 07 |

Frontier at start: 01, 02, 03. Tickets 04 and 05 both touch the plan and its fingerprint; the later one to finish merges the integration tip first.

Deferred to a later grilling: configuring which extensions a persona's agent loads (including excluding globally installed ones) and trimming prompt rules contributed by other extensions.
