import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai"

const DEFAULT_KILO_API_URL = "https://api.kilo.ai"
const ENV_KILO_API_URL = "KILO_API_URL"
const ENV_KILO_API_KEY = "KILO_API_KEY"
const ENV_KILO_EDITOR_NAME = "KILO_EDITOR_NAME"
const DEFAULT_EDITOR_NAME = "Pi"
const PROVIDER_NAME = "kilo"
const OPENROUTER_PATH = "/api/openrouter"
const DEVICE_AUTH_CODES_PATH = "/api/device-auth/codes"
const POLL_INTERVAL_MS = 3000
const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000
const ANONYMOUS_API_KEY = "anonymous"

interface OpenRouterModelRecord {
  id: string
  name: string
  description?: string
  context_length: number
  max_completion_tokens?: number | null
  pricing?: {
    prompt?: string | null
    completion?: string | null
    input_cache_write?: string | null
    input_cache_read?: string | null
  }
  architecture?: {
    input_modalities?: string[] | null
    output_modalities?: string[] | null
  }
  top_provider?: { max_completion_tokens?: number | null }
  supported_parameters?: string[]
}

interface OpenRouterModelsResponse {
  data: OpenRouterModelRecord[]
}

interface DeviceAuthInitiateResponse {
  code: string
  verificationUrl: string
  expiresIn: number
}

interface DeviceAuthPollResponse {
  status: "pending" | "approved" | "denied" | "expired"
  token?: string
}

function getRawApiBaseUrl(): string {
  const configured = process.env[ENV_KILO_API_URL]?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_KILO_API_URL
}

function stripOpenRouterSuffix(url: string): string {
  return url.replace(/\/api\/openrouter\/?$/i, "").replace(/\/+$/u, "")
}

function getKiloApiBaseUrl(): string {
  return stripOpenRouterSuffix(getRawApiBaseUrl())
}

function getKiloOpenRouterBaseUrl(): string {
  return `${getKiloApiBaseUrl()}${OPENROUTER_PATH}`
}

function getEditorName(): string {
  return process.env[ENV_KILO_EDITOR_NAME]?.trim() || DEFAULT_EDITOR_NAME
}

function getConfiguredApiKey(): string {
  const envKey = process.env[ENV_KILO_API_KEY]?.trim()
  return envKey && envKey.length > 0 ? envKey : ANONYMOUS_API_KEY
}

function parseApiPrice(price: string | null | undefined): number {
  if (!price) return 0
  const parsed = Number.parseFloat(price)
  return Number.isNaN(parsed) ? 0 : parsed
}

function supportsTextOnlyOutput(model: OpenRouterModelRecord): boolean {
  const outputModalities = model.architecture?.output_modalities ?? []

  if (outputModalities.length === 0) {
    return true
  }

  return outputModalities.every((modality) => modality === "text")
}

function buildInputModalities(model: OpenRouterModelRecord): Array<"text" | "image"> {
  const inputModalities = new Set(model.architecture?.input_modalities ?? [])
  const result: Array<"text" | "image"> = []

  if (inputModalities.has("text") || inputModalities.size === 0) {
    result.push("text")
  }

  if (inputModalities.has("image")) {
    result.push("image")
  }

  if (result.length === 0) {
    result.push("text")
  }

  return result
}

function transformModel(model: OpenRouterModelRecord) {
  const supportedParameters = model.supported_parameters ?? []
  const inputPrice = parseApiPrice(model.pricing?.prompt)
  const outputPrice = parseApiPrice(model.pricing?.completion)
  const cacheWritePrice = parseApiPrice(model.pricing?.input_cache_write)
  const cacheReadPrice = parseApiPrice(model.pricing?.input_cache_read)
  const maxOutputTokens =
    model.top_provider?.max_completion_tokens ?? model.max_completion_tokens ?? Math.max(1024, Math.ceil(model.context_length * 0.2))

  return {
    id: model.id,
    name: model.name,
    reasoning: supportedParameters.includes("reasoning"),
    input: buildInputModalities(model),
    cost: {
      input: inputPrice,
      output: outputPrice,
      cacheRead: cacheReadPrice,
      cacheWrite: cacheWritePrice,
    },
    contextWindow: model.context_length,
    maxTokens: maxOutputTokens,
    compat: {
      supportsDeveloperRole: false,
    },
  }
}

function buildFallbackModels() {
  return [
    {
      id: "kilo-auto/free",
      name: "Kilo Auto Free",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 204800,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "kilo-auto/balanced",
      name: "Kilo Auto Balanced",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.00000175,
        output: 0.000014,
        cacheRead: 0.000000175,
        cacheWrite: 0,
      },
      contextWindow: 400000,
      maxTokens: 65536,
      compat: {
        supportsDeveloperRole: false,
      },
    },
    {
      id: "kilo-auto/frontier",
      name: "Kilo Auto Frontier",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.000005,
        output: 0.000025,
        cacheRead: 0.0000005,
        cacheWrite: 0.00000625,
      },
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: {
        supportsDeveloperRole: false,
      },
    },
  ]
}

function sortModels(models: Array<{ id: string }>) {
  const priority = new Map([
    ["kilo-auto/free", 0],
    ["kilo-auto/balanced", 1],
    ["kilo-auto/frontier", 2],
  ])

  return [...models].sort((a, b) => {
    const aPriority = priority.get(a.id) ?? 1000
    const bPriority = priority.get(b.id) ?? 1000

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    return a.id.localeCompare(b.id)
  })
}

async function initiateDeviceAuth(): Promise<DeviceAuthInitiateResponse> {
  const response = await fetch(`${getKiloApiBaseUrl()}${DEVICE_AUTH_CODES_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  })

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many pending Kilo authorization requests. Please try again later.")
    }

    throw new Error(`Failed to start Kilo device authorization: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as DeviceAuthInitiateResponse
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
  const response = await fetch(`${getKiloApiBaseUrl()}${DEVICE_AUTH_CODES_PATH}/${code}`)

  if (response.status === 202) {
    return { status: "pending" }
  }

  if (response.status === 403) {
    return { status: "denied" }
  }

  if (response.status === 410) {
    return { status: "expired" }
  }

  if (!response.ok) {
    throw new Error(`Failed to poll Kilo device authorization: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as DeviceAuthPollResponse
}

async function authenticateWithDeviceAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const auth = await initiateDeviceAuth()

  callbacks.onProgress?.(`Open ${auth.verificationUrl} and enter code ${auth.code}`)
  callbacks.onAuth({
    url: auth.verificationUrl,
    instructions: `Open ${auth.verificationUrl} and enter code ${auth.code}`,
  })

  const deadline = Date.now() + auth.expiresIn * 1000

  while (Date.now() < deadline) {
    const result = await pollDeviceAuth(auth.code)

    if (result.status === "approved" && result.token) {
      return {
        refresh: result.token,
        access: result.token,
        expires: Date.now() + TOKEN_EXPIRATION_MS,
      }
    }

    if (result.status === "denied") {
      throw new Error("Authorization denied by user")
    }

    if (result.status === "expired") {
      throw new Error("Authorization code expired")
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error("Authorization timed out")
}

async function fetchKiloModels(apiKey?: string) {
  const response = await fetch(`${getKiloOpenRouterBaseUrl()}/models`, {
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "pi-kilo-gateway",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch Kilo models: ${response.status} ${response.statusText}`)
  }

  const json = (await response.json()) as OpenRouterModelsResponse
  const models = json.data
    .filter((model) => supportsTextOnlyOutput(model))
    .map((model) => transformModel(model))

  return sortModels(models)
}

function registerKiloProvider(pi: ExtensionAPI, models: ReturnType<typeof buildFallbackModels>) {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: getKiloOpenRouterBaseUrl(),
    api: "openai-completions",
    apiKey: getConfiguredApiKey(),
    authHeader: true,
    headers: {
      "HTTP-Referer": "https://pi.dev",
      "User-Agent": "pi-kilo-gateway",
      "X-Title": "Pi",
      "X-KILO-EDITORNAME": getEditorName(),
    },
    models,
    oauth: {
      name: "Kilo Gateway",
      login: authenticateWithDeviceAuth,
      refreshToken: async (credentials) => ({
        ...credentials,
        expires: Date.now() + TOKEN_EXPIRATION_MS,
      }),
      getApiKey: (credentials) => credentials.access,
    },
  })
}

export default function (pi: ExtensionAPI) {
  let currentModels = buildFallbackModels()
  let lastRefreshStatus = "Using bundled fallback models"

  registerKiloProvider(pi, currentModels)

  pi.registerCommand("kilo-refresh", {
    description: "Refresh the Kilo Gateway model catalog",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Refreshing Kilo Gateway models...", "info")
      try {
        const apiKey = getConfiguredApiKey()
        const models = await fetchKiloModels(apiKey === ANONYMOUS_API_KEY ? undefined : apiKey)
        if (models.length > 0) {
          currentModels = models
          registerKiloProvider(pi, currentModels)
          lastRefreshStatus = `Loaded ${models.length} live Kilo models`
          ctx.ui.notify(lastRefreshStatus, "success")
          return
        }

        lastRefreshStatus = "Kilo returned no models; keeping fallback catalog"
        ctx.ui.notify(lastRefreshStatus, "warning")
      } catch (error) {
        lastRefreshStatus = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Kilo refresh failed: ${lastRefreshStatus}`, "error")
      }
    },
  })

  pi.registerCommand("kilo-status", {
    description: "Show the active Kilo Gateway configuration",
    handler: async (_args, ctx) => {
      const baseUrl = getKiloOpenRouterBaseUrl()
      const apiBase = getKiloApiBaseUrl()
      const mode = process.env[ENV_KILO_API_KEY]?.trim() ? "API key" : "anonymous / OAuth"
      ctx.ui.notify(
        [
          `Kilo base URL: ${apiBase}`,
          `OpenRouter URL: ${baseUrl}`,
          `Model count: ${currentModels.length}`,
          `Auth mode: ${mode}`,
          `Last refresh: ${lastRefreshStatus}`,
        ].join("\n"),
        "info",
      )
    },
  })

  void (async () => {
    try {
      const apiKey = getConfiguredApiKey()
      const models = await fetchKiloModels(apiKey === ANONYMOUS_API_KEY ? undefined : apiKey)
      if (models.length > 0) {
        currentModels = models
        registerKiloProvider(pi, currentModels)
        lastRefreshStatus = `Loaded ${models.length} live Kilo models`
      }
    } catch (error) {
      lastRefreshStatus = error instanceof Error ? error.message : String(error)
    }
  })()
}
