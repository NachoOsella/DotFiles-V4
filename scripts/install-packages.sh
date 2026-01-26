#!/usr/bin/env bash

# ==============================================================================
#  🛠️  PROFESSIONAL PACKAGE INSTALLER
# ==============================================================================
#  Interactive, modular, and animated installer for Hyprland setup.
#  Author: Nacho
# ==============================================================================

# --- Safety & Init ---
set -u
IFS=$'\n\t'
trap "tput cnorm; exit 1" SIGINT SIGTERM # Restore cursor on exit

# --- Visuals & Colors (Gruvbox Inspired) ---
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
INVERSE='\033[7m'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
ORANGE='\033[0;91m'

ICON_OK="✔"
ICON_FAIL="✖"
ICON_WARN="⚠"
ICON_INFO="ℹ"
ICON_PKG="📦"
ICON_SEL_ON="[✔]"
ICON_SEL_OFF="[ ]"

# --- Packages Definition ---
# Format: "Group_Name:Description:Package1 Package2 ..."

declare -A PACKAGES_MAP
declare -a GROUPS_ORDER

add_group() {
	local key="$1"
	local desc="$2"
	shift 2
	PACKAGES_MAP["$key"]="$desc|$*"
	GROUPS_ORDER+=("$key")
}

# 1. Base System
add_group "Base" "Essential tools (git, wget, stow, fzf)" \
	base-devel git stow wget unzip unrar zip less ripgrep fd fzf zoxide

# 2. Hyprland Core
add_group "Hyprland" "Window manager, lock, idle, portal" \
	hyprland hyprpaper hyprlock hypridle hyprpicker hyprshot \
	xdg-desktop-portal-hyprland waybar rofi rofi-emoji dunst \
	wlogout grim slurp cliphist polkit-kde-agent uwsm

# 3. Terminal
add_group "Terminal" "Kitty, Fish, Starship, Btop" \
	kitty fish starship btop htop fastfetch yazi lazygit lsd eza viu

# 4. Editors
add_group "Editors" "Neovim, Vim" \
	neovim vim

# 5. Audio
add_group "Audio" "Pipewire, Wireplumber, VLC" \
	pipewire pipewire-alsa pipewire-pulse pipewire-jack wireplumber libpulse vlc

# 6. Fonts
add_group "Fonts" "Nerd Fonts, Emojis" \
	ttf-jetbrains-mono-nerd ttf-firacode-nerd ttf-dejavu ttf-liberation \
	noto-fonts noto-fonts-cjk noto-fonts-emoji

# 7. Theming
add_group "Theming" "Qt/GTK themes, Icons" \
	qt5ct qt6ct kvantum-qt5 qt5-wayland qt6-wayland papirus-icon-theme

# 8. Dev Tools
add_group "Dev" "Go, Node, Python, Docker, Java" \
	go npm pnpm python-pip docker docker-compose jdk17-openjdk jdk21-openjdk maven

# 9. Apps
add_group "Apps" "Daily apps (PDF, Passwords)" \
	zathura-pdf-poppler keepassxc feh imagemagick obsidian spotify-launcher yt-dlp

# 10. Network
add_group "Network" "NetworkManager, Bluetooth, SSH" \
	networkmanager bluez bluez-utils openssh

# 11. AUR (Special handling)
AUR_PACKAGES=(
	brave-bin
	visual-studio-code-bin
	vesktop
	gruvbox-dark-icons-gtk
)

# --- UI Functions ---

banner() {
	clear
	echo -e "${ORANGE}${BOLD}"
	echo "    ____           __        ____           "
	echo "   /  _/___  _____/ /_____ _/ / /__  _____  "
	echo "   / // __ \/ ___/ __/ __ \/ / / _ \/ ___/  "
	echo " _/ // / / (__  ) /_/ /_/ / / /  __/ /      "
	echo "/___/_/ /_/____/\__/\__,_/_/_/\___/_/       "
	echo -e "${RESET}"
	echo -e "${DIM}  Hyprland Setup Installer v2.0 ${RESET}"
	echo ""
}

show_spinner() {
	local pid=$1
	local delay=0.1
	local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

	tput civis # Hide cursor
	while ps -p "$pid" >/dev/null; do
		local temp=${spinstr#?}
		printf "  ${CYAN}%c${RESET}  " "$spinstr"
		local spinstr=$temp${spinstr%"$temp"}
		sleep $delay
		printf "\b\b\b\b\b"
	done
	tput cnorm # Show cursor
	printf "     \b\b\b\b\b"
}

log_task() {
	printf "${BLUE}${ICON_PKG}${RESET}  %-35s" "$1"
}

# --- Selector Logic ---

select_groups() {
	local options=("${GROUPS_ORDER[@]}")
	local selected=()
	# Default select all
	for ((i = 0; i < ${#options[@]}; i++)); do selected[i]=true; done

	local current=0

	while true; do
		banner
		echo -e "${YELLOW}${BOLD}Select components to install:${RESET} (SPACE to toggle, ENTER to confirm)"
		echo ""

		for ((i = 0; i < ${#options[@]}; i++)); do
			local key="${options[i]}"
			local info="${PACKAGES_MAP[$key]}"
			local desc="${info%%|*}" # Get description part

			local checkbox="${ICON_SEL_OFF}"
			local style="${DIM}"
			local cursor=" "

			if [[ "${selected[i]}" == "true" ]]; then
				checkbox="${GREEN}${ICON_SEL_ON}${RESET}"
				style="${RESET}"
			fi

			if [[ $i -eq $current ]]; then
				cursor="${CYAN}➜${RESET}"
				style="${BOLD}${CYAN}"
			fi

			printf " %b %b %b %-12s ${DIM}- %s${RESET}\n" "$cursor" "$checkbox" "$style" "$key" "$desc"
		done

		# Input handling
		read -rsn1 input
		if [[ "$input" == "" ]]; then break; fi # Enter

		case "$input" in
		"A") [[ $current -gt 0 ]] && ((current--)) ;;                       # Up
		"B") [[ $current -lt $((${#options[@]} - 1)) ]] && ((current++)) ;; # Down
		" ")                                                                # Space
			if [[ "${selected[current]}" == "true" ]]; then
				selected[current]=false
			else
				selected[current]=true
			fi
			;;
		esac
	done

	# Return selected keys
	SELECTED_GROUPS=()
	for ((i = 0; i < ${#options[@]}; i++)); do
		if [[ "${selected[i]}" == "true" ]]; then
			SELECTED_GROUPS+=("${options[i]}")
		fi
	done
}

# --- Install Logic ---

check_aur_helper() {
	if command -v paru &>/dev/null; then
		echo "paru"
	elif command -v yay &>/dev/null; then
		echo "yay"
	else
		echo "none"
	fi
}

install_yay_auto() {
	log_task "Installing AUR Helper (yay)"

	# Check if already running as root (bad for makepkg)
	if [[ $EUID -eq 0 ]]; then
		printf "${RED}${ICON_FAIL} Cannot build yay as root${RESET}\n"
		return 1
	fi

	(
		git clone https://aur.archlinux.org/yay.git /tmp/yay &>/dev/null
		cd /tmp/yay
		makepkg -si --noconfirm &>/dev/null
	) &
	show_spinner $!

	if command -v yay &>/dev/null; then
		printf "${GREEN}${ICON_OK}${RESET}\n"
	else
		printf "${RED}${ICON_FAIL}${RESET}\n"
	fi
	rm -rf /tmp/yay
}

install_pacman_pkg() {
	local pkgs=($@)
	if [[ ${#pkgs[@]} -eq 0 ]]; then return; fi

	sudo pacman -S --needed --noconfirm "${pkgs[@]}" >/dev/null 2>&1 &
	show_spinner $!

	if [[ $? -eq 0 ]]; then
		printf "${GREEN}${ICON_OK}${RESET}\n"
	else
		printf "${RED}${ICON_FAIL} (See /var/log/pacman.log)${RESET}\n"
	fi
}

install_aur_pkg() {
	local helper="$1"
	local pkgs=("${@:2}")
	if [[ ${#pkgs[@]} -eq 0 ]]; then return; fi

	$helper -S --needed --noconfirm "${pkgs[@]}" >/dev/null 2>&1 &
	show_spinner $!

	if [[ $? -eq 0 ]]; then
		printf "${GREEN}${ICON_OK}${RESET}\n"
	else
		printf "${RED}${ICON_FAIL}${RESET}\n"
	fi
}

# --- Main Execution ---

main() {
	# Check Arch
	if ! command -v pacman &>/dev/null; then
		echo -e "${RED}Error: This script requires Pacman (Arch Linux).${RESET}"
		exit 1
	fi

	# 1. Selection Phase
	select_groups

	if [[ ${#SELECTED_GROUPS[@]} -eq 0 ]]; then
		echo -e "\n${YELLOW}No packages selected. Exiting.${RESET}"
		exit 0
	fi

	# 2. Confirmation
	banner
	echo -e "${GREEN}${BOLD}Ready to install:${RESET}"
	printf "  ${CYAN}%s${RESET} " "${SELECTED_GROUPS[@]}"
	echo -e "\n\n${DIM}This process may take a while.${RESET}"

	read -p "Continue? [Y/n] " -n 1 -r
	echo ""
	if [[ ! $REPLY =~ ^[Yy]$ ]] && [[ -n $REPLY ]]; then
		exit 0
	fi

	# 3. System Update
	echo -e "\n${BOLD}:: Updating System...${RESET}"
	log_task "Synchronizing databases"
	sudo pacman -Sy --noconfirm >/dev/null 2>&1 &
	show_spinner $!
	printf "${GREEN}${ICON_OK}${RESET}\n"

	# 4. Install Selected Groups
	for group in "${SELECTED_GROUPS[@]}"; do
		local info="${PACKAGES_MAP[$group]}"
		local pkg_list="${info#*|}" # Get package list part

		echo -e "\n${BOLD}:: Installing $group${RESET}"
		log_task "Processing packages..."
		install_pacman_pkg $pkg_list
	done

	# 5. AUR Packages (if selected any group, we assume user might want AUR tools)
	# Ideally this should be a separate selectable group or tied to specific ones.
	# For now, let's ask explicitly.
	echo -e "\n${BOLD}:: AUR Configuration${RESET}"
	local helper=$(check_aur_helper)

	if [[ "$helper" == "none" ]]; then
		echo -e "${YELLOW}AUR helper not found.${RESET}"
		read -p "Install yay? [Y/n] " -n 1 -r
		echo ""
		if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
			install_yay_auto
			helper="yay"
		fi
	else
		log_task "Found AUR helper ($helper)"
		printf "${GREEN}${ICON_OK}${RESET}\n"
	fi

	if [[ "$helper" != "none" ]]; then
		read -p "Install external apps (Brave, VSCode, etc) via AUR? [Y/n] " -n 1 -r
		echo ""
		if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
			log_task "Installing AUR apps..."
			install_aur_pkg "$helper" "${AUR_PACKAGES[@]}"
		fi
	fi

	# 6. Services
	echo -e "\n${BOLD}:: System Services${RESET}"
	log_task "Enabling Network & Bluetooth"
	(
		sudo systemctl enable --now NetworkManager 2>/dev/null
		sudo systemctl enable --now bluetooth 2>/dev/null
		sudo systemctl enable --now docker 2>/dev/null
	) &
	show_spinner $!
	printf "${GREEN}${ICON_OK}${RESET}\n"

	# 7. Finish
	echo -e "\n${GREEN}${BOLD}✔ Installation Complete!${RESET}"
	echo -e "Don't forget to run: ${CYAN}./scripts/stow.sh install${RESET}"
}

main "$@"
