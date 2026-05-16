import type { RateAssistantMessage } from "./types.js";

/** Estimate output tokens from assistant content when provider usage is unavailable. */
export function estimateTokensFromContent(content: RateAssistantMessage["content"]): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
    } else if (block.type === "toolCall") {
      chars += JSON.stringify(block.arguments).length;
    }
  }
  return Math.round(chars / 4);
}

/** Prefer actual output tokens, falling back to a stable text-length estimate. */
export function getEffectiveTokens(message: RateAssistantMessage): number {
  const actual = message.usage?.output ?? 0;
  if (actual > 0) return actual;
  return estimateTokensFromContent(message.content);
}
