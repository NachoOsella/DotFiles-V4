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

overlay_host_root "$HOST" >/dev/null || true
export DOTFILES_OVERLAY_NOTICE_KEY="${DOTFILES_OVERLAY_NOTICE_KEY:-}"

PREFLIGHT_ARGS=(--host "$HOST")
if ((DRY_RUN)); then
	PREFLIGHT_ARGS+=(--dry-run)
fi
if ((SKIP_PACKAGES)); then
	PREFLIGHT_ARGS+=(--skip-packages)
fi
if ((SKIP_SYSTEM)); then
	PREFLIGHT_ARGS+=(--skip-system)
fi
if ((SKIP_STOW)); then
	PREFLIGHT_ARGS+=(--skip-stow)
fi
if ((SKIP_SERVICES)); then
	PREFLIGHT_ARGS+=(--skip-services)
fi

banner() {
	if [[ -t 1 && -n ${TERM:-} ]]; then
		clear || true
	fi
	echo -e "${ORANGE}${BOLD}"
	echo "   _____ __                 __  "
	echo "  / ___// /_____ _      __ / /  "
	echo "  \__ \/ __/ __ \ | /| / // /   "
	echo " ___/ / /_/ /_/ / |/ |/ //_/    "
	echo "/____/\__/\____/|__/|__(_)      "
	echo -e "${RESET}"
	echo -e "${DIM}  Automated System Bootstrap ${RESET}"
	echo -e "${DIM}  Target Host: ${HOST} ${RESET}"
	echo ""
}

banner

log_task "Starting Preflight Checks"
bash "$SCRIPT_DIR/preflight.sh" "${PREFLIGHT_ARGS[@]}"

log_task "Bootstrapping Environment"

if ((!SKIP_PACKAGES)); then
	log_step "Installing Packages"
	"$SCRIPT_DIR/install-packages.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi

if ((!SKIP_SYSTEM)); then
	log_step "Applying System Configuration"
	"$SCRIPT_DIR/apply-system.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi

if ((!SKIP_STOW)); then
	log_step "Linking User Configuration (Stow)"
	require_command stow
	if ((DRY_RUN)); then
		log "[dry-run] ./scripts/stow.sh install"
	else
		"$SCRIPT_DIR/stow.sh" install
	fi
fi

if ((!SKIP_SERVICES)); then
	log_step "Enabling System & User Services"
	"$SCRIPT_DIR/enable-services.sh" --host "$HOST" $([[ $DRY_RUN -eq 1 ]] && printf '%s' --dry-run)
fi

echo ""
echo -e "${GREEN}${BOLD}${ICON_OK} System bootstrap complete!${RESET}"
echo -e "${DIM}Please reboot your system for all changes to take effect.${RESET}"
echo ""
