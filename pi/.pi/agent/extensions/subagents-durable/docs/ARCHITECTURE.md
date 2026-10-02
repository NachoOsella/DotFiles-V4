# Architecture

## Host and activation

This extension targets a Durable-native host. Its root must be a Conversation in the same Harness as its children. The current coding-agent CLI does not expose that host interface. The discoverable `index.ts` remains a no-op until stable CLI integration exists. It must not register tools, commands, watchers, or lifecycle handlers. The existing subagents extension remains enabled and unchanged.

The host installs the native extension in its Registry before opening SQLite storage and calling `resume()`. Models, execution environments, settings, and storage belong to the host, not the subagents extension. There is no AgentSession adapter or transcript import.

## Ownership and persistence

```text
Harness
  Root conversation
    Background anchor task, terminal after creation
      Child conversation
        Generation and tool tasks
        Background anchor task
          Grandchild conversation
    Background reporter task for each work submission
```

The ownership edge survives the anchor becoming terminal. Ordinary parent abort and idle waits stop at the background edge. Explicit `abort(context, { background: true })` crosses it. Interruption aborts the target conversation's ordinary work, including queued inputs, but preserves its identity and independent background descendants.

SQLite stores conversations, entries, submissions, task checkpoints, and documents. Reopen installs the same task definitions and calls `resume()`. There are no child session files, loaded/unloaded states, recovery snapshots, mailboxes, or completion outboxes.

## Registry

One session-scoped typed document maps canonical paths to name, path, parent path, ConversationId, role, and creation time. `/root` is the reserved Durable root and does not need a registry record. Running state, queues, transcripts, usage, configuration, and ownership are not duplicated.

Replay-safe tools use a small task-scoped operation receipt committed together with child/reporter creation. This distinguishes replay of the same spawn from a different call attempting the same name. Spawn stores its decided tool response in that receipt, so later role, model, or visibility changes cannot change the response during replay. This is a tool result receipt, not an agent configuration snapshot or lifecycle record. Name, depth, and logical capacity validation run in the creating commit. Anchors have null input and result; identity stays in the registry.

## Messages and reports

- `send_message` submits a passive model-contributing write. Durable queues it at a boundary while busy and never starts a run while idle.
- `followup_task` defaults to `whenBusy: "steer"`, preserving current behavior. An explicit follow-up mode can select `"followUp"`.
- Spawn submits one NEW_TASK through a background reporter.
- A reporter submits child input with a request ID derived from its Durable task ID, waits for settlement, and commits its report decision as its next checkpoint.
- Successful answer reports use a parent request ID derived from child ConversationId and final answer EntryId. Multiple steers settling to one answer therefore produce one parent report, even with separate reporters.
- The reporting phase submits to the direct parent with `whenBusy: "steer"` and then commits a terminal receipt. A crash on either side of submission is safe because the request ID is unchanged. If the parent is itself a subagent, the same terminal commit creates a reporter that adopts this submission and reports the parent's next answer to its own parent. The chain stops at root. This covers a grandchild waking an idle parent after the parent's original task has finished.
- Aborted work produces no final answer report. Other unanswered outcomes produce bounded failure reports.

Exactly-once means one durable parent submission and one placed envelope per answer. Explicit parent abort may withdraw a queued report, as it may withdraw any Durable input. It does not imply exactly-once provider execution after a crash.

Task-acquired ConversationHandles only support input submissions in Durable 1.0.0. The host must supply one narrow passive-write function using its public `Conversation.submit({ type: "write", ... })`. It receives the invocation's cancellation context. This is the only host messaging exception. It must not implement admission or queues itself.

## Forks and configuration

Fresh children use `tx.createConversation`; inherited children use `tx.forkConversation`. Native agent documents supply model, thinking level, cwd, selected tools, extensions, and instructions. Pure role policy applies overrides and child-specific instructions. At the depth limit only spawn capability is removed, not all collaboration capabilities. No MCP extension is installed by this package.

The extension installs a root-only native prompt section. It derives delegation mode from the request's resolved thinking level, adds the configured supplemental hints, and leaves the host's instructions intact. Children receive their own identity and collaboration policy in native instructions. The root-only section disappears from a child's inherited prompt when Durable renders its sections.

Native forks retain a prefix through an EntryId. Recent N turns require a suffix, so choosing an older fork point alone is incorrect. The fork helper selects the current tail and applies native omission edits for older logical turns while retaining the active compaction baseline. A logical turn ends at a final assistant response. Several steers before that response belong to one turn. Boundaries use contributions after native context edits, so omitted inputs do not create turns. The helper never copies messages or modifies inherited usage. Native structured tool history is retained within selected turns rather than manually rebuilding text-only transcripts.

Durable compaction handles long-running conversations. Usage comes only from `pi.usage`, whose native fork policy is initial.

## Waiting and execution limits

Default waiting observes the caller's Durable inbox. Already queued activity wakes immediately; newly admitted activity wakes a subscribed wait. Optional targets also wake when any target's current work settles. For a target, the observer first awaits its existing reporter tasks and then ordinary child idle. Racing child idle independently would return in the gap between the spawn commit and initial input admission. Caller inbox activity can still wake a targeted wait. The absolute deadline is a Durable tool memo. Cancelling the invocation or reaching its deadline cancels only observation. Answers remain in Durable state. Waiting indicators come from live wait tool tasks.

Durable 1.0.0 has no global model concurrency setting. A host-side model request limiter bounds concurrent provider operations and releases on completion or cancellation. It does not queue turns, own lifecycle, or store running state. Logical agent capacity is independent. The old loaded-session limit is obsolete.

## UI

A read-only inspector projects registry metadata, Conversation agent/view state, task graph, and native usage. Attaching the source requires an initialized registry and never creates documents. It returns an initially hydrated projection, follows registry and task graph watches, and attaches to a selected child with `Conversation.watch()`. Closing disposes subscriptions. Activity shows a bounded recent entry list; tool errors retain their text.

Terminal status and completion previews come from the newest own native generation task receipts, not inherited answers or an application status record. An abort before the first assistant partial and a missing model still have authoritative task outcomes. The public task scan is ascending, so finding the newest receipt costs O(generation tasks). There is no private SQL query or persisted status cache. This is a performance limitation for very long histories, not a claimed constant-time operation.

The native host can expose the inspector as `/agents`; current CLI command, footer, dashboard, and `/stats` registration remain disabled until a stable Durable host interface exists.

Optional coding tools and tool search are separate Durable extensions. Codemode cannot safely execute nested Durable tools through the current public API and is a tracked compatibility gap, not a reason to create another tool runtime.
