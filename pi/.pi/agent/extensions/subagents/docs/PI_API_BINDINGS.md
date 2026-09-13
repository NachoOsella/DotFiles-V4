# Pi API bindings

V3 is bound to the installed `@earendil-works/pi-coding-agent@0.85.1` APIs.
The coordinator does not emulate Pi lifecycle or queues.

| Capability | Pi primitive | V3 use |
| --- | --- | --- |
| Child session creation | `createAgentSession()` | `session-factory.ts` |
| Persistent child history | `SessionManager.create(cwd, sessionDir)` | `.subagents/<root-session-id>` |
| Cold resume | `SessionManager.open(sessionFile, ...)` | lazy `ensureLoaded()` |
| Active context | `sessionManager.buildContextEntries()` | `ParentExecutionSnapshot`, `ForkProjector` |
| Child message delivery | `AgentSession.sendCustomMessage()` | child endpoint |
| Root message delivery | `ExtensionAPI.sendMessage()` | root endpoint |
| Running follow-up | `sendCustomMessage(..., { deliverAs: "steer", triggerTurn: true })` | coordinator follow-up |
| Idle follow-up | `sendCustomMessage(..., { triggerTurn: true })` | coordinator run admission |
| Queue-only message | `sendCustomMessage(..., { triggerTurn: false })` | deferred safely by Pi while streaming |
| Interrupt | `AgentSession.abort()` | coordinator interrupt |
| Active tools | `getActiveToolNames()` and SDK `tools` allowlist | caller inheritance |
| Thinking level | `AgentSession.thinkingLevel` and SDK `thinkingLevel` | caller inheritance |
| Model identity | `AgentSession.model`, `ModelRegistry.find()` | exact provider/id resolution |
| Role prompt | `DefaultResourceLoader.appendSystemPromptOverride` | child role prompt |
| Root persistence | `pi.appendEntry()` | graph snapshot only |
| UI widget | `ctx.ui.setWidget()` | running-only activity widget |
| Child activity | `AgentSession.subscribe()` | bounded `ToolActivity` events |

## Deliberate non-bindings

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
