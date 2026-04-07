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

mkdir -p "$PACKAGES_DIR" "$(host_packages_dir "$HOST")" "$(host_services_dir "$HOST")" "$(host_system_dir "$HOST")/etc/tlp.d"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pacman -Qqe | sort -u >"$tmpdir/explicit.txt"
pacman -Qqem | sort -u >"$tmpdir/aur.txt"
comm -23 "$tmpdir/explicit.txt" "$tmpdir/aur.txt" >"$PACKAGES_DIR/pacman.txt"
cp "$tmpdir/aur.txt" "$PACKAGES_DIR/aur.txt"

if [[ -r /etc/tlp.conf ]]; then
	awk -F= '
		/^[[:space:]]*START_CHARGE_THRESH_BAT0=/ || /^[[:space:]]*STOP_CHARGE_THRESH_BAT0=/ {
			print $0
		}
	' /etc/tlp.conf >"$(host_system_dir "$HOST")/etc/tlp.d/10-battery.conf"
fi

if [[ -d /etc/tlp.d ]]; then
	mkdir -p "$(host_system_dir "$HOST")/etc/tlp.d"
	find /etc/tlp.d -maxdepth 1 -type f -name '*.conf' -print0 |
		while IFS= read -r -d '' file; do
			install -D -m 0644 "$file" "$(host_system_dir "$HOST")/etc/tlp.d/$(basename "$file")"
		done
fi

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

if [[ -f /etc/NetworkManager/NetworkManager.conf ]]; then
	install -D -m 0644 /etc/NetworkManager/NetworkManager.conf \
		"$SYSTEM_DIR/etc/NetworkManager/NetworkManager.conf"
fi

if [[ -d /etc/NetworkManager/conf.d ]]; then
	mkdir -p "$SYSTEM_DIR/etc/NetworkManager/conf.d"
	find /etc/NetworkManager/conf.d -maxdepth 1 -type f -name '*.conf' -print0 |
		while IFS= read -r -d '' file; do
			install -D -m 0644 "$file" "$SYSTEM_DIR/etc/NetworkManager/conf.d/$(basename "$file")"
		done
fi

log "Captured package manifests for host '$HOST'"
log "Review package and service lists before committing"
