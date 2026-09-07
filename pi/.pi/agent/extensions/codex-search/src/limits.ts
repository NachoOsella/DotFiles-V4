/**
 * Defensive budgets for Codex response handling (P07).
 *
 * All limits apply *before* unbounded strings, SSE frames, collections, or
 * response bodies accumulate. A final display truncation alone does not bound
 * memory, so callers must enforce these while reading/parsing.
 *
 * Budgets (named constants, covered by tests):
 * - Single Responses SSE frame buffer: 256 KiB. Enforced while reading
 *   chunks, before a `\n\n` delimiter arrives.
 * - Total accumulated search text (streamed deltas + completed message parts,
 *   shared budget): 1 MiB. Exceeding stops the stream with a precise error;
 *   partial provider output is never returned as authoritative.
 * - Error body retained: 8 KiB. Read via a bounded stream reader so an
 *   unlimited body is never buffered first.
 * - Model-facing final tool text: 32 KiB. Applied when formatting tool
 *   output; source references are preserved first and an explicit truncation
 *   marker notes that complete content remains in result details.
 * - Model-facing partial preview: 4 KiB. Streaming `onUpdate` previews never
 *   exceed this per emission.
 * - Partial update cadence: at most once per 100 ms, plus a final flush.
 *   Implemented by `createThrottledUpdater` with an injectable clock/timer
 *   for deterministic tests.
 * - Collected citations / search-call records: 256 each. Extras are ignored
 *   once the cap is reached so maps stay bounded.
 * - Fetched model catalog / standalone JSON response: 2 MiB. Exceeding stops
 *   with a precise error before `JSON.parse`.
 * - Outbound request body: 256 KiB. Pathological request sizes are rejected
 *   with a schema error before any network call. Tool schemas are unchanged;
 *   this is a runtime guard only.
 */

export const SSE_FRAME_LIMIT_BYTES = 256 * 1024;
export const SEARCH_TEXT_LIMIT_BYTES = 1024 * 1024;
export const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
export const FINAL_TOOL_TEXT_LIMIT_BYTES = 32 * 1024;
export const PARTIAL_PREVIEW_LIMIT_BYTES = 4 * 1024;
export const PARTIAL_UPDATE_INTERVAL_MS = 100;
export const MAX_CITATIONS = 256;
export const MAX_SEARCH_CALLS = 256;
export const MODEL_CATALOG_LIMIT_BYTES = 2 * 1024 * 1024;
export const STANDALONE_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export const ERROR_BODY_TRUNCATION_MARKER = "\n[…truncated to 8 KiB…]";
export const FINAL_TOOL_TRUNCATION_MARKER =
  "\n\n[output truncated to 32 KiB; full results retained in details]";
export const PARTIAL_PREVIEW_TRUNCATION_MARKER = "…[preview truncated to 4 KiB]";
export const TEXT_LIMIT_TRUNCATION_MARKER = "…[truncated]";

/**
 * Truncate text to `limit` characters, reserving space for `marker`.
 * Returns the original text when it already fits.
 */
export function truncateWithMarker(text: string, limit: number, marker: string): string {
  if (text.length <= limit) return text;
  if (limit <= marker.length) return marker.slice(0, limit);
  return text.slice(0, limit - marker.length) + marker;
}

/** Clip a streaming preview to the 4 KiB model-facing budget. */
export function clipPartialPreview(text: string): string {
  return truncateWithMarker(text, PARTIAL_PREVIEW_LIMIT_BYTES, PARTIAL_PREVIEW_TRUNCATION_MARKER);
}

/**
 * Append a delta to a preview buffer without letting the buffer grow past
 * the 4 KiB budget. Once truncated, later deltas keep the truncated prefix
 * stable instead of accumulating an unbounded copy.
 */
export function appendBoundedPreview(current: string, delta: string): string {
  if (delta.length === 0) return current;
  if (current.endsWith(PARTIAL_PREVIEW_TRUNCATION_MARKER)) return current;
  const combined = current + delta;
  return clipPartialPreview(combined);
}

export interface ThrottledUpdaterOptions {
  intervalMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  signal?: AbortSignal;
}

export interface ThrottledUpdater {
  push(text: string): void;
  flush(): void;
  dispose(): void;
  readonly hasPending: boolean;
}

/**
 * Coalesce high-frequency preview updates to at most one emission per
 * `intervalMs`, plus an explicit final `flush()`.
 *
 * - The first `push` emits immediately; later pushes within the interval are
 *   coalesced into a single timer.
 * - `flush()` emits any pending preview and settles the updater; later
 *   `push` calls are ignored so no stale update follows completion.
 * - `dispose()` drops pending text and settles without emitting.
 * - Both settle paths clear any timer and remove the abort listener, so no
 *   timer or listener survives abort/failure/completion.
 */
export function createThrottledUpdater(
  emit: (text: string) => void,
  options: ThrottledUpdaterOptions = {},
): ThrottledUpdater {
  const intervalMs = options.intervalMs ?? PARTIAL_UPDATE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as never));
  const signal = options.signal;

  let pending: string | undefined;
  let timer: unknown;
  let settled = false;
  let lastEmit = Number.NEGATIVE_INFINITY;
  let abortListener: (() => void) | undefined;

  const clearTimerSafe = (): void => {
    if (timer !== undefined) {
      try {
        clearTimer(timer);
      } catch {
        // Ignore timer cleanup failures; settling must still proceed.
      }
      timer = undefined;
    }
  };

  const removeAbortListener = (): void => {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  const settle = (): void => {
    settled = true;
    clearTimerSafe();
    removeAbortListener();
  };

  if (signal) {
    if (signal.aborted) {
      settled = true;
    } else {
      abortListener = () => {
        pending = undefined;
        settle();
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  const emitNow = (text: string): void => {
    emit(text);
    lastEmit = now();
  };

  return {
    get hasPending(): boolean {
      return pending !== undefined;
    },

    push(text: string): void {
      if (settled || signal?.aborted) return;
      pending = text;
      const elapsed = now() - lastEmit;
      if (elapsed >= intervalMs) {
        clearTimerSafe();
        const next = pending;
        pending = undefined;
        emitNow(next);
        return;
      }
      if (timer !== undefined) return;
      const delay = intervalMs - elapsed;
      timer = setTimer(() => {
        timer = undefined;
        if (settled || signal?.aborted) {
          pending = undefined;
          return;
        }
        if (pending === undefined) return;
        const next = pending;
        pending = undefined;
        emitNow(next);
      }, delay);
    },

    flush(): void {
      if (settled || signal?.aborted) {
        pending = undefined;
        settle();
        return;
      }
      clearTimerSafe();
      if (pending !== undefined) {
        const next = pending;
        pending = undefined;
        emitNow(next);
      }
      settle();
    },

    dispose(): void {
      pending = undefined;
      settle();
    },
  };
}

/**
 * Read a fetch Response body as text without buffering an unlimited body
 * first. Returns the retained prefix plus whether the body was longer than
 * `limit`. Callers decide policy: error bodies truncate; JSON payloads treat
 * `truncated === true` as a precise limit error instead of parsing partial
 * data as authoritative.
 */
export async function readBoundedResponseText(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const full = await response.text();
    if (full.length > limit) return { text: full.slice(0, limit), truncated: true };
    return { text: full, truncated: false };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  let doneReading = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
    else {
      // Drain decoder state without retaining more output.
      decoder.decode();
    }
  } finally {
    if (!doneReading || truncated) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  if (text.length > limit) return { text: text.slice(0, limit), truncated: true };
  return { text, truncated };
}
