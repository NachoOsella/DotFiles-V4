import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { LSP_PARAMETER_DESCRIPTIONS } from './prompt.ts'

export const LspParameters = Type.Object({
    operation: StringEnum(
        [
            'definition',
            'references',
            'hover',
            'documentSymbols',
            'workspaceSymbols',
            'implementation',
        ] as const,
        { description: LSP_PARAMETER_DESCRIPTIONS.operation }
    ),
    filePath: Type.String({ description: LSP_PARAMETER_DESCRIPTIONS.filePath }),
    line: Type.Optional(
        Type.Integer({
            minimum: 1,
            description: LSP_PARAMETER_DESCRIPTIONS.line,
        })
    ),
    character: Type.Optional(
        Type.Integer({
            minimum: 1,
            description: LSP_PARAMETER_DESCRIPTIONS.character,
        })
    ),
    query: Type.Optional(
        Type.String({ description: LSP_PARAMETER_DESCRIPTIONS.query })
    ),
    limit: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: 50,
            description: LSP_PARAMETER_DESCRIPTIONS.limit,
        })
    ),
    offset: Type.Optional(
        Type.Integer({
            minimum: 0,
            description: LSP_PARAMETER_DESCRIPTIONS.offset,
        })
    ),
    contextLines: Type.Optional(
        Type.Integer({
            minimum: 0,
            maximum: 3,
            description: LSP_PARAMETER_DESCRIPTIONS.contextLines,
        })
    ),
})
