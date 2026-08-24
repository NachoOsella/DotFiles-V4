export const LSP_TOOL_DESCRIPTION =
    'Query language servers for semantic navigation. Results are compact and paginated to protect context. Position-based operations require 1-based line and UTF-16 character offsets. workspaceSymbols uses filePath only to select the language server.'

export const LSP_PROMPT_SNIPPET =
    'Query language servers for compact semantic code navigation'

export const LSP_PARAMETER_DESCRIPTIONS = {
    operation: 'Language-server operation to perform.',
    filePath:
        'Absolute or workspace-relative existing file. One leading @ is normalized. For workspaceSymbols, use a representative file for the target language.',
    line: 'Required for definition, references, hover, and implementation. 1-based editor line.',
    character:
        'Required for definition, references, hover, and implementation. 1-based UTF-16 editor column.',
    query: 'Required search text for workspaceSymbols.',
    limit: 'Maximum results to return. Defaults to 20; maximum 50.',
    offset: 'Zero-based result offset for pagination. Defaults to 0.',
    contextLines:
        'Source lines around navigation results. Defaults to 0 for token efficiency; maximum 3.',
}
