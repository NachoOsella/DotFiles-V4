/** Shared types for prompt-inspector extension. */

export interface ToolInfo {
  name: string;
  description: string;
  promptSnippet?: string;
}

export interface PromptBreakdown {
  totalChars: number;
  totalTokens: number;
  baseChars: number;
  baseTokens: number;
  appendChars: number;
  appendTokens: number;
  contextFilesChars: number;
  contextFilesTokens: number;
  skillsChars: number;
  skillsTokens: number;
  cwdChars: number;
  cwdTokens: number;
}

export interface InspectionReport {
  cwd: string;
  model: {
    provider?: string;
    id?: string;
    name?: string;
    contextWindow: number;
    thinkingLevel?: string;
  } | undefined;
  systemPrompt: string;
  breakdown: PromptBreakdown;
  tools: ToolInfo[];
  toolsJsonChars: number;
  toolsTokens: number;
  skills: Array<{ name: string; description: string; location: string }>;
  contextFiles: Array<{ path: string; chars: number; tokens: number }>;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
  messageCount: number;
  messagesTokens: number;
  totalEstimatedTokens: number;
  promptChars: number;
  promptTokens: number;
}

export interface SaveResult {
  path: string;
  chars: number;
  tokens: number;
}
