#!/usr/bin/env python3
"""
Structure Summary Script

Scans a codebase and produces a summary of:
- Detected entry points (main files, servers, CLI executables, framework entry files)
- Main classes / top-level types (exported classes, public structs, large classes)
- Top-level modules / packages
- Framework and build system detection

Usage:
    python structure-summary.py [path]

Output:
    Prints a structured summary to stdout.
"""

import ast
import json
import os
import re
import sys
from argparse import ArgumentParser
from collections import defaultdict
from pathlib import Path


def detect_framework(root: Path) -> dict:
    """Detect framework, language, and build system from config files."""
    result = {"language": None, "framework": None, "build_system": None, "workspace": False}

    if (root / "package.json").exists():
        result["language"] = "JavaScript/TypeScript"
        result["build_system"] = "npm/yarn/pnpm"
        pkg = json.loads((root / "package.json").read_text(errors="ignore"))
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        frameworks = {
            "next": "Next.js",
            "nuxt": "Nuxt",
            "react": "React",
            "vue": "Vue",
            "svelte": "Svelte/SvelteKit",
            "@angular/core": "Angular",
            "express": "Express",
            "fastify": "Fastify",
            "nest": "NestJS",
        }
        for key, name in frameworks.items():
            if any(k.startswith(key) for k in deps):
                result["framework"] = name
                break
        if "workspaces" in pkg or (root / "pnpm-workspace.yaml").exists():
            result["workspace"] = True
            result["build_system"] = "pnpm workspaces / monorepo"
        if (root / "turbo.json").exists():
            result["workspace"] = True
            result["build_system"] = "Turborepo"
        if (root / "nx.json").exists():
            result["workspace"] = True
            result["build_system"] = "Nx"

    elif (root / "go.mod").exists():
        result["language"] = "Go"
        result["build_system"] = "Go modules"
    elif any((root / f).exists() for f in ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"]):
        result["language"] = "Python"
        result["build_system"] = "pip/setuptools/poetry"
        if (root / "pyproject.toml").exists():
            text = (root / "pyproject.toml").read_text(errors="ignore")
            if "django" in text.lower():
                result["framework"] = "Django"
            elif "flask" in text.lower():
                result["framework"] = "Flask"
            elif "fastapi" in text.lower():
                result["framework"] = "FastAPI"
    elif (root / "Cargo.toml").exists():
        result["language"] = "Rust"
        result["build_system"] = "Cargo"
    elif any((root / f).exists() for f in ["pom.xml", "build.gradle"]):
        result["language"] = "Java"
        result["build_system"] = "Maven/Gradle"
        if (root / "build.gradle").exists():
            text = (root / "build.gradle").read_text(errors="ignore")
            if "spring" in text.lower():
                result["framework"] = "Spring Boot"
    elif any((root / f).exists() for f in ["composer.json", "composer.lock"]):
        result["language"] = "PHP"
        result["build_system"] = "Composer"
        if (root / "artisan").exists():
            result["framework"] = "Laravel"
    elif (root / "Gemfile").exists():
        result["language"] = "Ruby"
        result["build_system"] = "Bundler"
        if (root / "config.ru").exists():
            result["framework"] = "Rack/Sinatra"
        if any((root / d).exists() for d in ["app/controllers", "app/models", "app/views"]):
            result["framework"] = "Ruby on Rails"

    return result


def find_entry_points(root: Path, info: dict) -> list[str]:
    """Find likely entry points based on language/framework."""
    entries = []
    lang = info.get("language", "")
    framework = info.get("framework", "")

    if "JavaScript/TypeScript" in lang or "Node" in lang:
        if framework in ("Next.js",):
            entries += [str(p.relative_to(root)) for p in root.rglob("page.tsx") if "node_modules" not in str(p)]
            if (root / "server.ts").exists():
                entries.append("server.ts")
        elif framework in ("Nuxt",):
            entries += [str(p.relative_to(root)) for p in root.rglob("*.vue") if p.parent.name == "pages"]
        else:
            for name in ["index.js", "index.ts", "main.js", "main.ts", "server.ts", "server.js", "app.ts", "app.js", "cli.ts", "cli.js"]:
                if (root / name).exists():
                    entries.append(name)
                for f in root.rglob(name):
                    if "node_modules" not in str(f):
                        entries.append(str(f.relative_to(root)))
        # Check package.json bin and main fields
        if (root / "package.json").exists():
            pkg = json.loads((root / "package.json").read_text(errors="ignore"))
            if "main" in pkg:
                entries.append(pkg["main"])
            if "bin" in pkg:
                if isinstance(pkg["bin"], dict):
                    entries += list(pkg["bin"].values())
                elif isinstance(pkg["bin"], str):
                    entries.append(pkg["bin"])

    elif lang == "Python":
        for name in ["__main__.py", "main.py", "manage.py", "app.py", "server.py", "wsgi.py", "asgi.py", "cli.py"]:
            if (root / name).exists():
                entries.append(name)
        # pyproject.toml scripts
        if (root / "pyproject.toml").exists():
            text = (root / "pyproject.toml").read_text(errors="ignore")
            for line in text.splitlines():
                m = re.match(r'\s*"?(\w+)"?\s*=\s*"([^"]+)"', line)
                if m and "." in m.group(2):
                    entries.append(f"[script] {m.group(1)} -> {m.group(2)}")

    elif lang == "Go":
        for f in root.rglob("main.go"):
            if "vendor" not in str(f):
                entries.append(str(f.relative_to(root)))
        for f in root.rglob("*.go"):
            if f.parent.name == "cmd" and f.name == "main.go":
                entries.append(str(f.relative_to(root)))

    elif lang == "Rust":
        if (root / "src/main.rs").exists():
            entries.append("src/main.rs")
        for f in (root / "src/bin").glob("*.rs") if (root / "src/bin").exists() else []:
            entries.append(str(f.relative_to(root)))

    elif lang == "Java":
        for f in root.rglob("*.java"):
            text = f.read_text(errors="ignore")
            if "public static void main" in text:
                entries.append(str(f.relative_to(root)))

    elif lang == "Ruby":
        for name in ["config.ru", "Rakefile", "bin/rails", "bin/rake"]:
            if (root / name).exists():
                entries.append(name)
        for f in root.rglob("*.rb"):
            text = f.read_text(errors="ignore")
            if "require_relative" in text and f.parent.name == "bin":
                entries.append(str(f.relative_to(root)))

    # De-duplicate while preserving order
    seen = set()
    unique = []
    for e in entries:
        if e not in seen:
            seen.add(e)
            unique.append(e)
    return unique[:20]


def find_main_classes(root: Path, info: dict) -> list[dict]:
    """Find main classes, structs, or types in the codebase."""
    classes = []
    lang = info.get("language", "")

    if "JavaScript/TypeScript" in lang:
        for f in root.rglob("*.ts"):
            if "node_modules" in str(f):
                continue
            text = f.read_text(errors="ignore")
            # export class / export default class / export abstract class
            for m in re.finditer(r"export\s+(default\s+)?(abstract\s+)?class\s+(\w+)", text):
                classes.append({
                    "name": m.group(3),
                    "file": str(f.relative_to(root)),
                    "type": "class",
                })
            for m in re.finditer(r"export\s+interface\s+(\w+)", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "interface",
                })

    elif lang == "Python":
        for f in root.rglob("*.py"):
            if "__pycache__" in str(f):
                continue
            try:
                tree = ast.parse(f.read_text(errors="ignore"))
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    classes.append({
                        "name": node.name,
                        "file": str(f.relative_to(root)),
                        "type": "class",
                    })

    elif lang == "Go":
        for f in root.rglob("*.go"):
            if "vendor" in str(f):
                continue
            text = f.read_text(errors="ignore")
            for m in re.finditer(r"type\s+(\w+)\s+struct", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "struct",
                })
            for m in re.finditer(r"type\s+(\w+)\s+interface", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "interface",
                })

    elif lang == "Rust":
        for f in root.rglob("*.rs"):
            text = f.read_text(errors="ignore")
            for m in re.finditer(r"pub\s+(struct|enum|trait)\s+(\w+)", text):
                classes.append({
                    "name": m.group(2),
                    "file": str(f.relative_to(root)),
                    "type": m.group(1),
                })

    elif lang == "Java":
        for f in root.rglob("*.java"):
            text = f.read_text(errors="ignore")
            for m in re.finditer(r"(public\s+)?(abstract\s+)?class\s+(\w+)", text):
                classes.append({
                    "name": m.group(3),
                    "file": str(f.relative_to(root)),
                    "type": "class",
                })
            for m in re.finditer(r"public\s+interface\s+(\w+)", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "interface",
                })

    elif lang == "Ruby":
        for f in root.rglob("*.rb"):
            text = f.read_text(errors="ignore")
            for m in re.finditer(r"class\s+([A-Z]\w+)", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "class",
                })
            for m in re.finditer(r"module\s+([A-Z]\w+)", text):
                classes.append({
                    "name": m.group(1),
                    "file": str(f.relative_to(root)),
                    "type": "module",
                })

    # Sort by file depth (top-level first) and name
    classes.sort(key=lambda c: (c["file"].count("/"), c["name"]))
    return classes[:30]


def find_top_modules(root: Path, info: dict) -> list[str]:
    """Find top-level modules or packages."""
    modules = []
    lang = info.get("language", "")

    if "JavaScript/TypeScript" in lang:
        src = root / "src"
        if src.exists():
            modules = [d.name for d in src.iterdir() if d.is_dir() and d.name not in ("node_modules", ".git")]
        elif (root / "packages").exists():
            modules = [d.name for d in (root / "packages").iterdir() if d.is_dir()]
        elif (root / "apps").exists():
            modules = [d.name for d in (root / "apps").iterdir() if d.is_dir()]

    elif lang == "Python":
        # Look for top-level packages (directories with __init__.py)
        for d in root.iterdir():
            if d.is_dir() and not d.name.startswith(".") and (d / "__init__.py").exists():
                modules.append(d.name)
        if not modules and (root / "src").exists():
            for d in (root / "src").iterdir():
                if d.is_dir() and not d.name.startswith(".") and (d / "__init__.py").exists():
                    modules.append(f"src/{d.name}")

    elif lang == "Go":
        for d in root.iterdir():
            if d.is_dir() and not d.name.startswith(".") and any(f.suffix == ".go" for f in d.iterdir()):
                modules.append(d.name)
        if (root / "pkg").exists():
            modules += [f"pkg/{d.name}" for d in (root / "pkg").iterdir() if d.is_dir()]
        if (root / "internal").exists():
            modules += [f"internal/{d.name}" for d in (root / "internal").iterdir() if d.is_dir()]

    elif lang == "Rust":
        if (root / "src").exists():
            modules = [f.name for f in (root / "src").iterdir() if f.is_dir() or f.suffix == ".rs"]

    elif lang == "Java":
        src = root / "src/main/java" if (root / "src/main/java").exists() else root / "src"
        if src.exists():
            modules = [d.name for d in src.iterdir() if d.is_dir()]

    elif lang == "Ruby":
        if (root / "app").exists():
            modules = [d.name for d in (root / "app").iterdir() if d.is_dir()]
        elif (root / "lib").exists():
            modules = [d.name for d in (root / "lib").iterdir() if d.is_dir()]

    return sorted(set(modules))[:20]


def main():
    parser = ArgumentParser(description="Summarize codebase structure")
    parser.add_argument("path", nargs="?", default=".", help="Project root path")
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    info = detect_framework(root)
    entries = find_entry_points(root, info)
    classes = find_main_classes(root, info)
    modules = find_top_modules(root, info)

    print(f"Project: {root.name}")
    print(f"Language: {info['language'] or 'Unknown'}")
    print(f"Framework: {info['framework'] or 'None detected'}")
    print(f"Build System: {info['build_system'] or 'Unknown'}")
    print(f"Workspace/Monorepo: {'Yes' if info['workspace'] else 'No'}")
    print()

    print("Entry Points:")
    if entries:
        for e in entries:
            print(f"  - {e}")
    else:
        print("  (none detected)")
    print()

    print("Top-Level Modules:")
    if modules:
        for m in modules:
            print(f"  - {m}")
    else:
        print("  (none detected)")
    print()

    print("Main Classes/Types:")
    if classes:
        for c in classes[:20]:
            print(f"  - {c['name']} ({c['type']}) in {c['file']}")
    else:
        print("  (none detected)")


if __name__ == "__main__":
    main()
