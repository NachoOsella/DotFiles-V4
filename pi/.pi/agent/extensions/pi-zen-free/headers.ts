/** Create one OpenCode request identifier for a logical provider request. */
export function createOpenCodeRequestId(): string {
    return `req_${crypto.randomUUID().replaceAll('-', '')}`
}
