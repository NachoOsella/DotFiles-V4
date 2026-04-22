#!/usr/bin/env python3
"""Simple duplication detector. Reports line blocks that appear 2+ times.
Usage: python basic-duplication.py <file_or_directory> [--min-lines N]
"""

import hashlib
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_MIN_LINES = 4


def normalize(line):
    """Strip whitespace and comments for comparison."""
    line = line.strip()
    for prefix in ("#", "//", "*", "--"):
        if line.startswith(prefix):
            return ""
    return line


def find_duplicates(filepath, min_lines):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
        return

    blocks = defaultdict(list)
    normalized = [normalize(l) for l in lines]

    for i in range(len(lines) - min_lines + 1):
        block = "\n".join(normalized[i : i + min_lines])
        if not block.strip():
            continue
        h = hashlib.md5(block.encode()).hexdigest()
        blocks[h].append(i)

    found = False
    for h, indices in blocks.items():
        if len(indices) < 2:
            continue
        if not found:
            print(f"\n{filepath}")
            found = True
        print(f"  Duplicated block at lines {[i + 1 for i in indices]}")


def analyze_path(target, min_lines):
    target = Path(target)
    if target.is_file():
        find_duplicates(target, min_lines)
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
                ".cs",
                ".php",
                ".swift",
                ".kt",
                ".rs",
            ):
                find_duplicates(filepath, min_lines)
    else:
        print(f"Not found: {target}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file_or_directory> [--min-lines N]")
        sys.exit(1)

    target = sys.argv[1]
    min_lines = DEFAULT_MIN_LINES
    if "--min-lines" in sys.argv:
        idx = sys.argv.index("--min-lines")
        try:
            min_lines = int(sys.argv[idx + 1])
        except (IndexError, ValueError):
            print("Invalid --min-lines value")
            sys.exit(1)

    analyze_path(target, min_lines)
