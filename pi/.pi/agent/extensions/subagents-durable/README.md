# Durable subagents

A separate Durable-native implementation of the six subagent collaboration tools. Conversations, ownership, submissions, checkpoints, forks and usage belong to `@earendil-works/pi-durable`, not an application coordinator.

> [!IMPORTANT]
> This extension is disabled in the Pi CLI. Its discoverable `index.ts` is a no-op, regardless of settings. Keep using `../subagents`. Do not enable or remove the old extension until Durable reaches the CLI through a stable root/Harness integration.

The package targets published `pi-durable@1.0.0`, which is experimental. The installed `pi-coding-agent@1.0.0` still owns its root through legacy AgentSession. It does not expose the transactional Durable root required here. There is no legacy adapter or weaker delivery bridge.

## What is implemented

- Canonical nested identities, roles, native configuration inheritance and root/child delegation policy.
- `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent` and `list_agents`.
- Idle passive messages, busy steering, explicit queued follow-ups, cancellation-safe waits and recoverable interruption.
- Background ownership and direct-parent reports, including resumed nested parents. Several steers settling to one answer produce one report.
- SQLite restart, stable operation receipts and native fresh/full/recent-turn forks.
- Native per-conversation and aggregate usage. No JSONL accounting or inherited-spend subtraction.
- A read-only inspector with tree, activity, terminal status, completion previews and usage. No CLI command, dashboard, footer or stats registration yet.
- Optional native coding tools and capability-limited tool search. No MCP adapter is installed.

See [behavioral parity](docs/BEHAVIORAL_PARITY.md) for the evidence and intentional changes, [architecture](docs/ARCHITECTURE.md) for ownership and reporting, and the [verification record](docs/VERIFICATION.md) for final checks and review findings.

## Development

Install shared dependencies from the agent directory only. Do not run npm install inside this extension or create a per-extension node_modules. The new package is deliberately not a workspace.

```sh
cd ~/.pi/agent
npm install
npm run check
npm run check:extensions

cd extensions/subagents-durable
npm run check
npm test
```

Durable requires Node.js 22.19 or newer. Verification used Node.js 26.9.0. Tests compile TypeScript to the ignored `.build` directory, then use real Harness instances, native memory/SQLite storage and scripted faux model responses. They require no provider credentials.

The crash suite kills actual subprocesses after four distinct persisted boundaries. Graceful close/reopen has its own test and is not called a crash. Other tests cover concurrent spawns, a held tool round, reporter deduplication, cancellation, compaction, usage and UI subscriptions.

## Native-host API

For integration tests and future native hosts only. This is not a CLI activation recipe. A host supplies an already configured Models collection and owns its storage and execution environment.

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { decodeConfig } from './src/config/config.js'
import { openSubagentsHarness } from './src/host.js'

export async function runExample(models: Models, model: ModelRef) {
    const context = BACKGROUND_CONTEXT
    const host = await openSubagentsHarness(
        {
            models,
            hostId: 'example-host',
            config: decodeConfig({ maxConcurrentExecutions: 2 }),
            onReport: console.error,
        },
        context
    )
    try {
        const root = await host.harness.root(context)
        await root.configure(
            {
                model,
                cwd: process.cwd(),
                extensions: host.registry
                    .snapshot()
                    .installed()
                    .filter((extension) =>
                        [
                            'subagents-durable',
                            'coding-tools',
                            'tool-search',
                        ].includes(extension.name)
                    ),
            },
            context
        )
        const input = await root.submit(
            {
                type: 'input',
                content:
                    'Delegate a bounded review to a child and compare its result.',
            },
            context
        )
        return await input.wait(context)
    } finally {
        await host.close(context)
    }
}
```

Source imports use `.js` for emitted ESM. After building, the corresponding host entry is `.build/src/host.js`.

`openSubagentsHarness` needs `hostId`, `storagePath`, or supplied storage. The default file is `~/.pi/agent/subagents-durable/<hostId>.sqlite`. Use a stable safe filename segment for hostId. Never open the same SQLite database from concurrent hosts. Reopen with the same definitions and compatible configuration. There is no migration from old session files. Closing leaves unfinished Durable checkpoints resumable; it is not a durable abort.

A host with its own Harness can install `createSubagentsExtension` from `src/extension.ts` instead. It must supply `submitWrite` by delegating to public `Conversation.submit({ type: 'write', ... })`, initialize `SubagentsDoc`, and install task definitions before resuming. Do not replace that function with a mailbox or custom admission loop.

## Configuration

`decodeConfig` validates supported settings. The host helper uses environment configuration by default. To reuse parsed CLI settings or a settings file, pass `config: loadConfig({ settings })` or `loadConfig({ settingsPath })` from `src/config/load.ts` explicitly.

| Setting                   | Default | Meaning                                                 |
| ------------------------- | ------- | ------------------------------------------------------- |
| `maxAgents`               | 6       | Logical non-root identities, including completed agents |
| `maxConcurrentExecutions` | 4       | Concurrent provider operations, including root          |
| `maxDepth`                | 1       | Direct child depth 0, grandchild depth 1                |
| `waitAgentEnabled`        | true    | Register wait_agent in a native host                    |
| `wait.defaultTimeoutMs`   | 30000   | Invocation deadline, clamped to configured bounds       |
| `mode`                    | auto    | Explicit delegation unless thinking reaches proactiveAt |
| `proactiveAt`             | max     | Auto-mode threshold                                     |
| `roles`                   | empty   | Role model, thinking, tools and prompt additions        |

`enabled:false` removes native tools and prompt sections, but retains task definitions for previously admitted work. It never activates the inert CLI entry.

Tools and waits do not hold provider capacity. This differs deliberately from the old whole-run execution limit. Role tools add allowed inherited capabilities; they do not remove collaboration. Depth limits remove spawn, and tool search cannot restore it. A caller-supplied registry must explicitly select its allowed extensions. Native tool metadata cannot identify arbitrary foreign MCP provenance.

## Remaining gaps

- Stable CLI root adoption, live `/agents`, dashboard, footer and `/stats` integration.
- Public durable nested-tool execution for Codemode. Calling another tool's execute method directly would bypass durable intent and is not an acceptable substitute.
- The old outputSchema, structuredContent, exposure and namespace contracts. Native text/details results are not equivalent.
- Ascending native task scans make terminal status lookup linear in generation history. No private SQL query or persisted lifecycle cache is added.

Inspector totals cover registered subagents. Use `Harness.usage()` for root-plus-child totals and model grouping. Route `onReport` to your host diagnostics for infrastructure faults; failed reporter tasks remain native task receipts, not a second notification queue.

Exactly-once reporting means one durable parent input and one placed envelope per answer. It does not mean exactly-once provider execution across process death or persistence against power loss. Explicit parent abort may withdraw queued reports, just as it withdraws other Durable inputs.

Review [API assumptions](docs/PI_DURABLE_ASSUMPTIONS.md) before upgrading or considering a cutover. Shared Effect dependencies remain pinned; this package does not use Effect and does not upgrade unrelated extensions.
