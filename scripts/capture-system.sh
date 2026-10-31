#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
CAPTURE_SERVICES=1

usage() {
	cat <<'EOF'
Usage: ./scripts/capture-system.sh [--host HOST] [--skip-services]
Regenerates package manifests and captures relevant host overrides.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--host)
		shift
		[[ $# -gt 0 ]] || die "--host requires a value"
		HOST="$1"
		;;
	--skip-services)
		CAPTURE_SERVICES=0
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "Unknown argument: $1"
		;;
	esac
	shift
done

require_command pacman
require_command sort
require_command comm

mkdir -p "$PACKAGES_DIR" "$(host_packages_dir "$HOST")" "$(host_services_dir "$HOST")"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pacman -Qqe | sort -u >"$tmpdir/explicit.txt"
pacman -Qqem | sort -u >"$tmpdir/aur.txt"
comm -23 "$tmpdir/explicit.txt" "$tmpdir/aur.txt" >"$PACKAGES_DIR/pacman.txt"
cp "$tmpdir/aur.txt" "$PACKAGES_DIR/aur.txt"

if ((CAPTURE_SERVICES)); then
	if command_exists systemctl; then
		if systemctl list-unit-files --state=enabled --no-legend >/dev/null 2>&1; then
			systemctl list-unit-files --state=enabled --no-legend |
				awk '{print $1}' |
				sort -u >"$(host_services_dir "$HOST")/system.txt"
		else
			warn "Could not query system services; skipping system.txt"
		fi

		if systemctl --user list-unit-files --state=enabled --no-legend >/dev/null 2>&1; then
			systemctl --user list-unit-files --state=enabled --no-legend |
				awk '{print $1}' |
				sort -u >"$(host_services_dir "$HOST")/user.txt"
		else
			warn "Could not query user services; skipping user.txt"
		fi
	fi
fi

log "Captured package manifests for host '$HOST'"
log "Review package and service lists before committing"
