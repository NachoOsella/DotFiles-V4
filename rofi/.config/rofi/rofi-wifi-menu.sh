#!/usr/bin/env bash
set -euo pipefail

exec python3 "${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/scripts/iwd-client.py" menu
