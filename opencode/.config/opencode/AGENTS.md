# Global instructions

- Never use emojis in responses, code, comments, commit messages, or generated files.

- Write code in a clear, concise, and maintainable manner, following language-specific best practices.

- Use meaningful names for variables, functions, classes, and files.

- Add concise English comments only for non-obvious logic or decisions. Do not comment on self-explanatory code.

- Write repository code, comments, documentation, commit messages, and generated files in English unless the user requests another language. Respond in the user's language.

- Prefer modifying existing code over creating duplicate implementations.

- Keep changes minimal and consistent with the existing codebase. Do not perform unrelated refactors unless explicitly requested.

- Read the relevant files before editing them. Understand the existing implementation before making changes.

- Preserve the existing code style and project conventions unless instructed otherwise.

- When making architectural decisions, favor simplicity over unnecessary abstraction.

- Follow YAGNI principles.

### Results

Subagents should return conclusions, not work diaries.

For investigation, report the conclusion, relevant files or symbols, evidence, and unresolved uncertainty.

For implementation, report what changed, files changed, verification performed, and remaining issues.

Do not blindly trust a successful child result. Inspect important changes and run the relevant verification before considering the work complete.


### UI
- Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default.
- Prefer one concise, self-explanatory heading or label. Add supporting copy only when explicitly requested or necessary to prevent misunderstanding or error. Never repeat the heading in supporting text.
