# engram

Compact persistent memory for Pi. Inspired by Engram's concept of high-signal,
token-efficient knowledge units.

**3 tools, no bloat, priority-based recall.**

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
| `mem_save` | Save or update (via `topic_key`) a structured observation. Auto-dedup by content hash. Priority 1-5 assigned by type unless overridden. |
| `mem_search` | Search observations by query, type, priority. Omit query for recent results. Pass `id` for exact lookup. |
| `mem_admin` | Stats, delete (soft/hard), export JSON, import JSON. |

### mem_save

```json
{
  "title": "Fixed N+1 query in UserList",
  "content": "**What**: Fixed N+1 query in UserList\n**Why**: Lazy loading caused 50 queries per page\n**Where**: UserRepository.java:45-67",
  "type": "bugfix",
  "priority": 4,
  "topic_key": "architecture/db-performance"
}
```

- `topic_key` enables upserts: same key = update existing.
- `type` defaults to `discovery`.
- `priority` defaults: architecture/bugfix/decision=4, config=3,
  discovery/learning=2, preference/prompt=1.

### mem_search

- Omit `query` for most recent observations.
- Pass `id` for exact lookup (ignores all other params).
- `include_content: true` for full text, otherwise compact snippets.

### mem_admin

```text
mem_admin action=stats
mem_admin action=delete id=5 confirm=YES
mem_admin action=delete id=5 hard=true confirm=YES
mem_admin action=export path=./backup.json
mem_admin action=import path=./backup.json
```

## Priority system

Priority (1-5) determines what gets auto-recalled. Only memories with
**priority >= 3** are injected into the LLM context before each turn.
Lower-priority items are still searchable on demand.

| Priority | Types | Auto-recall |
|----------|-------|-------------|
| 4 | architecture, bugfix, decision | Yes |
| 3 | config | Yes |
| 2 | discovery, learning | No |
| 1 | preference, prompt | No |

## Auto-recall

Before each turn, engram searches for memories with priority >= 3 that
match the user's current prompt. Results are injected as compact
one-liners (title + type + topic + 100-char snippet), capped at ~1000
chars total.

Auto-save stores user prompts as low-priority (1) observations
(type=prompt) for future search, without bloating auto-recall.

## Slash commands

| Command | Description |
|---------|-------------|
| `/mem <query>` | Search memory |
| `/memsave title :: content` | Quick save (type=discovery) |
| `/memstats` | Show statistics |
| `/memexport [path]` | Export all memory to JSON |
| `/memimport <path>` | Import from JSON (dedup) |
| `/memsetup` | Validate config and show status |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MEMORY_DB` | `~/.pi/agent/memory/pi-memory.db` | Database path |
| `PI_MEMORY_SQLITE_BIN` | `sqlite3` | SQLite binary |
| `PI_MEMORY_PROJECT` | auto-detect | Force project name |
| `PI_MEMORY_AUTO_RECALL=0` | enabled | Disable auto-recall |
| `PI_MEMORY_AUTO_SAVE_PROMPTS=0` | enabled | Disable prompt auto-save |
| `PI_MEMORY_MAX_RECALL_CHARS` | 1000 | Max chars for auto-recall |
| `PI_MEMORY_MIN_PROMPT_CHARS` | 20 | Min length for prompt auto-save |
| `PI_MEMORY_SQLITE_TIMEOUT_MS` | 8000 | SQLite query timeout |

## Storage

Simple SQLite with WAL mode, single `observations` table. No FTS5, no
virtual tables, no triggers beyond the schema. LIKE-based search is
sufficient for hundreds of memories and keeps the extension lean.

## Migrating from old version

If you have an existing DB from the previous version (19-tool
pi-engram-memory), export before upgrading:

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

The previous version had 19 `mem_*` tools, each one adding
~100-200 tokens to every LLM system prompt. With 3 tools, the
definition overhead is minimal, leaving more context budget for
actual work. Auto-recall is similarly lean: only high-priority
memories, only compact snippets, capped at 1000 chars.
