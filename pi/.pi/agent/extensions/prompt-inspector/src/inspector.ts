/** Pure inspection logic: builds a report from current session state. */

import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  estimateCharsTokens,
  estimateTextTokens,
  estimateToolsTokens,
} from "./token-estimator.ts";
import type { InspectionReport, PromptBreakdown } from "./types.ts";

function getSkillEntries(options: BuildSystemPromptOptions) {
  return options.skills ?? [];
}

function getContextFileEntries(options: BuildSystemPromptOptions) {
  return options.contextFiles ?? [];
}

function buildBreakdown(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
): PromptBreakdown {
  const append = options.appendSystemPrompt ?? "";
  const contextFiles = getContextFileEntries(options);
  const skills = getSkillEntries(options);

  // These are approximations derived from the prompt structure.
  // The prompt is: base + append + project_context + skills + cwd
  // We estimate each section by measuring its source content.
  const appendChars = append.length;
  const contextFilesChars = contextFiles.reduce(
    (sum, f) => sum + f.content.length,
    0,
  );
  // Skills in prompt are only name/description/location, not full file.
  // Estimate from the formatted skills section if present.
  const skillsSection = extractSkillsSection(systemPrompt);
  const skillsChars = skillsSection.length;

  const cwdLine = `Current working directory: ${options.cwd}`;
  const cwdChars = cwdLine.length;

  // Base = total - known sections (approx)
  const accounted =
    appendChars + contextFilesChars + skillsChars + cwdChars;
  const baseChars = Math.max(0, systemPrompt.length - accounted);

  return {
    totalChars: systemPrompt.length,
    totalTokens: estimateTextTokens(systemPrompt),
    baseChars,
    baseTokens: estimateCharsTokens(baseChars),
    appendChars,
    appendTokens: estimateCharsTokens(appendChars),
    contextFilesChars,
    contextFilesTokens: estimateCharsTokens(contextFilesChars),
    skillsChars,
    skillsTokens: estimateCharsTokens(skillsChars),
    cwdChars,
    cwdTokens: estimateCharsTokens(cwdChars),
  };
}

function extractSkillsSection(prompt: string): string {
  const start = prompt.indexOf("<available_skills>");
  const end = prompt.indexOf("</available_skills>");
  if (start === -1 || end === -1) return "";
  return prompt.slice(start, end + "</available_skills>".length);
}

function getToolsJsonForEstimation(
  pi: ExtensionAPI,
  options: BuildSystemPromptOptions,
): unknown[] {
  // Prefer actual tool definitions from pi
  try {
    const all = pi.getAllTools();
    const activeNames = new Set(options.selectedTools ?? []);
    const active =
      activeNames.size > 0
        ? all.filter((t) => activeNames.has(t.name))
        : all;
    return active.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  } catch {
    // Fallback to snippets
    const snippets = options.toolSnippets ?? {};
    return Object.entries(snippets).map(([name, desc]) => ({
      name,
      description: desc,
      parameters: { type: "object", properties: {} },
    }));
  }
}

export function buildInspectionReport(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): InspectionReport {
  const systemPrompt = ctx.getSystemPrompt();
  const options = ctx.getSystemPromptOptions();
  const breakdown = buildBreakdown(systemPrompt, options);

  const toolsJson = getToolsJsonForEstimation(pi, options);
  const toolsJsonChars = JSON.stringify(toolsJson).length;
  const toolsTokens = estimateToolsTokens(toolsJson);

  const skills = getSkillEntries(options).map((s) => ({
    name: s.name,
    description: s.description,
    location: s.filePath,
  }));

  const contextFiles = getContextFileEntries(options).map((f) => ({
    path: f.path,
    chars: f.content.length,
    tokens: estimateCharsTokens(f.content.length),
  }));

  // Message stats from session
  const entries = ctx.sessionManager.getBranch();
  const messageCount = entries.filter((e: any) => e.type === "message").length;
  // Rough messages tokens (excluding system prompt) - we can use ctx.getContextUsage
  // to infer, but also estimate from branch
  const usage = ctx.getContextUsage();

  // Total estimated = systemPrompt tokens + tools tokens + messages tokens (if known via usage)
  // When usage is available it already includes systemPrompt+tools+messages.
  let totalEstimatedTokens = breakdown.totalTokens + toolsTokens;
  let messagesTokens = 0;
  if (usage?.tokens !== null && usage?.tokens !== undefined) {
    totalEstimatedTokens = usage.tokens;
    messagesTokens = Math.max(
      0,
      usage.tokens - breakdown.totalTokens - toolsTokens,
    );
  }

  const model = ctx.model
    ? {
        provider: ctx.model.provider,
        id: ctx.model.id,
        name: (ctx.model as any).name ?? ctx.model.id,
        contextWindow: ctx.model.contextWindow ?? 0,
        thinkingLevel: ctx.thinkingLevel,
      }
    : undefined;

  return {
    cwd: options.cwd,
    model,
    systemPrompt,
    breakdown,
    tools: toolsJson.map((t: any) => ({
      name: t.name,
      description: t.description,
    })),
    toolsJsonChars,
    toolsTokens,
    skills,
    contextFiles,
    contextUsage: usage
      ? {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
        }
      : undefined,
    messageCount,
    messagesTokens,
    totalEstimatedTokens,
    promptChars: systemPrompt.length,
    promptTokens: breakdown.totalTokens,
  };
}
