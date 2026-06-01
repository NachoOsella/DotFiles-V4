import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { fetchDeployedIds, fetchFreeModelsFromDev } from "./api.js";
import { readCachedModels, profile, writeCachedModels } from "./cache.js";
import { ZEN_BASE_URL, ZEN_KEY_VAR } from "./config.js";
import { createOpenCodeZenHeaders } from "./headers.js";
import { buildModelConfigs } from "./models.js";

const PROVIDER_ID = "zen-free";
const QUOTA_STATUS_KEY = "zen-free-quota";
const QUOTA_NOTICE_THROTTLE_MS = 60_000;

let lastQuotaNoticeAt = 0;

/** Return whether the current session is using the Zen free provider. */
function isZenFreeModel(ctx: { model?: { provider?: string } }): boolean {
  return ctx.model?.provider === PROVIDER_ID;
}

/** Detect common Zen anonymous quota errors in provider error payloads. */
function isZenFreeQuotaError(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;

  const errorMessage = String((message as { errorMessage?: unknown }).errorMessage ?? "");
  const content = String((message as { content?: unknown }).content ?? "");
  const combined = `${errorMessage}\n${content}`;

  return /429|freeusagelimiterror|free usage|rate limit exceeded|quota/i.test(combined);
}

/** Show a clear quota notification without spamming repeated retry attempts. */
function notifyQuotaExceeded(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus(key: string, text: string | undefined): void } }): void {
  ctx.ui.setStatus(QUOTA_STATUS_KEY, "zen quota exhausted");

  const now = Date.now();
  if (now - lastQuotaNoticeAt < QUOTA_NOTICE_THROTTLE_MS) return;
  lastQuotaNoticeAt = now;

  ctx.ui.notify(
    "OpenCode Zen free quota exhausted for this IP. Wait for the quota reset or switch to another provider.",
    "error",
  );
}

/** Register or replace the OpenCode Zen free provider with validated models. */
function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  if (models.length === 0) return;

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Zen Free",
    baseUrl: ZEN_BASE_URL,
    apiKey: `$${ZEN_KEY_VAR}`,
    headers: {
      ...createOpenCodeZenHeaders(),
      "X-Title": "Pi",
      "HTTP-Referer": "https://opencode.ai/",
    },
    api: "openai-completions",
    models,
  });
}

/** Fetch, validate, cache, and register the current free Zen models. */
async function refreshModels(pi: ExtensionAPI): Promise<number> {
  const startedAt = performance.now();
  const [freeModels, deployedIds] = await Promise.all([
    fetchFreeModelsFromDev(),
    fetchDeployedIds(process.env[ZEN_KEY_VAR] ?? "public"),
  ]);

  const models = buildModelConfigs(freeModels, deployedIds);
  if (models.length === 0) return 0;

  writeCachedModels(models);
  registerProvider(pi, models);
  profile("background refresh", startedAt);
  return models.length;
}

/** Register the OpenCode Zen free provider without blocking startup on network I/O. */
export default function (pi: ExtensionAPI) {
  const startedAt = performance.now();
  process.env[ZEN_KEY_VAR] = "public";

  const cachedModels = readCachedModels();
  registerProvider(pi, cachedModels);
  profile(`load from cache (${cachedModels.length} models)`, startedAt);

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);

    // Refresh in the background so slow or unavailable metadata endpoints do not delay startup.
    void refreshModels(pi)
      .then(() => {
        if (cachedModels.length === 0) ctx.ui.setStatus("zen-free", undefined);
      })
      .catch((error) => {
        if (cachedModels.length === 0) ctx.ui.setStatus("zen-free", undefined);
        if (process.env.PI_STARTUP_PROFILE === "1") {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[pi-startup] pi-zen-free background refresh failed: ${message}`);
        }
      });

    if (cachedModels.length === 0) {
      ctx.ui.setStatus("zen-free", "zen refresh");
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!isZenFreeModel(ctx)) return;

    if (event.status === 429) {
      notifyQuotaExceeded(ctx);
      return;
    }

    ctx.ui.setStatus(QUOTA_STATUS_KEY, undefined);
  });

  pi.on("message_end", (event, ctx) => {
    if (!isZenFreeModel(ctx)) return;
    if (!isZenFreeQuotaError(event.message)) return;

    notifyQuotaExceeded(ctx);
  });

  pi.registerCommand("zen-free-refresh", {
    description: "Refresh cached OpenCode Zen free models.",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("zen-free", "refreshing");
      try {
        const count = await refreshModels(pi);
        ctx.ui.setStatus("zen-free", undefined);
        ctx.ui.notify(
          count > 0 ? `Refreshed ${count} Zen free models.` : "No Zen free models were available.",
          count > 0 ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.setStatus("zen-free", undefined);
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Zen free refresh failed: ${message}`, "warning");
      }
    },
  });
}
