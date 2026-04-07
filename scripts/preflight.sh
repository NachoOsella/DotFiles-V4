#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
DRY_RUN=0
SKIP_PACKAGES=0
SKIP_SYSTEM=0
SKIP_STOW=0
SKIP_SERVICES=0

usage() {
	cat <<'EOF'
Usage: ./scripts/preflight.sh [--host HOST] [--dry-run] [--skip-packages] [--skip-system] [--skip-stow] [--skip-services]
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--host)
		shift
		[[ $# -gt 0 ]] || die "--host requires a value"
		HOST="$1"
		;;
	--dry-run)
		DRY_RUN=1
		;;
	--skip-packages)
		SKIP_PACKAGES=1
		;;
	--skip-system)
		SKIP_SYSTEM=1
		;;
	--skip-stow)
		SKIP_STOW=1
		;;
	--skip-services)
		SKIP_SERVICES=1
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

check_connectivity() {
	if command_exists curl; then
		curl --head --silent --fail --max-time 8 https://archlinux.org >/dev/null
		return $?
	fi

	if command_exists wget; then
		wget --spider --timeout=8 https://archlinux.org >/dev/null 2>&1
		return $?
	fi

	warn "Skipping connectivity check (curl/wget not available)"
	return 0
}

check_file() {
	local path="$1"
	[[ -f "$path" ]] || die "Missing required file: $(repo_relative "$path")"
}

log "Running preflight checks for host '$HOST'"

if [[ ! -f /etc/arch-release ]]; then
	die "This bootstrap flow currently supports Arch Linux only"
fi

if ((!SKIP_PACKAGES)); then
	require_command pacman
	check_file "$PACKAGES_DIR/pacman.txt"
	check_file "$PACKAGES_DIR/aur.txt"

	if ((!DRY_RUN)); then
		check_connectivity || die "Unable to reach archlinux.org (check network before installing packages)"
	fi
fi

if ((!SKIP_STOW)); then
	if ((!SKIP_PACKAGES)); then
		if ! command_exists stow; then
			warn "stow is not installed yet; package installation step should provide it"
		fi
	else
		require_command stow
	fi
fi

if ((!SKIP_SERVICES)); then
	require_command systemctl
fi

if ((!DRY_RUN)) && ((!SKIP_PACKAGES || !SKIP_SYSTEM || !SKIP_SERVICES)); then
	require_command sudo
	log "Validating sudo access"
	sudo -v || die "Unable to obtain sudo privileges"
fi

overlay_host_root "$HOST" >/dev/null || true

log "Preflight checks passed"
