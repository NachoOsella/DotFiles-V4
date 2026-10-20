import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { extractAccountIdFromToken } from "./codex.ts";

export const OPENAI_PROVIDER = "openai";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export type OpenAIAuthProvider = typeof OPENAI_PROVIDER | typeof OPENAI_CODEX_PROVIDER;

const OPENAI_AUTH_PROVIDERS: readonly OpenAIAuthProvider[] = [
  OPENAI_PROVIDER,
  OPENAI_CODEX_PROVIDER,
];

interface StoredCredential {
  type?: unknown;
  accountId?: unknown;
}

interface LegacyModelRegistry {
  authStorage?: {
    get(provider: string): StoredCredential | undefined;
  };
}

export interface AuthModelRegistry extends LegacyModelRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface ResolvedPiAuth {
  provider: OpenAIAuthProvider;
  token: string;
  accountId?: string;
}

export type StoredCredentialReader = (provider: string) => StoredCredential | undefined;

function getPublicCredentialReader(): StoredCredentialReader | undefined {
  return (piCodingAgent as { readStoredCredential?: StoredCredentialReader }).readStoredCredential;
}

export function isOpenAIAuthProvider(value: unknown): value is OpenAIAuthProvider {
  return value === OPENAI_PROVIDER || value === OPENAI_CODEX_PROVIDER;
}

function readCredential(
  provider: OpenAIAuthProvider,
  modelRegistry: LegacyModelRegistry,
  readStoredCredential: StoredCredentialReader | null,
): StoredCredential | undefined {
  return readStoredCredential
    ? readStoredCredential(provider)
    : modelRegistry.authStorage?.get(provider);
}

export function resolveCodexAccountId(
  token: string,
  modelRegistry: object,
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): string | undefined {
  const credential = readCredential(
    OPENAI_CODEX_PROVIDER,
    modelRegistry as LegacyModelRegistry,
    readStoredCredential,
  );
  if (credential?.type === "oauth" && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) return accountId;
  }
  return extractAccountIdFromToken(token);
}

function providerOrder(
  currentProvider: string | undefined,
  hasOfficialLogin: boolean,
  hasLegacyLogin: boolean,
): OpenAIAuthProvider[] {
  const ordered: OpenAIAuthProvider[] = [];
  const add = (provider: OpenAIAuthProvider) => {
    if (!ordered.includes(provider)) ordered.push(provider);
  };

  if (isOpenAIAuthProvider(currentProvider)) add(currentProvider);
  if (hasOfficialLogin) add(OPENAI_PROVIDER);
  if (hasLegacyLogin) add(OPENAI_CODEX_PROVIDER);
  for (const provider of OPENAI_AUTH_PROVIDERS) add(provider);
  return ordered;
}

/**
 * Resolve the best available OpenAI subscription credential.
 *
 * The official Pi login (`openai`) wins over the legacy Codex login
 * (`openai-codex`) unless the active model already uses one of them. An
 * `OPENAI_API_KEY` does not shadow a stored Codex OAuth login.
 */
export async function resolvePiAuth(
  modelRegistry: AuthModelRegistry,
  currentProvider?: string,
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): Promise<ResolvedPiAuth | undefined> {
  const hasOfficialLogin =
    readCredential(OPENAI_PROVIDER, modelRegistry, readStoredCredential)?.type === "oauth";
  const hasLegacyLogin =
    readCredential(OPENAI_CODEX_PROVIDER, modelRegistry, readStoredCredential)?.type === "oauth";
  for (const provider of providerOrder(currentProvider, hasOfficialLogin, hasLegacyLogin)) {
    let token: string | undefined;
    try {
      token = await modelRegistry.getApiKeyForProvider(provider);
    } catch {
      continue;
    }
    if (!token) continue;

    if (provider === OPENAI_CODEX_PROVIDER) {
      const accountId = resolveCodexAccountId(token, modelRegistry, readStoredCredential);
      return accountId ? { provider, token, accountId } : { provider, token };
    }
    return { provider, token };
  }
  return undefined;
}
