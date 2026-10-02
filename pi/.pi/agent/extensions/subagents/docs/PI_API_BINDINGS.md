# Pi API bindings

V3 is bound to the installed `@earendil-works/pi-coding-agent@1.0.0` APIs.
The coordinator does not emulate Pi lifecycle or queues.

| Capability                           | Pi primitive                                                        | V3 use                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Child session creation               | `createAgentSession()`                                              | `src/core/session-factory.ts`                                                           |
| Child extension startup              | `session.bindExtensions({})`                                        | emits `session_start` once per created or reopened child                                |
| Child extension shutdown             | `session.extensionRunner.emit()` before `session.dispose()`         | runs finalizers once while contexts are still valid                                     |
| Local tool orchestration in children | `createCodemodeExtension()`, `createToolSearchExtension()`          | `src/core/session-factory.ts`, registered as the `codemode` and `tool-search` built-ins |
| Structured tool results              | `outputSchema` and `structuredContent`                              | `src/tools/extension-tools.ts`, one shape for direct calls and scripts                  |
| Wait cancellation                    | `ctx.signal` into `WaitHub.wait()`                                  | abort ends the wait, never the child run                                                |
| Nested call activity                 | `parentToolCallId` on `tool_execution_*`                            | `src/core/agent-runtime.ts`, `src/ui/agents-modal.ts`                                   |
| Child settings and resources         | `SessionFactoryOptions.agentDir`                                    | defaults to the host's agent directory                                                  |
| Persistent child history             | `SessionManager.create(cwd, sessionDir)`                            | `.subagents/<root-session-id>`                                                          |
| Cold resume                          | `SessionManager.open(sessionFile, ...)`                             | lazy `ensureLoaded()`                                                                   |
| Active context                       | `sessionManager.getBranch()`, `buildSessionProjection()`            | applies compaction and context edits before fork selection                              |
| Child message delivery               | `AgentSession.sendCustomMessage()`                                  | child endpoint                                                                          |
| Root message delivery                | `ExtensionAPI.sendMessage()`                                        | root endpoint                                                                           |
| Running follow-up                    | `sendCustomMessage(..., { deliverAs: "steer", triggerTurn: true })` | coordinator follow-up                                                                   |
| Idle follow-up                       | `sendCustomMessage(..., { triggerTurn: true })`                     | coordinator run admission                                                               |
| Queue-only message                   | `sendCustomMessage(..., { triggerTurn: false })`                    | deferred safely by Pi while streaming                                                   |
| Interrupt                            | `AgentSession.abort()`                                              | coordinator interrupt                                                                   |
| Active tools                         | `getActiveToolNames()` and SDK `tools` allowlist                    | caller inheritance                                                                      |
| Thinking level                       | `AgentSession.thinkingLevel` and SDK `thinkingLevel`                | caller inheritance                                                                      |
| Model identity                       | `AgentSession.model`, `ModelRegistry.find()`                        | exact provider/id resolution                                                            |
| Role prompt                          | `DefaultResourceLoader.appendSystemPromptOverride`                  | child role prompt                                                                       |
| Root persistence                     | `pi.appendEntry()`                                                  | graph snapshot only                                                                     |
| UI widget                            | `ctx.ui.setWidget()`                                                | running-only activity widget                                                            |
| Child activity                       | `AgentSession.subscribe()`                                          | bounded `ToolActivity` events                                                           |
| Native run supervision               | `agent_start`, `agent_settled` through `AgentSession.subscribe()`   | admission bookkeeping and per-turn settlement, including extension wakes                |
| Native idle synchronization          | `AgentSession.isIdle`, `waitForIdle()`                              | waits for deferred SDK turns before idle delivery                                       |

Excess extension-triggered turns are aborted from `agent_start`. Pi still calls
the stream function with an aborted signal; cancellation depends on the provider
honoring that signal. The coordinator does not replace SDK stream functions or
rebind extension runtime internals.

## Deliberate non-bindings

- Children inherit the caller's active tool names as the session allowlist. A
  tool another extension registers with `codemode` or `deferred` exposure is
  therefore not reachable from a child script unless the caller had it active.
- MCP is not loaded in children. `createMcpExtension()` is never registered, so
  a child never reads `mcp.json`, connects a server, or starts a stdio process.
  `-builtin:codemode` and `-builtin:tool-search` still disable those two.
- Pi has no typed Codex `agent_message`; V3 uses hidden custom messages with a
  structured `details` payload and documents the conversion to user context.
- Pi's session switch replaces the active runtime; V3 therefore exposes a
  read-only `/agents` inspector rather than thread switching.
- `wait_agent` uses coordinator sequence numbers only. It does not maintain a
  second message queue and does not drain the Pi session.
- Children load project context, skills, prompt templates, and other enabled
  extensions. Only the subagents extension itself is filtered out; collaboration
  tools are injected as `customTools`.
- Pi exposes no Codex-equivalent parent authority object for cold reload. V3
  reopens the child's persistent session directly and cannot revalidate ownership
  or reconstruct environment, permissions, execution policy, and inherited
  instructions from a loaded parent.
