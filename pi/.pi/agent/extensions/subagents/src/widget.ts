/** Compact subagent widget: hidden when idle, one line per agent otherwise. */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { SubagentManager } from './manager.ts'

const WIDGET_KEY = 'subagents'

export function refreshSubagentsWidget(
    ctx: ExtensionContext,
    manager: SubagentManager
): void {
    if (ctx.mode !== 'tui' || !ctx.hasUI) {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            // UI may be unavailable.
        }
        return
    }
    const agents = manager.list('/root' as import('./ids.ts').AgentPath)
    if (agents.length === 0) {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            // Ignore teardown races.
        }
        return
    }
    const active = agents.filter((a) => a.status === 'Running').length
    try {
        ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
            render(width: number): string[] {
                const title =
                    active > 0
                        ? `Agents  ${active} active`
                        : `Agents  ${agents.length} settled`
                const lines = [theme.fg('muted', title)]
                for (const agent of agents.slice(0, 6)) {
                    const glyph =
                        agent.status === 'Running'
                            ? theme.fg('accent', '●')
                            : agent.status === 'Completed'
                              ? theme.fg('success', '✓')
                              : agent.status === 'Errored'
                                ? theme.fg('warning', '!')
                                : theme.fg('dim', '○')
                    const detail =
                        agent.status === 'Interrupted'
                            ? 'Interrupted, available for follow-up'
                            : agent.status
                    const line = `${glyph} ${agent.path} ${detail}`
                    lines.push(line.slice(0, Math.max(0, width)))
                }
                if (agents.length > 6) {
                    lines.push(theme.fg('dim', `+${agents.length - 6} more`))
                }
                return lines
            },
            invalidate(): void {},
        }))
    } catch {
        // Ignore UI races during teardown.
    }
}

export function clearSubagentsWidget(ctx: ExtensionContext): void {
    try {
        ctx.ui.setWidget(WIDGET_KEY, undefined)
    } catch {
        // Ignore teardown races.
    }
}
