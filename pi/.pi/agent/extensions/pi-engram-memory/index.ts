import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { Box, Container, Text, Spacer, truncateToWidth, visibleWidth, matchesKey, Key, Markdown } from "@earendil-works/pi-tui";
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
const AUTO_SAVE_PROMPTS = process.env.PI_MEMORY_AUTO_SAVE_PROMPTS !== "0";
const MAX_RECALL_CHARS = Number(process.env.PI_MEMORY_MAX_RECALL_CHARS ?? "1000");
const MIN_PROMPT_CHARS = Math.max(0, Number(process.env.PI_MEMORY_MIN_PROMPT_CHARS ?? "20"));
const SQLITE_TIMEOUT_MS = Number(process.env.PI_MEMORY_SQLITE_TIMEOUT_MS ?? "8000");

const VALID_TYPES = ["architecture", "bugfix", "config", "decision", "discovery", "learning", "preference", "prompt"] as const;

// Default priority by type: higher = more important, more likely to auto-recall
const DEFAULT_PRIORITY: Record<string, number> = {
  architecture: 4,
  bugfix: 4,
  decision: 4,
  config: 3,
  discovery: 2,
  learning: 2,
  preference: 1,
  prompt: 1,
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
  return query
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

/** First ~N chars of content as a compact snippet. */
function snip(content: string, maxLen = 120): string {
  if (!content) return "";
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + "...";
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

async function execSql(pi: ExtensionAPI, sqlText: string, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const tmpFile = join(
    dirname(DB_PATH),
    `.pi-tmp-${process.pid}-${randomUUID().slice(0, 8)}.sql`,
  );
  const body = `${sqlText.trim()}\n`;
  await writeFile(tmpFile, body, "utf8");
  try {
    const result = await pi.exec(SQLITE_BIN, [DB_PATH, `.read ${tmpFile}`], {
      signal,
      timeout: SQLITE_TIMEOUT_MS,
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
 * - Priority defaults by type: arch/bugfix/decision=4, config=3, discovery/learning=2, preference/prompt=1.
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
  const limit = Math.max(1, Math.min(Number(params.limit ?? 8), 15));

  // Exact lookup by ID
  if (typeof params.id === "number") {
    const rows = await sqliteJson<ObservationRow>(
      pi,
      `SELECT * FROM observations WHERE id=${sql(params.id)} AND deleted_at IS NULL LIMIT 1;`,
      signal,
    );
    if (!rows[0]) return { ok: false, error: `Observation #${params.id} not found.`, project: info.project };
    return {
      ok: true,
      project: rows[0].project,
      result: [formatRow(rows[0], true)].join("\n"),
    };
  }

  // Build WHERE clause
  const query = String(params.query ?? "").trim();
  const typeFilter = params.type?.trim();
  const priorityMin = Math.max(0, Math.min(5, Number(params.priority_min ?? 0)));

  const clauses: string[] = ["o.deleted_at IS NULL", `o.project=${sql(info.project)}`];

  if (query) {
    const terms = extractTerms(query);
    if (terms.length > 0) {
      const likeClauses = terms.map(
        (t) => `(o.title LIKE '%' || ${sql(t)} || '%' OR o.content LIKE '%' || ${sql(t)} || '%')`,
      );
      clauses.push(`(${likeClauses.join(" OR ")})`);
    }
  }

  if (typeFilter) clauses.push(`o.type=${sql(typeFilter)}`);
  if (priorityMin > 0) clauses.push(`o.priority>=${sql(priorityMin)}`);

  const where = clauses.join(" AND ");
  const rows = await sqliteJson<ObservationRow>(
    pi,
    `SELECT o.* FROM observations o WHERE ${where} ORDER BY o.priority DESC, o.updated_at DESC LIMIT ${sql(limit)};`,
    signal,
  );

  if (rows.length === 0) return { ok: true, project: info.project, result: "No memories found." };

  const formatted = rows.map((r) => formatRow(r, includeContent)).join("\n\n---\n\n");
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
// Auto-save prompt helper
// ---------------------------------------------------------------------------

function shouldSavePrompt(content: string): boolean {
  const p = content.trim();
  if (p.length < MIN_PROMPT_CHARS) return false;
  if (/^(y|yes|s[ií]|ok|okay|dale|go|segu[ií]|contin[uú]a|gracias|thanks|no|next|done|listo|hecho)$/i.test(p)) return false;
  return true;
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

  // --- Auto recall + auto save prompts -----------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await ensureDb(pi);
      const info = await detectProject(pi, ctx);
      await ensureSession(pi, info);
      lastProjectInfo = info;

      const prompt = String(event.prompt ?? "").trim();
      if (!prompt || prompt.startsWith("/")) return;

      // Auto-save prompt as low-priority memory (type=prompt, priority=1)
      if (AUTO_SAVE_PROMPTS && shouldSavePrompt(prompt)) {
        const cleaned = redactSecrets(prompt);
        const pTitle = `Prompt: ${cleaned.slice(0, 60)}${cleaned.length > 60 ? "..." : ""}`;
        const pHash = normalizedHash(pTitle, cleaned, "prompt", "project", info.project);
        const exists = await sqliteJson<{ id: number }>(
          pi,
          `SELECT id FROM observations WHERE normalized_hash=${sql(pHash)} AND deleted_at IS NULL LIMIT 1;`,
        );
        if (!exists[0]?.id) {
          await sqlite(
            pi,
            `INSERT INTO observations(session_id, type, title, content, priority, scope, normalized_hash, project) VALUES (${sql(currentSessionId)}, 'prompt', ${sql(pTitle)}, ${sql(cleaned)}, 1, 'project', ${sql(pHash)}, ${sql(info.project)});`,
          );
        }
      }

      // Auto-recall: only memories with priority >= 3
      if (!AUTO_RECALL) return;

      const terms = extractTerms(prompt);
      if (terms.length === 0) return;

      const likeClauses = terms.map(
        (t) =>
          `(o.title LIKE '%' || ${sql(t)} || '%' OR o.content LIKE '%' || ${sql(t)} || '%')`,
      );
      const rows = await sqliteJson<ObservationRow>(
        pi,
        `SELECT o.* FROM observations o WHERE o.deleted_at IS NULL AND o.project=${sql(info.project)} AND o.priority>=3 AND (${likeClauses.join(" OR ")}) ORDER BY o.priority DESC, o.updated_at DESC LIMIT 5;`,
      );
      if (rows.length === 0) return;

      const recalled = rows
        .map(
          (r) =>
            `[${r.type}] ${r.title} (p${r.priority})\n  topic: ${r.topic_key ?? "-"}\n  ${snip(r.content ?? "", 100)}`,
        )
        .join("\n\n");

      const block = clip(recalled, 1000);

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n# Local persistent memory recall\n` +
          `These are local memories retrieved for the current prompt. Use only when relevant. Do not expose secrets.\n\n` +
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
      "Save or update (via topic_key) an observation. Types: architecture, bugfix, config, decision, discovery, learning, preference, prompt. Priority 1-5 assigned by type unless provided.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title, max 80 chars" }),
      content: Type.String({ description: "Structured body describing the observation" }),
      type: Type.Optional(
        Type.String({
          description:
            "Type: architecture|bugfix|config|decision|discovery|learning|preference|prompt",
        }),
      ),
      priority: Type.Optional(
        Type.Number({
          description:
            "Importance 1-5. Default by type: arch/bugfix/decision=4, config=3, discovery/learning=2, preference/prompt=1",
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
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // --- Tool: mem_search --------------------------------------------------
  pi.registerTool({
    name: "mem_search",
    label: "Search Memory",
    description:
      "Search observations or get recent context. Omit query for recent. Pass id for exact lookup.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search terms (optional; omit for recent)" })),
      type: Type.Optional(Type.String({ description: "Filter by type" })),
      priority_min: Type.Optional(
        Type.Number({ description: "Minimum priority 1-5 (default 0 = no filter)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results 1-15 (default 8)" })),
      id: Type.Optional(Type.Number({ description: "Get observation by exact ID" })),
      include_content: Type.Optional(
        Type.Boolean({ description: "Return full content instead of snippets" }),
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
        const result = await handleSearch(pi, ctx, { query, limit: 8 });
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
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
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
            `Auto save prompts: ${AUTO_SAVE_PROMPTS}`,
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
        }, { overlay: true });
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
// Box-drawing borders, theme tokens, three-view navigation:
//   projects -> list (per-project) -> detail (full memory)
// ---------------------------------------------------------------------------
// MemoryBrowser TUI component
// Rounded borders, theme tokens, three-view navigation:
//   projects -> list (per-project) -> detail (full memory)
// Proper caching with version tracking for smooth rendering.
// ---------------------------------------------------------------------------

type MemView = "projects" | "list" | "detail";

class MemoryBrowser implements Component {
  private view: MemView = "projects";
  private selProject: string | null = null;
  private selIdx = 0;
  private scrollOff = 0;
  private viewing: ObservationRow | null = null;
  private searchMode = false;
  private searchBuf = "";

  // Render cache
  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];
  private version = 0;

  // Markdown renderer for detail view content
  private mdRenderer: Markdown | null = null;
  private mdContentKey = "";

  constructor(
    private all: ObservationRow[],
    private tui: any,
    private theme: any,
    private onDone: () => void,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedVersion = -1;
    this.cachedLines = [];
  }

  render(w: number): string[] {
    if (this.cachedWidth === w && this.cachedVersion === this.version) {
      return this.cachedLines;
    }
    let lines: string[];
    switch (this.view) {
      case "projects": lines = this.renderProjects(w); break;
      case "list":     lines = this.renderList(w); break;
      case "detail":   lines = this.renderDetail(w); break;
      default:         lines = [];
    }
    this.cachedWidth = w;
    this.cachedVersion = this.version;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    this.version++;
    switch (this.view) {
      case "projects": this.handleProjectsInput(data); break;
      case "list":     this.handleListInput(data); break;
      case "detail":   this.handleDetailInput(data); break;
    }
  }

  // ---- theme shorthand ---------------------------------------------------

  private paint(token: string, s: string): string {
    if (this.theme && typeof this.theme.fg === "function") {
      return this.theme.fg(token, s);
    }
    return s;
  }

  private a(s: string): string { return this.paint("accent", s); }
  private m(s: string): string { return this.paint("muted", s); }
  private d(s: string): string { return this.paint("dim", s); }
  private b(s: string): string { return this.paint("border", s); }
  private ba(s: string): string { return this.paint("borderAccent", s); }
  private ok(s: string): string { return this.paint("success", s); }
  private err(s: string): string { return this.paint("error", s); }
  private warn(s: string): string { return this.paint("warning", s); }
  private bold(s: string): string {
    if (this.theme && typeof this.theme.bold === "function") {
      return this.theme.bold(s);
    }
    return s;
  }

  // ---- helpers -----------------------------------------------------------

  private maxVis(): number {
    return Math.max(3, (process.stdout.rows || 24) - 8);
  }

  private clamp(n: number): void {
    if (this.selIdx >= n) this.selIdx = Math.max(0, n - 1);
    if (this.selIdx < 0) this.selIdx = 0;
    const mv = this.maxVis();
    if (this.selIdx < this.scrollOff) this.scrollOff = this.selIdx;
    else if (this.selIdx >= this.scrollOff + mv) this.scrollOff = this.selIdx - mv + 1;
  }

  private projectNames(): string[] {
    const s = new Set(this.all.map((r) => r.project || "?"));
    return [...s].sort();
  }

  private projectStats(): Map<string, { count: number; high: number }> {
    const m = new Map<string, { count: number; high: number }>();
    for (const r of this.all) {
      const p = r.project || "?";
      const e = m.get(p) ?? { count: 0, high: 0 };
      e.count++;
      if (r.priority >= 3) e.high++;
      m.set(p, e);
    }
    return m;
  }

  private items(): ObservationRow[] {
    let list = this.selProject
      ? this.all.filter((r) => r.project === this.selProject)
      : this.all;
    if (!this.searchBuf) return list;
    const q = this.searchBuf.toLowerCase();
    return list.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.content ?? "").toLowerCase().includes(q) ||
        (r.type ?? "").toLowerCase().includes(q) ||
        (r.topic_key ?? "").toLowerCase().includes(q),
    );
  }

  /** Render a compact type badge with semantic color. */
  private fmtType(type: string): string {
    const labels: Record<string, string> = {
      architecture: this.bold(this.a("arch")),
      bugfix:       this.err("bug"),
      config:       this.a("conf"),
      decision:     this.warn("deci"),
      discovery:    this.a("disc"),
      learning:     this.ok("lear"),
      preference:   this.d("pref"),
      prompt:       this.d("prom"),
    };
    return labels[type] ?? this.d(type.slice(0, 4));
  }

  /** Priority rendered as filled/empty circles. */
  private fmtPriority(p: number): string {
    const filled = "●".repeat(p);
    const empty = "○".repeat(5 - p);
    return `${filled}${empty}`;
  }

  /** Truncate a string with ellipsis, respecting ANSI codes. */
  private snip(text: string, maxLen: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const vis = visibleWidth(flat);
    if (vis <= maxLen) return flat;
    return truncateToWidth(flat, Math.max(3, maxLen - 3)) + "...";
  }

  /** Scroll position indicator like "8/42". */
  private scrollInfo(total: number): string {
    if (total <= 1) return "";
    const shown = Math.min(total, this.maxVis());
    const end = Math.min(this.scrollOff + shown, total);
    return `${this.scrollOff + 1}-${end}/${total}`;
  }

  /** Render a separator line with label. */
  private sep(label: string, iw: number): string {
    const lbl = label ? ` ${label} ` : "";
    const pad = Math.max(0, iw - visibleWidth(lbl));
    return this.d("─".repeat(Math.floor(pad / 2))) +
           this.m(lbl) +
           this.d("─".repeat(Math.ceil(pad / 2)));
  }

  // ---- View: project list ------------------------------------------------

  private renderProjects(w: number): string[] {
    const projs = this.projectNames();
    const stats = this.projectStats();
    this.clamp(projs.length);
    const mv = this.maxVis();
    const iw = w - 2;
    const lines: string[] = [];

    // Header with rounded corners
    lines.push(
      this.b("\u256D") + this.a(this.bold(" engram ")) + this.m("projects") +
      this.b("\u2500".repeat(Math.max(0, iw - 16))) + this.b("\u256E"),
    );

    // Empty state
    if (projs.length === 0) {
      lines.push(this.b("\u2502") + "  " + this.d("No memories yet."));
      lines.push(this.b("\u2570") + this.b("\u2500".repeat(iw)) + this.b("\u256F"));
      lines.push(this.d(" q close"));
      return lines;
    }

    // Project list
    const slice = projs.slice(this.scrollOff, this.scrollOff + mv);
    for (let i = 0; i < slice.length; i++) {
      const name = slice[i];
      const info = stats.get(name)!;
      const idx = this.scrollOff + i;
      const sel = idx === this.selIdx;
      const arrow = sel ? this.a("\u25B6") : " ";
      const label = `${this.b("\u2502")} ${arrow} ${this.bold(name)}`;
      const countS = ` ${info.count} mem  ${info.high} \u2605`;
      const pad = Math.max(1, iw - visibleWidth(label) - visibleWidth(countS));
      lines.push(label + " ".repeat(pad) + this.d(countS));
    }

    lines.push(this.b("\u2570") + this.b("\u2500".repeat(iw)) + this.b("\u256F"));

    // Footer with scroll position and keyboard hints
    const scrollS = this.scrollInfo(projs.length);
    const hints = "\u2191/\u2193 j/k nav  \u23CE select  q close";
    if (scrollS) {
      const hintPad = Math.max(1, iw - visibleWidth(hints) - visibleWidth(scrollS));
      lines.push(this.d(hints) + " ".repeat(hintPad) + this.m(scrollS));
    } else {
      lines.push(this.d(hints));
    }
    return lines;
  }

  private handleProjectsInput(data: string): void {
    const projs = this.projectNames();
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selIdx = Math.max(0, this.selIdx - 1); this.version++; return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selIdx = Math.min(projs.length - 1, this.selIdx + 1); this.version++; return;
    }
    if (matchesKey(data, Key.enter) && projs[this.selIdx]) {
      this.selProject = projs[this.selIdx];
      this.selIdx = 0; this.scrollOff = 0; this.view = "list"; this.version++;
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone();
    }
  }

  // ---- View: memory list -------------------------------------------------

  private renderList(w: number): string[] {
    const list = this.items();
    this.clamp(list.length);
    const mv = this.maxVis();
    const iw = w - 2;
    const lines: string[] = [];

    // Header
    const projL = this.selProject ? ` ${this.selProject} ` : " all ";
    const cntL = ` ${list.length} `;
    const headPad = Math.max(1, iw - visibleWidth(projL) - visibleWidth(cntL));
    lines.push(
      this.b("\u256D") + this.a(this.bold(projL)) + this.m(cntL) +
      this.b("\u2500".repeat(headPad)) + this.b("\u256E"),
    );

    // Search bar
    if (this.searchMode) {
      const searchPrefix = this.a("\u2315");
      const searchContent = this.searchBuf ? this.a(this.searchBuf) : this.d("type to filter...");
      const cursor = this.a("\u2588");
      const searchLine = `${this.b("\u2502")} ${searchPrefix} ${searchContent}${cursor}`;
      const searchPad = Math.max(0, iw - visibleWidth(searchLine) + 1);
      lines.push(searchLine + " ".repeat(searchPad));
    }

    // Empty state
    if (list.length === 0) {
      lines.push(this.b("\u2502") + "  " + this.d(this.searchBuf ? "No memories match your search." : "No memories in this project."));
      lines.push(this.b("\u2570") + this.b("\u2500".repeat(iw)) + this.b("\u256F"));
      lines.push(this.d(" \u232B back  q close"));
      return lines;
    }

    // Memory rows
    const slice = list.slice(this.scrollOff, this.scrollOff + mv);
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const idx = this.scrollOff + i;
      const sel = idx === this.selIdx;
      const arrow = sel ? this.a("\u25B6") : " ";

      // Row 1: Selection arrow + type badge + title + priority + date
      const tag = this.fmtType(row.type);
      const titleS = `${this.b("\u2502")} ${arrow} ${tag} ${this.bold(row.title)}`;
      const metaS = this.d(`${this.fmtPriority(row.priority)} ${(row.updated_at ?? "").slice(0, 10)}`);
      const metaL = visibleWidth(metaS);
      const avail = iw - 1 - visibleWidth(titleS) - metaL;
      lines.push(titleS + (avail > 0 ? " ".repeat(avail) : "") + metaS);

      // Row 2: Topic key (if present)
      if (row.topic_key) {
        const topicContent = `${this.b("\u2502")}    ${this.d("\u21B7")} ${this.m(row.topic_key)}`;
        lines.push(topicContent);
      }

      // Row 3: Content snippet
      const snip = (row.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (snip) {
        const snippetContent = `${this.b("\u2502")}    ${this.d(snip + (snip.length >= 80 ? "..." : ""))}`;
        lines.push(snippetContent);
      }

      // Row 4: Separator between entries
      lines.push(`${this.b("\u2502")}`);
    }

    lines.push(this.b("\u2570") + this.b("\u2500".repeat(iw)) + this.b("\u256F"));

    // Footer
    const scrollS = this.scrollInfo(list.length);
    if (this.searchMode) {
      const hints = "\u23CE apply  \u232B backspace  \u238B esc cancel";
      const hintPad = scrollS ? Math.max(1, iw - visibleWidth(hints) - visibleWidth(scrollS)) : 0;
      lines.push(this.d(hints) + (hintPad > 0 ? " ".repeat(hintPad) : "") + (scrollS ? this.m(scrollS) : ""));
    } else {
      const hints = "\u2191/\u2193 j/k nav  \u23CE view  / search  \u232B back  q close";
      const hintPad = scrollS ? Math.max(1, iw - visibleWidth(hints) - visibleWidth(scrollS)) : 0;
      lines.push(this.d(hints) + (hintPad > 0 ? " ".repeat(hintPad) : "") + (scrollS ? this.m(scrollS) : ""));
    }
    return lines;
  }

  private handleListInput(data: string): void {
    const list = this.items();

    if (this.searchMode) {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        this.searchMode = false; this.selIdx = 0; this.scrollOff = 0; this.version++; return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.searchBuf = this.searchBuf.slice(0, -1); this.selIdx = 0; this.scrollOff = 0; this.version++; return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
        this.searchBuf += data; this.selIdx = 0; this.scrollOff = 0; this.version++; return;
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) { this.selIdx = Math.max(0, this.selIdx - 1); this.version++; return; }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) { this.selIdx = Math.min(list.length - 1, this.selIdx + 1); this.version++; return; }
    if (matchesKey(data, Key.enter) && list[this.selIdx]) {
      this.viewing = list[this.selIdx]; this.view = "detail"; this.version++; return;
    }
    if (matchesKey(data, "/")) { this.searchMode = true; this.searchBuf = ""; this.version++; return; }
    if (matchesKey(data, Key.backspace)) {
      this.selProject = null; this.selIdx = 0; this.scrollOff = 0; this.view = "projects"; this.version++; return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone(); return;
    }
    if (matchesKey(data, Key.home)) { this.selIdx = 0; this.scrollOff = 0; this.version++; return; }
    if (matchesKey(data, Key.end)) { this.selIdx = list.length - 1; this.version++; return; }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.selIdx = Math.max(0, this.selIdx - Math.floor((process.stdout.rows || 24) / 2)); this.version++; return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      this.selIdx = Math.min(list.length - 1, this.selIdx + Math.floor((process.stdout.rows || 24) / 2)); this.version++; return;
    }
  }

  // ---- View: detail ------------------------------------------------------

  private renderDetail(w: number): string[] {
    const row = this.viewing!;
    const iw = Math.max(40, w - 2);
    const lines: string[] = [];

    // Header with type badge, title, priority
    const tag = this.fmtType(row.type);
    const titleS = ` ${tag} ${row.title} `;
    const idS = this.m(`#${row.id}`);
    const headerL = `${this.bold(titleS)} ${idS}`;
    const headerPad = Math.max(1, iw - visibleWidth(headerL));
    lines.push(
      this.b("\u256D") + headerL + " ".repeat(headerPad) + this.b("\u256E"),
    );

    // Metadata section
    const labelW = 10;

    // Priority row
    const pFilled = "●".repeat(row.priority);
    const pEmpty = "○".repeat(5 - row.priority);
    const pStr = row.priority >= 3 ? this.ok(pFilled) + this.d(pEmpty) : this.d(pFilled + pEmpty);
    lines.push(`${this.b("\u2502")}  ${this.d("priority".padEnd(labelW, " "))}${pStr}  ${this.m(`p${row.priority}`)}`);

    // Type row
    lines.push(`${this.b("\u2502")}  ${this.d("type".padEnd(labelW, " "))}${this.m(row.type)}`);

    // Scope row
    lines.push(`${this.b("\u2502")}  ${this.d("scope".padEnd(labelW, " "))}${this.m(row.scope)}`);

    // Topic row
    if (row.topic_key) {
      lines.push(`${this.b("\u2502")}  ${this.d("topic".padEnd(labelW, " "))}${this.a("\u21B7")} ${this.m(row.topic_key)}`);
    }

    // Dates
    const createdStr = (row.created_at ?? "").slice(0, 16) || "-";
    const updatedStr = (row.updated_at ?? "").slice(0, 16) || "-";
    lines.push(`${this.b("\u2502")}  ${this.d("created".padEnd(labelW, " "))}${this.m(createdStr)}`);
    lines.push(`${this.b("\u2502")}  ${this.d("updated".padEnd(labelW, " "))}${this.m(updatedStr)}`);

    // Revision / duplicate info
    if (row.revision_count > 0 || row.duplicate_count > 0) {
      const revParts: string[] = [];
      if (row.revision_count > 0) revParts.push(`${row.revision_count} rev`);
      if (row.duplicate_count > 0) revParts.push(`${row.duplicate_count} dup`);
      lines.push(`${this.b("\u2502")}  ${this.d("revisions".padEnd(labelW, " "))}${this.m(revParts.join(", "))}`);
    }

    // Separator
    lines.push(this.b("\u2502") + "  " + this.sep("content", iw - 3));

    // Content section — rendered as Markdown with syntax highlighting
    const contentRaw = row.content ?? "";
    const contentKey = `${row.id}-${(row.updated_at ?? "")}`;
    if (contentRaw) {
      const contentW = iw - 3;
      // Re-create markdown renderer only if content changed
      if (!this.mdRenderer || this.mdContentKey !== contentKey) {
        this.mdRenderer = new Markdown(contentRaw, 0, 0, getMarkdownTheme());
        this.mdContentKey = contentKey;
      }
      const mdLines = this.mdRenderer.render(contentW);
      for (const cl of mdLines) {
        lines.push(`${this.b("\u2502")}  ${cl}`);
      }
    } else {
      lines.push(`${this.b("\u2502")}  ${this.d("(no content)")}`);
    }

    lines.push(this.b("\u2570") + this.b("\u2500".repeat(iw)) + this.b("\u256F"));
    lines.push(this.d(" \u232B back  q close"));
    return lines;
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape)) {
      this.view = "list"; this.viewing = null; this.version++; return;
    }
    if (matchesKey(data, "q") || matchesKey(data, "Q")) {
      this.onDone();
    }
  }
}


