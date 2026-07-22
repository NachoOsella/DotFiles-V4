import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { DEEPSEEK_THINKING_LEVEL_MAP, DEFAULT_THINKING_LEVEL_MAP } from "./config.js";
import type { ModelsDevModel } from "./types.js";

/** Convert metadata from models.dev into Pi provider model configs. */
export function buildModelConfigs(
  freeModels: Map<string, ModelsDevModel>,
  deployedIds: Set<string> | null,
): ProviderModelConfig[] {
  const configs: ProviderModelConfig[] = [];

  for (const [id, info] of freeModels) {
    if (deployedIds && !deployedIds.has(id)) continue;
    if (info.modalities?.output?.includes("image")) continue;

    const thinkingLevelMap = info.reasoning
      ? id.includes("deepseek")
        ? DEEPSEEK_THINKING_LEVEL_MAP
        : DEFAULT_THINKING_LEVEL_MAP
      : undefined;

    // qwen3.6-plus-free is excluded because the Zen API /chat/completions endpoint
    // returns Anthropic Messages format (message_start, content_block_delta, etc.)
    // instead of OpenAI Chat Completions SSE format. Since pi-zen-free registers
    // as "openai-completions", the stream parser never receives finish_reason.
    // This is a backend issue on OpenCode's side, not a Pi configuration problem.
    if (id === "qwen3.6-plus-free") continue;

    configs.push({
      id,
      name: info.name ?? id,
      reasoning: info.reasoning ?? false,
      thinkingLevelMap,
      input: info.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
      // Keep provider pricing metadata instead of assuming every zero-input model is free.
      cost: {
        input: info.cost?.input ?? 0,
        output: info.cost?.output ?? 0,
        cacheRead: info.cost?.cache_read ?? 0,
        cacheWrite: info.cost?.cache_write ?? 0,
      },
      contextWindow: info.limit?.context ?? 128000,
      maxTokens: info.limit?.output ?? 16384,
    });
  }

  return configs;
}
