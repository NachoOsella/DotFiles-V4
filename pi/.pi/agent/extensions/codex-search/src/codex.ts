export {
  CodexError,
  classifyError,
  classifyHttpStatus,
  classifyEventErrorMessage,
} from "./errors.ts";
export type { CodexErrorKind } from "./errors.ts";
export type {
  CodexCitation,
  CodexSearchCall,
  CodexWebSearchResult,
  Freshness,
  ResponseLength,
  SearchContextSize,
  StandaloneExternalWebAccess,
} from "./modes/types.ts";
export type { CodexModel } from "./modes/types.ts";
export { runResponsesSearch } from "./modes/responses.ts";
export {
  runStandaloneCommands,
  externalWebAccessForFreshness,
  hasAnyCommand,
  assertSupportedStandaloneCombination,
  isUnsupportedStandaloneCombination,
} from "./modes/standalone.ts";
export type {
  SearchQuery,
  OpenCommand,
  FindCommand,
  ClickCommand,
  ScreenshotCommand,
  FinanceCommand,
  WeatherCommand,
  SportsCommand,
  TimeCommand,
  StandaloneCommandsOptions,
} from "./modes/standalone.ts";
export {
  createTransport,
  normalizeCodexBaseUrl,
  resolveCodexEndpoint,
  resolveCodexSearchEndpoint,
} from "./transport.ts";
export type { CodexTransport } from "./transport.ts";
export { createRefStore } from "./ref-store.ts";
export type { RefStore } from "./ref-store.ts";
export { buildCodexUserAgent, getCodexOriginator } from "./ua.ts";
export {
  getSharedCookieStore,
  wrapFetchWithCookies,
  ChatGptCloudflareCookieStore,
} from "./cookies.ts";
export type { FetchLike } from "./cookies.ts";

export interface FetchCodexModelsOptions {
  token: string;
  accountId: string;
  baseUrl?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchCodexModels(
  options: FetchCodexModelsOptions,
): Promise<import("./modes/types.ts").CodexModel[]> {
  const { CodexError, classifyHttpStatus, formatHttpErrorBody } = await import("./errors.ts");
  const { createTransport } = await import("./transport.ts");
  const {
    ERROR_BODY_LIMIT_BYTES,
    ERROR_BODY_TRUNCATION_MARKER,
    MODEL_CATALOG_LIMIT_BYTES,
    readBoundedResponseText,
  } = await import("./limits.ts");
  const transport = createTransport({
    token: options.token,
    accountId: options.accountId,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl as typeof fetch,
  });

  const endpoint = new URL(transport.resolveEndpoint("models"));
  endpoint.searchParams.set(
    "client_version",
    options.clientVersion ?? process.env.PI_CODEX_WEB_SEARCH_CLIENT_VERSION ?? "1.0.0",
  );

  const response = await transport.fetch(endpoint.toString(), {
    headers: transport.buildHeaders("application/json"),
    signal: options.signal,
  });

  if (!response.ok) {
    const status = response.status;
    const { text: rawError, truncated: errorTruncated } = await readBoundedResponseText(
      response,
      ERROR_BODY_LIMIT_BYTES,
    );
    const boundedError = errorTruncated
      ? rawError.slice(0, ERROR_BODY_LIMIT_BYTES - ERROR_BODY_TRUNCATION_MARKER.length) +
        ERROR_BODY_TRUNCATION_MARKER
      : rawError;
    const text = formatHttpErrorBody(boundedError, "responses");
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex models request failed: HTTP ${status}: ${text}`,
      status,
    );
  }

  const { text: catalogText, truncated } = await readBoundedResponseText(
    response,
    MODEL_CATALOG_LIMIT_BYTES,
  );
  if (truncated) {
    throw new CodexError(
      "transport",
      `Codex models response exceeded the ${MODEL_CATALOG_LIMIT_BYTES} char catalog ` +
        `budget. Cancelling the request; partial provider output is not returned as ` +
        `authoritative.`,
    );
  }
  const data = JSON.parse(catalogText) as {
    models?: Array<{
      slug?: string;
      id?: string;
      model?: string;
      display_name?: string;
      is_default?: boolean;
    }>;
  };
  return (data.models ?? [])
    .map((model) => ({
      id: model.slug ?? model.id ?? model.model ?? "",
      name: model.display_name,
      isDefault: model.is_default,
    }))
    .filter((model) => model.id.length > 0);
}

export function selectDefaultModel(
  models: import("./modes/types.ts").CodexModel[],
): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

export function extractAccountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}
