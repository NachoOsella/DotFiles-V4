# Codex-style Plan Mode for Pi

Pi extension that replicates the **Codex-style Plan Mode** workflow:

- read-only planning mode (`/plan`)
- clarification questions with interactive tabbed UI (`request_user_input`)
- per-option answers, with optional additional text for that same option, or a custom answer
- final decision: **implement** or **keep refining**

## What it implements

### 1) Codex-style Plan Mode

- Command: `/plan` (toggle)
- Shortcut: `Ctrl+Alt+P`
- In plan mode:
  - allowed tools: `read`, `bash`, `grep`, `find`, `ls`, `request_user_input`
  - blocks `edit` and `write`
  - blocks destructive bash commands

### 2) request_user_input-style UI

Tool: `request_user_input`

- one tab per question + final submit tab
- selection with `↑/↓`, `j/k`, `1-9`, `Enter`
- tab navigation with `Tab / Shift+Tab` (also `←/→`, `Ctrl+n/Ctrl+p`)
- extra `None of the above` option for custom responses
- if you start typing, that text is added as detail for the selected option (without forcing the last option)
- confirmation if there are unanswered questions

### 3) Final plan flow

When it detects a numbered plan (`Plan:` + steps), it shows:

- `Yes, implement this plan`
- `No, stay in Plan mode`
- `Refine with additional feedback`

If you choose to implement, it exits plan mode and also:

1. automatically imports steps into your other extension's `todo` (via `pi.events`)
2. sends a hidden model kickoff to reinforce using/updating `todo` by id
3. explicitly encourages searching/using relevant skills before implementation

## Installation

With these files already in:

- `~/.pi/agent/extensions/codex-plan-mode/index.ts`

just run:

```bash
/reload
```

or restart `pi`.

## Commands

- `/plan` → enable/disable plan mode
- `/plan-status` → show current state and last parsed plan

## Notes

- Plan mode state and the last plan are persisted in session state.
- The UI is inspired by the real behavior in the `openai/codex` repo (`request_user_input` + plan implementation prompt).
