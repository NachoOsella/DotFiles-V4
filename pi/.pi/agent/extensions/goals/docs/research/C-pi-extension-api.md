# C - Pi extension API reference (installed 1.4.0)

Research for the `goals` extension: a stateful loop that resumes the agent after it settles.

- Installed package: `/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent`
- Installed version: **1.4.0**
- npm registry: `npm view @earendil-works/pi-coding-agent version` -> `1.4.0`; latest tag in `versions` -> `1.4.0`. **1.4.0 is current** (checked 2025, no newer major/minor).
- Peer packages resolved inside the install: `node_modules/@earendil-works/pi-{agent-core,ai,tui,codemode,mcp,telemetry}` all `1.4.0`.

## Citation and evidence convention

`$PKG` = `/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent`.
All `path:line` citations are relative to `$PKG` unless they start with `extensions/` (local, `/home/nacho/.pi/agent/extensions/`).

Every claim is tagged:

| Tag | Meaning |
|---|---|
| `[RUNTIME]` | Verified by reading the executable JS in `dist/**/*.js`. This is the strongest evidence here. |
| `[TYPES]` | Taken from `dist/**/*.d.ts` only. The declaration exists; runtime behavior not traced. |
| `[EMPIRICAL]` | Verified by executing the installed `pi` binary or the installed `jiti` against a scratch extension in `/tmp`. |
| `[DOC]` | From `docs/*.md`. Used only for wording/intent, never as sole evidence for behavior. |

Nothing under the installed package or other extensions was modified. Scratch probes live in `/tmp/jiticheck`, `/tmp/piextcheck`.

---

## 1. Extension loading

### 1.1 Factory contract

An extension module's default export must be a function `(pi: ExtensionAPI) => void | Promise<void>`.

```
// dist/core/extensions/types.d.ts:1518
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

`[RUNTIME]` `dist/core/extensions/loader.js:464-500`: the module is imported with `{ default: true }` (`:484`); a non-function default yields the error `Extension does not export a valid factory function: <path>` (`:533`). The factory is awaited before `load.commit()` (`loader.js:513-521`), so an async factory delays startup. `[DOC]` `docs/extensions.md:13-48`.

### 1.2 Discovery rules

`[RUNTIME]` `dist/core/extensions/loader.js:596-632` (`resolveExtensionEntries`) and `:635-663` (`discoverExtensionsInDir`):

1. Direct files `extensions/*.ts` or `extensions/*.js` load.
2. Subdirectory with `index.ts` (preferred) or `index.js` loads that file.
3. Subdirectory with `package.json` whose `pi.extensions` array lists entry paths loads those paths, resolved relative to the directory (`path.resolve(dir, extPath)`, `loader.js:604`). Missing entries are silently skipped; if none exist it falls through to `index.ts`/`index.js`.
4. **No recursion beyond one level.** `discoverExtensionsInDir` iterates only `readdirSync(dir)` and does not descend further.

Scanned roots (`loader.js:666-702`): `<cwd>/.pi/extensions/` (`:680`), then `<agentDir>/extensions/` (`:683`), then explicitly configured paths (`--extension` / settings, `:686`). For a configured path that is a directory, the same `resolveExtensionEntries` applies, otherwise individual files are discovered one level down.

### 1.3 The `pi` manifest field

`[RUNTIME]` `dist/core/pi-manifest.js:1-27`:

```
// dist/core/pi-manifest.d.ts:1-6
export interface PiManifest {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
}
export declare function readPiManifest(packageJsonPath: string): PiManifest | null;
```

- It reads `package.json` and only accepts `pkg.pi` as an **object** (`pi-manifest.js:10`). It is `"pi": { "extensions": [...] }`, **not** a top-level `"pi.extensions"` key and **not** `pi: ["..."]`.
- `extensions` must be an array of strings; anything else is silently dropped (`pi-manifest.js:14-20`).
- Relative paths are resolved against the directory that owns the `package.json` (`loader.js:596-611`).

### 1.4 Does a helper `src/index.ts` entry work with `pi.extensions`?

Yes. `[RUNTIME]` (resolution) + `[EMPIRICAL]` (real load):

```json
// /tmp/piextcheck/package.json
{ "name": "piextcheck", "private": true, "pi": { "extensions": ["src/index.ts"] } }
```

```
$ pi --no-session --extension /tmp/piextcheck -p "/piextcheck  alpha beta "
EXT_LOADED marker=lib-ok args=" alpha beta " mode=print hasUI=false
```

The probe extension was `/tmp/piextcheck/src/index.ts` importing `./lib.js` while the real file is `src/lib.ts`. Both the manifest entry and the relative import worked.

Consequence for `goals`: `extensions/goals/package.json` may declare `{"pi":{"extensions":["src/index.ts"]}}`; the `extensions/*` discovery rule then loads `goals/src/index.ts` and **does not** load anything under `goals/src/` as a separate extension (discovery is one level only). A directory with no `index.ts` and no manifest entry is silently ignored.

### 1.5 jiti and import specifiers

`[RUNTIME]` `dist/core/extensions/loader.js:37-101` (alias table), `:474-484` (jiti creation):

```
const jiti = createJitiImpl(import.meta.url, {
    moduleCache: false,
    ...resolutionOptions,
});
const module = await jiti.import(extensionPath, { default: true });
```

- Unbundled Node installs (what is installed here) use `{ alias: getAliases() }` (`loader.js:475-479`).
- Aliased: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (mapped to the **compat** entrypoint), `@earendil-works/pi-ai/{compat,models,oauth,providers/all}`, the deprecated `@mariozechner/*` names, and `typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox*` (`loader.js:63-99`).
- `moduleCache: false`, so every load re-transpiles. Per-extension load caching is opt-in via `loadExtensionsCached` (`loader.js:487-499`, `:580-582`).
- `[DOC]` `docs/extensions.md:38`: Pi uses jiti, so TypeScript extensions need no build step.
- jiti handles TypeScript transform and ESM interop; other npm dependencies resolve through normal parent-directory lookup from the extension file.

**Relative import suffix `[EMPIRICAL]`** — using the installed jiti with the loader's exact options (`{ moduleCache: false }`), a `.ts` file importing a sibling:

| Specifier | Result |
|---|---|
| `"./helper.js"` (file is `helper.ts`) | resolves, loads `helper.ts` |
| `"./helper.ts"` | resolves |
| `"./helper"` | resolves |

All three work, so the repo convention (`.js` suffix per `~/.pi/AGENTS.md`) and the local code style (`.ts` suffix, e.g. `extensions/subagents/index.ts:9` -> `'./src/ui/agents-modal.ts'`) are both valid. Prefer one style per package; mixing is legal but confusing.

### 1.6 Lifecycle of the runtime object (important for state)

`[RUNTIME]` `dist/main.js:701-706` creates `createAgentSessionRuntime(createRuntime, ...)`, and `createRuntime` calls `createAgentSessionServices` -> resource loader -> extension discovery. `dist/core/agent-session-runtime.js:118-190` (`switchSession`/`newSession`/`fork`) calls `createRuntime` again after `teardownCurrent`. Therefore:

- **Every session replacement re-runs the extension factory with new objects.** In-memory module-level state does not survive `/new`, `/resume`, `/fork`, or `ctx.reload()`.
- `teardownCurrent` aborts the active run, emits `session_shutdown`, then invalidates the old runner (`agent-session-runtime.js:100-111`). Stale-API use throws: `runtime.assertActive()` (`loader.js:115-120`, `:197-201`; message set in `runner.js:483-491`).
- `[DOC]` `docs/extensions.md:58-60`: do not start processes/watchers in the factory; use `session_start` / `session_shutdown`.
- `pi.on()` returns an unsubscribe function (`types.d.ts:1187` etc.), but the whole runtime is discarded on replacement.

---

## 2. `ExtensionAPI` — full surface

Copied from `dist/core/extensions/types.d.ts:1186-1407`. Signatures are verbatim; doc comments are trimmed to the semantic ones and the long `@example` block in `registerProvider` is elided (marked).

```ts
// dist/core/extensions/types.d.ts:1186
export interface ExtensionAPI {
    on(event: "project_trust", handler: ProjectTrustHandler): () => void;
    on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): () => void;
    on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
    on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
    on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): () => void;
    on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): () => void;
    on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): () => void;
    on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
    on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
    on(event: "mcp_servers_change", handler: ExtensionHandler<McpServersChangeEvent>): () => void;
    on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): () => void;
    on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
    on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
    on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
    on(event: "cache_warming_decision", handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>): () => void;
    on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): () => void;
    on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
    on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
    on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
    on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): () => void;
    on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
    on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
    on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>): () => void;
    on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
    on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
    on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
    on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
    on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
    on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
    on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
    on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
    on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
    on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
    on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
    on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
    on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
    on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
    on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
    on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;

    /** Register a tool that the LLM can call. */
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
    /** Register a custom command. */
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
    /** Register a keyboard shortcut. */
    registerShortcut(shortcut: KeyId, options: {
        description?: string;
        handler: (ctx: ExtensionContext) => Promise<void> | void;
    }): void;
    /** Register a CLI flag. */
    registerFlag(name: string, options: {
        description?: string;
        type: "boolean";
        default?: boolean;
    } | {
        description?: string;
        type: "string";
        default?: string;
    }): void;
    /** Get the value of a registered CLI flag. */
    getFlag(name: string): boolean | string | undefined;
    /** Register a custom renderer for CustomMessageEntry. */
    registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
    /** Register a transformer for user and assistant Markdown before Pi renders it in the interactive transcript. */
    registerMarkdownTransformer(transformer: MarkdownTransformer): void;
    /** Register a custom renderer for CustomEntry. Custom entries do not participate in LLM context. */
    registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
    /** Choose how tool calls are drawn. Resolvers run in extension load order. */
    registerToolRenderer(resolver: ToolRendererResolver): void;
    /** Send a custom message to the session. */
    sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
        triggerTurn?: boolean;
        deliverAs?: "steer" | "followUp" | "nextTurn";
    }): void;
    /**
     * Send a user message to the agent. Always triggers a turn.
     * When the agent is streaming, use deliverAs to specify how to queue the message.
     * Set expandPromptTemplates to dispatch extension commands and expand skill commands and prompt templates.
     */
    sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
        deliverAs?: "steer" | "followUp";
        expandPromptTemplates?: boolean;
    }): void;
    /** Append a custom entry to the session for state persistence (not sent to LLM). */
    appendEntry<T = unknown>(customType: string, data?: T): void;
    /** Set the session display name (shown in session selector). */
    setSessionName(name: string): void;
    /** Get the current session name, if set. */
    getSessionName(): string | undefined;
    /** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
    setLabel(entryId: string, label: string | undefined): void;
    /** Execute a shell command. */
    exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
    /** Get the names of the active tools, which are the tools declared to the model. */
    getActiveTools(): string[];
    /** Get all configured tools with parameter schema, prompt guidelines, exposure, and source metadata. */
    getAllTools(): ToolInfo[];
    /** Get a copy of the effective settings (global and project settings merged, with overrides). */
    getSettings(): Settings;
    /** Set the active tools by name. Unknown and `hidden` tools are ignored. ... */
    setActiveTools(toolNames: string[]): void;
    /** Get available slash commands in the current session. */
    getCommands(): SlashCommandInfo[];
    /** Set the model for the current session ... Returns false if authentication is not configured. */
    setModel(model: Model<any>): Promise<boolean>;
    /** Get current thinking level. */
    getThinkingLevel(): ThinkingLevel;
    /** Set the thinking level (clamped to model capabilities) ... */
    setThinkingLevel(level: ThinkingLevel): void;
    /* ... @example blocks elided ... */
    registerProvider(provider: Provider): void;
    registerProvider(name: string, config: ProviderConfig): void;
    unregisterProvider(name: string): void;
    registerMcpServer(name: string, config: McpServerConfig): void;
    unregisterMcpServer(name: string): void;
    /** Every MCP server registered by extensions. */
    getMcpServers(): RegisteredMcpServer[];
    registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;
    unregisterVirtualModel(provider: string, id: string): void;
    /** Shared event bus for extension communication. */
    events: EventBus;
}
```

Note: there is **no** `refreshTools`, `getSessionStats`, `getMessages`, `log`, `getState`, or `store` on `ExtensionAPI`. `refreshTools` exists only in the internal `ExtensionActions` (`types.d.ts:1651`).

### 2.1 `ToolDefinition` (verbatim, `types.d.ts:453-519`)

```ts
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
    /** Tool name (used in LLM tool calls) */
    name: string;
    /** Human-readable label for UI */
    label: string;
    /** Description for LLM */
    description: string;
    /** Optional one-line snippet for the Available tools section in the default system prompt. */
    promptSnippet?: string;
    /** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
    promptGuidelines?: string[];
    /** Parameter schema (TypeBox) */
    parameters: TParams;
    /** Optional provider-side constrained sampling request ... Set false to explicitly disable it */
    constrainedSampling?: false | ConstrainedSamplingConfig;
    /** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
    renderShell?: "default" | "self";
    /** Optional compatibility shim to prepare raw tool call arguments before schema validation. */
    prepareArguments?: (args: unknown) => Static<TParams>;
    outputSchema?: TSchema;
    /** How the model reaches the tool. Default: `"direct"`. See {@link ToolExposure}. */
    exposure?: ToolExposure;
    namespace?: ToolNamespace;
    reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[];
    annotations?: ToolAnnotations;
    defaultActive?: boolean;
    prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
    executionMode?: ToolExecutionMode;
    /** Execute the tool. */
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
    /** Custom rendering for tool call display */
    renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
    /** Custom rendering for tool result display */
    renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
}
```

Key detail: `execute` returns `AgentToolResult<TDetails>` which is `{ content, details, isError?, usage?, terminate?, structuredContent? }` (`types.d.ts` re-exports it from `pi-agent-core`). `[DOC]` `docs/extensions.md:245-266`: throw to produce a failed result; a returned object is a success; include nested-call `usage`.

`exposure` semantics (`types.d.ts:395-399`), `[DOC]` `docs/extensions.md:266-273`: `direct` (default, declared + callable), `model-only`, `codemode`, `deferred`, `hidden` ("registered but unreachable; activating has no effect"). **Tools cannot be unregistered**; withdraw with `exposure: "hidden"`.

`ToolAnnotations` (`types.d.ts:400-412`): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

### 2.2 `RegisteredCommand` and command handler context

```ts
// types.d.ts:1171
export interface RegisteredCommand {
    name: string;
    sourceInfo: SourceInfo;
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}
```

`extensionPath`/`sourceInfo` are filled by the loader, so `registerCommand` takes `Omit<RegisteredCommand, "name" | "sourceInfo">`.

```ts
// types.d.ts:286
export interface ExtensionCommandContext extends ExtensionContext {
    getSystemPromptOptions(): BuildSystemPromptOptions;
    waitForIdle(): Promise<void>;
    newSession(options?: { parentSession?: string; setup?: (sessionManager: SessionManager) => Promise<void>; withSession?: (ctx: ReplacedSessionContext) => Promise<void>; }): Promise<{ cancelled: boolean }>;
    fork(entryId: string, options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void>; }): Promise<{ cancelled: boolean }>;
    navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string; }): Promise<{ cancelled: boolean }>;
    switchSession(sessionPath: string, options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void>; }): Promise<{ cancelled: boolean }>;
    reload(): Promise<void>;
}
// types.d.ts:329
export interface ReplacedSessionContext extends ExtensionCommandContext {
    sendMessage<T = unknown>(message: ..., options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
    sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): Promise<void>;
}
```

`ExtensionContext` itself (`types.d.ts:213-234`) has `ui`, `mode`, `hasUI`, `cwd`, `sessionManager: ReadonlySessionManager` (`:223`), `modelRegistry`, `model`, `scopedModels`, `thinkingLevel?`, `isIdle()`, `isProjectTrusted()`, `signal`, `abort()`, `hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact(options?)`, `getSystemPrompt()`.

`[RUNTIME]` `dist/core/agent-session.js:2813-2841` maps those actions: `isIdle: () => this.isIdle`, `getSignal: () => this.agent.signal`, `hasPendingMessages: () => this.pendingMessageCount > 0`, `compact` runs async and reports via `onComplete`/`onError`.

---

## 3. The settlement boundary

This is the core of the goal loop. Types first, then exact runtime semantics.

### 3.1 Types (verbatim)

```ts
// types.d.ts:753
export interface CustomEntryDraft {
    type: "custom";
    customType: string;
    data?: unknown;
}
export interface CustomMessageEntryDraft {
    type: "custom_message";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: unknown;
}
export interface ContextEditEntryDraft {
    type: "context_edit";
    targetId: string;
    replacement: ContextEditEntry["replacement"];
}
export interface CompactionEntryDraft {
    type: "compaction";
    summary: string;
    /** Null creates a self-retaining compaction that keeps no preceding entries. */
    firstKeptEntryId: string | null;
    details?: unknown;
    usage?: Usage;
}
export type SessionBoundaryDraft = CustomEntryDraft | CustomMessageEntryDraft | ContextEditEntryDraft | CompactionEntryDraft;
export interface BoundaryContextPreview {
    contextEntries: ProjectedSessionEntry[];
    contextMessages: AgentMessage[];
    llmMessages: Message[];
    pendingMessages: AgentMessage[];
    canContinue: boolean;
}
export interface BoundaryState {
    entries: SessionBoundaryDraft[];
    continue: boolean;
    context: BoundaryContextPreview;
    outcome: AgentActivityOutcome;
}
export interface BoundaryResult {
    entries?: SessionBoundaryDraft[];
    continue?: boolean;
}
/** Fired before final settlement. May append entries and ensure one next provider request. */
export interface AgentBeforeSettleEvent extends BoundaryState {
    type: "agent_before_settle";
}
/** Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run. */
export interface AgentSettledEvent {
    type: "agent_settled";
    /** Whether the run ended because it was aborted, for example with Escape. */
    aborted: boolean;
}
```

```ts
// types.d.ts:828
export interface TurnEndEvent extends BoundaryState {
    type: "turn_end";
    turnIndex: number;
    message: AgentMessage;
    toolResults: ToolResultMessage[];
    messageEntryId: string;
    toolResultEntryIds: string[];
}
// types.d.ts:752
export type AgentActivityOutcome = "completed" | "aborted" | "error";
// types.d.ts:1085
export type TurnEndEventResult = BoundaryResult;
export type AgentBeforeSettleEventResult = BoundaryResult;
```

### 3.2 (a) When `agent_before_settle` fires — `[RUNTIME]`

`dist/core/agent-session.js:1449-1467`, inside `_startRun`:

```js
await this.agent.prompt(messages);
while (!this._agentRunAbortRequested) {
    if (await this._handlePostAgentRun()) {          // retry / compaction / queued work
        if (this._agentRunAbortRequested) break;
        await this.agent.continue();
        continue;
    }
    if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))
        break;
    if (this._agentRunAbortRequested) break;
    await this.agent.continue();
}
```

`_handlePostAgentRun` (`agent-session.js:1531-1564`) returns true (meaning "keep looping, skip settlement") for: a retryable error whose retry was prepared, a compaction that just ran, or `agent.hasQueuedMessages()`. It returns false for an aborted run.

Therefore the boundary runs:

- only after the low-level agent loop has stopped **and** no retry, compaction retry, or queued message remains;
- **never when `_agentRunAbortRequested` is set** — the `||` short-circuits, so a user interrupt skips the boundary entirely;
- **once per run attempt**: after each `agent.continue()` the `while` re-evaluates, so a chain of continuations produces a chain of boundary dispatches;
- only if a handler is registered: `if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();` (`agent-session.js:1567`).

`[RUNTIME]` `dist/core/agent-session.js:1566-1589` (`_runBeforeSettleBoundary`) also sets `_isBeforeSettle = true` around the dispatch, which is what makes `session.abort()` set `_abortDuringBeforeSettle` (`agent-session.js:1978-1979`).

### 3.3 (b) What makes `continue: true` actually start another model request — `[RUNTIME]`

```js
// dist/core/agent-session.js:1571-1586
const result = await this._extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: this._lastActivityOutcome }, (entries) => this._buildBoundaryContext(entries, "agent_before_settle"));
this._commitBoundaryDrafts(result.entries);
this._flushPendingCustomMessages();
const finalContext = this._buildBoundaryContext([], "agent_before_settle");
if (this._abortDuringBeforeSettle) return false;
const shouldContinue = result.continue || this.agent.hasQueuedMessages();
if (shouldContinue && !finalContext.canContinue) {
    if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
    return false;
}
return shouldContinue;
```

`canContinue` comes from `_buildBoundaryContext` (`agent-session.js:615-633`):

```js
const llmMessages = convertToLlm(projection.messages);
const finalRole = llmMessages[llmMessages.length - 1]?.role;
const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
const pendingCustomContext = this._pendingCustomMessages.length > 0;
return {
    contextEntries: projection.entries,
    contextMessages: projection.messages,
    llmMessages,
    pendingMessages,
    canContinue: contextCanContinue || pendingCustomContext ||
        (boundary === "turn_end"
            ? this.agent.hasQueuedMessages()
            : finalRole === "assistant" && this.agent.hasQueuedMessages()),
};
```

So the rule is exact:

1. `continue: true` is necessary but **not sufficient**.
2. The projected transcript, after applying your drafts, must end in a non-`assistant` **LLM** role (`user` or `toolResult`) and contain at least one non-system message; or a queued agent message must exist.
3. Returning `continue: true` with **no entries** on a normal turn (last LLM message is the assistant response) fails the check: `_reportInvalidBoundaryContinuation` emits an error `"agent_before_settle requested continuation without runnable model context"` (`agent-session.js:641-647`) and the run settles.
4. When the check passes, `_startRun` calls `await this.agent.continue()`. `Agent.continue()` requires the last message role not to be `assistant` and calls `runContinuation()` -> `runAgentLoopContinue` -> `runLoop` (`pi-agent-core/dist/agent.js:254-272`, `agent-loop.js:64-77`), which issues **one model request per turn** exactly like a normal run. No new `user` message is synthesized.

### 3.4 (c) How a `custom_message` draft reaches the model — `[RUNTIME]`

`_commitBoundaryDrafts` -> `_applyBoundaryDrafts` (`agent-session.js:578-607`) calls `manager.appendCustomMessageEntry(...)`, then `_refreshFinalizedContext()` (`agent-session.js:570-576`) rebuilds `agent.state.messages` from `buildSessionProjection()`.

The draft materializes as a `CustomMessage` with `role: "custom"` (`dist/core/messages.d.ts:32-39`), and `convertToLlm` maps that role to a **user** message:

```js
// dist/core/messages.js:75,89-96
export function convertToLlm(messages) {
    ...
            case "custom": {
                const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
                return { role: "user", content, timestamp: m.timestamp };
            }
```

The same conversion runs for persisted replay (`buildSessionContext` -> `CustomMessage` -> `convertToLlm`) and is what `_buildBoundaryContext` uses, so `finalRole` becomes `"user"`. `display: false` only affects TUI rendering (`docs/session-format.md:186`); it is still sent to the model. `[TYPES]` + `[RUNTIME]`.

**A hidden prompt is exactly: a `custom_message` draft with `display: false`.**

### 3.5 (d) Entries without `continue` — `[RUNTIME]`

`_commitBoundaryDrafts(result.entries)` runs **before** the continuation decision (`agent-session.js:1573`). Entries are persisted either way; without `continue` the run simply settles right after. Same for `turn_end` (`agent-session.js:513`).

Consequence: a goal extension can write state/diagnostics at settlement risk-free; only a nonzero `continue` changes control flow.

### 3.6 (e) Can one boundary `continue` twice? — `[RUNTIME]`

No. `emitBoundary` (`dist/core/extensions/runner.js:759-806`) accumulates one boolean:

```js
let shouldContinue = false;
...
if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
```

- Last non-`undefined` value wins across all handlers and extensions.
- One dispatch -> one boolean -> at most one `agent.continue()`.
- `handlerResult.entries` **replaces** the accumulated array (it does not append). To add to what earlier handlers proposed, return `[...event.entries, draft]`.
- The `event` object is rebuilt before each handler with the current `entries`, `continue`, and a freshly built `context` (`runner.js:765-789`), so handler N sees handler N-1's effect.
- Because each continuation produces a new boundary dispatch, an unconditional `continue` loops forever. The guard is the extension's responsibility (`[DOC]` `docs/extensions.md:230`).

### 3.7 (f) Handler errors — `[RUNTIME]`

`emitBoundary` wraps each handler in `try/catch` and calls `emitError({ extensionPath, event, error, stack })` (`runner.js:780-787`). The handler's return value is discarded; the boundary continues with previous state.

Error surfacing per mode:
- `runner.emitError` -> registered `onError` listeners (`runner.js:497-501`).
- TUI: `showExtensionError(...)` (`dist/modes/interactive/interactive-mode.js:1538-1540`).
- print/json: `console.error("Extension error (<path>): <msg>")` (`dist/modes/print-mode.js:72-74`).
- If the accumulated drafts are invalid, `buildContext` throws, `emitBoundary` returns `{ entries: [], continue: false, valid: false }` and emits `"Invalid boundary entries: <message>"` (`runner.js:788-805`). Nothing is committed in that case (`agent-session.js:1573` commits `result.entries`, which is `[]`).

A throwing `agent_before_settle` handler therefore **stops the loop without crashing Pi** — but silently from the model's perspective. Log via `ctx.ui.notify` or `console.error` yourself if the loop must not stall unnoticed.

### 3.8 The exact continuation recipe

```ts
pi.on("agent_before_settle", async (event, ctx) => {
  // stop conditions: aborted, error, goal cleared, budget spent, no progress
  if (event.outcome !== "completed") return;
  if (!goalActive) return;

  return {
    entries: [
      ...event.entries,
      {
        type: "custom_message",
        customType: "goals-continuation",
        content: buildContinuationPrompt(goal), // what the model should see
        display: false,                          // hidden in TUI
      },
    ],
    continue: true,
  };
});
```

Verified ingredients: draft type `custom_message` (`types.d.ts:758`), commit path (`agent-session.js:578-607`), `canContinue` rule (`agent-session.js:615-633`), `continue` consumption (`agent-session.js:1580-1586`), and `agent.continue()` (`agent-session.js:1462`).

**Do not** rely on `sendMessage`/`sendUserMessage` inside this handler (see section 8).

---

## 4. Session state and persistence

### 4.1 `pi.appendEntry` — `[RUNTIME]`

```js
// dist/core/agent-session.js:2783-2790
appendEntry: (customType, data) => {
    const entryId = this.sessionManager.appendCustomEntry(customType, data);
    const entry = this.sessionManager.getEntry(entryId);
    if (entry) this._emit({ type: "entry_appended", entry });
},
```

It writes a `CustomEntry` as a child of the current leaf and moves the leaf. `entry_appended` is an `AgentSession` event (for host UI), **not** an `ExtensionEvent`.

Serialized shape (`docs/session-format.md:164-174`):

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

### 4.2 `CustomEntry` vs `custom_message`

```ts
// dist/core/session-manager.d.ts:56-70
export interface CustomEntry<T = unknown> extends SessionEntryBase {
    type: "custom";
    customType: string;
    data?: T;
}
// dist/core/session-manager.d.ts:88-94
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
    type: "custom_message";
    customType: string;
    content: string | (TextContent | ImageContent)[];
    details?: T;
    display: boolean;
}
```

| | `custom` (`appendEntry`) | `custom_message` (`sendMessage` / boundary draft) |
|---|---|---|
| Enters LLM context | No (`sessionEntryToContextMessages` returns none) | Yes, as a `user` message |
| Serialized key | `data` | `content` + `display` (+ `details`) |
| Intended use | durable extension state | injected context / prompts |
| TUI | only if `registerEntryRenderer(customType, ...)` | rendered when `display: true`, via `registerMessageRenderer` for custom styling |

`[RUNTIME]` `dist/core/session-manager.js` (`sessionEntryToContextMessages`) + `[DOC]` `docs/session-format.md:176-188`.

### 4.3 Read APIs (exact)

`ExtensionContext.sessionManager` is `ReadonlySessionManager` (`types.d.ts:223`), defined as:

```ts
// dist/core/session-manager.d.ts:161-180
export type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "buildContextEntries" | "buildSessionProjection" | "getHeader" | "getEntries" | "getTree" | "getSessionName">;
```

Relevant return types (`session-manager.d.ts:269,273,286,311,316,321,322,334,340`):

```ts
appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry;   // not on Readonly
appendCustomEntry(customType: string, data?: unknown): string;                                          // not on Readonly
appendCustomMessageEntry<T = unknown>(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: T): string; // not on Readonly
getBranch(fromId?: string): SessionEntry[];
buildContextEntries(): SessionEntry[];
buildSessionProjection(): SessionProjection;   // { entries: ProjectedSessionEntry[]; messages: AgentMessage[]; thinkingLevel; model }
buildSessionContext(): SessionContext;         // { messages: AgentMessage[]; thinkingLevel; model }
getEntries(): SessionEntry[];
getTree(): SessionTreeNode[];
getEntry(id: string): SessionEntry | undefined;
getLeafId(): string | null;
```

`getBranch()` is a plain leaf-to-root walk with **no compaction filtering**:

```js
// dist/core/session-manager.js:1062-1072
getBranch(fromId) {
    const path = [];
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) { path.push(current); current = current.parentId ? this.byId.get(current.parentId) : undefined; }
    path.reverse();
    return path;
}
```

`buildContextEntries()` applies the latest compaction and drops summarized entries (`session-manager.js:201-229`). **State reconstruction must use `getBranch()`; context reconstruction uses `buildContextEntries()`/`buildSessionProjection()`.**

### 4.4 How branch / fork / tree / resume / compaction affect reconstruction

| Operation | Runtime effect `[RUNTIME]` | What an extension must do |
|---|---|---|
| branch (`navigateTree`) | same session file, leaf moves; `session_before_tree` (cancellable) then `session_tree` (`agent-session.js:3302-3410`); no `session_start` | rebuild state from `getBranch()` on `session_tree` |
| fork (`/fork`, `/clone`, `ctx.fork`) | new session file via `createBranchedSession`, then `teardownCurrent("fork")` and a **new runtime** with `session_start.reason = "fork"` (`agent-session-runtime.js:194-247`) | rebuild on `session_start`; in-memory state is gone |
| new / resume | new runtime, `session_start.reason = "new" \| "resume"` with `previousSessionFile` (`agent-session-runtime.js:141,165`) | rebuild on `session_start` |
| reload (`ctx.reload`, `/reload`) | `session_shutdown{reason:"reload"}` then a fresh runner; `session_start{reason:"reload"}` (`agent-session.js:3001`, `:3028`) | rebuild on `session_start`; never reuse old objects |
| quit | `session_shutdown{reason:"quit"}` (`agent-session-runtime.js:296-302`) | flush anything pending, idempotently |
| compaction | appends a `compaction` entry with `firstKeptEntryId`; earlier entries vanish from **context** but stay on the **branch** (`session-manager.js:201-229`) | state survives; previously injected `custom_message` prompts may be summarized away, so re-inject at each continuation |

`[DOC]` `docs/extensions.md:344-350` says the same: "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`. Do not rebuild it from every file entry because abandoned branches represent alternative histories."

Local idiom: `extensions/subagents/src/persistence/session-state.ts:52-78` scans the branch **backwards** for the newest entry with `type === "custom" && customType === 'subagents-v3-state'`, validating each candidate and skipping corrupt ones. `$PKG/examples/extensions/todo.ts:118-133` rebuilds from tool-result `details` on both `session_start` and `session_tree`.

### 4.5 Correct rebuild pattern for `goals`

```ts
function latestSnapshot(branch: readonly SessionEntry[]): GoalSnapshot | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "custom" && e.customType === "goals-state") {
      const parsed = parseSnapshot(e.data);   // validate, never trust JSON
      if (parsed) return parsed;              // skip corrupt -> fall back to older
    }
  }
  return undefined;
}
pi.on("session_start", (_e, ctx) => { state = latestSnapshot(ctx.sessionManager.getBranch()) ?? empty(); });
pi.on("session_tree",  (_e, ctx) => { state = latestSnapshot(ctx.sessionManager.getBranch()) ?? empty(); });
```

Two invariants worth writing into the design:

1. **Latest valid entry wins**, not "latest entry". A half-written or schema-drifted snapshot must not brick the loop.
2. **Snapshot, not journal.** `appendEntry` is append-only with no delete/compact API for custom entries; a growing event log is never pruned. Write full bounded snapshots and accept the redundancy. `[TYPES]`: `SessionManager` has no remove/update API (`session-manager.d.ts`), only `append*`, `branch`, `resetLeaf`.

---

## 5. Usage and accounting

### 5.1 `Usage` (verbatim)

```ts
// node_modules/@earendil-works/pi-ai/dist/types.d.ts:285-305
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
    cacheWrite1h?: number;
    /**
     * Reasoning/thinking tokens, when the provider reports them. This is a subset of
     * `output` ...
     */
    reasoning?: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
```

Cache read and write **are separate fields**, and each has its own cost bucket. `cost.total` is the provider-reported total when the provider reports one.

`AssistantMessage.usage: Usage` (`pi-ai/dist/types.d.ts:381`), plus `stopReason`, `errorMessage?`, `provider`, `model`, `responseModel?`, `timestamp`, `durationMs?` (`:368-398`).

### 5.2 Where per-request usage lives

- `ctx.sessionManager.getBranch()` -> entries with `type === "message" && message.role === "assistant"` -> `entry.message.usage`.
- Tool results may carry `usage` from nested model calls (`ToolResultMessage.usage`); nested calls are aggregated onto the calling tool's result.
- Standalone `usage` entries: `{"type":"usage","kind":"cache_warm","provider":...,"model":...,"usage":{...}}` (`docs/session-format.md:112-122`), written by `SessionManager.appendUsage`.
- `compaction` and `branch_summary` entries carry summary-generation `usage`.
- `ctx.getContextUsage()` -> `ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }` (`types.d.ts:197-205`). This is **context occupancy**, not billing; `tokens` is `null` right after compaction.
- Exported helpers from the package root (`dist/index.d.ts`): `getLastAssistantUsage(entries): Usage | undefined`, `calculateContextTokens(usage): number`, `estimateTokens(message): number`.
  `[RUNTIME]` `dist/core/compaction/compaction.js:65-67,87-97`: `calculateContextTokens` = `usage.totalTokens || input+output+cacheRead+cacheWrite`; `getAssistantUsage` **skips** messages whose `stopReason` is `"aborted"` or `"error"` or whose usage is all-zero.

### 5.3 `extensions/shared/usage.ts` math (summarized)

`[RUNTIME]` local file, `extensions/shared/usage.ts`.

- `calculateUsageCost(usage, pricing)`: picks a pricing tier by `inputTokens = input + cacheRead + cacheWrite` (`> tier.inputTokensAbove`, highest match wins), splits `cacheWrite1h` (clamped to `cacheWrite`) from short cache writes, then

  ```
  cost = (input*rate.input + output*rate.output + cacheRead*rate.cacheRead
          + cacheWriteShort*rate.cacheWrite + cacheWrite1h*rate.input*2) / 1_000_000
  ```

  The `2x` factor is Anthropic's 1h-retention surcharge.
- `classifyUsageCost`: if `usage.cost.total > 0` that value is authoritative (`source: "reported"`); else catalog pricing (`"catalog"`), else estimate for `*-free` models via a paid reference (`"estimated"`, tracked separately, `actual` stays 0), else `"unknown"` with `unknownTokens`.
- `parseSessionUsage`: counts each usage-bearing entry exactly once (assistant messages, tool-result usage, `usage` entries, `compaction`/`branch_summary` usage). Model key is `provider/responseModel ?? model`.
- `finalizeTotalTokens`: canonical total = `input + output + cacheRead + cacheWrite`; the provider `totalTokens` is kept only as `reportedTotalTokens` plus a mismatch delta.
- `ownedSessionEntries`: slices entries after a `custom` marker (`SUBAGENT_OWN_USAGE_MARKER`) so a forked prefix is not double-billed. Useful pattern if the goal extension ever forks.

Divergence to be aware of: `parseSessionUsage` counts numeric usage on aborted/error assistant messages, while `getLastAssistantUsage` skips them. For a hard budget, prefer summing explicit assistant-message usage for entries whose `stopReason` is not `aborted`/`error`, and dedupe by entry id per continuation.

---

## 6. Lifecycle events: payload, mutability, usefulness

`[RUNTIME]` All events are dispatched by `ExtensionRunner.emit` (`dist/core/extensions/runner.js:813-839`) unless a dedicated emitter exists. `emit` **ignores** handler return values except for the four `session_before_*` events, where `cancel` short-circuits (`runner.js:820-825`). Dedicated emitters exist for: `tool_call`, `tool_result`, `user_bash`, `context`, `context_with_system`, `message_end`, `before_agent_start`, `input`, `before_provider_request`, `before_provider_headers`, `resources_discover`, `cache_warming_decision`, and the boundary events (`runner.d.ts:24-31`).

| Event | Payload (declaration) | Mutates / cancels | Notes for a goal loop |
|---|---|---|---|
| `message_end` | `{ type, message: AgentMessage }` (`types.d.ts:848`) | **Yes**: return `{ message }`, must keep the same role; handlers chain (`runner.js` `emitMessageEnd`); wrong role -> extension error, change ignored | observe assistant text/usage; avoid rewriting provider messages |
| `tool_execution_end` | `{ toolCallId, toolName, result: any, isError: boolean, durationMs?, parentToolCallId? }` (`types.d.ts:872-881`) | No (generic emit, return ignored) | tool accounting / progress signal, no session write |
| `turn_end` | `TurnEndEvent extends BoundaryState` (`types.d.ts:828-835`) | **Yes**: `BoundaryResult` (entries + continue) -> `{action:"continue"}` in the *same* low-level run (`agent-session.js:521-531`) | cheap place to append per-turn state; continuation happens inside one agent run |
| `agent_end` | `{ type, messages: AgentMessage[] }` (`types.d.ts:748`) | No | fires per low-level run, **not** a final-idle signal (`[DOC]` `docs/extensions.md:145`) |
| `agent_settled` | `{ type, aborted: boolean }` (`types.d.ts:801-806`) | No | true final idle; `sendMessage`/`prompt` here is deferred until after the event (`agent-session.js:1631-1634`, `1866-1869`) |
| `session_start` | `{ type, reason: "startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile? }` (`types.d.ts:575-582`) | No | rebuild state from `getBranch()` here |
| `session_shutdown` | `{ type, reason: "quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile? }` (`types.d.ts:637-644`) | No | idempotent cleanup only |
| `session_before_switch` | `{ reason: "new"\|"resume", targetSessionFile? }` (`types.d.ts:589-593`) | **Yes**: `{ cancel?: boolean }` | could refuse to leave with an active goal |
| `session_before_fork` | `{ entryId, position }` (`types.d.ts:595-599`) | **Yes**: `{ cancel?, skipConversationRestore? }` | |
| `session_before_tree` | `{ preparation: TreePreparation, signal }` (`types.d.ts:658-662`) | **Yes**: `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }` | |
| `session_before_compact` | `{ preparation, branchEntries, customInstructions?, reason, willRetry, signal }` (`types.d.ts:601-612`) | **Yes**: `{ cancel?, compaction? }` | can replace compaction output; used by `examples/extensions/custom-compaction.ts` |
| `session_compact` | `{ compactionEntry, fromExtension, reason, willRetry }` (`types.d.ts:613-622`) | No | re-inject the goal prompt after compaction |
| `session_tree` | `{ newLeafId, oldLeafId, summaryEntry?, fromExtension? }` (`types.d.ts:664-670`) | No | rebuild state (branch changed) |
| `input` | `{ text, images?, source: "interactive"\|"rpc"\|"extension", streamingBehavior? }` (`types.d.ts:910-920`) | **Yes**: `{action:"continue"} \| {action:"transform",text,images?} \| {action:"handled"}` (`types.d.ts:922-930`) | can swallow or rewrite user input; transforms chain, `handled` short-circuits (`[DOC]` `docs/extensions.md:208-210`) |
| `context` | `{ messages }` without system messages (`types.d.ts:679-683`) | **Yes**: return `{ messages }`; Pi restores prompt/tool state (`runner.js` `emitContext`) | request-scoped injection; not persisted |
| `context_with_system` | `{ messages }` full transcript (`types.d.ts:688-691`) | **Yes**, output used as returned; leading system message must stay at index 0 or an error is reported | only way to alter the system prompt for one request |

---

## 7. Commands and UI

### 7.1 Argument parsing — `[RUNTIME]`

```js
// dist/core/agent-session.js:1698-1706
const spaceIndex = text.indexOf(" ");
const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
```

- Splits on the **first** space only. `args` is the raw remainder: no trimming, no shell-like splitting, quotes are not special.
- `[EMPIRICAL]` `pi ... -p "/piextcheck  alpha beta "` produced `args=" alpha beta "`.
- No args -> `args === ""`.
- Command dispatch happens **before** model validation and works in print/json modes (`agent-session.js:1641-1647`); confirmed by the same probe (`mode=print hasUI=false`).
- Handler exceptions are caught and reported as extension errors with `extensionPath: "command:<name>"` (`agent-session.js:1716-1725`); the command is still considered handled.
- `getArgumentCompletions(argumentPrefix)` is optional (`types.d.ts:1175`).

### 7.2 UI surface (`ExtensionUIContext`, `types.d.ts:72-199`)

Relevant subset:

```ts
select(title, options: string[], opts?): Promise<string | undefined>;      // :74
confirm(title, message, opts?): Promise<boolean>;                         // :76
input(title, placeholder?, opts?): Promise<string | undefined>;           // :78
notify(message, type?: "info"|"warning"|"error"): void;                    // :80
setStatus(key: string, text: string | undefined): void;                    // :84
setWorkingMessage(message?: string): void;                                 // :86
setWidget(key, content: string[] | undefined, options?: { placement?: "aboveEditor"|"belowEditor" }): void;  // :101
setWidget(key, content: ((tui, theme) => Component & { dispose?(): void }) | undefined, options?): void;      // :102
setFooter(factory | undefined): void;                                      // :111
setHeader(factory | undefined): void;                                      // :115
setTitle(title: string): void;                                             // :119
custom<T>(factory, options?: { overlay?; overlayOptions?; onHandle? }): Promise<T>;  // :121
readonly theme: Theme;                                                     // :179
```

`ctx.mode: "tui" | "rpc" | "json" | "print"` and `ctx.hasUI` (`types.d.ts:213-218`). `[RUNTIME]` `runner.js:355-406`: with no UI context bound (print/json) the runner installs `noOpUIContext`, whose dialogs resolve to `undefined`/`false` and whose setters are no-ops; `hasUI()` is `uiContext !== noOpUIContext`. RPC binds a UI context that forwards supported dialogs (`docs/extensions.md:362-366`). Guard terminal-only components with `ctx.mode === "tui"`.

`[RUNTIME]` `ctx.ui.notify` / `setStatus` never throw in print mode; they silently do nothing. Any loop status output must have a non-UI fallback (returned prompt text, session entry, `console.error`). Local precedent: `extensions/subagents/index.ts:42-62` (`reportDiagnostic`) uses `ctx.hasUI ? notify : console.error`.

### 7.3 Command handlers vs event handlers

| | `ExtensionCommandContext` | `ExtensionContext` |
|---|---|---|
| Type | `types.d.ts:286` | `types.d.ts:213` |
| `waitForIdle`, `reload`, `newSession`, `fork`, `navigateTree`, `switchSession`, `getSystemPromptOptions` | yes | **no** |
| Intended caller | user-initiated commands | lifecycle events and tools |
| Danger | must not be used from event handlers (`[DOC]` `docs/extensions.md:328-330`: "calling them from lifecycle handlers can deadlock the runtime") | |

`navigateTree` additionally throws while streaming or compacting (`agent-session.js:3261-3266`), so a command must `await ctx.waitForIdle()` first.

---

## 8. `sendMessage` / `sendUserMessage` and the run loop

### 8.1 Signatures and options

```ts
// types.d.ts:1258 (ExtensionAPI)
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
}): void;
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
}): void;
```

### 8.2 `sendMessage` runtime behavior — `[RUNTIME]` `agent-session.js:1844-1881`

Decision order (exactly as coded):

1. `deliverAs === "nextTurn"` -> push to `_pendingNextTurnMessages`. Consumed only by `_prepareRun` at the next `_startRun` (`agent-session.js:1512-1513`). **No continuation.**
2. `isStreaming && triggerTurn !== false` -> `agent.steer(msg)` or `agent.followUp(msg)` (per `deliverAs`, default `steer`). It is queued into the live loop; the model sees it on the next turn.
3. `!isStreaming && triggerTurn` -> `_startRun({ messageType: "custom", ... })`: a **new run**, `before_agent_start` fires with `messageType: "custom"`. If `_isEmittingAgentSettled`, the call is deferred until after the settled event.
4. `isStreaming && triggerTurn === false` -> push to `_pendingCustomMessages`; flushed at the end of the turn/run (`agent-session.js:1893-1901`). No new request.
5. `!isStreaming && !triggerTurn` -> append immediately (`_appendCustomMessage`), no turn.

`isStreaming` is `_isAgentRunActive` (`agent-session.js:1068-1070`), which is **true during `agent_before_settle`**.

### 8.3 `sendUserMessage` runtime behavior — `[RUNTIME]` `agent-session.js:1910-1937`

Delegates to `prompt(text, { expandPromptTemplates: options?.expandPromptTemplates ?? false, streamingBehavior: options?.deliverAs, images, source: "extension" })`.

- `expandPromptTemplates` defaults to **false** here (unlike `prompt()`, which defaults to true).
- While streaming, `prompt` **throws** unless `deliverAs` is set: `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."` (`agent-session.js:1664-1675`).
- Not streaming: validates model + auth, then starts a real run with a real `user` message.
- Errors from the fire-and-forget `pi.sendUserMessage` are converted to extension errors by the runtime (`agent-session.js:2774-2782`), so a missing `deliverAs` inside a handler shows up as an extension error, not an exception at your call site.

### 8.4 What to use inside `agent_before_settle`

Because `isStreaming === true` during the boundary:

| Call | Actual effect at the boundary | Verdict |
|---|---|---|
| return `{ entries: [custom_message], continue: true }` | commits entry, then `agent.continue()` | **use this** |
| `pi.appendEntry(...)` | writes a `custom` entry immediately (child of current leaf) | OK for state, but ordering vs. returned drafts is not defined; prefer returning the draft |
| `pi.sendMessage(msg)` (defaults) | `agent.steer(...)` -> queued; makes `canContinue` true via `hasQueuedMessages()` even without `continue` | avoid: implicit continuation, ordering depends on queue state |
| `pi.sendMessage(msg, { deliverAs: "followUp" })` | `agent.followUp(...)` -> queued for after the current run | avoid at the boundary; use for "after this task" semantics from elsewhere |
| `pi.sendMessage(msg, { deliverAs: "nextTurn" })` | parked in `_pendingNextTurnMessages`; consumed at the next run's `_prepareRun` | safe but does not continue |
| `pi.sendMessage(msg, { triggerTurn: true })` | `isStreaming` is true, so it takes the **queue** branch, not `_startRun` | does not start a new run here |
| `pi.sendMessage(msg, { triggerTurn: false })` | parked in `_pendingCustomMessages`, flushed just after commit | no continuation |
| `pi.sendUserMessage(text)` | `prompt` throws (no `deliverAs`) -> extension error | **never** |
| `pi.sendUserMessage(text, { deliverAs: "steer" })` | queued user message; `canContinue` true via queue | avoid; mutates the transcript with a user role |
| `ctx.compact()` | starts async compaction, not awaited | avoid mid-boundary |

### 8.5 Alternative continuation recipe: `agent_settled` + deferred prompt

`[RUNTIME]` `agent-session.js:1631-1634` (`prompt`) and `:1866-1869` (`sendCustomMessage`): while `_isEmittingAgentSettled`, both defer themselves into `_deferredSettledActions`, which `_emitAgentSettled` runs immediately after all `agent_settled` handlers (`agent-session.js:695-710`).

```ts
pi.on("agent_settled", async () => {
  if (goalActive && shouldContinue) pi.sendMessage(goalPrompt, { triggerTurn: true });
});
```

Tradeoffs vs. the boundary recipe:

- Each iteration is a **separate run**: `_prepareRun` runs, `before_agent_start` fires with `messageType: "custom"`, `agent_start`/`agent_end` fire again, and `agent_settled` fires again.
- No `entries`/`continue` protocol, no `canContinue` check.
- The run starts after `agent_settled` handlers, so a second `agent_settled` handler observing the same event cannot see the continuation coming.
- `aborted` is available and is the natural place to stop a goal after an interrupt.

Both recipes need the same loop guard. The boundary recipe is preferable for `goals` because it keeps one continuous run, gives a validated context preview (`event.context.canContinue`, `event.context.llmMessages`), and lets state and prompt be committed atomically.

---

## 9. Interrupt and abort semantics

`[RUNTIME]`

1. Escape while streaming: `defaultEditor.onEscape` -> `restoreQueuedMessagesToEditor({ abort: true })` (`dist/modes/interactive/interactive-mode.js:2377-2380`). That drains steering+follow-up queues back into the editor and then calls `session.abort()` (`:3848-3868`).
2. `AgentSession.abort()` (`agent-session.js:1971-1983`):
   ```js
   if (this._isAgentRunActive) this._agentRunAbortRequested = true;
   this.abortRetry(); this.abortCompaction(); this.abortBranchSummary();
   if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
   this.agent.abort();
   await this.waitForIdle();
   ```
3. `ctx.abort()` maps to the same thing, with a mode hook: interactive binds `abortHandler: () => restoreQueuedMessagesToEditor({ abort: true })` (`interactive-mode.js:1479-1481`); otherwise `void this.abort()` (`agent-session.js:2819-2825`).
4. Mid-border settle abort: `_abortDuringBeforeSettle` makes `_runBeforeSettleBoundary` return `false` before evaluating `continue` (`agent-session.js:1576-1577`).
5. After the run: `_startRun` exits the loop, skips the boundary (short-circuit), and `finally` -> `_emitAgentSettled()` with `aborted = this._agentRunAbortRequested` (`agent-session.js:683-688`).
6. `agent_settled` therefore fires **once** after an interrupt with `aborted: true`, and `agent_before_settle` never fires for that run.

**Distinguishing a user interrupt from a failure**

| Signal | Meaning |
|---|---|
| `agent_settled.aborted` | an abort was *requested* for this run (`Escape`, `ctx.abort()`, `session.abort()`), regardless of who requested it |
| `turn_end.outcome` / `agent_before_settle.outcome` | derived from the last assistant message: `stopReason === "aborted"` -> `"aborted"`; `"error"` -> `"error"`; else `"completed"` (`agent-session.js:487-489`) |
| assistant `message.stopReason === "error"` + `message.errorMessage` | provider/runtime failure; `aborted` is false and `agent_before_settle` still fires with `outcome: "error"` |
| `message.stopReason === "length"` | output token limit hit; `outcome` is `"completed"` |

Caveats:

- `aborted: true` does not prove a human pressed Escape: an extension calling `ctx.abort()` produces the same signal. If that distinction matters, set a flag in the extension's own interrupt command and clear it on the next `session_start`/user `input`.
- On aborted/error responses the low-level loop calls `finishTurn` but **discards its decision** (`pi-agent-core/dist/agent-loop.js:148-157`), so a `turn_end` handler cannot rescue an aborted or errored turn. Only `agent_before_settle` (which is skipped on abort) or a fresh run can.
- Escape also clears queued messages into the editor. Any continuation that relied on `hasQueuedMessages()` disappears.

---

## 10. What an extension cannot do

`[RUNTIME]`-backed unless marked.

1. **Cannot issue a model request mid-run.** There is no API that calls the provider during streaming. `sendMessage`/`sendUserMessage` only queue while `isStreaming`. Requests happen at turn starts and after `agent.continue()` at a boundary (`agent-session.js:1450-1463`).
2. **Cannot cancel one provider call.** `ctx.abort()` aborts the whole run and all compaction/branch-summary/retry controllers (`agent-session.js:1971-1983`).
3. **Cannot choose a model per request** except by `registerVirtualModel({ route })` (routing) or `pi.setModel` / `setThinkingLevel` (session-level mutations that persist as `model_change` / `thinking_level_change` entries). `[TYPES]` `types.d.ts:1402`, `:1296-1306`.
4. **Cannot persist a system message in the transcript.** `appendEntry` writes `custom` (not in context); `sendMessage` writes `custom_message` (becomes `user`). `context_with_system` can own the system prompt **for one request only**, and Pi reports an error if the leading system message is dropped (`runner.js` `emitContext`). `[RUNTIME]` + `[TYPES]`.
5. **Cannot append a raw `user` message entry.** `SessionManager.appendMessage` exists but is not on `ReadonlySessionManager` (`session-manager.d.ts:161-180`); `sendUserMessage` goes through `prompt()` and therefore needs idle or `deliverAs`.
6. **Cannot modify or delete session entries.** Append-only: only `append*`, `branch`, `resetLeaf` (`session-manager.d.ts`). Only *future model context* can be changed, via a `context_edit` entry or a transient `context` handler.
7. **Cannot unregister tools or commands.** Tools are withdrawn with `exposure: "hidden"` (`docs/extensions.md:273`); `ExtensionAPI` has no unregister for commands, tools, renderers, or handlers other than the unsubscribe closure returned by `on()`.
8. **Cannot store state outside the session with any Pi API.** There is no storage API on `ExtensionAPI`. `pi.exec` and Node `fs` are available (the extension runs in-process with full permissions, `docs/extensions.md:5`), but nothing manages that storage across forks/resumes.
9. **Cannot call command-only session controls from event handlers.** `waitForIdle`, `reload`, `newSession`, `fork`, `navigateTree`, `switchSession` exist only on `ExtensionCommandContext` (`types.d.ts:286-327`), and `docs/extensions.md:328-330` warns they deadlock elsewhere.
10. **Cannot rely on state surviving session replacement.** Factory, handlers, and module globals are discarded on `/new`, `/resume`, `/fork`, and reload (`agent-session-runtime.js:100-190`, `agent-session.js:2990-3030`). Stale API calls throw.
11. **Cannot observe raw HTTP payloads.** `provider_stream_event` receives parsed provider events, is notification-only, and must be treated read-only (`types.d.ts:713-719`, `docs/extensions.md:217-224`).
12. **Cannot veto settlement.** There is no "cancel run" result. `agent_before_settle` can only add entries and request one more continuation; `agent_settled` is notification-only.
13. **Cannot start a nested run from inside `agent_before_settle`.** `sendMessage(..., { triggerTurn: true })` takes the queue branch because `isStreaming` is true (`agent-session.js:1861-1876`).
14. **Cannot prevent `turn_end` boundary entries from being committed** even when `continue` is not honoured. State writes are independent of control flow.
15. **Cannot assume `agent_end` means idle.** Retries, compaction, and queued messages can start another run (`docs/extensions.md:145`; `agent-session.js:1531-1564`).

---

## 11. Assembly notes for `goals`

- **Persistence:** `pi.appendEntry("goals-state", snapshot)` with a validated, versioned snapshot; read the newest valid one from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`.
- **Continuation:** `agent_before_settle` -> return `{ entries: [...event.entries, { type: "custom_message", customType: "goals-continuation", content, display: false }], continue: true }`; guard on `event.outcome === "completed"`, on goal status, budget, and a no-progress counter.
- **Prompt visibility:** `display: false` keeps it out of the TUI but still sends it as a `user` message; persist the same text in the snapshot if it must be auditable after compaction.
- **Usage:** sum `entry.message.usage` for `assistant` entries that are not `aborted`/`error`, plus tool-result and `usage` entries; treat `input/output/cacheRead/cacheWrite` as canonical and `totalTokens`/`cost.total` as reported metadata; `ctx.getContextUsage()` is occupancy, not spend.
- **Interrupts:** stop on `agent_settled.aborted === true`; do not try to continue from `agent_before_settle` after an abort (it is skipped by design).
- **Errors:** a throwing boundary handler silently stalls the loop. Wrap the decision logic, emit diagnostics explicitly, and never let an exception be the only stop signal.

## 12. Open / unverified

- Not exercised end-to-end: an actual continuation with a live model. The recipe is assembled from `_startRun`, `_runBeforeSettleBoundary`, `_buildBoundaryContext`, `_commitBoundaryDrafts`, `Agent.continue`, and `runAgentLoopContinue`, all read directly. A cheap future check is a scratch extension that returns `continue: true` once and logs the second `turn_start`.
- `AgentSession.getSessionStats()` (`agent-session.d.ts:892`) is not reachable from `ExtensionContext`; the goal extension must aggregate usage itself.
- The npm registry check was run once during this research; no version newer than 1.4.0 existed then.
- Local `extensions/todowrite` and `extensions/background-terminals` were inspected for style only; `todowrite` is not present in this checkout (`ls` shows no such directory), so the referenced `todo.ts` example under `$PKG/examples/extensions/` was used as the state-reconstruction reference instead.
