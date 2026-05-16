import { homedir } from "node:os";
import { join } from "node:path";

/** SQLite executable used by the memory extension. */
export const SQLITE_BIN = process.env.PI_MEMORY_SQLITE_BIN ?? "sqlite3";

/** SQLite database path for persistent memory. */
export const DB_PATH = process.env.PI_MEMORY_DB ?? join(homedir(), ".pi", "agent", "memory", "pi-memory.db");

/** Whether matching memories are injected before agent turns. */
export const AUTO_RECALL = process.env.PI_MEMORY_AUTO_RECALL !== "0";

/** Whether explicit durable user preferences are auto-captured. */
export const AUTO_CAPTURE = process.env.PI_MEMORY_AUTO_CAPTURE !== "0";

/** Maximum character budget for injected memory recall. */
export const MAX_RECALL_CHARS = Number(process.env.PI_MEMORY_MAX_RECALL_CHARS ?? "1000");

/** Maximum number of memories injected before a turn. */
export const MAX_RECALL_ITEMS = Math.max(1, Math.min(Number(process.env.PI_MEMORY_MAX_RECALL_ITEMS ?? "5"), 10));

/** Timeout for sqlite subprocess execution. */
export const SQLITE_TIMEOUT_MS = Number(process.env.PI_MEMORY_SQLITE_TIMEOUT_MS ?? "8000");

/** Busy timeout configured inside SQLite. */
export const SQLITE_BUSY_TIMEOUT_MS = Number(
  process.env.PI_MEMORY_SQLITE_BUSY_TIMEOUT_MS ?? String(Math.max(1000, SQLITE_TIMEOUT_MS - 1000)),
);

/** Observation types accepted by mem_save and import. */
export const VALID_TYPES = ["architecture", "bugfix", "config", "decision", "discovery", "learning", "preference"] as const;

/** Synthetic project name used for global personal memories. */
export const PERSONAL_PROJECT = "__personal__";

/** Status values accepted by memory metadata. */
export const ACTIVE_STATUSES = new Set(["active", "unverified", "stale", "superseded"]);

/** Common low-signal terms ignored by memory search and recall. */
export const SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "what", "when", "where", "como", "para", "por",
  "con", "que", "del", "las", "los", "una", "uno", "este", "esta", "eso", "ahi", "hacer", "hace", "podes",
  "puedes", "quiero", "necesito", "sobre", "solo", "cosas", "algo", "mucho", "poco", "bien", "mal",
]);

/** Default priority by observation type. */
export const DEFAULT_PRIORITY: Record<string, number> = {
  architecture: 4,
  bugfix: 4,
  decision: 4,
  config: 3,
  discovery: 2,
  learning: 2,
  preference: 1,
};
