#!/usr/bin/env python3
"""
GENERIC TEMPLATE - Enrich issue descriptions in Jira.

Adds detailed structured descriptions to epics, stories and subtasks
so they are understandable for both developers and non-technical
stakeholders (e.g. academic tutors).

Instructions for the AI:
1. Replace PROJECT_KEY with the real project key.
2. Fill EPIC_DESCRIPTIONS with each epic's data.
3. Fill STORY_CONTEXT with each story's context.
4. Descriptions use ADF (Atlassian Document Format).
5. Issue content text should be in the language the user requests.
6. Only run after epics and stories already exist in Jira.

Usage:
    python3 templates/enrich_descriptions_template.py
"""

import json, base64, time, sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# =========================================================================
# CONFIGURATION - REPLACE
# =========================================================================
PROJECT_KEY = "PROJECT_KEY"

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
# ADF HELPERS (Atlassian Document Format)
# =========================================================================
# These functions build the JSON format that Jira Cloud uses for rich
# descriptions with headings, lists and text formatting.

def t(text_str, marks=None):
    """Plain text or text with marks (bold, code, etc.)."""
    node = {"type": "text", "text": text_str}
    if marks: node["marks"] = marks
    return node

def strong_mark(): return {"type": "strong"}
def code_mark(): return {"type": "code"}

def strong(text_str): return t(text_str, [strong_mark()])
def code(text_str): return t(text_str, [code_mark()])

def p(*content):
    """Paragraph."""
    return {"type": "paragraph", "content": list(content)}

def h(level, *content):
    """Heading level 1-3."""
    return {"type": "heading", "attrs": {"level": level}, "content": list(content)}

def li(*content):
    """List item (bullet or ordered)."""
    return {"type": "listItem", "content": [p(*content)]}

def ul(*items):
    """Bullet list."""
    return {"type": "bulletList", "content": list(items)}

def ol(*items):
    """Ordered list."""
    return {"type": "orderedList", "content": list(items)}

def hr():
    """Horizontal rule (separator)."""
    return {"type": "rule"}

def ep():
    """Empty paragraph (spacer)."""
    return {"type": "paragraph", "content": []}

def adf(*content):
    """Complete ADF document."""
    return {"type": "doc", "version": 1, "content": list(content)}

# =========================================================================
# DESCRIPTION BUILDERS - Customize per project needs
# =========================================================================
# These functions take data and return ADF descriptions.
# The text content should be in the language the user requests.

def make_epic_description(summary, purpose, scope_items, tech_decisions, business_value, sprints, dependencies="None"):
    """
    Structured description for an epic.
    
    Designed so anyone (developer or tutor) can understand
    what the epic is about and why it matters.
    """
    return adf(
        h(2, strong("Proposito")),
        p(t(purpose)),
        ep(),
        h(2, strong("Alcance")),
        ul(*[li(t(item)) for item in scope_items]),
        ep(),
        h(2, strong("Decisiones tecnicas")),
        ul(*[li(t(d)) for d in tech_decisions]),
        ep(),
        h(2, strong("Valor de negocio")),
        p(t(business_value)),
        ep(),
        h(2, strong("Sprints")),
        p(t(sprints)),
        ep(),
        h(2, strong("Dependencias")),
        p(t(dependencies)),
    )


def make_story_description(summary, user_story, context, tech_notes):
    """
    Structured description for a user story.
    
    Includes classic user story format, business context,
    acceptance criteria and developer notes.
    """
    return adf(
        h(2, strong("Historia de usuario")),
        p(t(user_story)),
        ep(),
        h(2, strong("Contexto")),
        p(t(context)),
        ep(),
        h(2, strong("Criterios de aceptacion")),
        ul(
            li(t("Criterio 1: describir que debe cumplir la implementacion")),
            li(t("Criterio 2: validaciones, casos borde y comportamiento esperado")),
            li(t("Criterio 3: consideraciones de testing y regresion")),
        ),
        ep(),
        h(2, strong("Notas tecnicas")),
        p(t(tech_notes)),
    )


def make_subtask_description(task_summary, story_summary, category):
    """
    Description for a subtask based on its category.
    
    Common categories:
    - "entity": entities, DTOs, repositories, migrations
    - "controller": REST endpoints
    - "service": business logic
    - "config": configuration, Docker, properties
    - "frontend": Angular components
    - "test": automated tests
    - "docs": documentation
    """
    detail_map = {
        "entity": (
            "Crear la estructura de datos: entidad JPA, repositorio Spring Data, "
            "DTOs y migracion Flyway si corresponde."
        ),
        "controller": (
            "Implementar el controlador REST con validacion Jakarta Validation, "
            "manejo de excepciones y control de acceso por rol."
        ),
        "service": (
            "Implementar la logica de negocio con validaciones de dominio, "
            "transaccionalidad (@Transactional) y excepciones con codigos claros."
        ),
        "config": (
            "Configurar los archivos necesarios usando profiles de Spring "
            "y variables de entorno para valores sensibles."
        ),
        "frontend": (
            "Crear el componente Angular standalone con signals, servicios "
            "inyectables y manejo de estados loading/empty/error."
        ),
        "test": (
            "Escribir pruebas con JUnit 5 + Mockito (unitarias) y "
            "Testcontainers (integracion). Cubrir caso feliz, bordes y errores."
        ),
        "docs": (
            "Documentar la funcionalidad con proposito, ejemplos de uso "
            "y decisiones tecnicas. Redactar para audiencia academica."
        ),
    }
    detail = detail_map.get(category, "Implementar siguiendo las convenciones del proyecto.")
    
    return adf(
        p(strong("Objetivo:"), t(f" {task_summary}")),
        p(strong("Detalle:"), t(f" {detail}")),
        p(strong("Contexto:"), t(f" Pertenece a {story_summary}.")),
        hr(),
        p(t("Seguir los mismos patrones y convenciones del resto del proyecto.")),
    )

# =========================================================================
# DESCRIPTIONS PER EPIC - REPLACE
# =========================================================================
# Define descriptions for each epic. Text should be in the user's language.

EPIC_DESCRIPTIONS = {
    "EP-00: Nombre de la epica": make_epic_description(
        summary="EP-00: Nombre de la epica",
        purpose="Describir el proposito general de esta epica transversal.",
        scope_items=[
            "Item de alcance 1",
            "Item de alcance 2",
            "Item de alcance 3",
        ],
        tech_decisions=[
            "Decision tecnica 1 con su justificacion",
            "Decision tecnica 2 con su justificacion",
        ],
        business_value="Valor que aporta esta epica al negocio o al proyecto.",
        sprints="Sprint 1, Sprint 2",
        dependencies="EP-01, EP-02",
    ),
}


# =========================================================================
# CONTEXT PER STORY - REPLACE
# =========================================================================
# Define context and tech notes for each story.

STORY_CONTEXT = {
    "US-01": {
        "user_story": "Como [rol], quiero [funcionalidad] para [beneficio].",
        "context": "Explicar por que esta historia existe y que problema resuelve.",
        "tech_notes": "Detalles de implementacion: tecnologia, patrones, archivos a modificar.",
    },
}


# =========================================================================
# TASK CLASSIFIER - REPLACE
# =========================================================================
# Automatically classify subtasks by their title to assign descriptions.

import re

def classify_task(task_summary):
    """Classify a subtask into a category for description assignment."""
    tl = task_summary.lower()
    
    if re.search(r'crear.*(entidad|entity|repository|enum|dto|request|response|record)', tl) \
       or any(k in tl for k in ['migra', 'sql', 'tabla', 'v1_', 'v2_', 'v3_', 'v4_', 'v5_', 'seed']):
        return "entity"
    if re.search(r'(implementar|crear).*(controller|endpoint)', tl) \
       or any(k in tl for k in ['post ', 'get ', 'put ', 'patch ', 'delete ']) and '/api' in tl:
        return "controller"
    if any(k in tl for k in ['service', 'register', 'login', 'jwt', 'auth', 'checkout', 'cancel']):
        return "service"
    if any(k in tl for k in ['docker', 'compose', 'dockerfile', 'properties', '.env', 'config']):
        return "config"
    if any(k in tl for k in ['component', 'pantalla', 'page', 'angular', 'frontend', 'ui']):
        return "frontend"
    if any(k in tl for k in ['test', 'junit', 'mockito', 'testcontainers', 'fixture']):
        return "test"
    if any(k in tl for k in ['documentar', 'readme', 'diagrama', 'captura']):
        return "docs"
    return "default"


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
    except:
        return None

def jira_put(path, data, timeout=60):
    body = json.dumps(data).encode("utf-8")
    req = Request(f"{BASE_URL}{path}", data=body, method="PUT")
    req.add_header("Authorization", f"Basic {auth}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()) if resp.length else {}
    except HTTPError as e:
        print(f"  PUT error {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return None

def get_issues_by_type(issue_type):
    """Get all issues of a given type."""
    from urllib.parse import quote
    jql = quote(f"project = {PROJECT_KEY} AND issuetype = {issue_type}")
    url = f"/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary,issuetype"
    data = jira_get(url)
    return {issue["fields"]["summary"]: issue["key"] for issue in data.get("issues", [])} if data else {}


# =========================================================================
# MAIN
# =========================================================================

def main():
    print(f"Project: {PROJECT_KEY}")
    print()
    
    # Get existing issues
    epics = get_issues_by_type("Epic")
    stories = get_issues_by_type("Story")
    print(f"Epics found: {len(epics)}")
    print(f"Stories found: {len(stories)}")
    
    # REPLACE: update epics
    print("\n=== Updating Epics ===")
    for summary, key in sorted(epics.items()):
        desc = EPIC_DESCRIPTIONS.get(summary)
        if not desc:
            print(f"  SKIP: {key} - {summary} (no description defined)")
            continue
        result = jira_put(f"/rest/api/3/issue/{key}", {"fields": {"description": desc}})
        status = "OK" if result is not None else "FAIL"
        print(f"  {status}: {key}: {summary}")
        time.sleep(0.5)
    
    # REPLACE: update stories
    print("\n=== Updating Stories ===")
    for summary, key in sorted(stories.items()):
        story_key = summary.split(":")[0] if ":" in summary else summary
        ctx = STORY_CONTEXT.get(story_key)
        if not ctx:
            print(f"  SKIP: {key} - {summary} (no context defined)")
            continue
        desc = make_story_description(summary, ctx["user_story"], ctx["context"], ctx["tech_notes"])
        result = jira_put(f"/rest/api/3/issue/{key}", {"fields": {"description": desc}})
        status = "OK" if result is not None else "FAIL"
        print(f"  {status}: {key}: {summary}")
        time.sleep(0.5)
    
    print("\nDone.")

if __name__ == "__main__":
    main()
