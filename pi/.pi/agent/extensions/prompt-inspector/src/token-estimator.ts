/** Token estimation matching pi's internal logic (chars/4 approximation). */

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_CHARS = 4800;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCharsTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateToolsTokens(tools: unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return estimateTextTokens(JSON.stringify(tools));
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: unknown }>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg as any);
  }
  return total;
}

function estimateMessageTokens(message: {
  role: string;
  content: unknown;
}): number {
  // Mirrors pi's estimateMessageTokens: text + thinking + toolCall args
  if (message.role === "user" || message.role === "toolResult") {
    return estimateContentTokens(message.content as any);
  }
  if (Array.isArray((message as any).content)) {
    let chars = 0;
    for (const block of (message as any).content as Array<any>) {
      if (block.type === "text") chars += block.text?.length ?? 0;
      else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
      else if (block.type === "toolCall")
        chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
      else if (block.type === "image") chars += IMAGE_TOKEN_CHARS;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  if (typeof message.content === "string") {
    return estimateTextTokens(message.content);
  }
  return 0;
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as Array<any>) {
    if (block.type === "text") chars += block.text?.length ?? 0;
    else if (block.type === "image") chars += IMAGE_TOKEN_CHARS;
    else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function calculateContextPercent(
  tokens: number | null,
  contextWindow: number,
): number | null {
  if (tokens === null || contextWindow <= 0) return null;
  return (tokens / contextWindow) * 100;
}
