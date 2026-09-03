/**
 * prompt-inspector — inspecciona el prompt completo que pi envia al provider.
 *
 * Comandos:
 *   /prompt              — resumen con breakdown y tokens
 *   /prompt full         — vuelca system prompt completo
 *   /prompt tools        — detalle de tools activos
 *   /prompt skills       — detalle de skills
 *   /prompt save [path]  — guarda dump completo a archivo
 *   /dump-prompt         — alias de /prompt
 *
 * Modular: delega estimacion, inspeccion y formateo a src/*.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildInspectionReport } from "./src/inspector.js";
import {
  formatForFile,
  formatSummary,
} from "./src/formatter.js";
import {
  defaultDumpPath,
  writeReportToFile,
} from "./src/file-writer.js";
import { showInOverlayOrNotify } from "./src/ui.js";

type PromptSubcommand = "summary" | "full" | "tools" | "skills" | "save" | "help";

interface ParsedCommand {
  subcommand: PromptSubcommand;
  savePath?: string;
}

function parsePromptArgs(args: string): ParsedCommand {
  const trimmed = args.trim();
  if (!trimmed) return { subcommand: "summary" };

  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.toLowerCase() ?? "";

  if (first === "full" || first === "prompt") return { subcommand: "full" };
  if (first === "tools") return { subcommand: "tools" };
  if (first === "skills") return { subcommand: "skills" };
  if (first === "help" || first === "--help" || first === "-h")
    return { subcommand: "help" };
  if (first === "save") {
    const savePath = parts.slice(1).join(" ").trim() || undefined;
    return { subcommand: "save", savePath };
  }
  if (first === "summary" || first === "stats") return { subcommand: "summary" };

  // Unknown arg treated as save path
  if (first.includes("/") || first.includes(".")) {
    return { subcommand: "save", savePath: trimmed };
  }

  return { subcommand: "summary" };
}

function helpText(): string {
  return [
    "prompt-inspector — inspecciona el prompt enviado al provider",
    "",
    "Uso:",
    "  /prompt              resumen (tokens, breakdown)",
    "  /prompt full         vuelca system prompt completo",
    "  /prompt tools        lista tools activos con tokens",
    "  /prompt skills       lista skills disponibles",
    "  /prompt save [ruta]  guarda dump completo a archivo (default: ./pi-prompt-dump-<ts>.md)",
    "  /dump-prompt         alias de /prompt",
    "",
    "Tokens estimados como ceil(chars/4), imagen = 4800 chars. Aproximado; el tokenizer real varia por provider.",
  ].join("\n");
}

async function handlePromptCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const parsed = parsePromptArgs(args);

  if (parsed.subcommand === "help") {
    ctx.ui.notify(helpText(), "info");
    // Also print for print/json modes
    console.log(helpText());
    return;
  }

  let report;
  try {
    report = buildInspectionReport(ctx, pi);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Error al inspeccionar prompt: ${msg}`, "error");
    return;
  }

  switch (parsed.subcommand) {
    case "summary": {
      const text = formatSummary(report);
      if (ctx.hasUI && ctx.mode === "tui") {
        // Use notify + custom overlay for readability
        // Show via notify first for quick feedback, then overlay
        await showInOverlayOrNotify(ctx, "Prompt Inspector — resumen", text);
      } else {
        console.log(text);
        ctx.ui.notify("Resumen impreso en stdout", "info");
      }
      break;
    }
    case "full": {
      const header = `System prompt — ${report.promptChars} chars ~${report.promptTokens} tokens`;
      const content = `${header}\n${"─".repeat(header.length)}\n\n${report.systemPrompt}`;
      if (ctx.hasUI && ctx.mode === "tui") {
        await showInOverlayOrNotify(ctx, header, content);
      } else {
        console.log(content);
        // Also save for convenience in non-tui
        const fallback = defaultDumpPath(ctx.cwd);
        try {
          const saved = writeReportToFile(
            formatForFile(report),
            fallback,
            ctx.cwd,
          );
          ctx.ui.notify(`Dump guardado en ${saved}`, "info");
        } catch {}
      }
      break;
    }
    case "tools": {
      const lines = [
        `Tools activos (${report.tools.length}) — ${report.toolsJsonChars} chars ~${report.toolsTokens} tokens`,
        "─".repeat(60),
        ...report.tools.map((t) => `- ${t.name}: ${t.description}`),
        "",
        `JSON chars: ${report.toolsJsonChars} ~${report.toolsTokens} tokens (estimado como ceil(JSON.stringify(tools).length/4))`,
      ];
      const text = lines.join("\n");
      await showInOverlayOrNotify(ctx, "Tools", text);
      break;
    }
    case "skills": {
      const lines = [
        `Skills disponibles (${report.skills.length})`,
        "─".repeat(60),
        ...report.skills.map(
          (s) => `- ${s.name}: ${s.description}\n  ${s.location}`,
        ),
      ];
      if (report.skills.length === 0) lines.push("(none)");
      const text = lines.join("\n");
      await showInOverlayOrNotify(ctx, "Skills", text);
      break;
    }
    case "save": {
      const target = parsed.savePath ?? defaultDumpPath(ctx.cwd);
      try {
        const content = formatForFile(report);
        const saved = writeReportToFile(content, target, ctx.cwd);
        const msg = `Dump completo guardado en ${saved} (${content.length} chars ~${Math.ceil(content.length / 4)} tokens)`;
        ctx.ui.notify(msg, "info");
        console.log(msg);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Error al guardar: ${msg}`, "error");
      }
      break;
    }
  }
}



export default function promptInspectorExtension(pi: ExtensionAPI) {
  pi.registerCommand("prompt", {
    description:
      "Inspecciona el prompt enviado al provider. /prompt | /prompt full | /prompt save [ruta]",
    handler: async (args, ctx) => handlePromptCommand(args, ctx, pi),
  });

  // Alias for backwards compatibility / discoverability
  pi.registerCommand("dump-prompt", {
    description: "Alias de /prompt — inspecciona el prompt del provider",
    handler: async (args, ctx) => handlePromptCommand(args, ctx, pi),
  });

  // Also alias /inspect-prompt
  pi.registerCommand("inspect-prompt", {
    description: "Alias de /prompt",
    handler: async (args, ctx) => handlePromptCommand(args, ctx, pi),
  });

  // Optional: log on session start for debugging (no-op, just keeps extension warm)
  pi.on("session_start", (_event, _ctx) => {
    // No-op: could warm cache here if needed
  });
}
