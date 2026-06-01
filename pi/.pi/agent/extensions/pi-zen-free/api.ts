import {
  FALLBACK_FREE_MODELS,
  FETCH_TIMEOUT_MS,
  MODELS_DEV_URL,
  OPENCODE_CLI_USER_AGENT,
  ZEN_BASE_URL,
} from "./config.js";
import type { ModelsDevModel } from "./types.js";

/** Fetch JSON with a short timeout and return null on network or HTTP failures. */
async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": OPENCODE_CLI_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Build fallback model metadata from the currently documented Zen free models. */
function buildFallbackFreeModels(): Map<string, ModelsDevModel> {
  return new Map(
    FALLBACK_FREE_MODELS.map((model) => [
      model.id,
      {
        ...model,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        modalities: { input: ["text"], output: ["text"] },
      },
    ]),
  );
}

/** Load zero-cost OpenCode models from models.dev, falling back to documented free ids. */
export async function fetchFreeModelsFromDev(): Promise<Map<string, ModelsDevModel>> {
  const data = await fetchJson<Record<string, { id?: string; models?: Record<string, ModelsDevModel> }>>(
    MODELS_DEV_URL,
  );
  if (!data) return buildFallbackFreeModels();

  const opencodeProvider = Object.values(data).find((provider) => provider?.id === "opencode");
  if (!opencodeProvider?.models) return buildFallbackFreeModels();

  const freeModels = new Map<string, ModelsDevModel>();
  for (const [id, info] of Object.entries(opencodeProvider.models)) {
    if (info?.cost?.input === 0) {
      freeModels.set(id, info);
    }
  }

  return freeModels.size > 0 ? freeModels : buildFallbackFreeModels();
}

/** Load the set of model ids currently deployed by the Zen endpoint. */
export async function fetchDeployedIds(apiKey: string): Promise<Set<string> | null> {
  const data = await fetchJson<{ data?: { id: string }[] }>(`${ZEN_BASE_URL}/models`, {
    Authorization: `Bearer ${apiKey}`,
  });
  if (!data?.data) return null;
  return new Set(data.data.map((model) => model.id));
}
