# Pi LSP

This extension provides lazy, project-scoped Language Server Protocol clients for Pi.

LSP enables itself only in trusted projects when a supported server is installed in `PATH`. It does not download servers or invoke a shell. `.pi/lsp.json` is optional and only adds overrides or explicit disable rules.

```json
{
    "enabled": true,
    "diagnosticsAfterEdit": true,
    "warmOnRead": false,
    "idleTimeoutMs": 180000,
    "servers": {
        "typescript": {
            "command": ["typescript-language-server", "--stdio"],
            "extensions": [".ts", ".tsx", ".js", ".jsx"],
            "rootMarkers": ["tsconfig.json", "package.json"]
        }
    }
}
```

Commands:

- `/lsp-status`
- `/lsp-restart [server-id]`
- `/lsp-diagnostics [file]`

The model-facing `lsp` tool supports definitions, references, hover, implementations, document symbols, and workspace symbols. Results default to 20 items and 3,000 characters. Use `offset` and `limit` for additional pages. Source context is omitted by default; request `contextLines` only when the location alone is insufficient.

For `workspaceSymbols`, `filePath` selects the language server and must point to an existing representative source file. Position-based operations use 1-based editor lines and UTF-16 columns.

Clients synchronize files before document queries, cancel timed-out requests, serialize document updates, and close least-recently-used documents after 64 open files. They automatically stop after 60 seconds without an LSP request, edit diagnostic, or warm-up. `warmOnRead` is disabled by default because opening arbitrary files can otherwise keep multiple language servers alive.

When multiple servers support a file, the highest `priority` wins among servers that advertise the requested capability. Root discovery never escapes the current workspace. The automatic registry covers Angular, TypeScript, Java, Python, Rust, Go, C/C++, Lua, Docker, YAML, JSON, HTML, CSS, Bash, PHP, Ruby, Kotlin, Terraform, Zig, Nix, Svelte, and Vue.
