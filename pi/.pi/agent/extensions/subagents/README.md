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

Children run in persistent independent Pi sessions, report back with one bounded
`FINAL_ANSWER`, and never leak transcripts into the parent model context.

## Configure (environment)

| Variable | Effect |
|---|---|
| `SUBAGENTS_DISABLED=1` | Register no tools |
| `SUBAGENTS_DISABLE_WAIT=1` | Hide `wait_agent` |
| `SUBAGENTS_MAX_CONCURRENT=N` | Active child-run slots (default 4) |
| `SUBAGENTS_MAX_AGENTS=N` | Logical child identities (default 6) |
| `SUBAGENTS_MAX_LOADED=N` | Loaded child sessions (default 16) |
| `SUBAGENTS_MAX_DEPTH=N` | Nested agent depth (default 1) |

`model` uses `provider/model-id`. `reasoning_effort` accepts `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, or `max`. Overrides are valid with
`fork_turns=none` or a bounded N; full-history forks inherit the caller's model,
thinking level, and role.

## Develop

```bash
./node_modules/.bin/tsc --noEmit -p extensions/subagents/tsconfig.json
node --test --experimental-strip-types extensions/subagents/*.test.ts
```

Docs: `docs/PI_API_BINDINGS.md`, `docs/ARCHITECTURE.md`,
`docs/CODEX_PARITY.md`.
