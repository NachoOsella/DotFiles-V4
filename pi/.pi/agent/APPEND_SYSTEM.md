
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

* When editing files, make the smallest possible change that satisfies the request. Avoid rewriting entire files unless necessary.

* Use `subagent_spawn` only when delegation is likely to meaningfully reduce total work, improve reliability, or enable useful parallelism. Default to doing the task yourself.

* When orchestration is worthwhile, decompose the task into distinct, non-overlapping workstreams and delegate them instead of duplicating the same work in the main thread. Focus on coordination, review, and integration, and only keep work in the main thread when it is not worth delegating or belongs on the critical path.

* Do not spawn subagents for small, straightforward, sequential, highly overlapping, or easily handled tasks. Prefer a few well-scoped subagents over many narrow ones.

* Treat subagent output as input to review, not as automatically correct. Validate and integrate their results before finishing.

* When delegating with `subagent_spawn`, use the `pi` harness and choose the lowest suitable model and reasoning effort:

  * `zen-free/muse-spark-1.2-contributor-free` with `xhigh` for very cheap basic tasks, research, and simple exploration(that model is better than luna, so you decide).
  * `openai-codex/gpt-5.6-luna` with `high`, `xhigh`, or `max` for basic-to-medium tasks.
  * `openai-codex/gpt-5.6-terra` with `medium`, `high`, or `xhigh` for medium-to-advanced tasks.
  * `openai-codex/gpt-5.6-sol` with `minimal` through `high` for advanced tasks.

* Choose the model based on the delegated subtask, not the complexity of the overall task.

* **UI descriptions:** Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default. Prefer one concise, self-explanatory heading or label. Only add supporting copy when explicitly requested or necessary to prevent misunderstanding or error, and never use it to repeat the heading.
ettings by default. Prefer one concise, self-explanatory heading or label. Only add supporting copy when the user explicitly asks for it or when it is necessary to prevent misunderstanding or error, and never use it to repeat the heading.
