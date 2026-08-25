# AGENTS.md

## Commands

- **Install (shared):** `npm install` in `~/.pi/agent` (or `~/dotfiles/pi/.pi/agent`) — hoists `extensions/*` to single `node_modules` (symlinked as `~/.pi/agent/node_modules`). Never `npm install` inside `extensions/*`.
- **Type-check:** `npm run check` and `npm run check:extensions` in `~/.pi/agent`.
- **Format:** `npm run format` / `npm run format:check` in `~/.pi/agent` (prettier).
- **Test:** `npm test` in `~/.pi/agent` — `node --test --experimental-strip-types extensions/*/*.test.ts`. Targeted: `npm run test:lsp`, `test:todowrite`, `test:zen-free`.
- **Profile startup:** `PI_TIMING=1 pi --help` and `echo hi | PI_TIMING=1 pi -p "hi" 2>&1 | grep -A20 "Startup Timings"`.

## Architecture Boundaries

- `~/.pi/agent` is the runtime dir; `~/dotfiles/pi/.pi/agent` is the source. `extensions`, `package.json`, `settings.json`, `skills`, `themes`, `prompts` are symlinks between them. `node_modules` is shared via symlink `~/.pi/agent/node_modules -> ~/dotfiles/pi/.pi/agent/node_modules`.
- npm workspaces: `package.json:workspaces` lists each `extensions/*` with a manifest. `shared/` and `pi-zen-free/` (no `package.json`) are not workspaces. Per-extension `node_modules` must not exist.
- Pi auto-discovery: `extensions/*.ts` and `extensions/*/index.ts` only. Helper dirs must not contain `index.ts` (use `src/` or `_shared/`). See `extensions/README.md`.
- `jiti` loads TS with `alias` for `@earendil-works/pi-*`/`typebox`; other deps resolve via parent lookup with `preserveSymlinks:true` (`tsconfig.extensions.json`).

## Development Rules

- Shared runtime deps (`effect`, `@effect/platform-node`, `@earendil-works/pi-*`, `typebox`, `vscode-*`, `@xhayper/discord-rpc`, `firecrawl`) live in `~/.pi/agent/package.json:dependencies` with `overrides` pinning `effect@4.0.0-beta.98`. Extensions use `peerDependencies: {"effect":"*"}` for shared libs.
- Use `.js` suffix in relative TS imports inside extensions for `jiti` ESM.
- Keep `index.ts` thin (Pi registration); logic in small named-export modules, state isolated, TUI rendering separate.

## Testing

- After editing extensions: `npm run check:extensions` (covers `pi-zen-free`, `lsp`, `todowrite`).
- Prefer targeted `npm run test:<name>` during iteration, then `npm test` before completion.

## Safety and Constraints

- **Never:** add `effect` or `@earendil-works/pi-*` to `extensions/*/dependencies`; use `peerDependencies`.
- **Never:** create `extensions/*/node_modules` or commit `auth.json`, `sessions/`, `git/`, `pi-crash.log` (see `~/dotfiles/.gitignore`).
- **Ask first:** changing `overrides` version or `workspaces` list — affects all extensions.

## References

- Extension guide: `~/.pi/agent/extensions/README.md` (symlink to `~/dotfiles/pi/.pi/agent/extensions/README.md`)
- Global rules: `APPEND_SYSTEM.md`
- Workspace config: `~/.pi/agent/package.json`, `tsconfig.json`, `tsconfig.extensions.json`
