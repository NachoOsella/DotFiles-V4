#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
DRY_RUN=0

usage() {
	cat <<'EOF'
Usage: ./scripts/enable-services.sh [--host HOST] [--dry-run]
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

overlay_host_root "$HOST" >/dev/null || true
export DOTFILES_OVERLAY_NOTICE_KEY="${DOTFILES_OVERLAY_NOTICE_KEY:-}"

mapfile -t SYSTEM_UNITS < <(collect_service_units "$HOST" system | sort -u)
mapfile -t USER_UNITS < <(collect_service_units "$HOST" user | sort -u)
mapfile -t DISABLED_UNITS < <(collect_disabled_units "$HOST" | sort -u)

if ((${#DISABLED_UNITS[@]} > 0)); then
	log "Disabling conflicting system units for host '$HOST'"
	for unit in "${DISABLED_UNITS[@]}"; do
		if ((DRY_RUN)); then
			log "[dry-run] systemctl disable --now $unit"
			log "[dry-run] systemctl mask $unit"
		else
			sudo systemctl disable --now "$unit" 2>/dev/null || true
			sudo systemctl mask "$unit"
		fi
	done
fi

if ((${#SYSTEM_UNITS[@]} > 0)); then
	log "Enabling system units for host '$HOST'"
	for unit in "${SYSTEM_UNITS[@]}"; do
		if ((DRY_RUN)); then
			log "[dry-run] systemctl enable --now $unit"
		else
			sudo systemctl enable --now "$unit"
		fi
	done
fi

if ((${#USER_UNITS[@]} > 0)); then
	log "Enabling user units for host '$HOST'"
	if ((DRY_RUN)); then
		log "[dry-run] systemctl --user daemon-reload"
	else
		systemctl --user daemon-reload
	fi

	for unit in "${USER_UNITS[@]}"; do
		if ((DRY_RUN)); then
			log "[dry-run] systemctl --user enable --now $unit"
		else
			systemctl --user enable --now "$unit"
		fi
	done
fi
