# F2: Effect 4 usage and code quality review

Reviewer: adversarial reviewer #2 (did not write this code).
Scope: `src/**/*.ts`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`.

Reviewed revision: 2026-10-31 17:34 (-03). The extension is untracked in git and was being edited
while I reviewed (touched at 17:16, 17:25, 17:28, 17:30, 17:33). Every finding below was re-verified
against the revision with this aggregate hash:

```
cd extensions/goals && find src -name '*.ts' | sort | xargs md5sum && md5sum docs/ARCHITECTURE.md
# aggregate (md5 of the md5sum output): 6aef583eafb45b2430cafbef849123f4
```

Line numbers refer to that revision only; each finding also names the symbol so it survives
renumbering. Features that landed during the review (`PI_GOAL_DEFAULT_BUDGET`,
`PI_GOAL_MAX_BUDGET`, `PI_GOAL_ALLOW_UNATTENDED_CREATE`, the rewritten `describeExit`) were reviewed
only for the points listed here.

## Verdict

**SHIP WITH FIXES.**

The architecture is sound: the transcript is the single source of truth, the transition function is
pure, the policy is pure, and the Pi adapters hold no state of their own. The Effect layer is used
correctly for the parts that matter: effects are built lazily, the two mutating methods keep a
narrow `GoalError` channel, `Effect.try` converts session-write throws into `GoalPersistenceError`,
and one `ManagedRuntime` per extension load is disposed on shutdown. There is no `any`, no non-null
assertion, no unhandled promise, and failures are converted to messages rather than thrown.

Four issues are user-visible and should be fixed before shipping: the no-progress breaker can be
silently disabled by configuration, an interrupt pause can be silently undone by an unrelated
`/compact`, a manual `/compact` leaves the goal active but never starts the next run, and the
configured budget ceiling is bypassed by `/goal budget`. The rest are silent-failure, dead-code, and
duplication findings that are cheaper to fix now than after the file ownership is forgotten.

## Findings

| ID     | Sev    | Category     | File:line (symbol)                                             | Problem                                                                                                                                                                                | Fix                                                                                                                       |
| ------ | ------ | ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F2-01  | HIGH   | arch/safety  | `src/services/progress-tracker.ts:28,149` (`MAX_IDLE_TURNS`, `deriveTurnStats`) + `src/runtime.ts:34-35,58-59` | `idleTurns` is clamped to 10 but `PI_GOAL_MAX_IDLE_TURNS` accepts any positive integer. At 11 or more the no-progress breaker never fires and the goal runs to the turn cap.           | Remove the clamp or clamp and report the configured value; add a test with `maxIdleTurns > MAX_IDLE_TURNS`.               |
| F2-02  | HIGH   | arch/safety  | `src/adapters/pi-events.ts:163-174` (`session_before_compact`)   | Manual compaction is detected by a 5s wall-clock window (`hasRecentInterrupt`). Escape, then `/compact` within 5s, resumes a goal the user just paused; a compaction 6s later leaves it paused. | Use an explicit compaction intent flag, or correlate on the compaction event only, never on time.                         |
| F2-03  | HIGH   | arch/behavior| `src/adapters/pi-events.ts:163-174` (`session_before_compact`)   | After a manual `/compact` aborts a goal run, `clearInterrupt` makes the goal `active` but nothing starts a run. The goal stalls until the next user message, while the notice says it was "kept active". | Handle `session_compact` with `reason === "manual"` and start one continuation there, or say "active but stopped".          |
| F2-04  | MEDIUM | arch/safety  | `src/services/goal-controller.ts:335-341,632,815` (`budgetTooLarge`) | `PI_GOAL_MAX_BUDGET` is documented as a ceiling for "any goal budget, from the command or the tool" (`src/runtime.ts:28-29`) but only the two create paths call `budgetTooLarge`. `/goal budget 999999999` bypasses it. | Call `budgetTooLarge` before the `setBudget` transition (or enforce it in `transition()` for every budget input).          |
| F2-05  | MEDIUM | effect/data  | `src/services/goal-controller.ts:532` (`settle`)                | Active time is persisted for any goal that is not `complete`, so `activeMs` grows while the goal is paused or blocked, contradicting `SettleInput`'s own doc at `:72-76`. Proven: paused goal, unrelated run, `activeMs` 0 to 60000. | Gate on the goal having been active for the run, or at least on `snapshot.status === "active"`.                            |
| F2-06  | MEDIUM | error        | `src/runtime.ts:70-73,151` (`EngineRun`, `run`)                 | All failures are flattened to `message`; `error` is always a fresh `new Error(...)`, so the `GoalError` arm is unreachable, and `GoalPersistenceError.detail` (`goal-repository.ts:129,152`) is never surfaced or logged. | Carry the typed error/tag (or the `Exit`) to adapters, or delete the field; include `detail` in the surfaced message.       |
| F2-07  | MEDIUM | error        | `src/adapters/pi-events.ts:43-60` (`session_start`)             | `GoalLoadIssue`s are read once at startup. A snapshot that becomes corrupt mid-session loads as "no goal", so the goal silently stops; the defined `goal.diagnostic` event is never emitted. | Return issues from `settle`/`decideBoundary` and notify once per distinct issue.                                           |
| F2-08  | MEDIUM | error        | `src/adapters/pi-events.ts:62-69,170-173`                       | `session_tree` and `session_before_compact` drop `!result.ok` without a notice, so a failed restore or a failed unpause is invisible.                                                  | Notify on failure like the other handlers do.                                                                              |
| F2-09  | MEDIUM | architecture | `src/domain/events.ts:9-61`, `src/services/goal-controller.ts:78-82,297,505-556` | The event channel has no consumer: transitions build `GoalEvent[]`, `settle` returns them, no adapter reads `SettleResult.events`, and `describeGoalEvent` is unused.                     | Delete the event channel, or drive notices from it and delete the hand-written notices.                                    |
| F2-10  | MEDIUM | types        | `src/adapters/pi-tools.ts:17-32,70-93`                          | The tool payload shape exists three times (`GoalToolPayload`, `GoalOutputSchema`, `toJsonValue`). A new field in `buildToolPayload` is silently dropped from `structuredContent`; `status` is any string while the domain has six statuses. | Derive the JSON copy from one table and assert key coverage in a test; type the schema with the six literals.              |
| F2-11  | MEDIUM | architecture | `src/domain/transitions.ts:89`, `src/services/goal-controller.ts:638,821` | The "unfinished goal" create rule is enforced three times with three messages, so changing it in `transition()` does not change engine behavior.                                          | Keep the rule in `transition()` and surface its error.                                                                      |
| F2-12  | LOW    | effect       | `src/services/goal-controller.ts:1-10,253` (`Semaphore`)        | The header claims a permit serializes read-modify-write, but every guarded effect is synchronous (`Effect.sync`, `Effect.try` over synchronous session writes), so the permit is never contended. | Delete the semaphore, or keep it as stated insurance and correct the comment.                                              |
| F2-13  | LOW    | readability  | `src/services/goal-controller.ts:307-326` (`attempt`)           | `attempt` is a vague name for "run a transition and turn its typed failure into a string", used six times.                                                                              | Rename to `tryTransition` and document that it swallows.                                                                   |
| F2-14  | LOW    | readability  | `src/services/goal-controller.ts:275-304` (`runTransition`)     | Every transition re-derives turn stats and usage, after `load`/`deriveGoalView` already did. A settle that pauses and records time runs up to eight derivations plus three `readBranch` copies. | Pass the derived metrics into `runTransition`, or derive once per engine call.                                              |
| F2-15  | LOW    | readability  | `src/services/goal-controller.ts:384,493,579,613,652,713,731,750,835,891,925,945` | `applied.snapshot ? deriveGoalView(...) : null` is repeated twelve times, with two unconditional sites (`:546`, `:792`) and two different fallbacks.                                      | Add `applyAndView(command)` returning `{ snapshot, view, events }`.                                                         |
| F2-16  | LOW    | types        | `src/domain/transitions.ts:395-402`                             | The post-switch fallback builds an `InvalidTransitionError` with `to: current?.status ?? "active"`, so adding a `TransitionCommand` member compiles and fails at runtime with a misleading endpoint. | End with `const exhaustive: never = command` (or `default: command satisfies never`).                                     |
| F2-17  | LOW    | types        | `src/services/goal-controller.ts:348-358`, `src/adapters/pi-tools.ts:149` | `GoalActionResult.ok` is always `true` and `.snapshot` is never read, so `isError: result.value.ok ? undefined : true` is always `undefined`.                                          | Drop `ok`, read `view.snapshot`, set `isError` only in the failure path.                                                    |
| F2-18  | LOW    | readability  | `src/runtime.ts:1-7`, `src/domain/errors.ts:1-7,29`, `src/domain/goal.ts:317-322` | Stale justifications: runtime claims to track "whether a manual compaction just aborted it" (state removed); errors claim adapters branch on `_tag`/`code` (they do not); `elapsedMs` says "never persisted" while the complete path persists it. | Rewrite the four comments to match the code.                                                                               |
| F2-19  | LOW    | readability  | `src/domain/goal.ts:27-30`, `src/runtime.ts:34-35`              | Default turn and idle limits are defined twice; the domain copies are unused, so editing them has no effect.                                                                              | Import one source of truth.                                                                                                |
| F2-20  | LOW    | readability  | `src/adapters/pi-commands.ts:272`                               | Any unrecognized first token is an objective, so `/goal budgte 1000` creates a goal and starts a paying run instead of reporting a bad subcommand.                                       | Add a "did you mean" check against `SUBCOMMANDS` (prefix or edit distance) before creating.                                |
| F2-21  | LOW    | readability  | `src/adapters/pi-commands.ts:75,147`                            | `validateObjective` runs in the adapter and again in `transition()`; `validateBudgetTokens` runs after `parseBudgetArgument` already guarantees a positive integer or null, so its failure branch is dead. | Delete both adapter checks and surface the engine message.                                                                 |
| F2-22  | LOW    | architecture | `src/adapters/pi-events.ts:43-60`                               | `session_start` runs `rehydrate` and then a second full `view` only to read `issues` (two branch scans, two metric derivations), and the notice claims "an older valid one was restored" even when nothing was restored. | Return `issues` from `rehydrate` and word the notice conditionally.                                                        |
| F2-23  | LOW    | error        | `src/runtime.ts:158-162`, `src/adapters/pi-commands.ts:194,224` | `runtime.view()` maps every failure to `null`, so `/goal edit` and `/goal history` report "No goal set" when the read itself failed.                                                     | Return `EngineRun` and distinguish no-goal from read failure.                                                              |
| F2-24  | LOW    | readability  | `src/runtime.ts:75-106` (`describeExit`)                        | Now that defects are clipped, the remaining issues are small: `describeExit` is computed twice on the same exit (`:151`), and `messageOf` still returns `[object Object]` for a message-less object. | Compute once; fall back to `Cause.pretty`/`JSON.stringify` instead of `String(value)`.                                     |
| F2-25  | LOW    | dead code    | see list below                                                  | Eleven exported symbols and one barrel have no production consumer.                                                                                                                      | Delete.                                                                                                                    |
| F2-26  | LOW    | testability  | `test/engine.test.ts:30-65`                                     | The engine suite re-implements `GoalRuntime.run` (same `Exit`/`Option`/`Cause` collapsing), so the production error renderer is only covered through the fake host and the two can drift. | Move the run helper into a module the tests import.                                                                        |
| F2-27  | LOW    | repo         | `package.json:workspaces`, `tsconfig.extensions.json`, `extensions/goals/package.json:10` | `goals` is not a workspace and not in the extension tsconfig, so `npm run check:extensions` does not cover it; `tsc` and `prettier` are not installed in the workspace, so `npm run check` and `format:check` fail before reaching this code. | Add the extension to the workspace and tsconfig, then run the checks.                                                      |

Dead code referenced by F2-25 (unused outside the definition; test-only references do not count):

- `src/runtime.ts:215-217` `isGoalPayload` (also forces the `GoalToolPayload` import).
- `src/domain/errors.ts:74-76` `rejectionCode`, `:79-82` `TransitionEndpoints`.
- `src/domain/events.ts:47-61` `describeGoalEvent` (see F2-09 for the whole event channel).
- `src/domain/goal.ts:399-405` `isContinuable` and `isUnfinished`.
- `src/adapters/pi-events.ts:182-184` `goalContext`.
- `src/adapters/pi-tools.ts:257` `GOAL_TOOL_HELP`, and its `GOAL_USAGE` import at `:14`.
- `src/adapters/host.ts:16` `GoalHostContext`, which also uses a fragile `Parameters<Parameters<...>>`
  derivation that breaks if `on` gains an overload.
- `src/adapters/directive.ts:52-57` `withDirective`, a one-line wrapper used twice.
- `src/services/goal-controller.ts:217-228` `trailingDirective`, which duplicates the policy dedupe
  and is the only reason this file imports `readDirectiveDetails` and `GOAL_DIRECTIVE_CUSTOM_TYPE`.
- `src/index.ts:21-22` re-exports of `loadGoalsConfig` and `GOAL_USAGE`.
- `src/prompts/index.ts`, an unused barrel kept alive by `test/prompts.test.ts`.

## Details

### F2-01 The no-progress breaker can be configured out of existence (HIGH)

`src/services/progress-tracker.ts:27-28`:

```ts
/** Longest idle streak the breaker can observe; 10 is far past any threshold. */
const MAX_IDLE_TURNS = 10;
```

```ts
for (let index = turns.length - 1; index >= 0 && idleTurns < MAX_IDLE_TURNS; index -= 1) {
```

`src/runtime.ts:58-59` accepts any positive integer for `PI_GOAL_MAX_IDLE_TURNS` (`readPositiveInt`
only rejects zero, negatives, and non-finite values), and
`src/services/continuation-policy.ts:117` compares `metrics.idleTurns >= input.maxIdleTurns`. With
`PI_GOAL_MAX_IDLE_TURNS=11` the comparison can never be true. Verified: 12 evidence-free goal turns
produce `idleTurns = 10`; the policy returns `no-progress` for `maxIdleTurns` 3 and 10, and
`continue:active` for 11 and 20. The goal then runs to the 200-turn cap instead of stopping on a
stall. The comment "10 is far past any threshold" is only true for the default of 3.

### F2-02 An unrelated `/compact` can resume a goal the user interrupted (HIGH)

`src/adapters/pi-events.ts:163-174`:

```ts
pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason !== "manual") return;
    if (!runtime.hasRecentInterrupt()) return;
    runtime.clearInterrupt();
```

`hasRecentInterrupt` defaults to a 5000 ms window measured from any aborted `agent_settled`. I
confirmed against the running CLI (pi 1.4.0, `dist/core/agent-session.js:683-690`, and `compact()`
which begins with `await this.abort()`) that `agent_settled{aborted:true}` fires before
`session_before_compact`, so the intended path works. The failure modes are the two edges:

- Escape (user stops the goal), then `/compact` within 5s: `clearInterrupt` resumes the goal. The
  user never asked to resume, and the design rule is "pause requires an explicit user request"
  (`docs/ARCHITECTURE.md:26`). The next user message silently restarts autonomous work.
- `/compact` more than 5s after the abort: the goal stays paused even though this is exactly the
  case the code tries to detect.

An explicit intent flag is deterministic; a time window is not. The earlier
`markManualCompaction`/`consumeManualCompaction` pair was removed during this review, which removed
the API but not the heuristic.

### F2-03 A manual compaction resumes the goal but never starts the next run (HIGH)

After the undo, nothing triggers a turn:

```ts
if (result.ok) {
    renderGoalUi(ctx, result.value.view);
    notifyGoal(ctx, "Goal kept active across the manual compaction.", "info");
}
```

Pi's manual compaction "never retries or continues the interrupted agent turn"
(`dist/core/agent-session.js` `compact()` doc comment), and `agent_before_settle` is skipped for the
aborted run (`docs/research/C-pi-extension-api.md:948`). So the status is `active`, the status line
says `goal ...`, and the loop is stopped until the user types. Either start one continuation after
the compaction completes (`session_compact` with `reason === "manual"`, deferring the
`sendMessage(..., { triggerTurn: true })` to a later tick so it cannot race the compaction tail), or
say "goal is active but stopped; send a message or /goal resume". There is no `session_compact`
handler today (`test/wiring-drift.test.ts` pins the handler list).

### F2-04 The budget ceiling is enforced only on goal creation (MEDIUM)

`src/runtime.ts:28-29` documents `maxBudgetTokens` as a "hard ceiling for any goal budget, from the
command or the tool", and the engine defines the check:

```ts
const budgetTooLarge = (budgetTokens: number | null): GoalError | null =>
    budgetTokens !== null && budgetTokens > maxBudgetTokens
        ? new GoalRejectedError({ ... code: "invalid-budget" })
        : null;
```

The only call sites are the two create paths (`src/services/goal-controller.ts:632` for `/goal`,
`:815` for `create_goal`). The `setBudget` branch (`:770-796`) calls `transition()` directly, and
`validateBudgetTokens` only checks positivity, so `/goal budget 999999999` overrides the configured
ceiling and can also un-stick a `budgetLimited` goal beyond the intended cap. Put the check in
`transition()`'s `setBudget` case, where every caller inherits it.

### F2-05 `activeMs` is charged to paused and blocked goals (MEDIUM)

`src/services/goal-controller.ts:532`:

```ts
if (input.activeMsDelta > 0 && snapshot.status !== "complete") {
```

`SettleInput.activeMsDelta` is documented as "Wall-clock milliseconds the finished run spent while
the goal was active" (`src/services/goal-controller.ts:72-76`) and `ARCHITECTURE.md:130` says the
time is added "while a goal is active", but the predicate accepts `paused`, `blocked`,
`usageLimited`, and `budgetLimited`. Verified with the real engine layer: create, pause, then
`settle` with `activeMsDelta: 60_000` on a paused goal gives `activeMs` 0 to 60000 and the status
stays `paused`. That number is what `/goal status`, the widget, `timeUsedSeconds`, and the
completion report show.

### F2-06 Typed failures are flattened at the runtime boundary (MEDIUM)

```ts
return { ok: false, message: describeExit(exit), error: new Error(describeExit(exit)) };
```

`EngineRun` is typed `GoalError | Error` on the failure arm, but the `GoalError` arm can never be
produced: every failure becomes a plain `Error` built from the message, and adapters read only
`message`. Consequences:

- `GoalPersistenceError.detail` (`src/services/goal-repository.ts:129,152`) is discarded. The user
  sees "Failed to persist goal snapshot" with no cause, and nothing logs the cause.
- `GoalRejectedError.code` and `GoalValidationError.field` cannot influence behavior. The comment in
  `src/domain/errors.ts:1-7` ("adapters can branch on `_tag` or on the rejection `code`") describes a
  contract no adapter implements; `rejectionCode` is dead.

Either keep the typed error (return the `Exit`, or `{ tag, code, detail }`) or delete the field and
stop advertising a typed boundary.

### F2-07 Snapshot corruption after startup is silent (MEDIUM)

`loadLatestSnapshot` collects `GoalLoadIssue`s on every load and `view` returns them
(`src/services/goal-controller.ts:365`), but the only consumer is `session_start`, which immediately
re-reads the view (`src/adapters/pi-events.ts:52-59`). If an entry is corrupted mid session (bad
write, unsupported version from a newer build), `decideBoundary` and `settle` load
`snapshot: null` and do nothing, and the user sees a goal that silently stopped. `GoalEvent` already
defines `goal.diagnostic` (`src/domain/events.ts:41-44`) and it is never emitted. Return issues from
the observation methods and notify once per distinct issue.

### F2-08 Two handlers swallow failures (MEDIUM)

```ts
pi.on("session_tree", async (_event, ctx) => {
    const result = await runtime.run((engine) => engine.rehydrate(...));
    if (result.ok) {
        renderGoalUi(ctx, result.value.view);
    }
});
```

`session_before_compact` does the same (`if (result.ok)`, no else). Every other handler notifies on
failure, so these two are inconsistent rather than deliberate. A failed `/tree` restore leaves the
UI showing the previous branch's goal with no warning.

### F2-09 The event channel has no consumer (MEDIUM)

`transition()` returns `events`, `runTransition` threads them, `settle` collects them into
`SettleResult.events` (`src/services/goal-controller.ts:78-82`), and `GoalEvent` defines six
variants plus `describeGoalEvent`. No adapter reads `SettleResult.events`
(`src/adapters/pi-events.ts:81-96` uses only `view` and `notice`), and `describeGoalEvent` has zero
references. The status record already exists twice: `snapshot.history` and the notices the adapters
build by hand. This is roughly 120 lines across `src/domain/events.ts`,
`src/domain/transitions.ts`, and `src/services/goal-controller.ts` kept alive by tests only. Either
delete it or make it the single source of notices.

### F2-10 The tool payload shape is written three times (MEDIUM)

`GoalToolPayload` (`src/domain/goal.ts:363-377`), the TypeBox `GoalObjectSchema`
(`src/adapters/pi-tools.ts:17-26`), and the hand-written copy in `toJsonValue` (`:70-93`) must agree.
`toJsonValue` enumerates fields explicitly, so a field added to `buildToolPayload` is silently absent
from `structuredContent` while present in `details`, and a `status` that is not one of the six domain
statuses passes `outputSchema`. Add a test that walks the keys of `buildToolPayload(view)` and
asserts `structuredContent` has them, or derive both from one table.

### F2-11 The create rule is enforced three times (MEDIUM)

`transition()` create (`src/domain/transitions.ts:89`) refuses when an unfinished goal exists.
`runCommand` create (`src/services/goal-controller.ts:638`) and `runTool` create (`:821`) refuse
before calling it with their own `GoalConflictError` messages. The adapter message wins, so the rule
actually enforced is the engine copy, and the transition copy is dead for these paths (but live for
any future caller). Pick one owner.

### F2-12 The semaphore cannot contend (LOW)

```
 * own; a single permit serializes read-modify-write sections so parallel tool
 * calls cannot interleave snapshots.
```

Everything inside `gate.withPermit` is synchronous: `Effect.sync` for loads, `Effect.try` around
`pi.appendEntry` (session writes are synchronous in pi 1.4.0, `appendEntry` returns `void`), pure
transition and prompt builders. There is no await, sleep, or fork in the critical section, so two
engine calls cannot interleave regardless of the permit; the single-threaded event loop already
provides the guarantee. `Semaphore.makeUnsafe(1)` is the correct mutex in beta.98
(`docs/research/D-effect-v4.md:360`), so this is not API misuse, only an unused guarantee. If it
stays as insurance for a future async write, the comment must say that.

### F2-13, F2-14, F2-15 Duplication in the controller (LOW)

```ts
const runTransition = (...) => Effect.gen(function* () {
    const goalTurns = snapshot === null ? 0 : deriveTurnStats(branch, snapshot.goalId).goalTurns;
```

`deriveTurnStats` and `deriveUsage` run again for every transition after `load`/`deriveGoalView`
already computed both for the same branch; a settle that pauses and records time performs eight
derivations and three `readBranch` copies. And:

```ts
const nextView = applied.snapshot
    ? deriveGoalView(applied.snapshot, input.readBranch())
    : null;
```

appears twelve times with small inconsistencies (`:546` and `:792` derive unconditionally;
`rehydrate` and `clearInterrupt` fall back to the previous view instead of `null`). One
`applyAndView(command, input)` returning `{ snapshot, view, events }`, plus passing the derived
metrics into the transition context, removes both.

### F2-16 Exhaustiveness is not checked (LOW)

```ts
// Only reachable from untyped callers; keeps the function total without throwing.
return failure(
    new InvalidTransitionError({
        message: "unsupported goal transition command",
        from: current?.status ?? null,
        to: current?.status ?? "active",
    }),
);
```

Today this is unreachable, but it is also the only thing that runs if a new `TransitionCommand`
member is added without a case, and the error it builds is wrong (`to` is the current status). Use a
`never` check so the compiler reports the missing case.

### F2-25, F2-26 Dead exports and test duplication (LOW)

The dead list is mechanical. The testability point deserves one sentence: the engine is testable
without Pi (good), but `test/engine.test.ts:30-65` copies `GoalRuntime.run` and `describeExit`
instead of importing them, because `GoalRuntime` requires an `ExtensionAPI`. The production error
renderer is therefore only covered indirectly through the fake host, and a change to `describeExit`
does not show up in the engine suite.

## Fixed during this review (do not re-report)

These were findings when I started; they were fixed while I reviewed, and I re-verified the fixed
behavior:

- The turn cap mapped to `budget-exhausted` (`budgetLimited`) with an impossible "raise the cap"
  resume. It now pauses with `pauseReason: "turn-cap"`, compares `auditedTurns`, and a resume re-arms
  the allowance. Verified: boundary 2 returns `stopped` with status `paused`, and `resume` succeeds.
- The dead `manualCompaction` flag (`BoundaryFacts.manualCompaction`, `SettleInput.manualCompaction`,
  `GoalRuntime.markManualCompaction`/`consumeManualCompaction`, and the policy branch) was removed.
- No-op transitions no longer append a duplicate snapshot entry
  (`src/services/goal-controller.ts:297-299`).
- `describeExit` was rewritten to clip defects to one safe line and use `Cause.prettyErrors`; only
  the double evaluation (F2-24) remains.

## Keep as is

Do not churn these while fixing the findings:

1. Transcript as the single source of truth, full snapshots plus a tombstone, newest-first read that
   stops at the tombstone, and schema validation with recorded issues
   (`src/services/goal-repository.ts`). `Schema.decodeUnknownResult` is the correct beta.98 API.
2. `GoalContextInput` carrying a `readBranch` closure and an `appendEntry` closure bound to the same
   session (`src/domain/goal.ts:313-323`). This is why no branch mismatch is possible, and it is the
   seam that lets the engine be tested without Pi.
3. Context.Service + `Layer.effect` + one `ManagedRuntime` per extension load, disposed on
   `session_shutdown`, layer built lazily (`effect/dist/ManagedRuntime.js:84-108`). This matches
   `extensions/background-terminals/src/runtime.ts` and `extensions/git-info/src/runtime.ts`; the
   lifecycle is correct.
4. Effects are built lazily: `view` is `Effect.sync`, mutating methods build their `Effect.gen` at
   call time, and nothing runs at module load or layer construction except creating the semaphore
   and reading config.
5. The pure `transition()` returning `TransitionResult`, never throwing, and bumping `revision`
   through one `commit()`.
6. The pure `decideContinuation()` policy with injected prompt builders, ordered gates, and the
   dedupe anchor on `lastDirectiveAnchorId`.
7. Deriving usage and turns from the branch with `usageStartEntryId` as the charge boundary, and
   `chargeableTokens = input + cacheWrite + output` with `cacheRead` reported but not billed.
8. `Effect.try` around session writes converting throws into `GoalPersistenceError`, and
   `Effect.catch` (the beta.98 name; `catchAll` is gone) in `attempt` to keep observation paths total.
9. The structural `settledAborted` read (`src/adapters/pi-events.ts:38-40`). It is required: the
   workspace resolves `@earendil-works/pi-coding-agent` 1.0.0, whose `AgentSettledEvent` has no
   `aborted` field, while the running CLI is 1.4.0, which does. Keep it until the workspace
   dependency is bumped.
10. `Schema.TaggedErrorClass` errors with `Schema.Literals(GOAL_STATUSES)` payloads, so a persisted
    status cannot decode to anything else.
11. Thin `src/index.ts` (registration only) and best-effort UI wrappers in `src/adapters/pi-ui.ts`.
12. Prompt assembly isolated in `src/prompts/*` with `renderTemplate` failing loudly on an unresolved
    placeholder and `escapeObjective` for the untrusted objective.

## `docs/ARCHITECTURE.md` lines that no longer match the code

1. `:43` "any except complete --clear--> (no goal)". `clear` is not a transition and is allowed on
   `complete` goals (`src/services/goal-controller.ts:681-692`).
2. `:35-46` omits the `forked` command (to `paused`) and `touch` (activeMs only) from the state table
   (`src/domain/transitions.ts:69-70,363-392`), and now the `turn-cap` pause reason.
3. `:55` "late events carrying another id are rejected". No command or event carries a goal id, so
   there is nothing to reject; a late `update_goal` applies to whatever goal is current.
4. `:59-60` "appended with `pi.appendEntry`". Writes go through `GoalContextInput.appendEntry`, bound
   to `pi.appendEntry` in `src/runtime.ts:130`; section 7 says this, section 3 does not.
5. `:66-67` "returns the newest entry that validates ... corrupt or unknown-version entries are
   skipped". A `goal-cleared` tombstone stops the scan and returns `snapshot: null, cleared: true`
   (`src/services/goal-repository.ts:98-100`); that rule is missing.
6. `:84` "`turn_end` is observation only". No `turn_end` handler exists; the registered events are
   `session_start`, `session_tree`, `agent_start`, `agent_settled`, `agent_before_settle`,
   `session_before_compact`, `session_shutdown` (`src/adapters/pi-events.ts:42-179`,
   `test/wiring-drift.test.ts:35-43`).
7. `:86` "decideBoundary({ branch, sessionId, now, facts })". The call takes `GoalContextInput`
   (`readBranch` closure, `appendEntry`, `sessionId`, `now`, optional `elapsedMs`) plus `facts`
   (`src/adapters/pi-events.ts:101-110`).
8. `:97` "display: false". The adapter passes `runtime.config.showDirectives`, true when
   `PI_GOAL_SHOW_DIRECTIVES=1` (`src/adapters/pi-events.ts:136,146`, `src/runtime.ts:60`).
9. `:110-111` "A manual `/compact` also aborts, so the adapter marks that case and the goal stays
   active with a notice." There is no marker any more; the adapter correlates through a 5s window and
   `clearInterrupt`, and no run is started (F2-02, F2-03).
10. `:130` "added on `agent_start` → `agent_settled` while a goal is active". It is added for any
    non-`complete` goal (`src/services/goal-controller.ts:532`).
11. `:145-147` "stops only when `idleTurns >= maxIdleTurns` ... `maxGoalTurns` (200) is an
    independent safety net". `idleTurns` is clamped to 10 (F2-01), and the turn cap now pauses with
    reason `turn-cap` after a dedicated wrap-up prompt, so it is no longer the budget path.
12. `:160-166` `TransitionContext` omits `readonly tokensUsed?: number`
    (`src/domain/transitions.ts:52`).
13. `:230` `parseSnapshot(data: unknown)` omits the optional `entryId` parameter
    (`src/services/goal-repository.ts:46-49`).
14. `:273` lists `escapeObjective` under `messages.ts`; it lives in `continuation.ts`, and
    `formatBudget` and `renderTemplate` are missing from the contract list.
15. `:298-299` "apply one transition ... and return". `complete` applies `touch` then `complete`
    (`src/services/goal-controller.ts:861-896`), and `setBudget` may apply `setBudget` then `resume`
    (`:770-796`).
16. `:153-155` "`src/domain/goal.ts` (contract, frozen) ... Already written." The file has since
    grown `GoalToolPayload`, `GOAL_ERROR_CODES`, `GOAL_CLEARED_CUSTOM_TYPE`, `readDirectiveDetails`,
    `DirectiveKind`, `elapsedMs`, and the `turn-cap` pause reason.
17. `:315` "an in-memory store". There is no store; the fake session is the persistence boundary
    (`test/support/fake-session.ts`).
18. `:317-321` `elapsedMs` "never persisted" contradicts `ARCHITECTURE.md:303-305` and the code: the
    complete path persists it with `touch` (`src/services/goal-controller.ts:872-880`). The code
    matches the architecture section, so the domain comment is the wrong one.

`docs/PLAN.md` is stale in the same way: the State column still shows Phase A rows `in_progress`,
Phases B-E `pending`/`TBD`, Phase F `pending` including this review, and Phases G-I without owners,
although the implementation and 224 tests exist. The file advertises that "every task records its
owner ... state and evidence", so it currently misleads the integrator about what is left.

## Verification

Ran:

- `node --experimental-strip-types --test test/*.test.ts` in the extension directory (17:31): 224
  tests, 16 suites, 224 pass, 0 fail.
- Probe A (`/tmp/f2/probe.ts`, imports the real engine layer): create, pause, `settle` with
  `activeMsDelta: 60_000` gives status `paused`, `activeMs` 60000 (F2-05).
- Probe B (`/tmp/f2/probe5.ts`): 12 evidence-free goal turns give `idleTurns = 10`; the policy
  returns `no-progress` at `maxIdleTurns` 3 and 10, and `continue` at 11 and 20 (F2-01).
- Probe C (`/tmp/f2/probe3.ts`): the turn-cap flow, used to confirm the concurrent fix (resume now
  succeeds).
- Read the installed `.d.ts` for every Effect API claim: `Semaphore.makeUnsafe`/`withPermit`
  (`effect/dist/Semaphore.d.ts:175`, `:90`), `ManagedRuntime.make` and its lazy build
  (`dist/ManagedRuntime.d.ts:242`, `dist/ManagedRuntime.js:84-108`), `Effect.catch` as the beta.98
  name (`dist/Effect.d.ts:3987-4062`), `Effect.try` (`:2082`), `Layer.effect` and `Layer<ROut, E,
  RIn>` (`dist/Layer.d.ts:44,1063`), `Exit.findErrorOption` (`dist/Exit.d.ts:1315`), `Cause.pretty`
  (`dist/Cause.d.ts:1240`), `Schema.decodeUnknownResult` (`dist/Schema.d.ts:1247`).
- Read pi 1.4.0 (`~/.local/lib/node_modules/@earendil-works/pi-coding-agent`) for event ordering,
  synchronous `appendEntry`, and the manual-compaction flow, and pi 1.0.0
  (`~/.pi/agent/node_modules`, the workspace resolution) for `AgentSettledEvent`.

Not run, and therefore not asserted:

- `tsc`. TypeScript is not installed in `~/.pi/agent`, so `npm run check` and
  `npm run check:extensions` cannot run and this review verified types by reading declarations, not
  by compiling. F2-16 and F2-17 are claims about what the compiler would and would not catch.
- `prettier --check`. Prettier is not installed either, so formatting was not verified.
- Loading the extension in a real Pi session and any end-to-end goal run (`docs/PLAN.md` D2, D3).
  F2-02 and F2-03 are derived from the installed CLI source, not from an observed run.
