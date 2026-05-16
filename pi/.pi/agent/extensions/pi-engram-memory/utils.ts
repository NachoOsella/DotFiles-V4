import { createHash } from "node:crypto";
import { DEFAULT_PRIORITY, SEARCH_STOP_WORDS } from "./config.js";

/** Escape a value for SQLite literal interpolation. */
export function sql(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Normalize a project name to a stable, filesystem-safe identifier. */
export function normalizeProjectName(value: string): string {
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

/** Normalize text for hashing and deduplication. */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Hash normalized content so duplicate observations can be counted. */
export function normalizedHash(
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

/** Clip long text to a maximum character count. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated to ${max} chars]`;
}

/** Redact common API keys and tokens before storage/export. */
export function redactSecrets(text: string): string {
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

/** Return the default priority for a memory type. */
export function defaultPriority(type: string): number {
  return DEFAULT_PRIORITY[type.toLowerCase()] ?? 3;
}

/** Extract precise search terms while dropping stop words. */
export function extractTerms(query: string): string[] {
  const seen = new Set<string>();
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((term) => term.replace(/^-+|-+$/g, ""))
    .filter((term) => {
      if (term.length < 3 && !/^(ui|db|id|js|ts|go)$/i.test(term)) return false;
      if (SEARCH_STOP_WORDS.has(term) || seen.has(term)) return false;
      seen.add(term);
      return true;
    })
    .slice(0, 8);
}

/** Build an FTS5 MATCH expression from normalized terms. */
export function ftsMatchQuery(terms: string[]): string {
  return terms
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" OR ");
}

/** Normalize arrays or scalar strings into a JSON string list. */
export function normalizeStringList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.map((item) => cleanInline(String(item))).filter(Boolean).slice(0, 20);
    return items.length ? JSON.stringify(items) : null;
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeStringList(parsed);
    } catch {
      // Fall through and store the original scalar string.
    }
  }
  const text = cleanInline(String(value ?? ""));
  return text ? JSON.stringify([text]) : null;
}

/** Summarize a JSON list string for compact display. */
export function listSummary(value: string | null | undefined, maxItems = 3): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => cleanInline(String(item))).filter(Boolean).slice(0, maxItems).join(", ");
  } catch {
    // Use the raw value below.
  }
  return cropPlain(value, 80);
}

/** Build a stable topic-key suffix from arbitrary text. */
export function slugifyTopic(value: string): string {
  const base = normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha1").update(normalizeText(value)).digest("hex").slice(0, 8);
  return `${base || "memory"}-${hash}`;
}

/** Clean an FTS snippet before display. */
export function cleanSnippet(value: string | null | undefined): string {
  return cleanInline(String(value ?? "").replace(/[\u0001\u0002]/g, ""));
}

/** Build weighted LIKE relevance SQL for query terms. */
export function keywordScoreSql(terms: string[]): string {
  if (terms.length === 0) return "0";
  return terms
    .map((term) => {
      const q = sql(term);
      return [
        `(CASE WHEN lower(o.title)=${q} THEN 10 ELSE 0 END)`,
        `(CASE WHEN lower(o.title) LIKE '%' || ${q} || '%' THEN 5 ELSE 0 END)`,
        `(CASE WHEN lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' THEN 4 ELSE 0 END)`,
        `(CASE WHEN lower(COALESCE(o.tags, '')) LIKE '%' || ${q} || '%' THEN 2 ELSE 0 END)`,
        `(CASE WHEN lower(COALESCE(o.citations, '')) LIKE '%' || ${q} || '%' THEN 2 ELSE 0 END)`,
        `(CASE WHEN lower(o.content) LIKE '%' || ${q} || '%' THEN 1 ELSE 0 END)`,
      ].join(" + ");
    })
    .join(" + ");
}

/** Build SQL requiring at least one searchable field to match each query term. */
export function keywordCoverageSql(terms: string[]): string {
  if (terms.length === 0) return "0";
  return terms
    .map((term) => {
      const q = sql(term);
      return `(CASE WHEN lower(o.title) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.topic_key, '')) LIKE '%' || ${q} || '%' OR lower(o.content) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.tags, '')) LIKE '%' || ${q} || '%' OR lower(COALESCE(o.citations, '')) LIKE '%' || ${q} || '%' THEN 1 ELSE 0 END)`;
    })
    .join(" + ");
}

/** Build a one-line text snippet. */
export function snip(content: string, maxLen = 120): string {
  if (!content) return "";
  const flat = cleanInline(content);
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + "...";
}

/** Collapse whitespace for inline display. */
export function cleanInline(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Crop plain inline text with an ellipsis. */
export function cropPlain(text: string, maxLen: number): string {
  const value = cleanInline(text);
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}
