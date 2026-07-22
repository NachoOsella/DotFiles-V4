import { extname } from 'node:path'

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
    '.c': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.css': 'css',
    '.dart': 'dart',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',
    '.go': 'go',
    '.hbs': 'handlebars',
    '.hs': 'haskell',
    '.html': 'html',
    '.java': 'java',
    '.jl': 'julia',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.lua': 'lua',
    '.md': 'markdown',
    '.mjs': 'javascript',
    '.mts': 'typescript',
    '.php': 'php',
    '.pl': 'perl',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.scss': 'scss',
    '.sh': 'shellscript',
    '.sql': 'sql',
    '.svelte': 'svelte',
    '.swift': 'swift',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.vue': 'vue',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.zig': 'zig',
}

export function languageIdForPath(filePath: string): string {
    const fileName = filePath.split(/[\\/]/).at(-1)?.toLowerCase()
    if (fileName === 'dockerfile') return 'dockerfile'
    return LANGUAGE_IDS[extname(filePath).toLowerCase()] ?? 'plaintext'
}
