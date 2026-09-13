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

- Follow the YAGNI principles.

### Model selection

Choose the cheapest model that can reliably complete the delegated task. Model and reasoning overrides work with every `fork_turns` mode, including `all`.

Prefer models in this order:

* `opencode/muse-spark-1.3-contributor-free` with `xhigh` for most delegated work.
* `openai-codex/gpt-5.6-luna` with `high` for straightforward coding, tests, exploration, and debugging.
* `openai-codex/gpt-5.6-luna` with `xhigh` for harder multi-file or reasoning-heavy tasks.
* `openai-codex/gpt-5.6-sol` for important architecture, subtle correctness problems, or difficult reviews.

### Results

Subagents should return conclusions, not work diaries.

For investigation, report the conclusion, relevant files or symbols, evidence, and unresolved uncertainty.

For implementation, report what changed, files changed, verification performed, and remaining issues.

Do not blindly trust a successful child result. Inspect important changes and run the relevant verification before considering the work complete.


### UI
- Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default.
- Prefer one concise, self-explanatory heading or label. Add supporting copy only when explicitly requested or necessary to prevent misunderstanding or error. Never repeat the heading in supporting text.
