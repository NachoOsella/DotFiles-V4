/**
 * OpenAI HTTP transport.
 *
 * Two authentication modes share the same request surface:
 * - `openai-codex`: the legacy Codex backend (`chatgpt.com/backend-api`), using
 *   Codex client headers, the ChatGPT account id, and the Cloudflare cookie store.
 * - `openai`: the official Pi ChatGPT subscription login, which calls
 *   `api.openai.com/v1` directly with a bearer token.
 */

import { getCodexOriginator, buildCodexUserAgent } from "./ua.ts";
import { wrapFetchWithCookies, type FetchLike } from "./cookies.ts";
import type { OpenAIAuthProvider } from "./pi-auth.ts";

export interface TransportOptions {
  token: string;
  accountId?: string;
  provider?: OpenAIAuthProvider;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_CLIENT_VERSION = "1.0.0";

export interface CodexTransport {
  fetch: FetchLike;
  provider: OpenAIAuthProvider;
  baseUrl: string;
  token: string;
  accountId?: string;
  buildHeaders(accept: string): Headers;
  resolveEndpoint(path: "models" | "responses"): string;
  resolveSearchEndpoint(): string;
}

function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

export function normalizeCodexBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  normalized = stripSuffix(normalized, "/codex/responses");
  normalized = stripSuffix(normalized, "/codex");
  return normalized;
}

function isOpenAiRootBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com" && (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}

export function normalizeOpenAIBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_OPENAI_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  normalized = stripSuffix(normalized, "/codex/responses");
  normalized = stripSuffix(normalized, "/codex");
  normalized = stripSuffix(normalized, "/responses");
  normalized = stripSuffix(normalized, "/models");
  if (isOpenAiRootBaseUrl(normalized)) normalized = `${normalized}/v1`;
  return normalized;
}

export function resolveCodexEndpoint(
  baseUrl: string | undefined,
  path: "models" | "responses",
  provider: OpenAIAuthProvider = "openai-codex",
): string {
  if (provider === "openai") return `${normalizeOpenAIBaseUrl(baseUrl)}/${path}`;
  return `${normalizeCodexBaseUrl(baseUrl)}/codex/${path}`;
}

export function resolveCodexSearchEndpoint(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    normalized = normalized.slice(0, -"/responses".length);
  }
  if (normalized.endsWith("/codex/models")) {
    normalized = normalized.slice(0, -"/models".length);
  }
  if (normalized.endsWith("/codex/alpha/search") || normalized.endsWith("/alpha/search")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
  if (normalized.endsWith("/v1")) return `${normalized}/alpha/search`;
  if (isOpenAiRootBaseUrl(normalized)) return `${normalized}/v1/alpha/search`;
  return `${normalized}/codex/alpha/search`;
}

export function createTransport(options: TransportOptions): CodexTransport {
  const provider = options.provider ?? "openai-codex";
  const baseUrl =
    provider === "openai"
      ? normalizeOpenAIBaseUrl(options.baseUrl)
      : normalizeCodexBaseUrl(options.baseUrl);
  const rawFetch: FetchLike = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const fetch = provider === "openai" ? rawFetch : wrapFetchWithCookies(rawFetch);

  return {
    fetch,
    provider,
    baseUrl,
    token: options.token,
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    buildHeaders(accept: string): Headers {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${options.token}`);
      if (provider === "openai-codex") {
        if (options.accountId) headers.set("chatgpt-account-id", options.accountId);
        headers.set("originator", getCodexOriginator());
      }
      headers.set("accept", accept);
      if (accept === "text/event-stream") {
        headers.set("content-type", "application/json");
      }
      headers.set("User-Agent", buildCodexUserAgent());
      return headers;
    },
    resolveEndpoint(path) {
      return resolveCodexEndpoint(baseUrl, path, provider);
    },
    resolveSearchEndpoint() {
      return resolveCodexSearchEndpoint(baseUrl);
    },
  };
}
