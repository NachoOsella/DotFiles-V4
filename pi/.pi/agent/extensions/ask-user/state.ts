/** Pure questionnaire state for ask_user. No TUI dependencies. */

export interface StateOption {
    label: string
    description?: string
}

export interface StateQuestion {
    question: string
    options: StateOption[]
}

export interface DisplayOption {
    label: string
    description?: string
    isOther?: boolean
}

export interface StoredAnswer {
    question: string
    answer: string
    wasCustom: boolean
    index?: number
}

export const CUSTOM_OPTION_LABEL = 'Write my own answer...'

export type SelectOutcome =
    | { finished: true; answers: StoredAnswer[] }
    | { finished: false; movedTo: number }

export type CustomSubmitOutcome =
    | { finished: true; answers: StoredAnswer[] }
    | { finished: false; editing: boolean; movedTo: number }

/** Questionnaire navigation and answer storage. Finish requires every index. */
export class QuestionnaireState {
    readonly questions: StateQuestion[]
    questionIndex = 0
    optionIndex = 0
    editMode = false
    readonly answers = new Map<number, StoredAnswer>()
    /** Bumped on every mutation; render caches key on this plus width. */
    version = 0

    constructor(questions: StateQuestion[]) {
        this.questions = questions
    }

    currentQuestion(): StateQuestion {
        return this.questions[this.questionIndex]
    }

    currentOptions(): DisplayOption[] {
        const current = this.currentQuestion()
        return [
            ...current.options,
            { label: CUSTOM_OPTION_LABEL, isOther: true },
        ]
    }

    private bump(): void {
        this.version += 1
    }

    moveSelection(delta: number): void {
        const count = this.currentOptions().length
        if (count === 0) return
        this.optionIndex = (this.optionIndex + delta + count) % count
        this.bump()
    }

    setOptionIndex(index: number): void {
        const count = this.currentOptions().length
        if (index < 0 || index >= count) return
        if (this.optionIndex === index) return
        this.optionIndex = index
        this.bump()
    }

    moveQuestion(offset: number): boolean {
        const next = this.questionIndex + offset
        if (next < 0 || next >= this.questions.length) return false
        this.questionIndex = next
        this.optionIndex = 0
        if (this.editMode) this.editMode = false
        this.bump()
        return true
    }

    enterEditMode(): void {
        if (this.editMode) return
        this.editMode = true
        this.bump()
    }

    cancelEdit(): void {
        if (!this.editMode) return
        this.editMode = false
        this.bump()
    }

    firstUnanswered(): number | undefined {
        for (let index = 0; index < this.questions.length; index += 1) {
            if (!this.answers.has(index)) return index
        }
        return undefined
    }

    isComplete(): boolean {
        return this.firstUnanswered() === undefined
    }

    orderedAnswers(): StoredAnswer[] | null {
        if (!this.isComplete()) return null
        return this.questions.map(
            (_question, index) => this.answers.get(index) as StoredAnswer
        )
    }

    private saveAndAdvance(
        answer: string,
        wasCustom: boolean,
        index?: number
    ): SelectOutcome {
        this.answers.set(this.questionIndex, {
            question: this.currentQuestion().question,
            answer,
            wasCustom,
            index,
        })
        this.editMode = false
        const ordered = this.orderedAnswers()
        if (ordered) {
            this.bump()
            return { finished: true, answers: ordered }
        }
        const lastIndex = this.questions.length - 1
        if (this.questionIndex === lastIndex) {
            const first = this.firstUnanswered() as number
            this.questionIndex = first
            this.optionIndex = 0
            this.bump()
            return { finished: false, movedTo: first }
        }
        this.questionIndex += 1
        this.optionIndex = 0
        this.bump()
        return { finished: false, movedTo: this.questionIndex }
    }

    /**
     * Select an option by index. The custom row enters edit mode instead of
     * finishing. Regular options store an answer and advance or finish.
     */
    selectOption(
        index: number
    ): SelectOutcome | { finished: false; editing: true } {
        const options = this.currentOptions()
        const selected = options[index]
        if (!selected)
            return { finished: false as const, movedTo: this.questionIndex }
        if (selected.isOther) {
            this.optionIndex = index
            this.enterEditMode()
            return { finished: false as const, editing: true as const }
        }
        return this.saveAndAdvance(selected.label, false, index + 1)
    }

    /** Submit custom text. Blank input leaves edit mode without saving. */
    submitCustom(text: string): CustomSubmitOutcome {
        const trimmed = text.trim()
        if (!trimmed) {
            this.cancelEdit()
            return {
                finished: false,
                editing: false,
                movedTo: this.questionIndex,
            }
        }
        const outcome = this.saveAndAdvance(trimmed, true)
        if (outcome.finished) return outcome
        return {
            finished: false,
            editing: false,
            movedTo: outcome.movedTo,
        }
    }
}
