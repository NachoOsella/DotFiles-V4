import type { PayloadBlock, PromptPayload } from "./types.js";

/** Estimate token count using a stable character-based approximation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Format a provider payload as readable Markdown for inspection. */
export function formatPayloadAsMd(payload: PromptPayload | string): string {
  const lines: string[] = [];
  const obj = typeof payload === "string" ? JSON.parse(payload) as PromptPayload : payload;

  lines.push("# Pi Prompt Dump", "", `**Generated:** ${new Date().toISOString()}`, "", "---", "");
  appendModel(lines, obj);
  appendSystemPrompt(lines, obj);
  appendMessages(lines, obj);
  appendTools(lines, obj);
  appendMaxTokens(lines, obj);
  return lines.join("\n");
}

/** Append model metadata when present. */
function appendModel(lines: string[], payload: PromptPayload): void {
  if (!payload.model) return;
  lines.push("## Model", "", `\`${String(payload.model)}\``, "", "---", "");
}

/** Append provider-specific system prompt blocks. */
function appendSystemPrompt(lines: string[], payload: PromptPayload): void {
  const system = payload.system;
  if (!system) return;

  lines.push("## System Prompt", "");
  if (Array.isArray(system)) {
    for (const block of system as PayloadBlock[]) {
      if (block.type === "text") appendFence(lines, String(block.text ?? ""), "text");
    }
  } else if (typeof system === "string") {
    appendFence(lines, system, "text");
  }
  lines.push("---", "");
}

/** Append each conversation message in a provider-neutral form. */
function appendMessages(lines: string[], payload: PromptPayload): void {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;

  lines.push("## Messages", "", `**Count:** ${messages.length}`, "");
  messages.forEach((raw, index) => {
    const msg = raw as { role?: string; content?: unknown };
    lines.push(`### Message ${index + 1}: ${msg.role ?? "unknown"}`, "");
    appendMessageContent(lines, msg.content);
    lines.push("---", "");
  });
}

/** Append a message content field that may be text or block arrays. */
function appendMessageContent(lines: string[], content: unknown): void {
  if (typeof content === "string") {
    appendFence(lines, content, "text");
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content as PayloadBlock[]) {
    appendBlock(lines, block);
    lines.push("");
  }
}

/** Append a single provider content block. */
function appendBlock(lines: string[], block: PayloadBlock): void {
  if (block.type === "text") {
    appendFence(lines, String(block.text ?? ""), "text");
  } else if (block.type === "image") {
    lines.push(`> [Image: ${block.source?.media_type ?? block.source?.mediaType ?? "unknown"}]`);
  } else if (block.type === "thinking") {
    lines.push("> [Thinking block]");
  } else if (block.type === "toolUse" || block.type === "tool_use") {
    lines.push(`> [Tool call: ${block.name ?? "unknown"}]`);
    appendFence(lines, JSON.stringify(block.input ?? block.arguments ?? {}, null, 2), "json");
  } else if (block.type === "toolResult" || block.type === "tool_result") {
    appendToolResultBlock(lines, block);
  } else {
    appendFence(lines, JSON.stringify(block, null, 2).slice(0, 500), "json");
  }
}

/** Append a compact preview of a tool result block. */
function appendToolResultBlock(lines: string[], block: PayloadBlock): void {
  lines.push("> [Tool result]");
  if (!block.content) return;

  const textContent = Array.isArray(block.content)
    ? (block.content as PayloadBlock[]).map((item) => item.text ?? JSON.stringify(item)).join("\n")
    : String(block.content);

  const preview = textContent.length > 2000 ? `${textContent.slice(0, 2000)}\n... [truncated]` : textContent;
  appendFence(lines, preview, "text");
}

/** Append tool definitions in a compact list. */
function appendTools(lines: string[], payload: PromptPayload): void {
  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) return;

  lines.push("## Tools", "", `**Count:** ${tools.length}`, "");
  for (const rawTool of tools as Array<Record<string, any>>) {
    const name = rawTool.name || rawTool.function?.name || "unnamed";
    const desc = rawTool.description || rawTool.function?.description || "";
    lines.push(`- **${name}**: ${desc}`);
  }
  lines.push("", "---", "");
}

/** Append token limit metadata when present. */
function appendMaxTokens(lines: string[], payload: PromptPayload): void {
  const maxTokens = payload.max_tokens ?? payload.maxTokens;
  if (!maxTokens) return;
  lines.push(`**Max tokens:** ${maxTokens}`, "");
}

/** Append a fenced code block. */
function appendFence(lines: string[], text: string, lang: string): void {
  lines.push(`\`\`\`${lang}`, text, "```", "");
}
