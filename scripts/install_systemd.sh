#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/stow.sh" install systemd-user
"$SCRIPT_DIR/enable-services.sh"
