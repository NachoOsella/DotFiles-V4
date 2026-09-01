# Subagents V2

Subagents are isolated conversational sessions managed by one parent runtime. They share the filesystem with the parent and are not OS-level sandboxes.

## Delegation modes

- **Solo:** the parent does the work itself.
- **Assistant:** one bounded child handles independent research, validation, or review while the parent continues useful work.
- **Orchestrator:** several children handle substantial independent workstreams.

Parallelism alone is not a reason to spawn. The parent remains responsible for verification and integration.

## Lifecycle

An agent can execute multiple runs. Each run has a stable `runId`, status, output, and error. `subagent_interrupt` stops the current run and keeps the session reusable. `subagent_close` stops work, releases the backend scope, and permanently closes the entry. Its result reports `closed: false` when a backend or scope close fails or times out. `subagent_cancel` remains an alias for interrupt. `subagent_wait` has no model-facing timeout: an ID wait remains active until every listed child finishes or fails; a mailbox wait remains active until a message arrives.

## Messaging

Normal completion results are delivered as a `followUp` message so they do not interrupt an active parent turn. Normal `subagent_send` calls also queue a follow-up by default; use `steer` only to redirect an active run. Child questions use steering because they require immediate parent attention. Delivery uses peek, send, and acknowledge; failed delivery leaves the event pending for a later retry.

Mailbox overflow produces a visible gap event. A gap means the parent did not receive a complete retained history.

## Roles and tools

- `explorer`: read-only investigation.
- `worker`: bounded implementation with the normal coding tools.
- `tester`: validation tools including `bash`, but no write tools.
- `reviewer`: inspection and validation tools including `bash`, but no write tools.

The role tool allowlist is reapplied after extension binding. Child sessions do not receive subagent orchestration tools.

## Configuration

The defaults are `maxRunning = 8` and `maxTracked = 64`. Override them with environment variables:

- `PI_SUBAGENTS_MAX_RUNNING`
- `PI_SUBAGENTS_MAX_TRACKED`
- `PI_SUBAGENTS_<ROLE>_MODEL`
- `PI_SUBAGENTS_<ROLE>_REASONING`

`<ROLE>` is `DEFAULT`, `EXPLORER`, `WORKER`, `REVIEWER`, or `TESTER`. Explicit spawn model and reasoning values take precedence over role configuration, followed by role defaults and inherited parent values. Explorer and tester use the lowest-cost available model; worker and reviewer use the capability-ranked available model when no model is configured.

## Ownership

Workers may provide `owned_paths`. The manager normalizes these paths and warns about conservative overlaps. Ownership is advisory and does not create filesystem locks or worktrees.

## Delegation evaluations

`delegation-evals.ts` defines small, medium, and parallel scenarios, executes them through an injected model adapter, parses the model's JSON decision, and checks the delegation budget. Run the real Pi CLI adapter with:

```sh
PI_SUBAGENTS_EVAL_MODEL=provider/model npm run test:delegation
```

Use `PI_SUBAGENTS_EVAL_CASES=name1,name2` to run a subset. The evaluator disables tools and extensions so it measures delegation judgment rather than making repository changes. Unit tests use a deterministic adapter; the CLI command is the model-backed evaluation.
