/** Detected project identity used to scope project memories. */
export interface ProjectInfo {
  project: string;
  project_source: string;
  project_path: string;
  cwd: string;
}

/** Row shape returned by observation queries. */
export interface ObservationRow {
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
  tags?: string | null;
  citations?: string | null;
  confidence?: number | null;
  status?: string | null;
  verified_at?: string | null;
  search_snippet?: string | null;
}

/** Result returned by the shared observation search helper. */
export interface SearchRowsResult {
  rows: ObservationRow[];
  backend: "fts5" | "like" | "recent";
}
