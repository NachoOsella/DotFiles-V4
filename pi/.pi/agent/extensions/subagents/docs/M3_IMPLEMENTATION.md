# M3 implementation: versioned features

M3 starts after the M2 commit (`77cf202`). It adds snapshot version 3, task
identity, explicit archival, role context policy, and an evaluation protocol.
The six collaboration tools keep their inputs; outputs gain optional additive
fields. Native queues, defaults, and the depth limit are unchanged.

## Snapshot version 3

The custom entry type stays `subagents-v3-state`. Its payload is now
`version: 3` with an extra `tasks` array and an optional `archivedAt` per agent.

- Version 2 snapshots stay readable. Reading one migrates it in memory with an
  empty task list and no archived agents; the next checkpoint writes version 3.
- Unknown versions are rejected, not guessed.
- Task records are validated on read: unusable ones are dropped, recoverable
  fields are coerced, and duplicate ids are removed.
- Pending completions keep `meta.taskId` and `meta.runSequence`, so restored
  outbox entries keep their correlation.

## Task identity

Each `spawn_agent` and each `followup_task` creates an `AgentTask`:

```text
id, agentPath, objective, kind (spawn|followup), submittedBy,
communicationId, runSequence?, status, createdAt, completedAt?, resultRef?
```

- `objective` is a bounded single-line snippet, never the full payload.
- `runSequence` is attached when a run starts; the task becomes `completed` or
  `failed` with a timestamp and a `resultRef` (the child transcript) when that
  run settles. A limit-terminated run marks its task failed, not active.
- Retained history is capped at the 50 most recent tasks per agent. Active tasks
  are always kept, so a burst of concurrent submissions can exceed the cap.
- A later submission never mutates an older task.
- Completed results carry `taskId` and `runSequence` in their metadata, so a
  parent can attribute a `FINAL_ANSWER` to the submission that produced it.
- `spawn_agent` and `followup_task` return `task_id`. `list_agents` includes a
  bounded `current_task` summary.

This is correlation, not a second scheduler: Pi still owns every queue and run.

## Archival

Archival is an operator action, deliberately not a seventh model tool:

```text
/agents archive /root/reviewer
/agents unarchive /root/reviewer
```

Rules:

- Only terminal, settled agents with no live descendant can be archived;
  `/root` never.
- Archival is refused while the agent still owns, or is named by, an undelivered
  completion, while a run is still settling, while a descendant is live, or
  while an operation holds a runtime lease.
- An archived agent keeps its record, id, usage, task history, and transcript.
  It stops counting against `maxAgents`, disappears from the default listing,
  and rejects message, follow-up, interrupt, and load with `agent_archived`.
- The path is never reused for a different identity.
- Unarchiving restores the same identity, history, and quota slot.

## Role context policy

A role may now choose spawn context:

```json
{
  "roles": {
    "scout": { "context": { "mode": "lastN", "turns": 2 } },
    "reviewer": { "context": { "mode": "none" } }
  }
}
```

Precedence is explicit: an argument to `spawn_agent` wins, then the role policy,
then today's default of a full-history fork. `inherit` means the default. The
resolver is pure and reports which layer decided, so a surprising context choice
is explainable. Invalid policy is rejected during configuration decoding; an
invalid explicit request throws instead of falling back to the role policy.

Role selection happens before the context policy adjusts the fork, so a policy
cannot silently change which role a caller inherits.

## Public additions

| Surface | Addition |
| --- | --- |
| `spawn_agent` output | `task_id` |
| `followup_task` output | `task_id` |
| Completion metadata | `taskId`, `runSequence` |
| `list_agents` input | `include_archived` |
| `list_agents` output | `archived`, `current_task` |
| `/agents` command | `archive`, `unarchive` |
| Role config | `context` |

All new fields are optional, so existing schema validators and callers keep
working.

## Evaluations

`docs/EVALUATIONS.md` separates the deterministic suite from model-level
scenarios. The deterministic layer runs in CI. The model layer is specified with
a fixed protocol and budget but was not executed here; it needs a real provider
and an explicit spend decision.

## Honest limits

- Archival is one-way in practice for identity reuse: an archived path never
  becomes a fresh agent. Unarchive restores the same identity, not a clean one.
- Task records are metadata, not durable work items. They record what was
  submitted and how it ended; they do not survive an interrupted process beyond
  the last checkpoint.
- `resultRef` points at the child transcript. There is no separate artifact
  store, no content-addressed result, and no size guarantee for that file.
- Context policy selects history, not a token budget. A `lastN` fork can still
  be large; compaction summaries are copied as-is.
- `maxTreeTokens` still counts child usage only, and delivery runs still bypass
  admission, as documented in M2.
- The evaluation scenarios are unrun. No quality claim is made.

## Verification

| Command | Result |
| --- | --- |
| `src/persistence/schema-v3.test.ts` | 12 pass |
| `src/core/task-lifecycle.test.ts` + `src/core/archive.test.ts` | 14 pass |
| `src/core/context-policy.test.ts` + `src/config/role-context.test.ts` | 14 pass |
| `npm run test:subagents`, workspace Pi 1.0.0 | 337 tests: 331 pass, 6 expected host skips |
| Supplemental host suite, Pi 1.4.0 | 337 tests: 336 pass, 1 expected skip |
| `npm test`, full workspace | 621 tests: 615 pass, 6 expected skips |
| `npm run check:extensions` | Exit 0 with the cached compiler |
| Benchmark | unchanged: spawn 22.2 ms, cold reopen 4.5 ms |
| M2 snapshots | Read and migrated, no rejection |

No live provider was called. No archive or migration fault injection was done
beyond the tests listed.
