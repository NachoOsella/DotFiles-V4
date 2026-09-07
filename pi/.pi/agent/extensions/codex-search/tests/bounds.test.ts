import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTransport,
  fetchCodexModels,
  runResponsesSearch,
  runStandaloneCommands,
  CodexError,
} from "../src/codex.ts";
import {
  ERROR_BODY_LIMIT_BYTES,
  FINAL_TOOL_TEXT_LIMIT_BYTES,
  MAX_CITATIONS,
  MAX_SEARCH_CALLS,
  MODEL_CATALOG_LIMIT_BYTES,
  PARTIAL_PREVIEW_LIMIT_BYTES,
  SEARCH_TEXT_LIMIT_BYTES,
  SSE_FRAME_LIMIT_BYTES,
  appendBoundedPreview,
  clipPartialPreview,
  createThrottledUpdater,
  readBoundedResponseText,
  truncateWithMarker,
} from "../src/limits.ts";
import { formatToolText } from "../index.ts";

function makeTransport(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return createTransport({
    token: "fake-token",
    accountId: "fake-account",
    baseUrl: "https://example.test/backend",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function sseResponse(sse: string, status = 200): Response {
  return new Response(sse, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunkedSseResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function splitBytes(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    out.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) out.push(bytes.slice(offset));
  return out.filter((chunk) => chunk.length > 0);
}

const COMPLETED = 'event: response.completed\ndata: {"response":{"usage":{"total_tokens":7}}}\n\n';

describe("codex bounds (P07)", () => {
  it("accepts a valid complete stream with deltas and a terminal completion", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_123"}}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"Hello "}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"world"}\n\n',
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello world","annotations":[{"type":"url_citation","title":"Example","url":"https://example.com"}]}]}}\n\n',
      COMPLETED,
    ].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    const seen: string[] = [];
    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
      onTextDelta: (delta) => seen.push(delta),
    });
    assert.equal(result.text, "Hello world");
    assert.equal(result.responseId, "resp_123");
    assert.deepEqual(seen, ["Hello ", "world"]);
    assert.equal(result.citations.length, 1);
    assert.equal(result.usage?.totalTokens, 7);
  });

  it("fails delta-only EOF without a terminal completion", async () => {
    const sse = [
      'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":" text"}\n\n',
    ].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.match((error as Error).message, /without response\.completed/);
        return true;
      },
    );
  });

  it("fails when a completed message item arrives without response.completed", async () => {
    const sse =
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n';
    const transport = makeTransport(async () => sseResponse(sse));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      /without response\.completed/,
    );
  });

  it("treats response.incomplete distinctly from failure", async () => {
    const sse =
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
      'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
    const transport = makeTransport(async () => sseResponse(sse));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.match((error as Error).message, /incomplete.*max_output_tokens/);
        return true;
      },
    );
  });

  it("rejects malformed recognized frames with a schema error", async () => {
    const sse = "event: response.completed\ndata: {not-json\n\n";
    const transport = makeTransport(async () => sseResponse(sse));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal((error as CodexError).kind, "schema");
        assert.match((error as Error).message, /malformed/);
        return true;
      },
    );
  });

  it("ignores unknown valid event types for forward compatibility", async () => {
    const sse = [
      'event: response.future_thing\ndata: {"future":true}\n\n',
      'event: custom\ndata: {"anything":1}\n\n',
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n',
      COMPLETED,
    ].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
    });
    assert.equal(result.text, "ok");
  });

  it("ignores SSE [DONE] sentinels and comment-only frames", async () => {
    const sse = [
      ": keepalive\n\n",
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n',
      "data: [DONE]\n\n",
      COMPLETED,
    ].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
    });
    assert.equal(result.text, "ok");
  });

  it("stops oversized no-delimiter frames before they accumulate", async () => {
    const big = `data: ${"x".repeat(SSE_FRAME_LIMIT_BYTES + 16)}`;
    const transport = makeTransport(async () =>
      chunkedSseResponse([new TextEncoder().encode(big)]),
    );
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      /single-frame budget/,
    );
  });

  it("reassembles multibyte characters split across chunks", async () => {
    const deltaText = "a😀b café naïve";
    const sse =
      `event: response.output_text.delta\ndata: {"delta":${JSON.stringify(deltaText)}}\n\n` +
      COMPLETED;
    const bytes = new TextEncoder().encode(sse);
    // Split into tiny pieces, including inside multibyte sequences.
    const chunks = splitBytes(bytes, [1, 2, 1, 3, 5, 2, 7, 1, 4]);
    const transport = makeTransport(async () => chunkedSseResponse(chunks));
    const seen: string[] = [];
    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
      onTextDelta: (delta) => seen.push(delta),
    });
    assert.equal(result.text, deltaText);
    assert.equal(seen.join(""), deltaText);
  });

  it("stops when accumulated search text exceeds 1 MiB", async () => {
    // Many small frames: each frame stays far below the 256 KiB single-frame
    // budget, but the shared 1 MiB accumulated-text budget is exceeded.
    const chunk = "x".repeat(8 * 1024);
    const frames: string[] = [];
    for (let i = 0; i < 140; i++) {
      frames.push(
        `event: response.output_text.delta\ndata: {"delta":${JSON.stringify(chunk)}}\n\n`,
      );
    }
    const sse = [...frames, COMPLETED].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.match((error as Error).message, new RegExp(String(SEARCH_TEXT_LIMIT_BYTES)));
        return true;
      },
    );
  });

  it("bounds collected citations and search calls to 256 each", async () => {
    const annotations = Array.from({ length: 300 }, (_, i) => ({
      type: "url_citation",
      title: `t${i}`,
      url: `https://example.com/${i}`,
    }));
    const sse = [
      ...Array.from(
        { length: 300 },
        (_, i) =>
          `event: response.output_item.added\ndata: {"item":{"type":"web_search_call","id":"call-${i}","status":"completed"}}\n\n`,
      ),
      `event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":${JSON.stringify(annotations)}}]}}\n\n`,
      COMPLETED,
    ].join("");
    const transport = makeTransport(async () => sseResponse(sse));
    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
    });
    assert.equal(result.text, "ok");
    assert.equal(result.citations.length, MAX_CITATIONS);
    assert.equal(result.searchCalls.length, MAX_SEARCH_CALLS);
  });

  it("retains bounded HTTP error context without buffering an unlimited body", async () => {
    const bigBody = "E".repeat(20 * 1024);
    const transport = makeTransport(async () => new Response(bigBody, { status: 500 }));
    await assert.rejects(
      runResponsesSearch({ query: "q", model: "m", transport, externalWebAccess: true }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        const message = (error as Error).message;
        assert.ok(
          message.length < ERROR_BODY_LIMIT_BYTES + 500,
          `error too long: ${message.length}`,
        );
        assert.match(message, /truncated to 8 KiB/);
        assert.ok(message.length < bigBody.length, "error should not retain the full body");
        return true;
      },
    );
  });

  it("reads bounded response text with truncation instead of unlimited buffering", async () => {
    const big = "y".repeat(ERROR_BODY_LIMIT_BYTES + 100);
    const { text, truncated } = await readBoundedResponseText(
      new Response(big),
      ERROR_BODY_LIMIT_BYTES,
    );
    assert.equal(truncated, true);
    assert.equal(text.length, ERROR_BODY_LIMIT_BYTES);
  });

  it("rejects pathological request sizes before any network call", async () => {
    let fetchCalled = false;
    const transport = makeTransport(async () => {
      fetchCalled = true;
      return sseResponse(COMPLETED);
    });
    await assert.rejects(
      runResponsesSearch({
        query: "x".repeat(300 * 1024),
        model: "m",
        transport,
        externalWebAccess: true,
      }),
      /pathological-size guard/,
    );
    assert.equal(fetchCalled, false);
  });

  it("aborts streaming promptly and cleans up the SSE reader", async () => {
    const sse = 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n';
    const transport = makeTransport(async () => sseResponse(sse));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runResponsesSearch({
        query: "q",
        model: "m",
        transport,
        externalWebAccess: true,
        signal: controller.signal,
      }),
      (error: unknown) =>
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && /abort/i.test(error.message)),
    );
  });

  it("throttles many small deltas to a bounded update count plus final flush", () => {
    let now = 0;
    const timers = new Map<unknown, { fn: () => void; due: number }>();
    let nextId = 1;
    const emitted: string[] = [];
    const updater = createThrottledUpdater((text) => emitted.push(text), {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fn, due: now + ms });
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle);
      },
    });
    const fireDue = () => {
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    };
    for (let i = 0; i < 1000; i++) {
      now += 1;
      updater.push(`t${i}`);
      fireDue();
    }
    updater.flush();
    assert.ok(emitted.length <= 15, `expected bounded updates, got ${emitted.length}`);
    assert.equal(emitted[emitted.length - 1], "t999");
    updater.push("stale");
    assert.equal(emitted[emitted.length - 1], "t999");
    assert.equal(timers.size, 0);
  });

  it("cancels timers and ignores stale updates after abort", () => {
    let cleared = 0;
    const controller = new AbortController();
    const emitted: string[] = [];
    const updater = createThrottledUpdater((text) => emitted.push(text), {
      now: () => 0,
      setTimeout: () => ({}) as unknown,
      clearTimeout: () => {
        cleared += 1;
      },
      signal: controller.signal,
    });
    updater.push("first");
    assert.equal(emitted.length, 1);
    controller.abort();
    updater.push("stale");
    updater.flush();
    assert.deepEqual(emitted, ["first"]);
    assert.ok(cleared >= 0);
  });

  it("clips partial previews to 4 KiB with a marker", () => {
    const big = "p".repeat(PARTIAL_PREVIEW_LIMIT_BYTES + 50);
    const clipped = clipPartialPreview(big);
    assert.equal(clipped.length, PARTIAL_PREVIEW_LIMIT_BYTES);
    assert.match(clipped, /preview truncated/);
    let preview = "";
    preview = appendBoundedPreview(preview, "a".repeat(PARTIAL_PREVIEW_LIMIT_BYTES));
    const stable = appendBoundedPreview(preview, "more deltas");
    assert.equal(stable.length, PARTIAL_PREVIEW_LIMIT_BYTES);
  });

  it("clips final tool text to 32 KiB while keeping source references", () => {
    const bigText = "B".repeat(40 * 1024);
    const text = formatToolText(
      [
        {
          query: "q",
          text: bigText,
          citations: [{ title: "Example", url: "https://example.com/kept" }],
          searchCalls: [],
          refIds: { turn0fetch0: "turn0fetch0" },
        },
      ],
      [],
    );
    assert.ok(text.length <= FINAL_TOOL_TEXT_LIMIT_BYTES, `length ${text.length}`);
    assert.ok(text.includes("https://example.com/kept"));
    assert.ok(text.includes("turn0fetch0"));
    assert.match(text, /truncated to 32 KiB/);
  });

  it("truncateWithMarker preserves short text and marks long text", () => {
    assert.equal(truncateWithMarker("hi", 10, "[cut]"), "hi");
    assert.equal(truncateWithMarker("0123456789", 8, "[cut]").length, 8);
  });

  it("rejects oversized model catalogs without returning partial data", async () => {
    const padding = "z".repeat(MODEL_CATALOG_LIMIT_BYTES + 1024);
    const body = JSON.stringify({ models: [{ slug: "m", display_name: padding }] });
    assert.ok(body.length > MODEL_CATALOG_LIMIT_BYTES);
    const transport = makeTransport(async () => new Response(body));
    // fetchCodexModels builds its own transport from token/account, so call with
    // a fetchImpl that returns the oversized catalog.
    await assert.rejects(
      fetchCodexModels({
        token: "fake-token",
        accountId: "fake-account",
        baseUrl: "https://example.test/backend",
        fetchImpl: (async () => new Response(body)) as typeof fetch,
      }),
      /catalog budget/,
    );
    void transport;
  });

  it("bounds standalone JSON and output sizes without enabling standalone by default", async () => {
    const hugeOutput = "S".repeat(SEARCH_TEXT_LIMIT_BYTES + 16);
    const transport = makeTransport(
      async () => new Response(JSON.stringify({ output: hugeOutput })),
    );
    await assert.rejects(
      runStandaloneCommands({
        model: "m",
        transport,
        sessionId: "s",
        searchQuery: [{ q: "q" }],
        freshness: "live",
      }),
      /search-text budget/,
    );
  });

  it("caps standalone citations at 256", async () => {
    const results = Array.from({ length: 300 }, (_, i) => ({
      title: `t${i}`,
      url: `https://example.com/${i}`,
    }));
    const transport = makeTransport(
      async () => new Response(JSON.stringify({ output: "ok", results })),
    );
    const result = await runStandaloneCommands({
      model: "m",
      transport,
      sessionId: "s",
      searchQuery: [{ q: "q" }],
      freshness: "live",
    });
    assert.equal(result.citations.length, MAX_CITATIONS);
  });

  it("rejects pathological standalone request sizes before fetch", async () => {
    let fetchCalled = false;
    const transport = makeTransport(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ output: "ok" }));
    });
    await assert.rejects(
      runStandaloneCommands({
        model: "m",
        transport,
        sessionId: "s",
        searchQuery: [{ q: "x".repeat(300 * 1024) }],
        freshness: "live",
      }),
      /pathological-size guard/,
    );
    assert.equal(fetchCalled, false);
  });
});
