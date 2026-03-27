#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

HOST="$(detect_host)"
STATUS=0

check_file() {
	local path="$1"
	if [[ ! -f "$path" ]]; then
		error "Missing file: $(repo_relative "$path")"
		STATUS=1
	fi
}

check_sorted_unique() {
	local file="$1"
	[[ -f "$file" ]] || return 0

	local cleaned
	cleaned="$(grep -Ev '^\s*($|#)' "$file" || true)"
	if [[ -z "$cleaned" ]]; then
		return 0
	fi

	if [[ "$cleaned" != "$(printf '%s\n' "$cleaned" | sort -u)" ]]; then
		error "Manifest must be sorted and unique: $(repo_relative "$file")"
		STATUS=1
	fi
}

for cmd in bash stow pacman; do
	if ! command_exists "$cmd"; then
		warn "Command not available in current environment: $cmd"
	fi
done

check_file "$PACKAGES_DIR/pacman.txt"
check_file "$PACKAGES_DIR/aur.txt"
check_file "$DOTFILES_DIR/scripts/bootstrap.sh"
check_file "$DOTFILES_DIR/scripts/apply-system.sh"
check_file "$DOTFILES_DIR/scripts/enable-services.sh"
check_file "$DOTFILES_DIR/systemd-user/.config/systemd/user/clean-arch.timer"

check_sorted_unique "$PACKAGES_DIR/pacman.txt"
check_sorted_unique "$PACKAGES_DIR/aur.txt"
check_sorted_unique "$(host_services_dir "$HOST")/system.txt"
check_sorted_unique "$(host_services_dir "$HOST")/user.txt"

if ! grep -q '"systemd-user"' "$DOTFILES_DIR/scripts/stow.sh"; then
	error "systemd-user package is not registered in scripts/stow.sh"
	STATUS=1
fi

for script in \
	"$DOTFILES_DIR/scripts/bootstrap.sh" \
	"$DOTFILES_DIR/scripts/install-packages.sh" \
	"$DOTFILES_DIR/scripts/apply-system.sh" \
	"$DOTFILES_DIR/scripts/enable-services.sh" \
	"$DOTFILES_DIR/scripts/capture-system.sh" \
	"$DOTFILES_DIR/scripts/check.sh" \
	"$DOTFILES_DIR/scripts/install_systemd.sh" \
	"$DOTFILES_DIR/scripts/lib.sh"; do
	if ! bash -n "$script"; then
		STATUS=1
	fi
done

if (( STATUS == 0 )); then
	log "Checks passed"
fi

exit "$STATUS"
