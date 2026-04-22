#!/usr/bin/env python3
"""Simple script to report lines per method and nesting depth per file.
Supports Python, JavaScript, TypeScript, Java, C/C++, Go, Ruby.
Usage: python method-metrics.py <file_or_directory>
"""

import ast
import os
import re
import sys
from pathlib import Path


def count_nesting(lines, start_idx, end_idx):
    """Count maximum nesting depth for a block of lines."""
    depth = 0
    max_depth = 0
    for i in range(start_idx, end_idx):
        stripped = lines[i].lstrip()
        indent = len(lines[i]) - len(stripped)
        if indent > depth:
            depth = indent
        elif indent < depth and stripped:
            depth = indent
        if depth > max_depth:
            max_depth = depth
    # Convert indent levels to approximate nesting levels (assume 2 or 4 spaces)
    if max_depth == 0:
        return 0
    return (max_depth // 2) + 1


def analyze_python(filepath):
    """Use AST for accurate Python metrics."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source)
    except SyntaxError as e:
        print(f"  Syntax error in {filepath}: {e}")
        return

    lines = source.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = node.name
            start = node.lineno - 1
            end = node.end_lineno
            length = end - start
            depth = count_nesting(lines, start, end)
            print(f"  {name}: {length} lines, nesting ~{depth}")


def analyze_with_regex(filepath, pattern, name_group=1):
    """Fallback regex-based analysis for non-Python files."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"  Error reading {filepath}: {e}")
        return

    for i, line in enumerate(lines):
        m = pattern.search(line)
        if m:
            name = m.group(name_group)
            # Find end of method: next line at same or lower indent with content, or closing brace
            start_indent = len(line) - len(line.lstrip())
            j = i + 1
            while j < len(lines):
                stripped = lines[j].lstrip()
                if not stripped or stripped.startswith("//") or stripped.startswith("*"):
                    j += 1
                    continue
                cur_indent = len(lines[j]) - len(lines[j].lstrip())
                if stripped.startswith("}") or (cur_indent <= start_indent and stripped):
                    break
                j += 1
            length = j - i
            depth = count_nesting(lines, i, j)
            print(f"  {name}: {length} lines, nesting ~{depth}")


def analyze_file(filepath):
    path = Path(filepath)
    suffix = path.suffix.lower()
    print(f"\n{filepath}")

    if suffix == ".py":
        analyze_python(filepath)
    elif suffix in (".js", ".ts", ".java", ".c", ".cpp", ".h", ".go", ".rb"):
        # Simple regex for function/method signatures
        pattern = re.compile(
            r"(?:function\s+(\w+)|(\w+)\s*\(.*\)\s*\{|def\s+(\w+)|func\s+(\w+))"
        )
        analyze_with_regex(filepath, pattern)
    else:
        print(f"  Skipped (unsupported extension: {suffix})")


def analyze_path(target):
    target = Path(target)
    if target.is_file():
        analyze_file(target)
    elif target.is_dir():
        for filepath in target.rglob("*"):
            if filepath.is_file() and filepath.suffix.lower() in (
                ".py",
                ".js",
                ".ts",
                ".java",
                ".c",
                ".cpp",
                ".h",
                ".go",
                ".rb",
            ):
                analyze_file(filepath)
    else:
        print(f"Not found: {target}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file_or_directory>")
        sys.exit(1)
    analyze_path(sys.argv[1])
