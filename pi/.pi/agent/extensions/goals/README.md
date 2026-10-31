# pi-goals

`pi-goals` is a Pi extension that reproduces OpenAI Codex "thread goals": a persistent objective that the
agent keeps working toward across turns without a new user message. You set a goal with `/goal <objective>`;
the extension stores it in the session transcript, injects a continuation directive at each settlement
boundary while the goal is `active`, tracks token usage and goal turns from the transcript, accumulates
active time in the snapshot, and stops on completion, an audited block, a user pause, an interrupt, a
provider limit, a token budget, a turn cap, or a no-progress breaker. The prompt texts, tool contracts,
statuses, and budget rules follow Codex, with the deliberate differences listed in
[Differences from Codex](#differences-from-codex).

`docs/ARCHITECTURE.md` records the approved design and `docs/research/` holds the source evidence (Codex
commit `67f0994`, Pi 1.4.0, Effect 4). Where this README and the code disagree, the code is right; where
`ARCHITECTURE.md` and the code disagree, the code is right too.

## Status

Implemented and tested in this workspace. The code was built against Pi `1.4.0`, installed locally at
`/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent`, and Effect `4.0.0-beta.98`, which is
pinned in `~/.pi/agent/package.json` under both `dependencies` and `overrides`. The extension declares
`@earendil-works/pi-coding-agent` (`^1.4.0`), `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `effect`,
and `typebox` as peer dependencies.

## Install

The extension already lives at `~/.pi/agent/extensions/goals` and is loaded automatically. Its
`package.json` declares the entry point:

```json
{
    "pi": {
        "extensions": ["./src/index.ts"]
    }
}
```

Pi's discovery reads `extensions/*/package.json` and loads the paths declared under `pi.extensions`, so
`goals/src/index.ts` is registered and nothing under `src/` is loaded as a second extension (discovery is
one level deep).

No `npm install` is needed inside the extension. `effect`, `typebox`, and the `@earendil-works/*` packages
resolve from the workspace `node_modules` at `~/.pi/agent` by parent directory lookup, which is why they are
peer dependencies rather than local dependencies.

Load it explicitly for development, which skips discovery of everything else in the extension directory:

```sh
pi -e ~/.pi/agent/extensions/goals/src/index.ts
```

Remove the `-e` flag to use the discovered copy. Restarting Pi recreates the extension runtime from the
current source.

## Quick start

```sh
pi
```

Then, in the session:

```
/goal Add a health endpoint to the API, with a test, and verify it returns 200
```

On an idle session the goal is created as `active` and the first directive is sent immediately, so the
agent starts working without any further input. You then see:

- a notification: `Goal created. Working toward it now; /goal pause or Escape stops it.`
- the status line in the footer: `goal 3.1k · 0c · 12s`, which is charged tokens, continuation count, and
  accumulated active time (`goal paused ...` once the goal is not active)
- in the TUI, a two-line widget above the editor: the objective, then
  `status active · tokens unbounded · turns 1 · tools 3 · active 12s`

When the assistant turn settles, the extension writes a hidden continuation directive and Pi runs another
turn with the same objective. That repeats until the goal is complete, blocked, paused, or out of budget.
The model reports completion through `update_goal`; you do not send another message to keep it going.

Typical control commands:

```
/goal pause          stop continuing; the next boundary does not resume the goal
/goal status         full state: status, tokens, budget, turns, tools, active time, limits
/goal resume         continue from the current state with a fresh continuation directive
```

Escape during a run also pauses the goal (`paused`, reason `interrupted`), and `/goal resume` is the way
back. `/goal status` prints the metrics block; `/goal history` prints the status history kept in the
snapshot.

## Commands

Every subcommand is parsed in `src/adapters/pi-commands.ts`. The first word is a subcommand only when it
matches one of the names below; otherwise the whole argument string is the objective.

| Command                    | Effect                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/goal <objective>`        | Create an `active` goal and start the first goal turn. Uses `PI_GOAL_DEFAULT_BUDGET` when it is set, otherwise no budget. Refused if an unfinished goal exists; create is allowed over a `complete` goal. |
| `/goal`                    | Same as `/goal status`.                                                                                                                       |
| `/goal status`             | Render status line, widget, and a metrics block. With no goal, prints the usage text.                                                        |
| `/goal pause [reason]`     | Pause an `active` goal. Optional trailing text is stored as the pause detail. No-op while `budgetLimited`, invalid for other statuses.        |
| `/goal resume`             | Return `paused`, `blocked`, `usageLimited`, or `budgetLimited` to `active`, reset the turn-cap allowance, and send one continuation directive. Refused while charged tokens are at or above the budget. |
| `/goal clear`              | Append a `goal-cleared` tombstone, clear the status line, and report `Goal cleared.` The goal no longer loads; a new goal can be created at once. |
| `/goal edit`               | Open `ctx.ui.editor` with the current objective and replace it. Active goals receive an objective-updated directive. Requires an interactive session. |
| `/goal budget <tokens>`    | Set the token budget. Accepts a positive integer, or `off` / `none` / `unlimited` / `0` for no budget. Values above `PI_GOAL_MAX_BUDGET` are rejected. Setting a budget above current usage on a `budgetLimited` goal resumes it and continues. |
| `/goal history`            | Print the last status transitions stored in the snapshot (newest last).                                                                     |
| `/goal debug`              | Print a bounded JSON object: configuration, session and leaf ids, load issues, derived metrics, and the snapshot with its five newest history entries. |

Notes:

- `create`, `resume`, `edit`, and `budget` refuse to run while the agent is streaming; `pause` and `clear`
  are applied immediately because they are what a user reaches for when a run is going the wrong way.
- An objective whose first word is a subcommand cannot be created in one line (`/goal pause the queue`
  pauses the current goal with detail `the queue`).
- A first word that is close to a subcommand is treated as a typo: `/goal budgte 1000` reports
  `Did you mean /goal budget?` instead of creating a goal. Unknown words that are not close to a
  subcommand are objectives.
- Argument completion offers the subcommand names while the argument list is still a single word.
- `/goal clear` does not delete history. It appends a tombstone, which is the only way to represent removal
  in Pi's append-only session.

## Tools

Three tools are registered in `src/adapters/pi-tools.ts`. Their contracts mirror Codex, including the
`complete | blocked | paused` status enum. Tool results carry `goal`, `remainingTokens`, and
`completionBudgetReport` in `structuredContent`, and the same payload in `details`; a rejected call returns
`isError: true` with the reason so the model can continue working instead of stalling. The `goal` object
reports both `threadId` (the Pi session id, which is Codex's analogue) and `goalId`; timestamps are epoch
seconds. `completionBudgetReport` is null unless the goal is complete and has a budget or non-zero active
time.

| Tool          | Parameters                                                                                   | When the model may use it                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_goal`    | none                                                                                          | Anytime. Returns the current goal, token and elapsed-time usage, remaining budget, and the completion report when the goal is complete.                                                          |
| `create_goal` | `objective` (required, at most 4000 characters after trim), `token_budget` (optional positive integer, at most `PI_GOAL_MAX_BUDGET`) | Only when the user or system/developer instructions explicitly ask for a goal; not for ordinary tasks. Requires user authorization: an interactive confirmation, or in a non-interactive session the `PI_GOAL_ALLOW_UNATTENDED_CREATE=1` opt-in. Refused while any unfinished goal exists. `token_budget` only when explicitly requested. |
| `update_goal` | `status` (`complete`, `blocked`, `paused`), `reason` (optional string), `evidence` (optional string array) | `complete` only when the objective is achieved and verified from current state; `blocked` only after the same blocker repeats for at least three consecutive goal turns, with a reason and evidence; `paused` only at the user's explicit request. |

Gates enforced in code, not just in the prompt:

- `complete` requires at least one verification-grade tool result in the current goal turn: a read or
  search tool (`read`, `grep`, `find`, `ls`), a mutation (`write`, `edit`), or a shell command (`bash`,
  `powershell`). Planning tools such as `todowrite` and other extension tools do not satisfy it.
- `blocked` requires at least three audited goal turns since the goal was created or last resumed, a
  non-empty `reason`, and at least one non-empty `evidence` item. Otherwise `blocked-rejected`.
- `paused` requires an interactive confirmation (`ctx.ui.confirm`). Without a UI, or when the user declines,
  the adapter returns the unauthorized-pause message and the goal keeps running (`pause-unauthorized`).
- The gates are a floor, not proof. One qualifying tool call satisfies the completion gate whatever that
  call proved, and the blocked gate does not compare the reported blocker across turns; the prompt audit is
  what the model is expected to perform, and the code only refuses the clearly unevidenced request.
- `budgetLimited` wins over a pause or block request: both leave the status unchanged, and the tool
  result's structured `goal.status` reports `budgetLimited`.
- The model cannot resume, budget-limit, or usage-limit a goal. Those are user or system transitions.

## How continuation works

`agent_before_settle` in `src/adapters/pi-events.ts` is the only place that continues a goal. The engine
loads the newest snapshot from `ctx.sessionManager.getBranch()`, derives usage and turn metrics from the
same branch, applies the continuation policy, persists any resulting status change, and returns a decision.
For `continue` and `budget-wrapup`, the adapter appends one `custom_message` draft with
`customType: "goal-directive"` and `display: false` (or `true` when `PI_GOAL_SHOW_DIRECTIVES=1`), keeping any
drafts other handlers proposed, and returns `continue: true`; Pi converts that hidden custom message into a
user message, which is what makes the boundary continuation valid. Every directive stores `goalId`, `kind`,
`turn`, and `anchorEntryId` in its `details`. As a defense, the engine returns `idle` when the branch ends
with a directive anchored at the current assistant entry; in practice Pi dispatches one boundary per settled
run and each continuation produces a new assistant entry, so a boundary cannot continue twice. Continuation
stops when the status is not `active`, when `agent_settled` reports an abort, when the boundary outcome is an
error (usage limit maps to `usageLimited`, anything else to `paused` with reason `provider-error`), when the
token budget or the turn cap is reached, or when the no-progress breaker trips. Nothing here uses timers,
polling, or an external loop: the extension only reacts to Pi lifecycle events, and a settled run is the
only thing that can produce another turn. If the boundary decision itself fails, the adapter pauses the
goal with reason `internal-error` instead of leaving it `active` with nothing driving it.

## Behavior reference

### Statuses

| Status         | Meaning                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `active`       | The goal continues at every settlement boundary.                                                             |
| `paused`       | Stopped by the user, an interrupt, a provider error, no progress, a turn cap, a fork, or an internal failure. Resumable. |
| `blocked`      | The model reported an impasse after at least three audited goal turns. Resumable.                            |
| `usageLimited` | A provider usage/rate limit was detected from the error text. Resumable.                                     |
| `budgetLimited`| The token budget was reached. Resumable only after the budget changes.                                        |
| `complete`     | Terminal. `create` on a complete goal starts a new goal with a new id and reset counters.                    |

A goal id never changes after creation, and snapshots, directives, and derived turns all key off that id.

### Transitions

`src/domain/transitions.ts` is the only writer of snapshot fields. Invalid transitions return a typed error
and never throw.

- `create` from no goal or from `complete` sets `active`, stores the objective and budget, and records the
  branch leaf as `usageStartEntryId` so earlier usage is not charged.
- `active -> paused` for a user pause, an interrupt, a provider error, no progress, a turn cap, or an
  internal failure. A pause command is accepted only from `active`, is a no-op on a `budgetLimited` goal,
  and is invalid otherwise.
- `active -> blocked` only with at least three audited turns and a reason; the tool path also requires at
  least one evidence item.
- `active -> usageLimited` on a provider usage limit; `paused` and `blocked` can also move there, while
  `budgetLimited` stays `budgetLimited`.
- `active -> budgetLimited` when charged tokens reach the budget; the crossing happens at the boundary that
  also issues the wrap-up turn. `budgetLimited` is a no-op for pause and block.
- Any non-complete goal -> `paused(forked)` when it is copied into a forked session, except a
  `budgetLimited` goal, which stays `budgetLimited` and adopts the forked session id.
- `paused | blocked | usageLimited | budgetLimited -> active` on resume, which resets the goal-turn
  baseline. Resume is refused while charged tokens are at or above the budget, whatever the status, unless
  the budget was changed after the limit.
- `edit` and `setBudget` change the objective or budget without changing status, and are refused on a
  complete goal.
- `complete` is accepted from any non-complete status but needs a positive evidence count.
- `touch` adds active time without a history entry or a status change.

### Budgets

Budgets are per goal and default to unbounded. `/goal <objective>` applies `PI_GOAL_DEFAULT_BUDGET` when it
is set, `/goal budget <n>` changes it, and `create_goal` accepts an optional `token_budget`. Any budget above
`PI_GOAL_MAX_BUDGET` (default 2,000,000) is rejected, and the model is told never to set one unless asked.

Charged tokens are `input + cacheWrite + output` for every usage-bearing entry after the goal's
`usageStartEntryId`: assistant messages (including failed attempts, which are still billed), tool results
that carry nested-model usage, and `compaction` and `branch_summary` usage. Cache-warming `usage` entries
(`kind: "cache_warm"`) are background upkeep and are not charged. A usage record whose buckets are all zero
but which reports `totalTokens` is charged from that total, conservatively as non-cached input. `cacheRead`
is reported but never charged, and duplicate entry ids are counted once. This is the Pi counterpart of the
Codex charge `input - cached + output`: Pi reports cache buckets separately and its `input` already
excludes them.

When charged tokens reach the budget at a boundary, the goal moves to `budgetLimited` immediately and still
gets exactly one wrap-up turn (the Codex `budget_limit.md` text, which forbids new substantive work). The
next boundary stops it. The wrap-up turn therefore runs with status `budgetLimited`, where pause and block
requests are no-ops. The goal never auto-completes. Raising the budget above current usage resumes it in the
same `/goal budget` call.

### Active time

The adapter records `agent_start` and `agent_settled` timestamps and persists the difference with a `touch`
transition, only while the goal is `active`. A completion persists the in-flight time before it marks the
goal complete, so a goal finished in its first turn still reports elapsed time. Interrupted runs contribute
the time they ran while the goal was active. `/goal status` and the widget show it as a compact duration. A
hard kill loses the open span; see `docs/LIMITATIONS.md`.

### No-progress breaker and turn cap

A goal turn is the span after a goal directive. Two counters come from each turn. Activity, which feeds the
no-progress breaker, is any successful non-goal tool result, including planning and delegation tools.
Evidence, which feeds the completion gate, is narrower: only `read`/`grep`/`find`/`ls`, `write`/`edit`, and
`bash`/`powershell` results. `idleTurns` counts trailing goal turns with no activity, and when it reaches
`PI_GOAL_MAX_IDLE_TURNS` (default 3) the goal pauses with reason `no-progress`. Any successful non-goal tool
call resets the streak, so investigation turns and repeated polling are not punished.

`PI_GOAL_MAX_TURNS` (default 200) caps the audited goal turns since creation or the last resume. At the cap
the goal gets one turn-cap wrap-up directive (a distinct prompt that states the real limit, not a token
budget), then pauses with reason `turn-cap`. `/goal resume` resets the goal-turn baseline, so it grants a
fresh allowance; no budget change is needed. The cap itself is read when the extension loads, so changing
it takes a restart.

### Provider errors and usage limits

The boundary outcome comes from Pi, and the provider error text comes from the last assistant message. A
message matching the usage-limit patterns (for example `usage limit`, `rate limit`, `quota`, `429`,
`credits`, `billing`, `insufficient_quota`) moves the goal to `usageLimited`. Any other error pauses an
active goal with reason `provider-error`; the goal is not blocked, because the user can fix the cause and
resume. Aborts are handled separately: `agent_settled` with `aborted: true` pauses an active goal with
reason `interrupted`, including when Pi aborts the run for a manual `/compact`. Pi gives no causal link
between the abort and the compaction, so the extension never resumes the goal on its own; when an interrupt
was recent it only adds a notice telling the user to run `/goal resume`. A `/compact` that interrupted a run
therefore leaves the goal paused.

## Configuration

Six environment variables are read once per extension load, in `src/runtime.ts`. `PI_GOAL_MAX_TURNS`,
`PI_GOAL_MAX_IDLE_TURNS`, and `PI_GOAL_MAX_BUDGET` fall back to their defaults when unset, empty,
non-numeric, zero, or negative. `PI_GOAL_DEFAULT_BUDGET` treats those values as "unset", which means an
unlimited default budget rather than the fallback number.

| Variable                         | Default    | Effect                                                                                          |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `PI_GOAL_MAX_TURNS`              | `200`      | Audited goal turns allowed before the turn cap pauses the goal with reason `turn-cap`.            |
| `PI_GOAL_MAX_IDLE_TURNS`         | `3`        | Consecutive goal turns with no successful non-goal tool result before `paused(no-progress)`.       |
| `PI_GOAL_DEFAULT_BUDGET`         | unset      | Token budget applied by `/goal <objective>`. Unset, `0`, or an invalid value means unlimited.     |
| `PI_GOAL_MAX_BUDGET`             | `2000000`  | Hard ceiling for any budget from `/goal budget` or `create_goal`; larger values are rejected.      |
| `PI_GOAL_ALLOW_UNATTENDED_CREATE`| unset      | Set to `1` to let `create_goal` run without UI confirmation in non-interactive sessions.          |
| `PI_GOAL_SHOW_DIRECTIVES`        | unset      | Set to `1` to display goal directives in the transcript (`display: true`). Default hides them; they are still sent to the model. |

Budgets are not environment variables; they belong to the goal and are set with `/goal budget` or
`create_goal`'s `token_budget`.

## Testing

Run the suite from the extension directory:

```sh
cd ~/.pi/agent/extensions/goals
node --test --experimental-strip-types test/*.test.ts test/support/*.test.ts
```

Type-check it from the workspace root. `extensions/goals` is included in `tsconfig.extensions.json`, which
also covers the other TypeScript extensions named there:

```sh
cd ~/.pi/agent
npx --yes -p typescript@7.0.2 tsc --noEmit -p tsconfig.extensions.json
```

The extension's own `tsconfig.json` is narrower and can be used for a single-extension check:
`npx --yes -p typescript@7.0.2 tsc --noEmit -p extensions/goals/tsconfig.json`.

`package.json` also has `npm test` (direct `test/*.test.ts` only) and `npm run check`.

As of this writing the suite reports 260 tests in 17 suites, all passing on Node v26.13.0. Run the
command to see the current count.

What the suite covers:

- `test/transitions.test.ts`: every command and status combination, rejected transitions, invariants
  (history bound, revision bumps, no input mutation, terminal `complete`), objective and budget validation.
- `test/goal-repository.test.ts`: snapshot validation, newest valid entry wins, corrupt and unsupported
  versions, load-issue bounds, persistence failure mapping.
- `test/usage-accounting.test.ts`: charge formula, cache-read exclusion, cache-warming exclusion, the
  `totalTokens` fallback, anchor handling, entry types, duplicate ids, clamping.
- `test/progress-tracker.test.ts`: turn spans, the activity/evidence split, mutation flags, idle streak, tool
  categories, pending directives, continuation and wrap-up counts.
- `test/continuation-policy.test.ts`: decision order, duplicate-boundary guard, budget and idle and turn-cap
  breakers, error classification.
- `test/prompts.test.ts`: template substitution, objective escaping, the goal-context wrapper, budget and
  turn-cap wrap-up prompts, rejection texts.
- `test/engine.test.ts`: the real engine over a fake session and an appended-entry writer, covering
  creation, replacement, clear, pause and resume, turn-cap resume, one continuation per boundary, interrupt,
  manual compaction staying paused, usage limits, budget crossing and raising, the no-progress breaker,
  completion and blocked gates, pause authorization, forks including a budget-limited fork, compaction,
  restarts, `/tree` rewinds, internal-error fail-safe, and concurrent mutations.
- `test/adapter-commands.test.ts`: `/goal` create, busy refusal, status, pause and resume, clear tombstone,
  budget parsing, history, bounded debug output, edit, and the unknown-subcommand suggestion.
- `test/adapter-events.test.ts`: boundary continuation, anchor dedupe, `agent_settled` abort handling,
  fork rehydration, and the manual-compaction notice that does not resume the goal.
- `test/adapter-tools.test.ts`: tool payloads and output schemas, create authorization with and without UI,
  the unattended opt-in, the budget ceiling, completion evidence gate, blocked reason and evidence, and the
  pause confirmation.
- `test/runtime.test.ts` and `test/wiring-drift.test.ts`: run timing and environment parsing (including the
  new budget and unattended-create settings), plus a drift check that the registered events, tools, command
  names, argument schema, and custom entry types stay as declared.
- `test/support/*`: the fake session, boundary driver, and fake host that model Pi's settlement semantics
  (drafts are committed before the continuation decision, one continuation per boundary, `continue`
  requires runnable context), plus the fake host's own tests.

Not covered: live-model runs, live provider errors or usage limits, and any platform other than Linux.
`docs/LIMITATIONS.md` has the manual smoke test.

## Architecture

Four layers. `domain` is pure and has no Pi or Effect runtime imports; `services` holds the engine and
derivations, and its only Effect services are the engine itself; `prompts` builds every model-visible
string; `adapters` is the only place that touches the Pi API.

| File                                | Responsibility                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                      | Extension factory: build the runtime, register events, commands, and tools.                                         |
| `src/runtime.ts`                    | Managed Effect runtime, environment configuration, run timing, and the last interrupt timestamp.                    |
| `src/domain/goal.ts`                | Snapshot and metrics types, schemas, constants, directive details, pure helpers.                                   |
| `src/domain/transitions.ts`         | The state machine: one pure function from snapshot plus command to a new snapshot and events.                      |
| `src/domain/errors.ts`              | Tagged failures (`InvalidTransitionError`, `GoalConflictError`, `GoalRejectedError`, ...).                          |
| `src/domain/events.ts`              | Domain events emitted by transitions.                                                                              |
| `src/services/goal-controller.ts`   | The engine: `view`, `rehydrate`, `decideBoundary`, `settle`, `failSafe`, `runCommand`, `runTool`, serialized by one semaphore. |
| `src/services/goal-repository.ts`   | Reads the newest valid snapshot or tombstone from a branch; appends snapshots and tombstones through a host writer. |
| `src/services/usage-accounting.ts`  | `deriveUsage` and the charging formula over transcript entries.                                                    |
| `src/services/progress-tracker.ts`  | `deriveTurnStats`: goal turns, continuations, wrap-ups, tool counts, evidence, idle streak, pending directives.     |
| `src/services/continuation-policy.ts` | Pure boundary policy and provider error classification.                                                          |
| `src/prompts/continuation.ts`       | Continuation and kickoff prompts, the `codex_internal_context` wrapper, objective escaping and quoting, budget formatting. |
| `src/prompts/budget-limit.ts`       | The budget wrap-up prompt and the separate turn-cap wrap-up prompt.                                                |
| `src/prompts/objective.ts`          | Objective-edited prompt.                                                                                           |
| `src/prompts/messages.ts`           | Completion and blocked rejection texts, unauthorized-pause text, completion report.                                |
| `src/prompts/index.ts`              | Re-exports for adapters and tests.                                                                                 |
| `src/adapters/host.ts`              | Structural subset of `ExtensionAPI` the adapters need, so they depend on a small surface instead of the full API.   |
| `src/adapters/pi-events.ts`         | Lifecycle wiring; the single continuation site.                                                                    |
| `src/adapters/pi-commands.ts`       | `/goal` parsing, argument completion, and command handlers.                                                        |
| `src/adapters/pi-tools.ts`          | `get_goal`, `create_goal`, `update_goal`, including the pause confirmation.                                        |
| `src/adapters/pi-ui.ts`             | Status line, widget, notifications, detail and history formatting. Best effort; UI failures are swallowed.          |
| `src/adapters/directive.ts`         | Directive drafts and details, plus the directive used to start a run from a command.                                |

Invariants the implementation relies on:

- The transcript is the source of truth. Every engine call reads the branch it was given; the engine keeps
  no long-lived state, so a reload or restart cannot diverge from the session file.
- Snapshots are append-only `custom` session entries (`customType: "goal-snapshot"`), one complete snapshot
  per transition with a bumped revision. The newest entry that validates wins; corrupt and unknown-version
  entries are skipped with a recorded issue. A `goal-cleared` tombstone ends the goal.
- Quantitative state is derived, never persisted: tokens, goal turns, continuations, tool counts, evidence,
  and the idle streak are recomputed from the branch at each observation, so accounting is idempotent
  across restarts and cannot double count.
- One continuation site. Only `agent_before_settle` continues a goal inside a run; commands start a run
  only for `/goal <objective>`, `resume`, `edit` of an active goal, or a budget raise. One directive is
  appended per boundary. The assistant anchor is a defense against a second continuation; in practice Pi
  dispatches one boundary per settled run and each continuation produces a new assistant entry.
- Every status change goes through `transition()`. No other module writes a snapshot field.

## Differences from Codex

Codex reference: `openai/codex` at `67f0994`, `codex-rs/ext/goal`. Pi reference: 1.4.0 as installed here.

| Area                    | OpenAI Codex                                                                                                          | pi-goals                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Continuation trigger    | `on_thread_idle` lifecycle hook; `continue_if_idle` runs when no turn is active and no trigger-turn input is pending.   | `agent_before_settle` returning one hidden `custom_message` draft plus `continue: true`. Nothing else continues a goal.                                                              |
| State persistence       | SQLite `thread_goals` row updated in place; usage counters stored in the row.                                           | Append-only session entries: one full snapshot per transition, newest valid one on the branch. Usage and turn counts are derived from the transcript, not stored.                    |
| Tool payload identity   | `threadId` only; `createdAt` and `updatedAt` in epoch seconds.                                                         | `threadId` (the Pi session id) plus `goalId`; timestamps in epoch seconds. `completionBudgetReport` only with a budget or non-zero elapsed time.                                      |
| Create authorization    | `create_goal` needs no user authorization; a model can create a goal at any time an unfinished goal does not exist.     | Interactive sessions ask for confirmation; non-interactive sessions refuse unless `PI_GOAL_ALLOW_UNATTENDED_CREATE=1`. `/goal <objective>` needs no tool authorization.               |
| Pause authorization     | Prompt-only. `update_goal(paused)` is accepted without checking that the user asked.                                    | Deterministic. The adapter asks for interactive confirmation; no UI or a declined prompt returns `pause-unauthorized` and the goal keeps running.                                    |
| Completion audit        | Prompt-only. `update_goal(complete)` is accepted from any status; nothing verifies an audit happened.                    | Deterministic floor: at least one verification-grade tool result in the current goal turn (read/search, write/edit, shell); planning and other extension tools do not count.           |
| Blocked audit           | Prompt-only for the model path; runtime counters only cover repeated empty continuations and failed `exec` turns.        | Deterministic gate: at least three audited goal turns since creation or the last resume, a non-empty reason, and at least one evidence item.                                          |
| User interrupt          | The goal keeps running. The interrupted turn is evaluated at idle and `continue_if_idle` starts another continuation.    | The goal pauses (`paused`, reason `interrupted`) on `agent_settled{aborted:true}` and needs `/goal resume`. This follows the project requirements, not Codex.                          |
| Manual `/compact`       | The goal runtime does not observe compaction.                                                                          | `/compact` aborts the run first, so the goal pauses; the extension never resumes it on its own and only explains the pause. `/goal resume` continues.                                |
| Budget wrap-up timing   | Injected into the running turn as steering after the tool call that crosses the limit; no wrap-up if the limit is only crossed at turn stop. | The goal flips to `budgetLimited` at the crossing boundary and gets one wrap-up turn there. No mid-turn injection, because Pi has no API for it.                                      |
| Budget defaults         | An omitted `token_budget` defaults to a configured maximum.                                                            | `/goal` applies `PI_GOAL_DEFAULT_BUDGET` when set, otherwise unlimited; `PI_GOAL_MAX_BUDGET` caps every requested budget.                                                            |
| Token charge            | `input - cached_input + output`, cached input excluded.                                                                | `input + cacheWrite + output`, cache reads excluded and reported separately; cache-warming usage entries are not charged.                                                            |
| No-progress stop        | Three consecutive empty automatic turns or three failed `exec` turns move the goal to `blocked`.                        | Three trailing goal turns with no successful non-goal tool result pause it with reason `no-progress`; the model is not asked to mark a block.                                          |
| Turn cap                | None. The loop is unbounded.                                                                                           | `PI_GOAL_MAX_TURNS`, default 200 audited turns, with one turn-cap wrap-up and then `paused(turn-cap)`; `/goal resume` grants a fresh allowance.                                        |
| Provider error mapping  | Usage limit maps to `usageLimited`; every other terminal turn error maps to `blocked`.                                  | Usage limit maps to `usageLimited`; any other error pauses with reason `provider-error`, so the user can fix the cause and resume.                                                    |
| Plan tool               | The continuation prompt uses `update_plan` when it is enabled and drops the plan section when it is not.                | The same text with `update_plan` replaced by `todowrite`. No code reads plan state; the wording is the only coupling.                                                                |
| Subagent usage          | Descendant thread token usage rolls up into the root goal through the accounting state.                                 | Only usage recorded on the branch counts, including nested model usage on tool results. There is no parent/descendant linkage.                                                        |
| TUI                     | A goal menu with edit and resume flows, and status labels such as `stalled` for `blocked`.                              | `/goal` subcommands, a footer status line, a two-line widget above the editor, and notifications. No menu.                                                                            |
| Platforms               | Rust, cross-platform.                                                                                                  | TypeScript with no platform-specific code. Tested only on this Linux environment; macOS and Windows are unverified.                                                                   |

## Limitations

See `docs/LIMITATIONS.md` for the full list, each entry with the Pi mechanism behind it, plus the manual
smoke test. The three that matter most in daily use:

1. There is no idle scheduler. A goal does not auto-start after a restart, reload, or session resume; it
   re-engages on the next user message or immediately with `/goal resume`.
2. Budget enforcement runs between provider calls. A single in-flight response can overshoot the budget,
   and provider-side retries that never produce an assistant message are invisible.
3. The extension can only react to Pi events, so objectives must be re-injected on every continuation.
   Compaction can still summarize a directive away, and manual `/compact` is handled through a timing
   heuristic on the abort, not a first-class signal.

## File layout

```
extensions/goals/
|-- package.json              # pi.extensions entry, peer dependencies, test scripts
|-- tsconfig.json
|-- README.md
|-- docs/
|   |-- ARCHITECTURE.md       # approved design and module contracts
|   |-- PLAN.md               # implementation plan and phase state
|   |-- LIMITATIONS.md        # API limits, behavior gaps, test gaps, smoke test
|   `-- research/             # A-F source evidence reports
|-- src/
|   |-- index.ts
|   |-- runtime.ts
|   |-- domain/
|   |   |-- errors.ts
|   |   |-- events.ts
|   |   |-- goal.ts
|   |   `-- transitions.ts
|   |-- prompts/
|   |   |-- budget-limit.ts
|   |   |-- continuation.ts
|   |   |-- index.ts
|   |   |-- messages.ts
|   |   `-- objective.ts
|   |-- services/
|   |   |-- continuation-policy.ts
|   |   |-- goal-controller.ts
|   |   |-- goal-repository.ts
|   |   |-- progress-tracker.ts
|   |   `-- usage-accounting.ts
|   `-- adapters/
|       |-- directive.ts
|       |-- host.ts
|       |-- pi-commands.ts
|       |-- pi-events.ts
|       |-- pi-tools.ts
|       `-- pi-ui.ts
`-- test/
    |-- adapter-commands.test.ts
    |-- adapter-events.test.ts
    |-- adapter-tools.test.ts
    |-- continuation-policy.test.ts
    |-- engine.test.ts
    |-- goal-repository.test.ts
    |-- progress-tracker.test.ts
    |-- prompts.test.ts
    |-- runtime.test.ts
    |-- transitions.test.ts
    |-- usage-accounting.test.ts
    |-- wiring-drift.test.ts
    `-- support/
        |-- fake-boundary.ts
        |-- fake-host.test.ts
        |-- fake-host.ts
        |-- fake-session.test.ts
        `-- fake-session.ts
```
