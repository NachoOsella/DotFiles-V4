#!/usr/bin/env bash
# Installs applications only. Does not apply system files, services or dotfiles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=0

case "${1:-}" in
--dry-run) DRY_RUN=1; shift ;;
-h | --help)
    echo "Usage: ./scripts/install-pc-apps.sh [--dry-run]"
    exit 0
    ;;
esac
if (($#)); then
    echo "Unexpected argument: $1" >&2
    exit 1
fi

mapfile -t official < "$DOTFILES_DIR/packages/pc-pacman.txt"
mapfile -t aur < "$DOTFILES_DIR/packages/pc-aur.txt"

printf 'Official packages (%s):\n' "${#official[@]}"
printf '%s\n' "${official[*]}"
printf '\nAUR packages (%s):\n' "${#aur[@]}"
printf '%s\n' "${aur[*]}"
printf '\nNo system configuration or service changes will be applied.\n'

if ((DRY_RUN)); then
    echo "[dry-run] sudo pacman -Syu --needed <official packages>"
    echo "[dry-run] Install yay from AUR if no helper is available"
    echo "[dry-run] yay/paru -S --needed <AUR packages>"
    exit 0
fi

if ((EUID == 0)); then
    echo "Run this script as your regular user, not with sudo." >&2
    exit 1
fi

sudo pacman -Syu --needed "${official[@]}"

if command -v paru >/dev/null 2>&1; then
    helper=paru
elif command -v yay >/dev/null 2>&1; then
    helper=yay
else
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT
    git clone https://aur.archlinux.org/yay.git "$workdir/yay"
    (cd "$workdir/yay" && makepkg -si)
    helper=yay
fi

"$helper" -S --needed "${aur[@]}"
