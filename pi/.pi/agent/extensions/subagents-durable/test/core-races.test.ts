/**
 * Concurrent spawn races.
 *
 * Two tool calls in one assistant round run as parallel Durable tool tasks.
 * The creating commit serializes them, so duplicate names and logical capacity
 * are decided atomically rather than by a pre-check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import {
    configureRoot,
    createCoreHarness,
    lastUserText,
    until,
} from './support.js'

type RequestContext = Parameters<FauxResponseFactory>[0]

function route(
    onFirst: () => ReturnType<typeof fauxAssistantMessage>
): FauxResponseFactory {
    return (request: RequestContext) => {
        const text = lastUserText(request.messages)
        if (text.includes('race now')) return onFirst()
        return fauxAssistantMessage('agent done')
    }
}

async function runRace(
    config: SubagentsConfig,
    prompt: string,
    first: () => ReturnType<typeof fauxAssistantMessage>
): Promise<{ count: number; errors: number }> {
    const th = await createCoreHarness(config)
    try {
        const root = await configureRoot(th)
        th.faux!.setResponses(Array.from({ length: 20 }, () => route(first)))
        const submission = await root.submit(
            { type: 'input', content: prompt },
            th.context
        )
        await submission.wait(th.context)
        await until(async () => {
            const messages = (await root.context(th.context)).messages
            return (
                messages.filter(
                    (message) =>
                        message.role === 'toolResult' &&
                        message.isError === true
                ).length >= 1
            )
        })
        const state = await th.harness.snapshot(SubagentsDoc, th.context)
        const messages = (await root.context(th.context)).messages
        return {
            count: Object.keys(state?.agents ?? {}).length,
            errors: messages.filter(
                (message) =>
                    message.role === 'toolResult' && message.isError === true
            ).length,
        }
    } finally {
        await th.harness.close(th.context)
    }
}

test('two simultaneous spawns with one name create exactly one agent', async () => {
    const result = await runRace(DEFAULT_CONFIG, 'race now', () =>
        fauxAssistantMessage(
            [
                fauxToolCall(
                    'spawn_agent',
                    { task_name: 'same', message: 'one' },
                    { id: 'a' }
                ),
                fauxToolCall(
                    'spawn_agent',
                    { task_name: 'same', message: 'two' },
                    { id: 'b' }
                ),
            ],
            { stopReason: 'toolUse' }
        )
    )
    assert.equal(result.count, 1)
    assert.ok(result.errors >= 1, 'the losing spawn must fail')
})

test('two simultaneous spawns cannot exceed logical capacity', async () => {
    const result = await runRace(
        { ...DEFAULT_CONFIG, maxAgents: 1 },
        'race now',
        () =>
            fauxAssistantMessage(
                [
                    fauxToolCall(
                        'spawn_agent',
                        { task_name: 'first', message: 'one' },
                        { id: 'a' }
                    ),
                    fauxToolCall(
                        'spawn_agent',
                        { task_name: 'second', message: 'two' },
                        { id: 'b' }
                    ),
                ],
                { stopReason: 'toolUse' }
            )
    )
    assert.equal(result.count, 1)
    assert.ok(result.errors >= 1, 'the spawn over capacity must fail')
})
