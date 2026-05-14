#!/usr/bin/env python3
"""
GENERIC TEMPLATE - Batch operations script for Jira.

Instructions for the AI:
1. Replace UPPERCASE variables with real project values.
2. Verify issue type IDs with: jira.py info --project PROJECT_KEY
3. Verify story points customfield (default: customfield_10016).
4. If the project doesn't exist, create it first in Jira Cloud.
5. Keep issue content (summaries, descriptions, task names) in the language
   the user requests. Code comments and instructions stay in English.
6. Credentials go in config/credentials.json (set with: jira.py auth).

Usage:
    python3 scripts/batch_template.py                   # Run with real data
    python3 scripts/batch_template.py --dry-run         # Validate only, no writes
"""

import json, base64, sys, time, os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# =========================================================================
# CONFIGURATION - REPLACE with real project values
# =========================================================================
PROJECT_KEY = "PROJECT_KEY"            # Jira project key (e.g. APP, WEB)
BOARD_ID = 1                           # Scrum board ID (jira.py list sprints --board X)
BASE_URL = "https://your-domain.atlassian.net"  # Jira Cloud base URL
ISSUE_TYPE_EPIC = "10009"              # Check with: jira.py info --project PROJECT_KEY
ISSUE_TYPE_STORY = "10008"             # Check with: jira.py info --project PROJECT_KEY
ISSUE_TYPE_SUBTASK = "10010"           # Check with: jira.py info --project PROJECT_KEY
STORY_POINTS_FIELD = "customfield_10016"  # Check with jira.py info

# =========================================================================
# AUTH (do not modify - uses stored credentials)
# =========================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CREDENTIALS_FILE = CONFIG_DIR / "credentials.json"

def load_credentials():
    if not CREDENTIALS_FILE.exists():
        print("Error: credentials not found. Run: jira.py auth --email ... --token ...", file=sys.stderr)
        sys.exit(1)
    with open(CREDENTIALS_FILE) as f:
        return json.load(f)

creds = load_credentials()
auth = base64.b64encode(f"{creds['email']}:{creds['token']}".encode()).decode()
BASE_URL = creds.get("baseUrl", BASE_URL).rstrip("/")

# =========================================================================
# API HELPERS
# =========================================================================

def jira_get(path, timeout=15):
    """GET request to Jira API."""
    req = Request(f"{BASE_URL}{path}")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        print(f"GET error {e.code} on {path}: {e.read().decode()[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"GET error on {path}: {e}", file=sys.stderr)
        return None

def jira_post(path, data, timeout=120):
    """POST request to Jira API with retry logic."""
    body = json.dumps(data).encode("utf-8")
    req = Request(f"{BASE_URL}{path}", data=body, method="POST")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    for attempt in range(4):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except HTTPError as e:
            err_body = e.read().decode()
            if e.code in {429, 502, 503, 504} and attempt < 3:
                retry = float(e.headers.get("Retry-After", 2 ** attempt))
                print(f"  Retry {attempt+1} in {retry}s...", file=sys.stderr)
                time.sleep(retry)
                continue
            print(f"POST error {e.code}: {err_body[:200]}", file=sys.stderr)
            return {"_error": err_body[:200]}
        except URLError as e:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            print(f"POST timeout: {e}", file=sys.stderr)
            return {"_error": str(e.reason)}
    return {"_error": "Request failed"}

def jira_put(path, data, timeout=60):
    """PUT request to Jira API."""
    body = json.dumps(data).encode("utf-8")
    req = Request(f"{BASE_URL}{path}", data=body, method="PUT")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()) if resp.length else {}
    except HTTPError as e:
        print(f"PUT error {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return None

# =========================================================================
# ADF HELPERS (Atlassian Document Format)
# =========================================================================

def generate_adf_description(sections):
    """
    Generate ADF (Atlassian Document Format) for rich descriptions.
    
    sections is a list of tuples (type, content...):
      - ("h", level, "text") -> heading
      - ("p", "text") -> paragraph
      - ("b", "text") -> bullet list item
      - ("hr",) -> horizontal rule
      - ("ep",) -> empty paragraph
    """
    def text_node(txt, marks=None):
        n = {"type": "text", "text": txt}
        if marks: n["marks"] = marks
        return n
    
    def strong(txt): return text_node(txt, [{"type": "strong"}])
    
    content = []
    for section in sections:
        if section[0] == "h":
            content.append({"type": "heading", "attrs": {"level": section[1]}, "content": [text_node(section[2])]})
        elif section[0] == "p":
            content.append({"type": "paragraph", "content": [text_node(section[1])]})
        elif section[0] == "b":
            content.append({"type": "listItem", "content": [{"type": "paragraph", "content": [text_node(section[1])]}]})
        elif section[0] == "hr":
            content.append({"type": "rule"})
        elif section[0] == "ep":
            content.append({"type": "paragraph", "content": []})
    return {"type": "doc", "version": 1, "content": content}

# =========================================================================
# EXAMPLE FUNCTIONS - REPLACE with project-specific logic
# =========================================================================

def create_subtasks_for_stories(story_keys_map):
    """
    EXAMPLE: Create subtasks for existing stories.
    
    story_keys_map: dict {story_summary: story_key}
    
    REPLACE: task lists with the actual tasks for each story.
    Issue content should be in the language the user requests.
    """
    print("Creating subtasks...")
    for story_summary, story_key in story_keys_map.items():
        # REPLACE: define tasks for each story (language = user's language)
        tasks = [
            f"Implementar {story_summary} - parte 1",
            f"Testear {story_summary} - parte 2",
        ]
        for task in tasks:
            payload = {
                "fields": {
                    "project": {"key": PROJECT_KEY},
                    "summary": task[:80],
                    "description": generate_adf_description([
                        ("p", f"Subtarea para {story_summary}"),
                        ("p", "Implementar siguiendo los criterios de aceptacion definidos en la story padre."),
                    ]),
                    "issuetype": {"id": ISSUE_TYPE_SUBTASK},
                    "parent": {"key": story_key},
                }
            }
            result = jira_post("/rest/api/3/issue", payload)
            if result and result.get("key"):
                print(f"  Created: {result['key']}")
            time.sleep(0.3)


def update_descriptions(issue_type, descriptions_map):
    """
    EXAMPLE: Update rich descriptions.
    
    descriptions_map: dict {issue_key: adf_description_dict}
    
    REPLACE: descriptions with actual project content.
    Description text should be in the language the user requests.
    """
    print(f"Updating {issue_type} descriptions...")
    for key, desc in descriptions_map.items():
        result = jira_put(f"/rest/api/3/issue/{key}", {"fields": {"description": desc}})
        if result is not None:
            print(f"  OK: {key}")
        else:
            print(f"  FAIL: {key}")
        time.sleep(0.5)


def get_all_stories():
    """Get all stories from the project."""
    from urllib.parse import quote
    jql = quote(f"project = {PROJECT_KEY} AND issuetype = Story ORDER BY created ASC")
    url = f"/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary"
    data = jira_get(url)
    if not data:
        return {}
    return {issue["fields"]["summary"]: issue["key"] for issue in data.get("issues", [])}


def get_all_subtasks():
    """Get all subtasks with their parent key."""
    from urllib.parse import quote
    jql = quote(f"project = {PROJECT_KEY} AND issuetype = Subtask")
    url = f"/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary,parent"
    data = jira_get(url)
    if not data:
        return {}
    result = {}
    for issue in data.get("issues", []):
        parent = issue["fields"].get("parent", {}).get("key", "")
        result[issue["key"]] = {"summary": issue["fields"]["summary"], "parent_key": parent}
    return result


# =========================================================================
# MAIN ENTRY POINT
# =========================================================================

if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    
    print(f"Project: {PROJECT_KEY}")
    print(f"Board: {BOARD_ID}")
    print(f"Dry run: {dry_run}")
    print()
    
    if dry_run:
        print("[DRY RUN] No changes will be made to Jira.")
        print("[DRY RUN] Review the steps below and run without --dry-run.")
        sys.exit(0)
    
    # EXAMPLE: Get stories and create subtasks
    stories = get_all_stories()
    print(f"Stories found: {len(stories)}")
    
    # REPLACE: with actual logic needed
    # create_subtasks_for_stories(stories)
    
    print("Script completed.")
