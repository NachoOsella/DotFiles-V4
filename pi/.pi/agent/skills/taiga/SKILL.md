---
name: taiga
description: Manage Taiga projects through the REST API. Use when the user asks to inspect, create, update, assign, move, close, reopen, or delete Taiga user stories, tasks, issues, epics, sprints, or project work.
---

# Taiga

Use the bundled `taiga.py` helper. It reads `.env` from this skill directory, authenticates against Taiga, resolves the configured project, and prints JSON.

Official API reference: https://docs.taiga.io/api.html

## Rules

- Never print, echo, cat, or expose `.env`, passwords, auth tokens, or authentication responses.
- Treat references such as `#42` as Taiga refs, not database ids. Use `id:123` only when an internal id is explicitly known.
- Use the project configured in `.env` unless the user explicitly asks for another project.
- Prefer human names in payloads. The helper resolves member names/usernames, sprint names/slugs, statuses, issue types, priorities, and severities.
- Before changing a story, task, issue, or epic, use `patch`; it fetches the current object and includes its `version` for Taiga optimistic concurrency control.
- Do not delete anything unless the user explicitly asked to delete/remove it. Only then use `--confirm`.
- Do not silently guess between ambiguous members, sprints, or statuses. The helper fails and returns the candidates; use that information to resolve the ambiguity.
- For reads, perform them directly. For normal reversible writes such as create, assign, move, close, reopen, or edit, perform the requested action directly when the user's intent is clear.
- Summarize the result in user terms. Prefer Taiga refs, subjects, statuses, assignees, and sprint names over raw ids.

## Setup

The files must stay together:

```text
taiga/
├── SKILL.md
├── taiga.py
└── .env
```

Fill `.env` with the Taiga API URL, username, password, and default project slug. For Taiga Cloud the API URL is already set to `https://api.taiga.io/api/v1`.

The helper uses only Python's standard library.

## Commands

Assume `TAIGA` is the path to `taiga.py` in this skill directory:

```bash
python3 "$TAIGA" me
python3 "$TAIGA" projects
python3 "$TAIGA" project
python3 "$TAIGA" members
python3 "$TAIGA" sprints
python3 "$TAIGA" meta
```

`meta` is the quickest way to inspect members, sprints, story/task/issue statuses, issue types, priorities, and severities.

List project work:

```bash
python3 "$TAIGA" list story
python3 "$TAIGA" list task
python3 "$TAIGA" list issue
python3 "$TAIGA" list epic
python3 "$TAIGA" list sprint
```

Filters map directly to Taiga query parameters:

```bash
python3 "$TAIGA" list story --query status__is_closed=false
python3 "$TAIGA" list story --query assigned_to=me
python3 "$TAIGA" list task --query assigned_to=me
python3 "$TAIGA" list story --query milestone="Sprint 1"
```

Get one item. Visible refs are preferred:

```bash
python3 "$TAIGA" get story '#42'
python3 "$TAIGA" get task '#87'
python3 "$TAIGA" get issue '#15'
python3 "$TAIGA" get epic '#3'
python3 "$TAIGA" get sprint 'Sprint 1'
```

Create items with JSON. `project` is added automatically:

```bash
python3 "$TAIGA" create story --data '{"subject":"Add challenge eligibility endpoint","description":"Implement eligibility lookup and response contract.","status":"New","milestone":"Sprint 1","assigned_to":"me"}'

python3 "$TAIGA" create task --data '{"subject":"Add controller tests","user_story":"#42","assigned_to":"Nacho"}'

python3 "$TAIGA" create issue --data '{"subject":"Eligibility returns stale attempts","type":"Bug","priority":"High","severity":"Important","assigned_to":"me"}'
```

Patch items. Common names are resolved automatically and OCC `version` is handled by the helper:

```bash
python3 "$TAIGA" patch story '#42' --data '{"status":"In progress"}'
python3 "$TAIGA" patch story '#42' --data '{"milestone":"Sprint 2"}'
python3 "$TAIGA" patch task '#87' --data '{"assigned_to":"me"}'
python3 "$TAIGA" patch issue '#15' --data '{"status":"Closed"}'
```

To move a story back to the backlog:

```bash
python3 "$TAIGA" patch story '#42' --data '{"milestone":null}'
```

Delete only after an explicit user request:

```bash
python3 "$TAIGA" delete story '#42' --confirm
```

Resolve human-readable values when needed:

```bash
python3 "$TAIGA" lookup member 'Nacho'
python3 "$TAIGA" lookup sprint 'Sprint 1'
python3 "$TAIGA" lookup story-status 'In progress'
python3 "$TAIGA" lookup task-status 'Done'
python3 "$TAIGA" lookup issue-type 'Bug'
python3 "$TAIGA" lookup priority 'High'
```

## Raw API fallback

Use `raw` when the user needs a Taiga endpoint not wrapped above, such as attachments, history, watchers, custom attributes, webhooks, bulk operations, or wiki pages.

```bash
python3 "$TAIGA" raw GET /history/userstory/123
python3 "$TAIGA" raw GET /userstories/filters_data --query project=123
python3 "$TAIGA" raw POST /userstories/123/watch
```

Use the official API docs to verify the endpoint and payload before a raw write. If the endpoint modifies an existing versioned object, fetch the object first and include its current `version` when Taiga requires it.

## Common workflows

When asked "what do I have to do?", get `me`, then list open stories/tasks/issues assigned to that user. If the request is about the current sprint, inspect `sprints` first and filter by its id.

When asked to start work on `#N`, first identify the object type if it is not stated. Taiga refs can overlap across stories, tasks, and issues. Then patch its status to the project's in-progress equivalent and assign it if requested.

When asked to finish work, inspect available statuses with `meta`. Use the actual closed/done status configured by the project instead of assuming the name is always `Done` or `Closed`.

When creating a task under a user story, pass the story ref in `user_story`; the helper resolves it to the internal id.

When reporting results, show concise information such as `#42 Add challenge eligibility endpoint -> In progress, Sprint 1, assigned to Nacho`. Do not dump raw JSON unless the user asks for it.
