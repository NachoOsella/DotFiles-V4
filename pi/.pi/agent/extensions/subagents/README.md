# pi-subagents

Third-party Pi extension: Codex MultiAgentV2-style subagents
(`spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
`interrupt_agent`, `list_agents`).

Pi adaptation informed by `openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3`
(see `CODEX_SOURCE_MANIFEST.md` and `docs/CODEX_PARITY.md`). The revision is a
behavioral reference, not a complete parity claim. Not an OpenAI product.

## Use

```text
spawn_agent(task_name="check_tests", message="Run the focused suite.", agent_type="reviewer", fork_turns="all")
send_message(target="/root/check_tests", message="Still working.")
followup_task(target="/root/check_tests", message="Also check Windows.")
wait_agent(timeout_ms=60000)   # synchronizes only; returns no child output
interrupt_agent(target="/root/check_tests")
list_agents(path_prefix="/root")
```

Children run in persistent independent Pi sessions and report each completed
turn to their direct parent with `FINAL_ANSWER`. Child transcripts stay in their
own sessions; only the final answer enters the parent model context.

## Child capabilities

A child inherits the caller's active tools, cwd, skills, context files, and the
`codemode` and `tool_search` built-ins, so it can orchestrate local tools and
filter large results the same way the parent can. MCP is deliberately not
loaded: no child opens an MCP server, and `-builtin:<name>` still disables a
built-in for children too.

The six collaboration tools declare an `outputSchema` and return
`structuredContent`, so codemode scripts read their fields directly instead of
parsing text:

```js
const child = await tools.spawn_agent({
    task_name: 'review',
    message: 'Review the pending diff.',
})
text(child.task_name)
```

`wait_agent` follows the caller's abort signal. Escape, a cancelled tool call,
or a codemode deadline ends the wait immediately; it never interrupts the child
that is still running. `interrupt_agent` remains the way to stop one.

Turns started by child extensions, such as background-terminal notifications,
are also tracked and report their outcome to the parent. If execution capacity
is full, an extension-triggered turn is aborted and becomes `Interrupted`.
Its message remains in the child session for a later `followup_task`. Providers
must honor Pi's abort signal.

## Inspect and follow

`/agents`, or `alt+a`, opens a live inspector: agent rows with status, thinking
level and quiet time, plus a per-agent timeline of tool calls, durations and
nested calls. `tab` switches panels, `1`-`5` filter kinds, `g`/`G` jump, `^u`/`^d`
page, the wheel scrolls, and `q` closes. It reads state only: interrupting or
messaging an agent stays in the conversation, through the collaboration tools.
The timeline keeps the latest 500 committed activity entries per agent; full
conversation history remains in the native session.

A child's final answer arrives in the parent transcript as a card with its role,
model, tokens, cost and duration, and the `followup_task` path to continue that
agent. Failed runs render as `FINAL ERROR` with the error text.

## Configure (environment)

| Variable                     | Effect                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBAGENTS_DISABLED=1`       | Register no tools                                                                                                                        |
| `SUBAGENTS_DISABLE_WAIT=1`   | Hide `wait_agent`                                                                                                                        |
| `SUBAGENTS_MAX_CONCURRENT=N` | Active child-run slots (default 4)                                                                                                       |
| `SUBAGENTS_MAX_AGENTS=N`     | Logical child identities (default 6)                                                                                                     |
| `SUBAGENTS_MAX_LOADED=N`     | Loaded child sessions (default 16)                                                                                                       |
| `SUBAGENTS_MAX_DEPTH=N`      | Allowed nesting after a direct child; direct children are depth 0 (default 1). This is a Pi safety limit that Codex V2 does not enforce. |

`model` uses `provider/model-id`. `reasoning_effort` accepts `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, or `max`. Overrides are valid with
`fork_turns=none` or a bounded N. Full-history forks reject direct model and
reasoning overrides; they inherit caller execution defaults unless `agent_type`
selects configured role defaults.

Optional extension settings can be placed under `subagents` in `settings.json`,
or supplied as JSON through `SUBAGENTS_CONFIG` / `SUBAGENTS_CONFIG_PATH`.
Configured `roles` are exposed as `agent_type` choices in the spawn schema.

## Source layout

```text
subagents/
  index.ts           Pi registration and session hooks
  src/
    core/            Coordinator, native sessions, delivery and run limits
    domain/          Identities, paths, statuses, records and message contracts
    config/          Settings, roles, delegation modes and prompts
    persistence/     Snapshot schema, recovery, record mapping and forks
    tools/           Collaboration tool schemas, execution and rendering
    ui/              Dashboard, activity feed and transcript cards
  docs/              Architecture, Pi bindings and Codex reference
```

Tests sit beside the modules they exercise. Start with `index.ts` for Pi wiring,
`src/core/coordinator.ts` for execution, and `src/persistence/schema.ts` for the
saved-data contract.

Only snapshot schema `version: 2` under `subagents-v3-state` is supported.
Retired snapshots are ignored, not migrated. Existing session files are not
deleted. Old settings aliases are ignored; use `maxConcurrentExecutions`,
`maxLoadedAgents`, and `wait.{minTimeoutMs,defaultTimeoutMs,maxTimeoutMs}` under
`settings.json.subagents`.

## Session billing

The footer cost and cache share include the parent and all logical children,
including nested agents. `CH` reports cache reads over prompt tokens with the
same formula as `/stats`, not the latest single response. Context percentage and
window remain specific to the parent. Child usage updates after finalized
responses, without waiting for full settlement.
`/stats` shows the thread and physical-model breakdown; `/stats all` includes
linked child transcripts without separately adding their snapshots. Unavailable
child files use persisted usage instead. Free-model reference estimates stay
separate from billed or catalog-calculated cost.

## Develop

Run from the agent workspace:

```bash
npm run check:extensions
npm run test:subagents
```

The extension-local `npm test` runs `src/*/*.test.ts`.

Docs: `docs/PI_API_BINDINGS.md`, `docs/ARCHITECTURE.md`,
`docs/CODEX_PARITY.md`.
