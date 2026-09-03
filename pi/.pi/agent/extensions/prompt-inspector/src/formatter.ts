/** Formatting helpers for terminal, file, and overlay display. */

import type { InspectionReport } from "./types.ts";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPercent(p: number | null | undefined): string {
  if (p === null || p === undefined) return "n/a";
  return `${p.toFixed(1)}%`;
}

function bar(percent: number | null, width = 20): string {
  if (percent === null || percent === undefined) return "";
  const filled = Math.round((Math.min(percent, 100) / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatSummary(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push("Prompt Inspector — resumen");
  lines.push("─".repeat(50));
  lines.push(`CWD: ${report.cwd}`);
  if (report.model) {
    lines.push(
      `Modelo: ${report.model.provider}/${report.model.id} (${report.model.contextWindow ? fmt(report.model.contextWindow) + " ctx" : "ctx n/a"}) thinking: ${report.model.thinkingLevel ?? "off"}`,
    );
  } else {
    lines.push("Modelo: (no seleccionado)");
  }
  lines.push("");
  lines.push(
    `System prompt: ${fmt(report.breakdown.totalChars)} chars ~${fmt(report.breakdown.totalTokens)} tokens`,
  );
  lines.push(
    `  base: ${fmt(report.breakdown.baseChars)} ~${fmt(report.breakdown.baseTokens)} | append: ${fmt(report.breakdown.appendChars)} ~${fmt(report.breakdown.appendTokens)} | skills: ${fmt(report.breakdown.skillsChars)} ~${fmt(report.breakdown.skillsTokens)} | contextFiles: ${fmt(report.breakdown.contextFilesChars)} ~${fmt(report.breakdown.contextFilesTokens)}`,
  );
  lines.push(
    `Tools (${report.tools.length}): ${fmt(report.toolsJsonChars)} chars ~${fmt(report.toolsTokens)} tokens — ${report.tools.map((t) => t.name).join(", ")}`,
  );
  lines.push(
    `Skills: ${report.skills.length} — ${report.skills.map((s) => s.name).join(", ") || "(none)"}`,
  );
  if (report.contextFiles.length > 0) {
    lines.push(
      `Context files: ${report.contextFiles.length} — ${report.contextFiles.map((f) => `${f.path} (~${fmt(f.tokens)})`).join(", ")}`,
    );
  } else {
    lines.push("Context files: (none)");
  }
  lines.push(
    `Mensajes en sesion: ${report.messageCount} ~${fmt(report.messagesTokens)} tokens (estimado)`,
  );
  lines.push("");

  if (report.contextUsage) {
    const u = report.contextUsage;
    lines.push(
      `Contexto total: ${u.tokens !== null ? fmt(u.tokens) : "n/a"} / ${fmt(u.contextWindow)} ${bar(u.percent)} ${fmtPercent(u.percent)}`,
    );
  } else {
    lines.push(
      `Contexto total estimado (vacio): ~${fmt(report.totalEstimatedTokens)} tokens (prompt + tools)`,
    );
  }
  lines.push("");
  lines.push("Notas: tokens = ceil(chars/4), imagen = 4800 chars. Es aproximado; el tokenizer real varia por provider.");
  lines.push(`Usa /prompt full para ver el prompt completo, /prompt save [ruta] para guardarlo.`);
  return lines.join("\n");
}

export function formatDetailed(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push(formatSummary(report));
  lines.push("");
  lines.push("═".repeat(50));
  lines.push("TOOLS DETALLE");
  lines.push("─".repeat(50));
  for (const t of report.tools) {
    lines.push(`- ${t.name}: ${t.description.slice(0, 120)}`);
  }
  lines.push("");
  lines.push("═".repeat(50));
  lines.push("SKILLS DETALLE");
  lines.push("─".repeat(50));
  if (report.skills.length === 0) lines.push("(none)");
  for (const s of report.skills) {
    lines.push(`- ${s.name}: ${s.description.slice(0, 100)}`);
    lines.push(`  ${s.location}`);
  }
  lines.push("");
  lines.push("═".repeat(50));
  lines.push("CONTEXT FILES");
  lines.push("─".repeat(50));
  if (report.contextFiles.length === 0) lines.push("(none)");
  for (const f of report.contextFiles) {
    lines.push(`- ${f.path}: ${fmt(f.chars)} chars ~${fmt(f.tokens)} tokens`);
  }
  return lines.join("\n");
}

export function formatForFile(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push("# Prompt Inspector — dump completo");
  lines.push("");
  lines.push(`Generado: ${new Date().toISOString()}`);
  lines.push(`CWD: ${report.cwd}`);
  if (report.model) {
    lines.push(`Modelo: ${report.model.provider}/${report.model.id}`);
    lines.push(`Context window: ${report.model.contextWindow}`);
  }
  lines.push("");
  lines.push("## Resumen");
  lines.push("");
  lines.push("```");
  lines.push(formatSummary(report));
  lines.push("```");
  lines.push("");
  lines.push("## System Prompt");
  lines.push("");
  lines.push("```");
  lines.push(report.systemPrompt);
  lines.push("```");
  lines.push("");
  lines.push("## Tools (JSON para provider)");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.tools, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Skills");
  lines.push("");
  for (const s of report.skills) {
    lines.push(`- **${s.name}** — ${s.description}`);
    lines.push(`  - \`${s.location}\``);
  }
  if (report.skills.length === 0) lines.push("(none)");
  lines.push("");
  lines.push("## Context Files");
  lines.push("");
  for (const f of report.contextFiles) {
    lines.push(`- \`${f.path}\` — ${fmt(f.chars)} chars ~${fmt(f.tokens)} tokens`);
  }
  if (report.contextFiles.length === 0) lines.push("(none)");
  return lines.join("\n");
}
