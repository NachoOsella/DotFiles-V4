import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { defaultEnabled, shortcuts } from './config.js'
import { isCodexModel, isCodexRequest } from './request.js'

export default function gptFastMode(pi: ExtensionAPI): void {
    let enabled = defaultEnabled()

    function toggle(ctx: ExtensionContext): void {
        enabled = !enabled
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
