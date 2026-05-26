import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "pi-zen-free", "models.json");
const CACHE_VERSION = 1;

interface ModelCacheFile {
  version: number;
  refreshedAt: string;
  models: ProviderModelConfig[];
}

/** Log startup profile data only when explicitly requested. */
export function profile(label: string, startedAt: number): void {
  if (process.env.PI_STARTUP_PROFILE !== "1") return;
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  console.error(`[pi-startup] pi-zen-free ${label}: ${elapsedMs}ms`);
}

/** Read cached provider models without touching the network. */
export function readCachedModels(): ProviderModelConfig[] {
  if (!existsSync(CACHE_PATH)) return [];

  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<ModelCacheFile>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return [];
    return parsed.models;
  } catch {
    return [];
  }
}

/** Persist validated provider models for the next fast startup. */
export function writeCachedModels(models: ProviderModelConfig[]): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const payload: ModelCacheFile = {
      version: CACHE_VERSION,
      refreshedAt: new Date().toISOString(),
      models,
    };
    writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Cache writes are best-effort and must never break provider registration.
  }
}
