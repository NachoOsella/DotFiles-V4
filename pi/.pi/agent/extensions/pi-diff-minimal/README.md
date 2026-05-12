# pi-diff-minimal

A stripped-down pi extension that replaces the default `write` and `edit` tool output with **Shiki-powered, syntax-highlighted diffs** -- side-by-side split view, unified stacked view, and word-level change emphasis, all rendered directly in your terminal. Colors automatically derive from your pi theme.

This is a clean extraction of the diff rendering from [pi-diff](https://github.com/buddingnewinsights/pi-diff), with all review tools, CLI, prompts, and TUI overlay removed.

## Features

- **Syntax-highlighted diffs** -- full Shiki grammar highlighting (190+ languages) composited with diff background colors
- **Split view** -- side-by-side comparison for `edit` tool, auto-falls back to unified on narrow terminals
- **Unified view** -- stacked single-column layout for `write` tool overwrites
- **Word-level emphasis** -- changed characters get brighter backgrounds so you see exactly what changed
- **New file preview** -- syntax-highlighted preview when creating files
- **Theme-aware colors** -- diff backgrounds mix your pi theme's `toolDiffAdded`/`toolDiffRemoved` colors into `toolSuccessBg`/`toolErrorBg`; Shiki syntax theme auto-matches dark/light
- **Adaptive layout** -- auto-detects terminal width; wraps intelligently on wide terminals, truncates on narrow ones
- **LRU cache** -- singleton Shiki highlighter with 192-entry cache for fast re-renders
- **Large diff fallback** -- gracefully degrades (skips highlighting, still shows diff structure) for files > 80k chars
- **Fully customizable** -- every color and threshold is overridable via environment variables

## Install

Load directly for development:

```bash
pi -e ./dist/index.js
```

Or install from a local path via `package.json`.

## Configuration

Colors are set via environment variables or `.pi/settings.json`:

```bash
# Environment variables
export DIFF_BG_ADD="#1a3320"
export DIFF_THEME="github-dark"
```

```json
// .pi/settings.json
{
  "diffTheme": "default",
  "diffColors": {
    "bgAdd": "#1a3320",
    "fgAdd": "#50d264"
  }
}
```

Available presets: `default`, `midnight`, `subtle`, `neon`.

## How It Works

pi-diff-minimal wraps the built-in `write` and `edit` tools from the pi SDK. When the agent writes or edits a file:

1. **Before the write** reads the existing file content
2. **Delegates** to the original SDK tool (file is actually written)
3. **After the write** computes a structured diff between old and new content
4. **Renders** the diff with syntax highlighting and word-level emphasis

The rendering pipeline:

```
Old content --+
              +-- diff (structuredPatch) -- parse -- highlight (Shiki -> ANSI)
New content --+                                           |
                                                          +-- inject diff bg
                                                          +-- inject word-level bg
                                                          +-- wrap/fit to terminal
```

## License

MIT
