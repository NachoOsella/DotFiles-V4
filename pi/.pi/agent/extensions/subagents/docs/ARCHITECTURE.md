# Architecture

V3 treats Pi as the runtime for every agent. The extension owns the team graph,
admission control, communication routing, and UI activity; `AgentSession` owns
queues, ordering, lifecycle, and conversation persistence.

## Invariants

```text
Agent identity != loaded AgentSession.
Conversation state belongs to Pi SessionManager.
There is no extension mailbox and no extension turn scheduler.
spawn_agent submits exactly one NEW_TASK custom message.
send_message never starts an idle turn.
followup_task steers a running session and starts an idle session.
FINAL_ANSWER goes only to the direct parent, delivered as a steer
(triggerTurn=true) so a running parent ingests it mid-run.
wait_agent synchronizes only; it never consumes or returns message content.
wait_agent follows the caller's abort signal; cancelling a wait never cancels a child.
Children load codemode and tool search, never MCP.
Collaboration tools publish an outputSchema and structuredContent, not only JSON text.
Interrupted != destroyed.
Completed != destroyed.
Forks copy structured AgentMessage values, never a text baseline prompt.
A child inherits the caller's active tools, cwd, skills, and context files.
Agent-count capacity != execution capacity.
Coordinator-started runs reserve execution capacity before session initialization.
A residency lease protects every runtime used by an operation.
Dispatch != recipient transcript insertion != model processing.
Root teams belong to branches; detached generations cannot deliver or checkpoint.
Extension-triggered excess runs are aborted at native agent_start.
Nested agents share one coordinator and one execution limiter.
UI activity never enters a parent model context.
The /agents inspector reads state; it never mutates an agent or its run.
Completion card metadata (role, model, tokens, cost, duration) is UI-only.
```

## Runtime shape

```text
Pi root AgentSession
       │ extension tools
       ▼
SubagentCoordinator
  Agent registry
  Execution limiter
  Wait hub
  Snapshot persistence
  Session factory
  Communication endpoints
       │
       ├── /root/reviewer -> AgentRuntime -> AgentSession
       └── /root/tests    -> AgentRuntime -> AgentSession
```

`AgentRecord` is plain persisted identity metadata. `AgentRuntime` is a loaded
session plus run bookkeeping and is disposable. The coordinator admits one
operation at a time per agent with `AgentMutex`; it never creates a second
queue or waits for a child from inside the spawning tool call.

`SessionFactory` registers the `codemode` and `tool-search` built-ins through
`DefaultResourceLoader.extensionFactories` and calls `session.bindExtensions({})`
before the child's first run, so a child reaches the same local tool
orchestration the parent has. MCP is not registered. The factory takes its agent
directory as an option instead of reading the process default, which keeps child
settings and resources explicit and makes tests hermetic.

Child disposal aborts active work, emits `session_shutdown` while extension
contexts are still valid, and then calls `session.dispose()`. Disposal is
idempotent. The coordinator classifies the current run's finalized assistant
response as well as rejected promises: Pi persists provider errors and aborts
without necessarily rejecting the prompt promise.

Native `agent_start` and `agent_settled` events supervise all turns, including
extension-triggered wakes. Observers attach before child `session_start`
handlers run. Settlement captures each turn before Pi flushes deferred wakes;
an older settlement cannot clear a newer turn's permit or tracking promise.
Prompt promises are a fallback for preflight failures and non-event adapters.

An extension can start a native turn without entering coordinator admission.
If no execution slot is available, the supervisor calls `session.abort()` at
`agent_start` and the child becomes `Interrupted`. Pi still invokes the stream
function with an already-aborted signal, so providers must honor that signal.
The extension message remains in the child transcript for a later follow-up.

## Communication

All communications use a hidden Pi custom message with
`customType: "subagents-v3:communication"` and a structured `details` value.
The LLM sees the bounded Codex-style envelope. A child endpoint calls
`AgentSession.sendCustomMessage`; the root endpoint calls
`ExtensionAPI.sendMessage`. This keeps root and child delivery on Pi's native
queue implementation.

Pi has no typed inter-agent `agent_message` channel. Custom messages therefore
become user messages when converted for an LLM request. This is an explicit
host gap, not an emulated protocol claim.

Delivery must steer, not queue: Pi's agent loop builds each turn from a local
context copy and only ingests mid-run input through its steering queue.
A `triggerTurn:false` custom message lands in session state (visible in the
transcript, persisted) while the running parent's next requests never include
it; it surfaces only on the next user prompt. Completion delivery therefore
uses `triggerTurn:true` with `deliverAs:"steer"`. Plain `send_message` keeps
its never-starts-a-turn contract via split delivery: it steers when the
target is streaming (joining the live run without starting one) and appends
queue-only when the target is idle (read on its next activation).

A completion sent to an idle child parent enters through the coordinator's run
admission, so its continuation has an execution permit, status transitions,
usage capture, and a final answer to its own parent. Insertion confirmation never
waits for the parent's model run to finish. A child releases its permit
when its native run ends, before forwarding the result. A streaming parent
receives the completion as steering input in its existing run.

Completion delivery writes its stable communication ID and payload to an outbox
before dispatch. Critical checkpoint listeners are awaited; a failed intent
checkpoint prevents dispatch. Root `sendMessage` returns void and cannot prove
insertion. Root and child adapters instead probe their recipient's active branch
for the envelope ID. Only a confirmed insertion advances the watermark.

An outstanding dispatch is not resubmitted by ordinary observation. Retries need
a known-absent probe and a native idle/terminal boundary; an unknown probe never
authorizes retry. Restored outbox entries probe before dispatch, so an already
persisted envelope can be acknowledged without sending it again. This does not
promise exactly-once processing or delivery across every crash window.

In-flight deliveries share one promise per child/run sequence. A failed receipt
checkpoint restores only entries removed by that acknowledgment and preserves
newer concurrent completions. Runtime leases pin recipients through cold load,
dispatch, and insertion observation. LRU waits for a safe victim rather than
disposing a handle still owned by an operation.

## Persistence and forks

Persistent children live below:

```text
<root-session-dir>/.subagents/<root-session-id>/<child-session>.jsonl
```

The root session stores only the V3 graph snapshot. Child transcripts remain in
their own Pi session files. Restoring the root restores unloaded identities;
`SessionManager.open()` is called only when a target is used again.

Tree navigation retires the old coordinator before selecting another branch.
It fences delivery, attempts a preliminary checkpoint, quiesces native runs,
settles every disposal, and persists final usage/outbox on the old branch. The
final checkpoint is the persistence barrier. Failure retains the fenced manager
for retry; a preliminary checkpoint failure never skips shutdown. The new
coordinator restores only the selected branch. Old child files remain intact.

`src/persistence/record-snapshot.ts` owns current-schema record serialization
and restoration, separate from live coordination. Schema validation lives in
`src/persistence/schema.ts`; branch checkpoint selection lives in
`src/persistence/session-state.ts`. Retired schemas are ignored, never migrated. Parsers validate each record, discard unrecoverable
identities and foreign roots, repair recoverable fields, and validate completion
ownership. Strict guards accept only conforming data. A checkpoint with only
unrecoverable records falls back to an earlier usable checkpoint; an explicitly
empty checkpoint remains authoritative. Restoration never marks a saved run as
actively running.

Snapshots carry the active branch from `SessionManager.getBranch()`.
`ForkProjector` applies Pi's `buildSessionProjection()` before filtering tool
chatter and subagent communications, preserving compaction/branch summaries,
and selecting structured user/final-assistant messages. This honors branch-relative
context edits. `fork_turns=N` counts logical turns, not raw entries.

Inherited assistant messages keep their content but have zero usage in the child
session. The parent already accounts for their cost; the child accounts only for
new requests. This also prevents duplicated usage after reopening a child.

## Usage and billing

The child metadata entry marks the end of imported fork history. Statistics
exclude that prefix from message, tool, token, and cost counters. New usage is
captured on finalized messages, turn completion, compaction, and idle usage
entries. Public `message_end` precedes SDK persistence, so its finalized message
is included once until the SDK appends it.

Snapshots retain per-physical-model usage and pricing provenance. The root
publishes child-only cost and the live snapshot through `dashboard:subagents`;
its footer adds that cost and prompt-token buckets to the parent's cumulative
persisted usage. Active context occupancy remains parent-only. `/stats` and `/stats all` resolve each
logical child's transcript once, falling back to snapshots for unavailable
files. Root transcript caching does not freeze independently changing children.

## Dashboard activity

The dashboard retains the latest 500 committed activity entries per agent, plus
live entries. Full conversation history remains in Pi sessions. Unread badges
count retained activity, and scrolling covers the retained window. Summary
truncation scans at most 12,000 code points and preserves surrogate pairs.
Rendering wraps entries from the tail only until the visible rows and requested
scroll offset are covered; tool-result matching still scans the retained window.

## Compatibility

Production requires Pi >=1.4.0 <2.0.0. Pi 1.0 starts idle custom-triggered runs
without preparing system instructions; the extension fails closed on that host.
The workspace's older SDK remains useful for structural tests and explicit
characterization of this gap, not as production compatibility evidence.

`src/core/pi-api-drift.test.ts` asserts the Pi surface this extension reads: the entry
points it imports, the `AgentSession` methods and getters it calls, the
`SessionStats` fields it snapshots, tool-exposure semantics, and that
`bindExtensions()` emits `session_start`. A Pi upgrade that renames or removes
any of them fails the suite instead of silently disabling a capability.
