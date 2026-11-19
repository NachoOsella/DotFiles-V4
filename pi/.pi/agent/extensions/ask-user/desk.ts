/**
 * pi-desk rich questionnaire protocol.
 *
 * In RPC mode under the pi-desk GUI (`PI_DESK=1`), ask_user sends all its
 * questions at once through `ctx.ui.editor("pi-desk:ask_user", <json>)`. The
 * GUI recognizes the title prefix, renders a native multi-question card, and
 * replies with JSON. Any other RPC client keeps the existing one-select-per-
 * question flow, so nothing changes outside pi-desk.
 *
 * Pure module: no Pi imports, testable with plain `node --test`.
 */
import type { StoredAnswer } from './state.ts'

export const DESK_ASK_USER_TITLE = 'pi-desk:ask_user'

export interface DeskQuestionInput {
    question: string
    options: Array<{ label: string; description?: string }>
}

export function isPiDesk(env: Record<string, string | undefined> = process.env): boolean {
    return env.PI_DESK === '1'
}

export function buildDeskPayload(questions: DeskQuestionInput[]): string {
    return JSON.stringify({
        v: 1,
        questions: questions.map((q, index) => ({
            id: `q${index + 1}`,
            label: `Question ${index + 1}`,
            prompt: q.question,
            options: q.options.map((o, i) => ({
                value: String(i + 1),
                label: o.label,
                ...(o.description ? { description: o.description } : {}),
            })),
            allowOther: true,
        })),
    })
}

export type DeskParseResult =
    | { kind: 'answered'; answers: StoredAnswer[] }
    | { kind: 'dismissed' }
    | { kind: 'invalid' }

/**
 * Parses the GUI reply. Expected: `{"answers":[{"id":"q1","value":"2"},
 * {"id":"q2","custom":true,"label":"my text"}]}`; `{"dismissed":true}` means
 * the user closed the card. Anything unusable is `invalid`, and the caller
 * falls back to the plain select flow.
 */
export function parseDeskReply(
    raw: string | undefined,
    questions: DeskQuestionInput[]
): DeskParseResult {
    if (raw === undefined) return { kind: 'dismissed' }
    let data: unknown
    try {
        data = JSON.parse(raw)
    } catch {
        return { kind: 'invalid' }
    }
    if (!data || typeof data !== 'object') return { kind: 'invalid' }
    const record = data as { dismissed?: unknown; answers?: unknown }
    if (record.dismissed === true) return { kind: 'dismissed' }
    if (!Array.isArray(record.answers)) return { kind: 'invalid' }

    const answers: StoredAnswer[] = []
    for (const [index, question] of questions.entries()) {
        const id = `q${index + 1}`
        const reply = record.answers.find(
            (a): a is { id: string; value?: unknown; label?: unknown; custom?: unknown } =>
                !!a && typeof a === 'object' && (a as { id?: unknown }).id === id
        )
        if (!reply) return { kind: 'invalid' }
        if (reply.custom === true) {
            const text = typeof reply.label === 'string' ? reply.label.trim() : ''
            if (!text) return { kind: 'invalid' }
            answers.push({ question: question.question, answer: text, wasCustom: true })
            continue
        }
        const optionIndex = Number(reply.value) - 1
        const option = question.options[optionIndex]
        if (!Number.isInteger(optionIndex) || !option) return { kind: 'invalid' }
        answers.push({
            question: question.question,
            answer: option.label,
            wasCustom: false,
            index: optionIndex + 1,
        })
    }
    return { kind: 'answered', answers }
}
