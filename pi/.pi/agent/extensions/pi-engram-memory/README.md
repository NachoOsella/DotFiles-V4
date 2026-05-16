# engram

Compact persistent memory for Pi. Inspired by Engram's concept of high-signal,
token-efficient knowledge units.

**3 tools, SQLite storage, FTS5 search when available, bounded recall.**

## Location

```text
~/.pi/agent/extensions/pi-engram-memory/index.ts
```

Reload Pi:

```text
/reload
```

Requires `sqlite3`:

```bash
sudo pacman -S sqlite
```

## Tools

| Tool | Description |
|------|-------------|
| `mem_save` | Save or update a structured observation. Uses `topic_key` for upserts, content hashes for deduplication, optional tags/citations, and priority defaults by type. |
| `mem_search` | Search current-project memories plus global personal memories. Uses SQLite FTS5 BM25 when available and weighted `LIKE` fallback otherwise. Omit `query` for recent results; pass `id` for exact lookup. |
| `mem_admin` | Stats, delete, export JSON, and import JSON. |

### mem_save

```json
{
  "title": "Fixed N+1 query in UserList",
  "content": "## Finding\n- UserList triggered lazy loading.\n\n## Fix\n- Added fetch join in UserRepository.\n\n## Why it matters\n- Prevents 50 queries per page.",
  "type": "bugfix",
  "priority": 4,
  "topic_key": "bugfix/user-list-n-plus-one",
  "tags": ["database", "performance"],
  "citations": ["src/UserRepository.java:45"],
  "confidence": 0.95,
  "scope": "project"
}
```

- `topic_key` enables upserts: same key updates the existing memory.
- `scope: "project"` stores memory for the detected repo/project.
- `scope: "personal"` stores memory in a global personal namespace that is searchable from every project.
- `citations` should point to files or code locations that future agents can verify before relying on code-specific memories.
- Keep memories atomic: explain what changed, why it matters, and where to verify it.

### mem_search

```json
{
  "query": "authentication token refresh",
  "priority_min": 3,
  "limit": 5
}
```

Useful parameters:

- `id`: exact lookup; use after a compact result points to a relevant memory.
- `query`: precise keywords; 2-5 nouns usually work best.
- `scope`: `project` or `personal`; default searches both current project and global personal memories.
- `type`: exact type filter.
- `tags`: all provided tags must match.
- `updated_after`: lower bound for `updated_at`.
- `project`: admin/debug override for project-scoped search.
- `include_content`: full content for exact or follow-up lookups.

### mem_admin

```text
mem_admin action=stats
mem_admin action=delete id=5 confirm=YES
mem_admin action=delete id=5 hard=true confirm=YES
mem_admin action=export path=./backup.json
mem_admin action=import path=./backup.json
```

## Priority system

Priority (1-5) controls ranking and auto-recall. Project memories with
`priority >= 3` are candidates for task recall. Personal preferences are
searched separately and may be recalled when they match the prompt.

| Priority | Common types | Auto-recall |
|----------|--------------|-------------|
| 4 | architecture, bugfix, decision, explicit preferences | Yes |
| 3 | config | Yes |
| 2 | discovery, learning | Searchable |
| 1 | low-signal preference/background | Searchable |

## Search and recall

Before each non-command turn, engram performs two bounded recall passes:

1. Matching global personal preferences.
2. Matching high-priority current-project memories.

Results are injected as compact snippets and capped by `PI_MEMORY_MAX_RECALL_ITEMS`
and `PI_MEMORY_MAX_RECALL_CHARS`. If a memory includes citations, the prompt
reminds the agent to verify the cited files before relying on that fact.

Search uses SQLite FTS5 BM25 with weighted columns when available:

- title: highest weight
- topic key: high weight
- tags/citations: medium weight
- content: normal weight

If the local SQLite build does not support FTS5, the extension falls back to the
previous weighted `LIKE` search.

## Selective auto-capture

The extension does not store raw prompts. It only auto-captures explicit durable
instructions such as:

- "remember ..."
- "for future ..."
- "I prefer ..."
- "always ..."
- "never ..."

These are saved as high-priority `preference` memories. By default they use
`scope: "personal"`; prompts that explicitly mention the current project/repo are
saved with `scope: "project"`.

## Memory behavior policy

The extension nudges the agent to:

- Use `mem_search` before exploratory file reads when prior project context may matter.
- Prefer narrow searches with concrete keywords, `priority_min >= 3`, and `limit <= 5`.
- Use exact `id` lookups with `include_content` only after a compact search result is relevant.
- Verify cited files before applying code-specific memories.
- Save durable findings with `mem_save` using stable `topic_key` values.
- Avoid storing secrets, large code blobs, transient logs, or routine edits.

## Slash commands

| Command | Description |
|---------|-------------|
| `/mem [query]` | Search memory; no query shows recent memories. |
| `/mem #123` | Fetch exact memory content. |
| `/memsave title :: content` | Quick save as `type=discovery`. |
| `/memstats` | Show statistics. |
| `/memexport [path]` | Export all memory to JSON. |
| `/memimport <path>` | Import memory from JSON with deduplication. |
| `/memsetup` | Validate config and show FTS/recall status. |
| `/membrowse [query]` | Browse memories in an interactive TUI. Search supports text plus filters like `type:bugfix`, `scope:personal`, and `p>=3`. |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MEMORY_DB` | `~/.pi/agent/memory/pi-memory.db` | Database path. |
| `PI_MEMORY_SQLITE_BIN` | `sqlite3` | SQLite binary. |
| `PI_MEMORY_PROJECT` | auto-detect | Force project name. |
| `PI_MEMORY_AUTO_RECALL=0` | enabled | Disable auto-recall. |
| `PI_MEMORY_AUTO_CAPTURE=0` | enabled | Disable selective preference auto-capture. |
| `PI_MEMORY_MAX_RECALL_ITEMS` | 5 | Max memories injected before a turn. |
| `PI_MEMORY_MAX_RECALL_CHARS` | 1000 | Max chars for injected recall block. |
| `PI_MEMORY_SQLITE_TIMEOUT_MS` | 8000 | SQLite process timeout. |
| `PI_MEMORY_SQLITE_BUSY_TIMEOUT_MS` | `PI_MEMORY_SQLITE_TIMEOUT_MS - 1000` | SQLite lock wait timeout before retry. |

## Internal structure

The extension entry remains `index.ts` for Pi auto-discovery. Supporting modules keep the large codebase easier to maintain:

- `config.ts` — environment configuration and constants.
- `types.ts` — shared row and project types.
- `utils.ts` — pure text, SQL-literal, hashing, snippet, and search-term helpers.
- `format.ts` — memory row and save-result formatting.
- `tool-renderers.ts` — compact TUI renderers for memory tools.

## Storage

SQLite with WAL mode stores observations and sessions. The schema migrates in
place and adds optional metadata columns:

- `tags`
- `citations`
- `confidence`
- `status`
- `verified_at`

An `observations_fts` FTS5 table plus triggers is created when supported. The
index is rebuilt on startup to keep existing databases consistent.

## Migrating from old version

If you have an existing DB from the previous version, export before upgrading:

```text
/memexport ./old-backup.json
/reload
/memimport ./old-backup.json
```

Or delete the old DB and start fresh:

```bash
rm ~/.pi/agent/memory/pi-memory.db
/reload
```

## Why so few tools?

The previous version had many `mem_*` tools, each adding prompt overhead. With
3 tools, definitions remain small and the context budget stays focused on useful
retrieved memories.
