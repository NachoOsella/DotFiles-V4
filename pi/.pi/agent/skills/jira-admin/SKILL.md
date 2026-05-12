---
name: jira-admin
description: |
  Manage Jira projects programmatically: create epics, user stories, subtasks, sprints, and assign issues.
  Use when the user asks to create/update Jira issues in bulk, set up a project backlog in Jira,
  migrate planning from documents to Jira, or automate Jira administration.
---

# Jira Admin Skill

Provides a CLI script (`scripts/jira.py`) to programmatically manage a Jira Cloud project.
Creates epics, stories (with subtasks and story points), sprints, and assigns issues to sprints.

## Setup

Store your Jira credentials once (email + API token):

```bash
~/.pi/agent/skills/jira-admin/scripts/jira.py auth --email tu@email.com --token "tu-api-token"
```

The token is saved in `~/.pi/agent/skills/jira-admin/config/credentials.json`
(chmod 600). Your Atlassian API token is generated at
https://id.atlassian.com/manage/api-tokens

## Usage

All commands follow: `jira.py <command> [options]`

### Authentication

```bash
# Store credentials (first time)
jira.py auth --email user@example.com --token "ATATT3xxx"

# Test that credentials work
jira.py test

# Show current project info
jira.py info --project RN412023
```

### Creating Epics

```bash
# Single epic
jira.py create epic --project RN412023 --summary "E1 - Security"

# With detailed description
jira.py create epic --project RN412023 \
  --summary "E1 - Security" \
  --description "Login, roles, permissions and user management."
```

### Creating Stories

```bash
# Simple story
jira.py create story --project RN412023 \
  --summary "HU-01: Login and logout" \
  --parent EPIC-KEY \
  --points 3

# Story with acceptance criteria in description
jira.py create story --project RN412023 \
  --summary "HU-01: Login and logout" \
  --parent RN412023-2 \
  --points 3 \
  --description "As admin, I want to log in and out to access the system securely."

# Story with subtasks
jira.py create story --project RN412023 \
  --summary "HU-01: Login" \
  --parent RN412023-2 \
  --points 3 \
  --tasks "Endpoint POST /api/auth/login" "JWT generation" "Login page"
```

### Creating Subtasks

```bash
# Single subtask
jira.py create subtask --parent RN412023-16 \
  --summary "Implement login endpoint"

# Multiple subtasks at once
jira.py create subtask --parent RN412023-16 \
  --summary "JWT validation" "Token interceptor" "Route guard"
```

### Managing Sprints

```bash
# Create a sprint
jira.py create sprint --board 2 \
  --name "S1 - Base and Security" \
  --goal "Login, roles and API documentation"

# List existing sprints
jira.py list sprints --board 2

# Update sprint name/goal
jira.py update sprint --id 6 --name "S1 - Base and Catalog" --goal "New goal"
```

### Assigning Issues to Sprints

```bash
# Assign multiple issues to a sprint
jira.py assign --sprint 6 --issues RN412023-16 RN412023-23 RN412023-29

# Move all issues from one sprint to another
jira.py assign --from-sprint 6 --to-sprint 7
```

### Bulk Operations from JSON Plan

```bash
# Create everything from a JSON file (epics + stories + subtasks + sprints)
jira.py create-from-plan plan.json
```

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
      "stories": ["HU-01", "HU-02"]
    }
  ]
}
```

## Workflow Reference

When the user asks to migrate a backlog to Jira:

1. **Authenticate**: Ensure credentials are stored (`jira.py auth`)
2. **Verify access**: `jira.py test` to confirm the project exists
3. **Create epics** first (they have no dependencies)
4. **Create stories** with `--parent EPIC-KEY` to link them
5. **Create subtasks** with `--parent STORY-KEY`
6. **Create sprints** after all issues exist
7. **Assign** stories to sprints by their HU prefix or key

Tips:
- Sprint names are limited to **30 characters** in Jira Cloud
- Story points use `customfield_10016`
- Subtasks use issue type ID `10010` (for the standard Jira Cloud schema)
- Epics use issue type ID `10009`
- Stories use issue type ID `10008`
- The `parent` field links stories to epics in simplified Jira projects

## Examples Asked by Users

### "Create the full Scrum backlog in Jira"

```bash
# 1. Authenticate
jira.py auth --email user@example.com --token "xxx"

# 2. Create plan file with all epics+stories+tasks, then:
jira.py create-from-plan backlog.json

# 3. Create 4 sprints
jira.py create sprint --board 2 --name "S1 - Base" --goal "Base system"
jira.py create sprint --board 2 --name "S2 - Catalog" --goal "Products and stock"

# 4. Assign by HU prefix
jira.py assign --sprint 6 --by-hu HU-01 HU-02 HU-03
```

### "Update sprint names or goals"

```bash
jira.py update sprint --id 6 --name "S1 - Base and Security" --goal "New goal"
```

### "Check what's in each sprint"

```bash
jira.py list sprints --board 2 --verbose
```

## Configuration

Credentials are stored at `config/credentials.json`:

```json
{
  "email": "user@example.com",
  "token": "ATATT3xxx",
  "baseUrl": "https://your-domain.atlassian.net"
}
```

The `auth` command creates this file. Customize `baseUrl` if your instance
uses a different domain.
