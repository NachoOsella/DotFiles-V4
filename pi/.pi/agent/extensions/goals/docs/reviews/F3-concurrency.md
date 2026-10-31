# F3. Adversarial concurrency and race audit of `pi-goals`

Auditor: independent review. No source or test file was modified; scratch reproductions live under `/tmp/effprobe`.

## Revision audited

The working tree changed while this audit ran (`runtime.ts`, `goal-controller.ts`, `progress-tracker.ts`,
`continuation-policy.ts`, `pi-tools.ts` all changed between 17:13 and 17:30). All findings and line
numbers below are against the snapshot frozen at **2026-10-31T17:30:30-03:00**:

| File | SHA-256 (first 16) |
|---|---|
| `src/services/goal-controller.ts` | `1ca87209ecdd576b` |
| `src/runtime.ts` | `1f888923ddfdd480` |
| `src/adapters/pi-events.ts` | `723a4a46b9dd3958` |
| `src/adapters/pi-commands.ts` | `2a77c80e778aecbd` |
| `src/adapters/directive.ts` | `064f71cd2f1d1d59` |
| `src/domain/transitions.ts` | `11bb77c50ca2042a` |
| `src/services/progress-tracker.ts` | `cc1c04a9f4b9d4f2` |
| `src/services/continuation-policy.ts` | `0e3bdf71875eff9f` |

Citation legend: `EXT:` = `/home/nacho/.pi/agent/extensions/goals/`; `PI:` =
`/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent/`. Agent-loop citations use the full
nested path `PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:LINE`. `HEAD:` marks a citation into the live working tree at the timestamp of the head-status table
(not the frozen revision).

Suite state at that revision: `node --test test/engine.test.ts test/adapter-events.test.ts test/adapter-commands.test.ts test/adapter-tools.test.ts test/goal-repository.test.ts`
reports one failure, `the turn cap stops the loop with a wrap-up` (expected `budgetLimited`, got `paused`).
It is unrelated to the races below (it comes from the in-flight `activity`/`evidence` and wrap-up edits) but
it means the tree was not green while audited.

**Head drift.** After the freeze the head changed again (17:31-17:37): `failSafe` on boundary-decision
failure, `authorizeCreate`, removal of `withDirective`, and prompt edits. None of those changes alters the
concurrency findings below, but they shift line numbers. The audited sources are preserved at
`/tmp/audit-final/src`; every citation was verified against that copy. When reading the current head,
re-locate a cited block by the short code quote next to it.

## Verdict

**No critical race. No lost update, no duplicate model request, and no cross-goal corruption was found.**
The core concurrency design is sound: one Effect `Semaphore` per runtime, every read-modify-write inside the
permit, all writes synchronous appends, and a per-anchor continuation guard.

Four medium findings, all about *intent and accounting*, not about state corruption:

1. **F3** — a manual `/compact` within 1.5 s of an abort silently undoes an interrupt pause (the user's stop
   is reversed without a resume command). Top severity.
2. **F2** — `/goal pause` or `/goal clear` that lands after the boundary decision but before Pi commits the
   directive still lets one more goal turn run, and for `clear` leaves a directive for a cleared goal.
3. **F1** — if the run is discarded after the directive was committed, the abandoned directive counts as a
   goal turn; repeated occurrences can trip the no-progress breaker (reproduced).
4. **F6** — `activeMs` accrues for runs the goal did not drive (a paused goal collects time from ordinary
   user conversation; reproduced).

The rest are low: quit-path settle loss, 1.5 s miss window, misleading notice, the missing goal identity in
tool calls (latent, currently neutralized by gates), non-atomic multi-step commands, and doc drift.

### Status at the head (informational, 17:39:15)

The head is being edited while this report is written (hashes `progress-tracker eb631b8`,
`goal-controller 13707c7`, `pi-events b2c030a`, `pi-tools 773e85d`, `adapter-events.test f605645`). At that
instant two of the four medium findings (F3, F6) and one low finding (F5) were already addressed; F1 and F2
remained open:

| Finding | Head status | Evidence at the head |
|---|---|---|
| F3 | fixed (fail closed) | `HEAD:src/adapters/pi-events.ts:166-175` no longer calls `engine.clearInterrupt`; it only notifies. `HEAD:test/adapter-events.test.ts:197` is now `manual compaction explains the interrupt pause instead of resuming` and asserts `no automatic resume`. |
| F4 | resolved by F3 | no resume path exists, so the 1.5 s window only gates a notice. |
| F5 | fixed | the notice now says the goal is paused and names `/goal resume` (`HEAD:src/adapters/pi-events.ts:170-174`). |
| F6 | fixed | `HEAD:src/services/goal-controller.ts:507-525` charges the run *before* the interrupt transition and only when `status === "active"`, with a comment stating exactly that. |
| F1 | **open** | `HEAD:src/services/progress-tracker.ts:92-95` excludes only `objective-updated` from `turnDirectives`; an abandoned `continuation` directive still starts a turn, and `HEAD:src/services/progress-tracker.ts:157` still counts it. |
| F2 | **open** | `HEAD:src/adapters/pi-events.ts:73-75` still registers `agent_start` without a context and never re-checks the goal status before the continuation request. |
| F7 | **open** | `HEAD:src/adapters/pi-events.ts:177-179` still disposes the runtime on every `session_shutdown`, including quit before the abort. |
| F8, F9, F10 | open (low) | unchanged contracts: no `goalId` in `update_goal`; two-entry budget raise; pause still loses to an in-flight terminal update. |
| D1 | **worse** | `EXT:README.md:249` and `EXT:docs/LIMITATIONS.md:58-61` still describe the removed automatic resume and a "five second" window. |

This table is a snapshot; re-check the hashes before treating it as current.

## Findings

| ID | Severity | Race | Triggering interleaving | file:line | Impact | Fix | Test |
|---|---|---|---|---|---|---|---|
| F3 | medium (top) | Manual compaction resumes a goal the user interrupted | Escape at T0; `/compact` at T0+1.4 s | `EXT:src/runtime.ts:140-155`, `EXT:src/adapters/pi-events.ts:154-165` | goal continues and spends without an explicit resume | fail closed: never auto-resume; notify "paused by compaction, /goal resume" | `escape-then-compact-stays-paused` |
| F2 | medium | Pause/clear lands after the boundary decision, before the draft commit | boundary returns continue; `/goal pause` effect completes; Pi commits the draft and continues | `EXT:src/adapters/pi-events.ts:98-149`, `EXT:src/adapters/pi-commands.ts:294-320` | one extra model turn after a stop; cleared goal gets a directive | re-check at `agent_start`; `ctx.abort()` if the directive's goal is no longer active | `pause-after-decision-aborts-the-turn` |
| F1 | medium | Abandoned continuation directive counts as a goal turn | boundary returns continue; draft committed; abort before `agent.continue()` | `EXT:src/services/progress-tracker.ts:95-111`, `EXT:src/services/progress-tracker.ts:148-156`, `EXT:src/services/progress-tracker.ts:163`; `PI:dist/core/agent-session.js:1573-1577` | duplicate directive, inflated `goalTurns`/`continuationCount`, no-progress trips after repeats (reproduced) | count a directive only when an assistant entry follows it | `aborted-continuation-is-not-a-turn` |
| F6 | medium | `activeMs` charged for non-goal runs | goal paused; user chats; `agent_settled` touches with the whole span | `EXT:src/services/goal-controller.ts:511-523`, `EXT:src/adapters/pi-events.ts:75-95` | wrong `timeUsedSeconds`, wrong wrap-up input (reproduced 0 → 41 → 61 ms) | touch only when the goal was active for the span | `paused-goal-does-not-accrue-active-time` |
| F4 | low | 1.5 s window misses the compaction | abort waits >1.5 s (tool ignoring the signal, open UI confirm); `session_before_compact` then arrives | `EXT:src/runtime.ts:152-155`, `PI:dist/core/agent-session.js:2230-2233` | goal stays paused after a benign `/compact` | same fail-closed policy makes this the documented behavior | `slow-manual-compaction-keeps-the-pause` |
| F5 | low | Misleading "kept active" notice | manual compaction with a recent interrupt but no interrupt-paused goal | `EXT:src/adapters/pi-events.ts:161-164`, `EXT:src/services/goal-controller.ts:544-549` | user is told the goal was kept active when nothing changed | notify only when `clearInterrupt` actually resumed | `no-notice-when-clear-interrupt-is-a-no-op` |
| F7 | low | Quit path disposes before the final settle | quit during a run: `session_shutdown` → dispose → Pi aborts → `agent_settled` | `PI:dist/core/agent-session-runtime.js:296-303`, `EXT:src/runtime.ts:161-168` | last activeMs/interrupt never persisted; error is silently swallowed (reproduced) | defer dispose while a run is open | `quit-mid-run-persists-the-settle` |
| F8 | low | Tool calls carry no goal identity | parallel `update_goal(complete)` + `create_goal` | `EXT:src/domain/goal.ts:335-360`, `EXT:src/adapters/pi-tools.ts:50-70` | safety relies on gates, not on identity; latent for future transitions | add the observed goal id to the tool call and reject mismatches | `stale-tool-call-cannot-touch-a-new-goal` |
| F9 | low | Multi-step commands are not crash-atomic | `/goal budget` raise = setBudget then resume | `EXT:src/services/goal-controller.ts:711-734` | a crash between the two leaves `budgetLimited` with a raised budget (recoverable) | accept and document, or fold into one transition | `budget-raise-has-one-final-state` |
| F10 | low | Pause cannot preempt an in-flight terminal update | pause vs `update_goal complete`/`blocked` in one turn | `EXT:src/services/goal-controller.ts:802-841`; `EXT:src/domain/transitions.ts:129-160` | in both arrival orders the goal ends complete/blocked | define precedence explicitly or document that tool terminal states win | `pause-loses-to-inflight-complete` |
| D1 | low | Docs describe removed or stale interrupt behavior | docs say manual `/compact` auto-resumes within five seconds | `EXT:README.md:249`, `EXT:docs/LIMITATIONS.md:58`, `EXT:src/runtime.ts:152` | readers expect a resume the frozen code performs at 1500 ms and the head no longer performs at all; ARCHITECTURE still claims a "marks that case" flag that was removed | update README/LIMITATIONS/ARCHITECTURE to the fail-closed behavior | doc review |

## Detail and proof

### Q1. Two continuations for one boundary

**Literal duplicate model request: DISPROVED.** Three independent reasons:

1. Pi dispatches one boundary to all handlers and keeps **one** boolean. Each handler sees the accumulated
   value and the last write wins (`PI:dist/core/extensions/runner.js:762-778`, `continue: shouldContinue`).
   A second extension returning `continue` cannot add a second request.
2. `_startRun` calls `agent.continue()` exactly once per boundary decision and re-checks the abort flag first
   (`PI:dist/core/agent-session.js:1450-1462`).
3. Provider retries and compaction retries never reach the boundary: `_handlePostAgentRun` calls
   `agent.continue()` itself (`PI:dist/core/agent-session.js:1531-1564`). The goal handler runs once per
   settled session-level run, not once per attempt.

**Residual race: F1 (proved).** The abort window defeats the dedupe guard, not the request count.

```
1. turn ends; agent_before_settle -> goal decides "continue" and returns a directive draft (EXT:src/adapters/pi-events.ts:128)
2. Pi commits the draft                                          (PI:dist/core/agent-session.js:1573)
3. Escape arrives; Pi sees _abortDuringBeforeSettle and returns false, no continue (PI:dist/core/agent-session.js:1576-1577)
4. branch ends with an unanswered goal directive; goal is paused by settle
5. /goal resume -> a second directive; assistant answers; next boundary continues again
```

At step 3 the draft is already durable while the decision was discarded. `directivePending` requires the
directive to be the **last** entry (`EXT:src/services/progress-tracker.ts:163`), and the dedupe guard requires
`directivePending` (`EXT:src/services/continuation-policy.ts:101-109`), so the abandoned directive is never recognized again.
`goalTurns` counts directives, not answered directives (`EXT:src/services/progress-tracker.ts:155`), and `idleTurns` counts
trailing turns with zero tool activity (`EXT:src/services/progress-tracker.ts:148-156`). Reproduction (real engine, fake host,
`/tmp/effprobe/race.ts`): after one abandoned continuation plus a resume, the boundary stopped with
`No tool activity was observed for 3 goal turns` and `directives: 2`. Repeated escapes at the boundary can
therefore pause a healthy goal with a false no-progress verdict.

Fix: a goal turn should require a following assistant entry. In `deriveTurnStats`, when collecting
directives, treat a directive with no later assistant message (and not at the branch tail) as void for
`goalTurns`, `continuationCount`, and the idle streak, or record a `goal-continuation-requested` custom entry
keyed by anchor and void it when the next boundary sees no assistant after it.

### Q2. Continuation for a goal just paused, cleared, or limited

**Within one engine effect: DISPROVED.** Every mutating path wraps `load` + `transition` + `append` in one
permit: `decideBoundary` (`EXT:src/services/goal-controller.ts:380`), `settle` (`EXT:src/services/goal-controller.ts:484`), `clearInterrupt` (`EXT:src/services/goal-controller.ts:537`),
`runCommand` (`EXT:src/services/goal-controller.ts:570`), `runTool` (`EXT:src/services/goal-controller.ts:743`). A pause cannot interleave with the read inside a decision.
`budget`/`resume`/`edit`/`create` are refused while streaming (`EXT:src/adapters/pi-commands.ts:80`, `EXT:src/adapters/pi-commands.ts:110`, `EXT:src/adapters/pi-commands.ts:148`, `EXT:src/adapters/pi-commands.ts:186`).

**Across the decision/commit window: PROVED (F2).**

```
1. boundary handler loads "active" and returns {entries:[directive], continue:true}   (EXT:src/adapters/pi-events.ts:105-128)
2. before Pi commits, the user's /goal pause runs (extension commands execute during streaming:
   PI:dist/core/agent-session.js:1640-1647) and appends a paused snapshot   (EXT:src/adapters/pi-commands.ts:294-308)
3. Pi commits the directive and calls agent.continue()                     (PI:dist/core/agent-session.js:1573, :1461)
4. one more goal turn runs against a paused goal; the next boundary sees "paused" and stays idle
```

For `/goal clear` (`EXT:src/adapters/pi-commands.ts:309-320`) the extra turn runs on a cleared goal and the committed
directive still carries the cleared `goalId`. The same holds for a boundary that returns `budget-wrapup`.
Impact is bounded to one turn, but a turn can be long and expensive, and the user's stop is not authoritative.

Fix: give `agent_start` a context (`EXT:src/adapters/pi-events.ts:70-72` currently takes none), reload the newest snapshot,
and if the last entry is a goal directive whose goal is not `active`, call `ctx.abort()` before the first
request and suppress the "paused after interrupt" notice. Pi checks the abort signal before each provider
request and aborts the run (`PI:dist/core/agent-session.js:712-713`). This closes the window for pause and clear without
changing the normal continuation path.

### Q3. Parallel `update_goal` calls

**Lost updates and revision regressions: DISPROVED.** One permit per runtime (`EXT:src/services/goal-controller.ts:245`), load
inside the permit (`EXT:src/services/goal-controller.ts:320`), synchronous append through `persistSnapshot` (`EXT:src/services/goal-controller.ts:292-294`); a second tool call
re-reads the branch after the first write. Revisions only increase (`EXT:src/domain/transitions.ts:465`) and no-op
transitions are no longer re-persisted (`EXT:src/services/goal-controller.ts:290-292`). The existing test drives five
concurrent mutations and asserts non-decreasing revisions (`EXT:test/engine.test.ts:819-841`).

**Double transitions:** `unchanged()` returns the same snapshot and is now skipped, so it cannot append.
Multi-step commands still write two entries (`setBudget` then `resume`, `touch` then `complete`); they are
not crash-atomic (F9) but each order is a legal state.

**`get_goal` racing `update_goal`:** `runTool` is gated, so a tool read sees before or after, never mid-write.
`runtime.view()` (used by `/goal status`) is ungated (`EXT:src/runtime.ts:116-119`, engine `view` at `EXT:src/services/goal-controller.ts:341-345`, via `runtime.context`), so
it can read the intermediate of a two-step command (`setBudget` persisted, `resume` pending) because the
writer suspends at each `yield*`. That intermediate is itself a persisted state, so this is a stale display,
not corruption.

**Pause vs terminal tool updates (F10):** `pause` is invalid from `complete`, so in both arrival orders an
in-flight `update_goal complete` wins. This is a policy gap, not a data race.

### Q4. Interrupt correlation

`agent_settled{aborted}` marks the interrupt time (`EXT:src/adapters/pi-events.ts:76-80`) and pauses an active goal
(`EXT:src/services/goal-controller.ts:495-510`). `session_before_compact{reason:"manual"}` later checks
`hasRecentInterrupt()` (`EXT:src/runtime.ts:140-155`, 1500 ms) and resumes (`EXT:src/adapters/pi-events.ts:154-165`,
`EXT:src/services/goal-controller.ts:537-566`).

**(a) Can it resume a goal the user actually interrupted? YES — F3 (proved by code and by the existing
test).** At the frozen revision, `EXT:test/adapter-events.test.ts:197` created exactly the ambiguous
state: a settled-aborted goal, then a manual compaction, and asserted `active`. The head replaced that test
with the fail-closed expectation (status table). That sequence is indistinguishable from "user pressed Escape,
then (quickly) ran `/compact`". The runtime comment acknowledges it: *"It is not proof; a false positive only
means the goal stays active after an interrupt"* (`EXT:src/runtime.ts:146-150`). The window was narrowed to 1.5 s,
which lowers the likelihood but does not remove the hazard: an Up-arrow repeat of `/compact`, a keybinding,
or an RPC client can run it within 1.5 s, and the goal then resumes and spends on the next boundary.

**(b) Can it miss the compaction? YES — F4.** `compact()` awaits `this.abort()` before emitting the event
(`PI:dist/core/agent-session.js:2230-2233`, `PI:dist/core/agent-session.js:2253-2265`). `abort()` waits for idle, and the parallel tool
path awaits every tool promise (`PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:417-468`, `Promise.all` at `PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:463`). A tool that ignores the abort signal
or an open `ctx.ui.confirm` (the goal's own pause authorization, `EXT:src/adapters/pi-tools.ts:96-102`) can hold the run for
more than 1.5 s, so the benign compaction arrives after the window and the goal stays paused.

**(c) Unrelated interrupt within the window:** partly guarded. `clearInterrupt` requires
`status === "paused" && pause.reason === "interrupted"` (`EXT:src/services/goal-controller.ts:544-549`), so an abort of an
unrelated run cannot resume a goal paused for another reason. But an interrupt pause recorded at T0 can be
cleared by an abort at T0+1.4 s of a *different* run followed by `/compact`; the pause being undone is older
than the interrupt being matched. Same class as F3, lower likelihood.

Also **F5**: when `clearInterrupt` finds no interrupt pause it returns `ok:true`, and the adapter still tells
the user "Goal kept active across the manual compaction" (`EXT:src/adapters/pi-events.ts:161-164`).

Recommendation: fail closed. Keep the goal paused after a manual compaction and notify "paused by the
compaction; /goal resume to continue". That removes F3 entirely and turns F4 into the documented behavior.
The head already implements this (status table).
If auto-resume is kept, rename the finding to a product decision and update the docs (D1).

### Q5. Reload, dispose, and in-flight work

Probed against the installed Effect 4.0.0-beta.98 (`/tmp/effprobe/probe.mjs`): `ManagedRuntime.dispose()`
interrupts the in-flight effect (exit `Failure`, dispose returns immediately), and a later `runPromiseExit`
returns `Failure(Die("ManagedRuntime disposed"))` instead of throwing. `GoalRuntime.run` converts both into
`{ok:false}` (`EXT:src/runtime.ts:95-114`), so a disposed runtime fails safe and cannot be used to mutate state.

No module-level mutable state: the runtime is created per factory invocation (`EXT:src/index.ts:14-18`), Pi
creates a new extension instance for each session/reload, and `session_shutdown` disposes it
(`EXT:src/adapters/pi-events.ts:167-169`). Double disposal is safe (caught at `EXT:src/runtime.ts:163-167`).

**F7 (proved on the fake host):** the quit path emits `session_shutdown` *before* aborting the run
(`PI:dist/core/agent-session-runtime.js:296-303`; `/new`, `/resume`, `/fork` do the reverse at `PI:dist/core/agent-session-runtime.js:102-113`).
Our handler disposes the runtime, then Pi aborts and the run's `finally` emits `agent_settled`
(`PI:dist/core/agent-session.js:683-690`). The settle then runs on a disposed runtime. Reproduction
(`/tmp/effprobe/quit.ts`): after `session_shutdown`, `agent_settled{aborted:true}` appended no snapshot,
the goal stayed `active`, and the only trace was `Goal bookkeeping failed: ManagedRuntime disposed`; in real
Pi the notification is swallowed because the ctx is stale (`EXT:src/adapters/pi-ui.ts:80-90`) and the runner is invalidated
(`PI:dist/core/agent-session.js:1011-1022`). Impact: the last activeMs and the interrupt pause are lost on quit mid-run.

Fix: on `session_shutdown`, dispose only when `ctx.isIdle()`; otherwise leave the runtime alive for the
pending settle (the process is exiting anyway) or schedule disposal after the settle.

### Q6. Late events from an old goal

**No exact harmful sequence exists in this revision.** Constructed and rejected:

```
1. model emits update_goal(complete), create_goal, update_goal(complete) in one assistant message
2. tools run in parallel (Pi default; PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:368-378)
3. complete #1 completes G1; create sees a complete goal and creates G2; complete #2 has no goalId
4. complete #2 applies to G2 only if G2 has evidence in the current turn
```

The evidence gate blocks step 4: `currentTurnEvidence` is derived from the turn that starts at G2's creation
snapshot (`EXT:src/services/progress-tracker.ts:95-111`), and tool results are appended only after the whole batch finishes
(`PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:463-468`). `blocked` needs three audited turns; `paused` needs a live UI confirmation; `create_goal`
being a tool still refuses while an unfinished goal exists (`EXT:src/services/goal-controller.ts:757-767`); the command
`create` requires idle (`EXT:src/adapters/pi-commands.ts:80`). A tool cannot outlive its run because the parallel path awaits
all tool promises even after abort. So no late tool can reach a *new* goal today.

Latent hazard (F8): `GoalToolCall` carries no `goalId` (`EXT:src/domain/goal.ts:335-360`) and the tool adapters accept
none (`EXT:src/adapters/pi-tools.ts:50-70`). Safety depends on the gates above, not on identity. If a future transition lacks
an evidence/audit gate, or if `create` gains a non-idle path, the stale-tool sequence becomes live. Add the
observed goal id to the tool contract and reject mismatches.

Related but not a race: a forked snapshot keeps the original `sessionId` (the field is only set on `create`,
`EXT:src/domain/transitions.ts:107-109`); nothing validates it today.

### Q7. `activeMs`

**Span loss across boundary → settle → next run: fixed in the audited revision.** `beginRun` no longer resets
an open span (`EXT:src/runtime.ts:126-130`), so every `agent_start` inside one `_startRun` (continuations, retries,
overflow recovery; `PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:73-74`) keeps the original start, and the single `endRun` at settle returns the whole
span. Probe (`/tmp/effprobe/rt2.ts`): `beginRun(0); beginRun(5000); endRun(9000)` → `9000`. A second
`endRun` returns `0`, so two settles cannot double count.

**No double count, no unpaired begin/end** in normal flow: `agent_start` and `agent_settled` are paired per
session-level run. Nested runs do not exist in this extension.

**Defect: the span is charged to the goal regardless of whether the goal drove the run (F6).** At the frozen
revision, settle touched whenever `activeMsDelta > 0 && status !== "complete"` (`EXT:src/services/goal-controller.ts:511-523`); the head restricts it to `active` (status table). A paused, blocked,
usage-limited, or budget-limited goal accrues time from ordinary user conversation. Reproduction
(`/tmp/effprobe/active.ts`): a paused goal went `0 → 41 → 61 ms` across two 40/20 ms user runs. Fix: record
whether the goal was `active` at `beginRun` (or compare `pause.at`/`statusChangedAt` with the span start) and
skip the touch otherwise.

**Definitional note:** the span includes retry backoff, compaction, and boundary-decision gaps because
`agent_start` is not re-emitted for those gaps. That is defensible for a wall-clock "time used" metric but
should be stated in the docs. `withElapsedActiveMs` (`EXT:src/services/goal-controller.ts:144-152`) shows the in-flight total
to tools, so two `get_goal` calls in one run report different `timeUsedSeconds` than the persisted value.

## Safe because

1. **One writer per runtime.** `const gate = Semaphore.makeUnsafe(1);` (`EXT:src/services/goal-controller.ts:245`) and the
   module contract: *"a single permit serializes read-modify-write sections so parallel tool calls cannot
   interleave snapshots"* (file header). Every mutating entry point is `gate.withPermit(...)`
   (`EXT:src/services/goal-controller.ts:380`, `EXT:src/services/goal-controller.ts:484`, `EXT:src/services/goal-controller.ts:537`, `EXT:src/services/goal-controller.ts:570`, `EXT:src/services/goal-controller.ts:743`).
2. **Reads happen inside the permit.** `load(input)` is called inside each gated generator (`EXT:src/services/goal-controller.ts:487`, `EXT:src/services/goal-controller.ts:540`,
   `EXT:src/services/goal-controller.ts:747`), and `GoalContextInput` documents the invariant: *"`readBranch` and `appendEntry` run inside the
   engine's critical section and must address the same session"* (`EXT:src/domain/goal.ts:306-315`).
3. **Writes are synchronous and append-only.** `persistSnapshot` wraps a sync `appendEntry`
   (`EXT:src/services/goal-repository.ts:141-153`); Pi appends one JSONL line synchronously, and the loader skips malformed
   lines. A crash can lose at most the newest snapshot; the previous one is still authoritative
   (newest-first scan, `EXT:src/services/goal-repository.ts:92-112`).
4. **One continuation per boundary.** `continue: shouldContinue` with last-writer-wins
   (`PI:dist/core/extensions/runner.js:762-778`) and exactly one `agent.continue()` after the decision
   (`PI:dist/core/agent-session.js:1457-1461`).
5. **Retries do not re-enter the boundary.** `_handlePostAgentRun` continues the run itself
   (`PI:dist/core/agent-session.js:1531-1564`); the boundary only runs when the loop is about to settle.
6. **Aborted runs never reach the boundary.** The loop checks `_agentRunAbortRequested` before the event
   (`PI:dist/core/agent-session.js:1457`), and an aborted or errored turn ends the low-level loop
   (`PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:148-159`). Interrupt handling therefore lives only in `agent_settled`, as documented.
7. **Tools cannot outlive their run.** The parallel executor awaits `Promise.all` of every started tool
   (`PI:node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:463`), so a stale tool cannot mutate state after the session moved on (Q6).
8. **A new goal cannot be born under a running tool.** Command `create` refuses unless idle
   (`EXT:src/adapters/pi-commands.ts:80`); the tool `create` refuses while an unfinished goal exists
   (`EXT:src/services/goal-controller.ts:757-767`).
9. **Duplicate dispatch at the same anchor is blocked.** `directivePending && lastDirectiveAnchorId ===
   assistantEntryId` → idle (`EXT:src/services/continuation-policy.ts:101-109`).
10. **Disposal fails safe.** A disposed `ManagedRuntime` returns `Failure(Die("ManagedRuntime disposed"))`;
    `run()` converts it to `{ok:false}` (`EXT:src/runtime.ts:95-114`), and the UI helpers swallow stale-ctx throws
    (`EXT:src/adapters/pi-ui.ts:64-90`). No crash, no partial write.
11. **No process-local state.** `GoalRuntime` owns all mutable state; the factory creates one per session
    (`EXT:src/index.ts:14-18`); `session_shutdown` disposes it (`EXT:src/adapters/pi-events.ts:167-169`).

## Deterministic test sketches

All sketches use the existing harness (`test/support/fake-host.ts` for adapters,
`test/engine.test.ts`'s `makeHarness` for the engine) and a fake clock where possible. None needs a live
provider.

1. `aborted-continuation-is-not-a-turn` (F1). Given an active goal and a boundary that returns one
   continuation directive, when the directive is committed and `agent_settled{aborted:true}` follows with no
   assistant entry, then `goalTurns`, `continuationCount`, and `idleTurns` are unchanged, and three such
   abandoned directives do not trip the no-progress breaker. Frozen and head behavior: 3 idle turns → paused
   (F1 is still open).
2. `pause-after-decision-aborts-the-turn` (F2). Given a boundary result with `continue:true`, when `/goal
   pause` is applied before the draft is committed, then the subsequent `agent_start` aborts the run
   (`ctx.abort()` recorded) and no further directive is issued for the paused goal. Still open at the head.
3. `escape-then-compact-stays-paused` (F3). Given `agent_settled{aborted:true}` at t=0, when
   `session_before_compact{reason:"manual"}` arrives at t=1000 ms, then the goal stays `paused` with reason
   `interrupted` and no snapshot transitions to `active`. Frozen-revision behavior: resumes at t=1000 ms and
   stays paused at t=2000 ms. Head behavior: stays paused in both cases.
4. `paused-goal-does-not-accrue-active-time` (F6). Given a paused goal, when `agent_start` / 40 ms /
   `agent_settled` runs, then the persisted `activeMs` is unchanged. Frozen-revision behavior: +41 ms; the head
   fixes it.
5. `quit-mid-run-persists-the-settle` (F7). Given an open `agent_start` span, when `session_shutdown` runs and
   then `agent_settled{aborted:true}` arrives, then the snapshot is persisted (interrupt/activeMs) and the
   goal is `paused`. Frozen behavior: no snapshot, `active`, one swallowed error. Still open at the head.
6. `slow-manual-compaction-keeps-the-pause` (F4). Given an interrupt pause at t=0 and a manual compaction at
   t=5000 ms, then the goal stays paused (documents the fail-closed contract).
7. `stale-tool-call-cannot-touch-a-new-goal` (F8). Given goal G1 completed, G2 created, and a queued
   `update_goal complete` with no goal id, when it runs after G2 creation, then it is rejected for missing
   evidence or a goal-id mismatch; G2 is not completed.
8. `parallel-mutations-keep-one-winner` (Q3). Given `pause` and `update_goal complete` started
   simultaneously, when both effects settle, then the final status is one of the two legal outcomes for a
   deterministic arrival order and the revision is monotonic. This locks the current last-writer semantic.
9. `budget-raise-has-one-final-state` (F9). Given a `setBudget` raise on a budget-limited goal, when
   `setBudget` persists and the process dies before `resume`, then `/goal resume` still succeeds and the
   status is explainable from the history (documents the two-entry window).

## Reproductions (scratch, `/tmp`)

- `/tmp/effprobe/race.ts` — F1: abandoned directive + resume → no-progress stop with 3 idle turns.
- `/tmp/effprobe/active.ts` — F6: paused goal `activeMs` 0 → 41 → 61 ms across user runs.
- `/tmp/effprobe/quit.ts` — F7: `session_shutdown` then `agent_settled` → no snapshot, status `active`,
  `Goal bookkeeping failed: ManagedRuntime disposed`.
- `/tmp/effprobe/probe.mjs` — dispose semantics of Effect 4.0.0-beta.98 (`Failure`, later use → `Die`).
- `/tmp/effprobe/rt2.ts` — Q7: two `agent_start`s then one `endRun` return the whole span, not the last
  segment.

## Unverified / needs a live run

- Whether a real TUI user can type `/compact` within 1.5 s of Escape is a UX measurement, not a code fact
  (UNVERIFIED). The race is real; its frequency is not measured.
- Whether the editor/AI dispatches a command handler concurrently with a boundary handler is inferred from
  Pi executing extension commands during streaming (`PI:dist/core/agent-session.js:1640-1647`) and from the
  handler being async. The exact interleaving in the TUI event loop was not reproduced live (UNVERIFIED);
  the fix (re-check at `agent_start`) is safe regardless.
- The suite failure in `the turn cap stops the loop with a wrap-up` was not diagnosed; it is outside this
  audit and probably belongs to the in-flight policy/progress edits.
