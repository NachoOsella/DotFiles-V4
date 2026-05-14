# Jira Admin Templates

Generic templates for reference when working with the `jira-admin` skill
on different projects. Keep code comments and instructions in English.
The Jira issue content (summaries, descriptions, tasks) should be in the
language the user requests.

## Contents

| File | Purpose | When to use |
|---|---|---|
| `plan_template.json` | Scrum plan JSON to import into Jira | Starting a new project, defining epics, stories and sprints in bulk |
| `batch_operations_template.py` | Batch operations (create subtasks, update fields) | Making mass changes on existing issues |
| `enrich_descriptions_template.py` | Enrich descriptions of epics, stories and subtasks | After creating issues, to add detailed structured descriptions |
| `verify_plan_template.py` | Verify plan integrity against Jira | Validating that what was created in Jira matches the planned plan |

## Instructions for the AI

Each file has comments with `REPLACE` or `PROJECT_KEY` markers indicating
which values must be customized for the concrete project.

### Typical workflow

1. Create `plan_PROJECT_KEY.json` with the project's epics, stories and sprints
2. Run `jira.py create-from-plan plan_PROJECT_KEY.json --dry-run` to validate
3. Run `jira.py create-from-plan plan_PROJECT_KEY.json` to create in Jira
4. Adapt and run `enrich_descriptions_template.py` for detailed descriptions
5. Adapt and run `verify_plan_template.py` to verify everything is correct

### Important notes

- `ISSUE_TYPES` in `jira.py` are defaults. Verify with
  `jira.py info --project KEY` if they match the real project.
- `customfield_10016` for story points may vary between projects.
- Sprint names have a 30-character limit in Jira Cloud.
- Board ID can be found with: `jira.py list sprints --board X` (try 1, 2, etc.)
- Jira Cloud search API may have pagination issues (>100 results).
  Use key-ranges in queries when needed.
