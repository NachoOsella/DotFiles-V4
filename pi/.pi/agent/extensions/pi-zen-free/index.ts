import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_KEY_VAR = "PI_ZEN_FREE_KEY";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT = 5000;

interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "pi-zen-free", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function fetchFreeModelsFromDev(): Promise<Map<string, ModelsDevModel>> {
  const data = await fetchJson<Record<string, { id?: string; models?: Record<string, ModelsDevModel> }>>(
    MODELS_DEV_URL,
  );
  if (!data) return new Map();

  const opencodeProvider = Object.values(data).find((p) => p?.id === "opencode");
  if (!opencodeProvider?.models) return new Map();

  const freeModels = new Map<string, ModelsDevModel>();
  for (const [id, info] of Object.entries(opencodeProvider.models)) {
    if (info?.cost?.input === 0) {
      freeModels.set(id, info);
    }
  }
  return freeModels;
}

async function fetchDeployedIds(): Promise<Set<string> | null> {
  const data = await fetchJson<{ data?: { id: string }[] }>(`${ZEN_BASE_URL}/models`, {
    Authorization: "Bearer public",
  });
  if (!data?.data) return null;
  return new Set(data.data.map((m) => m.id));
}

const THINKING_LEVEL_MAP = {
  minimal: "low",
  xhigh: "high",
};

function buildModelConfigs(freeModels: Map<string, ModelsDevModel>, deployedIds: Set<string> | null): ProviderModelConfig[] {
  const configs: ProviderModelConfig[] = [];

  for (const [id, info] of freeModels) {
    if (deployedIds && !deployedIds.has(id)) continue;
    if (info.modalities?.output?.includes("image")) continue;

    configs.push({
      id,
      name: info.name ?? id,
      reasoning: info.reasoning ?? false,
      thinkingLevelMap: info.reasoning ? THINKING_LEVEL_MAP : undefined,
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

export default async function (pi: ExtensionAPI) {
  process.env[ZEN_KEY_VAR] = "public";

  const [freeModels, deployedIds] = await Promise.all([
    fetchFreeModelsFromDev(),
    fetchDeployedIds(),
  ]);

  const models = buildModelConfigs(freeModels, deployedIds);
  if (models.length === 0) return;

  pi.registerProvider("zen-free", {
    name: "OpenCode Zen Free",
    baseUrl: ZEN_BASE_URL,
    apiKey: ZEN_KEY_VAR,
    headers: {
      "X-Title": "Pi",
      "HTTP-Referer": "https://opencode.ai/",
    },
    api: "openai-completions",
    models,
  });
}
