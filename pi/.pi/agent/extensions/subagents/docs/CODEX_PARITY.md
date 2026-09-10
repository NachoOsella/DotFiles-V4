# Codex parity

Behavioral port of `openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd`
(feature `MultiAgentV2`). Prompts are original behavioral equivalents
until the pinned revision's root `LICENSE`/`NOTICE` is verified — no
upstream source text is copied.

## At parity

- Canonical `/root` paths, narrow `task_name` segments, nested agents.
- Six-tool family (`spawn_agent`, `send_message`, `followup_task`,
  `wait_agent`, `interrupt_agent`, `list_agents`); V1 names
  (`close_agent`, `resume_agent`, `send_input`, `assign_task`) rejected.
- `spawn_agent` returns the task path without waiting for completion.
- `fork_turns` default `all`; `none` fresh; `N` last N turns; `0` and
  malformed values rejected; full-history model inheritance enforced.
- `send_message` queue-only, never starts a turn; `followup_task`
  triggers (`NEW_TASK`), rejects `/root`, restarts terminal agents.
- `wait_agent` synchronizes only: pending/future mail, steering, or
  timeout; clamps below-minimum, rejects above-maximum; never returns
  mailbox content and never consumes it.
- `interrupt_agent` preserves identity for later follow-up.
- `list_agents` reads the logical registry with segment-aware prefix
  filtering and never loads sessions.
- Capacity counts active non-root turns, rejects immediately (no queue),
  releases on success/error/interruption; siblings isolated.
- Terminal results become queue-only `FINAL_ANSWER` to the direct
  parent; errors bounded with recovery guidance; interruptions produce
  no final answer.
- Parent never sees child streams, reasoning, or tool activity — only
  explicit `MESSAGE` and terminal `FINAL_ANSWER` envelopes at the
  `context`-event boundary.
- Children outlive the spawning turn; late completions stay queued.
- Logical identity survives unload/interruption; cold resume restores
  records unloaded with lazy reload on next delivery.
- LRU residency eviction (idle + terminal + mailbox-empty only).

## Known differences

1. **Prompt wording.** Original text preserving every meaning clause
   (`src/prompts.ts`); snapshots in `config-prompts.test.ts`.
2. **Mail transport.** Pi `role: "custom"` context injection instead of
   Codex typed `agent_message`; envelope text identical.
3. **Plaintext payloads.** No Responses-style encrypted tool args;
   payloads live in local session history only.
4. **History fork.** Parent branch text seeded as one baseline prompt;
   no native SDK session fork.
5. **Child model.** Inherits via tool wiring; no model-catalog leaf bit,
   no `Ultra`/proactive inference (explicit-only default).
6. **`ListedAgent` shape.** Minimal stable projection (path, status,
   residency, role, model, parent, pending, running); upstream field
   set was not captured at the pinned SHA.
7. **No `/agent` overlay.** Compact widget + slash-command-friendly
   list output; expanded overlay if Pi gains the primitive.
8. **No encrypted inter-agent payloads, no typed agent_message,
   no model capability metadata** (see `PI_API_BINDINGS.md`).
