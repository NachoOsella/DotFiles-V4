---
name: subagent-orchestration
description: Orchestrate Pi subagents for parallel investigation, implementation, review, and verification. Use when a task has independent workstreams, benefits from specialist agents, or the user asks to delegate, coordinate, parallelize, or run multiple agents.
---

# Subagent orchestration

Use subagents to isolate context and run independent work in parallel. Keep the root agent responsible for the plan, integration, and final verification.

## Decide whether to delegate

Delegate when a task has substantial workstreams that can proceed independently, such as separate modules, research questions, or implementation and review.

Stay with one agent when the work needs only one or two tool calls, follows a strict dependency chain, or requires constant edits to the same files. Coordination has a cost.

## Plan the work

1. Identify dependencies before spawning agents.
2. Run independent tasks in parallel. Wait for prerequisites before delegating dependent work.
3. Give each editing agent exclusive file or module ownership. Shared filesystem changes are visible immediately.
4. Keep cross-cutting decisions and final integration with the root agent.
5. Reserve one slot for follow-up or verification when capacity is tight.

Write delegation prompts that are clear, explanatory, and self-contained. The child should understand the task without guessing the parent's intent or rereading the full conversation. Never delegate with vague prompts such as "investigate this," "fix the tests," or "review the code."

Each delegation should state:

- the problem and why the work matters;
- one bounded objective;
- relevant paths, symbols, evidence, and prior decisions;
- allowed edits or explicit read-only scope;
- constraints, non-goals, and dependencies;
- acceptance criteria and exact checks to run;
- expected result, including files changed, evidence, checks run, and unresolved risks.

Include enough context to act, but omit unrelated history. Ask agents for conclusions, not work diaries.

## Spawn with the right context

`spawn_agent` starts asynchronously, so launch independent tasks before waiting.

```text
spawn_agent(
  task_name="inspect_auth",
  fork_turns="none",
  message="Inspect src/auth read-only. Find the cause of issue X. Return evidence with paths and a proposed fix; do not edit files."
)
```

Choose `fork_turns` deliberately:

- `none`: preferred when the brief is self-contained. It keeps the child focused and permits model and reasoning overrides.
- `N`: include only the recent turns needed for conversational context. Overrides are also permitted.
- `all`: use only when the full conversation is essential. Direct model and reasoning overrides are rejected.

Use `agent_type` only for configured roles. Choose the cheapest model that can reliably do the task. Save stronger models for architecture, subtle correctness, and final review.

Nested delegation is useful only when the child owns a genuinely separable workstream and the configured depth limit allows it.

## Coordinate agents

Use stable task names and explicit ownership.

- `send_message` adds context without starting an idle turn. Use it to correct an assumption or provide newly discovered information.
- `followup_task` assigns more work to an existing identity. It steers a running agent or restarts an idle, completed, or interrupted one.
- `interrupt_agent` stops the current run but preserves the agent identity.
- `list_agents` checks status and capacity. `/agents` opens the live dashboard.

Do not ask an agent to call collaboration tools on your behalf. Call them directly.

## Collect and integrate

Continue useful root work while children run. When blocked, call `wait_agent` once with a long timeout rather than polling. It only synchronizes; it does not return child content. The child's `FINAL_ANSWER` arrives separately in the parent context.

After results arrive:

1. Inspect important edits and claims yourself. Do not trust a success report blindly.
2. Resolve conflicting assumptions or overlapping changes centrally.
3. Run focused checks, then the repository-wide verification required by the project.
4. Send a bounded follow-up to the same agent if its work needs correction.
5. Report the integrated outcome, verification, and remaining issues.

## Useful patterns

- Parallel investigation: assign different hypotheses or subsystems read-only, then synthesize the evidence.
- Partitioned implementation: settle interfaces first, then give agents disjoint files and acceptance tests.
- Implementation plus review: let one agent implement while another reviews the relevant existing behavior or test plan, then verify both at the root.
- Best-of-N: ask several read-only agents for alternative designs when uncertainty justifies the extra cost. Pick one before editing.

Avoid spawning duplicate agents for the same task, polling with repeated `list_agents`, passing the full history by default, or letting multiple agents edit the same files.
