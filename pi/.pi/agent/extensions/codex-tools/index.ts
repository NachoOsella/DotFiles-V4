import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import {
    createBashToolDefinition,
    createEditToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
} from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'

export default function (pi: ExtensionAPI) {
    const cwd = process.cwd()

    // Keep Pi default behavior: tool outputs start collapsed.
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setToolsExpanded(false)
    })

    const prefixCall = (theme: any, name: string) =>
        theme.fg('success', '●') + ' ' + theme.fg('toolTitle', theme.bold(name))

    const setFirstLine = (component: any, firstLine: string) => {
        if (!component || typeof component.setText !== 'function') {
            return new Text(firstLine, 0, 0)
        }

        // If we can't safely read the current text buffer, keep original component untouched
        // to preserve native Pi rendering instead of accidentally hiding content.
        if (typeof component.text !== 'string') {
            return component
        }

        const raw = component.text
        if (!raw) {
            return component
        }

        const nl = raw.indexOf('\n')
        if (nl === -1) {
            component.setText(firstLine)
        } else {
            component.setText(firstLine + raw.slice(nl))
        }
        return component
    }

    const readDef = createReadToolDefinition(cwd)
    pi.registerTool({
        ...readDef,
        renderCall(args, theme, _context) {
            const parts: string[] = []
            if ((args as any)?.path) parts.push(`"${(args as any).path}"`)
            if (typeof (args as any)?.offset === 'number')
                parts.push(`offset:${(args as any).offset}`)
            if (typeof (args as any)?.limit === 'number')
                parts.push(`limit:${(args as any).limit}`)
            return new Text(
                prefixCall(theme, 'read') +
                    (parts.length
                        ? ' ' + theme.fg('muted', parts.join(' '))
                        : ''),
                0,
                0
            )
        },
    })

    const bashDef = createBashToolDefinition(cwd)
    pi.registerTool({
        ...bashDef,
        renderCall(args, theme, _context) {
            const command = String((args as any)?.command ?? '')
            const cmd =
                command.length > 80 ? `${command.slice(0, 77)}...` : command
            return new Text(
                prefixCall(theme, 'bash') + ' ' + theme.fg('accent', cmd),
                0,
                0
            )
        },
    })

    // Keep native Pi write/edit renderers (with expand/collapse), but restyle first line.
    const editDef = createEditToolDefinition(cwd)
    pi.registerTool({
        ...editDef,
        renderCall(args, theme, context) {
            const original = editDef.renderCall
                ? editDef.renderCall(args, theme, context)
                : new Text('', 0, 0)
            const path =
                typeof (args as any)?.path === 'string'
                    ? (args as any).path
                    : ''
            const firstLine =
                prefixCall(theme, 'edit') +
                (path ? ' ' + theme.fg('accent', `"${path}"`) : '')
            return setFirstLine(original as any, firstLine)
        },
    })

    const writeDef = createWriteToolDefinition(cwd)
    pi.registerTool({
        ...writeDef,
        renderCall(args, theme, context) {
            const original = writeDef.renderCall
                ? writeDef.renderCall(args, theme, context)
                : new Text('', 0, 0)
            const path =
                typeof (args as any)?.path === 'string'
                    ? (args as any).path
                    : ''
            const firstLine =
                prefixCall(theme, 'write') +
                (path ? ' ' + theme.fg('accent', `"${path}"`) : '')
            return setFirstLine(original as any, firstLine)
        },
    })
}
