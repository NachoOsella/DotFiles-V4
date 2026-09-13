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
