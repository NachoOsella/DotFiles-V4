import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildBehaviorEvalArgs,
    buildBehaviorEvalPrompt,
} from './src/delegation-behavior-eval.ts'
import { DELEGATION_EVALS, hasImmediateWait } from './delegation-evals.ts'

const scenario = DELEGATION_EVALS[0]
if (!scenario) throw new Error('delegation eval scenarios are empty')

test('behavioral eval disables extension discovery but loads its interceptor', () => {
    const args = buildBehaviorEvalArgs(
        { model: 'provider/model' },
        'evaluation prompt'
    )
    assert.equal(args.filter((arg) => arg === '--no-extensions').length, 1)
    assert.equal(args.filter((arg) => arg === '--extension').length, 1)
    const extensionIndex = args.indexOf('--extension')
    assert.ok(extensionIndex >= 0)
    assert.match(
        args[extensionIndex + 1] ?? '',
        /delegation-behavior-tools\.ts$/
    )
    assert.equal(args.includes('--append-system-prompt'), false)
})

test('behavioral eval keeps the scenario prompt neutral', () => {
    const prompt = buildBehaviorEvalPrompt(scenario)
    assert.match(prompt, /Use the available collaboration tools normally/)
    assert.match(prompt, /Tool calls are intercepted/)
    assert.doesNotMatch(prompt, /Default to doing the work yourself/)
})

test('immediate waits are detected after every spawn', () => {
    assert.equal(
        hasImmediateWait([
            { name: 'subagent_spawn' },
            { name: 'subagent_wait' },
        ]),
        true
    )
    assert.equal(
        hasImmediateWait([
            { name: 'subagent_spawn' },
            { name: 'subagent_wait' },
            { name: 'subagent_spawn' },
        ]),
        true
    )
    assert.equal(
        hasImmediateWait([
            { name: 'subagent_spawn' },
            { name: 'read' },
            { name: 'subagent_wait' },
        ]),
        false
    )
})
