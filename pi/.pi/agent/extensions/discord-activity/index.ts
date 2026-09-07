/**
 * Discord Activity Extension for Pi
 *
 * Sets your Discord Rich Presence to show what project you're working on with Pi.
 * Powered by Effect v4 for resource lifecycle management.
 *
 * Setup:
 *   1. Start the Discord desktop app.
 *   2. Run `/discord on` when you want to show your activity.
 *
 * Discord applies the activity to the account signed in to its desktop app.
 * DISCORD_CLIENT_ID can optionally override the bundled Pi application ID when
 * using a custom Discord application.
 *
 * The activity is manual. Use `/discord`, `/discord on`, or `/discord off` to
 * control whether Discord shows "prompteando" / "Coding with Pi <project-name>".
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Client } from '@xhayper/discord-rpc'
import { Effect, Fiber, pipe, type Scope } from 'effect'
import { basename } from 'node:path'
import {
    DISCORD_ACTIVITY_CHANNEL,
    REFRESH_CHANNEL,
} from '../shared/dashboard-state.ts'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Shared Pi application ID used when no custom Discord application is set. */
const DEFAULT_DISCORD_CLIENT_ID = '1520833162148712580'
const DISCORD_CONNECT_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal activity payload for Discord's SET_ACTIVITY RPC. */
interface DiscordActivity {
    name?: string
    type?: number
    state?: string
    details?: string
    timestamps?: {
        start?: number
    }
    assets?: {
        large_image?: string
        large_text?: string
        small_image?: string
        small_text?: string
    }
    instance?: boolean
}

// ---------------------------------------------------------------------------
// Effectful Discord operations
// ---------------------------------------------------------------------------

/**
 * Create and connect a Discord RPC client.
 * The client is automatically destroyed when the surrounding Scope closes
 * (acquireRelease pattern).
 */
const connectDiscord = (
    clientId: string
): Effect.Effect<Client, Error, Scope.Scope> =>
    Effect.acquireRelease(
        Effect.tryPromise(async () => {
            const client = new Client({ clientId })

            try {
                await new Promise<void>((resolve, reject) => {
                    let timeout: ReturnType<typeof setTimeout>
                    const cleanup = () => {
                        clearTimeout(timeout)
                        client.removeListener('ready', onReady)
                        client.removeListener('error', onError)
                    }
                    const rejectWithError = (error: unknown) => {
                        cleanup()
                        reject(
                            error instanceof Error
                                ? error
                                : new Error(String(error))
                        )
                    }
                    const onReady = () => {
                        cleanup()
                        resolve()
                    }
                    const onError = (error: unknown) => rejectWithError(error)

                    timeout = setTimeout(
                        () =>
                            rejectWithError(
                                new Error(
                                    'Discord desktop did not accept the RPC connection'
                                )
                            ),
                        DISCORD_CONNECT_TIMEOUT_MS
                    )
                    client.once('ready', onReady)
                    client.once('error', onError)
                    void client.login().catch(rejectWithError)
                })

                return client
            } catch (error) {
                await client.destroy().catch(() => {})
                throw error
            }
        }),
        // release: called when the Scope closes
        (client, _exit) =>
            pipe(
                Effect.tryPromise(() => client.destroy()),
                Effect.catch(() => Effect.void)
            )
    )

/**
 * Set Discord Rich Presence activity via the RPC SET_ACTIVITY command.
 */
const setActivity = (
    client: Client,
    activity: DiscordActivity
): Effect.Effect<void, Error> =>
    pipe(
        Effect.tryPromise(async () => {
            await client.request('SET_ACTIVITY', {
                pid: process.pid,
                activity: {
                    name: activity.name ?? 'Pi',
                    type: activity.type ?? 0, // 0 = Playing
                    created_at: Date.now(),
                    details: activity.details,
                    state: activity.state,
                    timestamps: activity.timestamps,
                    assets: activity.assets,
                    instance: activity.instance ?? false,
                },
            })
        }),
        Effect.asVoid
    )

/**
 * Keep the session alive until Discord closes, while remaining interruptible.
 */
const waitForDisconnect = (client: Client): Effect.Effect<void, Error> =>
    Effect.callback<void, Error>((resume) => {
        const onDisconnected = () =>
            resume(Effect.fail(new Error('Discord desktop disconnected')))

        client.once('disconnected', onDisconnected)
        return Effect.sync(() => {
            client.removeListener('disconnected', onDisconnected)
        })
    })

/**
 * Clear the current Discord activity.
 */
const clearActivity = (client: Client): Effect.Effect<void, Error> =>
    pipe(
        Effect.tryPromise(async () => {
            await client.request('SET_ACTIVITY', {
                pid: process.pid,
                activity: {},
            })
        }),
        Effect.asVoid
    )

// ---------------------------------------------------------------------------
// Activity builder
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable project label from a directory path.
 */
function projectName(cwd: string): string {
    return basename(cwd)
}

/**
 * Build the Discord activity payload for a given project.
 */
function buildActivity(project: string): DiscordActivity {
    return {
        name: 'prompteando',
        type: 0,
        details: `Coding with Pi ${project}`,
        timestamps: {
            start: Date.now(),
        },
        assets: {
            large_text: 'Pi - AI Coding Agent',
        },
        instance: true,
    }
}

// ---------------------------------------------------------------------------
// Main session effect
// ---------------------------------------------------------------------------

/**
 * Full lifecycle effect:
 *   connect -> set activity -> idle forever (until scope is closed).
 *
 * Wrapped in Effect.scoped, so the activity is cleared and the client is
 * destroyed when the fiber is interrupted.
 */
const sessionEffect = (
    clientId: string,
    project: string,
    onActivitySet: () => void,
    onUnavailable: (error: unknown) => void
): Effect.Effect<void, Error, never> =>
    pipe(
        Effect.scoped(
            Effect.gen(function* () {
                const client: Client = yield* connectDiscord(clientId)
                yield* setActivity(client, buildActivity(project))
                yield* Effect.sync(onActivitySet)

                // Keep the scope alive while Discord is connected. Interruption or a
                // disconnect closes the scope and destroys the RPC client.
                yield* Effect.ensuring(
                    waitForDisconnect(client),
                    pipe(
                        clearActivity(client),
                        Effect.catch(() => Effect.void)
                    )
                )
            })
        ),
        // Discord is optional, so an unavailable desktop client should not surface as a Pi error.
        Effect.catch((error: unknown) =>
            Effect.sync(() => onUnavailable(error))
        )
    )

// ---------------------------------------------------------------------------
// Pi Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    /** Reference to the background fiber running the Discord session. */
    let discordFiber: Fiber.Fiber<void, Error> | undefined
    let sessionGeneration = 0
    let activityActive = false

    const publishActivityState = (active: boolean) => {
        activityActive = active
        pi.events.emit(DISCORD_ACTIVITY_CHANNEL, { active })
    }

    const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
        publishActivityState(activityActive)
    })

    const stopDiscord = async (): Promise<boolean> => {
        sessionGeneration += 1
        publishActivityState(false)

        const fiber = discordFiber
        discordFiber = undefined
        if (!fiber) return false

        try {
            await Effect.runPromise(Fiber.interrupt(fiber))
        } catch {
            // Discord cleanup is best-effort because the process may already be gone.
        }
        return true
    }

    const startDiscord = (cwd: string): boolean => {
        if (discordFiber) return false

        const clientId =
            process.env.DISCORD_CLIENT_ID?.trim() || DEFAULT_DISCORD_CLIENT_ID
        const generation = ++sessionGeneration
        const project = projectName(cwd)
        const onActivitySet = () => {
            if (generation !== sessionGeneration) return

            publishActivityState(true)
        }
        const onUnavailable = (_error: unknown) => {
            if (generation !== sessionGeneration) return

            discordFiber = undefined
            publishActivityState(false)
        }

        try {
            const fiber: Fiber.Fiber<void, Error> = Effect.runFork(
                sessionEffect(clientId, project, onActivitySet, onUnavailable)
            )
            discordFiber = fiber
            return true
        } catch (error) {
            onUnavailable(error)
            return false
        }
    }

    pi.registerCommand('discord', {
        description: 'Toggle Discord activity (on, off, status)',
        getArgumentCompletions: (prefix) => {
            const options = ['on', 'off', 'status', 'toggle']
            const matches = options
                .filter((option) => option.startsWith(prefix.toLowerCase()))
                .map((value) => ({ value, label: value }))
            return matches.length > 0 ? matches : null
        },
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase()
            const action = command || 'toggle'

            if (!['on', 'off', 'status', 'toggle'].includes(action)) return
            if (action === 'status') return

            const shouldEnable =
                action === 'on' || (action === 'toggle' && !discordFiber)
            if (shouldEnable) {
                startDiscord(ctx.cwd)
                return
            }

            await stopDiscord()
        },
    })

    // A new session starts with Discord activity disabled. This only cleans up
    // a fiber left by a previous session; it never connects automatically.
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode === 'print') return
        await stopDiscord()
    })

    pi.on('session_shutdown', async () => {
        await stopDiscord()
        stopRefreshListener()
    })
}
