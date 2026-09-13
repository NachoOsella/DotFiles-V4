import { Plugin } from '@opencode/plugin'
import { Client } from '@xhayper/discord-rpc'
import { basename } from 'node:path'

const DEFAULT_DISCORD_CLIENT_ID = '1462270555586822206'
const DISCORD_CONNECT_TIMEOUT_MS = 5_000
const MAX_ACTIVITY_TEXT_LENGTH = 128

interface DiscordActivity {
    name: string
    type: number
    details: string
    state: string
    timestamps: { start: number }
    assets: {
        large_image: string
        large_text: string
        small_image: string
        small_text: string
    }
    instance: boolean
}

interface SessionInfo {
    directory?: string
    location?: { directory?: string }
    path?: { root?: string }
}

interface SessionModel {
    id?: string
    providerID?: string
}

interface SessionPart {
    type?: string
    tool?: string
    state?: { status?: string }
}

interface OpenCodeEvent {
    type?: string
    data?: {
        sessionID?: string
        info?: SessionInfo
        status?: { type?: string }
        location?: { directory?: string }
        model?: SessionModel
        part?: SessionPart
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function asEvent(value: unknown): OpenCodeEvent {
    if (!isRecord(value)) return {}

    const data = isRecord(value.data) ? value.data : undefined
    const info = data && isRecord(data.info) ? data.info : undefined
    const location = data && isRecord(data.location) ? data.location : undefined
    const path = info && isRecord(info.path) ? info.path : undefined
    const model = data && isRecord(data.model) ? data.model : undefined
    const part = data && isRecord(data.part) ? data.part : undefined
    const directory =
        info && typeof info.directory === 'string'
            ? info.directory
            : location && typeof location.directory === 'string'
              ? location.directory
              : undefined

    return {
        type: typeof value.type === 'string' ? value.type : undefined,
        data: data
            ? {
                  sessionID:
                      typeof data.sessionID === 'string'
                          ? data.sessionID
                          : undefined,
                  info: directory
                      ? {
                            directory,
                            location: location
                                ? {
                                      directory:
                                          typeof location.directory === 'string'
                                              ? location.directory
                                              : undefined,
                                  }
                                : undefined,
                            path: path
                                ? {
                                      root:
                                          typeof path.root === 'string'
                                              ? path.root
                                              : undefined,
                                  }
                                : undefined,
                        }
                      : undefined,
                  location: directory ? { directory } : undefined,
                  model: model
                      ? {
                            id:
                                typeof model.id === 'string'
                                    ? model.id
                                    : undefined,
                            providerID:
                                typeof model.providerID === 'string'
                                    ? model.providerID
                                    : undefined,
                        }
                      : undefined,
                  part: part
                      ? {
                            type:
                                typeof part.type === 'string'
                                    ? part.type
                                    : undefined,
                            tool:
                                typeof part.tool === 'string'
                                    ? part.tool
                                    : undefined,
                            state:
                                isRecord(part.state) &&
                                typeof part.state.status === 'string'
                                    ? { status: part.state.status }
                                    : undefined,
                        }
                      : undefined,
                  status:
                      isRecord(data.status) &&
                      typeof data.status.type === 'string'
                          ? { type: data.status.type }
                          : undefined,
              }
            : undefined,
    }
}

function projectName(directory: string): string {
    return basename(directory) || directory
}

function truncate(value: string): string {
    if (value.length <= MAX_ACTIVITY_TEXT_LENGTH) return value
    return `${value.slice(0, MAX_ACTIVITY_TEXT_LENGTH - 3)}...`
}

function formatModel(model: SessionModel | undefined): string | undefined {
    if (!model?.id) return undefined
    return model.providerID ? `${model.providerID}/${model.id}` : model.id
}

function eventStatus(event: OpenCodeEvent): string | undefined {
    if (event.type === 'session.error') return 'Error'
    if (event.type === 'session.idle') return 'Waiting for input'

    if (event.type === 'session.status') {
        switch (event.data?.status?.type) {
            case 'busy':
                return 'Thinking...'
            case 'retry':
                return 'Retrying...'
            case 'idle':
                return 'Waiting for input'
        }
    }

    if (event.type === 'message.part.updated') {
        const part = event.data?.part
        if (part?.state?.status === 'error') return 'Error'
        if (part?.state?.status === 'running') {
            return part.tool ? `Running ${part.tool}` : 'Working...'
        }
    }

    return undefined
}

function buildActivity(
    project: string,
    model: string | undefined,
    status: string,
    startedAt: number
): DiscordActivity {
    return {
        name: 'OpenCode',
        type: 0,
        details: truncate(`Working on ${project}`),
        state: truncate(model ? `${status} · ${model}` : status),
        timestamps: { start: startedAt },
        assets: {
            large_image: 'opencode_rpc_large_dark_1024',
            large_text: 'OpenCode - AI Coding Agent',
            small_image: 'opencode_icon_tight_dark_1024',
            small_text: 'OpenCode',
        },
        instance: true,
    }
}

async function connectDiscord(clientId: string): Promise<Client> {
    const client = new Client({ clientId })

    try {
        await new Promise<void>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | undefined

            const cleanup = () => {
                if (timeout) clearTimeout(timeout)
                client.removeListener('ready', onReady)
                client.removeListener('error', onError)
            }
            const onReady = () => {
                cleanup()
                resolve()
            }
            const onError = (error: unknown) => {
                cleanup()
                reject(
                    error instanceof Error ? error : new Error(String(error))
                )
            }

            timeout = setTimeout(() => {
                onError(
                    new Error(
                        'Discord desktop did not accept the RPC connection'
                    )
                )
            }, DISCORD_CONNECT_TIMEOUT_MS)
            client.once('ready', onReady)
            client.once('error', onError)
            void client.login().catch(onError)
        })

        return client
    } catch (error) {
        await client.destroy().catch(() => {})
        throw error
    }
}

async function setActivity(
    client: Client,
    activity: DiscordActivity
): Promise<void> {
    await client.request('SET_ACTIVITY', {
        pid: process.pid,
        activity: {
            ...activity,
            created_at: Date.now(),
        },
    })
}

async function clearActivity(client: Client): Promise<void> {
    await client.request('SET_ACTIVITY', {
        pid: process.pid,
        activity: {},
    })
}

class DiscordPresence {
    private client: Client | undefined
    private currentProject: string | undefined
    private currentSessionID: string | undefined
    private currentModel: string | undefined
    private currentStatus = 'Waiting for input'
    private startedAt = 0
    private enabled = false
    private operation: Promise<void> = Promise.resolve()
    private readonly sessions = new Map<
        string,
        { project: string; model?: string }
    >()
    private consumers = 0
    private readonly clientId: string

    constructor(clientId: string) {
        this.clientId = clientId
    }

    isEnabled(): boolean {
        return this.enabled
    }

    retain(): void {
        this.consumers += 1
    }

    async release(): Promise<void> {
        this.consumers = Math.max(0, this.consumers - 1)
        if (this.consumers === 0) await this.stop()
    }

    start(project: string, sessionID?: string, model?: string): Promise<void> {
        this.enabled = true
        this.currentProject = project
        this.currentSessionID = sessionID
        this.currentModel = model
        this.currentStatus = 'Waiting for input'
        if (!this.startedAt) this.startedAt = Date.now()

        return this.enqueue(async () => {
            if (!this.enabled) return

            if (!this.client) {
                this.client = await connectDiscord(this.clientId)
                this.client.once('disconnected', () => {
                    this.client = undefined
                    this.enabled = false
                    this.startedAt = 0
                    console.warn(
                        '[opencode-discord-activity] Discord disconnected'
                    )
                })
            }

            await setActivity(
                this.client,
                buildActivity(
                    this.currentProject ?? 'project',
                    this.currentModel,
                    this.currentStatus,
                    this.startedAt
                )
            )
        })
    }

    stop(): Promise<void> {
        this.enabled = false
        this.currentProject = undefined
        this.currentSessionID = undefined
        this.currentModel = undefined
        this.currentStatus = 'Waiting for input'
        this.startedAt = 0

        return this.enqueue(async () => {
            const client = this.client
            this.client = undefined
            if (!client) return

            await clearActivity(client).catch(() => {})
            await client.destroy().catch(() => {})
        })
    }

    observe(event: OpenCodeEvent): void {
        const data = event.data
        if (!data?.sessionID) return

        const directory =
            data.info?.directory ??
            data.info?.path?.root ??
            data.location?.directory
        const model = formatModel(data.model)
        const previous = this.sessions.get(data.sessionID)
        if (directory || model) {
            this.sessions.set(data.sessionID, {
                project: directory
                    ? projectName(directory)
                    : (previous?.project ?? 'project'),
                model: model ?? previous?.model,
            })
        }

        if (event.type === 'session.deleted') {
            this.sessions.delete(data.sessionID)
            if (data.sessionID === this.currentSessionID) {
                this.currentSessionID = undefined
            }
            return
        }

        if (!this.enabled) return

        const status = eventStatus(event)
        const isRelevantEvent =
            event.type === 'session.created' ||
            event.type === 'session.updated' ||
            status !== undefined
        if (!isRelevantEvent) return

        const session = this.sessions.get(data.sessionID)
        const project =
            session?.project ?? (directory && projectName(directory))
        if (!project) return

        this.currentSessionID = data.sessionID
        this.currentProject = project
        this.currentModel = session?.model ?? model
        if (status) this.currentStatus = status
        this.updateActivity()
    }

    private updateActivity(): void {
        void this.enqueue(async () => {
            if (!this.enabled || !this.client) return
            await setActivity(
                this.client,
                buildActivity(
                    this.currentProject ?? 'project',
                    this.currentModel,
                    this.currentStatus,
                    this.startedAt || Date.now()
                )
            )
        }).catch((error: unknown) => this.reportError(error))
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const next = this.operation.then(operation, operation)
        this.operation = next.catch(() => {})
        return next.catch((error: unknown) => {
            this.reportError(error)
            throw error
        })
    }

    private reportError(error: unknown): void {
        const client = this.client
        this.client = undefined
        this.enabled = false
        this.startedAt = 0
        void client?.destroy().catch(() => {})
        console.warn(
            '[opencode-discord-activity] Discord unavailable:',
            error instanceof Error ? error.message : String(error)
        )
    }
}

const sharedPresence = new DiscordPresence(
    process.env.DISCORD_CLIENT_ID?.trim() || DEFAULT_DISCORD_CLIENT_ID
)

function commandAction(text: string): 'on' | 'off' | 'status' | 'toggle' {
    const argument = text
        .trim()
        .replace(/^\/?discord\b\s*/i, '')
        .trim()
        .toLowerCase()
        .split(/\s+/)[0]

    if (
        argument === 'on' ||
        argument === 'off' ||
        argument === 'status' ||
        argument === 'toggle'
    ) {
        return argument
    }
    return 'toggle'
}

export default Plugin.define({
    id: 'opencode-discord-activity',
    async setup(ctx) {
        const controller = new AbortController()
        sharedPresence.retain()

        void (async () => {
            try {
                for await (const rawEvent of ctx.event.subscribe({
                    signal: controller.signal,
                })) {
                    sharedPresence.observe(asEvent(rawEvent))
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    console.warn(
                        '[opencode-discord-activity] Event stream stopped:',
                        error instanceof Error ? error.message : String(error)
                    )
                }
            }
        })()

        await ctx.command.transform((editor) => {
            editor.add({
                name: 'discord',
                description: 'Toggle Discord activity (on, off, status)',
                execute: async ({ sessionID, prompt }) => {
                    const action = commandAction(prompt.text)
                    if (action === 'status') {
                        console.log(
                            `[opencode-discord-activity] ${sharedPresence.isEnabled() ? 'enabled' : 'disabled'}`
                        )
                        return
                    }

                    if (
                        action === 'off' ||
                        (action === 'toggle' && sharedPresence.isEnabled())
                    ) {
                        await sharedPresence.stop()
                        return
                    }

                    const session = await ctx.session.get({ sessionID })
                    const directory = session.location.directory
                    await sharedPresence.start(
                        projectName(directory),
                        sessionID,
                        formatModel(session.model)
                    )
                },
            })
        })

        return async () => {
            controller.abort()
            await sharedPresence.release()
        }
    },
})
