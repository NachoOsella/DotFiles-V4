# Pi Local Memory

Local persistent memory extension for Pi, inspired by the Engram mental model.

It does not use MCP, HTTP, cloud sync, or remote services. Everything is stored locally in SQLite + FTS5, and `mem_*` tools are registered directly in Pi.

## Location

```text
~/.pi/agent/extensions/pi-engram-memory/index.ts
```

Note: the folder keeps the name `pi-engram-memory`, but code and variables use `PI_MEMORY_*`.

Reload Pi with:

```text
/reload
```

Requires `sqlite3` with FTS5:

```bash
sudo pacman -S sqlite
```

## Environment variables

- `PI_MEMORY_DB`: DB path. Default: `~/.pi/agent/memory/pi-memory.db`
- `PI_MEMORY_SQLITE_BIN`: sqlite binary. Default: `sqlite3`
- `PI_MEMORY_PROJECT`: force project name
- `PI_MEMORY_AUTO_RECALL=0`: disable automatic recall before each turn
- `PI_MEMORY_AUTO_SAVE_PROMPTS=0`: disable automatic prompt saving
- `PI_MEMORY_RECALL_LIMIT`: number of memories auto-injected. Default: `6`, max: `20`
- `PI_MEMORY_MAX_RECALL_CHARS`: max characters for compact context. Default: `6000`
- `PI_MEMORY_CONTEXT_LIMIT`: default limit for `/memcontext`. Default: `8`
- `PI_MEMORY_MIN_PROMPT_CHARS`: minimum length for automatic prompt saving. Default: `20`
- `PI_MEMORY_SQLITE_TIMEOUT_MS`: sqlite timeout. Default: `8000`

## Registered tools

- `mem_current_project`: shows detected project and active DB
- `mem_save`: save or upsert durable memory
- `mem_search`: search observations with SQLite FTS5
- `mem_search_prompts`: search saved prompts with SQLite FTS5
- `mem_context`: show recent project context
- `mem_update`: update a memory by ID, including `tool_name`
- `mem_delete`: delete a memory, soft-delete by default, returns `not_found` if no rows were affected
- `mem_get_observation`: fetch full observation content
- `mem_timeline`: show chronological context around an observation
- `mem_suggest_topic_key`: suggest stable key for upserts
- `mem_save_prompt`: save a prompt manually, optional `force`
- `mem_session_start`: start a new logical memory session
- `mem_session_end`: mark session ended and redact secrets from summary
- `mem_session_summary`: save session summary as both session summary and observation
- `mem_capture_passive`: extract bullet/numbered learnings and apply automatic `topic_key`
- `mem_merge_projects`: safe project merge, requires `confirm: "MERGE"` and returns counts
- `mem_stats`: DB statistics
- `mem_export`: export memories/prompts/sessions to JSON
- `mem_import`: import exported JSON with deduplication for observations and prompts

## Slash commands

- `/mem <query>`: search memory
- `/memsave title :: content`: save memory manually
- `/memcontext`: show recent context
- `/memstats`: show metrics
- `/memexport [path]`: export JSON
- `/memimport <path>`: import JSON
- `/memsetup`: validate configuration

## TUI

- Footer status now uses a compact, theme-aware indicator: `◆ mem <project>`.
- `mem_*` tools have dedicated renderers: compact headers, success/error state, active project, and expandable preview.
- Expanding a tool result shows full detail, while collapsed state avoids JSON walls.

## Security and quality improvements

- Redaction of common secret patterns before saving.
- `mem_delete` no longer falsely confirms non-existent deletions.
- `mem_merge_projects` requires explicit confirmation and validates source projects.
- `mem_session_end` redacts secrets in session summaries.
- Prompt auto-save skips trivial or very short prompts.
- Auto-recall ignores empty results or non-searchable queries.
- Export uses `ctx.cwd` for relative paths.
- Schema includes `meta` table with `schema_version`.
- Additional indexes for project filtering and `updated_at`.

## Notes

- Project detection order: `PI_MEMORY_PROJECT`, then `git remote`, then git root, then cwd name.
- `topic_key` lets you update evolving memories instead of creating duplicates.
- If another extension also registers `mem_*` tools, avoid enabling both at the same time to prevent name collisions.
