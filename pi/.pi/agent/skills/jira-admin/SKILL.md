---
name: jira-admin
description: |
  Manage Jira projects programmatically: create epics, user stories, subtasks, sprints, and assign issues.
  Use when the user asks to create/update Jira issues in bulk, set up a project backlog in Jira,
  migrate planning from documents to Jira, or automate Jira administration.
---

# Jira Admin Skill

Provides a CLI script (`scripts/jira.py`) to programmatically manage a Jira Cloud project.
Creates epics, stories with subtasks and story points, sprints, and sprint assignments.

The script uses only Python standard library modules. Bulk plan creation uses Jira Cloud's
`/rest/api/3/issue/bulk` endpoint in batches of up to 50 issues, and retries safely on Jira
rate limits or temporary server errors.

## Setup

Store your Jira credentials once (email + API token):

```bash
~/.pi/agent/skills/jira-admin/scripts/jira.py auth --email tu@email.com --token "tu-api-token"
```

The token is saved in `~/.pi/agent/skills/jira-admin/config/credentials.json`
(chmod 600). Your Atlassian API token is generated at
https://id.atlassian.com/manage/api-tokens

## Project Configuration

Most commands accept `--project` and `--board` as CLI arguments, but you can avoid repeating them
by saving project-scoped defaults once with the `config` command:

```bash
# Store project key, board and labels
jira.py config --project LEMBAS --board 35 --labels tfi

# Override issue type IDs if your Jira instance differs from the defaults
jira.py config --epic-type 10009 --story-type 10008 --subtask-type 10010

# Set the story points custom field (varies per Jira instance)
jira.py config --story-points-field customfield_10016
```

The configuration is stored in `config/project.json`. Fields omitted from the CLI keep their
hardcoded defaults, so you only need to save what differs from the defaults.

Once configured, CLI commands resolve values in this order:
1. **Explicit CLI flag** (highest priority)
2. **project.json** (saved via `jira.py config`)
3. **Hardcoded fallback** in the script itself

This means after running `jira.py config --project LEMBAS`, you can omit `--project LEMBAS`
in all subsequent commands for that project.

### Detecting boards

If a project has exactly one board, the script auto-detects it. You can also list all boards:

```bash
jira.py list boards --project LEMBAS
```

If a project has multiple boards, pass `--board ID` explicitly.

## Usage

All commands follow: `jira.py <command> [options]`

### Authentication

```bash
# Store credentials (first time)
jira.py auth --email user@example.com --token "ATATT3xxx"

# Store credentials for a specific Jira Cloud site
jira.py auth --email user@example.com --token "ATATT3xxx" \
  --base-url "https://your-domain.atlassian.net"

# Test that credentials work
jira.py test --project RN412023
# Or if project is set in config: jira.py test

# Show current project info
jira.py info --project RN412023
```

### Creating Epics

```bash
# Single epic (--project can be omitted if set in config)
jira.py create epic --project RN412023 --summary "E1 - Security"

# With detailed description
jira.py create epic --summary "E1 - Security" \
  --description "Login, roles, permissions and user management."
```

### Creating Stories

```bash
# Simple story
jira.py create story --project LEMBAS \
  --summary "HU-01: Login and logout" \
  --parent EPIC-KEY \
  --points 3

# Story with acceptance criteria in description
jira.py create story \
  --summary "HU-01: Login and logout" \
  --parent LEMBAS-2 \
  --points 3 \
  --description "As admin, I want to log in and out to access the system securely."

# Story with subtasks
jira.py create story --project LEMBAS \
  --summary "HU-01: Login" \
  --parent LEMBAS-2 \
  --points 3 \
  --tasks "Endpoint POST /api/auth/login" "JWT generation" "Login page"
```

### Creating Subtasks

```bash
# Single subtask
jira.py create subtask --parent LEMBAS-16 \
  "Implement login endpoint"

# Multiple subtasks at once
jira.py create subtask --parent LEMBAS-16 \
  "JWT validation" "Token interceptor" "Route guard"
```

### Managing Sprints

```bash
# Create a sprint (--board auto-detected if project has a single board)
jira.py create sprint \
  --name "S1 - Base and Security" \
  --goal "Login, roles and API documentation"

# List existing sprints (auto-detects board)
jira.py list sprints --verbose

# List sprints for a specific board
jira.py list sprints --board 35 --verbose

# Update sprint name/goal
jira.py update sprint --id 6 --name "S1 - Base and Catalog" --goal "New goal"
```

### Assigning Issues to Sprints

```bash
# Assign multiple issues to a sprint
jira.py assign --sprint 6 --issues LEMBAS-16 LEMBAS-23 LEMBAS-29

# Assign by HU prefix with one paginated board lookup
jira.py assign --sprint 6 --by-hu HU-01 HU-02 HU-03

# Move all stories from one sprint to another
jira.py assign --sprint 7 --from-sprint 6
```

### Bulk Operations from JSON Plan

```bash
# Validate and preview all writes without touching Jira
jira.py create-from-plan plan.json --dry-run

# Create everything from a JSON file (epics + stories + subtasks + sprints)
jira.py create-from-plan plan.json
```

`create-from-plan` validates the plan before writing. It rejects missing summaries,
invalid structure, sprint names longer than 30 characters, and sprint story references
that do not match a story summary or HU prefix in the plan.

The plan file can omit `project` and `board` if they are already set in `project.json`.

## Plan JSON Format

The bulk operation (`create-from-plan`) accepts a JSON file with this structure:

```json
{
  "project": "RN412023",
  "board": 2,
  "epics": [
    {
      "summary": "E1 - Security",
      "description": "Login, roles and permissions.",
      "stories": [
        {
          "summary": "HU-01: Login and logout",
          "description": "As admin...",
          "points": 3,
          "tasks": [
            "Login endpoint",
            "JWT generation"
          ]
        }
      ]
    }
  ],
  "sprints": [
    {
      "name": "S1 - Base",
      "goal": "Base system",
      "stories": ["HU-01"]
    }
  ]
}
```

## Workflow Reference

When the user asks to migrate a backlog to Jira:

1. **Authenticate**: Ensure credentials are stored (`jira.py auth`)
2. **Configure project**: `jira.py config --project KEY --board ID` (once per project)
3. **Verify access**: `jira.py test` (uses project from config) to confirm access
4. **Create or validate a plan**: `jira.py create-from-plan backlog.json --dry-run`
5. **Bulk-create the plan**: `jira.py create-from-plan backlog.json`
6. **Review the final report**: confirm created epics, stories, subtasks, sprints, and assignments

Tips:
- Sprint names are limited to **30 characters** in Jira Cloud
- Story points field (`customfield_10016`) can be overridden via `jira.py config --story-points-field`
- Issue type IDs (epic, story, subtask) can be overridden per Jira instance via `jira.py config`
- The `parent` field links stories to epics in simplified Jira projects
- Jira rate limits are handled with `Retry-After` and exponential backoff
- Board auto-detection works when the project has exactly one board

## Examples Asked by Users

### "Create the full Scrum backlog in Jira"

```bash
# 1. Authenticate
jira.py auth --email user@example.com --token "xxx"

# 2. Set project defaults (one time only)
jira.py config --project LEMBAS --board 35 --labels tfi

# 3. Create plan file with all epics+stories+tasks, then validate:
jira.py create-from-plan backlog.json --dry-run

# 4. Bulk create and assign from the plan:
jira.py create-from-plan backlog.json
```

### "Update sprint names or goals"

```bash
jira.py update sprint --id 6 --name "S1 - Base and Security" --goal "New goal"
```

### "Check what's in each sprint"

```bash
jira.py list sprints --verbose
```

## Configuration

| File | Purpose | Created by |
|---|---|---|
| `config/credentials.json` | Jira auth (email + token + baseUrl) | `jira.py auth` |
| `config/project.json` | Project-scoped defaults (project, board, labels, issue types, etc.) | `jira.py config` |

### credentials.json

```json
{
  "email": "user@example.com",
  "token": "ATATT3xxx",
  "baseUrl": "https://your-domain.atlassian.net"
}
```

The `auth` command creates this file. Customize `baseUrl` if your instance
uses a different domain.

### project.json

Stored at `config/project.json`. You only need to store values that differ from the
hardcoded defaults. Example when overrides are set:

```json
{
  "project": "LEMBAS",
  "board": 35,
  "labels": ["tfi"],
  "storyPointsField": "customfield_10016",
  "issueTypes": {
    "epic": "10009",
    "story": "10008",
    "subtask": "10010"
  }
}
```

Use `jira.py config --help` to see all available options.
