# Codex parity

This document is a test-backed matrix, not a claim that Pi and Codex expose the
same host protocol. The behavioral reference is recorded in
`CODEX_SOURCE_MANIFEST.md`.

| Invariant | V3 implementation | Verification | Status |
| --- | --- | --- | --- |
| Spawn is asynchronous | `coordinator.ts` admits a run without awaiting it | code path; native-session E2E pending | partial |
| One `NEW_TASK` per spawn | `transport.ts` submits one custom message | native-session E2E pending | partial |
| Queue-only message | `sendCustomMessage({ triggerTurn: false })` | native-session E2E pending | partial |
| Running follow-up reaches the next boundary | `deliverAs: "steer"` | native-session E2E pending | partial |
| Idle follow-up starts a run | native `triggerTurn: true` | native-session E2E pending | partial |
| No private mailbox | `WaitHub` stores sequence numbers only | `v3-primitives.test.ts` | exact |
| No private scheduler | `AgentSession.sendCustomMessage` owns execution | code path; native-session E2E pending | partial |
| Direct-parent final answer | `deliverCompletion()` resolves `parentPath` | code path; native-session E2E pending | partial |
| Final answer does not trigger parent | final endpoint uses `triggerTurn: false` | transport test pending | partial |
| Structured full fork | `ForkProjector` copies `AgentMessage` values | `v3-primitives.test.ts` | exact |
| Tool chatter excluded from forks | projector filters tool calls/results | `v3-primitives.test.ts` | exact |
| `fork_turns=N` counts logical turns | projector groups input/final pairs | `v3-primitives.test.ts` | close |
| Child session file reopens | nested persistent `SessionManager` | `v3-primitives.test.ts` | exact |
| Child AgentSession cold resume | `SessionFactory.open()` restores the runtime | kiwi marker E2E pending | partial |
| Agent count differs from run capacity | registry reservation plus `ExecutionLimiter` | limiter test; coordinator stress pending | partial |
| Wait does not return payload | `WaitHub` has no content store | `v3-primitives.test.ts` | exact |
| Typed `agent_message` protocol | Pi custom message conversion | no Pi primitive | host gap |
| Thread switching without replacing root | Pi has no attach/switch primitive | no safe implementation | missing |
| Codex reasoning channel parity | Pi custom messages become user context | no Pi primitive | host gap |

## Explicit host gaps

Pi converts `CustomMessage` into a user message for provider context. V3 cannot
produce Codex's literal typed `agent_message` analysis item without changing
Pi. It also cannot implement Codex thread switching safely because Pi's session
switch replaces the active runtime. These differences are documented rather
than hidden behind a fake host.

The old V2 snapshot format is accepted only as `legacyUnresumable`; it never
pretends that an in-memory child transcript can be resumed.
