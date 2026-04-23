// ~/.pi/agent/extensions/dump-system-prompt.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export default function (pi: any) {
    pi.on('before_agent_start', async (event: any) => {
        const dir = path.join(os.homedir(), '.pi', 'debug')
        fs.mkdirSync(dir, { recursive: true })

        const ts = new Date().toISOString().replace(/[:.]/g, '-')

        fs.writeFileSync(
            path.join(dir, `system-prompt-${ts}.md`),
            event.systemPrompt ?? '',
            'utf8'
        )

        fs.writeFileSync(
            path.join(dir, `system-prompt-options-${ts}.json`),
            JSON.stringify(event.systemPromptOptions ?? {}, null, 2),
            'utf8'
        )
    })
}
