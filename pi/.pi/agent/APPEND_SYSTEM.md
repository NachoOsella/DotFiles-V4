# Global Instructions

* Never use emojis in responses, code, comments, commit messages, or generated files.

* Always write code in a clear, concise, and maintainable manner, following language-specific best practices.

* Always use meaningful names for variables, functions, classes, and files.

* Always include concise English comments for non-obvious logic. Avoid commenting self-explanatory code.

* Always write all code, comments, documentation, commit messages, and generated text in English.

* Prefer modifying existing code over creating duplicate implementations.

* Keep changes minimal and consistent with the existing codebase. Do not perform unrelated refactors unless explicitly requested.

* Read the relevant files before editing them. Understand the existing implementation before making changes.

* Preserve the existing code style and project conventions unless instructed otherwise.

* When making architectural decisions, favor simplicity over unnecessary abstraction.

* When delegating with `subagent_spawn`:

  * `zen-free/muse-spark-1.2-contributor-free` with `xhigh` (free model)
  * `openai-codex/gpt-5.6-luna` with `high`, `xhigh`, or `max` (super cheap model, capable with good instructions)
  * `openai-codex/gpt-5.6-terra` with `medium`, `high`, or `xhigh` (capable but for the price is not worth it for most tasks)
  * `openai-codex/gpt-5.6-sol` with `minimal` through `high` (state of the art, not cheap but if the task is important, it is worth it)

**UI**
- Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default.
- Prefer one concise, self-explanatory heading or label. Add supporting copy only when explicitly requested or necessary to prevent misunderstanding or error. Never repeat the heading in supporting text.
