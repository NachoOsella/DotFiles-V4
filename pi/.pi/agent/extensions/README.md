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
| `prompt-inspector` | `prompt-inspector/index.ts` | Inspect system prompt + tools + skills with token breakdown. Modules in `prompt-inspector/src/`. |
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

## Allowed offline test scope

`npm run test:allowed` selects direct `*.test.ts` files from an explicit directory allowlist. It includes the nested Codex test directory and fails when a selected directory has no matching tests.

| Directory | Selected files |
|-----------|----------------|
| `extensions/ask-user` | `extensions/ask-user/*.test.ts` |
| `extensions/background-terminals` | `extensions/background-terminals/*.test.ts` |
| `extensions/codex-search/tests` | `extensions/codex-search/tests/*.test.ts` |
| `extensions/git-info` | `extensions/git-info/*.test.ts` |
| `extensions/model-info` | `extensions/model-info/*.test.ts` |
| `extensions/subagents` | `extensions/subagents/*.test.ts` |
| `extensions/todowrite` | `extensions/todowrite/*.test.ts` |
| `extensions/ui-customization` | `extensions/ui-customization/*.test.ts` |
| `extensions/shared` | `extensions/shared/*.test.ts` |

The selector intentionally excludes `prompt-inspector`, `pi-zen-free`, `discord-activity`, and `session-stats`. It also leaves the deferred `extensions/file-search` test target and `extensions/firecrawl-search` workspace entry unchanged. This selector is offline only. It does not run live provider checks or visual terminal checks.

## Validation

Run the scoped offline tests from `/home/nacho/.pi/agent`:

```bash
npm run test:allowed
```

The existing repository-wide scripts remain available and unchanged. `npm test` still includes its existing `extensions/*/*.test.ts` target and the deferred `npm --prefix extensions/file-search test` follow-up, so use `test:allowed` for this allowlisted scope. The existing type checks remain:

```bash
npm run check
npm run check:extensions
```

For scoped extension type checks, run the package configurations explicitly:

```bash
for name in ask-user background-terminals codex-search git-info model-info subagents todowrite ui-customization; do
  ./node_modules/.bin/tsc --noEmit --preserveSymlinks \
    -p "extensions/$name/tsconfig.json"
done
```

Syntax-check modified extension entries with esbuild:

```bash
npx --yes -p esbuild esbuild \
  ~/.pi/agent/extensions/prompt-inspector/index.ts \
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

New helper modules should use `.js` suffixes in relative TypeScript imports. Direct Node strip-types tests in this workspace currently require `.ts` imports in existing test paths. Do not mass-convert imports to reconcile these two resolution paths.

## Next refactor phases

1. Split `checkpoint/checkpoint-core.ts` into git process helpers, snapshot filters, checkpoint creation, restore, and ref lookup.
2. Split `pi-diff-minimal/src/renderer.ts` into layout, line rendering, syntax highlighting, and theme helpers.
3. Continue `pi-engram-memory/index.ts`: next safe splits are SQLite/migrations, search, tools/commands, auto-recall, and browser modules.
