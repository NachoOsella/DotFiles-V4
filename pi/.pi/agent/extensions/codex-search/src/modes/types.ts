export type SearchContextSize = "low" | "medium" | "high";
export type Freshness = "live" | "cached" | "indexed";
export type StandaloneExternalWebAccess = boolean | "indexed";
export type ResponseLength = "short" | "medium" | "long";

export interface CodexCitation {
  title?: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface CodexSearchCall {
  id?: string;
  status?: string;
  query?: string;
  url?: string;
  actionType?: string;
  refId?: string;
}

export interface CodexWebSearchResult {
  responseId?: string;
  model: string;
  text: string;
  searchCalls: CodexSearchCall[];
  citations: CodexCitation[];
  refIds?: Record<string, string>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  encryptedOutput?: string;
  results?: unknown[];
}

export interface CodexModel {
  id: string;
  name?: string;
  isDefault?: boolean;
}
