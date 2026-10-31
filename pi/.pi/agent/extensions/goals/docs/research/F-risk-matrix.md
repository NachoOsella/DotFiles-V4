# F. Risk matrix: autonomous goal continuation in Pi 1.4.0

Scope: a Pi extension that keeps a goal running by requesting continuation at Pi's settlement
boundary, persists state in session entries, and accounts token usage.

Source of truth: installed `@earendil-works/pi-coding-agent@1.4.0` at
`/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent`. All citations of the form
`dist/...:LINE` are relative to that directory. pi-ai citations are relative to its nested install at
`.../pi-coding-agent/node_modules/@earendil-works/pi-ai`. Prior art citations are absolute under
`/home/nacho/.pi/agent/extensions/`.

Method: every claim below was read from the shipped JavaScript (not from the CHANGELOG, not from
memory). Where behavior could only be inferred, the risk says `UNVERIFIED` and what would settle it.

---

## 0. How the boundary actually works (needed to read the risks)

This is the mechanism the whole design rests on, verified line by line.

1. `_startRun` prompts, then loops: `_handlePostAgentRun()` (retry, compaction, queued work) can
   continue the loop; otherwise `_runBeforeSettleBoundary()` is consulted
   (`dist/core/agent-session.js:1449-1462`). One boundary decision yields at most one
   `agent.continue()` per loop iteration.
2. `agent_before_settle` fires only when the run is *not* abort-requested; the loop short-circuits
   before the boundary on abort (`dist/core/agent-session.js:1457`, `dist/core/agent-session.js:1459`).
3. Continuation requires runnable context. After drafts are committed, `canContinue` must be true;
   for `agent_before_settle` that means the last projected message is not `assistant` (or a pending
   custom message exists). Otherwise `continue` is rejected and an extension error is reported
   (`dist/core/agent-session.js:615-633`, `dist/core/agent-session.js:1575-1583`). `Agent.continue()` throws on an assistant-last transcript
   (`node_modules/@earendil-works/pi-agent-core/dist/agent.js:262-273`), which is why the guard exists.
4. Boundary drafts are applied after *all* handlers return, at the then-current leaf, and the agent's
   in-memory messages are replaced by the rebuilt projection (`dist/core/agent-session.js:635-640`,
   `dist/core/agent-session.js:570-577`).
5. The handler continuation flag is cumulative: each handler sees `continue: shouldContinue` and
   may overwrite it; one boundary produces one boolean, never two continuations
   (`dist/core/extensions/runner.js:762-778`).
6. Handler exceptions are swallowed into extension errors; the boundary proceeds with the flags and
   entries accumulated so far (`dist/core/extensions/runner.js:773-787`).
7. `turn_end` is a *different* continuation mechanism. Returning `continue` there makes the agent
   loop run one more context-only turn inside the same run, with no `canContinue` guard
   (`dist/core/agent-session.js:521-532`,
   `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:184-208`).
8. `agent_settled{aborted}` fires after the run ends and no automatic work remains
   (`dist/core/agent-session.js:683-690`; `dist/core/extensions/types.d.ts:801-808`).
9. Custom entries (`pi.appendEntry`) are invisible to the model but survive on the raw branch
   (`dist/core/session-manager.js:163-166`, `dist/core/session-manager.js:901-914`). Custom *messages*
   (`custom_message`) are model-visible and are converted to `user` messages
   (`dist/core/session-manager.js:179-183`; `dist/core/messages.js:89-96`).

Consequences that drive most risks: the boundary continuation is *context-only* (no new text is
injected by returning `continue`), so the goal directive must be (re)appended as a draft or injected
per request; and the only durable state is the session entry.

---

## 1. Risk table

Impact: critical / high / medium / low. Likelihood assumes a competent first implementation.

| ID | Risk | Trigger | Impact | Likelihood | Detection | Mitigation | Test |
|---|---|---|---|---|---|---|---|
| R1.1 | Double continuation in one run cycle | Goal continues at both `turn_end` and `agent_before_settle` | high (2x spend, skipped progress bookkeeping) | high | two `agent_start` per goal step; step counter vs request count diverge | Pick exactly one continuation site; encode it in the state machine | `both-sites-configured-still-yields-one-request` |
| R1.2 | Duplicate state mutation across handlers | Two handlers (same or different extensions) each treat the boundary as theirs | medium | medium | duplicate `custom_message` directives in projection; step += 2 | Single writer: one handler, idempotent `applyBoundaryDecision(boundaryKey)` | `two-handlers-same-boundary-yield-one-step` |
| R1.3 | Phantom or duplicated step around an aborted continuation | Escape between `continue:true` and `agent.continue()`, or during the next stream | high | medium | `agent_settled{aborted}` with no `agent_start` for the recorded request, or a retried step | Record intent, confirm on `agent_start`; key steps by boundary id, not by counter increments | `abort-after-boundary-does-not-advance-step` |
| R2.1 | Goal resurrects after user interrupt | User presses Escape; goal still active; next user prompt ends normally and the goal continues | critical | high | `agent_settled{aborted:true}` followed later by a goal-driven `agent_start` with no explicit resume | Pause the goal on `agent_settled{aborted:true}`; require an explicit resume | `escape-pauses-goal-until-explicit-resume` |
| R2.2 | Continuation silently discarded after drafts commit | Escape while a boundary handler awaits | medium | medium | `agent_start` missing after a boundary that reported `continue`; entry_appended with no run | Treat `continue` as a request, not a fact; confirm via `agent_start`; never mark "running" before it | `abort-during-boundary-leaves-goal-paused` |
| R2.3 | Abort detection built on `agent_before_settle{outcome:"aborted"}` | Design assumes the boundary sees aborts | high (gap: never fires) | high | outcome is never `"aborted"` at that event | Detect aborts only from `agent_settled{aborted}` | `before-settle-never-reports-aborted` |
| R3.1 | Boundary continues a paused/limited goal | Pause/limit applied by a command between turns; boundary reads a stale snapshot | high | medium | goal status at decision time != status at execution time | Read state from the session branch at decision time; re-validate after appending; serialize mutations | `pause-between-turns-wins-over-stale-boundary` |
| R3.2 | Stale goal id mutates a new goal | Late tool result or queued command from goal N applied after goal N+1 exists | high | medium | tool `goalId` != active `goalId`/generation | Carry goal id + generation in every tool arg and entry; reject mismatches | `late-tool-result-for-old-goal-is-rejected` |
| R3.3 | Boundary hijacks a run the goal did not start | User prompt or another extension's `sendMessage({triggerTurn:true})` while a goal is active | medium | high | goal step attributed to a run whose first message is not the goal directive | Classify runs in `before_agent_start` / `agent_start`; only continue goal-started runs, or explicitly adopt user runs | `user-run-does-not-count-as-goal-step` |
| R4.1 | Torn persistence (entry + second record) | State written as entry plus an external file/in-memory flag | high | medium | entry present, state absent (or vice versa) after crash | One `custom` entry per transition carrying the whole snapshot; entry is the only source of truth | `single-entry-snapshot-is-atomic` |
| R4.2 | Restart after truncated write | Crash mid-`appendFileSync` | medium | low | last JSONL line fails `JSON.parse` | Loader skips bad lines; recover the previous snapshot by reverse scan | `truncated-last-line-recovers-previous-snapshot` |
| R4.3 | Snapshot never hits disk in a fresh session | Goal created before the first user/assistant message | medium | medium | `ctx.sessionManager.getSessionFile()` undefined | Refuse to treat an unpersisted goal as durable; warn; or persist on first turn | `goal-before-first-message-is-not-durable` |
| R4.4 | Schema mismatch breaks load | Older/newer snapshot shape | high | medium | parse throws or yields wrong shape; extension errors on every event | Versioned envelope, total parser, reject-unknown-version, never throw at load | `unknown-schema-version-loads-as-no-goal` |
| R4.5 | Persistence throws after in-memory mutation | Disk full / EACCES on append | medium | low | handler error at `appendEntry`, goal stuck mid-transition | Append first, mutate derived state after success; treat throw as "stay in previous state" | `append-failure-leaves-previous-state` |
| R5.1 | Fork/clone clones an active goal | `/fork`, `/clone` on a path containing the goal snapshot | critical | high | two sessions with the same goal id running | On `session_start` reason `fork`, force `paused` (or require explicit re-arm); goal id includes session id | `clone-of-active-goal-starts-paused` |
| R5.2 | `/tree` rewind drops or resurrects a snapshot | Navigate to an entry before the latest snapshot | high | medium | active goal id != snapshot on `getBranch()` | Reconstruct only from `getBranch()`; snapshot entries carry monotonic generation; ignore removed ids | `tree-rewind-restores-older-generation` |
| R5.3 | `/resume` auto-continues without intent | Resume a session whose last snapshot is `active` | high | high | goal-driven `agent_start` immediately after resume | On `session_start` reason `resume`, restore as `paused`; one command to resume | `resume-does-not-auto-continue` |
| R5.4 | Stale module-level scheduler survives replacement | `/new`, `/resume`, `/reload` | high | medium | two timers/two continuations after reload | All mutable state instance-scoped; clear timers in `session_shutdown`; never run work from module scope | `reload-twice-yields-one-scheduler` |
| R6.1 | Goal snapshot absent from boundary context after compaction | Compaction cut before the snapshot entry | high | high | `event.context.contextEntries` has no goal entry while `getBranch()` does | Never read goal state from boundary context/projection; read `getBranch()` | `compaction-hides-snapshot-from-context-but-not-branch` |
| R6.2 | Objective lost from model context | Compaction summarizes/cuts the directive `custom_message`, or the directive was only in the original user prompt | critical | high | first request after compaction lacks the objective text | Re-inject the objective at every boundary (draft or `context` transform); do not rely on history | `post-compaction-continuation-still-contains-objective` |
| R6.3 | Custom compaction wipes context | `session_before_compact` returns `firstKeptEntryId` not on the branch | high | low | projection collapses to the summary only | Keep Pi's `preparation.firstKeptEntryId`; never invent one | `invalid-first-kept-id-is-rejected` |
| R7.1 | Double-counted usage | Counting `message_end` and session entries, or assistant + toolResult duplicately | high | high | totals exceed Pi's footer/show stats | Dedupe by source entry id; count each message entry once | `same-message-observed-twice-counts-once` |
| R7.2 | Wrong token fields | Summing `input + output` only, or counting `cacheRead` as extra input | high | high | totals != `totalTokens`; budget drifts with caching | Use `totalTokens` (`input+output+cacheRead+cacheWrite`); cost from `usage.cost.total` | `cache-heavy-turn-matches-total-tokens` |
| R7.3 | Missing usage sources | Compaction summaries, cache warming, nested tool calls | medium | medium | goal total < Pi session total | Include `usage` entries, compaction/branch_summary usage, `toolResult.usage` | `all-usage-sources-reconcile-with-session-stats` |
| R7.4 | File-scoped vs branch-scoped totals conflated | `/tree` leaves abandoned-branch usage in `getEntries()` | medium | medium | goal total includes work on abandoned branches (or vice versa) | Track both: billed (file diff) and goal-branch usage; document which the budget uses | `abandoned-branch-usage-not-charged-to-new-branch` |
| R7.5 | Budget overshoot by one turn | Usage known only after the response | medium | certain | cap crossed exactly after a paid request | Check at boundary with a reserved worst-case turn margin; hard-stop before requesting | `budget-stop-happens-before-next-request` |
| R8.1 | Extension retries what Pi already retries | 5xx/429 | high (3x extra spend) | medium | duplicate identical requests after one error | Never retry provider errors; let Pi's retry finish | `transient-error-is-not-retried-by-extension` |
| R8.2 | Continuation after a terminal provider failure | Auth failure, non-retryable limit, quota | critical (loop of paid failures) | medium | `outcome:"error"` at boundary, repeated | Pause on `error` outcome (and on repeated identical error text) | `auth-error-pauses-goal` |
| R8.3 | Extension compaction fights Pi's overflow recovery | Context overflow | high | low | two compactions for one overflow; lost recovery attempt | Never compact on overflow; let `_checkCompaction` handle it; only observe `session_compact` | `overflow-is-not-compacted-twice` |
| R8.4 | Truncated output treated as progress | `stopReason:"length"` with partial tool calls | medium | medium | progress counter advances without tool results | Do not count a length-stopped turn as progress; require tool results or accepted output | `length-stop-does-not-count-as-progress` |
| R9.1 | Continuation while background work is still running | Background terminal or bash job started in a previous turn | medium | high | goal continues with an unfinished process; duplicated work | No cross-extension process registry exists; `pi.events` (`dist/core/extensions/types.d.ts:1405-1406`) is the only shared channel and the owner must publish, so model "waiting" explicitly | `goal-waits-for-background-terminal` |
| R9.2 | Subagent completion arrives after continuation | Child agent still running at settlement | medium | high | interleaved child completion turns | Treat "children running" as non-progress; pause or wait; never assume synchronous delegation | `goal-does-not-continue-while-child-runs` |
| R9.3 | Aborted tool leaves partial side effects | Escape during a mutating tool | medium | medium | tool result is an abort error but files changed | Record tool-call intent before execution; re-verify state after abort before continuing | `aborted-mutation-blocks-continuation` |
| R10.1 | Unbounded run | No goal step/credit cap | critical | high | requests per goal exceed cap | Hard caps: steps, wall clock, tokens, consecutive no-progress turns | `hard-step-cap-stops-continuation` |
| R10.2 | Non-progress false positives | Identical text/args across legitimate polling turns | medium | medium | premature stop | Require N consecutive identical fingerprints plus no new tool results before acting | `repeated-polling-before-threshold-continues` |
| R10.3 | Invalid-continuation error loop | `continue:true` with assistant-last context | medium | medium | extension error `requested continuation without runnable model context` each boundary | Check `event.context.canContinue` and append a directive draft before returning continue | `continue-without-runnable-context-is-downgraded` |
| R10.4 | Silent stop after handler throw | Exception in the boundary handler | high | medium | goal status `active`, no continuation, one extension error | Wrap handler body; on error write `paused(error)` and surface it; never leave `active` with no request | `boundary-handler-throw-pauses-goal` |
| R11.1 | User prompt mid-goal is ignored or overridden | User types while goal active; message steers/follow-ups into the run | high | high | user text in context but goal continues as if it were not there | Treat any user message after the last goal directive as a preemption checkpoint (pause or incorporate) | `user-steer-pauses-or-absorbs-into-goal` |
| R11.2 | Another extension's continuation flips the decision | Two extensions at one boundary | low | medium | agent continues although goal returned false | Read `event.continue` as input; the final boolean is shared, not owned | `foreign-continue-is-not-counted-as-goal-step` |
| R11.3 | Handler-order assumptions | Relying on being first/last | medium | medium | different behavior when another extension is installed | Read `event.entries`, `event.continue`, `event.context`; never assume ordering | `goal-works-regardless-of-handler-order` |
| R11.4 | Navigation from a boundary handler corrupts drafts | `ctx.navigateTree`/`fork`/`reload` inside a boundary handler | critical | low | drafts appended on a different leaf; projection mismatch | Never navigate/switch/reload from lifecycle handlers (docs: command-only, `docs/extensions.md:329-330`) | `boundary-handler-cannot-navigate` |
| R12.1 | Use-after-invalidate | Async work continues after `reload`/replacement | high | high | `This extension ctx is stale ...` errors | Snapshot plain data; flush synchronously in `session_shutdown`; no timers holding ctx | `stale-ctx-after-reload-throws-and-is-caught` |
| R12.2 | Quit ordering asymmetry loses final state | `quit`: `session_shutdown` fires before the abort/settled | high | medium | last transition missing on disk after quit | Flush in `session_shutdown`; treat `agent_settled` as non-authoritative for durability | `quit-flushes-state-before-invalidate` |
| R12.3 | Duplicate timers/listeners across reload | Old scheduler not cleared | high | medium | two continuations after `/reload` | Idempotent `session_shutdown` cleanup; instance-scoped state | `reload-clears-old-scheduler` |
| R13.1 | Boundary semantics change on minor upgrade | Pi minor version change | high | medium | drift test fails | Pin `>=1.4.0 <2.0.0`; add an executable API-contract test | `pi-api-drift-guard` |
| R13.2 | Draft/entry shape change | `SessionBoundaryDraft` adds/removes variants | medium | low | typecheck/test failure | Narrow interface in one adapter; drift test asserts variants used | `boundary-draft-contract` |
| R13.3 | Tool activation changes | Resume/tree records tool loadout (1.4.0 fix #11062) | medium | low | goal tools missing after resume | Verify active tools at `session_start`; use `pi.getActiveTools()`/`setActiveTools` | `goal-tools-active-after-resume` |
| R13.4 | Accounting API not exposed to extensions | `getSessionStats` is AgentSession-only | high (design assumption) | high | no way to read Pi totals from ctx | Derive totals from `ctx.sessionManager.getEntries()`; never assume a totals API | `usage-derived-from-entries-matches-pi` |

---

## 2. Detail

### Class 1 - Duplicate continuations

**R1.1 Double continuation in one run cycle.**
`turn_end` returning `continue` makes the agent loop perform one extra context-only turn
(`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:190-208`) via the hook installed at
`dist/core/agent-session.js:521-532`. Separately, when that loop finally ends,
`_runBeforeSettleBoundary()` may continue once more (`dist/core/agent-session.js:1450-1462`). A goal that returns `continue` in
both places produces two model requests per logical step and only one bookkeeping increment. The two
mechanisms are not equivalent: `turn_end` has no `canContinue` guard, `agent_before_settle` does
(`dist/core/agent-session.js:1575-1583`).
Detection: count `agent_start` events between goal steps and compare with the step counter.
Mitigation: choose one site; make the other pure observation. Test:
`both-sites-configured-still-yields-one-request`.

**R1.2 Duplicate state mutation across handlers.**
`emitBoundary` passes the accumulated flag and entries to each handler and lets each overwrite them
(`dist/core/extensions/runner.js:762-778`). Two handlers that both append a "continue the goal"
draft produce two `custom_message` entries and two step increments, but still only one continuation.
The duplicate is in persisted context, not in requests.
Detection: count goal directive entries per step; assert exactly one active directive.
Mitigation: one boundary handler per extension; decision function idempotent on a boundary key
(last branch entry id). Test: `two-handlers-same-boundary-yield-one-step`.

**R1.3 Phantom or duplicated step around an aborted continuation.**
After `continue:true`, Pi checks the abort flag twice before calling `agent.continue()`
(`dist/core/agent-session.js:1457-1461`). If Escape lands in that window the continuation never
happens, but a goal that already persisted "step N started" has spent a step for nothing. The reverse
is worse: if nothing was persisted, the same boundary is retried on the next run and the model is
asked again for work it may already have done.
Detection: a recorded request with no following `agent_start`; or two `agent_start`s for one boundary
key.
Mitigation: write `continuation_requested(boundaryKey)` before returning, confirm to `running` on
`agent_start` (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:73-74` emits it at the
start of every continuation), and make step identity the boundary key rather than a counter.
Test: `abort-after-boundary-does-not-advance-step`.

### Class 2 - Continuation after interrupt

**R2.1 Goal resurrects after user interrupt.**
`abort()` sets `_agentRunAbortRequested`, aborts compaction/branch summary, and marks
`_abortDuringBeforeSettle` when inside the boundary (`dist/core/agent-session.js:1971-1982`). The run
then ends and `agent_settled{aborted:true}` is emitted (`dist/core/agent-session.js:683-690`). Nothing in Pi remembers that the
goal was interrupted: the *next* user prompt starts a fresh run, whose boundary sees
`outcome:"completed"` and a still-`active` goal, so the goal continues. This is the single most likely
way the feature feels broken.
Detection: `agent_settled{aborted:true}` followed by a goal-driven `agent_start` without an explicit
resume action in between.
Mitigation: persist `paused` with reason `interrupted` in `agent_settled` when `aborted`; resume only
by explicit command/tool call. Test: `escape-pauses-goal-until-explicit-resume`.

**R2.2 Continuation silently discarded after drafts commit.**
If Escape arrives while a boundary handler awaits, `_abortDuringBeforeSettle` is set (`dist/core/agent-session.js:1971-1980`),
the drafts are still committed (`dist/core/agent-session.js:1573`), and `_runBeforeSettleBoundary` returns false (`dist/core/agent-session.js:1576-1577`).
The goal's directive entry is now in the session, but no request follows.
Detection: boundary returned `continue` but no `agent_start` before the next `agent_settled`.
Mitigation: treat `continue` as an *intent*, confirm on `agent_start`; because the handler cannot see
the abort (at the boundary `agent.activeRun` is already cleared, so `ctx.signal` is `undefined`,
`node_modules/@earendil-works/pi-agent-core/dist/agent.js:217-221`, `node_modules/@earendil-works/pi-agent-core/dist/agent.js:385-392`), the only reliable
signal is the missing `agent_start` plus the subsequent `agent_settled{aborted:true}`.
Test: `abort-during-boundary-leaves-goal-paused`.

**R2.3 `agent_before_settle{outcome:"aborted"}` is effectively unreachable.**
`_lastActivityOutcome` is set per turn (`dist/core/agent-session.js:487-489`), and the boundary is only reached when
`!_agentRunAbortRequested` (`dist/core/agent-session.js:1457`); an aborted turn also exits the agent loop immediately, ignoring
the `turn_end` decision (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:148-159`).
So `outcome` at this event is in practice `completed` or `error`.
Detection: assert in tests that no test observes `"aborted"` here.
Mitigation: do not build abort handling on `outcome`; use `agent_settled{aborted}`.
Test: `before-settle-never-reports-aborted`.

### Class 3 - Completed/paused/limited goals; stale goal ids

**R3.1 Boundary continues a paused/limited goal.**
Commands run between turns. A `pause`, `clear`, or budget limit applied after the last turn is
invisible to a handler that captured state at registration or at `session_start`. The boundary then
continues a goal the user just stopped.
Detection: compare the status read at decision time with the status committed by the decision.
Mitigation: read the newest snapshot from `ctx.sessionManager.getBranch()` inside the handler, decide,
append, and re-validate after the append (Pi applies drafts after all handlers, so the extension must
own serialization itself). Test: `pause-between-turns-wins-over-stale-boundary`.

**R3.2 Stale goal id mutates a new goal.**
Tools execute inside the turn (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:168-180`),
but a queued steering message or a command can clear and recreate a goal before the tool's effect is
applied (extension commands are handled immediately even during streaming,
`dist/core/agent-session.js:1623-1629`). A tool that writes `complete` for goal 7 after goal 8 exists corrupts 8.
Detection: tool argument `goalId`/generation differs from the active one.
Mitigation: every tool arg and every entry carries `goalId` + `generation`; mismatches are rejected
with a model-visible error. Test: `late-tool-result-for-old-goal-is-rejected`.

**R3.3 Boundary hijacks a run the goal did not start.**
Boundaries fire for every run, including a plain user prompt and runs started by another extension's
`sendMessage({triggerTurn:true})` (`dist/core/agent-session.js:1865-1871`) or `sendUserMessage` (`dist/core/agent-session.js:1631-1634`). A naive handler
treats any boundary as "the goal's turn end" and continues, so a user's ordinary question gets
followed by goal work.
Detection: first message of the run is not the goal directive.
Mitigation: classify in `before_agent_start` (`messageType` is `"user"` or `"custom"`,
`docs/extensions.md:216`) or `agent_start`, and only continue runs the goal started, unless the
design explicitly adopts a user run as goal context. Test: `user-run-does-not-count-as-goal-step`.

### Class 4 - Persistence races

**R4.1 Torn persistence between entry and derived state.**
`_appendEntry` mutates the in-memory tree and then persists synchronously
(`dist/core/session-manager.js:815-820`, `dist/core/session-manager.js:794-814`). Pi itself has no torn window because the entry
*is* the state. The risk appears only when the extension keeps a second record (external file, or an
in-memory "current" plus a *different* entry on next write).
Detection: entry present but derived state absent after restart.
Mitigation: one `custom` entry per transition with the complete snapshot
(`appendCustomEntry`, `dist/core/session-manager.js:901-914`); everything else is a cache rebuilt from `getBranch()`.
Test: `single-entry-snapshot-is-atomic`.

**R4.2 Restart after a truncated write.**
Appends are per-line `appendFileSync` (`dist/core/session-manager.js:811-813`); the loader skips lines that fail `JSON.parse`
rather than failing the session (`dist/core/session-manager.js:313-322`). A crash can therefore drop exactly the newest snapshot.
Detection: test fixture with a truncated last line.
Mitigation: reverse-scan the branch for the newest parsable snapshot (proven pattern:
`/home/nacho/.pi/agent/extensions/subagents/src/persistence/session-state.ts:52-74`) and never throw at load.
Test: `truncated-last-line-recovers-previous-snapshot`.

**R4.3 Snapshot never hits disk in a fresh session.**
A session file is created only once a user or assistant message exists
(`dist/core/session-manager.js:786-800`). A goal created from a command before the first prompt lives
only in memory; on quit it is gone.
Detection: `ctx.sessionManager.getSessionFile() === undefined` while the goal is `active`.
Mitigation: mark such a goal `pending` and do not rely on its durability; persist on first append
after the session has a conversation. Test: `goal-before-first-message-is-not-durable`.

**R4.4 Schema mismatch breaks load.**
`sessionEntryToContextMessages` and the file loader tolerate unknown shapes, but extension code is
the one that decides. A parse that throws inside `session_start` becomes an extension error and the
goal silently disappears; a parser that accepts garbage produces a corrupt goal.
Detection: load a fixture for each historical version.
Mitigation: versioned envelope, total (never-throwing) parser, unknown version treated as "no goal"
plus a user-visible notice. Precedent:
`/home/nacho/.pi/agent/extensions/subagents/src/persistence/schema.ts:50-58`. Test:
`unknown-schema-version-loads-as-no-goal`.

**R4.5 Persistence throws after in-memory mutation.**
An `appendEntry` failure (disk full, permissions) propagates out of the handler and is converted into
an extension error by `emitBoundary` (`dist/core/extensions/runner.js:773-787`). If the extension
mutated its own state first, memory and disk now disagree while the goal still looks `active`.
Detection: error at append plus a status transition already applied.
Mitigation: append first, apply derived state only after success; on throw keep the previous state and
persist `paused(error)`. Test: `append-failure-leaves-previous-state`.

### Class 5 - Session semantics

**R5.1 Fork/clone clones an active goal.**
`/clone` is `fork(leafId, {position:"at"})` (`dist/modes/interactive/interactive-mode.js:4581-4588`),
and `/fork` uses `createBranchedSession(targetLeafId)`
(`dist/core/agent-session-runtime.js:174-250`). That copies the whole root-to-leaf path, including
goal entries, into a new session file with a **new** session id
(`dist/core/session-manager.js:1243-1245`), then emits `session_start` with
`reason:"fork"` (`dist/core/agent-session-runtime.js:211`;
`dist/core/extensions/types.d.ts:575-583`). Two independent sessions now believe they own the goal.
Detection: same `goalId` active in two session ids; the fork starts with `reason:"fork"`.
Mitigation: goal identity includes `getSessionId()`; on `session_start` reasons `fork` and `new`,
restore as `paused` and require explicit resume. Test: `clone-of-active-goal-starts-paused`.

**R5.2 `/tree` rewind drops or resurrects a snapshot.**
`branch()` only moves the leaf; nothing is deleted (`dist/core/session-manager.js:1161-1166`), and
`getEntries()` still returns the whole file (`dist/core/session-manager.js:1107-1109`). After a rewind, the newest snapshot may no
longer be on `getBranch()` (`dist/core/session-manager.js:1062-1072`), so a reverse scan of the branch finds an *older* snapshot
and resurrects a stale generation. Note the exported free function has a trap:
`buildSessionProjection(entries)` defaults the leaf to `entries[entries.length-1]`
(`dist/core/session-manager.js:124-136`), i.e. the abandoned tip, not the active leaf.
Detection: active goal generation vs newest snapshot on the branch.
Mitigation: always use `ctx.sessionManager.buildSessionProjection()` (bound to the live leaf) or pass
`getLeafId()`; snapshots carry monotonic generation; a rewind that loses the latest snapshot must
pause, not resume an older one. Test: `tree-rewind-restores-older-generation`.

**R5.3 `/resume` auto-continues without intent.**
Resume reopens an existing file and emits `session_start{reason:"resume"}`
(`dist/core/agent-session-runtime.js:128-145`). If the last snapshot is `active`, any auto-start
mechanism (timer, `session_start` send, or the next user prompt) continues work the user only wanted
to inspect.
Detection: goal-driven request within the first run after resume.
Mitigation: persist `paused` on every clean shutdown and restore as `paused` after `resume`.
Test: `resume-does-not-auto-continue`.

**R5.4 Stale module-level scheduler survives replacement.**
Reload builds a new extension runtime and invalidates the old one
(`dist/core/agent-session.js:2998-3033`, `dist/core/extensions/runner.js:482-492`), but module-level
state in the extension's module is a separate question. Extensions are module-cached per
cwd/generation (`dist/core/extensions/loader.js:459-468`), so a cached factory can reuse module
scope; a module-level `setInterval` or singleton would then have two owners.
Unverified: whether a `/reload` always busts that cache. Settle it by reloading twice and counting
continuations.
Detection: two goal continuations per step after `/reload`.
Mitigation: all state instance-scoped inside the extension factory; timers cleared in
`session_shutdown`; never start work at module scope (also `docs/extensions.md:58-60`).
Test: `reload-twice-yields-one-scheduler`.

### Class 6 - Compaction destroying goal context

**R6.1 Custom entries vanish from the projected context.**
`sessionEntryToContextMessages` returns `[]` for `custom` entries and the comment says it plainly:
"Plain custom entries are display/state entries and do not participate in context"
(`dist/core/session-manager.js:163-166`, and `return []` at `dist/core/session-manager.js:186-191`). After a compaction, `buildContextEntries` keeps only the
compaction entry plus entries from `firstKeptEntryId` onward (`dist/core/session-manager.js:201-229`), so goal snapshots before
the cut are absent from `buildSessionProjection()` and from
`event.context.contextEntries` - while still present in `getBranch()`.
Detection: a boundary context with zero goal entries while `getBranch()` has them.
Mitigation: read state only from `getBranch()`; never from the boundary preview or projection.
Test: `compaction-hides-snapshot-from-context-but-not-branch`.

**R6.2 Objective lost from model context.**
A directive stored as `custom_message` is model-visible (`dist/core/session-manager.js:179-183`) and is converted to a `user`
message (`dist/core/messages.js:89-96`), which means it is a valid cut point
(`dist/core/compaction/compaction.js:253-266`) and it is summarized: the summarizer converts and
serializes it as `[User]: ...` (`dist/core/compaction/compaction.js:515-524`, `dist/core/compaction/utils.js:108-114`). Paraphrase,
truncation, or a cut can lose the objective. A directive that only existed in the original user
prompt is equally vulnerable. Because `agent_before_settle` continuation is context-only, the
continuation request then has no instruction to continue the goal at all.
Detection: first post-compaction request lacks the objective text; model output drifts to chat.
Mitigation: re-inject the directive on every continuation as a boundary `custom_message` draft, or
one persistent directive entry updated with a `context_edit` draft
(`SessionBoundaryDraft`, `dist/core/extensions/types.d.ts:752-778`; `appendContextEdit`,
`dist/core/session-manager.js:962-998`), or per-request through the `context` event
(`emitContext`, `dist/core/extensions/runner.js:1006-1065`), which is request-local because
`streamAssistantResponse` uses a local `messages` variable
(`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:265-273`) and never mutates
`context.messages`. Test: `post-compaction-continuation-still-contains-objective`.

**R6.3 Custom compaction can wipe context.**
`session_before_compact` may cancel or replace the compaction
(`dist/core/agent-session.js:2543-2567`; `dist/core/extensions/types.d.ts:1137-1140`). If the returned
`firstKeptEntryId` is not on the branch, `foundFirstKept` never becomes true and the projection
collapses to the summary alone (`dist/core/session-manager.js:216-226`), silently discarding the
whole kept range.
Detection: `firstKeptEntryId` not in `getBranch()` ids; post-compaction projection length.
Mitigation: pass `preparation.firstKeptEntryId` through unchanged (`docs/compaction.md:313-325`);
cancelling repeatedly risks overflow, so cancel only with a finite budget. Note `/compact` aborts the
active run first (`dist/core/agent-session.js:2230-2232`), i.e. manual compaction is itself an interrupt.
Test: `invalid-first-kept-id-is-rejected`.

### Class 7 - Token accounting

**R7.1 Double counting.**
`message_end` is delivered to extensions *before* persistence (`dist/core/agent-session.js:751-770`),
and the same assistant message also exists as a session entry afterwards. Counting both doubles the
bill. Counting an assistant message and separately counting the `toolResult` entries of the same turn
is correct (nested tool usage is folded into `toolResult.usage`, `dist/core/agent-session.js:716-723`) but counting the
`toolResult` twice (event + entry) is not.
Detection: goal totals exceed `sessionManager`-derived totals.
Mitigation: dedupe by source entry id; at `turn_end` use `event.messageEntryId` and
`event.toolResultEntryIds` (`dist/core/extensions/types.d.ts:828-835`) as the canonical keys.
Test: `same-message-observed-twice-counts-once`.

**R7.2 Wrong token fields.**
`Usage.input` excludes cached tokens: `calculateCost` treats total input as
`input + cacheRead + cacheWrite` (`node_modules/@earendil-works/pi-ai/dist/models.js:672-673`), and
providers build `totalTokens` the same way
(`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1186-1196`; `node_modules/@earendil-works/pi-ai/dist/types.d.ts:285-305`). Summing
`input + output` undercounts a cache-heavy session badly; adding `cacheRead` on top of `input` as if
`input` included it is also wrong. Context size uses `totalTokens` with a fallback
(`dist/core/compaction/compaction.js:65-67`).
Detection: reconcile against `totalTokens`.
Mitigation: budget on `usage.totalTokens` and `usage.cost.total`; never recompute cost.
Test: `cache-heavy-turn-matches-total-tokens`.

**R7.3 Missing usage sources.**
Pi's own totals include: `usage` entries (cache warming, `dist/core/session-manager.js:864-878`),
compaction and branch-summary usage (`dist/core/agent-session.js:3456-3457`), `toolResult.usage` for
nested calls (`dist/core/agent-session.js:3466-3470`), and assistant usage (`dist/core/agent-session.js:3478`). A goal that sums only assistant turns
undercounts every compaction and every nested model call.
Detection: goal total < Pi total for the same span.
Mitigation: mirror `getSessionStats` (`dist/core/agent-session.js:3445-3497`) over entries the extension can read.
Test: `all-usage-sources-reconcile-with-session-stats`.

**R7.4 File-scoped vs branch-scoped totals.**
`getSessionStats` iterates `getEntries()` (`dist/core/agent-session.js:3452`), which returns the
whole file including abandoned branches (`dist/core/session-manager.js:1107-1109`); `getBranch()` is only the active path (`dist/core/session-manager.js:1062-1072`).
After `/tree`, "billed" and "on this goal's branch" differ.
Detection: compare file-scope and branch-scope sums; they should differ exactly by abandoned work.
Mitigation: keep two counters; document that the hard budget uses billed (file diff) so rewinding
cannot refund spend. Test: `abandoned-branch-usage-not-charged-to-new-branch`.

**R7.5 Budget overshoot by one turn.**
Usage is only known after a response. A cap checked at the boundary stops *before the next request*
(that part is sound: `dist/core/agent-session.js:1457-1461`), but the last allowed request can already exceed the cap.
Detection: recorded spend after stop > cap.
Mitigation: enforce `spent + worst_case_turn <= cap` before requesting; report the overshoot
explicitly. Note `getContextUsage()` can return `tokens:null` right after compaction
(`dist/core/agent-session.js:3500-3530`), so it is not a budget source. Test: `budget-stop-happens-before-next-request`.

### Class 8 - Provider errors

**R8.1 Extension retries what Pi already retries.**
Pi retries transient provider failures up to `retry.maxRetries` (default 3,
`dist/core/settings-defaults.js:17-25`) with backoff, keeping the failed attempt in raw history and
omitting it from projection (`dist/core/agent-session.js:3090-3122`, `dist/core/agent-session.js:843-870`). Retryability is a
message-pattern decision (`node_modules/@earendil-works/pi-ai/dist/utils/retry.js:202-209`).
An extension that also retries multiplies spend.
Detection: identical requests after one error surface.
Mitigation: never retry; only observe `auto_retry_start`/`auto_retry_end`.
Test: `transient-error-is-not-retried-by-extension`.

**R8.2 Continuation after a terminal provider failure.**
Auth failures, quota exhaustion and workspace limits are excluded from retry
(`node_modules/@earendil-works/pi-ai/dist/utils/retry.js:4-25`), so the run ends with
`outcome:"error"` at the boundary (`dist/core/agent-session.js:487-489`) and `agent_settled`. Continuing from there bills one
failed request per boundary forever.
Detection: `outcome:"error"` (and repeated identical `errorMessage`).
Mitigation: pause on error; escalate after N identical errors; never auto-continue error outcomes.
Test: `auth-error-pauses-goal`.

**R8.3 Fighting Pi's overflow recovery.**
Context overflow is handled by compaction with one retry attempt
(`dist/core/agent-session.js:2391-2472`) and an explicit one-shot guard
(`_overflowRecoveryAttempted`, `dist/core/agent-session.js:2445-2472`). An extension that compacts on overflow, or retries after
`session_compact_failed`, duplicates the repair and can consume the single recovery attempt.
Detection: two compactions for one overflow; recovery message lost.
Mitigation: only observe `session_compact`/`session_compact_failed`; never call `ctx.compact()`
from an error path. Test: `overflow-is-not-compacted-twice`.

**R8.4 Truncated output treated as progress.**
`stopReason:"length"` fails all tool calls from the truncated message
(`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:165-172`). A goal that counts any
assistant turn as progress will spin on length stops.
Detection: `stopReason:"length"` with zero successful tool results.
Mitigation: progress requires successful tool results or an accepted final answer; count length stops
as no-progress and let Pi's compaction/recovery run. Test: `length-stop-does-not-count-as-progress`.

### Class 9 - External processes

**R9.1 Background work is not finished at settlement.**
The installed background-terminals extension defers results until `agent_settled` and keeps processes
alive across turns, killing them only on `session_shutdown`
(`/home/nacho/.pi/agent/extensions/background-terminals/index.ts:217`). Pi itself knows nothing
about them: it only tracks bash it executes itself (`dist/core/agent-session.js:3160-3177`,
`dist/core/agent-session.js:3209-3213`). A goal continuation can therefore overlap an unfinished process and duplicate work.
Pi exposes no process registry to event handlers. A boundary handler holds an `ExtensionContext`;
`executeTool()` exists only on `ExtensionToolContext` for tool execution
(`dist/core/extensions/types.d.ts:269-281`), so the goal cannot call `bg_status` from a boundary.
The only shared channel is the opt-in event bus (`dist/core/extensions/types.d.ts:1405-1406`), and
the process owner must publish on it.
Detection: goal continues while the owning extension reports running work.
Mitigation: model "waiting on external work" as an explicit goal status that only a tool result or a
published event clears; do not infer completion from settlement.
Test: `goal-waits-for-background-terminal`.

**R9.2 Subagent completion arrives after continuation.**
Subagents run in their own sessions and deliver completions as messages; the delivered turn can land
after the goal already continued, interleaving two work streams. Their cleanup also happens on
`session_shutdown` (`/home/nacho/.pi/agent/extensions/subagents/index.ts:376-386`).
Detection: a user/custom message from a child appears after the goal's continuation.
Mitigation: treat "children running" as a non-progress state and wait; make delegation contracts
explicit. Test: `goal-does-not-continue-while-child-runs`.

**R9.3 Aborted tool leaves partial side effects.**
Tools receive the run's abort signal and return synthetic abort results
(`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:408-460`), and Pi aborts its own bash
controllers (`dist/core/agent-session.js:3209-3213`). A killed command may still have mutated files.
Detection: tool result is an abort error for a mutating tool.
Mitigation: record tool-call intent before execution; after an abort, require re-verification before
continuing. Test: `aborted-mutation-blocks-continuation`.

### Class 10 - Infinite loops and runaway cost

**R10.1 No cap exists in Pi.**
The agent loop is `while (true)` (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:92`)
and the session loop is `while (!abortRequested)` (`dist/core/agent-session.js:1450`). Neither has a
turn, step, or cost ceiling. The extension is the only budget authority.
Detection: per-goal counters persisted in the snapshot.
Mitigation: hard caps on steps, wall clock, tokens, and consecutive no-progress turns; each cap
transitions to `limited` and injects one wrap-up instruction. Test:
`hard-step-cap-stops-continuation`.

**R10.2 Non-progress detection false positives.**
Legitimate work repeats identical tool calls (polling, retries with the same args). A one-shot
"same args = stuck" rule stops healthy goals.
Detection: fingerprint (tool name + normalized args + result hash) per turn; require a run of N
identical fingerprints *and* no new file edits.
Mitigation: N consecutive no-progress turns with escalating nudges, then stop. Test:
`repeated-polling-before-threshold-continues`.

**R10.3 Invalid-continuation error loop.**
Returning `continue` while the last projected message is `assistant` and nothing is queued fails the
`canContinue` check, reports an extension error, and stops the run
(`dist/core/agent-session.js:1575-1583`, `dist/core/agent-session.js:641-648`). Repeating this every boundary produces an error
per turn and no work.
Detection: the exact error string in the extension error stream.
Mitigation: check `event.context.canContinue` and append the directive draft before returning
continue. Test: `continue-without-runnable-context-is-downgraded`.

**R10.4 Silent stop after a handler throw.**
`emitBoundary` swallows handler exceptions and keeps the previous `continue` value
(`dist/core/extensions/runner.js:773-787`). A goal that throws before returning stays `active` with no
continuation and only an extension error.
Detection: status `active`, no continuation, one error.
Mitigation: wrap the handler body; on error persist `paused(error)` and surface it through the UI.
Test: `boundary-handler-throw-pauses-goal`.

### Class 11 - Manual and other-extension interference

**R11.1 User prompt mid-goal.**
A prompt typed while the agent is streaming is queued as steer or follow-up
(`dist/core/agent-session.js:1664-1676`) and is consumed inside the run, so the boundary fires with
the user's text already in context. A goal that blindly continues overrides the user's intervention.
Detection: a `user`-role message appears after the last goal directive on the branch.
Mitigation: treat it as a preemption checkpoint: pause, or explicitly incorporate it into the goal
with a recorded reason. Test: `user-steer-pauses-or-absorbs-into-goal`.

**R11.2 Another extension's continuation flips the decision.**
The continuation flag is shared state; the last handler to set it wins, and the final value is the OR
of the session's queued work (`dist/core/extensions/runner.js:770-778`;
`dist/core/agent-session.js:1578`). The goal must treat `event.continue` as an input, not as its own
output, and must not count a foreign continuation as a goal step.
Detection: step counter advances while the goal's own decision was `false`.
Mitigation: compute the goal decision independently; log foreign continuations.
Test: `foreign-continue-is-not-counted-as-goal-step`.

**R11.3 Handler-order assumptions.**
Order is extension load order and registration order within an extension
(`dist/core/extensions/runner.js:87-88`, `dist/core/extensions/runner.js:765-766`). Any design that depends on running first or last
breaks when another extension is installed.
Detection: behavior change with an extra no-op boundary extension loaded.
Mitigation: read `event.entries`, `event.continue`, `event.context`; never assume ordering.
Test: `goal-works-regardless-of-handler-order`.

**R11.4 Navigation from a boundary handler corrupts drafts.**
`ctx` inside a boundary is a full extension context, but navigation, session replacement, and reload
are documented as command-only because calling them from lifecycle handlers can deadlock
(`docs/extensions.md:329-330`). Worse, drafts are applied after all handlers at the current leaf
(`dist/core/agent-session.js:635-640`, `dist/core/agent-session.js:1573`) and the context preview is rebuilt after each handler
(`dist/core/extensions/runner.js:788-790`), so a mid-boundary branch change commits drafts on the new
leaf while later handlers see a different transcript.
Detection: leaf id changed between handler entry and commit.
Mitigation: assert the leaf id is unchanged before returning; refuse to continue if it changed.
Test: `boundary-handler-cannot-navigate`.

### Class 12 - Extension reload and shutdown

**R12.1 Use-after-invalidate.**
Reload and session replacement invalidate the old runner; any captured ctx method then throws
(`dist/core/extensions/runner.js:482-492`; `dist/core/agent-session.js:1011-1022`). Async work that
outlives the handler (usage aggregation, a delayed write) will throw at an unpredictable point.
Detection: `This extension ctx is stale ...` in errors.
Mitigation: capture plain data before awaiting; never keep `ctx` in a closure; flush synchronously in
`session_shutdown`; make cleanup idempotent (`docs/extensions.md:377-379`).
Test: `stale-ctx-after-reload-throws-and-is-caught`.

**R12.2 Quit ordering asymmetry.**
On `/new`, `/resume`, `/fork`, `teardownCurrent` awaits `session.abort()` *before* emitting
`session_shutdown` (`dist/core/agent-session-runtime.js:102-113`), so `agent_settled{aborted:true}`
arrives first. On quit, `dispose()` emits `session_shutdown` first and only then aborts and
invalidates (`dist/core/agent-session-runtime.js:296-303`;
`dist/core/agent-session.js:1011-1022`), so the settled event can arrive after the flush and after
invalidation.
Detection: last transition missing on disk after quit; stale-ctx error during quit.
Mitigation: `session_shutdown` is the only durability point; write the final snapshot there and make
`agent_settled` best-effort. Test: `quit-flushes-state-before-invalidate`.

**R12.3 Duplicate timers/listeners across reload.**
Anything registered outside the current runtime (module-level interval, global listener) survives the
runtime swap and doubles continuations.
Detection: two continuations per step after `/reload`; timer count > 1.
Mitigation: instance-scoped state only; `session_shutdown` clears every timer and listener; a
`started` latch per runtime generation. Test: `reload-clears-old-scheduler`.

### Class 13 - API compatibility (1.4.0-specific)

**R13.1 Boundary semantics are new and can change.**
`agent_before_settle` and the `BoundaryState`/`BoundaryResult` shapes exist in 1.4.0
(`dist/core/extensions/types.d.ts:786-808`) with subtleties that are easy to depend on accidentally:
the cumulative `continue` flag, the `canContinue` guard, `outcome` never being `aborted`, drafts
committed after all handlers. Any of these can change in a minor release without a type break.
Detection: an executable contract test that asserts the semantics the extension relies on.
Mitigation: narrow adapter layer; version guard `>=1.4.0 <2.0.0` (precedent:
`/home/nacho/.pi/agent/extensions/subagents/src/config/host-compatibility.ts:1-12`); drift tests
(`/home/nacho/.pi/agent/extensions/subagents/src/core/pi-api-drift.test.ts`). Test: `pi-api-drift-guard`.

**R13.2 Draft and entry variants.**
`SessionBoundaryDraft` is a union of `custom`, `custom_message`, `context_edit`, `compaction`
(`dist/core/extensions/types.d.ts:752-778`). Adding a variant is non-breaking for TS but the
extension's `switch` must have a default that fails closed. Test: `boundary-draft-contract`.

**R13.3 Tool activation changes.**
1.4.0 fixed resumed sessions and `/tree` leaving extension tools inactive when the branch recorded
its loadout before registration (`CHANGELOG.md:44`, #11062). A goal's tools must be verified active
after `session_start`, not assumed.
Detection: `pi.getActiveTools()` missing the goal tools after resume/tree.
Mitigation: assert at `session_start`; re-activate explicitly with `pi.setActiveTools()`
(`dist/core/extensions/types.d.ts:1291`). Test: `goal-tools-active-after-resume`.

**R13.4 No extension-facing totals API.**
`ExtensionContext.sessionManager` is a `ReadonlySessionManager` restricted to a fixed `Pick<>`
(`dist/core/session-manager.d.ts:178`) containing `getEntries`, `getBranch`, `getEntry`,
`buildSessionProjection`, `getHeader`, ids - and **not** `getSessionStats`. `getSessionStats` lives on
`AgentSession` (`dist/core/agent-session.d.ts:892`) and is not reachable from a handler.
Any design that assumes "ask Pi for the total" does not exist and must not be invented.
Detection: impossible to compile; call it out in review.
Mitigation: derive totals from `getEntries()` exactly as `getSessionStats` does
(`dist/core/agent-session.js:3445-3497`), deduping by entry id.
Test: `usage-derived-from-entries-matches-pi`.

---

## 3. Hard invariants our design must enforce

1. **One continuation site.** Exactly one of `turn_end` or `agent_before_settle` may request
   continuation; the other, if registered at all, is observation-only.
2. **One continuation per boundary key.** A boundary key is the id of the last entry on the branch at
   decision time; the same key may never produce a second model request.
3. **No continuation without a model-visible directive.** Before returning `continue` at
   `agent_before_settle`, the decision must include a draft that makes the final projected message
   non-`assistant` (checked against `event.context.canContinue`).
4. **The goal directive is re-established on every continuation**, never assumed to survive
   compaction, summarization, or a cut.
5. **`aborted` is authoritative.** `agent_settled{aborted:true}`, a terminal `error` outcome, or a
   manual compaction/abort transitions the goal to `paused`; only an explicit user action resumes it.
6. **The session entry is the only durable state.** No external file, no in-memory-only truth; one
   versioned `custom` entry per transition; loading never throws.
7. **State is branch-scoped and generation-stamped.** Every read is from
   `ctx.sessionManager.getBranch()`; every write carries `goalId`, `generation`, and `sessionId`;
   stale generations are ignored, never applied.
8. **New sessions never inherit `active`.** `session_start` with reason `fork`, `new`, or `resume`
   restores `paused`; a forked/cloned goal cannot run twice.
9. **Bounded work.** Hard caps on steps, wall clock, and tokens, checked before every request, plus a
   consecutive-no-progress cap; caps end in `limited` with a wrap-up turn, not a silent stop.
10. **Account once per entry id, on `totalTokens`.** Dedupe by source entry id; include compaction,
    cache-warm, and nested-tool usage; never recompute cost.
11. **Pi owns retries, compaction, and overflow recovery.** The extension never retries a provider
    error and never compacts on an error path.
12. **Boundary handlers are pure decision points.** No navigation, no session replacement, no reload,
    no long-running awaits; no `ctx` retained after the handler returns.
13. **Durability happens in `session_shutdown`.** Idempotent, synchronous flush; `agent_settled` is
    best-effort, never the only writer.
14. **Single writer.** All goal mutations go through one serialized code path; tools and commands pass
    through it with their goal id and generation.

---

## 4. Tests we must write

### R1 - duplicates
- `both-sites-configured-still-yields-one-request`: given a goal with both `turn_end` and
  `agent_before_settle` registered, when one step completes, then exactly one `agent_start` occurs
  per step.
- `two-handlers-same-boundary-yield-one-step`: given two continuation handlers, when the boundary
  fires, then one request occurs and one directive entry is active.
- `abort-after-boundary-does-not-advance-step`: given a boundary that returned `continue`, when
  Escape lands before `agent.continue()`, then the step counter is unchanged and the goal is paused.

### R2 - interrupts
- `escape-pauses-goal-until-explicit-resume`: given an active goal, when `agent_settled{aborted:true}`
  arrives, then status is `paused` and no continuation happens on the next user run.
- `abort-during-boundary-leaves-goal-paused`: given an abort during a boundary handler, when the run
  settles, then the goal is paused even though the handler returned `continue`.
- `before-settle-never-reports-aborted`: given aborted runs, when boundaries fire, then `outcome` is
  never `"aborted"` (documents the Pi behavior the design relies on).

### R3 - terminal states and stale ids
- `pause-between-turns-wins-over-stale-boundary`: given a pause applied after the last turn, when the
  boundary fires, then no continuation is requested.
- `late-tool-result-for-old-goal-is-rejected`: given goal 7 cleared and goal 8 created, when goal 7's
  tool result arrives, then goal 8 is unchanged and the tool reports an error.
- `user-run-does-not-count-as-goal-step`: given an active goal, when the user asks an unrelated
  question, then the goal step count is unchanged.

### R4 - persistence
- `single-entry-snapshot-is-atomic`: given a transition, when it is persisted, then exactly one
  `custom` entry contains the complete snapshot.
- `truncated-last-line-recovers-previous-snapshot`: given a session file whose last line is truncated,
  when the goal loads, then the previous snapshot is restored and no error is raised.
- `goal-before-first-message-is-not-durable`: given a goal created before any conversation, when the
  session is closed, then the goal is not reported as durable.
- `unknown-schema-version-loads-as-no-goal`: given a snapshot with `version: 99`, when the goal loads,
  then no goal is active and a notice is shown.
- `append-failure-leaves-previous-state`: given an append that throws, when a transition is attempted,
  then status and counters stay at the previous values.

### R5 - session semantics
- `clone-of-active-goal-starts-paused`: given an active goal, when `/clone` runs, then the new session
  has the goal `paused` and the old session keeps running.
- `tree-rewind-restores-older-generation`: given snapshots g1 then g2, when `/tree` rewinds to before
  g2, then the goal is `paused` and g2 is not applied.
- `resume-does-not-auto-continue`: given a session whose last snapshot is `active`, when it is
  resumed, then no request is issued before an explicit resume.
- `reload-twice-yields-one-scheduler`: given two `/reload`s, when the next boundary fires, then one
  continuation occurs and no old timer remains.

### R6 - compaction
- `compaction-hides-snapshot-from-context-but-not-branch`: given a compaction after the snapshot,
  when the boundary is built, then the snapshot is absent from `contextEntries` and present in
  `getBranch()`.
- `post-compaction-continuation-still-contains-objective`: given a compaction that summarized the
  directive, when the goal continues, then the next request contains the objective text.
- `invalid-first-kept-id-is-rejected`: given a custom compaction whose `firstKeptEntryId` is not on
  the branch, when it is applied, then the extension refuses and lets Pi compact normally.

### R7 - accounting
- `same-message-observed-twice-counts-once`: given both `message_end` and the session entry for one
  assistant message, when usage is totaled, then it is counted once.
- `cache-heavy-turn-matches-total-tokens`: given `input=10, cacheRead=1000, output=50`, when the turn
  is accounted, then tokens are 1060 and cost equals `usage.cost.total`.
- `all-usage-sources-reconcile-with-session-stats`: given a span containing a compaction, a cache-warm
  usage entry, a nested tool call, and assistant turns, when summed, then it equals Pi's
  `getSessionStats()` for the same span.
- `abandoned-branch-usage-not-charged-to-new-branch`: given work on branch A, when `/tree` moves to
  branch B, then branch-scoped usage excludes A while billed totals include it.
- `budget-stop-happens-before-next-request`: given a cap that would be exceeded by another turn, when
  the boundary fires, then no request is issued after the cap.

### R8 - provider errors
- `transient-error-is-not-retried-by-extension`: given a 529 that Pi retries, when the retry succeeds,
  then the extension issued no request of its own.
- `auth-error-pauses-goal`: given a 401 outcome `error`, when the boundary fires, then the goal is
  paused and no continuation is requested.
- `overflow-is-not-compacted-twice`: given a context-overflow recovery, when compaction runs, then
  exactly one compaction entry is appended.
- `length-stop-does-not-count-as-progress`: given a length stop with no successful tool results, when
  progress is evaluated, then the no-progress counter increments.

### R9 - external processes
- `goal-waits-for-background-terminal`: given a running background terminal, when the boundary fires,
  then the goal does not continue.
- `goal-does-not-continue-while-child-runs`: given a running subagent, when the boundary fires, then
  the goal does not continue.
- `aborted-mutation-blocks-continuation`: given an aborted mutating tool, when the goal would
  continue, then it pauses and asks for verification.

### R10 - loops and cost
- `hard-step-cap-stops-continuation`: given `maxSteps=2`, when step 3 would start, then status is
  `limited` and one wrap-up turn runs.
- `repeated-polling-before-threshold-continues`: given two identical poll turns, when the threshold is
  three, then the goal continues.
- `continue-without-runnable-context-is-downgraded`: given assistant-last context, when the handler
  returns `continue`, then it appends a directive draft instead of failing the guard.
- `boundary-handler-throw-pauses-goal`: given a handler exception, when the run settles, then status
  is `paused` with the error recorded.

### R11 - interference
- `user-steer-pauses-or-absorbs-into-goal`: given a user steer message, when the boundary fires, then
  the goal pauses or records the message as part of the goal.
- `foreign-continue-is-not-counted-as-goal-step`: given another extension returns `continue`, when the
  boundary fires, then the agent continues and the goal's step counter is unchanged.
- `goal-works-regardless-of-handler-order`: given the goal handler registered before and after a
  neutral extension, then behavior is identical.
- `boundary-handler-cannot-navigate`: given a boundary handler that attempts `navigateTree`, then the
  goal refuses to continue and reports the changed leaf.

### R12 - reload and shutdown
- `stale-ctx-after-reload-throws-and-is-caught`: given a captured ctx from the old runtime, when it is
  used after reload, then the error is caught and no state is written.
- `quit-flushes-state-before-invalidate`: given a quit with a pending transition, when
  `session_shutdown` runs, then the transition is on disk.
- `reload-clears-old-scheduler`: given one `/reload`, when the next boundary fires, then exactly one
  continuation occurs.

### R13 - compatibility
- `pi-api-drift-guard`: given the installed Pi, when the suite runs, then the events, payload fields,
  draft variants, and `ReadonlySessionManager` methods the extension uses all exist with the expected
  shapes.
- `boundary-draft-contract`: given the four draft variants, when each is applied, then the resulting
  projection matches expectations and unknown variants fail closed.
- `goal-tools-active-after-resume`: given a resumed session and a `/tree` navigation, when the goal
  runs, then its tools are in `pi.getActiveTools()`.
- `usage-derived-from-entries-matches-pi`: given a recorded span, when the extension's derivation runs
  on `getEntries()`, then it equals `getSessionStats()` for that span.

---

## 5. Unresolvable or partially resolvable risks

1. **`outcome:"aborted"` cannot be relied on at `agent_before_settle`** (R2.3). The loop short-circuits
   before the boundary when an abort is requested (`dist/core/agent-session.js:1457`), so the state is
   practically unreachable. Partially resolvable: use `agent_settled{aborted}`, but the *reason* for
   the abort (Escape vs `/compact` vs session replacement) is not carried by that event
   (`dist/core/extensions/types.d.ts:801-808`). Only heuristics remain: `session_shutdown{reason}`
   identifies session replacement (`dist/core/extensions/types.d.ts:637-645`), and a later
   `session_compact{reason:"manual"}` (`dist/core/extensions/types.d.ts:612-622`) identifies a manual
   compaction. Plain Escape leaves no distinguishing signal.

2. **A boundary handler cannot observe an in-flight abort.** At the boundary, `agent.activeRun` is
   already cleared, so `ctx.signal` is `undefined`
   (`node_modules/@earendil-works/pi-agent-core/dist/agent.js:217-221`, `node_modules/@earendil-works/pi-agent-core/dist/agent.js:385-392`). Pi honors
   `_abortDuringBeforeSettle` only after the handler returns
   (`dist/core/agent-session.js:1576-1577`). Work started inside the handler cannot be cancelled by
   the user, and the handler cannot know it will be discarded.

3. **Guaranteeing the objective survives compaction is only possible by re-injecting it.** Pi offers
   no "pin this entry across compaction" API. `session_before_compact` can cancel or supply a
   replacement compaction (`dist/core/extensions/types.d.ts:1137-1140`), but a `custom` entry is never
   model-visible (`dist/core/session-manager.js:163-166`) and a `custom_message` is summarized like
   any user text (`dist/core/compaction/compaction.js:515-524`). Cancelling compaction indefinitely is
   not viable: context overflow then fails the run. The residual risk is that re-injection itself
   becomes wrong if a compaction lands *between* the decision and the request; Pi commits drafts
   before the request (`dist/core/agent-session.js:1573`), which narrows but does not eliminate the window.

4. **A forked or cloned session cannot be prevented from inheriting goal state.** The extension can
   react to `session_start{reason:"fork"}` (`dist/core/extensions/types.d.ts:575-583`), but it cannot
   prevent `createBranchedSession` from copying the entries
   (`dist/core/session-manager.js:1205-1305`). It also cannot cancel a fork: `session_before_fork`
   supports `cancel` (`dist/core/extensions/types.d.ts:1133-1136`), but cancelling every fork is
   hostile. Residual: two sessions exist, only one may run; the other is paused by convention.

5. **Exact billing parity is not guaranteeable for failed attempts.** A failed assistant attempt is
   persisted (`dist/core/agent-session.js:755-770`), `_omitRecoveryAttempt` only adds a
   `context_edit` and keeps the entry (`dist/core/agent-session.js:843-870`). HTTP-level retries also
   happen inside Pi's provider layer before any assistant message exists: the SDK client is created
   with `maxRetries: 0` and the request is retried by `retryProviderRequest`
   (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:195-201`). Any tokens such a
   failed attempt consumes never reach an `AssistantMessage`, so no extension can see them. The
   extension can only reconcile with what Pi records.

6. **`/tree` accounting is inherently ambiguous.** `getEntries()` includes abandoned branches
   (`dist/core/session-manager.js:1107-1109`), so "spent on this goal" and "spent in this session
   file" diverge after any rewind. Both numbers are defensible; the design must pick one for the hard
   budget and say so. There is no Pi API that attributes usage per branch.

7. **Reload cache behavior is unverified.** Whether `/reload` re-evaluates the extension module
   (and thus resets module-level state) depends on the loader cache token
   (`dist/core/extensions/loader.js:459-468`). Settle it with a two-reload integration test; until
   then, treat module-level state as persistent and forbidden.

8. **`/compact` and `/tree` from outside the TUI can abort a goal.** `compact()` calls
   `await this.abort()` first (`dist/core/agent-session.js:2230-2231`), so a manual compaction aborts
   the run and produces `agent_settled{aborted:true}`. `compaction_start` is an internal
   `AgentSession` event, not an `ExtensionAPI` event (`dist/core/agent-session.js:2233`;
   `dist/core/extensions/types.d.ts:1186-1406`), so the only extension-visible trace is a later
   `session_compact{reason:"manual"}` (`dist/core/extensions/types.d.ts:612-622`). The goal cannot
   distinguish "user wants a summary" from "user wants to stop" at the moment it must decide. This is
   a design limitation of the available signals, not a bug that tests can remove.
