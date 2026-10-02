# Verification record

## Final checks

The final source snapshot passed these checks on Node.js 26.9.0:

| Check                                                                          | Result                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------ |
| Native package `npm run check`                                                 | Passed                                     |
| Native package `npm test`                                                      | 115 passed, 0 failed, across 26 test files |
| Repeated restart, reporter race, initialization wait and terminal-status tests | 13 passed, 0 failed                        |
| Shared agent `npm run check`                                                   | Passed                                     |
| Shared agent `npm run check:extensions`                                        | Passed                                     |
| Shared agent `npm test`                                                        | 449 passed, 0 failed                       |
| Independent installed-Durable probes                                           | Passed                                     |
| Independent native-host tool workflow with provider capacity 1                 | Passed                                     |
| New package Prettier check and git diff whitespace check                       | Passed                                     |
| README TypeScript example compiled against installed declarations              | Passed                                     |
| Documentation relative links                                                   | Resolved                                   |
| Legacy file checksum comparison with pre-work snapshot                         | Unchanged                                  |

The shared suite does not discover the nested native-package tests. The 449 and 115 counts are separate, not two descriptions of the same run. The repeated 13 tests are a subset, not additional coverage to add to those totals.

## Review findings that changed the implementation

Independent review corrected observable problems, not only test expectations:

- Spawn returns canonical identity and honors explicit model/thinking overrides ahead of role defaults.
- Role capabilities extend inherited tools without removing collaboration, and depth-limited spawn stays unavailable through search.
- Passive messages include the complete envelope and do not start idle or busy child runs.
- Same-answer reporters share the same parent request ID. Nested resumed answers continue upward through direct parents.
- Missing answer entries and broken parent metadata fault explicitly.
- Spawn commits the decided tool response with its intent. Replay does not recompute it from changed host policy.
- Target waits await pending reporter intent before child idle; independently racing idle returned too early.
- Caller cancellation stops observations, not background children or reporters.
- Root collaboration policy is a native prompt section; a full-fork child clears the inherited root section.
- Terminal status uses native generation receipts. Missing assistant partials and many passive writes cannot hide interruption or error.
- Waiting takes priority over running in list output.
- UI acquisition creates no documents, returns hydrated state, and disposes watches. Tool errors retain text and previews avoid split code points.
- Model permits are released before terminal delivery and on abort-after-grant, provider failure and stream termination.
- Crash reopens reinstall the actual extension and tools. Merely recovering the child while the original tool becomes unavailable is not accepted.

Several regression tests were checked by temporarily changing compiled output to reintroduce the defect. They failed, then passed after rebuilding from source. No compiled mutation is part of the repository.

## Persistence boundaries

Actual subprocess SIGKILL tests stop after:

1. The real spawn creation/receipt commit, before initial work proceeds.
2. Child input admission.
3. The persisted report decision.
4. Parent report admission, before the reporter terminal receipt.

A separate SIGKILL replay repeats the real spawn boundary with changed metadata visibility. Reopening verifies the original successful tool result as well as stable identities and one input/report. Grandchild identity, model, thinking, cwd, instructions and capabilities also survive SQLite reopens.

Graceful Harness.close has a separately named test. It cancels live invocations without persisting ordinary abort marks; it does not prove process-death behavior. None of these checks establishes power-loss durability or exactly-once external provider execution.

## Size and remaining work

The source-only production count is 4,926 lines, compared with the legacy baseline of 6,714: 1,788 fewer lines, about 26.6%. The count includes comments, configuration, UI, host support and optional integrations. It excludes test files, `src/testing`, generated output and both discoverable entry points. This is a measurement, not a claim that every legacy CLI feature has been replaced.

There is no custom coordinator, mailbox, scheduler, completion outbox, session residency layer, transcript copier or JSONL usage parser. The remaining mutable process-local mechanisms are the model request semaphore and read-only UI state. Durable owns the persistent execution machinery.

The CLI entry is inert. Stable root integration, actual CLI UI/stats wiring, durable Codemode nesting and old structured/exposure contracts remain unresolved. Terminal receipt scans are linear in generation history. Caller-supplied registries must control foreign MCP capabilities explicitly. See [behavioral parity](BEHAVIORAL_PARITY.md) and [API assumptions](PI_DURABLE_ASSUMPTIONS.md) before any upgrade or cutover.
