# M2 implementation: bounded execution and operational recovery

M2 starts from the M1 commit (`7c0ff9c`). Every new limit is opt-in. With no
`limits` block, scheduling, admission, ordering, and delivery behave exactly as
in M1; a regression test asserts that path.

## Configuration

```json
{
  "subagents": {
    "limits": {
      "runDeadlineMs": 900000,
      "maxModelRequestsPerRun": 40,
      "maxTreeTokens": 500000,
      "warnAtRatio": 0.8
    }
  }
}
```

- `runDeadlineMs`: wall-clock ceiling for one tracked run. The timer aborts the
  child session at expiry.
- `maxModelRequestsPerRun`: native `turn_start` events allowed in one run.
- `maxTreeTokens`: shared child budget for the whole root tree.
- `warnAtRatio`: fraction of the token budget that marks the warning state.
  Defaults to `0.8` when any limit is configured.

Values are positive safe integers; `warnAtRatio` must be `> 0` and `<= 1`.
`limits: {}` resolves to unlimited, and invalid values fail configuration
validation instead of silently enabling a default cap. There are no environment
variables for these limits.

## Enforcement

`src/core/limits.ts` owns the policy: `resolveLimits`, `describeLimits`,
`TokenBudget`, and the snapshot shape. The coordinator consumes it.

- Deadline: one unref'd timer per active tracked run. It is cleared on settle,
  dispose, delivery detach, and shutdown, and a generation check prevents a stale
  timer from aborting a later run of the same agent.
- Request limit: `turn_start` events are counted for the active tracked run.
  Extension-triggered turns become tracked runs too, so they are counted.
- Token budget: positive deltas from captured usage feed the shared budget.
  Restored records seed the budget without double counting, and repeated capture
  of the same usage adds nothing. `spawn` and `followup_task` call
  `checkAdmission()` before session creation or delivery, so an exhausted budget
  fails before expensive work and before a record is created.
- Termination: a limit abort records
  `limitReached: { kind: 'deadline' | 'requests' | 'tokens', detail }` and
  settles as an error status carrying the typed error message. The parent
  receives a nonempty bounded `FINAL_ANSWER` with recovery guidance.
  `interrupt_agent` stays `Interrupted` and never sets `limitReached`.
- Visibility: `SubagentCoordinator.limits()` returns the snapshot, a
  `LimitsChanged` event fires on every accounting or admission change, the
  dashboard channel carries sanitized limits, and the root prompt gains one
  runtime line with remaining tree tokens. The static configured limits are
  already described once by the shared prompt contract.

## Error codes

Typed errors now expose stable `code`, limit values, and `guidance` text in the
model-visible message:

| Code | Condition |
| --- | --- |
| `agent_capacity_reached` | Active child-run slots are full |
| `budget_exhausted_tokens` | Shared tree token budget refuses admission |
| `deadline_exceeded` | A run exceeded `runDeadlineMs` |
| `request_limit_exceeded` | A run exceeded `maxModelRequestsPerRun` |
| `agent_blocked` | A saved agent cannot be reopened under current state or policy |

No tool input schema changed. The list and wait outputs gained additive optional
fields, documented below.

## Cold reopen

`src/core/session-recovery.ts` validates a saved child before
`SessionManager.open` and after it:

1. The file must sit directly in `<rootSessionDir>/.subagents/<rootSessionId>/`,
   end in `.jsonl`, and carry the record's session id in its basename.
2. Path traversal, unsafe ids, and foreign directories are rejected.
3. Header identity, recorded session id, basename id, persisted
   `subagents-v3-agent-meta` identity (root, agent path, parent path, role), and
   the recorded root session id must agree.
4. A missing role, a removed role, or an unresolvable model raises
   `AgentBlockedError` with guidance. There is no default-role fallback, no
   alternate model, and no replacement session.

A blocked agent keeps its record and remains listed. The error keeps its
`agent_blocked` type and the record carries `blocked: { code, reason }`, which
`list_agents` reports as an additive `blocked_reason`. The block clears on a
successful reopen or when a new run starts, and the record's status is left
unchanged rather than invented.

## List and wait semantics

`list_agents` previously reported one boolean that meant unobserved coordinator
activity. It now distinguishes:

- `has_pending_mail`: an undelivered completion for this agent sits in the
  outbox.
- `has_pending_activity`: unobserved activity since the last `wait_agent`
  (the previous meaning of `has_pending_mail`).

`wait_agent` returns an additive `wake_reason` of `mailbox`, `steer`, or
`timeout` while keeping `message` and `timed_out`. Cancellation still raises.

## Benchmark

`node --experimental-strip-types extensions/subagents/bench/benchmarks.ts`
prints repeatable numbers. Measured on this machine, 20,000-character results:

| Measurement | Result |
| --- | --- |
| One-agent snapshot | 40,671 bytes |
| Six-agent snapshot | 243,611 bytes |
| Twenty-agent snapshot | 811,863 bytes |
| Long result copies per snapshot | 2 (`status.message` and `lastResult`) |
| Usage parse, 2,000 turns | 0.9 ms |
| Spawn (create + bind extensions) | 21.3 ms |
| Cold reopen | 4.6 ms |

Usage parsing is cheap, so incremental usage accounting is not justified.
Snapshot bytes are dominated by repeated result text; a future change should
store the result once and keep delivery checkpoints immediate.

## Honest limits

- The token budget counts child usage observed by the coordinator, not root
  model usage. Root spending is outside the shared budget.
- In-flight work can overshoot `maxTreeTokens`; there is no retrospective
  cancellation and no reservation of exact future tokens.
- Deadline termination depends on the provider honoring Pi's abort signal. A
  provider that ignores it delays settlement.
- A deadline can also fire while a child waits; that is intentional, because the
  limit bounds wall-clock time, not only model requests.
- Waiting still occupies a native run slot. Accounting did not change, because
  releasing and reacquiring a slot at request time would need a host seam.
- Runs started to deliver a pending completion bypass admission by design:
  refusing them would strand finished work. After exhaustion the tree can still
  execute delivery turns, and that is part of the documented overshoot.
- Compaction does not emit `turn_start`, so `maxModelRequestsPerRun` does not
  count it even though compaction consumes tokens and is reflected in the
  budget.
- Reopen containment is lexical. Symlinked session files and case-insensitive
  filesystems are not resolved with `realpath`, and the `stat` to `open` gap is
  a TOCTOU window. This is validation, not an OS sandbox.
- Legacy records without a `sessionId` are validated against their directory and
  header but cannot be matched to a recorded id.
- Persisted role or policy revision history, snapshot migration, and archived
  identities remain M3. M2 validates against current policy instead of storing
  the policy that produced the agent.

## Verification

| Command | Result |
| --- | --- |
| `src/core/limits.test.ts` | 9 pass |
| `src/config/config-limits.test.ts` | 8 pass |
| `src/config/config-prompts.test.ts` | 20 pass |
| `src/core/run-limits.test.ts` | 11 pass |
| `src/core/list-semantics.test.ts` | 4 pass |
| `src/core/session-recovery.test.ts` | 15 pass |
| `npm run test:subagents` | 294 tests: 288 pass, 6 expected host skips |
| `npm run check` and `npm run check:extensions` | Exit 0 with the cached compiler |
| Benchmark | Numbers above |

No live provider was called. Deadline tests use an injected timer seam rather
than sleeping. Snapshot durability under a simulated process crash remains
unverified.

A blocked reopen keeps the record, clears the loading state, and reports the
reason through `list_agents`; the failure surfaces when that agent is used,
never as a silent substitution.
