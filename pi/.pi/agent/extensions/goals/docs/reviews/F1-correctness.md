# F1. Correctness audit: `pi-goals` implementation vs. the researched Codex runtime

Verdict: **SHIP WITH FIXES**. No critical defects. One high-severity defect remains (manual `/compact` can resume a goal that an unrelated interrupt paused). The rest are medium contract and gate gaps plus low reporting issues. The state machine, persistence, accounting, and boundary protocol are otherwise sound, the test suite is green at freeze (228/228), and both real end-to-end transcripts are internally consistent.

## 0. Audit snapshot and method

The implementation was edited during and after the audit (turn-cap semantics, evidence/activity split, budget config, create confirmation). Everything below cites one frozen copy; re-check before acting on a finding, and see section 7 for changes observed after the freeze.

- Freeze: `/tmp/goals-audit-173310` (copied from `/home/nacho/.pi/agent/extensions/goals` at 2026-10-31 17:33:10, `node_modules` symlinked). The live tree was identical to the freeze for the audited files at that moment; several files changed again afterwards (section 7).
- Hashes (sha256): `transitions.ts 11bb77c5…`, `goal-controller.ts 97183dac…`, `continuation-policy.ts 9248dec5…`, `progress-tracker.ts cc1c04a9…`, `usage-accounting.ts 59e85005…`, `pi-events.ts 74752ee2…`, `pi-tools.ts adaf2457…`, `pi-commands.ts 81222754…`, `runtime.ts e6c7109d…`, `prompts/budget-limit.ts 476b5527…`.
- Tests at freeze: `node --test --experimental-strip-types test/*.test.ts` -> 228 tests, 228 pass, 0 fail.
- Fixed during the audit and therefore excluded as findings: the turn cap now writes `paused(turn-cap)` and `/goal resume` grants a fresh allowance (was `budgetLimited` with a "raise the cap" notice); `/goal pause` on a non-pausable status reports the real status; the dead `manualCompaction` boundary flag was removed; a `failSafe` pause runs when the boundary decision itself fails.
- E2E transcripts predate the new `create_goal` confirmation and the budget ceiling; they are still valid evidence for continuation, accounting, and restart behavior.
- Ground truth: `docs/ARCHITECTURE.md`, `docs/LIMITATIONS.md`, `README.md`, reports A and B, the Pi runtime (`dist/core/agent-session.js`, `dist/core/extensions/runner.js`, `dist/core/session-manager.js`; `pi-agent-core/dist/agent-loop.js`), and `/tmp/goals-e2e2` + `/tmp/goals-e2e3`.
- Behavior probes: `/tmp/probe3.ts` against the freeze, `node --experimental-strip-types`.

Pi facts that pin the audit:

- `getBranch()` is a raw leaf-to-root walk (`dist/core/session-manager.js:1062-1072`); `buildContextEntries()` is the compaction-aware view (`:1077-1079`, `:194-230`). Snapshots and directives survive compaction for derivation even when they leave model context.
- `_runBeforeSettleBoundary` runs after the agent loop, commits drafts, then continues (`dist/core/agent-session.js:1566-1586`) and is skipped when `_agentRunAbortRequested` is set (`:1455-1460`). `agent_settled` is emitted once per `_startRun` in the `finally` (`:1471`).
- `emitBoundary` reduces all handlers: `entries` is replaced by the last handler that returns them, `continue` is the last non-undefined value (`dist/core/extensions/runner.js:759-805`).
- `/compact` aborts first and awaits idle before emitting `session_before_compact` (`dist/core/agent-session.js:1971-1982`, `:2230-2262`).
- `createBranchedSession` copies entries with the same ids (`dist/core/session-manager.js:1205-1237`), so `usageStartEntryId` and `anchorEntryId` stay valid in a fork.

## 1. Findings

| ID | Severity | Area | file:line | What is wrong | Why it matters | Proposed fix | Test |
|---|---|---|---|---|---|---|---|
| H1 | HIGH | Interrupts / compaction | `src/adapters/pi-events.ts:163-174`; `src/runtime.ts:195-198` | Manual compaction resumes *any* goal paused by an interrupt within a 1.5 s window, not only the pause caused by this compaction. The window is a timing heuristic; the code comment admits "It is not proof". | A user who presses Escape to stop a goal and then types `/compact` quickly has the stop silently undone; autonomous work and spending resume without a visible cause. | Correlate causally: record the interrupted run/turn id at `agent_settled` and let `session_before_compact` resume only when the compaction's abort is that same run (or pass the abort identity through `compact()` state). Otherwise never auto-resume. | `test/adapter-events.test.ts:197-229` covers only the causal case; add "Esc, then /compact within the window keeps the goal paused". |
| M1 | MEDIUM | Blocked audit | `src/services/goal-controller.ts:902-924`; `src/domain/transitions.ts:254-270` | The audit gate is turn-count only (`auditedTurns >= 3`); "same blocker" is not checked. A whitespace or absent `reason` is replaced with `"unspecified blocker"` (`goal-controller.ts:918`), so the transition's own non-empty-reason rejection (`transitions.ts:267-270`) is unreachable from the tool. `evidence` is optional. | After three goal turns a model can mark `blocked` with a new story, no reason, and no evidence. `blocked` stops the loop until the user resumes. `docs/ARCHITECTURE.md:23` claims the same-blocker rule is "Enforced deterministically", which is not true. | Require a non-empty reason and at least one evidence item at the tool boundary; optionally store/compare a blocker fingerprint across the audit turns and reject a changed blocker. Correct the architecture text to "audit length only". | `test/engine.test.ts:619-658` only counts turns. Add whitespace-reason, changed-reason, and no-evidence cases. |
| M2 | MEDIUM | No-progress breaker | `src/services/progress-tracker.ts:28,149`; `src/runtime.ts:62` | `deriveTurnStats` stops scanning at `MAX_IDLE_TURNS = 10`, but `PI_GOAL_MAX_IDLE_TURNS` accepts any positive integer. | `PI_GOAL_MAX_IDLE_TURNS=20` silently disables the breaker: the value can never be reached. A safety valve is config-breakable. | Pass `maxIdleTurns` into the derivation (scan cap `maxIdleTurns + 1`) or reject/clamp config above the scan cap. | `test/runtime.test.ts:48-68` parses 9; add 11 trailing idle turns with `maxIdleTurns: 11` and assert the breaker trips. |
| M3 | MEDIUM | Budget wrap-up | `src/services/continuation-policy.ts:126-142`; `src/prompts/budget-limit.ts:27`; `src/services/goal-controller.ts:505-544` | The budget wrap-up turn runs while the snapshot is still `active`, but the prompt says "The system has marked the goal as budget_limited". The status changes only at the next boundary. If the wrap-up turn errors or is interrupted, `settle` pauses it and `budgetLimited` is never recorded. | The model is told a false status, can complete or block during the wrap-up, and can spend an unbounded extra turn; exhaustion can be replaced by `paused`. | Persist `budgetLimited` at the crossing while still allowing exactly one wrap-up directive (record a `wrapup` marker instead of relying on status), or at least do not claim `budget_limited` in the prompt. | `test/engine.test.ts:454-478` asserts one wrap-up then stop; add "wrap-up turn errors" and "budget + idle >= 3" cases. |
| M4 | MEDIUM | Completion gate | `src/services/goal-controller.ts:860-872`; `src/services/progress-tracker.ts:130-135` | The gate is `currentTurnEvidence > 0`. `evidence` now excludes plan/other tools, but a single `read`/`grep`/`find`/`ls` still satisfies it, and any successful tool resets the idle breaker. | The only deterministic protection against premature completion is one read of any file; a model can also loop (up to the turn cap) doing harmless reads. README:142-145 documents the gate as mechanical; `docs/ARCHITECTURE.md:25` presents it as a completion gate without qualification. | Require a mutating or command tool (`currentTurnMutated` or a `bash` result) for completion, or require the tool call to cite tool-result ids from the turn. | Add a test that `complete` with only a `read` is rejected, and a "reads forever" loop test. |
| M5 | MEDIUM | Continuation dedupe | `src/services/continuation-policy.ts:109-115`; `docs/ARCHITECTURE.md:114` | Dedupe requires `directivePending && lastDirectiveAnchorId === assistantEntryId`. A directive left pending by an abort during the boundary is ignored at the next boundary (different anchor), so a second directive is appended and the stale one stays in model context. | The model sees two "Continue working…" prompts around a user message, goal-turn counts inflate, and behavior contradicts "No continuation when a goal directive is already pending". | Treat a pending directive from a previous run as consumed (record the run/boundary that owns it), or dedupe on `directivePending` alone and record the stale directive. | Add an engine test: commit a directive, abort before the run, append a user turn and an assistant entry, boundary must not append a second directive. |
| M6 | MEDIUM | Transition matrix vs doc | `src/domain/transitions.ts:154-184` (resume budget check only for `budgetLimited`); `:254-287` (block has no active gate); `:311-341` (usage-limited from paused/blocked); `:363-380` (fork downgrades `budgetLimited`) | Transitions are accepted that `docs/ARCHITECTURE.md:34-46` does not list or that contradict `:45` (budget precedence). Probe output confirms: block from paused, usage-limit from paused/blocked, fork `budgetLimited -> paused`, resume from paused while over budget. | Statuses and pause/block reasons can be overwritten (usage-limited over a user pause); the fork loses the budget-limit fact; an over-budget paused goal resumes for one extra turn. None is tested. | Encode the intended matrix: block only from `active`, usage-limit only from `active`/`budgetLimited`, keep `budgetLimited` on fork, check the budget on every resume; update ARCHITECTURE and README. | Add a transitions matrix test covering all from/to pairs, including these four. |
| M7 | MEDIUM | Active-time accounting | `src/services/goal-controller.ts:532-544`; `src/runtime.ts:169-181`; e2e | Active time is the only quantity not derived from the transcript: it is persisted only by `settle` (or the completion `touch`). A hard kill loses the open span. e2e2 records `activeMs: 0` for a ~10-15 s goal; e2e3 records 51 961 ms against 62.4 s since the user turn and 115.6 s since creation. | `timeUsedSeconds`, `/goal status`, and the completion report understate time after restarts; `docs/ARCHITECTURE.md:72` claims quantitative state is derived. | Persist a `touch` at every boundary before the continuation decision, and/or derive active time from assistant entry timestamps inside goal turns. | No test covers active time across restart or across a multi-continuation chain; add both. |
| M8 | MEDIUM | Budget ceiling | `src/runtime.ts:28-29`; `src/services/goal-controller.ts:335-341,629-633,768-773,814-816` | `maxBudgetTokens` is documented as a "Hard ceiling for any goal budget, from the command or the tool", but `budgetTooLarge` is only checked in the two `create` paths. `/goal budget` (`setBudget`) is unguarded. | The documented invariant is false; a typo (or a pasted number) can set an effectively unlimited budget after creation. | Apply `budgetTooLarge` in the `setBudget` branch too (and in any future budget mutation). | Add a command test: `/goal budget 999999999` is rejected with the ceiling message. |
| L1 | LOW | Completion accounting | `src/services/usage-accounting.ts:63-82`; e2e2 | Usage is derived from the branch at snapshot time. Once `update_goal complete` writes the snapshot, the rest of the final turn (the assistant message that reports completion) is never charged. e2e2: 797 at completion; 1 130 including the final assistant (333). | Under-reports the completed goal's cost vs Codex, which accounts at turn stop with `ActiveOrComplete`. | Account once more at `agent_settled` for an already-complete goal, or label the number "as of completion". | Add an engine test: complete, append an assistant with usage, settle, assert the total. |
| L2 | LOW | Tool contract | `src/services/goal-controller.ts:183-184`; e2e2 | `completionBudgetReport` is returned for every `complete` goal, even with no token budget and zero elapsed. Codex returns `None` when `token_budget.is_none() && time_used_seconds <= 0` (A §5.1, B). | Divergence from the documented Codex payload. | Mirror the Codex predicate. | Add payload tests for complete-with-no-budget and complete-with-budget. |
| L3 | LOW | Accounting scope | `src/services/usage-accounting.ts:10-11,85-94` | `usage` entries (cache warming) and `branch_summary`/`compaction` usage are charged to the goal. Cache warming is background work; it is recorded at settle and lands in the next goal turn. | Overcharges the budget and can trip `budgetLimited` earlier than the goal's own spend. Documented as counted, not flagged as a budget risk. | Exclude `kind === "cache_warm"` usage entries or document the overcharge in the budget section. | Unit test counts a `usage` entry; add an engine test showing its budget effect. |
| L4 | LOW | Fork metadata | `src/domain/transitions.ts:363-380`; `src/services/goal-controller.ts:168` | The fork copies the snapshot with the source `sessionId`; `forked` and later `commit` never update it. The tool payload now exposes it as `threadId`. | `get_goal` in a fork reports the source session id; any session-scoped check added later would be wrong. | Set `sessionId: context.sessionId` in the `forked` transition (or on rehydrating a fork). | Add an assertion to `test/engine.test.ts:738-756`. |
| L5 | LOW | Goal-turn counting | `src/adapters/directive.ts:21-32`; `src/services/progress-tracker.ts:111-115` | Every `/goal edit` sends an `objective-updated` directive, which counts as a new goal turn and resets `currentTurnEvidence`. | Edits advance `auditedTurns` toward the turn cap and change evidence/audit behavior. | Count only `kickoff`/`continuation`/`budget-wrapup` as turn starts, or track edits separately. | Add a test: three edits do not change `goalTurns` (or document that they do). |
| L6 | LOW | Breaker precedence | `src/services/continuation-policy.ts:117-142` | The idle breaker runs before the budget breaker; a goal that is both over budget and idle for 3 turns is paused(no-progress) instead of `budgetLimited`. Probe confirms. | The budget state is not recorded; after resume the user sees a budget stop, not the pause they were told about. | Move the budget check above the idle check, or make no-progress preserve the budget-exhausted reason. | Add a policy test with `idleTurns >= 3` and `tokensUsed >= budget`. |
| L7 | LOW | Reporting consistency | `src/services/goal-controller.ts:151-157,804`; `src/adapters/pi-ui.ts:39` | `get_goal` adds the in-flight `elapsedMs` to `timeUsedSeconds`, while the status line/widget and `/goal status` use the persisted `snapshot.activeMs`. | Two different "active" numbers in one session; the UI lags the tool. | Use one source (pass elapsed into the UI render, or drop it from the tool payload). | Add a test comparing `get_goal` and the status line for the same run. |

## 2. Detail on the key findings

### H1: 1.5 s interrupt correlation defeats an explicit stop

`src/adapters/pi-events.ts:163-174`:

```ts
pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason !== "manual") return;
    if (!runtime.hasRecentInterrupt()) return;
    runtime.clearInterrupt();
    const result = await runtime.run((engine) =>
        engine.clearInterrupt(runtime.context(ctx)),
    );
```

`hasRecentInterrupt` is a pure time window (`src/runtime.ts:195-198`), fed by `markInterrupt()` on every `agent_settled{aborted:true}` (`src/adapters/pi-events.ts:74-80`). Its own comment (`src/runtime.ts:187-194`) says: "Pi gives no causal link, so this is a narrow timing heuristic ... It is not proof; a false positive only means the goal stays active after an interrupt." A false positive is exactly the case where the user stopped the goal and then ran `/compact` within 1.5 s. `clearInterrupt` resumes unconditionally for `paused(interrupted)` (`src/services/goal-controller.ts:558-589`). The fix is to thread the aborted run's identity into the compaction state instead of using elapsed time.

### M1: the blocked gate does not check the blocker or the reason

`src/services/goal-controller.ts:914-921` passes the reason through a fallback:

```ts
{
    type: "block",
    reason: call.reason?.trim() || "unspecified blocker",
    evidence: call.evidence ?? [],
    auditTurns: view.metrics.auditedTurns,
}
```

`src/domain/transitions.ts:267-270` rejects an empty reason (`const reason = command.reason.trim(); if (reason.length === 0) ...`), but the fallback makes every tool call non-empty, so that guard is unreachable from the model. `auditTurns` is `Math.max(0, turns.goalTurns - snapshot.turnBaseline)` (`goal-controller.ts:131`): a count since creation or the last resume, with no comparison of what the previous turns reported. Probe: `block` with `auditTurns: 3` succeeds from `paused` and from `active` regardless of the reason history. README:138-139 and README:142-145 document the mechanical nature; `docs/ARCHITECTURE.md:23` should match.

### M4: the completion gate is satisfiable with one read

`src/services/goal-controller.ts:861-871` requires only:

```ts
if (call.status === "complete") {
    if (view.metrics.currentTurnEvidence <= 0) {
```

`currentTurnEvidence` counts successful tool results whose category is `read`, `mutate`, or `command` (`progress-tracker.ts:130-135`). A single `read` of any file passes. The same counter feeds the idle breaker (`activity`), so the same read also resets the no-progress streak. The prompt carries the real requirement-by-requirement audit, but the deterministic gate proves nothing about the objective.

## 3. E2E evidence

### e2e2 (single-turn completion)

Transcript: `/tmp/goals-e2e2/sessions/2026-10-31T20-09-39-966Z_*.jsonl`.

- Goal created by the model through `create_goal` (no `/goal` command): snapshot `58a13fbd` rev 1 `active`, `usageStartEntryId = c4eeacc7` (the assistant entry containing the call).
- Tools: `bash` (listing), `write hello.txt`, `bash` (`grep -qx hello`), then `update_goal complete`: snapshot `9f0e3659` rev 2 `complete`.
- Continuations: **zero**. No `goal-directive` entries; the goal completed inside the creating turn, so the boundary was idle.
- Accounting: completion payload `tokensUsed: 797`, exactly the three assistant usages after the anchor (332 + 172 + 293). Recomputed end-of-branch total is 1 130; the final assistant `1b65a638` (333) runs after the completion snapshot and is not charged (L1).
- Anomaly: run from 20:09:40.26 to completion 20:09:55.53 (goal span 10.2 s), yet `activeMs: 0` and `timeUsedSeconds: 0` (M7). No `paused`/interrupt snapshot.

Verdict: correct for the completion path (three tool results, no duplicate continuation, payload consistent). Active-time accounting is wrong.

### e2e3 (interrupted run restored in a new process)

Transcript: `/tmp/goals-e2e3/sessions/2026-10-31T20-10-34-535Z_*.jsonl`.

- Goal created by `create_goal`: snapshot `b7acf3e2` rev 1 `active`, anchor `c6ca36e8`.
- First segment writes and verifies lines 1-5, ends at tool result `effc2b93` (20:11:18.056).
- A user message at `ee606601` (20:11:32.526): "Call get_goal and report the goal status, tokens used, turns and tools. Then stop." `get_goal` reports `tokens=unbounded turns=1 continuations=0 tools=7(0 failed) active=4s`, `tokensUsed: 3017` (recomputed at that point: exactly 3017).
- Boundary after assistant `252195e5` (stop) appends exactly one directive `d193d91b`: `kind: continuation`, `turn: 2`, `anchorEntryId: 252195e5`. No second directive anywhere.
- The continuation writes lines 6-12, verifies the file (12 newlines), calls `update_goal complete`: snapshots `5ede5cf5` (rev 2, touch) and `93e372ed` (rev 3, complete), both `activeMs: 51961`; completion payload `tokensUsed: 8949`.
- Recomputed branch total after the anchor is 9 363; minus the final assistant `5fe686ce` (414) = 8 949, exactly the payload. Cache reads are excluded (`allTokens: 113397`).
- The transcript alone cannot prove a second OS process (a resume appends no entry). Under the task's premise, the goal was restored as `active` (no paused snapshot), re-engaged on the user message, and continued once; that is the documented restart path and it behaved correctly.
- Losses: ~64 s of active time (115.6 s since creation, 62.4 s since the user message, 51.961 s recorded); the user's "Then stop" was not honored (the goal continued at the boundary), which is goal semantics but surprising.

Verdict: no duplicate continuations, no double counting, statuses and accounting consistent. Active time is lossy across the restart (M7).

## 4. Verified correct

- Create/conflict/validation: the model cannot create a second unfinished goal; only `complete` is replaceable; objective trimmed, 1..4000 code points; budgets positive integers (`transitions.ts:89-127`, `406-434`; tests `transitions.test.ts:92-249`). `create_goal` now requires user confirmation unless `PI_GOAL_ALLOW_UNATTENDED_CREATE=1` (`pi-tools.ts:96-110`), and the budget ceiling is enforced on both create paths (`goal-controller.ts:335-341,629-633,814-816`; but see M8 for `setBudget`).
- Pause gates: `active -> paused` only; `budgetLimited` is a no-op; pause from other statuses is invalid (`transitions.ts:129-152`). Tool pause requires an explicit user confirmation and is rejected without UI (`pi-tools.ts:112-121,213-222`; `adapter-tools.test.ts:176-204`).
- Completion authorization: the model can only request `complete|blocked|paused` (`pi-tools.ts:48-54,219-230`), and `paused` without confirmation fails with `pause-unauthorized` (`goal-controller.ts:931-937`).
- Resume conditions for `budgetLimited`: refused until a budget edit after the limit, verified both from `tokensUsed` and from history (`transitions.ts:154-184`; tests `:344-400`). The turn cap now pauses with reason `turn-cap` and `/goal resume` resets the audit baseline, so the earlier dead end is gone (`continuation-policy.ts:144-162`; `engine.test.ts:554-577`).
- Continuation is one directive per boundary, anchored to the assistant entry, and deduped for the same boundary (`continuation-policy.ts:109-115`; `adapter-events.test.ts:56-133`; e2e3).
- No continuation for non-`active` statuses; an interrupt is turned into `paused` by `settle`, and a provider error becomes `paused`/`usageLimited` inside the boundary, which returns `stopped` (`continuation-policy.ts:66-103`, `goal-controller.ts:505-530`).
- Boundary failure handling: `decideBoundary` failure triggers `failSafe`, which best-effort pauses the goal so nothing stays active unserved (`pi-events.ts:111-118`, `goal-controller.ts:591`).
- Provider-error classification order (quota before auth before transient) is tested (`continuation-policy.test.ts:180-227`).
- Token charge is `input + cacheWrite + output`; cache reads excluded; negatives clamped; duplicate entry ids counted once; the anchor excludes the creating assistant entry (`usage-accounting.ts:45-125`; `usage-accounting.test.ts:61-210`; e2e3).
- Persistence is a snapshot per transition with a revision, branch-scanned newest-first, tombstones for clear, corrupt/unsupported entries skipped with bounded issues (`goal-repository.ts:26-162`; `goal-repository.test.ts:43-167`).
- Compaction: snapshots/directives survive because `getBranch` ignores compaction cuts; the snapshot is out of model context but still loads; the continuation re-injects the objective (`engine.test.ts:758-780`; Pi `session-manager.js:1062-1079`).
- Fork: entries copy with the same ids, so `usageStartEntryId` and anchors remain valid; `session_start{reason:"fork"}` pauses the copied goal; the original stays active (`goal-controller.ts:368-394`; `engine.test.ts:738-756`; Pi `session-manager.js:1205-1237`).
- Concurrency: one semaphore per engine layer serializes read-modify-write; parallel mutations keep revisions monotone (`goal-controller.ts:253`, `engine.test.ts:823-844`).
- Multiple extensions at the boundary: our handler preserves `event.entries` and does not reset another extension's `continue` when idle (`pi-events.ts:128,138`; Pi `runner.js:759-805`).
- Manual compaction does not leave a paused goal in the causal case (`adapter-events.test.ts:197-229`).
- Tool payload shape mirrors Codex (`goal`, `remainingTokens`, `completionBudgetReport`, plus `threadId`) and the tools declare output schemas (`adapter-tools.test.ts:206-222`).

## 5. Tests: weak assertions and missing cases

Weak or self-referential assertions:

- `test/engine.test.ts:795-799` compares derived values before/after a restart (`goalId`, `status`, `tokensUsed`, `goalTurns`); comparing derived-to-derived values cannot fail unless the derivation is nondeterministic. The hardcoded `55` at `:798` is the real assertion.
- `test/support/fake-session.test.ts` and `fake-host.test.ts` test the fakes (e.g., "driver can reconstruct the same-boundary duplicate scenario", `fake-session.test.ts:220`). Useful for support code, but the suite validates the extension against a hand-written model of Pi. Nothing asserts Pi's real `getBranch`, boundary reducer, or compaction semantics, so a Pi drift would not fail this suite. `wiring-drift.test.ts` pins registrations and schemas only.
- `test/continuation-policy.test.ts` builds metrics by hand; it exercises the policy but not the derivation that feeds it (covered separately in `progress-tracker.test.ts`, so acceptable).

Missing cases, by area:

- Creation: tool-created goal with `token_budget`; create when the leaf is a cleared tombstone; create before the first message (durability window); create confirmation denial and `PI_GOAL_ALLOW_UNATTENDED_CREATE=1`.
- Pause: `/goal pause` on `blocked`/`usageLimited`/`paused` (error text); tool pause on `budgetLimited`; pause during streaming and the boundary stop.
- Resume: from `paused`/`blocked`/`usageLimited` while over budget; after a fork; after a turn cap (fresh allowance, no budget edit).
- Completion: from `paused` and `budgetLimited`; with a `read` as the only evidence; accounting after the final assistant message.
- Blocked: whitespace/absent reason; a different reason each turn; block from `paused`/`usageLimited`; audit inflated by two `/goal edit`s.
- Budget: exhaustion during the wrap-up turn; budget crossed in the same turn as an interrupt; cache-warm `usage` entries; `setBudget` above the ceiling (M8); budget after restart and after compaction.
- Restart: between directive commit and run start (stale pending directive); while `budgetLimited`; mid-run (active-time loss); a newer unsupported snapshot version over a valid older one.
- Reload: `session_start{reason:"reload"|"resume"|"startup"}`; only `fork` is tested.
- Compaction: compaction between decision and provider request (LIMITATIONS #4); a compaction that drops the creation snapshot but keeps a directive; auto (`threshold`) compaction must not pause.
- Branch/fork: fork of a `budgetLimited` goal (status downgrade, M6); fork at the anchor entry (no snapshot); resuming both sessions; the forked `threadId` (L4).
- Corrupt state: corrupt snapshot with a newer tombstone; non-integer `revision`; extra fields; tombstone with a mismatched `goalId`.
- Accounting: cache-warming attribution; nested `toolResult` usage; post-completion charge.
- Concurrency: boundary and tool in the same tick; `create`+`complete` in parallel; `settle` racing `decideBoundary`.
- Duplicates: two extensions at the boundary (one returns `false` after ours); abort-during-boundary stale directive; the same anchor with the directive not last.
- Interrupts: abort during the boundary window; abort after a wrap-up; interrupt followed by an unrelated `/compact` (H1).
- Provider errors: a stale `lastAssistantEntry` (no new assistant this run) misclassifying `errorText`; error on a paused goal.
- Long processes: a real 200-turn loop; activeMs across many continuations; branch scan cost.
- No-progress: a text-only turn counts idle; the wrap-up turn counts idle; no-progress vs budget precedence (L6).
- Objective changes: edit while paused (no directive); edits inflating `goalTurns` (L5).
- Invalid commands: `/goal status extra`; `/goal budget 1_000`; `/goal budget` while streaming; `/goal clear` with no goal.
- Recovery: `appendEntry` throwing during a boundary transition (notice + previous snapshot authoritative) and during a command (typed error); engine disposed mid-call.

The two most important missing tests: **turn-cap pause then `/goal resume` grants a fresh allowance end to end** (the new path has no resume test), and **interrupt followed by an unrelated manual compaction must keep the goal paused** (H1).

## 6. Unverified

- The e2e3 premise of a new OS process cannot be verified from the transcript; the file has one session header and no resume marker. The restart-path verdict assumes the task's description.
- Why e2e2 recorded `activeMs: 0` is not established. `agent_start` is emitted per agent loop (`pi-agent-core/dist/agent-loop.js:55,73`), so the handler should have set the span. Possible causes (unevaluated): the run started before the extension registered its handler, `agent_start` was not delivered in that run mode, or the touch was skipped. UNVERIFIED.
- `pi.appendEntry` is bound to the `AgentSession` that created the extension runner (`dist/core/agent-session.js:2783`), while `readBranch` uses `ctx.sessionManager`. In the audited Pi version both refer to the same session for the lifetime of an extension instance, and a session switch replaces the runtime. A cross-session write during an in-flight call was not observed but was not proven impossible. UNVERIFIED.
- Durability relies on Pi's session flush; the documented "one provider request" window before the session file exists was not re-tested.
- The source changed several times during the audit (`runtime.ts`, `pi-tools.ts`, `progress-tracker.ts`, tests). Findings were re-verified against the freeze, but later edits can invalidate line numbers or fix items. The test suite was green at freeze.
- The two e2e transcripts predate the `create_goal` confirmation and budget ceiling, so they do not exercise those paths.

## 7. Post-freeze deltas (observed, not re-audited)

After the freeze the working tree kept changing. These diffs were inspected while finishing the report; they appear to address findings above, but the new code was not re-audited or re-verified against the suite, so treat the findings table as the state of record at the freeze.

- `progress-tracker.ts`: the `MAX_IDLE_TURNS = 10` scan cap is gone, so **M2 is addressed**; `objective-updated` directives are now excluded from goal-turn starts, so **L5 is addressed**.
- `continuation-policy.ts`: the budget check now precedes the idle breaker, so **L6 is addressed**.
- `transitions.ts`: `resume` now checks an exhausted budget for every resumable status, not only `budgetLimited`, so the resume part of **M6 is addressed** (block-from-paused, usage-limit-from-paused/blocked, and fork downgrade remain).
- `usage-accounting.ts`: cache-warming `usage` entries (`kind === "cache_warm"`) are now excluded, so **L3 is addressed**.
- `pi-events.ts`: the manual-compaction notice now says the goal "stays active ... but is not running" and tells the user to send a message or `/goal resume`; the 1.5 s resume heuristic itself is unchanged, so **H1 remains** (its user-visible surprise is smaller). The unused `goalContext` helper was removed.
