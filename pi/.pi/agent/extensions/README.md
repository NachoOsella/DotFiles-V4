# Pi extensions workspace

This directory is symlinked from `~/.pi/agent/extensions` and contains personal Pi extensions.

## Auto-discovery rules

Pi auto-loads:

- `*.ts` files directly under this directory.
- `*/index.ts` files one level below this directory.

Do not add `index.ts` to helper-only directories. Use names such as `dump-prompt/formatter.ts` or `_shared/render.ts` for reusable modules that must not auto-load as extensions.

## Compatibility policy

The current refactor policy is: **phased full refactor with no behavior changes**.

Preserve:

- command names
- tool names and schemas
- environment variables
- package `pi.extensions` entry points
- auto-discovery behavior
- user-visible defaults

## Current structure

| Extension | Entry | Notes |
|-----------|-------|-------|
| `dump-prompt` | `dump-prompt.ts` | Top-level entry with helper modules in `dump-prompt/`. |
| `pi-zen-free` | `pi-zen-free/index.ts` | Provider registration split into API, config, model mapping, and types. |
| `todowrite` | `todowrite/index.ts` | Tool entry split into schema, state, widget, renderers, and types. |
| `token-rate` | `token-rate/token-rate.ts` | Package entry preserved; logic split into state, status, tokens, and types. |
| `codex-plan-mode` | `codex-plan-mode/index.ts` | Entry handles state and Pi hooks; plan parsing, prompt builders, message helpers, and request-user-input are split out. |
| `checkpoint` | `checkpoint/checkpoint.ts` | Package entry preserved; core git operations are in `checkpoint-core.ts`. |
| `session-stats` | `session-stats/index.ts` | Entry handles `/stats`; parser, aggregation, formatting, modal, panels, and output builders are split out. |
| `pi-diff-minimal` | `pi-diff-minimal/src/index.ts` | Package-style extension; renderer is the main remaining monolith. |
| `pi-engram-memory` | `pi-engram-memory/index.ts` | Largest extension; config, types, pure utilities, row formatting, and tool renderers are split out. |

## Module conventions

- Keep extension entry files focused on Pi registration and event wiring.
- Put pure logic in small modules with named exports.
- Keep state mutation in one module per extension.
- Keep TUI rendering separate from business logic.
- Use `.js` suffixes in relative TypeScript imports so jiti/runtime ESM resolution works.
- Do not create helper directories with `index.ts` unless the directory should be auto-loaded as an extension.
- Prefer no-op/fallback behavior over throwing during startup.
- Check `ctx.hasUI` before using interactive UI surfaces.

## Validation

Syntax-check modified extension entries with esbuild:

```bash
npx --yes -p esbuild esbuild \
  ~/.pi/agent/extensions/dump-prompt.ts \
  ~/.pi/agent/extensions/pi-zen-free/index.ts \
  ~/.pi/agent/extensions/todowrite/index.ts \
  ~/.pi/agent/extensions/token-rate/token-rate.ts \
  ~/.pi/agent/extensions/codex-plan-mode/index.ts \
  ~/.pi/agent/extensions/session-stats/index.ts \
  ~/.pi/agent/extensions/pi-engram-memory/index.ts \
  --bundle=false --format=esm --platform=node --outdir=/tmp/pi-extension-check
```

For package-style extensions, also run their local tests when available:

```bash
cd ~/.pi/agent/extensions/checkpoint && npm test
cd ~/.pi/agent/extensions/pi-diff-minimal && npm test
```

## Next refactor phases

1. Split `checkpoint/checkpoint-core.ts` into git process helpers, snapshot filters, checkpoint creation, restore, and ref lookup.
2. Split `pi-diff-minimal/src/renderer.ts` into layout, line rendering, syntax highlighting, and theme helpers.
3. Continue `pi-engram-memory/index.ts`: next safe splits are SQLite/migrations, search, tools/commands, auto-recall, and browser modules.
