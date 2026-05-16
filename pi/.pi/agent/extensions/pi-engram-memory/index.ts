import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key, Markdown } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
  ACTIVE_STATUSES,
  AUTO_CAPTURE,
  AUTO_RECALL,
  DB_PATH,
  MAX_RECALL_CHARS,
  MAX_RECALL_ITEMS,
  PERSONAL_PROJECT,
  SQLITE_BIN,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_TIMEOUT_MS,
  VALID_TYPES,
} from "./config.js";
import { formatRowHeader, formatRowMetadata, formatRowMinimal, formatSaveResult } from "./format.js";
import { memoryToolRenderer } from "./tool-renderers.js";
import type { ObservationRow, ProjectInfo, SearchRowsResult } from "./types.js";
import {
  cleanInline,
  clip,
  cropPlain,
  defaultPriority,
  extractTerms,
  ftsMatchQuery,
  keywordCoverageSql,
  keywordScoreSql,
  listSummary,
  normalizedHash,
  normalizeProjectName,
  normalizeStringList,
  redactSecrets,
  slugifyTopic,
  snip,
  sql,
} from "./utils.js";

/**
 * engram - Compact persistent memory for Pi
 *
 * A lean memory extension inspired by Engram's concept of compact,
 * high-signal knowledge units. Stores structured observations with
 * priority scoring in local SQLite. Designed for token efficiency:
 * only 3 tools, optional SQLite FTS5, no prompt guidelines bloat.
 *
 * Default DB: ~/.pi/agent/memory/pi-memory.db
 * Requires: sqlite3 with WAL support (Arch: sudo pacman -S sqlite)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let ftsAvailable: boolean | null = null;
let currentSessionId = `pi-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
let lastProjectInfo: ProjectInfo | null = null;
let sqliteQueue: Promise<unknown> = Promise.resolve();
const projectCache = new Map<string, ProjectInfo>();

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
      tags TEXT,
      citations TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'active',
      verified_at TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    `,
    signal,
  );

  // Add columns individually so older databases migrate without failing startup.
  for (const statement of [
    "ALTER TABLE observations ADD COLUMN priority INTEGER NOT NULL DEFAULT 3;",
    "ALTER TABLE observations ADD COLUMN tags TEXT;",
    "ALTER TABLE observations ADD COLUMN citations TEXT;",
    "ALTER TABLE observations ADD COLUMN confidence REAL NOT NULL DEFAULT 0.8;",
    "ALTER TABLE observations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
    "ALTER TABLE observations ADD COLUMN verified_at TEXT;",
  ]) {
    try {
      await sqlite(pi, statement, signal);
    } catch {
      // Column already exists or cannot be added because the table is fresh.
    }
  }

  await sqlite(
    pi,
    `
    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_project_updated ON observations(project, updated_at);
    CREATE INDEX IF NOT EXISTS idx_obs_scope_project ON observations(scope, project, updated_at);
    CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(project, scope, topic_key);
    CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_obs_priority ON observations(project, priority);
    CREATE INDEX IF NOT EXISTS idx_obs_status ON observations(status, updated_at);
    `,
    signal,
  );

  await ensureFts(pi, signal);
  initialized = true;
}

/** Create and synchronize the optional SQLite FTS5 index. */
async function ensureFts(pi: ExtensionAPI, signal?: AbortSignal): Promise<void> {
  if (ftsAvailable !== null) return;

  try {
    await sqlite(
      pi,
      `
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title,
        topic_key,
        content,
        type,
        project UNINDEXED,
        scope UNINDEXED,
        tags,
        citations,
        content='observations',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS observations_fts_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, topic_key, content, type, project, scope, tags, citations)
        VALUES (new.id, new.title, COALESCE(new.topic_key, ''), new.content, new.type, new.project, new.scope, COALESCE(new.tags, ''), COALESCE(new.citations, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS observations_fts_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, topic_key, content, type, project, scope, tags, citations)
        VALUES ('delete', old.id, old.title, COALESCE(old.topic_key, ''), old.content, old.type, old.project, old.scope, COALESCE(old.tags, ''), COALESCE(old.citations, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS observations_fts_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, topic_key, content, type, project, scope, tags, citations)
        VALUES ('delete', old.id, old.title, COALESCE(old.topic_key, ''), old.content, old.type, old.project, old.scope, COALESCE(old.tags, ''), COALESCE(old.citations, ''));
        INSERT INTO observations_fts(rowid, title, topic_key, content, type, project, scope, tags, citations)
        VALUES (new.id, new.title, COALESCE(new.topic_key, ''), new.content, new.type, new.project, new.scope, COALESCE(new.tags, ''), COALESCE(new.citations, ''));
      END;

      INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
      `,
      signal,
    );
    ftsAvailable = true;
  } catch {
    // Some SQLite builds omit FTS5. Search falls back to weighted LIKE queries.
    ftsAvailable = false;
  }
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

  // 2. Git remote / git root. Use ctx.cwd explicitly because Pi may run
  // extension code from a different process working directory.
  try {
    const root = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
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
  const type = (VALID_TYPES as readonly string[]).includes(String(params.type ?? "")) ? String(params.type) : "discovery";
  const scope = params.scope === "personal" ? "personal" : "project";
  const memoryProject = scope === "personal" ? PERSONAL_PROJECT : info.project;
  const topic_key = params.topic_key?.trim() || undefined;
  const tags = normalizeStringList(params.tags);
  const citations = normalizeStringList(params.citations);
  const confidence = typeof params.confidence === "number"
    ? Math.max(0, Math.min(1, params.confidence))
    : 0.8;
  const status = ACTIVE_STATUSES.has(String(params.status ?? "active")) ? String(params.status ?? "active") : "active";
  const verifiedAt = params.verified_at?.trim() || undefined;

  if (!title) return { ok: false, error: "title is required" };
  if (!content) return { ok: false, error: "content is required" };
  if (title.length > 80) return { ok: false, error: "title must be 80 characters or less" };

  const priority =
    typeof params.priority === "number" && params.priority >= 1 && params.priority <= 5
      ? Math.round(params.priority)
      : defaultPriority(type);

  const hash = normalizedHash(title, content, type, scope, memoryProject);

  // Upsert by topic_key. Personal memories use a global namespace so they
  // can be recalled from every project without duplicating preferences.
  if (topic_key) {
    const projectClause = scope === "personal"
      ? "scope='personal'"
      : `project=${sql(memoryProject)} AND scope=${sql(scope)}`;
    const existing = await sqliteJson<{ id: number }>(
      pi,
      `SELECT id FROM observations WHERE ${projectClause} AND topic_key=${sql(topic_key)} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1;`,
      signal,
    );
    if (existing[0]?.id) {
      const id = existing[0].id;
      await sqlite(
        pi,
        `UPDATE observations SET type=${sql(type)}, priority=${sql(priority)}, title=${sql(title)}, content=${sql(content)}, normalized_hash=${sql(hash)}, project=${sql(memoryProject)}, tags=${sql(tags)}, citations=${sql(citations)}, confidence=${sql(confidence)}, status=${sql(status)}, verified_at=${sql(verifiedAt)}, revision_count=revision_count+1, last_seen_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(id)};`,
        signal,
      );
      return { ok: true, project: memoryProject, result: { id, action: "updated", topic_key, priority } };
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
    return { ok: true, project: memoryProject, result: { id: duplicate[0].id, action: "deduped" } };
  }

  // Insert
  const rows = await sqliteJson<{ id: number }>(
    pi,
    `INSERT INTO observations(session_id, type, title, content, priority, scope, topic_key, normalized_hash, project, tags, citations, confidence, status, verified_at) VALUES (${sql(currentSessionId)}, ${sql(type)}, ${sql(title)}, ${sql(content)}, ${sql(priority)}, ${sql(scope)}, ${sql(topic_key)}, ${sql(hash)}, ${sql(memoryProject)}, ${sql(tags)}, ${sql(citations)}, ${sql(confidence)}, ${sql(status)}, ${sql(verifiedAt)}); SELECT last_insert_rowid() AS id;`,
    signal,
  );

  return { ok: true, project: memoryProject, result: { id: rows[0]?.id, action: "inserted", priority } };
}

/**
 * mem_search: Search observations or get recent context.
 *
 * - Pass `id` for exact lookup (ignores all other filters).
 * - Omit `query` to get most recent results in the current project plus global personal scope.
 * - Pass `query` for FTS5 BM25 search with weighted LIKE fallback.
 * - Use `include_content` to get full content after a compact search result points to an ID.
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
    const idHead = formatRowHeader(row);
    const metadata = formatRowMetadata(row);
    const idBody = (row.content ?? "").trim();
    return {
      ok: true,
      project: row.project,
      result: [idHead, metadata, idBody].filter(Boolean).join("\n"),
    };
  }

  const { rows, backend } = await searchObservationRows(pi, info, params, signal);
  if (rows.length === 0) return { ok: true, project: info.project, result: "(no memories found)", backend };

  const formatted = rows.slice(0, limit).map((r) => formatRowMinimal(r, includeContent)).join("\n");
  return { ok: true, project: info.project, result: formatted, backend };
}

/** Search observations with FTS5 first, falling back to weighted LIKE. */
async function searchObservationRows(
  pi: ExtensionAPI,
  info: ProjectInfo,
  params: any,
  signal?: AbortSignal,
): Promise<SearchRowsResult> {
  const query = String(params.query ?? "").trim();
  const terms = query ? extractTerms(query) : [];
  const limit = Math.max(1, Math.min(Number(params.limit ?? 5), 50));
  const clauses = buildObservationClauses(info, params, terms);
  const where = clauses.length > 0 ? clauses.join(" AND ") : "1=1";

  if (terms.length > 0 && ftsAvailable) {
    const match = ftsMatchQuery(terms);
    if (match) {
      try {
        const rows = await sqliteJson<ObservationRow>(
          pi,
          `SELECT o.*,
                  snippet(observations_fts, 2, '', '', '...', 18) AS search_snippet,
                  bm25(observations_fts, 10.0, 6.0, 1.0, 1.0, 1.0, 3.0, 2.0, 2.0) AS fts_score
           FROM observations_fts
           JOIN observations o ON o.id=observations_fts.rowid
           WHERE observations_fts MATCH ${sql(match)} AND ${where}
           ORDER BY fts_score ASC, o.priority DESC, o.updated_at DESC
           LIMIT ${sql(limit)};`,
          signal,
        );
        return { rows, backend: "fts5" };
      } catch {
        // Invalid MATCH syntax or a stale FTS index should never break memory search.
      }
    }
  }

  const relevance = keywordScoreSql(terms);
  const coverage = keywordCoverageSql(terms);
  const order = terms.length > 0
    ? `ORDER BY relevance DESC, coverage DESC, o.priority DESC, o.updated_at DESC`
    : `ORDER BY o.priority DESC, o.updated_at DESC`;
  const rows = await sqliteJson<ObservationRow>(
    pi,
    `SELECT o.*, (${relevance}) AS relevance, (${coverage}) AS coverage FROM observations o WHERE ${where} ${order} LIMIT ${sql(limit)};`,
    signal,
  );
  return { rows, backend: terms.length > 0 ? "like" : "recent" };
}

/** Build the non-FTS filters shared by tool search, auto-recall, and commands. */
function buildObservationClauses(info: ProjectInfo, params: any, terms: string[]): string[] {
  const clauses: string[] = ["o.deleted_at IS NULL"];
  const scopeFilter = String(params.scope ?? "").trim();
  const projectFilter = params.project?.trim() ? normalizeProjectName(params.project.trim()) : "";

  if (projectFilter) {
    clauses.push(`o.project=${sql(projectFilter)}`);
  } else if (scopeFilter === "personal") {
    clauses.push("o.scope='personal'");
  } else if (scopeFilter === "project") {
    clauses.push(`o.scope='project' AND o.project=${sql(info.project)}`);
  } else {
    clauses.push(`((o.scope='project' AND o.project=${sql(info.project)}) OR o.scope='personal')`);
  }

  const typeFilter = params.type?.trim();
  if (typeFilter) clauses.push(`o.type=${sql(typeFilter)}`);

  const priorityMin = Math.max(0, Math.min(5, Number(params.priority_min ?? 2)));
  if (priorityMin > 0) clauses.push(`o.priority>=${sql(priorityMin)}`);

  const status = params.status?.trim();
  if (status) clauses.push(`o.status=${sql(status)}`);
  else clauses.push("COALESCE(o.status, 'active')!='superseded'");

  if (params.updated_after?.trim()) clauses.push(`o.updated_at>=${sql(params.updated_after.trim())}`);

  const tags = Array.isArray(params.tags)
    ? params.tags.map((tag: unknown) => cleanInline(String(tag))).filter(Boolean)
    : params.tags ? [cleanInline(String(params.tags))] : [];
  for (const tag of tags.slice(0, 8)) {
    clauses.push(`lower(COALESCE(o.tags, '')) LIKE '%' || ${sql(tag.toLowerCase())} || '%'`);
  }

  if (terms.length > 0) {
    const likeClauses = terms.map((term) => {
      const q = sql(term);
      return `(lower(o.title) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' OR lower(o.content) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.tags, '')) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.citations, '')) LIKE '%' || ${q} || '%')`;
    });
    const minCoverage = terms.length >= 4 ? 2 : 1;
    clauses.push(`(${likeClauses.join(" OR ")})`);
    clauses.push(`(${keywordCoverageSql(terms)})>=${sql(minCoverage)}`);
  }

  return clauses;
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

    const deleteScope = `(project=${sql(info.project)} OR scope='personal')`;

    if (params.hard) {
      const rows = await sqliteJson<{ changed: number }>(
        pi,
        `DELETE FROM observations WHERE id=${sql(id)} AND ${deleteScope}; SELECT changes() AS changed;`,
        signal,
      );
      const changed = Number(rows[0]?.changed ?? 0);
      return { ok: true, project: info.project, result: { id, action: changed > 0 ? "hard_deleted" : "not_found" } };
    }

    const rows = await sqliteJson<{ changed: number }>(
      pi,
      `UPDATE observations SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=${sql(id)} AND ${deleteScope} AND deleted_at IS NULL; SELECT changes() AS changed;`,
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
        `INSERT INTO sessions(id, project, directory, started_at, ended_at, status) VALUES (${sql(sess.id)}, ${sql(sess.project)}, ${sql(sess.directory)}, COALESCE(${sql(sess.started_at)}, datetime('now')), ${sql(sess.ended_at)}, COALESCE(${sql(sess.status)}, 'imported')) ON CONFLICT(id) DO UPDATE SET project=excluded.project, directory=excluded.directory, ended_at=COALESCE(excluded.ended_at, sessions.ended_at), status=excluded.status;`,
        signal,
      );
      importedSess++;
    }

    for (const obs of observations) {
      const title = String(obs?.title ?? "").trim();
      const content = String(obs?.content ?? "").trim();
      const project = normalizeProjectName(String(obs?.project ?? info.project));
      if (!title || !content || !project) continue;
      const type = (VALID_TYPES as readonly string[]).includes(String(obs?.type ?? "")) ? String(obs.type) : "discovery";
      const scope = obs?.scope === "personal" ? "personal" : "project";
      const memoryProject = scope === "personal" ? PERSONAL_PROJECT : project;
      const topic_key = obs?.topic_key?.trim() || undefined;
      const tags = normalizeStringList(obs?.tags);
      const citations = normalizeStringList(obs?.citations);
      const confidence = typeof obs?.confidence === "number" ? Math.max(0, Math.min(1, obs.confidence)) : 0.8;
      const status = ACTIVE_STATUSES.has(String(obs?.status ?? "active")) ? String(obs?.status ?? "active") : "active";
      const hash = normalizedHash(title, content, type, scope, memoryProject);

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
        `INSERT INTO observations(session_id, type, title, content, priority, scope, topic_key, normalized_hash, project, tags, citations, confidence, status, verified_at, revision_count, duplicate_count, last_seen_at, created_at, updated_at) VALUES (${sql(obs?.session_id)}, ${sql(type)}, ${sql(redactSecrets(title))}, ${sql(redactSecrets(content))}, ${sql(priority)}, ${sql(scope)}, ${sql(topic_key)}, ${sql(hash)}, ${sql(memoryProject)}, ${sql(tags)}, ${sql(citations)}, ${sql(confidence)}, ${sql(status)}, ${sql(obs?.verified_at)}, ${sql(Number(obs?.revision_count ?? 0))}, ${sql(Number(obs?.duplicate_count ?? 0))}, COALESCE(${sql(obs?.last_seen_at)}, datetime('now')), COALESCE(${sql(obs?.created_at)}, datetime('now')), COALESCE(${sql(obs?.updated_at)}, datetime('now')));`,
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

interface AutoCaptureCandidate {
  title: string;
  content: string;
  scope: "personal" | "project";
  topic_key: string;
}

/** Detect explicit user instructions that are safe to persist automatically. */
function detectAutoCapture(prompt: string): AutoCaptureCandidate | null {
  const text = cleanInline(prompt);
  if (text.length < 12 || text.length > 600) return null;

  const explicit = /\b(remember|for future|from now on|i prefer|my preference|always|never)\b/i.test(text);
  if (!explicit) return null;

  const projectSpecific = /\b(this|current)\s+(project|repo|repository|codebase|extension)\b|\b(in|for)\s+this\s+(project|repo|repository|codebase|extension)\b/i.test(text);
  const scope = projectSpecific ? "project" : "personal";
  const title = cropPlain(`User ${scope} preference: ${text}`, 80);
  const content = [
    "## Preference",
    `- ${text}`,
    "",
    "## Source",
    "- Captured from an explicit user instruction in the current prompt.",
  ].join("\n");
  return {
    title,
    content,
    scope,
    topic_key: `preference/${slugifyTopic(text)}`,
  };
}

/** Save an explicit durable user preference without interrupting the turn. */
async function maybeAutoCapturePreference(
  pi: ExtensionAPI,
  ctx: ExtensionContext | any,
  prompt: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!AUTO_CAPTURE) return;
  const candidate = detectAutoCapture(prompt);
  if (!candidate) return;

  await handleSave(
    pi,
    ctx,
    {
      ...candidate,
      type: "preference",
      priority: 4,
      tags: ["auto-captured", candidate.scope],
      status: "active",
      confidence: 0.9,
    },
    signal,
  );
}

/** Format memories for compact injection into the system prompt. */
function formatRecallBlock(rows: ObservationRow[]): string {
  return rows
    .map((r) => {
      const citationHint = listSummary(r.citations, 2);
      const verify = citationHint ? `\n  verify: ${citationHint}` : "";
      const scope = r.scope === "personal" ? "personal" : r.project;
      return `[${r.type}] ${r.title} (p${r.priority}, ${scope})\n  topic: ${r.topic_key ?? "-"}${verify}\n  ${snip(r.content ?? "", 110)}`;
    })
    .join("\n\n");
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

      await maybeAutoCapturePreference(pi, ctx, prompt);

      if (!AUTO_RECALL) return;

      const personalLimit = Math.min(2, MAX_RECALL_ITEMS);
      const taskLimit = Math.max(1, MAX_RECALL_ITEMS - personalLimit);
      const [personal, task] = await Promise.all([
        searchObservationRows(pi, info, {
          query: prompt,
          scope: "personal",
          type: "preference",
          priority_min: 1,
          limit: personalLimit,
        }),
        searchObservationRows(pi, info, {
          query: prompt,
          scope: "project",
          priority_min: 3,
          limit: taskLimit,
        }),
      ]);

      const seen = new Set<number>();
      const rows = [...personal.rows, ...task.rows].filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }).slice(0, MAX_RECALL_ITEMS);

      const memoryPolicy =
        `Memory policy: use mem_search before exploratory file reads when prior project decisions, bugs, configuration, preferences, or previous session context may matter. ` +
        `For code-specific memories with citations, verify cited files before relying on them. Save durable findings with mem_save.`;

      if (rows.length === 0) {
        return {
          systemPrompt:
            event.systemPrompt +
            `\n\n# Local persistent memory\n` +
            `${memoryPolicy}\n`,
        };
      }

      const block = clip(formatRecallBlock(rows), MAX_RECALL_CHARS);
      ctx.ui.setStatus(
        "memory",
        `${ctx.ui.theme.fg("accent", "◆")} ${ctx.ui.theme.fg("muted", "mem")} ${ctx.ui.theme.fg("success", `${rows.length} recalled`)}`,
      );

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n# Local persistent memory recall\n` +
          `These local memories matched the current prompt. Prefer them over redundant exploration when they answer the question. Do not expose secrets.\n` +
          `${memoryPolicy}\n\n` +
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
      "Keep memories atomic and explain why the fact matters. Add citations when a memory depends on files or code locations so future agents can verify it.",
      "Write mem_save content as clean Markdown: use short headings when helpful, bullet lists for facts and decisions, and fenced code blocks for commands, errors, config, SQL, JSON, or code.",
      "Avoid storing large code blobs, secrets, transient logs, or routine edits that are unlikely to help future sessions.",
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
        Type.String({ description: "project or personal (default project). Personal memories are global across projects." }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Optional tags for filtering, e.g. ['auth', '2026-05']." }),
      ),
      citations: Type.Optional(
        Type.Array(Type.String(), { description: "Optional file/code references to verify before relying on the memory, e.g. ['src/auth.ts:42']." }),
      ),
      confidence: Type.Optional(
        Type.Number({ description: "Confidence 0-1. Use lower values for unverified or uncertain facts." }),
      ),
      status: Type.Optional(
        Type.String({ description: "active | unverified | stale | superseded (default active)" }),
      ),
      verified_at: Type.Optional(
        Type.String({ description: "Optional ISO timestamp or date when citations were last verified." }),
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
      "Search memory before relying on file exploration when prior context may answer the request. Searches current project plus global personal memories by default, with FTS5 ranking when available. Be selective: derive 2-5 precise keywords, use filters, and pass id for exact lookup.",
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
      scope: Type.Optional(Type.String({ description: "project | personal. Default searches current project plus global personal memories." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tag filters. All provided tags must match." })),
      updated_after: Type.Optional(Type.String({ description: "Optional lower bound for updated_at, e.g. 2026-05-01." })),
      project: Type.Optional(Type.String({ description: "Admin/debug override for project-scoped search." })),
      status: Type.Optional(Type.String({ description: "active | unverified | stale | superseded. Default excludes superseded." })),
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
    description: "Search memory. Usage: /mem [query|#id]",
    handler: async (args, ctx) => {
      const query = args.trim();
      try {
        const idMatch = query.match(/^#?(\d+)$/);
        const params = idMatch
          ? { id: Number(idMatch[1]), include_content: true }
          : query
            ? { query, limit: 5, priority_min: 2 }
            : { limit: 8, priority_min: 1 };
        const result = await handleSearch(pi, ctx, params);
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
            `Auto capture: ${AUTO_CAPTURE}`,
            `FTS5: ${ftsAvailable ? "available" : "fallback LIKE"}`,
            `Max recall items: ${MAX_RECALL_ITEMS}`,
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
    description: "Browse memories with an interactive TUI. Usage: /membrowse [query]",
    handler: async (args, ctx) => {
      try {
        await ensureDb(pi);
        const info = await detectProject(pi, ctx);
        const query = args.trim();
        const rows = query
          ? (await searchObservationRows(pi, info, { query, limit: 1000, priority_min: 0 }, undefined)).rows
          : await sqliteJson<ObservationRow>(
              pi,
              `SELECT * FROM observations WHERE deleted_at IS NULL ORDER BY CASE WHEN project=${sql(info.project)} THEN 0 WHEN scope='personal' THEN 1 ELSE 2 END, project ASC, priority DESC, updated_at DESC LIMIT 1000;`,
            );

        const deleteMemory = async (row: ObservationRow): Promise<boolean> => {
          // The browser can show every project, so delete against the row project
          // instead of the current project used by mem_admin's command/tool scope.
          const result = await sqliteJson<{ changed: number }>(
            pi,
            `DELETE FROM observations WHERE id=${sql(row.id)} AND project=${sql(row.project)}; SELECT changes() AS changed;`,
          );
          return Number(result[0]?.changed ?? 0) > 0;
        };

        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          const browser = new MemoryBrowser(rows, info.project, tui, theme, () => done(undefined), deleteMemory);
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
  private pendingDelete: ObservationRow | null = null;
  private busy = false;
  private message: string | null = null;
  private mdRenderer: Markdown | null = null;
  private mdContentKey = "";

  private cachedWidth = -1;
  private cachedVersion = -1;
  private cachedLines: string[] = [];
  private version = 0;

  constructor(
    private all: ObservationRow[],
    private currentProject: string,
    private tui: any,
    private theme: any,
    private onDone: () => void,
    private onDelete: (row: ObservationRow) => Promise<boolean>,
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

  /** Return all project names, keeping the current project first for quick access. */
  private projectNames(): string[] {
    const projects = [...new Set([this.currentProject, ...this.all.map((row) => row.project || "unknown")])].sort();
    return projects.sort((left, right) => {
      if (left === this.currentProject) return -1;
      if (right === this.currentProject) return 1;
      return left.localeCompare(right);
    });
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

    const tokens = this.searchBuf.toLowerCase().split(/\s+/).filter(Boolean);
    return base.filter((row) => {
      for (const token of tokens) {
        if (token.startsWith("type:")) {
          if (row.type !== token.slice(5)) return false;
          continue;
        }
        if (token.startsWith("scope:")) {
          if (row.scope !== token.slice(6)) return false;
          continue;
        }
        const priorityMatch = token.match(/^p>=?(\d)$/);
        if (priorityMatch) {
          if (row.priority < Number(priorityMatch[1])) return false;
          continue;
        }
        const haystack = [row.title, row.content, row.type, row.topic_key, row.tags, row.citations, row.scope].join("\n").toLowerCase();
        if (!haystack.includes(token)) return false;
      }
      return true;
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

  /** Render transient browser status without exceeding the overlay width. */
  private statusRows(innerWidth: number): string[] {
    if (this.busy) return [this.row(this.warn("Deleting..."), innerWidth)];
    if (this.message) return [this.row(this.m(this.message), innerWidth)];
    return [];
  }

  /** Start hard-delete confirmation for the provided memory. */
  private requestDelete(row: ObservationRow | undefined): void {
    if (!row || this.busy) return;
    this.pendingDelete = row;
    this.message = null;
    this.touch();
  }

  /** Cancel an active hard-delete confirmation prompt. */
  private cancelDelete(): void {
    this.pendingDelete = null;
    this.message = "Delete cancelled.";
    this.touch();
  }

  /** Execute the confirmed hard delete and update the in-memory browser list. */
  private async confirmDelete(): Promise<void> {
    const row = this.pendingDelete;
    if (!row || this.busy) return;

    this.busy = true;
    this.message = null;
    this.touch();

    try {
      const deleted = await this.onDelete(row);
      if (!deleted) {
        this.message = `Could not delete #${row.id}.`;
        return;
      }

      this.all = this.all.filter((item) => item.id !== row.id);
      this.message = `Deleted #${row.id}.`;
      if (this.view === "detail") {
        this.view = "list";
        this.viewing = null;
        this.detailScroll = 0;
      }
      this.clamp(this.items().length);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.message = `Could not delete #${row.id}: ${cropPlain(msg, 80)}`;
    } finally {
      this.pendingDelete = null;
      this.busy = false;
      this.touch();
    }
  }

  /** Handle the confirmation keys shared by list and detail views. */
  private handleDeleteConfirmation(data: string): boolean {
    if (!this.pendingDelete) return false;
    if (this.busy) return true;
    if (matchesKey(data, "y") || matchesKey(data, "Y")) {
      void this.confirmDelete();
      return true;
    }
    if (matchesKey(data, "n") || matchesKey(data, "N") || matchesKey(data, Key.escape)) {
      this.cancelDelete();
      return true;
    }
    return true;
  }

  /** Return footer hints, replacing normal controls during delete confirmation. */
  private footerHints(normal: string): string {
    if (this.pendingDelete) return `Confirm hard delete #${this.pendingDelete.id}? y confirm • n/esc cancel`;
    if (this.busy) return "Deleting...";
    return normal;
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
      const current = project === this.currentProject ? ` ${this.ok("current")}` : "";
      const left = `${marker} ${this.bold(project)}${current}`;
      const right = this.d(`${info.count} memories  ${info.high} high`);
      lines.push(this.row(left + " ".repeat(Math.max(1, inner - 2 - visibleWidth(left) - visibleWidth(right))) + right, inner));
    }

    lines.push(...this.statusRows(inner));
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
      lines.push(...this.statusRows(inner));
      lines.push(this.empty(inner));
      lines.push(...this.bottom(this.footerHints("backspace projects • q close"), inner));
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

    lines.push(...this.statusRows(inner));
    const position = rows.length > 0 ? `${this.selIdx + 1}/${rows.length}` : "";
    const baseHints = this.searchMode
      ? "enter apply • backspace delete • esc cancel"
      : "j/k navigate • l/enter detail • d delete • h projects • / search • q close";
    const hints = position ? `${baseHints} • ${position}` : baseHints;
    lines.push(...this.bottom(this.footerHints(hints), inner));
    return lines;
  }

  private handleListInput(data: string): void {
    if (this.handleDeleteConfirmation(data)) return;
    if (this.busy) return;

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
    } else if (matchesKey(data, "d") || matchesKey(data, "D")) {
      this.requestDelete(rows[this.selIdx]);
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
      ["status", row.status && row.status !== "active" ? this.warn(row.status) : this.ok("active")],
      ["conf", typeof row.confidence === "number" ? this.m(row.confidence.toFixed(2)) : this.d("-")],
      ["topic", row.topic_key ? this.a("↳ ") + this.m(row.topic_key) : this.d("-")],
      ["tags", listSummary(row.tags) ? this.m(listSummary(row.tags)) : this.d("-")],
      ["cites", listSummary(row.citations, 2) ? this.m(listSummary(row.citations, 2)) : this.d("-")],
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
    lines.push(...this.statusRows(inner));
    const hints = `j/k scroll • d delete • h back • backspace back • q close${pos ? ` • ${pos}` : ""}`;
    lines.push(...this.bottom(this.footerHints(hints), inner));
    return lines;
  }

  private handleDetailInput(data: string): void {
    if (this.handleDeleteConfirmation(data)) return;
    if (this.busy) return;

    const maxScroll = Number.MAX_SAFE_INTEGER;

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.detailScroll = Math.max(0, this.detailScroll - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.detailScroll = Math.min(maxScroll, this.detailScroll + 1);
    else if (matchesKey(data, Key.ctrl("u"))) this.detailScroll = Math.max(0, this.detailScroll - Math.floor(this.maxBodyRows() / 2));
    else if (matchesKey(data, Key.ctrl("d"))) this.detailScroll = Math.min(maxScroll, this.detailScroll + Math.floor(this.maxBodyRows() / 2));
    else if (matchesKey(data, "d") || matchesKey(data, "D")) this.requestDelete(this.viewing ?? undefined);
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

