# Nacho Codex Search

Personal Pi extension adapted from [Leechael/pi-codex-search](https://github.com/Leechael/pi-codex-search).
It provides `codex_search` using Pi's existing `openai` authentication (Sign in with ChatGPT),
with fallback to the legacy `openai-codex` login.

This local copy is private and maintained directly in the Pi extensions workspace. The original MIT
license and attribution are preserved in `LICENSE`.

## Why this exists

Web search does not have to be built into Pi. It can be a tool.

This extension is for Pi workflows that need fresh or source-backed information:

- **Look up current docs and release notes.** Ask the model to check things that changed after its training cutoff.
- **Get sources with the answer.** Search results include citations when OpenAI returns them.
- **Reuse your ChatGPT login.** The tool uses Pi's stored `openai` OAuth credential, or the legacy `openai-codex` credential when that is the active login, instead of asking you to paste tokens.
- **Batch related searches in Responses mode.** One `codex_search` call can run related queries together.
- **Inspect webpages when explicitly enabled.** `codex_standalone_web` sends one standalone action per tool call because `/alpha/search` rejects multi-action batching.
- **Keep projects in control.** Change defaults, enable the standalone tool, or disable the extension per project.

## What this package adds

- A `codex_search` Pi tool using the Responses API.
- 1–32 search queries per `codex_search` call, controlled by `batchSize`.
- Optional `codex_standalone_web` using experimental `/alpha/search` with open, find, click, screenshot, finance, weather, sports, and time commands. It accepts exactly one action per tool call.
- `live`, `indexed`, or `cached` freshness, plus `low` / `medium` / `high` search context size. Standalone mode disables `low` because Codex returns Cloudflare challenges for low-context standalone requests.
- Streaming progress while OpenAI responds.
- Collapsed result previews in the TUI, with full text and sources available when expanded.
- Structured details: model, citations, search calls, response ids, usage, and per-query failures.
- Config files for home and project defaults.
- `/codex-search-settings` for status, editing, reset, standalone enablement, and disable.

## Install

From npm:

```bash
pi install npm:pi-codex-search
```

Or load a local checkout without installing:

```bash
pi -e /path/to/pi-codex-search
```

### Install from GitHub Release tarball

If you prefer not to use npm, download the tarball from the [latest release](https://github.com/Leechael/pi-codex-search/releases/latest), extract it, and install from the local path:

```bash
curl -L https://github.com/Leechael/pi-codex-search/releases/latest/download/pi-codex-search.tar.gz | tar -xz -C /tmp
pi install /tmp/pi-codex-search
```

## Sign in

Inside Pi, run:

```text
/login openai
```

Choose `Sign in with ChatGPT` when Pi asks for the login method. Pi stores and refreshes the credential. The extension prefers this official login and calls `https://api.openai.com/v1/responses` directly.

The legacy Codex login still works:

```text
/login openai-codex
```

Choose `ChatGPT Plus/Pro (Codex Subscription)`. The extension uses the stored `openai-codex` credential when `openai` is not configured, or when the active Pi model already uses `openai-codex`.

The tool is registered by default. If neither login can provide a credential, the first `codex_search` call fails with an `auth` error that points back to `/login openai`. A legacy Codex credential also needs a ChatGPT account id.

Set `enabled: false` if you want the extension installed but hidden for a project.

## Tool

Default tools:

```text
codex_search
codex_standalone_web
```

`codex_search` is always registered when the extension is enabled. `codex_standalone_web` is optional and off by default.

Example call:

```json
{
  "name": "codex_search",
  "arguments": {
    "queries": ["latest OpenAI Codex release notes"],
    "search_context_size": "medium",
    "freshness": "live"
  }
}
```

Arguments for `codex_search`:

- `queries` — required array of search questions. Queries run in parallel and results are grouped by query. The default max is 5 and the hard max is 32.
- `search_context_size` — optional, one of `low`, `medium`, `high`; defaults to `medium`.
- `freshness` — optional, `live`, `indexed`, or `cached`; defaults to `live`.

Arguments for optional `codex_standalone_web`:

- `urls` — one page to open/fetch directly.
- `find` — one `{ "url", "pattern" }` object for in-page text search after opening the URL.
- `click` — one `{ "url", "id" }` object for following a link id from an opened page.
- `screenshot` — one `{ "url", "pageno" }` object for page screenshots after opening the URL.
- `finance`, `weather`, `sports`, `time` — one Codex web lookup command.

Standalone uses `medium` or `high` search context only. If standalone is enabled while the saved context is `low`, settings normalize it to `medium`.

The tool returns text. When citations are available, the text includes a `Sources:` section.

The structured `details` object includes:

- `model`
- `api`
- `freshness` / `searchContextSize`
- `queryCount` / `failedQueryCount`
- `successes`: per-query `{ query, text, citations, searchCalls, responseId?, usage? }`
- `failures`: per-query `{ query, kind, message }`

Failure `kind` is one of `auth`, `rate_limit`, `transport`, `timeout`, `schema`, or `unknown`.

## Model used for search

The search request needs a model id that the active login can use. The extension chooses it in this order:

1. `model` from env / project / home config, if set.
2. The active Pi model, if it comes from the same provider as the resolved login and appears in that provider's model catalog.
3. The default model from the login's catalog: `https://api.openai.com/v1/models` for `openai`, or `/codex/models` for `openai-codex`.

Most users do not need to set this. Model ids differ between logins; for example, the official `openai` login exposes subscription models such as `gpt-6.1-sol`, while `openai-codex` exposes Codex model ids.

## Settings

Most users only need `/login openai`. Use settings when you want to enable `codex_standalone_web`, disable the extension for a project, pin a model, or change defaults.

Open the interactive settings dialog:

```text
/codex-search-settings
```

Useful subcommands:

```text
/codex-search-settings status
/codex-search-settings reset
```

Settings are merged from three layers, highest precedence first:

1. Environment variables.
2. Project file: `<cwd>/.pi/pi-codex-search.json`.
3. Home file: `~/.pi/pi-codex-search.json`.

Each layer is optional. Missing files are skipped. Malformed JSON or invalid values fail fast so you do not silently run with the wrong tool settings.

Because the project file lives under `<cwd>/.pi/`, it follows Pi's project trust rules. If you decline to trust a project, the extension reads only the home file and environment variables; the project scope is hidden in the settings dialog and cannot be saved or deleted until the project is trusted.

Full schema, all fields optional:

```json
{
  "enabled": true,
  "standaloneEnabled": false,
  "model": "gpt-6.1-sol",
  "baseUrl": "https://api.openai.com/v1",
  "searchContextSize": "medium",
  "freshness": "live",
  "batchSize": 5
}
```

`enabled: false` skips tool registration entirely. The model will not see `codex_search` or `codex_standalone_web`.

`standaloneEnabled: true` registers `codex_standalone_web`. It uses the legacy `openai-codex` login because the official `openai` login does not expose the standalone `/alpha/search` endpoint. It posts web commands to `/codex/alpha/search` on `chatgpt.com/backend-api`, accepts one action per tool call, stores returned ref ids for follow-up open/find/click/screenshot actions, disables `low` search context, and may be blocked by Cloudflare or backend session limits. Use `codex_search` for web search queries.

`searchApi: "standalone"` from older configs is treated as `standaloneEnabled: true` for compatibility.

`clientVersion` only affects the legacy Codex `/codex/models` request. The official `openai` login uses `/v1/models` and ignores it.

Environment variable equivalents:

| Field               | Env var                              |
| ------------------- | ------------------------------------ |
| `enabled`           | `PI_CODEX_WEB_SEARCH_ENABLED`        |
| `standaloneEnabled` | `PI_CODEX_WEB_STANDALONE_ENABLED`    |
| `model`             | `PI_CODEX_WEB_SEARCH_MODEL`          |
| `baseUrl`           | `PI_CODEX_WEB_SEARCH_BASE_URL`       |
| `clientVersion`     | `PI_CODEX_WEB_SEARCH_CLIENT_VERSION` |
| `searchContextSize` | `PI_CODEX_WEB_SEARCH_CONTEXT_SIZE`   |
| `freshness`         | `PI_CODEX_WEB_SEARCH_FRESHNESS`      |
| `batchSize`         | `PI_CODEX_WEB_SEARCH_BATCH_SIZE`     |

`PI_CODEX_WEB_SEARCH_ENABLED` accepts `true` / `false` (case-insensitive). Any other value fails config loading.

The settings dialog shows a unified `SettingsList` view. The model picker loads models from the resolved login asynchronously after the dialog opens, so the UI appears immediately when the model catalog is slow. Interactive edits write the selected config file immediately. When you close the dialog, Pi reloads so the tool set and defaults apply without restarting the whole terminal.

## Notes

### Codex search vs model search

This does not add browsing to the model provider itself. It adds a Pi tool. The model decides when to call `codex_search`, just like any other tool.

### Account id

Legacy `openai-codex` requests need both the access token and the ChatGPT account id. The extension first checks Pi's stored OAuth credential. If that does not include an account id, it tries to extract one from the access token. The official `openai` login does not use a separate account id header.

## Troubleshooting

### `codex_search` fails with an `auth` error

Run:

```text
/login openai
```

Choose `Sign in with ChatGPT`. If you use the legacy Codex login instead, run `/login openai-codex` and choose `ChatGPT Plus/Pro (Codex Subscription)`. The extension picks up the refreshed credential on the next call.

### `codex_search` says the account id was not found

This only applies to the legacy `openai-codex` login. The stored OAuth credential did not include an account id, and the extension could not decode one from the access token. Re-run `/login openai-codex` so Pi refreshes the credential, or switch to `/login openai`.

### The model does not see `codex_search`

Check whether `enabled` is false in env, project config, or home config:

```text
/codex-search-settings status
```

Remember that env overrides project, and project overrides home.

### Search uses the wrong model

Set `model` in your config file, or set `PI_CODEX_WEB_SEARCH_MODEL`, to a model id from the active login's catalog. If unset, the extension uses the active model when it belongs to the same provider and is present in the catalog, then falls back to the catalog default.

### `codex_standalone_web` fails with the official OpenAI login

The standalone web tool uses the legacy Codex `/alpha/search` endpoint. Run `/login openai-codex` if you need standalone page actions, or keep using `codex_search` with the official `openai` login.

### A different extension already registers `codex_search`

The tool names are fixed as `codex_search` and `codex_standalone_web`. Disable conflicting extensions or tools with the same names.

## Development

```bash
npm install
npm run check
npm test
npm run lint
npm run format:check
```

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)

## License

MIT
