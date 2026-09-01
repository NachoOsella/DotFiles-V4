# Minimal Codex V2-style subagents for Pi

## Status — 2026-08-30

Implemented with minimal prompts and low context noise. All V2-style core pieces are in place behind the existing tool names; heavy system prompts and conversation inheritance were intentionally skipped.

Done:

- Adaptive collaboration policy via short tool guideline (only active while `subagent_spawn` exists; 287 chars, no mode toggle).
- Flat hierarchy: leaf workers only (`report_to_parent` question-only, no orchestration tools in children).
- Task metadata: `task_name` and `agent_type` (`default|explorer|worker|reviewer|tester`) with unique active task names, validated and normalized.
- Roles with one-sentence instructions, injected via virtual context file, read-only enforcement for explorer/reviewer/tester, explicit model configuration precedence, and independent reasoning-effort defaults.
- Bounded mailbox with sequenced envelopes (`question|result|error|cancelled`), deduplication, selective drain (`agentIds|sequences|afterSequence`), and interruptible `wait` that also wakes for requested-child questions.
- `subagent_send` (`steer|follow-up`) and `subagent_wait` extended (`ids?`, `timeout_ms?`, `after_sequence?`) without breaking old calls.
- Batched parent delivery: 100 ms window for settlements, immediate `steer` for child questions, strict sequence order across failures, and duplicate suppression between explicit waits and automatic follow-ups.
- Memory budgets (prompt 24 KB, send 8 KB, question 4 KB, result 8 KB, wait 32 KB, check 1 KB, transcript 256 KB, mailbox 128 KB; tails kept, full history stays on disk).
- Backend fix: `ModelRuntime` instead of obsolete `modelRegistry` option, provider registrations copied, `send` steering correctly mapped, and child-only tool wiring.
- `result-delivery.ts` removed; mailbox is the single source for parent-visible results.
- UI shows `taskName` and role; version-based transcript caching.
- Tests: 30 passing (`backend`, `collaboration-policy`, `mailbox`, `manager`, `roles`, `takeover`, `transcript`); `npm run check` and `check:extensions` pass.

Intentionally deferred (per design principles): recursive subagents, `fork_turns` history inheritance, inter-child messaging, progress streaming, user-defined role files, task-graph TUI, and automatic planning.

## Goal

Evolve the existing subagents extension toward Codex V2's task and mailbox model while keeping Pi's implementation smaller and quieter.

The main Pi session decides whether delegation is useful. Small or sequential work stays in the main thread. Larger independent work can be delegated to leaf agents. Subagents never orchestrate other agents.

## Design principles

- Keep one adaptive collaboration policy. Do not add assistant and orchestrator modes.
- Keep the hierarchy flat: main thread to leaf agents.
- Prefer self-contained tasks over inherited conversation history.
- Send the main model only information needed for coordination.
- Keep complete transcripts on disk and bounded previews in memory.
- Batch concurrent completions into one parent message.
- Use explicit roles only when they change child behavior.
- Preserve the existing tool names and accepted arguments where practical.

## Target model

```text
Main Pi session
├── adaptive collaboration policy
├── task registry
├── mailbox
├── spawn / send / wait
└── integration and final response
    ├── explorer
    ├── worker
    ├── reviewer
    └── tester
```

All agents share the same working tree. The main thread owns decomposition, file ownership, integration, validation, and the final response.

## Minimal prompts

### Main collaboration policy

Inject this policy only when `subagent_spawn` is active. Child sessions exclude that tool, so they do not receive the policy.

```text
Delegate only when independent context, specialization, or parallel work is useful. Keep small, sequential, or overlapping work in the main thread. Give each subagent one self-contained task and avoid duplicating its work. Agents share the working tree, so parallel write tasks need separate file ownership. Select models explicitly, verify returned work, and integrate results in the main thread.
```

This is guidance, not a mode. Explicit user instructions about delegation still take priority.

### Child base policy

```text
Complete the assigned task directly. Stay within its scope, do not spawn agents or ask the user, and do not revert unrelated work. Report the result, validation, and blockers concisely.
```

### Role additions

Keep role instructions to one sentence:

```text
explorer: Inspect and report concrete files and execution paths without editing.
worker: Make the smallest complete change and run focused validation.
reviewer: Report only material correctness, security, concurrency, or test findings.
tester: Run requested checks and classify failures without changing application source.
```

Do not add long output templates unless a delegated task requires one.

## Tool interface

### `subagent_spawn`

Keep current arguments and add optional Codex-style metadata:

```ts
{
  prompt: string;
  name: string;
  task_name?: string;
  agent_type?: "default" | "explorer" | "worker" | "reviewer" | "tester";
  working_dir?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
}
```

Rules:

- `task_name` defaults to a normalized `name`.
- Active task names must be unique.
- The spawn result reports id, task name, role, and model.
- The spawn result must not echo the full prompt.
- Prompts have a byte limit before session creation.

### `subagent_send`

Add parent-to-child communication:

```ts
{
  id: string;
  message: string;
  delivery?: "steer" | "follow-up";
}
```

`steer` redirects an active run. `follow-up` waits for the current run to settle. Sending to an idle child starts another turn.

### `subagent_wait`

Extend the existing tool without breaking current calls:

```ts
{
  ids?: string[];
  timeout_ms?: number;
  after_sequence?: number;
}
```

- With `ids`, wait until all listed agents settle or one listed agent asks a question; return still-pending IDs without cancelling them.
- Without `ids`, wait for mailbox activity after `after_sequence`.
- Return compact mailbox events, `next_sequence`, and `timed_out`.
- Do not repeat outputs already consumed by an earlier wait.

### Existing management tools

Keep `subagent_cancel`, `subagent_check`, and `subagent_list` for compatibility. Keep their descriptions and outputs short. They do not need prompt guidelines.

## Roles

Create `src/roles.ts`:

```ts
export interface AgentRole {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly defaultReasoningEffort?: ReasoningEffort;
  /** Controls built-in edit/write tools; shell access remains possible. */
  readonly canUseWriteTools?: boolean;
}
```

Model resolution order:

1. Explicit spawn model.
2. Configured role model.
3. Parent model.
4. The Pi SDK default when no model is supplied.

Reasoning-effort resolution is independent:

1. Explicit spawn reasoning effort.
2. Configured role reasoning effort.
3. The role's reasoning default, when defined.
4. Parent reasoning effort.

Add role instructions through a virtual context file in `DefaultResourceLoader.agentsFilesOverride`. Do not copy them into every user task.

Start with built-in roles in TypeScript. Defer user-defined role files until the core flow is stable.

## Mailbox

Replace implicit deferred result handling with an internal mailbox in `src/mailbox.ts`.

```ts
export type AgentMessageKind =
  | "question"
  | "result"
  | "error"
  | "cancelled";

export interface AgentEnvelope {
  readonly sequence: number;
  readonly agentId: string;
  readonly taskName: string;
  readonly role: string;
  readonly kind: AgentMessageKind;
  readonly text: string;
  readonly createdAt: number;
}
```

The mailbox owns:

- monotonic sequence numbers;
- bounded retention;
- deduplication;
- interruptible waits;
- completion consumption;
- batching before delivery to the parent.

Do not publish token deltas, tool activity, routine progress, or transcript events to the parent mailbox. Those remain available through the TUI and session file.

### Child-to-parent communication

Provide a child-only tool:

```text
report_to_parent(kind: "question", message: string)
```

Initially support questions only. Final results already arrive through run settlement. This avoids progress chatter and unnecessary parent turns.

The tool publishes a mailbox envelope but cannot inspect or control other agents.

## Context policy

Do not implement Codex's `fork_turns` in the first version.

Each child receives:

- normal trusted Pi resources for its cwd;
- its short role policy;
- the self-contained delegated prompt;
- no parent conversation history.

This keeps context use predictable and avoids inherited instructions being mistaken for the child's task. A bounded recent-turn option can be considered later only if self-contained prompts prove insufficient.

## Context and memory budgets

Use byte limits, not character counts.

Suggested initial limits:

| Data | Limit |
|---|---:|
| Spawn prompt | 24 KB |
| Parent-to-child message | 8 KB |
| Child question | 4 KB |
| Automatic final result per agent | 8 KB |
| Combined wait result | 32 KB |
| Check preview | 1 KB |
| In-memory transcript per child | 256 KB |
| Retained mailbox text | 128 KB |

When truncating a final result, include the child session file path. Do not include full prompts or transcripts in routine tool results.

The manager should retain a bounded transcript tail for the TUI. The persisted Pi child session remains the source for complete history.

## Delivery behavior

- Batch mailbox messages that arrive within a short window, such as 100 ms.
- Deliver one compact parent message for a group of settled agents.
- If the parent is busy, queue the batch as a follow-up.
- If an explicit `subagent_wait` consumes a result first, remove it from automatic delivery.
- A child question may trigger a parent turn immediately because it requires coordination.
- Automatic delivery stops at the first failed batch, releases failed and later claims, and retries in sequence order.
- Routine started and progress events must not trigger parent turns.

Example completion batch:

```text
Subagent updates:
- sa-2 auth/explore finished: 3 relevant files found
- sa-3 auth/tests failed: existing integration fixture is missing
```

## Snapshot changes

Extend `SubagentSnapshot` with:

```ts
{
  taskName: string;
  role: string;
  version: number;
  lastMailboxSequence?: number;
}
```

Increment `version` for every visible change. TUI caches should use `id`, `version`, and width rather than content lengths.

Keep statuses minimal:

```ts
"running" | "done" | "error"
```

Do not add extra states unless the UI or tool behavior needs them.

## Backend changes

Update `SubagentSession.send`:

```ts
send(
  text: string,
  delivery: "steer" | "follow-up",
): Effect.Effect<void, SendError>;
```

The Pi backend maps this to `session.steer`, `session.followUp`, or a fresh `session.prompt` when idle.

Use `ModelRuntime` with `createAgentSession`. Resolve how the extension obtains or creates the runtime before adding role-specific model defaults. The backend must not pass obsolete `modelRegistry` options.

Continue excluding orchestration tools from children. Register `report_to_parent` as a child-only custom tool.

## File changes

```text
extensions/subagents/
├── index.ts
├── src/
│   ├── collaboration-policy.ts   new
│   ├── roles.ts                  new
│   ├── mailbox.ts                new
│   ├── domain.ts                 update
│   ├── backend.ts                update
│   ├── manager.ts                update
│   ├── prompt.ts                 update
│   ├── result-delivery.ts        replace after mailbox migration
│   ├── backends/pi.ts            update
│   ├── backends/stub.ts          update
│   └── ui/
│       ├── takeover.ts           update
│       └── transcript.ts         small update
├── collaboration-policy.test.ts  new
├── roles.test.ts                 new
├── mailbox.test.ts               new
├── pi-backend.test.ts            new
└── tool-contract.test.ts         new
```

Keep `index.ts` limited to Pi registration and translation between tools, the manager, and parent messages.

## Implementation phases — all completed 2026-08-30

### Phase 0: stabilize — done

- `ModelRuntime` instead of `modelRegistry` in `createAgentSession`.
- Byte budgets for prompts, sends, questions, results, transcripts, and mailbox.
- Takeover send failures now surface through tools/UI instead of being silently dropped.
- Cancellation during `restarting` immediately visible as `running` and interruptible.
- Snapshot `version` replaces length-based fingerprint; TUI invalidates by version.
- Extension included in `npm run check:extensions`.

### Phase 1: adaptive policy and task metadata — done

- 287-char policy via `SUBAGENT_SPAWN_PROMPT_GUIDELINES` (active only when `subagent_spawn` is registered).
- `task_name` and `agent_type` on `subagent_spawn` with normalized unique names.
- Spawn result no longer echoes the full prompt.

### Phase 2: roles — done

- Built-in roles (`default`, `explorer`, `worker`, `reviewer`, `tester`) with one-sentence instructions.
- Virtual context file injection via `DefaultResourceLoader.agentsFilesOverride`.
- `explicit > role-default > parent` precedence for model/reasoning.
- Read-only roles limited to `read|grep|find|ls` (+ optional `report_to_parent`).

### Phase 3: mailbox — done

- `src/mailbox.ts` with `question|result|error|cancelled`, monotonic sequences, bounded retention, and deduplication.
- Manager owns the mailbox, publishes settlements, and exposes `waitForMailbox`/`drainMailbox`.
- Parent batching: 100 ms window; questions trigger immediate `steer`.
- `subagent_wait` now supports mailbox waits (`ids?`, `timeout_ms?`, `after_sequence?`).

### Phase 4: communication — done

- `subagent_send` (`steer` is default, `follow-up` also supported).
- Child-only `report_to_parent` (question-only, 4 KB bound, writes through `reportToParent` hook into the mailbox).
- Send failures propagate to `subagent_send` and takeover `requestSend`.

### Phase 5: validation and cleanup — done

- `backend.test.ts` covers stub steer/follow-up semantics and orchestration denylist.
- `result-delivery.ts` and its test deleted; mailbox is the delivery mechanism.
- Dashboard and takeover show `taskName` and role; compact listings include both.
- `npm run check`, `check:extensions`, and full `npm test` (30 tests) pass.

## Tests

Required coverage:

- Main policy is present only when orchestration tools are active.
- Child sessions never receive orchestration tools.
- Role instructions are loaded once and stay short.
- Explicit model selection overrides role defaults.
- Task names are unique while tracked.
- Mailbox sequences are ordered and waits do not lose events.
- Mailbox and transcript memory stay within their byte limits.
- Concurrent completions produce one parent batch.
- Explicit waits suppress duplicate automatic delivery.
- Child questions reach the parent and parent replies reach the child.
- Cancel works during spawn, restart, and active execution.
- Runtime disposal closes children and mailbox waiters.
- The real backend passes the current `createAgentSession` contract.
- Existing spawn, wait, cancel, check, and list calls remain valid.

## Deferred work

Do not include these in the first V2-style release:

- recursive subagents;
- full parent conversation inheritance;
- inter-child messaging;
- verbose progress streaming to the parent;
- user-defined role configuration;
- complex task graphs in the TUI;
- automatic planning frameworks.

Add them only if real usage shows a need.

## Completion criteria

The implementation is complete when:

1. The main model delegates selectively without a mode toggle.
2. Children remain leaf workers.
3. Spawned work has task names and optional roles.
4. Parent and child can exchange a bounded question and response.
5. Waiting uses a sequenced mailbox without duplicate results.
6. Routine orchestration adds little context beyond task prompts and compact results.
7. Full transcripts remain recoverable from child session files.
8. Type-checks and all focused tests pass.

## References

- [Codex multi-agent tool definitions](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [Codex V2 spawn handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- [Codex V2 wait handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
- [Codex agent spawn control](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control/spawn.rs)
- [Codex collaboration prompt](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/templates/collab/experimental_prompt.md)
- [Pi SDK documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
