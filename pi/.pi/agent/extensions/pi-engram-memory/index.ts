import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, matchesKey, Key, Markdown } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/**
 * engram - Compact persistent memory for Pi
 *
 * A lean memory extension inspired by Engram's concept of compact,
 * high-signal knowledge units. Stores structured observations with
 * priority scoring in local SQLite. Designed for token efficiency:
 * only 3 tools, no FTS5, no prompt guidelines bloat.
 *
 * Default DB: ~/.pi/agent/memory/pi-memory.db
 * Requires: sqlite3 with WAL support (Arch: sudo pacman -S sqlite)
 */

// ---------------------------------------------------------------------------
// Configuration (env overrides)
// ---------------------------------------------------------------------------

const SQLITE_BIN = process.env.PI_MEMORY_SQLITE_BIN ?? "sqlite3";
const DB_PATH = process.env.PI_MEMORY_DB ?? join(homedir(), ".pi", "agent", "memory", "pi-memory.db");
const AUTO_RECALL = process.env.PI_MEMORY_AUTO_RECALL !== "0";
const MAX_RECALL_CHARS = Number(process.env.PI_MEMORY_MAX_RECALL_CHARS ?? "1000");
const SQLITE_TIMEOUT_MS = Number(process.env.PI_MEMORY_SQLITE_TIMEOUT_MS ?? "8000");
const SQLITE_BUSY_TIMEOUT_MS = Number(
  process.env.PI_MEMORY_SQLITE_BUSY_TIMEOUT_MS ?? String(Math.max(1000, SQLITE_TIMEOUT_MS - 1000)),
);

const VALID_TYPES = ["architecture", "bugfix", "config", "decision", "discovery", "learning", "preference"] as const;

// Common low-signal terms ignored by memory search/recall.
const SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "what", "when", "where", "como", "para", "por",
  "con", "que", "del", "las", "los", "una", "uno", "este", "esta", "eso", "ahi", "hacer", "hace", "podes",
  "puedes", "quiero", "necesito", "sobre", "solo", "cosas", "algo", "mucho", "poco", "bien", "mal",
]);

// Default priority by type: higher = more important, more likely to auto-recall
const DEFAULT_PRIORITY: Record<string, number> = {
  architecture: 4,
  bugfix: 4,
  decision: 4,
  config: 3,
  discovery: 2,
  learning: 2,
  preference: 1,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectInfo {
  project: string;
  project_source: string;
  project_path: string;
  cwd: string;
}

interface ObservationRow {
  id: number;
  type: string;
  title: string;
  content: string;
  priority: number;
  scope: string;
  topic_key: string | null;
  normalized_hash: string;
  revision_count: number;
  duplicate_count: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  project: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let currentSessionId = `pi-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
let lastProjectInfo: ProjectInfo | null = null;
let sqliteQueue: Promise<unknown> = Promise.resolve();
const projectCache = new Map<string, ProjectInfo>();

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

/** Escape a value for SQLite literal interpolation. */
function sql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Normalize a project name to a stable, filesystem-safe identifier. */
function normalizeProjectName(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^.*[:/]([^/:]+\/[^/]+)$/i, "$1")
    .split("/")
    .pop()!
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Normalize text for hash comparison. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** SHA-256 hash of title + content + type + scope + project for dedup. */
function normalizedHash(
  title: string,
  content: string,
  type: string,
  scope: string,
  project: string,
): string {
  const stable = [project, scope, type, title, content]
    .map((part) => normalizeText(String(part ?? "")))
    .join("\n---\n");
  return createHash("sha256").update(stable).digest("hex");
}

/** Truncate text to a maximum length for context budgets. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated to ${max} chars]`;
}

/** Redact common secret patterns before persisting. */
function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1****************");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh*_************************");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "sk-************************");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza************************");
  out = out.replace(
    /\b((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)\s*[:=]\s*)([^\s'"`]+|'[^']+'|"[^"]+"|`[^`]+`)/gi,
    (_m: string, key: string) => `${key}[REDACTED]`,
  );
  out = out.replace(
    /^\s*([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*).+$/gim,
    (_m: string, key: string) => `${key}[REDACTED]`,
  );
  return out;
}

/** Default priority for a given type. */
function defaultPriority(type: string): number {
  return DEFAULT_PRIORITY[type.toLowerCase()] ?? 3;
}

/** Extract search-safe terms from a user query. */
function extractTerms(query: string): string[] {
  const seen = new Set<string>();
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((term) => {
      if (term.length < 3 && !/^(ui|db|id|js|ts|go)$/i.test(term)) return false;
      if (SEARCH_STOP_WORDS.has(term) || seen.has(term)) return false;
      seen.add(term);
      return true;
    })
    .slice(0, 8);
}

/** Build a relevance score for keyword search using title/topic/content weights. */
function keywordScoreSql(terms: string[]): string {
  if (terms.length === 0) return "0";
  return terms
    .map((term) => {
      const q = sql(term);
      return [
        `(CASE WHEN lower(o.title)=${q} THEN 10 ELSE 0 END)`,
        `(CASE WHEN lower(o.title) LIKE '%' || ${q} || '%' THEN 5 ELSE 0 END)`,
        `(CASE WHEN lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' THEN 4 ELSE 0 END)`,
        `(CASE WHEN lower(o.content) LIKE '%' || ${q} || '%' THEN 1 ELSE 0 END)`,
      ].join(" + ");
    })
    .join(" + ");
}

/** Count how many distinct query terms matched anywhere in an observation. */
function keywordCoverageSql(terms: string[]): string {
  if (terms.length === 0) return "0";
  return terms
    .map((term) => {
      const q = sql(term);
      return `(CASE WHEN lower(o.title) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' OR lower(o.content) LIKE '%' || ${q} || '%' THEN 1 ELSE 0 END)`;
    })
    .join(" + ");
}

/** First ~N chars of content as a compact snippet. */
function snip(content: string, maxLen = 120): string {
  if (!content) return "";
  const flat = cleanInline(content);
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + "...";
}

/** Collapse arbitrary text into a terminal-safe single line. */
function cleanInline(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Truncate a plain string for compact terminal output. */
function cropPlain(text: string, maxLen: number): string {
  const value = cleanInline(text);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

/** Run SQLite CLI work sequentially inside this extension process. */
function enqueueSql<T>(task: () => Promise<T>): Promise<T> {
  const run = sqliteQueue.then(task, task);
  sqliteQueue = run.catch(() => undefined);
  return run;
}

/** Return true when sqlite reports a transient lock/busy condition. */
function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/** Execute a single SQLite script with WAL, busy timeout, serialization, and retry. */
async function execSql(pi: ExtensionAPI, sqlText: string, signal?: AbortSignal): Promise<string> {
  return enqueueSql(async () => {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new Error("sqlite execution aborted");

      try {
        return await execSqlOnce(pi, sqlText, signal);
      } catch (error) {
        lastError = error;
        if (!isSqliteBusyError(error) || attempt === maxAttempts) break;

        // Back off a little in case another Pi process is holding the write lock.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });
}

/** Execute a single SQLite script file. Use execSql for callers. */
async function execSqlOnce(pi: ExtensionAPI, sqlText: string, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const tmpFile = join(
    dirname(DB_PATH),
    `.pi-tmp-${process.pid}-${randomUUID().slice(0, 8)}.sql`,
  );
  const body = [
    `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
    sqlText.trim(),
    "",
  ].join("\n");
  await writeFile(tmpFile, body, "utf8");
  try {
    const result = await pi.exec(SQLITE_BIN, [DB_PATH, `.read ${tmpFile}`], {
      signal,
      timeout: SQLITE_TIMEOUT_MS + 2000,
    });
    if (result.code !== 0) {
      throw new Error(
        `sqlite exited ${result.code}: ${(result.stderr || result.stdout || "no output").trim()}`,
      );
    }
    return (result.stdout ?? "").trim();
  } finally {
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

/** Execute SQL and parse the JSON output (sqlite3 .mode json). */
async function sqliteJson<T = Record<string, unknown>>(
  pi: ExtensionAPI,
  sqlText: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const out = await execSql(pi, `.mode json\n${sqlText}`, signal);
  if (!out.trim()) return [];
  try {
    return JSON.parse(out) as T[];
  } catch {
    throw new Error(`sqlite returned non-JSON: ${out.slice(0, 300)}`);
  }
}

/** Shorthand: execute SQL without needing the result. */
async function sqlite(pi: ExtensionAPI, sqlText: string, signal?: AbortSignal): Promise<void> {
  await execSql(pi, sqlText, signal);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function ensureDb(pi: ExtensionAPI, signal?: AbortSignal): Promise<void> {
  if (initialized) return;

  await sqlite(
    pi,
    `
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      directory TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      type TEXT NOT NULL DEFAULT 'discovery',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      scope TEXT NOT NULL DEFAULT 'project',
      topic_key TEXT,
      normalized_hash TEXT NOT NULL,
      revision_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      project TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    `,
    signal,
  );

  // Migration: add priority column if upgrading from old schema
  try {
    await sqlite(pi, "ALTER TABLE observations ADD COLUMN priority INTEGER NOT NULL DEFAULT 3;", signal);
  } catch {
    // column already exists — fine
  }

  // Indices (IF NOT EXISTS makes them idempotent)
  await sqlite(
    pi,
    `
    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_project_updated ON observations(project, updated_at);
    CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(project, scope, topic_key);
    CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_obs_priority ON observations(project, priority);
    `,
    signal,
  );

  initialized = true;
}

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------

async function detectProject(
  pi: ExtensionAPI,
  ctx?: ExtensionContext | any,
  signal?: AbortSignal,
): Promise<ProjectInfo> {
  await ensureDb(pi, signal);
  const cwd = String(ctx?.cwd ?? ctx?.systemPromptOptions?.cwd ?? process.cwd());
  const envProject = process.env.PI_MEMORY_PROJECT?.trim();
  const cacheKey = `${cwd}\n${envProject ?? ""}`;
  const cached = projectCache.get(cacheKey);
  if (cached) return { ...cached };

  // 1. Environment override
  if (envProject) {
    const info: ProjectInfo = {
      project: normalizeProjectName(envProject),
      project_source: "env",
      project_path: cwd,
      cwd,
    };
    projectCache.set(cacheKey, info);
    return info;
  }

  // 2. Git remote / git root
  try {
    const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      signal,
      timeout: 1200,
    });
    if (root.code === 0 && root.stdout?.trim()) {
      const gitRoot = root.stdout.trim();
      const remote = await pi.exec(
        "git",
        ["-C", gitRoot, "config", "--get", "remote.origin.url"],
        { signal, timeout: 1200 },
      );
      const rawName =
        remote.code === 0 && remote.stdout?.trim()
          ? remote.stdout.trim()
          : basename(gitRoot);
      const project =
        normalizeProjectName(rawName) || normalizeProjectName(basename(gitRoot));
      const info: ProjectInfo = {
        project,
        project_source: rawName === basename(gitRoot) ? "git_root" : "git_remote",
        project_path: gitRoot,
        cwd,
      };
      projectCache.set(cacheKey, info);
      return info;
    }
  } catch {
    // git is optional
  }

  // 3. cwd basename
  const project = normalizeProjectName(basename(cwd)) || "unknown";
  const info: ProjectInfo = {
    project,
    project_source: project === "unknown" ? "unknown" : "cwd",
    project_path: cwd,
    cwd,
  };
  projectCache.set(cacheKey, info);
  return info;
}

async function ensureSession(pi: ExtensionAPI, info: ProjectInfo, signal?: AbortSignal): Promise<void> {
  await ensureDb(pi, signal);
  await sqlite(
    pi,
    `INSERT INTO sessions(id, project, directory, status) VALUES (${sql(currentSessionId)}, ${sql(info.project)}, ${sql(info.project_path)}, 'active') ON CONFLICT(id) DO UPDATE SET project=excluded.project, directory=excluded.directory, status='active';`,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * mem_save: Save or update (via topic_key) a structured observation.
 *
 * - Deduplicates by normalized hash of (project, scope, type, title, content).
 * - Upserts by topic_key if one is provided and a match exists.
 * - Priority defaults by type: arch/bugfix/decision=4, config=3, discovery/learning=2, preference=1.
 */
async function handleSave(
  pi: ExtensionAPI,
  ctx: ExtensionContext | any,
  params: any,
  signal?: AbortSignal,
) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  await ensureSession(pi, info, signal);

  const title = redactSecrets(String(params.title ?? "").trim());
  const content = redactSecrets(String(params.content ?? "").trim());
  const type = VALID_TYPES.includes(String(params.type ?? "")) ? params.type : "discovery";
  const scope = params.scope === "personal" ? "personal" : "project";
  const topic_key = params.topic_key?.trim() || undefined;

  if (!title) return { ok: false, error: "title is required" };
  if (!content) return { ok: false, error: "content is required" };
  if (title.length > 80) return { ok: false, error: "title must be 80 characters or less" };

  const priority =
    typeof params.priority === "number" && params.priority >= 1 && params.priority <= 5
      ? Math.round(params.priority)
      : defaultPriority(type);

  const hash = normalizedHash(title, content, type, scope, info.project);

  // Upsert by topic_key
  if (topic_key) {
    const existing = await sqliteJson<{ id: number }>(
      pi,
      `SELECT id FROM observations WHERE project=${sql(info.project)} AND scope=${sql(scope)} AND topic_key=${sql(topic_key)} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1;`,
      signal,
    );
    if (existing[0]?.id) {
      const id = existing[0].id;
      await sqlite(
        pi,
        `UPDATE observations SET type=${sql(type)}, priority=${sql(priority)}, title=${sql(title)}, content=${sql(content)}, normalized_hash=${sql(hash)}, revision_count=revision_count+1, last_seen_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(id)};`,
        signal,
      );
      return { ok: true, project: info.project, result: { id, action: "updated", topic_key, priority } };
    }
  }

  // Dedup by hash
  const duplicate = await sqliteJson<{ id: number; duplicate_count: number }>(
    pi,
    `SELECT id, duplicate_count FROM observations WHERE normalized_hash=${sql(hash)} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1;`,
    signal,
  );
  if (duplicate[0]?.id) {
    await sqlite(
      pi,
      `UPDATE observations SET duplicate_count=duplicate_count+1, last_seen_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(duplicate[0].id)};`,
      signal,
    );
    return { ok: true, project: info.project, result: { id: duplicate[0].id, action: "deduped" } };
  }

  // Insert
  const rows = await sqliteJson<{ id: number }>(
    pi,
    `INSERT INTO observations(session_id, type, title, content, priority, scope, topic_key, normalized_hash, project) VALUES (${sql(currentSessionId)}, ${sql(type)}, ${sql(title)}, ${sql(content)}, ${sql(priority)}, ${sql(scope)}, ${sql(topic_key)}, ${sql(hash)}, ${sql(info.project)}); SELECT last_insert_rowid() AS id;`,
    signal,
  );

  return { ok: true, project: info.project, result: { id: rows[0]?.id, action: "inserted", priority } };
}

/**
 * mem_search: Search observations or get recent context.
 *
 * - Pass `id` for exact lookup (ignores all other filters).
 * - Omit `query` to get most recent results.
 * - Pass `query` for LIKE-based search across title and content.
 * - Use `include_content` to get full content instead of snippets.
 */
async function handleSearch(
  pi: ExtensionAPI,
  ctx: ExtensionContext | any,
  params: any,
  signal?: AbortSignal,
) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const includeContent = Boolean(params.include_content);
  const limit = Math.max(1, Math.min(Number(params.limit ?? 5), 10));

  // Exact lookup by ID
  if (typeof params.id === "number") {
    const rows = await sqliteJson<ObservationRow>(
      pi,
      `SELECT * FROM observations WHERE id=${sql(params.id)} AND deleted_at IS NULL LIMIT 1;`,
      signal,
    );
    if (!rows[0]) return { ok: false, error: `Observation #${params.id} not found.`, project: info.project };
    const row = rows[0];
    const idHead = `#${row.id} [${typeAbbr(row.type)}] ${row.title} (p${row.priority})`;
    const idBody = (row.content ?? "").trim();
    return {
      ok: true,
      project: row.project,
      result: idBody ? `${idHead}\n${idBody}` : idHead,
    };
  }

  // Build WHERE clause
  const query = String(params.query ?? "").trim();
  const typeFilter = params.type?.trim();
  const priorityMin = Math.max(0, Math.min(5, Number(params.priority_min ?? 2)));
  const terms = query ? extractTerms(query) : [];

  const clauses: string[] = ["o.deleted_at IS NULL", `o.project=${sql(info.project)}`];

  if (terms.length > 0) {
    const likeClauses = terms.map((term) => {
      const q = sql(term);
      return `(lower(o.title) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' OR lower(o.content) LIKE '%' || ${q} || '%')`;
    });
    const minCoverage = terms.length >= 4 ? 2 : 1;
    clauses.push(`(${likeClauses.join(" OR ")})`);
    clauses.push(`(${keywordCoverageSql(terms)})>=${sql(minCoverage)}`);
  }

  if (typeFilter) clauses.push(`o.type=${sql(typeFilter)}`);
  if (priorityMin > 0) clauses.push(`o.priority>=${sql(priorityMin)}`);

  const where = clauses.join(" AND ");
  const relevance = keywordScoreSql(terms);
  const coverage = keywordCoverageSql(terms);
  const rows = await sqliteJson<ObservationRow>(
    pi,
    `SELECT o.*, (${relevance}) AS relevance, (${coverage}) AS coverage FROM observations o WHERE ${where} ORDER BY relevance DESC, coverage DESC, o.priority DESC, o.updated_at DESC LIMIT ${sql(limit)};`,
    signal,
  );

  if (rows.length === 0) return { ok: true, project: info.project, result: "(no memories found)" };

  const formatted = rows.map((r) => formatRowMinimal(r, includeContent)).join("\n");
  return { ok: true, project: info.project, result: formatted };
}

function formatRow(row: ObservationRow, includeContent: boolean): string {
  const head = `#${row.id} [${row.type}] ${row.title} (p${row.priority}, ${(row.updated_at ?? "").slice(0, 10)})`;
  const topic = row.topic_key ? `\n  topic: ${row.topic_key}` : "";
  const body = includeContent
    ? `\n${row.content ?? ""}`
    : `\n  ${snip(row.content ?? "", 120)}`;
  const counts =
    row.revision_count > 0 || row.duplicate_count > 0
      ? `\n  rev:${row.revision_count} dup:${row.duplicate_count}`
      : "";
  return `${head}${topic}${body}${counts}`;
}

// ---------------------------------------------------------------------------
// Ultra-minimal formatting for tool output
// ---------------------------------------------------------------------------

/** Type abbreviation map for ultra-minimal display (4 chars each). */
const TYPE_ABBR: Record<string, string> = {
  architecture: "arch",
  bugfix:       "bugf",
  config:       "conf",
  decision:     "deci",
  discovery:    "disc",
  learning:     "lear",
  preference:   "pref",
};

function typeAbbr(type: string): string {
  return TYPE_ABBR[type] ?? type.slice(0, 4);
}

/**
 * Format a single observation as ONE ultra-minimal line.
 * Default searches intentionally omit snippets to prevent wall-of-text output.
 *
 *   #42 arch p4 Fixed N+1 query
 *   #42 arch p4 Fixed N+1 query -- short snippet...   // include_content=true
 */
function formatRowMinimal(row: ObservationRow, includeContent: boolean): string {
  const id = `#${row.id}`;
  const meta = `${typeAbbr(row.type)} p${row.priority}`;
  const title = cropPlain(row.title, includeContent ? 58 : 84);
  const head = `${id} ${meta} ${title}`;

  if (!includeContent) return cropPlain(head, 104);

  const snippet = snip(row.content ?? "", 48);
  const line = snippet ? `${head} -- ${snippet}` : head;
  return cropPlain(line, 120);
}

/** Format a save result object as one ultra-minimal text line. */
function formatSaveResult(result: any): string {
  if (!result.ok) return `error: ${result.error}`;
  const r = result.result;
  if (!r) return "error: unknown";
  switch (r.action) {
    case "inserted": return `saved #${r.id} (p${r.priority})`;
    case "updated":  return `updated #${r.id} (p${r.priority})`;
    case "deduped":  return `duplicate #${r.id}`;
    default:         return `#${r.id} (${r.action})`;
  }
}

/**
 * mem_admin: Manage memory storage.
 *
 * Actions:
 * - stats   — counts by type and priority, db path
 * - delete  — soft-delete (default) or hard-delete with confirm="YES"
 * - export  — JSON export to path (relative to cwd)
 * - import  — JSON import from path, dedup by hash
 */
async function handleAdmin(
  pi: ExtensionAPI,
  ctx: ExtensionContext | any,
  params: any,
  signal?: AbortSignal,
) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const action = String(params.action ?? "").trim();

  if (action === "stats") {
    const pw = params.project?.trim()
      ? `AND project=${sql(normalizeProjectName(params.project))}`
      : "";
    const counts = await sqliteJson<{ metric: string; value: number }>(
      pi,
      `SELECT 'total' AS metric, COUNT(*) AS value FROM observations WHERE deleted_at IS NULL ${pw}
       UNION ALL SELECT 'deleted', COUNT(*) FROM observations WHERE deleted_at IS NOT NULL ${pw}
       ${params.project ? "" : "UNION ALL SELECT 'projects', COUNT(DISTINCT project) FROM observations WHERE deleted_at IS NULL"}
       UNION ALL SELECT 'sessions', COUNT(*) FROM sessions ${params.project ? `WHERE project=${sql(normalizeProjectName(params.project))}` : ""}
       ORDER BY metric;`,
      signal,
    );
    const byType = await sqliteJson<{ type: string; count: number }>(
      pi,
      `SELECT type, COUNT(*) AS count FROM observations WHERE deleted_at IS NULL ${pw} GROUP BY type ORDER BY type;`,
      signal,
    );
    const byPriority = await sqliteJson<{ priority: number; count: number }>(
      pi,
      `SELECT priority, COUNT(*) AS count FROM observations WHERE deleted_at IS NULL ${pw} GROUP BY priority ORDER BY priority;`,
      signal,
    );
    return {
      ok: true,
      project: info.project,
      result: { db: DB_PATH, counts, by_type: byType, by_priority: byPriority },
    };
  }

  if (action === "delete") {
    const id = Number(params.id);
    if (!id || !Number.isFinite(id)) return { ok: false, error: "id is required for delete.", project: info.project };
    if (params.confirm !== "YES") return { ok: false, error: "delete requires confirm='YES'.", project: info.project };

    if (params.hard) {
      const rows = await sqliteJson<{ changed: number }>(
        pi,
        `DELETE FROM observations WHERE id=${sql(id)} AND project=${sql(info.project)}; SELECT changes() AS changed;`,
        signal,
      );
      const changed = Number(rows[0]?.changed ?? 0);
      return { ok: true, project: info.project, result: { id, action: changed > 0 ? "hard_deleted" : "not_found" } };
    }

    const rows = await sqliteJson<{ changed: number }>(
      pi,
      `UPDATE observations SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(id)} AND project=${sql(info.project)} AND deleted_at IS NULL; SELECT changes() AS changed;`,
      signal,
    );
    const changed = Number(rows[0]?.changed ?? 0);
    return { ok: true, project: info.project, result: { id, action: changed > 0 ? "soft_deleted" : "not_found" } };
  }

  if (action === "export") {
    const cwd = String(ctx?.cwd ?? process.cwd());
    const outPath = params.path?.trim()
      ? resolve(cwd, params.path)
      : join(cwd, `pi-memory-export-${new Date().toISOString().slice(0, 10)}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    const observations = await sqliteJson(pi, "SELECT * FROM observations WHERE deleted_at IS NULL ORDER BY updated_at DESC;", signal);
    const sessions = await sqliteJson(pi, "SELECT * FROM sessions ORDER BY started_at DESC;", signal);
    await writeFile(
      outPath,
      JSON.stringify({ exported_at: new Date().toISOString(), schema: "engram-v3", observations, sessions }, null, 2),
    );
    return {
      ok: true,
      project: info.project,
      result: { path: outPath, observations: observations.length, sessions: sessions.length },
    };
  }

  if (action === "import") {
    if (!params.path?.trim()) return { ok: false, error: "path is required for import.", project: info.project };
    const inPath = resolve(String(ctx?.cwd ?? process.cwd()), params.path.trim());
    const raw = await readFile(inPath, "utf8");
    const data = JSON.parse(raw) as { observations?: any[]; sessions?: any[] };
    const observations = Array.isArray(data.observations) ? data.observations : [];
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    let importedObs = 0;
    let dedupedObs = 0;
    let importedSess = 0;

    for (const sess of sessions) {
      if (!sess?.id || !sess?.project || !sess?.directory) continue;
      await sqlite(
        pi,
        `INSERT INTO sessions(id, project, directory, started_at, ended_at, summary, status) VALUES (${sql(sess.id)}, ${sql(sess.project)}, ${sql(sess.directory)}, COALESCE(${sql(sess.started_at)}, datetime('now')), ${sql(sess.ended_at)}, ${sql(sess.summary)}, COALESCE(${sql(sess.status)}, 'imported')) ON CONFLICT(id) DO UPDATE SET project=excluded.project, directory=excluded.directory, ended_at=COALESCE(excluded.ended_at, sessions.ended_at), summary=COALESCE(excluded.summary, sessions.summary), status=excluded.status;`,
        signal,
      );
      importedSess++;
    }

    for (const obs of observations) {
      const title = String(obs?.title ?? "").trim();
      const content = String(obs?.content ?? "").trim();
      const project = normalizeProjectName(String(obs?.project ?? info.project));
      if (!title || !content || !project) continue;
      const type = String(obs?.type ?? "imported");
      const scope = String(obs?.scope ?? "project");
      const topic_key = obs?.topic_key?.trim() || undefined;
      const hash = normalizedHash(title, content, type, scope, project);

      const existing = await sqliteJson<{ id: number }>(
        pi,
        `SELECT id FROM observations WHERE normalized_hash=${sql(hash)} AND deleted_at IS NULL LIMIT 1;`,
        signal,
      );
      if (existing[0]?.id) {
        await sqlite(
          pi,
          `UPDATE observations SET duplicate_count=duplicate_count+1, last_seen_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(existing[0].id)};`,
          signal,
        );
        dedupedObs++;
        continue;
      }

      const priority =
        typeof obs.priority === "number" && obs.priority >= 1 && obs.priority <= 5
          ? Math.round(obs.priority)
          : defaultPriority(type);

      await sqlite(
        pi,
        `INSERT INTO observations(session_id, type, title, content, priority, scope, topic_key, normalized_hash, project, revision_count, duplicate_count, last_seen_at, created_at, updated_at) VALUES (${sql(obs?.session_id)}, ${sql(type)}, ${sql(redactSecrets(title))}, ${sql(redactSecrets(content))}, ${sql(priority)}, ${sql(scope)}, ${sql(topic_key)}, ${sql(hash)}, ${sql(project)}, ${sql(Number(obs?.revision_count ?? 0))}, ${sql(Number(obs?.duplicate_count ?? 0))}, COALESCE(${sql(obs?.last_seen_at)}, datetime('now')), COALESCE(${sql(obs?.created_at)}, datetime('now')), COALESCE(${sql(obs?.updated_at)}, datetime('now')));`,
        signal,
      );
      importedObs++;
    }

    projectCache.clear();
    return {
      ok: true,
      project: info.project,
      result: {
        path: inPath,
        imported_observations: importedObs,
        deduped_observations: dedupedObs,
        imported_sessions: importedSess,
      },
    };
  }

  return { ok: false, error: `Unknown action '${action}'. Use stats, delete, export, or import.`, project: info.project };
}

// ---------------------------------------------------------------------------
// Minimal tool renderers
// ---------------------------------------------------------------------------

/** Build a tiny component that renders preformatted lines without wrapping. */
function compactLines(lines: string[]): Component {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(20, width);
      return lines.map((line) => truncateToWidth(line, safeWidth));
    },
    invalidate() {},
  };
}

/** Extract the plain text payload from a tool execution result. */
function toolText(result: any): string {
  const item = result?.content?.find?.((entry: any) => entry?.type === "text");
  return typeof item?.text === "string" ? item.text.trim() : "";
}

/** Style one memory result line while keeping it compact and ANSI-safe. */
function styleMemoryLine(line: string, theme: any): string {
  const match = line.match(/^(#\d+)\s+([a-z]{4})\s+(p\d)\s+(.+)$/);
  if (!match) return theme.fg("muted", line);

  const [, id, type, priority, rest] = match;
  const [title, snippet] = rest.split(/\s+--\s+/, 2);
  let out = `${theme.fg("accent", id)} ${theme.fg("muted", type)} ${theme.fg("warning", priority)} ${title}`;
  if (snippet) out += theme.fg("dim", ` -- ${snippet}`);
  return out;
}

/** Render memory tools as clean single-line summaries and compact result lists. */
function memoryToolRenderer(label: string) {
  return {
    renderCall(args: any, theme: any) {
      const parts: string[] = [];
      if (args?.id !== undefined) parts.push(`#${args.id}`);
      if (args?.query) parts.push(`"${cropPlain(args.query, 34)}"`);
      if (!args?.query && args?.title) parts.push(`"${cropPlain(args.title, 34)}"`);
      if (args?.type) parts.push(String(args.type));
      if (args?.priority_min) parts.push(`p>=${args.priority_min}`);
      if (args?.limit) parts.push(`n=${args.limit}`);
      const suffix = parts.length ? theme.fg("dim", ` ${parts.join(" ")}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold(label)) + suffix, 0, 0);
    },

    renderResult(result: any, options: any, theme: any) {
      if (options?.isPartial) return new Text(theme.fg("warning", "working..."), 0, 0);

      const text = toolText(result);
      if (!text) return new Text(theme.fg("dim", "done"), 0, 0);

      const rawLines = text.split("\n").filter(Boolean);
      if (rawLines.length === 1 && rawLines[0] === "(no memories found)") {
        return new Text(theme.fg("dim", "no memories"), 0, 0);
      }

      const maxLines = options?.expanded ? rawLines.length : 8;
      const visible = rawLines.slice(0, maxLines).map((line) => styleMemoryLine(line, theme));
      if (rawLines.length > maxLines) {
        visible.push(theme.fg("dim", `... ${rawLines.length - maxLines} more`));
      }
      return compactLines(visible);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function engram(pi: ExtensionAPI) {
  // --- Session lifecycle ------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureDb(pi);
      lastProjectInfo = await detectProject(pi, ctx);
      await ensureSession(pi, lastProjectInfo);
      ctx.ui.setStatus(
        "memory",
        `${ctx.ui.theme.fg("accent", "◆")} ${ctx.ui.theme.fg("muted", "mem")} ${ctx.ui.theme.fg("success", lastProjectInfo.project)}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(
        "memory",
        `${ctx.ui.theme.fg("error", "◆")} ${ctx.ui.theme.fg("muted", "mem unavailable")}`,
      );
      ctx.ui.notify(
        `engram is not available. Install sqlite3 (Arch: sudo pacman -S sqlite). ${msg}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await ensureDb(pi);
      const info = lastProjectInfo ?? (await detectProject(pi, ctx));
      await sqlite(
        pi,
        `UPDATE sessions SET ended_at=datetime('now'), status='ended' WHERE id=${sql(currentSessionId)};`,
      );
      ctx.ui.setStatus("memory", undefined);
      void info;
    } catch {
      // never block shutdown
    }
  });

  // --- Auto recall -------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await ensureDb(pi);
      const info = await detectProject(pi, ctx);
      await ensureSession(pi, info);
      lastProjectInfo = info;

      const prompt = String(event.prompt ?? "").trim();
      if (!prompt || prompt.startsWith("/")) return;

      // Auto-recall: only memories with priority >= 3
      if (!AUTO_RECALL) return;

      const terms = extractTerms(prompt);
      if (terms.length === 0) return;

      const likeClauses = terms.map((term) => {
        const q = sql(term);
        return `(lower(o.title) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' OR lower(o.content) LIKE '%' || ${q} || '%')`;
      });
      const minCoverage = terms.length >= 4 ? 2 : 1;
      const relevance = keywordScoreSql(terms);
      const coverage = keywordCoverageSql(terms);
      const rows = await sqliteJson<ObservationRow>(
        pi,
        `SELECT o.*, (${relevance}) AS relevance, (${coverage}) AS coverage FROM observations o WHERE o.deleted_at IS NULL AND o.project=${sql(info.project)} AND o.priority>=3 AND (${likeClauses.join(" OR ")}) AND (${coverage})>=${sql(minCoverage)} ORDER BY relevance DESC, coverage DESC, o.priority DESC, o.updated_at DESC LIMIT 3;`,
      );
      if (rows.length === 0) {
        // No specific memories found, but keep a strong memory policy visible to the LLM.
        return {
          systemPrompt:
            event.systemPrompt +
            `\n\n# Local persistent memory recall\n` +
            `No specific memories matched this prompt automatically.\n` +
            `Memory policy: before reading files or doing exploratory work, use mem_search first when the request may depend on prior project decisions, architecture, bugs, configuration, user preferences, or previous session context. Search with 2-5 precise keywords, priority_min>=3, limit<=5, and avoid include_content unless following up by exact id. After discovering durable project knowledge, fixes, decisions, or user preferences, save it with mem_save.\n`,
        };
      }

      const recalled = rows
        .map(
          (r) =>
            `[${r.type}] ${r.title} (p${r.priority})\n  topic: ${r.topic_key ?? "-"}\n  ${snip(r.content ?? "", 100)}`,
        )
        .join("\n\n");

      const block = clip(recalled, MAX_RECALL_CHARS);

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n# Local persistent memory recall\n` +
          `These are local memories retrieved for the current prompt. Prefer them over redundant file exploration when they answer the question. Do not expose secrets.\n` +
          `Memory policy: use mem_search before reading files or doing exploratory work when more prior context may exist. Search with narrow keywords, priority_min>=3, limit<=5, and no include_content unless following up by exact id. After discovering durable project knowledge, fixes, decisions, or user preferences, save it with mem_save.\n\n` +
          `\`\`\`text\n${block}\n\`\`\``,
      };
    } catch {
      return;
    }
  });

  // --- Tool: mem_save ----------------------------------------------------
  pi.registerTool({
    name: "mem_save",
    label: "Save Memory",
    description:
      "Save or update (via topic_key) an observation. Types: architecture, bugfix, config, decision, discovery, learning, preference. Priority 1-5 assigned by type unless provided. Saved observations are searchable via mem_search and automatically recalled when relevant.",
    promptGuidelines: [
      "Use mem_save after learning durable project knowledge: architecture decisions, bug fixes, configuration, debugging findings, user preferences, or decisions that should help future sessions.",
      "Use stable topic_key values with mem_save for knowledge that may evolve, so future saves update the same memory instead of creating duplicates.",
      "Write mem_save content as clean Markdown: use short headings when helpful, bullet lists for facts and decisions, and fenced code blocks for commands, errors, config, SQL, JSON, or code.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title, max 80 chars" }),
      content: Type.String({ description: "Structured Markdown body describing the observation. Use headings, bullets, and fenced code blocks when helpful." }),
      type: Type.Optional(
        Type.String({
          description:
            "Type: architecture|bugfix|config|decision|discovery|learning|preference",
        }),
      ),
      priority: Type.Optional(
        Type.Number({
          description:
            "Importance 1-5. Default by type: arch/bugfix/decision=4, config=3, discovery/learning=2, preference=1",
        }),
      ),
      topic_key: Type.Optional(
        Type.String({ description: "Stable key for upserts, e.g. architecture/auth-model" }),
      ),
      scope: Type.Optional(
        Type.String({ description: "project or personal (default project)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await handleSave(pi, ctx, params, signal);
      return {
        content: [{ type: "text", text: formatSaveResult(result) }],
        details: result,
      };
    },
    ...memoryToolRenderer("mem_save"),
  });

  // --- Tool: mem_search --------------------------------------------------
  pi.registerTool({
    name: "mem_search",
    label: "Search Memory",
    description:
      "Search memory before relying on file exploration when prior project context may answer the request. Be selective: derive 2-5 precise keywords from the user's current request, prefer type/priority filters, use limit 3-5, and do not use include_content for broad searches. Pass id for exact lookup.",
    promptGuidelines: [
      "Use mem_search early, before reading files, when the request mentions project-specific decisions, architecture, previous bugs, configuration, user preferences, or prior work.",
      "Prefer mem_search over exploratory file reads when the answer may already be in memory; then read files only to verify or implement changes.",
      "Use narrow mem_search queries with 2-5 concrete keywords, priority_min>=3, and limit<=5 unless the user explicitly asks for broader memory history.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Precise search keywords from the user's current request. Avoid vague terms; use nouns, filenames, feature names, bugs, decisions, or libraries." })),
      type: Type.Optional(Type.String({ description: "Optional exact type filter: architecture|bugfix|config|decision|discovery|learning|preference." })),
      priority_min: Type.Optional(
        Type.Number({ description: "Minimum priority 1-5 (default 2). Use 3+ for important context." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results 1-10 (default 5). Prefer 3-5 for focused context." })),
      id: Type.Optional(Type.Number({ description: "Get one exact memory by ID after a focused search." })),
      include_content: Type.Optional(
        Type.Boolean({ description: "Use only for exact/follow-up lookups; broad searches remain compact." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await handleSearch(pi, ctx, params, signal);
      const text =
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
    ...memoryToolRenderer("mem_search"),
  });

  // --- Tool: mem_admin ---------------------------------------------------
  pi.registerTool({
    name: "mem_admin",
    label: "Memory Admin",
    description:
      "Manage memory storage: stats, delete (confirm='YES'), export, import.",
    parameters: Type.Object({
      action: Type.String({ description: "stats | delete | export | import" }),
      id: Type.Optional(Type.Number({ description: "Observation ID (required for delete)" })),
      hard: Type.Optional(Type.Boolean({ description: "Permanent delete (default soft-delete)" })),
      path: Type.Optional(Type.String({ description: "File path for export or import" })),
      project: Type.Optional(Type.String({ description: "Project name for scoped stats" })),
      confirm: Type.Optional(
        Type.String({ description: "Must be 'YES' for delete action" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await handleAdmin(pi, ctx, params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // --- Slash commands ----------------------------------------------------
  pi.registerCommand("mem", {
    description: "Search memory. Usage: /mem <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /mem <query>", "warning");
      try {
        const result = await handleSearch(pi, ctx, { query, limit: 5, priority_min: 2 });
        ctx.ui.notify(
          typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memsave", {
    description: "Save memory. Usage: /memsave title :: content",
    handler: async (args, ctx) => {
      const [title, ...body] = args.split("::");
      const content = body.join("::").trim();
      if (!title?.trim() || !content) return ctx.ui.notify("Usage: /memsave title :: content", "warning");
      try {
        const result = await handleSave(pi, ctx, { title: title.trim(), content, type: "discovery" });
        ctx.ui.notify(formatSaveResult(result), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memstats", {
    description: "Show memory statistics.",
    handler: async (_args, ctx) => {
      try {
        const result = await handleAdmin(pi, ctx, { action: "stats" });
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memexport", {
    description: "Export memory to JSON. Usage: /memexport [path]",
    handler: async (args, ctx) => {
      try {
        const result = await handleAdmin(pi, ctx, {
          action: "export",
          path: args.trim() || undefined,
        });
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memimport", {
    description: "Import memory from JSON. Usage: /memimport <path>",
    handler: async (args, ctx) => {
      const file = args.trim();
      if (!file) return ctx.ui.notify("Usage: /memimport <path>", "warning");
      try {
        const result = await handleAdmin(pi, ctx, { action: "import", path: file });
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memsetup", {
    description: "Show engram setup info.",
    handler: async (_args, ctx) => {
      try {
        await ensureDb(pi);
        const info = await detectProject(pi, ctx);
        ctx.ui.notify(
          [
            "engram OK",
            `DB: ${DB_PATH}`,
            `SQLite: ${SQLITE_BIN}`,
            `Project: ${info.project} (${info.project_source})`,
            `Auto recall: ${AUTO_RECALL}`,
            `Max recall chars: ${MAX_RECALL_CHARS}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `engram error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // -----------------------------------------------------------------------
  // /membrowse — TUI memory browser
  // -----------------------------------------------------------------------
  pi.registerCommand("membrowse", {
    description: "Browse memories with an interactive TUI.",
    handler: async (_args, ctx) => {
      try {
        await ensureDb(pi);
        const info = await detectProject(pi, ctx);
        const rows = await sqliteJson<ObservationRow>(
          pi,
          `SELECT * FROM observations WHERE deleted_at IS NULL AND project=${sql(info.project)} ORDER BY priority DESC, updated_at DESC LIMIT 200;`,
        );

        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          const browser = new MemoryBrowser(rows, tui, theme, () => done(undefined));
          return browser;
        }, {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "74%",
            minWidth: 72,
            maxHeight: "86%",
            margin: 2,
          },
        });
      } catch (error) {
        ctx.ui.notify(
          `membrowse error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

// ---------------------------------------------------------------------------
// MemoryBrowser TUI component
// Rounded, theme-aware overlay with three-view navigation:
//   projects -> list (per-project) -> detail (scrollable full memory)
// Every rendered line is width-bounded and framed to avoid visual spillover.
// ---------------------------------------------------------------------------

type MemView = "projects" | "list" | "detail";

class MemoryBrowser implements Component {
  private view: MemView = "projects";
  private selProject: string | null = null;
  private selIdx = 0;
  private scrollOff = 0;
  private detailScroll = 0;
  private viewing: ObservationRow | null = null;
  private searchMode = false;
  private searchBuf = "";
  private mdRenderer: Markdown | null = null;
  private mdContentKey = "";

  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];
  private version = 0;

  constructor(
    private all: ObservationRow[],
    private tui: any,
    private theme: any,
    private onDone: () => void,
  ) {}

  /** Clear cached render output when state or theme changes. */
  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedVersion = -1;
    this.cachedLines = [];
  }

  /** Render the active browser view within the overlay width. */
  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedVersion === this.version) return this.cachedLines;

    const safeWidth = Math.max(60, width);
    let lines: string[];
    if (this.view === "projects") lines = this.renderProjects(safeWidth);
    else if (this.view === "list") lines = this.renderList(safeWidth);
    else lines = this.renderDetail(safeWidth);

    this.cachedWidth = width;
    this.cachedVersion = this.version;
    this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth));
    return this.cachedLines;
  }

  /** Route keyboard input to the active view. */
  handleInput(data: string): void {
    if (this.view === "projects") this.handleProjectsInput(data);
    else if (this.view === "list") this.handleListInput(data);
    else this.handleDetailInput(data);
  }

  // ---- Theme helpers -----------------------------------------------------

  private paint(token: string, value: string): string {
    return this.theme && typeof this.theme.fg === "function" ? this.theme.fg(token, value) : value;
  }

  private a(value: string): string { return this.paint("accent", value); }
  private m(value: string): string { return this.paint("muted", value); }
  private d(value: string): string { return this.paint("dim", value); }
  private b(value: string): string { return this.paint("border", value); }
  private ba(value: string): string { return this.paint("borderAccent", value); }
  private ok(value: string): string { return this.paint("success", value); }
  private err(value: string): string { return this.paint("error", value); }
  private warn(value: string): string { return this.paint("warning", value); }
  private bold(value: string): string {
    return this.theme && typeof this.theme.bold === "function" ? this.theme.bold(value) : value;
  }

  // ---- Layout helpers ----------------------------------------------------

  /** Number of body rows to render, leaving room for borders and footer. */
  private maxBodyRows(): number {
    const terminalRows = process.stdout.rows || 28;
    return Math.max(8, Math.floor(terminalRows * 0.68));
  }

  /** Pad ANSI-styled text to a visible width. */
  private pad(value: string, width: number): string {
    return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
  }

  /** Truncate ANSI-styled text to a visible width and then pad it. */
  private fit(value: string, width: number): string {
    return this.pad(truncateToWidth(value, Math.max(0, width)), width);
  }

  /** Render a full bordered row with left/right edges. */
  private row(content: string, innerWidth: number): string {
    return this.b("│") + this.fit(` ${content}`, innerWidth) + this.b("│");
  }

  /** Render an empty bordered row for breathing room. */
  private empty(innerWidth: number): string {
    return this.b("│") + " ".repeat(innerWidth) + this.b("│");
  }

  /** Render a rounded header with a centered-ish title. */
  private top(title: string, innerWidth: number): string {
    const label = this.fit(` ${title} `, Math.max(10, innerWidth - 4));
    const lineWidth = Math.max(0, innerWidth - visibleWidth(label));
    const leftRule = Math.min(2, lineWidth);
    const rightRule = Math.max(0, lineWidth - leftRule);
    return this.b("╭") + this.ba("─".repeat(leftRule)) + label + this.b("─".repeat(rightRule)) + this.b("╮");
  }

  /** Render a footer border with compact keyboard hints. */
  private bottom(hints: string, innerWidth: number): string[] {
    return [
      this.b("├") + this.b("─".repeat(innerWidth)) + this.b("┤"),
      this.row(this.d(hints), innerWidth),
      this.b("╰") + this.b("─".repeat(innerWidth)) + this.b("╯"),
    ];
  }

  /** Clamp list selection and scroll window to available rows. */
  private clamp(total: number, visibleRows = this.maxBodyRows()): void {
    this.selIdx = Math.max(0, Math.min(this.selIdx, Math.max(0, total - 1)));
    if (this.selIdx < this.scrollOff) this.scrollOff = this.selIdx;
    if (this.selIdx >= this.scrollOff + visibleRows) this.scrollOff = this.selIdx - visibleRows + 1;
    this.scrollOff = Math.max(0, Math.min(this.scrollOff, Math.max(0, total - visibleRows)));
  }

  /** Return all project names sorted for stable navigation. */
  private projectNames(): string[] {
    return [...new Set(this.all.map((row) => row.project || "unknown"))].sort();
  }

  /** Count memories and high-priority memories per project. */
  private projectStats(): Map<string, { count: number; high: number }> {
    const stats = new Map<string, { count: number; high: number }>();
    for (const row of this.all) {
      const project = row.project || "unknown";
      const entry = stats.get(project) ?? { count: 0, high: 0 };
      entry.count++;
      if (row.priority >= 3) entry.high++;
      stats.set(project, entry);
    }
    return stats;
  }

  /** Return memories filtered by selected project and search query. */
  private items(): ObservationRow[] {
    const base = this.selProject ? this.all.filter((row) => row.project === this.selProject) : this.all;
    if (!this.searchBuf.trim()) return base;
    const query = this.searchBuf.toLowerCase();
    return base.filter((row) => {
      const haystack = [row.title, row.content, row.type, row.topic_key].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }

  /** Compact semantic type badge. */
  private fmtType(type: string): string {
    const labels: Record<string, string> = {
      architecture: this.a(this.bold("arch")),
      bugfix: this.err("bugf"),
      config: this.a("conf"),
      decision: this.warn("deci"),
      discovery: this.a("disc"),
      learning: this.ok("lear"),
      preference: this.d("pref"),
    };
    return labels[type] ?? this.d(type.slice(0, 4));
  }

  /** Render priority as a compact block bar. */
  private fmtPriority(priority: number): string {
    const p = Math.max(1, Math.min(5, Number(priority) || 1));
    return (p >= 3 ? this.ok("█".repeat(p)) : this.d("█".repeat(p))) + this.d("░".repeat(5 - p));
  }

  /** Collapse text for one-line list previews. */
  private preview(value: string, width: number): string {
    return truncateToWidth(value.replace(/\s+/g, " ").trim(), width);
  }

  /** Render memory content as markdown and keep renderer instances cached per memory. */
  private renderMarkdownLines(row: ObservationRow, width: number): string[] {
    const content = row.content?.trim() || "(no content)";
    const key = `${row.id}:${row.updated_at ?? ""}:${width}`;
    if (!this.mdRenderer || this.mdContentKey !== key) {
      this.mdRenderer = new Markdown(content, 0, 0, getMarkdownTheme());
      this.mdContentKey = key;
    }
    return this.mdRenderer.render(width).map((line) => truncateToWidth(line, width));
  }

  /** Mark component state dirty and request a redraw. */
  private touch(): void {
    this.version++;
    this.invalidate();
    this.tui?.requestRender?.();
  }

  // ---- Projects view -----------------------------------------------------

  private renderProjects(width: number): string[] {
    const inner = width - 2;
    const projects = this.projectNames();
    const stats = this.projectStats();
    const visibleRows = this.maxBodyRows();
    this.clamp(projects.length, visibleRows);

    const lines = [this.top(`${this.a(this.bold("engram"))} ${this.m("projects")}`, inner), this.empty(inner)];

    if (projects.length === 0) {
      lines.push(this.row(this.d("No memories saved yet."), inner));
      lines.push(...this.bottom("q close", inner));
      return lines;
    }

    const slice = projects.slice(this.scrollOff, this.scrollOff + visibleRows);
    for (let i = 0; i < slice.length; i++) {
      const project = slice[i];
      const selected = this.scrollOff + i === this.selIdx;
      const info = stats.get(project) ?? { count: 0, high: 0 };
      const marker = selected ? this.a("▸") : this.d(" ");
      const left = `${marker} ${this.bold(project)}`;
      const right = this.d(`${info.count} memories  ${info.high} high`);
      lines.push(this.row(left + " ".repeat(Math.max(1, inner - 2 - visibleWidth(left) - visibleWidth(right))) + right, inner));
    }

    lines.push(this.empty(inner));
    lines.push(...this.bottom("j/k navigate • l/enter open • h/q close", inner));
    return lines;
  }

  private handleProjectsInput(data: string): void {
    const projects = this.projectNames();
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selIdx--;
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selIdx++;
    else if ((matchesKey(data, Key.enter) || matchesKey(data, "l")) && projects[this.selIdx]) {
      this.selProject = projects[this.selIdx];
      this.selIdx = 0;
      this.scrollOff = 0;
      this.searchBuf = "";
      this.view = "list";
    } else if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone();
      return;
    }
    this.clamp(projects.length);
    this.touch();
  }

  // ---- List view ---------------------------------------------------------

  private renderList(width: number): string[] {
    const inner = width - 2;
    const rows = this.items();
    const rowHeight = 2;
    const visibleItems = Math.max(3, Math.floor((this.maxBodyRows() - (this.searchMode ? 2 : 0)) / rowHeight));
    this.clamp(rows.length, visibleItems);

    const title = `${this.a(this.bold(this.selProject ?? "all projects"))} ${this.m(`${rows.length} memories`)}`;
    const lines = [this.top(title, inner)];

    if (this.searchMode) {
      const query = this.searchBuf ? this.a(this.searchBuf) : this.d("type to filter...");
      lines.push(this.row(`${this.a("/")} ${query}${this.a("█")}`, inner));
      lines.push(this.b("├") + this.b("─".repeat(inner)) + this.b("┤"));
    }

    if (rows.length === 0) {
      lines.push(this.empty(inner));
      lines.push(this.row(this.d(this.searchBuf ? "No memories match this search." : "No memories in this project."), inner));
      lines.push(this.empty(inner));
      lines.push(...this.bottom("backspace projects • q close", inner));
      return lines;
    }

    const slice = rows.slice(this.scrollOff, this.scrollOff + visibleItems);
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const selected = this.scrollOff + i === this.selIdx;
      const marker = selected ? this.a("▸") : this.d(" ");
      const titleLeft = `${marker} ${this.fmtType(row.type)} ${this.bold(row.title)}`;
      const meta = `${this.fmtPriority(row.priority)} ${this.d(`#${row.id}`)} ${this.m((row.updated_at ?? "").slice(0, 10))}`;
      const titleGap = Math.max(1, inner - 2 - visibleWidth(titleLeft) - visibleWidth(meta));
      lines.push(this.row(titleLeft + " ".repeat(titleGap) + meta, inner));

      const topic = row.topic_key ? `${this.d("↳")} ${this.m(row.topic_key)}` : this.preview(row.content ?? "", inner - 6);
      lines.push(this.row(`  ${this.d(topic)}`, inner));
    }

    const position = rows.length > 0 ? `${this.selIdx + 1}/${rows.length}` : "";
    const baseHints = this.searchMode
      ? "enter apply • backspace delete • esc cancel"
      : "j/k navigate • l/enter detail • h projects • / search • q close";
    const hints = position ? `${baseHints} • ${position}` : baseHints;
    lines.push(...this.bottom(hints, inner));
    return lines;
  }

  private handleListInput(data: string): void {
    const rows = this.items();

    if (this.searchMode) {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) this.searchMode = false;
      else if (matchesKey(data, Key.backspace)) this.searchBuf = this.searchBuf.slice(0, -1);
      else if (data.length === 1 && data.charCodeAt(0) >= 32) this.searchBuf += data;
      this.selIdx = 0;
      this.scrollOff = 0;
      this.touch();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selIdx--;
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selIdx++;
    else if (matchesKey(data, Key.home)) this.selIdx = 0;
    else if (matchesKey(data, Key.end)) this.selIdx = rows.length - 1;
    else if (matchesKey(data, Key.ctrl("u"))) this.selIdx -= Math.floor(this.maxBodyRows() / 2);
    else if (matchesKey(data, Key.ctrl("d"))) this.selIdx += Math.floor(this.maxBodyRows() / 2);
    else if ((matchesKey(data, Key.enter) || matchesKey(data, "l")) && rows[this.selIdx]) {
      this.viewing = rows[this.selIdx];
      this.detailScroll = 0;
      this.view = "detail";
    } else if (matchesKey(data, "/")) {
      this.searchMode = true;
      this.searchBuf = "";
    } else if (matchesKey(data, Key.backspace) || matchesKey(data, "h")) {
      this.selProject = null;
      this.selIdx = 0;
      this.scrollOff = 0;
      this.view = "projects";
    } else if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone();
      return;
    }

    this.clamp(this.items().length);
    this.touch();
  }

  // ---- Detail view -------------------------------------------------------

  private renderDetail(width: number): string[] {
    const row = this.viewing;
    if (!row) return this.renderList(width);

    const inner = width - 2;
    const contentWidth = Math.max(24, inner - 4);
    const title = `${this.fmtType(row.type)} ${this.bold(row.title)} ${this.m(`#${row.id}`)}`;
    const lines = [this.top(title, inner)];

    const metaPairs = [
      ["priority", `${this.fmtPriority(row.priority)} ${this.m(`p${row.priority}`)}`],
      ["type", this.m(row.type)],
      ["scope", this.m(row.scope)],
      ["topic", row.topic_key ? this.a("↳ ") + this.m(row.topic_key) : this.d("-")],
      ["updated", this.m((row.updated_at ?? "").slice(0, 16) || "-")],
    ];

    for (const [label, value] of metaPairs) {
      lines.push(this.row(`${this.d(label.padEnd(9, " "))} ${value}`, inner));
    }

    lines.push(this.b("├") + this.b("─".repeat(2)) + this.m(" content ") + this.b("─".repeat(Math.max(0, inner - 11))) + this.b("┤"));

    const mdLines = this.renderMarkdownLines(row, contentWidth);
    const visibleContentRows = Math.max(5, this.maxBodyRows() - metaPairs.length - 2);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, mdLines.length - visibleContentRows)));
    const visible = mdLines.slice(this.detailScroll, this.detailScroll + visibleContentRows);

    for (const contentLine of visible) {
      lines.push(this.row(`  ${contentLine}`, inner));
    }

    const remaining = visibleContentRows - visible.length;
    for (let i = 0; i < remaining; i++) lines.push(this.empty(inner));

    const pos = mdLines.length > visibleContentRows
      ? `${this.detailScroll + 1}-${Math.min(this.detailScroll + visibleContentRows, mdLines.length)}/${mdLines.length}`
      : "";
    const hints = `j/k scroll • h back • l noop • backspace back • q close${pos ? ` • ${pos}` : ""}`;
    lines.push(...this.bottom(hints, inner));
    return lines;
  }

  private handleDetailInput(data: string): void {
    const maxScroll = Number.MAX_SAFE_INTEGER;

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.detailScroll = Math.max(0, this.detailScroll - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.detailScroll = Math.min(maxScroll, this.detailScroll + 1);
    else if (matchesKey(data, Key.ctrl("u"))) this.detailScroll = Math.max(0, this.detailScroll - Math.floor(this.maxBodyRows() / 2));
    else if (matchesKey(data, Key.ctrl("d"))) this.detailScroll = Math.min(maxScroll, this.detailScroll + Math.floor(this.maxBodyRows() / 2));
    else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape) || matchesKey(data, "h")) {
      this.view = "list";
      this.viewing = null;
      this.detailScroll = 0;
    } else if (matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone();
      return;
    }
    this.touch();
  }
}

