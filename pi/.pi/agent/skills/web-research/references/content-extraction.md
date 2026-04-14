# Content Extraction Reference Guide

## fetch_content Capabilities

### Web Pages

Extract readable content as markdown from any URL:

```
fetch_content(url: "https://example.com/article")
fetch_content(urls: ["https://a.com", "https://b.com", "https://c.com"])  # parallel
```

- Falls back to Gemini for pages that block bots or fail Readability extraction
- Content is stored and can be retrieved with `get_search_content`

### YouTube Videos

Two modes available:

**Transcript extraction (with optional prompt):**
```
# Generic transcript
fetch_content(url: "https://youtube.com/watch?v=abc123")

# Focused analysis — ALWAYS pass the user's specific question via prompt
fetch_content(
  url: "https://youtube.com/watch?v=abc123",
  prompt: "What does the speaker recommend for error handling patterns?"
)
```

**Frame extraction** (requires `yt-dlp` + `ffmpeg`):
```
# Single frame at timestamp
fetch_content(url: "...", timestamp: "12:30")

# Multiple frames at 5s intervals from a single timestamp
fetch_content(url: "...", timestamp: "12:30", frames: 4)

# Frames across a time range (contact sheet)
fetch_content(url: "...", timestamp: "10:00-15:00", frames: 8)

# Sample frames across entire video
fetch_content(url: "...", frames: 6)

# With model override and prompt
fetch_content(
  url: "...",
  timestamp: "5:00-20:00",
  frames: 10,
  prompt: "Describe the architecture diagram shown",
  model: "gemini-2.5-flash"
)
```

### GitHub Repositories

```
# Standard (clones if under size threshold)
fetch_content(url: "https://github.com/org/repo")

# Force clone for large repos
fetch_content(url: "https://github.com/org/repo", forceClone: true)
```

### Local Video Files

Requires `ffmpeg`:
```
fetch_content(url: "file:///path/to/video.mp4", prompt: "Describe the UI shown at 2:30")
fetch_content(url: "file:///path/to/video.mp4", timestamp: "1:00-3:00", frames: 5)
```

## Retrieving Stored Content

After `web_search` or `fetch_content`, use `get_search_content`:

```
# From web_search by query text
get_search_content(responseId: "abc123", query: "first search query")

# From web_search by query index
get_search_content(responseId: "abc123", queryIndex: 0)

# From fetch_content by URL
get_search_content(responseId: "abc123", url: "https://example.com")

# From fetch_content by URL index
get_search_content(responseId: "abc123", urlIndex: 0)
```

## When to Use fetch_content

| Scenario | Tool | Why |
|----------|------|-----|
| Search snippet is enough | `web_search` only | Saves tokens and time |
| Need full article text | `web_search` + `fetch_content` | Deep analysis requires full content |
| YouTube tutorial question | `fetch_content` with `prompt` | Focused transcript analysis |
| Code in a GitHub repo | `fetch_content` | Access raw source files |
| Video frame analysis | `fetch_content` with `frames` | Visual understanding |
| Parallel multi-page extraction | `fetch_content(urls: [...])` | All fetched simultaneously |
