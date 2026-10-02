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
Execution capacity applies to every child run, including follow-ups.
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

## Persistence and forks

Persistent children live below:

```text
<root-session-dir>/.subagents/<root-session-id>/<child-session>.jsonl
```

The root session stores only the V3 graph snapshot. Child transcripts remain in
their own Pi session files. Restoring the root restores unloaded identities;
`SessionManager.open()` is called only when a target is used again.

`ForkProjector` reads `SessionManager.buildContextEntries()`, filters tool
chatter and subagent communications, preserves compaction/branch summaries,
and copies structured user/final-assistant messages. `fork_turns=N` counts
logical turns, not raw entries.

## Compatibility

`pi-api-drift.test.ts` asserts the Pi surface this extension reads: the entry
points it imports, the `AgentSession` methods and getters it calls, the
`SessionStats` fields it snapshots, tool-exposure semantics, and that
`bindExtensions()` emits `session_start`. A Pi upgrade that renames or removes
any of them fails the suite instead of silently disabling a capability.
