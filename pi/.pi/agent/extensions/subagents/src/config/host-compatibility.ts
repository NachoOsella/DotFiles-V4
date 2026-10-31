/** Pi 1.4 prepares system instructions for custom-triggered child runs. */
export function isSupportedHostVersion(version: string): boolean {
    const match = /^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.exec(version)
    return match !== null && Number(match[1]) >= 4
}

export function assertSupportedHost(version: string): void {
    if (!isSupportedHostVersion(version)) {
        throw new Error(
            `Subagents requires Pi >=1.4.0 <2.0.0; installed ${version}. Older custom-triggered runs omit system instructions.`
        )
    }
}
