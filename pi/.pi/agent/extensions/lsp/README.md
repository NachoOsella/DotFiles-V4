# Pi LSP

This extension provides lazy, project-scoped Language Server Protocol clients for Pi.

LSP automatically enables itself in trusted projects when a supported server is installed in `PATH`.
The extension does not download servers or invoke a shell; `.pi/lsp.json` is optional and only adds overrides or explicit disable rules.

Optional configuration example:

```json
{
    "enabled": true,
    "diagnosticsAfterEdit": true,
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

The automatic registry covers Angular, TypeScript, Java, Python, Rust, Go, C/C++, Lua, Docker, YAML, JSON, HTML, CSS, Bash, PHP, Ruby, Kotlin, Terraform, Zig, Nix, Svelte, and Vue. The model-facing `lsp` tool supports definitions, references, hover, implementations, document symbols, and workspace symbols.
