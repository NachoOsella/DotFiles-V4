# Global Instructions

## Core

- Never use emojis in responses, code, comments, commit messages, documentation, or generated files.
- Write all code, comments, documentation, commit messages, and generated project text in English.
- Prefer the smallest clear, correct change that fully solves the task.
- Read and understand the relevant code before editing.
- Reuse existing code, standard library features, platform features, and installed dependencies before adding new implementations.
- Preserve the repository's architecture, naming, formatting, error handling, and conventions unless the task requires otherwise.
- Do not perform unrelated refactors or cleanup.
- Follow YAGNI. Prefer simple, direct solutions over speculative abstractions, extra flexibility, boilerplate, or dependencies.
- Make routine implementation decisions without asking. Ask only when reasonable interpretations would materially change the result.

## Code

- Write clear, concise, maintainable code with meaningful names.
- Comment only non-obvious intent, constraints, or deliberate shortcuts.
- Avoid unexplained domain or configuration literals. Do not extract obvious literals into pointless constants.
- Fix shared root causes instead of patching individual symptoms.
- For bug fixes, inspect relevant callers and sibling paths.
- Delete code made obsolete by the change, but do not optimize for fewer lines or smaller diffs at the cost of readability.
- If a file becomes meaningfully harder to maintain, split it along an existing responsibility boundary, not an arbitrary line limit.
- Mark deliberate shortcuts with a `ponytail` comment describing the limitation and intended upgrade path.

## Tests

- Do not write excessive tests.
- Add tests for meaningful observable behavior, not incidental implementation details.
- Avoid assertions on styling, colors, or internal structure unless they are part of the required behavior.
- For bug fixes, prefer a focused regression test when practical.
- Run the smallest relevant verification first, then expand when the risk justifies it.

## Writing style

- Use direct, literal prose.
- No em dashes, decorative language, metaphors, filler, or unnecessary repetition.
- Prefer ordinary, precise wording.

## UI

- Do not add subtitles, helper text, or descriptive copy by default.
- Prefer concise, self-explanatory labels and headings.
- Add supporting text only when requested or needed to prevent misunderstanding.
- Follow existing UI patterns and avoid adding elements just to make a screen feel fuller.

## Reliable file editing

- Before editing an existing file, work from the latest file content you have actually read. Never reconstruct `oldText` from memory.
- For the native `edit` tool, use `{ "path": "...", "edits": [{ "oldText": "...", "newText": "..." }] }`. Both text fields must be strings.
- Copy `oldText` exactly from the latest read, preserving indentation, whitespace, blank lines, quotes, Unicode, and newlines.
- Keep `oldText` as small as possible while still identifying exactly one location.
- All edits in one call target the same original snapshot. Do not overlap or nest edits; merge nearby changes when appropriate.
- If an edit fails, do not repeat the same call. For stale, missing, or ambiguous text, reread the relevant region, rebuild the edit, and retry. For schema or argument errors, correct the payload shape first.
- Do not rely on fuzzy matching to compensate for guessed or stale `oldText`.
- After a successful edit, inspect the returned diff. Reread only when the diff is insufficient or further edits need fresh context.
- Use `write` only for new files or intentional full-file replacements when the complete content is known.
- Never claim an edit succeeded unless the tool reports success.
