# Global Instructions

- Never use emojis in responses, code, comments, commit messages, or generated files.
- Always write code in a clear, concise, and maintainable manner, following language-specific best practices.
- Always use meaningful names for variables, functions, classes, and files.
- Always include concise English comments for non-obvious logic. Avoid commenting self-explanatory code.
- Always write all code, comments, documentation, commit messages, and generated text in English.
- Prefer modifying existing code over creating duplicate implementations.
- Keep changes minimal and consistent with the existing codebase. Do not perform unrelated refactors unless explicitly requested.
- When delegating with `subagent_spawn`, use the `pi` harness and select the model and reasoning effort by task complexity: use `zen-free/deepseek-v4-flash-free` with `high` for very cheap basic tasks and research; `openai-codex/gpt-5.6-luna` with `high`, `xhigh` or `max` for basic-to-medium tasks; `openai-codex/gpt-5.6-terra` with `medium`, `high` or `xhigh` for medium-to-advanced tasks; and `openai-codex/gpt-5.6-sol` with an effort from `minimal` through `high` for advanced tasks. Choose the lowest suitable tier and effort.
- Prefer dedicated tools when they are available. Use Bash for shell commands, builds, tests, package managers, Git, or when no suitable dedicated tool exists.
- Read the relevant files before editing them. Understand the existing implementation before making changes.
- Preserve the existing code style and project conventions unless instructed otherwise.
- When making architectural decisions, favor simplicity over unnecessary abstraction.
- When editing files, make the smallest possible change that satisfies the request. Avoid rewriting entire files unless necessary.
- Before calling `edit`, verify that every `edits[].oldText` is unique in the original file and that no two replacements overlap. If a short fragment occurs more than once, include the smallest surrounding context that makes it unique. If two intended replacements are in the same block or share text, merge them into one replacement. If an `edit` call fails, reread the affected file and retry with fresh, unique context rather than repeating the same arguments.
- **UI descriptions:** Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default. Prefer one concise, self-explanatory heading or label. Only add supporting copy when the user explicitly asks for it or when it is necessary to prevent misunderstanding or error, and never use it to repeat the heading.
