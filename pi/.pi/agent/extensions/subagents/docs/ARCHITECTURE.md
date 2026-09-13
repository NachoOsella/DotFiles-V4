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
FINAL_ANSWER goes only to the direct parent with triggerTurn=false.
wait_agent synchronizes only; it never consumes or returns message content.
Interrupted != destroyed.
Completed != destroyed.
Forks copy structured AgentMessage values, never a text baseline prompt.
A child inherits the caller's active tools, cwd, skills, and context files.
Agent-count capacity != execution capacity.
Execution capacity applies to every child run, including follow-ups.
Nested agents share one coordinator and one execution limiter.
UI activity never enters a parent model context.
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

## Remaining legacy code

`manager.ts`, `host.ts`, and `host-live.ts` remain temporarily for the old unit
test adapter while V3 integration coverage is built. They are not imported by
`index.ts` and are scheduled for removal after the native-session integration
suite replaces those tests.
