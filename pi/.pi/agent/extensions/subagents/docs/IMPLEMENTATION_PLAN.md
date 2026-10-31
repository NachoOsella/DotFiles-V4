# Subagent harness implementation plan

## Goal

Implement the review in `HARNESS_REVIEW.md` as staged, independently verifiable changes. Keep the current native Pi session architecture and the six collaboration tools. Correctness comes before new orchestration features.

This document is written before implementation agents start. All agents share a working tree. Each source file has one writer at a time; passing tests alone does not authorize changes outside an assignment.

## Compatibility and design decisions

- Preserve tool names, input/output schemas, existing environment variables, default delegation mode, default fork mode, and current snapshot version during the first milestone.
- Preserve native Pi steering and queues. Do not add a second scheduler or replace provider stream functions.
- Preserve the depth limit and real last-N fork selection.
- Completion insertion acknowledgment means recipient transcript insertion, not model processing. Ordinary send/follow-up success still means native dispatch acceptance. Do not claim exactly-once delivery or filesystem fsync guarantees.
- Teams follow the selected root branch. Tree navigation quiesces the old coordinator before constructing the selected branch's team. Old child transcripts remain intact. Results from detached coordinators must never enter the newly selected branch.
- Retain the last durable checkpoint until a replacement checkpoint is ready. Closing must persist after child settlement while the root extension context is still valid.
- Keep arbitrary provider/model fallbacks explicit. Missing roles, models, or child files must not silently change execution authority or billing.
- Tool restrictions are not an OS sandbox. Existing role `tools` behavior remains compatible; new opt-in allow/deny restrictions must be enforced at create and reopen, including codemode reachability.
- Do not change workspace lists, dependency overrides, install dependencies, commit, or edit unrelated extensions.
- If a host interface cannot provide a required guarantee, implement the strongest honest guarantee and record the remaining limitation rather than simulate success.

## M1 integration decisions

The user approved requiring Pi >=1.4.0 <2.0.0 after native tests confirmed
that Pi 1.0 custom-triggered child runs omit system instructions. The extension
now declares `^1.4.0` as its Pi peer dependency and fails closed on older hosts.
Shared workspace dependencies were not updated or installed. The installed CLI
is Pi 1.4.0; the workspace's Pi 1.0.0 remains a structural test and host-gap
characterization target, not a supported production runtime.

Receipt retries use transcript probes and a deferred native idle check. A
failed final checkpoint retains the detached manager for retry. Preliminary
checkpoint failure must never prevent child shutdown. Failed child finalizers
are reported after every disposal has been attempted.

See `M1_IMPLEMENTATION.md` for the implemented behavior, disposition of all 21
audit findings, and explicit M2/M3 deferrals.

## Execution graph and ownership

```text
M0 Plan and baseline
  |
  +-- A Session construction and context --------+
  |                                             |
  +-- B Delivery, residency, lifecycle ----------+-- Root integration
  |                                             |       |
  +-- C Contracts, outcomes, opt-in policy ------+       +-- M1 verification
                                                        |
                                                        +-- M2 bounded execution and recovery
                                                        |
                                                        +-- M3 versioned product features and evaluations
```

At most three implementation agents run concurrently. The root keeps one available slot for an independent review after integration. Workers report interface changes immediately and submit results with changed paths, tests actually run, and unresolved risks. Workers must not delegate further.

### Agent A: session construction and context

Exclusive write ownership:

- `src/core/session-factory.ts`
- `src/persistence/fork-projector.ts`
- `src/core/session-factory.test.ts`
- New focused context/factory regression tests under `src/core/` or `src/persistence/`, with names prefixed `session-context-`.
- New context-import helper under `src/persistence/`, if needed.

Tasks:

1. Construct and share one `SettingsManager` and intended `agentDir` between loader and session.
2. Keep model-runtime/auth selection explicit. Do not assume passing a model descriptor shares the parent runtime.
3. Group logical turns before filtering communication. Cover real child `NEW_TASK`/`FINAL_ANSWER` histories, not only user-message histories.
4. Preserve task intent and provenance in inherited context without reintroducing child control envelopes as fresh authoritative assignments.
5. Import compaction and branch summaries through supported Pi persistence interfaces or an explicitly inherited-context representation. Never use parent entry IDs as child compaction references.
6. Consume Agent C's optional role restrictions during create and reopen. Keep native collaboration depth/wait exclusions effective.
7. Add an opt-in child extension profile only if it can be expressed and tested without breaking existing defaults. Surface loader failures instead of silently losing tools.

Acceptance:

- Directory-local steering and compaction settings are effective without environment overrides, including cold reopen.
- LastN(1) of a multi-assignment child selects one logical turn with necessary context.
- Compacted parent -> fork -> child reopen -> subsequent compaction preserves context and zero inherited usage.
- Existing factory and native collaboration tests remain green.

### Agent B: delivery, residency, lifecycle

Exclusive write ownership:

- `src/core/coordinator.ts`
- `src/core/agent-runtime.ts`
- `src/core/transport.ts`
- `src/core/execution-limiter.ts`, only if required for admission rollback.
- `src/domain/agent-record.ts`, `src/domain/communication.ts`, `src/domain/events.ts`, `src/domain/parent-snapshot.ts`
- `src/persistence/schema.ts`, `src/persistence/record-snapshot.ts`
- New focused tests named `delivery-receipts.test.ts`, `runtime-residency.test.ts`, or `shutdown-barrier.test.ts`.

Tasks:

1. Persist completion intent in the logical outbox before attempting delivery. Expose a critical state-change event so the root can append a checkpoint before submission.
2. Distinguish dispatch, recipient insertion, and native run completion. Keep spawn/follow-up asynchronous with respect to model completion.
3. Add an optional recipient insertion probe to endpoint construction. Root integration will supply a probe reading current branch entries by communication ID. Child probes read their native session entries.
4. Never acknowledge an idle-parent completion merely because `startRun` returned. Reconcile native insertion or preserve the outbox for later retry. Prevent duplicate insertion when an already queued message has not yet reached the transcript.
5. Preserve completion IDs across retries and verify durable transcript receipts before resubmission after recovery.
6. Pin resolved runtimes for the full duration of send/follow-up/completion operations so LRU cannot dispose in-use sessions. Define lock ordering and release leases on failure/cancellation.
7. Make shutdown an idempotent quiescence barrier that stops admission and waits for final child state. Give root a safe way to detach delivery before branch changes without discarding pending results.
8. Reserve execution admission before expensive spawn side effects when native startup semantics allow it. Otherwise document and test the remaining startup limitation.
9. Prefer captured finalized assistant text for completion; avoid classifying arbitrary errors containing 'abort' as user cancellation.
10. Consume Agent C's bounded result formatter without silently dropping the full result.

Root/worker contract:

- Preserve existing endpoint callers through optional parameters/options wherever practical.
- Root owns `index.ts`. B must send exact integration requirements and exported method/event names before finishing.
- B owns all coordinator edits, including any changes requested by A or C. Other workers send proposed integration snippets instead of editing it.
- State explicitly whether an insertion receipt is pending, failed, or confirmed. A native root send is fire-and-forget; a promise-shaped wrapper is not a receipt.

Acceptance:

- Root void dispatch does not immediately advance an insertion watermark.
- Rejected insertion into an idle child parent retains a pending completion.
- A persisted recipient envelope is not inserted again after recovery.
- Loaded capacity of one with concurrent sends/follow-ups never reaches a disposed session.
- Closing preserves usage/outbox mutations produced while aborting runs.
- Existing concurrency, retry, and native wake regressions remain green.

### Agent C: prompt contracts, bounded outcomes, opt-in role policy

Exclusive write ownership:

- `src/config/config.ts`, `src/config/roles.ts`, `src/config/prompts.ts`, `src/config/mode.ts`
- `src/config/config-prompts.test.ts` and new focused config/prompt tests.
- `src/domain/completion.ts`, `src/domain/communication.test.ts` only for completion assertions.
- `src/tools/tool-specs.ts`, `src/tools/extension-tools.ts`
- New focused result/schema tests under `src/domain/` or `src/tools/`.

Tasks:

1. Keep one capability-aware collaboration contract. Remove contradictory/repeated instructions while retaining existing behavioral clauses.
2. Add concise task brief, evidence-based result, workspace ownership, and provenance guidance. Do not claim prompts enforce permissions or prevent injection.
3. Show role descriptions to the model and avoid recommending unavailable nested spawning at the depth limit.
4. Add backward-compatible opt-in role `allowTools`/`denyTools` and a pure resolver. Publish the resolver interface immediately for A/B. Existing `tools` semantics remain unless restrictions are configured.
5. Make successful completions nonempty and bounded, with an explicit truncation marker and a retrievable native session reference. Preserve full text in the child transcript. Bounds must not affect source transcript storage.
6. Publish the bounded formatter call shape to B. Retain call-site compatibility for existing tests where possible.
7. Fail closed for unknown root caller identity while preserving explicitly pinned child caller resolution. Coordinate required coordinator changes with B.
8. Validate structured tool results against declared schemas in focused tests. Preserve schemas and direct/codemode behavior.

Acceptance:

- No unavailable spawn instruction at the depth limit.
- Task/result guidance distinguishes observations, inferences, unrun checks, and blockers.
- Empty success has a meaningful outcome; oversized success has a bounded summary and full-result reference.
- Role descriptions are discoverable and restrictions are deterministic, including deny precedence.
- Tool names/schemas and delegation defaults do not change.

### Root: integration, branch ownership, checkpointing, verification

Exclusive write ownership:

- `index.ts`
- `src/persistence/session-state.ts`
- `src/persistence/lifecycle.test.ts`
- New entry integration tests named `entry-*.test.ts` under `src/core/` or `src/persistence/`.
- Documentation, including this status ledger and compatibility notes.

Tasks:

1. Supply native root transcript insertion probes and critical checkpoint handling to B's delivery implementation.
2. Reconcile receipts after native root activity without depending on a second model request to declare dispatch successful.
3. Quiesce and detach old branch delivery before activating the selected branch's coordinator. Keep old transcript files and pending state; do not copy the old team into a branch with no snapshot.
4. Move the final shutdown checkpoint after coordinator settlement and before root context invalidation. Keep handlers idempotent.
5. Use Pi's structured prompt integration for root guidance.
6. Make explicit invalid config/path/JSON and environment limits diagnostic rather than silently falling back to enabled defaults. Preserve absent-config defaults.
7. Coalesce unchanged/noncritical usage snapshots while keeping outbox intent and receipts immediate. Do not optimize usage accounting speculatively.
8. Integrate workers in dependency order, inspect diffs, run tests, request fixes from the owning worker, then run an independent review.

Acceptance:

- Tree navigation backward and forward restores selected membership and fences late old-branch delivery.
- Shutdown root JSONL includes final pending deliveries and final usage.
- Native root asynchronous delivery errors cannot clear the only pending result.
- Malformed explicit configuration cannot silently enable a default team.
- Existing print/non-UI and reload behavior remains functional.

## Milestone 1: correctness and contract baseline

Review mapping: findings 1-7, 9-10, 15-18, and the directly relevant parts of 13-14 and 20-21.

Implement the assignments above, with compatibility-preserving optional policy additions. No worker may quietly expand this milestone into a public schema redesign. The root must finish all integration before declaring it complete.

Verification order:

1. Each worker's focused regression tests.
2. `npm run test:subagents` from the agent workspace.
3. Supplemental host-aligned suite when the temporary alias harness is available.
4. `npm run check:extensions` and scoped extension type check if TypeScript is available. A missing executable is reported, not bypassed or installed without review.
5. `npm test` before completion; classify unrelated failures separately.
6. Independent read-only review of delivery, residency, branch replacement, and context import.

No live-provider evaluation runs without an explicit bounded scenario and cost limit.

## Milestone 2: bounded execution and operational recovery

Starts only after milestone 1 is integrated and reviewed. Keep disabled/unlimited defaults for new limits.

### Bounded execution

- Per-run deadline and model-request limit.
- Shared root-tree token accounting with pre-admission checks and documented in-flight overshoot.
- Typed budget/deadline termination, a nonempty parent outcome, and visible remaining limits.
- Do not count waiting as free execution unless a safe request-time reacquisition seam exists in Pi. Keep current accounting otherwise.

### Recovery and observability

- Validate child session file ownership and role/policy revisions on cold reopen.
- Preserve missing-role/model failures as actionable blocked work, not fallback execution.
- Add capacity-specific error codes and recovery guidance without changing existing tool schemas.
- Correct the semantics of pending activity versus unread mail.
- Benchmark snapshot bytes, spawn/reopen latency, and usage parsing on long sessions before introducing incremental accounting.

Assignments and file leases are reissued after milestone 1; do not run these changes concurrently with an earlier owner of the same file.

## Milestone 3: versioned features and model evaluation

These recommendations require deliberate product/schema decisions and are not hidden inside milestone 1:

- Distinct task assignment receipts and task/run correlation in public outputs.
- Bounded team/task recovery views and artifact inspection.
- Explicit archival of logical identities, with preserved usage and immutable identity ownership.
- Role-specific context selection beyond the corrected existing fork modes.
- Snapshot migration policy where new durable fields require a new version.
- Repeated model-level evaluations for delegation decisions, duplicate work, ownership conflicts, failure recovery, context growth, and verified task success.

Preserve the existing six-tool compatibility layer. Any additional versioned interfaces get their own plan section, tests, and migration notes before agents implement them.

### M3 execution plan

M3 starts after the M2 commit (`77cf202`). It introduces snapshot version 3 and
additive public fields. Existing tool inputs, the six-tool family, native queues,
and default behavior stay intact. Archival is an operator command, not a seventh
model-facing tool, so delegation semantics do not silently grow.

Frozen contracts:

```ts
// domain/agent-record.ts
export type AgentTaskKind = 'spawn' | 'followup'
export type AgentTaskStatus = 'active' | 'completed' | 'failed' | 'archived'
export interface AgentTask {
    readonly id: string
    readonly agentPath: AgentPath
    readonly objective: string   // bounded, never a full payload
    readonly kind: AgentTaskKind
    readonly submittedBy: AgentPath
    readonly communicationId: string
    readonly runSequence?: number
    readonly status: AgentTaskStatus
    readonly createdAt: number
    readonly completedAt?: number
    readonly resultRef?: string
}

// persistence/schema.ts
export interface PersistedSubagentStateV3 {
    readonly version: 3
    readonly rootSessionId: string
    readonly persistedAt: number
    readonly agents: readonly PersistedSubagentV3[]
    readonly tasks: readonly PersistedTaskV3[]
}
export function parsePersistedStateV3(value: unknown): PersistedSubagentStateV3 | undefined
export function isPersistedStateV3(value: unknown): value is PersistedSubagentStateV3
```

Migration policy: reading a version 2 snapshot migrates it in memory to version
3 with an empty task list and no archived agents, then the next checkpoint
writes version 3. Version 2 stays readable indefinitely; unknown versions are
rejected rather than guessed. The custom entry type `subagents-v3-state` is
unchanged.

Archive policy: only terminal agents can be archived, never `/root`. An archived
agent keeps its record, usage, transcript, and identity; it stops counting
against `maxAgents`, is excluded from the default listing, and rejects message,
follow-up, and interrupt with `agent_archived`. Archival is refused while an
undelivered completion names that agent. Archived paths are never reused.

Role context policy: roles may declare `context: { mode: 'inherit' | 'none' |
'lastN', turns?: number }`. An explicit `fork_turns` argument always wins; the
role policy applies only when the caller omits it; `inherit` keeps the current
default. Resolution is pure and returns its source so tests and diagnostics can
explain the choice.

Public surface additions are additive and optional: `task_id` on spawn and
follow-up outputs, `task_id` and `run_sequence` in completion metadata,
`archived` and a bounded `current_task` summary in `list_agents`. The `/agents`
command gains `archive` and `unarchive`.

Ownership:

| Worker | Files | Deliverable |
| --- | --- | --- |
| A | `src/persistence/schema.ts`, `src/persistence/record-snapshot.ts`, `src/persistence/session-state.ts`, new `src/persistence/schema-v3.test.ts` | Version 3 schema, migration, validation, serializer |
| B | `src/core/coordinator.ts`, `src/domain/agent-record.ts`, `src/domain/communication.ts`, `src/domain/events.ts`, new `src/core/task-lifecycle.test.ts`, new `src/core/archive.test.ts` | Task lifecycle, quota release, archive semantics |
| C | `src/config/config.ts`, `src/config/roles.ts`, new `src/core/context-policy.ts`, `src/core/context-policy.test.ts`, `src/config/role-context.test.ts` | Role context policy and pure resolver |
| Root | `index.ts`, `src/tools/*`, docs, `docs/EVALUATIONS.md` | Additive outputs, archive command, integration, evaluation protocol |

Verification: worker suites, `npm run test:subagents`, host suite, both type
checks, full `npm test`, and an independent review of migration correctness,
task/run correlation, quota release, and archive races. Live-model evaluation is
documented but not executed without an explicit bounded budget.

## Status ledger

| Work | Owner | State | Evidence |
| --- | --- | --- | --- |
| M0 plan | Root | Complete | This document written before spawning workers |
| Session/context | A | Complete | Shared settings, child-shaped last-N, native summary import, role create/reopen, host-context characterization |
| Delivery/residency/lifecycle | B | Complete | Receipt checkpoints, runtime leases, cheap admission, concurrent rollback repair, disposal-failure regressions |
| Contracts/policy/results | C | Complete | Lazy root tools, bounded nonempty outcomes, long-reference/Unicode bounds, role policy, output-schema validation |
| Root/branch/checkpoint integration | Root | Complete | Native entry receipt/steer/composition, branch navigation, failed checkpoint retry, strict config, supported-host guard |
| M1 independent review | Review worker | Complete | Concurrent rollback, failed disposal, failed-retirement retention, pre-checkpoint shutdown, and Pi 1.0 prompt gap addressed |
| M1 verification | Root | Complete | Workspace 238 pass / 6 expected skips; supported host 243 pass / 1 expected skip; full workspace 522 pass / 6 expected skips; both type-checks pass |
| M2 bounded execution/recovery | A: policy/config · B: enforcement · C: reopen | Complete | Limits 17 focused, run-limits 11, list-semantics 4, session-recovery 15, tool schema 12; unlimited path regression; review P1 blocked-state fixed |
| M3 versioned features | A: schema v3 · B: tasks/archive · C: role context | Complete | Schema 12, task/archive 14, context 14, wiring 1; v2 migrates; review P1 limit-task and archive-descendant fixed |
| M3 model-level evaluations | Root | Specified, not run | Protocol and budget in docs/EVALUATIONS.md; no provider spend without approval |

## Milestone 2 execution plan

M2 starts after the M1 commit (`7c0ff9c`). New limits ship disabled or
unlimited by default: absent configuration must behave exactly like M1. No tool
input schema changes. Additive optional output fields are allowed and documented.

### Scope

Included:

- Per-run wall-clock deadline, per-run model-request limit, and a shared
  root-tree token budget with pre-admission refusal.
- Typed termination with a nonempty parent outcome and visible remaining limits.
- Cold-reopen ownership and current-policy validation with blocked, actionable
  failures instead of fallback execution.
- Capacity-specific error codes and recovery guidance in error text.
- Truthful `list_agents` mail versus activity semantics and `wait_agent` wake
  reasons.
- A repeatable benchmark for snapshot bytes, spawn/reopen latency, and usage
  parsing before any incremental accounting change.

Excluded and recorded as M3: persisted role/policy revision history, snapshot
schema migration, task/run identity contracts, identity archival, and model
quality evaluation.

### Frozen internal contracts

`src/core/limits.ts`:

```ts
export interface ResolvedLimits {
    readonly runDeadlineMs?: number
    readonly maxModelRequestsPerRun?: number
    readonly maxTreeTokens?: number
    readonly warnAtRatio: number
    readonly unlimited: boolean
}
export function resolveLimits(config: CodexSubagentsConfig): ResolvedLimits
export function describeLimits(limits: ResolvedLimits): string

export interface TokenBudgetSnapshot {
    readonly limit?: number
    readonly consumed: number
    readonly reserved: number
    readonly remaining: number
    readonly exhausted: boolean
    readonly warning: boolean
}
export class TokenBudget {
    constructor(limit?: number, warnAtRatio?: number)
    snapshot(): TokenBudgetSnapshot
    checkAdmission(): void
    reserve(tokens: number): void
    release(tokens: number): void
    settle(reserved: number, actual: number): void
    record(tokens: number): void
}
```

Configuration block, all optional:

```json
{
  "subagents": {
    "limits": {
      "runDeadlineMs": 900000,
      "maxModelRequestsPerRun": 40,
      "maxTreeTokens": 500000,
      "warnAtRatio": 0.8
    }
  }
}
```

`src/domain/errors.ts` is root-owned for M2 so both implementation workers can
import the same typed errors. Each new error exposes a stable `code`, its limit,
and `guidance` text.

`AgentRecord.limitReached?: { kind: 'deadline' | 'requests' | 'tokens', detail: string }`
is optional and persisted only when present. A limit termination settles as an
error status with explicit guidance, so the parent receives a nonempty result.
User-initiated `interrupt_agent` keeps `Interrupted` semantics.

### Ownership

| Worker | Files | Deliverable |
| --- | --- | --- |
| A | `src/config/config.ts`, `src/config/prompts.ts`, new `src/core/limits.ts`, `src/core/limits.test.ts`, `src/config/config-limits.test.ts`, `src/config/config-prompts.test.ts` | Pure limit policy, config validation, prompt-visible remaining limits |
| B | `src/core/coordinator.ts`, `src/domain/agent-record.ts`, `src/domain/events.ts`, `src/persistence/schema.ts`, new `src/core/run-limits.test.ts`, new `src/core/list-semantics.test.ts` | Enforcement, termination, budget accounting, mail/activity semantics, wake reasons |
| C | `src/core/session-factory.ts`, new `src/core/session-recovery.ts`, `src/core/session-recovery.test.ts`, `src/core/session-factory.test.ts` | Cold-reopen ownership and policy validation, blocked errors, no fallback |
| Root | `index.ts`, `src/domain/errors.ts`, `src/tools/extension-tools.ts`, `src/tools/tool-specs.ts`, `shared/dashboard-state.ts`, docs, `bench/` | Error contracts, additive output fields, limit publication, benchmark, integration |

### Verification order

1. Each worker's focused tests.
2. `npm run test:subagents` on the workspace SDK.
3. Supplemental host suite on Pi 1.4.
4. `npm run check` and `npm run check:extensions` with the cached executable.
5. `npm test` for the whole workspace.
6. Benchmark run with recorded numbers.
7. Independent read-only review of enforcement races, budget accounting, and
   reopen validation.

## Final verification

| Command / target | Result |
| --- | --- |
| `npm run test:subagents`, workspace Pi 1.0.0 | 244 tests: 238 pass, 6 supported-host entry tests skipped, zero failures |
| `node --import /tmp/pi-subagents-host-aliases.mjs --test --experimental-strip-types extensions/subagents/src/*/*.test.ts`, host Pi 1.4.0 | 244 tests: 243 pass, unsupported-host diagnostic test skipped, zero failures |
| `npm test`, full workspace | 528 tests: 522 pass, same 6 expected entry skips, zero failures |
| `npm run check` | Exit 0 using existing cached TypeScript 7.0.2 through `PATH` |
| `npm run check:extensions` | Exit 0 with the same cached executable |
| Changed TypeScript files, cached Prettier with existing style | Formatted and checked with four-space indentation, single quotes, no semicolons, ES5 trailing commas |
| `git diff --check` | Clean |

Final source logs:

- `/tmp/pi-subagents-m1-final-workspace.log`
- `/tmp/pi-subagents-m1-final-host.log`
- `/tmp/pi-subagents-m1-final-all.log`
- `/tmp/pi-subagents-format.log`

TypeScript executable lookup used
`PATH=/home/nacho/.npm/_npx/d08dbff2f92d3e31/node_modules/.bin:$PATH`.
The supplemental host hook does not alias TypeBox.

An earlier full run under concurrent verification load failed the unrelated
`git-info/process.test.ts` partial-output timeout. Its nine focused tests passed,
a serial full run passed, and the final ordinary `npm test` also passed. No
`git-info` code changed. An attempted `NODE_OPTIONS=--test-concurrency=1` command
was rejected by Node; the valid serial invocation was
`npm test -- --test-concurrency=1`.

No full interactive CLI lifecycle, live-provider quality evaluation, provider-
driven compaction, filesystem crash/fault injection, shutdown timeout, or
performance benchmark was run. These results do not replace those scenarios.

## M2 verification

| Command / target | Result |
| --- | --- |
| `npm run test:subagents`, workspace Pi 1.0.0 | 294 tests: 288 pass, 6 supported-host entry skips, zero failures |
| Supplemental host suite, Pi 1.4.0 | 294 tests: 293 pass, 1 unsupported-host skip, zero failures |
| `npm test`, full workspace | 578 tests: 572 pass, 6 expected entry skips, zero failures |
| `npm run check` / `npm run check:extensions` | Exit 0 with the cached compiler |
| `bench/benchmarks.ts` | 20k result: 40,671 B per agent snapshot, 811,863 B for 20 agents, result text stored twice; usage parse 2,000 turns 0.9 ms; spawn 21.3 ms; cold reopen 4.6 ms |

Logs: `/tmp/pi-subagents-m2-host.log`, `/tmp/pi-subagents-m2-all.log`,
`/tmp/pi-subagents-m2-format.log`. The benchmark shows usage parsing is cheap
and snapshot duplication is the real cost, so incremental usage accounting is
not justified in M2.

## M3 verification

| Command / target | Result |
| --- | --- |
| `npm run test:subagents`, workspace Pi 1.0.0 | 337 tests: 331 pass, 6 supported-host entry skips, zero failures |
| Supplemental host suite, Pi 1.4.0 | 337 tests: 336 pass, 1 unsupported-host skip, zero failures |
| `npm test`, full workspace, serial | 621 tests: 615 pass, 6 expected entry skips, zero failures |
| `npm run check:extensions` | Exit 0 with the cached compiler |
| `bench/benchmarks.ts` | spawn 22.2 ms, cold reopen 4.5 ms, snapshot numbers unchanged |

Logs: `/tmp/pi-subagents-m3-final-workspace.log`,
`/tmp/pi-subagents-m3-final-host.log`, `/tmp/pi-subagents-m3-final-all.log`,
`/tmp/pi-subagents-m3-format.log`.

## Completion report requirements

The final report must list implemented findings separately from deferred ones, files changed, exact test commands and results, unavailable verification, and remaining host limitations. Do not call all 21 findings implemented because a few foundational changes landed. Do not commit changes unless requested.
