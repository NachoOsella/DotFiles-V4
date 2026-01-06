#!/bin/bash

# ============================================================
# Stow Manager - Manages dotfiles symlinks
# ============================================================

set -e

DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# All available stow packages
STOW_PACKAGES=(
	hypr
	kitty
	fish
	nvim
	waybar
	rofi
	dunst
	lazygit
	yazi
	btop
	fastfetch
	lsd
	wlogout
	zathura
	gtk
	qt
	starship
	opencode
	keepassxc
)

usage() {
	echo ""
	echo -e "${CYAN}Stow Manager${NC} - Manages dotfiles symlinks"
	echo ""
	echo "Usage: $0 [command] [packages...]"
	echo ""
	echo "Commands:"
	echo "  install, i    Install (stow) specified packages"
	echo "  remove, r     Remove (unstow) specified packages"
	echo "  restow, re    Re-apply stow (useful after changes)"
	echo "  all           Install all packages"
	echo "  remove-all    Remove all packages"
	echo "  list, ls      List available packages"
	echo "  status, st    Show symlink status"
	echo "  help, -h      Show this help"
	echo ""
	echo "Examples:"
	echo "  $0 all                    # Install everything"
	echo "  $0 install hypr kitty     # Install hypr and kitty"
	echo "  $0 remove nvim            # Remove nvim"
	echo "  $0 restow hypr            # Re-apply hypr"
	echo ""
	echo "Available packages:"
	echo "  ${STOW_PACKAGES[*]}"
	echo ""
}

check_stow() {
	if ! command -v stow &>/dev/null; then
		log_error "stow is not installed. Install it with: sudo pacman -S stow"
		exit 1
	fi
}

check_dotfiles_dir() {
	if [[ ! -d "$DOTFILES_DIR" ]]; then
		log_error "Dotfiles directory not found: $DOTFILES_DIR"
		exit 1
	fi
}

stow_package() {
	local pkg="$1"
	local action="$2" # "" for stow, "-D" for unstow, "-R" for restow

	if [[ ! -d "$DOTFILES_DIR/$pkg" ]]; then
		log_warn "Package not found: $pkg"
		return 1
	fi

	cd "$DOTFILES_DIR"

	case "$action" in
	"")
		if stow -v "$pkg" 2>&1; then
			log_success "Installed: $pkg"
		else
			log_error "Error installing: $pkg"
			return 1
		fi
		;;
	"-D")
		if stow -v -D "$pkg" 2>&1; then
			log_success "Removed: $pkg"
		else
			log_error "Error removing: $pkg"
			return 1
		fi
		;;
	"-R")
		if stow -v -R "$pkg" 2>&1; then
			log_success "Re-applied: $pkg"
		else
			log_error "Error re-applying: $pkg"
			return 1
		fi
		;;
	esac
}

cmd_install() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Specify at least one package"
		usage
		exit 1
	fi

	log_info "Installing packages..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" ""
	done
}

cmd_remove() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Specify at least one package"
		exit 1
	fi

	log_info "Removing packages..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" "-D"
	done
}

cmd_restow() {
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		log_error "Specify at least one package"
		exit 1
	fi

	log_info "Re-applying packages..."
	for pkg in "${packages[@]}"; do
		stow_package "$pkg" "-R"
	done
}

cmd_all() {
	log_info "Installing all packages..."
	cd "$DOTFILES_DIR"

	for pkg in "${STOW_PACKAGES[@]}"; do
		stow_package "$pkg" ""
	done

	echo ""
	log_success "All packages installed"
}

cmd_remove_all() {
	log_info "Removing all packages..."
	cd "$DOTFILES_DIR"

	for pkg in "${STOW_PACKAGES[@]}"; do
		stow_package "$pkg" "-D" 2>/dev/null || true
	done

	echo ""
	log_success "All packages removed"
}

cmd_list() {
	echo ""
	echo -e "${CYAN}Available packages:${NC}"
	echo ""

	for pkg in "${STOW_PACKAGES[@]}"; do
		if [[ -d "$DOTFILES_DIR/$pkg" ]]; then
			local files=$(find "$DOTFILES_DIR/$pkg" -type f | wc -l)
			printf "  ${GREEN}%-15s${NC} (%d files)\n" "$pkg" "$files"
		fi
	done
	echo ""
}

cmd_status() {
	echo ""
	echo -e "${CYAN}Symlink status:${NC}"
	echo ""

	for pkg in "${STOW_PACKAGES[@]}"; do
		if [[ -d "$DOTFILES_DIR/$pkg/.config" ]]; then
			# Find first directory/file in .config
			local target=$(ls "$DOTFILES_DIR/$pkg/.config" | head -1)
			local link_path="$HOME/.config/$target"

			if [[ -L "$link_path" ]]; then
				printf "  ${GREEN}[LINKED]${NC}  %-15s -> %s\n" "$pkg" "$(readlink "$link_path")"
			elif [[ -e "$link_path" ]]; then
				printf "  ${YELLOW}[EXISTS]${NC}  %-15s (file/directory exists, not a symlink)\n" "$pkg"
			else
				printf "  ${RED}[MISSING]${NC} %-15s\n" "$pkg"
			fi
		fi
	done
	echo ""
}

# ============================================================
# MAIN
# ============================================================

main() {
	check_stow
	check_dotfiles_dir

	local cmd="${1:-help}"
	shift 2>/dev/null || true

	case "$cmd" in
	install | i)
		cmd_install "$@"
		;;
	remove | r)
		cmd_remove "$@"
		;;
	restow | re)
		cmd_restow "$@"
		;;
	all)
		cmd_all
		;;
	remove-all)
		cmd_remove_all
		;;
	list | ls)
		cmd_list
		;;
	status | st)
		cmd_status
		;;
	help | -h | --help)
		usage
		;;
	*)
		log_error "Unknown command: $cmd"
		usage
		exit 1
		;;
	esac
}

main "$@"
