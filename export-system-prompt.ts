import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<{ prompt: string }>("system-prompt", (entry, { outputPad }, theme) =>
    new Text(`${theme.fg("accent", "System prompt")}\n\n${entry.data?.prompt ?? ""}`, outputPad, 1),
  );

  pi.registerCommand("export-system-prompt", {
    description: "Show Pi's current system prompt in chat, or export it to a new file: [path]",
    handler: async (args, ctx) => {
      const filePath = args.trim();
      if (!filePath) {
        // Display in chat without duplicating the prompt in the model's context.
        pi.appendEntry("system-prompt", { prompt: ctx.getSystemPrompt() });
        return;
      }

      const path = resolve(ctx.cwd, filePath);
      try {
        // Do not overwrite an existing file; prompts may contain sensitive context.
        await writeFile(path, ctx.getSystemPrompt(), { encoding: "utf8", flag: "wx", mode: 0o600 });
        ctx.ui.notify(`System prompt saved to ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not export system prompt: ${String(error)}`, "error");
      }
    },
  });
}
