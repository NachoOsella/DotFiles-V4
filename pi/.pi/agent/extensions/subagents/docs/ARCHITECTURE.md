# Architecture

## Behavioral invariants (code review checklist)

```text
Agent identity != loaded session.
Completed != destroyed.
Interrupted != destroyed.
Parent turn lifetime != child agent lifetime.
send_message != followup_task.
wait_agent != result retrieval.
UI child output != parent model context.
Active execution capacity != logical agent count.
Residency capacity != execution capacity.
No spawn queue.
No V2 close_agent.
No V2 resume_agent.
No automatic child transcript forwarding.
No recursive cancellation when a parent turn merely ends.
All agents share the same working tree.
A terminal child result goes to its direct parent as FINAL_ANSWER.
```

## Layout

```text
extensions/subagents/
  index.ts                 Pi registration only (tools, widget, lifecycle)
  src/
    provenance.ts          Codex SHA + Effect version pin
    ids.ts                 branded AgentId/AgentPath/TurnId/ToolCallId/CommunicationId
    agent-path.ts          canonical /root paths, segments, relative resolution
    agent-status.ts        PendingInit/Running/Interrupted/Completed/Errored/Shutdown/NotFound
    status-reducer.ts      pure event-to-status reducer (+ terminal-error precedence)
    communication.ts       NEW_TASK/MESSAGE/FINAL_ANSWER + fork_turns parser + envelopes
    completion.ts          terminal status -> bounded FINAL_ANSWER payload
    errors.ts              tagged errors (capacity, not-found, overrides, ...)
    events.ts              SubagentEvent (domain plane; UI/model planes separate)
    config.ts              CodexSubagentsConfig decode + wait clamping
    mode.ts                explicit-only / proactive / custom resolution
    prompts.ts             original behavioral-equivalent role prompts + assembler
    tool-specs.ts          six TypeBox schemas + forbidden V1 names
    agent-record.ts        logical record (no live handles)
    host.ts                PiHost semantic interface + fork-history helper
    fake-host.ts           deterministic test double (pause/gate/fail)
    manager.ts             AgentControl: registry + mailbox + capacity + turns
    runtime.ts             async Effect boundary (Cause -> Error)
    extension-tools.ts     six tool adapters (root + child SDK variants)
    host-live.ts           SDK adapter (only file importing Pi session APIs)
    ownership-policy.ts    parent-owned child restrictions
    persistence.ts         CustomEntry snapshot scan
    projection.ts          pure TUI reducer + bounded activity ring
    widget.ts              compact setWidget adapter
```

## Scope hierarchy

```text
Extension instance
  SubagentManager (one per root session)
    /root logical record
    /root/child-a AgentRecord + RuntimeEntry (child scope: session + AbortController)
      active turn promise (background; never awaited by the spawning tool call)
    /root/child-b ...
```

There is intentionally no parent-turn-fiber -> child-fiber link:
`spawn` starts the turn as an unawaited background promise, so parent
cancellation (tool AbortSignal) never propagates to children. Session
shutdown aborts every turn and closes every SDK session.

## Simplifications vs the full plan (documented, not accidental)

- **Plain manager instead of ten Effect services.** Registry, mailbox,
  capacity, runtime store, residency, and communication live in one
  `SubagentManager` class with synchronous atomic sections (JS is
  single-threaded; reserve check+insert has no await between). Effect is
  used at the async boundary (`runtime.ts`) and proven by
  `effect-smoke.test.ts`. The module split above preserves the plan's
  file responsibilities so services can be extracted later without
  changing behavior.
- **Event listeners instead of PubSub.** `manager.onEvent` is a
  synchronous listener set; mailbox state remains authoritative and
  `wait_agent` re-checks after subscribing (lost-wakeup protection).
- **No Schema dependency.** Config uses explicit decoders to avoid
  Effect beta API churn.
- **Child history seeding.** `fork_turns=all/N` copies parent branch
  text into one baseline prompt rather than a native fork primitive
  (Pi SDK exposes no session fork for SDK sessions).
- **Usage reporting.** Child sessions are memory-only, so token usage
  never reaches session files. The manager folds per-session cumulative
  readings into per-agent deltas (`captureUsage` on turn end, eviction,
  and shutdown) and persists totals in the `subagents-v2-state`
  snapshot. session-stats reads that snapshot; in-flight turns are not
  yet reflected.
- **Child tool surface.** Children load the full extension set (fff,
  todowrite, background-terminals, ...) minus the subagents extension
  itself, honoring settings disables. Our own entry is stripped by path
  (`filterSubagentsExtension`) so no second manager boots. The SDK only
  activates the base four plus leaves customs inactive, so host-live
  activates every registered tool (this also enables recursion).
  `SUBAGENTS_MINIMAL_CHILD_TOOLS=1` restores the extension-free child.
