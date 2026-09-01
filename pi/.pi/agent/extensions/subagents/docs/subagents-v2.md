# Subagents V2

Subagents are isolated conversational sessions managed by one parent runtime. They share the filesystem with the parent and are not OS-level sandboxes.

## Delegation modes

- **Solo:** the parent does the work itself.
- **Assistant:** one bounded child handles independent research, validation, or review while the parent continues useful work.
- **Orchestrator:** several children handle substantial independent workstreams.

Parallelism alone is not a reason to spawn. The parent remains responsible for verification and integration.

## Lifecycle

An agent can execute multiple runs. Each run has a stable `runId`, status, output, and error. `subagent_interrupt` stops the current run and keeps the session reusable. `subagent_close` stops work and permanently closes the entry. Its result reports `terminal: true` once reuse is impossible and separately reports `resourcesReleased: false` when backend or scope cleanup was incomplete. `subagent_cancel` remains an alias for interrupt. `subagent_wait` has no model-facing timeout: an ID wait remains active until every listed child finishes, fails, is interrupted, or is closed, unless one of the listed children asks a question. A question returns immediately with that event and the still-pending IDs; it does not cancel other work. A mailbox wait remains active until a message arrives.

## Messaging

Normal completion results are delivered as a `followUp` message so they do not interrupt an active parent turn. Normal `subagent_send` calls also queue a follow-up by default; use `steer` only to redirect an active run. Child questions use steering because they require immediate parent attention. Automatic delivery claims events in mailbox sequence order, acknowledges them only after success, and stops at the first failure. Failed and later events remain pending for bounded-backoff retry.

Mailbox overflow produces a visible gap event. A gap means the parent did not receive a complete retained history. Automatic delivery claims an event before awaiting the host sender; explicit waits cannot consume an event while it is claimed. Failed sends release the claim and retry with bounded backoff.

## Roles and tools

- `explorer`: investigation with no built-in edit/write tools.
- `worker`: bounded implementation with the normal coding tools.
- `tester`: validation tools including `bash`, but no built-in edit/write tools. Shell commands can still modify the shared filesystem, so the role prompt forbids source edits.
- `reviewer`: inspection and validation tools including `bash`, but no built-in edit/write tools. Shell commands can still modify the shared filesystem, so the role prompt forbids source edits.

The role tool allowlist is reapplied after extension binding. Child sessions do not receive subagent orchestration tools.

## Configuration

The defaults are `maxRunning = 8` and `maxTracked = 64`. Override them with environment variables:

- `PI_SUBAGENTS_MAX_RUNNING`
- `PI_SUBAGENTS_MAX_TRACKED`
- `PI_SUBAGENTS_<ROLE>_MODEL`
- `PI_SUBAGENTS_<ROLE>_REASONING`
- `PI_SUBAGENTS_<ROLE>_EXTENSION_TOOLS` (comma-separated trusted extension tool names)

`<ROLE>` is `DEFAULT`, `EXPLORER`, `WORKER`, `REVIEWER`, or `TESTER`. Model selection is explicit: the spawn model wins, followed by configured role model, inherited parent model, and finally the Pi SDK default. Reasoning selection is independent: explicit spawn effort, configured role effort, role default, then inherited parent effort. Roles do not infer model quality or rank available models.

The lightweight delegation evals run with a controlled adapter. The optional `test:delegation:behavior` script runs selected scenarios through the real Pi CLI parent setup and intercepts collaboration tool calls without launching children; it may require provider credentials.

## Ownership

Workers may provide `owned_paths`. The manager normalizes these paths and warns about conservative overlaps. Ownership is advisory and does not create filesystem locks or worktrees.

## Delegation evaluations

`delegation-evals.ts` defines small, medium, and parallel scenarios, executes them through an injected model adapter, parses the model's JSON decision, and checks the delegation budget. Run the real Pi CLI adapter with:

```sh
PI_SUBAGENTS_EVAL_MODEL=provider/model npm run test:delegation
```

Use `PI_SUBAGENTS_EVAL_CASES=name1,name2` to run a subset. The evaluator disables tools and extensions so it measures delegation judgment rather than making repository changes. Unit tests use a deterministic adapter; the CLI command is the model-backed evaluation.
