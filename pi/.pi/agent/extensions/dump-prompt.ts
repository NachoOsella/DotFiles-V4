/**
 * Dump Prompt Extension
 *
 * Captures the full payload sent to the LLM provider and writes it
 * to ~/pi-prompt-dump.json (raw) and ~/pi-prompt-dump.md (readable).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "./dump-prompt/formatter.js";
import type { PromptPayload } from "./dump-prompt/types.js";
import { getDumpPaths, writeDump } from "./dump-prompt/writer.js";

/** Register the /dump-prompt command and provider payload capture hook. */
export default function (pi: ExtensionAPI) {
  let lastPayload: PromptPayload | null = null;
  let autoSave = false;

  const { jsonPath } = getDumpPaths();

  pi.on("before_provider_request", (event) => {
    lastPayload = event.payload as PromptPayload;

    if (autoSave && lastPayload) {
      try {
        writeDump(lastPayload);
      } catch {
        // Ignore write errors while the provider request is in progress.
      }
    }
  });

  pi.registerCommand("dump-prompt", {
    description:
      "Save last LLM payload to ~/pi-prompt-dump.json and ~/pi-prompt-dump.md. Use 'on'/'off' for auto-save.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        autoSave = true;
        ctx.ui.notify("Auto-save enabled: every payload will be written to ~/pi-prompt-dump.*", "success");
        return;
      }

      if (arg === "off") {
        autoSave = false;
        ctx.ui.notify("Auto-save disabled", "info");
        return;
      }

      if (!lastPayload) {
        ctx.ui.notify("No payload captured yet. Send a message first, then run /dump-prompt.", "warn");
        return;
      }

      try {
        writeDump(lastPayload);
        const json = JSON.stringify(lastPayload, null, 2);
        const jsonSize = Buffer.byteLength(json, "utf-8");
        const tokenEstimate = estimateTokens(JSON.stringify(lastPayload));
        ctx.ui.notify(
          `Dumped: ${jsonPath} (${(jsonSize / 1024).toFixed(1)}KB, ~${tokenEstimate} tokens)`,
          "success",
        );
      } catch (err) {
        ctx.ui.notify(`Error writing dump: ${err}`, "error");
      }
    },
  });
}
