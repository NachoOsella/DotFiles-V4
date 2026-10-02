# Codex parity

This document is a test-backed matrix, not a claim that Pi and Codex expose the
same host protocol. The behavioral reference is recorded in
`CODEX_SOURCE_MANIFEST.md`.

| Invariant                                    | V3 implementation                                                                                                                     | Verification                                                        | Status                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| Spawn is asynchronous                        | `src/core/coordinator.ts` admits a run without awaiting it                                                                            | `src/core/coordinator.test.ts`                                      | exact                  |
| One `NEW_TASK` per spawn                     | `src/core/transport.ts` submits one custom message                                                                                    | `src/core/coordinator.test.ts`                                      | exact                  |
| Queue-only message                           | Pi 1.0 defers insertion while streaming                                                                                               | `src/core/native-session.test.ts`                                   | exact                  |
| Running follow-up reaches the next boundary  | `deliverAs: "steer"`                                                                                                                  | coordinator and native-session tests                                | exact                  |
| Idle follow-up starts a run                  | native `triggerTurn: true`                                                                                                            | `src/core/coordinator.test.ts`                                      | exact                  |
| No private mailbox                           | `WaitHub` stores sequence numbers only                                                                                                | `src/core/primitives.test.ts`                                       | exact                  |
| No private scheduler                         | `AgentSession.sendCustomMessage` owns execution                                                                                       | `src/core/native-session.test.ts`                                   | exact                  |
| Direct-parent final answer                   | `deliverCompletion()` resolves `parentPath`                                                                                           | `src/core/coordinator.test.ts`                                      | exact                  |
| Final answer reaches the parent mid-run      | completion delivery steers (`triggerTurn: true`, `deliverAs: "steer"`); queue-only customs bypass a running loop's local context copy | `src/core/coordinator.test.ts`                                      | intentional divergence |
| Structured full fork                         | `ForkProjector` copies `AgentMessage` values                                                                                          | `src/core/primitives.test.ts`                                       | exact                  |
| Tool chatter excluded from forks             | projector filters tool calls/results                                                                                                  | `src/core/primitives.test.ts`                                       | exact                  |
| `fork_turns=N` counts logical turns          | projector groups input/final pairs                                                                                                    | `src/core/primitives.test.ts`                                       | close                  |
| Child session file reopens                   | nested persistent `SessionManager`                                                                                                    | `src/core/primitives.test.ts` and `src/core/native-session.test.ts` | exact                  |
| Child AgentSession cold resume               | `SessionFactory.open()` restores the runtime                                                                                          | factory-level kiwi E2E still pending                                | partial                |
| Parent-authoritative cold reload             | Direct child session reopen only                                                                                                      | Pi has no equivalent parent authority object                        | host gap               |
| Environment and execution policy inheritance | Child resource loading only                                                                                                           | Pi exposes no Codex-equivalent permission/policy bundle             | host gap               |
| Child tool reach                             | Caller's active tools are the allowlist; codemode and tool search load as built-ins                                                   | `src/core/session-factory.test.ts`                                  | Pi adaptation          |
| Agent count differs from run capacity        | registry reservation plus `ExecutionLimiter`                                                                                          | limiter and coordinator tests                                       | close                  |
| V2 ignores configured max depth              | Pi deliberately enforces `maxDepth` as a safety limit; direct children have nesting depth 0                                           | coordinator and prompt tests                                        | intentional divergence |
| Durable nested completion delivery           | Failed `FINAL_ANSWER` deliveries remain in the child record outbox and retry when the parent loads                                    | `src/core/coordinator.test.ts`                                      | Pi adaptation          |
| Wait does not return payload                 | `WaitHub` has no content store                                                                                                        | `src/core/primitives.test.ts`                                       | exact                  |
| Typed `agent_message` protocol               | Pi custom message conversion                                                                                                          | no Pi primitive                                                     | host gap               |
| Thread switching without replacing root      | Pi has no attach/switch primitive                                                                                                     | no safe implementation                                              | missing                |
| Codex reasoning channel parity               | Pi custom messages become user context                                                                                                | no Pi primitive                                                     | host gap               |

## Explicit host gaps

Pi converts `CustomMessage` into a user message for provider context. V3 cannot
produce Codex's literal typed `agent_message` analysis item without changing
Pi. It also cannot implement Codex thread switching safely because Pi's session
switch replaces the active runtime. These differences are documented rather
than hidden behind a fake host.

The pinned Codex revision is a behavioral reference, not a claim that every
behavior at that SHA is ported. In particular, Codex cold reload validates child
ownership through a loaded parent and reconstructs execution state from current
parent authority/config. Pi exposes no equivalent authority, environment,
permission, or execution-policy bundle, so V3 reopens persisted child sessions
directly.

Only the current snapshot schema (`version: 2`, `subagents-v3-state`) is loaded.
Retired snapshot formats and settings aliases are ignored, with no migration
or reconstructed in-memory child sessions.
