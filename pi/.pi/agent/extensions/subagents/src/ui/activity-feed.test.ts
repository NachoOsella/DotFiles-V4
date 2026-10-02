import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ActivityFeed,
    MAX_RETAINED_ENTRIES,
    MAX_SUMMARY_CHARS,
} from './activity-feed.ts'

const PATH = '/root/worker'

test('retains a bounded number of entries and drops the oldest', () => {
    const feed = new ActivityFeed()
    const total = MAX_RETAINED_ENTRIES + 25
    for (let index = 0; index < total; index++) {
        feed.push(PATH, 'tool', `tool-${index}`)
    }
    const entries = feed.get(PATH)
    assert.equal(entries.length, MAX_RETAINED_ENTRIES)
    assert.equal(entries[0]?.summary, `tool-${total - MAX_RETAINED_ENTRIES}`)
    assert.equal(entries.at(-1)?.summary, `tool-${total - 1}`)
})

test('retention also applies to committed live entries', () => {
    const feed = new ActivityFeed()
    for (let index = 0; index < MAX_RETAINED_ENTRIES; index++) {
        feed.push(PATH, 'tool', `tool-${index}`)
    }
    feed.updateLive(PATH, 'message', 'live tail')
    feed.commitLive(PATH)
    const entries = feed.get(PATH)
    assert.equal(entries.length, MAX_RETAINED_ENTRIES)
    assert.equal(entries[0]?.summary, 'tool-1')
    assert.equal(entries.at(-1)?.summary, 'live tail')
    assert.equal(entries.at(-1)?.live, false)
})

test('commits live entries and keeps tool identity', () => {
    const feed = new ActivityFeed()
    feed.push(PATH, 'tool', 'read path="a"', {
        toolCallId: 'call-1',
        nested: true,
    })
    feed.updateLive(PATH, 'thinking', 'considering')
    feed.commitLive(PATH)
    const entries = feed.get(PATH)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.toolCallId, 'call-1')
    assert.equal(entries[0]?.nested, true)
    assert.equal(entries[1]?.kind, 'thinking')
    assert.equal(entries[1]?.live, false)
})

test('duplicate finals stay single and shadow the streamed message', () => {
    const feed = new ActivityFeed()
    feed.push(PATH, 'message', 'the answer')
    feed.push(PATH, 'final', 'the answer')
    feed.push(PATH, 'final', 'the answer')
    const entries = feed.get(PATH)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.kind, 'final')
    assert.equal(entries[0]?.summary, 'the answer')
})

test('truncates long summaries on code point boundaries', () => {
    const feed = new ActivityFeed()
    const long = '\u{10400}'.repeat(MAX_SUMMARY_CHARS + 500)
    feed.push(PATH, 'final', long)
    const summary = feed.get(PATH)[0]!.summary
    assert.equal([...summary].length, MAX_SUMMARY_CHARS)
    assert.equal(summary.length, MAX_SUMMARY_CHARS * 2)
    assert.equal(hasLoneSurrogate(summary), false)
})

test('never splits a surrogate pair at the truncation edge', () => {
    const feed = new ActivityFeed()
    const edge = `${'a'.repeat(MAX_SUMMARY_CHARS - 1)}\u{10400}b`
    feed.push(PATH, 'final', edge)
    const summary = feed.get(PATH)[0]!.summary
    assert.equal([...summary].length, MAX_SUMMARY_CHARS)
    assert.equal(summary.endsWith('\u{10400}'), true)
    assert.equal(hasLoneSurrogate(summary), false)
})

test('short summaries are returned trimmed and unchanged', () => {
    const feed = new ActivityFeed()
    feed.push(PATH, 'message', '  hello  ')
    assert.equal(feed.get(PATH)[0]?.summary, 'hello')
    feed.push(PATH, 'message', '   ')
    assert.equal(feed.get(PATH).length, 1)
})

function hasLoneSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true
            index++
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true
        }
    }
    return false
}
