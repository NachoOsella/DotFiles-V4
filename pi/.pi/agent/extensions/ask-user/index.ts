import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Cause, Effect, Exit } from 'effect'
import { Type, type Static } from 'typebox'
import { QuestionnaireComponent } from './component.ts'
import { CUSTOM_OPTION_LABEL, type StoredAnswer } from './state.ts'
import {
    ASK_USER_PARAMETER_DESCRIPTIONS,
    ASK_USER_PROMPT_GUIDELINES,
    ASK_USER_PROMPT_SNIPPET,
    ASK_USER_TOOL_DESCRIPTION,
    buildAskUserResultMessage,
} from './prompt.ts'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 5
const MAX_QUESTIONS = 5

const OptionSchema = Type.Object({
    label: Type.String({
        description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
    }),
    description: Type.Optional(
        Type.String({
            description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
        })
    ),
})

const QuestionSchema = Type.Object({
    question: Type.String({
        description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
    }),
    options: Type.Array(OptionSchema, {
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    }),
})

const AskUserParams = Type.Object({
    questions: Type.Array(QuestionSchema, {
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
    }),
})

export type AskUserInput = Static<typeof AskUserParams>
type Question = AskUserInput['questions'][number]

type Answer = StoredAnswer
type SelectionResult = Answer[] | null
export type AskUserOutcome =
    'answered' | 'dismissed' | 'aborted' | 'unavailable'

interface AskUserDetails {
    questions: Array<{ question: string; options: string[] }>
    answers: Answer[]
    cancelled: boolean
    outcome: AskUserOutcome
}

export default function askUser(pi: ExtensionAPI) {
    pi.registerTool({
        name: 'ask_user',
        label: 'Ask User',
        description: ASK_USER_TOOL_DESCRIPTION,
        promptSnippet: ASK_USER_PROMPT_SNIPPET,
        promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
        parameters: AskUserParams,
        executionMode: 'sequential',
        prepareArguments(args) {
            if (!args || typeof args !== 'object') return args as AskUserInput
            const input = args as {
                questions?: unknown
                question?: unknown
                options?: unknown
            }
            if (
                input.questions === undefined &&
                typeof input.question === 'string'
            ) {
                return {
                    questions: [
                        { question: input.question, options: input.options },
                    ],
                } as AskUserInput
            }
            return args as AskUserInput
        },

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const questionDetails = params.questions.map((question) => ({
                question: question.question,
                options: question.options.map((option) => option.label),
            }))
            const reply = (
                text: string,
                answers: Answer[] = [],
                outcome: AskUserOutcome
            ) => ({
                content: [{ type: 'text' as const, text }],
                details: {
                    questions: questionDetails,
                    answers,
                    cancelled: outcome !== 'answered',
                    outcome,
                } satisfies AskUserDetails,
            })

            for (const [index, question] of params.questions.entries()) {
                if (
                    question.options.length < MIN_OPTIONS ||
                    question.options.length > MAX_OPTIONS
                ) {
                    throw new Error(
                        `Question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${question.options.length}).`
                    )
                }
            }

            if (ctx.mode !== 'tui' && !ctx.hasUI) {
                return reply(
                    buildAskUserResultMessage({ kind: 'unavailable' }),
                    [],
                    'unavailable'
                )
            }
            if (signal?.aborted) {
                return reply(
                    buildAskUserResultMessage({ kind: 'aborted' }),
                    [],
                    'aborted'
                )
            }

            if (ctx.mode === 'rpc') {
                const answers: Answer[] = []
                for (const [questionIndex, question] of params.questions.entries()) {
                    if (signal?.aborted) {
                        return reply(
                            buildAskUserResultMessage({ kind: 'aborted' }),
                            [],
                            'aborted'
                        )
                    }

                    const displayedOptions = question.options.map((option) =>
                        option.description
                            ? `${option.label} — ${option.description}`
                            : option.label
                    )
                    const choice = await ctx.ui.select(
                        `Question ${questionIndex + 1}/${params.questions.length}: ${question.question}`,
                        [...displayedOptions, CUSTOM_OPTION_LABEL],
                        { signal }
                    )
                    if (choice === undefined) {
                        const outcome = signal?.aborted ? 'aborted' : 'dismissed'
                        return reply(
                            buildAskUserResultMessage({ kind: outcome }),
                            [],
                            outcome
                        )
                    }

                    if (choice === CUSTOM_OPTION_LABEL) {
                        const answer = await ctx.ui.input(
                            question.question,
                            'Write your answer',
                            { signal }
                        )
                        if (answer === undefined) {
                            const outcome = signal?.aborted ? 'aborted' : 'dismissed'
                            return reply(
                                buildAskUserResultMessage({ kind: outcome }),
                                [],
                                outcome
                            )
                        }
                        answers.push({
                            question: question.question,
                            answer: answer.trim(),
                            wasCustom: true,
                        })
                        continue
                    }

                    const selectedIndex = displayedOptions.indexOf(choice)
                    const selected = question.options[selectedIndex]
                    if (!selected) {
                        return reply(
                            buildAskUserResultMessage({ kind: 'dismissed' }),
                            [],
                            'dismissed'
                        )
                    }
                    answers.push({
                        question: question.question,
                        answer: selected.label,
                        wasCustom: false,
                        index: selectedIndex + 1,
                    })
                }
                return reply(
                    buildAskUserResultMessage({ kind: 'answered', answers }),
                    answers,
                    'answered'
                )
            }

            const showQuestions = (uiSignal: AbortSignal) =>
                ctx.ui.custom<SelectionResult>(
                    (tui, theme, keybindings, done) => {
                        let settled = false
                        const component = new QuestionnaireComponent(
                            tui,
                            theme,
                            keybindings,
                            params.questions,
                            (result) => {
                                if (settled) return
                                settled = true
                                uiSignal.removeEventListener('abort', onAbort)
                                done(result)
                            }
                        )

                        function onAbort() {
                            component.abort()
                        }

                        uiSignal.addEventListener('abort', onAbort, {
                            once: true,
                        })
                        if (uiSignal.aborted) queueMicrotask(onAbort)

                        const originalDispose =
                            component.dispose.bind(component)
                        component.dispose = () => {
                            uiSignal.removeEventListener('abort', onAbort)
                            originalDispose()
                        }
                        return component
                    }
                )

            const uiExit = await Effect.runPromiseExit(
                Effect.tryPromise(showQuestions),
                signal ? { signal } : undefined
            )

            if (Exit.isFailure(uiExit)) {
                if (Cause.hasInterruptsOnly(uiExit.cause)) {
                    return reply(
                        buildAskUserResultMessage({ kind: 'aborted' }),
                        [],
                        'aborted'
                    )
                }
                const [first] = Cause.prettyErrors(uiExit.cause)
                throw new Error(first?.message ?? Cause.pretty(uiExit.cause))
            }

            const answers = uiExit.value
            if (!answers) {
                return reply(
                    buildAskUserResultMessage({ kind: 'dismissed' }),
                    [],
                    'dismissed'
                )
            }
            return reply(
                buildAskUserResultMessage({ kind: 'answered', answers }),
                answers,
                'answered'
            )
        },

        renderCall(args, theme, _context) {
            const questions = Array.isArray(args.questions)
                ? (args.questions as Question[])
                : []
            let text = theme.fg('toolTitle', theme.bold('ask_user '))
            text += theme.fg(
                'muted',
                `${questions.length} question${questions.length === 1 ? '' : 's'}`
            )
            for (const [index, question] of questions.entries()) {
                text += `\n${theme.fg('dim', `  ${index + 1}. ${question.question}`)}`
            }
            return new Text(text, 0, 0)
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as
                (AskUserDetails & { outcome?: AskUserOutcome }) | undefined
            if (!details) {
                const first = result.content[0]
                return new Text(first?.type === 'text' ? first.text : '', 0, 0)
            }
            if (details.outcome === 'aborted') {
                return new Text(theme.fg('warning', 'Aborted'), 0, 0)
            }
            if (details.outcome === 'unavailable') {
                return new Text(theme.fg('warning', 'No interactive UI'), 0, 0)
            }
            if (details.cancelled) {
                return new Text(theme.fg('warning', 'Dismissed'), 0, 0)
            }
            const lines = details.answers.map((answer, index) => {
                const value = answer.wasCustom
                    ? `(wrote) ${answer.answer}`
                    : `${answer.index}. ${answer.answer}`
                return `${theme.fg('success', 'OK ')}${theme.fg('accent', `${index + 1}.`)} ${value}`
            })
            return new Text(lines.join('\n'), 0, 0)
        },
    })
}
