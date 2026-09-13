import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent'
import { Box, Container, Markdown, Text } from '@earendil-works/pi-tui'

interface CommunicationDetails {
    readonly messageType?: unknown
    readonly author?: unknown
    readonly payload?: unknown
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
    const content = new Container()
    content.addChild(
        new Text(
            `${theme.fg('success', theme.bold('FINAL ANSWER'))}  ${theme.fg('muted', author)}`,
            0,
            0
        )
    )
    content.addChild(new Text(theme.fg('borderMuted', '─'.repeat(12)), 0, 0))
    content.addChild(new Markdown(payload, 0, 0, getMarkdownTheme()))

    const card = new Box(options.outputPad, 1, (text) =>
        theme.bg('customMessageBg', text)
    )
    card.addChild(content)
    return card
}
