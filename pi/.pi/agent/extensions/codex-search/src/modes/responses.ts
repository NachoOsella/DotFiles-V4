import {
  CodexError,
  classifyEventErrorMessage,
  classifyHttpStatus,
  formatHttpErrorBody,
} from "../errors.ts";
import {
  ERROR_BODY_LIMIT_BYTES,
  ERROR_BODY_TRUNCATION_MARKER,
  MAX_REQUEST_BODY_BYTES,
  MAX_CITATIONS,
  MAX_SEARCH_CALLS,
  SEARCH_TEXT_LIMIT_BYTES,
  SSE_FRAME_LIMIT_BYTES,
  readBoundedResponseText,
} from "../limits.ts";
import type { CodexTransport } from "../transport.ts";
import type {
  CodexWebSearchResult,
  CodexCitation,
  CodexSearchCall,
  SearchContextSize,
} from "./types.ts";

export interface ResponsesSearchOptions {
  query: string;
  model: string;
  transport: CodexTransport;
  externalWebAccess: boolean;
  indexedWebAccess?: true;
  searchContextSize?: SearchContextSize;
  sessionId?: string;
  threadId?: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

interface SseEvent {
  type: string;
  data?: unknown;
  raw?: string;
}

interface ResponseOutputText {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface ResponseOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
  };
  content?: ResponseOutputText[];
}

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ResponseEnvelope {
  id?: string;
  status?: string;
  usage?: ResponseUsage;
  incomplete_details?: { reason?: string };
}

interface ResponseEventData {
  response?: ResponseEnvelope;
  item?: ResponseOutputItem;
  delta?: string;
  incomplete_details?: { reason?: string };
  error?: {
    message?: string;
    code?: string;
  };
}

function assertRequestBodySize(bodyText: string): void {
  if (bodyText.length > MAX_REQUEST_BODY_BYTES) {
    throw new CodexError(
      "schema",
      `Codex responses request body is ${bodyText.length} chars, exceeding the ` +
        `${MAX_REQUEST_BODY_BYTES} char pathological-size guard. Shorten the query ` +
        `before retrying. Request schemas are unchanged; this guard only rejects ` +
        `payloads that would risk unbounded upload/memory use.`,
    );
  }
}

function isRecognizedSseType(type: string): boolean {
  return type.startsWith("response.");
}

function textLimitError(additional: number, total: number): CodexError {
  return new CodexError(
    "transport",
    `Codex responses stream exceeded the ${SEARCH_TEXT_LIMIT_BYTES} char accumulated ` +
      `search-text budget (current ${total}, +${additional}). Cancelling the stream; ` +
      `partial provider output is not returned as authoritative.`,
  );
}

export async function runResponsesSearch(
  options: ResponsesSearchOptions,
): Promise<CodexWebSearchResult> {
  const {
    transport,
    query,
    model,
    externalWebAccess,
    indexedWebAccess,
    searchContextSize,
    sessionId,
    threadId,
    signal,
    onTextDelta,
  } = options;
  const headers = transport.buildHeaders("text/event-stream");
  if (sessionId) headers.set("session-id", sessionId);
  if (threadId) {
    headers.set("thread-id", threadId);
    headers.set("x-client-request-id", threadId);
  }

  const webSearchTool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: externalWebAccess,
    search_context_size: searchContextSize ?? "medium",
  };
  if (indexedWebAccess) webSearchTool.indexed_web_access = true;

  const bodyText = JSON.stringify({
    model,
    instructions:
      "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: query }],
      },
    ],
    tools: [webSearchTool],
    tool_choice: "required",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  });
  assertRequestBodySize(bodyText);

  const response = await transport.fetch(transport.resolveEndpoint("responses"), {
    method: "POST",
    headers,
    body: bodyText,
    signal,
  });

  if (!response.ok) {
    const status = response.status;
    const { text: rawError, truncated } = await readBoundedResponseText(
      response,
      ERROR_BODY_LIMIT_BYTES,
    );
    const boundedError = truncated
      ? rawError.slice(0, ERROR_BODY_LIMIT_BYTES - ERROR_BODY_TRUNCATION_MARKER.length) +
        ERROR_BODY_TRUNCATION_MARKER
      : rawError;
    const formatted = formatHttpErrorBody(boundedError, "responses");
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex responses request failed: HTTP ${status}: ${formatted}`,
      status,
    );
  }
  if (!response.body) {
    throw new Error("Codex responses response did not include a body");
  }

  let responseId: string | undefined;
  let usage: ResponseUsage | undefined;
  let streamedText = "";
  let totalTextLength = 0;
  const messageTextParts: string[] = [];
  const searchCalls = new Map<string, CodexSearchCall>();
  const citations = new Map<string, CodexCitation>();
  let completed = false;

  const accountForText = (additional: number): void => {
    if (additional <= 0) return;
    if (totalTextLength + additional > SEARCH_TEXT_LIMIT_BYTES) {
      throw textLimitError(additional, totalTextLength);
    }
    totalTextLength += additional;
  };

  for await (const event of parseSse(response.body, {
    frameLimit: SSE_FRAME_LIMIT_BYTES,
    signal,
  })) {
    if (signal?.aborted) {
      throw new DOMException("Codex responses request was aborted", "AbortError");
    }
    const data = event.data as ResponseEventData | undefined;
    if (!data) {
      if (event.raw !== undefined && isRecognizedSseType(event.type)) {
        throw new CodexError(
          "schema",
          `Codex responses stream contained a malformed ${event.type || "(unknown)"} frame ` +
            `that could not be parsed as JSON. Cancelling the stream.`,
        );
      }
      continue;
    }

    if (event.type === "response.created") {
      const id = data.response?.id;
      if (typeof id === "string" && id.length > 0) responseId = id;
      continue;
    }

    if (event.type === "response.output_text.delta") {
      const delta = data.delta ?? "";
      if (delta.length > 0) {
        accountForText(delta.length);
        streamedText += delta;
        onTextDelta?.(delta);
      }
      continue;
    }

    if (event.type === "response.output_item.added" && data.item?.type === "web_search_call") {
      const item = data.item;
      if (item.id && searchCalls.size < MAX_SEARCH_CALLS && !searchCalls.has(item.id)) {
        searchCalls.set(item.id, {
          id: item.id,
          status: item.status,
        });
      }
      continue;
    }

    if (event.type === "response.output_item.done") {
      collectOutputItem(data.item, searchCalls, messageTextParts, citations, accountForText);
      continue;
    }

    if (event.type === "response.completed") {
      completed = true;
      const envelopeId = data.response?.id;
      if (typeof envelopeId === "string" && envelopeId.length > 0 && !responseId) {
        responseId = envelopeId;
      }
      if (data.response?.usage) usage = data.response.usage;
      continue;
    }

    if (event.type === "response.incomplete") {
      const reason =
        data.response?.incomplete_details?.reason ??
        data.incomplete_details?.reason ??
        data.response?.status ??
        "unknown reason";
      throw new CodexError(
        "transport",
        `Codex responses stream ended incomplete: ${reason}. Partial provider ` +
          `output is not returned as authoritative.`,
      );
    }

    if (event.type === "response.failed") {
      const message = data.error?.message ?? data.error?.code ?? "Codex web search failed";
      throw new CodexError(classifyEventErrorMessage(message), message);
    }

    // Unknown valid event types are ignored for forward compatibility.
  }

  if (!completed) {
    throw new CodexError(
      "transport",
      "Codex responses stream ended without response.completed. The connection " +
        "may have been truncated; partial provider output is not returned as authoritative.",
    );
  }

  return {
    responseId,
    model,
    text: messageTextParts.join("") || streamedText,
    searchCalls: [...searchCalls.values()],
    citations: [...citations.values()],
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
  };
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  opts?: { frameLimit?: number; signal?: AbortSignal },
): AsyncGenerator<SseEvent> {
  const frameLimit = opts?.frameLimit ?? SSE_FRAME_LIMIT_BYTES;
  const signal = opts?.signal;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let abortListener: (() => void) | undefined;

  if (signal) {
    if (signal.aborted) {
      reader.releaseLock();
      throw new DOMException("Codex responses request was aborted", "AbortError");
    }
    abortListener = () => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abortListener, { once: true });
  }

  let doneReading = false;
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Codex responses request was aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = findSseSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        if (frame.length > frameLimit) {
          throw new CodexError(
            "transport",
            `Codex SSE frame exceeded the ${frameLimit} char single-frame budget ` +
              `before a delimiter arrived. Cancelling the stream.`,
          );
        }
        buffer = buffer.slice(separator.index + separator.length);
        const event = parseSseFrame(frame);
        if (event) yield event;
        separator = findSseSeparator(buffer);
      }
      if (buffer.length > frameLimit) {
        throw new CodexError(
          "transport",
          `Codex SSE frame exceeded the ${frameLimit} char single-frame budget ` +
            `before a delimiter arrived. Cancelling the stream.`,
        );
      }
    }
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    if (!doneReading) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  buffer += decoder.decode();
  if (buffer.trim().length === 0) return;
  if (buffer.length > frameLimit) {
    throw new CodexError(
      "transport",
      `Codex SSE frame exceeded the ${frameLimit} char single-frame budget ` +
        `before a delimiter arrived. Cancelling the stream.`,
    );
  }
  const event = parseSseFrame(buffer);
  if (event) yield event;
}

function findSseSeparator(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function parseSseFrame(frame: string): SseEvent | undefined {
  const lines = frame.split(/\r?\n/);
  let type = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return undefined;

  try {
    return { type, data: JSON.parse(raw) };
  } catch {
    return { type, raw };
  }
}

function collectOutputItem(
  item: ResponseOutputItem | undefined,
  searchCalls: Map<string, CodexSearchCall>,
  messageTextParts: string[],
  citations: Map<string, CodexCitation>,
  accountForText: (additional: number) => void,
): void {
  if (!item) return;

  if (item.type === "web_search_call") {
    if (searchCalls.size >= MAX_SEARCH_CALLS) return;
    const key = item.id ?? `search-${searchCalls.size + 1}`;
    if (searchCalls.has(key)) return;
    const query = item.action?.query ?? item.action?.queries?.join(", ");
    searchCalls.set(key, {
      id: item.id,
      status: item.status,
      query,
      url: item.action?.url,
      actionType: item.action?.type,
    });
    return;
  }

  if (item.type !== "message" || item.role !== "assistant") return;

  for (const part of item.content ?? []) {
    if (part.type !== "output_text") continue;
    const text = part.text ?? "";
    if (text.length > 0) {
      accountForText(text.length);
      messageTextParts.push(text);
    }
    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== "url_citation" || !annotation.url) continue;
      if (citations.size >= MAX_CITATIONS) break;
      if (citations.has(annotation.url)) continue;
      citations.set(annotation.url, {
        title: annotation.title,
        url: annotation.url,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index,
      });
    }
  }
}
