import { Plugin, usePlugin } from '@opencode/plugin/tui'
import { createMemo, Show } from 'solid-js'
import {
    BAR_WIDTH,
    CRITICAL_THRESHOLD,
    HIGH_THRESHOLD,
    buildBar,
    detailLine,
    totalUsage,
    usagePercent,
} from './usage.ts'

type TuiContext = ReturnType<typeof usePlugin>
type Message = ReturnType<
    TuiContext['data']['session']['message']['list']
>[number]
type Model = NonNullable<
    ReturnType<TuiContext['data']['location']['model']['list']>
>[number]
type AssistantMessage = Extract<Message, { type: 'assistant' }>

const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
})

function isAssistant(message: Message): message is AssistantMessage {
    return message.type === 'assistant'
}

function resolveUsage(ctx: TuiContext, sessionID: string) {
    try {
        const session = ctx.data.session.get(sessionID)
        const messages = ctx.data.session.message.list(sessionID) ?? []
        const boundary = session?.revert?.messageID
        const boundaryIndex = boundary
            ? messages.findIndex((message) => message.id === boundary)
            : -1
        if (boundary && boundaryIndex < 0) {
            return { used: 0, total: 0, percent: undefined }
        }

        const end = boundaryIndex >= 0 ? boundaryIndex : messages.length
        let compactionIndex = -1
        for (let index = end - 1; index >= 0; index--) {
            const message = messages[index]
            if (message.type === 'compaction' && message.status === 'completed') {
                compactionIndex = index
                break
            }
        }

        let assistant: AssistantMessage | undefined
        for (let index = end - 1; index > compactionIndex; index--) {
            const message = messages[index]
            if (isAssistant(message) && totalUsage(message.tokens) > 0) {
                assistant = message
                break
            }
        }

        const used = totalUsage(assistant?.tokens)
        const reference = assistant?.model ?? session?.model
        const models: Model[] =
            ctx.data.location.model.list(session?.location ?? ctx.location) ?? []
        const total = reference
            ? models.find(
                  (model) =>
                      model.providerID === reference.providerID &&
                      (model.id === reference.id ||
                          model.modelID === reference.id),
              )?.limit.context ?? 0
            : 0

        return { used, total, percent: usagePercent(used, total) }
    } catch {
        return { used: 0, total: 0, percent: undefined }
    }
}

function ContextProgress(props: { sessionID: string }) {
    const ctx = usePlugin()
    const usage = createMemo(() => resolveUsage(ctx, props.sessionID))
    const cost = createMemo(() => ctx.data.session.cost(props.sessionID))
    const tone = createMemo(() => {
        const percent = usage().percent ?? 0
        if (percent >= CRITICAL_THRESHOLD) {
            return ctx.theme.text.feedback.error.default
        }
        if (percent >= HIGH_THRESHOLD) {
            return ctx.theme.text.feedback.warning.default
        }
        return ctx.theme.text.subdued
    })

    return (
        <Show when={usage().used > 0 || cost() > 0}>
            <box flexDirection="column">
                <text fg={ctx.theme.text.default}>Context</text>
                <Show when={usage().used > 0}>
                    <text fg={ctx.theme.text.subdued}>
                        {detailLine(usage().used, usage().total)}
                    </text>
                </Show>
                <Show when={usage().percent !== undefined}>
                    <text fg={tone()}>
                        {`${buildBar(usage().percent!, BAR_WIDTH)} ${usage().percent}%`}
                    </text>
                </Show>
                <Show when={cost() > 0}>
                    <text fg={ctx.theme.text.subdued}>{money.format(cost())} spent</text>
                </Show>
            </box>
        </Show>
    )
}

export default Plugin.define({
    id: 'context-progress',
    setup(ctx) {
        return ctx.ui.slot({
            append: 'sidebar.content',
            render: (input) => (
                <ContextProgress sessionID={input.sessionID} />
            ),
        })
    },
})
