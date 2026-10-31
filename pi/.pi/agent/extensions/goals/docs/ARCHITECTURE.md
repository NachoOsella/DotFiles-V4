# Architecture: Codex Goals for Pi

Status: approved design. Source evidence is in `docs/research/` (A-F reports). This document is
the implementation contract: every module listed here has a fixed responsibility, exported
surface, and invariants.

## 1. What we reproduce

Researched against `openai/codex` @ `67f0994` (`codex-rs/ext/goal`), Pi `1.4.0`, Effect
`4.0.0-beta.98`.

| Codex behavior                                                   | Our implementation                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Goal persists across turns, statuses `active/paused/blocked/usageLimited/budgetLimited/complete` | Same six statuses, same names.                                                                               |
| Continuation injected only when the thread is idle and status is `active` | `agent_before_settle` returns one hidden `custom_message` directive; nothing else continues.                |
| First goal turn already receives the continuation prompt          | `/goal` writes the `user_goal` fragment plus the verbatim continuation prompt as the kickoff directive.      |
| Objective is data, XML-escaped, max 4000 chars                    | Same escaping and limit.                                                                                     |
| Token budget charge is `input - cached + output`                  | Pi separates cache buckets, so we charge `input + cacheWrite + output` and exclude `cacheRead` (documented). |
| Budget limit produces one wrap-up turn, then `budgetLimited`       | Same: one `budget-wrapup` directive, then `budgetLimited`; never auto-completes.                             |
| `budgetLimited` wins over `paused`/`blocked`                       | Same: pause/block requests are no-ops while budget-limited.                                                   |
| `create_goal` refuses while an unfinished goal exists              | Same error semantics; creating also needs user authorization (interactive confirmation, or the `PI_GOAL_ALLOW_UNATTENDED_CREATE` opt-in). |
| `update_goal` accepts only `complete`, `blocked`, `paused`         | Same; `resume`/limits are user-only.                                                                          |
| `blocked` requires the same blocker for 3 consecutive goal turns   | Enforced deterministically: `auditedTurns >= 3`.                                                              |
| Pause requires an explicit user request                            | Enforced deterministically: the adapter asks the user to authorize; no UI means rejection.                     |
| Completion audit is prompt-only                                    | We add a gate: `complete` needs at least one verification-grade tool result (read/search, write/edit, shell) in the current goal turn. Planning tools do not count. |
| Tool results carry `goal`, `remainingTokens`, `completionBudgetReport` | Same payload shape in `structuredContent`.                                                                   |

Deliberate improvements (documented as divergences in `README.md`): deterministic completion,
blocked, and pause gates; usage derived from the transcript instead of counters; abort-aware
continuation; fork protection.

## 2. State machine

```
(no goal) --create--> active
complete  --create--> active (new goal id, counters reset)
active    --pause--> paused            (user, interrupt, provider error, no progress)
active    --block--> blocked           (auditTurns >= 3 only)
active    --budget exhausted--> budgetLimited
active    --usage limit--> usageLimited
paused|blocked|usageLimited|budgetLimited --resume--> active   (budget must allow it)
any except complete --complete(audited)--> complete
any except complete --clear--> (no goal)
complete  --anything but create/clear--> InvalidTransition
budgetLimited --pause|block--> budgetLimited (unchanged, precedence)
```

Rules:

- `complete` is terminal. `create` on a complete goal replaces it.
- The safety turn cap pauses with reason `turn-cap`; `/goal resume` grants a fresh allowance
  because the cap counts turns since the last resume. It is not a `budgetLimited` state.
- Crossing the token budget flips the goal to `budgetLimited` at the wrap-up boundary and still
  allows exactly one wrap-up turn; pause and block are no-ops in that state.
- Every change goes through `transition()` in `src/domain/transitions.ts`. No other module writes
  a snapshot field.
- Invalid transitions return a typed error, never throw.
- `resume` from `budgetLimited` requires the budget to no longer be exhausted (raise it first).
- A goal id never changes after creation; late events carrying another id are rejected.

## 3. Persistence

State is one `custom` session entry per transition (`customType: "goal-snapshot"`), appended with
`pi.appendEntry`. Details:

- **Snapshot, not journal.** Each entry holds the complete `GoalSnapshot` with a monotonically
  increasing `revision`. No external files, no SQLite. Clearing writes a `goal-cleared` tombstone so
  a cleared goal stays cleared after a restart.
- **Read path.** `loadLatestSnapshot(branch)` scans `ctx.sessionManager.getBranch()` backwards and
  returns the newest entry that validates against `GoalSnapshotSchema`. Corrupt or unknown-version
  entries are skipped with a recorded issue; loading never throws.
- **Branch semantics.** `getBranch()` is a plain leaf-to-root walk that ignores compaction cuts, so
  snapshots survive compaction. `/tree` restores the snapshot that belongs to the active branch.
  `/fork` copies entries into a new session: `session_start{reason:"fork"}` forces `paused`
  (`reason: "forked"`) so two sessions never run the same goal.
- **Quantitative state is derived, never persisted.** Tokens, goal turns, continuations, tool
  counts, and current-turn evidence are recomputed from the transcript at each observation, using
  `usageStartEntryId` as the charge boundary. This makes accounting idempotent across restarts and
  impossible to double count.
- **Durability window.** Pi only creates the session file once a user or assistant message exists.
  A goal created before the first assistant response lives in memory until then. Same guarantee Pi
  gives its own state; documented in `README.md`.
- **No auto-resume after restart.** `session_start` restores state and UI but never starts a run.
  The goal re-engages on the next user message, or immediately with `/goal resume`.

## 4. Continuation protocol

`agent_before_settle` is the single continuation site. `turn_end` is observation only.

The adapter calls `engine.decideBoundary({ branch, sessionId, now, facts })`. The engine:

1. Loads the authoritative snapshot from the branch it was given (not from memory).
2. Derives metrics from the same branch.
3. Applies the continuation policy.
4. Persists the resulting snapshot (if the decision changes status).
5. Returns a `BoundaryDecision`.

The adapter then:

- `continue` / `budget-wrapup`: returns `{ entries: [...event.entries, { type: "custom_message",
  customType: "goal-directive", content: prompt, display: false, details }], continue: true }`.
  The draft is what makes Pi's `canContinue` check pass: a hidden custom message becomes a `user`
  message for the model.
- Everything else: returns `undefined` (no entries, no continue), so Pi settles.

Dedupe invariant: every directive stores `anchorEntryId` (the assistant entry that caused it) in its
`details`. If the newest goal directive on the branch was already anchored at the current assistant
entry, the engine returns `idle`. Since a continuation always produces a new assistant entry, the
same boundary can never be continued twice.

Other invariants:

- No continuation when `status !== "active"`.
- No continuation after an interrupt: `agent_settled{aborted:true}` pauses the goal. A manual
  `/compact` also aborts, so the adapter marks that case and the goal stays active with a notice.
- No continuation after `outcome: "error"`: usage-limit text maps to `usageLimited`, anything else
  to `paused(provider-error)`.
- No continuation when a goal directive is already pending (aborted before the request).
- One continuation site, one directive per boundary, one engine instance per session runtime.

## 5. Accounting

`deriveUsage({ branch, usageStartEntryId })` sums every usage-bearing entry after the anchor:

- assistant messages (`message.usage`), including failed attempts (the provider still bills them);
- tool results carrying nested-model usage (`message.usage`);
- `usage` entries (cache warming);
- `compaction` and `branch_summary` usage.

Charge: `tokensUsed = input + cacheWrite + output` (Codex `input - cached + output`, with Pi's
separate cache buckets). `cacheRead` is reported but not charged. Metrics also expose
`allTokens = input + output + cacheRead + cacheWrite` and `costTotal`.

Active time is the only accumulated quantity: added on `agent_start` → `agent_settled` while a goal
is active, persisted with a `touch` transition.

Budgets: default `null` (unlimited). When `tokensUsed >= budgetTokens` at a boundary: one
`budget-wrapup` directive (never substantive work), then `budgetLimited`. Guarantee: the system
stops between provider calls; it cannot stop a call already in flight.

## 6. Progress and circuit breaker

Derived per goal turn (a span that starts at a goal directive):

- `currentTurnEvidence`: successful tool results that are not goal tools.
- `currentTurnMutated`: successful `write`/`edit`.
- `idleTurns`: trailing goal turns with zero `currentTurnEvidence`.

The breaker stops (`paused(no-progress)`) only when `idleTurns >= maxIdleTurns` (default 3). Any
successful tool call resets it, so investigation turns are never punished. `maxGoalTurns` (default
200) is an independent safety net.

## 7. Module contracts

Ownership is exclusive: one agent per file group during implementation.

### `src/domain/goal.ts` (contract, frozen)

Types, schemas, constants, and pure helpers. Already written. Do not change without the integrator.

### `src/domain/transitions.ts`

```ts
export interface TransitionContext {
    readonly now: number;
    readonly goalId: string;
    readonly sessionId: string;
    readonly usageStartEntryId: string | null;
    readonly goalTurns: number;
}

export type TransitionCommand =
    | { type: "create"; objective: string; budgetTokens: number | null }
    | { type: "pause"; pauseReason: PauseReason; detail?: string }
    | { type: "resume" }
    | { type: "edit"; objective: string }
    | { type: "setBudget"; budgetTokens: number | null }
    | { type: "complete"; evidenceCount: number }
    | { type: "block"; reason: string; evidence: readonly string[]; auditTurns: number }
    | { type: "budget-exhausted" }
    | { type: "usage-limited"; detail: string }
    | { type: "provider-error"; detail: string }
    | { type: "interrupted" }
    | { type: "no-progress"; idleTurns: number }
    | { type: "forked" }
    | { type: "touch"; activeMsDelta: number };

export interface TransitionOutcome {
    readonly snapshot: GoalSnapshot | null;
    readonly events: readonly GoalEvent[];
}

export type TransitionResult =
    | { ok: true; outcome: TransitionOutcome }
    | { ok: false; error: GoalError };

export function transition(
    current: GoalSnapshot | null,
    command: TransitionCommand,
    context: TransitionContext,
): TransitionResult;

export function validateObjective(objective: string): GoalError | null;
export function validateBudgetTokens(budgetTokens: number | null): GoalError | null;
```

### `src/services/usage-accounting.ts`

```ts
export function deriveUsage(input: {
    branch: readonly TranscriptEntry[];
    usageStartEntryId: string | null;
}): GoalUsageTotals;

export function chargeableTokens(usage: UsageSnapshot): number;
export function addUsageTotals(left: GoalUsageTotals, right: GoalUsageTotals): GoalUsageTotals;
export function emptyUsageTotals(): GoalUsageTotals;
```

### `src/services/progress-tracker.ts`

```ts
export interface TurnStats { /* see section 6 + GoalMetrics fields */ }
export function deriveTurnStats(branch: readonly TranscriptEntry[], goalId: string): TurnStats;
export function summarizeToolName(toolName: string | undefined): "goal" | "read" | "mutate" | "command" | "other";
export function isGoalTool(toolName: string | undefined): boolean;
```

### `src/services/goal-repository.ts`

```ts
export function isSnapshotEntry(entry: TranscriptEntry): boolean;
export function isClearedEntry(entry: TranscriptEntry): boolean;
export function parseSnapshot(data: unknown): { ok: true; snapshot: GoalSnapshot } | { ok: false; issue: GoalLoadIssue };
export function loadLatestSnapshot(branch: readonly TranscriptEntry[]): GoalLoadResult;
export function persistSnapshot(appendEntry: (type: string, data: unknown) => void, snapshot: GoalSnapshot): Effect.Effect<void, GoalPersistenceError>;
export function persistCleared(appendEntry: (type: string, data: unknown) => void, goalId: string, at: number): Effect.Effect<void, GoalPersistenceError>;
```

### `src/services/continuation-policy.ts`

```ts
export interface PolicyInput {
    readonly view: GoalView | null;
    readonly facts: BoundaryFacts;
    readonly maxGoalTurns: number;
    readonly maxIdleTurns: number;
    readonly buildContinuationPrompt: (view: GoalView) => string;
    readonly buildWrapUpPrompt: (view: GoalView) => string;
}

export type PolicyOutcome =
    | { kind: "idle"; reason: string }
    | { kind: "continue"; reason: string; prompt: string }
    | { kind: "budget-wrapup"; reason: string; prompt: string }
    | { kind: "transition"; reason: string; command: TransitionCommand; notice: string };

export function decideContinuation(input: PolicyInput): PolicyOutcome;
export function classifyFailure(errorText: string | null): "usage-limit" | "auth" | "transient" | "unknown";
```

### `src/prompts/*.ts`

```ts
// continuation.ts
export function buildContinuationPrompt(input: ContinuationPromptInput): string;
export function buildKickoffPrompt(input: ContinuationPromptInput & { goalId: string }): string;
// budget-limit.ts
export function buildBudgetWrapUpPrompt(input: { objective: string; tokensUsed: number; budgetTokens: number | null; activeMs: number }): string;
// objective.ts
export function buildObjectiveUpdatedPrompt(input: { objective: string; tokensUsed: number; budgetTokens: number | null; remainingTokens: number | null }): string;
// messages.ts
export function buildCompletionRejectedMessage(input: { evidenceCount: number }): string;
export function buildBlockedRejectedMessage(input: { auditedTurns: number; requiredTurns: number }): string;
export function buildPauseUnauthorizedMessage(): string;
export function buildCompletionReport(view: GoalView): string;
export function escapeObjective(objective: string): string;
```

Prompt texts are verbatim from `codex-rs/ext/goal/templates/goals/*.md` (see
`docs/research/B-codex-goal-prompts-tools.md`) with only the documented substitutions.

### `src/services/goal-controller.ts`

```ts
export interface GoalEngineShape {
    readonly view: (input: GoalContextInput) => Effect.Effect<GoalViewResult>;
    readonly rehydrate: (input: GoalContextInput & { reason: SessionStartReason }) => Effect.Effect<GoalActionResult>;
    readonly decideBoundary: (input: GoalContextInput & { facts: BoundaryFacts }) => Effect.Effect<BoundaryDecision>;
    readonly settle: (input: GoalContextInput & SettleInput) => Effect.Effect<SettleResult>;
    readonly clearInterrupt: (input: GoalContextInput) => Effect.Effect<GoalActionResult>;
    readonly runCommand: (input: GoalContextInput & { command: UserCommand }) => Effect.Effect<GoalActionResult, GoalError>;
    readonly runTool: (input: GoalContextInput & { call: GoalToolCall }) => Effect.Effect<GoalActionResult, GoalError>;
}
export class GoalEngine extends Context.Service<GoalEngine, GoalEngineShape>()("goals/GoalEngine") {}
export function makeGoalEngineLayer(options: GoalEngineOptions): Layer.Layer<GoalEngine, never, never>;
```

`GoalContextInput` carries `readBranch()` and `appendEntry()`, both bound to the same session, so a
write can never land on a branch other than the one the decision came from.

`runCommand`/`runTool` serialize through one semaphore, load the snapshot from the branch, apply
one transition, persist, and return. `decideBoundary` additionally applies the policy and persists
the resulting transition before returning. `settle` records interrupts and active time when a run
ends; `clearInterrupt` undoes a pause caused by a manual `/compact` abort.

`GoalContextInput` also carries an optional `elapsedMs`: the time of the run in flight. Tool
payloads add it to the reported active time, and a completion transition persists it before marking
the goal complete, so `timeUsedSeconds` is not zero for a goal finished in its first turn.

### `src/adapters/*.ts` and `src/index.ts`

Pi wiring only: events, commands, tools, UI. Owned by the integrator.

## 8. Testing

`node --test --experimental-strip-types test/*.test.ts` from the extension directory. Unit tests
cover domain transitions, derivation, accounting, repository, policy, and prompts. Integration tests
drive the engine through a fake branch and an in-memory store, covering the mandatory scenarios from
`docs/research/F-risk-matrix.md` (races, restarts, compaction, forks, provider errors, budgets).
