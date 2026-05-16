import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchDeployedIds, fetchFreeModelsFromDev } from "./api.js";
import { ZEN_BASE_URL, ZEN_KEY_VAR } from "./config.js";
import { buildModelConfigs } from "./models.js";

/** Register the OpenCode Zen free provider when free models are available. */
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
