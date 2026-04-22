#!/usr/bin/env python3
"""
Project Dependency Tree Generator

Generates a visual import/require dependency tree for a codebase.
Supports: JavaScript/TypeScript, Python, Go, Java, Rust, Ruby, PHP.

Usage:
    python dependency-tree.py [path] [--max-depth N] [--format tree|json]

Output:
    Prints a tree showing which files import which other files within the project.
"""

import ast
import json
import os
import re
import sys
from argparse import ArgumentParser
from collections import defaultdict
from pathlib import Path


# File extensions per language
EXTENSIONS = {
    "js": [".js", "jsx", ".mjs", ".cjs"],
    "ts": [".ts", ".tsx", ".mts", ".cts"],
    "python": [".py"],
    "go": [".go"],
    "java": [".java"],
    "rust": [".rs"],
    "ruby": [".rb"],
    "php": [".php"],
}


def detect_language(root: Path) -> str:
    """Detect primary language by file count and config files."""
    if (root / "package.json").exists():
        return "ts" if any((root / "tsconfig.json").exists() or f.suffix == ".ts" for f in root.rglob("*")) else "js"
    if any((root / f).exists() for f in ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]):
        return "python"
    if (root / "go.mod").exists():
        return "go"
    if any((root / f).exists() for f in ["pom.xml", "build.gradle", "build.gradle.kts"]):
        return "java"
    if (root / "Cargo.toml").exists():
        return "rust"
    if (root / "Gemfile").exists():
        return "ruby"
    if any((root / f).exists() for f in ["composer.json", "composer.lock"]):
        return "php"

    # Fallback: count files
    counts = {lang: sum(1 for _ in root.rglob("*") if _.suffix in exts) for lang, exts in EXTENSIONS.items()}
    return max(counts, key=counts.get) if counts else "ts"


def resolve_relative_import(base: Path, import_path: str, extensions: list[str], root: Path) -> Path | None:
    """Resolve a relative import path to an absolute file path."""
    if import_path.startswith("."):
        base_dir = base.parent
        # Try exact, then with extensions, then /index.*
        candidates = [base_dir / import_path]
        for ext in extensions:
            candidates.append(base_dir / (import_path + ext))
        if not any(ext in import_path for ext in extensions):
            for ext in extensions:
                candidates.append(base_dir / import_path / ("index" + ext))
        for c in candidates:
            if c.exists() and c.is_file():
                return c.resolve()
    return None


def parse_js_ts_imports(file_path: Path) -> list[Path]:
    """Parse ES/CommonJS imports from JS/TS files."""
    imports = []
    text = file_path.read_text(errors="ignore")
    patterns = [
        r'''import\s+.*?\s+from\s+['"]([^'"]+)['"]''',
        r'''import\s*\(\s*['"]([^'"]+)['"]\s*\)''',
        r'''require\s*\(\s*['"]([^'"]+)['"]\s*\)''',
        r'''import\s+['"]([^'"]+)['"]''',
    ]
    for pat in patterns:
        for m in re.finditer(pat, text):
            raw = m.group(1)
            resolved = resolve_relative_import(file_path, raw, EXTENSIONS["ts"] + EXTENSIONS["js"], file_path)
            if resolved:
                imports.append(resolved)
    return imports


def parse_python_imports(file_path: Path, root: Path) -> list[Path]:
    """Parse Python imports using AST."""
    imports = []
    try:
        tree = ast.parse(file_path.read_text(errors="ignore"))
    except SyntaxError:
        return imports

    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.module:
                parts = node.module.split(".")
            elif isinstance(node, ast.Import):
                # import x.y.z -> take first alias
                parts = node.names[0].name.split(".") if node.names else []
            else:
                continue

            # Try to resolve to file relative to root
            candidate = root
            for part in parts:
                candidate = candidate / part
            candidates = [candidate.with_suffix(".py"), candidate / "__init__.py"]
            for c in candidates:
                if c.exists():
                    imports.append(c.resolve())
                    break
    return imports


def parse_go_imports(file_path: Path, root: Path) -> list[Path]:
    """Parse Go imports."""
    imports = []
    text = file_path.read_text(errors="ignore")
    # Extract quoted strings inside import blocks or single imports
    for m in re.finditer(r'"([^"]+)"', text):
        raw = m.group(1)
        # Only handle module-local imports (contain module name or are relative)
        # We approximate by checking if a matching directory exists under root
        parts = raw.split("/")
        candidate = root
        for part in parts:
            candidate = candidate / part
        go_file = candidate.with_suffix(".go")
        if go_file.exists():
            imports.append(go_file.resolve())
        elif candidate.is_dir():
            # Could be a package directory; try to find a representative file
            for f in candidate.iterdir():
                if f.suffix == ".go" and not f.name.endswith("_test.go"):
                    imports.append(f.resolve())
                    break
    return imports


def parse_java_imports(file_path: Path, root: Path) -> list[Path]:
    """Parse Java imports."""
    imports = []
    text = file_path.read_text(errors="ignore")
    for line in text.splitlines():
        m = re.match(r"import\s+(static\s+)?([^;]+);", line.strip())
        if m:
            class_path = m.group(2).replace(".", "/") + ".java"
            candidate = root
            for part in class_path.split("/"):
                candidate = candidate / part
            # Java source is usually under src/main/java or src/
            for src_dir in [root / "src", root / "src/main/java"]:
                full = src_dir / class_path
                if full.exists():
                    imports.append(full.resolve())
                    break
    return imports


def parse_rust_imports(file_path: Path, root: Path) -> list[Path]:
    """Parse Rust mod/use statements."""
    imports = []
    text = file_path.read_text(errors="ignore")
    for line in text.splitlines():
        m = re.match(r"\s*mod\s+(\w+);", line)
        if m:
            mod_name = m.group(1)
            candidates = [
                file_path.parent / (mod_name + ".rs"),
                file_path.parent / mod_name / "mod.rs",
            ]
            for c in candidates:
                if c.exists():
                    imports.append(c.resolve())
        m = re.match(r"\s*use\s+([^;]+);", line)
        if m:
            path = m.group(1).replace("::", "/").split(" as ")[0].strip()
            candidates = [
                root / "src" / (path + ".rs"),
                root / "src" / path / "mod.rs",
            ]
            for c in candidates:
                if c.exists():
                    imports.append(c.resolve())
    return imports


def parse_generic_imports(file_path: Path, root: Path, lang: str) -> list[Path]:
    """Route to the correct parser."""
    if lang in ("js", "ts"):
        return parse_js_ts_imports(file_path)
    if lang == "python":
        return parse_python_imports(file_path, root)
    if lang == "go":
        return parse_go_imports(file_path, root)
    if lang == "java":
        return parse_java_imports(file_path, root)
    if lang == "rust":
        return parse_rust_imports(file_path, root)
    return []


def build_tree(root: Path, lang: str, max_depth: int = 3) -> dict:
    """Build a nested dependency tree."""
    tree = {}
    visited_global = set()
    extensions = EXTENSIONS.get(lang, [])
    files = [f for f in root.rglob("*") if f.suffix in extensions and not any(part.startswith(".") for part in f.relative_to(root).parts)]

    def recurse(file_path: Path, depth: int, visited: set) -> dict:
        node = {"file": str(file_path.relative_to(root)), "imports": []}
        if depth >= max_depth:
            return node
        imports = parse_generic_imports(file_path, root, lang)
        for imp in imports:
            if imp in visited:
                continue
            visited.add(imp)
            child = recurse(imp, depth + 1, visited)
            node["imports"].append(child)
        return node

    for f in files:
        if f.name in ("index.js", "index.ts", "main.py", "main.rs", "App.java", "server.ts", "server.js"):
            visited_global = set()
            tree[str(f.relative_to(root))] = recurse(f, 0, visited_global)

    if not tree:
        # If no clear entry points, pick the largest files
        files_sorted = sorted(files, key=lambda x: x.stat().st_size, reverse=True)[:5]
        for f in files_sorted:
            visited_global = set()
            tree[str(f.relative_to(root))] = recurse(f, 0, visited_global)

    return tree


def print_tree(node: dict, prefix: str = "", is_last: bool = True) -> None:
    """Pretty-print the tree."""
    connector = "└── " if is_last else "├── "
    print(f"{prefix}{connector}{node['file']}")
    new_prefix = prefix + ("    " if is_last else "│   ")
    children = node.get("imports", [])
    for i, child in enumerate(children):
        print_tree(child, new_prefix, i == len(children) - 1)


def main():
    parser = ArgumentParser(description="Generate a project dependency tree")
    parser.add_argument("path", nargs="?", default=".", help="Project root path")
    parser.add_argument("--max-depth", type=int, default=3, help="Maximum recursion depth")
    parser.add_argument("--format", choices=["tree", "json"], default="tree", help="Output format")
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    lang = detect_language(root)
    tree = build_tree(root, lang, args.max_depth)

    if args.format == "json":
        print(json.dumps(tree, indent=2))
    else:
        for name, node in tree.items():
            print(name)
            for i, child in enumerate(node.get("imports", [])):
                print_tree(child, "", i == len(node["imports"]) - 1)
            print()


if __name__ == "__main__":
    main()
