#!/usr/bin/env python3
"""
Jira Admin CLI — Programmatic Jira Cloud administration.

Manages epics, stories, subtasks, sprints and assignments.
Credentials stored in ../config/credentials.json relative to this script.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

# --- Paths ---
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CREDENTIALS_FILE = CONFIG_DIR / "credentials.json"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# --- Issue type IDs for standard Jira Cloud ---
ISSUE_TYPES = {
    "epic": "10009",
    "story": "10008",
    "task": "10006",
    "bug": "10007",
    "subtask": "10010",
}


def die(msg):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


# =========================================================================
# Credentials
# =========================================================================


def load_credentials():
    """Load credentials from config file."""
    if not CREDENTIALS_FILE.exists():
        die(
            f"No credentials found at {CREDENTIALS_FILE}.\n"
            f"Run: {sys.argv[0]} auth --email you@example.com --token \"your-api-token\""
        )
    with open(CREDENTIALS_FILE) as f:
        creds = json.load(f)
    for key in ("email", "token"):
        if key not in creds:
            die(f"Missing '{key}' in {CREDENTIALS_FILE}")
    return creds


def cmd_auth(args):
    """Store Jira credentials."""
    email = args.email
    token = args.token
    base_url = getattr(args, "base_url", "https://tecnicatura-team-412023.atlassian.net")

    if not email or not token:
        die("Both --email and --token are required")

    creds = {"email": email, "token": token, "baseUrl": base_url}
    CREDENTIALS_FILE.write_text(json.dumps(creds, indent=2))
    os.chmod(CREDENTIALS_FILE, 0o600)
    print(f"Credentials saved to {CREDENTIALS_FILE}")


# =========================================================================
# HTTP helpers
# =========================================================================


def _curl(method, path, data=None, raw=False):
    """Execute a curl request and return parsed JSON or raw output."""
    creds = load_credentials()
    email = creds["email"]
    token = creds["token"]
    base_url = creds.get("baseUrl", "https://tecnicatura-team-412023.atlassian.net")
    url = f"{base_url}{path}"

    cmd = [
        "curl", "-s",
        "-u", f"{email}:{token}",
        "-H", "Accept: application/json",
    ]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "-X", method, "-d", json.dumps(data)]
    cmd.append(url)

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.stderr and r.stderr.strip():
        print(f"  [curl stderr] {r.stderr.strip()[:200]}", file=sys.stderr)

    if raw:
        return r.stdout

    if not r.stdout.strip():
        return {}

    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"  [JSON error] {e}", file=sys.stderr)
        print(f"  [raw] {r.stdout[:300]}", file=sys.stderr)
        return {"_error": str(e), "_raw": r.stdout[:200]}


def get(path):
    return _curl("GET", path)


def post(path, data):
    return _curl("POST", path, data)


def put(path, data):
    return _curl("PUT", path, data)


def delete(path):
    return _curl("DELETE", path)


# =========================================================================
# Test / Info
# =========================================================================


def cmd_test(args):
    """Test connection by fetching project info."""
    project = args.project
    result = get(f"/rest/api/3/project/{project}")
    if "key" in result:
        print(f"OK — Project: {result['key']} ({result.get('name', '?')})")
        print(f"  Lead: {result.get('lead', {}).get('displayName', '?')}")
        types = result.get("issueTypes", [])
        for t in types:
            print(f"  Issue type: {t['name']} (ID={t['id']})")
    else:
        print(f"Error: {result.get('errorMessages', result)}")


def cmd_info(args):
    """Show project metadata."""
    cmd_test(args)


# =========================================================================
# List
# =========================================================================


def cmd_list(args):
    """List epics, stories, or sprints."""
    kind = args.kind

    if kind == "sprints":
        board = args.board or 2
        data = get(f"/rest/agile/1.0/board/{board}/sprint")
        print(f"{'ID':>5}  {'State':10}  {'Name':35}  {'Goal':50}")
        print("-" * 105)
        for s in data.get("values", []):
            if args.verbose:
                # Count issues in sprint
                iss = get(
                    f"/rest/agile/1.0/sprint/{s['id']}/issue"
                    "?fields=customfield_10016,issuetype&maxResults=0"
                )
                total = iss.get("total", 0)
                print(
                    f"{s['id']:>5}  {s['state']:10}  {s['name'][:35]:35}  "
                    f"{s.get('goal','')[:50]:50}  ({total} issues)"
                )
            else:
                print(f"{s['id']:>5}  {s['state']:10}  {s['name'][:35]:35}")
    elif kind == "epics":
        board = args.board or 2
        data = get(f"/rest/agile/1.0/board/{board}/epic?maxResults=100")
        print(f"{'Key':15}  {'Summary'}")
        print("-" * 60)
        for ep in data.get("values", []):
            print(f"{ep.get('key','?'):15}  {ep.get('summary','?')[:50]}")
    elif kind == "issues":
        project = args.project
        max_results = args.max_results or 100
        data = get(
            f"/rest/agile/1.0/board/{args.board or 2}/issue"
            f"?maxResults={max_results}&fields=summary,issuetype,customfield_10016"
        )
        print(f"{'Key':15}  {'Type':8}  {'SP':4}  {'Summary'}")
        print("-" * 70)
        for iss in data.get("issues", []):
            f = iss.get("fields", {})
            itype = f.get("issuetype", {}).get("name", "?")
            sp = f.get("customfield_10016", "")
            sp_str = f"{sp:.0f}" if sp else "-"
            print(
                f"{iss.get('key','?'):15}  {itype:8}  {sp_str:4}  "
                f"{f.get('summary','?')[:50]}"
            )
    else:
        die(f"Unknown kind: {kind}. Use: sprints, epics, issues")


# =========================================================================
# Create: Epic
# =========================================================================


def cmd_create_epic(args):
    """Create an epic."""
    project = args.project
    summary = args.summary
    description = args.description or ""

    doc = _make_doc(description)
    data = {
        "fields": {
            "project": {"key": project},
            "issuetype": {"id": ISSUE_TYPES["epic"]},
            "summary": summary,
            "description": doc,
        }
    }
    result = post("/rest/api/3/issue", data)
    if "key" in result:
        print(f"Created epic: {result['key']} — {summary}")
        return result["key"]
    else:
        print(f"Error: {result.get('errorMessages', result)}", file=sys.stderr)
        return None


# =========================================================================
# Create: Story
# =========================================================================


def cmd_create_story(args):
    """Create a story (optionally with subtasks)."""
    project = args.project
    summary = args.summary
    parent_key = args.parent
    points = args.points or 0
    description = args.description or ""
    task_list = args.tasks or []
    labels = args.labels or ["tfi"]

    doc = _make_doc(description)
    data = {
        "fields": {
            "project": {"key": project},
            "issuetype": {"id": ISSUE_TYPES["story"]},
            "summary": summary,
            "description": doc,
            "parent": {"key": parent_key},
            "customfield_10016": points,
            "labels": labels,
        }
    }
    result = post("/rest/api/3/issue", data)
    if "key" in result:
        story_key = result["key"]
        print(f"Created story: {story_key} — {summary} ({points} SP)")

        # Create subtasks
        for task_summary in task_list:
            time.sleep(0.2)
            _create_subtask(task_summary, story_key)
        return story_key
    else:
        # Try with truncated summary
        data["fields"]["summary"] = summary[:80]
        result2 = post("/rest/api/3/issue", data)
        if "key" in result2:
            story_key = result2["key"]
            print(f"Created story: {story_key} — {summary[:60]} ({points} SP)")
            for task_summary in task_list:
                time.sleep(0.2)
                _create_subtask(task_summary, story_key)
            return story_key
        print(f"Error creating story: {result.get('errorMessages', result)}", file=sys.stderr)
        return None


def _create_subtask(summary, parent_key):
    """Create a single subtask under a story."""
    doc = _make_doc(summary)
    data = {
        "fields": {
            "project": {"key": "dummy"},  # Will be overridden by parent's project
            "issuetype": {"id": ISSUE_TYPES["subtask"]},
            "summary": summary[:80],
            "description": doc,
            "parent": {"key": parent_key},
            "labels": ["tfi"],
        }
    }
    result = post("/rest/api/3/issue", data)
    if "key" in result:
        return result["key"]
    else:
        print(f"  Warning: subtask '{summary[:40]}' failed: {result.get('errorMessages','?')}", file=sys.stderr)
        return None


# =========================================================================
# Create: Subtask
# =========================================================================


def cmd_create_subtask(args):
    """Create one or more subtasks."""
    parent_key = args.parent
    summaries = args.summary
    for s in summaries:
        key = _create_subtask(s, parent_key)
        if key:
            print(f"Created subtask: {key} — {s[:60]}")
        time.sleep(0.2)


# =========================================================================
# Create: Sprint
# =========================================================================


def cmd_create_sprint(args):
    """Create a sprint."""
    board = args.board or 2
    name = args.name
    goal = args.goal or ""

    if len(name) > 30:
        die(f"Sprint name must be <= 30 characters. Got {len(name)}: '{name}'")

    data = {
        "name": name,
        "goal": goal,
        "originBoardId": board,
    }
    result = post("/rest/agile/1.0/sprint", data)
    if "id" in result:
        print(f"Created sprint: ID={result['id']} — {name}")
        return result["id"]
    else:
        print(f"Error: {result.get('errorMessages', result.get('errors', result))}", file=sys.stderr)
        return None


# =========================================================================
# Update: Sprint
# =========================================================================


def cmd_update_sprint(args):
    """Update sprint name/goal."""
    sprint_id = args.id
    data = {}
    if args.name:
        if len(args.name) > 30:
            die(f"Sprint name must be <= 30 characters")
        data["name"] = args.name
    if args.goal:
        data["goal"] = args.goal

    if not data:
        print("Nothing to update. Provide --name and/or --goal.")
        return

    result = put(f"/rest/agile/1.0/sprint/{sprint_id}", data)
    if "id" in result:
        print(f"Updated sprint {sprint_id}: name='{result.get('name','')}' goal='{result.get('goal','')}'")
    else:
        print(f"Error: {result}", file=sys.stderr)


# =========================================================================
# Assign
# =========================================================================


def cmd_assign(args):
    """Assign issues to a sprint."""
    sprint_id = args.sprint
    issue_keys = args.issues or []
    by_hu = args.by_hu or []
    from_sprint = getattr(args, "from_sprint", None)

    # If --by-hu, resolve HU prefixes to actual keys
    if by_hu:
        board = getattr(args, "board", 2)
        resolved = _resolve_hu_keys(by_hu, board)
        issue_keys.extend(resolved)

    # If --from-sprint, move all issues from that sprint
    if from_sprint:
        data = get(f"/rest/agile/1.0/sprint/{from_sprint}/issue?fields=issuetype&maxResults=200")
        for iss in data.get("issues", []):
            f = iss.get("fields", {})
            if f.get("issuetype", {}).get("name") == "Story":
                issue_keys.append(iss.get("key"))
        print(f"Moved {len(issue_keys)} stories from sprint {from_sprint}")

    if not issue_keys:
        die("No issues to assign. Provide --issues, --by-hu or --from-sprint.")

    # Assign in batches of 50
    total = len(issue_keys)
    for i in range(0, total, 50):
        batch = issue_keys[i : i + 50]
        result = post(f"/rest/agile/1.0/sprint/{sprint_id}/issue", {"issues": batch})
        if isinstance(result, dict) and result.get("errorMessages"):
            print(f"  Batch error: {result['errorMessages']}")
        else:
            print(f"  Batch {i//50+1}: assigned {len(batch)} issues to sprint {sprint_id}")

    print(f"Total: {total} issues assigned.")


def _resolve_hu_keys(hu_prefixes, board=2):
    """Resolve HU-XX prefixes to Jira issue keys by querying the board."""
    data = get(f"/rest/agile/1.0/board/{board}/issue?maxResults=300&fields=summary,issuetype")
    resolved = []
    for iss in data.get("issues", []):
        f = iss.get("fields", {})
        if f.get("issuetype", {}).get("name") != "Story":
            continue
        summary = f.get("summary", "")
        for prefix in hu_prefixes:
            if summary.startswith(prefix) or prefix in summary:
                resolved.append(iss.get("key"))
                break
    return resolved


# =========================================================================
# Bulk from plan JSON
# =========================================================================


def cmd_create_from_plan(args):
    """Create everything from a JSON plan file."""
    plan_file = args.plan
    if not os.path.exists(plan_file):
        die(f"Plan file not found: {plan_file}")

    with open(plan_file) as f:
        plan = json.load(f)

    project = plan.get("project", "RN412023")
    board = plan.get("board", 2)

    # 1. Create epics with their stories
    epic_keys = {}  # summary -> key
    for epic_def in plan.get("epics", []):
        epic_summary = epic_def["summary"]
        epic_desc = epic_def.get("description", "")
        epic_key = cmd_create_epic(
            argparse.Namespace(
                project=project,
                summary=epic_summary,
                description=epic_desc,
            )
        )
        if epic_key:
            epic_keys[epic_summary] = epic_key
            time.sleep(0.3)

        # Create stories under this epic
        for story_def in epic_def.get("stories", []):
            if not epic_key:
                print(f"  Skipping story '{story_def['summary']}' (epic failed)")
                continue
            time.sleep(0.3)
            cmd_create_story(
                argparse.Namespace(
                    project=project,
                    summary=story_def["summary"],
                    parent=epic_key,
                    points=story_def.get("points", 0),
                    description=story_def.get("description", ""),
                    tasks=story_def.get("tasks", []),
                    labels=story_def.get("labels", ["tfi"]),
                )
            )

    # 2. Create sprints
    sprint_ids = {}
    for sprint_def in plan.get("sprints", []):
        time.sleep(0.3)
        sid = cmd_create_sprint(
            argparse.Namespace(
                board=board,
                name=sprint_def["name"][:30],
                goal=sprint_def.get("goal", ""),
            )
        )
        if sid:
            sprint_ids[sprint_def["name"]] = sid

    # 3. Assign stories to sprints by HU prefix
    if plan.get("sprints"):
        # Get all stories to build HU -> key mapping
        all_data = get(
            f"/rest/agile/1.0/board/{board}/issue?maxResults=300&fields=summary,issuetype"
        )
        hu_map = {}
        for iss in all_data.get("issues", []):
            f = iss.get("fields", {})
            if f.get("issuetype", {}).get("name") == "Story":
                s = f.get("summary", "")
                if s.startswith("HU-"):
                    hu_id = s.split(":")[0].strip()
                    hu_map[hu_id] = iss.get("key")

        for sprint_def in plan.get("sprints", []):
            sid = sprint_ids.get(sprint_def["name"])
            if not sid:
                continue
            keys = [hu_map[hu] for hu in sprint_def.get("stories", []) if hu in hu_map]
            if keys:
                for i in range(0, len(keys), 50):
                    batch = keys[i : i + 50]
                    result = post(f"/rest/agile/1.0/sprint/{sid}/issue", {"issues": batch})
                    if isinstance(result, dict) and result.get("errorMessages"):
                        print(f"  Assign error: {result['errorMessages']}")
                    else:
                        print(f"  Sprint '{sprint_def['name']}': assigned {len(batch)} stories")
                time.sleep(0.3)

    print("\nDone. Review at:")
    print(f"  https://{plan.get('site', 'tecnicatura-team-412023')}.atlassian.net/jira/software/projects/{project}/boards/{board}")


# =========================================================================
# Helpers
# =========================================================================


def _make_doc(text):
    """Create an Atlassian Document Format body."""
    if not text:
        return None
    lines = text.strip().split("\n")
    content = []
    for line in lines:
        content.append(
            {"type": "paragraph", "content": [{"type": "text", "text": line}]}
        )
    return {"type": "doc", "version": 1, "content": content}


# =========================================================================
# CLI
# =========================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Jira Admin CLI — Programmatic Jira Cloud management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to execute")

    # auth
    p_auth = sub.add_parser("auth", help="Store Jira credentials")
    p_auth.add_argument("--email", required=True, help="Atlassian account email")
    p_auth.add_argument("--token", required=True, help="Atlassian API token")
    p_auth.add_argument("--base-url", default="https://tecnicatura-team-412023.atlassian.net",
                        help="Jira base URL")

    # test / info
    p_test = sub.add_parser("test", help="Test API connection")
    p_test.add_argument("--project", default="RN412023", help="Project key")
    p_info = sub.add_parser("info", help="Show project info")
    p_info.add_argument("--project", default="RN412023", help="Project key")

    # list
    p_list = sub.add_parser("list", help="List resources (sprints, epics, issues)")
    p_list.add_argument("kind", choices=["sprints", "epics", "issues"], help="What to list")
    p_list.add_argument("--board", type=int, default=2, help="Board ID")
    p_list.add_argument("--project", default="RN412023", help="Project key")
    p_list.add_argument("--max-results", type=int, default=100, help="Max results")
    p_list.add_argument("--verbose", "-v", action="store_true", help="Show details")

    # create epic
    p_ce = sub.add_parser("create", help="Create resources (epic, story, subtask, sprint)")
    create_sub = p_ce.add_subparsers(dest="create_type")

    p_epic = create_sub.add_parser("epic", help="Create an epic")
    p_epic.add_argument("--project", default="RN412023", required=True)
    p_epic.add_argument("--summary", required=True)
    p_epic.add_argument("--description", default="")

    p_story = create_sub.add_parser("story", help="Create a user story")
    p_story.add_argument("--project", default="RN412023", required=True)
    p_story.add_argument("--summary", required=True)
    p_story.add_argument("--parent", required=True, help="Epic key (e.g. RN412023-2)")
    p_story.add_argument("--points", type=int, default=0, help="Story points")
    p_story.add_argument("--description", default="")
    p_story.add_argument("--tasks", nargs="*", default=[], help="Subtask summaries")
    p_story.add_argument("--labels", nargs="*", default=["tfi"])

    p_subtask = create_sub.add_parser("subtask", help="Create one or more subtasks")
    p_subtask.add_argument("--parent", required=True, help="Parent story key")
    p_subtask.add_argument("summary", nargs="+", help="Subtask summary(ies)")

    p_sprint = create_sub.add_parser("sprint", help="Create a sprint")
    p_sprint.add_argument("--board", type=int, default=2)
    p_sprint.add_argument("--name", required=True)
    p_sprint.add_argument("--goal", default="")

    # update sprint
    p_us = sub.add_parser("update", help="Update sprint")
    update_sub = p_us.add_subparsers(dest="update_type")
    p_us_sprint = update_sub.add_parser("sprint", help="Update sprint name/goal")
    p_us_sprint.add_argument("--id", type=int, required=True)
    p_us_sprint.add_argument("--name", help="New name (max 30 chars)")
    p_us_sprint.add_argument("--goal", help="New goal")

    # assign
    p_assign = sub.add_parser("assign", help="Assign issues to a sprint")
    p_assign.add_argument("--sprint", type=int, required=True, help="Sprint ID")
    p_assign.add_argument("--board", type=int, default=2)
    p_assign.add_argument("--issues", nargs="*", default=[], help="Issue keys")
    p_assign.add_argument("--by-hu", nargs="*", default=[], help="HU prefixes (e.g. HU-01 HU-02)")
    p_assign.add_argument("--from-sprint", type=int, help="Move all stories from another sprint")

    # create-from-plan
    p_plan = sub.add_parser("create-from-plan", help="Bulk create from JSON plan")
    p_plan.add_argument("plan", help="Path to JSON plan file")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    # Dispatch
    handlers = {
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
            p_ce.print_help()
    elif args.command == "update":
        if args.update_type == "sprint":
            cmd_update_sprint(args)
        else:
            die("Use: update sprint --id N --name ...")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
