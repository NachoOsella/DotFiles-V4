# pi-subagents

Third-party Pi extension: Codex MultiAgentV2-style subagents
(`spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
`interrupt_agent`, `list_agents`).

Behavioral port of `openai/codex@9d83c48e...` (see
`CODEX_SOURCE_MANIFEST.md`). Not an OpenAI product.

## Use

```text
spawn_agent(task_name="check_tests", message="Run the focused suite.", model="openai-codex/gpt-5.6-luna", reasoning_effort="high", fork_turns="all")
send_message(target="/root/check_tests", message="Still working.")
followup_task(target="/root/check_tests", message="Also check Windows.")
wait_agent(timeout_ms=60000)   # synchronizes only; returns no child output
interrupt_agent(target="/root/check_tests")
list_agents(path_prefix="/root")
```

Children run in independent sessions, report back with one bounded
`FINAL_ANSWER`, and never leak transcripts into the parent context.

## Configure (environment)

| Variable | Effect |
|---|---|
| `SUBAGENTS_DISABLED=1` | Register no tools |
| `SUBAGENTS_DISABLE_WAIT=1` | Hide `wait_agent` |
| `SUBAGENTS_MAX_CONCURRENT=N` | Active child-turn slots (default 4) |
| `SUBAGENTS_MINIMAL_CHILD_TOOLS=1` | Children get base tools only, no extensions |

`model` uses `provider/model-id`. `reasoning_effort` accepts `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, or `max`. Both overrides work with every
`fork_turns` mode. Without an override, the child uses its inherited or default
model configuration.

## Develop

```bash
./node_modules/.bin/tsc --noEmit -p extensions/subagents/tsconfig.json
node --test --experimental-strip-types extensions/subagents/*.test.ts
```

Docs: `docs/PI_API_BINDINGS.md`, `docs/ARCHITECTURE.md`,
`docs/CODEX_PARITY.md`.
