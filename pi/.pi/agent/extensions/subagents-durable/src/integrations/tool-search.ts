/**
 * Native tool search.
 *
 * Durable 1.0.0 has no tool exposure or deferred-tool contract. The only
 * supported way to widen the offered set is `ToolControl.addTools`, which
 * appends names to an explicit `pi.agent.tools` array for the next request.
 * When the agent offers every tool (`tools` unset), this tool reports matches
 * without a control, matching Durable's `addTools` no-op.
 *
 * Codemode is intentionally absent: Durable 1.0.0 exposes no nested tool task
 * API, and calling another tool's `execute` directly would bypass durable
 * intent.
 */

import type {
    Extension,
    JsonObject,
    ToolRegistration,
} from '@earendil-works/pi-durable'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { SPAWN_AGENT_TOOL } from '../tools/index.js'

export type ToolSearchMatch = {
    readonly [key: string]: JsonValue
    readonly name: string
    readonly description: string
}

export type ToolSearchDetails = JsonObject & {
    readonly query: string
    readonly matches: readonly ToolSearchMatch[]
    readonly added: readonly string[]
}

const DEFAULT_LIMIT = 8

const parameters = Type.Object(
    {
        query: Type.String({
            minLength: 1,
            description: 'What capability to look for.',
        }),
        limit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: 32,
                description: `Maximum matches (default ${DEFAULT_LIMIT}).`,
            })
        ),
    },
    { additionalProperties: false }
)

const toolSearch = defineTool<typeof parameters, ToolSearchDetails>({
    name: 'tool_search',
    description:
        'Find installed tools by name or description and add matching ones to the next request. ' +
        'Only widens an explicitly selected tool set; when every tool is already offered it only reports matches.',
    parameters,
    execute: async (args, api, context) => {
        const limit = args.limit ?? DEFAULT_LIMIT
        const agent = await api.agent(context)
        const offered = new Set(agent.tools.map((tool) => tool.name))
        // Only tools of the extensions this conversation selected. Searching the
        // whole registry would hand a child tools its agent never selected. Spawn is
        // orchestration-only: when a role or the depth limit removed it, search must
        // not restore it, and the spawn tool guards depth at execution regardless.
        const selected = new Set(
            agent.extensions.map((extension) => extension.name)
        )
        const candidates = api.registry
            .tools()
            .filter(
                ({ extension, tool }) =>
                    selected.has(extension.name) &&
                    !offered.has(tool.name) &&
                    tool.name !== SPAWN_AGENT_TOOL
            )
            .map(({ tool }) => ({
                name: tool.name,
                description: tool.description,
            }))
        const matches = rank(candidates, args.query).slice(0, limit)
        const added = matches
            .filter((match) => !offered.has(match.name))
            .map((match) => match.name)
        const text =
            matches.length === 0
                ? `No installed tools matched ${JSON.stringify(args.query)}.`
                : [
                      `More tools can help with ${JSON.stringify(args.query)}:`,
                      ...matches.map(
                          (match) => `- ${match.name}: ${match.description}`
                      ),
                  ].join('\n')
        return {
            content: [{ type: 'text', text }],
            details: { query: args.query, matches, added },
            ...(added.length === 0 ? {} : { control: { addTools: added } }),
        }
    },
})

/** The `tool_search` extension (`tool-search`). */
export function createToolSearchExtension(): Extension<ToolRegistration> {
    return defineExtension({ name: 'tool-search', tools: [toolSearch] })
}

function rank(
    candidates: readonly ToolSearchMatch[],
    query: string
): ToolSearchMatch[] {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0)
    return candidates
        .map((candidate) => ({ candidate, score: score(candidate, tokens) }))
        .filter(({ score: value }) => value > 0)
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.candidate.name.localeCompare(b.candidate.name)
        )
        .map(({ candidate }) => candidate)
}

function score(candidate: ToolSearchMatch, tokens: readonly string[]): number {
    const name = candidate.name.toLowerCase()
    const description = candidate.description.toLowerCase()
    let total = tokens.includes(name) ? 5 : 0
    for (const token of tokens) {
        if (name.includes(token)) total += 3
        if (name.startsWith(token)) total += 1
        if (description.includes(token)) total += 1
    }
    return total
}

// Re-exported so a host can inspect the registered name without importing the tool.
export const TOOL_SEARCH_NAME = 'tool_search'
