# Limitations

This file lists what `pi-goals` cannot do, why, and what the current behavior is. Every entry names the
Pi mechanism it works around. The code is the reference for behavior; `../README.md` covers usage and
`ARCHITECTURE.md` covers the approved design.

## Hard limits of the public Pi API

### 1. No idle scheduler: a goal does not auto-start after a restart or reload

Pi exposes no scheduler or background-turn API. `agent_before_settle` fires only while a run is settling,
and `session_start` is a notification. A process-local Node timer could send a message while idle, but it
would not survive a restart, and the design uses no timers.

Consequence: after a restart, `/reload`, or resume of an old session, the goal is restored in its last
status and nothing continues it, because the extension starts no run outside a boundary or an explicit user
command. It re-engages on the next user message, because the boundary after that turn sees an `active`
goal, or immediately with `/goal resume`, which sends a continuation directive with `triggerTurn: true`
while the session is idle. A fork is handled separately: see item 6.

### 2. `agent_before_settle{outcome:"aborted"}` is unreachable

Pi's run loop checks the abort flag before it dispatches the settlement boundary, so an aborted run never
reaches `agent_before_settle`. The event type declares `aborted` as an outcome and the continuation policy
handles it defensively, but in practice the only abort signal is `agent_settled` with `aborted: true`.

Consequence: interrupt handling lives in `agent_settled`, which pauses an active goal with reason
`interrupted`. The policy branch for an aborted boundary is dead code kept for the event contract.

### 3. Boundary handlers cannot observe an in-flight abort

At the boundary the agent has no active run, so `ctx.signal` is undefined, and Pi honors an abort requested
during the handler only after the handler returns. The handler cannot know that its continuation will be
discarded and cannot cancel work it already started.

Consequence: an abort during the decision window is honored by Pi (no continuation starts), but a directive
may already have been appended and a status change persisted. The extension keeps the window to one branch
read, one derivation, one append, and re-evaluates at the next boundary, so the outcome is a stray directive
or a pause, not a stalled loop.

### 4. Compaction can summarize the directive away

`custom` entries written with `pi.appendEntry` never enter model context, and `custom_message` entries are
ordinary user text to the compactor. Pi has no API to pin an entry across compaction.

Consequence: the extension embeds the objective in the kickoff prompt and again in every continuation
prompt, and keeps authoritative state in `custom` snapshots on the branch (which compaction does not touch)
plus turn spans derived from directive entries. A compaction that lands between the decision and the
provider request can still drop the freshly injected text. Pi commits boundary drafts before issuing the
request, which narrows that window but does not remove it.

### 5. Manual `/compact` aborts the running turn

`compact()` aborts the run first, so a manual compaction produces the same `agent_settled{aborted: true}`
as Escape. At that moment Pi carries no signal that distinguishes them; the only later trace is
`session_before_compact` with reason `manual`.

Consequence: the extension records the interrupt time and treats a manual compaction event within five
seconds as the cause, clearing the interrupt pause by resuming the goal. The correlation is time-based only:
an Escape followed by a manual compaction within that window is also attributed to the compaction and the
goal is silently resumed. A compaction that arrives later leaves the goal paused with reason `interrupted`.
Clearing the pause makes the goal `active` again, but it does not start a run; the goal waits for the next
user message, whose boundary continues it. The five-second window and the resume are in `src/runtime.ts` and
`src/adapters/pi-events.ts`.

### 6. `/fork` copies goal entries into a new session

Pi creates the forked session by copying branch entries before the extension receives
`session_start{reason: "fork"}`, and there is no API to prevent the copy.

Consequence: the fork starts with the original snapshot and history. The extension pauses any non-complete
goal in the fork with reason `forked`, so two sessions never continue the same goal. `/goal history` in the
fork shows the original transitions, and continuing there requires `/goal resume`.

### 7. No per-branch attribution of usage in Pi

`getBranch()` is the active leaf-to-root path; `getEntries()` covers the whole session file, including
abandoned branches. Pi exposes no per-branch usage accounting.

Consequence: the extension charges the branch it reads, starting after the goal's `usageStartEntryId`. A
`/tree` rewind to an earlier leaf reduces the charged total for the goal, so budget enforcement is
branch-scoped, not file-scoped. Rewinding can therefore refund budget that was already spent on the
abandoned leaf. A rewind to a leaf before a `goal-cleared` tombstone also resurrects the goal, because the
tombstone is no longer on the active branch.

### 8. The session file exists only after the first user or assistant message

Pi creates the session file when the first user or assistant message is appended. Before that,
`appendEntry` writes live only in memory.

Consequence: a goal created with `/goal` before any message exists is not durable, and neither is a clear
tombstone written in that window. In normal use the kickoff directive starts a run immediately, so the
window is one provider request long, but a crash inside it loses the goal.

### 9. Provider-side retries are invisible; budget enforcement happens between provider calls

Pi retries provider requests inside its provider layer, before any assistant message exists, and the
extension can only observe usage that Pi records. `agent_before_settle` runs after a run stops, so every
budget check happens between provider calls.

Consequence: tokens spent on retried or failed HTTP attempts are never charged, and the last allowed
request can push usage past the budget before the extension sees the total and stops. The extension cannot
interrupt a call in flight. The same applies to the turn cap and the no-progress breaker: they are checked
at boundaries.

### 10. The extension cannot cancel another extension's continuation at the same boundary

Pi dispatches one settlement boundary to every registered handler. Each handler sees the accumulated
`continue` flag, the last non-undefined value wins, and a handler's `entries` replace the accumulated
array.

Consequence: `pi-goals` cannot see or cancel another extension's continuation, and a handler registered
after it can override its decision. The assistant-anchor dedupe is a per-goal defense; Pi's one boundary
per settled run is what actually prevents a double continuation, and neither mechanism says anything about
other extensions.

## Known behavior gaps vs Codex

- No plan-tool coupling beyond prompt wording. The continuation prompt says `todowrite` where Codex says
  `update_plan`; nothing reads, validates, or enforces plan state.
- No subagent or descendant roll-up beyond Pi's recorded tool-result usage. Codex rolls descendant token
  usage into the root goal; here only entries on the branch count, including nested model usage carried by
  tool results.
- No TUI goal menu. Codex has a `/goal` menu with edit and resume flows; this extension has `/goal`
  subcommands, a footer status line, a two-line widget, and notifications.
- No `usageLimited` auto-recovery. After a usage limit the goal stays `usageLimited` until `/goal resume`.
  There is no background check that retries when the provider limit resets.
- Provider error mapping differs. Codex blocks on every non-usage terminal turn error; here the goal pauses
  with reason `provider-error` so the user can fix the cause and resume.
- No default or maximum token budget. Codex defaults an omitted `token_budget` to a configured maximum;
  here an omitted budget means unbounded, and there is no upper bound on a requested budget.
- Raw status labels. Codex renders `blocked` as "stalled" and `budgetLimited` as "limited by budget"; this
  extension shows the status names used by the tools and the snapshot.
- Mechanical gates. `complete` is satisfied by any successful non-goal tool result in the current goal turn,
  including a plan write such as `todowrite`, and the blocked gate counts audited goal directives without
  checking that the same blocker recurred. The prompt asks for stronger evidence than the code verifies.
- `clear` is a tombstone, not a deletion. Codex removes the goal row; Pi session entries are append-only,
  so earlier snapshots stay on the branch and only a `goal-cleared` entry ends the goal.

## Test coverage gaps

- No live-model end-to-end test in the default suite. The engine is driven over a fake session and an
  appended-entry writer. The boundary driver models Pi's documented semantics (drafts are committed before
  the continuation decision, one continuation per boundary, `continue` requires runnable context) but not
  queued or steering messages, the shared `continue` flag across extensions, or `_abortDuringBeforeSettle`.
- UI rendering is not asserted. The fake host records `setStatus` and `setWidget` calls, but no test checks
  the status line or widget text, so a formatting regression would pass the suite.
- No Windows or macOS run. The extension has no platform-specific code and makes no shell or path
  assumptions, but only this Linux environment has been tested.
- No test with a live provider error or a live usage limit. Error classification is unit-tested from
  message strings only.
- No test for a compaction that arrives after the five-second interrupt window.

### Manual smoke test

Use a scratch directory and a working provider. This checks the live continuation loop and the terminal UI,
which the automated suite does not cover.

1. Start Pi with the extension explicitly, so other discovered extensions cannot interfere:
   `pi -e ~/.pi/agent/extensions/goals/src/index.ts`.
2. Run `/goal Create smoke.txt containing the word ok, then verify the file exists`.
3. Expect the `Goal created` notification, the footer status line, and the widget above the editor (TUI
   only), followed by at least one automatic continuation without a new user message. With
   `PI_GOAL_SHOW_DIRECTIVES=1` the directives are visible in the transcript.
4. Run `/goal status` and check tokens, turns, continuations, idle turns, and the turn cap.
5. Run `/goal pause`, let the current turn end, and confirm that no continuation starts. Run `/goal resume`
   and confirm that one more turn starts.
6. Press Escape during a run; expect `Goal paused after the interrupt`. `/goal resume` continues.
7. Exit and restart with `pi --continue` (or `pi -r` and pick the session). The goal must be restored, must
   not start a turn on its own, and must continue at the boundary after the next message you send.
8. Run `/goal clear`; the status line disappears, `/goal status` reports no goal, and `/goal <new objective>`
   creates a fresh goal.
9. Run `/goal budget 500` and keep the goal working until usage crosses 500. Expect one wrap-up turn, then
   `budgetLimited`, and `/goal resume` refused until the budget is raised above current usage.
