# Web Search Reference Guide

## Providers

| Provider | Requires | Notes |
|----------|----------|-------|
| `exa` | API key (or MCP fallback) | Direct API with key, falls back to MCP. Good for structured search. |
| `perplexity` | API key | Strong synthesis and reasoning. Needs `PERPLEXITY_API_KEY`. |
| `gemini` | API key | Google's search-backed answers. Needs Gemini API key. |
| `auto` (default) | — | Auto-selects: Exa → Perplexity → Gemini API → Gemini Web (browser login) |

## Parameters Deep Dive

### `queries` (preferred over `query`)

Always prefer `queries` (array) for research tasks. Each query returns its own synthesized answer with a unique `responseId`.

**Effective query design:**
- Vary **phrasing**: `"X vs Y benchmarks"` vs `"performance comparison X and Y"`
- Vary **scope**: broad overview → specific angle → edge case
- Vary **source type**: official docs → community discussion → benchmark data
- Include **year/date** for time-sensitive topics

### `recencyFilter`

- `"day"` — breaking news, real-time data
- `"week"` — recent releases, announcements
- `"month"` — fast-moving tech, pricing changes
- `"year"` — stable but current information

### `domainFilter`

**Include only:**
```json
["docs.djangoproject.com", "djangoproject.com"]
```

**Exclude noise:**
```json
["-pinterest.com", "-quora.com", "-reddit.com", "-medium.com"]
```

**Combine:**
```json
["github.com", "docs.python.org", "-stackoverflow.com"]
```

### `includeContent`

When `true`, full page content is fetched in the background and stored. Use `get_search_content` later with the `responseId` to retrieve it. Essential for deep analysis when search snippets aren't enough.

### `numResults`

- Default: 5
- Max: 20
- Use higher values (10-15) for broad topics
- Use lower values (3-5) for narrow, well-defined queries

### `workflow`

- `"none"` — skip curation, just return search results
- `"summary-review"` (default) — open curator with auto summary draft

## Advanced Patterns

### Multi-Phase Research

```
# Phase 1: Broad landscape
web_search(queries: ["topic overview 2025", "topic alternatives comparison"])

# Phase 2: Deep dive on specific aspects (use responseIds from Phase 1)
get_search_content(responseId: "...", query: "topic overview 2025")

# Phase 3: Targeted follow-up
web_search(queries: ["specific subtopic benchmark", "specific subtopic limitations"])
```

### Evidence Verification

```
# Search for claim
web_search(queries: ["specific claim to verify"])

# If URL found, fetch full content for verification
fetch_content(urls: ["https://source-url.com/article"])
```

### Comparative Research

For comparing N options, structure queries to cover:
1. Each option individually (official docs, benchmarks)
2. Direct comparisons (X vs Y, head-to-head)
3. Community sentiment (discussions, reviews)
4. Migration/switching costs (if applicable)
