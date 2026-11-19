/**
 * pi-desk host bridge.
 *
 * Inert unless the session runs under the pi-desk GUI (`PI_DESK=1`, RPC mode):
 * in the TUI it registers nothing, so commands, footer and behavior stay as
 * they are.
 *
 * Under pi-desk it:
 *   - forwards the `dashboard:*` event channels (model, git, subagents,
 *     background terminals, fast mode, discord) to the GUI as
 *     `setStatus("pi-desk:<channel>", <json>)`, throttled and bounded;
 *   - adds `/desk-goto` (RPC has no tree navigation command).
 *
 * It does not gate tool calls: pi-desk runs every tool without asking.
 */
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
    BACKGROUND_TERMINALS_CHANNEL,
    DISCORD_ACTIVITY_CHANNEL,
    FAST_MODE_CHANNEL,
    GIT_INFO_CHANNEL,
    MODEL_INFO_CHANNEL,
    REFRESH_CHANNEL,
    SUBAGENTS_INFO_CHANNEL,
} from '../shared/dashboard-state.ts'
import { createForwarder } from './core.ts'

const FORWARDED_CHANNELS = [
    MODEL_INFO_CHANNEL,
    GIT_INFO_CHANNEL,
    SUBAGENTS_INFO_CHANNEL,
    BACKGROUND_TERMINALS_CHANNEL,
    FAST_MODE_CHANNEL,
    DISCORD_ACTIVITY_CHANNEL,
]

export default function piDesk(pi: ExtensionAPI): void {
    if (process.env.PI_DESK !== '1') return

    let current: ExtensionContext | undefined

    const forwarder = createForwarder((key, text) => {
        const ctx = current
        if (!ctx?.hasUI) return
        try {
            ctx.ui.setStatus(key, text)
        } catch {
            // The session may be shutting down.
        }
    })
    for (const channel of FORWARDED_CHANNELS) {
        pi.events.on(channel, (value: unknown) => forwarder.push(channel, value))
    }

    pi.on('session_start', (_event, ctx) => {
        current = ctx
        forwarder.reset()
        // Ask every producer to publish its current state for the new session.
        pi.events.emit(REFRESH_CHANNEL, undefined)
    })

    pi.on('session_shutdown', () => {
        current = undefined
    })

    pi.registerCommand('desk-goto', {
        description: 'Continue this chat from an earlier entry: /desk-goto <entryId> [summarize]',
        handler: async (args, ctx) => {
            const [entryId, flag] = (args ?? '').trim().split(/\s+/)
            if (!entryId) return
            await ctx.waitForIdle()
            await ctx.navigateTree(entryId, { summarize: flag === 'summarize' })
        },
    })
}
