/**
 * Fake Pi host for adapter integration tests.
 *
 * The adapters are registered through `src/index.ts` against this double, so the
 * tests exercise the real command/tool/event wiring instead of calling the
 * engine directly. The double implements the whole `ExtensionAPI` surface the
 * extension factory expects; unimplemented members are documented stubs that no
 * goal adapter reaches.
 *
 * `appendEntry` writes through to the same `FakeSession` the handlers read, the
 * way `pi.appendEntry` writes to the live session manager. Without that, the
 * engine could never load the snapshot it just persisted.
 */
import { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import type {
    AgentToolResult,
    BuildSystemPromptOptions,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionToolContext,
    ExtensionUIContext,
    ExtensionWidgetOptions,
    RegisteredCommand,
    SessionHeader,
    SessionProjection,
    SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import goalsExtension from "../../src/index.ts";
import { GOAL_SNAPSHOT_CUSTOM_TYPE } from "../../src/domain/goal.ts";
import {
    FAKE_EPOCH_MS,
    FakeSession,
    type FakeCustomMessageEntry,
} from "./fake-session.ts";

/** Default working directory reported by the fake context. */
const FAKE_CWD = "/fake/workspace";

/** Any function shape, used to store handlers registered through `on`. */
type AnyHandler = (...args: never[]) => unknown;

/**
 * Minimal structural view of a registered tool. Only the members the tests
 * inspect or call are modelled; `execute` keeps the real argument shape so a
 * test can invoke a tool the way Pi would.
 */
export interface ToolDefinitionLike {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: TSchema;
    readonly outputSchema?: TSchema;
    execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>>;
}

export type CommandDefinitionLike = Omit<RegisteredCommand, "name" | "sourceInfo">;

export interface NotificationRecord {
    readonly message: string;
    readonly type: "info" | "warning" | "error" | undefined;
}

export interface StatusRecord {
    readonly key: string;
    readonly text: string | undefined;
}

export interface WidgetRecord {
    readonly key: string;
    readonly content: unknown;
    readonly placement: string | undefined;
}

/** Recording, configurable `ExtensionUIContext` double. */
export interface RecordingUI extends ExtensionUIContext {
    readonly notifications: NotificationRecord[];
    readonly statuses: StatusRecord[];
    readonly widgets: WidgetRecord[];
    setConfirmAnswer(answer: boolean): void;
    setEditorAnswer(answer: string | undefined): void;
}

export interface RecordingUIOptions {
    readonly confirm?: boolean;
    readonly editor?: string | undefined;
    readonly select?: string | undefined;
    readonly input?: string | undefined;
}

export function createRecordingUI(options: RecordingUIOptions = {}): RecordingUI {
    const notifications: NotificationRecord[] = [];
    const statuses: StatusRecord[] = [];
    const widgets: WidgetRecord[] = [];
    let confirmAnswer = options.confirm ?? true;
    let editorAnswer = options.editor;

    return {
        notifications,
        statuses,
        widgets,
        notify(message, type) {
            notifications.push({ message, type });
        },
        setStatus(key, text) {
            statuses.push({ key, text });
        },
        setWidget(key, content, widgetOptions) {
            widgets.push({ key, content, placement: widgetOptions?.placement });
        },
        confirm: async () => confirmAnswer,
        select: async () => options.select,
        input: async () => options.input,
        editor: async () => editorAnswer,
        custom: <T>() => new Promise<T>(() => {}),
        onTerminalInput: () => () => {},
        // No adapter reads the theme; the prototype keeps the nominal type.
        theme: Object.create(Theme.prototype),
        setWorkingMessage() {},
        setWorkingVisible() {},
        setWorkingIndicator() {},
        setHiddenThinkingLabel() {},
        setFooter() {},
        setHeader() {},
        setTitle() {},
        pasteToEditor() {},
        setEditorText() {},
        getEditorText: () => "",
        addAutocompleteProvider() {},
        setEditorComponent() {},
        getEditorComponent: () => undefined,
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false, error: "fake ui has no themes" }),
        getToolsExpanded: () => false,
        setToolsExpanded() {},
        setConfirmAnswer(value) {
            confirmAnswer = value;
        },
        setEditorAnswer(value) {
            editorAnswer = value;
        },
    };
}

/** Structural view of the session-manager members the adapters could call. */
export interface FakeSessionManager {
    getCwd(): string;
    getSessionDir(): string;
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
    getLeafEntry(): ReturnType<FakeSession["getBranch"]>[number] | undefined;
    getEntry(id: string): ReturnType<FakeSession["getBranch"]>[number] | undefined;
    getLabel(id: string): string | undefined;
    getBranch(): ReturnType<FakeSession["getBranch"]>;
    buildContextEntries(): ReturnType<FakeSession["buildContextEntries"]>;
    buildSessionProjection(): SessionProjection;
    getHeader(): SessionHeader | null;
    getEntries(): ReturnType<FakeSession["getEntries"]>;
    getTree(): SessionTreeNode[];
    getSessionName(): string | undefined;
}

export function makeFakeSessionManager(session: FakeSession): FakeSessionManager {
    return {
        getCwd: () => FAKE_CWD,
        getSessionDir: () => `${FAKE_CWD}/sessions`,
        getSessionId: () => session.sessionId,
        getSessionFile: () => undefined,
        getLeafId: () => session.leafId,
        getLeafEntry: () => session.getBranch().at(-1),
        getEntry: (id) => session.getEntry(id),
        getLabel: () => undefined,
        getBranch: () => session.getBranch(),
        buildContextEntries: () => session.buildContextEntries(),
        buildSessionProjection: () => ({
            entries: [],
            messages: [],
            thinkingLevel: "off",
            model: null,
        }),
        getHeader: () => ({
            type: "session",
            id: session.sessionId,
            timestamp: new Date(FAKE_EPOCH_MS).toISOString(),
            cwd: FAKE_CWD,
        }),
        getEntries: () => session.getEntries(),
        getTree: () => [],
        getSessionName: () => undefined,
    };
}

export type ExtensionMode = ExtensionContext["mode"];

export interface FakeContextOptions {
    readonly idle?: boolean;
    readonly hasUI?: boolean;
    readonly mode?: ExtensionMode;
    readonly confirm?: boolean;
    readonly editor?: string | undefined;
    readonly cwd?: string;
}

/** Context double plus the knobs tests flip between assertions. */
export interface FakeContext extends ExtensionCommandContext, ExtensionToolContext {
    readonly ui: RecordingUI;
    readonly session: FakeSession;
    setIdle(idle: boolean): void;
    setConfirmAnswer(answer: boolean): void;
    setEditorAnswer(answer: string | undefined): void;
}

export function makeFakeContext(
    session: FakeSession,
    options: FakeContextOptions = {},
): FakeContext {
    const ui = createRecordingUI({
        confirm: options.confirm,
        editor: options.editor,
    });
    const cwd = options.cwd ?? FAKE_CWD;
    let idle = options.idle ?? true;
    const sessionManager = makeFakeSessionManager(session);

    return {
        ui,
        mode: options.mode ?? "tui",
        hasUI: options.hasUI ?? true,
        cwd,
        session,
        // The only cast in this file: FakeSession entries are the structural
        // subset the engine reads, while `ReadonlySessionManager` promises the
        // full Pi SessionEntry/AgentMessage union. Re-modelling those message
        // types here would duplicate Pi's session format, so the double is cast
        // once at the context boundary.
        sessionManager: sessionManager as unknown as ExtensionContext["sessionManager"],
        modelRegistry: Object.create(ModelRegistry.prototype),
        model: undefined,
        scopedModels: [],
        isIdle: () => idle,
        isProjectTrusted: () => false,
        signal: undefined,
        abort() {},
        hasPendingMessages: () => false,
        shutdown() {},
        getContextUsage: () => undefined,
        compact() {},
        getSystemPrompt: () => "",
        getSystemPromptOptions: (): BuildSystemPromptOptions => ({ cwd }),
        waitForIdle: async () => {},
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {},
        tools: [],
        executeTool: async () => {
            throw new Error("fake context: executeTool is not implemented");
        },
        setIdle(value) {
            idle = value;
        },
        setConfirmAnswer(value) {
            ui.setConfirmAnswer(value);
        },
        setEditorAnswer(value) {
            ui.setEditorAnswer(value);
        },
    };
}

export interface AppendedEntry {
    readonly customType: string;
    readonly data: unknown;
}

export interface SentMessage {
    readonly message: unknown;
    readonly options: unknown;
}

export interface FakeHost {
    readonly api: ExtensionAPI;
    readonly handlers: ReadonlyMap<string, readonly AnyHandler[]>;
    readonly tools: ReadonlyMap<string, ToolDefinitionLike>;
    readonly commands: ReadonlyMap<string, CommandDefinitionLike>;
    readonly appended: readonly AppendedEntry[];
    readonly sentMessages: readonly SentMessage[];
    readonly ui: RecordingUI;
    emit<E extends { readonly type: string }>(event: E): Promise<unknown[]>;
    setContext(ctx: FakeContext): void;
    setIdle(idle: boolean): void;
    setConfirmAnswer(answer: boolean): void;
}

/** Create a host double. Call `setContext` before emitting events or tool calls. */
export function makeFakeHost(): FakeHost {
    const handlers = new Map<string, AnyHandler[]>();
    const tools = new Map<string, ToolDefinitionLike>();
    const commands = new Map<string, CommandDefinitionLike>();
    const appended: AppendedEntry[] = [];
    const sentMessages: SentMessage[] = [];
    const fallbackUI = createRecordingUI();
    let active: FakeContext | null = null;
    // Only overrides set through the host apply to a context; otherwise the
    // context keeps the options it was created with.
    let idleOverride: boolean | null = null;
    let confirmOverride: boolean | null = null;

    const api: ExtensionAPI = {
        on(event: string, handler: AnyHandler): () => void {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
            return () => {
                const current = handlers.get(event);
                if (!current) return;
                const index = current.indexOf(handler);
                if (index >= 0) current.splice(index, 1);
            };
        },
        registerTool(tool: ToolDefinitionLike): void {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, options: CommandDefinitionLike): void {
            commands.set(name, options);
        },
        appendEntry(customType: string, data?: unknown): void {
            if (active === null) {
                throw new Error("fake host: appendEntry called before setContext()");
            }
            active.session.appendCustom(customType, data);
            appended.push({ customType, data });
        },
        sendMessage(message: unknown, options?: unknown): void {
            sentMessages.push({ message, options });
        },
        registerShortcut() {},
        registerFlag() {},
        getFlag: () => undefined,
        registerMessageRenderer() {},
        registerMarkdownTransformer() {},
        registerEntryRenderer() {},
        sendUserMessage() {},
        setSessionName() {},
        getSessionName: () => undefined,
        setLabel() {},
        exec: async () => {
            throw new Error("fake host: exec is not implemented");
        },
        getActiveTools: () => [],
        getAllTools: () => [],
        getSettings: () => {
            throw new Error("fake host: getSettings is not implemented");
        },
        setActiveTools() {},
        getCommands: () => [],
        setModel: async () => false,
        getThinkingLevel: () => "off",
        setThinkingLevel() {},
        registerProvider() {},
        unregisterProvider() {},
        registerMcpServer() {},
        unregisterMcpServer() {},
        getMcpServers: () => [],
        registerVirtualModel() {},
        unregisterVirtualModel() {},
        events: {
            on: () => () => {},
            emit: () => {},
        },
    };

    return {
        api,
        handlers,
        tools,
        commands,
        appended,
        sentMessages,
        get ui() {
            return active?.ui ?? fallbackUI;
        },
        async emit<E extends { readonly type: string }>(event: E): Promise<unknown[]> {
            if (active === null) {
                throw new Error("fake host: emit called before setContext()");
            }
            const results: unknown[] = [];
            for (const handler of handlers.get(event.type) ?? []) {
                results.push(await Reflect.apply(handler, undefined, [event, active]));
            }
            return results;
        },
        setContext(ctx: FakeContext): void {
            active = ctx;
            if (idleOverride !== null) ctx.setIdle(idleOverride);
            if (confirmOverride !== null) ctx.setConfirmAnswer(confirmOverride);
        },
        setIdle(value: boolean): void {
            idleOverride = value;
            active?.setIdle(value);
        },
        setConfirmAnswer(value: boolean): void {
            confirmOverride = value;
            active?.setConfirmAnswer(value);
        },
    };
}

/** A host with the real extension registered and bound to one fake session. */
export interface GoalHarness {
    readonly host: FakeHost;
    readonly session: FakeSession;
    readonly ctx: FakeContext;
    close(): Promise<void>;
}

export function makeGoalHarness(options: {
    readonly session?: FakeSession;
    readonly context?: FakeContextOptions;
} = {}): GoalHarness {
    const session = options.session ?? new FakeSession();
    const host = makeFakeHost();
    const ctx = makeFakeContext(session, options.context ?? {});
    host.setContext(ctx);
    goalsExtension(host.api);
    return {
        host,
        session,
        ctx,
        close: async () => {
            await host.emit({ type: "session_shutdown" });
        },
    };
}

/** True for plain objects (arrays and null excluded). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray` without the implicit `any[]`. */
export function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

/** Model-visible custom message, as `sendMessage` and boundary drafts carry it. */
export interface CustomMessageLike {
    /** Draft entries carry `type: "custom_message"`; sent messages do not. */
    readonly type: string | undefined;
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
    readonly details: unknown;
}

export function asCustomMessage(value: unknown): CustomMessageLike {
    if (!isRecord(value)) throw new Error("expected a custom message object");
    const { type, customType, content, display, details } = value;
    if (typeof customType !== "string") throw new Error("custom message has no customType");
    if (typeof content !== "string") throw new Error("custom message has no text content");
    if (typeof display !== "boolean") throw new Error("custom message has no display flag");
    return {
        type: typeof type === "string" ? type : undefined,
        customType,
        content,
        display,
        details,
    };
}

/**
 * Commit a message the extension sent with `triggerTurn` the way Pi does when it
 * starts the requested run: the custom message becomes a branch entry.
 */
export function commitSentMessage(
    session: FakeSession,
    host: FakeHost,
    index = host.sentMessages.length - 1,
): FakeCustomMessageEntry {
    const sent = host.sentMessages[index];
    if (sent === undefined) throw new Error(`fake host: no sent message at index ${index}`);
    const message = asCustomMessage(sent.message);
    return session.appendCustomMessage(
        message.customType,
        message.content,
        message.display,
        message.details,
    );
}

/** Persisted goal snapshots, oldest first. */
export function snapshots(host: FakeHost): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const entry of host.appended) {
        if (entry.customType !== GOAL_SNAPSHOT_CUSTOM_TYPE) continue;
        if (!isRecord(entry.data)) throw new Error("goal snapshot payload is not an object");
        result.push(entry.data);
    }
    return result;
}

export function lastSnapshot(host: FakeHost): Record<string, unknown> {
    const all = snapshots(host);
    const last = all.at(-1);
    if (last === undefined) throw new Error("fake host: no goal snapshot was appended");
    return last;
}

export function toolNamed(host: FakeHost, name: string): ToolDefinitionLike {
    const tool = host.tools.get(name);
    if (tool === undefined) throw new Error(`fake host: tool ${name} is not registered`);
    return tool;
}

export function commandNamed(host: FakeHost, name: string): CommandDefinitionLike {
    const command = host.commands.get(name);
    if (command === undefined) throw new Error(`fake host: command ${name} is not registered`);
    return command;
}

/** Read a boundary handler result: drafts plus the continuation flag. */
export function readBoundaryResult(value: unknown): {
    readonly entries: CustomMessageLike[];
    readonly continue: boolean;
} {
    if (!isRecord(value)) throw new Error("boundary handler returned no object");
    const entries: CustomMessageLike[] = [];
    if (isUnknownArray(value.entries)) {
        for (const entry of value.entries) entries.push(asCustomMessage(entry));
    }
    return { entries, continue: value.continue === true };
}

/** Read `structuredContent` from a tool result. */
export function structuredContentOf(result: AgentToolResult<unknown>): Record<string, unknown> {
    if (!isRecord(result.structuredContent)) {
        throw new Error("tool result has no structuredContent object");
    }
    return result.structuredContent;
}

/** Join the text blocks of a tool result. */
export function resultText(result: AgentToolResult<unknown>): string {
    const parts: string[] = [];
    for (const block of result.content) {
        if (block.type === "text") parts.push(block.text);
    }
    return parts.join("\n");
}
