#!/usr/bin/env bash

# Installs only user-level dotfiles with GNU Stow.
# This script is the safe entry point for people who want the desktop configs
# without installing packages, writing to /etc, or changing systemd services.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/stow.sh" install "$@"
