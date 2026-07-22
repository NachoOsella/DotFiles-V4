import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startClient } from './src/client.ts'

test('starts an stdio LSP client and receives diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-test-'))
    const server = join(root, 'server.mjs')
    const filePath = join(root, 'example.ts')
    await writeFile(filePath, 'const value: string = 1\n')
    await writeFile(
        server,
        `
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const separator = buffer.indexOf('\\r\\n\\r\\n')
    if (separator < 0) break
    const header = buffer.subarray(0, separator).toString()
    const length = Number(header.match(/Content-Length: (\\d+)/i)?.[1] ?? 0)
    const start = separator + 4
    if (buffer.length < start + length) break
    const message = JSON.parse(buffer.subarray(start, start + length).toString())
    buffer = buffer.subarray(start + length)
    if (message.method === 'initialize') respond(message.id, { capabilities: {} })
    if (message.method === 'textDocument/didOpen') {
      notify('textDocument/publishDiagnostics', {
        uri: message.params.textDocument.uri,
        diagnostics: [{ severity: 1, message: 'test diagnostic', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }]
      })
    }
    if (message.method === 'shutdown') respond(message.id, null)
  }
})
function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
function respond(id, result) { send({ jsonrpc: '2.0', id, result }) }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }) }
`
    )

    const client = await startClient({
        serverId: 'test',
        config: {
            command: [process.execPath, server],
            extensions: ['.ts'],
            rootMarkers: [],
        },
        root,
    })

    try {
        await client.touchFile(filePath, true)
        const diagnostics = client.diagnostics().get(filePath) ?? []
        assert.equal(diagnostics[0]?.message, 'test diagnostic')
    } finally {
        await client.shutdown()
        await rm(root, { recursive: true, force: true })
    }
})
