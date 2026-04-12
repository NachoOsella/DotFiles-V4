#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
DRY_RUN=0
PACMAN_ONLY=0

usage() {
	cat <<'EOF'
Usage: ./scripts/install-packages.sh [--host HOST] [--dry-run] [--pacman-only]
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
	--pacman-only)
		PACMAN_ONLY=1
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

overlay_host_root "$HOST" >/dev/null || true
export DOTFILES_OVERLAY_NOTICE_KEY="${DOTFILES_OVERLAY_NOTICE_KEY:-}"

mapfile -t PACMAN_PACKAGES < <(collect_manifest_packages "$HOST" pacman | sort -u)
mapfile -t AUR_PACKAGES < <(collect_manifest_packages "$HOST" aur | sort -u)

install_yay() {
	if command_exists yay; then
		return 0
	fi

	if ((DRY_RUN)); then
		log "[dry-run] Would install yay from AUR"
		return 0
	fi

	require_command git
	require_command makepkg

	local workdir
	workdir="$(mktemp -d)"
	trap 'rm -rf "$workdir"' RETURN

	log "Installing yay AUR helper"
	git clone https://aur.archlinux.org/yay.git "$workdir/yay"
	(
		cd "$workdir/yay"
		makepkg -si --noconfirm
	)
}

if ((${#PACMAN_PACKAGES[@]} > 0)); then
	log "Installing ${#PACMAN_PACKAGES[@]} official packages for host '$HOST'"
	print_package_grid "${PACMAN_PACKAGES[@]}"
	if ((DRY_RUN)); then
		execute_spinner "Simulating pacman installation" "sleep 1.5"
	else
		execute_spinner "Running pacman" "sudo pacman -Sy --needed --noconfirm ${PACMAN_PACKAGES[*]}"
	fi
else
	warn "No pacman packages declared for host '$HOST'"
fi

if ((PACMAN_ONLY)); then
	exit 0
fi

if ((${#AUR_PACKAGES[@]} == 0)); then
	log "No AUR packages declared for host '$HOST'"
	exit 0
fi

if ! command_exists yay && ! command_exists paru; then
	install_yay
fi

HELPER="yay"
if command_exists paru; then
	HELPER="paru"
fi

log "Installing ${#AUR_PACKAGES[@]} AUR packages with $HELPER"
print_package_grid "${AUR_PACKAGES[@]}"
if ((DRY_RUN)); then
	execute_spinner "Simulating $HELPER installation" "sleep 1.5"
else
	execute_spinner "Running $HELPER" "$HELPER -S --needed --noconfirm ${AUR_PACKAGES[*]}"
fi
