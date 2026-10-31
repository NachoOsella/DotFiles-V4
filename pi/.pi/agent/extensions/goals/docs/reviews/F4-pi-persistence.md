# F4 - Adversarial review: Pi integration and persistence

Scope: the Pi boundary/persistence/state layers of `pi-goals`, not the domain logic or prompt text.
Nothing in this review was written by me; every claim below is a check against the code in this tree
and against the installed Pi runtime.

## Audit baseline

Code was being edited while this review ran (`src/runtime.ts` at 17:16:23, `src/services/goal-controller.ts`
and `src/domain/transitions.ts` at 17:13:28, `docs/ARCHITECTURE.md` at 17:16:51). All findings below were
re-verified against the tree as of the md5 snapshot in `/tmp/goals-hashes.txt`:

```
b27aadc059df3ef10e3f7221b29b8d34  src/runtime.ts
e8adc454343301d1667595d3d5b7b9a4  src/adapters/pi-events.ts
e550e6233797949f821e3f2aa32ea223  src/services/goal-controller.ts
1fd86ad5d831de796ee3153edc025ff7  src/domain/transitions.ts
85a237150abdde784355824ca00bf5cb  src/services/usage-accounting.ts
4c5dad2aa4f849418a2a34b978f1e799  src/services/goal-repository.ts
5a9d59ade9869b14be103f0e81bfc548  src/services/progress-tracker.ts
75a21b6d47234939997f24c0db00d3c1  src/adapters/directive.ts
```

Pi ground truth: runtime `1.4.0` at `/home/nacho/.local/lib/node_modules/@earendil-works/pi-coding-agent`
(`dist/core/agent-session.js`, `dist/core/session-manager.js`, `dist/core/extensions/runner.js`,
`dist/core/extensions/types.d.ts`). Workspace typings resolved by `tsc`: **1.0.0** at
`~/.pi/agent/node_modules/@earendil-works/pi-coding-agent` (that is what `preserveSymlinks` +
parent lookup selects; its `types.d.ts` has no `AgentSettledEvent.aborted`).

Commands run (both clean, on the baseline above):

```
node .../typescript/bin/tsc --noEmit -p tsconfig.json                      -> exit 0
node --test --experimental-strip-types test/*.test.ts test/support/*.test.ts -> 246 pass, 0 fail
```

## Verdict

**Sound with reservations.** The boundary protocol is correct and minimal: exactly one continuation site,
the returned shape matches `BoundaryResult`, Pi's `canContinue` check is satisfied by construction, and
other extensions' drafts are preserved. Persistence is a correct newest-valid-wins snapshot on
`getBranch()`, and it behaves correctly on `/new`, `/resume`, `/fork`, `/reload`, `/tree`, auto-compaction
and hard kill. No critical defect found; nothing can crash Pi or wedge the loop.

One **High** finding: a manual `/compact` within five seconds of an Escape silently resumes a goal the user
interrupted, contradicting both the user's explicit stop and `LIMITATIONS.md` #5. Two Medium findings are a
dead `manualCompaction` flag whose documented mechanism does not exist, and a false "Goal paused." report
plus a duplicate snapshot when pausing a `budgetLimited` goal. The remaining findings are Low: an
unreachable dedupe guard, an unsafe-but-unreachable usage fallback, an undocumented accounting divergence,
and two undocumented branch/compaction consequences.

## Findings

| ID | Sev | file:line | Problem | Impact | Fix | Test |
|---|---|---|---|---|---|---|
| F-01 | **High** | `src/adapters/pi-events.ts:152-166`, `src/runtime.ts:140-152` | `session_before_compact{manual}` resumes the goal whenever *any* abort happened in the last 5 s, even when this compaction did not cause it (idle session: `compact()` calls `abort()`, which is a no-op, so no `agent_settled{aborted}` follows). | Escape pauses the goal, then `/compact` within 5 s silently un-pauses it and the notice claims the goal was "kept active". Contradicts `docs/LIMITATIONS.md:52-62` ("an abort that the compaction did not cause leaves the goal paused"). | Only clear when the compaction owns the abort: record `streamingAtCompactionRequest` in the `/compact` command path, or clear the interrupt flag when `session_before_compact` arrives *without* an `agent_settled{aborted}` after the compaction started (e.g. store `compactionStartedAt` on `compaction_start`). | `manual compaction after an idle interrupt does not resume`: `markInterrupt(); emit session_before_compact{manual}` -> status stays `paused/interrupted`. |
| F-02 | Medium | `src/adapters/pi-events.ts:84`, `:109`; `src/services/continuation-policy.ts:71-74`; `src/services/goal-controller.ts:465`; `docs/ARCHITECTURE.md` §4 | Both call sites hardcode `manualCompaction: false`, so `SettleInput.manualCompaction` and the policy's `manual-compaction` branch are dead. ARCHITECTURE §4 says "the adapter marks that case", and the `markManualCompaction`/`consumeManualCompaction` helpers were removed, so nothing marks anything. | A maintainer reading the design believes the compaction case is identified structurally; it is identified by a wall-clock heuristic (F-01). The dead field invites a future "fix" in the wrong place. | Delete `manualCompaction` from `SettleInput`, `BoundaryFacts` and the policy branch, and rewrite ARCHITECTURE §4 to describe the actual mechanism. | `wiring-drift`-style assertion that `BoundaryFacts` has no unused field; or a policy test proving the branch is unreachable (drop both). |
| F-03 | Medium | `src/services/goal-controller.ts:629`; `src/domain/transitions.ts:131`; `src/services/goal-controller.ts:288-290` | `/goal pause` on a `budgetLimited` goal returns `unchanged(current)` but the engine still reports `"Goal paused."`, and `runTransition` persists a snapshot whenever `next !== null`, so an identical snapshot (same `revision`) is appended. | The user is told the goal paused while `status` stays `budgetLimited`; the command adapter then notifies "Goal paused. /goal resume continues it." (verified empirically: status `budgetLimited`, message `"Goal paused."`, `+1` appended snapshot). | Return a status-specific message (as the tool path already does at `goal-controller.ts:856-858`), and skip `persistSnapshot` when `result.outcome.snapshot === current`. | `pause on budgetLimited reports the real status and appends no entry`. |
| F-04 | Medium | `src/adapters/pi-events.ts:30-39` | Comment claims "`AgentSettledEvent.aborted` only exists in newer Pi typings while the runtime has carried it since 1.0". Pi 1.0.0's runtime emits `{type:"agent_settled"}` with no `aborted` (`1.0.0 dist/core/agent-session.js:676`), and its typings omit the field (`1.0.0 dist/core/extensions/types.d.ts:762-764`). Pi 1.4.0 has both (`types.d.ts:801-805`, `agent-session.js:683-688`). | With `peerDependencies: ^1.4.0` there is no live bug, but the comment is false, and the workspace `tsc` floor is 1.0.0, so the typecheck cannot catch removal of a 1.4-only API the extension depends on. On an actual 1.0.0 runtime, Escape would never pause a goal. | Correct the comment to "absent in 1.0.x typings *and* runtime; added in 1.4". Add a CI check against the installed 1.4.0 typings (separate tsconfig with `paths`) or a runtime version gate. | Already covered behaviorally by `test/adapter-events.test.ts:135-141` (payload without `aborted` leaves the goal active). Add a build check that typechecks against the installed 1.4.0 typings, not just the workspace 1.0.0. |
| F-05 | Low | `src/services/progress-tracker.ts:151`; `src/services/continuation-policy.ts:106-114` | `directivePending` requires the directive to be the **last** entry on the branch. At an `agent_before_settle` the branch always ends with the just-persisted assistant message (or a settle snapshot), so the guard cannot fire in 1.4.0. | README/ARCHITECTURE present this as the invariant that prevents continuing the same boundary twice; the real reason is that each `agent.continue()` produces a new assistant entry. If the guard ever did fire it would silently stop an active goal with a misleading `idle` reason. | Keep it as defense but label it unreachable, or replace with an assertion that the anchor differs from the current assistant entry. | Direct unit test: branch ending in a directive anchored at the current assistant entry -> `idle/already-continued`. |
| F-06 | Low | `src/services/usage-accounting.ts:65-73` | When `usageStartEntryId` is not on the branch, `anchorIndex` stays `-1` and the **whole** branch is charged, including pre-goal history. | Unreachable today: the anchor is the parent of the creation snapshot, so either both are on the branch or neither is (rewind/fork keep prefixes). If it ever became reachable it would overcharge the budget, the unsafe direction. `test/usage-accounting.test.ts` pins the behavior ("charges the whole branch when the anchor is null or absent"). | Charge nothing when the snapshot exists but the anchor does not; keep whole-branch only for `usageStartEntryId === null` at creation. | `snapshot present + anchor missing -> 0 charged`. |
| F-07 | Low | `src/services/usage-accounting.ts:85-94` | Assistant usage is charged regardless of `stopReason`, while Pi's own `getAssistantUsage` skips `aborted`/`error` (`1.4.0 dist/core/compaction/compaction.js:72-80`). | Defensible (Anthropic records input/cache usage on `message_start`, so an aborted call did spend tokens: `pi-ai/dist/api/anthropic-messages.js:491-501`), but it is a deliberate divergence that `LIMITATIONS.md` does not state; `README.md:203` mentions failed attempts only in the budget section. | Add one line to LIMITATIONS: aborted/error assistants are charged when the provider reported usage; Pi's context estimate ignores them. | `aborted assistant with zero usage adds nothing; with partial usage adds input+cacheWrite+output`. |
| F-08 | Low | `src/services/goal-repository.ts:92-114`; `src/adapters/pi-events.ts:152-166` | (a) `/tree` to a point before a `goal-cleared` tombstone resurrects the goal (branch semantics). (b) After a manual compaction clears the interrupt pause, the goal is `active` but nothing starts a run, so it waits for the next user message. | Neither is wrong, both surprise users; `LIMITATIONS.md` documents only the usage-refund half of branch scoping (#7) and not these. | Document both under LIMITATIONS #4/#7. No code change recommended. | None (documentation). |
| F-09 | Info | `src/adapters/directive.ts:35-50` | Every continuation appends a permanent `custom_message` user turn (several KB). | Context grows by one large user message per goal turn; the repeated text is charged to the goal budget (correct per Codex) and eventually rolled up by compaction. Self-limiting and intended. | None. | None. |

## 1. Boundary protocol

**Shape.** `buildDirectiveDraft` returns `{type:"custom_message", customType, content, display, details}`
(`src/adapters/directive.ts:35-50`), exactly `CustomMessageEntryDraft`
(`1.4.0 dist/core/extensions/types.d.ts:758-764`). `withDirective` returns `[...existing, directive]`
(`directive.ts:52-57`), and the handler returns `{entries, continue: true}`
(`pi-events.ts:130`, `:140`), which is `BoundaryResult` (`types.d.ts:778-796`). Correct.

**`canContinue`.** Pi commits `result.entries` and then re-derives the context
(`dist/core/agent-session.js:1571-1586`). The rule is
`contextCanContinue || pendingCustomContext || (finalRole === "assistant" && hasQueuedMessages)`
(`agent-session.js:615-633`), with `finalRole` taken from `convertToLlm(projection.messages)`. A
`custom_message` becomes `role: "user"` (`dist/core/messages.js:89-96`), the directive is appended as the
child of the current leaf (`agent-session.js:578-607`), so the projected transcript always ends in `user`
and the check passes. **No path returns `continue: true` without a model-visible entry**: both continuing
branches build a draft first (`pi-events.ts:122-141`); `stopped` and `idle` return `undefined`. There is no
path where the extension's own drafts fail `canContinue`.

**Other extensions' drafts.** `withDirective` preserves `event.entries`, and Pi replaces its accumulated
array with the returned one (`runner.js:774-779`), so a second extension's draft survives if it ran before
`goals`. Three residual cases, all safe: (a) a handler registered *after* `goals` can override `continue`
back to `false`, leaving the directive committed with no continuation, which the extension tolerates on the
next boundary; (b) a later handler can drop `goals`' draft from `entries` while `continue` stays true, which
Pi rejects with `"agent_before_settle requested continuation without runnable model context"` and settles
(`agent-session.js:1580-1586`, `:641-647`) - no crash, no loop; (c) another extension's `compaction` draft
ordered before the directive still leaves the directive last, so `canContinue` holds.

**Dedupe.** The declared guard (`continuation-policy.ts:106-114`) cannot fire in 1.4.0 (F-05). Nothing needs
it: each continuation produces a new assistant entry, and the anchor recorded in `details`
(`directive.ts:21-33`) therefore differs at the next boundary.

## 2. Persistence

- **Write path.** `runtime.context()` wires `appendEntry` to `pi.appendEntry` (`runtime.ts:84-92`), which
  calls `SessionManager.appendCustomEntry` (`agent-session.js:2783-2790`). One complete snapshot per
  transition (`goal-repository.ts:141-156`), tombstone on clear (`:117-137`). Snapshots carry only JSON-safe
  values (`domain/goal.ts` schemas are numbers/strings/arrays/null), so nothing is lost to `JSON.stringify`.
- **Read path.** `loadLatestSnapshot` scans `getBranch()` backwards, returns the first entry that decodes
  (`goal-repository.ts:92-114`), records up to 3 issues from newer invalid entries (`:24`), and treats a
  tombstone as authoritative (`:98-100`). A `version !== 1` payload becomes `unsupported-version` and is
  skipped so an older valid snapshot loads (`:72-82`) - correct forward compatibility.
- **Corruption.** `parseSnapshot` never throws; JSON strings are parsed first, then Effect `Schema` decode
  (`:46-90`). An unusable newest entry cannot brick the session; `session_start` surfaces it once
  (`pi-events.ts:51-58`).
- **Branch semantics.** `getBranch()` is an unfiltered leaf-to-root walk (`session-manager.js:1062-1072`), so
  snapshots survive compaction. Rewind and fork keep prefixes, so the anchor and snapshot are always on the
  same branch. `getEntries()` is correctly not used.
- **Fork.** `session_start{reason:"fork"}` pauses a non-complete goal with `pause.reason = "forked"`
  (`goal-controller.ts:343-372`, `transitions.ts:363-380`), so two sessions cannot continue the same goal.
  Pi copies entries before emitting that event (`agent-session-runtime.js:174-250`), so pausing after the
  fact is the only available lever.
- **Duplicate appends.** `runTransition` writes whenever `next !== null` (`goal-controller.ts:288-290`), so a
  transition that returns `unchanged` still appends an identical snapshot (F-03). Only the
  `budgetLimited`-guarded paths reach this (`transitions.ts:131`, `:259`, `:291`, `:314`).

## 3. Timers, module state, stale contexts, shutdown

- **No timers.** `grep` over `src/` finds `setTimeout|setInterval|setImmediate|process.on` nowhere; all
  timekeeping is `Date.now()` at call sites (`runtime.ts:84,126,133,140,145`).
- **No module-level mutable state.** Only `const` lookups and pure functions outside classes. `GoalRuntime`
  holds the only mutable fields (`runStartedAt`, `manualCompaction`-era flags, `lastInterruptAt`), one
  instance per load (`src/index.ts:15-20`). `manualCompaction` and its accessors are gone; `lastInterruptAt`
  and `runStartedAt` remain, both session-scoped and disposable.
- **Run span.** `beginRun` now only opens a span when none is open (`runtime.ts:126-130`), so the N
  `agent_start` events Pi emits for a continuation chain (`agent-session.js:898-902`;
  `pi-agent-core/dist/agent-loop.js:73`) collapse into one span and `endRun` at `agent_settled` measures the
  whole chain. This was the defect I expected and it is already handled.
- **Stale context after reload.** Every handler uses its own `ctx`; the only long-lived reference is
  `runtime.pi` (`runtime.ts:87`). After reload the old `pi` throws on `assertActive`
  (`loader.js:197-201`, `runner.js:483-491`), `Effect.try` converts that to `GoalPersistenceError`
  (`goal-repository.ts:141-156`), and `run()` returns `ok:false` (`runtime.ts:95-115`) - a notification, not
  a crash. Handlers registered with the new runtime use the new instance.
- **Shutdown.** `session_shutdown` -> `runtime.dispose()` (`pi-events.ts:168-170`), which nulls the span and
  swallows `ManagedRuntime.dispose()` errors (`runtime.ts:154-161`). Idempotent by construction: calling it
  twice just re-awaits a settle of an already-disposed runtime inside a `try`. Pi awaits the handler
  (`agent-session-runtime.js:100-111`). No resource to leak (the layer is a semaphore plus closures).
- **Factory work before a session exists.** The factory only reads `process.env`, builds a
  `ManagedRuntime` (`runtime.ts:73-81`), and registers handlers/tools/commands (`index.ts:15-20`). No
  `appendEntry`, `sendMessage`, file, network, timer or `ctx` use. `ManagedRuntime.make` is synchronous and
  the layer has no acquisition step, so nothing session-bound happens at load.

## 4. Usage derivation

- **Pi semantics confirmed at the source.** Anthropic's `input_tokens` maps to `usage.input`,
  `cache_read_input_tokens` to `cacheRead`, `cache_creation_input_tokens` to `cacheWrite`, and
  `totalTokens` is their sum (`pi-ai/dist/api/anthropic-messages.js:491-501`), so `input` excludes both
  cache buckets and `calculateContextTokens` must add all four (`compaction.js:65-67`). The extension's
  charge `input + cacheWrite + output` (`usage-accounting.ts:45-54`) is therefore the correct Pi
  counterpart of Codex's `input - cached + output`; `cacheRead` stays informational (`allTokens`).
  `cacheWrite` is charged 1:1 although Anthropic bills it at a premium, which understates spend slightly;
  `costTotal` keeps the reported cost separately (`:110`).
- **Anchor.** `usageStartEntryId` is the branch leaf at creation (`goal-controller.ts:254`), and charging
  starts at `anchorIndex + 1` (`usage-accounting.ts:65-73`). Correct on resume (prior session usage is
  excluded), on fork (same anchor, copied prefix, goal paused), and after compaction (the branch keeps
  pre-compaction entries). `null` anchor (empty branch) charges everything, which is correct for a goal that
  started the session. The missing-anchor fallback is F-06.
- **Dedupe.** A per-call `Set` on entry ids (`usage-accounting.ts:70-77`) plus no persisted totals makes
  every derivation idempotent; there is no accumulator that could double count.
- **Aborted/error assistants.** Charged when usage is present (`:85-94`), unlike Pi's own accounting
  (F-07, deliberate).

## 5. Session-file durability

`SessionManager._persist` returns early while `!_hasConversation()`, and `_hasConversation` requires a
`message` entry whose role is `user` or `assistant` (`session-manager.js:791-800`). A `custom` snapshot and a
`custom_message` directive both fail that test (`custom_message` entries have `type: "custom_message"`), so
**a goal created before the first assistant reply is memory-only**. Once the first assistant message lands,
the whole `fileEntries` array is written and `flushed` flips (`:800-811`); every later append is a
synchronous `appendFileSync` (`:814`). Therefore:

- Goal created and the process killed before any assistant message exists: the goal, the directive and any
  tombstone are lost. `LIMITATIONS.md:82-89` states exactly this, and the window is one provider request
  wide. **Correct as documented.**
- Killed at any later point: at most the entries produced after the last successful `appendEntry`/message
  are lost, i.e. an in-flight turn. The last persisted snapshot and all directives survive, `activeMs` for
  the dead run is lost (it is only persisted at `agent_settled`), and the status stays whatever it was. No
  torn or duplicated state is possible because each line is written whole.

## 6. Version compatibility

Every Pi API used here exists in both 1.0.0 and 1.4.0 typings: `CustomMessageEntryDraft`,
`SessionBoundaryDraft`, `agent_before_settle`, `BoundaryState`/`BoundaryResult`, `ToolDefinition.outputSchema`,
`structuredContent`, `ExtensionContext.mode/hasUI`, `session_before_compact.reason`,
`getArgumentCompletions`, `setWidget` with `placement`. The workspace `tsc` resolves the 1.0.0 typings and is
clean, which is the weaker of the two typechecks.

The only API gap is `AgentSettledEvent.aborted`. Runtime behavior differs materially:

| | Pi 1.0.0 | Pi 1.4.0 (installed) |
|---|---|---|
| `agent_settled` payload | `{type}` only (`agent-session.js:676`) | `{type, aborted}` (`:683-688`) |
| `agent_before_settle` semantics | identical (`_runBeforeSettleBoundary`, `_buildBoundaryContext`) | identical |
| `emitBoundary` entries/continue handling | identical (`runner.js`) | identical |
| Effect on `pi-goals` | `settledAborted` returns `false`; Escape never pauses | correct |

So: no draft-validation or `canContinue` difference between the two versions, and the one behavioral hazard
is confined to 1.0.x, which the peer range excludes. The payload-without-`aborted` path is exercised by
`test/adapter-events.test.ts:135-141`, so the runtime degradation on 1.0.x is behaviorally pinned even
though no version gate exists. F-04 is about the false comment and the typecheck floor,
not a live defect.

## 7. Session operations vs code paths

| Operation | Pi path (1.4.0) | `pi-goals` path | Correct? |
|---|---|---|---|
| `/new` | new runtime, `session_start{reason:"new"}` (`agent-session-runtime.js:147-175`) | `pi-events.ts:42-59` -> `rehydrate`; empty branch -> `view:null` -> UI cleared | Yes |
| `/resume` | `session_start{reason:"resume"}` (`:128-145`) | same; newest valid snapshot or tombstone on the branch | Yes |
| `/fork` | entries copied, `session_start{reason:"fork"}` (`:174-250`) | `goal-controller.ts:350-372` pauses a non-complete goal (`forked`) | Yes |
| `/reload` | `session_shutdown{reload}`, then `session_start{reload}` (`agent-session.js:3001`, `:3028`) | dispose (`pi-events.ts:168-170`) then rehydrate | Yes |
| `/tree` | same session file, leaf moves, `session_tree` on success only (`agent-session.js:3406-3411`) | `pi-events.ts:61-68` rehydrates from the new branch | Yes; a rewind past the tombstone resurrects the goal (F-08a) |
| auto-compaction | `compaction` entry; earlier entries leave context, stay on the branch (`session-manager.js:201-229`) | nothing hooked; `getBranch()` unaffected; directives may be summarized (prompt repeats the objective) | Yes |
| manual `/compact` | `abort()` first (`agent-session.js:2230-2231`), then `session_before_compact{manual}` (`:2253-2266`) | `agent_settled{aborted}` pauses, then `pi-events.ts:152-166` resumes within 5 s | Mostly; F-01 is the false-resume case, F-08b the no-run case |
| process kill | last flushed line is the durable state | last snapshot; in-flight turn and its `activeMs` lost | Yes, documented |
| `/goal clear` | append-only entry | tombstone (`goal-repository.ts:117-137`); newest scan stops there | Yes |
| `/goal clear` then new goal | - | new snapshot after the tombstone wins the scan | Yes |
| goal before first message | no session file (`session-manager.js:791-800`) | snapshot+directive memory-only | Yes, documented |
| switch away while active | `session_before_switch` not handled by the extension; `teardownCurrent` aborts first, so the run settles and the goal pauses | stays `active` on disk if the run already ended; continues at the next boundary after resume | Yes (no scheduler by design) |

## 8. Not verified

- No live end-to-end run (no provider): the boundary commit and `agent.continue()` sequence is verified by
  reading `agent-session.js`, not by observing a second `turn_start`. UNVERIFIED at runtime.
- Effect 4 `ManagedRuntime.make` laziness: I confirm only that the factory performs no session or I/O work;
  whether the layer is built eagerly at `make` is UNVERIFIED and irrelevant to correctness here.
- Aborted-message usage shape from non-Anthropic providers: only the Anthropic adapter was read
  (`anthropic-messages.js`); whether every provider records partial usage on abort is UNVERIFIED, which is
  why F-07 asks for documentation rather than a behavior change.
- Concurrent editing: the tree changed under this audit (see baseline). If `runtime.ts`,
  `goal-controller.ts` or `transitions.ts` change again, re-check F-01 (`pi-events.ts` is stable at hash
  `e8adc4…`), F-03 (`goal-controller.ts:288-290`, `:629`, `transitions.ts:131`) and the `beginRun` guard at
  `runtime.ts:126-130`.
