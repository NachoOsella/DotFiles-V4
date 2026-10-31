# A. Codex CLI "Goals": runtime, scheduler, persistence, state machine

- Repository: `https://github.com/openai/codex`, shallow clone at `/tmp/codex-src`.
- Commit: `67f0994b532b8740f14b5b738af7b7b2a915b1d6` (`2026-10-31 00:12:17 +0000`, "Tighten Bazel CI snapshot handling and OTLP test cleanup (#58459)").
- All line numbers below were re-read from that working tree (`cat -n` / `grep -n`). Nothing here comes from documentation. No tests were executed; behavior is read from source plus the test bodies that pin it.
- Companion reports: `B-codex-goal-prompts-tools.md` (verbatim prompt and tool contracts), `D-effect-v4.md`. This report covers runtime, scheduler, persistence, state machine, budgets, errors, concurrency.

## 1. File inventory

Goal implementation is one Rust crate plus a state-store slice, a protocol surface, and host wiring.

| Path | Lines | Purpose | Key symbols (line) |
|---|---|---|---|
| `codex-rs/ext/goal/Cargo.toml` | 31 | Crate `codex-goal-extension`; depends on `codex-core`, `codex-state`, `codex-protocol`, `codex-rollout`, `codex-prompts`, `codex-otel` | `[lib] name = "codex_goal_extension"` (3-4) |
| `codex-rs/ext/goal/src/lib.rs` | 28 | Module list and public exports | `mod runtime` (9), `pub use runtime::GoalRuntimeHandle` (23) |
| `codex-rs/ext/goal/src/spec.rs` | 94 | Responses API tool specs for the three model-facing goal tools | `GET_GOAL_TOOL_NAME` (9), `CREATE_GOAL_TOOL_NAME` (10), `UPDATE_GOAL_TOOL_NAME` (11), `create_update_goal_tool` (60) |
| `codex-rs/ext/goal/src/tool.rs` | 538 | Tool executors `get_goal`/`create_goal`/`update_goal`, budget validation, state/protocol conversion | `GoalToolExecutor` (31), `handle_create` (204), `handle_update` (247), `validate_goal_budget` (427), `protocol_goal_from_state` (492) |
| `codex-rs/ext/goal/src/api.rs` | 377 | `GoalService`: external (user/RPC) set/get/clear, mutation permit window, runtime registry | `GoalService` (88), `set_thread_goal` (147), `clear_thread_goal` (297), `register_runtime` (347) |
| `codex-rs/ext/goal/src/runtime.rs` | 695 | Per-thread runtime: continuation admission, stop reasons, external apply, progress accounting | `GoalRuntimeHandle` (28), `ActiveGoalStopReason` (40), `continue_if_idle` (436), `stop_active_goal_for_turn` (277), `restore_after_resume` (412) |
| `codex-rs/ext/goal/src/accounting.rs` | 691 | In-memory usage baselines, empty-response and exec-failure streaks, permits | `GoalAccountingState` (20), `mark_goal_continuation` (218), `empty_response_goal` (229), `execution_failure_goal` (155), `goal_token_delta_for_usage` (570) |
| `codex-rs/ext/goal/src/extension.rs` | 657 | Host lifecycle wiring (thread/turn/tool/token), tool mounting, budget-limit steering | `on_thread_idle` (180), `on_turn_start` (238), `on_turn_stop` (314), `on_turn_abort` (380), `on_turn_error` (423), `on_tool_finish` (483), `install_with_backend` (613) |
| `codex-rs/ext/goal/src/steering.rs` | 145 | Renders steering fragments injected as internal user context | `continuation_steering_item` (53), `goal_context_input_item` (60), `continuation_prompt` (67), `budget_limit_prompt` (96) |
| `codex-rs/ext/goal/src/events.rs` | 34 | Emits `EventMsg::ThreadGoalUpdated` to the host sink | `GoalEventEmitter::thread_goal_updated` (19) |
| `codex-rs/ext/goal/src/metrics.rs` | 84 | OTel counters/histograms per status | `record_terminal_if_status_changed` (54) |
| `codex-rs/ext/goal/src/analytics.rs` | 77 | `CodexGoalEvent` analytics | `GoalEventAttribution` (10), `track` (51) |
| `codex-rs/ext/goal/templates/goals/continuation.md` | 56 | Continuation prompt; completion audit (35-46), blocked audit (48-54) | n/a |
| `codex-rs/ext/goal/templates/goals/budget_limit.md` | 16 | One-time wrap-up prompt at budget exhaustion | n/a |
| `codex-rs/ext/goal/templates/goals/objective_updated.md` | 16 | Steering prompt when the user edits the objective | n/a |
| `codex-rs/ext/goal/tests/goal_extension_backend.rs` | 2104 | Tool + lifecycle + service integration tests | `GoalExtensionHarness` (1699) |
| `codex-rs/ext/goal/tests/accounting.rs` | 286 | Pure state-machine tests for accounting | module include `#[path = "../src/accounting.rs"]` (3) |
| `codex-rs/ext/goal/tests/steering.rs` | 69 | Prompt rendering tests | (19, 41) |
| `codex-rs/state/src/model/thread_goal.rs` | 117 | Store-layer goal types and status mapping | `ThreadGoalStatus` (12), `as_str` (24), `is_terminal` (39), `ThreadGoal` (60) |
| `codex-rs/state/src/runtime/goals.rs` | 1733 | All goal SQL and transitions | `GoalUpdate` (22), `GoalAccountingMode` (35), `replace_thread_goal_snapshot` (70), `insert_thread_goal` (215), `update_thread_goal` (273), `account_thread_goal_usage` (501) |
| `codex-rs/state/goals_migrations/0001_thread_goals.sql` | 18 | `thread_goals` DDL in the dedicated goals DB | n/a |
| `codex-rs/state/goals_migrations/0002_thread_goal_continuation_deferrals.sql` | 3 | Deferral marker table | n/a |
| `codex-rs/state/src/sqlite.rs` | 1+ | `goals_1.sqlite` file, WAL, synchronous=NORMAL, corruption recovery | `GOALS_DB_FILENAME` (49), `GOALS_DB` (106-114), `open_goals_db` (354) |
| `codex-rs/protocol/src/protocol.rs` | 1+ | Wire/protocol types and the event | `EventMsg::ThreadGoalUpdated` (1609), `ThreadGoalStatus` (4365-4375), `MAX_THREAD_GOAL_OBJECTIVE_CHARS` (4377), `ThreadGoal` (4391-4405), `ThreadGoalUpdatedEvent` (4407-4416) |
| `codex-rs/protocol/src/turn_input.rs` | 1+ | Turn submission contracts used by the scheduler | `TurnStartOptions` (221-240), `StartIfIdleSubmission` (267-277), `NotSubmittedReason` (289-323) |
| `codex-rs/core/src/codex_thread.rs` | 1+ | Idle-start API exposed to extensions | `start_turn_if_idle` (491-517) |
| `codex-rs/core/src/session/turn_input.rs` | 1+ | Admission rules for automatic idle starts | `TurnInputMode::StartIfIdle` (255-273), `start_if_idle` (481-560) |
| `codex-rs/core/src/tasks/lifecycle.rs` | 1+ | Emits `on_thread_idle` | `emit_thread_idle_lifecycle_if_idle` (63-88) |
| `codex-rs/core/src/tasks/mod.rs` | 1+ | Turn completion ordering and idle cause | idle cause (861-872), turn stop (892), idle emit (911-928) |
| `codex-rs/core/src/context/user_goal.rs` | 120 | User-space goal instruction fragment (authorization trail) | `UserGoalUpdate` (18-24), `message_ids` (31-39), `body` (92-119) |
| `codex-rs/core/src/session/retained_context.rs` | 1+ | Persists user goal instruction before state change | `record_user_goal_update` (84-125) |
| `codex-rs/app-server/src/request_processors/thread_goal_processor.rs` | 1+ | `thread/goal/set|get|clear` RPCs, rollout append, notification ordering | (60, 133-252, 254-273, 275-321, 472) |
| `codex-rs/app-server/src/request_processors/thread_fork_goal.rs` | 28 | Copy goal row on fork | `inherit_thread_goal_snapshot` (5-28) |
| `codex-rs/app-server/src/request_processors/thread_processor.rs` | 1+ | Resume emits goal snapshot + idle; fork inherits goal | (4576-4581), (5773-5799) |
| `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` | 1+ | v2 goal RPC/notification types | `ThreadGoalStatus` (820-829), `ThreadGoal` (831-848), `ThreadGoalSetParams` (875-895) |
| `codex-rs/features/src/lib.rs` | 1+ | Feature flag | `Goals` (441), spec `key: "goals"` (2115) |
| `codex-rs/tui/src/goal_display.rs` | 1+ | Status labels and usage summary | `goal_status_label` (33-42) |
| `codex-rs/tui/src/chatwidget/slash_dispatch.rs` | 1+ | `/goal` parsing | (986-1040) |

Install site: the extension is only registered when a state DB exists (`codex-rs/app-server/src/extensions.rs:87-100`), with `enabled = config.features.enabled(Feature::Goals)` and `max_goal_token_budget` from config (95-98). Registration wires six contributor traits (`codex-rs/ext/goal/src/extension.rs:633-638`).

## 2. State machine

### 2.1 What a goal is

Durable row (`codex-rs/state/goals_migrations/0001_thread_goals.sql:1-18`), exactly one row per thread (`thread_id TEXT PRIMARY KEY`). Columns, formatting collapsed from the DDL but names and constraints verbatim:

```sql
thread_id, goal_id TEXT NOT NULL, objective TEXT NOT NULL,
status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete')),
token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0,
time_used_seconds INTEGER NOT NULL DEFAULT 0, created_at_ms, updated_at_ms
```

Store struct `codex-rs/state/src/model/thread_goal.rs:60-71` carries `goal_id: String`; the wire struct `codex-rs/protocol/src/protocol.rs:4391-4405` does not (it exposes thread id, objective, status, token_budget, tokens_used, time_used_seconds, created_at, updated_at, timestamps in epoch seconds). `goal_id` is the optimistic-concurrency version used by every write.

Status values: `Active, Paused, Blocked, UsageLimited, BudgetLimited, Complete` (`codex-rs/protocol/src/protocol.rs:4365-4375`; storage twin snake_case at `codex-rs/state/src/model/thread_goal.rs:12-21`). Wire serde is camelCase (`protocol.rs:4366`), so JSON is `active, paused, blocked, usageLimited, budgetLimited, complete`; SQLite text is `active, paused, blocked, usage_limited, budget_limited, complete` (`thread_goal.rs:24-33`).

`ThreadGoalStatus::is_terminal` returns true only for `BudgetLimited | Complete` (`thread_goal.rs:39-41`), but that helper has no production callers; the runtime's real gate is "status == Active" (section 3).

### 2.2 In-memory state (not persisted)

`GoalAccountingState` (`codex-rs/ext/goal/src/accounting.rs:19-41`) holds `current_turn_id`, `interrupted_turn_id`, a per-turn map, wall-clock baseline, `consecutive_execution_failure_turns: u8`, `automatic_goal_turn_id`, `consecutive_empty_turns: u8`, and descendant token counters. Per turn (`:43-53`): token baselines, `active_goal_id`, `account_tokens`, `failed_execution`, `successful_tool`, `empty_final`, `has_activity`. None of this is written to disk; a restart resets all streaks (section 4.4).

### 2.3 Transitions

Every legal write path and its trigger:

| From | To | Trigger | Evidence |
|---|---|---|---|
| none | `active` | `create_goal` tool inserts (`INSERT ... ON CONFLICT DO UPDATE ... WHERE thread_goals.status = 'complete'`) | `state/src/runtime/goals.rs:215-271`; conflict guard at `:247` |
| none | requested status (default `active`), or `budget_limited` if the new budget is already met | create with no existing goal: `replace_thread_goal` upsert (new `goal_id`), resets usage to 0 | `goals.rs:158-213`; call site `ext/goal/src/api.rs:236-249` |
| `active` | `budget_limited` | accounting when `tokens_used + delta >= token_budget` and mode filter allows | `goals.rs:534-572` |
| `paused` | `budget_limited` | accounting with `ActiveOrStopped` only (used when the tool stops the goal) | `goals.rs:518-533`; `ext/goal/src/tool.rs:262-271` |
| `active` | `paused` | model `update_goal` with `paused`, or user/RPC set | `ext/goal/src/tool.rs:252-260`; `ext/goal/src/api.rs:212-280` |
| `active` | `blocked` | model `update_goal`, turn error, 3 consecutive empty automatic turns, 3 consecutive failed-`exec` turns | `tool.rs:252-260`; `ext/goal/src/runtime.rs:315-342`; `accounting.rs:155-173,229-246` |
| `active`, `budget_limited` | `usage_limited` | provider usage limit on the turn (`CodexErrorInfo::UsageLimitExceeded`) | `ext/goal/src/runtime.rs:319-323,368-370`; `extension.rs:429-436` |
| `active` | `complete` | model `update_goal` | `tool.rs:252-260,279-299` |
| `blocked`/`paused`/`usage_limited`/`complete`/`budget_limited` | any requested status | external set (`thread/goal/set`), with coercions below | `ext/goal/src/api.rs:212-280` |
| any | row deleted | `thread/goal/clear`, thread deletion | `api.rs:297-345`; `state/src/runtime/threads.rs:1208` |

Coercions and refusals inside the single UPDATE for the `(status, no budget)` shape (`state/src/runtime/goals.rs:329-334`), binds at `:340-346`:

```sql
status = CASE
    WHEN status = ? AND ? IN (?, ?) THEN status
    WHEN ? = 'active' AND token_budget IS NOT NULL AND tokens_used >= token_budget THEN ?
    ELSE ?
END,
```

The binds are `budget_limited`, requested status, `paused`, `blocked`, requested status, `budget_limited`, requested status (`goals.rs:340-346`); the `(status, budget)` shape carries the same guard with `tokens_used >= <new budget>` (`:287-318`).

Consequences: `budget_limited` can never be downgraded to paused/blocked; reactivating an over-budget goal stays `budget_limited`; `complete` is reachable from `budget_limited` (no guard). Insert/replace apply the same rule with `tokens_used = 0` (`goals.rs:623-635`). Tests pin these: `state/src/runtime/goals.rs:1343`, `:1390`, `:1441`, `:1488`.

Unused helpers: `pause_active_thread_goal` and `usage_limit_active_thread_goal` (`goals.rs:422-436`) have no call sites outside that file (verified by `grep -rn` over `codex-rs`); the runtime writes status directly through `update_thread_goal` (`ext/goal/src/runtime.rs:376-390`).

### 2.4 Who may set what

- The model can only set `complete | blocked | paused` (`ext/goal/src/tool.rs:252-260`, error text at `:256-259`). Resume, `budget_limited`, and `usage_limited` are "controlled by the user or system" (`spec.rs:82`).
- The RPC layer accepts all six statuses with no whitelist (`app-server/src/request_processors/thread_goal_processor.rs:156-160`).
- `create_goal` is refused while an unfinished goal exists; only `complete` can be replaced (`goals.rs:247`; test `ext/goal/tests/goal_extension_backend.rs:205-259`).
- Validation: objective 1..=4000 chars (`protocol/src/protocol.rs:4377-4389`), budget > 0 and <= configured max (`ext/goal/src/tool.rs:427-445`).

### 2.5 Blocked is a prompt-level policy plus a code-level breaker

The "three consecutive goal turns" blocked audit is instructed text (`templates/goals/continuation.md:48-54`), and the code enforces two independent automatic breakers (section 3.6). `paused` is only legitimate on explicit user request (`spec.rs:74-76`).

## 3. Scheduler and automatic continuation

### 3.1 The hook

The only continuation trigger is the thread-idle lifecycle. `GoalExtension` implements `ThreadLifecycleContributor::on_thread_idle` (`ext/goal/src/extension.rs:180-203`):

```rust
            if let Err(err) = runtime.continue_if_idle().await {
                tracing::warn!(
```
(lines 196-198; the `Warn` body follows)

Core calls it from `emit_thread_idle_lifecycle_if_idle` (`codex-rs/core/src/tasks/lifecycle.rs:63-88`), which returns early when (a) an active turn exists, or (b) trigger-turn mailbox input is pending:

```rust
        let active_turn = self.active_turn.lock().await;
        if active_turn.is_some() {
            return;
        }
```

```rust
        if self.input_queue.has_trigger_turn_mailbox_items().await {
            return;
        }
```
(quotes are `lifecycle.rs:65-68` and `:75-77`, with the intervening cause adjustment elided)

It is emitted only after the active turn is cleared and the terminal turn event sent (`core/src/tasks/mod.rs:892` turn stop, `:911-928` idle emit). The idle cause is computed at `:861-872` (`Interrupted` for interrupt/budget aborts, `Failed` when a terminal error exists, else `Completed`). Extension-side aborts also emit idle (`core/src/session/extension_interruption.rs:113-121`). The app server emits idle explicitly after a live resume (`app-server/src/request_processors/thread_processor.rs:4576-4581`) and after a running-thread resume (`thread_lifecycle.rs:1257-1264`).

### 3.2 The gate chain in `continue_if_idle`

`ext/goal/src/runtime.rs:436-535`, in order:

1. `if !self.tools_available() { clear_active_goal(); return }` (437-440). Tools are unavailable for ephemeral threads (`extension.rs:110-111`, `persistent_thread_state_available && tools_visible_for_thread`).
2. Take the per-thread goal-state permit (`:443`).
3. Skip if a continuation deferral row exists (`:445-454`, SQL `has_thread_goal_continuation_deferral`, `goals.rs:127-144`).
4. Require an upgradeable `ThreadManager` and live thread (`:456-463`).
5. Read the goal; clear and return when absent (`:465-475`) or when `goal.status != Active` (`:476-479`).
6. Build the payload and admit it (`:480-516`).

### 3.3 Continuation payload

Payload is a hidden user-role fragment, not a user message. `continuation_steering_item` wraps the rendered template in `InternalModelContextFragment` with source `"goal"` (`ext/goal/src/steering.rs:53-65`), rendered from `templates/goals/continuation.md` with `objective`, `tokens_used`, `token_budget`, `remaining_tokens` (`steering.rs:67-94`); `remaining_tokens` is clamped with `.max(0)` (`:74-77`), and the objective is XML-escaped (`:140-145`). Template selection switches on `update_plan_enabled` (`:79-83`).

Admission (`ext/goal/src/runtime.rs:485-499`, exact excerpt):

```rust
        let item = continuation_steering_item(
            &protocol_goal_from_state(goal),
            thread.config().await.update_plan_enabled,
        );

        match thread
            .start_turn_if_idle(
                TurnInputRequest::new(TurnInput::ResponseItem(item)).on_start(TurnStartOptions {
                    turn_trigger: Some("goal".to_string()),
                    ..start_options
                }),
            )
            .await
        {
            Ok(StartIfIdleSubmission::Started { turn_id, .. }) => {
```

`start_options` are inherited from `thread.thread_extension_data().get::<TurnStartOptions>()` (`:480-484`), which carries lineage: `parent_turn_id` is set to the finished goal turn at turn stop (`extension.rs:362-375`), and after a successful `create_goal` call `root_turn_id = thread.active_turn_root(turn_id)` plus `parent_turn_id = tool turn` (`extension.rs:496-511`).

### 3.4 Admission rules (`start_turn_if_idle`)

`CodexThread::start_turn_if_idle` uses `TurnInputMode::StartIfIdle` (`core/src/codex_thread.rs:491-517`), which classifies a `ResponseItem` as `TurnStartKind::Automatic` (`core/src/session/turn_input.rs:255-273`) and then (`:501-560`):

- `PendingTriggerTurn` if trigger-mailbox items exist (`:501-505`, re-checked at `:555-560`).
- `PlanMode` for automatic input when the thread would run in Plan mode (`:508-514`).
- `ServerDraining` when extension turn-start admission is closed (`:516-535`).
- `NotIdle` if an active turn already exists, under the `active_turn` mutex (`:537-543`).
- `Superseded` only for `ContinueIfIdle` with an expected previous turn id (`:544-550`).

The goal extension treats every rejection as a silent skip (debug log) and does not retry in that boundary (`ext/goal/src/runtime.rs:504-509`). All variants are defined at `protocol/src/turn_input.rs:289-323`.

### 3.5 How many continuations, and duplicate prevention

- One continuation per idle boundary. `on_thread_idle` is emitted once per cleared turn (`core/src/tasks/mod.rs:911-928`), and the moment a continuation is admitted the active turn exists again, so any concurrent idle emission returns at `lifecycle.rs:65-70`.
- Cross-task serialization: `goal_state_lock: Semaphore::new(1)` per runtime (`ext/goal/src/runtime.rs:59,113`), acquired for the whole read/start window (`:443`), with the comment "Hold this through the read/start window so external set/clear cannot change the goal after we read it but before the continuation launches" (`:441-442`).
- Atomic admission in core under the `active_turn` mutex (`core/src/session/turn_input.rs:537-543`).
- The clamp that lets the runtime recognize its own automatic turn: `mark_goal_continuation(turn_id)` is called only after `Started` (`runtime.rs:499-503`); the comment at `:500-501` notes turn-stop evaluation takes the same permit.
- There is no continuation counter and no per-goal turn cap anywhere in the crate (`grep` for counters finds only the empty/exec streaks in `accounting.rs`).

### 3.6 No-progress logic

Two code-level breakers, both requiring the turn to belong to the active goal:

1. Consecutive empty automatic turns. Evaluated at turn stop and at idle after an interrupt (`extension.rs:187-195,339-346`). Condition (`accounting.rs:229-246`):

```rust
let empty = automatic && !turn.has_activity && (turn.empty_final || interrupted);
...
inner.consecutive_empty_turns = inner.consecutive_empty_turns.saturating_add(1);
(inner.consecutive_empty_turns >= 3).then_some(goal_id)
```
(first and last three lines of `accounting.rs:238-245`, with the `!empty` early return elided)

`automatic` means the turn id equals `automatic_goal_turn_id`, set only by host-admitted continuations (`accounting.rs:218-220`) and cleared by `reset_empty_responses` (`:222-226`). `empty_final` is an empty agent message whose phase is `FinalAnswer` or `None` (`:180-188`); any other `TurnItem` variant sets `has_activity` (`:189-212`). Threshold is exactly 3.

2. Consecutive failed `exec` turns without a successful tool. `record_tool_outcome` marks `failed_execution` only for `ToolCallOutcome::Failed { handler_executed: true }` on the default-namespace `exec` tool, and any successful tool clears the streak (`accounting.rs:137-152`); `execution_failure_goal` returns the goal at `>= 3` (`:155-173`). `Completed { success: false }`, `Blocked`, `Aborted`, and `Failed { handler_executed: false }` do not count (test `tests/accounting.rs:171-190`).

Prompt-level guidance also exists: the continuation prompt asks the model to classify the previous turn as progress / verified wait / no progress (`templates/goals/continuation.md:22-25`), but no code consumes that classification.

### 3.7 What stops the loop

Absent an explicit stop, the loop is unbounded. It stops when:

- status becomes anything other than `active` (`runtime.rs:476-479`): `paused`, `blocked`, `usage_limited`, `budget_limited`, `complete`;
- the goal row is deleted (`runtime.rs:472-475`);
- a deferral row exists (`runtime.rs:445-454`), which is how forks avoid auto-starting;
- goal tools are unavailable, e.g. ephemeral thread (`runtime.rs:437-440`);
- no live thread or thread manager is available (`runtime.rs:456-463`);
- admission rejects the turn: `NotIdle`, `PlanMode`, `PendingTriggerTurn`, `ServerDraining` (`core/src/session/turn_input.rs:501-543`).

After a rejected or skipped continuation, if no goal-active turn is current the runtime resets the idle baseline and clears the active goal id (`runtime.rs:518-533`).

## 4. Persistence

### 4.1 Database

Goal state lives in its own SQLite file, not the main state DB and not the rollout: `GOALS_DB_FILENAME = "goals_1.sqlite"` (`state/src/sqlite.rs:49`), spec `GOALS_DB { label: "goals DB", kind: DbKind::Goals, recovery: RecoveryMode::BackupAndRebuild }` (`sqlite.rs:106-114`). It is opened at startup (`state/src/runtime.rs:173-183`) and bound as `GoalStore::new(Arc::clone(&goals_pool))` (`runtime.rs:269`), exposed as `StateRuntime::thread_goals()` (`runtime.rs:299-301`). Schema is a separate migrator embedded from `state/goals_migrations` (`state/src/migrations.rs:9,40-42`). The old main-DB table was dropped (`state/migrations/0034_drop_thread_goals.sql:1`); every goal query in the tree goes through `StateRuntime::thread_goals()`, which is bound to the goals pool (`state/src/runtime.rs:269,299-301`), so the state-DB copy is unreachable.

Two tables: `thread_goals` (one row per thread, primary key `thread_id`, 18 lines) and `thread_goal_continuation_deferrals (thread_id PRIMARY KEY REFERENCES thread_goals(thread_id) ON DELETE CASCADE)` (`goals_migrations/0002:1-3`). No version column; `goal_id` is a UUID regenerated on each create/replace (`goals.rs:165`) and used as the compare-and-swap token (`WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)`, `goals.rs:301-302`).

### 4.2 Write path and durability

Every goal write is a single statement with `RETURNING`, executed through `fetch_one_write`/`fetch_optional_write`, which open `BEGIN IMMEDIATE`, decode, then `COMMIT` (`state/src/sqlite/busy_retry.rs:79-110`). Standalone updates use `execute_with_busy_retry` with the same bound inputs (`busy_retry.rs:52-77`). The one multi-statement transaction is the fork snapshot, which upserts the row and inserts the deferral marker under one `begin_immediate` and commits once (`goals.rs:70-125`).

DB settings: `synchronous(SqliteSynchronous::Normal)`, `busy_timeout(DEFAULT_BUSY_TIMEOUT)`, WAL journal (`sqlite.rs:469-482`). `synchronous` is `NORMAL`, not `FULL`, and there is no explicit `fsync`; durability against power loss is therefore weaker than a fully synced commit. Writes are not wrapped in a goal-level transaction beyond what is listed; a status change plus its event emission is not atomic (event emission happens after the DB write, `runtime.rs:602-608`).

Snapshot write moments: on turn stop (`extension.rs:347-361`), on turn abort (`:395-407`), on tool finish (`:521-538`), on external mutation (`runtime.rs:164-189`), on explicit RPC set/clear (`api.rs:147-294,297-345`). Token counters are only written as deltas, guarded by `expected_goal_id`.

### 4.3 Rollout copy (secondary)

Explicit user/RPC mutations append `RolloutItem::EventMsg(EventMsg::ThreadGoalUpdated)` to the live thread's rollout after the DB write (`app-server/src/request_processors/thread_goal_processor.rs:225`; item construction `ext/goal/src/api.rs:67-74`). `ThreadGoalUpdated` is on the persisted-event allowlist (`rollout/src/policy.rs:128-140`). Runtime accounting events from the extension are not appended there; they go through the extension event sink (`ext/goal/src/events.rs:19-33`) and become client notifications.

The rollout copy is not a restore source. It only feeds thread previews (`state/src/extract.rs:163-168`; `thread-store/src/thread_metadata_sync.rs:322-330`) and is inert for model context (`core/src/session/turn.rs:2260,2337`). All reads (`thread/goal/get`, tools, resume, fork) hit SQLite (`ext/goal/src/tool.rs:192-200`; `api.rs:131-142`; `runtime.rs:412-423`).

### 4.4 Restore

`restore_after_resume` reads the row and, if `status == Active`, re-arms in-memory idle accounting (`mark_idle_goal_active`, `record_resumed`), otherwise clears the active goal id (`runtime.rs:412-434`). It performs no DB write and does not start a turn. The continuation, if any, comes from the idle hook the host emits right after resume (`app-server/src/request_processors/thread_processor.rs:4576-4581`, `thread_lifecycle.rs:1257-1264`). In-memory streaks and token baselines are lost on restart, so the empty/failure counters restart at zero.

### 4.5 Fork

Fork copies the goal only when `defer_goal_continuation && rollout_path.is_some() && goals_enabled` (`app-server/src/request_processors/thread_processor.rs:5773-5775`). Before copying, the source thread's in-flight accounting is flushed under the goal-state permit (`ext/goal/src/api.rs:113-129` -> `runtime.rs:164-189`). Then the row is re-keyed to the target thread and upserted unchanged, including `goal_id`, `status`, `tokens_used`, `time_used_seconds`, `created_at` (`app-server/src/request_processors/thread_fork_goal.rs:10-27`), and the same transaction inserts a deferral row (`goals.rs:111-120`). The deferral blocks continuation (`runtime.rs:445-454`) until the first turn start of the fork clears it (`extension.rs:256-263`). Test: `app-server/tests/suite/v2/thread_fork.rs:928` (row equality 1048-1056, marker present 1057-1062, no turn/model call while forking 1073-1089, no turn after app-server restart 1110-1115, marker consumed by the first explicit turn 1129-1135, then `BudgetLimited` with 157 tokens 1152-1160).

### 4.6 Compaction

Compaction never touches goal state; `core/src` has no `thread_goals` access. What is preserved is the user authorization trail: compaction snapshots ids of `user.goal` items before summarizing (`core/src/compact.rs:74,277,430`) and re-appends goal edits accepted after the snapshot (`core/src/session/mod.rs:4598-4618`); new context windows do the same (`session/mod.rs:5129,5166-5167`). Those items are `user.goal` / `user.goal.omitted`, objective JSON capped at 700 bytes and omitted whole when larger (`core/src/context/user_goal.rs:14,26-28,63-77,92-119`). The goal *state* re-enters the model only through the next continuation's steering item, which is rebuilt from the SQLite row every turn (`runtime.rs:485-488`).

### 4.7 Corruption

Startup runs a bounded `quick_check`; on `CorruptedNeedsFixed` with `RecoveryMode::BackupAndRebuild` the pool is closed, the corrupt file is backed up, and the DB is rebuilt fresh (`state/src/sqlite.rs:490-520`). For goals that means: corruption recovery silently discards all goals, there is no restore from rollout.

## 5. Budgets

### 5.1 What is counted

Tokens: `goal_token_delta_for_usage = input_tokens - cached_input_tokens + output_tokens` (`ext/goal/src/accounting.rs:570-575`). Cached input is excluded; `reasoning_output_tokens` is never added on its own, the formula reads only those three fields (`:551-575`). Wall clock: elapsed seconds since the last accounted instant, only while the goal is the runtime's active goal (`accounting.rs:635-674`, `:417-422`).

There is no turn-count budget, no time budget, and no per-continuation cap; `time_used_seconds` is recorded and reported but never compared to a limit (`grep` for `time_used_seconds` shows only accumulation, metrics, prompts).

Descendants: subagent token usage rolls up into the root thread's goal through `root_accounting_state.record_descendant_token_usage(&token_usage.last_token_usage)` (`extension.rs:469-471`), with the root state resolved from the parent thread id (`extension.rs:119-142`). Tests: `ext/goal/tests/goal_extension_backend.rs:448`, `:511`, `:551`.

### 5.2 Where it is accounted

All accounting goes through `GoalStore::account_thread_goal_usage(thread_id, time_delta_seconds, token_delta, mode, expected_goal_id)` (`state/src/runtime/goals.rs:501-616`):

| Call site | Mode | Event id |
|---|---|---|
| tool finish (`extension.rs:521-538`) | `ActiveOnly`, `KeepActive` | tool `call_id` |
| turn stop (`extension.rs:347-361`) | `ActiveOnly`, `ClearActive` | `{turn}:turn-stop` |
| turn abort (`extension.rs:395-407`) | `ActiveOnly`, `ClearActive` | `{turn}:turn-abort` |
| turn error / usage limit (`runtime.rs:343-349`) | `ActiveOnly`, `ClearActive` | `{turn}:{reason}-progress` |
| external mutation (`runtime.rs:164-189`) | `ActiveOnly`, `ClearActive` | `{turn}:external-goal-mutation` or `{thread}:external-goal-mutation` |
| `update_goal` (`tool.rs:262-275`) | `ActiveOrComplete` for complete, `ActiveOrStopped` otherwise | tool `call_id` |

Only positive deltas are used (`accounting.rs:282-303`; `goals.rs:509-515`), so deltas are monotone per turn and cannot double-count within a turn. Concurrency is serialized by `progress_accounting_lock` (`accounting.rs:248-257`) plus the DB write; the parallel-tool test pins that two simultaneous tool finishes charge once (`tests/goal_extension_backend.rs:385-446`).

### 5.3 Exhaustion

The transition happens inside the accounting UPDATE, assembled by the query builder (`goals.rs:548-572`). The emitted SQL is:

```sql
, status = CASE
WHEN <budget_limit_status_filter>
AND token_budget IS NOT NULL
AND tokens_used + ?
>= token_budget
THEN ?
ELSE status
END,
```

with `?` bound to `token_delta` and then to `'budget_limited'` (`goals.rs:561,568`); `<budget_limit_status_filter>` is a Rust `&str` pushed at `:554`.

`budget_limit_status_filter` is `status = 'active'` for `ActiveStatusOnly`/`ActiveOnly`/`ActiveOrComplete` and `status IN ('active','paused','blocked','usage_limited','budget_limited')` for `ActiveOrStopped` (`goals.rs:528-533`), so `paused -> budget_limited` is only possible on the final accounting performed by `update_goal`.

At exhaustion:

- The in-flight turn is not aborted. `TurnAbortReason::BudgetLimited` exists (`protocol/src/protocol.rs:4553-4558`) but nothing in this tree raises it (only consumers: `core/src/tasks/mod.rs:618,863,944`, `core/src/agent/status.rs:15`).
- Wrap-up: the turn is never cut short. When the limit is crossed by a tool-finish accounting pass, the runtime injects the budget-limit prompt into that turn exactly once per goal (`extension.rs:539-551`; dedupe `accounting.rs:526-533`; prompt `templates/goals/budget_limit.md:14-16`: "do not start new substantive work ... Wrap up this turn soon"). If the limit is crossed only at turn-stop accounting, no wrap-up prompt is injected because the turn is already over.
- Accounting keeps charging the same turn after the limit: `ActiveOnly` includes `budget_limited` (`goals.rs:522`), pinned by `tests/goal_extension_backend.rs:628-702` (`tokens_used` 25 at crossing, 35 at turn stop) and `:704-760`.
- No new continuation starts, because `continue_if_idle` requires `Active` (`runtime.rs:476-479`).
- The goal cannot return to `active` while over budget: external set is coerced back (`goals.rs:321-336`; test `:1390`), `update_goal` cannot request it (`tool.rs:252-260`).
- `update_goal complete` is still accepted and finalizes usage (`tool.rs:262-275` `ActiveOrComplete`; test `tests/goal_extension_backend.rs:1088` case 3).

### 5.4 Budget configuration

`max_goal_token_budget` is config (`core/src/config/mod.rs:993`), parsed from `[goals] max_goal_token_budget` as `NonZeroU64` (`config/src/config_toml.rs:761`), and used as both a cap and a default (`api.rs:165-170`; `tool.rs:212-214`). Per-goal budgets default to `None` (unbounded) unless requested.

## 6. Interruptions, errors, blocked state

- User interrupt: abort reason `Interrupted` routes to `accounting.interrupt_turn(turn_id)`, which moves the turn id to `interrupted_turn_id` instead of evaluating immediately ("Abort can run on the submission loop: defer evaluation until idle", `accounting.rs:478-488`). Progress is still accounted (`extension.rs:395-407`), `TurnStartOptions` are dropped (`:391`), and the empty-response counter is not reset for `Interrupted` (`:392-394`). At the following idle, the deferred turn is evaluated as an empty response and then finished (`extension.rs:187-195`), and `continue_if_idle` runs. Net effect: a single interrupt of a productive continuation does not stop the goal; it restarts it. Repeated interrupts of activity-free automatic turns reach the 3-strike breaker and set `Blocked` (test `app-server/tests/suite/v2/thread_goal_empty_responses.rs:36`, "interrupt" case).
- Other abort reasons (`Replaced`, `ReviewEnded`, `BudgetLimited`) call `finish_turn` and reset the empty streak (`extension.rs:392-394,414-418`).
- Turn error: `CodexErrorInfo::UsageLimitExceeded` maps to `usage_limited`; every other error maps to `blocked` (`extension.rs:429-436`). The comment states the intent: "The turn has ended because the error was non-retryable or its retries were exhausted. Block the goal to prevent automatic continuation from looping and consuming tokens, as can happen with compaction errors" (`:431-434`). So transient provider errors that survive the model client's own retries do not reschedule a continuation; the goal blocks.
- Rate limits are the `usage_limited` path; `can_stop` allows it from `active` or `budget_limited`, then the status is written with `update_thread_goal` (`runtime.rs:368-370,376-390`). It is resumable by the user.
- Tool errors: only failed `exec` executions count toward the exec breaker; script errors and pre-handler failures do not (`accounting.rs:137-152`; test `tests/accounting.rs:171-190`). Successful tool output resets the exec streak even inside an interrupted turn (test `tests/accounting.rs:192-229`).
- Stale-turn protection: `stop_active_goal_for_turn` returns early unless the accounting turn matches the current/interrupted turn and its active goal id matches the expected id (`runtime.rs:302-313,362-367`). Tests: `tests/goal_extension_backend.rs:1051` (stale usage limit), `:1014` (Plan-mode turn cannot stop the goal).
- Empty responses: see 3.6. A user (non-automatic) turn never counts (`accounting.rs:235-243`), which is why the "user" case needs 6 turns in `tests/accounting.rs:63-134`.
- Blocked recovery: user resume via `thread/goal/set status=active` (`api.rs:212-250`) which also steers the live turn if the objective changed (`runtime.rs:237-241`). The "fresh blocked audit" rule is prompt-only (`templates/goals/continuation.md:51`).
- Terminal error on resume: `restore_after_resume` never resurrects non-active goals (`runtime.rs:424-432`), pinned by `app-server/tests/suite/v2/thread_resume.rs:3288` (paused goal stays paused, no `turn/started` after resume).
- Conflicting work: admission refuses with `PendingTriggerTurn` when trigger-mailbox input exists (`core/src/session/turn_input.rs:501-505`), so queued user work wins over a goal continuation.

## 7. Concurrency and single-flight guards

Per-thread runtime (`ext/goal/src/runtime.rs:47-60`):

- `goal_state_lock: Semaphore::new(1)` serializes "read goal + start continuation" against external set/clear and against accounting-plus-status writes. Held at: `continue_if_idle` (443), `stop_active_goal_for_turn` (288), `GoalService::set_thread_goal` (183-191), `clear_thread_goal` (306-314), `flush_thread_goal_progress_for_fork` (121-124), post-`create_goal` lineage (extension.rs:501).
- `progress_accounting_permit` (`accounting.rs:253-257`) serializes snapshot -> DB write -> mark-accounted, so one token delta is charged once.
- `turn_start_lock` (`accounting.rs:259-263`) serializes turn-start accounting with stopping a deferred interrupted turn; the comment forbids holding it while submitting a turn or awaiting the goal-state permit (`accounting.rs:23-25`).
- Lock ordering observed: goal-state permit outer, then accounting permit (runtime.rs:288 -> 559 via stop/account), and turn-start permit only in the empty-response path when the turn was interrupted (`runtime.rs:290-301`).

Runtime registry: `GoalService` holds `Mutex<HashMap<String, Weak<GoalRuntimeHandle>>>` (`api.rs:88-90`), registers on thread start (`extension.rs:161`), unregisters on stop (`:207-209`) with `Weak::ptr_eq` identity check (`api.rs:352-362`), and prunes dead entries on lookup (`:364-372`). Runtime creation is single-flight through `ExtensionData::get_or_init` (`extension.rs:143-159`).

DB level: one row per thread, single-statement compare-and-swap on `goal_id` (`goals.rs:301-302,585-587`), `INSERT ... WHERE thread_goals.status = 'complete'` for create (`:247`), `BEGIN IMMEDIATE` + `busy_timeout` retry for writes (`busy_retry.rs:33-39,52-77`), so two writers cannot interleave read-modify-write of the same row. `account_thread_goal_usage` is an atomic `UPDATE ... SET x = x + delta`, which is why concurrent accounting adds rather than overwrites (test `state/src/runtime/goals.rs:1660-1701`).

Extension-level: `tool_attempt_counts_for_goal_progress` excludes `update_goal` calls so a status change does not double-charge (`extension.rs:513-519,645-657`); `mark_budget_limit_reported_if_new` makes the wrap-up prompt once per goal (`accounting.rs:526-533`).

Known gap: the empty/exec streak counters and the budget-prompt flag are in-memory only; a process restart loses them while the DB keeps the status.

## 8. Tests that pin behavior

Crate `codex-rs/ext/goal/tests`:

- `goal_accounting_uses_turn_start_baseline_for_exact_deltas` (`accounting.rs:20`): delta is exactly 28 for the fixture, proving per-turn baseline subtraction.
- `goal_accounting_ignores_plan_mode_turns` (`:47`): `record_token_usage` returns `None` in Plan mode.
- `empty_continuations_require_three_turns_without_activity_or_goal_changes` (`:63-134`): asserts `empty_response_goal` returns `Some` exactly on the blocking turn for 11 scenarios; user/tool/reset/missing-final/partial-answer interruptions push blocking to turn 5 or 6, aborts at 3.
- `execution_failures_do_not_transfer_to_a_replacement_goal` (`:136-169`): the streak restarts on goal replacement, blocks on turn 4.
- `script_errors_and_failures_before_execution_do_not_block_goals` (`:171-190`): `Completed{success:false}` and `Failed{handler_executed:false}` never produce a stop.
- `successful_tool_resets_failures_before_an_interrupted_turn_ends` (`:192-229`): a successful `shell` call in turn 3 prevents blocking.
- `goal_accounting_preserves_concurrent_descendant_usage_across_checkpoints` (`:231-268`): usage recorded during an accounting window stays pending for the next snapshot.
- `installed_goal_tools_create_goal_and_fill_empty_preview` (`goal_extension_backend.rs:56`): exact tool JSON incl. `remainingTokens`, and thread preview set from the objective.
- `installed_goal_tools_apply_maximum_token_budget` (`:103`): over-max budget rejected with the exact message and no row written; omitted budget defaults to the max.
- `ephemeral_goal_tools_preserve_specs_but_reject_execution` (`:152`): specs present, execution error "Goal tools require a persistent thread."
- `goal_tools_hidden_for_review_subagents` (`:189`): empty tool list.
- `installed_goal_tools_only_replace_complete_goal` (`:205`): duplicate create rejected verbatim; create after `complete` resets usage to 0.
- `create_goal_resets_baseline_before_turn_stop_accounting` (`:262`): only post-create usage (15) is charged; missing token baseline at turn start is tolerated.
- `tool_finish_accounts_active_goal_progress_and_emits_event` (`:334`): 23 tokens charged, event id equals the tool call id.
- `parallel_tool_finish_accounts_active_goal_progress_once` (`:385`): two concurrent finishes yield one event and one charge.
- `spawned_descendant_usage_exhausts_root_goal_budget_once` (`:448`), `grandchild_usage_rolls_up_after_parent_runtime_unloads` (`:511`), `subagent_usage_resets_when_root_goal_is_replaced` (`:551`): descendant rollup semantics.
- `budget_limited_goal_keeps_accruing_until_turn_stop` (`:628`): events at 25 (tool) and 35 (turn stop), status `budget_limited`.
- `budget_limited_goal_keeps_accounting_after_later_tool_finish` (`:704`).
- `turn_error_usage_limit_accounts_progress_and_clears_accounting` (`:762`): 23 tokens, `usage_limited`.
- `turn_error_blocks_goal` (`:844`): fatal error -> `blocked`.
- `failed_execution_turns_block_goal_unless_a_tool_succeeds` (`:874`): blocking turn is 3, 5, or 4 depending on a recovery success or a status-only turn.
- `usage_limit_budget_limited_goal_accounts_remaining_progress` (`:935`): `budget_limited -> usage_limited`, with the in-flight delta charged first (`tokens_used` 35 in both events, suffix `:usage-limit-progress`).
- `usage_limit_plan_turn_does_not_stop_goal` (`:1014`) and `usage_limit_stale_turn_does_not_stop_current_goal` (`:1051`).
- `update_goal_can_stop_and_accounts_final_progress` (`:1088`): for blocked/paused the requested status wins except when the final accounting crosses the budget, which yields `budget_limited`.
- `update_goal_rejects_resume_and_system_limit_statuses` (`:1215`): exact error text for `active`/`budget_limited`/`usage_limited`.
- `external_goal_mutation_start_accounts_active_goal_progress` (`:1244`).
- `goal_service_external_set_active_preserves_concurrent_usage` (`:1296`).
- `thread_stop_unregisters_goal_runtime_from_service` (`:1389`): after stop, clearing the goal emits no event.
- `thread_resume_rehydrates_active_goal_idle_accounting` (`:1429`): resumed idle goal accrues descendant tokens (23) and >=1s wall clock, event id `{thread}:external-goal-mutation`.
- `goal_service_sets_gets_and_clears_thread_goal` (`:1482`): a failed instruction-recording future leaves the goal unchanged; clear returns false when nothing existed.
- `goal_service_enforces_maximum_token_budget_on_creation_and_updates` (`:1556`).
- `steering.rs:19` and `:41`: the continuation prompt text is stable with and without `update_plan`, including when the objective mentions the plan tool.

State layer `codex-rs/state/src/runtime/goals.rs`: `replace_update_and_get_thread_goal` (`:668`), `replace_thread_goal_applies_budget_limit_immediately` (`:763`), `insert_thread_goal_does_not_replace_existing_goal` (`:786`), `insert_thread_goal_applies_budget_limit_immediately` (`:826`), `update_thread_goal_ignores_replaced_goal_version` (`:850`), `usage_accounting_ignores_replaced_goal_version` (`:918`), `update_thread_goal_objective_preserves_usage_and_created_at` (`:967`), `concurrent_partial_updates_preserve_independent_fields` (`:1022`), `pause_active_thread_goal_does_not_clobber_terminal_status` (`:1070`), `usage_limit_active_thread_goal_updates_active_or_budget_limited_goals` (`:1129`), `usage_accounting_updates_active_goals_and_accounts_budget_limited_in_flight_usage` (`:1189`), `active_status_only_usage_accounting_does_not_update_budget_limited_goals` (`:1260`), `stopped_usage_accounting_promotes_paused_goal_over_budget` (`:1295`), `budget_updates_immediately_stop_active_goals_already_over_budget` (`:1343`), `activating_goal_already_over_budget_keeps_it_budget_limited` (`:1390`), `pausing_budget_limited_goal_preserves_terminal_status` (`:1441`), `blocking_budget_limited_goal_preserves_terminal_status` (`:1488`), `usage_accounting_can_finalize_completed_goal_for_completing_turn` (`:1540`), `usage_accounting_can_finalize_stopped_goal_for_in_flight_turn` (`:1593`), `usage_accounting_adds_concurrent_token_deltas` (`:1660`), `deleting_thread_deletes_goal` (`:1704`).

App server:

- `empty_goal_continuations_block_after_three_without_activity` (`app-server/tests/suite/v2/thread_goal_empty_responses.rs:36-190`): three empty automatic turns produce `thread/goal/updated` with `Blocked`, each turn `Completed` with no error; activity or a tool call on turn 3 pushes it to 6; interrupt variant ends `Blocked` after 4.
- `worker_guardian_sees_goal_set_after_spawn` (`guardian_goal_tests.rs:12-121`): only `origin: "user"` goals appear as `User set the goal:` in guardian root context.
- `user_goal_updates_survive_resume_and_clear` (`:126-247`): original then edited objective, `User set goal status: "paused".`, `User cleared the goal.`, and never the automatic objective.
- `thread_fork_defers_inherited_active_goal_until_next_turn` (`thread_fork.rs:928-1170`): row copied, deferral marker, no turn/model request, marker survives restart, cleared by first turn, then `BudgetLimited` with 157 tokens.
- `thread_fork_rejects_incompatible_boundaries_and_ephemeral_goal_deferral` (`:2629`).
- `thread_resume_preserves_goal_first_and_fork_approvals_reviewer` (`thread_resume.rs:1397`), `thread_goal_get_rejects_unmaterialized_thread` (`:2243`), `unloaded_thread_goal_mutations_respect_parent_ownership` (`:2292`), `thread_goal_mutations_preserve_authoritative_sqlite_metadata` (`:2407`), `thread_goal_set_repairs_missing_sqlite_metadata` (`:2493`), `thread_goal_set_enforces_configured_maximum_token_budget` (`:3389`), `thread_goal_set_preserves_budget_limited_same_objective` (`:3482`), `thread_goal_set_persists_resumable_stopped_statuses` (`:3568`), `thread_goal_set_edits_objective_without_resetting_usage` (`:3646`), `thread_goal_keeps_original_root_until_external_objective_edit` (`:3749`, root switch at 3881).
- `provider_requirement_changes_reject_inputs_to_existing_threads` (`model_provider_enforcement_tests.rs:47`): goal set with an objective is gated like `turn/start`.

TUI: `tui/src/chatwidget/tests/goal_menu.rs` edit/resume flows (82, 121, 157, 195, 216) and `tui/src/chatwidget/tests/goal_validation.rs` (52, 78, 103, 117, 139, 159). `/goal` accepts `clear|edit|pause|resume` or an objective (`tui/src/chatwidget/slash_dispatch.rs:986-1047`); labels map `blocked -> "stalled"`, `budget_limited -> "limited by budget"` (`tui/src/goal_display.rs:33-42`).

## 9. What we must reproduce vs. what is Rust-specific plumbing

Must reproduce (observable behavior):

1. One goal per thread, six statuses, with the coercion rules: `budget_limited` is sticky against pause/block and against re-activation while over budget; `complete` is reachable from any status; create is refused unless the existing goal is complete.
2. Continuation is driven by the idle boundary, exactly once per boundary, serialized by a single-permit lock that also guards external set/clear, and admitted atomically against "there is already an active turn". One continuation per boundary, no cap, no backoff.
3. The continuation payload is a hidden user-role fragment, wrapped as internal context with source `goal`, carrying the objective plus token budget numbers, never a visible user message; it is rebuilt from persisted state each turn.
4. Token accounting is `input - cached + output`, charged as deltas at tool finish, turn stop, turn abort, turn error, external mutation, and final `update_goal`, always version-guarded; descendants roll up into the root goal.
5. Budget exhaustion sets `budget_limited`, keeps charging the in-flight turn, injects the wrap-up prompt once, and blocks further continuations; it never aborts the turn.
6. Three-strike breakers: three consecutive activity-free automatic turns (including already-interrupted ones) and three consecutive failed `exec` turns without a success, both reset by activity/user turns/goal replacement, both ignored for Plan-mode turns.
7. Error mapping: usage limit -> `usage_limited` (also from `budget_limited`), every other terminal error -> `blocked`; interrupt does not stop the goal, it defers evaluation to idle and restarts continuation.
8. User/RPC mutations must be recorded as an explicit user instruction before the state change, must hold the same permit as continuation, and must survive compaction and resume; automatic changes must not look like user authorization.
9. Restore on resume re-arms accounting only for `active`; nothing auto-resumes non-active statuses; fork copies the snapshot and defers the first continuation until a turn starts.
10. Durable state is a single-row-per-thread store with a compare-and-swap version (`goal_id`) and atomic additive updates; the event log is history, not the source of truth.

Rust-specific plumbing we should not copy literally: trait-based extension contributors (`ThreadLifecycleContributor`, `TurnLifecycleContributor`, `TokenUsageContributor`, `ToolLifecycleContributor`), tokio `Semaphore`/`Mutex` choices, `Weak<ThreadManager>` handles, the `ExtensionData` type-map, `RolloutItem`/`EventMsg` wire enums, sqlx `QueryBuilder`/`RETURNING` and `BEGIN IMMEDIATE`/busy-retry mechanics, OTel/analytics clients, and `cargo` test harness plumbing. The pi extension equivalent needs: one scheduler hook at the turn-end/idle boundary, one mutex/single-flight per thread, one tool-finish accounting hook, one token-usage hook, and one durable store.

## 10. Uncertainties and what I could not verify

- No tests were run. Every behavioral claim is from source or from reading a test body; nobody executed `cargo test` at this commit.
- Ordering between the DB write and the emitted `ThreadGoalUpdated` event is not transactional; on a crash between them the client can miss an update while the row is correct (`runtime.rs:602-608`, `ext/goal/src/tool.rs:385-391`). I did not find a reconciliation path for that case.
- `RecoveryMode::BackupAndRebuild` uses a `quick_check` limited to 100 ms (`state/src/sqlite.rs:490-498`); I did not verify what happens when the check times out or how often it runs, so "corruption loses all goals" is bounded by that behavior.
- Foreign-key enforcement on the goals pool is not visible in this tree (`PRAGMA foreign_keys` is not set in `sqlite.rs`), so `ON DELETE CASCADE` for the deferral table (`goals_migrations/0002:2`) is unconfirmed. Thread deletion removes the goal row explicitly (`state/src/runtime/threads.rs:1208`), but I could not confirm whether a deferral row can outlive it. If it can, it would permanently suppress continuation for a reused thread id.
- The main state DB still contains goal-specific migrations (`0029`, `0032`, `0033`) and a drop (`0034`); I found no data copy from that table into `goals_1.sqlite`, so pre-split goals appear to be discarded. I could not find a comment or test stating this was intended.
- `TurnAbortReason::BudgetLimited` has no producer in this tree (only match arms at `core/src/tasks/mod.rs:618,863,944` and `core/src/agent/status.rs:15`). Whether some out-of-tree caller aborts goal turns on budget is unknown; in-tree behavior is that the turn runs to completion.
- The exact JSON-RPC error code for an unknown status string is inferred from serde derives (`app-server-protocol/src/protocol/v2/thread.rs:820-829`); I did not find a test asserting the code.
- `codex-rs/app-server/tests/suite/v2/code_mode_host.rs:385` (`app_server_blocks_goal_after_repeated_code_mode_host_failures`) and `codex-rs/app-server/tests/suite/v2/daemon_update_recovery.rs:38` (managed restart resumes a goal) were not read in detail; they likely pin additional failure and restart behavior.
- TUI behavior is summarized at the level needed for labeling and commands; the goal file materialization path (`tui/src/goal_files.rs`) was not audited.
- I did not audit `metrics.rs`/`analytics.rs` semantics beyond noting the emitted counters, since they are not behavioral.
