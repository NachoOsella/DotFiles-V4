#!/usr/bin/env python3
"""
GENERIC TEMPLATE - Verify Jira plan integrity.

Compares what was created in Jira against the reference plan JSON and
reports discrepancies: missing epics, stories without parent, incorrect
points, incomplete subtasks, wrong sprint assignments.

Instructions for the AI:
1. Replace PROJECT_KEY and BOARD_ID with real values.
2. Point PLAN_FILE at the actual plan JSON to verify.
3. Run to get a diff report.
4. Fix any discrepancies found.
5. Keep issue content text in the language the user requests.

Usage:
    python3 templates/verify_plan_template.py
"""

import json, base64, sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote

# =========================================================================
# CONFIGURATION - REPLACE
# =========================================================================
PROJECT_KEY = "PROJECT_KEY"
BOARD_ID = 1

PLAN_FILE = Path(__file__).resolve().parent.parent / "templates" / "plan_template.json"

# =========================================================================
# AUTH
# =========================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CREDENTIALS_FILE = CONFIG_DIR / "credentials.json"

creds = json.load(open(CREDENTIALS_FILE))
auth = base64.b64encode(f"{creds['email']}:{creds['token']}".encode()).decode()
BASE_URL = creds.get("baseUrl", "https://your-domain.atlassian.net").rstrip("/")

# =========================================================================
# API HELPERS
# =========================================================================

def jira_get(path, timeout=15):
    req = Request(f"{BASE_URL}{path}")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  GET error: {e}", file=sys.stderr)
        return None

def get_all_issues():
    """
    Get all project issues using key-ranges to avoid Jira Cloud
    pagination issues with >100 results.
    
    REPLACE: key ranges if the project has pre-existing issues.
    Strategy: query by type for more targeted ranges.
    """
    all_issues = {}
    
    for itype in ["Epic", "Story", "Subtask"]:
        jql = quote(f"project = {PROJECT_KEY} AND issuetype = {itype}")
        url = f"/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary,issuetype,parent,customfield_10016"
        data = jira_get(url)
        if data:
            for issue in data.get("issues", []):
                all_issues[issue["key"]] = issue
    
    return all_issues


# =========================================================================
# CHECKS
# =========================================================================

errors = []
warnings = []

def check(condition, msg):
    if condition:
        print(f"  OK: {msg}")
    else:
        print(f"  FAIL: {msg}")
        errors.append(msg)

def warn(msg):
    print(f"  WARN: {msg}")
    warnings.append(msg)


def verify_epics(plan, jira_epics):
    """Verify all plan epics exist in Jira."""
    print("\n=== Verifying Epics ===")
    
    plan_epic_names = {e["summary"] for e in plan.get("epics", [])}
    jira_epic_names = {v["fields"]["summary"] for v in jira_epics.values()}
    
    missing = plan_epic_names - jira_epic_names
    extra = jira_epic_names - plan_epic_names
    
    check(len(plan_epic_names) == len(jira_epic_names),
          f"Epic count: plan={len(plan_epic_names)}, jira={len(jira_epic_names)}")
    check(not missing, f"All plan epics exist in Jira (missing: {missing or 'none'})")
    check(not extra, f"No extra epics in Jira (extra: {extra or 'none'})")


def verify_stories(plan, jira_stories, jira_epics):
    """Verify stories: count, points, parent epic."""
    print("\n=== Verifying Stories ===")
    
    # Map plan stories
    plan_stories = {}
    for epic in plan.get("epics", []):
        for story in epic.get("stories", []):
            plan_stories[story["summary"]] = {
                "epic": epic["summary"],
                "points": story.get("points", 0),
                "tasks": len(story.get("tasks", [])),
            }
    
    jira_story_map = {v["fields"]["summary"]: k for k, v in jira_stories.items()}
    
    # Count
    check(len(plan_stories) == len(jira_stories),
          f"Story count: plan={len(plan_stories)}, jira={len(jira_stories)}")
    
    missing = set(plan_stories.keys()) - set(jira_story_map.keys())
    extra = set(jira_story_map.keys()) - set(plan_stories.keys())
    check(not missing, f"All plan stories exist (missing: {missing or 'none'})")
    check(not extra, f"No extra stories (extra: {extra or 'none'})")
    
    # Story points
    total_plan = sum(s["points"] for s in plan_stories.values())
    total_jira = sum(
        jira_stories[jira_story_map[sname]]["fields"].get("customfield_10016") or 0
        for sname in plan_stories if sname in jira_story_map
    )
    check(total_plan == total_jira, f"Story points: plan={total_plan}, jira={total_jira}")
    
    # Parent epic
    parent_ok = True
    for sname in plan_stories:
        if sname not in jira_story_map:
            continue
        parent_info = jira_stories[jira_story_map[sname]]["fields"].get("parent", {})
        parent_key = parent_info.get("key")
        if parent_key:
            parent_summary = jira_epics.get(parent_key, {}).get("fields", {}).get("summary", "")
            expected = plan_stories[sname]["epic"]
            if parent_summary != expected:
                print(f"    FAIL: {sname} -> parent={parent_summary}, expected={expected}")
                parent_ok = False
    check(parent_ok, "Parent epic assignment correct")


def verify_subtasks(plan, jira_subtasks, jira_stories):
    """Verify subtasks: total count and per-story distribution."""
    print("\n=== Verifying Subtasks ===")
    
    plan_tasks_total = sum(
        len(story.get("tasks", []))
        for epic in plan.get("epics", [])
        for story in epic.get("stories", [])
    )
    
    check(plan_tasks_total == len(jira_subtasks),
          f"Subtask count: plan={plan_tasks_total}, jira={len(jira_subtasks)}")
    
    # Check per-story distribution
    jira_story_map = {v["fields"]["summary"]: k for k, v in jira_stories.items()}
    story_subtask_count = {}
    for key, sdata in jira_subtasks.items():
        parent = sdata.get("parent_key")
        story_subtask_count[parent] = story_subtask_count.get(parent, 0) + 1
    
    dist_ok = True
    for epic in plan.get("epics", []):
        for story in epic.get("stories", []):
            sname = story["summary"]
            expected = len(story.get("tasks", []))
            skey = jira_story_map.get(sname)
            actual = story_subtask_count.get(skey, 0)
            if expected != actual:
                print(f"    FAIL: {sname}: plan={expected} tasks, jira={actual} subtasks")
                dist_ok = False
    check(dist_ok, "Subtask distribution correct")


def verify_sprints(board_id, plan):
    """Verify story-to-sprint assignments."""
    print("\n=== Verifying Sprints ===")
    
    sprints_data = jira_get(f"/rest/agile/1.0/board/{board_id}/sprint?state=future,active,closed")
    if not sprints_data:
        warn(f"Could not fetch sprints from board {board_id}")
        return
    
    for sprint in sprints_data.get("values", []):
        sid = sprint["id"]
        sname = sprint["name"]
        
        # Find in plan
        plan_sprint = next((s for s in plan.get("sprints", []) if s["name"] == sname), None)
        
        if not plan_sprint:
            warn(f"Sprint '{sname}' not found in plan")
            continue
        
        # Get sprint issues
        sprint_issues = jira_get(f"/rest/agile/1.0/sprint/{sid}/issue?maxResults=100&fields=summary,issuetype")
        if not sprint_issues:
            warn(f"Could not fetch issues for sprint {sid}")
            continue
        
        actual_stories = {i["fields"]["summary"] for i in sprint_issues.get("issues", [])
                         if i["fields"]["issuetype"]["name"] == "Story"}
        expected_stories = set(plan_sprint.get("stories", []))
        
        missing = expected_stories - actual_stories
        extra = actual_stories - expected_stories
        
        check(not missing, f"'{sname}': all stories assigned (missing: {missing or 'none'})")
        check(not extra, f"'{sname}': no extra stories (extra: {extra or 'none'})")


# =========================================================================
# MAIN
# =========================================================================

def main():
    print(f"Project: {PROJECT_KEY}")
    print(f"Board: {BOARD_ID}")
    print()
    
    # Load plan
    with open(PLAN_FILE) as f:
        plan = json.load(f)
    print(f"Plan loaded: {len(plan.get('epics', []))} epics, {len(plan.get('sprints', []))} sprints")
    
    # Get Jira data
    print("\nFetching issues from Jira...")
    all_issues = get_all_issues()
    
    jira_epics = {k: v for k, v in all_issues.items() if v["fields"]["issuetype"]["name"] == "Epic"}
    jira_stories = {k: v for k, v in all_issues.items() if v["fields"]["issuetype"]["name"] == "Story"}
    jira_subtasks = {}
    for k, v in all_issues.items():
        if v["fields"]["issuetype"]["name"] == "Subtask":
            parent = v["fields"].get("parent", {}).get("key", "")
            jira_subtasks[k] = {"summary": v["fields"]["summary"], "parent_key": parent}
    
    print(f"  Epics: {len(jira_epics)}")
    print(f"  Stories: {len(jira_stories)}")
    print(f"  Subtasks: {len(jira_subtasks)}")
    
    # Run checks
    verify_epics(plan, jira_epics)
    verify_stories(plan, jira_stories, jira_epics)
    verify_subtasks(plan, jira_subtasks, jira_stories)
    verify_sprints(BOARD_ID, plan)
    
    # Final report
    print(f"\n{'='*50}")
    print(f"Errors: {len(errors)}")
    for e in errors:
        print(f"  - {e}")
    print(f"Warnings: {len(warnings)}")
    for w in warnings:
        print(f"  - {w}")
    print(f"\nVerification: {'PASS' if not errors else f'FAIL ({len(errors)} errors)}'")

if __name__ == "__main__":
    main()
