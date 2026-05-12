/**
 * Dump Prompt Extension
 *
 * Captures the full payload sent to the LLM provider and writes it
 * to ~/pi-prompt-dump.json (raw) and ~/pi-prompt-dump.md (readable).
 *
 * Usage:
 *   /dump-prompt      - Save the last captured payload to disk
 *   /dump-prompt on   - Auto-save every payload (default: off)
 *   /dump-prompt off  - Disable auto-save
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  let lastPayload: Record<string, unknown> | null = null;
  let lastSystemPrompt: string | null = null;
  let autoSave = false;

  // Compute output paths
  const jsonPath = join(homedir(), "pi-prompt-dump.json");
  const mdPath = join(homedir(), "pi-prompt-dump.md");

  /**
   * Format the payload as a readable Markdown document.
   */
  function formatPayloadAsMd(
    payload: Record<string, unknown> | string
  ): string {
    const lines: string[] = [];
    const obj = typeof payload === "string" ? JSON.parse(payload) : payload;

    lines.push("# Pi Prompt Dump");
    lines.push("");
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    // Model info
    if (obj.model) {
      lines.push("## Model");
      lines.push("");
      lines.push(`\`${obj.model}\``);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    // System prompt
    if (obj.system) {
      lines.push("## System Prompt");
      lines.push("");
      if (Array.isArray(obj.system)) {
        for (const block of obj.system) {
          if (block.type === "text") {
            lines.push("```text");
            lines.push(block.text);
            lines.push("```");
            lines.push("");
          }
        }
      } else if (typeof obj.system === "string") {
        lines.push("```text");
        lines.push(obj.system);
        lines.push("```");
        lines.push("");
      }
      lines.push("---");
      lines.push("");
    }

    // Messages
    if (obj.messages && Array.isArray(obj.messages)) {
      lines.push("## Messages");
      lines.push("");
      lines.push(`**Count:** ${obj.messages.length}`);
      lines.push("");
      for (let i = 0; i < obj.messages.length; i++) {
        const msg = obj.messages[i];
        lines.push(`### Message ${i + 1}: ${msg.role}`);
        lines.push("");

        if (typeof msg.content === "string") {
          lines.push("```text");
          lines.push(msg.content);
          lines.push("```");
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              lines.push("```text");
              lines.push(block.text);
              lines.push("```");
            } else if (block.type === "image") {
              lines.push(`> [Image: ${block.source?.media_type ?? "unknown"}]`);
            } else if (block.type === "thinking") {
              lines.push("> [Thinking block]");
            } else if (block.type === "toolUse" || block.type === "tool_use") {
              lines.push(`> [Tool call: ${block.name}]`);
              lines.push("```json");
              lines.push(JSON.stringify(block.input ?? block.arguments ?? {}, null, 2));
              lines.push("```");
            } else if (block.type === "toolResult" || block.type === "tool_result") {
              lines.push(`> [Tool result]`);
              if (block.content) {
                const textContent = Array.isArray(block.content)
                  ? block.content.map((c: Record<string, unknown>) => c.text ?? JSON.stringify(c)).join("\n")
                  : String(block.content);
                lines.push("```text");
                lines.push(textContent.slice(0, 2000));
                if (textContent.length > 2000) {
                  lines.push("... [truncated]");
                }
                lines.push("```");
              }
            } else {
              lines.push("```json");
              lines.push(JSON.stringify(block, null, 2).slice(0, 500));
              lines.push("```");
            }
            lines.push("");
          }
        }
        lines.push("---");
        lines.push("");
      }
    }

    // Tools
    if (obj.tools && Array.isArray(obj.tools) && obj.tools.length > 0) {
      lines.push("## Tools");
      lines.push("");
      lines.push(`**Count:** ${obj.tools.length}`);
      lines.push("");
      for (const tool of obj.tools) {
        const name = tool.name || tool.function?.name || "unnamed";
        const desc = tool.description || tool.function?.description || "";
        lines.push(`- **${name}**: ${desc}`);
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    // Max tokens or other params
    if (obj.max_tokens || obj.maxTokens) {
      lines.push(`**Max tokens:** ${obj.max_tokens ?? obj.maxTokens}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Estimate token count (very rough: 4 chars ~= 1 token).
   */
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Write both JSON and MD files.
   */
  function writeDump(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload, null, 2);
    const md = formatPayloadAsMd(payload);

    writeFileSync(jsonPath, json, "utf-8");
    writeFileSync(mdPath, md, "utf-8");
  }

  // ── Capture every payload sent to the provider ──────────────
  pi.on("before_provider_request", (event, _ctx) => {
    lastPayload = event.payload as Record<string, unknown>;
    lastSystemPrompt = _ctx.getSystemPrompt?.() ?? null;

    if (autoSave && lastPayload) {
      try {
        writeDump(lastPayload);
      } catch {
        // Silently ignore write errors during streaming
      }
    }
  });

  // ── Command: /dump-prompt ────────────────────────────────────
  pi.registerCommand("dump-prompt", {
    description:
      "Save last LLM payload to ~/pi-prompt-dump.json and ~/pi-prompt-dump.md. Use 'on'/'off' for auto-save.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // Toggle auto-save
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

      // Dump on demand
      if (!lastPayload) {
        ctx.ui.notify(
          "No payload captured yet. Send a message first, then run /dump-prompt.",
          "warn"
        );
        return;
      }

      try {
        writeDump(lastPayload);
        const jsonSize = Buffer.byteLength(JSON.stringify(lastPayload, null, 2), "utf-8");
        const tokenEstimate = estimateTokens(JSON.stringify(lastPayload));
        ctx.ui.notify(
          `Dumped: ${jsonPath} (${(jsonSize / 1024).toFixed(1)}KB, ~${tokenEstimate} tokens)`,
          "success"
        );
      } catch (err) {
        ctx.ui.notify(`Error writing dump: ${err}`, "error");
      }
    },
  });
}
