# Codex-style Plan Mode for Pi

Pi extension that provides a Codex-style planning workflow:

- read-only planning mode through `/plan`
- clarification questions with the interactive `request_user_input` UI
- full Markdown plans without visible XML or custom tags
- derived task payloads emitted when a plan is approved
- final decision flow to implement, keep refining, or add feedback

## What it implements

### 1) Codex-style Plan Mode

- Command: `/plan` (toggle)
- Shortcut: `Ctrl+Alt+P`
- In plan mode:
  - allowed tools: `read`, `bash`, `grep`, `find`, `ls`, `request_user_input`
  - blocks `edit` and `write`
  - blocks destructive bash commands

The hidden plan-mode prompt now encourages the agent to:

1. Explore the repository with non-mutating commands before asking questions.
2. Ask only for high-impact preferences or choices that cannot be discovered.
3. Produce a decision-complete Markdown plan instead of a short checklist.
4. Ask with request_user_input whenever uncertainty remains instead of assuming defaults.

### 2) Markdown plans

When ready, the agent emits a normal Markdown plan without XML or custom tags:

```md
# Clear plan title

## Summary
- What the change will accomplish and why.

## Implementation Changes
- Main implementation change.
- Supporting implementation change.

## Test Plan
- Validation command or scenario.

## Decisions Confirmed
- User-confirmed decisions that resolved earlier doubts.
```

The extension preserves the full Markdown plan for review and status display. It also derives concise execution steps from implementation and validation sections so task tracking remains practical.

If the agent has any relevant doubt after exploration, it must ask through `request_user_input` before writing the final plan. It should not hide unresolved decisions in an assumptions section.

Legacy `Plan:` plus numbered steps and older proposed-plan blocks still work as parser fallbacks.

### 3) request_user_input-style UI

Tool: `request_user_input`

- one tab per question plus final submit tab
- selection with arrow keys, `j/k`, `1-9`, and `Enter`
- tab navigation with `Tab / Shift+Tab`, arrow keys, `Ctrl+n`, or `Ctrl+p`
- optional `None of the above` answer for custom responses
- typed text is added as detail for the selected option
- confirmation when submitting with unanswered questions

### 4) Final plan flow

When it detects a Markdown plan or legacy numbered plan, it shows:

- `Yes, implement this plan`
- `No, stay in Plan mode`
- `Refine with additional feedback`

If you choose to implement, it exits plan mode and also:

1. emits `codex-plan-mode:approved-tasks` with derived task payloads
2. emits the legacy `codex-plan-mode:approved-plan` event for compatibility
3. sends a hidden model kickoff with the full approved Markdown plan
4. tells the agent to verify existing tasks before implementation
5. encourages using relevant skills before coding

## Installation

With these files already in:

- `~/.pi/agent/extensions/codex-plan-mode/index.ts`

Reload Pi:

```bash
/reload
```

or restart `pi`.

## Commands

- `/plan` toggles plan mode
- `/plan-status` shows the current state and the last full Markdown plan when available

## Notes

- Plan mode state, the last Markdown plan, derived steps, and the approved plan are persisted in session state.
- The UI is inspired by the real behavior in the `openai/codex` repository.
- Plan mode no longer renders a truncated `Plan draft` widget; use the final message or `/plan-status` for the full plan.
- Derived task steps intentionally remain shorter than the Markdown plan so execution tracking stays readable.
