---
name: web-research
description: Use for researched facts with sources and citations.
---

# Web Research

Conduct systematic research with verifiable evidence and citations.

## Available Tools

| Tool | Purpose |
|------|---------|
| `web_search` | Search the web with AI-synthesized answers, multi-query support, recency filters, and domain scoping |
| `fetch_content` | Extract readable markdown content from URLs, YouTube videos/transcripts, GitHub repos, and local files |
| `code_search` | Search for code examples, API documentation, and library usage patterns from GitHub, Stack Overflow, and official docs |
| `get_search_content` | Retrieve full stored content from a previous `web_search` or `fetch_content` call via `responseId` |

## When to use this skill

Use it when the answer depends on information that may have changed, needs source attribution, or requires reading outside the current conversation. Typical cases:

- latest status, news, pricing, policies, schedules, or product specs
- technical questions that need official docs, standards, papers, or release notes
- comparisons that should be grounded in real sources
- extracting content from URLs, YouTube, PDFs, or GitHub repos

## Research workflow

### Phase 1: Plan

Before searching, clarify:
1. **What** exactly needs to be answered?
2. **How many sources** are needed for confidence? (3+ for complex topics)
3. **What evidence** would validate the answer? (benchmarks, docs, expert opinions, release notes)

### Phase 2: Search Strategically

Use `web_search` with **multiple varied queries** (2-4) rather than a single query. Each query gets its own synthesized answer, so varying phrasing, scope, and angle gives broader coverage.

Prefer primary sources when the topic is technical:

- official docs, standards, RFCs, release notes
- original papers, vendor docs, repository READMEs
- reputable benchmarks or issue trackers when docs are incomplete

```
# Good — varied angles covering different aspects
queries:
  - "React Server Components vs client components performance 2025"
  - "React Server Components real-world benchmark results"
  - "when to use React Server Components limitations"

# Bad — redundant phrasing, same scope
queries:
  - "React Server Components"
  - "React Server Components info"
  - "about React Server Components"
```

**Key parameters:**
- `recencyFilter`: use `"month"` or `"year"` for fast-moving topics like tech, security, and pricing
- `domainFilter`: scope to authoritative domains, or exclude noise with `-` prefixes
- `provider`: `"auto"` by default; override only when you need a specific backend
- `includeContent`: set `true` when you need full page text stored for later retrieval
- `numResults`: 5-20 results per query

### Phase 3: Fetch Deep Content

Use `fetch_content` when:
- A search result URL contains critical details not in the snippet
- You need to extract a YouTube video transcript or frames
- You need to explore a GitHub repository's contents
- A page requires full-text analysis beyond the search summary

```
# Extract content from specific URLs
fetch_content(urls: ["https://example.com/article", "https://example.com/docs"])

# YouTube video with specific question
fetch_content(url: "https://youtube.com/watch?v=...", prompt: "What does the speaker say about error handling at 12:30?")

# GitHub repository (clones if needed)
fetch_content(url: "https://github.com/org/repo")
```

### Phase 4: Code & API Research

Use `code_search` for programming-specific questions:
- Library usage patterns and examples
- API signatures and parameters
- Common debugging solutions
- Framework best practices from real codebases

### Phase 5: Retrieve Full Content

When a `web_search` or `fetch_content` response was too truncated, use `get_search_content` with the `responseId` to retrieve the full stored content:

```
get_search_content(responseId: "abc123", query: "first query text")
get_search_content(responseId: "abc123", urlIndex: 0)
```

### Phase 6: Synthesize & Cite

Produce a structured output:

1. **Executive summary** — 2-4 sentences answering the core question
2. **Key findings** — bullet points with inline source citations (e.g., `[source 1]`, `[source 3]`)
3. **Evidence table** (when comparing) — structured comparison with sources
4. **Caveats & uncertainty** — note conflicting sources, outdated info, or speculation
5. **Sources** — numbered list with URLs and brief descriptions

If the user asked for "latest" or "today", include exact dates and compare publish date vs event date when they differ.

## Quality Standards

- **Cross-verify**: Don't rely on a single source for factual claims, especially numbers, dates, or technical specifications
- **Cite everything**: Every claim should have an inline citation pointing to a specific source
- **Note recency**: Flag information that may be outdated; prefer recent sources for fast-moving topics
- **Distinguish fact from opinion**: Clearly separate documented facts from blog opinions or speculation
- **Show work**: Briefly explain the search strategy so the user can replicate or extend it
- **Handle contradictions**: When sources disagree, present the conflict and explain which is more authoritative and why
- **Prefer primary sources**: When possible, rely on official or original sources over summaries or reposts

## Anti-Patterns

- Don't synthesize answers from memory when current external data is needed
- Don't cite sources you haven't actually searched or fetched
- Don't present search snippets as definitive facts — dig deeper with `fetch_content` when needed
- Don't skip the planning phase — unstructured searching wastes tokens and misses key angles
- Don't ignore contradictory evidence — address it head-on

## References

- `references/web-search-guide.md` — Detailed guide on `web_search` parameters, providers, and advanced patterns
- `references/content-extraction.md` — Guide for `fetch_content` including YouTube transcripts, GitHub repos, and frame extraction
