#!/usr/bin/env bash
set -euo pipefail

WALLPAPER_PATH="${1:-}"

if [[ -z "$WALLPAPER_PATH" ]]; then
  WALLPAPER_PATH="$(rg -n "path\s*=\s*" hypr/.config/hypr/hyprpaper.conf | head -n1 | sed -E 's/.*path\s*=\s*//')"
fi

if [[ -z "$WALLPAPER_PATH" ]]; then
  echo "Could not detect wallpaper path. Pass one as first argument."
  exit 1
fi

if [[ ! -f "$WALLPAPER_PATH" ]]; then
  echo "Wallpaper file not found: $WALLPAPER_PATH"
  exit 1
fi

python3 - <<'PY' "$WALLPAPER_PATH"
from pathlib import Path
import sys

wall = sys.argv[1]
hyprpaper = Path('hypr/.config/hypr/hyprpaper.conf')
hyprlock = Path('hypr/.config/hypr/hyprlock.conf')

hp = hyprpaper.read_text()
lines = []
for line in hp.splitlines():
    if line.strip().startswith('path = '):
        indent = line[: len(line) - len(line.lstrip())]
        lines.append(f"{indent}path = {wall}")
    else:
        lines.append(line)
hyprpaper.write_text("\n".join(lines) + "\n")

if hyprlock.exists():
    hl = hyprlock.read_text()
    import re
    hl = re.sub(r'(path\s*=\s*).*', rf'\1{wall}', hl, count=1)
    hyprlock.write_text(hl)

print(f"Wallpaper configured: {wall}")
PY

echo "Updated wallpaper in:"
echo "  hypr/.config/hypr/hyprpaper.conf"
echo "  hypr/.config/hypr/hyprlock.conf"
