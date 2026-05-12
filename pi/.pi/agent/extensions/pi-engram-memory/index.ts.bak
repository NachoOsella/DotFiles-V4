import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

/**
 * Pi Local Memory
 * -----------------------------------------------------------------------------
 * Local-first persistent memory for Pi, inspired by Engram's mental model,
 * but implemented directly as a Pi extension. It does NOT call Engram, MCP,
 * HTTP APIs, cloud sync, or any remote service.
 *
 * Storage: SQLite + FTS5 through the local sqlite3 CLI.
 * Default DB: ~/.pi/agent/memory/pi-memory.db
 * Arch dependency: sudo pacman -S sqlite
 */

const SQLITE_BIN = process.env.PI_MEMORY_SQLITE_BIN ?? "sqlite3";
const DB_PATH = process.env.PI_MEMORY_DB ?? join(homedir(), ".pi", "agent", "memory", "pi-memory.db");
const AUTO_RECALL = process.env.PI_MEMORY_AUTO_RECALL !== "0";
const AUTO_SAVE_PROMPTS = process.env.PI_MEMORY_AUTO_SAVE_PROMPTS !== "0";
const MAX_RECALL_CHARS = Number(process.env.PI_MEMORY_MAX_RECALL_CHARS ?? "6000");
const DEFAULT_CONTEXT_LIMIT = Number(process.env.PI_MEMORY_CONTEXT_LIMIT ?? "8");
const AUTO_RECALL_LIMIT = Math.max(1, Math.min(Number(process.env.PI_MEMORY_RECALL_LIMIT ?? "6"), 20));
const MIN_PROMPT_CHARS = Math.max(0, Number(process.env.PI_MEMORY_MIN_PROMPT_CHARS ?? "20"));
const SQLITE_TIMEOUT_MS = Number(process.env.PI_MEMORY_SQLITE_TIMEOUT_MS ?? "8000");
const SCHEMA_VERSION = "2";

type ProjectInfo = {
  project: string;
  project_source: "env" | "git_remote" | "git_root" | "cwd" | "unknown";
  project_path: string;
  cwd: string;
  available_projects: string[];
  warning: string;
};

type SaveObservationInput = {
  title: string;
  content: string;
  type?: string;
  scope?: string;
  topic_key?: string;
  tool_name?: string;
};

type ObservationRow = {
  id: number;
  session_id?: string | null;
  type: string;
  title: string;
  content?: string;
  snippet?: string;
  tool_name?: string | null;
  project: string;
  scope: string;
  topic_key?: string | null;
  revision_count?: number;
  duplicate_count?: number;
  last_seen_at?: string;
  created_at: string;
  updated_at: string;
  score?: number;
};

let initialized = false;
let currentSessionId = `pi-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
let lastProjectInfo: ProjectInfo | null = null;
const projectCache = new Map<string, ProjectInfo>();

function clip(text: string, max = MAX_RECALL_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[pi-local-memory: truncated to ${max} chars]`;
}

function sql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

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

function normalizedHash(input: SaveObservationInput, project: string): string {
  const stable = [
    project,
    input.scope ?? "project",
    input.type ?? "discovery",
    input.title,
    input.content,
  ]
    .map((part) => normalizeText(String(part ?? "")))
    .join("\n---\n");
  return createHash("sha256").update(stable).digest("hex");
}

function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1****************");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh*_************************");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "sk-************************");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza************************");
  out = out.replace(
    /\b((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)\s*[:=]\s*)([^\s'"`]+|'[^']+'|"[^"]+"|`[^`]+`)/gi,
    (_m, key) => `${key}[REDACTED]`,
  );
  out = out.replace(
    /^\s*([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*).+$/gim,
    (_m, key) => `${key}[REDACTED]`,
  );
  return out;
}

function ftsQuery(input: string): string {
  const tokens = input
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);

  if (tokens.length === 0) return "";
  return tokens.map((token) => `${token.replace(/"/g, '')}*`).join(" OR ");
}

function slugifyTopic(type: string, titleOrContent: string): string {
  const family = (() => {
    const t = `${type} ${titleOrContent}`.toLowerCase();
    if (/arch|arquitect|design|diseñ/.test(t)) return "architecture";
    if (/bug|fix|error|exception|crash|fall/.test(t)) return "bug";
    if (/decision|decid|choose|chose|eleg/.test(t)) return "decision";
    if (/config|setup|install|env|docker|linux|nvim/.test(t)) return "config";
    if (/pattern|convention|naming|estructura/.test(t)) return "pattern";
    if (/prefer|preference|gusta|prefier/.test(t)) return "preference";
    if (/learn|discovery|descubr|finding/.test(t)) return "learning";
    return normalizeProjectName(type || "memory") || "memory";
  })();

  const slug = titleOrContent
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return `${family}/${slug || randomUUID().slice(0, 8)}`;
}

async function sqlite(pi: ExtensionAPI, sqlText: string, opts?: { json?: boolean; signal?: AbortSignal; timeout?: number }): Promise<string> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const file = join(tmpdir(), `pi-local-memory-${process.pid}-${randomUUID()}.sql`);
  const body = `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sqlText.trim()}\n`;
  await writeFile(file, body, "utf8");
  try {
    const args = opts?.json
      ? ["-json", DB_PATH, `.read ${file}`]
      : [DB_PATH, `.read ${file}`];
    const result = await pi.exec(SQLITE_BIN, args, { signal: opts?.signal, timeout: opts?.timeout ?? SQLITE_TIMEOUT_MS });
    const stdout = result.stdout?.trim() ?? "";
    const stderr = result.stderr?.trim() ?? "";
    if (result.code !== 0) {
      throw new Error(`sqlite failed (${result.code}): ${stderr || stdout || "no output"}`);
    }
    return stdout;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

async function sqliteJson<T = Record<string, unknown>>(pi: ExtensionAPI, sqlText: string, signal?: AbortSignal): Promise<T[]> {
  const out = await sqlite(pi, sqlText, { json: true, signal });
  if (!out.trim()) return [];
  try {
    return JSON.parse(out) as T[];
  } catch (error) {
    throw new Error(`sqlite returned non-JSON output: ${out.slice(0, 500)}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureDb(pi: ExtensionAPI, signal?: AbortSignal): Promise<void> {
  if (initialized) return;
  await sqlite(
    pi,
    `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      directory TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      type TEXT NOT NULL DEFAULT 'discovery',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      project TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      topic_key TEXT,
      normalized_hash TEXT NOT NULL,
      revision_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title,
      content,
      tool_name,
      type,
      project,
      content='observations',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, tool_name, type, project)
      VALUES (new.id, new.title, new.content, COALESCE(new.tool_name, ''), new.type, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, tool_name, type, project)
      VALUES('delete', old.id, old.title, old.content, COALESCE(old.tool_name, ''), old.type, old.project);
    END;

    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, tool_name, type, project)
      VALUES('delete', old.id, old.title, old.content, COALESCE(old.tool_name, ''), old.type, old.project);
      INSERT INTO observations_fts(rowid, title, content, tool_name, type, project)
      VALUES (new.id, new.title, new.content, COALESCE(new.tool_name, ''), new.type, new.project);
    END;

    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      content TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
      content,
      project,
      content='user_prompts',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO prompts_fts(rowid, content, project)
      VALUES (new.id, new.content, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON user_prompts BEGIN
      INSERT INTO prompts_fts(prompts_fts, rowid, content, project)
      VALUES('delete', old.id, old.content, old.project);
    END;

    CREATE TRIGGER IF NOT EXISTS prompts_au AFTER UPDATE ON user_prompts BEGIN
      INSERT INTO prompts_fts(prompts_fts, rowid, content, project)
      VALUES('delete', old.id, old.content, old.project);
      INSERT INTO prompts_fts(rowid, content, project)
      VALUES (new.id, new.content, new.project);
    END;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT INTO meta(key, value) VALUES ('schema_version', '2')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_observations_topic ON observations(project, scope, topic_key);
    CREATE INDEX IF NOT EXISTS idx_observations_hash ON observations(normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
    CREATE INDEX IF NOT EXISTS idx_observations_updated ON observations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_observations_project_updated ON observations(project, updated_at);
    CREATE INDEX IF NOT EXISTS idx_prompts_project ON user_prompts(project);
    CREATE INDEX IF NOT EXISTS idx_prompts_project_created ON user_prompts(project, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    `,
    { signal },
  );
  initialized = true;
}

async function availableProjects(pi: ExtensionAPI, signal?: AbortSignal): Promise<string[]> {
  await ensureDb(pi, signal);
  const rows = await sqliteJson<{ project: string }>(
    pi,
    `
    SELECT project FROM (
      SELECT project FROM observations WHERE deleted_at IS NULL
      UNION
      SELECT project FROM user_prompts
      UNION
      SELECT project FROM sessions
    ) WHERE project IS NOT NULL AND project != '' ORDER BY project;
    `,
    signal,
  );
  return rows.map((r) => r.project);
}

async function detectProject(pi: ExtensionAPI, ctx?: ExtensionContext | any, signal?: AbortSignal): Promise<ProjectInfo> {
  await ensureDb(pi, signal);
  const cwd = String(ctx?.cwd ?? ctx?.systemPromptOptions?.cwd ?? process.cwd());
  const envProject = process.env.PI_MEMORY_PROJECT?.trim();
  const cacheKey = `${cwd}\n${envProject ?? ""}`;
  const cached = projectCache.get(cacheKey);
  if (cached) return { ...cached, available_projects: await availableProjects(pi, signal) };

  const projects = await availableProjects(pi, signal);

  if (envProject) {
    const info: ProjectInfo = {
      project: normalizeProjectName(envProject),
      project_source: "env",
      project_path: cwd,
      cwd,
      available_projects: projects,
      warning: "",
    };
    projectCache.set(cacheKey, info);
    return info;
  }

  try {
    const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { signal, timeout: 1200 });
    if (root.code === 0 && root.stdout?.trim()) {
      const gitRoot = root.stdout.trim();
      const remote = await pi.exec("git", ["-C", gitRoot, "config", "--get", "remote.origin.url"], { signal, timeout: 1200 });
      const rawName = remote.code === 0 && remote.stdout?.trim() ? remote.stdout.trim() : basename(gitRoot);
      const project = normalizeProjectName(rawName) || normalizeProjectName(basename(gitRoot));
      const info: ProjectInfo = {
        project,
        project_source: rawName === basename(gitRoot) ? "git_root" : "git_remote",
        project_path: gitRoot,
        cwd,
        available_projects: projects,
        warning: "",
      };
      projectCache.set(cacheKey, info);
      return info;
    }
  } catch {
    // git is optional; fall back to cwd.
  }

  const project = normalizeProjectName(basename(cwd)) || "unknown";
  const info: ProjectInfo = {
    project,
    project_source: project === "unknown" ? "unknown" : "cwd",
    project_path: cwd,
    cwd,
    available_projects: projects,
    warning: project === "unknown" ? "Could not infer a project; set PI_MEMORY_PROJECT to force one." : "Project inferred from cwd basename, not git remote.",
  };
  projectCache.set(cacheKey, info);
  return info;
}

async function ensureSession(pi: ExtensionAPI, info: ProjectInfo, signal?: AbortSignal): Promise<void> {
  await ensureDb(pi, signal);
  await sqlite(
    pi,
    `
    INSERT INTO sessions(id, project, directory, status)
    VALUES (${sql(currentSessionId)}, ${sql(info.project)}, ${sql(info.project_path)}, 'active')
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      directory = excluded.directory,
      status = 'active';
    `,
    { signal },
  );
}

function okEnvelope(info: ProjectInfo, result: unknown, extra: Record<string, unknown> = {}): any {
  return {
    ok: true,
    project: info.project,
    project_source: info.project_source,
    project_path: info.project_path,
    ...extra,
    result,
  };
}

function errEnvelope(info: ProjectInfo | null, error: string, extra: Record<string, unknown> = {}): any {
  return {
    ok: false,
    project: info?.project ?? "",
    project_source: info?.project_source ?? "unknown",
    project_path: info?.project_path ?? "",
    available_projects: info?.available_projects ?? [],
    error,
    ...extra,
  };
}

function toolText(payload: unknown) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

type MemoryToolPayload = {
  ok?: boolean;
  project?: string;
  project_source?: string;
  result?: unknown;
  error?: string;
  rows?: unknown[];
  observations?: unknown[];
  prompts?: unknown[];
  sessions?: unknown[];
  db_path?: string;
};

function summarizeToolArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.query === "string") return `query=${JSON.stringify(args.query.slice(0, 60))}`;
  if (typeof args.title === "string") return `title=${JSON.stringify(args.title.slice(0, 60))}`;
  if (typeof args.id === "number") return `id=#${args.id}`;
  if (typeof args.project === "string") return `project=${args.project}`;
  if (typeof args.path === "string") return args.path;
  if (Array.isArray(args.source_projects)) return `${args.source_projects.join(",")} -> ${args.target_project ?? "?"}`;
  return "";
}

function summarizeEnvelope(payload: MemoryToolPayload): string {
  if (payload?.ok === false) return payload.error || "operation failed";
  const result = payload?.result;
  if (typeof result === "string") return result.split(/\r?\n/).find((line) => line.trim())?.trim() || "empty result";
  if (Array.isArray(result)) return `${result.length} metric${result.length === 1 ? "" : "s"}`;
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.action === "string") {
      const id = obj.id === undefined ? "" : ` #${obj.id}`;
      const changed = obj.changed === undefined ? "" : ` (${obj.changed} changed)`;
      return `${obj.action}${id}${changed}`;
    }
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.topic_key === "string") return obj.topic_key;
    if (typeof obj.captured === "number") return `${obj.captured} captured`;
    if (typeof obj.imported_observations === "number") return `${obj.imported_observations} observations imported, ${obj.imported_prompts ?? 0} prompts imported`;
  }
  return "done";
}

function detailsText(payload: MemoryToolPayload): string {
  const result = payload?.result;
  if (typeof result === "string") return result;
  return JSON.stringify(payload, null, 2);
}

function memoryToolRenderer(label: string) {
  return {
    renderCall(args: any, theme: any) {
      const argSummary = summarizeToolArgs(args);
      const text = [
        theme.fg("accent", "◆"),
        theme.fg("toolTitle", theme.bold(label)),
        argSummary ? theme.fg("muted", ` ${argSummary}`) : "",
      ].join(" ");
      return new Text(text, 0, 0);
    },
    renderResult(result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any) {
      if (options.isPartial) return new Text(`${theme.fg("warning", "◌")} ${theme.fg("muted", "reading local memory...")}`, 0, 0);
      const payload = (result?.details ?? {}) as MemoryToolPayload;
      const ok = payload.ok !== false;
      const project = payload.project ? theme.fg("muted", ` ${payload.project}`) : "";
      const status = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const summary = ok ? summarizeEnvelope(payload) : payload.error || "error";
      let text = `${status} ${theme.fg("toolTitle", label)}${project} ${theme.fg(ok ? "muted" : "error", "— " + summary)}`;
      if (options.expanded) {
        text += `\n${theme.fg("borderMuted", "─".repeat(32))}\n${detailsText(payload)}`;
      } else if (typeof payload.result === "string" && payload.result !== "No memories found." && payload.result !== "No prompts found.") {
        const preview = payload.result.split(/\r?\n/).filter(Boolean).slice(0, 3).join("  ");
        if (preview) text += `\n${theme.fg("dim", truncateToWidth(preview, 140))}`;
      }
      return new Text(text, 0, 0);
    },
  };
}

async function saveObservation(pi: ExtensionAPI, ctx: ExtensionContext | any, input: SaveObservationInput, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  await ensureSession(pi, info, signal);

  const clean: SaveObservationInput = {
    title: redactSecrets(input.title.trim()),
    content: redactSecrets(input.content.trim()),
    type: normalizeProjectName(input.type ?? "discovery") || "discovery",
    scope: input.scope === "personal" ? "personal" : "project",
    topic_key: input.topic_key?.trim() || undefined,
    tool_name: input.tool_name?.trim() || undefined,
  };

  if (!clean.title || !clean.content) throw new Error("mem_save requires non-empty title and content");

  const hash = normalizedHash(clean, info.project);

  if (clean.topic_key) {
    const existing = await sqliteJson<{ id: number }>(
      pi,
      `
      SELECT id FROM observations
      WHERE project = ${sql(info.project)}
        AND scope = ${sql(clean.scope)}
        AND topic_key = ${sql(clean.topic_key)}
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1;
      `,
      signal,
    );

    if (existing[0]?.id) {
      const id = existing[0].id;
      await sqlite(
        pi,
        `
        UPDATE observations SET
          type = ${sql(clean.type)},
          title = ${sql(clean.title)},
          content = ${sql(clean.content)},
          tool_name = ${sql(clean.tool_name)},
          normalized_hash = ${sql(hash)},
          revision_count = revision_count + 1,
          last_seen_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ${sql(id)};
        `,
        { signal },
      );
      return okEnvelope(info, { id, action: "updated_topic", topic_key: clean.topic_key });
    }
  }

  const duplicate = await sqliteJson<{ id: number; duplicate_count: number }>(
    pi,
    `
    SELECT id, duplicate_count FROM observations
    WHERE normalized_hash = ${sql(hash)} AND deleted_at IS NULL
    ORDER BY updated_at DESC LIMIT 1;
    `,
    signal,
  );

  if (duplicate[0]?.id) {
    const id = duplicate[0].id;
    await sqlite(
      pi,
      `
      UPDATE observations SET
        duplicate_count = duplicate_count + 1,
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ${sql(id)};
      `,
      { signal },
    );
    return okEnvelope(info, { id, action: "deduped", duplicate_count: (duplicate[0].duplicate_count ?? 0) + 1 });
  }

  const rows = await sqliteJson<{ id: number }>(
    pi,
    `
    INSERT INTO observations(session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash)
    VALUES (
      ${sql(currentSessionId)}, ${sql(clean.type)}, ${sql(clean.title)}, ${sql(clean.content)},
      ${sql(clean.tool_name)}, ${sql(info.project)}, ${sql(clean.scope)}, ${sql(clean.topic_key)}, ${sql(hash)}
    );
    SELECT last_insert_rowid() AS id;
    `,
    signal,
  );

  return okEnvelope(info, { id: rows[0]?.id, action: "inserted", topic_key: clean.topic_key ?? null });
}

async function validateReadProject(pi: ExtensionAPI, ctx: ExtensionContext | any, explicitProject?: string, signal?: AbortSignal) {
  const detected = await detectProject(pi, ctx, signal);
  if (!explicitProject?.trim()) return detected;
  const project = normalizeProjectName(explicitProject);
  const projects = await availableProjects(pi, signal);
  if (!projects.includes(project) && !(project === detected.project && projects.length === 0)) {
    return { ...detected, project, available_projects: projects, warning: `Unknown project '${project}'.` };
  }
  return { ...detected, project, available_projects: projects, warning: "" };
}

function formatSearchRows(rows: ObservationRow[], includeContent = false): string {
  if (rows.length === 0) return "No memories found.";
  return rows
    .map((r) => {
      const head = `#${r.id} [${r.type}/${r.scope}] ${r.title} (${r.project}, ${r.updated_at})`;
      const topic = r.topic_key ? `\nTopic: ${r.topic_key}` : "";
      const counts = `\nRevisions: ${r.revision_count ?? 0}, duplicates: ${r.duplicate_count ?? 0}`;
      const body = includeContent ? `\n${r.content ?? ""}` : `\n${r.snippet ?? ""}`;
      return `${head}${topic}${counts}${body}`;
    })
    .join("\n\n---\n\n");
}

async function searchMemories(pi: ExtensionAPI, ctx: ExtensionContext | any, params: any, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await validateReadProject(pi, ctx, params.project, signal);
  if (info.warning.startsWith("Unknown project")) return errEnvelope(info, info.warning, { available_projects: info.available_projects });

  const query = String(params.query ?? "").trim();
  const type = params.type?.trim();
  const scope = params.scope?.trim();
  const limit = Math.max(1, Math.min(Number(params.limit ?? 8), 50));
  const includeContent = Boolean(params.include_content ?? false);
  const fts = ftsQuery(query);

  if (!fts) return okEnvelope(info, "No searchable terms in query.", { rows: [] });

  const rows = await sqliteJson<ObservationRow>(
    pi,
    `
    SELECT
      o.id, o.session_id, o.type, o.title,
      ${includeContent ? "o.content" : "snippet(observations_fts, 1, '<<', '>>', ' … ', 24) AS snippet"},
      o.tool_name, o.project, o.scope, o.topic_key, o.revision_count, o.duplicate_count,
      o.last_seen_at, o.created_at, o.updated_at,
      bm25(observations_fts) AS score
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ${sql(fts)}
      AND o.deleted_at IS NULL
      AND o.project = ${sql(info.project)}
      ${type ? `AND o.type = ${sql(type)}` : ""}
      ${scope ? `AND o.scope = ${sql(scope)}` : ""}
    ORDER BY score ASC, o.updated_at DESC
    LIMIT ${sql(limit)};
    `,
    signal,
  );

  return okEnvelope(info, formatSearchRows(rows, includeContent), { rows });
}

function shouldSavePrompt(content: string): boolean {
  const prompt = content.trim();
  if (prompt.length < MIN_PROMPT_CHARS) return false;
  if (/^(y|yes|s[ií]|ok|okay|dale|go|segu[ií]|contin[uú]a|gracias|thanks|no)$/i.test(prompt)) return false;
  return true;
}

async function savePrompt(pi: ExtensionAPI, ctx: ExtensionContext | any, content: string, signal?: AbortSignal, opts: { force?: boolean } = {}) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  await ensureSession(pi, info, signal);
  const clean = redactSecrets(content.trim());
  if (!clean) return okEnvelope(info, { action: "skipped_empty_prompt" });
  if (!opts.force && !shouldSavePrompt(clean)) return okEnvelope(info, { action: "skipped_trivial_prompt", min_prompt_chars: MIN_PROMPT_CHARS });
  const rows = await sqliteJson<{ id: number }>(
    pi,
    `
    INSERT INTO user_prompts(session_id, content, project)
    VALUES (${sql(currentSessionId)}, ${sql(clean)}, ${sql(info.project)});
    SELECT last_insert_rowid() AS id;
    `,
    signal,
  );
  return okEnvelope(info, { id: rows[0]?.id, action: "prompt_saved" });
}

async function searchPrompts(pi: ExtensionAPI, ctx: ExtensionContext | any, params: any, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await validateReadProject(pi, ctx, params.project, signal);
  if (info.warning.startsWith("Unknown project")) return errEnvelope(info, info.warning, { available_projects: info.available_projects });

  const query = String(params.query ?? "").trim();
  const fts = ftsQuery(query);
  const limit = Math.max(1, Math.min(Number(params.limit ?? 10), 50));
  if (!fts) return okEnvelope(info, "No searchable terms in query.", { rows: [] });

  const rows = await sqliteJson<{ id: number; content: string; project: string; created_at: string; snippet?: string; score?: number }>(
    pi,
    `
    SELECT
      p.id,
      ${params.include_content ? "p.content" : "snippet(prompts_fts, 0, '<<', '>>', ' … ', 32) AS snippet"},
      p.project,
      p.created_at,
      bm25(prompts_fts) AS score
    FROM prompts_fts
    JOIN user_prompts p ON p.id = prompts_fts.rowid
    WHERE prompts_fts MATCH ${sql(fts)}
      AND p.project = ${sql(info.project)}
    ORDER BY score ASC, p.created_at DESC
    LIMIT ${sql(limit)};
    `,
    signal,
  );

  const formatted = rows.length
    ? rows.map((r) => `#${r.id} (${r.project}, ${r.created_at})\n${params.include_content ? r.content : r.snippet}`).join("\n\n---\n\n")
    : "No prompts found.";
  return okEnvelope(info, formatted, { rows });
}

async function recentContext(pi: ExtensionAPI, ctx: ExtensionContext | any, params: any, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await validateReadProject(pi, ctx, params.project, signal);
  if (info.warning.startsWith("Unknown project")) return errEnvelope(info, info.warning, { available_projects: info.available_projects });
  const limit = Math.max(1, Math.min(Number(params.limit ?? DEFAULT_CONTEXT_LIMIT), 30));
  const scope = params.scope?.trim();

  const observations = await sqliteJson<ObservationRow>(
    pi,
    `
    SELECT id, session_id, type, title, content, tool_name, project, scope, topic_key,
      revision_count, duplicate_count, last_seen_at, created_at, updated_at
    FROM observations
    WHERE deleted_at IS NULL
      AND project = ${sql(info.project)}
      ${scope ? `AND scope = ${sql(scope)}` : ""}
    ORDER BY updated_at DESC
    LIMIT ${sql(limit)};
    `,
    signal,
  );

  const prompts = await sqliteJson<{ id: number; content: string; project: string; created_at: string }>(
    pi,
    `
    SELECT id, content, project, created_at
    FROM user_prompts
    WHERE project = ${sql(info.project)}
    ORDER BY created_at DESC
    LIMIT ${sql(Math.min(limit, 10))};
    `,
    signal,
  );

  const sessions = await sqliteJson<{ id: string; summary: string | null; started_at: string; ended_at: string | null; status: string }>(
    pi,
    `
    SELECT id, summary, started_at, ended_at, status
    FROM sessions
    WHERE project = ${sql(info.project)}
    ORDER BY started_at DESC
    LIMIT 5;
    `,
    signal,
  );

  const result = [
    `## Recent observations for ${info.project}`,
    observations.length ? formatSearchRows(observations, true) : "No observations yet.",
    `\n## Recent prompts`,
    prompts.length ? prompts.map((p) => `#${p.id} (${p.created_at}) ${p.content}`).join("\n\n") : "No prompts yet.",
    `\n## Recent sessions`,
    sessions.length ? sessions.map((s) => `${s.id} | ${s.status} | ${s.started_at}${s.ended_at ? ` → ${s.ended_at}` : ""}${s.summary ? `\n${s.summary}` : ""}`).join("\n\n") : "No sessions yet.",
  ].join("\n\n");

  return okEnvelope(info, clip(result), { observations, prompts, sessions });
}

async function getObservation(pi: ExtensionAPI, ctx: ExtensionContext | any, id: number, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const rows = await sqliteJson<ObservationRow>(
    pi,
    `
    SELECT id, session_id, type, title, content, tool_name, project, scope, topic_key,
      revision_count, duplicate_count, last_seen_at, created_at, updated_at
    FROM observations
    WHERE id = ${sql(id)} AND deleted_at IS NULL
    LIMIT 1;
    `,
    signal,
  );
  if (!rows[0]) return errEnvelope(info, `Observation #${id} not found.`);
  return okEnvelope({ ...info, project: rows[0].project }, rows[0]);
}

async function stats(pi: ExtensionAPI, ctx: ExtensionContext | any, params: any, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await validateReadProject(pi, ctx, params.project, signal);
  const projectClause = params.project ? `AND project = ${sql(info.project)}` : "";
  const rows = await sqliteJson<Record<string, unknown>>(
    pi,
    `
    SELECT 'observations' AS metric, COUNT(*) AS value FROM observations WHERE deleted_at IS NULL ${projectClause}
    UNION ALL SELECT 'deleted_observations', COUNT(*) FROM observations WHERE deleted_at IS NOT NULL ${projectClause}
    UNION ALL SELECT 'prompts', COUNT(*) FROM user_prompts WHERE 1=1 ${projectClause}
    UNION ALL SELECT 'sessions', COUNT(*) FROM sessions WHERE 1=1 ${projectClause}
    UNION ALL SELECT 'projects', COUNT(DISTINCT project) FROM (
      SELECT project FROM observations WHERE deleted_at IS NULL
      UNION ALL SELECT project FROM user_prompts
      UNION ALL SELECT project FROM sessions
    );
    `,
    signal,
  );
  return okEnvelope(info, rows, { db_path: DB_PATH });
}

async function timeline(pi: ExtensionAPI, ctx: ExtensionContext | any, id: number, limit: number, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const baseRows = await sqliteJson<ObservationRow>(
    pi,
    `SELECT id, session_id, project, topic_key, created_at FROM observations WHERE id = ${sql(id)} AND deleted_at IS NULL LIMIT 1;`,
    signal,
  );
  const base = baseRows[0];
  if (!base) return errEnvelope(info, `Observation #${id} not found.`);
  const safeLimit = Math.max(1, Math.min(limit, 30));
  const rows = await sqliteJson<ObservationRow>(
    pi,
    `
    SELECT id, session_id, type, title, content, tool_name, project, scope, topic_key,
      revision_count, duplicate_count, last_seen_at, created_at, updated_at
    FROM observations
    WHERE deleted_at IS NULL
      AND project = ${sql(base.project)}
      AND (
        session_id = ${sql(base.session_id)}
        ${base.topic_key ? `OR topic_key = ${sql(base.topic_key)}` : ""}
      )
    ORDER BY created_at ASC
    LIMIT ${sql(safeLimit)};
    `,
    signal,
  );
  return okEnvelope({ ...info, project: base.project }, formatSearchRows(rows, true), { rows });
}

function resolveFromCwd(ctx: ExtensionContext | any, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(String(ctx?.cwd ?? process.cwd()), filePath);
}

async function exportJson(pi: ExtensionAPI, ctx: ExtensionContext | any, filePath: string | undefined, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const outPath = resolveFromCwd(ctx, filePath?.trim() || `pi-memory-export-${new Date().toISOString().slice(0, 10)}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  const observations = await sqliteJson(pi, `SELECT * FROM observations WHERE deleted_at IS NULL ORDER BY updated_at DESC;`, signal);
  const prompts = await sqliteJson(pi, `SELECT * FROM user_prompts ORDER BY created_at DESC;`, signal);
  const sessions = await sqliteJson(pi, `SELECT * FROM sessions ORDER BY started_at DESC;`, signal);
  await writeFile(outPath, JSON.stringify({ exported_at: new Date().toISOString(), schema_version: SCHEMA_VERSION, observations, prompts, sessions }, null, 2));
  return okEnvelope(info, { path: outPath, observations: observations.length, prompts: prompts.length, sessions: sessions.length });
}

async function importJson(pi: ExtensionAPI, ctx: ExtensionContext | any, filePath: string, signal?: AbortSignal) {
  await ensureDb(pi, signal);
  const info = await detectProject(pi, ctx, signal);
  const inPath = resolveFromCwd(ctx, filePath.trim());
  const raw = await readFile(inPath, "utf8");
  const data = JSON.parse(raw) as { observations?: any[]; prompts?: any[]; sessions?: any[] };
  const observations = Array.isArray(data.observations) ? data.observations : [];
  const prompts = Array.isArray(data.prompts) ? data.prompts : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  let importedObservations = 0;
  let dedupedObservations = 0;
  let importedPrompts = 0;
  let importedSessions = 0;

  for (const session of sessions) {
    if (!session?.id || !session?.project || !session?.directory) continue;
    await sqlite(
      pi,
      `
      INSERT INTO sessions(id, project, directory, started_at, ended_at, summary, status)
      VALUES (${sql(session.id)}, ${sql(session.project)}, ${sql(session.directory)}, COALESCE(${sql(session.started_at)}, datetime('now')), ${sql(session.ended_at)}, ${sql(session.summary)}, COALESCE(${sql(session.status)}, 'imported'))
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        directory = excluded.directory,
        ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
        summary = COALESCE(excluded.summary, sessions.summary),
        status = excluded.status;
      `,
      { signal },
    );
    importedSessions++;
  }

  for (const observation of observations) {
    const title = String(observation?.title ?? "").trim();
    const content = String(observation?.content ?? "").trim();
    const project = normalizeProjectName(String(observation?.project ?? info.project));
    if (!title || !content || !project) continue;
    const input: SaveObservationInput = {
      title,
      content,
      type: observation?.type ?? "imported",
      scope: observation?.scope ?? "project",
      topic_key: observation?.topic_key ?? undefined,
      tool_name: observation?.tool_name ?? "import",
    };
    const hash = normalizedHash(input, project);
    const existing = await sqliteJson<{ id: number }>(pi, `SELECT id FROM observations WHERE normalized_hash = ${sql(hash)} AND deleted_at IS NULL LIMIT 1;`, signal);
    if (existing[0]?.id) {
      await sqlite(pi, `UPDATE observations SET duplicate_count = duplicate_count + 1, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ${sql(existing[0].id)};`, { signal });
      dedupedObservations++;
      continue;
    }
    await sqlite(
      pi,
      `
      INSERT INTO observations(session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, created_at, updated_at)
      VALUES (${sql(observation?.session_id)}, ${sql(input.type)}, ${sql(redactSecrets(title))}, ${sql(redactSecrets(content))}, ${sql(input.tool_name)}, ${sql(project)}, ${sql(input.scope)}, ${sql(input.topic_key)}, ${sql(hash)}, ${sql(Number(observation?.revision_count ?? 0))}, ${sql(Number(observation?.duplicate_count ?? 0))}, COALESCE(${sql(observation?.last_seen_at)}, datetime('now')), COALESCE(${sql(observation?.created_at)}, datetime('now')), COALESCE(${sql(observation?.updated_at)}, datetime('now')));
      `,
      { signal },
    );
    importedObservations++;
  }

  for (const prompt of prompts) {
    const content = String(prompt?.content ?? "").trim();
    const project = normalizeProjectName(String(prompt?.project ?? info.project));
    if (!content || !project) continue;
    const duplicate = await sqliteJson<{ id: number }>(pi, `SELECT id FROM user_prompts WHERE project = ${sql(project)} AND content = ${sql(redactSecrets(content))} LIMIT 1;`, signal);
    if (duplicate[0]?.id) continue;
    await sqlite(
      pi,
      `
      INSERT INTO user_prompts(session_id, content, project, created_at)
      VALUES (${sql(prompt?.session_id)}, ${sql(redactSecrets(content))}, ${sql(project)}, COALESCE(${sql(prompt?.created_at)}, datetime('now')));
      `,
      { signal },
    );
    importedPrompts++;
  }

  projectCache.clear();
  return okEnvelope(info, { path: inPath, imported_observations: importedObservations, deduped_observations: dedupedObservations, imported_prompts: importedPrompts, imported_sessions: importedSessions });
}

export default function piLocalMemory(pi: ExtensionAPI) {
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
      ctx.ui.setStatus("memory", `${ctx.ui.theme.fg("error", "◆")} ${ctx.ui.theme.fg("muted", "mem unavailable")}`);
      ctx.ui.notify(`Pi Local Memory is not available. Install sqlite3 (Arch: sudo pacman -S sqlite). ${msg}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await ensureDb(pi);
      const info = lastProjectInfo ?? (await detectProject(pi, ctx));
      await sqlite(pi, `UPDATE sessions SET ended_at = datetime('now'), status = 'ended' WHERE id = ${sql(currentSessionId)};`);
      ctx.ui.setStatus("memory", undefined);
      void info;
    } catch {
      // shutdown must never block Pi.
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await ensureDb(pi);
      const info = await detectProject(pi, ctx);
      await ensureSession(pi, info);
      lastProjectInfo = info;

      const prompt = String(event.prompt ?? "").trim();
      if (!prompt || prompt.startsWith("/")) return;

      if (AUTO_SAVE_PROMPTS) {
        await savePrompt(pi, ctx, prompt);
      }

      if (!AUTO_RECALL) return;
      const recalled = await searchMemories(pi, ctx, { query: prompt, project: info.project, limit: AUTO_RECALL_LIMIT, include_content: false });
      const resultText = typeof recalled.result === "string" ? recalled.result : JSON.stringify(recalled.result);
      if (!resultText || resultText === "No memories found." || resultText === "No searchable terms in query.") return;

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n# Local persistent memory recall\n` +
          `These are local memories retrieved from Pi Local Memory for the current prompt. Use only when relevant. Do not expose secrets; do not treat stale memories as more authoritative than current files.\n\n` +
          `\`\`\`text\n${clip(resultText)}\n\`\`\``,
      };
    } catch {
      return;
    }
  });

  const toolGuidelines = [
    "Use mem_context first when the user asks to remember prior work, previous decisions, project conventions, or how something was solved before.",
    "Use mem_search when mem_context is not enough or when specific keywords, bugs, files, architecture choices, or preferences are involved.",
    "Use mem_search_prompts when the user asks what they previously requested or when exact prior prompt wording matters.",
    "Use mem_save immediately after durable bug fixes, architecture/design decisions, codebase discoveries, configuration changes, conventions, or user preferences that should survive sessions.",
    "Do not save secrets, API keys, tokens, passwords, private keys, or temporary one-off details to memory.",
    "Use topic_key to update evolving memories instead of creating many near-duplicates; call mem_suggest_topic_key when unsure.",
  ];

  pi.registerTool({
    name: "mem_current_project",
    label: "Current Memory Project",
    description: "Detect the current project used for local memory scoping.",
    promptSnippet: "Inspect which project Pi Local Memory will read/write.",
    ...memoryToolRenderer("Current Project"),
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      await ensureDb(pi, signal);
      const info = await detectProject(pi, ctx, signal);
      await ensureSession(pi, info, signal);
      return toolText(okEnvelope(info, { cwd: info.cwd, db_path: DB_PATH }));
    },
  });

  pi.registerTool({
    name: "mem_search",
    label: "Search Memory",
    description: "Search persistent local memory with SQLite FTS5 across title/content/type/project.",
    promptSnippet: "Search local persistent memory for previous decisions, fixes, preferences, and project context.",
    promptGuidelines: toolGuidelines,
    ...memoryToolRenderer("Search Memory"),
    parameters: Type.Object({
      query: Type.String({ description: "Full-text search query" }),
      project: Type.Optional(Type.String({ description: "Optional project override; defaults to current project" })),
      type: Type.Optional(Type.String({ description: "Optional type filter: decision, architecture, bugfix, pattern, config, discovery, learning, preference" })),
      scope: Type.Optional(Type.String({ description: "Optional scope filter: project or personal" })),
      limit: Type.Optional(Type.Number({ description: "Max results, 1-50", minimum: 1, maximum: 50 })),
      include_content: Type.Optional(Type.Boolean({ description: "Return full content instead of snippets" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await searchMemories(pi, ctx, params, signal));
    },
  });

  pi.registerTool({
    name: "mem_save",
    label: "Save Memory",
    description: "Save or upsert a structured local memory. Project is auto-detected from cwd/git.",
    promptSnippet: "Save durable local memories: decisions, bugfixes, architecture, config, patterns, discoveries, learnings, preferences.",
    promptGuidelines: toolGuidelines,
    ...memoryToolRenderer("Save Memory"),
    parameters: Type.Object({
      title: Type.String({ description: "Short searchable title, e.g. 'Fixed N+1 query in UserList'" }),
      type: Type.String({ description: "decision | architecture | bugfix | pattern | config | discovery | learning | preference" }),
      scope: Type.Optional(Type.String({ description: "project (default) or personal" })),
      topic_key: Type.Optional(Type.String({ description: "Stable key for evolving memories, e.g. architecture/auth-model" })),
      content: Type.String({ description: "Structured body. Prefer **What**, **Why**, **Where**, **Learned**." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await saveObservation(pi, ctx, params, signal));
    },
  });

  pi.registerTool({
    name: "mem_update",
    label: "Update Memory",
    description: "Partially update an observation by ID.",
    ...memoryToolRenderer("Update Memory"),
    parameters: Type.Object({
      id: Type.Number({ description: "Observation ID" }),
      title: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      topic_key: Type.Optional(Type.String()),
      tool_name: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await ensureDb(pi, signal);
      const info = await detectProject(pi, ctx, signal);
      const existing = await sqliteJson<ObservationRow>(pi, `SELECT * FROM observations WHERE id = ${sql(params.id)} AND deleted_at IS NULL LIMIT 1;`, signal);
      if (!existing[0]) return toolText(errEnvelope(info, `Observation #${params.id} not found.`));
      const next = {
        title: redactSecrets(params.title ?? existing[0].title),
        content: redactSecrets(params.content ?? existing[0].content ?? ""),
        type: params.type ?? existing[0].type,
        scope: params.scope ?? existing[0].scope,
        topic_key: params.topic_key ?? existing[0].topic_key ?? undefined,
        tool_name: params.tool_name ?? existing[0].tool_name ?? undefined,
      };
      const hash = normalizedHash(next, existing[0].project);
      await sqlite(
        pi,
        `
        UPDATE observations SET
          title = ${sql(next.title)}, content = ${sql(next.content)}, type = ${sql(next.type)},
          scope = ${sql(next.scope)}, topic_key = ${sql(next.topic_key)}, tool_name = ${sql(next.tool_name)}, normalized_hash = ${sql(hash)},
          revision_count = revision_count + 1, updated_at = datetime('now'), last_seen_at = datetime('now')
        WHERE id = ${sql(params.id)};
        `,
        { signal },
      );
      return toolText(okEnvelope({ ...info, project: existing[0].project }, { id: params.id, action: "updated" }));
    },
  });

  pi.registerTool({
    name: "mem_suggest_topic_key",
    label: "Suggest Memory Topic Key",
    description: "Suggest a stable topic_key from memory type and title/content.",
    ...memoryToolRenderer("Topic Key"),
    parameters: Type.Object({
      type: Type.String(),
      title: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const info = await detectProject(pi, ctx, signal);
      const topic_key = slugifyTopic(String(params.type ?? "memory"), String(params.title || params.content || "memory"));
      return toolText(okEnvelope(info, { topic_key }));
    },
  });

  pi.registerTool({
    name: "mem_delete",
    label: "Delete Memory",
    description: "Delete an observation by ID. Soft-delete by default; hard delete only when requested.",
    ...memoryToolRenderer("Delete Memory"),
    parameters: Type.Object({
      id: Type.Number({ description: "Observation ID" }),
      project: Type.String({ description: "Project name required for destructive operations" }),
      hard: Type.Optional(Type.Boolean({ description: "Permanently delete instead of soft-delete" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await ensureDb(pi, signal);
      const info = await validateReadProject(pi, ctx, params.project, signal);
      if (info.warning.startsWith("Unknown project")) return toolText(errEnvelope(info, info.warning));
      if (params.hard) {
        const rows = await sqliteJson<{ changed: number }>(pi, `DELETE FROM observations WHERE id = ${sql(params.id)} AND project = ${sql(info.project)}; SELECT changes() AS changed;`, signal);
        const changed = Number(rows[0]?.changed ?? 0);
        return toolText(okEnvelope(info, { id: params.id, action: changed > 0 ? "hard_deleted" : "not_found", changed }));
      }
      const rows = await sqliteJson<{ changed: number }>(pi, `UPDATE observations SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ${sql(params.id)} AND project = ${sql(info.project)} AND deleted_at IS NULL; SELECT changes() AS changed;`, signal);
      const changed = Number(rows[0]?.changed ?? 0);
      return toolText(okEnvelope(info, { id: params.id, action: changed > 0 ? "soft_deleted" : "not_found", changed }));
    },
  });

  pi.registerTool({
    name: "mem_save_prompt",
    label: "Save Prompt",
    description: "Save a user prompt locally for future context.",
    ...memoryToolRenderer("Save Prompt"),
    parameters: Type.Object({
      content: Type.String({ description: "User prompt content" }),
      force: Type.Optional(Type.Boolean({ description: "Save even if the prompt looks trivial or shorter than PI_MEMORY_MIN_PROMPT_CHARS" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await savePrompt(pi, ctx, params.content, signal, { force: Boolean(params.force) }));
    },
  });

  pi.registerTool({
    name: "mem_search_prompts",
    label: "Search Saved Prompts",
    description: "Search saved user prompts with SQLite FTS5.",
    promptSnippet: "Search previous user prompts saved by Pi Local Memory.",
    promptGuidelines: toolGuidelines,
    ...memoryToolRenderer("Search Prompts"),
    parameters: Type.Object({
      query: Type.String({ description: "Full-text prompt query" }),
      project: Type.Optional(Type.String({ description: "Optional project override; defaults to current project" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      include_content: Type.Optional(Type.Boolean({ description: "Return full prompt content instead of snippets" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await searchPrompts(pi, ctx, params, signal));
    },
  });

  pi.registerTool({
    name: "mem_context",
    label: "Memory Context",
    description: "Get recent local context from previous sessions, prompts, and observations.",
    promptSnippet: "Load recent local persistent memory context for the current project.",
    promptGuidelines: toolGuidelines,
    ...memoryToolRenderer("Memory Context"),
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Optional project override" })),
      scope: Type.Optional(Type.String({ description: "Optional scope filter" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await recentContext(pi, ctx, params, signal));
    },
  });

  pi.registerTool({
    name: "mem_stats",
    label: "Memory Stats",
    description: "Show local memory statistics.",
    ...memoryToolRenderer("Memory Stats"),
    parameters: Type.Object({ project: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await stats(pi, ctx, params, signal));
    },
  });

  pi.registerTool({
    name: "mem_timeline",
    label: "Memory Timeline",
    description: "Show chronological context around an observation.",
    ...memoryToolRenderer("Timeline"),
    parameters: Type.Object({
      id: Type.Number({ description: "Observation ID" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await timeline(pi, ctx, Number(params.id), Number(params.limit ?? 20), signal));
    },
  });

  pi.registerTool({
    name: "mem_get_observation",
    label: "Get Memory Observation",
    description: "Get full untruncated content for an observation ID.",
    ...memoryToolRenderer("Get Memory"),
    parameters: Type.Object({ id: Type.Number({ description: "Observation ID" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await getObservation(pi, ctx, Number(params.id), signal));
    },
  });

  pi.registerTool({
    name: "mem_session_start",
    label: "Start Memory Session",
    description: "Register a local memory session for the current project.",
    ...memoryToolRenderer("Start Session"),
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const info = await detectProject(pi, ctx, signal);
      currentSessionId = `pi-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      await ensureSession(pi, info, signal);
      return toolText(okEnvelope(info, { session_id: currentSessionId, action: "started" }));
    },
  });

  pi.registerTool({
    name: "mem_session_end",
    label: "End Memory Session",
    description: "Mark the current local memory session as ended.",
    ...memoryToolRenderer("End Session"),
    parameters: Type.Object({ summary: Type.Optional(Type.String({ description: "Optional session summary" })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const info = await detectProject(pi, ctx, signal);
      const summary = typeof params.summary === "string" ? redactSecrets(params.summary) : undefined;
      await sqlite(pi, `UPDATE sessions SET ended_at = datetime('now'), status = 'ended', summary = COALESCE(${sql(summary)}, summary) WHERE id = ${sql(currentSessionId)};`, { signal });
      return toolText(okEnvelope(info, { session_id: currentSessionId, action: "ended" }));
    },
  });

  pi.registerTool({
    name: "mem_session_summary",
    label: "Save Session Summary",
    description: "Save a comprehensive end-of-session summary as both session summary and an observation.",
    ...memoryToolRenderer("Session Summary"),
    parameters: Type.Object({
      summary: Type.String({ description: "Markdown summary with Goal, Instructions, Discoveries, Accomplished, Relevant Files" }),
      title: Type.Optional(Type.String({ description: "Optional memory title" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const info = await detectProject(pi, ctx, signal);
      await ensureSession(pi, info, signal);
      await sqlite(pi, `UPDATE sessions SET summary = ${sql(redactSecrets(params.summary))} WHERE id = ${sql(currentSessionId)};`, { signal });
      const saved = await saveObservation(
        pi,
        ctx,
        { title: params.title ?? `Session summary ${new Date().toISOString().slice(0, 10)}`, type: "summary", scope: "project", topic_key: `session/${currentSessionId}`, content: params.summary },
        signal,
      );
      return toolText(okEnvelope(info, { session_id: currentSessionId, saved }));
    },
  });

  pi.registerTool({
    name: "mem_capture_passive",
    label: "Capture Passive Learnings",
    description: "Extract bullet/numbered learnings from text and save them as observations.",
    ...memoryToolRenderer("Capture Learnings"),
    parameters: Type.Object({
      text: Type.String({ description: "Text containing learnings; supports sections like '## Key Learnings:'" }),
      type: Type.Optional(Type.String({ description: "Memory type for extracted items" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const lines = String(params.text ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l))
        .map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ""))
        .filter((l) => l.length > 20)
        .slice(0, 20);
      const results = [];
      for (const line of lines) {
        const type = params.type ?? "learning";
        const title = line.slice(0, 80);
        results.push(await saveObservation(pi, ctx, { title, type, topic_key: slugifyTopic(type, line), content: `**Learned**: ${line}` }, signal));
      }
      const info = await detectProject(pi, ctx, signal);
      return toolText(okEnvelope(info, { captured: results.length, results }));
    },
  });

  pi.registerTool({
    name: "mem_merge_projects",
    label: "Merge Memory Projects",
    description: "Merge source project names into a target canonical project. Requires confirm='MERGE'.",
    ...memoryToolRenderer("Merge Projects"),
    parameters: Type.Object({
      source_projects: Type.Array(Type.String(), { description: "Project names to merge from" }),
      target_project: Type.String({ description: "Canonical target project" }),
      confirm: Type.String({ description: "Must be exactly MERGE" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await ensureDb(pi, signal);
      const info = await detectProject(pi, ctx, signal);
      if (params.confirm !== "MERGE") return toolText(errEnvelope(info, "Refusing to merge projects without confirm='MERGE'."));
      const target = normalizeProjectName(params.target_project);
      if (!target) return toolText(errEnvelope(info, "target_project normalizes to an empty project name."));
      const sources = (params.source_projects ?? []).map((p: string) => normalizeProjectName(p)).filter(Boolean).filter((p: string) => p !== target);
      if (sources.length === 0) return toolText(errEnvelope(info, "No source projects to merge after normalization."));
      const projects = await availableProjects(pi, signal);
      const unknown = sources.filter((source: string) => !projects.includes(source));
      if (unknown.length > 0) return toolText(errEnvelope(info, `Unknown source project(s): ${unknown.join(", ")}`, { available_projects: projects }));

      const perSource: Array<{ source: string; observations: number; prompts: number; sessions: number }> = [];
      for (const source of sources) {
        const counts = await sqliteJson<{ observations: number; prompts: number; sessions: number }>(
          pi,
          `
          SELECT
            (SELECT COUNT(*) FROM observations WHERE project = ${sql(source)}) AS observations,
            (SELECT COUNT(*) FROM user_prompts WHERE project = ${sql(source)}) AS prompts,
            (SELECT COUNT(*) FROM sessions WHERE project = ${sql(source)}) AS sessions;
          `,
          signal,
        );
        await sqlite(
          pi,
          `
          UPDATE observations SET project = ${sql(target)}, updated_at = datetime('now') WHERE project = ${sql(source)};
          UPDATE user_prompts SET project = ${sql(target)} WHERE project = ${sql(source)};
          UPDATE sessions SET project = ${sql(target)} WHERE project = ${sql(source)};
          `,
          { signal },
        );
        perSource.push({ source, observations: Number(counts[0]?.observations ?? 0), prompts: Number(counts[0]?.prompts ?? 0), sessions: Number(counts[0]?.sessions ?? 0) });
      }
      projectCache.clear();
      return toolText(okEnvelope(info, { action: "merged", sources, target_project: target, counts: perSource }));
    },
  });

  pi.registerTool({
    name: "mem_export",
    label: "Export Memory JSON",
    description: "Export local memory JSON to a path relative to ctx.cwd unless absolute.",
    ...memoryToolRenderer("Export Memory"),
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Output path. Defaults to pi-memory-export-YYYY-MM-DD.json in cwd" })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await exportJson(pi, ctx, params.path, signal));
    },
  });

  pi.registerTool({
    name: "mem_import",
    label: "Import Memory JSON",
    description: "Import a JSON export produced by mem_export or /memexport. Deduplicates observations by normalized hash and prompts by exact content/project.",
    ...memoryToolRenderer("Import Memory"),
    parameters: Type.Object({ path: Type.String({ description: "Input JSON path, relative to ctx.cwd unless absolute" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolText(await importJson(pi, ctx, params.path, signal));
    },
  });

  pi.registerCommand("mem", {
    description: "Search local memory. Usage: /mem <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Uso: /mem <query>", "warning");
      try {
        const res = await searchMemories(pi, ctx, { query, limit: 8, include_content: false });
        ctx.ui.notify(typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memsave", {
    description: "Save local memory. Usage: /memsave title :: content",
    handler: async (args, ctx) => {
      const [title, ...body] = args.split("::");
      const content = body.join("::").trim();
      if (!title?.trim() || !content) return ctx.ui.notify("Usage: /memsave title :: content", "warning");
      try {
        const res = await saveObservation(pi, ctx, { title: title.trim(), content, type: "manual" });
        ctx.ui.notify(JSON.stringify(res.result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memcontext", {
    description: "Show recent local memory context for current project.",
    handler: async (_args, ctx) => {
      try {
        const res = await recentContext(pi, ctx, { limit: DEFAULT_CONTEXT_LIMIT });
        ctx.ui.notify(typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memstats", {
    description: "Show local memory stats.",
    handler: async (_args, ctx) => {
      try {
        const res = await stats(pi, ctx, {});
        ctx.ui.notify(JSON.stringify(res, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memexport", {
    description: "Export local memory JSON. Usage: /memexport [path]",
    handler: async (args, ctx) => {
      try {
        const res = await exportJson(pi, ctx, args.trim() || undefined);
        ctx.ui.notify(JSON.stringify(res.result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memimport", {
    description: "Import local memory JSON. Usage: /memimport <path>",
    handler: async (args, ctx) => {
      const file = args.trim();
      if (!file) return ctx.ui.notify("Uso: /memimport <path>", "warning");
      try {
        const res = await importJson(pi, ctx, file);
        ctx.ui.notify(JSON.stringify(res.result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("memsetup", {
    description: "Show Pi Local Memory setup info.",
    handler: async (_args, ctx) => {
      try {
        await ensureDb(pi);
        const info = await detectProject(pi, ctx);
        ctx.ui.notify(
          [
            "Pi Local Memory OK",
            `DB: ${DB_PATH}`,
            `SQLite bin: ${SQLITE_BIN}`,
            `Project: ${info.project} (${info.project_source})`,
            `Schema version: ${SCHEMA_VERSION}`,
            `Auto recall: ${AUTO_RECALL}`,
            `Auto recall limit: ${AUTO_RECALL_LIMIT}`,
            `Auto save prompts: ${AUTO_SAVE_PROMPTS}`,
            `Min prompt chars: ${MIN_PROMPT_CHARS}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Pi Local Memory error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
