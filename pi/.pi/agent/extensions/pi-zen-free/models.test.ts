import assert from 'node:assert/strict'
import test from 'node:test'
import { BOOTSTRAP_MODELS } from './models.ts'

test('bootstrap catalog contains only the protocol-tested free models', () => {
    assert.deepEqual(
        BOOTSTRAP_MODELS.map((model) => model.id),
        [
            'nemotron-3.5-lightning-free',
            'nemotron-3-ultra-free',
            'big-pickle',
            'mimo-v2.5-free',
            'hy3-free',
        ]
    )
    for (const model of BOOTSTRAP_MODELS) {
        assert.equal(model.provider, 'zen-free')
        assert.equal(model.api, 'openai-completions')
        const compat = model.compat as Record<string, unknown> | undefined
        assert.deepEqual(
            {
                supportsStore: compat?.supportsStore,
                supportsDeveloperRole: compat?.supportsDeveloperRole,
                maxTokensField: compat?.maxTokensField,
            },
            {
                supportsStore: false,
                supportsDeveloperRole: false,
                maxTokensField: 'max_tokens',
            }
        )
    }
})
