#!/usr/bin/env python3
"""
Jira Admin CLI — Programmatic Jira Cloud administration.

Manages epics, stories, subtasks, sprints and assignments using Jira Cloud
REST APIs. Credentials are stored in ../config/credentials.json relative to
this script.
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# --- Paths ---
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CREDENTIALS_FILE = CONFIG_DIR / "credentials.json"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

PROJECT_CONFIG_FILE = CONFIG_DIR / "project.json"

# Ultimate fallback defaults for optional values.
# Override them per-project by running: jira.py config --project KEY --board ID
HARDCODED_DEFAULTS = {
    "project": "RN412023",
    "labels": ["tfi"],
    "storyPointsField": "customfield_10016",
    "issueTypes": {
        "epic": "10009",
        "story": "10008",
        "task": "10006",
        "bug": "10007",
        "subtask": "10010",
    },
    "baseUrl": "https://tecnicatura-team-412023.atlassian.net",
}

# --- Issue type IDs for the current Jira Cloud project schema ---
ISSUE_TYPES = {
    "epic": "10009",
    "story": "10008",
    "task": "10006",
    "bug": "10007",
    "subtask": "10010",
}

STORY_POINTS_FIELD = "customfield_10016"
BULK_CREATE_LIMIT = 50
SPRINT_ASSIGN_LIMIT = 50
TRANSIENT_STATUS_CODES = {429, 502, 503, 504}


def die(msg):
    """Print an error message and terminate the CLI with a failing status."""
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


# =========================================================================
# Credentials
# =========================================================================


def load_credentials():
    """Load Jira credentials from the skill configuration file."""
    if not CREDENTIALS_FILE.exists():
        die(
            f"No credentials found at {CREDENTIALS_FILE}.\n"
            f"Run: {sys.argv[0]} auth --email you@example.com --token \"your-api-token\""
        )
    with open(CREDENTIALS_FILE, encoding="utf-8") as f:
        creds = json.load(f)
    for key in ("email", "token"):
        if key not in creds:
            die(f"Missing '{key}' in {CREDENTIALS_FILE}")
    return creds


# =========================================================================
# Project configuration
# =========================================================================


def project_config():
    """Load project-scoped configuration merged on top of HARDCODED_DEFAULTS."""
    config = dict(HARDCODED_DEFAULTS)
    if PROJECT_CONFIG_FILE.exists():
        with open(PROJECT_CONFIG_FILE, encoding="utf-8") as f:
            user_config = json.load(f)
            config.update(user_config)
            if "issueTypes" in user_config:
                config["issueTypes"] = {
                    **HARDCODED_DEFAULTS["issueTypes"],
                    **user_config["issueTypes"],
                }
    return config


def apply_project_config():
    """Update module-level constants from project config (called once at startup)."""
    cfg = project_config()
    global ISSUE_TYPES, STORY_POINTS_FIELD
    if cfg.get("issueTypes"):
        ISSUE_TYPES = dict(cfg["issueTypes"])
    if cfg.get("storyPointsField"):
        STORY_POINTS_FIELD = cfg["storyPointsField"]


def resolve_project(args):
    """Resolve project key: explicit CLI arg > project config > HARDCODED_DEFAULTS."""
    val = getattr(args, "project", None)
    if val:
        return val
    return project_config().get("project", HARDCODED_DEFAULTS["project"])


def resolve_labels(args):
    """Resolve labels: explicit CLI arg > project config > HARDCODED_DEFAULTS."""
    val = getattr(args, "labels", None)
    if val is not None:
        return val
    return project_config().get("labels", HARDCODED_DEFAULTS["labels"])


# =========================================================================
# Auth
# =========================================================================


def cmd_auth(args):
    """Store Jira credentials on disk with user-only permissions."""
    email = args.email
    token = args.token
    base_url = getattr(args, "base_url", HARDCODED_DEFAULTS["baseUrl"])

    if not email or not token:
        die("Both --email and --token are required")

    creds = {"email": email, "token": token, "baseUrl": base_url.rstrip("/")}
    CREDENTIALS_FILE.write_text(json.dumps(creds, indent=2), encoding="utf-8")
    os.chmod(CREDENTIALS_FILE, 0o600)
    print(f"Credentials saved to {CREDENTIALS_FILE}")


# =========================================================================
# Config command
# =========================================================================


def cmd_config(args):
    """Store project-scoped configuration (project.json)."""
    cfg = project_config()
    for key in ("project", "storyPointsField"):
        val = getattr(args, key, None)
        if val is not None:
            cfg[key] = val
    if args.board is not None:
        cfg["board"] = args.board
    if args.labels is not None:
        cfg["labels"] = args.labels
    if args.base_url is not None:
        cfg["baseUrl"] = args.base_url

    issue_types = {}
    if args.epic_type:
        issue_types["epic"] = args.epic_type
    if args.story_type:
        issue_types["story"] = args.story_type
    if args.subtask_type:
        issue_types["subtask"] = args.subtask_type
    if args.task_type:
        issue_types["task"] = args.task_type
    if args.bug_type:
        issue_types["bug"] = args.bug_type
    if issue_types:
        cfg.setdefault("issueTypes", {}).update(issue_types)

    # Strip entries that match HARDCODED_DEFAULTS to keep the file minimal
    for key in list(cfg.keys()):
        if key in HARDCODED_DEFAULTS and cfg[key] == HARDCODED_DEFAULTS[key]:
            if key == "issueTypes":
                continue  # handled below
            del cfg[key]
    if "issueTypes" in cfg and cfg["issueTypes"] == HARDCODED_DEFAULTS.get("issueTypes"):
        del cfg["issueTypes"]
    if "baseUrl" in cfg and cfg["baseUrl"] == HARDCODED_DEFAULTS.get("baseUrl"):
        del cfg["baseUrl"]

    PROJECT_CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    print(f"Project config saved to {PROJECT_CONFIG_FILE}")
    if cfg:
        print(json.dumps(cfg, indent=2))
    else:
        print("(empty -- all values match hardcoded defaults)")


# =========================================================================
# HTTP client
# =========================================================================


class JiraClient:
    """Small Jira Cloud REST client implemented with Python standard library."""

    def __init__(self, credentials=None, timeout=30, max_retries=4):
        """Initialize authentication, base URL, timeout and retry settings."""
        self.credentials = credentials or load_credentials()
        self.base_url = self.credentials.get(
            "baseUrl", "https://tecnicatura-team-412023.atlassian.net"
        ).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        auth = f"{self.credentials['email']}:{self.credentials['token']}".encode("utf-8")
        self.auth_header = "Basic " + base64.b64encode(auth).decode("ascii")

    def request(self, method, path, data=None, query=None):
        """Execute an HTTP request with JSON parsing and safe retry behavior."""
        url = self._url(path, query)
        body = None if data is None else json.dumps(data).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": self.auth_header,
            "User-Agent": "pi-jira-admin/2.0",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        for attempt in range(self.max_retries + 1):
            request = Request(url, data=body, headers=headers, method=method)
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    return self._decode_response(response.read())
            except HTTPError as exc:
                payload = self._decode_response(exc.read())
                if exc.code in TRANSIENT_STATUS_CODES and attempt < self.max_retries:
                    self._sleep_before_retry(exc, attempt)
                    continue
                return self._error_payload(exc.code, payload)
            except URLError as exc:
                if attempt < self.max_retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                return {"_error": str(exc.reason)}

        return {"_error": "Request failed after retries"}

    def get(self, path, query=None):
        """Execute a GET request."""
        return self.request("GET", path, query=query)

    def post(self, path, data, query=None):
        """Execute a POST request."""
        return self.request("POST", path, data=data, query=query)

    def put(self, path, data, query=None):
        """Execute a PUT request."""
        return self.request("PUT", path, data=data, query=query)

    def delete(self, path, query=None):
        """Execute a DELETE request."""
        return self.request("DELETE", path, query=query)

    def _url(self, path, query=None):
        """Build an absolute Jira API URL from a path and query parameters."""
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urlencode(query, doseq=True)}"
        return url

    def _decode_response(self, raw):
        """Decode a JSON response body, returning an empty dict for empty bodies."""
        if not raw:
            return {}
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"_raw": text[:500], "_error": "Invalid JSON response"}

    def _error_payload(self, status_code, payload):
        """Normalize Jira HTTP errors into a printable dictionary."""
        if isinstance(payload, dict):
            payload.setdefault("_status", status_code)
            return payload
        return {"_status": status_code, "_error": str(payload)}

    def _sleep_before_retry(self, exc, attempt):
        """Respect Retry-After when present, otherwise use exponential backoff."""
        retry_after = exc.headers.get("Retry-After")
        if retry_after:
            try:
                delay = int(retry_after)
            except ValueError:
                delay = min(2 ** attempt, 8)
        else:
            delay = min(2 ** attempt, 8)
        print(f"  Jira returned {exc.code}; retrying in {delay}s...", file=sys.stderr)
        time.sleep(delay)


_CLIENT = None


def client():
    """Return a process-wide Jira client so credentials are loaded once."""
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = JiraClient()
    return _CLIENT


def get(path, query=None):
    """Compatibility wrapper for existing command code."""
    return client().get(path, query=query)


def post(path, data, query=None):
    """Compatibility wrapper for existing command code."""
    return client().post(path, data, query=query)


def put(path, data, query=None):
    """Compatibility wrapper for existing command code."""
    return client().put(path, data, query=query)


def delete(path, query=None):
    """Compatibility wrapper for existing command code."""
    return client().delete(path, query=query)


# =========================================================================
# Test / Info
# =========================================================================


def cmd_test(args):
    """Test connection by fetching project info."""
    project = resolve_project(args)
    result = get(f"/rest/api/3/project/{project}")
    if "key" in result:
        print(f"OK - Project: {result['key']} ({result.get('name', '?')})")
        print(f"  Lead: {result.get('lead', {}).get('displayName', '?')}")
        for issue_type in result.get("issueTypes", []):
            print(f"  Issue type: {issue_type['name']} (ID={issue_type['id']})")
    else:
        print(f"Error: {format_error(result)}")


def cmd_info(args):
    """Show project metadata."""
    if not getattr(args, "project", None):
        args.project = resolve_project(args)
    cmd_test(args)


# =========================================================================
# Pagination and listing
# =========================================================================


def fetch_paginated(path, item_key, query=None, max_results=100):
    """Fetch all pages for Jira endpoints that use startAt/maxResults pagination."""
    items = []
    start_at = 0
    query = dict(query or {})
    while True:
        page_query = dict(query)
        page_query.update({"startAt": start_at, "maxResults": max_results})
        data = get(path, query=page_query)
        page_items = data.get(item_key, [])
        items.extend(page_items)
        if data.get("isLast") is True:
            break
        total = data.get("total")
        start_at += len(page_items)
        if not page_items or (total is not None and start_at >= total):
            break
    return items


def fetch_board_issues(board, fields, max_results=100):
    """Fetch every issue visible on a board with a constrained field list."""
    return fetch_paginated(
        f"/rest/agile/1.0/board/{board}/issue",
        "issues",
        query={"fields": fields},
        max_results=max_results,
    )


def fetch_project_boards(project_key=None):
    """Fetch Jira Agile boards, optionally constrained to a project key."""
    query = {"maxResults": 50}
    if project_key:
        query["projectKeyOrId"] = project_key
    return fetch_paginated("/rest/agile/1.0/board", "values", query=query, max_results=50)


def resolve_board_id(args):
    """Return an explicit board ID or auto-detect the single board for a project."""
    if getattr(args, "board", None):
        return args.board

    project = resolve_project(args)
    boards = fetch_project_boards(project)
    if len(boards) == 1:
        board = boards[0]
        print(f"Using board {board['id']} - {board.get('name', '')}", file=sys.stderr)
        return board["id"]

    if not boards:
        die(f"No boards found for project '{project}'. Use 'list boards' to inspect available boards.")

    print("Multiple boards found. Re-run with --board ID. Available boards:", file=sys.stderr)
    for board in boards:
        location = board.get("location", {})
        print(
            f"  {board.get('id')}: {board.get('name', '')} "
            f"({location.get('projectKey', location.get('displayName', ''))})",
            file=sys.stderr,
        )
    die("Board auto-detection is ambiguous")


def cmd_list(args):
    """List boards, epics, issues, or sprints."""
    kind = args.kind

    if kind == "boards":
        project = getattr(args, "project", None) or resolve_project(args)
        boards = fetch_project_boards(project)
        print(f"{'ID':>5}  {'Type':10}  {'Name':35}  {'Project'}")
        print("-" * 80)
        for board in boards:
            location = board.get("location", {})
            project = location.get("projectKey") or location.get("displayName", "")
            print(f"{board.get('id', '?'):>5}  {board.get('type', '?'):10}  {board.get('name', '')[:35]:35}  {project}")
    elif kind == "sprints":
        board = resolve_board_id(args)
        sprints = fetch_paginated(f"/rest/agile/1.0/board/{board}/sprint", "values")
        print(f"{'ID':>5}  {'State':10}  {'Name':35}  {'Goal':50}")
        print("-" * 105)
        for sprint in sprints:
            if args.verbose:
                issues = get(
                    f"/rest/agile/1.0/sprint/{sprint['id']}/issue",
                    query={"fields": f"{STORY_POINTS_FIELD},issuetype", "maxResults": 0},
                )
                total = issues.get("total", 0)
                print(
                    f"{sprint['id']:>5}  {sprint['state']:10}  {sprint['name'][:35]:35}  "
                    f"{sprint.get('goal', '')[:50]:50}  ({total} issues)"
                )
            else:
                print(f"{sprint['id']:>5}  {sprint['state']:10}  {sprint['name'][:35]:35}")
    elif kind == "epics":
        board = resolve_board_id(args)
        epics = fetch_paginated(f"/rest/agile/1.0/board/{board}/epic", "values")
        print(f"{'Key':15}  {'Summary'}")
        print("-" * 60)
        for epic in epics:
            print(f"{epic.get('key', '?'):15}  {epic.get('summary', '?')[:50]}")
    elif kind == "issues":
        board = resolve_board_id(args)
        issues = fetch_board_issues(board, f"summary,issuetype,{STORY_POINTS_FIELD}", args.max_results)
        print(f"{'Key':15}  {'Type':8}  {'SP':4}  {'Summary'}")
        print("-" * 70)
        for issue in issues:
            fields = issue.get("fields", {})
            issue_type = fields.get("issuetype", {}).get("name", "?")
            points = fields.get(STORY_POINTS_FIELD, "")
            points_text = f"{points:.0f}" if points else "-"
            print(
                f"{issue.get('key', '?'):15}  {issue_type:8}  {points_text:4}  "
                f"{fields.get('summary', '?')[:50]}"
            )
    else:
        die(f"Unknown kind: {kind}. Use: boards, sprints, epics, issues")


# =========================================================================
# Issue payload builders and creators
# =========================================================================


def make_issue_payload(project, issue_type, summary, description="", parent_key=None, points=None, labels=None):
    """Build a Jira issue create payload for single and bulk create endpoints."""
    fields = {
        "project": {"key": project},
        "issuetype": {"id": ISSUE_TYPES[issue_type]},
        "summary": summary[:255],
    }
    doc = _make_doc(description)
    if doc:
        fields["description"] = doc
    if parent_key:
        fields["parent"] = {"key": parent_key}
    if points is not None:
        fields[STORY_POINTS_FIELD] = points
    if labels:
        fields["labels"] = labels
    return {"fields": fields}


def cmd_create_epic(args):
    """Create an epic."""
    project = resolve_project(args)
    payload = make_issue_payload(project, "epic", args.summary, args.description or "")
    result = post("/rest/api/3/issue", payload)
    if "key" in result:
        print(f"Created epic: {result['key']} - {args.summary}")
        return result["key"]
    print(f"Error: {format_error(result)}", file=sys.stderr)
    return None


def cmd_create_story(args):
    """Create a story and optionally create subtasks below it."""
    project = resolve_project(args)
    labels = resolve_labels(args)
    payload = make_issue_payload(
        project,
        "story",
        args.summary,
        args.description or "",
        parent_key=args.parent,
        points=args.points or 0,
        labels=labels,
    )
    result = post("/rest/api/3/issue", payload)
    if "key" not in result and len(args.summary) > 80:
        payload["fields"]["summary"] = args.summary[:80]
        result = post("/rest/api/3/issue", payload)

    if "key" in result:
        story_key = result["key"]
        print(f"Created story: {story_key} - {args.summary} ({args.points or 0} SP)")
        for task_summary in args.tasks or []:
            subtask_key = _create_subtask(task_summary, story_key, project)
            if subtask_key:
                print(f"  Created subtask: {subtask_key} - {task_summary[:60]}")
        return story_key

    print(f"Error creating story: {format_error(result)}", file=sys.stderr)
    return None


def _create_subtask(summary, parent_key, project):
    """Create a single subtask under a parent story using the real project key."""
    labels = project_config().get("labels", HARDCODED_DEFAULTS["labels"])
    payload = make_issue_payload(
        project,
        "subtask",
        summary[:80],
        summary,
        parent_key=parent_key,
        labels=labels,
    )
    result = post("/rest/api/3/issue", payload)
    if "key" in result:
        return result["key"]
    print(f"  Warning: subtask '{summary[:40]}' failed: {format_error(result)}", file=sys.stderr)
    return None


def cmd_create_subtask(args):
    """Create one or more subtasks."""
    project = resolve_project(args)
    for summary in args.summary:
        key = _create_subtask(summary, args.parent, project)
        if key:
            print(f"Created subtask: {key} - {summary[:60]}")


def bulk_create_issues(issue_updates, label):
    """Create issues in Jira bulk batches and return result records in input order."""
    ordered_results = []
    for batch_number, batch in enumerate(chunked(issue_updates, BULK_CREATE_LIMIT), start=1):
        result = post("/rest/api/3/issue/bulk", {"issueUpdates": [item["payload"] for item in batch]})
        batch_results = map_bulk_create_response(batch, result)
        ordered_results.extend(batch_results)
        ok_count = sum(1 for item in batch_results if item.get("key"))
        print(f"  {label} batch {batch_number}: created {ok_count}/{len(batch)}")
        for item in batch_results:
            if item.get("error"):
                print(f"    Failed {item['summary'][:60]}: {item['error']}", file=sys.stderr)
    return ordered_results


def map_bulk_create_response(batch, result):
    """Map Jira bulk create successes and errors back to the original batch order."""
    mapped = [
        {"summary": item["summary"], "key": None, "error": None, "meta": item.get("meta", {})}
        for item in batch
    ]
    if not isinstance(result, dict):
        for item in mapped:
            item["error"] = "Unexpected bulk response"
        return mapped

    errors_by_index = {}
    for error in result.get("errors", []):
        index = error.get("failedElementNumber")
        if index is not None:
            errors_by_index[index] = format_error(error)

    successes = iter(result.get("issues", []))
    for index, item in enumerate(mapped):
        if index in errors_by_index:
            item["error"] = errors_by_index[index]
            continue
        issue = next(successes, None)
        if issue and issue.get("key"):
            item["key"] = issue["key"]
        else:
            item["error"] = format_error(result) if result.get("_status") else "Missing issue in bulk response"
    return mapped


# =========================================================================
# Sprints and assignments
# =========================================================================


def cmd_create_sprint(args):
    """Create a sprint on the explicit or auto-detected project board."""
    board = resolve_board_id(args)
    name = args.name
    goal = args.goal or ""

    if len(name) > 30:
        die(f"Sprint name must be <= 30 characters. Got {len(name)}: '{name}'")

    result = post("/rest/agile/1.0/sprint", {"name": name, "goal": goal, "originBoardId": board})
    if "id" in result:
        print(f"Created sprint: ID={result['id']} - {name}")
        return result["id"]
    print(f"Error: {format_error(result)}", file=sys.stderr)
    return None


def cmd_update_sprint(args):
    """Update sprint name and/or goal."""
    data = {}
    if args.name:
        if len(args.name) > 30:
            die("Sprint name must be <= 30 characters")
        data["name"] = args.name
    if args.goal:
        data["goal"] = args.goal

    if not data:
        print("Nothing to update. Provide --name and/or --goal.")
        return

    result = put(f"/rest/agile/1.0/sprint/{args.id}", data)
    if "id" in result:
        print(f"Updated sprint {args.id}: name='{result.get('name', '')}' goal='{result.get('goal', '')}'")
    else:
        print(f"Error: {format_error(result)}", file=sys.stderr)


def cmd_assign(args):
    """Assign issues to a sprint by explicit keys, HU prefixes, or source sprint."""
    sprint_id = args.sprint
    issue_keys = list(args.issues or [])

    if args.by_hu:
        issue_keys.extend(resolve_hu_keys(args.by_hu, resolve_board_id(args)))

    if args.from_sprint:
        source_issues = fetch_paginated(
            f"/rest/agile/1.0/sprint/{args.from_sprint}/issue",
            "issues",
            query={"fields": "issuetype"},
        )
        moved = 0
        for issue in source_issues:
            fields = issue.get("fields", {})
            if fields.get("issuetype", {}).get("name") == "Story":
                issue_keys.append(issue.get("key"))
                moved += 1
        print(f"Moved {moved} stories from sprint {args.from_sprint}")

    issue_keys = dedupe([key for key in issue_keys if key])
    if not issue_keys:
        die("No issues to assign. Provide --issues, --by-hu or --from-sprint.")

    assign_issues_to_sprint(sprint_id, issue_keys)


def assign_issues_to_sprint(sprint_id, issue_keys):
    """Assign issue keys to a sprint in Jira-supported batches."""
    total = len(issue_keys)
    assigned = 0
    for index, batch in enumerate(chunked(issue_keys, SPRINT_ASSIGN_LIMIT), start=1):
        result = post(f"/rest/agile/1.0/sprint/{sprint_id}/issue", {"issues": batch})
        if isinstance(result, dict) and result.get("errorMessages"):
            print(f"  Batch error: {result['errorMessages']}", file=sys.stderr)
        else:
            assigned += len(batch)
            print(f"  Batch {index}: assigned {len(batch)} issues to sprint {sprint_id}")
    print(f"Total: {assigned}/{total} issues assigned.")
    return assigned


def resolve_hu_keys(hu_prefixes, board=2):
    """Resolve HU prefixes to Jira issue keys using one paginated board query."""
    issues = fetch_board_issues(board, "summary,issuetype")
    return resolve_hu_keys_from_issues(hu_prefixes, issues)


def resolve_hu_keys_from_issues(hu_prefixes, issues):
    """Resolve HU prefixes from an existing issue collection without more API calls."""
    resolved = []
    for issue in issues:
        fields = issue.get("fields", {})
        if fields.get("issuetype", {}).get("name") != "Story":
            continue
        summary = fields.get("summary", "")
        for prefix in hu_prefixes:
            if summary.startswith(prefix) or prefix in summary:
                resolved.append(issue.get("key"))
                break
    return dedupe([key for key in resolved if key])


# =========================================================================
# Bulk from plan JSON
# =========================================================================


def cmd_create_from_plan(args):
    """Create epics, stories, subtasks, sprints and assignments from a JSON plan."""
    plan = load_plan(args.plan)
    errors = validate_plan(plan)
    if errors:
        for error in errors:
            print(f"Validation error: {error}", file=sys.stderr)
        die("Plan validation failed")

    project = plan.get("project") or resolve_project(args)
    board = plan.get("board") or resolve_board_id(argparse.Namespace(board=None, project=project))
    summary = summarize_plan(plan)

    if args.dry_run:
        print_dry_run(summary, plan, board=board)
        return

    report = {
        "epics": 0,
        "stories": 0,
        "subtasks": 0,
        "sprints": 0,
        "assignments": 0,
        "errors": [],
    }

    print("Creating epics in bulk...")
    epic_items = []
    for epic_def in plan.get("epics", []):
        epic_items.append(
            {
                "summary": epic_def["summary"],
                "payload": make_issue_payload(project, "epic", epic_def["summary"], epic_def.get("description", "")),
                "meta": {"epic": epic_def},
            }
        )
    epic_results = bulk_create_issues(epic_items, "Epic") if epic_items else []
    epic_keys = {item["summary"]: item["key"] for item in epic_results if item.get("key")}
    report["epics"] = len(epic_keys)
    collect_errors(report, "epic", epic_results)

    print("Creating stories in bulk...")
    story_items = []
    for epic_def in plan.get("epics", []):
        epic_key = epic_keys.get(epic_def["summary"])
        if not epic_key:
            continue
        for story_def in epic_def.get("stories", []):
            story_items.append(
                {
                    "summary": story_def["summary"],
                    "payload": make_issue_payload(
                        project,
                        "story",
                        story_def["summary"],
                        story_def.get("description", ""),
                        parent_key=epic_key,
                        points=story_def.get("points", 0),
                        labels=story_def.get("labels", ["tfi"]),
                    ),
                    "meta": {"story": story_def, "epic_key": epic_key},
                }
            )
    story_results = bulk_create_issues(story_items, "Story") if story_items else []
    story_keys = {item["summary"]: item["key"] for item in story_results if item.get("key")}
    hu_map = {extract_hu(item["summary"]): item["key"] for item in story_results if item.get("key") and extract_hu(item["summary"])}
    report["stories"] = len(story_keys)
    collect_errors(report, "story", story_results)

    print("Creating subtasks in bulk...")
    subtask_items = []
    for item in story_results:
        story_key = item.get("key")
        story_def = item.get("meta", {}).get("story", {})
        if not story_key:
            continue
        for task_summary in story_def.get("tasks", []):
            subtask_items.append(
                {
                    "summary": task_summary,
                    "payload": make_issue_payload(
                        project,
                        "subtask",
                        task_summary[:80],
                        task_summary,
                        parent_key=story_key,
                        labels=story_def.get("labels", ["tfi"]),
                    ),
                    "meta": {"story_key": story_key},
                }
            )
    subtask_results = bulk_create_issues(subtask_items, "Subtask") if subtask_items else []
    report["subtasks"] = sum(1 for item in subtask_results if item.get("key"))
    collect_errors(report, "subtask", subtask_results)

    print("Creating sprints...")
    sprint_ids = {}
    for sprint_def in plan.get("sprints", []):
        sprint_id = cmd_create_sprint(
            argparse.Namespace(board=board, name=sprint_def["name"], goal=sprint_def.get("goal", ""))
        )
        if sprint_id:
            sprint_ids[sprint_def["name"]] = sprint_id
    report["sprints"] = len(sprint_ids)

    print("Assigning stories to sprints...")
    for sprint_def in plan.get("sprints", []):
        sprint_id = sprint_ids.get(sprint_def["name"])
        if not sprint_id:
            continue
        keys = []
        for ref in sprint_def.get("stories", []):
            key = hu_map.get(ref) or story_keys.get(ref)
            if key:
                keys.append(key)
        if keys:
            report["assignments"] += assign_issues_to_sprint(sprint_id, dedupe(keys))

    print_plan_report(report, plan, board, project)


def load_plan(plan_file):
    """Read a JSON plan file from disk and return its parsed content."""
    if not os.path.exists(plan_file):
        die(f"Plan file not found: {plan_file}")
    try:
        with open(plan_file, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        die(f"Invalid JSON in {plan_file}: {exc}")


def validate_plan(plan):
    """Validate a create-from-plan document before making Jira write requests."""
    errors = []
    if not isinstance(plan, dict):
        return ["Plan must be a JSON object"]
    if not plan.get("project"):
        errors.append("Missing required 'project'")
    if "epics" in plan and not isinstance(plan["epics"], list):
        errors.append("'epics' must be a list")
    if "sprints" in plan and not isinstance(plan["sprints"], list):
        errors.append("'sprints' must be a list")

    story_refs = set()
    for epic_index, epic_def in enumerate(plan.get("epics", []), start=1):
        if not isinstance(epic_def, dict):
            errors.append(f"Epic #{epic_index} must be an object")
            continue
        if not epic_def.get("summary"):
            errors.append(f"Epic #{epic_index} is missing summary")
        if not isinstance(epic_def.get("stories", []), list):
            errors.append(f"Epic '{epic_def.get('summary', epic_index)}' stories must be a list")
            continue
        for story_index, story_def in enumerate(epic_def.get("stories", []), start=1):
            if not isinstance(story_def, dict):
                errors.append(f"Story #{story_index} in epic '{epic_def.get('summary', epic_index)}' must be an object")
                continue
            summary = story_def.get("summary")
            if not summary:
                errors.append(f"Story #{story_index} in epic '{epic_def.get('summary', epic_index)}' is missing summary")
                continue
            story_refs.add(summary)
            hu = extract_hu(summary)
            if hu:
                story_refs.add(hu)
            if not isinstance(story_def.get("tasks", []), list):
                errors.append(f"Story '{summary}' tasks must be a list")

    for sprint_index, sprint_def in enumerate(plan.get("sprints", []), start=1):
        if not isinstance(sprint_def, dict):
            errors.append(f"Sprint #{sprint_index} must be an object")
            continue
        name = sprint_def.get("name")
        if not name:
            errors.append(f"Sprint #{sprint_index} is missing name")
        elif len(name) > 30:
            errors.append(f"Sprint '{name}' name must be <= 30 characters")
        if not isinstance(sprint_def.get("stories", []), list):
            errors.append(f"Sprint '{name or sprint_index}' stories must be a list")
            continue
        for story_ref in sprint_def.get("stories", []):
            if story_ref not in story_refs:
                errors.append(f"Sprint '{name}' references unknown story '{story_ref}'")
    return errors


def summarize_plan(plan):
    """Count the main resources described by a plan."""
    epics = len(plan.get("epics", []))
    stories = 0
    subtasks = 0
    for epic_def in plan.get("epics", []):
        for story_def in epic_def.get("stories", []):
            stories += 1
            subtasks += len(story_def.get("tasks", []))
    return {"epics": epics, "stories": stories, "subtasks": subtasks, "sprints": len(plan.get("sprints", []))}


def print_dry_run(summary, plan, board=None):
    """Print the write operations that would be performed without calling Jira."""
    print("Dry run: no Jira write requests will be made.")
    print(f"Project: {plan.get('project')}")
    print(f"Board: {board or plan.get('board', '?')}")
    print(
        "Would create: "
        f"{summary['epics']} epics, {summary['stories']} stories, "
        f"{summary['subtasks']} subtasks, {summary['sprints']} sprints"
    )
    for epic_def in plan.get("epics", []):
        print(f"  Epic: {epic_def['summary']}")
        for story_def in epic_def.get("stories", []):
            print(f"    Story: {story_def['summary']} ({story_def.get('points', 0)} SP)")
            for task_summary in story_def.get("tasks", []):
                print(f"      Subtask: {task_summary}")
    for sprint_def in plan.get("sprints", []):
        print(f"  Sprint: {sprint_def['name']} -> {', '.join(sprint_def.get('stories', []))}")


def collect_errors(report, kind, results):
    """Append bulk operation errors to the final report."""
    for item in results:
        if item.get("error"):
            report["errors"].append(f"{kind} '{item['summary']}': {item['error']}")


def print_plan_report(report, plan, board, project):
    """Print a concise create-from-plan summary and the Jira board URL."""
    print("\nDone.")
    print(f"  Epics created: {report['epics']}")
    print(f"  Stories created: {report['stories']}")
    print(f"  Subtasks created: {report['subtasks']}")
    print(f"  Sprints created: {report['sprints']}")
    print(f"  Story sprint assignments: {report['assignments']}")
    if report["errors"]:
        print("  Errors:", file=sys.stderr)
        for error in report["errors"]:
            print(f"    - {error}", file=sys.stderr)
    site = plan.get("site") or client().base_url.replace("https://", "").split(".")[0]
    print("Review at:")
    print(f"  https://{site}.atlassian.net/jira/software/projects/{project}/boards/{board}")


# =========================================================================
# Helpers
# =========================================================================


def _make_doc(text):
    """Create an Atlassian Document Format body from plain text."""
    if not text:
        return None
    content = []
    for line in text.strip().split("\n"):
        content.append({"type": "paragraph", "content": [{"type": "text", "text": line}]})
    return {"type": "doc", "version": 1, "content": content}


def extract_hu(summary):
    """Extract a HU-XX prefix from a story summary when present."""
    if not isinstance(summary, str):
        return None
    text = summary.strip()
    if not text.startswith("HU-"):
        return None
    return text.split(":", 1)[0].strip()


def chunked(items, size):
    """Yield fixed-size chunks from a sequence."""
    for index in range(0, len(items), size):
        yield items[index : index + size]


def dedupe(items):
    """Return items with duplicates removed while preserving first-seen order."""
    seen = set()
    unique = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)
    return unique


def format_error(result):
    """Format Jira error payloads into concise human-readable text."""
    if not isinstance(result, dict):
        return str(result)
    parts = []
    if result.get("_status"):
        parts.append(f"HTTP {result['_status']}")
    if result.get("errorMessages"):
        parts.extend(result["errorMessages"])
    if result.get("errors"):
        parts.append(json.dumps(result["errors"], ensure_ascii=False))
    if result.get("message"):
        parts.append(str(result["message"]))
    if result.get("_error"):
        parts.append(str(result["_error"]))
    if result.get("elementErrors"):
        parts.append(json.dumps(result["elementErrors"], ensure_ascii=False))
    return "; ".join(parts) if parts else json.dumps(result, ensure_ascii=False)[:500]


# =========================================================================
# CLI
# =========================================================================


def main():
    """Parse command-line arguments and dispatch to the selected command."""
    parser = argparse.ArgumentParser(
        description="Jira Admin CLI - Programmatic Jira Cloud management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to execute")

    p_config = sub.add_parser("config", help="Set project-scoped defaults (saved to project.json)")
    p_config.add_argument("--project", default=None, help="Default project key")
    p_config.add_argument("--board", type=int, default=None, help="Default board ID")
    p_config.add_argument("--labels", nargs="*", default=None, help="Default issue labels")
    p_config.add_argument("--story-points-field", default=None, help="Story points custom field ID")
    p_config.add_argument("--epic-type", default=None, help="Epic issue type ID")
    p_config.add_argument("--story-type", default=None, help="Story issue type ID")
    p_config.add_argument("--subtask-type", default=None, help="Subtask issue type ID")
    p_config.add_argument("--task-type", default=None, help="Task issue type ID")
    p_config.add_argument("--bug-type", default=None, help="Bug issue type ID")
    p_config.add_argument("--base-url", default=None, help="Default Jira base URL")

    p_auth = sub.add_parser("auth", help="Store Jira credentials")
    p_auth.add_argument("--email", required=True, help="Atlassian account email")
    p_auth.add_argument("--token", required=True, help="Atlassian API token")
    p_auth.add_argument("--base-url", help="Jira base URL (default: config or hardcoded)")

    p_test = sub.add_parser("test", help="Test API connection")
    p_test.add_argument("--project", default=None, help="Project key (default: config or hardcoded)")
    p_info = sub.add_parser("info", help="Show project info")
    p_info.add_argument("--project", default=None, help="Project key (default: config or hardcoded)")

    p_list = sub.add_parser("list", help="List resources (boards, sprints, epics, issues)")
    p_list.add_argument("kind", choices=["boards", "sprints", "epics", "issues"], help="What to list")
    p_list.add_argument("--board", type=int, help="Board ID. If omitted, the script auto-detects the project board when possible.")
    p_list.add_argument("--project", default=None, help="Project key used for board auto-detection (default: config or hardcoded)")
    p_list.add_argument("--max-results", type=int, default=100, help="Page size for issue listing")
    p_list.add_argument("--verbose", "-v", action="store_true", help="Show details")

    p_create = sub.add_parser("create", help="Create resources (epic, story, subtask, sprint)")
    create_sub = p_create.add_subparsers(dest="create_type")

    p_epic = create_sub.add_parser("epic", help="Create an epic")
    p_epic.add_argument("--project", default=None, help="Project key (default: config or hardcoded)")
    p_epic.add_argument("--summary", required=True)
    p_epic.add_argument("--description", default="")

    p_story = create_sub.add_parser("story", help="Create a user story")
    p_story.add_argument("--project", default=None, help="Project key (default: config or hardcoded)")
    p_story.add_argument("--summary", required=True)
    p_story.add_argument("--parent", required=True, help="Epic key (e.g. RN412023-2)")
    p_story.add_argument("--points", type=int, default=0, help="Story points")
    p_story.add_argument("--description", default="")
    p_story.add_argument("--tasks", nargs="*", default=[], help="Subtask summaries")
    p_story.add_argument("--labels", nargs="*", default=None, help="Issue labels (default: config or ['tfi'])")

    p_subtask = create_sub.add_parser("subtask", help="Create one or more subtasks")
    p_subtask.add_argument("--project", default=None, help="Project key (default: config or hardcoded)")
    p_subtask.add_argument("--parent", required=True, help="Parent story key")
    p_subtask.add_argument("summary", nargs="+", help="Subtask summary or summaries")

    p_sprint = create_sub.add_parser("sprint", help="Create a sprint")
    p_sprint.add_argument("--board", type=int, help="Board ID. If omitted, the script auto-detects the project board when possible.")
    p_sprint.add_argument("--project", default=None, help="Project key used for board auto-detection (default: config or hardcoded)")
    p_sprint.add_argument("--name", required=True)
    p_sprint.add_argument("--goal", default="")

    p_update = sub.add_parser("update", help="Update sprint")
    update_sub = p_update.add_subparsers(dest="update_type")
    p_update_sprint = update_sub.add_parser("sprint", help="Update sprint name/goal")
    p_update_sprint.add_argument("--id", type=int, required=True)
    p_update_sprint.add_argument("--name", help="New name (max 30 chars)")
    p_update_sprint.add_argument("--goal", help="New goal")

    p_assign = sub.add_parser("assign", help="Assign issues to a sprint")
    p_assign.add_argument("--sprint", type=int, required=True, help="Sprint ID")
    p_assign.add_argument("--board", type=int, help="Board ID. If omitted, the script auto-detects the project board when possible.")
    p_assign.add_argument("--project", default=None, help="Project key used for board auto-detection (default: config or hardcoded)")
    p_assign.add_argument("--issues", nargs="*", default=[], help="Issue keys")
    p_assign.add_argument("--by-hu", nargs="*", default=[], help="HU prefixes (e.g. HU-01 HU-02)")
    p_assign.add_argument("--from-sprint", type=int, help="Move all stories from another sprint")

    p_plan = sub.add_parser("create-from-plan", help="Bulk create from JSON plan")
    p_plan.add_argument("plan", help="Path to JSON plan file")
    p_plan.add_argument("--dry-run", action="store_true", help="Validate and print planned writes without calling Jira")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    # Load project config and apply it to module-level globals
    if args.command != "auth":
        apply_project_config()

    handlers = {
        "config": cmd_config,
        "auth": cmd_auth,
        "test": cmd_test,
        "info": cmd_info,
        "list": cmd_list,
        "create-from-plan": cmd_create_from_plan,
        "assign": cmd_assign,
    }

    if args.command in handlers:
        handlers[args.command](args)
    elif args.command == "create":
        create_handlers = {
            "epic": cmd_create_epic,
            "story": cmd_create_story,
            "subtask": cmd_create_subtask,
            "sprint": cmd_create_sprint,
        }
        handler = create_handlers.get(args.create_type)
        if handler:
            handler(args)
        else:
            p_create.print_help()
    elif args.command == "update":
        if args.update_type == "sprint":
            cmd_update_sprint(args)
        else:
            die("Use: update sprint --id N --name ...")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
