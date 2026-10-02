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

Children run in persistent independent Pi sessions, report back with one bounded
`FINAL_ANSWER`, and never leak transcripts into the parent model context.

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

## Inspect and follow

`/agents`, or `alt+a`, opens a live inspector: agent rows with status, thinking
level and quiet time, plus a per-agent timeline of tool calls, durations and
nested calls. `tab` switches panels, `1`-`5` filter kinds, `g`/`G` jump, `^u`/`^d`
page, the wheel scrolls, and `q` closes. It reads state only: interrupting or
messaging an agent stays in the conversation, through the collaboration tools.

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

## Develop

```bash
./node_modules/.bin/tsc --noEmit -p extensions/subagents/tsconfig.json
node --test --experimental-strip-types extensions/subagents/*.test.ts
```

Docs: `docs/PI_API_BINDINGS.md`, `docs/ARCHITECTURE.md`,
`docs/CODEX_PARITY.md`.
