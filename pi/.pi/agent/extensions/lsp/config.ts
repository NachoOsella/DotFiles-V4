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
}

export function loadConfig(cwd: string, trusted: boolean): LoadedConfig {
    const path = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)
    const detectedServers = detectAvailableServers()
    const base: LspConfig = {
        enabled: Object.keys(detectedServers).length > 0,
        diagnosticsAfterEdit: true,
        warmOnRead: true,
        servers: detectedServers,
    }

    if (!trusted || !existsSync(path)) return { config: base, path: undefined }

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
                warmOnRead: value.warmOnRead !== false,
                servers,
            },
            path,
        }
    } catch {
        return { config: base, path }
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
        env: isRecord(value.env) ? stringRecord(value.env) : fallback?.env,
        initialization: value.initialization ?? fallback?.initialization,
        disabled: false,
    }
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

function commandAvailable(command: string | undefined): boolean {
    if (!command) return false
    if (isAbsolute(command)) {
        try {
            accessSync(command, constants.X_OK)
            return true
        } catch {
            return false
        }
    }

    const lookup = process.platform === 'win32' ? 'where' : 'which'
    return spawnSync(lookup, [command], { stdio: 'ignore' }).status === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
