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

    configs.push({
      id,
      name: info.name ?? id,
      reasoning: info.reasoning ?? false,
      thinkingLevelMap,
      input: info.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: info.limit?.context ?? 128000,
      maxTokens: info.limit?.output ?? 16384,
    });
  }

  return configs;
}
