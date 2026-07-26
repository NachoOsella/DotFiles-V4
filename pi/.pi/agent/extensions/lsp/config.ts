import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import type { LspConfig, ServerConfig } from './types.ts'

const CONFIG_FILE = 'lsp.json'

const DEFAULT_SERVERS: Readonly<Record<string, ServerConfig>> = {
    angular: {
        command: ['ngserver', '--stdio'],
        extensions: ['.ts', '.tsx', '.html'],
        rootMarkers: ['angular.json', 'project.json'],
        requiresRootMarker: true,
        priority: 50,
    },
    typescript: {
        command: ['typescript-language-server', '--stdio'],
        extensions: [
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '.mjs',
            '.cjs',
            '.mts',
            '.cts',
        ],
        rootMarkers: ['tsconfig.json', 'package.json'],
        priority: 100,
    },
    jdtls: {
        command: ['jdtls'],
        extensions: ['.java'],
        rootMarkers: [
            'pom.xml',
            'build.gradle',
            'build.gradle.kts',
            'settings.gradle',
            'settings.gradle.kts',
        ],
    },
    python: {
        command: ['pyright-langserver', '--stdio'],
        extensions: ['.py', '.pyi'],
        rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    },
    rust: {
        command: ['rust-analyzer'],
        extensions: ['.rs'],
        rootMarkers: ['Cargo.toml'],
    },
    go: {
        command: ['gopls'],
        extensions: ['.go'],
        rootMarkers: ['go.mod', 'go.work'],
    },
    cpp: {
        command: ['clangd'],
        extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx'],
        rootMarkers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'],
    },
    lua: {
        command: ['lua-language-server'],
        extensions: ['.lua'],
        rootMarkers: ['.luarc.json', '.luacheckrc', '.git'],
    },
    docker: {
        command: ['docker-langserver', '--stdio'],
        extensions: [
            'Dockerfile',
            '.dockerfile',
            'docker-compose.yml',
            'docker-compose.yaml',
        ],
        rootMarkers: [
            'Dockerfile',
            'docker-compose.yml',
            'docker-compose.yaml',
        ],
    },
    yaml: {
        command: ['yaml-language-server', '--stdio'],
        extensions: ['.yaml', '.yml'],
        rootMarkers: ['.yamllint', 'docker-compose.yml', 'package.json'],
    },
    json: {
        command: ['vscode-json-language-server', '--stdio'],
        extensions: ['.json', '.jsonc'],
        rootMarkers: ['package.json', 'tsconfig.json'],
    },
    html: {
        command: ['vscode-html-language-server', '--stdio'],
        extensions: ['.html', '.htm'],
        rootMarkers: ['package.json', 'index.html'],
    },
    css: {
        command: ['vscode-css-language-server', '--stdio'],
        extensions: ['.css', '.scss', '.less'],
        rootMarkers: ['package.json'],
    },
    bash: {
        command: ['bash-language-server', 'start'],
        extensions: ['.sh', '.bash', '.zsh'],
        rootMarkers: ['.git', 'package.json'],
    },
    php: {
        command: ['intelephense', '--stdio'],
        extensions: ['.php'],
        rootMarkers: ['composer.json'],
    },
    ruby: {
        command: ['ruby-lsp'],
        extensions: ['.rb', '.rake', '.gemspec'],
        rootMarkers: ['Gemfile', '.ruby-version'],
    },
    kotlin: {
        command: ['kotlin-language-server'],
        extensions: ['.kt', '.kts'],
        rootMarkers: ['build.gradle', 'build.gradle.kts', 'pom.xml'],
    },
    terraform: {
        command: ['terraform-ls', 'serve'],
        extensions: ['.tf', '.tfvars'],
        rootMarkers: ['.terraform', 'main.tf'],
    },
    zig: {
        command: ['zls'],
        extensions: ['.zig', '.zon'],
        rootMarkers: ['build.zig', 'build.zig.zon'],
    },
    nix: {
        command: ['nixd'],
        extensions: ['.nix'],
        rootMarkers: ['flake.nix', 'shell.nix'],
    },
    svelte: {
        command: ['svelteserver', '--stdio'],
        extensions: ['.svelte'],
        rootMarkers: ['package.json', 'svelte.config.js'],
    },
    vue: {
        command: ['vue-language-server', '--stdio'],
        extensions: ['.vue'],
        rootMarkers: ['package.json', 'vue.config.js', 'vite.config.ts'],
    },
}

export interface LoadedConfig {
    readonly config: LspConfig
    readonly path: string | undefined
    readonly error?: string
}

export function loadConfig(cwd: string, trusted: boolean): LoadedConfig {
    const path = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)
    const detectedServers = detectAvailableServers()
    const base: LspConfig = {
        enabled: Object.keys(detectedServers).length > 0,
        diagnosticsAfterEdit: true,
        // Reads are frequent and should not leave a server running for every
        // incidental file type. Servers still start on explicit LSP requests
        // and post-edit diagnostics.
        warmOnRead: false,
        idleTimeoutMs: 180_000,
        servers: detectedServers,
    }

    if (!trusted) {
        return {
            config: { ...base, enabled: false },
            path: undefined,
            error: 'Project is not trusted; LSP process execution is disabled.',
        }
    }
    if (!existsSync(path)) return { config: base, path: undefined }

    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (!isRecord(value)) return { config: base, path }

        const servers = { ...detectedServers }
        if (isRecord(value.servers)) {
            for (const [id, raw] of Object.entries(value.servers)) {
                if (isRecord(raw) && raw.disabled === true) {
                    delete servers[id]
                    continue
                }
                const server = parseServer(raw, servers[id])
                if (server) servers[id] = server
            }
        }

        return {
            config: {
                enabled:
                    value.enabled !== false && Object.keys(servers).length > 0,
                diagnosticsAfterEdit: value.diagnosticsAfterEdit !== false,
                warmOnRead: value.warmOnRead === true,
                idleTimeoutMs: positiveInteger(value.idleTimeoutMs) ?? 180_000,
                servers,
            },
            path,
        }
    } catch (error) {
        return {
            config: base,
            path,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

function parseServer(
    value: unknown,
    fallback: ServerConfig | undefined
): ServerConfig | undefined {
    if (!isRecord(value)) return fallback
    if (value.disabled === true) return undefined
    const command = stringArray(value.command) ?? fallback?.command
    if (!command || command.length === 0) return undefined
    return {
        command,
        extensions: stringArray(value.extensions) ?? fallback?.extensions ?? [],
        rootMarkers:
            stringArray(value.rootMarkers) ?? fallback?.rootMarkers ?? [],
        requiresRootMarker:
            typeof value.requiresRootMarker === 'boolean'
                ? value.requiresRootMarker
                : fallback?.requiresRootMarker,
        priority: positiveInteger(value.priority) ?? fallback?.priority,
        env: isRecord(value.env) ? stringRecord(value.env) : fallback?.env,
        initialization: value.initialization ?? fallback?.initialization,
        disabled: false,
    }
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
        ? value
        : undefined
}

function stringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? value
        : undefined
}

function stringRecord(
    value: Record<string, unknown>
): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
    )
}

function detectAvailableServers(): Readonly<Record<string, ServerConfig>> {
    return Object.fromEntries(
        Object.entries(DEFAULT_SERVERS).filter(([, server]) =>
            commandAvailable(server.command[0])
        )
    )
}

const commandAvailability = new Map<string, boolean>()

function commandAvailable(command: string | undefined): boolean {
    if (!command) return false
    const cacheKey = `${process.platform}:${process.env.PATH ?? ''}:${command}`
    const cached = commandAvailability.get(cacheKey)
    if (cached !== undefined) return cached
    if (isAbsolute(command)) {
        try {
            accessSync(command, constants.X_OK)
            commandAvailability.set(cacheKey, true)
            return true
        } catch {
            commandAvailability.set(cacheKey, false)
            return false
        }
    }

    const lookup = process.platform === 'win32' ? 'where' : 'which'
    const available =
        spawnSync(lookup, [command], { stdio: 'ignore' }).status === 0
    commandAvailability.set(cacheKey, available)
    return available
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
