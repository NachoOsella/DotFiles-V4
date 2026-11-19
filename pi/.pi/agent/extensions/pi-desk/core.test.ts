import assert from 'node:assert/strict'
import test from 'node:test'
import { bounded, createForwarder } from './core.ts'

test('bounded clips strings and arrays', () => {
    const out = bounded({ a: 'x'.repeat(1000), list: Array.from({ length: 300 }, (_, i) => i) }) as {
        a: string
        list: number[]
    }
    assert.equal(out.a.length, 601)
    assert.equal(out.list.length, 100)
})

test('forwarder throttles per channel and de-duplicates', () => {
    const sent: Array<[string, string]> = []
    const timers: Array<() => void> = []
    const f = createForwarder((k, t) => sent.push([k, t]), 150, (fn) => timers.push(fn))
    f.push('dashboard:git-info', { branch: 'a' })
    f.push('dashboard:git-info', { branch: 'b' })
    f.push('dashboard:model-info', { modelId: 'm' })
    assert.equal(timers.length, 2)
    timers.splice(0).forEach((fn) => fn())
    assert.equal(sent.length, 2)
    assert.equal(sent[0][0], 'pi-desk:dashboard:git-info')
    assert.equal(JSON.parse(sent[0][1]).data.branch, 'b')
    f.push('dashboard:git-info', { branch: 'b' })
    timers.splice(0).forEach((fn) => fn())
    assert.equal(sent.length, 2, 'identical payload is not resent')
    f.reset()
    f.push('dashboard:git-info', { branch: 'b' })
    timers.splice(0).forEach((fn) => fn())
    assert.equal(sent.length, 3)
})
