#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: validate.sh <presentation.md> [presenterm-config.yaml]

Performs static path/fence checks and, when Presenterm is installed, exports a
self-contained HTML file in a temporary directory to validate parsing/rendering.
It does not enable executable snippets.
USAGE
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

deck="$1"
config="${2:-}"

if [[ ! -f "$deck" ]]; then
  echo "error: deck not found: $deck" >&2
  exit 1
fi

python3 - "$deck" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

path = Path(sys.argv[1]).resolve()
text = path.read_text(encoding="utf-8")
errors: list[str] = []
warnings: list[str] = []

if "<!-- end_slide -->" not in text:
    warnings.append("no explicit <!-- end_slide --> separator found")

fences = re.findall(r"^\s*(```+|~~~+)", text, flags=re.MULTILINE)
if len(fences) % 2:
    errors.append("an unclosed fenced code block may exist")

remote_images = re.findall(r"!\[[^\]]*\]\((https?://[^)]+)\)", text)
for url in remote_images:
    errors.append(f"remote image is unsupported: {url}")

for raw in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text):
    target = raw.strip().split(maxsplit=1)[0].strip("<>")
    if target.startswith(("http://", "https://", "data:")):
        continue
    target_path = (path.parent / target).resolve()
    if not target_path.exists():
        errors.append(f"missing image: {target}")

front = re.match(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", text, flags=re.DOTALL)
if front:
    theme_match = re.search(r"(?m)^\s*path:\s*(.+?)\s*$", front.group(1))
    if theme_match:
        theme = theme_match.group(1).strip().strip("'\"")
        theme_path = (path.parent / theme).resolve()
        if not theme_path.exists():
            errors.append(f"missing theme file: {theme}")
else:
    warnings.append("no YAML front matter found")

columns = [int(v) for v in re.findall(r"<!--\s*column:\s*(\d+)\s*-->", text)]
layouts = re.findall(r"<!--\s*column_layout:\s*\[([^]]+)\]\s*-->", text)
if columns and not layouts:
    errors.append("column commands exist without a column_layout command")

for message in warnings:
    print(f"warning: {message}")
for message in errors:
    print(f"error: {message}", file=sys.stderr)

if errors:
    raise SystemExit(1)

print("static checks passed")
PY

if [[ -n "$config" && ! -f "$config" ]]; then
  echo "error: config not found: $config" >&2
  exit 1
fi

if ! command -v presenterm >/dev/null 2>&1; then
  echo "warning: presenterm is not installed; render validation skipped"
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
output="$tmp_dir/presentation.html"

cmd=(presenterm)
if [[ -n "$config" ]]; then
  cmd+=(--config-file "$config")
fi
cmd+=(--export-html "$deck" --output "$output")

"${cmd[@]}"

if [[ ! -s "$output" ]]; then
  echo "error: Presenterm did not produce a non-empty HTML export" >&2
  exit 1
fi

echo "render validation passed"
