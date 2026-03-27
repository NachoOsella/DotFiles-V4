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
Usage: ./scripts/bootstrap.sh [--host HOST] [--dry-run] [--skip-packages] [--skip-system] [--skip-stow] [--skip-services]
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

require_command bash

log "Bootstrapping host '$HOST'"

if (( ! SKIP_PACKAGES )); then
	"$SCRIPT_DIR/install-packages.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi

if (( ! SKIP_SYSTEM )); then
	"$SCRIPT_DIR/apply-system.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi

if (( ! SKIP_STOW )); then
	require_command stow
	if (( DRY_RUN )); then
		log "[dry-run] ./scripts/stow.sh install"
	else
		"$SCRIPT_DIR/stow.sh" install
	fi
fi

if (( ! SKIP_SERVICES )); then
	"$SCRIPT_DIR/enable-services.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi
