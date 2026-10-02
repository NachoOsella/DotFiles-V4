export function isCodexModel(
    model: { provider: string; id: string } | undefined,
    registeredModel: { api: string } | undefined
): boolean {
    return (
        model?.provider === 'openai-codex' &&
        registeredModel?.api === 'openai-codex-responses'
    )
}

export function isCodexRequest(
    model: { provider: string; id: string } | undefined,
    registeredModel: { api: string } | undefined,
    payload: unknown
): payload is Record<string, unknown> {
    return (
        isCodexModel(model, registeredModel) &&
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).model === model?.id
    )
}
