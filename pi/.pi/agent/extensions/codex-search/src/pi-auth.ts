import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { extractAccountIdFromToken } from "./codex.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";

interface StoredCredential {
  type?: unknown;
  accountId?: unknown;
}

interface LegacyModelRegistry {
  authStorage?: {
    get(provider: string): StoredCredential | undefined;
  };
}

export type StoredCredentialReader = (provider: string) => StoredCredential | undefined;

function getPublicCredentialReader(): StoredCredentialReader | undefined {
  return (piCodingAgent as { readStoredCredential?: StoredCredentialReader }).readStoredCredential;
}

export function resolveCodexAccountId(
  token: string,
  modelRegistry: object,
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): string | undefined {
  const credential = readStoredCredential
    ? readStoredCredential(OPENAI_CODEX_PROVIDER)
    : (modelRegistry as LegacyModelRegistry).authStorage?.get(OPENAI_CODEX_PROVIDER);
  if (credential?.type === "oauth" && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) return accountId;
  }
  return extractAccountIdFromToken(token);
}
