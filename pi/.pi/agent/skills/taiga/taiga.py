#!/usr/bin/env python3
"""Small Taiga REST API CLI used by the taiga agent skill."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SKILL_DIR = Path(__file__).resolve().parent
ENV_FILE = SKILL_DIR / ".env"

RESOURCE_ENDPOINTS = {
    "story": "userstories",
    "task": "tasks",
    "issue": "issues",
    "epic": "epics",
    "sprint": "milestones",
}
REF_RESOURCES = {"story", "task", "issue", "epic"}


def load_env(path: Path) -> None:
    if not path.exists():
        raise RuntimeError(f"Missing {path}. Configure the Taiga skill first.")

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def json_print(value: Any) -> None:
    if value is None:
        return
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False))


def parse_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("--data must be a JSON object")
    return value


def parse_query(values: list[str] | None) -> dict[str, Any]:
    query: dict[str, Any] = {}
    for item in values or []:
        if "=" not in item:
            raise RuntimeError(f"Invalid query parameter '{item}'. Use key=value.")
        key, value = item.split("=", 1)
        if key in query:
            current = query[key]
            if not isinstance(current, list):
                current = [current]
            current.append(value)
            query[key] = current
        else:
            query[key] = value
    return query


class TaigaClient:
    def __init__(self) -> None:
        self.api_url = os.environ.get("TAIGA_API_URL", "https://api.taiga.io/api/v1").rstrip("/")
        self.username = os.environ.get("TAIGA_USERNAME", "")
        self.password = os.environ.get("TAIGA_PASSWORD", "")
        self.token = os.environ.get("TAIGA_AUTH_TOKEN", "")
        self.project_slug = os.environ.get("TAIGA_PROJECT_SLUG", "")
        self.project_id_override = os.environ.get("TAIGA_PROJECT_ID", "")
        self._project: dict[str, Any] | None = None

    def _authenticate(self) -> None:
        if self.token:
            return
        if not self.username or not self.password:
            raise RuntimeError(
                "Set TAIGA_USERNAME and TAIGA_PASSWORD in .env, or provide TAIGA_AUTH_TOKEN."
            )
        response = self.request(
            "POST",
            "/auth",
            data={"type": "normal", "username": self.username, "password": self.password},
            auth=False,
        )
        token = response.get("auth_token") if isinstance(response, dict) else None
        if not token:
            raise RuntimeError("Taiga authentication succeeded but no auth_token was returned")
        self.token = str(token)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> Any:
        if auth:
            self._authenticate()

        url = f"{self.api_url}/{path.lstrip('/')}"
        if query:
            url += "?" + urlencode(query, doseq=True)

        body = None
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-disable-pagination": "True",
        }
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        if data is not None:
            body = json.dumps(data).encode("utf-8")

        request = Request(url, data=body, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                if not raw:
                    return None
                content_type = response.headers.get("Content-Type", "")
                if "json" in content_type:
                    return json.loads(raw.decode("utf-8"))
                return raw.decode("utf-8", errors="replace")
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                details = json.dumps(json.loads(raw), ensure_ascii=False)
            except json.JSONDecodeError:
                details = raw.strip() or exc.reason
            raise RuntimeError(f"Taiga API {exc.code} {method.upper()} {path}: {details}") from exc
        except URLError as exc:
            raise RuntimeError(f"Could not reach Taiga API at {self.api_url}: {exc.reason}") from exc

    def project(self) -> dict[str, Any]:
        if self._project is not None:
            return self._project

        if self.project_id_override:
            project = self.request("GET", f"/projects/{self.project_id_override}")
        elif self.project_slug:
            project = self.request("GET", "/projects/by_slug", query={"slug": self.project_slug})
        else:
            raise RuntimeError("Set TAIGA_PROJECT_SLUG or TAIGA_PROJECT_ID in .env")

        if not isinstance(project, dict):
            raise RuntimeError("Unexpected project response from Taiga")
        self._project = project
        return project

    def project_id(self) -> int:
        project_id = self.project().get("id")
        if not isinstance(project_id, int):
            raise RuntimeError("Configured Taiga project has no numeric id")
        return project_id

    def me(self) -> dict[str, Any]:
        value = self.request("GET", "/users/me")
        if not isinstance(value, dict):
            raise RuntimeError("Unexpected /users/me response")
        return value

    def _match_named(self, items: list[dict[str, Any]], value: str, label: str) -> dict[str, Any]:
        if value.isdigit():
            target_id = int(value)
            for item in items:
                if item.get("id") == target_id:
                    return item

        needle = value.casefold().lstrip("@").strip()
        exact: list[dict[str, Any]] = []
        partial: list[dict[str, Any]] = []
        for item in items:
            names = [
                str(item.get("name", "")),
                str(item.get("slug", "")),
                str(item.get("username", "")),
                str(item.get("full_name", "")),
                str(item.get("full_name_display", "")),
                str(item.get("email", "")),
            ]
            normalized = [name.casefold() for name in names if name]
            if needle in normalized:
                exact.append(item)
            elif any(needle in name for name in normalized):
                partial.append(item)

        matches = exact or partial
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise RuntimeError(f"No {label} matching '{value}'")

        candidates = [
            {
                "id": item.get("id"),
                "name": item.get("name") or item.get("full_name") or item.get("username"),
                "username": item.get("username"),
            }
            for item in matches
        ]
        raise RuntimeError(f"Ambiguous {label} '{value}': {json.dumps(candidates, ensure_ascii=False)}")

    def resolve_member(self, value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        text = str(value).strip()
        if text.casefold() in {"none", "null", "unassigned"}:
            return None
        if text.casefold() == "me":
            return int(self.me()["id"])
        member = self._match_named(self.project().get("members", []), text, "project member")
        return int(member["id"])

    def resolve_sprint(self, value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        text = str(value).strip()
        if text.casefold() in {"none", "null", "backlog"}:
            return None

        milestones = self.request("GET", "/milestones", query={"project": self.project_id()})
        if not isinstance(milestones, list):
            raise RuntimeError("Unexpected milestones response")
        sprint = self._match_named(milestones, text, "sprint")
        return int(sprint["id"])

    def resolve_project_value(self, kind: str, value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        text = str(value).strip()
        if text.casefold() in {"none", "null"}:
            return None

        field_map = {
            "story-status": "us_statuses",
            "task-status": "task_statuses",
            "issue-status": "issue_statuses",
            "issue-type": "issue_types",
            "priority": "priorities",
            "severity": "severities",
        }
        field = field_map[kind]
        items = self.project().get(field, [])
        if not isinstance(items, list):
            raise RuntimeError(f"Project does not expose {field}")
        item = self._match_named(items, text, kind)
        return int(item["id"])

    def get_resource(self, resource: str, identifier: str) -> dict[str, Any]:
        endpoint = RESOURCE_ENDPOINTS[resource]

        if resource == "sprint":
            sprint_id = self.resolve_sprint(identifier)
            if sprint_id is None:
                raise RuntimeError("A sprint identifier is required")
            value = self.request("GET", f"/{endpoint}/{sprint_id}")
        elif identifier.startswith("id:"):
            value = self.request("GET", f"/{endpoint}/{identifier[3:]}")
        else:
            ref = identifier.lstrip("#")
            if not ref.isdigit():
                raise RuntimeError(
                    f"{resource} identifiers are Taiga refs such as #42. Use id:123 for an internal id."
                )
            value = self.request(
                "GET",
                f"/{endpoint}/by_ref",
                query={"ref": int(ref), "project": self.project_id()},
            )

        if not isinstance(value, dict):
            raise RuntimeError(f"Unexpected {resource} response")
        return value

    def normalize_payload(self, resource: str, data: dict[str, Any]) -> dict[str, Any]:
        payload = dict(data)
        payload.setdefault("project", self.project_id())

        if "assigned_to" in payload:
            payload["assigned_to"] = self.resolve_member(payload["assigned_to"])
        if "milestone" in payload:
            payload["milestone"] = self.resolve_sprint(payload["milestone"])

        status_kind = {
            "story": "story-status",
            "task": "task-status",
            "issue": "issue-status",
        }.get(resource)
        if status_kind and "status" in payload and not isinstance(payload["status"], int):
            payload["status"] = self.resolve_project_value(status_kind, payload["status"])

        if resource == "issue":
            for field, kind in (
                ("type", "issue-type"),
                ("priority", "priority"),
                ("severity", "severity"),
            ):
                if field in payload and not isinstance(payload[field], int):
                    payload[field] = self.resolve_project_value(kind, payload[field])

        if resource == "task" and "user_story" in payload and not isinstance(payload["user_story"], int):
            story = self.get_resource("story", str(payload["user_story"]))
            payload["user_story"] = story["id"]

        return payload

    def list_resource(self, resource: str, query: dict[str, Any]) -> Any:
        endpoint = RESOURCE_ENDPOINTS[resource]
        query = dict(query)
        query.setdefault("project", self.project_id())

        if query.get("assigned_to") == "me":
            query["assigned_to"] = self.me()["id"]
        if "milestone" in query:
            query["milestone"] = self.resolve_sprint(query["milestone"])

        return self.request("GET", f"/{endpoint}", query=query)

    def create_resource(self, resource: str, data: dict[str, Any]) -> Any:
        endpoint = RESOURCE_ENDPOINTS[resource]
        payload = self.normalize_payload(resource, data)
        return self.request("POST", f"/{endpoint}", data=payload)

    def patch_resource(self, resource: str, identifier: str, data: dict[str, Any]) -> Any:
        endpoint = RESOURCE_ENDPOINTS[resource]
        current = self.get_resource(resource, identifier)
        payload = self.normalize_payload(resource, data)
        payload.pop("project", None)
        if "version" in current and "version" not in payload:
            payload["version"] = current["version"]
        return self.request("PATCH", f"/{endpoint}/{current['id']}", data=payload)

    def delete_resource(self, resource: str, identifier: str) -> Any:
        endpoint = RESOURCE_ENDPOINTS[resource]
        current = self.get_resource(resource, identifier)
        return self.request("DELETE", f"/{endpoint}/{current['id']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Taiga REST API helper for agent skills")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("me", help="Show the authenticated Taiga user")
    sub.add_parser("projects", help="List accessible projects")
    sub.add_parser("project", help="Show the configured project")
    sub.add_parser("members", help="Show members of the configured project")
    sub.add_parser("sprints", help="List sprints of the configured project")
    sub.add_parser("meta", help="Show project statuses, issue metadata and members")

    lookup = sub.add_parser("lookup", help="Resolve a human-readable project value to its Taiga id")
    lookup.add_argument(
        "kind",
        choices=["member", "sprint", "story-status", "task-status", "issue-status", "issue-type", "priority", "severity"],
    )
    lookup.add_argument("value")

    list_parser = sub.add_parser("list", help="List project resources")
    list_parser.add_argument("resource", choices=RESOURCE_ENDPOINTS)
    list_parser.add_argument("--query", action="append", help="Additional API filter as key=value")

    get_parser = sub.add_parser("get", help="Get one project resource")
    get_parser.add_argument("resource", choices=RESOURCE_ENDPOINTS)
    get_parser.add_argument("identifier", help="Visible ref (#42), sprint name/slug/id, or id:123")

    create_parser = sub.add_parser("create", help="Create a project resource")
    create_parser.add_argument("resource", choices=RESOURCE_ENDPOINTS)
    create_parser.add_argument("--data", required=True, help="JSON object. Human names are accepted for common fields.")

    patch_parser = sub.add_parser("patch", help="Patch a project resource with OCC-safe version handling")
    patch_parser.add_argument("resource", choices=RESOURCE_ENDPOINTS)
    patch_parser.add_argument("identifier")
    patch_parser.add_argument("--data", required=True, help="JSON object. Human names are accepted for common fields.")

    delete_parser = sub.add_parser("delete", help="Delete a project resource")
    delete_parser.add_argument("resource", choices=RESOURCE_ENDPOINTS)
    delete_parser.add_argument("identifier")
    delete_parser.add_argument("--confirm", action="store_true", help="Required destructive-operation guard")

    raw = sub.add_parser("raw", help="Call any Taiga API endpoint")
    raw.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    raw.add_argument("path", help="Path relative to /api/v1, for example /history/userstory/12")
    raw.add_argument("--query", action="append", help="Query parameter as key=value")
    raw.add_argument("--data", help="JSON object")

    return parser


def main() -> int:
    try:
        load_env(ENV_FILE)
        args = build_parser().parse_args()
        client = TaigaClient()

        if args.command == "me":
            json_print(client.me())
        elif args.command == "projects":
            json_print(client.request("GET", "/projects"))
        elif args.command == "project":
            json_print(client.project())
        elif args.command == "members":
            json_print(client.project().get("members", []))
        elif args.command == "sprints":
            json_print(client.request("GET", "/milestones", query={"project": client.project_id()}))
        elif args.command == "meta":
            project = client.project()
            json_print(
                {
                    "project": {"id": project.get("id"), "name": project.get("name"), "slug": project.get("slug")},
                    "members": project.get("members", []),
                    "sprints": project.get("milestones", []),
                    "story_statuses": project.get("us_statuses", []),
                    "task_statuses": project.get("task_statuses", []),
                    "issue_statuses": project.get("issue_statuses", []),
                    "issue_types": project.get("issue_types", []),
                    "priorities": project.get("priorities", []),
                    "severities": project.get("severities", []),
                }
            )
        elif args.command == "lookup":
            if args.kind == "member":
                json_print({"id": client.resolve_member(args.value)})
            elif args.kind == "sprint":
                json_print({"id": client.resolve_sprint(args.value)})
            else:
                json_print({"id": client.resolve_project_value(args.kind, args.value)})
        elif args.command == "list":
            json_print(client.list_resource(args.resource, parse_query(args.query)))
        elif args.command == "get":
            json_print(client.get_resource(args.resource, args.identifier))
        elif args.command == "create":
            json_print(client.create_resource(args.resource, parse_json_object(args.data)))
        elif args.command == "patch":
            json_print(client.patch_resource(args.resource, args.identifier, parse_json_object(args.data)))
        elif args.command == "delete":
            if not args.confirm:
                raise RuntimeError("Deletion blocked. Re-run with --confirm only after the user explicitly requested deletion.")
            json_print(client.delete_resource(args.resource, args.identifier))
        elif args.command == "raw":
            json_print(
                client.request(
                    args.method,
                    args.path,
                    query=parse_query(args.query),
                    data=parse_json_object(args.data) if args.data else None,
                )
            )
        return 0
    except (RuntimeError, KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
