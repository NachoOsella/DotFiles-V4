/** Extract the most recent assistant text from a list of messages. */
export function extractLastAssistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    const text = blocksToText(message.content);
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

/** Convert Pi message content blocks into concatenated text. */
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Detect assistant text that looks like a plan implementation decision prompt. */
export function looksLikeImplementationDecisionPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "implement this plan",
    "stay in plan mode",
    "refine the plan",
    "proceed with implementation",
    "seguir refinando",
    "ajustar algo del plan",
  ].some((token) => normalized.includes(token));
}
