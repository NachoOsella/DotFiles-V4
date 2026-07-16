#!/usr/bin/env python3
"""Fetch all subtasks of In-Progress user stories from Jira."""
import json, sys, os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode
import base64

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_DIR = SCRIPT_DIR.parent / "config"

with open(CONFIG_DIR / "credentials.json") as f:
    creds = json.load(f)
with open(CONFIG_DIR / "project.json") as f:
    pcfg = json.load(f)

email = creds["email"]
token = creds["token"]
base_url = creds.get("baseUrl", "https://tecnicatura-team-412023.atlassian.net")
project_key = pcfg.get("project", "LEMBAS")
auth_header = base64.b64encode(f"{email}:{token}".encode()).decode()

def jira_get(path, query=None):
    url = f"{base_url}{path}"
    if query:
        url += "?" + urlencode(query, doseq=True)
    req = Request(url, headers={
        "Authorization": f"Basic {auth_header}",
        "Accept": "application/json",
    })
    with urlopen(req) as resp:
        return json.loads(resp.read())

# Use the new /search/jql endpoint
jql = f'project = "{project_key}" AND status = "In Progress" AND issuetype in (Story, Epic, Task, Bug) ORDER BY key'
search_data = jira_get("/rest/api/3/search/jql", {
    "jql": jql,
    "fields": "summary,issuetype,status,assignee,updated,priority,customfield_10016,subtasks",
    "maxResults": 100,
})

# The new search/jql endpoint may have a different key for issues
issues = search_data.get("issues", [])
print(f"\n=== In-Progress Issues ({len(issues)} found) ===\n", file=sys.stderr)

results = []
for issue in issues:
    key = issue["key"]
    fields = issue["fields"]
    itype = fields["issuetype"]["name"]
    summary = fields["summary"]
    status = fields["status"]["name"]
    assignee = fields.get("assignee", {})
    assignee_name = assignee.get("displayName", "Unassigned") if assignee else "Unassigned"
    points = fields.get("customfield_10016", None)
    priority = fields.get("priority", {})
    priority_name = priority.get("name", "None") if priority else "None"
    updated = fields.get("updated", "")

    # Fetch subtasks for this issue
    sub_data = jira_get("/rest/api/3/search/jql", {
        "jql": f"parent = {key} ORDER BY key",
        "fields": "summary,issuetype,status,assignee,updated,priority",
        "maxResults": 50,
    })
    subtasks = [
        {
            "key": st["key"],
            "summary": st["fields"]["summary"],
            "status": st["fields"]["status"]["name"],
            "assignee": st["fields"].get("assignee", {}).get("displayName", "Unassigned") if st["fields"].get("assignee") else "Unassigned",
            "priority": st["fields"].get("priority", {}).get("name", "None") if st["fields"].get("priority") else "None",
            "updated": st["fields"].get("updated", ""),
        }
        for st in sub_data.get("issues", [])
    ]

    results.append({
        "key": key,
        "type": itype,
        "summary": summary,
        "status": status,
        "assignee": assignee_name,
        "points": points,
        "priority": priority_name,
        "updated": updated,
        "subtask_count": len(subtasks),
        "subtasks": subtasks,
    })

output = {"project": project_key, "issues": results}
print(json.dumps(output, indent=2, ensure_ascii=False))
