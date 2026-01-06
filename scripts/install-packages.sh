#!/bin/bash

# ============================================================
# Dotfiles Package Installer
# Instala los paquetes esenciales para este setup Hyprland
# ============================================================

set -e

# Colores
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
# PAQUETES
# ============================================================

# Sistema base y utilidades
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

# Hyprland y Wayland
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

# Terminal y shell
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

# Fuentes
FONT_PACKAGES=(
	ttf-jetbrains-mono-nerd
	ttf-firacode-nerd
	ttf-dejavu
	ttf-liberation
	noto-fonts
	noto-fonts-cjk
	noto-fonts-emoji
)

# Theming Qt/GTK
THEMING_PACKAGES=(
	qt5ct
	qt6ct
	kvantum-qt5
	qt5-wayland
	qt6-wayland
	papirus-icon-theme
)

# Desarrollo
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

# Apps
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

# Paquetes AUR (requieren yay)
AUR_PACKAGES=(
	brave-bin
	visual-studio-code-bin
	vesktop
	gruvbox-dark-icons-gtk
)

# ============================================================
# FUNCIONES
# ============================================================

check_root() {
	if [[ $EUID -eq 0 ]]; then
		log_error "No ejecutes este script como root"
		exit 1
	fi
}

check_arch() {
	if ! command -v pacman &>/dev/null; then
		log_error "Este script es solo para Arch Linux"
		exit 1
	fi
}

install_yay() {
	if ! command -v yay &>/dev/null; then
		log_info "Instalando yay..."
		git clone https://aur.archlinux.org/yay.git /tmp/yay
		cd /tmp/yay
		makepkg -si --noconfirm
		cd -
		rm -rf /tmp/yay
		log_success "yay instalado"
	else
		log_success "yay ya está instalado"
	fi
}

install_packages() {
	local name="$1"
	shift
	local packages=("$@")

	if [[ ${#packages[@]} -eq 0 ]]; then
		return
	fi

	log_info "Instalando paquetes: $name"
	sudo pacman -S --needed --noconfirm "${packages[@]}" 2>/dev/null || {
		log_warn "Algunos paquetes de $name fallaron, continuando..."
	}
}

install_aur_packages() {
	if [[ ${#AUR_PACKAGES[@]} -eq 0 ]]; then
		return
	fi

	log_info "Instalando paquetes AUR..."
	yay -S --needed --noconfirm "${AUR_PACKAGES[@]}" 2>/dev/null || {
		log_warn "Algunos paquetes AUR fallaron, continuando..."
	}
}

enable_services() {
	log_info "Habilitando servicios..."

	sudo systemctl enable --now NetworkManager 2>/dev/null || true
	sudo systemctl enable --now bluetooth 2>/dev/null || true
	sudo systemctl enable --now docker 2>/dev/null || true
	sudo systemctl enable --now sddm 2>/dev/null || true

	# Agregar usuario a grupo docker
	sudo usermod -aG docker "$USER" 2>/dev/null || true

	log_success "Servicios configurados"
}

print_summary() {
	echo ""
	echo -e "${GREEN}============================================${NC}"
	echo -e "${GREEN}  Instalación completada${NC}"
	echo -e "${GREEN}============================================${NC}"
	echo ""
	echo "Paquetes instalados:"
	echo "  - Base y utilidades"
	echo "  - Hyprland + componentes"
	echo "  - Terminal (kitty, fish, starship)"
	echo "  - Editores (neovim, vim)"
	echo "  - Audio (pipewire)"
	echo "  - Fuentes Nerd"
	echo "  - Theming Qt/GTK"
	echo "  - Desarrollo (go, node, java, docker)"
	echo "  - Apps (brave, vscode, obsidian, etc)"
	echo ""
	echo -e "${YELLOW}Siguiente paso:${NC}"
	echo "  cd ~/dotfiles && ./scripts/stow-all.sh"
	echo ""
	echo -e "${YELLOW}Reinicia la sesión para aplicar cambios de grupo (docker)${NC}"
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

	log_info "Actualizando sistema..."
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

# Ejecutar si no es sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	main "$@"
fi
