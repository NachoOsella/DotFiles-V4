import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
    FAST_MODE_CHANNEL,
    REFRESH_CHANNEL,
} from '../shared/dashboard-state.ts'
import { defaultEnabled, shortcuts } from './config.js'
import { isCodexModel, isCodexRequest } from './request.js'

export default function gptFastMode(pi: ExtensionAPI): void {
    let enabled = defaultEnabled()

    // GUI hosts (pi-desk) show a fast-mode chip from this channel. With no
    // listener (plain TUI) the emit is a no-op. Optional chaining keeps test
    // doubles and older hosts without an event bus working.
    const publish = () => {
        try {
            pi.events?.emit(FAST_MODE_CHANNEL, { active: enabled })
        } catch {
            // Advisory only.
        }
    }
    pi.events?.on(REFRESH_CHANNEL, publish)

    function toggle(ctx: ExtensionContext): void {
        enabled = !enabled
        publish()
        if (!ctx.hasUI) return
        if (!enabled) {
            ctx.ui.notify('GPT Fast mode disabled.', 'info')
        } else if (
            isCodexModel(
                ctx.model,
                ctx.model &&
                    ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
            )
        ) {
            ctx.ui.notify(
                'GPT Fast mode enabled (service_tier: priority).',
                'info'
            )
        } else {
            ctx.ui.notify(
                'GPT Fast mode enabled, but the current model is not supported.',
                'warning'
            )
        }
    }

    pi.registerCommand('fast', {
        description: 'Toggle GPT Fast mode (service_tier: priority)',
        handler: async (_args, ctx) => toggle(ctx),
    })

    for (const shortcut of shortcuts()) {
        pi.registerShortcut(
            shortcut as Parameters<ExtensionAPI['registerShortcut']>[0],
            {
                description: 'Toggle GPT Fast mode',
                handler: toggle,
            }
        )
    }

    pi.on('session_start', () => {
        enabled = defaultEnabled()
        publish()
    })

    pi.on('before_provider_request', (event, ctx) => {
        if (!enabled || !ctx.model) return
        const registeredModel = ctx.modelRegistry.find(
            ctx.model.provider,
            ctx.model.id
        )
        if (!isCodexRequest(ctx.model, registeredModel, event.payload)) return
        return { ...event.payload, service_tier: 'priority' }
    })
}
