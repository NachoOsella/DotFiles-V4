/**
 * Dashboard projection for GUI hosts (pi-desk).
 *
 * Pure: turns manager snapshots into the metadata-only shape published on
 * BACKGROUND_TERMINALS_CHANNEL. Output text is deliberately left out; hosts
 * tail `spillPath` for live output, so a chatty process never floods the
 * event bus.
 */
import type {
  BackgroundTerminalInfo,
  BackgroundTerminalsState,
} from "../../shared/dashboard-state.ts";
import type { OutputView, TerminalSnapshot } from "./domain.ts";

function streamInfo(view: OutputView) {
  return {
    totalBytes: view.totalBytes,
    truncatedBytes: view.truncatedBytes,
    ...(view.spillPath ? { spillPath: view.spillPath } : {}),
  };
}

export function toTerminalInfo(snap: TerminalSnapshot): BackgroundTerminalInfo {
  return {
    id: snap.id,
    title: snap.title,
    command: snap.command,
    cwd: snap.cwd,
    ...(snap.pid !== undefined ? { pid: snap.pid } : {}),
    status: snap.status,
    createdAt: snap.createdAt,
    ...(snap.settledAt !== undefined ? { settledAt: snap.settledAt } : {}),
    ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
    ...(snap.signal !== undefined ? { signal: snap.signal } : {}),
    ...(snap.errorText !== undefined ? { errorText: snap.errorText } : {}),
    stdout: streamInfo(snap.stdout),
    stderr: streamInfo(snap.stderr),
  };
}

export function toBackgroundTerminalsState(
  snaps: ReadonlyArray<TerminalSnapshot>,
): BackgroundTerminalsState {
  return {
    running: snaps.filter((snap) => snap.status === "running").length,
    terminals: snaps.map(toTerminalInfo),
  };
}

/**
 * Coalesces bursts of manager notifications into at most one publish per
 * `intervalMs`, and skips publishes whose payload did not change.
 */
export function createThrottledPublisher(
  publish: (state: BackgroundTerminalsState) => void,
  intervalMs = 250,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
) {
  let pending: (() => ReadonlyArray<TerminalSnapshot>) | undefined;
  let timer: unknown;
  let last = "";
  const flush = () => {
    timer = undefined;
    const read = pending;
    pending = undefined;
    if (!read) return;
    const state = toBackgroundTerminalsState(read());
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    publish(state);
  };
  return {
    request(read: () => ReadonlyArray<TerminalSnapshot>) {
      pending = read;
      if (timer === undefined) timer = schedule(flush, intervalMs);
    },
    /** Publish now, even if unchanged (used on dashboard refresh). */
    force(read: () => ReadonlyArray<TerminalSnapshot>) {
      last = "";
      pending = read;
      flush();
    },
  };
}
