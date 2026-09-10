# Pi API bindings

Source-verified against the installed `@earendil-works/pi-coding-agent`
(`0.84.2`, `dist/*.d.ts`). Every `PiHostLive` method delegates to one of
these primitives; no orchestration lives in the adapter.

| Required capability | Pi symbol | Path |
|---|---|---|
| Register model tools | `pi.registerTool(tool)` | `core/extensions/types.d.ts` (`ExtensionAPI`) |
| Tool parameter schemas | `Type.Object(...)` from `typebox` | extension `ToolDefinition.parameters` |
| Child agent session creation | `createAgentSession(options)` | `core/sdk.d.ts` |
| In-memory child sessions | `SessionManager.inMemory(cwd)` | `core/session-manager.d.ts` |
| Extension-free child runtime | `new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noThemes: true })` + `resourceLoader.reload()` | `core/resource-loader.d.ts` |
| AgentDir for child loader | `getAgentDir()` | `index.d.ts` |
| Child custom (collaboration) tools | `createAgentSession({ customTools })` | `core/sdk.d.ts` (`CreateAgentSessionOptions`) |
| Child full extension set (minus subagents) | `DefaultResourceLoader({ settingsManager, extensionsOverride })` filtering `extensions/subagents/index.ts` | `core/resource-loader.d.ts` (`DefaultResourceLoaderOptions`) |
| Child settings parity (disabled stay disabled) | `SettingsManager.create(cwd, agentDir)` for the child loader | `core/settings-manager.d.ts` |
| Activate every registered child tool | `session.setActiveToolsByName(session.getAllTools().map(t => t.name))` (SDK leaves customs/extensions inactive by default) | `core/agent-session.d.ts` (`AgentSession`) |
| Run a model/tool turn | `session.prompt(text, { expandPromptTemplates: false })` | `core/agent-session.d.ts` (`AgentSession`) |
| Abort a turn | `session.abort()` | `core/agent-session.d.ts` |
| Child cleanup | `session.dispose()` | `core/agent-session.d.ts` |
| Last assistant text (FINAL_ANSWER source) | `session.getLastAssistantText()` | `core/agent-session.d.ts` |
| Typed message injection | `session.sendCustomMessage({ customType, content, display, details }, { triggerTurn })` | `core/agent-session.d.ts` |
| Parent branch text (fork source) | `ctx.sessionManager.getBranch()` | `core/session-manager.d.ts` (`ReadonlySessionManager`) |
| In-memory session detection | `ctx.sessionManager.getSessionDir() === ""` | `core/session-manager.d.ts` |
| Mailbox delivery boundary | `pi.on("context", handler)` returning `{ messages }` | `core/extensions/types.d.ts` |
| Role prompt fragment | `pi.on("before_agent_start", handler)` returning `{ systemPrompt }` (appended) | `core/extensions/types.d.ts` |
| Steering wake for `wait_agent` | `pi.on("input", handler)` | `core/extensions/types.d.ts` |
| Caller resolution | `ctx.sessionManager.getSessionId()` + manager bindings | `core/session-manager.d.ts` |
| Persistence (logical state only) | `pi.appendEntry(customType, data)` + branch scan for `type: "custom"` | `core/extensions/types.d.ts`, `core/session-manager.d.ts` (`CustomEntry`) |
| Cold resume scan | entries with `type === "custom"` and `customType === "subagents-v2-state"` | `core/session-manager.d.ts` |
| Compact widget | `ctx.ui.setWidget(key, factory \| undefined)` | todowrite `widget.ts` precedent |
| Lifecycle / shutdown | `pi.on("session_start" \| "session_tree" \| "session_shutdown" \| "agent_settled" \| "tool_result", ...)` | `core/extensions/types.d.ts` |
| Cwd inheritance | `ctx.cwd` | `core/extensions/types.d.ts` (`ExtensionContext`) |
| Model snapshot | `ctx.model` (unused; host defaults to `pi-default` marker) | `core/extensions/types.d.ts` |

## Deliberate non-bindings

- **No typed `agent_message` input.** Pi has `CustomMessage` entries
  (`appendCustomMessageEntry`) which convert to user messages in
  `buildSessionContext`. Mail uses `role: "custom"` context injection
  with the exact `Message Type / Task name / Sender / Payload` envelope
  preserved as text. See `CODEX_PARITY.md`.
- **No model capability bit for collaboration support.** Children always
  receive the collaboration tools; there is no leaf-model mode and no
  model-name allowlist.
- **No `Ultra` reasoning level mapping.** `resolveMode` always resolves
  explicit-only unless `multiAgentModeHintText` is configured.
- **No encrypted payloads.** Payloads are plaintext in local session
  history; never emitted in telemetry or the default widget.
