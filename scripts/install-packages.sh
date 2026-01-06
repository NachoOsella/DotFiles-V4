#!/bin/bash

# ============================================================
# Dotfiles Package Installer
# Installs essential packages for this Hyprland setup
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================
# PACKAGES
# ============================================================

# Base system and utilities
BASE_PACKAGES=(
	base-devel
	git
	stow
	wget
	unzip
	unrar
	zip
	less
	ripgrep
	fd
	fzf
	zoxide
)

# Hyprland and Wayland
HYPRLAND_PACKAGES=(
	hyprland
	hyprpaper
	hyprlock
	hypridle
	hyprpicker
	hyprshot
	xdg-desktop-portal-hyprland
	waybar
	rofi
	rofi-emoji
	dunst
	wlogout
	grim
	slurp
	cliphist
	polkit-kde-agent
	uwsm
)

# Terminal and shell
TERMINAL_PACKAGES=(
	kitty
	fish
	starship
	btop
	htop
	fastfetch
	yazi
	lazygit
	lsd
	eza
	viu
)

# Editores
EDITOR_PACKAGES=(
	neovim
	vim
)

# Audio/Video
AUDIO_PACKAGES=(
	pipewire
	pipewire-alsa
	pipewire-pulse
	pipewire-jack
	wireplumber
	libpulse
	vlc
)

# Fonts
FONT_PACKAGES=(
	ttf-jetbrains-mono-nerd
	ttf-firacode-nerd
	ttf-dejavu
	ttf-liberation
	noto-fonts
	noto-fonts-cjk
	noto-fonts-emoji
)

# Qt/GTK theming
THEMING_PACKAGES=(
	qt5ct
	qt6ct
	kvantum-qt5
	qt5-wayland
	qt6-wayland
	papirus-icon-theme
)

# Development
DEV_PACKAGES=(
	go
	npm
	pnpm
	python-pip
	docker
	docker-compose
	jdk17-openjdk
	jdk21-openjdk
	maven
)

# Applications
APP_PACKAGES=(
	zathura-pdf-poppler
	keepassxc
	feh
	imagemagick
	obsidian
	spotify-launcher
	yt-dlp
)

# Networking
NETWORK_PACKAGES=(
	networkmanager
	bluez
	bluez-utils
	openssh
)

# AUR packages (require yay)
AUR_PACKAGES=(
	brave-bin
	visual-studio-code-bin
	vesktop
	gruvbox-dark-icons-gtk
)

# ============================================================
# FUNCTIONS
# ============================================================

check_root() {
	if [[ $EUID -eq 0 ]]; then
		log_error "Do not run this script as root"
		exit 1
	fi
}

check_arch() {
	if ! command -v pacman &>/dev/null; then
		log_error "This script is for Arch Linux only"
		exit 1
	fi
}

install_yay() {
	if ! command -v yay &>/dev/null; then
		log_info "Installing yay..."
		git clone https://aur.archlinux.org/yay.git /tmp/yay
		cd /tmp/yay
		makepkg -si --noconfirm
		cd -
		rm -rf /tmp/yay
		log_success "yay installed"
	else
		log_success "yay already installed"
	fi
}

install_packages() {
	local name="$1"
	shift
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		return
	fi

	log_info "Installing packages: $name"
	sudo pacman -S --needed --noconfirm "${packages[@]}" 2>/dev/null || {
		log_warn "Some $name packages failed, continuing..."
	}
}

install_aur_packages() {
	if [[ ${#AUR_PACKAGES[@]} -eq 0 ]]; then
		return
	fi

	log_info "Installing AUR packages..."
	yay -S --needed --noconfirm "${AUR_PACKAGES[@]}" 2>/dev/null || {
		log_warn "Some AUR packages failed, continuing..."
	}
}

enable_services() {
	log_info "Enabling services..."

	sudo systemctl enable --now NetworkManager 2>/dev/null || true
	sudo systemctl enable --now bluetooth 2>/dev/null || true
	sudo systemctl enable --now docker 2>/dev/null || true
	sudo systemctl enable --now sddm 2>/dev/null || true

	# Add user to docker group
	sudo usermod -aG docker "$USER" 2>/dev/null || true

	log_success "Services configured"
}

print_summary() {
	echo ""
	echo -e "${GREEN}============================================${NC}"
	echo -e "${GREEN}  Installation completed${NC}"
	echo -e "${GREEN}============================================${NC}"
	echo ""
	echo "Installed packages:"
	echo "  - Base and utilities"
	echo "  - Hyprland + components"
	echo "  - Terminal (kitty, fish, starship)"
	echo "  - Editors (neovim, vim)"
	echo "  - Audio (pipewire)"
	echo "  - Nerd fonts"
	echo "  - Qt/GTK theming"
	echo "  - Development (go, node, java, docker)"
	echo "  - Apps (brave, vscode, obsidian, etc)"
	echo ""
	echo -e "${YELLOW}Next step:${NC}"
	echo "  cd ~/dotfiles && ./scripts/stow-all.sh"
	echo ""
	echo -e "${YELLOW}Restart session to apply group changes (docker)${NC}"
}

# ============================================================
# MAIN
# ============================================================

main() {
	echo ""
	echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
	echo -e "${BLUE}║     Dotfiles Package Installer             ║${NC}"
	echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
	echo ""

	check_root
	check_arch

	log_info "Updating system..."
	sudo pacman -Syu --noconfirm

	install_packages "Base" "${BASE_PACKAGES[@]}"
	install_packages "Hyprland" "${HYPRLAND_PACKAGES[@]}"
	install_packages "Terminal" "${TERMINAL_PACKAGES[@]}"
	install_packages "Editores" "${EDITOR_PACKAGES[@]}"
	install_packages "Audio" "${AUDIO_PACKAGES[@]}"
	install_packages "Fuentes" "${FONT_PACKAGES[@]}"
	install_packages "Theming" "${THEMING_PACKAGES[@]}"
	install_packages "Desarrollo" "${DEV_PACKAGES[@]}"
	install_packages "Apps" "${APP_PACKAGES[@]}"
	install_packages "Network" "${NETWORK_PACKAGES[@]}"

	install_yay
	install_aur_packages

	enable_services

	print_summary
}

# Run if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	main "$@"
fi
