---
name: explore
description: Use for exploring codebases, searching code, and mapping architecture.
---

## Workflow Differentiation

This skill supports two distinct exploration modes. Choose the appropriate workflow before beginning.

### Workflow A: Understand a Specific Feature
Use when the user asks about a concrete behavior, bug, or capability (e.g., "How does password reset work?").

1. **Identify the trigger**: Search for user-facing strings, route definitions, API endpoints, or event handlers related to the feature.
2. **Trace forward**: Follow the call chain from the trigger through controllers/services/functions to data access or external calls.
3. **Trace backward**: Identify which files depend on or configure the feature (feature flags, middleware, guards).
4. **Map data flow**: Track how data transforms from input to output across the traced path.
5. **Summarize**: Provide the complete file path chain with line numbers and a brief description of each step.

### Workflow B: Map General Architecture
Use when the user asks about the overall structure, tech stack, or how the project is organized (e.g., "What architecture does this project use?").

1. **Detect project type**: Examine config files (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, etc.) to identify language, framework, and build system.
2. **Map directory conventions**: Look for standard patterns (`src/`, `app/`, `lib/`, `packages/`, `internal/`, `cmd/`) but do not assume them. See Gotchas.
3. **Identify entry points**: Find where the application starts. This varies wildly by framework and project structure. See Gotchas.
4. **Identify layers**: Look for directories matching known architecture patterns (see `references/architecture-patterns.md`).
5. **Summarize**: Produce a high-level overview with the detected architecture, key directories, entry points, and major dependencies.

## Discovery Strategy

1. **Map structure**: Use `glob` to identify key directories (`src/`, `lib/`, `tests/`, `config/`, `app/`, `packages/`, `cmd/`)
2. **Search content**: Use `grep` to find specific terms, classes, functions, or patterns
3. **Read for context**: Examine identified files to understand logic and dependencies
4. **Synthesize**: Connect findings across files to provide comprehensive answers

## Automation

For complex or large codebases, use the helper scripts in `scripts/`:
- `scripts/dependency-tree.[ext]`: Generates a project dependency/import tree to visualize module relationships.
- `scripts/structure-summary.[ext]`: Scans the codebase and produces a summary of entry points, main classes, and top-level modules.

## Output Guidelines

- Provide specific file paths and line numbers (e.g., `src/auth/login.ts:42`)
- Summarize findings concisely
- Suggest next investigation steps when further exploration may be needed
- When mapping architecture, explicitly state which pattern was detected and which directories map to which layer
- When tracing a feature, present the call chain as a numbered path from trigger to effect

## Gotchas

- **Monorepos hide entry points**: In monorepos (Turborepo, Nx, Rush, pnpm workspaces), the real application entry points are often under `apps/` or `packages/<name>/`, not a top-level `src/`. Always check the workspace config file (`pnpm-workspace.yaml`, `turbo.json`, `nx.json`) before assuming structure.
- **Frameworks hide real structure**: Next.js, Nuxt, SvelteKit, and Remix use file-system routing. The `app/` or `pages/` directory defines routes, but business logic may live elsewhere. The entry point is often inside the framework's internal server or a `server.ts` file, not `index.js`.
- **Do not assume `main.py` or `index.js` is the entry point**: Python packages may use `__main__.py`, CLI entry points in `pyproject.toml`, or `cmd/` in Go. Node.js apps may use `bin/`, `server.ts`, or framework-specific files. Rust binaries are in `src/main.rs` or `src/bin/`. Verify with build/package configs.
- **Generated code pollutes search results**: Look for `generated/`, `dist/`, `target/`, `.next/`, or `__pycache__/` and exclude them from searches. Respect `.gitignore`.
- **Tests mirror source structure**: `tests/` or `__tests__/` may mirror `src/` exactly. When searching for a feature, prefer source files over test files unless the user asks for test coverage.
- **Configuration as code**: Infrastructure and deployment configs (Terraform, CDK, Docker, Helm) may live in a separate repo or under `infra/`, `deploy/`, `.github/workflows/`. Include them in architecture mapping if relevant.
