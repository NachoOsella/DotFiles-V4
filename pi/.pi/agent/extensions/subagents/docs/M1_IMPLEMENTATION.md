# M1 implementation

M1 implements the compatible correctness work in `IMPLEMENTATION_PLAN.md`.
It does not complete all 21 recommendations in `HARNESS_REVIEW.md`.

Three implementation workers owned separate files for sessions/context,
delivery/residency, and contracts/policy. Root integrated lifecycle hooks and
configuration. A fourth worker reviewed the changes without editing them.
No dependencies were installed, shared dependency versions changed, or commits
created. No live provider was called for verification.

## Host requirement

The user approved requiring Pi >=1.4.0 <2.0.0 after native tests demonstrated
that Pi 1.0 starts an idle custom-message turn without preparing its system
instructions. This affects the first child task, especially `fork_turns=none`.
The extension now checks `VERSION` before registering tools and reports a
diagnostic on an unsupported host. Its peer dependency declares `^1.4.0`.

The shared workspace still contains Pi 1.0. Its structural tests and explicit
host characterization remain useful, but native entry tests skip that host.
The installed CLI uses Pi 1.4. Supplemental tests use temporary Node resolution
hooks for the Pi packages, not a dependency installation or a full CLI trial.

## Implemented behavior

- The resource loader and child session share one settings manager and agent
  directory on create and reopen.
- Logical turns are grouped before communication filtering. Inherited task
  context retains provenance without replaying an active control envelope.
- Fork import uses native compaction and branch-summary operations with child
  entry references. Imported assistant usage remains zero.
- Root delivery persists completion intent before dispatch and reconciles stable
  communication IDs against recipient transcripts. A dispatch return value is
  never an insertion receipt. A receipt is not proof of model processing.
- Critical intent, receipt, and retry checkpoints propagate persistence failures.
  A failed receipt checkpoint preserves newer concurrent outbox entries.
- Runtime leases prevent eviction of a session owned by an operation. Execution
  admission happens before expensive child initialization.
- Tree navigation replaces branch membership instead of merging graphs. Old
  generations cannot deliver or checkpoint into the selected branch.
- Shutdown attempts every disposal and records final usage/outbox before root
  retirement. Preliminary checkpoint failure cannot skip shutdown. A failed final
  checkpoint retains the fenced graph for another retirement attempt.
- Optional role allow/deny lists preserve legacy additive tools. Deny wins and
  also filters injected collaboration tools. These are tool filters, not an OS
  sandbox or a trusted-extension isolation policy.
- Successful results are nonempty and bounded. Truncated results carry a child
  transcript reference when available. Finalized assistant text is captured
  before later projection changes.
- Root prompt sections compose with neighboring extensions. Prompts describe
  effective depth, owned files, bounded briefs, evidence, and result provenance.
- Explicit malformed configuration disables subagents with a diagnostic.
  Environment counts require full integers; zero depth is valid. Explicit JSON
  and files accept raw configuration or a `subagents` section.
- Identical graph checkpoints are suppressed. Critical delivery checkpoints
  remain ordered and immediate.

## Audit disposition

"Implemented" below refers to the concrete M1 behavior, not every proposed
acceptance scenario or future capability in the audit.

| Finding | M1 disposition | Remaining work |
| --- | --- | --- |
| 1. Shared child settings | Implemented | Parent model-runtime sharing remains an explicit future policy, not an assumption |
| 2. Recipient insertion receipts | Implemented with host limits | Native void dispatch without insertion or a later boundary needs explicit reconciliation; no exactly-once claim |
| 3. Nested last-N forks | Implemented | A turn count is still not a token budget |
| 4. Summary import | Implemented | Tests use native append/projection operations, not provider-driven compaction |
| 5. Branch ownership | Implemented | Full CLI switch/fork/resume scenarios remain additional coverage |
| 6. Shutdown persistence barrier | Implemented, partially bounded | Deadline/timeout for an uncooperative provider or finalizer is M2 |
| 7. Runtime leases | Implemented | Broader completion-under-eviction stress testing remains useful |
| 8. Budgets and deadlines | Deferred | M2 |
| 9. Restrictive role capabilities | Partially implemented | Opt-in tool policy is present; parent authority and OS isolation are separate work |
| 10. Child extension profile | Partially implemented | Loader diagnostics are visible; extension allow/deny profiles and resource benchmarks are M2 |
| 11. Task and native-run identities | Deferred | M3 versioned task receipts and assignment policy |
| 12. Identity archival | Deferred | M3; completed agents still count toward the identity quota |
| 13. Cheap admission | Partially implemented | Reservation ordering is fixed; structured capacity errors and recovery guidance are M2 |
| 14. Cold-resume validation | Partially implemented | Unknown bound callers fail closed; policy revisions, canonical file ownership, and blocked-state recovery are M2 |
| 15. Bounded useful results | Partially implemented | Nonempty bounded summaries and transcript references exist; configurable budgets and validated artifact records are deferred |
| 16. Brief/result contract | Implemented as prompt guidance | A validated task/result record belongs to M3 |
| 17. Capability-aware prompt composition | Partially implemented | Single contract and structured sections exist; default delegation mode remains unchanged |
| 18. Envelope provenance | Deferred | Control metadata stays authoritative; canonical model-visible envelope changes are M3 |
| 19. Deliberate context/recovery | Deferred beyond last-N repair | Model-window budgets and compact team/task summaries are M2/M3 |
| 20. Checkpoint amplification | Partially implemented | Unchanged snapshots are suppressed; payload deduplication, coalescing, migration, and byte benchmarks remain |
| 21. Diagnostics/configuration | Partially implemented | Explicit config failures and typed abort classification are fixed; resolved source reports, structured failure taxonomy, and wait/mail semantics remain |

## Verification scope

Focused regressions cover native root void-dispatch failure, insertion before
model completion, queued steering inserted once through a continuation, branch
membership replacement, failed pre/final checkpoints followed by retry,
concurrent receipt rollback, disposal failure, tight residency pressure, child
settings/reopen, nested fork grouping, summary import, role policy, and result
schemas. Native streams run in process without contacting providers.

The independent review found and prompted fixes for concurrent acknowledgment
rollback, disposal cleanup, failed-retirement retention, and a preliminary
checkpoint that could otherwise skip shutdown. It also confirmed the Pi 1.0
prompt-preparation defect that motivated the supported-host decision.

Run from `~/.pi/agent`:

```sh
npm run check
npm run check:extensions
npm run test:subagents
npm test -- --test-concurrency=1
```

This session used an existing cached TypeScript binary through `PATH` because
the workspace's executable link was absent. Prettier also ran from its existing
cache with the repository's four-space, single-quote, no-semicolon style.
Final test counts and evidence paths are in the implementation plan ledger.

## Remaining limits

Pi custom messages become user-role model context. Prompt guidance cannot make
that a typed security channel. Tool filtering cannot prevent a trusted extension
or an unrestricted shell from writing files.

A provider that ignores cancellation can still delay shutdown indefinitely.
Storage failure at process exit can prevent persistence even though all child
cleanup is attempted. Receipt reconciliation does not guarantee model processing,
exactly-once delivery, or recovery without an insertion probe and a safe retry
boundary.

The coordinator retains both legacy adapter behavior and receipt-enabled
production delivery. Production root wiring always enables receipts; future
internal extraction should preserve that distinction rather than add another
scheduler. Snapshot version 2, the six tools, native queues, depth limits,
environment variables, default fork behavior, and default delegation mode remain
unchanged. M2 and M3 are not implemented by this milestone.
