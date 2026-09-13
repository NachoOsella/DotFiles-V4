#!/usr/bin/env python3
"""Check public functions/classes for missing docstrings.

Usage:
    python check_docstrings.py <path> [--lang python|javascript|typescript|java|rust]

Exit codes:
    0  All checked items have docstrings.
    1  One or more public items are missing docstrings.
"""

import argparse
import ast
import os
import re
import sys
from pathlib import Path


def missing_docstrings_python(file_path: Path, source: str) -> list[str]:
    """Return list of "file:line name" for public items missing docstrings."""
    tree = ast.parse(source)
    missing: list[str] = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = node.name
            # Skip private and dunder items
            if name.startswith("_"):
                continue
            # Skip module-level if __all__ is present and name not exported
            if getattr(node, "body", None) and not ast.get_docstring(node):
                missing.append(f"{file_path}:{node.lineno} {name}")
    return missing


def missing_docstrings_js_ts(file_path: Path, source: str) -> list[str]:
    """Heuristic check for JSDoc on exported functions/classes in JS/TS."""
    missing: list[str] = []
    lines = source.splitlines()

    # Pattern: export function/class/const arrow function
    export_pattern = re.compile(
        r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+\w+\s*=\s*(?:async\s+)?\()?"
    )

    for i, line in enumerate(lines, start=1):
        if export_pattern.search(line):
            # Look back up to 10 lines for a JSDoc block
            found = False
            for j in range(max(0, i - 10), i):
                if lines[j].strip().startswith("/**"):
                    found = True
                    break
            if not found:
                # Extract name roughly
                name_match = re.search(r"(?:function|class|const)\s+(\w+)", line)
                name = name_match.group(1) if name_match else "<anonymous>"
                missing.append(f"{file_path}:{i} {name}")
    return missing


def missing_docstrings_java(file_path: Path, source: str) -> list[str]:
    """Heuristic check for Javadoc on public methods/classes in Java."""
    missing: list[str] = []
    lines = source.splitlines()
    in_javadoc = False

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("/**"):
            in_javadoc = True
        if stripped.endswith("*/"):
            in_javadoc = False

        # Match public class/method (skip interfaces/abstract if needed)
        if re.search(r"^\s+public\s+(?:static\s+)?(?:[\w<>,\[\]]+\s+)?\w+\s*\(", stripped):
            if not in_javadoc and not re.search(r"^\s*//", stripped):
                name_match = re.search(r"\w+\s*(?:\(|\{)", stripped)
                name = name_match.group(0).rstrip("({") if name_match else "<unknown>"
                missing.append(f"{file_path}:{i} {name}")
    return missing


def missing_docstrings_rust(file_path: Path, source: str) -> list[str]:
    """Heuristic check for doc comments on pub items in Rust."""
    missing: list[str] = []
    lines = source.splitlines()

    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("pub ") and not stripped.startswith("pub use"):
            # Look back for doc comment
            found = False
            for j in range(max(0, i - 5), i):
                if lines[j].strip().startswith("///") or lines[j].strip().startswith("//!"):
                    found = True
                    break
            if not found:
                name_match = re.search(r"pub\s+(?:fn|struct|enum|trait|type|const|static)\s+(\w+)", stripped)
                name = name_match.group(1) if name_match else "<unknown>"
                missing.append(f"{file_path}:{i} {name}")
    return missing


LANG_HANDLERS = {
    "python": (".py", missing_docstrings_python),
    "javascript": (".js", missing_docstrings_js_ts),
    "typescript": (".ts", missing_docstrings_js_ts),
    "java": (".java", missing_docstrings_java),
    "rust": (".rs", missing_docstrings_rust),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Check for missing docstrings on public API surface.")
    parser.add_argument("path", type=Path, help="File or directory to scan.")
    parser.add_argument("--lang", choices=list(LANG_HANDLERS.keys()), help="Language override.")
    args = parser.parse_args()

    all_missing: list[str] = []

    if args.path.is_file():
        files = [args.path]
    else:
        files = [p for p in args.path.rglob("*") if p.is_file()]

    for file_path in files:
        ext = file_path.suffix.lower()
        handler = None

        if args.lang:
            expected_ext, handler = LANG_HANDLERS[args.lang]
            if ext != expected_ext:
                continue
        else:
            for expected_ext, h in LANG_HANDLERS.values():
                if ext == expected_ext:
                    handler = h
                    break

        if handler is None:
            continue

        try:
            source = file_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"Skipping {file_path}: {e}", file=sys.stderr)
            continue

        all_missing.extend(handler(file_path, source))

    if all_missing:
        print("Missing docstrings detected:")
        for entry in all_missing:
            print(f"  - {entry}")
        return 1

    print("No missing docstrings found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
