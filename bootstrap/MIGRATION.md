# Migrate existing personas to Bootstrap

Bootstrap reads personas from `~/.pi/agent/agents` and the project's `.pi/agents`. Copy shared personas into the global directory. If you have six persona files in `~/.claude/agents`, run these commands to copy them and prompt before replacing any existing files.

```sh
mkdir -p ~/.pi/agent/agents
cp -i ~/.claude/agents/*.md ~/.pi/agent/agents/
```

Use the same copy procedure for personas from other tools. A repository-specific persona can go in that repository's `.pi/agents`, where it takes priority over a global persona of the same name, ignoring case. Team definitions belong in the project's `.pi/agents/teams.yaml`. The global persona directory stays under `~/.pi/agent` when `PI_CODING_AGENT_DIR` points elsewhere.

## Update model selections

Check each copied persona's `model:` field. To keep a short name such as `review`, add an entry to the global `bootstrap.json` in `~/.pi/agent` or in `$PI_CODING_AGENT_DIR` if set. Merge the entry into the existing JSON object if you already have a file.

```json
{
  "modelAliases": {
    "review": { "model": "openai/gpt-5", "thinking": "high" }
  }
}
```

Replace the example with a full provider/model ID available in your Pi installation. Alias names are case-insensitive. A project can retarget an alias in `<project>/.pi/bootstrap.json`; that entry supplies both the model and any alias thinking level for the project. Add a definition for each short name you want to keep. Bootstrap supplies no built-in aliases.

You can also switch a persona to a full ID, for example `model: openai/gpt-5`. Keep any valid suffix you want to carry over, such as `model: openai/gpt-5:low`. The suffix wins over a separate persona `thinking:` field, which wins over the alias level. To inherit the launching session's model, omit the `model:` field.

## Check the migrated persona

Use flat scalar frontmatter. If you add `skills:`, write the exact names from the skills' `SKILL.md` files as a comma-separated list. An empty field advertises zero skills. An omitted field keeps all skills Pi discovers. Check any `extensions:` paths against Bootstrap's [extension lookup rules](README.md#prerequisites), especially if they previously resolved relative to another tool's directory.

Call `bootstrap_generate` with `dry_run: true` and the migrated persona. Check the persona file and source, resolved model, thinking level and allowed skills in the plan. Pi checks skill discovery when the agent starts. If the launch reports an unknown name, correct the spelling or make the skill discoverable by Pi, then run again.

Launch migrated personas through Bootstrap. The interactive `/system` command, `--agent` flag and persona-cycling shortcuts were removed with `system-select`.
