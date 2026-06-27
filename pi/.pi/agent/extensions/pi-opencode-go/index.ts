import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "opencode-go";
const API_KEY_VAR = "PI_OPENCODE_GO_KEY";
const BASE_URL = "https://opencode.ai/zen/go/v1";
const ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const MODELS_URL = `${BASE_URL}/models`;
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 5_000;
const STATUS_KEY = "opencode-go";
const OPENCODE_CLI_USER_AGENT = process.env.PI_OPENCODE_GO_USER_AGENT ?? "opencode/1.15.11";

/* ------------------------------------------------------------------ */
/*  Models that use the Anthropic Messages API. The SDK appends        */
/*  /v1/messages, so these base URLs must omit the /v1 suffix.         */
/* ------------------------------------------------------------------ */
const ANTHROPIC_MODEL_IDS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
]);

/* ------------------------------------------------------------------ */
/*  Hardcoded metadata for models that are missing from models.dev     */
/*  but are live on OpenCode Go (sourced from whichllm.io).            */
/* ------------------------------------------------------------------ */
interface HardcodedMeta {
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ProviderModelConfig["input"];
  baseUrl?: string;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
}

const OPENCODE_PRICE_BY_ID = new Map<string, HardcodedMeta["cost"]>([
  ["minimax-m2.7", { input: 0.30, output: 1.20, cache_read: 0.06, cache_write: 0.375 }],
  ["minimax-m2.5", { input: 0.30, output: 1.20, cache_read: 0.06, cache_write: 0.375 }],
  ["glm-5.1", { input: 1.40, output: 4.40, cache_read: 0.26 }],
  ["glm-5", { input: 1.00, output: 3.20, cache_read: 0.20 }],
  ["kimi-k2.5", { input: 0.60, output: 3.00, cache_read: 0.10 }],
  ["kimi-k2.6", { input: 0.95, output: 4.00, cache_read: 0.16 }],
  ["qwen3.7-max", { input: 2.50, output: 7.50, cache_read: 0.50, cache_write: 3.125 }],
  ["qwen3.7-plus", { input: 0.40, output: 1.60, cache_read: 0.04, cache_write: 0.50 }],
  ["qwen3.6-plus", { input: 0.50, output: 3.00, cache_read: 0.05, cache_write: 0.625 }],
  ["qwen3.5-plus", { input: 0.20, output: 1.20, cache_read: 0.02, cache_write: 0.25 }],
  ["deepseek-v4-pro", { input: 1.74, output: 3.48, cache_read: 0.145 }],
  ["deepseek-v4-flash", { input: 0.14, output: 0.28, cache_read: 0.028 }],
]);

const HARDCODED_META = new Map<string, HardcodedMeta>([
  ["deepseek-v4-pro", {
    name: "DeepSeek V4 Pro",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ["text"],
  }],
  ["deepseek-v4-flash", {
    name: "DeepSeek V4 Flash",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ["text"],
  }],
  ["mimo-v2.5", {
    name: "MiMo-V2.5",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ["text", "image"],
  }],
  ["mimo-v2.5-pro", {
    name: "MiMo-V2.5-Pro",
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 128_000,
    input: ["text"],
  }],
  ["mimo-v2-pro", {
    name: "MiMo-V2 Pro",
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 128_000,
    input: ["text"],
  }],
  ["mimo-v2-omni", {
    name: "MiMo-V2 Omni",
    reasoning: true,
    contextWindow: 262_144,
    maxTokens: 128_000,
    input: ["text", "image"],
  }],
  ["minimax-m3", {
    name: "MiniMax M3",
    reasoning: true,
    contextWindow: 512_000,
    maxTokens: 131_072,
    input: ["text", "image"],
    baseUrl: ANTHROPIC_BASE_URL,
  }],
  ["hy3-preview", {
    name: "HY3 Preview",
    reasoning: true,
    contextWindow: 262_144,
    maxTokens: 65_536,
    input: ["text"],
    cost: { input: 0.066, output: 0.26 },
  }],
  ["qwen3.7-max", {
    name: "Qwen3.7 Max",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ["text"],
    baseUrl: ANTHROPIC_BASE_URL,
  }],
  ["qwen3.7-plus", {
    name: "Qwen3.7 Plus",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ["text", "image"],
    baseUrl: ANTHROPIC_BASE_URL,
  }],
  ["qwen3.6-plus", {
    name: "Qwen3.6 Plus",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ["text", "image"],
    baseUrl: ANTHROPIC_BASE_URL,
  }],
  ["kimi-k2.7-code", {
    name: "Kimi K2.7 Code",
    reasoning: true,
    contextWindow: 262_144,
    maxTokens: 65_536,
    input: ["text", "image"],
  }],
]);

interface OpenCodeModelListResponse {
  data?: Array<{ id?: string }>;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

/** Prompt the user for an OpenCode Go API key and store it in Pi auth. */
async function loginOpenCodeGo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onAuth({ url: "https://opencode.ai/auth" });
  const apiKey = (await callbacks.onPrompt({ message: "Paste your OpenCode Go API key:" })).trim();
  if (!apiKey) throw new Error("OpenCode Go API key is required.");

  return {
    access: apiKey,
    refresh: apiKey,
    expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
  };
}

/** OpenCode Go keys do not need refreshing; keep the stored key. */
async function refreshOpenCodeGo(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return {
    ...credentials,
    expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
  };
}

/** Fetch JSON with the OpenCode CLI user agent and a short timeout. */
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

/** Create a random OpenCode CLI-compatible request identifier. */
function createClientId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Build headers expected by the OpenCode Zen/Go API gateway. */
function createOpenCodeHeaders(): Record<string, string> {
  return {
    "User-Agent": OPENCODE_CLI_USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-session": createClientId("ses"),
    "x-opencode-project": createClientId("proj"),
    "x-opencode-request": createClientId("req"),
    "X-Title": "Pi",
    "HTTP-Referer": "https://opencode.ai/",
  };
}

/** Return whether a model uses the Anthropic Messages endpoint. */
function usesAnthropicEndpoint(id: string): boolean {
  // All MiniMax and all Qwen models go through the Anthropic-compatible v1/messages endpoint.
  if (ANTHROPIC_MODEL_IDS.has(id)) return true;
  return id.startsWith("qwen");
}

/** Convert models.dev metadata into Pi input modality flags. */
function getInputTypes(info: ModelsDevModel): ProviderModelConfig["input"] {
  return info.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
}

/** Create a Pi model definition for an OpenCode Go model. */
function createModel(
  id: string,
  info: ModelsDevModel | HardcodedMeta,
): ProviderModelConfig {
  const isAnthropic = usesAnthropicEndpoint(id);
  const contextWindow = info.contextWindow ?? info.limit?.context ?? 128_000;
  const maxTokens = info.maxTokens ?? info.limit?.output ?? 16_384;
  const input = "input" in info ? info.input : getInputTypes(info);
  const reasoning = info.reasoning ?? false;
  const baseUrl = "baseUrl" in info && info.baseUrl
    ? info.baseUrl
    : isAnthropic
      ? ANTHROPIC_BASE_URL
      : BASE_URL;

  const cost = OPENCODE_PRICE_BY_ID.get(id) ?? info.cost;
  const modelCost = cost
    ? {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache_read ?? 0,
        cacheWrite: cost.cache_write ?? 0,
      }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  return {
    id,
    name: info.name ?? id,
    api: isAnthropic ? "anthropic-messages" : "openai-completions",
    baseUrl,
    reasoning,
    thinkingLevelMap: reasoning ? { minimal: "low", xhigh: id.includes("deepseek") ? "max" : "high" } : undefined,
    input,
    contextWindow,
    maxTokens,
    cost: modelCost,
    compat: isAnthropic
      ? { supportsEagerToolInputStreaming: false }
      : {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
          ...(id.includes("deepseek")
            ? {
                // DeepSeek uses a nested thinking switch, not only OpenAI-style reasoning_effort.
                thinkingFormat: "deepseek" as const,
                requiresReasoningContentOnAssistantMessages: true,
              }
            : {}),
        },
  };
}

/** Fetch the model IDs currently exposed by OpenCode Go. */
async function fetchGoModelIds(): Promise<Set<string> | null> {
  const payload = await fetchJson<OpenCodeModelListResponse>(MODELS_URL, {
    ...createOpenCodeHeaders(),
    Authorization: `Bearer ${process.env[API_KEY_VAR] ?? "public"}`,
  });

  if (!payload?.data) return null;
  return new Set(payload.data.map((model) => model.id).filter((id): id is string => Boolean(id)));
}

/** Fetch OpenCode model metadata from models.dev. */
async function fetchModelsDevData(): Promise<Map<string, ModelsDevModel>> {
  const data = await fetchJson<Record<string, { id?: string; models?: Record<string, ModelsDevModel> }>>(MODELS_DEV_URL);
  const opencodeProvider = data ? Object.values(data).find((provider) => provider?.id === "opencode") : undefined;
  return new Map(Object.entries(opencodeProvider?.models ?? {}));
}

/** Build model configs from live Go ids enriched with models.dev + hardcoded metadata. */
async function buildGoModels(): Promise<ProviderModelConfig[]> {
  const [liveIds, modelsDev] = await Promise.all([fetchGoModelIds(), fetchModelsDevData()]);
  const ids = liveIds ?? new Set([...modelsDev.keys(), ...HARDCODED_META.keys()]);
  const models: ProviderModelConfig[] = [];

  for (const id of ids) {
    // Prefer hardcoded metadata (verified against whichllm / OpenCode Go docs)
    // over models.dev, which often has stale or incomplete Go-specific info.
    const hardcoded = HARDCODED_META.get(id);
    if (hardcoded) {
      // Merge cost from models.dev when the hardcoded entry lacks cost data.
      const fromDev = modelsDev.get(id);
      if (fromDev?.cost && !hardcoded.cost) {
        models.push(createModel(id, { ...hardcoded, cost: fromDev.cost as HardcodedMeta["cost"] }));
      } else {
        models.push(createModel(id, hardcoded));
      }
      continue;
    }
    // Fall back to models.dev for models not in the hardcoded set.
    const fromDev = modelsDev.get(id);
    if (fromDev && !fromDev.modalities?.output?.includes("image")) {
      models.push(createModel(id, fromDev));
      continue;
    }

    // Do not hide newly released Go models just because metadata has not
    // reached models.dev yet. Register a conservative text-only fallback.
    models.push(createModel(id, {
      name: id,
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text"],
    }));
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Register OpenCode Go using live model availability when possible. */
async function registerOpenCodeGo(pi: ExtensionAPI): Promise<number> {
  const models = await buildGoModels();

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Go",
    baseUrl: BASE_URL,
    apiKey: `$${API_KEY_VAR}`,
    headers: createOpenCodeHeaders(),
    api: "openai-completions",
    models,
    oauth: {
      name: "OpenCode Go",
      login: loginOpenCodeGo,
      refreshToken: refreshOpenCodeGo,
      getApiKey: (credentials) => credentials.access,
    },
  });

  return models.length;
}

/** Add OpenCode Go subscription models to Pi. */
export default async function (pi: ExtensionAPI) {
  await registerOpenCodeGo(pi);

  pi.registerCommand("opencode-go-refresh", {
    description: "Refresh OpenCode Go models.",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "refreshing");
      try {
        const count = await registerOpenCodeGo(pi);
        ctx.modelRegistry.refresh();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(`Refreshed ${count} OpenCode Go models.`, "info");
      } catch (error) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`OpenCode Go refresh failed: ${message}`, "warning");
      }
    },
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (event.status === 401 || event.status === 403) {
      ctx.ui.notify(`OpenCode Go authentication failed. Set ${API_KEY_VAR} with your Go API key.`, "error");
    }
  });
}
