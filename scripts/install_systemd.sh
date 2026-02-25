#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_SERVICE="$SCRIPT_DIR/systemd/clean-arch.service"
SRC_TIMER="$SCRIPT_DIR/systemd/clean-arch.timer"
DST_DIR="$HOME/.config/systemd/user"
DST_SERVICE="$DST_DIR/clean-arch.service"
DST_TIMER="$DST_DIR/clean-arch.timer"

if [[ ! -f "$SRC_SERVICE" || ! -f "$SRC_TIMER" ]]; then
  echo "Missing unit files in: $SCRIPT_DIR/systemd" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
install -m 0644 "$SRC_SERVICE" "$DST_SERVICE"
install -m 0644 "$SRC_TIMER" "$DST_TIMER"

systemctl --user daemon-reload
systemctl --user enable --now clean-arch.timer

echo
echo "Installed user units:"
echo "  $DST_SERVICE"
echo "  $DST_TIMER"
echo
echo "Timer status:"
systemctl --user --no-pager --full status clean-arch.timer || true
echo
echo "Next runs:"
systemctl --user list-timers --all --no-pager | grep -E 'clean-arch|NEXT|LAST' || true
echo
echo "Done."
