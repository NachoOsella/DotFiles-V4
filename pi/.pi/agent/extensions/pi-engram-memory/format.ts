import type { ObservationRow } from "./types.js";
import { cleanSnippet, cropPlain, listSummary, snip } from "./utils.js";

/** Type abbreviation map for ultra-minimal display. */
const TYPE_ABBR: Record<string, string> = {
  architecture: "arch",
  bugfix: "bugf",
  config: "conf",
  decision: "deci",
  discovery: "disc",
  learning: "lear",
  preference: "pref",
};

/** Return the compact four-character type abbreviation. */
export function typeAbbr(type: string): string {
  return TYPE_ABBR[type] ?? type.slice(0, 4);
}

/** Format a detailed row header for exact lookup output. */
export function formatRowHeader(row: ObservationRow): string {
  const scope = row.scope === "personal" ? "personal" : (row.project || "project");
  const status = row.status && row.status !== "active" ? ` ${row.status}` : "";
  return `#${row.id} [${typeAbbr(row.type)}] ${row.title} (p${row.priority}, ${scope}${status})`;
}

/** Format metadata for exact lookup output. */
export function formatRowMetadata(row: ObservationRow): string {
  const lines: string[] = [];
  if (row.topic_key) lines.push(`topic: ${row.topic_key}`);
  const tags = listSummary(row.tags);
  if (tags) lines.push(`tags: ${tags}`);
  const citations = listSummary(row.citations);
  if (citations) lines.push(`citations: ${citations}`);
  if (typeof row.confidence === "number") lines.push(`confidence: ${row.confidence.toFixed(2)}`);
  return lines.length ? lines.map((line) => `  ${line}`).join("\n") : "";
}

/** Format a single observation as one compact line. */
export function formatRowMinimal(row: ObservationRow, includeContent: boolean): string {
  const id = `#${row.id}`;
  const scope = row.scope === "personal" ? "personal" : row.project;
  const topic = row.topic_key ? ` ${row.topic_key}` : "";
  const meta = `${typeAbbr(row.type)} p${row.priority} ${scope}`;
  const title = cropPlain(row.title, includeContent ? 44 : 54);
  const head = `${id} ${meta}${topic} ${title}`;
  const snippet = includeContent
    ? snip(row.content ?? "", 72)
    : (cleanSnippet(row.search_snippet) || snip(row.content ?? "", 52));
  const line = snippet ? `${head} -- ${snippet}` : head;
  return cropPlain(line, includeContent ? 140 : 128);
}

/** Format an observation in a verbose legacy shape. */
export function formatRow(row: ObservationRow, includeContent: boolean): string {
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

/** Format a save result object as one ultra-minimal text line. */
export function formatSaveResult(result: any): string {
  if (!result.ok) return `error: ${result.error}`;
  const row = result.result;
  if (!row) return "error: unknown";
  switch (row.action) {
    case "inserted": return `saved #${row.id} (p${row.priority})`;
    case "updated": return `updated #${row.id} (p${row.priority})`;
    case "deduped": return `duplicate #${row.id}`;
    default: return `#${row.id} (${row.action})`;
  }
}
