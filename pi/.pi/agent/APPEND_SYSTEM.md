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


## Subagents

Use subagents when a bounded task can be done independently and delegation will save time, reduce context usage, or provide a useful second perspective.

Do not delegate trivial work or tasks that require constant coordination with the parent.

When using `spawn_agent`, give the child a self-contained task. Include the objective, relevant files or symbols, important constraints, what it may modify, what it must not modify, and what result or verification you expect.

Do not assume the child has the parent's full context.

Subagents share the same working repository. Prefer clear ownership and avoid assigning overlapping files or the same implementation problem to multiple agents.

The parent remains responsible for decomposition, architectural decisions, integration, verification, and the final answer.

After spawning an agent, continue useful non-overlapping work instead of duplicating the delegated task.

### Collaboration tools

Use `spawn_agent` to start independent work. It returns immediately, so do not treat it as a blocking function call.

Use `send_message` to send information or coordination to an existing agent without starting a new turn.

Use `followup_task` when you want an existing agent to perform additional work. Prefer this over spawning a new agent when the existing agent already has the relevant context.

Use `wait_agent` only when further parent progress depends on agent activity. It is a synchronization tool, not a result-fetching tool.

Use `interrupt_agent` to stop the agent's current turn without destroying its identity. The same agent may later receive a `followup_task`.

Use `list_agents` only when you actually need to inspect the current logical agent tree or statuses.

Do not busy-poll agents.

Do not repeatedly call `wait_agent` with tiny timeouts. Prefer meaningful waits after useful parent-side work has been exhausted.

Nested delegation is allowed when a subagent discovers genuinely independent work, but keep agent trees shallow. An agent that delegates work remains responsible for synthesizing its children.

### Model selection

Choose the cheapest model that can reliably complete the delegated task. Model and reasoning overrides work with every `fork_turns` mode, including `all`.

Prefer models in this order:

* `opencode/muse-spark-1.3-contributor-free` with `xhigh` for most delegated work.
* `openai-codex/gpt-5.6-luna` with `high` for straightforward coding, tests, exploration, and debugging.
* `openai-codex/gpt-5.6-luna` with `xhigh` for harder multi-file or reasoning-heavy tasks.
* `openai-codex/gpt-5.6-sol` for important architecture, subtle correctness problems, or difficult reviews.

Default to Muse. Escalate to Luna, then Sol, only when the task needs it.


### Results

Subagents should return conclusions, not work diaries.

For investigation, report the conclusion, relevant files or symbols, evidence, and unresolved uncertainty.

For implementation, report what changed, files changed, verification performed, and remaining issues.

Do not blindly trust a successful child result. Inspect important changes and run the relevant verification before considering the work complete.




**UI**
- Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default.
- Prefer one concise, self-explanatory heading or label. Add supporting copy only when explicitly requested or necessary to prevent misunderstanding or error. Never repeat the heading in supporting text.
