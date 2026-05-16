import { FETCH_TIMEOUT_MS, MODELS_DEV_URL, ZEN_BASE_URL } from "./config.js";
import type { ModelsDevModel } from "./types.js";

/** Fetch JSON with a short timeout and return null on network or HTTP failures. */
async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "pi-zen-free", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Load zero-cost OpenCode models from models.dev. */
export async function fetchFreeModelsFromDev(): Promise<Map<string, ModelsDevModel>> {
  const data = await fetchJson<Record<string, { id?: string; models?: Record<string, ModelsDevModel> }>>(
    MODELS_DEV_URL,
  );
  if (!data) return new Map();

  const opencodeProvider = Object.values(data).find((provider) => provider?.id === "opencode");
  if (!opencodeProvider?.models) return new Map();

  const freeModels = new Map<string, ModelsDevModel>();
  for (const [id, info] of Object.entries(opencodeProvider.models)) {
    if (info?.cost?.input === 0) {
      freeModels.set(id, info);
    }
  }
  return freeModels;
}

/** Load the set of model ids currently deployed by the Zen endpoint. */
export async function fetchDeployedIds(): Promise<Set<string> | null> {
  const data = await fetchJson<{ data?: { id: string }[] }>(`${ZEN_BASE_URL}/models`, {
    Authorization: "Bearer public",
  });
  if (!data?.data) return null;
  return new Set(data.data.map((model) => model.id));
}
