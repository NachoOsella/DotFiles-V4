# F6. Adversarial audit: safety, runaway loops, cost, and coverage

Audit snapshot: 2026-10-31 17:24 local. The implementation was still being modified while this audit ran
(`src/runtime.ts` 17:16, `test/runtime.test.ts` 17:16); line numbers refer to the hashes in Appendix A.
Read-only audit: no source, test, or doc file was changed except this report.

Scope: `src/**/*.ts` (4,134 LOC), `test/**/*.ts`, `README.md`, `docs/ARCHITECTURE.md`,
`docs/LIMITATIONS.md`, `docs/research/F-risk-matrix.md` (R9-R13). Nothing was executed against a live
provider; engine and adapter behavior was probed with the project's own fake session and host
(`/tmp/f6/probe*.ts`), and the full suite was run (`246 tests, 16 suites, 0 failures`).

## Verdict

**Not ready for unattended use.** The core is well built: one continuation site (`agent_before_settle`
with a draft), state derived from the branch instead of counters, versioned snapshots, typed
transitions, a serialized engine, and 246 passing tests. Three control gaps are nevertheless serious:

1. the model can start a goal without user authorization and reset the runaway cap by completing and
   recreating one (F6-01, critical),
2. a user message after the last directive does not stop the loop (F6-02, high),
3. there is no default token budget, no wall-clock cap, and the only hard cap is a model-resettable
   200-turn counter, so per-goal cost is unbounded (F6-05, high).

Add the active-stall failure path (F6-04, high) and the audit verdict is: safe for supervised,
interactive use; not safe as an unattended agent.

## 1. Findings

Severity: critical means "model or injected text can cause unbounded spend or run without consent";
high means "user intent or recovery is broken"; medium means "a guard can be defeated or misleads the
operator"; low means "correctness, hygiene, or documentation".

| ID | Sev | Area | file:line | Problem | Impact | Fix | Test to add |
|---|---|---|---|---|---|---|---|
| F6-01 | critical | Authorization / runaway | `src/adapters/pi-tools.ts:148-166`; `src/services/goal-controller.ts:723-731`; `src/domain/transitions.ts:512-520` | `create_goal` has no user authorization and is legal whenever the current goal is `complete`. Verified by probe: tool-only create with no user turn yields `continue: true`; `complete` then `create_goal` produces revision 1 and `turn: 2`, so the cap restarts. The model also picks `token_budget` (no maximum). | A prompt injection or a misbehaving model can start and indefinitely renew an autonomous loop. The 200-turn cap and any per-goal accounting reset on every recreate. | Require explicit user confirmation for `create_goal` when no goal exists (as `update_goal paused` already does), or only allow it in a turn that opened with an explicit `/goal`; count goal creations per session as a guard; cap `token_budget`; hide `create_goal` when no goal exists unless the user asked for one. | `create_goal_without_user_request_is_rejected`; `complete_then_create_does_not_reset_runaway_guard` |
| F6-02 | high | User control | `src/services/continuation-policy.ts:63-164` (no user branch; default at `:159-163`) | The policy never inspects user messages after the last directive. Verified: user "stop working on the goal, do something else" plus assistant reply still yields `continue: true`. | The continuation directive is appended after the user's instruction, so the newest user-role text tells the model to keep going. R11.1 (high/high) is unmitigated. | If a `user` message exists after the newest goal directive, transition to `paused(user)` and require an explicit resume, or record that the user message was incorporated before continuing. | `user_message_after_last_directive_pauses_goal` |
| F6-03 | medium | Recovery | `src/services/continuation-policy.ts:143-156`; `src/domain/transitions.ts:585-595`; `src/adapters/pi-commands.ts:132-175` | The turn cap is persisted as the `budget-exhausted` transition. For an unbudgeted goal, `resume` then rejects with "raise the budget first", while the stop notice says "Raise the cap" and no command changes `maxGoalTurns` (env only, read at load: `src/runtime.ts:40-46`). Verified at transition level. | A capped goal with no budget is recoverable only through the undocumented `/goal budget off` (or a budget above current usage). The stated remedy is impossible. | Use a distinct `paused(turn-cap)` reason that `resume` clears and that resets `turnBaseline`, or name the exact command in the notice and add `/goal turns <n>`. | `turn_cap_is_resumable_without_a_budget` |
| F6-04 | high | Failure recovery | `src/adapters/pi-events.ts:113-116`; `src/runtime.ts:95-112`; `src/domain/goal.ts:51-58` | Any engine failure at the boundary is notified and then `undefined` is returned. Status stays `active`. The `internal-error` pause reason exists but is never used (grep: only the enum). | R10.4: the goal claims to be active while nothing continues. A persistent failure (for example `appendEntry` always throwing) strands the goal until the user clears it; a transient one silently spends a turn. | On failure, attempt a best-effort `pause(internal-error)` transition, then notify. If the pause cannot persist, surface that explicitly. Never leave `active` with no request after a caught error. | `boundary_engine_failure_pauses_goal_instead_of_leaving_active` |
| F6-05 | high | Cost / runaway | `src/domain/goal.ts:26-30`; `src/runtime.ts:28-29`; `src/services/usage-accounting.ts:52-54`; `src/services/continuation-policy.ts:116-157` | No default token budget (`/goal` creates with `budgetTokens: null`, `src/adapters/pi-commands.ts:84-88`), no wall-clock cap (`activeMs` is tracked and displayed but never compared to a limit), and the only hard cap is 200 goal turns. Cost inside one turn is unbounded, and `cacheRead` is never charged. | 200 turns times arbitrary per-turn cost. A read-only loop resets the idle breaker with one `read` per turn and runs to the cap. Cache-heavy turns evade the token budget. This is the exact R10.1 scenario. | Default token budget (Codex defaults to a configured maximum), a wall-clock cap on `activeMs`, and a per-turn delta cap. Charge a fraction of `cacheRead` or cap `allTokens` as a secondary limit. | `read_only_loop_stops_at_wall_clock_cap`; `default_budget_bounds_a_goal` |
| F6-06 | medium | Cost accounting | `src/services/usage-accounting.ts:120-126` | A usage object missing any of `input`/`output`/`cacheRead`/`cacheWrite` is ignored entirely. Verified: `{totalTokens:1000}` and `{cost:{total:1}}` both charge 0. | A custom provider or proxy that reports only `totalTokens`, or omits usage on some messages, makes `tokensUsed` stay 0 and the budget never trips. | Fall back to `totalTokens`, then `cost.total`; track "usage unknown" turns and pause or warn after a threshold. | `total_tokens_only_usage_is_charged`; `missing_usage_pauses_after_threshold` |
| F6-07 | medium | Secrets / info leak | `src/runtime.ts:53-64`; `src/adapters/pi-tools.ts:111-119`; `src/domain/goal.ts:110-117`; `src/adapters/pi-ui.ts:95-110` | Defects are rendered with `Cause.pretty` into text that reaches the model as a tool error. Verified after dispose: `Goal decision failed ... Error: ManagedRuntime disposed` plus a stack and absolute paths. Provider error text is stored verbatim in `pause.detail` and printed by `/goal status` and `/goal debug`. | Local paths and Effect internals leak to the model; provider error text (request IDs, org identifiers) is persisted in the session file and shown. | One-line redacted error for model-facing results; truncate `pause.detail` (for example 200 chars); keep stacks in a debug-only path. | `engine_error_text_has_no_stack_or_paths` |
| F6-08 | medium | Compaction | `src/adapters/pi-events.ts:84` and `:109`; `src/services/continuation-policy.ts:71-74`; `src/runtime.ts:140-152` | `manualCompaction` is hardcoded `false` at both call sites, so the policy branch is unreachable. Recovery relies on `session_before_compact` arriving within 5 seconds after `agent_settled`. | If Pi's ordering differs, a manual `/compact` pauses the goal incorrectly. If a user Escape happens less than 5 seconds before an unrelated `/compact`, the intended stop is undone. | Pass the real signal or delete the dead branch; verify the order in Pi source and cover it; do not infer a manual compaction from a time window alone. | `manual_compaction_before_settle_keeps_goal_active`; `interrupt_then_compaction_after_window_stays_paused` |
| F6-09 | low | Progress | `src/adapters/pi-events.ts:25-30`; `src/services/progress-tracker.ts:111-124` | Only `stopReason: "error"` is special. A `length`-stopped turn counts any successful tool result as evidence; `currentTurnMutated` is computed but never used by a gate. | A model that keeps truncating output can loop with partial work (R8.4). | Treat `length` as no-progress unless a mutation tool succeeded, and surface it. | `length_stop_does_not_count_as_progress` |
| F6-10 | medium | External work | no source reference; `src/` has no `pi.events` use | A background terminal or running child agent started in a turn does not block the next continuation; the tool result counts as evidence. | Duplicate and concurrent work, conflicting edits. R9.1 and R9.2 are unmitigated. | Treat job/handle tool results as a wait state until a matching status/result arrives; document that delegation must be awaited; subscribe to a bus event if the owning extension publishes one. | `goal_does_not_continue_while_background_handle_is_open` |
| F6-11 | low | Dedupe | `src/services/continuation-policy.ts:106-114`; `src/services/goal-controller.ts:207-219` | Dedupe uses `directivePending`, which requires the directive to be the last entry on `getBranch()`. Drafts exist only in `event.entries` while the handler runs. `trailingDirective` is exported but unused. A same-settle re-dispatch or a later handler replacing `entries` is invisible. | One extra paid turn if Pi re-dispatches the boundary or another extension rewrites the draft array. The documented "can never continue twice" invariant is weaker than stated. | Feed `event.entries` and `event.continue` into the decision; key dedupe by `(assistantEntryId, goalId, turn)`; delete or use `trailingDirective`. | `same_settle_redispatch_with_drafts_yields_one_turn` |
| F6-12 | low | Time accounting | `src/services/goal-controller.ts:780-800` and `:481` | Completion adds in-flight elapsed through `touch`; `settle` skips its touch only when the status is already `complete`. If the completion transition fails after the touch, the run is charged again at settle. | Inflated `timeUsedSeconds` in reports. No current cap depends on it, so impact is cosmetic today. | Track the persisted delta and subtract it from the run start, or key time charges by run id. | `failed_complete_after_touch_does_not_double_count_time` |
| F6-13 | low | Storage / PII | `src/domain/transitions.ts:44,471`; `src/services/goal-repository.ts:141-148`; `src/adapters/pi-commands.ts:248` | Every transition appends a full snapshot containing the objective and up to 40 history entries. `/goal debug` truncates JSON at 3500 chars mid-object. | Session growth is O(transitions) with many copies of a possibly sensitive objective in shared session files; debug output is not valid JSON. | Store a delta or bound the snapshot; redact the objective in user-facing dumps; print a summary plus a file path. | `long_goal_session_growth_is_bounded` |
| F6-14 | low | Documentation | `docs/LIMITATIONS.md:138-139` | "No adapter tests" is false: `test/adapter-commands.test.ts`, `adapter-tools.test.ts`, `adapter-events.test.ts` cover commands, tools, events, pause confirmation, and UI. | Reviewers and future agents mis-scope work, and audit inputs are stale. | Update the list and keep it aligned with the suite. | none (doc fix) |
| F6-15 | low | Prompt injection | `src/prompts/continuation.ts:144-151` vs `:47-52` | `buildKickoffPrompt` JSON-quotes the objective inside `<codex_internal_context>` without escaping `<` or `>`, unlike `escapeObjective`. | An objective containing `</codex_internal_context>` can close the wrapper and inject text into the first directive (user or model sourced). | Escape angle brackets before quoting, or strip the closing token. | `kickoff_objective_cannot_close_internal_context` |

## 2. Loop and cost matrix

Every path that can cause a model request or bill tokens, its guard, and whether an adversary
(model, injected text, or an unusual provider) can defeat the guard.

| # | Loop path | Guard(s) in code | Defeatable? |
|---|---|---|---|
| L1 | Boundary continuation (`agent_before_settle` to `continue: true`) | `status === active`; duplicate-anchor check; idle breaker (3); budget; turn cap (200) | **Yes.** A `read` per turn resets the idle breaker (`progress-tracker.ts:111-124`); no budget by default; the cap resets on complete then create (F6-01); user messages are ignored (F6-02). |
| L2 | Kickoff from `/goal <objective>` | `ctx.isIdle()`, unfinished-goal conflict, objective and budget validation | No. This is the only user-authorized starter. |
| L3 | Kickoff from `create_goal` | Unfinished-goal conflict only; no authorization, no confirmation | **Yes.** Model or injected text can start a goal (F6-01). |
| L4 | Resume via `/goal resume` | User-only; budget check for `budgetLimited` | No model path, but turn-cap resume is broken (F6-03). |
| L5 | Budget wrap-up turn | `wrapupCount` derived from directives on the branch | Mostly. A `/tree` rewind that removes the wrap-up directive buys another wrap-up turn (user action). |
| L6 | No-progress pause | `idleTurns >= maxIdleTurns` (default 3) | **Yes, cheaply.** One successful non-goal tool result per turn (including `read`, `grep`, `ls`) resets it; cost then runs to the turn cap. |
| L7 | Completion | `currentTurnEvidence > 0`; rejects a second complete | **Weak.** A single successful `read` is enough evidence; then `create_goal` restarts a fresh goal (F6-01). |
| L8 | Repeated `update_goal(complete)` | Transition rejects when already complete | No loop by itself; each attempt is a tool error, not a model request. |
| L9 | Repeated `/goal edit` | User-only, idle check; each edit sends an `objective-updated` directive with `triggerTurn` | User-driven only; there is no rate limit, so a script can spend one turn per edit. |
| L10 | Raising the budget | User-only; auto-resume when the new budget exceeds usage | User-driven only. |
| L11 | Foreign extension `continue` | None; Pi's continuation flag is shared | **Yes.** Another extension can keep the session running; the goal will also continue at the next boundary (R11.2). |
| L12 | Background job or child agent | None (no registry, no `pi.events` use) | **Yes.** Continuation starts while external work runs (F6-10). |
| L13 | Provider retry | Pi retries internally; the extension pauses on a terminal error | No extension-side retry; this is correct (R8.1). |

## 3. Cost accounting under attack

Charge definition: `input + cacheWrite + output` (`src/services/usage-accounting.ts:52-54`), derived from
the branch after `usageStartEntryId`, deduped by entry id (`:70-78`).

| Attack | Result | Evidence |
|---|---|---|
| (a) Cached reads only | Charge is ~0 while the provider still bills cache reads and wall clock grows. The budget is a billed-token cap, not a cost cap. | `:52-54`, test "cache reads are not charged against the budget"; documented in `docs/LIMITATIONS.md:125-128`. |
| (b) Nested or tool usage | Counted from `toolResult` message usage (`:85-94`). Whether Pi also folds nested usage into the parent assistant message is **UNVERIFIED**; if it does, this double counts. | `:92-93`; ARCHITECTURE `:119-124` claims both are additive. |
| (c) Usage on error or aborted messages | Counted when the usage object is complete, which is correct because the provider billed it. Aborted or failed attempts without a usage object are not counted. | `:73-78`, `:120-126`. |
| (d) Provider reports zero, partial, or missing usage | Charged 0. `isUsageSnapshot` requires all four numeric buckets; `{totalTokens}` and `{cost}` alone are ignored (probe). The budget can never trip; only the turn cap applies. | `:120-126`; probe output in Appendix B. |
| (e) Budget timing | Checked only at the boundary, so the last request can overshoot by a full turn. Documented. | `continuation-policy.ts:125-141`; `docs/LIMITATIONS.md:91-100`. |
| (f) Token budget chosen by the model | `create_goal` accepts any positive integer, and the model can set it; there is no maximum. | `pi-tools.ts:39-45`; `transitions.ts:848-857`; `docs/LIMITATIONS.md:125-126`. |

## 4. Provider and long-process behavior

| Situation | Current behavior | Gap |
|---|---|---|
| Rate or usage limit | Boundary classifies the error text and transitions to `usageLimited`; no retry; `/goal resume` is required. | None for safety. Classification is regex-only and tested from strings, not live errors. |
| Auth error | `paused(provider-error)` with the text in `pause.detail`. | Detail persistence and display (F6-07). |
| Context overflow | Pi retries and compacts inside the provider layer; the extension only observes final usage and never compacts. | No test; overflow-recovery ordering with the boundary is UNVERIFIED. Charging of discarded attempts depends on Pi recording them. |
| `stopReason: "length"` | Treated as a completed turn; tool results count as progress. | F6-09. |
| Background terminal running | No awareness; the next boundary continues. The handle result counts as evidence. | F6-10. |
| Child agent still running | No awareness; completion can arrive later as a message and interleave. | F6-10. |
| Manual `/compact` | Aborts the run, pauses via `agent_settled`, then `session_before_compact` clears the pause within 5 seconds. | F6-08 (ordering and window). |
| Quit or reload | Every transition persists when it happens; `session_shutdown` disposes the Effect runtime. | A settle racing shutdown can be lost; after dispose, calls fail with a stack (probe) but Pi loads a fresh runtime on replacement. |

## 5. Secrets and PII

- **Model-visible:** tool error text on engine defects includes `Cause.pretty`, stack frames, and
  absolute paths (`src/runtime.ts:53-64`, probe). No environment values, prompts, or command output are
  logged by the extension.
- **Persisted:** the objective (up to 4000 chars) in every snapshot; provider error text in
  `pause.detail`; block evidence strings supplied by the model (`src/domain/goal.ts:110-126`). All land
  in the session JSONL, which users commonly share in bug reports.
- **Rendered:** `/goal status` prints the full objective, pause detail, and block evidence; the widget
  and status line truncate the objective (`pi-ui.ts:46-59`, `:93-117`). `/goal debug` adds `sessionId`,
  `leafId`, and the whole snapshot, truncated at 3500 chars.
- No `console.*`, file writes, `exec`, or env dump exists in `src/` (grep).

## 6. Failure recovery

| Failure | State left behind | Stranded? |
|---|---|---|
| Corrupt or unknown snapshot | Newer bad entries are skipped; the newest valid snapshot loads; if none exists the goal disappears and the message still says an older valid one was restored (`pi-events.ts:51-58`, `goal-repository.ts:92-114`). | No, but the notice is misleading when no valid entry existed. |
| `appendEntry` throws during a boundary transition | `decideBoundary` returns `stopped` with "state update failed" and the goal stays `active`; the next boundary retries. | Yes if permanent (F6-04). |
| `appendEntry` throws during a tool call | Tool returns an error result; state unchanged. | No. |
| Exception anywhere in the boundary handler | Caught by `runtime.run`; notice only; `active` with no continuation. | Yes (F6-04). |
| Runtime disposed while the session continues | Every engine call fails with a stack; boundary returns `undefined`; goal stays `active`. | Yes, but Pi normally replaces the runtime. |
| Abort between decision and request | `agent_settled{aborted}` pauses the goal; the next boundary sees `inactive` and stays settled. | No. |
| Restart or reload with an active goal | Restored active, no run started; next user message continues it. | Intentional and documented, but a user who returns for an unrelated question gets a goal continuation (see F6-02). |

## 7. Coverage against 21 scenario groups

The project brief with the numbered groups is not in the repo. The 21 groups below were reconstructed
from the task checklist, R1-R13 in `docs/research/F-risk-matrix.md`, and the invariants in
`docs/ARCHITECTURE.md`/`docs/LIMITATIONS.md`. Mapping is by test name.

| # | Scenario group | Test(s) that cover it | Gap |
|---|---|---|---|
| G1 | Duplicate continuation at one boundary | `adapter-events`: "a second boundary anchored at the same assistant entry is deduped", "a new assistant entry lets the next boundary continue again"; `engine`: "an active goal continues once per boundary", "the same boundary never continues twice" | Same-settle re-dispatch and foreign entry replacement are untested (F6-11). |
| G2 | Interrupt (Escape) pauses | `adapter-events`: "agent_settled with aborted pauses the goal..."; `engine`: "an interrupt pauses..."; `continuation-policy`: "aborted outcome pauses..." | None. |
| G3 | Manual compaction vs interrupt | `adapter-events`: "manual compaction clears the interrupt pause, threshold compaction does not"; `engine`: "a manual compaction can undo the interrupt pause" | Only the intended order is covered; the adapter's hardcoded `manualCompaction: false` path is dead (F6-08). |
| G4 | User prompt mid-goal | none | **Full gap** (F6-02). |
| G5 | Provider usage limit | `continuation-policy`: "usage-limit error..."; `engine`: "provider usage limits map to usageLimited" | No live error; string classification only. |
| G6 | Auth or transient failure | `continuation-policy`: "auth error...", "transient 500..."; `engine`: "other provider errors pause..." | None functional. |
| G7 | Overflow and length stops | none | **Full gap** for both; length behavior is wrong by design (F6-09). |
| G8 | Budget crossing and wrap-up | `engine`: "a budgeted goal wraps up once and then stops"; `continuation-policy`: three budget tests | None. |
| G9 | Budget resume or raise | `engine`: "raising the budget resumes..."; `transitions`: five resume tests | Turn-cap recovery is untested and broken (F6-03). |
| G10 | Turn cap | `engine`: "the turn cap stops the loop with a wrap-up"; `continuation-policy`: both turn-cap tests | No test for resume or recovery (F6-03); no test that a read-only loop actually stops. |
| G11 | No-progress breaker | `engine`: "three idle turns...", "tool activity resets..."; `progress-tracker`: 15 tests | No test that `read`/`grep`/`ls` alone never trip it; no wall-clock or per-turn cost bound (F6-05). |
| G12 | Completion gate | `engine` and `adapter-tools`: "completion needs evidence..." | No repeated-complete test, no complete-then-create test, no test that one `read` suffices (F6-01, L7). |
| G13 | Blocked audit | `engine`: "blocked needs three...", "resuming a blocked goal resets..."; `transitions` | None. |
| G14 | Pause authorization | `adapter-tools`: "update_goal paused needs the user confirmation..."; `engine`: "pausing through the tool needs explicit authorization" | No non-UI (`-p`) case; `hasUI === false` path rejects, which is correct but untested end to end. |
| G15 | Fork protection | `adapter-events`: "session_start on a forked session pauses..."; `engine`: same | None. |
| G16 | Tree rewind | `engine`: "a tree rewind restores the snapshot on the active branch" | No test for a rewind that drops the goal entirely. |
| G17 | Restart and reload | `engine`: "a restarted engine derives the same state from the branch" | No adapter test asserting `session_start` does not continue; no resume-after-restart boundary test. |
| G18 | Compaction hides state | `engine`: "a goal survives compaction even when the snapshot leaves model context" | None functional. |
| G19 | Persistence corruption and failure | `goal-repository`: 8 tests; `engine`: "malformed snapshots are skipped..." | No test that a boundary-time persist failure leaves a recoverable state (F6-04). |
| G20 | Concurrency and late events | `engine`: "parallel mutations serialize", "usage is counted once per entry", "a late completion cannot attach to a cleared goal" | No foreign `continue` test, no handler-order test, no same-entry double dispatch (F6-11). |
| G21 | Background job or child agent | none | **Full gap** (F6-10). |

Coverage summary: 10 covered, 8 partial, 3 full gaps (G4, G7, G21). The suite is strong on the state
machine, persistence, and policy; it is weak exactly where an adversary operates: authorization,
user preemption, external work, and cost bounds.

## 8. Tests that cannot fail or assert implementation details

| Test | Problem |
|---|---|
| `test/engine.test.ts:938` `assert.equal(goalId.length > 0, true)` | Tautology after a successful create; it cannot fail unless the engine returns an empty string, which the schema already forbids. |
| `test/prompts.test.ts:114` `assert.equal(prompt.split("\n").length, 56)` | Brittle: any harmless wording change breaks the suite while behavior is unchanged. Keep the wrapper and escaping assertions, drop the line count. |
| `test/runtime.test.ts:70-73` "dispose is idempotent" | No assertion; it passes if `dispose` does nothing. Assert that a run after the second dispose fails with a controlled error rather than a defect. |
| `test/wiring-drift.test.ts:30` exact registration set | Intentional contract test, but it fails on any additive tool or event. Keep it as a drift guard and update it with the API, not with behavior. |
| `test/support/fake-host.test.ts`, `fake-session.test.ts` | Tests of the fakes. Legitimate, but they inflate the 246-test count; do not cite them as extension coverage. |

## 9. Highest-value tests to add

1. `user_message_after_last_directive_pauses_goal` (F6-02). Drive a normal continuation, then append a
   user message and an assistant reply, then assert the boundary returns `stopped` and the status is
   `paused`.
2. `create_goal_without_user_request_is_rejected` and
   `complete_then_create_does_not_reset_runaway_guard` (F6-01). Call `create_goal` from a tool context
   with no user turn and assert an error; then complete a goal, recreate, and assert the session-level
   creation counter or cap still applies.
3. `boundary_engine_failure_pauses_goal_instead_of_leaving_active` (F6-04). Inject an `appendEntry` that
   throws, drive `agent_before_settle`, and assert status `paused(internal-error)` and one notice.
4. `turn_cap_is_resumable_without_a_budget` (F6-03). Set `maxGoalTurns: 1`, drive to `budgetLimited`,
   then `/goal resume` and assert it succeeds (or that the notice names a working command).
5. `total_tokens_only_usage_is_charged` (F6-06). A boundary with one assistant message carrying
   `{totalTokens: 1000}` must charge 1000, and a goal with `budgetTokens: 500` must stop.

Also add, in descending value: `read_only_loop_stops_at_wall_clock_cap` (F6-05),
`goal_does_not_continue_while_background_handle_is_open` (F6-10),
`same_settle_redispatch_with_drafts_yields_one_turn` (F6-11),
`manual_compaction_before_settle_keeps_goal_active` (F6-08),
`engine_error_text_has_no_stack_or_paths` (F6-07).

## Appendix A: audited snapshot

`sha256` of the files cited here, taken at 17:24:

```
806df981...  src/domain/goal.ts
11bb77c5...  src/domain/transitions.ts
0f77d8b1...  src/services/continuation-policy.ts
b81ad2b7...  src/services/goal-controller.ts
61c41135...  src/services/usage-accounting.ts
975dea74...  src/services/progress-tracker.ts
778e7b13...  src/services/goal-repository.ts
c0b1d459...  src/runtime.ts
288e5fa4...  src/adapters/pi-tools.ts
b411343b...  src/adapters/pi-events.ts
2a77c80e...  src/adapters/pi-commands.ts
f4ea68c7...  src/adapters/pi-ui.ts
7f7a0aed...  src/prompts/continuation.ts
3590de31...  test/engine.test.ts
b082b175...  test/runtime.test.ts
```

Re-run `sha256sum src/**/*.ts test/*.test.ts` and compare before acting on a line number.

## Appendix B: probes

`/tmp/f6/probe.ts` (usage shapes, read-only evidence, turn-cap resume):

```
totalTokens-only: 0
cost-only: 0
no-usage: 0
full: 130
read-only turn evidence/idle: 0 1
after read evidence/idle: 1 0
resume after turn-cap, no budget: GoalRejectedError: cannot resume a goal whose token budget is exhausted; raise the budget first
```

`/tmp/f6/probe2.ts` (real adapters over the fake host):

```
snapshots after tool create: 1
status: active
boundary after unauthorized create: true continuation
complete isError: false
new goal status/revision: active 1
boundary after complete->create: true 2
boundary after user message: true
```

`/tmp/f6/probe3.ts` (dispose and model-visible errors):

```
boundary after dispose: [null]
notifications after dispose: [..., 'Goal decision failed; staying settled. Error: ManagedRuntime disposed\n    at cau...']
get_goal after dispose isError: true text: Error: ManagedRuntime disposed
    at causePrettyError (file:///home/nacho/dotfiles/pi/.pi/agent/node_modules/effect/dis...
```

Suite: `node --test --experimental-strip-types test/*.test.ts test/support/*.test.ts` reports
`tests 246, suites 16, pass 246, fail 0` on Node v26.13.0.
