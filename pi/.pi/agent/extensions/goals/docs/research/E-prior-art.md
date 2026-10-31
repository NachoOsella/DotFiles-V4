# E. Prior art: third-party Pi goal loops

Research snapshot: 2026-10-31. Installed Pi in this environment: `@earendil-works/pi-coding-agent` 1.4.0.

## Scope and method

Cloned shallow into `/tmp/prior-art/` (never inside the project). Two requested repos do not exist:

- `https://github.com/JJGO/pi-goal` returns 404: `gh api repos/JJGO/pi-goal` returns "Not Found". No repo of that name under `JJGO/`.
- `https://github.com/mattleong/pi-goals`: first clone failed with "Repository not found"; the repo does exist (public, 1 star, default branch `main`) and cloned cleanly on retry. Treated as found.

Requested repos plus alternatives found via `gh search repos pi-goals --limit 30` and npm (`pi-goal@0.1.7`, `pi-goals@0.5.1`, `pi-goal-x@0.34.1`, `@liucong233333/pi-bettergoal@0.3.1`, `@schovest/pi-goal`, `@narumitw/pi-goal`). Twelve implementations were read; each cited line was re-read in the clone. No test suite was executed (no `npm install` was run), so test counts are static counts and coverage claims are from reading test files.

Search for the modern continuation hook (`agent_before_settle` + `continue: true`) across all clones returned hits only in tmonk's specs and one test worker; Pi documents the contract at `docs/extensions.md:230` in the installed 1.4.0 tree.

## 1. Comparison table

`mech` = mechanism that starts the next model request. `persist` = source of truth. Stars/pushed from `gh api repos/<owner>/<repo>`.

| repo | commit | last commit | stars | Pi API targeted | mech | persist | budget | audit | tests | notable gaps |
|---|---|---|---|---|---|---|---|---|---|---|
| mattlong/pi-goals | `e17c833` | 2026-05-11 | 1 | peer `*`, node>=22.5 | `agent_end` -> 250 ms debounce timer -> `sendMessage(followUp, triggerTurn)`; `agent_start` confirms dispatch | SQLite `pi-goal.sqlite` (WAL+migrations) **plus** session entries | token budget + `maxAutonomousTurns`; non-cached input+output; per-turn delta dedupe | none (prompt text only) | 35 cases / 5 files; `spawnSync` CLI behavior tests | sqlite native dep; dual-write can diverge; no evidence gate |
| Michaelliv/pi-goal | `3f100be` | 2026-06-21 | 235 | `@mariozechner/*` `*` | `agent_end` -> `queueMicrotask` -> `sendMessage(followUp)` | session entries, `getBranch()` fallback `getEntries()` | token budget from `usage.totalTokens` (cache included) | none (prompt checklist) | 25 cases / 4 files; one test greps source with a regex | mid-turn goal creation never accounted; reload pauses; no continuation on restored session |
| bnema/pi-goals | `524a99c` | 2026-06-08 | 1 | `>=0.78 <1` | `agent_end` -> `sendMessage(followUp)` with persisted request id | session entries, branch replay | token budget, input+output (+optional cacheRead); time accounting | model must pass `evidence`; blocked needs same blocker 3 turns | 76 cases / 13 files; fake `ExtensionApi`/ctx | continuation cap is lifetime-per-goal and never resets; evidence is not inspected |
| code-yeongyu/pi-goal | `f326bdb` | 2026-10-26 | 23 | `*`, dev 0.87.1 | `agent_end` -> `sendMessage(followUp)` | per-thread JSON + history JSONL under session dir | token budget `input+output`; `TurnUsageTracker` diff vs cumulative | none | 71 cases / 9 files; 946-line extension test | user abort becomes `blocked`; files not branch-aware |
| fitchmultz/pi-codex-goal | `3aff9df` | 2026-10-31 | 196 | `*` optional, dev 1.0.2 | `agent_end` -> idle retry timer 50 ms -> `sendMessage(followUp)`; generation-tagged delivery | session entries only, `reconstructGoal(getBranch())` | token budget (min 500k), `input+output`, `turnGoalId` dedupe | none; checklist in prompt | 365 cases / 34 files; runtime harness + mock timers | no auditor; idle polling; lifetime usage re-counts context |
| tmonk/pi-goal-x | `b0fc15e` | 2026-10-27 | 121 | `>=1.4 <2` | `agent_end` records intent, `agent_settled` -> scheduler -> timer 0/50 ms -> `sendMessage(followUp)` | goal files in `.pi/goals` + JSONL ledger + scheduler state | token/time budget at 100% (+50/75/90% warnings); `input+output` | nested auditor session, read-only tools, final-line verdict | 1,149 cases / 104 files; SDK subprocess workers | explicitly rejects `agent_before_settle`; possible aborted-token double charge; huge surface |
| capyup/pi-goal | `ec2bcbe` | 2026-05-13 | 21 | `*`, dev 0.74.0 | `turn_end`/`agent_end` -> single timer, 50 ms re-arm -> `sendMessage(followUp)` | session entries + `.pi/goals/*.md` + JSONL ledger | **none** | in-process auditor session, `<approved/>` regex | 75 cases / 14 files, pure helpers only | no budget at all; 50 ms spin while busy |
| transcendr/pi-goals | `f090daa` | 2026-05-21 | 26 | **no peerDeps**, dev 0.74.0 | `turn_end`/`agent_end` -> 25 ms timer -> `sendMessage(followUp)` | session entries, event replay over `getBranch()` | token/time budget, 110% hard stop, `totalTokens` | none; "completion floor" defers+steers | **none** (no test files, no test script) | zero coverage; no peers declared |
| DraconDev/pi-goal-list-loop-audit | `6fba4c2` | 2026-10-31 | 29 | `>=0.84.2 <2` | 5 hooks -> `sendContinuation` -> `sendMessage(followUp)`; dispatch sidecar phases | `.pi-glla/active.jsonl` ledger (session entries not truth) | `tokensUsed/tokensLimit`, `input+output`, `timestamp:tokens` dedupe | **detached auditor subprocess** + evidence shield | 4,021 cases / 489 files | 70k LOC extensions tree; timestamp dedupe collisions; no native continuation |
| tintinweb/pi-supervisor | `63dff13` | 2026-05-31 | 72 | `>=0.74` | `agent_end` -> separate supervisor LLM -> `sendUserMessage`; `turn_end` steer | in-memory + session entry | **none** (only steer cap 5) | the supervisor *is* the auditor (no tools) | 57 cases / 6 files; e2e harness | not a goal tool surface; no budget; message-only |
| PurpleMyst/pi-goal | `82219d5` | 2026-06-12 | 14 | `@mariozechner >=0.69` | `agent_end` -> `setTimeout(0)` HACK -> `sendMessage(triggerTurn)` | session entries via `getEntries()` | none | none | 56 cases / 4 files | mutates entries array with `reverse()`; not branch-aware; no budget |
| wassname/pi-goals | `f452d97` | 2026-10-29 | 5 | `*` + `pi-subagents` | self-addressed "wake token" transformed in `input`; review on `agent_settled` | `plan.md`-style goals file | none | judge subagent via delegation events | 31 cases / 5 files | depends on external scheduler + subagents; no budget |

## 2. Cross-cutting findings

1. **Nobody uses the native continuation contract.** Zero of twelve use `agent_before_settle` returning `{ continue: true }`. Every loop is built from `agent_end`/`agent_settled`/`turn_end` plus `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, and most add a debounce timer because `agent_end` is not a final-idle signal (documented at `docs/extensions.md:145`). tmonk is the only one that anchors on `agent_settled`, and it explicitly rejected `agent_before_settle` (`specs/2026-10-01-pi-1-0-0-compatibility/MILESTONES.md:304-313`): "fires *before* settle, i.e. inside the same unsafe window `agent_end` occupies".
2. **Timer-driven continuation is where duplicates live.** 250 ms (mattlong `index.ts:22`), 50 ms retry (fitchmultz `src/continuation-scheduler.ts:156`, capyup `extensions/goal.ts:118`), 25 ms (transcendr `.pi/extensions/goal/continuation.ts:112`), `setTimeout(0)` (PurpleMyst `src/extension.ts:157`). Every one needs a dedupe flag *and* an idle re-check; the more mature ones add a persisted request id (bnema `src/lifecycle.ts:180-199`) or a generation token (fitchmultz `src/goal-delivery.ts:50-58`).
3. **Token accounting semantics are inconsistent, and this is the least-tested area.** Three variants: `input+output` (fitchmultz `src/goal-accounting.ts:44-49`, tmonk `extensions/goal-format.ts:305-311`, capyup `extensions/goal.ts:324-329`, Dracon `extensions/goal-loop-core.ts:672-675`, code-yeongyu `src/goal/store.ts:186-188`), `input+output` with optional cache (bnema `src/accounting.ts:80-83`), `totalTokens` (transcendr `extensions/goal/lifecycle.ts:380-383`, Michaelliv `.pi/extensions/pi-goal/usage.ts:9-17`), and Codex-style non-cached input+output (mattlong `goal-core.mjs:166-173`). The gap is large on long loops because cached input dominates each request; the definition must be chosen deliberately.
4. **Double-count defenses are ad hoc.** mattlong resets a per-turn high-water mark and takes deltas (`index.ts:653-659`); code-yeongyu diffs cumulative run usage against a flushed counter (`src/goal/turn-usage.ts:40-49`); fitchmultz gates the charge on `accounting.turnGoalId === goal.goalId` and clears the id after (`src/goal-accounting.ts:135`, `src/goal-runtime-turn-handlers.ts:50`); Dracon dedupes by `timestamp:tokens` (`extensions/goal-loop-core.ts:677`). None keys on a stable message/entry id.
5. **Completion trust is split three ways.** Trust the model with a long audit checklist (mattlong, Michaelliv, fitchmultz, PurpleMyst), require a non-empty model-supplied evidence string (bnema `src/tools.ts:96-97`), or run an independent auditor (tmonk, capyup, Dracon, tintinweb, wassname). Metered auditors cost a full extra model session per completion claim.
6. **Progress guards are common; their failure modes differ.** bnema suppresses after 3 no-progress turns and counts "meaningful text" with a verb regex (`src/lifecycle.ts:215-250`, `:321-328`). PurpleMyst pauses when an iteration made zero tool calls (`src/goal_state_machine.ts:42-46`). mattlong requires tool-observable activity and then latches a suppression flag (`index.ts:1191-1200`). capyup requires a goal-work tool call in the turn (`extensions/goal.ts:2172-2179`).
7. **Interrupt handling converges on "pause", except one.** tmonk pauses only on a genuine user abort (`extensions/goal-events.ts:201-207`); PurpleMyst pauses on `ctx.signal.aborted` at `turn_end` (`src/extension.ts:56-66`); mattlong pauses on `stopReason === "aborted"` (`index.ts:1162-1168`). code-yeongyu instead writes `blocked` with reason "user interrupted the turn" (`src/goal/lifecycle.ts:91-96`), which converts an Esc into a state that needs an explicit resume path.
8. **Persistence is drifting toward files, away from session entries.** Session-entry-only: bnema, Michaelliv, fitchmultz, PurpleMyst. File-based: mattlong (SQLite), tmonk (`.pi/goals` + ledger), capyup (`.pi/goals` + ledger), Dracon (`.pi-glla/active.jsonl`), code-yeongyu (per-thread JSON), wassname (goals markdown). Only the session-entry group is branch-aware for free (`/tree`, `/fork`).
9. **API targeting is stale across the field.** Most keep the pre-rename `@mariozechner/*` scope (Michaelliv, PurpleMyst) or declare `*` (mattlong, code-yeongyu, fitchmultz, capyup), which hides incompatibilities; only bnema (`>=0.78 <1`), Dracon (`>=0.84.2 <2`), tmonk (`>=1.4 <2`) and tintinweb (`>=0.74`) set a floor, and transcendr declares no peers at all. None was loaded against 1.4.0 in this study, so actual compatibility is untested; the declared ranges are the only evidence available.

## 3. Per-implementation detail

### 3.1 mattlong/pi-goals: the original "Codex-like" one

Commit `e17c8335e37000b2b11aebec20acc1aa2b2931cf` (2026-05-11), 2,388 LOC across `index.ts`, `goal-core.mjs`, `goal-store.mjs`, 35 tests.

- Continuation: `agent_end` -> `maybeContinue` with a four-way guard (`index.ts:749-751`), 250 ms debounce (`index.ts:22`, `:768`), then `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` (`index.ts:793-806`). Dispatch is confirmed at `agent_start`, which flips `continuationQueued` to `continuationRunning` and clears `autoContinuationSuppressed` for non-continuation runs (`index.ts:1178-1189`).
- No-progress: if the continuation ran and no tool fired, `agent_end` latches `autoContinuationSuppressed` (`index.ts:1191-1200`).
- Accounting: `message_end` charges per assistant message (`index.ts:1131-1133`), `turn_end` charges the final message (`index.ts:1134-1153`), both through `messageTokenDelta`, a high-water-mark delta reset at `turn_start` (`index.ts:653-659`, `goal-core.mjs:179-185`). Token definition is non-cached input + output (`goal-core.mjs:166-173`).
- Budget: `tokenBudget` and `maxAutonomousTurns`; the latter pauses with "Pi automatic continuation guard reached" rather than suppressing (`index.ts:702-723`). Budget crossing sends one wrap-up prompt (`index.ts:733-747`).
- Persistence: dual write to SQLite (`goal-store.mjs:126-136`, WAL, three SQL migrations) and `pi.appendEntry` (`index.ts:356-366`); session entries are the fallback for history (`index.ts:848-862`).
- Gaps: native sqlite dependency (engines `>=22.5`), dual-write divergence is unhandled, no evidence audit, prompt injection via `before_agent_start` rewrites the whole system prompt (`index.ts:1206-1209`) rather than letting Pi append a section, and `context` filters presentation messages out of every request (`index.ts:1211-1213`).

### 3.2 Michaelliv/pi-goal (most widely used)

Commit `3f100be5434454d3388755a119d01caca9127c16` (2026-06-21), 567 LOC, 25 tests, 235 stars.

- Continuation: `agent_end` -> `queueContinuation` -> `queueMicrotask` -> `sendMessage` (`index.ts:431-434`, `:169-177`), with a module-level `continuationQueued` flag (`:25`) cleared on any non-active persist (`:104-106`).
- State: `active|paused|budget_limited|complete` (`goal-state.ts:1`), persisted as one custom session entry (`index.ts:102-110`), restored from `getBranch?.() ?? getEntries()` (`:72-84`).
- Accounting: `turn_start` records the goal id, `turn_end` charges only when the id still matches (`index.ts:409-425`). This is the concrete bug: a goal created mid-turn (via `create_goal`) has `activeGoalThisTurnId === null` at `turn_start`, so the creating turn's tokens are never counted; replacing a goal mid-turn loses the whole turn as well (`:414-419` returns early on id mismatch).
- Budget: `tokenDeltaFromUsage` prefers `usage.totalTokens` (`usage.ts:9-17`), so cached input is counted as spend; `accountGoalTurn` flips to `budget_limited` at the threshold (`goal-state.ts:104-114`).
- Completion: prompt-only audit checklist (`index.ts:136-147`); `update_goal` accepts only `complete` (`index.ts:283`).
- Reload: an active goal is force-paused on `session_start` reason `reload` (`index.ts:385-395`) and the restored-session path only notifies, it does not queue a continuation (`:398-406`). Correct for safety, but a resumed session with an active goal stays idle until some other agent run ends.
- Tests include a "contract" test that regex-matches source text (`test/continuation-contract.test.cjs:8-13`), i.e. it asserts an implementation detail, not behavior.

### 3.3 bnema/pi-goals: the most rigorous small implementation

Commit `524a99c90771f12a97914860de62e39cbe9c1adf` (2026-06-08), 2,868 LOC, 76 tests across 13 files.

- Continuation: `agent_end` -> `maybeScheduleContinuation` (`src/lifecycle.ts:126-128`), with guards for status, `autoContinue`, idle, pending messages, budget, cap and prior request id (`:166-178`). The request id is persisted before dispatch (`:180-199`) and cleared at `turn_start` (`:70-81`), so a duplicate `agent_end` in the same turn cannot re-send.
- Uses `before_agent_start` to return a hidden `customType: pi-goals/context` message (`:55-68`) instead of rewriting the system prompt; state also carries durable context (refs, instructions, criteria).
- Accounting: `message_end` (`:88-106`) -> `accountAssistantUsage` (`src/accounting.ts:59-78`); funds are `input+output+cacheRead(optional)` (`:80-83`), so lifetime spend re-counts context each turn, a deliberate "spending cap, not context capacity" model.
- Budget/wrap-up: `maybeApplyBudgetLimit` (`accounting.ts:85-89`) and a one-shot wrap-up follow-up guarded by `wrapUpScheduledForGoalId` (`lifecycle.ts:146-164`).
- Completion: model may set only `complete` or `blocked` (`src/validation.ts:29-34`); `complete` requires a non-empty `evidence` string (`src/tools.ts:96-97`); `blocked` requires the same `blocker_key` on 3 consecutive goal turns (`validation.ts:36-44`, `tools.ts:117-127`). Evidence is required but never inspected.
- Caps: defaults `maxAutoContinuations: 50`, `noProgressTurnLimit: 3` (`src/goal-state.ts:123-131`). `continuationCount` only ever increments (`goal-state.ts:203` initializes it, `lifecycle.ts:185` increments it) and the cap check runs before dispatch (`lifecycle.ts:176`), so hitting 50 ends auto-continuation for that goal id; only replacing the goal resets it. The same branch also calls `suppress`, which latches `autoContinueSuppressedReason` (`lifecycle.ts:252-264`), cleared only by a progress turn.
- Tests are the best-in-class small suite: `tests/fakes.ts` provides `FakePi`/`FakeCtx`, lifecycle tests assert restore-on-branch and no duplicate append (`tests/lifecycle.test.ts:25-40`).

### 3.4 code-yeongyu/pi-goal

Commit `f326bdbb69b5a42740332f6e528498a4921490a6` (2026-10-26), 1,193 LOC, 71 tests.

- Continuation: `agent_end` (`src/goal/lifecycle.ts:78-107`) -> `queueHiddenGoalPrompt` -> `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` (`:220-226`). `session_start` also queues a continuation when a goal is already active and the context is idle (`:46-56`).
- Accounting: `TurnUsageTracker` keeps `pending` and `flushed`; `takeRemaining(agentRunMessages)` subtracts flushed from the cumulative run total, per usage field (`src/goal/turn-usage.ts:16-49`). This is the cleanest in-memory answer to double counting in the survey, but it only protects within one process: a reload resets `flushed` while the persisted `tokensUsed` remains, so post-reload accounting can re-charge an already-charged run.
- Persistence: files keyed by session/thread id under the session dir (`src/index.ts:19-26`, `src/goal/store.ts:26-32`), plus a history JSONL. Not branch-aware: `/tree` navigation does not restore goal state for the new branch.
- Interrupt bug: `agent_end` sees `ctx.signal.aborted` and writes `status: "blocked", reason: "user interrupted the turn"` (`src/goal/lifecycle.ts:79,91-96`). A user pressing Esc therefore lands in a blocked state, and the transition table allows `blocked -> active` only from user source (`src/goal/transitions.ts:42-53`), so continuation stops until a command.
- Surface: `get_goal`, `create_goal`, `update_goal`, `/goal` with pause/resume/clear; statuses `active|paused|blocked|complete`, transitions enforced centrally (`transitions.ts:37-54`).

### 3.5 fitchmultz/pi-codex-goal

Commit `3aff9df0e991e849168f5b739a0b0d3991baca0f` (2026-10-31), 5,726 LOC of source, 365 tests across 34 files.

- Continuation: `agent_end` -> `continuation.maybeContinue(ctx, true)` (`src/goal-runtime-agent-handlers.ts:67`); if not idle or pending messages exist, it schedules a 50 ms retry (`src/continuation-scheduler.ts:156-158`, `CONTINUATION_RETRY_MS` in `src/runtime-config.ts:1`). Post-compaction it re-polls idle with a `turnIndex` + `agentRunSequence` validation (`:188-224`).
- Delivery carries a `generation` UUID and a pending map with `start/finish/invalidate`, so a stale send cannot be mistaken for a live delivery (`src/goal-delivery.ts:50-66,86-101`).
- State: six statuses including `waiting` and `host_overflow_cap_reset` (`src/types.ts:3`); session entries only (`src/goal-persistence.ts:54-59`), usage entries throttled to 60 s (`src/runtime-config.ts:3`), a useful write-amplification guard.
- Tree/fork: `reconstructGoal(ctx.sessionManager.getBranch())` on `session_start`/`session_tree` (`src/goal-state-controller.ts:141-157`).
- Accounting: `input+output` (`src/goal-accounting.ts:44-49`), charged at `turn_end` (`src/goal-runtime-turn-handlers.ts:49`) and gated on `accounting.turnGoalId === goal.goalId` (`src/goal-accounting.ts:135`) with the id cleared after each charge (`src/goal-runtime-turn-handlers.ts:50`, `src/goal-runtime-controller.ts:219`); budget crossing sends one steer (`:146-157`). A regression test covers resume-between-aborted-turn_end-and-agent_end (`test/continuation.test.ts:66`).
- Completion: trust-the-model with a prompt checklist (`src/prompts.ts:41-56`); no auditor.
- Tests: `test/support/runtime-harness.ts:138-260` fakes the ExtensionAPI and records `sentMessages`/entries; timers are mocked with `node:test` (`test/compaction-continuation.test.ts:23`). This is the harness pattern to copy.

### 3.6 tmonk/pi-goal-x

Commit `b0fc15ebb658a1e9ea60ae65496717a780080f37` (2026-10-27), 19,526 LOC under `extensions/`, 1,149 tests across 104 files.

- Continuation: `agent_end` only records intent (`continuationAfterSettleFor = goalId`, `extensions/goal-events.ts:611`); `agent_settled` drives `core.scheduler.settled(...)` (`:615-638`), which schedules `setTimeout` 0 or 50 ms (`extensions/goal-runtime.ts:89-103`) and sends via `sendFollowUp` (`extensions/goal-state.ts:297-306`). The persisted prompt is a small checkpoint marker; the real prompt is injected per request in `before_agent_start`/`context` (`extensions/goal-events.ts:414-553`).
- Scheduler is a persisted state machine (`idle|ready|waiting|claimed|running|interrupted`, `extensions/goal-scheduler-state.ts:16-27`) with a `dispatchId` claim token and phase guards (`extensions/goal-scheduler.ts:391-427`).
- Budget: token + optional time; warning thresholds 50/75/90% then a one-shot `budget_limited` transition at 100% that cancels pending continuations and arms a wrap-up reminder (`extensions/goal-state.ts:526-560`). `input+output` only (`extensions/goal-format.ts:305-311`).
- Completion: nested auditor session created with `createAgentSession`, `SessionManager.inMemory`, read-only tools `read/grep/find/ls/bash` (`extensions/goal-auditor.ts:324-348`); verdict must be the final line `<approved/>`/`<disapproved/>` (`:64-72`), specifically to stop prose mentions from counting as approval. Auditor can be disabled per goal (`extensions/goal-completion.ts:75-80`), and rejection re-injects `[AUDITOR REJECTION]` instead of completing.
- Possible double charge: `turn_end` charges `completedTurnTokens` (`extensions/goal-events.ts:193-198`) and `agent_end` re-charges any aborted assistant messages (`:566-571`); when the abort carries no user signal the goal stays active, so both paths can run for the same message. Inference from code, not executed.
- Rejects `agent_before_settle` with a reasoned argument (`specs/2026-10-01-pi-1-0-0-compatibility/MILESTONES.md:304-313`); targets `>=1.4 <2` (`package.json:80-85`), the newest target in the survey.

### 3.7 capyup/pi-goal

Commit `ec2bcbe3ad4ca6d17455f77092c9001c4543e901` (2026-05-13), 4,863 LOC of source, 75 tests across 14 files.

- Continuation: one timer slot, 50 ms re-arm while not idle (`extensions/goal.ts:894-915`, `CONTINUATION_IDLE_RETRY_MS = 50` at `:118`); dispatch is `sendMessage({ customType: "pi-goal-event", display: false }, { triggerTurn: true, deliverAs: "followUp" })` (`:918-931`). Armed from `turn_end` only when the turn was not a tool-use turn and a goal-work tool fired (`:2158-2180`), and from `agent_end` (`:2352-2363`).
- Budget: none. `grep -n "tokenBudget\|tokensLimit\|budget"` over `extensions/*.ts` returns nothing; `usage.activeSeconds` is tracked but no cap exists.
- Accounting: `assistantTurnTokens` = `usage.input + usage.output` (`extensions/goal.ts:324-329`), so cache tokens are undercounted, and it is charged at `turn_end` (`:2159-2162`) plus settlement hooks.
- Completion: in-process auditor with `createAgentSession` + `SessionManager.inMemory`, read-only tool allowlist (`extensions/goal-auditor.ts:186-208`); prompt is aggressively skeptical (`:105-109`); verdict by regex `<approved/>`/`<disapproved/>`. Rejection returns tool text and keeps the goal open.
- State: session entries plus markdown goal bodies under `.pi/goals/` and a JSONL ledger; three statuses only (`active|paused|complete`).
- Gaps: cache undercount, busy-spin timer, auditor silently inherits the executor model when unconfigured, tests are pure-helper only (no ExtensionAPI harness).

### 3.8 transcendr/pi-goals (npm `pi-goals@0.5.1`)

Commit `f090daa595827f2d347600a2aa3083152242efdd` (2026-05-21), 5,510 LOC of source, **no tests** (no test files, no `test` script in `package.json`).

- Continuation: `turn_end`/`agent_end` -> `scheduleMaybeContinueGoal` (`extensions/goal/continuation.ts:97-114`), 25 ms `setTimeout`, then `sendMessage({ customType, display: false }, { triggerTurn: true, deliverAs: "followUp" })` (`:304-312`). Compaction uses a retry ladder `[100,250,500,1000,2000]` (`:39`).
- Budget: token + time with warning -> reached -> 110% hard stop (`extensions/goal/budget.ts:31-33`, `constants.ts:24`); tokens from `message.usage.totalTokens` (`extensions/goal/lifecycle.ts:380-383`). Safety caps `MAX_CONSECUTIVE_AUTO_TURNS = 50`, `MAX_NO_PROGRESS_AUTO_TURNS = 3` (`constants.ts:19-20`).
- Completion: no auditor. A "completion floor" (minimum tokens/time, or work cards) can turn a `complete` claim into `defer_and_steer` (`extensions/goal/completion-gate.ts:22-38`), which is a clever anti-premature-completion trick but is advisory.
- Persistence: session entries replayed over `getBranch()` (`extensions/goal/state.ts:32-40`), stale-goal rejection by id (`:134`).
- Gaps: no automated coverage, no `peerDependencies` at all (consumers must supply `@earendil-works/*`), and `totalTokens` accounting charges cache reads as spend.

### 3.9 DraconDev/pi-goal-list-loop-audit

Commit `6fba4c26588d925919508f902d24d2a962ccc37a` (2026-10-31), 70,482 LOC under `extensions/` (173,911 repo-wide), 4,021 test cases across 489 files.

- Continuation: five hooks (`turn_end`, `agent_end`, `agent_settled`, `before_agent_start`, `agent_start`) funnel into `sendContinuation` (`extensions/goal-continuation.ts:1617`), which calls `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` (`:1769-1773`). Source comment warns "A loop host may never emit agent_settled" (`extensions/goal-loop.ts:601`).
- The most interesting design choice: a durable dispatch sidecar with explicit phases, because "a `sendMessage({ triggerTurn: true })` call is only a dispatch acknowledgement. It is not proof that an agent turn started" (`extensions/goal-loop-dispatch.ts:1-10`; phases `prepared|accepted|started|failed|unacknowledged` at `:20`).
- Accounting: `sumNewAssistantTokens(messages, seen)` dedupes with `${timestamp}:${tokens}` (`extensions/goal-loop-core.ts:664-677`) (collision-prone for two identical-length messages in the same millisecond) and charges `input+output` when non-zero, else `totalTokens` (`:672-675`).
- Budget: `usage.tokensUsed/tokensLimit`, opt-in, pauses when `limit > 0 && used > limit` (`extensions/loops/goal-activation.ts:3359-3374`).
- Completion: a detached auditor **subprocess** (`spawn(command, [workerPath, "--job-dir", jobDir])`, `extensions/goal-loop-auditor-process.ts:2748-2760`), with job dirs, request hashing and identity checks; an evidence shield requires an `<evidence>` block covering every verification item. `complete_goal` is explicitly nonterminal: "this does NOT complete or approve the goal" (`extensions/loops/goal-tools.ts:724`). This is the strongest audit design, at the cost of a separate worker and a huge codebase.
- Interrupt: user abort stands down and blocks auto re-fire (`abortedStandDown`, `extensions/loops/goal-activation.ts:1015`, checked at `:1516`, `:1695`, `:1716`).
- Gaps: 70k LOC under `extensions/` (`goal-loop-core.ts` alone is 5,615 lines), ledger-as-truth (not branch-aware), dedupe key collisions, and no use of the native continuation contract.

### 3.10 tintinweb/pi-supervisor: auditor-first, no goal tools

Commit `63dff13346afa39fe4e6f22001d2a5b7ee60ba8a` (2026-05-31), 1,311 LOC of source, 57 tests.

- Continuation: there is no goal state machine. `agent_end` sends a separate supervisor LLM the outcome + recent conversation and gets `{ action: continue|steer|done }` (`src/index.ts:100-136`); `steer` becomes `pi.sendUserMessage(decision.message)` (`:125`). `turn_end` can steer mid-run on medium/high sensitivity (`:67-94`, `deliverAs: "steer"` at `:92`).
- The supervisor session is an in-memory Pi session with **no tools** (`src/model-client.ts:46-52`), so its "audit" is purely text-based; it cannot inspect files. Compaction summaries are passed in to preserve context (`src/engine.ts:100-111`).
- Stagnation cap: 5 consecutive idle steers then a lenient final evaluation (`src/index.ts:42`, `:107`, `:129`), a pragmatic escape from infinite supervision.
- No budget, no goal persistence beyond a session entry (`src/state.ts:8`, `:87-89`), not a drop-in goal extension. Useful for the "should an independent model judge completion" question: it bets everything on that, and consequently cannot verify evidence.

### 3.11 PurpleMyst/pi-goal: minimal, with a documented hack

Commit `82219d5c91e5ca34cdadd27f58a7163e0ac91858` (2026-06-12), 363 LOC of source, 56 tests.

- Continuation: `agent_end` -> `gm.continue()` -> `sendGoalMessage` -> `setTimeout(..., 0)` with the comment "HACK: Use setTimeout to ensure this runs after the current turn's processing is fully complete... Not documented behavior, but what works works" (`src/extension.ts:154-176`); the timer re-checks `ctx.hasPendingMessages()` and `ctx.isIdle()` and pauses the goal instead of sending (`:158-162`).
- No-progress: if the previous iteration made zero tool calls, `continue()` returns `NO_TOOL_CALLS` and the goal pauses (`src/goal_state_machine.ts:42-46`), counted via `tool_call` (`src/extension.ts:46-52`, `goal_state_machine.ts:75-79`).
- Abort: `turn_end` checks `ctx.signal?.aborted` and pauses, with a comment that session events do not carry the signal (`src/extension.ts:54-66`).
- State: `idle|ready|paused`, persisted as custom entries, restored with `sm.getEntries()` then `entries.reverse()` **in place** (`src/goal_finder.ts:9-12`); it mutates the session manager's array and is not branch-aware.
- No budget, no auditor; completion is a `update_goal(status: "complete")` literal.
- Value: the smallest complete loop (363 LOC of core), and the clearest statement that the `setTimeout` deferral is a workaround, not a contract.

### 3.12 wassname/pi-goals: a different bet, self-messaging

Commit `f452d974b3e5e65bf8c192ef61009db416a02bc1` (2026-10-29), 860 LOC of source, 31 tests.

- Instead of continuation messages, it emits a self-addressed **wake token** and transforms it in the `input` handler into the loop prompt (`src/index.ts:189-197`), so the loop is driven by ordinary user-input flow. Review/verification runs on `agent_settled` (`:183-187`).
- Completion is judged by a subagent registered through `pi-subagents` delegation events (`src/judge.ts:6-10`, `:61`, `:95`), i.e. it outsources the auditor to another extension's structured delegation protocol.
- Depends on `@jl1990/pi-scheduler` and `pi-subagents` at runtime; no budget; goals live in a markdown file.

## 4. Design lessons

1. **Prefer `agent_before_settle` + `{ continue: true }` as the continuation decision, and keep a message-based fallback only for explicit resume.** Every surveyed loop reimplements idle detection with 0-250 ms timers because `agent_end` is not final idle (`docs/extensions.md:145`), and the resulting dedupe machinery is the largest source of complexity (bnema `lifecycle.ts:166-199`, fitchmultz `goal-delivery.ts:50-58`, Dracon `goal-loop-dispatch.ts:1-10`). The counter-argument (tmonk `MILESTONES.md:304-313`) is about *when* it fires, not whether it can express the decision; the continuation there is one extra model request, not a new run. Verify `event.context.canContinue` and the entry-chaining contract in C-pi-extension-api before committing.
2. **Model continuation as a two-phase transaction: `requested` then `started`, persisted in the same snapshot.** Dispatch acknowledgement is not a started turn (Dracon's explicit finding, `goal-loop-dispatch.ts:1-10`); mattlong approximates it with `continuationQueued` -> `continuationRunning` at `agent_start` (`index.ts:1178-1189`). Our repository can persist `{ requestId, phase }` atomically with the goal snapshot, which kills the reload/duplicate-continuation class outright.
3. **Key usage accounting on message identity, not counters or timestamps.** The three existing defenses are all lossy: per-turn high-water marks (mattlong `index.ts:653-659`), per-run cumulative diffs (code-yeongyu `turn-usage.ts:40-49`), and `${timestamp}:${tokens}` keys (Dracon `goal-loop-core.ts:677`, which collides). Charging per assistant message/entry id is idempotent, survives reload, and makes the "duplicate count" invariant testable (our C6 requirement).
4. **Fix the token definition before writing code: non-cached input + output.** mattlong is the only implementation that subtracts `cacheRead` from input (`goal-core.mjs:166-173`); everyone else either ignores cache entirely or counts `totalTokens`, which turns a 2M-token session into a 40x budget error. Pick Codex's definition, document it in ARCHITECTURE.md, and assert it with a unit test that feeds a usage object with large `cacheRead`.
5. **Completion should be evidence-gated first, independently audited only as an option.** bnema's non-empty `evidence` plus 3-turn blocker recurrence (`tools.ts:96-97`, `validation.ts:36-44`) costs nothing and blocks the two worst failure modes (premature complete, thrash-blocked). Independent auditors (tmonk `goal-auditor.ts:324-348`, capyup `goal-auditor.ts:186-208`, Dracon subprocess `goal-loop-auditor-process.ts:2748-2760`) add a full model session per claim and, in tintinweb's case, cannot even inspect files (`model-client.ts:46-52`). Ship audit as a flag with the nested-session + read-only tools recipe, not as the default.
6. **Bound the loop with independent caps and make every suppression recoverable.** Use continuation count (bnema `goal-state.ts:125`), no-progress turns (bnema `lifecycle.ts:215-250`, PurpleMyst `goal_state_machine.ts:42-46`), autonomous-turn guard (mattlong `index.ts:713-720`) and token budget, each with its own status or reason. bnema's uncapped-counter design (`lifecycle.ts:176-199`, `goal-state.ts:203`) shows the failure: the 50-continuation cap is per goal lifetime, so once reached the only recovery is replacing the goal. Prefer a status (`paused`, reason `cap_reached`) that `/goal resume` can clear and that resets the counter.
7. **A user interrupt must pause, never terminalize.** code-yeongyu writes `blocked` with "user interrupted the turn" (`lifecycle.ts:91-96`) and its transition table then needs a user action to leave `blocked` (`transitions.ts:42-53`). PurpleMyst and mattlong pause instead (`extension.ts:54-66`, `index.ts:1162-1168`). Treat aborts as `paused (reason: interrupted)`, and distinguish a genuine user abort from provider/transport aborts (tmonk does, `goal-events.ts:201-207`).
8. **Session entries remain the right source of truth; add branch awareness on restore and never auto-resume on reload.** The session-entry group (bnema, fitchmultz, Michaelliv) gets `/tree` and `/fork` behavior from `getBranch()` (bnema `goal-state.ts:519-528`, fitchmultz `goal-state-controller.ts:141-157`). File/SQLite-as-truth (mattlong, tmonk, capyup, Dracon, code-yeongyu) loses branch semantics and adds migration burdens. On restore, pause (Michaelliv `index.ts:385-395`) or ask (fitchmultz `goal-runtime-session-handlers.ts:87-97`) rather than resuming silently.

## 5. No prior art found for

- **A goal loop built on `agent_before_settle` + `continue: true`.** Zero occurrences in 12 implementations; only a rejection memo (tmonk) and one test worker mention it.
- **Entry/message-id based usage dedupe in a goal extension.** The closest are high-water marks and timestamp keys; nobody uses the durable id.
- **Cost (currency) accounting or provider-reported cost.** All count tokens; none reads cost fields.
- **A typed domain layer with exhaustive transitions isolated from Pi adapters.** Transitions exist (code-yeongyu `transitions.ts:37-54`, bnema status enum `goal-state.ts:12-19`), but state machines and I/O are entangled in every case; Dracon is a 70k-LOC callback monolith.
- **Schema migration for session-entry state.** Persisted state carries `version`/`schemaVersion` (mattlong `index.ts:357`, bnema `goal-state.ts:82`), but no implementation migrates old entries when the shape changes; mattlong only migrates SQLite (`goal-store.mjs:6-10`).
- **A goal extension that survives `/tree` branch switching with file-backed state.** File-as-truth implementations (tmonk, capyup, Dracon, code-yeongyu) do not rebind on branch change.
- **Cross-process locking in a goal loop.** Dracon has a bakery-ticket owner file, but for its own supervisor/loop host, not for goal state; everyone else assumes one Pi process.

## Appendix: candidates found but not read

Identified via `gh search`/npm, not cloned (time-boxed): `junjiezhou1122/pi-goal` (independent verifier per claim), `izzzzzi/pi-goal-pro` (no-progress detection, token budgets), `Liucong-JunZi/pi-bettergoal` (agent-controlled wait/wake on top of Michaelliv), `schovest/pi-goal`, `narumitw/pi-goal` (+ `xbeark` fork with `-p` support), `steve-goldberg/pi-goal`, `sarthakxv/pi-goal`, `edxeth/pi-ralph-loop`, `braedonsaunders/bb-plugin-ultragoal`, `MuseLinn/pi-muselinn-harness`, `tchivs/gsd-omp`. Their READMEs suggest variants of the same `agent_end` + `sendMessage` pattern; none should be assumed different without reading.

Not found: `JJGO/pi-goal` (404). `mattleong/pi-goals` exists but its first clone attempt failed; retry succeeded.
