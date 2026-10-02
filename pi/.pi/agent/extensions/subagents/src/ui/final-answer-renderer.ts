import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent'
import { Box, Container, Markdown, Text } from '@earendil-works/pi-tui'
import type { FinalAnswerMeta } from '../domain/communication.ts'
import { formatDuration, formatTokens } from './format.ts'

interface CommunicationDetails {
    readonly messageType?: unknown
    readonly author?: unknown
    readonly payload?: unknown
    readonly meta?: unknown
}

interface RenderableCustomMessage {
    readonly content: unknown
    readonly details?: unknown
}

interface MessageRenderOptions {
    readonly outputPad: number
}

/** Render root-bound child completions as a compact transcript card. */
export function renderSubagentCommunication(
    message: RenderableCustomMessage,
    options: MessageRenderOptions,
    theme: Theme
) {
    const details = message.details as CommunicationDetails | undefined
    if (details?.messageType !== 'FINAL_ANSWER') {
        return new Text(
            theme.fg('customMessageText', String(message.content ?? '')),
            options.outputPad,
            0
        )
    }

    const author =
        typeof details.author === 'string' ? details.author : 'subagent'
    const payload =
        typeof details.payload === 'string'
            ? details.payload
            : String(message.content ?? '')
    const meta = details.meta as FinalAnswerMeta | undefined
    const failed = meta?.failed === true
    const content = new Container()
    content.addChild(
        new Text(
            failed
                ? `${theme.fg('error', theme.bold('FINAL ERROR'))}  ${theme.fg('muted', author)}`
                : `${theme.fg('success', theme.bold('FINAL ANSWER'))}  ${theme.fg('muted', author)}`,
            0,
            0
        )
    )
    const detail = [
        meta?.role,
        meta?.model,
        meta?.tokens ? `${formatTokens(meta.tokens)} tok` : '',
        meta?.cost ? `$${meta.cost.toFixed(4)}` : '',
        meta?.durationMs !== undefined ? formatDuration(meta.durationMs) : '',
    ]
        .filter(Boolean)
        .join(' · ')
    if (detail) {
        content.addChild(new Text(theme.fg('dim', detail), 0, 0))
    }
    content.addChild(new Text(theme.fg('borderMuted', '─'.repeat(12)), 0, 0))
    // Failures are short and should read as errors, not as rendered prose.
    if (failed) {
        content.addChild(new Text(theme.fg('error', payload), 0, 0))
    } else {
        content.addChild(new Markdown(payload, 0, 0, getMarkdownTheme()))
    }
    content.addChild(
        new Text(theme.fg('dim', `↳ followup_task ${author}`), 0, 0)
    )

    const card = new Box(options.outputPad, 1, (text) =>
        theme.bg(failed ? 'toolErrorBg' : 'customMessageBg', text)
    )
    card.addChild(content)
    return card
}
